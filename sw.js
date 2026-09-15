const CACHE = 'finances-arm-v81';

const ASSETS = [
  './',
  './index.html',
  './style.css?v=78',
  './app.js?v=111',
  './exports.js?v=1',
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
  const url = new URL(request.url);
  const isCoreAsset = ['/', '/finance/', '/finance/index.html', '/finance/app.js', '/finance/style.css', '/finance/config.js', '/finance/exports.js'].includes(url.pathname);
  const network = async () => {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  };
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const fresh = await network().catch(() => null);
      const cached = await caches.match(request) || await caches.match('./index.html');
      return fresh || cached || new Response('Offline. Reconnect to open Finances.', { status: 503 });
    })());
  } else if (isCoreAsset) {
    event.respondWith((async () => {
      const fresh = await network().catch(() => null);
      return fresh || await caches.match(request);
    })());
  } else {
    event.respondWith(caches.match(request).then(cached => cached || network()));
  }
});
