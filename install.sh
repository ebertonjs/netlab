#!/bin/bash
# NetNOC — instalador. Uso:
#   ./install.sh             instala dependências e cria o venv
#   ./install.sh --service   idem + cria e ativa o serviço systemd (inicia no boot)
set -e
cd "$(dirname "$0")"
APPDIR="$(pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 não encontrado. Instale com: sudo apt-get install -y python3 python3-venv"; exit 1
fi
python3 - <<'PY' || { echo "É necessário Python 3.9 ou superior."; exit 1; }
import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY

if ! command -v gcc >/dev/null 2>&1; then
  echo "Instalando gcc/python3-dev (necessário para compilar psutil)..."
  sudo apt-get update
  sudo apt-get install -y gcc python3-dev python3-venv
fi
python3 -c "import venv, ensurepip" 2>/dev/null || sudo apt-get install -y python3-venv

# ferramentas opcionais (SNMP, traceroute, ping)
for pkg in snmp traceroute iputils-ping; do
  dpkg -s "$pkg" >/dev/null 2>&1 || { echo "Instalando $pkg..."; sudo apt-get install -y "$pkg" || true; }
done

# câmeras (DVR): go2rtc — repassa o vídeo do DVR ao navegador sem converter (leve até no Raspberry Pi 3)
GO2RTC_VERSION="v1.9.14"
if [ ! -x bin/go2rtc ]; then
  case "$(uname -m)" in
    aarch64|arm64) G2R=go2rtc_linux_arm64 ;;
    armv7l|armv8l) G2R=go2rtc_linux_arm ;;
    armv6l)        G2R=go2rtc_linux_armv6 ;;
    x86_64)        G2R=go2rtc_linux_amd64 ;;
    i386|i686)     G2R=go2rtc_linux_i386 ;;
    *)             G2R="" ;;
  esac
  if [ -n "$G2R" ]; then
    command -v curl >/dev/null 2>&1 || sudo apt-get install -y curl || true
    echo "Baixando go2rtc $GO2RTC_VERSION ($G2R)..."
    mkdir -p bin
    if curl -fL --retry 3 -o bin/go2rtc.tmp "https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VERSION/$G2R"; then
      chmod +x bin/go2rtc.tmp && mv bin/go2rtc.tmp bin/go2rtc && echo "go2rtc instalado em bin/go2rtc"
    else
      rm -f bin/go2rtc.tmp; echo "AVISO: não foi possível baixar o go2rtc (câmeras ao vivo ficam indisponíveis; fotos continuam)."
    fi
  else
    echo "AVISO: arquitetura $(uname -m) sem go2rtc pronto; câmeras ao vivo indisponíveis."
  fi
fi

python3 -m venv venv
# shellcheck disable=SC1091
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

if [ "$1" = "--service" ]; then
  USER_NAME="$(id -un)"
  UNIT=/etc/systemd/system/netnoc.service
  echo "Criando $UNIT (usuário: $USER_NAME)..."
  sudo tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=NetNOC
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APPDIR
Environment=PYTHONUNBUFFERED=1
ExecStart=$APPDIR/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
UNITEOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now netnoc
  sleep 4
  echo ""
  echo "Serviço ativo. Senha inicial do admin:"
  sudo journalctl -u netnoc --no-pager | grep "senha:" | tail -1 || true
  echo "Acesse: http://$(hostname -I | awk '{print $1}'):8000"
  exit 0
fi

echo ""
echo "Instalação concluída."
echo "1) (opcional) edite config.json com seus destinos/DNS iniciais"
echo "2) rode:  source venv/bin/activate && python3 -m uvicorn main:app --host 0.0.0.0 --port 8000"
echo "3) a senha do usuário 'admin' aparece no terminal na primeira execução (ou defina NETNOC_ADMIN_PASSWORD)"
echo "Para iniciar no boot: ./install.sh --service   (veja INSTALL.md)"
