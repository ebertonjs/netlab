"""Integração somente-leitura com a API JSON-RPC do Zabbix (token de API, Bearer)."""
import json, time
import requests
import db
import security

SECRET = ("token",)
DEFAULTS = {"enabled": False, "url": "", "token": "", "verify_ssl": True, "min_severity": 2, "limit": 50}
SEV_NAMES = {0: "Não classificado", 1: "Informação", 2: "Atenção", 3: "Média", 4: "Alta", 5: "Desastre"}
_cache = {"ts": 0, "data": None}


def get_cfg():
    return security.load_secret_cfg("zabbix", DEFAULTS, SECRET)


def masked():
    return security.mask_cfg(get_cfg(), SECRET)


def save_cfg(new):
    old = get_cfg()
    if new.get("enabled") or new.get("url"):
        if not security.valid_url(new.get("url", "")):
            raise ValueError("URL do Zabbix inválida (ex.: https://zabbix.exemplo/api_jsonrpc.php)")
    merged = security.merge_secrets(old, dict(DEFAULTS, **new), SECRET, ("url",))
    merged["min_severity"] = max(0, min(5, int(merged.get("min_severity", 2))))
    merged["limit"] = max(1, min(200, int(merged.get("limit", 50))))
    security.save_secret_cfg("zabbix", merged, SECRET)
    _cache["data"] = None


def _rpc(cfg, method, params):
    r = requests.post(cfg["url"], timeout=8, verify=bool(cfg.get("verify_ssl", True)),
                      headers={"Content-Type": "application/json-rpc",
                               "Authorization": "Bearer " + cfg["token"]},
                      data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}))
    r.raise_for_status()
    j = r.json()
    if "error" in j:
        raise RuntimeError(j["error"].get("data") or j["error"].get("message") or "erro Zabbix")
    return j["result"]


def problems(force=False):
    """Problemas ativos (cache de 30 s para não sobrecarregar o Zabbix com vários clientes)."""
    cfg = get_cfg()
    if not cfg["enabled"] or not cfg["url"]:
        return {"enabled": False, "problems": []}
    if not force and _cache["data"] and time.time() - _cache["ts"] < 30:
        return _cache["data"]
    try:
        res = _rpc(cfg, "problem.get", {
            "output": ["eventid", "name", "severity", "clock", "acknowledged", "objectid"],
            "recent": False, "sortfield": ["eventid"], "sortorder": "DESC", "limit": cfg["limit"],
            "severities": list(range(cfg["min_severity"], 6)), "selectHosts": ["name"]})
        out = []
        for p in res:
            hosts = p.get("hosts") or []
            out.append({"id": p["eventid"], "name": p["name"], "severity": int(p["severity"]),
                        "severity_name": SEV_NAMES.get(int(p["severity"]), "?"),
                        "since": int(p["clock"]), "ack": p.get("acknowledged") == "1",
                        "host": hosts[0]["name"] if hosts else ""})
        out.sort(key=lambda x: (-x["severity"], -x["since"]))
        data = {"enabled": True, "ok": True, "problems": out, "ts": time.time()}
    except Exception as e:
        data = {"enabled": True, "ok": False, "error": str(e)[:200], "problems": [], "ts": time.time()}
    _cache["ts"], _cache["data"] = time.time(), data
    return data


def test():
    cfg = get_cfg()
    if not cfg["url"]:
        raise ValueError("Zabbix não configurado")
    r = requests.post(cfg["url"], timeout=8, verify=bool(cfg.get("verify_ssl", True)),
                      headers={"Content-Type": "application/json-rpc"},
                      data=json.dumps({"jsonrpc": "2.0", "method": "apiinfo.version", "params": [], "id": 1}))
    r.raise_for_status()
    version = r.json().get("result")
    _rpc(cfg, "problem.get", {"output": ["eventid"], "limit": 1})      # valida o token
    return version
