# netnoc-collector (Rust)

Binário separado que faz a coleta pesada do NetNOC e grava no **mesmo SQLite** do painel:

| Módulo | O que coleta | Tabelas (em `netnoc-historico.db`) |
|---|---|---|
| `ping` | todos os destinos: **ICMP nativo** (sem `ping` do sistema), **TCP** e **HTTP(S)**, cada um no seu intervalo | `pings(target, ts, latency, success, jitter)` |
| `mikrotik` | REST: `system/resource`, `system/health`, `interface` | `mikrotik_resource`, `mikrotik_iface`, `meta.mt_comments` |
| `agh` | AdGuard Home `/control/stats` | `agh_stats` |
| — | estado de cada módulo e heartbeat | `meta.collector:*`, `events` (falhas de coleta) |

O resto continua no Python, com a mesma lógica de antes: API, painel, incidentes (offline, perda, latência, jitter, queda local), rollups, limpeza, DHCP, DNS, IP público, sistema, SNMP, certificados e speedtest.

Como os dois lados se conversam:

- **O Python não grava mais esses dados.** Com `NETNOC_EXTERNAL_COLLECTOR=ping,mikrotik,agh` no `netnoc.service`, o Python lê a cada segundo as amostras novas de `pings` e passa pela mesma avaliação de incidentes. Os workers de MikroTik e AdGuard ficam parados; só o sincronismo do DHCP continua.
- **Volta automática.** Se o coletor parar (heartbeat com mais de 60 s, ou SIGTERM), o Python volta a coletar sozinho na hora e registra um evento. Quando o coletor volta, ele devolve a coleta.
- **Painel de saúde.** Em Configurações → Geral → Coletores aparecem `rust:ping`, `rust:mikrotik` e `rust:agh`.

---

## 1. Qual target usar no Pi 3

O Pi 3 tem CPU de 64 bits, mas o DietPi existe em imagem de 32 bits (ARMv7) e de 64 bits (ARMv8). O que decide é o **sistema**, não o kernel:

```bash
dpkg --print-architecture     # armhf  ou  arm64   <- este decide
uname -m                      # armv7l ou  aarch64 (só o kernel)
```

| `dpkg --print-architecture` | Target Rust |
|---|---|
| `armhf` | `armv7-unknown-linux-musleabihf` |
| `arm64` | `aarch64-unknown-linux-musl` |

Usamos **musl estático**: um arquivo só, sem depender da glibc do DietPi. SQLite (`bundled`) e TLS (rustls/ring) já vão dentro. Não há OpenSSL.

## 2. Baixar pronto (recomendado)

Cada versão do NetNOC publica o coletor já compilado em [Releases](https://github.com/ebertonjs/netlab/releases/latest) (feito pelo GitHub Actions, `.github/workflows/coletor.yml`, depois de rodar os testes). No Pi, na pasta do NetNOC:

```bash
cd collector
curl -LO https://github.com/ebertonjs/netlab/releases/latest/download/netnoc-collector-armhf   # ou -arm64
mv netnoc-collector-armhf netnoc-collector
chmod +x netnoc-collector instalar-coletor.sh medir.sh
./instalar-coletor.sh ./netnoc-collector
```

O `SHA256SUMS.txt` da release confere a integridade (`sha256sum -c`). Para compilar você mesmo, siga abaixo.

## 2b. Compilar no seu PC (cross-compile)

### Opção A — cargo-zigbuild (recomendada; Linux, WSL2 ou macOS)

```bash
# uma vez
rustup target add armv7-unknown-linux-musleabihf aarch64-unknown-linux-musl
pip install ziglang            # ou instale o zig pelo gerenciador de pacotes
cargo install cargo-zigbuild

# a cada versão (dentro de netlab/collector)
cargo zigbuild --release --target armv7-unknown-linux-musleabihf     # DietPi armhf
cargo zigbuild --release --target aarch64-unknown-linux-musl         # DietPi arm64
```

O binário fica em `target/<target>/release/netnoc-collector` (cerca de 4 MB).

> No Windows, use o **WSL2** (Ubuntu): é o caminho mais simples. O zigbuild nativo no Windows também funciona, mas a compilação do SQLite em C é mais sensível a esse ambiente.

### Opção B — cross (precisa de Docker)

```bash
cargo install cross
cross build --release --target armv7-unknown-linux-musleabihf
```

### Opção C — compilar no próprio Pi

Funciona, mas leva uns 20–30 min no Pi 3 e pode faltar RAM no LTO. Se for compilar no Pi, use `CARGO_PROFILE_RELEASE_LTO=thin cargo build --release` e deixe um swap de 1 GB.

### Testes (no PC)

```bash
cargo test                      # 28 testes: unidade + integração
cargo test -- --ignored         # + ICMP de verdade em 127.0.0.1 (precisa de CAP_NET_RAW ou root)
```

| Onde | O que cobre |
|---|---|
| `src/*` (unidade) | backoff (dobra, teto, jitter, patamares de log), configuração (exemplo do repositório válido, campo desconhecido com linha, faixas, prioridade do ambiente, módulo inválido), cache de DNS com backoff, uptime do RouterOS, decifragem Fernet igual à do Python |
| `tests/mikrotik_simulado.rs` | MikroTik falso (servidor HTTP local): coleta completa com autenticação, bps entre duas coletas, HTTP 401/500, JSON inválido, timeout, conexão recusada, senha nunca no erro, endereço sem `/rest` duplicado |
| `tests/adguard_simulado.rs` | AdGuard falso: estatísticas, autenticação só com usuário, falhas |
| `tests/ping_agendador.rs` | agendador de ping com sonda simulada gravando num SQLite real: intervalos, latência, falha, jitter, destino fora sem backoff, tipo `agent` ignorado, destino removido sai da agenda |

O coletor não faz SNMP (isso continua no Python, pelo net-snmp).

## 3. Deploy no Pi

```bash
# no PC
scp target/armv7-unknown-linux-musleabihf/release/netnoc-collector dietpi@IP_DO_PI:~/netnoc/netnoc/collector/

# no Pi, na pasta do NetNOC
cd ~/netnoc/netnoc/collector
chmod +x instalar-coletor.sh medir.sh
./instalar-coletor.sh ./netnoc-collector
```

O `instalar-coletor.sh`:
1. confere a arquitetura do binário;
2. copia para `/usr/local/bin` e cria `/etc/netnoc-collector.toml`;
3. roda `--check` (abre o banco, lê destinos, decifra as senhas);
4. cria `netnoc-collector.service` com o **mesmo usuário** do `netnoc.service` (sem root, só `CAP_NET_RAW`);
5. cria o drop-in `/etc/systemd/system/netnoc.service.d/coletor.conf` com `NETNOC_EXTERNAL_COLLECTOR=ping,mikrotik,agh`;
6. liga o coletor no boot e reinicia o NetNOC.

Para **atualizar**, rode o mesmo comando com o binário novo. Para **voltar atrás**:

```bash
./instalar-coletor.sh --remover     # para o coletor, apaga o drop-in e reinicia o NetNOC: tudo volta ao Python
```

Para assumir só uma parte, use `NETNOC_COLLECTOR_MODULES=ping ./instalar-coletor.sh ./netnoc-collector`. O valor vale para o drop-in **e** para o `[modules]` do `.toml`: ajuste os dois se mudar depois.

### Configuração

`/etc/netnoc-collector.toml` (exemplo comentado em `netnoc-collector.toml.example`). As variáveis de ambiente têm prioridade:

| Variável | Padrão |
|---|---|
| `NETNOC_DB` | `db` do .toml |
| `NETNOC_HIST_DB` | `netnoc-historico.db` ao lado do `netnoc.db` |
| `NETNOC_KEY_FILE` / `NETNOC_SECRET_KEY` | `netnoc.key` ao lado do `netnoc.db` |
| `NETNOC_COLLECTOR_LOG` | `info` (`debug` mostra cada lote gravado) |
| `NETNOC_COLLECTOR_MODULES` | `ping,mikrotik,agh` (nome desconhecido = erro) |

Destinos, intervalos, MikroTik e AdGuard continuam sendo configurados **na interface**. O coletor relê o banco a cada 5 s.

**Validação rigorosa:** campo com nome errado no `.toml`, valor fora da faixa (ex.: `tick_ms = 10`) ou módulo desconhecido em `NETNOC_COLLECTOR_MODULES` impedem a partida, com todos os problemas listados e a linha do arquivo. Confira antes de reiniciar o serviço:

```bash
netnoc-collector -c /etc/netnoc-collector.toml --check
```

### Quando um equipamento cai (backoff)

| Onde | Comportamento |
|---|---|
| MikroTik e AdGuard | a cada falha seguida o intervalo dobra (60 s → 120 → 240 → 480 → 600 s), com ±10% de variação, até `retry.max_backoff_secs`; no primeiro sucesso volta ao normal. O evento "Falha ao coletar…" é gravado **uma vez** por sequência e um "Coleta … restabelecida" na volta; o log só repete na 1ª, 2ª, 4ª, 8ª… falha. |
| Ping (ICMP/TCP/HTTP) | **sem backoff**: um destino fora continua sendo testado no intervalo dele, senão a volta demoraria a aparecer e a disponibilidade ficaria errada. |
| DNS dos destinos por nome | o IP fica em cache por `ping.dns_cache_secs`; um nome que não resolve espera 1, 2, 4… s (até `retry.dns_max_backoff_secs`) antes de o DNS ser consultado de novo. |

## 4. Testar no Pi (antes × depois)

1. **Antes** (só Python), com o painel aberto como no dia a dia:
   ```bash
   ./instalar-coletor.sh --remover      # se já tiver instalado
   sleep 120 && ./medir.sh 300 antes
   ```
2. **Instale** o coletor (passo 3), espere 2 min e meça de novo:
   ```bash
   ./medir.sh 300 depois
   cat medicoes.txt
   ```
   - **CPU do python:** deve cair bastante, porque cada ping deixava de ser um processo `ping` novo.
   - **forks/s:** deve ir para perto de 0.
   - **RAM do coletor:** fica em torno de 6–10 MB.
   - **SD (KB/h):** escrita no cartão no sistema todo.
3. **Os dados continuam certos?**
   - `journalctl -u netnoc-collector -f`: sem erros, e "coletando de …" para MikroTik e AdGuard.
   - Configurações → Geral → Coletores: `rust:ping`, `rust:mikrotik` e `rust:agh` em **ok**; `ping` (Python) também ok, agora só lendo.
   - Página inicial: latências se mexendo, portas do MikroTik com tráfego e comentário, AdGuard com consultas subindo.
   - Teste de queda: desligue da tomada um aparelho monitorado. Em ~3 ciclos o incidente **offline** deve abrir, e fechar quando ele voltar (igual a antes).
   - Teste de volta automática: `sudo systemctl stop netnoc-collector`. No log de eventos aparece "coleta voltou para o NetNOC" e os gráficos não param. Depois, `sudo systemctl start netnoc-collector`.
   - Comparação direta (no Pi, com o `sqlite3` instalado):
     ```bash
     sqlite3 ~/netnoc/netnoc/netnoc-historico.db \
       "SELECT target, COUNT(*), ROUND(AVG(latency),2), SUM(success=0) FROM pings
        WHERE ts > strftime('%s','now') - 600 GROUP BY target;"
     ```
     Cada destino deve ter cerca de `600 / intervalo` amostras. As latências tendem a ficar um pouco **menores** que as do `ping` do sistema, porque não há o custo de criar um processo a cada medição.

## 5. Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| `sem permissão para abrir socket ICMP` | Falta `AmbientCapabilities=CAP_NET_RAW` no serviço, ou você rodou na mão sem root. Para testar na mão: `sudo setcap cap_net_raw+ep /usr/local/bin/netnoc-collector`. |
| `tabelas ainda não criadas pelo NetNOC` | O Python ainda não criou o `netnoc-historico.db`. Inicie o `netnoc` uma vez; o coletor espera sozinho. |
| `--check` mostra MikroTik "(SEM senha!)" | A chave não confere com a do Python. O coletor lê `netnoc.key` na pasta do banco, ou `NETNOC_SECRET_KEY`. |
| Eventos "coleta voltou para o NetNOC" se repetindo | O coletor está caindo: veja `journalctl -u netnoc-collector`. |
| Destinos IPv6 sempre fora | IPv6 desligado no kernel do Pi: o coletor avisa no log ao iniciar. |
