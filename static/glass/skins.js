// NetNOC v4.0 — tema (Pro) e tamanho da interface.
// Carregado no <head>: aplica antes do primeiro paint (a CSP não permite script inline).
// Modo: escuro, claro ou automático (escuro das 18h às 7h: o painel acompanha o plantão).
// Ordem de escolha: URL (?modo=claro) > escolha deste aparelho > padrão do servidor > escuro.
'use strict';
(function () {
  const MODES = [['dark', 'Escuro'], ['light', 'Claro'], ['auto', 'Automático (escuro das 18h às 7h)']];
  const LIST = {pro: {name: 'Pro', modes: MODES}};         // mantido para quem lê SKIN.LIST
  const DEF = {skin: 'pro', mode: 'dark'};
  const root = document.documentElement;

  function ls(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (_) { /* sem storage */ }
    return null;
  }
  function valid(st) {
    st = st || {};
    // temas da v3 (Glass, Terminal, Grafana, Material, Lagoa) viram Pro, mantendo claro/escuro
    let mode = st.mode;
    if (mode === 'claro') mode = 'light';
    if (mode === 'escuro') mode = 'dark';
    if (!MODES.some(m => m[0] === mode)) mode = mode === 'light' ? 'light' : 'dark';
    return {skin: 'pro', mode};
  }
  function fromUrl() {
    const m = new URLSearchParams(location.search).get('modo');
    return m ? {mode: m} : null;
  }
  function current() {
    const u = fromUrl(), dev = ls('netnoc_ui'), srv = ls('netnoc_ui_server');
    return valid(Object.assign({}, dev || srv || DEF, u || {}));
  }
  const isNight = () => { const hr = new Date().getHours(); return hr >= 18 || hr < 7; };

  function apply(st, el) {
    el = el || root;
    st = valid(st);
    const dark = st.mode === 'auto' ? isNight() : st.mode === 'dark';
    el.setAttribute('data-skin', 'pro');
    el.setAttribute('data-theme', dark ? 'dark' : 'light');
    el.setAttribute('data-mode', st.mode);
    if (el === root) {
      const m = document.querySelector('meta[name="theme-color"]');
      if (m) m.content = dark ? '#0b1120' : '#f4f6fa';
    }
    return st;
  }
  let state = apply(current());
  // modo automático: confere a cada 5 min se virou dia/noite
  setInterval(() => {
    if (state.mode !== 'auto') return;
    const before = root.getAttribute('data-theme');
    apply(state);
    if (root.getAttribute('data-theme') !== before) document.dispatchEvent(new CustomEvent('nn:skin', {detail: state}));
  }, 300000);

  // ------------------------------------------------------------- tamanho da interface (vale por aparelho)
  const DENS = {normal: ['Normal', 1], compacta: ['Compacta', .86], minima: ['Mínima', .76]};
  function density(d) {
    if (d === undefined) {
      const u = new URLSearchParams(location.search).get('densidade');
      if (DENS[u]) return u;
      const v = ls('netnoc_density');
      return DENS[v] ? v : 'compacta';
    }
    if (DENS[d]) ls('netnoc_density', d);
    applyDensity();
    return density();
  }
  function applyDensity() {
    const d = density();
    root.setAttribute('data-density', d);
    root.style.setProperty('--zoom', String(DENS[d][1]));
  }
  applyDensity();

  function set(st, opts) {
    opts = opts || {};
    state = apply(Object.assign({}, state, st));
    if (opts.save !== false) ls('netnoc_ui', state);
    document.dispatchEvent(new CustomEvent('nn:skin', {detail: state}));
    return state;
  }
  function followServer() {        // esquece a escolha deste aparelho
    ls('netnoc_ui', null);
    state = apply(current());
    document.dispatchEvent(new CustomEvent('nn:skin', {detail: state}));
  }
  async function syncServer() {
    try {
      const r = await fetch('/api/settings/ui', {credentials: 'same-origin'});
      if (!r.ok) return;
      const d = valid(await r.json());
      const old = ls('netnoc_ui_server');
      ls('netnoc_ui_server', d);
      if (!ls('netnoc_ui') && !fromUrl() && JSON.stringify(old) !== JSON.stringify(d)) {
        state = apply(d);
        document.dispatchEvent(new CustomEvent('nn:skin', {detail: state}));
      }
    } catch (_) { /* sem rede: segue com o cache */ }
  }

  // ------------------------------------------------------------- cores lidas do tema (gráficos, SVG)
  function col(name, el) {
    const v = getComputedStyle(el || root).getPropertyValue(name).trim();
    if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map(c => c + c).join('');
    return v || '#888888';
  }
  const palette = el => [1, 2, 3, 4, 5, 6, 7, 8].map(i => col('--c' + i, el));

  window.SKIN = {LIST, MODES, get: () => Object.assign({}, state), set, apply, followServer, syncServer, col, palette,
    DENS, density, isDeviceOverride: () => !!ls('netnoc_ui'), serverDefault: () => valid(ls('netnoc_ui_server') || DEF), valid};
})();
