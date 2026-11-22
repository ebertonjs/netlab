// NetNOC — tela: AdGuard Home
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

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

})();
