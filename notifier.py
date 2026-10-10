"""Notificações: Telegram (via monitor), Discord, webhook genérico (HMAC), e-mail SMTP, janelas de manutenção."""
import hashlib, hmac, json, queue, smtplib, ssl, threading, time, uuid
from email.message import EmailMessage
from typing import Optional

import requests

import db
import security

SEV = {"Alta": 3, "Media": 2, "Baixa": 1, "Info": 0}

_SECRETS = {
    "discord": ("webhook_url",),
    "webhook": ("secret",),
    "email": ("password",),
}
_GUARD = {
    "discord": ("webhook_url_host",),     # o próprio segredo é a URL: nunca reaproveitado se mudar
    "webhook": ("url",),
    "email": ("host", "port", "user"),
}
_DEFAULTS = {
    "min_severity": "Alta",
    "discord": {"enabled": False, "webhook_url": ""},
    "webhook": {"enabled": False, "url": "", "secret": ""},
    "email": {"enabled": False, "host": "", "port": 587, "user": "", "password": "",
              "sender": "", "to": "", "starttls": True},
}


def get_config():
    try:
        raw = json.loads(db.get_setting("notify", "{}") or "{}")
    except Exception:
        raw = {}
    cfg = json.loads(json.dumps(_DEFAULTS))
    cfg["min_severity"] = raw.get("min_severity", "Alta")
    for ch, fields in _SECRETS.items():
        cfg[ch].update(raw.get(ch, {}))
        for f in fields:
            cfg[ch][f] = security.decrypt(cfg[ch].get(f) or "")
    return cfg


def masked_config():
    cfg = get_config()
    for ch, fields in _SECRETS.items():
        for f in fields:
            cfg[ch][f] = security.MASK if cfg[ch].get(f) else ""
    return cfg


def save_config(new):
    old = get_config()
    if new.get("min_severity", "Alta") not in SEV:
        raise ValueError("Severidade inválida")
    out = {"min_severity": new.get("min_severity", "Alta")}
    d = new.get("discord", {})
    d_old = old["discord"]
    if d.get("enabled") or d.get("webhook_url"):
        if d.get("webhook_url") != security.MASK and not _valid_discord(d.get("webhook_url", "")):
            raise ValueError("URL do webhook do Discord inválida")
    out["discord"] = {"enabled": bool(d.get("enabled")),
                      "webhook_url": d_old["webhook_url"] if d.get("webhook_url") == security.MASK
                      else d.get("webhook_url", "")}
    w = new.get("webhook", {})
    if w.get("enabled") and not security.valid_url(w.get("url", "")):
        raise ValueError("URL do webhook inválida")
    out["webhook"] = security.merge_secrets(old["webhook"], {
        "enabled": bool(w.get("enabled")), "url": w.get("url", ""), "secret": w.get("secret", "")},
        ("secret",), ("url",))
    e = new.get("email", {})
    if e.get("enabled"):
        if not security.valid_host(e.get("host", "")) or not security.valid_port(e.get("port", 0)):
            raise ValueError("Servidor SMTP inválido")
        if "@" not in e.get("sender", "") or not e.get("to", ""):
            raise ValueError("Remetente/destinatário inválidos")
    out["email"] = security.merge_secrets(old["email"], {
        "enabled": bool(e.get("enabled")), "host": e.get("host", ""), "port": int(e.get("port") or 587),
        "user": e.get("user", ""), "password": e.get("password", ""), "sender": e.get("sender", ""),
        "to": e.get("to", ""), "starttls": bool(e.get("starttls", True))},
        ("password",), ("host", "port", "user"))
    stored = json.loads(json.dumps(out))
    for ch, fields in _SECRETS.items():
        for f in fields:
            stored[ch][f] = security.encrypt(stored[ch].get(f) or "")
    db.set_setting("notify", json.dumps(stored))


def _valid_discord(u):
    return isinstance(u, str) and u.startswith(("https://discord.com/api/webhooks/",
                                                "https://discordapp.com/api/webhooks/",
                                                "http://127.0.0.1", "http://localhost")) and security.valid_url(u)


# -------------------------------------------------------------- manutenção
def get_maintenance():
    try:
        return json.loads(db.get_setting("maintenance", "[]") or "[]")
    except Exception:
        return []


def add_maintenance(name, start, end, targets=None):
    if not security.valid_name(name):
        raise ValueError("Nome inválido")
    start, end = float(start), float(end)
    if end <= start or end - start > 30 * 86400:
        raise ValueError("Período inválido (máximo 30 dias)")
    items = [m for m in get_maintenance() if m["end"] > time.time() - 7 * 86400]
    items.append({"id": uuid.uuid4().hex[:8], "name": name.strip(), "start": start, "end": end,
                  "targets": [str(t) for t in (targets or [])][:200]})
    db.set_setting("maintenance", json.dumps(items))
    return items[-1]


def remove_maintenance(mid):
    db.set_setting("maintenance", json.dumps([m for m in get_maintenance() if m["id"] != mid]))


def in_maintenance(target=None, now=None):
    now = now or time.time()
    for m in get_maintenance():
        if m["start"] <= now <= m["end"] and (not m["targets"] or target in m["targets"]):
            return m
    return None


# ------------------------------------------------------------------ envio
def _send_discord(cfg, sev, text, target):
    color = {"Alta": 0xFF5C5C, "Media": 0xFFB23D, "Baixa": 0x4D8DFF, "Info": 0x8A63FF}.get(sev, 0x8A63FF)
    r = requests.post(cfg["discord"]["webhook_url"], timeout=6,
                      json={"embeds": [{"title": f"NetNOC — {sev}", "description": text[:1900], "color": color}]})
    r.raise_for_status()


def _send_webhook(cfg, sev, text, target, kind):
    w = cfg["webhook"]
    body = json.dumps({"severity": sev, "text": text, "kind": kind, "target": target,
                       "ts": time.time()}, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json"}
    if w.get("secret"):
        headers["X-NetNOC-Signature"] = "sha256=" + hmac.new(w["secret"].encode(), body, hashlib.sha256).hexdigest()
    r = requests.post(w["url"], data=body, headers=headers, timeout=6)
    r.raise_for_status()


def _send_email(cfg, sev, text, target):
    e = cfg["email"]
    msg = EmailMessage()
    msg["Subject"] = f"[NetNOC {sev}] {text.splitlines()[-1][:80] if text else ''}".replace("\n", " ")
    msg["From"] = e["sender"]
    msg["To"] = e["to"]
    msg.set_content(text)
    ctx = ssl.create_default_context()
    if int(e["port"]) == 465:
        s = smtplib.SMTP_SSL(e["host"], int(e["port"]), timeout=10, context=ctx)
    else:
        s = smtplib.SMTP(e["host"], int(e["port"]), timeout=10)
        if e.get("starttls"):
            s.starttls(context=ctx)
    try:
        if e.get("user"):
            s.login(e["user"], e["password"])
        s.send_message(msg)
    finally:
        try:
            s.quit()
        except Exception:
            pass


def _telegram(text):
    import monitor
    return monitor.send_telegram(text)


CHANNELS = ("telegram", "discord", "webhook", "email")


def send_channel(ch, sev, text, target=None, kind="incident"):
    """Envia (síncrono) por um canal. Levanta exceção em falha — usado nos botões de teste."""
    cfg = get_config()
    if ch == "telegram":
        if not _telegram(text):
            raise RuntimeError("Telegram: falha no envio")
    elif ch == "discord":
        _send_discord(cfg, sev, text, target)
    elif ch == "webhook":
        _send_webhook(cfg, sev, text, target, kind)
    elif ch == "email":
        _send_email(cfg, sev, text, target)
    else:
        raise ValueError("Canal desconhecido")


# fila assíncrona: o monitor nunca bloqueia esperando SMTP/HTTP
_q = queue.Queue(maxsize=500)
_started = False
_slock = threading.Lock()


def _worker():
    while True:
        sev, text, target, kind = _q.get()
        try:
            cfg = get_config()
            import monitor
            tg = monitor.get_telegram()
            for ch in CHANNELS:
                enabled = tg["enabled"] if ch == "telegram" else cfg[ch]["enabled"]
                minsev = tg["min_severity"] if ch == "telegram" else cfg["min_severity"]
                if not enabled or SEV.get(sev, 0) < SEV.get(minsev, 3):
                    continue
                for attempt in range(2):
                    try:
                        send_channel(ch, sev, text, target, kind)
                        break
                    except Exception as ex:
                        if attempt == 1:
                            db.execute("INSERT INTO events(ts,message,severity) VALUES(?,?,?)",
                                       (time.time(), f"Falha ao notificar via {ch}: {str(ex)[:120]}", "Baixa"))
                        else:
                            time.sleep(2)
        except Exception:
            pass


def dispatch(severity, text, kind="incident", target=None):
    global _started
    with _slock:
        if not _started:
            _started = True
            threading.Thread(target=_worker, daemon=True, name="notifier").start()
    if kind == "incident" and target is not None and in_maintenance(target):
        return False
    try:
        _q.put_nowait((severity, text, target, kind))
        return True
    except queue.Full:
        return False
