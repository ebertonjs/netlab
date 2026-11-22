// NetNOC v4.0 — página inicial: estado da rede e causa, 4 números ao vivo, linha do tempo e blocos de detalhes
// (disponibilidade, MikroTik com o pico da WAN, DNS, AdGuard, servidor, câmeras, mapa de incidentes).
// Uma chamada (/api/home) a cada 30 s; os números e a chegada de incidentes vêm pelo tempo real (SSE).
'use strict';
(function () {
  const {h, clear, api, ms, pct, hm, dmhm, dur, bps, num, openSheet, $} = window.NN;
  const ICON = (n, cls) => h('span', {class: cls || '', trusted: ICO(n)});
  let D = null, camTimer = null, camIdx = 0;

  // ------------------------------------------------------------------ helpers
  const lab = (icon, text, right) => h('div', {class: 'hx-lab'}, ICON(icon), h('span', {text}),
    right != null ? h('span', {class: 'hx-r'}, right) : null);
  const bar = (v, cls) => h('div', {class: 'hx-bar'}, h('i', {class: cls || '', style: {width: Math.max(0, Math.min(100, v || 0)) + '%'}}));
  const level = (v, warn, bad) => v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok';
  const since = ts => ts ? dur(Date.now() / 1000 - ts) : '--';
  const WDS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

  // ------------------------------------------------------------------ 0. a rede contada (linha do tempo narrativa)
  const openEp = new Set();
  let diagBox = null;
  const LV = {bad: 'red', warn: 'yellow', info: 'blue', ok: 'green'};
  function when(ts) {
    const d = new Date(ts * 1000), t = new Date();
    const y = new Date(t); y.setDate(t.getDate() - 1);
    const p = n => String(n).padStart(2, '0');
    const hhmm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === t.toDateString()) return hhmm;
    if (d.toDateString() === y.toDateString()) return 'ontem ' + hhmm;
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + hhmm;
  }
  function evList(ev, tips) {
    const box = h('div', {class: 'st-ev'});
    for (const e of ev || []) box.append(h('div', {class: 'e ' + (e.ok === true ? 'ok' : e.ok === false ? 'bad' : '')}, h('i'), h('span', {text: e.txt})));
    if (tips && tips.length) box.append(h('div', {class: 'tips'}, ...tips.map(t => h('div', {text: '→ ' + t}))));
    return box;
  }
  async function runDiag(btn) {
    btn.disabled = true; btn.lastChild.textContent = ' Investigando…';
    diagBox = {loading: true}; render();
    try { diagBox = await window.NN.post('/api/diagnose', {}); } catch (e) { diagBox = {error: e.message}; }
    btn.disabled = false; render();
  }
  function renderStory(el) {
    const S = D.story;
    if (!S) { el.hidden = true; return; }
    el.classList.add('st-' + S.state);
    const btn = h('button', {class: 'tbtn st-btn', type: 'button', title: 'Gateway, internet, DNS, MikroTik e traceroute agora'}, ICON('search'), ' Diagnosticar agora');
    btn.onclick = () => runDiag(btn);
    el.append(h('div', {class: 'st-head'},
      h('span', {class: 'st-dot ' + (LV[S.state] || '')}),
      h('div', {class: 'st-txt'}, h('div', {class: 'st-h', text: S.headline}), h('div', {class: 'st-s', text: S.sub}),
        h('div', {class: 'st-d', text: S.day})),
      btn));
    if (diagBox) {
      const d = diagBox;
      const b = h('div', {class: 'st-diag'});
      if (d.loading) b.append(h('div', {class: 'hint', text: 'Pingando gateway e internet, testando DNS, consultando o MikroTik…'}));
      else if (d.error) b.append(h('div', {class: 'callout', text: d.error}));
      else b.append(h('div', {class: 'st-dt'}, h('b', {text: d.title}), h('span', {class: 'conf', text: 'confiança ' + d.confidence + ' · ' + d.secs + ' s'}),
        h('button', {class: 'st-x', type: 'button', title: 'Fechar', trusted: ICO('x'), onclick: () => { diagBox = null; render(); }})),
      d.text ? h('p', {text: d.text}) : null, evList(d.evidence, d.tips));
      el.append(b);
    }
    if (S.insights && S.insights.length) el.append(h('div', {class: 'st-ins'}, ...S.insights.map(t => h('span', {}, ICON('clock'), t))));
    const tl = h('div', {class: 'st-tl'});
    for (const e of S.episodes || []) {
      const key = e.diag_id ? 'd' + e.diag_id : 'i' + e.start + e.title;
      const isOpen = openEp.has(key);
      const row = h('div', {class: 'st-ep ' + e.level + (e.open ? ' live' : '') + (isOpen ? ' open' : ''),
        onclick: () => { isOpen ? openEp.delete(key) : openEp.add(key); render(); }},
      h('div', {class: 'st-when'}, h('b', {text: when(e.start)}), h('span', {text: e.open ? 'há ' + dur(e.duration_s) : dur(e.duration_s)})),
      h('i', {class: 'st-pin'}),
      h('div', {class: 'st-body'}, h('div', {class: 'st-t', text: e.title}),
        e.cause ? h('div', {class: 'st-c'}, ICON('search'), e.cause)
          : e.pending ? h('div', {class: 'st-c none'}, ICON('search'), 'investigando a causa…')
            : (e.kind === 'gap' ? null : h('div', {class: 'st-c none', text: 'sem diagnóstico'})),
        isOpen && e.text ? h('p', {text: e.text}) : null,
        isOpen && e.evidence ? evList(e.evidence, e.tips) : null,
        isOpen && e.kind !== 'gap' ? h('button', {class: 'tbtn st-map', type: 'button', onclick: ev => { ev.stopPropagation();
          openSheet('topology', {view: 'mapa', at: Math.round(e.start + 45)}); }}, ICON('map'), ' Ver o mapa nesse momento') : null));
      tl.append(row);
    }
    if (!tl.children.length) tl.append(h('div', {class: 'st-empty', text: 'Nada aconteceu nas últimas 48 horas.'}));
    else if (S.total > S.episodes.length) tl.append(h('div', {class: 'hint', text: `+ ${S.total - S.episodes.length} anteriores em Incidentes`}));
    el.append(tl);
  }

  // ------------------------------------------------------------------ 2. disponibilidade por destino
  function renderAvail(el) {
    const A = D.avail || [];
    el.append(lab('grid', 'Disponibilidade por destino · 24 h', 'cada quadrado = 30 min'));
    const box = h('div', {class: 'hx-av'});
    const ST = {ok: 'ok', warn: 'lento ou perda leve', bad: 'fora do ar', iso: 'isolado (o equipamento pai caiu)'};
    for (const t of A) {
      const cells = h('div', {class: 'hx-cells'});
      for (const b of t.blocks) {
        const tip = `${hm(b.ts)}–${hm(b.ts + 1800)} · ` + (b.s ? ST[b.s] + (b.lat != null ? ` · ${ms(b.lat)} ms` : '') +
          (b.loss ? ` · ${pct(b.loss)}% perda` : '') : 'sem dados');
        cells.append(h('i', {class: b.s || 'na', title: tip}));
      }
      const p = t.pct;
      box.append(h('div', {class: 'hx-avr', onclick: () => openSheet('target', {name: t.name}), title: 'Detalhes de ' + t.name},
        h('span', {class: 'n', text: t.name}), cells,
        h('span', {class: 'p ' + (p == null ? '' : p >= 99.9 ? 'ok' : p >= 99 ? 'warn' : 'bad'), text: p == null ? '--' : pct(p, p >= 99.995 ? 0 : 1) + '%'})));
    }
    if (!A.length) box.append(h('div', {class: 'hint', text: 'Nenhum destino cadastrado.'}));
    el.append(box);
    if (A.length && A[0].blocks.length) {
      const b0 = A[0].blocks[0].ts, n = A[0].blocks.length;
      const axis = h('div', {class: 'hx-axis'});
      for (let i = 0; i <= 4; i++) axis.append(h('span', {text: i === 4 ? 'agora' : hm(b0 + i * n / 4 * 1800)}));
      el.append(h('div', {class: 'hx-avr axis'}, h('span'), axis, h('span')));
    }
    el.append(h('div', {class: 'hx-legend'},
      ...[['ok', 'ok'], ['warn', 'lento / perda leve'], ['bad', 'fora do ar'], ['iso', 'isolado']].map(([c, t]) => h('span', {}, h('i', {class: c}), t))));
  }

  // ------------------------------------------------------------------ 3. rede (MikroTik): portas + aparelhos
  function renderNet(el) {
    const N = D.net, st = N.status || {};
    const head = [st.board_name, st.cpu_load != null ? 'CPU ' + Math.round(st.cpu_load) + '%' : null,
      st.temperature != null ? Math.round(st.temperature) + ' °C' : null].filter(Boolean).join(' · ');
    el.append(lab('router', 'Portas do MikroTik', head));
    const ifs = (N.interfaces || []).filter(i => !i.disabled).slice(0, 8);
    const mx = Math.max(1, ...ifs.map(i => (i.rx_bps || 0) + (i.tx_bps || 0)));
    const list = h('div', {class: 'hx-ports'});
    for (const i of ifs) {
      const up = !!i.running;
      list.append(h('div', {class: 'hx-port' + (up ? '' : ' down'), onclick: () => openSheet('mikrotik'), title: 'Abrir MikroTik'},
        h('i', {class: 'd'}), h('b', {text: i.name}), h('span', {class: 'c', text: i.comment || ''}),
        h('span', {class: 't', text: up ? `↓ ${bps(i.rx_bps)}  ↑ ${bps(i.tx_bps)}` : 'desconectado'}),
        bar(up ? Math.max(2, 100 * ((i.rx_bps || 0) + (i.tx_bps || 0)) / mx) : 0)));
    }
    if (st.stale) list.append(h('div', {class: 'hint', text: 'Sem dados novos do MikroTik — verifique a conexão.'}));
    el.append(list);
    // v4.0: o pico real da internet (porta WAN), no lugar do speedtest
    const pk = D.kpi && D.kpi.wan_peak;
    if (pk) el.append(h('div', {class: 'hx-wan', title: 'Maior tráfego que passou pela porta ' + pk.iface + ' hoje'},
      ICON('gauge'), h('span', {class: 'l', text: 'Pico hoje na WAN'}),
      h('b', {text: '↓ ' + bps(pk.rx_bps)}), h('span', {class: 'w', text: hm(pk.rx_ts)}),
      pk.tx_bps != null ? h('b', {text: '↑ ' + bps(pk.tx_bps)}) : null, pk.tx_ts ? h('span', {class: 'w', text: hm(pk.tx_ts)}) : null));
    el.append(h('div', {class: 'hx-sep'}));
    el.append(lab('network', 'Aparelhos na rede', h('span', {}, h('b', {text: String(N.active)}), ' ativos' + (N.new_24h ? ` · ${N.new_24h} novo${N.new_24h > 1 ? 's' : ''} hoje` : ''))));
    const dl = h('div', {class: 'hx-devs'});
    for (const d of N.hosts || []) {
      dl.append(h('div', {class: 'hx-dev' + (d.new ? ' new' : ''), onclick: () => openSheet('mikrotik'), title: d.new ? 'Apareceu em ' + dmhm(d.first_seen) : ''},
        h('span', {class: 'tag', text: d.new ? 'NOVO' : ''}), h('b', {text: d.name}), h('span', {class: 'ip', text: d.ip || ''}),
        h('span', {class: 'w', text: d.new ? 'há ' + since(d.first_seen) : d.active ? 'ativo' : 'inativo'})));
    }
    if (!(N.hosts || []).length) dl.append(h('div', {class: 'hint', text: 'Nenhum aparelho no DHCP do roteador.'}));
    el.append(dl);
  }

  // ------------------------------------------------------------------ 4. câmeras (fotos; clique = ao vivo)
  function renderCams(el) {
    const chans = (D.cams && D.cams.channels) || [];
    el.append(lab('video', 'Câmeras', 'clique para ver ao vivo'));
    const g = h('div', {class: 'hx-cams', style: {'--n': chans.length > 4 ? 3 : 2}});
    for (const c of chans.slice(0, 9)) {
      const img = h('img', {alt: '', 'data-ch': c.ch});
      img.addEventListener('error', () => img.classList.add('err'));
      img.addEventListener('load', () => img.classList.remove('err'));
      g.append(h('button', {class: 'hx-cam', type: 'button', onclick: () => openSheet('cameras', {ch: c.ch}), title: 'Ao vivo: ' + c.name},
        img, h('span', {class: 'nm', text: c.name})));
    }
    el.append(g);
  }
  // uma foto por vez, a cada ~60 s, só com a página inicial visível (no DVR sem CGI cada foto abre o vídeo por 2–3 s)
  function refreshCams(first) {
    clearTimeout(camTimer);
    const imgs = [...document.querySelectorAll('.hx-cam img')];
    if (!imgs.length) return;
    const visible = !document.hidden && !document.body.classList.contains('sheet-open') && !document.querySelector('.tvg');
    if (first) {
      imgs.forEach(im => { if (!im.src) im.src = `/api/cam/snapshot/${im.dataset.ch}?last=1&t=${Date.now()}`; });
    } else if (visible) {
      const im = imgs[camIdx % imgs.length];
      camIdx++;
      const nx = new Image();
      nx.onload = () => { im.src = nx.src; im.classList.remove('err'); };
      nx.src = `/api/cam/snapshot/${im.dataset.ch}?age=50&t=${Date.now()}`;
    }
    camTimer = setTimeout(() => refreshCams(false), first ? 1500 : Math.max(4000, 60000 / imgs.length));
  }

  // ------------------------------------------------------------------ 5. AdGuard
  function renderAgh(el) {
    const a = D.agh;
    el.append(lab('shield', 'AdGuard · 24 h'));
    el.append(h('div', {class: 'hx-big', text: a.queries != null ? a.queries.toLocaleString('pt-BR') : '--'}),
      h('div', {class: 'hint', text: 'consultas DNS' + (a.avg_ms ? ` · ${ms(a.avg_ms)} ms em média` : '')}),
      h('div', {class: 'hx-kv2'}, h('span', {text: 'Bloqueadas'}), h('b', {text: `${a.blocked != null ? a.blocked.toLocaleString('pt-BR') : '--'} · ${pct(a.blocked_pct)}%`})),
      bar(a.blocked_pct, 'bad'));
    const tb = (a.top_blocked || [])[0];
    if (tb) el.append(h('div', {class: 'hx-kv2'}, h('span', {text: 'Mais bloqueado'}), h('b', {text: tb.name, title: tb.count + ' bloqueios'})));
  }

  // ------------------------------------------------------------------ 6. DNS
  function renderDns(el) {
    const L = (D.dns || []).filter(d => d.success != null);
    el.append(lab('globe', 'DNS · tempo de resposta'));
    const mx = Math.max(60, ...L.map(d => num(d.latency) || 0));
    let best = null;
    for (const d of L) {
      const v = d.success ? num(d.latency) : null;
      if (v != null && (!best || v < best.v)) best = {n: d.name, v};
      el.append(h('div', {class: 'hx-kv2'}, h('span', {text: d.name}), h('b', {class: v == null ? 'bad' : '', text: v == null ? 'sem resposta' : ms(v, 0) + ' ms'})),
        bar(v == null ? 100 : 100 * v / mx, v == null ? 'bad' : level(v, 50, 150)));
    }
    if (!L.length) el.append(h('div', {class: 'hint', text: 'Sem medições na última hora.'}));
    if (best) el.append(h('div', {class: 'hint hx-foot'}, 'mais rápido agora: ', h('b', {text: best.n})));
  }

  // ------------------------------------------------------------------ 7. Raspberry Pi
  function renderSys(el) {
    const s = D.system || {};
    el.append(lab('cpu', s.host_label || 'Servidor'));
    const rows = [['CPU', s.cpu_pct, '%', 70, 90], ['Memória', s.mem_pct, '%', 80, 92], ['Temperatura', s.temp_c, ' °C', 65, 75], ['Disco', s.disk_pct, '%', 80, 92]];
    for (const [n, v, u, w, b] of rows) {
      if (v == null) continue;
      el.append(h('div', {class: 'hx-kv2'}, h('span', {text: n}), h('b', {text: (u === '%' ? Math.round(v) : pct(v, 1)) + u})),
        bar(u === '%' ? v : v / 85 * 100, level(v, w, b)));
    }
    el.append(h('div', {class: 'hint hx-foot', text: [s.host_uptime_s ? 'ligado há ' + dur(s.host_uptime_s) : null,
      s.db_hist_mb != null ? 'histórico ' + pct(s.db_hist_mb, 1) + ' MB' : s.db_mb != null ? 'banco ' + pct(s.db_mb, 1) + ' MB' : null].filter(Boolean).join(' · ')}));
  }

  // ------------------------------------------------------------------ 8. mapa de incidentes (coluna esquerda)
  function renderHeat() {
    const el = $('hxHeat');
    if (!el) return;
    clear(el);
    const H = D.heat;
    if (!H) return;
    el.append(h('h4', {text: 'Incidentes · 7 dias × 24 h'}));
    const g = h('div', {class: 'hx-heat'});
    const mx = Math.max(1, ...H.cells.flat());
    H.cells.forEach((row, di) => {
      const d = new Date(H.days[di] + 'T12:00:00');
      g.append(h('span', {class: 'dl', text: WDS[d.getDay()]}));
      row.forEach((c, hr) => g.append(h('i', {title: `${WDS[d.getDay()]} ${String(hr).padStart(2, '0')}h · ${c} incidente${c === 1 ? '' : 's'}`,
        style: c ? {background: `color-mix(in srgb, var(--red) ${30 + 70 * c / mx}%, transparent)`} : null})));
    });
    el.append(g);
    // pior faixa de 3 horas na semana
    const tot = Array.from({length: 24}, (_, hr) => H.cells.reduce((a, r) => a + r[hr], 0));
    const all = tot.reduce((a, b) => a + b, 0);
    let bi = 0, bv = -1;
    for (let i = 0; i < 24; i++) { const v = tot[i] + tot[(i + 1) % 24] + tot[(i + 2) % 24]; if (v > bv) { bv = v; bi = i; } }
    el.append(h('div', {class: 'hint'}, all
      ? h('span', {}, 'Pior horário: ', h('b', {text: `${bi}h–${(bi + 3) % 24}h`}), ` · ${all} incidente${all > 1 ? 's' : ''} na semana`)
      : 'Nenhum incidente na semana ✓'));
  }

  // ------------------------------------------------------------------ montagem
  function panel(cls, fn) {
    const p = h('section', {class: 'hx-p glass ' + cls});
    try { fn(p); } catch (e) { console.error(e); p.append(h('div', {class: 'hint', text: 'Erro ao montar este bloco.'})); }
    return p;
  }
  // ================================================================== página inicial nova (v3.14)
  // 1) estado + causa + 4 números  2) linha do tempo (aberta só com problema)  3) destinos (app.js)
  // 4) detalhes em blocos que a pessoa reordena, recolhe ou esconde (salvo por usuário no servidor)
  const BLOCKS = {
    avail: {t: 'Disponibilidade por destino', span: 2, fn: renderAvail},
    net: {t: 'MikroTik e aparelhos', fn: renderNet, need: () => D.net},
    dns: {t: 'DNS', fn: renderDns},
    agh: {t: 'AdGuard Home', fn: renderAgh, need: () => D.agh},
    sys: {t: 'Servidor', fn: renderSys},
    cams: {t: 'Câmeras', span: 2, fn: renderCams, need: () => D.cams && D.cams.channels.length},
    heat: {t: 'Incidentes · 7 dias × 24 h', fn: el => { el.append(lab('calendar', 'Incidentes · 7 dias × 24 h')); el.append(heatBox()); }},
  };
  const DEF = {order: Object.keys(BLOCKS), collapsed: ['heat'], hidden: []};
  let P = null, tlOpen = false, customizing = false, lastActive = null;
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { return null; } };
  function prefs() {
    if (P) return P;
    try { P = JSON.parse(ls('nn_home_prefs') || 'null'); } catch (_) { P = null; }
    return (P = norm(P));
  }
  function norm(p) {
    p = Object.assign({}, DEF, p || {});
    const ok = k => Object.prototype.hasOwnProperty.call(BLOCKS, k);
    p.order = [...new Set((p.order || []).filter(ok).concat(DEF.order))];
    p.collapsed = (p.collapsed || []).filter(ok); p.hidden = (p.hidden || []).filter(ok);
    return p;
  }
  let saveT = null;
  function savePrefs() {
    ls('nn_home_prefs', JSON.stringify(P));
    clearTimeout(saveT);
    saveT = setTimeout(() => window.NN.post('/api/me/prefs', {home: P}).catch(() => { /* fica só neste navegador */ }), 600);
  }
  function heatBox() { let e = $('hxHeat'); if (!e) e = h('div', {class: 'hx-heatbox', id: 'hxHeat'}); return e; }

  function liveKpis() {
    const S = window.NN.S, o = S.overview || {}, k = (D && D.kpi) || {};
    const set = (id, v, cls, sub) => {
      const e = $(id); if (!e) return;
      e.querySelector('.v b').textContent = v; e.querySelector('.v').className = 'v ' + (cls || '');
      if (sub != null) e.querySelector('.s').textContent = sub;
    };
    const up = k.up_today;
    set('h2kUp', up == null ? '--' : pct(up, 2), up == null ? '' : up >= 99.5 ? 'ok' : up >= 98 ? 'warn' : 'bad',
      `7 dias ${pct(k.up_7d, 2)}% · 30 dias ${pct(k.up_30d, 2)}%`);
    set('h2kLat', ms(o.avg_latency), '', o.avg_jitter != null ? `jitter ${ms(o.avg_jitter)} ms · média dos destinos` : 'média dos destinos');
    const loss = num(o.avg_loss_pct), live = o.targets || {};
    const losing = Object.keys(live).filter(n => (num(live[n].loss_pct) || 0) > 0);
    set('h2kLoss', pct(loss), loss > 5 ? 'bad' : loss > 0 ? 'warn' : '',
      losing.length ? (losing.length <= 2 ? losing.join(', ') : losing.length + ' destinos') + ' perdendo' : 'nenhum destino perdendo');
    const n = (S.active || []).length;
    set('h2kInc', String(n), n ? 'bad' : '', `${k.month_incidents == null ? '--' : k.month_incidents} no mês` +
      (k.month_mttr_s ? ' · resolvidos em ' + dur(k.month_mttr_s) + ' (média)' : ''));
  }
  function k2(id, icon, label, unit, open) {
    return h('button', {class: 'h2-kpi', id, type: 'button', onclick: () => openSheet(open)},
      h('span', {class: 'l'}, ICON(icon), label), h('span', {class: 'v'}, h('b', {text: '--'}), h('small', {text: unit})), h('span', {class: 's'}));
  }

  function renderTop() {
    const top = $('hxTop');
    if (!top) return;
    const St = D.story || {state: 'ok', headline: '', sub: '', day: ''};
    const bad = St.state === 'bad' || St.state === 'warn';
    clear(top);
    // ---- 1. estado
    const btn = h('button', {class: 'tbtn' + (bad ? ' primary' : ''), type: 'button', title: 'Gateway, internet, DNS, MikroTik e traceroute agora'}, ICON('search'), ' Diagnosticar agora');
    btn.onclick = () => runDiag(btn);
    const acts = h('div', {class: 'h2-acts'}, btn);
    if (bad) acts.append(h('button', {class: 'tbtn', type: 'button', onclick: () => openSheet('topology', {view: 'mapa'})}, ICON('map'), ' Ver no mapa'),
      h('button', {class: 'tbtn', type: 'button', onclick: () => openSheet('incidents')}, ICON('alert'), ' Incidentes'));
    else acts.append(h('button', {class: 'tbtn', type: 'button', onclick: () => { tlOpen = !tlOpen; renderTop(); }}, ICON('clock'), tlOpen ? ' Recolher linha do tempo' : ' Linha do tempo'));
    const head = String(St.headline || '').replace(/^Agora:\s*/, '');
    const state = h('div', {class: 'h2-state'},
      h('span', {class: 'h2-orb', trusted: ICO(St.state === 'bad' ? 'x' : St.state === 'warn' ? 'alert' : 'check')}),
      h('div', {class: 'h2-txt'}, h('h2', {text: head || 'Carregando…'}), St.sub ? h('div', {class: 'h2-why', text: St.sub}) : null, acts));
    if (diagBox) {
      const d = diagBox, b = h('div', {class: 'st-diag'});
      if (d.loading) b.append(h('div', {class: 'hint', text: 'Pingando gateway e internet, testando DNS, consultando o MikroTik…'}));
      else if (d.error) b.append(h('div', {class: 'callout', text: d.error}));
      else b.append(h('div', {class: 'st-dt'}, h('b', {text: d.title}), h('span', {class: 'conf', text: 'confiança ' + d.confidence + ' · ' + d.secs + ' s'}),
        h('button', {class: 'st-x', type: 'button', title: 'Fechar', trusted: ICO('x'), onclick: () => { diagBox = null; render(); }})),
      d.text ? h('p', {text: d.text}) : null, evList(d.evidence, d.tips));
      state.lastChild.append(b);
    }
    const kp = h('div', {class: 'h2-kpis'},
      k2('h2kUp', 'check', 'Disponível hoje', '%', 'sla'), k2('h2kLat', 'activity', 'Latência agora', 'ms', 'latency'),
      k2('h2kLoss', 'loss', 'Perda agora', '%', 'latency'), k2('h2kInc', 'alert', 'Incidentes', 'agora', 'incidents'));
    top.append(h('section', {class: 'h2-hero glass st-' + St.state}, state, kp));
    liveKpis();
    // ---- 2. linha do tempo
    const tl = h('section', {class: 'h2-tl glass st-' + St.state});
    if (bad || tlOpen) {
      tl.append(h('div', {class: 'hx-lab'}, ICON('clock'), h('span', {text: 'O que aconteceu'}), h('span', {class: 'hx-r', text: St.day || ''}),
        !bad ? h('button', {class: 'h2-x', type: 'button', title: 'Recolher', trusted: ICO('x'), onclick: () => { tlOpen = false; renderTop(); }}) : null));
      const tmp = h('div');
      try { renderStory(tmp); } catch (e) { console.error(e); }
      // reaproveita a linha do tempo da narrativa (sem o cabeçalho, que já está no bloco de cima)
      tmp.querySelectorAll('.st-head, .st-diag').forEach(x => x.remove());
      tl.append(...tmp.childNodes);
    } else {
      tl.classList.add('calm');
      tl.append(ICON('clock'), h('span', {class: 'h2-day', text: St.day || 'Nada aconteceu nas últimas 48 horas.'}),
        h('button', {class: 'tbtn', type: 'button', onclick: () => { tlOpen = true; renderTop(); }}, 'Abrir linha do tempo'));
    }
    top.append(tl);
    // ---- 3. título dos destinos (os cards vêm logo abaixo, do app.js)
    top.append(h('div', {class: 'h2-bar'}, h('h3', {text: 'Destinos'}), h('span', {class: 'hint', text: 'com problema primeiro · agrupados como no mapa'}),
      h('button', {class: 'tbtn', type: 'button', onclick: () => openSheet('config', {tab: 'destinos'})}, ICON('plus'), ' Adicionar')));
  }

  function renderDetails() {
    const root = $('hx');
    const p = prefs();
    const keep = root.querySelector('[data-blk="cams"]');           // não recarrega as fotos a cada atualização
    clear(root);
    const bar = h('div', {class: 'h2-bar'}, h('h3', {text: 'Detalhes'}),
      h('span', {class: 'hint', text: 'arraste ⋮⋮ para reordenar · clique no título para recolher'}),
      h('button', {class: 'tbtn' + (customizing ? ' on' : ''), type: 'button', onclick: () => { customizing = !customizing; renderDetails(); }}, ICON('gear'), ' Personalizar'));
    root.append(bar);
    if (customizing) {
      const box = h('div', {class: 'h2-custom glass'}, h('div', {class: 'hint', text: 'Blocos mostrados na página inicial:'}));
      for (const id of p.order) {
        const c = h('input', {type: 'checkbox'}); c.checked = !p.hidden.includes(id);
        c.addEventListener('change', () => { p.hidden = c.checked ? p.hidden.filter(x => x !== id) : p.hidden.concat(id); savePrefs(); renderDetails(); });
        box.append(h('label', {class: 'switch'}, c, BLOCKS[id].t));
      }
      box.append(h('button', {class: 'tbtn', type: 'button', onclick: () => { P = norm(null); savePrefs(); renderDetails(); }}, ICON('refresh'), ' Restaurar padrão'));
      root.append(box);
    }
    const grid = h('div', {class: 'h2-blocks'});
    for (const id of p.order) {
      const B = BLOCKS[id];
      if (p.hidden.includes(id) || (B.need && !B.need())) continue;
      const cls = {cams: 'hx-camp', heat: 'hx-heatp'}[id] || 'hx-' + id;          // mesmas classes da página clássica
      const el = (id === 'cams' && keep) ? keep : panel(cls, B.fn);
      el.dataset.blk = id;
      el.classList.toggle('span2', B.span === 2);
      el.classList.toggle('h2-col', p.collapsed.includes(id));
      wireBlock(el, id);
      grid.append(el);
    }
    root.append(grid);
    if (!keep && grid.querySelector('.hx-cams')) refreshCams(true);
    renderHeat();
  }
  function wireBlock(el, id) {
    const p = prefs();
    const lb = el.querySelector(':scope > .hx-lab');
    if (!lb || lb.dataset.wired) return;
    lb.dataset.wired = '1';
    lb.classList.add('h2-head');
    lb.title = 'Clique para recolher/abrir';
    lb.addEventListener('click', ev => {
      if (ev.target.closest('a, button, input, select, .h2-drag')) return;
      const col = !el.classList.contains('h2-col');
      el.classList.toggle('h2-col', col);
      p.collapsed = col ? p.collapsed.concat(id) : p.collapsed.filter(x => x !== id);
      savePrefs();
    });
    const hd = h('span', {class: 'h2-drag', title: 'Arraste para reordenar', text: '⋮⋮', draggable: 'true'});
    hd.addEventListener('dragstart', ev => { el.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', id); });
    hd.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      const g = el.parentElement;
      if (g) p.order = [...g.children].map(x => x.dataset.blk).concat(p.order).filter((x, i, a) => x && a.indexOf(x) === i);
      savePrefs();
    });
    lb.append(hd);
    el.addEventListener('dragover', ev => {
      const g = el.parentElement, drag = g && g.querySelector('.dragging');
      if (!drag || drag === el) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const after = (ev.clientY - r.top) > r.height / 2 || (ev.clientX - r.left) > r.width * 0.66;
      g.insertBefore(drag, after ? el.nextSibling : el);
    });
  }

  function render() {
    if (!D) return;
    try { renderTop(); } catch (e) { window.NN.reportError('Página inicial (topo): ' + e.message, e); }
    try { renderDetails(); } catch (e) { window.NN.reportError('Página inicial (detalhes): ' + e.message, e); }
  }
  async function load() {
    try { D = await api('/api/home'); } catch (_) { return; /* sessão expirada/rede: app.js trata */ }
    try { render(); } catch (e) { NN.reportError('Página inicial: ' + e.message, e); }
  }
  function start() {
    // arrumação salva no servidor (vale em qualquer aparelho); o localStorage só acelera a primeira pintura
    api('/api/me/prefs').then(r => { if (r && r.home) { P = norm(r.home); ls('nn_home_prefs', JSON.stringify(P)); render(); } }).catch(() => {});
    // números ao vivo (SSE) sem esperar os 30 s; incidente novo/resolvido recarrega a narrativa na hora
    document.addEventListener('nn:snapshot', ev => {
      if (!D) return;
      liveKpis();
      const sig = ((ev.detail && ev.detail.incidents) || []).map(i => i.id).join(',');
      if (sig !== lastActive) { const first = lastActive === null; lastActive = sig; if (!first) load(); }
    });
    load();
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); refreshCams(false); } });
    document.addEventListener('nn:skin', render);
  }
  window.NNHome = {load, render};
  window.addEventListener('DOMContentLoaded', () => setTimeout(start, 400));
})();
