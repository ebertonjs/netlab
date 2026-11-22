// NetNOC — tela: Incidentes
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== INCIDENTES
  const TYPE_PT = {offline: 'Offline', latency: 'Latência', jitter: 'Jitter', loss: 'Perda', dns: 'DNS', cpu: 'CPU', temp: 'Temperatura',
    cert: 'Certificado', local: 'Queda local', camera: 'Câmera', dvr_hd: 'Disco do DVR'};
  registerSheet('incidents', {
    title: 'Incidentes e eventos', icon: 'alert',
    async render(ctx) {
      const days = ctx.params.days || 7;
      ctx.tools.append(seg([[1, '24 h'], [7, '7 dias'], [30, '30 dias']], days, d => ctx.reopen({days: d})));
      const [L, R] = panels(ctx);
      const [sum, pats, list, evs] = await Promise.all([
        api('/api/incidents/summary?days=' + days), api('/api/insights/patterns?days=30').catch(() => []),
        api('/api/incidents?days=' + days), api('/api/events?limit=80')]);
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

})();
