"""Bot do Telegram com IA opcional (Gemini ou Groq).

Você pergunta pelo Telegram ("como está o ping pro Google?") e o NetNOC responde com dados reais:
a IA escolhe as ferramentas (ping agora, histórico, incidentes, MikroTik…), o NetNOC executa e a IA
escreve o relatório. Sem IA configurada, os comandos /status, /ping, /trace, /alertas, /mk funcionam igual.

Segurança:
- Só responde ao chat_id configurado em Telegram (os outros são ignorados).
- As ferramentas são só de leitura: nada é alterado, nenhum comando livre é executado.
- Ping/traceroute com host validado, limite de quantidade e de uso por minuto.
- Chaves das IAs cifradas no banco (mesmo esquema das outras senhas); erros nunca expõem chave/token.
"""
import json, re, subprocess, threading, time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import requests

import db
import monitor
import security

# ------------------------------------------------------------------ configuração
SECRET = ("gemini_key", "groq_key")
DEFAULTS = {
    "enabled": False,               # bot responde mensagens (os alertas continuam no switch do Telegram)
    "provider": "none",             # none | gemini | groq
    "gemini_key": "", "gemini_model": "gemini-3.5-flash-lite",
    "groq_key": "", "groq_model": "openai/gpt-oss-120b",
    "any_host": True,               # ping/traceroute para endereços fora dos destinos cadastrados
}
PROVIDERS = ("none", "gemini", "groq")
MAX_ROUNDS = 6                      # chamadas de ferramenta por pergunta
PING_MAX = 10                       # pings por chamada
TOOL_RATE = 20                      # pings/traceroutes por minuto (somados)
HIST_TTL = 15 * 60                  # memória curta da conversa
HIST_LEN = 8                        # mensagens guardadas (usuário + bot)

_api = {}                           # funções do main.py (overview, targets, incidents, …), via start()
_state = {"last_error": "", "last_error_ts": None, "last_msg_ts": None, "running": False, "ignored": 0}
_hist = {}                          # chat_id -> deque[(ts, role, text)]
_tool_ts = deque()
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="aibot")


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
    out["enabled"], out["any_host"] = bool(out["enabled"]), bool(out["any_host"])
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
    cmd = ["ping", "-n", "-c", str(n), "-i", "0.3", "-W", "1", host]
    if monitor.IS_WINDOWS:
        cmd = ["ping", "-n", str(n), "-w", "1000", host]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=n * 1.5 + 5)
        out = p.stdout
        if p.returncode == 2 and not out and "-i" in cmd:          # ping sem suporte a -i (ex.: busybox antigo)
            cmd = [c for i, c in enumerate(cmd) if c != "-i" and (i == 0 or cmd[i - 1] != "-i")]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=n * 2 + 5).stdout
    except subprocess.TimeoutExpired:
        return [None] * n
    except FileNotFoundError:
        raise RuntimeError("comando ping não encontrado no servidor")
    got = [float(x) for x in re.findall(r"time[=<]([\d.]+)", out)]
    return got + [None] * max(0, n - len(got))


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
        import checks
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
    import checks
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


def tool_speedtest():
    rows = _api["speedtests"](limit=6)
    return {"testes": [{"quando": _hm(r["ts"]), "download_mbps": _r(r.get("download")), "upload_mbps": _r(r.get("upload")),
                        "latencia_ms": _r(r.get("latency"))} for r in rows]}


def tool_servidor():
    s = _api["system"]()
    return {"host": s.get("host_label"), "versao_netnoc": s.get("version"), "cpu_pct": s.get("cpu_pct"),
            "ram_pct": s.get("mem_pct"), "temperatura_c": s.get("temp_c"), "disco_pct": s.get("disk_pct"),
            "ligado_ha": _dur(s.get("host_uptime_s")) if s.get("host_uptime_s") else None,
            "netnoc_rodando_ha": _dur(s.get("app_uptime_s")), "coletores_com_problema": s.get("workers_bad")}


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
    ("speedtest", tool_speedtest, "Últimos testes de velocidade (download, upload, latência).", {}, []),
    ("servidor", tool_servidor, "Servidor onde roda o NetNOC: CPU, RAM, temperatura, disco e coletores.", {}, []),
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


# ------------------------------------------------------------------ IA
def _system_prompt():
    names = ", ".join(t["name"] for t in monitor.get_targets()) or "nenhum"
    return (
        f"Você é o assistente do {monitor.get_app_name()}, o painel de monitoramento da rede do usuário. "
        f"Agora são {datetime.now().strftime('%d/%m/%Y %H:%M')}. Destinos cadastrados: {names}.\n"
        "Regras:\n"
        "- Responda em português do Brasil, curto e direto, como um analista de NOC falando com o dono da rede.\n"
        "- Texto puro para o Telegram: NADA de markdown (sem **, #, ``` ou tabelas). Use quebras de linha e poucos emojis (✅ ⚠️ ❌ 📶).\n"
        "- Para qualquer dado da rede use as ferramentas. Nunca invente números. Se uma ferramenta der erro, diga qual.\n"
        "- No ping, compare com o histórico de 24h quando houver e diga se está normal, pior ou melhor.\n"
        "- Latência: até 30 ms ótima, 30–80 ms ok, acima de 100 ms ruim. Perda acima de 1% merece atenção.\n"
        "- Se o pedido não tiver relação com a rede, responda em uma frase que você cuida só do monitoramento."
    )


def _decls_openai():
    return [{"type": "function", "function": {"name": n, "description": d,
             "parameters": {"type": "object", "properties": p, "required": r}}} for n, _, d, p, r in TOOLS]


def _decls_gemini():
    out = []
    for n, _, d, p, r in TOOLS:
        dd = {"name": n, "description": d}
        if p:
            dd["parameters"] = {"type": "object", "properties": p, "required": r}
        out.append(dd)
    return [{"functionDeclarations": out}]


def _http_err(r, who):
    try:
        j = r.json()
        msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error")
    except Exception:
        msg = ""
    code = {400: "requisição recusada", 401: "chave inválida", 403: "chave sem permissão", 404: "modelo não encontrado",
            429: "limite da cota grátis atingido, tente em 1 minuto"}.get(r.status_code, f"HTTP {r.status_code}")
    msg = re.sub(r"(AIza|gsk_)[A-Za-z0-9_\-]+", "***", str(msg or ""))[:160]
    return RuntimeError(f"{who}: {code}" + (f" ({msg})" if msg and r.status_code not in (401, 429) else ""))


def _post(url, headers, body, who):
    try:
        r = requests.post(url, headers=headers, json=body, timeout=45)
    except requests.Timeout:
        raise RuntimeError(f"{who}: sem resposta (timeout)")
    except Exception as e:
        raise RuntimeError(f"{who}: {type(e).__name__}")
    if not r.ok:
        raise _http_err(r, who)
    return r.json()


def ask_groq(cfg, history, question, tools=True):
    msgs = [{"role": "system", "content": _system_prompt()}]
    msgs += [{"role": "user" if role == "u" else "assistant", "content": txt} for _, role, txt in history]
    msgs.append({"role": "user", "content": question})
    url = "https://api.groq.com/openai/v1/chat/completions"
    hdr = {"Authorization": f"Bearer {cfg['groq_key']}"}
    used = []
    for _ in range(MAX_ROUNDS + 1):
        body = {"model": cfg["groq_model"], "messages": msgs, "temperature": 0.3, "max_tokens": 2048}
        if cfg["groq_model"].startswith("openai/gpt-oss"):
            body["reasoning_effort"] = "low"      # raciocínio curto: resposta mais rápida e sem estourar max_tokens
        if tools and len(used) < MAX_ROUNDS:
            body["tools"], body["tool_choice"] = _decls_openai(), "auto"
        j = _post(url, hdr, body, "Groq")
        m = (j.get("choices") or [{}])[0].get("message") or {}
        calls = m.get("tool_calls") or []
        if not calls:
            txt = (m.get("content") or "").strip()
            if not txt:
                raise RuntimeError("Groq: resposta vazia (" + str((j.get("choices") or [{}])[0].get("finish_reason")) + ")")
            return txt, used
        msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
        for c in calls:
            fn = c.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            used.append(fn.get("name"))
            res = run_tool(fn.get("name"), args)
            msgs.append({"role": "tool", "tool_call_id": c.get("id"), "content": json.dumps(res, ensure_ascii=False, default=str)[:12000]})
    return "Não consegui fechar a resposta (muitas consultas). Tente uma pergunta mais específica.", used


def ask_gemini(cfg, history, question, tools=True):
    contents = [{"role": "user" if role == "u" else "model", "parts": [{"text": txt}]} for _, role, txt in history]
    contents.append({"role": "user", "parts": [{"text": question}]})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{cfg['gemini_model']}:generateContent"
    hdr = {"x-goog-api-key": cfg["gemini_key"]}
    used = []
    for _ in range(MAX_ROUNDS + 1):
        body = {"systemInstruction": {"parts": [{"text": _system_prompt()}]}, "contents": contents,
                "generationConfig": {"maxOutputTokens": 4096}}   # Gemini 3 recomenda a temperatura padrão
        if tools and len(used) < MAX_ROUNDS:
            body["tools"] = _decls_gemini()
        j = _post(url, hdr, body, "Gemini")
        cand = (j.get("candidates") or [{}])[0]
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        if not calls:
            txt = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
            if not txt and cand.get("finishReason") not in (None, "STOP"):
                raise RuntimeError(f"Gemini: resposta bloqueada ({cand.get('finishReason')})")
            return txt, used
        contents.append({"role": "model", "parts": parts})   # devolve como veio (inclui thoughtSignature)
        resp = []
        for c in calls:
            used.append(c.get("name"))
            res = run_tool(c.get("name"), c.get("args") or {})
            resp.append({"functionResponse": {"name": c.get("name"), "response": {"resultado": res}}})
        contents.append({"role": "user", "parts": resp})
    return "Não consegui fechar a resposta (muitas consultas). Tente uma pergunta mais específica.", used


def ask(question, chat="test", cfg=None, tools=True):
    cfg = cfg or get_cfg()
    p = cfg["provider"]
    if p == "gemini" and cfg["gemini_key"]:
        fn = ask_gemini
    elif p == "groq" and cfg["groq_key"]:
        fn = ask_groq
    else:
        raise RuntimeError("IA não configurada")
    now = time.time()
    h = _hist.setdefault(chat, deque(maxlen=HIST_LEN))
    while h and now - h[0][0] > HIST_TTL:
        h.popleft()
    txt, used = fn(cfg, list(h), question, tools)
    txt = _plain(txt) or "Sem resposta da IA."
    h.append((now, "u", question[:1000]))
    h.append((now, "a", txt[:1500]))
    return txt, used


def _plain(t):
    """Tira o markdown que escapar (o Telegram mostraria os asteriscos)."""
    t = re.sub(r"```[a-z]*\n?", "", t or "")
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)
    t = re.sub(r"(?m)^#{1,6}\s*", "", t)
    t = re.sub(r"(?m)^\s*[-*]\s+", "• ", t)
    return t.strip()


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


HELP = ("🤖 Comandos:\n"
        "/status — resumo da rede\n"
        "/ping <destino ou IP> [n] — ping agora\n"
        "/trace <destino ou IP> — traceroute\n"
        "/alertas — incidentes abertos e das últimas 24 h\n"
        "/mk — MikroTik\n"
        "/limpar — esquece a conversa\n")


def handle(text, chat):
    """Resposta (texto) para uma mensagem do dono do bot."""
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


def _send(token, chat, text):
    text = text or "…"
    for i in range(0, len(text), 4000):           # limite do Telegram: 4096 por mensagem
        try:
            _tg(token, "sendMessage", chat_id=chat, text=text[i:i + 4000], disable_web_page_preview="true")
        except Exception as e:
            _err(f"envio: {type(e).__name__}")


def _process(token, chat, text):
    try:
        try:
            _tg(token, "sendChatAction", http_timeout=5, chat_id=chat, action="typing")
        except Exception:
            pass
        _send(token, chat, handle(text, chat))
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
            params = {"timeout": 50, "allowed_updates": json.dumps(["message"])}
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
    mikrotik_ifaces, dns, speedtests, system). Inicia o leitor do Telegram em segundo plano."""
    _api.update(api)
    if not _state.get("thread"):
        th = threading.Thread(target=_loop, name="aibot", daemon=True)
        _state["thread"] = True
        th.start()
