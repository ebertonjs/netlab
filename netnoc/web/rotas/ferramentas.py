"""Ferramentas: traceroute, IPv4 × IPv6, descoberta, certificados e speedtest."""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from netnoc.coleta import checks, monitor
from netnoc.nucleo import db
from netnoc.web.comum import audit, need_admin

router = APIRouter()


@router.post("/api/speedtest/run")
def speedtest_run(request: Request):
    audit(request, "speedtest")
    try:
        return monitor.run_speedtest()
    except RuntimeError as e:
        raise HTTPException(409, str(e))


# ------------------------------------------------------------ ferramentas
@router.get("/api/tools/traceroute")
def tool_traceroute(request: Request, host: str, max_hops: int = 20):
    need_admin(request)
    try:
        hops = checks.traceroute(host, max_hops)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    audit(request, "traceroute", host)
    return {"host": host, "hops": hops}


@router.get("/api/tools/ipcompare")
def tool_ipcompare(request: Request, host: str):
    need_admin(request)
    try:
        res = checks.compare_ip_versions(host)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "ipcompare", host)
    return res


class DiscoverIn(BaseModel):
    cidr: str


@router.post("/api/tools/discover")
def tool_discover(item: DiscoverIn, request: Request):
    known = [t["host"] for t in monitor.get_targets()]
    try:
        jid = checks.start_discovery(item.cidr, known)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "discover", item.cidr)
    return {"job": jid}


@router.get("/api/tools/discover/{jid}")
def tool_discover_status(jid: str, request: Request):
    need_admin(request)
    st = checks.discovery_status(jid)
    if not st:
        raise HTTPException(404, "Varredura não encontrada")
    return st


@router.get("/api/certs")
def certs_ep():
    rows = db.query("SELECT key, value FROM meta WHERE key LIKE 'cert_days:%'")
    return {r["key"].split(":", 1)[1]: (float(r["value"]) if r["value"] not in ("", None) else None)
            for r in rows}
