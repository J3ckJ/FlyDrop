const CACHE = 'flydrop-shell-v4';
const SHELL = ['/', '/app.js', '/i18n.js', '/style.css', '/icon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('flydrop-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Files, previews, text, enrollment and credentials are never cached.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  const key = url.pathname;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const cloned = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, cloned))); }
    return response;
  }).catch(async () => (await caches.match(key)) || Response.error()));
});
