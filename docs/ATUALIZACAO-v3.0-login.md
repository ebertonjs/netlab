# v3.0 — Tela de login própria

- Novo `/login`: nome do app, tema escolhido (inclui Grafana/personalizado), mostrar senha, aviso de Caps Lock, "Manter conectado 30 dias", mensagem de erro, bloqueio por tentativas (8 falhas/10 min).
- Sessão por cookie assinado (HttpOnly, SameSite=Strict, 12 h; 30 dias se marcar "manter"). Trocar a senha do usuário ou removê-lo derruba a sessão. CSRF mantido.
- Botão ⎋ Sair na barra superior (`/api/logout`). Sessão expirada volta sozinha ao login.
- Basic Auth continua valendo para curl/scripts/Prometheus (`/metrics` Bearer) e agentes.
- Navegadores não mostram mais o popup nativo.

Arquivos: security.py main.py static/{login.html,login.js,util.js,index.html,sw.js} static/js/live.js
Reinicie o serviço e dê Ctrl+F5. Atrás de HTTPS/proxy, envie `X-Forwarded-Proto: https` para o cookie sair com flag Secure.
