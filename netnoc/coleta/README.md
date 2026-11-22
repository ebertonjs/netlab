# Coleta (`netnoc/coleta`)

Tudo que mede a rede e decide quando algo virou um problema.

| Arquivo | O que faz |
|---|---|
| `monitor.py` | **Fachada** (v4.4): reexporta os módulos abaixo, para o resto do projeto continuar usando `monitor.X`, e liga os coletores (`start_all`). Código novo importa direto do módulo do assunto. |
| `base.py` · `ajustes.py` · `telegram.py` · `alvos.py` · `incidentes.py` · `ping.py` · `mikrotik.py` · `adguard.py` · `sistema.py` · `laco.py` | O antigo `monitor.py`, um arquivo por assunto: constantes e estado; nome/intervalos; alertas pelo Telegram; destinos e DNS; incidentes e eventos; ping/TCP/HTTP e leitura do coletor Rust; MikroTik, DHCP, topologia e pico da WAN; AdGuard; DNS/IP público/servidor/certificados/limpeza; laço supervisionado e saúde dos coletores. As dependências entre eles ficam no fim de cada arquivo (há ciclos, resolvidos na hora da chamada). |
| `medir.py` | "Medir agora" (v4.3): taxa da WAN lida no MikroTik a cada segundo. |
| `syslog.py` | Syslog do MikroTik (v4.3): recebe por UDP, guarda e traduz o motivo das quedas do PPPoE. |
| *(até a v4.3)* | O coração da coleta. Coletores supervisionados (uma exceção não derruba a thread): ping/TCP/HTTP dos destinos, DNS, IP público, sistema (CPU, RAM, temperatura, disco), MikroTik (REST: recurso, interfaces, DHCP), AdGuard Home, certificados e o **pico da WAN** (`wan_iface`, `wan_peak`). Janela de avaliação por tempo e **abertura/fechamento de incidentes** (offline, perda, latência, jitter, queda local), supressão em cascata pelo "Depende de". Ganchos `INCIDENT_HOOKS` e `NEW_DEVICE_HOOKS` para os outros módulos reagirem. Lê do **coletor Rust** quando ele está ativo e volta a coletar sozinho se ele parar. |
| `checks.py` | Sondas além do ICMP: TCP, HTTP(S) com status esperado, validade de certificado, traceroute, IPv4 × IPv6, descoberta de aparelhos na rede e `ping_many` (vários pings de uma vez, usado pelo bot e pelo diagnóstico). |

**Usa:** núcleo, alertas. **Usado por:** análise, bot, web.

## Mudanças
- **v4.4** — `monitor.py` dividido em 10 módulos por assunto, com `monitor.py` como fachada compatível.
- **v4.3** — `medir.py` (Medir agora), `syslog.py` (log do MikroTik), tráfego das portas em médias de 5 min.
- **v4.0** — saem `snmp.py`, `sites.py` (agentes multi-site) e o speedtest (no Pi 3 ele media a placa de 100 Mbps do Pi, não a internet). No lugar, **pico da WAN**: o maior download/upload da porta de internet do MikroTik no período (PPPoE primeiro, ou a porta escolhida em `wan_iface`). Interfaces do MikroTik: porta parada/desligada só é gravada quando muda de estado ou a cada 10 min (antes, a cada coleta); a primeira limpeza apaga, em lotes, as linhas antigas dessas portas. Coletores sem nada configurado saem da lista de saúde.
- **v3.12** — vira pasta própria. Novo gancho `NEW_DEVICE_HOOKS`: o DHCP do MikroTik avisa quando aparece um MAC nunca visto (a primeira sincronização é só a linha de base). `ping_many` em `checks.py`, com alternativa para `ping` sem a opção `-i`.
- **v3.11** — gancho `INCIDENT_HOOKS` chamado na abertura de cada incidente (alimenta o diagnóstico automático).
- **v3.9** — modo coletor externo: com `NETNOC_EXTERNAL_COLLECTOR` o Python só lê as amostras do Rust e mantém a mesma avaliação; heartbeat, volta automática e saúde `rust:*`.
- **v3.4** — speedtest automático diário; DHCP do MikroTik com aparelhos na rede.
- **v3.3** — coletores supervisionados, janela de avaliação por tempo, queda local como um único alerta, DNS lento só após 3 medições.
- **v2.x** — checks TCP/HTTP, SNMP, multi-site com agentes.

## Melhorias desta versão
- A velocidade do link vem do tráfego real e não gasta banda; o diagnóstico de "internet saturada" compara o tráfego atual com o maior dos últimos 30 dias.
- A tabela de interfaces, a maior do histórico, cresce só com as portas em uso.

## Próximas melhorias
- "Normal por hora da semana" (fase 3): limites aprendidos em vez de fixos.
- Identificar celulares com MAC aleatório para não gerar avisos repetidos.
