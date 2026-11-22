"""Migrações do banco, numeradas (v4.4).

Cada arquivo SQLite guarda a própria versão em `PRAGMA user_version`: netnoc.db (configuração) e
netnoc-historico.db (histórico) têm contagens separadas, porque o histórico pode ser apagado ou
recriado sem mexer na configuração. Na partida, `aplicar()` roda, em ordem, só as migrações com
número maior que a versão gravada, cada uma na sua transação.

Para mudar o banco numa versão nova: escreva uma função `_mNNN(c)` idempotente (pode rodar de novo
sem estragar nada, porque bancos antigos começam na versão 0) e acrescente-a no fim da lista.
Tabelas e índices NOVOS continuam no SCHEMA do db.py (CREATE IF NOT EXISTS); aqui ficam as mudanças
em coisas que já existem: colunas, dados, remoções.
"""
import json


def _m_cfg_1(c):
    """dhcp_hosts.promoted_target (v3.x): o aparelho do DHCP que virou destino monitorado."""
    cols = [r[1] for r in c.execute("PRAGMA main.table_info(dhcp_hosts)")]
    if cols and "promoted_target" not in cols:
        c.execute("ALTER TABLE main.dhcp_hosts ADD COLUMN promoted_target TEXT")


V4_SETTINGS = ("snmp_devices", "zabbix", "speedtest_auto", "agent_token_hash")


def _m_cfg_2(c):
    """v4.0: SNMP, Zabbix, multi-site e speedtest saíram — tira as configurações e os destinos do tipo agente."""
    c.execute(f"DELETE FROM main.settings WHERE key IN ({','.join('?' * len(V4_SETTINGS))})", V4_SETTINGS)
    c.execute("DROP TABLE IF EXISTS main.speedtests")
    c.execute("DROP TABLE IF EXISTS main.snmp_samples")
    row = c.execute("SELECT value FROM main.settings WHERE key='targets'").fetchone()
    if row:
        try:
            ts = json.loads(row[0] or "[]")
            new = [{k: v for k, v in t.items() if k != "sites"} for t in ts if t.get("type") != "agent"]
            if new != ts:
                c.execute("UPDATE main.settings SET value=? WHERE key='targets'", (json.dumps(new),))
        except ValueError:
            pass


def _m_hist_1(c):
    """v4.0: tabelas e marcas do que saiu (speedtest, SNMP, agentes) no histórico."""
    c.execute("DROP TABLE IF EXISTS h.speedtests")
    c.execute("DROP TABLE IF EXISTS h.snmp_samples")
    c.execute("DELETE FROM h.meta WHERE key LIKE 'agent_seen:%' OR key LIKE 'speedtest_%'")
    c.execute("DELETE FROM h.incidents WHERE resolved_ts IS NULL AND type IN ('snmp', 'snmpval', 'agent')")


# (número, arquivo, descrição, função) — só acrescente no fim; nunca renumere
MIGRACOES = [
    (1, "main", "coluna promoted_target nos aparelhos do DHCP", _m_cfg_1),
    (2, "main", "v4.0: remove SNMP, Zabbix, multi-site e speedtest da configuração", _m_cfg_2),
    (1, "h", "v4.0: remove SNMP, multi-site e speedtest do histórico", _m_hist_1),
]


def versao(c, sch):
    return c.execute(f"PRAGMA {sch}.user_version").fetchone()[0]


def ultima(sch):
    return max((v for v, s, *_ in MIGRACOES if s == sch), default=0)


def _print(msg):
    print(f"[db] migração {msg}", flush=True)


def aplicar(c, log=_print):
    """Roda as migrações pendentes. Uma que falhar desfaz só ela e interrompe a partida (melhor parar do que
    seguir com o banco pela metade)."""
    feitas = []
    c.commit()                       # o módulo sqlite3 pode ter uma transação implícita aberta
    for sch in ("main", "h"):
        atual = versao(c, sch)
        for v, s, desc, fn in sorted((m for m in MIGRACOES if m[1] == sch), key=lambda m: m[0]):
            if v <= atual:
                continue
            try:
                c.execute("BEGIN")
                fn(c)
                c.execute(f"PRAGMA {sch}.user_version={int(v)}")
                c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK")
                raise
            feitas.append(f"{'configuração' if sch == 'main' else 'histórico'} {v}: {desc}")
            log(feitas[-1])
    return feitas


def estado(c):
    return {sch: {"versao": versao(c, sch), "ultima": ultima(sch),
                  "pendentes": [d for v, s, d, _ in MIGRACOES if s == sch and v > versao(c, sch)]} for sch in ("main", "h")}


