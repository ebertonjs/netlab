# NetNOC v2.0 — Bloco 2 (novas ferramentas — backend/API)

Sobrescreva os arquivos (mesmas pastas) por cima do bloco 1 e reinicie.
Novos: checks.py, notifier.py, snmp.py, zabbix.py, sla.py, sites.py, backup.py, agent.py.
Alterados: db.py (tabela snmp_samples), monitor.py, main.py, install.sh.
Dependências do sistema: `sudo apt install snmp traceroute iputils-ping` (o install.sh já faz).
A interface gráfica dessas funções vem no bloco 3; até lá tudo é acessível pela API (autenticada).

## Checks (POST /api/settings/targets)
- ICMP (padrão) · TCP `{"type":"tcp","host":"1.2.3.4","port":22}` ·
  HTTP/HTTPS `{"type":"http","host":"https://site","expect_status":200,"verify_ssl":true}`.
- Certificado HTTPS: verificado a cada 6 h; incidente Média < 14 dias, Alta < 3 dias (GET /api/certs).
- `GET /api/tools/traceroute?host=` · `GET /api/tools/ipcompare?host=` (latência/perda v4 × v6)
- `POST /api/tools/discover {"cidr":"192.168.1.0/24"}` → `GET /api/tools/discover/{job}`
  (ICMP + ARP + DNS reverso; só redes privadas, máx. /22).

## Alertas
- Canais: Telegram (como antes) + Discord + webhook genérico (assinatura `X-NetNOC-Signature: sha256=HMAC`)
  + e-mail SMTP. GET/POST /api/settings/notify · POST /api/settings/notify/test/{telegram|discord|webhook|email}.
- Manutenção: POST /api/maintenance {"name","start","end","targets":[]} (epoch; vazio = todos).
  Em manutenção o incidente é registrado mas não notifica.
- Alvo filho não alerta quando o pai está offline (evento "alerta suprimido").

## SNMP / Zabbix
- POST /api/settings/snmp (lista de dispositivos v1/v2c/v3 + OIDs customizados com unidade, escala, min/max).
  Coleta uptime, estado e tráfego (bps) das interfaces e os OIDs customizados (ex.: potência óptica de OLT).
  POST /api/snmp/test/{nome}, POST /api/snmp/walk, GET /api/snmp/latest, GET /api/snmp/history.
  Credenciais cifradas e passadas à CLI por arquivo temporário 0600.
- Zabbix: POST /api/settings/zabbix {url, token de API, verify_ssl, min_severity}; GET /api/zabbix/problems.

## SLA / relatórios
- GET /api/sla?days=30 ou ?month=AAAA-MM · GET /api/sla.csv (UTF-8 com BOM, separador `;`, protegido contra injeção de fórmula).
  Disponibilidade, latência, quedas, tempo fora, MTTR e MTBF por alvo.

## Multi-site
1. POST /api/settings/agent-token → token (mostrado uma vez).
2. Em cada alvo, campo `"sites":["filial-a"]`.
3. No site remoto: `python3 agent.py --url https://noc:8000 --site filial-a --token TOKEN`
4. GET /api/sites mostra, por alvo, a visão central × sites e o diagnóstico
   ("problema no alvo" × "problema na conexão do central" × "caminho do site"). Agente mudo >3 min gera incidente.

## Backup / Prometheus
- GET /api/backup (JSON sem nenhum segredo) · POST /api/restore (valida tudo antes de gravar;
  segredos atuais são mantidos só se o destino não mudou).
- GET /metrics (Basic ou `Authorization: Bearer <token>` de POST /api/settings/metrics-token).
