"""Bot do Telegram com IA opcional (Gemini ou Groq).

Você pergunta pelo Telegram ("como está o ping pro Google?") e o NetNOC responde com dados reais:
a IA escolhe as ferramentas (ping agora, histórico, incidentes, MikroTik…), o NetNOC executa e a IA
escreve o relatório. Sem IA configurada, os comandos /status, /ping, /trace, /alertas, /mk funcionam igual.

Segurança:
- Só responde ao chat_id configurado em Telegram (os outros são ignorados).
- As ferramentas de consulta são só de leitura. Ações (PPPoE, portas, reinícios, bloquear) só são PROPOSTAS: o
  servidor valida e manda botões Sim/Cancelar; nada acontece sem o "Sim". Nenhum comando livre é executado.
- Ping/traceroute com host validado, limite de quantidade e de uso por minuto.
- Chaves das IAs cifradas no banco (mesmo esquema das outras senhas); erros nunca expõem chave/token.
"""
import json, re, threading, time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import requests

from netnoc.coleta import monitor
from netnoc.nucleo import security

# ------------------------------------------------------------------ configuração
SECRET = ("gemini_key", "groq_key")
DEFAULTS = {
    "enabled": False,               # bot responde mensagens (os alertas continuam no switch do Telegram)
    "provider": "none",             # none | gemini | groq
    "gemini_key": "", "gemini_model": "gemini-3.5-flash-lite",
    "groq_key": "", "groq_model": "openai/gpt-oss-120b",
    "any_host": True,               # ping/traceroute para endereços fora dos destinos cadastrados
    "diary": False,                 # diário da rede no Telegram todo dia
    "diary_time": "07:00",
    "actions": False,               # ações no roteador (PPPoE, bloquear, acordar) — sempre com confirmação
    "new_devices": True,            # avisa quando um aparelho novo aparece no DHCP
    "actions_ports": False,         # v4.1: desligar/ligar portas e o PPPoE (sempre com volta automática na internet)
    "actions_reboot": False,        # v4.1: reiniciar MikroTik, DVR, servidor e o NetNOC
    "revert_min": 5,                # minutos até a porta/PPPoE religar sozinho (0 = só religa quando pedir)
    "restart_all": ["mikrotik", "dvr"],   # o que "reinicia tudo" inclui (mikrotik, dvr, netnoc, servidor)
}
RESTART_ITEMS = {"dvr": "DVR", "netnoc": "serviço do NetNOC", "mikrotik": "MikroTik", "servidor": "servidor (Raspberry Pi)"}
PROVIDERS = ("none", "gemini", "groq")
MAX_ROUNDS = 6                      # chamadas de ferramenta por pergunta
HIST_TTL = 15 * 60                  # memória curta da conversa
HIST_LEN = 8                        # mensagens guardadas (usuário + bot)

_api = {}                           # funções do main.py (overview, targets, incidents, …), via start()
_state = {"last_error": "", "last_error_ts": None, "last_msg_ts": None, "running": False, "ignored": 0}
_hist = {}                          # chat_id -> deque[(ts, role, text)]
_tool_ts = deque()
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="aibot")
_ctx = threading.local()            # chat da conversa em andamento (para as ferramentas que pedem confirmação)
_pending = {}                       # token -> ação esperando o "Sim"


def get_cfg():
    return security.load_secret_cfg("ai_bot", DEFAULTS, SECRET)


def valid_model(m):
    return bool(re.fullmatch(r"[A-Za-z0-9._:/-]{1,80}", str(m or "")))


def set_cfg(cfg):
    out = {k: cfg.get(k, v) for k, v in DEFAULTS.items()}
    if out["provider"] not in PROVIDERS:
        raise ValueError("Provedor inválido")
    for k in ("gemini_model", "groq_model"):
        m = str(out[k] or "").strip() or DEFAULTS[k]
        if not valid_model(m):
            raise ValueError("Nome de modelo inválido")
        out[k] = m
    for k in ("enabled", "any_host", "diary", "actions", "new_devices", "actions_ports", "actions_reboot"):
        out[k] = bool(out[k])
    try:
        out["revert_min"] = int(out["revert_min"])
    except (TypeError, ValueError):
        raise ValueError("Volta automática inválida")
    if not 0 <= out["revert_min"] <= 1440:
        raise ValueError("Volta automática deve ficar entre 0 (não religar) e 1440 min")
    ra = out["restart_all"] if isinstance(out["restart_all"], list) else []
    out["restart_all"] = [k for k in RESTART_ITEMS if k in ra]
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(out["diary_time"] or "")):
        raise ValueError("Horário do diário inválido (use HH:MM)")
    security.save_secret_cfg("ai_bot", out, SECRET)


def status():
    return dict(_state)


def _err(msg):
    _state["last_error"], _state["last_error_ts"] = str(msg)[:200], time.time()


# ------------------------------------------------------------------ formatação
def _hm(ts):
    return datetime.fromtimestamp(ts).strftime("%d/%m %H:%M") if ts else None


def _dur(s):
    s = int(max(0, s or 0))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}min"
    if s < 86400:
        return f"{s // 3600}h{(s % 3600) // 60:02d}"
    return f"{s // 86400}d {(s % 86400) // 3600}h"


def _r(v, d=1):
    try:
        return None if v is None else round(float(v), d)
    except (TypeError, ValueError):
        return None


def _ms(v):
    v = _r(v)
    return "--" if v is None else (str(int(round(v))) if v >= 100 else f"{v:.1f}").replace(".", ",")


def _pct(v, d=1):
    v = _r(v, d)
    return "--" if v is None else (f"{v:.{d}f}").replace(".", ",")


def _bps(v):
    v = float(v or 0)
    for u, k in (("Gbps", 1e9), ("Mbps", 1e6), ("kbps", 1e3)):
        if v >= k:
            return f"{v / k:.1f} {u}".replace(".", ",")
    return f"{int(v)} bps"



HELP = ("🤖 Comandos:\n"
        "/status — resumo da rede\n"
        "/ping <destino ou IP> [n] — ping agora\n"
        "/trace <destino ou IP> — traceroute\n"
        "/alertas — incidentes abertos e das últimas 24 h\n"
        "/mk — MikroTik\n"
        "/diagnostico [destino] — investiga a causa agora\n"
        "/diario — resumo das últimas 24 h\n"
        "/banda — quem está usando a internet agora\n"
        "/aparelhos — aparelhos da rede e os novos\n"
        "/pppoe — reiniciar a conexão (pede confirmação)\n"
        "/acordar <aparelho> — liga o PC pela rede\n"
        "/bloquear <aparelho> · /desbloquear <aparelho> · /bloqueados\n"
        "/cameras [nome ou número] — foto das câmeras agora\n"
        "/portas — portas do MikroTik\n"
        "/desligar <porta ou pppoe> [min] · /religar <porta>\n"
        "/reiniciar mikrotik | dvr | servidor | netnoc | tudo\n"
        "/medir [segundos] — velocidade real da internet (rode um speedtest junto)\n"
        "/log [pppoe|system|texto] — log do MikroTik\n"
        "/backup — manda o backup da configuração agora\n"
        "/saude — saúde do NetNOC, último backup e vigia externo\n"
        "/limpar — esquece a conversa\n")


def _strip_acc(s):
    import unicodedata
    return "".join(ch for ch in unicodedata.normalize("NFD", s) if unicodedata.category(ch) != "Mn")


def handle(text, chat):
    """Resposta para uma mensagem do dono: texto, ou (texto, teclado) quando pede confirmação."""
    _ctx.chat = str(chat)
    text = (text or "").strip()
    if not text:
        return None
    cfg = get_cfg()
    ai = (cfg["provider"] == "gemini" and cfg["gemini_key"]) or (cfg["provider"] == "groq" and cfg["groq_key"])
    m = re.match(r"^/(\w+)(?:@\w+)?\s*(.*)$", text, re.S)
    try:
        if m:
            c, arg = m.group(1).lower(), m.group(2)
            if c in ("start", "ajuda", "help"):
                return HELP + ("\nOu pergunte em português, ex.: \"como está o ping pro Google?\"" if ai else
                               "\nPara perguntar em português, ative uma IA em Configurações → Alertas.")
            if c == "status":
                return cmd_status()
            if c == "ping":
                return cmd_ping(arg)
            if c in ("trace", "traceroute"):
                return cmd_trace(arg)
            if c in ("alertas", "incidentes"):
                return cmd_alertas()
            if c in ("mk", "mikrotik"):
                return cmd_mk()
            if c in ("diagnostico", "diag", "diagnóstico"):
                from netnoc.analise import diagnose
                names = []
                if arg.strip():
                    t = _find_target(arg.strip())
                    if not t:
                        return f"Não achei o destino '{arg.strip()}'. Use o nome cadastrado."
                    names = [t["name"]]
                if not _rate_ok():
                    return "⚠️ Limite de testes por minuto atingido, tente em instantes."
                with diagnose._lock:
                    d = diagnose.investigate("check", names)
                return diagnose.format_text(d)
            if c == "banda":
                return cmd_banda()
            if c == "aparelhos":
                return cmd_aparelhos()
            if c == "bloqueados":
                return cmd_bloqueados()
            if c in ("pppoe", "reconectar"):
                return propose(chat, "pppoe")
            if c in ("acordar", "wol", "ligar"):
                return propose(chat, "wake", arg)
            if c == "bloquear":
                return propose(chat, "block", arg)
            if c in ("desbloquear", "liberar"):
                return propose(chat, "unblock", arg)
            if c in ("cameras", "câmeras", "camera", "câmera", "fotos"):
                return cmd_cameras(chat, arg) or "📷 Enviado."
            if c == "portas":
                return cmd_portas()
            if c in ("desligar", "desativar"):
                mm = re.match(r"^(.*?)(?:\s+(\d{1,4})\s*(?:min|m)?)?$", arg.strip())
                return propose(chat, "port_off", (mm.group(1).strip(), int(mm.group(2)) if mm.group(2) else None))
            if c in ("religar", "ativar", "ligarporta"):
                return propose(chat, "port_on", (arg.strip(), None))
            if c == "reiniciar":
                alvo = _strip_acc(arg.strip().lower())
                kmap = {"mikrotik": "reboot_mikrotik", "roteador": "reboot_mikrotik", "mk": "reboot_mikrotik", "dvr": "reboot_dvr",
                        "cameras": "reboot_dvr", "servidor": "reboot_servidor", "pi": "reboot_servidor", "raspberry": "reboot_servidor",
                        "netnoc": "reboot_netnoc", "tudo": "reboot_all", "": "reboot_all"}
                if alvo not in kmap:
                    return "Uso: /reiniciar mikrotik | dvr | servidor | netnoc | tudo"
                return propose(chat, kmap[alvo])
            if c in ("diario", "diário", "resumo"):
                from netnoc.analise import story
                return story.diary(24)
            if c == "backup":
                from netnoc.nucleo import guarda
                threading.Thread(target=guarda.run_backup, args=("pedido no Telegram",), daemon=True).start()
                return "💾 Gerando o backup, chega em instantes."
            if c in ("medir", "velocidade", "speedtest"):
                from netnoc.coleta import medir
                mm = re.match(r"^\s*(\d{1,3})?", arg or "")
                st = medir.start(int(mm.group(1)) if mm and mm.group(1) else medir.DEFAULT_S, who="telegram",
                                 on_done=_medir_done(str(chat)))
                return (f"📶 Medindo a internet ({st['iface']}) por {st['seconds']} s.\n"
                        "Rode um speedtest AGORA no celular ou no PC (fast.com, speedtest.net). O resultado chega aqui.")
            if c == "log":
                return cmd_log(arg)
            if c in ("saude", "saúde", "health"):
                return cmd_saude()
            if c == "limpar":
                _hist.pop(chat, None)
                return "Conversa esquecida."
            return "Comando desconhecido.\n\n" + HELP
        if not ai:
            return "IA desativada: use os comandos.\n\n" + HELP
        txt, _ = ask(text, chat, cfg)
        return txt
    except (ValueError, RuntimeError) as e:
        return f"⚠️ {e}"
    except Exception as e:
        if type(e).__name__ == "ActionError":
            return f"⚠️ {e}"
        _err(f"comando: {type(e).__name__}")
        return f"⚠️ Erro interno ({type(e).__name__})."


# ------------------------------------------------------------------ Telegram
def _tg(token, method, http_timeout=15, **data):
    r = requests.post(f"https://api.telegram.org/bot{token}/{method}", data=data, timeout=http_timeout)
    try:
        j = r.json()
    except ValueError:
        j = {"ok": False, "description": f"HTTP {r.status_code}"}
    return r.status_code, j


def _send(token, chat, text, markup=None):
    text = text or "…"
    parts = [text[i:i + 4000] for i in range(0, len(text), 4000)]    # limite do Telegram: 4096 por mensagem
    for n, part in enumerate(parts):
        extra = {"reply_markup": json.dumps(markup)} if markup and n == len(parts) - 1 else {}
        try:
            _tg(token, "sendMessage", chat_id=chat, text=part, disable_web_page_preview="true", **extra)
        except Exception as e:
            _err(f"envio: {type(e).__name__}")


def _edit(token, chat, msg_id, text):
    try:
        _tg(token, "editMessageText", chat_id=chat, message_id=msg_id, text=text[:4000],
            reply_markup=json.dumps({"inline_keyboard": []}))
    except Exception as e:
        _err(f"edição: {type(e).__name__}")


def _callback(token, cq):
    """Toque num botão Sim/Cancelar."""
    try:
        _tg(token, "answerCallbackQuery", http_timeout=5, callback_query_id=cq.get("id"))
    except Exception:
        pass
    msg = cq.get("message") or {}
    chat, mid = str((msg.get("chat") or {}).get("id", "")), msg.get("message_id")
    m = re.match(r"^a:([\w-]+):([yn])$", str(cq.get("data") or ""))
    if not m:
        return
    p = _pending.pop(m.group(1), None)
    orig = (msg.get("text") or "").strip()
    if not p or p["chat"] != chat or p["exp"] < time.time():
        _edit(token, chat, mid, orig + "\n\n⌛ Expirou. Peça de novo.")
        return
    if m.group(2) == "n":
        _edit(token, chat, mid, orig + ("\n\n👍 Ok, anotado como seu." if p.get("newdev") else "\n\n✖ Cancelado."))
        return
    _edit(token, chat, mid, orig + "\n\n⏳ Executando…")
    _edit(token, chat, mid, orig + "\n\n" + execute(p))


def _process(token, chat, text):
    try:
        try:
            _tg(token, "sendChatAction", http_timeout=5, chat_id=chat, action="typing")
        except Exception:
            pass
        r = handle(text, chat)
        if isinstance(r, tuple):
            _send(token, chat, r[0], r[1])
        else:
            _send(token, chat, r)
    except Exception as e:
        _err(f"mensagem: {type(e).__name__}")


def _loop():
    offset, backoff, started = None, 2, time.time()
    _state["running"] = True
    while True:
        try:
            tg = monitor.get_telegram()
            cfg = get_cfg()
            token, owner = tg.get("bot_token"), str(tg.get("chat_id") or "").strip()
            if not (cfg["enabled"] and token and owner):
                time.sleep(10)
                continue
            params = {"timeout": 50, "allowed_updates": json.dumps(["message", "callback_query"])}
            if offset is not None:
                params["offset"] = offset
            code, j = _tg(token, "getUpdates", http_timeout=65, **params)
            if not j.get("ok"):
                desc = str(j.get("description") or f"HTTP {code}")
                if code == 409:
                    desc = "outro programa já está lendo este bot (webhook ou outra instância do NetNOC)"
                _err(f"Telegram: {desc}")
                time.sleep(min(backoff, 60))
                backoff = min(backoff * 2, 60)
                continue
            backoff = 2
            for u in j.get("result") or []:
                offset = u["update_id"] + 1
                cq = u.get("callback_query")
                if cq:
                    cchat = str(((cq.get("message") or {}).get("chat") or {}).get("id", ""))
                    if cchat == owner and str((cq.get("from") or {}).get("id", "")) and cchat:
                        _state["last_msg_ts"] = time.time()
                        _pool.submit(_callback, token, cq)
                    else:
                        _state["ignored"] += 1
                    continue
                msg = u.get("message") or {}
                chat = str((msg.get("chat") or {}).get("id", ""))
                if chat != owner:
                    _state["ignored"] += 1          # só o dono conversa com o bot
                    continue
                if (msg.get("date") or 0) < started - 120:
                    continue                         # não responde ao acúmulo de quando o NetNOC estava parado
                _state["last_msg_ts"] = time.time()
                _pool.submit(_process, token, chat, msg.get("text") or "")
        except Exception as e:
            # nunca str(e): a exceção do requests traz a URL, que contém o token do bot
            _err(f"Telegram: {type(e).__name__}")
            time.sleep(min(backoff, 60))
            backoff = min(backoff * 2, 60)


def start(api):
    """api: funções do main.py (overview, targets, incidents, series, uptime, mikrotik_status,
    mikrotik_ifaces, dns, wan_peak, system). Inicia o leitor do Telegram em segundo plano."""
    _api.update(api)
    if on_new_devices not in monitor.NEW_DEVICE_HOOKS:
        monitor.NEW_DEVICE_HOOKS.append(on_new_devices)
    threading.Thread(target=_restart_notice, name="aibot-volta", daemon=True).start()
    try:
        from netnoc.bot import actions
        actions.resume_local_reverts()         # porta desligada com volta pelo NetNOC: retoma depois de um reinício
    except Exception as e:
        print(f"[aibot] volta automática: {e}", flush=True)
    if not _state.get("thread"):
        th = threading.Thread(target=_loop, name="aibot", daemon=True)
        _state["thread"] = True
        th.start()


# dependências entre os módulos do bot: no fim do arquivo porque há ciclos (só usadas na hora da chamada)
from netnoc.bot.comandos import cmd_alertas, cmd_aparelhos, cmd_banda, cmd_bloqueados, cmd_cameras, cmd_log, cmd_mk, cmd_ping, cmd_portas, cmd_saude, cmd_status, cmd_trace  # noqa: E402
from netnoc.bot.confirmar import _restart_notice, execute, on_new_devices, propose  # noqa: E402
from netnoc.bot.ferramentas import _find_target, _medir_done, _rate_ok  # noqa: E402
from netnoc.bot.ia import ask  # noqa: E402


# reexporta as partes que saíram deste arquivo (v4.4): o resto do projeto e os testes continuam usando aibot.X
from netnoc.bot import comandos as _comandos, confirmar as _confirmar, ferramentas as _ferramentas, ia as _ia  # noqa: E402
for _m in (_ferramentas, _ia, _comandos, _confirmar):
    for _k, _v in vars(_m).items():
        if not _k.startswith("__") and not isinstance(_v, type(threading)):
            globals().setdefault(_k, _v)
del _m, _k, _v

