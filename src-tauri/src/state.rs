use crate::db;
use crate::deals::Thresholds;
use crate::shopee::{mock, ProductPage, ProductQuery, ShopeeClient};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::RwLock;

pub const SETTINGS_KEY: &str = "app_settings";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoLiveRules {
    pub enabled: bool,
    pub max_items: usize,
    pub min_score: f64,
    pub keyword: String,
    pub max_price: f64,
    /// Limpa a lista antes de preencher (senão só acrescenta).
    pub replace: bool,
    /// "" (todos) | "anomaly" (só preço fora da curva) | "discount" (só desconto/queda)
    pub kind: String,
}

impl Default for AutoLiveRules {
    fn default() -> Self {
        // Sem histórico o score máximo fica em ~55 (desconto 100%); 20 ≈ desconto de 30% + vendas razoáveis.
        Self {
            enabled: false,
            max_items: 20,
            min_score: 20.0,
            keyword: String::new(),
            max_price: 0.0,
            replace: false,
            kind: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub app_id: String,
    pub secret: String,
    pub interval_minutes: u64,
    pub max_pages_per_search: u32,
    pub page_size: u32,
    pub thresholds: Thresholds,
    pub notifications: bool,
    pub history_days: i64,
    pub auto_live: AutoLiveRules,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            secret: String::new(),
            interval_minutes: 30,
            max_pages_per_search: 2,
            page_size: 100,
            thresholds: Thresholds::default(),
            notifications: true,
            history_days: 90,
            auto_live: AutoLiveRules::default(),
        }
    }
}

impl AppSettings {
    pub fn has_credentials(&self) -> bool {
        !self.app_id.trim().is_empty() && !self.secret.trim().is_empty()
    }
    pub fn load(conn: &Connection) -> AppSettings {
        db::get_setting(conn, SETTINGS_KEY)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
    pub fn save(&self, conn: &Connection) -> Result<(), rusqlite::Error> {
        db::set_setting(conn, SETTINGS_KEY, &serde_json::to_string(self).unwrap_or_default())
    }
    pub fn build_client(&self) -> Option<ShopeeClient> {
        self.has_credentials().then(|| ShopeeClient::new(self.app_id.trim(), self.secret.trim()))
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub scanning: bool,
    pub last_run_at: Option<String>,
    pub last_summary: Option<String>,
    pub last_error: Option<String>,
    pub next_run_at: Option<String>,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub client: RwLock<Option<ShopeeClient>>,
    pub scan_lock: tokio::sync::Mutex<()>,
    pub scan: Mutex<ScanStatus>,
    pub mock_tick: AtomicU64,
    /// Acordado quando o usuário muda o intervalo ou pede "rodar agora".
    pub wake: tokio::sync::Notify,
}

impl AppState {
    pub fn new(conn: Connection) -> Self {
        let settings = AppSettings::load(&conn);
        Self {
            db: Mutex::new(conn),
            client: RwLock::new(settings.build_client()),
            scan_lock: tokio::sync::Mutex::new(()),
            scan: Mutex::new(ScanStatus::default()),
            mock_tick: AtomicU64::new(1),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// Acesso síncrono ao banco — nunca segure o guard através de um `.await`.
    pub fn with_db<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, rusqlite::Error>) -> Result<T, String> {
        let mut guard = self.db.lock().map_err(|_| "banco de dados indisponível (lock envenenado)".to_string())?;
        f(&mut guard).map_err(|e| format!("erro no banco de dados: {e}"))
    }

    pub fn settings(&self) -> AppSettings {
        self.with_db(|c| Ok(AppSettings::load(c))).unwrap_or_default()
    }

    pub async fn is_live(&self) -> bool {
        self.client.read().await.is_some()
    }

    /// Busca produtos na API real (se houver credenciais) ou no gerador mock.
    pub async fn fetch_products(&self, q: &ProductQuery) -> Result<ProductPage, String> {
        let client = self.client.read().await.clone();
        match client {
            Some(c) => c.product_offers(q).await.map_err(|e| e.to_string()),
            None => {
                let tick = self.mock_tick.fetch_add(1, Ordering::Relaxed);
                // Simula latência de rede para a UI ser testada de forma realista.
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                Ok(mock::product_offers(q, tick / 3))
            }
        }
    }

    pub fn update_scan(&self, f: impl FnOnce(&mut ScanStatus)) -> ScanStatus {
        let mut s = self.scan.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut s);
        s.clone()
    }
}
