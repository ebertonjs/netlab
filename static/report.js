(function () {
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const dur = s => { if (s == null) return '–'; s = Math.round(s); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's'; };
  const f = ts => new Date(ts * 1000).toLocaleString('pt-BR');
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  fetch('/api/settings/appname').then(r => r.json()).then(a => { if (a && a.name) document.title = 'Relatório de SLA — ' + a.name; }).catch(() => {});
  const qs = location.search || '?days=30';
  fetch('/api/sla' + qs).then(r => { if (!r.ok) throw new Error('Erro ' + r.status); return r.json(); }).then(d => {
    document.getElementById('period').textContent = f(d.start) + ' → ' + f(d.end) + ' · gerado em ' + f(Date.now() / 1000);
    const t = el('table'), hd = el('tr');
    ['Alvo', 'Disponibilidade', '', 'Latência média', 'Quedas', 'Tempo fora', 'MTTR', 'MTBF'].forEach(x => hd.append(el('th', null, x)));
    t.append(hd);
    d.targets.forEach(r => {
      const tr = el('tr'); tr.append(el('td', null, r.target));
      tr.append(el('td', 'n' + (r.availability_pct != null && r.availability_pct < 99.9 ? ' bad' : ''), r.availability_pct != null ? r.availability_pct.toFixed(3) + '%' : '–'));
      const b = el('td'), bar = el('div', 'bar'), i = el('i'); i.style.width = (r.availability_pct || 0) + '%'; bar.append(i); b.append(bar); tr.append(b);
      tr.append(el('td', 'n', r.avg_latency_ms != null ? r.avg_latency_ms + ' ms' : '–'), el('td', 'n', String(r.outages)),
        el('td', 'n', dur(r.downtime_s)), el('td', 'n', dur(r.mttr_s)), el('td', 'n', dur(r.mtbf_s)));
      t.append(tr);
    });
    document.getElementById('out').replaceChildren(t);
  }).catch(e => { document.getElementById('out').textContent = e.message; });
})();
