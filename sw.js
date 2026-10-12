// Offline cache for Shipibo Helper. Bump VERSION (and app.js VERSION) on every release.
const VERSION = '1.7.0';
const CACHE = 'shipibo-helper-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/dict.json', 'data/index.json', 'data/grammar.json', 'data/taught.json', 'data/morphemes.json', 'data/attested.json', 'data/labels.json', 'data/dictlearn.json', 'data/examples.json',
  'vendor/web-llm-0.2.85.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('shipibo-helper-') && k !== CACHE)
    .map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // model files are cached by WebLLM itself
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit ||
    fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match('index.html'))));
});
