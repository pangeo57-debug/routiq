/**
 * RoutePal service worker.
 *
 * Replaces an earlier version that was generated at runtime as a Blob URL. That
 * approach was broken in two ways: createObjectURL produces a NEW url on every
 * page load, so the browser treated each visit as a different worker and
 * re-registered it every time; and its install step cached nothing at all
 * (`addAll([])`), so it provided neither offline support nor speed while still
 * sitting in the request path.
 *
 * Strategy: network-first for same-origin requests, falling back to cache.
 *  - Online: always the freshest deploy — no more "I pushed but still see the
 *    old version".
 *  - Offline: the last successful response is served, so the app still opens
 *    with all its localStorage data intact.
 *
 * Third-party requests (map tiles, geocoding, routing APIs) deliberately
 * bypass the worker: their responses are large, frequently changing, or
 * opaque, and caching them would waste storage and risk stale coordinates.
 */

// Bump on deploy to retire old caches. Any change to this file also causes the
// browser to treat the worker as updated.
const CACHE = 'routepal-v2';

self.addEventListener('install', (event) => {
  // Take over as soon as possible rather than waiting for every existing tab
  // to close — a stale worker serving an old build is the exact problem this
  // file exists to solve.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET, only our own files. Everything else goes straight to the network.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only cache real, complete responses; an error page cached here would
        // be served offline forever.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit =>
          hit || caches.match('./routiq.html')  // deep link while offline
        )
      )
  );
});
