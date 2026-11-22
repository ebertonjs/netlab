"""v4.3: Medir agora, syslog do MikroTik e agregado de 5 min das portas."""
import json, os, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.getcwd())
os.environ["NETNOC_AUTH"] = "on"
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))

# ---------------------------------------------------------------- MikroTik falso
ST = {"monitor_ok": True, "rx": 0, "tx": 0, "calls": []}
class MT(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
        ST["calls"].append(("POST", self.path, body))
        if self.path.endswith("/interface/monitor-traffic"):
            if not ST["monitor_ok"]:
                return self._j(400, {"error": 400, "detail": "no such command"})
            return self._j(200, [{"name": body["interface"], "rx-bits-per-second": str(900_000_000 if len(ST["calls"]) % 4 else 940_000_000),
                                  "tx-bits-per-second": "480000000"}])
        return self._j(404, {})
    def do_GET(self):
        ST["calls"].append(("GET", self.path))
        if "/interface?name=" in self.path:
            ST["rx"] += 100_000_000; ST["tx"] += 50_000_000          # ~800 / 400 Mbps por segundo
            return self._j(200, [{"name": "PPOE OPERADORA", "rx-byte": str(ST["rx"]), "tx-byte": str(ST["tx"])}])
        return self._j(200, [])
mt = ThreadingHTTPServer(("127.0.0.1", 0), MT); threading.Thread(target=mt.serve_forever, daemon=True).start()

from netnoc.nucleo import db, security, stats
db.init_db()
from netnoc.coleta import monitor, medir, syslog
monitor.set_mikrotik(dict(monitor.get_mikrotik(), enabled=True, host="127.0.0.1", port=mt.server_port, use_https=False,
                          username="netnoc", password="x", wan_iface="PPOE OPERADORA", plan_mbps=1000))
monitor.set_telegram(True, "123:TOKEN", "999", "Alta")

# ---------------------------------------------------------------- Medir agora
medir.MIN_S = 2
DONE = []
st = medir.start(3, who="teste", on_done=lambda r, e: DONE.append((r, e)))
ok(st["running"] and st["iface"] == "PPOE OPERADORA" and st["seconds"] == 3, f"começou {st['iface']}")
try:
    medir.start(3); ok(False, "deixou duas medições juntas")
except medir.MedirError as e:
    ok("andamento" in str(e), "uma medição por vez")
for _ in range(80):
    if DONE: break
    time.sleep(0.1)
res, err = DONE[0]
ok(err is None and res["method"] == "monitor" and res["n"] >= 2, f"medição pelo monitor-traffic {res}")
ok(res["rx_peak"] == 940e6 or res["rx_peak"] == 900e6, "pico do download")
ok(any(c[0] == "POST" and c[2].get("interface") == "PPOE OPERADORA" and "once" in c[2] for c in ST["calls"]), "pede monitor-traffic once da WAN")
txt = medir.format_text(res, None, 1000)
ok("Download" in txt and "% do contratado" in txt, txt)
ok(medir.history()[0]["iface"] == "PPOE OPERADORA", "guarda no histórico")

ST["monitor_ok"] = False; DONE.clear()
medir.start(3, on_done=lambda r, e: DONE.append((r, e)))
for _ in range(80):
    if DONE: break
    time.sleep(0.1)
res, err = DONE[0]
ok(res and res["method"] == "contadores" and 6e8 < res["rx_top3"] < 1e9, f"sem monitor-traffic: usa os contadores {res and res['rx_top3']}")

monitor.set_mikrotik(dict(monitor.get_mikrotik(), enabled=False))
try:
    medir.start(3); ok(False, "mediu com MikroTik desligado")
except medir.MedirError as e:
    ok("desativada" in str(e), "MikroTik desligado: explica")
monitor.set_mikrotik(dict(monitor.get_mikrotik(), enabled=True))
ok(monitor.WAN_RE.search("PPOE OPERADORA"), "'PPOE OPERADORA' reconhecida como internet")

# ---------------------------------------------------------------- HTTP + bot
security.set_user("admin", "senha-admin-1", "admin")
from fastapi.testclient import TestClient
from netnoc.web.app import app
c = TestClient(app); H = {"origin": "http://testserver", "x-netnoc": "1"}
c.post("/api/login", json={"user": "admin", "password": "senha-admin-1"}, headers=H)
g = c.get("/api/wan/medir").json(); ok(g["plan_mbps"] == 1000 and g["history"], "GET /api/wan/medir")
r = c.post("/api/wan/medir", json={"seconds": 3}, headers=H); ok(r.status_code == 200 and r.json()["running"], "POST inicia")
ok(c.post("/api/wan/medir", json={"seconds": 3}, headers=H).status_code == 400, "segunda ao mesmo tempo: 400")
while medir.state()["running"]:
    time.sleep(0.2)
ok(c.post("/api/settings/mikrotik", json={"enabled": True, "host": "127.0.0.1", "port": mt.server_port, "use_https": False,
                                           "username": "netnoc", "password": "x", "plan_mbps": -5}, headers=H).status_code == 400, "plano negativo: 400")

from netnoc.bot import aibot
SENT = []
aibot._tg = lambda token, method, http_timeout=15, **kw: SENT.append((method, kw)) or {"ok": True, "result": []}
r = aibot.handle("/medir 3", "999"); ok("Rode um speedtest" in r, "/medir responde na hora")
for _ in range(80):
    if any("Medição da internet" in kw.get("text", "") for m, kw in SENT): break
    time.sleep(0.1)
ok(any("Medição da internet" in kw.get("text", "") and kw.get("chat_id") == "999" for m, kw in SENT), "resultado chega no chat")
while medir.state()["running"]:
    time.sleep(0.2)
names = [n for n, *_ in aibot.TOOLS]; ok("medir_velocidade" in names and "log_mikrotik" in names, "ferramentas novas na IA")

# ---------------------------------------------------------------- syslog
for raw, topics, msg in [
    (b"<134>Nov 22 01:31:00 MikroTik pppoe,ppp,info PPOE OPERADORA: terminating... - peer is not responding", "pppoe,ppp,info", "PPOE OPERADORA: terminating... - peer is not responding"),
    (b"system,info,account user admin logged in from 192.168.88.5 via winbox", "system,info,account", "user admin logged in from 192.168.88.5 via winbox"),
    (b"<131>2026-11-22T01:31:00-03:00 MikroTik pppoe,ppp,error PPOE OPERADORA: authentication failed", "pppoe,ppp,error", "PPOE OPERADORA: authentication failed"),
]:
    sev, t, m = syslog.parse(raw)
    ok(t == topics and m == msg, f"parse {t!r} {m!r}")
ok(syslog.parse(b"<131>x,error a")[0] == "error", "severidade pelo PRI/tópico")
ok(syslog.reason("PPOE OPERADORA: authentication failed").startswith("falha de autenticação"), "motivo traduzido")
ok(c.post("/api/settings/syslog", json={"enabled": True, "port": 80}, headers=H).status_code == 400, "porta < 1025: 400")
s0 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
r = c.post("/api/settings/syslog", json={"enabled": True, "port": port}, headers=H)
ok(r.status_code == 200 and r.json()["listening"], f"escutando na {port}")
tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
tx.sendto(b"<134>Nov 22 01:31:00 MikroTik pppoe,ppp,info PPOE OPERADORA: terminating... - peer is not responding", ("127.0.0.1", port))
tx.sendto(b"system,info,account user admin logged in via winbox", ("127.0.0.1", port))
intruso = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); intruso.bind(("127.0.0.2", 0))
intruso.sendto(b"pppoe,ppp,info falso: disconnected", ("127.0.0.1", port))
for _ in range(50):
    if syslog.status()["received"] >= 2 and syslog.status()["ignored"] >= 1: break
    time.sleep(0.1)
stt = syslog.status()
ok(stt["received"] == 2 and stt["ignored"] == 1, f"aceita só o MikroTik {stt}")
rows = c.get("/api/mikrotik/log?topic=pppoe").json()["rows"]
ok(len(rows) == 1 and "peer is not responding" in rows[0]["msg"], "filtro por tópico")
ok(len(c.get("/api/mikrotik/log?q=winbox").json()["rows"]) == 1, "busca por texto")
ok(c.get("/api/mikrotik/log?topic=a;b").status_code == 400, "tópico inválido: 400")
ev = db.query("SELECT message FROM events ORDER BY ts DESC LIMIT 5")
ok(any("operadora parou de responder" in e["message"] for e in ev), f"queda do PPPoE vira evento {[e['message'] for e in ev][:2]}")
lg = syslog.wan_reason_near(time.time())
ok(lg and "operadora" in lg["reason"], "motivo perto do horário (para o diagnóstico)")
t = aibot.handle("/log pppoe", "999"); ok("peer is not responding" in t and "winbox" not in t, "/log pppoe")
ok("winbox" in aibot.handle("/log winbox", "999"), "/log com texto")
ok(aibot.tool_log(topico="account")["linhas"], "ferramenta da IA")
c.post("/api/settings/syslog", json={"enabled": False, "port": port}, headers=H)
ok(not syslog.status()["listening"], "desligar fecha a porta")

# ---------------------------------------------------------------- agregado das portas
now = time.time()
rows = []
for i in range(0, 5 * 86400, 60):                       # 5 dias, 1 linha/min
    ts = now - i
    rows.append((ts, "PPOE OPERADORA", 1, 0, 0, 0, 300e6 if i != 4 * 86400 else 990e6, 50e6))
db.executemany("INSERT INTO mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?,?,?,?,?,?,?,?)", rows)
db.execute("DELETE FROM meta WHERE key='iface5_end'")
for _ in range(3):
    stats.run_rollups()
n5 = db.query("SELECT COUNT(*) n, MAX(rx_max) mx FROM mikrotik_iface_5m WHERE name='PPOE OPERADORA'")[0]
ok(n5["n"] >= 5 * 288 - 2 and n5["mx"] == 990e6, f"5 dias agregados em 5 min ({n5['n']} blocos), pico preservado")
monitor._prune_iface_raw()
old = db.query("SELECT COUNT(*) n FROM mikrotik_iface WHERE ts < ?", (now - 2 * 86400 - 600,))[0]["n"]
ok(old == 0, "bruto com mais de 2 dias apagado")
ok(db.query("SELECT COUNT(*) n FROM mikrotik_iface WHERE ts > ?", (now - 86400,))[0]["n"] > 1000, "último dia continua bruto")
stats.cache_clear()
hist = monitor.get_mikrotik_iface_history("PPOE OPERADORA", 7 * 86400)
ok(hist and "rx_max" in hist[0] and abs(hist[-1]["ts"] - now) < 1800, "semana vem das médias de 5 min")
ok(monitor.wan_peak(7 * 86400)["rx_bps"] == 990e6, "pico da semana acha o máximo já agregado")
ok(monitor.wan_peak(86400)["rx_bps"] == 300e6, "pico de hoje pelo bruto")
print("TUDO OK")
