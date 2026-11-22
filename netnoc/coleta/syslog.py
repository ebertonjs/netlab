"""Syslog do MikroTik (v4.3): o roteador manda o log dele para o NetNOC por UDP.

Com isso aparece o MOTIVO real de cada queda do PPPoE (a operadora derrubou, falhou a autenticação,
o cabo caiu…), logins no roteador e mudanças de configuração. Funciona no device-mode home.

No MikroTik (troque IP_DO_PI):
    /system logging action add name=netnoc target=remote remote=IP_DO_PI remote-port=5514
    /system logging add topics=info action=netnoc
    /system logging add topics=error action=netnoc
    /system logging add topics=warning action=netnoc
    /system logging add topics=critical action=netnoc

Só aceita pacotes vindos do IP do MikroTik configurado (qualquer outro aparelho é ignorado). Porta
acima de 1024: não precisa de root.
"""
import re, socket, threading, time

from netnoc.coleta import monitor
from netnoc.nucleo import db

KEY = "syslog"
DEFAULTS = {"enabled": False, "port": 5514}
MAX_MSG = 600
_RE_PRI = re.compile(r"^<(\d{1,3})>")
_RE_TS = re.compile(r"^(?:[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?)\s+")
_RE_TOPICS = re.compile(r"^([a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)+)\s+(.*)$", re.S)
SEV = ("emerg", "alert", "crit", "error", "warning", "notice", "info", "debug")

# frases do RouterOS -> explicação em português (a primeira que casar vale)
REASONS = [
    (re.compile(r"peer is not responding|LCP.*timeout", re.I), "a operadora parou de responder (queda do lado deles ou da fibra)"),
    (re.compile(r"authentication failed|auth.*fail|bad (?:user|password)", re.I), "falha de autenticação no PPPoE (usuário/senha ou bloqueio na operadora)"),
    (re.compile(r"terminating.*disconnected|terminating.*-\s*$|session closed|peer terminated|received PADT", re.I), "a operadora encerrou a sessão PPPoE"),
    (re.compile(r"link down|link(?:ed)? down|ether.*down", re.I), "o cabo/porta caiu (link down)"),
    (re.compile(r"no response from (?:ac|server)|timeout waiting for PADO|PADO", re.I), "o concentrador da operadora não respondeu ao reconectar"),
    (re.compile(r"\bdisconnected\b", re.I), "a conexão PPPoE caiu (o RouterOS não informou o motivo)"),
]


def get_cfg():
    import json
    try:
        c = json.loads(db.get_setting(KEY) or "{}")
    except ValueError:
        c = {}
    out = dict(DEFAULTS)
    out.update({k: c[k] for k in DEFAULTS if k in c})
    return out


def set_cfg(cfg):
    import json
    out = dict(DEFAULTS)
    out.update({k: cfg[k] for k in DEFAULTS if k in cfg})
    out["enabled"] = bool(out["enabled"])
    if not isinstance(out["port"], int) or not 1025 <= out["port"] <= 65535:
        raise ValueError("Porta do syslog: use de 1025 a 65535")
    db.set_setting(KEY, json.dumps(out))
    restart()


def parse(data):
    """bytes do pacote -> (severidade, tópicos, mensagem). Aceita BSD (RFC 3164), RFC 5424 simples e o
    formato padrão do RouterOS ('tópico,tópico mensagem')."""
    s = data.decode("utf-8", "replace").strip().replace("\x00", "")
    sev = "info"
    m = _RE_PRI.match(s)
    if m:
        sev = SEV[int(m.group(1)) % 8]
        s = s[m.end():]
        if s.startswith("1 "):                     # RFC 5424: "1 ts host app procid msgid sd msg"
            parts = s.split(" ", 7)
            s = parts[7] if len(parts) == 8 else s
    m = _RE_TS.match(s)
    if m:
        s = s[m.end():]
        # depois do horário vem o nome do roteador (uma palavra), se não for já a lista de tópicos
        if not _RE_TOPICS.match(s):
            s = s.partition(" ")[2] or s
    topics = ""
    m = _RE_TOPICS.match(s)
    if m:
        topics, s = m.group(1), m.group(2)
    for t in topics.split(","):
        if t in ("error", "warning", "critical", "info", "debug"):
            sev = {"critical": "crit"}.get(t, t)
    return sev, topics[:80], _clean(s)


def _clean(s):
    """Sem caracteres de controle; o texto é mostrado com textContent na tela, nunca como HTML."""
    return "".join(ch for ch in s if ch >= " " or ch == "\t")[:MAX_MSG].strip()


def reason(msg):
    for rx, why in REASONS:
        if rx.search(msg):
            return why
    return None


def _is_wan_msg(topics, msg):
    if "pppoe" in topics or "ppp" in topics.split(",") or monitor.WAN_RE.search(msg):
        return True
    try:
        w = monitor.wan_iface()
    except Exception:
        w = None
    return bool(w and re.search(rf"(^|\W){re.escape(w)}(\W|$)", msg))


_last_event = {}


def store(src, sev, topics, msg, now=None):
    now = now or time.time()
    db.execute("INSERT INTO syslog(ts,host,sev,topics,msg) VALUES(?,?,?,?,?)", (now, src, sev, topics, msg))
    if _is_wan_msg(topics, msg):
        why = reason(msg)
        if why and now - _last_event.get(why, 0) > 60:          # rajada do mesmo motivo vira um evento só
            _last_event[why] = now
            monitor.log_event(f"MikroTik: {why} — \"{msg[:120]}\"", "Media")


def recent(minutes=None, since=None, until=None, topic=None, text=None, limit=200):
    q, args = "SELECT ts, host, sev, topics, msg FROM syslog WHERE 1=1", []
    if minutes:
        q += " AND ts >= ?"; args.append(time.time() - minutes * 60)
    if since:
        q += " AND ts >= ?"; args.append(since)
    if until:
        q += " AND ts <= ?"; args.append(until)
    if topic:
        q += " AND (',' || topics || ',') LIKE ?"; args.append(f"%,{topic},%")
    if text:
        q += " AND msg LIKE ?"; args.append(f"%{text}%")
    q += " ORDER BY ts DESC LIMIT ?"; args.append(int(limit))
    return db.query(q, tuple(args))


def wan_reason_near(ts, window=180):
    """Motivo de uma queda da internet perto do horário `ts` (para o diagnóstico e os alertas)."""
    for r in recent(since=ts - window, until=ts + window, limit=100):
        if _is_wan_msg(r["topics"], r["msg"]):
            why = reason(r["msg"])
            if why:
                return {"reason": why, "ts": r["ts"], "msg": r["msg"]}
    return None


# ------------------------------------------------------------------ servidor UDP
_sock = None
_thread = None
_stats = {"received": 0, "ignored": 0, "last": None, "error": None}


def _allowed():
    """IPs aceitos: o do MikroTik configurado (resolvido)."""
    h = (monitor.get_mikrotik() or {}).get("host") or ""
    try:
        return {socket.gethostbyname(h)} if h else set()
    except OSError:
        return set()


def _serve(sock):
    allowed, refreshed = _allowed(), time.time()
    while True:
        try:
            data, (ip, _port) = sock.recvfrom(4096)
        except OSError:
            return                                  # socket fechado (restart/stop)
        if time.time() - refreshed > 60:
            allowed, refreshed = _allowed(), time.time()
        if ip not in allowed:
            _stats["ignored"] += 1
            continue
        try:
            sev, topics, msg = parse(data)
            if msg:
                store(ip, sev, topics, msg)
                _stats["received"] += 1
                _stats["last"] = time.time()
        except Exception as e:
            _stats["error"] = type(e).__name__


def start():
    global _sock, _thread
    cfg = get_cfg()
    if not cfg["enabled"] or _sock is not None:
        return
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", cfg["port"]))
    except OSError as e:
        _stats["error"] = f"não abriu a porta UDP {cfg['port']}: {e.strerror or e}"
        print(f"[syslog] {_stats['error']}", flush=True)
        return
    _stats["error"] = None
    _sock = s
    _thread = threading.Thread(target=_serve, args=(s,), daemon=True, name="syslog")
    _thread.start()


def stop():
    global _sock
    if _sock is not None:
        try:
            _sock.close()
        except OSError:
            pass
        _sock = None


def restart():
    stop()
    start()


def status():
    cfg = get_cfg()
    return {**cfg, "listening": _sock is not None, **_stats}
