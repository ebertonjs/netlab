(function () {
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  // tema escolhido no painel (inclusive o personalizado)
  try {
    const t = localStorage.getItem('netnoc_theme') || 'dark-blue';
    root.setAttribute('data-theme', t);
    if (t === 'custom') {
      const c = JSON.parse(localStorage.getItem('netnoc_custom_theme') || 'null');
      if (c) Object.keys(c).forEach(k => root.style.setProperty('--' + k, c[k]));
    }
  } catch (e) { /* ok */ }
  function setName(n) { if (!n) return; $('appName').textContent = n; document.title = 'Entrar — ' + n; }
  try { setName(localStorage.getItem('netnoc_app_name')); } catch (e) { /* ok */ }
  fetch('/api/loginfo').then(r => r.json()).then(d => {
    setName(d.name);
    $('ver').textContent = d.version ? 'v' + d.version : '';
    try { localStorage.setItem('netnoc_app_name', d.name); } catch (e) { /* ok */ }
    if (d.auth === false) location.replace('/');
  }).catch(() => {});
  function next() {
    const n = new URLSearchParams(location.search).get('next') || '/';
    return (n[0] === '/' && n[1] !== '/' && n[1] !== '\\') ? n : '/';
  }
  $('eye').addEventListener('click', () => {
    const p = $('p'), show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('eye').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  });
  $('p').addEventListener('keyup', e => { $('caps').style.display = e.getModifierState && e.getModifierState('CapsLock') ? 'block' : 'none'; });
  $('f').addEventListener('submit', async e => {
    e.preventDefault();
    const user = $('u').value.trim(), password = $('p').value;
    $('err').textContent = '';
    if (!user || !password) { $('err').textContent = 'Informe usuário e senha.'; return; }
    const go = $('go'); go.disabled = true; go.textContent = 'Entrando…';
    try {
      const r = await fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-NetNOC': '1'},
        credentials: 'same-origin', body: JSON.stringify({user, password, remember: $('rem').checked})});
      if (r.ok) { location.replace(next()); return; }
      let msg = 'Não foi possível entrar.';
      try { const j = await r.json(); if (typeof j.detail === 'string') msg = j.detail; } catch (_) { /* ok */ }
      $('err').textContent = msg;
      const card = document.querySelector('.lg'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      $('p').value = ''; $('p').focus();
    } catch (_) {
      $('err').textContent = 'Sem conexão com o servidor.';
    }
    go.disabled = false; go.textContent = 'Entrar';
  });
})();
