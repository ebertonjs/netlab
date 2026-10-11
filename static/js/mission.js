// Página "Mission Control": anel de saúde, radar de latência, incidentes, MikroTik, linha de 24 h e cards por alvo.
(function () {
  const PORT_POS = [36.3, 47.6, 59, 70.4, 81.7];
  const RING = [[0, 40], [5, 70], [20, 130], [50, 190], [100, 250]];
  const CX = 320, CY = 270;
  const HIDE_OVERVIEW = true;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let page, root, el = {}, D = {}, lastSig = '', lastScore = null, tween = null, clockTimer = null, snapAt = 0;
  const last = {};

  function active() { return page && page.classList.contains('active'); }
  function every(key, ms, fn) {
    if (Date.now() - (last[key] || 0) < ms) return Promise.resolve();
    last[key] = Date.now();
    return Promise.resolve().then(fn).catch(function () { /* fonte indisponível */ });
  }
  function refresh(force) {
    if (force) Object.keys(last).forEach(function (k) { last[k] = 0; });
    return Promise.all([
      every('spark', 8000, async function () { D.spark = await apiJSON('GET', '/api/sparklines'); }),
      every('bars', 60000, async function () { D.bars = await apiJSON('GET', '/api/uptime/bars?hours=24'); }),
      every('targets', 15000, async function () { D.targetsInfo = await apiJSON('GET', '/api/targets'); }),
      every('resolved', 30000, async function () {
        const all = await apiJSON('GET', '/api/incidents?days=1');
        D.resolved = (all || []).filter(function (i) { return i.resolved_ts; }).slice(0, 4);
      }),
      every('agh', 30000, async function () {
        const st = await apiJSON('GET', '/api/agh/status');
        if (!st || !st.enabled) { D.agh = null; return; }
        const stats = await apiJSON('GET', '/api/agh/stats').catch(function () { return {}; });
        const hist = await apiJSON('GET', '/api/agh/history?range=1h').catch(function () { return []; });
        D.agh = {st: st, stats: stats || {}, hist: hist || []};
      }),
      every('lat24', 60000, async function () { D.lat24 = await apiJSON('GET', '/api/history/24h'); }),
      every('speed', 120000, async function () { D.speed = await apiJSON('GET', '/api/speedtest/history?limit=8'); }),
      every('sites', 20000, async function () { D.sites = await apiJSON('GET', '/api/sites'); }),
      every('aghtop', 30000, async function () {
        D.aghTop = D.agh ? await apiJSON('GET', '/api/agh/top') : null;
      }),
      every('mk', 8000, async function () {
        const st = await apiJSON('GET', '/api/mikrotik/status');
        D.mk = st && st.enabled && st.board_name ? st : null;
        D.ifaces = D.mk ? await apiJSON('GET', '/api/mikrotik/interfaces') : null;
      })
    ]);
  }

  // ------------------------------------------------------------------ modelo
  function snap() { return window.__lastSnapshot || {}; }
  function targetState(n, t, incs) {
    if (!t || t.online == null) return 'na';
    if (t.online === false) return 'bad';
    if ((t.loss_pct || 0) >= 5 || incs.some(function (i) { return i.target === n; })) return 'warn';
    return 'ok';
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function model() {
    const s = snap(), o = s.overview || {}, ts = o.targets || {};
    const incs = (s.incidents || []).filter(function (i) { return i.severity !== 'Info'; });
    const names = Object.keys(ts).sort();
    const st = {}; names.forEach(function (n) { st[n] = targetState(n, ts[n], incs); });
    const known = names.filter(function (n) { return st[n] !== 'na'; });
    const pts = {ok: 100, warn: 60, bad: 0};
    const links = known.length ? known.reduce(function (a, n) { return a + pts[st[n]]; }, 0) / known.length : null;
    const ups = (D.targetsInfo || []).map(function (t) { return t.uptime_24h; }).filter(function (v) { return typeof v === 'number'; });
    const disp = ups.length ? ups.reduce(function (a, b) { return a + b; }, 0) / ups.length : null;
    const lat = o.avg_latency != null ? clamp(100 - Math.max(0, o.avg_latency - 50) / 250 * 100, 0, 100) : null;
    const hi = incs.filter(function (i) { return i.severity === 'Alta'; }).length;
    const mid = incs.filter(function (i) { return i.severity === 'Media'; }).length;
    const inc = clamp(100 - hi * 25 - mid * 10 - (incs.length - hi - mid) * 3, 0, 100);
    // pesos: disponibilidade 30, estado dos alvos 30, latência 15, incidentes 25 (ignora o que não tem dado)
    const parts = [[disp, 30], [links, 30], [lat, 15], [inc, 25]].filter(function (p) { return p[0] != null; });
    const wsum = parts.reduce(function (a, p) { return a + p[1]; }, 0);
    const score = known.length && wsum ? Math.round(parts.reduce(function (a, p) { return a + p[0] * p[1]; }, 0) / wsum) : null;
    const internet = o.internet_online === false ? 0 : (o.avg_loss_pct != null ? clamp(100 - o.avg_loss_pct, 0, 100) : null);
    const hw = [];
    if (D.mk) {
      let e = 100;
      if (D.mk.stale) e -= 40;
      if (D.mk.cpu_load >= 80) e -= 25; else if (D.mk.cpu_load >= 60) e -= 10;
      if (D.mk.temperature >= 75) e -= 25; else if (D.mk.temperature >= 65) e -= 10;
      if (D.mk.mem_pct >= 90) e -= 15;
      hw.push(clamp(e, 0, 100));
    }
    const cpu = num(o.cpu_pct), mem = num(o.mem_pct), tmp = num(o.temp_c);
    if (cpu != null || mem != null || tmp != null) {
      let e = 100;
      if (cpu >= 90) e -= 30; else if (cpu >= 70) e -= 10;
      if (tmp >= 80) e -= 30; else if (tmp >= 70) e -= 10;
      if (mem >= 90) e -= 15;
      hw.push(clamp(e, 0, 100));
    }
    const equip = hw.length ? Math.min.apply(null, hw) : null;
    return {o: o, ts: ts, names: names, st: st, incs: incs, hi: hi, score: score, links: links, disp: disp, internet: internet, equip: equip};
  }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function tone(v) { return v == null ? 'na' : v >= 90 ? 'ok' : v >= 70 ? 'warn' : 'bad'; }
  const TONE_LABEL = {ok: 'OPERACIONAL', warn: 'ATENÇÃO', bad: 'CRÍTICO', na: 'SEM DADOS'};

  // ---------------------------------------------------------------- construção
  function build() {
    page = addPage('mission', 'Mission Control', '🛰️', 'Mission Control', 'Painel de comando da rede em tempo real', onShow);
    const nav = document.querySelector('nav a[data-page="mission"]'), ov = document.querySelector('nav a[data-page="overview"]');
    if (nav && ov) ov.after(nav);
    el.pills = h('div', {class: 'mc-pills'});
    el.clock = h('div', {class: 'mc-clock'});
    el.kpis = h('div', {class: 'mc-kpis'});
    el.health = h('section', {class: 'mc-card mc-health'});
    el.radar = h('section', {class: 'mc-card mc-radar'});
    el.feed = h('section', {class: 'mc-card mc-feed'});
    el.hw = h('div', {class: 'mc-hw'});
    el.extra = h('div', {class: 'mc-extra'});
    el.attn = h('section', {class: 'mc-card mc-attn'});
    el.ok = h('section', {class: 'mc-card mc-okl'});
    root = h('div', {class: 'mc'},
      h('div', {class: 'mc-head'}, el.pills, el.clock),
      el.kpis,
      h('div', {class: 'mc-grid'}, el.health, el.radar, el.feed),
      el.hw,
      el.extra,
      h('div', {class: 'mc-lists'}, el.attn, el.ok));
    page.append(root);
    document.addEventListener('netnoc:snapshot', onSnap);
    // os botões de organizar widgets só fazem sentido na Visão Geral
    document.addEventListener('netnoc:page', function (ev) {
      const b = document.getElementById('autoArrangeBtn'), bar = b && b.parentElement;
      if (bar) bar.style.display = ev.detail === 'overview' ? '' : 'none';
      document.body.classList.toggle('mc-on', ev.detail === 'mission');
      if (HIDE_OVERVIEW && ev.detail === 'overview') window.showPage('mission');
    });
    // Visão Geral desativada (teste): some do menu e abre o Mission Control. Para reativar, troque HIDE_OVERVIEW para false.
    if (HIDE_OVERVIEW && ov) {
      ov.style.display = 'none';
      const mc = document.querySelector('.sidebar nav a[data-page="mission"]'); if (mc) mc.classList.add('mc-first');
    }
    try {
      if (HIDE_OVERVIEW || !localStorage.getItem('netnoc_mc_seen')) { localStorage.setItem('netnoc_mc_seen', '1'); window.showPage('mission'); }
    } catch (e) { /* sem storage */ }
  }
  function onShow() {
    refresh(true).then(render);
    render();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000); tick();
  }
  function onSnap() {
    if (!active()) return;
    refresh(false).then(function () { /* entra no próximo render */ });
    if (Date.now() - snapAt < 1500) return;
    snapAt = Date.now(); render();
  }
  function tick() {
    if (!active()) { clearInterval(clockTimer); return; }
    const d = new Date();
    el.clock.replaceChildren(h('b', {text: d.toLocaleTimeString('pt-BR')}),
      h('small', {text: d.toLocaleDateString('pt-BR', {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'}).toUpperCase().replace(/\./g, '')}));
    root.querySelectorAll('[data-started]').forEach(function (n) {
      n.textContent = dur(Date.now() / 1000 - Number(n.dataset.started));
    });
  }
  function dur(s) {
    s = Math.max(0, Math.floor(s));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  function render() {
    if (!active()) return;
    const m = model();
    renderPills(m); renderKpis(m); renderHealth(m); renderRadar(m); renderFeed(m); renderHw(m); renderExtra(m); renderLists(m);
  }

  // ------------------------------------------------------------------ blocos
  function renderPills(m) {
    const s = snap(), age = s.ts ? Date.now() / 1000 - s.ts : null, fresh = age != null && age < 30;
    const bad = m.names.filter(function (n) { return m.st[n] === 'bad' || m.st[n] === 'warn'; }).length;
    const pills = [h('span', {class: 'mc-pill', text: m.names.length + ' ALVOS · ' + (bad ? bad + ' COM PROBLEMA' : 'TODOS OK')})];
    if (!fresh) pills.push(h('span', {class: 'mc-pill stale', text: 'DADOS ATRASADOS'}));
    el.pills.replaceChildren.apply(el.pills, pills);
  }
  function kpi(label, big, cls, sub) {
    return h('div', {class: 'mc-kpi'}, h('span', {class: 'mc-lab', text: label}),
      h('b', {class: cls || '', text: big}), sub ? h('small', {text: sub}) : null);
  }
  function renderKpis(m) {
    const o = m.o, on = o.internet_online;
    const loss = o.avg_loss_pct, lat = o.avg_latency;
    el.kpis.replaceChildren(
      kpi('Status da internet', on == null ? '–' : on ? 'ONLINE' : 'OFFLINE', on ? 'mc-ok' : on === false ? 'mc-bad' : 'mc-na', o.speedtest && o.speedtest.download ? '↓ ' + Math.round(o.speedtest.download) + ' · ↑ ' + Math.round(o.speedtest.upload) + ' Mbps (último teste)' : null),
      kpi('IP público', o.public_ip || '–', 'mc-ip', o.public_ipv6 || null),
      kpi('Latência média', lat != null ? lat.toFixed(1) + ' ms' : '–', lat == null ? 'mc-na' : lat > 100 ? 'mc-bad' : lat > 50 ? 'mc-warn' : 'mc-ok', o.avg_jitter != null ? 'jitter ' + o.avg_jitter.toFixed(1) + ' ms' : null),
      kpi('Perda de pacotes', loss != null ? loss.toFixed(2) + '%' : '–', loss == null ? 'mc-na' : loss > 5 ? 'mc-bad' : loss > 1 ? 'mc-warn' : 'mc-ok', null));
  }

  function svg(tag, attrs, parent) {
    const x = svgEl(tag, attrs); if (parent) parent.appendChild(x); return x;
  }
  function renderHealth(m) {
    const t = tone(m.score), sc = m.score;
    const C = 2 * Math.PI * 125, C2 = 2 * Math.PI * 98;
    const grad = {ok: ['#35e0ff', '#3ef0a5'], warn: ['#ffb020', '#ffd36b'], bad: ['#ff4d5e', '#ff8a5c'], na: ['#7d8aa8', '#7d8aa8']}[t];
    const ring = svgEl('svg', {viewBox: '0 0 300 300', class: 'mc-ring', 'aria-hidden': 'true'});
    const defs = svg('defs', {}, ring);
    const g = svg('linearGradient', {id: 'mcg', x1: '0', x2: '1'}, defs);
    svg('stop', {offset: '0', 'stop-color': grad[0]}, g); svg('stop', {offset: '1', 'stop-color': grad[1]}, g);
    const f = svg('filter', {id: 'mcf', x: '-20%', y: '-20%', width: '140%', height: '140%'}, defs);
    svg('feGaussianBlur', {stdDeviation: '5', result: 'b'}, f);
    const fm = svg('feMerge', {}, f); svg('feMergeNode', {'in': 'b'}, fm); svg('feMergeNode', {'in': 'SourceGraphic'}, fm);
    svg('circle', {cx: 150, cy: 150, r: 125, fill: 'none', stroke: 'rgba(90,150,255,.14)', 'stroke-width': 16}, ring);
    svg('circle', {cx: 150, cy: 150, r: 125, fill: 'none', stroke: 'url(#mcg)', 'stroke-width': 16, 'stroke-linecap': 'round',
      'stroke-dasharray': (C * (sc || 0) / 100).toFixed(1) + ' ' + C.toFixed(1), transform: 'rotate(-90 150 150)', filter: 'url(#mcf)'}, ring);
    const lt = tone(m.links);
    svg('circle', {cx: 150, cy: 150, r: 98, fill: 'none', stroke: 'rgba(90,150,255,.10)', 'stroke-width': 4}, ring);
    svg('circle', {cx: 150, cy: 150, r: 98, fill: 'none', stroke: {ok: '#3ef0a5', warn: '#ffb020', bad: '#ff4d5e', na: '#7d8aa8'}[lt], 'stroke-width': 4,
      'stroke-linecap': 'round', 'stroke-dasharray': (C2 * (m.links || 0) / 100).toFixed(1) + ' ' + C2.toFixed(1), transform: 'rotate(-90 150 150)', opacity: '.85'}, ring);
    const num = h('b', {class: 'mc-score-n mc-' + t, text: sc == null ? '–' : String(sc)});
    if (sc != null && lastScore != null && sc !== lastScore && !reduced) countTo(num, lastScore, sc);
    lastScore = sc;
    function sub(label, v, dec) { return h('div', {class: 'mc-sub'}, h('span', {class: 'mc-lab', text: label}), h('b', {class: 'mc-' + tone(v), text: v == null ? '–' : (dec ? v.toFixed(1) : String(Math.round(v)))})); }
    el.health.replaceChildren(
      h('div', {class: 'mc-lab', text: 'Saúde da rede'}),
      h('div', {class: 'mc-ring-box'}, ring, h('div', {class: 'mc-score'}, num, h('small', {class: 'mc-' + t, text: TONE_LABEL[t]}))),
      h('div', {class: 'mc-subs'}, sub('Internet', m.internet), sub('Disp. 24h', m.disp, true), sub('Equip.', m.equip)),
      h('div', {class: 'mc-note', title: 'Nota = 30% disponibilidade 24 h + 30% estado dos alvos + 15% latência + 25% incidentes ativos', text: 'Como é calculada?'}));
  }
  function countTo(node, a, b) {
    cancelAnimationFrame(tween);
    const t0 = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - t0) / 700);
      node.textContent = String(Math.round(a + (b - a) * k));
      if (k < 1) tween = requestAnimationFrame(step);
    })(t0);
  }

  function rad(ms) {
    if (ms == null) return 120;
    if (ms >= 100) return Math.min(268, 250 + (ms - 100) / 50 * 18);
    for (let i = 1; i < RING.length; i++) {
      if (ms <= RING[i][0]) {
        const a = RING[i - 1], b = RING[i];
        return a[1] + (ms - a[0]) / (b[0] - a[0]) * (b[1] - a[1]);
      }
    }
    return 250;
  }
  const COL = {ok: '#3ef0a5', warn: '#ffb020', bad: '#ff4d5e', na: '#7d8aa8'};
  function renderRadar(m) {
    const sig = m.names.map(function (n) { const t = m.ts[n] || {}; return n + ':' + m.st[n] + ':' + Math.round(t.latency || 0); }).join('|');
    if (sig === lastSig && el.radar.firstChild) return;
    lastSig = sig;
    const s = svgEl('svg', {viewBox: '0 0 640 540', class: 'mc-radar-svg', role: 'img', 'aria-label': 'Radar de latência dos alvos'});
    const defs = svg('defs', {}, s);
    const rg = svg('radialGradient', {id: 'mcsw', cx: '0', cy: '0', r: '1', gradientUnits: 'objectBoundingBox'}, defs);
    svg('stop', {offset: '0', 'stop-color': '#35e0ff', 'stop-opacity': '0'}, rg); svg('stop', {offset: '1', 'stop-color': '#35e0ff', 'stop-opacity': '.22'}, rg);
    const fl = svg('filter', {id: 'mcg2', x: '-50%', y: '-50%', width: '200%', height: '200%'}, defs);
    svg('feGaussianBlur', {stdDeviation: '4', result: 'b'}, fl);
    const fm = svg('feMerge', {}, fl); svg('feMergeNode', {'in': 'b'}, fm); svg('feMergeNode', {'in': 'SourceGraphic'}, fm);
    [70, 130, 190, 250].forEach(function (r, i) {
      svg('circle', {cx: CX, cy: CY, r: r, fill: 'none', stroke: 'rgba(90,150,255,.18)', 'stroke-dasharray': i ? '3 6' : '0'}, s);
      const t = svg('text', {x: CX + r + 4, y: CY - 4, fill: '#7d8aa8', 'font-size': 10, 'font-family': 'monospace'}, s);
      t.textContent = ['5', '20', '50', '100'][i] + ' ms';
    });
    for (let a = 0; a < 360; a += 30) {
      svg('line', {x1: CX, y1: CY, x2: CX + Math.cos(a * Math.PI / 180) * 250, y2: CY + Math.sin(a * Math.PI / 180) * 250, stroke: 'rgba(90,150,255,.07)'}, s);
    }
    if (!reduced) {
      const sw = svg('path', {d: 'M' + CX + ',' + CY + ' L' + (CX + 250) + ',' + CY + ' A250,250 0 0 0 ' + (CX + 250 * Math.cos(-0.5)) + ',' + (CY + 250 * Math.sin(-0.5)) + ' Z', fill: 'url(#mcsw)'}, s);
      svg('animateTransform', {attributeName: 'transform', type: 'rotate', from: '0 ' + CX + ' ' + CY, to: '360 ' + CX + ' ' + CY, dur: '9s', repeatCount: 'indefinite'}, sw);
    }
    const n = m.names.length;
    m.names.forEach(function (name, i) {
      const t = m.ts[name] || {}, st = m.st[name], c = COL[st];
      const ang = (-90 + 20 + i * 360 / Math.max(n, 1)) * Math.PI / 180;
      const r = st === 'bad' ? 225 : st === 'na' ? 150 : rad(t.latency);
      const x = CX + Math.cos(ang) * r, y = CY + Math.sin(ang) * r;
      svg('line', {x1: CX, y1: CY, x2: x, y2: y, stroke: c, 'stroke-opacity': st === 'na' ? .15 : .35, 'stroke-width': 1.4, 'stroke-dasharray': st === 'bad' ? '4 5' : '0'}, s);
      if ((st === 'ok' || st === 'warn') && !reduced) {
        const secs = clamp(2 + (t.latency || 20) / 25, 2, 7);
        [0, 1].forEach(function (k) {
          const d = svg('circle', {r: 2.4, fill: c, opacity: '.9'}, s);
          svg('animateMotion', {dur: secs + 's', begin: (-k * secs / 2) + 's', repeatCount: 'indefinite', path: 'M' + CX + ',' + CY + ' L' + x.toFixed(1) + ',' + y.toFixed(1)}, d);
        });
      }
      if (st === 'bad') {
        [20, 32].forEach(function (rr, k) { svg('circle', {cx: x, cy: y, r: rr, fill: 'none', stroke: c, 'stroke-opacity': .5 - k * .2}, s); });
      }
      svg('circle', {cx: x, cy: y, r: st === 'bad' ? 8 : 7, fill: st === 'bad' ? '#2a0e14' : '#06121a', stroke: c, 'stroke-width': 2.5, filter: 'url(#mcg2)'}, s);
      const right = x >= CX, tx = right ? x + 14 : x - 14, anchor = right ? 'start' : 'end';
      const l1 = svg('text', {x: tx, y: y - 2, fill: '#e6edf9', 'font-size': 12, 'font-weight': 600, 'text-anchor': anchor, 'font-family': 'Inter,sans-serif'}, s);
      l1.textContent = name;
      const l2 = svg('text', {x: tx, y: y + 13, fill: c, 'font-size': 11, 'text-anchor': anchor, 'font-family': 'monospace'}, s);
      l2.textContent = st === 'bad' ? 'offline' : st === 'na' ? 'sem dados' : (t.latency != null ? t.latency.toFixed(0) + ' ms' : 'ok');
    });
    svg('circle', {cx: CX, cy: CY, r: 30, fill: 'rgba(53,224,255,.08)', stroke: '#35e0ff', 'stroke-opacity': .5}, s);
    svg('circle', {cx: CX, cy: CY, r: 15, fill: '#071a2a', stroke: '#35e0ff', 'stroke-width': 2.5, filter: 'url(#mcg2)'}, s);
    const tc = svg('text', {x: CX, y: CY + 4, fill: '#35e0ff', 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': 'monospace'}, s);
    tc.textContent = 'GW';
    el.radar.replaceChildren(
      h('div', {class: 'mc-lab', text: 'Radar de latência'}),
      h('div', {class: 'mc-legend'}, h('span', {}, h('i', {class: 'g'}), 'ok'), h('span', {}, h('i', {class: 'a'}), 'degradado'), h('span', {}, h('i', {class: 'r'}), 'offline')),
      s);
  }

  function incText(i) {
    return i.target && String(i.message || '').indexOf(i.target) < 0 ? i.target + ' — ' + i.message : String(i.message || '');
  }
  function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); }
  function renderFeed(m) {
    const rows = [];
    rows.push(h('div', {class: 'mc-lab', text: 'Incidentes ativos'}));
    if (!m.incs.length) rows.push(h('div', {class: 'mc-inc g'}, h('i', {class: 'mc-d'}), h('div', {}, h('b', {text: 'Tudo operacional'}), h('span', {text: 'Nenhum incidente ativo'}))));
    m.incs.slice(0, 5).forEach(function (i) {
      rows.push(h('div', {class: 'mc-inc ' + (i.severity === 'Alta' ? 'r' : 'a')}, h('i', {class: 'mc-d'}),
        h('div', {}, h('b', {text: incText(i)}), h('span', {text: i.severity})),
        h('span', {class: 'mc-tm', 'data-started': String(i.started_ts), text: dur(Date.now() / 1000 - i.started_ts)})));
    });
    if (m.incs.length > 5) rows.push(h('div', {class: 'mc-more', text: '+ ' + (m.incs.length - 5) + ' outros'}));
    const r = D.resolved || [];
    if (r.length) {
      rows.push(h('div', {class: 'mc-lab mc-gap', text: 'Resolvidos hoje'}));
      r.slice(0, 3).forEach(function (i) {
        rows.push(h('div', {class: 'mc-inc g'}, h('i', {class: 'mc-d'}),
          h('div', {}, h('b', {text: incText(i)}),
            h('span', {text: hhmm(i.started_ts) + ' → ' + hhmm(i.resolved_ts) + ' · ' + fmtDur(i.resolved_ts - i.started_ts)}))));
      });
    }
    el.feed.replaceChildren.apply(el.feed, rows);
  }

  function wanName() { return (typeof MK_PORT_ORDER !== 'undefined' && MK_PORT_ORDER[0]) || 'ether1'; }
  function bps(v) { return v == null ? '–' : (typeof fmtBps === 'function' ? fmtBps(v) : (v / 1e6).toFixed(1) + ' Mbps'); }
  function meter(label, v, unit, warn, bad) {
    const n = num(v), t = n == null ? 'na' : n >= bad ? 'bad' : n >= warn ? 'warn' : 'ok';
    return h('div', {class: 'mc-meter'},
      h('div', {class: 'mc-meter-h'}, h('span', {text: label}), h('b', {class: 'mc-' + t, text: n == null ? '–' : (Math.round(n * 10) / 10) + unit})),
      h('div', {class: 'mc-bar'}, h('i', {class: 'mc-' + t, style: {width: (n == null ? 0 : clamp(unit === '°C' ? n : n, 0, 100)) + '%'}})));
  }
  function hwCard(title, dot, body) {
    return h('section', {class: 'mc-card mc-hwc'}, h('div', {class: 'mc-lab mc-hwh'}, h('span', {text: title}), dot ? h('i', {class: 'mc-dot ' + dot}) : null), body);
  }
  function renderHw(m) {
    const o = m.o, cards = [];
    // Raspberry Pi (host do NetNOC)
    cards.push(hwCard('Raspberry Pi · servidor', 'ok', h('div', {class: 'mc-meters'},
      meter('CPU', o.cpu_pct, '%', 70, 90), meter('Memória', o.mem_pct, '%', 80, 90), meter('Temperatura', o.temp_c, '°C', 65, 80))));
    // MikroTik
    const mk = D.mk;
    if (mk) {
      const by = {}; (D.ifaces || []).forEach(function (r) { by[r.name] = r; });
      const order = (typeof MK_PORT_ORDER !== 'undefined') ? MK_PORT_ORDER : ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'];
      const w = by[wanName()];
      const img = document.querySelector('.mk-panel-img');
      let photo = null;
      if (img && img.src) {
        photo = h('div', {class: 'mc-photo'}, h('img', {src: img.src, alt: 'MikroTik'}));
        PORT_POS.forEach(function (left, i) {
          const r = by[order[i]];
          photo.appendChild(h('i', {class: 'mc-port ' + (r ? (r.running ? 'on' : 'off') : ''), style: {left: left + '%'}}));
        });
      }
      cards.push(hwCard('MikroTik ' + (mk.board_name || '') + ' · RouterOS ' + String(mk.version || '').split(' ')[0], mk.stale ? 'bad' : 'ok', h('div', {},
        photo,
        h('div', {class: 'mc-rxtx'}, h('span', {}, '↓ ', h('b', {class: 'mc-ok', text: bps(w && w.rx_bps)})), h('span', {}, '↑ ', h('b', {class: 'mc-tx', text: bps(w && w.tx_bps)}))),
        h('div', {class: 'mc-meters mc-meters-3'}, meter('CPU', mk.cpu_load, '%', 60, 80), meter('Memória', mk.mem_pct, '%', 80, 90), meter('Temp.', mk.temperature, '°C', 65, 75)),
        h('div', {class: 'mc-small', text: 'Uptime ' + (mk.uptime_s != null ? fmtDur(mk.uptime_s) : '–')}))));
    }
    // AdGuard Home
    const ag = D.agh;
    if (ag) {
      const st = ag.st, s = ag.stats || {};
      const q = s.num_dns_queries, bl = s.num_blocked_filtering, pct = s.blocked_pct;
      const hist = (ag.hist || []).map(function (p) { return p.num_dns_queries; });
      const line = svgEl('svg', {viewBox: '0 0 220 50', preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'mc-agh-line'});
      if (hist.length > 1) {
        const mx = Math.max.apply(null, hist.concat([1])), mn = Math.min.apply(null, hist), rng = (mx - mn) || 1, step = 220 / (hist.length - 1);
        svg('polyline', {points: hist.map(function (v, i) { return (i * step).toFixed(1) + ',' + (46 - (v - mn) / rng * 40).toFixed(1); }).join(' '), fill: 'none', stroke: '#5b9dff', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'}, line);
      }
      cards.push(hwCard('AdGuard Home' + (st.version ? ' · ' + st.version : ''), st.online ? (st.protection_enabled ? 'ok' : 'warn') : 'bad', h('div', {},
        h('div', {class: 'mc-agh-grid'},
          h('div', {}, h('span', {class: 'mc-lab', text: 'Consultas DNS'}), h('b', {class: 'mc-big', text: q != null ? Number(q).toLocaleString('pt-BR') : '–'})),
          h('div', {}, h('span', {class: 'mc-lab', text: 'Bloqueadas'}), h('b', {class: 'mc-big mc-bad', text: bl != null ? Number(bl).toLocaleString('pt-BR') : '–'}))),
        h('div', {class: 'mc-meter'}, h('div', {class: 'mc-meter-h'}, h('span', {text: '% de bloqueio'}), h('b', {text: (pct != null ? pct : '–') + '%'})),
          h('div', {class: 'mc-bar'}, h('i', {class: 'mc-ok', style: {width: clamp(num(pct) || 0, 0, 100) + '%'}}))),
        line,
        h('div', {class: 'mc-small', text: !st.online ? 'AdGuard fora do ar' : 'Proteção ' + (st.protection_enabled ? 'ativa' : 'DESATIVADA') + (s.avg_processing_time != null ? ' · resposta média ' + (s.avg_processing_time * 1000).toFixed(1) + ' ms' : '')}))));
    }
    el.hw.className = 'mc-hw mc-hw-' + cards.length;
    el.hw.replaceChildren.apply(el.hw, cards);
  }

  // ---------------------------------------------------- cards extras (5, 6, 7)
  function ago(ts) {
    const d = Date.now() / 1000 - ts;
    return d < 90 ? 'agora' : d < 3600 ? Math.round(d / 60) + ' min' : d < 86400 ? Math.round(d / 3600) + ' h' : Math.round(d / 86400) + ' d';
  }
  function areaSvg(vals, color) {
    const s = svgEl('svg', {viewBox: '0 0 320 90', preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'mc-area'});
    if (vals.length < 2) return s;
    const mx = Math.max.apply(null, vals.concat([1])), step = 320 / (vals.length - 1);
    const pts = vals.map(function (v, i) { return (i * step).toFixed(1) + ',' + (84 - v / mx * 74).toFixed(1); });
    const g = svg('linearGradient', {id: 'mcla', x1: '0', y1: '0', x2: '0', y2: '1'}, svg('defs', {}, s));
    svg('stop', {offset: '0', 'stop-color': color, 'stop-opacity': '.35'}, g); svg('stop', {offset: '1', 'stop-color': color, 'stop-opacity': '0'}, g);
    svg('polygon', {points: '0,90 ' + pts.join(' ') + ' 320,90', fill: 'url(#mcla)'}, s);
    svg('polyline', {points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'}, s);
    return s;
  }
  function cardLat() {
    const pts = (D.lat24 || []).map(function (p) { return p.latency; }).filter(function (v) { return typeof v === 'number'; });
    const sp = (D.speed || []).slice().reverse();
    if (pts.length < 2 && !sp.length) return null;
    const avg = pts.length ? pts.reduce(function (a, b) { return a + b; }, 0) / pts.length : null;
    const mn = pts.length ? Math.min.apply(null, pts) : null, mx = pts.length ? Math.max.apply(null, pts) : null;
    const f = function (v) { return v == null ? '–' : v.toFixed(1) + ' ms'; };
    const body = [];
    if (pts.length > 1) {
      body.push(areaSvg(pts, '#35e0ff'));
      body.push(h('div', {class: 'mc-stats3'},
        h('span', {}, 'mín ', h('b', {text: f(mn)})), h('span', {}, 'média ', h('b', {text: f(avg)})), h('span', {}, 'máx ', h('b', {class: mx > 100 ? 'mc-warn' : '', text: f(mx)}))));
    }
    if (sp.length) {
      const lastS = sp[sp.length - 1], top = Math.max.apply(null, sp.map(function (x) { return Math.max(x.download || 0, x.upload || 0); }).concat([1]));
      body.push(h('div', {class: 'mc-lab mc-gap', text: 'Último speedtest · ' + (ago(lastS.ts) === 'agora' ? 'agora' : 'há ' + ago(lastS.ts))}));
      body.push(h('div', {class: 'mc-rxtx'}, h('span', {}, '↓ ', h('b', {class: 'mc-ok', text: (lastS.download || 0).toFixed(0) + ' Mbps'})),
        h('span', {}, '↑ ', h('b', {class: 'mc-tx', text: (lastS.upload || 0).toFixed(0) + ' Mbps'}))));
      body.push(h('div', {class: 'mc-spd'}, sp.map(function (x) {
        return h('div', {class: 'mc-spd-c', title: fmtDateTime(x.ts) + ' — ↓' + (x.download || 0).toFixed(0) + ' ↑' + (x.upload || 0).toFixed(0) + ' Mbps'},
          h('i', {class: 'd', style: {height: ((x.download || 0) / top * 100) + '%'}}), h('i', {class: 'u', style: {height: ((x.upload || 0) / top * 100) + '%'}}));
      })));
    }
    return h('section', {class: 'mc-card'}, h('div', {class: 'mc-lab mc-hwh', text: 'Latência da internet · 24 h'}), body);
  }
  function cardSites() {
    const sl = (D.sites && D.sites.sites) || [];
    if (!sl.length) return null;
    const diag = ((D.sites && D.sites.targets) || []).filter(function (t) { return t.diagnosis && t.diagnosis !== 'Ok'; });
    const off = sl.filter(function (x) { return !x.online; }).length;
    const rows = sl.map(function (x) {
      return h('div', {class: 'mc-site'}, h('i', {class: 'mc-dot ' + (x.online ? 'ok' : 'bad')}), h('span', {class: 'mc-rn', text: x.site}),
        h('em', {class: x.online ? '' : 'mc-bad', text: x.online ? 'online' : 'mudo há ' + ago(x.last_seen)}));
    });
    diag.slice(0, 3).forEach(function (t) {
      rows.push(h('div', {class: 'mc-site mc-diag'}, h('i', {class: 'mc-dot warn'}), h('span', {text: t.target + ' — ' + t.diagnosis})));
    });
    return h('section', {class: 'mc-card'}, h('div', {class: 'mc-lab mc-hwh'}, h('span', {text: 'Sites remotos · ' + sl.length}), h('i', {class: 'mc-dot ' + (off ? 'bad' : diag.length ? 'warn' : 'ok')})), rows);
  }
  function topList(title, items, fmt, color) {
    const mx = Math.max.apply(null, items.map(function (x) { return x.v; }).concat([1]));
    return h('div', {class: 'mc-top'}, h('div', {class: 'mc-small mc-toph', text: title}),
      items.map(function (x) {
        return h('div', {class: 'mc-toprow'}, h('span', {class: 'mc-rn', title: x.name, text: x.name}), h('b', {text: fmt(x.v)}),
          h('div', {class: 'mc-bar'}, h('i', {style: {width: (x.v / mx * 100) + '%', background: color || ''}})));
      }));
  }
  function cardTop() {
    const parts = [];
    const ifs = (D.ifaces || []).filter(function (r) { return r.running; }).map(function (r) {
      return {name: r.name, v: (r.rx_bps || 0) + (r.tx_bps || 0), rx: r.rx_bps || 0, tx: r.tx_bps || 0};
    }).filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 5);
    if (ifs.length) parts.push(topList('MikroTik · interfaces por tráfego', ifs, function (v) { return bps(v); }, '#5b9dff'));
    const t = D.aghTop;
    if (t && t.clients && t.clients.length) parts.push(topList('AdGuard · clientes mais ativos', t.clients.map(function (x) { return {name: x.name, v: x.count}; }),
      function (v) { return Number(v).toLocaleString('pt-BR'); }, '#35e0ff'));
    if (t && t.blocked && t.blocked.length) parts.push(topList('AdGuard · domínios mais bloqueados', t.blocked.map(function (x) { return {name: x.name, v: x.count}; }),
      function (v) { return Number(v).toLocaleString('pt-BR'); }, '#ff4d5e'));
    if (!parts.length) return null;
    return h('section', {class: 'mc-card mc-topc'}, h('div', {class: 'mc-lab mc-hwh', text: 'Top consumidores'}), parts);
  }
  function renderExtra() {
    const cards = [cardLat(), cardSites(), cardTop()].filter(Boolean);
    el.extra.className = 'mc-extra mc-extra-' + cards.length;
    el.extra.replaceChildren.apply(el.extra, cards);
  }

  const RANK = {bad: 0, warn: 1, ok: 2, na: 3};
  const TLAB = {ok: 'ESTÁVEL', warn: 'DEGRADADO', bad: 'OFFLINE', na: 'SEM DADOS'};
  function lineSvg(vals, color) {
    const s = svgEl('svg', {viewBox: '0 0 220 60', preserveAspectRatio: 'none', 'aria-hidden': 'true'});
    const nums = (vals || []).map(function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; });
    if (nums.length < 2) return s;
    const mx = Math.max.apply(null, nums.concat([1])), step = 220 / (nums.length - 1);
    svg('polyline', {points: nums.map(function (v, i) { return (i * step).toFixed(1) + ',' + (56 - v / mx * 48).toFixed(1); }).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.2, 'vector-effect': 'non-scaling-stroke'}, s);
    return s;
  }
  function dots24(n) {
    const bars = (D.bars && D.bars[n]) || [];
    return h('div', {class: 'mc-dots'}, bars.map(function (b) {
      return h('i', {class: b.pct == null ? 'na' : b.pct >= 98 ? '' : b.pct >= 90 ? 'w' : 'b', title: fmtDateTime(b.ts) + ' — ' + (b.pct == null ? 'sem dados' : b.pct + '%')});
    }));
  }
  function renderLists(m) {
    if (!m.names.length) { el.attn.replaceChildren(emptyState('Sem destinos cadastrados.')); el.ok.replaceChildren(); return; }
    const sorted = m.names.slice().sort(function (a, b) { return RANK[m.st[a]] - RANK[m.st[b]] || a.localeCompare(b); });
    const attn = sorted.filter(function (n) { return m.st[n] !== 'ok'; }), good = sorted.filter(function (n) { return m.st[n] === 'ok'; });
    el.attn.replaceChildren(
      h('div', {class: 'mc-lab', text: attn.length ? 'Precisam de atenção · ' + attn.length : 'Atenção'}),
      attn.length ? h('div', {class: 'mc-acards'}, attn.map(function (n) {
        const t = m.ts[n] || {}, st = m.st[n], c = COL[st];
        const inc = m.incs.filter(function (i) { return i.target === n; }).sort(function (a, b) { return a.started_ts - b.started_ts; })[0];
        const sub = st === 'bad' ? (inc ? 'há ' + fmtDur(Date.now() / 1000 - inc.started_ts) + ' · ' : '') + 'perda ' + (t.loss_pct || 0).toFixed(0) + '%'
          : st === 'na' ? 'sem dados' : 'perda ' + (t.loss_pct || 0).toFixed(0) + '% · jitter ' + (t.avg_jitter || 0).toFixed(0) + ' ms';
        return h('div', {class: 'mc-ac ' + st},
          h('div', {class: 'mc-th'}, h('span', {text: n}), h('em', {text: TLAB[st]})),
          h('div', {class: 'mc-tn', text: st === 'bad' ? 'OFFLINE' : st === 'na' ? '–' : (t.latency != null ? t.latency.toFixed(0) + ' ms' : 'OK')}),
          h('div', {class: 'mc-ts', text: sub}), lineSvg((D.spark && D.spark[n]) || [], c), dots24(n));
      })) : h('div', {class: 'mc-allok', text: '✔ Todos os alvos operando normalmente'}));
    el.ok.replaceChildren(
      h('div', {class: 'mc-lab mc-okh'}, h('span', {text: 'Operando normalmente · ' + good.length}), h('span', {text: '24 h'})),
      h('div', {class: 'mc-rows'}, good.map(function (n) {
        const t = m.ts[n] || {};
        return h('div', {class: 'mc-row'}, h('span', {class: 'mc-rn', text: n}), h('b', {class: 'mc-ok', text: t.latency != null ? t.latency.toFixed(0) + ' ms' : 'OK'}),
          lineSvg((D.spark && D.spark[n]) || [], COL.ok), dots24(n));
      })));
  }

  build();
})();
