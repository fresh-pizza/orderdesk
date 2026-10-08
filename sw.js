/* Order Desk service worker: keeps the app itself on the device so it opens with no internet. */
const VERSION = 'od-1.0.1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'supabase.js', 'manifest.webmanifest',
  'icon-192.png', 'apple-touch-icon.png',
  'bricolage-grotesque-latin-600-normal.woff2', 'bricolage-grotesque-latin-700-normal.woff2',
  'hanken-grotesk-latin-400-normal.woff2', 'hanken-grotesk-latin-500-normal.woff2',
  'hanken-grotesk-latin-600-normal.woff2', 'ibm-plex-mono-latin-500-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('od-') && k !== VERSION && k !== 'od-photos') await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // menu photos: from the device first, download once
  if (url.pathname.includes('/storage/v1/object/public/')) {
    e.respondWith((async () => {
      const c = await caches.open('od-photos');
      const hit = await c.match(req.url);
      if (hit) return hit;
      let res;
      try { res = await fetch(req.url, { mode: 'cors' }); } catch (_) { return fetch(req); }
      if (res.ok) c.put(req.url, res.clone());
      return res;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return; // database and login go straight to the network
  // the app itself: from the device, instantly
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && url.pathname.match(/\.(png|woff2|js|css)$/)) c.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await c.match('index.html');
      if (fallback && req.mode === 'navigate') return fallback;
      throw err;
    }
  })());
});
