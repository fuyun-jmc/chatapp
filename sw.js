/* Service Worker —— 仅负责 Web Push 接收与通知点击跳转 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = { title: '新消息', body: '', url: './', tag: 'chat', ts: Date.now() };
  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed && typeof parsed === 'object') data = Object.assign(data, parsed);
    }
  } catch (e) { /* 非 JSON 推送则忽略解析 */ }

  var opts = {
    body: data.body || '',
    data: { url: data.url || './' },
    icon: 'assets/icon.svg',
    badge: 'assets/icon.svg',
    tag: data.tag || 'chat',
    renotify: !!data.tag,
    timestamp: data.ts || Date.now(),
    requireInteraction: false
  };
  if (data.sender) opts.data.sender = data.sender;

  event.waitUntil(self.registration.showNotification(data.title || '新消息', opts));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if ('focus' in c) {
          c.postMessage({ type: 'push-open', url: target });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// 页面在前台时，把通知事件转给页面自行处理（避免重复弹系统通知）
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});
