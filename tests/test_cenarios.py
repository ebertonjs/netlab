"""Roda cada cenário de tests/cenarios/ num processo próprio, numa pasta temporária limpa.

Os cenários são scripts: usam caminhos relativos (config.json, netnoc.db, static/) e estado global
dos módulos, então cada um ganha um diretório e um interpretador só para ele. Um cenário passa
quando termina com código 0 e imprime "TUDO OK"; se falhar, a saída dele aparece no erro.

    pip install -r requirements-dev.txt
    pytest -q
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
CENARIOS = sorted((Path(__file__).parent / "cenarios").glob("*.py"))


def _pasta(tmp: Path) -> Path:
    shutil.copy(RAIZ / "config.json", tmp / "config.json")
    shutil.copy(RAIZ / "manage.py", tmp / "manage.py")
    for nome in ("netnoc", "static"):
        (tmp / nome).symlink_to(RAIZ / nome, target_is_directory=True)
    return tmp


@pytest.mark.parametrize("cenario", CENARIOS, ids=[c.stem for c in CENARIOS])
def test_cenario(cenario: Path, tmp_path: Path):
    pasta = _pasta(tmp_path)
    env = {k: v for k, v in os.environ.items() if not k.startswith("NETNOC_")}
    env.update(PYTHONPATH=str(pasta), PYTHONDONTWRITEBYTECODE="1",
               PATH=str(Path(__file__).parent / "fakebin") + os.pathsep + env.get("PATH", ""))   # ping falso
    r = subprocess.run([sys.executable, str(cenario)], cwd=pasta, env=env,
                       capture_output=True, text=True, timeout=180)
    saida = r.stdout + r.stderr
    assert r.returncode == 0 and "TUDO OK" in r.stdout, f"{cenario.name} falhou:\n{saida[-4000:]}"
