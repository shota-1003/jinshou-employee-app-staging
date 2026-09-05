'use strict';

// アプリの見た目(HTML/CSS/JS)だけをキャッシュするapp-shell方式。申請データ自体は
// 常にオンラインでSupabaseへ直接送るため、APIレスポンスはキャッシュしない。
//
// 2026-08-25: ネットワーク優先(network-first)へ変更した。以前はcaches.matchを
// 常に優先するcache-firstだったため、SHELL_FILESの1つでも過去にインストール中に
// 404等で失敗すると(cache.addAllはアトミックで1件でも失敗すると全体が失敗する)、
// 端末がその時点の古い/壊れたキャッシュへ永久に固定されてしまう不具合があった
// (実機で「CSSが一切当たらずHTMLだけの崩れた画面になる」という報告があった)。
// ネットワークが使える限り常に最新のファイルを取得し、オフライン時だけキャッシュへ
// フォールバックする方式にすることで、この種の「古いキャッシュに固定される」問題を
// 自己修復できるようにした。
// 2026-09-01: 接頭辞を分けた。CacheStorageはオリジン単位で共有されるため、
// activateで「自分以外のキャッシュを全部消す」ままだと、同じオリジンに増えた
// 配置カレンダー専用PWA(calendar/sw.js、接頭辞 jinshou-assignment-calendar)の
// キャッシュまで消してしまい、両者が起動のたびに互いのキャッシュを潰し合う。
// 自分の接頭辞の古い版だけを消すようにする。
const CACHE_PREFIX = 'jinshou-employee-app';
const CACHE_NAME = 'jinshou-employee-app-v148-staging';
const SHELL_FILES = [
  './', './index.html', './style.css', './app.js', './qr.js', './icons.js', './manifest.json',
  './icons/app-icon-180-v2.png', './icons/icon-192-v2.png', './icons/icon-512-v2.png', './icons/icon-512-maskable-v2.png',
  './icons/favicon-32-v2.png', './icons/favicon-16-v2.png',
  './brand/logo-gold.png', './brand/logo-navy.png', './brand/logo-white.png',
];

self.addEventListener('install', (event) => {
  // 1つのファイルが取得できなくても他のファイルのキャッシュ登録は続ける
  // (cache.addAllのアトミック失敗で更新全体が止まらないようにする)。
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      SHELL_FILES.map((file) => cache.add(file).catch(() => null)),
    )),
  );
  self.skipWaiting();
});

// クライアントから明示的にskipWaitingを促されたら即座にwaitingを解除する(収束の保険)。
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
  if (url.origin !== self.location.origin) return; // Supabase API等の外部通信はキャッシュしない
  if (event.request.method !== 'GET') return;
  // lucky-preview(Staging専用の演出プレビュー)はSWのキャッシュ対象から完全に除外し、
  // 常にブラウザのネイティブfetchで最新を取得させる(古い版がキャッシュから出続けるのを防ぐ)。
  if (url.pathname.includes('/lucky-preview')) return;

  // {cache: 'reload'}でブラウザのHTTPキャッシュ(GitHub Pagesのmax-age等)を無視して
  // 必ずネットワークへ再取得しにいく。これを指定しないと、SW自体はnetwork-firstでも
  // 内部のfetch()がブラウザのHTTPキャッシュから「新鮮」と判定された古い応答を返して
  // しまい、結局古い内容が表示され続けることがある(実機で確認)。
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

// Push通知(2026-08-26追加)。重要な通知(会社からのお知らせ・申請の承認/却下/差戻し・
// 日報不整合・未提出締切・休暇申請結果・本人予定の事前通知)のみをcreate_system_notification
// (announcements/announcement_recipients、既存の通知センター)経由で送る設計のため、
// ここでは受信したペイロードをそのまま表示するだけにする(重要度の絞り込みは送信側で行う)。
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: '通知', body: event.data ? event.data.text() : '' }; }
  const title = data.title || '迅翔興業 社員ポータル';
  const options = {
    body: data.body || '',
    icon: './icons/icon-192-v2.png',
    badge: './icons/favicon-32-v2.png',
    data: { url: data.url || './' },
    tag: data.tag || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});

// ブラウザ側の都合(鍵のローテーション等)でPush購読が失効すると発火する。ここで再購読して
// サーバー側(push_subscriptions)を更新しないと、本人が何もしていないのに通知が届かなく
// なる(気づきにくい静かな不具合)。app.js側でログイン中に保存したemployee_code/端末トークンを
// IndexedDB(jinshou-push-auth)から読み、app.jsのrpc()と同じSupabase REST経由で
// register_my_push_subscriptionを直接呼ぶ(SWはモジュール分割していないため定数を最小限だけ
// ここに複製している。値そのものはapp.js側と同じで秘匿情報ではない)。
const SW_SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SW_SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
const SW_VAPID_PUBLIC_KEY = 'BAwOlLW9xTd5GUuIFaj_a-8VjxlLUEPWSlOaZpy5-0_M0DPkyWokfCBXZdRqsZGsMvvFAU6i2wWKP8KRQWepR2A';

function swUrlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function readPushAuth() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open('jinshou-push-auth', 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore('auth', { keyPath: 'id' }); };
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction('auth', 'readonly');
        const getReq = tx.objectStore('auth').get('current');
        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    };
    req.onerror = () => resolve(null);
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const auth = await readPushAuth();
    if (!auth || !auth.employeeCode || !auth.token) return; // 保存情報が無ければ次回アプリ起動時のinitPushToggleStateに委ねる
    try {
      const applicationServerKey = (event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey)
        || swUrlBase64ToUint8Array(SW_VAPID_PUBLIC_KEY);
      const newSub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      const json = newSub.toJSON();
      await fetch(`${SW_SUPABASE_URL}/rest/v1/rpc/register_my_push_subscription`, {
        method: 'POST',
        headers: {
          apikey: SW_SUPABASE_ANON_KEY, Authorization: `Bearer ${SW_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json', 'X-Device-Token': auth.token,
        },
        body: JSON.stringify({
          p_employee_code: auth.employeeCode, p_endpoint: json.endpoint,
          p_p256dh: json.keys.p256dh, p_auth: json.keys.auth, p_user_agent: 'service-worker-resubscribe',
        }),
      });
    } catch (e) { /* 再購読に失敗しても致命的ではない(次回アプリ起動時にinitPushToggleStateが不整合を検知できる) */ }
  })());
});
