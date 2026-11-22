"""Backup/restauração da configuração (JSON). Segredos NUNCA saem no export; na restauração
são mantidos os atuais quando o destino (host/url/usuário) não mudou, senão ficam em branco."""
import json, time
from netnoc.nucleo import db
from netnoc.integracoes import dvr
from netnoc.coleta import monitor
from netnoc.alertas import notifier
from netnoc.nucleo import security
from netnoc.bot import aibot

FORMAT = "netnoc-backup"
VERSION = 2

# chave -> (campos secretos, campos de destino que invalidam o segredo)
SECRET_MAP = {
    "telegram": (("bot_token",), ("chat_id",)),
    "mikrotik": (("password",), ("host", "port", "username", "use_https")),
    "agh": (("password",), ("host", "port", "username", "use_https")),
    "dvr": (("password",), ("host", "http_port", "rtsp_port", "username")),
    "ai_bot": (("gemini_key", "groq_key"), ()),
}
PLAIN = ("targets", "dns_servers", "intervals", "app_name", "maintenance", "ui_default")
# backups de versões antigas ainda podem trazer estas chaves: são ignoradas (SNMP, Zabbix, speedtest saíram na v4.0)
IGNORED = ("zabbix", "snmp_devices", "speedtest_auto")


def export_cfg():
    out = {}
    for k in PLAIN:
        raw = db.get_setting(k)
        if raw is not None:
            out[k] = raw if k == "app_name" else json.loads(raw)
    cfgs = {"telegram": monitor.get_telegram(), "mikrotik": monitor.get_mikrotik(),
            "agh": monitor.get_agh(), "dvr": dvr.get_cfg(), "ai_bot": aibot.get_cfg()}
    for k, (secrets_, _) in SECRET_MAP.items():
        c = dict(cfgs[k])
        for f in secrets_:
            c[f] = ""
        out[k] = c
    n = notifier.get_config()
    n["discord"]["webhook_url"] = ""
    n["webhook"]["secret"] = ""
    n["email"]["password"] = ""
    out["notify"] = n
    return {"format": FORMAT, "version": VERSION, "exported_at": time.time(), "settings": out}


class BackupError(ValueError):
    pass


def _validate(data):
    """Valida TUDO antes de gravar qualquer coisa. Retorna dict normalizado key->objeto."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise BackupError("Arquivo não é um backup do NetNOC")
    if int(data.get("version", 0)) > VERSION:
        raise BackupError("Backup de versão mais nova")
    s = data.get("settings")
    if not isinstance(s, dict):
        raise BackupError("Campo 'settings' ausente")
    out = {}
    if "targets" in s:
        ts = s["targets"]
        if not isinstance(ts, list) or len(ts) > 1000:
            raise BackupError("targets: formato inválido")
        names = set()
        # destino de agente remoto (multi-site, removido na v4.0) fica de fora
        ts = [t for t in ts if not (isinstance(t, dict) and t.get("type") == "agent")]
        for t in ts:
            if not isinstance(t, dict):
                raise BackupError("targets: item inválido")
            n, h = t.get("name"), t.get("host")
            if not security.valid_name(n or ""):
                raise BackupError(f"targets: nome inválido: {str(n)[:30]}")
            ok = security.valid_url(h) if t.get("type") == "http" else security.valid_host(h)
            if not ok:
                raise BackupError(f"targets: host inválido em {n}")
            if t.get("type") == "tcp" and not security.valid_port(t.get("port")):
                raise BackupError(f"targets: porta inválida em {n}")
            if t.get("type", "icmp") not in ("icmp", "tcp", "http"):
                raise BackupError(f"targets: tipo inválido em {n}")
            iv = t.get("interval")
            if iv is not None and (not isinstance(iv, int) or not 2 <= iv <= 3600):
                raise BackupError(f"targets: intervalo inválido em {n}")
            st = t.get("expect_status")
            if st is not None and (not isinstance(st, int) or not 100 <= st <= 599):
                raise BackupError(f"targets: status HTTP inválido em {n}")
            t.pop("sites", None)
            g = t.get("group")
            if g is not None and (not isinstance(g, str) or not security.valid_name(g, 30)):
                raise BackupError(f"targets: grupo inválido em {n}")
            if n in names:
                raise BackupError(f"targets: nome duplicado {n}")
            names.add(n)
        for t in ts:
            if t.get("parent") and t["parent"] not in names:
                t.pop("parent")          # o pai era um destino que saiu (ex.: agente): vira destino de topo
        out["targets"] = ts
    if "dns_servers" in s:
        ds = s["dns_servers"]
        if not isinstance(ds, list) or any(not isinstance(d, dict) or not security.valid_name(d.get("name") or "")
                                           or not security.valid_host(d.get("ip") or "") for d in ds):
            raise BackupError("dns_servers: formato inválido")
        out["dns_servers"] = ds
    if "intervals" in s:
        iv = s["intervals"]
        if not isinstance(iv, dict):
            raise BackupError("intervals: formato inválido")
        clean = {}
        for k, v in iv.items():
            if k in monitor._INTERVAL_DEFAULTS:
                if not isinstance(v, int) or not 1 <= v <= 86400:
                    raise BackupError(f"intervals: {k} inválido")
                clean[k] = v
        out["intervals"] = clean
    if "ui_default" in s:
        u = s["ui_default"]
        import re as _re
        if not isinstance(u, dict) or not _re.fullmatch(r"#[0-9a-fA-F]{6}", str(u.get("accent", "#6750a4"))):
            raise BackupError("ui_default: tema inválido")
        # v4.0: só o tema Pro; backups com outro tema viram Pro (escuro, salvo se era claro)
        u = {"skin": "pro", "mode": "light" if u.get("mode") in ("light",) else "dark", "accent": u.get("accent", "#6750a4")}
        out["ui_default"] = {"skin": u["skin"], "mode": u["mode"], "accent": str(u.get("accent", "#6750a4")).lower()}
    if "app_name" in s:
        if not isinstance(s["app_name"], str) or not security.valid_name(s["app_name"], 40):
            raise BackupError("app_name inválido")
        out["app_name"] = s["app_name"]
    if "maintenance" in s:
        ms = s["maintenance"]
        if not isinstance(ms, list):
            raise BackupError("maintenance: formato inválido")
        for m in ms:
            if not isinstance(m, dict) or not security.valid_name(m.get("name") or "") or \
                    not isinstance(m.get("start"), (int, float)) or not isinstance(m.get("end"), (int, float)) or \
                    m["end"] <= m["start"]:
                raise BackupError("maintenance: item inválido")
            m.setdefault("id", str(int(m["start"])))
            m["targets"] = [str(x) for x in (m.get("targets") or [])]
        out["maintenance"] = ms
    for k in ("telegram", "mikrotik", "agh", "dvr", "ai_bot"):
        if k in s:
            c = s[k]
            if not isinstance(c, dict):
                raise BackupError(f"{k}: formato inválido")
            if k == "ai_bot" and c.get("provider", "none") not in aibot.PROVIDERS:
                raise BackupError("ai_bot: provedor inválido")
            if k == "ai_bot" and any(c.get(m) and not aibot.valid_model(c[m]) for m in ("gemini_model", "groq_model")):
                raise BackupError("ai_bot: modelo inválido")
            if k in ("mikrotik", "agh", "dvr") and c.get("host") and not security.valid_host(c["host"]):
                raise BackupError(f"{k}: host inválido")
            out[k] = c
    if "notify" in s:
        n = s["notify"]
        if not isinstance(n, dict):
            raise BackupError("notify: formato inválido")
        if n.get("min_severity", "Alta") not in notifier.SEV:
            raise BackupError("notify: severidade inválida")
        w = n.get("webhook") or {}
        if not isinstance(w, dict) or (w.get("url") and not security.valid_url(w["url"])):
            raise BackupError("notify: URL do webhook inválida")
        e = n.get("email") or {}
        if not isinstance(e, dict) or (e.get("host") and not security.valid_host(e["host"])):
            raise BackupError("notify: servidor SMTP inválido")
        if e.get("port") not in (None, "") and not security.valid_port(e.get("port")):
            raise BackupError("notify: porta SMTP inválida")
        out["notify"] = n
    return out


def import_cfg(data):
    norm = _validate(data)           # 400 antes de tocar no banco
    applied = []
    cur = {"telegram": monitor.get_telegram(), "mikrotik": monitor.get_mikrotik(),
           "agh": monitor.get_agh(), "dvr": dvr.get_cfg(), "ai_bot": aibot.get_cfg()}
    for k in PLAIN:
        if k in norm:
            db.set_setting(k, norm[k] if k == "app_name" else json.dumps(norm[k]))
            applied.append(k)
    monitor._invalidate_targets()
    for k in ("telegram", "mikrotik", "agh", "dvr", "ai_bot"):
        if k in norm:
            new = dict(cur[k])
            new.update(norm[k])
            secrets_, guard = SECRET_MAP[k]
            for f in secrets_:
                same = all(str(new.get(g, "")) == str(cur[k].get(g, "")) for g in guard)
                new[f] = cur[k].get(f, "") if same else ""
            security.save_secret_cfg(k, new, secrets_)
            applied.append(k)
    if "notify" in norm:
        old = notifier.get_config()
        n = json.loads(json.dumps(norm["notify"]))
        for ch, f in (("discord", "webhook_url"), ("webhook", "secret"), ("email", "password")):
            n.setdefault(ch, {})
            guard = {"discord": (), "webhook": ("url",), "email": ("host", "port", "user")}[ch]
            same = all(str(n[ch].get(g, "")) == str(old[ch].get(g, "")) for g in guard)
            n[ch][f] = old[ch].get(f, "") if same else ""
        stored = json.loads(json.dumps(n))
        for ch, fields in notifier._SECRETS.items():
            for f in fields:
                stored[ch][f] = security.encrypt(stored[ch].get(f) or "")
        db.set_setting("notify", json.dumps(stored))
        applied.append("notify")
    return applied
