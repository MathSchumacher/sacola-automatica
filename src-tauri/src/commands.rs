use crate::db::{self, Deal, DealFilter, LiveItem, PricePoint, SavedSearch};
use crate::deals::PeerStats;
use crate::scheduler::{self, ScanSummary, EVT_LIVE_CHANGED};
use crate::shopee::{ProductPage, ProductQuery};
use crate::state::{AppSettings, AppState, ScanStatus};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub mode: &'static str,
    pub has_credentials: bool,
    pub app_id: String,
    pub products_tracked: i64,
    pub scan: ScanStatus,
    pub version: &'static str,
}

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    let settings = state.settings();
    let live = state.is_live().await;
    let products_tracked = state.with_db(|c| db::count_products(c))?;
    let scan = state.scan.lock().map(|s| s.clone()).unwrap_or_default();
    Ok(AppStatus {
        mode: if live { "live" } else { "mock" },
        has_credentials: settings.has_credentials(),
        app_id: settings.app_id,
        products_tracked,
        scan,
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.settings())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings, String> {
    let mut s = settings;
    s.interval_minutes = s.interval_minutes.clamp(5, 24 * 60);
    s.max_pages_per_search = s.max_pages_per_search.clamp(1, 10);
    s.page_size = s.page_size.clamp(10, 500);
    s.history_days = s.history_days.clamp(7, 3650);
    s.app_id = s.app_id.trim().to_string();
    s.secret = s.secret.trim().to_string();
    state.with_db(|c| s.save(c))?;
    *state.client.write().await = s.build_client();
    // Reinicia o timer para respeitar o novo intervalo.
    state.wake.notify_one();
    let _ = app.emit("settings:changed", ());
    Ok(s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub message: String,
    pub sample: Option<String>,
}

/// Faz uma chamada mínima à API real para validar App ID + Secret.
#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>) -> Result<ConnectionTest, String> {
    let client = state.client.read().await.clone();
    let Some(client) = client else {
        return Ok(ConnectionTest {
            ok: false,
            message: "Sem credenciais — informe App ID e Secret e salve. Enquanto isso o app roda em modo de demonstração.".into(),
            sample: None,
        });
    };
    let q = ProductQuery { limit: 1, page: 1, sort_type: Some(2), ..Default::default() };
    match client.product_offers(&q).await {
        Ok(p) => Ok(ConnectionTest {
            ok: true,
            message: format!("Conectado como App ID {}", client.app_id()),
            sample: p.nodes.first().map(|n| n.product_name.clone()),
        }),
        Err(e) => Ok(ConnectionTest { ok: false, message: e.to_string(), sample: None }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    #[serde(flatten)]
    pub page: ProductPage,
    /// Mediana dos pares da palavra-chave (se já conhecida) — usada para marcar preços fora da curva.
    pub peers: Option<PeerStats>,
}

/// Busca manual. Os resultados também alimentam o histórico e o grupo de pares da palavra-chave.
#[tauri::command]
pub async fn search_products(state: State<'_, AppState>, query: ProductQuery) -> Result<SearchResult, String> {
    let page = state.fetch_products(&query).await?;
    let now = db::now_rfc3339();
    let keyword = query.keyword.clone().unwrap_or_default();
    let price_sorted = matches!(query.sort_type, Some(3) | Some(4));
    let ids: Vec<i64> = page.nodes.iter().map(|n| n.item_id).collect();
    let prices: Vec<f64> = page.nodes.iter().map(|n| n.price_min).collect();
    let peers = state.with_db(|c| {
        db::upsert_products(c, &page.nodes, &now)?;
        if db::norm_keyword(&keyword).is_empty() || ids.is_empty() {
            return Ok(None);
        }
        // Página ordenada por preço distorceria a mediana; só atualiza com amostras "neutras".
        if !price_sorted {
            db::update_peer_stats(c, &keyword, &prices, &now)?;
        }
        db::link_peers(c, &keyword, &ids)?;
        db::get_peer_stats(c, &keyword)
    })?;
    Ok(SearchResult { page, peers })
}

#[tauri::command]
pub fn get_peer_stats(state: State<'_, AppState>, keyword: String) -> Result<Option<PeerStats>, String> {
    state.with_db(|c| db::get_peer_stats(c, &keyword))
}

#[tauri::command]
pub fn list_deals(state: State<'_, AppState>, filter: DealFilter) -> Result<Vec<Deal>, String> {
    let th = state.settings().thresholds;
    state.with_db(|c| db::list_deals(c, &filter, &th))
}

#[tauri::command]
pub fn get_product_history(state: State<'_, AppState>, item_id: i64) -> Result<Vec<PricePoint>, String> {
    state.with_db(|c| db::product_history(c, item_id))
}

// ---------- buscas monitoradas ----------

#[tauri::command]
pub fn list_searches(state: State<'_, AppState>) -> Result<Vec<SavedSearch>, String> {
    state.with_db(|c| db::list_searches(c, false))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSearch {
    pub keyword: String,
    pub list_type: Option<u8>,
    pub sort_type: Option<u8>,
    #[serde(default = "one")]
    pub pages: u32,
    #[serde(default = "yes")]
    pub hunt_low_price: bool,
}
fn one() -> u32 {
    1
}
fn yes() -> bool {
    true
}

#[tauri::command]
pub fn add_search(state: State<'_, AppState>, search: NewSearch) -> Result<SavedSearch, String> {
    state.with_db(|c| db::add_search(c, &search.keyword, search.list_type, search.sort_type, search.pages, search.hunt_low_price))
}

#[tauri::command]
pub fn set_search_enabled(state: State<'_, AppState>, id: i64, enabled: bool) -> Result<(), String> {
    state.with_db(|c| db::set_search_enabled(c, id, enabled))
}

#[tauri::command]
pub fn delete_search(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.with_db(|c| db::delete_search(c, id))
}

#[tauri::command]
pub async fn run_scan_now(app: AppHandle) -> Result<ScanSummary, String> {
    scheduler::run_scan(&app).await
}

// ---------- lista da live ----------

#[tauri::command]
pub fn list_live(state: State<'_, AppState>) -> Result<Vec<LiveItem>, String> {
    state.with_db(|c| db::list_live(c))
}

#[tauri::command]
pub fn add_to_live(app: AppHandle, state: State<'_, AppState>, item_ids: Vec<i64>) -> Result<usize, String> {
    let n = state.with_db(|c| db::add_to_live(c, &item_ids, "manual"))?;
    let _ = app.emit(EVT_LIVE_CHANGED, ());
    Ok(n)
}

#[tauri::command]
pub fn remove_from_live(app: AppHandle, state: State<'_, AppState>, item_id: i64) -> Result<(), String> {
    state.with_db(|c| db::remove_from_live(c, item_id))?;
    let _ = app.emit(EVT_LIVE_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn move_live_item(app: AppHandle, state: State<'_, AppState>, item_id: i64, delta: i64) -> Result<(), String> {
    state.with_db(|c| db::move_live_item(c, item_id, delta))?;
    let _ = app.emit(EVT_LIVE_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.with_db(|c| db::clear_live(c))?;
    let _ = app.emit(EVT_LIVE_CHANGED, ());
    Ok(())
}

/// Preenche a lista da live com os melhores achadinhos segundo as regras salvas
/// (ou regras passadas na hora).
#[tauri::command]
pub fn auto_fill_live(
    app: AppHandle,
    state: State<'_, AppState>,
    rules: Option<crate::state::AutoLiveRules>,
    replace: Option<bool>,
) -> Result<usize, String> {
    let mut settings = state.settings();
    if let Some(r) = rules {
        settings.auto_live = r;
    }
    let n = scheduler::auto_fill_live(&state, &settings, replace.unwrap_or(false))?;
    let _ = app.emit(EVT_LIVE_CHANGED, ());
    Ok(n)
}

/// Formatos: `ids` (um por linha), `ids_comma`, `links`, `offer_links`, `csv`.
#[tauri::command]
pub fn export_live(state: State<'_, AppState>, format: String) -> Result<String, String> {
    let items = state.with_db(|c| db::list_live(c))?;
    Ok(render_export(&items, &format))
}

pub fn render_export(items: &[LiveItem], format: &str) -> String {
    match format {
        "ids_comma" => items.iter().map(|i| i.item_id.to_string()).collect::<Vec<_>>().join(","),
        "links" => items.iter().map(|i| i.product_link.clone()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"),
        "offer_links" => items.iter().map(|i| i.offer_link.clone()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"),
        "csv" => {
            let mut out = String::from("posicao;item_id;shop_id;produto;preco;desconto_pct;vendas;comissao_pct;link_produto;link_afiliado\n");
            for (i, it) in items.iter().enumerate() {
                out.push_str(&format!(
                    "{};{};{};{};{};{};{};{};{};{}\n",
                    i + 1,
                    it.item_id,
                    it.shop_id,
                    csv_field(&it.product_name),
                    format!("{:.2}", it.price_min).replace('.', ","),
                    it.discount_rate.round(),
                    it.sales,
                    format!("{:.2}", it.commission_rate * 100.0).replace('.', ","),
                    it.product_link,
                    it.offer_link
                ));
            }
            out
        }
        _ => items.iter().map(|i| i.item_id.to_string()).collect::<Vec<_>>().join("\n"),
    }
}

fn csv_field(s: &str) -> String {
    if s.contains(';') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Salva a exportação na pasta Downloads e devolve o caminho.
#[tauri::command]
pub fn export_live_file(app: AppHandle, state: State<'_, AppState>, format: String) -> Result<String, String> {
    let content = {
        let items = state.with_db(|c| db::list_live(c))?;
        if items.is_empty() {
            return Err("a lista da live está vazia".into());
        }
        render_export(&items, &format)
    };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("não foi possível localizar a pasta Downloads: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = if format == "csv" { "csv" } else { "txt" };
    let name = format!("achadinhos-live-{}.{ext}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(name);
    let bytes: Vec<u8> = if ext == "csv" {
        // BOM para o Excel abrir acentuação corretamente.
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice(content.as_bytes());
        b
    } else {
        content.into_bytes()
    };
    std::fs::write(&path, bytes).map_err(|e| format!("falha ao gravar arquivo: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: i64, name: &str) -> LiveItem {
        LiveItem {
            item_id: id,
            position: id,
            added_at: String::new(),
            source: "manual".into(),
            note: None,
            shop_id: 7,
            product_name: name.into(),
            product_link: format!("https://shopee.com.br/p/7/{id}"),
            offer_link: format!("https://s.shopee.com.br/{id}"),
            image_url: String::new(),
            price_min: 19.9,
            discount_rate: 40.0,
            sales: 10,
            commission_rate: 0.125,
        }
    }

    #[test]
    fn export_formats() {
        let items = vec![item(1, "A; com ponto e vírgula"), item(2, "B")];
        assert_eq!(render_export(&items, "ids"), "1\n2");
        assert_eq!(render_export(&items, "ids_comma"), "1,2");
        assert!(render_export(&items, "links").contains("https://shopee.com.br/p/7/2"));
        let csv = render_export(&items, "csv");
        assert!(csv.starts_with("posicao;item_id;"));
        assert!(csv.contains("\"A; com ponto e vírgula\""));
        assert!(csv.contains("19,90;40;10;12,50"));
    }
}
