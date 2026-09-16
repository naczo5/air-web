// Retire the legacy cache-everything worker. Game media can exceed browser
// quotas and ranged audio responses cannot be stored with Cache.put().
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("air-se-shell-")).map((name) => caches.delete(name)));
    await self.registration.unregister();
    await self.clients.claim();
  })());
});
