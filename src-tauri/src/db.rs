//! Persistência local (SQLite): produtos, histórico de preços, buscas monitoradas,
//! lista de IDs para a live e configurações.

use crate::deals::{self, DealEval, History, PeerStats, Thresholds};
use crate::shopee::ProductOffer;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub type DbResult<T> = Result<T, rusqlite::Error>;

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn open(path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> DbResult<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate(&conn)?;
    Ok(conn)
}

/// Migrações idempotentes baseadas em `user_version`.
pub fn migrate(conn: &Connection) -> DbResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS products (
                item_id         INTEGER PRIMARY KEY,
                shop_id         INTEGER NOT NULL DEFAULT 0,
                product_name    TEXT NOT NULL DEFAULT '',
                product_link    TEXT NOT NULL DEFAULT '',
                offer_link      TEXT NOT NULL DEFAULT '',
                image_url       TEXT NOT NULL DEFAULT '',
                shop_name       TEXT NOT NULL DEFAULT '',
                price_min       REAL NOT NULL DEFAULT 0,
                price_max       REAL NOT NULL DEFAULT 0,
                discount_rate   REAL NOT NULL DEFAULT 0,
                sales           INTEGER NOT NULL DEFAULT 0,
                rating          REAL NOT NULL DEFAULT 0,
                commission_rate REAL NOT NULL DEFAULT 0,
                commission      REAL NOT NULL DEFAULT 0,
                first_seen      TEXT NOT NULL,
                last_seen       TEXT NOT NULL,
                notified_at     TEXT
            );
            CREATE TABLE IF NOT EXISTS price_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id       INTEGER NOT NULL,
                price_min     REAL NOT NULL,
                price_max     REAL NOT NULL,
                discount_rate REAL NOT NULL,
                sales         INTEGER NOT NULL,
                captured_at   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_hist_item ON price_history(item_id, id);
            CREATE TABLE IF NOT EXISTS searches (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword     TEXT NOT NULL DEFAULT '',
                list_type   INTEGER,
                sort_type   INTEGER,
                pages       INTEGER NOT NULL DEFAULT 1,
                enabled     INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL,
                last_run_at TEXT,
                last_result TEXT
            );
            CREATE TABLE IF NOT EXISTS live_list (
                item_id  INTEGER PRIMARY KEY,
                position INTEGER NOT NULL,
                added_at TEXT NOT NULL,
                source   TEXT NOT NULL DEFAULT 'manual',
                note     TEXT
            );
            PRAGMA user_version = 1;",
        )?;
    }
    if version < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS peer_stats (
                keyword    TEXT PRIMARY KEY,
                median     REAL NOT NULL,
                p25        REAL NOT NULL,
                count      INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS product_peers (
                item_id INTEGER NOT NULL,
                keyword TEXT NOT NULL,
                PRIMARY KEY (item_id, keyword)
            );
            ALTER TABLE searches ADD COLUMN hunt_low_price INTEGER NOT NULL DEFAULT 1;
            PRAGMA user_version = 2;",
        )?;
    }
    Ok(())
}

/// Normaliza a palavra-chave usada como chave do grupo de pares.
pub fn norm_keyword(k: &str) -> String {
    k.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------- pares (mediana por palavra-chave) ----------

/// Recalcula mediana/p25 de uma palavra-chave a partir dos preços informados (amostra de referência).
pub fn update_peer_stats(conn: &Connection, keyword: &str, prices: &[f64], now: &str) -> DbResult<Option<PeerStats>> {
    let key = norm_keyword(keyword);
    if key.is_empty() {
        return Ok(None);
    }
    let Some((median, p25, count)) = deals::peer_quantiles(prices) else { return Ok(None) };
    conn.execute(
        "INSERT INTO peer_stats(keyword, median, p25, count, updated_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(keyword) DO UPDATE SET median = excluded.median, p25 = excluded.p25,
            count = excluded.count, updated_at = excluded.updated_at",
        params![key, median, p25, count as i64, now],
    )?;
    Ok(Some(PeerStats { keyword: key, median, p25, count }))
}

/// Associa produtos a um grupo de pares (palavra-chave).
pub fn link_peers(conn: &mut Connection, keyword: &str, item_ids: &[i64]) -> DbResult<()> {
    let key = norm_keyword(keyword);
    if key.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for id in item_ids {
        tx.execute("INSERT OR IGNORE INTO product_peers(item_id, keyword) VALUES(?1, ?2)", params![id, key])?;
    }
    tx.commit()
}

pub fn get_peer_stats(conn: &Connection, keyword: &str) -> DbResult<Option<PeerStats>> {
    conn.query_row(
        "SELECT keyword, median, p25, count FROM peer_stats WHERE keyword = ?1",
        [norm_keyword(keyword)],
        |r| Ok(PeerStats { keyword: r.get(0)?, median: r.get(1)?, p25: r.get(2)?, count: r.get::<_, i64>(3)? as u32 }),
    )
    .optional()
}

/// Para cada produto, o grupo de pares mais adequado: o MAIS ESPECÍFICO (menor) entre os que têm
/// amostra suficiente; se nenhum tiver, o maior (para a UI mostrar "poucos pares").
/// Palavra-chave genérica ("kit", "a") tende a ter grupo grande e mediana pouco representativa.
fn peer_map(conn: &Connection, min_count: u32) -> DbResult<HashMap<i64, PeerStats>> {
    let mut stmt = conn.prepare(
        "SELECT pp.item_id, ps.keyword, ps.median, ps.p25, ps.count
         FROM product_peers pp JOIN peer_stats ps ON ps.keyword = pp.keyword",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            PeerStats { keyword: r.get(1)?, median: r.get(2)?, p25: r.get(3)?, count: r.get::<_, i64>(4)? as u32 },
        ))
    })?;
    let min_count = min_count.max(1);
    let mut map: HashMap<i64, PeerStats> = HashMap::new();
    for row in rows {
        let (id, ps) = row?;
        match map.get(&id) {
            None => {
                map.insert(id, ps);
            }
            Some(cur) => {
                let cur_ok = cur.count >= min_count;
                let new_ok = ps.count >= min_count;
                let better = match (cur_ok, new_ok) {
                    (true, true) => ps.count < cur.count,   // ambos confiáveis → o mais específico
                    (false, true) => true,                  // só o novo é confiável
                    (true, false) => false,
                    (false, false) => ps.count > cur.count, // nenhum confiável → o maior
                };
                if better {
                    map.insert(id, ps);
                }
            }
        }
    }
    Ok(map)
}

// ---------- settings ----------

pub fn get_setting(conn: &Connection, key: &str) -> DbResult<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------- produtos / histórico ----------

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSummary {
    pub received: usize,
    pub new_products: usize,
    pub price_changes: usize,
    pub history_rows: usize,
}

/// Capturas sem mudança de preço só geram nova linha de histórico a cada N horas
/// (mantém a média "viva" sem inflar o banco).
const HEARTBEAT_HOURS: i64 = 6;

pub fn upsert_products(conn: &mut Connection, items: &[ProductOffer], now: &str) -> DbResult<UpsertSummary> {
    let tx = conn.transaction()?;
    let mut summary = UpsertSummary { received: items.len(), ..Default::default() };
    for p in items {
        if p.item_id <= 0 {
            continue;
        }
        let existing: Option<(f64, Option<String>)> = tx
            .query_row(
                "SELECT p.price_min,
                        (SELECT captured_at FROM price_history h WHERE h.item_id = p.item_id ORDER BY id DESC LIMIT 1)
                 FROM products p WHERE p.item_id = ?1",
                [p.item_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        tx.execute(
            "INSERT INTO products(item_id, shop_id, product_name, product_link, offer_link, image_url, shop_name,
                                  price_min, price_max, discount_rate, sales, rating, commission_rate, commission,
                                  first_seen, last_seen)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)
             ON CONFLICT(item_id) DO UPDATE SET
                shop_id = excluded.shop_id,
                product_name = CASE WHEN excluded.product_name <> '' THEN excluded.product_name ELSE products.product_name END,
                product_link = CASE WHEN excluded.product_link <> '' THEN excluded.product_link ELSE products.product_link END,
                offer_link   = CASE WHEN excluded.offer_link <> '' THEN excluded.offer_link ELSE products.offer_link END,
                image_url    = CASE WHEN excluded.image_url <> '' THEN excluded.image_url ELSE products.image_url END,
                shop_name    = CASE WHEN excluded.shop_name <> '' THEN excluded.shop_name ELSE products.shop_name END,
                price_min = excluded.price_min, price_max = excluded.price_max, discount_rate = excluded.discount_rate,
                sales = excluded.sales, rating = excluded.rating, commission_rate = excluded.commission_rate,
                commission = excluded.commission, last_seen = excluded.last_seen",
            params![
                p.item_id, p.shop_id, p.product_name, p.product_link, p.offer_link, p.image_url, p.shop_name,
                p.price_min, p.price_max, p.price_discount_rate, p.sales, p.rating_star, p.commission_rate,
                p.commission, now
            ],
        )?;

        let should_record = match &existing {
            None => {
                summary.new_products += 1;
                true
            }
            Some((old_price, last_capture)) => {
                let changed = (old_price - p.price_min).abs() > 0.005;
                if changed {
                    summary.price_changes += 1;
                }
                changed || last_capture.as_deref().map_or(true, |t| hours_since(t, now) >= HEARTBEAT_HOURS)
            }
        };
        if should_record {
            record_history(&tx, p, now)?;
            summary.history_rows += 1;
        }
    }
    tx.commit()?;
    Ok(summary)
}

fn record_history(tx: &Transaction, p: &ProductOffer, now: &str) -> DbResult<()> {
    tx.execute(
        "INSERT INTO price_history(item_id, price_min, price_max, discount_rate, sales, captured_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![p.item_id, p.price_min, p.price_max, p.price_discount_rate, p.sales, now],
    )?;
    Ok(())
}

fn hours_since(earlier: &str, later: &str) -> i64 {
    let a = chrono::DateTime::parse_from_rfc3339(earlier).ok();
    let b = chrono::DateTime::parse_from_rfc3339(later).ok();
    match (a, b) {
        (Some(a), Some(b)) => (b - a).num_hours(),
        _ => i64::MAX,
    }
}

pub fn prune_history(conn: &Connection, keep_days: i64) -> DbResult<usize> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(keep_days))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    conn.execute("DELETE FROM price_history WHERE captured_at < ?1", [cutoff])
}

/// Estatísticas das capturas anteriores à mais recente, por item.
fn history_map(conn: &Connection) -> DbResult<HashMap<i64, History>> {
    let mut stmt = conn.prepare(
        "WITH ranked AS (
            SELECT item_id, price_min,
                   ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY id DESC) AS rn
            FROM price_history
         )
         SELECT item_id, COUNT(*), AVG(price_min), MIN(price_min), MAX(price_min),
                MAX(CASE WHEN rn = 2 THEN price_min END)
         FROM ranked WHERE rn >= 2 GROUP BY item_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            History {
                samples: r.get::<_, i64>(1)? as u32,
                avg_price: r.get(2)?,
                min_price: r.get(3)?,
                max_price: r.get(4)?,
                prev_price: r.get(5)?,
            },
        ))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, h) = row?;
        map.insert(id, h);
    }
    Ok(map)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductRow {
    pub item_id: i64,
    pub shop_id: i64,
    pub product_name: String,
    pub product_link: String,
    pub offer_link: String,
    pub image_url: String,
    pub shop_name: String,
    pub price_min: f64,
    pub price_max: f64,
    pub discount_rate: f64,
    pub sales: i64,
    pub rating: f64,
    pub commission_rate: f64,
    pub commission: f64,
    pub first_seen: String,
    pub last_seen: String,
    pub notified_at: Option<String>,
}

const PRODUCT_COLS: &str = "item_id, shop_id, product_name, product_link, offer_link, image_url, shop_name, \
price_min, price_max, discount_rate, sales, rating, commission_rate, commission, first_seen, last_seen, notified_at";

fn map_product(r: &rusqlite::Row) -> DbResult<ProductRow> {
    Ok(ProductRow {
        item_id: r.get(0)?,
        shop_id: r.get(1)?,
        product_name: r.get(2)?,
        product_link: r.get(3)?,
        offer_link: r.get(4)?,
        image_url: r.get(5)?,
        shop_name: r.get(6)?,
        price_min: r.get(7)?,
        price_max: r.get(8)?,
        discount_rate: r.get(9)?,
        sales: r.get(10)?,
        rating: r.get(11)?,
        commission_rate: r.get(12)?,
        commission: r.get(13)?,
        first_seen: r.get(14)?,
        last_seen: r.get(15)?,
        notified_at: r.get(16)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deal {
    #[serde(flatten)]
    pub product: ProductRow,
    pub history: History,
    pub peers: Option<PeerStats>,
    pub eval: DealEval,
    pub in_live: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DealFilter {
    pub keyword: String,
    pub only_qualifying: bool,
    pub min_score: f64,
    pub max_price: f64,
    pub min_sales: i64,
    pub exclude_in_live: bool,
    /// score | discount | drop | price | sales | commission | recent
    pub sort: String,
    pub limit: usize,
    /// Só produtos vistos nas últimas N horas (0 = todos).
    pub seen_within_hours: i64,
    /// "" (todos) | "anomaly" (preço fora da curva) | "discount" (desconto/queda)
    pub kind: String,
}

pub fn list_deals(conn: &Connection, f: &DealFilter, th: &Thresholds) -> DbResult<Vec<Deal>> {
    let hist = history_map(conn)?;
    let peers = peer_map(conn, th.min_peer_count)?;
    let mut live_stmt = conn.prepare("SELECT item_id FROM live_list")?;
    let live: std::collections::HashSet<i64> =
        live_stmt.query_map([], |r| r.get::<_, i64>(0))?.collect::<DbResult<_>>()?;

    let kw = format!("%{}%", f.keyword.trim());
    let mut stmt = conn.prepare(&format!(
        "SELECT {PRODUCT_COLS} FROM products
         WHERE (?1 = '%%' OR product_name LIKE ?1 COLLATE NOCASE OR shop_name LIKE ?1 COLLATE NOCASE)"
    ))?;
    let products = stmt.query_map([&kw], map_product)?.collect::<DbResult<Vec<_>>>()?;

    let now = chrono::Utc::now();
    let mut out: Vec<Deal> = products
        .into_iter()
        .filter(|p| {
            if f.seen_within_hours > 0 {
                if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&p.last_seen) {
                    return (now - t.with_timezone(&chrono::Utc)).num_hours() <= f.seen_within_hours;
                }
            }
            true
        })
        .map(|p| {
            let h = hist.get(&p.item_id).cloned().unwrap_or_default();
            let ps = peers.get(&p.item_id).cloned();
            let eval = deals::evaluate(p.price_min, p.discount_rate, p.sales, p.rating, &h, ps.as_ref(), th);
            let in_live = live.contains(&p.item_id);
            Deal { product: p, history: h, peers: ps, eval, in_live }
        })
        .filter(|d| !f.only_qualifying || d.eval.qualifies)
        .filter(|d| match f.kind.as_str() {
            "anomaly" => d.eval.is_price_anomaly,
            "discount" => !d.eval.is_price_anomaly && (d.eval.kind == "discount" || d.eval.kind == "drop"),
            _ => true,
        })
        .filter(|d| d.eval.score >= f.min_score)
        .filter(|d| f.max_price <= 0.0 || d.product.price_min <= f.max_price)
        .filter(|d| d.product.sales >= f.min_sales)
        .filter(|d| !f.exclude_in_live || !d.in_live)
        .collect();

    match f.sort.as_str() {
        "discount" => out.sort_by(|a, b| b.product.discount_rate.total_cmp(&a.product.discount_rate)),
        "drop" => out.sort_by(|a, b| {
            b.eval.drop_vs_avg_pct.unwrap_or(f64::MIN).total_cmp(&a.eval.drop_vs_avg_pct.unwrap_or(f64::MIN))
        }),
        "peer" => out.sort_by(|a, b| {
            a.eval.peer_ratio.unwrap_or(f64::MAX).total_cmp(&b.eval.peer_ratio.unwrap_or(f64::MAX))
        }),
        "price" => out.sort_by(|a, b| a.product.price_min.total_cmp(&b.product.price_min)),
        "sales" => out.sort_by(|a, b| b.product.sales.cmp(&a.product.sales)),
        "commission" => out.sort_by(|a, b| b.product.commission_rate.total_cmp(&a.product.commission_rate)),
        "recent" => out.sort_by(|a, b| b.product.last_seen.cmp(&a.product.last_seen)),
        _ => out.sort_by(|a, b| b.eval.score.total_cmp(&a.eval.score)),
    }
    if f.limit > 0 {
        out.truncate(f.limit);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricePoint {
    pub captured_at: String,
    pub price_min: f64,
    pub discount_rate: f64,
    pub sales: i64,
}

pub fn product_history(conn: &Connection, item_id: i64) -> DbResult<Vec<PricePoint>> {
    let mut stmt = conn.prepare(
        "SELECT captured_at, price_min, discount_rate, sales FROM price_history WHERE item_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt
        .query_map([item_id], |r| {
            Ok(PricePoint { captured_at: r.get(0)?, price_min: r.get(1)?, discount_rate: r.get(2)?, sales: r.get(3)? })
        })?
        .collect();
    rows
}

pub fn mark_notified(conn: &Connection, item_ids: &[i64], now: &str) -> DbResult<()> {
    for id in item_ids {
        conn.execute("UPDATE products SET notified_at = ?1 WHERE item_id = ?2", params![now, id])?;
    }
    Ok(())
}

pub fn count_products(conn: &Connection) -> DbResult<i64> {
    conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0))
}

// ---------- buscas monitoradas ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearch {
    pub id: i64,
    pub keyword: String,
    pub list_type: Option<u8>,
    pub sort_type: Option<u8>,
    pub pages: u32,
    pub enabled: bool,
    pub created_at: String,
    pub last_run_at: Option<String>,
    pub last_result: Option<String>,
    /// Além da busca normal, consulta também ordenado por menor preço para caçar preços fora da curva.
    pub hunt_low_price: bool,
}

fn map_search(r: &rusqlite::Row) -> DbResult<SavedSearch> {
    Ok(SavedSearch {
        id: r.get(0)?,
        keyword: r.get(1)?,
        list_type: r.get::<_, Option<i64>>(2)?.map(|v| v as u8),
        sort_type: r.get::<_, Option<i64>>(3)?.map(|v| v as u8),
        pages: r.get::<_, i64>(4)? as u32,
        enabled: r.get::<_, i64>(5)? != 0,
        created_at: r.get(6)?,
        last_run_at: r.get(7)?,
        last_result: r.get(8)?,
        hunt_low_price: r.get::<_, i64>(9)? != 0,
    })
}

const SEARCH_COLS: &str = "id, keyword, list_type, sort_type, pages, enabled, created_at, last_run_at, last_result, hunt_low_price";

pub fn list_searches(conn: &Connection, only_enabled: bool) -> DbResult<Vec<SavedSearch>> {
    let sql = format!(
        "SELECT {SEARCH_COLS} FROM searches {} ORDER BY id ASC",
        if only_enabled { "WHERE enabled = 1" } else { "" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_search)?.collect();
    rows
}

pub fn add_search(
    conn: &Connection,
    keyword: &str,
    list_type: Option<u8>,
    sort_type: Option<u8>,
    pages: u32,
    hunt_low_price: bool,
) -> DbResult<SavedSearch> {
    conn.execute(
        "INSERT INTO searches(keyword, list_type, sort_type, pages, enabled, created_at, hunt_low_price) VALUES(?1,?2,?3,?4,1,?5,?6)",
        params![
            keyword.trim(),
            list_type.map(|v| v as i64),
            sort_type.map(|v| v as i64),
            pages.clamp(1, 10) as i64,
            now_rfc3339(),
            hunt_low_price as i64
        ],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(&format!("SELECT {SEARCH_COLS} FROM searches WHERE id = ?1"), [id], map_search)
}

pub fn set_search_enabled(conn: &Connection, id: i64, enabled: bool) -> DbResult<()> {
    conn.execute("UPDATE searches SET enabled = ?1 WHERE id = ?2", params![enabled as i64, id])?;
    Ok(())
}

pub fn delete_search(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM searches WHERE id = ?1", [id])?;
    Ok(())
}

pub fn touch_search(conn: &Connection, id: i64, result: &str, now: &str) -> DbResult<()> {
    conn.execute("UPDATE searches SET last_run_at = ?1, last_result = ?2 WHERE id = ?3", params![now, result, id])?;
    Ok(())
}

// ---------- lista da live ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveItem {
    pub item_id: i64,
    pub position: i64,
    pub added_at: String,
    pub source: String,
    pub note: Option<String>,
    pub shop_id: i64,
    pub product_name: String,
    pub product_link: String,
    pub offer_link: String,
    pub image_url: String,
    pub price_min: f64,
    pub discount_rate: f64,
    pub sales: i64,
    pub commission_rate: f64,
}

pub fn list_live(conn: &Connection) -> DbResult<Vec<LiveItem>> {
    let mut stmt = conn.prepare(
        "SELECT l.item_id, l.position, l.added_at, l.source, l.note,
                COALESCE(p.shop_id,0), COALESCE(p.product_name,''), COALESCE(p.product_link,''),
                COALESCE(p.offer_link,''), COALESCE(p.image_url,''), COALESCE(p.price_min,0),
                COALESCE(p.discount_rate,0), COALESCE(p.sales,0), COALESCE(p.commission_rate,0)
         FROM live_list l LEFT JOIN products p ON p.item_id = l.item_id
         ORDER BY l.position ASC, l.added_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(LiveItem {
            item_id: r.get(0)?,
            position: r.get(1)?,
            added_at: r.get(2)?,
            source: r.get(3)?,
            note: r.get(4)?,
            shop_id: r.get(5)?,
            product_name: r.get(6)?,
            product_link: r.get(7)?,
            offer_link: r.get(8)?,
            image_url: r.get(9)?,
            price_min: r.get(10)?,
            discount_rate: r.get(11)?,
            sales: r.get(12)?,
            commission_rate: r.get(13)?,
        })
    })?
    .collect();
    rows
}

/// Adiciona IDs ao final da lista (ignora duplicados). Retorna quantos entraram.
pub fn add_to_live(conn: &mut Connection, item_ids: &[i64], source: &str) -> DbResult<usize> {
    let tx = conn.transaction()?;
    let mut pos: i64 = tx.query_row("SELECT COALESCE(MAX(position), 0) FROM live_list", [], |r| r.get(0))?;
    let now = now_rfc3339();
    let mut added = 0;
    for id in item_ids {
        if *id <= 0 {
            continue;
        }
        pos += 1;
        let n = tx.execute(
            "INSERT OR IGNORE INTO live_list(item_id, position, added_at, source) VALUES(?1,?2,?3,?4)",
            params![id, pos, now, source],
        )?;
        added += n;
    }
    tx.commit()?;
    Ok(added)
}

pub fn remove_from_live(conn: &Connection, item_id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM live_list WHERE item_id = ?1", [item_id])?;
    Ok(())
}

pub fn clear_live(conn: &Connection) -> DbResult<()> {
    conn.execute("DELETE FROM live_list", [])?;
    Ok(())
}

pub fn move_live_item(conn: &mut Connection, item_id: i64, delta: i64) -> DbResult<()> {
    let items = list_live(conn)?;
    let Some(idx) = items.iter().position(|i| i.item_id == item_id) else { return Ok(()) };
    let new_idx = (idx as i64 + delta).clamp(0, items.len() as i64 - 1) as usize;
    if new_idx == idx {
        return Ok(());
    }
    let mut ids: Vec<i64> = items.iter().map(|i| i.item_id).collect();
    let moved = ids.remove(idx);
    ids.insert(new_idx, moved);
    let tx = conn.transaction()?;
    for (pos, id) in ids.iter().enumerate() {
        tx.execute("UPDATE live_list SET position = ?1 WHERE item_id = ?2", params![pos as i64 + 1, id])?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(id: i64, price: f64, discount: f64) -> ProductOffer {
        ProductOffer {
            item_id: id,
            shop_id: 1,
            product_name: format!("Produto {id}"),
            product_link: "https://x".into(),
            offer_link: "https://y".into(),
            image_url: String::new(),
            price_min: price,
            price_max: price,
            price_discount_rate: discount,
            sales: 500,
            rating_star: 4.5,
            commission_rate: 0.1,
            commission: price * 0.1,
            shop_name: "Loja".into(),
            period_start_time: 0,
            period_end_time: 0,
        }
    }

    #[test]
    fn upsert_builds_history_and_detects_drop() {
        let mut conn = open_in_memory().unwrap();
        let th = Thresholds { min_history_samples: 2, ..Default::default() };
        for (i, price) in [100.0, 100.5, 99.5, 101.0].iter().enumerate() {
            let now = format!("2026-01-0{}T00:00:00Z", i + 1);
            upsert_products(&mut conn, &[offer(1, *price, 0.0)], &now).unwrap();
        }
        let before = list_deals(&conn, &DealFilter::default(), &th).unwrap();
        assert_eq!(before.len(), 1);
        assert!(!before[0].eval.qualifies);

        upsert_products(&mut conn, &[offer(1, 60.0, 0.0)], "2026-01-05T00:00:00Z").unwrap();
        let after = list_deals(&conn, &DealFilter { only_qualifying: true, ..Default::default() }, &th).unwrap();
        assert_eq!(after.len(), 1);
        let d = &after[0];
        assert_eq!(d.history.samples, 4);
        assert!(d.eval.drop_vs_avg_pct.unwrap() > 35.0);
        assert!(d.eval.is_lowest_ever);
        assert_eq!(product_history(&conn, 1).unwrap().len(), 5);
    }

    #[test]
    fn heartbeat_skips_unchanged_price_within_window() {
        let mut conn = open_in_memory().unwrap();
        upsert_products(&mut conn, &[offer(2, 10.0, 0.0)], "2026-01-01T00:00:00Z").unwrap();
        upsert_products(&mut conn, &[offer(2, 10.0, 0.0)], "2026-01-01T01:00:00Z").unwrap();
        assert_eq!(product_history(&conn, 2).unwrap().len(), 1);
        upsert_products(&mut conn, &[offer(2, 10.0, 0.0)], "2026-01-01T07:00:00Z").unwrap();
        assert_eq!(product_history(&conn, 2).unwrap().len(), 2);
    }

    #[test]
    fn live_list_dedupes_and_reorders() {
        let mut conn = open_in_memory().unwrap();
        upsert_products(&mut conn, &[offer(1, 1.0, 0.0), offer(2, 2.0, 0.0), offer(3, 3.0, 0.0)], "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(add_to_live(&mut conn, &[1, 2, 2, 3], "manual").unwrap(), 3);
        assert_eq!(add_to_live(&mut conn, &[1], "auto").unwrap(), 0);
        move_live_item(&mut conn, 3, -2).unwrap();
        let ids: Vec<i64> = list_live(&conn).unwrap().iter().map(|i| i.item_id).collect();
        assert_eq!(ids, vec![3, 1, 2]);
        remove_from_live(&conn, 1).unwrap();
        assert_eq!(list_live(&conn).unwrap().len(), 2);
        let deals = list_deals(&conn, &DealFilter { exclude_in_live: true, ..Default::default() }, &Thresholds::default()).unwrap();
        assert_eq!(deals.len(), 1);
        assert_eq!(deals[0].product.item_id, 1);
    }

    #[test]
    fn peer_anomaly_detected_via_list_deals() {
        let mut conn = open_in_memory().unwrap();
        // 10 camisetas "normais" + 1 a R$ 2 de vendedor novo
        let mut items: Vec<ProductOffer> = (1..=10).map(|i| offer(i, 30.0 + i as f64, 0.0)).collect();
        let mut cheap = offer(99, 2.0, 0.0);
        cheap.sales = 0;
        cheap.rating_star = 0.0;
        items.push(cheap);
        upsert_products(&mut conn, &items, "2026-01-01T00:00:00Z").unwrap();
        let prices: Vec<f64> = items.iter().map(|p| p.price_min).collect();
        let ps = update_peer_stats(&conn, " Camiseta  Básica ", &prices, "2026-01-01T00:00:00Z").unwrap().unwrap();
        assert_eq!(ps.keyword, "camiseta básica");
        assert_eq!(ps.count, 11);
        link_peers(&mut conn, "camiseta básica", &items.iter().map(|p| p.item_id).collect::<Vec<_>>()).unwrap();

        let f = DealFilter { only_qualifying: true, kind: "anomaly".into(), ..Default::default() };
        let deals = list_deals(&conn, &f, &Thresholds::default()).unwrap();
        assert_eq!(deals.len(), 1);
        assert_eq!(deals[0].product.item_id, 99);
        assert!(deals[0].eval.is_price_anomaly);
        assert!(deals[0].eval.new_seller_hint);
        assert_eq!(deals[0].peers.as_ref().unwrap().keyword, "camiseta básica");
        // sem filtro de tipo, o item caro não qualifica
        let all = list_deals(&conn, &DealFilter { only_qualifying: true, ..Default::default() }, &Thresholds::default()).unwrap();
        assert_eq!(all.len(), 1);
        assert!(get_peer_stats(&conn, "CAMISETA básica").unwrap().is_some());
        assert!(update_peer_stats(&conn, "   ", &prices, "x").unwrap().is_none());

        // Grupo genérico grande ("a", mediana alta) + grupo específico pequeno mas suficiente:
        // o produto deve usar o específico.
        let big: Vec<f64> = (1..=40).map(|i| 100.0 + i as f64).collect();
        update_peer_stats(&conn, "a", &big, "2026-01-01T00:00:00Z").unwrap();
        link_peers(&mut conn, "a", &[99]).unwrap();
        let th = Thresholds { min_peer_count: 8, ..Default::default() };
        let d = list_deals(&conn, &DealFilter { keyword: "Produto 99".into(), ..Default::default() }, &th).unwrap();
        assert_eq!(d[0].peers.as_ref().unwrap().keyword, "camiseta básica");
        // se o específico não tiver amostra suficiente, cai no maior
        let th_strict = Thresholds { min_peer_count: 20, ..Default::default() };
        let d = list_deals(&conn, &DealFilter { keyword: "Produto 99".into(), ..Default::default() }, &th_strict).unwrap();
        assert_eq!(d[0].peers.as_ref().unwrap().keyword, "a");
    }

    #[test]
    fn searches_crud() {
        let conn = open_in_memory().unwrap();
        let s = add_search(&conn, " fone ", Some(1), Some(2), 99, true).unwrap();
        assert_eq!(s.keyword, "fone");
        assert_eq!(s.pages, 10);
        assert!(s.hunt_low_price);
        set_search_enabled(&conn, s.id, false).unwrap();
        assert!(list_searches(&conn, true).unwrap().is_empty());
        assert_eq!(list_searches(&conn, false).unwrap().len(), 1);
        delete_search(&conn, s.id).unwrap();
        assert!(list_searches(&conn, false).unwrap().is_empty());
    }
}
