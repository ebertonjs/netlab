"""Autenticação, criptografia de segredos e validação de entrada do NetNOC."""
import base64, hashlib, hmac, ipaddress, json, os, re, secrets, threading, time
from typing import Optional

import db

MASK = "•" * 8
ENC_PREFIX = "enc:v1:"
_KEY_FILE = os.environ.get("NETNOC_KEY_FILE", "netnoc.key")

# ------------------------------------------------------------------ segredos
_fernet = None


def _get_fernet():
    global _fernet
    if _fernet is not None:
        return _fernet
    from cryptography.fernet import Fernet
    key = os.environ.get("NETNOC_SECRET_KEY")
    if not key:
        if os.path.exists(_KEY_FILE):
            key = open(_KEY_FILE, "r").read().strip()
        else:
            key = Fernet.generate_key().decode()
            fd = os.open(_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(key)
    _fernet = Fernet(key.encode() if isinstance(key, str) else key)
    return _fernet


def encrypt(value: str) -> str:
    if not value or value.startswith(ENC_PREFIX):
        return value or ""
    return ENC_PREFIX + _get_fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    if not value or not value.startswith(ENC_PREFIX):
        return value or ""
    try:
        return _get_fernet().decrypt(value[len(ENC_PREFIX):].encode()).decode()
    except Exception:
        return ""


def load_secret_cfg(key, defaults, secret_fields):
    """Lê config JSON de settings e decifra os campos secretos."""
    cfg = dict(defaults)
    try:
        cfg.update(json.loads(db.get_setting(key, "{}") or "{}"))
    except Exception:
        pass
    for f in secret_fields:
        cfg[f] = decrypt(cfg.get(f) or "")
    return cfg


def save_secret_cfg(key, cfg, secret_fields):
    out = dict(cfg)
    for f in secret_fields:
        out[f] = encrypt(out.get(f) or "")
    db.set_setting(key, json.dumps(out))


def mask_cfg(cfg, secret_fields):
    out = dict(cfg)
    for f in secret_fields:
        out[f] = MASK if out.get(f) else ""
    return out


def merge_secrets(old, new, secret_fields, guarded_fields=()):
    """Se o segredo veio mascarado, reaproveita o antigo — MAS só se host/porta/usuário
    não mudaram (senão o servidor enviaria a credencial salva para um destino escolhido pelo atacante)."""
    new = dict(new)
    for f in secret_fields:
        if new.get(f) == MASK:
            for g in guarded_fields:
                if str(new.get(g, "")) != str(old.get(g, "")):
                    raise ValueError(
                        "Host/porta/usuário alterados: informe a senha/token novamente.")
            new[f] = old.get(f, "")
    return new


# ----------------------------------------------------------------- validação
_LABEL = re.compile(r"^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$")


def valid_host(h) -> bool:
    if not isinstance(h, str):
        return False
    h = h.strip()
    if not h or len(h) > 253 or h.startswith("-"):
        return False
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        pass
    return all(_LABEL.match(p) for p in h.rstrip(".").split("."))


def valid_url(u) -> bool:
    return isinstance(u, str) and re.match(r"^https?://[^\s<>\"']{3,2000}$", u) is not None


_BAD_NAME = re.compile(r"[<>\"'&`\\\x00-\x1f\x7f]")


def valid_name(n, maxlen=60) -> bool:
    return isinstance(n, str) and 0 < len(n.strip()) <= maxlen and not _BAD_NAME.search(n)


def clean_name(n, maxlen=60) -> str:
    n = _BAD_NAME.sub("", n or "").strip()
    return n[:maxlen]


def valid_port(p) -> bool:
    try:
        return 1 <= int(p) <= 65535
    except Exception:
        return False


# ------------------------------------------------------------------- senhas
ITER = 200_000


def hash_password(pw: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITER)
    return f"pbkdf2${ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def check_password_hash(pw: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(salt), int(it))
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except Exception:
        return False


def _users():
    try:
        return json.loads(db.get_setting("auth_users", "{}") or "{}")
    except Exception:
        return {}


def set_user(name, pw, role):
    users = _users()
    users[name] = {"hash": hash_password(pw), "role": role}
    db.set_setting("auth_users", json.dumps(users))
    _vcache.clear()


def list_users():
    return [{"name": k, "role": v.get("role", "viewer")} for k, v in _users().items()]


def delete_user(name):
    users = _users()
    if name in users and users[name].get("role") == "admin" and \
            sum(1 for u in users.values() if u.get("role") == "admin") <= 1:
        raise ValueError("Não é possível remover o último admin")
    users.pop(name, None)
    db.set_setting("auth_users", json.dumps(users))
    _vcache.clear()


def ensure_admin():
    """Cria o admin inicial. Retorna a senha gerada (ou None se já existia)."""
    if _users():
        return None
    pw = os.environ.get("NETNOC_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
    set_user("admin", pw, "admin")
    return pw


# verificação com cache (PBKDF2 é caro; 5 min)
_vcache = {}
_vlock = threading.Lock()


def verify(user, pw):
    users = _users()
    u = users.get(user)
    if not u:
        hash_password(pw)   # tempo constante aproximado
        return None
    ck = hashlib.sha256((user + "\0" + pw + "\0" + u["hash"]).encode()).hexdigest()
    now = time.time()
    with _vlock:
        hit = _vcache.get(ck)
        if hit and hit[1] > now:
            return u.get("role", "viewer")
    if check_password_hash(pw, u["hash"]):
        with _vlock:
            if len(_vcache) > 200:
                _vcache.clear()
            _vcache[ck] = (True, now + 300)
        return u.get("role", "viewer")
    return None


# ---------------------------------------------------------------- rate limit
_fails = {}
_flock = threading.Lock()
MAX_FAILS, WINDOW = 8, 600          # por IP+usuário
MAX_FAILS_IP = 40                   # teto por IP (força bruta trocando o usuário)


def _count(key, now):
    lst = [t for t in _fails.get(key, []) if t > now - WINDOW]
    if lst:
        _fails[key] = lst
    else:
        _fails.pop(key, None)
    return len(lst)


def rate_limited(ip, user=""):
    now = time.time()
    with _flock:
        if len(_fails) > 5000:
            _fails.clear()
        return (_count((ip, (user or "").lower()), now) >= MAX_FAILS
                or _count((ip, None), now) >= MAX_FAILS_IP)


def register_fail(ip, user=""):
    now = time.time()
    with _flock:
        _fails.setdefault((ip, (user or "").lower()), []).append(now)
        _fails.setdefault((ip, None), []).append(now)


# --------------------------------------------------------------- tokens agent
def new_token():
    return secrets.token_urlsafe(32)


def token_hash(t):
    return hashlib.sha256(t.encode()).hexdigest()


def check_token(setting_key, token):
    stored = db.get_setting(setting_key, "")
    return bool(stored and token and hmac.compare_digest(stored, token_hash(token)))


# ------------------------------------------------------------- sessão (cookie)
SESSION_COOKIE = "netnoc_session"
SESSION_TTL = 12 * 3600
SESSION_TTL_LONG = 30 * 86400


def _session_key():
    k = db.get_setting("session_secret", "")
    if not k:
        k = secrets.token_hex(32)
        db.set_setting("session_secret", k)
    return k.encode()


def _fp(user):
    u = _users().get(user) or {}
    return hashlib.sha256((u.get("hash") or "").encode()).hexdigest()[:10]


def make_session(user, ttl=SESSION_TTL):
    body = base64.urlsafe_b64encode(json.dumps(
        {"u": user, "e": int(time.time() + ttl), "f": _fp(user)}, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(_session_key(), body.encode(), hashlib.sha256).hexdigest()
    return body + "." + sig


def parse_session(token):
    """Retorna (user, role) ou None. Trocar a senha ou remover o usuário invalida a sessão."""
    try:
        body, sig = token.split(".", 1)
        calc = hmac.new(_session_key(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, sig):
            return None
        d = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if d.get("e", 0) < time.time():
            return None
        u = _users().get(d.get("u"))
        if not u or d.get("f") != _fp(d["u"]):
            return None
        return d["u"], u.get("role", "viewer")
    except Exception:
        return None


def _hostport(h, scheme):
    h = (h or "").strip().lower()
    host, sep, port = h.rpartition(":")
    if not sep or "]" in port:                       # sem porta (ou IPv6 sem porta)
        return h, {"http": "80", "https": "443", "ws": "80", "wss": "443"}.get(scheme, "")
    return host, port


def _same_origin(origin, hdrs):
    """Origin do navegador == host acessado (aceita porta padrão implícita e host repassado por proxy)."""
    if not origin or "://" not in origin:
        return False
    scheme, _, rest = origin.partition("://")
    o = _hostport(rest.split("/", 1)[0], scheme.lower())
    cands = [hdrs.get("host", "")] + [x.strip() for x in hdrs.get("x-forwarded-host", "").split(",") if x.strip()]
    return any(_hostport(c, scheme.lower()) == o or _hostport(c, "https" if scheme == "http" else "http") == o
               for c in cands)


def _cookie_from(hdr):
    for part in (hdr or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == SESSION_COOKIE:
            return v
    return ""


# ---------------------------------------------------------------- middleware
AUTH_OFF = os.environ.get("NETNOC_AUTH", "on").lower() == "off"
PUBLIC_PATHS = {"/healthz", "/status", "/status.html", "/status.js", "/api/public/status",
                "/login", "/login.js", "/api/login", "/api/loginfo", "/style.css", "/theme-grafana.css",
                "/glass/login.css",
                "/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/favicon.ico"}
AGENT_PREFIX = "/api/agent/"
METRICS_PATH = "/metrics"
ADMIN_ONLY_METHODS = {"POST", "PUT", "DELETE", "PATCH"}
# POSTs liberados para viewer (leituras que usam POST)
VIEWER_POST_OK = {"/api/logout"}

CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
SEC_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
]


async def _send_plain(send, status, body, extra=()):
    if isinstance(body, str):
        body = body.encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    headers += list(extra) + SEC_HEADERS
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class AuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            # vídeo das câmeras: exige sessão válida e mesma origem (evita sequestro de WebSocket entre sites)
            hdrs = {k.decode().lower(): v.decode("latin-1") for k, v in scope["headers"]}
            scope.setdefault("state", {})
            origin = hdrs.get("origin", "")
            same = _same_origin(origin, hdrs)
            sess = None
            if not AUTH_OFF:
                sess = parse_session(_cookie_from(hdrs.get("cookie", "")))
                auth = hdrs.get("authorization", "")
                if not sess and auth.startswith("Basic "):          # quem entrou pelo login do navegador (Basic)
                    ip = (scope.get("client") or ("?", 0))[0]
                    try:
                        u, _, pw = base64.b64decode(auth[6:]).decode().partition(":")
                    except Exception:
                        u, pw = "", ""
                    if u and not rate_limited(ip, u):
                        r = verify(u, pw)
                        if r:
                            sess = (u, r)
                        else:
                            register_fail(ip, u)
            if not same or (not AUTH_OFF and not sess):
                why = "origem diferente" if not same else ("sem cookie de sessão" if SESSION_COOKIE not in hdrs.get("cookie", "") else "sessão inválida/expirada")
                print(f"[cam/ws] recusado: {why} (origin={origin[:80]!r} host={hdrs.get('host', '')[:80]!r})", flush=True)
                await send({"type": "websocket.close", "code": 1008})
                return
            scope["state"]["user"], scope["state"]["role"] = sess if sess else ("anon", "admin")
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        method = scope["method"]
        hdrs = {k.decode().lower(): v.decode("latin-1") for k, v in scope["headers"]}
        client = (scope.get("client") or ("?", 0))[0]
        scope.setdefault("state", {})

        async def send_sec(msg):
            if msg["type"] == "http.response.start":
                names = {h[0] for h in msg["headers"]}
                msg["headers"] = list(msg["headers"]) + [h for h in SEC_HEADERS if h[0] not in names]
            await send(msg)

        # agentes remotos: Bearer próprio (validado no endpoint)
        if path.startswith(AGENT_PREFIX):
            scope["state"]["user"] = "agent"
            scope["state"]["role"] = "agent"
            return await self.app(scope, receive, send_sec)
        if path in PUBLIC_PATHS:
            scope["state"]["user"], scope["state"]["role"] = "public", "public"
            return await self.app(scope, receive, send_sec)
        if path == METRICS_PATH:
            auth = hdrs.get("authorization", "")
            if auth.startswith("Bearer ") and check_token("metrics_token_hash", auth[7:]):
                scope["state"]["user"], scope["state"]["role"] = "metrics", "metrics"
                return await self.app(scope, receive, send_sec)

        role, user = "admin", "anon"
        if not AUTH_OFF:
            auth = hdrs.get("authorization", "")
            role = None
            sess = parse_session(_cookie_from(hdrs.get("cookie", ""))) if SESSION_COOKIE in hdrs.get("cookie", "") else None
            if sess:
                # sessão válida nunca é bloqueada pelo limite de tentativas (antes: 8 erros de
                # qualquer um no mesmo IP/proxy derrubavam todos os usuários logados)
                user, role = sess
            elif auth.startswith("Basic "):
                try:
                    u, _, p = base64.b64decode(auth[6:]).decode().partition(":")
                except Exception:
                    u, p = "", ""
                if rate_limited(client, u):
                    return await _send_plain(send, 429, '{"detail":"Muitas tentativas. Aguarde."}',
                                             [(b"retry-after", b"600")])
                role = verify(u, p) if u else None
                user = u
                if role is None:
                    register_fail(client, u)
            if role is None:
                browser = "sec-fetch-mode" in hdrs
                if (browser and method == "GET" and not path.startswith("/api/")
                        and hdrs.get("sec-fetch-mode") == "navigate"):
                    from urllib.parse import quote
                    nxt = quote(path + ("?" + scope["query_string"].decode() if scope.get("query_string") else ""), safe="/?=&")
                    return await _send_plain(send, 302, b"", [(b"location", b"/login?next=" + nxt.encode()),
                                                              (b"cache-control", b"no-store")])
                # navegadores: sem desafio Basic (o front redireciona para /login); curl/agentes continuam com Basic
                extra = [] if (browser or "x-netnoc" in hdrs) else [(b"www-authenticate", b'Basic realm="NetNOC", charset="UTF-8"')]
                return await _send_plain(send, 401, '{"detail":"Autenticação necessária"}', extra)
        # CSRF: mutações exigem cabeçalho customizado + origem igual
        if method in ADMIN_ONLY_METHODS:
            if hdrs.get("x-netnoc") != "1":
                return await _send_plain(send, 403, '{"detail":"CSRF: cabeçalho ausente"}')
            origin = hdrs.get("origin")
            if origin:
                host = hdrs.get("host", "")
                if origin.split("://", 1)[-1] != host:
                    return await _send_plain(send, 403, '{"detail":"CSRF: origem inválida"}')
            if role != "admin" and path not in VIEWER_POST_OK:
                return await _send_plain(send, 403, '{"detail":"Somente administradores"}')
        scope["state"]["user"] = user
        scope["state"]["role"] = role
        scope["state"]["ip"] = client
        return await self.app(scope, receive, send_sec)
