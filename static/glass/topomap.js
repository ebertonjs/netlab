// NetNOC v3.5 — mapa da rede em caixas (estilo mapa de NOC): grupos de destinos ligados por
// linhas com "pacotes" animados. Usado na tela Topologia e na cena 2 do Modo TV.
'use strict';
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const BW = 236, GAPX = 112, GAPY = 26, HEAD = 62, ROW = 25, PADB = 14, MAXROWS = 8, M = 30;
  const ST_ICO = {ok: 'check', warn: 'alert', bad: 'x', iso: 'minus', na: 'minus'};
  const ST_TXT = {ok: 'ok', warn: 'lento / perda', bad: 'fora do ar', iso: 'isolado (o pai caiu)', na: 'sem dados'};

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  }
  function iconFor(g) {
    if (g.kind === 'origin') return 'server';
    if (g.kind === 'internet') return 'cloud';
    if (g.kind === 'cams') return 'video';
    if (g.kind === 'env') return 'thermo';
    const n = (g.label || '').toLowerCase();
    if (/c[aâ]mera|dvr|cftv|nvr/.test(n)) return 'video';
    if (/wi-?fi|wireless|\bap\b|access/.test(n)) return 'wifi';
    if (/gateway|router|roteador|mikrotik|firewall|olt|onu|core/.test(n)) return 'router';
    if (/servidor|server|nas|vps|storage|host/.test(n)) return 'server';
    if (/rede|lan|switch|local/.test(n)) return 'network';
    return g.kind === 'device' ? 'router' : 'layers';
  }
  const ms = v => v == null ? '' : (v >= 100 ? Math.round(v) : (+v).toFixed(1)) + ' ms';

  // ------------------------------------------------------------------ layout em colunas
  function layout(D) {
    const nodes = {__origin: {id: '__origin', label: D.origin.label, sub: D.origin.app, kind: 'origin', items: [], state: 'ok'}};
    for (const g of D.groups) nodes[g.id] = Object.assign({}, g);
    const edges = D.edges.map(e => Object.assign({}, e));
    if (D.cams && D.cams.items.length) {
      nodes.__cams = {id: '__cams', label: 'Câmeras', kind: 'cams', state: D.cams.items.some(i => i.state === 'bad') ? 'warn' : 'ok',
        items: D.cams.items.map(c => ({name: c.name, host: 'canal ' + c.ch, state: c.state, ch: c.ch}))};
      edges.push({from: nodes[D.cams.attach] ? D.cams.attach : '__origin', to: '__cams', state: nodes.__cams.state});
    }
    // camada = maior distância a partir da origem (com proteção contra ciclos)
    const layer = {__origin: 0};
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const e of edges) {
        if (layer[e.from] == null) continue;
        const v = layer[e.from] + 1;
        if (layer[e.to] == null || (layer[e.to] < v && v < 12)) { layer[e.to] = v; changed = true; }
      }
      if (!changed) break;
    }
    for (const id of Object.keys(nodes)) if (layer[id] == null) layer[id] = 1;
    const cols = [];
    for (const id of Object.keys(nodes)) (cols[layer[id]] = cols[layer[id]] || []).push(id);
    const hOf = n => HEAD + Math.min(n.items.length, MAXROWS + (n.items.length > MAXROWS ? 1 : 0)) * ROW + PADB + (n.kind === 'origin' ? -6 : 0);
    // ordem dentro da coluna: pela posição média dos pais (menos cruzamentos)
    const yIdx = {};
    cols.forEach((ids, ci) => {
      if (!ids) return;
      if (ci > 0) {
        const score = id => {
          const ps = edges.filter(e => e.to === id && yIdx[e.from] != null).map(e => yIdx[e.from]);
          return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 99;
        };
        ids.sort((a, b) => score(a) - score(b));
      }
      ids.forEach((id, i) => { yIdx[id] = i; });
    });
    const colH = cols.map(ids => (ids || []).reduce((a, id) => a + hOf(nodes[id]) + GAPY, -GAPY));
    // caixa "Ambiente" fica embaixo da origem, ligada na vertical
    let env = null;
    if (D.env && D.env.length) {
      env = {id: '__env', label: 'Ambiente', kind: 'env', items: D.env.map(e => ({name: e.name, host: e.value + e.unit, state: e.state, env: true})),
        state: D.env.some(e => e.state === 'bad') ? 'bad' : D.env.some(e => e.state === 'warn') ? 'warn' : 'ok'};
      colH[0] += GAPY * 2 + hOf(env);
    }
    const H = Math.max(...colH, 300) + 2 * M;
    const W = cols.length * BW + (cols.length - 1) * GAPX + 2 * M;
    cols.forEach((ids, ci) => {
      if (!ids) return;
      let y = M + (H - 2 * M - colH[ci]) / 2;
      for (const id of ids) {
        const n = nodes[id];
        n.x = M + ci * (BW + GAPX); n.y = y; n.w = BW; n.h = hOf(n);
        y += n.h + GAPY;
      }
      if (ci === 0 && env) {
        env.x = M; env.y = y + GAPY; env.w = BW; env.h = hOf(env);
        nodes.__env = env;
        edges.push({from: '__origin', to: '__env', state: env.state, vertical: true});
      }
    });
    return {nodes, edges, W, H};
  }

  // ------------------------------------------------------------------ desenho
  function render(host, D, opts) {
    opts = opts || {};
    const L = layout(D);
    const wrap = el('div', 'tm-wrap' + (opts.tv ? ' tv' : ''));
    const stage = el('div', 'tm-stage');
    stage.style.width = L.W + 'px'; stage.style.height = L.H + 'px';
    const svg = svgEl('svg', {class: 'tm-links', width: L.W, height: L.H, viewBox: `0 0 ${L.W} ${L.H}`});
    stage.append(svg);
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const e of L.edges) {
      const a = L.nodes[e.from], b = L.nodes[e.to];
      if (!a || !b) continue;
      let d;
      if (e.vertical) {
        const x = a.x + a.w / 2;
        d = `M${x} ${a.y + a.h} L${x} ${b.y}`;
      } else {
        const x1 = a.x + a.w, y1 = a.y + Math.min(a.h / 2, 46), x2 = b.x, y2 = b.y + Math.min(b.h / 2, 46), mx = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
      }
      const st = e.state || 'na';
      svg.append(svgEl('path', {d, class: 'tm-glow ' + st}), svgEl('path', {d, class: 'tm-line ' + st}));
      const pts = e.vertical ? [[a.x + a.w / 2, a.y + a.h], [b.x + b.w / 2, b.y]]
        : [[a.x + a.w, a.y + Math.min(a.h / 2, 46)], [b.x, b.y + Math.min(b.h / 2, 46)]];
      for (const [x, y] of pts) svg.append(svgEl('circle', {cx: x, cy: y, r: 5, class: 'tm-end ' + st}));
      if ((st === 'ok' || st === 'warn') && !reduce) {
        // "pacotes" correndo pela ligação
        for (let k = 0; k < 2; k++) {
          const c = svgEl('circle', {r: 3.2, class: 'tm-pkt ' + st});
          const am = svgEl('animateMotion', {dur: st === 'warn' ? '3.6s' : '2.4s', repeatCount: 'indefinite', path: d, begin: (k * (st === 'warn' ? 1.8 : 1.2)) + 's'});
          c.append(am); svg.append(c);
        }
      }
      if (e.latency != null && !e.vertical) {
        // rótulo junto da chegada (cada caixa tem uma só entrada: não sobrepõe outros rótulos nem a curva)
        const t = svgEl('text', {x: b.x - 12, y: b.y + Math.min(b.h / 2, 46) - 9, class: 'tm-lat', 'text-anchor': 'end'}); t.textContent = ms(e.latency);
        svg.append(t);
      }
    }
    for (const n of Object.values(L.nodes)) {
      const box = el('div', `tm-box ${n.kind || 'group'} st-${n.state || 'na'}`);
      box.style.left = n.x + 'px'; box.style.top = n.y + 'px'; box.style.width = n.w + 'px'; box.style.height = n.h + 'px';
      const head = el('div', 'tm-head');
      const ic = el('span', 'tm-ico'); ic.innerHTML = ICO(iconFor(n));
      const tt = el('div', 'tm-title');
      tt.append(el('b', null, n.label));
      const okN = n.items.filter(i => i.state === 'ok').length;
      tt.append(el('small', null, n.kind === 'origin' ? (n.sub || 'NetNOC') + ' · monitorando'
        : n.kind === 'env' ? 'sensores' : `${okN}/${n.items.length} ok`));
      head.append(ic, tt);
      if (n.kind !== 'origin') head.append(el('i', 'tm-dot ' + (n.state || 'na')));
      box.append(head);
      const rows = n.items.slice(0, MAXROWS);
      for (const it of rows) {
        const r = el('div', 'tm-row ' + it.state);
        r.title = `${it.name} · ${ST_TXT[it.state] || ''}` + (it.latency != null && it.state !== 'bad' ? ` · ${ms(it.latency)}` : '');
        r.append(el('span', 'n', it.name), el('span', 'h', it.env ? it.host : (it.state === 'bad' ? 'fora' : it.host)));
        const s = el('span', 's ' + it.state); s.innerHTML = ICO(ST_ICO[it.state] || 'minus'); r.append(s);
        if (it.ch && opts.onCam) { r.classList.add('click'); r.addEventListener('click', () => opts.onCam(it.ch)); }
        else if (!it.env && n.kind !== 'cams' && opts.onItem) { r.classList.add('click'); r.addEventListener('click', () => opts.onItem(it.name)); }
        box.append(r);
      }
      if (n.items.length > MAXROWS) box.append(el('div', 'tm-more', `+ ${n.items.length - MAXROWS} destinos`));
      stage.append(box);
    }
    wrap.append(stage);
    host.innerHTML = '';
    host.append(wrap);
    // escala para caber no espaço disponível (nunca maior que 1,6x)
    function fit() {
      const cw = wrap.clientWidth, ch = wrap.clientHeight;
      if (!cw || !ch) return;
      const k = Math.min(cw / L.W, ch / L.H, opts.tv ? 2.2 : 1.6);
      stage.style.transform = `translate(${(cw - L.W * k) / 2}px, ${(ch - L.H * k) / 2}px) scale(${k})`;
    }
    const ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(wrap);
    requestAnimationFrame(fit);
    return {destroy() { if (ro) ro.disconnect(); }, fit, size: {w: L.W, h: L.H}};
  }

  // anel "X online" (SVG) — usado no painel lateral
  function ring(sum, size) {
    size = size || 150;
    const tot = Math.max(1, sum.total), r = size / 2 - 12, c = 2 * Math.PI * r;
    const svg = svgEl('svg', {viewBox: `0 0 ${size} ${size}`, class: 'tm-ring', width: size, height: size});
    svg.append(svgEl('circle', {cx: size / 2, cy: size / 2, r, class: 'trk'}));
    let off = 0;
    for (const k of ['ok', 'warn', 'iso', 'bad', 'na']) {
      const v = sum[k] || 0;
      if (!v) continue;
      const len = c * v / tot;
      svg.append(svgEl('circle', {cx: size / 2, cy: size / 2, r, class: 'seg ' + k,
        'stroke-dasharray': `${Math.max(0, len - (v < tot ? 3 : 0))} ${c}`, 'stroke-dashoffset': -off,
        transform: `rotate(-90 ${size / 2} ${size / 2})`}));
      off += len;
    }
    const t1 = svgEl('text', {x: size / 2, y: size / 2 + 4, 'text-anchor': 'middle', class: 'big'}); t1.textContent = String(sum.ok || 0);
    const t2 = svgEl('text', {x: size / 2, y: size / 2 + 24, 'text-anchor': 'middle', class: 'sub'}); t2.textContent = 'online';
    svg.append(t1, t2);
    return svg;
  }

  // assinatura só de estrutura + estados: latência mudando não redesenha (a animação não reinicia)
  function sig(D) {
    return JSON.stringify([D.groups.map(g => [g.id, g.items.map(i => i.name + ':' + i.state)]), D.edges.map(e => e.from + '>' + e.to + ':' + e.state),
      (D.env || []).map(e => e.name + ':' + e.state), D.cams && D.cams.items.map(c => c.state), document.documentElement.dataset.skin]);
  }

  window.NNMap = {render, ring, sig, ST_TXT};
})();
