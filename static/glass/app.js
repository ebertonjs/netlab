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

  // ------------------------------------------------------------------ erros (v3.14)
  // Rede de segurança: um erro solto num gráfico/tela não derruba a interface nem fica mudo.
  // Vai para o console sempre; na tela, no máximo um aviso a cada 30 s.
  let lastErrToast = 0;
  function reportError(msg, err) {
    const text = String(msg || (err && err.message) || err || '');
    if (!text || /ResizeObserver loop|Script error\.?$|AbortError|Load failed|Failed to fetch|NetworkError/.test(text)) return;
    console.error('[netnoc]', text, err || '');
    const now = Date.now();
    if (now - lastErrToast < 30000 || !document.getElementById('toasts')) return;
    lastErrToast = now;
    toast('Algo falhou nesta tela: ' + text.slice(0, 120), 'error');
  }
  window.addEventListener('error', e => reportError(e.message, e.error));
  window.addEventListener('unhandledrejection', e => reportError(e.reason && e.reason.message, e.reason));
  /** Substituto de um gráfico que falhou: aceita qualquer leitura/escrita/chamada (c.options.plugins.legend.display = …,
   *  c.data.datasets[0].data = …, c.update()) sem lançar, para o resto da tela seguir desenhando. */
  function chartStub() {
    const handler = {
      get(t, k) {
        if (k === 'then') return undefined;                       // não é uma Promise
        if (k === Symbol.iterator) return function* () { /* vazio */ };
        if (k === Symbol.toPrimitive) return () => '';
        if (k === 'length') return 0;
        if (!(k in t.v)) t.v[k] = node();
        return t.v[k];
      },
      set(t, k, v) { t.v[k] = v; return true; },
      apply() { return undefined; },
    };
    function node() { const f = () => {}; f.v = {}; return new Proxy(f, handler); }
    return node();
  }
  /** Executa fn; se lançar, troca o conteúdo de `el` por um aviso em vez de deixar o bloco vazio/quebrado. */
  function safe(el, fn, label) {
    try { return fn(); } catch (e) {
      console.error('[netnoc]', label || '', e);
      if (el) { el.textContent = ''; el.append(h('div', {class: 'callout', text: (label ? label + ': ' : '') + 'não foi possível mostrar (' + e.message + ')'})); }
      return null;
    }
  }

  // ------------------------------------------------------------------ formatação
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : (v != null && v !== '' && isFinite(+v) ? +v : null);
  const ms = (v, d) => { v = num(v); return v == null ? '--' : (v >= 100 ? Math.round(v) : v.toFixed(d == null ? 1 : d)); };
  const pct = (v, d) => {
    v = num(v);
    if (v == null) return '--';
    if (v >= 99.995 && d !== 0) return '100';
    const dd = d == null ? 1 : d, t = v.toFixed(dd);
    // 99,96% não pode aparecer como "100.0%": abaixo de 100 arredonda para baixo (99.9)
    return (v < 100 && parseFloat(t) >= 100) ? (Math.floor(v * 10 ** dd) / 10 ** dd).toFixed(dd) : t;
  };
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
  const S = {overview: null, active: [], targets: [], spark: {}, system: null, me: null, cam: null};
  window.NN = {h, clear, api, post, del, toast, safe, reportError, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, hue, isLocal, sparkArea, S, $};

  // ------------------------------------------------------------------ data e rede (topo)
  const WD = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  const MO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  function tick() {
    const d = new Date();
    $('dateLine').textContent = `${WD[d.getDay()]}, ${d.getDate()} de ${MO[d.getMonth()]}`;
  }
  function renderSub() {
    const ip = S.overview && S.overview.public_ip;
    $('subLine').textContent = (window.APP_NAME || 'NetNOC') + (ip ? ' · ' + ip : '');
  }

  // falha da própria coleta (MikroTik, AdGuard…) vira um aviso discreto no topo
  function renderCollectWarn() {
    let b = $('collectWarn');
    if (!b) {
      b = h('button', {class: 'chip warn h2-warn', id: 'collectWarn', type: 'button', hidden: true, onclick: () => openSheet('config')});
      $('me').insertBefore(b, $('me').firstChild);
    }
    const ws = (S.system && S.system.workers) || [];
    const bad = ws.filter(w => w.status === 'error' || w.status === 'stalled');
    b.hidden = !bad.length;
    if (!bad.length) return;
    b.className = 'chip h2-warn ' + (bad.some(w => w.status === 'stalled') ? 'bad' : 'warn');
    b.title = bad.map(w => `${w.name}: ${w.status === 'stalled' ? 'parado' : (w.error || 'falha')}`).join('\n') + '\n\nAbrir Configurações';
    b.setAttribute('aria-label', `${bad.length} ${bad.length > 1 ? 'coletas' : 'coleta'} com falha`);
    clear(b).append(h('span', {trusted: ICO('alert')}), h('b', {text: String(bad.length)}),
      h('span', {class: 't', text: ` ${bad.length > 1 ? 'coletas' : 'coleta'} com falha`}));
  }

  // ------------------------------------------------------------------ cards
  const cardEls = {}, grpEls = {};
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
    if (!S.targets.length) {
      [...grid.children].forEach(ch => { if (ch !== head) ch.remove(); });
      if (grid.firstChild !== head) grid.insertBefore(head, grid.firstChild);
      grid.append(h('div', {class: 'card glass', style: {display: 'grid', placeItems: 'center', cursor: 'pointer'},
        onclick: () => openSheet('config')}, h('span', {text: 'Nenhum destino. Toque para adicionar.'})));
      return;
    }
    // estado de cada destino primeiro (para poder ordenar: com problema na frente, na página inicial nova)
    const info = S.targets.map(t => {
      const L = live[t.name] || {};
      const raw = L.online != null ? L.online : t.online;
      const loss = L.loss_pct != null ? L.loss_pct : t.loss_pct;
      // offline só com queda confirmada (incidente aberto ou ≥50% de perda); um ping perdido não pinta o card de vermelho
      const down = S.active.some(i => i.type === 'offline' && i.target === t.name) || (raw === false && (loss || 0) >= 50);
      return {t, L, raw, loss, down};
    });
    let order = info, groups = null;
    {
      const prob = l => l.slice().sort((x, y) => (y.down - x.down) || ((y.loss || 0) > 5) - ((x.loss || 0) > 5));
      groups = [['Internet', prob(info.filter(x => !isLocal(x.t)))], ['Rede local', prob(info.filter(x => isLocal(x.t)))]].filter(g => g[1].length);
      order = groups.flatMap(g => g[1]);
    }
    const cardOf = t => (cardEls[t.name] || (cardEls[t.name] = buildCard(t))).card;
    const seq = [head];
    if (groups && groups.length > 1) {
      for (const [name, l] of groups) {
        const g = grpEls[name] || (grpEls[name] = h('div', {class: 'grid-grp'}, h('b', {text: name}), h('span')));
        const ok = l.filter(x => !x.down).length;
        g.lastChild.textContent = `${ok}/${l.length} ok`;
        g.classList.toggle('bad', ok < l.length);
        seq.push(g, ...l.map(x => cardOf(x.t)));
      }
    } else order.forEach(x => seq.push(cardOf(x.t)));
    const keep = new Set(seq);
    [...grid.children].forEach(ch => { if (!keep.has(ch)) ch.remove(); });
    seq.forEach((n, i) => { if (grid.children[i] !== n) grid.insertBefore(n, grid.children[i] || null); });
    order.forEach(({t, L, raw, loss, down}) => {
      const c = cardEls[t.name];
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
    ['home', 'home', 'Início'], ['latency', 'activity', 'Latência'], ['incidents', 'alert', 'Incidentes'], ['cameras', 'camera', 'Câmeras'],
    ['dns', 'dns', 'DNS'], ['mikrotik', 'router', 'MikroTik'], ['adguard', 'shield', 'AdGuard'],
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
      chart(el, cfg) {
        // gráfico que falha (Chart.js ausente, dado estranho) vira aviso no lugar; a tela continua
        try { const c = new Chart(el, cfg); ctx.charts.push(c); return c; } catch (e) {
          console.error('[netnoc] gráfico', id, e);
          const box = el && el.parentElement;
          if (box) { el.remove(); box.append(h('div', {class: 'callout', text: 'Gráfico indisponível (' + e.message + ')'})); }
          const stub = chartStub(); ctx.charts.push(stub); return stub;    // ctx.charts[i] continua válido
        }
      },
      reopen(p) { openSheet(id, Object.assign({}, ctx.params, p || {})); }};
    cur = ctx;
    $('sheetWrap').hidden = false;
    document.body.classList.add('sheet-open');
    markDock(id);
    try { history.replaceState(null, '', location.pathname + location.search + '#' + id + (params && params.name ? '/' + encodeURIComponent(params.name) : '')); } catch (_) { /* ok */ }
    Promise.resolve().then(() => def.render(ctx)).catch(e => {
      console.error('[netnoc] tela', id, e);
      if (!ctx.alive) return;
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
    const [sys, cam] = await Promise.all([api('/api/system').catch(() => null), api('/api/cam/status').catch(() => null)]);
    S.system = sys; S.cam = cam;
    each(renderCards, renderCollectWarn);
  }
  // cada bloco desenha sozinho: um que falhe não impede os outros (o erro vai para o console)
  function each(...fns) { for (const f of fns) { try { f(); } catch (e) { reportError((f.name || 'bloco') + ': ' + e.message, e); } } }
  function applySnapshot(snap) {
    if (!snap) return;
    S.overview = snap.overview; S.active = snap.incidents || [];
    window.__lastSnapshot = snap;
    each(renderSub, renderCards);
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
    tick(); setInterval(tick, 30000);
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
