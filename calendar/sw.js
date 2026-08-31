'use strict';

// 配置カレンダー専用PWAのService Worker。
//
// 社員ポータル側(../sw.js)とはスコープが違う(こちらは /calendar/ 配下だけ)。
// 方式はポータルと同じネットワーク優先: 常に最新を取りに行き、オフラインのときだけ
// キャッシュへフォールバックする(古いキャッシュに固定される事故を自己修復するため)。
//
// 【キャッシュ名の接頭辞を分ける理由】CacheStorageはオリジン単位で共有されるため、
// activate時に「自分以外のキャッシュを全部消す」書き方にすると、社員ポータルと
// 配置カレンダーが互いのキャッシュを消し合ってしまう。どちらも自分の接頭辞の
// 古い版だけを消すようにしてある(../sw.js側も同じ方針に揃えてある)。
const CACHE_PREFIX = 'jinshou-assignment-calendar';
const CACHE_NAME = `${CACHE_PREFIX}-v1-staging`;

// このSWが実際に配信できるのはスコープ(/calendar/)配下だけ。
// ../assignment-calendar.js などの共有ファイルは社員ポータル側のSWが持つ。
const SHELL_FILES = [
  './', './index.html', './calendar-boot.js', './manifest.json',
  './icons/cal-icon-192.png', './icons/cal-icon-512.png',
  './icons/cal-app-icon-180.png', './icons/cal-favicon-32.png', './icons/cal-favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      SHELL_FILES.map((file) => cache.add(file).catch(() => null)),
    )),
  );
  self.skipWaiting();
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
  if (url.origin !== self.location.origin) return; // Supabase等の外部通信はキャッシュしない
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request, { cache: 'reload' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
