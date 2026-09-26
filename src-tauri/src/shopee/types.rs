use serde::{Deserialize, Deserializer, Serialize};

/// Parâmetros do `productOfferV2`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductQuery {
    pub keyword: Option<String>,
    pub shop_id: Option<i64>,
    pub item_id: Option<i64>,
    /// 0 = Recomendados, 1 = Maior comissão, 2 = Melhor desempenho
    pub list_type: Option<u8>,
    /// 1 = Relevância, 2 = Vendas, 3 = Maior preço, 4 = Menor preço, 5 = Comissão
    pub sort_type: Option<u8>,
    pub is_ams_offer: Option<bool>,
    pub is_key_seller: Option<bool>,
    #[serde(default = "default_page")]
    pub page: u32,
    /// 1..=500
    #[serde(default = "default_limit")]
    pub limit: u32,
}

fn default_page() -> u32 {
    1
}
fn default_limit() -> u32 {
    50
}

impl ProductQuery {
    /// Gera o texto da query GraphQL. Strings são escapadas via serde_json.
    pub fn to_graphql(&self) -> String {
        let mut args: Vec<String> = Vec::new();
        if let Some(k) = self.keyword.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            args.push(format!("keyword: {}", serde_json::to_string(k).unwrap_or_default()));
        }
        if let Some(v) = self.shop_id {
            args.push(format!("shopId: {v}"));
        }
        if let Some(v) = self.item_id {
            args.push(format!("itemId: {v}"));
        }
        if let Some(v) = self.list_type {
            args.push(format!("listType: {v}"));
        }
        if let Some(v) = self.sort_type {
            args.push(format!("sortType: {v}"));
        }
        if let Some(v) = self.is_ams_offer {
            args.push(format!("isAMSOffer: {v}"));
        }
        if let Some(v) = self.is_key_seller {
            args.push(format!("isKeySeller: {v}"));
        }
        args.push(format!("page: {}", self.page.max(1)));
        args.push(format!("limit: {}", self.limit.clamp(1, 500)));

        format!(
            "{{ productOfferV2({}) {{ nodes {{ {} }} pageInfo {{ page limit hasNextPage }} }} }}",
            args.join(", "),
            PRODUCT_FIELDS
        )
    }
}

pub const PRODUCT_FIELDS: &str = "itemId shopId productName productLink offerLink imageUrl \
priceMin priceMax priceDiscountRate sales ratingStar commissionRate commission shopName \
periodStartTime periodEndTime";

/// Um produto retornado pela API (campos normalizados para números).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProductOffer {
    #[serde(deserialize_with = "de_i64")]
    pub item_id: i64,
    #[serde(default, deserialize_with = "de_i64")]
    pub shop_id: i64,
    #[serde(default)]
    pub product_name: String,
    #[serde(default)]
    pub product_link: String,
    #[serde(default)]
    pub offer_link: String,
    #[serde(default)]
    pub image_url: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub price_min: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub price_max: f64,
    /// Percentual (0-100) informado pela Shopee.
    #[serde(default, deserialize_with = "de_f64")]
    pub price_discount_rate: f64,
    #[serde(default, deserialize_with = "de_i64")]
    pub sales: i64,
    #[serde(default, deserialize_with = "de_f64")]
    pub rating_star: f64,
    /// Fração (0.05 = 5%).
    #[serde(default, deserialize_with = "de_f64")]
    pub commission_rate: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub commission: f64,
    #[serde(default)]
    pub shop_name: String,
    #[serde(default, deserialize_with = "de_i64")]
    pub period_start_time: i64,
    #[serde(default, deserialize_with = "de_i64")]
    pub period_end_time: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    #[serde(default, deserialize_with = "de_i64")]
    pub page: i64,
    #[serde(default, deserialize_with = "de_i64")]
    pub limit: i64,
    #[serde(default)]
    pub has_next_page: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProductPage {
    #[serde(default)]
    pub nodes: Vec<ProductOffer>,
    #[serde(default)]
    pub page_info: PageInfo,
}

/// A API ora devolve números como string ("19.90"), ora como número, ora null.
#[derive(Deserialize)]
#[serde(untagged)]
enum Loose {
    Num(f64),
    Str(String),
    Null,
}

pub fn de_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(match Option::<Loose>::deserialize(d)? {
        Some(Loose::Num(n)) => n,
        Some(Loose::Str(s)) => s.trim().replace(',', ".").parse().unwrap_or(0.0),
        _ => 0.0,
    })
}

pub fn de_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(match Option::<Loose>::deserialize(d)? {
        Some(Loose::Num(n)) => n as i64,
        Some(Loose::Str(s)) => s.trim().parse::<f64>().map(|v| v as i64).unwrap_or(0),
        _ => 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphql_escapes_keyword_and_clamps() {
        let q = ProductQuery {
            keyword: Some("fone \"bluetooth\"".into()),
            list_type: Some(1),
            sort_type: Some(2),
            page: 0,
            limit: 9999,
            ..Default::default()
        };
        let s = q.to_graphql();
        assert!(s.contains(r#"keyword: "fone \"bluetooth\"""#));
        assert!(s.contains("page: 1"));
        assert!(s.contains("limit: 500"));
        assert!(s.contains("listType: 1"));
    }

    #[test]
    fn deserializes_loose_numbers() {
        let json = r#"{"itemId":"123","shopId":9,"productName":"x","priceMin":"19.90","priceMax":25,"priceDiscountRate":null,"sales":"10","commissionRate":"0.05"}"#;
        let p: ProductOffer = serde_json::from_str(json).unwrap();
        assert_eq!(p.item_id, 123);
        assert_eq!(p.price_min, 19.90);
        assert_eq!(p.price_max, 25.0);
        assert_eq!(p.price_discount_rate, 0.0);
        assert_eq!(p.sales, 10);
        assert_eq!(p.commission_rate, 0.05);
    }
}
