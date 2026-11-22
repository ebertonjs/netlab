// NetNOC — tela: Topologia
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== TOPOLOGIA
  function layoutTree(nodes, edges) {
    const kids = {};
    for (const e of edges) (kids[e.source] = kids[e.source] || []).push(e.target);
    const pos = {}; let leaf = 0; let maxDepth = 0;
    (function walk(id, d, seen) {
      if (seen.has(id)) return; seen.add(id);
      maxDepth = Math.max(maxDepth, d);
      const ch = kids[id] || [];
      if (!ch.length) { pos[id] = {x: leaf++, y: d}; return; }
      ch.forEach(c => walk(c, d + 1, seen));
      const xs = ch.map(c => pos[c] && pos[c].x).filter(v => v != null);
      pos[id] = {x: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : leaf++, y: d};
    })('internet', 0, new Set());
    return {pos, leaves: Math.max(1, leaf), depth: maxDepth};
  }
  registerSheet('topology', {
    title: 'Topologia', icon: 'network',
    async render(ctx) {
      const view = ctx.params.view === 'arvore' ? 'arvore' : 'mapa';
      ctx.tools.append(seg([['mapa', 'Mapa'], ['arvore', 'Árvore']], view, v => ctx.reopen({view: v})));
      if (view === 'mapa') return renderMap(ctx);
      const [L, R] = panels(ctx);
      const topo = await api('/api/topology');
      if (!ctx.alive) return;
      const cfg = await api('/api/settings');
      const gw = gatewayOf(cfg.targets.map(t => Object.assign({}, t)));
      const orphans = gw ? cfg.targets.filter(t => t.name !== gw.name && !t.parent && !isLocal(t)) : [];
      L.append(h('div', {class: 'bigstat'}, h('span', {class: 'l', text: 'Destinos'}), h('span', {class: 'v', text: String(cfg.targets.length)})));
      if (gw && orphans.length) {
        L.append(h('div', {class: 'callout'}, h('b', {text: `${orphans.length} destino(s) de internet sem pai`}),
          `Se "${gw.name}" cair, cada um gera um alerta "offline" separado. Ligando-os ao ${gw.name}, só a causa raiz alerta.`,
          h('div', {style: {marginTop: '10px'}}, tbtn('Ligar ao ' + gw.name, 'link', async () => {
            if (needAdmin()) return;
            for (const t of orphans) {
              await act(() => post('/api/settings/targets/' + encodeURIComponent(t.name) + '/update', {parent: gw.name, set_parent: true}));
            }
            toast('Topologia atualizada'); NN.loadTargets(); ctx.reopen();
          }, 'primary'))));
      } else {
        L.append(h('div', {class: 'callout blue', text: 'Defina "Depende de" em cada destino para suprimir alertas em cascata (abra um card → Depende de).'}));
      }
      const l = h('div', {class: 'list'});
      for (const n of topo.nodes.filter(x => x.type === 'target')) {
        const p = cfg.targets.find(t => t.name === n.id) || {};
        l.append(li(n.online === false ? 'alta' : 'ok', n.label, p.parent ? '↳ ' + p.parent : 'raiz', '', () => openSheet('target', {name: n.id})));
      }
      L.append(l);
      const {pos, leaves, depth} = layoutTree(topo.nodes, topo.edges);
      const W = Math.max(640, leaves * 120), H = Math.max(360, (depth + 1) * 130);
      const X = x => 60 + (W - 120) * (leaves > 1 ? x / (leaves - 1) : .5), Y = y => 50 + (H - 110) * (depth ? y / depth : 0);
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'topo');
      for (const e of topo.edges) {
        const a = pos[e.source], b = pos[e.target];
        if (!a || !b) continue;
        const tn = topo.nodes.find(n => n.id === e.target) || {};
        const p = document.createElementNS(NS, 'path');
        const x1 = X(a.x), y1 = Y(a.y) + 22, x2 = X(b.x), y2 = Y(b.y) - 22, my = (y1 + y2) / 2;
        p.setAttribute('d', `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`);
        p.setAttribute('class', 'edge' + (tn.online === false ? ' dead' : (e.loss_pct || 0) > 0 ? ' hot' : ''));
        svg.append(p);
        if (e.latency != null) {
          const t = document.createElementNS(NS, 'text');
          t.setAttribute('x', (x1 + x2) / 2 + 6); t.setAttribute('y', my); t.setAttribute('font-size', '10'); t.setAttribute('opacity', '.65');
          t.textContent = ms(e.latency) + ' ms';
          svg.append(t);
        }
      }
      for (const n of topo.nodes) {
        const p = pos[n.id]; if (!p) continue;
        const g = document.createElementNS(NS, 'g');
        g.style.cursor = n.type === 'target' ? 'pointer' : 'default';
        const color = n.type === 'internet' ? C('--blue') : n.online === false ? C('--red') : n.online ? C('--green') : C('--grey');
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', X(p.x)); c.setAttribute('cy', Y(p.y)); c.setAttribute('r', n.type === 'internet' ? 24 : 20);
        c.setAttribute('fill', color); c.setAttribute('class', 'node-orb'); c.style.color = color;
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', X(p.x)); t.setAttribute('y', Y(p.y) + 38); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-weight', '600');
        t.textContent = n.label;
        g.append(c, t);
        if (n.type === 'target') g.addEventListener('click', () => openSheet('target', {name: n.id}));
        svg.append(g);
      }
      R.append(svg);
    },
  });

  // mapa da rede em caixas (v3.5)
  async function renderMap(ctx) {
    const [L, R] = panels(ctx);
    const host = h('div', {class: 'tm-host'});
    const kp = h('div', {class: 'tm-kpis'});
    const tb = h('div', {class: 'tmc'});
    R.classList.add('topo-map');
    R.append(kp, tb, host);
    let m = null, drawnSig = '', drawnAt = 0;
    // ---- máquina do tempo: at = null -> ao vivo
    let at = ctx.params.at ? +ctx.params.at : null, span = ctx.params.span || (at && Date.now() / 1000 - at > 86400 ? 168 : 24);
    let TM = null, playT = null, fetchT = null;
    const p2 = n => String(n).padStart(2, '0');
    const fmtAt = ts => {
      const d = new Date(ts * 1000), t = new Date(), y = new Date(t); y.setDate(t.getDate() - 1);
      const hh = p2(d.getHours()) + ':' + p2(d.getMinutes());
      return d.toDateString() === t.toDateString() ? 'hoje ' + hh : d.toDateString() === y.toDateString() ? 'ontem ' + hh : p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + hh;
    };
    const live = h('button', {type: 'button', class: 'tmc-live'}, h('i'), 'Ao vivo');
    const rng = h('input', {type: 'range', class: 'tmc-rng', step: '60', 'aria-label': 'Momento exibido no mapa'});
    const marks = h('div', {class: 'tmc-marks'});
    const lab = h('div', {class: 'tmc-lab'}, h('b'), h('span'));
    const playB = h('button', {type: 'button', class: 'tmc-b', title: 'Reproduzir', trusted: ICO('play')});
    const backB = h('button', {type: 'button', class: 'tmc-b', title: 'Voltar', trusted: ICO('left')});
    const fwdB = h('button', {type: 'button', class: 'tmc-b', title: 'Avançar', trusted: ICO('chevron')});
    const spanSeg = h('div', {class: 'tmc-span'});
    tb.append(live, h('div', {class: 'tmc-mid'}, h('div', {class: 'tmc-track'}, marks, rng)), lab, h('div', {class: 'tmc-ctl'}, backB, playB, fwdB), spanSeg);
    const stepS = () => span * 3600 / 120;
    function syncBar() {
      const now = Date.now() / 1000, from = TM ? Math.max(TM.first, now - span * 3600) : now - span * 3600;
      rng.min = String(Math.floor(from)); rng.max = String(Math.ceil(now));
      rng.value = String(at == null ? now : Math.max(from, at));
      live.classList.toggle('on', at == null);
      tb.classList.toggle('hist', at != null);
      lab.firstChild.textContent = at == null ? 'Agora' : fmtAt(at);
      lab.lastChild.textContent = at == null ? 'ao vivo' : 'há ' + dur(now - at);
      playB.innerHTML = ICO(playT ? 'pause' : 'play');
      clear(marks);
      for (const e of (TM && TM.marks) || []) {
        const a = Math.max(from, e.start), b = Math.min(now, e.end || now);
        if (b < from) continue;
        const mk = h('i', {class: e.level, title: `${fmtAt(e.start)} · ${e.title}${e.cause ? ' — ' + e.cause : ''}`});
        mk.style.left = (100 * (a - from) / (now - from)) + '%';
        mk.style.width = Math.max(.6, 100 * (b - a) / (now - from)) + '%';
        mk.onclick = () => { stopPlay(); at = e.start + 30; syncBar(); load(); };
        marks.append(mk);
      }
      clear(spanSeg).append(...[[6, '6 h'], [24, '24 h'], [168, '7 dias']].map(([v, t]) =>
        h('button', {type: 'button', class: span === v ? 'on' : '', text: t, onclick: async () => { span = v; await loadTM(); syncBar(); }})));
    }
    async function loadTM() { try { TM = await api('/api/timemachine?hours=' + span); } catch (_) { TM = null; } }
    function goto(ts) {
      const now = Date.now() / 1000;
      at = ts >= now - 30 ? null : ts;
      syncBar();
      clearTimeout(fetchT); fetchT = setTimeout(load, 180);
    }
    function stopPlay() { clearInterval(playT); playT = null; syncBar(); }
    rng.addEventListener('input', () => { stopPlay(); goto(+rng.value); });
    live.onclick = () => { stopPlay(); at = null; syncBar(); load(); };
    backB.onclick = () => { stopPlay(); goto((at == null ? Date.now() / 1000 : at) - stepS()); };
    fwdB.onclick = () => { stopPlay(); if (at != null) goto(at + stepS()); };
    playB.onclick = () => {
      if (playT) return stopPlay();
      if (at == null) at = Date.now() / 1000 - span * 3600;
      playT = setInterval(() => { goto(at + stepS()); if (at == null) stopPlay(); }, 700);
      syncBar();
    };
    ctx.cleanups.push(() => { clearInterval(playT); clearTimeout(fetchT); });
    const kpi = (orb, icon, l, v, sub) => h('div', {class: 'tm-kpi'}, h('span', {class: 'orb ' + orb, trusted: ICO(icon)}),
      h('span', {style: {minWidth: 0}}, h('span', {class: 'l', text: l}), h('span', {class: 'v', text: String(v)}), h('span', {class: 's', text: sub})));
    async function load() {
      const want = at;
      const D = await api('/api/topomap' + (want != null ? '?at=' + Math.round(want) : ''));
      if (!ctx.alive || want !== at) return;          // o usuário já arrastou para outro momento
      const s = D.summary;
      clear(kp).append(
        kpi('green', 'check', 'Destinos online', `${s.ok + s.warn}/${s.total}`, !s.total ? 'nenhum destino' : D.at ? 'naquele momento' : 'respondendo agora'),
        kpi(s.bad ? 'red' : 'green', s.bad ? 'x' : 'check', 'Fora do ar', s.bad, s.bad ? 'causa raiz' : 'nenhum problema'),
        kpi(s.warn ? '' : 'green', 'alert', 'Avisos', s.warn, 'lento ou com perda'),
        kpi(s.iso ? 'grey' : 'blue', 'network', 'Isolados', s.iso, 'atrás de um equipamento caído'));
      const sg = NNMap.sig(D);
      if (!m || sg !== drawnSig || Date.now() - drawnAt > 60000) {
        if (m) { try { m.destroy(); } catch (_) { /* ok */ } m = null; }
        m = NN.safe(host, () => NNMap.render(host, D, {onItem: n => openSheet('target', {name: n}), onCam: ch => openSheet('cameras', {ch})}), 'Mapa');
        drawnSig = m ? sg : null; drawnAt = Date.now();
      }
      // painel lateral
      clear(L);
      L.append(h('div', {class: 'bigstat'}, h('span', {class: 'l', text: 'Status da rede'}), h('span', {class: 'v', text: String(s.total)}, h('small', {text: 'destinos'}))));
      L.append(h('div', {class: 'tm-ringbox'}, NNMap.ring(s, 168)));
      const lg = h('div', {class: 'tm-legend'});
      for (const [k, c, t] of [['ok', 'var(--green)', 'Online'], ['warn', 'var(--yellow)', 'Avisos'], ['bad', 'var(--red)', 'Fora do ar'], ['iso', 'var(--muted)', 'Isolados'], ['na', 'var(--grey)', 'Sem dados']]) {
        if (k === 'na' && !s.na) continue;
        lg.append(h('div', {}, h('i', {style: {background: c}}), h('b', {text: String(s[k] || 0)}), h('span', {text: t})));
      }
      L.append(lg, h('div', {class: 'rule'}));
      L.append(h('h4', {class: 'side-h', text: D.at ? 'Problemas em ' + fmtAt(D.at) : 'Problemas agora'}));
      const act_ = D.at ? D.incidents : (NN.S.active || []);
      if (!act_.length) L.append(h('div', {class: 'hint', style: {color: 'var(--green)'}, text: 'Nenhum problema ✓'}));
      const pl = h('div', {class: 'list'});
      for (const i of act_.slice(0, 6)) pl.append(li(sevClass(i.severity), i.target, i.cause ? i.message + ' — ' + i.cause : i.message, hm(i.started_ts), () => openSheet('incidents')));
      L.append(pl, h('div', {class: 'rule'}));
      L.append(h('div', {class: 'hint', text: 'Agrupe os destinos abrindo um card → "Grupo no mapa" (ex.: Servidores, Wi-Fi, Câmeras). Sem grupo: os de internet vão para "Internet", os locais para "Rede local", e quem tem dependentes ganha caixa própria. As ligações seguem o "Depende de".'}));
    }
    await loadTM(); syncBar();
    await load();
    ctx.every(10000, () => { if (at == null) load(); syncBar(); });
    ctx.every(60000, async () => { await loadTM(); syncBar(); });
    ctx.cleanups.push(() => { if (m) m.destroy(); });
  }

})();
