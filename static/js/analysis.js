// Página "Análise": linha do tempo de incidentes (Gantt com zoom), mapa de calor, Zabbix, sites, certificados.
(function () {
  const SEV_COLOR = {Alta: 'var(--red)', Media: 'var(--orange)', Baixa: 'var(--blue)', Info: 'var(--purple)'};
  const state = {days: 7, view: null, targetsLoaded: false};
  let page, tlBox, hmBox, zbBox, stBox, ctBox, timer = null;

  function build() {
    page = addPage('analise', 'Análise', '📊', 'Análise', 'Linha do tempo, padrões por hora, Zabbix, sites e certificados', onShow);
    // --- timeline
    const range = h('select', {id: 'tlRange', 'aria-label': 'Período', onchange: e => { state.days = parseFloat(e.target.value); state.view = null; loadTimeline(); }},
      h('option', {value: '1', text: '24 h'}), h('option', {value: '7', text: '7 dias', selected: true}), h('option', {value: '30', text: '30 dias'}));
    const types = h('select', {id: 'tlType', 'aria-label': 'Tipo', onchange: loadTimeline},
      h('option', {value: 'offline', text: 'Só quedas'}), h('option', {value: 'all', text: 'Todos os tipos'}));
    const reset = h('button', {type: 'button', class: 'mini-btn', text: '↺ Zoom', title: 'Voltar ao período completo',
      onclick: () => { state.view = null; loadTimeline(); }});
    tlBox = h('div', {class: 'tl-box'}, skeleton(4));
    page.append(card('Linha do tempo de incidentes', h('div', {},
      h('div', {class: 'x-controls'}, range, types, reset, h('span', {class: 'hint', text: 'Arraste sobre o gráfico para ampliar.'})), tlBox)));
    // --- heatmap
    const tsel = h('select', {id: 'hmTarget', 'aria-label': 'Alvo', onchange: loadHeatmap});
    const dsel = h('select', {id: 'hmDays', 'aria-label': 'Dias', onchange: loadHeatmap},
      h('option', {value: '7', text: '7 dias'}), h('option', {value: '14', text: '14 dias', selected: true}), h('option', {value: '30', text: '30 dias'}));
    const msel = h('select', {id: 'hmMetric', 'aria-label': 'Métrica', onchange: loadHeatmap},
      h('option', {value: 'lat', text: 'Latência'}), h('option', {value: 'loss', text: 'Perda'}));
    hmBox = h('div', {class: 'hm-box'}, skeleton(4));
    page.append(card('Mapa de calor (hora × dia)', h('div', {}, h('div', {class: 'x-controls'}, tsel, dsel, msel), hmBox)));
    // --- zabbix / sites / certs
    zbBox = h('div', {}, skeleton(3)); stBox = h('div', {}, skeleton(3)); ctBox = h('div', {}, skeleton(2));
    const grid = h('div', {class: 'x-grid'},
      card('Zabbix — problemas ativos', zbBox), card('Multi-site — visão central × sites', stBox), card('Certificados HTTPS', ctBox));
    page.append(grid);
  }

  // ------------------------------------------------------------ timeline
  async function loadTimeline() {
    const days = state.days;
    let rows;
    try { rows = await apiJSON('GET', '/api/incidents?days=' + days); } catch (e) { tlBox.replaceChildren(emptyState('Erro: ' + e.message)); return; }
    if (document.getElementById('tlType').value === 'offline') rows = rows.filter(r => r.type === 'offline');
    const now = Date.now() / 1000;
    const t0full = now - days * 86400;
    const view = state.view || [t0full, now];
    const targets = Array.from(new Set(rows.map(r => r.target))).sort();
    tlBox.replaceChildren();
    if (!targets.length) { tlBox.append(emptyState('Nenhum incidente no período. 🎉')); return; }
    const W = Math.max(600, tlBox.clientWidth || 900), rowH = 26, left = 130, top = 24;
    const H = top + targets.length * rowH + 8;
    const svg = svgEl('svg', {width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'tl-svg', role: 'img', 'aria-label': 'Linha do tempo de incidentes'});
    const x = t => left + ((t - view[0]) / (view[1] - view[0])) * (W - left - 10);
    // grade/ticks
    const nt = 6;
    for (let i = 0; i <= nt; i++) {
      const t = view[0] + (view[1] - view[0]) * i / nt, px = x(t);
      svg.append(svgEl('line', {x1: px, x2: px, y1: top - 6, y2: H - 4, class: 'tl-grid'}));
      const tx = svgEl('text', {x: px, y: 12, class: 'tl-tick', 'text-anchor': i === 0 ? 'start' : i === nt ? 'end' : 'middle'});
      tx.textContent = (view[1] - view[0]) > 2 * 86400 ? new Date(t * 1000).toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'})
        : new Date(t * 1000).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
      svg.append(tx);
    }
    targets.forEach((tg, i) => {
      const y = top + i * rowH;
      const lb = svgEl('text', {x: 4, y: y + 16, class: 'tl-label'}); lb.textContent = tg.length > 18 ? tg.slice(0, 17) + '…' : tg;
      const lt = svgEl('title'); lt.textContent = tg; lb.append(lt);
      svg.append(lb, svgEl('line', {x1: left, x2: W - 10, y1: y + rowH - 2, y2: y + rowH - 2, class: 'tl-grid'}));
    });
    rows.forEach(r => {
      const i = targets.indexOf(r.target), end = r.resolved_ts || now;
      if (end < view[0] || r.started_ts > view[1]) return;
      const xs = Math.max(left, x(Math.max(r.started_ts, view[0]))), xe = Math.min(W - 10, x(Math.min(end, view[1])));
      const bar = svgEl('rect', {x: xs, y: top + i * rowH + 4, width: Math.max(3, xe - xs), height: rowH - 10, rx: 3,
        fill: SEV_COLOR[r.severity] || 'var(--muted)', class: 'tl-bar' + (r.resolved_ts ? '' : ' open')});
      const tt = svgEl('title');
      tt.textContent = r.target + ' — ' + r.type + ' (' + r.severity + ')\n' + r.message + '\n' + fmtDateTime(r.started_ts) + ' → ' +
        (r.resolved_ts ? fmtDateTime(r.resolved_ts) + ' (' + fmtDur(r.resolved_ts - r.started_ts) + ')' : 'em andamento');
      bar.append(tt); svg.append(bar);
    });
    // seleção por arraste
    const sel = svgEl('rect', {y: top - 6, height: H - top, class: 'tl-sel', visibility: 'hidden'});
    svg.append(sel);
    let dragX = null;
    const px = ev => { const b = svg.getBoundingClientRect(); return (ev.clientX - b.left) * (W / b.width); };
    svg.addEventListener('mousedown', ev => { dragX = px(ev); sel.setAttribute('visibility', 'visible'); sel.setAttribute('x', dragX); sel.setAttribute('width', 0); });
    svg.addEventListener('mousemove', ev => {
      if (dragX === null) return; const c = px(ev);
      sel.setAttribute('x', Math.min(dragX, c)); sel.setAttribute('width', Math.abs(c - dragX));
    });
    const end = ev => {
      if (dragX === null) return; const c = px(ev); const a = Math.min(dragX, c), b = Math.max(dragX, c); dragX = null;
      sel.setAttribute('visibility', 'hidden');
      if (b - a < 8) return;
      const inv = p => view[0] + ((p - left) / (W - left - 10)) * (view[1] - view[0]);
      state.view = [Math.max(view[0], inv(a)), Math.min(view[1], inv(b))]; loadTimeline();
    };
    svg.addEventListener('mouseup', end); svg.addEventListener('mouseleave', ev => { if (dragX !== null) end(ev); });
    const legend = h('div', {class: 'tl-legend'}, Object.keys(SEV_COLOR).map(k =>
      h('span', {}, h('i', {style: {background: SEV_COLOR[k]}}), ' ' + k)));
    tlBox.append(svg, legend);
  }

  // ------------------------------------------------------------ heatmap
  function hmColor(v, metric) {
    if (v == null) return 'var(--panel2)';
    const lim = metric === 'lat' ? [20, 80, 200] : [0.5, 2, 10];
    const pal = ['#2fae5c', '#8ac24a', '#ffb23d', '#e0453f'];
    const i = v <= lim[0] ? 0 : v <= lim[1] ? 1 : v <= lim[2] ? 2 : 3;
    return pal[i];
  }
  async function loadHeatmap() {
    const t = document.getElementById('hmTarget').value;
    if (!t) { hmBox.replaceChildren(emptyState('Cadastre um destino para ver o mapa de calor.')); return; }
    const metric = document.getElementById('hmMetric').value;
    let d;
    try { d = await apiJSON('GET', '/api/heatmap?target=' + encodeURIComponent(t) + '&days=' + document.getElementById('hmDays').value); }
    catch (e) { hmBox.replaceChildren(emptyState('Erro: ' + e.message)); return; }
    const grid = h('div', {class: 'hm-grid', role: 'table', 'aria-label': 'Mapa de calor'});
    grid.style.gridTemplateColumns = '64px repeat(24, minmax(10px, 1fr))';
    grid.append(h('div', {}));
    for (let hh = 0; hh < 24; hh++) grid.append(h('div', {class: 'hm-h', text: hh % 3 === 0 ? String(hh).padStart(2, '0') : ''}));
    const map = {};
    d.cells.forEach(c => { map[c.d + ':' + c.h] = c; });
    d.days.forEach((day, di) => {
      grid.append(h('div', {class: 'hm-d', text: day.slice(8) + '/' + day.slice(5, 7)}));
      for (let hh = 0; hh < 24; hh++) {
        const c = map[di + ':' + hh], v = c ? (metric === 'lat' ? c.lat : c.loss) : null;
        const cell = h('div', {class: 'hm-c', role: 'cell', title: day + ' ' + String(hh).padStart(2, '0') + 'h — ' +
          (c ? ('latência ' + (c.lat != null ? c.lat + ' ms' : '–') + ' · perda ' + c.loss + '%') : 'sem dados')});
        cell.style.background = hmColor(v, metric);
        if (v != null && ((metric === 'lat' && v > 200) || (metric === 'loss' && v > 10))) cell.textContent = '!';
        grid.append(cell);
      }
    });
    const leg = h('div', {class: 'tl-legend'}, ['bom', 'ok', 'atenção', 'ruim'].map((n, i) =>
      h('span', {}, h('i', {style: {background: ['#2fae5c', '#8ac24a', '#ffb23d', '#e0453f'][i]}}), ' ' + n)),
      h('span', {}, h('i', {style: {background: 'var(--panel2)'}}), ' sem dados'));
    hmBox.replaceChildren(grid, leg);
  }

  // ------------------------------------------------------------ zabbix / sites / certs
  async function loadZabbix() {
    let d;
    try { d = await apiJSON('GET', '/api/zabbix/problems'); } catch (e) { zbBox.replaceChildren(emptyState('Erro: ' + e.message)); return; }
    if (!d.enabled) { zbBox.replaceChildren(emptyState('Integração desativada. Configure em Configurações → Zabbix.')); return; }
    if (d.ok === false) { zbBox.replaceChildren(emptyState('Falha ao consultar o Zabbix: ' + d.error)); return; }
    if (!d.problems.length) { zbBox.replaceChildren(emptyState('Nenhum problema ativo no Zabbix. ✅')); return; }
    const cls = ['', 'info', 'warn', 'avg', 'high', 'dis'];
    zbBox.replaceChildren(h('table', {class: 'data-table'},
      h('thead', {}, h('tr', {}, ['Severidade', 'Host', 'Problema', 'Desde'].map(t => h('th', {text: t})))),
      h('tbody', {}, d.problems.map(p => h('tr', {},
        h('td', {}, h('span', {class: 'zb-sev zb' + p.severity, text: '⚠ ' + p.severity_name})),
        h('td', {text: p.host}), h('td', {text: p.name + (p.ack ? ' ✔' : '')}), h('td', {text: fmtDateTime(p.since)}))))));
  }
  async function loadSites() {
    let d;
    try { d = await apiJSON('GET', '/api/sites'); } catch (e) { stBox.replaceChildren(emptyState('Erro: ' + e.message)); return; }
    if (!d.sites.length) { stBox.replaceChildren(emptyState('Nenhum agente remoto reportou ainda. Veja agent.py.')); return; }
    const sites = d.sites.map(s => h('span', {class: 'status-pill ' + (s.online ? 'online' : 'offline'),
      text: (s.online ? '▲ ' : '▼ ') + s.site}));
    const rows = d.targets.map(t => h('tr', {},
      h('td', {text: t.target}), h('td', {text: t.local === true ? '▲ ok' : t.local === false ? '▼ fora' : '–'}),
      h('td', {text: Object.keys(t.sites).map(s => s + ': ' + (t.sites[s].up ? '▲' : '▼')).join('  ')}),
      h('td', {text: t.diagnosis})));
    stBox.replaceChildren(h('div', {class: 'x-controls'}, sites), h('table', {class: 'data-table'},
      h('thead', {}, h('tr', {}, ['Alvo', 'Central', 'Sites', 'Diagnóstico'].map(x => h('th', {text: x})))), h('tbody', {}, rows)));
  }
  async function loadCerts() {
    let d;
    try { d = await apiJSON('GET', '/api/certs'); } catch (e) { ctBox.replaceChildren(emptyState('Erro: ' + e.message)); return; }
    const names = Object.keys(d);
    if (!names.length) { ctBox.replaceChildren(emptyState('Nenhum alvo HTTPS monitorado (a verificação roda a cada 6 h).')); return; }
    ctBox.replaceChildren(h('table', {class: 'data-table'}, h('tbody', {}, names.sort().map(n => {
      const v = d[n], cls = v == null ? '' : v < 3 ? 'offline' : v < 14 ? 'warn' : 'online';
      return h('tr', {}, h('td', {text: n}), h('td', {}, h('span', {class: 'status-pill ' + cls,
        text: v == null ? '? sem leitura' : (v < 14 ? '⚠ ' : '✔ ') + Math.floor(v) + ' dias'})));
    }))));
  }

  async function fillTargets() {
    try {
      const s = await apiJSON('GET', '/api/settings');
      const sel = document.getElementById('hmTarget'), cur = sel.value;
      sel.replaceChildren(...s.targets.map(t => h('option', {value: t.name, text: t.name})));
      if (s.targets.some(t => t.name === cur)) sel.value = cur;
    } catch (e) { /* ok */ }
  }

  function onShow() {
    fillTargets().then(loadHeatmap);
    loadTimeline(); loadZabbix(); loadSites(); loadCerts();
    clearInterval(timer);
    timer = setInterval(() => {
      const p = document.querySelector('.page.active');
      if (!p || p.dataset.page !== 'analise') { clearInterval(timer); return; }
      loadTimeline(); loadZabbix(); loadSites();
    }, 30000);
  }

  window.addEventListener('load', build);
})();
