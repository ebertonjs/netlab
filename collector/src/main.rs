//! netnoc-collector — coletor do NetNOC em Rust.
//! Assume o ping (ICMP/TCP/HTTP), o MikroTik e o AdGuard Home, gravando no mesmo SQLite do painel.
//! O resto (API, incidentes, rollups, DHCP, speedtest, DNS, sistema) continua no Python.
use netnoc_collector::{agh, config, db, health, mikrotik, ping, settings};

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::watch;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "netnoc-collector [-c ARQUIVO.toml] [--check] [--version]

  -c, --config ARQ   arquivo de configuração (padrão: $NETNOC_COLLECTOR_CONFIG ou /etc/netnoc-collector.toml)
  --check            abre o banco, lê alvos e integrações, mostra o resumo e sai
  --version          mostra a versão

Variáveis (têm prioridade sobre o arquivo): NETNOC_DB, NETNOC_HIST_DB, NETNOC_KEY_FILE, NETNOC_SECRET_KEY,
NETNOC_COLLECTOR_LOG (ex.: info, debug), NETNOC_COLLECTOR_MODULES (ex.: ping,mikrotik,agh)";

struct Args {
    config: Option<PathBuf>,
    check: bool,
}

fn args() -> Args {
    let mut a = Args { config: None, check: false };
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "-c" | "--config" => a.config = it.next().map(PathBuf::from),
            "--check" => a.check = true,
            "-V" | "--version" => {
                println!("netnoc-collector {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => {
                eprintln!("argumento desconhecido: {other}\n\n{USAGE}");
                std::process::exit(2);
            }
        }
    }
    a
}

fn main() {
    let a = args();
    let cfg = match config::Config::load(a.config.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuração: {e:#}");
            std::process::exit(2);
        }
    };
    // log_level já foi validado em Config::load
    let filter = EnvFilter::try_new(&cfg.log_level).unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(std::io::stderr().is_terminal())
        .with_writer(std::io::stderr)
        // no journald a data já vem do systemd
        .with_target(false)
        .init();

    // 2 threads bastam: tudo é I/O; o SQLite tem a thread dele
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
    if let Err(e) = rt.block_on(run(cfg, a.check)) {
        error!("{e:#}");
        std::process::exit(1);
    }
}

async fn wait_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT");
    tokio::select! {
        _ = term.recv() => info!("SIGTERM recebido, encerrando"),
        _ = int.recv() => info!("SIGINT recebido, encerrando"),
    }
}

async fn run(cfg: config::Config, check: bool) -> Result<()> {
    let hist = cfg.hist_path();
    info!("netnoc-collector {} — banco {} + {}", env!("CARGO_PKG_VERSION"), cfg.db.display(), hist.display());
    for w in cfg.warnings() {
        warn!("configuração: {w}");
    }
    let secrets = Arc::new(settings::Secrets::load(&cfg.key_path()));

    // abre e espera o schema (o NetNOC em Python cria as tabelas na primeira execução)
    let (stop_tx, stop_rx) = watch::channel(false);
    let sig = tokio::spawn(async move {
        wait_signal().await;
        let _ = stop_tx.send(true);
    });
    let conn = loop {
        let (db, h) = (cfg.db.clone(), hist.clone());
        let res = tokio::task::spawn_blocking(move || -> Result<_> {
            let c = db::open(db, h)?;
            let missing = db::missing_tables(&c)?;
            Ok((c, missing))
        })
        .await?;
        match res {
            Ok((c, missing)) if missing.is_empty() => break c,
            Ok((_, missing)) => warn!("tabelas ainda não criadas pelo NetNOC: {} — tentando de novo em 5 s", missing.join(", ")),
            Err(e) if check => return Err(e),
            Err(e) => warn!("{e:#} — tentando de novo em 5 s"),
        }
        if check {
            anyhow::bail!("schema incompleto");
        }
        let mut s = stop_rx.clone();
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = s.changed() => return Ok(()),
        }
    };
    let db = db::spawn(conn);

    let first = settings::parse(&db.settings().await?, &secrets);
    if check {
        println!("configuração ..... ok (backoff até {} s; DNS em cache por {} s)", cfg.retry.max_backoff_secs, cfg.ping.dns_cache_secs);
        println!("banco ............ ok ({} / {})", cfg.db.display(), hist.display());
        println!("chave ............ {}", if secrets.has_key() { "ok" } else { "não encontrada (senhas cifradas ficarão vazias)" });
        println!("destinos ......... {} (intervalo padrão {} s)", first.targets.len(), first.ping_interval_s);
        for t in &first.targets {
            println!("  - {:<24} {:<5} {}", t.name, t.kind, t.host);
        }
        let st = |i: &settings::Integration, user: bool| {
            if i.ready(user) {
                format!("ativo, {} a cada {} s{}", i.base(), i.interval_s, if i.password.is_empty() && user { " (SEM senha!)" } else { "" })
            } else {
                "desativado".into()
            }
        };
        println!("mikrotik ......... {}", st(&first.mikrotik, true));
        println!("adguard .......... {}", st(&first.agh, false));
        println!("módulos .......... {}", cfg.enabled_modules().join(", "));
        db.stop().await;
        return Ok(());
    }

    // relê alvos/intervalos/integrações periodicamente (o que a UI muda vale em segundos)
    let (set_tx, set_rx) = watch::channel(Arc::new(first));
    {
        let (db, secrets, mut stop, every) = (db.clone(), secrets.clone(), stop_rx.clone(), cfg.settings_reload_secs);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(every)) => {}
                    _ = stop.changed() => return,
                }
                match db.settings().await {
                    Ok(raw) => {
                        let new = settings::parse(&raw, &secrets);
                        set_tx.send_if_modified(|cur| {
                            let changed = format!("{:?}", cur) != format!("{:?}", new);
                            if changed {
                                *cur = Arc::new(new);
                            }
                            changed
                        });
                    }
                    Err(e) => warn!("lendo configurações: {e:#}"),
                }
            }
        });
    }

    let reg = health::Registry::default();
    let mut tasks = Vec::new();
    if cfg.modules.ping {
        tasks.push(tokio::spawn(ping::run(db.clone(), set_rx.clone(), reg.clone(), cfg.ping.clone(), cfg.retry.clone(), stop_rx.clone())));
    }
    if cfg.modules.mikrotik {
        tasks.push(tokio::spawn(mikrotik::run(
            db.clone(),
            set_rx.clone(),
            reg.clone(),
            cfg.retry.max_backoff_secs as f64,
            stop_rx.clone(),
        )));
    }
    if cfg.modules.agh {
        tasks.push(tokio::spawn(agh::run(db.clone(), set_rx.clone(), reg.clone(), cfg.retry.max_backoff_secs as f64, stop_rx.clone())));
    }
    if tasks.is_empty() {
        warn!("nenhum módulo ativo (modules.ping/mikrotik/agh)");
    }
    tasks.push(tokio::spawn(health::heartbeat(db.clone(), reg.clone(), cfg.enabled_modules(), stop_rx.clone())));
    info!("módulos ativos: {}", cfg.enabled_modules().join(", "));

    let _ = sig.await;
    // cada módulo grava o que tem e sai; depois a thread do banco faz o último commit
    for t in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(10), t).await;
    }
    db.write(vec![db::Rec::Meta {
        key: "collector:heartbeat".into(),
        value: serde_json::json!({"ts": health::now(), "stopped": true, "pid": std::process::id()}).to_string(),
        ts: 0.0, // ts antigo = Python assume na hora (sem esperar 60 s)
    }]);
    db.stop().await;
    info!("encerrado");
    Ok(())
}
