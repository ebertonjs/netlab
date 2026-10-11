# NetNOC v2.0 — Bloco 1 (segurança, banco, performance)

Copie estes arquivos por cima do projeto (mesmas pastas) e rode `pip install -r requirements.txt`
(entrou `cryptography`). Pare o serviço antes e suba de novo.

Arquivos: db.py, security.py (novo), stats.py (novo), monitor.py, main.py, manage.py (novo),
requirements.txt, .gitignore, static/util.js (novo), static/app.js, static/topology.js, static/index.html.

## O que muda ao subir
- **Login obrigatório** (HTTP Basic). Na 1ª subida aparece no log a senha do usuário `admin`
  (ou defina `NETNOC_ADMIN_PASSWORD`). Trocar: `python manage.py set-password admin`.
  Perfis: `admin` (altera tudo) e `viewer` (só leitura). Criar usuários: POST /api/users.
- Escape hatch: `NETNOC_AUTH=off` desliga o login (não recomendado).
- **Senhas/tokens (Telegram, MikroTik, AdGuard) são cifrados** no banco (Fernet). A chave fica em
  `netnoc.key` (0600) — faça backup dela junto com o banco, ou use `NETNOC_SECRET_KEY`.
  Credenciais antigas em texto puro são recifradas automaticamente.
- **Banco antigo é convertido na 1ª subida** (VACUUM único, pode levar alguns segundos/minutos
  com o WAL de 39 MB): ativa `auto_vacuum` de verdade e os índices novos. Os pings brutos de
  30 dias viram agregados de 5 min/1 h em segundo plano; bruto fica 7 dias.
- Proteções: CSRF (cabeçalho X-NetNOC + origem), CSP/X-Frame-Options, rate limit de login
  (8 falhas/10 min), validação de host/nome (bloqueia injeção de argumento no ping e HTML),
  bloqueio de exfiltração de credencial (trocar host sem reenviar a senha é recusado),
  escape de HTML em toda a interface, /docs e /openapi.json desativados, log de auditoria
  (GET /api/audit).

## Performance
- Ping concorrente (16 threads): 30 alvos com 0,2 s cada = 0,4 s por ciclo (sequencial: 6 s).
- Um commit por ciclo; leitura em conexões separadas (WAL); janela deslizante em memória
  (sem query por ping); N+1 eliminado em /api/targets, /api/overview, barras de uptime.
- Gráficos 24h/7d/30d usam tabelas agregadas (≤ ~720 pontos por série); cache de 2 s no overview;
  SSE em /api/stream; checkpoint do WAL + incremental_vacuum (corrigido) no prune.
- Alertas: histerese (3 falhas abrem, 2 sucessos fecham), supressão de filhos quando o pai cai,
  incidentes abertos são recarregados após reinício (antes duplicavam).
