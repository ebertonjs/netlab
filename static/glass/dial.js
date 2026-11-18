// NetNOC — mostrador redondo (estilo termostato de parede). Visual inspirado no hc-dial-card (MIT).
// NNDial.create() → {el, set(d)}. set() só mexe no que mudou, então o anel gira suave entre atualizações.
//   d = {state: ok|warn|bad|iso|na, off (número apagado), top, topIcon, kind, label, big, unit, sub: [[rótulo, valor, unidade], ...],
//        foot, footSmall, q: 0..3 (barras), loss: bool, net: bool, rot: graus, aria}
'use strict';
(function () {
  const STATE_ICO = {ok: 'check', warn: 'alert', bad: 'x', iso: 'minus', na: 'minus'};

  function create() {
    const el = document.createElement('div');
    el.className = 'nnd na';
    el.setAttribute('role', 'img');
    el.innerHTML =
      '<div class="nnd-ring"><div class="nnd-knurl"><i class="nnd-mark"></i></div></div><div class="nnd-bezel"></div>' +
      '<div class="nnd-disp">' +
      '<div class="a nnd-top"><b data-k="topIcon"></b><span data-k="top"></span></div>' +
      '<div class="a nnd-kind" data-k="kind"></div>' +
      '<div class="a nnd-dot" data-k="dot"></div>' +
      '<div class="a nnd-q"><i></i><i></i><i></i></div>' +
      '<div class="a nnd-loss" data-k="loss">' + ICO('loss') + '</div>' +
      '<div class="a nnd-net" data-k="net">' + ICO('wifi') + '</div>' +
      '<div class="a nnd-lbl"><span data-k="label"></span></div>' +
      '<div class="a nnd-big"><span data-k="big">--</span><sup data-k="unit"></sup></div>' +
      '<div class="a nnd-line"></div>' +
      '<div class="a nnd-sub" data-k="sub"></div>' +
      '<div class="a nnd-foot"><span data-k="foot"></span><small data-k="footSmall"></small></div>' +
      '</div>';
    const $ = {};
    el.querySelectorAll('[data-k]').forEach(n => { $[n.dataset.k] = n; });
    const bars = el.querySelectorAll('.nnd-q i');
    const knurl = el.querySelector('.nnd-knurl');
    let prev = {};
    const txt = (k, v) => { v = v == null ? '' : String(v); if (prev[k] !== v) { prev[k] = v; $[k].textContent = v; } };
    const ico = (k, name) => { if (prev[k] !== name) { prev[k] = name; $[k].innerHTML = name ? ICO(name) : ''; } };

    function set(d) {
      const st = d.state || 'na';
      const cls = 'nnd ' + st + (d.off ? ' off' : '');
      if (prev.cls !== cls) { prev.cls = cls; el.className = cls; }
      ico('dot', STATE_ICO[st]);
      txt('top', d.top); ico('topIcon', d.topIcon); ico('kind', d.kind);
      txt('label', d.label); txt('big', d.big); txt('unit', d.unit);
      txt('foot', d.foot); txt('footSmall', d.footSmall);
      const subSig = JSON.stringify(d.sub || []);
      if (prev.sub !== subSig) {
        prev.sub = subSig;
        $.sub.textContent = '';
        for (const [k, v, u] of d.sub || []) {
          const s = document.createElement('span');
          const sm = document.createElement('small'); sm.textContent = k;
          const b = document.createElement('b'); b.textContent = v; b.style.fontWeight = 'inherit';
          s.append(sm, b);
          if (u) { const uu = document.createElement('u'); uu.textContent = u; s.append(uu); }
          $.sub.append(s);
        }
      }
      bars.forEach((b, i) => b.classList.toggle('on', i < (d.q || 0)));
      $.loss.classList.toggle('on', !!d.loss);
      const netOff = d.net === false;
      if (prev.net !== netOff) { prev.net = netOff; $.net.classList.toggle('off', netOff); $.net.innerHTML = ICO(netOff ? 'wifiOff' : 'wifi'); }
      if (d.rot != null && isFinite(d.rot)) knurl.style.setProperty('--rot', d.rot.toFixed(1) + 'deg');
      if (d.aria && prev.aria !== d.aria) { prev.aria = d.aria; el.setAttribute('aria-label', d.aria); }
    }
    return {el, set};
  }

  // Maior tamanho de mostrador que cabe em W×H para n itens (escolhe o número de colunas).
  function fit(n, W, H, gap) {
    let best = 0, cols = 1;
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const s = Math.min((W - (c - 1) * gap) / c, (H - (r - 1) * gap) / r);
      if (s > best) { best = s; cols = c; }
    }
    return {size: Math.max(0, Math.floor(best)), cols};
  }

  window.NNDial = {create, fit};
})();
