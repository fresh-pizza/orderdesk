// The app that used to live here has moved. This takes its old offline copy off the phone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) { try { c.navigate(c.url); } catch (_) {} }
})()));
