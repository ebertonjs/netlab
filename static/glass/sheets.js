// NetNOC v3 — painéis sobrepostos (sheets) da interface glass.
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;

  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const C = n => window.SKIN.col(n);
  const pal = i => window.SKIN.palette()[i % 8];
  const RANGES = [['5m', '5 min'], ['1h', '1 h'], ['24h', 'Dia'], ['7d', 'Semana'], ['30d', 'Mês']];
  const RANGE_S = {'5m': 300, '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000};
  let lastRange = '1h';

  // ------------------------------------------------------------------ peças comuns
  function seg(items, value, onChange) {
    const s = h('div', {class: 'seg'});
    for (const [v, label] of items) {
      s.append(h('button', {type: 'button', class: v === value ? 'on' : '', text: label, onclick: () => onChange(v)}));
    }
    return s;
  }
  const tbtn = (text, icon, onclick, cls) => h('button', {class: 'tbtn' + (cls ? ' ' + cls : ''), type: 'button', onclick},
    icon ? h('span', {trusted: ICO(icon)}) : null, text);
  const stat = (icon, title, value, cls) => h('div', {class: 'stat' + (cls ? ' ' + cls : '')},
    h('span', {class: 'si', trusted: ICO(icon)}), h('div', {}, h('b', {text: title}), h('span', {text: value})));
  const sec = (icon, title, ...kids) => h('section', {class: 'sec'}, h('h3', {}, h('span', {trusted: ICO(icon)}), title), ...kids);
  const chartBox = cls => { const c = h('canvas'); return [h('div', {class: 'chart-box' + (cls ? ' ' + cls : '')}, c), c]; };
  const kv = pairs => { const d = h('dl', {class: 'kv'}); for (const [k, v] of pairs) d.append(h('dt', {text: k}), h('dd', {text: v == null ? '--' : v})); return d; };
  const panels = ctx => { const L = h('aside', {class: 'panel dark'}); const R = h('div', {class: 'panel main'}); ctx.body.append(L, R); return [L, R]; };
  const needAdmin = () => { if (!NN.isAdmin()) { toast('Somente administradores podem alterar', 'error'); return true; } return false; };
  function field(label, input) { return h('label', {class: 'field'}, label, input); }
  const inp = (attrs) => h('input', Object.assign({class: 'inp'}, attrs));
  function select(options, value) {
    const s = h('select', {class: 'inp'});
    for (const [v, l] of options) { const o = h('option', {value: v, text: l}); if (String(v) === String(value)) o.selected = true; s.append(o); }
    return s;
  }
  function sw(label, checked) { const i = h('input', {type: 'checkbox'}); i.checked = !!checked; return [h('label', {class: 'switch'}, i, label), i]; }
  async function act(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'error'); return null; }
  }
  function li(cls, title, sub, right, onclick) {
    return h('div', {class: 'li ' + (cls || ''), onclick, style: onclick ? {cursor: 'pointer'} : null},
      h('span', {class: 'b'}), h('div', {}, h('div', {text: title}), sub ? h('div', {class: 't2', text: sub}) : null),
      h('div', {class: 'r'}, ...(Array.isArray(right) ? right : [right])));
  }

  // ------------------------------------------------------------------ Chart.js
  function tickFmt(span) {
    return v => {
      const d = new Date(v);
      const p = n => String(n).padStart(2, '0');
      if (span > 2 * 86400) return p(d.getDate()) + '/' + p(d.getMonth() + 1);
      return p(d.getHours()) + ':' + p(d.getMinutes());
    };
  }
  function baseOpts(span, extra) {
    const grid = css('--chart-grid'), tc = css('--muted');
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: {duration: 350}, parsing: false, normalized: true,
      interaction: {mode: 'nearest', axis: 'x', intersect: false},
      scales: {
        x: {type: 'linear', grid: {display: false}, border: {display: false},
          ticks: {color: tc, maxTicksLimit: 8, callback: tickFmt(span), font: {size: 11}}},
        y: {grid: {color: grid}, border: {display: false}, ticks: {color: tc, maxTicksLimit: 6, font: {size: 11}}, beginAtZero: true},
      },
      plugins: {
        legend: {display: false, labels: {color: css('--text-2'), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: {size: 11}}},
        tooltip: {callbacks: {title: it => it.length ? dmhm(it[0].parsed.x / 1000) : ''}},
        decimation: {enabled: true, algorithm: 'lttb', samples: 400},
      },
    }, extra || {});
  }
  function gradient(ctxEl, color) {
    const g = ctxEl.getContext('2d').createLinearGradient(0, 0, 0, ctxEl.parentElement.clientHeight || 220);
    g.addColorStop(0, color + '66'); g.addColorStop(1, color + '00');
    return g;
  }
  function withGaps(points) {
    // insere null onde a coleta parou (restart, queda do host): o gráfico mostra o buraco em vez de uma reta
    if (points.length < 3) return points;
    const dif = [];
    for (let i = 1; i < points.length; i++) dif.push(points[i].x - points[i - 1].x);
    const med = [...dif].sort((a, b) => a - b)[Math.floor(dif.length / 2)] || 0;
    if (!med) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].x - points[i - 1].x > med * 4) out.push({x: points[i - 1].x + med, y: null});
      out.push(points[i]);
    }
    return out;
  }
  function lineDS(canvas, label, points, color, fill) {
    return {label, data: withGaps(points), borderColor: color, backgroundColor: fill ? gradient(canvas, color) : color,
      fill: !!fill, tension: .3, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 3, borderWidth: 2, spanGaps: false};
  }

  // ================================================================== LATÊNCIA
  function gatewayOf(targets) {
    return targets.find(t => /gateway|router|roteador/i.test(t.name)) ||
      targets.find(t => isLocal(t) && targets.some(c => c.parent === t.name)) || targets.find(isLocal);
  }
  function flowSvg(gw, ext, local) {
    // diagrama "energia": LAN (gateway) ← NetNOC → Internet, com IP público no arco
    const o = S.overview || {};
    const T = o.targets || {};
    const gwL = gw && T[gw.name];
    const extOn = ext.filter(t => T[t.name] && T[t.name].online).length;
    const extLat = ext.map(t => T[t.name] && num(T[t.name].avg_latency)).filter(v => v != null);
    const avgExt = extLat.length ? extLat.reduce((a, b) => a + b, 0) / extLat.length : null;
    const g = gwL ? (gwL.online ? C('--green') : C('--red')) : C('--grey');
    const e = !ext.length ? C('--grey') : extOn === ext.length ? C('--accent') : extOn ? C('--yellow') : C('--red');
    const a = C('--accent');
    const ip = o.public_ip || '';
    const esc = window.esc;
    return `<svg viewBox="0 0 300 230" aria-label="Fluxo LAN → NetNOC → Internet">
      <defs><style>.fl{stroke-dasharray:6 8;animation:fl 1.2s linear infinite}@keyframes fl{to{stroke-dashoffset:-28}}</style></defs>
      <path d="M40 70 Q150 -10 260 70" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2"/>
      <rect x="104" y="14" width="92" height="22" rx="11" fill="rgba(255,255,255,.18)"/>
      <text x="150" y="29" text-anchor="middle" font-size="11" fill="#fff" font-weight="600">${esc(ip || 'IP público')}</text>
      <path d="M150 34 C150 70 150 90 150 118" stroke="${e}" stroke-width="3" fill="none" class="fl"/>
      <path d="M58 120 L58 175 Q58 190 73 190 L135 190 Q150 190 150 175 L150 160" stroke="${g}" stroke-width="3" fill="none" class="fl"/>
      <path d="M150 160 L150 175 Q150 190 165 190 L227 190 Q242 190 242 175 L242 120" stroke="${e}" stroke-width="3" fill="none" class="fl"/>
      <g class="node-orb" style="color:${g}"><circle cx="58" cy="100" r="26" fill="${g}"/></g>
      <text x="58" y="97" text-anchor="middle" font-size="10" fill="#fff" font-weight="700">LAN</text>
      <text x="58" y="110" text-anchor="middle" font-size="10" fill="#fff">${gwL ? (gwL.online ? ms(gwL.latency) + ' ms' : 'off') : '--'}</text>
      <g class="node-orb" style="color:${a}"><circle cx="150" cy="140" r="26" fill="${a}"/></g>
      <text x="150" y="137" text-anchor="middle" font-size="10" fill="#fff" font-weight="700">${esc((window.APP_NAME || 'NetNOC').slice(0, 9))}</text>
      <text x="150" y="150" text-anchor="middle" font-size="10" fill="#fff">${local.length + ext.length} alvos</text>
      <g class="node-orb" style="color:${e}"><circle cx="242" cy="100" r="26" fill="${e}"/></g>
      <text x="242" y="97" text-anchor="middle" font-size="10" fill="#fff" font-weight="700">WAN</text>
      <text x="242" y="110" text-anchor="middle" font-size="10" fill="#fff">${avgExt != null ? ms(avgExt) + ' ms' : '--'}</text>
      <text x="58" y="222" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">${local.length} locais</text>
      <text x="242" y="222" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">${extOn}/${ext.length} online</text>
    </svg>`;
  }

  registerSheet('latency', {
    title: 'Latência e disponibilidade', icon: 'activity',
    async render(ctx) {
      const range = ctx.params.range || lastRange;
      lastRange = range;
      ctx.tools.append(tbtn('Agora', 'refresh', () => ctx.reopen()), seg(RANGES, range, r => ctx.reopen({range: r})));
      const [L, R] = panels(ctx);
      const targets = S.targets;
      const gw = gatewayOf(targets);
      const local = targets.filter(isLocal), ext = targets.filter(t => !isLocal(t));
      const flow = h('div', {class: 'flow', trusted: flowSvg(gw, ext, local)});
      L.append(flow);
      const list = h('div', {class: 'list', style: {marginTop: '8px'}});
      const T = (S.overview && S.overview.targets) || {};
      for (const t of targets) {
        const x = T[t.name] || {};
        list.append(li(x.online === false ? 'alta' : 'ok', t.name, t.host, (x.online === false ? 'offline' : ms(x.avg_latency) + ' ms'),
          () => openSheet('target', {name: t.name})));
      }
      L.append(list);
      const trio = h('div', {class: 'trio', style: {marginTop: '18px'}});
      L.append(h('div', {class: 'rule'}), trio);

      const pills = h('div', {class: 'stats'});
      R.append(pills);
      const [box1, c1] = chartBox('tall');
      const [box2, c2] = chartBox('short');
      R.append(sec('activity', 'Latência por destino', box1), sec('loss', 'Perda de pacotes (média dos destinos)', box2));

      const [hist, slas] = await Promise.all([
        api('/api/ping/history?range=' + range),
        Promise.all([1, 7, 30].map(d => api('/api/sla?days=' + d).catch(() => null))),
      ]);
      if (!ctx.alive) return;
      const span = RANGE_S[range];
      const ds = [], lossAcc = {};
      let all = [], jit = [], loss = [];
      Object.entries(hist).forEach(([name, rows], i) => {
        const pts = rows.filter(r => r.latency != null).map(r => ({x: r.ts * 1000, y: +r.latency.toFixed(2)}));
        ds.push(lineDS(c1, name, pts, pal(i), false));
        for (const r of rows) {
          if (r.latency != null) all.push(r.latency);
          jit.push(r.jitter || 0); loss.push(r.loss_pct || 0);
          const a = lossAcc[r.ts] || (lossAcc[r.ts] = [0, 0]); a[0] += r.loss_pct || 0; a[1]++;
        }
      });
      const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      const up = slas.map(s => s ? avg(s.targets.map(t => t.availability_pct).filter(v => v != null)) : null);
      pills.append(stat('up', 'Latência média', ms(avg(all)) + ' ms'), stat('activity', 'Jitter médio', ms(avg(jit)) + ' ms', 'blue'),
        stat('loss', 'Perda média', pct(avg(loss), 2) + '%', avg(loss) > 1 ? 'red' : ''),
        stat('check', 'Disponível 24 h', pct(up[0], 3) + '%', 'green'));
      [['Hoje', up[0]], ['7 dias', up[1]], ['30 dias', up[2]]].forEach(([l, v]) =>
        trio.append(h('div', {}, h('div', {class: 'l', text: l}), h('div', {class: 'v', text: pct(v, 2) + '%'}), h('div', {class: 's', text: 'disponível'}))));
      ctx.chart(c1, {type: 'line', data: {datasets: ds}, options: baseOpts(span, {})}).options.plugins.legend.display = true;
      ctx.charts[0].update();
      const lp = Object.entries(lossAcc).sort((a, b) => a[0] - b[0]).map(([ts, a]) => ({x: ts * 1000, y: +(a[0] / a[1]).toFixed(2)}));
      ctx.chart(c2, {type: 'bar', data: {datasets: [{label: 'Perda %', data: lp, backgroundColor: C('--c1'), borderRadius: 4,
        barPercentage: .7, categoryPercentage: .9}]},
      options: baseOpts(span, {})});
      ctx.every(30000, () => { flow.innerHTML = flowSvg(gw, ext, local); });
    },
  });

  // ================================================================== DESTINO (detalhe)
  registerSheet('target', {
    title: p => p.name || 'Destino', icon: 'globe',
    async render(ctx) {
      const name = ctx.params.name;
      const range = ctx.params.range || lastRange;
      ctx.tools.append(seg(RANGES, range, r => ctx.reopen({range: r})));
      const t = S.targets.find(x => x.name === name);
      if (!t) { ctx.body.append(h('div', {class: 'panel main'}, h('div', {class: 'callout', text: 'Destino não encontrado.'}))); return; }
      const [L, R] = panels(ctx);
      const T = ((S.overview && S.overview.targets) || {})[name] || {};
      const online = T.online != null ? T.online : t.online;
      const head = h('div', {style: {display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '16px'}},
        h('div', {class: 'orb ' + (online === false ? 'red' : online ? 'green' : 'grey'), style: {width: '58px', height: '58px'},
          trusted: ICO(online === false ? 'x' : 'check')}),
        h('div', {}, h('div', {style: {fontSize: '20px', fontWeight: '700'}, text: name}),
          h('div', {class: 'hint mono', text: t.host})));
      L.append(head);
      const certs = await api('/api/certs').catch(() => ({}));
      const cfg = await api('/api/settings').catch(() => ({targets: []}));
      const full = (cfg.targets || []).find(x => x.name === name) || {};
      L.append(kv([
        ['Status', online === false ? 'Offline' : online ? 'Online' : 'Sem dados'],
        ['Tipo', (t.type || 'icmp').toUpperCase() + (full.port ? ' :' + full.port : '')],
        ['Latência atual', online === false ? '—' : ms(T.latency != null ? T.latency : t.latency) + ' ms'],
        ['Média da janela', ms(T.avg_latency) + ' ms'],
        ['Jitter', ms(T.avg_jitter != null ? T.avg_jitter : t.jitter) + ' ms'],
        ['Perda na janela', pct(T.loss_pct != null ? T.loss_pct : t.loss_pct) + '%'],
        ['Disponibilidade 24 h', pct(t.uptime_24h, 3) + '%'],
        ['Monitorado desde', t.since ? dmhm(t.since) : '--'],
        ['Última falha', t.last_fail ? ago(t.last_fail) : 'nunca'],
        ...(certs[name] != null ? [['Certificado', Math.round(certs[name]) + ' dias']] : []),
      ]));
      L.append(h('div', {class: 'rule'}));
      // edição: pai e intervalo
      const parentSel = select([['', '🌐 Raiz (sem pai)'], ...S.targets.filter(x => x.name !== name).map(x => [x.name, x.name])], full.parent || '');
      const ivIn = inp({type: 'number', min: 2, max: 3600, placeholder: 'padrão', value: full.interval || ''});
      const grpList = 'grp' + Math.random().toString(36).slice(2, 7);
      const grpIn = inp({value: full.group || '', maxlength: 30, placeholder: 'automático', list: grpList});
      const grpDl = h('datalist', {id: grpList}, ...[...new Set(S.targets.map(x => x.group).filter(Boolean).concat(['Servidores', 'Rede local', 'Wi-Fi', 'Câmeras', 'Internet']))].map(g => h('option', {value: g})));
      L.append(h('div', {class: 'form'},
        field('Depende de (pai na topologia)', parentSel),
        field('Grupo no mapa', grpIn), grpDl,
        field('Intervalo próprio (s)', ivIn),
        h('div', {class: 'hint', text: 'Com um pai definido, se o pai cair este destino não gera alerta próprio (causa raiz).'}),
        h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}},
          tbtn('Salvar', 'check', async () => {
            if (needAdmin()) return;
            const ok = await act(() => post('/api/settings/targets/' + encodeURIComponent(name) + '/update',
              {parent: parentSel.value || null, set_parent: true, interval: ivIn.value ? +ivIn.value : null, set_interval: true,
                group: grpIn.value.trim() || null, set_group: true}), 'Destino atualizado');
            if (ok) NN.loadTargets();
          }, 'primary'),
          tbtn('Remover', 'trash', async () => {
            if (needAdmin() || !confirm(`Remover "${name}" do monitoramento?`)) return;
            const ok = await act(() => del('/api/settings/targets/' + encodeURIComponent(name)), 'Destino removido');
            if (ok) { NN.closeSheet(); NN.loadTargets(); }
          }, 'danger'))));

      const pills = h('div', {class: 'stats'});
      const [box1, c1] = chartBox('tall');
      const bars = h('div', {class: 'bars'});
      const heat = h('div', {class: 'heat'});
      R.append(pills, sec('activity', 'Latência e jitter', box1), sec('clock', 'Disponibilidade por hora (24 h)', bars),
        sec('calendar', 'Mapa de calor — latência média por hora (14 dias)', heat));
      const [hist, ub, hm_] = await Promise.all([
        api('/api/ping/history?range=' + range), api('/api/uptime/bars?hours=24'),
        api('/api/heatmap?days=14&target=' + encodeURIComponent(name)).catch(() => null)]);
      if (!ctx.alive) return;
      const rows = hist[name] || [];
      const lat = rows.filter(r => r.latency != null);
      const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      pills.append(stat('up', 'Latência média', ms(avg(lat.map(r => r.latency))) + ' ms'),
        stat('down', 'Mínima / máxima', lat.length ? ms(Math.min(...lat.map(r => r.latency))) + ' / ' + ms(Math.max(...lat.map(r => r.latency))) + ' ms' : '--', 'blue'),
        stat('loss', 'Perda média', pct(avg(rows.map(r => r.loss_pct || 0)), 2) + '%', 'red'),
        stat('check', 'Disponível 24 h', pct(t.uptime_24h, 3) + '%', 'green'));
      const span = RANGE_S[range];
      ctx.chart(c1, {type: 'line', data: {datasets: [
        lineDS(c1, 'Latência (ms)', lat.map(r => ({x: r.ts * 1000, y: +r.latency.toFixed(2)})), C('--c1'), true),
        Object.assign(lineDS(c1, 'Jitter (ms)', rows.map(r => ({x: r.ts * 1000, y: +(r.jitter || 0).toFixed(2)})), C('--c2'), false), {borderDash: [4, 4]}),
      ]}, options: baseOpts(span, {})}).options.plugins.legend.display = true;
      ctx.charts[0].update();
      for (const b of (ub[name] || [])) {
        const cls = b.pct == null ? 'none' : b.pct >= 99.9 ? '' : b.pct >= 98 ? 'mid' : 'bad';
        bars.append(h('span', {class: 'bar ' + cls, title: `${hm(b.ts - 3600)}–${hm(b.ts)}: ${b.pct == null ? 'sem dados' : b.pct + '%'}`}));
      }
      if (hm_ && hm_.cells) {
        const lats = hm_.cells.map(c => c.lat).filter(v => v != null);
        const mx = Math.max(1, ...lats), mn = Math.min(...lats, mx);
        const grid = {};
        for (const c of hm_.cells) grid[c.d + ':' + c.h] = c;
        const hdr = h('div', {class: 'hr'}, h('span'));
        for (let i = 0; i < 24; i++) hdr.append(h('span', {text: i % 3 === 0 ? String(i).padStart(2, '0') : '', style: {textAlign: 'center'}}));
        heat.append(hdr);
        hm_.days.forEach((d, di) => {
          const row = h('div', {class: 'hr'}, h('span', {text: d.slice(8, 10) + '/' + d.slice(5, 7)}));
          for (let i = 0; i < 24; i++) {
            const c = grid[di + ':' + i];
            const cell = h('span', {class: 'c'});
            if (c) {
              const k = c.lat == null ? 1 : (c.lat - mn) / ((mx - mn) || 1);
              cell.style.background = c.loss > 2 ? 'var(--red)' : `hsla(${30 - k * 30}, 90%, ${62 - k * 12}%, ${0.25 + k * 0.75})`;
              cell.title = `${d} ${i}h: ${c.lat == null ? '--' : c.lat + ' ms'} · perda ${c.loss}%`;
            }
            row.append(cell);
          }
          heat.append(row);
        });
      }
    },
  });

  // ================================================================== INCIDENTES
  const TYPE_PT = {offline: 'Offline', latency: 'Latência', jitter: 'Jitter', loss: 'Perda', dns: 'DNS', cpu: 'CPU', temp: 'Temperatura',
    cert: 'Certificado', snmp: 'SNMP', snmpval: 'SNMP limite', agent: 'Agente', local: 'Queda local'};
  registerSheet('incidents', {
    title: 'Incidentes e eventos', icon: 'alert',
    async render(ctx) {
      const days = ctx.params.days || 7;
      ctx.tools.append(seg([[1, '24 h'], [7, '7 dias'], [30, '30 dias']], days, d => ctx.reopen({days: d})));
      const [L, R] = panels(ctx);
      const [sum, pats, list, evs, zbx] = await Promise.all([
        api('/api/incidents/summary?days=' + days), api('/api/insights/patterns?days=30').catch(() => []),
        api('/api/incidents?days=' + days), api('/api/events?limit=80'), api('/api/zabbix/problems').catch(() => null)]);
      if (!ctx.alive) return;
      const total = Object.values(sum).reduce((a, b) => a + b, 0);
      L.append(h('div', {class: 'bigstat'}, h('span', {class: 'l', text: 'Incidentes'}), h('span', {class: 'v'}, String(total), h('small', {text: days === 1 ? '24 h' : days + ' dias'}))));
      const orbs = h('div', {style: {display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '10px', textAlign: 'center', margin: '10px 0 6px'}});
      [['Alta', 'red'], ['Media', ''], ['Baixa', 'blue'], ['Info', 'grey']].forEach(([s, c]) => orbs.append(h('div', {},
        h('div', {class: 'orb ' + c, style: {margin: '0 auto 6px', width: '48px', height: '48px', fontWeight: '700'}, text: String(sum[s] || 0)}),
        h('div', {class: 'hint', text: s === 'Media' ? 'Média' : s}))));
      L.append(orbs);
      const short = list.filter(i => i.resolved_ts && i.resolved_ts - i.started_ts < 180).length;
      if (list.length) {
        L.append(h('div', {class: 'hint', style: {margin: '8px 0 14px'}, text: `${short} de ${list.length} duraram menos de 3 min.` +
          (short > list.length / 2 ? ' Muito ruído: considere subir os limites ou o mínimo de severidade das notificações.' : '')}));
      }
      L.append(h('div', {class: 'rule'}), h('h4', {class: 'hint', style: {fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em'}, text: 'Padrões (30 dias)'}));
      if (!pats.length) L.append(h('div', {class: 'hint', text: 'Nenhum padrão recorrente encontrado.'}));
      for (const p of pats) L.append(li('media', p.target, `por volta das ${String(p.hour).padStart(2, '0')}h`, p.count + '×'));
      const by = {};
      for (const i of list) { const k = TYPE_PT[i.type] || i.type; by[k] = (by[k] || 0) + 1; }
      if (Object.keys(by).length) {
        L.append(h('div', {class: 'rule'}), kv(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v + '×'])));
      }

      const active = list.filter(i => !i.resolved_ts);
      const actList = h('div', {class: 'list'});
      if (!active.length) actList.append(li('ok', 'Nenhum incidente ativo', null, ''));
      for (const i of active) actList.append(li(sevClass(i.severity), i.message, `${TYPE_PT[i.type] || i.type} · ${i.target}`, ['desde ' + hm(i.started_ts), h('br'), dur(Date.now() / 1000 - i.started_ts)]));
      R.append(sec('alert', 'Ativos', actList));
      if (zbx && zbx.enabled) {
        const zl = h('div', {class: 'list'});
        if (!zbx.ok) zl.append(li('media', 'Falha ao consultar o Zabbix', zbx.error, ''));
        if (zbx.ok && !zbx.problems.length) zl.append(li('ok', 'Sem problemas no Zabbix', null, ''));
        for (const p of zbx.problems.slice(0, 20)) {
          zl.append(li(p.severity >= 4 ? 'alta' : p.severity >= 3 ? 'media' : 'baixa', p.name, `${p.host} · ${p.severity_name}${p.ack ? ' · ack' : ''}`, dmhm(p.since)));
        }
        R.append(sec('server', 'Zabbix', zl));
      }
      const hl = h('div', {class: 'list'});
      for (const i of list.filter(x => x.resolved_ts).slice(0, 60)) {
        hl.append(li(sevClass(i.severity), i.message, `${TYPE_PT[i.type] || i.type} · ${dmhm(i.started_ts)}`, dur(i.resolved_ts - i.started_ts)));
      }
      if (!hl.children.length) hl.append(li('ok', 'Sem histórico no período', null, ''));
      R.append(sec('clock', 'Histórico', hl));
      const el = h('div', {class: 'list'});
      for (const e of evs.slice(0, 50)) el.append(li(sevClass(e.severity), e.message, null, dmhm(e.ts)));
      R.append(sec('file', 'Eventos', el));
    },
  });

  // ================================================================== DNS
  registerSheet('dns', {
    title: 'Servidores DNS', icon: 'globe',
    async render(ctx) {
      const range = ['1h', '24h', '7d'].includes(ctx.params.range) ? ctx.params.range : '24h';
      ctx.tools.append(seg([['1h', '1 h'], ['24h', 'Dia'], ['7d', 'Semana']], range, r => ctx.reopen({range: r})));
      const [L, R] = panels(ctx);
      const [cur, hist] = await Promise.all([api('/api/dns'), api('/api/dns/history?range=' + range)]);
      if (!ctx.alive) return;
      const sorted = [...cur].sort((a, b) => (num(a.latency) == null) - (num(b.latency) == null) || (a.latency - b.latency));
      L.append(h('div', {class: 'bigstat'}, h('span', {class: 'l', text: 'Mais rápido agora'}),
        h('span', {class: 'v', text: sorted[0] && sorted[0].latency != null ? sorted[0].name : '--'})));
      const lst = h('div', {class: 'list'});
      for (const s of sorted) lst.append(li(s.success === false ? 'alta' : 'ok', s.name, s.ip, s.latency == null ? '--' : ms(s.latency, 0) + ' ms'));
      L.append(lst, h('div', {class: 'rule'}),
        h('div', {class: 'hint', text: 'Consulta de teste: registro A do domínio configurado em config.json. "Lento" só abre incidente após 3 medições seguidas acima do limite.'}));
      const tiles = h('div', {class: 'tiles'});
      R.append(sec('globe', 'Por servidor', tiles));
      for (const s of cur) {
        const pts = hist[s.name] || [];
        const vals = pts.map(p => p.latency);
        const okp = pts.length ? pts.reduce((a, p) => a + p.ok_pct, 0) / pts.length : null;
        const sp = h('div', {class: 'tspark'});
        sp.append(sparkArea(vals, 300, 70, C('--spark')));
        sp.firstChild.style.width = '100%'; sp.firstChild.style.height = '100%';
        tiles.append(h('div', {class: 'tile'}, h('h4', {text: s.name}), h('div', {class: 'tsub mono', text: s.ip}), sp,
          h('div', {class: 'tfoot'}, h('span', {class: 'orb ' + (s.success === false ? 'red' : ''), trusted: ICO('globe')}),
            h('span', {class: 'big'}, s.latency == null ? '--' : ms(s.latency, 0), h('sup', {text: ' ms'})),
            h('span', {class: 'ctrl', text: okp == null ? '--' : pct(okp, 2) + '% ok'}))));
      }
      const [box, cv] = chartBox('tall');
      R.append(sec('activity', 'Comparativo', box));
      ctx.chart(cv, {type: 'line', data: {datasets: Object.entries(hist).map(([n, pts], i) =>
        lineDS(cv, n, pts.filter(p => p.latency != null).map(p => ({x: p.ts * 1000, y: +p.latency.toFixed(1)})), pal(i)))},
      options: baseOpts(RANGE_S[range])}).options.plugins.legend.display = true;
      ctx.charts[0].update();
    },
  });

  // ================================================================== MIKROTIK
  registerSheet('mikrotik', {
    title: 'MikroTik', icon: 'router',
    async render(ctx) {
      const range = ['1h', '24h', '7d'].includes(ctx.params.range) ? ctx.params.range : '24h';
      ctx.tools.append(seg([['1h', '1 h'], ['24h', 'Dia'], ['7d', 'Semana']], range, r => ctx.reopen({range: r})));
      const [L, R] = panels(ctx);
      const st = await api('/api/mikrotik/status');
      if (!st.enabled) {
        L.append(h('div', {class: 'hint', text: 'Integração desativada.'}));
        R.append(h('div', {class: 'callout blue'}, h('b', {text: 'MikroTik não configurado'}),
          'Ative a API REST no RouterOS v7 (/ip service enable www ou www-ssl) e configure em Configurações → MikroTik.'),
        tbtn('Abrir configurações', 'gear', () => openSheet('config', {tab: 'integ'}), 'primary'));
        return;
      }
      const top = h('div', {style: {display: 'flex', justifyContent: 'space-between', margin: '4px 0 18px'}});
      const memc = st.mem_pct, hddc = st.hdd_pct;
      [['cpu', 'CPU', st.cpu_load, ''], ['db', 'RAM', memc, 'blue'], ['hdd', 'Disco', hddc, 'grey'], ['thermo', 'Temp', st.temperature, 'red']].forEach(([ic, l, v, c]) =>
        top.append(h('div', {style: {textAlign: 'center'}}, h('div', {class: 'orb ' + c, style: {width: '52px', height: '52px', margin: '0 auto 6px', fontSize: '12px', fontWeight: '700'},
          text: v == null ? '--' : Math.round(v) + (ic === 'thermo' ? '°' : '%')}), h('div', {class: 'hint', text: l}))));
      L.append(top, kv([['Modelo', st.board_name], ['RouterOS', st.version], ['Uptime', st.uptime_s != null ? dur(st.uptime_s) : '--'],
        ['Host', st.host], ['Última coleta', st.ts ? ago(st.ts) : '--']]));
      if (st.stale) L.append(h('div', {class: 'callout', style: {marginTop: '14px'}, text: 'Dados desatualizados: a coleta está atrasada ou falhando.'}));
      const [cbox, cc] = chartBox('short');
      L.append(h('div', {class: 'rule'}), h('div', {class: 'bigstat'}, h('span', {class: 'l', text: 'CPU'}), h('span', {class: 'v'}, st.cpu_load != null ? Math.round(st.cpu_load) : '--', h('small', {text: '%'}))), cbox);
      const ifs = await api('/api/mikrotik/interfaces');
      const tiles = h('div', {class: 'tiles'});
      R.append(sec('network', 'Interfaces', tiles));
      const res = await api('/api/mikrotik/history?range=' + range);
      if (!ctx.alive) return;
      ctx.chart(cc, {type: 'line', data: {datasets: [lineDS(cc, 'CPU %', res.points.map(p => ({x: p.ts * 1000, y: p.cpu_load})), C('--spark'), true)]},
        options: baseOpts(RANGE_S[range], {})});
      if (!ifs.length) tiles.append(h('div', {class: 'hint', text: 'Sem coleta recente de interfaces.'}));
      const shown = ifs.filter(i => !i.disabled);
      await Promise.all(shown.map(async i => {
        const sp = h('div', {class: 'tspark'});
        const tile = h('div', {class: 'tile'}, h('h4', {text: i.name}), sp,
          h('div', {class: 'tfoot'}, h('span', {class: 'orb ' + (i.running ? 'green' : 'grey'), trusted: ICO(i.running ? 'down' : 'minus')}),
            h('span', {class: 'big', style: {fontSize: '17px'}, text: bps(i.rx_bps)}),
            h('span', {class: 'ctrl', title: 'Upload'}, h('span', {trusted: ICO('up')}), bps(i.tx_bps))));
        tiles.append(tile);
        const hh = await api('/api/mikrotik/history?range=' + range + '&iface=' + encodeURIComponent(i.name)).catch(() => null);
        if (hh && ctx.alive) {
          const svg = sparkArea(hh.points.map(p => p.rx_bps), 300, 70, C('--spark'));
          svg.style.width = '100%'; svg.style.height = '100%';
          sp.append(svg);
        }
      }));
      const hosts = await api('/api/dhcp/hosts').catch(() => []);
      if (!ctx.alive) return;
      const tbl = h('table', {class: 'tbl'}, h('thead', {}, h('tr', {}, ...['Dispositivo', 'IP', 'MAC', 'Visto', ''].map(x => h('th', {text: x})))));
      const tb = h('tbody');
      for (const d of hosts) {
        tb.append(h('tr', {},
          h('td', {}, h('span', {style: {color: d.active ? 'var(--green)' : 'var(--muted)'}, text: '● '}), d.hostname || '(sem nome)'),
          h('td', {class: 'mono', text: d.ip}), h('td', {class: 'mono', text: d.mac}), h('td', {text: ago(d.last_seen)}),
          h('td', {class: 'num'}, d.promoted_target ? h('span', {class: 'hint', text: '✓ ' + d.promoted_target}) :
            tbtn('Monitorar', 'plus', async () => {
              if (needAdmin()) return;
              const nm = prompt('Nome do destino:', d.hostname || d.ip);
              if (!nm) return;
              if (await act(() => post(`/api/dhcp/hosts/${d.id}/promote`, {name: nm}), `"${nm}" agora é monitorado`)) { NN.loadTargets(); ctx.reopen(); }
            }))));
      }
      tbl.append(tb);
      R.append(sec('server', `Clientes DHCP (${hosts.filter(x => x.active).length} ativos)`, hosts.length ? tbl : h('div', {class: 'hint', text: 'Nenhum lease encontrado.'})));
    },
  });

  // ================================================================== ADGUARD
  registerSheet('adguard', {
    title: 'AdGuard Home', icon: 'shield',
    async render(ctx) {
      const range = ['24h', '7d', '30d'].includes(ctx.params.range) ? ctx.params.range : '7d';
      ctx.tools.append(seg([['24h', 'Dia'], ['7d', 'Semana'], ['30d', 'Mês']], range, r => ctx.reopen({range: r})));
      const [L, R] = panels(ctx);
      const cfg = await api('/api/settings/agh').catch(() => null);
      if (cfg && !cfg.enabled) {
        L.append(h('div', {class: 'hint', text: 'Integração desativada.'}));
        R.append(h('div', {class: 'callout blue'}, h('b', {text: 'AdGuard Home não configurado'}), 'Configure host, porta e usuário em Configurações → Integrações.'),
          tbtn('Abrir configurações', 'gear', () => openSheet('config', {tab: 'integ'}), 'primary'));
        return;
      }
      // dados gravados primeiro (rápido); status e top são consultas ao vivo e podem demorar se o AdGuard não responder
      const [s, hist] = await Promise.all([api('/api/agh/stats').catch(() => ({})), api('/api/agh/history?range=' + range).catch(() => [])]);
      if (!ctx.alive) return;
      const head = h('div', {style: {display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '16px'}},
        h('div', {class: 'orb grey', style: {width: '58px', height: '58px'}, trusted: ICO('shield')}),
        h('div', {}, h('div', {style: {fontSize: '18px', fontWeight: '700'}, text: 'Verificando…'}), h('div', {class: 'hint', text: cfg ? cfg.host : ''})));
      L.append(head);
      L.append(kv([['Consultas', s.num_dns_queries != null ? s.num_dns_queries.toLocaleString('pt-BR') : '--'],
        ['Bloqueadas', s.num_blocked_filtering != null ? s.num_blocked_filtering.toLocaleString('pt-BR') : '--'],
        ['% bloqueado', pct(s.blocked_pct, 2) + '%'], ['Tempo médio', s.avg_processing_time != null ? ms(s.avg_processing_time * 1000, 1) + ' ms' : '--'],
        ['Última coleta', s.ts ? ago(s.ts) : '--']]));
      L.append(h('div', {class: 'hint', style: {marginTop: '14px'}, text: 'Os totais são a janela de estatísticas do próprio AdGuard (normalmente 24 h).'}));
      if (cfg && cfg.sync_interval_seconds > 600) {
        L.append(h('div', {class: 'callout', style: {marginTop: '14px'}, text: `Coleta a cada ${dur(cfg.sync_interval_seconds)}: o gráfico fica com poucos pontos. Recomendado: 300 s.`}));
      }
      R.append(h('div', {class: 'stats'}, stat('globe', 'Consultas', (s.num_dns_queries || 0).toLocaleString('pt-BR')),
        stat('shield', 'Bloqueadas', (s.num_blocked_filtering || 0).toLocaleString('pt-BR'), 'red'),
        stat('gauge', '% bloqueado', pct(s.blocked_pct, 1) + '%', 'blue')));
      const [box, cv] = chartBox();
      R.append(sec('activity', 'Consultas × bloqueios', box));
      ctx.chart(cv, {type: 'line', data: {datasets: [
        lineDS(cv, 'Consultas', hist.map(p => ({x: p.ts * 1000, y: p.num_dns_queries})), C('--c2'), true),
        lineDS(cv, 'Bloqueadas', hist.map(p => ({x: p.ts * 1000, y: p.num_blocked_filtering})), C('--c1'), true)]},
      options: baseOpts(RANGE_S[range])}).options.plugins.legend.display = true;
      ctx.charts[0].update();
      const tiles = h('div', {class: 'tiles'});
      const lists = {};
      [['clients', 'Top clientes', 'user'], ['queried', 'Mais consultados', 'globe'], ['blocked', 'Mais bloqueados', 'shield']].forEach(([k, t, ic]) => {
        lists[k] = h('div', {class: 'list', style: {marginTop: '8px'}}, h('div', {class: 'hint', text: 'carregando…'}));
        tiles.append(h('div', {class: 'tile'}, h('h4', {}, h('span', {trusted: ICO(ic)}), t), lists[k]));
      });
      R.append(tiles);
      api('/api/agh/status').then(st => {
        if (!ctx.alive) return;
        const orb = head.firstChild, title = head.lastChild.firstChild, sub = head.lastChild.lastChild;
        orb.className = 'orb ' + (st.online ? (st.protection_enabled ? 'green' : '') : 'red');
        title.textContent = st.online ? (st.protection_enabled ? 'Proteção ativa' : 'Proteção desligada') : 'Sem resposta';
        sub.textContent = (st.host || '') + (st.version ? ' · ' + st.version : '');
      }).catch(() => {});
      api('/api/agh/top').then(top => {
        if (!ctx.alive) return;
        for (const k of Object.keys(lists)) {
          const l = clear(lists[k]);
          const arr = top[k] || [];
          const mx = Math.max(1, ...arr.map(x => x.count));
          for (const x of arr) {
            const row = li('', x.name, null, x.count.toLocaleString('pt-BR'));
            row.style.background = `linear-gradient(90deg, rgba(245,158,46,.18) ${100 * x.count / mx}%, transparent 0)`;
            l.append(row);
          }
          if (!arr.length) l.append(h('div', {class: 'hint', text: 'Sem dados (AdGuard não respondeu)'}));
        }
      }).catch(() => {});
    },
  });

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
    R.classList.add('topo-map');
    R.append(kp, host);
    let m = null, drawnSig = '', drawnAt = 0;
    const kpi = (orb, icon, l, v, sub) => h('div', {class: 'tm-kpi'}, h('span', {class: 'orb ' + orb, trusted: ICO(icon)}),
      h('span', {style: {minWidth: 0}}, h('span', {class: 'l', text: l}), h('span', {class: 'v', text: String(v)}), h('span', {class: 's', text: sub})));
    async function load() {
      const D = await api('/api/topomap');
      if (!ctx.alive) return;
      const s = D.summary;
      clear(kp).append(
        kpi('green', 'check', 'Destinos online', `${s.ok + s.warn}/${s.total}`, s.total ? 'respondendo agora' : 'nenhum destino'),
        kpi(s.bad ? 'red' : 'green', s.bad ? 'x' : 'check', 'Fora do ar', s.bad, s.bad ? 'causa raiz' : 'nenhum problema'),
        kpi(s.warn ? '' : 'green', 'alert', 'Avisos', s.warn, 'lento ou com perda'),
        kpi(s.iso ? 'grey' : 'blue', 'network', 'Isolados', s.iso, 'atrás de um equipamento caído'));
      const sg = NNMap.sig(D);
      if (!m || sg !== drawnSig || Date.now() - drawnAt > 60000) {
        if (m) m.destroy();
        m = NNMap.render(host, D, {onItem: n => openSheet('target', {name: n}), onCam: ch => openSheet('cameras', {ch})});
        drawnSig = sg; drawnAt = Date.now();
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
      L.append(h('h4', {class: 'side-h', text: 'Problemas agora'}));
      const act_ = NN.S.active || [];
      if (!act_.length) L.append(h('div', {class: 'hint', style: {color: 'var(--green)'}, text: 'Nenhum problema ✓'}));
      const pl = h('div', {class: 'list'});
      for (const i of act_.slice(0, 6)) pl.append(li(sevClass(i.severity), i.target, i.message, hm(i.started_ts), () => openSheet('incidents')));
      L.append(pl, h('div', {class: 'rule'}));
      L.append(h('div', {class: 'hint', text: 'Agrupe os destinos abrindo um card → "Grupo no mapa" (ex.: Servidores, Wi-Fi, Câmeras). Sem grupo: os de internet vão para "Internet", os locais para "Rede local", e quem tem dependentes ganha caixa própria. As ligações seguem o "Depende de".'}));
    }
    await load();
    ctx.every(10000, load);
    ctx.cleanups.push(() => { if (m) m.destroy(); });
  }

  // ================================================================== FERRAMENTAS
  registerSheet('tools', {
    title: 'Ferramentas', icon: 'wrench', single: true,
    async render(ctx) {
      const R = h('div', {class: 'panel main'}); ctx.body.append(R);
      if (!NN.isAdmin()) R.append(h('div', {class: 'callout blue', text: 'As ferramentas exigem perfil administrador.'}));
      const tiles = h('div', {class: 'tiles', style: {gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))'}});
      R.append(tiles);

      // speedtest
      const spOut = h('div', {class: 'list'});
      const spBtn = tbtn('Iniciar teste', 'play', async () => {
        spBtn.disabled = true; spBtn.lastChild.textContent = 'Testando… (~30 s)';
        const r = await act(() => post('/api/speedtest/run'));
        spBtn.disabled = false; spBtn.lastChild.textContent = 'Iniciar teste';
        if (r) loadSpeed();
      }, 'primary');
      async function loadSpeed() {
        const rows = await api('/api/speedtest/history?limit=6').catch(() => []);
        clear(spOut);
        if (!rows.length) spOut.append(h('div', {class: 'hint', text: 'Nenhum teste ainda.'}));
        for (const r of rows) spOut.append(li('ok', `↓ ${r.download ?? '--'}  ↑ ${r.upload ?? '--'} Mbps`, `latência ${ms(r.latency, 0)} ms`, dmhm(r.ts)));
      }
      loadSpeed();
      tiles.append(h('div', {class: 'tile'}, h('h4', {}, h('span', {trusted: ICO('gauge')}), 'Teste de velocidade'),
        h('div', {class: 'tsub', style: {marginBottom: '10px'}, text: 'Cloudflare · 25 MB download / 5 MB upload'}), spBtn, h('div', {style: {height: '10px'}}), spOut));

      // traceroute
      const trHost = inp({placeholder: '8.8.8.8 ou dominio.com'});
      const trOut = h('div', {class: 'out', text: '—'});
      const trBtn = tbtn('Rastrear', 'route', async () => {
        if (!trHost.value.trim()) return;
        trBtn.disabled = true; trOut.textContent = 'executando…';
        const r = await act(() => api('/api/tools/traceroute?host=' + encodeURIComponent(trHost.value.trim())));
        trBtn.disabled = false;
        trOut.textContent = r ? r.hops.map(x => `${String(x.hop).padStart(2)}  ${(x.ip || '*').padEnd(40)} ${x.ms != null ? x.ms + ' ms' : ''}`).join('\n') || 'sem resposta' : 'falhou';
      }, 'primary');
      tiles.append(h('div', {class: 'tile'}, h('h4', {}, h('span', {trusted: ICO('route')}), 'Traceroute'),
        h('div', {class: 'form'}, trHost, trBtn, trOut)));

      // v4 x v6
      const ipHost = inp({placeholder: 'google.com'});
      const ipOut = h('div', {class: 'list'});
      const ipBtn = tbtn('Comparar', 'activity', async () => {
        if (!ipHost.value.trim()) return;
        ipBtn.disabled = true;
        const r = await act(() => api('/api/tools/ipcompare?host=' + encodeURIComponent(ipHost.value.trim())));
        ipBtn.disabled = false;
        clear(ipOut);
        if (!r) return;
        for (const fam of ['ipv4', 'ipv6']) {
          const x = r[fam] || {};
          ipOut.append(li(x.address ? 'ok' : 'info', fam.toUpperCase() + (x.address ? ' · ' + x.address : ''),
            x.address ? `perda ${pct(x.loss_pct, 0)}% · min ${ms(x.min_ms)} · máx ${ms(x.max_ms)}` : (x.error || ''), x.avg_ms != null ? ms(x.avg_ms) + ' ms' : '--'));
        }
        if (r.diff_ms != null) ipOut.append(h('div', {class: 'hint', text: `IPv6 ${r.diff_ms > 0 ? 'mais lento' : 'mais rápido'} em ${ms(Math.abs(r.diff_ms))} ms`}));
      }, 'primary');
      tiles.append(h('div', {class: 'tile'}, h('h4', {}, h('span', {trusted: ICO('layers')}), 'IPv4 × IPv6'), h('div', {class: 'form'}, ipHost, ipBtn, ipOut)));

      // descoberta
      const cidr = inp({placeholder: '192.168.1.0/24'});
      const dOut = h('div', {class: 'list'});
      const dBtn = tbtn('Varrer rede', 'search', async () => {
        if (!cidr.value.trim()) return;
        const r = await act(() => post('/api/tools/discover', {cidr: cidr.value.trim()}));
        if (!r) return;
        dBtn.disabled = true;
        const poll = ctx.every(1500, async () => {
          const s = await api('/api/tools/discover/' + r.job).catch(() => null);
          if (!s) return;
          clear(dOut).append(h('div', {class: 'hint', text: `${s.done}/${s.total} verificados · ${s.found.length} encontrados`}));
          for (const f of s.found) {
            dOut.append(li(f.monitored ? 'ok' : 'baixa', f.ip + (f.hostname ? ' · ' + f.hostname : ''), f.mac || '',
              f.monitored ? 'monitorado' : tbtn('Monitorar', 'plus', async () => {
                const nm = prompt('Nome do destino:', f.hostname || f.ip);
                if (nm && await act(() => post('/api/settings/targets', {name: nm, host: f.ip}), `"${nm}" adicionado`)) NN.loadTargets();
              })));
          }
          if (s.status === 'done') { clearInterval(poll); dBtn.disabled = false; }
        });
      }, 'primary');
      tiles.append(h('div', {class: 'tile'}, h('h4', {}, h('span', {trusted: ICO('search')}), 'Descoberta de rede'),
        h('div', {class: 'tsub', style: {marginBottom: '10px'}, text: 'Somente redes privadas, até /22.'}), h('div', {class: 'form'}, cidr, dBtn, dOut)));
    },
  });

  // ================================================================== SLA
  registerSheet('sla', {
    title: 'Relatório de SLA', icon: 'file', single: true,
    async render(ctx) {
      const month = ctx.params.month || '';
      const days = ctx.params.days || 30;
      const mIn = inp({type: 'month', value: month, style: {height: '36px', width: '170px'}});
      mIn.addEventListener('change', () => ctx.reopen({month: mIn.value, days}));
      const q = month ? 'month=' + month : 'days=' + days;
      const csv = h('a', {class: 'tbtn', href: '/api/sla.csv?' + q, download: 'sla.csv', style: {textDecoration: 'none'}}, h('span', {trusted: ICO('download')}), 'CSV');
      ctx.tools.append(seg([[7, '7 dias'], [30, '30 dias'], [90, '90 dias']], month ? 0 : days, d => ctx.reopen({days: d, month: ''})), mIn, csv);
      const R = h('div', {class: 'panel main'}); ctx.body.append(R);
      const rep = await api('/api/sla?' + q);
      if (!ctx.alive) return;
      R.append(h('div', {class: 'hint', style: {marginBottom: '10px'}, text: `Período: ${dmhm(rep.start)} → ${dmhm(rep.end)}. Disponibilidade = amostras com resposta / total. MTTR e MTBF consideram incidentes "offline".`}));
      const cols = ['Destino', 'Disponível', 'Amostras', 'Lat. média', 'Lat. máx', 'Jitter', 'Quedas', 'Tempo fora', 'MTTR', 'MTBF'];
      const tbl = h('table', {class: 'tbl'}, h('thead', {}, h('tr', {}, ...cols.map((c, i) => h('th', {class: i ? 'num' : '', text: c})))));
      const tb = h('tbody');
      for (const t of rep.targets) {
        const a = t.availability_pct;
        tb.append(h('tr', {},
          h('td', {text: t.target}),
          h('td', {class: 'num', style: {color: a == null ? '' : a >= 99.9 ? 'var(--green)' : a >= 99 ? 'var(--orange)' : 'var(--red)', fontWeight: '700'}, text: a == null ? '--' : pct(a, 3) + '%'}),
          h('td', {class: 'num', text: t.samples.toLocaleString('pt-BR')}), h('td', {class: 'num', text: ms(t.avg_latency_ms) + ' ms'}),
          h('td', {class: 'num', text: ms(t.max_latency_ms) + ' ms'}), h('td', {class: 'num', text: ms(t.avg_jitter_ms) + ' ms'}),
          h('td', {class: 'num', text: String(t.outages)}), h('td', {class: 'num', text: t.downtime_s ? dur(t.downtime_s) : '0'}),
          h('td', {class: 'num', text: t.mttr_s != null ? dur(t.mttr_s) : '--'}), h('td', {class: 'num', text: t.mtbf_s != null ? dur(t.mtbf_s) : '--'})));
      }
      tbl.append(tb);
      R.append(h('div', {style: {overflowX: 'auto'}}, tbl));
    },
  });

  // ================================================================== CÂMERAS
  // Vídeo só roda com esta tela aberta e visível; ao fechar/trocar de aba os streams são encerrados.
  function camTile(ch, opts) {
    const img = h('img', {alt: '', src: `/api/cam/snapshot/${ch.ch}?last=1&t=${Date.now()}`});
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    const badge = h('span', {class: 'cam-badge', text: ch.loss ? 'SEM VÍDEO' : 'FOTO'});
    if (ch.loss) badge.classList.add('loss');
    const msg = h('div', {class: 'cam-msg'});
    const video = h('video', {muted: true, playsinline: true, autoplay: true});
    video.muted = true;
    const act = h('div', {class: 'cam-act'},
      h('a', {href: `/api/cam/snapshot/${ch.ch}`, download: `camera-${ch.ch}.jpg`, title: 'Baixar foto agora', trusted: ICO('download'), onclick: e => e.stopPropagation()}),
      opts.full ? null : h('button', {type: 'button', title: 'Tela cheia', trusted: ICO('expand'), onclick: e => { e.stopPropagation(); opts.onOpen(); }}));
    const tile = h('div', {class: 'camtile' + (opts.full ? ' full' : ''), onclick: opts.full ? null : opts.onOpen},
      img, video, h('div', {class: 'cam-top'}, h('span', {trusted: ICO('video')}), ch.name, badge), msg, act);
    return {tile, img, video, badge, msg};
  }
  function startLive(t, src) {
    return NNCam.play(t.video, src, s => {
      if (s === 'playing') { t.tile.classList.add('playing'); t.badge.className = 'cam-badge live'; t.badge.textContent = 'AO VIVO'; clear(t.msg); }
      else if (s === 'connecting' || s === 'reconnecting') { t.badge.className = 'cam-badge'; t.badge.textContent = s === 'connecting' ? 'CONECTANDO' : 'RECONECTANDO'; }
      else if (s.startsWith('error:')) { t.tile.classList.remove('playing'); t.badge.className = 'cam-badge loss'; t.badge.textContent = 'ERRO'; clear(t.msg).append(h('span', {text: s.slice(6)})); }
    });
  }

  registerSheet('cameras', {
    title: p => p.ch ? 'Câmera ' + p.ch : 'Câmeras', icon: 'video', single: true,
    async render(ctx) {
      const st = await api('/api/cam/status');
      if (!ctx.alive) return;
      const R = h('div', {class: 'panel main'}); ctx.body.append(R);
      if (!st.enabled) {
        R.append(h('div', {class: 'callout blue'}, h('b', {text: 'DVR não configurado'}),
          'Informe o IP, usuário e senha do DVR em Configurações → Integrações. Use um usuário do DVR só com permissão de visualização.'),
        tbtn('Configurar DVR', 'gear', () => openSheet('config', {tab: 'integ'}), 'primary'));
        return;
      }
      const g2 = st.go2rtc || {};
      const liveOk = g2.binary && g2.running;
      let mode = ctx.params.mode || (liveOk ? 'live' : 'foto');
      if (!liveOk) mode = 'foto';
      const full = ctx.params.ch ? st.channels.find(c => c.ch === Number(ctx.params.ch)) : null;
      const hd = ctx.params.hd !== false;
      // ferramentas
      if (full) {
        ctx.tools.append(tbtn('Mosaico', 'grid', () => ctx.reopen({ch: null})),
          seg(st.channels.map(c => [c.ch, String(c.ch)]), full.ch, c => ctx.reopen({ch: c})));
        if (liveOk) ctx.tools.append(seg([[true, 'HD'], [false, 'Leve']], hd, v => ctx.reopen({hd: v})));
      } else if (liveOk) {
        ctx.tools.append(seg([['live', 'Ao vivo'], ['foto', 'Fotos']], mode, m => ctx.reopen({mode: m})));
      }
      if (!liveOk) {
        R.append(h('div', {class: 'callout'}, h('b', {text: 'Vídeo ao vivo indisponível — mostrando fotos'}),
          g2.binary ? (g2.error || 'O go2rtc não está rodando.') : 'O go2rtc não está instalado no servidor. Rode ./install.sh de novo para baixá-lo.'));
      }
      for (const w of st.warnings || []) R.append(h('div', {class: 'callout', text: w}));

      const tiles = [];
      if (full) {
        const t = camTile(full, {full: true});
        R.append(t.tile);
        tiles.push([full, t]);
      } else {
        const grid = h('div', {class: 'camgrid'});
        const n = st.channels.length;
        grid.style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
        for (const c of st.channels) {
          const t = camTile(c, {onOpen: () => ctx.reopen({ch: c.ch})});
          grid.append(t.tile);
          tiles.push([c, t]);
        }
        R.append(grid);
      }
      // rodapé com informações do DVR
      const hdd = (st.hdd || [])[0];
      R.append(h('div', {class: 'cam-info'},
        h('span', {}, 'DVR ', h('b', {text: (st.model || '') + (st.host ? ' · ' + st.host : '')})),
        st.version ? h('span', {}, 'Firmware ', h('b', {text: st.version})) : null,
        hdd ? h('span', {}, 'HD ', h('b', {text: hdd.error ? 'com erro' : (hdd.used_pct != null ? pct(hdd.used_pct, 0) + '% usado de ' + Math.round(hdd.total_gb) + ' GB' : (hdd.state || 'ok'))})) : null,
        h('span', {}, 'Eventos ', h('b', {text: !st.events.enabled ? 'desligados' : st.events.connected ? 'conectado' : ('desconectado' + (st.events.error ? ' (' + st.events.error + ')' : ''))})),
        h('span', {}, 'Modo ', h('b', {text: mode === 'live' ? 'ao vivo — o vídeo para quando você fecha esta tela' : 'fotos a cada 3 s'}))));

      // execução: vídeo ou fotos, só enquanto a aba estiver visível
      let running = false, photoT = null, players = [];
      function startAll() {
        if (running || !ctx.alive) return;
        running = true;
        if (mode === 'live') {
          players = tiles.map(([c, t]) => startLive(t, full ? `ch${c.ch}${hd ? '_hd' : ''}` : `ch${c.ch}`));
        } else {
          const tick = () => {
            for (const [c, t] of tiles) {
              const im = new Image();
              im.onload = () => { t.img.src = im.src; t.img.style.visibility = ''; t.badge.textContent = 'FOTO ' + hm(Date.now() / 1000); };
              im.src = `/api/cam/snapshot/${c.ch}?t=${Date.now()}`;
            }
          };
          tick();
          photoT = setInterval(tick, 3000);
        }
      }
      function stopAll() {
        running = false;
        clearInterval(photoT);
        players.forEach(p => { try { p.stop(); } catch (_) { /* ok */ } });
        players = [];
        for (const [, t] of tiles) t.tile.classList.remove('playing');
      }
      function onVis() { if (document.hidden) stopAll(); else startAll(); }
      document.addEventListener('visibilitychange', onVis);
      ctx.cleanups.push(stopAll, () => document.removeEventListener('visibilitychange', onVis));
      startAll();
    },
  });

  // ================================================================== CONFIGURAÇÕES
  const RECOMMENDED = {ping_interval_seconds: 10, dns_check_interval_seconds: 30, public_ip_interval_seconds: 300, system_interval_seconds: 15};
  const IV_LABEL = {ping_interval_seconds: 'Ping (s)', dns_check_interval_seconds: 'DNS (s)', public_ip_interval_seconds: 'IP público (s)', system_interval_seconds: 'Sistema (s)'};

  function integForm(kind, cfg, R) {
    const isMt = kind === 'mikrotik';
    const [swEl, en] = sw('Ativado', cfg.enabled);
    const host = inp({value: cfg.host || '', placeholder: isMt ? '192.168.88.1' : '192.168.1.5'});
    const port = inp({type: 'number', value: cfg.port || (isMt ? 443 : 3000)});
    const [swH, https] = sw('HTTPS', cfg.use_https);
    const user = inp({value: cfg.username || '', autocomplete: 'off'});
    const pass = inp({type: 'password', value: cfg.password || '', autocomplete: 'new-password'});
    const iv = inp({type: 'number', min: 15, value: cfg.sync_interval_seconds || 60});
    const save = async () => {
      if (needAdmin()) return;
      const body = {enabled: en.checked, host: host.value.trim(), port: +port.value, use_https: https.checked,
        username: user.value.trim(), password: pass.value, sync_interval_seconds: +iv.value};
      if (isMt) body.verify_ssl = !!cfg.verify_ssl;
      await act(() => post('/api/settings/' + kind, body), 'Salvo');
    };
    const test = async () => {
      const r = await act(() => post('/api/settings/' + kind + '/test'));
      if (r) toast(isMt ? `Conectado · ${r.leases_found} leases DHCP` : `Conectado · AdGuard ${r.version || ''}`);
    };
    const warn = (+cfg.sync_interval_seconds || 60) > 600
      ? h('div', {class: 'callout', text: `Intervalo atual de ${dur(cfg.sync_interval_seconds)}: gráficos e vazão ficam sem sentido. Recomendado: ${isMt ? '60' : '300'} s.`}) : null;
    R.append(sec(isMt ? 'router' : 'shield', isMt ? 'MikroTik (API REST)' : 'AdGuard Home', warn,
      h('div', {class: 'form'}, h('div', {class: 'row2'}, field('Host', host), field('Porta', port)),
        h('div', {class: 'row2'}, field('Usuário', user), field('Senha', pass)),
        h('div', {class: 'row2'}, field('Intervalo de coleta (s)', iv), h('div', {style: {display: 'flex', gap: '18px', alignItems: 'end', paddingBottom: '10px'}}, swEl, swH)),
        h('div', {class: 'hint', text: 'A senha salva aparece mascarada. Se mudar host/porta/usuário, digite a senha de novo.'}),
        h('div', {style: {display: 'flex', gap: '8px'}}, tbtn('Salvar', 'check', save, 'primary'), tbtn('Testar', 'activity', test)))));
  }

  function dvrForm(cfg, R, ctx) {
    const [swEl, en] = sw('Ativado', cfg.enabled);
    const [swEv, ev] = sw('Alertas de perda de vídeo e HD', cfg.events);
    const [swH, https] = sw('HTTPS', cfg.use_https);
    const host = inp({value: cfg.host || '', placeholder: '192.168.1.108'});
    const hp = inp({type: 'number', value: cfg.http_port || 80});
    const rp = inp({type: 'number', value: cfg.rtsp_port || 554});
    const user = inp({value: cfg.username || '', autocomplete: 'off'});
    const pass = inp({type: 'password', value: cfg.password || '', autocomplete: 'new-password'});
    const chs = select([[1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']], cfg.channels || 4);
    const tpl = inp({value: cfg.rtsp_template || '', placeholder: 'padrão Intelbras/Dahua (deixe vazio)', class: 'inp mono'});
    const out = h('div', {class: 'list', style: {marginTop: '12px'}});
    const body = () => ({enabled: en.checked, host: host.value.trim(), http_port: +hp.value, rtsp_port: +rp.value, use_https: https.checked,
      username: user.value.trim(), password: pass.value, channels: +chs.value, events: ev.checked, rtsp_template: tpl.value.trim()});
    const save = async () => { if (needAdmin()) return false; return !!(await act(() => post('/api/settings/dvr', body()), 'DVR salvo')); };
    const test = async () => {
      if (!(await save())) return;
      clear(out).append(h('div', {class: 'hint', text: 'Testando…'}));
      const r = await act(() => post('/api/settings/dvr/test'));
      clear(out);
      if (!r) return;
      out.append(li('ok', `${r.model || 'DVR'} · firmware ${r.version || '?'}`, `${r.snapshots_ok}/${r.channels.length} canais responderam com imagem`,
        r.go2rtc && r.go2rtc.running ? 'vídeo ao vivo pronto' : (r.go2rtc && r.go2rtc.binary ? 'go2rtc iniciando…' : 'go2rtc não instalado')));
      for (const c of r.channels) out.append(li(/265/.test((c.sub || '') + (c.main || '')) ? 'media' : 'ok', `Canal ${c.ch}: ${c.name}`,
        `principal ${c.main || '?'} · extra ${c.sub || '?'}`, ''));
      for (const d of r.hdd || []) out.append(li(d.error ? 'alta' : 'ok', `HD ${d.disk}`, d.used_pct != null ? `${pct(d.used_pct, 0)}% de ${d.total_gb} GB` : (d.state || ''), ''));
      for (const w of r.warnings || []) out.append(li('media', w, null, ''));
      // diagnóstico: o que o firmware respondeu (vídeo ao vivo só precisa do RTSP)
      for (const c of r.checks || []) out.append(li(c.ok ? 'ok' : 'baixa', c.name, c.ok ? null : (c.error || 'sem resposta'), c.ok ? 'ok' : 'indisponível'));
    };
    R.append(sec('video', 'DVR Intelbras (câmeras)',
      h('div', {class: 'callout blue'}, h('b', {text: 'Crie no DVR um usuário só de visualização'}),
        'e deixe o stream extra (e de preferência o principal) em H.264 — o navegador não toca H.265. O vídeo só é puxado do DVR enquanto alguém está na tela de câmeras.'),
      h('div', {class: 'form'},
        h('div', {class: 'row2'}, field('IP do DVR', host), field('Canais', chs)),
        h('div', {class: 'row2'}, field('Usuário', user), field('Senha', pass)),
        h('div', {class: 'row2'}, field('Porta HTTP', hp), field('Porta RTSP', rp)),
        h('div', {style: {display: 'flex', gap: '18px', flexWrap: 'wrap'}}, swEl, swEv, swH),
        h('details', {}, h('summary', {class: 'hint', style: {cursor: 'pointer'}, text: 'Avançado: modelo de URL RTSP'}),
          h('div', {class: 'form', style: {marginTop: '8px'}}, tpl,
            h('div', {class: 'hint', text: 'Variáveis: {user} {password} {host} {rtsp_port} {ch} {sub}. Padrão: rtsp://{user}:{password}@{host}:{rtsp_port}/cam/realmonitor?channel={ch}&subtype={sub}'}))),
        h('div', {style: {display: 'flex', gap: '8px'}}, tbtn('Salvar', 'check', save, 'primary'), tbtn('Salvar e testar', 'activity', test))),
      out));
  }

  registerSheet('config', {
    title: 'Configurações', icon: 'gear',
    async render(ctx) {
      const tab = ctx.params.tab || 'geral';
      ctx.tools.append(seg([['geral', 'Geral'], ['aparencia', 'Aparência'], ['destinos', 'Destinos'], ['alertas', 'Alertas'], ['integ', 'Integrações']], tab, t => ctx.reopen({tab: t})));
      const [L, R] = panels(ctx);
      // ---- painel esquerdo: sistema + coletores
      const sys = await api('/api/system').catch(() => null);
      if (sys) {
        L.append(h('div', {class: 'bigstat'}, h('span', {class: 'l', text: sys.host_label}), h('span', {class: 'v', text: 'v' + sys.version})));
        L.append(kv([['CPU', pct(sys.cpu_pct, 0) + '%'], ['Memória', pct(sys.mem_pct, 0) + '%'], ['Temperatura', sys.temp_c != null ? pct(sys.temp_c, 1) + ' °C' : '--'],
          ['Disco', sys.disk_pct != null ? pct(sys.disk_pct, 0) + '%' : '--'], ['Banco', sys.db_mb != null ? ms(sys.db_mb) + ' MB' : '--'],
          ['Host ligado há', sys.host_uptime_s ? dur(sys.host_uptime_s) : '--'], ['NetNOC rodando há', dur(sys.app_uptime_s)],
          ['Janela de avaliação', dur(sys.window_seconds)]]));
        L.append(h('div', {class: 'rule'}), h('h4', {class: 'hint', style: {fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em'}, text: 'Coletores'}));
        const wl = h('div', {class: 'list'});
        for (const w of sys.workers) {
          wl.append(li(w.status === 'ok' ? 'ok' : w.status === 'error' ? 'media' : 'alta', w.name,
            w.error ? w.error : `a cada ${dur(w.interval)} · ${w.runs} execuções`, w.last_run ? ago(w.last_run) : 'nunca'));
        }
        L.append(wl);
      }
      L.append(h('div', {class: 'rule'}), h('div', {class: 'form'},
        h('div', {class: 'hint', text: `Sessão: ${(S.me || {}).user} (${(S.me || {}).role})`}),
        h('a', {class: 'tbtn', href: '/classic#config', style: {textDecoration: 'none', justifyContent: 'center'}}, h('span', {trusted: ICO('gear')}), 'Avançado (interface clássica)'),
        h('div', {class: 'hint', text: 'SNMP, notificações Discord/webhook/e-mail, usuários, backup, Zabbix, multi-site e manutenção continuam na interface clássica.'}),
        tbtn('Sair', 'logout', async () => { await post('/api/logout').catch(() => {}); location.href = '/login'; }, 'danger')));

      if (!NN.isAdmin()) R.append(h('div', {class: 'callout blue', text: 'Perfil somente leitura: as alterações exigem um administrador.'}));

      if (tab === 'geral') {
        const iv = await api('/api/settings/intervals');
        const ins = {};
        const grid = h('div', {class: 'row2'});
        for (const k of Object.keys(IV_LABEL)) { ins[k] = inp({type: 'number', min: 1, max: 86400, value: iv[k]}); grid.append(field(IV_LABEL[k], ins[k])); }
        const off = Object.keys(RECOMMENDED).filter(k => iv[k] > RECOMMENDED[k] * 4);
        R.append(sec('clock', 'Intervalos de coleta',
          off.length ? h('div', {class: 'callout'}, h('b', {text: 'Intervalos muito longos'}),
            off.map(k => `${IV_LABEL[k].replace(' (s)', '')}: ${dur(iv[k])}`).join(' · ') +
            '. Com ping de 60 s a detecção de queda leva minutos e o painel de sistema fica horas atrasado.') : null,
          h('div', {class: 'form'}, grid,
            h('div', {class: 'hint', text: 'Alterações valem na hora (não precisa reiniciar).'}),
            h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}},
              tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                const body = {}; for (const k in ins) body[k] = +ins[k].value;
                if (await act(() => post('/api/settings/intervals', body), 'Intervalos salvos')) ctx.reopen();
              }, 'primary'),
              tbtn('Usar recomendados', 'bolt', () => { for (const k in RECOMMENDED) ins[k].value = RECOMMENDED[k]; })))));
        const sa = await api('/api/settings/speedtest').catch(() => null);
        if (sa) {
          const [saSw, saEn] = sw('Rodar o teste de velocidade todo dia', sa.enabled);
          const saAt = inp({type: 'time', value: sa.time, style: {maxWidth: '140px'}});
          R.append(sec('gauge', 'Speedtest automático',
            h('div', {class: 'form'}, saSw, field('Horário', saAt),
              h('div', {class: 'hint', text: 'Baixa ~25 MB e envia ~5 MB uma vez por dia. Prefira um horário de rede ociosa (madrugada). O resultado aparece na página inicial.'}),
              h('div', {}, tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                await act(() => post('/api/settings/speedtest', {enabled: saEn.checked, time: saAt.value}), 'Speedtest automático salvo');
              }, 'primary')))));
        }
        const an = await api('/api/settings/appname');
        const nameIn = inp({value: an.name, maxlength: 40});
        R.append(sec('home', 'Nome do painel', h('div', {class: 'form'}, nameIn, h('div', {}, tbtn('Salvar', 'check', async () => {
          if (needAdmin()) return;
          if (await act(() => post('/api/settings/appname', {name: nameIn.value}), 'Nome salvo')) { window.APP_NAME = nameIn.value.trim(); document.title = window.APP_NAME; }
        }, 'primary')))));
        const ps = await api('/api/settings/public-status').catch(() => null);
        if (ps) {
          const [swEl, en] = sw('Página pública /status ativada', ps.enabled);
          const title = inp({value: ps.title});
          const boxes = h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: '10px'}});
          const checks = {};
          for (const t of S.targets) {
            const c = h('input', {type: 'checkbox'}); c.checked = ps.targets.includes(t.name); checks[t.name] = c;
            boxes.append(h('label', {class: 'switch', style: {fontSize: '13px'}}, c, t.name + (isLocal(t) ? ' 🏠' : '')));
          }
          R.append(sec('eye', 'Página de status pública',
            ps.enabled && !ps.targets.length ? h('div', {class: 'callout', text: 'Ativada sem seleção = TODOS os destinos aparecem sem login, inclusive os internos (🏠). Selecione só os públicos.'}) : null,
            h('div', {class: 'form'}, swEl, field('Título', title), boxes,
              h('div', {}, tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                await act(() => post('/api/settings/public-status', {enabled: en.checked, title: title.value,
                  targets: Object.keys(checks).filter(k => checks[k].checked)}), 'Página pública salva');
              }, 'primary'), ' ', h('a', {class: 'tbtn', href: '/status', target: '_blank', rel: 'noopener', style: {textDecoration: 'none'}}, 'Abrir /status')))));
        }
      }

      if (tab === 'destinos') {
        const cfg = await api('/api/settings');
        const tbl = h('table', {class: 'tbl'}, h('thead', {}, h('tr', {}, ...['Destino', 'Host', 'Tipo', 'Depende de', 'Grupo', 'Intervalo', ''].map(x => h('th', {text: x})))));
        const tb = h('tbody');
        for (const t of cfg.targets) {
          tb.append(h('tr', {}, h('td', {text: t.name}), h('td', {class: 'mono', text: t.host}), h('td', {text: (t.type || 'icmp').toUpperCase() + (t.port ? ':' + t.port : '')}),
            h('td', {text: t.parent || '—'}), h('td', {text: t.group || 'auto'}), h('td', {text: t.interval ? t.interval + ' s' : 'padrão'}),
            h('td', {class: 'num'}, tbtn('', 'eye', () => openSheet('target', {name: t.name})), ' ',
              tbtn('', 'trash', async () => {
                if (needAdmin() || !confirm(`Remover "${t.name}"?`)) return;
                if (await act(() => del('/api/settings/targets/' + encodeURIComponent(t.name)), 'Removido')) { NN.loadTargets(); ctx.reopen(); }
              }, 'danger'))));
        }
        tbl.append(tb);
        R.append(sec('globe', `Destinos (${cfg.targets.length})`, h('div', {style: {overflowX: 'auto'}}, tbl)));
        // adicionar
        const nm = inp({placeholder: 'Nome'}), host = inp({placeholder: 'IP, host ou https://url'});
        const type = select([['icmp', 'ICMP (ping)'], ['tcp', 'TCP (porta)'], ['http', 'HTTP(S)']], 'icmp');
        const port = inp({type: 'number', placeholder: '443'}), status = inp({type: 'number', placeholder: '200 (opcional)'});
        const parent = select([['', '🌐 Raiz'], ...cfg.targets.map(t => [t.name, t.name])], '');
        const ivl = inp({type: 'number', placeholder: 'padrão'});
        const grp = inp({placeholder: 'automático', maxlength: 30, list: 'grpAdd'});
        const grpDl = h('datalist', {id: 'grpAdd'}, ...[...new Set(cfg.targets.map(x => x.group).filter(Boolean).concat(['Servidores', 'Rede local', 'Wi-Fi', 'Câmeras', 'Internet']))].map(g => h('option', {value: g})));
        const portF = field('Porta', port), stF = field('Status HTTP esperado', status);
        const sync = () => { portF.hidden = type.value !== 'tcp'; stF.hidden = type.value !== 'http'; };
        type.addEventListener('change', sync); sync();
        R.append(sec('plus', 'Adicionar destino', h('div', {class: 'form'},
          h('div', {class: 'row2'}, field('Nome', nm), field('Host / URL', host)),
          h('div', {class: 'row2'}, field('Tipo', type), field('Depende de', parent)),
          h('div', {class: 'row2'}, portF, stF, field('Intervalo próprio (s)', ivl)),
          h('div', {class: 'row2'}, field('Grupo no mapa', grp), grpDl),
          h('div', {class: 'hint', text: 'Dica: Instagram/Facebook limitam ICMP e geram "perda" falsa. Use HTTP (https://www.instagram.com) ou TCP 443.'}),
          h('div', {}, tbtn('Adicionar', 'plus', async () => {
            if (needAdmin()) return;
            const body = {name: nm.value.trim(), host: host.value.trim(), type: type.value, parent: parent.value || null};
            if (type.value === 'tcp') body.port = +port.value;
            if (type.value === 'http' && status.value) body.expect_status = +status.value;
            if (ivl.value) body.interval = +ivl.value;
            if (grp.value.trim()) body.group = grp.value.trim();
            if (await act(() => post('/api/settings/targets', body), 'Destino adicionado')) { NN.loadTargets(); ctx.reopen(); }
          }, 'primary')))));
        // DNS
        const dl = h('div', {class: 'list'});
        for (const d of cfg.dns_servers) dl.append(li('ok', d.name, d.ip, tbtn('', 'trash', async () => {
          if (needAdmin() || !confirm(`Remover DNS "${d.name}"?`)) return;
          if (await act(() => del('/api/settings/dns/' + encodeURIComponent(d.name)), 'Removido')) ctx.reopen();
        }, 'danger')));
        const dn = inp({placeholder: 'Nome'}), dip = inp({placeholder: 'IP'});
        R.append(sec('globe', 'Servidores DNS', dl, h('div', {class: 'row2', style: {marginTop: '12px'}}, dn, dip),
          h('div', {style: {marginTop: '10px'}}, tbtn('Adicionar DNS', 'plus', async () => {
            if (needAdmin()) return;
            if (await act(() => post('/api/settings/dns', {name: dn.value.trim(), ip: dip.value.trim()}), 'DNS adicionado')) ctx.reopen();
          }, 'primary'))));
      }

      if (tab === 'alertas') {
        const tg = await api('/api/settings/telegram');
        const [swEl, en] = sw('Alertas no Telegram', tg.enabled);
        const tok = inp({type: 'password', value: tg.bot_token, autocomplete: 'off'});
        const chat = inp({value: tg.chat_id});
        const sev = select([['Alta', 'Só Alta'], ['Media', 'Média e acima'], ['Baixa', 'Baixa e acima'], ['Info', 'Tudo (inclui Info)']], tg.min_severity);
        R.append(sec('bolt', 'Telegram',
          tg.min_severity === 'Info' || tg.min_severity === 'Baixa'
            ? h('div', {class: 'callout', text: 'Severidade mínima baixa: "DNS lento" e afins vão todos para o celular. Recomendado: Média.'}) : null,
          h('div', {class: 'form'}, swEl, h('div', {class: 'row2'}, field('Token do bot', tok), field('Chat ID', chat)),
            field('Enviar a partir de', sev),
            h('div', {style: {display: 'flex', gap: '8px'}},
              tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                await act(() => post('/api/settings/telegram', {enabled: en.checked, bot_token: tok.value, chat_id: chat.value.trim(), min_severity: sev.value}), 'Telegram salvo');
              }, 'primary'),
              tbtn('Enviar teste', 'play', () => act(() => post('/api/settings/telegram/test'), 'Mensagem enviada'))))));
        const mt = await api('/api/maintenance').catch(() => []);
        const ml = h('div', {class: 'list'});
        const now = Date.now() / 1000;
        for (const m of mt.filter(x => x.end > now)) {
          ml.append(li(m.start <= now ? 'media' : 'baixa', m.name, `${dmhm(m.start)} → ${dmhm(m.end)}${m.targets.length ? ' · ' + m.targets.join(', ') : ' · todos'}`,
            tbtn('', 'trash', async () => { if (!needAdmin() && await act(() => del('/api/maintenance/' + m.id), 'Removida')) ctx.reopen(); }, 'danger')));
        }
        if (!ml.children.length) ml.append(h('div', {class: 'hint', text: 'Nenhuma janela de manutenção agendada.'}));
        const mn = inp({placeholder: 'Ex.: troca do roteador'}), mh = inp({type: 'number', value: 2, min: 1, max: 720});
        R.append(sec('calendar', 'Manutenção (silencia notificações)', ml, h('div', {class: 'row2', style: {marginTop: '12px'}}, field('Descrição', mn), field('Duração a partir de agora (h)', mh)),
          h('div', {style: {marginTop: '10px'}}, tbtn('Agendar agora', 'plus', async () => {
            if (needAdmin() || !mn.value.trim()) return;
            const s = Date.now() / 1000;
            if (await act(() => post('/api/maintenance', {name: mn.value.trim(), start: s, end: s + mh.value * 3600}), 'Manutenção agendada')) ctx.reopen();
          }, 'primary'))));
        R.append(h('div', {class: 'callout blue'}, h('b', {text: 'Outros canais'}), 'Discord, webhook com assinatura HMAC e e-mail ficam em Avançado (interface clássica).'));
      }

      if (tab === 'aparencia') {
        const SK = window.SKIN, st = SK.get();
        const reopen = () => ctx.reopen({tab: 'aparencia'});
        // galeria com prévia ao vivo
        const gal = h('div', {class: 'skins'});
        for (const [id, def] of Object.entries(SK.LIST)) {
          const prev = h('div', {class: 'skin-prev', 'aria-hidden': 'true'},
            h('div', {class: 'sp-side', text: '17:35'}),
            h('div', {class: 'sp-grid'}, h('div', {class: 'sp-card'}), h('div', {class: 'sp-card'}), h('div', {class: 'sp-card bad'}), h('div', {class: 'sp-card'})),
            h('div', {class: 'sp-dock'}, h('i'), h('i'), h('i'), h('i'), h('i')));
          SK.apply({skin: id, mode: id === st.skin ? st.mode : def.modes[0][0], accent: st.accent}, prev);
          gal.append(h('button', {type: 'button', class: 'skin-card' + (id === st.skin ? ' on' : ''), 'aria-pressed': id === st.skin ? 'true' : 'false',
            onclick: () => { SK.set({skin: id, mode: def.modes[0][0]}); reopen(); }},
          prev, h('b', {}, id === st.skin ? h('span', {trusted: ICO('check')}) : null, def.name), h('span', {text: def.desc})));
        }
        R.append(sec('layers', 'Tema da interface', gal));
        // modo / variante da skin atual
        const def = SK.LIST[st.skin];
        R.append(sec(st.skin === 'terminal' ? 'activity' : 'moon', st.skin === 'terminal' ? 'Cor do fósforo' : 'Modo',
          seg(def.modes, st.mode, m => { SK.set({mode: m}); reopen(); })));
        // cor de destaque (Material You)
        if (def.accent) {
          const sw_ = h('div', {class: 'swatches'});
          for (const c of SK.ACCENTS) {
            const b = h('button', {type: 'button', class: 'swatch' + (c === st.accent ? ' on' : ''), title: c, 'aria-label': 'Cor ' + c,
              onclick: () => { SK.set({accent: c}); reopen(); }});
            b.style.background = c;
            sw_.append(b);
          }
          const pick = h('input', {type: 'color', class: 'swatch', value: st.accent, title: 'Outra cor'});
          pick.addEventListener('change', () => { SK.set({accent: pick.value}); reopen(); });
          sw_.append(pick);
          R.append(sec('bolt', 'Cor de destaque', h('div', {class: 'hint', style: {marginBottom: '10px'},
            text: 'A paleta inteira (fundo, cards, botões e gráficos) é gerada a partir desta cor.'}), sw_));
        }
        // densidade (tamanho de tudo) — por aparelho
        R.append(sec('layers', 'Tamanho da interface',
          h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Vale para todos os temas, só neste aparelho. O modo TV não muda.'}),
          seg(Object.entries(SK.DENS).map(([k, v]) => [k, v[0]]), SK.density(), d => { SK.density(d); reopen(); })));
        // aparelho x padrão do servidor
        const srv = SK.serverDefault(), own = SK.isDeviceOverride();
        const srvTxt = `${SK.LIST[srv.skin].name} · ${(SK.LIST[srv.skin].modes.find(m => m[0] === srv.mode) || [, ''])[1]}`;
        R.append(sec('server', 'Padrão do servidor',
          h('div', {class: 'hint', style: {marginBottom: '10px'}, text: own
            ? `Este aparelho usa uma escolha própria. O padrão do servidor é ${srvTxt}.`
            : `Este aparelho segue o padrão do servidor (${srvTxt}). Escolher um tema acima vale só para este aparelho.`}),
          h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}},
            tbtn('Definir o tema atual como padrão', 'check', async () => {
              if (needAdmin()) return;
              const cur_ = SK.get();
              if (await act(() => post('/api/settings/ui', {skin: cur_.skin, mode: cur_.mode, accent: cur_.accent}), 'Padrão do servidor atualizado')) {
                await SK.syncServer(); reopen();
              }
            }, 'primary'),
            own ? tbtn('Seguir o padrão do servidor', 'refresh', () => { SK.followServer(); reopen(); }) : null)));
        R.append(sec('link', 'Quiosque / TV', h('div', {class: 'hint', text: 'Para fixar um tema numa tela sem mexer nas configurações, use a URL:'}),
          h('div', {class: 'out', style: {marginTop: '8px'}, text:
            `${location.origin}/?skin=terminal&modo=verde#tv\n${location.origin}/?skin=grafana&modo=dark\n${location.origin}/?skin=material&modo=light&cor=%230b57d0`}),
          h('div', {class: 'hint', style: {marginTop: '8px'}, text: 'skin: glass, terminal, grafana, material · modo: dark/light (terminal: verde, ambar, ciano) · cor: só no Material.'})));
      }

      if (tab === 'integ') {
        const [mt, agh, dv] = await Promise.all([api('/api/settings/mikrotik'), api('/api/settings/agh'), api('/api/settings/dvr').catch(() => null)]);
        integForm('mikrotik', mt, R);
        integForm('agh', agh, R);
        if (dv) dvrForm(dv, R, ctx);
      }
    },
  });
})();
