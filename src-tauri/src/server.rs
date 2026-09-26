//! Servidor HTTP local mínimo (127.0.0.1:47831) para a extensão "Achadinhos Live Helper".
//!
//! Rotas:
//! - `GET  /health`                → {"ok":true,"mode":"live|mock"}
//! - `GET  /resolve?itemId=123`    → {"itemId","shopId","productLink","offerLink","productName","priceMin"} via productOfferV2
//! - `POST /favorited` {"itemIds":[..],"source":"chat"} → registra os IDs na lista da live (origem "chat")
//! - `GET  /live/ids`              → {"itemIds":[..]}
//!
//! Sem dependências extras: parser HTTP/1.1 suficiente para requisições pequenas da extensão.

use crate::db;
use crate::scheduler::EVT_LIVE_CHANGED;
use crate::shopee::ProductQuery;
use crate::state::AppState;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 47831;

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("local-http".into())
        .spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
                Ok(l) => l,
                Err(e) => {
                    log::warn!("servidor local não iniciou na porta {PORT}: {e} (a extensão do navegador não terá integração)");
                    return;
                }
            };
            log::info!("servidor local da extensão em http://127.0.0.1:{PORT}");
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            if let Err(e) = handle(&app, s) {
                                log::debug!("requisição local falhou: {e}");
                            }
                        });
                    }
                    Err(e) => log::debug!("accept falhou: {e}"),
                }
            }
        })
        .expect("thread do servidor local");
}

struct Request {
    method: String,
    path: String,
    query: String,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let target = parts.next().unwrap_or("/");
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.to_string(), String::new()),
    };
    let mut content_length = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; content_length.min(64 * 1024)];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok(Request { method, path, query, body: String::from_utf8_lossy(&body).to_string() })
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\nAccess-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then_some(v)
    })
}

fn handle(app: &AppHandle, mut stream: TcpStream) -> std::io::Result<()> {
    let req = read_request(&mut stream)?;
    if req.method == "OPTIONS" {
        return respond(&mut stream, 204, "");
    }
    let state = app.state::<AppState>();
    let (status, body) = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/health") => {
            let live = tauri::async_runtime::block_on(state.is_live());
            (200, serde_json::json!({ "ok": true, "mode": if live { "live" } else { "mock" }, "version": env!("CARGO_PKG_VERSION") }).to_string())
        }
        ("GET", "/resolve") => match query_param(&req.query, "itemId").and_then(|v| v.parse::<i64>().ok()) {
            None => (400, serde_json::json!({ "error": "itemId inválido" }).to_string()),
            Some(item_id) => {
                let q = ProductQuery { item_id: Some(item_id), limit: 1, page: 1, ..Default::default() };
                match tauri::async_runtime::block_on(state.fetch_products(&q)) {
                    Ok(page) => match page.nodes.into_iter().find(|n| n.item_id == item_id).or_else(|| None) {
                        Some(p) => {
                            let now = db::now_rfc3339();
                            let _ = state.with_db(|c| db::upsert_products(c, std::slice::from_ref(&p), &now));
                            (
                                200,
                                serde_json::json!({
                                    "itemId": p.item_id, "shopId": p.shop_id, "productLink": p.product_link,
                                    "offerLink": p.offer_link, "productName": p.product_name, "priceMin": p.price_min
                                })
                                .to_string(),
                            )
                        }
                        None => (404, serde_json::json!({ "error": "produto não encontrado na API de afiliados" }).to_string()),
                    },
                    Err(e) => (502, serde_json::json!({ "error": e }).to_string()),
                }
            }
        },
        ("POST", "/favorited") => {
            #[derive(serde::Deserialize)]
            struct Body {
                #[serde(default)]
                item_ids: Vec<i64>,
                #[serde(default, rename = "itemIds")]
                item_ids_camel: Vec<i64>,
                #[serde(default)]
                source: Option<String>,
            }
            match serde_json::from_str::<Body>(&req.body) {
                Err(e) => (400, serde_json::json!({ "error": format!("JSON inválido: {e}") }).to_string()),
                Ok(b) => {
                    let ids: Vec<i64> = b.item_ids.into_iter().chain(b.item_ids_camel).filter(|i| *i > 0).collect();
                    let source = b.source.unwrap_or_else(|| "chat".into());
                    match state.with_db(|c| db::add_to_live(c, &ids, &source)) {
                        Ok(n) => {
                            let _ = app.emit(EVT_LIVE_CHANGED, ());
                            (200, serde_json::json!({ "added": n }).to_string())
                        }
                        Err(e) => (500, serde_json::json!({ "error": e }).to_string()),
                    }
                }
            }
        }
        ("GET", "/live/ids") => match state.with_db(|c| db::list_live(c)) {
            Ok(items) => (200, serde_json::json!({ "itemIds": items.iter().map(|i| i.item_id).collect::<Vec<_>>() }).to_string()),
            Err(e) => (500, serde_json::json!({ "error": e }).to_string()),
        },
        _ => (404, serde_json::json!({ "error": "rota não encontrada" }).to_string()),
    };
    respond(&mut stream, status, &body)
}
