import sqlite3, time, threading, os

# Dois arquivos:
#   netnoc.db            -> só configuração e equipamentos (settings, dhcp_hosts): pequeno, vai no backup
#   netnoc-historico.db  -> medições, incidentes, eventos, logs: pode ser apagado a qualquer momento
# O histórico é anexado (ATTACH ... AS h) na mesma conexão, então as consultas continuam iguais.
DB_PATH = os.environ.get("NETNOC_DB", "netnoc.db")
HIST_PATH = os.environ.get("NETNOC_HIST_DB") or os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "netnoc-historico.db")
HIST_TABLES = ("pings", "pings_5m", "pings_1h", "port_checks", "dns_checks", "speedtests", "incidents", "events",
               "meta", "snmp_samples", "audit_log", "mikrotik_resource", "mikrotik_iface", "agh_stats")
_lock = threading.RLock()          # único escritor
_local = threading.local()         # conexões de leitura por thread
_wconn = None


def _connect(readonly=False):
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ? AS h", (HIST_PATH,))
    if not readonly:
        # auto_vacuum só vale se definido ANTES de entrar em WAL (e em banco novo)
        for sch in ("main", "h"):
            conn.execute(f"PRAGMA {sch}.auto_vacuum=INCREMENTAL")
            conn.execute(f"PRAGMA {sch}.journal_mode=WAL")
            conn.execute(f"PRAGMA {sch}.journal_size_limit=33554432")
    conn.execute("PRAGMA main.synchronous=NORMAL")
    conn.execute("PRAGMA h.synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=15000")
    if readonly:
        conn.execute("PRAGMA query_only=ON")
    return conn


def _writer():
    global _wconn
    if _wconn is None:
        _wconn = _connect()
    return _wconn


def _reader():
    c = getattr(_local, "conn", None)
    if c is None:
        c = _local.conn = _connect(readonly=True)
    return c


SCHEMA_CFG = """
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS dhcp_hosts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac TEXT UNIQUE, ip TEXT, hostname TEXT, active INTEGER,
    first_seen REAL, last_seen REAL, promoted_target TEXT
);
"""

SCHEMA_HIST = """
CREATE TABLE IF NOT EXISTS h.pings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT, ts REAL, latency REAL, success INTEGER, jitter REAL
);

CREATE INDEX IF NOT EXISTS h.idx_pings_target_ts ON pings(target, ts);

CREATE INDEX IF NOT EXISTS h.idx_pings_ts ON pings(ts);

CREATE INDEX IF NOT EXISTS h.idx_pings_fail ON pings(target, ts) WHERE success=0;

CREATE TABLE IF NOT EXISTS h.pings_5m(
    target TEXT, bucket INTEGER, n INTEGER, ok INTEGER,
    lat_sum REAL, lat_max REAL, jit_sum REAL,
    PRIMARY KEY(target, bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS h.pings_1h(
    target TEXT, bucket INTEGER, n INTEGER, ok INTEGER,
    lat_sum REAL, lat_max REAL, jit_sum REAL,
    PRIMARY KEY(target, bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS h.port_checks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, ip TEXT, port INTEGER, proto TEXT, ts REAL, is_open INTEGER, latency REAL
);

CREATE INDEX IF NOT EXISTS h.idx_ports_ts ON port_checks(ip, port, ts);

CREATE TABLE IF NOT EXISTS h.dns_checks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server TEXT, ts REAL, latency REAL, success INTEGER
);

CREATE INDEX IF NOT EXISTS h.idx_dns_server_ts ON dns_checks(server, ts);

CREATE TABLE IF NOT EXISTS h.speedtests(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, download REAL, upload REAL, latency REAL
);

CREATE INDEX IF NOT EXISTS h.idx_speed_ts ON speedtests(ts);

CREATE TABLE IF NOT EXISTS h.incidents(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, target TEXT, message TEXT, severity TEXT,
    started_ts REAL, resolved_ts REAL
);

CREATE INDEX IF NOT EXISTS h.idx_inc_started ON incidents(started_ts);

CREATE INDEX IF NOT EXISTS h.idx_inc_open ON incidents(resolved_ts);

CREATE TABLE IF NOT EXISTS h.events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, message TEXT, severity TEXT
);

CREATE INDEX IF NOT EXISTS h.idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS h.meta(key TEXT PRIMARY KEY, value TEXT, ts REAL);

CREATE TABLE IF NOT EXISTS h.snmp_samples(
    ts REAL, device TEXT, key TEXT, value REAL
);

CREATE INDEX IF NOT EXISTS h.idx_snmp_dev_key_ts ON snmp_samples(device, key, ts);

CREATE INDEX IF NOT EXISTS h.idx_snmp_ts ON snmp_samples(ts);

CREATE TABLE IF NOT EXISTS h.audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, user TEXT, ip TEXT, action TEXT, detail TEXT
);

CREATE INDEX IF NOT EXISTS h.idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS h.mikrotik_resource(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, cpu_load REAL, uptime_s INTEGER,
    free_memory INTEGER, total_memory INTEGER,
    free_hdd INTEGER, total_hdd INTEGER,
    temperature REAL, board_name TEXT, version TEXT
);

CREATE INDEX IF NOT EXISTS h.idx_mikrotik_resource_ts ON mikrotik_resource(ts);

CREATE TABLE IF NOT EXISTS h.mikrotik_iface(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, name TEXT, running INTEGER, disabled INTEGER,
    rx_bytes INTEGER, tx_bytes INTEGER, rx_bps REAL, tx_bps REAL
);

CREATE INDEX IF NOT EXISTS h.idx_mikrotik_iface_ts ON mikrotik_iface(name, ts);

CREATE TABLE IF NOT EXISTS h.agh_stats(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, num_dns_queries INTEGER, num_blocked_filtering INTEGER,
    num_replaced_safebrowsing INTEGER, num_replaced_parental INTEGER,
    avg_processing_time REAL
);

CREATE INDEX IF NOT EXISTS h.idx_agh_stats_ts ON agh_stats(ts);
"""


def init_db():
    with _lock:
        c = _writer()
        # bancos antigos: auto_vacuum estava desligado de fato -> converte (VACUUM único)
        if c.execute("PRAGMA main.auto_vacuum").fetchone()[0] != 2:
            c.execute("PRAGMA main.auto_vacuum=INCREMENTAL")
            c.execute("VACUUM main")
        c.executescript(SCHEMA_CFG)
        c.executescript(SCHEMA_HIST)
        c.commit()
        _migrate_history(c)
        cols = [r[1] for r in c.execute("PRAGMA table_info(dhcp_hosts)").fetchall()]
        if cols and "promoted_target" not in cols:
            c.execute("ALTER TABLE dhcp_hosts ADD COLUMN promoted_target TEXT")
            c.commit()


def _migrate_history(c):
    """Bancos de versões anteriores: move as medições de netnoc.db para netnoc-historico.db (uma vez)."""
    old = {r[0] for r in c.execute("SELECT name FROM main.sqlite_master WHERE type='table'")}
    moving = [t for t in HIST_TABLES if t in old]
    if not moving:
        return
    print(f"[db] separando o histórico em {os.path.basename(HIST_PATH)}: {', '.join(moving)}", flush=True)
    for t in moving:
        cols = [r[1] for r in c.execute(f"PRAGMA main.table_info({t})")]
        hcols = {r[1] for r in c.execute(f"PRAGMA h.table_info({t})")}
        cl = ",".join(x for x in cols if x in hcols)
        n = c.execute(f"SELECT COUNT(*) FROM main.{t}").fetchone()[0]
        c.execute(f"INSERT OR IGNORE INTO h.{t}({cl}) SELECT {cl} FROM main.{t}")
        c.execute(f"DROP TABLE main.{t}")
        c.commit()
        print(f"[db]   {t}: {n} linhas", flush=True)
    c.execute("VACUUM main")                # devolve o espaço: netnoc.db fica só com a configuração
    c.commit()
    try:
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()   # sem isso o espaço só volta no próximo checkpoint
    except Exception:
        pass
    print(f"[db] pronto: netnoc.db agora tem só a configuração", flush=True)


def sizes():
    """Tamanho em bytes de cada arquivo (com o WAL)."""
    def sz(p):
        return sum(os.path.getsize(p + x) for x in ("", "-wal") if os.path.exists(p + x))
    return {"config": sz(DB_PATH), "history": sz(HIST_PATH)}


def execute(query, params=()):
    with _lock:
        c = _writer()
        cur = c.execute(query, params)
        c.commit()
        return cur.lastrowid


def executemany(query, rows):
    if not rows:
        return
    with _lock:
        c = _writer()
        c.executemany(query, rows)
        c.commit()


def query(query, params=()):
    cur = _reader().execute(query, params)
    try:
        return [dict(r) for r in cur.fetchall()]
    finally:
        cur.close()


def query_w(query, params=()):
    """Leitura pelo escritor (leitura-após-escrita consistente)."""
    with _lock:
        cur = _writer().execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]
        cur.close()
        return rows


def insert_pings(rows):
    """rows: (target, ts, latency, success, jitter) — um commit por ciclo."""
    executemany("INSERT INTO pings(target,ts,latency,success,jitter) VALUES(?,?,?,?,?)", rows)


def set_meta(key, value):
    execute("INSERT INTO meta(key,value,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
            (key, str(value), time.time()))


def set_meta_many(items):
    now = time.time()
    executemany("INSERT INTO meta(key,value,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
                [(k, str(v), now) for k, v in items.items()])


def get_meta(key, default=None):
    r = query_w("SELECT value FROM meta WHERE key=?", (key,))
    return r[0]["value"] if r else default


def set_setting(key, value_json):
    execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value_json))


def get_setting(key, default=None):
    r = query_w("SELECT value FROM settings WHERE key=?", (key,))
    return r[0]["value"] if r else default


def audit(user, ip, action, detail=""):
    try:
        execute("INSERT INTO audit_log(ts,user,ip,action,detail) VALUES(?,?,?,?,?)",
                (time.time(), user, ip, action, str(detail)[:500]))
    except Exception:
        pass


def clear_history():
    """Apaga todas as medições/incidentes/eventos (arquivo de histórico) e devolve o espaço em disco.
    A configuração (netnoc.db) não é tocada. Mantém só os valores "do momento" em meta."""
    with _lock:
        c = _writer()
        for t in HIST_TABLES:
            if t == "meta":
                c.execute("DELETE FROM h.meta WHERE key IN ('rollup5_end','rollup1_end')")
            else:
                c.execute(f"DELETE FROM h.{t}")
        c.commit()
        c.execute("VACUUM h")
        try:
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        except Exception:
            pass


# ---------- rollups ----------
def rollup_chunk(src, dst, bucket_s, start, end):
    """Agrega [start,end) em buckets; idempotente (REPLACE). src='pings' ou tabela de rollup."""
    with _lock:
        c = _writer()
        if src == "pings":
            c.execute(f"""INSERT OR REPLACE INTO {dst}(target,bucket,n,ok,lat_sum,lat_max,jit_sum)
                SELECT target, CAST(ts/{bucket_s} AS INTEGER)*{bucket_s}, COUNT(*), SUM(success),
                       COALESCE(SUM(latency),0), COALESCE(MAX(latency),0), COALESCE(SUM(jitter),0)
                FROM pings WHERE ts>=? AND ts<? GROUP BY target, CAST(ts/{bucket_s} AS INTEGER)""", (start, end))
        else:
            c.execute(f"""INSERT OR REPLACE INTO {dst}(target,bucket,n,ok,lat_sum,lat_max,jit_sum)
                SELECT target, CAST(bucket/{bucket_s} AS INTEGER)*{bucket_s}, SUM(n), SUM(ok),
                       SUM(lat_sum), MAX(lat_max), SUM(jit_sum)
                FROM {src} WHERE bucket>=? AND bucket<? GROUP BY target, CAST(bucket/{bucket_s} AS INTEGER)""",
                (start, end))
        c.commit()


def prune_old(days, raw_days=7, hourly_days=365):
    now = time.time()
    cutoff = now - days * 86400
    raw_cut = now - min(raw_days, days) * 86400
    execute("DELETE FROM pings WHERE ts < ?", (raw_cut,))
    execute("DELETE FROM pings_5m WHERE bucket < ?", (cutoff,))
    execute("DELETE FROM pings_1h WHERE bucket < ?", (now - hourly_days * 86400,))
    for t in ("port_checks", "dns_checks", "mikrotik_resource", "mikrotik_iface", "agh_stats"):
        execute(f"DELETE FROM {t} WHERE ts < ?", (cutoff,))
    execute("DELETE FROM events WHERE ts < ?", (now - max(days, 90) * 86400,))
    execute("DELETE FROM audit_log WHERE ts < ?", (now - 365 * 86400,))
    vacuum_incremental()
    checkpoint()


def vacuum_incremental():
    with _lock:
        c = _writer()
        for sch in ("main", "h"):
            cur = c.execute(f"PRAGMA {sch}.incremental_vacuum")
            cur.fetchall()      # sem consumir o cursor quase nada é liberado
            cur.close()
        c.commit()


def checkpoint():
    with _lock:
        try:
            _writer().execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        except Exception:
            pass


def vacuum_full():
    with _lock:
        c = _writer()
        c.commit()
        c.execute("VACUUM main")
        c.execute("VACUUM h")
        checkpoint()
