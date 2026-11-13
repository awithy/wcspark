// Minimal service worker: makes the app installable and shows a friendly page when offline.
// Deliberately does not cache app data — the server is the source of truth.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(
    fetch(req).catch(
      () =>
        new Response(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
           <title>Sparks — offline</title>
           <body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
           <p>You're offline. Sparks will be here when you reconnect.</p>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    ),
  );
});
