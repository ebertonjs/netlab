// topology.js — Topologia NOC profissional, animação seletiva por evento
(function () {
  const canvas = document.getElementById('topoCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const emptyEl = document.getElementById('topoEmpty');
  const detailBody = document.getElementById('topoDetailBody');

  let nodes = [];      // {id, label, type, online, host}
  let edges = [];      // {source, target}
  let positions = {};  // id -> {x, y}
  let prevOnline = {}; // id -> boolean (estado anterior, p/ detectar mudança)
  let flashes = {};    // id -> {startTs, fromOnline, toOnline} — flash de transição
  let scale = 1, offsetX = 0, offsetY = 0;
  let dragging = null;
  let selectedId = null;
  let hoveredId = null;
  let loaded = false;

  let animFrameId = null;
  let animTime = 0;
  let lastFrameTs = 0;
  const FLASH_DURATION = 1.4; // segundos

  function resizeCanvas() {
    const box = canvas.parentElement.getBoundingClientRect();
    canvas.width = box.width * devicePixelRatio;
    canvas.height = box.height * devicePixelRatio;
    canvas.style.width = box.width + 'px';
    canvas.style.height = box.height + 'px';
  }

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  window.addEventListener('resize', resizeCanvas);

  function getCss(varName, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return val || fallback;
  }

  function getColor(n) {
    if (n.type === 'internet') return getCss('--blue', '#3a7bd5');
    if (n.online === true) return getCss('--green', '#2fae5c');
    if (n.online === false) return getCss('--red', '#d9463f');
    return getCss('--muted', '#8a8f9c');
  }

  function layout() {
    const children = {};
    edges.forEach(e => {
      (children[e.source] = children[e.source] || []).push(e.target);
    });
    const root = nodes.find(n => n.type === 'internet') || nodes[0];
    if (!root) return;

    const visited = new Set([root.id]);
    positions[root.id] = positions[root.id] || { x: 0, y: 0 };
    let frontier = [root.id];
    let level = 1;

    while (frontier.length) {
      const next = [];
      frontier.forEach(pid => (children[pid] || []).forEach(cid => {
        if (!visited.has(cid)) { visited.add(cid); next.push(cid); }
      }));
      const radius = level * 160;
      next.forEach((id, i) => {
        if (positions[id]) return;
        const angle = (i / Math.max(next.length, 1)) * Math.PI * 2 - Math.PI / 2;
        positions[id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      });
      frontier = next;
      level++;
    }

    let orphanIndex = 0;
    nodes.forEach(n => {
      if (!positions[n.id]) {
        positions[n.id] = { x: orphanIndex * 130 - 200, y: level * 160 };
        orphanIndex++;
      }
    });
  }

  // Detecta mudanças de status desde o último refresh e agenda flashes
  function detectStatusChanges() {
    const now = performance.now() / 1000;
    nodes.forEach(n => {
      const prev = prevOnline[n.id];
      if (prev !== undefined && prev !== n.online) {
        flashes[n.id] = { startTs: now, fromOnline: prev, toOnline: n.online };
      }
      prevOnline[n.id] = n.online;
    });
  }

  function worldToScreen(x, y) {
    const box = canvas.getBoundingClientRect();
    return {
      x: box.width / 2 + (x + offsetX) * scale,
      y: box.height / 2 + (y + offsetY) * scale,
    };
  }

  function screenToWorld(sx, sy) {
    const box = canvas.getBoundingClientRect();
    return {
      x: (sx - box.width / 2) / scale - offsetX,
      y: (sy - box.height / 2) / scale - offsetY,
    };
  }

  function drawBackground(width, height) {
    ctx.strokeStyle = getCss('--border', 'rgba(120,120,130,0.06)');
    ctx.lineWidth = 1;
    const gridSize = 48 * scale;
    const startX = (boxWidthHalf() + offsetX * scale) % gridSize;
    const startY = (boxHeightHalf() + offsetY * scale) % gridSize;

    ctx.beginPath();
    for (let x = startX; x < width; x += gridSize) {
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let y = startY; y < height; y += gridSize) {
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  function boxWidthHalf() { return canvas.getBoundingClientRect().width / 2; }
  function boxHeightHalf() { return canvas.getBoundingClientRect().height / 2; }

  function startAnimation() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    lastFrameTs = performance.now();

    function loop(ts) {
      const dt = Math.min((ts - lastFrameTs) / 1000, 0.1);
      lastFrameTs = ts;
      animTime += dt;
      draw();
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);
  }

  function draw() {
    const box = canvas.getBoundingClientRect();
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);

    drawBackground(box.width, box.height);

    if (!nodes.length) return;

    const nowSec = performance.now() / 1000;

    // 1. Arestas — estáticas, só mudam cor no estado atual (sem loop de pacote)
    edges.forEach(e => {
      const p1 = positions[e.source], p2 = positions[e.target];
      if (!p1 || !p2) return;
      const s1 = worldToScreen(p1.x, p1.y), s2 = worldToScreen(p2.x, p2.y);

      const targetNode = nodes.find(n => n.id === e.target);
      const isOffline = targetNode && targetNode.online === false;
      const flash = targetNode && flashes[targetNode.id];

      let strokeStyle = isOffline ? 'rgba(217, 70, 63, 0.45)' : getCss('--border', 'rgba(120,120,130,0.35)');
      let lineWidth = 1.4 * Math.min(scale, 1.2);
      // cor/espessura pela qualidade do enlace (latência e perda do destino)
      const q = isOffline ? null : edgeQuality(e);
      if (q) {
        strokeStyle = q === 'bad' ? 'rgba(217, 70, 63, 0.85)' : q === 'warn' ? 'rgba(255, 178, 61, 0.85)' : 'rgba(47, 174, 92, 0.6)';
        lineWidth *= q === 'bad' ? 2.2 : q === 'warn' ? 1.8 : 1.4;
      }

      // Flash na aresta durante a transição de status (destaca a mudança sem loop contínuo)
      if (flash) {
        const t = nowSec - flash.startTs;
        if (t < FLASH_DURATION) {
          const alpha = 1 - t / FLASH_DURATION;
          strokeStyle = flash.toOnline ? `rgba(47, 174, 92, ${0.25 + alpha * 0.5})` : `rgba(217, 70, 63, ${0.25 + alpha * 0.5})`;
          lineWidth = (1.4 + alpha * 1.6) * Math.min(scale, 1.2);
        } else {
          delete flashes[targetNode.id];
        }
      }

      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = strokeStyle;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
    });

    // 1b. Partículas de tráfego (MikroTik): velocidade proporcional ao throughput total
    if (trafficBps > 50000 && !reduceMotion) {
      const speed = 0.12 + 0.3 * Math.min(1, Math.max(0, Math.log10(trafficBps / 1e5) / 3));
      edges.forEach(e => {
        if (e.source !== 'internet') return;
        const tn = nodes.find(n => n.id === e.target);
        if (!tn || tn.online === false) return;
        const p1 = positions[e.source], p2 = positions[e.target];
        if (!p1 || !p2) return;
        const a = worldToScreen(p1.x, p1.y), b = worldToScreen(p2.x, p2.y);
        for (let k = 0; k < 3; k++) {
          const f = (nowSec * speed + k / 3) % 1;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 2.4 * Math.min(scale, 1.3), 0, Math.PI * 2);
          ctx.fillStyle = getCss('--accent', '#4d8dff');
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1.0;
        }
      });
    }

    // 2. Nós
    nodes.forEach(n => {
      const p = positions[n.id];
      if (!p) return;
      const s = worldToScreen(p.x, p.y);
      const isInternet = n.type === 'internet';
      const isHovered = n.id === hoveredId;
      const baseRadius = isInternet ? 20 : 14;
      const r = (baseRadius + (isHovered ? 2 : 0)) * Math.min(scale, 1.4);
      const color = getColor(n);
      const flash = flashes[n.id];

      // Anel de pulso lento e discreto (só nós online/internet, ciclo de ~4s, amplitude pequena)
      if ((n.online === true || isInternet) && !flash) {
        const pulse = (Math.sin(animTime * 0.8) + 1) * 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 4 + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.12;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // Flash de transição de status no próprio nó — anel expandindo uma vez
      if (flash) {
        const t = nowSec - flash.startTs;
        if (t < FLASH_DURATION) {
          const progress = t / FLASH_DURATION;
          const flashColor = flash.toOnline ? getCss('--green', '#2fae5c') : getCss('--red', '#d9463f');
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 4 + progress * 16, 0, Math.PI * 2);
          ctx.strokeStyle = flashColor;
          ctx.globalAlpha = (1 - progress) * 0.6;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        }
      }

      // Sem glow/shadow contínuo — só leve destaque em hover/seleção
      if (n.id === selectedId || isHovered) {
        ctx.shadowBlur = 6;
        ctx.shadowColor = color;
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (n.id === selectedId) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = getCss('--text', '#e8ebf5');
        ctx.stroke();
      }

      // Label com fundo sólido leve, sem transparência exagerada
      const fontSize = Math.max(10, 11 * Math.min(scale, 1.2));
      ctx.font = `500 ${fontSize}px system-ui, -apple-system, sans-serif`;
      const textWidth = ctx.measureText(n.label).width;
      const padX = 6, padY = 3;
      const labelY = s.y + r + 16;

      ctx.fillStyle = getCss('--surface', 'rgba(20, 22, 28, 0.85)');
      roundRect(ctx, s.x - textWidth / 2 - padX, labelY - fontSize / 2 - padY, textWidth + padX * 2, fontSize + padY * 2, 4);
      ctx.fill();

      ctx.fillStyle = getCss('--text', '#cfd3dc');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.label, s.x, labelY);
      ctx.textBaseline = 'alphabetic';
    });
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function nodeAt(sx, sy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const p = positions[n.id];
      if (!p) continue;
      const s = worldToScreen(p.x, p.y);
      const r = (n.type === 'internet' ? 20 : 14) * Math.min(scale, 1.4);
      if (Math.hypot(sx - s.x, sy - s.y) <= r + 5) return n;
    }
    return null;
  }

  function showDetail(n) {
    selectedId = n ? n.id : null;
    if (!detailBody) return;
    if (!n) {
      detailBody.innerHTML = '<div class="insight-empty">Clique em um nó do grafo para ver os detalhes. Arraste para reorganizar, use a roda do mouse para zoom.</div>';
      return;
    }
    const statusLabel = n.type === 'internet' ? 'Rede principal' : (n.online === true ? 'Online' : n.online === false ? 'Offline' : 'Sem dados');
    detailBody.innerHTML = `
      <div class="topo-detail-title">${esc(n.label)}</div>
      <div class="topo-detail-row"><span>Status</span><span>${statusLabel}</span></div>
      ${n.host ? `<div class="topo-detail-row"><span>Host / IP</span><span>${esc(n.host)}</span></div>` : ''}
    `;
  }

  // ---------- Eventos & Interação ----------
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = nodeAt(sx, sy);
    if (hit) {
      dragging = { kind: 'node', id: hit.id };
      showDetail(hit);
    } else {
      dragging = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      if (dragging.kind === 'node') {
        const rect = canvas.getBoundingClientRect();
        const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        positions[dragging.id] = world;
      } else if (dragging.kind === 'pan') {
        const dx = e.clientX - dragging.lastX, dy = e.clientY - dragging.lastY;
        offsetX += dx / scale;
        offsetY += dy / scale;
        dragging.lastX = e.clientX;
        dragging.lastY = e.clientY;
      }
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      hoveredId = null;
      return;
    }
    const hit = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    hoveredId = hit ? hit.id : null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  });

  window.addEventListener('mouseup', () => { dragging = null; });

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left, sy = touch.clientY - rect.top;
      const hit = nodeAt(sx, sy);
      if (hit) {
        dragging = { kind: 'node', id: hit.id };
        showDetail(hit);
      } else {
        dragging = { kind: 'pan', lastX: touch.clientX, lastY: touch.clientY };
      }
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (dragging.kind === 'node') {
      const rect = canvas.getBoundingClientRect();
      const world = screenToWorld(touch.clientX - rect.left, touch.clientY - rect.top);
      positions[dragging.id] = world;
    } else if (dragging.kind === 'pan') {
      const dx = touch.clientX - dragging.lastX, dy = touch.clientY - dragging.lastY;
      offsetX += dx / scale;
      offsetY += dy / scale;
      dragging.lastX = touch.clientX;
      dragging.lastY = touch.clientY;
    }
  }, { passive: true });

  canvas.addEventListener('touchend', () => { dragging = null; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(Math.max(scale * delta, 0.3), 3);

    const after = screenToWorld(sx, sy);
    offsetX += (after.x - before.x);
    offsetY += (after.y - before.y);
  }, { passive: false });

  document.getElementById('topoZoomIn')?.addEventListener('click', () => { scale = Math.min(scale * 1.2, 3); });
  document.getElementById('topoZoomOut')?.addEventListener('click', () => { scale = Math.max(scale * 0.8, 0.3); });
  document.getElementById('topoReset')?.addEventListener('click', () => {
    positions = {}; scale = 1; offsetX = 0; offsetY = 0;
    layout();
  });

  let trafficBps = 0;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function edgeQuality(e) {
    if (e.latency == null && e.loss_pct == null) return null;
    if ((e.loss_pct || 0) >= 10 || (e.latency || 0) > 200) return 'bad';
    if ((e.loss_pct || 0) >= 2 || (e.latency || 0) > 80) return 'warn';
    return e.latency != null ? 'good' : null;
  }

  async function refreshTraffic() {
    try {
      const res = await fetch('/api/mikrotik/interfaces');
      const rows = await res.json();
      trafficBps = Array.isArray(rows)
        ? rows.filter(r => r.running && !r.disabled).reduce((s, r) => s + (r.rx_bps || 0) + (r.tx_bps || 0), 0) : 0;
    } catch (e) { trafficBps = 0; }
  }

  async function refreshTopologyData() {
    try {
      const res = await fetch('/api/topology');
      const data = await res.json();
      nodes = data.nodes || [];
      edges = data.edges || [];
    } catch (e) {
      nodes = []; edges = [];
    }
    refreshTraffic();
    if (emptyEl) emptyEl.classList.toggle('hidden', nodes.length > 1);
    detectStatusChanges();
    layout();
    if (!loaded) {
      resizeCanvas();
      resizeObserver.observe(canvas.parentElement);
      startAnimation();
      loaded = true;
    }
  }

  function onTopologyPageShown() {
    resizeCanvas();
    refreshTopologyData();
  }

  window.refreshTopologyData = refreshTopologyData;
  window.onTopologyPageShown = onTopologyPageShown;
})();
