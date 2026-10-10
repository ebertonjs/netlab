// Tempo real (SSE), identidade do usuário, indicador "ao vivo" e notificações do navegador.
(function () {
  let es = null, backoff = 1000, seen = null;

  function setLive(on) {
    const el = document.getElementById('liveChip');
    if (!el) return;
    el.className = 'live-chip ' + (on ? 'on' : 'off');
    el.textContent = on ? '● ao vivo' : '⟳ atualizando';
    el.title = on ? 'Atualização em tempo real (SSE) ativa' : 'Sem stream: atualizando a cada 5 s';
  }

  function notify(inc) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = 'NetNOC — ' + inc.severity;
    const opts = {body: inc.message, tag: 'inc-' + inc.id, icon: '/icon-192.png'};
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch (e) { /* ok */ } });
    } else { try { new Notification(title, opts); } catch (e) { /* ok */ } }
  }

  function onSnapshot(s) {
    if (typeof applyOverview === 'function' && s.overview) applyOverview(s.overview);
    const ids = new Set((s.incidents || []).map(i => i.id));
    if (seen === null) seen = ids;                     // primeira carga: só referência
    else (s.incidents || []).forEach(i => {
      if (!seen.has(i.id) && (i.severity === 'Alta' || i.severity === 'Media')) notify(i);
    });
    seen = ids;
    window.__lastSnapshot = s;
    document.dispatchEvent(new CustomEvent('netnoc:snapshot', {detail: s}));
  }

  function connect() {
    if (!window.EventSource) { setLive(false); return; }
    es = new EventSource('/api/stream');
    es.onopen = () => { window.__sseOk = true; backoff = 1000; setLive(true); };
    es.onmessage = ev => { try { onSnapshot(JSON.parse(ev.data)); } catch (e) { /* ignora */ } };
    es.onerror = () => {
      window.__sseOk = false; setLive(false);
      try { es.close(); } catch (e) { /* ok */ }
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000);
    };
  }

  function buildTopbar() {
    const bar = document.querySelector('header.topbar');
    if (!bar || document.getElementById('liveChip')) return;
    const tools = h('div', {class: 'topbar-tools'},
      h('span', {id: 'liveChip', class: 'live-chip off', text: '⟳ atualizando', role: 'status'}),
      h('button', {type: 'button', id: 'bellBtn', class: 'icon-btn', title: 'Ativar notificações do navegador', 'aria-label': 'Ativar notificações', text: '🔔',
        onclick: async () => {
          if (!('Notification' in window)) return showToast('Navegador sem suporte a notificações.', 'error');
          const p = await Notification.requestPermission();
          showToast(p === 'granted' ? 'Notificações ativadas.' : 'Permissão negada.', p === 'granted' ? 'success' : 'error');
        }}),
      h('button', {type: 'button', id: 'tvBtn', class: 'icon-btn', title: 'Modo TV / Wallboard', 'aria-label': 'Modo TV', text: '📺',
        onclick: () => window.NetnocWall && window.NetnocWall.toggle()}),
      h('span', {id: 'userChip', class: 'user-chip', text: ''}));
    const sel = document.getElementById('themeSelect');
    sel.after(tools);
  }

  async function identify() {
    try {
      const me = await apiJSON('GET', '/api/me');
      window.CURRENT_USER = {user: me.user, role: me.role};
      document.body.classList.toggle('role-viewer', me.role !== 'admin');
      const chip = document.getElementById('userChip');
      if (chip) chip.textContent = '👤 ' + me.user + (me.role === 'admin' ? '' : ' (leitura)');
      document.dispatchEvent(new CustomEvent('netnoc:me', {detail: window.CURRENT_USER}));
    } catch (e) { /* sem auth: ignora */ }
  }

  window.addEventListener('load', () => { buildTopbar(); identify(); connect(); });
})();
