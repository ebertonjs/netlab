// Novas abas de Configurações: Notificações (+manutenção), SNMP, Zabbix e Segurança.
(function () {
  const MASK = '••••••••';
  function field(label, input, hint) {
    return h('div', {class: 'field'}, h('label', {}, label), input, hint ? h('div', {class: 'hint', text: hint}) : null);
  }
  function inp(name, type, ph, val) {
    const i = h('input', {name: name, type: type || 'text', placeholder: ph || '', autocomplete: 'off'});
    if (val != null) i.value = val;
    return i;
  }
  function check(name, label, on) {
    const c = h('input', {name: name, type: 'checkbox'}); c.checked = !!on;
    return h('label', {class: 'chk'}, c, ' ' + label);
  }
  function msg(text, err) { showToast(text, err ? 'error' : 'success'); }
  function addTab(id, label, panel) {
    const tabs = document.querySelector('.config-tabs');
    const tab = h('button', {type: 'button', class: 'config-tab', 'data-tab': id, text: label});
    tabs.append(tab);
    panel.classList.add('config-tab-panel'); panel.dataset.tabPanel = id;
    const last = document.querySelector('.config-tab-panel:last-of-type') || document.querySelector('.config-tab-panel');
    document.querySelectorAll('.config-tab-panel')[document.querySelectorAll('.config-tab-panel').length - 1].after(panel);
    tab.addEventListener('click', () => {
      document.querySelectorAll('.config-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.config-tab-panel').forEach(p => p.classList.toggle('active', p === panel));
      try { localStorage.setItem('netnoc_config_tab', id); } catch (e) { /* ok */ }
      if (panel._onShow) panel._onShow();
    });
    return tab;
  }
  const num = v => (v === '' || v == null ? null : Number(v));

  // ------------------------------------------------------------- Notificações
  function buildNotify() {
    const f = h('form', {class: 'x-form', id: 'formNotify'});
    const dis = h('div', {class: 'x-sub'}, h('h4', {text: 'Discord'}), check('d_enabled', 'Ativar'),
      field('URL do webhook', inp('d_url', 'password', 'https://discord.com/api/webhooks/…')),
      h('button', {type: 'button', class: 'mini-btn', text: 'Testar', 'data-test': 'discord'}));
    const wh = h('div', {class: 'x-sub'}, h('h4', {text: 'Webhook genérico (JSON)'}), check('w_enabled', 'Ativar'),
      field('URL', inp('w_url', 'text', 'https://…')),
      field('Segredo HMAC', inp('w_secret', 'password', 'opcional'), 'Assinatura no cabeçalho X-NetNOC-Signature: sha256=…'),
      h('button', {type: 'button', class: 'mini-btn', text: 'Testar', 'data-test': 'webhook'}));
    const em = h('div', {class: 'x-sub'}, h('h4', {text: 'E-mail (SMTP)'}), check('e_enabled', 'Ativar'),
      h('div', {class: 'x-row'}, field('Servidor', inp('e_host', 'text', 'smtp.exemplo.com')), field('Porta', inp('e_port', 'number', '587', 587))),
      h('div', {class: 'x-row'}, field('Usuário', inp('e_user')), field('Senha', inp('e_pass', 'password'))),
      h('div', {class: 'x-row'}, field('Remetente', inp('e_from', 'text', 'noc@exemplo.com')), field('Destinatário(s)', inp('e_to', 'text', 'a@x.com, b@x.com'))),
      check('e_tls', 'STARTTLS (porta 465 usa SSL direto)', true),
      h('button', {type: 'button', class: 'mini-btn', text: 'Testar', 'data-test': 'email'}));
    const tg = h('div', {class: 'x-sub'}, h('h4', {text: 'Telegram'}), h('p', {class: 'hint', text: 'Configurado na aba Alertas.'}),
      h('button', {type: 'button', class: 'mini-btn', text: 'Testar', 'data-test': 'telegram'}));
    const sev = h('select', {name: 'min_severity'}, ['Alta', 'Media', 'Baixa', 'Info'].map(s => h('option', {value: s, text: s})));
    f.append(field('Severidade mínima (Discord / webhook / e-mail)', sev), dis, wh, em, tg,
      h('button', {type: 'submit', class: 'admin-only', text: 'Salvar notificações'}));
    const el = f.elements;
    async function load() {
      try {
        const c = await apiJSON('GET', '/api/settings/notify');
        sev.value = c.min_severity;
        el.d_enabled.checked = c.discord.enabled; el.d_url.value = c.discord.webhook_url;
        el.w_enabled.checked = c.webhook.enabled; el.w_url.value = c.webhook.url; el.w_secret.value = c.webhook.secret;
        el.e_enabled.checked = c.email.enabled; el.e_host.value = c.email.host; el.e_port.value = c.email.port;
        el.e_user.value = c.email.user; el.e_pass.value = c.email.password; el.e_from.value = c.email.sender;
        el.e_to.value = c.email.to; el.e_tls.checked = c.email.starttls;
      } catch (e) { /* viewer */ }
    }
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        await apiJSON('POST', '/api/settings/notify', {min_severity: sev.value,
          discord: {enabled: el.d_enabled.checked, webhook_url: el.d_url.value},
          webhook: {enabled: el.w_enabled.checked, url: el.w_url.value, secret: el.w_secret.value},
          email: {enabled: el.e_enabled.checked, host: el.e_host.value, port: Number(el.e_port.value) || 587, user: el.e_user.value,
            password: el.e_pass.value, sender: el.e_from.value, to: el.e_to.value, starttls: el.e_tls.checked}});
        msg('Notificações salvas.'); load();
      } catch (e) { msg(e.message, true); }
    });
    f.addEventListener('click', async ev => {
      const ch = ev.target.dataset && ev.target.dataset.test; if (!ch) return;
      ev.target.disabled = true;
      try { await apiJSON('POST', '/api/settings/notify/test/' + ch); msg('Teste enviado por ' + ch + '.'); }
      catch (e) { msg(e.message, true); }
      ev.target.disabled = false;
    });
    // manutenção
    const mList = h('div', {class: 'settings-list'});
    const mf = h('form', {class: 'settings-form x-form'},
      field('Nome', inp('m_name', 'text', 'Ex.: troca de switch')),
      field('Início', h('input', {name: 'm_start', type: 'datetime-local', required: true})),
      field('Fim', h('input', {name: 'm_end', type: 'datetime-local', required: true})),
      field('Alvos (vazio = todos)', h('select', {name: 'm_targets', multiple: true, size: 4})),
      h('button', {type: 'submit', class: 'admin-only', text: '+ Agendar'}));
    async function loadMaint() {
      try {
        const [list, s] = await Promise.all([apiJSON('GET', '/api/maintenance'), apiJSON('GET', '/api/settings')]);
        mf.elements.m_targets.replaceChildren(...s.targets.map(t => h('option', {value: t.name, text: t.name})));
        mList.replaceChildren(...(list.length ? list.map(m => h('div', {class: 'settings-item'},
          h('span', {text: m.name + ' — ' + fmtDateTime(m.start) + ' → ' + fmtDateTime(m.end) + (m.targets.length ? ' [' + m.targets.join(', ') + ']' : ' [todos]')}),
          h('button', {type: 'button', title: 'Remover', class: 'admin-only', text: '✕', onclick: async () => {
            await apiJSON('DELETE', '/api/maintenance/' + m.id); loadMaint(); }}))) : [emptyState('Nenhuma janela agendada.')]));
      } catch (e) { /* ok */ }
    }
    mf.addEventListener('submit', async ev => {
      ev.preventDefault(); const e = mf.elements;
      try {
        await apiJSON('POST', '/api/maintenance', {name: e.m_name.value, start: new Date(e.m_start.value).getTime() / 1000,
          end: new Date(e.m_end.value).getTime() / 1000, targets: Array.from(e.m_targets.selectedOptions).map(o => o.value)});
        mf.reset(); msg('Janela agendada.'); loadMaint();
      } catch (er) { msg(er.message, true); }
    });
    const panel = h('div', {}, h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Canais de notificação'})), f),
      h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Janelas de manutenção (silenciam alertas)'})), mf, mList));
    panel._onShow = () => { load(); loadMaint(); };
    addTab('notif', '📣 Notificações', panel);
  }

  // ------------------------------------------------------------------- SNMP
  function buildSnmp() {
    let devices = [];
    const list = h('div', {class: 'settings-list'});
    const f = h('form', {class: 'x-form'});
    const ver = h('select', {name: 'version'}, ['2c', '1', '3'].map(v => h('option', {value: v, text: 'v' + v})));
    const v3 = h('div', {class: 'x-sub hidden'},
      h('div', {class: 'x-row'}, field('Usuário', inp('user')),
        field('Nível', h('select', {name: 'level'}, ['authPriv', 'authNoPriv', 'noAuthNoPriv'].map(v => h('option', {value: v, text: v}))))),
      h('div', {class: 'x-row'}, field('Autenticação', h('select', {name: 'auth_proto'}, ['SHA', 'MD5', 'SHA-256', 'SHA-512'].map(v => h('option', {value: v, text: v})))),
        field('Senha auth', inp('auth_pass', 'password'))),
      h('div', {class: 'x-row'}, field('Privacidade', h('select', {name: 'priv_proto'}, ['AES', 'DES', 'AES-192', 'AES-256'].map(v => h('option', {value: v, text: v})))),
        field('Senha priv', inp('priv_pass', 'password'))));
    const v2 = h('div', {class: 'x-sub'}, field('Community', inp('community', 'password')));
    ver.addEventListener('change', () => { v3.classList.toggle('hidden', ver.value !== '3'); v2.classList.toggle('hidden', ver.value === '3'); });
    const oids = h('textarea', {name: 'oids', rows: 4, placeholder: 'nome;oid;unidade;escala;min;max\nrx_olt;.1.3.6.1.4.1.2011.…;dBm;0.01;-28;-8'});
    f.append(h('div', {class: 'x-row'}, field('Nome', inp('name', 'text', 'OLT-Central')), field('Host', inp('host', 'text', '10.0.0.2')),
      field('Porta', inp('port', 'number', '161', 161)), field('Versão', ver), field('Intervalo (s)', inp('poll_seconds', 'number', '60', 60))),
      v2, v3, field('OIDs customizados', oids, 'Uma linha por OID. Limites min/max geram incidente.'),
      h('button', {type: 'submit', class: 'admin-only', text: 'Salvar dispositivo'}));
    function toForm(d) {
      const e = f.elements;
      ['name', 'host', 'port', 'poll_seconds', 'community', 'user', 'auth_pass', 'priv_pass'].forEach(k => { if (e[k]) e[k].value = d[k] != null ? d[k] : ''; });
      ['version', 'level', 'auth_proto', 'priv_proto'].forEach(k => { if (d[k]) e[k].value = d[k]; });
      e.oids.value = (d.oids || []).map(o => [o.name, o.oid, o.unit || '', o.scale != null ? o.scale : 1, o.min != null ? o.min : '', o.max != null ? o.max : ''].join(';')).join('\n');
      ver.dispatchEvent(new Event('change'));
    }
    function fromForm() {
      const e = f.elements, d = {name: e.name.value.trim(), host: e.host.value.trim(), port: Number(e.port.value) || 161,
        version: e.version.value, poll_seconds: Number(e.poll_seconds.value) || 60, oids: []};
      if (d.version === '3') Object.assign(d, {user: e.user.value, level: e.level.value, auth_proto: e.auth_proto.value,
        auth_pass: e.auth_pass.value, priv_proto: e.priv_proto.value, priv_pass: e.priv_pass.value});
      else d.community = e.community.value;
      e.oids.value.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
        const p = l.split(';').map(x => x.trim());
        d.oids.push({name: p[0], oid: p[1], unit: p[2] || '', scale: num(p[3]) == null ? 1 : num(p[3]), min: num(p[4]), max: num(p[5])});
      });
      return d;
    }
    async function save(newList, okMsg) {
      try { await apiJSON('POST', '/api/settings/snmp', newList); msg(okMsg); await load(); } catch (e) { msg(e.message, true); }
    }
    function render() {
      list.replaceChildren(...(devices.length ? devices.map(d => h('div', {class: 'settings-item'},
        h('span', {text: d.name + ' — ' + d.host + ':' + d.port + ' (v' + d.version + ', ' + (d.oids || []).length + ' OIDs)'}),
        h('span', {}, h('button', {type: 'button', class: 'mini-btn', text: 'Testar', onclick: async ev => {
            ev.target.disabled = true;
            try { const r = await apiJSON('POST', '/api/snmp/test/' + encodeURIComponent(d.name));
              msg(d.name + ': ' + (r.sysname || 'ok') + ', uptime ' + fmtDur(r.uptime_s)); } catch (e) { msg(e.message, true); }
            ev.target.disabled = false; }}),
          h('button', {type: 'button', class: 'mini-btn', text: 'Editar', onclick: () => toForm(d)}),
          h('button', {type: 'button', class: 'admin-only', title: 'Remover', text: '✕', onclick: () => {
            if (confirm('Remover ' + d.name + '?')) save(devices.filter(x => x.name !== d.name), 'Dispositivo removido.'); }})))) :
        [emptyState('Nenhum dispositivo SNMP cadastrado.')]));
    }
    async function load() { try { devices = await apiJSON('GET', '/api/settings/snmp'); render(); } catch (e) { /* viewer */ } }
    f.addEventListener('submit', ev => {
      ev.preventDefault(); const d = fromForm();
      save(devices.filter(x => x.name !== d.name).concat([d]), 'Dispositivo salvo.');
    });
    const panel = h('div', {}, h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Dispositivos SNMP (OLT, switches…)'})), list),
      h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Adicionar / editar'})), f));
    panel._onShow = load;
    addTab('snmp', '📡 SNMP', panel);
  }

  // ----------------------------------------------------------------- Zabbix
  function buildZabbix() {
    const f = h('form', {class: 'x-form'}, check('enabled', 'Ativar integração (somente leitura)'),
      field('URL da API', inp('url', 'text', 'https://zabbix.exemplo/api_jsonrpc.php')),
      field('Token de API', inp('token', 'password', 'token gerado no Zabbix (Usuários → Tokens de API)')),
      h('div', {class: 'x-row'}, field('Severidade mínima', h('select', {name: 'min_severity'},
          ['0 Não classificado', '1 Informação', '2 Atenção', '3 Média', '4 Alta', '5 Desastre'].map((t, i) => h('option', {value: i, text: t})))),
        field('Máx. problemas', inp('limit', 'number', '50', 50))),
      check('verify_ssl', 'Validar certificado TLS', true),
      h('div', {class: 'x-row'}, h('button', {type: 'submit', class: 'admin-only', text: 'Salvar'}),
        h('button', {type: 'button', class: 'mini-btn', id: 'zbTest', text: 'Testar conexão'})));
    async function load() {
      try {
        const c = await apiJSON('GET', '/api/settings/zabbix'), e = f.elements;
        e.enabled.checked = c.enabled; e.url.value = c.url; e.token.value = c.token; e.min_severity.value = c.min_severity;
        e.limit.value = c.limit; e.verify_ssl.checked = c.verify_ssl;
      } catch (er) { /* viewer */ }
    }
    f.addEventListener('submit', async ev => {
      ev.preventDefault(); const e = f.elements;
      try {
        await apiJSON('POST', '/api/settings/zabbix', {enabled: e.enabled.checked, url: e.url.value.trim(), token: e.token.value,
          verify_ssl: e.verify_ssl.checked, min_severity: Number(e.min_severity.value), limit: Number(e.limit.value) || 50});
        msg('Zabbix salvo.'); load();
      } catch (er) { msg(er.message, true); }
    });
    f.querySelector('#zbTest').addEventListener('click', async ev => {
      ev.target.disabled = true;
      try { const r = await apiJSON('POST', '/api/settings/zabbix/test'); msg('Zabbix ' + r.version + ' — token válido.'); }
      catch (e) { msg(e.message, true); }
      ev.target.disabled = false;
    });
    const panel = h('div', {}, h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Zabbix'})), f));
    panel._onShow = load;
    addTab('zabbix', '🛡 Zabbix', panel);
  }

  // --------------------------------------------------------------- Segurança
  function buildSecurity() {
    const users = h('div', {class: 'settings-list'});
    const uf = h('form', {class: 'settings-form x-form'}, field('Usuário', inp('u_name')), field('Senha (mín. 8)', inp('u_pass', 'password')),
      field('Perfil', h('select', {name: 'u_role'}, h('option', {value: 'viewer', text: 'Leitura'}), h('option', {value: 'admin', text: 'Admin'}))),
      h('button', {type: 'submit', class: 'admin-only', text: 'Salvar usuário'}));
    async function loadUsers() {
      try {
        const l = await apiJSON('GET', '/api/users');
        users.replaceChildren(...l.map(u => h('div', {class: 'settings-item'}, h('span', {text: u.name + ' — ' + (u.role === 'admin' ? 'admin' : 'leitura')}),
          h('button', {type: 'button', class: 'admin-only', title: 'Remover', text: '✕', onclick: async () => {
            if (!confirm('Remover ' + u.name + '?')) return;
            try { await apiJSON('DELETE', '/api/users/' + encodeURIComponent(u.name)); loadUsers(); } catch (e) { msg(e.message, true); } }})) ));
      } catch (e) { users.replaceChildren(emptyState('Somente administradores.')); }
    }
    uf.addEventListener('submit', async ev => {
      ev.preventDefault(); const e = uf.elements;
      try { await apiJSON('POST', '/api/users', {name: e.u_name.value.trim(), password: e.u_pass.value, role: e.u_role.value});
        uf.reset(); msg('Usuário salvo.'); loadUsers(); } catch (er) { msg(er.message, true); }
    });
    // tokens
    function tokenBox(label, url, hint) {
      const out = h('input', {readonly: true, class: 'token-out', placeholder: 'o token aparece aqui (uma única vez)', 'aria-label': label});
      return h('div', {class: 'x-sub'}, h('h4', {text: label}), h('p', {class: 'hint', text: hint}),
        h('div', {class: 'x-controls'}, h('button', {type: 'button', class: 'mini-btn admin-only', text: 'Gerar novo token', onclick: async () => {
            if (!confirm('Gerar novo token invalida o anterior. Continuar?')) return;
            try { const r = await apiJSON('POST', url); out.value = r.token; out.select(); } catch (e) { msg(e.message, true); } }}),
          h('button', {type: 'button', class: 'mini-btn', text: 'Copiar', onclick: () => { if (out.value && navigator.clipboard) navigator.clipboard.writeText(out.value).then(() => msg('Copiado.')); }}), out));
    }
    // backup
    const file = h('input', {type: 'file', accept: 'application/json,.json', 'aria-label': 'Arquivo de backup'});
    const backup = h('div', {class: 'x-sub'}, h('h4', {text: 'Backup da configuração'}),
      h('p', {class: 'hint', text: 'O arquivo não contém senhas/tokens. Ao restaurar, segredos atuais são mantidos só se o destino não mudou.'}),
      h('div', {class: 'x-controls'}, h('a', {class: 'mini-btn', href: '/api/backup', text: '⬇ Exportar JSON'}), file,
        h('button', {type: 'button', class: 'mini-btn admin-only', text: '⬆ Restaurar', onclick: async () => {
          if (!file.files[0]) return msg('Escolha um arquivo.', true);
          if (!confirm('Restaurar substitui destinos, DNS, intervalos e integrações. Continuar?')) return;
          try { const data = JSON.parse(await file.files[0].text()); const r = await apiJSON('POST', '/api/restore', data);
            msg('Restaurado: ' + r.applied.join(', ')); setTimeout(() => location.reload(), 1200); } catch (e) { msg(e.message, true); } }})));
    // status pública
    const ps = h('form', {class: 'x-sub x-form'}, h('h4', {text: 'Página de status pública (somente leitura)'}),
      check('ps_enabled', 'Ativar em /status (sem login)'), field('Título', inp('ps_title', 'text', 'Status dos serviços')),
      field('Alvos exibidos (vazio = todos)', h('select', {name: 'ps_targets', multiple: true, size: 4})),
      h('div', {class: 'x-controls'}, h('button', {type: 'submit', class: 'admin-only', text: 'Salvar'}),
        h('a', {class: 'mini-btn', href: '/status', target: '_blank', rel: 'noopener', text: 'Abrir página'})));
    async function loadPs() {
      try {
        const [c, s] = await Promise.all([apiJSON('GET', '/api/settings/public-status'), apiJSON('GET', '/api/settings')]);
        const e = ps.elements; e.ps_enabled.checked = c.enabled; e.ps_title.value = c.title;
        e.ps_targets.replaceChildren(...s.targets.map(t => { const o = h('option', {value: t.name, text: t.name}); o.selected = c.targets.includes(t.name); return o; }));
      } catch (e) { /* ok */ }
    }
    ps.addEventListener('submit', async ev => {
      ev.preventDefault(); const e = ps.elements;
      try { await apiJSON('POST', '/api/settings/public-status', {enabled: e.ps_enabled.checked, title: e.ps_title.value || 'Status dos serviços',
        targets: Array.from(e.ps_targets.selectedOptions).map(o => o.value)}); msg('Página de status salva.'); } catch (er) { msg(er.message, true); }
    });
    // auditoria
    const audit = h('div', {class: 'tool-out'});
    async function loadAudit() {
      try {
        const rows = await apiJSON('GET', '/api/audit?limit=50');
        audit.replaceChildren(h('table', {class: 'data-table'}, h('thead', {}, h('tr', {}, ['Quando', 'Usuário', 'IP', 'Ação', 'Detalhe'].map(t => h('th', {text: t})))),
          h('tbody', {}, rows.map(r => h('tr', {}, h('td', {text: fmtDateTime(r.ts)}), h('td', {text: r.user}), h('td', {text: r.ip}), h('td', {text: r.action}), h('td', {text: r.detail || ''}))))));
      } catch (e) { audit.replaceChildren(emptyState('Somente administradores.')); }
    }
    const panel = h('div', {},
      h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Usuários'})), users, uf),
      h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Tokens de integração'})),
        tokenBox('Agente remoto (multi-site)', '/api/settings/agent-token', 'Use em: python3 agent.py --url … --site … --token …'),
        tokenBox('Prometheus /metrics', '/api/settings/metrics-token', 'Envie como Authorization: Bearer <token>. Vale somente para /metrics.')),
      h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Backup e status pública'})), backup, ps),
      h('section', {class: 'panel'}, h('div', {class: 'panel-header'}, h('span', {text: 'Log de auditoria'})), audit));
    panel._onShow = () => { loadUsers(); loadPs(); loadAudit(); };
    addTab('seguranca', '🔒 Segurança', panel);
  }

  window.addEventListener('load', () => {
    if (!document.querySelector('.config-tabs')) return;
    buildNotify(); buildSnmp(); buildZabbix(); buildSecurity();
    const saved = (function () { try { return localStorage.getItem('netnoc_config_tab'); } catch (e) { return null; } })();
    if (saved && ['notif', 'snmp', 'zabbix', 'seguranca'].includes(saved)) {
      const t = document.querySelector('.config-tab[data-tab="' + saved + '"]'); if (t) t.click();
    }
  });
})();
