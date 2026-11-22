// NetNOC — tela: Configurações
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== CONFIGURAÇÕES
  const RECOMMENDED = {ping_interval_seconds: 10, dns_check_interval_seconds: 30, public_ip_interval_seconds: 300, system_interval_seconds: 15};
  const IV_LABEL = {ping_interval_seconds: 'Ping (s)', dns_check_interval_seconds: 'DNS (s)', public_ip_interval_seconds: 'IP público (s)', system_interval_seconds: 'Sistema (s)'};

  // Outros canais de alerta: Discord, webhook (JSON assinado) e e-mail (v4.0: veio da interface clássica)
  function notifyForm(c, R, ctx) {
    const [dSw, dEn] = sw('Discord', c.discord.enabled);
    const dUrl = inp({type: 'password', value: c.discord.webhook_url || '', placeholder: 'https://discord.com/api/webhooks/…', autocomplete: 'off'});
    const [wSw, wEn] = sw('Webhook (JSON)', c.webhook.enabled);
    const wUrl = inp({value: c.webhook.url || '', placeholder: 'https://…'});
    const wSec = inp({type: 'password', value: c.webhook.secret || '', placeholder: 'opcional', autocomplete: 'off'});
    const [eSw, eEn] = sw('E-mail (SMTP)', c.email.enabled);
    const eHost = inp({value: c.email.host || '', placeholder: 'smtp.gmail.com'}), ePort = inp({type: 'number', value: c.email.port || 587});
    const eUser = inp({value: c.email.user || '', autocomplete: 'off'}), ePass = inp({type: 'password', value: c.email.password || '', autocomplete: 'new-password'});
    const eFrom = inp({value: c.email.sender || '', placeholder: 'noc@exemplo.com'}), eTo = inp({value: c.email.to || '', placeholder: 'a@x.com, b@x.com'});
    const [tSw, eTls] = sw('STARTTLS (na porta 465 usa SSL direto)', c.email.starttls !== false);
    const sev = select([['Alta', 'Só alta'], ['Media', 'Média ou mais'], ['Baixa', 'Baixa ou mais'], ['Info', 'Tudo']], c.min_severity || 'Alta');
    const test = ch => tbtn('Testar', 'play', async () => { await act(() => post('/api/settings/notify/test/' + ch), 'Teste enviado'); });
    const sub = (title, ...kids) => h('div', {class: 'h2-sub'}, h('h4', {text: title}), ...kids);
    R.append(sec('bell', 'Outros canais de alerta',
      h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Além do Telegram. As senhas salvas aparecem mascaradas; se mudar o endereço, digite de novo.'}),
      field('Enviar a partir de', sev),
      sub('Discord', dSw, field('URL do webhook do canal', dUrl), h('div', {}, test('discord'))),
      sub('Webhook', wSw, h('div', {class: 'row2'}, field('URL', wUrl), field('Segredo HMAC', wSec)),
        h('div', {class: 'hint', text: 'O corpo vai assinado no cabeçalho X-NetNOC-Signature: sha256=…'}), h('div', {}, test('webhook'))),
      sub('E-mail', eSw, h('div', {class: 'row2'}, field('Servidor', eHost), field('Porta', ePort)),
        h('div', {class: 'row2'}, field('Usuário', eUser), field('Senha', ePass)),
        h('div', {class: 'row2'}, field('Remetente', eFrom), field('Destinatários', eTo)), tSw, h('div', {}, test('email'))),
      h('div', {style: {marginTop: '12px'}}, tbtn('Salvar canais', 'check', async () => {
        if (needAdmin()) return;
        if (await act(() => post('/api/settings/notify', {min_severity: sev.value,
          discord: {enabled: dEn.checked, webhook_url: dUrl.value},
          webhook: {enabled: wEn.checked, url: wUrl.value.trim(), secret: wSec.value},
          email: {enabled: eEn.checked, host: eHost.value.trim(), port: +ePort.value || 587, user: eUser.value.trim(), password: ePass.value,
            sender: eFrom.value.trim(), to: eTo.value.trim(), starttls: eTls.checked}}), 'Canais salvos')) ctx.reopen({tab: 'alertas'});
      }, 'primary'))));
  }

  function integForm(kind, cfg, R) {
    const isMt = kind === 'mikrotik';
    const [swEl, en] = sw('Ativado', cfg.enabled);
    const host = inp({value: cfg.host || '', placeholder: isMt ? '192.168.88.1' : '192.168.1.5'});
    const port = inp({type: 'number', value: cfg.port || (isMt ? 443 : 3000)});
    const [swH, https] = sw('HTTPS', cfg.use_https);
    const user = inp({value: cfg.username || '', autocomplete: 'off'});
    const pass = inp({type: 'password', value: cfg.password || '', autocomplete: 'new-password'});
    const iv = inp({type: 'number', min: 15, value: cfg.sync_interval_seconds || 60});
    const wan = isMt ? inp({value: cfg.wan_iface || '', placeholder: 'automático (pppoe-out1, ether1…)'}) : null;
    // v4.2: certificado fixado (HTTPS com o certificado próprio do RouterOS)
    const plan = isMt ? inp({type: 'number', min: 0, max: 100000, value: cfg.plan_mbps || '', placeholder: 'ex.: 1000'}) : null;
    const pin = isMt ? inp({value: cfg.cert_sha256 || '', placeholder: 'vazio = sem fixar', spellcheck: 'false', style: {fontFamily: 'ui-monospace,monospace', fontSize: '12px'}}) : null;
    const save = async () => {
      if (needAdmin()) return;
      const body = {enabled: en.checked, host: host.value.trim(), port: +port.value, use_https: https.checked,
        username: user.value.trim(), password: pass.value, sync_interval_seconds: +iv.value};
      if (isMt) { body.verify_ssl = !!cfg.verify_ssl; body.wan_iface = wan.value.trim(); body.cert_sha256 = pin.value.trim(); body.plan_mbps = +plan.value || 0; }
      await act(() => post('/api/settings/' + kind, body), 'Salvo');
    };
    const test = async () => {
      const r = await act(() => post('/api/settings/' + kind + '/test'));
      if (r) toast(isMt ? `Conectado · ${r.leases_found} leases DHCP` : `Conectado · AdGuard ${r.version || ''}`);
    };
    const warn = (+cfg.sync_interval_seconds || 60) > 600
      ? h('div', {class: 'callout', text: `Intervalo atual de ${dur(cfg.sync_interval_seconds)}: gráficos e vazão ficam sem sentido. Recomendado: ${isMt ? '60' : '300'} s.`}) : null;
    R.append(sec(isMt ? 'router' : 'shield', isMt ? 'MikroTik (API REST)' : 'AdGuard Home', warn,
      h('div', {class: 'form'}, h('div', {class: 'row2'}, field('Host', host), field('Porta', port)),
        h('div', {class: 'row2'}, field('Usuário', user), field('Senha', pass)),
        h('div', {class: 'row2'}, field('Intervalo de coleta (s)', iv), h('div', {style: {display: 'flex', gap: '18px', alignItems: 'end', paddingBottom: '10px'}}, swEl, swH)),
        isMt ? field('Porta da internet (WAN)', wan) : null,
        isMt ? h('div', {class: 'hint', text: 'Usada para o pico de download/upload (a velocidade real do link) e para ver se a internet está saturada. Vazio: o NetNOC escolhe a porta PPPoE ou a com nome/comentário de WAN.'}) : null,
        isMt ? field('Velocidade contratada (download, Mbps)', plan) : null,
        isMt ? mtHttps(cfg, host, port, https, pin) : null,
        h('div', {class: 'hint', text: 'A senha salva aparece mascarada. Se mudar host/porta/usuário, digite a senha de novo.'}),
        h('div', {style: {display: 'flex', gap: '8px'}}, tbtn('Salvar', 'check', save, 'primary'), tbtn('Testar', 'activity', test)))));
  }

  // v4.2: HTTPS no MikroTik com certificado fixado + comandos do RouterOS para preparar tudo
  function mtHttps(cfg, host, port, https, pin) {
    const fpOut = h('div', {class: 'hint'});
    const read = async () => {
      if (needAdmin()) return;
      if (!https.checked) return toast('Ligue HTTPS e coloque a porta do www-ssl antes', 'error');
      const r = await act(() => post('/api/settings/mikrotik/cert', {host: host.value.trim(), port: +port.value}));
      if (!r) return;
      fpOut.textContent = 'Lido do roteador: ' + r.pretty + '. Confira com o "fingerprint" do /certificate print detail no MikroTik antes de salvar.';
      pin.value = r.sha256;
    };
    const ip = (host.value || cfg.host || '192.168.88.1').trim();
    const cmds = [
      '# 1) certificado próprio do roteador (vale 10 anos)',
      `/certificate add name=netnoc-https common-name=${ip} subject-alt-name=IP:${ip} days-valid=3650 key-size=2048 key-usage=digital-signature,key-encipherment,tls-server`,
      '/certificate sign netnoc-https',
      '# 2) liga o HTTPS da API só para o Pi (troque IP_DO_PI)',
      '/ip service set www-ssl certificate=netnoc-https port=1886 address=IP_DO_PI/32 disabled=no',
      '# 3) usuário só com o que o NetNOC usa (sem winbox, ssh, ftp, sensitive)',
      '/user group add name=netnoc policy=read,write,api,rest-api,reboot,!local,!telnet,!ssh,!ftp,!winbox,!web,!sniff,!sensitive,!policy,!password,!romon,!test',
      '/user add name=netnoc group=netnoc address=IP_DO_PI/32 password=SENHA_FORTE',
      '# 4) impressão digital para conferir na tela',
      '/certificate print detail where name=netnoc-https',
      '# 5) depois que o NetNOC estiver funcionando por HTTPS, desligue o HTTP sem criptografia',
      '/ip service set www disabled=yes'].join('\n');
    const pre = h('pre', {class: 'ai-out', text: cmds});
    const det = h('details', {}, h('summary', {text: 'Como ligar o HTTPS no MikroTik (comandos para colar no terminal)'}), pre,
      h('div', {class: 'hint', text: 'Depois: aqui em cima, porta 1886, HTTPS ligado, usuário netnoc. Toque em "Ler certificado", confira a impressão digital e salve. Funciona no device-mode home.'}));
    return h('div', {}, field('Certificado fixado (SHA-256)', pin),
      h('div', {class: 'hint', text: 'O MikroTik usa certificado próprio, que nenhuma autoridade reconhece. Fixando a impressão digital, o NetNOC só conversa com ESTE roteador; se o certificado mudar, a coleta para e avisa.'}),
      h('div', {style: {display: 'flex', gap: '8px', margin: '6px 0'}}, tbtn('Ler certificado', 'lock', read)), fpOut, det);
  }

  // v4.3: syslog do MikroTik
  async function syslogForm(R, ctx, mt) {
    const st = await api('/api/settings/syslog').catch(() => null);
    if (!st) return;
    const [swEl, en] = sw('Receber o log do MikroTik', st.enabled);
    const port = inp({type: 'number', min: 1025, max: 65535, value: st.port});
    const me = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : 'IP_DO_PI';
    const cmds = [`/system logging action add name=netnoc target=remote remote=${me} remote-port=${st.port}`,
      '/system logging add topics=info action=netnoc',
      '/system logging add topics=warning action=netnoc',
      '/system logging add topics=error action=netnoc',
      '/system logging add topics=critical action=netnoc'].join('\n');
    const stat = !st.enabled ? '' : st.error ? 'Erro: ' + st.error
      : st.listening ? `Escutando na porta UDP ${st.port}. ` + (st.last ? `Última mensagem: ${ago(st.last)} · ${st.received} recebidas.` : 'Nenhuma mensagem ainda.')
        + (st.ignored ? ` ${st.ignored} ignoradas (de outro IP que não o MikroTik).` : '') : '';
    R.append(sec('file', 'Syslog do MikroTik',
      h('div', {class: 'hint', style: {marginBottom: '8px'}, text: 'O roteador manda o log dele para o NetNOC: aparece o motivo de cada queda do PPPoE (no diagnóstico e no Telegram com /log), logins e erros. Só aceita mensagens do IP do MikroTik configurado acima. Funciona no device-mode home.'}),
      h('div', {class: 'form'}, h('div', {class: 'row2'}, h('div', {style: {display: 'flex', alignItems: 'end', paddingBottom: '10px'}}, swEl), field('Porta UDP', port)),
        stat ? h('div', {class: 'hint', text: stat}) : null,
        h('details', {}, h('summary', {text: 'Comandos para colar no terminal do MikroTik'}), h('pre', {class: 'ai-out', text: cmds})),
        h('div', {}, tbtn('Salvar', 'check', async () => {
          if (needAdmin()) return;
          if (await act(() => post('/api/settings/syslog', {enabled: en.checked, port: +port.value}), 'Salvo')) ctx.reopen({tab: 'integ'});
        }, 'primary')))));
  }

  // v4.2: backup diário no Telegram + vigia externo
  async function guardaSec(R, ctx) {
    const g = await api('/api/settings/guarda').catch(() => null);
    if (!g) return;
    const [bkEl, bkOn] = sw('Mandar backup todo dia pelo Telegram', g.backup_enabled);
    const [hiEl, hiOn] = sw('Incluir o histórico (gráficos e incidentes; arquivo maior)', g.backup_hist);
    const tm = inp({type: 'time', value: g.backup_time || '03:30'});
    const hc = inp({value: g.hc_url || '', placeholder: 'https://hc-ping.com/…', autocomplete: 'off', spellcheck: 'false'});
    const when = ts => ts ? new Date(ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : '';
    const lb = g.last_backup;
    const lbTxt = !lb ? 'Nenhum backup enviado ainda.'
      : lb.ok ? `Último backup: ${when(lb.ts)} · ${Math.round(lb.size / 1024)} KB · ok`
      : `Último backup: ${when(lb.ts)} · falhou: ${lb.error}`;
    const hcTxt = !g.hc_url ? 'Vigia externo desligado.'
      : g.hc && g.hc.last ? `Último aviso: ${when(g.hc.last)} · ${g.hc.ok ? 'ok' : 'falhou: ' + (g.hc.error || '')}` : 'Aguardando o primeiro aviso.';
    const save = async () => {
      if (needAdmin()) return;
      const r = await act(() => post('/api/settings/guarda', {backup_enabled: bkOn.checked, backup_time: tm.value, backup_hist: hiOn.checked, hc_url: hc.value.trim()}), 'Salvo');
      if (r && r.hc && r.hc.last && !r.hc.ok) toast('A URL do vigia não respondeu: ' + (r.hc.error || ''), 'error');
      if (r) ctx.reopen();
    };
    R.append(sec('clock', 'Backup automático e vigia externo',
      !g.telegram_ok ? h('div', {class: 'callout', text: 'Configure o Telegram (Alertas) para o backup automático chegar até você.'}) : null,
      h('div', {class: 'form'}, bkEl, h('div', {class: 'row2'}, field('Horário', tm), h('div', {style: {display: 'flex', alignItems: 'end', paddingBottom: '10px'}}, hiEl)),
        h('div', {class: 'hint', text: lbTxt}),
        h('div', {class: 'hint', text: 'O arquivo leva a configuração e as senhas CIFRADAS. A chave que abre as senhas (' + (g.key_path || 'netnoc.key') + ') nunca vai junto: copie-a uma vez para outro lugar (pendrive, gerenciador de senhas). Sem ela, um backup restaurado volta sem as senhas.'}),
        field('URL do vigia externo (healthchecks.io)', hc),
        h('div', {class: 'hint', text: 'A cada minuto o NetNOC avisa esse endereço que está vivo. Se o Pi travar, faltar luz ou a internet cair, os avisos param e o healthchecks.io te manda e-mail ou Telegram. Crie uma conta grátis, um "check" com período de 5 min e cole aqui a URL de ping. ' + hcTxt}),
        h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}}, tbtn('Salvar', 'check', save, 'primary'),
          tbtn('Mandar backup agora', 'download', async () => {
            if (needAdmin()) return;
            const r = await act(() => post('/api/backup/run'));
            if (r) { toast(`Backup enviado (${Math.round(r.size / 1024)} KB)`); ctx.reopen(); }
          })))));
  }

  function dvrForm(cfg, R, ctx) {
    const [swEl, en] = sw('Ativado', cfg.enabled);
    const [swEv, ev] = sw('Alertas de perda de vídeo e HD', cfg.events);
    const [swH, https] = sw('HTTPS', cfg.use_https);
    const host = inp({value: cfg.host || '', placeholder: '192.168.1.108'});
    const hp = inp({type: 'number', value: cfg.http_port || 80});
    const rp = inp({type: 'number', value: cfg.rtsp_port || 554});
    const user = inp({value: cfg.username || '', autocomplete: 'off'});
    const pass = inp({type: 'password', value: cfg.password || '', autocomplete: 'new-password'});
    const chs = select([[1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']], cfg.channels || 4);
    const tpl = inp({value: cfg.rtsp_template || '', placeholder: 'padrão Intelbras/Dahua (deixe vazio)', class: 'inp mono'});
    const out = h('div', {class: 'list', style: {marginTop: '12px'}});
    const body = () => ({enabled: en.checked, host: host.value.trim(), http_port: +hp.value, rtsp_port: +rp.value, use_https: https.checked,
      username: user.value.trim(), password: pass.value, channels: +chs.value, events: ev.checked, rtsp_template: tpl.value.trim()});
    const save = async () => { if (needAdmin()) return false; return !!(await act(() => post('/api/settings/dvr', body()), 'DVR salvo')); };
    const test = async () => {
      if (!(await save())) return;
      clear(out).append(h('div', {class: 'hint', text: 'Testando…'}));
      const r = await act(() => post('/api/settings/dvr/test'));
      clear(out);
      if (!r) return;
      out.append(li('ok', `${r.model || 'DVR'} · firmware ${r.version || '?'}`, `${r.snapshots_ok}/${r.channels.length} canais responderam com imagem`,
        r.go2rtc && r.go2rtc.running ? 'vídeo ao vivo pronto' : (r.go2rtc && r.go2rtc.binary ? 'go2rtc iniciando…' : 'go2rtc não instalado')));
      for (const c of r.channels) out.append(li(/265/.test((c.sub || '') + (c.main || '')) ? 'media' : 'ok', `Canal ${c.ch}: ${c.name}`,
        `principal ${c.main || '?'} · extra ${c.sub || '?'}`, ''));
      for (const d of r.hdd || []) out.append(li(d.error ? 'alta' : 'ok', `HD ${d.disk}`, d.used_pct != null ? `${pct(d.used_pct, 0)}% de ${d.total_gb} GB` : (d.state || ''), ''));
      for (const w of r.warnings || []) out.append(li('media', w, null, ''));
      // diagnóstico: o que o firmware respondeu (vídeo ao vivo só precisa do RTSP)
      for (const c of r.checks || []) out.append(li(c.ok ? 'ok' : 'baixa', c.name, c.ok ? null : (c.error || 'sem resposta'), c.ok ? 'ok' : 'indisponível'));
    };
    R.append(sec('video', 'DVR Intelbras (câmeras)',
      h('div', {class: 'callout blue'}, h('b', {text: 'Crie no DVR um usuário só de visualização'}),
        'e deixe o stream extra (e de preferência o principal) em H.264 — o navegador não toca H.265. O vídeo só é puxado do DVR enquanto alguém está na tela de câmeras.'),
      h('div', {class: 'form'},
        h('div', {class: 'row2'}, field('IP do DVR', host), field('Canais', chs)),
        h('div', {class: 'row2'}, field('Usuário', user), field('Senha', pass)),
        h('div', {class: 'row2'}, field('Porta HTTP', hp), field('Porta RTSP', rp)),
        h('div', {style: {display: 'flex', gap: '18px', flexWrap: 'wrap'}}, swEl, swEv, swH),
        h('details', {}, h('summary', {class: 'hint', style: {cursor: 'pointer'}, text: 'Avançado: modelo de URL RTSP'}),
          h('div', {class: 'form', style: {marginTop: '8px'}}, tpl,
            h('div', {class: 'hint', text: 'Variáveis: {user} {password} {host} {rtsp_port} {ch} {sub}. Padrão: rtsp://{user}:{password}@{host}:{rtsp_port}/cam/realmonitor?channel={ch}&subtype={sub}'}))),
        h('div', {style: {display: 'flex', gap: '8px'}}, tbtn('Salvar', 'check', save, 'primary'), tbtn('Salvar e testar', 'activity', test))),
      out));
  }

  registerSheet('config', {
    title: 'Configurações', icon: 'gear',
    async render(ctx) {
      const tab = ctx.params.tab || 'geral';
      ctx.tools.append(seg([['geral', 'Geral'], ['aparencia', 'Aparência'], ['destinos', 'Destinos'], ['alertas', 'Alertas'], ['integ', 'Integrações']]
        .concat(NN.isAdmin() ? [['seg', 'Segurança']] : []), tab, t => ctx.reopen({tab: t})));
      const [L, R] = panels(ctx);
      // ---- painel esquerdo: sistema + coletores
      const sys = await api('/api/system').catch(() => null);
      if (sys) {
        L.append(h('div', {class: 'bigstat'}, h('span', {class: 'l', text: sys.host_label}), h('span', {class: 'v', text: 'v' + sys.version})));
        L.append(kv([['CPU', pct(sys.cpu_pct, 0) + '%'], ['Memória', pct(sys.mem_pct, 0) + '%'], ['Temperatura', sys.temp_c != null ? pct(sys.temp_c, 1) + ' °C' : '--'],
          ['Disco', sys.disk_pct != null ? pct(sys.disk_pct, 0) + '%' : '--'], ['Configuração', sys.db_cfg_mb != null ? pct(sys.db_cfg_mb, 2) + ' MB' : '--'], ['Histórico', sys.db_hist_mb != null ? ms(sys.db_hist_mb) + ' MB' : '--'],
          ['Host ligado há', sys.host_uptime_s ? dur(sys.host_uptime_s) : '--'], ['NetNOC rodando há', dur(sys.app_uptime_s)],
          ['Janela de avaliação', dur(sys.window_seconds)]]));
        L.append(h('div', {class: 'rule'}), h('h4', {class: 'hint', style: {fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em'}, text: 'Coletores'}));
        const wl = h('div', {class: 'list'});
        for (const w of sys.workers) {
          wl.append(li(w.status === 'ok' ? 'ok' : w.status === 'error' ? 'media' : 'alta', w.name,
            w.error ? w.error : `a cada ${dur(w.interval)} · ${w.runs} execuções`, w.last_run ? ago(w.last_run) : 'nunca'));
        }
        L.append(wl);
      }
      L.append(h('div', {class: 'rule'}), h('div', {class: 'form'},
        h('div', {class: 'hint', text: `Sessão: ${(S.me || {}).user} (${(S.me || {}).role})`}),
        tbtn('Sair', 'logout', async () => { await post('/api/logout').catch(() => {}); location.href = '/login'; }, 'danger')));

      if (!NN.isAdmin()) R.append(h('div', {class: 'callout blue', text: 'Perfil somente leitura: as alterações exigem um administrador.'}));

      if (tab === 'geral') {
        const iv = await api('/api/settings/intervals');
        const ins = {};
        const grid = h('div', {class: 'row2'});
        for (const k of Object.keys(IV_LABEL)) { ins[k] = inp({type: 'number', min: 1, max: 86400, value: iv[k]}); grid.append(field(IV_LABEL[k], ins[k])); }
        const off = Object.keys(RECOMMENDED).filter(k => iv[k] > RECOMMENDED[k] * 4);
        R.append(sec('clock', 'Intervalos de coleta',
          off.length ? h('div', {class: 'callout'}, h('b', {text: 'Intervalos muito longos'}),
            off.map(k => `${IV_LABEL[k].replace(' (s)', '')}: ${dur(iv[k])}`).join(' · ') +
            '. Com ping de 60 s a detecção de queda leva minutos e o painel de sistema fica horas atrasado.') : null,
          h('div', {class: 'form'}, grid,
            h('div', {class: 'hint', text: 'Alterações valem na hora (não precisa reiniciar).'}),
            h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}},
              tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                const body = {}; for (const k in ins) body[k] = +ins[k].value;
                if (await act(() => post('/api/settings/intervals', body), 'Intervalos salvos')) ctx.reopen();
              }, 'primary'),
              tbtn('Usar recomendados', 'bolt', () => { for (const k in RECOMMENDED) ins[k].value = RECOMMENDED[k]; })))));
        // banco: configuração x histórico
        if (sys) {
          const files = sys.db_files || {config: 'netnoc.db', history: 'netnoc-historico.db'};
          R.append(sec('db', 'Dados',
            h('div', {class: 'tiles', style: {gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', marginBottom: '12px'}},
              h('div', {class: 'tile', style: {minHeight: '0'}}, h('h4', {text: 'Configuração'}),
                h('div', {class: 'big', text: (sys.db_cfg_mb != null ? pct(sys.db_cfg_mb, 2) : '--') + ' MB'}),
                h('div', {class: 'tsub', text: files.config + ' — destinos, grupos, integrações, usuários e aparelhos do DHCP. Fica sempre; é o que vai no backup.'})),
              h('div', {class: 'tile', style: {minHeight: '0'}}, h('h4', {text: 'Histórico'}),
                h('div', {class: 'big', text: (sys.db_hist_mb != null ? ms(sys.db_hist_mb) : '--') + ' MB'}),
                h('div', {class: 'tsub', text: files.history + ' — pings, médias, DNS, incidentes, eventos e logs. Pode ser apagado quando quiser.'}))),
            h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Apagar o histórico zera gráficos, SLA e incidentes, mas não mexe em nenhuma configuração. O monitoramento continua e o histórico recomeça na hora.'}),
            h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}},
              tbtn('Apagar histórico', 'trash', async () => {
                if (needAdmin() || !confirm('Apagar TODO o histórico (pings, gráficos, SLA, incidentes e eventos)? A configuração não é afetada.')) return;
                const r = await act(() => post('/api/history/clear'), 'Histórico apagado');
                if (r) { NN.loadSlow(); ctx.reopen(); }
              }, 'danger'),
              tbtn('Compactar arquivos', 'refresh', async () => {
                if (needAdmin()) return;
                const r = await act(() => post('/api/history/vacuum'));
                if (r) { toast(`Compactado: ${r.size_before_mb} MB → ${r.size_after_mb} MB`); ctx.reopen(); }
              }))));
        }
        // backup / restauração da configuração (v4.0: veio da interface clássica)
        if (NN.isAdmin()) {
          const file = h('input', {type: 'file', accept: 'application/json,.json', class: 'inp', 'aria-label': 'Arquivo de backup'});
          R.append(sec('download', 'Backup da configuração',
            h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Destinos, DNS, intervalos, integrações, alertas e bot num arquivo JSON, sem nenhuma senha ou chave. Ao restaurar, as senhas atuais continuam valendo se o endereço do equipamento não mudou.'}),
            h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center'}},
              h('a', {class: 'tbtn primary', href: '/api/backup', style: {textDecoration: 'none'}}, h('span', {trusted: ICO('download')}), 'Baixar backup'),
              file,
              tbtn('Restaurar', 'upload', async () => {
                if (!file.files[0]) return toast('Escolha o arquivo de backup', 'error');
                if (!confirm('Restaurar substitui destinos, DNS, intervalos, integrações e alertas pelos do arquivo. Continuar?')) return;
                let data;
                try { data = JSON.parse(await file.files[0].text()); } catch (_) { return toast('O arquivo não é um JSON válido', 'error'); }
                const r = await act(() => post('/api/restore', data));
                if (r) { toast('Restaurado: ' + r.applied.join(', ')); setTimeout(() => location.reload(), 1200); }
              }))));
        }
        if (NN.isAdmin()) await guardaSec(R, ctx);
        const an = await api('/api/settings/appname');
        const nameIn = inp({value: an.name, maxlength: 40});
        R.append(sec('home', 'Nome do painel', h('div', {class: 'form'}, nameIn, h('div', {}, tbtn('Salvar', 'check', async () => {
          if (needAdmin()) return;
          if (await act(() => post('/api/settings/appname', {name: nameIn.value}), 'Nome salvo')) { window.APP_NAME = nameIn.value.trim(); document.title = window.APP_NAME; }
        }, 'primary')))));
        const ps = await api('/api/settings/public-status').catch(() => null);
        if (ps) {
          const [swEl, en] = sw('Página pública /status ativada', ps.enabled);
          const title = inp({value: ps.title});
          const boxes = h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: '10px'}});
          const checks = {};
          for (const t of S.targets) {
            const c = h('input', {type: 'checkbox'}); c.checked = ps.targets.includes(t.name); checks[t.name] = c;
            boxes.append(h('label', {class: 'switch', style: {fontSize: '13px'}}, c, t.name + (isLocal(t) ? ' 🏠' : '')));
          }
          R.append(sec('eye', 'Página de status pública',
            ps.enabled && !ps.targets.length ? h('div', {class: 'callout', text: 'Ativada sem seleção = TODOS os destinos aparecem sem login, inclusive os internos (🏠). Selecione só os públicos.'}) : null,
            h('div', {class: 'form'}, swEl, field('Título', title), boxes,
              h('div', {}, tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                await act(() => post('/api/settings/public-status', {enabled: en.checked, title: title.value,
                  targets: Object.keys(checks).filter(k => checks[k].checked)}), 'Página pública salva');
              }, 'primary'), ' ', h('a', {class: 'tbtn', href: '/status', target: '_blank', rel: 'noopener', style: {textDecoration: 'none'}}, 'Abrir /status')))));
        }
      }

      if (tab === 'destinos') {
        const cfg = await api('/api/settings');
        const tbl = h('table', {class: 'tbl'}, h('thead', {}, h('tr', {}, ...['Destino', 'Host', 'Tipo', 'Depende de', 'Grupo', 'Intervalo', ''].map(x => h('th', {text: x})))));
        const tb = h('tbody');
        for (const t of cfg.targets) {
          tb.append(h('tr', {}, h('td', {text: t.name}), h('td', {class: 'mono', text: t.host}), h('td', {text: (t.type || 'icmp').toUpperCase() + (t.port ? ':' + t.port : '')}),
            h('td', {text: t.parent || '—'}), h('td', {text: t.group || 'auto'}), h('td', {text: t.interval ? t.interval + ' s' : 'padrão'}),
            h('td', {class: 'num'}, tbtn('', 'eye', () => openSheet('target', {name: t.name})), ' ',
              tbtn('', 'trash', async () => {
                if (needAdmin() || !confirm(`Remover "${t.name}"?`)) return;
                if (await act(() => del('/api/settings/targets/' + encodeURIComponent(t.name)), 'Removido')) { NN.loadTargets(); ctx.reopen(); }
              }, 'danger'))));
        }
        tbl.append(tb);
        R.append(sec('globe', `Destinos (${cfg.targets.length})`, h('div', {style: {overflowX: 'auto'}}, tbl)));
        // adicionar
        const nm = inp({placeholder: 'Nome'}), host = inp({placeholder: 'IP, host ou https://url'});
        const type = select([['icmp', 'ICMP (ping)'], ['tcp', 'TCP (porta)'], ['http', 'HTTP(S)']], 'icmp');
        const port = inp({type: 'number', placeholder: '443'}), status = inp({type: 'number', placeholder: '200 (opcional)'});
        const parent = select([['', '🌐 Raiz'], ...cfg.targets.map(t => [t.name, t.name])], '');
        const ivl = inp({type: 'number', placeholder: 'padrão'});
        const grp = inp({placeholder: 'automático', maxlength: 30, list: 'grpAdd'});
        const grpDl = h('datalist', {id: 'grpAdd'}, ...[...new Set(cfg.targets.map(x => x.group).filter(Boolean).concat(['Servidores', 'Rede local', 'Wi-Fi', 'Câmeras', 'Internet']))].map(g => h('option', {value: g})));
        const portF = field('Porta', port), stF = field('Status HTTP esperado', status);
        const sync = () => { portF.hidden = type.value !== 'tcp'; stF.hidden = type.value !== 'http'; };
        type.addEventListener('change', sync); sync();
        R.append(sec('plus', 'Adicionar destino', h('div', {class: 'form'},
          h('div', {class: 'row2'}, field('Nome', nm), field('Host / URL', host)),
          h('div', {class: 'row2'}, field('Tipo', type), field('Depende de', parent)),
          h('div', {class: 'row2'}, portF, stF, field('Intervalo próprio (s)', ivl)),
          h('div', {class: 'row2'}, field('Grupo no mapa', grp), grpDl),
          h('div', {class: 'hint', text: 'Dica: Instagram/Facebook limitam ICMP e geram "perda" falsa. Use HTTP (https://www.instagram.com) ou TCP 443.'}),
          h('div', {}, tbtn('Adicionar', 'plus', async () => {
            if (needAdmin()) return;
            const body = {name: nm.value.trim(), host: host.value.trim(), type: type.value, parent: parent.value || null};
            if (type.value === 'tcp') body.port = +port.value;
            if (type.value === 'http' && status.value) body.expect_status = +status.value;
            if (ivl.value) body.interval = +ivl.value;
            if (grp.value.trim()) body.group = grp.value.trim();
            if (await act(() => post('/api/settings/targets', body), 'Destino adicionado')) { NN.loadTargets(); ctx.reopen(); }
          }, 'primary')))));
        // DNS
        const dl = h('div', {class: 'list'});
        for (const d of cfg.dns_servers) dl.append(li('ok', d.name, d.ip, tbtn('', 'trash', async () => {
          if (needAdmin() || !confirm(`Remover DNS "${d.name}"?`)) return;
          if (await act(() => del('/api/settings/dns/' + encodeURIComponent(d.name)), 'Removido')) ctx.reopen();
        }, 'danger')));
        const dn = inp({placeholder: 'Nome'}), dip = inp({placeholder: 'IP'});
        R.append(sec('globe', 'Servidores DNS', dl, h('div', {class: 'row2', style: {marginTop: '12px'}}, dn, dip),
          h('div', {style: {marginTop: '10px'}}, tbtn('Adicionar DNS', 'plus', async () => {
            if (needAdmin()) return;
            if (await act(() => post('/api/settings/dns', {name: dn.value.trim(), ip: dip.value.trim()}), 'DNS adicionado')) ctx.reopen();
          }, 'primary'))));
      }

      if (tab === 'alertas') {
        const tg = await api('/api/settings/telegram');
        const [swEl, en] = sw('Alertas no Telegram', tg.enabled);
        const tok = inp({type: 'password', value: tg.bot_token, autocomplete: 'off'});
        const chat = inp({value: tg.chat_id});
        const sev = select([['Alta', 'Só Alta'], ['Media', 'Média e acima'], ['Baixa', 'Baixa e acima'], ['Info', 'Tudo (inclui Info)']], tg.min_severity);
        R.append(sec('bolt', 'Telegram',
          tg.min_severity === 'Info' || tg.min_severity === 'Baixa'
            ? h('div', {class: 'callout', text: 'Severidade mínima baixa: "DNS lento" e afins vão todos para o celular. Recomendado: Média.'}) : null,
          h('div', {class: 'form'}, swEl, h('div', {class: 'row2'}, field('Token do bot', tok), field('Chat ID', chat)),
            field('Enviar a partir de', sev),
            h('div', {style: {display: 'flex', gap: '8px'}},
              tbtn('Salvar', 'check', async () => {
                if (needAdmin()) return;
                await act(() => post('/api/settings/telegram', {enabled: en.checked, bot_token: tok.value, chat_id: chat.value.trim(), min_severity: sev.value}), 'Telegram salvo');
              }, 'primary'),
              tbtn('Enviar teste', 'play', () => act(() => post('/api/settings/telegram/test'), 'Mensagem enviada'))))));
        // bot + IA: você pergunta pelo Telegram e o NetNOC responde
        const ab = await api('/api/settings/aibot').catch(() => null);
        if (ab) {
          const [bSwEl, bEn] = sw('Responder mensagens no Telegram', ab.enabled);
          const prov = select([['none', 'Nenhuma (só comandos)'], ['gemini', 'Google Gemini (cota grátis)'], ['groq', 'Groq (cota grátis, muito rápido)']], ab.provider);
          const gKey = inp({type: 'password', value: ab.gemini_key, autocomplete: 'off', placeholder: 'AIza…'});
          const gMod = inp({value: ab.gemini_model, placeholder: 'gemini-3.5-flash-lite', list: 'aiGemModels'});
          const qKey = inp({type: 'password', value: ab.groq_key, autocomplete: 'off', placeholder: 'gsk_…'});
          const qMod = inp({value: ab.groq_model, placeholder: 'openai/gpt-oss-120b', list: 'aiGroqModels'});
          const [anyEl, anyH] = sw('Permitir ping e traceroute para qualquer IP ou site (não só os destinos)', ab.any_host);
          const [dyEl, dyH] = sw('Diário da rede no Telegram todo dia', ab.diary);
          const [ndEl, ndH] = sw('Avisar quando um aparelho novo entrar na rede (DHCP do MikroTik)', ab.new_devices);
          const [acEl, acH] = sw('Permitir ações no roteador pelo Telegram (sempre com botão de confirmação)', ab.actions);
          const dyT = inp({type: 'time', value: ab.diary_time || '07:00', style: {maxWidth: '140px'}});
          // v4.1: portas/PPPoE e reinícios
          const [poEl, poH] = sw('Permitir desligar e ligar portas do MikroTik (inclusive o PPPoE)', ab.actions_ports);
          const [rbEl, rbH] = sw('Permitir reinícios (MikroTik, DVR, servidor, NetNOC)', ab.actions_reboot);
          const rvMin = inp({type: 'number', min: 0, max: 1440, value: ab.revert_min ?? 5, style: {maxWidth: '110px'}});
          const RA = [['dvr', 'DVR'], ['netnoc', 'Serviço do NetNOC'], ['mikrotik', 'MikroTik'], ['servidor', 'Servidor (Raspberry Pi)']];
          const raChk = {};
          const raBox = h('div', {style: {display: 'flex', gap: '18px', flexWrap: 'wrap'}}, ...RA.map(([k, l]) => {
            const [el, c] = sw(l, (ab.restart_all || []).includes(k)); raChk[k] = c; return el; }));
          const sudoWarn = ab.sudo_ok ? null : h('div', {class: 'callout', text: 'Para reiniciar o servidor ou o NetNOC pelo Telegram, rode uma vez no Pi, na pasta do NetNOC: ./install.sh --permitir-reinicio (libera só esses dois comandos). MikroTik e DVR não precisam disso.'});
          const gBox = h('div', {class: 'form'}, h('div', {class: 'row2'}, field('Chave do Gemini', gKey), field('Modelo', gMod)),
            h('datalist', {id: 'aiGemModels'}, ...['gemini-3.5-flash-lite', 'gemini-3.8-flash'].map(v => h('option', {value: v}))),
            h('div', {class: 'hint'}, 'Chave grátis em ', h('a', {href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener', text: 'aistudio.google.com/apikey'}),
              '. Flash-Lite tem cota grátis maior; o 3.8 Flash raciocina melhor, mas a cota grátis é bem menor.'));
          const qBox = h('div', {class: 'form'}, h('div', {class: 'row2'}, field('Chave do Groq', qKey), field('Modelo', qMod)),
            h('datalist', {id: 'aiGroqModels'}, ...['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'].map(v => h('option', {value: v}))),
            h('div', {class: 'hint'}, 'Chave grátis em ', h('a', {href: 'https://console.groq.com/keys', target: '_blank', rel: 'noopener', text: 'console.groq.com/keys'}),
              '. Se o Groq aposentar o modelo, troque aqui pelo que ele indicar.'));
          const syncP = () => { gBox.hidden = prov.value !== 'gemini'; qBox.hidden = prov.value !== 'groq'; };
          prov.addEventListener('change', syncP); syncP();
          const st = ab.status || {};
          const stLine = st.last_error && (!st.last_msg_ts || st.last_error_ts > st.last_msg_ts)
            ? h('div', {class: 'callout', text: `Último erro (${dmhm(st.last_error_ts)}): ${st.last_error}`})
            : st.last_msg_ts ? h('div', {class: 'hint', text: `Última mensagem recebida: ${dmhm(st.last_msg_ts)}`}) : null;
          const q = inp({placeholder: 'Ex.: como está o ping pro Google?  ou  /status'});
          const out = h('pre', {class: 'ai-out', hidden: true});
          const ask = async () => {
            if (needAdmin()) return;
            out.hidden = false; out.textContent = 'Pensando…';
            const r = await act(() => post('/api/settings/aibot/test', {question: q.value.trim()}));
            out.textContent = r ? r.answer + `\n\n— ${r.secs}s` + (r.tools && r.tools.length ? ' · consultou: ' + r.tools.join(', ') : '') : 'Falhou (veja o aviso).';
          };
          q.addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
          R.append(sec('bolt', 'Bot e IA no Telegram',
            ab.telegram_ready ? null : h('div', {class: 'callout', text: 'Preencha o token do bot e o Chat ID acima: o bot só conversa com esse chat.'}),
            h('div', {class: 'form'}, bSwEl,
              h('div', {class: 'hint', text: 'Comandos: /status, /ping <destino ou IP>, /trace <destino>, /diagnostico [destino], /diario, /banda, /aparelhos, /alertas, /mk, /portas, /cameras. Com uma IA ativa, dá para pedir em português: "a internet caiu essa noite?", "me manda a foto do portão", "desliga a porta do roteador por 10 min", "reinicia tudo".'}),
              field('IA', prov), gBox, qBox, anyEl,
              h('div', {style: {display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'}}, dyEl, dyT,
                tbtn('Ver diário agora', 'file', async () => {
                  out.hidden = false; out.textContent = 'Montando…';
                  const r = await act(() => post('/api/diary/test'));
                  out.textContent = r ? r.text : 'Falhou.';
                })),
              h('div', {class: 'hint', text: 'Resumo das últimas 24 h com as quedas e a causa de cada uma. Também pelo comando /diario.'}),
              ndEl, acEl,
              h('div', {class: 'hint', text: 'Ações: /pppoe (reinicia a conexão), /acordar <PC> (Wake-on-LAN), /bloquear e /desbloquear <aparelho>. Nada acontece sem você tocar em "Sim". Precisa de um usuário do MikroTik com permissão de escrita; o bloqueio cria uma regra "NetNOC" no firewall. /banda, /aparelhos, /portas e /cameras funcionam sempre.'}),
              poEl,
              h('div', {style: {display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap'}}, h('span', {class: 'hint', text: 'Volta automática:'}), rvMin, h('span', {class: 'hint', text: 'min (0 = só religa quando você pedir)'})),
              h('div', {class: 'hint', text: '/desligar <porta ou pppoe> [min] e /religar <porta>. A porta é achada pelo nome (ether3) ou pelo comentário no MikroTik ("roteador", "AP sala"). Com tempo acima de 0, a porta religa sozinha (agendado no MikroTik ou, se o device-mode bloquear, pelo NetNOC). Com 0, só religa quando você pedir; se for o PPPoE, o Telegram para junto: religue em MikroTik → Portas, na rede de casa. A porta em que o servidor está ligado nunca é desligada.'}),
              rbEl,
              h('div', {class: 'hint', text: '"Reinicia tudo" (/reiniciar tudo) inclui:'}), raBox,
              h('div', {class: 'hint', text: 'Ordem: DVR, NetNOC, MikroTik e o servidor por último, com uma confirmação só. O bot avisa quando cada um volta. Reiniciar o DVR precisa de um usuário administrador do DVR.'}),
              sudoWarn,
              stLine,
              h('div', {style: {display: 'flex', gap: '8px'}},
                tbtn('Salvar', 'check', async () => {
                  if (needAdmin()) return;
                  if (await act(() => post('/api/settings/aibot', {enabled: bEn.checked, provider: prov.value, gemini_key: gKey.value, gemini_model: gMod.value.trim(),
                    groq_key: qKey.value, groq_model: qMod.value.trim(), any_host: anyH.checked, diary: dyH.checked, diary_time: dyT.value || '07:00', actions: acH.checked, new_devices: ndH.checked,
                    actions_ports: poH.checked, actions_reboot: rbH.checked, revert_min: rvMin.value === '' ? 5 : +rvMin.value,
                    restart_all: RA.map(r => r[0]).filter(k => raChk[k].checked)}), 'Bot salvo')) ctx.reopen();
                }, 'primary')),
              h('div', {class: 'hint', text: 'Teste aqui sem o celular (salve antes):'}),
              h('div', {style: {display: 'flex', gap: '8px'}}, q, tbtn('Perguntar', 'play', ask)), out)));
        }
        const mt = await api('/api/maintenance').catch(() => []);
        const ml = h('div', {class: 'list'});
        const now = Date.now() / 1000;
        for (const m of mt.filter(x => x.end > now)) {
          ml.append(li(m.start <= now ? 'media' : 'baixa', m.name, `${dmhm(m.start)} → ${dmhm(m.end)}${m.targets.length ? ' · ' + m.targets.join(', ') : ' · todos'}`,
            tbtn('', 'trash', async () => { if (!needAdmin() && await act(() => del('/api/maintenance/' + m.id), 'Removida')) ctx.reopen(); }, 'danger')));
        }
        if (!ml.children.length) ml.append(h('div', {class: 'hint', text: 'Nenhuma janela de manutenção agendada.'}));
        const mn = inp({placeholder: 'Ex.: troca do roteador'}), mh = inp({type: 'number', value: 2, min: 1, max: 720});
        R.append(sec('calendar', 'Manutenção (silencia notificações)', ml, h('div', {class: 'row2', style: {marginTop: '12px'}}, field('Descrição', mn), field('Duração a partir de agora (h)', mh)),
          h('div', {style: {marginTop: '10px'}}, tbtn('Agendar agora', 'plus', async () => {
            if (needAdmin() || !mn.value.trim()) return;
            const s = Date.now() / 1000;
            if (await act(() => post('/api/maintenance', {name: mn.value.trim(), start: s, end: s + mh.value * 3600}), 'Manutenção agendada')) ctx.reopen();
          }, 'primary'))));
        const nc = await api('/api/settings/notify').catch(() => null);
        if (nc) notifyForm(nc, R, ctx);
      }

      if (tab === 'aparencia') {
        const SK = window.SKIN, st = SK.get();
        const reopen = () => ctx.reopen({tab: 'aparencia'});
        R.append(sec('moon', 'Modo',
          h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Automático: escuro das 18h às 7h e claro de dia (troca sozinho, sem recarregar).'}),
          seg(SK.MODES.map(([k, l]) => [k, l.replace(/ \(.*\)$/, '')]), st.mode, m => { SK.set({mode: m}); reopen(); })));
        R.append(sec('layers', 'Tamanho da interface',
          h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Só neste aparelho. O Modo TV não muda.'}),
          seg(Object.entries(SK.DENS).map(([k, v]) => [k, v[0]]), SK.density(), d => { SK.density(d); reopen(); })));
        const srv = SK.serverDefault(), own = SK.isDeviceOverride();
        const mName = m => (SK.MODES.find(x => x[0] === m) || [, m])[1].replace(/ \(.*\)$/, '').toLowerCase();
        R.append(sec('server', 'Padrão do servidor',
          h('div', {class: 'hint', style: {marginBottom: '10px'}, text: own
            ? `Este aparelho usa uma escolha própria. O padrão do servidor é ${mName(srv.mode)}.`
            : `Este aparelho segue o padrão do servidor (${mName(srv.mode)}). Escolher um modo acima vale só para este aparelho.`}),
          h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}},
            tbtn('Usar o modo atual como padrão', 'check', async () => {
              if (needAdmin()) return;
              if (await act(() => post('/api/settings/ui', {skin: 'pro', mode: SK.get().mode}), 'Padrão do servidor atualizado')) {
                await SK.syncServer(); reopen();
              }
            }, 'primary'),
            own ? tbtn('Seguir o padrão do servidor', 'refresh', () => { SK.followServer(); reopen(); }) : null)));
        R.append(sec('link', 'Quiosque / TV', h('div', {class: 'hint', text: 'Para fixar o modo numa tela sem mexer nas configurações, use a URL:'}),
          h('div', {class: 'out', style: {marginTop: '8px'}, text: `${location.origin}/?modo=dark#tv\n${location.origin}/?modo=auto&densidade=normal`})));
      }

      if (tab === 'seg' && NN.isAdmin()) {
        // ---- segredos em repouso (v3.14)
        const inv = await api('/api/security/secrets').catch(() => null);
        if (inv) {
          const k = inv.key;
          const used = inv.items.filter(i => i.state !== 'vazio');
          const list = h('div', {class: 'list'});
          for (const i of used) list.append(li(i.state === 'cifrado' ? 'ok' : 'alta', i.label + (i.field ? ' · ' + i.field : ''), null, i.state));
          R.append(sec('lock', 'Senhas e tokens salvos',
            h('div', {class: inv.plain ? 'callout' : 'callout blue', text: inv.plain
              ? `${inv.plain} segredo(s) em texto puro. Reinicie o NetNOC (ele cifra na partida) ou rode: python manage.py protect`
              : inv.encrypted ? `Todos os ${inv.encrypted} segredos estão cifrados (Fernet/AES) no banco. A tela nunca mostra os valores.`
                : 'Nenhuma senha ou token salvo ainda. Quando houver, ficam cifrados (Fernet/AES) no banco.'}),
            list,
            kv([['Chave', k.source === 'env' ? 'variável NETNOC_SECRET_KEY' : (k.path || '--')],
              ['Permissão', k.source === 'env' ? '--' : (k.mode || 'ausente') + (k.ok ? ' (só o dono lê)' : ' — corrigida na próxima partida')],
              ['Guardados só como hash', 'senhas dos usuários e o token do /metrics']]),
            h('div', {class: 'hint', text: 'Trocar a chave: pare o NetNOC e o coletor e rode python manage.py rotate-key --yes (a chave anterior fica guardada como .bak).'})));
        }
        // ---- usuários (v4.0: veio da interface clássica)
        const ul = await api('/api/users').catch(() => []);
        const uList = h('div', {class: 'list'});
        for (const u of ul) {
          uList.append(li(u.role === 'admin' ? 'ok' : 'baixa', u.name, u.role === 'admin' ? 'administrador' : 'somente leitura',
            u.name === (S.me || {}).user ? h('span', {class: 'hint', text: 'você'}) : tbtn('', 'trash', async () => {
              if (!confirm('Remover o usuário ' + u.name + '? As sessões dele terminam na hora.')) return;
              if (await act(() => del('/api/users/' + encodeURIComponent(u.name)), 'Usuário removido')) ctx.reopen({tab: 'seg'});
            }, 'danger')));
        }
        const uName = inp({placeholder: 'nome', autocomplete: 'off'}), uPass = inp({type: 'password', placeholder: 'mínimo 8 caracteres', autocomplete: 'new-password'});
        const uRole = select([['viewer', 'Somente leitura'], ['admin', 'Administrador']], 'viewer');
        R.append(sec('user', 'Usuários', uList,
          h('div', {class: 'row2', style: {marginTop: '12px'}}, field('Usuário', uName), field('Senha', uPass)),
          h('div', {class: 'row2'}, field('Perfil', uRole), h('div', {style: {display: 'flex', alignItems: 'end', paddingBottom: '10px'}},
            tbtn('Salvar usuário', 'check', async () => {
              if (!uName.value.trim()) return toast('Informe o nome', 'error');
              if (await act(() => post('/api/users', {name: uName.value.trim(), password: uPass.value, role: uRole.value}), 'Usuário salvo')) ctx.reopen({tab: 'seg'});
            }, 'primary'))),
          h('div', {class: 'hint', text: 'Para trocar a senha de alguém, salve o mesmo nome com a senha nova.'})));
        // ---- token do Prometheus
        const tokOut = inp({readonly: true, placeholder: 'o token aparece aqui uma única vez', class: 'inp mono'});
        R.append(sec('chart', 'Prometheus (/metrics)',
          h('div', {class: 'hint', style: {marginBottom: '10px'}, text: 'Para o Grafana/Prometheus ler as métricas: envie Authorization: Bearer <token>. O token vale só para /metrics; gerar outro invalida o anterior.'}),
          h('div', {style: {display: 'flex', gap: '8px', flexWrap: 'wrap'}}, tokOut,
            tbtn('Gerar token', 'refresh', async () => {
              if (!confirm('Gerar um token novo invalida o anterior. Continuar?')) return;
              const r = await act(() => post('/api/settings/metrics-token'));
              if (r) { tokOut.value = r.token; tokOut.select(); }
            }, 'primary'),
            tbtn('Copiar', 'download', () => { if (tokOut.value && navigator.clipboard) navigator.clipboard.writeText(tokOut.value).then(() => toast('Copiado')); }))));
        // ---- auditoria com filtros
        const users = await api('/api/audit/users').catch(() => []);
        const fUser = select([['', 'Todos os usuários']].concat(users.map(u => [u, u])), '');
        const fKind = select([['', 'Tudo'], ['login', 'Entradas e saídas'], ['negado', 'Negado / falhas'], ['config', 'Alterações']], '');
        const fHours = select([['24', 'Últimas 24 h'], ['168', '7 dias'], ['720', '30 dias'], ['0', 'Tudo']], '168');
        const fQ = inp({type: 'search', placeholder: 'Buscar na ação ou detalhe'});
        const out = h('div', {class: 'list'});
        const fmt = ts => new Date(ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
        const sevOf = r => (r.action === 'login_falhou' || /^negado/.test(r.detail || '')) ? 'alta' : /^(erro|recusado)/.test(r.detail || '') ? 'media' : (r.action === 'login' || r.action === 'logout') ? 'ok' : '';
        async function loadAudit() {
          const q = new URLSearchParams({limit: '300', user: fUser.value, kind: fKind.value, hours: fHours.value, q: fQ.value.trim()});
          const rows = await api('/api/audit?' + q).catch(e => { toast(e.message, 'error'); return []; });
          if (!ctx.alive) return;
          clear(out);
          if (!rows.length) { out.append(h('div', {class: 'hint', text: 'Nada registrado com esses filtros.'})); return; }
          for (const r of rows) out.append(li(sevOf(r), `${r.user} · ${r.action}`, [r.detail, r.ip].filter(Boolean).join(' · '), fmt(r.ts)));
        }
        let qt = null;
        fQ.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(loadAudit, 300); });
        ctx.cleanups.push(() => clearTimeout(qt));
        [fUser, fKind, fHours].forEach(e => e.addEventListener('change', loadAudit));
        R.append(sec('shield', 'Auditoria',
          h('div', {class: 'hint', text: 'Toda alteração (quem, de onde, o quê e se deu certo), entradas, saídas, senhas erradas e tentativas negadas.'}),
          h('div', {class: 'row2'}, field('Usuário', fUser), field('Tipo', fKind), field('Período', fHours), field('Busca', fQ)),
          out));
        loadAudit();
      }

      if (tab === 'integ') {
        const [mt, agh, dv] = await Promise.all([api('/api/settings/mikrotik'), api('/api/settings/agh'), api('/api/settings/dvr').catch(() => null)]);
        integForm('mikrotik', mt, R);
        if (NN.isAdmin()) await syslogForm(R, ctx, mt);
        integForm('agh', agh, R);
        if (dv) dvrForm(dv, R, ctx);
      }
    },
  });
})();
