// M+V service worker — makes the site installable & instant, without ever serving stale content
// or touching Supabase. Bump CACHE when you ship a new build to retire the old shell.
const CACHE = "mv-v10";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  // drop any old caches (previous versions) and take control immediately
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only ever handle our OWN origin's GETs. Supabase (and anything cross-origin) passes straight
  // through untouched — the SW must never cache or interfere with the notes API.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // The page itself: network-first, so a fresh deploy is picked up as soon as there's signal;
  // fall back to the cached shell when offline.
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Static assets (icons, manifest): cache-first — they rarely change and this makes launch instant.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }))
  );
});
