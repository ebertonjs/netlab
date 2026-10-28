#!/bin/bash
# NetNOC — reinstalador / desinstalador com backup automático.
#
# Uso (rode como seu usuário, SEM sudo; ele pede a senha quando precisa):
#   ./reinstalar.sh                  backup + remove + instala de novo (última versão do GitHub) + restaura os dados
#   ./reinstalar.sh --sem-historico  idem, mas recomeça o histórico do zero (mantém só a configuração)
#   ./reinstalar.sh --desinstalar    backup + remove (não instala de novo)
#   ./reinstalar.sh --backup         só faz o backup (não mexe em nada)
#   ./reinstalar.sh --restaurar DIR  instala de novo usando um backup feito antes (pasta DIR)
#
# Opções extras: --dir CAMINHO (pasta da instalação; padrão: a deste script ou a do serviço)
#                --repo URL     (padrão: https://github.com/ebertonjs/netlab.git)
#                --sim          responde "sim" às perguntas
#
# O que é guardado: netnoc.db (configuração), netnoc.key (chave das senhas), netnoc-historico.db (histórico),
# config.json e o arquivo do serviço systemd. A instalação antiga é MOVIDA para o backup (não apagada) até a nova
# subir; se algo der errado, ela volta para o lugar sozinha.
set -Eeuo pipefail

REPO="https://github.com/ebertonjs/netlab.git"
MODE="reinstalar"
KEEP_HIST=1
YES=0
APPDIR=""
RESTORE_FROM=""
UNIT="${NETNOC_UNIT:-/etc/systemd/system/netnoc.service}"

while [ $# -gt 0 ]; do
  case "$1" in
    --sem-historico) KEEP_HIST=0 ;;
    --desinstalar) MODE="desinstalar" ;;
    --backup) MODE="backup" ;;
    --restaurar) MODE="restaurar"; RESTORE_FROM="${2:-}"; shift ;;
    --dir) APPDIR="${2:-}"; shift ;;
    --repo) REPO="${2:-}"; shift ;;
    --sim|-y) YES=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1 (veja --help)"; exit 1 ;;
  esac
  shift
done

c_ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
c_info() { printf '\033[36m• %s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$*"; exit 1; }
ask() { [ "$YES" = 1 ] && return 0; read -r -p "$1 [s/N] " r; [[ "$r" =~ ^[sSyY] ]]; }

[ "$(id -u)" = 0 ] && [ "${NETNOC_ALLOW_ROOT:-}" != 1 ] && die "Rode sem sudo (como o usuário que roda o NetNOC). O script pede a senha quando precisar."

# ---------------------------------------------------------------- onde está a instalação
if [ -z "$APPDIR" ] && [ "$MODE" = "restaurar" ]; then
  # instala no mesmo lugar de antes (anotado no backup) ou em ~/netlab
  if [ -f "$RESTORE_FROM/netnoc.service" ]; then APPDIR="$(sed -n 's/^WorkingDirectory=//p' "$RESTORE_FROM/netnoc.service" | head -1)"; fi
  APPDIR="${APPDIR:-$HOME/netlab}"
fi
if [ -z "$APPDIR" ] && [ -f "$UNIT" ]; then
  APPDIR="$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -1)"
fi
if [ -z "$APPDIR" ]; then
  APPDIR="$(cd "$(dirname "$0")" && pwd)"
fi
APPDIR="$(cd "$APPDIR" 2>/dev/null && pwd || echo "$APPDIR")"
case "$APPDIR" in
  /|"$HOME"|"$HOME/"|/home|/root|/usr|/etc|/var|/opt|"") die "Pasta de instalação perigosa: '$APPDIR'. Use --dir com a pasta do NetNOC." ;;
esac
if [ -d "$APPDIR" ] && [ "$MODE" != "restaurar" ] && [ ! -f "$APPDIR/main.py" ]; then
  die "$APPDIR não parece ser uma instalação do NetNOC (sem main.py). Use --dir com a pasta certa."
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${NETNOC_BACKUP_DIR:-$HOME/netnoc-backup}/$STAMP"

# a pasta da instalação vai ser movida: continua rodando a partir de uma cópia deste script
if [ -z "${NETNOC_REINST_COPY:-}" ] && [[ "$(cd "$(dirname "$0")" && pwd)" == "$APPDIR"* ]] && [ "$MODE" != "backup" ]; then
  tmp="$(mktemp /tmp/netnoc-reinstalar.XXXXXX.sh)"
  cp "$0" "$tmp"; chmod +x "$tmp"
  args=(--dir "$APPDIR" --repo "$REPO")
  [ "$KEEP_HIST" = 0 ] && args+=(--sem-historico)
  [ "$YES" = 1 ] && args+=(--sim)
  case "$MODE" in desinstalar) args+=(--desinstalar) ;; restaurar) args+=(--restaurar "$RESTORE_FROM") ;; esac
  NETNOC_REINST_COPY=1 exec "$tmp" "${args[@]}"
fi

svc_exists() { [ -f "$UNIT" ]; }
svc_stop() { if svc_exists; then sudo systemctl stop netnoc 2>/dev/null || true; fi; }

# ---------------------------------------------------------------- backup
do_backup() {
  [ -d "$APPDIR" ] || die "Instalação não encontrada em $APPDIR (use --dir CAMINHO)"
  if [ ! -f "$APPDIR/netnoc.db" ]; then c_warn "Não achei netnoc.db em $APPDIR — o backup vai sem configuração."; fi
  mkdir -p "$BACKUP"
  # banco consistente: o serviço é parado antes da cópia (WAL pendente vai junto)
  svc_stop
  local f n=0 files=(netnoc.db netnoc.db-wal netnoc.db-shm netnoc.key config.json)
  if [ "$KEEP_HIST" = 1 ]; then files+=(netnoc-historico.db netnoc-historico.db-wal netnoc-historico.db-shm); fi
  for f in "${files[@]}"; do
    if [ -f "$APPDIR/$f" ]; then cp -p "$APPDIR/$f" "$BACKUP/"; n=$((n + 1)); fi
  done
  if svc_exists; then cp "$UNIT" "$BACKUP/netnoc.service"; fi
  ( cd "$APPDIR" && git rev-parse --short HEAD > "$BACKUP/versao.txt" 2>/dev/null ) || true
  if [ ! -f "$BACKUP/netnoc.key" ]; then c_warn "netnoc.key não encontrado: senhas salvas (Telegram, MikroTik, DVR) não vão abrir depois."; fi
  c_ok "Backup em $BACKUP ($n arquivos, $(du -sh "$BACKUP" | cut -f1))"
}

# ---------------------------------------------------------------- serviço: mantém porta e variáveis do antigo
carry_unit() {
  local old="$1"
  if [ ! -f "$old" ] || [ ! -f "$UNIT" ]; then return 0; fi
  local port envs
  port="$(sed -n 's/.*--port \([0-9]\+\).*/\1/p' "$old" | head -1)"
  envs="$(grep '^Environment=' "$old" | grep -v 'PYTHONUNBUFFERED' || true)"
  if [ -n "$port" ] && [ "$port" != 8000 ]; then
    sudo sed -i "s/--port 8000/--port $port/" "$UNIT"
    c_info "Porta mantida: $port"
  fi
  if [ -n "$envs" ]; then
    while IFS= read -r line; do
      sudo sed -i "/^\[Service\]/a $line" "$UNIT"
    done <<< "$envs"
    c_info "Variáveis mantidas: $(echo "$envs" | sed 's/Environment=//' | tr '\n' ' ')"
  fi
  sudo systemctl daemon-reload
  sudo systemctl restart netnoc
}

wait_up() {
  local port url i
  port="$(sed -n 's/.*--port \([0-9]\+\).*/\1/p' "$UNIT" 2>/dev/null | head -1)"; port="${port:-8000}"
  url="http://127.0.0.1:$port/healthz"
  for i in $(seq 1 45); do
    if curl -fsS -m 3 "$url" >/dev/null 2>&1; then
      c_ok "NetNOC respondendo em http://$(hostname -I 2>/dev/null | awk '{print $1}'):$port"
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_into() {
  local src="$1" dst="$2" f files=(netnoc.db netnoc.db-wal netnoc.db-shm netnoc.key config.json)
  if [ "$KEEP_HIST" = 1 ]; then files+=(netnoc-historico.db netnoc-historico.db-wal netnoc-historico.db-shm); fi
  for f in "${files[@]}"; do
    if [ -f "$src/$f" ]; then cp -p "$src/$f" "$dst/"; fi
  done
}

install_fresh() {
  local src="$1"     # pasta com os dados a restaurar
  if ! command -v git >/dev/null 2>&1; then c_info "Instalando git..."; sudo apt-get install -y git; fi
  c_info "Baixando a versão atual de $REPO ..."
  git clone --depth 1 "$REPO" "$APPDIR"
  restore_into "$src" "$APPDIR"
  c_info "Instalando (dependências, go2rtc e serviço)..."
  ( cd "$APPDIR" && chmod +x install.sh && ./install.sh --service )
  carry_unit "$src/netnoc.service"
}

# ---------------------------------------------------------------- fluxo
echo
echo "NetNOC — $MODE"
echo "  instalação: $APPDIR"
[ "$MODE" != "restaurar" ] && echo "  backup em:  $BACKUP"
[ "$MODE" = "reinstalar" ] && echo "  histórico:  $([ "$KEEP_HIST" = 1 ] && echo mantido || echo 'recomeça do zero')"
echo

case "$MODE" in
  backup)
    do_backup
    ;;

  desinstalar)
    ask "Fazer backup e REMOVER o NetNOC deste aparelho?" || exit 0
    do_backup
    if svc_exists; then
      sudo systemctl disable netnoc 2>/dev/null || true
      sudo rm -f "$UNIT"; sudo systemctl daemon-reload
    fi
    rm -rf "$APPDIR"
    c_ok "NetNOC removido. Seus dados estão em $BACKUP"
    echo "  Para instalar de novo com eles:  ./reinstalar.sh --restaurar $BACKUP"
    echo "  (baixe o script antes: curl -fsSLO https://raw.githubusercontent.com/ebertonjs/netlab/main/reinstalar.sh)"
    ;;

  restaurar)
    if [ ! -d "$RESTORE_FROM" ]; then die "Pasta de backup não encontrada: $RESTORE_FROM"; fi
    if [ ! -f "$RESTORE_FROM/netnoc.db" ]; then c_warn "Esse backup não tem netnoc.db — a instalação começa sem configuração."; fi
    if [ -e "$APPDIR" ] && [ -n "$(ls -A "$APPDIR" 2>/dev/null)" ]; then die "$APPDIR já existe e não está vazio. Use --dir outro caminho ou remova antes."; fi
    ask "Instalar o NetNOC em $APPDIR usando o backup $RESTORE_FROM?" || exit 0
    install_fresh "$RESTORE_FROM"
    wait_up || die "O serviço não respondeu. Veja: journalctl -u netnoc -n 50 --no-pager"
    ;;

  reinstalar)
    ask "Fazer backup, remover e instalar de novo o NetNOC?" || exit 0
    do_backup
    OLD="$BACKUP/instalacao-antiga"
    mv "$APPDIR" "$OLD"
    c_info "Instalação antiga guardada em $OLD (volta sozinha se algo falhar)"
    rollback() {
      c_warn "Algo deu errado — voltando a instalação antiga..."
      rm -rf "$APPDIR"; mv "$OLD" "$APPDIR"
      if [ -f "$BACKUP/netnoc.service" ]; then sudo cp "$BACKUP/netnoc.service" "$UNIT"; fi
      sudo systemctl daemon-reload; sudo systemctl enable --now netnoc 2>/dev/null || true
      sudo systemctl restart netnoc 2>/dev/null || true
      die "Reinstalação cancelada; a versão anterior foi restaurada. Backup em $BACKUP"
    }
    trap rollback ERR
    install_fresh "$BACKUP"
    wait_up || rollback
    trap - ERR
    if ask "Tudo certo. Apagar a instalação antiga de $OLD (os dados continuam no backup)?"; then
      rm -rf "$OLD"
      c_ok "Instalação antiga removida"
    fi
    c_ok "Reinstalação concluída ($(cd "$APPDIR" && git rev-parse --short HEAD 2>/dev/null || echo '?'))."
    echo "  Backup dos dados: $BACKUP"
    ;;
esac
