"""MikroTik, AdGuard Home, SNMP, Zabbix, câmeras do DVR (inclui o WebSocket do vídeo) e banda por aparelho."""
import asyncio, json
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import Response
from pydantic import BaseModel

from netnoc.coleta import monitor, snmp
from netnoc.integracoes import dvr, zabbix
from netnoc.nucleo import security
from netnoc.web.comum import audit, need_admin, RANGE_SECONDS, secs

router = APIRouter()


class MikrotikIn(BaseModel):
    enabled: bool
    host: str = ""
    port: int = 443
    use_https: bool = True
    verify_ssl: bool = False
    username: str = ""
    password: str = ""
    sync_interval_seconds: int = 60


def _check_hostport(host, port, enabled):
    if (host or enabled) and not security.valid_host(host):
        raise HTTPException(400, "Host inválido")
    if not security.valid_port(port):
        raise HTTPException(400, "Porta inválida")


@router.get("/api/settings/mikrotik")
def get_mikrotik_ep():
    return security.mask_cfg(monitor.get_mikrotik(), ("password",))


@router.post("/api/settings/mikrotik")
def set_mikrotik_ep(data: MikrotikIn, request: Request):
    _check_hostport(data.host, data.port, data.enabled)
    try:
        payload = security.merge_secrets(monitor.get_mikrotik(), data.dict(), ("password",),
                                         ("host", "port", "username", "use_https"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    payload["sync_interval_seconds"] = max(15, int(payload["sync_interval_seconds"]))
    monitor.set_mikrotik(payload)
    audit(request, "mikrotik", payload["host"])
    if payload["enabled"]:
        monitor.sync_dhcp_leases()
    return {"ok": True}


@router.post("/api/settings/mikrotik/test")
def test_mikrotik_ep():
    try:
        leases = monitor.fetch_dhcp_leases()
    except Exception as e:
        raise HTTPException(400, f"Não foi possível conectar: {e}")
    monitor.sync_dhcp_leases()
    return {"ok": True, "leases_found": len(leases)}


@router.get("/api/mikrotik/status")
def mikrotik_status_ep():
    cfg = monitor.get_mikrotik()
    return {"enabled": cfg["enabled"], "host": cfg["host"], **(monitor.get_mikrotik_status() or {})}


@router.get("/api/mikrotik/interfaces")
def mikrotik_interfaces_ep():
    return monitor.get_mikrotik_interfaces()


@router.get("/api/mikrotik/history")
def mikrotik_history_ep(range: str = "1h", iface: Optional[str] = None):
    s = secs(range) if range in RANGE_SECONDS else 3600
    if iface:
        return {"type": "interface", "iface": iface, "points": monitor.get_mikrotik_iface_history(iface, s)}
    return {"type": "resource", "points": monitor.get_mikrotik_resource_history(s)}


class AghIn(BaseModel):
    enabled: bool
    host: str = ""
    port: int = 3000
    use_https: bool = False
    username: str = ""
    password: str = ""
    sync_interval_seconds: int = 60


@router.get("/api/settings/agh")
def get_agh_ep():
    return security.mask_cfg(monitor.get_agh(), ("password",))


@router.post("/api/settings/agh")
def set_agh_ep(data: AghIn, request: Request):
    _check_hostport(data.host, data.port, data.enabled)
    try:
        payload = security.merge_secrets(monitor.get_agh(), data.dict(), ("password",),
                                         ("host", "port", "username", "use_https"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    payload["sync_interval_seconds"] = max(15, int(payload["sync_interval_seconds"]))
    monitor.set_agh(payload)
    audit(request, "agh", payload["host"])
    return {"ok": True}


@router.post("/api/settings/agh/test")
def test_agh_ep():
    try:
        st = monitor.test_agh_connection()
    except Exception as e:
        raise HTTPException(400, f"Não foi possível conectar: {e}")
    return {"ok": True, "version": st.get("version")}


@router.get("/api/agh/status")
def agh_status_ep():
    return monitor.get_agh_status() or {"enabled": False}


@router.get("/api/agh/stats")
def agh_stats_ep():
    return monitor.get_agh_stats_latest() or {}


@router.get("/api/agh/top")
def agh_top_ep():
    try:
        return monitor.get_agh_top()
    except Exception:
        return {"clients": [], "queried": [], "blocked": []}


@router.get("/api/agh/history")
def agh_history_ep(range: str = "1h"):
    return monitor.get_agh_stats_history(secs(range) if range in RANGE_SECONDS else 3600)


# -------------------------------------------------------------------- SNMP
@router.get("/api/settings/snmp")
def snmp_get(request: Request):
    need_admin(request)
    return snmp.masked_devices()


@router.post("/api/settings/snmp")
def snmp_set(data: List[dict], request: Request):
    try:
        snmp.save_devices(data)
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "snmp", len(data))
    return {"ok": True}


def _snmp_dev(name):
    for d in snmp.get_devices():
        if d["name"] == name:
            return d
    raise HTTPException(404, "Dispositivo SNMP não encontrado")


@router.post("/api/snmp/test/{name}")
def snmp_test(name: str, request: Request):
    try:
        res = snmp.poll_device(_snmp_dev(name))
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "sysname": res.get("sysname"), "uptime_s": res.get("uptime_s"), "custom": res.get("custom")}


class WalkIn(BaseModel):
    device: str
    oid: str


@router.post("/api/snmp/walk")
def snmp_walk(item: WalkIn, request: Request):
    try:
        rows = snmp.walk(_snmp_dev(item.device), item.oid)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "snmp-walk", f"{item.device} {item.oid}")
    return rows


@router.get("/api/snmp/latest")
def snmp_latest(device: Optional[str] = None):
    return snmp.latest(device)


@router.get("/api/snmp/history")
def snmp_history(device: str, key: str, range: str = "1h"):
    return snmp.history(device, key, secs(range) if range in RANGE_SECONDS else 3600)


# ------------------------------------------------------------------ Zabbix
@router.get("/api/settings/zabbix")
def zabbix_get(request: Request):
    need_admin(request)
    return zabbix.masked()


@router.post("/api/settings/zabbix")
def zabbix_set(data: dict, request: Request):
    try:
        zabbix.save_cfg(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "zabbix", data.get("url"))
    return {"ok": True}


@router.post("/api/settings/zabbix/test")
def zabbix_test():
    try:
        return {"ok": True, "version": zabbix.test()}
    except Exception as e:
        raise HTTPException(400, f"Falha: {str(e)[:200]}")


@router.get("/api/zabbix/problems")
def zabbix_problems():
    return zabbix.problems()


# ------------------------------------------------------------ câmeras (DVR Intelbras)
@router.get("/api/settings/dvr")
def dvr_get(request: Request):
    need_admin(request)
    return dvr.masked()


@router.post("/api/settings/dvr")
def dvr_set(data: dict, request: Request):
    try:
        dvr.save_cfg(data)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    audit(request, "dvr", data.get("host"))
    return {"ok": True}


@router.post("/api/settings/dvr/test")
def dvr_test(request: Request):
    try:
        return dvr.test()
    except Exception as e:
        raise HTTPException(400, f"Não foi possível falar com o DVR: {dvr._safe_err(e)}")


@router.get("/api/cam/status")
def cam_status():
    return dvr.status()


@router.get("/api/cam/viewers")
def cam_viewers():
    return {"viewers": dvr.viewers()}


@router.get("/api/cam/snapshot/{ch}")
def cam_snapshot(ch: int, last: bool = False, age: float = 2.0):
    """Foto do canal. last=1 devolve a última imagem boa guardada (sem tocar no DVR).
    age = idade máxima aceita da foto em cache (s): a página inicial usa ~50 s e várias telas abertas
    dividem a mesma foto em vez de cada uma acordar o DVR."""
    if last:
        lg = dvr.last_good(ch)
        if lg:
            return Response(lg[1], media_type="image/jpeg", headers={"Cache-Control": "no-store", "X-Snapshot-Ts": str(int(lg[0]))})
    try:
        data, ts = dvr.snapshot(ch, max_age=max(0.0, min(float(age), 120.0)))
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"DVR: {dvr._safe_err(e)}")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store", "X-Snapshot-Ts": str(int(ts))})


@router.websocket("/api/cam/ws")
async def cam_ws(websocket: WebSocket, src: str = ""):
    """Ponte navegador ⇄ go2rtc (localhost). Autenticação e origem já checadas no middleware.
    Do navegador só passa o pedido "mse" (lista de codecs); nenhum outro comando do go2rtc é exposto."""
    if not dvr.valid_src(src):
        await websocket.close(code=1008)
        return
    import websockets
    await websocket.accept()
    try:
        async with websockets.connect(f"ws://{dvr.GO2RTC_ADDR}/api/ws?src={src}", max_size=None,
                                      open_timeout=6, ping_interval=None, compression=None) as up:
            async def from_browser():
                while True:
                    m = await websocket.receive()
                    if m["type"] == "websocket.disconnect":
                        return
                    txt = m.get("text")
                    if txt:
                        try:
                            j = json.loads(txt)
                        except Exception:
                            continue
                        if j.get("type") == "mse" and isinstance(j.get("value"), str) and len(j["value"]) < 500:
                            await up.send(json.dumps({"type": "mse", "value": j["value"]}))

            async def from_go2rtc():
                async for m in up:
                    if isinstance(m, (bytes, bytearray)):
                        await websocket.send_bytes(bytes(m))
                    else:
                        await websocket.send_text(m)

            tasks = [asyncio.create_task(from_browser()), asyncio.create_task(from_go2rtc())]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "value": "vídeo indisponível: " + dvr._safe_err(e)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@router.get("/api/bandwidth")
def bandwidth_ep():
    from netnoc.bot import actions
    try:
        return actions.bandwidth_top(3)
    except actions.ActionError as e:
        raise HTTPException(400, str(e))
