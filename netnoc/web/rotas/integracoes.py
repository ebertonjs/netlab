"""MikroTik, AdGuard Home e câmeras do DVR (inclui o WebSocket do vídeo)."""
import asyncio, json, re
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import Response
from pydantic import BaseModel

from netnoc.coleta import medir, monitor, syslog
from netnoc.integracoes import dvr
from netnoc.nucleo import security, tlspin
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
    wan_iface: str = ""
    cert_sha256: str = ""
    plan_mbps: int = 0


class MedirIn(BaseModel):
    seconds: int = medir.DEFAULT_S


class SyslogIn(BaseModel):
    enabled: bool = False
    port: int = 5514


class CertIn(BaseModel):
    host: str
    port: int = 443


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
    payload["wan_iface"] = (payload.get("wan_iface") or "").strip()
    if payload["wan_iface"] and not re.fullmatch(r"[\w .:@<>/+-]{1,40}", payload["wan_iface"]):
        raise HTTPException(400, "Nome da porta WAN inválido")
    if not 0 <= int(payload.get("plan_mbps") or 0) <= 100000:
        raise HTTPException(400, "Velocidade do plano inválida")
    try:
        payload["cert_sha256"] = tlspin.norm(payload.get("cert_sha256"))
    except ValueError as e:
        raise HTTPException(400, str(e))
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
        raise HTTPException(400, f"Não foi possível conectar: {monitor._safe_err(e)}")
    monitor.sync_dhcp_leases()
    return {"ok": True, "leases_found": len(leases)}


@router.post("/api/settings/mikrotik/cert")
def mikrotik_cert_ep(data: CertIn):
    """Lê a impressão digital do certificado que o MikroTik apresenta, para o usuário conferir e fixar."""
    _check_hostport(data.host, data.port, True)
    try:
        fp = tlspin.fetch(data.host, data.port)
    except Exception as e:
        raise HTTPException(400, f"Não consegui ler o certificado: {type(e).__name__}")
    return {"sha256": fp, "pretty": tlspin.pretty(fp)}


# ---------------------------------------------------------------- Medir agora (v4.3)
@router.get("/api/wan/medir")
def medir_get():
    return {**medir.state(), "history": medir.history()[:10], "plan_mbps": monitor.get_mikrotik().get("plan_mbps") or 0,
            "min_s": medir.MIN_S, "max_s": medir.MAX_S}


@router.post("/api/wan/medir")
def medir_post(data: MedirIn, request: Request):
    try:
        st = medir.start(data.seconds, who=(request.scope.get("state", {}).get("user") or "painel"))
    except medir.MedirError as e:
        raise HTTPException(400, str(e))
    audit(request, "medir", f"{st['iface']} {st['seconds']} s")
    return st


# ---------------------------------------------------------------- syslog do MikroTik (v4.3)
@router.get("/api/settings/syslog")
def syslog_get():
    return syslog.status()


@router.post("/api/settings/syslog")
def syslog_set(data: SyslogIn, request: Request):
    need_admin(request)
    try:
        syslog.set_cfg(data.dict())
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(request, "syslog", f"{'on' if data.enabled else 'off'} {data.port}")
    return syslog.status()


@router.get("/api/mikrotik/log")
def mikrotik_log(minutes: int = 1440, topic: Optional[str] = None, q: Optional[str] = None, limit: int = 200):
    if topic and not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", topic):
        raise HTTPException(400, "Tópico inválido")
    return {"status": syslog.status(),
            "rows": syslog.recent(minutes=max(1, min(minutes, 43200)), topic=topic, text=(q or "")[:60] or None,
                                  limit=max(1, min(limit, 1000)))}


@router.get("/api/mikrotik/status")
def mikrotik_status_ep():
    cfg = monitor.get_mikrotik()
    return {"enabled": cfg["enabled"], "host": cfg["host"], **(monitor.get_mikrotik_status() or {})}


@router.get("/api/mikrotik/interfaces")
def mikrotik_interfaces_ep():
    return monitor.get_mikrotik_interfaces()


# ---------------------------------------------------- portas: ligar/desligar pela interface (v4.1)
# Funciona pela rede local mesmo com a internet (e o Telegram) fora: é o jeito de religar o PPPoE.
@router.get("/api/mikrotik/ports")
def ports_ep(request: Request):
    need_admin(request)
    from netnoc.bot import actions
    try:
        srv = actions._server_ports()
        return [dict(i, wan=actions.is_wan(i), server=i["name"] in srv) for i in actions.interfaces()
                if i["type"] in ("ether", "wlan", "wifi", "pppoe-out", "sfp", "vlan")]
    except actions.ActionError as e:
        raise HTTPException(400, str(e))


class PortIn(BaseModel):
    name: str
    enabled: bool


@router.post("/api/mikrotik/ports")
def port_set_ep(data: PortIn, request: Request):
    from netnoc.bot import actions
    try:
        itf = next((i for i in actions.interfaces() if i["name"] == data.name), None)
        if not itf:
            raise HTTPException(404, "Porta não encontrada")
        msg = actions.iface_on(itf) if data.enabled else actions.iface_off(itf, 0)
    except actions.ActionError as e:
        raise HTTPException(400, str(e))
    audit(request, "porta-" + ("ligar" if data.enabled else "desligar"), data.name)
    return {"ok": True, "message": msg}


@router.get("/api/wan/peak")
def wan_peak_ep():
    """Maior download/upload na porta WAN do MikroTik hoje, em 7 e em 30 dias (v4.0, no lugar do speedtest)."""
    return {"today": monitor.wan_peak(86400), "d7": monitor.wan_peak(7 * 86400), "d30": monitor.wan_peak(30 * 86400),
            "iface": monitor.wan_iface()}


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
