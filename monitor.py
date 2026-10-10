import subprocess, time, threading, platform, json, re, os
from collections import deque, defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests
import psutil

import db
import security
import stats

CFG = json.load(open("config.json", encoding="utf-8"))
THRESH = CFG["thresholds"]
OFFLINE_N = int(CFG.get("offline_consecutive_failures", 3))
RECOVER_N = int(CFG.get("recovery_consecutive_ok", 2))
LOSS_MIN_FAILS = int(CFG.get("loss_min_failures", 2))
RAW_DAYS = int(CFG.get("raw_retention_days", 7))
H1_DAYS = int(CFG.get("rollup_1h_retention_days", 365))
WINDOW = 20

IS_WINDOWS = platform.system().lower().startswith("win")

_state_lock = threading.RLock()
_win = {}                 # target -> deque[(ts, latency, ok, jitter)]
_last_latency = {}
_consec = {}              # target -> [fails, oks]
_active_incidents = {}    # (type,target) -> {id,severity,started_ts}
_pending = {}             # (type,target) -> consecutive bad/ok counters for hysteresis
_next_due = {}
_started_at = time.time()
_targets_cache = None


# ------------------------------------------------------------------ settings
def init_settings():
    if db.get_setting("targets") is None:
        db.set_setting("targets", json.dumps(CFG["targets"]))
    if db.get_setting("dns_servers") is None:
        db.set_setting("dns_servers", json.dumps(CFG["dns_servers"]))
    if db.get_setting("intervals") is None:
        db.set_setting("intervals", json.dumps({
            "ping_interval_seconds": CFG["ping_interval_seconds"],
            "dns_check_interval_seconds": CFG["dns_check_interval_seconds"],
            "public_ip_interval_seconds": CFG["public_ip_interval_seconds"],
            "system_interval_seconds": CFG["system_interval_seconds"],
        }))
    if db.get_setting("telegram") is None:
        db.set_setting("telegram", json.dumps({
            "enabled": False, "bot_token": "", "chat_id": "", "min_severity": "Alta"}))
    if db.get_setting("app_name") is None:
        db.set_setting("app_name", CFG.get("app_name", "NetNOC"))
    migrate_secrets()


def migrate_secrets():
    """Recifra credenciais antigas que estavam em texto puro."""
    for key, fields in (("telegram", ("bot_token",)), ("mikrotik", ("password",)), ("agh", ("password",))):
        raw = db.get_setting(key)
        if not raw:
            continue
        try:
            cfg = json.loads(raw)
        except Exception:
            continue
        if any(cfg.get(f) and not str(cfg[f]).startswith(security.ENC_PREFIX) for f in fields):
            for f in fields:
                cfg[f] = security.encrypt(cfg.get(f) or "")
            db.set_setting(key, json.dumps(cfg))


def get_app_name():
    return db.get_setting("app_name", "NetNOC")


def set_app_name(name):
    name = (name or "").strip()
    if not name:
        raise ValueError("Nome não pode ser vazio")
    if len(name) > 40:
        raise ValueError("Nome muito longo (máx. 40 caracteres)")
    if not security.valid_name(name, 40):
        raise ValueError("Nome contém caracteres inválidos")
    db.set_setting("app_name", name)


_INTERVAL_DEFAULTS = {
    "ping_interval_seconds": 5, "dns_check_interval_seconds": 30,
    "public_ip_interval_seconds": 300, "system_interval_seconds": 5}


def get_intervals():
    d = dict(_INTERVAL_DEFAULTS)
    d.update(json.loads(db.get_setting("intervals", "{}") or "{}"))
    return d


def set_intervals(data):
    current = get_intervals()
    for k, v in data.items():
        if v is None or k not in _INTERVAL_DEFAULTS:
            continue
        v = int(v)
        if not 1 <= v <= 86400:
            raise ValueError(f"{k}: valor deve estar entre 1 e 86400")
        current[k] = v
    db.set_setting("intervals", json.dumps(current))


# ------------------------------------------------------------------ telegram
_TG_SECRET = ("bot_token",)
_TG_DEFAULTS = {"enabled": False, "bot_token": "", "chat_id": "", "min_severity": "Alta"}
_SEVERITY_ORDER = {"Alta": 3, "Media": 2, "Baixa": 1, "Info": 0}


def get_telegram():
    return security.load_secret_cfg("telegram", _TG_DEFAULTS, _TG_SECRET)


def set_telegram(enabled, bot_token, chat_id, min_severity):
    security.save_secret_cfg("telegram", {
        "enabled": bool(enabled), "bot_token": bot_token or "",
        "chat_id": chat_id or "", "min_severity": min_severity or "Alta"}, _TG_SECRET)


def send_telegram(message):
    cfg = get_telegram()
    if not cfg["enabled"] or not cfg["bot_token"] or not cfg["chat_id"]:
        return False
    try:
        url = f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage"
        r = requests.post(url, data={"chat_id": cfg["chat_id"], "text": message}, timeout=5)
        return r.ok
    except Exception:
        return False


def notify(severity, text, kind="incident", target=None):
    """Ponto único de saída de alertas (o módulo notifier, se presente, assume)."""
    try:
        import notifier
        return notifier.dispatch(severity, text, kind, target)
    except ImportError:
        cfg = get_telegram()
        if cfg["enabled"] and _SEVERITY_ORDER.get(severity, 0) >= _SEVERITY_ORDER.get(cfg["min_severity"], 3):
            threading.Thread(target=send_telegram, args=(text,), daemon=True).start()


# ------------------------------------------------------------------- targets
def _invalidate_targets():
    global _targets_cache
    _targets_cache = None


def get_targets():
    global _targets_cache
    t = _targets_cache
    if t is None:
        t = json.loads(db.get_setting("targets", "[]"))
        _targets_cache = t
    return [dict(x) for x in t]


def get_dns_servers():
    return json.loads(db.get_setting("dns_servers", "[]"))


def _ancestors(name, items):
    by = {t["name"]: t for t in items}
    seen, cur = [], by.get(name, {}).get("parent")
    while cur and cur in by and cur not in seen:
        seen.append(cur)
        cur = by[cur].get("parent")
    return seen


def add_target(name, host, parent=None, extra=None):
    name = (name or "").strip()
    host = (host or "").strip()
    if not security.valid_name(name):
        raise ValueError("Nome inválido (use até 60 caracteres, sem < > \" ' & \\)")
    items = get_targets()
    extra = extra or {}
    ttype = extra.get("type", "icmp")
    if ttype not in ("icmp", "tcp", "http"):
        raise ValueError("Tipo de check inválido")
    if ttype == "http":
        if not security.valid_url(host):
            raise ValueError("URL inválida (http:// ou https://)")
    elif not security.valid_host(host):
        raise ValueError("Host inválido (IP ou nome de host)")
    if ttype == "tcp" and not security.valid_port(extra.get("port")):
        raise ValueError("Porta TCP inválida")
    if extra.get("expect_status") is not None and not 100 <= int(extra["expect_status"]) <= 599:
        raise ValueError("Status HTTP esperado inválido")
    for sname in extra.get("sites") or []:
        if not security.valid_name(sname, 40) or "@" in sname:
            raise ValueError("Nome de site inválido")
    if any(t["name"] == name for t in items):
        raise ValueError("Já existe um destino com esse nome")
    if parent:
        if parent not in {t["name"] for t in items}:
            raise ValueError("Pai inexistente")
    entry = {"name": name, "host": host, "parent": parent or None}
    entry.update(extra)
    items.append(entry)
    db.set_setting("targets", json.dumps(items))
    _invalidate_targets()


def remove_target(name):
    items = get_targets()
    new = [t for t in items if t["name"] != name]
    for t in new:                       # filhos viram raiz
        if t.get("parent") == name:
            t["parent"] = None
    db.set_setting("targets", json.dumps(new))
    _invalidate_targets()
    with _state_lock:
        _win.pop(name, None)
        _last_latency.pop(name, None)
        _consec.pop(name, None)
        _next_due.pop(name, None)
    for (itype, tgt) in [k for k in list(_active_incidents) if k[1] == name]:
        resolve_incident(itype, tgt, "Destino removido")


def add_dns(name, ip):
    if not security.valid_name(name) or not security.valid_host(ip):
        raise ValueError("Nome ou IP inválido")
    items = get_dns_servers()
    if any(s["name"] == name for s in items):
        raise ValueError("Já existe um servidor DNS com esse nome")
    items.append({"name": name, "ip": ip})
    db.set_setting("dns_servers", json.dumps(items))


def remove_dns(name):
    db.set_setting("dns_servers", json.dumps([s for s in get_dns_servers() if s["name"] != name]))
    resolve_incident("dns", name, "Servidor removido")


# ------------------------------------------------------------------ mikrotik
_MT_SECRET = ("password",)
_MIKROTIK_DEFAULTS = {
    "enabled": False, "host": "", "port": 443, "use_https": True,
    "verify_ssl": False, "username": "", "password": "", "sync_interval_seconds": 60,
}


def get_mikrotik():
    return security.load_secret_cfg("mikrotik", _MIKROTIK_DEFAULTS, _MT_SECRET)


def set_mikrotik(payload):
    cfg = dict(_MIKROTIK_DEFAULTS)
    cfg.update(payload)
    security.save_secret_cfg("mikrotik", cfg, _MT_SECRET)


def _mikrotik_base_url(cfg):
    scheme = "https" if cfg["use_https"] else "http"
    return f"{scheme}://{cfg['host']}:{cfg['port']}/rest"


def _mikrotik_get(path, cfg=None):
    cfg = cfg or get_mikrotik()
    if not cfg["host"] or not cfg["username"]:
        raise ValueError("MikroTik não configurado")
    r = requests.get(f"{_mikrotik_base_url(cfg)}/{path}", auth=(cfg["username"], cfg["password"]),
                     verify=cfg["verify_ssl"], timeout=6)
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
    seen = []
    for lease in leases:
        mac = lease.get("mac-address")
        if not mac:
            continue
        seen.append(mac)
        ip = str(lease.get("address", ""))[:64]
        hostname = security.clean_name(lease.get("host-name", ""), 60)
        active = 1 if lease.get("status") == "bound" else 0
        db.execute(
            "INSERT INTO dhcp_hosts(mac,ip,hostname,active,first_seen,last_seen,promoted_target) VALUES(?,?,?,?,?,?,NULL) "
            "ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip, hostname=excluded.hostname, active=excluded.active, last_seen=excluded.last_seen",
            (mac, ip, hostname, active, now, now))
    if seen:
        db.execute(f"UPDATE dhcp_hosts SET active=0 WHERE mac NOT IN ({','.join('?' * len(seen))})", tuple(seen))
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
    return db.query("""
        SELECT m.name, m.running, m.disabled, m.rx_bytes, m.tx_bytes, m.rx_bps, m.tx_bps, m.ts
        FROM mikrotik_iface m JOIN (SELECT name, MAX(ts) mts FROM mikrotik_iface
             WHERE ts >= ? GROUP BY name) x ON x.name=m.name AND x.mts=m.ts
        ORDER BY m.name ASC""", (time.time() - 3600,))


def get_mikrotik_resource_history(seconds):
    return db.query("SELECT ts, cpu_load, temperature FROM mikrotik_resource WHERE ts>=? ORDER BY ts ASC",
                    (time.time() - seconds,))


def _downsample(rows, maxn=600):
    if len(rows) <= maxn:
        return rows
    step = len(rows) / maxn
    return [rows[int(i * step)] for i in range(maxn)]


def get_mikrotik_iface_history(iface, seconds):
    return _downsample(db.query("SELECT ts, rx_bps, tx_bps FROM mikrotik_iface WHERE name=? AND ts>=? ORDER BY ts ASC",
                                (iface, time.time() - seconds)))


_mt_prev = {}


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
        rows.append((now, name, running, disabled, rx, tx, rx_bps, tx_bps))
    db.executemany("INSERT INTO mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?,?,?,?,?,?,?,?)", rows)
    sync_dhcp_leases()


def _mikrotik_parse_uptime(text):
    if not text:
        return None
    return sum(int(v) * {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1}[u]
               for v, u in re.findall(r"(\d+)([wdhms])", text))


def mikrotik_worker():
    while True:
        cfg = get_mikrotik()
        if cfg["enabled"] and cfg["host"]:
            try:
                _poll_mikrotik_once(cfg)
            except Exception as e:
                log_event(f"Falha ao coletar dados do MikroTik: {e}", "Baixa")
        time.sleep(max(get_mikrotik()["sync_interval_seconds"], 15))


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


# --------------------------------------------------------------------------- AGH
_AGH_SECRET = ("password",)
_AGH_DEFAULTS = {"enabled": False, "host": "", "port": 3000, "use_https": False,
                 "username": "", "password": "", "sync_interval_seconds": 60}


def get_agh():
    return security.load_secret_cfg("agh", _AGH_DEFAULTS, _AGH_SECRET)


def set_agh(payload):
    cfg = dict(_AGH_DEFAULTS)
    cfg.update(payload)
    security.save_secret_cfg("agh", cfg, _AGH_SECRET)


def _agh_get(path, cfg=None):
    cfg = cfg or get_agh()
    if not cfg["host"]:
        raise ValueError("AdGuard Home não configurado")
    scheme = "https" if cfg["use_https"] else "http"
    auth = (cfg["username"], cfg["password"]) if cfg["username"] else None
    r = requests.get(f"{scheme}://{cfg['host']}:{cfg['port']}/control/{path}", auth=auth, timeout=6)
    r.raise_for_status()
    return r.json()


def test_agh_connection():
    return _agh_get("status", get_agh())


def _poll_agh_once(cfg):
    s = _agh_get("stats", cfg)
    db.execute(
        "INSERT INTO agh_stats(ts,num_dns_queries,num_blocked_filtering,num_replaced_safebrowsing,"
        "num_replaced_parental,avg_processing_time) VALUES(?,?,?,?,?,?)",
        (time.time(), s.get("num_dns_queries", 0), s.get("num_blocked_filtering", 0),
         s.get("num_replaced_safebrowsing", 0), s.get("num_replaced_parental", 0),
         s.get("avg_processing_time", 0)))


def agh_worker():
    while True:
        cfg = get_agh()
        if cfg["enabled"] and cfg["host"]:
            try:
                _poll_agh_once(cfg)
            except Exception as e:
                log_event(f"Falha ao coletar dados do AdGuard Home: {e}", "Baixa")
        time.sleep(max(get_agh()["sync_interval_seconds"], 15))


def get_agh_status():
    cfg = get_agh()
    if not cfg["enabled"]:
        return None
    try:
        st = _agh_get("status", cfg)
    except Exception:
        return {"enabled": True, "host": cfg["host"], "online": False}
    return {"enabled": True, "host": cfg["host"], "online": True, "version": st.get("version"),
            "protection_enabled": st.get("protection_enabled"), "dns_addresses": st.get("dns_addresses")}


def get_agh_stats_latest():
    rows = db.query("SELECT * FROM agh_stats ORDER BY ts DESC LIMIT 1")
    if not rows:
        return None
    row = rows[0]
    total = row["num_dns_queries"] or 0
    row["blocked_pct"] = round(100 * (row["num_blocked_filtering"] or 0) / total, 2) if total else 0
    return row


def get_agh_stats_history(seconds):
    return _downsample(db.query(
        "SELECT ts, num_dns_queries, num_blocked_filtering FROM agh_stats WHERE ts>=? ORDER BY ts ASC",
        (time.time() - seconds,)))


# --------------------------------------------------------------------- incidents
def _format_duration(seconds):
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def log_event(message, severity="Info"):
    db.execute("INSERT INTO events(ts,message,severity) VALUES(?,?,?)", (time.time(), message, severity))


def reconcile_incidents():
    """Após reinício, recarrega incidentes abertos (antes eles ficavam órfãos e duplicavam)."""
    names = {t["name"] for t in get_targets()} | {s["name"] for s in get_dns_servers()} | {"Raspberry Pi"}
    for r in db.query_w("SELECT * FROM incidents WHERE resolved_ts IS NULL ORDER BY id"):
        key = (r["type"], r["target"])
        if r["target"] not in names or key in _active_incidents:
            db.execute("UPDATE incidents SET resolved_ts=? WHERE id=?", (time.time(), r["id"]))
        else:
            _active_incidents[key] = {"id": r["id"], "severity": r["severity"], "started_ts": r["started_ts"]}


def raise_incident(itype, target, message, severity):
    key = (itype, target)
    with _state_lock:
        if key in _active_incidents:
            return
        started_ts = time.time()
        iid = db.execute(
            "INSERT INTO incidents(type,target,message,severity,started_ts,resolved_ts) VALUES(?,?,?,?,?,NULL)",
            (itype, target, message, severity, started_ts))
        _active_incidents[key] = {"id": iid, "severity": severity, "started_ts": started_ts}
    log_event(message, severity)
    notify(severity, f"🚨 NetNOC [{severity}]\n{message}", "incident", target)


def resolve_incident(itype, target, message="Resolvido"):
    with _state_lock:
        incident = _active_incidents.pop((itype, target), None)
    if incident:
        db.execute("UPDATE incidents SET resolved_ts=? WHERE id=?", (time.time(), incident["id"]))
        log_event(f"{message}: {target}", "Info")
        dur = _format_duration(time.time() - incident["started_ts"])
        notify(incident["severity"], f"✅ NetNOC [{incident['severity']}]\n{target}: {message}\nDuração: {dur}",
               "incident", target)


def _hyst(kind, target, bad, open_fn, n_open=1, n_close=RECOVER_N):
    """Histerese genérica: abre após n_open maus consecutivos, fecha após n_close bons."""
    key = (kind, target)
    with _state_lock:
        c = _pending.setdefault(key, [0, 0])
        if bad:
            c[0] += 1
            c[1] = 0
        else:
            c[1] += 1
            c[0] = 0
        opened = key in _active_incidents
        if bad and not opened and c[0] >= n_open:
            do_open = True
        else:
            do_open = False
        do_close = (not bad) and opened and c[1] >= n_close
    if do_open:
        open_fn()
    if do_close:
        resolve_incident(kind, target)


# ------------------------------------------------------------------------ ping
def ping_host(host, timeout=1):
    """Latência em ms ou None."""
    if not security.valid_host(host):
        return None
    count_flag = "-n" if IS_WINDOWS else "-c"
    timeout_flag = "-w" if IS_WINDOWS else "-W"
    timeout_val = str(int(timeout * 1000)) if IS_WINDOWS else str(timeout)
    try:
        out = subprocess.run(["ping", count_flag, "1", timeout_flag, timeout_val, host],
                             capture_output=True, text=True, timeout=timeout + 2)
        if out.returncode != 0:
            return None
        m = re.search(r"time[=<]([\d.]+)", out.stdout)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def probe_target(t):
    """Despacha pelo tipo de check (icmp por padrão). Retorna latência ms ou None."""
    ttype = t.get("type", "icmp")
    if ttype != "icmp":
        try:
            import checks
            return checks.probe(t)
        except ImportError:
            return None
    return ping_host(t["host"])


def _record_result(name, ts, lat):
    ok = lat is not None
    with _state_lock:
        prev = _last_latency.get(name)
        jitter = abs(lat - prev) if (ok and prev is not None) else 0
        if ok:
            _last_latency[name] = lat
        _win.setdefault(name, deque(maxlen=WINDOW)).append((ts, lat, ok, jitter))
        c = _consec.setdefault(name, [0, 0])
        if ok:
            c[0], c[1] = 0, c[1] + 1
        else:
            c[0], c[1] = c[0] + 1, 0
    return (name, ts, lat, int(ok), jitter)


def window_snapshot():
    out = {}
    with _state_lock:
        items = {k: list(v) for k, v in _win.items()}
    for name, rows in items.items():
        if not rows:
            continue
        ok = [r for r in rows if r[2]]
        out[name] = {
            "online": bool(rows[-1][2]), "latency": rows[-1][1],
            "avg_latency": sum(r[1] for r in ok) / len(ok) if ok else None,
            "avg_jitter": sum(r[3] for r in rows) / len(rows),
            "jitter": rows[-1][3],
            "loss_pct": 100 * (1 - len(ok) / len(rows)),
            "last_ts": rows[-1][0], "samples": len(rows)}
    return out


def warm_state():
    """Preenche as janelas deslizantes a partir do banco ao iniciar."""
    for t in get_targets():
        rows = db.query_w("SELECT ts, latency, success, jitter FROM pings WHERE target=? ORDER BY ts DESC LIMIT ?",
                          (t["name"], WINDOW))
        d = deque(maxlen=WINDOW)
        for r in reversed(rows):
            d.append((r["ts"], r["latency"], bool(r["success"]), r["jitter"] or 0))
            if r["success"]:
                _last_latency[t["name"]] = r["latency"]
        if d:
            _win[t["name"]] = d
            fails = 0
            for r in rows:
                if r["success"]:
                    break
                fails += 1
            _consec[t["name"]] = [fails, 0 if fails else 1]


def _parent_down(name, items):
    for anc in _ancestors(name, items):
        if ("offline", anc) in _active_incidents:
            return anc
    return None


def evaluate_target_health(name, items=None):
    with _state_lock:
        rows = list(_win.get(name, ()))
        fails_c, oks_c = _consec.get(name, [0, 0])
    if not rows:
        return
    total = len(rows)
    fails = sum(1 for r in rows if not r[2])
    loss_pct = fails / total * 100
    lats = [r[1] for r in rows if r[2]]
    avg_lat = sum(lats) / len(lats) if lats else None
    avg_jit = sum(r[3] for r in rows) / total

    items = items if items is not None else get_targets()
    # offline: N falhas consecutivas abrem; M sucessos consecutivos fecham
    key = ("offline", name)
    if fails_c >= OFFLINE_N and key not in _active_incidents:
        anc = _parent_down(name, items)
        if anc:
            if ("suppressed", name) not in _pending:
                _pending[("suppressed", name)] = True
                log_event(f"{name} sem resposta — causa provável: {anc} offline (alerta suprimido)", "Info")
        else:
            raise_incident("offline", name, f"{name} está offline", "Alta")
    elif oks_c >= RECOVER_N:
        _pending.pop(("suppressed", name), None)
        resolve_incident("offline", name)

    offline = key in _active_incidents or fails_c >= OFFLINE_N
    if offline:
        return      # latência/jitter/perda são ruído enquanto está fora
    if fails_c > 0:
        return      # sequência de falhas em curso: espera confirmar offline ou recuperar
    if avg_lat is not None:
        _hyst("latency", name, avg_lat > THRESH["ping_ms"],
              lambda: raise_incident("latency", name, f"Alta latência detectada no destino {name}", "Alta"))
    _hyst("jitter", name, avg_jit > THRESH["jitter_ms"],
          lambda: raise_incident("jitter", name, f"Jitter alto detectado em {name}", "Media"))
    _hyst("loss", name, loss_pct > THRESH["loss_pct"] and fails >= LOSS_MIN_FAILS,
          lambda: raise_incident("loss", name, f"Perda de pacotes detectada para {name}", "Media"))


_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="probe")


def ping_cycle(force=False):
    """Um ciclo: sonda em paralelo os alvos vencidos e grava tudo em um único commit."""
    now = time.time()
    interval = get_intervals()["ping_interval_seconds"]
    items = get_targets()
    due = []
    for t in items:
        if t.get("type") == "agent":      # alimentado por agente remoto, não sondado aqui
            continue
        iv = max(1, int(t.get("interval") or interval))
        if force or _next_due.get(t["name"], 0) <= now:
            _next_due[t["name"]] = now + iv
            due.append(t)
    if not due:
        return 0
    futs = [(t, _pool.submit(probe_target, t)) for t in due]
    rows = []
    for t, f in futs:
        try:
            lat = f.result(timeout=30)
        except Exception:
            lat = None
        rows.append(_record_result(t["name"], time.time(), lat))
    db.insert_pings(rows)
    names = {t["name"] for t in items}
    for t in due:
        evaluate_target_health(t["name"], items)
    return len(rows)


def ping_worker():
    while True:
        t0 = time.time()
        try:
            ping_cycle()
        except Exception as e:
            print("ping_worker:", e)
        time.sleep(max(0.2, 1.0 - (time.time() - t0)))


# ------------------------------------------------------------------------- dns
def dns_worker():
    import dns.resolver
    fails = {}
    while True:
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
            fails[s["name"]] = 0 if success else fails.get(s["name"], 0) + 1
            if not success:
                if fails[s["name"]] >= 2:
                    raise_incident("dns", s["name"], f"DNS {s['name']} não respondeu", "Media")
            else:
                _hyst("dns", s["name"], latency > THRESH["dns_ms"],
                      lambda s=s, latency=latency: raise_incident(
                          "dns", s["name"], f"DNS da {s['name']} lento: {latency:.0f}ms", "Baixa"))
        db.executemany("INSERT INTO dns_checks(server,ts,latency,success) VALUES(?,?,?,?)", rows)
        time.sleep(get_intervals()["dns_check_interval_seconds"])


def public_ip_worker():
    while True:
        for key, url in (("public_ip", "https://api.ipify.org?format=json"),
                         ("public_ipv6", "https://api64.ipify.org?format=json")):
            try:
                db.set_meta(key, requests.get(url, timeout=5).json().get("ip"))
            except Exception:
                pass
        time.sleep(get_intervals()["public_ip_interval_seconds"])


def get_cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000, 1)
    except Exception:
        return None


def system_worker():
    while True:
        cpu = psutil.cpu_percent(interval=1)
        mem = psutil.virtual_memory().percent
        temp = get_cpu_temp()
        meta = {"cpu_pct": cpu, "mem_pct": mem}
        if temp is not None:
            meta["temp_c"] = temp
        db.set_meta_many(meta)
        if temp is not None:
            _hyst("temp", "Raspberry Pi", temp > THRESH["temp_c"],
                  lambda: raise_incident("temp", "Raspberry Pi", f"Temperatura alta: {temp}°C", "Media"))
        _hyst("cpu", "Raspberry Pi", cpu > THRESH["cpu_pct"],
              lambda: raise_incident("cpu", "Raspberry Pi", f"CPU alta: {cpu}%", "Media"), n_open=3)
        time.sleep(get_intervals()["system_interval_seconds"])


def rollup_worker():
    while True:
        try:
            stats.run_rollups()
        except Exception as e:
            print("rollup:", e)
        time.sleep(60)


def cert_worker():
    """Verifica a validade dos certificados dos alvos https a cada 6 h."""
    import checks
    warn, crit = int(CFG.get("cert_warn_days", 14)), int(CFG.get("cert_crit_days", 3))
    time.sleep(30)
    while True:
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
        time.sleep(6 * 3600)


def snmp_worker():
    import snmp
    due = {}
    while True:
        for dev in snmp.get_devices():
            n = dev["name"]
            if due.get(n, 0) > time.time():
                continue
            due[n] = time.time() + dev.get("poll_seconds", 60)
            try:
                res = snmp.poll_device(dev)
                _hyst("snmp", n, False, lambda: None)
                for key, bad, why in snmp.check_thresholds(dev, res.get("custom", {})):
                    _hyst("snmpval", f"{n}/{key}", bad,
                          lambda n=n, key=key, why=why: raise_incident(
                              "snmpval", f"{n}/{key}", f"{n}: {key} fora do limite ({why})", "Media"))
            except Exception as e:
                _hyst("snmp", n, True,
                      lambda n=n, e=e: raise_incident("snmp", n, f"SNMP sem resposta de {n}: {str(e)[:80]}", "Media"),
                      n_open=3)
        time.sleep(5)


def sites_worker():
    import sites
    while True:
        try:
            sites.watchdog()
        except Exception as e:
            print("sites:", e)
        time.sleep(30)


def prune_worker():
    time.sleep(120)
    while True:
        try:
            stats.run_rollups()          # nunca apagar bruto antes de agregar
            db.prune_old(CFG["history_retention_days"], RAW_DAYS, H1_DAYS)
            try:
                import snmp
                snmp.prune(CFG["history_retention_days"])
            except Exception:
                pass
        except Exception as e:
            print("prune:", e)
        time.sleep(3600)


# -------------------------------------------------------------------- speedtest
def run_speedtest():
    result = {"download": None, "upload": None, "latency": None}
    try:
        start = time.time()
        requests.get("https://speed.cloudflare.com/__down?bytes=0", timeout=3)
        result["latency"] = (time.time() - start) * 1000
    except Exception:
        pass
    try:
        start = time.time()
        r = requests.get("https://speed.cloudflare.com/__down?bytes=25000000", timeout=20)
        result["download"] = round((len(r.content) * 8 / 1e6) / (time.time() - start), 1)
    except Exception:
        pass
    try:
        payload = b"0" * 5_000_000
        start = time.time()
        requests.post("https://speed.cloudflare.com/__up", data=payload, timeout=20)
        result["upload"] = round((len(payload) * 8 / 1e6) / (time.time() - start), 1)
    except Exception:
        pass
    db.execute("INSERT INTO speedtests(ts,download,upload,latency) VALUES(?,?,?,?)",
               (time.time(), result["download"], result["upload"], result["latency"]))
    log_event(f"Teste de velocidade concluído: {result['download']} Mbps down / {result['upload']} Mbps up", "Info")
    return result


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


_started = False


def start_all():
    global _started
    if _started:
        return
    _started = True
    db.init_db()
    init_settings()
    reconcile_incidents()
    warm_state()
    log_event("NetNOC iniciado", "Info")
    for fn in (ping_worker, dns_worker, public_ip_worker, system_worker, rollup_worker,
               prune_worker, mikrotik_worker, agh_worker, cert_worker, snmp_worker, sites_worker):
        threading.Thread(target=fn, daemon=True, name=fn.__name__).start()
