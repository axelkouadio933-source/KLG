// DukaManager IA — Service Worker v2.0
// Gère le cache hors ligne et la synchronisation

const CACHE = 'dukamanager-v2';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// Installation — mise en cache des ressources essentielles
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activation — nettoyage des anciens caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Interception des requêtes — stratégie cache-first pour les assets, network-first pour les API
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ne pas intercepter les requêtes vers l'API Anthropic
  if (url.hostname === 'api.anthropic.com') return;
  // Ne pas intercepter les requêtes Google Fonts (online only)
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com')) return;
  // Ne pas intercepter les requêtes CDN jsPDF
  if (url.hostname === 'cdnjs.cloudflare.com') return;

  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) {
        // Retourner le cache et mettre à jour en arrière-plan
        const fetchUpdate = fetch(e.request)
          .then(resp => {
            if (resp && resp.ok) {
              caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
            }
            return resp;
          }).catch(() => {});
        return cached;
      }
      // Pas en cache — tenter le réseau
      return fetch(e.request)
        .then(resp => {
          if (resp && resp.ok && e.request.destination !== 'document') {
            caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        })
        .catch(() => {
          // Hors ligne et pas en cache — retourner l'app shell
          if (e.request.destination === 'document') {
            return caches.match('/index.html');
          }
        });
    })
  );
});

// Synchronisation en arrière-plan (quand la connexion revient)
self.addEventListener('sync', e => {
  if (e.tag === 'sync-ventes') {
    e.waitUntil(syncVentesPendantes());
  }
});

async function syncVentesPendantes() {
  // Ici on peut implémenter la sync vers un serveur distant
  console.log('[SW] Synchronisation des ventes pendantes...');
}

// Notifications push (pour alertes stock, rapports quotidiens)
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'DukaManager';
  const options = {
    body: data.body || 'Nouvelle notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    data: { url: data.url || '/' },
    actions: data.actions || []
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cls => {
      if (cls.length) { cls[0].focus(); cls[0].navigate(url); }
      else clients.openWindow(url);
    })
  );
});
