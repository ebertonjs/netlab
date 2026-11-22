"""Constantes do config.json, estado compartilhado em memória (janelas de ping, incidentes ativos) e ganchos.

Parte do antigo monitor.py (v4.4); o monitor.py continua reexportando tudo."""
import time, threading, platform, json




CFG = json.load(open("config.json", encoding="utf-8"))
THRESH = CFG["thresholds"]
OFFLINE_N = int(CFG.get("offline_consecutive_failures", 3))
RECOVER_N = int(CFG.get("recovery_consecutive_ok", 2))
LOSS_MIN_FAILS = int(CFG.get("loss_min_failures", 2))
RAW_DAYS = int(CFG.get("raw_retention_days", 7))
H1_DAYS = int(CFG.get("rollup_1h_retention_days", 365))
IFACE_RAW_DAYS = float(CFG.get("iface_raw_retention_days", 2))     # v4.3: tráfego bruto das portas; depois, médias de 5 min
# janela de avaliação em TEMPO (antes: 20 amostras -> 20 min com ping de 60 s)
WINDOW_S = int(CFG.get("window_seconds", 300))
MIN_SAMPLES = int(CFG.get("window_min_samples", 5))
WINDOW = 240                                   # teto de amostras guardadas em memória
DNS_SLOW_N = int(CFG.get("dns_slow_consecutive", 3))
HOST_LABEL = CFG.get("host_label", "Raspberry Pi")
LOCAL_LABEL = "Conectividade local"

IS_WINDOWS = platform.system().lower().startswith("win")

_state_lock = threading.RLock()
_win = {}                 # target -> deque[(ts, latency, ok, jitter)]
_last_latency = {}
_consec = {}              # target -> [fails, oks]
_active_incidents = {}    # (type,target) -> {id,severity,started_ts}
_pending = {}             # (type,target) -> consecutive bad/ok counters for hysteresis
_next_due = {}
_clean_since = {}         # target -> ts: falhas anteriores não contam para perda/jitter (pós-recuperação)
_inflight = {}            # target -> (target_dict, submitted_ts, future)
_started_at = time.time()
INCIDENT_HOOKS = []       # funções (tipo, alvo, id, severidade) chamadas quando um incidente abre (ex.: diagnóstico)
NEW_DEVICE_HOOKS = []     # funções ([{mac, ip, hostname}]) chamadas quando aparece um MAC nunca visto no DHCP

