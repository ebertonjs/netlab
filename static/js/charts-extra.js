// Gráficos: bandas de incidentes, zoom por arraste (duplo clique reseta), anotação de pico e SLA em destaque.
(function () {
  const RANGE_DAYS = {'5m': 5 / 1440, '1h': 1 / 24, '24h': 1, '7d': 7, '30d': 30};
  const BAND = {Alta: 'rgba(255,92,92,0.16)', Media: 'rgba(255,178,61,0.14)'};
  window.__incBands = [];
  const getPing = () => (typeof pingChart !== 'undefined' ? pingChart : null);
  const getJitter = () => (typeof jitterChart !== 'undefined' ? jitterChart : null);
  const getRange = () => (typeof currentRange !== 'undefined' ? currentRange : '5m');
  let sel = null;       // {chart, a, b}

  function idxFromTs(ts) {
    const arr = window.__pingLabelTs || [];
    if (!arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < ts) lo = m + 1; else hi = m; }
    return lo;
  }

  const plugin = {
    id: 'netnocExtras',
    beforeDatasetsDraw(chart) {
      if (chart.canvas.id !== 'pingChart' || !window.__incBands.length) return;
      const {ctx, chartArea: ca, scales: {x}} = chart;
      if (!x || !ca) return;
      const arr = window.__pingLabelTs || [];
      if (!arr.length) return;
      const now = Date.now() / 1000;
      ctx.save();
      window.__incBands.forEach(b => {
        const end = b.end || now;
        if (end < arr[0] || b.start > arr[arr.length - 1]) return;
        const i0 = idxFromTs(Math.max(b.start, arr[0])), i1 = idxFromTs(Math.min(end, arr[arr.length - 1]));
        if (i0 == null || i1 == null) return;
        let x0 = x.getPixelForValue(i0), x1 = x.getPixelForValue(i1);
        if (!isFinite(x0) || !isFinite(x1)) return;
        x0 = Math.max(ca.left, Math.min(x0, ca.right)); x1 = Math.max(ca.left, Math.min(x1, ca.right));
        ctx.fillStyle = BAND[b.severity] || BAND.Media;
        ctx.fillRect(x0, ca.top, Math.max(2, x1 - x0), ca.bottom - ca.top);
      });
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      if (chart.canvas.id !== 'pingChart') return;
      const {ctx, chartArea: ca} = chart;
      let best = null;
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        ds.data.forEach((p, j) => {
          const y = p && p.y;
          if (y != null && (best === null || y > best.y) && meta.data[j]) best = {y: y, el: meta.data[j]};
        });
      });
      if (best && best.y > 0 && isFinite(best.el.x)) {
        ctx.save();
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#ddd';
        ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'center';
        const tx = Math.min(Math.max(best.el.x, ca.left + 24), ca.right - 24);
        ctx.fillText('▲ ' + best.y.toFixed(0) + ' ms', tx, Math.max(ca.top + 10, best.el.y - 6));
        ctx.restore();
      }
      if (sel && sel.chart === chart && sel.a != null) {
        ctx.save(); ctx.fillStyle = 'rgba(77,141,255,0.18)'; ctx.strokeStyle = 'rgba(77,141,255,0.7)';
        const l = Math.min(sel.a, sel.b), w = Math.abs(sel.b - sel.a);
        ctx.fillRect(l, ca.top, w, ca.bottom - ca.top); ctx.strokeRect(l, ca.top, w, ca.bottom - ca.top); ctx.restore();
      }
    }
  };

  function zoomAll(min, max) {
    [getPing(), getJitter()].forEach(c => {
      if (!c || !c.options || !c.options.scales || !c.options.scales.x) return;
      if (min == null) { delete c.options.scales.x.min; delete c.options.scales.x.max; }
      else { c.options.scales.x.min = min; c.options.scales.x.max = max; }
      c.update('none');
    });
  }

  function attachZoom(chart) {
    if (!chart || !chart.canvas || chart.__zoomAttached) return; chart.__zoomAttached = true;
    const cv = chart.canvas;
    cv.style.cursor = 'crosshair';
    const px = ev => { const r = cv.getBoundingClientRect(); return (ev.clientX - r.left) * (cv.width / (window.devicePixelRatio || 1) / r.width); };
    cv.addEventListener('mousedown', ev => { const ca = chart.chartArea; const x = px(ev); if (!ca || x < ca.left || x > ca.right) return; sel = {chart: chart, a: x, b: x}; });
    cv.addEventListener('mousemove', ev => { if (sel && sel.chart === chart) { sel.b = Math.min(Math.max(px(ev), chart.chartArea.left), chart.chartArea.right); chart.draw(); } });
    const done = () => {
      if (!sel || sel.chart !== chart) return;
      const s = sel; sel = null;
      if (Math.abs(s.b - s.a) > 12) {
        const x = chart.scales.x;
        const i0 = Math.round(x.getValueForPixel(Math.min(s.a, s.b))), i1 = Math.round(x.getValueForPixel(Math.max(s.a, s.b)));
        if (isFinite(i0) && isFinite(i1) && i1 > i0) { zoomAll(i0, i1); return; }
      }
      chart.draw();
    };
    cv.addEventListener('mouseup', done); cv.addEventListener('mouseleave', done);
    cv.addEventListener('dblclick', () => zoomAll(null, null));
    cv.setAttribute('title', 'Arraste para ampliar · duplo clique para voltar');
  }

  async function loadBands() {
    try {
      const rows = await apiJSON('GET', '/api/incidents?days=' + (RANGE_DAYS[getRange()] || 1));
      window.__incBands = rows.filter(r => r.type === 'offline' || r.severity === 'Alta')
        .map(r => ({start: r.started_ts, end: r.resolved_ts, severity: r.severity}));
      if (getPing()) getPing().update('none');
    } catch (e) { /* ok */ }
  }

  async function loadSla() {
    try {
      const rows = await apiJSON('GET', '/api/targets');
      const v = rows.map(r => r.uptime_24h).filter(x => x != null);
      let el = document.getElementById('slaBadge');
      const head = document.querySelector('[data-widget="chart-ping"] .panel-header');
      if (!head) return;
      if (!el) { el = h('span', {id: 'slaBadge', class: 'sla-badge', title: 'Disponibilidade média nas últimas 24 h'}); head.append(el); }
      const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      el.textContent = avg == null ? '' : 'SLA 24h: ' + avg.toFixed(2) + '%';
      el.className = 'sla-badge ' + (avg == null ? '' : avg >= 99.9 ? 'good' : avg >= 99 ? 'warn' : 'bad');
    } catch (e) { /* ok */ }
  }

  if (window.Chart && Chart.register) Chart.register(plugin);
  window.addEventListener('load', () => {
    setTimeout(() => { attachZoom(getPing()); attachZoom(getJitter()); }, 300);
    loadBands(); loadSla();
    setInterval(loadBands, 15000); setInterval(loadSla, 30000);
    const rs = document.getElementById('rangeSelect');
    if (rs) rs.addEventListener('change', () => { zoomAll(null, null); setTimeout(loadBands, 50); });
  });
})();
