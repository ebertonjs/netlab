#!/bin/bash
set -e
cd "$(dirname "$0")"

if ! command -v gcc >/dev/null 2>&1; then
  echo "Instalando gcc/python3-dev (necessário para compilar psutil)..."
  sudo apt-get update
  sudo apt-get install -y gcc python3-dev python3-venv
fi

# ferramentas opcionais usadas pelos novos recursos (SNMP, traceroute, ping)
for pkg in snmp traceroute iputils-ping; do
  dpkg -s "$pkg" >/dev/null 2>&1 || { echo "Instalando $pkg..."; sudo apt-get install -y "$pkg" || true; }
done

python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
echo ""
echo "Instalação concluída."
echo "Edite config.json com seus destinos/portas/DNS."
echo "A senha do usuário admin aparece no log na primeira execução (ou defina NETNOC_ADMIN_PASSWORD)."
echo "Para rodar: source venv/bin/activate && python3 -m uvicorn main:app --host 0.0.0.0 --port 8000"
