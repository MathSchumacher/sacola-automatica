//! Integração com a Shopee Affiliate Open API (GraphQL).
//!
//! Endpoint BR: https://open-api.affiliate.shopee.com.br/graphql
//! Autenticação: header `Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature={sig}`
//! onde `sig = sha256_hex(AppId + Timestamp + Payload + Secret)`.

pub mod auth;
pub mod client;
pub mod mock;
pub mod types;

pub use client::ShopeeClient;
pub use types::{ProductOffer, ProductPage, ProductQuery};
