// NetNOC — tela: Destino (detalhe)
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== DESTINO (detalhe)
  registerSheet('target', {
    title: p => p.name || 'Destino', icon: 'globe',
    async render(ctx) {
      const name = ctx.params.name;
      const range = ctx.params.range || ui.lastRange;
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

})();
