/* Offline copy of the page: the car usually has only the adapter's Wi-Fi, without internet.
 * Everything is stored on the first visit with internet and served from the cache afterwards;
 * files are refreshed in the background whenever the network answers. After changing a file,
 * bump CACHE so every car picks up the new set at once. Requests to the adapter are not touched. */
'use strict';

var CACHE = 'cp-p1';
var FILES = ['./', 'index.html', 'js/link.js', 'js/client.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE)
    .then(function (c) { return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'no-cache' }); })); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys()
    .then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('cp-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    })
    .then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r && r.ok && r.type === 'basic') cache.put(url.origin + url.pathname, r.clone());
        return r;
      }).catch(function () { return null; });
      if (hit) { e.waitUntil(net); return hit; }
      return net.then(function (r) {
        return r || new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      });
    });
  }));
});
