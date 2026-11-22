"""Ferramentas que a IA (e alguns comandos) usam para consultar a rede: só leitura, com limites.

Parte do antigo aibot.py (v4.4); o aibot.py continua reexportando tudo."""
import re, time


from netnoc.coleta import monitor
from netnoc.nucleo import security

PING_MAX = 10                       # pings por chamada
TOOL_RATE = 20                      # pings/traceroutes por minuto (somados)

# ------------------------------------------------------------------ ferramentas (só leitura)
def _rate_ok():
    now = time.time()
    with _lock:
        while _tool_ts and now - _tool_ts[0] > 60:
            _tool_ts.popleft()
        if len(_tool_ts) >= TOOL_RATE:
            return False
        _tool_ts.append(now)
        return True


def _find_target(q):
    """Nome do destino (sem diferenciar maiúsculas/acentos) ou host exato."""
    import unicodedata
    norm = lambda s: unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower().strip()
    q0 = norm(q)
    ts = monitor.get_targets()
    for t in ts:
        if norm(t["name"]) == q0 or norm(t["host"]) == q0:
            return t
    part = [t for t in ts if q0 and q0 in norm(t["name"])]
    return part[0] if len(part) == 1 else None


def _resolve(dest):
    """(destino cadastrado ou None, host, tipo). Levanta ValueError se não puder."""
    dest = str(dest or "").strip()
    if not dest:
        raise ValueError("Informe um destino (nome cadastrado, IP ou domínio).")
    t = _find_target(dest)
    if t:
        return t, t["host"], t.get("type", "icmp")
    host = re.sub(r"^https?://", "", dest).split("/")[0]
    if not security.valid_host(host):
        raise ValueError(f"'{dest}' não é um destino cadastrado nem um IP/domínio válido.")
    if not get_cfg()["any_host"]:
        raise ValueError(f"'{dest}' não está entre os destinos cadastrados (ping livre desativado nas configurações).")
    return None, host, "icmp"


def _icmp(host, n):
    """Pings ICMP pelo `ping` do sistema: lista de ms (None = perdido)."""
    from netnoc.coleta import checks
    return checks.ping_many(host, n)


def _history_24h(name):
    rows = (_api["series"](86400, [name]) or {}).get(name, [])
    lats = [r["latency"] for r in rows if r.get("latency") is not None]
    loss = [r["loss_pct"] for r in rows if r.get("loss_pct") is not None]
    up = (_api["uptime"](86400, [name]) or {}).get(name)
    return {"latencia_media_ms": _r(sum(lats) / len(lats)) if lats else None,
            "latencia_min_ms": _r(min(lats)) if lats else None, "latencia_max_ms": _r(max(lats)) if lats else None,
            "perda_media_pct": _r(sum(loss) / len(loss), 2) if loss else None, "disponibilidade_pct": _r(up, 2)}


def tool_ping(destino, quantidade=5):
    t, host, kind = _resolve(destino)
    n = max(1, min(int(quantidade or 5), PING_MAX))
    if not _rate_ok():
        raise RuntimeError("limite de testes por minuto atingido, tente de novo em instantes")
    if kind == "icmp":
        samples = _icmp(host, n)
    else:
        from netnoc.coleta import checks
        samples = []
        for _ in range(n):
            samples.append(checks.probe(t))
            time.sleep(0.2)
    ok = [s for s in samples if s is not None]
    jit = [abs(ok[i] - ok[i - 1]) for i in range(1, len(ok))]
    out = {"destino": t["name"] if t else host, "host": host, "tipo": kind, "enviados": n, "recebidos": len(ok),
           "perda_pct": round(100 * (n - len(ok)) / n, 1),
           "min_ms": _r(min(ok)) if ok else None, "media_ms": _r(sum(ok) / len(ok)) if ok else None,
           "max_ms": _r(max(ok)) if ok else None, "jitter_ms": _r(sum(jit) / len(jit)) if jit else None,
           "amostras_ms": [_r(s) for s in samples]}
    if t:
        out["historico_24h"] = _history_24h(t["name"])
        snap = (_api["overview"]().get("targets") or {}).get(t["name"]) or {}
        out["janela_atual"] = {"online": snap.get("online"), "latencia_media_ms": _r(snap.get("avg_latency")),
                               "perda_pct": _r(snap.get("loss_pct"))}
    return out


def tool_traceroute(destino):
    _, host, _ = _resolve(destino)
    if not _rate_ok():
        raise RuntimeError("limite de testes por minuto atingido")
    from netnoc.coleta import checks
    hops = checks.traceroute(host, 20)
    return {"host": host, "saltos": [{"n": h["hop"], "ip": h["ip"] or "*", "ms": _r(h["ms"])} for h in hops]}


def tool_status():
    o = _api["overview"]()
    tg = _api["targets"]()
    inc = _api["incidents"](active_only=True)
    return {
        "agora": _hm(time.time()), "internet_online": o.get("internet_online"), "ip_publico": o.get("public_ip"),
        "latencia_media_ms": o.get("avg_latency"), "jitter_medio_ms": o.get("avg_jitter"), "perda_media_pct": o.get("avg_loss_pct"),
        "destinos": [{"nome": t["name"], "host": t["host"], "tipo": t.get("type"), "online": t.get("online"),
                      "latencia_ms": _r(t.get("latency")), "jitter_ms": _r(t.get("jitter")), "perda_pct": _r(t.get("loss_pct")),
                      "disponibilidade_24h_pct": _r(t.get("uptime_24h"), 2)} for t in tg],
        "incidentes_abertos": [{"destino": i["target"], "tipo": i["type"], "severidade": i["severity"], "mensagem": i["message"],
                                "desde": _hm(i["started_ts"]), "duracao": _dur(time.time() - i["started_ts"])} for i in inc],
    }


def tool_historico(destino, horas=24):
    t, _, _ = _resolve(destino)
    if not t:
        raise ValueError("histórico só existe para destinos cadastrados")
    horas = max(1, min(int(horas or 24), 24 * 30))
    secs = horas * 3600
    rows = (_api["series"](secs, [t["name"]]) or {}).get(t["name"], [])
    lats = [r["latency"] for r in rows if r.get("latency") is not None]
    loss = [r["loss_pct"] for r in rows if r.get("loss_pct") is not None]
    worst = sorted([r for r in rows if r.get("latency") is not None], key=lambda r: -r["latency"])[:3]
    since = time.time() - secs
    incs = [i for i in _api["incidents"](days=horas / 24) if i["target"] == t["name"]]
    return {"destino": t["name"], "periodo_horas": horas, "amostras": len(rows),
            "latencia_media_ms": _r(sum(lats) / len(lats)) if lats else None,
            "latencia_min_ms": _r(min(lats)) if lats else None, "latencia_max_ms": _r(max(lats)) if lats else None,
            "perda_media_pct": _r(sum(loss) / len(loss), 2) if loss else None,
            "disponibilidade_pct": _r((_api["uptime"](secs, [t["name"]]) or {}).get(t["name"]), 2),
            "piores_momentos": [{"quando": _hm(r["ts"]), "latencia_ms": _r(r["latency"])} for r in worst],
            "incidentes": [{"tipo": i["type"], "severidade": i["severity"], "mensagem": i["message"],
                            "inicio": _hm(i["started_ts"]), "fim": _hm(i["resolved_ts"]),
                            "duracao": _dur((i["resolved_ts"] or time.time()) - i["started_ts"])}
                           for i in incs if (i["resolved_ts"] or time.time()) >= since][:20]}


def tool_incidentes(horas=24, apenas_abertos=False):
    horas = max(1, min(int(horas or 24), 24 * 30))
    rows = _api["incidents"](active_only=True) if apenas_abertos else _api["incidents"](days=horas / 24)
    return {"periodo_horas": None if apenas_abertos else horas, "total": len(rows),
            "incidentes": [{"destino": i["target"], "tipo": i["type"], "severidade": i["severity"], "mensagem": i["message"],
                            "inicio": _hm(i["started_ts"]), "fim": _hm(i["resolved_ts"]) or "em aberto",
                            "duracao": _dur((i["resolved_ts"] or time.time()) - i["started_ts"])} for i in rows[:30]]}


def tool_cameras(camera=None):
    """Manda as fotos direto no chat (só leitura)."""
    from netnoc.bot import actions
    chat = getattr(_ctx, "chat", None)
    if not chat or chat == "painel":
        return {"erro": "as fotos só podem ser enviadas pelo Telegram"}
    try:
        n, fails = send_cameras(chat, camera)
    except actions.ActionError as e:
        return {"erro": str(e)}
    return {"status": f"{n} foto(s) enviada(s) no chat", "sem_imagem": fails}


def tool_portas():
    from netnoc.bot import actions
    return {"portas": [{"nome": i["name"], "comentario": i["comment"], "tipo": i["type"], "link": i["running"],
                        "desligada": i["disabled"], "internet": actions.is_wan(i)}
                       for i in actions.interfaces() if i["type"] in ("ether", "wlan", "wifi", "pppoe-out", "sfp", "vlan")]}


def _medir_done(chat):
    def done(res, err):
        from netnoc.coleta import medir
        tg = monitor.get_telegram()
        if tg.get("bot_token"):
            _send(tg["bot_token"], chat, medir.format_text(res, err, monitor.get_mikrotik().get("plan_mbps") or None))
    return done


def tool_medir(segundos=None):
    from netnoc.coleta import medir
    chat = getattr(_ctx, "chat", None) or str(monitor.get_telegram().get("chat_id") or "")
    try:
        st = medir.start(segundos or medir.DEFAULT_S, who="telegram", on_done=_medir_done(chat))
    except medir.MedirError as e:
        return {"erro": str(e)}
    return {"status": f"medindo a porta {st['iface']} por {st['seconds']} s; o resultado chega sozinho no chat",
            "instrucao": "peça ao usuário para rodar um speedtest AGORA no celular ou no PC"}


def tool_log(topico=None, texto=None, horas=None):
    from netnoc.coleta import syslog
    st = syslog.status()
    if not st["enabled"]:
        return {"erro": "syslog do MikroTik desligado (Configurações → Integrações → MikroTik)"}
    rows = syslog.recent(minutes=int(horas or 24) * 60, topic=topico, text=texto, limit=40)
    return {"linhas": [{"hora": _hm(r["ts"]), "topicos": r["topics"], "msg": r["msg"]} for r in rows]}


def tool_mikrotik():
    st = _api["mikrotik_status"]()
    if not st.get("enabled"):
        return {"ativo": False, "obs": "integração MikroTik desativada"}
    ifs = [i for i in _api["mikrotik_ifaces"]() if not i.get("disabled")]
    ifs.sort(key=lambda i: -((i.get("rx_bps") or 0) + (i.get("tx_bps") or 0)))
    return {"ativo": True, "modelo": st.get("board_name"), "routeros": st.get("version"), "dados_atrasados": st.get("stale"),
            "cpu_pct": st.get("cpu_load"), "ram_pct": st.get("mem_pct"), "temperatura_c": st.get("temperature"),
            "ligado_ha": _dur(st.get("uptime_s")) if st.get("uptime_s") else None,
            "interfaces": [{"nome": i["name"], "link": bool(i.get("running")), "download": _bps(i.get("rx_bps")),
                            "upload": _bps(i.get("tx_bps"))} for i in ifs[:12]]}


def tool_dns():
    return {"servidores": [{"nome": d["name"], "ip": d["ip"], "ok": d["success"], "latencia_ms": _r(d["latency"])}
                           for d in _api["dns"]()]}


def tool_banda_wan():
    """Pico de download/upload na porta WAN do MikroTik (substitui o speedtest na v4.0)."""
    out = {}
    for label, secs in (("hoje", 86400), ("7_dias", 7 * 86400), ("30_dias", 30 * 86400)):
        pk = _api["wan_peak"](secs)
        if pk:
            out["porta"] = pk["iface"]
            out[label] = {"download_mbps": _r(pk["rx_bps"] / 1e6), "download_quando": _hm(pk["rx_ts"]),
                          "upload_mbps": _r((pk.get("tx_bps") or 0) / 1e6), "upload_quando": _hm(pk["tx_ts"]) if pk.get("tx_ts") else None}
    return out or {"erro": "Sem dados do MikroTik (ative a integração para medir o tráfego da WAN)"}


def tool_servidor():
    s = _api["system"]()
    return {"host": s.get("host_label"), "versao_netnoc": s.get("version"), "cpu_pct": s.get("cpu_pct"),
            "ram_pct": s.get("mem_pct"), "temperatura_c": s.get("temp_c"), "disco_pct": s.get("disk_pct"),
            "ligado_ha": _dur(s.get("host_uptime_s")) if s.get("host_uptime_s") else None,
            "netnoc_rodando_ha": _dur(s.get("app_uptime_s")), "coletores_com_problema": s.get("workers_bad")}


def tool_diagnosticar(destino=None):
    from netnoc.analise import diagnose
    if destino:
        t, host, _ = _resolve(destino)
        if not t:
            raise ValueError("o diagnóstico completo é para destinos cadastrados; para outros endereços use ping ou traceroute")
        names = [t["name"]]
    else:
        names = []
    if not _rate_ok():
        raise RuntimeError("limite de testes por minuto atingido")
    with diagnose._lock:
        d = diagnose.investigate("check", names)
    return {"causa": d["title"], "confianca": d["confidence"], "explicacao": d["text"], "o_que_fazer": d["tips"],
            "evidencias": [("ok: " if e["ok"] else "falha: " if e["ok"] is False else "") + e["txt"] for e in d["evidence"]]}


def tool_diagnosticos(horas=48):
    from netnoc.analise import story
    eps = story.episodes(max(1, min(int(horas or 48), 24 * 30)))
    return {"episodios": [{"inicio": _hm(e["start"]), "fim": _hm(e["end"]) if e["end"] else "em aberto", "duracao": _dur(e["duration_s"]),
                           "o_que": e["title"], "causa_provavel": e["cause"], "explicacao": e["text"]} for e in eps[:25]]}


def tool_banda():
    from netnoc.bot import actions
    r = actions.bandwidth_top(3)
    return {"medido_por": r["method"], "total_download": _bps(r["total_down_bps"]), "total_upload": _bps(r["total_up_bps"]),
            "aparelhos": [{"nome": d["name"], "ip": d["ip"], "download": _bps(d["down_bps"]), "upload": _bps(d["up_bps"])} for d in r["devices"]]}


def tool_aparelhos(dias=7):
    from netnoc.bot import actions
    lim = time.time() - max(1, min(int(dias or 7), 90)) * 86400
    devs = actions.devices()
    return {"total": len(devs), "conectados_agora": sum(1 for d in devs if d["active"]),
            "novos_no_periodo": [{"nome": d["hostname"] or "sem nome", "ip": d["ip"], "mac": d["mac"], "primeira_vez": _hm(d["first_seen"])}
                                 for d in devs if (d["first_seen"] or 0) >= lim][:20]}


ACAO_KIND = {"reiniciar_pppoe": "pppoe", "acordar": "wake", "bloquear": "block", "desbloquear": "unblock",
             "desligar_porta": "port_off", "ligar_porta": "port_on", "reiniciar_mikrotik": "reboot_mikrotik",
             "reiniciar_dvr": "reboot_dvr", "reiniciar_servidor": "reboot_servidor", "reiniciar_netnoc": "reboot_netnoc",
             "reiniciar_tudo": "reboot_all"}


def tool_acao(acao, aparelho=None, porta=None, minutos=None):
    chat = getattr(_ctx, "chat", None)
    if not chat or chat == "painel":
        return {"erro": "ações só podem ser confirmadas pelo Telegram"}
    kind = ACAO_KIND.get(acao)
    if not kind:
        return {"erro": "ação desconhecida"}
    arg = (porta or "", minutos) if kind in ("port_off", "port_on") else aparelho
    text, kb = propose(chat, kind, arg)
    if not kb:
        return {"erro": text}
    tg = monitor.get_telegram()
    _send(tg["bot_token"], chat, text, kb)
    return {"status": "pedido de confirmação enviado com os botões Sim/Cancelar; a ação só acontece se o usuário tocar em Sim"}


S_DEST = {"type": "string", "description": "Nome de um destino cadastrado (ex.: Google DNS) ou IP/domínio"}
TOOLS = [
    ("status_rede", tool_status, "Situação atual: internet, todos os destinos (latência, jitter, perda, disponibilidade 24h) e incidentes abertos.", {}, []),
    ("ping", tool_ping, "Faz pings AGORA para um destino e compara com as últimas 24h quando ele é cadastrado.",
     {"destino": S_DEST, "quantidade": {"type": "integer", "description": f"1 a {PING_MAX}, padrão 5"}}, ["destino"]),
    ("traceroute", tool_traceroute, "Traceroute agora até um destino (saltos e latência de cada um).", {"destino": S_DEST}, ["destino"]),
    ("historico", tool_historico, "Histórico de um destino cadastrado: latência média/mín/máx, perda, disponibilidade, piores momentos e incidentes.",
     {"destino": S_DEST, "horas": {"type": "integer", "description": "janela em horas (1 a 720), padrão 24"}}, ["destino"]),
    ("incidentes", tool_incidentes, "Lista incidentes (quedas, perda, latência alta…) do período ou só os abertos.",
     {"horas": {"type": "integer", "description": "janela em horas, padrão 24"}, "apenas_abertos": {"type": "boolean"}}, []),
    ("mikrotik", tool_mikrotik, "Roteador MikroTik: CPU, RAM, temperatura, uptime e tráfego/link das interfaces.", {}, []),
    ("dns", tool_dns, "Servidores DNS monitorados: se respondem e com que latência.", {}, []),
    ("banda_wan", tool_banda_wan, "Maior download/upload que passou pela internet (porta WAN do MikroTik) hoje, em 7 e em 30 dias: a velocidade real que o link entregou.", {}, []),
    ("servidor", tool_servidor, "Servidor onde roda o NetNOC: CPU, RAM, temperatura, disco e coletores.", {}, []),
    ("diagnosticar", tool_diagnosticar, "Investiga AGORA a causa de um problema (gateway, internet, DNS, MikroTik/PPPoE/WAN, quedas simultâneas, traceroute) "
     "e devolve a causa provável. Sem destino: checa a rede toda.", {"destino": S_DEST}, []),
    ("diagnosticos", tool_diagnosticos, "Quedas e alertas recentes COM a causa encontrada pelo diagnóstico automático (operadora, energia, aparelho, DNS…). "
     "Use para 'por que caiu', 'o que aconteceu essa noite'.", {"horas": {"type": "integer", "description": "janela em horas, padrão 48"}}, []),
    ("banda", tool_banda, "Quem está usando a internet AGORA: download/upload por aparelho (MikroTik).", {}, []),
    ("aparelhos", tool_aparelhos, "Aparelhos da rede (DHCP do MikroTik): total, conectados e os novos dos últimos dias.",
     {"dias": {"type": "integer", "description": "janela para 'novos', padrão 7"}}, []),
    ("acao", tool_acao, "PEDE ao usuário a confirmação de uma ação: reiniciar_pppoe (derruba e reconecta), acordar (Wake-on-LAN), "
     "bloquear/desbloquear um aparelho, desligar_porta/ligar_porta do MikroTik (inclusive o PPPoE: porta='pppoe'), "
     "reiniciar_mikrotik, reiniciar_dvr, reiniciar_servidor (o Raspberry Pi), reiniciar_netnoc ou reiniciar_tudo. "
     "Não executa: envia botões Sim/Cancelar e o servidor valida tudo. Use só quando o usuário pedir a ação; "
     "para 'desabilita a porta do roteador', use desligar_porta com porta='roteador' (busca pelo comentário).",
     {"acao": {"type": "string", "enum": list(ACAO_KIND)},
      "aparelho": {"type": "string", "description": "nome, IP ou MAC do aparelho (acordar, bloquear, desbloquear)"},
      "porta": {"type": "string", "description": "nome (ether3) ou comentário da porta, ou 'pppoe' para a conexão de internet"},
      "minutos": {"type": "integer", "description": "desligar_porta: religa sozinha depois de N min; omita para usar o padrão da configuração; 0 = não religar"}},
     ["acao"]),
    ("cameras", tool_cameras, "Envia AGORA no chat do Telegram a foto de uma câmera (pelo nome ou número) ou de todas.",
     {"camera": {"type": "string", "description": "nome ou número da câmera; vazio = todas"}}, []),
    ("portas", tool_portas, "Lista as portas do MikroTik com comentário, link, se está desligada e qual é a internet.", {}, []),
    ("medir_velocidade", tool_medir, "Mede AGORA a velocidade real da internet lendo a porta WAN do MikroTik a cada segundo (30 a 120 s). "
     "O usuário precisa rodar um speedtest durante a medição; o resultado chega sozinho no chat.",
     {"segundos": {"type": "integer", "description": "15 a 120, padrão 45"}}, []),
    ("log_mikrotik", tool_log, "Log do próprio MikroTik (syslog): quedas do PPPoE com o motivo, logins, erros. Use para 'por que o PPPoE caiu', 'quem entrou no roteador'.",
     {"topico": {"type": "string", "description": "pppoe, system, interface, error, account…"},
      "texto": {"type": "string", "description": "trecho para procurar na mensagem"},
      "horas": {"type": "integer", "description": "janela em horas, padrão 24"}}, []),
]
_TOOL_FN = {n: f for n, f, *_ in TOOLS}


def run_tool(name, args):
    fn = _TOOL_FN.get(name)
    if not fn:
        return {"erro": f"ferramenta desconhecida: {name}"}
    try:
        args = {k: v for k, v in (args or {}).items() if v is not None}
        return fn(**args)
    except TypeError:
        return {"erro": "parâmetros inválidos"}
    except (ValueError, RuntimeError) as e:
        return {"erro": str(e)}
    except Exception as e:
        return {"erro": type(e).__name__}


# dependências entre os módulos do bot: no fim do arquivo porque há ciclos (só usadas na hora da chamada)
from netnoc.bot.aibot import _api, _bps, _ctx, _dur, _hm, _lock, _r, _send, _tool_ts, get_cfg  # noqa: E402
from netnoc.bot.confirmar import propose, send_cameras  # noqa: E402
