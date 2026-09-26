//! Varredura periódica das buscas monitoradas:
//! coleta (busca base + caça por menor preço) → histórico → pares/mediana → achadinhos → notificações → auto-live.

use crate::db::{self, DealFilter, SavedSearch};
use crate::shopee::ProductQuery;
use crate::state::{AppSettings, AppState, ScanStatus};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub const EVT_STATUS: &str = "scan:status";
pub const EVT_FINISHED: &str = "scan:finished";
pub const EVT_LIVE_CHANGED: &str = "live:changed";

/// Ordenação "menor preço" do productOfferV2.
const SORT_LOWEST_PRICE: u8 = 4;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub searches_run: usize,
    pub requests: usize,
    pub products_received: usize,
    pub new_products: usize,
    pub price_changes: usize,
    pub qualifying_deals: usize,
    pub anomalies: usize,
    pub notified: usize,
    pub auto_live_added: usize,
    pub errors: Vec<String>,
    pub duration_ms: u128,
}

impl ScanSummary {
    pub fn human(&self) -> String {
        let mut s = format!(
            "{} busca(s), {} produtos recebidos, {} novos, {} mudanças de preço, {} achadinhos ({} fora da curva)",
            self.searches_run, self.products_received, self.new_products, self.price_changes, self.qualifying_deals, self.anomalies
        );
        if self.auto_live_added > 0 {
            s.push_str(&format!(", {} adicionados à live", self.auto_live_added));
        }
        if !self.errors.is_empty() {
            s.push_str(&format!(" — {} erro(s)", self.errors.len()));
        }
        s
    }
}

fn emit_status(app: &AppHandle, status: &ScanStatus) {
    let _ = app.emit(EVT_STATUS, status);
}

/// Loop em background. O intervalo é relido a cada volta (mudanças nas configurações valem na hora).
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Primeira varredura logo após abrir (dá tempo da janela carregar).
        tokio::time::sleep(Duration::from_secs(8)).await;
        let _ = run_scan(&app).await;
        loop {
            let state = app.state::<AppState>();
            let minutes = state.settings().interval_minutes.clamp(5, 24 * 60);
            let next = chrono::Utc::now() + chrono::Duration::minutes(minutes as i64);
            let status = state.update_scan(|s| {
                s.next_run_at = Some(next.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            });
            emit_status(&app, &status);

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(minutes * 60)) => {}
                _ = state.wake.notified() => {}
            }
            let _ = run_scan(&app).await;
        }
    });
}

/// Executa uma varredura completa. Se já houver uma em andamento, retorna erro.
pub async fn run_scan(app: &AppHandle) -> Result<ScanSummary, String> {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.scan_lock.try_lock() else {
        return Err("já existe uma varredura em andamento".into());
    };
    let started = std::time::Instant::now();
    let settings = state.settings();
    let status = state.update_scan(|s| {
        s.scanning = true;
        s.last_error = None;
    });
    emit_status(app, &status);

    let result = scan_inner(app, &state, &settings).await;

    let summary = match &result {
        Ok(s) => s.clone(),
        Err(e) => ScanSummary { errors: vec![e.clone()], ..Default::default() },
    };
    let status = state.update_scan(|s| {
        s.scanning = false;
        s.last_run_at = Some(db::now_rfc3339());
        s.last_summary = Some(summary.human());
        s.last_error = summary.errors.first().cloned();
    });
    emit_status(app, &status);
    let _ = app.emit(EVT_FINISHED, &summary);
    log::info!("varredura concluída em {}ms: {}", started.elapsed().as_millis(), summary.human());
    result
}

/// Resultado de uma sequência de páginas de uma mesma consulta.
struct PassResult {
    item_ids: Vec<i64>,
    prices: Vec<f64>,
    received: usize,
    error: Option<String>,
}

/// Busca `pages` páginas de uma consulta, grava produtos/histórico e devolve ids/preços.
async fn run_pass(state: &AppState, base: &ProductQuery, pages: u32, summary: &mut ScanSummary) -> Result<PassResult, String> {
    let mut out = PassResult { item_ids: Vec::new(), prices: Vec::new(), received: 0, error: None };
    for page in 1..=pages {
        let q = ProductQuery { page, ..base.clone() };
        summary.requests += 1;
        match state.fetch_products(&q).await {
            Ok(pg) => {
                let now = db::now_rfc3339();
                let up = state.with_db(|c| db::upsert_products(c, &pg.nodes, &now))?;
                out.received += up.received;
                summary.products_received += up.received;
                summary.new_products += up.new_products;
                summary.price_changes += up.price_changes;
                out.item_ids.extend(pg.nodes.iter().map(|n| n.item_id));
                out.prices.extend(pg.nodes.iter().map(|n| n.price_min));
                if !pg.page_info.has_next_page || pg.nodes.is_empty() {
                    break;
                }
            }
            Err(e) => {
                let rate_limited = e.contains("10030") || e.to_lowercase().contains("limite");
                out.error = Some(e);
                if rate_limited {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                break;
            }
        }
        // Respeita o rate limit da API entre páginas.
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    Ok(out)
}

async fn run_search(state: &AppState, settings: &AppSettings, search: &SavedSearch, summary: &mut ScanSummary) -> Result<String, String> {
    let pages = search.pages.clamp(1, settings.max_pages_per_search.clamp(1, 10));
    let limit = settings.page_size.clamp(1, 500);
    let keyword = Some(search.keyword.clone()).filter(|k| !k.trim().is_empty());
    let has_keyword = keyword.is_some();

    // 1) Busca base (ordenação escolhida) — define a mediana dos pares quando não for ordenada por preço.
    let base_q = ProductQuery { keyword: keyword.clone(), list_type: search.list_type, sort_type: search.sort_type, limit, ..Default::default() };
    let base = run_pass(state, &base_q, pages, summary).await?;
    let mut received = base.received;
    let mut errors: Vec<String> = base.error.iter().cloned().collect();

    if has_keyword && !base.item_ids.is_empty() {
        let price_sorted = matches!(search.sort_type, Some(3) | Some(4));
        let kw = search.keyword.clone();
        let ids = base.item_ids.clone();
        let prices = base.prices.clone();
        state.with_db(move |c| {
            if !price_sorted {
                db::update_peer_stats(c, &kw, &prices, &db::now_rfc3339())?;
            }
            db::link_peers(c, &kw, &ids)
        })?;
    }

    // 2) Caça por menor preço: é onde moram os "bugs" de preço.
    if search.hunt_low_price && has_keyword && base.error.is_none() {
        let hunt_q = ProductQuery { keyword: keyword.clone(), sort_type: Some(SORT_LOWEST_PRICE), limit, ..Default::default() };
        let hunt = run_pass(state, &hunt_q, pages, summary).await?;
        received += hunt.received;
        if let Some(e) = hunt.error {
            errors.push(e);
        }
        if !hunt.item_ids.is_empty() {
            let kw = search.keyword.clone();
            let ids = hunt.item_ids.clone();
            state.with_db(move |c| db::link_peers(c, &kw, &ids))?;
        }
    }

    if let Some(e) = errors.first() {
        Err(format!("erro: {e}"))
    } else {
        Ok(format!("ok — {received} produtos{}", if search.hunt_low_price && has_keyword { " (base + menor preço)" } else { "" }))
    }
}

async fn scan_inner(app: &AppHandle, state: &AppState, settings: &AppSettings) -> Result<ScanSummary, String> {
    let started = std::time::Instant::now();
    let mut summary = ScanSummary::default();
    let searches = state.with_db(|c| db::list_searches(c, true))?;
    if searches.is_empty() {
        summary.errors.push("nenhuma busca monitorada ativa — cadastre em Monitoramento".into());
        summary.duration_ms = started.elapsed().as_millis();
        return Ok(summary);
    }

    for search in &searches {
        summary.searches_run += 1;
        let result = match run_search(state, settings, search, &mut summary).await {
            Ok(msg) => msg,
            Err(e) => {
                summary.errors.push(format!("busca '{}': {e}", search.keyword));
                e
            }
        };
        state.with_db(|c| db::touch_search(c, search.id, &result, &db::now_rfc3339()))?;
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    // Limpeza do histórico antigo.
    let _ = state.with_db(|c| db::prune_history(c, settings.history_days.clamp(7, 3650)));

    // Achadinhos atuais.
    let filter = DealFilter { only_qualifying: true, sort: "score".into(), ..Default::default() };
    let deals = state.with_db(|c| db::list_deals(c, &filter, &settings.thresholds))?;
    summary.qualifying_deals = deals.len();
    summary.anomalies = deals.iter().filter(|d| d.eval.is_price_anomaly).count();

    // Notificações: só para achadinhos ainda não notificados nas últimas 24h (anomalias primeiro).
    if settings.notifications {
        let now = chrono::Utc::now();
        let fresh: Vec<_> = deals
            .iter()
            .filter(|d| {
                d.product
                    .notified_at
                    .as_deref()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map_or(true, |t| (now - t.with_timezone(&chrono::Utc)).num_hours() >= 24)
            })
            .take(5)
            .collect();
        for d in &fresh {
            let title = if d.eval.is_price_anomaly {
                format!(
                    "Preço fora da curva: R$ {:.2} (normal ≈ R$ {:.2})",
                    d.product.price_min,
                    d.eval.peer_median.unwrap_or(0.0)
                )
            } else {
                format!(
                    "Achadinho: {:.0}% off — R$ {:.2}",
                    d.product.discount_rate.max(d.eval.drop_vs_avg_pct.unwrap_or(0.0)),
                    d.product.price_min
                )
            };
            let _ = app.notification().builder().title(title).body(&d.product.product_name).show();
        }
        let ids: Vec<i64> = fresh.iter().map(|d| d.product.item_id).collect();
        if !ids.is_empty() {
            state.with_db(|c| db::mark_notified(c, &ids, &db::now_rfc3339()))?;
            summary.notified = ids.len();
        }
    }

    // Preenchimento automático da lista da live.
    if settings.auto_live.enabled {
        summary.auto_live_added = auto_fill_live(state, settings, false)?;
        if summary.auto_live_added > 0 {
            let _ = app.emit(EVT_LIVE_CHANGED, ());
        }
    }

    summary.duration_ms = started.elapsed().as_millis();
    Ok(summary)
}

/// Seleciona os melhores achadinhos pelas regras e adiciona à lista da live.
/// `force_replace` sobrepõe a regra `replace` das configurações.
pub fn auto_fill_live(state: &AppState, settings: &AppSettings, force_replace: bool) -> Result<usize, String> {
    let rules = &settings.auto_live;
    let replace = force_replace || rules.replace;
    let filter = DealFilter {
        keyword: rules.keyword.clone(),
        only_qualifying: true,
        min_score: rules.min_score,
        max_price: rules.max_price,
        exclude_in_live: !replace,
        sort: "score".into(),
        limit: 0,
        kind: rules.kind.clone(),
        ..Default::default()
    };
    state.with_db(|c| {
        if replace {
            db::clear_live(c)?;
        }
        let current = db::list_live(c)?.len();
        let room = rules.max_items.saturating_sub(current);
        if room == 0 {
            return Ok(0);
        }
        let deals = db::list_deals(c, &filter, &settings.thresholds)?;
        let ids: Vec<i64> = deals.iter().take(room).map(|d| d.product.item_id).collect();
        db::add_to_live(c, &ids, "auto")
    })
}
