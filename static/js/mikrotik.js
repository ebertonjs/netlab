// ---------- MikroTik / DHCP ----------
async function loadMikrotikSettings(){
  const d = await getJSON('/api/settings/mikrotik');
  const f = document.getElementById('formMikrotik');
  f.elements['enabled'].checked = !!d.enabled;
  f.elements['host'].value = d.host || '';
  f.elements['port'].value = d.port || 443;
  f.elements['use_https'].checked = !!d.use_https;
  f.elements['verify_ssl'].checked = !!d.verify_ssl;
  f.elements['username'].value = d.username || '';
  f.elements['password'].value = d.password || '';
  f.elements['sync_interval_seconds'].value = d.sync_interval_seconds || 60;
}

document.getElementById('formMikrotik').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    enabled: f.get('enabled') === 'on',
    host: f.get('host') || '',
    port: parseInt(f.get('port')) || 443,
    use_https: f.get('use_https') === 'on',
    verify_ssl: f.get('verify_ssl') === 'on',
    username: f.get('username') || '',
    password: f.get('password') || '',
    sync_interval_seconds: parseInt(f.get('sync_interval_seconds')) || 60,
  };
  if(body.enabled && !body.host.trim()){
    showToast('Informe o host/IP do MikroTik para ativar.', 'error');
    return;
  }
  const r = await fetch('/api/settings/mikrotik', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao salvar', 'error'); return; }
  showToast('Configuração do MikroTik salva.');
  await loadMikrotikSettings();
});

document.getElementById('testMikrotikBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testMikrotikBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Testando...';
  try{
    const r = await fetch('/api/settings/mikrotik/test', {method:'POST'});
    const j = await r.json();
    if(r.ok){ showToast(`Conectado! ${j.leases_found} lease(s) encontrada(s).`); await loadDhcpHosts(); }
    else { showToast(j.detail || 'Falha na conexão', 'error'); }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

function fmtRelativeTime(ts){
  if(!ts) return '-';
  const diff = Date.now()/1000 - ts;
  if(diff < 90) return 'agora mesmo';
  if(diff < 3600) return `${Math.round(diff/60)} min atrás`;
  if(diff < 86400) return `${Math.round(diff/3600)}h atrás`;
  return `${Math.round(diff/86400)}d atrás`;
}

async function loadDhcpHosts(){
  const rows = await getJSON('/api/dhcp/hosts');
  const el = document.getElementById('dhcpHostsList');
  if(rows.length === 0){
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;">Nenhum dispositivo descoberto ainda. Configure e teste a conexão com o MikroTik acima.</div>';
    return;
  }
  el.innerHTML = rows.map(h => {
    const label = h.hostname || h.ip || h.mac;
    const statusDot = h.active ? 'online' : 'offline';
    const promoted = h.promoted_target;
    return `
      <div class="settings-item dhcp-item">
        <span class="dhcp-item-main">
          <span class="dot ${statusDot}" style="margin-right:4px;"></span>
          ${esc(label)} <span class="parent-hint">${esc(h.ip || '')} · ${esc(h.mac)}</span>
        </span>
        ${promoted
          ? `<span class="parent-hint">✅ monitorado como "${esc(promoted)}"</span>`
          : `<button type="button" class="promote-btn" data-id="${h.id}" data-suggested="${esc(label)}">+ Promover</button>`}
      </div>`;
  }).join('');
}

document.getElementById('dhcpHostsList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.promote-btn');
  if(!btn) return;
  const suggested = btn.dataset.suggested;
  const name = prompt('Nome do destino monitorado:', suggested);
  if(!name || !name.trim()) return;
  const targets = await getJSON('/api/settings');
  const parentNames = targets.targets.map(t => t.name).join(', ');
  let parent = '';
  if(targets.targets.length){
    parent = prompt(`Conectar a qual destino? (deixe em branco para "Rede local")\nOpções: ${parentNames}`, '') || '';
  }
  const r = await fetch(`/api/dhcp/hosts/${btn.dataset.id}/promote`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: name.trim(), parent: parent.trim() || null})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao promover', 'error'); return; }
  await loadDhcpHosts();
  await loadSettings();
  await refreshTopologyData();
  showToast(`"${name.trim()}" agora é um destino monitorado.`);
});

