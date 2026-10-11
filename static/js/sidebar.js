// Menu lateral: recolher no desktop (lembra a escolha) e gaveta com botão ☰ no celular.
(function () {
  const side = document.querySelector('.sidebar'), row = document.querySelector('.brand-row'), top = document.querySelector('.topbar');
  if (!side || !row) return;
  const body = document.body, KEY = 'netnoc_sb';
  const ICON_CH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
  const ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* sem storage */ } }

  // dica (tooltip) com o nome da página quando o menu está só com ícones
  function wrap(el) {
    // o texto vira <span class="nav-t"> para poder esconder só ele (ícones emoji ficam)
    Array.prototype.slice.call(el.childNodes).forEach(function (n) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        const sp = document.createElement('span'); sp.className = 'nav-t'; sp.textContent = n.textContent;
        el.replaceChild(sp, n);
      }
    });
  }
  function labels() {
    side.querySelectorAll('nav a').forEach(function (a) {
      if (!a.title) a.title = a.textContent.trim();
      wrap(a);
    });
    const d = side.querySelector('.danger-btn'); if (d) { if (!d.title) d.title = d.textContent.trim(); wrap(d); }
  }
  labels();
  new MutationObserver(labels).observe(side.querySelector('nav'), {childList: true});

  const tg = document.createElement('button');
  tg.type = 'button'; tg.className = 'sb-toggle'; tg.innerHTML = ICON_CH;
  tg.setAttribute('aria-label', 'Recolher menu lateral'); tg.title = 'Recolher / expandir menu';
  row.appendChild(tg);
  function setCollapsed(v, persist) {
    body.classList.toggle('sb-collapsed', v);
    tg.setAttribute('aria-expanded', String(!v));
    if (persist) save(v ? '1' : '0');
    // gráficos e radar se ajustam à nova largura
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 230);
  }
  tg.addEventListener('click', function () { setCollapsed(!body.classList.contains('sb-collapsed'), true); });
  const pref = stored();
  setCollapsed(pref === '1' || (pref === null && window.innerWidth < 1100 && window.innerWidth > 720), false);

  // celular: gaveta
  const bd = document.createElement('div'); bd.className = 'sb-backdrop';
  document.querySelector('.layout').appendChild(bd);
  if (top) {
    const bu = document.createElement('button');
    bu.type = 'button'; bu.className = 'sb-burger'; bu.innerHTML = ICON_MENU; bu.setAttribute('aria-label', 'Abrir menu');
    top.insertBefore(bu, top.firstChild);
    bu.addEventListener('click', function () { body.classList.add('sb-open'); });
  }
  function close() { body.classList.remove('sb-open'); }
  bd.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  side.addEventListener('click', function (e) { if (e.target.closest('nav a')) close(); });
  window.addEventListener('resize', function () { if (window.innerWidth > 720) close(); });
})();
