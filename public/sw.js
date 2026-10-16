// Minimal service worker so the controller can be installed as an app (PWA / APK via PWABuilder).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // always use the network: live data must never be cached
