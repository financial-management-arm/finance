const CACHE = 'finances-arm-v61';

const ASSETS = [
  './',
  './index.html',
  './style.css?v=57',
  './app.js?v=80',
  './config.js?v=21',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('finances-arm-') && key !== CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const network = async () => {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  };
  if (request.mode === 'navigate') {
    const update = network().catch(() => null);
    event.waitUntil(update);
    event.respondWith((async () => {
      const cached = await caches.match(request) || await caches.match('./index.html');
      return cached || await update || new Response('Offline. Reconnect to open Finances.', { status: 503 });
    })());
  } else {
    event.respondWith(caches.match(request).then(cached => cached || network()));
  }
});
