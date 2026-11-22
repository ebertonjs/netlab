"""Comandos do Telegram que funcionam sem IA (/status, /ping, /mk, /portas, /log…).

Parte do antigo aibot.py (v4.4); o aibot.py continua reexportando tudo."""
import re, time


from netnoc.coleta import monitor

# ------------------------------------------------------------------ comandos (sem IA)
def _line_target(t):
    on = t.get("online")
    ico = "⚪" if on is None else ("✅" if on and (t.get("loss_pct") or 0) < 5 else ("⚠️" if on else "❌"))
    if on is False:
        return f"{ico} {t['name']}: OFFLINE"
    return f"{ico} {t['name']}: {_ms(t.get('latency'))} ms · perda {_pct(t.get('loss_pct'), 0)}%"


def cmd_status():
    s = tool_status()
    lines = [f"📡 {monitor.get_app_name()} · {s['agora']}",
             f"Internet: {'✅ online' if s['internet_online'] else '❌ OFFLINE'}" + (f" · IP {s['ip_publico']}" if s['ip_publico'] else ""),
             f"Média: {_ms(s['latencia_media_ms'])} ms · jitter {_ms(s['jitter_medio_ms'])} ms · perda {_pct(s['perda_media_pct'])}%", ""]
    lines += [_line_target({"name": d["nome"], "online": d["online"], "latency": d["latencia_ms"], "loss_pct": d["perda_pct"]})
              for d in s["destinos"]]
    inc = s["incidentes_abertos"]
    lines += ["", "Alertas abertos:" if inc else "Nenhum alerta aberto ✅"]
    lines += [f"• {i['severidade']}: {i['mensagem']} (há {i['duracao']})" for i in inc[:8]]
    return "\n".join(lines)


def cmd_ping(arg):
    parts = arg.split()
    if not parts:
        return "Uso: /ping <destino ou IP> [quantidade]\nEx.: /ping 8.8.8.8   /ping Google DNS 10"
    n = 5
    if len(parts) > 1 and parts[-1].isdigit():
        n = int(parts.pop())
    r = tool_ping(" ".join(parts), n)
    amostras = " ".join("×" if a is None else _ms(a) for a in r["amostras_ms"])
    head = "✅" if r["recebidos"] == r["enviados"] else ("❌" if not r["recebidos"] else "⚠️")
    lines = [f"{head} {r['destino']} ({r['host']}, {r['tipo'].upper()})",
             f"{r['recebidos']}/{r['enviados']} respostas · perda {_pct(r['perda_pct'], 0)}%"]
    if r["recebidos"]:
        lines.append(f"mín {_ms(r['min_ms'])} · média {_ms(r['media_ms'])} · máx {_ms(r['max_ms'])} ms" +
                     (f" · jitter {_ms(r['jitter_ms'])} ms" if r["jitter_ms"] is not None else ""))
    lines.append(f"amostras: {amostras}")
    h = r.get("historico_24h")
    if h and h.get("latencia_media_ms") is not None:
        lines.append(f"24 h: média {_ms(h['latencia_media_ms'])} ms · disponibilidade {_pct(h['disponibilidade_pct'], 2)}%")
    return "\n".join(lines)


def cmd_trace(arg):
    if not arg.strip():
        return "Uso: /trace <destino ou IP>"
    r = tool_traceroute(arg.strip())
    lines = [f"🧭 traceroute {r['host']}"]
    lines += [f"{h['n']:>2}  {h['ip']:<16} {(_ms(h['ms']) + ' ms') if h['ms'] is not None else '*'}" for h in r["saltos"]]
    return "\n".join(lines) if r["saltos"] else "Traceroute sem resposta."


def cmd_alertas():
    r = tool_incidentes(24)
    abertos = [i for i in r["incidentes"] if i["fim"] == "em aberto"]
    lines = [f"🚨 Abertos: {len(abertos)}"] + [f"• {i['severidade']}: {i['mensagem']} (há {i['duracao']})" for i in abertos[:10]]
    fech = [i for i in r["incidentes"] if i["fim"] != "em aberto"]
    lines += ["", f"Resolvidos nas últimas 24 h: {len(fech)}"]
    lines += [f"• {i['inicio']} {i['destino']}: {i['mensagem']} ({i['duracao']})" for i in fech[:10]]
    return "\n".join(lines)


def cmd_mk():
    r = tool_mikrotik()
    if not r["ativo"]:
        return "Integração MikroTik desativada."
    lines = [f"🛜 MikroTik {r['modelo'] or ''} · RouterOS {r['routeros'] or ''}" + (" (dados atrasados)" if r["dados_atrasados"] else ""),
             f"CPU {r['cpu_pct']}% · RAM {r['ram_pct']}% · {r['temperatura_c'] if r['temperatura_c'] is not None else '--'}°C · ligado há {r['ligado_ha'] or '--'}", ""]
    lines += [f"{'🟢' if i['link'] else '🔴'} {i['nome']}: ↓ {i['download']} ↑ {i['upload']}" for i in r["interfaces"]]
    return "\n".join(lines)

def cmd_cameras(chat, arg):
    from netnoc.bot import actions
    try:
        n, fails = send_cameras(chat, arg.strip() or None)
    except actions.ActionError as e:
        return f"⚠️ {e}"
    return None if not fails else f"📷 {n} foto(s). Sem imagem agora: {', '.join(fails)}."


def cmd_log(arg):
    from netnoc.coleta import syslog
    if not syslog.get_cfg()["enabled"]:
        return "O syslog do MikroTik está desligado. Ligue em Configurações → Integrações → MikroTik."
    a = (arg or "").strip()
    topic = a.lower() if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9-]{0,30}", a) and a.lower() in (
        "pppoe", "ppp", "system", "interface", "error", "warning", "critical", "account", "dhcp", "wireless", "firewall") else None
    rows = syslog.recent(minutes=24 * 60, topic=topic, text=None if topic else (a[:60] or None), limit=15)
    if not rows:
        return "Nada no log do MikroTik nas últimas 24 h" + (f" com '{a}'." if a else ".")
    return "📜 Log do MikroTik (mais recentes primeiro)\n" + "\n".join(
        f"{time.strftime('%d/%m %H:%M', time.localtime(r['ts']))} {r['topics']}: {r['msg'][:160]}" for r in rows)


def cmd_saude():
    from netnoc.nucleo import guarda
    ok, det = guarda.health()
    up = det["uptime_s"]
    lines = [("✅ NetNOC saudável" if ok else "⚠️ NetNOC com problema: " + "; ".join(det["problems"])),
             f"No ar há {up // 86400}d {up % 86400 // 3600}h {up % 3600 // 60}min"]
    lb = guarda.last_backup()
    if lb:
        lines.append(f"Último backup: {time.strftime('%d/%m %H:%M', time.localtime(lb['ts']))} "
                     + ("✅" if lb.get("ok") else f"❌ {lb.get('error', '')}"))
    else:
        lines.append("Último backup: nenhum ainda (/backup faz um agora)")
    hc = guarda.hc_status()
    if not guarda.get_cfg()["hc_url"]:
        lines.append("Vigia externo: não configurado")
    elif hc["last"]:
        lines.append(f"Vigia externo: último aviso às {time.strftime('%H:%M', time.localtime(hc['last']))} "
                     + ("✅" if hc["ok"] else f"❌ {hc['error']}"))
    return "\n".join(lines)


def cmd_portas():
    from netnoc.bot import actions
    try:
        ifs = [i for i in actions.interfaces() if i["type"] in ("ether", "wlan", "wifi", "pppoe-out", "sfp", "vlan")]
    except actions.ActionError as e:
        return f"⚠️ {e}"
    L = ["🔌 Portas do MikroTik:"]
    for i in ifs:
        st = "⚪ desligada" if i["disabled"] else ("🟢 com link" if i["running"] else "🔴 sem link")
        L.append(f"{st} · {i['name']}" + (f" ({i['comment']})" if i["comment"] else "") + (" · internet" if actions.is_wan(i) else ""))
    return "\n".join(L)


def cmd_banda():
    from netnoc.bot import actions
    r = actions.bandwidth_top(3)
    if not r["devices"]:
        return "📶 Ninguém usando a internet de forma relevante agora."
    L = [f"📶 Agora: ↓ {_bps(r['total_down_bps'])} · ↑ {_bps(r['total_up_bps'])}"]
    L += [f"{i}. {d['name']}: ↓ {_bps(d['down_bps'])} ↑ {_bps(d['up_bps'])}" for i, d in enumerate(r["devices"], 1)]
    return "\n".join(L)


def cmd_aparelhos():
    from netnoc.bot import actions
    devs = actions.devices()
    if not devs:
        return "Nenhum aparelho conhecido: a lista vem do DHCP do MikroTik."
    lim = time.time() - 7 * 86400
    novos = [d for d in devs if (d["first_seen"] or 0) >= lim]
    L = [f"📱 {sum(1 for d in devs if d['active'])} conectados agora · {len(devs)} conhecidos"]
    if novos:
        L += ["", "Novos nos últimos 7 dias:"] + [f"• {d['hostname'] or 'sem nome'} — {d['ip']} ({d['mac']}) desde {_hm(d['first_seen'])}" for d in novos[:12]]
    return "\n".join(L)


def cmd_bloqueados():
    from netnoc.bot import actions
    b = actions.blocked()
    return ("🚫 Bloqueados:\n" + "\n".join(f"• {x['ip']} {x['comment'].replace('NetNOC: ', '')}" for x in b)) if b else "Nenhum aparelho bloqueado."


# dependências entre os módulos do bot: no fim do arquivo porque há ciclos (só usadas na hora da chamada)
from netnoc.bot.aibot import _bps, _hm, _ms, _pct  # noqa: E402
from netnoc.bot.confirmar import send_cameras  # noqa: E402
from netnoc.bot.ferramentas import tool_incidentes, tool_mikrotik, tool_ping, tool_status, tool_traceroute  # noqa: E402
