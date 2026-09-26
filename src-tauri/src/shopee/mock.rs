//! Gerador de dados fictícios para desenvolver/testar sem credenciais.
//! Os preços variam deterministicamente com `tick` para popular o histórico.

use super::types::{PageInfo, ProductOffer, ProductPage, ProductQuery};

const CATALOG: &[(&str, &str, f64)] = &[
    ("Fone de Ouvido Bluetooth TWS", "TechStore BR", 89.90),
    ("Smartwatch D20 Relógio Inteligente", "GadgetMania", 59.90),
    ("Air Fryer 4L Digital 1500W", "Casa & Cozinha", 349.00),
    ("Kit 10 Pares Meias Cano Alto", "Meias Brasil", 39.90),
    ("Luminária LED de Mesa Articulada", "Iluminar", 64.90),
    ("Mochila Notebook Impermeável 15.6", "Bolsas Top", 119.90),
    ("Carregador Turbo 20W USB-C", "Cabo Certo", 34.90),
    ("Garrafa Térmica Inox 500ml", "Vida Fit", 49.90),
    ("Tapete de Banheiro Antiderrapante", "Lar Doce Lar", 29.90),
    ("Caixa de Som Bluetooth Portátil", "SomBom", 129.90),
    ("Organizador de Maquiagem Acrílico", "Beleza Pura", 44.90),
    ("Escova Secadora 3 em 1", "Beleza Pura", 159.90),
    ("Câmera de Segurança WiFi 360", "Segurança Já", 99.90),
    ("Teclado Mecânico Gamer RGB", "GamerPoint", 189.90),
    ("Mouse Sem Fio Silencioso", "GamerPoint", 39.90),
    ("Panela de Pressão Elétrica 6L", "Casa & Cozinha", 299.00),
    ("Conjunto 3 Frigideiras Antiaderente", "Casa & Cozinha", 119.90),
    ("Kit 6 Potes Herméticos Vidro", "Lar Doce Lar", 79.90),
    ("Suporte Celular Veicular Magnético", "Cabo Certo", 24.90),
    ("Película 3D iPhone Kit 3un", "Cabo Certo", 19.90),
    ("Vestido Midi Canelado Feminino", "Moda Leve", 69.90),
    ("Tênis Esportivo Masculino Leve", "Pisada Certa", 109.90),
    ("Legging Fitness Cintura Alta", "Vida Fit", 49.90),
    ("Máquina de Cortar Cabelo Profissional", "Barber Shop", 79.90),
    ("Aspirador de Pó Vertical 2 em 1", "Lar Doce Lar", 189.90),
    ("Ventilador de Mesa Turbo 40cm", "Casa & Cozinha", 139.90),
    ("Umidificador de Ar Ultrassônico", "Vida Fit", 69.90),
    ("Kit 50 Hidratantes Labiais", "Beleza Pura", 59.90),
    ("Secador de Cabelo 2000W Profissional", "Beleza Pura", 129.90),
    ("Jogo de Lençol Casal 4 Peças", "Lar Doce Lar", 89.90),
    ("Cadeira Gamer Reclinável", "GamerPoint", 699.00),
    ("Monitor 24 Full HD 75Hz", "TechStore BR", 649.00),
    ("Hub USB-C 7 em 1", "TechStore BR", 89.90),
    ("Mini Projetor Portátil HD", "TechStore BR", 259.00),
    ("Balança Digital Bioimpedância", "Vida Fit", 59.90),
    ("Chaleira Elétrica Inox 1.8L", "Casa & Cozinha", 79.90),
    ("Kit Ferramentas 129 Peças", "Oficina Pro", 99.90),
    ("Parafusadeira Furadeira 21V 2 Baterias", "Oficina Pro", 169.90),
    ("Ring Light 26cm com Tripé", "Beleza Pura", 69.90),
    ("Microfone Lapela Sem Fio", "SomBom", 79.90),
];

fn hash(x: u64) -> u64 {
    // splitmix64
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn unit(seed: u64) -> f64 {
    (hash(seed) % 10_000) as f64 / 10_000.0
}

/// Preço atual do item `idx` no instante `tick`.
/// Alguns itens recebem quedas fortes periodicamente para simular "achadinhos".
fn price_at(idx: usize, base: f64, tick: u64) -> (f64, f64) {
    let drift = 1.0 + (unit(idx as u64 * 31 + tick / 3) - 0.5) * 0.08; // ±4%
    let mut price = base * drift;
    // a cada ciclo de ~7 ticks, 1/4 dos itens entra em promoção agressiva
    let promo_slot = hash(idx as u64 + tick / 7) % 4 == 0;
    let discount = if promo_slot {
        25.0 + unit(idx as u64 * 7 + tick / 7) * 45.0 // 25..70%
    } else if unit(idx as u64 * 13 + tick) > 0.75 {
        5.0 + unit(idx as u64 * 17 + tick) * 12.0 // 5..17%
    } else {
        0.0
    };
    price *= 1.0 - discount / 100.0;
    ((price * 100.0).round() / 100.0, discount.round())
}

pub fn product_offers(q: &ProductQuery, tick: u64) -> ProductPage {
    let kw = q.keyword.as_deref().map(|k| k.trim().to_lowercase()).unwrap_or_default();
    let terms: Vec<&str> = kw.split_whitespace().collect();

    // "Vendedores novos" com preço fora da curva: a cada ciclo alguns itens do catálogo ganham um clone
    // de loja recém-criada a 3–15% do preço normal, sem vendas e sem avaliação (o "bug" que queremos achar).
    let anomalies = CATALOG.iter().enumerate().filter_map(|(idx, (name, _, base))| {
        let cycle = tick / 5;
        if hash(idx as u64 * 97 + cycle) % 7 != 0 {
            return None;
        }
        let ratio = 0.03 + unit(idx as u64 * 101 + cycle) * 0.12;
        let price = ((base * ratio) * 100.0).round() / 100.0;
        let item_id = 200_000_000 + idx as i64;
        let shop_id = 9000 + (hash(idx as u64 + cycle) % 50) as i64;
        Some(ProductOffer {
            item_id,
            shop_id,
            product_name: format!("{name} PROMOÇÃO"),
            product_link: format!("https://shopee.com.br/product/{shop_id}/{item_id}"),
            offer_link: format!("https://s.shopee.com.br/mock{item_id}"),
            image_url: format!("https://picsum.photos/seed/{item_id}/300/300"),
            price_min: price.max(0.5),
            price_max: price.max(0.5),
            price_discount_rate: 0.0,
            sales: (hash(idx as u64 * 7 + cycle) % 6) as i64,
            rating_star: 0.0,
            commission_rate: 0.03,
            commission: price * 0.03,
            shop_name: format!("Loja Nova {}", shop_id - 9000),
            period_start_time: 0,
            period_end_time: 0,
        })
    });

    let mut items: Vec<ProductOffer> = CATALOG
        .iter()
        .enumerate()
        .filter(|(_, (name, shop, _))| {
            if terms.is_empty() {
                return true;
            }
            let hay = format!("{} {}", name.to_lowercase(), shop.to_lowercase());
            terms.iter().all(|t| hay.contains(t))
        })
        .filter(|(idx, _)| q.item_id.map_or(true, |id| id == 100_000_000 + *idx as i64))
        .filter(|(idx, _)| q.shop_id.map_or(true, |id| id == 5000 + (*idx as i64 % 12)))
        .map(|(idx, (name, shop, base))| {
            let (price, discount) = price_at(idx, *base, tick);
            let original = if discount > 0.0 { price / (1.0 - discount / 100.0) } else { price };
            let sales = 120 + (hash(idx as u64 * 3) % 9000) as i64;
            let commission_rate = 0.03 + unit(idx as u64 * 5) * 0.15;
            let item_id = 100_000_000 + idx as i64;
            let shop_id = 5000 + (idx as i64 % 12);
            ProductOffer {
                item_id,
                shop_id,
                product_name: name.to_string(),
                product_link: format!("https://shopee.com.br/product/{shop_id}/{item_id}"),
                offer_link: format!("https://s.shopee.com.br/mock{item_id}"),
                image_url: format!("https://picsum.photos/seed/{item_id}/300/300"),
                price_min: price,
                price_max: (original * 100.0).round() / 100.0,
                price_discount_rate: discount,
                sales,
                rating_star: 4.0 + unit(idx as u64 * 11) * 0.9,
                commission_rate,
                commission: price * commission_rate,
                shop_name: shop.to_string(),
                period_start_time: 0,
                period_end_time: 0,
            }
        })
        .collect();

    // Anomalias passam pelos mesmos filtros de palavra-chave/loja/item.
    items.extend(anomalies.filter(|p| {
        let hay = format!("{} {}", p.product_name.to_lowercase(), p.shop_name.to_lowercase());
        (terms.is_empty() || terms.iter().all(|t| hay.contains(t)))
            && q.item_id.map_or(true, |id| id == p.item_id)
            && q.shop_id.map_or(true, |id| id == p.shop_id)
    }));

    match q.sort_type {
        Some(2) => items.sort_by(|a, b| b.sales.cmp(&a.sales)),
        Some(3) => items.sort_by(|a, b| b.price_min.total_cmp(&a.price_min)),
        Some(4) => items.sort_by(|a, b| a.price_min.total_cmp(&b.price_min)),
        Some(5) => items.sort_by(|a, b| b.commission_rate.total_cmp(&a.commission_rate)),
        _ => {}
    }

    let limit = q.limit.clamp(1, 500) as usize;
    let page = q.page.max(1) as usize;
    let start = (page - 1) * limit;
    let total = items.len();
    let nodes: Vec<ProductOffer> = items.into_iter().skip(start).take(limit).collect();
    ProductPage {
        nodes,
        page_info: PageInfo {
            page: page as i64,
            limit: limit as i64,
            has_next_page: start + limit < total,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyword_filters_and_pages() {
        let q = ProductQuery { keyword: Some("cozinha".into()), limit: 3, ..Default::default() };
        let p = product_offers(&q, 1);
        assert_eq!(p.nodes.len(), 3);
        assert!(p.page_info.has_next_page);
        assert!(p.nodes.iter().all(|n| n.shop_name.to_lowercase().contains("cozinha")));
    }

    #[test]
    fn prices_change_over_ticks() {
        let q = ProductQuery::default();
        let a = product_offers(&q, 1);
        let b = product_offers(&q, 40);
        assert!(a.nodes.iter().zip(b.nodes.iter()).any(|(x, y)| x.price_min != y.price_min));
    }
}
