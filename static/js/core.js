// ---------- Toast notifications ----------
function showToast(message, type='success'){
  const container = document.getElementById('toastContainer');
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const s1=document.createElement('span'); s1.textContent=icon; const s2=document.createElement('span'); s2.textContent=message; el.append(s1,s2);
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 250);
  }, 3500);
}

// ---------- Config tabs ----------
document.querySelectorAll('.config-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.config-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.config-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === tab.dataset.tab));
    localStorage.setItem('netnoc_config_tab', tab.dataset.tab);
    if(tab.dataset.tab === 'mikrotik') loadDhcpHosts();
  });
});
(function restoreConfigTab(){
  const saved = localStorage.getItem('netnoc_config_tab');
  if(!saved) return;
  const tab = document.querySelector(`.config-tab[data-tab="${saved}"]`);
  if(tab) tab.click();
})();

// ---------- Validation helpers ----------
function isValidHost(value){
  const v = (value || '').trim();
  if(!v) return false;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const hostname = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]{0,251}[a-zA-Z0-9])?$/;
  if(ipv4.test(v)){
    return v.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
  }
  return hostname.test(v);
}

function markFieldValidity(input, valid, message){
  input.classList.toggle('invalid', !valid);
  let err = input.parentElement.querySelector('.field-error');
  if(!valid){
    if(!err){
      err = document.createElement('div');
      err.className = 'field-error';
      input.parentElement.appendChild(err);
    }
    err.textContent = message;
  } else if(err){
    err.remove();
  }
}

async function loadIncidentBanner(){
  const rows = await getJSON('/api/incidents?active_only=true');
  const el = document.getElementById('incidentBanner');
  if(rows.length === 0){
    el.classList.add('hidden');
    return;
  }
  const hasAlta = rows.some(r => r.severity === 'Alta');
  el.classList.remove('hidden');
  el.innerHTML = `<span class="banner-dot"></span> ${rows.length} incidente${rows.length>1?'s':''} ativo${rows.length>1?'s':''}${hasAlta ? ' — severidade Alta presente' : ''} — clique para ver detalhes`;
  el.onclick = () => {
    showPage('overview');
    const widget = document.querySelector('[data-widget="incidents"]');
    if(widget){
      widget.scrollIntoView({behavior:'smooth', block:'center'});
      widget.classList.remove('flash-highlight');
      void widget.offsetWidth; // reflow para reiniciar a animação
      widget.classList.add('flash-highlight');
    }
  };
}

(function initPage(){
  const saved = localStorage.getItem('netnoc_page') || 'overview';
  showPage(saved);
})();

const THEME_KEY = 'netnoc_theme';

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const sel = document.getElementById('themeSelect');
  if(sel) sel.value = theme;
  localStorage.setItem(THEME_KEY, theme);
  if(theme === 'custom'){
    const custom = loadCustomTheme();
    if(custom) applyCustomThemeVars(custom);
  } else {
    clearCustomThemeVars();
  }
}

document.getElementById('themeSelect').addEventListener('change', e => {
  applyTheme(e.target.value);
  const base = document.getElementById('themeBaseSelect');
  if(e.target.value !== 'custom' && base){
    base.value = e.target.value;
    renderColorPickers(e.target.value);
  }
});

(function initTheme(){
  const saved = localStorage.getItem(THEME_KEY) || 'dark-blue';
  const custom = loadCustomTheme();
  if(custom) ensureCustomOptionInSelects();
  applyTheme(saved);
  const baseSel = document.getElementById('themeBaseSelect');
  const baseForPickers = (saved === 'custom') ? (baseSel?.value || 'dark-blue') : saved;
  renderColorPickers(baseForPickers);
})();

const COLORS = ["#3ddc84", "#4d8dff", "#8a63ff", "#ffb23d", "#ff5c5c", "#2fd9d9"];
let currentRange = "5m";
let pingChart, jitterChart, lossChart, incidentsDonut, mikrotikIfaceChart, aghChart;
let mikrotikSelectedIface = null;
let mikrotikShowDisabled = false;

function barLevel(pct, warn=70, danger=90){
  if(pct >= danger) return 'danger';
  if(pct >= warn) return 'warn';
  return '';
}
function setBar(fillEl, pct, baseClass, warn, danger){
  fillEl.style.width = (pct || 0) + '%';
  fillEl.className = 'bar-fill ' + baseClass + ' ' + barLevel(pct || 0, warn, danger);
}

function fmtTime(ts){
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
}

function hexToRgba(hex, alpha){
  if(!hex || hex[0] !== '#') return hex;
  const h = hex.replace('#','');
  const full = h.length === 3 ? h.split('').map(c=>c+c).join('') : h;
  const r = parseInt(full.substring(0,2),16), g = parseInt(full.substring(2,4),16), b = parseInt(full.substring(4,6),16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function baseChartOpts(yLabel){
  return {
    responsive:true,
    animation:false,
    interaction:{mode:'index', intersect:false},
    elements:{line:{borderWidth:2.25, tension:.35, capBezierPoints:true}, point:{hoverRadius:3.5, hitRadius:8}},
    plugins:{legend:{labels:{color:'#8891ab', boxWidth:9, boxHeight:9, usePointStyle:true, font:{size:11.5}}}},
    scales:{
      x:{ticks:{color:'#8891ab', maxTicksLimit:8, font:{size:11}}, grid:{color:'rgba(35,43,69,.55)', drawTicks:false}, border:{display:false}},
      y:{ticks:{color:'#8891ab', font:{size:11}}, grid:{color:'rgba(35,43,69,.55)', drawTicks:false}, border:{display:false}, title:{display:!!yLabel, text:yLabel, color:'#8891ab'}}
    }
  };
}

function makeChart(ctx, opts){
  return new Chart(ctx, {type:'line', data:{datasets:[]}, options: opts});
}

async function getJSON(url, opts){
  const r = await fetch(url, opts);
  return r.json();
}

async function loadOverview(){
  applyOverview(await getJSON('/api/overview'));
}

function applyOverview(d){
  const dot = document.getElementById('dotInternet');
  const status = document.getElementById('internetStatus');
  if(d.internet_online){ dot.className='dot online'; status.textContent='Online'; }
  else { dot.className='dot offline'; status.textContent='Offline'; }

  document.getElementById('publicIp').textContent = d.public_ip || '--';
  document.getElementById('publicIpv6').textContent = d.public_ipv6 || '';
  document.getElementById('avgLatency').textContent = d.avg_latency != null ? d.avg_latency + ' ms' : '-- ms';
  document.getElementById('avgJitter').textContent = d.avg_jitter != null ? d.avg_jitter + ' ms' : '-- ms';
  document.getElementById('avgLoss').textContent = d.avg_loss_pct != null ? d.avg_loss_pct + ' %' : '-- %';

  if(d.speedtest){
    document.getElementById('speedDown').textContent = (d.speedtest.download ?? '--') + ' Mbps ↓';
    document.getElementById('speedUp').textContent = (d.speedtest.upload ?? '--') + ' Mbps ↑';
    document.getElementById('speedDownBig').textContent = d.speedtest.download ?? '--';
    document.getElementById('speedUpBig').textContent = d.speedtest.upload ?? '--';
    document.getElementById('speedLatBig').textContent = d.speedtest.latency ? d.speedtest.latency.toFixed(0) : '--';
  }

  document.getElementById('sysCpu').textContent = (d.cpu_pct ?? '--') + '%';
  document.getElementById('sysMem').textContent = (d.mem_pct ?? '--') + '%';
  document.getElementById('sysTemp').textContent = (d.temp_c ?? '--') + '°C';
  document.getElementById('barCpu').style.width = (d.cpu_pct || 0) + '%';
  document.getElementById('barMem').style.width = (d.mem_pct || 0) + '%';
  document.getElementById('barTemp').style.width = Math.min(100, ((d.temp_c || 0) / 90) * 100) + '%';
}

async function loadPingCharts(){
  const data = await getJSON(`/api/ping/history?range=${currentRange}`);
  const names = Object.keys(data);
    const labelTs = new Map();
  names.forEach(n => data[n].forEach(r => { const l = fmtTime(r.ts); if(!labelTs.has(l)) labelTs.set(l, r.ts); }));
  const labels = Array.from(labelTs.keys());
  window.__pingLabelTs = Array.from(labelTs.values());

  pingChart.data.labels = labels;
  pingChart.data.datasets = names.map((n,i) => ({
    label:`${getIcon(n)} ${n}`, data:data[n].map(r=>({x:fmtTime(r.ts), y:r.latency})),
    borderColor:COLORS[i%COLORS.length], backgroundColor:hexToRgba(COLORS[i%COLORS.length],.12),
    fill:true, tension:.35, pointRadius:0, borderWidth:2.25
  }));
  pingChart.update();

  jitterChart.data.labels = labels;
  jitterChart.data.datasets = names.map((n,i) => ({
    label:`${getIcon(n)} ${n}`, data:data[n].map(r=>({x:fmtTime(r.ts), y:r.jitter})),
    borderColor:COLORS[i%COLORS.length], backgroundColor:hexToRgba(COLORS[i%COLORS.length],.12),
    fill:true, tension:.35, pointRadius:0, borderWidth:2.25
  }));
  jitterChart.update();
}

async function loadLossChart(){
  const data = await getJSON(`/api/loss/history?range=${currentRange}`);
  const names = Object.keys(data);
  const buckets = 20;
  const datasets = names.map((n,i) => {
    const rows = data[n];
    const chunk = Math.max(1, Math.floor(rows.length / buckets));
    const points = [];
    for(let j=0;j<rows.length;j+=chunk){
      const slice = rows.slice(j, j+chunk);
      const lossAvg = slice.length ? slice.reduce((s,r) => s + (r.loss_pct != null ? r.loss_pct : (r.success ? 0 : 100)), 0) / slice.length : 0;
      points.push({x: fmtTime(slice[0].ts), y: Math.round(lossAvg*100)/100});
    }
    return {label:`${getIcon(n)} ${n}`, data:points, backgroundColor:hexToRgba(COLORS[i%COLORS.length],.65), borderRadius:3, borderSkipped:false};
  });
  lossChart.data.datasets = datasets;
  lossChart.data.labels = datasets[0] ? datasets[0].data.map(p=>p.x) : [];
  lossChart.update();
}

const ICON_RULES = [
  { match: /google/i, icon: '🔍' },
  { match: /cloudflare/i, icon: '☁️' },
  { match: /quad9/i, icon: '🛡️' },
  { match: /instagram/i, icon: '📷' },
  { match: /facebook/i, icon: '📘' },
  { match: /whatsapp/i, icon: '💬' },
  { match: /(twitter|\bx\.com)/i, icon: '🐦' },
  { match: /tiktok/i, icon: '🎵' },
  { match: /youtube/i, icon: '▶️' },
  { match: /netflix/i, icon: '🎬' },
  { match: /discord/i, icon: '🎮' },
  { match: /steam/i, icon: '🕹️' },
  { match: /valorant|riot/i, icon: '🎯' },
  { match: /(mikrotik|routeros)/i, icon: '📡' },
  { match: /(gateway|router|onu|olt)/i, icon: '🌐' },
  { match: /(vps|server|servidor)/i, icon: '🖥️' },
  { match: /(nas)/i, icon: '💾' },
];
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function getIcon(name, host){
  const hay = `${name || ''} ${host || ''}`;
  for(const r of ICON_RULES){ if(r.match.test(hay)) return r.icon; }
  if(host && PRIVATE_IP.test(host)) return '🖥️';
  if(host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) return '🌐';
  return '🌐';
}

const BRAND_RULES = [
  { match: /google/i, key: 'google' },
  { match: /cloudflare/i, key: 'cloudflare' },
  { match: /quad9/i, key: 'shield' },
  { match: /instagram/i, key: 'instagram' },
  { match: /facebook/i, key: 'facebook' },
  { match: /whatsapp/i, key: 'whatsapp' },
  { match: /(twitter|\bx\.com)/i, key: 'x' },
  { match: /tiktok/i, key: 'tiktok' },
  { match: /youtube/i, key: 'youtube' },
  { match: /netflix/i, key: 'netflix' },
  { match: /discord/i, key: 'discord' },
  { match: /steam/i, key: 'steam' },
  { match: /valorant/i, key: 'valorant' },
  { match: /riot/i, key: 'riotgames' },
  { match: /(mikrotik|routeros)/i, key: 'mikrotik' },
  { match: /(gateway|router|onu|olt)/i, key: 'gateway' },
  { match: /(vps|server|servidor)/i, key: 'server' },
  { match: /(nas)/i, key: 'nas' },
];

function getIconHtml(name, host){
  const hay = `${name || ''} ${host || ''}`;
  let key = null;
  for(const r of BRAND_RULES){ if(r.match.test(hay)){ key = r.key; break; } }
  if(!key){
    key = (host && PRIVATE_IP.test(host)) ? 'server' : 'globe';
  }
  const svg = (typeof BRAND_ICONS !== 'undefined' && BRAND_ICONS[key]) ? BRAND_ICONS[key] : '';
  return `<span class="icon-badge">${svg}</span>`;
}

async function loadTargets(){
  const [rows, spark] = await Promise.all([
    getJSON('/api/targets'), getJSON('/api/sparklines').catch(() => ({}))]);
  const tbody = document.getElementById('targetsBody');
  tbody.classList.remove('is-loading');
  if(!rows.length){
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhum destino cadastrado. Adicione em Configurações → Destinos.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="name-cell">${getIconHtml(r.name, r.host)} ${esc(r.name)}</td>
      <td>${esc(r.host)}</td>
      <td><span class="status-pill ${r.online ? 'online':'offline'}">${r.online ? '▲ Online':'▼ Offline'}</span></td>
      <td>${r.latency != null ? r.latency.toFixed(0)+' ms' : '-'}</td>
      <td>${r.jitter != null ? r.jitter.toFixed(0)+' ms' : '-'}</td>
      <td>${r.loss_pct != null ? r.loss_pct+'%' : '-'}</td>
      <td>${r.uptime_24h != null ? r.uptime_24h+'%' : '-'}</td>
      <td class="spark-cell">${sparkSvg(spark[r.name])}</td>
    </tr>`).join('');
}

async function loadDns(){
  const rows = await getJSON('/api/dns');
  const el = document.getElementById('dnsList');
  el.innerHTML = rows.map(r => {
    const cls = r.latency > 150 ? 'bad' : (r.latency > 80 ? 'high' : '');
    return `<div class="dns-item"><span>${esc(r.name)}</span><span class="lat ${cls}">${r.latency != null ? r.latency.toFixed(0)+' ms' : '-'}</span></div>`;
  }).join('');
}

function iconForMessage(msg){
  return getIconHtml(msg, '');
}

function fmtBps(bps){
  if(bps == null) return '--';
  if(bps >= 1_000_000) return (bps/1_000_000).toFixed(1) + ' Mbps';
  if(bps >= 1_000) return (bps/1_000).toFixed(0) + ' Kbps';
  return Math.round(bps) + ' bps';
}

function fmtUptime(seconds){
  if(seconds == null) return '--';
  const d = Math.floor(seconds/86400), h = Math.floor((seconds%86400)/3600), m = Math.floor((seconds%3600)/60);
  if(d) return `${d}d ${h}h`;
  if(h) return `${h}h ${m}m`;
  return `${m}m`;
}

async function loadMikrotikStatus(){
  const s = await getJSON('/api/mikrotik/status');
  const dot = document.getElementById('dotMikrotik');
  const body = document.getElementById('mikrotikBody');
  const offline = document.getElementById('mikrotikOffline');

  if(!s.enabled || !s.ts){
    body.classList.add('hidden');
    offline.classList.remove('hidden');
    dot.className = 'dot';
    return;
  }
  body.classList.remove('hidden');
  offline.classList.add('hidden');
  dot.className = 'dot ' + (s.stale ? 'offline' : 'online');

  document.getElementById('mkBoard').textContent = s.board_name || '--';
  document.getElementById('mkVersion').textContent = s.version || '--';
  document.getElementById('mkUptime').textContent = fmtUptime(s.uptime_s);
  document.getElementById('mkCpu').textContent = (s.cpu_load ?? '--') + '%';
  setBar(document.getElementById('mkBarCpu'), s.cpu_load, 'cpu', 70, 90);
  document.getElementById('mkMem').textContent = (s.mem_pct ?? '--') + '%';
  setBar(document.getElementById('mkBarMem'), s.mem_pct, 'mem', 75, 90);

  const tempRow = document.getElementById('mkTempRow');
  if(s.temperature != null){
    tempRow.classList.remove('hidden');
    document.getElementById('mkTemp').textContent = s.temperature + '°C';
  } else {
    tempRow.classList.add('hidden');
  }
}

// Ordem física das portas do hAP ax2 (internet, 2, 3, 4, 5) mapeada pros
// nomes que o RouterOS expõe em /interface. Ajuste aqui se o seu device
// renomeou as portas (ex: "ether1-gateway").
const MK_PORT_ORDER = ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'];

function renderMikrotikPortPanel(allRows){
  const byName = Object.fromEntries(allRows.map(r => [r.name, r]));
  document.querySelectorAll('.mk-port-box').forEach(box => {
    const idx = Number(box.dataset.portIndex);
    const portName = MK_PORT_ORDER[idx];
    const row = byName[portName];
    box.classList.remove('online', 'offline');
    if(row) box.classList.add(row.running ? 'online' : 'offline');
  });
}

async function loadMikrotikInterfaces(){
  const allRows = await getJSON('/api/mikrotik/interfaces');
  renderMikrotikPortPanel(allRows);
  const body = document.getElementById('mikrotikIfaceBody');
  const select = document.getElementById('mikrotikIfaceSelect');
  const toggleBtn = document.getElementById('mkToggleDisabled');

  const activeRows = allRows.filter(r => r.running || !r.disabled);
  const disabledCount = allRows.length - activeRows.length;
  toggleBtn.textContent = mikrotikShowDisabled
    ? `Ocultar desabilitadas (${disabledCount})`
    : `Mostrar desabilitadas (${disabledCount})`;
  toggleBtn.classList.toggle('hidden', disabledCount === 0);

  const rows = (mikrotikShowDisabled ? allRows : activeRows)
    .slice()
    .sort((a, b) => (b.running - a.running) || ((b.rx_bps + b.tx_bps) - (a.rx_bps + a.tx_bps)));

  body.innerHTML = rows.map(r => `
    <tr data-iface="${esc(r.name)}" class="${r.name === mikrotikSelectedIface ? 'iface-active' : ''} ${r.disabled ? 'iface-disabled' : ''}">
      <td>${esc(r.name)}</td>
      <td><span class="dot ${r.running ? 'online' : 'offline'}"></span></td>
      <td>${fmtBps(r.rx_bps)}</td>
      <td>${fmtBps(r.tx_bps)}</td>
    </tr>`).join('') || '<tr><td colspan="4">Nenhuma interface encontrada.</td></tr>';

  body.querySelectorAll('tr[data-iface]').forEach(tr => {
    tr.addEventListener('click', () => {
      mikrotikSelectedIface = tr.dataset.iface;
      select.value = mikrotikSelectedIface;
      body.querySelectorAll('tr').forEach(t => t.classList.remove('iface-active'));
      tr.classList.add('iface-active');
      loadMikrotikIfaceChart();
    });
  });

  const runningRows = allRows.filter(r => r.running);
  document.getElementById('mkTotalRx').textContent = fmtBps(runningRows.reduce((sum, r) => sum + (r.rx_bps || 0), 0));
  document.getElementById('mkTotalTx').textContent = fmtBps(runningRows.reduce((sum, r) => sum + (r.tx_bps || 0), 0));
  document.getElementById('mkIfaceCount').textContent = runningRows.length;

  const currentNames = allRows.map(r => r.name);
  const selectNames = Array.from(select.options).map(o => o.value);
  if(JSON.stringify(currentNames) !== JSON.stringify(selectNames)){
    select.innerHTML = allRows.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  }
  if(!mikrotikSelectedIface && rows.length){
    mikrotikSelectedIface = rows[0].name;
  }
  if(mikrotikSelectedIface) select.value = mikrotikSelectedIface;
}

document.getElementById('mkToggleDisabled').addEventListener('click', () => {
  mikrotikShowDisabled = !mikrotikShowDisabled;
  loadMikrotikInterfaces();
});

async function loadMikrotikIfaceChart(){
  if(!mikrotikSelectedIface || !mikrotikIfaceChart) return;
  const data = await getJSON(`/api/mikrotik/history?range=${currentRange}&iface=${encodeURIComponent(mikrotikSelectedIface)}`);
  const points = data.points || [];
  mikrotikIfaceChart.data.labels = points.map(p => fmtTime(p.ts));
  mikrotikIfaceChart.data.datasets = [
    {label:'↓ RX', data: points.map(p => ({x:fmtTime(p.ts), y: p.rx_bps/1000})), borderColor:'#3ba3ff', backgroundColor:hexToRgba('#3ba3ff',.12), fill:true, tension:.35, pointRadius:0, borderWidth:2.25},
    {label:'↑ TX', data: points.map(p => ({x:fmtTime(p.ts), y: p.tx_bps/1000})), borderColor:'#ff9d3b', backgroundColor:hexToRgba('#ff9d3b',.12), fill:true, tension:.35, pointRadius:0, borderWidth:2.25},
  ];
  mikrotikIfaceChart.update();
}

document.getElementById('mikrotikIfaceSelect').addEventListener('change', e => {
  mikrotikSelectedIface = e.target.value;
  loadMikrotikIfaceChart();
});

async function loadMikrotik(){
  await loadMikrotikStatus();
  await loadMikrotikInterfaces();
  await loadMikrotikIfaceChart();
}

async function loadEvents(){
  const rows = await getJSON('/api/events?limit=30');
  const el = document.getElementById('eventsList');
  el.innerHTML = rows.map(r => `
    <div class="event-item">
      <span class="event-time">${fmtTime(r.ts)}</span>
      <span class="event-msg">${iconForMessage(r.message)} ${esc(r.message)}</span>
      <span class="sev ${esc(r.severity)}">${esc(r.severity)}</span>
    </div>`).join('');
}

async function loadIncidents(){
  const rows = await getJSON('/api/incidents?active_only=true');
  document.getElementById('incidentCount').textContent = rows.length;
  const el = document.getElementById('incidentsList');
  if(rows.length === 0){
    el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Nenhum incidente ativo</div>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="incident-item">
      <span>${iconForMessage(r.target + ' ' + r.message)} ${esc(r.message)}</span>
      <span class="sev ${esc(r.severity)}">${esc(r.severity)}</span>
    </div>`).join('');
}

async function loadIncidentsSummary(){
  const d = await getJSON('/api/incidents/summary?days=7');
  const labels = Object.keys(d);
  const values = Object.values(d);
  const colorMap = {Alta:'#ff5c5c', Media:'#ffb23d', Baixa:'#4d8dff', Info:'#8a63ff'};
  incidentsDonut.data.labels = labels;
  incidentsDonut.data.datasets = [{data:values, backgroundColor:labels.map(l=>colorMap[l])}];
  incidentsDonut.update();
}

