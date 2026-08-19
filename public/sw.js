const CACHE = "shangtu-notebook-shell-v3";
const SHELL = ["/", "/manifest.webmanifest", "/book-mark.svg"];

self.addEventListener("install", (event) => event.waitUntil(Promise.all([
  caches.open(CACHE).then((cache) => cache.addAll(SHELL)),
  self.skipWaiting(),
])));
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  self.clients.claim(),
])));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const updateCache = (response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  };
  // The HTML shell is the version boundary. Prefer the network when online
  // so a deployed update becomes visible without manually clearing storage;
  // keep the cached shell as the offline fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then(updateCache).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then(updateCache)));
});
