// Modo TV / Wallboard v2: faixa de alerta, KPIs, cards com sparkline + 24 h, lateral com
// incidentes e equipamento (foto com portas ao vivo). Telas extras giram em rodízio.
(function () {
  const PORT_POS = [36.3, 47.6, 59, 70.4, 81.7];       // % da esquerda de cada porta na foto do hAP ax²
  let root = null, timer = null, clock = null, idx = 0, panels = [], rotateMs = 15000;
  let D = {};                                         // dados auxiliares (atualizados em segundo plano)
  let seen = null, prevPorts = null, alertTimer = null, sound = false, wakeLock = null, hideCur = null;
  const last = {};                                     // controle de intervalo por fonte

  function every(key, ms, fn) {
    if (Date.now() - (last[key] || 0) < ms) return Promise.resolve();
    last[key] = Date.now();
    return Promise.resolve().then(fn).catch(function () { /* fonte indisponível: segue sem */ });
  }
  function refreshData() {
    return Promise.all([
      every('spark', 8000, async function () { D.spark = await apiJSON('GET', '/api/sparklines'); }),
      every('bars', 60000, async function () { D.bars = await apiJSON('GET', '/api/uptime/bars?hours=24'); }),
      every('targets', 15000, async function () { D.targetsInfo = await apiJSON('GET', '/api/targets'); }),
      every('resolved', 30000, async function () {
        const all = await apiJSON('GET', '/api/incidents?days=1');
        D.resolved = (all || []).filter(function (i) { return i.resolved_ts; }).slice(0, 6);
      }),
      every('certs', 60000, async function () { D.certs = await apiJSON('GET', '/api/certs'); }),
      every('mk', 8000, async function () {
        const st = await apiJSON('GET', '/api/mikrotik/status');
        D.mk = st && st.enabled && st.board_name ? st : null;
        if (D.mk) {
          D.ifaces = await apiJSON('GET', '/api/mikrotik/interfaces');
          if (!D.histLoaded) {
            D.histLoaded = true;
            try {
              const hh = await apiJSON('GET', '/api/mikrotik/history?range=1h&iface=' + encodeURIComponent(wanName()));
              D.hist = (hh.points || []).slice(-120).map(function (p) { return [p.rx_bps || 0, p.tx_bps || 0]; });
            } catch (e) { /* sem histórico: o gráfico se forma ao vivo */ }
          } else pushTraffic();
          checkPorts();
        }
      })
    ]);
  }

  // ------------------------------------------------------------------ utilidades
  function wanName() { return (typeof MK_PORT_ORDER !== 'undefined' && MK_PORT_ORDER[0]) || 'ether1'; }
  function portRows() {
    const by = {}; (D.ifaces || []).forEach(function (r) { by[r.name] = r; });
    const order = (typeof MK_PORT_ORDER !== 'undefined') ? MK_PORT_ORDER : ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'];
    return order.map(function (n) { return by[n] || null; });
  }
  function bps(v) {
    if (v == null) return '–';
    return typeof fmtBps === 'function' ? fmtBps(v) : (v / 1e6).toFixed(1) + ' Mbps';
  }
  function pushTraffic() {
    const w = (D.ifaces || []).find(function (r) { return r.name === wanName(); });
    if (!w) return;
    D.hist = D.hist || [];
    D.hist.push([w.rx_bps || 0, w.tx_bps || 0]);
    if (D.hist.length > 120) D.hist.shift();
  }
  function lineSvg(series, colors, w, hgt) {
    const svg = svgEl('svg', {viewBox: '0 0 ' + w + ' ' + hgt, preserveAspectRatio: 'none', class: 'wall-line', 'aria-hidden': 'true'});
    let mx = 0;
    series.forEach(function (s) { s.forEach(function (v) { if (typeof v === 'number' && isFinite(v) && v > mx) mx = v; }); });
    if (!mx) mx = 1;
    series.forEach(function (s, k) {
      if (s.length < 2) return;
      const step = w / (s.length - 1);
      const pts = s.map(function (v, i) {
        const y = hgt - 3 - ((typeof v === 'number' && isFinite(v) ? v : 0) / mx) * (hgt - 6);
        return (i * step).toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      svg.appendChild(svgEl('polyline', {points: pts, fill: 'none', stroke: colors[k], 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke'}));
    });
    return svg;
  }

  // -------------------------------------------------------------------- alertas
  function banner(text) {
    if (!root) return;
    const b = root.querySelector('.wall-alert');
    b.textContent = text; b.classList.add('on');
    clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { if (root) root.querySelector('.wall-alert').classList.remove('on'); }, 10000);
    beep();
  }
  function beep() {
    if (!sound) return;
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      const c = new A(), o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.15;
      o.connect(g); g.connect(c.destination); o.start(); setTimeout(function () { o.stop(); c.close(); }, 450);
    } catch (e) { /* sem áudio */ }
  }
  function checkIncidents(list) {
    const ids = new Set((list || []).map(function (i) { return i.id; }));
    if (seen) {
      (list || []).forEach(function (i) {
        if (!seen.has(i.id) && i.severity !== 'Info') banner('▼ NOVO INCIDENTE — ' + (i.target ? i.target + ': ' : '') + i.message);
      });
    }
    seen = ids;
  }
  function checkPorts() {
    const rows = portRows(), now = rows.map(function (r) { return r ? !!r.running : null; });
    if (prevPorts) now.forEach(function (st, i) {
      if (prevPorts[i] === true && st === false) banner('▼ PORTA ' + (rows[i] ? rows[i].name : 'ether' + (i + 1)) + ' SEM LINK');
    });
    prevPorts = now;
  }

  // ---------------------------------------------------------------------- blocos
  function snap() { return window.__lastSnapshot || {}; }

  function kpi(label, value, cls, extra) {
    return h('div', {class: 'wall-kpi'}, h('small', {text: label}),
      h('b', {class: cls || '', text: value}), extra ? h('span', {class: 'wall-kpi-x', text: extra}) : null);
  }
  function kpis() {
    const s = snap(), o = s.overview || {}, ts = o.targets || {}, names = Object.keys(ts);
    const on = names.filter(function (n) { return ts[n].online === true; }).length;
    const inc = (s.incidents || []).filter(function (i) { return i.severity !== 'Info'; });
    const hi = inc.filter(function (i) { return i.severity === 'Alta'; }).length;
    const sla = (D.targetsInfo || []).map(function (t) { return t.uptime_24h; }).filter(function (v) { return typeof v === 'number'; });
    const slaV = sla.length ? (sla.reduce(function (a, b) { return a + b; }, 0) / sla.length) : null;
    const loss = o.avg_loss_pct;
    return h('div', {class: 'wall-kpis'},
      kpi('Alvos online', on + ' / ' + names.length, names.length && on < names.length ? 'bad' : 'ok'),
      kpi('Incidentes ativos', String(inc.length), hi ? 'bad' : inc.length ? 'warn' : 'ok', inc.length ? hi + ' alta · ' + (inc.length - hi) + ' outras' : 'nenhum'),
      kpi('Latência média', o.avg_latency != null ? o.avg_latency.toFixed(0) + ' ms' : '–'),
      kpi('Perda média', loss != null ? loss.toFixed(1) + '%' : '–', loss > 5 ? 'bad' : loss > 1 ? 'warn' : 'ok'),
      kpi('SLA 24 h', slaV != null ? slaV.toFixed(2) + '%' : '–', slaV != null && slaV < 99 ? 'warn' : ''));
  }

  function targetState(n, t, incs) {
    if (t && t.online === false) return 'bad';
    if (!t || t.online == null) return 'na';
    if (t.loss_pct >= 5 || incs.some(function (i) { return i.target === n; })) return 'warn';
    return 'ok';
  }
  function barsRow(n) {
    const b = (D.bars && D.bars[n]) || [];
    return h('div', {class: 'wall-24'}, b.map(function (x) {
      return h('i', {class: 'wall-24c ' + (x.pct == null ? 'nodata' : x.pct >= 98 ? 'ok' : x.pct >= 90 ? 'warn' : 'bad'),
        title: fmtDateTime(x.ts) + ' — ' + (x.pct == null ? 'sem dados' : x.pct + '%')});
    }));
  }
  function statusTile(n, t, state, incs) {
    const on = state === 'ok' || state === 'warn';
    const mine = incs.filter(function (i) { return i.target === n; }).sort(function (a, b) { return a.started_ts - b.started_ts; })[0];
    const sub = state === 'bad' ? (mine ? 'offline há ' + fmtDur(Date.now() / 1000 - mine.started_ts) : 'offline')
      : state === 'warn' ? 'degradado' : state === 'ok' ? 'estável' : 'sem dados';
    const sp = (D.spark && D.spark[n]) || [];
    const col = state === 'bad' ? '#ff6369' : state === 'warn' ? '#f5a524' : '#3ecf8e';
    return h('div', {class: 'wall-tile ' + (state === 'bad' ? 'bad' : state === 'warn' ? 'warn' : state === 'ok' ? 'ok' : 'na')},
      h('div', {class: 'wall-tile-head'},
        h('span', {class: 'wall-glyph', 'aria-hidden': 'true', text: on ? '▲' : state === 'bad' ? '▼' : '●'}),
        h('span', {class: 'wall-name', text: n}), h('span', {class: 'wall-since', text: sub})),
      h('div', {class: 'wall-big', text: on ? (t.latency != null ? t.latency.toFixed(0) + ' ms' : 'OK') : state === 'bad' ? 'OFFLINE' : '–'}),
      h('div', {class: 'wall-sub', text: t ? 'perda ' + (t.loss_pct || 0).toFixed(0) + '% · jitter ' + (t.avg_jitter || 0).toFixed(0) + ' ms' : 'sem dados'}),
      sp.length > 1 ? (function () { const d = h('div', {class: 'wall-spark'}); d.appendChild(lineSvg([sp.map(function (v) { return v == null ? 0 : v; })], [col], 300, 46)); return d; })() : h('div', {class: 'wall-spark'}),
      barsRow(n));
  }
  const RANK = {bad: 0, warn: 1, ok: 2, na: 3};
  function cards() {
    const s = snap(), ts = (s.overview && s.overview.targets) || {}, incs = s.incidents || [];
    const names = Object.keys(ts);
    if (!names.length) return emptyState('Sem destinos.');
    const st = {}; names.forEach(function (n) { st[n] = targetState(n, ts[n], incs); });
    names.sort(function (a, b) { return RANK[st[a]] - RANK[st[b]] || a.localeCompare(b); });
    const nBad = names.filter(function (n) { return st[n] === 'bad'; }).length;
    return h('div', {class: 'wall-cards' + (nBad === 1 ? ' one-bad' : '')}, names.map(function (n) { return statusTile(n, ts[n], st[n], incs); }));
  }

  function incPanel() {
    const inc = (snap().incidents || []).filter(function (i) { return i.severity !== 'Info'; });
    const list = inc.length ? inc.slice(0, 3).map(function (i) {
      return h('div', {class: 'wall-inc sev-' + i.severity},
        h('span', {class: 'wall-dot-sev', 'aria-hidden': 'true'}),
        h('div', {}, h('b', {text: (i.target ? i.target + ' — ' : '') + i.message}),
          h('span', {class: 'wall-meta', text: i.severity + ' · há ' + fmtDur(Date.now() / 1000 - i.started_ts)})));
    }) : [h('div', {class: 'wall-meta ok', text: '✔ Tudo operacional'})];
    return h('section', {class: 'wall-panel'}, h('h4', {text: 'Incidentes ativos'}), list,
      inc.length > 3 ? h('div', {class: 'wall-meta', text: '+ ' + (inc.length - 3) + ' outros'}) : null);
  }
  function hhmm(ts) { return new Date(ts * 1000).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); }
  function resolvedPanel() {
    const r = (D.resolved || []).slice(0, 2);
    if (!r.length) return null;
    return h('section', {class: 'wall-panel'}, h('h4', {text: 'Resolvidos hoje'}), r.map(function (i) {
      return h('div', {class: 'wall-inc sev-ok'}, h('span', {class: 'wall-dot-sev', 'aria-hidden': 'true'}),
        h('div', {}, h('b', {text: (i.target ? i.target + ' — ' : '') + i.message}),
          h('span', {class: 'wall-meta', text: hhmm(i.started_ts) + ' → ' + hhmm(i.resolved_ts) + ' · ' + fmtDur(i.resolved_ts - i.started_ts)})));
    }));
  }
  function certLine() {
    const c = D.certs || {}, ks = Object.keys(c).filter(function (k) { return typeof c[k] === 'number'; });
    if (!ks.length) return null;
    ks.sort(function (a, b) { return c[a] - c[b]; });
    const k = ks[0], d = Math.floor(c[k]);
    return h('div', {class: 'wall-cert'}, 'Próx. certificado: ',
      h('b', {class: d < 15 ? 'bad' : d < 30 ? 'warn' : '', text: k + ' · ' + (d < 0 ? 'VENCIDO' : d + ' dias')}));
  }

  function portPhoto(big) {
    const img = document.querySelector('.mk-panel-img');
    if (!img || !img.src) return null;
    const rows = portRows();
    const wrap = h('div', {class: 'wall-photo' + (big ? ' big' : '')}, h('img', {src: img.src, alt: 'hAP ax²'}));
    PORT_POS.forEach(function (left, i) {
      const r = rows[i];
      wrap.appendChild(h('i', {class: 'wall-port ' + (r ? (r.running ? 'online' : 'offline') : ''), style: {left: left + '%'}}));
    });
    return wrap;
  }
  function trafficBlock(big) {
    const w = (D.ifaces || []).find(function (r) { return r.name === wanName(); });
    const hist = D.hist || [];
    const box = h('div', {class: 'wall-traffic'},
      h('div', {class: 'wall-rxtx'}, h('span', {}, '↓ ', h('b', {class: 'ok', text: bps(w && w.rx_bps)})),
        h('span', {}, '↑ ', h('b', {class: 'tx', text: bps(w && w.tx_bps)}))));
    if (hist.length > 1) box.appendChild(lineSvg([hist.map(function (p) { return p[0]; }), hist.map(function (p) { return p[1]; })], ['#3ecf8e', '#4f8cff'], 300, big ? 120 : 50));
    else box.appendChild(h('div', {class: 'wall-meta', text: 'coletando tráfego…'}));
    return box;
  }
  function equipPanel() {
    const m = D.mk;
    if (!m) return null;
    const up = m.uptime_s != null ? fmtDur(m.uptime_s) : '–';
    return h('section', {class: 'wall-panel wall-equip'},
      h('h4', {}, 'MikroTik ' + (m.board_name || ''), h('span', {class: 'wall-live ' + (m.stale ? 'bad' : 'ok'), text: ' ●'}),
        h('span', {class: 'wall-h4r', text: 'RouterOS ' + (m.version || '').split(' ')[0] + ' · up ' + up})),
      portPhoto(false), trafficBlock(false),
      h('div', {class: 'wall-res'},
        h('div', {}, 'CPU', h('b', {text: (m.cpu_load != null ? m.cpu_load : '–') + '%'})),
        h('div', {}, 'Memória', h('b', {text: (m.mem_pct != null ? Math.round(m.mem_pct) : '–') + '%'})),
        h('div', {}, 'Temp.', h('b', {class: m.temperature >= 70 ? 'bad' : m.temperature >= 60 ? 'warn' : '', text: m.temperature != null ? m.temperature + '°C' : '–'}))),
      certLine());
  }

  // ----------------------------------------------------------------------- telas
  const P = {
    main() {
      const side = h('div', {class: 'wall-side'}, incPanel(), resolvedPanel(), equipPanel() || (certLine() ? h('section', {class: 'wall-panel'}, certLine()) : null));
      return h('div', {class: 'wall-main'}, cards(), side);
    },
    equip() {
      const m = D.mk;
      if (!m) return emptyState('MikroTik desativado ou sem dados.');
      const rows = (D.ifaces || []).filter(function (r) { return r.running; })
        .sort(function (a, b) { return ((b.rx_bps || 0) + (b.tx_bps || 0)) - ((a.rx_bps || 0) + (a.tx_bps || 0)); }).slice(0, 6);
      return h('div', {class: 'wall-equip-full'},
        h('div', {class: 'wall-equip-left'}, portPhoto(true), trafficBlock(true)),
        h('div', {class: 'wall-equip-right'},
          h('div', {class: 'wall-res big'},
            h('div', {}, 'CPU', h('b', {text: (m.cpu_load != null ? m.cpu_load : '–') + '%'})),
            h('div', {}, 'Memória', h('b', {text: (m.mem_pct != null ? Math.round(m.mem_pct) : '–') + '%'})),
            h('div', {}, 'Temp.', h('b', {text: m.temperature != null ? m.temperature + '°C' : '–'})),
            h('div', {}, 'Uptime', h('b', {text: m.uptime_s != null ? fmtDur(m.uptime_s) : '–'}))),
          h('section', {class: 'wall-panel'}, h('h4', {text: 'Maiores interfaces'}),
            rows.map(function (r) {
              return h('div', {class: 'wall-if'}, h('span', {text: r.name}), h('span', {text: '↓ ' + bps(r.rx_bps)}), h('span', {text: '↑ ' + bps(r.tx_bps)}));
            }))));
    },
    bars() {
      const box = h('div', {class: 'wall-bars'}, skeleton(3));
      apiJSON('GET', '/api/uptime/bars?hours=24').then(function (d) {
        box.replaceChildren.apply(box, Object.keys(d).map(function (n) {
          return h('div', {class: 'wall-bar-row'}, h('span', {class: 'wall-bar-name', text: n}),
            h('div', {class: 'avail-bars'}, d[n].map(function (b) {
              return h('div', {class: 'avail-bar ' + (b.pct == null ? 'nodata' : b.pct >= 98 ? 'ok' : b.pct >= 90 ? 'warn' : 'bad'),
                title: fmtDateTime(b.ts) + ' — ' + (b.pct == null ? 'sem dados' : b.pct + '%')});
            })));
        }));
      }).catch(function () { box.replaceChildren(emptyState('Erro ao carregar.')); });
      return box;
    },
    zabbix() {
      const box = h('div', {class: 'wall-list'});
      apiJSON('GET', '/api/zabbix/problems').then(function (d) {
        if (!d.enabled || !d.problems.length) { box.replaceChildren(h('div', {class: 'wall-allok'}, h('div', {class: 'wall-big', text: d.enabled ? '✔ Zabbix sem problemas' : 'Zabbix desativado'}))); return; }
        box.replaceChildren.apply(box, d.problems.slice(0, 10).map(function (p) {
          return h('div', {class: 'wall-inc-row sev-' + (p.severity >= 4 ? 'Alta' : 'Media')},
            h('span', {class: 'wall-sev', text: '⚠ ' + p.severity_name}), h('span', {class: 'wall-inc-msg', text: p.host + ' — ' + p.name}),
            h('span', {class: 'wall-inc-t', text: fmtDur(Date.now() / 1000 - p.since)}));
        }));
      }).catch(function () { box.replaceChildren(emptyState('Erro ao consultar o Zabbix.')); });
      return box;
    }
  };
  const TITLES = {main: 'Painel', equip: 'Equipamento', bars: 'Disponibilidade 24 h', zabbix: 'Zabbix'};

  function render() {
    if (!root) return;
    const key = panels[idx % panels.length];
    const s = snap();
    checkIncidents(s.incidents);
    root.querySelector('.wall-body').replaceChildren(P[key]());
    root.querySelector('.wall-kpibox').replaceChildren(kpis());
    root.querySelector('.wall-title').textContent = TITLES[key];
    const dots = root.querySelectorAll('.wall-dot'), cur = idx % panels.length;
    dots.forEach(function (d, i) { d.classList.toggle('on', i === cur); });
    const o = s.overview, st = root.querySelector('.wall-status');
    const ok = o && o.internet_online && !(s.incidents || []).some(function (i) { return i.severity === 'Alta'; });
    st.className = 'wall-status ' + (ok ? 'ok' : 'bad');
    st.textContent = ok ? '▲ OPERACIONAL' : '▼ ATENÇÃO';
    root.classList.toggle('alerting', !ok);
    const live = root.querySelector('.wall-live-chip');
    const age = s.ts ? Date.now() / 1000 - s.ts : null;
    const fresh = age != null && age < 30;
    live.className = 'wall-live-chip ' + (fresh ? 'ok' : 'bad'); live.textContent = fresh ? '● ao vivo' : '● dados atrasados';
  }

  function buildPanels() { panels = ['main']; if (D.mk) panels.push('equip', 'main'); panels.push('bars'); }

  function open() {
    if (root) return;
    panels = ['main', 'bars'];
    root = h('div', {id: 'wall', class: 'wall', role: 'dialog', 'aria-label': 'Modo TV'},
      h('div', {class: 'wall-alert', role: 'alert'}),
      h('div', {class: 'wall-top'}, h('span', {class: 'wall-status'}), h('span', {class: 'wall-title'}),
        h('span', {class: 'wall-clockbox'}, h('span', {class: 'wall-clock'}), h('small', {class: 'wall-live-chip'})),
        h('button', {type: 'button', class: 'wall-x', 'aria-label': 'Sair do modo TV', text: '✕', onclick: close})),
      h('div', {class: 'wall-kpibox'}),
      h('div', {class: 'wall-body'}),
      h('div', {class: 'wall-foot'}, h('span', {class: 'wall-dots'}),
        h('button', {type: 'button', class: 'wall-snd', title: 'Som de alerta', text: '🔇', onclick: function (e) { sound = !sound; e.target.textContent = sound ? '🔔' : '🔇'; if (sound) beep(); }}),
        h('label', {class: 'wall-rot'}, 'Girar a cada ', h('select', {onchange: function (e) { rotateMs = Number(e.target.value) * 1000; restart(); }},
          [[10, '10 s'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [0, 'parado']].map(function (o) { return h('option', {value: o[0], text: o[1], selected: o[0] * 1000 === rotateMs}); })))));
    document.body.append(root); document.body.classList.add('tv-on');
    document.addEventListener('keydown', onKey);
    document.addEventListener('netnoc:snapshot', onSnap);
    root.addEventListener('mousemove', wake);
    wake();
    try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch (e) { /* ok */ }
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () { /* ok */ }); } catch (e) { /* ok */ }
    seen = null; prevPorts = null; D.histLoaded = false; Object.keys(last).forEach(function (k) { last[k] = 0; });
    tick(); clock = setInterval(tick, 1000);
    refreshData().then(function () {
      if (!root) return;
      buildPanels();
      apiJSON('GET', '/api/zabbix/problems').then(function (d) { if (d.enabled && root && panels.indexOf('zabbix') < 0) { panels.push('zabbix'); drawDots(); } }).catch(function () { /* ok */ });
      drawDots(); restart();
    });
    drawDots(); restart();
  }
  function drawDots() {
    if (!root) return;
    root.querySelector('.wall-dots').replaceChildren.apply(root.querySelector('.wall-dots'), panels.map(function () { return h('i', {class: 'wall-dot'}); }));
    render();
  }
  function wake() {
    if (!root) return;
    root.classList.remove('nocursor'); clearTimeout(hideCur);
    hideCur = setTimeout(function () { if (root) root.classList.add('nocursor'); }, 5000);
  }
  function tick() { if (root) root.querySelector('.wall-clock').textContent = new Date().toLocaleTimeString('pt-BR'); }
  function restart() {
    clearInterval(timer);
    if (rotateMs > 0) timer = setInterval(function () { idx++; refreshData().then(render); render(); }, rotateMs);
    render();
  }
  let snapAt = 0;
  function onSnap() {
    if (!root) return;
    refreshData().then(function () { /* dados novos entram no próximo render */ });
    const k = panels[idx % panels.length];
    if (k === 'bars' || k === 'zabbix') { checkIncidents(snap().incidents); return; }
    if (Date.now() - snapAt < 1500) return; snapAt = Date.now();
    render();
  }
  function onKey(e) { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') { idx++; render(); } else if (e.key === 'ArrowLeft') { idx = Math.max(0, idx - 1); render(); } }
  function close() {
    if (!root) return; root.remove(); root = null; clearInterval(timer); clearInterval(clock); clearTimeout(alertTimer); clearTimeout(hideCur);
    document.body.classList.remove('tv-on'); document.removeEventListener('keydown', onKey); document.removeEventListener('netnoc:snapshot', onSnap);
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) { /* ok */ }
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) { /* ok */ }
  }
  window.NetnocWall = {toggle: function () { return root ? close() : open(); }, open: open, close: close};
  if (location.hash === '#tv') window.addEventListener('load', function () { setTimeout(open, 800); });
})();
