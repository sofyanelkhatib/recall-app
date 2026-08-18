/* ================================================================
   RECALL — service worker
   Caches the app shell for offline use. Study/review, library,
   and analytics all work fully offline once the shell is cached.
   Live flashcard generation (Groq/Gemini calls) still needs a
   network connection — that's a provider constraint, not this file.
   ================================================================ */

const CACHE_NAME = "recall-cache-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept calls to AI providers — always go to network live.
  if (
    url.hostname.includes("groq.com") ||
    url.hostname.includes("googleapis.com")
  ) {
    return;
  }

  // App shell + same-origin assets: cache-first, falling back to network,
  // and updating the cache in the background when a fresh copy is fetched.
  if (event.request.method === "GET") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
  }
});
