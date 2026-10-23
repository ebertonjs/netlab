// NetNOC v3.4 — blocos da página inicial: indicadores, disponibilidade por destino, rede (MikroTik),
// câmeras, AdGuard, DNS, Raspberry Pi e mapa de incidentes. Uma chamada (/api/home) a cada 30 s.
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

  // ------------------------------------------------------------------ 1. indicadores
  function kpi(orb, icon, label, value, sub, opts) {
    opts = opts || {};
    return h('button', {class: 'hx-kpi glass' + (opts.cls ? ' ' + opts.cls : ''), type: 'button', title: opts.title || '',
      onclick: opts.open ? () => openSheet(opts.open) : null},
    h('span', {class: 'orb ' + orb, trusted: ICO(icon)}),
    h('span', {class: 'hx-kv'}, h('span', {class: 'l', text: label}), h('span', {class: 'v'}, value), h('span', {class: 's', text: sub || ''})));
  }
  function renderKpis(el) {
    const k = D.kpi || {};
    const upc = k.up_today == null ? 'grey' : k.up_today >= 99.5 ? 'green' : k.up_today >= 98 ? '' : 'red';
    const sp = k.speedtest;
    const q = k.quiet || {};
    el.append(
      kpi(upc, 'check', 'Disponível hoje', k.up_today == null ? '--' : pct(k.up_today, 2) + '%',
        `7 d ${pct(k.up_7d, 2)}% · 30 d ${pct(k.up_30d, 2)}%`, {open: 'sla', title: 'Média dos destinos'}),
      kpi('blue', 'globe', 'IP público', k.public_ip || '--',
        k.public_ip_since ? 'mesmo IP há ' + since(k.public_ip_since) : '', {title: 'Muda quando a operadora troca seu IP'}),
      kpi('', 'gauge', 'Último speedtest', sp && sp.download != null ? h('span', {}, '↓ ' + Math.round(sp.download), h('small', {text: ' Mbps'})) : '--',
        sp ? `↑ ${sp.upload != null ? Math.round(sp.upload) : '--'} Mbps · ${dmhm(sp.ts)}`
          : (k.speedtest_auto && k.speedtest_auto.enabled ? 'automático às ' + k.speedtest_auto.time : 'nenhum teste ainda'),
        {open: 'tools'}),
      q.now
        ? kpi('red', 'alert', 'Queda em andamento', q.target || '--', 'veja os incidentes', {open: 'incidents', cls: 'bad'})
        : kpi('', 'clock', 'Sem quedas há', q.since ? since(q.since) : '--', q.target ? 'última: ' + q.target : 'nenhuma queda registrada', {open: 'incidents'}),
      kpi(k.month_incidents ? '' : 'green', 'alert', 'Incidentes no mês', String(k.month_incidents == null ? '--' : k.month_incidents),
        k.month_mttr_s ? 'resolvidos em ' + dur(k.month_mttr_s) + ' (média)' : 'nenhum resolvido', {open: 'incidents'}));
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
    el.append(list, h('div', {class: 'hx-sep'}));
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
      s.db_mb != null ? 'banco ' + pct(s.db_mb, 1) + ' MB' : null].filter(Boolean).join(' · ')}));
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
  function render() {
    const root = $('hx');
    if (!root || !D) return;
    const keep = root.querySelector('.hx-cams');           // não recarrega as fotos a cada atualização
    const keepPanel = keep && keep.closest('.hx-p');
    clear(root);
    const k = h('div', {class: 'hx-kpis'}); renderKpis(k); root.append(k);
    const row = h('div', {class: 'hx-row' + (D.net ? '' : ' one')});
    row.append(panel('hx-avail', renderAvail));
    if (D.net) row.append(panel('hx-net', renderNet));
    root.append(row);
    const row2 = h('div', {class: 'hx-row4'});
    if (D.cams && D.cams.channels.length) row2.append(keepPanel || panel('hx-camp', renderCams));
    if (D.agh) row2.append(panel('hx-agh', renderAgh));
    row2.append(panel('hx-dns', renderDns));
    row2.append(panel('hx-sys', renderSys));
    const hasCam = !!row2.querySelector('.hx-cams');
    row2.classList.toggle('cams', hasCam);
    row2.style.setProperty('--cols', row2.children.length);
    row2.style.setProperty('--rest', Math.max(1, row2.children.length - 1));
    root.append(row2);
    if (!keepPanel && row2.querySelector('.hx-cams')) refreshCams(true);   // painel novo: carrega as fotos
    renderHeat();
  }
  async function load() {
    try { D = await api('/api/home'); render(); } catch (_) { /* sessão expirada: app.js redireciona */ }
  }
  function start() {
    load();
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); refreshCams(false); } });
    document.addEventListener('nn:skin', render);
  }
  window.NNHome = {load, render};
  window.addEventListener('DOMContentLoaded', () => setTimeout(start, 400));
})();
