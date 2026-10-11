# v2.9 — Correções

1. **Temas em tudo**: Mission Control e Modo TV agora seguem o tema escolhido (Verde, Roxo, OLED, Claro, Personalizado). Novo `theme-sync.css`; `core.js` marca `data-tone` claro/escuro (funciona com tema personalizado). Azul Escuro e Grafana mantêm paleta própria.
2. **Telegram não salvava**: ao trocar o Chat ID com o token mascarado o servidor recusava (400) e a tela mostrava "salva" mesmo assim. Corrigido no backend (main.py) e a tela agora mostra o erro real quando falha.
3. **Nome da aplicação em tudo**: Modo TV (atualiza ao vivo), título da aba, notificação do navegador, mensagens de alerta (Telegram/Discord/e-mail/teste), relatório SLA (tela e CSV), página pública de status, manifesto do PWA (nome do app instalado) e evento "iniciado".

Arquivos: main.py monitor.py notifier.py sla.py static/{index.html,sw.js,util.js,report.js,status.js,theme-sync.css} static/js/{core,layout,settings,live,wall}.js
Depois de copiar: reinicie o serviço e dê Ctrl+F5 (o service worker troca de cache sozinho).
