"""Diagnóstico automático: quando algo cai, o NetNOC investiga sozinho, como um analista de NOC faria.

Na abertura de um incidente (offline, queda local, perda, latência, jitter, DNS) ele espera alguns segundos
para as quedas simultâneas aparecerem e então coleta evidências:
  - o gateway responde? (ping)
  - a internet responde? (1.1.1.1 e 8.8.8.8)
  - o MikroTik está no ar? reiniciou? a WAN tem link? o PPPoE está conectado? o link está saturado?
  - o DNS da rede resolve? e um DNS público direto?
  - o que mais caiu junto (rede local x internet, dependências)?
  - até onde o traceroute chega?
e chega a uma causa provável com nível de confiança, explicação em português e o que fazer.

O resultado fica gravado (tabela diagnoses), vai para o Telegram e alimenta a linha do tempo da página
inicial e o diário diário. Ao iniciar, também detecta se o servidor ficou desligado (falta de energia).
Tudo por regras: não depende de IA.
"""
import ipaddress, json, queue, re, socket, threading, time
from datetime import datetime
from urllib.parse import urlparse

from netnoc.coleta import checks
from netnoc.nucleo import db
from netnoc.coleta import monitor

DIAG_TYPES = ("local", "offline", "dns", "loss", "latency", "jitter")    # em ordem de prioridade
SETTLE_S = 8                     # espera quedas simultâneas antes de investigar
REFS = (("Cloudflare", "1.1.1.1"), ("Google", "8.8.8.8"))
GAP_MIN_S = 180                  # buraco mínimo nos dados para contar como "servidor desligado"
NOTIFY_DEDUP_S = 900             # mesma causa para os mesmos destinos: não repete no Telegram

_q = queue.Queue(maxsize=200)
_lock = threading.Lock()         # uma investigação por vez (o Pi 3 agradece)
_last_sent = {}                  # assinatura -> ts
_started = False
SEV_RANK = {"Alta": 3, "Media": 2, "Baixa": 1, "Info": 0}


# ------------------------------------------------------------------ utilidades
def _hm(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "--"


def _dmhm(ts):
    return datetime.fromtimestamp(ts).strftime("%d/%m %H:%M") if ts else "--"


def dur(s):
    s = int(max(0, s or 0))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60} min"
    if s < 86400:
        h, m = divmod(s // 60, 60)
        return f"{h}h{m:02d}"
    d, rest = divmod(s, 86400)
    return f"{d}d {rest // 3600}h"


def _n(v, d=1):
    return "--" if v is None else (f"{v:.{d}f}" if v < 100 else f"{v:.0f}").replace(".", ",")


def host_of(h):
    h = str(h or "")
    if "://" in h:
        h = urlparse(h).hostname or ""
    return h


def is_private(host):
    h = host_of(host)
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return h.endswith((".lan", ".local", ".home", ".internal")) or "." not in h


def default_gateway():
    """Gateway padrão do servidor (Linux: /proc/net/route)."""
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                p = line.split()
                if len(p) > 2 and p[1] == "00000000" and int(p[3], 16) & 2:
                    return socket.inet_ntoa(int(p[2], 16).to_bytes(4, "little"))
    except Exception:
        pass
    return None


def _stats(samples):
    ok = [s for s in samples if s is not None]
    n = len(samples) or 1
    return {"ok": len(ok), "n": len(samples), "loss": round(100 * (n - len(ok)) / n, 1),
            "avg": round(sum(ok) / len(ok), 1) if ok else None, "max": round(max(ok), 1) if ok else None}


def _ping(host, n=4):
    try:
        return _stats(checks.ping_many(host, n))
    except Exception:
        return {"ok": 0, "n": n, "loss": 100.0, "avg": None, "max": None, "error": True}


def _in_thread(fn, timeout, default=None):
    box = [default]

    def run():
        try:
            box[0] = fn()
        except Exception:
            box[0] = default
    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout)
    return box[0]


def _resolve_system(name):
    return _in_thread(lambda: bool(socket.getaddrinfo(name, None)), 5, False)


def _resolve_via(server, name):
    def q():
        import dns.resolver
        r = dns.resolver.Resolver(configure=False)
        r.nameservers = [server]
        r.timeout = r.lifetime = 2.5
        t0 = time.time()
        r.resolve(name, "A")
        return round((time.time() - t0) * 1000, 1)
    return _in_thread(q, 4, None)


def _bool(v):
    return v is True or str(v).lower() == "true"


# ------------------------------------------------------------------ MikroTik ao vivo
def _mikrotik():
    """Estado do roteador agora: alcançável, uptime, WAN física, PPPoE, CPU e tráfego da WAN."""
    cfg = monitor.get_mikrotik()
    if not cfg.get("enabled") or not cfg.get("host"):
        return None
    out = {"host": cfg["host"], "reachable": False}
    try:
        res = monitor._mikrotik_get("system/resource", cfg)
        out["reachable"] = True
        out["uptime_s"] = monitor._mikrotik_parse_uptime(res.get("uptime", ""))
        out["cpu"] = int(res.get("cpu-load") or 0)
        ifs = monitor._mikrotik_get("interface", cfg)
    except Exception as e:
        out["error"] = monitor._safe_err(e)
        return out
    ifs = [i for i in ifs if not _bool(i.get("disabled"))]
    ppp = [i for i in ifs if i.get("type") in ("pppoe-out", "l2tp-out", "pptp-out", "sstp-out", "ovpn-out")]
    eth = [i for i in ifs if i.get("type") == "ether"]
    out["ppp"] = [{"name": i["name"], "up": _bool(i.get("running"))} for i in ppp]
    # porta física da WAN: comentário/nome com wan/internet/operadora, senão ether1
    wan = next((i for i in eth if re.search(r"wan|internet|operadora|isp|onu|modem", f"{i.get('name')} {i.get('comment', '')}", re.I)), None) \
        or next((i for i in eth if i.get("name") == "ether1"), None)
    if wan:
        out["wan_port"] = {"name": wan["name"], "up": _bool(wan.get("running"))}
    # tráfego atual da WAN (última coleta) para ver saturação
    wname = (ppp[0]["name"] if ppp else (wan or {}).get("name"))
    if wname:
        rows = db.query("SELECT rx_bps, tx_bps, ts FROM mikrotik_iface WHERE name=? ORDER BY ts DESC LIMIT 1", (wname,))
        if rows and time.time() - rows[0]["ts"] < 600:
            out["wan_rx_bps"], out["wan_tx_bps"] = rows[0]["rx_bps"], rows[0]["tx_bps"]
    return out


# ------------------------------------------------------------------ investigação
def _failing_now():
    """Destinos que estão falhando agora (sequência de falhas em curso ou offline aberto)."""
    out = []
    targets = {t["name"]: t for t in monitor.get_targets()}
    active = dict(monitor._active_incidents)
    with monitor._state_lock:
        consec = {k: list(v) for k, v in monitor._consec.items()}
    for n, t in targets.items():
        if t.get("type") == "agent":
            continue
        if ("offline", n) in active or consec.get(n, [0, 0])[0] > 0:
            out.append(t)
    return out


def _common_parent(names, targets):
    parent = {t["name"]: t.get("parent") for t in targets}
    chains = []
    for n in names:
        c, p, seen = [], parent.get(n), set()
        while p and p not in seen:
            seen.add(p)
            c.append(p)
            p = parent.get(p)
        chains.append(c)
    if not chains or not chains[0]:
        return None
    for p in chains[0]:
        if all(p in c for c in chains[1:]):
            return p
    return None


def investigate(kind, target_names=(), traceroute=True):
    """Coleta evidências e decide a causa provável. kind: tipo do incidente principal
    (local/offline/dns/loss/latency/jitter) ou 'check' (verificação sob demanda)."""
    t0 = time.time()
    targets = monitor.get_targets()
    by_name = {t["name"]: t for t in targets}
    tnames = [n for n in target_names if n in by_name]
    ev = []                         # evidências: (ok True/False/None, texto)
    add = lambda ok, txt: ev.append({"ok": ok, "txt": txt})

    # 1) em paralelo: gateway, referências da internet, DNS, MikroTik, o próprio destino
    gw = default_gateway()
    mt_cfg = monitor.get_mikrotik()
    if not gw and mt_cfg.get("enabled") and is_private(mt_cfg.get("host")):
        gw = mt_cfg.get("host")
    qname = monitor.CFG.get("dns_query_name") or "google.com"
    jobs = {"gw": (lambda: _ping(gw, 5)) if gw else (lambda: None),
            "refs": lambda: {name: _ping(ip, 4) for name, ip in REFS},
            "dns_sys": lambda: _resolve_system(qname),
            "dns_pub": lambda: _resolve_via("1.1.1.1", qname),
            "mt": _mikrotik}
    main_t = by_name.get(tnames[0]) if tnames else None
    if main_t and kind in ("check", "offline", "loss", "latency", "jitter"):
        if main_t.get("type", "icmp") == "icmp":
            jobs["target"] = lambda: _ping(main_t["host"], 6)
        elif main_t.get("type") in ("http", "tcp"):
            jobs["target"] = lambda: _stats([checks.probe(main_t) for _ in range(3)])
    if kind == "dns" and target_names:
        dsrv = next((s for s in monitor.get_dns_servers() if s["name"] == target_names[0]), None)
        if dsrv:
            jobs["dns_srv"] = lambda: (dsrv, _resolve_via(dsrv["ip"], qname))
    res, ths = {}, []
    for k, fn in jobs.items():
        th = threading.Thread(target=lambda k=k, fn=fn: res.__setitem__(k, _in_thread(fn, 25)), daemon=True)
        th.start()
        ths.append(th)
    for th in ths:
        th.join(30)
    G, R, MT = res.get("gw"), res.get("refs") or {}, res.get("mt")
    dns_sys, dns_pub, T = res.get("dns_sys"), res.get("dns_pub"), res.get("target")

    # 2) o que mais está caindo junto
    failing = _failing_now()
    for n in tnames:
        if n not in [f["name"] for f in failing] and kind in ("offline", "local"):
            failing.append(by_name[n])
    f_local = [f["name"] for f in failing if is_private(f["host"])]
    f_public = [f["name"] for f in failing if not is_private(f["host"])]
    n_local = sum(1 for t in targets if is_private(t["host"]) and t.get("type") != "agent")

    # evidências legíveis
    mt_up = bool(MT and MT.get("reachable"))
    gw_ok = (G is not None and G["ok"] > 0) or mt_up
    if gw:
        if G and G["ok"]:
            add(True, f"Gateway {gw}: responde ({_n(G['avg'])} ms, perda {_n(G['loss'], 0)}%)")
        else:
            add(False if not mt_up else None, f"Gateway {gw}: sem resposta ao ping" + (" (mas a API do MikroTik responde)" if mt_up else ""))
    refs_ok = [n for n, s in R.items() if s and s["ok"]]
    for n, s in R.items():
        add(bool(s and s["ok"]), f"Internet ({n} {dict(REFS)[n]}): " + (f"{_n(s['avg'])} ms, perda {_n(s['loss'], 0)}%" if s and s["ok"] else "sem resposta"))
    if dns_sys is not None:
        add(bool(dns_sys), f"DNS da rede resolvendo {qname}: " + ("ok" if dns_sys else "falhou"))
    if dns_pub is not None or not dns_sys:
        add(dns_pub is not None, "DNS público 1.1.1.1 direto: " + (f"ok ({_n(dns_pub)} ms)" if dns_pub is not None else "falhou"))
    if MT:
        if not mt_up:
            add(False, f"MikroTik {MT['host']}: API sem resposta" + (f" ({MT.get('error')})" if MT.get("error") else ""))
        else:
            add(True, f"MikroTik no ar há {dur(MT.get('uptime_s'))} · CPU {MT.get('cpu')}%")
            for p in MT.get("ppp", []):
                add(p["up"], f"Conexão {p['name']}: " + ("conectada" if p["up"] else "DESCONECTADA"))
            if MT.get("wan_port"):
                w = MT["wan_port"]
                add(w["up"], f"Porta WAN {w['name']}: " + ("com link" if w["up"] else "SEM LINK (cabo ou ONU/modem)"))
    if T is not None and main_t:
        add(T["ok"] > 0, f"{main_t['name']} agora: " + (f"{T['ok']}/{T['n']} respostas, {_n(T['avg'])} ms" if T["ok"] else "sem resposta"))
    if len(failing) > 1 or (failing and not tnames):
        add(None, "Falhando ao mesmo tempo: " + ", ".join(f["name"] for f in failing[:10]))

    # 3) decisão
    cause, conf, title, text, tips = "unknown", "baixa", "Causa não identificada", "", []
    main_name = tnames[0] if tnames else None
    main_priv = bool(main_t and is_private(main_t["host"]))
    since = None
    if tnames:
        st = [i["started_ts"] for (k, n), i in monitor._active_incidents.items() if n in tnames]
        since = min(st) if st else None
    rebooted = mt_up and MT.get("uptime_s") is not None and MT["uptime_s"] < (time.time() - (since or time.time())) + 300

    if not gw_ok and (len(f_local) >= max(2, n_local // 2) or kind == "local" or not refs_ok):
        cause, conf = "local", "alta" if not refs_ok else "media"
        title = "Falha local: o servidor não alcança o roteador"
        text = ("O NetNOC não consegue falar nem com o gateway. O problema está entre o servidor e o roteador: "
                "cabo de rede ou Wi-Fi do servidor, switch no caminho, ou o roteador desligado/travado (falta de energia nele?).")
        tips = ["Veja se o roteador está ligado e com as luzes normais", "Confira o cabo/Wi-Fi do servidor e o switch"]
        if MT and not mt_up:
            text += " A API do MikroTik também não responde."
    elif rebooted:
        cause, conf = "router_reboot", "alta"
        title = "O MikroTik reiniciou"
        text = (f"O roteador está ligado há só {dur(MT['uptime_s'])} (reiniciou por volta das {_hm(time.time() - MT['uptime_s'])}). "
                "Se ninguém reiniciou, pode ter sido queda de energia nele ou travamento.")
        tips = ["Se repetir, verifique a fonte/nobreak do roteador e o log do RouterOS"]
    elif gw_ok and not refs_ok:
        wan, ppp_down = (MT or {}).get("wan_port"), [p for p in (MT or {}).get("ppp", []) if not p["up"]]
        cause, conf = "isp", "alta"
        if wan and not wan["up"]:
            cause = "isp_link"
            title = "Operadora: a porta WAN está sem link"
            text = (f"Sua rede está normal, mas a porta {wan['name']} do MikroTik está sem link físico: "
                    "a ONU/modem da operadora desligou ou o cabo soltou.")
            tips = ["Confira se a ONU/modem está ligada e com a luz LOS apagada", "Reencaixe o cabo entre a ONU e o roteador",
                    "Se a luz LOS estiver vermelha, é na fibra: ligue para a operadora"]
        elif ppp_down:
            title = "Operadora: a conexão PPPoE caiu"
            text = (f"Sua rede está normal (o gateway responde), mas a conexão {ppp_down[0]['name']} está desconectada: "
                    "a operadora derrubou a sessão ou o link dela caiu.")
            tips = ["Se não voltar em alguns minutos, ligue para a operadora", "Reiniciar a ONU costuma ajudar quando a sessão não sobe"]
        else:
            title = "Operadora: internet fora"
            text = "Seu roteador e sua rede estão normais, mas nenhum servidor da internet responde: o problema está na operadora."
            if not MT:
                conf = "media"
            tips = ["Ligue para a operadora e informe o horário de início", "O NetNOC já guardou o registro para o seu histórico"]
    elif refs_ok and dns_sys is False:
        if dns_pub is not None:
            cause, conf, title = "dns_local", "alta", "DNS da rede fora"
            text = ("A internet funciona (os IPs respondem), mas o DNS configurado na rede não resolve nomes: "
                    "sites não abrem por nome. O DNS público responde normalmente.")
            tips = ["Confira o DNS do roteador ou o AdGuard", "Como paliativo, use 1.1.1.1 ou 8.8.8.8 no roteador"]
        else:
            cause, conf, title = "dns_upstream", "media", "DNS fora"
            text = "A internet responde por IP, mas nenhuma resolução de nomes funciona, nem a direta no 1.1.1.1."
            tips = ["Pode haver bloqueio de DNS na operadora ou no firewall do roteador"]
    elif kind == "dns" and "dns_srv" in res:
        dsrv, lat = res["dns_srv"]
        if lat is None and dns_pub is not None:
            cause, conf, title = "dns_server", "alta", f"Só o DNS {dsrv['name']} está fora"
            text = f"O servidor DNS {dsrv['name']} ({dsrv['ip']}) não respondeu, mas os outros e a internet estão normais."
            tips = ["Sem impacto se a rede usa outro DNS; se usa este, troque temporariamente"]
        elif lat is not None:
            cause, conf, title = "dns_recovered", "media", f"DNS {dsrv['name']} oscilou"
            text = f"Na investigação o DNS {dsrv['name']} já respondeu ({_n(lat)} ms): foi uma oscilação passageira."
    elif kind in ("loss", "latency", "jitter") and gw_ok:
        gq = G or {}
        rq = [s for s in R.values() if s]
        r_avg = [s["avg"] for s in rq if s["avg"] is not None]
        r_bad = (sum(s["loss"] for s in rq) / max(1, len(rq)) > 0) or (r_avg and max(r_avg) > monitor.THRESH["ping_ms"])
        sat = None
        if MT and MT.get("wan_rx_bps"):
            sp = db.query("SELECT download FROM speedtests WHERE download IS NOT NULL ORDER BY ts DESC LIMIT 1")
            if sp and sp[0]["download"]:
                sat = MT["wan_rx_bps"] / (sp[0]["download"] * 1e6)
        if gq.get("loss", 0) >= 10 or (gq.get("avg") or 0) > 20:
            cause, conf, title = "lan_quality", "alta", "Problema dentro da sua rede"
            text = (f"A perda/latência já aparece no gateway ({_n(gq.get('avg'))} ms, perda {_n(gq.get('loss'), 0)}%): "
                    "o problema está antes da internet — Wi-Fi fraco do servidor, cabo ruim ou roteador sobrecarregado"
                    + (f" (CPU do MikroTik {MT['cpu']}%)" if mt_up and MT.get("cpu") is not None else "") + ".")
            tips = ["Se o servidor está no Wi-Fi, prefira cabo", "Veja a CPU do roteador e se algum aparelho está saturando a rede"]
        elif sat is not None and sat >= 0.8:
            cause, conf, title = "saturation", "alta", "Internet saturada"
            text = (f"O link está no limite: download atual {_n(MT['wan_rx_bps'] / 1e6)} Mbps, perto dos "
                    f"{_n(sp[0]['download'])} Mbps medidos no último speedtest. A lentidão vem do uso da banda.")
            tips = ["Veja quem está usando a banda (downloads, atualizações, câmeras na nuvem)"]
        elif r_bad:
            cause, conf, title = "isp_quality", "media", "Operadora instável"
            rtxt = ", ".join("%s %s ms/%s%%" % (n, _n(s["avg"]), _n(s["loss"], 0)) for n, s in R.items() if s)
            text = ("Sua rede local está limpa, mas a internet como um todo está lenta ou perdendo pacotes "
                    f"({rtxt}): sinal de problema na operadora.")
            tips = ["Se continuar, registre a reclamação: o NetNOC guarda o histórico com horários"]
        elif main_name:
            cause, conf, title = "remote_quality", "media", f"Só {main_name} está lento"
            text = f"A rede e a internet em geral estão normais; a lentidão é só no caminho até {main_name} ou do lado deles."
    elif kind == "check" and main_name and gw_ok and T is not None and T["ok"] == T["n"]:
        cause, conf = "ok", "alta"
    elif kind in ("offline", "check") and main_name and gw_ok:
        if main_priv:
            others = [n for n in f_local if n != main_name]
            if others:
                par = _common_parent([main_name] + others, targets)
                if par:
                    cause, conf, title = "parent", "alta", f"Caiu o que depende de {par}"
                    text = f"{', '.join([main_name] + others)} dependem de {par}, e estão todos fora: o problema provavelmente é em {par}."
                    tips = [f"Verifique {par} (energia, cabo, travamento)"]
                else:
                    cause, conf, title = "lan_partial", "media", "Vários aparelhos da rede caíram juntos"
                    text = (f"{', '.join([main_name] + others)} caíram ao mesmo tempo, mas o roteador está normal: "
                            "provável switch, ponto de acesso Wi-Fi ou falta de energia em parte da casa.")
                    tips = ["Veja o switch/AP que liga esses aparelhos e as tomadas deles"]
            elif T is not None and T["ok"]:
                cause, conf, title = "recovered", "media", f"{main_name} já voltou"
                text = f"Na investigação {main_name} já respondia ({_n(T['avg'])} ms): foi uma queda curta."
            else:
                cause, conf, title = "device", "alta", f"Só {main_name} está fora"
                text = (f"O resto da rede está normal; só {main_name} não responde. Provável: aparelho desligado, travado, "
                        "sem energia na tomada ou fora do Wi-Fi.")
                tips = [f"Confira se {main_name} está ligado e conectado", "Se for Wi-Fi, veja o sinal onde ele fica"]
        else:
            if T is not None and T["ok"] and kind == "offline":
                cause, conf, title = "recovered", "media", f"{main_name} já voltou"
                text = f"Na investigação {main_name} já respondia ({_n(T['avg'])} ms): foi uma queda curta."
            elif main_t.get("type") in ("http", "tcp") and not _resolve_system(host_of(main_t["host"])):
                cause, conf, title = "remote_dns", "alta", f"O endereço de {main_name} não resolve"
                text = f"A internet está normal, mas o nome {host_of(main_t['host'])} não resolve no DNS: problema no domínio deles ou no DNS."
            else:
                cause, conf, title = "remote", "alta", f"Só {main_name} está fora"
                text = (f"Sua internet está normal ({' e '.join(refs_ok)} respondem). Só {main_name} não responde: "
                        "o problema é do lado deles ou no caminho até eles — não é na sua rede.")
                tips = ["Nada a fazer na sua rede; aguarde ou verifique o status do serviço"]
    elif kind == "check" and main_name is None and gw_ok and refs_ok:
        cause, conf, title = "ok", "alta", "Tudo normal"
        text = "Gateway, internet e DNS respondem normalmente."

    if cause == "ok" or (kind == "check" and T is not None and T["ok"] == T["n"] and refs_ok and gw_ok and cause in ("unknown", "recovered")):
        cause, conf, title = "ok", "alta", f"{main_name} está normal" if main_name else "Tudo normal"
        text = (f"{main_name} responde ({_n(T['avg'])} ms, sem perda), e gateway e internet estão normais." if main_name and T
                else "Gateway, internet e DNS respondem normalmente.")

    # 4) traceroute (só quando ajuda: destino/internet fora com a rede local ok)
    if traceroute and gw_ok and cause in ("isp", "remote", "isp_quality", "remote_quality"):
        tgt = main_t["host"] if (main_t and cause in ("remote", "remote_quality")) else "8.8.8.8"
        hops = _in_thread(lambda: checks.traceroute(host_of(tgt), 15), 45, None)
        if hops:
            good = [h for h in hops if h.get("ip")]
            last = good[-1] if good else None
            reached = last and last["ip"] == host_of(tgt)
            if last and not reached:
                where = "dentro da sua rede" if is_private(last["ip"]) else "na rede da operadora ou depois dela"
                add(False, f"Traceroute até {host_of(tgt)}: para no salto {last['hop']} ({last['ip']}, {where})")
                if cause == "isp" and not is_private(last["ip"]):
                    text += f" O traceroute passa pelo seu roteador e morre no salto {last['hop']} ({last['ip']})."
            elif reached:
                add(True, f"Traceroute até {host_of(tgt)}: chega em {len(hops)} saltos")
            else:
                add(False, f"Traceroute até {host_of(tgt)}: nenhum salto respondeu")

    return {"ts": t0, "kind": kind, "targets": tnames, "cause": cause, "confidence": conf, "title": title,
            "text": text, "tips": tips, "evidence": ev, "secs": round(time.time() - t0, 1)}


# ------------------------------------------------------------------ texto
CONF = {"alta": "confiança alta", "media": "confiança média", "baixa": "confiança baixa"}


def format_text(d, header=True):
    lines = []
    if header:
        alvo = (", ".join(d["targets"][:4]) + (" e outros" if len(d["targets"]) > 4 else "")) if d["targets"] else "rede"
        lines.append(f"🔎 Diagnóstico · {alvo}")
    lines.append(f"Causa provável: {d['title']} ({CONF.get(d['confidence'], d['confidence'])})")
    if d["text"]:
        lines.append(d["text"])
    if d["evidence"]:
        lines.append("")
        lines.append("Evidências:")
        lines += [("✅ " if e["ok"] is True else "❌ " if e["ok"] is False else "• ") + e["txt"] for e in d["evidence"]]
    if d["tips"]:
        lines.append("")
        lines.append("O que fazer:")
        lines += ["→ " + t for t in d["tips"]]
    return "\n".join(lines)


def save(d, incident_ids=(), end_ts=None):
    return db.execute(
        "INSERT INTO diagnoses(ts, end_ts, incident_ids, targets, kind, cause, confidence, title, text, evidence, tips) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (d["ts"], end_ts, json.dumps(list(incident_ids)), json.dumps(d["targets"], ensure_ascii=False), d["kind"], d["cause"],
         d["confidence"], d["title"], d["text"], json.dumps(d["evidence"], ensure_ascii=False), json.dumps(d["tips"], ensure_ascii=False)))


# ------------------------------------------------------------------ fila de incidentes
def on_incident(itype, target, iid, severity):
    """Gancho chamado pelo monitor quando um incidente abre."""
    if itype not in DIAG_TYPES:
        return
    try:
        _q.put_nowait((itype, target, iid, severity, time.time()))
    except queue.Full:
        pass


def _worker():
    while True:
        first = _q.get()
        time.sleep(SETTLE_S)                     # deixa as quedas simultâneas aparecerem
        batch = [first]
        while True:
            try:
                batch.append(_q.get_nowait())
            except queue.Empty:
                break
        try:
            _handle_batch(batch)
        except Exception as e:
            monitor.log_event(f"Diagnóstico automático falhou: {type(e).__name__}", "Baixa")


def _handle_batch(batch):
    # incidentes que já fecharam enquanto esperávamos continuam valendo (queda curta também merece causa)
    batch.sort(key=lambda b: DIAG_TYPES.index(b[0]))
    kind = batch[0][0]
    names = list(dict.fromkeys(b[1] for b in batch if b[0] == kind))
    if kind == "local":
        names = []
    with _lock:
        d = investigate(kind, names)
    ids = [b[2] for b in batch]
    save(d, ids)
    sev = max((b[3] for b in batch), key=lambda s: SEV_RANK.get(s, 0))
    sig = f"{d['cause']}|{','.join(sorted(d['targets']))}"
    if time.time() - _last_sent.get(sig, 0) > NOTIFY_DEDUP_S:
        _last_sent[sig] = time.time()
        monitor.notify(sev, format_text(d), "incident", d["targets"][0] if d["targets"] else None)
    monitor.log_event(f"Diagnóstico: {d['title']}" + (f" ({', '.join(d['targets'][:3])})" if d["targets"] else ""), "Info")


# ------------------------------------------------------------------ servidor desligado (energia)
def boot_time():
    try:
        with open("/proc/uptime") as f:
            return time.time() - float(f.read().split()[0])
    except Exception:
        return None


def check_gap(app_started):
    """Na partida: se os dados pararam por mais de GAP_MIN_S, registra o período em que o servidor ficou
    desligado (reboot do host = provável falta de energia) ou o NetNOC parado."""
    rows = db.query_w("SELECT MAX(ts) m FROM pings WHERE ts < ?", (app_started - 5,))
    last = rows[0]["m"] if rows and rows[0]["m"] else None
    if not last:
        return None
    gap = app_started - last
    if gap < GAP_MIN_S or gap > 30 * 86400:
        return None
    boot = boot_time()
    host = monitor.HOST_LABEL
    if boot and last - 60 <= boot <= app_started:
        cause, title = "power", f"{host} ficou desligado"
        text = (f"O servidor parou às {_dmhm(last)} e só ligou de novo às {_dmhm(boot)} ({dur(boot - last)} sem monitoramento). "
                "Ele reiniciou nesse meio-tempo: provável falta de energia (ou alguém desligou/reiniciou).")
        tips = ["Um nobreak pequeno no servidor e no roteador evita esse buraco"]
    else:
        cause, title = "stopped", "NetNOC ficou parado"
        text = f"O monitoramento ficou parado de {_dmhm(last)} até {_dmhm(app_started)} ({dur(gap)}), sem o servidor reiniciar (atualização ou serviço parado)."
        tips = []
    d = {"ts": last, "kind": "gap", "targets": [], "cause": cause, "confidence": "alta" if cause == "power" else "media",
         "title": title, "text": text, "tips": tips, "evidence": []}
    if not db.query_w("SELECT 1 FROM diagnoses WHERE kind='gap' AND ABS(ts-?)<1", (last,)):
        save(d, (), app_started)
        monitor.log_event(f"{title}: {_dmhm(last)} → {_dmhm(app_started)}", "Media")
        if cause == "power":
            monitor.notify("Media", f"🔌 {monitor.get_app_name()}\n{text}", "info")
    return d


def start():
    global _started
    if _started:
        return
    _started = True
    if on_incident not in monitor.INCIDENT_HOOKS:
        monitor.INCIDENT_HOOKS.append(on_incident)
    threading.Thread(target=_worker, daemon=True, name="diagnostico").start()
    app_started = time.time()

    def later():
        time.sleep(90)              # sem RTC o Pi pode estar com o relógio errado logo após ligar (espera o NTP)
        try:
            check_gap(app_started)
        except Exception as e:
            print(f"[diagnostico] gap: {type(e).__name__}", flush=True)
    threading.Thread(target=later, daemon=True, name="gap").start()


# ------------------------------------------------------------------ consulta
def recent(hours=48, limit=50):
    rows = db.query("SELECT * FROM diagnoses WHERE ts >= ? ORDER BY ts DESC LIMIT ?", (time.time() - hours * 3600, limit))
    for r in rows:
        for k in ("incident_ids", "targets", "evidence", "tips"):
            try:
                r[k] = json.loads(r[k] or "[]")
            except ValueError:
                r[k] = []
    return rows
