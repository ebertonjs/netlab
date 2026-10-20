"""SNMP v1/v2c/v3 via CLI do net-snmp. Credenciais vão num snmp.conf temporário 0600 (não aparecem no ps)."""
import json, os, re, shutil, subprocess, tempfile, threading, time, uuid
from typing import Optional

import db
import security

SECRET_FIELDS = ("community", "auth_pass", "priv_pass")
OID_RE = re.compile(r"^\.?\d+(\.\d+)*$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.:\-]+$")

# OIDs padrão (MIB-2)
OID_SYSUPTIME = ".1.3.6.1.2.1.1.3.0"
OID_SYSNAME = ".1.3.6.1.2.1.1.5.0"
OID_IFDESCR = ".1.3.6.1.2.1.2.2.1.2"
OID_IFOPER = ".1.3.6.1.2.1.2.2.1.8"
OID_IFHCIN = ".1.3.6.1.2.1.31.1.1.1.6"
OID_IFHCOUT = ".1.3.6.1.2.1.31.1.1.1.10"
OID_IFIN = ".1.3.6.1.2.1.2.2.1.10"
OID_IFOUT = ".1.3.6.1.2.1.2.2.1.16"


def get_devices():
    try:
        devs = json.loads(db.get_setting("snmp_devices", "[]") or "[]")
    except Exception:
        return []
    for d in devs:
        for f in SECRET_FIELDS:
            d[f] = security.decrypt(d.get(f) or "")
    return devs


def masked_devices():
    out = []
    for d in get_devices():
        d = dict(d)
        for f in SECRET_FIELDS:
            d[f] = security.MASK if d.get(f) else ""
        out.append(d)
    return out


def validate_device(d, strict=True):
    if not security.valid_name(d.get("name", ""), 40):
        raise ValueError("Nome inválido")
    if not security.valid_host(d.get("host", "")):
        raise ValueError("Host inválido")
    if not security.valid_port(d.get("port", 161)):
        raise ValueError("Porta inválida")
    if str(d.get("version", "2c")) not in ("1", "2c", "3"):
        raise ValueError("Versão SNMP inválida")
    if str(d.get("version")) == "3":
        if not NAME_RE.match(d.get("user", "") or ""):
            raise ValueError("Usuário SNMPv3 inválido")
        if d.get("level") not in ("noAuthNoPriv", "authNoPriv", "authPriv"):
            raise ValueError("Nível de segurança inválido")
        if d.get("auth_proto") not in (None, "", "MD5", "SHA", "SHA-224", "SHA-256", "SHA-384", "SHA-512"):
            raise ValueError("Protocolo de autenticação inválido")
        if d.get("priv_proto") not in (None, "", "DES", "AES", "AES-192", "AES-256"):
            raise ValueError("Protocolo de privacidade inválido")
        for f in ("auth_pass", "priv_pass"):
            v = d.get(f) or ""
            # a senha vai para uma linha do snmp.conf: quebra de linha injetaria diretivas
            if any(ch in v for ch in "\r\n\x00") or len(v) > 128:
                raise ValueError("Senha SNMPv3 inválida")
    else:
        c = d.get("community", "")
        if strict and (not c or any(ch.isspace() for ch in c) or len(c) > 64):
            raise ValueError("Community inválida")
    oids = d.get("oids", []) or []
    if len(oids) > 50:
        raise ValueError("Máximo 50 OIDs por dispositivo")
    for o in oids:
        if not NAME_RE.match(o.get("name", "") or "") or not OID_RE.match(o.get("oid", "") or ""):
            raise ValueError(f"OID/nome inválido: {o.get('name')}")


def save_devices(new_list):
    old = {d["name"]: d for d in get_devices()}
    out = []
    names = set()
    for d in new_list:
        validate_device(d)
        if d["name"] in names:
            raise ValueError("Nome de dispositivo duplicado")
        names.add(d["name"])
        d = dict(d)
        o = old.get(d["name"], {})
        d = security.merge_secrets(o, d, SECRET_FIELDS, ("host", "port", "version", "user"))
        d.setdefault("poll_seconds", 60)
        d["poll_seconds"] = max(15, int(d["poll_seconds"]))
        for o_ in d.get("oids", []):
            o_["scale"] = float(o_.get("scale") or 1)
            o_["unit"] = str(o_.get("unit") or "")[:12]
        for f in SECRET_FIELDS:
            d[f] = security.encrypt(d.get(f) or "")
        out.append(d)
    db.set_setting("snmp_devices", json.dumps(out))


# ---------------------------------------------------------------------- CLI
def _conf_dir(dev):
    tmp = tempfile.mkdtemp(prefix="nnsnmp_")
    os.chmod(tmp, 0o700)
    lines = []
    if str(dev["version"]) == "3":
        lines.append(f"defSecurityName {dev['user']}")
        lines.append(f"defSecurityLevel {dev['level']}")
        if dev["level"] != "noAuthNoPriv":
            lines.append(f"defAuthType {dev.get('auth_proto') or 'SHA'}")
            lines.append(f"defAuthPassphrase {dev.get('auth_pass', '')}")
        if dev["level"] == "authPriv":
            lines.append(f"defPrivType {dev.get('priv_proto') or 'AES'}")
            lines.append(f"defPrivPassphrase {dev.get('priv_pass', '')}")
    else:
        lines.append(f"defCommunity {dev['community']}")
    p = os.path.join(tmp, "snmp.conf")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    return tmp


def _run(tool, dev, args, timeout=12):
    if shutil.which(tool) is None:
        raise RuntimeError("net-snmp não instalado (apt install snmp)")
    tmp = _conf_dir(dev)
    try:
        v = str(dev["version"])
        cmd = [tool, f"-v{v}", "-On", "-Oq", "-Ot", "-t", "3", "-r", "1"] + args[0] + \
              [f"{dev['host']}:{int(dev.get('port', 161))}"] + args[1]
        env = dict(os.environ, SNMPCONFPATH=tmp, SNMP_PERSISTENT_DIR=tmp, MIBS="")
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip()[:200] or "falha SNMP")
        return r.stdout
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _parse(out):
    rows = {}
    for line in out.splitlines():
        m = re.match(r"^(\.[\d.]+)\s+(.*)$", line.strip())
        if m:
            rows[m.group(1)] = m.group(2).strip().strip('"')
    return rows


def get(dev, oids):
    return _parse(_run("snmpget", dev, ([], list(oids))))


def walk(dev, oid, limit=300):
    if not OID_RE.match(oid):
        raise ValueError("OID inválido")
    rows = _parse(_run("snmpwalk", dev, ([], [oid]), timeout=30))
    return dict(list(rows.items())[:limit])


def _num(v):
    m = re.match(r"^-?\d+(\.\d+)?", v or "")
    return float(m.group(0)) if m else None


def _uptime_seconds(v):
    m = re.search(r"\((\d+)\)", v or "")
    if m:
        return int(m.group(1)) / 100
    n = _num(v)
    return n / 100 if n is not None else None


# ------------------------------------------------------------------ coleta
_prev = {}          # (device, ifindex) -> (in, out, ts)
_fail = {}


def poll_device(dev):
    """Coleta e grava; retorna dict com resumo. Levanta exceção se o dispositivo não respondeu."""
    now = time.time()
    base = get(dev, [OID_SYSUPTIME, OID_SYSNAME])
    rows = []
    summary = {"uptime_s": _uptime_seconds(base.get(OID_SYSUPTIME)), "sysname": base.get(OID_SYSNAME)}
    if summary["uptime_s"] is not None:
        rows.append((now, dev["name"], "sys.uptime", summary["uptime_s"]))
    # interfaces
    try:
        descr = walk(dev, OID_IFDESCR)
        oper = walk(dev, OID_IFOPER)
        hc = True
        try:
            cin, cout = walk(dev, OID_IFHCIN), walk(dev, OID_IFHCOUT)
            if not cin:
                raise RuntimeError
        except Exception:
            hc = False
            cin, cout = walk(dev, OID_IFIN), walk(dev, OID_IFOUT)
        for oid, name in descr.items():
            idx = oid.rsplit(".", 1)[1]
            nm = re.sub(r"[^A-Za-z0-9_./\-]", "_", name)[:40]
            st = _num(oper.get(f"{OID_IFOPER}.{idx}"))
            rows.append((now, dev["name"], f"if.{nm}.up", 1.0 if st == 1 else 0.0))
            i_ = _num(next((v for k, v in cin.items() if k.endswith("." + idx)), None))
            o_ = _num(next((v for k, v in cout.items() if k.endswith("." + idx)), None))
            if i_ is None or o_ is None:
                continue
            p = _prev.get((dev["name"], idx))
            _prev[(dev["name"], idx)] = (i_, o_, now)
            if p and now > p[2]:
                dt = now - p[2]
                wrap = 2 ** 64 if hc else 2 ** 32
                din = (i_ - p[0]) % wrap
                dout = (o_ - p[1]) % wrap
                rows.append((now, dev["name"], f"if.{nm}.in_bps", din * 8 / dt))
                rows.append((now, dev["name"], f"if.{nm}.out_bps", dout * 8 / dt))
    except RuntimeError:
        pass
    # OIDs customizados (potência óptica etc.)
    custom = {}
    oids = dev.get("oids") or []
    if oids:
        got = get(dev, [o["oid"] if o["oid"].startswith(".") else "." + o["oid"] for o in oids])
        for o in oids:
            key = o["oid"] if o["oid"].startswith(".") else "." + o["oid"]
            v = _num(got.get(key))
            if v is None:
                continue
            v = v * float(o.get("scale") or 1)
            custom[o["name"]] = v
            rows.append((now, dev["name"], f"oid.{o['name']}", v))
    db.executemany("INSERT INTO snmp_samples(ts,device,key,value) VALUES(?,?,?,?)", rows)
    summary["custom"] = custom
    return summary


def check_thresholds(dev, custom):
    """Retorna lista de (key, bad, msg) para o monitor aplicar histerese."""
    out = []
    for o in dev.get("oids") or []:
        v = custom.get(o["name"])
        if v is None:
            continue
        bad, why = False, ""
        if o.get("min") not in (None, "") and v < float(o["min"]):
            bad, why = True, f"{v:.2f}{o.get('unit', '')} < {o['min']}"
        if o.get("max") not in (None, "") and v > float(o["max"]):
            bad, why = True, f"{v:.2f}{o.get('unit', '')} > {o['max']}"
        out.append((o["name"], bad, why))
    return out


def latest(device=None):
    q = ("SELECT s.device, s.key, s.value, s.ts FROM snmp_samples s JOIN "
         "(SELECT device, key, MAX(ts) mts FROM snmp_samples WHERE ts>=? GROUP BY device, key) x "
         "ON x.device=s.device AND x.key=s.key AND x.mts=s.ts")
    rows = db.query(q, (time.time() - 3600,))
    out = {}
    for r in rows:
        if device and r["device"] != device:
            continue
        out.setdefault(r["device"], {})[r["key"]] = {"value": r["value"], "ts": r["ts"]}
    return out


def history(device, key, seconds, maxn=600):
    rows = db.query("SELECT ts, value FROM snmp_samples WHERE device=? AND key=? AND ts>=? ORDER BY ts",
                    (device, key, time.time() - seconds))
    if len(rows) > maxn:
        step = len(rows) / maxn
        rows = [rows[int(i * step)] for i in range(maxn)]
    return rows


def prune(days):
    db.execute("DELETE FROM snmp_samples WHERE ts < ?", (time.time() - days * 86400,))
