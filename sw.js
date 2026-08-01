// M+V service worker — makes the site installable & instant, without ever serving stale content
// or touching Supabase. Bump CACHE when you ship a new build to retire the old shell.
const CACHE = "mv-v16";
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

// ---------- push notifications ----------
// iOS subscribes with userVisibleOnly:true, which is a promise: EVERY push must show a notification.
// So there is no silent path here — even a malformed payload gets a fallback card, because staying quiet
// is what makes iOS revoke the subscription.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "a new note ♡", {
      body: d.body || "",
      tag: d.tag || "mv-note",     // a burst of notes collapses into one line instead of a stack
      icon: "./icon-192.png",      // (iOS uses the installed app's own icon and ignores this)
      badge: "./icon-192.png",
      data: { url: d.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.location.href).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // already open (the usual case on a phone) — just bring it forward rather than reloading it
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
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
    // cache: "reload" bypasses the HTTP cache. GitHub Pages serves index.html with max-age=600, so a
    // plain fetch() here can hand back a ten-minute-old build — which made "did the fix land?" untestable
    // (an installed PWA keeps its own copy on top of that). This forces the real network copy every launch.
    e.respondWith(
      fetch(new Request(url.href, { cache: "reload", credentials: "same-origin" }))
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
