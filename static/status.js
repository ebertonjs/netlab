(function () {
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const fmt = ts => new Date(ts * 1000).toLocaleString('pt-BR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
  const dur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? h + 'h ' + m + 'min' : m + 'min'; };
  async function load() {
    const items = document.getElementById('items'), banner = document.getElementById('banner');
    let d;
    try {
      const r = await fetch('/api/public/status', {cache: 'no-store'});
      if (!r.ok) throw new Error(r.status === 404 ? 'Página de status não habilitada.' : 'Erro ' + r.status);
      d = await r.json();
    } catch (e) {
      banner.className = 'banner'; banner.textContent = e.message; items.replaceChildren(); return;
    }
    document.title = d.title + (d.app ? ' — ' + d.app : ''); document.getElementById('title').textContent = d.title;
    document.getElementById('updated').textContent = 'Atualizado em ' + new Date(d.updated * 1000).toLocaleTimeString('pt-BR');
    const msg = {ok: '✔ Todos os sistemas operacionais', degraded: '⚠ Instabilidade em alguns serviços', down: '✖ Serviços indisponíveis', unknown: 'Sem dados'};
    banner.className = 'banner ' + d.overall; banner.textContent = msg[d.overall] || msg.unknown;
    items.replaceChildren(...d.targets.map(t => {
      const box = el('div', 'item'), row = el('div', 'row');
      row.append(el('span', null, t.name));
      const st = el('span', 'st ' + (t.online === true ? 'ok' : t.online === false ? 'bad' : 'na'),
        (t.online === true ? '▲ Operacional' : t.online === false ? '▼ Fora do ar' : '● Sem dados') + (t.uptime_24h != null ? ' · ' + t.uptime_24h + '% (24h)' : ''));
      row.append(st);
      const bars = el('div', 'bars');
      t.bars.forEach(b => {
        const x = el('div', 'bar ' + (b.pct == null ? '' : b.pct >= 99.5 ? 'ok' : b.pct >= 95 ? 'warn' : 'bad'));
        x.title = b.date + ' — ' + (b.pct == null ? 'sem dados' : b.pct + '%'); bars.append(x);
      });
      const lg = el('div', 'legend'); lg.append(el('span', null, '30 dias atrás'), el('span', null, 'hoje'));
      box.append(row, bars, lg); return box;
    }));
    const inc = document.getElementById('incs');
    inc.replaceChildren(...(d.incidents.length ? d.incidents.map(i =>
      el('div', 'inc', i.target + ' — ' + fmt(i.started) + (i.resolved ? ' (' + dur(i.resolved - i.started) + ')' : ' — em andamento')))
      : [el('div', 'empty', 'Nenhum incidente nos últimos 7 dias.')]));
  }
  load(); setInterval(load, 60000);
})();
