// Offline-first service worker: precache the app shell, then serve from cache and
// refresh in the background (stale-while-revalidate). Bump VERSION on each release.
const VERSION = 'tl-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'js/app.js', 'js/store.js', 'js/db.js', 'js/seed.js', 'js/calc.js', 'js/tz.js', 'js/ui.js', 'js/actions.js',
  'js/metrics.js', 'js/fx.js', 'js/report-render.js',
  ...['dashboard', 'journal', 'tasks', 'timer', 'evidence', 'approvals', 'salary', 'reports', 'invoices', 'calculator', 'employers', 'settings'].map(v => `js/views/${v}.js`),
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // FX APIs etc. go straight to network
  e.respondWith(caches.open(VERSION).then(async cache => {
    const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then(res => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => cached);
    if (cached) { e.waitUntil(fresh); return cached; }
    return fresh;
  }));
});
