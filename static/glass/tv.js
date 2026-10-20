// NetNOC v3 — Modo TV no visual glass.
// Quatro cenas em rodízio (Visão geral, Topologia, Equipamentos, Últimas 24 h) + ALERTA crítico que toma a tela.
// Abre pelo dock, pela tecla T ou por #tv (ex.: #tv?cenas=1,2,3&tempo=20&som=1).
// Teclas: ← → cenas · espaço pausa · A dispensa alerta · S som · F tela cheia · Esc sai.
'use strict';
(function () {
  const {h, clear, api, ms, pct, hm, dur, bps, num, brandSvg, hue, sparkArea, S} = window.NN;
  const SCENES = [[1, 'Visão geral', 'home'], [2, 'Topologia', 'network'], [3, 'Equipamentos', 'router'], [4, 'Últimas 24 horas', 'clock'], [5, 'Câmeras', 'video']];
  const NSC = SCENES.length;
  const KEY = 'netnoc_tv_glass';
  const GOAL = 99.9;
  const PORTS = ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'];
  const PORT_POS = [36.3, 47.6, 59, 70.4, 81.7];
  const WD = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const MO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const pad = n => String(n).padStart(2, '0');

  let root = null, el = {}, cfg = loadCfg(), sound = false, paused = false, idx = 0, timer = null;
  let ticks = [], D = {}, last = {}, scene = null, chart = null, dismissed = new Set(), seen = null, prevPorts = null;
  let alertId = null, hideT = null, wakeLock = null, toastT = null, renderT = null;

  // ------------------------------------------------------------------ configuração
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { return null; } }
  function loadCfg() {
    let c = {scenes: [1, 2, 3, 4], secs: 15, camAuto: false};
    try {
      const j = JSON.parse(ls(KEY) || 'null');
      if (j && Array.isArray(j.scenes)) c = {scenes: j.scenes.filter(n => n >= 1 && n <= NSC), secs: Number(j.secs) >= 0 ? Number(j.secs) : 15, camAuto: !!j.camAuto};
    } catch (_) { /* padrão */ }
    if (!c.scenes.length) c.scenes = [1, 2, 3, 4];
    return c;
  }
  const saveCfg = () => ls(KEY, JSON.stringify(cfg));
  function urlParams() {
    const q = location.hash.split('?')[1] || '', p = new URLSearchParams(q), out = {};
    if (p.get('cenas')) { const l = p.get('cenas').split(',').map(Number).filter(n => n >= 1 && n <= NSC); if (l.length) out.scenes = l; }
    if (p.get('tempo') && Number(p.get('tempo')) >= 0) out.secs = Number(p.get('tempo'));
    if (p.get('som') === '1') out.sound = true;
    return out;
  }

  // ------------------------------------------------------------------ dados
  function every(k, msec, fn) {
    if (Date.now() - (last[k] || 0) < msec) return Promise.resolve();
    last[k] = Date.now();
    return Promise.resolve().then(fn).catch(() => { /* fonte indisponível: segue sem */ });
  }
  function refresh() {
    const mon = new Date(); const month = mon.getFullYear() + '-' + pad(mon.getMonth() + 1);
    return Promise.all([
      every('targets', 15000, async () => { D.targets = await api('/api/targets'); }),
      every('spark', 15000, async () => { D.spark = await api('/api/sparklines'); }),
      every('topo', 15000, async () => { D.topo = await api('/api/topology'); D.cfg = await api('/api/settings'); }),
      every('sys', 15000, async () => { D.sys = await api('/api/system'); }),
      every('bars', 60000, async () => { D.bars = await api('/api/uptime/bars?hours=6'); }),
      every('inc', 30000, async () => { D.inc = await api('/api/incidents?days=1'); }),
      every('mk', 15000, async () => {
        D.mk = await api('/api/mikrotik/status');
        D.ifaces = D.mk && D.mk.enabled ? await api('/api/mikrotik/interfaces') : [];
        const w = wan();
        if (w) {
          // última hora; se a coleta for espaçada (poucos pontos), cai para 24 h
          let hh = await api('/api/mikrotik/history?range=1h&iface=' + encodeURIComponent(w.name));
          if ((hh.points || []).length < 3) hh = await api('/api/mikrotik/history?range=24h&iface=' + encodeURIComponent(w.name));
          D.wanHist = (hh.points || []).map(p => p.rx_bps);
        }
      }),
      every('agh', 60000, async () => {
        D.agh = await api('/api/agh/stats');
        D.aghTop = await api('/api/agh/top').catch(() => null);
      }),
      every('dns', 30000, async () => { D.dns = await api('/api/dns'); }),
      every('lat24', 60000, async () => { D.lat24 = await api('/api/history/24h'); }),
      every('speed', 120000, async () => { D.speed = await api('/api/speedtest/history?limit=8'); }),
      every('sla', 300000, async () => { D.sla = await api('/api/sla?month=' + month); }),
    ]);
  }
  function wan() {
    const l = (D.ifaces || []).filter(i => !i.disabled);
    if (!l.length) return null;
    return l.find(i => /pppoe|ppoe|wan|internet/i.test(i.name) && i.running) || l.find(i => i.name === 'ether1') ||
      l.slice().sort((a, b) => (b.rx_bps || 0) - (a.rx_bps || 0))[0];
  }

  // ------------------------------------------------------------------ modelo
  function live() { return (S.overview && S.overview.targets) || {}; }
  function targetsList() { return D.targets || S.targets || []; }
  function stateMap() {
    // só incidentes de destino (um servidor DNS chamado "Google" não pode pintar o alvo de ping "Google")
    const T = live(), incs = (S.active || []).filter(i => i.severity !== 'Info' && ['offline', 'latency', 'jitter', 'loss', 'cert'].includes(i.type));
    const parent = {};
    for (const t of (D.cfg && D.cfg.targets) || []) parent[t.name] = t.parent || null;
    const st = {};
    for (const t of targetsList()) {
      const x = T[t.name] || {};
      const on = x.online != null ? x.online : t.online;
      const loss = x.loss_pct != null ? x.loss_pct : (t.loss_pct || 0);
      const down = (S.active || []).some(i => i.type === 'offline' && i.target === t.name);
      if (on == null) st[t.name] = 'na';
      // vermelho só com queda confirmada (incidente aberto ou ≥50% de perda); um ping perdido fica amarelo
      else if (down || (!on && loss >= 50)) st[t.name] = 'bad';
      else if (!on) st[t.name] = 'warn';
      else if ((x.loss_pct || 0) >= 5 || incs.some(i => i.target === t.name)) st[t.name] = 'warn';
      else st[t.name] = 'ok';
    }
    // isolado: está fora porque um ancestral caiu
    for (const n of Object.keys(st)) {
      if (st[n] !== 'bad') continue;
      let p = parent[n], seenP = new Set();
      while (p && !seenP.has(p)) { seenP.add(p); if (st[p] === 'bad') { st[n] = 'iso'; break; } p = parent[p]; }
    }
    return {st, parent};
  }
  function health() {
    const {st} = stateMap();
    const vals = Object.values(st).filter(s => s !== 'na');
    const pts = {ok: 100, warn: 60, bad: 0, iso: 30};
    const links = vals.length ? vals.reduce((a, s) => a + pts[s], 0) / vals.length : null;
    const ups = targetsList().map(t => t.uptime_24h).filter(v => typeof v === 'number');
    const up = ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : null;
    const disp = up == null ? null : Math.max(0, Math.min(100, (up - 95) * 20));
    const lat = S.overview ? num(S.overview.avg_latency) : null;
    const latS = lat == null ? null : Math.max(0, Math.min(100, 100 - (lat - 30) / 1.2));
    const incs = (S.active || []).filter(i => i.severity !== 'Info');
    const alta = incs.filter(i => i.severity === 'Alta').length, media = incs.filter(i => i.severity === 'Media').length;
    const incS = Math.max(0, 100 - alta * 30 - media * 10);
    const parts = [[links, 35], [disp, 30], [latS, 10], [incS, 25]].filter(p => p[0] != null);
    const w = parts.reduce((a, p) => a + p[1], 0);
    const score = w ? Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / w) : null;
    return {score, up, st, online: vals.filter(s => s === 'ok' || s === 'warn').length, known: vals.length, incs};
  }

  // ------------------------------------------------------------------ peças
  const lab = (t, icon) => h('div', {class: 'tvg-lab'}, icon ? h('span', {trusted: ICO(icon)}) : null, t);
  const orb = (cls, icon, text) => h('div', {class: 'tvg-orb ' + (cls || ''), trusted: icon ? ICO(icon) : null, text: icon ? null : text});
  function li(cls, text, right) {
    return h('div', {class: 'tvg-li ' + (cls || '')}, h('i'), h('span', {class: 'm', text, title: text}), h('span', {class: 'r', text: right || ''}));
  }
  function bar(label, value, wPct, color) {
    const b = h('div', {class: 'tvg-bar'}, h('span', {text: label}), h('b', {text: value}), h('i'));
    b.lastChild.style.setProperty('--w', Math.max(0, Math.min(100, wPct)) + '%');
    if (color) b.lastChild.style.setProperty('--c', color);
    return b;
  }
  const tone = (v, warn, bad) => v == null ? 'grey' : v >= bad ? 'red' : v >= warn ? 'yellow' : 'green';
  const sevCls = s => ({Alta: 'alta', Media: 'media'}[s] || '');
  function area(vals, color) {
    const svg = sparkArea(vals, 400, 100, color);
    return svg;
  }
  const C = n => window.SKIN.col(n);
  const accent = () => C('--spark');
  function ring(score) {
    const CIRC = 2 * Math.PI * 88;
    const col = score == null ? C('--grey') : score >= 90 ? C('--green') : score >= 70 ? C('--yellow') : C('--red');
    const v = score == null ? 0 : score;
    return `<svg viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r="88" fill="none" stroke="${C('--track')}" stroke-width="13"/>
      <circle cx="100" cy="100" r="88" fill="none" stroke="${col}" stroke-width="13" stroke-linecap="round"
        stroke-dasharray="${(CIRC * v / 100).toFixed(1)} ${CIRC.toFixed(1)}" style="filter:drop-shadow(0 0 8px ${col});transition:stroke-dasharray 1s"/>
      <circle cx="100" cy="100" r="72" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="2" stroke-dasharray="2 6"/>
    </svg>`;
  }

  // ================================================================== CENA 1 — Visão geral
  const scene1 = {
    build() {
      this.left = h('section', {class: 'tvg-dark tvg-pad'});
      this.cards = h('section', {class: 'tvg-cards'});
      this.right = h('section', {class: 'tvg-right'});
      return h('div', {class: 'tvg-sc tvg-s1'}, this.left, this.cards, this.right);
    },
    update() {
      const H = health();
      const label = H.score == null ? 'SEM DADOS' : H.score >= 90 ? 'SAUDÁVEL' : H.score >= 70 ? 'ATENÇÃO' : 'CRÍTICO';
      const lc = H.score == null ? 'inherit' : H.score >= 90 ? 'var(--green)' : H.score >= 70 ? 'var(--yellow)' : 'var(--red)';
      // esquerda: saúde
      const L = clear(this.left);
      L.append(lab('Saúde da rede', 'activity'));
      const r = h('div', {class: 'tvg-ring', trusted: ring(H.score)});
      r.append(h('div', {class: 'val'}, h('b', {text: H.score == null ? '–' : String(H.score)}), h('span', {text: label, style: {color: lc}})));
      L.append(r);
      const hours = h('div', {class: 'tvg-hours'});
      const bars = D.bars || {};
      const now = Math.floor(Date.now() / 3600000) * 3600;
      for (let i = 5; i >= 0; i--) {
        const end = now - i * 3600 + 3600;
        const v = Object.values(bars).map(b => (b.find(x => x.ts === end) || {}).pct).filter(x => x != null);
        const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
        const row = h('div', {class: 'hr'}, h('span', {text: hm(end - 3600)}), h('i'), h('span', {text: avg == null ? '–' : pct(avg, avg >= 99.95 ? 0 : 1) + '%'}));
        row.children[1].style.setProperty('--w', (avg == null ? 0 : Math.max(4, (avg - 95) * 20)) + '%');
        row.children[1].style.setProperty('--c', avg == null ? 'transparent' : avg >= 99.9 ? 'var(--green)' : avg >= 98 ? 'var(--yellow)' : 'var(--red)');
        hours.append(row);
      }
      L.append(lab('Disponibilidade por hora'), hours);
      L.append(h('div', {class: 'tvg-trio', style: {marginTop: '1.2em'}},
        h('div', {}, h('small', {text: 'Online'}), h('b', {text: H.known ? H.online + '/' + H.known : '–'})),
        h('div', {}, h('small', {text: 'Disp. 24h'}), h('b', {text: H.up == null ? '–' : pct(H.up, 1) + '%'})),
        h('div', {}, h('small', {text: 'Alertas'}), h('b', {text: String(H.incs.length), style: {color: H.incs.length ? 'var(--yellow)' : ''}}))));

      // centro: um card por destino (problemas primeiro)
      const order = {bad: 0, iso: 1, warn: 2, ok: 3, na: 4};
      const list = targetsList().slice().sort((a, b) => order[H.st[a.name] || 'na'] - order[H.st[b.name] || 'na']).slice(0, 16);
      const n = list.length;
      this.cards.style.setProperty('--cols', n <= 4 ? 2 : n <= 9 ? 3 : 4);
      const CC = clear(this.cards);
      if (!n) CC.append(h('div', {class: 'tvg-empty', text: 'Nenhum destino cadastrado.'}));
      const T = live();
      for (const t of list) {
        const st = H.st[t.name] || 'na', x = T[t.name] || {};
        const lat = x.latency != null ? x.latency : t.latency;
        const hu = hue(t.name);
        const card = h('article', {class: 'tvg-card tvg-glass ' + (st === 'bad' ? 'off' : st === 'warn' ? 'warn' : '')});
        card.append(h('div', {class: 'tint', style: {background: `radial-gradient(120% 90% at 85% 0%, hsla(${hu},70%,60%,.28), transparent 60%)`}}),
          h('div', {class: 'brand', trusted: brandSvg(t.name, t.host)}));
        const sp = h('div', {class: 'spark'});
        sp.append(area((D.spark || S.spark || {})[t.name], st === 'bad' ? C('--red') : accent()));
        card.append(sp, h('div', {class: 'fade'}),
          h('div', {class: 'nm'}, h('span', {text: t.name}), h('em', {text: (t.type || 'icmp').toUpperCase()})),
          h('div', {class: 'host', text: t.host}),
          h('div', {class: 'bot'},
            orb(st === 'bad' ? 'red' : st === 'iso' ? 'grey' : st === 'warn' ? 'yellow' : st === 'na' ? 'grey' : '', st === 'bad' || st === 'iso' ? 'x' : st === 'na' ? 'minus' : 'check'),
            h('span', {class: 'lat' + (st === 'bad' || st === 'iso' ? ' down' : '')}, st === 'bad' || st === 'iso' ? (st === 'iso' ? 'isolado' : 'offline') : ms(lat), st === 'bad' || st === 'iso' ? null : h('small', {text: 'ms'})),
            h('span', {class: 'meta'}, 'perda ' + pct(x.loss_pct != null ? x.loss_pct : t.loss_pct, 0) + '%', h('br'), t.uptime_24h != null ? pct(t.uptime_24h, 1) + '% 24h' : '')));
        CC.append(card);
      }

      // direita: KPIs + incidentes
      const o = S.overview || {};
      const R = clear(this.right);
      const on = o.internet_online;
      R.append(h('div', {class: 'tvg-kpi tvg-glass'}, orb(on === false ? 'red' : 'orange', on === false ? 'wifiOff' : 'wifi'),
        h('div', {}, h('small', {text: 'Internet'}), h('b', {text: on === false ? 'OFFLINE' : on ? 'ONLINE' : '–', style: {color: on === false ? 'var(--red)' : ''}}))));
      R.append(h('div', {class: 'tvg-kpi tvg-glass'}, orb('blue', 'globe'),
        h('div', {style: {minWidth: 0}}, h('small', {text: 'IP público' + (o.public_ipv6 ? ' · IPv6 ativo' : '')}), h('b', {class: 'ip', text: o.public_ip || '–'}))));
      R.append(h('div', {class: 'tvg-k2'},
        h('div', {class: 'tvg-kpi tvg-glass'}, h('small', {text: 'Latência'}), h('b', {text: ms(o.avg_latency, 0) + ' ms'}), h('span', {class: 'tvg-sub', text: 'jitter ' + ms(o.avg_jitter) + ' ms'})),
        h('div', {class: 'tvg-kpi tvg-glass'}, h('small', {text: 'Perda'}), h('b', {text: pct(o.avg_loss_pct, 1) + '%', style: {color: (o.avg_loss_pct || 0) > 2 ? 'var(--orange)' : ''}}),
          h('span', {class: 'tvg-sub', text: 'média dos destinos'}))));
      const box = h('section', {class: 'tvg-dark tvg-pad'});
      box.append(lab('Agora', 'alert'));
      const l = h('div', {class: 'tvg-list'});
      const incs = H.incs;
      if (!incs.length) l.append(li('ok', 'Tudo operacional', ''));
      for (const i of incs.slice(0, 5)) l.append(li(sevCls(i.severity), i.message, dur(Date.now() / 1000 - i.started_ts)));
      if (incs.length > 5) l.append(h('div', {class: 'tvg-more', text: '+ ' + (incs.length - 5) + ' outros'}));
      const res = (D.inc || []).filter(i => i.resolved_ts).slice(0, Math.max(0, 3 - incs.length));
      if (res.length) {
        l.append(h('div', {class: 'tvg-lab', style: {margin: '.8em 0 .2em'}, text: 'Resolvidos hoje'}));
        for (const i of res) l.append(li('ok', i.target + ' · ' + i.message, dur(i.resolved_ts - i.started_ts)));
      }
      box.append(l);
      R.append(box);
    },
  };

  // ================================================================== CENA 2 — Topologia
  const scene2 = {
    build() {
      this.chips = h('div', {class: 'tvg-chips'});
      this.box = h('section', {class: 'tvg-topo tvg-glass'});
      return h('div', {class: 'tvg-sc tvg-s2'}, this.chips, this.box);
    },
    update() {
      const topo = D.topo;
      const {st} = stateMap();
      const CH = clear(this.chips);
      const vals = Object.values(st);
      const cnt = k => vals.filter(v => v === k).length;
      CH.append(h('span', {class: 'tvg-chip tvg-glass'}, h('i', {style: {background: 'var(--blue)', boxShadow: '0 0 .7em var(--blue)'}}), vals.length + ' equipamentos'));
      if (cnt('bad')) CH.append(h('span', {class: 'tvg-chip r tvg-glass'}, h('i'), cnt('bad') + ' offline'));
      if (cnt('iso')) CH.append(h('span', {class: 'tvg-chip g tvg-glass'}, h('i'), cnt('iso') + ' isolado' + (cnt('iso') > 1 ? 's' : '')));
      if (cnt('warn')) CH.append(h('span', {class: 'tvg-chip a tvg-glass'}, h('i'), cnt('warn') + ' degradado' + (cnt('warn') > 1 ? 's' : '')));
      if (!cnt('bad') && !cnt('iso') && !cnt('warn')) CH.append(h('span', {class: 'tvg-chip tvg-glass'}, h('i'), 'Tudo operacional'));
      const B = clear(this.box);
      if (!topo || !topo.nodes || topo.nodes.length < 2) { B.append(h('div', {class: 'tvg-empty', text: 'Nenhum destino cadastrado.'})); return; }
      // layout em árvore da esquerda para a direita
      const kids = {};
      for (const e of topo.edges) (kids[e.source] = kids[e.source] || []).push(e.target);
      const pos = {}; let leaf = 0, depth = 0;
      (function walk(id, d, seenW) {
        if (seenW.has(id)) return; seenW.add(id); depth = Math.max(depth, d);
        const ch = kids[id] || [];
        if (!ch.length) { pos[id] = {x: d, y: leaf++}; return; }
        ch.forEach(c => walk(c, d + 1, seenW));
        const ys = ch.map(c => pos[c] && pos[c].y).filter(v => v != null);
        pos[id] = {x: d, y: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : leaf++};
      })('internet', 0, new Set());
      const W = Math.max(900, (depth + 1) * 380), Hh = Math.max(420, leaf * 92);
      const X = x => 120 + (W - 380) * (depth ? x / depth : 0), Y = y => 46 + (Hh - 92) * (leaf > 1 ? y / (leaf - 1) : .5);
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      const T = live();
      for (const e of topo.edges) {
        const a = pos[e.source], b = pos[e.target]; if (!a || !b) continue;
        const s = st[e.target] || 'na';
        const x1 = X(a.x) + 30, y1 = Y(a.y), x2 = X(b.x) - 26, y2 = Y(b.y), mx = (x1 + x2) / 2;
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
        p.setAttribute('class', 'edge ' + (s === 'na' ? 'iso' : s));
        svg.append(p);
      }
      for (const n of topo.nodes) {
        const p = pos[n.id]; if (!p) continue;
        const s = n.type === 'internet' ? 'net' : (st[n.id] || 'na');
        const col = {net: C('--blue'), ok: C('--green'), warn: C('--yellow'), bad: C('--red'), iso: C('--grey'), na: C('--grey')}[s];
        const g = document.createElementNS(NS, 'g');
        const r = n.type === 'internet' ? 30 : 22;
        g.innerHTML = `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${r + 10}" fill="${col}" opacity=".16"/>` +
          `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${r}" fill="${col}" style="filter:drop-shadow(0 0 10px ${col})"/>`;
        const root_ = n.type === 'internet';
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', root_ ? X(p.x) : X(p.x) + r + 16); t.setAttribute('y', root_ ? Y(p.y) + r + 34 : Y(p.y) - 3);
        t.setAttribute('font-size', root_ ? '24' : '22'); t.setAttribute('font-weight', '600');
        if (root_) t.setAttribute('text-anchor', 'middle');
        t.textContent = n.label;
        const sub = document.createElementNS(NS, 'text');
        sub.setAttribute('x', root_ ? X(p.x) : X(p.x) + r + 16); sub.setAttribute('y', root_ ? Y(p.y) + r + 58 : Y(p.y) + 21);
        sub.setAttribute('font-size', '16'); sub.setAttribute('class', 'sub');
        if (root_) sub.setAttribute('text-anchor', 'middle');
        const x = T[n.id] || {};
        sub.textContent = n.type === 'internet' ? ((S.overview || {}).public_ip || '') :
          s === 'bad' ? 'OFFLINE · ' + n.host : s === 'iso' ? 'ISOLADO' : (x.latency != null ? ms(x.latency) + ' ms · ' : '') + (n.host || '');
        if (s === 'bad') sub.style.fill = C('--red');
        g.append(t, sub);
        svg.append(g);
      }
      B.append(svg);
    },
  };

  // ================================================================== CENA 3 — Equipamentos
  const scene3 = {
    build() {
      this.pi = h('section', {class: 'tvg-dark tvg-pad'});
      this.mk = h('section', {class: 'tvg-glass tvg-pad mk'});
      this.agh = h('section', {class: 'tvg-glass tvg-pad'});
      this.dns = h('section', {class: 'tvg-glass tvg-pad'});
      this.speed = h('section', {class: 'tvg-dark tvg-pad'});
      return h('div', {class: 'tvg-sc tvg-s3'}, this.pi, this.mk, this.agh, this.dns, this.speed);
    },
    update() {
      // servidor do NetNOC
      const s = D.sys || {};
      const P = clear(this.pi);
      P.append(lab((s.host_label || 'Servidor') + ' · NetNOC', 'server'));
      const orbs = h('div', {class: 'tvg-orbs'});
      [['CPU', s.cpu_pct, '%', 70, 90], ['RAM', s.mem_pct, '%', 80, 90], ['Temp', s.temp_c, '°', 65, 75], ['Disco', s.disk_pct, '%', 80, 90]].forEach(([l, v, u, w, b]) =>
        orbs.append(h('div', {}, orb(tone(v, w, b), null, v == null ? '–' : Math.round(v) + u), h('small', {text: l}))));
      P.append(orbs);
      const wk = s.workers || [];
      P.append(h('dl', {class: 'tvg-kv'},
        h('dt', {text: 'Host ligado há'}), h('dd', {text: s.host_uptime_s ? dur(s.host_uptime_s) : '–'}),
        h('dt', {text: 'NetNOC rodando há'}), h('dd', {text: s.app_uptime_s != null ? dur(s.app_uptime_s) : '–'}),
        h('dt', {text: 'Banco de dados'}), h('dd', {text: s.db_mb != null ? ms(s.db_mb) + ' MB' : '–'}),
        h('dt', {text: 'Coletores'}), h('dd', {text: wk.length ? wk.filter(w => w.status === 'ok').length + '/' + wk.length + ' ok' : '–',
          style: {color: wk.some(w => w.status === 'stalled') ? 'var(--red)' : ''}})));

      // MikroTik
      const M = clear(this.mk), mk = D.mk;
      if (!mk || !mk.enabled) {
        M.append(lab('MikroTik', 'router'), h('div', {class: 'tvg-empty', text: 'Integração MikroTik desativada.'}));
      } else {
        M.append(lab(`MikroTik ${mk.board_name || ''} · RouterOS ${mk.version || ''}` + (mk.stale ? ' · dados atrasados' : ''), 'router'));
        const by = {}; for (const i of D.ifaces || []) by[i.name] = i;
        const photo = h('div', {class: 'tvg-photo'}, h('img', {src: 'glass/mk-panel.jpg', alt: 'Painel frontal do MikroTik'}));
        PORTS.forEach((p, i) => { const r = by[p]; const dot = h('i', {class: r ? (r.running ? 'on' : 'off') : '', title: p}); dot.style.left = PORT_POS[i] + '%'; photo.append(dot); });
        M.append(photo);
        const w = wan();
        M.append(h('div', {class: 'tvg-rxtx'},
          h('div', {}, orb('green', 'down'), h('div', {}, h('small', {text: 'Download · ' + (w ? w.name : 'WAN')}), h('b', {text: bps(w && w.rx_bps)}))),
          h('div', {}, orb('blue', 'up'), h('div', {}, h('small', {text: 'Upload'}), h('b', {text: bps(w && w.tx_bps)})))));
        const ar = h('div', {class: 'tvg-area'});
        if (D.wanHist && D.wanHist.length > 1) ar.append(area(D.wanHist, accent()));
        M.append(ar);
        const mo = h('div', {class: 'tvg-orbs', style: {marginTop: '1em'}});
        [['CPU', mk.cpu_load, '%', 60, 85], ['RAM', mk.mem_pct, '%', 80, 90], ['Temp', mk.temperature, '°', 65, 75], ['Disco', mk.hdd_pct, '%', 85, 95]].forEach(([l, v, u, a, b]) =>
          mo.append(h('div', {}, orb(tone(v, a, b), null, v == null ? '–' : Math.round(v) + u), h('small', {text: l}))));
        M.append(mo, h('div', {class: 'tvg-sub', style: {textAlign: 'center'}, text: 'Uptime ' + (mk.uptime_s != null ? dur(mk.uptime_s) : '–')}));
      }

      // AdGuard
      const A = clear(this.agh), ag = D.agh || {};
      A.append(lab('AdGuard Home', 'shield'));
      if (!ag.ts) A.append(h('div', {class: 'tvg-empty', text: 'Sem dados do AdGuard.'}));
      else {
        A.append(h('div', {class: 'tvg-big'}, pct(ag.blocked_pct, 1), h('small', {text: '% bloqueado'})),
          h('div', {class: 'tvg-sub', text: `${(ag.num_dns_queries || 0).toLocaleString('pt-BR')} consultas · ${(ag.num_blocked_filtering || 0).toLocaleString('pt-BR')} bloqueadas`}));
        const top = (D.aghTop && D.aghTop.blocked) || [];
        const l = h('div', {class: 'tvg-list', style: {marginTop: 'auto'}});
        for (const x of top.slice(0, 3)) l.append(li('media', x.name, x.count.toLocaleString('pt-BR')));
        if (top.length) A.append(h('div', {class: 'tvg-lab', style: {marginTop: '1em'}, text: 'Mais bloqueados'}), l);
      }

      // DNS
      const Dn = clear(this.dns);
      Dn.append(lab('Servidores DNS', 'globe'));
      const bars = h('div', {class: 'tvg-bars'});
      for (const d of (D.dns || []).slice().sort((a, b) => (a.latency == null) - (b.latency == null) || a.latency - b.latency)) {
        const v = num(d.latency);
        bars.append(bar(d.name, d.success === false ? 'falhou' : ms(v, 0) + ' ms', d.success === false ? 100 : Math.min(100, (v || 0) / 2),
          d.success === false || v > 150 ? 'var(--red)' : v > 60 ? 'var(--yellow)' : 'var(--green)'));
      }
      if (!bars.children.length) bars.append(h('div', {class: 'tvg-sub', text: 'Nenhum servidor configurado.'}));
      Dn.append(bars);

      // velocidade
      const Sp = clear(this.speed), sl = D.speed || [];
      Sp.append(lab('Velocidade', 'gauge'));
      if (!sl.length) Sp.append(h('div', {class: 'tvg-empty', text: 'Nenhum teste ainda.'}));
      else {
        const x = sl[0];
        Sp.append(h('div', {style: {display: 'flex', gap: '1.6em', alignItems: 'baseline'}},
          h('div', {class: 'tvg-big'}, x.download != null ? String(Math.round(x.download)) : '–', h('small', {text: '↓ Mbps'})),
          h('div', {class: 'tvg-big', style: {fontSize: '2em'}}, x.upload != null ? String(Math.round(x.upload)) : '–', h('small', {text: '↑ Mbps'}))),
        h('div', {class: 'tvg-sub', text: 'último teste ' + new Date(x.ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) + ' · latência ' + ms(x.latency, 0) + ' ms'}));
        const mx = Math.max(1, ...sl.map(r => r.download || 0));
        const b = h('div', {class: 'tvg-bars', style: {marginTop: 'auto'}});
        for (const r of sl.slice(0, 4)) b.append(bar(new Date(r.ts * 1000).toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'}), (r.download != null ? Math.round(r.download) : '–') + ' Mbps', 100 * (r.download || 0) / mx, 'var(--blue)'));
        Sp.append(b);
      }
    },
  };

  // ================================================================== CENA 4 — Últimas 24 h
  const scene4 = {
    build() {
      this.cv = h('canvas');
      this.stats = h('div', {class: 'tvg-stats3'});
      this.chart = h('section', {class: 'tvg-glass tvg-pad chart'}, lab('Latência média da internet · 24 h', 'activity'), h('div', {class: 'tvg-chart'}, this.cv), this.stats);
      this.sla = h('section', {class: 'tvg-dark tvg-pad sla'});
      this.res = h('section', {class: 'tvg-glass tvg-pad'});
      this.sum = h('section', {class: 'tvg-glass tvg-pad'});
      return h('div', {class: 'tvg-sc tvg-s4'}, this.chart, this.sla, h('div', {class: 'low'}, this.res, this.sum));
    },
    update() {
      const pts = (D.lat24 || []).map(p => ({x: p.ts * 1000, y: +(+p.latency).toFixed(2)}));
      const ys = pts.map(p => p.y);
      clear(this.stats).append(
        h('span', {}, 'mín', h('b', {text: ys.length ? ms(Math.min(...ys)) + ' ms' : '–'})),
        h('span', {}, 'média', h('b', {text: ys.length ? ms(ys.reduce((a, b) => a + b, 0) / ys.length) + ' ms' : '–'})),
        h('span', {}, 'máx', h('b', {text: ys.length ? ms(Math.max(...ys)) + ' ms' : '–'})));
      const col = accent();
      if (!chart) {
        const ctx = this.cv.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, this.cv.parentElement.clientHeight || 300);
        g.addColorStop(0, col + '70'); g.addColorStop(1, col + '00');
        const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        chart = new Chart(this.cv, {type: 'line', data: {datasets: [{data: pts, borderColor: col, backgroundColor: g, fill: true, tension: .3,
          cubicInterpolationMode: 'monotone', pointRadius: 0, borderWidth: 2.5}]},
        options: {responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
          plugins: {legend: {display: false}, tooltip: {enabled: false}},
          scales: {x: {type: 'linear', grid: {display: false}, border: {display: false},
            ticks: {color: css('--muted'), maxTicksLimit: 9, font: {size: 13}, callback: v => { const d = new Date(v); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }}},
          y: {beginAtZero: true, grid: {color: css('--chart-grid')}, border: {display: false}, ticks: {color: css('--muted'), maxTicksLimit: 5, font: {size: 13}}}}}});
      } else { chart.data.datasets[0].data = pts; }
      if (pts.length) { chart.options.scales.x.min = pts[0].x; chart.options.scales.x.max = pts[pts.length - 1].x; }
      chart.update('none');

      // SLA do mês
      const L = clear(this.sla);
      L.append(lab('SLA do mês · meta ' + String(GOAL).replace('.', ',') + '%', 'file'));
      const rows = ((D.sla && D.sla.targets) || []).filter(t => t.availability_pct != null).sort((a, b) => a.availability_pct - b.availability_pct);
      const bars = h('div', {class: 'tvg-bars tvg-sla'});
      for (const t of rows.slice(0, 12)) {
        const a = t.availability_pct;
        const b = bar(t.target, pct(a, 2) + '%', (a - 98) * 50, a >= GOAL ? 'var(--green)' : a >= 99 ? 'var(--yellow)' : 'var(--red)');
        const goal = h('span', {class: 'tvg-goal'}); goal.style.left = ((GOAL - 98) * 50) + '%';
        b.lastChild.append(goal);
        bars.append(b);
      }
      if (!rows.length) bars.append(h('div', {class: 'tvg-sub', text: 'Sem dados no mês.'}));
      const below = rows.filter(t => t.availability_pct < GOAL).length;
      L.append(bars, h('div', {class: 'tvg-sub', style: {marginTop: 'auto', paddingTop: '1em'},
        text: below ? `${below} destino(s) abaixo da meta · escala 98–100%` : 'Todos os destinos dentro da meta · escala 98–100%'}));

      // resolvidos hoje
      const R = clear(this.res);
      R.append(lab('Resolvidos hoje', 'check'));
      const res = (D.inc || []).filter(i => i.resolved_ts);
      const l = h('div', {class: 'tvg-list'});
      if (!res.length) l.append(li('ok', 'Nenhum incidente hoje', ''));
      for (const i of res.slice(0, 5)) l.append(li(sevCls(i.severity), `${hm(i.started_ts)} · ${i.message}`, dur(i.resolved_ts - i.started_ts)));
      R.append(l);

      // resumo 24 h
      const Sm = clear(this.sum);
      Sm.append(lab('Incidentes · 24 h', 'alert'));
      const all = D.inc || [];
      const c = s => all.filter(i => i.severity === s).length;
      Sm.append(h('div', {class: 'tvg-orbs', style: {gridTemplateColumns: 'repeat(3,1fr)'}},
        h('div', {}, orb('red', null, String(c('Alta'))), h('small', {text: 'Alta'})),
        h('div', {}, orb('yellow', null, String(c('Media'))), h('small', {text: 'Média'})),
        h('div', {}, orb('blue', null, String(c('Baixa'))), h('small', {text: 'Baixa'}))));
      const by = {};
      for (const i of all) by[i.target] = (by[i.target] || 0) + 1;
      const worst = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
      const downtime = all.filter(i => i.type === 'offline').reduce((a, i) => a + ((i.resolved_ts || Date.now() / 1000) - i.started_ts), 0);
      Sm.append(h('dl', {class: 'tvg-kv'},
        h('dt', {text: 'Mais instável'}), h('dd', {text: worst ? `${worst[0]} (${worst[1]}×)` : '–'}),
        h('dt', {text: 'Tempo offline somado'}), h('dd', {text: downtime ? dur(downtime) : '0'})));
    },
  };
  // ================================================================== CENA 5 — Câmeras (opcional)
  // Só transmite enquanto a cena está na tela; ao trocar de cena os streams são fechados.
  const scene5 = {
    build() {
      this.players = []; this.started = false;
      this.box = h('section', {class: 'tvg-glass tvg-pad'});
      return h('div', {class: 'tvg-sc', style: {gridTemplateColumns: '1fr'}}, this.box);
    },
    async update() {
      if (this.started) return;
      this.started = true;
      let st = null;
      try { st = await api('/api/cam/status'); } catch (_) { /* ok */ }
      if (scene !== this) return;
      const B = clear(this.box);
      if (!st || !st.enabled) { B.append(lab('Câmeras', 'video'), h('div', {class: 'tvg-empty', text: 'DVR não configurado.'})); return; }
      const live = st.go2rtc && st.go2rtc.running;
      const n = st.channels.length;
      const grid = h('div', {class: 'camgrid', style: {flex: '1', minHeight: '0', gridAutoRows: '1fr', alignContent: 'stretch'}});
      grid.style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
      for (const c of st.channels) {
        const img = h('img', {alt: '', src: `/api/cam/snapshot/${c.ch}?last=1&t=${Date.now()}`});
        const video = h('video', {muted: true, playsinline: true, autoplay: true}); video.muted = true;
        const badge = h('span', {class: 'cam-badge' + (c.loss ? ' loss' : ''), text: c.loss ? 'SEM VÍDEO' : (live ? 'CONECTANDO' : 'FOTO')});
        const tile = h('div', {class: 'camtile', style: {aspectRatio: 'auto', cursor: 'default'}}, img, video,
          h('div', {class: 'cam-top'}, h('span', {trusted: ICO('video')}), c.name, badge));
        grid.append(tile);
        if (live && window.NNCam) {
          this.players.push(NNCam.play(video, 'ch' + c.ch, s => {
            if (s === 'playing') { tile.classList.add('playing'); badge.className = 'cam-badge live'; badge.textContent = 'AO VIVO'; }
            else if (s.startsWith('error:')) { badge.className = 'cam-badge loss'; badge.textContent = 'ERRO'; }
          }));
        }
      }
      B.append(lab(`Câmeras · ${st.model || 'DVR'}`, 'video'), grid);
    },
    stop() { (this.players || []).forEach(p => { try { p.stop(); } catch (_) { /* ok */ } }); this.players = []; },
  };
  const SC = {1: scene1, 2: scene2, 3: scene3, 4: scene4, 5: scene5};

  // ------------------------------------------------------------------ alerta e avisos
  function beep(freq) {
    if (!sound) return;
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      const c = new A(), o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = freq || 880; g.gain.value = .15; o.connect(g); g.connect(c.destination);
      o.start(); setTimeout(() => { o.stop(); c.close(); }, 450);
    } catch (_) { /* sem áudio */ }
  }
  function toast(text) {
    if (!root) return;
    el.toast.textContent = text; el.toast.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => el.toast && el.toast.classList.remove('on'), 10000);
    beep(660);
  }
  function checkEvents() {
    const list = (S.active || []).filter(i => i.severity !== 'Info' && i.severity !== 'Alta');
    const ids = new Set((S.active || []).map(i => i.id));
    if (seen) list.forEach(i => { if (!seen.has(i.id)) toast('Novo incidente · ' + i.message); });
    seen = ids;
    const by = {}; for (const r of D.ifaces || []) by[r.name] = r;
    const now = PORTS.map(n => by[n] ? !!by[n].running : null);
    if (prevPorts) now.forEach((s, i) => { if (prevPorts[i] === true && s === false) toast('Porta ' + PORTS[i] + ' do MikroTik sem link'); });
    prevPorts = now;
  }
  const activeAlerts = () => (S.active || []).filter(i => i.severity === 'Alta' && !dismissed.has(i.id)).sort((a, b) => a.started_ts - b.started_ts);
  function renderAlert() {
    if (!root) return;
    const al = activeAlerts();
    if (!al.length) {
      if (alertId != null) { alertId = null; el.alert.classList.remove('on'); clear(el.alert); schedule(); }
      return;
    }
    const main = al[0];
    const isNew = alertId == null || al.some(i => i.id > alertId);
    alertId = Math.max(...al.map(i => i.id));
    const {st, parent} = stateMap();
    const aff = Object.keys(st).filter(n => n !== main.target && (st[n] === 'iso' || st[n] === 'bad') && (function up(p, k) {
      while (p && k < 20) { if (p === main.target) return true; p = parent[p]; k++; } return false; })(parent[n], 0));
    const box = h('div', {class: 'tvg-abox tvg-glass'},
      orb('red', 'alert'),
      h('span', {class: 'tvg-badge', text: 'ALERTA CRÍTICO'}),
      h('h2', {text: main.target}),
      h('p', {text: main.message}),
      h('div', {class: 'dur', 'data-since': String(main.started_ts), text: dur(Date.now() / 1000 - main.started_ts)}),
      h('div', {class: 'tvg-sub', text: 'desde ' + hm(main.started_ts) + (al.length > 1 ? ` · +${al.length - 1} alerta(s) crítico(s)` : '')}),
      aff.length ? h('div', {class: 'aff'}, 'Afetados: ', ...aff.slice(0, 10).map(n => h('span', {text: n}))) : null,
      h('div', {class: 'hint', text: 'A = DISPENSAR · O RODÍZIO VOLTA QUANDO O ALERTA FOR RESOLVIDO OU DISPENSADO'}));
    clear(el.alert).append(box);
    el.alert.classList.add('on');
    clearTimeout(timer);
    if (isNew) { beep(880); setTimeout(() => beep(990), 550); }
  }

  // ------------------------------------------------------------------ cenas / rodízio
  function show(n) {
    const key = cfg.scenes[n] || cfg.scenes[0];
    idx = cfg.scenes.indexOf(key);
    if (chart) { try { chart.destroy(); } catch (_) { /* ok */ } chart = null; }
    if (scene && scene.stop) scene.stop();
    scene = SC[key];
    const node = scene.build();
    clear(el.stage).append(node);
    const meta = SCENES[key - 1];
    clear(el.scene).append(h('span', {trusted: ICO(meta[2])}), meta[1]);
    el.sname.textContent = `cena ${idx + 1}/${cfg.scenes.length}`;
    dots();
    try { scene.update(); } catch (e) { console.error(e); }
    schedule();
  }
  function dots() {
    clear(el.dots);
    cfg.scenes.forEach((k, i) => el.dots.append(h('button', {type: 'button', class: i === idx ? 'on' : '', title: SCENES[k - 1][1],
      'aria-label': SCENES[k - 1][1], onclick: () => show(i)})));
    el.dots.style.setProperty('--secs', cfg.secs + 's');
    el.dots.classList.toggle('run', !paused && cfg.secs > 0 && cfg.scenes.length > 1 && alertId == null);
  }
  function schedule() {
    clearTimeout(timer);
    dots();
    if (paused || !cfg.secs || cfg.scenes.length < 2 || alertId != null) return;
    timer = setTimeout(() => show((idx + 1) % cfg.scenes.length), cfg.secs * 1000);
  }
  const step = d => show((idx + d + cfg.scenes.length) % cfg.scenes.length);
  function setPaused(p) { paused = p; ctlState(); schedule(); }
  function setSound(s) { sound = s; ctlState(); if (s) beep(660); }
  function ctlState() {
    el.pp.innerHTML = ICO(paused ? 'play' : 'pause'); el.pp.title = paused ? 'Continuar (espaço)' : 'Pausar (espaço)';
    el.snd.innerHTML = ICO(sound ? 'bell' : 'bellOff'); el.snd.classList.toggle('on', sound);
  }
  function render() {
    clearTimeout(renderT);
    renderT = setTimeout(() => {
      if (!root || !scene) return;
      try { scene.update(); } catch (e) { console.error(e); }
      renderAlert(); checkEvents();
    }, 120);
  }

  // ------------------------------------------------------------------ popover de configuração
  function popContent() {
    const P = clear(el.pop);
    P.append(h('h4', {text: 'Cenas no rodízio'}));
    SCENES.forEach(([k, name]) => {
      const c = h('input', {type: 'checkbox'}); c.checked = cfg.scenes.includes(k);
      c.addEventListener('change', () => {
        const set = new Set(cfg.scenes); c.checked ? set.add(k) : set.delete(k);
        if (!set.size) { c.checked = true; return; }
        cfg.scenes = [...set].sort(); saveCfg(); show(0);
      });
      P.append(h('label', {}, c, name));
    });
    P.append(h('h4', {text: 'Tempo por cena', style: {marginTop: '1em'}}));
    const row = h('div', {class: 'row'});
    [[10, '10 s'], [15, '15 s'], [20, '20 s'], [30, '30 s'], [60, '1 min'], [0, 'Fixa']].forEach(([v, l]) =>
      row.append(h('button', {type: 'button', class: cfg.secs === v ? 'on' : '', text: l, onclick: () => { cfg.secs = v; saveCfg(); popContent(); schedule(); }})));
    P.append(row, h('div', {class: 'hint', text: 'Teclas: ← → cenas · espaço pausa · A dispensa alerta · S som · F tela cheia · Esc sai. URL: #tv?cenas=1,2&tempo=20&som=1'}));
  }

  // ------------------------------------------------------------------ abrir / fechar
  function fullscreen() {
    try { document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen(); } catch (_) { /* ok */ }
  }
  function wake() {
    if (!root) return;
    root.classList.remove('nocursor');
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (root && !el.pop.classList.contains('on')) root.classList.add('nocursor'); }, 4000);
  }
  function onKey(e) {
    if (!root) return;
    const k = e.key;
    if (k === 'Escape') { if (el.pop.classList.contains('on')) el.pop.classList.remove('on'); else close(); }
    else if (k === 'ArrowRight') step(1);
    else if (k === 'ArrowLeft') step(-1);
    else if (k === ' ') { e.preventDefault(); setPaused(!paused); }
    else if (k === 'a' || k === 'A') { activeAlerts().forEach(i => dismissed.add(i.id)); renderAlert(); }
    else if (k === 's' || k === 'S') setSound(!sound);
    else if (k === 'f' || k === 'F') fullscreen();
    else return;
    e.stopPropagation();
  }
  const onSnap = () => render();
  function tickClock() {
    if (!root) return;
    const d = new Date();
    el.clock.firstChild.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    el.clock.lastChild.textContent = `${WD[d.getDay()]}, ${d.getDate()} de ${MO[d.getMonth()]}`;
    const o = S.overview;
    el.live.classList.toggle('bad', !!(o && o.internet_online === false));
    el.live.lastChild.textContent = o && o.internet_online === false ? 'SEM INTERNET' : 'AO VIVO';
    const dEl = el.alert.querySelector('.dur[data-since]');
    if (dEl) dEl.textContent = dur(Date.now() / 1000 - Number(dEl.dataset.since));
  }

  function open() {
    if (root) return;
    const u = urlParams();
    if (u.scenes) cfg.scenes = u.scenes;
    if (u.secs != null) cfg.secs = u.secs;
    if (u.sound) sound = true;
    // DVR configurado: a cena Câmeras entra no rodízio automaticamente (uma vez; se desmarcar, fica desmarcada)
    if (!cfg.camAuto && !u.scenes) {
      api('/api/cam/status').then(st => {
        if (!st || !st.enabled || !root) return;
        cfg.camAuto = true;
        if (!cfg.scenes.includes(5)) { cfg.scenes = [...cfg.scenes, 5].sort(); dots(); el.sname.textContent = `cena ${idx + 1}/${cfg.scenes.length}`; }
        saveCfg();
      }).catch(() => { /* sem DVR */ });
    }
    if (window.NN.closeSheet) window.NN.closeSheet();
    const btn = (icon, title, fn) => { const b = h('button', {type: 'button', title, 'aria-label': title, onclick: fn}); b.innerHTML = ICO(icon); return b; };
    el.clock = h('div', {class: 'tvg-clock'}, h('b', {text: '--:--:--'}), h('span', {text: ''}));
    el.live = h('span', {class: 'tvg-live'}, h('i'), 'AO VIVO');
    el.scene = h('div', {class: 'tvg-scene tvg-glass'});
    el.stage = h('main', {class: 'tvg-stage'});
    el.dots = h('div', {class: 'tvg-dots tvg-glass'});
    el.sname = h('span', {class: 'tvg-sname'});
    el.pp = btn('pause', 'Pausar (espaço)', () => setPaused(!paused));
    el.snd = btn('bellOff', 'Som de alerta (S)', () => setSound(!sound));
    el.pop = h('div', {class: 'tvg-pop tvg-glass'});
    el.alert = h('div', {class: 'tvg-alert', role: 'alert'});
    el.toast = h('div', {class: 'tvg-toast tvg-glass', role: 'status'});
    const logo = h('div', {class: 'tvg-logo'}); logo.innerHTML = ICO('activity');
    root = h('div', {class: 'tvg', role: 'dialog', 'aria-label': 'Modo TV'},
      h('div', {class: 'bg', 'aria-hidden': 'true'}),
      h('header', {class: 'tvg-top'},
        h('div', {class: 'tvg-brand'}, logo, h('div', {class: 'tvg-name'}, window.APP_NAME || 'NetNOC', h('small', {text: 'MODO TV'})), el.live),
        el.scene, el.clock),
      el.stage,
      h('footer', {class: 'tvg-foot'}, el.sname, el.dots,
        h('div', {class: 'tvg-ctl'}, btn('left', 'Cena anterior (←)', () => step(-1)), el.pp, btn('chevron', 'Próxima cena (→)', () => step(1)),
          el.snd, btn('gear', 'Configurar cenas', () => { popContent(); el.pop.classList.toggle('on'); }),
          btn('max', 'Tela cheia (F)', fullscreen), btn('x', 'Sair (Esc)', close))),
      el.pop, el.toast, el.alert);
    document.body.append(root);
    document.body.classList.add('tvg-on');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('nn:snapshot', onSnap);
    root.addEventListener('mousemove', wake); root.addEventListener('click', wake);
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); } catch (_) { /* ok */ }
    ctlState(); wake(); tickClock();
    ticks.push(setInterval(tickClock, 1000));
    ticks.push(setInterval(() => refresh().then(render), 5000));
    last = {};
    show(0);
    refresh().then(() => { seen = null; render(); });
  }
  function close() {
    if (!root) return;
    clearTimeout(timer); clearTimeout(hideT); clearTimeout(renderT); clearTimeout(toastT);
    ticks.forEach(clearInterval); ticks = [];
    if (scene && scene.stop) scene.stop();
    if (chart) { try { chart.destroy(); } catch (_) { /* ok */ } chart = null; }
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('nn:snapshot', onSnap);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) { /* ok */ }
    try { if (wakeLock) wakeLock.release(); } catch (_) { /* ok */ }
    wakeLock = null;
    root.remove(); root = null; scene = null; alertId = null;
    document.body.classList.remove('tvg-on');
    if (/^#tv/.test(location.hash)) { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* ok */ } }
  }

  window.NetnocTV = {open, close, toggle: () => (root ? close() : open()), isOpen: () => !!root};
  if (/^#tv/.test(location.hash)) window.addEventListener('load', () => setTimeout(open, 900));
})();
