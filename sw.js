const CACHE = 'finances-arm-v95';

const ASSETS = [
  './',
  './index.html',
  './style.css?v=110',
  './app.js?v=142',
  './exports.js?v=1',
  './config.js?v=22',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS).catch(() => {}))
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

function putCache(request, response) {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isAppFile = req.mode === 'navigate' ||
    /\.(?:html|css|js)$/.test(url.pathname) ||
    url.searchParams.has('v');

  // Always try the network first for the app shell so a refresh
  // never paints a previous deploy underneath the current one.
  if (isAppFile) {
    event.respondWith(
      fetch(req).then(res => putCache(req, res)).catch(() =>
        caches.match(req).then(cached => cached || caches.match('./index.html'))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => putCache(req, res)))
  );
});
