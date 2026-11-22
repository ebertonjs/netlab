// NetNOC — tela: Latência
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

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
      const range = ctx.params.range || ui.lastRange;
      ui.lastRange = range;
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

})();
