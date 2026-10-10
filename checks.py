"""Checks além de ICMP: TCP, HTTP(S), validade de certificado, traceroute, v4 vs v6, descoberta."""
import ipaddress, re, shutil, socket, ssl, subprocess, threading, time, uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests

import security

try:                                    # silencia o aviso quando verify_ssl=false foi escolhido
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass


# ------------------------------------------------------------------ sondas
def tcp_probe(host, port, timeout=2.0):
    if not security.valid_host(host) or not security.valid_port(port):
        return None
    t0 = time.time()
    try:
        s = socket.create_connection((host, int(port)), timeout=timeout)
        s.close()
        return (time.time() - t0) * 1000
    except Exception:
        return None


def http_probe(url, timeout=5.0, verify=True, expect=None):
    if not security.valid_url(url):
        return None
    t0 = time.time()
    try:
        r = requests.get(url, timeout=timeout, verify=verify, allow_redirects=True, stream=True,
                         headers={"User-Agent": "NetNOC/2.0"})
        ms = (time.time() - t0) * 1000
        r.close()
        if expect:
            return ms if r.status_code == int(expect) else None
        return ms if r.status_code < 400 else None
    except Exception:
        return None


def probe(t):
    """Chamado pelo monitor para tipos != icmp."""
    ttype = t.get("type")
    if ttype == "tcp":
        return tcp_probe(t["host"], t.get("port"))
    if ttype == "http":
        return http_probe(t["host"], verify=t.get("verify_ssl", True), expect=t.get("expect_status"))
    return None


# ------------------------------------------------------------- certificado
def cert_days_left(host, port=443, timeout=5):
    """Dias até expirar o certificado servido (None se falhar). Não valida a cadeia: queremos a data."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, int(port)), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ss:
                der = ss.getpeercert(binary_form=True)
        from cryptography import x509
        cert = x509.load_der_x509_certificate(der)
        try:
            exp = cert.not_valid_after_utc.timestamp()
        except AttributeError:               # cryptography < 42
            import calendar
            exp = calendar.timegm(cert.not_valid_after.timetuple())
        return (exp - time.time()) / 86400
    except Exception:
        return None


def url_host_port(url):
    m = re.match(r"^https://([^/:?#]+)(?::(\d+))?", url or "")
    if not m:
        return None
    return m.group(1), int(m.group(2) or 443)


# -------------------------------------------------------------- traceroute
def _have(cmd):
    return shutil.which(cmd) is not None


def traceroute(host, max_hops=20):
    if not security.valid_host(host):
        raise ValueError("Host inválido")
    max_hops = max(1, min(int(max_hops), 30))
    if _have("traceroute"):
        cmd = ["traceroute", "-n", "-w", "1", "-q", "1", "-m", str(max_hops), "--", host]
    elif _have("tracepath"):
        cmd = ["tracepath", "-n", "-m", str(max_hops), host]
    else:
        raise RuntimeError("traceroute não instalado (apt install traceroute)")
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
    except subprocess.TimeoutExpired:
        raise RuntimeError("traceroute excedeu o tempo limite")
    hops = []
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\??\s+(.*)$", line)
        if not m:
            continue
        rest = m.group(2)
        ip = re.search(r"((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]{3,39})\s", rest + " ")
        ms = re.search(r"([\d.]+)\s*ms", rest)
        hops.append({"hop": int(m.group(1)),
                     "ip": ip.group(1) if ip and "*" not in rest.split()[0] else None,
                     "ms": float(ms.group(1)) if ms else None})
    return hops


def compare_ip_versions(host, samples=4):
    """Resolve A e AAAA e mede latência por família."""
    if not security.valid_host(host):
        raise ValueError("Host inválido")
    res = {}
    for fam, flag, name in ((socket.AF_INET, "-4", "ipv4"), (socket.AF_INET6, "-6", "ipv6")):
        try:
            infos = socket.getaddrinfo(host, None, fam, socket.SOCK_STREAM)
            addr = infos[0][4][0]
        except Exception:
            res[name] = {"address": None, "error": "sem registro" if not _is_ip(host) else "não aplicável"}
            continue
        lats = []
        for _ in range(samples):
            try:
                out = subprocess.run(["ping", flag, "-c", "1", "-W", "1", addr],
                                     capture_output=True, text=True, timeout=4)
                m = re.search(r"time[=<]([\d.]+)", out.stdout)
                if out.returncode == 0 and m:
                    lats.append(float(m.group(1)))
            except Exception:
                pass
        res[name] = {"address": addr, "sent": samples, "received": len(lats),
                     "loss_pct": 100 * (1 - len(lats) / samples),
                     "avg_ms": round(sum(lats) / len(lats), 2) if lats else None,
                     "min_ms": min(lats) if lats else None, "max_ms": max(lats) if lats else None}
    a, b = res.get("ipv4", {}).get("avg_ms"), res.get("ipv6", {}).get("avg_ms")
    res["diff_ms"] = round(b - a, 2) if a is not None and b is not None else None
    return res


def _is_ip(h):
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        return False


# -------------------------------------------------------------- descoberta
_jobs = {}
_jlock = threading.Lock()


def _arp_table():
    out = {}
    try:
        for line in open("/proc/net/arp").read().splitlines()[1:]:
            p = line.split()
            if len(p) >= 4 and p[3] != "00:00:00:00:00:00":
                out[p[0]] = p[3]
    except Exception:
        pass
    return out


def validate_cidr(cidr):
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        raise ValueError("CIDR inválido")
    if net.version != 4:
        raise ValueError("Somente IPv4")
    if not net.is_private or net.is_loopback or net.is_link_local:
        raise ValueError("Somente redes privadas (RFC1918)")
    if net.prefixlen < 22:
        raise ValueError("Rede grande demais (máximo /22 = 1022 hosts)")
    return net


def _ping_once(ip):
    try:
        out = subprocess.run(["ping", "-c", "1", "-W", "1", ip], capture_output=True, text=True, timeout=3)
        m = re.search(r"time[=<]([\d.]+)", out.stdout)
        return float(m.group(1)) if out.returncode == 0 and m else None
    except Exception:
        return None


def _rdns(ip):
    try:
        socket.setdefaulttimeout(1.0)
        return security.clean_name(socket.gethostbyaddr(ip)[0], 60)
    except Exception:
        return ""
    finally:
        socket.setdefaulttimeout(None)


def start_discovery(cidr, known_hosts=()):
    net = validate_cidr(cidr)
    jid = uuid.uuid4().hex[:12]
    with _jlock:
        for k in [k for k, v in _jobs.items() if time.time() - v["started"] > 3600]:
            _jobs.pop(k, None)
        if any(j["status"] == "running" for j in _jobs.values()):
            raise ValueError("Já existe uma varredura em andamento")
        _jobs[jid] = {"status": "running", "cidr": str(net), "started": time.time(),
                      "total": net.num_addresses - 2 if net.prefixlen < 31 else net.num_addresses,
                      "done": 0, "found": []}

    def run():
        hosts = [str(h) for h in (net.hosts() if net.prefixlen < 31 else net)]
        known = set(known_hosts)
        with ThreadPoolExecutor(max_workers=64) as ex:
            for ip, lat in zip(hosts, ex.map(_ping_once, hosts)):
                with _jlock:
                    _jobs[jid]["done"] += 1
                    if lat is not None:
                        _jobs[jid]["found"].append({"ip": ip, "latency": lat, "monitored": ip in known})
        arp = _arp_table()
        with _jlock:
            found = list(_jobs[jid]["found"])
        with ThreadPoolExecutor(max_workers=32) as ex:
            names = list(ex.map(lambda f: _rdns(f["ip"]), found))
        with _jlock:
            for f, n in zip(_jobs[jid]["found"], names):
                f["hostname"] = n
                f["mac"] = arp.get(f["ip"], "")
            _jobs[jid]["found"].sort(key=lambda f: tuple(int(x) for x in f["ip"].split(".")))
            _jobs[jid]["status"] = "done"

    threading.Thread(target=run, daemon=True, name="discovery").start()
    return jid


def discovery_status(jid):
    with _jlock:
        j = _jobs.get(jid)
        return dict(j, id=jid) if j else None
