importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBlqKxXfkVOOn6eIy_OwJDbze8AQcLL10w",
  authDomain: "the-standard-hotel.firebaseapp.com",
  projectId: "the-standard-hotel",
  storageBucket: "the-standard-hotel.firebasestorage.app",
  messagingSenderId: "501545264045",
  appId: "1:501545264045:web:bea29d2602363c825eb724"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(async (payload) => {
  const data = payload.data || {};
  const title = data.title || payload.notification?.title || 'The Standard Hotel';
  const options = {
    body: data.body || payload.notification?.body || 'A new hotel enquiry needs attention.',
    icon: '/favicon.ico',
    data: {
      url: '/reception-notifications.html',
      enquiryId: data.enquiryId || ''
    },
    tag: data.enquiryId || ('standard-hotel-enquiry-' + Date.now()),
    renotify: true
  };

  await self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/reception-notifications.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
