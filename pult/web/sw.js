const CACHE = 'pult-shell-v1';
const SHELL = ['/', '/app.js', '/net.js', '/experiments.js', '/zip.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pult-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const cloned = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, cloned)));
    }
    return response;
  }).catch(async () => (await caches.match(url.pathname)) || Response.error()));
});

self.addEventListener('push', event => {
  let data = { title: 'Пульт', body: '' };
  try { data = { ...data, ...(event.data ? event.data.json() : {}) }; } catch { data.body = event.data ? event.data.text() : ''; }
  event.waitUntil(self.registration.showNotification(data.title || 'Пульт', {
    body: data.body || '',
    tag: data.topic || 'pult',
    renotify: true,
    data,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow('/');
  }));
});

self.addEventListener('sync', event => {
  if (event.tag === 'pult-flush') event.waitUntil(Promise.resolve());
});
