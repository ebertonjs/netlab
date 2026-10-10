// ---------- AdGuard Home ----------
async function loadAghStatus(){
  const s = await getJSON('/api/agh/status');
  const dot = document.getElementById('dotAgh');
  const body = document.getElementById('aghBody');
  const offline = document.getElementById('aghOffline');

  if(!s.enabled){
    body.classList.add('hidden');
    offline.classList.remove('hidden');
    dot.className = 'dot';
    return;
  }
  body.classList.remove('hidden');
  offline.classList.add('hidden');
  dot.className = 'dot ' + (s.online ? 'online' : 'offline');

  document.getElementById('aghProtection').textContent = s.protection_enabled ? 'Ativa' : 'Desativada';
  document.getElementById('aghVersion').textContent = s.version || '--';

  const stats = await getJSON('/api/agh/stats');
  document.getElementById('aghQueries').textContent = stats.num_dns_queries ?? '--';
  document.getElementById('aghBlocked').textContent = stats.num_blocked_filtering ?? '--';
  document.getElementById('aghBlockedPct').textContent = (stats.blocked_pct ?? 0) + '%';
  setBar(document.getElementById('aghBarBlocked'), stats.blocked_pct, 'cpu', 20, 40);
}

async function loadAghChart(){
  if(!aghChart) return;
  const data = await getJSON(`/api/agh/history?range=${currentRange}`);
  aghChart.data.labels = data.map(p => fmtTime(p.ts));
  aghChart.data.datasets = [
    { label: 'Consultas', data: data.map(p => p.num_dns_queries), borderColor: '#5b9dff' },
    { label: 'Bloqueadas', data: data.map(p => p.num_blocked_filtering), borderColor: '#ff5b7a' },
  ];
  aghChart.update();
}

async function loadAgh(){
  await loadAghStatus();
  await loadAghChart();
}

async function loadAghSettings(){
  const d = await getJSON('/api/settings/agh');
  const f = document.getElementById('formAgh');
  f.elements.enabled.checked = !!d.enabled;
  f.elements.host.value = d.host || '';
  f.elements.port.value = d.port || 3000;
  f.elements.use_https.checked = !!d.use_https;
  f.elements.username.value = d.username || '';
  f.elements.password.value = d.password || '';
  f.elements.sync_interval_seconds.value = d.sync_interval_seconds || 60;
}

document.getElementById('formAgh').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    enabled: f.elements.enabled.checked,
    host: f.elements.host.value.trim(),
    port: parseInt(f.elements.port.value) || 3000,
    use_https: f.elements.use_https.checked,
    username: f.elements.username.value.trim(),
    password: f.elements.password.value,
    sync_interval_seconds: parseInt(f.elements.sync_interval_seconds.value) || 60,
  };
  if(payload.enabled && !payload.host){
    showToast('Informe o host/IP do AdGuard Home para ativar.', 'error');
    return;
  }
  const r = await fetch('/api/settings/agh', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao salvar', 'error'); return; }
  showToast('Configuração do AdGuard Home salva.');
  await loadAghSettings();
  await loadAgh();
});

document.getElementById('testAghBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testAghBtn');
  btn.disabled = true; btn.textContent = 'Testando...';
  try {
    const r = await fetch('/api/settings/agh/test', {method:'POST'});
    const j = await r.json();
    if(r.ok){ showToast(`Conectado! Versão ${j.version || '--'}.`); await loadAgh(); }
    else { showToast(j.detail || 'Falha ao conectar', 'error'); }
  } finally {
    btn.disabled = false; btn.textContent = 'Testar Conexão';
  }
});

async function refreshAll(){
  await Promise.all([
    loadOverview(), loadPingCharts(), loadLossChart(), loadTargets(),
    loadDns(), loadEvents(), loadIncidents(), loadIncidentsSummary(),
    loadAvailability(), loadInsights(), loadIncidentBanner(), loadMikrotik(), loadAgh()
  ]);
  const currentPage = document.querySelector('.page.active')?.dataset.page;
  if(currentPage === 'topologia' && typeof refreshTopologyData === 'function'){
    refreshTopologyData();
  }
  if(currentPage === 'config' && document.querySelector('.config-tab-panel[data-tab-panel="mikrotik"]')?.classList.contains('active')){
    loadDhcpHosts();
  }
}

document.getElementById('rangeSelect').addEventListener('change', e => {
  currentRange = e.target.value;
  loadPingCharts(); loadLossChart(); loadMikrotikIfaceChart(); loadAghChart();
});

document.getElementById('runSpeedtest').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Testando...';
  await getJSON('/api/speedtest/run', {method:'POST'});
  await loadOverview();
  e.target.disabled = false; e.target.textContent = 'Executar Teste';
});

window.addEventListener('load', () => {
  pingChart = makeChart(document.getElementById('pingChart'), baseChartOpts('ms'));
  jitterChart = makeChart(document.getElementById('jitterChart'), baseChartOpts('ms'));
  lossChart = new Chart(document.getElementById('lossChart'), {
    type:'bar', data:{datasets:[]}, options: baseChartOpts('%')
  });
  incidentsDonut = new Chart(document.getElementById('incidentsDonut'), {
    type:'doughnut',
    data:{labels:[], datasets:[]},
    options:{plugins:{legend:{position:'bottom', labels:{color:'#8891ab'}}}}
  });
  mikrotikIfaceChart = makeChart(document.getElementById('mikrotikIfaceChart'), baseChartOpts('kbps'));
  aghChart = makeChart(document.getElementById('aghChart'), baseChartOpts('queries'));
  initWidgetAppearance();
  refreshAll();
  loadSettings();
  loadIntervalsSettings();
  loadTelegramSettings();
  loadMikrotikSettings();
  loadDhcpHosts();
  loadAghSettings();
  loadAppName();
  let __tick = 0;
  setInterval(() => { if(!window.__sseOk || (++__tick % 3) === 0) refreshAll(); }, 5000);
});
