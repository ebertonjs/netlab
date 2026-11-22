// NetNOC — tela: SLA
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

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

})();
