//! Backoff exponencial com teto e variação aleatória (jitter).
//!
//! Usado nas integrações consultadas por API (MikroTik, AdGuard) e na resolução de DNS do ping:
//! quando o outro lado cai, as tentativas se espaçam (intervalo × 2ⁿ, até `max`) em vez de martelar
//! um roteador/OLT/enlace que já está com problema; no primeiro sucesso volta ao intervalo normal.
//! O jitter (±10%) evita que vários coletores reconectem todos no mesmo segundo.
use rand::Rng;

#[derive(Debug, Clone)]
pub struct Backoff {
    fails: u32,
    max_s: f64,
    jitter: f64,
}

impl Backoff {
    /// `max_s`: teto do intervalo entre tentativas, em segundos.
    pub fn new(max_s: f64) -> Self {
        Self { fails: 0, max_s: max_s.max(1.0), jitter: 0.1 }
    }

    pub fn without_jitter(mut self) -> Self {
        self.jitter = 0.0;
        self
    }

    /// Falhas seguidas até agora.
    pub fn fails(&self) -> u32 {
        self.fails
    }

    /// Registra uma falha e devolve quantas seguidas já são (1 = a primeira).
    pub fn fail(&mut self) -> u32 {
        self.fails = self.fails.saturating_add(1);
        self.fails
    }

    /// Registra um sucesso. Devolve quantas falhas seguidas havia (Some só quando estava falhando).
    pub fn ok(&mut self) -> Option<u32> {
        let f = std::mem::take(&mut self.fails);
        (f > 0).then_some(f)
    }

    /// Espera até a próxima tentativa, dado o intervalo normal: `interval × 2^falhas`, limitado ao
    /// teto (e nunca abaixo do próprio intervalo), com ±jitter.
    pub fn delay(&self, interval_s: f64) -> f64 {
        self.delay_with(interval_s, rand::thread_rng().gen_range(-1.0..=1.0))
    }

    /// Igual a `delay`, com o sorteio do jitter (-1..=1) informado (para testes).
    pub fn delay_with(&self, interval_s: f64, r: f64) -> f64 {
        let base = interval_s.max(0.1);
        if self.fails == 0 {
            return base;
        }
        let exp = base * 2f64.powi(self.fails.min(30) as i32);
        let capped = exp.min(self.max_s.max(base));
        (capped * (1.0 + self.jitter * r.clamp(-1.0, 1.0))).max(base)
    }

    /// Só vale a pena registrar a falha quando ela muda de patamar (1ª, 2ª, 4ª, 8ª…): evita
    /// inundar o log/eventos com a mesma mensagem enquanto o equipamento está fora.
    pub fn should_report(&self) -> bool {
        self.fails > 0 && self.fails.is_power_of_two()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dobra_ate_o_teto() {
        let mut b = Backoff::new(600.0).without_jitter();
        assert_eq!(b.delay(60.0), 60.0);
        b.fail();
        assert_eq!(b.delay(60.0), 120.0);
        b.fail();
        assert_eq!(b.delay(60.0), 240.0);
        b.fail();
        assert_eq!(b.delay(60.0), 480.0);
        b.fail();
        assert_eq!(b.delay(60.0), 600.0);
        for _ in 0..50 {
            b.fail();
        }
        assert_eq!(b.delay(60.0), 600.0, "não passa do teto nem estoura com muitas falhas");
    }

    #[test]
    fn sucesso_zera() {
        let mut b = Backoff::new(600.0).without_jitter();
        assert_eq!(b.ok(), None);
        b.fail();
        b.fail();
        assert_eq!(b.ok(), Some(2));
        assert_eq!(b.fails(), 0);
        assert_eq!(b.delay(30.0), 30.0);
    }

    #[test]
    fn intervalo_maior_que_o_teto_e_respeitado() {
        let mut b = Backoff::new(60.0).without_jitter();
        b.fail();
        assert_eq!(b.delay(300.0), 300.0, "nunca fica mais frequente que o intervalo configurado");
    }

    #[test]
    fn jitter_dentro_de_10_por_cento() {
        let mut b = Backoff::new(1000.0);
        b.fail();
        assert!((b.delay_with(100.0, 1.0) - 220.0).abs() < 1e-9);
        assert!((b.delay_with(100.0, -1.0) - 180.0).abs() < 1e-9);
        for _ in 0..200 {
            let d = b.delay(100.0);
            assert!((180.0..=220.0).contains(&d), "{d}");
        }
    }

    #[test]
    fn relata_em_patamares() {
        let mut b = Backoff::new(600.0);
        let mut rel = vec![];
        for _ in 0..10 {
            b.fail();
            if b.should_report() {
                rel.push(b.fails());
            }
        }
        assert_eq!(rel, vec![1, 2, 4, 8]);
    }
}
