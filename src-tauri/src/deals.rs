//! Regras puras para classificar um produto como "achadinho".
//! Sem dependência de banco ou framework — tudo que decide "é oferta?" passa por aqui.
//!
//! Três tipos de achadinho:
//! - `anomaly`  — preço fora da curva em relação aos pares (mesma palavra-chave): o "bug" de preço,
//!                típico de vendedor novo (camiseta R$ 2, tênis R$ 8). Não exige vendas.
//! - `drop`     — preço bem abaixo da média histórica registrada pelo próprio app.
//! - `discount` — desconto alto informado pela Shopee.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thresholds {
    /// Desconto informado pela Shopee (%) a partir do qual já conta como achadinho.
    pub min_discount_rate: f64,
    /// Queda (%) em relação à média histórica do próprio app.
    pub min_drop_vs_avg: f64,
    /// Vendas mínimas (só para os tipos desconto/queda — vendedor novo não tem vendas).
    pub min_sales: i64,
    /// Amostras mínimas de histórico para confiar na média.
    pub min_history_samples: u32,
    /// Preço ÷ mediana dos pares abaixo do qual é "fora da curva" (0.35 = 65% mais barato que o normal).
    pub max_peer_ratio: f64,
    /// Quantos pares são necessários para a mediana valer.
    pub min_peer_count: u32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            min_discount_rate: 30.0,
            min_drop_vs_avg: 15.0,
            min_sales: 20,
            min_history_samples: 3,
            max_peer_ratio: 0.35,
            min_peer_count: 8,
        }
    }
}

/// Estatísticas das capturas ANTERIORES (exclui a captura atual).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub samples: u32,
    pub avg_price: Option<f64>,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub prev_price: Option<f64>,
}

/// Estatísticas do grupo de pares (produtos da mesma palavra-chave).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerStats {
    pub keyword: String,
    pub median: f64,
    pub p25: f64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DealEval {
    /// Positivo = está mais barato que a média histórica.
    pub drop_vs_avg_pct: Option<f64>,
    /// Positivo = caiu desde a captura anterior.
    pub drop_vs_prev_pct: Option<f64>,
    pub is_lowest_ever: bool,
    /// preço ÷ mediana dos pares (0.05 = 95% abaixo do normal).
    pub peer_ratio: Option<f64>,
    pub peer_median: Option<f64>,
    pub peer_keyword: Option<String>,
    pub peer_count: u32,
    pub is_price_anomaly: bool,
    /// Sinais de vendedor novo / anúncio recém-criado (poucas vendas e sem avaliação).
    pub new_seller_hint: bool,
    /// "anomaly" | "drop" | "discount" | "none"
    pub kind: String,
    /// 0..=100 — quanto maior, melhor o achadinho.
    pub score: f64,
    pub qualifies: bool,
    pub reasons: Vec<String>,
}

fn pct_drop(reference: f64, current: f64) -> Option<f64> {
    if reference > 0.0 && current >= 0.0 {
        Some(((reference - current) / reference * 1000.0).round() / 10.0)
    } else {
        None
    }
}

/// Mediana e percentil 25 de uma lista de preços (ignora <= 0).
pub fn peer_quantiles(prices: &[f64]) -> Option<(f64, f64, u32)> {
    let mut v: Vec<f64> = prices.iter().copied().filter(|p| *p > 0.0 && p.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let q = |f: f64| -> f64 {
        let pos = f * (v.len() - 1) as f64;
        let lo = pos.floor() as usize;
        let hi = pos.ceil() as usize;
        if lo == hi {
            v[lo]
        } else {
            v[lo] + (v[hi] - v[lo]) * (pos - lo as f64)
        }
    };
    Some((q(0.5), q(0.25), v.len() as u32))
}

pub fn evaluate(
    price: f64,
    discount_rate: f64,
    sales: i64,
    rating: f64,
    hist: &History,
    peer: Option<&PeerStats>,
    th: &Thresholds,
) -> DealEval {
    let trusted_history = hist.samples >= th.min_history_samples.max(1);
    let drop_vs_avg_pct = if trusted_history { hist.avg_price.and_then(|avg| pct_drop(avg, price)) } else { None };
    let drop_vs_prev_pct = hist.prev_price.and_then(|p| pct_drop(p, price));
    let is_lowest_ever = hist.samples >= 1 && hist.min_price.map_or(false, |m| price < m * 0.999);

    // ----- pares / anomalia -----
    let peer_ok = peer.map_or(false, |p| p.count >= th.min_peer_count.max(1) && p.median > 0.0);
    let peer_ratio = if peer_ok { peer.map(|p| ((price / p.median) * 1000.0).round() / 1000.0) } else { None };
    let peer_median = if peer_ok { peer.map(|p| p.median) } else { None };
    let peer_keyword = peer.map(|p| p.keyword.clone());
    let peer_count = peer.map_or(0, |p| p.count);
    let is_price_anomaly = price > 0.0 && peer_ratio.map_or(false, |r| r <= th.max_peer_ratio && th.max_peer_ratio > 0.0);
    let new_seller_hint = sales <= 30 && rating <= 0.0;

    let mut reasons = Vec::new();
    if is_price_anomaly {
        let r = peer_ratio.unwrap_or(1.0);
        reasons.push(format!(
            "{:.0}% abaixo da mediana de \"{}\" (R$ {:.2}, {} itens)",
            (1.0 - r) * 100.0,
            peer_keyword.as_deref().unwrap_or("-"),
            peer_median.unwrap_or(0.0),
            peer_count
        ));
        if new_seller_hint {
            reasons.push("sem vendas/avaliações — possível vendedor novo".to_string());
        }
    }

    let discount_ok = discount_rate >= th.min_discount_rate && th.min_discount_rate > 0.0;
    if discount_ok {
        reasons.push(format!("{:.0}% de desconto na Shopee", discount_rate));
    }
    let drop_ok = drop_vs_avg_pct.map_or(false, |d| d >= th.min_drop_vs_avg && th.min_drop_vs_avg > 0.0);
    if let Some(d) = drop_vs_avg_pct {
        if drop_ok {
            reasons.push(format!("{:.1}% abaixo da média histórica", d));
        }
    }
    if is_lowest_ever {
        reasons.push("menor preço já registrado".to_string());
    }
    let sales_ok = sales >= th.min_sales;
    if !sales_ok && !is_price_anomaly && (discount_ok || drop_ok) {
        reasons.push(format!("poucas vendas ({sales})"));
    }

    let sales_bonus = ((sales.max(0) as f64 + 1.0).log10() * 3.0).min(10.0);
    let mut score = 0.45 * discount_rate.clamp(0.0, 100.0)
        + 1.2 * drop_vs_avg_pct.unwrap_or(0.0).max(0.0)
        + if is_lowest_ever { 10.0 } else { 0.0 }
        + sales_bonus;
    if is_price_anomaly {
        // Quanto mais longe da mediana, maior o score: ratio 0.35 → ~66, ratio 0.05 → ~95.
        score = score.max(50.0 + 48.0 * (1.0 - peer_ratio.unwrap_or(1.0) / th.max_peer_ratio.max(0.01)).clamp(0.0, 1.0) + 2.0);
    }
    let score = score.clamp(0.0, 100.0);

    let qualifies = is_price_anomaly || (sales_ok && (discount_ok || drop_ok));
    let kind = if is_price_anomaly {
        "anomaly"
    } else if drop_ok && sales_ok {
        "drop"
    } else if discount_ok && sales_ok {
        "discount"
    } else {
        "none"
    };

    DealEval {
        drop_vs_avg_pct,
        drop_vs_prev_pct,
        is_lowest_ever,
        peer_ratio,
        peer_median,
        peer_keyword,
        peer_count,
        is_price_anomaly,
        new_seller_hint,
        kind: kind.to_string(),
        score: (score * 10.0).round() / 10.0,
        qualifies,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hist(samples: u32, avg: f64, min: f64, prev: f64) -> History {
        History { samples, avg_price: Some(avg), min_price: Some(min), max_price: Some(avg * 1.2), prev_price: Some(prev) }
    }
    fn peers(median: f64, count: u32) -> PeerStats {
        PeerStats { keyword: "camiseta".into(), median, p25: median * 0.8, count }
    }
    fn th() -> Thresholds {
        Thresholds::default()
    }

    #[test]
    fn qualifies_by_shopee_discount_alone() {
        let e = evaluate(50.0, 45.0, 100, 4.5, &History::default(), None, &th());
        assert!(e.qualifies);
        assert_eq!(e.kind, "discount");
        assert!(e.drop_vs_avg_pct.is_none());
        assert!(e.score > 20.0);
    }

    #[test]
    fn qualifies_by_history_drop_without_shopee_discount() {
        let e = evaluate(70.0, 0.0, 100, 4.5, &hist(5, 100.0, 95.0, 98.0), None, &th());
        assert_eq!(e.drop_vs_avg_pct, Some(30.0));
        assert!(e.is_lowest_ever);
        assert!(e.qualifies);
        assert_eq!(e.kind, "drop");
        assert!(e.reasons.iter().any(|r| r.contains("menor preço")));
    }

    #[test]
    fn history_not_trusted_with_few_samples() {
        let e = evaluate(70.0, 0.0, 100, 4.5, &hist(1, 100.0, 100.0, 100.0), None, &th());
        assert!(e.drop_vs_avg_pct.is_none());
        assert!(!e.qualifies);
        assert_eq!(e.drop_vs_prev_pct, Some(30.0));
    }

    #[test]
    fn low_sales_blocks_discount_qualification() {
        let e = evaluate(50.0, 60.0, 3, 4.5, &History::default(), None, &th());
        assert!(!e.qualifies);
        assert!(e.reasons.iter().any(|r| r.contains("poucas vendas")));
    }

    #[test]
    fn price_increase_is_negative_drop() {
        let e = evaluate(120.0, 0.0, 100, 4.5, &hist(5, 100.0, 90.0, 100.0), None, &th());
        assert_eq!(e.drop_vs_avg_pct, Some(-20.0));
        assert!(!e.qualifies);
    }

    #[test]
    fn price_anomaly_qualifies_even_without_sales() {
        // camiseta a R$ 2 com mediana R$ 35 e vendedor novo (0 vendas, sem nota)
        let e = evaluate(2.0, 0.0, 0, 0.0, &History::default(), Some(&peers(35.0, 40)), &th());
        assert!(e.is_price_anomaly);
        assert!(e.new_seller_hint);
        assert!(e.qualifies);
        assert_eq!(e.kind, "anomaly");
        assert_eq!(e.peer_ratio, Some(0.057));
        assert!(e.score >= 85.0, "score {}", e.score);
        assert!(e.reasons.iter().any(|r| r.contains("mediana")));
        assert!(e.reasons.iter().any(|r| r.contains("vendedor novo")));
    }

    #[test]
    fn anomaly_needs_enough_peers_and_ratio() {
        let few = evaluate(2.0, 0.0, 0, 0.0, &History::default(), Some(&peers(35.0, 3)), &th());
        assert!(!few.is_price_anomaly);
        assert!(few.peer_ratio.is_none());
        let not_cheap_enough = evaluate(20.0, 0.0, 0, 0.0, &History::default(), Some(&peers(35.0, 40)), &th());
        assert!(!not_cheap_enough.is_price_anomaly);
        assert_eq!(not_cheap_enough.peer_ratio, Some(0.571));
        assert!(!not_cheap_enough.qualifies);
    }

    #[test]
    fn anomaly_score_grows_as_price_falls() {
        let a = evaluate(12.0, 0.0, 0, 0.0, &History::default(), Some(&peers(35.0, 40)), &th());
        let b = evaluate(3.0, 0.0, 0, 0.0, &History::default(), Some(&peers(35.0, 40)), &th());
        assert!(a.is_price_anomaly && b.is_price_anomaly);
        assert!(b.score > a.score);
    }

    #[test]
    fn quantiles() {
        let (med, p25, n) = peer_quantiles(&[10.0, 20.0, 30.0, 40.0, 0.0, -1.0]).unwrap();
        assert_eq!(n, 4);
        assert_eq!(med, 25.0);
        assert_eq!(p25, 17.5);
        assert!(peer_quantiles(&[]).is_none());
    }
}
