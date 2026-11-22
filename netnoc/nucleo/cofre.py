"""Segredos em repouso: inventário, endurecimento na partida e troca da chave (v3.14).

Todas as senhas, tokens e chaves de API salvos em `settings` ficam cifrados com Fernet
(AES-128-CBC + HMAC-SHA256) e o prefixo `enc:v1:`; a chave fica em `netnoc.key` (0600) ou em
NETNOC_SECRET_KEY. Este módulo:

- `harden()` — roda na partida: corrige a permissão do `netnoc.key`, cifra qualquer segredo
  conhecido que ainda esteja em texto puro (bancos antigos, restauração manual) e cifra o
  segredo das sessões.
- `inventory()` — lista cada segredo conhecido e se está cifrado, vazio ou em texto puro
  (sem nunca devolver o valor). Usado em Configurações → Segurança e no `manage.py secrets`.
- `rotate_key()` — gera uma chave nova, recifra tudo numa transação só e troca o arquivo,
  guardando a anterior como `netnoc.key.<data>.bak`. Rodar com o NetNOC e o coletor parados
  (o `manage.py rotate-key` avisa).
"""
import json, os, stat, time

from netnoc.nucleo import db, security

# chave em settings → campos secretos. "*" = cada item de uma lista; "canal.campo" = dentro de um objeto.
REGISTRY = {
    "telegram": ("bot_token",),
    "mikrotik": ("password",),
    "agh": ("password",),
    "ai_bot": ("gemini_key", "groq_key"),
    "dvr": ("password",),
    "notify": ("discord.webhook_url", "webhook.secret", "email.password"),
    "guarda": ("hc_url",),            # v4.2: URL do vigia externo
    "session_secret": ("",),          # valor inteiro (texto, não JSON)
}
HASHED = ("metrics_token_hash", "users")   # guardados só como hash: nada a cifrar
LABELS = {
    "telegram": "Telegram", "mikrotik": "MikroTik", "agh": "AdGuard Home", "ai_bot": "Bot/IA",
    "dvr": "Câmeras (DVR)", "notify": "Outros canais de alerta", "guarda": "Vigia externo", "session_secret": "Assinatura das sessões",
}


# ------------------------------------------------------------------ helpers
def _walk(obj, path):
    """Devolve [(container, chave)] para o caminho ('a.b', '*.c', '')."""
    if path == "":
        return []
    head, _, rest = path.partition(".")
    if head == "*":
        out = []
        for item in obj if isinstance(obj, list) else []:
            out += _walk(item, rest) if rest else []
        return out
    if not isinstance(obj, dict):
        return []
    if not rest:
        return [(obj, head)] if head in obj else []
    return _walk(obj.get(head), rest)


def _state(v):
    if not v:
        return "vazio"
    return "cifrado" if str(v).startswith(security.ENC_PREFIX) else "texto puro"


def key_file_info():
    if os.environ.get("NETNOC_SECRET_KEY"):
        return {"source": "env", "path": None, "mode": None, "ok": True}
    p = security._KEY_FILE
    if not os.path.exists(p):
        return {"source": "file", "path": os.path.abspath(p), "mode": None, "ok": False}
    mode = stat.S_IMODE(os.stat(p).st_mode)
    return {"source": "file", "path": os.path.abspath(p), "mode": oct(mode), "ok": not (mode & 0o077)}


# ------------------------------------------------------------------ inventário
def inventory():
    rows = []
    for key, fields in REGISTRY.items():
        raw = db.get_setting(key)
        if key == "session_secret":
            rows.append({"key": key, "label": LABELS[key], "field": "", "state": _state(raw)})
            continue
        try:
            cfg = json.loads(raw) if raw else None
        except Exception:
            cfg = None
        for f in fields:
            refs = _walk(cfg, f) if cfg is not None else []
            if not refs:
                rows.append({"key": key, "label": LABELS[key], "field": f.replace("*.", ""), "state": "vazio"})
            for i, (c, k) in enumerate(refs):
                name = (c.get("name") or str(i + 1)) if f.startswith("*.") else ""
                rows.append({"key": key, "label": LABELS[key] + (f" · {name}" if name else ""),
                             "field": f.replace("*.", ""), "state": _state(c.get(k))})
    plain = sum(r["state"] == "texto puro" for r in rows)
    return {"items": rows, "plain": plain, "encrypted": sum(r["state"] == "cifrado" for r in rows),
            "key": key_file_info(), "hashed": list(HASHED)}


# ------------------------------------------------------------------ partida
def harden():
    """Corrige permissão da chave e cifra segredos em texto puro. Devolve a lista do que mudou."""
    changed = []
    info = key_file_info()
    if info["source"] == "file" and info["mode"] and not info["ok"]:
        try:
            os.chmod(info["path"], 0o600)
            changed.append(f"permissão de {os.path.basename(info['path'])}: {info['mode']} → 0o600")
        except OSError as e:
            print(f"[cofre] não deu para restringir {info['path']}: {e}", flush=True)
    for key, fields in REGISTRY.items():
        raw = db.get_setting(key)
        if not raw:
            continue
        if key == "session_secret":
            if not raw.startswith(security.ENC_PREFIX):
                db.set_setting(key, security.encrypt(raw))
                changed.append(key)
            continue
        try:
            cfg = json.loads(raw)
        except Exception:
            continue
        hit = False
        for f in fields:
            for c, k in _walk(cfg, f):
                v = c.get(k)
                if v and isinstance(v, str) and not v.startswith(security.ENC_PREFIX) and v != security.MASK:
                    c[k] = security.encrypt(v)
                    hit = True
        if hit:
            db.set_setting(key, json.dumps(cfg))
            changed.append(key)
    if changed:
        print(f"[cofre] protegido em repouso: {', '.join(changed)}", flush=True)
    return changed


# ------------------------------------------------------------------ troca de chave
def _recrypt(value, old, new):
    """Recifra recursivamente qualquer string 'enc:v1:' dentro de value (str/JSON)."""
    if isinstance(value, str):
        if value.startswith(security.ENC_PREFIX):
            plain = old.decrypt(value[len(security.ENC_PREFIX):].encode())     # falha → exceção (aborta tudo)
            return security.ENC_PREFIX + new.encrypt(plain).decode(), 1
        return value, 0
    if isinstance(value, list):
        n = 0
        out = []
        for v in value:
            v2, k = _recrypt(v, old, new)
            out.append(v2)
            n += k
        return out, n
    if isinstance(value, dict):
        n = 0
        out = {}
        for kk, v in value.items():
            out[kk], k = _recrypt(v, old, new)
            n += k
        return out, n
    return value, 0


def rotate_key():
    """Gera chave nova e recifra todos os segredos. Devolve {'values': n, 'backup': caminho}."""
    from cryptography.fernet import Fernet
    if os.environ.get("NETNOC_SECRET_KEY"):
        raise RuntimeError("A chave vem de NETNOC_SECRET_KEY: troque a variável e recifre manualmente.")
    path = os.path.abspath(security._KEY_FILE)
    if not os.path.exists(path):
        raise RuntimeError(f"Chave não encontrada em {path}")
    old = security._get_fernet()
    new_key = Fernet.generate_key()
    new = Fernet(new_key)
    total = 0
    tmp = path + ".novo"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(new_key.decode())
    with db._lock:
        c = db._writer()
        try:
            c.execute("BEGIN IMMEDIATE")
            for r in c.execute("SELECT key, value FROM settings WHERE value LIKE ?", (f"%{security.ENC_PREFIX}%",)).fetchall():
                raw = r["value"]
                if raw.startswith(security.ENC_PREFIX):
                    v2, n = _recrypt(raw, old, new)
                else:
                    try:
                        v2, n = _recrypt(json.loads(raw), old, new)
                        v2 = json.dumps(v2)
                    except ValueError:
                        continue
                if n:
                    c.execute("UPDATE settings SET value=? WHERE key=?", (v2, r["key"]))
                    total += n
            backup = f"{path}.{time.strftime('%Y%m%d-%H%M%S')}.bak"
            with open(path) as src:
                bfd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(bfd, "w") as b:
                    b.write(src.read())
            c.commit()
        except Exception:
            c.rollback()
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    os.replace(tmp, path)               # só troca o arquivo depois que tudo foi recifrado e gravado
    security._fernet = new
    security._skey = None
    return {"values": total, "backup": backup}
