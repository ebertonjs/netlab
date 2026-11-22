import json, os, stat, sys, time
os.environ["NETNOC_AUTH"] = "on"
sys.path.insert(0, os.getcwd())
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))
from netnoc.nucleo import db, security, backup, cofre
db.init_db()
from netnoc.coleta import monitor
# ---------------- migração já testada no servidor de demonstração; aqui: backup de versões antigas
old = {"format": "netnoc-backup", "version": 2, "settings": {
    "targets": [{"name": "A", "host": "8.8.8.8"}, {"name": "Ag", "host": "1.2.3.4", "type": "agent", "sites": ["x"]},
                {"name": "B", "host": "1.1.1.1", "parent": "Ag", "sites": ["x"]}],
    "zabbix": {"enabled": True, "url": "http://z"}, "snmp_devices": [{"name": "OLT"}], "speedtest_auto": {"enabled": True, "time": "04:30"},
    "ui_default": {"skin": "terminal", "mode": "ambar", "accent": "#6750a4"}}}
ap = backup.import_cfg(old)
ts = monitor.get_targets()
ok([t["name"] for t in ts] == ["A", "B"] and all("sites" not in t and "parent" not in t for t in ts), f"backup antigo: agente fora, pai órfão solto {ts}")
ok(json.loads(db.get_setting("ui_default"))["skin"] == "pro", "tema antigo do backup vira Pro")
ok(db.get_setting("zabbix") is None and db.get_setting("snmp_devices") is None, "Zabbix/SNMP do backup ignorados")
ex = backup.export_cfg()["settings"]
ok(not {"zabbix", "snmp_devices", "speedtest_auto"} & set(ex), "export sem as chaves removidas")
# ---------------- pico da WAN + portas
now = time.time()
rows = []
for i in range(120):
    t = now - i * 60
    rows += [(t, "pppoe-out1", 1, 0, 0, 0, 50e6 + i * 1e5, 5e6), (t, "ether1", 1, 0, 0, 0, 51e6, 6e6)]
rows.append((now - 3600, "pppoe-out1", 1, 0, 0, 0, 180e6, 20e6))
db.executemany("INSERT INTO mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?,?,?,?,?,?,?,?)", rows)
from netnoc.nucleo import stats; stats.cache_clear()
ok(monitor.wan_iface() == "pppoe-out1", "WAN descoberta: PPPoE primeiro")
pk = monitor.wan_peak(86400)
ok(pk and pk["rx_bps"] == 180e6 and abs(pk["rx_ts"] - (now - 3600)) < 1, f"pico de hoje {pk and pk['rx_bps']}")
monitor.set_mikrotik(dict(monitor.get_mikrotik(), wan_iface="ether1"))
ok(monitor.wan_iface() == "ether1", "porta WAN escolhida pelo usuário vale")
monitor.set_mikrotik(dict(monitor.get_mikrotik(), wan_iface=""))
# ---------------- limpeza v4 das portas paradas e pings de agente
db.executemany("INSERT INTO mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?,?,?,?,?,?,?,?)",
               [(now - 3 * 86400 - i, "wlan2", 0, 1, 0, 0, 0, 0) for i in range(500)] + [(now - 60, "ether5", 0, 0, 0, 0, 0, 0)])
db.executemany("INSERT INTO pings(ts,target,latency,success) VALUES(?,?,?,?)", [(now - i, "X@filial", 5, 1) for i in range(300)])
db.execute("DELETE FROM meta WHERE key='v4_iface_cleanup'")
monitor.prune_once()
ok(db.query("SELECT COUNT(*) n FROM mikrotik_iface WHERE name='wlan2'")[0]["n"] == 0, "porta desativada antiga apagada")
ok(db.query("SELECT COUNT(*) n FROM mikrotik_iface WHERE name='ether5'")[0]["n"] == 1, "estado recente de porta parada mantido")
ok(db.query("SELECT COUNT(*) n FROM pings WHERE target LIKE '%@%'")[0]["n"] == 0, "pings de agente apagados")
# ---------------- coletores sem nada configurado não aparecem
monitor._health.update({"certificados": {"interval": 21600, "last_run": now, "runs": 1}, "mikrotik": {"interval": 60, "last_run": now, "runs": 1}})
names = {w["name"] for w in monitor.worker_health()}
ok("certificados" not in names and "mikrotik" not in names, f"coletores ociosos escondidos {names}")
# ---------------- HTTP
security.set_user("admin", "senha-admin-1", "admin"); security.set_user("leitor", "senha-leitor", "viewer")
from fastapi.testclient import TestClient
from netnoc.web.app import app
H = {"origin": "http://testserver", "x-netnoc": "1"}
c = TestClient(app)
ok(c.post("/api/login", json={"user": "admin", "password": "senha-admin-1"}, headers=H).status_code == 200, "login")
for m, p in [("get", "/api/zabbix/problems"), ("get", "/api/settings/snmp"), ("get", "/api/sites"), ("post", "/api/speedtest/run"),
             ("get", "/api/speedtest/history"), ("get", "/api/agent/config?site=x"), ("get", "/api/story"), ("get", "/api/bandwidth")]:
    r = getattr(c, m)(p, headers=H)
    ok(r.status_code in (404, 405), f"removida {p} -> {r.status_code}")
r = c.get("/classic", follow_redirects=False); ok(r.status_code == 302 and r.headers["location"] == "/", "/classic redireciona")
w = c.get("/api/wan/peak").json(); ok(w["today"]["rx_bps"] == 180e6 and w["iface"] == "pppoe-out1", "/api/wan/peak")
hm = c.get("/api/home").json(); ok(hm["kpi"]["wan_peak"]["rx_bps"] == 180e6 and "speedtest" not in hm["kpi"], "/api/home com pico da WAN")
ok("speedtest" not in c.get("/api/overview").json(), "overview sem speedtest")
r = c.post("/api/settings/mikrotik", json={"enabled": False, "host": "10.0.0.1", "port": 443, "username": "u", "wan_iface": "pppoe-out1"}, headers=H)
ok(r.status_code == 200 and monitor.get_mikrotik()["wan_iface"] == "pppoe-out1", "salva porta WAN")
ok(c.post("/api/settings/mikrotik", json={"enabled": False, "host": "10.0.0.1", "port": 443, "wan_iface": "a;rm"}, headers=H).status_code == 400, "porta WAN inválida recusada")
ok(c.post("/api/settings/ui", json={"skin": "lagoa", "mode": "noite"}, headers=H).status_code == 400, "tema removido recusado")
ok(c.post("/api/settings/ui", json={"skin": "pro", "mode": "auto"}, headers=H).status_code == 200, "modo automático aceito")
r = c.get("/api/backup"); ok(r.status_code == 200 and "zabbix" not in r.text, "backup baixa")
r = c.post("/api/restore", json=r.json(), headers=H); ok(r.status_code == 200, f"restaura o próprio backup {r.text[:80]}")
r = c.post("/api/settings/notify", json={"min_severity": "Media", "discord": {"enabled": False, "webhook_url": ""},
     "webhook": {"enabled": False, "url": "", "secret": ""}, "email": {"enabled": False, "host": "", "port": 587, "user": "", "password": "", "sender": "", "to": "", "starttls": True}}, headers=H)
ok(r.status_code == 200 and c.get("/api/settings/notify").json()["min_severity"] == "Media", "outros canais salvam")
ok(c.post("/api/users", json={"name": "joao", "password": "12345678", "role": "viewer"}, headers=H).status_code == 200, "cria usuário")
ok(any(u["name"] == "joao" for u in c.get("/api/users").json()), "lista usuários")
ok(c.delete("/api/users/joao", headers=H).status_code == 200, "remove usuário")
ok("token" in c.post("/api/settings/metrics-token", headers=H).json(), "token do /metrics")
inv = c.get("/api/security/secrets").json(); ok(all(i["key"] not in ("zabbix", "snmp_devices") for i in inv["items"]), "inventário sem Zabbix/SNMP")
v = TestClient(app); v.post("/api/login", json={"user": "leitor", "password": "senha-leitor"}, headers=H)
ok(v.post("/api/me/prefs", json={"home": {"order": ["dns"]}}, headers=H).status_code == 200, "visualizador salva a própria arrumação")
ok(v.delete("/api/users/admin", headers=H).status_code == 403, "visualizador não remove usuário")
aud = c.get("/api/audit?user=leitor").json(); ok(any(a["detail"].startswith("negado") for a in aud), "403 auditado")
r = c.get("/", headers={"accept-encoding": "gzip"}); ok("skins/terminal" not in r.text and "util.js?v=" in r.text and 'class="home2"' in r.text, "app.html enxuto e versionado")
for f in ("/style.css", "/index.html", "/js/core.js", "/glass/skins/lagoa.css"):
    ok(c.get(f, follow_redirects=False).status_code in (302, 404), f"arquivo removido {f}")
ok(c.get("/login").status_code in (200, 302), "login abre")
print("TUDO OK")
