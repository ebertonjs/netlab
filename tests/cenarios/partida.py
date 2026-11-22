"""O NetNOC sobe de verdade (startup completo, laços de coleta rodando) e nenhuma rota GET da API dá erro 5xx.
Pega o tipo de erro que os outros cenários não veem: nome indefinido dentro de um laço ou de uma rota pouco usada."""
import os, sys, time
sys.path.insert(0, os.getcwd())
os.environ["NETNOC_AUTH"] = "off"
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))
from netnoc.coleta import monitor
from netnoc.web.app import app, startup
from fastapi.testclient import TestClient
startup()
time.sleep(12)
with monitor._hlock:
    hs = {k: dict(v) for k, v in monitor._health.items()}
for name in ("ping", "sistema", "dns", "ip_publico"):
    h = hs.get(name) or {}
    ok(h.get("runs", 0) >= 1, f"laço '{name}' rodou ({h.get('runs')})")
    err = h.get("error") or ""
    ok(not any(x in err for x in ("NameError", "AttributeError", "TypeError", "ImportError")), f"laço '{name}' sem erro de código: {err!r}")
c = TestClient(app)
bad = []
for r in app.routes:
    p, ms = getattr(r, "path", ""), getattr(r, "methods", set()) or set()
    if "GET" not in ms or not p.startswith("/api") or "{" in p or "stream" in p:
        continue
    q = c.get(p)
    if q.status_code >= 500:
        bad.append((p, q.status_code, q.text[:100]))
ok(not bad, f"nenhuma rota GET com erro 5xx {bad}")
ok(c.get("/healthz").json()["ok"], "/healthz ok")
ok(c.get("/").status_code == 200, "página inicial abre")
print("TUDO OK")
