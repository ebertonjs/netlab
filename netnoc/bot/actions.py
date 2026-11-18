"""Ações na rede (fase 4): sempre disparadas pelo dono, com confirmação, e registradas na auditoria.

- reiniciar a conexão PPPoE do MikroTik (desliga e liga a interface pppoe-client)
- acordar um PC (Wake-on-LAN, pacote mágico enviado pelo próprio servidor e, se houver, pelo MikroTik)
- bloquear / desbloquear um aparelho (lista de endereços "netnoc-bloqueados" + uma regra de firewall
  que descarta o tráfego dela; a regra é criada uma vez, com comentário, e pode ser apagada no Winbox)
- quem está usando a banda agora (torch do MikroTik; se não der, taxa das conexões)
- aparelho novo na rede (o monitor avisa quando um MAC nunca visto aparece no DHCP)

As ações de escrita exigem: opção "Permitir ações" ligada no bot e um usuário do MikroTik com permissão de escrita.
"""
import ipaddress, re, socket, time
from urllib.parse import quote

import requests

from netnoc.nucleo import db
from netnoc.coleta import monitor
from netnoc.nucleo import security

BLOCK_LIST = "netnoc-bloqueados"
BLOCK_COMMENT = "NetNOC: aparelhos bloqueados (pode apagar para desfazer)"
MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")


class ActionError(RuntimeError):
    pass


# ------------------------------------------------------------------ MikroTik (escrita)
def _mt_cfg():
    cfg = monitor.get_mikrotik()
    if not cfg.get("enabled") or not cfg.get("host") or not cfg.get("username"):
        raise ActionError("integração MikroTik desativada ou sem usuário")
    return cfg


def _mt(method, path, body=None, timeout=15):
    cfg = _mt_cfg()
    try:
        r = requests.request(method, f"{monitor._mikrotik_base_url(cfg)}/{path}", auth=(cfg["username"], cfg["password"]),
                             json=body, verify=cfg["verify_ssl"], timeout=timeout)
    except requests.Timeout:
        raise ActionError("o MikroTik não respondeu a tempo")
    except Exception as e:
        raise ActionError(f"sem conexão com o MikroTik ({type(e).__name__})")
    if r.status_code in (401, 403):
        raise ActionError("o usuário do MikroTik não tem permissão de escrita (grupo 'write' ou 'full')")
    if not r.ok:
        try:
            msg = (r.json() or {}).get("detail") or (r.json() or {}).get("message") or ""
        except ValueError:
            msg = ""
        raise ActionError(f"o MikroTik recusou ({r.status_code}{': ' + str(msg)[:120] if msg else ''})")
    try:
        return r.json() if r.content else None
    except ValueError:
        return None


def _id(item):
    return quote(str(item.get(".id", "")), safe="")


def _bool(v):
    return v is True or str(v).lower() == "true"


def pppoe_clients():
    return [{"id": i.get(".id"), "name": i.get("name"), "running": _bool(i.get("running")), "disabled": _bool(i.get("disabled"))}
            for i in (_mt("GET", "interface/pppoe-client") or [])]


def restart_pppoe(name=None):
    cl = [c for c in pppoe_clients() if not c["disabled"] or c["name"] == name]
    if name:
        cl = [c for c in cl if c["name"] == name]
    if not cl:
        raise ActionError("nenhuma conexão PPPoE encontrada no MikroTik")
    c = cl[0]
    path = f"interface/pppoe-client/{quote(c['id'], safe='')}"
    _mt("PATCH", path, {"disabled": "true"})
    time.sleep(3)
    _mt("PATCH", path, {"disabled": "false"})
    for _ in range(20):                       # espera a sessão subir (até ~40 s)
        time.sleep(2)
        st = next((x for x in pppoe_clients() if x["name"] == c["name"]), None)
        if st and st["running"]:
            return f"✅ {c['name']} reiniciada e conectada de novo."
    return f"⚠️ {c['name']} foi reiniciada, mas ainda não reconectou. Se não subir em alguns minutos, reinicie a ONU ou ligue para a operadora."


# ------------------------------------------------------------------ aparelhos
def _norm_mac(m):
    return str(m or "").upper().replace("-", ":")


def devices():
    """Aparelhos conhecidos (DHCP do MikroTik + destinos com IP local)."""
    rows = db.query("SELECT mac, ip, hostname, active, first_seen, last_seen, promoted_target FROM dhcp_hosts ORDER BY last_seen DESC")
    return rows


def find_device(q):
    """Por nome de destino, hostname do DHCP, IP ou MAC. -> dict(name, ip, mac)."""
    q0 = str(q or "").strip()
    if not q0:
        raise ActionError("informe o aparelho (nome, IP ou MAC)")
    low = q0.lower()
    devs = devices()
    t = next((t for t in monitor.get_targets() if t["name"].lower() == low or t["host"] == q0), None)
    if t:
        d = next((d for d in devs if d["ip"] == t["host"] or d["promoted_target"] == t["name"]), None)
        return {"name": t["name"], "ip": t["host"] if _is_ip(t["host"]) else (d or {}).get("ip"), "mac": (d or {}).get("mac")}
    if MAC_RE.match(q0):
        d = next((d for d in devs if _norm_mac(d["mac"]) == _norm_mac(q0)), None)
        return {"name": (d or {}).get("hostname") or q0, "ip": (d or {}).get("ip"), "mac": _norm_mac(q0)}
    if _is_ip(q0):
        d = next((d for d in devs if d["ip"] == q0), None)
        return {"name": (d or {}).get("hostname") or q0, "ip": q0, "mac": (d or {}).get("mac")}
    m = [d for d in devs if (d["hostname"] or "").lower() == low] or [d for d in devs if low in (d["hostname"] or "").lower()]
    if len(m) == 1 or (m and (m[0]["hostname"] or "").lower() == low):
        d = m[0]
        return {"name": d["hostname"] or d["ip"], "ip": d["ip"], "mac": d["mac"]}
    if len(m) > 1:
        raise ActionError("mais de um aparelho com esse nome: " + ", ".join(f"{d['hostname']} ({d['ip']})" for d in m[:5]))
    raise ActionError(f"não achei o aparelho '{q0}' (use o nome, o IP ou o MAC)")


def _is_ip(s):
    try:
        ipaddress.ip_address(str(s))
        return True
    except ValueError:
        return False


# ------------------------------------------------------------------ Wake-on-LAN
def wake(dev):
    mac = _norm_mac(dev.get("mac"))
    if not MAC_RE.match(mac):
        raise ActionError(f"não sei o MAC de {dev.get('name')}: ele precisa ter aparecido no DHCP do MikroTik")
    payload = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "")) * 16
    sent = []
    targets = {"255.255.255.255"}
    if dev.get("ip") and _is_ip(dev["ip"]):
        try:
            targets.add(str(ipaddress.ip_network(dev["ip"] + "/24", strict=False).broadcast_address))
        except ValueError:
            pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for addr in targets:
            for port in (9, 7):
                try:
                    s.sendto(payload, (addr, port))
                    sent.append(f"{addr}:{port}")
                except OSError:
                    pass
    finally:
        s.close()
    via_mt = False
    try:
        br = _lan_iface()
        if br:
            _mt("POST", "tool/wol", {"mac": mac, "interface": br})
            via_mt = True
    except ActionError:
        pass
    if not sent and not via_mt:
        raise ActionError("não consegui enviar o pacote mágico")
    return (f"⏰ Pacote mágico enviado para {dev.get('name')} ({mac})" + (" pelo servidor e pelo MikroTik" if via_mt and sent else
            " pelo MikroTik" if via_mt else "") + ". Se o PC estiver com Wake-on-LAN ativado na BIOS/placa de rede, ele liga em alguns segundos.")


# ------------------------------------------------------------------ bloqueio
def _ensure_block_rule():
    rules = _mt("GET", "ip/firewall/filter") or []
    if any(r.get("src-address-list") == BLOCK_LIST and r.get("chain") == "forward" for r in rules):
        return False
    body = {"chain": "forward", "action": "drop", "src-address-list": BLOCK_LIST, "comment": BLOCK_COMMENT}
    if rules:
        body["place-before"] = rules[0].get(".id")         # no topo: antes de qualquer "accept"
    _mt("PUT", "ip/firewall/filter", body)
    return True


def blocked():
    return [{"id": e.get(".id"), "ip": e.get("address"), "comment": e.get("comment", "")}
            for e in (_mt("GET", "ip/firewall/address-list") or []) if e.get("list") == BLOCK_LIST]


def block(dev):
    ip = dev.get("ip")
    if not ip or not _is_ip(ip):
        raise ActionError(f"não sei o IP de {dev.get('name')}")
    if not ipaddress.ip_address(ip).is_private:
        raise ActionError("só aparelhos da rede local podem ser bloqueados")
    mt_host = monitor.get_mikrotik().get("host")
    if ip == mt_host or ip == _server_ip():
        raise ActionError("esse é o roteador ou o próprio servidor do NetNOC: não vou bloquear")
    if any(b["ip"] == ip for b in blocked()):
        return f"{dev.get('name')} ({ip}) já está bloqueado."
    created = _ensure_block_rule()
    _mt("PUT", "ip/firewall/address-list", {"list": BLOCK_LIST, "address": ip,
                                                    "comment": security.clean_name(f"NetNOC: {dev.get('name')} {dev.get('mac') or ''}", 80)})
    return (f"🚫 {dev.get('name')} ({ip}) bloqueado: sem acesso à internet nem aos outros aparelhos." +
            (" (criei a regra de firewall 'NetNOC' no topo da lista)" if created else "") +
            " Para liberar: /desbloquear " + str(dev.get("name")))


def unblock(dev):
    ip = dev.get("ip")
    items = [b for b in blocked() if b["ip"] == ip or (dev.get("mac") and dev["mac"] in (b["comment"] or "").upper())]
    if not items:
        return f"{dev.get('name')} não estava bloqueado."
    for b in items:
        _mt("DELETE", f"ip/firewall/address-list/{quote(b['id'], safe='')}")
    return f"✅ {dev.get('name')} ({ip}) liberado."


def _server_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("192.0.2.1", 9))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


# ------------------------------------------------------------------ quem usa a banda
def _lan_iface():
    try:
        ifs = monitor._mikrotik_get("interface")
    except Exception as e:
        raise ActionError(f"sem conexão com o MikroTik ({type(e).__name__})")
    br = [i for i in ifs if i.get("type") == "bridge" and not _bool(i.get("disabled"))]
    return br[0]["name"] if br else None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _ip_only(a):
    a = str(a or "")
    if a.count(":") == 1:
        a = a.split(":")[0]               # 192.168.1.10:443
    return a


def _private(ip):
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def bandwidth_top(seconds=3, limit=8):
    """[{ip, name, down_bps, up_bps}] dos aparelhos que mais usam a banda agora."""
    _mt_cfg()
    agg, method = {}, "torch"
    try:
        br = _lan_iface()
        if not br:
            raise ActionError("sem bridge")
        rows = _mt("POST", "tool/torch", {"interface": br, "src-address": "0.0.0.0/0", "dst-address": "0.0.0.0/0",
                                               "duration": f"{int(seconds)}s"}, timeout=seconds + 20) or []
        for r in rows:
            src, dst = _ip_only(r.get("src-address")), _ip_only(r.get("dst-address"))
            tx, rx = _num(r.get("tx")), _num(r.get("rx"))
            if _private(src) and not _private(dst):
                a = agg.setdefault(src, [0.0, 0.0]); a[0] += tx; a[1] += rx      # tx na bridge = descendo para o aparelho
            elif _private(dst) and not _private(src):
                a = agg.setdefault(dst, [0.0, 0.0]); a[0] += tx; a[1] += rx
        if not agg and rows is not None:
            raise ActionError("torch vazio")
    except ActionError:
        agg, method = {}, "conexões"
        rows = _mt("GET", "ip/firewall/connection?.proplist=src-address,dst-address,orig-rate,repl-rate", timeout=20) or []
        for r in rows:
            src = _ip_only(r.get("src-address"))
            if not _private(src):
                continue
            a = agg.setdefault(src, [0.0, 0.0])
            a[0] += _num(r.get("repl-rate"))      # resposta = download do aparelho
            a[1] += _num(r.get("orig-rate"))
    names = {d["ip"]: (d["promoted_target"] or d["hostname"] or d["ip"]) for d in devices() if d["ip"]}
    for t in monitor.get_targets():
        names.setdefault(t["host"], t["name"])
    out = [{"ip": ip, "name": names.get(ip, ip), "down_bps": d, "up_bps": u} for ip, (d, u) in agg.items() if d + u > 0]
    out.sort(key=lambda x: -(x["down_bps"] + x["up_bps"]))
    return {"method": method, "devices": out[:limit], "total_down_bps": sum(x["down_bps"] for x in out),
            "total_up_bps": sum(x["up_bps"] for x in out)}
