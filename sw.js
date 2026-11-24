// Smart Buddies service worker: shows push notifications (and nothing else, no caching).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    // Normally there is no point interrupting somebody who is already looking at the portal.
    // A test is the exception: the whole point is to see it, and you tap it from inside the app.
    var inFront = list.some(function (c) { return c.visibilityState === 'visible'; });
    if (inFront && !data.force) return;
    // the number on the home screen icon, so you see it without unlocking
    if (data.badge && self.navigator && self.navigator.setAppBadge) {
      try { self.navigator.setAppBadge(Number(data.badge) || 1); } catch (err) {}
    }
    return self.registration.showNotification(data.title || 'Smart Buddies', {
      body: data.body || '', tag: data.tag || 'sb', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url || '/' },
    });
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  if (self.navigator && self.navigator.clearAppBadge) { try { self.navigator.clearAppBadge(); } catch (err) {} }
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
