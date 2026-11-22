"""Ações com confirmação (botões Sim/Cancelar): PPPoE, portas, reinícios, bloquear, aparelho novo.

Parte do antigo aibot.py (v4.4); o aibot.py continua reexportando tudo."""
import json, secrets, threading, time

import requests

from netnoc.nucleo import db
from netnoc.coleta import monitor

# ------------------------------------------------------------------ ações com confirmação
ACTION_TTL = 180                    # s para confirmar uma ação pedida
NEWDEV_TTL = 3600                   # s para o botão "Bloquear" do aviso de aparelho novo


def _kb(token, yes="✅ Sim", no="✖ Cancelar"):
    return {"inline_keyboard": [[{"text": yes, "callback_data": f"a:{token}:y"}, {"text": no, "callback_data": f"a:{token}:n"}]]}


def propose(chat, kind, arg=None, ttl=ACTION_TTL):
    """Prepara a ação e devolve (texto, teclado). Nada é executado antes do "Sim"."""
    from netnoc.bot import actions
    cfg_ = get_cfg()
    if not cfg_["actions"]:
        return ("🔒 As ações no roteador estão desligadas. Ligue em Configurações → Alertas → Bot e IA → "
                "\"Permitir ações no roteador\".", None)
    try:
        if kind == "pppoe":
            cl = [c for c in actions.pppoe_clients() if not c["disabled"]]
            if not cl:
                return ("Nenhuma conexão PPPoE encontrada no MikroTik.", None)
            args, desc = {"name": cl[0]["name"]}, f"⚠️ Reiniciar a conexão {cl[0]['name']}?\nA internet cai por uns 10 a 30 segundos."
        elif kind in ("wake", "block", "unblock"):
            if not str(arg or "").strip():
                return ("Diga qual aparelho (nome, IP ou MAC).", None)
            dev = actions.find_device(arg)
            label = f"{dev['name']} ({dev.get('ip') or '?'}{', ' + dev['mac'] if dev.get('mac') else ''})"
            args = {"dev": dev}
            desc = {"wake": f"⏰ Ligar {label} pela rede (Wake-on-LAN)?",
                    "block": f"🚫 Bloquear {label}?\nEle fica sem internet e sem acesso aos outros aparelhos até você liberar.",
                    "unblock": f"✅ Liberar {label}?"}[kind]
        elif kind in ("port_off", "port_on"):
            if not cfg_["actions_ports"]:
                return ("🔒 Desligar/ligar portas está desativado. Ligue em Configurações → Alertas → Bot e IA → "
                        "\"Permitir desligar e ligar portas\".", None)
            q, minutes = (arg if isinstance(arg, tuple) else (arg, None))
            itf = actions.find_iface(q or "")
            lbl = itf["name"] + (f" ({itf['comment']})" if itf["comment"] else "")
            if kind == "port_off":
                minutes = cfg_["revert_min"] if minutes is None else max(0, int(minutes))
                actions.check_iface_off(itf, minutes)
                args = {"itf": itf, "minutes": minutes}
                desc = (f"⚠️ Desligar {lbl}?\n" + ("A internet cai. " if actions.is_wan(itf) else "Quem está ligado nela fica sem rede. ")
                        + (f"Ela religa sozinha em {minutes} min." if minutes > 0 else "Fica desligada até você pedir para ligar.")
                        + ("\n⚠️ Sem internet, este chat para de funcionar: para religar, use o NetNOC na rede de casa (MikroTik → Portas) ou o Winbox."
                           if minutes <= 0 and actions.is_wan(itf) else ""))
            else:
                if not itf["disabled"]:
                    return (f"{lbl} já está ligada.", None)
                args, desc = {"itf": itf}, f"🔌 Ligar {lbl}?"
        elif kind in ("reboot_mikrotik", "reboot_dvr", "reboot_servidor", "reboot_netnoc", "reboot_all"):
            if not cfg_["actions_reboot"]:
                return ("🔒 Reinícios estão desativados. Ligue em Configurações → Alertas → Bot e IA → \"Permitir reinícios\".", None)
            items = cfg_["restart_all"] if kind == "reboot_all" else [kind.split("_", 1)[1]]
            if not items:
                return ("\"Reiniciar tudo\" está vazio: escolha o que entra em Configurações → Alertas → Bot e IA.", None)
            # ordem segura: o que não derruba a conexão primeiro; o servidor sempre por último
            order = [k for k in ("dvr", "netnoc", "mikrotik", "servidor") if k in items]
            if "servidor" in order and "netnoc" in order:
                order.remove("netnoc")                 # reiniciar o servidor já reinicia o NetNOC
            for k in order:
                if k in ("servidor", "netnoc") and not actions.can_sudo("systemctl", *(("reboot",) if k == "servidor" else ("restart", "netnoc"))):
                    return ("⚠️ O NetNOC não tem permissão para reiniciar o " + ("servidor" if k == "servidor" else "próprio serviço")
                            + ". No Pi, rode uma vez: sudo ./install.sh --permitir-reinicio", None)
            args = {"order": order}
            what = {"dvr": "📹 DVR (câmeras voltam em 2–3 min)", "netnoc": "♻️ serviço do NetNOC (~15 s fora)",
                    "mikrotik": "🛜 MikroTik (a rede e a internet caem 1–2 min)", "servidor": "🍓 servidor do NetNOC (~1 min fora)"}
            desc = ("⚠️ Reiniciar, nesta ordem:\n" if len(order) > 1 else "⚠️ Reiniciar ") + \
                "\n".join((f"{i}. " if len(order) > 1 else "") + what[k] for i, k in enumerate(order, 1)) + \
                ("\nAviso aqui quando tudo voltar." if len(order) > 1 or order[0] != "dvr" else "")
        else:
            return ("Ação desconhecida.", None)
    except actions.ActionError as e:
        return (f"⚠️ {e}", None)
    token = secrets.token_urlsafe(8)
    _pending[token] = {"kind": kind, "args": args, "chat": str(chat), "exp": time.time() + ttl, "desc": desc}
    for k in [k for k, v in _pending.items() if v["exp"] < time.time()]:
        _pending.pop(k, None)
    return desc, _kb(token)


def execute(p):
    from netnoc.bot import actions
    a = p["args"]
    try:
        if p["kind"] == "pppoe":
            r = actions.restart_pppoe(a["name"])
        elif p["kind"] == "wake":
            r = actions.wake(a["dev"])
        elif p["kind"] == "block":
            r = actions.block(a["dev"])
        elif p["kind"] == "unblock":
            r = actions.unblock(a["dev"])
        elif p["kind"] == "port_off":
            r = actions.iface_off(a["itf"], a["minutes"])
        elif p["kind"] == "port_on":
            r = actions.iface_on(a["itf"])
        elif p["kind"].startswith("reboot_"):
            r = _run_reboots(a["order"], p["chat"])
        else:
            r = "Ação desconhecida."
        ok = True
    except actions.ActionError as e:
        r, ok = f"⚠️ Não deu: {e}", False
    except Exception as e:
        r, ok = f"⚠️ Erro inesperado ({type(e).__name__})", False
    target = a.get("name") or (a.get("dev") or {}).get("name") or (a.get("itf") or {}).get("name") or ",".join(a.get("order") or [])
    db.audit("telegram", "", f"acao:{p['kind']}", f"{target} -> {'ok' if ok else 'falhou'}")
    monitor.log_event(f"Ação pelo Telegram: {p['kind']} {target} ({'ok' if ok else 'falhou'})", "Info")
    return r


def _run_reboots(order, chat):
    """Executa os reinícios na ordem; MikroTik e servidor avisam no Telegram quando voltam."""
    from netnoc.bot import actions
    lines = []
    for k in order:
        try:
            if k == "dvr":
                lines.append(actions.reboot_dvr())
            elif k == "mikrotik":
                lines.append(actions.reboot_mikrotik())
                threading.Thread(target=_watch_mikrotik, args=(chat,), daemon=True).start()
            elif k in ("netnoc", "servidor"):
                actions.schedule_local("reboot_pi" if k == "servidor" else "restart_netnoc", chat, delay=8 if "mikrotik" in order else 3)
                lines.append("♻️ " + ("Servidor reiniciando" if k == "servidor" else "NetNOC reiniciando") + ": aviso quando voltar.")
        except actions.ActionError as e:
            lines.append(f"⚠️ {RESTART_ITEMS.get(k, k)}: {e}")
    return "\n".join(lines)


def _watch_mikrotik(chat):
    from netnoc.bot import actions
    secs = actions.wait_mikrotik()
    tg = monitor.get_telegram()
    if not tg.get("bot_token"):
        return
    if secs is None:
        txt = "⚠️ O MikroTik não respondeu em 5 min depois do reinício. Confira se ele ligou."
    else:
        txt = f"✅ MikroTik voltou em {secs} s."
        try:
            cl = actions.pppoe_clients()
            if cl:
                txt += " " + " · ".join(f"{c['name']}: {'conectado' if c['running'] else 'ainda desconectado'}" for c in cl)
        except actions.ActionError:
            pass
    for _ in range(12):                       # a internet pode demorar mais que o roteador
        try:
            _core._tg(tg["bot_token"], "sendMessage", chat_id=chat, text=txt)
            return
        except Exception:
            time.sleep(10)


def _restart_notice():
    """Na partida: se o NetNOC/servidor foi reiniciado pelo Telegram, avisa que voltou."""
    raw = db.get_meta("restart_notice")
    if not raw:
        return
    db.set_meta("restart_notice", "")
    try:
        n = json.loads(raw)
    except ValueError:
        return
    if time.time() - n.get("ts", 0) > 1800:
        return
    tg = monitor.get_telegram()
    if not tg.get("bot_token"):
        return
    what = "O servidor" if n.get("kind") == "reboot_pi" else "O NetNOC"
    for _ in range(18):
        try:
            _core._tg(tg["bot_token"], "sendMessage", chat_id=n["chat"],
                text=f"✅ {what} voltou ({int(time.time() - n['ts'])} s depois do pedido). Tudo rodando.")
            return
        except Exception:
            time.sleep(10)


def send_cameras(chat, channel=None):
    """Fotos das câmeras agora (só leitura, sem confirmação)."""
    from netnoc.bot import actions
    photos, fails = actions.camera_photos(channel)
    tg = monitor.get_telegram()
    _send_photos(tg["bot_token"], chat, photos)
    return len(photos), fails


def _send_photos(token, chat, photos):
    if len(photos) == 1:
        data, cap = photos[0]
        requests.post(f"https://api.telegram.org/bot{token}/sendPhoto", data={"chat_id": chat, "caption": cap[:1000]},
                      files={"photo": ("camera.jpg", data, "image/jpeg")}, timeout=30)
        return
    media, files = [], {}
    for i, (data, cap) in enumerate(photos):
        media.append({"type": "photo", "media": f"attach://f{i}", "caption": cap[:1000]})
        files[f"f{i}"] = (f"camera{i}.jpg", data, "image/jpeg")
    requests.post(f"https://api.telegram.org/bot{token}/sendMediaGroup", data={"chat_id": chat, "media": json.dumps(media)},
                  files=files, timeout=60)


def on_new_devices(devs):
    """Gancho do monitor: aparelho nunca visto apareceu no DHCP."""
    cfg = get_cfg()
    tg = monitor.get_telegram()
    if not (cfg["new_devices"] and tg.get("bot_token") and tg.get("chat_id")):
        return
    for d in devs[:5]:
        text = (f"📱 Aparelho novo na rede\nNome: {d.get('hostname') or 'sem nome'}\nIP: {d.get('ip') or '?'}\nMAC: {d.get('mac')}\n"
                f"Visto agora ({_hm(time.time())}).")
        kb = None
        if cfg["actions"]:
            token = secrets.token_urlsafe(8)
            dev = {"name": d.get("hostname") or d.get("ip"), "ip": d.get("ip"), "mac": d.get("mac")}
            _pending[token] = {"kind": "block", "args": {"dev": dev}, "chat": str(tg["chat_id"]), "exp": time.time() + NEWDEV_TTL,
                               "desc": text, "newdev": True}
            kb = _kb(token, "🚫 Bloquear", "👍 É meu")
        else:
            text += "\nSe não conhece, ligue as ações no bot para poder bloquear daqui."
        _send(tg["bot_token"], tg["chat_id"], text, kb)


# dependências entre os módulos do bot: no fim do arquivo porque há ciclos (só usadas na hora da chamada)
from netnoc.bot.aibot import RESTART_ITEMS, _hm, _pending, _send, get_cfg  # noqa: E402
from netnoc.bot import aibot as _core  # noqa: E402  (_tg pelo módulo: os testes trocam aibot._tg)
