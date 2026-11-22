// NetNOC — tela: Ferramentas
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== FERRAMENTAS
  registerSheet('tools', {
    title: 'Ferramentas', icon: 'wrench', single: true,
    async render(ctx) {
      const R = h('div', {class: 'panel main'}); ctx.body.append(R);
      if (!NN.isAdmin()) R.append(h('div', {class: 'callout blue', text: 'As ferramentas exigem perfil administrador.'}));
      const tiles = h('div', {class: 'tiles', style: {gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))'}});
      R.append(tiles);

      // velocidade real: pico da porta WAN do MikroTik (v4.0, no lugar do speedtest)
      const wOut = h('div', {class: 'list'});
      api('/api/wan/peak').then(W => {
        clear(wOut);
        const rows = [['Hoje', W.today], ['7 dias', W.d7], ['30 dias', W.d30]].filter(r => r[1]);
        if (!rows.length) { wOut.append(h('div', {class: 'hint', text: 'Sem dados do MikroTik: ative a integração em Configurações → Integrações.'})); return; }
        for (const [l, r] of rows) wOut.append(li('ok', `↓ ${bps(r.rx_bps)}  ↑ ${bps(r.tx_bps)}`, `${l} · porta ${r.iface}`, dmhm(r.rx_ts)));
      }).catch(() => wOut.append(h('div', {class: 'hint', text: 'Sem dados do MikroTik.'})));
      tiles.append(h('div', {class: 'tile'}, h('h4', {}, h('span', {trusted: ICO('gauge')}), 'Velocidade real da internet'),
        h('div', {class: 'tsub', style: {marginBottom: '10px'}, text: 'Maior download/upload que passou pela porta WAN do MikroTik. Mede o link de verdade, sem gastar banda (um teste feito no Raspberry Pi 3 para em ~100 Mbps).'}), wOut));

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

})();
