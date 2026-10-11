// ---------- Layout livre dos cards (arrastar + redimensionar, como na Topologia) ----------
const WIDGET_LAYOUT_KEY = 'netnoc_widget_layout';
const WIDGET_DEFAULT_LAYOUT_KEY = 'netnoc_widget_default_layout';
const WIDGET_META_KEY = 'netnoc_widget_meta';
const GRID_SNAP = 10;
const MIN_W = 240;
const MIN_H = 120;

function loadWidgetLayout(){
  try{ return JSON.parse(localStorage.getItem(WIDGET_LAYOUT_KEY)) || {}; }catch(e){ return {}; }
}
function saveWidgetLayoutFor(id, patch){
  const layout = loadWidgetLayout();
  layout[id] = Object.assign({}, layout[id], patch);
  localStorage.setItem(WIDGET_LAYOUT_KEY, JSON.stringify(layout));
}
function loadWidgetMeta(){
  try{ return JSON.parse(localStorage.getItem(WIDGET_META_KEY)) || {}; }catch(e){ return {}; }
}
function saveWidgetMetaFor(id, patch){
  const meta = loadWidgetMeta();
  meta[id] = Object.assign({}, meta[id], patch);
  localStorage.setItem(WIDGET_META_KEY, JSON.stringify(meta));
}
function cleanHeaderLabel(span){
  if(!span) return '';
  const clone = span.cloneNode(true);
  clone.querySelectorAll('span,select,button,input').forEach(n => n.remove());
  return clone.textContent.replace('⠿','').trim();
}
function getWidgetDefs(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return [];
  return Array.from(grid.querySelectorAll('.widget')).map(w => ({
    el: w,
    id: w.dataset.widget,
    label: cleanHeaderLabel(w.querySelector('.panel-header > span')) || w.dataset.widget
  }));
}
function snap(v){ return Math.round(v / GRID_SNAP) * GRID_SNAP; }

// Mede a posição/tamanho atuais (resultado do CSS grid original) para usar como
// layout padrão na primeira vez que o usuário abre a dash, antes de existir algo salvo.
function measureDefaultLayout(){
  const grid = document.getElementById('widgetsGrid');
  const gridRect = grid.getBoundingClientRect();
  const layout = {};
  grid.querySelectorAll('.widget').forEach(w => {
    const r = w.getBoundingClientRect();
    layout[w.dataset.widget] = {
      x: snap(r.left - gridRect.left),
      y: snap(r.top - gridRect.top),
      w: snap(r.width),
      h: snap(r.height),
    };
  });
  return layout;
}

function applyWidgetPosition(el, pos){
  el.style.left = pos.x + 'px';
  el.style.top = pos.y + 'px';
  el.style.width = pos.w + 'px';
  el.style.minHeight = pos.h + 'px';
}

function recalcGridHeight(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;
  let maxBottom = 0;
  grid.querySelectorAll('.widget').forEach(w => {
    if(w.classList.contains('widget-hidden')) return;
    const bottom = w.offsetTop + w.offsetHeight;
    if(bottom > maxBottom) maxBottom = bottom;
  });
  grid.style.height = (maxBottom + 20) + 'px';
}

// Reorganiza os cards visíveis num masonry de colunas (sem sobreposição), preservando
// a largura relativa de cada card e a ordem de leitura atual (topo→baixo, esquerda→direita).
function autoArrangeWidgets(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;
  const cols = 3;
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--density-gap')) || 14;
  const gridWidth = grid.getBoundingClientRect().width;
  const colWidth = (gridWidth - gap * (cols - 1)) / cols;

  const defs = getWidgetDefs().filter(({el}) => !el.classList.contains('widget-hidden'));
  // Ordena pela posição atual (leitura: topo → baixo, esquerda → direita) pra manter o agrupamento que o usuário já fez
  defs.sort((a, b) => {
    const ay = Math.round(a.el.offsetTop / 40), by = Math.round(b.el.offsetTop / 40);
    if(ay !== by) return ay - by;
    return a.el.offsetLeft - b.el.offsetLeft;
  });

  const colHeights = new Array(cols).fill(0);
  defs.forEach(({el, id}) => {
    const span = Math.max(1, Math.min(cols, Math.round((el.offsetWidth + gap) / (colWidth + gap))));
    let bestStart = 0, bestHeight = Infinity;
    for(let start = 0; start <= cols - span; start++){
      const h = Math.max(...colHeights.slice(start, start + span));
      if(h < bestHeight){ bestHeight = h; bestStart = start; }
    }
    const x = bestStart * (colWidth + gap);
    const y = bestHeight;
    const w = span * colWidth + (span - 1) * gap;
    const h = el.offsetHeight;
    applyWidgetPosition(el, {x, y, w, h});
    saveWidgetLayoutFor(id, {x, y, w, h});
    for(let i = bestStart; i < bestStart + span; i++) colHeights[i] = y + h + gap;
  });

  recalcGridHeight();
  showToast('Layout reorganizado automaticamente', 'success');
}
document.getElementById('autoArrangeBtn')?.addEventListener('click', autoArrangeWidgets);
document.getElementById('autoArrangeBtn2')?.addEventListener('click', autoArrangeWidgets);

function initWidgetAppearance(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;
  // Mede o arranjo original (grid CSS) ANTES de ativar o modo livre — precisa ser feito
  // sempre nesse momento, pois depois que o grid vira "free-grid" a informação se perde.
  // O snapshot fica salvo para uso posterior em resets individuais (sem precisar recarregar a página).
  const defaultLayout = measureDefaultLayout();
  localStorage.setItem(WIDGET_DEFAULT_LAYOUT_KEY, JSON.stringify(defaultLayout));

  let layout = loadWidgetLayout();
  const hasSaved = Object.keys(layout).length > 0;
  if(!hasSaved) layout = defaultLayout;

  grid.classList.add('free-grid');

  const defs = getWidgetDefs();
  const meta = loadWidgetMeta();

  defs.forEach(({el, id}) => {
    el.removeAttribute('draggable');
    el.classList.remove('widget-wide', 'widget-full', 'widget-size-2', 'widget-size-full');

    const pos = layout[id] || {x:0, y:0, w:340, h:220};
    applyWidgetPosition(el, pos);

    const m = meta[id] || {};
    el.classList.toggle('widget-hidden', !!m.hidden);

    attachWidgetInteractions(el, id);
  });

  if(!hasSaved) localStorage.setItem(WIDGET_LAYOUT_KEY, JSON.stringify(layout));
  recalcGridHeight();
  renderWidgetManagerList();
}

function attachWidgetInteractions(el, id){
  const header = el.querySelector('.panel-header.drag-handle');
  if(!header) return;

  // Menu (⋮): ocultar / restaurar posição individual
  if(!header.querySelector('.widget-menu-wrap')){
    const wrap = document.createElement('div');
    wrap.className = 'widget-menu-wrap';
    wrap.innerHTML = `
      <button type="button" class="widget-menu-btn" title="Opções do card">⋮</button>
      <div class="widget-menu-dropdown">
        <button type="button" data-action="hide">🙈 Ocultar card</button>
        <button type="button" data-action="reset">↺ Restaurar posição/tamanho</button>
      </div>`;
    header.appendChild(wrap);

    const btn = wrap.querySelector('.widget-menu-btn');
    const dropdown = wrap.querySelector('.widget-menu-dropdown');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.widget-menu-dropdown.open').forEach(d => { if(d !== dropdown) d.classList.remove('open'); });
      dropdown.classList.toggle('open');
    });
    wrap.querySelector('[data-action="hide"]').addEventListener('click', () => {
      el.classList.add('widget-hidden');
      saveWidgetMetaFor(id, {hidden:true});
      dropdown.classList.remove('open');
      recalcGridHeight();
      renderWidgetManagerList();
    });
    wrap.querySelector('[data-action="reset"]').addEventListener('click', () => {
      let defaults = {};
      try{ defaults = JSON.parse(localStorage.getItem(WIDGET_DEFAULT_LAYOUT_KEY)) || {}; }catch(e){}
      const def = defaults[id];
      if(def){
        applyWidgetPosition(el, def);
        saveWidgetLayoutFor(id, def);
        recalcGridHeight();
      }
      dropdown.classList.remove('open');
    });
  }

  // Alça de redimensionar (canto inferior direito)
  if(!el.querySelector('.resize-handle')){
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = 'Arraste para redimensionar';
    el.appendChild(handle);

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;
      el.classList.add('resizing');

      function onMove(ev){
        const w = Math.max(MIN_W, snap(startW + (ev.clientX - startX)));
        const h = Math.max(MIN_H, snap(startH + (ev.clientY - startY)));
        el.style.width = w + 'px';
        el.style.minHeight = h + 'px';
        recalcGridHeight();
      }
      function onUp(){
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        el.classList.remove('resizing');
        saveWidgetLayoutFor(id, {w: el.offsetWidth, h: el.offsetHeight});
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  // Arrastar pelo cabeçalho para reposicionar livremente (não dispara em botões/selects/menu)
  header.addEventListener('pointerdown', (e) => {
    if(e.target.closest('button, select, input, .widget-menu-wrap')) return;
    e.preventDefault();
    header.setPointerCapture(e.pointerId);
    const grid = document.getElementById('widgetsGrid');
    const gridRect = grid.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = el.offsetLeft, startTop = el.offsetTop;
    let moved = false;

    function onMove(ev){
      moved = true;
      let x = startLeft + (ev.clientX - startX);
      let y = startTop + (ev.clientY - startY);
      x = Math.max(0, Math.min(x, gridRect.width - el.offsetWidth));
      y = Math.max(0, y);
      el.style.left = snap(x) + 'px';
      el.style.top = snap(y) + 'px';
      el.classList.add('being-dragged');
      recalcGridHeight();
    }
    function onUp(){
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', onUp);
      el.classList.remove('being-dragged');
      if(moved) saveWidgetLayoutFor(id, {x: el.offsetLeft, y: el.offsetTop});
    }
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
  });
}

document.addEventListener('click', () => {
  document.querySelectorAll('.widget-menu-dropdown.open').forEach(d => d.classList.remove('open'));
});

function renderWidgetManagerList(){
  const container = document.getElementById('widgetManagerList');
  if(!container) return;
  const defs = getWidgetDefs();
  const meta = loadWidgetMeta();
  container.innerHTML = defs.map(({id, label}) => {
    const hidden = !!(meta[id] || {}).hidden;
    return `
      <div class="widget-manager-row" data-widget-id="${id}">
        <label class="wm-name"><input type="checkbox" class="wm-visible-toggle" ${hidden ? '' : 'checked'}> ${label}</label>
      </div>`;
  }).join('') || '<div class="version-hint">Nenhum card encontrado.</div>';

  container.querySelectorAll('.widget-manager-row').forEach(row => {
    const id = row.dataset.widgetId;
    const el = document.querySelector(`#widgetsGrid [data-widget="${id}"]`);
    row.querySelector('.wm-visible-toggle').addEventListener('change', (e) => {
      const hidden = !e.target.checked;
      if(el) el.classList.toggle('widget-hidden', hidden);
      saveWidgetMetaFor(id, {hidden});
      recalcGridHeight();
    });
  });
}

document.getElementById('resetLayoutBtn')?.addEventListener('click', () => {
  localStorage.removeItem(WIDGET_LAYOUT_KEY);
  location.reload();
});

// ---------- Densidade (Aparência → Layout) ----------
const DENSITY_KEY = 'netnoc_density';
function applyDensity(value){
  document.documentElement.setAttribute('data-density', value);
  const sel = document.getElementById('densitySelect');
  if(sel) sel.value = value;
  localStorage.setItem(DENSITY_KEY, value);
}
document.getElementById('densitySelect')?.addEventListener('change', e => applyDensity(e.target.value));
(function initDensity(){
  applyDensity(localStorage.getItem(DENSITY_KEY) || 'comfortable');
})();

// ---------- Sub-tabs (dentro da aba Aparência) ----------
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const wrap = tab.closest('.panel');
    wrap.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t === tab));
    wrap.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.subtabPanel === tab.dataset.subtab));
  });
});

// ---------- Editor de cores custom (Aparência → Cores) ----------
const CUSTOM_THEME_KEY = 'netnoc_custom_theme';
const COLOR_VARS = [
  {key:'bg', label:'Fundo'},
  {key:'panel', label:'Painel'},
  {key:'panel2', label:'Painel (alt)'},
  {key:'border', label:'Borda'},
  {key:'text', label:'Texto'},
  {key:'accent', label:'Destaque'},
  {key:'green', label:'Verde (ok)'},
  {key:'red', label:'Vermelho (erro)'},
  {key:'orange', label:'Laranja (alerta)'},
  {key:'blue', label:'Azul'},
  {key:'purple', label:'Roxo'},
];
const THEME_PRESETS = {
  'dark-blue': {bg:'#0b0f19', panel:'#11172a', panel2:'#161d33', border:'#232b45', text:'#e6e9f2', accent:'#4d8dff', green:'#3ddc84', red:'#ff5c5c', orange:'#ffb23d', blue:'#4d8dff', purple:'#8a63ff'},
  'dark-green': {bg:'#0a120d', panel:'#0f1c14', panel2:'#142418', border:'#1f3526', text:'#dff5e6', accent:'#4dd0e1', green:'#39e07a', red:'#ff6b6b', orange:'#f0b74e', blue:'#4dd0e1', purple:'#7ad48f'},
  'dark-purple': {bg:'#100b1c', panel:'#181227', panel2:'#20182f', border:'#332a49', text:'#ece6f9', accent:'#8a7dff', green:'#4de0a0', red:'#ff6f91', orange:'#ffb56b', blue:'#8a7dff', purple:'#c084fc'},
  'midnight-oled': {bg:'#000000', panel:'#0a0a0a', panel2:'#131313', border:'#232323', text:'#f0f0f0', accent:'#5c9dff', green:'#3ddc84', red:'#ff5c5c', orange:'#ffb23d', blue:'#5c9dff', purple:'#a37bff'},
  'light': {bg:'#f4f6fb', panel:'#ffffff', panel2:'#eef1f8', border:'#dbe1ee', text:'#131a2b', accent:'#2f6fe0', green:'#1fa15c', red:'#e0453f', orange:'#d98b1f', blue:'#2f6fe0', purple:'#6c47d6'},
};

function loadCustomTheme(){
  try{ return JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY)); }catch(e){ return null; }
}
function applyCustomThemeVars(vars){
  const root = document.documentElement;
  COLOR_VARS.forEach(({key}) => {
    if(vars[key]) root.style.setProperty(`--${key}`, vars[key]);
  });
}
function clearCustomThemeVars(){
  const root = document.documentElement;
  COLOR_VARS.forEach(({key}) => root.style.removeProperty(`--${key}`));
}
function ensureCustomOptionInSelects(){
  [document.getElementById('themeSelect')].forEach(sel => {
    if(sel && !sel.querySelector('option[value="custom"]')){
      const opt = document.createElement('option');
      opt.value = 'custom';
      opt.textContent = '🎨 Personalizado';
      sel.appendChild(opt);
    }
  });
}
function removeCustomOptionFromSelects(){
  document.querySelectorAll('option[value="custom"]').forEach(o => o.parentElement.removeChild(o));
}
function renderColorPickers(baseTheme){
  const container = document.getElementById('colorPickerGrid');
  if(!container) return;
  const custom = loadCustomTheme();
  const source = custom || THEME_PRESETS[baseTheme] || THEME_PRESETS['dark-blue'];
  container.innerHTML = COLOR_VARS.map(({key,label}) => `
    <div class="color-picker-item">
      <label for="cpick-${key}">${label}</label>
      <input type="color" id="cpick-${key}" data-key="${key}" value="${source[key] || '#000000'}">
    </div>`).join('');

  container.querySelectorAll('input[type="color"]').forEach(input => {
    input.addEventListener('input', (e) => {
      document.documentElement.style.setProperty(`--${e.target.dataset.key}`, e.target.value);
    });
  });
}
document.getElementById('themeBaseSelect')?.addEventListener('change', e => {
  clearCustomThemeVars();
  applyTheme(e.target.value);
  renderColorPickers(e.target.value);
});
document.getElementById('saveCustomThemeBtn')?.addEventListener('click', () => {
  const vars = {};
  document.querySelectorAll('#colorPickerGrid input[type="color"]').forEach(input => {
    vars[input.dataset.key] = input.value;
  });
  localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(vars));
  ensureCustomOptionInSelects();
  document.documentElement.setAttribute('data-theme', 'custom');
  applyCustomThemeVars(vars);
  updateThemeTone();
  localStorage.setItem(THEME_KEY, 'custom');
  const sel = document.getElementById('themeSelect');
  if(sel) sel.value = 'custom';
  showToast('Tema personalizado salvo', 'success');
});
document.getElementById('resetCustomThemeBtn')?.addEventListener('click', () => {
  localStorage.removeItem(CUSTOM_THEME_KEY);
  clearCustomThemeVars();
  removeCustomOptionFromSelects();
  const base = document.getElementById('themeBaseSelect')?.value || 'dark-blue';
  applyTheme(base);
  renderColorPickers(base);
  showToast('Tema restaurado para o preset', 'success');
});

// ---------- Restaurar tudo (Aparência) ----------
document.getElementById('restoreAllBtn')?.addEventListener('click', () => {
  [WIDGET_LAYOUT_KEY, WIDGET_DEFAULT_LAYOUT_KEY, WIDGET_META_KEY, DENSITY_KEY, CUSTOM_THEME_KEY, THEME_KEY].forEach(k => localStorage.removeItem(k));
  location.reload();
});

const PAGE_TITLES = {
  overview: ["Visão Geral", "Monitoramento em tempo real da sua rede"],
  topologia: ["Topologia", "Hierarquia da rede e impacto das quedas"],
  config: ["Configurações", "Destinos, DNS, intervalos e alertas"],
};

function showPage(page){
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  const [title, subtitle] = PAGE_TITLES[page] || PAGE_TITLES.overview;
  document.querySelector('.topbar h1').textContent = title;
  document.querySelector('.topbar p').textContent = subtitle;
  localStorage.setItem('netnoc_page', page);
  if(page === 'topologia' && typeof onTopologyPageShown === 'function'){
    onTopologyPageShown();
  }
  document.dispatchEvent(new CustomEvent('netnoc:page', {detail: page}));
}

document.querySelectorAll('nav a[data-page]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showPage(a.dataset.page);
  });
});

