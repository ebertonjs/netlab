async function loadSettings(){
  const d = await getJSON('/api/settings');

  document.getElementById('listTargets').innerHTML = d.targets.map(t => `
    <div class="settings-item">
      <span>${getIconHtml(t.name, t.host)} ${esc(t.name)} — ${esc(t.host)}${t.type && t.type !== 'icmp' ? ` <span class="type-tag">${esc(t.type)}${t.port ? ':' + esc(t.port) : ''}</span>` : ''}${t.parent ? ` <span class="parent-hint">↳ conectado a ${esc(t.parent)}</span>` : ''}</span>
      <button data-kind="target" data-name="${esc(t.name)}" title="Remover">✕</button>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px;">Nenhum destino cadastrado</div>';

  const parentSelect = document.getElementById('targetParentSelect');
  const currentParentValue = parentSelect.value;
  parentSelect.innerHTML = '<option value="">🌐 Rede local (raiz)</option>' +
    d.targets.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  if(d.targets.some(t => t.name === currentParentValue)) parentSelect.value = currentParentValue;

  document.getElementById('listDns').innerHTML = d.dns_servers.map(s => `
    <div class="settings-item">
      <span>${esc(s.name)} — ${esc(s.ip)}</span>
      <button data-kind="dns" data-name="${esc(s.name)}" title="Remover">✕</button>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px;">Nenhum servidor DNS cadastrado</div>';
}

async function handleSettingsClick(e){
  const btn = e.target.closest('button[data-kind]');
  if(!btn) return;
  const kind = btn.dataset.kind;
  if(!confirm(`Remover "${btn.dataset.name}"?`)) return;
  try{
    if(kind === 'target'){
      await fetch(`/api/settings/targets/${encodeURIComponent(btn.dataset.name)}`, {method:'DELETE'});
    } else if(kind === 'dns'){
      await fetch(`/api/settings/dns/${encodeURIComponent(btn.dataset.name)}`, {method:'DELETE'});
    }
    await loadSettings();
    await refreshTopologyData();
    showToast(`"${btn.dataset.name}" removido.`);
  }catch(err){ showToast('Erro ao remover: ' + err, 'error'); }
}

document.getElementById('listTargets').addEventListener('click', handleSettingsClick);
document.getElementById('listDns').addEventListener('click', handleSettingsClick);

document.getElementById('formTarget').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const hostInput = e.target.elements['host'];
  const ttype = f.get('type') || 'icmp';
  const hostOk = ttype === 'http' ? /^https?:\/\/\S+$/i.test(f.get('host') || '') : isValidHost(f.get('host'));
  if(!hostOk){
    markFieldValidity(hostInput, false, ttype === 'http' ? 'URL inválida' : 'IP ou host inválido');
    showToast(ttype === 'http' ? 'Informe uma URL http(s) válida.' : 'Informe um IP ou host válido.', 'error');
    return;
  }
  markFieldValidity(hostInput, true);
  const payload = {name:f.get('name'), host:f.get('host'), parent: f.get('parent') || null, type: ttype};
  if(ttype === 'tcp') payload.port = parseInt(f.get('port')) || null;
  if(ttype === 'http' && f.get('expect_status')) payload.expect_status = parseInt(f.get('expect_status'));
  const sitesTxt = (f.get('sites') || '').split(',').map(s => s.trim()).filter(Boolean);
  if(sitesTxt.length) payload.sites = sitesTxt;
  const r = await fetch('/api/settings/targets', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao adicionar', 'error'); return; }
  e.target.reset();
  await loadSettings();
  await refreshTopologyData();
  showToast(`Destino "${f.get('name')}" adicionado.`);
});

(function(){
  const sel = document.getElementById('targetTypeSelect');
  if(!sel) return;
  const upd = () => {
    document.querySelectorAll('#formTarget .x-tcp').forEach(el => el.classList.toggle('hidden', sel.value !== 'tcp'));
    document.querySelectorAll('#formTarget .x-http').forEach(el => el.classList.toggle('hidden', sel.value !== 'http'));
  };
  sel.addEventListener('change', upd); upd();
})();

document.getElementById('formDns').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const ipInput = e.target.elements['ip'];
  if(!isValidHost(f.get('ip'))){
    markFieldValidity(ipInput, false, 'IP inválido');
    showToast('Informe um IP válido.', 'error');
    return;
  }
  markFieldValidity(ipInput, true);
  const r = await fetch('/api/settings/dns', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:f.get('name'), ip:f.get('ip')})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao adicionar', 'error'); return; }
  e.target.reset();
  await loadSettings();
  showToast(`Servidor DNS "${f.get('name')}" adicionado.`);
});

function applyAppName(name, version){
  window.APP_NAME = name;
  try{ localStorage.setItem('netnoc_app_name', name); }catch(_){ /* ok */ }
  document.title = `${name} - Monitoramento de Rede`;
  document.querySelectorAll('[data-appname]').forEach(el => { el.textContent = name; });
  document.dispatchEvent(new CustomEvent('netnoc:appname', {detail: name}));
  document.getElementById('brandName').textContent = `🛰 ${name}`;
  if(version){
    document.getElementById('brandVersion').textContent = `v${version}`;
    document.getElementById('versionDisplay').textContent = `v${version}`;
  }
}

async function loadAppName(){
  const d = await getJSON('/api/settings/appname');
  applyAppName(d.name, d.version);
  document.getElementById('appNameInput').value = d.name;
}

document.getElementById('formAppName').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = f.get('app_name').trim();
  if(!name) return;
  const r = await fetch('/api/settings/appname', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao salvar', 'error'); return; }
  const j = await r.json();
  applyAppName(name, j.version);
  showToast('Nome da aplicação atualizado.');
});

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if(!confirm('Isso vai apagar TODO o histórico (pings, DNS, incidentes, eventos, speedtests). Confirmar?')) return;
  await fetch('/api/history/clear', {method:'POST'});
  await refreshAll();
  showToast('Histórico limpo.');
});

async function loadAvailability(){
  const data = await getJSON('/api/uptime/bars?hours=24');
  const el = document.getElementById('availabilityList');
  const names = Object.keys(data);
  if(names.length === 0){
    el.innerHTML = '<div class="insight-empty">Sem destinos cadastrados</div>';
    return;
  }
  el.innerHTML = names.map(name => {
    const bars = data[name];
    const okCount = bars.filter(b => b.pct != null).length;
    const avgPct = okCount ? (bars.reduce((s,b)=> s + (b.pct||0), 0) / okCount).toFixed(1) : '-';
    const barsHtml = bars.map(b => {
      let cls = 'nodata';
      if(b.pct != null){
        cls = b.pct >= 98 ? 'ok' : (b.pct >= 90 ? 'warn' : 'bad');
      }
      const label = b.pct != null ? `${fmtTime(b.ts)} — ${b.pct}%` : `${fmtTime(b.ts)} — sem dados`;
      return `<div class="avail-bar ${cls}" title="${esc(label)}"></div>`;
    }).join('');
    return `
      <div class="avail-row">
        <div class="avail-row-label"><span>${getIconHtml(name,'')} ${esc(name)}</span><span>${avgPct}%</span></div>
        <div class="avail-bars">${barsHtml}</div>
      </div>`;
  }).join('');
}

async function loadInsights(){
  const rows = await getJSON('/api/insights/patterns?days=30');
  const el = document.getElementById('insightsList');
  if(rows.length === 0){
    el.innerHTML = '<div class="insight-empty">Nenhum padrão relevante encontrado ainda (precisa de mais histórico).</div>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="insight-item">${getIconHtml(r.target,'')} ${esc(r.message)}</div>
  `).join('');
}

async function loadIntervalsSettings(){
  const d = await getJSON('/api/settings/intervals');
  const f = document.getElementById('formIntervals');
  for(const key of Object.keys(d)){
    if(f.elements[key]) f.elements[key].value = d[key];
  }
}

document.getElementById('formIntervals').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {};
  for(const [k,v] of f.entries()) body[k] = parseInt(v);
  const invalid = Object.entries(body).filter(([k,v]) => !Number.isFinite(v) || v <= 0);
  if(invalid.length){
    showToast('Os intervalos precisam ser números maiores que zero.', 'error');
    return;
  }
  await fetch('/api/settings/intervals', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  showToast('Intervalos salvos. Passam a valer no próximo ciclo de cada worker.');
});

async function loadTelegramSettings(){
  const d = await getJSON('/api/settings/telegram');
  const f = document.getElementById('formTelegram');
  f.elements['enabled'].checked = !!d.enabled;
  f.elements['bot_token'].value = d.bot_token || '';
  f.elements['chat_id'].value = d.chat_id || '';
  f.elements['min_severity'].value = d.min_severity || 'Alta';
}

document.getElementById('formTelegram').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const enabled = f.get('enabled') === 'on';
  const bot_token = f.get('bot_token') || '';
  const chat_id = f.get('chat_id') || '';
  if(enabled && (!bot_token.trim() || !chat_id.trim())){
    showToast('Preencha Bot Token e Chat ID para ativar os alertas.', 'error');
    return;
  }
  const body = {
    enabled, bot_token, chat_id,
    min_severity: f.get('min_severity')
  };
  const r = await fetch('/api/settings/telegram', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if(!r.ok){
    let msg = 'Não foi possível salvar o Telegram';
    try{ const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : msg; }catch(_){ /* ok */ }
    showToast(msg, 'error');
    return;
  }
  showToast('Configuração do Telegram salva.');
  await loadTelegramSettings();
});

document.getElementById('testTelegramBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testTelegramBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Enviando...';
  try{
    const r = await fetch('/api/settings/telegram/test', {method:'POST'});
    if(r.ok){ showToast('Mensagem de teste enviada! Confira o Telegram.'); }
    else { const j = await r.json(); showToast(j.detail || 'Não foi possível enviar', 'error'); }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

