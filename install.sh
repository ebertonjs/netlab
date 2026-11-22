#!/bin/bash
# NetNOC — instalador. Uso:
#   ./install.sh             instala dependências e cria o venv
#   ./install.sh --service   idem + cria e ativa o serviço systemd (inicia no boot)
#   ./install.sh --permitir-reinicio   deixa o bot reiniciar o servidor e o NetNOC (só esses 2 comandos)
#   ./install.sh --remover-reinicio    desfaz a permissão acima
#   ./install.sh --watchdog            reinicia o NetNOC sozinho se ele travar (confere /healthz a cada minuto)
#   ./install.sh --remover-watchdog    desfaz o watchdog
set -e
cd "$(dirname "$0")"
APPDIR="$(pwd)"

# ------------------------------------------------------------------ permissão de reinício (v4.1)
# Libera para o usuário do serviço SÓ "systemctl reboot" e "systemctl restart netnoc", sem senha.
# Nada mais: o bot continua sem poder rodar outros comandos como root.
SUDOERS=/etc/sudoers.d/netnoc-reinicio
if [ "$1" = "--permitir-reinicio" ] || [ "$1" = "--remover-reinicio" ]; then
  if [ "$1" = "--remover-reinicio" ]; then
    sudo rm -f "$SUDOERS" && echo "Permissão removida: o bot não reinicia mais o servidor nem o NetNOC."
    exit 0
  fi
  SVC_USER="$(sed -n 's/^User=//p' /etc/systemd/system/netnoc.service 2>/dev/null | head -1)"
  SVC_USER="${SVC_USER:-$(id -un)}"
  SCTL="$(command -v systemctl || echo /usr/bin/systemctl)"
  TMP="$(mktemp)"
  {
    echo "# NetNOC: o bot do Telegram pode reiniciar o servidor e o serviço (criado por install.sh --permitir-reinicio)"
    echo "$SVC_USER ALL=(root) NOPASSWD: $SCTL reboot, $SCTL restart netnoc"
  } > "$TMP"
  if sudo visudo -cf "$TMP" >/dev/null; then
    sudo install -m 0440 -o root -g root "$TMP" "$SUDOERS"
    rm -f "$TMP"
    echo "✔ Usuário '$SVC_USER' pode rodar só: $SCTL reboot e $SCTL restart netnoc"
    echo "  Ative em Configurações → Alertas → Bot e IA → Permitir reinícios. Para desfazer: ./install.sh --remover-reinicio"
  else
    rm -f "$TMP"; echo "Erro ao validar a regra do sudo; nada foi alterado."; exit 1
  fi
  exit 0
fi

# ------------------------------------------------------------------ watchdog (v4.2)
# O Restart=always do systemd só age quando o processo MORRE. Travado (thread presa, banco preso) ele
# continua "active" para sempre. Este timer chama /healthz a cada minuto e, depois de 3 falhas seguidas,
# reinicia o serviço. O script fica em /usr/local/sbin (dono root): o usuário do NetNOC não consegue
# alterá-lo, então rodar como root não abre brecha.
WD_BIN=/usr/local/sbin/netnoc-watchdog
WD_UNIT=/etc/systemd/system/netnoc-watchdog
if [ "$1" = "--watchdog" ] || [ "$1" = "--remover-watchdog" ]; then
  if [ "$1" = "--remover-watchdog" ]; then
    sudo systemctl disable --now netnoc-watchdog.timer 2>/dev/null || true
    sudo rm -f "$WD_BIN" "$WD_UNIT.service" "$WD_UNIT.timer"
    sudo systemctl daemon-reload
    echo "Watchdog removido."; exit 0
  fi
  [ -f /etc/systemd/system/netnoc.service ] || { echo "Crie o serviço antes: ./install.sh --service"; exit 1; }
  command -v curl >/dev/null 2>&1 || sudo apt-get install -y curl
  PORT="$(sed -n 's/.*--port[ =]\([0-9]\+\).*/\1/p' /etc/systemd/system/netnoc.service | head -1)"
  PORT="${PORT:-8000}"
  TMP="$(mktemp)"
  cat > "$TMP" <<WDEOF
#!/bin/bash
# NetNOC watchdog (criado por install.sh --watchdog). 3 falhas seguidas do /healthz -> restart.
STATE=/run/netnoc-watchdog.falhas
systemctl is-active --quiet netnoc || { rm -f "\$STATE"; exit 0; }   # parado de propósito: não mexe
PID="\$(systemctl show -p MainPID --value netnoc)"
AGE="\$(ps -o etimes= -p "\$PID" 2>/dev/null | tr -d ' ')"
[ -n "\$AGE" ] && [ "\$AGE" -lt 180 ] && exit 0                       # acabou de subir
if curl -fsS -m 20 -o /dev/null "http://127.0.0.1:$PORT/healthz"; then rm -f "\$STATE"; exit 0; fi
N=\$(( \$(cat "\$STATE" 2>/dev/null || echo 0) + 1 ))
echo "\$N" > "\$STATE"
logger -t netnoc-watchdog "healthz falhou (\$N/3)"
if [ "\$N" -ge 3 ]; then
  rm -f "\$STATE"
  logger -t netnoc-watchdog "NetNOC travado: reiniciando"
  systemctl restart netnoc
fi
WDEOF
  sudo install -m 0755 -o root -g root "$TMP" "$WD_BIN"; rm -f "$TMP"
  sudo tee "$WD_UNIT.service" >/dev/null <<WDEOF
[Unit]
Description=NetNOC watchdog (confere /healthz)

[Service]
Type=oneshot
ExecStart=$WD_BIN
WDEOF
  sudo tee "$WD_UNIT.timer" >/dev/null <<WDEOF
[Unit]
Description=NetNOC watchdog a cada minuto

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
WDEOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now netnoc-watchdog.timer
  echo "✔ Watchdog ativo: confere http://127.0.0.1:$PORT/healthz a cada minuto e reinicia o NetNOC após 3 falhas."
  echo "  Ver o que ele fez: journalctl -t netnoc-watchdog   |   Remover: ./install.sh --remover-watchdog"
  exit 0
fi

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

# ferramentas opcionais (traceroute, ping)
for pkg in traceroute iputils-ping; do
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
if [ -f requirements.lock ]; then
  echo "Usando requirements.lock (versões travadas desta instalação)"
  pip install -r requirements.txt -c requirements.lock
else
  pip install -r requirements.txt
fi

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
