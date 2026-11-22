// NetNOC — tela: MikroTik (inclui Medir agora e o log)
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

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
      medirSec(R, ctx);
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
      // v4.1: ligar/desligar portas (funciona pela rede de casa mesmo com a internet fora)
      if (NN.isAdmin()) {
        const pl = h('div', {class: 'list'});
        R.append(sec('link', 'Portas: ligar e desligar', h('div', {class: 'hint', style: {marginBottom: '8px'},
          text: 'Pela rede de casa funciona mesmo com a internet fora: é aqui que você religa o PPPoE se desligou pelo Telegram.'}), pl));
        api('/api/mikrotik/ports').then(ports => {
          if (!ctx.alive) return;
          for (const p of ports) {
            const st = p.disabled ? 'desligada' : p.running ? 'com link' : 'sem link';
            const lbl = p.name + (p.comment ? ' · ' + p.comment : '') + (p.wan ? ' · internet' : '');
            const btn = p.server ? h('span', {class: 'hint', text: 'servidor do NetNOC'}) : tbtn(p.disabled ? 'Ligar' : 'Desligar', p.disabled ? 'play' : 'pause', async () => {
              if (!p.disabled && !confirm(`Desligar ${p.name}?` + (p.wan ? ' A internet cai (e o Telegram junto) até você ligar de novo aqui.' : ''))) return;
              const r = await act(() => post('/api/mikrotik/ports', {name: p.name, enabled: p.disabled}));
              if (r) { toast(r.message.split('\n')[0]); ctx.reopen(); }
            }, p.disabled ? 'primary' : 'danger');
            pl.append(li(p.disabled ? 'baixa' : p.running ? 'ok' : 'media', lbl, st, btn));
          }
          if (!ports.length) pl.append(h('div', {class: 'hint', text: 'Nenhuma porta.'}));
        }).catch(e => pl.append(h('div', {class: 'hint', text: e.message})));
      }
      logSec(R, ctx);
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

  // v4.3: Medir agora — a taxa da WAN lida no MikroTik a cada segundo
  const mbps = b => b == null ? '--' : (b >= 1e7 ? Math.round(b / 1e6) : (b / 1e6).toFixed(1));
  function medirSec(R, ctx) {
    const secs = h('select', {class: 'inp', style: {width: 'auto'}, 'aria-label': 'Duração'},
      ...[[30, '30 s'], [45, '45 s'], [60, '1 min'], [120, '2 min']].map(([v, t]) => h('option', {value: v, text: t})));
    secs.value = '45';
    const now = h('div', {class: 'bigstat'});
    const spark = h('div', {style: {height: '70px', margin: '6px 0'}});
    const info = h('div', {class: 'hint'});
    const hist = h('div', {class: 'list'});
    const btn = tbtn('Medir agora', 'gauge', async () => {
      if (needAdmin()) return;
      const r = await act(() => post('/api/wan/medir', {seconds: +secs.value}));
      if (r) { toast('Rode um speedtest agora no celular ou no PC'); poll(); }
    }, 'primary');
    R.append(sec('speed', 'Velocidade real da internet',
      h('div', {class: 'hint', style: {marginBottom: '8px'}, text: 'Toque em "Medir agora" e rode um speedtest no celular ou no PC (fast.com, speedtest.net). O NetNOC lê a porta da internet no MikroTik a cada segundo e mostra o pico real, sem o limite da placa de rede do Pi. Também pelo Telegram: /medir.'}),
      h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}}, btn, secs), now, spark, info, hist));
    let timer = null;
    const draw = st => {
      const s = st.samples || [], last = s[s.length - 1], res = st.result, plan = st.plan_mbps;
      clear(now);
      if (st.running || last) {
        now.append(h('span', {class: 'l', text: st.running ? 'Agora' : 'Última'}),
          h('span', {class: 'v'}, mbps(last ? last[1] : null), h('small', {text: ' Mbps ↓'})),
          h('span', {class: 'l', style: {marginLeft: '14px'}, text: mbps(last ? last[2] : null) + ' Mbps ↑'}));
      }
      clear(spark);
      if (s.length > 1) { const sv = sparkArea(s.map(x => x[1]), 600, 70, C('--spark')); sv.style.width = '100%'; sv.style.height = '100%'; spark.append(sv); }
      const left = st.running ? Math.max(0, Math.round(st.started + st.seconds - st.now)) : 0;
      info.textContent = st.running ? `Medindo ${st.iface}… faltam ${left} s` + (st.method === 'contadores' ? ' (pelos contadores)' : '')
        : st.error ? 'Parou: ' + st.error
        : res ? `Pico: ↓ ${mbps(res.rx_peak)} · ↑ ${mbps(res.tx_peak)} Mbps (3 melhores segundos: ↓ ${mbps(res.rx_top3)} · ↑ ${mbps(res.tx_top3)})` +
          (plan ? ` · ${Math.round(res.rx_top3 / 1e6 / plan * 100)}% do plano de ${plan} Mbps` : '') : '';
      clear(hist);
      for (const m of (st.history || []).slice(0, 5)) {
        const d = new Date(m.ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
        const pct = plan ? Math.round(m.rx_top3 / 1e6 / plan * 100) : null;
        hist.append(li(pct == null ? 'ok' : pct >= 80 ? 'ok' : pct >= 50 ? 'media' : 'alta', `↓ ${mbps(m.rx_top3)} · ↑ ${mbps(m.tx_top3)} Mbps`,
          d + (pct != null ? ` · ${pct}% do plano` : '') + (m.who === 'telegram' ? ' · Telegram' : '')));
      }
    };
    const poll = async () => {
      clearTimeout(timer);
      if (!ctx.alive) return;
      const st = await api('/api/wan/medir').catch(() => null);
      if (!st || !ctx.alive) return;
      btn.disabled = !!st.running;
      draw(st);
      if (st.running) timer = setTimeout(poll, 1000);
    };
    poll();
  }

  // v4.3: log do MikroTik (syslog)
  function logSec(R, ctx) {
    const q = inp({placeholder: 'procurar (ex.: PPOE, admin, link down)', style: {maxWidth: '320px'}});
    const topic = h('select', {class: 'inp', style: {width: 'auto'}, 'aria-label': 'Tópico'},
      ...[['', 'Tudo'], ['pppoe', 'PPPoE'], ['interface', 'Portas'], ['account', 'Logins'], ['system', 'Sistema'], ['error', 'Erros'], ['warning', 'Avisos']]
        .map(([v, t]) => h('option', {value: v, text: t})));
    const box = h('div', {class: 'list'});
    const load = async () => {
      const r = await api('/api/mikrotik/log?minutes=10080&limit=150' + (topic.value ? '&topic=' + topic.value : '') + (q.value.trim() ? '&q=' + encodeURIComponent(q.value.trim()) : '')).catch(e => ({err: e.message}));
      if (!ctx.alive) return;
      clear(box);
      if (r.err) return box.append(h('div', {class: 'hint', text: r.err}));
      if (!r.status.enabled) {
        return box.append(h('div', {class: 'hint', text: 'Desligado. Ligue em Configurações → Integrações → Syslog do MikroTik para ver aqui o motivo de cada queda do PPPoE, logins e erros do roteador.'}));
      }
      if (!r.rows.length) return box.append(h('div', {class: 'hint', text: r.status.received ? 'Nada com esse filtro na última semana.' : 'Nenhuma mensagem recebida ainda. Confira os comandos em Configurações → Integrações.'}));
      for (const x of r.rows) {
        const sevc = /crit|emerg|alert|error/.test(x.sev) ? 'alta' : x.sev === 'warning' ? 'media' : 'ok';
        box.append(li(sevc, x.msg, new Date(x.ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'}) + ' · ' + x.topics));
      }
    };
    let tq = null;
    q.addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(load, 400); });
    topic.addEventListener('change', load);
    R.append(sec('file', 'Log do MikroTik', h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px'}}, topic, q), box));
    load();
  }

})();
