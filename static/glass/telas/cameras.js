// NetNOC — tela: Câmeras
'use strict';
(function () {
  const {h, clear, api, post, del, toast, ms, pct, hm, dmhm, dur, ago, bps, num, sevClass,
    brandSvg, isLocal, sparkArea, S, registerSheet, openSheet} = window.NN;
  const {css, C, pal, RANGES, RANGE_S, ui, seg, tbtn, stat, sec, chartBox, kv, panels, needAdmin, field, inp, select, sw, act, li,
    tickFmt, baseOpts, gradient, withGaps, lineDS, gatewayOf} = window.NNT;

  // ================================================================== CÂMERAS
  // Vídeo só roda com esta tela aberta e visível; ao fechar/trocar de aba os streams são encerrados.
  function camTile(ch, opts) {
    const img = h('img', {alt: '', src: `/api/cam/snapshot/${ch.ch}?last=1&t=${Date.now()}`});
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    const badge = h('span', {class: 'cam-badge', text: ch.loss ? 'SEM VÍDEO' : 'FOTO'});
    if (ch.loss) badge.classList.add('loss');
    const msg = h('div', {class: 'cam-msg'});
    const video = h('video', {muted: true, playsinline: true, autoplay: true});
    video.muted = true;
    const act = h('div', {class: 'cam-act'},
      h('a', {href: `/api/cam/snapshot/${ch.ch}`, download: `camera-${ch.ch}.jpg`, title: 'Baixar foto agora', trusted: ICO('download'), onclick: e => e.stopPropagation()}),
      opts.full ? null : h('button', {type: 'button', title: 'Tela cheia', trusted: ICO('expand'), onclick: e => { e.stopPropagation(); opts.onOpen(); }}));
    const tile = h('div', {class: 'camtile' + (opts.full ? ' full' : ''), onclick: opts.full ? null : opts.onOpen},
      img, video, h('div', {class: 'cam-top'}, h('span', {trusted: ICO('video')}), ch.name, badge), msg, act);
    return {tile, img, video, badge, msg};
  }
  function startLive(t, src) {
    return NNCam.play(t.video, src, s => {
      if (s === 'playing') { t.tile.classList.add('playing'); t.badge.className = 'cam-badge live'; t.badge.textContent = 'AO VIVO'; clear(t.msg); }
      else if (s === 'connecting' || s === 'reconnecting') { t.badge.className = 'cam-badge'; t.badge.textContent = s === 'connecting' ? 'CONECTANDO' : 'RECONECTANDO'; }
      else if (s.startsWith('error:')) { t.tile.classList.remove('playing'); t.badge.className = 'cam-badge loss'; t.badge.textContent = 'ERRO'; clear(t.msg).append(h('span', {text: s.slice(6)})); }
    });
  }

  registerSheet('cameras', {
    title: p => p.ch ? 'Câmera ' + p.ch : 'Câmeras', icon: 'camera', single: true,
    async render(ctx) {
      const st = await api('/api/cam/status');
      if (!ctx.alive) return;
      const R = h('div', {class: 'panel main'}); ctx.body.append(R);
      if (!st.enabled) {
        R.append(h('div', {class: 'callout blue'}, h('b', {text: 'DVR não configurado'}),
          'Informe o IP, usuário e senha do DVR em Configurações → Integrações. Use um usuário do DVR só com permissão de visualização.'),
        tbtn('Configurar DVR', 'gear', () => openSheet('config', {tab: 'integ'}), 'primary'));
        return;
      }
      const g2 = st.go2rtc || {};
      const liveOk = g2.binary && g2.running;
      let mode = ctx.params.mode || (liveOk ? 'live' : 'foto');
      if (!liveOk) mode = 'foto';
      const full = ctx.params.ch ? st.channels.find(c => c.ch === Number(ctx.params.ch)) : null;
      const hd = ctx.params.hd !== false;
      // ferramentas
      if (full) {
        ctx.tools.append(tbtn('Mosaico', 'grid', () => ctx.reopen({ch: null})),
          seg(st.channels.map(c => [c.ch, String(c.ch)]), full.ch, c => ctx.reopen({ch: c})));
        if (liveOk) ctx.tools.append(seg([[true, 'HD'], [false, 'Leve']], hd, v => ctx.reopen({hd: v})));
      } else if (liveOk) {
        ctx.tools.append(seg([['live', 'Ao vivo'], ['foto', 'Fotos']], mode, m => ctx.reopen({mode: m})));
      }
      if (!liveOk) {
        R.append(h('div', {class: 'callout'}, h('b', {text: 'Vídeo ao vivo indisponível — mostrando fotos'}),
          g2.binary ? (g2.error || 'O go2rtc não está rodando.') : 'O go2rtc não está instalado no servidor. Rode ./install.sh de novo para baixá-lo.'));
      }
      for (const w of st.warnings || []) R.append(h('div', {class: 'callout', text: w}));

      const tiles = [];
      if (full) {
        const t = camTile(full, {full: true});
        R.append(t.tile);
        tiles.push([full, t]);
      } else {
        const grid = h('div', {class: 'camgrid'});
        const n = st.channels.length;
        grid.style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
        for (const c of st.channels) {
          const t = camTile(c, {onOpen: () => ctx.reopen({ch: c.ch})});
          grid.append(t.tile);
          tiles.push([c, t]);
        }
        R.append(grid);
      }
      // rodapé com informações do DVR
      const hdd = (st.hdd || [])[0];
      R.append(h('div', {class: 'cam-info'},
        h('span', {}, 'DVR ', h('b', {text: (st.model || '') + (st.host ? ' · ' + st.host : '')})),
        st.version ? h('span', {}, 'Firmware ', h('b', {text: st.version})) : null,
        hdd ? h('span', {}, 'HD ', h('b', {text: hdd.error ? 'com erro' : (hdd.used_pct != null ? pct(hdd.used_pct, 0) + '% usado de ' + Math.round(hdd.total_gb) + ' GB' : (hdd.state || 'ok'))})) : null,
        h('span', {}, 'Eventos ', h('b', {text: !st.events.enabled ? 'desligados' : st.events.connected ? 'conectado' : ('desconectado' + (st.events.error ? ' (' + st.events.error + ')' : ''))})),
        h('span', {}, 'Modo ', h('b', {text: mode === 'live' ? 'ao vivo — o vídeo para quando você fecha esta tela' : 'fotos a cada 3 s'}))));

      // execução: vídeo ou fotos, só enquanto a aba estiver visível
      let running = false, photoT = null, players = [];
      function startAll() {
        if (running || !ctx.alive) return;
        running = true;
        if (mode === 'live') {
          players = tiles.map(([c, t]) => startLive(t, full ? `ch${c.ch}${hd ? '_hd' : ''}` : `ch${c.ch}`));
        } else {
          const tick = () => {
            for (const [c, t] of tiles) {
              const im = new Image();
              im.onload = () => { t.img.src = im.src; t.img.style.visibility = ''; t.badge.textContent = 'FOTO ' + hm(Date.now() / 1000); };
              im.src = `/api/cam/snapshot/${c.ch}?t=${Date.now()}`;
            }
          };
          tick();
          photoT = setInterval(tick, 3000);
        }
      }
      function stopAll() {
        running = false;
        clearInterval(photoT);
        players.forEach(p => { try { p.stop(); } catch (_) { /* ok */ } });
        players = [];
        for (const [, t] of tiles) t.tile.classList.remove('playing');
      }
      function onVis() { if (document.hidden) stopAll(); else startAll(); }
      document.addEventListener('visibilitychange', onVis);
      ctx.cleanups.push(stopAll, () => document.removeEventListener('visibilitychange', onVis));
      startAll();
    },
  });

})();
