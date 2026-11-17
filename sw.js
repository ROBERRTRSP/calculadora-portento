const CACHE = 'porcento-v27';
const ASSETS = ['./', './index.html', './scanner.html', './catalogo.html', './comparador.html', './manifest.webmanifest', './porcento.css?v=27', './factura.js?v=27', './catalogo.js?v=27', './barcode.js?v=27', './icon-180.png', './icon-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('porcento-') && key !== CACHE).map(key => caches.delete(key))))
])));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(async () => await caches.match(event.request) || Response.error()));
});
