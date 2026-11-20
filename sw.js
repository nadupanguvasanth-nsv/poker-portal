// Smart Buddies service worker: shows push notifications (and nothing else, no caching).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    // the app is open and in front: it already shows its own alert
    if (list.some(function (c) { return c.visibilityState === 'visible'; })) return;
    return self.registration.showNotification(data.title || 'Smart Buddies', {
      body: data.body || '', tag: data.tag || 'sb', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url || '/' },
    });
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
