// Service worker minimal : rend le site installable comme une application.
// Aucune mise en cache : le site reste toujours à jour.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
