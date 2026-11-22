#!/bin/bash
# NetNOC — aplica uma atualização (.zip) com volta automática se der errado.
#
#   ./atualizar.sh netnoc-v4.2.zip     aplica, reinicia e confere o /healthz; falhou -> volta sozinho
#   ./atualizar.sh --desfazer          volta a última atualização aplicada
#
# O zip traz só os arquivos que mudaram e, se for o caso, um REMOVER.txt com os que saíram do projeto
# (um caminho por linha). Antes de mexer, tudo o que será sobrescrito ou apagado é guardado em
# atualizacoes/<data>.tar.gz. Banco, chave e config.json nunca são tocados.
# Rode como seu usuário (sem sudo); ele pede a senha só para reiniciar o serviço.
set -Eeuo pipefail
cd "$(dirname "$0")"
APPDIR="$(pwd)"
PY="$APPDIR/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
PORT="$(sed -n 's/.*--port[ =]\([0-9]\+\).*/\1/p' /etc/systemd/system/netnoc.service 2>/dev/null | head -1 || true)"
PORT="${NETNOC_PORT:-${PORT:-8000}}"
HIST=atualizacoes
mkdir -p "$HIST"

reiniciar() {
  if [ -n "${NETNOC_RESTART_CMD:-}" ]; then bash -c "$NETNOC_RESTART_CMD"; return; fi   # testes / instalação sem systemd
  if systemctl list-unit-files netnoc.service >/dev/null 2>&1 && [ -f /etc/systemd/system/netnoc.service ]; then
    sudo systemctl restart netnoc
  else
    echo "  (sem serviço systemd: reinicie o NetNOC você mesmo)"; return 0
  fi
}

saudavel() {
  # até 120 s para subir e responder 200 no /healthz
  for _ in $(seq 1 40); do
    sleep 3
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then return 0; fi
  done
  return 1
}

desfazer() {
  local tarf="$1" novos="$2" pipf="${2%.novos}.pip"
  echo "↩ Voltando para a versão anterior..."
  if [ -f "$novos" ]; then
    while IFS= read -r f; do [ -n "$f" ] && rm -f -- "$f"; done < "$novos"
  fi
  tar -xzf "$tarf"
  if [ -s "$pipf" ] && [ -x venv/bin/pip ]; then
    echo "  voltando as dependências Python para as versões de antes"
    venv/bin/pip install -q -r "$pipf" || echo "  (aviso: o pip não conseguiu voltar todas; veja $pipf)"
  fi
  reiniciar
  if saudavel; then echo "✔ Versão anterior de volta e respondendo."; else
    echo "✖ A versão anterior também não respondeu. Veja: journalctl -u netnoc -n 80"; fi
}

if [ "${1:-}" = "--desfazer" ]; then
  last="$(ls -1t "$HIST"/*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "$last" ] || { echo "Nenhuma atualização para desfazer."; exit 1; }
  echo "Desfazendo $(basename "$last" .tar.gz)"
  desfazer "$last" "${last%.tar.gz}.novos"
  mv "$last" "$last.desfeito"
  exit 0
fi

ZIP="${1:-}"
[ -f "$ZIP" ] || { sed -n '2,10p' "$0"; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
TARF="$HIST/$STAMP.tar.gz"
NOVOS="$HIST/$STAMP.novos"

# 1) confere o zip e monta as listas (sobrescritos, novos, removidos); nada é alterado ainda
"$PY" -I - "$ZIP" "$HIST/$STAMP" <<'PY'
import os, sys, zipfile
zpath, base = sys.argv[1], sys.argv[2]
PROTEGIDOS = {"netnoc.db", "netnoc-historico.db", "netnoc.key", "config.json", "go2rtc.yaml"}
def seguro(p):
    p = p.replace("\\", "/")
    n = os.path.normpath(p)
    return p and not p.startswith("/") and not n.startswith("..") and "/../" not in "/" + p + "/" and n not in PROTEGIDOS \
        and not n.startswith(("venv/", "atualizacoes/", "bin/", ".git/")) and not n.endswith((".db", ".key"))
z = zipfile.ZipFile(zpath)
nomes = [i.filename for i in z.infolist() if not i.is_dir()]
ruins = [n for n in nomes if not seguro(n)]
if ruins:
    sys.exit("Zip recusado, caminhos não permitidos: " + ", ".join(ruins[:5]))
remover = []
if "REMOVER.txt" in nomes:
    for ln in z.read("REMOVER.txt").decode("utf-8").splitlines():
        ln = ln.split("#", 1)[0].strip()
        if not ln:
            continue
        if not seguro(ln):
            sys.exit(f"REMOVER.txt: caminho não permitido: {ln}")
        if os.path.isdir(ln):
            for r, _, fs in os.walk(ln):
                remover += [os.path.join(r, f) for f in fs]
        elif os.path.exists(ln):
            remover.append(ln)
    nomes.remove("REMOVER.txt")
existentes = [n for n in nomes if os.path.exists(n)]
novos = [n for n in nomes if not os.path.exists(n)]
open(base + ".guardar", "w").write("\n".join(sorted(set(existentes + remover))))
open(base + ".novos", "w").write("\n".join(novos))
open(base + ".remover", "w").write("\n".join(remover))
open(base + ".extrair", "w").write("\n".join(nomes))
print(f"  {len(existentes)} arquivo(s) atualizado(s), {len(novos)} novo(s), {len(remover)} removido(s)")
PY

# 2) guarda o estado atual de tudo que vai mudar
if [ -s "$HIST/$STAMP.guardar" ]; then
  tar -czf "$TARF" -T "$HIST/$STAMP.guardar"
else
  tar -czf "$TARF" --files-from /dev/null
fi
echo "  cópia de segurança: $TARF"
REQ_ANTES="$(sha256sum requirements.txt 2>/dev/null | cut -d' ' -f1 || true)"

# 3) aplica: extrai, remove o que saiu
"$PY" -I - "$ZIP" "$HIST/$STAMP" <<'PY'
import os, sys, zipfile
zpath, base = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zpath)
for n in open(base + ".extrair").read().split("\n"):
    if not n:
        continue
    d = os.path.dirname(n)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = n + ".novo"
    with z.open(n) as src, open(tmp, "wb") as dst:
        dst.write(src.read())
    mode = (z.getinfo(n).external_attr >> 16) & 0o777
    if n.endswith(".sh") or mode & 0o111:
        os.chmod(tmp, 0o755)
    os.replace(tmp, n)
for n in open(base + ".remover").read().split("\n"):
    if n and os.path.exists(n):
        os.remove(n)
# pastas que ficaram vazias depois das remoções
for n in sorted({os.path.dirname(x) for x in open(base + ".remover").read().split("\n") if x}, key=len, reverse=True):
    try:
        while n and not os.listdir(n):
            os.rmdir(n); n = os.path.dirname(n)
    except OSError:
        pass
PY
rm -f "$HIST/$STAMP.guardar" "$HIST/$STAMP.extrair" "$HIST/$STAMP.remover"

if [ "$REQ_ANTES" != "$(sha256sum requirements.txt 2>/dev/null | cut -d' ' -f1 || true)" ] && [ -x venv/bin/pip ]; then
  venv/bin/pip freeze --exclude-editable > "$HIST/$STAMP.pip" 2>/dev/null || true     # para voltar as versões se der errado
  echo "  requirements.txt mudou: instalando dependências"
  venv/bin/pip install -q -r requirements.txt || { echo "✖ pip falhou"; desfazer "$TARF" "$NOVOS"; mv "$TARF" "$TARF.desfeito"; exit 1; }
fi

# 4) reinicia e confere
echo "  reiniciando o NetNOC..."
reiniciar
if saudavel; then
  echo "✔ Atualização aplicada e o NetNOC está respondendo. Para voltar: ./atualizar.sh --desfazer"
  ls -1t "$HIST"/*.tar.gz 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f" "${f%.tar.gz}.novos" "${f%.tar.gz}.pip"; done   # guarda as 5 últimas
else
  echo "✖ O NetNOC não respondeu depois da atualização."
  desfazer "$TARF" "$NOVOS"
  mv "$TARF" "$TARF.desfeito"      # já desfeita: o --desfazer seguinte volta a anterior a ela
  exit 1
fi
