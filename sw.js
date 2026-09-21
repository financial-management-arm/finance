const CACHE = 'finances-arm-v76';

const ASSETS = [
  './',
  './index.html',
  './style.css?v=98',
  './app.js?v=128',
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
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function network(request) {
  return fetch(request).then(response => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigations: serve the cached shell instantly, refresh it in the
  // background so the next load picks up a new deploy.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then(cached => {
        const update = network(req).catch(() => null);
        return cached || update || caches.match('./index.html');
      })
    );
    return;
  }

  // Everything else: cache-first, falling back to network and caching the
  // result for next time.
  event.respondWith(
    caches.match(req).then(cached => cached || network(req).catch(() => cached))
  );
});
