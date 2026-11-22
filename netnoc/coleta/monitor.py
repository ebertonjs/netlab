"""Coleta do NetNOC — fachada.

Até a v4.3 tudo isto era um arquivo de 1.500 linhas. Agora cada assunto tem o seu módulo:

    base        constantes do config.json, estado em memória, ganchos
    ajustes     nome do painel, intervalos, migração de segredos
    telegram    alertas pelo Telegram
    alvos       destinos e servidores DNS
    incidentes  incidentes e eventos
    ping        ping/TCP/HTTP, janela de avaliação, leitura do coletor Rust
    mikrotik    API REST do MikroTik, DHCP, topologia, pico da WAN
    adguard     AdGuard Home
    sistema     DNS, IP público, servidor, certificados, limpeza, estatísticas
    laco        laço supervisionado dos coletores e a saúde deles

O resto do projeto continua usando `monitor.qualquer_coisa`: este arquivo reexporta tudo e só guarda
`start_all`. Para código novo, importe do módulo do assunto.
"""
import threading

from netnoc.coleta import (adguard, ajustes, alvos, base, incidentes, laco, mikrotik,  # noqa: F401
                           ping, sistema, telegram)
from netnoc.nucleo import db, stats

# reexporta os nomes de cada módulo (inclusive os internos usados por outras partes, ex.: _health,
# _active_incidents). São os MESMOS objetos: mudar um dicionário por aqui muda no módulo de origem.
for _m in (base, ajustes, telegram, alvos, incidentes, ping, mikrotik, adguard, sistema, laco):
    for _k, _v in vars(_m).items():
        if not _k.startswith("__") and not isinstance(_v, type(threading)):
            globals().setdefault(_k, _v)
del _m, _k, _v

_started = False


def start_all():
    global _started
    if _started:
        return
    _started = True
    db.init_db()
    ajustes.init_settings()
    incidentes.reconcile_incidents()
    ping.warm_state()
    incidentes.log_event(f"{ajustes.get_app_name()} iniciado", "Info")
    if ping.EXTERNAL:
        print(f"[coletor] módulos entregues ao netnoc-collector: {', '.join(sorted(ping.EXTERNAL))}", flush=True)
    iv = lambda k: (lambda: ajustes.get_intervals()[k])
    loops = (
        ("ping", ping.ping_tick, lambda: 1, 0),
        ("dns", sistema.dns_once, iv("dns_check_interval_seconds"), 2),
        ("ip_publico", sistema.public_ip_once, iv("public_ip_interval_seconds"), 1),
        ("sistema", sistema.system_once, iv("system_interval_seconds"), 0),
        ("rollup", stats.run_rollups, lambda: 60, 5),
        ("limpeza", sistema.prune_once, lambda: 3600, 120),
        ("mikrotik", ping.mikrotik_tick, lambda: mikrotik._setting_interval("mikrotik", 60), 3),
        ("adguard", ping.agh_tick, lambda: mikrotik._setting_interval("agh", 60), 4),
        ("certificados", sistema.cert_once, lambda: 6 * 3600, 30),
    )
    for name, once, get_iv, delay in loops:
        threading.Thread(target=laco._loop, args=(name, once, get_iv, delay), daemon=True, name=name).start()
