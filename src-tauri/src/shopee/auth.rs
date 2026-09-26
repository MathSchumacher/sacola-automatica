use sha2::{Digest, Sha256};

/// Assinatura exigida pela Open API de Afiliados:
/// `SHA256(AppId + Timestamp + Payload + Secret)` em hex minúsculo, sem separadores.
/// `payload` é o corpo JSON exatamente como será enviado; `timestamp` em segundos Unix.
pub fn sign(app_id: &str, timestamp: i64, payload: &str, secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(app_id.as_bytes());
    hasher.update(timestamp.to_string().as_bytes());
    hasher.update(payload.as_bytes());
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

/// Monta o valor completo do header `Authorization`.
pub fn authorization_header(app_id: &str, timestamp: i64, payload: &str, secret: &str) -> String {
    let signature = sign(app_id, timestamp, payload, secret);
    format!("SHA256 Credential={app_id}, Timestamp={timestamp}, Signature={signature}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_reference_vector() {
        // sha256 de "123456" + "1577836800" + "{}" + "secret", calculado externamente (sha256sum).
        let sig = sign("123456", 1_577_836_800, "{}", "secret");
        assert_eq!(sig.len(), 64);
        assert_eq!(sig, "fc6f2a82951ed2ecfa66f4dfa686dfa2d78ab48fd10ba6b73dd61257e0e4e6bc");
    }

    #[test]
    fn header_has_expected_shape() {
        let h = authorization_header("123456", 1_577_836_800, "{}", "s");
        assert!(h.starts_with("SHA256 Credential=123456, Timestamp=1577836800, Signature="));
    }
}
