"""Abre o NetNOC num Chromium de verdade e passa por todas as telas: nenhuma pode dar erro de JavaScript.

Pega o que os testes de API não veem: um nome indefinido num arquivo de tela, uma tela que não monta,
um script que não carrega. Precisa do Playwright (no CI ele é instalado; local, é pulado se faltar):

    pip install playwright && python -m playwright install chromium
"""
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api")

RAIZ = Path(__file__).resolve().parent.parent
TELAS = ["latency", "incidents", "dns", "mikrotik", "adguard", "topology", "tools", "sla", "cameras"]
CONFIG_ABAS = ["geral", "aparencia", "destinos", "alertas", "integ", "seg"]


def _porta():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="module")
def servidor(tmp_path_factory):
    pasta = tmp_path_factory.mktemp("nav")
    shutil.copy(RAIZ / "config.json", pasta / "config.json")
    for nome in ("netnoc", "static", "main.py"):
        (pasta / nome).symlink_to(RAIZ / nome)
    porta = _porta()
    env = {k: v for k, v in os.environ.items() if not k.startswith("NETNOC_")}
    env.update(NETNOC_ADMIN_PASSWORD="senha-admin-1", PYTHONDONTWRITEBYTECODE="1",
               PATH=str(Path(__file__).parent / "fakebin") + os.pathsep + env.get("PATH", ""))
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--port", str(porta)], cwd=pasta, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{porta}"
    for _ in range(60):
        try:
            urllib.request.urlopen(url + "/healthz", timeout=2)
            break
        except OSError:
            time.sleep(0.5)
    else:
        proc.kill()
        pytest.fail("o NetNOC não subiu:\n" + proc.stdout.read().decode(errors="replace")[-3000:])
    yield url
    proc.terminate()
    proc.wait(10)


def test_todas_as_telas_sem_erro_de_js(servidor):
    erros = []
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1400, "height": 1000})
        pg.on("pageerror", lambda e: erros.append(f"[{pg.url}] {e}"))
        pg.on("console", lambda m: m.type == "error" and "Failed to load resource" not in m.text and erros.append(f"[console] {m.text}"))
        pg.goto(servidor + "/login")
        pg.fill("input[type=text], input[name=user]", "admin")
        pg.fill("input[type=password]", "senha-admin-1")
        pg.keyboard.press("Enter")
        pg.wait_for_selector('.home2', timeout=15000)
        assert pg.evaluate('!!(window.NN && window.NNT)'), 'scripts da interface não carregaram'
        for t in TELAS:
            pg.evaluate(f"NN.openSheet('{t}')")
            pg.wait_for_timeout(1200)
        for aba in CONFIG_ABAS:
            pg.evaluate(f"NN.openSheet('config', {{tab: '{aba}'}})")
            pg.wait_for_timeout(1200)
        pg.evaluate("NN.closeSheet()")
        pg.wait_for_timeout(500)
        b.close()
    assert not erros, "\n".join(erros)
