"""MikroTik pela API REST: recurso, interfaces, DHCP, topologia e o pico da WAN.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import time, json, re


import requests

from netnoc.nucleo import db
from netnoc.nucleo import security
from netnoc.nucleo import stats
from netnoc.nucleo import tlspin
from netnoc.coleta.base import IFACE_RAW_DAYS, NEW_DEVICE_HOOKS

# ------------------------------------------------------------------ mikrotik
_MT_SECRET = ("password",)
_MIKROTIK_DEFAULTS = {
    "enabled": False, "host": "", "port": 443, "use_https": True,
    "verify_ssl": False, "username": "", "password": "", "sync_interval_seconds": 60,
    "wan_iface": "",          # v4.0: porta da internet (vazio = descobrir sozinho)
    "cert_sha256": "",        # v4.2: certificado fixado (HTTPS com certificado próprio do RouterOS)
    "plan_mbps": 0,           # v4.3: velocidade contratada (download), para comparar no "Medir agora"
}


def get_mikrotik():
    return security.load_secret_cfg("mikrotik", _MIKROTIK_DEFAULTS, _MT_SECRET)


def set_mikrotik(payload):
    cfg = dict(_MIKROTIK_DEFAULTS)
    cfg.update(payload)
    security.save_secret_cfg("mikrotik", cfg, _MT_SECRET)
    stats.cache_clear()       # porta da WAN pode ter mudado


def _mikrotik_base_url(cfg):
    scheme = "https" if cfg["use_https"] else "http"
    return f"{scheme}://{cfg['host']}:{cfg['port']}/rest"


def _mikrotik_get(path, cfg=None):
    cfg = cfg or get_mikrotik()
    if not cfg["host"] or not cfg["username"]:
        raise ValueError("MikroTik não configurado")
    r = tlspin.request(cfg, "GET", f"{_mikrotik_base_url(cfg)}/{path}", auth=(cfg["username"], cfg["password"]),
                       timeout=6)
    r.raise_for_status()
    return r.json()


def fetch_dhcp_leases():
    return _mikrotik_get("ip/dhcp-server/lease")


def sync_dhcp_leases():
    now = time.time()
    try:
        leases = fetch_dhcp_leases()
    except Exception:
        return []
    seen, new = [], []
    known = {r["mac"] for r in db.query_w("SELECT mac FROM dhcp_hosts")}
    for lease in leases:
        mac = lease.get("mac-address")
        if not mac:
            continue
        seen.append(mac)
        if known and mac not in known:            # na primeira sincronização tudo é "novo": não avisa
            new.append({"mac": mac, "ip": str(lease.get("address", ""))[:64],
                        "hostname": security.clean_name(lease.get("host-name", ""), 60)})
        ip = str(lease.get("address", ""))[:64]
        hostname = security.clean_name(lease.get("host-name", ""), 60)
        active = 1 if lease.get("status") == "bound" else 0
        db.execute(
            "INSERT INTO dhcp_hosts(mac,ip,hostname,active,first_seen,last_seen,promoted_target) VALUES(?,?,?,?,?,?,NULL) "
            "ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip, hostname=excluded.hostname, active=excluded.active, last_seen=excluded.last_seen",
            (mac, ip, hostname, active, now, now))
    if seen:
        db.execute(f"UPDATE dhcp_hosts SET active=0 WHERE mac NOT IN ({','.join('?' * len(seen))})", tuple(seen))
    if new:
        for d in new:
            log_event(f"Aparelho novo na rede: {d['hostname'] or 'sem nome'} ({d['ip']}, {d['mac']})", "Baixa")
        for fn in NEW_DEVICE_HOOKS:
            try:
                fn(new)
            except Exception:
                pass
    return leases


def get_dhcp_hosts():
    return db.query("SELECT * FROM dhcp_hosts ORDER BY (promoted_target IS NULL) ASC, last_seen DESC")


def promote_dhcp_host(host_id, name=None, parent=None):
    rows = db.query_w("SELECT * FROM dhcp_hosts WHERE id=?", (host_id,))
    if not rows:
        raise ValueError("Dispositivo não encontrado")
    host = rows[0]
    if not host["ip"]:
        raise ValueError("Dispositivo sem IP conhecido, não é possível monitorar")
    name = security.clean_name(name or host["hostname"] or host["ip"])
    add_target(name, host["ip"], parent)
    db.execute("UPDATE dhcp_hosts SET promoted_target=? WHERE id=?", (name, host_id))
    log_event(f"Dispositivo promovido a destino monitorado: {name}", "Info")
    return name


def get_mikrotik_status():
    cfg = get_mikrotik()
    if not cfg["enabled"]:
        return None
    rows = db.query("SELECT * FROM mikrotik_resource ORDER BY ts DESC LIMIT 1")
    if not rows:
        return None
    row = rows[0]
    stale = (time.time() - row["ts"]) > max(cfg["sync_interval_seconds"] * 3, 120)
    return {
        "ts": row["ts"], "stale": stale, "cpu_load": row["cpu_load"], "uptime_s": row["uptime_s"],
        "mem_pct": round(100 * (1 - row["free_memory"] / row["total_memory"]), 1) if row["total_memory"] else None,
        "hdd_pct": round(100 * (1 - row["free_hdd"] / row["total_hdd"]), 1) if row["total_hdd"] else None,
        "temperature": row["temperature"], "board_name": row["board_name"], "version": row["version"],
    }


def get_mikrotik_interfaces():
    # janela proporcional ao intervalo de coleta (antes: 1 h fixa -> tabela vazia com coleta de 6 h)
    win = max(3600, _setting_interval("mikrotik", 60) * 3)
    return db.query("""
        SELECT m.name, m.running, m.disabled, m.rx_bytes, m.tx_bytes, m.rx_bps, m.tx_bps, m.ts
        FROM mikrotik_iface m JOIN (SELECT name, MAX(ts) mts FROM mikrotik_iface INDEXED BY idx_mikrotik_iface_time
             WHERE ts >= ? GROUP BY name) x ON x.name=m.name AND x.mts=m.ts
        ORDER BY m.name ASC""", (time.time() - win,))


def get_mikrotik_resource_history(seconds):
    return db.query("SELECT ts, cpu_load, temperature FROM mikrotik_resource WHERE ts>=? ORDER BY ts ASC",
                    (time.time() - seconds,))


def _downsample(rows, maxn=600):
    if len(rows) <= maxn:
        return rows
    step = len(rows) / maxn
    return [rows[int(i * step)] for i in range(maxn)]


def get_mikrotik_iface_history(iface, seconds):
    since = time.time() - seconds
    if seconds <= IFACE_RAW_DAYS * 86400:
        return _downsample(db.query("SELECT ts, rx_bps, tx_bps FROM mikrotik_iface WHERE name=? AND ts>=? ORDER BY ts ASC",
                                    (iface, since)))
    # períodos longos: médias de 5 min (+ o pico de cada bloco, para o gráfico não esconder o máximo)
    return _downsample(db.query("SELECT bucket ts, rx_avg rx_bps, tx_avg tx_bps, rx_max, tx_max FROM mikrotik_iface_5m "
                                "WHERE name=? AND bucket>=? ORDER BY bucket ASC", (iface, since)))


_mt_prev = {}
_mt_comment = {}           # nome da interface -> comentário (descrição dada no RouterOS)
_mt_stored = {}            # nome -> (running, disabled, ts) da última linha gravada


def _poll_mikrotik_once(cfg):
    now = time.time()
    res = _mikrotik_get("system/resource", cfg)
    if isinstance(res, list):
        res = res[0] if res else {}
    temp = None
    try:
        health = _mikrotik_get("system/health", cfg)
        for item in health if isinstance(health, list) else [health]:
            if item.get("name") in ("temperature", "cpu-temperature"):
                temp = float(item.get("value"))
    except Exception:
        pass
    db.execute(
        "INSERT INTO mikrotik_resource(ts,cpu_load,uptime_s,free_memory,total_memory,free_hdd,total_hdd,temperature,board_name,version) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (now, float(res.get("cpu-load", 0) or 0), _mikrotik_parse_uptime(res.get("uptime", "")),
         int(res.get("free-memory", 0) or 0), int(res.get("total-memory", 0) or 0),
         int(res.get("free-hdd-space", 0) or 0), int(res.get("total-hdd-space", 0) or 0),
         temp, res.get("board-name"), res.get("version")))
    rows = []
    for iface in _mikrotik_get("interface", cfg):
        name = iface.get("name")
        if not name:
            continue
        rx, tx = int(iface.get("rx-byte", 0) or 0), int(iface.get("tx-byte", 0) or 0)
        running = 1 if iface.get("running") in (True, "true") else 0
        disabled = 1 if iface.get("disabled") in (True, "true") else 0
        prev = _mt_prev.get(name)
        rx_bps = tx_bps = 0.0
        if prev and now > prev[2]:
            dt = now - prev[2]
            rx_bps = max(0, (rx - prev[0]) * 8 / dt)
            tx_bps = max(0, (tx - prev[1]) * 8 / dt)
        _mt_prev[name] = (rx, tx, now)
        _mt_comment[name] = security.clean_name(iface.get("comment", "") or "", 40)
        # v4.0: porta em uso entra a cada coleta; desligada/sem cabo só quando muda de estado ou a cada 10 min
        # (o painel continua vendo a porta caída na hora, sem encher o histórico com zeros)
        last = _mt_stored.get(name)
        if running and not disabled or not last or last[:2] != (running, disabled) or now - last[2] >= 600:
            _mt_stored[name] = (running, disabled, now)
            rows.append((now, name, running, disabled, rx, tx, rx_bps, tx_bps))
    db.executemany("INSERT INTO mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?,?,?,?,?,?,?,?)", rows)
    sync_dhcp_leases()


def _mikrotik_parse_uptime(text):
    if not text:
        return None
    return sum(int(v) * {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1}[u]
               for v, u in re.findall(r"(\d+)([wdhms])", text))


def _safe_err(e):
    """Mensagem de erro sem URL/credenciais (str() de exceções do requests inclui a URL)."""
    if isinstance(e, requests.HTTPError) and e.response is not None:
        return f"HTTP {e.response.status_code}"
    if isinstance(e, requests.exceptions.SSLError):
        return "certificado mudou (impressão digital diferente da salva)" if "mudou" in str(e) else "SSLError (certificado)"
    if isinstance(e, requests.RequestException):
        return type(e).__name__
    return str(e)[:120]


def _setting_interval(key, default, minimum=15):
    """Lê só o intervalo do JSON (sem decifrar segredos) — usado a cada segundo pelo laço."""
    try:
        v = int(json.loads(db.get_setting(key, "{}") or "{}").get("sync_interval_seconds", default))
    except Exception:
        v = default
    return max(minimum, v)


def mikrotik_once():
    cfg = get_mikrotik()
    if cfg["enabled"] and cfg["host"]:
        try:
            _poll_mikrotik_once(cfg)
        except Exception as e:
            log_event(f"Falha ao coletar dados do MikroTik: {_safe_err(e)}", "Baixa")
            raise


# ---------------------------------------------------------------------- topology
def build_topology():
    targets = get_targets()
    nodes = [{"id": "internet", "label": "Internet", "type": "internet"}]
    edges = []
    names = {t["name"] for t in targets}
    snap = window_snapshot()
    for t in targets:
        s = snap.get(t["name"])
        nodes.append({"id": t["name"], "label": t["name"], "host": t["host"], "type": "target",
                      "online": s["online"] if s else None})
        parent = t.get("parent")
        edge = {"source": parent if parent and parent in names else "internet", "target": t["name"]}
        if s:
            edge.update({"latency": s["latency"], "loss_pct": s["loss_pct"]})
        edges.append(edge)
    return {"nodes": nodes, "edges": edges}


# -------------------------------------------------------------------- pico da WAN (v4.0, no lugar do speedtest)
# O Pi 3 tem placa de 100 Mbps (o 3 B+, ~300): um speedtest feito nele mede o Pi, não a internet. O MikroTik
# já conta o tráfego da porta WAN, então o maior download/upload visto ali é a medida real do link.
WAN_RE = re.compile(r"pp?poe|wan|internet|operadora|isp|onu|modem|lte|starlink", re.I)   # "PPOE OPERADORA" também


@stats.ttl_cache(600)
def wan_iface():
    """Porta da WAN: a que o usuário escolheu, senão uma com nome/comentário de WAN (PPPoE primeiro), senão a
    com mais download nas últimas 24 h."""
    chosen = (get_mikrotik() or {}).get("wan_iface")
    if chosen:
        return chosen
    rows = db.query("SELECT name, MAX(rx_bps) mx FROM mikrotik_iface INDEXED BY idx_mikrotik_iface_time "
                    "WHERE ts >= ? GROUP BY name", (time.time() - 86400,))
    if not rows:
        return None
    named = [r for r in rows if WAN_RE.search(f"{r['name']} {_mt_comment.get(r['name'], '')}")]
    named.sort(key=lambda r: (not r["name"].lower().startswith("pppoe"), -(r["mx"] or 0)))
    if named:
        return named[0]["name"]
    return max(rows, key=lambda r: r["mx"] or 0)["name"]


@stats.ttl_cache(300)
def wan_peak(seconds=86400):
    """Maior download e upload da WAN no período, com o horário de cada um (bits/s)."""
    name = wan_iface()
    if not name:
        return None
    since = time.time() - seconds
    rx = db.query("SELECT rx_bps v, ts FROM mikrotik_iface WHERE name=? AND ts>=? ORDER BY rx_bps DESC LIMIT 1", (name, since))
    tx = db.query("SELECT tx_bps v, ts FROM mikrotik_iface WHERE name=? AND ts>=? ORDER BY tx_bps DESC LIMIT 1", (name, since))
    rx = [dict(r) for r in rx if r["v"] is not None]
    tx = [dict(r) for r in tx if r["v"] is not None]
    if seconds > IFACE_RAW_DAYS * 86400:
        # o bruto só cobre os últimos dias: o resto vem dos máximos de 5 min
        rx += [dict(r) for r in db.query("SELECT rx_max v, bucket ts FROM mikrotik_iface_5m WHERE name=? AND bucket>=? "
                                         "ORDER BY rx_max DESC LIMIT 1", (name, since)) if r["v"] is not None]
        tx += [dict(r) for r in db.query("SELECT tx_max v, bucket ts FROM mikrotik_iface_5m WHERE name=? AND bucket>=? "
                                         "ORDER BY tx_max DESC LIMIT 1", (name, since)) if r["v"] is not None]
    if not rx:
        return None
    rx, tx = max(rx, key=lambda r: r["v"]), (max(tx, key=lambda r: r["v"]) if tx else None)
    return {"iface": name, "rx_bps": rx["v"], "rx_ts": rx["ts"],
            "tx_bps": tx["v"] if tx else None, "tx_ts": tx["ts"] if tx else None, "seconds": seconds}


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.alvos import add_target, get_targets  # noqa: E402
from netnoc.coleta.incidentes import log_event  # noqa: E402
from netnoc.coleta.ping import window_snapshot  # noqa: E402
