'use strict';
// 外注ポータルのapp-shellキャッシュ。employee-appと同じ network-first + 自分の接頭辞の古い版だけ削除。
// CacheStorageはオリジン(GitHub Pages)単位で共有されるため、接頭辞を分けてemployee-appの
// キャッシュを潰さないようにする(社員ポータルと同一オリジンにサブフォルダ配置されるため)。
const CACHE_PREFIX = 'jinshou-subcontractor-app';
const CACHE_NAME = 'jinshou-subcontractor-app-v11';
const SHELL_FILES = [
  './', './index.html', './style.css', './app.js', './client-error-reporter.js', './manifest.json',
  './icons/app-icon-180-v2.png', './icons/icon-192-v2.png', './icons/icon-512-v2.png', './icons/icon-512-maskable-v2.png',
  './icons/favicon-32-v2.png', './icons/favicon-16-v2.png',
  './brand/logo-gold.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => null)))),
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Supabase API等はキャッシュしない
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request, { cache: 'reload' })
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)); } return res; })
      .catch(() => caches.match(event.request)),
  );
});
