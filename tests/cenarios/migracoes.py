"""v4.4: migrações numeradas — banco novo nasce na última versão; banco antigo (versão 0) migra uma vez só."""
import json, os, sqlite3, sys
sys.path.insert(0, os.getcwd())
ok = lambda c, m: print(("PASS " if c else "FAIL ") + m) or (c or sys.exit(1))

# banco "antigo": dhcp_hosts sem a coluna nova, configuração do Zabbix e um destino de agente
old = sqlite3.connect("netnoc.db")
old.executescript("""CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE dhcp_hosts(id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT UNIQUE, ip TEXT, hostname TEXT, active INTEGER, first_seen REAL, last_seen REAL);
INSERT INTO settings VALUES('zabbix','{"url":"http://z"}');""")
old.execute("INSERT INTO settings VALUES('targets', ?)", (json.dumps([{"name": "A", "host": "1.1.1.1", "sites": ["x"]}, {"name": "Ag", "host": "2.2.2.2", "type": "agent"}]),))
old.commit(); old.close()

from netnoc.nucleo import db, migracoes
LOG = []
_orig = migracoes._print
migracoes._print = lambda m: LOG.append(m) or _orig(m)
migracoes.aplicar.__defaults__ = (migracoes._print,)
db.init_db()
c = db._writer()
ok(migracoes.versao(c, "main") == migracoes.ultima("main") and migracoes.versao(c, "h") == migracoes.ultima("h"), f"versões no fim {migracoes.estado(c)}")
ok("promoted_target" in [r[1] for r in c.execute("PRAGMA main.table_info(dhcp_hosts)")], "coluna nova criada")
ok(db.get_setting("zabbix") is None and [t["name"] for t in json.loads(db.get_setting("targets"))] == ["A"], "v4.0 aplicada na configuração")
ok(len(LOG) == len(migracoes.MIGRACOES), f"cada migração rodou uma vez {LOG}")
LOG.clear()
db.init_db()
ok(LOG == [], "na segunda partida não roda nada")

# histórico apagado (arquivo novo): só as migrações do histórico, a configuração fica
db._wconn.close(); db._wconn = None
db._local.__dict__.clear()
for f in os.listdir("."):
    if f.startswith("netnoc-historico.db"):
        os.remove(f)
db.init_db()
ok(all(x.startswith("histórico") for x in LOG) and LOG, f"histórico novo migra sozinho {LOG}")

# migração que falha: desfaz só ela e não marca a versão
def quebra(c):
    c.execute("INSERT INTO main.settings VALUES('meio', 'x')")
    raise RuntimeError("falhou")
migracoes.MIGRACOES.append((99, "main", "teste que falha", quebra))
try:
    migracoes.aplicar(db._writer()); ok(False, "não levantou")
except RuntimeError:
    pass
c = db._writer()
ok(migracoes.versao(c, "main") < 99 and db.get_setting("meio") is None, "falha desfeita, versão não avançou")
print("TUDO OK")
