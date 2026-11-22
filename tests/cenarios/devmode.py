import json, os, sys, time
sys.path.insert(0, os.getcwd())
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "acoes.py"), encoding="utf-8").read().split("cfg = aibot.get_cfg()")[0]
exec(src)
# MikroTik em device-mode home: scheduler bloqueado
_orig_put, _orig_get = MT.do_PUT, MT.do_GET
def put(self):
    if "system/scheduler" in self.path:
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        return self._j(400, {"error": 400, "message": "Bad Request", "detail": "failure: not allowed by device-mode"})
    return _orig_put(self)
def get(self):
    if "system/scheduler" in self.path:
        return self._j(400, {"error": 400, "detail": "failure: not allowed by device-mode"})
    return _orig_get(self)
MT.do_PUT, MT.do_GET = put, get
aibot.set_cfg(dict(aibot.get_cfg(), actions=True, actions_ports=True, revert_min=5))
CH = "999"
t, kb = aibot.propose(CH, "port_off", ("pppoe", None)); ok(kb is not None, f"propõe: {t}")
tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "1", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 1, "text": t}})
pp = next(i for i in ST["ifaces"] if i["name"] == "PPOE OPERADORA")
ok(pp["disabled"] == "true", "PPPoE desligado mesmo com o agendador bloqueado")
msg = SENT[-1][1]["text"]; ok("pelo NetNOC" in msg and "device-mode" in msg, f"explica a volta pelo NetNOC: {msg[-160:]!r}")
due = float(db.get_meta("iface_revert:PPOE OPERADORA")); ok(290 < due - time.time() <= 300, "horário da volta gravado no banco")
ok("PPOE OPERADORA" in actions._local_timers, "timer local armado")
# simula reinício do NetNOC com a volta já vencida
actions._local_timers.pop("PPOE OPERADORA").cancel()
db.set_meta("iface_revert:PPOE OPERADORA", str(time.time() - 5))
actions.resume_local_reverts()
for _ in range(50):
    if pp["disabled"] == "false": break
    threading.Event().wait(0.1)
ok(pp["disabled"] == "false" and not db.get_meta("iface_revert:PPOE OPERADORA"), "na partida, religa o que já venceu")
# religar manualmente cancela o timer local
aibot._callback("123:TOKEN", {"id": "2", "data": "x"})
t, kb = aibot.propose(CH, "port_off", ("roteador", 3)); tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "3", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 2, "text": t}})
ok("ether2" in actions._local_timers, "timer da ether2")
t, kb = aibot.propose(CH, "port_on", ("ether2", None)); tok = kb["inline_keyboard"][0][0]["callback_data"].split(":")[1]
aibot._callback("123:TOKEN", {"id": "4", "data": f"a:{tok}:y", "message": {"chat": {"id": CH}, "message_id": 3, "text": t}})
ok("ether2" not in actions._local_timers and not db.get_meta("iface_revert:ether2"), "religar cancela a volta local")
print("TUDO OK")
