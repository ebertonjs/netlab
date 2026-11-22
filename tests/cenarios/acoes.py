"""Ações v4.1 contra um MikroTik e um DVR falsos (servidores HTTP locais) e um Telegram falso."""
import json, os, sys, threading, time, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.getcwd())
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))

ST = {"ifaces": [
    {".id": "*1", "name": "ether1", "type": "ether", "comment": "WAN ONU", "running": "true", "disabled": "false"},
    {".id": "*2", "name": "ether2", "type": "ether", "comment": "Roteador sala", "running": "true", "disabled": "false"},
    {".id": "*3", "name": "ether3", "type": "ether", "comment": "Raspberry", "running": "true", "disabled": "false"},
    {".id": "*4", "name": "ether4", "type": "ether", "comment": "AP quarto", "running": "true", "disabled": "false"},
    {".id": "*5", "name": "bridge", "type": "bridge", "comment": "", "running": "true", "disabled": "false"},
    {".id": "*16", "name": "PPOE OPERADORA", "type": "pppoe-out", "comment": "", "running": "true", "disabled": "false"}],
    "sched": [], "reboots": 0, "calls": [], "dvr_reboot": 0}
SERVER_MAC = "AA:BB:CC:00:11:22"


class MT(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0); return json.loads(self.rfile.read(n) or b"{}")
    def do_GET(self):
        p = self.path.split("/rest/", 1)[-1]
        ST["calls"].append(("GET", p))
        if p == "interface": return self._j(200, ST["ifaces"])
        if p == "interface/pppoe-client": return self._j(200, [{".id": "*6", "name": "PPOE OPERADORA", "running": "true", "disabled": "false"}])
        if p == "ip/arp": return self._j(200, [{"address": SRV_IP, "mac-address": SERVER_MAC, "interface": "bridge"}])
        if p == "interface/bridge/host": return self._j(200, [{"mac-address": SERVER_MAC, "on-interface": "ether3", "interface": "bridge"}])
        if p == "system/scheduler": return self._j(200, ST["sched"])
        if p == "system/resource": return self._j(200, {"uptime": "10s"})
        return self._j(404, {"detail": "no such command"})
    def do_PATCH(self):
        p = self.path.split("/rest/", 1)[-1]; b = self._body(); ST["calls"].append(("PATCH", p, b))
        if "%2A" in p or "%2a" in p:             # igual ao RouterOS: ID codificado não é reconhecido
            return self._j(400, {"error": 400, "message": "Bad Request", "detail": "missing or invalid resource identifier"})
        iid = p.split("/")[-1]
        for i in ST["ifaces"]:
            if i[".id"] == iid:
                i["disabled"] = b.get("disabled", i["disabled"])
                i["running"] = "false" if i["disabled"] == "true" else "true"
        return self._j(200, {})
    def do_PUT(self):
        p = self.path.split("/rest/", 1)[-1]; b = self._body(); ST["calls"].append(("PUT", p, b))
        if p == "system/scheduler":
            b[".id"] = f"*S{len(ST['sched'])}"; ST["sched"].append(b); return self._j(200, b)
        return self._j(404, {})
    def do_DELETE(self):
        p = self.path.split("/rest/", 1)[-1]; ST["calls"].append(("DELETE", p))
        if "%2A" in p or "%2a" in p:
            return self._j(400, {"error": 400, "detail": "missing or invalid resource identifier"})
        sid = p.split("/")[-1]; ST["sched"] = [s for s in ST["sched"] if s[".id"] != sid]
        return self._j(200, {})
    def do_POST(self):
        p = self.path.split("/rest/", 1)[-1]; ST["calls"].append(("POST", p))
        if p == "system/reboot": ST["reboots"] += 1; return self._j(200, {})
        return self._j(404, {})


class DVR(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if "magicBox.cgi?action=reboot" in self.path:
            ST["dvr_reboot"] += 1; b = b"OK"
        elif "snapshot.cgi" in self.path:
            ch = re.search(r"channel=(\d+)", self.path).group(1); b = b"\xff\xd8JPEG" + ch.encode() + b"\xff\xd9"
            self.send_response(200); self.send_header("Content-Type", "image/jpeg"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        else:
            b = b"Error"
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


mt = ThreadingHTTPServer(("127.0.0.1", 0), MT); threading.Thread(target=mt.serve_forever, daemon=True).start()
dv = ThreadingHTTPServer(("127.0.0.1", 0), DVR); threading.Thread(target=dv.serve_forever, daemon=True).start()

from netnoc.nucleo import db
db.init_db()
_db_get = db.get_meta
from netnoc.coleta import monitor
from netnoc.bot import actions, aibot
from netnoc.integracoes import dvr
SRV_IP = actions._server_ip()
monitor.set_mikrotik(dict(monitor.get_mikrotik(), enabled=True, host="127.0.0.1", port=mt.server_port, use_https=False,
                          username="netnoc", password="x"))
dvr.save_cfg({"enabled": True, "host": "127.0.0.1", "http_port": dv.server_port, "username": "admin", "password": "x", "channels": 3,
              "names": {"1": "Portão", "2": "Garagem", "3": "Quintal"}}) if hasattr(dvr, "save_cfg") else None
from netnoc.nucleo import security as _sec
_c = _sec.load_secret_cfg("dvr", dvr.DEFAULTS, dvr.SECRET); _c["names"] = {"1": "Portão", "2": "Garagem", "3": "Quintal"}
_sec.save_secret_cfg("dvr", _c, dvr.SECRET)
security_cfg = monitor.set_telegram if hasattr(monitor, "set_telegram") else None
monitor.set_telegram(True, "123:TOKEN", "999", "Alta") if security_cfg else None

SENT = []
aibot._tg = lambda token, method, http_timeout=30, **kw: SENT.append((method, kw)) or {"ok": True, "result": []}
PHOTOS = []
class _R:
    ok = True
aibot.requests.post = lambda url, data=None, files=None, timeout=None: PHOTOS.append((url.rsplit("/", 1)[-1], data, sorted((files or {}).keys()))) or _R()
actions.time.sleep = lambda s: None          # sem esperas no teste

cfg = aibot.get_cfg()
aibot.set_cfg(dict(cfg, actions=True, actions_ports=False, actions_reboot=False))
CH = "999"
t, kb = aibot.propose(CH, "port_off", ("roteador", None))
ok(kb is None and "desativado" in t, "portas desligadas na configuração: recusa")
aibot.set_cfg(dict(aibot.get_cfg(), actions_ports=True, actions_reboot=True, revert_min=5, restart_all=["mikrotik", "dvr"]))

# ---- achar porta pelo comentário
ok(actions.find_iface("a porta do roteador")["name"] == "ether2", "acha 'a porta do roteador' pelo comentário")
ok(actions.find_iface("pppoe")["name"] == "PPOE OPERADORA", "'pppoe' = conexão de internet")
ok(actions.find_iface("ETHER4")["name"] == "ether4", "nome sem diferenciar maiúsculas")
try: actions.find_iface("impressora"); ok(False, "porta inexistente")
except actions.ActionError as e: ok("Portas:" in str(e), "porta inexistente lista as portas")

# ---- proteções
t, kb = aibot.propose(CH, "port_off", ("raspberry", None)); ok(kb is None and "servidor do NetNOC" in t, f"recusa a porta do servidor: {t}")
t, kb = aibot.propose(CH, "port_off", ("bridge", None)); ok(kb is None and "bridge" in t, "recusa a bridge")
t, kb = aibot.propose(CH, "port_off", ("pppoe", 0)); ok(kb and "Fica desligada até você pedir" in t and "Telegram" not in t and "este chat para" in t, f"PPPoE sem volta: avisa que o chat para {t!r}")
aibot.set_cfg(dict(aibot.get_cfg(), revert_min=0))
t, kb = aibot.propose(CH, "port_off", ("pppoe", None)); ok(kb and "Fica desligada" in t, "padrão 0 = não religa")
aibot.set_cfg(dict(aibot.get_cfg(), revert_min=5))

# ---- desligar a porta do roteador por 10 min (fluxo do botão Sim)
t, kb = aibot.propose(CH, "port_off", ("roteador", 10)); ok(kb and "10 min" in t, "proposta com 10 min")
tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "1", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 7, "text": t}})
e2 = next(i for i in ST["ifaces"] if i["name"] == "ether2")
ok(e2["disabled"] == "true", "ether2 desligada")
ok(len(ST["sched"]) == 1 and ST["sched"][0]["interval"] == "10m" and 'enable [find name="ether2"]' in ST["sched"][0]["on-event"]
   and "scheduler remove" in ST["sched"][0]["on-event"], f"volta automática agendada no MikroTik {ST['sched']}")
sch_i = [c for c in ST["calls"] if c[0] == "PUT"][0]; pat_i = [k for k, c in enumerate(ST["calls"]) if c[0] == "PATCH"][0]
ok(ST["calls"].index(sch_i) < pat_i, "agenda ANTES de desligar")
ok("desligada" in SENT[-1][1]["text"] and "Religa sozinha em 10 min" in SENT[-1][1]["text"], "resposta no Telegram")
# ---- religar cancela o agendamento
t, kb = aibot.propose(CH, "port_on", ("ether2", None)); tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "2", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 8, "text": t}})
ok(e2["disabled"] == "false" and not ST["sched"], "religar liga e cancela a volta agendada")

# ---- reiniciar tudo (MikroTik + DVR), ordem DVR → MikroTik
t, kb = aibot.propose(CH, "reboot_all"); ok(kb and t.index("DVR") < t.index("MikroTik"), f"plano em ordem: {t!r}")
tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "3", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 9, "text": t}})
_ev = threading.Event()
for _ in range(50):
    if any(m == "sendMessage" and "MikroTik voltou" in kw.get("text", "") for m, kw in SENT): break
    _ev.wait(0.1)
ok(ST["reboots"] == 1 and ST["dvr_reboot"] == 1, f"MikroTik e DVR reiniciados ({ST['reboots']}, {ST['dvr_reboot']})")
ok(any(m == "sendMessage" and "MikroTik voltou" in kw.get("text", "") for m, kw in SENT), "avisa quando o MikroTik volta")
# servidor sem sudo: recusa com instrução
aibot.set_cfg(dict(aibot.get_cfg(), restart_all=["servidor"]))
_cs = actions.can_sudo; actions.can_sudo = lambda *a: False
t, kb = aibot.propose(CH, "reboot_all"); ok(kb is None and "--permitir-reinicio" in t, "servidor sem permissão: explica como liberar")
actions.can_sudo = lambda *a: True
t, kb = aibot.propose(CH, "reboot_all"); ok(kb and "servidor" in t, "com permissão: propõe reiniciar o servidor")
CMDS = []
actions._sudo = lambda *c: CMDS.append(c) or True
tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "4", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 10, "text": t}})
for _ in range(50):
    if CMDS: break
    threading.Event().wait(0.1)
ok(CMDS == [("systemctl", "reboot")] and json.loads(_db_get("restart_notice"))["kind"] == "reboot_pi", f"reinicia o servidor e deixa o aviso {CMDS}")
aibot._restart_notice()
ok(any("O servidor voltou" in kw.get("text", "") for m, kw in SENT), "na volta, avisa no Telegram")
actions.can_sudo = _cs

# ---- câmeras
aibot._ctx.chat = CH
r = aibot.tool_cameras(None); ok(PHOTOS and PHOTOS[-1][0] == "sendMediaGroup" and len(PHOTOS[-1][2]) == 3, f"todas as câmeras em álbum {r}")
r = aibot.tool_cameras("portao"); ok(PHOTOS[-1][0] == "sendPhoto" and "Portão" in PHOTOS[-1][1]["caption"], "câmera pelo nome (sem acento)")
r = aibot.tool_cameras("9"); ok("erro" in r and "Câmeras:" in r["erro"], "câmera inexistente lista as câmeras")

# ---- comandos
ok("ether2 (Roteador sala)" in aibot.handle("/portas", CH), "/portas")
r = aibot.handle("/desligar ap quarto 3", CH); ok(isinstance(r, tuple) and "ether4" in r[0] and "3 min" in r[0], "/desligar ap quarto 3")
r = aibot.handle("/reiniciar roteador", CH); ok(isinstance(r, tuple) and "MikroTik" in r[0], "/reiniciar roteador")
ok(aibot.handle("/cameras quintal", CH) == "📷 Enviado." and PHOTOS[-1][0] == "sendPhoto", "/cameras quintal")
# ---- IA: a ferramenta acao com porta
r = aibot.tool_acao("desligar_porta", porta="pppoe"); ok("confirmação" in r.get("status", ""), "IA pede confirmação para desligar o PPPoE")
r = aibot.tool_acao("reiniciar_tudo"); ok("erro" in r or "confirmação" in r.get("status", ""), "IA reiniciar_tudo")
names = [n for n, *_ in aibot.TOOLS]; ok("cameras" in names and "portas" in names, "ferramentas novas na IA")
from netnoc.nucleo import db as _db
ok(any("acao:port_off" in (a["action"] or "") for a in _db.query("SELECT action FROM audit_log")), "auditado")
# ---- tela: ligar/desligar pela rede local
from netnoc.nucleo import security as _secm
_secm.AUTH_OFF = True                      # o módulo já foi carregado com o login ligado
from fastapi.testclient import TestClient
from netnoc.web.app import app
c = TestClient(app); H = {"x-netnoc": "1"}
ports = c.get("/api/mikrotik/ports").json()
ok(any(p["name"] == "ether3" and p["server"] for p in ports) and any(p["name"] == "PPOE OPERADORA" and p["wan"] for p in ports), "lista portas com servidor e internet marcados")
r = c.post("/api/mikrotik/ports", json={"name": "PPOE OPERADORA", "enabled": False}, headers=H)
pp = next(i for i in ST["ifaces"] if i["name"] == "PPOE OPERADORA")
ok(r.status_code == 200 and pp["disabled"] == "true" and "Winbox" in r.json()["message"], "desliga o PPPoE pela tela, sem volta")
r = c.post("/api/mikrotik/ports", json={"name": "PPOE OPERADORA", "enabled": True}, headers=H)
ok(r.status_code == 200 and pp["disabled"] == "false", "religa o PPPoE pela tela")
r = c.post("/api/mikrotik/ports", json={"name": "ether3", "enabled": False}, headers=H)
ok(r.status_code == 400 and "servidor" in r.text, "tela também protege a porta do servidor")
print("TUDO OK")
