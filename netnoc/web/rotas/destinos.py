"""Cadastro de destinos e servidores DNS, aparelhos do DHCP."""
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from netnoc.coleta import monitor
from netnoc.nucleo import stats
from netnoc.web.comum import audit

router = APIRouter()


@router.get("/api/dhcp/hosts")
def dhcp_hosts_ep():
    return monitor.get_dhcp_hosts()


class PromoteIn(BaseModel):
    name: Optional[str] = None
    parent: Optional[str] = None


@router.post("/api/dhcp/hosts/{host_id}/promote")
def promote_dhcp_host_ep(host_id: int, item: PromoteIn, request: Request):
    try:
        name = monitor.promote_dhcp_host(host_id, item.name, item.parent)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "promote", name)
    return {"ok": True, "name": name}


class TargetIn(BaseModel):
    name: str
    host: str
    parent: Optional[str] = None
    interval: Optional[int] = None
    type: str = "icmp"
    port: Optional[int] = None
    expect_status: Optional[int] = None
    verify_ssl: Optional[bool] = None
    group: Optional[str] = None


class DnsIn(BaseModel):
    name: str
    ip: str


@router.post("/api/settings/targets")
def create_target(item: TargetIn, request: Request):
    extra = {}
    if item.type != "icmp":
        extra["type"] = item.type
    if item.port is not None:
        extra["port"] = item.port
    if item.expect_status is not None:
        extra["expect_status"] = item.expect_status
    if item.verify_ssl is not None:
        extra["verify_ssl"] = item.verify_ssl
    if item.group and item.group.strip():
        extra["group"] = item.group.strip()
    if item.interval:
        if not 2 <= item.interval <= 3600:
            raise HTTPException(400, "Intervalo deve estar entre 2 e 3600 s")
        extra["interval"] = item.interval
    try:
        monitor.add_target(item.name, item.host, item.parent, extra)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "target+", item.name)
    return {"ok": True}


class TargetUpdateIn(BaseModel):
    parent: Optional[str] = None
    interval: Optional[int] = None
    group: Optional[str] = None
    set_parent: bool = False
    set_interval: bool = False
    set_group: bool = False


@router.post("/api/settings/targets/{name}/update")
def update_target_ep(name: str, item: TargetUpdateIn, request: Request):
    kw = {}
    if item.set_parent:
        kw["parent"] = item.parent
    if item.set_interval:
        kw["interval"] = item.interval
    if item.set_group:
        kw["group"] = item.group
    try:
        monitor.update_target(name, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    stats.cache_clear()
    audit(request, "target~", f"{name} {kw}")
    return {"ok": True}


@router.delete("/api/settings/targets/{name}")
def delete_target(name: str, request: Request):
    monitor.remove_target(name)
    audit(request, "target-", name)
    return {"ok": True}


@router.post("/api/settings/dns")
def create_dns(item: DnsIn, request: Request):
    try:
        monitor.add_dns(item.name, item.ip)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "dns+", item.name)
    return {"ok": True}


@router.delete("/api/settings/dns/{name}")
def delete_dns(name: str, request: Request):
    monitor.remove_dns(name)
    audit(request, "dns-", name)
    return {"ok": True}
