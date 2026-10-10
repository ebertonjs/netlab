// Helpers de UI compartilhados pelos módulos novos (DOM seguro: textContent, nunca innerHTML com dados).
(function () {
  window.h = function (tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(x => el.append(x instanceof Node ? x : document.createTextNode(String(x))));
    }
    return el;
  };
  window.svgEl = function (tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
    return el;
  };
  window.apiJSON = async function (method, url, body) {
    const opts = {method: method};
    if (body !== undefined) { opts.headers = {'Content-Type': 'application/json'}; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch (e) { /* sem corpo */ }
    if (!r.ok) {
      let msg = j && j.detail;
      if (Array.isArray(msg)) msg = msg.map(x => x.msg).join('; ');
      throw new Error(msg || ('Erro ' + r.status));
    }
    return j;
  };
  window.fmtDur = function (s) {
    if (s == null) return '–';
    s = Math.round(s);
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + hh + 'h';
    if (hh) return hh + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  };
  window.fmtDateTime = function (ts) {
    return new Date(ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
  };
  window.CURRENT_USER = {user: null, role: 'viewer'};
  window.isAdmin = function () { return window.CURRENT_USER.role === 'admin'; };

  // Cria uma página lateral (nav + seção .page) sem tocar no markup existente.
  window.addPage = function (id, label, icon, title, subtitle, onShow) {
    const nav = document.querySelector('.sidebar nav');
    const content = document.querySelector('main.content');
    const page = h('div', {class: 'page', 'data-page': id});
    // as páginas ficam logo depois da última .page existente
    const pages = content.querySelectorAll('.page');
    pages[pages.length - 1].after(page);
    const cfg = nav.querySelector('[data-page="config"]');
    const a = h('a', {href: '#', 'data-page': id}, h('span', {class: 'nav-emoji', 'aria-hidden': 'true', text: icon}), ' ' + label);
    cfg.before(a);
    a.addEventListener('click', e => { e.preventDefault(); window.showPage(id); });
    if (typeof PAGE_TITLES !== 'undefined') PAGE_TITLES[id] = [title, subtitle];
    if (onShow) {
      document.addEventListener('netnoc:page', ev => { if (ev.detail === id) onShow(); });
    }
    try { if (localStorage.getItem('netnoc_page') === id) window.showPage(id); } catch (e) { /* ok */ }
    return page;
  };
  window.card = function (title, body, extraHeader) {
    return h('section', {class: 'panel x-card'},
      h('div', {class: 'panel-header'}, h('span', {text: title}), extraHeader || null), body);
  };
  window.emptyState = function (msg) { return h('div', {class: 'empty-state', text: msg}); };
  window.skeleton = function (n) {
    const box = h('div', {class: 'skeleton-box', 'aria-hidden': 'true'});
    for (let i = 0; i < (n || 3); i++) box.append(h('div', {class: 'skeleton-line'}));
    return box;
  };
})();
