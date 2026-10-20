// NetNOC v3.2 — skins (temas que mudam a interface inteira).
// Carregado no <head>: aplica a skin antes do primeiro paint (CSP não permite script inline).
// Ordem de escolha: URL (?skin=terminal&modo=ambar&cor=%23ff7043) > escolha deste aparelho > padrão do servidor > Glass escuro.
'use strict';
(function () {
  const LIST = {
    glass: {name: 'Glass', desc: 'Vidro fosco, cards com imagem e dock flutuante. Feito para tablet na parede.',
      modes: [['dark', 'Escuro'], ['light', 'Claro']], nav: 'dock'},
    terminal: {name: 'NOC Terminal', desc: 'Monoespaçado, fósforo e scanlines. Destinos em tabela, navegação por teclas 1–0.',
      modes: [['verde', 'Fósforo verde'], ['ambar', 'Âmbar'], ['ciano', 'Ciano']], nav: 'bar'},
    grafana: {name: 'Grafana / Zabbix', desc: 'Painéis planos e densos, menu lateral fixo. Mais informação por tela no PC.',
      modes: [['dark', 'Escuro'], ['light', 'Claro']], nav: 'side'},
    material: {name: 'Material You', desc: 'Cores sólidas geradas a partir da sua cor de destaque, cantos grandes e barra inferior.',
      modes: [['light', 'Claro'], ['dark', 'Escuro']], nav: 'bottom', accent: true},
  };
  const ACCENTS = ['#6750a4', '#0b57d0', '#00897b', '#2e7d32', '#f57c00', '#d81b60', '#5d4037', '#455a64'];
  const DEF = {skin: 'glass', mode: 'dark', accent: '#6750a4'};
  const root = document.documentElement;

  function ls(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (_) { /* sem storage */ }
    return null;
  }
  function valid(st) {
    st = Object.assign({}, DEF, st || {});
    if (!LIST[st.skin]) st.skin = DEF.skin;
    const modes = LIST[st.skin].modes.map(m => m[0]);
    if (!modes.includes(st.mode)) st.mode = modes[0];
    if (!/^#[0-9a-f]{6}$/i.test(st.accent || '')) st.accent = DEF.accent;
    return st;
  }
  function fromUrl() {
    const q = new URLSearchParams(location.search), out = {};
    if (q.get('skin')) out.skin = q.get('skin');
    if (q.get('modo')) out.mode = q.get('modo');
    if (q.get('cor')) out.accent = q.get('cor');
    return Object.keys(out).length ? out : null;
  }
  function legacy() {          // v3.0/3.1 guardavam só claro/escuro do glass
    try { const t = localStorage.getItem('netnoc_glass_theme'); return t ? {skin: 'glass', mode: t} : null; } catch (_) { return null; }
  }
  function current() {
    const u = fromUrl();
    const dev = ls('netnoc_ui');
    const srv = ls('netnoc_ui_server');
    if (u) return valid(Object.assign({}, dev || srv || legacy() || {}, u));
    return valid(dev || srv || legacy() || DEF);
  }

  // ------------------------------------------------------------- cor de destaque -> paleta
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let hh = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60;
    }
    return [hh, s * 100, l * 100];
  }
  function hsl(hh, s, l) {
    s /= 100; l /= 100; hh = ((hh % 360) + 360) % 360;
    const k = n => (n + hh / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function materialVars(accent, dark) {
    const [hh, s] = hexToHsl(accent), sat = Math.max(35, Math.min(s, 80));
    const v = {
      '--accent': dark ? hsl(hh, sat, 74) : hsl(hh, sat, 42),
      '--accent-2': dark ? hsl(hh, sat, 84) : hsl(hh, sat, 56),
      '--m-on-accent': dark ? hsl(hh, sat, 18) : '#ffffff',
      '--m-container': dark ? hsl(hh, 32, 26) : hsl(hh, 70, 91),
      '--m-on-container': dark ? hsl(hh, 60, 90) : hsl(hh, 60, 14),
      '--m-bg': dark ? hsl(hh, 10, 8) : hsl(hh, 30, 98),
      '--m-surface': dark ? hsl(hh, 10, 12) : hsl(hh, 26, 95),
      '--m-surface-2': dark ? hsl(hh, 11, 16) : hsl(hh, 24, 92),
      '--m-surface-3': dark ? hsl(hh, 12, 21) : hsl(hh, 22, 88),
      '--m-outline': dark ? hsl(hh, 8, 32) : hsl(hh, 10, 78),
    };
    // paleta dos gráficos: o destaque primeiro, depois matizes espaçadas
    [0, 210, 130, 45, 330, 180, 270, 90].forEach((d, i) => { v['--c' + (i + 1)] = dark ? hsl(hh + d, sat, 68) : hsl(hh + d, sat, 46); });
    return v;
  }

  // ------------------------------------------------------------- aplicar
  function apply(st, el) {
    el = el || root;
    st = valid(st);
    el.setAttribute('data-skin', st.skin);
    const darkish = st.skin === 'terminal' ? true : st.mode === 'dark';
    el.setAttribute('data-theme', darkish ? 'dark' : 'light');
    if (st.skin === 'terminal') el.setAttribute('data-variant', st.mode); else el.removeAttribute('data-variant');
    const mv = materialVars(st.accent, darkish);
    for (const k of Object.keys(mv)) {
      if (st.skin === 'material') el.style.setProperty(k, mv[k]); else el.style.removeProperty(k);
    }
    if (el === root) {
      const m = document.querySelector('meta[name="theme-color"]');
      if (m) m.content = {glass: darkish ? '#1c1b36' : '#c9d6e8', terminal: '#050806', grafana: darkish ? '#111217' : '#f4f5f5', material: mv['--m-bg']}[st.skin];
    }
    return st;
  }
  let state = apply(current());

  // ------------------------------------------------------------- densidade (tamanho da interface; vale por aparelho)
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

  window.SKIN = {LIST, ACCENTS, get: () => Object.assign({}, state), set, apply, followServer, syncServer, col, palette,
    DENS, density,
    isDeviceOverride: () => !!ls('netnoc_ui'), serverDefault: () => valid(ls('netnoc_ui_server') || DEF), valid};
})();
