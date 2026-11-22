"""Destinos monitorados e servidores DNS: cadastro, edição, dependências ("Depende de").

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import json



from netnoc.nucleo import db
from netnoc.nucleo import security
from netnoc.coleta.base import _active_incidents, _clean_since, _consec, _inflight, _last_latency, _next_due, _state_lock, _win

# ------------------------------------------------------------------- targets
_targets_cache = None

def _invalidate_targets():
    global _targets_cache
    _targets_cache = None


def get_targets():
    global _targets_cache
    t = _targets_cache
    if t is None:
        t = json.loads(db.get_setting("targets", "[]"))
        _targets_cache = t
    return [dict(x) for x in t]


def get_dns_servers():
    return json.loads(db.get_setting("dns_servers", "[]"))


def _ancestors(name, items):
    by = {t["name"]: t for t in items}
    seen, cur = [], by.get(name, {}).get("parent")
    while cur and cur in by and cur not in seen:
        seen.append(cur)
        cur = by[cur].get("parent")
    return seen


def add_target(name, host, parent=None, extra=None):
    name = (name or "").strip()
    host = (host or "").strip()
    if not security.valid_name(name):
        raise ValueError("Nome inválido (use até 60 caracteres, sem < > \" ' & \\)")
    items = get_targets()
    extra = extra or {}
    ttype = extra.get("type", "icmp")
    if ttype not in ("icmp", "tcp", "http"):
        raise ValueError("Tipo de check inválido")
    if ttype == "http":
        if not security.valid_url(host):
            raise ValueError("URL inválida (http:// ou https://)")
    elif not security.valid_host(host):
        raise ValueError("Host inválido (IP ou nome de host)")
    if ttype == "tcp" and not security.valid_port(extra.get("port")):
        raise ValueError("Porta TCP inválida")
    if extra.get("expect_status") is not None and not 100 <= int(extra["expect_status"]) <= 599:
        raise ValueError("Status HTTP esperado inválido")
    if extra.get("group") is not None and not security.valid_name(extra["group"], 30):
        raise ValueError("Nome de grupo inválido (até 30 caracteres)")
    if any(t["name"] == name for t in items):
        raise ValueError("Já existe um destino com esse nome")
    if parent:
        if parent not in {t["name"] for t in items}:
            raise ValueError("Pai inexistente")
    entry = {"name": name, "host": host, "parent": parent or None}
    entry.update(extra)
    items.append(entry)
    db.set_setting("targets", json.dumps(items))
    _invalidate_targets()


def remove_target(name):
    items = get_targets()
    new = [t for t in items if t["name"] != name]
    for t in new:                       # filhos viram raiz
        if t.get("parent") == name:
            t["parent"] = None
    db.set_setting("targets", json.dumps(new))
    _invalidate_targets()
    with _state_lock:
        _win.pop(name, None)
        _last_latency.pop(name, None)
        _consec.pop(name, None)
        _next_due.pop(name, None)
        _clean_since.pop(name, None)
        _inflight.pop(name, None)
    for (itype, tgt) in [k for k in list(_active_incidents) if k[1] == name]:
        resolve_incident(itype, tgt, "Destino removido")


def update_target(name, parent=..., interval=..., group=...):
    """Altera pai e/ou intervalo de um destino existente (sem recriar e sem perder histórico)."""
    items = get_targets()
    by = {t["name"]: t for t in items}
    if name not in by:
        raise ValueError("Destino não encontrado")
    t = by[name]
    if parent is not ...:
        parent = parent or None
        if parent is not None:
            if parent not in by or parent == name:
                raise ValueError("Pai inválido")
            if name in _ancestors(parent, items):
                raise ValueError("Isso criaria um ciclo na topologia")
        t["parent"] = parent
    if interval is not ...:
        if interval in (None, 0, ""):
            t.pop("interval", None)
        else:
            interval = int(interval)
            if not 2 <= interval <= 3600:
                raise ValueError("Intervalo deve estar entre 2 e 3600 s")
            t["interval"] = interval
        _next_due.pop(name, None)
    if group is not ...:
        group = (group or "").strip()
        if not group:
            t.pop("group", None)
        elif not security.valid_name(group, 30):
            raise ValueError("Nome de grupo inválido (até 30 caracteres)")
        else:
            t["group"] = group
    db.set_setting("targets", json.dumps(items))
    _invalidate_targets()


def add_dns(name, ip):
    if not security.valid_name(name) or not security.valid_host(ip):
        raise ValueError("Nome ou IP inválido")
    items = get_dns_servers()
    if any(s["name"] == name for s in items):
        raise ValueError("Já existe um servidor DNS com esse nome")
    items.append({"name": name, "ip": ip})
    db.set_setting("dns_servers", json.dumps(items))


def remove_dns(name):
    db.set_setting("dns_servers", json.dumps([s for s in get_dns_servers() if s["name"] != name]))
    resolve_incident("dns", name, "Servidor removido")


# dependências entre os módulos da coleta: no fim do arquivo porque há ciclos
# (ex.: incidentes avisa pelo Telegram, que consulta os destinos); só são usadas na hora da chamada
from netnoc.coleta.incidentes import resolve_incident  # noqa: E402
