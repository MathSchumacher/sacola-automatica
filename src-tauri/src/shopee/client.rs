use super::auth::authorization_header;
use super::types::{ProductPage, ProductQuery};
use serde::Deserialize;
use std::time::Duration;

pub const ENDPOINT_BR: &str = "https://open-api.affiliate.shopee.com.br/graphql";

#[derive(Debug, thiserror::Error)]
pub enum ShopeeError {
    #[error("falha de rede: {0}")]
    Http(#[from] reqwest::Error),
    #[error("limite de requisições atingido (10030) — aguarde e reduza a frequência")]
    RateLimited,
    #[error("credenciais inválidas ou assinatura rejeitada ({code}): {message}")]
    Unauthorized { code: i64, message: String },
    #[error("erro da API Shopee ({code}): {message}")]
    Api { code: i64, message: String },
    #[error("resposta inesperada da API: {0}")]
    Parse(String),
}

#[derive(Debug, Clone)]
pub struct ShopeeClient {
    app_id: String,
    secret: String,
    endpoint: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct GqlResponse {
    #[serde(default)]
    data: Option<serde_json::Value>,
    #[serde(default)]
    errors: Vec<GqlError>,
}

#[derive(Deserialize)]
struct GqlError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    extensions: Option<GqlExt>,
}

#[derive(Deserialize)]
struct GqlExt {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    message: Option<String>,
}

impl ShopeeClient {
    pub fn new(app_id: impl Into<String>, secret: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("AchadinhosShopee/0.1 (desktop)")
            .build()
            .expect("reqwest client");
        Self {
            app_id: app_id.into(),
            secret: secret.into(),
            endpoint: ENDPOINT_BR.to_string(),
            http,
        }
    }

    pub fn app_id(&self) -> &str {
        &self.app_id
    }

    /// Executa uma query GraphQL crua e devolve `data`.
    pub async fn graphql(&self, query: &str) -> Result<serde_json::Value, ShopeeError> {
        let payload = serde_json::json!({ "query": query }).to_string();
        let ts = chrono::Utc::now().timestamp();
        let auth = authorization_header(&self.app_id, ts, &payload, &self.secret);

        let resp = self
            .http
            .post(&self.endpoint)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;
        let parsed: GqlResponse = serde_json::from_str(&text).map_err(|e| {
            ShopeeError::Parse(format!("HTTP {status}: {e} — corpo: {}", truncate(&text, 300)))
        })?;

        if let Some(err) = parsed.errors.first() {
            let code = err.extensions.as_ref().and_then(|e| e.code).unwrap_or(-1);
            let message = err
                .extensions
                .as_ref()
                .and_then(|e| e.message.clone())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| err.message.clone());
            let lower = message.to_lowercase();
            return Err(match code {
                10030 => ShopeeError::RateLimited,
                10020 | 10031 | 10035 | 10040 => ShopeeError::Unauthorized { code, message },
                _ if lower.contains("signature") || lower.contains("credential") => {
                    ShopeeError::Unauthorized { code, message }
                }
                _ => ShopeeError::Api { code, message },
            });
        }

        if !status.is_success() {
            return Err(ShopeeError::Api {
                code: status.as_u16() as i64,
                message: truncate(&text, 300),
            });
        }

        parsed
            .data
            .ok_or_else(|| ShopeeError::Parse("resposta sem campo `data`".into()))
    }

    pub async fn product_offers(&self, q: &ProductQuery) -> Result<ProductPage, ShopeeError> {
        let data = self.graphql(&q.to_graphql()).await?;
        let node = data
            .get("productOfferV2")
            .cloned()
            .ok_or_else(|| ShopeeError::Parse("resposta sem `productOfferV2`".into()))?;
        serde_json::from_value(node).map_err(|e| ShopeeError::Parse(e.to_string()))
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}
