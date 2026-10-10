// NetNOC — utilitários de segurança do frontend (carregado antes de tudo)
(function () {
  const MAP = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'};
  window.esc = function (v) {
    return v == null ? '' : String(v).replace(/[&<>"'`]/g, c => MAP[c]);
  };
  // toda requisição que muda estado leva o cabeçalho anti-CSRF
  const orig = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    opts = opts || {};
    const m = (opts.method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') {
      opts.headers = Object.assign({}, opts.headers || {}, {'X-NetNOC': '1'});
    }
    opts.credentials = opts.credentials || 'same-origin';
    return orig(url, opts);
  };
  // mini gráfico SVG (apenas números -> seguro)
  window.sparkSvg = function (vals, w, h) {
    w = w || 80; h = h || 22;
    if (!vals || vals.length < 2) return '<span class="muted">–</span>';
    const nums = vals.map(v => (typeof v === 'number' && isFinite(v)) ? v : null);
    const ok = nums.filter(v => v !== null);
    if (!ok.length) return '<span class="muted">–</span>';
    const mn = Math.min.apply(null, ok), mx = Math.max.apply(null, ok), rng = (mx - mn) || 1;
    const step = w / (nums.length - 1);
    let d = '', pen = false, bad = '';
    nums.forEach((v, i) => {
      const x = (i * step).toFixed(1);
      if (v === null) { pen = false; bad += '<rect x="' + x + '" y="0" width="' + Math.max(1, step).toFixed(1) + '" height="' + h + '" class="spark-bad"/>'; return; }
      const y = (h - 2 - ((v - mn) / rng) * (h - 4)).toFixed(1);
      d += (pen ? 'L' : 'M') + x + ' ' + y; pen = true;
    });
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="latência na última hora">' + bad + '<path d="' + d + '"/></svg>';
  };
})();
