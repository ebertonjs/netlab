// NetNOC — tela: DNS
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== DNS
  registerSheet('dns', {
    title: 'Servidores DNS', icon: 'dns',
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

})();
