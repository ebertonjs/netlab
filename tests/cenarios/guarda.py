"""v4.2 rede de segurança: backup no Telegram, restauração, /healthz, vigia externo e MikroTik com certificado fixado."""
import io, json, os, shutil, ssl, subprocess, sys, tarfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.getcwd())
os.environ["NETNOC_AUTH"] = "on"
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))
AQUI = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(AQUI, "..", "..", "collector", "tests", "fixtures")

from netnoc.nucleo import db, security, guarda, tlspin, cofre
db.init_db()
from netnoc.coleta import monitor
monitor.set_telegram(True, "123:TOKEN", "999", "Alta")

# ---------------------------------------------------------------- Telegram falso
SENT = []
class _R:
    def __init__(s, ok=True, code=200): s.ok, s.status_code = ok, code
    def json(s): return {"ok": s.ok, "description": "" if s.ok else "Bad Request: chat not found"}
TG_OK = [True]
def fake_post(url, data=None, files=None, timeout=None):
    SENT.append((url.rsplit("/", 1)[-1], data, files))
    if "hc-ping" in url:
        return _R(True)
    return _R(TG_OK[0], 200 if TG_OK[0] else 400)
guarda.requests.post = fake_post

# ---------------------------------------------------------------- backup
security.set_user("admin", "senha-admin-1", "admin")
monitor.set_mikrotik(dict(monitor.get_mikrotik(), host="10.0.0.1", username="u", password="segredo-mt"))
name, data = guarda.build()
tar = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
names = set(tar.getnames())
ok({"netnoc.db", "config.json", "netnoc-backup.json", "LEIA-ME.txt"} <= names, f"conteúdo do backup {sorted(names)}")
ok(not any(n.endswith(".key") for n in names) and "netnoc-historico.db" not in names, "sem chave e sem histórico por padrão")
exp = json.load(tar.extractfile("netnoc-backup.json"))
ok(exp["settings"]["mikrotik"]["password"] == "", "JSON do backup sem senha")
raw_db = tar.extractfile("netnoc.db").read()
ok(b"segredo-mt" not in raw_db and b"enc:v1:" in raw_db, "senhas cifradas dentro do netnoc.db do backup")
_, d2 = guarda.build(include_hist=True)
ok("netnoc-historico.db" in tarfile.open(fileobj=io.BytesIO(d2), mode="r:gz").getnames(), "histórico entra quando pedido")

r = guarda.run_backup("teste")
doc = [s for s in SENT if s[0] == "sendDocument"]
ok(r["ok"] and doc and doc[-1][1]["chat_id"] == "999" and doc[-1][2]["document"][0].startswith("netnoc-backup-"), f"enviado ao Telegram {r}")
ok("chave netnoc.key fica fora" in doc[-1][1]["caption"], "legenda lembra da chave")
ok(json.loads(db.get_meta("backup_last"))["ok"], "resultado guardado")
TG_OK[0] = False
r = guarda.run_backup("teste")
ok(not r["ok"] and "chat not found" in r["error"] and "TOKEN" not in r["error"], f"falha do Telegram explicada, sem token: {r['error']}")
TG_OK[0] = True

# ---------------------------------------------------------------- horário do backup diário
guarda.set_cfg(dict(guarda.get_cfg(), backup_time="03:30"))
lt = time.localtime()
def at(h, m):
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, h, m, 0, 0, 0, -1))
db.set_meta("backup_last", json.dumps({"ts": at(3, 31) - 86400, "ok": True}))
ok(not guarda._due(guarda.get_cfg(), at(3, 0)), "antes do horário: não")
ok(guarda._due(guarda.get_cfg(), at(3, 40)), "depois do horário, sem backup hoje: sim")
db.set_meta("backup_last", json.dumps({"ts": at(3, 31), "ok": True}))
ok(not guarda._due(guarda.get_cfg(), at(9, 0)), "já feito hoje: não")
db.set_meta("backup_last", json.dumps({"ts": at(3, 31), "ok": False}))
ok(not guarda._due(guarda.get_cfg(), at(3, 50)) and guarda._due(guarda.get_cfg(), at(5, 0)), "falhou: tenta de novo 1 h depois")
guarda.set_cfg(dict(guarda.get_cfg(), backup_enabled=False))
ok(not guarda._due(guarda.get_cfg(), at(5, 0)), "desligado: não")
for bad in ({"backup_time": "25:00"}, {"hc_url": "http://hc-ping.com/x"}, {"hc_url": "https://x.com/a b"}):
    try:
        guarda.set_cfg(dict(guarda.get_cfg(), **bad)); ok(False, f"aceitou {bad}")
    except ValueError:
        ok(True, f"recusa {bad}")

# ---------------------------------------------------------------- saúde
okh, det = guarda.health()
ok(okh and det["problems"] == [], "saudável")
monitor._started = True
guarda._STARTED = time.time() - 3600
with monitor._hlock:
    monitor._health.update({"ping": {"interval": 1, "last_run": time.time()}, "rollup": {"interval": 60, "last_run": time.time()},
                            "sistema": {"interval": 15, "last_run": time.time() - 900}})
okh, det = guarda.health()
ok(not okh and det["problems"] == ["laço 'sistema' parado"], f"laço preso detectado {det}")

# ---------------------------------------------------------------- vigia externo
guarda.set_cfg(dict(guarda.get_cfg(), hc_url="https://hc-ping.com/abc-123"))
ok("hc-ping" not in db.get_setting("guarda"), "URL do vigia cifrada no banco")
ok(any(r["key"] == "guarda" and r["state"] == "cifrado" for r in cofre.inventory()["items"]), "vigia no inventário de segredos")
SENT.clear()
guarda._tick()
ok(SENT and SENT[-1][0] == "fail" and "sistema" in SENT[-1][1].decode(), f"com problema avisa /fail {SENT[-1:]}")
with monitor._hlock:
    monitor._health["sistema"]["last_run"] = time.time()
guarda._tick()
ok(SENT[-1][0] == "abc-123" and guarda.hc_status()["ok"], "saudável: ping normal")

# ---------------------------------------------------------------- HTTP
from fastapi.testclient import TestClient
from netnoc.web.app import app
c = TestClient(app)
H = {"origin": "http://testserver", "x-netnoc": "1"}
r = c.get("/healthz"); ok(r.status_code == 200 and r.json()["ok"], "/healthz 200 sem login")
with monitor._hlock:
    monitor._health["ping"]["last_run"] = time.time() - 600
r = c.get("/healthz"); ok(r.status_code == 503 and "ping" in r.text, "/healthz 503 quando um laço parou")
with monitor._hlock:
    monitor._health["ping"]["last_run"] = time.time()
ok(c.get("/api/settings/guarda").status_code in (401, 403), "config do vigia exige login")
c.post("/api/login", json={"user": "admin", "password": "senha-admin-1"}, headers=H)
g = c.get("/api/settings/guarda").json()
ok(g["hc_url"] == security.MASK and g["telegram_ok"] and g["last_backup"], f"GET mascara a URL {g['hc_url']!r}")
r = c.post("/api/settings/guarda", json={"backup_enabled": True, "backup_time": "04:10", "backup_hist": False, "hc_url": security.MASK}, headers=H)
ok(r.status_code == 200 and guarda.get_cfg()["hc_url"] == "https://hc-ping.com/abc-123" and guarda.get_cfg()["backup_time"] == "04:10", "salvar com máscara mantém a URL")
ok(c.post("/api/settings/guarda", json={"backup_time": "4h"}, headers=H).status_code == 400, "horário inválido: 400")
r = c.post("/api/backup/run", headers=H); ok(r.status_code == 200 and r.json()["size"] > 1000, "backup manual pela tela")
security.set_user("leitor", "senha-leitor", "viewer")
v = TestClient(app); v.post("/api/login", json={"user": "leitor", "password": "senha-leitor"}, headers=H)
ok(v.get("/api/settings/guarda").status_code == 403 and v.post("/api/backup/run", headers=H).status_code == 403, "visualizador não mexe")

# ---------------------------------------------------------------- bot
from netnoc.bot import aibot
SENT.clear()
ok("Gerando" in aibot.handle("/backup", "999"), "/backup responde")
for _ in range(50):
    if any(s[0] == "sendDocument" for s in SENT): break
    time.sleep(0.1)
ok(any(s[0] == "sendDocument" for s in SENT), "/backup manda o arquivo")
s = aibot.handle("/saude", "999"); ok("saudável" in s and "Último backup" in s and "Vigia externo" in s, f"/saude {s!r}")

# ---------------------------------------------------------------- MikroTik por HTTPS com certificado fixado
class MT(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = json.dumps([{"mac-address": "AA:BB:CC:00:00:01", "address": "10.0.0.9", "host-name": "pc", "status": "bound"}]).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
def tls_server(cert, keyder):
    kp = os.path.join(os.getcwd(), os.path.basename(keyder) + ".pem")
    subprocess.run(["openssl", "pkcs8", "-inform", "DER", "-nocrypt", "-in", keyder, "-out", kp], check=True)
    s = ThreadingHTTPServer(("127.0.0.1", 0), MT)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, kp)
    s.socket = ctx.wrap_socket(s.socket, server_side=True)
    s.handle_error = lambda *a: None
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s.server_port
p_ok = tls_server(os.path.join(FIX, "cert.pem"), os.path.join(FIX, "key.der"))
p_mal = tls_server(os.path.join(FIX, "outro.pem"), os.path.join(FIX, "outro-key.der"))
r = c.post("/api/settings/mikrotik/cert", json={"host": "127.0.0.1", "port": p_ok}, headers=H)
fp = r.json()["sha256"]
ok(r.status_code == 200 and len(fp) == 64 and r.json()["pretty"].count(":") == 31, "lê a impressão digital")
base = {"enabled": True, "host": "127.0.0.1", "port": p_ok, "use_https": True, "username": "netnoc", "password": "x"}
ok(c.post("/api/settings/mikrotik", json=dict(base, cert_sha256="abc"), headers=H).status_code == 400, "impressão digital inválida: 400")
r = c.post("/api/settings/mikrotik", json=dict(base, cert_sha256=r.json()["pretty"]), headers=H)
ok(r.status_code == 200 and monitor.get_mikrotik()["cert_sha256"] == fp, "salva normalizada (formato AB:CD aceito)")
ok(len(monitor.fetch_dhcp_leases()) == 1, "coleta pelo HTTPS com o certificado fixado")
monitor.set_mikrotik(dict(monitor.get_mikrotik(), port=p_mal))
try:
    monitor.fetch_dhcp_leases(); ok(False, "aceitou o impostor")
except Exception as e:
    ok("mudou" in monitor._safe_err(e), f"outro certificado recusado: {monitor._safe_err(e)}")
r = c.post("/api/settings/mikrotik/test", headers=H)
ok(r.status_code == 400 and "certificado mudou" in r.text and "127.0.0.1" not in r.text, f"teste da tela explica {r.text}")
from netnoc.bot import actions
try:
    actions._mt("GET", "interface"); ok(False, "ação aceitou o impostor")
except actions.ActionError as e:
    ok("certificado do MikroTik recusado" in str(e), f"ações também recusam: {e}")

# ---------------------------------------------------------------- manage.py backup/restaurar
env = {k: v for k, v in os.environ.items() if not k.startswith("NETNOC_")}
py = sys.executable
out = subprocess.run([py, "manage.py", "backup"], capture_output=True, text=True, env=env)
arq = out.stdout.split(" ")[0]
ok(out.returncode == 0 and os.path.exists(arq), f"manage.py backup: {out.stdout.strip()[:80]}")
monitor.set_app_name("Mudado depois")
out = subprocess.run([py, "manage.py", "restaurar", arq], capture_output=True, text=True, env=env)
ok(out.returncode == 1 and "--yes" in out.stdout, "restaurar pede confirmação")
out = subprocess.run([py, "manage.py", "restaurar", arq, "--yes"], capture_output=True, text=True, env=env)
ok(out.returncode == 0 and "netnoc.db restaurado" in out.stdout and "ATENÇÃO" not in out.stdout, f"restaura {out.stdout[-200:]}")
ok(any(f.startswith("netnoc.db.antes-") for f in os.listdir(".")), "guarda o banco anterior")
chk = subprocess.run([py, "-c", "from netnoc.nucleo import db; db.init_db(); from netnoc.coleta import monitor as m; "
                      "print(m.get_app_name(), m.get_mikrotik()['password'])"], capture_output=True, text=True, env=env)
ok(chk.stdout.split()[-1] == "x" and "Mudado" not in chk.stdout, f"configuração e senha de volta: {chk.stdout.strip()} {chk.stderr[-200:]}")
os.rename("netnoc.key", "netnoc.key.velha")
out = subprocess.run([py, "manage.py", "restaurar", arq, "--yes"], capture_output=True, text=True, env=env)
ok("ATENÇÃO" in out.stdout and "MikroTik" in out.stdout, "chave diferente: avisa quais senhas não abrem")
os.replace("netnoc.key.velha", "netnoc.key")
bad = tarfile.open("ruim.tar.gz", "w:gz"); i = tarfile.TarInfo("../fora"); i.size = 1; bad.addfile(i, io.BytesIO(b"x")); bad.close()
out = subprocess.run([py, "manage.py", "restaurar", "ruim.tar.gz", "--yes"], capture_output=True, text=True, env=env)
ok(out.returncode == 1 and not os.path.exists("../fora"), "arquivo estranho recusado")
print("TUDO OK")
