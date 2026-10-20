const CACHE = 'flydrop-shell-v5';
const SHELL = ['/', '/app.js', '/i18n.js', '/style.css', '/modes.js', '/modes.css', '/sha256.js', '/shot-fixtures.js', '/icon.svg', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/fonts/InterVariable.woff2', '/fonts/JetBrainsMono-Regular.woff2', '/fonts/JetBrainsMono-Medium.woff2'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('flydrop-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });

async function handleShare(request) {
  const form = await request.formData();
  const text = [form.get('text'), form.get('url'), form.get('title')].filter(value => typeof value === 'string' && value.trim()).join('\n');
  const file = form.get('media');
  if (file && typeof file.arrayBuffer === 'function' && file.size) {
    await fetch('/api/buffer', { method: 'POST', body: file, credentials: 'include', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image'), 'X-FlyDrop-Source': 'share' } });
  } else if (text) {
    await fetch('/api/buffer', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, source: 'share' }) });
  }
  return Response.redirect('/#buffer', 303);
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share') {
    event.respondWith(handleShare(event.request).catch(() => Response.redirect('/#buffer', 303)));
    return;
  }
  // Files, previews, text, enrollment and credentials are never cached.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  const key = url.pathname;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const cloned = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(key, cloned))); }
    return response;
  }).catch(async () => (await caches.match(key)) || Response.error()));
});
