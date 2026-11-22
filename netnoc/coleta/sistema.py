"""DNS, IP público, recursos do servidor, certificados, limpeza do banco e estatísticas de disponibilidade.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import time, os
from collections import defaultdict


import requests
import psutil

from netnoc.nucleo import db
from netnoc.nucleo import stats
from netnoc.coleta.base import CFG, DNS_SLOW_N, H1_DAYS, HOST_LABEL, IFACE_RAW_DAYS, LOCAL_LABEL, RAW_DAYS, THRESH, _active_incidents

# ------------------------------------------------------------------------- dns
_dns_fails = {}


def dns_once():
    import dns.resolver
    rows = []
    for s in get_dns_servers():
        resolver = dns.resolver.Resolver(configure=False)
        resolver.nameservers = [s["ip"]]
        resolver.timeout = resolver.lifetime = 1.5
        start = time.time()
        success = True
        try:
            resolver.resolve(CFG["dns_query_name"], "A")
        except Exception:
            success = False
        latency = (time.time() - start) * 1000
        rows.append((s["name"], time.time(), latency, int(success)))
        _dns_fails[s["name"]] = 0 if success else _dns_fails.get(s["name"], 0) + 1
        if not success:
            if ("local", LOCAL_LABEL) in _active_incidents:
                continue        # queda local já alertada: não dispara um alerta por servidor DNS
            if _dns_fails[s["name"]] >= 2:
                raise_incident("dns", s["name"], f"DNS {s['name']} não respondeu", "Media")
        else:
            # lento só abre após DNS_SLOW_N medições seguidas (antes: 1 resposta > 150 ms já abria)
            _hyst("dns", s["name"], latency > THRESH["dns_ms"],
                  lambda s=s, latency=latency: raise_incident(
                      "dns", s["name"], f"DNS da {s['name']} lento: {latency:.0f}ms", "Baixa"),
                  n_open=DNS_SLOW_N)
    db.executemany("INSERT INTO dns_checks(server,ts,latency,success) VALUES(?,?,?,?)", rows)


def public_ip_once():
    for key, url in (("public_ip", "https://api.ipify.org?format=json"),
                     ("public_ipv6", "https://api64.ipify.org?format=json")):
        try:
            ip = requests.get(url, timeout=5).json().get("ip")
        except Exception:
            continue
        if not ip:
            continue
        old = db.get_meta(key)
        if old != ip:
            db.set_meta(key + "_since", time.time())
            if old:
                log_event(f"IP público mudou: {old} → {ip}", "Info")
        db.set_meta(key, ip)


def get_cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000, 1)
    except Exception:
        return None


def system_once():
    cpu = psutil.cpu_percent(interval=1)
    mem = psutil.virtual_memory().percent
    temp = get_cpu_temp()
    meta = {"cpu_pct": cpu, "mem_pct": mem}
    try:
        meta["disk_pct"] = psutil.disk_usage(os.path.dirname(os.path.abspath(db.DB_PATH))).percent
    except Exception:
        pass
    try:
        sz = db.sizes()
        meta["db_cfg_mb"] = round(sz["config"] / 1e6, 2)
        meta["db_hist_mb"] = round(sz["history"] / 1e6, 1)
        meta["db_mb"] = round((sz["config"] + sz["history"]) / 1e6, 1)
    except Exception:
        pass
    meta["host_uptime_s"] = int(time.time() - psutil.boot_time())
    if temp is not None:
        meta["temp_c"] = temp
    db.set_meta_many(meta)
    if temp is not None:
        _hyst("temp", HOST_LABEL, temp > THRESH["temp_c"],
              lambda: raise_incident("temp", HOST_LABEL, f"Temperatura alta: {temp}°C", "Media"))
    _hyst("cpu", HOST_LABEL, cpu > THRESH["cpu_pct"],
          lambda: raise_incident("cpu", HOST_LABEL, f"CPU alta: {cpu}%", "Media"), n_open=3)


def cert_once():
    """Verifica a validade dos certificados dos alvos https (a cada 6 h)."""
    from netnoc.coleta import checks
    warn, crit = int(CFG.get("cert_warn_days", 14)), int(CFG.get("cert_crit_days", 3))
    for t in get_targets():
        if t.get("type") != "http" or not t["host"].startswith("https://"):
            continue
        hp = checks.url_host_port(t["host"])
        days = checks.cert_days_left(*hp) if hp else None
        db.set_meta(f"cert_days:{t['name']}", "" if days is None else round(days, 1))
        if days is None:
            continue
        sev = "Alta" if days < crit else "Media"
        _hyst("cert", t["name"], days < warn,
              lambda t=t, days=days, sev=sev: raise_incident(
                  "cert", t["name"], f"Certificado de {t['name']} expira em {days:.0f} dia(s)", sev))


def prune_once():
    stats.run_rollups()          # nunca apagar bruto antes de agregar
    db.prune_old(CFG["history_retention_days"], RAW_DAYS, H1_DAYS)
    _prune_iface_raw()
    db.optimize()
    if not db.get_meta("v4_iface_cleanup"):
        # v4.0: o histórico das portas guarda só as que estão em uso; apaga uma vez as linhas antigas de portas
        # desativadas/sem cabo (em lotes, para não travar o Pi com a tabela grande)
        cut = time.time() - 86400
        while db.execute_count("DELETE FROM mikrotik_iface WHERE rowid IN (SELECT rowid FROM mikrotik_iface "
                               "WHERE (disabled=1 OR running=0) AND ts < ? LIMIT 20000)", (cut,)):
            time.sleep(0.2)
        # pings que os agentes remotos (multi-site, removido) mandavam: "destino@site"
        while db.execute_count("DELETE FROM pings WHERE rowid IN (SELECT rowid FROM pings WHERE target LIKE '%@%' LIMIT 20000)"):
            time.sleep(0.2)
        db.set_meta("v4_iface_cleanup", "1")



def _prune_iface_raw():
    """Apaga o bruto das portas com mais de IFACE_RAW_DAYS, só até onde já foi agregado, em lotes (a 1ª vez,
    num Pi com 30 dias de histórico, são ~1 milhão de linhas: um DELETE único travaria o banco)."""
    done = float(db.get_meta("iface5_end") or 0)
    cut = min(time.time() - IFACE_RAW_DAYS * 86400, done)
    if cut <= 0:
        return
    while db.execute_count("DELETE FROM mikrotik_iface WHERE rowid IN (SELECT rowid FROM mikrotik_iface "
                           "INDEXED BY idx_mikrotik_iface_time WHERE ts < ? LIMIT 20000)", (cut,)):
        time.sleep(0.2)


# ------------------------------------------------------------------------ stats
def get_uptime_pct(target, hours=24):
    return stats.uptime_pct(hours * 3600, [target]).get(target)


def get_hourly_bars(target, hours=24):
    return stats.hourly_bars(hours, [target]).get(target, [])


def detect_patterns(days=30):
    import datetime
    ts_from = time.time() - days * 86400
    rows = db.query(
        "SELECT target, started_ts FROM incidents WHERE started_ts >= ? AND type IN ('offline','loss','latency')",
        (ts_from,))
    if len(rows) < 5:
        return []
    per = defaultdict(lambda: defaultdict(int))
    for r in rows:
        per[r["target"]][datetime.datetime.fromtimestamp(r["started_ts"]).hour] += 1
    insights = []
    for target, hm in per.items():
        total = sum(hm.values())
        if total < 4:
            continue
        avg = total / 24
        for hour, count in sorted(hm.items(), key=lambda x: -x[1]):
            if count >= max(3, avg * 2):
                insights.append({"target": target, "hour": hour, "count": count,
                                 "message": f"{target} costuma ter problemas por volta de {hour:02d}h ({count} incidentes nos últimos {days} dias)"})
    insights.sort(key=lambda x: -x["count"])
    return insights[:8]


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.alvos import get_dns_servers, get_targets  # noqa: E402
from netnoc.coleta.incidentes import _hyst, log_event, raise_incident  # noqa: E402
