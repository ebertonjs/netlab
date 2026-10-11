// Modo TV v3: quatro cenas em rodízio (Visão geral, Topologia, Equipamentos, 24 h) e modo ALERTA que toma a tela.
// Abre pelo botão 📺 ou por #tv (ex.: #tv?cenas=1,2,3&tempo=20&som=1). Teclas: ← → cenas, espaço pausa, A dispensa alerta,
// S som, F tela cheia, Esc sai.
(function () {
  const PORT_POS = [36.3, 47.6, 59, 70.4, 81.7];
  const GOAL = 99.9;                       // meta de SLA (%)
  const SCENES = [[1, 'VISÃO GERAL'], [2, 'TOPOLOGIA'], [3, 'EQUIPAMENTOS'], [4, 'ÚLTIMAS 24 H']];
  const KEY = 'netnoc_tv';
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CW = 204, CH = 84, GX = 76, GY = 16;
  let root = null, stage, foot, dotsEl, nameEl, bar, pop, clockEl, toast, alertEl;
  let scene = null, sceneKey = 1, cfg = loadCfg(), D = {}, timer = null, tick = null, paused = false, sound = false, wakeLock = null, hideCur = null;
  let sceneStart = 0, seen = null, prevPorts = null, dismissed = new Set(), alertId = null, toastTimer = null, snapAt = 0;
  const last = {};

  // --------------------------------------------------------------- utilidades
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem storage */ } }
  function loadCfg() {
    let c = {scenes: [1, 2, 3, 4], secs: 15};
    try { const j = JSON.parse(lsGet(KEY) || 'null'); if (j && Array.isArray(j.scenes) && j.scenes.length) c = {scenes: j.scenes.filter(function (n) { return n >= 1 && n <= 4; }), secs: Number(j.secs) >= 0 ? Number(j.secs) : 15}; } catch (e) { /* padrão */ }
    if (!c.scenes.length) c.scenes = [1, 2, 3, 4];
    return c;
  }
  function saveCfg() { lsSet(KEY, JSON.stringify(cfg)); }
  function urlParams() {
    const q = (location.hash.split(/[?&]/).slice(1)).join('&'), p = new URLSearchParams(q), out = {};
    if (p.get('cenas')) { const l = p.get('cenas').split(',').map(Number).filter(function (n) { return n >= 1 && n <= 4; }); if (l.length) out.scenes = l; }
    if (p.get('tempo') && Number(p.get('tempo')) >= 0) out.secs = Number(p.get('tempo'));
    if (p.get('som') === '1') out.sound = true;
    return out;
  }
  function every(key, ms, fn) {
    if (Date.now() - (last[key] || 0) < ms) return Promise.resolve();
    last[key] = Date.now();
    return Promise.resolve().then(fn).catch(function () { /* fonte indisponível: segue sem */ });
  }
  function snap() { return window.__lastSnapshot || {}; }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dur(s) { s = Math.max(0, Math.floor(s)); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60); }
  function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); }
  function bps(v) { return v == null ? '–' : (typeof fmtBps === 'function' ? fmtBps(v) : (v / 1e6).toFixed(1) + ' Mbps'); }
  function sv(tag, attrs, parent) { const x = svgEl(tag, attrs); if (parent) parent.appendChild(x); return x; }
  function part(box, sig, fn) {                                 // só refaz o bloco se algo mudou
    if (box.dataset.sig === sig) return; box.dataset.sig = sig; box.replaceChildren.apply(box, [].concat(fn()).filter(Boolean));
  }
  function wanName() { return (typeof MK_PORT_ORDER !== 'undefined' && MK_PORT_ORDER[0]) || 'ether1'; }

  // -------------------------------------------------------------------- dados
  function refreshData(force) {
    if (force) Object.keys(last).forEach(function (k) { last[k] = 0; });
    return Promise.all([
      every('spark', 8000, async function () { D.spark = await apiJSON('GET', '/api/sparklines'); }),
      every('targets', 15000, async function () { D.targetsInfo = await apiJSON('GET', '/api/targets'); }),
      every('topo', 15000, async function () { D.topo = await apiJSON('GET', '/api/topology'); }),
      every('res', 30000, async function () { D.res = await apiJSON('GET', '/api/incidents?days=1'); }),
      every('certs', 60000, async function () { D.certs = await apiJSON('GET', '/api/certs'); }),
      every('mk', 8000, async function () {
        const st = await apiJSON('GET', '/api/mikrotik/status');
        D.mk = st && st.enabled && st.board_name ? st : null;
        D.ifaces = D.mk ? await apiJSON('GET', '/api/mikrotik/interfaces') : null;
        if (D.mk && !D.histLoaded) {
          D.histLoaded = true;
          try { const hh = await apiJSON('GET', '/api/mikrotik/history?range=1h&iface=' + encodeURIComponent(wanName())); D.hist = (hh.points || []).slice(-120).map(function (p) { return [p.rx_bps || 0, p.tx_bps || 0]; }); } catch (e) { /* sem histórico */ }
        }
        if (D.mk) pushTraffic();
      }),
      every('agh', 30000, async function () {
        const st = await apiJSON('GET', '/api/agh/status');
        if (!st || !st.enabled) { D.agh = null; return; }
        const stats = await apiJSON('GET', '/api/agh/stats').catch(function () { return {}; });
        const top = await apiJSON('GET', '/api/agh/top').catch(function () { return null; });
        D.agh = {st: st, stats: stats || {}, top: top};
      }),
      every('zbx', 30000, async function () { const z = await apiJSON('GET', '/api/zabbix/problems'); D.zbx = z && z.enabled ? z : null; }),
      every('lat24', 60000, async function () { D.lat24 = await apiJSON('GET', '/api/history/24h'); }),
      every('speed', 120000, async function () { D.speed = await apiJSON('GET', '/api/speedtest/history?limit=8'); }),
      every('sites', 20000, async function () { D.sites = await apiJSON('GET', '/api/sites'); }),
      every('sla', 300000, async function () {
        const d = new Date(), m = d.getFullYear() + '-' + pad(d.getMonth() + 1);
        D.sla = await apiJSON('GET', '/api/sla?month=' + m);
      })
    ]);
  }
  function pushTraffic() {
    const w = (D.ifaces || []).filter(function (r) { return r.name === wanName(); })[0]; if (!w) return;
    D.hist = D.hist || []; D.hist.push([w.rx_bps || 0, w.tx_bps || 0]); if (D.hist.length > 120) D.hist.shift();
  }

  // ------------------------------------------------------------------- modelo
  function targetState(n, t, incs) {
    if (!t || t.online == null) return 'na';
    if (t.online === false) return 'bad';
    if ((t.loss_pct || 0) >= 5 || incs.some(function (i) { return i.target === n; })) return 'warn';
    return 'ok';
  }
  function tone(v) { return v == null ? 'na' : v >= 90 ? 'ok' : v >= 70 ? 'warn' : 'bad'; }
  function model() {
    const s = snap(), o = s.overview || {}, ts = o.targets || {};
    const incs = (s.incidents || []).filter(function (i) { return i.severity !== 'Info'; });
    const names = Object.keys(ts).sort(), st = {};
    names.forEach(function (n) { st[n] = targetState(n, ts[n], incs); });
    const known = names.filter(function (n) { return st[n] !== 'na'; });
    const pts = {ok: 100, warn: 60, bad: 0};
    const links = known.length ? known.reduce(function (a, n) { return a + pts[st[n]]; }, 0) / known.length : null;
    const ups = (D.targetsInfo || []).map(function (t) { return t.uptime_24h; }).filter(function (v) { return typeof v === 'number'; });
    const disp = ups.length ? ups.reduce(function (a, b) { return a + b; }, 0) / ups.length : null;
    const lat = o.avg_latency != null ? clamp(100 - Math.max(0, o.avg_latency - 50) / 250 * 100, 0, 100) : null;
    const hi = incs.filter(function (i) { return i.severity === 'Alta'; }).length, mid = incs.filter(function (i) { return i.severity === 'Media'; }).length;
    const inc = clamp(100 - hi * 25 - mid * 10 - (incs.length - hi - mid) * 3, 0, 100);
    const parts = [[disp, 30], [links, 30], [lat, 15], [inc, 25]].filter(function (p) { return p[0] != null; });
    const wsum = parts.reduce(function (a, p) { return a + p[1]; }, 0);
    const score = known.length && wsum ? Math.round(parts.reduce(function (a, p) { return a + p[0] * p[1]; }, 0) / wsum) : null;
    const internet = o.internet_online === false ? 0 : (o.avg_loss_pct != null ? clamp(100 - o.avg_loss_pct, 0, 100) : null);
    const hw = [];
    if (D.mk) { let e = 100; if (D.mk.stale) e -= 40; if (D.mk.cpu_load >= 80) e -= 25; else if (D.mk.cpu_load >= 60) e -= 10; if (D.mk.temperature >= 75) e -= 25; else if (D.mk.temperature >= 65) e -= 10; if (D.mk.mem_pct >= 90) e -= 15; hw.push(clamp(e, 0, 100)); }
    const cpu = num(o.cpu_pct), mem = num(o.mem_pct), tmp = num(o.temp_c);
    if (cpu != null || mem != null || tmp != null) { let e = 100; if (cpu >= 90) e -= 30; else if (cpu >= 70) e -= 10; if (tmp >= 80) e -= 30; else if (tmp >= 70) e -= 10; if (mem >= 90) e -= 15; hw.push(clamp(e, 0, 100)); }
    return {o: o, ts: ts, names: names, st: st, incs: incs, score: score, links: links, disp: disp, internet: internet, equip: hw.length ? Math.min.apply(null, hw) : null};
  }

  // ----------------------------------------------------------------- componentes
  function flat(a) { return [].concat.apply([], a.map(function (x) { return Array.isArray(x) ? flat(x) : [x]; })).filter(function (x) { return x != null && x !== false; }); }
  function card(cls) { return h('section', {class: 'tv-card' + (cls ? ' ' + cls : '')}, flat([].slice.call(arguments, 1))); }
  function lab(t, cls) { return h('div', {class: 'tv-lab' + (cls ? ' ' + cls : ''), text: t}); }
  function kpi(label, big, cls, sub, tile) {
    return h('div', {class: 'tv-kpi ' + tile}, h('span', {text: label}), h('b', {class: cls || '', text: big}), sub ? h('small', {text: sub}) : null);
  }
  function meter(label, v, unit, warn, bad) {
    const n = num(v), t = n == null ? 'na' : n >= bad ? 'bad' : n >= warn ? 'warn' : 'ok';
    return h('div', {class: 'tv-meter'}, h('div', {class: 'tv-meter-h'}, h('span', {text: label}), h('b', {class: 'c-' + t, text: n == null ? '–' : (Math.round(n * 10) / 10) + unit})),
      h('div', {class: 'tv-bar'}, h('i', {class: 'bg-' + t, style: {width: (n == null ? 0 : clamp(n, 0, 100)) + '%'}})));
  }
  function lineSvg(series, cls, w, hh) {
    const s = svgEl('svg', {viewBox: '0 0 ' + w + ' ' + hh, preserveAspectRatio: 'none', class: 'tv-line', 'aria-hidden': 'true'});
    let mx = 1; series.forEach(function (a) { a.forEach(function (v) { if (typeof v === 'number' && v > mx) mx = v; }); });
    series.forEach(function (a, k) {
      if (a.length < 2) return;
      const step = w / (a.length - 1), pts = a.map(function (v, i) { return (i * step).toFixed(1) + ',' + ((hh - 4) - (v || 0) / mx * (hh - 10)).toFixed(1); });
      if (k === 0 && cls === 'area') {
        const g = sv('linearGradient', {id: 'tvla', x1: 0, y1: 0, x2: 0, y2: 1}, sv('defs', {}, s));
        sv('stop', {offset: 0, 'stop-color': '#35e0ff', 'stop-opacity': '.35'}, g); sv('stop', {offset: 1, 'stop-color': '#35e0ff', 'stop-opacity': 0}, g);
        sv('polygon', {points: '0,' + hh + ' ' + pts.join(' ') + ' ' + w + ',' + hh, fill: 'url(#tvla)'}, s);
      }
      sv('polyline', {points: pts.join(' '), fill: 'none', class: 'tv-ln tv-ln' + k, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke'}, s);
    });
    return s;
  }

  // --------------------------------------------------------------- cena 1: visão geral
  function ringSvg(m) {
    const t = tone(m.score), C = 2 * Math.PI * 170, C2 = 2 * Math.PI * 136;
    const grad = {ok: ['#35e0ff', '#3ef0a5'], warn: ['#ffb020', '#ffd36b'], bad: ['#ff4d5e', '#ff8a5c'], na: ['#7d8aa8', '#7d8aa8']}[t];
    const s = svgEl('svg', {viewBox: '0 0 400 400', 'aria-hidden': 'true'});
    const g = sv('linearGradient', {id: 'tvrg', x1: 0, x2: 1}, sv('defs', {}, s));
    sv('stop', {offset: 0, 'stop-color': grad[0]}, g); sv('stop', {offset: 1, 'stop-color': grad[1]}, g);
    sv('circle', {cx: 200, cy: 200, r: 170, fill: 'none', class: 'tv-track', 'stroke-width': 22}, s);
    sv('circle', {cx: 200, cy: 200, r: 170, fill: 'none', stroke: 'url(#tvrg)', 'stroke-width': 22, 'stroke-linecap': 'round', 'stroke-dasharray': (C * (m.score || 0) / 100).toFixed(1) + ' ' + C.toFixed(1), transform: 'rotate(-90 200 200)'}, s);
    sv('circle', {cx: 200, cy: 200, r: 136, fill: 'none', class: 'tv-track2', 'stroke-width': 5}, s);
    sv('circle', {cx: 200, cy: 200, r: 136, fill: 'none', class: 'c-stroke-' + tone(m.links), 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-dasharray': (C2 * (m.links || 0) / 100).toFixed(1) + ' ' + C2.toFixed(1), transform: 'rotate(-90 200 200)', opacity: '.85'}, s);
    return s;
  }
  const RING = [[0, 50], [5, 160], [20, 270], [50, 350], [100, 410]];
  function rad(ms) {
    if (ms == null) return 190;
    if (ms >= 100) return Math.min(430, 410 + (ms - 100) / 50 * 20);
    for (let i = 1; i < RING.length; i++) if (ms <= RING[i][0]) { const a = RING[i - 1], b = RING[i]; return a[1] + (ms - a[0]) / (b[0] - a[0]) * (b[1] - a[1]); }
    return 400;
  }
  function radarSvg(m) {
    const CX = 550, CY = 440, s = svgEl('svg', {viewBox: '0 0 1100 880', class: 'tv-radar', role: 'img', 'aria-label': 'Radar de latência'});
    const defs = sv('defs', {}, s), rg = sv('radialGradient', {id: 'tvsw', cx: 0, cy: 0, r: 1}, defs);
    sv('stop', {offset: 0, 'stop-color': '#35e0ff', 'stop-opacity': 0}, rg); sv('stop', {offset: 1, 'stop-color': '#35e0ff', 'stop-opacity': '.28'}, rg);
    [160, 270, 350, 410].forEach(function (r, i) {
      sv('circle', {cx: CX, cy: CY, r: r, fill: 'none', class: 'tv-rring', 'stroke-dasharray': i ? '4 8' : '0'}, s);
      const t = sv('text', {x: CX + r + 6, y: CY - 6, class: 'tv-rmut', 'font-size': 16}, s); t.textContent = [5, 20, 50, 100][i] + ' ms';
    });
    if (!reduced) {
      const sw = sv('path', {d: 'M' + CX + ',' + CY + ' L' + (CX + 400) + ',' + CY + ' A400,400 0 0 0 ' + (CX + 400 * Math.cos(-0.5)) + ',' + (CY + 400 * Math.sin(-0.5)) + ' Z', fill: 'url(#tvsw)'}, s);
      sv('animateTransform', {attributeName: 'transform', type: 'rotate', from: '0 ' + CX + ' ' + CY, to: '360 ' + CX + ' ' + CY, dur: '9s', repeatCount: 'indefinite'}, sw);
    }
    const n = m.names.length;
    m.names.forEach(function (name, i) {
      const t = m.ts[name] || {}, st = m.st[name];
      const a = (-90 + 20 + i * 360 / Math.max(n, 1)) * Math.PI / 180, r = st === 'bad' ? 365 : st === 'na' ? 240 : rad(t.latency) + (i % 2) * 55;
      const x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
      sv('line', {x1: CX, y1: CY, x2: x, y2: y, class: 'tv-rl c-stroke-' + st, 'stroke-opacity': st === 'na' ? .15 : .4, 'stroke-width': 2, 'stroke-dasharray': st === 'bad' ? '6 7' : '0'}, s);
      if ((st === 'ok' || st === 'warn') && !reduced) {
        const secs = clamp(2 + (t.latency || 20) / 25, 2, 7);
        [0, 1].forEach(function (k) {
          const d = sv('circle', {r: 3.5, class: 'c-fill-' + st}, s);
          sv('animateMotion', {dur: secs + 's', begin: (-k * secs / 2) + 's', repeatCount: 'indefinite', path: 'M' + CX + ',' + CY + ' L' + x.toFixed(1) + ',' + y.toFixed(1)}, d);
        });
      }
      if (st === 'bad') [30, 46].forEach(function (rr, k) { sv('circle', {cx: x, cy: y, r: rr, fill: 'none', class: 'c-stroke-bad', 'stroke-opacity': .5 - k * .25}, s); });
      sv('circle', {cx: x, cy: y, r: 13, class: 'tv-rnode c-stroke-' + st, 'stroke-width': 4}, s);
      const right = x >= CX, tx = right ? x + 26 : x - 26, an = right ? 'start' : 'end';
      const l1 = sv('text', {x: tx, y: y - 2, 'text-anchor': an, class: 'tv-rname', 'font-size': 24}, s); l1.textContent = name;
      const l2 = sv('text', {x: tx, y: y + 24, 'text-anchor': an, class: 'c-fill-' + st, 'font-size': 20, 'font-family': 'monospace'}, s);
      l2.textContent = st === 'bad' ? 'offline' : st === 'na' ? 'sem dados' : (t.latency != null ? t.latency.toFixed(0) + ' ms' : 'ok');
    });
    sv('circle', {cx: CX, cy: CY, r: 26, class: 'tv-rcore', 'stroke-width': 4}, s);
    const tc = sv('text', {x: CX, y: CY + 7, 'text-anchor': 'middle', class: 'tv-rcoret', 'font-size': 18, 'font-weight': 700, 'font-family': 'monospace'}, s); tc.textContent = 'GW';
    return s;
  }
  function incRows(m, max) {
    const rows = [];
    if (!m.incs.length) rows.push(h('div', {class: 'tv-inc g'}, h('i'), h('div', {text: 'Tudo operacional'})));
    m.incs.slice(0, max).forEach(function (i) {
      rows.push(h('div', {class: 'tv-inc ' + (i.severity === 'Alta' ? 'r' : 'a')}, h('i'),
        h('div', {text: i.target && String(i.message || '').indexOf(i.target) < 0 ? i.target + ' — ' + i.message : String(i.message || '')}),
        h('span', {'data-started': String(i.started_ts), text: dur(Date.now() / 1000 - i.started_ts)})));
    });
    if (m.incs.length > max) rows.push(h('div', {class: 'tv-more', text: '+ ' + (m.incs.length - max) + ' outros'}));
    return rows;
  }
  const scene1 = {
    build: function () {
      const el = {ring: h('div', {class: 'tv-ringbox'}), subs: h('div', {class: 'tv-subs'}), radar: h('div', {class: 'tv-radarbox'}), kpis: h('div', {class: 'tv-kcol'}), inc: card('tv-flex')};
      el.num = h('div', {class: 'tv-score'});
      this.el = el;
      return h('div', {class: 'tv-s1'},
        card('tv-health', lab('Saúde da rede'), h('div', {class: 'tv-ringwrap'}, el.ring, el.num), el.subs),
        card('tv-radarcard', lab('Radar de latência'), el.radar), h('div', {class: 'tv-right'}, el.kpis, el.inc));
    },
    update: function () {
      const m = model(), e = this.el, t = tone(m.score), o = m.o;
      part(e.ring, 'r' + m.score + t + Math.round(m.links || 0), function () { return ringSvg(m); });
      part(e.num, 's' + m.score + t, function () { return h('div', {}, h('b', {class: 'c-' + t, text: m.score == null ? '–' : String(m.score)}), h('small', {class: 'c-' + t, text: {ok: 'OPERACIONAL', warn: 'ATENÇÃO', bad: 'CRÍTICO', na: 'SEM DADOS'}[t]})); });
      part(e.subs, 'u' + [m.internet, m.disp, m.equip].map(function (v) { return v == null ? 'n' : Math.round(v * 10); }).join(','), function () {
        function sub(l, v, dec) { return h('div', {class: 'tv-sub'}, h('span', {text: l}), h('b', {class: 'c-' + tone(v), text: v == null ? '–' : (dec ? v.toFixed(1) : String(Math.round(v)))})); }
        return [sub('INTERNET', m.internet), sub('DISP. 24H', m.disp, true), sub('EQUIP.', m.equip)];
      });
      part(e.radar, 'd' + m.names.map(function (n) { const t2 = m.ts[n] || {}; return n + m.st[n] + Math.round(t2.latency || 0); }).join('|'), function () { return radarSvg(m); });
      const on = o.internet_online, lat = o.avg_latency, loss = o.avg_loss_pct;
      part(e.kpis, 'k' + on + (o.public_ip || '') + Math.round(lat || 0) + (loss || 0) + (o.speedtest ? o.speedtest.download : ''), function () {
        return [
          kpi('Status da internet', on == null ? '–' : on ? 'ONLINE' : 'OFFLINE', '', o.speedtest && o.speedtest.download ? '↓ ' + Math.round(o.speedtest.download) + ' · ↑ ' + Math.round(o.speedtest.upload) + ' Mbps no último teste' : null, on === false ? 't-bad' : on ? 't-ok' : 't-na'),
          kpi('IP público', o.public_ip || '–', 'tv-ipv', o.public_ipv6 ? 'IPv6 ativo' : null, 't-blue'),
          h('div', {class: 'tv-krow'}, kpi('Latência', lat != null ? lat.toFixed(0) + ' ms' : '–', '', o.avg_jitter != null ? 'jitter ' + o.avg_jitter.toFixed(1) + ' ms' : null, lat == null ? 't-na' : lat > 100 ? 't-bad' : lat > 50 ? 't-warn' : 't-ok'),
            kpi('Perda', loss != null ? loss.toFixed(1) + '%' : '–', '', null, loss == null ? 't-na' : loss > 5 ? 't-bad' : loss > 1 ? 't-warn' : 't-ok'))
        ];
      });
      const rs = (D.res || []).filter(function (i) { return i.resolved_ts; }).slice(0, 2);
      part(e.inc, 'i' + m.incs.map(function (i) { return i.id; }).join(',') + '|' + rs.map(function (i) { return i.id; }).join(','), function () {
        const rows = [lab('Incidentes ativos')].concat(incRows(m, 4));
        if (rs.length) { rows.push(lab('Resolvidos hoje', 'tv-gap')); rs.forEach(function (i) { rows.push(h('div', {class: 'tv-inc g'}, h('i'), h('div', {text: (i.target ? i.target + ' — ' : '') + i.message}), h('span', {text: fmtDur(i.resolved_ts - i.started_ts)}))); }); }
        return rows;
      });
    }
  };

  // --------------------------------------------------------------- cena 2: topologia
  function treeModel() {
    const T = D.topo || {nodes: [], edges: []}, m = model(), nodes = T.nodes || [], by = {}, kids = {}, par = {};
    nodes.forEach(function (n) { by[n.id] = n; kids[n.id] = []; });
    (T.edges || []).forEach(function (e) { if (by[e.source] && by[e.target] && par[e.target] == null && e.target !== 'internet') { par[e.target] = e.source; kids[e.source].push(e.target); } });
    nodes.forEach(function (n) { if (n.id !== 'internet' && par[n.id] == null && by.internet) { par[n.id] = 'internet'; kids.internet.push(n.id); } });
    Object.keys(kids).forEach(function (k) { kids[k].sort(function (a, b) { return String(by[a].label).localeCompare(String(by[b].label)); }); });
    const st = {};
    nodes.forEach(function (n) {
      if (n.id === 'internet') { st[n.id] = m.o.internet_online === false ? 'bad' : m.o.internet_online == null ? 'na' : 'ok'; return; }
      const t = m.ts[n.id] || {}, on = t.online != null ? t.online : n.online;
      st[n.id] = on == null ? 'na' : on === false ? 'bad' : (((t.loss_pct || 0) >= 5 || m.incs.some(function (i) { return i.target === n.id; })) ? 'warn' : 'ok');
    });
    const iso = {};
    nodes.forEach(function (n) {
      if (st[n.id] !== 'bad' || n.id === 'internet') return;
      let c = par[n.id], cause = null; while (c && c !== 'internet') { if (st[c] === 'bad') cause = c; c = par[c]; }
      if (cause) iso[n.id] = cause;
    });
    Object.keys(iso).forEach(function (id) { st[id] = 'iso'; });
    return {m: m, nodes: nodes, by: by, kids: kids, par: par, st: st, iso: iso};
  }
  function descOf(tm, id, acc) { (tm.kids[id] || []).forEach(function (k) { acc.push(k); descOf(tm, k, acc); }); return acc; }
  const scene2 = {
    build: function () {
      this.chips = h('div', {class: 'tv-chips'}); this.box = h('div', {class: 'tv-treebox'});
      return h('div', {class: 'tv-s2'}, this.chips, card('tv-treecard', this.box));
    },
    update: function () {
      const tm = treeModel(), box = this.box;
      if (!tm.by.internet || tm.nodes.length < 2) { part(box, 'empty', function () { return h('div', {class: 'tv-empty', text: 'Nenhum destino cadastrado.'}); }); return; }
      const ids = tm.nodes.filter(function (n) { return n.id !== 'internet'; }).map(function (n) { return n.id; });
      const c = {bad: 0, iso: 0, warn: 0}; ids.forEach(function (i) { if (c[tm.st[i]] != null) c[tm.st[i]]++; });
      const chips = [h('span', {class: 'tv-chip', text: ids.length + ' EQUIPAMENTOS'})];
      if (c.bad || c.iso) chips.push(h('span', {class: 'tv-chip r', text: (c.bad ? c.bad + ' OFFLINE' : '') + (c.bad && c.iso ? ' · ' : '') + (c.iso ? c.iso + ' ISOLADO' + (c.iso > 1 ? 'S' : '') : '')}));
      if (c.warn) chips.push(h('span', {class: 'tv-chip a', text: c.warn + ' DEGRADADO' + (c.warn > 1 ? 'S' : '')}));
      if (!c.bad && !c.iso && !c.warn) chips.push(h('span', {class: 'tv-chip g', text: 'TUDO OPERACIONAL'}));
      part(this.chips, 'c' + chips.map(function (x) { return x.textContent; }).join('|'), function () { return chips; });
      const sig = tm.nodes.map(function (n) { return n.id + tm.st[n.id] + (tm.iso[n.id] || '') + Math.round(num((tm.m.ts[n.id] || {}).latency) || 0) + (tm.par[n.id] || ''); }).join('|');
      part(box, sig, function () { return drawTree(tm, box); });
    }
  };
  function drawTree(tm, box) {
    const pos = {}, depthOf = {}; let slot = 0, maxD = 0;
    (function walk(id, d) {
      depthOf[id] = d; maxD = Math.max(maxD, d);
      const ks = tm.kids[id] || [];
      if (!ks.length) { pos[id] = slot++; return; }
      ks.forEach(function (k) { walk(k, d + 1); }); pos[id] = (pos[ks[0]] + pos[ks[ks.length - 1]]) / 2;
    })('internet', 0);
    const W = 40 + (maxD + 1) * CW + maxD * GX, H = 40 + Math.max(slot, 1) * (CH + GY);
    const inner = h('div', {class: 'tv-tinner', style: {width: W + 'px', height: H + 'px'}});
    const links = svgEl('svg', {class: 'tv-tlinks', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true'});
    inner.appendChild(links);
    function xy(id) { return {x: 20 + depthOf[id] * (CW + GX), y: 20 + pos[id] * (CH + GY)}; }
    Object.keys(pos).forEach(function (id) {
      (tm.kids[id] || []).forEach(function (k) {
        const a = xy(id), b = xy(k), x1 = a.x + CW, y1 = a.y + CH / 2, x2 = b.x, y2 = b.y + CH / 2, mx = (x1 + x2) / 2, st = tm.st[k];
        const d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
        sv('path', {d: d, fill: 'none', class: 'tv-tl c-stroke-' + st + (st === 'bad' || st === 'iso' ? ' dash' : ''), 'stroke-width': id === 'internet' ? 4 : 3}, links);
        if ((st === 'ok' || st === 'warn') && !reduced) { const c = sv('circle', {r: 4, class: 'c-fill-' + st}, links); sv('animateMotion', {dur: '3.2s', repeatCount: 'indefinite', path: d}, c); }
      });
    });
    Object.keys(pos).forEach(function (id) {
      const n = tm.by[id], p = xy(id), s = tm.st[id], t = tm.m.ts[id] || {};
      const val = id === 'internet' ? (tm.m.o.avg_latency != null ? Math.round(tm.m.o.avg_latency) + ' ms' : '—') : s === 'bad' ? 'OFFLINE' : (s === 'iso' || s === 'na') ? '—' : (t.latency != null ? Math.round(t.latency) + ' ms' : 'OK');
      inner.appendChild(h('div', {class: 'tv-tn ' + s, style: {left: p.x + 'px', top: p.y + 'px'}},
        s === 'bad' ? h('span', {class: 'tv-tag', text: 'OFFLINE'}) : null,
        s === 'iso' ? h('span', {class: 'tv-tag i', text: 'ISOLADO POR ' + String(tm.iso[id]).toUpperCase()}) : null,
        h('div', {class: 'tv-tt', text: n.label}), h('div', {class: 'tv-tip', text: id === 'internet' ? (tm.m.o.public_ip || '') : (n.host || '')}),
        h('b', {text: val})));
    });
    requestAnimationFrame(function () {
      const cw = box.clientWidth, ch = box.clientHeight; if (!cw || !ch) return;
      const k = Math.min(cw / W, ch / H, 1.5);
      inner.style.transform = 'scale(' + k + ')'; inner.style.left = Math.max(0, (cw - W * k) / 2) + 'px'; inner.style.top = Math.max(0, (ch - H * k) / 2) + 'px';
    });
    return inner;
  }

  // --------------------------------------------------------------- cena 3: equipamentos
  function photo() {
    const img = document.querySelector('.mk-panel-img'); if (!img || !img.src) return null;
    const by = {}; (D.ifaces || []).forEach(function (r) { by[r.name] = r; });
    const order = (typeof MK_PORT_ORDER !== 'undefined') ? MK_PORT_ORDER : ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'];
    const w = h('div', {class: 'tv-photo'}, h('img', {src: img.src, alt: 'MikroTik'}));
    PORT_POS.forEach(function (left, i) { const r = by[order[i]]; w.appendChild(h('i', {class: 'tv-port ' + (r ? (r.running ? 'on' : 'off') : ''), style: {left: left + '%'}})); });
    return w;
  }
  const scene3 = {
    build: function () { this.grid = h('div', {class: 'tv-s3'}); this.cards = {}; return this.grid; },
    update: function () {
      const o = snap().overview || {}, list = [];
      list.push(['pi', 'p' + [o.cpu_pct, o.mem_pct, o.temp_c].join(','), function () {
        return card('', lab('Raspberry Pi · servidor'), h('div', {class: 'tv-meters'}, meter('CPU', o.cpu_pct, '%', 70, 90), meter('Memória', o.mem_pct, '%', 80, 90), meter('Temperatura', o.temp_c, '°C', 65, 80)));
      }]);
      const mk = D.mk;
      if (mk) {
        const w = (D.ifaces || []).filter(function (r) { return r.name === wanName(); })[0], hist = D.hist || [];
        list.push(['mk', 'm' + [mk.cpu_load, mk.mem_pct, mk.temperature, w && w.rx_bps, w && w.tx_bps, (D.ifaces || []).map(function (r) { return r.running ? 1 : 0; }).join('')].join(','), function () {
          return card('', lab('MikroTik ' + (mk.board_name || '') + ' · RouterOS ' + String(mk.version || '').split(' ')[0]), photo(),
            h('div', {class: 'tv-rxtx'}, h('span', {}, '↓ ', h('b', {class: 'c-ok', text: bps(w && w.rx_bps)})), h('span', {}, '↑ ', h('b', {class: 'c-blue', text: bps(w && w.tx_bps)}))),
            hist.length > 1 ? lineSvg([hist.map(function (p) { return p[0]; }), hist.map(function (p) { return p[1]; })], 'plain', 300, 80) : null,
            h('div', {class: 'tv-meters tv-m3'}, meter('CPU', mk.cpu_load, '%', 60, 80), meter('Memória', mk.mem_pct, '%', 80, 90), meter('Temp.', mk.temperature, '°C', 65, 75)),
            h('div', {class: 'tv-small', text: 'Uptime ' + (mk.uptime_s != null ? fmtDur(mk.uptime_s) : '–')}));
        }]);
      }
      const ag = D.agh;
      if (ag) {
        const s = ag.stats || {}, top = ag.top && ag.top.blocked ? ag.top.blocked.slice(0, 3) : [];
        list.push(['agh', 'a' + [s.num_dns_queries, s.num_blocked_filtering, ag.st.online, top.map(function (x) { return x.name + x.count; }).join('')].join(','), function () {
          return card('', lab('AdGuard Home' + (ag.st.version ? ' · ' + ag.st.version : '')),
            h('div', {class: 'tv-agrid'}, h('div', {}, h('span', {class: 'tv-lab', text: 'Consultas'}), h('b', {text: s.num_dns_queries != null ? Number(s.num_dns_queries).toLocaleString('pt-BR') : '–'})),
              h('div', {}, h('span', {class: 'tv-lab', text: 'Bloqueadas'}), h('b', {class: 'c-bad', text: s.num_blocked_filtering != null ? Number(s.num_blocked_filtering).toLocaleString('pt-BR') : '–'}))),
            meter('% de bloqueio', s.blocked_pct, '%', 101, 102),
            top.length ? lab('Top bloqueados', 'tv-gap') : null,
            top.map(function (x) { return h('div', {class: 'tv-inc g'}, h('i'), h('div', {text: x.name}), h('span', {text: Number(x.count).toLocaleString('pt-BR')})); }),
            h('div', {class: 'tv-small', text: !ag.st.online ? 'AdGuard fora do ar' : 'Proteção ' + (ag.st.protection_enabled ? 'ativa' : 'DESATIVADA')}));
        }]);
      }
      const z = D.zbx;
      if (z) {
        const ps = (z.problems || []).slice(0, 5);
        list.push(['zbx', 'z' + ps.map(function (p) { return p.eventid || p.name; }).join(','), function () {
          return card('', lab('Zabbix · problemas'), ps.length ? ps.map(function (p) { return h('div', {class: 'tv-inc ' + (Number(p.severity) >= 4 ? 'r' : 'a')}, h('i'), h('div', {text: (p.host ? p.host + ' — ' : '') + p.name})); })
            : h('div', {class: 'tv-allok', text: '✔ Nenhum problema ativo'}));
        }]);
      }
      this.grid.className = 'tv-s3 n' + list.length;
      const want = list.map(function (x) { return x[0]; }).join(',');
      if (this.order !== want) { this.order = want; this.cards = {}; this.grid.replaceChildren(); }
      list.forEach(function (x) {
        let slot = this.cards[x[0]];
        if (!slot) { slot = this.cards[x[0]] = h('div', {class: 'tv-slot'}); this.grid.appendChild(slot); }
        part(slot, x[1], x[2]);
      }, this);
    }
  };

  // --------------------------------------------------------------- cena 4: 24 h
  const scene4 = {
    build: function () {
      this.a = h('div', {class: 'tv-slot'}); this.b = h('div', {class: 'tv-slot'}); this.c = h('div', {class: 'tv-slot'});
      return h('div', {class: 'tv-s4'}, this.a, this.b, this.c);
    },
    update: function () {
      const pts = (D.lat24 || []).map(function (p) { return p.latency; }).filter(function (v) { return typeof v === 'number'; });
      const sp = (D.speed || []).slice().reverse();
      part(this.a, 'l' + pts.length + Math.round(pts[pts.length - 1] || 0) + (sp[sp.length - 1] ? sp[sp.length - 1].ts : ''), function () {
        const avg = pts.length ? pts.reduce(function (x, y) { return x + y; }, 0) / pts.length : null;
        const f = function (v) { return v == null ? '–' : v.toFixed(1) + ' ms'; };
        const top = Math.max.apply(null, sp.map(function (x) { return Math.max(x.download || 0, x.upload || 0); }).concat([1]));
        const lastS = sp[sp.length - 1];
        return card('', lab('Latência da internet · 24 h'), pts.length > 1 ? lineSvg([pts], 'area', 320, 100) : h('div', {class: 'tv-empty', text: 'Sem histórico ainda.'}),
          pts.length ? h('div', {class: 'tv-stats3'}, h('span', {}, 'mín ', h('b', {text: f(Math.min.apply(null, pts))})), h('span', {}, 'média ', h('b', {text: f(avg)})), h('span', {}, 'máx ', h('b', {text: f(Math.max.apply(null, pts))}))) : null,
          lastS ? lab('Speedtest · ↓ ' + (lastS.download || 0).toFixed(0) + ' / ↑ ' + (lastS.upload || 0).toFixed(0) + ' Mbps', 'tv-gap') : null,
          sp.length ? h('div', {class: 'tv-spd'}, sp.map(function (x) { return h('div', {}, h('i', {class: 'd', style: {height: ((x.download || 0) / top * 100) + '%'}}), h('i', {class: 'u', style: {height: ((x.upload || 0) / top * 100) + '%'}})); })) : null);
      });
      const sla = ((D.sla && D.sla.targets) || []).filter(function (t) { return t.availability_pct != null; }).sort(function (x, y) { return x.availability_pct - y.availability_pct; }).slice(0, 9);
      part(this.b, 's' + sla.map(function (t) { return t.target + t.availability_pct; }).join('|'), function () {
        return card('', lab('SLA do mês · meta ' + GOAL.toString().replace('.', ',') + '%'), sla.length ? sla.map(function (t) {
          const ok = t.availability_pct >= GOAL;
          return h('div', {class: 'tv-sla'}, h('span', {text: t.target}), h('b', {class: ok ? 'c-ok' : t.availability_pct >= 99 ? 'c-warn' : 'c-bad', text: t.availability_pct.toFixed(2).replace('.', ',') + '%'}),
            h('div', {class: 'tv-bar'}, h('i', {class: ok ? 'bg-ok' : t.availability_pct >= 99 ? 'bg-warn' : 'bg-bad', style: {width: clamp(t.availability_pct, 0, 100) + '%'}})));
        }) : h('div', {class: 'tv-empty', text: 'Sem dados do mês.'}));
      });
      const sl = (D.sites && D.sites.sites) || [], certs = D.certs || {}, ck = Object.keys(certs).filter(function (k) { return typeof certs[k] === 'number'; }).sort(function (x, y) { return certs[x] - certs[y]; }).slice(0, 4);
      part(this.c, 'x' + sl.map(function (x) { return x.site + x.online; }).join(',') + ck.map(function (k) { return k + Math.floor(certs[k]); }).join(','), function () {
        const out = [lab('Sites remotos' + (sl.length ? ' · ' + sl.length : ''))];
        if (sl.length) sl.forEach(function (x) { out.push(h('div', {class: 'tv-inc ' + (x.online ? 'g' : 'r')}, h('i'), h('div', {text: x.site}), h('span', {text: x.online ? 'online' : 'mudo há ' + Math.round((Date.now() / 1000 - x.last_seen) / 60) + ' min'}))); });
        else out.push(h('div', {class: 'tv-empty', text: 'Nenhum agente cadastrado.'}));
        if (ck.length) { out.push(lab('Certificados HTTPS', 'tv-gap')); ck.forEach(function (k) { const d = Math.floor(certs[k]); out.push(h('div', {class: 'tv-inc ' + (d < 15 ? 'r' : d < 30 ? 'a' : 'g')}, h('i'), h('div', {text: k}), h('span', {text: d < 0 ? 'VENCIDO' : d + ' dias'}))); }); }
        return card('', out);
      });
    }
  };
  const SC = {1: scene1, 2: scene2, 3: scene3, 4: scene4};

  // ----------------------------------------------------------------------- alerta
  function beep() {
    if (!sound) return;
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      const c = new A(), o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start(); setTimeout(function () { o.stop(); c.close(); }, 450);
    } catch (e) { /* sem áudio */ }
  }
  function showToast(text) {
    if (!root) return;
    toast.textContent = text; toast.classList.add('on'); clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toast) toast.classList.remove('on'); }, 10000); beep();
  }
  function checkEvents() {
    const s = snap(), list = (s.incidents || []).filter(function (i) { return i.severity !== 'Info'; }), ids = new Set(list.map(function (i) { return i.id; }));
    if (seen) list.forEach(function (i) { if (!seen.has(i.id) && i.severity !== 'Alta') showToast('▼ NOVO INCIDENTE — ' + (i.target ? i.target + ': ' : '') + i.message); });
    seen = ids;
    const by = {}; (D.ifaces || []).forEach(function (r) { by[r.name] = r; });
    const order = (typeof MK_PORT_ORDER !== 'undefined') ? MK_PORT_ORDER : [], now = order.map(function (n) { return by[n] ? !!by[n].running : null; });
    if (prevPorts) now.forEach(function (st, i) { if (prevPorts[i] === true && st === false) showToast('▼ PORTA ' + order[i] + ' SEM LINK'); });
    prevPorts = now;
  }
  function activeAlerts() {
    return (snap().incidents || []).filter(function (i) { return i.severity === 'Alta' && !dismissed.has(i.id); }).sort(function (a, b) { return a.started_ts - b.started_ts; });
  }
  function renderAlert() {
    const al = activeAlerts();
    if (!al.length) { if (alertId != null) { alertId = null; alertEl.classList.remove('on'); root.classList.remove('alerting'); alertEl.replaceChildren(); sceneStart = Date.now(); schedule(); } return; }
    const main = al[0], key = al.map(function (i) { return i.id; }).join(',') + '|' + Math.round(((D.targetsInfo || []).length));
    if (alertEl.dataset.sig === key && alertEl.classList.contains('on')) return;
    const isNew = alertId == null || al.some(function (i) { return i.id > alertId; });
    alertEl.dataset.sig = key; alertId = Math.max.apply(null, al.map(function (i) { return i.id; }));
    const tm = treeModel(), id = main.target, desc = id && tm.by[id] ? descOf(tm, id, []) : [], iso = desc.filter(function (k) { return tm.st[k] === 'iso' || tm.st[k] === 'bad'; });
    const info = (D.targetsInfo || []).filter(function (t) { return t.name === id; })[0], node = id && tm.by[id];
    alertEl.replaceChildren(h('div', {class: 'tv-ab'}),
      h('div', {class: 'tv-abody'},
        h('span', {class: 'tv-badge', text: '⚠ ALERTA CRÍTICO'}),
        h('h1', {text: id || 'Rede'}),
        h('p', {text: (id && String(main.message || '').indexOf(id) === 0 ? String(main.message).slice(id.length).trim() : String(main.message || '')) + (node && node.host ? ' · ' + node.host : '')}),
        h('div', {class: 'tv-atimer', 'data-started': String(main.started_ts), text: dur(Date.now() / 1000 - main.started_ts)}),
        h('div', {class: 'tv-aimp'},
          h('div', {}, h('span', {text: 'IMPACTO'}), h('b', {text: iso.length ? iso.length + ' equipamento' + (iso.length > 1 ? 's' : '') + ' isolado' + (iso.length > 1 ? 's' : '') : desc.length ? desc.length + ' dependente' + (desc.length > 1 ? 's' : '') : 'sem dependentes'}),
            iso.length ? h('small', {text: iso.slice(0, 3).map(function (k) { return tm.by[k].label; }).join(', ')}) : null),
          h('div', {}, h('span', {text: 'SEVERIDADE'}), h('b', {text: main.severity}), h('small', {text: 'desde ' + hhmm(main.started_ts)})),
          h('div', {}, h('span', {text: 'UPTIME 24 H'}), h('b', {text: info && typeof info.uptime_24h === 'number' ? info.uptime_24h.toFixed(0) + '%' : '–'}))),
        al.length > 1 ? h('div', {class: 'tv-aother'}, 'Outros alertas: ', al.slice(1, 4).map(function (i) { return h('b', {text: (i.target || i.message)}); }), al.length > 4 ? ' +' + (al.length - 4) : '') : null),
      h('div', {class: 'tv-afoot', text: 'ROTAÇÃO PAUSADA ENQUANTO HOUVER ALERTA · A = DISPENSAR · VOLTA SOZINHA AO RESOLVER'}));
    alertEl.classList.add('on'); root.classList.add('alerting'); clearTimeout(timer);
    if (isNew) beep();
  }

  // --------------------------------------------------------------- cenas / rotação
  function enabledScenes() { return cfg.scenes.slice().sort(); }
  function goScene(key) {
    sceneKey = key; scene = SC[key];
    const node = scene.build.call(scene); stage.replaceChildren(node); scene.order = null;
    stage.className = 'tv-stage s' + key;
    nameEl.textContent = 'CENA ' + (enabledScenes().indexOf(key) + 1) + '/' + enabledScenes().length + ' · ' + SCENES.filter(function (x) { return x[0] === key; })[0][1];
    dotsEl.replaceChildren.apply(dotsEl, enabledScenes().map(function (k) { return h('i', {class: k === key ? 'on' : '', title: SCENES[k - 1][1], onclick: function () { goScene(k); schedule(); }}); }));
    const on = dotsEl.querySelector('.on'); if (on) { on.style.setProperty('--secs', (cfg.secs || 0) + 's'); }
    sceneStart = Date.now();
    scene.update.call(scene);
  }
  function step(d) {
    const l = enabledScenes(), i = Math.max(0, l.indexOf(sceneKey)); goScene(l[(i + d + l.length) % l.length]); schedule();
  }
  function schedule() {
    clearTimeout(timer); dotsEl.classList.toggle('run', !paused && cfg.secs > 0 && alertId == null);
    if (paused || !cfg.secs || alertId != null) return;
    timer = setTimeout(function () { step(1); }, cfg.secs * 1000);
  }
  function refreshAll() { refreshData(false).then(function () { if (root) onData(); }); }
  function onData() { if (scene) scene.update.call(scene); checkEvents(); renderAlert(); renderStatus(); }
  function onSnap() {
    if (!root) return;
    refreshAll();
    if (Date.now() - snapAt < 1500) return; snapAt = Date.now();
    onData();
  }
  function renderStatus() {
    const s = snap(), age = s.ts ? Date.now() / 1000 - s.ts : null, fresh = age != null && age < 30;
    root.querySelector('.tv-live').className = 'tv-live ' + (fresh ? 'ok' : 'bad'); root.querySelector('.tv-live').textContent = fresh ? 'AO VIVO' : 'DADOS ATRASADOS';
  }
  function clockTick() {
    if (!root) return;
    const d = new Date();
    clockEl.replaceChildren(h('b', {text: d.toLocaleTimeString('pt-BR')}), h('small', {text: d.toLocaleDateString('pt-BR', {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'}).toUpperCase().replace(/\./g, '')}));
    root.querySelectorAll('[data-started]').forEach(function (n) { n.textContent = dur(Date.now() / 1000 - Number(n.dataset.started)); });
  }

  // ------------------------------------------------------------------ interface
  function popContent() {
    pop.replaceChildren.apply(pop, flat([h('div', {class: 'tv-pop-t', text: 'Cenas no rodízio'}),
      SCENES.map(function (x) {
        const cb = h('input', {type: 'checkbox'}); cb.checked = cfg.scenes.indexOf(x[0]) >= 0;
        cb.addEventListener('change', function () {
          const l = cfg.scenes.filter(function (n) { return n !== x[0]; }); if (cb.checked) l.push(x[0]);
          if (!l.length) { cb.checked = true; return; }
          cfg.scenes = l.sort(); saveCfg(); if (cfg.scenes.indexOf(sceneKey) < 0) goScene(cfg.scenes[0]); else goScene(sceneKey); schedule();
        });
        return h('label', {}, cb, ' ' + x[0] + ' · ' + x[1]);
      }),
      h('label', {class: 'tv-pop-s'}, 'Trocar a cada ', h('select', {onchange: function (e) { cfg.secs = Number(e.target.value); saveCfg(); schedule(); dotsEl.querySelectorAll('.on').forEach(function (n) { n.style.setProperty('--secs', cfg.secs + 's'); }); }},
        [[10, '10 s'], [15, '15 s'], [20, '20 s'], [30, '30 s'], [60, '1 min'], [0, 'parado']].map(function (o) { return h('option', {value: o[0], text: o[1], selected: o[0] === cfg.secs}); })))]));
  }
  function setPaused(v) { paused = v; root.querySelector('.tv-pp').textContent = paused ? '▶' : '⏸'; root.classList.toggle('paused', paused); schedule(); }
  function setSound(v) { sound = v; root.querySelector('.tv-snd').textContent = sound ? '🔔' : '🔇'; if (sound) beep(); }
  function fullscreen() {
    try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch (e) { /* ok */ }
  }
  function onKey(e) {
    if (e.key === 'Escape') { if (pop.classList.contains('on')) { pop.classList.remove('on'); if (e.target && e.target.blur) e.target.blur(); } else close(); return; }
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === 'ArrowRight') step(1); else if (k === 'ArrowLeft') step(-1);
    else if (k === ' ') { e.preventDefault(); setPaused(!paused); }
    else if (k === 'a' || k === 'A') { activeAlerts().forEach(function (i) { dismissed.add(i.id); }); alertEl.dataset.sig = ''; renderAlert(); }
    else if (k === 's' || k === 'S') setSound(!sound);
    else if (k === 'f' || k === 'F') fullscreen();
    else if (/^[1-4]$/.test(k) && cfg.scenes.indexOf(Number(k)) >= 0) { goScene(Number(k)); schedule(); }
  }
  function wake() {
    if (!root) return;
    root.classList.remove('nocursor'); root.classList.add('showbar'); clearTimeout(hideCur);
    hideCur = setTimeout(function () { if (root) { root.classList.add('nocursor'); root.classList.remove('showbar'); pop.classList.remove('on'); } }, 4000);
  }

  function open() {
    if (root) return;
    const u = urlParams(); if (u.scenes) cfg.scenes = u.scenes; if (u.secs != null) cfg.secs = u.secs; if (u.sound) sound = true;
    stage = h('div', {class: 'tv-stage'}); dotsEl = h('div', {class: 'tv-dots'}); nameEl = h('span', {class: 'tv-sname'}); clockEl = h('div', {class: 'tv-clock'});
    toast = h('div', {class: 'tv-toast', role: 'status'}); alertEl = h('div', {class: 'tv-alert', role: 'alert'}); pop = h('div', {class: 'tv-pop'});
    bar = h('div', {class: 'tv-bar2'},
      h('button', {type: 'button', title: 'Cena anterior (←)', 'aria-label': 'Cena anterior', text: '◀', onclick: function () { step(-1); }}),
      h('button', {type: 'button', class: 'tv-pp', title: 'Pausar / continuar (espaço)', 'aria-label': 'Pausar', text: '⏸', onclick: function () { setPaused(!paused); }}),
      h('button', {type: 'button', title: 'Próxima cena (→)', 'aria-label': 'Próxima cena', text: '▶', onclick: function () { step(1); }}),
      h('button', {type: 'button', class: 'tv-snd', title: 'Som de alerta (S)', 'aria-label': 'Som de alerta', text: sound ? '🔔' : '🔇', onclick: function () { setSound(!sound); }}),
      h('button', {type: 'button', title: 'Configurar cenas e tempo', 'aria-label': 'Configurar', text: '⚙', onclick: function () { popContent(); pop.classList.toggle('on'); }}),
      h('button', {type: 'button', title: 'Tela cheia (F)', 'aria-label': 'Tela cheia', text: '⛶', onclick: fullscreen}),
      h('button', {type: 'button', title: 'Sair (Esc)', 'aria-label': 'Sair do modo TV', text: '✕', onclick: close}));
    root = h('div', {id: 'wall', class: 'tv', role: 'dialog', 'aria-label': 'Modo TV'},
      h('div', {class: 'tv-top'}, h('div', {class: 'tv-logo'}, h('span', {'data-appname': '', text: window.APP_NAME || 'NetNOC'}), h('small', {text: 'MISSION CONTROL'})), h('span', {class: 'tv-live'}), clockEl),
      toast, stage, h('div', {class: 'tv-foot'}, nameEl, dotsEl), alertEl, bar, pop);
    document.body.append(root); document.body.classList.add('tv-on');
    document.addEventListener('keydown', onKey); document.addEventListener('netnoc:snapshot', onSnap);
    root.addEventListener('mousemove', wake); root.addEventListener('click', wake);
    window.addEventListener('resize', onResize);
    wake();
    try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch (e) { /* ok */ }
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () { /* ok */ }); } catch (e) { /* ok */ }
    seen = null; prevPorts = null; dismissed = new Set(); alertId = null; paused = false; D.histLoaded = false;
    Object.keys(last).forEach(function (k) { last[k] = 0; });
    clockTick(); tick = setInterval(clockTick, 1000);
    const first = enabledScenes()[0]; goScene(first); schedule();
    refreshData(true).then(function () { if (root) { onData(); schedule(); } });
    renderStatus();
  }
  let rzT = null;
  function onResize() { clearTimeout(rzT); rzT = setTimeout(function () { if (root && sceneKey === 2) { stage.querySelector('.tv-treebox') && (stage.querySelector('.tv-treebox').dataset.sig = ''); scene.update.call(scene); } }, 250); }
  function close() {
    if (!root) return;
    root.remove(); root = null; scene = null; clearTimeout(timer); clearInterval(tick); clearTimeout(toastTimer); clearTimeout(hideCur);
    document.body.classList.remove('tv-on'); document.removeEventListener('keydown', onKey); document.removeEventListener('netnoc:snapshot', onSnap); window.removeEventListener('resize', onResize);
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) { /* ok */ }
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) { /* ok */ }
    cfg = loadCfg();
  }
  window.NetnocWall = {toggle: function () { return root ? close() : open(); }, open: open, close: close};
  if (/^#tv/.test(location.hash)) window.addEventListener('load', function () { setTimeout(open, 800); });
})();
