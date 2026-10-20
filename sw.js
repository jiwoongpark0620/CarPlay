/* Offline copy of the CarPlay client.
 *
 * The car opens this page with no internet most of the time (only the adapter's Wi-Fi), so
 * everything the page needs is stored on the first visit with internet and served from the
 * cache afterwards. Small files are refreshed in the background whenever the network answers;
 * the 1.4 MB decoder is fetched only once per CACHE version.
 *
 * After changing any file on GitHub, bump CACHE so every car picks up the new set at once.
 * Requests to the adapter (tespush.com) are never touched.
 */
'use strict';

var CACHE = 'cp-v10';
var FILES = [
  './',
  'index.html',
  'js/client.js',
  'js/protocol.js',
  'js/video.js',
  'js/h264worker.js',
  'js/h264dec.js',
  'js/h264dec.wasm.txt'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // no-cache: take the files from the network, not from a stale HTTP cache entry
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'no-cache' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('cp-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function cacheKey(url) { return url.origin + url.pathname; }   // ?stats=1, ?t=… share one entry

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  var bigOnce = /\.wasm\.txt$/.test(url.pathname);
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit && bigOnce) return hit;
      var net = fetch(req).then(function (r) {
        if (r && r.ok && r.type === 'basic') cache.put(cacheKey(url), r.clone());
        return r;
      }).catch(function () { return null; });
      if (hit) { e.waitUntil(net); return hit; }
      return net.then(function (r) {
        return r || new Response('offline and not cached: ' + url.pathname, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      });
    });
  }));
});
