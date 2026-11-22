// NetNOC — peças comuns das telas (sheets): botões, campos, seções e gráficos. Cada tela fica em telas/<nome>.js.
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;

  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const C = n => window.SKIN.col(n);
  const pal = i => window.SKIN.palette()[i % 8];
  const RANGES = [['5m', '5 min'], ['1h', '1 h'], ['24h', 'Dia'], ['7d', 'Semana'], ['30d', 'Mês']];
  const RANGE_S = {'5m': 300, '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000};
  const ui = {lastRange: '1h'};      // período escolhido por último (Latência e Destino compartilham)

  // ------------------------------------------------------------------ peças comuns
  function seg(items, value, onChange) {
    const s = h('div', {class: 'seg'});
    for (const [v, label] of items) {
      s.append(h('button', {type: 'button', class: v === value ? 'on' : '', text: label, onclick: () => onChange(v)}));
    }
    return s;
  }
  const tbtn = (text, icon, onclick, cls) => h('button', {class: 'tbtn' + (cls ? ' ' + cls : ''), type: 'button', onclick},
    icon ? h('span', {trusted: ICO(icon)}) : null, text);
  const stat = (icon, title, value, cls) => h('div', {class: 'stat' + (cls ? ' ' + cls : '')},
    h('span', {class: 'si', trusted: ICO(icon)}), h('div', {}, h('b', {text: title}), h('span', {text: value})));
  const sec = (icon, title, ...kids) => h('section', {class: 'sec'}, h('h3', {}, h('span', {trusted: ICO(icon)}), title), ...kids);
  const chartBox = cls => { const c = h('canvas'); return [h('div', {class: 'chart-box' + (cls ? ' ' + cls : '')}, c), c]; };
  const kv = pairs => { const d = h('dl', {class: 'kv'}); for (const [k, v] of pairs) d.append(h('dt', {text: k}), h('dd', {text: v == null ? '--' : v})); return d; };
  const panels = ctx => { const L = h('aside', {class: 'panel dark'}); const R = h('div', {class: 'panel main'}); ctx.body.append(L, R); return [L, R]; };
  const needAdmin = () => { if (!NN.isAdmin()) { toast('Somente administradores podem alterar', 'error'); return true; } return false; };
  function field(label, input) { return h('label', {class: 'field'}, label, input); }
  const inp = (attrs) => h('input', Object.assign({class: 'inp'}, attrs));
  function select(options, value) {
    const s = h('select', {class: 'inp'});
    for (const [v, l] of options) { const o = h('option', {value: v, text: l}); if (String(v) === String(value)) o.selected = true; s.append(o); }
    return s;
  }
  function sw(label, checked) { const i = h('input', {type: 'checkbox'}); i.checked = !!checked; return [h('label', {class: 'switch'}, i, label), i]; }
  async function act(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'error'); return null; }
  }
  function li(cls, title, sub, right, onclick) {
    return h('div', {class: 'li ' + (cls || ''), onclick, style: onclick ? {cursor: 'pointer'} : null},
      h('span', {class: 'b'}), h('div', {}, h('div', {text: title}), sub ? h('div', {class: 't2', text: sub}) : null),
      h('div', {class: 'r'}, ...(Array.isArray(right) ? right : [right])));
  }

  // ------------------------------------------------------------------ Chart.js
  function tickFmt(span) {
    return v => {
      const d = new Date(v);
      const p = n => String(n).padStart(2, '0');
      if (span > 2 * 86400) return p(d.getDate()) + '/' + p(d.getMonth() + 1);
      return p(d.getHours()) + ':' + p(d.getMinutes());
    };
  }
  function baseOpts(span, extra) {
    const grid = css('--chart-grid'), tc = css('--muted');
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: {duration: 350}, parsing: false, normalized: true,
      interaction: {mode: 'nearest', axis: 'x', intersect: false},
      scales: {
        x: {type: 'linear', grid: {display: false}, border: {display: false},
          ticks: {color: tc, maxTicksLimit: 8, callback: tickFmt(span), font: {size: 11}}},
        y: {grid: {color: grid}, border: {display: false}, ticks: {color: tc, maxTicksLimit: 6, font: {size: 11}}, beginAtZero: true},
      },
      plugins: {
        legend: {display: false, labels: {color: css('--text-2'), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: {size: 11}}},
        tooltip: {callbacks: {title: it => it.length ? dmhm(it[0].parsed.x / 1000) : ''}},
        decimation: {enabled: true, algorithm: 'lttb', samples: 400},
      },
    }, extra || {});
  }
  function gradient(ctxEl, color) {
    const g = ctxEl.getContext('2d').createLinearGradient(0, 0, 0, ctxEl.parentElement.clientHeight || 220);
    g.addColorStop(0, color + '66'); g.addColorStop(1, color + '00');
    return g;
  }
  function withGaps(points) {
    // insere null onde a coleta parou (restart, queda do host): o gráfico mostra o buraco em vez de uma reta
    if (points.length < 3) return points;
    const dif = [];
    for (let i = 1; i < points.length; i++) dif.push(points[i].x - points[i - 1].x);
    const med = [...dif].sort((a, b) => a - b)[Math.floor(dif.length / 2)] || 0;
    if (!med) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].x - points[i - 1].x > med * 4) out.push({x: points[i - 1].x + med, y: null});
      out.push(points[i]);
    }
    return out;
  }
  function lineDS(canvas, label, points, color, fill) {
    return {label, data: withGaps(points), borderColor: color, backgroundColor: fill ? gradient(canvas, color) : color,
      fill: !!fill, tension: .3, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 3, borderWidth: 2, spanGaps: false};
  }


  function gatewayOf(targets) {
    return targets.find(t => /gateway|router|roteador/i.test(t.name)) ||
      targets.find(t => isLocal(t) && targets.some(c => c.parent === t.name)) || targets.find(isLocal);
  }

  window.NNT = {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf};
})();
