// Página "Ferramentas": traceroute, IPv4×IPv6, descoberta de rede e relatório de SLA.
(function () {
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

  function traceCard() {
    const host = h('input', {id: 'trHost', placeholder: 'host ou IP (ex.: 8.8.8.8)', 'aria-label': 'Host', required: true});
    const out = h('div', {class: 'tool-out'});
    const btn = h('button', {type: 'button', text: 'Executar', onclick: async () => {
      if (!host.value.trim()) return;
      busy(btn, true, 'Rastreando…'); out.replaceChildren(skeleton(4));
      try {
        const d = await apiJSON('GET', '/api/tools/traceroute?host=' + encodeURIComponent(host.value.trim()));
        out.replaceChildren(h('table', {class: 'data-table'},
          h('thead', {}, h('tr', {}, ['#', 'IP', 'ms'].map(t => h('th', {text: t})))),
          h('tbody', {}, d.hops.map(x => h('tr', {}, h('td', {text: x.hop}), h('td', {text: x.ip || '* * *'},),
            h('td', {text: x.ms != null ? x.ms.toFixed(1) : '–'}))))));
      } catch (e) { out.replaceChildren(emptyState('Erro: ' + e.message)); }
      busy(btn, false, 'Executar');
    }});
    host.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    return card('Traceroute', h('div', {}, h('div', {class: 'x-controls'}, host, btn), out));
  }

  function v6Card() {
    const host = h('input', {id: 'v6Host', placeholder: 'ex.: google.com', 'aria-label': 'Host'});
    const out = h('div', {class: 'tool-out'});
    const btn = h('button', {type: 'button', text: 'Comparar', onclick: async () => {
      if (!host.value.trim()) return;
      busy(btn, true, 'Medindo…'); out.replaceChildren(skeleton(3));
      try {
        const d = await apiJSON('GET', '/api/tools/ipcompare?host=' + encodeURIComponent(host.value.trim()));
        const row = (n, x) => h('tr', {}, h('td', {text: n}), h('td', {text: x.address || x.error || '–'}),
          h('td', {text: x.avg_ms != null ? x.avg_ms + ' ms' : '–'}), h('td', {text: x.loss_pct != null ? x.loss_pct + '%' : '–'}));
        out.replaceChildren(h('table', {class: 'data-table'},
          h('thead', {}, h('tr', {}, ['Família', 'Endereço', 'Latência', 'Perda'].map(t => h('th', {text: t})))),
          h('tbody', {}, row('IPv4', d.ipv4), row('IPv6', d.ipv6))),
          h('p', {class: 'hint', text: d.diff_ms == null ? 'Sem dados suficientes para comparar.'
            : (d.diff_ms > 0 ? 'IPv6 está ' + d.diff_ms + ' ms mais lento.' : 'IPv6 está ' + Math.abs(d.diff_ms) + ' ms mais rápido (ou igual).')}));
      } catch (e) { out.replaceChildren(emptyState('Erro: ' + e.message)); }
      busy(btn, false, 'Comparar');
    }});
    host.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    return card('IPv4 × IPv6', h('div', {}, h('div', {class: 'x-controls'}, host, btn), out));
  }

  function discoverCard() {
    const cidr = h('input', {id: 'dsCidr', placeholder: '192.168.1.0/24', 'aria-label': 'Rede (CIDR)'});
    const out = h('div', {class: 'tool-out'});
    const btn = h('button', {type: 'button', text: 'Varrer', onclick: async () => {
      busy(btn, true, 'Varrendo…'); out.replaceChildren(skeleton(4));
      try {
        const {job} = await apiJSON('POST', '/api/tools/discover', {cidr: cidr.value.trim()});
        let st;
        do {
          await new Promise(r => setTimeout(r, 1200));
          st = await apiJSON('GET', '/api/tools/discover/' + job);
          btn.textContent = 'Varrendo… ' + st.done + '/' + st.total;
        } while (st.status === 'running');
        if (!st.found.length) { out.replaceChildren(emptyState('Nenhum host respondeu.')); }
        else out.replaceChildren(h('table', {class: 'data-table'},
          h('thead', {}, h('tr', {}, ['IP', 'Nome', 'MAC', 'ms', ''].map(t => h('th', {text: t})))),
          h('tbody', {}, st.found.map(f => h('tr', {}, h('td', {text: f.ip}), h('td', {text: f.hostname || '–'}), h('td', {text: f.mac || '–'}),
            h('td', {text: f.latency.toFixed(1)}),
            h('td', {}, f.monitored ? h('span', {class: 'hint', text: '✔ monitorado'}) :
              h('button', {type: 'button', class: 'mini-btn admin-only', text: '+ Monitorar', onclick: async ev => {
                const name = prompt('Nome do destino:', f.hostname || f.ip);
                if (!name) return;
                try { await apiJSON('POST', '/api/settings/targets', {name: name.trim(), host: f.ip}); ev.target.replaceWith(h('span', {class: 'hint', text: '✔ adicionado'}));
                  if (typeof loadSettings === 'function') loadSettings(); }
                catch (e) { showToast(e.message, 'error'); }
              }})))))));
      } catch (e) { out.replaceChildren(emptyState('Erro: ' + e.message)); }
      busy(btn, false, 'Varrer');
    }});
    return card('Descoberta de rede (ICMP + ARP)', h('div', {}, h('div', {class: 'x-controls'}, cidr, btn,
      h('span', {class: 'hint', text: 'Só redes privadas, até /22.'})), out));
  }

  function slaCard() {
    const mode = h('select', {id: 'slaMode', 'aria-label': 'Período'},
      h('option', {value: 'days:7', text: 'Últimos 7 dias'}), h('option', {value: 'days:30', text: 'Últimos 30 dias', selected: true}),
      h('option', {value: 'days:90', text: 'Últimos 90 dias'}), h('option', {value: 'month', text: 'Mês específico…'}));
    const month = h('input', {type: 'month', id: 'slaMonth', 'aria-label': 'Mês', style: {display: 'none'}});
    mode.addEventListener('change', () => { month.style.display = mode.value === 'month' ? '' : 'none'; });
    const out = h('div', {class: 'tool-out'});
    const qs = () => mode.value === 'month' ? 'month=' + encodeURIComponent(month.value) : 'days=' + mode.value.split(':')[1];
    const csv = h('a', {class: 'mini-btn', href: '#', text: '⬇ CSV', onclick: ev => { ev.preventDefault(); location.href = '/api/sla.csv?' + qs(); }});
    const rep = h('a', {class: 'mini-btn', href: '#', text: '🖨 Relatório / PDF', onclick: ev => { ev.preventDefault(); window.open('/report.html?' + qs(), '_blank', 'noopener'); }});
    const btn = h('button', {type: 'button', text: 'Gerar', onclick: async () => {
      busy(btn, true, 'Calculando…'); out.replaceChildren(skeleton(4));
      try {
        const d = await apiJSON('GET', '/api/sla?' + qs());
        const pct = v => v == null ? '–' : v.toFixed(3) + '%';
        out.replaceChildren(h('table', {class: 'data-table'},
          h('thead', {}, h('tr', {}, ['Alvo', 'Disponib.', 'Latência', 'Quedas', 'Tempo fora', 'MTTR', 'MTBF'].map(t => h('th', {text: t})))),
          h('tbody', {}, d.targets.map(t => h('tr', {}, h('td', {text: t.target}),
            h('td', {class: t.availability_pct != null && t.availability_pct < 99.9 ? 'bad-text' : '', text: pct(t.availability_pct)}),
            h('td', {text: t.avg_latency_ms != null ? t.avg_latency_ms + ' ms' : '–'}), h('td', {text: t.outages}),
            h('td', {text: fmtDur(t.downtime_s)}), h('td', {text: fmtDur(t.mttr_s)}), h('td', {text: fmtDur(t.mtbf_s)}))))));
      } catch (e) { out.replaceChildren(emptyState('Erro: ' + e.message)); }
      busy(btn, false, 'Gerar');
    }});
    return card('SLA e relatórios', h('div', {}, h('div', {class: 'x-controls'}, mode, month, btn, csv, rep), out));
  }

  window.addEventListener('load', () => {
    const page = addPage('ferramentas', 'Ferramentas', '🧰', 'Ferramentas', 'Diagnóstico de rede e relatórios de SLA', null);
    page.append(h('div', {class: 'x-grid'}, traceCard(), v6Card()), discoverCard(), slaCard());
  });
})();
