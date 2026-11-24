// Service worker: aplikacja otwiera się bez internetu (mapa i nowe wyszukiwania wymagają sieci).
const CACHE = 'tablice-v1';
const SHELL = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon.svg',
  './icon-180.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === location.origin || url.hostname === 'unpkg.com';
  if (e.request.method !== 'GET' || !isShell) return;
  // najpierw sieć (świeża wersja), bez sieci — kopia z pamięci
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
