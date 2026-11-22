//! HTTPS com certificado fixado (igual ao netnoc/nucleo/tlspin.py): aceita só o certificado cuja
//! impressão digital SHA-256 foi salva no painel. A cadeia e o nome não importam (o MikroTik usa
//! certificado autoassinado); a assinatura do handshake continua sendo conferida normalmente.
use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};
use sha2::{Digest, Sha256};

/// "AB:CD:…" ou "abcd…" -> 64 dígitos hex minúsculos; None se vazio ou inválido.
pub fn norm(fp: &str) -> Option<String> {
    let s: String = fp.chars().filter(|c| !c.is_whitespace() && *c != ':').collect::<String>().to_lowercase();
    (s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())).then_some(s)
}

pub fn sha256_hex(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug)]
struct Pin {
    fp: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if sha256_hex(end_entity.as_ref()) == self.fp {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::General("certificado mudou (impressão digital diferente da salva)".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(m, c, d, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(m, c, d, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Cliente reqwest que só fala com o aparelho dono deste certificado.
pub fn client(fp: &str, timeout: Duration) -> Result<reqwest::Client, String> {
    let fp = norm(fp).ok_or("impressão digital inválida")?;
    let provider = Arc::new(ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin { fp, provider }))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(cfg)
        .timeout(timeout)
        .connect_timeout(timeout)
        .pool_max_idle_per_host(1)
        .build()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza() {
        let h = "AB:".repeat(31) + "AB";
        assert_eq!(norm(&h).unwrap(), "ab".repeat(32));
        assert!(norm("abc").is_none());
        assert!(norm(&"zz".repeat(32)).is_none());
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
