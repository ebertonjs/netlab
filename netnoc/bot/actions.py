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
from netnoc.nucleo import tlspin

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
        r = tlspin.request(cfg, method, f"{monitor._mikrotik_base_url(cfg)}/{path}", auth=(cfg["username"], cfg["password"]),
                           json=body, timeout=timeout)
    except requests.Timeout:
        raise ActionError("o MikroTik não respondeu a tempo")
    except requests.exceptions.SSLError as e:
        raise ActionError("certificado do MikroTik recusado" + (": mudou desde que foi salvo" if "mudou" in str(e) else ""))
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
    return quote(str(item.get(".id", "")), safe="*")


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
    path = f"interface/pppoe-client/{quote(c['id'], safe='*')}"
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
        _mt("DELETE", f"ip/firewall/address-list/{quote(b['id'], safe='*')}")
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


# ================================================================== v4.1: portas, reinícios e câmeras
# Toda ação que pode cortar a conexão tem VOLTA AUTOMÁTICA agendada no próprio MikroTik (scheduler do
# RouterOS): ele religa sozinho mesmo que o Pi fique sem internet e o Telegram caia.
REVERT_PREFIX = "netnoc-religar-"
WAN_RE = re.compile(r"pppoe|wan|internet|operadora|isp|onu|modem|lte|starlink", re.I)
IFACE_NAME_RE = re.compile(r"^[\w .:@<>/+-]{1,40}$")


def _strip(s):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "").lower()) if unicodedata.category(c) != "Mn")


def interfaces():
    out = []
    for i in (_mt("GET", "interface") or []):
        out.append({"id": i.get(".id"), "name": i.get("name") or "", "type": i.get("type") or "",
                    "comment": security.clean_name(i.get("comment", "") or "", 60),
                    "running": _bool(i.get("running")), "disabled": _bool(i.get("disabled"))})
    return out


def is_wan(itf):
    return itf["type"] == "pppoe-out" or bool(WAN_RE.search(f"{itf['name']} {itf['comment']}")) or \
        itf["name"] == (monitor.get_mikrotik() or {}).get("wan_iface")


def find_iface(q, ifs=None):
    """Acha a porta pelo nome exato, pelo comentário ("roteador", "AP sala") ou por "pppoe"/"wan"."""
    ifs = ifs if ifs is not None else interfaces()
    k = _strip(q).strip()
    if not k:
        raise ActionError("diga qual porta (nome como ether3 ou o comentário dela)")
    exact = [i for i in ifs if _strip(i["name"]) == k]
    if exact:
        return exact[0]
    if k in ("pppoe", "internet", "wan", "operadora", "conexao", "conexao da internet"):
        cand = [i for i in ifs if i["type"] == "pppoe-out"] or [i for i in ifs if is_wan(i)]
        if cand:
            return cand[0]
    words = [w for w in re.split(r"\W+", k) if len(w) >= 3 and w not in ("porta", "que", "vai", "para", "pro", "pra", "do", "da")]
    hits = [i for i in ifs if words and all(w in _strip(f"{i['name']} {i['comment']}") for w in words)]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise ActionError("mais de uma porta combina: " + ", ".join(f"{i['name']} ({i['comment'] or 'sem comentário'})" for i in hits[:6]))
    names = [i["name"] + (f" ({i['comment']})" if i["comment"] else "") for i in ifs
             if i["type"] in ("ether", "wlan", "pppoe-out", "wifi", "vlan", "sfp")]
    raise ActionError(f"não achei a porta \"{q}\". Portas: " + ", ".join(names[:14]))


def _server_ports():
    """Portas por onde o próprio servidor fala com o MikroTik: desligar uma delas tranca o NetNOC para fora."""
    ip = _server_ip()
    out = set()
    try:
        arp = [a for a in (_mt("GET", "ip/arp") or []) if a.get("address") == ip]
        mac = _norm_mac(arp[0].get("mac-address")) if arp else None
        if arp and arp[0].get("interface"):
            out.add(arp[0]["interface"])              # a bridge (ou a porta, se não houver bridge)
        if mac:
            for hst in (_mt("GET", "interface/bridge/host") or []):
                if _norm_mac(hst.get("mac-address")) == mac:
                    for k in ("on-interface", "interface"):
                        if hst.get(k):
                            out.add(hst[k])
    except ActionError:
        raise
    except Exception:
        pass
    return out


def _sched_name(iface):
    return REVERT_PREFIX + re.sub(r"[^\w.-]", "_", iface)[:40]


def _sched_blocked(e):
    """Agendador do MikroTik indisponível: device-mode, ou usuário restrito sem a política do scheduler."""
    t = str(e).lower()
    return "device-mode" in t or "permiss" in t or "not enough" in t or "policy" in t


def _cancel_revert(iface):
    _cancel_local(iface)
    name = _sched_name(iface)
    try:
        scheds = _mt("GET", "system/scheduler") or []
    except ActionError as e:
        if _sched_blocked(e):
            return                        # agendador bloqueado: não há o que cancelar no MikroTik
        raise
    for s in scheds:
        if s.get("name") == name:
            _mt("DELETE", f"system/scheduler/{_id(s)}")


# ---- volta automática pelo NetNOC (quando o device-mode do MikroTik bloqueia o agendador)
# O Pi fala com o MikroTik pela rede local, então religa mesmo com a internet fora. O horário fica no banco:
# se o NetNOC reiniciar no meio, ele religa na partida (resume_local_reverts).
_local_timers = {}
LOCAL_KEY = "iface_revert:"


def _cancel_local(iface):
    t = _local_timers.pop(iface, None)
    if t:
        t.cancel()
    db.set_meta(LOCAL_KEY + iface, "")


def _local_revert_now(iface):
    _local_timers.pop(iface, None)
    for attempt in range(30):              # tenta por ~5 min (o MikroTik pode estar ocupado)
        try:
            cur = next((i for i in interfaces() if i["name"] == iface), None)
            if cur and cur["disabled"]:
                _mt("PATCH", f"interface/{quote(cur['id'], safe='*')}", {"disabled": "false"})
            db.set_meta(LOCAL_KEY + iface, "")
            monitor.log_event(f"Porta {iface} religada sozinha (volta automática do NetNOC)", "Info")
            return True
        except ActionError:
            time.sleep(10)
    monitor.log_event(f"Não consegui religar a porta {iface}: o MikroTik não respondeu", "Alta")
    return False


def _schedule_local(iface, minutes):
    import threading
    _cancel_local(iface)
    db.set_meta(LOCAL_KEY + iface, str(time.time() + minutes * 60))
    t = threading.Timer(minutes * 60, _local_revert_now, args=(iface,))
    t.daemon = True
    _local_timers[iface] = t
    t.start()


def resume_local_reverts():
    """Na partida: religa o que já venceu e reagenda o que ainda falta."""
    import threading
    for r in db.query("SELECT key, value FROM meta WHERE key LIKE ? AND value != ''", (LOCAL_KEY + "%",)):
        iface = r["key"][len(LOCAL_KEY):]
        try:
            due = float(r["value"])
        except ValueError:
            continue
        left = due - time.time()
        if left <= 0:
            threading.Thread(target=_local_revert_now, args=(iface,), daemon=True).start()
        else:
            t = threading.Timer(left, _local_revert_now, args=(iface,))
            t.daemon = True
            _local_timers[iface] = t
            t.start()


def check_iface_off(itf, minutes):
    """Valida antes de pedir a confirmação (e de novo antes de executar)."""
    if itf["type"] == "bridge":
        raise ActionError(f"{itf['name']} é a bridge da rede local: desligá-la derruba tudo, inclusive o NetNOC. Desligue uma porta.")
    if itf["name"] in _server_ports():
        raise ActionError(f"o servidor do NetNOC está ligado pela porta {itf['name']}: desligá-la tranca o NetNOC para fora da rede.")
    if itf["disabled"]:
        raise ActionError(f"{itf['name']} já está desligada")


def iface_off(itf, minutes):
    """Desliga a porta e, se `minutes` > 0, agenda a religação (no MikroTik ou, se o device-mode bloquear, no NetNOC)."""
    cur = next((i for i in interfaces() if i["name"] == itf["name"]), None)
    if not cur:
        raise ActionError(f"a porta {itf['name']} não existe mais")
    check_iface_off(cur, minutes)
    via = None
    if minutes and minutes > 0:
        _cancel_revert(cur["name"])
        name = _sched_name(cur["name"])
        script = f'/interface enable [find name="{cur["name"]}"]; /system scheduler remove [find name="{name}"]'
        try:
            # o scheduler roda pela primeira vez "interval" depois de criado: é o atraso que queremos
            _mt("PUT", "system/scheduler", {"name": name, "interval": f"{int(minutes)}m", "on-event": script,
                                             "comment": "NetNOC: religa a porta sozinho (pode apagar para cancelar)"})
            via = "mikrotik"
        except ActionError as e:
            if not _sched_blocked(e):
                raise                          # outro erro: não desliga sem a volta garantida
            _schedule_local(cur["name"], int(minutes))
            via = "netnoc"
    try:
        _mt("PATCH", f"interface/{quote(cur['id'], safe='*')}", {"disabled": "true"})
    except ActionError:
        if via == "netnoc":
            _cancel_local(cur["name"])
        raise
    if via == "mikrotik":
        back = f"\n⏱️ Religa sozinha em {int(minutes)} min (agendado no próprio MikroTik)."
    elif via == "netnoc":
        back = (f"\n⏱️ Religa sozinha em {int(minutes)} min, pelo NetNOC (o device-mode do MikroTik bloqueia o agendador dele; "
                "o NetNOC religa pela rede local, mesmo sem internet).")
    elif is_wan(cur):
        back = ("\nFica desligada até você pedir para ligar. Sem internet o Telegram não chega: religue pelo NetNOC na rede de casa "
                "(MikroTik → Portas) ou pelo Winbox.")
    else:
        back = "\nFica desligada até você pedir para ligar."
    return f"✅ {cur['name']}{' (' + cur['comment'] + ')' if cur['comment'] else ''} desligada.{back}"


def iface_on(itf):
    cur = next((i for i in interfaces() if i["name"] == itf["name"]), None)
    if not cur:
        raise ActionError(f"a porta {itf['name']} não existe mais")
    _mt("PATCH", f"interface/{quote(cur['id'], safe='*')}", {"disabled": "false"})
    try:
        _cancel_revert(cur["name"])
    except ActionError:
        pass
    for _ in range(10):
        time.sleep(2)
        st = next((i for i in interfaces() if i["name"] == cur["name"]), None)
        if st and st["running"]:
            return f"✅ {cur['name']} ligada e com link."
    return f"✅ {cur['name']} ligada (ainda sem link: confira o cabo ou o aparelho do outro lado)."


# ------------------------------------------------------------------ reinícios
def reboot_mikrotik():
    try:
        _mt("POST", "system/reboot", {}, timeout=8)
    except ActionError as e:
        if "não respondeu" not in str(e) and "sem conexão" not in str(e):
            raise                                      # o roteador pode cair antes de responder: isso é sucesso
    return "✅ MikroTik reiniciando (a rede volta em 1 a 2 min)."


def wait_mikrotik(timeout_s=300):
    """Espera o MikroTik voltar; devolve os segundos que levou ou None."""
    t0 = time.time()
    time.sleep(20)
    while time.time() - t0 < timeout_s:
        try:
            _mt("GET", "system/resource", timeout=5)
            return int(time.time() - t0)
        except ActionError:
            time.sleep(5)
    return None


def reboot_dvr():
    from netnoc.integracoes import dvr
    cfg = dvr.get_cfg()
    if not cfg.get("enabled") or not cfg.get("host"):
        raise ActionError("DVR não configurado")
    try:
        r = dvr._get(cfg, "/cgi-bin/magicBox.cgi?action=reboot", timeout=8)
        if getattr(r, "status_code", 200) in (401, 403):
            raise ActionError("o usuário do DVR não pode reiniciar (precisa ser administrador)")
    except ActionError:
        raise
    except Exception as e:
        msg = str(e)
        if "401" in msg or "403" in msg:
            raise ActionError("o usuário do DVR não pode reiniciar (precisa ser administrador)")
        if "404" in msg:
            raise ActionError("o DVR não aceita reinício pela rede (CGI desligado)")
        if "Timeout" not in type(e).__name__ and "Connection" not in type(e).__name__:
            raise ActionError(f"o DVR recusou ({type(e).__name__})")
    return "✅ DVR reiniciando (as câmeras voltam em 2 a 3 min)."


def _sudo(*cmd):
    import subprocess
    try:
        r = subprocess.run(["sudo", "-n", *cmd], capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        raise ActionError("sudo não está instalado")
    except subprocess.TimeoutExpired:
        return True
    if r.returncode != 0:
        raise ActionError("o usuário do NetNOC não tem permissão para isso. No Pi, rode uma vez: "
                          "sudo ./install.sh --permitir-reinicio")
    return True


def can_sudo(*cmd):
    import subprocess
    try:
        r = subprocess.run(["sudo", "-n", "-l", *cmd], capture_output=True, text=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def schedule_local(kind, chat, delay=3):
    """Reinício do serviço/servidor: deixa um aviso para quando voltar e dispara depois de responder no Telegram."""
    import json, threading
    db.set_meta("restart_notice", json.dumps({"chat": str(chat), "ts": time.time(), "kind": kind}))

    def go():
        time.sleep(delay)
        try:
            if kind == "reboot_pi":
                _sudo("systemctl", "reboot")
            else:
                _sudo("systemctl", "restart", "netnoc")
        except ActionError as e:
            db.set_meta("restart_notice", "")
            monitor.log_event(f"Reinício pelo Telegram falhou: {e}", "Media")
    threading.Thread(target=go, daemon=True).start()


# ------------------------------------------------------------------ câmeras
def camera_photos(channel=None):
    """[(jpeg, legenda)] de um canal ou de todos (máx. 10, o limite de um álbum do Telegram)."""
    from netnoc.integracoes import dvr
    cfg = dvr.get_cfg()
    if not cfg.get("enabled") or not cfg.get("host"):
        raise ActionError("DVR não configurado")
    chans = list(range(1, cfg["channels"] + 1))
    if channel not in (None, "", "todas", "todos", 0):
        q = _strip(channel)
        pick = [c for c in chans if q == str(c) or q in _strip(dvr.channel_name(cfg, c))]
        if not pick:
            raise ActionError("câmera não encontrada. Câmeras: " + ", ".join(f"{c} {dvr.channel_name(cfg, c)}" for c in chans))
        chans = pick
    out, fails = [], []
    for c in chans[:10]:
        try:
            data, ts = dvr.snapshot(c, max_age=20, cfg=cfg)
            out.append((data, f"📷 {dvr.channel_name(cfg, c)} · {time.strftime('%H:%M:%S', time.localtime(ts))}"))
        except Exception:
            fails.append(dvr.channel_name(cfg, c))
    if not out:
        raise ActionError("não consegui foto de nenhuma câmera agora" + (f" ({', '.join(fails)})" if fails else ""))
    return out, fails
