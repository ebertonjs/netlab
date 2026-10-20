// NetNOC v3 — núcleo da interface glass: estado, helpers, home, dock, sheets, tempo real.
'use strict';
(function () {
  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------------ DOM seguro
  // h('div', {class:'x', text:'...', onclick:fn}, filho1, 'texto', ...)  — nunca innerHTML com dados.
  function h(tag, attrs, ...kids) {
    const ns = tag.startsWith('svg:') ? 'http://www.w3.org/2000/svg' : null;
    const el = ns ? document.createElementNS(ns, tag.slice(4)) : document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.setAttribute('class', v);
        else if (k === 'text') el.textContent = v;
        else if (k === 'icon') el.insertAdjacentHTML('afterbegin', ICO(v));     // ícone estático
        else if (k === 'trusted') el.insertAdjacentHTML('beforeend', v);        // só constantes do código
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k in el && !ns && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  async function api(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { /* ok */ }
    if (!r.ok) throw new Error((j && j.detail) || ('HTTP ' + r.status));
    return j;
  }
  const post = (url, body) => api(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body || {})});
  const del = url => api(url, {method: 'DELETE'});

  function toast(msg, kind) {
    const t = h('div', {class: 'toast' + (kind === 'error' ? ' error' : ''), text: msg});
    $('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
  }

  // ------------------------------------------------------------------ formatação
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : (v != null && v !== '' && isFinite(+v) ? +v : null);
  const ms = (v, d) => { v = num(v); return v == null ? '--' : (v >= 100 ? Math.round(v) : v.toFixed(d == null ? 1 : d)); };
  const pct = (v, d) => { v = num(v); return v == null ? '--' : (v >= 99.995 && d !== 0 ? '100' : v.toFixed(d == null ? 1 : d)); };
  const pad = n => String(n).padStart(2, '0');
  const hm = ts => { const d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const dmhm = ts => { const d = new Date(ts * 1000); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hm(ts); };
  function dur(s) {
    s = Math.max(0, Math.round(num(s) || 0));
    const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + hh + 'h';
    if (hh) return hh + 'h' + pad(m);
    if (m) return m + 'min';
    return s + 's';
  }
  const ago = ts => ts ? dur(Date.now() / 1000 - ts) + ' atrás' : '--';
  function bps(v) {
    v = num(v); if (v == null) return '--';
    const u = ['bps', 'kbps', 'Mbps', 'Gbps']; let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }
  const sevClass = s => ({Alta: 'alta', Media: 'media', Baixa: 'baixa', Info: 'info'}[s] || 'info');

  // ------------------------------------------------------------------ ícones de marca
  const BRAND_RULES = [
    [/google/i, 'google'], [/cloudflare/i, 'cloudflare'], [/quad9/i, 'shield'], [/instagram/i, 'instagram'],
    [/facebook/i, 'facebook'], [/whatsapp/i, 'whatsapp'], [/(twitter|\bx\.com)/i, 'x'], [/tiktok/i, 'tiktok'],
    [/youtube/i, 'youtube'], [/netflix/i, 'netflix'], [/discord/i, 'discord'], [/steam/i, 'steam'],
    [/valorant/i, 'valorant'], [/\briot/i, 'riotgames'], [/(mikrotik|routeros)/i, 'mikrotik'],
    [/\b(gateway|router|roteador|onu|olt)\b/i, 'gateway'], [/\b(vps|server|servidor)\b/i, 'server'], [/\bnas\b/i, 'nas'],
  ];
  const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  function brandKey(name, host) {
    const hay = (name || '') + ' ' + (host || '');
    for (const [re, k] of BRAND_RULES) if (re.test(hay)) return k;
    return (host && PRIVATE_IP.test(host)) ? 'server' : 'globe';
  }
  const brandSvg = (name, host) => (typeof BRAND_ICONS !== 'undefined' && BRAND_ICONS[brandKey(name, host)]) || '';
  function hue(str) { let x = 0; for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; }
  const isLocal = t => PRIVATE_IP.test(String(t.host || '').replace(/^https?:\/\//, ''));

  // ------------------------------------------------------------------ sparkline SVG
  function sparkArea(vals, w, h0, color) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h0}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const raw = (vals || []).map(num);
    // média móvel de 3 pontos: o desenho fica "orgânico" como na referência, sem esconder picos grandes
    const nums = raw.map((v, i) => {
      if (v == null) return null;
      const win = [raw[i - 1], v, raw[i + 1]].filter(x => x != null);
      return win.reduce((a, b) => a + b, 0) / win.length;
    });
    const ok = nums.filter(v => v != null);
    if (ok.length < 2) return svg;
    const mn = Math.min(...ok), mx = Math.max(...ok), rng = Math.max(mx - mn, mx * 0.15, 0.5);
    const step = w / (nums.length - 1);
    const pts = [];
    nums.forEach((v, i) => { if (v != null) pts.push([i * step, h0 - 8 - ((v - mn) / rng) * (h0 - 22)]); });
    const f = n => n.toFixed(1);
    let d = 'M' + f(pts[0][0]) + ' ' + f(pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
    }
    const first = pts[0][0], last = pts[pts.length - 1][0];
    const gid = 'g' + Math.random().toString(36).slice(2, 8);
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".45"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', d + `L${last} ${h0}L${first} ${h0}Z`);
    area.setAttribute('fill', `url(#${gid})`); area.setAttribute('class', 'area');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', d); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '2'); line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(defs, area, line);
    return svg;
  }

  // ------------------------------------------------------------------ estado
  const S = {
    overview: null, active: [], targets: [], spark: {}, system: null, me: null,
    mikrotik: null, agh: null, recent: [], bars: {}, hist: [], dnsWorst: null,
  };
  window.NN = {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, hue, isLocal, sparkArea, S, $};

  // ------------------------------------------------------------------ relógio / data
  const WD = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  const MO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  function tick() {
    const d = new Date();
    $('clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    $('dateLine').textContent = `${WD[d.getDay()]}, ${d.getDate()} de ${MO[d.getMonth()]}`;
  }
  function renderSub() {
    const ip = S.overview && S.overview.public_ip;
    $('subLine').textContent = (window.APP_NAME || 'NetNOC') + (ip ? ' · ' + ip : '');
  }

  // ------------------------------------------------------------------ coluna esquerda
  function renderNow() {
    const o = S.overview;
    const online = o ? o.internet_online : null;
    const icon = $('netIcon');
    icon.innerHTML = ICO(online === false ? 'wifiOff' : 'wifi');
    icon.firstChild.style.color = online === false ? 'var(--red)' : 'var(--orange)';
    icon.firstChild.setAttribute('stroke-width', '1.6');
    $('netLat').textContent = o ? ms(o.avg_latency) : '--';
    const lats = o ? Object.values(o.targets || {}).map(t => num(t.latency)).filter(v => v != null) : [];
    $('netSub').textContent = lats.length
      ? `↑ ${ms(Math.max(...lats))}  ↓ ${ms(Math.min(...lats))} · jitter ${ms(o.avg_jitter)}`
      : (online === false ? 'sem resposta' : 'aguardando dados');
  }

  function renderHours() {
    const el = clear($('hours'));
    // latência média por hora (últimas 5 h) + disponibilidade média das barras horárias
    const byHour = {};
    for (const p of S.hist) {
      const hh = Math.floor(p.ts / 3600) * 3600;
      const a = byHour[hh] || (byHour[hh] = [0, 0]);
      a[0] += p.latency; a[1]++;
    }
    const now = Math.floor(Date.now() / 3600000) * 3600;
    const rows = [];
    for (let i = 4; i >= 0; i--) {
      const hh = now - i * 3600;
      const a = byHour[hh];
      const ups = [];
      for (const bars of Object.values(S.bars)) {
        const b = bars.find(x => x.ts === hh + 3600);
        if (b && b.pct != null) ups.push(b.pct);
      }
      rows.push({hh, lat: a ? a[0] / a[1] : null, up: ups.length ? ups.reduce((x, y) => x + y, 0) / ups.length : null});
    }
    const lv = rows.map(r => r.lat).filter(v => v != null);
    const mn = Math.min(...lv), mx = Math.max(...lv), rng = (mx - mn) || 1;
    for (const r of rows) {
      const bad = r.up != null && r.up < 99;
      const pos = r.lat == null ? 0 : 6 + 88 * (r.lat - mn) / rng;
      const knob = h('span', {class: 'knob', style: {left: pos + '%'}});
      el.append(h('div', {class: 'hour'},
        h('span', {class: 't', text: hm(r.hh)}),
        h('span', {class: 'ico', trusted: ICO(bad ? 'alert' : 'activity'), style: {color: bad ? 'var(--yellow)' : 'var(--orange)'}}),
        h('span', {class: 'v', text: r.lat == null ? '--' : ms(r.lat) + ' ms'}),
        h('span', {class: 'track'}, r.lat == null ? null : knob),
        h('span', {class: 'u', text: r.up == null ? '--' : pct(r.up) + '%'})));
    }
  }

  function renderAgenda() {
    const el = clear($('agenda'));
    el.append(h('h4', {text: 'Agora'}));
    if (!S.active.length) el.append(h('div', {class: 'empty', text: 'Nenhum incidente ativo ✓'}));
    for (const i of S.active.slice(0, 5)) {
      el.append(h('div', {class: 'ev ' + sevClass(i.severity), onclick: () => openSheet('incidents')},
        h('span', {class: 'b'}), h('span', {class: 'w', text: hm(i.started_ts)}),
        h('span', {class: 'm', text: i.message, title: i.message})));
    }
    const rec = S.recent.filter(i => i.resolved_ts).slice(0, 3);
    if (rec.length) {
      el.append(h('h4', {text: 'Resolvidos hoje'}));
      for (const i of rec) {
        el.append(h('div', {class: 'ev', onclick: () => openSheet('incidents')},
          h('span', {class: 'b', style: {background: 'var(--green)'}}), h('span', {class: 'w', text: hm(i.resolved_ts)}),
          h('span', {class: 'm', text: `${i.target} · ${dur(i.resolved_ts - i.started_ts)}`})));
      }
    }
  }

  // ------------------------------------------------------------------ chips
  function chip(icon, text, opts) {
    opts = opts || {};
    const c = h('button', {class: 'chip' + (opts.cls ? ' ' + opts.cls : ''), type: 'button', title: opts.title || '',
      onclick: opts.open ? () => openSheet(opts.open) : null});
    if (icon === 'dot') c.append(h('span', {class: 'dot'}));
    else c.insertAdjacentHTML('afterbegin', ICO(icon));
    c.append(h('span', {text}));
    return c;
  }
  function renderChips() {
    const el = clear($('chips'));
    const o = S.overview, s = S.system;
    if (o) {
      el.append(chip('dot', o.internet_online ? 'Internet OK' : 'Internet fora',
        {cls: o.internet_online ? '' : 'bad', open: 'latency', title: 'Pelo menos um destino respondendo'}));
      el.append(chip('up', ms(o.avg_latency) + ' ms', {open: 'latency', title: 'Latência média'}));
      el.append(chip('loss', pct(o.avg_loss_pct) + '% perda', {open: 'latency', cls: (o.avg_loss_pct || 0) > 2 ? 'warn' : ''}));
    }
    if (S.active.length) el.append(chip('alert', S.active.length + ' incidente' + (S.active.length > 1 ? 's' : ''), {open: 'incidents'}));
    if (s) {
      el.append(chip('cpu', pct(s.cpu_pct, 0) + '%', {open: 'config', title: 'CPU do ' + s.host_label}));
      if (s.temp_c != null) el.append(chip('thermo', pct(s.temp_c, 1) + ' °C', {open: 'config', cls: s.temp_c > 70 ? 'warn' : ''}));
      const ws = s.workers || [];
      const stalled = ws.filter(w => w.status === 'stalled').map(w => w.name);
      const failing = ws.filter(w => w.status === 'error').map(w => w.name);
      if (stalled.length) el.append(chip('alert', 'Coletor parado: ' + stalled.join(', '), {cls: 'bad', open: 'config'}));
      if (failing.length) el.append(chip('alert', 'Falha na coleta: ' + failing.join(', '), {cls: 'warn', open: 'config'}));
    }
    if (S.mikrotik && S.mikrotik.enabled) {
      el.append(chip('router', S.mikrotik.cpu_load != null ? 'MikroTik ' + Math.round(S.mikrotik.cpu_load) + '%' : 'MikroTik',
        {open: 'mikrotik', cls: S.mikrotik.stale ? 'dim' : ''}));
    }
    if (S.agh && S.agh.blocked_pct != null) el.append(chip('shield', 'AdGuard ' + pct(S.agh.blocked_pct) + '%', {open: 'adguard', title: '% bloqueado'}));
    if (S.dnsWorst != null && S.dnsWorst > 150) el.append(chip('globe', 'DNS lento ' + ms(S.dnsWorst, 0) + ' ms', {open: 'dns', cls: 'warn'}));
  }

  // ------------------------------------------------------------------ cards
  const cardEls = {};
  const C = n => window.SKIN.col(n);
  function cardColor() { return C('--spark'); }

  function buildCard(t) {
    const hu = hue(t.name);
    const art = h('div', {class: 'card-art'},
      h('div', {class: 'tint', style: {background:
        `radial-gradient(120% 90% at 85% 0%, hsla(${hu},70%,60%,.30), transparent 60%),` +
        `radial-gradient(90% 80% at 0% 0%, hsla(${(hu + 60) % 360},60%,55%,.18), transparent 60%)`}}),
      h('div', {class: 'brand', trusted: brandSvg(t.name, t.host)}),
      h('div', {class: 'spark-holder'}),
      h('div', {class: 'fade'}));
    const title = h('div', {class: 'card-title'}, h('span', {text: t.name}), h('span', {trusted: ICO('chevron')}),
      h('span', {class: 'kind', text: (t.type || 'icmp').toUpperCase()}));
    const host = h('div', {class: 'card-host', text: t.host});
    const row = h('div', {class: 'card-row'});
    const card = h('article', {class: 'card glass', tabindex: '0', role: 'button', 'aria-label': 'Detalhes de ' + t.name,
      onclick: () => openSheet('target', {name: t.name}),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('target', {name: t.name}); } }},
    art, title, host, row);
    card.style.animationDelay = (Object.keys(cardEls).length * 30) + 'ms';
    return {card, row, holder: art.querySelector('.spark-holder'), sig: ''};
  }

  function renderCards() {
    const grid = $('grid');
    const live = (S.overview && S.overview.targets) || {};
    const names = new Set(S.targets.map(t => t.name));
    for (const n of Object.keys(cardEls)) if (!names.has(n)) { cardEls[n].card.remove(); delete cardEls[n]; }
    if (!S.loaded) return;
    // cabeçalho de colunas: só aparece nas skins que mostram os destinos como tabela
    let head = grid.querySelector(':scope > .grid-head');
    if (!head) head = h('div', {class: 'grid-head', 'aria-hidden': 'true'},
      h('span', {text: 'Status'}), h('span', {text: 'Destino'}), h('span', {text: 'Host'}), h('span', {text: 'Latência (1 h)'}));
    const known = new Set(Object.values(cardEls).map(c => c.card));
    [...grid.children].forEach(ch => { if (!known.has(ch) && ch !== head) ch.remove(); });
    if (grid.firstChild !== head) grid.insertBefore(head, grid.firstChild);
    if (!S.targets.length) {
      grid.append(h('div', {class: 'card glass', style: {display: 'grid', placeItems: 'center', cursor: 'pointer'},
        onclick: () => openSheet('config')}, h('span', {text: 'Nenhum destino. Toque para adicionar.'})));
      return;
    }
    S.targets.forEach((t, i0) => {
      const i = i0 + 1;           // posição 0 é o cabeçalho
      let c = cardEls[t.name];
      if (!c) { c = cardEls[t.name] = buildCard(t); }
      if (grid.children[i] !== c.card) grid.insertBefore(c.card, grid.children[i] || null);
      const L = live[t.name] || {};
      const raw = L.online != null ? L.online : t.online;
      const loss = L.loss_pct != null ? L.loss_pct : t.loss_pct;
      // offline só com queda confirmada (incidente aberto ou ≥50% de perda); um ping perdido não pinta o card de vermelho
      const down = S.active.some(i => i.type === 'offline' && i.target === t.name) || (raw === false && (loss || 0) >= 50);
      const online = raw == null ? null : !down;
      const lat = raw === false ? (L.avg_latency != null ? L.avg_latency : t.latency) : (L.latency != null ? L.latency : t.latency);
      c.card.classList.toggle('off', online === false);
      const sig = [online, ms(lat), pct(loss, 0), pct(t.uptime_24h, 2)].join('|');
      if (sig !== c.sig) {
        c.sig = sig;
        clear(c.row).append(
          h('span', {class: 'rb ' + (online === false ? 'on-red' : online ? 'on-green' : ''), title: online === false ? 'Offline' : online ? 'Online' : 'Sem dados',
            trusted: ICO(online === false ? 'x' : online ? 'check' : 'minus')}),
          h('span', {class: 'pill', title: 'Latência atual'}, online === false ? '—' : ms(lat), h('small', {text: 'ms'})),
          h('span', {class: 'pill loss' + ((loss || 0) > 5 ? ' bad' : (loss || 0) > 0 ? ' warn' : ''), title: 'Perda de pacotes na janela', trusted: ICO('loss')},
            pct(loss, 0) + '%'),
          t.uptime_24h != null ? h('span', {class: 'pill up', title: 'Disponibilidade nas últimas 24 h', trusted: ICO('clock')}, pct(t.uptime_24h, 2) + '%') : null);
      }
      // destino que é o próprio DVR: a última imagem de uma câmera vira o fundo do card (atualiza a cada 5 min)
      if (S.cam && S.cam.enabled && S.cam.host && t.host === S.cam.host) {
        const ch = (S.cam.channels || []).find(x => !x.loss && x.last_good) || (S.cam.channels || [])[0];
        if (ch && (!c.camImg || Date.now() - (c.camTs || 0) > 300000)) {
          if (!c.camImg) {
            c.camImg = h('img', {class: 'cam-bg', alt: ''});
            c.camImg.addEventListener('error', () => { c.camImg.style.display = 'none'; });
            c.card.querySelector('.card-art').insertBefore(c.camImg, c.card.querySelector('.card-art .brand'));
          }
          c.camImg.style.display = '';
          c.camImg.src = `/api/cam/snapshot/${ch.ch}?last=1&t=${Date.now()}`;
          c.camTs = Date.now();
        }
      }
      const sv = S.spark[t.name];
      const ss = JSON.stringify(sv || []) + document.documentElement.dataset.theme;
      if (ss !== c.sparkSig) {
        c.sparkSig = ss;
        const svg = sparkArea(sv, 300, 96, online === false ? C('--red') : cardColor());
        svg.setAttribute('class', 'spark');
        clear(c.holder).append(svg);
      }
    });
    const dockInc = document.querySelector('.round[data-id="incidents"] .count');
    if (dockInc) { dockInc.textContent = S.active.length; dockInc.hidden = !S.active.length; }
  }

  // ------------------------------------------------------------------ dock
  const DOCK = [
    ['home', 'home', 'Início'], ['latency', 'activity', 'Latência'], ['incidents', 'alert', 'Incidentes'], ['cameras', 'video', 'Câmeras'],
    ['dns', 'globe', 'DNS'], ['mikrotik', 'router', 'MikroTik'], ['adguard', 'shield', 'AdGuard'],
    ['topology', 'network', 'Topologia'], ['tools', 'wrench', 'Ferramentas'], ['config', 'gear', 'Configurações'], ['sla', 'file', 'SLA'], ['tv', 'tv', 'Modo TV (T)'],
  ];
  function renderDock() {
    const el = clear($('dock'));
    DOCK.forEach(([id, ic, label], i) => {
      const key = i < 10 ? String((i + 1) % 10) : '';
      const b = h('button', {class: 'round glass', type: 'button', title: label + (key ? ` (${key})` : ''), 'aria-label': label, dataset: {id},
        onclick: () => (id === 'home' ? closeSheet() : id === 'tv' ? openTV() : openSheet(id))});
      b.insertAdjacentHTML('afterbegin', ICO(ic));
      // rótulo e tecla: escondidos no Glass, visíveis nas skins com barra/menu
      b.append(h('span', {class: 'lbl', text: label.replace(/ \(.\)$/, '')}));
      if (key) b.append(h('span', {class: 'key', text: key}));
      if (id === 'incidents') b.append(h('span', {class: 'count', hidden: true}));
      el.append(b);
    });
    markDock('home');
  }
  function openTV() {
    if (!window.NetnocTV) { toast('Modo TV indisponível', 'error'); return; }
    closeSheet();
    window.NetnocTV.toggle();
  }
  document.addEventListener('keydown', e => {
    if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') && !document.querySelector('.tvg')) openTV();
  });
  function markDock(id) {
    document.querySelectorAll('.dock .round').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  }

  // ------------------------------------------------------------------ sheets
  const SHEETS = {};
  let cur = null;
  function registerSheet(id, def) { SHEETS[id] = def; }

  function openSheet(id, params) {
    const def = SHEETS[id];
    if (!def) return;
    closeSheet(true);
    const body = clear($('sheetBody'));
    body.className = 'sheet-body' + (def.single ? ' single' : '');
    const tools = clear($('sheetTools'));
    $('sheetIco').innerHTML = ICO(def.icon);
    $('sheetTitle').textContent = typeof def.title === 'function' ? def.title(params || {}) : def.title;
    const ctx = {id, params: params || {}, body, tools, charts: [], timers: [], cleanups: [], alive: true,
      every(ms_, fn) { const t = setInterval(() => { if (ctx.alive) fn(); }, ms_); ctx.timers.push(t); return t; },
      chart(el, cfg) { const c = new Chart(el, cfg); ctx.charts.push(c); return c; },
      reopen(p) { openSheet(id, Object.assign({}, ctx.params, p || {})); }};
    cur = ctx;
    $('sheetWrap').hidden = false;
    document.body.classList.add('sheet-open');
    markDock(id);
    try { history.replaceState(null, '', location.pathname + location.search + '#' + id + (params && params.name ? '/' + encodeURIComponent(params.name) : '')); } catch (_) { /* ok */ }
    Promise.resolve().then(() => def.render(ctx)).catch(e => {
      body.append(h('div', {class: 'panel main'}, h('div', {class: 'callout', text: 'Erro ao carregar: ' + e.message})));
    });
  }
  function closeSheet(silent) {
    if (cur) {
      cur.alive = false;
      cur.timers.forEach(clearInterval);
      cur.charts.forEach(c => { try { c.destroy(); } catch (_) { /* ok */ } });
      cur.cleanups.forEach(f => { try { f(); } catch (_) { /* ok */ } });
      cur = null;
    }
    if (!silent) {
      $('sheetWrap').hidden = true;
      document.body.classList.remove('sheet-open');
      markDock('home');
      try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* ok */ }
    }
  }
  $('sheetClose').innerHTML = ICO('x');
  $('sheetClose').addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && cur) closeSheet(); });

  // ------------------------------------------------------------------ tema / usuário
  // ------------------------------------------------------------------ skin / modo
  function themeIcon() {
    const st = window.SKIN.get();
    const b = $('themeBtn');
    b.innerHTML = ICO(st.mode === 'dark' ? 'moon' : st.mode === 'light' ? 'sun' : 'layers');
    const modes = window.SKIN.LIST[st.skin].modes;
    const m = modes.find(x => x[0] === st.mode);
    b.title = `${window.SKIN.LIST[st.skin].name} · ${m ? m[1] : ''} — clique para alternar o modo`;
  }
  function onSkin() {
    themeIcon();
    for (const c of Object.values(cardEls)) c.sparkSig = '';
    renderCards();
    if (cur && SHEETS[cur.id]) cur.reopen();
  }
  document.addEventListener('nn:skin', onSkin);
  function setTheme(mode) { window.SKIN.set({mode}); }
  $('themeBtn').addEventListener('click', () => {
    const st = window.SKIN.get(), modes = window.SKIN.LIST[st.skin].modes.map(m => m[0]);
    setTheme(modes[(modes.indexOf(st.mode) + 1) % modes.length]);
  });
  // atalhos 1–0 abrem as seções do dock
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[0-9]$/.test(e.key) || document.querySelector('.tvg')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
    const i = (Number(e.key) + 9) % 10, d = DOCK[i];
    if (!d) return;
    if (d[0] === 'home') closeSheet(); else if (d[0] === 'tv') openTV(); else openSheet(d[0]);
  });
  $('userBtn').addEventListener('click', () => openSheet('config'));

  function renderMe() {
    const u = S.me || {};
    const b = clear($('userBtn'));
    b.append(h('span', {text: (u.user || '?').slice(0, 1).toUpperCase()}));
    b.append(h('span', {class: 'badge', style: {background: u.role === 'admin' ? 'var(--blue)' : 'var(--green)'}}));
    b.title = (u.user || '') + ' (' + (u.role || '') + ')';
  }

  // ------------------------------------------------------------------ dados
  async function loadTargets() {
    try {
      const [t, sp] = await Promise.all([api('/api/targets'), api('/api/sparklines').catch(() => ({}))]);
      S.targets = t; S.spark = sp; S.loaded = true;
      renderCards();
    } catch (e) { /* 401 já redireciona */ }
  }
  async function loadSlow() {
    const [sys, bars, hist, rec, mt, agh, dns, cam] = await Promise.all([
      api('/api/system').catch(() => null),
      api('/api/uptime/bars?hours=6').catch(() => ({})),
      api('/api/history/24h').catch(() => []),
      api('/api/incidents?days=1').catch(() => []),
      api('/api/mikrotik/status').catch(() => null),
      api('/api/agh/stats').catch(() => null),
      api('/api/dns').catch(() => []),
      api('/api/cam/status').catch(() => null),
    ]);
    S.system = sys; S.bars = bars || {}; S.hist = (hist || []).filter(p => p.ts >= Date.now() / 1000 - 6 * 3600);
    S.recent = rec || []; S.mikrotik = mt; S.agh = agh && agh.ts ? agh : null; S.cam = cam;
    renderCards();
    const dl = (dns || []).map(d => num(d.latency)).filter(v => v != null);
    S.dnsWorst = dl.length ? Math.max(...dl) : null;
    renderHours(); renderAgenda(); renderChips();
  }
  function applySnapshot(snap) {
    if (!snap) return;
    S.overview = snap.overview; S.active = snap.incidents || [];
    window.__lastSnapshot = snap;
    renderNow(); renderSub(); renderChips(); renderAgenda(); renderCards();
    document.dispatchEvent(new CustomEvent('nn:snapshot', {detail: snap}));
  }
  function startStream() {
    let es, backoff = 2000, poll = null;
    const fallback = () => { if (!poll) poll = setInterval(() => api('/api/snapshot').then(applySnapshot).catch(() => {}), 5000); };
    function connect() {
      try { es = new EventSource('/api/stream'); } catch (_) { fallback(); return; }
      es.onmessage = ev => { backoff = 2000; if (poll) { clearInterval(poll); poll = null; } try { applySnapshot(JSON.parse(ev.data)); } catch (_) { /* ok */ } };
      es.onerror = () => { es.close(); fallback(); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); };
    }
    connect();
  }

  async function init() {
    renderDock();
    themeIcon();
    window.SKIN.syncServer();
    tick(); setInterval(tick, 1000);
    for (let i = 0; i < 6; i++) $('grid').append(h('div', {class: 'skeleton'}));
    try {
      const [me, info] = await Promise.all([api('/api/me'), api('/api/settings/appname').catch(() => null)]);
      S.me = me;
      if (info && info.name) {
        window.APP_NAME = info.name;
        document.title = info.name;
        try { localStorage.setItem('netnoc_app_name', info.name); } catch (_) { /* ok */ }
      }
    } catch (_) { return; }
    renderMe(); renderSub();
    clear($('grid'));
    await api('/api/snapshot').then(applySnapshot).catch(() => {});
    await loadTargets();
    loadSlow();
    startStream();
    setInterval(loadTargets, 15000);
    setInterval(loadSlow, 60000);
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash) { const [id, name] = hash.split('/'); if (SHEETS[id]) openSheet(id, name ? {name} : undefined); }
  }

  Object.assign(window.NN, {registerSheet, openSheet, closeSheet, loadTargets, loadSlow, renderCards, setTheme,
    isAdmin: () => S.me && S.me.role === 'admin'});
  window.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
})();
