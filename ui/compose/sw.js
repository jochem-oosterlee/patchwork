// Two-cache strategy:
//   APP_CACHE  — bumps with every release. Stores the app shell (HTML,
//                CSS, JS modules, manifest, icons) so refresh always
//                pulls the latest code.
//   ASSET_CACHE — only bumps when the actual binary assets change.
//                 Keeps the ~148 MB SF2 across app updates so users
//                 don't redownload it every time we ship a CSS tweak.
const APP_CACHE   = 'chord-pad-app-v216';
const ASSET_CACHE = 'chord-pad-assets-v1';

const OFFLINE_ASSETS = [
  './chord-pad.html',
  './chord-pad.css',
  './js/chord-pad.js',
  './js/midi.js',
  './js/audio.js',
  './js/seq.js',
  './js/pads.js',
  './js/kbinput.js',
  './js/pianoroll.js',
  './js/chordview.js',
  './js/analyzer.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(OFFLINE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete every previous app cache, but KEEP the asset cache so the
  // SF2 sticks around across version bumps. Asset cache only gets
  // wiped when ASSET_CACHE itself bumps (rare).
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys
      .filter(k => k !== APP_CACHE && k !== ASSET_CACHE)
      .map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Big binary assets (SF2 sample bank) are immutable and ~148MB — never
// re-fetch if we already have them in cache. Stored in ASSET_CACHE so
// they survive app-version bumps.
const CACHE_FIRST_PATTERNS = [/\.sf2$/i];

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (e.request.method !== 'GET') return;
  const cacheFirst = CACHE_FIRST_PATTERNS.some(re => re.test(url.pathname));
  if (cacheFirst) {
    e.respondWith((async () => {
      const c = await caches.open(ASSET_CACHE);
      const cached = await c.match(e.request);
      if (cached) return cached;
      const resp = await fetch(e.request);
      if (!resp.ok) return resp;
      // Await the cache write before serving so the entry is persisted
      // by the time the page starts reading the body. Previous version
      // fire-and-forgot the put — if the user refreshed mid-stream the
      // cache stayed empty and the next load re-downloaded.
      try { await c.put(e.request, resp.clone()); } catch (_) {}
      const fromCache = await c.match(e.request);
      return fromCache || resp;
    })());
    return;
  }
  // Network-first for everything else: fresh content on refresh, cache
  // as offline fallback. App-shell only, lives in APP_CACHE.
  e.respondWith(
    fetch(e.request)
      .then(response => {
        const clone = response.clone();
        caches.open(APP_CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
