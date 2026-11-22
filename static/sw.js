// Service worker: cacheia só o "casco" estático; nunca intercepta /api, /metrics ou o stream.
const CACHE = 'netnoc-v4.4';
const SHELL = ['/', '/glass/glass.css', '/glass/fonts.css', '/glass/skins.js', '/glass/skins/pro.css', '/glass/ui-icons.js',
  '/glass/app.js', '/glass/home.js', '/glass/topomap.js', '/glass/telas/comum.js', '/glass/telas/latencia.js', '/glass/telas/destino.js', '/glass/telas/incidentes.js', '/glass/telas/dns.js', '/glass/telas/mikrotik.js', '/glass/telas/adguard.js', '/glass/telas/topologia.js', '/glass/telas/ferramentas.js', '/glass/telas/sla.js', '/glass/telas/cameras.js', '/glass/telas/config.js', '/glass/tv.js', '/glass/dial.js', '/glass/dial.css',
  '/glass/camplayer.js', '/glass/mk-panel.jpg', '/util.js', '/chart.umd.js', '/icons.js', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname === '/login' || u.pathname === '/status' || u.pathname.startsWith('/api/') || u.pathname === '/metrics' || u.pathname === '/healthz') return;
  // v3.14: arquivo com ?v=<hash do conteúdo> nunca muda → cache primeiro (abre na hora mesmo em
  // enlace lento/satélite); ao guardar uma versão nova, apaga as anteriores do mesmo arquivo.
  if (u.searchParams.has('v')) {
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok && r.type === 'basic') {
        const copy = r.clone();
        c.keys().then(ks => ks.forEach(k => { const ku = new URL(k.url); if (ku.pathname === u.pathname && ku.search !== u.search) c.delete(k); }));
        c.put(e.request, copy);
      }
      return r;
    }))));
    return;
  }
  // o resto: rede primeiro (dados e páginas sempre frescos), cache só como reserva offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && r.type === 'basic' && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match('/'))));
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({type: 'window'}).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('/'))); });
