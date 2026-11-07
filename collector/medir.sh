#!/usr/bin/env bash
# Mede, durante N segundos, o custo do NetNOC no Pi: CPU e RAM de cada processo,
# processos criados (cada ping pelo Python é um fork) e quanto foi escrito no cartão SD.
#
#   ./medir.sh [SEGUNDOS] [ROTULO]      ex.: ./medir.sh 300 antes   /  ./medir.sh 300 depois
#
# O resultado também vai para medicoes.txt (ao lado deste script) para comparar depois.
set -uo pipefail
SECS="${1:-120}"
LABEL="${2:-$(date +%H:%M)}"
OUT="$(cd "$(dirname "$0")" && pwd)/medicoes.txt"
HZ="$(getconf CLK_TCK)"

pid_of() { local p; p="$(systemctl show -p MainPID --value "$1" 2>/dev/null)"; [ -n "$p" ] && [ "$p" != 0 ] && echo "$p"; }
# utime+stime+cutime+cstime: inclui os filhos já encerrados (os "ping" do Python)
ticks() { [ -r "/proc/$1/stat" ] && awk '{print $14+$15+$16+$17}' "/proc/$1/stat" || echo 0; }
rss_kb() { [ -r "/proc/$1/status" ] && awk '/^VmRSS/{print $2}' "/proc/$1/status" || echo 0; }
forks() { awk '/^processes/{print $2}' /proc/stat; }
# setores escritos no cartão (mmcblk0) ou no primeiro disco que aparecer
DISK="$(awk '$3 ~ /^(mmcblk[0-9]+|sd[a-z]|nvme[0-9]n[0-9]|vd[a-z])$/ {print $3; exit}' /proc/diskstats)"
wsect() { awk -v d="$DISK" '$3==d {print $10}' /proc/diskstats; }

PY="$(pid_of netnoc || true)"
RS="$(pid_of netnoc-collector || true)"
[ -n "$PY" ] || { echo "netnoc.service não está rodando"; exit 1; }

echo "Medindo por ${SECS}s (NetNOC pid $PY${RS:+, coletor pid $RS})..."
t0p=$(ticks "$PY"); t0r=$( [ -n "$RS" ] && ticks "$RS" || echo 0 ); f0=$(forks); w0=$(wsect)
mem0=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
sleep "$SECS"
t1p=$(ticks "$PY"); t1r=$( [ -n "$RS" ] && ticks "$RS" || echo 0 ); f1=$(forks); w1=$(wsect)
mem1=$(awk '/MemAvailable/{print $2}' /proc/meminfo)

pct() { awk -v a="$1" -v b="$2" -v hz="$HZ" -v s="$SECS" 'BEGIN{printf "%.1f", (b-a)/hz/s*100}'; }
cpu_py=$(pct "$t0p" "$t1p"); cpu_rs=$(pct "$t0r" "$t1r")
rss_py=$(( $(rss_kb "$PY") / 1024 )); rss_rs=$(( $( [ -n "$RS" ] && rss_kb "$RS" || echo 0) / 1024 ))
fps=$(awk -v a="$f0" -v b="$f1" -v s="$SECS" 'BEGIN{printf "%.1f", (b-a)/s}')
kbw=$(awk -v a="$w0" -v b="$w1" -v s="$SECS" 'BEGIN{printf "%.0f", (b-a)*512/1024/s*3600}')

LINE=$(printf '%-10s %s  python: CPU %5s%%  RAM %4s MB | coletor: CPU %5s%%  RAM %3s MB | forks/s %5s | SD %6s KB/h (%s) | MemAvailable %s MB' \
  "$LABEL" "$(date '+%F %T')" "$cpu_py" "$rss_py" "${RS:+$cpu_rs}" "${RS:+$rss_rs}" "$fps" "$kbw" "${DISK:-?}" "$((mem1/1024))")
echo "$LINE" | tee -a "$OUT"
echo "(CPU em % de UM núcleo; o Pi 3 tem 4. Histórico em $OUT)"
