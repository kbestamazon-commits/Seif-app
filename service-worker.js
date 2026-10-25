'use strict';
const CACHE = 'seif-life-2-7';
const ASSETS = ['./', './index.html', './style.css?v=27', './app.js?v=27', './qr-local.js?v=27', './icon.svg', './icon.png', './manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith('seif-test-') || k.startsWith('seif-life-')) && k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Network-first for code avoids serving an older security fix from cache. Offline fallback remains available.
  event.respondWith(fetch(event.request).then(response => {
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{}));}
    return response;
  }).catch(()=>caches.match(event.request)));
});
