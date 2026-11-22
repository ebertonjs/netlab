"""Aplicação web do NetNOC: monta o FastAPI, liga a coleta na partida e inclui as rotas.

As rotas ficam em netnoc/web/rotas/, uma por domínio (cada arquivo expõe `router`); o que elas
compartilham (versão, auditoria, períodos, permissão) fica em netnoc/web/comum.py.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from netnoc.analise import diagnose, story
from netnoc.bot import aibot
from netnoc.coleta import monitor, syslog
from netnoc.integracoes import dvr
from netnoc.nucleo import cofre, guarda, security, stats
from netnoc.web import middleware
from netnoc.web.comum import APP_VERSION  # noqa: F401  (main.py e scripts leem daqui)
from netnoc.web.rotas import (alertas, autenticacao, destinos, ferramentas, integracoes, metricas, paginas,
                              painel, sistema)

ROUTERS = (sistema, metricas, alertas, integracoes, destinos, ferramentas, autenticacao, paginas, painel)


def startup():
    monitor.start_all()
    diagnose.start()
    story.start()
    dvr.start()
    guarda.start()
    syslog.start()
    aibot.start({"overview": metricas.overview, "targets": metricas._targets_payload, "incidents": metricas.incidents,
                 "series": stats.series, "uptime": stats.uptime_pct, "mikrotik_status": integracoes.mikrotik_status_ep,
                 "mikrotik_ifaces": integracoes.mikrotik_interfaces_ep, "dns": metricas.dns_status,
                 "wan_peak": monitor.wan_peak, "system": sistema.system_ep})
    try:
        cofre.harden()       # chave 0600, segredos antigos em texto puro → cifrados
    except Exception as e:
        print(f"[cofre] {e}", flush=True)
    pw = security.ensure_admin()
    if pw:
        banner = "=" * 60
        print(f"\n{banner}\n NetNOC: usuário inicial 'admin'  senha: {pw}\n"
              f" (altere em Configurações → Segurança ou: python manage.py set-password admin)\n{banner}\n", flush=True)
    if security.AUTH_OFF:
        print("AVISO: autenticação DESLIGADA (NETNOC_AUTH=off)", flush=True)


@asynccontextmanager
async def lifespan(_app):
    startup()          # on_event("startup") está deprecated
    yield
    dvr.shutdown()     # encerra o go2rtc junto com o NetNOC
    syslog.stop()


app = FastAPI(title="NetNOC", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(security.AuthMiddleware)
app.add_middleware(middleware.AuditMiddleware)      # por fora do login: vê o usuário e também o 403
app.add_middleware(middleware.CacheMiddleware)
app.add_middleware(middleware.CompressMiddleware)
for _r in ROUTERS:
    app.include_router(_r.router)
# por último: tudo que não é rota vira arquivo de static/
app.mount("/", StaticFiles(directory="static", html=True), name="static")
