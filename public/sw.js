/**
 * Claude Bridge service worker — Task 9 (web push notifications) ONLY.
 *
 * Deliberately does NOT do any caching / offline / fetch interception.
 * The bridge is a live dashboard over a local agent process; stale
 * cached responses for task state would be actively misleading. This
 * file exists solely to satisfy the browser requirement that a Push
 * subscription be owned by a service worker, and to render/route the
 * notifications `libs/webPush.ts` sends.
 */

self.addEventListener("install", () => {
  // Activate immediately — no cached assets to warm, nothing to wait on.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "Claude Bridge", body: "" };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      // Non-JSON payload — fall back to raw text as the body.
      data = { title: "Claude Bridge", body: event.data.text() };
    }
  }

  const title = data.title || "Claude Bridge";
  const options = {
    body: data.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url || "/tasks" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/tasks";

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target = new URL(url, self.location.origin).href;
      for (const client of clientsList) {
        // Reuse an already-open bridge tab rather than piling up new
        // ones — focus it and navigate if the URL differs.
        if (client.url === target && "focus" in client) {
          return client.focus();
        }
      }
      for (const client of clientsList) {
        if ("focus" in client && "navigate" in client) {
          await client.focus();
          return client.navigate(target);
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
    })(),
  );
});
