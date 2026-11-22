"""Middlewares HTTP do NetNOC (v3.14): auditoria automática, compressão e cache dos arquivos.

- `AuditMiddleware` — toda requisição que altera algo (POST/PUT/PATCH/DELETE em /api/) entra no
  registro de auditoria com usuário, IP, método, caminho e resultado. Rotas que já registram uma
  ação detalhada (`comum.audit`) marcam a requisição e não ganham uma linha duplicada; tentativas
  negadas (403) e erros (≥500) são registrados sempre.
- `CompressMiddleware` — gzip para respostas de texto (HTML, JS, CSS, JSON). Fica de fora o tempo
  real (SSE em /api/stream), o vídeo das câmeras e downloads: compressão em blocos atrasaria os
  eventos ao vivo.
- `CacheMiddleware` — arquivos com `?v=<versão>` (app.html sempre muda a versão quando o código
  muda) ficam em cache "imutável" por um ano; o resto de static/ revalida a cada acesso.
"""
import gzip

from netnoc.nucleo import db

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
AUDIT_SKIP = ("/api/login", "/api/me/prefs")   # login tem auditoria própria; prefs: só a arrumação da tela
NO_COMPRESS = ("/api/stream", "/api/cam/", "/api/backup")


class AuditMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope["method"] not in MUTATING or not scope["path"].startswith("/api/")
                or scope["path"].startswith(AUDIT_SKIP)):
            return await self.app(scope, receive, send)
        status = {"code": 500}

        async def _send(msg):
            if msg["type"] == "http.response.start":
                status["code"] = msg["status"]
            await send(msg)

        try:
            await self.app(scope, receive, _send)
        finally:
            self._log(scope, status["code"])

    @staticmethod
    def _log(scope, code):
        st = scope.get("state") or {}
        if code == 401:
            return              # sem sessão: barrado antes de chegar à rota (evita ruído de varreduras)
        if st.get("audited") and code < 400:
            return
        user = st.get("user") or "anon"
        ip = st.get("ip") or (scope.get("client") or ("?", 0))[0]
        result = "negado" if code == 403 else ("erro" if code >= 500 else ("recusado" if code >= 400 else "ok"))
        db.audit(user, ip, f"{scope['method']} {scope['path']}"[:120], f"{result} ({code})")


class CompressMiddleware:
    """gzip próprio (o da Starlette 0.37 usa nível 9, pesado para o Pi 3, e solta avisos no log).

    Junta o corpo de respostas de texto até `max_size` e comprime de uma vez com nível 6; arquivos
    estáticos (que têm ETag) ficam comprimidos em memória, então o Pi comprime cada versão de um
    arquivo uma vez só. Respostas acima do limite ou de outros tipos passam como vieram.
    """
    TYPES = (b"text/", b"application/json", b"application/javascript", b"image/svg+xml",
             b"application/manifest+json")

    def __init__(self, app, minimum_size=800, max_size=4_000_000, level=6):
        self.app = app
        self.minimum_size, self.max_size, self.level = minimum_size, max_size, level
        self._cache = {}            # (caminho, etag) → bytes comprimidos

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"].startswith(NO_COMPRESS):
            return await self.app(scope, receive, send)
        hdrs = dict(scope.get("headers") or [])
        if b"gzip" not in hdrs.get(b"accept-encoding", b"") or b"text/event-stream" in hdrs.get(b"accept", b""):
            return await self.app(scope, receive, send)
        st = {"start": None, "parts": [], "size": 0, "mode": None}       # mode: None=decidindo, "gz", "pass"

        async def flush_plain(more):
            await send(st["start"])
            await send({"type": "http.response.body", "body": b"".join(st["parts"]), "more_body": more})
            st["parts"] = []

        async def _send(msg):
            if msg["type"] == "http.response.start":
                h = {k.lower(): v for k, v in msg["headers"]}
                ctype = h.get(b"content-type", b"")
                if (b"content-encoding" in h or not ctype.startswith(self.TYPES) or b"event-stream" in ctype
                        or msg["status"] in (204, 304)):
                    st["mode"] = "pass"
                    return await send(msg)
                st["start"], st["etag"] = msg, h.get(b"etag")
                return
            if msg["type"] != "http.response.body" or st["mode"] == "pass":
                return await send(msg)
            body, more = msg.get("body", b""), msg.get("more_body", False)
            st["parts"].append(body)
            st["size"] += len(body)
            if st["size"] > self.max_size:
                st["mode"] = "pass"
                return await flush_plain(more)
            if more:
                return
            data = b"".join(st["parts"])
            start = st["start"]
            st["mode"], st["parts"] = "done", []
            if len(data) < self.minimum_size or scope["method"] == "HEAD":
                return await send(start) or await send({"type": "http.response.body", "body": data})
            key = (scope["path"], st["etag"]) if st["etag"] else None
            gz = self._cache.get(key) if key else None
            if gz is None:
                gz = gzip.compress(data, compresslevel=self.level, mtime=0)
                if key:
                    if len(self._cache) > 200:
                        self._cache.clear()
                    self._cache[key] = gz
            headers = [(k, v) for k, v in start["headers"] if k.lower() != b"content-length"]
            headers += [(b"content-encoding", b"gzip"), (b"content-length", str(len(gz)).encode()),
                        (b"vary", b"Accept-Encoding")]
            await send({**start, "headers": headers})
            await send({"type": "http.response.body", "body": gz})

        await self.app(scope, receive, _send)
        if st["mode"] is None and st["start"] is not None and st["parts"]:     # app terminou sem fechar o corpo
            await flush_plain(False)


class CacheMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("GET", "HEAD") or scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        versioned = b"v=" in (scope.get("query_string") or b"")
        path = scope["path"]

        async def _send(msg):
            if msg["type"] == "http.response.start" and msg["status"] == 200:
                names = {h[0].lower() for h in msg["headers"]}
                if b"cache-control" not in names:
                    if versioned and not path.endswith((".html", "/")):
                        val = b"public, max-age=31536000, immutable"
                    else:
                        val = b"no-cache"      # revalida (ETag/Last-Modified → 304, barato)
                    msg["headers"] = list(msg["headers"]) + [(b"cache-control", val)]
            await send(msg)

        return await self.app(scope, receive, _send)
