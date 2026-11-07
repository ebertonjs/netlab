#!/usr/bin/env bash
# Instala (ou remove) o netnoc-collector no Pi, ao lado do NetNOC já instalado como serviço.
#
#   ./instalar-coletor.sh [BINÁRIO]     instala/atualiza (padrão: ./netnoc-collector ao lado deste script)
#   ./instalar-coletor.sh --remover     volta tudo para o Python (o binário e o .toml ficam)
#
# O que faz:
#   1. confere se o binário é da arquitetura do sistema (armhf/arm64)
#   2. copia para /usr/local/bin e cria /etc/netnoc-collector.toml (se não existir)
#   3. cria netnoc-collector.service com o mesmo usuário e pasta do netnoc.service
#   4. avisa o Python por um drop-in (netnoc.service.d/coletor.conf) para não coletar ping/MikroTik/AdGuard
#   5. testa (--check), liga o coletor no boot e reinicia o NetNOC
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DROPIN_DIR=/etc/systemd/system/netnoc.service.d
DROPIN=$DROPIN_DIR/coletor.conf
UNIT=/etc/systemd/system/netnoc-collector.service
CONF=/etc/netnoc-collector.toml
BIN=/usr/local/bin/netnoc-collector
MODULES="${NETNOC_COLLECTOR_MODULES:-ping,mikrotik,agh}"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
info() { printf '• %s\n' "$*"; }
fail() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

command -v systemctl >/dev/null || fail "systemd não encontrado"

if [ "${1:-}" = "--remover" ]; then
  info "Parando o coletor e devolvendo a coleta ao Python..."
  sudo systemctl disable --now netnoc-collector 2>/dev/null || true
  sudo rm -f "$DROPIN"
  sudo rmdir "$DROPIN_DIR" 2>/dev/null || true
  sudo systemctl daemon-reload
  sudo systemctl restart netnoc
  ok "Pronto: o NetNOC voltou a coletar tudo. ($BIN e $CONF continuam lá; apague se quiser.)"
  exit 0
fi

SRC="${1:-$HERE/netnoc-collector}"
[ -f "$SRC" ] || fail "binário não encontrado: $SRC (passe o caminho: ./instalar-coletor.sh /caminho/netnoc-collector)"

# ---- usuário e pasta do NetNOC (do serviço existente)
systemctl cat netnoc >/dev/null 2>&1 || fail "netnoc.service não existe — instale o NetNOC como serviço antes (./install.sh --service)"
USER_NAME="$(systemctl show -p User --value netnoc)"
APPDIR="$(systemctl show -p WorkingDirectory --value netnoc)"
[ -n "$USER_NAME" ] || USER_NAME="$(id -un)"
[ -n "$APPDIR" ] && [ -d "$APPDIR" ] || fail "pasta do NetNOC não encontrada (WorkingDirectory do netnoc.service)"
[ -f "$APPDIR/netnoc.db" ] || fail "$APPDIR/netnoc.db não existe — inicie o NetNOC uma vez antes"
info "NetNOC em $APPDIR (usuário $USER_NAME)"

# ---- arquitetura: e_machine do ELF (offset 18): 0x28 = ARM 32 bits, 0xb7 = AArch64, 0x3e = x86_64
ARCH_SYS="$(dpkg --print-architecture 2>/dev/null || uname -m)"
EM="$(od -An -tx1 -j18 -N1 "$SRC" | tr -d ' ')"
case "$EM" in 28) ARCH_BIN=armhf ;; b7) ARCH_BIN=arm64 ;; 3e) ARCH_BIN=amd64 ;; *) ARCH_BIN="desconhecida($EM)" ;; esac
case "$ARCH_SYS" in armv7l|armhf) ARCH_SYS=armhf ;; aarch64|arm64) ARCH_SYS=arm64 ;; x86_64|amd64) ARCH_SYS=amd64 ;; esac
[ "$ARCH_BIN" = "$ARCH_SYS" ] || fail "binário é $ARCH_BIN, mas o sistema é $ARCH_SYS — compile para o target certo (veja collector/README.md)"
ok "arquitetura: $ARCH_SYS"

# ---- binário e configuração
sudo install -m 0755 "$SRC" "$BIN"
ok "$("$BIN" --version) em $BIN"
if [ ! -f "$CONF" ]; then
  sed "s#^db = .*#db = \"$APPDIR/netnoc.db\"#" "$HERE/netnoc-collector.toml.example" | sudo tee "$CONF" >/dev/null
  ok "criado $CONF"
else
  info "$CONF já existe (mantido)"
fi

# ---- teste antes de ligar
info "Testando acesso ao banco e às integrações..."
sudo -u "$USER_NAME" env NETNOC_COLLECTOR_CONFIG="$CONF" NETNOC_COLLECTOR_LOG=warn "$BIN" --check || fail "o --check falhou (veja a mensagem acima)"

# ---- serviço do coletor
sed -e "s#USUARIO#$USER_NAME#g" -e "s#PASTA#$APPDIR#g" "$HERE/netnoc-collector.service" | sudo tee "$UNIT" >/dev/null
# chave do Python: se estiver só no ambiente do netnoc.service, repassa ao coletor
if systemctl show -p Environment --value netnoc | grep -q 'NETNOC_SECRET_KEY='; then
  KEYLINE="$(systemctl show -p Environment --value netnoc | tr ' ' '\n' | grep '^NETNOC_SECRET_KEY=')"
  sudo sed -i "/^Environment=NETNOC_COLLECTOR_CONFIG/a Environment=$KEYLINE" "$UNIT"
  sudo chmod 600 "$UNIT"
fi
ok "criado $UNIT"

# ---- avisa o Python (drop-in: some com --remover; o reinstalar.sh não mexe nele)
sudo mkdir -p "$DROPIN_DIR"
printf '[Service]\nEnvironment=NETNOC_EXTERNAL_COLLECTOR=%s\n' "$MODULES" | sudo tee "$DROPIN" >/dev/null
ok "NetNOC avisado: $MODULES ficam com o coletor ($DROPIN)"

sudo systemctl daemon-reload
sudo systemctl enable --now netnoc-collector
sudo systemctl restart netnoc
sleep 6
if systemctl is-active --quiet netnoc-collector && systemctl is-enabled --quiet netnoc-collector; then
  ok "netnoc-collector ativo e iniciando no boot"
else
  sudo journalctl -u netnoc-collector -n 20 --no-pager
  fail "o coletor não ficou ativo (log acima)"
fi
echo ""
echo "Logs:      journalctl -u netnoc-collector -f"
echo "Medir:     $HERE/medir.sh 120"
echo "Desfazer:  $0 --remover"
