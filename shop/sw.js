/* Order Desk shop service worker: keeps the shop app itself on the device so it
   opens instantly, even on a slow connection. The menu/order data still always
   comes live from the server — this only caches the app's own files (and dish
   photos), not the data. Scope is this folder (/shop/) only; it never touches
   the admin app or its own service worker at the parent level. */
const VERSION = 'od-shop-2.3.5';
const SHELL = ['./', 'index.html', 'shop.css?v=2.3.5', 'shop.js?v=2.3.5',
  '../app.css?v=2.3.5', '../supabase.js', '../icon-192.png', '../apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('od-shop-') && k !== VERSION && k !== 'od-shop-photos') await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // dish/review photos: from the device first, download once
  if (url.pathname.includes('/storage/v1/object/public/')) {
    e.respondWith((async () => {
      const c = await caches.open('od-shop-photos');
      const hit = await c.match(req.url);
      if (hit) return hit;
      let res;
      try { res = await fetch(req.url, { mode: 'cors' }); } catch (_) { return fetch(req); }
      if (res.ok) c.put(req.url, res.clone());
      return res;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return; // database and login always go straight to the network
  // the shop app's own files: from the device, instantly, falling back to the network for anything new
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
