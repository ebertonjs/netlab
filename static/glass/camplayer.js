// NetNOC — player de câmeras (MSE via WebSocket do go2rtc, passando pelo NetNOC).
// Protocolo: envia {"type":"mse","value":"<codecs suportados>"}, recebe {"type":"mse","value":"<mime>"} e depois
// fragmentos fMP4 binários. Lógica de buffer baseada no video-rtc.js do go2rtc (MIT, AlexxIT).
'use strict';
(function () {
  const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'avc1.4D401F', 'avc1.42E01E', 'hvc1.1.6.L153.B0'];

  function play(video, src, onState) {
    const state = s => { try { onState && onState(s); } catch (_) { /* ok */ } };
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (!MS) { state('error:Navegador sem suporte a vídeo ao vivo (MSE)'); return {stop() {}}; }
    let closed = false, ws = null, ms = null, sb = null, queue = [], retry = null, tries = 0;

    function pump() {
      if (!sb || sb.updating || closed) return;
      if (queue.length) {
        const len = queue.reduce((a, b) => a + b.byteLength, 0), data = new Uint8Array(len);
        let o = 0;
        for (const b of queue) { data.set(b, o); o += b.byteLength; }
        queue = [];
        try { sb.appendBuffer(data); } catch (e) {
          if (e.name === 'QuotaExceededError' && sb.buffered.length) { try { sb.remove(sb.buffered.start(0), sb.buffered.end(sb.buffered.length - 1) - 2); } catch (_) { /* ok */ } }
        }
        return;
      }
      if (sb.buffered && sb.buffered.length) {
        const end = sb.buffered.end(sb.buffered.length - 1), start = end - 5, start0 = sb.buffered.start(0);
        if (start > start0) {
          try { sb.remove(start0, start); if (ms.setLiveSeekableRange) ms.setLiveSeekableRange(start, end); } catch (_) { /* ok */ }
          return;
        }
        if (video.currentTime < start) video.currentTime = start;
        const gap = end - video.currentTime;           // mantém o vídeo colado no "ao vivo"
        video.playbackRate = Math.max(0.6, Math.min(2.5, gap > 0.1 ? gap : 0.6));
      }
    }

    function connect() {
      ms = new MS();
      const isManaged = MS === window.ManagedMediaSource;
      ms.addEventListener('sourceopen', () => {
        if (!isManaged) URL.revokeObjectURL(video.src);
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/api/cam/ws?src=${encodeURIComponent(src)}`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          const codecs = CODECS.filter(c => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join();
          if (!/avc1/.test(codecs)) { state('error:Este navegador não toca vídeo H.264 (use Chrome, Edge, Safari ou o navegador do Android)'); }
          ws.send(JSON.stringify({type: 'mse', value: codecs}));
        };
        ws.onmessage = ev => {
          if (typeof ev.data === 'string') {
            let j; try { j = JSON.parse(ev.data); } catch (_) { return; }
            if (j.type === 'mse') {
              try {
                sb = ms.addSourceBuffer(j.value);
                sb.mode = 'segments';
                sb.addEventListener('updateend', pump);
              } catch (e) {
                state('error:' + (/hvc1|hev1/.test(j.value) ? 'Stream em H.265 — o navegador não toca. Mude para H.264 no DVR (Câmera → Codificação).'
                  : 'Codec não suportado por este navegador (' + j.value + ').'));
              }
            } else if (j.type === 'error') {
              state('error:' + String(j.value || 'erro no vídeo').slice(0, 160));
            }
            return;
          }
          queue.push(new Uint8Array(ev.data));
          pump();
        };
        ws.onclose = ev => {
          if (closed) return;
          if (ev.code === 1008) { state('error:Sessão expirada — entre novamente'); return; }
          state('reconnecting');
          tries++;
          retry = setTimeout(restart, Math.min(15000, 2000 * tries));   // DVR caiu/reiniciou: tenta de novo
        };
      }, {once: true});
      if (isManaged) { video.disableRemotePlayback = true; video.srcObject = ms; } else { video.srcObject = null; video.src = URL.createObjectURL(ms); }
      video.muted = true; video.playsInline = true;
      video.play().catch(() => { /* autoplay: muted já resolve */ });
    }
    function teardown() {
      if (ws) { ws.onclose = null; try { ws.close(); } catch (_) { /* ok */ } ws = null; }
      sb = null; queue = [];
      try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch (_) { /* ok */ }
      video.pause(); video.removeAttribute('src'); video.srcObject = null;
      try { video.load(); } catch (_) { /* ok */ }
    }
    function restart() { if (closed) return; teardown(); connect(); }

    const onPlaying = () => { tries = 0; state('playing'); };
    video.addEventListener('playing', onPlaying);
    state('connecting');
    connect();
    return {
      stop() {
        closed = true; clearTimeout(retry);
        video.removeEventListener('playing', onPlaying);
        teardown();
      },
    };
  }

  window.NNCam = {play};
})();
