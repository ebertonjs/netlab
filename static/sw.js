// Service worker: cacheia só o "casco" estático; nunca intercepta /api, /metrics ou o stream.
const CACHE = 'netnoc-v3.4-20261022';
const SHELL = ['/', '/glass/glass.css', '/glass/fonts.css', '/glass/skins.js', '/glass/skins/terminal.css', '/glass/skins/grafana.css', '/glass/skins/material.css', '/glass/ui-icons.js', '/glass/app.js', '/glass/home.js', '/glass/sheets.js', '/glass/tv.js', '/glass/camplayer.js', '/glass/mk-panel.jpg', '/classic', '/style.css', '/extra.css', '/mission.css', '/theme-grafana.css', '/tree.css', '/tv.css', '/theme-sync.css', '/js/tree.js', '/util.js', '/chart.umd.js', '/icons.js', '/topology.js',
  '/js/layout.js', '/js/core.js', '/js/settings.js', '/js/mikrotik.js', '/js/agh.js', '/js/ui.js', '/js/live.js',
  '/js/charts-extra.js', '/js/analysis.js', '/js/tools.js', '/js/mission.js','/js/sidebar.js', '/js/settings-extra.js', '/js/wall.js', '/js/pwa.js',
  '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname === '/login' || u.pathname === '/status' || u.pathname.startsWith('/api/') || u.pathname === '/metrics' || u.pathname === '/healthz') return;
  // rede primeiro (dados e código sempre frescos), cache só como reserva offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && r.type === 'basic' && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match('/'))));
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({type: 'window'}).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('/'))); });
