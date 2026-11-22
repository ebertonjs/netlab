"""Incidentes e eventos: abrir, resolver, histerese e reconciliação na partida.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import time



from netnoc.nucleo import db
from netnoc.coleta.base import INCIDENT_HOOKS, RECOVER_N, _active_incidents, _pending, _state_lock

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
    targets = {t["name"] for t in get_targets()}
    dns = {s["name"] for s in get_dns_servers()}

    def still_valid(itype, tgt):
        if itype in ("offline", "latency", "jitter", "loss", "cert"):
            return tgt in targets
        if itype == "dns":
            return tgt in dns
        if itype in ("cpu", "temp"):
            return True
        if itype in ("local", "camera", "dvr_hd"):
            return True          # câmeras: o worker de eventos do DVR reconcilia ao conectar
        return False

    for r in db.query_w("SELECT * FROM incidents WHERE resolved_ts IS NULL ORDER BY id"):
        key = (r["type"], r["target"])
        if not still_valid(*key) or key in _active_incidents:
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
    notify(severity, f"🚨 {get_app_name()} [{severity}]\n{message}", "incident", target)
    for fn in INCIDENT_HOOKS:
        try:
            fn(itype, target, iid, severity)
        except Exception:
            pass


def resolve_incident(itype, target, message="Resolvido"):
    with _state_lock:
        incident = _active_incidents.pop((itype, target), None)
    if incident:
        db.execute("UPDATE incidents SET resolved_ts=? WHERE id=?", (time.time(), incident["id"]))
        log_event(f"{message}: {target}", "Info")
        dur = _format_duration(time.time() - incident["started_ts"])
        notify(incident["severity"], f"✅ {get_app_name()} [{incident['severity']}]\n{target}: {message}\nDuração: {dur}",
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


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.ajustes import get_app_name  # noqa: E402
from netnoc.coleta.alvos import get_dns_servers, get_targets  # noqa: E402
from netnoc.coleta.telegram import notify  # noqa: E402
