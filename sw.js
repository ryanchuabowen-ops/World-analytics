// World Atlas — Service Worker
// Cache version — bump this string to force a cache refresh on next visit
const CACHE = 'atlas-v4';

// Assets to pre-cache on install
const PRECACHE = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
];

// ── Install: pre-cache everything ───────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ─────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for static/CDN, network-first for HTML ─
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network-first for the HTML page itself (gets latest updates)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Network-first for daily-refreshed data snapshots — a stale cached copy is
  // worse than a fresh network fetch; only fall back to cache when offline.
  if (/\/data\/(live-data|supply-chain-data|supply-chain-history|conflict-index)\.json$/.test(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for CDN assets, map data, and other static resources
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache successful responses for same-origin or CDN assets
        if (response.ok && (
          url.hostname === self.location.hostname ||
          url.hostname.includes('cdnjs.cloudflare.com') ||
          url.hostname.includes('jsdelivr.net')
        )) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // fall back to cache if offline
    })
  );
});
