import sqlite3, time, threading, os

DB_PATH = os.environ.get("NETNOC_DB", "netnoc.db")
_lock = threading.RLock()          # único escritor
_local = threading.local()         # conexões de leitura por thread
_wconn = None


def _connect(readonly=False):
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    if not readonly:
        # auto_vacuum só vale se definido ANTES de entrar em WAL (e em banco novo)
        conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA journal_size_limit=33554432")
    conn.execute("PRAGMA synchronous=NORMAL")
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


SCHEMA = """
CREATE TABLE IF NOT EXISTS pings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT, ts REAL, latency REAL, success INTEGER, jitter REAL
);
CREATE INDEX IF NOT EXISTS idx_pings_target_ts ON pings(target, ts);
CREATE INDEX IF NOT EXISTS idx_pings_ts ON pings(ts);
CREATE INDEX IF NOT EXISTS idx_pings_fail ON pings(target, ts) WHERE success=0;

CREATE TABLE IF NOT EXISTS pings_5m(
    target TEXT, bucket INTEGER, n INTEGER, ok INTEGER,
    lat_sum REAL, lat_max REAL, jit_sum REAL,
    PRIMARY KEY(target, bucket)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pings_1h(
    target TEXT, bucket INTEGER, n INTEGER, ok INTEGER,
    lat_sum REAL, lat_max REAL, jit_sum REAL,
    PRIMARY KEY(target, bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS port_checks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, ip TEXT, port INTEGER, proto TEXT, ts REAL, is_open INTEGER, latency REAL
);
CREATE INDEX IF NOT EXISTS idx_ports_ts ON port_checks(ip, port, ts);

CREATE TABLE IF NOT EXISTS dns_checks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server TEXT, ts REAL, latency REAL, success INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dns_server_ts ON dns_checks(server, ts);

CREATE TABLE IF NOT EXISTS speedtests(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, download REAL, upload REAL, latency REAL
);
CREATE INDEX IF NOT EXISTS idx_speed_ts ON speedtests(ts);

CREATE TABLE IF NOT EXISTS incidents(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, target TEXT, message TEXT, severity TEXT,
    started_ts REAL, resolved_ts REAL
);
CREATE INDEX IF NOT EXISTS idx_inc_started ON incidents(started_ts);
CREATE INDEX IF NOT EXISTS idx_inc_open ON incidents(resolved_ts);

CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, message TEXT, severity TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS snmp_samples(
    ts REAL, device TEXT, key TEXT, value REAL
);
CREATE INDEX IF NOT EXISTS idx_snmp_dev_key_ts ON snmp_samples(device, key, ts);
CREATE INDEX IF NOT EXISTS idx_snmp_ts ON snmp_samples(ts);

CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, user TEXT, ip TEXT, action TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS dhcp_hosts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac TEXT UNIQUE, ip TEXT, hostname TEXT, active INTEGER,
    first_seen REAL, last_seen REAL, promoted_target TEXT
);

CREATE TABLE IF NOT EXISTS mikrotik_resource(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, cpu_load REAL, uptime_s INTEGER,
    free_memory INTEGER, total_memory INTEGER,
    free_hdd INTEGER, total_hdd INTEGER,
    temperature REAL, board_name TEXT, version TEXT
);
CREATE INDEX IF NOT EXISTS idx_mikrotik_resource_ts ON mikrotik_resource(ts);

CREATE TABLE IF NOT EXISTS mikrotik_iface(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, name TEXT, running INTEGER, disabled INTEGER,
    rx_bytes INTEGER, tx_bytes INTEGER, rx_bps REAL, tx_bps REAL
);
CREATE INDEX IF NOT EXISTS idx_mikrotik_iface_ts ON mikrotik_iface(name, ts);

CREATE TABLE IF NOT EXISTS agh_stats(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL, num_dns_queries INTEGER, num_blocked_filtering INTEGER,
    num_replaced_safebrowsing INTEGER, num_replaced_parental INTEGER,
    avg_processing_time REAL
);
CREATE INDEX IF NOT EXISTS idx_agh_stats_ts ON agh_stats(ts);
"""


def init_db():
    with _lock:
        c = _writer()
        # bancos antigos: auto_vacuum estava desligado de fato -> converte (VACUUM único)
        if c.execute("PRAGMA auto_vacuum").fetchone()[0] != 2:
            c.execute("PRAGMA auto_vacuum=INCREMENTAL")
            c.execute("VACUUM")
        c.executescript(SCHEMA)
        c.commit()
        cols = [r[1] for r in c.execute("PRAGMA table_info(dhcp_hosts)").fetchall()]
        if cols and "promoted_target" not in cols:
            c.execute("ALTER TABLE dhcp_hosts ADD COLUMN promoted_target TEXT")
            c.commit()


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
    with _lock:
        c = _writer()
        c.executescript("""
            DELETE FROM pings; DELETE FROM pings_5m; DELETE FROM pings_1h;
            DELETE FROM port_checks; DELETE FROM dns_checks; DELETE FROM speedtests;
            DELETE FROM incidents; DELETE FROM events;
            DELETE FROM mikrotik_resource; DELETE FROM mikrotik_iface; DELETE FROM agh_stats; DELETE FROM snmp_samples;
            DELETE FROM meta WHERE key IN ('rollup5_end','rollup1_end');
        """)
        c.commit()


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
        cur = c.execute("PRAGMA incremental_vacuum")
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
        c.execute("VACUUM")
        checkpoint()
