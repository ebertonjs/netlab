// Topologia em árvore hierárquica: níveis por "pai", impacto das quedas, painel de detalhe, busca e ramos recolhíveis.
// O grafo livre antigo continua na aba "Grafo livre".
(function () {
  const page = document.querySelector('.page[data-page="topologia"]');
  const oldWrap = page && page.querySelector('.topo-wrap');
  if (!page || !oldWrap) return;

  const CW = 204, CH = 84, GX = 76, GY = 16, PADX = 24, PADY = 40;
  const LEVELS = ['INTERNET', 'BORDA', 'DISTRIBUIÇÃO', 'DESTINOS'];
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const KEY_TAB = 'netnoc_topo_tab', KEY_COL = 'netnoc_topo_collapsed';
  let T = {nodes: [], edges: []}, D = {}, collapsed = {}, selected = 'internet', query = '', scale = 1, structSig = '', els = {}, fitted = false;
  const last = {};
  let root, scroll, stage, inner, svgL, side, chips, searchEl, tabs = {};

  function active() { return page.classList.contains('active'); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem storage */ } }
  function every(key, ms, fn) {
    if (Date.now() - (last[key] || 0) < ms) return Promise.resolve();
    last[key] = Date.now();
    return Promise.resolve().then(fn).catch(function () { /* fonte indisponível */ });
  }
  function snap() { return window.__lastSnapshot || {}; }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }

  // ------------------------------------------------------------------ dados
  function refresh(force) {
    if (force) Object.keys(last).forEach(function (k) { last[k] = 0; });
    return Promise.all([
      every('topo', 15000, async function () { T = await apiJSON('GET', '/api/topology'); }),
      every('spark', 10000, async function () { D.spark = await apiJSON('GET', '/api/sparklines'); }),
      every('targets', 30000, async function () { D.targets = await apiJSON('GET', '/api/targets'); }),
      every('res', 30000, async function () { D.res = await apiJSON('GET', '/api/incidents?days=1'); }),
      every('mk', 8000, async function () {
        const st = await apiJSON('GET', '/api/mikrotik/status');
        D.ifaces = st && st.enabled ? await apiJSON('GET', '/api/mikrotik/interfaces') : null;
      }),
      every('hist', 60000, async function () { D.hist = await apiJSON('GET', '/api/ping/history?range=24h'); })
    ]);
  }

  // ----------------------------------------------------------------- modelo
  function iconFor(n) {
    if (n.type === 'internet') return '🌐';
    const s = String(n.label || '').toLowerCase();
    const map = [[/olt/, '🧩'], [/dwdm|padtec|mux|transponder/, '🔆'], [/mikrotik|router|rb\d|hap|ccr|roteador/, '📡'],
      [/switch|sw[-_ ]?\d|\bsw\b|olt-sw/, '🔀'], [/gateway|\bgw\b|gtw/, '🛰️'], [/link|backup|opera|transit|ix\b|cdn/, '🔗'],
      [/filial|site|pop|matriz|escrit|loja|unidade/, '🏢'], [/dns|google|cloudflare|quad9|8\.8\.8\.8|1\.1\.1\.1/, '🔎'],
      [/ap[-_ ]|radio|ubiquiti|airmax|wifi|wi-fi|antena/, '📶'], [/server|servidor|srv|nas|vm|pi\b|raspberry/, '🖥️'], [/cam|dvr|nvr/, '📷']];
    for (let i = 0; i < map.length; i++) if (map[i][0].test(s)) return map[i][1];
    return '🔹';
  }
  function model() {
    const s = snap(), o = s.overview || {}, ts = o.targets || {};
    const incs = (s.incidents || []).filter(function (i) { return i.severity !== 'Info'; });
    const nodes = T.nodes || [], by = {}, kids = {}, par = {};
    nodes.forEach(function (n) { by[n.id] = n; kids[n.id] = []; });
    (T.edges || []).forEach(function (e) {
      if (by[e.source] && by[e.target] && par[e.target] == null && e.target !== 'internet') { par[e.target] = e.source; kids[e.source].push(e.target); }
    });
    nodes.forEach(function (n) { if (n.id !== 'internet' && par[n.id] == null && by.internet) { par[n.id] = 'internet'; kids.internet.push(n.id); } });
    Object.keys(kids).forEach(function (k) { kids[k].sort(function (a, b) { return String(by[a].label).localeCompare(String(by[b].label)); }); });
    const st = {};
    nodes.forEach(function (n) {
      if (n.id === 'internet') { st[n.id] = o.internet_online === false ? 'bad' : o.internet_online == null ? 'na' : 'ok'; return; }
      const t = ts[n.id] || {}, on = t.online != null ? t.online : n.online;
      if (on == null) st[n.id] = 'na';
      else if (on === false) st[n.id] = 'bad';
      else st[n.id] = ((t.loss_pct || 0) >= 5 || incs.some(function (i) { return i.target === n.id; })) ? 'warn' : 'ok';
    });
    // isolado = offline com um ancestral (não-internet) também offline; a causa é o ancestral mais próximo da raiz
    const iso = {};
    nodes.forEach(function (n) {
      if (st[n.id] !== 'bad' || n.id === 'internet') return;
      let c = par[n.id], cause = null;
      while (c && c !== 'internet') { if (st[c] === 'bad') cause = c; c = par[c]; }
      if (cause) { iso[n.id] = cause; }
    });
    Object.keys(iso).forEach(function (id) { st[id] = 'iso'; });
    function desc(id, acc) { (kids[id] || []).forEach(function (k) { acc.push(k); desc(k, acc); }); return acc; }
    return {o: o, ts: ts, incs: incs, nodes: nodes, by: by, kids: kids, par: par, st: st, iso: iso, desc: desc};
  }

  // visibilidade (ramos recolhidos) e posições
  function layoutTree(m) {
    const pos = {}, depthOf = {};
    let slot = 0, maxDepth = 0;
    function walk(id, d) {
      depthOf[id] = d; maxDepth = Math.max(maxDepth, d);
      const ks = collapsed[id] ? [] : (m.kids[id] || []);
      if (!ks.length) { pos[id] = {slot: slot++}; return; }
      ks.forEach(function (k) { walk(k, d + 1); });
      const a = pos[ks[0]].slot, b = pos[ks[ks.length - 1]].slot;
      pos[id] = {slot: (a + b) / 2};
    }
    if (m.by.internet) walk('internet', 0);
    Object.keys(pos).forEach(function (id) { pos[id].x = PADX + depthOf[id] * (CW + GX); pos[id].y = PADY + pos[id].slot * (CH + GY); pos[id].d = depthOf[id]; });
    return {pos: pos, depth: maxDepth, slots: Math.max(slot, 1)};
  }

  // ------------------------------------------------------------------ build
  function build() {
    page.insertBefore(h('div', {class: 'tt-tabs'},
      tabs.tree = h('button', {type: 'button', class: 'tt-tab', onclick: function () { setTab('tree'); }, text: 'Hierarquia'}),
      tabs.graph = h('button', {type: 'button', class: 'tt-tab', onclick: function () { setTab('graph'); }, text: 'Grafo livre'})), oldWrap);
    chips = h('div', {class: 'tt-chips'});
    searchEl = h('input', {type: 'search', class: 'tt-search', placeholder: 'Buscar equipamento…', 'aria-label': 'Buscar equipamento'});
    searchEl.addEventListener('input', function () { query = searchEl.value.trim().toLowerCase(); applyFilter(); });
    searchEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') focusFirstMatch(); });
    const zoom = h('div', {class: 'tt-zoom'},
      h('button', {type: 'button', title: 'Diminuir zoom', 'aria-label': 'Diminuir zoom', onclick: function () { setScale(scale - 0.1); }, text: '−'}),
      h('button', {type: 'button', title: 'Aumentar zoom', 'aria-label': 'Aumentar zoom', onclick: function () { setScale(scale + 0.1); }, text: '+'}),
      h('button', {type: 'button', title: 'Ajustar à tela', 'aria-label': 'Ajustar à tela', onclick: function () { fit(); }, text: '⤢'}),
      h('button', {type: 'button', title: 'Expandir todos os ramos', 'aria-label': 'Expandir todos', onclick: function () { collapsed = {}; saveCollapsed(); structSig = ''; render(); }, text: '⊞'}));
    svgL = svgEl('svg', {class: 'tt-links', 'aria-hidden': 'true'});
    inner = h('div', {class: 'tt-inner'}, svgL);
    stage = h('div', {class: 'tt-stage'}, inner);
    scroll = h('div', {class: 'tt-scroll'}, stage);
    side = h('aside', {class: 'tt-side'});
    root = h('section', {class: 'tt'},
      h('div', {class: 'tt-bar'}, chips, h('div', {class: 'tt-bar-r'}, searchEl, zoom)),
      h('div', {class: 'tt-main'}, h('div', {class: 'tt-canvas'}, scroll,
        h('div', {class: 'tt-legend'}, h('span', {}, h('i', {class: 'ok'}), 'ok'), h('span', {}, h('i', {class: 'warn'}), 'degradado'), h('span', {}, h('i', {class: 'bad'}), 'offline'),
          h('span', {}, h('i', {class: 'iso'}), 'isolado'), h('span', {class: 'tt-hint', text: 'Link da Internet: espessura = tráfego da WAN'}))), side));
    page.insertBefore(root, oldWrap);
    try { collapsed = JSON.parse(lsGet(KEY_COL) || '{}') || {}; } catch (e) { collapsed = {}; }
    setTab(lsGet(KEY_TAB) === 'graph' ? 'graph' : 'tree');
    document.addEventListener('netnoc:snapshot', function () { if (active() && root.style.display !== 'none') onSnap(); });
    document.addEventListener('netnoc:page', function (ev) { if (ev.detail === 'topologia') onShow(); });
    // quando o grafo antigo recarrega (ex.: após cadastrar destino), a árvore também
    const orig = window.refreshTopologyData;
    if (typeof orig === 'function') {
      window.refreshTopologyData = function () {
        const r = orig.apply(this, arguments);
        last.topo = 0; if (active()) refresh(false).then(render);
        return r;
      };
    }
    window.addEventListener('resize', function () { if (active() && root.style.display !== 'none' && scale === fitScale) fit(); });
  }
  let fitScale = 1;
  function setTab(t) {
    lsSet(KEY_TAB, t);
    tabs.tree.classList.toggle('on', t === 'tree'); tabs.graph.classList.toggle('on', t === 'graph');
    tabs.tree.setAttribute('aria-pressed', String(t === 'tree')); tabs.graph.setAttribute('aria-pressed', String(t === 'graph'));
    root.style.display = t === 'tree' ? '' : 'none';
    oldWrap.style.display = t === 'graph' ? '' : 'none';
    if (t === 'graph') { if (typeof onTopologyPageShown === 'function') onTopologyPageShown(); window.dispatchEvent(new Event('resize')); }
    else if (active()) onShow();
  }
  function onShow() {
    if (root.style.display === 'none') return;
    refresh(true).then(function () { render(); if (!fitted) { fit(); fitted = true; } });
    render();
  }
  function onSnap() { refresh(false).then(render); }

  function saveCollapsed() { lsSet(KEY_COL, JSON.stringify(collapsed)); }

  // ----------------------------------------------------------------- render
  const TXT = {ok: 'ONLINE', warn: 'DEGRADADO', bad: 'OFFLINE', iso: 'ISOLADO', na: 'SEM DADOS'};
  function nodeVal(n, m) {
    const s = m.st[n.id];
    if (n.id === 'internet') { const l = m.o.avg_latency; return s === 'bad' ? 'OFFLINE' : l != null ? Math.round(l) + ' ms' : '—'; }
    const t = m.ts[n.id] || {};
    if (s === 'bad') return 'OFFLINE';
    if (s === 'iso' || s === 'na') return '—';
    return t.latency != null ? Math.round(t.latency) + ' ms' : 'OK';
  }
  function sparkOf(id) {
    if (id !== 'internet') return (D.spark && D.spark[id]) || [];
    const arrs = Object.keys(D.spark || {}).map(function (k) { return D.spark[k]; }).filter(function (a) { return a && a.length > 1; });
    if (!arrs.length) return [];
    const L = Math.min.apply(null, arrs.map(function (a) { return a.length; }));
    const out = []; for (let i = 0; i < L; i++) out.push(arrs.reduce(function (a, b) { return a + (b[b.length - L + i] || 0); }, 0) / arrs.length);
    return out;
  }
  function spark(vals) {
    const s = svgEl('svg', {viewBox: '0 0 70 24', preserveAspectRatio: 'none', 'aria-hidden': 'true'});
    const nums = (vals || []).map(function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; });
    if (nums.length > 1) {
      const mx = Math.max.apply(null, nums.concat([1])), step = 70 / (nums.length - 1);
      s.appendChild(svgEl('polyline', {points: nums.map(function (v, i) { return (i * step).toFixed(1) + ',' + (21 - v / mx * 17).toFixed(1); }).join(' '), fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'}));
    }
    return s;
  }
  function wanBps() {
    const order = (typeof MK_PORT_ORDER !== 'undefined' && MK_PORT_ORDER[0]) || 'ether1';
    const r = (D.ifaces || []).filter(function (x) { return x.name === order; })[0];
    return r ? (r.rx_bps || 0) + (r.tx_bps || 0) : null;
  }
  function linkWidth(srcId) {
    if (srcId !== 'internet') return 2;
    const b = wanBps();
    if (b == null || b <= 0) return 3;
    return Math.max(2, Math.min(9, 2 + Math.log10(b / 1e5 + 1) * 1.8));
  }

  function render() {
    if (!active() || root.style.display === 'none') return;
    const m = model();
    if (!m.by.internet || m.nodes.length < 2) {
      structSig = '';
      stage.style.width = ''; stage.style.height = '';
      inner.replaceChildren(h('div', {class: 'tt-empty', text: 'Nenhum destino cadastrado ainda. Adicione destinos em Configurações → Rede.'}));
      chips.replaceChildren(); side.replaceChildren(); return;
    }
    const L = layoutTree(m);
    const sig = m.nodes.map(function (n) { return n.id + ':' + m.st[n.id] + ':' + (m.iso[n.id] || '') + ':' + (collapsed[n.id] ? 1 : 0) + ':' + (m.par[n.id] || ''); }).join('|') + '#' + Math.round(linkWidth('internet') * 2);
    if (sig !== structSig) { structSig = sig; buildNodes(m, L); }
    updateValues(m);
    renderChips(m);
    renderSide(m);
    applyFilter();
  }

  function buildNodes(m, L) {
    els = {};
    const w = PADX * 2 + (L.depth + 1) * CW + L.depth * GX, hgt = PADY + L.slots * (CH + GY) + 10;
    inner.style.width = w + 'px'; inner.style.height = hgt + 'px';
    svgL.setAttribute('width', w); svgL.setAttribute('height', hgt); svgL.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt);
    const frag = [svgL];
    for (let d = 0; d <= L.depth; d++) {
      frag.push(h('div', {class: 'tt-lv', style: {left: (PADX + d * (CW + GX)) + 'px'}, text: d < LEVELS.length ? LEVELS[d] : 'NÍVEL ' + (d + 1)}));
    }
    svgL.replaceChildren();
    const ids = Object.keys(L.pos);
    ids.forEach(function (id) {
      const kids = collapsed[id] ? [] : (m.kids[id] || []);
      kids.forEach(function (k) {
        const a = L.pos[id], b = L.pos[k], x1 = a.x + CW, y1 = a.y + CH / 2, x2 = b.x, y2 = b.y + CH / 2, mx = (x1 + x2) / 2;
        const sk = m.st[k], cls = sk === 'iso' ? 'iso' : sk;
        const d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
        const p = svgEl('path', {d: d, class: 'tt-l ' + cls, 'data-from': id, 'data-to': k, 'stroke-width': linkWidth(id)});
        svgL.appendChild(p);
        if ((sk === 'ok' || sk === 'warn') && !reduced) {
          const c = svgEl('circle', {r: 3.5, class: 'tt-dot ' + cls});
          c.appendChild(svgEl('animateMotion', {dur: '3.2s', repeatCount: 'indefinite', path: d}));
          svgL.appendChild(c);
        }
        if (sk === 'iso') {
          // ✂ marca o ponto onde a conexão foi perdida
        }
      });
    });
    ids.forEach(function (id) {
      const n = m.by[id], p = L.pos[id], s = m.st[id], all = m.desc(id, []);
      const hasKids = (m.kids[id] || []).length > 0;
      const e = {};
      e.val = h('b', {}); e.ip = h('div', {class: 'tt-ip'}); e.sp = h('div', {class: 'tt-sp'});
      const card = h('div', {class: 'tt-n ' + s + (id === selected ? ' sel' : ''), tabindex: '0', role: 'button', 'data-id': id, style: {left: p.x + 'px', top: p.y + 'px'},
        'aria-label': n.label + ' — ' + TXT[s]},
        s === 'bad' ? h('span', {class: 'tt-tag'}, 'OFFLINE') : null,
        s === 'iso' ? h('span', {class: 'tt-tag i', text: 'ISOLADO POR ' + String(m.iso[id] || '').toUpperCase()}) : null,
        h('div', {class: 'tt-t'}, h('i', {text: iconFor(n)}), h('span', {text: n.label})),
        e.ip, h('div', {class: 'tt-m'}, e.val, e.sp),
        hasKids ? h('button', {type: 'button', class: 'tt-tog', title: collapsed[id] ? 'Expandir ramo' : 'Recolher ramo', 'aria-label': collapsed[id] ? 'Expandir ramo' : 'Recolher ramo',
          text: collapsed[id] ? String(all.length) : '−',
          onclick: function (ev) { ev.stopPropagation(); collapsed[id] = !collapsed[id]; if (!collapsed[id]) delete collapsed[id]; saveCollapsed(); structSig = ''; render(); }}) : null);
      card.addEventListener('click', function () { select(id); });
      card.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(id); } });
      e.card = card; els[id] = e;
      frag.push(card);
    });
    inner.replaceChildren.apply(inner, frag);
    sizeStage();
  }
  function updateValues(m) {
    Object.keys(els).forEach(function (id) {
      const n = m.by[id], e = els[id]; if (!n || !e) return;
      e.val.textContent = nodeVal(n, m);
      e.ip.textContent = id === 'internet' ? (m.o.public_ip || '') : (n.host || '');
      const sv = spark(sparkOf(id)); e.sp.replaceChildren(sv);
    });
  }
  function renderChips(m) {
    const ids = m.nodes.filter(function (n) { return n.id !== 'internet'; }).map(function (n) { return n.id; });
    const c = {bad: 0, iso: 0, warn: 0};
    ids.forEach(function (i) { if (c[m.st[i]] != null) c[m.st[i]]++; });
    const list = [h('span', {class: 'tt-chip', text: ids.length + ' EQUIPAMENTOS'})];
    if (c.bad || c.iso) list.push(h('span', {class: 'tt-chip r', text: (c.bad ? c.bad + ' OFFLINE' : '') + (c.bad && c.iso ? ' · ' : '') + (c.iso ? c.iso + ' ISOLADO' + (c.iso > 1 ? 'S' : '') : '')}));
    if (c.warn) list.push(h('span', {class: 'tt-chip a', text: c.warn + ' DEGRADADO' + (c.warn > 1 ? 'S' : '')}));
    if (!c.bad && !c.iso && !c.warn) list.push(h('span', {class: 'tt-chip g', text: 'TUDO OPERACIONAL'}));
    chips.replaceChildren.apply(chips, list);
  }

  // ----------------------------------------------------------- painel lateral
  function select(id) {
    selected = id;
    Object.keys(els).forEach(function (k) { els[k].card.classList.toggle('sel', k === id); });
    renderSide(model());
    side.scrollIntoView && window.innerWidth <= 900 && side.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }
  function kv(label, val, cls) { return h('div', {class: 'tt-kv'}, h('span', {text: label}), h('b', {class: cls || '', text: val})); }
  function renderSide(m) {
    const n = m.by[selected] || m.by.internet; if (!n) { side.replaceChildren(); return; }
    const id = n.id, s = m.st[id], t = m.ts[id] || {};
    const upT = (D.targets || []).filter(function (x) { return x.name === id; })[0];
    const open = m.incs.filter(function (i) { return i.target === id; }).sort(function (a, b) { return a.started_ts - b.started_ts; });
    const resolved = (D.res || []).filter(function (i) { return i.target === id && i.resolved_ts; }).slice(0, 3);
    const parent = m.par[id], desc = m.desc(id, []);
    const offDesc = desc.filter(function (k) { return m.st[k] === 'bad' || m.st[k] === 'iso'; });
    const sec = open.length ? Date.now() / 1000 - open[0].started_ts : null;
    const body = [
      h('h2', {text: n.label}),
      h('div', {class: 'tt-sub', text: (id === 'internet' ? (m.o.public_ip || '—') : (n.host || '—')) + (parent ? ' · pai: ' + (m.by[parent] ? m.by[parent].label : parent) : '')}),
      h('div', {class: 'tt-kvs'},
        kv('Status', TXT[s], 'st-' + s),
        kv('Há', sec != null ? fmtDur(sec) : '—'),
        kv('Latência', id === 'internet' ? (m.o.avg_latency != null ? m.o.avg_latency.toFixed(1) + ' ms' : '—') : (t.latency != null ? t.latency.toFixed(1) + ' ms' : '—')),
        kv('Perda', id === 'internet' ? (m.o.avg_loss_pct != null ? m.o.avg_loss_pct.toFixed(1) + '%' : '—') : (t.loss_pct != null ? t.loss_pct.toFixed(0) + '%' : '—')),
        kv('Uptime 24 h', upT && typeof upT.uptime_24h === 'number' ? upT.uptime_24h.toFixed(1) + '%' : '—'),
        kv('Impacto', desc.length ? desc.length + (desc.length > 1 ? ' filhos' : ' filho') : 'sem filhos', offDesc.length ? 'st-warn' : ''))
    ];
    if (s === 'iso') body.push(h('div', {class: 'tt-lab', text: 'IMPACTO'}), h('div', {class: 'tt-p', text: 'Fora do ar por causa de ' + (m.by[m.iso[id]] ? m.by[m.iso[id]].label : m.iso[id]) + ' (equipamento acima na hierarquia). Não é falha própria.'}));
    else if (s === 'bad' && desc.length) body.push(h('div', {class: 'tt-lab', text: 'IMPACTO'}), h('div', {class: 'tt-p', text: desc.length + ' equipamento' + (desc.length > 1 ? 's' : '') + ' abaixo dele ' + (offDesc.length ? 'ficou isolado: ' + offDesc.map(function (k) { return m.by[k].label; }).join(', ') : 'depende dele') + '.'}));
    if (desc.length) body.push(h('div', {class: 'tt-lab', text: 'ABAIXO DESTE NÓ'}), h('div', {class: 'tt-chlist'}, (m.kids[id] || []).map(function (k) {
      return h('button', {type: 'button', class: 'tt-pill ' + m.st[k], onclick: function () { revealAndSelect(k); }, text: m.by[k].label});
    })));
    body.push(h('div', {class: 'tt-lab', text: 'INCIDENTES'}));
    if (!open.length && !resolved.length) body.push(h('div', {class: 'tt-p tt-mut', text: 'Nenhum incidente nas últimas 24 h.'}));
    open.forEach(function (i) { body.push(h('div', {class: 'tt-inc'}, h('i', {class: 'r'}), h('div', {}, h('b', {text: i.message}), h('span', {text: i.severity + ' · desde ' + hhmm(i.started_ts)})))); });
    resolved.forEach(function (i) { body.push(h('div', {class: 'tt-inc'}, h('i', {class: 'g'}), h('div', {}, h('b', {text: i.message}), h('span', {text: 'resolvido ' + hhmm(i.resolved_ts) + ' · ' + fmtDur(i.resolved_ts - i.started_ts)})))); });
    const pts = id === 'internet' ? null : ((D.hist && D.hist[id]) || []).map(function (p) { return p.latency; }).filter(function (v) { return typeof v === 'number'; });
    if (pts && pts.length > 1) {
      const step = Math.max(1, Math.floor(pts.length / 140)), v = pts.filter(function (_, i) { return i % step === 0; });
      const mx = Math.max.apply(null, v.concat([1])), sv = svgEl('svg', {viewBox: '0 0 280 56', preserveAspectRatio: 'none', class: 'tt-chart', 'aria-hidden': 'true'});
      sv.appendChild(svgEl('polyline', {points: v.map(function (y, i) { return (i * 280 / (v.length - 1)).toFixed(1) + ',' + (52 - y / mx * 46).toFixed(1); }).join(' '), fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'}));
      body.push(h('div', {class: 'tt-lab', text: 'LATÊNCIA 24 H · máx ' + mx.toFixed(0) + ' ms'}), sv);
    }
    side.replaceChildren.apply(side, body);
  }
  function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); }

  // ------------------------------------------------------------ busca / zoom
  function revealAndSelect(id) {
    const m = model(); let c = m.par[id], ch = false;
    while (c) { if (collapsed[c]) { delete collapsed[c]; ch = true; } c = m.par[c]; }
    if (ch) { saveCollapsed(); structSig = ''; render(); }
    select(id);
    const e = els[id]; if (e) e.card.scrollIntoView({block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth'});
  }
  function matches(n) { return !query || String(n.label).toLowerCase().indexOf(query) >= 0 || String(n.host || '').toLowerCase().indexOf(query) >= 0; }
  function applyFilter() {
    const m = model(); let first = null, cnt = 0;
    Object.keys(els).forEach(function (id) {
      const hit = matches(m.by[id] || {});
      els[id].card.classList.toggle('dim', !!query && !hit);
      els[id].card.classList.toggle('hit', !!query && hit);
      if (hit && !first) first = id; if (hit) cnt++;
    });
    searchEl.classList.toggle('none', !!query && !cnt);
  }
  function focusFirstMatch() {
    if (!query) return;
    const m = model(), hit = m.nodes.filter(matches)[0];
    if (hit) revealAndSelect(hit.id);
  }
  function sizeStage() {
    stage.style.width = (inner.offsetWidth * scale) + 'px'; stage.style.height = (inner.offsetHeight * scale) + 'px';
    inner.style.transform = 'scale(' + scale + ')';
  }
  function setScale(v) { scale = Math.max(0.4, Math.min(1.6, Math.round(v * 100) / 100)); sizeStage(); }
  function fit() {
    const w = inner.offsetWidth; if (!w) return;
    const aw = scroll.clientWidth - 4;
    fitScale = Math.max(aw < 700 ? 0.75 : 0.5, Math.min(1, aw / w));
    setScale(fitScale);
    const r = els.internet ? els.internet.card.offsetTop + CH / 2 : 0;
    scroll.scrollTo(0, Math.max(0, r * scale - scroll.clientHeight / 2));
  }

  build();
})();
