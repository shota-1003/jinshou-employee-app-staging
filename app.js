'use strict';

// 迅翔興業 社員ポータルPWA。既存の「各種書類(株式会社迅翔興業様) の原本」スプレッドシートを
// 社員全員で直接共有編集する(誰が何を消したか分からなくなる)問題を避けるため、
// 各社員が自分の端末からSupabaseへ直接送信する構成にした。
//
// 認証(2026-08-24改訂): 「社員番号を知っているだけで他人になりすませる」という
// 監査指摘を受け、端末バインド型のセッショントークン認証を導入した。暗証番号
// (4〜6桁、pgcryptoでサーバー側bcryptハッシュ化、平文は一切保存しない)による
// 本人確認は「新しい端末で最初の1回だけ」行い、成功時にサーバーが256bitのランダムな
// 端末トークンを発行する。このトークンをlocalStorage(ブラウザ/PWAを閉じても消えない)
// へ保存し、以後は全RPC呼び出しでX-Device-Tokenヘッダーとして送る。サーバー側は
// このヘッダーをrequire_employee_session()で検証しており、有効なトークンが
// employee_codeと一致しない限り、社員番号を渡すだけでは一切のRPCが失敗する
// (詳細: database/supabase/202608241411_device-session-auth.sql)。
// 別の端末では対応するトークンを持たないため暗証番号の再確認が必ず発生し、
// 管理者は社員詳細画面「ログイン端末」タブから特定の端末だけを個別に無効化できる。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
// Staging/Production取り違え防止用フラグ(2026-08-28)。ソース上は常にfalseで、
// scripts/deploy-employee-portal-staging.jsがコピー先だけをtrueへ書き換える
// (SUPABASE_URL/ANON_KEYと同じ「ソースは変更しない、コピー先だけ差し替える」方式)。
// Production側のデプロイ経路ではこの行を一切書き換えないため、本番に誤って
// Staging表示が出ることは構造的に無い。
const IS_STAGING = true;
// 画面下部の小さなビルド情報表示用。各deployスクリプトが、sw.jsのCACHE_NAME更新と同じ
// タイミングでこの2行(コピー先のみ)を書き換える(空文字のままなら「不明」として表示する)。
const APP_BUILD_VERSION = 'jinshou-employee-app-v113-staging';
const BUILD_DEPLOYED_AT = '2026-09-02T14:45:25.585Z';
// VAPID公開鍵は秘匿情報ではないためそのまま埋め込む(.envのVAPID_PUBLIC_KEYと同じ値、
// mail-secretary等の他アプリと共通の会社送信元アイデンティティを再利用する)。
const VAPID_PUBLIC_KEY = 'BAwOlLW9xTd5GUuIFaj_a-8VjxlLUEPWSlOaZpy5-0_M0DPkyWokfCBXZdRqsZGsMvvFAU6i2wWKP8KRQWepR2A';
const N8N_BASE_URL = 'https://shota1003.app.n8n.cloud';
const SESSION_KEY = 'jinshou_employee_session'; // sessionStorage(タブを閉じると消える、UI表示用のキャッシュ)
const REMEMBERED_CODE_KEY = 'jinshou_remembered_employee_code'; // localStorage(社員番号入力欄の補助のみ)
const DEVICE_AUTH_KEY = 'jinshou_device_auth'; // localStorage({employeeCode, token}、この端末の実際の認証情報)

let currentDeviceToken = null; // このタブで現在有効な端末トークン(rpc()が毎回ヘッダーへ載せる)

// 2026-09-02(ユーザー指示: Production障害の可視化マップ検知、共通モジュール化・重複禁止)。
// 実装は共通webapp/lib/client-error-reporter.js(index.htmlでこのファイルより前に読込済み)へ
// 集約し、画面ごとの複製をしない。
const EMPLOYEE_APP_AGENT_NAME = 'jinshou-employee-app-agent';
window.ClientErrorReporter.init({
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  agentName: EMPLOYEE_APP_AGENT_NAME,
  getEmployeeCode: () => { const s = getSession(); return (s && s.employeeCode) || null; },
  getDeviceToken: () => currentDeviceToken,
});

async function rpc(name, params) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
  if (currentDeviceToken) headers['X-Device-Token'] = currentDeviceToken;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) {
    // SupabaseのRPCエラー(RAISE EXCEPTIONのメッセージ)はJSONで返るため、
    // 表示用に読みやすいメッセージだけを取り出す(生JSONをそのまま見せない)。
    let message = `通信エラー(${res.status})`;
    try { const parsed = JSON.parse(text); if (parsed && parsed.message) message = parsed.message; } catch { /* JSONでなければそのまま */ }
    // 端末が無効化された/退職・利用停止になった等でセッションが失効した場合は、
    // その場のエラー表示だけで終わらせず、ログイン画面へ強制的に戻す。
    if (message === 'セッションが確認できませんでした。再度ログインしてください' || message === 'このアカウントは現在ご利用いただけません') {
      clearSession();
      clearDeviceAuth();
      currentDeviceToken = null;
      if (document.getElementById('screen-login')) {
        showScreen('login');
        showError('login-error', message === 'このアカウントは現在ご利用いただけません' ? message : 'ログイン状態が無効になりました。もう一度ログインしてください。');
      }
    } else {
      // 2026-09-02: セッション失効(想定内の通常フロー)以外は、可視化マップが検知できるよう
      // 実際のProductionエラーとして報告する。
      window.ClientErrorReporter.reportHttpError(`rpc/${name}`, res.status, message);
    }
    throw new Error(message);
  }
  return text ? JSON.parse(text) : null;
}

// new Date().toISOString()はUTC日付になるため、深夜0時〜9時JSTの間は「今日」が
// 前日にずれてしまう(日報の未提出判定・自動確認・通知は日本時間の暦日で行う必要がある)。
// 日報関連の「今日の日付」は必ずこの関数で取得する。
function todayJST() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 2026-08-28: 管理者お知らせ管理画面で、DB側の列欠落(list_announcements_admin、
// database/supabase/202608280732_list-announcements-admin-column-fix.sql参照)により
// 「自動通知(undefined)・確認済みundefined/3」のような生のundefinedがそのまま画面へ出た
// 実例が見つかった。DB側は修正したが、同種の欠損値(null/undefined/NaN)が将来別の箇所で
// 再発してもユーザーへ生の値を見せないよう、テンプレート内で値を直接補間する箇所は
// このヘルパーを通す(値があればそのまま、無ければfallbackを返すだけの薄い関数)。
function safeText(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number' && Number.isNaN(val)) return fallback;
  return val;
}

// デプロイ直後、CDN/ブラウザキャッシュの都合でindex.htmlとapp.jsのバージョンが一瞬
// 食い違うことがある(実機で確認済み)。存在しないid宛のaddEventListenerが例外を投げると
// init()内の後続の配線処理まで巻き込んで止まってしまうため、要素が無ければ何もせず
// 続行するこのヘルパーを新規追加箇所から使う。
function onId(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// iPhone等で撮影した写真(HEIC/HEIF含む、実測で3〜10MB超)をそのままbase64化してn8nへ
// 送ると、JSONペイロードが10MBを超えることがあり、n8n側の「To Binary」ノードが
// メモリ不足でクラッシュして「アップロードに失敗しました」になることを、実際のn8n実行
// ログ(NodeCrashedError, jsonSizeBytes=10317078)で確認した。領収書の文字が読み取れれば
// 十分なため、長辺1600px・JPEG品質0.82程度まで縮小してからアップロードする
// (画像以外のPDF等はそのまま、canvasが使えない/失敗した場合も元ファイルのまま送る
// フォールバックにする)。
async function compressImageForUpload(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 1920; // 複数領収書が1枚に写っている場合の文字も読める解像度を残しつつ、
    // 元のiPhone写真(4000px超)よりは十分小さくしてn8n側のメモリ不足クラッシュを防ぐ。
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close && bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) return file;
    // HEIC等の入力でも、出力は必ずJPEGになる(iOS Safariのcanvasは常にJPEG/PNGでエンコードできる)。
    const newName = (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch (e) {
    // 圧縮できなくても、元のファイルでアップロード自体は試みる(圧縮は最善努力)。
    return file;
  }
}

// 領収書写真をn8n「App Receipt Upload」経由でDriveへアップロードする。このワークフローは
// 秘密情報(Gateway Shared Secret)を要求せず、内部でemployee_codeをSupabaseへ照会して
// 本人確認する(ブラウザに秘密情報を埋め込まないための設計、詳細はn8n/app-receipt-upload.json)。
async function uploadReceiptPhoto(employeeCode, file) {
  file = await compressImageForUpload(file);
  const base64 = await fileToBase64(file);
  const res = await fetch(`${N8N_BASE_URL}/webhook/app-receipt-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeCode, fileName: file.name || 'receipt.jpg', mimeType: file.type || 'image/jpeg', base64 }),
  });
  const json = await res.json().catch(() => null);
  // 原因を後から追えるよう、サーバー側のエラー内容・HTTPステータスをそのままメッセージに含める
  // (「アップロードに失敗しました」とだけ表示すると、通信エラーなのかサーバー側の処理失敗なのか
  // 区別できず実機での原因調査ができなかったため)。
  if (!res.ok || !json || json.error || !json.driveFileId) {
    throw new Error((json && json.error) || `アップロードに失敗しました(status:${res.status})`);
  }
  return json;
}

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function setSession(session) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REMEMBERED_CODE_KEY);
}
function getRememberedCode() { return localStorage.getItem(REMEMBERED_CODE_KEY); }
function setRememberedCode(code) { localStorage.setItem(REMEMBERED_CODE_KEY, code); }

function getDeviceAuth() {
  try { return JSON.parse(localStorage.getItem(DEVICE_AUTH_KEY)); } catch { return null; }
}
function setDeviceAuth(employeeCode, token) {
  localStorage.setItem(DEVICE_AUTH_KEY, JSON.stringify({ employeeCode, token }));
  currentDeviceToken = token;
}
function clearDeviceAuth() {
  localStorage.removeItem(DEVICE_AUTH_KEY);
  currentDeviceToken = null;
}

const SCREEN_ENTER_HOOKS = {};

// 下部ナビは5つ(ホーム/申請/お知らせ/履歴/自分)。そこから遷移するサブ画面にいる間も、
// 元のタブが点灯したままになるようにマッピングする。
const BOTTOM_NAV_MAP = {
  menu: 'menu',
  'assignment-calendar': 'menu',
  'menu-apply': 'menu-apply', leave: 'menu-apply', expense: 'menu-apply', 'expense-select': 'menu-apply', 'expense-advance': 'menu-apply', 'expense-company': 'menu-apply',
  'expense-bulk': 'menu-apply',
  meeting: 'menu-apply', 'supply-request': 'menu-apply', 'qual-submit': 'menu-apply', 'health-submit': 'menu-apply',
  'entertainment-submit': 'menu-apply', 'daily-report': 'menu-apply',
  'joyo-denpyo-list': 'menu-apply', 'joyo-denpyo-form': 'menu-apply', 'joyo-denpyo-detail': 'menu-apply', 'joyo-denpyo-print': 'menu-apply',
  announcements: 'announcements',
  history: 'history',
  myinfo: 'myinfo', 'leave-history': 'myinfo', 'my-supply': 'myinfo', 'my-qual': 'myinfo', 'my-health': 'myinfo',
  'my-change-requests': 'myinfo', 'profile-edit': 'myinfo', 'pin-change': 'myinfo', 'anon-consult': 'myinfo', 'anon-submit': 'myinfo',
  'anon-done': 'myinfo', 'anon-thread': 'myinfo', 'my-entertainment': 'myinfo', 'my-daily-reports': 'myinfo',
  'entertainment-update': 'myinfo', 'entertainment-late-submit': 'myinfo',
};

// 絵文字を廃止し線画SVG(icons.js)へ統一するための一括反映。静的HTML内の
// <span class="icon-slot" data-icon="name">を実際のSVGへ差し替える。back-linkは
// 個別にdata-iconを書かなくても済むよう、ここでまとめて先頭にアイコンを付ける。
function hydrateIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
    el.removeAttribute('data-icon');
  });
  scope.querySelectorAll('.back-link:not([data-hydrated])').forEach((el) => {
    el.setAttribute('data-hydrated', '1');
    el.insertAdjacentHTML('afterbegin', icon('chevron-left'));
  });
}

// スマホのハードウェア/ジェスチャーの「戻る」に対応するため、画面遷移のたびに
// history.pushStateで積んでおく(popstateから呼ぶ場合はfromPopstate:trueにして
// 積み直さない)。これが無いと「戻る」操作がアプリ内遷移として扱われず、
// アプリ自体が終了・ホーム画面に戻る等の予期しない挙動になってしまう。
// 管理者専用画面(ここに来た時点で下部ナビを管理者用に切り替える)。個人側の5タブ
// (ホーム/申請/お知らせ/履歴/自分)を管理者作業中に誤って押して個人ページへ
// 戻ってしまう不具合の対策として、管理者モード中は専用の下部ナビだけを表示し、
// 個人画面へは専用の「社員画面に戻る」ボタンからのみ戻れるようにする。
const ADMIN_SCREENS = new Set([
  'admin', 'admin-dashboard', 'admin-announce', 'admin-request-list', 'admin-all-requests', 'admin-role-management',
  'anon-admin', 'anon-admin-thread',
  'qual-admin', 'category-review', 'employee-directory', 'employee-detail', 'info-change-admin',
  'supply-master-admin', 'entertainment-admin', 'site-admin', 'leave-admin', 'leave-grant',
  'employee-summary', 'employee-monthly-detail', 'attendance-matrix', 'bulk-expense-admin', 'bulk-expense-detail',
  'expense-payment', 'joyo-denpyo-admin', 'event-admin', 'license-admin', 'health-admin',
  'daily-report-admin', 'daily-report-management', 'daily-report-detail', 'daily-report-people', 'purpose-admin',
  'daily-report-needs-review-admin', 'daily-report-edit-requests-admin',
  'subcontractor-company-admin', 'subcontractor-worker-admin', 'personnel-ledger-hub',
  'supply-holdings-admin', 'supply-request-admin', 'joyo-denpyo-summary', 'master-management-hub', 'employee-create',
  'first-login-codes-admin',
]);
let inAdminMode = false;
// 「戻る」ボタンの遷移元復帰(2026-08-28)で使う、アプリ内で実際に何回画面遷移したかのカウンタ。
// showScreenでpushStateするたびに増え、popstateで戻るたびに減る。0の間はまだ本当の遷移元が
// 無い(リロード直後等)ことを示す。
let appNavDepth = 0;

function showScreen(id, opts) {
  opts = opts || {};
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
  const preAuthScreens = ['login', 'pin-entry', 'pin-register'];
  if (!preAuthScreens.includes(id)) {
    if (ADMIN_SCREENS.has(id)) inAdminMode = true;
    else if (BOTTOM_NAV_MAP[id] || id === 'menu') inAdminMode = false; // 個人側の画面へ来たら管理者モードを解除
  }
  // 配置カレンダーを開いている間だけページ側をスクロールさせない(INT-16)。
  // 配置カレンダーは上部を「スクロール領域の外」に置いて日付移動UIを固定しているため、
  // ページ側が別にスクロールすると、その保証が崩れてモジュールごと上へ流れてしまう。
  document.body.classList.toggle('assignment-calendar-open', id === 'assignment-calendar');
  if (id === 'assignment-calendar') mountAssignmentCalendar();
  else unmountAssignmentCalendar();
  document.getElementById('bottom-nav').style.display = (!preAuthScreens.includes(id) && !inAdminMode) ? 'flex' : 'none';
  document.getElementById('admin-bottom-nav').style.display = (!preAuthScreens.includes(id) && inAdminMode) ? 'flex' : 'none';
  // ログイン前・管理者モード中は案内AIを表示しない(下部ナビと同じ扱い)。
  document.getElementById('ai-guide-fab-wrap').style.display = (!preAuthScreens.includes(id) && !inAdminMode) ? '' : 'none';
  if (preAuthScreens.includes(id) || inAdminMode) closeAiGuidePanel();
  document.querySelectorAll('.bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === (BOTTOM_NAV_MAP[id] || id));
  });
  document.querySelectorAll('.admin-bottom-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === id);
  });
  if (!opts.fromPopstate && !preAuthScreens.includes(id)) {
    if (opts.replace) {
      // 完了画面(screen-done)への遷移・そこからの離脱に使う。pushStateすると、
      // 送信フォーム→完了画面→次の画面、と積み上がった履歴を「戻る」で辿るたびに
      // 完了画面へ戻ってきてしまう(無限ループに見える)・フォーム画面へ戻って
      // 二重送信を誘発する、という2つの問題が起きるため、履歴を積まずに置き換える。
      history.replaceState({ screen: id }, '', location.pathname + location.search);
    } else {
      history.pushState({ screen: id }, '', location.pathname + location.search);
      appNavDepth += 1;
    }
  }
  window.scrollTo(0, 0);
  if (SCREEN_ENTER_HOOKS[id]) SCREEN_ENTER_HOOKS[id]();
}

window.addEventListener('popstate', (e) => {
  if (!getSession()) return; // ログイン前はブラウザ標準の戻る動作に任せる
  if (appNavDepth > 0) appNavDepth -= 1;
  const id = (e.state && e.state.screen) || 'menu';
  if (document.getElementById(`screen-${id}`)) showScreen(id, { fromPopstate: true });
});

// 「戻る」ボタンの遷移元復帰(2026-08-28、ユーザー指示): 同じ機能画面がホーム/申請一覧など
// 複数の入口から開かれる場合、「戻る」は固定の画面ではなく実際に開いた入口へ戻るべき、という
// 指示に対応する。history.pushStateは画面遷移のたびに既に積んでいるため、本当に前の画面が
// あるとわかっている場合(appNavDepthで管理)だけhistory.back()を使い、直接この画面を開いた
// (リロード等でアプリ内の遷移履歴が無い)場合はdata-navの固定先へ安全にフォールバックする。
function goBackToOrigin(fallbackTarget) {
  if (appNavDepth > 0) { history.back(); return; }
  showScreen(fallbackTarget);
}

// 各種申請の完了画面(screen-done)は共通だが、「メニューに戻る」を常にホームへ
// 固定すると申請のたびにホームへ戻されて不便なため、申請元の画面へ戻れるように
// 遷移先を呼び出し側から指定できるようにする。
// 「差し戻す」「却下する」を押すと理由入力欄が下に表示される作りだが、ボタンの
// すぐ下に表示されるだけだと画面の下に隠れて何も起きていないように見えるため、
// 表示と同時にスクロールしてテキストエリアへフォーカスする。
function revealReasonBox(boxEl) {
  boxEl.style.display = 'block';
  boxEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const textarea = boxEl.querySelector('textarea');
  if (textarea) setTimeout(() => textarea.focus(), 300);
}

function showDone(message, returnTo) {
  document.getElementById('done-message').textContent = message;
  document.querySelector('#screen-done [data-nav]').setAttribute('data-nav', returnTo || 'menu');
  // 送信元のフォーム画面をそのまま履歴に残さず完了画面へ置き換える(戻るでフォームへ
  // 戻って二重送信、を防ぐ)。
  showScreen('done', { replace: true });
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.add('show');
}
function hideError(elId) {
  document.getElementById(elId).classList.remove('show');
}

let pendingLoginCode = null; // 社員番号入力〜暗証番号入力/登録の間だけ保持する一時変数

// 起動時: この端末が有効な端末トークンを持っていれば、暗証番号なしでログイン状態を
// 復元する(「初回だけ本人確認、以後はログイン状態を維持」の実体)。トークンが
// 無効(別端末・管理者に無効化された・退職/利用停止)なら暗証番号の入力へフォールバックする。
async function tryResumeDeviceSession() {
  const auth = getDeviceAuth();
  if (!auth || !auth.token || !auth.employeeCode) return false;
  currentDeviceToken = auth.token;
  try {
    const rows = await rpc('resume_employee_session', { p_employee_code: auth.employeeCode });
    const info = rows && rows[0];
    if (!info) throw new Error('empty');
    setSession({ employeeCode: auth.employeeCode, employeeId: info.out_employee_id, employeeName: info.out_employee_name, requestRole: info.out_request_role });
    return true;
  } catch (e) {
    // この端末が管理者の承認待ちなだけの場合は、トークンを消さずに承認待ち画面へ留める
    // (ここでclearDeviceAuth()してしまうと、承認待ちの間にアプリを開くたびPIN再入力を要求し、
    // そのたびに新しい「承認待ち端末」が作られてしまう)。
    if ((e.message || '').includes('承認待ち')) return 'pending';
    clearDeviceAuth();
    return false;
  }
}

// 起動時: 端末が社員番号を覚えていれば暗証番号入力画面へ、覚えていなければ社員番号入力画面へ。
async function startLoginFlow() {
  const resumeResult = await tryResumeDeviceSession();
  if (resumeResult === true) { enterMenu(); return; }
  if (resumeResult === 'pending') { showScreen('device-pending'); return; }

  const remembered = getRememberedCode();
  if (!remembered) { showScreen('login'); return; }

  pendingLoginCode = remembered;
  hideError('pin-entry-error');
  document.getElementById('pin-entry-name').textContent = '確認中...';
  showScreen('pin-entry');
  try {
    const rows = await rpc('check_employee_has_pin', { p_employee_code: remembered });
    const info = rows && rows[0];
    if (!info || !info.exists_and_active) {
      // 退職・無効化された社員番号を端末が覚えていた場合は、社員番号入力からやり直させる。
      clearSession();
      showScreen('login');
      return;
    }
    if (!info.has_pin) {
      showScreen('pin-register');
      resetRegisterSteps();
      return;
    }
    document.getElementById('pin-entry-name').textContent = `${info.employee_name}さん`;
  } catch (e) {
    document.getElementById('pin-entry-name').textContent = '';
    showError('pin-entry-error', '通信エラーが発生しました。');
  }
}

async function doSubmitEmployeeCode() {
  const code = document.getElementById('login-code').value.trim();
  hideError('login-error');
  if (!code) return;
  try {
    const rows = await rpc('check_employee_has_pin', { p_employee_code: code });
    const info = rows && rows[0];
    if (!info || !info.exists_and_active) {
      showError('login-error', '社員番号が確認できませんでした。');
      return;
    }
    pendingLoginCode = code;
    setRememberedCode(code);
    if (info.has_pin) {
      hideError('pin-entry-error');
      document.getElementById('pin-entry-name').textContent = `${info.employee_name}さん`;
      showScreen('pin-entry');
    } else {
      hideError('pin-register-error');
      showScreen('pin-register');
      resetRegisterSteps();
    }
  } catch (e) {
    showError('login-error', '通信エラーが発生しました。電波の良い場所でもう一度お試しください。');
  }
}

// ============================================================
// 暗証番号の表示/非表示 (E-14)
//
// 現場では手袋のまま片手で入力するため、打ち間違いに気づけないまま
// 5回失敗して15分ロックされる事故が起きやすい。既定は非表示のまま、
// 目のボタンで確認できるようにする。
// 個々の画面へ個別に書かず、type="password" の欄すべてへ一括で付ける
// (今後PIN欄が増えても付け忘れが起きない)。
// ============================================================
function attachPinRevealToggles() {
  const inputs = document.querySelectorAll('input[type="password"][inputmode="numeric"]');
  inputs.forEach((input) => {
    if (input.dataset.revealAttached === '1') return;
    input.dataset.revealAttached = '1';
    let field = input.parentElement;
    if (!field || !field.classList.contains('pin-field')) {
      field = document.createElement('div');
      field.className = 'pin-field';
      input.parentNode.insertBefore(field, input);
      field.appendChild(input);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pin-reveal';
    btn.textContent = '👁';
    btn.setAttribute('aria-label', '暗証番号を表示する');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.setAttribute('aria-label', show ? '暗証番号を隠す' : '暗証番号を表示する');
      input.focus();
    });
    field.appendChild(btn);
  });
}

// ============================================================
// 弱い暗証番号を使っている人へのお願い (E-13)
// ログインは拒否しない。ホームで変更を促すだけ。
// ============================================================
async function refreshPinWeakBanner(session) {
  const banner = document.getElementById('pin-weak-banner');
  if (!banner || !session) return;
  try {
    const rows = await rpc('get_my_auth_status', { p_employee_code: session.employeeCode });
    const st = Array.isArray(rows) ? rows[0] : rows;
    banner.style.display = st && st.out_must_change_pin ? '' : 'none';
  } catch (e) {
    // 取得できなくてもホーム自体は使えるようにする(RPCが無い環境でも壊さない)
    banner.style.display = 'none';
  }
}

// ============================================================
// 暗証番号をお忘れの方 (E-15)
// 端末トークンが手元にあるかどうかで、その場で再設定できるかが決まる。
// ============================================================
function openPinForgot() {
  const auth = getDeviceAuth();
  const hasDevice = !!(auth && auth.token && pendingLoginCode && auth.employeeCode === pendingLoginCode);
  document.getElementById('pin-forgot-device-card').style.display = hasDevice ? '' : 'none';
  document.getElementById('pin-forgot-request-card').style.display = hasDevice ? 'none' : '';
  hideError('pin-forgot-error');
  hideError('pin-forgot-request-error');
  document.getElementById('pin-forgot-new').value = '';
  document.getElementById('pin-forgot-confirm').value = '';
  showScreen('pin-forgot');
  attachPinRevealToggles();
}

async function doPinForgotReset() {
  const pin = document.getElementById('pin-forgot-new').value.trim();
  const confirmPin = document.getElementById('pin-forgot-confirm').value.trim();
  hideError('pin-forgot-error');
  if (!/^[0-9]{4,6}$/.test(pin)) {
    showError('pin-forgot-error', '暗証番号は4〜6桁の数字で入力してください。');
    return;
  }
  if (pin !== confirmPin) {
    showError('pin-forgot-error', '確認用の暗証番号が一致しません。');
    return;
  }
  const btn = document.getElementById('pin-forgot-submit');
  btn.disabled = true;
  try {
    await rpc('reset_my_pin_with_device', { p_employee_code: pendingLoginCode, p_new_pin: pin });
    // 設定した暗証番号でそのままログインする(もう一度打たせない)
    const rows = await rpc('verify_employee_pin', { p_employee_code: pendingLoginCode, p_pin: pin });
    if (!rows || rows.length === 0) { showError('pin-forgot-error', '設定できましたが、ログインに失敗しました。もう一度お試しください。'); return; }
    const emp = rows[0];
    setSession({ employeeCode: pendingLoginCode, employeeId: emp.out_employee_id, employeeName: emp.out_employee_name, requestRole: emp.out_request_role });
    setDeviceAuth(pendingLoginCode, emp.out_device_token);
    if (emp.out_approval_status === 'pending') { showScreen('device-pending'); return; }
    enterMenu();
  } catch (e) {
    showError('pin-forgot-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

async function doPinResetRequest() {
  hideError('pin-forgot-request-error');
  const btn = document.getElementById('pin-forgot-request-submit');
  btn.disabled = true;
  try {
    await rpc('request_pin_reset', { p_employee_code: pendingLoginCode, p_note: null });
    // 社員番号の存在有無を画面から推測できないよう、常に同じ文言を出す。
    showError('pin-forgot-request-error', '管理者へ再設定の依頼を送りました。初回登録コードが伝えられるまでお待ちください。');
  } catch (e) {
    showError('pin-forgot-request-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// ログイン済みの本人が、現在の暗証番号を思い出せないまま設定し直す (E-15)。
// 端末トークンが本人確認そのものなので、管理者を介さずに完結する。
async function doPinChangeReset() {
  const pin = document.getElementById('pin-change-reset-new').value.trim();
  const confirmPin = document.getElementById('pin-change-reset-confirm').value.trim();
  hideError('pin-change-reset-error');
  if (!/^[0-9]{4,6}$/.test(pin)) {
    showError('pin-change-reset-error', '暗証番号は4〜6桁の数字で入力してください。');
    return;
  }
  if (pin !== confirmPin) {
    showError('pin-change-reset-error', '確認用の暗証番号が一致しません。');
    return;
  }
  const btn = document.getElementById('pin-change-reset-submit');
  btn.disabled = true;
  try {
    const session = getSession();
    await rpc('reset_my_pin_with_device', { p_employee_code: session.employeeCode, p_new_pin: pin });
    document.getElementById('pin-change-reset-new').value = '';
    document.getElementById('pin-change-reset-confirm').value = '';
    showDone('暗証番号を設定しました。次回のログインから新しい暗証番号をお使いください。', 'myinfo');
  } catch (e) {
    showError('pin-change-reset-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// 配置カレンダー(別モジュール)の組み込み
//
// 独自の認証・独自の社員/現場マスターは持たせない。ポータルが既に持っている
// rpc() とログイン中の社員番号をそのまま渡すだけで、同じセッションで動く
// (統合仕様書 §6)。画面を離れるときは destroy() を呼んで resize リスナーを外す。
// ============================================================
let assignmentCalendarApi = null;

function mountAssignmentCalendar() {
  const root = document.getElementById('assignment-calendar-root');
  if (!root || !window.AssignmentCalendar) return;
  const session = getSession();
  if (!session) return;
  if (assignmentCalendarApi) { assignmentCalendarApi.refresh(); return; }
  try {
    assignmentCalendarApi = window.AssignmentCalendar.mount(root, {
      rpc,
      employeeCode: session.employeeCode,
      employeeName: session.employeeName,
      // 現場管理アプリはまだ無い。用意できたらここで site_id を渡して遷移させる。
      onOpenSite: null,
    });
  } catch (e) {
    root.innerHTML = '<div class="hint" style="padding:16px;">配置カレンダーを開けませんでした。時間をおいてもう一度お試しください。</div>';
  }
}

// ホームの配置カードから、配置カレンダーの「特定の日」を開く。
// 現場名の文字列一致ではなく、正式な日付(dateStr)で AssignmentCalendar.goToDate を呼ぶ。
// goToDate は month ビューでその日を選択状態にし、その日の詳細(現場・集合時間・メンバー等)を
// 読み込み直して描画する。配置が変更・取消されていても、遷移先は常に最新データを再取得する
// ため、古い配置へ飛ぶことはない。
function openAssignmentCalendarAt(dateStr) {
  showScreen('assignment-calendar'); // ここで mountAssignmentCalendar が呼ばれ api がセットされる
  if (!dateStr) return;
  const go = () => { try { if (assignmentCalendarApi && assignmentCalendarApi.goToDate) assignmentCalendarApi.goToDate(dateStr); } catch (e) { /* カレンダー未初期化時は月表示のまま */ } };
  // mount直後の初期ロード(render)と競合しないよう、次のタスクでジャンプする。
  if (assignmentCalendarApi) setTimeout(go, 0); else setTimeout(go, 60);
}

function unmountAssignmentCalendar() {
  if (!assignmentCalendarApi) return;
  try { assignmentCalendarApi.destroy(); } catch (e) { /* 既に外れている */ }
  assignmentCalendarApi = null;
  const root = document.getElementById('assignment-calendar-root');
  if (root) root.innerHTML = '';
}

async function doVerifyPin() {
  const pin = document.getElementById('pin-entry-code').value.trim();
  hideError('pin-entry-error');
  if (!pin) return;
  const btn = document.getElementById('pin-entry-submit');
  btn.disabled = true;
  try {
    const rows = await rpc('verify_employee_pin', { p_employee_code: pendingLoginCode, p_pin: pin });
    if (!rows || rows.length === 0) {
      showError('pin-entry-error', '暗証番号が違います。');
      document.getElementById('pin-entry-code').value = '';
      return;
    }
    const emp = rows[0];
    setSession({ employeeCode: pendingLoginCode, employeeId: emp.out_employee_id, employeeName: emp.out_employee_name, requestRole: emp.out_request_role });
    setDeviceAuth(pendingLoginCode, emp.out_device_token);
    document.getElementById('pin-entry-code').value = '';
    if (emp.out_approval_status === 'pending') { showScreen('device-pending'); return; }
    enterMenu();
  } catch (e) {
    showError('pin-entry-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// 初回登録は2段階。ここが1段階目: 初回登録コードから対象社員を特定し、氏名を本人に見せる。
// コードはまだ消費しない(ここでやめても、もう一度やり直せる)。
function resetRegisterSteps() {
  const step1 = document.getElementById('pin-register-step1');
  const step2 = document.getElementById('pin-register-step2');
  if (step1) step1.style.display = '';
  if (step2) step2.style.display = 'none';
  const name = document.getElementById('pin-register-name');
  if (name) name.textContent = '初めての方へ';
  const identified = document.getElementById('pin-register-identified-name');
  if (identified) identified.textContent = '';
  hideError('pin-register-error');
  hideError('pin-register-error2');
  for (const id of ['pin-register-code', 'pin-register-confirm']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
}

async function doIdentifyForRegister() {
  // 初回登録コードは大文字英数字のみ。コピペや一部キーボードで小文字・空白が混ざると
  // bcrypt照合(サーバ側)で失敗するため、送信前に空白除去+大文字化して正規化する。
  const firstCode = document.getElementById('pin-register-first-code').value.replace(/\s+/g, '').toUpperCase();
  hideError('pin-register-error');
  if (!firstCode) {
    showError('pin-register-error', '初回登録コードを入力してください。管理者から渡されていない場合は管理者へお問い合わせください。');
    return;
  }
  const btn = document.getElementById('pin-register-identify');
  btn.disabled = true;
  try {
    const rows = await rpc('identify_employee_by_first_login_code',
      { p_employee_code: pendingLoginCode, p_first_login_code: firstCode });
    const name = rows && rows[0] && rows[0].out_employee_name;
    if (!name) throw new Error('初回登録コードが正しくありません。管理者へお問い合わせください。');
    document.getElementById('pin-register-identified-name').textContent = `${name} さん`;
    document.getElementById('pin-register-step1').style.display = 'none';
    document.getElementById('pin-register-step2').style.display = '';
    hideError('pin-register-error2');
  } catch (e) {
    showError('pin-register-error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// 2段階目: 本人だと確認できたうえで、本人が自分の暗証番号を決める。
async function doRegisterPin() {
  // 初回登録コードは大文字英数字のみ。コピペや一部キーボードで小文字・空白が混ざると
  // bcrypt照合(サーバ側)で失敗するため、送信前に空白除去+大文字化して正規化する。
  const firstCode = document.getElementById('pin-register-first-code').value.replace(/\s+/g, '').toUpperCase();
  const pin = document.getElementById('pin-register-code').value.trim();
  const pinConfirm = document.getElementById('pin-register-confirm').value.trim();
  hideError('pin-register-error2');

  if (!/^[0-9]{4,6}$/.test(pin)) {
    showError('pin-register-error2', '暗証番号は4〜6桁の数字で入力してください。');
    return;
  }
  if (pin !== pinConfirm) {
    showError('pin-register-error2', '確認用の暗証番号が一致しません。');
    return;
  }

  const btn = document.getElementById('pin-register-submit');
  btn.disabled = true;
  try {
    const rows = await rpc('register_employee_pin', { p_employee_code: pendingLoginCode, p_first_login_code: firstCode, p_pin: pin });
    const emp = rows[0];
    setSession({ employeeCode: pendingLoginCode, employeeId: emp.out_employee_id, employeeName: emp.out_employee_name, requestRole: emp.out_request_role });
    setDeviceAuth(pendingLoginCode, emp.out_device_token);
    document.getElementById('pin-register-first-code').value = '';
    document.getElementById('pin-register-code').value = '';
    document.getElementById('pin-register-confirm').value = '';
    if (emp.out_approval_status === 'pending') { showScreen('device-pending'); return; }
    enterMenu();
  } catch (e) {
    showError('pin-register-error2', e.message);
  } finally {
    btn.disabled = false;
  }
}


// 承認待ち画面の「更新して確認する」ボタン。承認されていればenterMenu()、まだなら
// 画面はそのまま(showScreenは何度呼んでも安全)。
async function retryDevicePending() {
  const btn = document.getElementById('device-pending-retry');
  if (btn) btn.disabled = true;
  const resumeResult = await tryResumeDeviceSession();
  if (resumeResult === true) { enterMenu(); }
  if (btn) btn.disabled = false;
}

// 「別の社員番号でログインし直す」= 実質的なログアウト。既にログイン済みであれば、
// この端末のトークンをサーバー側でも明示的に無効化してから画面を切り替える
// (共有端末の切り替え時に前の利用者のトークンを残さないため)。
async function switchEmployee() {
  const session = getSession();
  if (session && currentDeviceToken) {
    try { await rpc('logout_employee_session', { p_employee_code: session.employeeCode }); } catch (e) { /* 失敗しても端末側は必ずログアウトさせる */ }
  }
  clearSession();
  clearDeviceAuth();
  pendingLoginCode = null;
  document.getElementById('login-code').value = '';
  showScreen('login');
}

async function loadHomeLeaveStats(balanceElId, usedElId, grantedElId) {
  const session = getSession();
  try {
    const rows = await rpc('get_leave_summary', { p_employee_code: session.employeeCode });
    const b = rows && rows[0];
    document.getElementById(balanceElId).textContent = b && b.has_active_period ? `${b.remaining_this_period}日` : '未設定';
    document.getElementById(usedElId).textContent = b && b.has_active_period ? `${b.used_this_period}日` : '-';
    if (grantedElId) document.getElementById(grantedElId).textContent = b && b.has_active_period ? `${b.granted_this_period}日` : '-';
  } catch (e) { /* 表示できなくても致命的ではないため無視 */ }
}

// ホームの挨拶・声かけ。以前は時刻を3区分・季節を2区分だけで判定し、深夜0時台でも
// 「おはようございます」「熱中症に気をつけて」が出てしまう不自然な固定文だった。
// 朝/昼/夕方/夜/深夜の5区分×複数の言い回しをランダムに選び、季節(暑い時期/寒い時期)・
// 曜日(月曜/金曜)も加味することで、会社から自然に声をかけられている感覚を目指す。
//
// 天候条件との連動は今回実装しない(外部APIの継続課金判断が必要なため、コスト面の承認を
// 得てから対応する)。getWeatherHint()を拡張点として用意しておき、将来天候データを
// 取得できるようになった時点で、この関数の中身を実装するだけで声かけへ反映できる設計にする。
function getWeatherHint() {
  return null; // 将来の拡張点(天候API連携)。現時点では常にnull。
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildHomeGreeting() {
  const now = new Date();
  const h = now.getHours();
  const day = now.getDay(); // 0=日, 1=月, ... 6=土
  const month = now.getMonth() + 1;
  const isHotSeason = month >= 6 && month <= 9;
  const isColdSeason = month === 12 || month === 1 || month === 2;
  const weatherHint = getWeatherHint();

  let band;
  if (h >= 5 && h < 11) band = 'morning';
  else if (h >= 11 && h < 17) band = 'afternoon';
  else if (h >= 17 && h < 19) band = 'evening';
  else if (h >= 19 && h < 23) band = 'night';
  else band = 'lateNight';

  const GREETINGS = {
    morning: ['おはようございます。今日も安全第一でいきましょう', 'おはようございます。今日も一日よろしくお願いします',
      ...(day === 1 ? ['おはようございます。今週も一週間よろしくお願いします'] : [])],
    afternoon: ['お疲れさまです。午後からも安全第一でいきましょう', 'お疲れさまです。残りの時間も無理のないように'],
    evening: ['今日もお疲れさまでした', ...(day === 5 ? ['今週もお疲れさまでした。よい週末を'] : ['今日も一日ありがとうございました'])],
    night: ['今日も一日お疲れさまでした', 'お疲れさまです。今日もありがとうございました'],
    lateNight: ['遅い時間までお疲れさまです', '夜遅くまでお疲れさまです'],
  };

  const SUBS = {
    morning: [
      ...(isHotSeason ? ['今日は暑くなりそうです。こまめに水分補給してください'] : []),
      ...(isColdSeason ? ['冷え込む朝です。暖かくしてお出かけください'] : []),
      '今日も気をつけて行ってらっしゃい', '無理のない範囲で今日も頑張りましょう',
    ],
    afternoon: [
      ...(isHotSeason ? ['暑い時間帯です。水分と休憩をしっかり取ってください'] : []),
      '午後もこまめに休憩を取ってください', 'あと少し、無理せずいきましょう',
    ],
    evening: ['日報の入力忘れがないか確認してください', '帰り道も気をつけてお帰りください'],
    night: ['明日に備えて、今日はゆっくり休んでください', '今日も一日、お疲れさまでした'],
    lateNight: ['明日に備えて、無理せず早めに休んでください', '体調を崩さないよう、今日はゆっくり休んでください'],
  };

  const sub = weatherHint || pick(SUBS[band]);
  return { greeting: pick(GREETINGS[band]), sub };
}

// 配置カレンダー専用URL(calendar/)から未ログインで飛ばされてきた場合、
// ログインが済んだ時点でそちらへ戻す。認証画面をカレンダー側にも作らず、
// ログインは常にこの社員ポータル1か所だけで行うための仕組み
// (calendar/calendar-boot.js の goPortalLogin() と対になっている)。
//
// 2026-09-01修正: 以前は location.search だけを見ていたため、
//   (1) 新しい端末で暗証番号ログインすると「承認待ち」画面へ入り、
//       承認後に「更新して確認する」を押した時点では戻り先が分からない
//   (2) 途中で画面を再読み込みするとクエリが消えて戻り先を失う
// という2つの経路でカレンダーへ戻れず、社員ポータルのホームに留まっていた。
// 戻り先をsessionStorageへ覚えておき、ホームへ入る時点で必ず消費する。
const LOGIN_RETURN_KEY = 'jinshou_login_return';

// 戻り先はアプリ内の決まった場所だけを許可する。外部URLを受け取って
// そこへ飛ばす作り(オープンリダイレクト)にはしない。
const LOGIN_RETURN_TARGETS = { calendar: 'calendar/' };

// 起動時に ?next=... が付いていたら覚えておく。A(通常版)・B(更新先行版)とも
// 相対パスで戻すので、開いていた側のカレンダーへそのまま帰る。
function rememberLoginReturn() {
  try {
    const next = new URLSearchParams(location.search).get('next');
    if (next && LOGIN_RETURN_TARGETS[next]) sessionStorage.setItem(LOGIN_RETURN_KEY, next);
  } catch (e) { /* sessionStorageが使えない環境では戻り先を覚えないだけ */ }
}

function consumeLoginRedirect() {
  let next = null;
  try {
    next = sessionStorage.getItem(LOGIN_RETURN_KEY)
      || new URLSearchParams(location.search).get('next');
  } catch (e) { return false; }
  const target = next && LOGIN_RETURN_TARGETS[next];
  if (!target) return false;
  try { sessionStorage.removeItem(LOGIN_RETURN_KEY); } catch (e) { /* 消せなくても遷移はする */ }
  location.replace(target);
  return true;
}

function enterMenu(replace) {
  if (consumeLoginRedirect()) return;
  const session = getSession();
  const { greeting, sub } = buildHomeGreeting();
  document.getElementById('menu-greeting-hi').textContent = greeting;
  document.getElementById('menu-greeting-name').textContent = `${session.employeeName}さん`;
  document.getElementById('menu-greeting-sub').textContent = sub;
  checkAnonUnreadBadge().then(loadTodayList);
  loadAnnounceBanner();
  loadHomeAnnouncePreview();
  showScreen('menu', { replace: !!replace });
  renderHomeAdminBanner(session);
  renderHomeDailyReportCard(session);
  renderHomeDailyReportStatusBanner(session);
  renderHomeMonthStats(session);
  renderHomeLeaveCard(session);
  renderHomeStatusSummaryCard(session);
  renderHomeUpcomingEvents(session);
  renderHomeEventsArea(session);
  renderHomeMyOutingBanner(session);
  renderHomeAssignmentCard(session);
  refreshPinWeakBanner(session);
}

// 本人が現在「外出・一時離脱」中の場合、ホーム最上部に目立つバナーで表示し、その場で
// 「戻りました」を押せるようにする(status-submit画面まで行かないと戻れない、という
// 二度手間を避ける)。status-submit画面の「現在、外出・離脱中です」カードと同じデータ・
// 同じRPC(get_employee_status_timeline/mark_status_report_returned)を再利用する。
async function renderHomeMyOutingBanner(session) {
  const banner = document.getElementById('home-my-outing-banner');
  if (!banner) return;
  try {
    const rows = await rpc('get_employee_status_timeline', { p_employee_code: session.employeeCode, p_target_employee_code: session.employeeCode, p_work_date: null });
    const active = (rows || []).filter((r) => r.status === 'active' && r.event_type === 'outing');
    if (active.length === 0) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
    banner.style.display = '';
    banner.innerHTML = active.map((r) => `
      <div class="row1"><span><strong>現在 ${r.category || '外出'}中です</strong></span></div>
      <div class="row2">${r.destination ? `行き先: ${r.destination}　` : ''}${r.expected_return_at ? `予定復帰 ${new Date(r.expected_return_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
      <button type="button" class="danger-submit" style="margin-top:8px;" data-home-return-id="${r.id}">戻りました</button>
    `).join('');
    banner.querySelectorAll('[data-home-return-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('mark_status_report_returned', { p_employee_code: session.employeeCode, p_report_id: Number(btn.dataset.homeReturnId) });
          await renderHomeMyOutingBanner(session);
        } catch (e) {
          btn.disabled = false;
          alert(e.message || '処理に失敗しました。');
        }
      });
    });
  } catch (e) { /* 取得できなくてもホーム自体は使えるようにする */ }
}

// 配置カレンダー(別プロジェクト)で登録された「本人の今日・明日の配置予定」をホームに表示する
// (2026-08-31、Shota指示: 配置を本人ポータルへ通知・日報を打ちやすくする)。
// 配置カレンダー側が既に実装済みの assignment_get_my_schedule をそのまま再利用する
// (重複実装しない、SKILL-003)。配置テーブルはまだProductionに無いため、RPCが存在しない/
// 空の場合はカードを隠すだけで、ホーム自体は正常に使えるようにする(graceful degrade)。
// 「確定ではなく、変更もあるので、とりあえず見える・打ちやすくするため」という位置づけのため
// 予定として控えめに表示する(強い通知バナーにはしない)。
function normalizeSchedule(raw) {
  // assignment_get_my_scheduleはRETURNS jsonb。PostgREST経由では配列がそのまま返るが、
  // 環境差で {assignment_get_my_schedule:[...]} 形になる場合にも備えて正規化する。
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.assignment_get_my_schedule)) return raw.assignment_get_my_schedule;
  return [];
}

async function renderHomeAssignmentCard(session) {
  const card = document.getElementById('home-assignment-card');
  if (!card) return;
  const today = todayJST();
  const tomorrow = (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  try {
    const rows = normalizeSchedule(await rpc('assignment_get_my_schedule', { p_employee_code: session.employeeCode, p_date_from: today, p_date_to: tomorrow }));
    const mine = rows.filter((r) => r && r.assignment_kind !== 'off'); // 休み等は除く
    if (mine.length === 0) { card.style.display = 'none'; card.innerHTML = ''; return; }
    // タップで配置カレンダーの「その日」へ遷移する(現場名の文字列推測ではなく、正式な
    // 日付(r.date)で AssignmentCalendar.goToDate を呼ぶ。要件: date/schedule_id を使う)。
    const line = (r) => {
      const when = r.date === today ? '今日' : (r.date === tomorrow ? '明日' : r.date);
      const time = r.time_label || (r.is_allday ? '終日' : '');
      const meet = r.meeting_time ? `集合${r.meeting_time}` : '';
      const haul = r.assignment_kind === 'haul' ? '🚚 ' : '';
      // 配置確認: HOMEから1タップで正式な配置確認(assignment_confirm_my_assignment, member_id指定)を行う。
      // 確認済みは confirmed_at で判定。既読(read_at)とは別。連打しても二重登録しない(idempotent)。
      const confirmUi = r.confirmed_at
        ? '<span class="mini-tag info" style="flex:none;">✓ 確認済み</span>'
        : (r.member_id ? `<button type="button" class="secondary home-assign-confirm-btn" data-member-id="${r.member_id}" style="flex:none;padding:6px 10px;font-size:13px;">配置を確認する</button>` : '');
      return `<div class="home-assignment-row-wrap" style="border-top:1px solid var(--line,rgba(128,128,128,0.2));padding:8px 2px;">
        <div class="home-assignment-row" data-date="${r.date}" role="button" tabindex="0"
          style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;">
          <span class="row2" style="flex:1;min-width:0;">${when}: ${haul}${safeText(r.label, '現場未設定')}${time ? `　${time}` : ''}${meet ? `　${meet}` : ''}</span>
          <span aria-hidden="true" style="color:var(--muted);font-size:18px;line-height:1;flex:none;">›</span>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:4px;">${confirmUi}</div>
      </div>`;
    };
    card.style.display = '';
    card.innerHTML = `<div class="row1"><span><strong>📍 配置予定</strong>(配置カレンダーより・変更される場合があります)</span></div>${mine.map(line).join('')}<div class="hint-inline" style="margin-top:4px;">タップすると配置カレンダーの詳細（集合時間・メンバー等）を確認できます</div>`;
    card.querySelectorAll('.home-assignment-row').forEach((rowEl) => {
      const go = () => openAssignmentCalendarAt(rowEl.dataset.date);
      rowEl.addEventListener('click', go);
      rowEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    });
    // HOMEから1タップで正式な配置確認(member_id指定)。管理者カレンダーの確認数へ即時反映。
    card.querySelectorAll('.home-assign-confirm-btn').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        btn.disabled = true; btn.textContent = '確認中...';
        try {
          await rpc('assignment_confirm_my_assignment', { p_employee_code: session.employeeCode, p_member_id: Number(btn.dataset.memberId) });
          renderHomeAssignmentCard(session); // 再取得して「確認済み」表示へ
        } catch (e2) { btn.disabled = false; btn.textContent = '配置を確認する'; alert(e2.message || '配置の確認に失敗しました。'); }
      });
    });
  } catch (e) {
    // 配置テーブルがまだ無い環境(Production等)ではRPCが無くエラーになる。カードを隠すだけ。
    card.style.display = 'none'; card.innerHTML = '';
  }
}

// 日報は社員が最も頻繁に使う機能のため、「よく使う機能」の固定最優先カードとする
// (利用回数による自動並び替えの対象にはしない)。本日提出済みかどうかでラベル・
// 遷移先の案内文だけを切り替える(画面自体はdaily-reportのまま。既存のloadDailyReportForDateが
// 提出済み内容を表示するため、そのまま「確認」の役割も果たす)。
async function renderHomeDailyReportCard(session) {
  const descEl = document.getElementById('home-daily-report-desc');
  try {
    const rows = await rpc('get_my_daily_report_for_date', { p_employee_code: session.employeeCode, p_report_date: todayJST() });
    const submitted = (rows || []).some((r) => r.report_status === 'submitted' || r.report_status === 'confirmed');
    descEl.textContent = submitted ? '本日の日報を確認' : '今日の日報を入力';
  } catch (e) { /* 取得できなくても遷移自体はできるため無視 */ }
}

// ホーム画面「今月の状況」(給与期間の出勤日数・残業時間だけを簡潔に表示し、詳細は
// 日報履歴・カレンダー画面へ誘導する。全項目を詰め込んで見づらくしない設計)。
async function renderHomeMonthStats(session) {
  const el = document.getElementById('home-month-stats');
  el.innerHTML = '';
  el.onclick = () => showScreen('my-daily-reports');
  try {
    const now = new Date();
    const rows = await rpc('get_my_daily_report_month_summary', {
      p_employee_code: session.employeeCode, p_year: now.getFullYear(), p_month: now.getMonth() + 1, p_period_type: 'pay_period',
    });
    const s = rows && rows[0];
    if (!s) return;
    const fmtN = (n) => Number(n || 0).toFixed(1).replace(/\.0$/, '');
    el.innerHTML = `
      <div class="stat-mini"><span class="stat-mini-label">今月出勤日数</span><span class="stat-mini-value">${fmtN(s.work_days)}日</span></div>
      <div class="stat-mini"><span class="stat-mini-label">今月残業時間</span><span class="stat-mini-value">${fmtN(s.overtime_hours)}h</span></div>
    `;
  } catch (e) { /* 取れなくてもホーム全体の表示は続ける */ }
}

async function renderHomeLeaveCard(session) {
  const descEl = document.getElementById('home-leave-desc');
  try {
    const rows = await rpc('get_leave_summary', { p_employee_code: session.employeeCode });
    const b = rows && rows[0];
    descEl.textContent = b && b.has_active_period ? `今年度 使用${b.used_this_period}日・残り${b.remaining_this_period}日` : '残日数を確認・申請する';
  } catch (e) { /* 取れなくても遷移自体はできる */ }
}

// ホーム「今日の在席・不在」カードに、タップせずとも一目で分かる現在人数のサマリーを表示する
// (2026-08-28第4弾、ユーザー指示: 在席状況は補助機能のため横長コンパクトな1行カードへ縮小し、
// 「休暇○人｜外出○人｜遅刻○人｜早退○人」の形式で表示する)。get_employee_status_board_generalは
// 既にセンシティブな理由等を返さない設計のため、そのまま再利用して件数だけ集計する
// (新規RPCは追加しない)。
async function renderHomeStatusSummaryCard(session) {
  const descEl = document.getElementById('home-status-summary-desc');
  if (!descEl) return;
  try {
    const rows = await rpc('get_employee_status_board_general', { p_employee_code: session.employeeCode });
    const counts = { on_leave: 0, out: 0, late: 0, early_left: 0 };
    (rows || []).forEach((r) => { if (counts[r.current_state] !== undefined) counts[r.current_state] += 1; });
    const total = counts.on_leave + counts.out + counts.late + counts.early_left;
    descEl.textContent = total === 0
      ? '現在、共有事項はありません'
      : `休暇${counts.on_leave}人｜外出${counts.out}人｜遅刻${counts.late}人｜早退${counts.early_left}人`;
  } catch (e) { /* 取れなくても遷移自体はできる */ }
}

// ホーム画面「近日予定」(会社からのお知らせとは別カテゴリ、本人が登録した個人予定のみ)。
// 直近のものだけを優先表示し(1か月先の予定でホームが埋まらないように)、当日・前日は強調する。
async function renderHomeUpcomingEvents(session) {
  const area = document.getElementById('home-upcoming-events-area');
  try {
    const rows = await rpc('get_my_upcoming_calendar_events', { p_employee_code: session.employeeCode, p_days_ahead: 14, p_limit: 5 });
    if (!rows || rows.length === 0) { area.innerHTML = ''; return; }
    const urgencyLabel = { today: '本日', tomorrow: '明日', this_week: '今週', later: '' };
    area.innerHTML = `
      <div class="section-title">近日予定</div>
      <div class="today-list">
        ${rows.map((ev) => `
          <div class="today-item ${ev.urgency === 'today' || ev.urgency === 'tomorrow' ? 'urgent' : ''}" data-event-nav="${ev.event_date}">
            <span class="today-item-icon"><span class="icon-slot" data-icon="calendar"></span></span>
            <div class="today-item-body">
              <div class="today-item-label">${urgencyLabel[ev.urgency] ? urgencyLabel[ev.urgency] + '　' : ''}${ev.event_date.slice(5).replace('-', '/')}${ev.start_time ? ' ' + ev.start_time.slice(0, 5) : ''}　${ev.title}</div>
              ${ev.location ? `<div class="today-item-count">${ev.location}</div>` : ''}
            </div>
            <span class="today-item-arrow"><span class="icon-slot" data-icon="chevron-right"></span></span>
          </div>
        `).join('')}
      </div>
    `;
    hydrateIcons(area);
    area.querySelectorAll('[data-event-nav]').forEach((el) => {
      el.addEventListener('click', () => {
        const d = el.dataset.eventNav;
        showScreen('my-daily-reports');
        setTimeout(() => {
          setDailyReportView('calendar');
          const [y, m] = d.split('-').map(Number);
          dailyReportCalYear = y; dailyReportCalMonth = m;
          loadDailyReportCalendar().then(() => onDailyReportCalDayClick(d, null));
        }, 50);
      });
    });
  } catch (e) {
    area.innerHTML = '';
  }
}

// ホーム画面から1タップで「本日の日報を確認」できるようにする専用バナー(2026-08-26追加)。
// 提出済み/未提出/要確認の3状態を出し分け、タップ先も状態に応じて変える
// (未提出→入力画面、それ以外→詳細確認画面)。「よく使う機能」の日報カード(入力用)とは別に、
// ホーム上部で状態そのものが一目で分かるようにする。
// 2026-08-28(第3弾): 独立した「本日の日報未提出」バナーはホームから廃止し、同内容は
// 「今日やること」(get_my_today_tasksのown_daily_report/needs_review/rejected各行)へ
// 一本化した(同じ情報を複数箇所に出さない、ユーザー指示)。ここでは、休暇でも未提出でもない
// 「今日は休みとして登録する」のワンタップ導線だけを、今日やることの直下に残す
// (提出済み・休暇登録済みの日は表示しない)。
async function renderHomeDailyReportStatusBanner(session) {
  // §2: 社員が自分で勤務日を休日に変更できる導線は不要。「今日は休みとして登録する」は完全撤去。
  // 休日はカレンダー(配置)・休暇情報からシステムが判定し、確定できる日はシステムが自動記録する。
  // 判定不能/競合時は勝手に休日化せず、管理者の要確認へ回す(サーバ側 daily_report_employee_bucket)。
  const restBtn = document.getElementById('home-daily-report-mark-rest-btn');
  if (restBtn) restBtn.style.display = 'none';
}

// executiveはadmin-dashboard(全管理メニュー)、日報担当(nippo_admin、executiveではない)は
// 日報管理画面への専用入口を表示する。nippo_adminはrequestRole(セッションに直接入っている値)
// では判定できず、都度サーバーへ確認が必要(check_nippo_admin RPC)なため非同期。
// admin-dashboard自体がisAdmin()(executive)限定のため、この入口が無いとnippo_adminは
// 日報管理画面へ辿り着く手段が無くなってしまう。
async function renderHomeAdminBanner(session) {
  const bannerArea = document.getElementById('admin-banner-area');
  const showAdmin = session.requestRole === 'executive';
  let html = '';
  if (showAdmin) {
    html = `
      <button type="button" class="main-menu-card" data-nav="admin-dashboard" style="width:100%; flex-direction:row; align-items:center; gap:14px; margin-top:8px;">
        <span class="main-menu-card-icon">${icon('shield')}</span>
        <span style="text-align:left;">
          <span class="main-menu-label" style="display:block;">管理者ダッシュボード</span>
          <span class="main-menu-desc">承認待ち・社員管理をまとめて確認</span>
        </span>
        <span style="margin-left:auto; color:var(--text-faint);">${icon('chevron-right')}</span>
      </button>
    `;
  } else if (await isNippoAdmin()) {
    html = `
      <button type="button" class="main-menu-card" data-nav="daily-report-management" style="width:100%; flex-direction:row; align-items:center; gap:14px; margin-top:8px;">
        <span class="main-menu-card-icon">${icon('clipboard-list')}</span>
        <span style="text-align:left;">
          <span class="main-menu-label" style="display:block;">日報管理(日報担当)</span>
          <span class="main-menu-desc">日報の確認・未提出者確認・外注代理入力</span>
        </span>
        <span style="margin-left:auto; color:var(--text-faint);">${icon('chevron-right')}</span>
      </button>
    `;
  }
  bannerArea.innerHTML = html;
  bannerArea.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => showScreen(el.getAttribute('data-nav')));
  });
}

// ホーム画面「会社からのお知らせ」の最新2〜3件ミニプレビュー。
async function loadHomeAnnouncePreview() {
  const session = getSession();
  const area = document.getElementById('home-announce-block');
  area.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_announcements', { p_employee_code: session.employeeCode });
    // 重要/最重要は上部のannounce-banner-area(loadAnnounceBanner)に固定表示されるため、
    // ここでは扱わない(二重表示を避ける)。表示順: ①通常のお知らせで未読
    // ②個人の申請通知(却下等)で未読。古い個人通知が通常のお知らせを埋もれさせないため。
    const homeRank = (a) => {
      const isPersonal = a.related_type === 'employee_requests';
      if (!isPersonal && !a.is_read) return 0;
      return 1;
    };
    // related_type='daily_reports'(日報未提出の自動通知)は、同じ内容を「今日やること」の
    // own_daily_reportが既に表示しているため、ここでも重複表示しない(2026-08-28、ユーザー指摘:
    // 「会社からのお知らせ：本日の日報未提出です」「今日やること：本日は日報がまだ記入されて
    // いません」の重複。importance='normal'の古い通知にも適用するため、importance='important'の
    // バナー側(loadAnnounceBanner)と同じ除外条件をここにも適用する)。
    const visible = (rows || []).filter((a) => a.importance === 'normal' && shouldShowOnHome(a) && a.related_type !== 'daily_reports')
      .sort((a, b) => homeRank(a) - homeRank(b) || new Date(b.created_at) - new Date(a.created_at));
    if (visible.length === 0) { area.innerHTML = '<div class="hint">お知らせはありません。</div>'; return; }
    const top = visible.slice(0, 3);
    const TAG_LABEL = { critical: '最重要', important: '重要' };
    area.innerHTML = top.map((a) => `
      <div class="home-announce-item" data-id="${a.id}">
        <span class="home-announce-dot ${a.importance !== 'normal' ? 'important' : (!a.is_read ? 'unread normal-imp' : '')}"></span>
        <div class="home-announce-body2">
          <div class="home-announce-title-row">
            ${TAG_LABEL[a.importance] ? `<span class="home-announce-tag important">${TAG_LABEL[a.importance]}</span>` : '<span class="home-announce-tag normal">お知らせ</span>'}
            <span class="home-announce-title">${a.title}</span>
          </div>
          <div class="home-announce-date">${new Date(a.created_at).toLocaleDateString('ja-JP')}</div>
        </div>
      </div>
    `).join('');
    area.querySelectorAll('.home-announce-item').forEach((el) => {
      el.addEventListener('click', () => showScreen('announcements'));
    });
  } catch (e) {
    area.innerHTML = '';
  }
}

// ---------- 有給休暇申請 ----------

function updateLeaveDaysDisplay() {
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const isHalf = document.getElementById('leave-half').checked;
  const box = document.getElementById('leave-days-box');
  if (!start || !end) { box.textContent = '日数: -'; return; }
  if (end < start) { box.textContent = '終了日は開始日以降にしてください'; return; }
  const days = isHalf && start === end ? 0.5 : (new Date(end) - new Date(start)) / 86400000 + 1;
  box.textContent = `日数: ${days}日`;
}

async function loadLeaveBalance() {
  const session = getSession();
  const box = document.getElementById('leave-balance-box');
  box.textContent = '残日数を確認中...';
  try {
    const rows = await rpc('get_leave_summary', { p_employee_code: session.employeeCode });
    const b = rows && rows[0];
    if (!b || !b.has_active_period) {
      document.getElementById('leave-summary-period').textContent = '';
      document.getElementById('leave-summary-used').textContent = '-';
      document.getElementById('leave-summary-granted').textContent = '-';
      document.getElementById('leave-summary-count').textContent = '-';
      document.getElementById('leave-summary-balance').textContent = '未設定';
      document.getElementById('leave-summary-note').textContent = '今年度の有給付与がまだ会社側で登録されていません。人事へご確認ください。';
      box.textContent = '';
    } else {
      const fmtDate = (d) => new Date(d).toLocaleDateString('ja-JP');
      document.getElementById('leave-summary-period').textContent = `対象期間: ${fmtDate(b.period_start)}〜${fmtDate(b.period_end)}`;
      document.getElementById('leave-summary-used').textContent = `${b.used_this_period}日`;
      document.getElementById('leave-summary-granted').textContent = `${b.granted_this_period}日`;
      document.getElementById('leave-summary-count').textContent = `${b.taken_count_this_period}回`;
      document.getElementById('leave-summary-balance').textContent = `${b.remaining_this_period}日`;
      document.getElementById('leave-summary-note').textContent = '';
      box.textContent = `申請後の残日数見込み: 計算中`;
    }
  } catch (e) {
    box.textContent = '';
  }
}

async function loadLeaveHistory() {
  const session = getSession();
  const listEl = document.getElementById('leave-history-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_leave_taken_history', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '<div class="hint">承認済みの有給取得履歴はまだありません。</div>';
      return;
    }
    listEl.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="row1"><span>${r.start_date} 〜 ${r.end_date}</span><span>${r.requested_days}日</span></div>
        <div class="row2">${r.reason || ''}${r.is_half_day ? '(半休)' : ''}</div>
        <span class="status-badge done">承認済み</span>
      `;
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSubmitLeave() {
  const session = getSession();
  const category = document.getElementById('leave-category').value;
  const start = document.getElementById('leave-start').value;
  const end = document.getElementById('leave-end').value;
  const isHalf = document.getElementById('leave-half').checked;
  const reason = document.getElementById('leave-reason').value.trim();
  const note = document.getElementById('leave-note').value.trim();
  hideError('leave-error');

  if (!start || !end || !reason) {
    showError('leave-error', '開始日・終了日・事由は必須です。');
    return;
  }
  if (end < start) {
    showError('leave-error', '終了日は開始日以降にしてください。');
    return;
  }

  const btn = document.getElementById('leave-submit');
  btn.disabled = true;
  try {
    await rpc('submit_paid_leave_request', {
      p_employee_code: session.employeeCode,
      p_start_date: start,
      p_end_date: end,
      p_is_half_day: isHalf,
      p_reason: reason,
      p_note: note || null,
      p_leave_category: category,
    });
    showDone(`${document.getElementById('leave-category').selectedOptions[0].textContent}の申請を受け付けました。承認をお待ちください。`, 'menu-apply');
    ['leave-start', 'leave-end', 'leave-reason', 'leave-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('leave-half').checked = false;
    updateLeaveDaysDisplay();
  } catch (e) {
    showError('leave-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 経費立替申請 / 会社経費登録(複数明細、共通画面) ----------

const EXPENSE_PAYMENT_OPTIONS = {
  employee_advance: ['現金', 'クレジットカード', '電子マネー', '振込', 'その他'],
  company_expense: ['会社現金', '法人カード', '会社口座', 'その他'],
};
const EXPENSE_SCREEN_TEXT = {
  employee_advance: {
    title: '経費立替申請',
    hint: '自分で支払った会社経費を申請します(後日会社から返金)。領収書の写真が必須です。複数の領収書をまとめて1回の申請にできます。',
  },
  company_expense: {
    title: '会社経費登録',
    hint: '会社(現金・法人カード・会社口座等)が既に支払った経費を登録します。社員への返金は発生しません。領収書の写真が必須です。',
  },
};

let currentExpenseCategory = 'employee_advance';
let expenseItemSeq = 0;
const expenseItemState = new Map(); // itemId -> { driveFileId, driveFileUrl, uploading, siteId }

// 取引先マスター(business_partners)から候補を読み込み、datalistで検索型選択を実現する。
// 入力値がマスターの名称と完全一致すればbusiness_partner_id、一致しなければ新規取引先名として
// 送信する(vendorNameToIdは送信時の解決に使う)。
let vendorNameToId = new Map();
async function populateVendorList() {
  try {
    const rows = await rpc('search_business_partners', { p_query: null });
    vendorNameToId = new Map(rows.map((v) => [v.partner_name, v.id]));
    document.getElementById('vendor-list').innerHTML = rows.map((v) => `<option value="${v.partner_name}">`).join('');
  } catch (e) { /* 取引先候補が引けなくても自由入力は継続できる */ }
}

// 使用目的マスター(expense_purpose_master、管理者のみ追加・編集・無効化可)から検索して選択する。
// 表記揺れ(「接待」「接待費」等がバラバラに保存される)を防ぐため、自由入力は許可しない
// (site-selectと同じ「検索→select」の方式)。
async function populatePurposeSelect(selectEl, query) {
  try {
    const rows = await rpc('search_expense_purposes', { p_query: query || null });
    const current = selectEl.value;
    selectEl.innerHTML = '<option value="">選択してください</option>' + rows.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
    if (current && rows.some((p) => p.name === current)) selectEl.value = current;
  } catch (e) { /* 候補が引けなくても他の項目は引き続き入力できる */ }
}

// 取引先参加者名を複数登録できる簡易チップ入力(検索は不要な自由記入の氏名リスト)。
// HTML側(expense-item-template)に既にある入力欄・追加ボタン・チップ表示欄を配線するだけで、
// マークアップの再生成はしない(打ち合わせ項目の他の要素を巻き込んで消さないため)。
function wirePartnerParticipantChips(card) {
  const names = [];
  const input = card.querySelector('.item-partner-participant-input');
  const chips = card.querySelector('.item-partner-participant-chips');

  function renderChips() {
    chips.innerHTML = names.map((n, i) => `
      <span class="participant-chip" data-idx="${i}">${n}<button type="button">${icon('x-circle')}</button></span>
    `).join('');
    chips.querySelectorAll('.participant-chip button').forEach((btn) => {
      btn.addEventListener('click', () => {
        names.splice(Number(btn.closest('.participant-chip').dataset.idx), 1);
        renderChips();
      });
    });
  }

  function addName() {
    const v = input.value.trim();
    if (!v) return;
    names.push(v);
    input.value = '';
    renderChips();
  }

  card.querySelector('.item-partner-participant-add-btn').addEventListener('click', addName);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addName(); }
  });

  return {
    getNames() { return names.slice(); },
    // 接待事前申請の紐付け時、取引先参加者名(「、」区切りの文字列)から事前反映するために使う。
    setNames(namesText) {
      names.length = 0;
      (namesText || '').split(/[、,]/).map((n) => n.trim()).filter(Boolean).forEach((n) => names.push(n));
      renderChips();
    },
  };
}

// 打ち合わせ・接待交際費の「自社参加者」複数選択(検索→タップで選択、チップで表示)。
function createParticipantSelect(container) {
  const selected = new Map();
  container.innerHTML = `
    <input type="text" class="participant-search-input" placeholder="氏名・社員番号で検索...">
    <div class="participant-results"></div>
    <div class="participant-chips"></div>
  `;
  const input = container.querySelector('.participant-search-input');
  const results = container.querySelector('.participant-results');
  const chips = container.querySelector('.participant-chips');
  let allEmployees = [];
  let onChange = null;

  const employeesLoaded = (async () => {
    const session = getSession();
    try { allEmployees = await rpc('list_employees_for_participant_select', { p_employee_code: session.employeeCode }); } catch (e) { /* 無視 */ }
  })();

  function renderChips() {
    chips.innerHTML = Array.from(selected.entries()).map(([code, name]) => `
      <span class="participant-chip" data-code="${code}">${name}<button type="button">${icon('x-circle')}</button></span>
    `).join('');
    chips.querySelectorAll('.participant-chip button').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected.delete(btn.closest('.participant-chip').dataset.code);
        renderChips();
        if (onChange) onChange();
      });
    });
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    const matches = allEmployees.filter((e) => !selected.has(e.employee_code) && (q === '' || e.employee_name.includes(q) || e.employee_code.includes(q))).slice(0, 8);
    results.innerHTML = matches.map((e, i) => `<button type="button" class="participant-result-item" data-idx="${i}">${e.employee_name}(${e.employee_code})</button>`).join('');
    results.querySelectorAll('.participant-result-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        selected.set(matches[i].employee_code, matches[i].employee_name);
        input.value = '';
        results.innerHTML = '';
        renderChips();
        if (onChange) onChange();
      });
    });
  });

  return {
    setOnChange(cb) { onChange = cb; },
    getSelectedCodes() { return Array.from(selected.keys()); },
    getCount() { return selected.size; },
    // 接待事前申請の紐付け時、自社参加者を候補データから事前選択するために使う。
    async setSelectedCodes(codes) {
      await employeesLoaded;
      selected.clear();
      (codes || []).forEach((code) => {
        const emp = allEmployees.find((e) => e.employee_code === code);
        selected.set(code, emp ? emp.employee_name : code);
      });
      renderChips();
      if (onChange) onChange();
    },
  };
}

// 共通: カード形式の社員選択コンポーネント(2026-08-28新設)。検索テキスト入力だけの
// createParticipantSelectより、スマホでの片手タップ選択のストレスが小さい代替として、
// 今後の申請・報告画面で再利用する想定(接待事前申請の自社参加者選択で最初に採用)。
// createParticipantSelectと同じインターフェース(setOnChange/getSelectedCodes/getCount/
// setSelectedCodes)を持つため、呼び出し元の他のコードを変更せずに差し替えられる。
function createEmployeeCardPicker(container) {
  const selected = new Map();
  container.innerHTML = `
    <input type="text" class="participant-search-input" placeholder="氏名・社員番号で絞り込み...">
    <div class="emp-picker-chips"></div>
    <div class="emp-picker-grid"></div>
  `;
  const input = container.querySelector('.participant-search-input');
  const chips = container.querySelector('.emp-picker-chips');
  const grid = container.querySelector('.emp-picker-grid');
  let allEmployees = [];
  let onChange = null;

  function render() {
    // 2026-08-28: 社員向け選択画面では役職・職種・部署等の分類を一切表示しない
    // (ユーザー指示: 一般社員が他の社員の内部区分を見る必要はない)。氏名だけのフラットな
    // 一覧にする(在籍中の全社員を1つのリストとして表示、部署等でグループ分けしない)。
    const q = input.value.trim();
    const matches = allEmployees.filter((e) => q === '' || e.employee_name.includes(q) || e.employee_code.includes(q));
    grid.innerHTML = `
      <div class="emp-picker-cards">
        ${matches.map((e) => `<button type="button" class="emp-picker-card${selected.has(e.employee_code) ? ' selected' : ''}" data-code="${e.employee_code}">${e.employee_name}</button>`).join('')}
      </div>
    `;
    grid.querySelectorAll('.emp-picker-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.code;
        const emp = allEmployees.find((e) => e.employee_code === code);
        if (selected.has(code)) selected.delete(code); else selected.set(code, emp ? emp.employee_name : code);
        render();
        if (onChange) onChange();
      });
    });
    chips.innerHTML = Array.from(selected.entries()).map(([code, name]) => `
      <span class="participant-chip" data-code="${code}">${name}<button type="button">${icon('x-circle')}</button></span>
    `).join('');
    chips.querySelectorAll('.participant-chip button').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected.delete(btn.closest('.participant-chip').dataset.code);
        render();
        if (onChange) onChange();
      });
    });
  }

  const employeesLoaded = (async () => {
    const session = getSession();
    // 2026-08-28: 社員選択画面では氏名・社員番号以外を返さないlist_employees_for_participant_select
    // を使う(list_employees_for_selectorは部署・役職まで返すため、社員向け選択UIには使わない)。
    try { allEmployees = await rpc('list_employees_for_participant_select', { p_employee_code: session.employeeCode }); } catch (e) { /* 無視 */ }
    render();
  })();

  input.addEventListener('input', render);

  return {
    setOnChange(cb) { onChange = cb; },
    getSelectedCodes() { return Array.from(selected.keys()); },
    getCount() { return selected.size; },
    async setSelectedCodes(codes) {
      await employeesLoaded;
      selected.clear();
      (codes || []).forEach((code) => {
        const emp = allEmployees.find((e) => e.employee_code === code);
        selected.set(code, emp ? emp.employee_name : code);
      });
      render();
      if (onChange) onChange();
    },
  };
}

const participantSelects = new Map(); // itemId -> インスタンス(経費明細ごとの自社参加者選択)

// 領収書の日付・店舗・金額から、承認済みの接待事前申請を検索して紐付け候補を出す。
async function searchAndShowPreapprovals(card, itemId) {
  const area = card.querySelector('.preapproval-search-area');
  const session = getSession();
  const date = card.querySelector('.item-date').value || null;
  const store = card.querySelector('.item-store').value.trim() || null;
  const amount = card.querySelector('.item-amount').value || null;
  const state = expenseItemState.get(itemId);
  area.innerHTML = '<div class="hint">承認済みの事前申請を確認しています...</div>';
  let candidates = [];
  try {
    candidates = await rpc('search_my_entertainment_preapprovals', {
      p_employee_code: session.employeeCode, p_near_date: date, p_near_store: store, p_near_amount: amount ? Number(amount) : null,
    });
  } catch (e) { /* 検索できなくても手動での判断に委ねる */ }

  if (candidates.length > 0) {
    area.innerHTML = '<div class="item-suggest-label">この接待の事前申請を選んでタップしてください</div>' + candidates.map((c, i) => `
      <div class="preapproval-candidate" data-idx="${i}">
        <div class="row1"><span>${c.planned_store || '(店舗未記入)'}</span><span>${c.planned_amount != null ? Number(c.planned_amount).toLocaleString() + '円' : ''}</span></div>
        <div class="row2">${new Date(c.planned_datetime).toLocaleString('ja-JP')}・${c.partner_name_snapshot || ''}</div>
      </div>
    `).join('');
    area.querySelectorAll('.preapproval-candidate').forEach((el, i) => {
      el.addEventListener('click', () => {
        area.querySelectorAll('.preapproval-candidate').forEach((x) => x.classList.remove('linked'));
        el.classList.add('linked');
        state.entertainmentPreapprovalId = candidates[i].id;

        // 事前申請で入力済みの情報を自動反映する(同じ内容を二度入力させない)。
        const c = candidates[i];
        if (c.business_partner_id) {
          vendorNameToId.set(c.partner_name_snapshot, c.business_partner_id);
          card.querySelector('.item-vendor').value = c.partner_name_snapshot || '';
        }
        if (!card.querySelector('.item-date').value && c.planned_datetime) {
          card.querySelector('.item-date').value = new Date(c.planned_datetime).toISOString().slice(0, 10);
        }
        if (!card.querySelector('.item-purpose').value && c.purpose) {
          card.querySelector('.item-purpose').value = c.purpose;
        }
        if (c.partner_participants && state.partnerParticipantChips) state.partnerParticipantChips.setNames(c.partner_participants);
        if (c.partner_participant_count) card.querySelector('.item-partner-count').value = c.partner_participant_count;
        const pSelect = participantSelects.get(itemId);
        if (pSelect && c.our_participant_employee_codes) {
          pSelect.setSelectedCodes(c.our_participant_employee_codes).then(() => {
            card.querySelector('.item-our-count').textContent = pSelect.getCount();
          });
        }
      });
    });
  } else {
    state.entertainmentPreapprovalId = null;
    const admin = session.requestRole === 'executive';
    area.innerHTML = `<div class="preapproval-warning">${icon('alert-triangle')}事前申請が確認できないため、この接待交際費は通常の経費として申請できません。「接待・会食」から先に事前申請してください。</div>`
      + (admin ? `
        <div class="preapproval-override-box">
          <label>例外理由(管理者のみ入力可)<span class="required-mark">(必須)</span></label>
          <textarea class="item-override-reason" placeholder="例: 先方都合で急遽実施、事前申請の時間が取れなかった"></textarea>
        </div>
      ` : '');
  }
}

function enterExpenseScreen(category) {
  currentExpenseCategory = category;
  const text = EXPENSE_SCREEN_TEXT[category];
  document.getElementById('expense-screen-title').textContent = text.title;
  document.getElementById('expense-screen-hint').textContent = text.hint;
  resetExpenseForm();
  hideError('expense-error');
  populateVendorList();
  showScreen('expense');
}

async function populateSiteSelect(selectEl, query, dailyReportOnly) {
  try {
    const session = getSession();
    const rows = await rpc('search_sites', { p_query: query || null, p_employee_code: session ? session.employeeCode : null, p_daily_report_only: !!dailyReportOnly });
    const current = selectEl.value;
    const recent = rows.filter((s) => s.recently_used);
    const others = rows.filter((s) => !s.recently_used);
    const opt = (s) => `<option value="${s.id}" data-name="${s.site_name}">${s.site_name}</option>`;
    let html = '<option value="">選択してください</option>';
    if (recent.length > 0) html += `<optgroup label="最近使った現場">${recent.map(opt).join('')}</optgroup>`;
    html += (recent.length > 0 ? '<optgroup label="現場一覧">' : '') + others.map(opt).join('') + (recent.length > 0 ? '</optgroup>' : '');
    html += '<option value="__new__">該当する現場がない/新しい現場を入力</option>';
    selectEl.innerHTML = html;
    if (current && (rows.some((s) => String(s.id) === current) || current === '__new__')) selectEl.value = current;
  } catch (e) { /* 現場マスターが引けない場合は空のまま(自由入力は不可、要確認扱い) */ }
}

// 過去の入力履歴から現場・使用目的の候補を提示する(タップで入力欄へ反映するだけで、
// 自動で確定・送信はしない。候補が無ければ何も表示しない=AIが推測で埋めることはない)。
async function showExpenseSuggestion(card, storeName) {
  const area = card.querySelector('.item-suggest-area');
  area.style.display = 'none';
  area.innerHTML = '';
  if (!storeName) return;
  try {
    const rows = await rpc('suggest_expense_context', { p_store_name: storeName });
    const s = rows && rows[0];
    if (!s || !s.site_id) return;
    area.innerHTML = `
      <div class="item-suggest-label">前回の入力から候補(タップで入力欄へ反映、必ず内容を確認してください)</div>
      <button type="button" class="item-suggest-chip">${icon('info')}<span>現場候補: ${s.site_name}／用途候補: ${s.purpose}${s.vendor_name ? `／取引先候補: ${s.vendor_name}` : ''}</span></button>
    `;
    area.style.display = 'block';
    area.querySelector('.item-suggest-chip').addEventListener('click', async () => {
      const siteSelect = card.querySelector('.item-site-select');
      await populateSiteSelect(siteSelect, '');
      siteSelect.value = String(s.site_id);
      card.querySelector('.item-purpose').value = s.purpose || '';
      if (s.vendor_name) card.querySelector('.item-vendor').value = s.vendor_name;
      area.innerHTML = '<div class="item-suggest-label">候補を反映しました。内容を確認してください。</div>';
    });
  } catch (e) { /* 候補が引けなくても致命的ではないため無視 */ }
}

async function runOcrForItem(card, file) {
  const ocrStatus = card.querySelector('.ocr-status');
  ocrStatus.textContent = 'AIが内容を読み取っています...';
  try {
    file = await compressImageForUpload(file);
    const base64 = await fileToBase64(file);
    const session = getSession();
    const res = await fetch(`${N8N_BASE_URL}/webhook/receipt-ocr-proxy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeCode: session.employeeCode, mimeType: file.type || 'image/jpeg', base64 }),
    });
    const json = await res.json().catch(() => null);
    const receipt = json && json.receipts && json.receipts[0];
    if (!receipt) { ocrStatus.textContent = ''; return; }

    // 読み取れた事実だけをフォームへ候補入力する(現場・使用目的・取引先はプロンプト側で
    // 出力させていないため、ここで埋まることはない=AIが推測で確定しない設計)。
    if (receipt.document_date) card.querySelector('.item-date').value = receipt.document_date;
    if (receipt.counterparty_raw) card.querySelector('.item-store').value = receipt.counterparty_raw;
    if (receipt.total_amount != null) { card.querySelector('.item-amount').value = receipt.total_amount; updateExpenseTotal(); }
    if (receipt.tax_amount != null) card.querySelector('.item-tax').value = receipt.tax_amount;

    const confidence = receipt.confidence || 'low';
    if (confidence === 'high') {
      ocrStatus.textContent = 'AIが内容を読み取りました。内容を確認してください(間違っていれば修正できます)。';
    } else if (confidence === 'medium') {
      ocrStatus.textContent = '読み取り精度が高くありません。内容を必ず確認・修正してください。';
    } else {
      ocrStatus.textContent = '読み取りに自信が持てませんでした。手入力で確認してください。';
      // 低信頼は候補として埋めない方が安全なため、金額以外はクリアする
      card.querySelector('.item-date').value = '';
      card.querySelector('.item-store').value = '';
    }

    if (receipt.counterparty_raw && confidence !== 'low') showExpenseSuggestion(card, receipt.counterparty_raw);
  } catch (e) {
    ocrStatus.textContent = '';
  }
}

// カードがまだ写真を選んでいない「空の初期枠」かどうか。撮影/写真選択ボタン
// (item-photo-step)がまだ表示されたまま=handlePhotoFileが一度も呼ばれていない状態。
function isExpenseItemEmpty(card) {
  const photoStep = card.querySelector('.item-photo-step');
  return !!photoStep && photoStep.style.display !== 'none';
}

// 明細ラベル(明細1,2,3...)を、内部の連番カウンタではなく実際のDOM順で振り直す。
// 追加・削除のたびに呼ぶことで、削除後や複数選択後も番号が1から連番のまま保たれる。
function renumberExpenseItems() {
  document.querySelectorAll('#expense-item-list .expense-item-card').forEach((card, idx) => {
    card.querySelector('.item-label').textContent = `明細${idx + 1}`;
  });
}

function addExpenseItem(initialFile) {
  const template = document.getElementById('expense-item-template');
  const clone = template.content.cloneNode(true);
  hydrateIcons(clone);
  const itemId = `item-${++expenseItemSeq}`;
  const card = clone.querySelector('.expense-item-card');
  card.dataset.itemId = itemId;
  expenseItemState.set(itemId, { driveFileId: null, driveFileUrl: null, uploading: false });

  const paymentSelect = clone.querySelector('.item-payment');
  paymentSelect.innerHTML = EXPENSE_PAYMENT_OPTIONS[currentExpenseCategory].map((p) => `<option value="${p}">${p}</option>`).join('');

  const siteSelect = clone.querySelector('.item-site-select');
  const siteSearch = clone.querySelector('.item-site-search');
  const newSiteWrap = clone.querySelector('.item-new-site-wrap');
  const newSiteToggleBtn = clone.querySelector('.item-new-site-toggle-btn');
  populateSiteSelect(siteSelect, '');
  siteSearch.addEventListener('input', () => populateSiteSelect(siteSelect, siteSearch.value.trim()));
  siteSelect.addEventListener('change', () => {
    if (siteSelect.value === '__new__') newSiteWrap.style.display = 'block';
  });
  // ネイティブselectの選択肢の中に埋もれて「新しい現場を入力」が見つけにくい実機があるため、
  // 常に見える専用ボタンからも同じ新規入力欄を開けるようにする(selectとボタン、どちらからでも入力可)。
  newSiteToggleBtn.addEventListener('click', () => {
    siteSelect.value = '__new__';
    newSiteWrap.style.display = 'block';
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    if (cardEl) cardEl.querySelector('.item-new-site-name').focus();
  });

  const purposeCategorySelect = clone.querySelector('.item-purpose-category');
  const purposeSearch = clone.querySelector('.item-purpose-search');
  const meetingBlock = clone.querySelector('.item-meeting-block');
  const entertainmentBlock = clone.querySelector('.item-entertainment-block');
  const partnerParticipantChips = wirePartnerParticipantChips(clone.querySelector('.item-meeting-block'));
  populatePurposeSelect(purposeCategorySelect, '');
  purposeSearch.addEventListener('input', () => populatePurposeSelect(purposeCategorySelect, purposeSearch.value.trim()));
  let lastEntertainmentSearchKey = '';
  function syncPurposeCategory() {
    const cat = purposeCategorySelect.value;
    const needsMeeting = cat === '取引先との打ち合わせ' || cat === '接待交際費';
    meetingBlock.style.display = needsMeeting ? 'block' : 'none';
    entertainmentBlock.style.display = cat === '接待交際費' ? 'block' : 'none';
    if (needsMeeting && !participantSelects.has(itemId)) {
      const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
      const inst = createParticipantSelect(cardEl.querySelector('.participant-select'));
      inst.setOnChange(() => { cardEl.querySelector('.item-our-count').textContent = inst.getCount(); });
      participantSelects.set(itemId, inst);
    }
    if (cat === '接待交際費' && lastEntertainmentSearchKey !== cat) {
      lastEntertainmentSearchKey = cat;
      const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
      searchAndShowPreapprovals(cardEl, itemId);
    } else if (cat !== '接待交際費') {
      lastEntertainmentSearchKey = '';
    }
  }
  purposeCategorySelect.addEventListener('change', syncPurposeCategory);
  expenseItemState.get(itemId).partnerParticipantChips = partnerParticipantChips;

  clone.querySelector('.remove-item-btn').addEventListener('click', () => {
    document.querySelector(`[data-item-id="${itemId}"]`).remove();
    expenseItemState.delete(itemId);
    participantSelects.delete(itemId);
    renumberExpenseItems();
    updateExpenseTotal();
  });

  const preview = clone.querySelector('.item-photo-preview');
  const status = clone.querySelector('.photo-status');
  const photoStep = clone.querySelector('.item-photo-step');
  const photoAttached = clone.querySelector('.item-photo-attached');
  const details = clone.querySelector('.item-details');

  async function handlePhotoFile(file) {
    if (!file) return;
    photoStep.style.display = 'none';
    photoAttached.style.display = 'block';
    details.style.display = 'block';
    updateExpenseTotal(); // 空明細ではなくなったので明細件数の表示に反映する

    // iPhone写真ライブラリのHEIC等、ブラウザによっては<img src>へ元ファイルを
    // そのまま渡しても正しく描画できない(実機で、領収書ではなく画面全体が単色の
    // 矩形になって表示される不具合を確認した)。アップロード時と同じcanvas経由の
    // 再エンコード(compressImageForUpload)を先に通してから、その結果をプレビューにも
    // 使うことで、実際にアップロードされる内容と同じ・確実に描画できるJPEGを表示する。
    let previewFile;
    try {
      previewFile = await compressImageForUpload(file);
    } catch (e) {
      previewFile = file;
    }
    preview.onerror = () => {
      status.textContent = 'プレビューを表示できませんでした(この端末で非対応の画像形式の可能性があります)。アップロードは続行されます。';
      status.className = 'photo-status err';
    };
    preview.src = URL.createObjectURL(previewFile);
    status.textContent = 'アップロード中...';
    status.className = 'photo-status uploading';
    const state = expenseItemState.get(itemId);
    state.uploading = true;
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    runOcrForItem(cardEl, file); // 並行実行(アップロード完了を待たずにOCRも進める)
    try {
      const session = getSession();
      const result = await uploadReceiptPhoto(session.employeeCode, file);
      state.driveFileId = result.driveFileId;
      state.driveFileUrl = result.driveFileUrl;
      status.textContent = 'アップロード完了';
      status.className = 'photo-status ok';
    } catch (e) {
      status.textContent = 'アップロードに失敗しました。もう一度お試しください。';
      status.className = 'photo-status err';
    } finally {
      state.uploading = false;
    }
  }

  clone.querySelector('.item-photo-input').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));
  clone.querySelector('.item-photo-input-lib').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));
  clone.querySelector('.retake-btn').addEventListener('click', () => {
    photoStep.style.display = 'flex';
    photoStep.style.flexDirection = 'column';
    photoAttached.style.display = 'none';
    status.textContent = '';
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    cardEl.querySelector('.ocr-status').textContent = '';
    const state = expenseItemState.get(itemId);
    state.driveFileId = null;
    state.driveFileUrl = null;
    updateExpenseTotal(); // 再び空明細に戻るので明細件数の表示に反映する
  });

  clone.querySelector('.item-amount').addEventListener('input', updateExpenseTotal);
  clone.querySelector('.item-store').addEventListener('blur', (e) => {
    const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
    if (e.target.value.trim()) showExpenseSuggestion(cardEl, e.target.value.trim());
  });

  document.getElementById('expense-item-list').appendChild(clone);
  renumberExpenseItems();
  updateExpenseTotal();
  if (initialFile) handlePhotoFile(initialFile);
}

// 複数の領収書写真を一度に選択したとき、写真1枚ごとに明細を1件自動作成してOCRを走らせる
// (写真1→OCR→明細1、写真2→OCR→明細2、…という流れ。1枚ずつ手作業で追加する必要をなくす)。
// 画面を開いた直後は常に空の明細1が1件だけ存在する(手動での単発撮影に備えた初期枠)。
// これを残したまま複数選択分を明細2以降へ積み増すと、選んだ枚数と番号がズレて
// 空の明細1だけが取り残されてしまうため、複数選択時はまだ写真を選んでいない
// 空の明細をすべて削除してから、選んだ枚数ぶんを1から連番で作り直す。
function addExpenseItemsBatch(files) {
  const fileArr = Array.from(files || []);
  if (fileArr.length === 0) return;
  document.querySelectorAll('#expense-item-list .expense-item-card').forEach((card) => {
    if (isExpenseItemEmpty(card)) {
      const itemId = card.dataset.itemId;
      card.remove();
      expenseItemState.delete(itemId);
      participantSelects.delete(itemId);
    }
  });
  fileArr.forEach((file) => addExpenseItem(file));
}

function updateExpenseTotal() {
  const cards = document.querySelectorAll('.expense-item-card');
  let total = 0;
  let validCount = 0;
  cards.forEach((card) => {
    if (isExpenseItemEmpty(card)) return;
    validCount += 1;
    const amount = Number(card.querySelector('.item-amount').value || 0);
    total += amount;
  });
  document.getElementById('expense-total-count').textContent = `${validCount}件`;
  document.getElementById('expense-total-amount').textContent = `${total.toLocaleString()}円`;
}

function resetExpenseForm() {
  document.getElementById('expense-item-list').innerHTML = '';
  expenseItemState.clear();
  participantSelects.clear();
  expenseItemSeq = 0;
  addExpenseItem();
}

async function doSubmitExpense() {
  const session = getSession();
  hideError('expense-error');
  const cards = Array.from(document.querySelectorAll('.expense-item-card'));

  if (cards.length === 0) {
    showError('expense-error', '明細を1件以上追加してください。');
    return;
  }

  const items = [];
  for (const card of cards) {
    const itemId = card.dataset.itemId;
    const state = expenseItemState.get(itemId);
    const date = card.querySelector('.item-date').value;
    const store = card.querySelector('.item-store').value.trim();
    const amount = Number(card.querySelector('.item-amount').value || 0);
    const tax = card.querySelector('.item-tax').value;
    const payment = card.querySelector('.item-payment').value;
    const note = card.querySelector('.item-note').value.trim();
    const label = card.querySelector('.item-label').textContent;
    const purposeCategory = card.querySelector('.item-purpose-category').value.trim();
    const purpose = card.querySelector('.item-purpose').value.trim();

    if (state.uploading) { showError('expense-error', `${label}: 写真のアップロード中です。少しお待ちください。`); return; }
    if (!state.driveFileId) { showError('expense-error', `${label}: 領収書またはレシートの写真を添付してください。`); return; }
    if (!date || !store || !amount) { showError('expense-error', `${label}: 利用日・支払先・金額は必須です。`); return; }
    if (!purposeCategory) { showError('expense-error', `${label}: 使用目的のカテゴリを選択してください。`); return; }
    if (['その他', '取引先との打ち合わせ', '接待交際費'].includes(purposeCategory) && !purpose) {
      showError('expense-error', `${label}: 使用目的の詳細を入力してください。`); return;
    }

    const siteSelect = card.querySelector('.item-site-select');
    let siteId = siteSelect.value || null;
    let newSiteName = null;
    let siteName = null;
    if (siteId === '__new__') {
      newSiteName = card.querySelector('.item-new-site-name').value.trim();
      if (!newSiteName) { showError('expense-error', `${label}: 新しい現場名を入力してください。`); return; }
      siteId = null;
    } else if (!siteId) {
      showError('expense-error', `${label}: 現場を選択してください。`); return;
    } else {
      siteName = siteSelect.options[siteSelect.selectedIndex].dataset.name;
    }

    const vendorText = card.querySelector('.item-vendor').value.trim();
    const businessPartnerId = vendorNameToId.get(vendorText) || null;
    const newBusinessPartnerName = (!businessPartnerId && vendorText) ? vendorText : null;

    let partnerParticipants = null;
    let partnerCount = null;
    let ourCodes = null;
    const needsMeeting = purposeCategory === '取引先との打ち合わせ' || purposeCategory === '接待交際費';
    if (needsMeeting) {
      if (!businessPartnerId && !newBusinessPartnerName) { showError('expense-error', `${label}: 取引先を選択または入力してください。`); return; }
      const chipNames = state.partnerParticipantChips ? state.partnerParticipantChips.getNames() : [];
      partnerParticipants = chipNames.length > 0 ? chipNames.join('、') : null;
      partnerCount = Number(card.querySelector('.item-partner-count').value || 0);
      if (!partnerCount) { showError('expense-error', `${label}: 取引先の参加人数を入力してください。`); return; }
      const pSelect = participantSelects.get(itemId);
      ourCodes = pSelect ? pSelect.getSelectedCodes() : [];
      if (ourCodes.length === 0) { showError('expense-error', `${label}: 自社参加者を選択してください。`); return; }
    }

    let entertainmentPreapprovalId = null;
    let overrideReason = null;
    if (purposeCategory === '接待交際費') {
      entertainmentPreapprovalId = state.entertainmentPreapprovalId || null;
      if (!entertainmentPreapprovalId) {
        if (session.requestRole === 'executive') {
          const reasonEl = card.querySelector('.item-override-reason');
          overrideReason = reasonEl ? reasonEl.value.trim() : '';
          if (!overrideReason) { showError('expense-error', `${label}: 事前申請が確認できないため、この接待交際費は通常の経費として申請できません。管理者の場合は例外理由を入力してください。`); return; }
        } else {
          showError('expense-error', `${label}: 事前申請が確認できないため、この接待交際費は通常の経費として申請できません。「接待・会食」から先に事前申請してください。`); return;
        }
      }
    }

    items.push({
      document_date: date, store, amount, tax_amount: tax ? Number(tax) : null,
      site_id: siteId, site_name: siteName, new_site_name: newSiteName,
      business_partner_id: businessPartnerId, new_business_partner_name: newBusinessPartnerName, vendor_name: vendorText || null,
      purpose_category: purposeCategory, purpose,
      partner_participants: partnerParticipants, partner_participant_count: partnerCount,
      our_participant_employee_codes: ourCodes,
      entertainment_preapproval_id: entertainmentPreapprovalId, admin_override_reason: overrideReason,
      payment_method: payment, content_description: note || null,
      drive_file_id: state.driveFileId, drive_file_url: state.driveFileUrl,
    });
  }

  const btn = document.getElementById('expense-submit');
  btn.disabled = true;
  try {
    const result = await rpc('submit_expense_claim', { p_employee_code: session.employeeCode, p_expense_category: currentExpenseCategory, p_items: items });
    const r = result && result[0];
    const label = currentExpenseCategory === 'company_expense' ? '会社経費登録' : '経費立替申請';
    showDone(`${label}を受け付けました(${r ? r.item_count : items.length}件、合計${r ? Number(r.total_amount).toLocaleString() : ''}円)。承認をお待ちください。`, 'menu-apply');
    resetExpenseForm();
  } catch (e) {
    showError('expense-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- まとめて精算(複数画像・複数明細を1回で申請) ----------
// 「かんたん申請」(写真1枚=明細1件)とは別の入口。1枚の写真に複数の領収書が写っていても
// AI(receipt-ocr-proxy)は既にreceipts[]を配列で返せる設計になっていたため、ここでは
// 配列の全要素を消費して明細を自動生成する(既存のrunOcrForItemはreceipts[0]しか
// 使っていなかった、まとめて精算専用にrunBulkOcrForPhotoを新設する)。

let bulkExpenseCategory = 'employee_advance';
let bulkItems = []; // { id, date, store, amount, tax, confidence, driveFileId, driveFileUrl, fileHash, siteId, siteName, purposeCategory, note }
let bulkItemSeq = 0;
let bulkCoverSheet = null; // { driveFileId, driveFileUrl, declaredTotal, applicantName }

async function computeFileHashHex(file) {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return null; // 対応環境が無くても重複検知が効かないだけで申請自体は続行できる
  }
}

// receipts[]配列の全要素を消費する(既存runOcrForItemとの違いはこの1点)。
// 通信・サーバーエラーは呼び出し元で「失敗として再試行できる」よう例外を投げる。
// 「AIが実際に解析して0件だった(白紙等)」場合だけ空配列を返す。
async function runBulkOcrForPhoto(file) {
  file = await compressImageForUpload(file);
  const base64 = await fileToBase64(file);
  const session = getSession();
  const res = await fetch(`${N8N_BASE_URL}/webhook/receipt-ocr-proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeCode: session.employeeCode, mimeType: file.type || 'image/jpeg', base64 }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('領収書の解析に失敗しました');
  return json.receipts || [];
}

function bulkTotalAmount() {
  return bulkItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
}

function updateBulkExpenseTotal() {
  document.getElementById('expense-bulk-item-count').textContent = String(bulkItems.length);
  document.getElementById('expense-bulk-total-count').textContent = `${bulkItems.length}件`;
  document.getElementById('expense-bulk-total-amount').textContent = `${bulkTotalAmount().toLocaleString('ja-JP')}円`;
  updateBulkReconciliationPreview();
}

function updateBulkReconciliationPreview() {
  const box = document.getElementById('expense-bulk-reconciliation-box');
  if (!bulkCoverSheet || bulkCoverSheet.declaredTotal == null) { box.style.display = 'none'; return; }
  const sum = bulkTotalAmount();
  const matched = Math.abs(sum - bulkCoverSheet.declaredTotal) < 1;
  box.style.display = 'block';
  box.innerHTML = matched
    ? `<div class="mini-tag info">${icon('check-circle')}照合OK: 経費精算書の合計(${bulkCoverSheet.declaredTotal.toLocaleString('ja-JP')}円)と明細合計が一致</div>`
    : `<div class="mini-tag warn">${icon('alert-triangle')}金額不一致・要確認: 経費精算書は${bulkCoverSheet.declaredTotal.toLocaleString('ja-JP')}円、明細合計は${sum.toLocaleString('ja-JP')}円です</div>`;
  hydrateIcons(box);
}

const CONFIDENCE_LABEL = { high: '高', medium: '中', low: '低(要確認)' };
// 高信頼→自動入力のまま(緑チェック)、中信頼→要本人確認(黄色警告)、低信頼→要手動確認(赤警告)。
// AIが読めなかった/自信が無いものを推測で確定させないという方針を、色で一目で分かるようにする。
const CONFIDENCE_BADGE = {
  high: { cls: 'done', icon: 'check-circle', text: '読取OK' },
  medium: { cls: '', mini: 'warn', icon: 'alert-triangle', text: '要確認' },
  low: { cls: 'rejected', icon: 'alert-triangle', text: '要手動確認' },
};

function bulkItemSummaryHtml(item) {
  const badge = CONFIDENCE_BADGE[item.confidence] || CONFIDENCE_BADGE.low;
  const badgeHtml = badge.mini
    ? `<span class="mini-tag ${badge.mini}">${icon(badge.icon)}${badge.text}</span>`
    : `<span class="status-badge ${badge.cls}">${icon(badge.icon)}${badge.text}</span>`;
  const traceHtml = item.photoLabel ? `<div class="hint-inline">元画像: ${item.photoLabel}</div>` : '';
  return `${item.amount != null ? Number(item.amount).toLocaleString('ja-JP') + '円' : '金額未読取'} ${badgeHtml}${item.siteName ? `・現場: ${item.siteName}` : ''}${item.purposeCategory ? `・${item.purposeCategory}` : ''}${traceHtml}`;
}

function renderBulkItemRow(item) {
  const tpl = document.getElementById('expense-bulk-item-template');
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.dataset.itemId = item.id;
  if (item.photoQueueId) row.dataset.photoQueueId = item.photoQueueId;
  row.querySelector('.item-label').textContent = `${item.date || '日付未読取'}・${item.store || '支払先不明'}`;
  row.querySelector('.bulk-item-summary').innerHTML = bulkItemSummaryHtml(item);

  row.querySelector('.remove-item-btn').addEventListener('click', () => {
    bulkItems = bulkItems.filter((it) => it.id !== item.id);
    row.remove();
    updateBulkExpenseTotal();
  });

  const editBox = row.querySelector('.bulk-item-edit');
  row.querySelector('.bulk-item-edit-toggle').addEventListener('click', async () => {
    const opening = editBox.style.display === 'none';
    editBox.style.display = opening ? 'block' : 'none';
    if (!opening) return;
    const dateEl = row.querySelector('.bi-date'); dateEl.value = item.date || '';
    const storeEl = row.querySelector('.bi-store'); storeEl.value = item.store || '';
    const amountEl = row.querySelector('.bi-amount'); amountEl.value = item.amount != null ? item.amount : '';
    row.querySelector('.bi-confidence').textContent = `AI読み取り信頼度: ${CONFIDENCE_LABEL[item.confidence] || '不明'}`;
    const siteEl = row.querySelector('.bi-site');
    await populateSiteSelect(siteEl, '');
    if (item.siteId) siteEl.value = String(item.siteId);
    const purposeEl = row.querySelector('.bi-purpose');
    await populatePurposeSelect(purposeEl, '');
    if (item.purposeCategory) purposeEl.value = item.purposeCategory;
    const noteEl = row.querySelector('.bi-note'); noteEl.value = item.note || '';

    const sync = () => {
      item.date = dateEl.value || null;
      item.store = storeEl.value.trim() || null;
      item.amount = amountEl.value ? Number(amountEl.value) : null;
      item.siteId = siteEl.value && siteEl.value !== '__new__' ? siteEl.value : null;
      item.siteName = siteEl.value ? (siteEl.selectedOptions[0] && siteEl.selectedOptions[0].dataset.name) || siteEl.selectedOptions[0].textContent : null;
      item.purposeCategory = purposeEl.value || null;
      item.note = noteEl.value.trim() || null;
      // 本人が中身を入力・確認した明細は、AIの当初confidenceが低くても「確認済み」として
      // 緑表示に切り替える(読めなかったものを本人が確認して埋めた、という状態を表す)。
      if (item.date && item.store && item.amount && item.siteId && item.purposeCategory) item.confidence = 'high';
      row.querySelector('.item-label').textContent = `${item.date || '日付未読取'}・${item.store || '支払先不明'}`;
      row.querySelector('.bulk-item-summary').innerHTML = bulkItemSummaryHtml(item);
      updateBulkExpenseTotal();
    };
    [dateEl, storeEl, amountEl, siteEl, purposeEl, noteEl].forEach((el) => el.addEventListener('change', sync));
    amountEl.addEventListener('input', sync);
  });

  document.getElementById('expense-bulk-item-list').appendChild(row);
}

// 写真ごとの処理状況(待機中/解析中/完了/失敗)を保持する。1枚ずつ独立して失敗・再試行
// できるようにするため、選択されたFileListそのものではなくこのキューで状態管理する
// (失敗した1枚だけを後から再試行できるように、Fileオブジェクト自体をここに保持する)。
let bulkPhotoQueue = [];
let bulkPhotoSeq = 0;

function renderBulkPhotoProgress() {
  const el = document.getElementById('expense-bulk-receipts-progress');
  if (bulkPhotoQueue.length === 0) { el.innerHTML = ''; return; }
  const STATUS_LABEL2 = { pending: '待機中', processing: '解析中...', done: '完了', failed: '失敗' };
  el.innerHTML = bulkPhotoQueue.map((p) => `
    <div class="bulk-photo-progress-row ${p.status}">
      <span>${p.photoLabel}: ${STATUS_LABEL2[p.status]}${p.status === 'failed' ? `(${p.error || ''})` : ''}</span>
      ${p.status === 'failed' ? `<button type="button" class="secondary bulk-photo-retry-btn" data-id="${p.id}">再試行</button>` : ''}
    </div>
  `).join('');
  el.querySelectorAll('.bulk-photo-retry-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = bulkPhotoQueue.find((p) => p.id === btn.dataset.id);
      if (entry) processBulkPhoto(entry);
    });
  });
  updateBulkReceiptsSummary();
}

function updateBulkReceiptsSummary() {
  const statusEl = document.getElementById('expense-bulk-receipts-status');
  const total = bulkPhotoQueue.length;
  const done = bulkPhotoQueue.filter((p) => p.status === 'done').length;
  const failed = bulkPhotoQueue.filter((p) => p.status === 'failed').length;
  const stillWorking = bulkPhotoQueue.some((p) => p.status === 'pending' || p.status === 'processing');
  if (stillWorking) {
    statusEl.textContent = `解析中... (${done + failed}/${total}枚)`;
    return;
  }
  const highCount = bulkItems.filter((it) => it.confidence === 'high').length;
  const needsReviewCount = bulkItems.length - highCount;
  let msg = `${total}枚の写真から領収書${bulkItems.length}件を検出(正常${highCount}件・要確認${needsReviewCount}件)。合計${bulkTotalAmount().toLocaleString('ja-JP')}円`;
  if (failed > 0) msg += `。${failed}枚の解析に失敗しました。「再試行」を押してください`;
  statusEl.textContent = msg;
}

function addBulkItemsFromPhoto(entry, uploadResult, receipts, fileHash) {
  if (receipts.length === 0) {
    // 白紙・判読不能等でAIが1件も検出しなかった場合でも、写真自体は明細として
    // 1件だけ手入力用に追加する(せっかく撮影した写真を無かったことにしない)。
    bulkItemSeq += 1;
    const item = {
      id: 'bulk-item-' + bulkItemSeq, date: null, store: null, amount: null, tax: null, confidence: 'low',
      driveFileId: uploadResult.driveFileId, driveFileUrl: uploadResult.driveFileUrl, fileHash,
      siteId: null, siteName: null, purposeCategory: null, note: null, photoLabel: `${entry.photoLabel}(自動検出なし・要手動入力)`,
      photoQueueId: entry.id,
    };
    bulkItems.push(item);
    renderBulkItemRow(item);
  } else {
    receipts.forEach((r, ri) => {
      bulkItemSeq += 1;
      const label = receipts.length > 1 ? `${entry.photoLabel}の${ri + 1}件目(全${receipts.length}件中)` : entry.photoLabel;
      const item = {
        id: 'bulk-item-' + bulkItemSeq, date: r.document_date || null, store: r.counterparty_raw || null,
        amount: r.total_amount != null ? Number(r.total_amount) : null, tax: r.tax_amount != null ? Number(r.tax_amount) : null,
        confidence: r.confidence || 'low',
        driveFileId: uploadResult.driveFileId, driveFileUrl: uploadResult.driveFileUrl, fileHash,
        siteId: null, siteName: null, purposeCategory: null, note: r.content_description || null, photoLabel: label,
        photoQueueId: entry.id,
      };
      bulkItems.push(item);
      renderBulkItemRow(item);
    });
  }
  updateBulkExpenseTotal();
}

async function processBulkPhoto(entry) {
  // 同じ写真を「編集して差し替えた」明細が残らないよう、再試行時は前回分の明細を消す。
  bulkItems = bulkItems.filter((it) => it.photoQueueId !== entry.id);
  document.querySelectorAll(`.expense-bulk-item-row[data-photo-queue-id="${entry.id}"]`).forEach((el) => el.remove());
  entry.status = 'processing';
  entry.error = null;
  renderBulkPhotoProgress();
  const session = getSession();
  try {
    const [uploadResult, receipts, fileHash] = await Promise.all([
      uploadReceiptPhoto(session.employeeCode, entry.file),
      runBulkOcrForPhoto(entry.file),
      computeFileHashHex(entry.file),
    ]);
    entry.status = 'done';
    addBulkItemsFromPhoto(entry, uploadResult, receipts, fileHash);
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message || 'アップロードに失敗しました';
  }
  renderBulkPhotoProgress();
}

async function handleBulkReceiptFiles(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;
  const startIndex = bulkPhotoQueue.length;
  const newEntries = list.map((file, i) => {
    bulkPhotoSeq += 1;
    return { id: 'bulk-photo-' + bulkPhotoSeq, file, photoLabel: `写真${startIndex + i + 1}枚目`, status: 'pending', error: null };
  });
  bulkPhotoQueue = bulkPhotoQueue.concat(newEntries);
  renderBulkPhotoProgress();
  // 端末・回線への負荷を抑えるため、写真は同時並列ではなく1枚ずつ順番に処理する
  // (30枚選んでも一気に30リクエストを投げない)。
  for (const entry of newEntries) {
    await processBulkPhoto(entry);
  }
}

// 経費精算書(紙の集計表)専用のAI読取。領収書用エンドポイント(receipt-ocr-proxy)とは
// 別のn8nワークフロー(expense-cover-ocr-proxy、scripts/n8n-build-expense-cover-ocr.js)を
// 呼び、申請者・申請日・明細・合計金額を構造化して受け取る。
async function runCoverSheetOcr(file) {
  file = await compressImageForUpload(file);
  const base64 = await fileToBase64(file);
  const session = getSession();
  const res = await fetch(`${N8N_BASE_URL}/webhook/expense-cover-ocr-proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeCode: session.employeeCode, mimeType: file.type || 'image/jpeg', base64 }),
  });
  const json = await res.json().catch(() => null);
  return json || { is_cover_sheet: false };
}

async function handleBulkCoverSheetFile(file) {
  const statusEl = document.getElementById('expense-bulk-cover-status');
  const session = getSession();
  statusEl.textContent = 'アップロード・読み取り中...';
  try {
    const [uploadResult, extracted] = await Promise.all([
      uploadReceiptPhoto(session.employeeCode, file),
      runCoverSheetOcr(file),
    ]);
    bulkCoverSheet = {
      driveFileId: uploadResult.driveFileId, driveFileUrl: uploadResult.driveFileUrl,
      declaredTotal: extracted.declared_total != null ? Number(extracted.declared_total) : null,
      applicantName: extracted.applicant_name || null,
      submissionDate: extracted.submission_date || null,
      lineItems: extracted.line_items || [],
      confidence: extracted.confidence || 'low',
    };
    document.getElementById('expense-bulk-cover-label').textContent = file.name || '経費精算書を撮影・選択する';
    if (!extracted.is_cover_sheet) {
      statusEl.textContent = '経費精算書として認識できませんでした(添付は保存されます。手動で照合してください)。';
    } else {
      const parts = [];
      if (bulkCoverSheet.applicantName) parts.push(`申請者: ${bulkCoverSheet.applicantName}`);
      if (bulkCoverSheet.submissionDate) parts.push(`申請日: ${bulkCoverSheet.submissionDate}`);
      if (bulkCoverSheet.declaredTotal != null) parts.push(`合計: ${bulkCoverSheet.declaredTotal.toLocaleString('ja-JP')}円`);
      statusEl.textContent = parts.length > 0
        ? `経費精算書を読み取りました(${parts.join('・')})。内容を確認してください。`
        : '経費精算書らしき書類ですが、内容をうまく読み取れませんでした。';
    }
    updateBulkReconciliationPreview();
  } catch (e) {
    statusEl.textContent = 'アップロードに失敗しました。もう一度お試しください。';
    bulkCoverSheet = null;
  }
}

function resetExpenseBulkForm() {
  bulkItems = [];
  bulkItemSeq = 0;
  bulkPhotoQueue = [];
  bulkPhotoSeq = 0;
  bulkCoverSheet = null;
  document.getElementById('expense-bulk-item-list').innerHTML = '';
  document.getElementById('expense-bulk-receipts-progress').innerHTML = '';
  document.getElementById('expense-bulk-receipts-status').textContent = '';
  document.getElementById('expense-bulk-cover-status').textContent = '';
  document.getElementById('expense-bulk-cover-label').textContent = '経費精算書を撮影・選択する';
  document.getElementById('expense-bulk-reconciliation-box').style.display = 'none';
  document.getElementById('expense-bulk-month').value = todayJST().slice(0, 7);
  document.getElementById('expense-bulk-batch-title').value = '';
  document.getElementById('expense-bulk-note').value = '';
  updateBulkExpenseTotal();
}

function enterExpenseBulkScreen(category) {
  bulkExpenseCategory = category;
  document.getElementById('expense-bulk-title').textContent = category === 'company_expense' ? 'まとめて精算(会社経費)' : 'まとめて精算(経費立替)';
  resetExpenseBulkForm();
  hideError('expense-bulk-error');
  populateSiteSelect(document.getElementById('expense-bulk-bulk-site'), '');
  populatePurposeSelect(document.getElementById('expense-bulk-bulk-purpose'), '');
  showScreen('expense-bulk');
}

function applyBulkSiteAndPurposeToAll() {
  const siteEl = document.getElementById('expense-bulk-bulk-site');
  const purposeEl = document.getElementById('expense-bulk-bulk-purpose');
  const siteId = siteEl.value && siteEl.value !== '__new__' ? siteEl.value : null;
  const siteName = siteEl.value ? (siteEl.selectedOptions[0] && siteEl.selectedOptions[0].dataset.name) || siteEl.selectedOptions[0].textContent : null;
  const purposeCategory = purposeEl.value || null;
  bulkItems.forEach((item) => {
    if (siteId) { item.siteId = siteId; item.siteName = siteName; }
    if (purposeCategory) item.purposeCategory = purposeCategory;
  });
  document.getElementById('expense-bulk-item-list').innerHTML = '';
  bulkItems.forEach(renderBulkItemRow);
}

async function doSubmitExpenseBulk() {
  const session = getSession();
  hideError('expense-bulk-error');
  const monthValue = document.getElementById('expense-bulk-month').value;
  if (!monthValue) { showError('expense-bulk-error', '精算対象月を選択してください。'); return; }
  if (bulkPhotoQueue.some((p) => p.status === 'processing' || p.status === 'pending')) {
    showError('expense-bulk-error', '写真の解析が完了するまでお待ちください。'); return;
  }
  if (bulkPhotoQueue.some((p) => p.status === 'failed')) {
    showError('expense-bulk-error', '解析に失敗した写真があります。「再試行」するか、不要な写真は明細ごと削除してください。'); return;
  }
  if (bulkItems.length === 0) { showError('expense-bulk-error', '領収書の写真を追加してください。'); return; }
  const missing = bulkItems.find((it) => !it.amount || it.amount <= 0 || !it.siteId || !it.purposeCategory);
  if (missing) { showError('expense-bulk-error', '金額・現場・使用目的が未入力の明細があります。各明細の「明細を編集」から入力してください。'); return; }

  const items = bulkItems.map((it) => ({
    document_date: it.date, store: it.store || '(店舗不明)', amount: it.amount, tax_amount: it.tax,
    site_id: it.siteId, site_name: it.siteName, new_site_name: null,
    business_partner_id: null, new_business_partner_name: null, vendor_name: it.store,
    purpose_category: it.purposeCategory, purpose: it.note,
    // 「どの元画像のどの領収書から読み取ったか」を明細の記録として恒久的に残す
    // (元画像自体はdocuments.related_file_id経由で辿れるが、1枚に複数領収書があった
    // 場合の「何件目か」はここに記録しないと後から追えなくなるため)。
    payment_method: null, content_description: [it.note, it.photoLabel ? `[${it.photoLabel}]` : null].filter(Boolean).join(' '),
    drive_file_id: it.driveFileId, drive_file_url: it.driveFileUrl,
    confidence: it.confidence, file_hash: it.fileHash,
  }));
  const coverSheet = bulkCoverSheet ? {
    drive_file_id: bulkCoverSheet.driveFileId, drive_file_url: bulkCoverSheet.driveFileUrl,
    declared_total: bulkCoverSheet.declaredTotal, applicant_name: bulkCoverSheet.applicantName,
  } : null;

  const btn = document.getElementById('expense-bulk-submit');
  btn.disabled = true;
  try {
    const result = await rpc('submit_bulk_expense_claim', {
      p_employee_code: session.employeeCode, p_expense_category: bulkExpenseCategory,
      p_target_month: `${monthValue}-01`, p_batch_title: document.getElementById('expense-bulk-batch-title').value.trim() || null,
      p_items: items, p_cover_sheet: coverSheet,
    });
    const r = result && result[0];
    let msg = `まとめて精算を受け付けました(${r ? r.item_count : items.length}件、合計${r ? Number(r.total_amount).toLocaleString('ja-JP') : ''}円)。承認をお待ちください。`;
    if (r && r.reconciliation_status === 'mismatch') msg += ' ※経費精算書の合計と明細合計が一致していません。管理者が確認します。';
    if (r && r.duplicate_warning_count > 0) msg += ' ※過去の申請と重複の可能性がある明細があります。管理者が確認します。';
    showDone(msg, 'menu-apply');
    resetExpenseBulkForm();
  } catch (e) {
    showError('expense-bulk-error', e.message || '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- まとめ精算管理(管理者) ----------

let bulkExpenseAdminFilter = '';

async function loadBulkExpenseAdminList() {
  const session = getSession();
  const listEl = document.getElementById('bea-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
  const STATUS_BADGE = {
    waiting_approval: '承認待ち', ready_for_review: '確認中', needs_review: '確認中',
    approved: '承認済み', waiting_payment: '支払待ち', paid: '支払済み', rejected: '却下',
  };
  try {
    const rows = await rpc('admin_get_bulk_expense_requests', { p_admin_employee_code: session.employeeCode, p_status_group: bulkExpenseAdminFilter || null });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当するまとめ精算申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="admin-result-item bea-row" data-id="${r.employee_request_id}">
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span class="status-badge">${STATUS_BADGE[r.status] || r.status}</span></div>
        <div class="row2">${r.target_month ? new Date(r.target_month).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' }) : ''} ${r.batch_title || ''}・領収書${r.item_count}件・合計${yen(r.total_amount)}</div>
        <div class="row2">承認${yen(r.approved_amount)}・却下${yen(r.rejected_amount)}・未処理${yen(r.pending_amount)}</div>
        ${r.reconciliation_status === 'mismatch' ? `<div class="mini-tag warn">${icon('alert-triangle')}経費精算書と金額不一致</div>` : ''}
        ${r.duplicate_warning_count > 0 ? `<div class="mini-tag warn">${icon('alert-triangle')}重複の疑いあり(${r.duplicate_warning_count}件)</div>` : ''}
      </div>
    `).join('');
    hydrateIcons(listEl);
    listEl.querySelectorAll('.bea-row').forEach((el) => {
      el.addEventListener('click', () => openBulkExpenseDetail(el.dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

let bulkExpenseDetailRequestId = null;
const bulkExpenseSelectedItems = new Set();

async function openBulkExpenseDetail(requestId) {
  const session = getSession();
  bulkExpenseDetailRequestId = requestId;
  bulkExpenseSelectedItems.clear();
  showScreen('bulk-expense-detail');
  document.getElementById('bed-item-list').innerHTML = '<div class="hint">読み込み中...</div>';
  hideError('bed-error');
  document.getElementById('bed-reason-box').style.display = 'none';
  await loadBulkExpenseDetail();
}

async function loadBulkExpenseDetail() {
  const session = getSession();
  const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
  try {
    const [items, list] = await Promise.all([
      rpc('admin_get_bulk_expense_request_items', { p_admin_employee_code: session.employeeCode, p_employee_request_id: Number(bulkExpenseDetailRequestId) }),
      rpc('admin_get_bulk_expense_requests', { p_admin_employee_code: session.employeeCode, p_status_group: null }),
    ]);
    const head = (list || []).find((r) => String(r.employee_request_id) === String(bulkExpenseDetailRequestId));
    if (head) {
      document.getElementById('bed-title').textContent = `${head.employee_name}さん ${head.target_month ? new Date(head.target_month).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' }) : ''} ${head.batch_title || ''}`;
      document.getElementById('bed-approved').textContent = yen(head.approved_amount);
      document.getElementById('bed-rejected').textContent = yen(head.rejected_amount);
      document.getElementById('bed-pending').textContent = yen(head.pending_amount);
      document.getElementById('bed-total').textContent = yen(head.total_amount);
      document.getElementById('bed-reconciliation').textContent = head.reconciliation_status === 'matched' ? '経費精算書との照合: OK'
        : head.reconciliation_status === 'mismatch' ? '経費精算書との照合: 金額不一致・要確認' : '';
    }

    const STATUS_LABEL_ITEM = { pending: '未処理', approved: '承認済み', rejected: '却下', on_hold: '保留(差戻し)' };
    document.getElementById('bed-item-list').innerHTML = (items || []).map((it) => `
      <div class="history-item bed-item-row" data-id="${it.expense_item_id}">
        <label class="checkbox-row">
          <input type="checkbox" class="bed-item-check" data-id="${it.expense_item_id}" ${it.approval_status !== 'pending' ? '' : ''}>
          <span>
            <div class="row1"><span>${it.document_date || ''}　${it.vendor_name}</span><span>${yen(it.amount)}</span></div>
            <div class="row2">${it.site_name || '-'}・${it.purpose_category || '-'}・<span class="status-badge ${it.approval_status === 'rejected' ? 'rejected' : (it.approval_status === 'approved' ? 'done' : '')}">${STATUS_LABEL_ITEM[it.approval_status] || it.approval_status}</span></div>
            ${it.approval_reason ? `<div class="row2">理由: ${it.approval_reason}</div>` : ''}
            ${it.duplicate_warning ? `<div class="mini-tag warn">${icon('alert-triangle')}重複の疑いあり</div>` : ''}
          </span>
        </label>
        ${it.document_id
          ? `<div class="receipt-thumb-wrap"><img class="receipt-proxy-thumb" data-document-id="${it.document_id}" alt="領収書" loading="lazy"></div>`
          : '<div class="hint-inline">領収書画像なし</div>'}
      </div>
    `).join('');
    hydrateIcons(document.getElementById('bed-item-list'));
    hydrateReceiptImages(document.getElementById('bed-item-list'));
    document.querySelectorAll('.bed-item-check').forEach((cb) => {
      cb.checked = bulkExpenseSelectedItems.has(cb.dataset.id);
      cb.addEventListener('change', () => {
        if (cb.checked) bulkExpenseSelectedItems.add(cb.dataset.id); else bulkExpenseSelectedItems.delete(cb.dataset.id);
        updateBulkExpenseSelectedCount();
      });
    });
    updateBulkExpenseSelectedCount();
  } catch (e) {
    document.getElementById('bed-item-list').innerHTML = `<div class="hint">読み込みに失敗しました: ${e.message}</div>`;
  }
}

function updateBulkExpenseSelectedCount() {
  document.getElementById('bed-selected-count').textContent = `${bulkExpenseSelectedItems.size}件選択中`;
}

let bulkExpensePendingDecision = null;

async function doDecideBulkExpenseSelected(decision) {
  hideError('bed-error');
  if (bulkExpenseSelectedItems.size === 0) { showError('bed-error', '明細を選択してください。'); return; }
  if (decision === 'approved') {
    await submitBulkExpenseDecision('approved', null);
    return;
  }
  bulkExpensePendingDecision = decision;
  document.getElementById('bed-reason-box').style.display = 'block';
  document.getElementById('bed-reason').value = '';
  document.getElementById('bed-reason').focus();
}

async function submitBulkExpenseDecision(decision, reason) {
  const session = getSession();
  hideError('bed-error');
  try {
    await rpc('admin_decide_expense_items', {
      p_admin_employee_code: session.employeeCode, p_item_ids: Array.from(bulkExpenseSelectedItems).map(Number),
      p_decision: decision, p_reason: reason,
    });
    bulkExpenseSelectedItems.clear();
    document.getElementById('bed-reason-box').style.display = 'none';
    await loadBulkExpenseDetail();
  } catch (e) {
    showError('bed-error', e.message || '処理に失敗しました。');
  }
}

// ---------- 会議申請 ----------

let meetingParticipantSelect = null;
function resetMeetingForm() {
  if (!meetingParticipantSelect) {
    meetingParticipantSelect = createEmployeeCardPicker(document.getElementById('meeting-participants'));
    meetingParticipantSelect.setOnChange(() => {
      document.getElementById('meeting-participant-count').textContent = meetingParticipantSelect.getCount();
    });
  } else {
    meetingParticipantSelect.setSelectedCodes([]);
  }
}

async function doSubmitMeeting() {
  const session = getSession();
  const date = document.getElementById('meeting-date').value;
  const place = document.getElementById('meeting-place').value.trim();
  const participantCodes = meetingParticipantSelect ? meetingParticipantSelect.getSelectedCodes() : [];
  const hasMeal = document.getElementById('meeting-meal').checked;
  const content = document.getElementById('meeting-content').value.trim();
  const amount = document.getElementById('meeting-amount').value;
  const receive = document.getElementById('meeting-receive').value;
  hideError('meeting-error');

  if (!date || !content) {
    showError('meeting-error', '会議日・会議内容は必須です。');
    return;
  }
  if (participantCodes.length === 0) {
    showError('meeting-error', '参加社員を1人以上選択してください。');
    return;
  }

  const btn = document.getElementById('meeting-submit');
  btn.disabled = true;
  try {
    await rpc('submit_meeting_request', {
      p_employee_code: session.employeeCode,
      p_meeting_date: date,
      p_place: place || null,
      p_headcount: null,
      p_has_meal: hasMeal,
      p_content: content,
      p_amount: amount ? Number(amount) : null,
      p_receive_method: receive,
      p_participant_employee_codes: participantCodes,
    });
    showDone('会議申請を受け付けました。承認をお待ちください。', 'menu-apply');
    ['meeting-date', 'meeting-place', 'meeting-content', 'meeting-amount'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('meeting-meal').checked = false;
    meetingParticipantSelect.setSelectedCodes([]);
  } catch (e) {
    showError('meeting-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 申請履歴 ----------

const REQUEST_TYPE_LABEL = {
  paid_leave: '有給休暇申請', expense_reimbursement: '経費立替申請', meeting: '会議申請', supply_item: '支給品申請',
  entertainment_preapproval: '接待事前申請', qualification: '資格・免許', other: 'その他',
};
const STATUS_LABEL = {
  ready_for_review: '確認中', waiting_employee_info: '差し戻し(要修正)', needs_review: '確認中', stopped: '処理停止',
  waiting_approval: '承認待ち', approved: '承認済み', rejected: '却下', on_hold: '保留',
  waiting_payment: '支払待ち', paid: '支払済み', cancelled: '取消',
  pending: '確認待ち', pending_verification: '確認待ち', active: '有効', expired: '期限切れ',
};
const STATUS_GROUP_LABEL = { pending: '承認待ち', needs_review: '差し戻し(要修正)', special_review: '特別承認待ち', approved: '承認済み', rejected: '却下' };

async function loadHistory() {
  const session = getSession();
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_requests', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '<div class="hint">まだ申請がありません。</div>';
      return;
    }
    listEl.innerHTML = '';
    const detailableTypes = ['expense_reimbursement', 'paid_leave', 'meeting', 'supply_item'];
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const dateStr = new Date(r.requested_at).toLocaleDateString('ja-JP');
      const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
      const statusClass = ['approved', 'paid'].includes(r.status) ? 'done' : (['rejected', 'cancelled'].includes(r.status) ? 'rejected' : '');
      // 却下された申請だけでなく、承認待ち/一部承認/承認済み/支払済み/受取確認済みなど
      // 全ステータスで詳細を開けるようにする(以前はrejectedのみタップ可能だった不具合の修正)。
      const clickable = detailableTypes.includes(r.request_type);
      const approverLine = r.approver_name
        ? `<div class="row2">承認者: ${r.approver_name}・${r.decided_at ? new Date(r.decided_at).toLocaleString('ja-JP') : ''}</div>`
        : (['approved', 'rejected'].includes(r.status) ? '<div class="row2">承認者記録なし(旧データ)</div>' : '');
      div.innerHTML = `
        <div class="row1"><span>${REQUEST_TYPE_LABEL[r.request_type] || r.request_type}</span><span>${amountStr}</span></div>
        <div class="row2">${dateStr}　${r.summary || ''}</div>
        ${approverLine}
        <span class="status-badge ${statusClass}">${STATUS_LABEL[r.status] || r.status}</span>
        ${clickable ? '<div class="hint-inline">タップして詳細を確認</div>' : ''}
      `;
      if (clickable) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => openMyRequestDetail(r.id, 'history'));
      }
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 申請の詳細(社員本人視点、通知タップ/お知らせ/申請履歴から遷移。全ステータス対応) ----------

// 詳細画面の「戻る」リンクを、遷移元(申請履歴/お知らせ/ホーム)に応じて出し分ける。
const MRD_RETURN_LABEL = { history: '申請履歴に戻る', announcements: 'お知らせに戻る', home: 'ホームに戻る' };

function openImageZoom(url) {
  if (!url) return;
  document.getElementById('image-zoom-img').src = url;
  document.getElementById('image-zoom-overlay').classList.add('open');
}

// 領収書原本(Google Drive 非公開)を Edge Function receipt-image 経由で認証付き取得し、
// Blob→objectURL でインライン表示する。Drive URL も Google 認証情報もフロントへ出さない。
// container 内の img.receipt-proxy-thumb[data-document-id] を対象に、サムネイル表示＋タップ拡大を配線する。
// Edge Function receipt-image を認証付きで呼び、画像 Blob の objectURL を返す(汎用)。
// query 例: 'document_id=12'(領収書) / 'kind=qualification_photo&id=34'(資格証・免許証・健診)。
async function fetchSecureImageObjectUrl(query) {
  const session = getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/receipt-image?${query}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-employee-code': (session && session.employeeCode) || '',
      'x-device-token': currentDeviceToken || '',
    },
  });
  if (!res.ok) throw new Error('secure_image_fetch_' + res.status);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
async function fetchReceiptObjectUrl(documentId) {
  return fetchSecureImageObjectUrl(`document_id=${encodeURIComponent(documentId)}`);
}

// 資格証/免許証/健診結果などの Drive 画像を、img.secure-proxy-thumb[data-secure-kind][data-secure-id]
// に対してプロキシ経由で読み込み、タップ拡大を配線する(領収書と同じ仕組みの汎用版)。
function hydrateSecureImages(container) {
  if (!container) return;
  container.querySelectorAll('img.secure-proxy-thumb[data-secure-kind][data-secure-id]').forEach((img) => {
    if (img.dataset.hydrated) return;
    img.dataset.hydrated = '1';
    const q = `kind=${encodeURIComponent(img.dataset.secureKind)}&id=${encodeURIComponent(img.dataset.secureId)}`;
    fetchSecureImageObjectUrl(q)
      .then((objUrl) => { img.src = objUrl; img.dataset.zoom = objUrl; img.addEventListener('click', () => openImageZoom(objUrl)); img.style.cursor = 'zoom-in'; })
      .catch(() => { const note = document.createElement('div'); note.className = 'hint-inline'; note.textContent = '画像を表示できませんでした'; img.replaceWith(note); });
  });
  // PDF はプロキシ経由でBlob取得し新規タブで開く(Drive URL/認証情報を出さない)。
  container.querySelectorAll('button.secure-proxy-pdf[data-secure-kind][data-secure-id]').forEach((btn) => {
    if (btn.dataset.wired) return; btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      btn.disabled = true; const old = btn.textContent; btn.textContent = '読み込み中...';
      try { const u = await fetchSecureImageObjectUrl(`kind=${encodeURIComponent(btn.dataset.secureKind)}&id=${encodeURIComponent(btn.dataset.secureId)}`); window.open(u, '_blank'); }
      catch (e) { alert('PDFを表示できませんでした。'); }
      finally { btn.disabled = false; btn.textContent = old; }
    });
  });
}
// 領収書ギャラリー: 月別に複数の領収書を左右スワイプ/前次/拡大で確認できる。画像は receipt-image
// プロキシ経由(二重保存なし)。各画像に申請情報(日付/店名/金額/勘定科目/用途/現場)を紐付けて表示。
let rgItems = []; let rgIdx = 0; const rgUrlCache = new Map();
async function renderReceiptGalleryItem() {
  const it = rgItems[rgIdx]; if (!it) return;
  const img = document.getElementById('rg-img');
  const info = document.getElementById('rg-info');
  const yen = (n) => (n != null ? `${Number(n).toLocaleString('ja-JP')}円` : '');
  info.innerHTML = `
    <div class="rg-info-head">${rgIdx + 1} / ${rgItems.length}</div>
    <div class="rg-info-main">${it.vendor_name || '(店名なし)'}　<strong>${yen(it.amount)}</strong></div>
    <div class="rg-info-sub">${[it.document_date, it.purpose_category, it.expense_category, it.site_name].filter(Boolean).join('・')}</div>`;
  img.style.opacity = '0.4';
  try {
    if (!rgUrlCache.has(it.document_id)) rgUrlCache.set(it.document_id, await fetchSecureImageObjectUrl(`kind=receipt&id=${encodeURIComponent(it.document_id)}`));
    img.src = rgUrlCache.get(it.document_id); img.style.opacity = '1';
  } catch (e) { img.removeAttribute('src'); img.style.opacity = '1'; info.innerHTML += '<div class="rg-info-sub">画像を表示できませんでした</div>'; }
}
function rgStep(delta) { if (!rgItems.length) return; rgIdx = (rgIdx + delta + rgItems.length) % rgItems.length; renderReceiptGalleryItem(); }
function openReceiptGallery(items, startIdx) {
  rgItems = (items || []).filter((x) => x.document_id); rgIdx = Math.max(0, Math.min(startIdx || 0, rgItems.length - 1));
  if (rgItems.length === 0) { alert('この月に領収書画像はありません。'); return; }
  document.getElementById('receipt-gallery-overlay').classList.add('open');
  renderReceiptGalleryItem();
}
function closeReceiptGallery() { document.getElementById('receipt-gallery-overlay').classList.remove('open'); }

// 資格証/健診などの Drive 画像・PDF を、画面内サムネイル＋タップ拡大／PDFは新規タブで開く形にする共通HTML。
function secureFileBlockHtml(photoKind, pdfKind, refId, hasPhoto, hasPdf) {
  let h = '';
  if (hasPhoto) h += `<img class="secure-proxy-thumb" data-secure-kind="${photoKind}" data-secure-id="${refId}" alt="画像" loading="lazy">`;
  if (hasPdf) h += `<button type="button" class="secondary secure-proxy-pdf" data-secure-kind="${pdfKind}" data-secure-id="${refId}" style="margin-left:6px; vertical-align:top;">PDFを開く</button>`;
  if (!hasPhoto && !hasPdf) return '';
  return `<div class="secure-file-block" style="margin-top:8px;">${h}</div>`;
}

function hydrateReceiptImages(container) {
  if (!container) return;
  container.querySelectorAll('img.receipt-proxy-thumb[data-document-id]').forEach((img) => {
    if (img.dataset.hydrated) return;
    img.dataset.hydrated = '1';
    const docId = img.dataset.documentId;
    fetchReceiptObjectUrl(docId)
      .then((objUrl) => {
        img.src = objUrl;
        img.dataset.zoom = objUrl;
        img.addEventListener('click', () => openImageZoom(objUrl));
        img.style.cursor = 'zoom-in';
      })
      .catch(() => {
        const note = document.createElement('div');
        note.className = 'hint-inline';
        note.textContent = '領収書画像を表示できませんでした';
        img.replaceWith(note);
      });
  });
}

let currentMyRequestDetail = null;

async function openMyRequestDetail(requestId, returnTo) {
  returnTo = MRD_RETURN_LABEL[returnTo] ? returnTo : 'history';
  currentMyRequestDetail = { requestId: Number(requestId), returnTo };
  showScreen('my-request-detail');
}

// showScreen('my-request-detail')のたびにSCREEN_ENTER_HOOKSから呼ばれる(戻る/進むを含む)。
async function loadMyRequestDetailContent() {
  if (!currentMyRequestDetail) return;
  const { requestId, returnTo } = currentMyRequestDetail;
  const session = getSession();
  const backLink = document.getElementById('mrd-back-link');
  backLink.dataset.nav = returnTo;
  backLink.textContent = MRD_RETURN_LABEL[returnTo];
  document.getElementById('mrd-title').textContent = '申請詳細';
  document.getElementById('mrd-reject-box').style.display = 'none';
  document.getElementById('mrd-payment-card').innerHTML = '';
  document.getElementById('mrd-items').innerHTML = '<div class="hint">読み込み中...</div>';
  const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
  try {
    const rows = await rpc('get_my_request_detail', { p_employee_code: session.employeeCode, p_request_id: Number(requestId) });
    if (!rows || rows.length === 0) { document.getElementById('mrd-items').innerHTML = '<div class="hint">申請が見つかりませんでした。</div>'; return; }
    const head = rows[0];
    document.getElementById('mrd-title').textContent = `${REQUEST_TYPE_LABEL[head.request_type] || head.request_type}の詳細`;
    if (head.rejection_reason) {
      document.getElementById('mrd-reject-box').style.display = '';
      document.getElementById('mrd-rejection-reason').textContent = head.rejection_reason;
      document.getElementById('mrd-decided-at').textContent = head.decided_at ? `却下日: ${new Date(head.decided_at).toLocaleDateString('ja-JP')}` : '';
    }

    const ITEM_APPROVAL_LABEL = { approved: '承認', rejected: '却下', pending: '承認待ち', on_hold: '承認待ち' };
    document.getElementById('mrd-items').innerHTML = rows.map((r) => `
      <div class="mrd-item-card">
        <div class="row1"><span>申請日</span><span>${new Date(r.requested_at).toLocaleDateString('ja-JP')}</span></div>
        ${r.site_name ? `<div class="row2">現場: ${r.site_name}</div>` : ''}
        ${r.purpose ? `<div class="row2">使用目的: ${r.purpose}</div>` : ''}
        ${r.partner_name ? `<div class="row2">取引先: ${r.partner_name}</div>` : ''}
        <div class="row2">
          ${r.amount != null ? `金額: ${yen(r.amount)}` : ''}
          ${r.item_approval_status ? `<span class="mrd-item-approval-badge ${r.item_approval_status}">${ITEM_APPROVAL_LABEL[r.item_approval_status] || r.item_approval_status}</span>` : ''}
        </div>
        ${r.target_date ? `<div class="row2">${r.target_date}</div>` : ''}
        ${r.note ? `<div class="row2">備考: ${r.note}</div>` : ''}
        ${r.item_approval_status === 'rejected' && r.item_rejection_reason ? `<div class="row2">却下理由: ${r.item_rejection_reason}</div>` : ''}
        ${r.receipt_url
          ? `<div class="row2"><img class="mrd-receipt-thumb" src="${r.receipt_url}" alt="領収書" data-zoom="${r.receipt_url}"></div>`
          : '<div class="hint-inline">この明細には領収書画像が添付されていません</div>'}
      </div>
    `).join('');
    if (head.cover_sheet_url) {
      document.getElementById('mrd-items').insertAdjacentHTML('afterbegin', `
        <div class="mrd-item-card">
          <div class="row1"><span>経費精算書</span></div>
          <img class="mrd-receipt-thumb" src="${head.cover_sheet_url}" alt="経費精算書" data-zoom="${head.cover_sheet_url}">
        </div>
      `);
    }
    document.getElementById('mrd-items').querySelectorAll('[data-zoom]').forEach((img) => {
      img.addEventListener('click', () => openImageZoom(img.dataset.zoom));
    });

    // item16: 承認前の有給申請は本人が取り消せる(承認済み/支払済み/却下/取消済みは不可)。
    const leaveCancelable = head.request_type === 'paid_leave'
      && ['draft', 'waiting_employee_info', 'ready_for_review', 'needs_review', 'stopped', 'waiting_approval', 'on_hold'].includes(head.status);
    if (leaveCancelable) {
      document.getElementById('mrd-items').insertAdjacentHTML('beforeend',
        '<button type="button" class="secondary" id="mrd-cancel-leave" style="margin-top:14px;color:var(--danger);border-color:var(--danger);">この有給申請を取り消す</button>');
      document.getElementById('mrd-cancel-leave').addEventListener('click', async () => {
        if (!window.confirm('この有給申請を取り消しますか？\n\n承認前のため取り消せます。取消後は承認待ちから外れます（有給残数には影響しません）。')) return;
        const reason = window.prompt('取消理由（任意）') || null;
        const session2 = getSession();
        try {
          await rpc('cancel_my_paid_leave_request', { p_employee_code: session2.employeeCode, p_employee_request_id: requestId, p_reason: reason });
          alert('有給申請を取り消しました。');
          showScreen(returnTo || 'history');
        } catch (e2) { alert(e2.message || '取消に失敗しました。'); }
      });
    }

    // 経費立替のみ支払状況(未払い/受取確認待ち/支払済み)を表示する。承認額そのものが
    // 無い(=承認済み明細がまだ無い)申請は支払カードを出さない。
    if (head.request_type === 'expense_reimbursement' && head.approved_total != null) {
      await renderMyPaymentCard(requestId, head);
    }
  } catch (e) {
    document.getElementById('mrd-items').innerHTML = `<div class="hint">読み込みに失敗しました: ${e.message}</div>`;
  }
}

async function renderMyPaymentCard(requestId, head) {
  const session = getSession();
  const yen = (n) => `${Number(n || 0).toLocaleString('ja-JP')}円`;
  const card = document.getElementById('mrd-payment-card');
  card.innerHTML = `
    <div class="mrd-payment-card">
      <div class="section-title" style="margin-top:0;">支払状況</div>
      <div class="mrd-payment-row"><span>承認額</span><span>${yen(head.approved_total)}</span></div>
      <div class="mrd-payment-row"><span>支払済み</span><span>${yen(head.paid_total)}</span></div>
      <div class="mrd-payment-row emphasis"><span>未払い</span><span>${yen(head.unpaid_total)}</span></div>
      ${Number(head.unconfirmed_total) > 0 ? `<div class="mrd-payment-row emphasis"><span>受取確認待ち</span><span>${yen(head.unconfirmed_total)}</span></div>` : ''}
      <div id="mrd-payment-schedule" class="mrd-payment-row"></div>
      <div id="mrd-payment-list"></div>
    </div>
  `;
  try {
    const schRows = await rpc('get_my_expense_payment_schedule', { p_employee_code: session.employeeCode, p_employee_request_id: Number(requestId) });
    const s = schRows && schRows[0];
    const schEl = document.getElementById('mrd-payment-schedule');
    if (s && schEl) {
      if (s.payment_status === 'paid') {
        schEl.innerHTML = `<span>精算状況</span><span class="status-badge done">精算完了${s.paid_at ? '（' + new Date(s.paid_at).toLocaleDateString('ja-JP') + '）' : ''}</span>`;
      } else if (s.scheduled_payment_date) {
        schEl.innerHTML = `<span>精算状況</span><span class="mini-tag info">${new Date(s.scheduled_payment_date).toLocaleDateString('ja-JP')} 精算予定</span>`;
      } else {
        schEl.innerHTML = '<span>精算状況</span><span class="mini-tag">承認済み（精算予定日は調整中）</span>';
      }
    }
  } catch (e) { /* 予定情報が無ければ表示しない */ }
  try {
    const payments = await rpc('get_my_expense_payments', { p_employee_code: session.employeeCode, p_employee_request_id: Number(requestId) });
    const listEl = document.getElementById('mrd-payment-list');
    if (!payments || payments.length === 0) { listEl.innerHTML = ''; return; }
    listEl.innerHTML = payments.map((p) => `
      <div class="history-item">
        <div class="row1"><span>${new Date(p.paid_at).toLocaleDateString('ja-JP')}支払</span><span>${yen(p.paid_amount)}</span></div>
        ${p.payment_method ? `<div class="row2">${p.payment_method}</div>` : ''}
        ${p.confirmed_at
          ? `<span class="status-badge done">受取確認済み(${new Date(p.confirmed_at).toLocaleDateString('ja-JP')})</span>`
          : `<button type="button" class="secondary mrd-receive-btn" data-payment-id="${p.payment_id}">受け取りました</button>`}
      </div>
    `).join('');
    listEl.querySelectorAll('.mrd-receive-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('confirm_expense_payment_receipt', { p_employee_code: session.employeeCode, p_payment_id: Number(btn.dataset.paymentId) });
          await openMyRequestDetail(requestId, document.getElementById('mrd-back-link').dataset.nav);
        } catch (e) {
          btn.disabled = false;
          alert(e.message || '受取確認に失敗しました。');
        }
      });
    });
  } catch (e) {
    // 支払記録が無い(未支払)場合はエラーにせず何も表示しない。
  }
}

// ---------- 支給品申請(社員): 選択式。一覧にタップで選び、「その他」だけ自由入力欄を出す ----------

const SUPPLY_ICON_BY_NAME = {
  '制服ジャケット': 'briefcase', '制服ズボン': 'briefcase', 'ヘルメット': 'shield', '安全帯': 'shield',
  'フルハーネス': 'shield', '安全靴': 'package', '手袋': 'package', '空調服': 'package', '空調服バッテリー': 'package',
};

// 数量選択(基本1〜5、「6以上」を選ぶと隣の数値入力を使う)。既存の<input type="number">と
// 同じidのまま<select>へ差し替えているため、値の読み取り・複数品目一括申請の仕組みは変更不要。
function resetQtySelect(baseId) {
  const sel = document.getElementById(baseId);
  const custom = document.getElementById(baseId + '-custom');
  sel.value = '1';
  custom.value = '';
  custom.style.display = 'none';
}
function readQtySelect(baseId) {
  const sel = document.getElementById(baseId);
  const custom = document.getElementById(baseId + '-custom');
  if (sel.value === '__custom__') return Number(custom.value) || 1;
  return Number(sel.value) || 1;
}
function wireQtySelectCustomToggle(baseId) {
  const sel = document.getElementById(baseId);
  const custom = document.getElementById(baseId + '-custom');
  sel.addEventListener('change', () => { custom.style.display = sel.value === '__custom__' ? 'block' : 'none'; });
}

let selectedSupplyMasterId = null;
let selectedSupplyMasterItem = null;

let supplyMasterCache = [];
async function loadSupplyMasterCache() {
  supplyMasterCache = await rpc('list_supply_master', {});
  return supplyMasterCache;
}

function populateSizeSelect(selectEl, sizeOptions) {
  const opts = (sizeOptions && sizeOptions.length > 0) ? sizeOptions : ['S', 'M', 'L', 'LL', '3L', '4L', '5L', 'XL', 'XXL', 'フリー'];
  selectEl.innerHTML = '<option value="">選択してください</option>' + opts.map((s) => `<option value="${s}">${s}</option>`).join('');
}

async function loadSupplySelectGrid() {
  const grid = document.getElementById('supply-select-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('supply-req-detail').style.display = 'none';
  selectedSupplyMasterId = null;
  selectedSupplyMasterItem = null;
  try {
    const rows = await loadSupplyMasterCache();
    const cards = rows.map((m) => ({ id: m.id, name: m.item_name, requiresSize: m.requires_size, sizeOptions: m.size_options, icon: SUPPLY_ICON_BY_NAME[m.item_name] || 'package' }));
    cards.push({ id: 'other', name: '上記以外', requiresSize: false, icon: 'plus' });
    grid.innerHTML = cards.map((c) => `
      <button type="button" class="supply-select-card" data-id="${c.id}" data-name="${c.name}" data-requires-size="${c.requiresSize}">
        ${icon(c.icon)}
        <span class="supply-select-card-label">${c.name}</span>
      </button>
    `).join('');
    grid.querySelectorAll('.supply-select-card').forEach((el) => {
      el.addEventListener('click', () => selectSupplyMasterCard(el, cards));
    });
  } catch (e) {
    grid.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function selectSupplyMasterCard(el, cards) {
  document.querySelectorAll('#supply-select-grid .supply-select-card').forEach((c) => c.classList.remove('selected'));
  el.classList.add('selected');
  const isOther = el.dataset.id === 'other';
  selectedSupplyMasterId = isOther ? null : Number(el.dataset.id);
  selectedSupplyMasterItem = el.dataset.name;
  const card = cards.find((c) => String(c.id) === el.dataset.id);

  document.getElementById('supply-req-detail').style.display = 'block';
  document.getElementById('supply-req-selected-title').textContent = isOther ? '上記以外の支給品' : el.dataset.name;
  document.getElementById('supply-req-other-wrap').style.display = isOther ? 'block' : 'none';
  resetQtySelect('supply-req-qty');
  document.getElementById('supply-req-reason').value = '';
  const requiresSize = el.dataset.requiresSize === 'true';
  document.getElementById('supply-req-size-wrap').style.display = requiresSize ? 'block' : 'none';
  if (requiresSize) populateSizeSelect(document.getElementById('supply-req-size'), card && card.sizeOptions);
  document.getElementById('supply-req-master-id').value = selectedSupplyMasterId || '';
}

let supplyReqCart = [];
function renderSupplyReqCart() {
  const el = document.getElementById('supply-req-cart');
  const submitBtn = document.getElementById('supply-req-submit');
  if (supplyReqCart.length === 0) {
    el.innerHTML = '<div class="hint">まだ品目が追加されていません。</div>';
    submitBtn.disabled = true;
    return;
  }
  el.innerHTML = supplyReqCart.map((it, i) => `
    <div class="supply-item">
      <div class="row1"><span>${it.item_name}${it.size ? '(' + it.size + ')' : ''}</span><span>${it.quantity}個</span></div>
      ${it.reason ? `<div class="row2">${it.reason}</div>` : ''}
      <button type="button" class="reject-btn" data-remove-idx="${i}">削除</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-remove-idx]').forEach((btn) => {
    btn.addEventListener('click', () => { supplyReqCart.splice(Number(btn.dataset.removeIdx), 1); renderSupplyReqCart(); });
  });
  submitBtn.disabled = false;
}

function resetSupplyRequestScreen() {
  supplyReqCart = [];
  renderSupplyReqCart();
  hideError('supply-req-submit-error');
  loadSupplySelectGrid();
}

function doAddSupplyReqItem() {
  const isOther = selectedSupplyMasterId == null;
  const otherName = document.getElementById('supply-req-other-name').value.trim();
  const qty = readQtySelect('supply-req-qty');
  const size = document.getElementById('supply-req-size-wrap').style.display !== 'none' ? document.getElementById('supply-req-size').value : '';
  const reason = document.getElementById('supply-req-reason').value.trim();
  hideError('supply-req-error');

  if (!selectedSupplyMasterItem) { showError('supply-req-error', '支給品を選択してください。'); return; }
  if (isOther && !otherName) { showError('supply-req-error', '上記以外の支給品名を入力してください。'); return; }

  supplyReqCart.push({
    master_item_id: selectedSupplyMasterId, item_name: isOther ? otherName : selectedSupplyMasterItem,
    quantity: qty, size: size || null, reason: reason || null,
  });
  renderSupplyReqCart();
  document.getElementById('supply-req-detail').style.display = 'none';
  document.querySelectorAll('#supply-select-grid .supply-select-card').forEach((c) => c.classList.remove('selected'));
}

async function doSubmitSupplyRequestBulk() {
  const session = getSession();
  hideError('supply-req-submit-error');
  if (supplyReqCart.length === 0) { showError('supply-req-submit-error', '品目を1件以上追加してください。'); return; }
  const btn = document.getElementById('supply-req-submit');
  btn.disabled = true;
  try {
    await rpc('submit_supply_request_bulk', { p_employee_code: session.employeeCode, p_items: supplyReqCart });
    showDone('支給品申請を受け付けました。承認をお待ちください。', 'menu-apply');
  } catch (e) {
    showError('supply-req-submit-error', e.message || '送信に失敗しました。もう一度お試しください。');
    btn.disabled = false;
  }
}

const SUPPLY_SOURCE_TYPE_LABEL = {
  initial_holding: '初期保有登録', issuance: '通常支給', exchange: '交換', return: '返却', loss: '紛失', additional: '追加支給',
};

function formatSupplyIssuedDate(r) {
  if (r.date_precision === 'approximate') return r.approximate_note || 'おおよその時期';
  if (r.date_precision === 'unknown') return '時期不明';
  if (!r.issued_date) return '-';
  if (r.date_precision === 'year_month') return new Date(r.issued_date).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' });
  return new Date(r.issued_date).toLocaleDateString('ja-JP');
}

async function loadMySupplyHoldings() {
  const session = getSession();
  const el = document.getElementById('my-supply-holdings');
  el.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_supply_holdings', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { el.innerHTML = '<div class="hint">現在保有している支給品はありません。</div>'; return; }
    el.innerHTML = rows.map((r) => `
      <div class="supply-item">
        <div class="row1"><span>${r.item_name}${r.size ? '　' + r.size : ''}</span><span>${r.current_quantity}個</span></div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// 支給品「申請状況」: 承認済み(支給予定日つき)/受渡完了/申請中/却下 を本人が確認できる。
// 承認済みでもまだ受渡されていない間は「保有数」には出さず、ここに「◯月◯日 支給予定」と出す。
const SUPPLY_REQ_STATE = {
  pending: { label: '申請中', cls: '' },
  approved: { label: '承認済み', cls: 'info' },
  issued: { label: '受渡完了', cls: 'done' },
  rejected: { label: '却下', cls: 'rejected' },
};
async function loadMySupplyRequests() {
  const session = getSession();
  const el = document.getElementById('my-supply-requests');
  if (!el) return;
  el.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_supply_requests', { p_employee_code: session.employeeCode });
    // 受渡完了(issued)は「支給履歴」に出るので、ここでは進行中(申請中/承認済み)＋却下のみ表示。
    const active = (rows || []).filter((r) => r.status !== 'issued');
    if (active.length === 0) { el.innerHTML = '<div class="hint">進行中の支給品申請はありません。</div>'; return; }
    el.innerHTML = active.map((r) => {
      const st = SUPPLY_REQ_STATE[r.status] || { label: r.status, cls: '' };
      const sched = (r.status === 'approved' && r.scheduled_issue_date)
        ? `<span class="elapsed">${new Date(r.scheduled_issue_date).toLocaleDateString('ja-JP')} 支給予定</span>`
        : (r.status === 'approved' ? '<span class="elapsed">支給予定日は調整中です</span>' : '');
      return `
      <div class="supply-item">
        <div class="row1"><span>${r.item_name}${r.size ? '(' + r.size + ')' : ''}</span><span>${r.quantity}個</span></div>
        <div class="row2"><span class="mini-tag ${st.cls}">${st.label}</span>${sched}</div>
        ${r.status === 'rejected' && r.reject_reason ? `<div class="row2">却下理由: ${r.reject_reason}</div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadMySupply() {
  const session = getSession();
  loadMySupplyHoldings();
  loadMySupplyRequests();
  const listEl = document.getElementById('my-supply-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_supply_history', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) {
      listEl.innerHTML = '<div class="hint">まだ支給履歴がありません。</div>';
      return;
    }
    listEl.innerHTML = rows.map((r) => `
      <div class="supply-item">
        <div class="row1"><span>${r.item_name}${r.size ? '(' + r.size + ')' : ''}</span><span>${r.quantity}個</span></div>
        <div class="row2"><span class="mini-tag ${r.source_type === 'initial_holding' ? 'info' : ''}">${SUPPLY_SOURCE_TYPE_LABEL[r.source_type] || r.source_type}</span>${formatSupplyIssuedDate(r)}</div>
        ${r.needs_return ? `<div class="elapsed">${r.returned_date ? `返却済(${new Date(r.returned_date).toLocaleDateString('ja-JP')})` : '返却必要'}</div>` : ''}
        ${r.source_type === 'initial_holding' && r.registered_by_self ? `<button type="button" class="secondary" data-edit-ih-id="${r.id}" data-edit-ih='${JSON.stringify(r).replace(/'/g, "&#39;")}'>この登録を修正する</button>` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('[data-edit-ih-id]').forEach((btn) => {
      btn.addEventListener('click', () => openEditInitialHolding(JSON.parse(btn.dataset.editIh.replace(/&#39;/g, "'"))));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 現在保有している支給品の初期登録 ----------

let selectedSupplyIhMasterId = null;
let selectedSupplyIhMasterItem = null;
let supplyIhCart = [];

async function loadSupplyIhSelectGrid() {
  const grid = document.getElementById('supply-ih-select-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('supply-ih-detail').style.display = 'none';
  selectedSupplyIhMasterId = null;
  selectedSupplyIhMasterItem = null;
  try {
    const rows = await loadSupplyMasterCache();
    const cards = rows.map((m) => ({ id: m.id, name: m.item_name, requiresSize: m.requires_size, sizeOptions: m.size_options, icon: SUPPLY_ICON_BY_NAME[m.item_name] || 'package' }));
    cards.push({ id: 'other', name: '上記以外', requiresSize: false, icon: 'plus' });
    grid.innerHTML = cards.map((c) => `
      <button type="button" class="supply-select-card" data-id="${c.id}" data-name="${c.name}" data-requires-size="${c.requiresSize}">
        ${icon(c.icon)}
        <span class="supply-select-card-label">${c.name}</span>
      </button>
    `).join('');
    grid.querySelectorAll('.supply-select-card').forEach((el) => {
      el.addEventListener('click', () => selectSupplyIhMasterCard(el, cards));
    });
  } catch (e) {
    grid.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function toggleSupplyIhPrecisionFields() {
  const precision = document.getElementById('supply-ih-precision').value;
  document.getElementById('supply-ih-date-wrap').style.display = (precision === 'exact' || precision === 'year_month') ? 'block' : 'none';
  document.getElementById('supply-ih-date').type = precision === 'year_month' ? 'month' : 'date';
  document.getElementById('supply-ih-approx-wrap').style.display = (precision === 'approximate') ? 'block' : 'none';
}

function selectSupplyIhMasterCard(el, cards) {
  document.querySelectorAll('#supply-ih-select-grid .supply-select-card').forEach((c) => c.classList.remove('selected'));
  el.classList.add('selected');
  const isOther = el.dataset.id === 'other';
  selectedSupplyIhMasterId = isOther ? null : Number(el.dataset.id);
  selectedSupplyIhMasterItem = el.dataset.name;
  const card = cards.find((c) => String(c.id) === el.dataset.id);

  document.getElementById('supply-ih-detail').style.display = 'block';
  document.getElementById('supply-ih-selected-title').textContent = isOther ? '上記以外の支給品' : el.dataset.name;
  document.getElementById('supply-ih-other-wrap').style.display = isOther ? 'block' : 'none';
  resetQtySelect('supply-ih-qty');
  document.getElementById('supply-ih-note').value = '';
  document.getElementById('supply-ih-precision').value = 'unknown';
  toggleSupplyIhPrecisionFields();
  const requiresSize = el.dataset.requiresSize === 'true';
  document.getElementById('supply-ih-size-wrap').style.display = requiresSize ? 'block' : 'none';
  if (requiresSize) populateSizeSelect(document.getElementById('supply-ih-size'), card && card.sizeOptions);
  document.getElementById('supply-ih-master-id').value = selectedSupplyIhMasterId || '';
}

function renderSupplyIhCart() {
  const el = document.getElementById('supply-ih-cart');
  const submitBtn = document.getElementById('supply-ih-submit');
  if (supplyIhCart.length === 0) {
    el.innerHTML = '<div class="hint">まだ品目が追加されていません。</div>';
    submitBtn.disabled = true;
    return;
  }
  el.innerHTML = supplyIhCart.map((it, i) => `
    <div class="supply-item">
      <div class="row1"><span>${it.item_name}${it.size ? '(' + it.size + ')' : ''}</span><span>${it.quantity}個</span></div>
      <div class="row2">${formatSupplyIssuedDate({ date_precision: it.date_precision, issued_date: it.issued_date, approximate_note: it.approximate_note })}</div>
      <button type="button" class="reject-btn" data-remove-idx="${i}">削除</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-remove-idx]').forEach((btn) => {
    btn.addEventListener('click', () => { supplyIhCart.splice(Number(btn.dataset.removeIdx), 1); renderSupplyIhCart(); });
  });
  submitBtn.disabled = false;
}

function resetSupplyInitialHoldingScreen() {
  supplyIhCart = [];
  renderSupplyIhCart();
  hideError('supply-ih-submit-error');
  loadSupplyIhSelectGrid();
}

function doAddSupplyIhItem() {
  const isOther = selectedSupplyIhMasterId == null;
  const otherName = document.getElementById('supply-ih-other-name').value.trim();
  const qty = readQtySelect('supply-ih-qty');
  const size = document.getElementById('supply-ih-size-wrap').style.display !== 'none' ? document.getElementById('supply-ih-size').value : '';
  const precision = document.getElementById('supply-ih-precision').value;
  const dateVal = document.getElementById('supply-ih-date').value;
  const approxNote = document.getElementById('supply-ih-approx-note').value.trim();
  const note = document.getElementById('supply-ih-note').value.trim();
  hideError('supply-ih-error');

  if (!selectedSupplyIhMasterItem) { showError('supply-ih-error', '支給品を選択してください。'); return; }
  if (isOther && !otherName) { showError('supply-ih-error', '上記以外の支給品名を入力してください。'); return; }
  if ((precision === 'exact' || precision === 'year_month') && !dateVal) { showError('supply-ih-error', '支給日を入力してください。'); return; }
  if (precision === 'approximate' && !approxNote) { showError('supply-ih-error', 'おおよその時期を入力してください。'); return; }

  supplyIhCart.push({
    item_name: isOther ? otherName : selectedSupplyIhMasterItem, quantity: qty, size: size || null,
    date_precision: precision, issued_date: precision === 'year_month' ? (dateVal + '-01') : (dateVal || null),
    approximate_note: precision === 'approximate' ? approxNote : null, note: note || null,
  });
  renderSupplyIhCart();
  document.getElementById('supply-ih-detail').style.display = 'none';
  document.querySelectorAll('#supply-ih-select-grid .supply-select-card').forEach((c) => c.classList.remove('selected'));
}

async function doSubmitSupplyInitialHoldingBulk() {
  const session = getSession();
  hideError('supply-ih-submit-error');
  if (supplyIhCart.length === 0) { showError('supply-ih-submit-error', '品目を1件以上追加してください。'); return; }
  const btn = document.getElementById('supply-ih-submit');
  btn.disabled = true;
  try {
    await rpc('submit_initial_holding', { p_employee_code: session.employeeCode, p_items: supplyIhCart });
    showDone('現在保有している支給品を登録しました。', 'my-supply');
  } catch (e) {
    showError('supply-ih-submit-error', e.message || '登録に失敗しました。もう一度お試しください。');
    btn.disabled = false;
  }
}

function openEditInitialHolding(row) {
  const session = getSession();
  const newQty = window.prompt('数量を入力してください', row.quantity);
  if (newQty === null) return;
  const newNote = window.prompt('備考(任意)', row.reason || '');
  if (newNote === null) return;
  rpc('update_my_initial_holding', {
    p_employee_code: session.employeeCode, p_issuance_id: row.id, p_item_name: row.item_name, p_size: row.size,
    p_quantity: Number(newQty) || row.quantity, p_date_precision: row.date_precision, p_issued_date: row.issued_date,
    p_approximate_note: row.approximate_note, p_note: newNote,
  }).then(() => loadMySupply()).catch((e) => window.alert(e.message || '修正に失敗しました。'));
}

// ---------- 管理者画面 ----------

function isAdmin() {
  const session = getSession();
  return session && session.requestRole === 'executive';
}

// nippo_adminは既存のrequest_role(session)には現れないため、都度サーバーへ確認する。
// 同一タブ内での連打を避けるため軽くキャッシュする(ログイン中の権限変更は稀なため許容)。
let _nippoAdminCache = null;
async function isNippoAdmin() {
  if (isAdmin()) return true;
  if (_nippoAdminCache !== null) return _nippoAdminCache;
  const session = getSession();
  try {
    _nippoAdminCache = await rpc('check_nippo_admin', { p_employee_code: session.employeeCode });
  } catch (e) { _nippoAdminCache = false; }
  return _nippoAdminCache;
}

async function loadAdminEmployeeSelects() {
  const session = getSession();
  const rows = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
  const options = rows.map((e) => `<option value="${e.employee_code}" data-id="${e.id != null ? e.id : ''}">${e.employee_code} ${e.employee_name}</option>`).join('');
  document.getElementById('admin-employee-select').innerHTML = options;
  document.getElementById('admin-issue-employee').innerHTML = options;
  await loadAdminIssueMasterSelect();
  // item4: PINリセット通知等から来た場合、対象社員を自動選択して詳細(PINリセット導線)を出す。
  if (pendingAdminPreselectEmployeeId != null) {
    const sel = document.getElementById('admin-employee-select');
    const opt = Array.from(sel.options).find((o) => String(o.dataset.id) === String(pendingAdminPreselectEmployeeId));
    if (opt) { sel.value = opt.value; loadAdminEmployeeDetail(); }
    pendingAdminPreselectEmployeeId = null;
  }
}

async function loadAdminIssueMasterSelect() {
  const session = getSession();
  const select = document.getElementById('admin-issue-master');
  try {
    const rows = await rpc('admin_list_supply_master', { p_admin_employee_code: session.employeeCode });
    const active = rows.filter((m) => m.active);
    select.innerHTML = active.map((m) => `<option value="${m.id}" data-requires-size="${m.requires_size}">${m.item_name}</option>`).join('') + '<option value="">上記以外(自由入力)</option>';
    toggleAdminIssueOtherWrap();
  } catch (e) { /* 読み込めなくても記録フォーム自体は使える(その他扱いになる) */ }
}

function toggleAdminIssueOtherWrap() {
  const select = document.getElementById('admin-issue-master');
  const isOther = !select.value;
  document.getElementById('admin-issue-other-wrap').style.display = isOther ? 'block' : 'none';
}

async function loadAdminEmployeeDetail() {
  const session = getSession();
  const targetCode = document.getElementById('admin-employee-select').value;
  const detailEl = document.getElementById('admin-employee-detail');
  if (!targetCode) return;
  detailEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_employee_admin_summary', { p_admin_employee_code: session.employeeCode, p_target_employee_code: targetCode });
    const s = rows && rows[0];
    if (!s) { detailEl.innerHTML = ''; return; }
    const supplyLines = (s.supply_history || []).slice(0, 10).map((h) => `<div class="row2">${h.issued_date} ${h.item_name} ${h.quantity}個</div>`).join('');
    detailEl.innerHTML = `
      <div class="summary-row"><span>有給残日数</span><span class="summary-value">${s.leave_balance != null ? s.leave_balance + '日' : '未登録'}</span></div>
      <div class="summary-row"><span>今年使用</span><span class="summary-value">${s.leave_used_this_year}日(${s.leave_taken_count_this_year}回)</span></div>
      <div class="section-title" style="margin:14px 0 6px;">支給品履歴</div>
      ${supplyLines || '<div class="hint">支給履歴なし</div>'}
    `;
  } catch (e) {
    detailEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doAdminResetPin() {
  const session = getSession();
  const targetCode = document.getElementById('admin-employee-select').value;
  const statusEl = document.getElementById('admin-reset-pin-status');
  if (!targetCode) return;
  if (!confirm(`社員番号${targetCode}の暗証番号をリセットします。現在の暗証番号は使えなくなり、新しい初回登録コードを本人へ伝える必要があります。よろしいですか？`)) return;
  statusEl.textContent = '';
  try {
    // admin_reset_employee_pinは既存のPINを無効化したうえで、register_employee_pinで
    // 本人が次回ログイン時に新PINを設定するための初回登録コードを発行する
    // (admin_issue_first_login_codeと同じ形式で返る、表示方法もそちらに合わせた)。
    const r = await rpc('admin_reset_employee_pin', { p_admin_employee_code: session.employeeCode, p_target_employee_code: targetCode });
    const info = r[0];
    statusEl.style.color = 'var(--success)';
    statusEl.innerHTML = `リセットしました。初回登録コード: <b style="font-size:16px; letter-spacing:1px;">${info.out_code}</b>(このコードはこの画面を離れると二度と表示できません。今すぐ本人へお伝えください。有効期限: ${new Date(info.out_expires_at).toLocaleDateString('ja-JP')})`;
  } catch (e) {
    statusEl.textContent = 'リセットに失敗しました: ' + e.message;
    statusEl.style.color = 'var(--danger)';
  }
}

async function doAdminRecordIssuance() {
  const session = getSession();
  const targetCode = document.getElementById('admin-issue-employee').value;
  const date = document.getElementById('admin-issue-date').value;
  const masterSelect = document.getElementById('admin-issue-master');
  const masterId = masterSelect.value ? Number(masterSelect.value) : null;
  const otherItem = document.getElementById('admin-issue-item').value.trim();
  const qty = document.getElementById('admin-issue-qty').value;
  const size = document.getElementById('admin-issue-size').value.trim();
  const condition = document.getElementById('admin-issue-condition').value;
  const reason = document.getElementById('admin-issue-reason').value.trim();
  const needsReturn = document.getElementById('admin-issue-return').checked;
  const note = document.getElementById('admin-issue-note').value.trim();
  hideError('admin-issue-error');

  if (!targetCode || !date || (!masterId && !otherItem)) {
    showError('admin-issue-error', '対象社員・支給日・支給品は必須です。');
    return;
  }

  const btn = document.getElementById('admin-issue-submit');
  btn.disabled = true;
  try {
    await rpc('record_supply_issuance', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: targetCode, p_issued_date: date,
      p_item_name: masterId ? null : otherItem, p_quantity: qty ? Number(qty) : 1, p_size: size || null, p_condition: condition,
      p_reason: reason || null, p_needs_return: needsReturn, p_note: note || null, p_master_item_id: masterId,
      p_source_type: document.getElementById('admin-issue-source-type').value,
    });
    ['admin-issue-date', 'admin-issue-item', 'admin-issue-size', 'admin-issue-reason', 'admin-issue-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('admin-issue-qty').value = '1';
    document.getElementById('admin-issue-return').checked = false;
    if (document.getElementById('admin-employee-select').value === targetCode) loadAdminEmployeeDetail();
    showError('admin-issue-error', '記録しました。');
    document.getElementById('admin-issue-error').style.color = 'var(--success)';
  } catch (e) {
    document.getElementById('admin-issue-error').style.color = '';
    showError('admin-issue-error', '記録に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doAdminSearch() {
  const session = getSession();
  const itemName = document.getElementById('admin-search-item').value.trim();
  const unreturnedOnly = document.getElementById('admin-search-unreturned').checked;
  const resultsEl = document.getElementById('admin-search-results');
  resultsEl.innerHTML = '<div class="hint">検索中...</div>';
  try {
    const rows = await rpc('get_supply_admin_list', {
      p_admin_employee_code: session.employeeCode, p_item_name: itemName || null, p_unreturned_only: unreturnedOnly,
    });
    if (!rows || rows.length === 0) { resultsEl.innerHTML = '<div class="hint">該当なし</div>'; return; }
    resultsEl.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'admin-result-item';
      div.innerHTML = `
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span>${r.item_name} ${r.quantity}個</span></div>
        <div class="row2">支給日: ${r.issued_date}・経過${formatElapsed(r.elapsed_days)}${r.needs_return ? (r.returned_date ? `・返却済(${r.returned_date})` : '・未返却') : ''}</div>
        ${r.needs_return && !r.returned_date ? `<button type="button" class="return-btn" data-issuance-id="${r.id}">返却済みにする</button>` : ''}
      `;
      resultsEl.appendChild(div);
    });
    resultsEl.querySelectorAll('.return-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await rpc('mark_supply_returned', { p_admin_employee_code: session.employeeCode, p_issuance_id: Number(btn.dataset.issuanceId), p_returned_date: new Date().toISOString().slice(0, 10) });
        doAdminSearch();
      });
    });
  } catch (e) {
    resultsEl.innerHTML = '<div class="hint">検索に失敗しました。</div>';
  }
}

// ---------- 匿名相談ボックス ----------
// 通常の申請(社員番号と紐付く)とは完全に別のデータ・別のローカルストレージキーで扱う。
// ここにemployeeCode等を混ぜない(混ぜた瞬間に匿名性が崩れるため)。

const ANON_STORAGE_KEY = 'jinshou_anon_consultations'; // [{code, token, category, createdAt}]
let currentAnonCode = null;
let currentAnonToken = null;
let currentAnonAdminCode = null;
let currentAdminRequestFilter = null;

function getAnonConsultations() {
  try { return JSON.parse(localStorage.getItem(ANON_STORAGE_KEY)) || []; } catch { return []; }
}
function saveAnonConsultation(entry) {
  const list = getAnonConsultations();
  list.unshift(entry);
  localStorage.setItem(ANON_STORAGE_KEY, JSON.stringify(list));
}

const URGENCY_LABEL = { normal: '通常', soon: '早めに対応希望', urgent: '緊急' };
const ANON_STATUS_LABEL = { unconfirmed: '未確認', confirmed: '確認済み', in_progress: '対応中', resolved: '対応完了' };

async function doSubmitAnonConsultation() {
  const category = document.getElementById('anon-category').value;
  const content = document.getElementById('anon-content').value.trim();
  const urgency = document.querySelector('input[name="anon-urgency"]:checked').value;
  hideError('anon-submit-error');

  if (!content) {
    showError('anon-submit-error', '相談内容を入力してください。');
    return;
  }

  const btn = document.getElementById('anon-submit-btn');
  btn.disabled = true;
  try {
    const rows = await rpc('submit_anonymous_consultation', { p_category: category, p_content: content, p_urgency: urgency });
    const r = rows[0];
    saveAnonConsultation({ code: r.consultation_code, token: r.anon_token, category, createdAt: new Date().toISOString() });
    document.getElementById('anon-content').value = '';
    document.getElementById('anon-done-code').textContent = r.consultation_code;
    showScreen('anon-done');
  } catch (e) {
    showError('anon-submit-error', '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

async function loadMyAnonConsultations() {
  const listEl = document.getElementById('anon-my-list');
  const list = getAnonConsultations();
  if (list.length === 0) { listEl.innerHTML = '<div class="hint">まだ相談を送っていません。</div>'; return; }
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';

  const rendered = [];
  for (const entry of list) {
    try {
      const rows = await rpc('get_anonymous_consultation_thread', { p_consultation_code: entry.code, p_anon_token: entry.token });
      const status = rows[0] ? rows[0].status : 'unconfirmed';
      const last = rows[rows.length - 1];
      rendered.push(`
        <div class="consult-list-item" data-code="${entry.code}">
          <div class="row1"><span>${entry.category}</span><span class="status-badge ${status === 'resolved' ? 'done' : ''}">${ANON_STATUS_LABEL[status]}</span></div>
          <div class="row2">相談番号: ${entry.code}${last ? ' ・最新: ' + (last.sender === 'admin' ? '会社からの返信あり' : '自分の送信') : ''}</div>
        </div>
      `);
    } catch (e) {
      rendered.push(`<div class="consult-list-item"><div class="row1">相談番号: ${entry.code}</div><div class="row2">読み込みに失敗しました</div></div>`);
    }
  }
  listEl.innerHTML = rendered.join('');
  listEl.querySelectorAll('.consult-list-item').forEach((el) => {
    el.addEventListener('click', () => openAnonThread(el.dataset.code));
  });
}

async function openAnonThread(code) {
  const entry = getAnonConsultations().find((c) => c.code === code);
  if (!entry) return;
  currentAnonCode = entry.code;
  currentAnonToken = entry.token;
  document.getElementById('anon-thread-code').textContent = code;
  showScreen('anon-thread');
  await renderAnonThread();
}

async function renderAnonThread() {
  const messagesEl = document.getElementById('anon-thread-messages');
  messagesEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_anonymous_consultation_thread', { p_consultation_code: currentAnonCode, p_anon_token: currentAnonToken });
    messagesEl.innerHTML = rows.map((m) => `
      <div class="chat-bubble from-${m.sender}">
        ${m.message}
        <div class="meta">${m.sender === 'admin' ? '会社' : '自分'} ・ ${new Date(m.sent_at).toLocaleString('ja-JP')}</div>
      </div>
    `).join('') || '<div class="hint">メッセージがありません。</div>';
  } catch (e) {
    messagesEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSendAnonThreadMessage() {
  const message = document.getElementById('anon-thread-reply').value.trim();
  hideError('anon-thread-error');
  if (!message) return;
  const btn = document.getElementById('anon-thread-send');
  btn.disabled = true;
  try {
    await rpc('send_anonymous_employee_message', { p_consultation_code: currentAnonCode, p_anon_token: currentAnonToken, p_message: message });
    document.getElementById('anon-thread-reply').value = '';
    await renderAnonThread();
  } catch (e) {
    showError('anon-thread-error', '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function checkAnonUnreadBadge() {
  const list = getAnonConsultations();
  const badge = document.getElementById('home-anon-badge');
  for (const entry of list) {
    try {
      const unread = await rpc('has_unread_anonymous_reply', { p_consultation_code: entry.code, p_anon_token: entry.token });
      if (unread) { badge.style.display = 'block'; return; }
    } catch (e) { /* 個別の失敗は無視して他をチェックし続ける */ }
  }
  badge.style.display = 'none';
}

// ---------- 匿名相談管理(管理者) ----------

async function loadAnonAdminList() {
  const session = getSession();
  const status = document.getElementById('anon-admin-status-filter').value || null;
  const listEl = document.getElementById('anon-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('list_anonymous_consultations_admin', { p_admin_employee_code: session.employeeCode, p_status: status });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する相談はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="consult-list-item" data-code="${r.consultation_code}">
        <div class="row1">
          <span><span class="urgency-tag ${r.urgency}">${r.urgency === 'urgent' ? '🔴 緊急' : URGENCY_LABEL[r.urgency]}</span> ${r.category}${r.has_unread_employee_message ? ' 🔵' : ''}</span>
        </div>
        <div class="row2">${r.content.length > 60 ? r.content.slice(0, 60) + '…' : r.content}</div>
        <div class="row2">#${r.consultation_code} ・ ${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        <span class="status-badge ${r.status === 'resolved' ? 'done' : ''}">${ANON_STATUS_LABEL[r.status]}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.consult-list-item').forEach((el) => {
      el.addEventListener('click', () => openAnonAdminThread(el.dataset.code));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openAnonAdminThread(code) {
  currentAnonAdminCode = code;
  document.getElementById('anon-admin-thread-code').textContent = code;
  showScreen('anon-admin-thread');
  await renderAnonAdminThread();
}

async function renderAnonAdminThread() {
  const session = getSession();
  const messagesEl = document.getElementById('anon-admin-thread-messages');
  messagesEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_anonymous_consultation_admin_thread', { p_admin_employee_code: session.employeeCode, p_consultation_code: currentAnonAdminCode });
    if (rows[0]) document.getElementById('anon-admin-status-select').value = rows[0].status;
    messagesEl.innerHTML = rows.map((m) => `
      <div class="chat-bubble from-${m.sender === 'admin' ? 'employee' : 'admin'}">
        ${m.message}
        <div class="meta">${m.sender === 'admin' ? '会社(自分)' : '社員'} ・ ${new Date(m.sent_at).toLocaleString('ja-JP')}</div>
      </div>
    `).join('') || '<div class="hint">メッセージがありません。</div>';
  } catch (e) {
    messagesEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doAdminReplyAnon() {
  const session = getSession();
  const message = document.getElementById('anon-admin-reply').value.trim();
  hideError('anon-admin-thread-error');
  if (!message) return;
  const btn = document.getElementById('anon-admin-reply-btn');
  btn.disabled = true;
  try {
    await rpc('admin_reply_anonymous_consultation', { p_admin_employee_code: session.employeeCode, p_consultation_code: currentAnonAdminCode, p_message: message });
    document.getElementById('anon-admin-reply').value = '';
    await renderAnonAdminThread();
  } catch (e) {
    showError('anon-admin-thread-error', '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doAdminChangeAnonStatus() {
  const session = getSession();
  const status = document.getElementById('anon-admin-status-select').value;
  try {
    await rpc('admin_update_anonymous_consultation_status', { p_admin_employee_code: session.employeeCode, p_consultation_code: currentAnonAdminCode, p_status: status });
  } catch (e) { /* 失敗時は選択が反映されないだけなので致命的ではない */ }
}

// ---------- 今日やること・お知らせ(社員側) ----------

// 外注日報タスクをタップしたときは、日報入力画面を開いてから「誰の日報を入力しますか」を
// 外注作業員モードへ自動で切り替える(担当者が毎回手動でプルダウンを操作しなくて済むように)。
async function navigateToTodayTask(nav, taskKey) {
  if (!nav) return; // お休み・有給などの通知行はタップ先なし
  showScreen(nav);
  if (taskKey === 'subcontractor_daily_report' && nav === 'daily-report') {
    await resetDailyReportForm();
    const typeSelect = document.getElementById('daily-report-target-type');
    typeSelect.value = 'subcontractor';
    typeSelect.dispatchEvent(new Event('change'));
  }
}

// 「今日やること」はDBの実状態(未提出の日報・担当している外注日報・差戻し・承認待ち・
// 資格/健診期限等)から動的に生成する。get_my_today_tasksが対象社員ごとに該当する
// タスクだけを個別行として返すため、ここでは受け取った行をそのまま表示するだけでよい
// (固定文言の組み立てはサーバー側に一本化)。
async function loadTodayList() {
  const session = getSession();
  const listEl = document.getElementById('today-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const tasks = await rpc('get_my_today_tasks', { p_employee_code: session.employeeCode });
    const items = (tasks || []).map((t) => ({
      icon: t.icon, label: t.label,
      count: t.detail || (t.item_count != null ? `${t.item_count}件` : ''),
      nav: t.nav_screen, urgent: t.urgent, taskKey: t.task_key,
    }));
    const anonBadgeEl = document.getElementById('home-anon-badge');
    const anonUnread = anonBadgeEl && anonBadgeEl.style.display !== 'none';
    if (anonUnread) {
      items.push({ icon: 'message-circle', label: '匿名相談に会社から返信があります', count: '', nav: 'anon-consult' });
    }
    if (items.length === 0) {
      listEl.innerHTML = '<div class="today-empty">今日確認が必要なことはありません。</div>';
      return;
    }
    listEl.innerHTML = items.map((it, i) => `
      <button type="button" class="today-item ${it.urgent ? 'urgent' : ''}" data-idx="${i}">
        <span class="today-item-icon">${icon(it.icon)}</span>
        <span class="today-item-body"><span class="today-item-label">${it.label}</span><span class="today-item-count">${it.count}</span></span>
        <span class="today-item-arrow">${icon('chevron-right')}</span>
      </button>
    `).join('');
    listEl.querySelectorAll('.today-item').forEach((el) => {
      el.addEventListener('click', () => {
        const it = items[Number(el.dataset.idx)];
        navigateToTodayTask(it.nav, it.taskKey);
      });
    });
  } catch (e) {
    listEl.innerHTML = '';
  }
}

// ホーム最上部の「重要なお知らせ」バナー。未読かどうかに関わらず、掲載期間中の
// 重要/最重要のお知らせは全てここに固定表示する(既読になった瞬間に消えるのは
// 通常のお知らせだけで、重要なお知らせは表示終了日まで上部に残り続ける仕様)。
async function loadAnnounceBanner() {
  const session = getSession();
  const area = document.getElementById('announce-banner-area');
  area.innerHTML = '';
  try {
    const rows = await rpc('get_my_announcements', { p_employee_code: session.employeeCode });
    // related_type='daily_reports'(本日の日報未提出の自動通知)は、同じ内容を「今日やること」の
    // own_daily_reportが既により具体的な導線(タップで日報入力画面へ)込みで表示しているため、
    // ここで重複表示しない(2026-08-28、ユーザー指摘: 「会社からのお知らせ」と「今日やること」で
    // 実質同じ内容が重複表示される)。
    const importantOnes = (rows || [])
      // item5: 配置(assignment_member)は毎日発生する日常通知。「重要なお知らせ」には積まず、
      // 「配置予定」カードと「今日やること」に集約する(日報の自動通知 daily_reports も同様に除外)。
      .filter((a) => (a.importance === 'important' || a.importance === 'critical') && shouldShowOnHome(a) && a.related_type !== 'daily_reports' && a.related_type !== 'assignment_member')
      .sort((a, b) => (a.importance === b.importance ? 0 : a.importance === 'critical' ? -1 : 1) || new Date(b.created_at) - new Date(a.created_at));
    if (importantOnes.length === 0) return;
    // ホームが重要お知らせだけで埋まらないよう表示は3件まで(最重要優先・新しい順は上のsort済み)。
    // 残りは件数つきの1ボタンへまとめ、お知らせ一覧へ誘導する(2026-08-31、統合フェーズ§15)。
    const HOME_BANNER_LIMIT = 3;
    const shown = importantOnes.slice(0, HOME_BANNER_LIMIT);
    const restCount = importantOnes.length - shown.length;
    area.innerHTML = shown.map((important) => `
      <button type="button" class="announce-banner home-announce-banner-item" data-id="${important.id}">
        <div class="announce-banner-label">📢 ${important.importance === 'critical' ? '最重要のお知らせ' : '重要なお知らせ'}</div>
        <div class="announce-banner-title">${important.title}</div>
      </button>
    `).join('') + (restCount > 0 ? `
      <button type="button" class="announce-banner home-announce-banner-item announce-banner-more">
        <div class="announce-banner-title">重要なお知らせが他${restCount}件あります(すべて見る)</div>
      </button>
    ` : '');
    area.querySelectorAll('.home-announce-banner-item').forEach((btn) => {
      if (btn.classList.contains('announce-banner-more')) {
        btn.addEventListener('click', () => showScreen('announcements'));
      } else {
        // 「お知らせ一覧へ飛ぶだけ」は不可。種別に応じて対象の詳細へ直接遷移する
        // (配置通知→対象日の配置カレンダー詳細、申請/差し戻し通知→申請詳細、日報通知→日報入力)。
        btn.addEventListener('click', () => announceDeepLink(Number(btn.dataset.id)));
      }
    });
  } catch (e) { /* 表示できなくても致命的ではないため無視 */ }
}

// お知らせ(通知)を、種別に応じた「対象の詳細画面」へ直接遷移させる。
// get_announcement_target が種別・対象日・対象IDを1回で解決する。解決できない/該当画面が無い
// 種別のみお知らせ一覧へフォールバックする。遷移時にそのお知らせを既読化する。
async function announceDeepLink(announcementId) {
  const session = getSession();
  try { await rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: announcementId }); } catch (e) { /* 無視 */ }
  let t = null;
  try {
    const rows = await rpc('get_announcement_target', { p_employee_code: session.employeeCode, p_announcement_id: announcementId });
    t = rows && rows[0];
  } catch (e) { /* 解決失敗時は一覧へフォールバック */ }
  if (!t || !t.related_type) { showScreen('announcements'); return; }
  if (t.related_type === 'assignment_member') {
    // 対象日の配置カレンダー詳細へ。ここで「確認しました」を押すと管理者の確認数へ反映される。
    openAssignmentCalendarAt(t.target_date || null);
    return;
  }
  if (t.related_type === 'daily_reports') {
    dailyReportPrefillDate = t.target_date || todayJST();
    showScreen('daily-report');
    return;
  }
  if (t.related_type === 'employee_requests' && t.target_id) {
    openMyRequestDetail(t.target_id, 'announcements');
    return;
  }
  // item4: 暗証番号再設定依頼(related_type='employees')は、管理者の社員管理(PINリセット)画面へ直接遷移し、
  // 対象社員を自動選択する。管理者は本人確認のうえ「この社員の暗証番号をリセットする」を実行できる。
  if (t.related_type === 'employees' && t.target_id) {
    pendingAdminPreselectEmployeeId = Number(t.target_id);
    showScreen('admin');
    return;
  }
  showScreen('announcements');
}
// item4: PINリセット通知等から管理者社員管理へ来たとき、対象社員を自動選択するための保留id。
let pendingAdminPreselectEmployeeId = null;

// お知らせがホーム画面に表示され続けてよいかどうかの判定(共通)。
// ルール: 未読は常に表示する。既読の場合は、display_modeがpersist_after_readなら表示し続け、
// until_dateならdisplay_untilの日付までは表示し続け、それ以外(hide_after_read等)は
// 既読になった時点でホームから消える(お知らせ履歴/申請履歴では引き続き確認できる)。
function shouldShowOnHome(a) {
  // display_until(表示終了日時)は既読/未読に関わらず必ず優先する(2026-08-28修正:
  // 未読の場合は無条件でtrueを返していたため、表示期間を過ぎた未読のお知らせが
  // ホームに表示され続けてしまっていた)。
  if (a.display_mode === 'until_date' && a.display_until && new Date(a.display_until) < new Date()) return false;
  if (!a.is_read) return true;
  // item6: 「既読」と「処理済み」を分ける。配置(assignment_member)等のアクション付き日常通知は、
  // 本人が確認(acknowledged_at=操作完了)したらHOMEから消す。会社告知等はread後も残す(persist)。
  if (a.related_type === 'assignment_member' && a.acknowledged_at) return false;
  if (a.display_mode === 'persist_after_read') return true;
  if (a.display_mode === 'until_date' && a.display_until) {
    return new Date(a.display_until) >= new Date();
  }
  return false;
}

async function loadAnnouncements(includeArchived) {
  const session = getSession();
  const listEl = document.getElementById('announcements-list');
  const archiveBtn = document.getElementById('announce-show-archived-btn');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_announcements', { p_employee_code: session.employeeCode, p_include_archived: !!includeArchived });
    if (archiveBtn) archiveBtn.style.display = includeArchived ? 'none' : '';
    if (!rows || rows.length === 0) {
      listEl.innerHTML = `<div class="hint">${includeArchived ? '過去の通知はありません。' : 'お知らせはありません。'}</div>`;
      return;
    }
    listEl.innerHTML = rows.map((a) => `
      <div class="announce-item ${a.is_read ? '' : 'unread'}" data-id="${a.id}">
        <div class="row1">
          <span class="title">${a.importance !== 'normal' ? `<span class="icon-slot" data-icon="alert-triangle"></span> ` : ''}${a.title}</span>
          <span class="date">${new Date(a.created_at).toLocaleDateString('ja-JP')}</span>
        </div>
        <div class="body">${a.body}${a.attachment_url ? `<br><a href="${a.attachment_url}" target="_blank" rel="noopener">添付ファイルを開く</a>` : ''}</div>
        ${a.related_type === 'employee_requests' ? `<button type="button" class="secondary announce-detail-btn" data-request-id="${a.related_id}">この申請の詳細を見る</button>` : ''}
        ${a.related_type === 'assignment_member' ? `<button type="button" class="secondary announce-assign-btn">配置を確認する</button>` : ''}
        ${a.related_type === 'employees' ? `<button type="button" class="secondary announce-admin-btn">社員管理で対応する</button>` : ''}
        ${a.importance !== 'normal' ? `
          <div class="announce-ack-row">
            ${a.acknowledged_at
              ? `<span class="mini-tag info">確認済み(${new Date(a.acknowledged_at).toLocaleString('ja-JP')})</span>`
              : `<button type="button" class="secondary announce-ack-btn">確認しました</button>`}
          </div>
        ` : ''}
      </div>
    `).join('');
    hydrateIcons(listEl);
    listEl.querySelectorAll('.announce-item').forEach((el) => {
      el.addEventListener('click', async (e) => {
        if (e.target.closest('.announce-ack-btn') || e.target.closest('.announce-detail-btn') || e.target.closest('.announce-assign-btn') || e.target.closest('.announce-admin-btn') || e.target.closest('a')) return;
        const wasUnread = el.classList.contains('unread');
        el.classList.toggle('expanded');
        if (wasUnread) {
          el.classList.remove('unread');
          try { await rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: Number(el.dataset.id) }); } catch (e2) { /* 無視 */ }
        }
      });
    });
    listEl.querySelectorAll('.announce-detail-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // カードの本文をタップせず「詳細を見る」を直接タップした場合でも、この通知を
        // 見た(内容を確認した)ことに変わりはないため、ここでも既読にする
        // (以前はここを経由すると既読化されずホームに「未読」が残り続けるバグがあった)。
        const item = btn.closest('.announce-item');
        if (item && item.classList.contains('unread')) {
          item.classList.remove('unread');
          try { await rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: Number(item.dataset.id) }); } catch (e2) { /* 無視 */ }
        }
        openMyRequestDetail(btn.dataset.requestId, 'announcements');
      });
    });
    // item4: PIN再設定依頼等(related_type='employees')→ 管理者社員管理へdeep link(対象社員選択済み)。
    listEl.querySelectorAll('.announce-admin-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.announce-item');
        if (item && item.classList.contains('unread')) {
          item.classList.remove('unread');
          try { rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: Number(item.dataset.id) }); } catch (e2) { /* 無視 */ }
        }
        announceDeepLink(Number(item.dataset.id));
      });
    });
    listEl.querySelectorAll('.announce-assign-btn').forEach((btn) => {
      // item2: 「配置を確認する」で、対象の配置(assignment_member)を直接『確認済み』にする。
      // notificationの既読だけで終わらせず、本人のassignment acknowledgement(confirmed_at)を保存し、
      // 管理者の「本日の配置を社員がまだ確認していない」件数から除外され、通知カードも確認済みになる。
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.announce-item');
        const annId = Number(item.dataset.id);
        btn.disabled = true;
        try {
          const rows = await rpc('get_announcement_target', { p_employee_code: session.employeeCode, p_announcement_id: annId });
          const t = rows && rows[0];
          if (t && t.related_type === 'assignment_member' && t.target_id) {
            await rpc('assignment_confirm_my_assignment', { p_employee_code: session.employeeCode, p_member_id: Number(t.target_id) });
          }
          await rpc('mark_announcement_read', { p_employee_code: session.employeeCode, p_announcement_id: annId });
          await rpc('acknowledge_announcement', { p_employee_code: session.employeeCode, p_announcement_id: annId }).catch(() => {});
          loadAnnouncements();
        } catch (e2) {
          btn.disabled = false;
          alert(e2.message || '配置の確認に失敗しました。もう一度お試しください。');
        }
      });
    });
    listEl.querySelectorAll('.announce-ack-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.announce-item');
        try {
          await rpc('acknowledge_announcement', { p_employee_code: session.employeeCode, p_announcement_id: Number(item.dataset.id) });
          loadAnnouncements();
        } catch (e3) { /* 無視 */ }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 管理者ダッシュボード ----------

// status: 'pending'(未処理・要対応→赤) / 'good'(処理済み・正常完了→緑) /
// 'warn'(処理済みだが却下・差し戻し等→オレンジ) / 'neutral'(単なる件数表示→強調しない)。
// 0件は常にstatusに関わらずグレー。管理画面全体で今後追加するカードもこのルールに従う。
const DASH_CARDS = [
  { key: 'pending_expense_approvals', filter: 'expense', label: '経費立替 承認待ち', icon: 'receipt', status: 'pending' },
  { key: 'pending_leave_approvals', filter: 'leave', label: '有給申請 承認待ち', icon: 'calendar', status: 'pending' },
  { key: 'pending_meeting_approvals', filter: 'meeting', label: '会議申請 承認待ち', icon: 'users-round', status: 'pending' },
  { key: 'pending_supply_requests', filter: 'supply', label: '支給品申請 確認待ち', icon: 'package', status: 'pending' },
  { key: 'needs_correction_count', filter: 'needs_correction', label: '確認・修正が必要な申請', icon: 'edit', status: 'pending' },
  { key: 'unanswered_consultations', filter: null, label: '未対応の匿名相談', icon: 'message-circle', nav: 'anon-admin', status: 'pending' },
  { key: 'pending_qualifications', filter: null, label: '資格の確認待ち', icon: 'graduation-cap', nav: 'qual-admin', status: 'pending' },
  { key: 'qualification_expiring_count', filter: null, label: '期限が近い資格', icon: 'clock', nav: 'qual-admin', status: 'pending' },
  { key: 'category_review_needed_count', filter: null, label: '経費の勘定科目 要確認', icon: 'hash', nav: 'category-review', status: 'pending' },
  { key: 'pending_info_change_requests', filter: null, label: '個人情報の変更申請', icon: 'user', nav: 'info-change-admin', status: 'pending' },
  { key: 'pending_sites', filter: null, label: '新規現場の確認待ち', icon: 'map-pin', nav: 'site-admin', status: 'pending' },
  { key: 'pending_entertainment_preapprovals', filter: null, label: '接待事前申請 承認待ち', icon: 'users-round', nav: 'entertainment-admin', status: 'pending' },
  { key: 'health_checkup_overdue_count', filter: null, label: '健診 期限超過', icon: 'check-circle', nav: 'health-admin', healthFilter: 'overdue', status: 'pending' },
  { key: 'health_checkup_due_soon_count', filter: null, label: '健診 期限間近', icon: 'clock', nav: 'health-admin', healthFilter: 'due_soon', status: 'pending' },
  { key: 'health_checkup_retest_pending_count', filter: null, label: '再検査確認待ち', icon: 'alert-triangle', nav: 'health-admin', healthFilter: 'retest', status: 'pending' },
  { key: 'today_submissions_count', filter: null, label: '本日の申請', icon: 'clock', nav: 'admin-all-requests', areqFilter: { type: '', status: '' }, status: 'neutral' },
  { key: 'approved_recent_count', filter: null, label: '承認済み(30日)', icon: 'check-circle', nav: 'admin-all-requests', areqFilter: { type: '', status: 'approved' }, status: 'good' },
  { key: 'rejected_recent_count', filter: null, label: '却下(30日)', icon: 'x-circle', nav: 'admin-all-requests', areqFilter: { type: '', status: 'rejected' }, status: 'warn' },
  { key: 'entertainment_special_review_count', filter: null, label: '接待: 後日申請(特別承認待ち)', icon: 'alert-triangle', nav: 'admin-all-requests', areqFilter: { type: 'entertainment_preapproval', status: 'special_review' }, status: 'pending' },
  { key: 'entertainment_override_count', filter: null, label: '接待: 事前申請なし(例外承認累計)', icon: 'users-round', nav: 'entertainment-admin', status: 'neutral' },
  { key: 'daily_report_exception_count', filter: null, label: '日報: 特殊ケース未対応', icon: 'clipboard-list', nav: 'daily-report-admin', status: 'pending' },
];

// カードのstatus+件数から表示クラスを決める共通ルール(今後追加するカードもこの関数を使う)。
function dashCardColorClass(status, count) {
  if (!count) return 'zero';
  if (status === 'good') return 'good';
  if (status === 'warn') return 'warn';
  if (status === 'neutral') return 'neutral';
  return 'alert';
}

// 管理者HOME「今日やること」: 配置由来の要対応(要確認日報・配置あり未提出・配置未確認)＋新着申請を
// 優先度順に表示し、件数タップで対象画面へ直接遷移する(admin_home_today_tasks RPCを集約に再利用)。
async function renderAdminTodayTasks(session) {
  const el = document.getElementById('admin-today-tasks');
  if (!el) return;
  try {
    const rows = await rpc('admin_home_today_tasks', { p_admin_employee_code: session.employeeCode });
    const actionable = (rows || []).filter((r) => Number(r.cnt) > 0).sort((a, b) => a.sort_order - b.sort_order);
    if (actionable.length === 0) {
      el.innerHTML = '<div class="card" style="text-align:center;color:var(--muted);">今日、対応が必要なことはありません 🎉</div>';
      return;
    }
    el.innerHTML = actionable.map((r) => {
      const color = r.severity === 'urgent' ? 'var(--danger)' : (r.severity === 'attention' ? 'var(--gold, #c9a227)' : 'var(--primary)');
      return `<button type="button" class="history-item admin-today-task" data-nav="${r.nav_screen}" data-task-key="${r.task_key}" style="width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;border-left:3px solid ${color};">
        <span style="flex:1;min-width:0;">${r.label}</span>
        <span style="font-weight:800;font-size:18px;color:${color};flex:none;">${r.cnt}</span>
        <span aria-hidden="true" style="color:var(--muted);flex:none;">›</span>
      </button>`;
    }).join('');
    // 日報系: 未提出/配置未確認は対象者一覧へ。要確認(§3)は処理できる要確認一覧(確定/修正依頼/取消)へ。
    const TASK_TO_PEOPLE = { daily_report_missing: 'missing', assignment_unconfirmed: 'unconfirmed' };
    el.querySelectorAll('.admin-today-task').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.taskKey === 'daily_report_anomaly') { showScreen('daily-report-needs-review-admin'); return; }
      // 有給P0: 「有給申請の承認待ち」→ 申請管理を 種類=有給・状態=承認待ち で絞り込んで直接表示。
      if (btn.dataset.taskKey === 'approval_leave') { openAdminRequestsFiltered('paid_leave', 'pending'); return; }
      // 各専用承認は種類フィルタ付きで申請管理へ(その他に有給等が混ざらない導線)。
      if (btn.dataset.taskKey === 'approval_expense') { openAdminRequestsFiltered('expense_reimbursement', 'pending'); return; }
      if (btn.dataset.taskKey === 'approval_meeting') { openAdminRequestsFiltered('meeting', 'pending'); return; }
      const b = TASK_TO_PEOPLE[btn.dataset.taskKey];
      if (b) openDailyReportPeople(b); else showScreen(btn.dataset.nav);
    }));
  } catch (e) {
    // 集約が取れなくても下のカードは別途表示されるため、静かに隠す
    el.innerHTML = '';
  }
}

async function loadAdminDashboard() {
  const session = getSession();
  renderAdminTodayTasks(session);
  const grid = document.getElementById('admin-dashboard-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_admin_dashboard', { p_admin_employee_code: session.employeeCode });
    const d = rows && rows[0];
    grid.innerHTML = DASH_CARDS.map((c, i) => {
      const count = d ? d[c.key] : 0;
      return `
        <button type="button" class="dash-card" data-idx="${i}">
          <span class="dash-card-top">${icon(c.icon)}<span class="dash-card-count ${dashCardColorClass(c.status, count)}">${count}</span></span>
          <span class="dash-card-label">${c.label}</span>
        </button>
      `;
    }).join('');
    grid.querySelectorAll('.dash-card').forEach((el) => {
      el.addEventListener('click', () => {
        const c = DASH_CARDS[Number(el.dataset.idx)];
        if (c.healthFilter) {
          healthAdminFilter = c.healthFilter;
          document.querySelectorAll('#screen-health-admin .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.healthFilter === c.healthFilter));
        }
        if (c.areqFilter) {
          areqFilters = { type: c.areqFilter.type || '', status: c.areqFilter.status || '', name: '', dateFrom: '', dateTo: '', site: '', partner: '' };
        }
        if (c.nav) {
          showScreen(c.nav);
          if (c.areqFilter) {
            document.querySelectorAll('#areq-type-filter .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.type === areqFilters.type));
            document.querySelectorAll('#areq-status-filter .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.status === areqFilters.status));
          }
          return;
        }
        openAdminRequestList(c.filter);
      });
    });
  } catch (e) {
    grid.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function openAdminRequestList(filter) {
  currentAdminRequestFilter = filter;
  const found = DASH_CARDS.find((c) => c.filter === filter);
  document.getElementById('admin-request-list-title').textContent = found ? found.label : '一覧';
  showScreen('admin-request-list');
}

// 有給P0: 申請管理を「種類×状態」で絞り込んで開く(HOME件数と一覧を同一データソース admin_search_requests で一致させる)。
function openAdminRequestsFiltered(type, status) {
  areqFilters = { type: type || '', status: status || '', name: '', dateFrom: '', dateTo: '', site: '', partner: '' };
  showScreen('admin-all-requests');
  document.querySelectorAll('#areq-type-filter .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.type === areqFilters.type));
  document.querySelectorAll('#areq-status-filter .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.status === areqFilters.status));
  if (typeof loadAdminAllRequests === 'function') loadAdminAllRequests();
}

async function loadAdminRequestList() {
  const session = getSession();
  const listEl = document.getElementById('admin-request-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  const canDecide = ['expense', 'leave', 'meeting'].includes(currentAdminRequestFilter);
  try {
    const rows = await rpc('list_pending_requests_admin', { p_admin_employee_code: session.employeeCode, p_filter: currentAdminRequestFilter });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => {
      const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
      return `
        <div class="history-item" data-id="${r.id}">
          <div class="row1"><span>${r.employee_name || ''}・${REQUEST_TYPE_LABEL[r.request_type] || r.request_type}</span><span>${amountStr}</span></div>
          <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
          <span class="status-badge">${STATUS_LABEL[r.status] || r.status}</span>
          ${canDecide ? `
            <div class="qual-verify-btns">
              <button type="button" class="approve-btn">承認する</button>
              <button type="button" class="reject-btn">差し戻す</button>
            </div>
            <div class="reject-reason-box" style="display:none;">
              <textarea class="reject-reason-input" placeholder="差戻し理由を入力してください"></textarea>
              <button type="button" class="reject-confirm-btn">差戻しを確定する</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideRequest(e.target.closest('.history-item').dataset.id, 'approved'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        revealReasonBox(e.target.closest('.history-item').querySelector('.reject-reason-box'));
      });
    });
    listEl.querySelectorAll('.reject-confirm-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.history-item');
        const reason = item.querySelector('.reject-reason-input').value.trim();
        if (!reason) return;
        doDecideRequest(item.dataset.id, 'rejected', reason);
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doDecideRequest(requestId, action, reason) {
  const session = getSession();
  try {
    await rpc('admin_decide_request', { p_admin_employee_code: session.employeeCode, p_request_id: Number(requestId), p_action: action, p_rejection_reason: reason || null });
    await loadAdminRequestList();
  } catch (e) {
    window.alert(e.message || '処理に失敗しました。');
  }
}

// ---------- お知らせ管理(管理者) ----------

let announceAllEmployees = [];
const announceSelectedCodes = new Set();
let announceAttachment = null; // { driveFileId, driveFileUrl }

function renderAnnounceEmployeeChecklist(query) {
  const listEl = document.getElementById('announce-employee-checklist');
  const q = (query || '').trim();
  const matches = announceAllEmployees.filter((e) => q === '' || e.employee_name.includes(q) || e.employee_code.includes(q));
  listEl.innerHTML = matches.map((e) => `
    <label class="checkbox-row" style="margin:0;">
      <input type="checkbox" class="announce-emp-check" value="${e.employee_code}" ${announceSelectedCodes.has(e.employee_code) ? 'checked' : ''}>
      <span>${e.employee_name}(${e.employee_code})</span>
    </label>
  `).join('');
  listEl.querySelectorAll('.announce-emp-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) announceSelectedCodes.add(cb.value); else announceSelectedCodes.delete(cb.value);
      document.getElementById('announce-employee-selected-count').textContent = announceSelectedCodes.size;
    });
  });
}

async function loadAnnounceAdminEmployeeSelect() {
  const session = getSession();
  try {
    announceAllEmployees = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
    renderAnnounceEmployeeChecklist('');
  } catch (e) { /* 無視 */ }
}

async function handleAnnounceAttachment(file) {
  if (!file) return;
  const statusEl = document.getElementById('announce-attachment-status');
  const labelEl = document.getElementById('announce-attachment-label');
  statusEl.textContent = 'アップロード中...';
  try {
    const session = getSession();
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    announceAttachment = { driveFileId: result.driveFileId, driveFileUrl: result.driveFileUrl };
    labelEl.textContent = file.name;
    statusEl.textContent = 'アップロード完了';
  } catch (e) {
    statusEl.textContent = 'アップロードに失敗しました。もう一度お試しください。';
    announceAttachment = null;
  }
}

async function doCreateAnnouncement() {
  const session = getSession();
  const title = document.getElementById('announce-title').value.trim();
  const body = document.getElementById('announce-body').value.trim();
  const importance = document.querySelector('input[name="announce-importance"]:checked').value;
  const displayMode = document.querySelector('input[name="announce-display-mode"]:checked').value;
  const displayUntil = displayMode === 'until_date' ? document.getElementById('announce-display-until-date').value : null;
  const displayFrom = document.getElementById('announce-display-from').value || null;
  const target = document.querySelector('input[name="announce-target"]:checked').value;
  hideError('announce-error');
  if (!title || !body) { showError('announce-error', 'タイトルと本文を入力してください。'); return; }
  if (displayMode === 'until_date' && !displayUntil) { showError('announce-error', '表示する期限の日付を選んでください。'); return; }
  let employeeCodes = null;
  if (target === 'select') {
    employeeCodes = Array.from(announceSelectedCodes);
    if (employeeCodes.length === 0) { showError('announce-error', '配信先の社員を選択してください。'); return; }
  }
  const btn = document.getElementById('announce-submit');
  btn.disabled = true;
  try {
    await rpc('admin_create_announcement', {
      p_admin_employee_code: session.employeeCode, p_title: title, p_body: body,
      p_importance: importance, p_employee_codes: employeeCodes,
      p_attachment_drive_file_id: announceAttachment ? announceAttachment.driveFileId : null,
      p_attachment_drive_url: announceAttachment ? announceAttachment.driveFileUrl : null,
      p_display_mode: displayMode, p_display_until: displayUntil, p_display_from: displayFrom,
    });
    document.getElementById('announce-title').value = '';
    document.getElementById('announce-body').value = '';
    document.getElementById('announce-importance-normal').checked = true;
    document.getElementById('announce-display-hide').checked = true;
    document.getElementById('announce-display-until-box').style.display = 'none';
    document.getElementById('announce-display-until-date').value = '';
    document.getElementById('announce-display-from').value = '';
    document.getElementById('announce-target-all').checked = true;
    document.getElementById('announce-employee-picker').style.display = 'none';
    announceSelectedCodes.clear();
    document.getElementById('announce-employee-selected-count').textContent = '0';
    document.getElementById('announce-attachment-label').textContent = 'ファイルを選ぶ';
    document.getElementById('announce-attachment-status').textContent = '';
    announceAttachment = null;
    await loadAnnounceAdminList();
  } catch (e) {
    showError('announce-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function loadAnnounceAdminList() {
  const session = getSession();
  const listEl = document.getElementById('announce-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('list_announcements_admin', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">まだお知らせを送信していません。</div>'; return; }
    listEl.innerHTML = rows.map((a) => `
      <div class="announce-admin-item" data-id="${a.id}" data-title="${a.title.replace(/"/g, '&quot;')}">
        <div class="row1"><span>${a.importance === 'important' ? `<span class="icon-slot" data-icon="alert-triangle"></span> ` : ''}${a.title}</span><span>${a.read_count}/${a.recipient_count} 既読</span></div>
        <div class="row2">${new Date(a.created_at).toLocaleString('ja-JP')}${a.source_system && a.source_system !== 'admin_manual' ? `・自動通知(${safeText(a.source_system, '不明')})` : ''}${a.importance === 'important' ? `・確認済み${safeText(a.acknowledged_count, 0)}/${safeText(a.recipient_count, 0)}` : ''}</div>
        <button type="button" class="link announce-hide-btn" data-id="${a.id}" style="color:var(--danger);margin-top:4px;">このお知らせを削除(非公開)する</button>
      </div>
    `).join('');
    hydrateIcons(listEl);
    listEl.querySelectorAll('.announce-admin-item').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target.closest('.announce-hide-btn')) return; openAnnounceStatus(Number(el.dataset.id), el.dataset.title); });
    });
    // item8: 会社お知らせの削除(論理非公開)。社員側お知らせから消える(履歴・監査は残す)。
    listEl.querySelectorAll('.announce-hide-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm('このお知らせを削除(非公開)しますか？\n\n社員のお知らせから消えます。履歴・監査には残ります。')) return;
        btn.disabled = true;
        try {
          await rpc('admin_hide_announcement', { p_admin_employee_code: session.employeeCode, p_announcement_id: Number(btn.dataset.id), p_reason: null });
          loadAnnounceAdminList();
        } catch (e2) { alert(e2.message || '削除に失敗しました。'); btn.disabled = false; }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openAnnounceStatus(id, title) {
  const session = getSession();
  document.getElementById('announce-status-title').textContent = title;
  showScreen('announce-status');
  const listEl = document.getElementById('announce-status-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_announcement_read_status_admin', { p_admin_employee_code: session.employeeCode, p_announcement_id: id });
    listEl.innerHTML = rows.map((r) => `
      <div class="read-status-row">
        <span class="name">${r.employee_name}</span>
        <span class="read-at ${r.read_at ? '' : 'unread'}">${r.read_at ? new Date(r.read_at).toLocaleString('ja-JP') : '未読'}</span>
        ${r.acknowledged_at ? `<span class="mini-tag info">確認済み ${new Date(r.acknowledged_at).toLocaleString('ja-JP')}</span>` : ''}
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 資格 ----------

let qualPhotoUpload = null;
let qualPdfUpload = null;

async function handleQualFile(file, kind) {
  if (!file) return;
  const statusEl = document.getElementById(`qual-${kind}-status`);
  const labelEl = document.getElementById(`qual-${kind}-label`);
  statusEl.textContent = 'アップロード中...';
  try {
    const session = getSession();
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    if (kind === 'photo') qualPhotoUpload = result; else qualPdfUpload = result;
    statusEl.textContent = 'アップロード完了';
    labelEl.textContent = file.name;
  } catch (e) {
    statusEl.textContent = 'アップロードに失敗しました。';
  }
}

function setQualCategory(category) {
  document.getElementById('qual-category').value = category;
  const isLicense = category === 'license';
  document.getElementById('qual-category-qualification').classList.toggle('secondary-off', isLicense);
  document.getElementById('qual-category-license').classList.toggle('secondary-off', !isLicense);
  document.getElementById('qual-name-wrap').style.display = isLicense ? 'none' : 'block';
  document.getElementById('qual-license-type-wrap').style.display = isLicense ? 'block' : 'none';
  if (isLicense) loadLicenseTypeSelect();
}

async function loadLicenseTypeSelect() {
  try {
    const rows = await rpc('list_license_types', {});
    document.getElementById('qual-license-type').innerHTML = rows.map((t) => `<option value="${t.id}">${t.type_name}</option>`).join('');
  } catch (e) { /* 無視 */ }
}

function resetQualForm() {
  ['qual-name', 'qual-number', 'qual-obtained', 'qual-expiry', 'qual-renewal', 'qual-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('qual-photo-input').value = '';
  document.getElementById('qual-pdf-input').value = '';
  document.getElementById('qual-photo-label').textContent = '写真を選ぶ';
  document.getElementById('qual-pdf-label').textContent = 'PDFを選ぶ';
  document.getElementById('qual-photo-status').textContent = '';
  document.getElementById('qual-pdf-status').textContent = '';
  qualPhotoUpload = null;
  qualPdfUpload = null;
  hideError('qual-error');
  setQualCategory('qualification');
}

async function doSubmitQualification() {
  const session = getSession();
  const category = document.getElementById('qual-category').value;
  const name = document.getElementById('qual-name').value.trim();
  const licenseTypeId = document.getElementById('qual-license-type').value || null;
  hideError('qual-error');
  if (category === 'qualification' && !name) { showError('qual-error', '資格名を入力してください。'); return; }
  if (category === 'license' && !licenseTypeId) { showError('qual-error', '免許種別を選択してください。'); return; }
  const btn = document.getElementById('qual-submit');
  btn.disabled = true;
  try {
    await rpc('submit_qualification', {
      p_employee_code: session.employeeCode,
      p_qualification_name: category === 'qualification' ? name : null,
      p_qualification_number: document.getElementById('qual-number').value.trim() || null,
      p_obtained_date: document.getElementById('qual-obtained').value || null,
      p_expiry_date: document.getElementById('qual-expiry').value || null,
      p_renewal_deadline: document.getElementById('qual-renewal').value || null,
      p_note: document.getElementById('qual-note').value.trim() || null,
      p_photo_drive_file_id: qualPhotoUpload ? qualPhotoUpload.driveFileId : null,
      p_photo_drive_file_url: qualPhotoUpload ? qualPhotoUpload.driveFileUrl : null,
      p_pdf_drive_file_id: qualPdfUpload ? qualPdfUpload.driveFileId : null,
      p_pdf_drive_file_url: qualPdfUpload ? qualPdfUpload.driveFileUrl : null,
      p_category: category,
      p_license_type_id: category === 'license' ? Number(licenseTypeId) : null,
    });
    resetQualForm();
    showDone(`${category === 'license' ? '免許' : '資格'}を登録しました。管理者の確認をお待ちください。`, 'menu-apply');
  } catch (e) {
    showError('qual-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

const QUAL_STATUS_LABEL = { pending_verification: '確認待ち', active: '有効', rejected: '却下', expired: '期限切れ', expiring_soon: '期限間近' };

async function loadMyQualifications() {
  const session = getSession();
  const listEl = document.getElementById('my-qual-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_qualifications', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">登録された資格はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((q) => {
      const expiring = q.status === 'active' && q.days_until_expiry != null && q.days_until_expiry >= 0 && q.days_until_expiry <= 60;
      const expired = q.status === 'active' && q.days_until_expiry != null && q.days_until_expiry < 0;
      const expiryText = q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}${expiring ? `(残り${q.days_until_expiry}日)` : ''}${expired ? '(期限切れ)' : ''}` : '';
      return `
        <div class="qual-item ${expiring ? 'expiring' : ''} ${expired ? 'expired' : ''}">
          <div class="row1"><span>${q.category === 'license' ? '<span class="mini-tag info">免許</span> ' : ''}${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
          <div class="row2">${expiryText}</div>
          <div class="row2">${q.qualification_number ? `番号: ${q.qualification_number}` : ''}</div>
          ${secureFileBlockHtml('qualification_photo', 'qualification_pdf', q.id, !!q.certificate_photo_url, !!q.certificate_pdf_url)}
        </div>
      `;
    }).join('');
    hydrateSecureImages(listEl);
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 資格管理(管理者) ----------

let qualAdminCategoryFilter = '';

async function loadQualAdminList() {
  const session = getSession();
  const filter = document.getElementById('qual-admin-filter').value || null;
  const search = document.getElementById('qual-admin-search').value.trim() || null;
  const listEl = document.getElementById('qual-admin-list');
  const countEl = document.getElementById('qual-admin-count');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_qualifications', { p_admin_employee_code: session.employeeCode, p_filter: filter, p_category: qualAdminCategoryFilter || null, p_search: search });
    countEl.textContent = rows ? `${rows.length}件` : '';
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する資格・免許はありません。</div>'; return; }
    listEl.innerHTML = rows.map((q) => {
      const displayStatus = q.display_status || q.status;
      const expiring = displayStatus === 'expiring_soon';
      const expiryText = q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}${q.days_until_expiry != null ? `(残り${q.days_until_expiry}日)` : ''}` : '期限未登録';
      const badgeClass = displayStatus === 'active' ? 'done' : (displayStatus === 'rejected' || displayStatus === 'expired' ? 'rejected' : '');
      return `
        <div class="qual-item ${expiring ? 'expiring' : ''}" data-id="${q.id}">
          <div class="row1"><span>${q.category === 'license' ? '<span class="mini-tag info">免許</span> ' : ''}${q.employee_name}・${q.qualification_name}</span><span class="status-badge ${badgeClass}">${QUAL_STATUS_LABEL[displayStatus] || displayStatus}</span></div>
          <div class="row2">取得日: ${q.obtained_date ? new Date(q.obtained_date).toLocaleDateString('ja-JP') : '未登録'}</div>
          <div class="row2">${expiryText}</div>
          <div class="row2">${q.qualification_number ? `番号: ${q.qualification_number}` : ''}</div>
          ${q.note ? `<div class="row2">備考: ${q.note}</div>` : ''}
          ${secureFileBlockHtml('qualification_photo', 'qualification_pdf', q.id, !!q.certificate_photo_url, !!q.certificate_pdf_url)}
          ${q.status === 'pending_verification' ? `
            <div class="qual-verify-btns">
              <button type="button" class="approve-btn">有効化する</button>
              <button type="button" class="reject-btn">却下する</button>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doVerifyQualification(e.target.closest('.qual-item').dataset.id, 'active'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doVerifyQualification(e.target.closest('.qual-item').dataset.id, 'rejected'));
    });
    hydrateSecureImages(listEl);
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doVerifyQualification(id, action) {
  const session = getSession();
  try {
    await rpc('admin_verify_qualification', { p_admin_employee_code: session.employeeCode, p_qualification_id: Number(id), p_action: action });
    await loadQualAdminList();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

// ---------- 勘定科目確認(管理者) ----------

async function loadCategoryReview() {
  const session = getSession();
  const listEl = document.getElementById('category-review-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_category_review', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">確認が必要な勘定科目はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="category-review-item" data-document-id="${r.document_id}">
        <div class="row1"><span>${r.employee_name}・${r.store_name || ''}</span><span>${r.amount != null ? `${Number(r.amount).toLocaleString()}円` : ''}</span></div>
        <div class="row2">${r.document_date ? new Date(r.document_date).toLocaleDateString('ja-JP') : ''}　現場: ${r.site_name || '-'}　用途: ${r.purpose || '-'}</div>
        <div class="ai-suggest">AI提案: ${r.category_candidate || '(候補なし)'}${r.category_confidence ? `(確信度: ${r.category_confidence === 'medium' ? '中' : '低'})` : '(未提案)'}</div>
        <input type="text" class="category-input" list="category-suggest-list" placeholder="正しい勘定科目を入力" value="${r.category_candidate || ''}">
        <button type="button" class="confirm-btn">この科目で確定する</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.category-review-item').forEach((el) => {
      el.querySelector('.confirm-btn').addEventListener('click', () => {
        const value = el.querySelector('.category-input').value.trim();
        if (!value) return;
        doConfirmCategory(el.dataset.documentId, value);
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doConfirmCategory(documentId, category) {
  const session = getSession();
  try {
    await rpc('admin_set_account_category', { p_admin_employee_code: session.employeeCode, p_document_id: Number(documentId), p_category: category, p_note: null });
    await loadCategoryReview();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

// ---------- 自分の情報(プロフィール) ----------

// 会社管理項目(社員番号・入社日等)は鍵アイコンつきで編集不可を明示。住所・電話番号等は
// 「変更申請」ボタンを付け、タップすると本人が変更申請を出せる(即時反映はしない)。
function fieldRow(label, value, editField) {
  const displayValue = value ? String(value) : '未登録';
  const editBtn = editField ? `<button type="button" class="field-edit-btn" data-edit-field="${editField}" data-current="${(value || '').replace(/"/g, '&quot;')}">変更申請</button>` : '';
  return `
    <div class="field-row">
      <span class="field-label">${label}</span>
      <span style="display:flex; align-items:center; gap:8px;">
        <span class="field-value ${value ? '' : 'empty'}">${displayValue}</span>
        ${editBtn}
      </span>
    </div>
  `;
}

function lockedFieldRow(label, value) {
  const displayValue = value ? String(value) : '未登録';
  return `
    <div class="field-row">
      <span class="field-label">${label}<span class="field-locked">${icon('lock')}管理者のみ変更可</span></span>
      <span class="field-value ${value ? '' : 'empty'}">${displayValue}</span>
    </div>
  `;
}

const CHANGE_FIELD_LABEL = {
  phone: '電話番号', postal_code: '郵便番号', address: '住所', email: 'メールアドレス',
  emergency_contact_name: '緊急連絡先(氏名)', emergency_contact_relation: '緊急連絡先(続柄)', emergency_contact_phone: '緊急連絡先(電話番号)',
};

function renderAvatar(elId, name, photoUrl) {
  const el = document.getElementById(elId);
  if (photoUrl) {
    el.style.backgroundImage = `url("${photoUrl}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (name || '?').charAt(0);
  }
}

// ---------- Push通知(2026-08-26追加、既存の通知センター(announcements)の配信経路を1つ追加するだけ) ----------

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// sw.jsのpushsubscriptionchangeハンドラが、ページが開いていない状態でも自力で
// register_my_push_subscriptionを呼び直せるよう、購読中は社員番号と端末トークンを
// IndexedDBへ保存しておく(localStorageはService Workerから読めないため)。
function savePushAuthForSW(employeeCode, token) {
  try {
    const req = indexedDB.open('jinshou-push-auth', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('auth', { keyPath: 'id' }); };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('auth', 'readwrite');
      if (employeeCode && token) tx.objectStore('auth').put({ id: 'current', employeeCode, token });
      else tx.objectStore('auth').delete('current');
    };
  } catch (e) { /* IndexedDB非対応環境では諦める(pushsubscriptionchangeの自動復旧のみ効かない) */ }
}

async function initPushToggleState() {
  const toggle = document.getElementById('myinfo-push-toggle');
  const statusEl = document.getElementById('myinfo-push-status');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toggle.disabled = true;
    statusEl.textContent = 'この端末・ブラウザはPush通知に対応していません。';
    return;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    toggle.checked = false;
    statusEl.textContent = 'ブラウザ側で通知がブロックされています。ブラウザのアドレスバー付近の設定アイコンから、このサイトの通知を「許可」に変更してから再度お試しください。';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    toggle.checked = !!sub;
    if (sub) statusEl.textContent = 'Push通知は有効です。';
  } catch (e) { /* 取得できなくてもトグル操作自体は試せる */ }
}

async function togglePushNotifications(enable) {
  const session = getSession();
  const statusEl = document.getElementById('myinfo-push-status');
  const toggle = document.getElementById('myinfo-push-toggle');
  try {
    const reg = await navigator.serviceWorker.ready;
    if (enable) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toggle.checked = false;
        statusEl.textContent = 'ブラウザの通知許可が必要です。ブラウザの設定から通知を許可してください。';
        return;
      }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
      const json = sub.toJSON();
      await rpc('register_my_push_subscription', {
        p_employee_code: session.employeeCode, p_endpoint: json.endpoint,
        p_p256dh: json.keys.p256dh, p_auth: json.keys.auth, p_user_agent: navigator.userAgent,
      });
      savePushAuthForSW(session.employeeCode, currentDeviceToken);
      statusEl.textContent = 'Push通知を有効にしました。';
    } else {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await rpc('unregister_my_push_subscription', { p_employee_code: session.employeeCode, p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      savePushAuthForSW(null, null);
      statusEl.textContent = 'Push通知を無効にしました。';
    }
  } catch (e) {
    toggle.checked = !enable;
    statusEl.textContent = 'Push通知の設定に失敗しました: ' + (e.message || '');
  }
}

async function loadMyInfo() {
  const session = getSession();
  renderAvatar('myinfo-avatar', session.employeeName, null);
  document.getElementById('myinfo-name').textContent = session.employeeName;
  document.getElementById('myinfo-code').textContent = `社員番号: ${session.employeeCode}`;
  document.getElementById('myinfo-photo-status').textContent = '';
  loadHomeLeaveStats('myinfo-leave-balance', 'myinfo-leave-used', 'myinfo-leave-granted');
  initPushToggleState();

  try {
    const rows = await rpc('get_my_profile', { p_employee_code: session.employeeCode });
    const p = rows && rows[0];
    if (!p) return;
    renderAvatar('myinfo-avatar', p.employee_name, p.profile_photo_url);
    document.getElementById('myinfo-photo-remove-btn').style.display = p.profile_photo_url ? 'inline' : 'none';
    document.getElementById('myinfo-basic-fields').innerHTML =
      lockedFieldRow('社員番号', p.employee_code) +
      lockedFieldRow('氏名', p.employee_name) +
      lockedFieldRow('フリガナ', p.furigana) +
      lockedFieldRow('生年月日', p.birth_date ? new Date(p.birth_date).toLocaleDateString('ja-JP') : null) +
      lockedFieldRow('入社日', p.hire_date ? new Date(p.hire_date).toLocaleDateString('ja-JP') : null) +
      lockedFieldRow('所属/役割', p.department);
    document.getElementById('myinfo-contact-fields').innerHTML =
      fieldRow('メールアドレス', p.email, 'email') +
      fieldRow('電話番号', p.phone, 'phone') +
      fieldRow('郵便番号', p.postal_code, 'postal_code') +
      fieldRow('住所', p.address, 'address');
    document.getElementById('myinfo-emergency-fields').innerHTML =
      fieldRow('氏名', p.emergency_contact_name, 'emergency_contact_name') +
      fieldRow('続柄', p.emergency_contact_relation, 'emergency_contact_relation') +
      fieldRow('電話番号', p.emergency_contact_phone, 'emergency_contact_phone');

    document.querySelectorAll('.field-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => openProfileEdit(btn.dataset.editField, btn.dataset.current));
    });
  } catch (e) { /* プロフィールが読めなくても他の情報は表示され続ける */ }
}

async function handleMyPhotoFile(file) {
  if (!file) return;
  const session = getSession();
  const statusEl = document.getElementById('myinfo-photo-status');
  statusEl.textContent = 'アップロード中...';
  try {
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    await rpc('update_my_profile_photo', { p_employee_code: session.employeeCode, p_drive_file_id: result.driveFileId, p_drive_file_url: result.driveFileUrl });
    statusEl.textContent = '';
    await loadMyInfo();
  } catch (e) {
    statusEl.textContent = e.message || 'アップロードに失敗しました。';
  }
}

async function handleMyPhotoRemove() {
  if (!confirm('プロフィール画像を削除しますか?')) return;
  const session = getSession();
  try {
    await rpc('remove_my_profile_photo', { p_employee_code: session.employeeCode });
    await loadMyInfo();
  } catch (e) {
    document.getElementById('myinfo-photo-status').textContent = e.message || '削除に失敗しました。';
  }
}

function openProfileEdit(field, currentValue) {
  document.getElementById('profile-edit-field').value = field;
  document.getElementById('profile-edit-title').textContent = `${CHANGE_FIELD_LABEL[field] || field}の変更申請`;
  document.getElementById('profile-edit-label').textContent = `新しい${CHANGE_FIELD_LABEL[field] || ''}`;
  const input = document.getElementById('profile-edit-value');
  input.value = currentValue || '';
  hideError('profile-edit-error');
  showScreen('profile-edit');
}

async function doSubmitProfileEdit() {
  const session = getSession();
  const field = document.getElementById('profile-edit-field').value;
  const value = document.getElementById('profile-edit-value').value.trim();
  hideError('profile-edit-error');
  if (!value) { showError('profile-edit-error', '内容を入力してください。'); return; }

  const btn = document.getElementById('profile-edit-submit');
  btn.disabled = true;
  try {
    await rpc('submit_info_change_request', { p_employee_code: session.employeeCode, p_field_name: field, p_new_value: value });
    showDone('変更を申請しました。管理者が確認したうえで反映されます。', 'myinfo');
  } catch (e) {
    showError('profile-edit-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

function resetPinChangeForm() {
  hideError('pin-change-error');
  document.getElementById('pin-change-current').value = '';
  document.getElementById('pin-change-new').value = '';
  document.getElementById('pin-change-confirm').value = '';
}

async function doSubmitPinChange() {
  const session = getSession();
  const current = document.getElementById('pin-change-current').value.trim();
  const newPin = document.getElementById('pin-change-new').value.trim();
  const confirm = document.getElementById('pin-change-confirm').value.trim();
  hideError('pin-change-error');

  if (!current) { showError('pin-change-error', '現在の暗証番号を入力してください。'); return; }
  if (!/^[0-9]{4,6}$/.test(newPin)) { showError('pin-change-error', '新しい暗証番号は4〜6桁の数字で入力してください。'); return; }
  if (newPin !== confirm) { showError('pin-change-error', '新しい暗証番号(確認)が一致しません。'); return; }

  const btn = document.getElementById('pin-change-submit');
  btn.disabled = true;
  try {
    await rpc('change_employee_pin', { p_employee_code: session.employeeCode, p_current_pin: current, p_new_pin: newPin });
    resetPinChangeForm();
    showDone('暗証番号を変更しました。', 'myinfo');
  } catch (e) {
    showError('pin-change-error', e.message || '変更に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

const CHANGE_STATUS_LABEL = { pending: '確認待ち', approved: '承認済み', rejected: '却下' };

async function loadMyChangeRequests() {
  const session = getSession();
  const listEl = document.getElementById('my-change-requests-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_change_requests', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">変更申請はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="change-request-item">
        <div class="row1"><span>${CHANGE_FIELD_LABEL[r.field_name] || r.field_name}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${CHANGE_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${r.old_value || '(未登録)'} → ${r.new_value}</div>
        <div class="row2">${new Date(r.created_at).toLocaleString('ja-JP')}${r.review_note ? `・${r.review_note}` : ''}</div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 個人情報の変更申請確認(管理者) ----------

async function loadInfoChangeAdmin() {
  const session = getSession();
  const status = document.getElementById('info-change-filter').value || null;
  const listEl = document.getElementById('info-change-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_info_change_requests', { p_admin_employee_code: session.employeeCode, p_status: status });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する変更申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="change-request-item" data-id="${r.id}">
        <div class="row1"><span>${r.employee_name}・${CHANGE_FIELD_LABEL[r.field_name] || r.field_name}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${CHANGE_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${r.old_value || '(未登録)'} → ${r.new_value}</div>
        <div class="row2">${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        ${r.status === 'pending' ? `
          <div class="qual-verify-btns">
            <button type="button" class="approve-btn">承認する</button>
            <button type="button" class="reject-btn">却下する</button>
          </div>
        ` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideInfoChange(e.target.closest('.change-request-item').dataset.id, 'approved'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideInfoChange(e.target.closest('.change-request-item').dataset.id, 'rejected'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doDecideInfoChange(id, action) {
  const session = getSession();
  try {
    await rpc('admin_decide_info_change_request', { p_admin_employee_code: session.employeeCode, p_request_id: Number(id), p_action: action, p_note: null });
    await loadInfoChangeAdmin();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

// ---------- 社員名簿・社員管理(管理者) ----------

let employeeSearchTimer = null;
let employeeStatusFilter = 'active';
let currentEmployeeDetailCode = null;
let currentEmployeeDetailTab = 'basic';

async function loadEmployeeDirectory() {
  const session = getSession();
  const search = document.getElementById('employee-search-input').value.trim();
  const listEl = document.getElementById('employee-directory-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_employees', { p_admin_employee_code: session.employeeCode, p_search: search || null, p_status_filter: employeeStatusFilter || null, p_sort: 'code' });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する社員はいません。</div>'; return; }
    listEl.innerHTML = rows.map((e) => `
      <div class="employee-row" data-code="${e.employee_code}">
        <div class="employee-avatar">${(e.employee_name || '?').charAt(0)}</div>
        <div class="employee-row-body">
          <div class="employee-row-name">${e.employee_name}<span style="color:var(--text-faint); font-weight:500; font-size:11.5px;">${e.employee_code}</span></div>
          <div class="employee-row-meta">${e.department || ''}${e.status !== 'active' ? '・在籍外' : ''}</div>
          <div class="employee-row-flags">
            ${e.qualification_warning_count > 0 ? `<span class="mini-tag warn">資格期限 ${e.qualification_warning_count}件</span>` : ''}
            ${e.pending_request_count > 0 ? `<span class="mini-tag info">未処理申請 ${e.pending_request_count}件</span>` : ''}
          </div>
        </div>
        <span style="color:var(--text-faint);">${icon('chevron-right')}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.employee-row').forEach((el) => {
      el.addEventListener('click', () => openEmployeeDetail(el.dataset.code));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function resetEmployeeCreateForm() {
  ['ec-code', 'ec-name', 'ec-furigana', 'ec-department', 'ec-hire-date', 'ec-phone', 'ec-address',
    'ec-emergency-name', 'ec-emergency-relation', 'ec-emergency-phone'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('ec-gender').value = '';
  document.getElementById('ec-foreign-worker').checked = false;
  hideError('ec-error');
}

async function doCreateEmployee() {
  const session = getSession();
  const code = document.getElementById('ec-code').value.trim();
  const name = document.getElementById('ec-name').value.trim();
  hideError('ec-error');
  // 社員番号は既存の社員名簿・給与Spreadsheetの番号をそのまま指定する(自動採番しない=項目1/5)。
  if (!code) { showError('ec-error', '社員番号を入力してください。'); return; }
  if (!/^[0-9]{1,10}$/.test(code)) { showError('ec-error', '社員番号は数字で入力してください(例: 0044)。'); return; }
  if (!name) { showError('ec-error', '氏名を入力してください。'); return; }
  const btn = document.getElementById('ec-submit');
  btn.disabled = true;
  try {
    // 空欄・形式・重複・既存衝突チェックはRPC側(admin_create_employee_with_code)でも
    // 二重に行い、重複社員番号はDBのUNIQUE制約が最終防衛線になる。
    //
    // 2026-09-01: admin_create_employee_with_code から admin_create_employee_and_issue_code へ
    // 変更した。以前は社員を作った後に管理者が社員詳細画面で「初回登録コードを発行する」を
    // 押す必要があり、押し忘れると本人がいつまでもログインできない状態が残っていた。
    // 新しい関数は社員の作成とその社員専用コードの発行を1回で行う(中身は同じ2つの関数を
    // 順に呼んでいるだけで、発行のロジックは重複させていない)。
    const rows = await rpc('admin_create_employee_and_issue_code', {
      p_admin_employee_code: session.employeeCode,
      p_new_employee_code: code,
      p_employee_name: name,
      p_department: document.getElementById('ec-department').value.trim() || null,
      p_hire_date: document.getElementById('ec-hire-date').value || null,
      p_gender: document.getElementById('ec-gender').value || null,
      p_is_foreign_worker: document.getElementById('ec-foreign-worker').checked,
      p_furigana: document.getElementById('ec-furigana').value.trim() || null,
      p_phone: document.getElementById('ec-phone').value.trim() || null,
      p_address: document.getElementById('ec-address').value.trim() || null,
      p_emergency_contact_name: document.getElementById('ec-emergency-name').value.trim() || null,
      p_emergency_contact_relation: document.getElementById('ec-emergency-relation').value.trim() || null,
      p_emergency_contact_phone: document.getElementById('ec-emergency-phone').value.trim() || null,
    });
    const created = rows && rows[0];
    const createdCode = created.out_employee_code || created.employee_code;
    // コードは発行したその1回しか表示できない(DBにはハッシュしか残さないため)。
    // 控え損ねた場合は社員詳細画面から再発行でき、そのとき古いコードは失効する。
    if (created.out_first_login_code) {
      const limit = new Date(created.out_expires_at).toLocaleDateString('ja-JP');
      alert(`社員番号${createdCode}で登録しました。\n\n`
        + `この社員の初回登録コード: ${created.out_first_login_code}\n`
        + `有効期限: ${limit}\n\n`
        + 'このコードはこの画面を離れると二度と表示できません。今すぐ控えて本人へお伝えください。\n'
        + '控え損ねた場合は、社員詳細画面から再発行できます(古いコードは使えなくなります)。');
    } else {
      alert(`社員番号${createdCode}で登録しました。\n`
        + '初回登録コードは自動発行できませんでした。社員詳細画面から発行してください。');
    }
    openEmployeeDetail(createdCode, 'basic');
  } catch (e) {
    showError('ec-error', e.message || '登録に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function openEmployeeDetail(code, initialTab) {
  currentEmployeeDetailCode = code;
  const tab = initialTab || 'basic';
  currentEmployeeDetailTab = tab;
  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#screen-employee-detail .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `employee-detail-panel-${tab}`));
  showScreen('employee-detail');
  // ヘッダー(アバター・氏名)は全タブ共通で常に表示されるため、basicタブ以外へ
  // 直接遷移する場合(社員別集計・有給管理の行クリック等)でも必ず読み込む。
  if (tab !== 'basic') loadEmployeeDetailBasic();
  await switchEmployeeDetailTab(tab);
}

async function switchEmployeeDetailTab(tab) {
  currentEmployeeDetailTab = tab;
  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('#screen-employee-detail .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `employee-detail-panel-${tab}`));
  if (tab === 'basic') await loadEmployeeDetailBasic();
  else if (tab === 'leave') { await loadEmployeeDetailLeave(); await loadEmployeeDetailLeavePolicy(); await loadEmployeeDetailLeaveGrants(); }
  else if (tab === 'qual') await loadEmployeeDetailQual();
  else if (tab === 'supply') await loadEmployeeDetailSupply();
  else if (tab === 'requests') await loadEmployeeDetailRequests();
  else if (tab === 'devices') await loadEmployeeDetailDevices();
}

async function loadEmployeeDetailPortalAccess() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  try {
    const rows = await rpc('admin_list_employees', { p_admin_employee_code: session.employeeCode, p_search: code, p_status_filter: null, p_sort: 'code' });
    const e = (rows || []).find((r) => r.employee_code === code);
    if (!e) return;
    const statusEl = document.getElementById('employee-detail-portal-access-status');
    const toggleBtn = document.getElementById('employee-detail-portal-access-toggle-btn');
    statusEl.textContent = e.portal_access_enabled ? '許可中' : '停止中';
    statusEl.className = 'mini-tag ' + (e.portal_access_enabled ? 'info' : 'danger');
    toggleBtn.textContent = e.portal_access_enabled ? '利用を停止する' : '利用を再開する';
    toggleBtn.onclick = async () => {
      const enabling = !e.portal_access_enabled;
      if (!enabling && !confirm('この社員のポータル利用を停止します。既存の全端末も即座に使えなくなります。よろしいですか？')) return;
      toggleBtn.disabled = true;
      try {
        await rpc('admin_set_portal_access', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code, p_enabled: enabling });
        await loadEmployeeDetailPortalAccess();
        await loadEmployeeDetailDevices();
      } catch (e2) { alert(e2.message); }
      toggleBtn.disabled = false;
    };

    const codeStatusEl = document.getElementById('employee-detail-first-code-status');
    codeStatusEl.textContent = e.has_registered_pin ? '初回登録済み' : (e.has_valid_first_login_code ? '発行済み(未使用)' : '未発行');
    codeStatusEl.className = 'mini-tag ' + (e.has_registered_pin ? 'info' : (e.has_valid_first_login_code ? 'warn' : ''));
    const issueBtn = document.getElementById('employee-detail-issue-first-code-btn');
    const resultEl = document.getElementById('employee-detail-first-code-result');
    resultEl.style.display = 'none';
    issueBtn.textContent = e.has_valid_first_login_code ? '再発行する(古いコードは失効します)' : '初回登録コードを発行する';
    issueBtn.onclick = async () => {
      if (e.has_valid_first_login_code && !confirm('既に有効なコードがあります。再発行すると古いコードは使えなくなります。よろしいですか？')) return;
      issueBtn.disabled = true;
      try {
        const r = await rpc('admin_issue_first_login_code', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
        const info = r[0];
        resultEl.style.display = 'block';
        resultEl.innerHTML = `<div class="hint" style="margin-top:8px;">コード: <b style="font-size:16px; letter-spacing:1px;">${info.out_code}</b>(このコードはこの画面を離れると二度と表示できません。今すぐ本人へお伝えください。有効期限: ${new Date(info.out_expires_at).toLocaleDateString('ja-JP')})</div>`;
        await loadEmployeeDetailPortalAccess();
      } catch (e2) { alert(e2.message); }
      issueBtn.disabled = false;
    };
  } catch (e) { /* 読み込み失敗時は静かに諦める(端末一覧は別途表示されるため) */ }
}

// ================= 初回登録コード管理(管理者) =================
// コードはDBにハッシュのみ保存され平文は復元不可のため、(再)発行した瞬間の平文だけを
// このセッションのメモリ(flcRevealed)に一時保持して表示する。画面を離れる/再読込すると
// 平文は消える(その場合は再発行して表示する)。一般社員はこの画面・RPCへ到達できない。
const flcRevealed = new Map();   // employee_code -> { code, expires_at }  ※メモリのみ・端末外へ出さない
const flcShown = new Set();      // いま平文を表示中の employee_code(「表示する」を押した行)
let flcRows = [];                // admin_list_first_login_codes の結果(平文は含まない)

const FLC_STATUS_LABEL = {
  registered: { t: '登録済み', c: 'info' },
  issued: { t: '発行済み・未使用', c: 'warn' },
  no_code: { t: '未発行', c: '' },
  expired: { t: '期限切れ', c: 'danger' },
  revoked: { t: '失効', c: '' },
  used: { t: '使用済み', c: 'info' },
};

async function loadFirstLoginCodesAdmin() {
  const session = getSession();
  const listEl = document.getElementById('flc-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  const searchEl = document.getElementById('flc-search');
  if (searchEl && !searchEl.dataset.wired) {
    searchEl.dataset.wired = '1';
    searchEl.addEventListener('input', renderFirstLoginCodesList);
  }
  const bulkBtn = document.getElementById('flc-reissue-all-btn');
  if (bulkBtn && !bulkBtn.dataset.wired) {
    bulkBtn.dataset.wired = '1';
    bulkBtn.addEventListener('click', bulkIssueFirstLoginCodes);
  }
  try {
    flcRows = await rpc('admin_list_first_login_codes', { p_admin_employee_code: session.employeeCode });
    renderFirstLoginCodesList();
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">${e.message || '読み込みに失敗しました'}</div>`;
  }
}

function renderFirstLoginCodesList() {
  const listEl = document.getElementById('flc-list');
  const summaryEl = document.getElementById('flc-summary');
  const q = (document.getElementById('flc-search')?.value || '').trim().toLowerCase();
  const rows = flcRows.filter((r) => !q
    || (r.employee_code || '').toLowerCase().includes(q)
    || (r.employee_name || '').toLowerCase().includes(q));
  if (summaryEl) {
    const issued = flcRows.filter((r) => r.status === 'issued').length;
    const registered = flcRows.filter((r) => r.status === 'registered').length;
    const noCode = flcRows.filter((r) => r.status === 'no_code' || r.status === 'expired' || r.status === 'revoked').length;
    summaryEl.textContent = `対象社員 ${flcRows.length}名 / 発行済み・未使用 ${issued}名 / 登録済み ${registered}名 / 未発行・要対応 ${noCode}名`;
  }
  if (rows.length === 0) { listEl.innerHTML = '<div class="empty-state">該当する社員がいません</div>'; return; }
  listEl.innerHTML = '';
  rows.forEach((r) => {
    const st = FLC_STATUS_LABEL[r.status] || { t: r.status, c: '' };
    const revealed = flcRevealed.get(r.employee_code);
    const shown = flcShown.has(r.employee_code);
    const div = document.createElement('div');
    div.className = 'history-item';
    let codeArea = '';
    if (r.status === 'registered') {
      codeArea = '<div class="hint-inline">この社員は既に暗証番号を登録済みです(暗証番号でログインします)。コードの発行は不要です。</div>';
    } else if (revealed) {
      // 表示するを押した時だけ平文を見せる(既定は伏せ字)。コピー可能。
      const masked = '•'.repeat(revealed.code.length);
      codeArea = `
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;">
          <code style="font-size:17px;letter-spacing:2px;font-weight:700;">${shown ? revealed.code : masked}</code>
          <button type="button" class="btn-secondary flc-toggle" data-code="${r.employee_code}" style="padding:4px 10px;">${shown ? '隠す' : '表示する'}</button>
          <button type="button" class="btn-secondary flc-copy" data-code="${r.employee_code}" style="padding:4px 10px;">コードをコピー</button>
          <button type="button" class="btn-secondary flc-copy-pair" data-code="${r.employee_code}" style="padding:4px 10px;">社員番号+コードをコピー</button>
        </div>
        <div class="hint-inline" style="margin-top:4px;">有効期限: ${revealed.expires_at ? new Date(revealed.expires_at).toLocaleDateString('ja-JP') : '-'}。この画面を離れると再表示できません(その場合は再発行してください)。</div>`;
    } else {
      const label = (r.status === 'no_code') ? '発行して表示' : '再発行して表示(前のコードは無効化)';
      codeArea = `<div style="margin-top:6px;"><button type="button" class="btn-secondary flc-issue" data-code="${r.employee_code}" style="padding:6px 12px;">${label}</button></div>`;
    }
    div.innerHTML = `
      <div class="row1"><span><b>${r.employee_code}</b> ${r.employee_name}</span><span class="mini-tag ${st.c}">${st.t}</span></div>
      ${r.code_issued_at && r.status !== 'registered' ? `<div class="hint-inline">発行日時: ${new Date(r.code_issued_at).toLocaleString('ja-JP')}</div>` : ''}
      ${codeArea}
    `;
    listEl.appendChild(div);
  });
  // 行内ボタンの配線
  listEl.querySelectorAll('.flc-issue').forEach((b) => b.addEventListener('click', () => issueFirstLoginCodeFor(b.dataset.code, false)));
  listEl.querySelectorAll('.flc-toggle').forEach((b) => b.addEventListener('click', () => { const c = b.dataset.code; if (flcShown.has(c)) flcShown.delete(c); else flcShown.add(c); renderFirstLoginCodesList(); }));
  listEl.querySelectorAll('.flc-copy').forEach((b) => b.addEventListener('click', () => flcCopy(b, flcRevealed.get(b.dataset.code)?.code || '', 'コードをコピー')));
  listEl.querySelectorAll('.flc-copy-pair').forEach((b) => b.addEventListener('click', () => { const rv = flcRevealed.get(b.dataset.code); flcCopy(b, rv ? `${b.dataset.code} ${rv.code}` : '', '社員番号+コードをコピー'); }));
}

async function flcCopy(btn, text, restoreLabel) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent; btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = restoreLabel || orig; }, 1500);
  } catch (e) {
    alert('コピーできませんでした。手動で選択してコピーしてください。');
  }
}

async function issueFirstLoginCodeFor(employeeCode, silent) {
  const session = getSession();
  const row = flcRows.find((r) => r.employee_code === employeeCode);
  if (row && row.status === 'issued' && !silent) {
    if (!confirm(`${employeeCode} には既に有効なコードがあります。再発行すると以前のコードは使えなくなります。よろしいですか？`)) return;
  }
  try {
    const r = await rpc('admin_issue_first_login_code', { p_admin_employee_code: session.employeeCode, p_target_employee_code: employeeCode });
    const info = Array.isArray(r) ? r[0] : r;
    flcRevealed.set(employeeCode, { code: info.out_code, expires_at: info.out_expires_at });
    flcShown.add(employeeCode); // 発行直後は表示状態にする(管理者がすぐ確認できるように)
    if (row) { row.status = 'issued'; row.code_issued_at = new Date().toISOString(); }
    if (!silent) renderFirstLoginCodesList();
    return true;
  } catch (e) {
    if (!silent) alert(e.message || '発行に失敗しました。');
    return false;
  }
}

async function bulkIssueFirstLoginCodes() {
  const targets = flcRows.filter((r) => r.status !== 'registered');
  if (targets.length === 0) { alert('発行が必要な社員はいません(全員が登録済みです)。'); return; }
  if (!confirm(`未登録の社員 ${targets.length}名へ初回登録コードを発行します。\n既に有効なコードがある社員は再発行され、以前のコードは無効になります。\n\n表示されたコードは本人へお渡しください。よろしいですか？`)) return;
  const btn = document.getElementById('flc-reissue-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = '発行中...'; }
  let done = 0;
  for (const r of targets) {
    // eslint-disable-next-line no-await-in-loop
    if (await issueFirstLoginCodeFor(r.employee_code, true)) done += 1;
  }
  if (btn) { btn.disabled = false; btn.textContent = '未登録の社員へ一括発行して表示'; }
  renderFirstLoginCodesList();
  alert(`${done}名分の初回登録コードを発行しました。各行の「表示する」で確認し、本人へお渡しください。`);
}

// User-Agent文字列をそのまま表示せず、一般の管理者にも分かる端末種別へ短縮する
// (mail-secretary/app.jsの同名ヘルパーと同じロジックを再利用、重複実装しない)。
function shortenDeviceLabel(ua) {
  if (!ua) return '不明な端末';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android端末';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  return ua.length > 40 ? ua.slice(0, 40) + '…' : ua;
}

async function loadEmployeeDetailDevices() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  const listEl = document.getElementById('employee-detail-devices-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  await loadEmployeeDetailPortalAccess();
  try {
    const rows = await rpc('admin_list_employee_devices', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">この社員はまだどの端末からもログインしていません。</div>'; return; }
    listEl.innerHTML = rows.map((d) => `
      <div class="admin-result-item">
        <div class="row1"><span>${shortenDeviceLabel(d.device_label)}</span><span class="status-badge ${d.approval_status === 'pending' ? 'warn' : (d.is_active && d.employee_status === 'active' ? 'done' : 'rejected')}">${d.approval_status === 'pending' ? '承認待ち' : (d.approval_status === 'rejected' ? '却下済み' : (!d.is_active ? '無効化済み' : (d.employee_status !== 'active' ? '本人が利用停止中' : '有効')))}</span></div>
        <div class="row2">初回ログイン: ${new Date(d.created_at).toLocaleString('ja-JP')}</div>
        <div class="row2">最終利用: ${new Date(d.last_seen_at).toLocaleString('ja-JP')}${d.last_seen_ip ? `・${d.last_seen_ip}` : ''}</div>
        ${!d.is_active && d.approval_status !== 'pending' ? `<div class="row2">無効化: ${d.revoked_at ? new Date(d.revoked_at).toLocaleString('ja-JP') : ''}(${d.revoked_by === 'self' ? '本人がログアウト' : (d.revoked_by === 'system:employee_inactive' ? '退職・利用停止による自動遮断' : `管理者(${d.revoked_by})が無効化`)})</div>` : ''}
        ${d.approval_status === 'pending' ? `<button type="button" class="approve-btn" data-approve-device-id="${d.id}">承認する</button><button type="button" class="reject-btn" data-reject-device-id="${d.id}">却下する</button>` : ''}
        ${d.approval_status === 'approved' && d.is_active ? `<button type="button" class="return-btn" data-revoke-device-id="${d.id}">この端末を無効化する</button>` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('[data-revoke-device-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この端末を無効化しますか?次回利用時に暗証番号の再入力が必要になります。')) return;
        btn.disabled = true;
        try {
          await rpc('admin_revoke_employee_device', { p_admin_employee_code: session.employeeCode, p_device_id: Number(btn.dataset.revokeDeviceId) });
          await loadEmployeeDetailDevices();
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
        }
      });
    });
    listEl.querySelectorAll('[data-approve-device-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('admin_decide_device_approval', { p_admin_employee_code: session.employeeCode, p_device_id: Number(btn.dataset.approveDeviceId), p_action: 'approve' });
          await loadEmployeeDetailDevices();
        } catch (e) { alert(e.message); btn.disabled = false; }
      });
    });
    listEl.querySelectorAll('[data-reject-device-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('この端末からの利用申請を却下しますか?')) return;
        btn.disabled = true;
        try {
          await rpc('admin_decide_device_approval', { p_admin_employee_code: session.employeeCode, p_device_id: Number(btn.dataset.rejectDeviceId), p_action: 'reject' });
          await loadEmployeeDetailDevices();
        } catch (e) { alert(e.message); btn.disabled = false; }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailBasic() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  try {
    const rows = await rpc('admin_get_employee_profile', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    const p = rows && rows[0];
    if (!p) return;
    renderAvatar('employee-detail-avatar', p.employee_name, p.profile_photo_url);
    document.getElementById('employee-detail-name').textContent = p.employee_name;
    document.getElementById('employee-detail-code').textContent = `社員番号: ${p.employee_code}・${p.status === 'active' ? '在籍中' : '在籍外'}`;
    document.getElementById('employee-detail-basic-fields').innerHTML =
      fieldRow('フリガナ', p.furigana) + fieldRow('生年月日', p.birth_date ? new Date(p.birth_date).toLocaleDateString('ja-JP') : null) +
      fieldRow('入社日', p.hire_date ? new Date(p.hire_date).toLocaleDateString('ja-JP') : null) + fieldRow('所属/役割', p.department) +
      fieldRow('権限', p.request_role === 'executive' ? '管理者' : '一般社員') +
      fieldRow('メールアドレス', p.email) + fieldRow('電話番号', p.phone) + fieldRow('郵便番号', p.postal_code) + fieldRow('住所', p.address) +
      fieldRow('緊急連絡先(氏名)', p.emergency_contact_name) + fieldRow('緊急連絡先(続柄)', p.emergency_contact_relation) + fieldRow('緊急連絡先(電話番号)', p.emergency_contact_phone) +
      fieldRow('日報: 運転手', p.is_driver ? '対象' : null) + fieldRow('日報: 残業入力', p.can_overtime ? '対象' : null) +
      fieldRow('日報: 現場入力', p.can_input_site_duty ? '対象' : null) + fieldRow('日報: 営業入力', p.can_input_sales ? '対象' : null) +
      fieldRow('日報: 運搬入力', p.can_input_transport ? '対象' : null) + fieldRow('日報: 資格取得登録', p.can_input_qualification ? '対象' : null);
  } catch (e) { /* 無視 */ }
}

const LEAVE_TX_LABEL = { initial_grant: '付与(初回)', accrual: '付与', usage: '使用', adjustment: '調整/取消', carryover_expiry: '失効' };

async function loadEmployeeDetailLeave() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  const listEl = document.getElementById('employee-detail-leave-history');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const summaryRows = await rpc('admin_get_employee_leave_summary', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    const b = summaryRows && summaryRows[0];
    // 使用実績(used_this_period/taken_count_this_period)は、管理者による付与登録
    // (has_active_period)の有無に関わらず、実際のleave_balances(usage)から常に算出される
    // (付与額が未設定だからといって既に取得済みの実績まで隠さない)。付与/残りは、管理者が
    // 「有給ポリシー」タブで付与登録するまでは架空の数字を出さず「未設定」のままにする。
    if (b) {
      document.getElementById('employee-detail-leave-used').textContent = `${b.used_this_period}日(${b.taken_count_this_period}回)`;
      document.getElementById('employee-detail-leave-granted').textContent = b.granted_this_period != null ? `${b.granted_this_period}日` : '未設定';
      document.getElementById('employee-detail-leave-balance').textContent = b.remaining_this_period != null ? `${b.remaining_this_period}日` : '未設定';
      if (b.period_start) {
        const periodLabel = `${new Date(b.period_start).toLocaleDateString('ja-JP')}〜${new Date(b.period_end).toLocaleDateString('ja-JP')}`;
        document.getElementById('employee-detail-leave-period').textContent = b.has_active_period
          ? `対象期間: ${periodLabel}`
          : `対象期間(入社日基準の目安、付与未登録): ${periodLabel}`;
      } else {
        document.getElementById('employee-detail-leave-period').textContent = '対象期間: 不明(入社日・付与のいずれも未登録のため全期間の実績を表示)';
      }
    } else {
      document.getElementById('employee-detail-leave-used').textContent = '-';
      document.getElementById('employee-detail-leave-granted').textContent = '未設定';
      document.getElementById('employee-detail-leave-balance').textContent = '未設定';
      document.getElementById('employee-detail-leave-period').textContent = '今年度の付与がまだ登録されていません。';
    }

    const ledger = await rpc('admin_get_employee_leave_ledger', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    if (!ledger || ledger.length === 0) { listEl.innerHTML = '<div class="hint">付与・使用履歴はまだありません。</div>'; return; }
    listEl.innerHTML = ledger.map((tx) => `
      <div class="history-item">
        <div class="row1"><span>${LEAVE_TX_LABEL[tx.transaction_type] || tx.transaction_type}</span><span style="color:${tx.amount < 0 ? 'var(--danger)' : 'var(--primary)'};">${tx.amount > 0 ? '+' : ''}${tx.amount}日</span></div>
        <div class="row2">${new Date(tx.effective_date).toLocaleDateString('ja-JP')}${tx.note ? `・${tx.note}` : ''}</div>
        ${tx.can_cancel ? `<button type="button" class="link leave-cancel-btn" data-request-id="${tx.related_employee_request_id}">この有給を取消する</button>` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('.leave-cancel-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = prompt('取消理由を入力してください');
        if (!reason) return;
        try {
          await rpc('admin_cancel_paid_leave', { p_admin_employee_code: session.employeeCode, p_employee_request_id: Number(btn.dataset.requestId), p_reason: reason });
          await loadEmployeeDetailLeave();
        } catch (e) { alert(e.message || '取消に失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

let leaveGrantTargetCode = null;

function updateLeaveGrantStatutoryHint() {
  const hintEl = document.getElementById('leave-grant-statutory-hint');
  const hireDate = document.getElementById('leave-grant-target').dataset.hireDate;
  const schedule = document.getElementById('leave-grant-schedule').value;
  if (!hireDate) { hintEl.textContent = ''; return; }
  rpc('calc_statutory_leave_days', { p_hire_date: hireDate, p_schedule: schedule, p_as_of: todayJST() })
    .then((rows) => {
      const days = Array.isArray(rows) ? rows[0] : rows;
      hintEl.textContent = days != null ? `参考(法定最低基準): ${typeof days === 'object' ? days.calc_statutory_leave_days : days}日` : '入社日が未登録のため参考値を計算できません。';
    })
    .catch(() => { hintEl.textContent = ''; });
}

async function openLeaveGrant(code, name) {
  const session = getSession();
  leaveGrantTargetCode = code;
  const targetEl = document.getElementById('leave-grant-target');
  targetEl.textContent = `対象: ${name}さん(${code})`;
  targetEl.dataset.hireDate = '';
  document.getElementById('leave-grant-method').value = '';
  document.getElementById('leave-grant-schedule').value = 'full_time';
  document.getElementById('leave-grant-statutory-wrap').style.display = 'none';
  document.getElementById('leave-grant-statutory-hint').textContent = '';
  document.getElementById('leave-grant-amount').value = '';
  document.getElementById('leave-grant-date').value = todayJST();
  document.getElementById('leave-grant-period-start').value = todayJST();
  document.getElementById('leave-grant-period-end').value = '';
  document.getElementById('leave-grant-note').value = '';
  document.getElementById('leave-grant-manual-adjustment').checked = false;
  document.getElementById('leave-grant-adjustment-reason-wrap').style.display = 'none';
  document.getElementById('leave-grant-adjustment-reason').value = '';
  hideError('leave-grant-error');
  showScreen('leave-grant');
  try {
    const rows = await rpc('admin_get_employee_leave_policy', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    const p = rows && rows[0];
    if (p && p.hire_date) targetEl.dataset.hireDate = p.hire_date.slice(0, 10);
    if (p && p.grant_method) {
      document.getElementById('leave-grant-method').value = p.grant_method;
      document.getElementById('leave-grant-statutory-wrap').style.display = p.grant_method === 'legal_statutory' ? '' : 'none';
    }
    if (p && p.statutory_schedule) document.getElementById('leave-grant-schedule').value = p.statutory_schedule;
    updateLeaveGrantStatutoryHint();
  } catch (e) { /* 参考値が取れなくても付与自体は続行できる */ }
}

async function doSubmitLeaveGrant() {
  const session = getSession();
  const method = document.getElementById('leave-grant-method').value;
  const schedule = document.getElementById('leave-grant-schedule').value;
  const amount = Number(document.getElementById('leave-grant-amount').value);
  const date = document.getElementById('leave-grant-date').value;
  const periodStart = document.getElementById('leave-grant-period-start').value;
  const periodEnd = document.getElementById('leave-grant-period-end').value;
  const note = document.getElementById('leave-grant-note').value.trim() || null;
  const isManual = document.getElementById('leave-grant-manual-adjustment').checked;
  const adjustmentReason = document.getElementById('leave-grant-adjustment-reason').value.trim() || null;
  hideError('leave-grant-error');
  if (!method) { showError('leave-grant-error', '付与方式(法定基準/会社独自運用)を選択してください。'); return; }
  if (!amount || amount <= 0) { showError('leave-grant-error', '付与日数を入力してください。'); return; }
  if (!date) { showError('leave-grant-error', '付与日を入力してください。'); return; }
  if (!periodStart || !periodEnd) { showError('leave-grant-error', '対象期間(開始・終了)を入力してください。'); return; }
  if (isManual && !adjustmentReason) { showError('leave-grant-error', '手動調整の場合は調整理由を入力してください。'); return; }
  try {
    await rpc('admin_record_leave_grant', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: leaveGrantTargetCode,
      p_granted_days: amount, p_grant_date: date, p_grant_period_start: periodStart, p_grant_period_end: periodEnd,
      p_grant_method: method, p_grant_reason: note, p_is_manual_adjustment: isManual, p_adjustment_reason: adjustmentReason,
    });
    // 対象社員の有給管理方式もあわせて記録しておく(次回以降の付与画面で自動反映される)。
    await rpc('admin_set_employee_leave_policy', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: leaveGrantTargetCode,
      p_base_date: null, p_next_grant_date: null,
      p_grant_method: method, p_statutory_schedule: method === 'legal_statutory' ? schedule : null, p_company_custom_note: method === 'company_custom' ? note : null,
    }).catch(() => { /* ポリシー保存に失敗しても付与自体は成功しているため致命的ではない */ });
    showDone('有給を付与しました。', 'leave-admin');
  } catch (e) {
    showError('leave-grant-error', e.message || '付与に失敗しました。');
  }
}

function updateEmployeeDetailStatutoryHint() {
  const method = document.getElementById('employee-detail-leave-method').value;
  document.getElementById('employee-detail-leave-statutory-wrap').style.display = method === 'legal_statutory' ? '' : 'none';
  document.getElementById('employee-detail-leave-custom-wrap').style.display = method === 'company_custom' ? '' : 'none';
}

async function loadEmployeeDetailLeavePolicy() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  try {
    const rows = await rpc('admin_get_employee_leave_policy', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    const p = rows && rows[0];
    document.getElementById('employee-detail-leave-base-date').value = (p && p.base_date) ? p.base_date : '';
    document.getElementById('employee-detail-leave-next-grant').value = (p && p.next_grant_date) ? p.next_grant_date : '';
    document.getElementById('employee-detail-leave-policy-hint').textContent = p && p.is_estimate
      ? `次回付与予定日は未設定のため目安(入社日または直近付与実績から自動計算)を表示しています。入社日: ${p.hire_date ? new Date(p.hire_date).toLocaleDateString('ja-JP') : '未登録'}`
      : '次回付与予定日は管理者により設定済みです。';
    document.getElementById('employee-detail-leave-method').value = (p && p.grant_method) || '';
    document.getElementById('employee-detail-leave-schedule').value = (p && p.statutory_schedule) || 'full_time';
    document.getElementById('employee-detail-leave-custom-note').value = (p && p.company_custom_note) || '';
    updateEmployeeDetailStatutoryHint();
    document.getElementById('employee-detail-leave-statutory-hint').textContent = (p && p.statutory_reference_days != null)
      ? `参考(法定最低基準): ${p.statutory_reference_days}日` : '';
  } catch (e) { /* 無視 */ }
}

async function doSaveLeavePolicy() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  const method = document.getElementById('employee-detail-leave-method').value || null;
  try {
    await rpc('admin_set_employee_leave_policy', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: code,
      p_base_date: document.getElementById('employee-detail-leave-base-date').value || null,
      p_next_grant_date: document.getElementById('employee-detail-leave-next-grant').value || null,
      p_grant_method: method,
      p_statutory_schedule: method === 'legal_statutory' ? document.getElementById('employee-detail-leave-schedule').value : null,
      p_company_custom_note: method === 'company_custom' ? (document.getElementById('employee-detail-leave-custom-note').value.trim() || null) : null,
    });
    await loadEmployeeDetailLeavePolicy();
  } catch (e) { alert(e.message || '保存に失敗しました。'); }
}

const LEAVE_GRANT_METHOD_LABEL = { legal_statutory: '法定基準', company_custom: '会社独自運用' };

async function loadEmployeeDetailLeaveGrants() {
  const session = getSession();
  const code = currentEmployeeDetailCode;
  const listEl = document.getElementById('employee-detail-leave-grants');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_employee_leave_grants', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">付与記録はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((g) => `
      <div class="history-item">
        <div class="row1">
          <span>${LEAVE_GRANT_METHOD_LABEL[g.grant_method] || g.grant_method}${g.is_manual_adjustment ? '(手動調整)' : ''}${g.superseded_at ? ' <span class="mini-tag danger">訂正済み</span>' : ''}</span>
          <span>${g.granted_days}日</span>
        </div>
        <div class="row2">対象期間 ${new Date(g.grant_period_start).toLocaleDateString('ja-JP')}〜${new Date(g.grant_period_end).toLocaleDateString('ja-JP')}・付与日${new Date(g.grant_date).toLocaleDateString('ja-JP')}${g.grant_reason ? `・${g.grant_reason}` : ''}</div>
        <div class="row2">記録者: ${g.created_by}(${new Date(g.created_at).toLocaleDateString('ja-JP')})${g.superseded_at ? `・訂正: ${g.superseded_by}「${g.superseded_reason}」` : ''}</div>
        ${!g.superseded_at ? `<button type="button" class="link leave-grant-supersede-btn" data-grant-id="${g.id}">この付与記録を訂正する</button>` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('.leave-grant-supersede-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = prompt('訂正理由を入力してください(元の記録は削除されず、訂正済みとして残ります)');
        if (!reason) return;
        try {
          await rpc('admin_supersede_leave_grant', { p_admin_employee_code: session.employeeCode, p_grant_id: Number(btn.dataset.grantId), p_reason: reason });
          await loadEmployeeDetailLeave();
          await loadEmployeeDetailLeaveGrants();
        } catch (e) { alert(e.message || '訂正に失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 有給管理(管理者、全社員比較) ----------

async function loadLeaveAdmin() {
  const session = getSession();
  const search = document.getElementById('la-search').value.trim();
  const listEl = document.getElementById('la-list');
  const tbodyEl = document.getElementById('la-table-body');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  tbodyEl.innerHTML = '';
  try {
    const rows = await rpc('admin_list_leave_summary', { p_admin_employee_code: session.employeeCode, p_search: search || null });
    document.getElementById('la-count').textContent = `${rows.length}名`;
    if (rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する社員がいません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="admin-result-item la-row" data-code="${r.employee_code}" data-name="${r.employee_name}">
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span>${r.current_balance}日</span></div>
        <div class="row2">${r.policy_is_set ? LEAVE_GRANT_METHOD_LABEL[r.grant_method] || r.grant_method : '<span class="mini-tag danger">方式未設定</span>'}・付与累計${r.granted_total}日・使用累計${r.used_total}日・次回付与目安${r.next_grant_estimate ? new Date(r.next_grant_estimate).toLocaleDateString('ja-JP') : '-'}</div>
      </div>
    `).join('');
    tbodyEl.innerHTML = rows.map((r) => `
      <tr class="la-row" data-code="${r.employee_code}" data-name="${r.employee_name}">
        <td>${r.employee_code}</td><td>${r.employee_name}</td>
        <td>${r.policy_is_set ? (LEAVE_GRANT_METHOD_LABEL[r.grant_method] || r.grant_method) : '<span class="mini-tag danger">未設定</span>'}</td>
        <td>${r.current_balance}日</td>
        <td>${r.granted_total}日</td><td>${r.used_total}日</td>
        <td>${r.next_grant_estimate ? new Date(r.next_grant_estimate).toLocaleDateString('ja-JP') : '-'}</td>
        <td><button type="button" class="return-btn la-grant-btn" data-code="${r.employee_code}" data-name="${r.employee_name}">付与</button></td>
      </tr>
    `).join('');
    document.querySelectorAll('.la-grant-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openLeaveGrant(btn.dataset.code, btn.dataset.name); });
    });
    document.querySelectorAll('.la-row').forEach((el) => {
      el.addEventListener('click', () => openEmployeeDetail(el.dataset.code, 'leave'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 社員別集計(管理者、月次で全社員比較) ----------

async function loadEmployeeSummary() {
  const session = getSession();
  const monthInput = document.getElementById('es-month').value;
  if (!monthInput) return;
  const [year, month] = monthInput.split('-').map(Number);
  const listEl = document.getElementById('es-list');
  const tbodyEl = document.getElementById('es-table-body');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  tbodyEl.innerHTML = '';
  try {
    const rows = await rpc('admin_get_employee_monthly_summary', { p_admin_employee_code: session.employeeCode, p_year: year, p_month: month });
    document.getElementById('es-count').textContent = `${rows.length}名(${year}年${month}月)`;
    const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
    if (rows.length === 0) { listEl.innerHTML = '<div class="hint">対象の社員がいません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="admin-result-item es-row" data-code="${r.employee_code}">
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span>支払待ち${yen(r.unpaid_amount)}</span></div>
        <div class="row2">申請総額${yen(r.expense_advance_amount)}(承認${yen(r.approved_total)}・却下${yen(r.rejected_total)})・会社経費${yen(r.company_expense_amount)}・支払済${yen(r.paid_amount)}</div>
        ${Number(r.receipt_pending_amount) > 0 ? `<div class="row2">受取確認待ち${yen(r.receipt_pending_amount)}</div>` : ''}
        <div class="row2">有給付与${r.leave_granted}日・使用${r.leave_used}日・残${r.leave_balance}日・その他申請${r.other_request_count}件</div>
      </div>
    `).join('');
    tbodyEl.innerHTML = rows.map((r) => `
      <tr class="es-row" data-code="${r.employee_code}">
        <td>${r.employee_code}</td><td>${r.employee_name}</td>
        <td>${yen(r.expense_advance_amount)}</td><td>${yen(r.approved_total)}</td><td>${yen(r.rejected_total)}</td>
        <td>${yen(r.company_expense_amount)}</td><td>${yen(r.paid_amount)}</td><td>${yen(r.unpaid_amount)}</td>
        <td>${yen(r.receipt_pending_amount)}</td>
        <td>${r.leave_granted}日</td><td>${r.leave_used}日</td><td>${r.leave_balance}日</td>
        <td>${r.other_request_count}件</td>
      </tr>
    `).join('');
    document.querySelectorAll('.es-row').forEach((el) => {
      el.addEventListener('click', () => {
        const r = rows.find((x) => x.employee_code === el.dataset.code);
        openEmployeeMonthlyDetail(el.dataset.code, r ? r.employee_name : '', year, month);
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 社員個人詳細(社員別集計のドリルダウン) ----------

let emdContext = null; // { code, name, year, month } (支払登録画面から戻る際の再読み込み用)

async function openEmployeeMonthlyDetail(code, name, year, month) {
  const session = getSession();
  emdContext = { code, name, year, month };
  showScreen('employee-monthly-detail');
  document.getElementById('emd-title').textContent = `${name}さん(${code}) ${year}年${month}月`;
  const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
  ['emd-advance-list', 'emd-company-list', 'emd-leave-list', 'emd-other-list', 'emd-site-list'].forEach((id) => {
    document.getElementById(id).innerHTML = '<div class="hint">読み込み中...</div>';
  });
  document.getElementById('emd-approved').textContent = '-';
  document.getElementById('emd-rejected').textContent = '-';
  document.getElementById('emd-unpaid').textContent = '-';
  document.getElementById('emd-paid').textContent = '-';
  document.getElementById('emd-leave-balance').textContent = '-';
  document.getElementById('emd-headcount').textContent = '-';

  const PAY_LABEL = { not_started: '未着手', waiting_payment: '支払待ち', paid: '支払済' };
  const REQ_STATUS_BADGE = { rejected: '却下', cancelled: '取消' };

  try {
    const [expenseRows, ledgerRows, siteRows, otherRows] = await Promise.all([
      rpc('admin_get_employee_expense_detail', { p_admin_employee_code: session.employeeCode, p_year: year, p_month: month, p_target_employee_code: code }),
      rpc('admin_get_employee_leave_ledger', { p_admin_employee_code: session.employeeCode, p_target_employee_code: code }),
      rpc('admin_get_employee_attendance_by_site', { p_admin_employee_code: session.employeeCode, p_year: year, p_month: month, p_employee_code: code }),
      rpc('admin_search_requests', { p_admin_employee_code: session.employeeCode, p_employee_code: code, p_date_from: `${year}-${String(month).padStart(2, '0')}-01`, p_date_to: new Date(year, month, 0).toISOString().slice(0, 10) }),
    ]);

    const advance = expenseRows.filter((r) => r.expense_category === 'employee_advance');
    const company = expenseRows.filter((r) => r.expense_category === 'company_expense');
    // 未払い/支払済みは「却下・取消された申請」を対象外にする(却下された申請は未払いに残さない)。
    const liveAdvance = advance.filter((r) => r.request_status !== 'rejected' && r.request_status !== 'cancelled');
    const rejectedTotal = advance.filter((r) => r.request_status === 'rejected').reduce((s, r) => s + Number(r.amount || 0), 0);
    const approvedTotal = liveAdvance.reduce((s, r) => s + Number(r.amount || 0), 0);
    const unpaid = liveAdvance.filter((r) => r.payment_status !== 'paid').reduce((s, r) => s + Number(r.amount || 0), 0);
    const paid = liveAdvance.filter((r) => r.payment_status === 'paid').reduce((s, r) => s + Number(r.amount || 0), 0);
    document.getElementById('emd-approved').textContent = yen(approvedTotal);
    document.getElementById('emd-rejected').textContent = yen(rejectedTotal);
    document.getElementById('emd-unpaid').textContent = yen(unpaid);
    document.getElementById('emd-paid').textContent = yen(paid);

    // 支払登録ボタンは1申請(request_id)につき1つだけ出す(複数明細の申請でも重複させない)。
    const paymentButtonShownFor = new Set();
    const expenseRow = (r, isAdvance) => {
      const badge = REQ_STATUS_BADGE[r.request_status];
      const canPay = isAdvance && !badge && r.payment_status !== 'paid';
      let payBtn = '';
      if (canPay && !paymentButtonShownFor.has(r.request_id)) {
        paymentButtonShownFor.add(r.request_id);
        payBtn = `<button type="button" class="secondary emd-pay-btn" data-request-id="${r.request_id}" style="margin-top:6px;">支払を登録する</button>`;
      }
      return `
      <div class="history-item">
        <div class="row1"><span>${r.vendor_name}</span><span>${yen(r.amount)}</span></div>
        <div class="row2">${r.site_name || '-'}・${r.purpose_category || '-'}・${isAdvance ? (PAY_LABEL[r.payment_status] || r.payment_status) : '会社経費(立替なし)'}${badge ? `・<span class="status-badge rejected">${badge}</span>` : ''}</div>
        <div class="row2">${r.document_date || ''}${r.rejection_reason ? `・却下理由: ${r.rejection_reason}` : ''}</div>
        ${r.document_id ? `<img class="secure-proxy-thumb emd-receipt-thumb" data-secure-kind="receipt" data-secure-id="${r.document_id}" data-doc-id="${r.document_id}" alt="領収書" loading="lazy">` : ''}
        ${payBtn}
      </div>
    `;
    };
    // この月の領収書(document_idつき)を1つのギャラリーへまとめる。
    const monthReceipts = [...advance, ...company].filter((r) => r.document_id).map((r) => ({ document_id: r.document_id, vendor_name: r.vendor_name, amount: r.amount, document_date: r.document_date, purpose_category: r.purpose_category, expense_category: r.expense_category, site_name: r.site_name }));
    const galleryBtnHtml = monthReceipts.length > 0
      ? `<button type="button" class="secondary" id="emd-receipt-gallery-btn" style="margin-bottom:10px;">📷 この月の領収書をまとめて見る(${monthReceipts.length}枚)</button>` : '';
    document.getElementById('emd-advance-list').innerHTML = galleryBtnHtml + (advance.length === 0 ? '<div class="hint">この月の経費立替はありません。</div>' : advance.map((r) => expenseRow(r, true)).join(''));
    document.getElementById('emd-company-list').innerHTML = company.length === 0 ? '<div class="hint">この月の会社経費はありません。</div>' : company.map((r) => expenseRow(r, false)).join('');
    const galleryBtn = document.getElementById('emd-receipt-gallery-btn');
    if (galleryBtn) galleryBtn.addEventListener('click', () => openReceiptGallery(monthReceipts, 0));
    // 各行のサムネイルはプロキシで読み込み、タップでその位置からギャラリーを開く。
    hydrateSecureImages(document.getElementById('emd-advance-list'));
    hydrateSecureImages(document.getElementById('emd-company-list'));
    document.querySelectorAll('.emd-receipt-thumb').forEach((img) => {
      img.addEventListener('click', (e) => { e.stopPropagation(); const idx = monthReceipts.findIndex((x) => String(x.document_id) === String(img.dataset.docId)); openReceiptGallery(monthReceipts, idx < 0 ? 0 : idx); }, true);
    });

    document.querySelectorAll('.emd-pay-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openExpensePayment(btn.dataset.requestId, name, code);
      });
    });

    const currentBalance = ledgerRows.reduce((s, tx) => s + Number(tx.amount || 0), 0);
    document.getElementById('emd-leave-balance').textContent = `${currentBalance}日`;
    const monthLedger = ledgerRows.filter((tx) => tx.effective_date && tx.effective_date.slice(0, 7) === `${year}-${String(month).padStart(2, '0')}`);
    document.getElementById('emd-leave-list').innerHTML = monthLedger.length === 0 ? '<div class="hint">この月の有給の動きはありません。</div>' : monthLedger.map((tx) => `
      <div class="history-item"><div class="row1"><span>${LEAVE_TX_LABEL[tx.transaction_type] || tx.transaction_type}</span><span>${tx.amount > 0 ? '+' : ''}${tx.amount}日</span></div>
      <div class="row2">${new Date(tx.effective_date).toLocaleDateString('ja-JP')}${tx.note ? `・${tx.note}` : ''}</div></div>
    `).join('');

    const other = otherRows.filter((r) => r.source_type !== 'expense_reimbursement' && r.source_type !== 'paid_leave');
    document.getElementById('emd-other-list').innerHTML = other.length === 0 ? '<div class="hint">この月のその他申請はありません。</div>' : other.map((r) => `
      <div class="history-item"><div class="row1"><span>${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}</span><span class="status-badge">${STATUS_GROUP_LABEL[r.status_group] || r.status_group}</span></div>
      <div class="row2">${r.summary || ''}</div></div>
    `).join('');

    const headcountTotal = siteRows.reduce((s, r) => s + Number(r.total_headcount || 0), 0);
    document.getElementById('emd-headcount').textContent = `${headcountTotal}人工`;
    document.getElementById('emd-site-list').innerHTML = siteRows.length === 0 ? '<div class="hint">この月の日報はありません。</div>' : siteRows.map((r) => `
      <div class="history-item"><div class="row1"><span>${r.site_name}</span><span>${r.total_headcount}人工</span></div></div>
    `).join('');
  } catch (e) {
    document.getElementById('emd-advance-list').innerHTML = `<div class="hint">読み込みに失敗しました: ${e.message}</div>`;
  }
}

// ---------- 経費支払登録 ----------

let expensePaymentTarget = null; // { requestId, employeeName, employeeCode }

async function openExpensePayment(requestId, employeeName, employeeCode) {
  const session = getSession();
  expensePaymentTarget = { requestId, employeeName, employeeCode };
  showScreen('expense-payment');
  document.getElementById('ep-target').textContent = `対象: ${employeeName}さん(${employeeCode})`;
  document.getElementById('ep-total').textContent = '-';
  document.getElementById('ep-remaining').textContent = '-';
  document.getElementById('ep-amount').value = '';
  document.getElementById('ep-date').value = todayJST();
  document.getElementById('ep-method').value = '';
  document.getElementById('ep-note').value = '';
  hideError('ep-error');
  const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
  try {
    const rows = await rpc('admin_get_expense_payment_status', { p_admin_employee_code: session.employeeCode, p_employee_request_id: Number(requestId) });
    const s = rows && rows[0];
    if (s) {
      document.getElementById('ep-total').textContent = yen(s.total_amount);
      document.getElementById('ep-remaining').textContent = yen(s.remaining_amount);
      document.getElementById('ep-amount').value = s.remaining_amount;
      document.getElementById('ep-amount').max = s.remaining_amount;
    }
  } catch (e) {
    showError('ep-error', e.message || '状態の取得に失敗しました。');
  }
  loadExpensePaymentSchedule(requestId);
}

// 精算予定日の現在値を表示する(承認済み→精算予定→精算完了の状態)。
async function loadExpensePaymentSchedule(requestId) {
  const session = getSession();
  const el = document.getElementById('ep-schedule-current');
  if (!el) return;
  try {
    const rows = await rpc('admin_get_expense_payment_schedule', { p_admin_employee_code: session.employeeCode, p_employee_request_id: Number(requestId) });
    const s = rows && rows[0];
    if (!s) { el.textContent = ''; return; }
    if (s.payment_status === 'paid') {
      el.innerHTML = `<span class="status-badge done">精算完了${s.paid_at ? '（' + new Date(s.paid_at).toLocaleDateString('ja-JP') + '）' : ''}</span>`;
    } else if (s.scheduled_payment_date) {
      el.innerHTML = `現在の精算予定日: <strong>${new Date(s.scheduled_payment_date).toLocaleDateString('ja-JP')}</strong>`;
      document.getElementById('ep-schedule-date').value = String(s.scheduled_payment_date).slice(0, 10);
    } else {
      el.textContent = '精算予定日は未設定です。';
    }
  } catch (e) { el.textContent = ''; }
}

async function doSubmitExpensePayment() {
  const session = getSession();
  if (!expensePaymentTarget) return;
  const amount = Number(document.getElementById('ep-amount').value);
  const date = document.getElementById('ep-date').value;
  const method = document.getElementById('ep-method').value || null;
  const note = document.getElementById('ep-note').value.trim() || null;
  hideError('ep-error');
  if (!amount || amount <= 0) { showError('ep-error', '支払金額を入力してください。'); return; }
  if (!date) { showError('ep-error', '支払日を入力してください。'); return; }
  const btn = document.getElementById('ep-submit');
  btn.disabled = true;
  try {
    await rpc('admin_register_expense_payment', {
      p_admin_employee_code: session.employeeCode, p_employee_request_id: Number(expensePaymentTarget.requestId),
      p_paid_amount: amount, p_paid_at: date, p_payment_method: method, p_note: note,
    });
    // 「完了」画面を挟まず、社員個人詳細へ直接戻って再読み込みする(支払済み/未払いの
    // 数字が変わったこと自体が完了の確認になる)。showDoneのdata-nav+SCREEN_ENTER_HOOKSの
    // 組み合わせだと、このコンテキスト付き再読み込みをフックに登録した場合、
    // openEmployeeMonthlyDetail自身がshowScreen('employee-monthly-detail')を呼ぶため
    // 再度フックが発火して無限ループになるため使わない。
    if (emdContext) await openEmployeeMonthlyDetail(emdContext.code, emdContext.name, emdContext.year, emdContext.month);
    else showScreen('employee-summary');
  } catch (e) {
    showError('ep-error', e.message || '登録に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 出面集計(管理者、社員別/外注会社別/現場別マトリクス、月次/年間) ----------

let attendanceView = 'employee';
let attendancePeriod = 'month'; // 'month' | 'year'
let attendanceSiteFilter = '';
let attendanceEmployeeFilter = '';
let attendanceCompanyFilter = '';

function currentAttendanceMonth() {
  const v = document.getElementById('am-month').value;
  if (!v) return null;
  const [year, month] = v.split('-').map(Number);
  return { year, month };
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

async function loadAttendanceFilterOptions() {
  const session = getSession();
  const ym = currentAttendanceMonth();
  try {
    if (ym) {
      const rows = await rpc('admin_list_attendance_filter_options', { p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month });
      const opts = (rows && rows[0]) || { sites: [], subcontractor_companies: [] };
      const siteSelect = document.getElementById('am-site-filter');
      const current = siteSelect.value;
      siteSelect.innerHTML = '<option value="">すべての現場</option>' + (opts.sites || []).map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
      siteSelect.value = current;
    }
    if (!document.getElementById('am-employee-filter').dataset.loaded) {
      const emps = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
      document.getElementById('am-employee-filter').innerHTML = '<option value="">すべての社員</option>' + emps.map((e) => `<option value="${e.employee_code}">${e.employee_name}</option>`).join('');
      document.getElementById('am-employee-filter').dataset.loaded = '1';
    }
    if (!document.getElementById('am-company-filter').dataset.loaded) {
      const companies = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: false });
      document.getElementById('am-company-filter').innerHTML = '<option value="">すべての外注会社</option>' + companies.map((c) => `<option value="${c.id}">${c.company_name}</option>`).join('');
      document.getElementById('am-company-filter').dataset.loaded = '1';
    }
  } catch (e) { /* 無視 */ }
}

function attendanceViewLabel() {
  return attendanceView === 'employee' ? '社員' : (attendanceView === 'subcontractor_company' ? '外注会社' : '現場');
}

// 表示切替(社員別/外注会社別/現場別)やフィルターを素早く連続操作すると、後から出した
// リクエストより先に古いリクエストの応答が返ってきて、新しい表示を古い結果で
// 上書きしてしまう競合が起きうる(実機テストで再現した)。呼び出しごとに世代番号を
// 発行し、応答が返ってきた時点で最新の呼び出しでなければ描画しない。
let attendanceMatrixRequestSeq = 0;

// 「対象月」を< 2026年8月 >のようなナビゲーション表示にする(集計ロジック自体は
// 変更せず、既存の#am-month(type=month)の値をそのまま使う。見た目だけの変更)。
function updateAmMonthDisplay() {
  const v = document.getElementById('am-month').value;
  if (!v) return;
  const [y, m] = v.split('-').map(Number);
  document.getElementById('am-month-display').textContent = `${y}年${m}月`;
}
function shiftAmMonth(delta) {
  const input = document.getElementById('am-month');
  const [y, m] = (input.value || todayJST().slice(0, 7)).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  input.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  input.dispatchEvent(new Event('change'));
}

async function loadAttendanceMatrix() {
  const session = getSession();
  const mySeq = ++attendanceMatrixRequestSeq;
  const wrapEl = document.getElementById('am-matrix-wrap');
  const filterParams = {
    p_site_id: attendanceSiteFilter ? Number(attendanceSiteFilter) : null,
    p_employee_code: attendanceEmployeeFilter || null,
    p_subcontractor_company_id: attendanceCompanyFilter ? Number(attendanceCompanyFilter) : null,
  };
  wrapEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    let rows; let colCount; let colLabel; let periodLabel;
    if (attendancePeriod === 'month') {
      const ym = currentAttendanceMonth();
      if (!ym) return;
      rows = await rpc('admin_get_attendance_matrix', { p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month, p_view: attendanceView, ...filterParams });
      colCount = daysInMonth(ym.year, ym.month);
      colLabel = (i) => `${i}`;
      periodLabel = `${ym.year}年${ym.month}月`;
    } else {
      const year = Number(document.getElementById('am-year').value) || new Date().getFullYear();
      rows = await rpc('admin_get_attendance_matrix_yearly', { p_admin_employee_code: session.employeeCode, p_year: year, p_view: attendanceView, ...filterParams });
      colCount = 12;
      colLabel = (i) => `${i}月`;
      periodLabel = `${year}年`;
    }
    if (mySeq !== attendanceMatrixRequestSeq) return; // より新しいリクエストが既に発行されている
    document.getElementById('am-hint').textContent = `${rows.length}件(${periodLabel})。${attendancePeriod === 'month' ? 'セルをタップするとその日の内訳、行をタップするとその期間の内訳を確認できます。' : '行をタップすると年間の内訳を確認できます。'}`;
    if (rows.length === 0) { wrapEl.innerHTML = '<div class="hint">この期間の出面データはありません。</div>'; return; }

    let headers = '';
    for (let i = 1; i <= colCount; i++) headers += `<th>${colLabel(i)}</th>`;
    const bodyRows = rows.map((r) => {
      let cells = '';
      for (let i = 1; i <= colCount; i++) {
        const key = attendancePeriod === 'month' ? String(i) : String(i);
        const v = (attendancePeriod === 'month' ? r.daily : r.monthly)[key];
        cells += v
          ? `<td class="am-cell-value" data-col="${i}" data-group-id="${r.group_id}" data-group-label="${r.group_label}">${v}</td>`
          : '<td class="am-cell-empty">-</td>';
      }
      const total = attendancePeriod === 'month' ? r.month_total : r.year_total;
      return `<tr class="am-row-clickable" data-group-id="${r.group_id}" data-group-label="${r.group_label}">
        <td>${r.group_label}</td>${cells}<td class="am-total-col">${total}</td>
      </tr>`;
    }).join('');
    const colTotals = [];
    for (let i = 1; i <= colCount; i++) {
      const key = String(i);
      colTotals.push(rows.reduce((sum, r) => sum + (Number((attendancePeriod === 'month' ? r.daily : r.monthly)[key]) || 0), 0));
    }
    const grandTotal = rows.reduce((sum, r) => sum + Number((attendancePeriod === 'month' ? r.month_total : r.year_total) || 0), 0);
    const totalRow = `<tr><td>合計</td>${colTotals.map((t) => `<td class="am-total-col">${t ? t : '-'}</td>`).join('')}<td class="am-total-col">${grandTotal}</td></tr>`;

    wrapEl.innerHTML = `
      <table class="attendance-matrix-table">
        <thead><tr><th>${attendanceViewLabel()}</th>${headers}<th>${attendancePeriod === 'month' ? '月合計' : '年合計'}</th></tr></thead>
        <tbody>${bodyRows}${totalRow}</tbody>
      </table>
    `;
    if (attendancePeriod === 'month') {
      wrapEl.querySelectorAll('.am-cell-value').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openAttendanceCellDetail(Number(el.dataset.col), el.dataset.groupId, el.dataset.groupLabel);
        });
      });
    }
    wrapEl.querySelectorAll('.am-row-clickable').forEach((el) => {
      el.addEventListener('click', () => openAttendanceDetail(el.dataset.groupId, el.dataset.groupLabel));
    });
  } catch (e) {
    if (mySeq === attendanceMatrixRequestSeq) wrapEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openAttendanceCellDetail(day, groupId, groupLabel) {
  const session = getSession();
  const ym = currentAttendanceMonth();
  showScreen('attendance-cell-detail');
  const dateLabel = `${ym.year}年${ym.month}月${day}日`;
  document.getElementById('acd-title').textContent = `${dateLabel} ${groupLabel}`;
  const listEl = document.getElementById('acd-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_attendance_cell_detail', { p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month, p_day: day, p_view: attendanceView, p_group_id: String(groupId) });
    const total = rows.reduce((sum, r) => sum + Number(r.headcount || 0), 0);
    const catLabel = { employee: '社員', subcontractor: '外注会社', site: '現場' };
    listEl.innerHTML = (rows.length === 0 ? '<div class="hint">データがありません。</div>' : rows.map((r) => `
      <div class="history-item"><div class="row1"><span>${catLabel[r.category] || r.category} ${r.label}</span><span>${r.headcount}人工</span></div></div>
    `).join('')) + `<div class="history-item"><div class="row1"><span><strong>合計</strong></span><span><strong>${total}人工</strong></span></div></div>`;
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openAttendanceDetail(groupId, groupLabel) {
  const session = getSession();
  const periodLabel = attendancePeriod === 'month' ? (() => { const ym = currentAttendanceMonth(); return `${ym.year}年${ym.month}月`; })() : `${document.getElementById('am-year').value}年`;
  showScreen('attendance-detail');
  const listEl = document.getElementById('ad-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  if (attendancePeriod === 'year') {
    document.getElementById('ad-title').textContent = `${groupLabel}(${periodLabel})`;
    listEl.innerHTML = '<div class="hint">年間表示の詳細内訳はマトリクス表(月別)をご確認ください。特定の日の内訳は月次表示に切り替えてセルをタップしてください。</div>';
    return;
  }
  const ym = currentAttendanceMonth();
  try {
    if (attendanceView === 'employee') {
      document.getElementById('ad-title').textContent = `${groupLabel}さんの現場別内訳(${ym.year}年${ym.month}月)`;
      const rows = await rpc('admin_get_employee_attendance_by_site', { p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month, p_employee_code: groupId });
      listEl.innerHTML = rows.length === 0 ? '<div class="hint">データがありません。</div>' : rows.map((r) => `
        <div class="history-item"><div class="row1"><span>${r.site_name}</span><span>${r.total_headcount}人工</span></div></div>
      `).join('');
    } else {
      document.getElementById('ad-title').textContent = `${groupLabel}の内訳(${ym.year}年${ym.month}月)`;
      if (attendanceView === 'site') {
        const rows = await rpc('admin_get_site_attendance_detail', { p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month, p_site_id: Number(groupId) });
        const total = rows.reduce((sum, r) => sum + Number(r.total_headcount || 0), 0);
        listEl.innerHTML = (rows.length === 0 ? '<div class="hint">データがありません。</div>' : rows.map((r) => `
          <div class="history-item"><div class="row1"><span>${r.worker_label}</span><span>${r.total_headcount}人工</span></div><div class="row2">${r.worker_type === 'employee' ? '社員' : '外注会社'}</div></div>
        `).join('')) + `<div class="history-item"><div class="row1"><span><strong>総人工</strong></span><span><strong>${total}人工</strong></span></div></div>`;
      } else {
        listEl.innerHTML = '<div class="hint">外注会社別ビューの月内訳はマトリクス表(日別)をご確認ください。現場ごとの内訳は「現場別」表示から確認できます。</div>';
      }
    }
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailQual() {
  const session = getSession();
  const listEl = document.getElementById('employee-detail-qual-list');
  const healthArea = document.getElementById('employee-detail-health-summary');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  healthArea.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const healthRows = await rpc('admin_get_employee_health_summary', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    const h = healthRows && healthRows[0];
    healthArea.innerHTML = `
      <div class="health-summary-card">
        <div class="row"><span class="label">最終受診日</span><span>${h && h.last_checkup_date ? new Date(h.last_checkup_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        <div class="row"><span class="label">次回予定</span><span>${h && h.next_due_date ? new Date(h.next_due_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        ${h && h.is_overdue ? '<div class="row"><span class="label">状態</span><span style="color:var(--danger); font-weight:700;">期限超過</span></div>' : ''}
        ${h && h.needs_retest ? '<div class="row"><span class="label">状態</span><span style="color:var(--warn); font-weight:700;">再検査確認待ち</span></div>' : ''}
      </div>
    `;

    const nameRows = await rpc('admin_get_employee_profile', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    const targetName = nameRows && nameRows[0] && nameRows[0].employee_name;
    const rows = await rpc('admin_list_qualifications', { p_admin_employee_code: session.employeeCode, p_filter: null, p_category: null });
    const mine = (rows || []).filter((q) => q.employee_name === targetName);
    if (mine.length === 0) { listEl.innerHTML = '<div class="hint">登録された資格・免許はありません。</div>'; return; }
    listEl.innerHTML = mine.map((q) => `
      <div class="qual-item">
        <div class="row1"><span>${q.category === 'license' ? '<span class="mini-tag info">免許</span> ' : ''}${q.qualification_name}</span><span class="status-badge ${q.status === 'active' ? 'done' : (q.status === 'rejected' ? 'rejected' : '')}">${QUAL_STATUS_LABEL[q.status] || q.status}</span></div>
        <div class="row2">${q.expiry_date ? `有効期限: ${new Date(q.expiry_date).toLocaleDateString('ja-JP')}${q.days_until_expiry != null ? `(残り${q.days_until_expiry}日)` : ''}` : '期限未登録'}</div>
        ${secureFileBlockHtml('qualification_photo', 'qualification_pdf', q.id, !!q.certificate_photo_url, !!q.certificate_pdf_url)}
      </div>
    `).join('');
    hydrateSecureImages(listEl);
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailSupplyHoldings() {
  const session = getSession();
  const el = document.getElementById('employee-detail-supply-holdings');
  const sel = document.getElementById('ed-supply-correction-item');
  el.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_employee_supply_holdings', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    el.innerHTML = (!rows || rows.length === 0) ? '<div class="hint">現在保有している品目はありません。</div>' : rows.map((r) => `
      <div class="supply-item">
        <div class="row1"><span>${r.item_name}${r.size ? `(${r.size})` : ''}</span><span>${r.current_quantity}個</span></div>
      </div>
    `).join('');
    const masterRows = await rpc('admin_list_supply_master', { p_admin_employee_code: session.employeeCode }).catch(() => []);
    sel.innerHTML = masterRows.filter((m) => m.active).map((m) => `<option value="${m.id}">${m.item_name}</option>`).join('');
  } catch (e) {
    el.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

const SUPPLY_CORRECTION_SOURCE_LABEL = { initial_holding: '初期登録', additional: '追加支給(記録漏れ分)', loss: '紛失', return: '返却', exchange: '交換', issuance: '支給(申請承認)' };

async function doRecordSupplyCorrection() {
  const session = getSession();
  const masterItemId = Number(document.getElementById('ed-supply-correction-item').value);
  const sourceType = document.getElementById('ed-supply-correction-type').value;
  const size = document.getElementById('ed-supply-correction-size').value.trim();
  const qty = Number(document.getElementById('ed-supply-correction-qty').value);
  const reason = document.getElementById('ed-supply-correction-reason').value.trim();
  hideError('ed-supply-correction-error');
  if (!masterItemId) { showError('ed-supply-correction-error', '品目を選択してください。'); return; }
  if (!qty || qty <= 0) { showError('ed-supply-correction-error', '数量を1以上で入力してください。'); return; }
  if (!reason) { showError('ed-supply-correction-error', '理由を入力してください。'); return; }
  try {
    await rpc('admin_record_supply_correction', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode,
      p_master_item_id: masterItemId, p_source_type: sourceType, p_quantity: qty, p_size: size || null, p_reason: reason,
    });
    document.getElementById('ed-supply-correction-qty').value = '';
    document.getElementById('ed-supply-correction-size').value = '';
    document.getElementById('ed-supply-correction-reason').value = '';
    await loadEmployeeDetailSupplyHoldings();
    await loadEmployeeDetailSupply();
  } catch (e) {
    showError('ed-supply-correction-error', e.message || '記録に失敗しました。');
  }
}

async function loadEmployeeDetailSupply() {
  const session = getSession();
  loadEmployeeDetailSupplyHoldings();
  const listEl = document.getElementById('employee-detail-supply-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_supply_admin_list', { p_admin_employee_code: session.employeeCode, p_employee_code: currentEmployeeDetailCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">支給履歴はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="supply-item">
        <div class="row1"><span>${r.item_name}</span><span>${r.quantity}個</span></div>
        <div class="row2">支給日: ${r.issued_date}${r.size ? `・サイズ${r.size}` : ''}${r.condition === 'used' ? '・中古' : '・新品'}</div>
        <div class="elapsed">経過${formatElapsed(r.elapsed_days)}${r.needs_return ? (r.returned_date ? `・返却済(${r.returned_date})` : '・未返却') : ''}</div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadEmployeeDetailRequests() {
  const session = getSession();
  const listEl = document.getElementById('employee-detail-requests-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_employee_requests', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">申請履歴はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => {
      const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
      const statusClass = r.status_group === 'approved' ? 'done' : (r.status_group === 'rejected' ? 'rejected' : '');
      const approverLine = r.approver_name
        ? `<div class="row2">承認者: ${r.approver_name}・${r.decided_at ? new Date(r.decided_at).toLocaleString('ja-JP') : ''}</div>`
        : (['approved', 'rejected'].includes(r.status_group) ? '<div class="row2">承認者記録なし(旧データ)</div>' : '');
      return `
        <div class="history-item">
          <div class="row1"><span>${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}</span><span>${amountStr}</span></div>
          <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
          ${approverLine}
          <span class="status-badge ${statusClass}">${STATUS_LABEL[r.status] || STATUS_GROUP_LABEL[r.status_group] || r.status}</span>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function openEmployeeEditBasic() {
  document.getElementById('employee-edit-furigana').value = '';
  document.getElementById('employee-edit-birth').value = '';
  document.getElementById('employee-edit-department').value = '';
  document.getElementById('employee-edit-headcount-category').value = '';
  hideError('employee-edit-error');
  showScreen('employee-edit-basic');
  // 現在値の読み込み完了までは保存ボタンを無効化する。以前ここが無防備だったため、
  // 読み込み完了前(チェックボックスがまだ画面初期状態のまま)に保存を押すと、
  // 日報権限フラグ等が意図せずfalseで上書きされてしまう不具合を実際に踏んだ
  // (社員0001の通勤早出/残業等の表示対象フラグが誤って全消去された)。
  const submitBtn = document.getElementById('employee-edit-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = '読み込み中...';
  // 日報の対象者フラグは現在値を読み込んでチェック状態を反映する(社員詳細の
  // admin_get_employee_profileと同じデータをここでも取得する)。
  try {
    const session = getSession();
    const rows = await rpc('admin_get_employee_profile', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
    const p = rows && rows[0];
    if (p) {
      document.getElementById('employee-edit-furigana').value = p.furigana || '';
      document.getElementById('employee-edit-birth').value = p.birth_date ? p.birth_date.slice(0, 10) : '';
      document.getElementById('employee-edit-show-birthday').checked = p.show_birthday_on_calendar !== false;
      document.getElementById('employee-edit-department').value = p.department || '';
      document.getElementById('employee-edit-headcount-category').value = p.headcount_category || '';
      document.getElementById('employee-edit-is-driver').checked = !!p.is_driver;
      document.getElementById('employee-edit-can-overtime').checked = !!p.can_overtime;
      document.getElementById('employee-edit-can-site-duty').checked = !!p.can_input_site_duty;
      document.getElementById('employee-edit-can-sales').checked = !!p.can_input_sales;
      document.getElementById('employee-edit-can-transport').checked = !!p.can_input_transport;
      document.getElementById('employee-edit-can-qualification').checked = !!p.can_input_qualification;
      document.getElementById('employee-edit-can-backdate-ent').checked = !!p.can_backdate_entertainment_preapproval;
    }
  } catch (e) {
    showError('employee-edit-error', '現在の設定を読み込めませんでした。保存すると意図せず設定が消える可能性があるため、画面を開き直してください。');
    return; // 読み込み失敗時は保存ボタンを無効のままにする(disabledを解除しない)
  } finally {
    submitBtn.textContent = '保存する';
  }
  submitBtn.disabled = false;
}

async function doSaveEmployeeBasic() {
  const session = getSession();
  const furigana = document.getElementById('employee-edit-furigana').value.trim();
  const birth = document.getElementById('employee-edit-birth').value;
  const department = document.getElementById('employee-edit-department').value.trim();
  hideError('employee-edit-error');
  const btn = document.getElementById('employee-edit-submit');
  btn.disabled = true;
  try {
    await rpc('admin_update_employee_basic', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode,
      p_furigana: furigana || null, p_birth_date: birth || null, p_department: department || null,
      p_is_driver: document.getElementById('employee-edit-is-driver').checked,
      p_can_overtime: document.getElementById('employee-edit-can-overtime').checked,
      p_can_input_site_duty: document.getElementById('employee-edit-can-site-duty').checked,
      p_can_input_sales: document.getElementById('employee-edit-can-sales').checked,
      p_can_input_transport: document.getElementById('employee-edit-can-transport').checked,
      p_can_input_qualification: document.getElementById('employee-edit-can-qualification').checked,
      p_can_backdate_entertainment_preapproval: document.getElementById('employee-edit-can-backdate-ent').checked,
      p_show_birthday_on_calendar: document.getElementById('employee-edit-show-birthday').checked,
      // 空文字は「自動判定へ戻す」。RPC側がその意味で受け取る(nullは変更しない)。
      p_headcount_category: document.getElementById('employee-edit-headcount-category').value,
    });
    showScreen('employee-detail');
    await loadEmployeeDetailBasic();
  } catch (e) {
    showError('employee-edit-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 支給品保有一覧(横断、管理者) ----------

function formatSupplyHoldingsDate(d) {
  return d ? new Date(d).toLocaleDateString('ja-JP') : '-';
}

async function loadSupplyHoldingsAdmin() {
  const session = getSession();
  const listEl = document.getElementById('sha-list');
  const countEl = document.getElementById('sha-count');
  const employeeName = document.getElementById('sha-search-employee').value.trim();
  const itemName = document.getElementById('sha-search-item').value.trim();
  const heldOnly = document.getElementById('sha-held-only').checked;
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_all_supply_holdings', {
      p_admin_employee_code: session.employeeCode,
      p_item_name: itemName || null, p_employee_name: employeeName || null, p_held_only: heldOnly,
    });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する保有データはありません。</div>'; countEl.textContent = ''; return; }

    const byEmployee = new Map();
    rows.forEach((r) => {
      if (!byEmployee.has(r.employee_code)) byEmployee.set(r.employee_code, { name: r.employee_name, items: [] });
      byEmployee.get(r.employee_code).items.push(r);
    });
    countEl.textContent = `${byEmployee.size}名・${rows.length}件`;

    listEl.innerHTML = Array.from(byEmployee.values()).map((emp) => `
      <div class="card">
        <div class="form-title" style="font-size:15px;">${emp.name}</div>
        ${emp.items.map((it, idx) => `
          <div class="supply-item">
            <div class="row1"><span>${it.item_name}${it.size ? `(${it.size})` : ''}</span><span>${it.current_quantity}${it.current_quantity <= 0 ? '(保有なし)' : '個'}</span></div>
            <div class="row2">最終支給日: ${formatSupplyHoldingsDate(it.last_issued_date)}${it.first_issued_date && it.first_issued_date !== it.last_issued_date ? `(初回: ${formatSupplyHoldingsDate(it.first_issued_date)})` : ''}</div>
            ${it.replacement_due_date ? `<div class="row2">交換目安: ${formatSupplyHoldingsDate(it.replacement_due_date)}${new Date(it.replacement_due_date) < new Date() ? '<span class="mini-tag warn">交換目安を超過</span>' : ''}</div>` : ''}
            ${it.note ? `<div class="row2">備考: ${it.note}</div>` : ''}
            <button type="button" class="sha-history-toggle" data-employee-code="${it.employee_code}" data-item-name="${it.item_name}" data-size="${it.size || ''}" data-target="sha-history-${emp.name}-${idx}">履歴を見る</button>
            <div id="sha-history-${emp.name}-${idx}" class="sha-history-box" style="display:none;"></div>
          </div>
        `).join('')}
      </div>
    `).join('');
    listEl.querySelectorAll('.sha-history-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const box = document.getElementById(btn.dataset.target);
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        box.style.display = 'block';
        box.innerHTML = '<div class="hint">読み込み中...</div>';
        try {
          const hist = await rpc('admin_get_supply_item_history', {
            p_admin_employee_code: session.employeeCode, p_target_employee_code: btn.dataset.employeeCode,
            p_item_name: btn.dataset.itemName, p_size: btn.dataset.size || null,
          });
          box.innerHTML = hist.length === 0 ? '<div class="hint">履歴がありません。</div>' : hist.map((h) => `
            <div class="row2">${formatSupplyHoldingsDate(h.issued_date)}・${SUPPLY_CORRECTION_SOURCE_LABEL[h.source_type] || h.source_type}・${h.quantity}個${h.returned_date ? `・返却日: ${formatSupplyHoldingsDate(h.returned_date)}` : ''}${h.note ? `・${h.note}` : ''}</div>
          `).join('');
        } catch (e) {
          box.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
        }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 支給品マスター管理(管理者) ----------

async function loadSupplyMasterAdmin() {
  const session = getSession();
  const listEl = document.getElementById('supply-master-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetSupplyMasterForm();
  try {
    const rows = await rpc('admin_list_supply_master', { p_admin_employee_code: session.employeeCode });
    listEl.innerHTML = rows.map((m) => `
      <div class="supply-item" data-id="${m.id}" style="${m.active ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${m.item_name}</span><span>${m.active ? '有効' : '停止中'}</span></div>
        <div class="row2">${m.requires_size ? `サイズ選択あり(${(m.size_options || []).join('・') || '未設定'})` : 'サイズ選択なし'}・表示順${m.sort_order}</div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-master-btn" data-name="${m.item_name}" data-requires-size="${m.requires_size}" data-sort="${m.sort_order}" data-size-options="${(m.size_options || []).join(',')}">編集</button>
          <button type="button" class="reject-btn toggle-active-btn" data-active="${m.active}">${m.active ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-master-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('supply-master-edit-id').value = item.dataset.id;
        document.getElementById('supply-master-name').value = btn.dataset.name;
        document.getElementById('supply-master-requires-size').checked = btn.dataset.requiresSize === 'true';
        document.getElementById('supply-master-size-options-wrap').style.display = btn.dataset.requiresSize === 'true' ? 'block' : 'none';
        document.getElementById('supply-master-size-options').value = btn.dataset.sizeOptions || '';
        document.getElementById('supply-master-sort').value = btn.dataset.sort;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-active-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_supply_master_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadSupplyMasterAdmin();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function resetSupplyMasterForm() {
  document.getElementById('supply-master-edit-id').value = '';
  document.getElementById('supply-master-name').value = '';
  document.getElementById('supply-master-requires-size').checked = false;
  document.getElementById('supply-master-size-options-wrap').style.display = 'none';
  document.getElementById('supply-master-size-options').value = '';
  document.getElementById('supply-master-sort').value = '100';
  hideError('supply-master-error');
}

async function doSaveSupplyMasterItem() {
  const session = getSession();
  const id = document.getElementById('supply-master-edit-id').value;
  const name = document.getElementById('supply-master-name').value.trim();
  const requiresSize = document.getElementById('supply-master-requires-size').checked;
  const sizeOptions = document.getElementById('supply-master-size-options').value.split(',').map((s) => s.trim()).filter(Boolean);
  const sortOrder = Number(document.getElementById('supply-master-sort').value || 100);
  hideError('supply-master-error');
  if (!name) { showError('supply-master-error', '品目名を入力してください。'); return; }

  const btn = document.getElementById('supply-master-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_supply_master_item', {
      p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_item_name: name,
      p_requires_size: requiresSize, p_sort_order: sortOrder, p_size_options: requiresSize && sizeOptions.length > 0 ? sizeOptions : null,
    });
    await loadSupplyMasterAdmin();
  } catch (e) {
    showError('supply-master-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 支給品申請の確認(管理者、まとめて承認/却下) ----------

async function loadSupplyRequestAdminList() {
  const session = getSession();
  const listEl = document.getElementById('supply-request-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_pending_supply_items', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">承認待ちの支給品申請はありません。</div>'; return; }
    const byRequest = new Map();
    rows.forEach((r) => {
      if (!byRequest.has(r.employee_request_id)) byRequest.set(r.employee_request_id, { employee_name: r.employee_name, employee_code: r.employee_code, requested_at: r.requested_at, items: [] });
      byRequest.get(r.employee_request_id).items.push(r);
    });
    listEl.innerHTML = Array.from(byRequest.entries()).map(([reqId, g]) => `
      <div class="card" data-request-id="${reqId}">
        <div class="row1"><span>${g.employee_name}(${g.employee_code})</span><span>${new Date(g.requested_at).toLocaleString('ja-JP')}</span></div>
        ${g.items.map((it) => `
          <div class="supply-item" data-item-request-id="${it.item_request_id}">
            <div class="row1"><span>${it.item_name}</span></div>
            ${it.reason ? `<div class="row2">${it.reason}</div>` : ''}
            <div class="row2" style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
              数量 <input type="number" min="1" class="decide-qty-input" style="width:56px;" value="${it.quantity}">
              サイズ <input type="text" class="decide-size-input" style="width:64px;" value="${it.size || ''}">
            </div>
            <div class="row2" style="display:flex; gap:6px; align-items:center;">
              支給予定日 <input type="date" class="decide-schedule-input" style="width:150px;">
            </div>
            <div class="hint-inline">承認しても保有数はまだ増えません。実際に渡したら「受渡待ち」から受渡完了を押してください。</div>
            <div class="qual-verify-btns">
              <button type="button" class="approve-btn decide-approve-btn">承認する</button>
              <button type="button" class="reject-btn decide-reject-btn">却下する</button>
            </div>
          </div>
        `).join('')}
        <button type="button" class="secondary approve-all-btn" style="margin-top:8px;">この申請の全品を承認する</button>
      </div>
    `).join('');

    listEl.querySelectorAll('.decide-approve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        const decision = {
          item_request_id: Number(item.dataset.itemRequestId), action: 'approve',
          quantity: Number(item.querySelector('.decide-qty-input').value) || 1,
          size: item.querySelector('.decide-size-input').value.trim() || null,
          scheduled_issue_date: item.querySelector('.decide-schedule-input').value || null,
        };
        try { await rpc('admin_decide_supply_items', { p_admin_employee_code: session.employeeCode, p_decisions: [decision] }); await loadSupplyRequestAdminList(); await loadSupplyDeliveryQueue(); }
        catch (e) { window.alert(e.message || '承認に失敗しました。'); }
      });
    });
    listEl.querySelectorAll('.decide-reject-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = window.prompt('却下理由を入力してください');
        if (reason === null || !reason.trim()) return;
        const item = btn.closest('.supply-item');
        const decision = { item_request_id: Number(item.dataset.itemRequestId), action: 'reject', reason };
        try { await rpc('admin_decide_supply_items', { p_admin_employee_code: session.employeeCode, p_decisions: [decision] }); await loadSupplyRequestAdminList(); }
        catch (e) { window.alert(e.message || '却下に失敗しました。'); }
      });
    });
    listEl.querySelectorAll('.approve-all-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.card');
        const decisions = Array.from(card.querySelectorAll('.supply-item')).map((item) => ({
          item_request_id: Number(item.dataset.itemRequestId), action: 'approve',
          quantity: Number(item.querySelector('.decide-qty-input').value) || 1,
          size: item.querySelector('.decide-size-input').value.trim() || null,
          scheduled_issue_date: item.querySelector('.decide-schedule-input').value || null,
        }));
        try { await rpc('admin_decide_supply_items', { p_admin_employee_code: session.employeeCode, p_decisions: decisions }); await loadSupplyRequestAdminList(); await loadSupplyDeliveryQueue(); }
        catch (e) { window.alert(e.message || '承認に失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// 受渡待ち(承認済み・未受渡)の一覧。受渡完了で初めて本人の保有へ加算される。
async function loadSupplyDeliveryQueue() {
  const session = getSession();
  const el = document.getElementById('supply-delivery-queue-list');
  if (!el) return;
  el.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_supply_pending_delivery', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { el.innerHTML = '<div class="hint">受渡待ちの支給品はありません。</div>'; return; }
    el.innerHTML = rows.map((r) => `
      <div class="card supply-delivery-row" data-item-request-id="${r.item_request_id}">
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span class="mini-tag info">承認済み</span></div>
        <div class="row2">${r.item_name}${r.size ? `・${r.size}` : ''}　数量${r.quantity}</div>
        <div class="row2" style="display:flex; gap:6px; align-items:center;">
          支給予定日 <input type="date" class="dq-schedule-input" style="width:150px;" value="${r.scheduled_issue_date ? String(r.scheduled_issue_date).slice(0, 10) : ''}">
          <button type="button" class="secondary dq-save-schedule">予定日を保存</button>
        </div>
        <div class="row2 hint-inline">承認: ${r.decided_by || ''}${r.decided_at ? '（' + new Date(r.decided_at).toLocaleDateString('ja-JP') + '）' : ''}</div>
        <div class="qual-verify-btns">
          <button type="button" class="approve-btn dq-deliver-btn">受渡完了(本人へ渡した)</button>
        </div>
      </div>
    `).join('');
    el.querySelectorAll('.dq-save-schedule').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.supply-delivery-row');
        const d = row.querySelector('.dq-schedule-input').value;
        if (!d) { window.alert('支給予定日を入力してください。'); return; }
        try { await rpc('admin_set_supply_schedule', { p_admin_employee_code: session.employeeCode, p_item_request_id: Number(row.dataset.itemRequestId), p_scheduled_issue_date: d }); await loadSupplyDeliveryQueue(); }
        catch (e) { window.alert(e.message || '保存に失敗しました。'); }
      });
    });
    el.querySelectorAll('.dq-deliver-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.supply-delivery-row');
        if (!window.confirm('本人へ渡したものとして受渡完了にします。本人の保有数に加算されます。よろしいですか？')) return;
        try { await rpc('admin_mark_supply_delivered', { p_admin_employee_code: session.employeeCode, p_deliveries: [{ item_request_id: Number(row.dataset.itemRequestId) }] }); await loadSupplyDeliveryQueue(); }
        catch (e) { window.alert(e.message || '受渡完了に失敗しました。'); }
      });
    });
  } catch (e) {
    el.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 健康診断(社員本人) ----------

let healthFileUpload = null;

async function handleHealthFile(file) {
  if (!file) return;
  const status = document.getElementById('health-file-status');
  const label = document.getElementById('health-file-label');
  status.textContent = 'アップロード中...';
  try {
    const session = getSession();
    const result = await uploadReceiptPhoto(session.employeeCode, file);
    healthFileUpload = result;
    status.textContent = 'アップロード完了';
    label.textContent = file.name;
  } catch (e) {
    status.textContent = 'アップロードに失敗しました。';
  }
}

function resetHealthForm() {
  ['health-date', 'health-type', 'health-institution', 'health-next', 'health-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('health-retest').checked = false;
  document.getElementById('health-file-input').value = '';
  document.getElementById('health-file-label').textContent = '写真/PDFを選ぶ';
  document.getElementById('health-file-status').textContent = '';
  healthFileUpload = null;
  hideError('health-error');
}

async function doSubmitHealthCheckup() {
  const session = getSession();
  const date = document.getElementById('health-date').value;
  hideError('health-error');
  if (!date) { showError('health-error', '受診日を入力してください。'); return; }
  const btn = document.getElementById('health-submit');
  btn.disabled = true;
  try {
    await rpc('submit_health_checkup', {
      p_employee_code: session.employeeCode,
      p_checkup_date: date,
      p_checkup_type: document.getElementById('health-type').value.trim() || null,
      p_institution: document.getElementById('health-institution').value.trim() || null,
      p_next_due_date: document.getElementById('health-next').value || null,
      p_needs_retest: document.getElementById('health-retest').checked,
      p_note: document.getElementById('health-note').value.trim() || null,
      p_result_drive_file_id: healthFileUpload ? healthFileUpload.driveFileId : null,
      p_result_drive_file_url: healthFileUpload ? healthFileUpload.driveFileUrl : null,
    });
    resetHealthForm();
    showDone('健康診断の記録を登録しました。', 'menu-apply');
  } catch (e) {
    showError('health-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

function healthStatusText(s) {
  if (!s || !s.last_checkup_date) return '未登録です';
  const last = new Date(s.last_checkup_date).toLocaleDateString('ja-JP');
  const next = s.next_due_date ? new Date(s.next_due_date).toLocaleDateString('ja-JP') : '未登録';
  let status = '';
  if (s.is_overdue) status = '(期限を超えています)';
  else if (s.days_until_due != null && s.days_until_due <= 60) status = `(残り${s.days_until_due}日)`;
  return `最終受診日: ${last} ／ 次回予定: ${next}${status}`;
}

async function loadMyHealthSummary() {
  const session = getSession();
  const area = document.getElementById('my-health-summary');
  area.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_health_summary', { p_employee_code: session.employeeCode });
    const s = rows && rows[0];
    area.innerHTML = `
      <div class="health-summary-card">
        <div class="row"><span class="label">最終受診日</span><span>${s && s.last_checkup_date ? new Date(s.last_checkup_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        <div class="row"><span class="label">次回予定</span><span>${s && s.next_due_date ? new Date(s.next_due_date).toLocaleDateString('ja-JP') : '未登録'}</span></div>
        ${s && s.is_overdue ? '<div class="row"><span class="label">状態</span><span style="color:var(--danger); font-weight:700;">期限超過</span></div>' : ''}
        ${s && s.needs_retest ? '<div class="row"><span class="label">状態</span><span style="color:var(--warn); font-weight:700;">再検査確認待ち</span></div>' : ''}
      </div>
    `;
  } catch (e) {
    area.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadMyHealthList() {
  const session = getSession();
  const listEl = document.getElementById('my-health-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_health_checkups', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">登録された健診記録はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((h) => `
      <div class="qual-item">
        <div class="row1"><span>${new Date(h.checkup_date).toLocaleDateString('ja-JP')}${h.checkup_type ? `・${h.checkup_type}` : ''}</span><span class="status-badge ${h.result_confirmed ? 'done' : ''}">${h.result_confirmed ? '確認済み' : '未確認'}</span></div>
        <div class="row2">${h.institution || ''}</div>
        <div class="row2">${h.next_due_date ? `次回予定: ${new Date(h.next_due_date).toLocaleDateString('ja-JP')}` : ''}${h.needs_retest ? '・再検査あり' : ''}</div>
        <div class="row2">${h.note || ''}</div>
        ${secureFileBlockHtml('health', 'health', h.id, !!h.result_file_url, false)}
      </div>
    `).join('');
    hydrateSecureImages(listEl);
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 接待・会食 事前申請(社員) ----------

// 接待先(取引先)を複数会社ぶん動的に管理するウィジェット。通常フォーム・特別後日申請
// フォームの両方で共有する(2026-08-27、複数会社対応)。会社ごとに「参加人数」は必須だが
// 「参加者名」は自由テキストで、人数と名前の件数が一致しなくても申請できる仕様。
function createEntCompanyList(containerId, addBtnId, summaryId, getOurCount) {
  const container = document.getElementById(containerId);
  let seq = 0;

  function recalcSummary() {
    let partnerTotal = 0;
    container.querySelectorAll('.ent-company-block').forEach((b) => {
      partnerTotal += Number(b.querySelector('.ent-company-count').value || 0);
    });
    const ourTotal = getOurCount();
    const el = document.getElementById(summaryId);
    if (el) el.innerHTML = `社外参加者合計: <b>${partnerTotal}</b>名　自社参加者合計: <b>${ourTotal}</b>名　総参加人数: <b>${partnerTotal + ourTotal}</b>名`;
  }

  function updateRemoveButtons() {
    const blocks = container.querySelectorAll('.ent-company-block');
    blocks.forEach((b) => { b.querySelector('.ent-company-remove').style.display = blocks.length > 1 ? '' : 'none'; });
  }

  function addBlock() {
    seq += 1;
    const block = document.createElement('div');
    block.className = 'ent-company-block';
    block.innerHTML = `
      <div class="ent-company-block-header">
        <span>取引先${seq}</span>
        <button type="button" class="secondary danger ent-company-remove">✕ この会社を削除</button>
      </div>
      <label>会社名<span class="required-mark">(必須)</span></label>
      <input type="text" class="ent-company-name" list="vendor-list">
      <label>参加人数<span class="required-mark">(必須)</span></label>
      <input type="number" class="ent-company-count" min="1">
      <label>参加者名(分かる範囲・任意)</label>
      <div class="hint-inline">人数ぶん全員の氏名が分からなくても申請できます(例: 5名中2名だけ判明でも可)</div>
      <input type="text" class="ent-company-names" placeholder="例: 山田様、佐藤様">`;
    container.appendChild(block);
    block.querySelector('.ent-company-count').addEventListener('input', recalcSummary);
    block.querySelector('.ent-company-remove').addEventListener('click', () => { block.remove(); updateRemoveButtons(); recalcSummary(); });
    updateRemoveButtons();
    recalcSummary();
  }

  // resetEntertainmentForm()は画面へ入るたびに呼ばれ、そのたびにcreateEntCompanyList()が
  // 再実行される(=このボタン要素自体は使い回される)。addEventListenerだと呼ぶたびに
  // リスナーが積み重なり、2回目以降の画面訪問で「＋追加」1クリックで複数ブロックが
  // 追加される不具合になる(実機検証で発見)。onclick代入は常に直前の1件だけを置き換えるため、
  // 同じ要素へ何度re-initしても安全。
  document.getElementById(addBtnId).onclick = addBlock;

  return {
    reset() { container.innerHTML = ''; seq = 0; addBlock(); },
    recalcSummary,
    getCompanies() {
      return Array.from(container.querySelectorAll('.ent-company-block')).map((b) => {
        const name = b.querySelector('.ent-company-name').value.trim();
        const partnerId = vendorNameToId.get(name) || null;
        return {
          business_partner_id: partnerId,
          new_company_name: partnerId ? null : name,
          participant_count: Number(b.querySelector('.ent-company-count').value || 0),
          participant_names: b.querySelector('.ent-company-names').value.trim() || null,
          __name: name,
        };
      });
    },
  };
}

function validateEntCompanies(companies, errorElId) {
  if (companies.length === 0) { showError(errorElId, '接待先の取引先を1社以上入力してください。'); return false; }
  for (const c of companies) {
    if (!c.__name) { showError(errorElId, '取引先の会社名を入力してください。'); return false; }
    if (!c.participant_count) { showError(errorElId, '各取引先の参加人数を入力してください。'); return false; }
  }
  return true;
}

let entOurParticipantSelect = null;
let entCompanyList = null;

function resetEntertainmentForm() {
  ['ent-datetime', 'ent-store', 'ent-amount', 'ent-purpose', 'ent-note'].forEach((id) => { document.getElementById(id).value = ''; });
  hideError('ent-error');
  document.getElementById('ent-goto-late-btn').style.display = 'none';
  // 通常の事前申請フォームでは過去日を選ばせない(実際の防止はサーバー側だが、
  // ここでは選択の時点で気づけるようにする)。同日(当日事後申請)は引き続き選択可能。
  const todayStr = new Date().toISOString().slice(0, 10);
  document.getElementById('ent-datetime').min = `${todayStr}T00:00`;
  entOurParticipantSelect = createEmployeeCardPicker(document.getElementById('ent-our-participants'));
  entCompanyList = createEntCompanyList('ent-companies', 'ent-company-add', 'ent-summary', () => entOurParticipantSelect.getCount());
  entOurParticipantSelect.setOnChange(() => { document.getElementById('ent-our-count').textContent = entOurParticipantSelect.getCount(); entCompanyList.recalcSummary(); });
  document.getElementById('ent-our-count').textContent = '0';
  entCompanyList.reset();
}

async function doSubmitEntertainmentPreapproval() {
  const session = getSession();
  const datetime = document.getElementById('ent-datetime').value;
  const purpose = document.getElementById('ent-purpose').value.trim();
  hideError('ent-error');

  if (!datetime) { showError('ent-error', '予定日時を入力してください。'); return; }
  if (!purpose) { showError('ent-error', '目的を入力してください。'); return; }
  const companies = entCompanyList.getCompanies();
  if (!validateEntCompanies(companies, 'ent-error')) return;
  const ourCodes = entOurParticipantSelect ? entOurParticipantSelect.getSelectedCodes() : [];
  if (ourCodes.length === 0) { showError('ent-error', '自社参加者を選択してください。'); return; }

  // 過去日提出の可否(特例許可の有無)は社員ごとに違うため、ここでは判定せずサーバーの
  // 判定に委ねる(特例許可がある社員は過去日でもこのフォームで正常に送信できる)。
  // 特例がない社員が過去日を送った場合は、下のcatchでサーバーからの案内メッセージを表示する。
  const btn = document.getElementById('ent-submit');
  btn.disabled = true;
  try {
    await rpc('submit_entertainment_preapproval_multi', {
      p_employee_code: session.employeeCode,
      p_planned_datetime: new Date(datetime).toISOString(),
      p_planned_store: document.getElementById('ent-store').value.trim() || null,
      p_planned_amount: document.getElementById('ent-amount').value ? Number(document.getElementById('ent-amount').value) : null,
      p_purpose: purpose,
      p_partner_companies: companies.map(({ __name, ...c }) => c),
      p_our_participant_employee_codes: ourCodes,
      p_note: document.getElementById('ent-note').value.trim() || null,
      p_is_special_late_application: false,
      p_late_reason: null,
    });
    showDone('接待・会食の事前申請を送信しました。管理者の承認をお待ちください。', 'menu-apply');
  } catch (e) {
    showError('ent-error', e.message || '送信に失敗しました。');
    const gotoLateBtn = document.getElementById('ent-goto-late-btn');
    gotoLateBtn.style.display = (e.message || '').includes('特別後日申請') ? 'block' : 'none';
  } finally {
    btn.disabled = false;
  }
}

// ---------- 接待・会食 特別後日申請(社員、事前申請できなかった過去日分) ----------

let entLateOurParticipantSelect = null;
let entLateCompanyList = null;

function resetEntertainmentLateForm() {
  ['ent-late-datetime', 'ent-late-store', 'ent-late-amount', 'ent-late-purpose', 'ent-late-reason', 'ent-late-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('ent-late-ack').checked = false;
  document.getElementById('ent-late-submit').disabled = true;
  hideError('ent-late-error');
  entLateOurParticipantSelect = createEmployeeCardPicker(document.getElementById('ent-late-our-participants'));
  entLateCompanyList = createEntCompanyList('ent-late-companies', 'ent-late-company-add', 'ent-late-summary', () => entLateOurParticipantSelect.getCount());
  entLateOurParticipantSelect.setOnChange(() => { document.getElementById('ent-late-our-count').textContent = entLateOurParticipantSelect.getCount(); entLateCompanyList.recalcSummary(); });
  document.getElementById('ent-late-our-count').textContent = '0';
  entLateCompanyList.reset();
}

async function doSubmitEntertainmentLatePreapproval() {
  const session = getSession();
  const datetime = document.getElementById('ent-late-datetime').value;
  const purpose = document.getElementById('ent-late-purpose').value.trim();
  const reason = document.getElementById('ent-late-reason').value.trim();
  hideError('ent-late-error');

  if (!datetime) { showError('ent-late-error', '接待の実施日時を入力してください。'); return; }
  if (!purpose) { showError('ent-late-error', '目的を入力してください。'); return; }
  const companies = entLateCompanyList.getCompanies();
  if (!validateEntCompanies(companies, 'ent-late-error')) return;
  const ourCodes = entLateOurParticipantSelect ? entLateOurParticipantSelect.getSelectedCodes() : [];
  if (ourCodes.length === 0) { showError('ent-late-error', '自社参加者を選択してください。'); return; }
  if (reason.length < 15) { showError('ent-late-error', '事前に申請できなかった具体的な理由を15文字以上で入力してください。'); return; }
  if (!document.getElementById('ent-late-ack').checked) { showError('ent-late-error', '確認のチェックを入れてください。'); return; }

  const btn = document.getElementById('ent-late-submit');
  btn.disabled = true;
  try {
    await rpc('submit_entertainment_preapproval_multi', {
      p_employee_code: session.employeeCode,
      p_planned_datetime: new Date(datetime).toISOString(),
      p_planned_store: document.getElementById('ent-late-store').value.trim() || null,
      p_planned_amount: document.getElementById('ent-late-amount').value ? Number(document.getElementById('ent-late-amount').value) : null,
      p_purpose: purpose,
      p_partner_companies: companies.map(({ __name, ...c }) => c),
      p_our_participant_employee_codes: ourCodes,
      p_note: document.getElementById('ent-late-note').value.trim() || null,
      p_is_special_late_application: true,
      p_late_reason: reason,
    });
    showDone('特別後日申請を送信しました。管理者による例外承認をお待ちください。', 'my-entertainment');
  } catch (e) {
    showError('ent-late-error', e.message || '送信に失敗しました。');
    btn.disabled = !document.getElementById('ent-late-ack').checked;
  }
}

// ---------- 勤務中ステータス: 外出・遅刻・早退(2026-08-28、9/1本番運用開始向け新機能) ----------

async function loadStatusSubmitScreen() {
  hideError('status-outing-error'); hideError('status-late-error'); hideError('status-early-error');
  document.getElementById('status-outing-category').value = '業務外出';
  ['status-outing-destination', 'status-outing-reason', 'status-outing-expected-return', 'status-outing-note',
    'status-late-expected-arrival', 'status-late-reason', 'status-late-note',
    'status-early-reason', 'status-early-note'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('status-outing-will-return').checked = true;

  const session = getSession();
  const card = document.getElementById('status-active-outings-card');
  const list = document.getElementById('status-active-outings-list');
  card.style.display = 'none';
  try {
    const rows = await rpc('get_employee_status_timeline', { p_employee_code: session.employeeCode, p_target_employee_code: session.employeeCode, p_work_date: null });
    const active = rows.filter((r) => r.status === 'active' && r.event_type === 'outing');
    if (active.length === 0) return;
    card.style.display = '';
    list.innerHTML = active.map((r) => `
      <div class="plain-list-row">
        <div><b>${r.category || ''}</b> ${r.destination || ''}</div>
        <div class="hint-inline">${r.reason || ''}${r.expected_return_at ? ` (予定: ${new Date(r.expected_return_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })})` : ''}</div>
        <button type="button" class="secondary" data-return-id="${r.id}">戻りました</button>
      </div>`).join('');
    list.querySelectorAll('[data-return-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('mark_status_report_returned', { p_employee_code: session.employeeCode, p_report_id: Number(btn.dataset.returnId) });
          showDone('お帰りなさい。戻ったことを記録しました。', 'status-submit');
        } catch (e) {
          btn.disabled = false;
          alert(e.message || '処理に失敗しました。');
        }
      });
    });
  } catch (e) { /* 一覧取得に失敗してもフォーム自体は使えるようにする */ }
}

// 外出/遅刻の予定時刻は「当日の時刻」だけを入力させる(年月日の入力は不要、常に本日扱い)。
// <input type="time">の値("HH:MM")へtodayJST()の日付を合成してISO文字列化する。
function todayTimeToISOJST(timeStr) {
  if (!timeStr) return null;
  return new Date(`${todayJST()}T${timeStr}:00+09:00`).toISOString();
}

async function doSubmitStatusOuting() {
  const session = getSession();
  const category = document.getElementById('status-outing-category').value;
  const destination = document.getElementById('status-outing-destination').value.trim() || null;
  const reason = document.getElementById('status-outing-reason').value.trim() || null;
  const expectedReturn = document.getElementById('status-outing-expected-return').value;
  const willReturn = document.getElementById('status-outing-will-return').checked;
  const note = document.getElementById('status-outing-note').value.trim() || null;
  hideError('status-outing-error');
  const isBusinessUse = category === '業務外出' || category === '現場移動';
  const visibility = category === '病院等' ? 'sensitive' : 'general';

  const btn = document.getElementById('status-outing-submit');
  btn.disabled = true;
  try {
    await rpc('submit_status_report_outing', {
      p_employee_code: session.employeeCode,
      p_category: category,
      p_destination: destination,
      p_reason: reason,
      p_is_business_use: isBusinessUse,
      p_will_return_today: willReturn,
      p_expected_return_at: todayTimeToISOJST(expectedReturn),
      p_note: note,
      p_visibility: visibility,
      p_target_employee_code: null,
    });
    showDone('外出を報告しました。戻ったら「戻りました」から報告してください。', 'menu');
  } catch (e) {
    showError('status-outing-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doSubmitStatusLate() {
  const session = getSession();
  const expectedArrival = document.getElementById('status-late-expected-arrival').value;
  const reason = document.getElementById('status-late-reason').value.trim();
  const note = document.getElementById('status-late-note').value.trim() || null;
  hideError('status-late-error');
  if (!expectedArrival) { showError('status-late-error', '到着予定時刻を入力してください。'); return; }
  if (!reason) { showError('status-late-error', '理由を入力してください。'); return; }

  const btn = document.getElementById('status-late-submit');
  btn.disabled = true;
  try {
    await rpc('submit_status_report_late_arrival', {
      p_employee_code: session.employeeCode,
      p_scheduled_start_at: null,
      p_expected_arrival_at: todayTimeToISOJST(expectedArrival),
      p_reason: reason,
      p_note: note,
    });
    showDone('遅刻を報告しました。', 'menu');
  } catch (e) {
    showError('status-late-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doSubmitStatusEarly() {
  const session = getSession();
  const reason = document.getElementById('status-early-reason').value.trim();
  const note = document.getElementById('status-early-note').value.trim() || null;
  hideError('status-early-error');
  if (!reason) { showError('status-early-error', '理由を入力してください。'); return; }

  const btn = document.getElementById('status-early-submit');
  btn.disabled = true;
  try {
    await rpc('submit_status_report_early_leave', {
      p_employee_code: session.employeeCode,
      p_early_leave_at: new Date().toISOString(),
      p_reason: reason,
      p_note: note,
    });
    showDone('早退を報告しました。お疲れさまでした。', 'menu');
  } catch (e) {
    showError('status-early-error', e.message || '送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

const STATUS_BOARD_LABEL = {
  working: { emoji: '🟢', label: '勤務中' },
  out: { emoji: '🟡', label: '外出中' },
  late: { emoji: '🔵', label: '遅刻報告中' },
  early_left: { emoji: '🔴', label: '早退' },
};

async function loadAdminStatusBoard() {
  const session = getSession();
  const list = document.getElementById('admin-status-board-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_employee_status_board', { p_admin_employee_code: session.employeeCode });
    if (rows.length === 0) { list.innerHTML = '<div class="hint">社員データがありません。</div>'; return; }
    list.innerHTML = rows.map((r) => {
      const s = STATUS_BOARD_LABEL[r.current_state] || STATUS_BOARD_LABEL.working;
      const overdueTag = r.is_overdue ? ' <span class="tag danger">帰着予定超過</span>' : '';
      const detail = r.current_state === 'working' ? '' :
        `${r.category || ''}${r.destination ? `・${r.destination}` : ''}${r.expected_return_at ? `・${new Date(r.expected_return_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}帰社予定` : ''}`;
      return `<button type="button" class="plain-list-row status-board-row" data-code="${r.employee_code}" data-name="${r.employee_name}">
        <div>${s.emoji} <b>${r.employee_name}</b>${overdueTag}</div>
        <div class="hint-inline">${s.label}${detail ? `　${detail}` : ''}</div>
      </button>`;
    }).join('');
    list.querySelectorAll('.status-board-row').forEach((row) => {
      row.addEventListener('click', () => openStatusTimeline(row.dataset.code, row.dataset.name));
    });
  } catch (e) {
    list.innerHTML = `<div class="error show">${e.message || '読み込みに失敗しました。'}</div>`;
  }
}

// 全社員共通の在席状況(2026-08-28制定、2026-08-28仕様変更): 管理者専用のadmin_get_employee_status_boardとは
// 別に、destination/reason/categoryを一切受け取らないget_employee_status_board_generalを使う。
// 社員ポータルは勤怠打刻システムではないため、「勤務中」を自動的に断定表示することを廃止し、
// 休暇/外出中/遅刻/早退という「通常と違う状態」だけを、その順番でグループ表示する
// (RPC側でも同じ優先順位でソート済みのため、フロントはグループ単位に振り分けるだけでよい)。
const STATUS_GENERAL_GROUPS = [
  { state: 'on_leave', title: '本日休暇', emoji: '⚪' },
  { state: 'out', title: '外出中', emoji: '🟡' },
  { state: 'late', title: '遅刻', emoji: '🔵' },
  { state: 'early_left', title: '早退', emoji: '🔴' },
];

function renderStatusGeneralRow(group, r) {
  const time = r.detail_time
    ? new Date(r.detail_time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  let stateLine;
  if (group.state === 'on_leave') stateLine = '休暇';
  else if (group.state === 'out') stateLine = '外出中';
  else if (group.state === 'late') stateLine = time ? `${time}頃予定` : '遅刻';
  else stateLine = time ? `${time}早退` : '早退';
  const returnDetail = group.state === 'out' && time ? `　戻り予定 ${time}` : '';
  return `<div class="plain-list-row status-board-row">
    <div>${group.emoji} <b>${r.employee_name}</b></div>
    <div class="hint-inline">${stateLine}${returnDetail}</div>
  </div>`;
}

async function loadStatusBoardGeneral() {
  const session = getSession();
  const list = document.getElementById('status-board-general-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_employee_status_board_general', { p_employee_code: session.employeeCode });
    if (rows.length === 0) { list.innerHTML = '<div class="hint">現在、共有事項はありません。</div>'; return; }
    const byState = {};
    rows.forEach((r) => { (byState[r.current_state] = byState[r.current_state] || []).push(r); });
    list.innerHTML = STATUS_GENERAL_GROUPS.filter((g) => byState[g.state] && byState[g.state].length > 0).map((g) => `
      <div class="section-title">${g.title}(${byState[g.state].length}名)</div>
      ${byState[g.state].map((r) => renderStatusGeneralRow(g, r)).join('')}
    `).join('');
  } catch (e) {
    list.innerHTML = `<div class="error show">${e.message || '読み込みに失敗しました。'}</div>`;
  }
}

// ---------- Action Center(2026-08-28、管理者から社員個人/複数社員への指示) ----------

async function loadMyActionItems() {
  const session = getSession();
  const list = document.getElementById('my-action-items-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_action_items', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { list.innerHTML = '<div class="hint">現在、対応が必要な指示はありません。</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="card" data-id="${r.id}" style="margin-bottom:10px;">
        <div style="font-weight:700;">${r.is_overdue ? '<span class="tag danger">期限超過</span> ' : ''}${r.title}</div>
        ${r.body ? `<div class="hint-inline" style="white-space:pre-wrap;margin-top:4px;">${r.body}</div>` : ''}
        <div class="hint-inline" style="margin-top:6px;">${r.due_date ? `期限: ${r.due_date}・` : ''}発行: ${r.created_by_name}</div>
        <button type="button" class="secondary action-item-done-btn" style="margin-top:8px;">完了にする</button>
      </div>
    `).join('');
    list.querySelectorAll('.action-item-done-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-id]');
        btn.disabled = true;
        try {
          await rpc('mark_action_item_done', { p_employee_code: session.employeeCode, p_action_item_id: Number(card.dataset.id) });
          await loadMyActionItems();
        } catch (e) { btn.disabled = false; window.alert(e.message || '操作に失敗しました。'); }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="error show">${e.message || '読み込みに失敗しました。'}</div>`;
  }
}

let actionItemEmployeeSelect = null;

function resetActionItemCreateForm() {
  ['action-item-title', 'action-item-body', 'action-item-due-date'].forEach((id) => { document.getElementById(id).value = ''; });
  hideError('action-item-error');
  actionItemEmployeeSelect = createEmployeeCardPicker(document.getElementById('action-item-employee-picker'));
  loadAdminActionItemsList();
}

async function doCreateActionItem() {
  const session = getSession();
  const title = document.getElementById('action-item-title').value.trim();
  const body = document.getElementById('action-item-body').value.trim();
  const dueDate = document.getElementById('action-item-due-date').value || null;
  const codes = actionItemEmployeeSelect ? actionItemEmployeeSelect.getSelectedCodes() : [];
  hideError('action-item-error');
  if (!title) { showError('action-item-error', 'タイトルを入力してください。'); return; }
  if (codes.length === 0) { showError('action-item-error', '対象社員を選択してください。'); return; }

  const btn = document.getElementById('action-item-submit');
  btn.disabled = true;
  try {
    await rpc('admin_create_action_item', {
      p_admin_employee_code: session.employeeCode, p_title: title, p_body: body || null,
      p_due_date: dueDate, p_employee_codes: codes, p_department: null,
    });
    showDone('指示を発行しました。', 'admin-dashboard');
  } catch (e) {
    showError('action-item-error', e.message || '発行に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function loadAdminActionItemsList() {
  const session = getSession();
  const list = document.getElementById('admin-action-items-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_action_items', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { list.innerHTML = '<div class="hint">まだ指示を発行していません。</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="plain-list-row">
        <div><b>${r.title}</b></div>
        <div class="hint-inline">${r.due_date ? `期限: ${r.due_date}・` : ''}完了 ${r.completed_count}/${r.recipient_count}</div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = '';
  }
}

const STATUS_EVENT_LABEL = { outing: '外出', late_arrival: '遅刻', early_leave: '早退' };

async function openStatusTimeline(employeeCode, employeeName) {
  document.getElementById('status-timeline-title').textContent = `${employeeName}さんの本日の記録`;
  showScreen('status-timeline');
  const session = getSession();
  const list = document.getElementById('status-timeline-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_employee_status_timeline', { p_employee_code: session.employeeCode, p_target_employee_code: employeeCode, p_work_date: null });
    if (rows.length === 0) { list.innerHTML = '<div class="hint">本日の記録はありません。</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="plain-list-row">
        <div><b>${STATUS_EVENT_LABEL[r.event_type] || r.event_type}</b> ${r.category || ''} ${r.destination || ''}</div>
        <div class="hint-inline">${r.reason || ''}</div>
        <div class="hint-inline">報告: ${new Date(r.reported_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          ${r.actual_return_at ? ` / 帰着: ${new Date(r.actual_return_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ''}
          ${r.actual_arrival_at ? ` / 出勤: ${new Date(r.actual_arrival_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="error show">${e.message || '読み込みに失敗しました。'}</div>`;
  }
}

const ENT_STATUS_LABEL = { pending: '確認待ち', approved: '承認済み', rejected: '却下' };

const ENT_TIMING_TAG_CLASS = { '事前申請': 'info', '当日事後申請': 'warn', '後日申請': 'danger' };

async function loadMyEntertainmentList() {
  const session = getSession();
  const listEl = document.getElementById('my-entertainment-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_entertainment_preapprovals', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">事前申請はまだありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="qual-item" data-id="${r.id}">
        <div class="row1"><span>${r.planned_store || '(店舗未記入)'}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${ENT_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${new Date(r.planned_datetime).toLocaleString('ja-JP')}・${r.partner_name_snapshot || ''}</div>
        <div class="row2">${r.purpose || ''}${r.planned_amount != null ? `・予定${Number(r.planned_amount).toLocaleString()}円` : ''}</div>
        <div class="row2">実績: 取引先${r.actual_partner_participant_count ?? '-'}名/自社${r.actual_our_participant_count ?? '-'}名・紐付き領収書${r.linked_receipt_count}件</div>
        <div class="employee-row-flags" style="margin-top:6px;">
          <span class="mini-tag ${ENT_TIMING_TAG_CLASS[r.submission_timing] || 'muted'}">${r.submission_timing || ''}</span>
          ${r.requires_special_review ? '<span class="mini-tag danger">事前申請なし(特別承認)</span>' : ''}
          ${r.used_backdate_exception ? '<span class="mini-tag warn">過去日提出の特例を使用</span>' : ''}
        </div>
        ${r.late_submission_reason ? `<div class="row2">事前申請できなかった理由: ${r.late_submission_reason}</div>` : ''}
        ${r.status === 'rejected' && r.rejection_reason ? `<div class="row2">却下理由: ${r.rejection_reason}</div>` : ''}
        <div class="qual-verify-btns">
          <button type="button" class="update-actuals-btn">実績を更新する</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.update-actuals-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => openEntertainmentUpdate(e.target.closest('.qual-item').dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

let entUpdateOurParticipantSelect = null;

async function openEntertainmentUpdate(id) {
  const session = getSession();
  document.getElementById('ent-update-id').value = id;
  hideError('ent-update-error');
  document.getElementById('ent-update-partner-participants').value = '';
  document.getElementById('ent-update-partner-count').value = '';
  document.getElementById('ent-update-note').value = '';
  document.getElementById('ent-update-planned-summary').textContent = '読み込み中...';
  document.getElementById('ent-update-history').innerHTML = '';
  showScreen('entertainment-update');

  const rows = await rpc('get_my_entertainment_preapprovals', { p_employee_code: session.employeeCode });
  const r = rows.find((x) => String(x.id) === String(id));
  if (r) {
    document.getElementById('ent-update-planned-summary').textContent =
      `当初の予定: ${new Date(r.planned_datetime).toLocaleString('ja-JP')}・${r.partner_name_snapshot || ''}・取引先${r.partner_participant_count ?? '-'}名/自社${r.our_participant_count ?? '-'}名`;
    document.getElementById('ent-update-partner-count').value = r.actual_partner_participant_count || '';
  }

  entUpdateOurParticipantSelect = createParticipantSelect(document.getElementById('ent-update-our-participants'));
  entUpdateOurParticipantSelect.setOnChange(() => {
    document.getElementById('ent-update-our-count').textContent = entUpdateOurParticipantSelect.getCount();
  });

  try {
    const changes = await rpc('get_entertainment_preapproval_changes', { p_employee_code: session.employeeCode, p_id: Number(id) });
    const historyEl = document.getElementById('ent-update-history');
    if (!changes || changes.length === 0) { historyEl.innerHTML = '<div class="hint">変更履歴はありません。</div>'; return; }
    historyEl.innerHTML = changes.map((c) => {
      const d = c.detail || {};
      let body = '';
      if (c.action === 'entertainment_preapproval_submitted') {
        body = `事前申請を提出(${d.submission_timing || ''})`;
      } else if (c.action === 'entertainment_preapproval_actuals_updated') {
        const parts = [];
        if (d.added && d.added.length) parts.push(`追加: ${d.added.join('、')}`);
        if (d.removed && d.removed.length) parts.push(`削除: ${d.removed.join('、')}`);
        if (d.old_partner_participants !== d.new_partner_participants) parts.push(`取引先参加者を変更`);
        body = `実績を更新${parts.length ? '(' + parts.join('・') + ')' : ''}${d.note ? '・' + d.note : ''}`;
      } else if (c.action === 'entertainment_preapproval_late_exception_approval') {
        body = `管理者が例外承認(理由: ${d.reason || ''})`;
      } else {
        body = c.action;
      }
      return `<div class="change-request-item"><div class="row1"><span>${body}</span></div><div class="row2">${c.actor_name}・${new Date(c.created_at).toLocaleString('ja-JP')}</div></div>`;
    }).join('');
  } catch (e) { /* 履歴が取れなくても更新フォームは使える */ }
}

async function doUpdateEntertainmentActuals() {
  const session = getSession();
  const id = document.getElementById('ent-update-id').value;
  const partnerParticipants = document.getElementById('ent-update-partner-participants').value.trim() || null;
  const partnerCount = Number(document.getElementById('ent-update-partner-count').value || 0);
  const note = document.getElementById('ent-update-note').value.trim() || null;
  hideError('ent-update-error');
  if (!partnerCount) { showError('ent-update-error', '取引先の参加人数を入力してください。'); return; }
  const ourCodes = entUpdateOurParticipantSelect ? entUpdateOurParticipantSelect.getSelectedCodes() : [];
  if (ourCodes.length === 0) { showError('ent-update-error', '自社参加者を選択してください。'); return; }

  const btn = document.getElementById('ent-update-submit');
  btn.disabled = true;
  try {
    await rpc('update_entertainment_preapproval_actuals', {
      p_employee_code: session.employeeCode, p_id: Number(id),
      p_actual_partner_participants: partnerParticipants, p_actual_partner_participant_count: partnerCount,
      p_actual_our_participant_employee_codes: ourCodes, p_note: note,
    });
    showScreen('my-entertainment');
  } catch (e) {
    showError('ent-update-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 接待事前申請の承認(管理者) ----------

async function loadEntertainmentAdminList() {
  const session = getSession();
  const status = document.getElementById('entertainment-admin-filter').value || null;
  const listEl = document.getElementById('entertainment-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_entertainment_preapprovals', { p_admin_employee_code: session.employeeCode, p_status: status });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する事前申請はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="qual-item" data-id="${r.id}">
        <div class="row1"><span>${r.employee_name}・${r.planned_store || '(店舗未記入)'}</span><span class="status-badge ${r.status === 'approved' ? 'done' : (r.status === 'rejected' ? 'rejected' : '')}">${ENT_STATUS_LABEL[r.status]}</span></div>
        <div class="row2">${new Date(r.planned_datetime).toLocaleString('ja-JP')}・${r.partner_name_snapshot || ''}(取引先${r.partner_participant_count ?? '-'}名/自社${r.our_participant_count ?? '-'}名)</div>
        <div class="row2">${r.purpose || ''}${r.planned_amount != null ? `・予定${Number(r.planned_amount).toLocaleString()}円` : ''}</div>
        <div class="row2">登録日時: ${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        <div class="employee-row-flags" style="margin-top:6px;">
          <span class="mini-tag ${ENT_TIMING_TAG_CLASS[r.submission_timing] || 'muted'}">${r.submission_timing || ''}</span>
          ${r.used_backdate_exception ? '<span class="mini-tag warn">本人に過去日提出の特例許可あり</span>' : ''}
        </div>
        ${r.requires_special_review ? `<div class="preapproval-warning">${icon('alert-triangle')}この接待は事前申請されていません。内容を確認のうえ、例外承認または却下してください。</div>` : ''}
        ${r.late_submission_reason ? `<div class="row2">本人が申告した「事前に申請できなかった理由」: ${r.late_submission_reason}</div>` : ''}
        ${r.exception_reason ? `<div class="row2">例外承認理由: ${r.exception_reason}</div>` : ''}
        ${r.status === 'rejected' && r.rejection_reason ? `<div class="row2">却下理由: ${r.rejection_reason}</div>` : ''}
        ${r.status === 'pending' ? `
          ${r.requires_special_review ? `
            <label>例外承認理由(管理者入力)<span class="required-mark">(必須)</span></label>
            <div class="hint-inline">申請者本人の説明ではなく、管理者が「なぜ事後でも承認するか」を記録する欄です</div>
            <textarea class="ent-exception-reason" placeholder="例: 先方都合で急遽実施、事前に把握はしていた"></textarea>
          ` : ''}
          <label>却下理由<span class="hint-inline" style="display:inline;">(任意、入力すると申請者に伝わります)</span></label>
          <textarea class="ent-reject-reason" placeholder="例: 業務関連性が確認できないため"></textarea>
          <div class="qual-verify-btns">
            <button type="button" class="approve-btn">${r.requires_special_review ? '例外承認する' : '承認する'}</button>
            <button type="button" class="reject-btn">却下する</button>
          </div>
        ` : ''}
      </div>
    `).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.qual-item');
        const reasonEl = item.querySelector('.ent-exception-reason');
        doDecideEntertainment(item.dataset.id, 'approved', reasonEl ? reasonEl.value.trim() : null);
      });
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const item = e.target.closest('.qual-item');
        const reasonEl = item.querySelector('.ent-reject-reason');
        doDecideEntertainment(item.dataset.id, 'rejected', reasonEl ? reasonEl.value.trim() : null);
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doDecideEntertainment(id, action, exceptionReason) {
  const session = getSession();
  try {
    await rpc('admin_decide_entertainment_preapproval', { p_admin_employee_code: session.employeeCode, p_id: Number(id), p_action: action, p_exception_reason: exceptionReason || null });
    await loadEntertainmentAdminList();
  } catch (e) {
    window.alert(e.message || '操作に失敗しました。');
  }
}

// ---------- 現場管理(管理者・日報担当) ----------

async function loadSiteAdminList() {
  const session = getSession();
  const listEl = document.getElementById('site-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_pending_sites', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">確認待ちの新規現場はありません。</div>'; return; }
    // 2026-08-28: 現場が見つからず日報等から自由入力された仮現場について、既存の類似現場候補
    // (admin_get_site_merge_candidates)を表示し、「新規登録」だけでなく「既存現場へ統合」も
    // その場で選べるようにする(表記揺れによる現場の重複作成を防ぐ、ユーザー指示)。
    const candidateLists = await Promise.all(rows.map((s) =>
      rpc('admin_get_site_merge_candidates', { p_admin_employee_code: session.employeeCode, p_site_id: s.id }).catch(() => [])));
    listEl.innerHTML = rows.map((s, i) => {
      const candidates = candidateLists[i] || [];
      const candidatesHtml = candidates.length > 0 ? `
        <div class="hint-inline" style="margin-top:6px;">似ている既存の現場:</div>
        ${candidates.map((c) => `
          <button type="button" class="secondary site-merge-btn" data-candidate-id="${c.candidate_site_id}" style="margin:2px 4px 0 0;">
            「${c.candidate_site_name}」へ統合(類似度${Math.round(c.similarity * 100)}%)
          </button>
        `).join('')}
      ` : '';
      return `
      <div class="qual-item" data-id="${s.id}">
        <div class="row1"><input type="text" class="site-rename-input" value="${s.site_name}"></div>
        <div class="row2">申請者: ${s.proposed_by_name ? `${s.proposed_by_name}(${s.proposed_by_code || '—'})` : '申請者不明'}</div>
        <div class="row2">申請日時: ${new Date(s.created_at).toLocaleString('ja-JP')}</div>
        ${candidatesHtml}
        <div class="qual-verify-btns">
          <button type="button" class="approve-btn">新規現場として承認する</button>
          <button type="button" class="reject-btn">却下する</button>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideSite(e.target.closest('.qual-item'), 'active'));
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doDecideSite(e.target.closest('.qual-item'), 'inactive'));
    });
    listEl.querySelectorAll('.site-merge-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.qual-item');
        const fromId = Number(item.dataset.id);
        const intoId = Number(btn.dataset.candidateId);
        btn.disabled = true;
        try {
          await rpc('admin_merge_sites', { p_admin_employee_code: session.employeeCode, p_from_site_id: fromId, p_into_site_id: intoId, p_reason: null });
          await loadSiteAdminList();
        } catch (e) { btn.disabled = false; window.alert(e.message || '統合に失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
  loadAllSitesList();
}

async function doDecideSite(itemEl, action) {
  const session = getSession();
  const id = itemEl.dataset.id;
  const renamedTo = itemEl.querySelector('.site-rename-input').value.trim();
  try {
    if (action === 'active' && renamedTo) {
      await rpc('admin_update_site_name', { p_admin_employee_code: session.employeeCode, p_site_id: Number(id), p_site_name: renamedTo });
    }
    await rpc('admin_decide_pending_site', { p_admin_employee_code: session.employeeCode, p_site_id: Number(id), p_action: action });
    await loadSiteAdminList();
  } catch (e) { /* 失敗時は一覧が更新されないだけ */ }
}

const JAPAN_PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
function populateSitePrefectureSelect(selectId) {
  const sel = document.getElementById(selectId || 'site-create-prefecture');
  if (sel.options.length > 1) return;
  JAPAN_PREFECTURES.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    sel.appendChild(opt);
  });
}

// ---------- 現場を登録申請(2026-08-28第4弾、一般社員向け) ----------

function resetProposeSiteForm() {
  document.getElementById('propose-site-name').value = '';
  document.getElementById('propose-site-notes').value = '';
  document.getElementById('propose-site-out-of-prefecture').checked = false;
  document.getElementById('propose-site-prefecture').value = '';
  document.getElementById('propose-site-candidates').style.display = 'none';
  hideError('propose-site-error');
  populateSitePrefectureSelect('propose-site-prefecture');
}

async function doProposeSite(forceCreate) {
  const session = getSession();
  const name = document.getElementById('propose-site-name').value.trim();
  const prefecture = document.getElementById('propose-site-prefecture').value || null;
  const isOutOfPrefecture = document.getElementById('propose-site-out-of-prefecture').checked;
  const notes = document.getElementById('propose-site-notes').value.trim() || null;
  const candidatesEl = document.getElementById('propose-site-candidates');
  hideError('propose-site-error');
  candidatesEl.style.display = 'none';
  if (!name) { showError('propose-site-error', '現場名を入力してください。'); return; }

  const btn = document.getElementById('propose-site-submit');
  btn.disabled = true;
  try {
    const result = await rpc('propose_new_site', {
      p_employee_code: session.employeeCode, p_site_name: name, p_prefecture: prefecture,
      p_is_out_of_prefecture: isOutOfPrefecture, p_notes: notes, p_force_create: !!forceCreate,
    });
    const r = result[0];
    if (r.created) {
      showDone('現場を登録申請しました。管理者の確認後、正式な現場になります。', 'menu-apply');
    } else if (r.similar_candidates) {
      document.getElementById('propose-site-candidates-list').innerHTML = r.similar_candidates.map((c) => `
        <button type="button" class="secondary propose-site-candidate-btn" data-site-id="${c.site_id}" style="display:block;width:100%;text-align:left;margin-top:6px;">
          「${c.site_name}」(類似度${Math.round(c.similarity * 100)}%)
        </button>
      `).join('');
      candidatesEl.style.display = 'block';
      document.querySelectorAll('.propose-site-candidate-btn').forEach((cbtn) => {
        cbtn.addEventListener('click', () => {
          showDone(`既存の現場「${cbtn.textContent.trim()}」を使ってください。新規登録はしていません。`, 'menu-apply');
        });
      });
    } else {
      showDone('既存の現場と同じ名前のため、その現場をそのまま使えます。新規登録はしていません。', 'menu-apply');
    }
  } catch (e) {
    showError('propose-site-error', e.message || '登録申請に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function doCreateSite(forceCreate) {
  const session = getSession();
  const nameInput = document.getElementById('site-create-name');
  const name = nameInput.value.trim();
  const candidatesEl = document.getElementById('site-create-candidates');
  hideError('site-create-error');
  candidatesEl.style.display = 'none';
  if (!name) { showError('site-create-error', '現場名を入力してください。'); return; }
  try {
    const result = await rpc('admin_register_site', {
      p_admin_employee_code: session.employeeCode, p_site_name: name,
      p_prefecture: document.getElementById('site-create-prefecture').value || null,
      p_address: document.getElementById('site-create-address').value.trim() || null,
      p_prime_contractor: document.getElementById('site-create-prime-contractor').value.trim() || null,
      p_planned_start_date: document.getElementById('site-create-start-date').value || null,
      p_planned_end_date: document.getElementById('site-create-end-date').value || null,
      p_force_create: !!forceCreate,
    });
    const r = result && result[0];
    if (r && r.similar_candidates && r.similar_candidates.length > 0) {
      candidatesEl.style.display = 'block';
      candidatesEl.innerHTML = `
        <div class="hint-inline" style="margin-top:8px;">似た現場が見つかりました。既存の現場ではありませんか？</div>
        ${r.similar_candidates.map((c) => `<div class="hint-inline">・${c.site_name}(類似度${Math.round(c.similarity * 100)}%)</div>`).join('')}
        <button type="button" class="secondary" id="site-create-force-btn" style="margin-top:6px;">それでも新規現場として登録する</button>
      `;
      document.getElementById('site-create-force-btn').addEventListener('click', () => doCreateSite(true));
      return;
    }
    nameInput.value = '';
    document.getElementById('site-create-prefecture').value = '';
    document.getElementById('site-create-address').value = '';
    document.getElementById('site-create-prime-contractor').value = '';
    document.getElementById('site-create-start-date').value = '';
    document.getElementById('site-create-end-date').value = '';
    await loadSiteAdminList();
    await loadAllSitesList();
  } catch (e) {
    showError('site-create-error', e.message || '登録に失敗しました。');
  }
}

let siteListQuery = '';
async function loadAllSitesList() {
  const session = getSession();
  const listEl = document.getElementById('site-all-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_sites', { p_admin_employee_code: session.employeeCode, p_include_inactive: true, p_query: siteListQuery || null });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する現場はありません。</div>'; return; }
    const statusLabel = { active: '有効', pending: '承認待ち', inactive: '無効', merged: '統合済み' };
    listEl.innerHTML = rows.map((s) => `
      <div class="qual-item" data-id="${s.id}">
        <div class="row1"><input type="text" class="site-rename-input" value="${s.site_name}"><span class="mini-tag ${s.status === 'active' ? 'info' : (s.status === 'pending' ? 'danger' : '')}">${statusLabel[s.status] || s.status}</span></div>
        <div class="qual-verify-btns">
          <button type="button" class="site-save-btn">名前を保存</button>
          ${s.status === 'active' || s.status === 'inactive' ? `<button type="button" class="reject-btn toggle-site-active-btn" data-active="${s.status === 'active'}">${s.status === 'active' ? '無効化する(アーカイブ)' : '有効化する'}</button>` : ''}
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.site-save-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const item = e.target.closest('.qual-item');
        const newName = item.querySelector('.site-rename-input').value.trim();
        if (!newName) return;
        try {
          await rpc('admin_update_site_name', { p_admin_employee_code: session.employeeCode, p_site_id: Number(item.dataset.id), p_site_name: newName });
          await loadAllSitesList();
        } catch (e2) { window.alert(e2.message || '保存に失敗しました。'); }
      });
    });
    listEl.querySelectorAll('.toggle-site-active-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const item = e.target.closest('.qual-item');
        const willActivate = btn.dataset.active !== 'true';
        if (!willActivate && !window.confirm('この現場を無効化します。過去の日報・経費等のデータはそのまま残り、日報の現場選択肢にだけ表示されなくなります。よろしいですか？')) return;
        try {
          await rpc('admin_set_site_active', { p_admin_employee_code: session.employeeCode, p_site_id: Number(item.dataset.id), p_is_active: willActivate });
          await loadAllSitesList();
        } catch (e2) { window.alert(e2.message || '切り替えに失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 端末承認(管理者、2026-08-28セキュリティ強化) ----------

async function loadDeviceApprovalList() {
  const session = getSession();
  const listEl = document.getElementById('device-approval-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_pending_devices', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">承認待ちの端末はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="qual-item" data-id="${r.device_id}">
        <div class="row1"><span>${r.employee_name}(${r.employee_code})</span><span class="mini-tag danger">承認待ち</span></div>
        <div class="row2">申請日時: ${new Date(r.created_at).toLocaleString('ja-JP')}・既存の承認済み端末: ${r.existing_approved_count}台</div>
        <div class="qual-verify-btns">
          <button type="button" class="approve-btn">承認する</button>
          <button type="button" class="reject-btn">却下する</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.target.closest('.qual-item').dataset.id);
        try { await rpc('admin_decide_device_approval', { p_admin_employee_code: session.employeeCode, p_device_id: id, p_action: 'approve' }); await loadDeviceApprovalList(); }
        catch (e2) { window.alert(e2.message || '承認に失敗しました。'); }
      });
    });
    listEl.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.target.closest('.qual-item').dataset.id);
        if (!window.confirm('この端末からの利用申請を却下します。よろしいですか？')) return;
        try { await rpc('admin_decide_device_approval', { p_admin_employee_code: session.employeeCode, p_device_id: id, p_action: 'reject' }); await loadDeviceApprovalList(); }
        catch (e2) { window.alert(e2.message || '却下に失敗しました。'); }
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// ---------- 免許種別マスター管理(管理者) ----------

function resetLicenseTypeForm() {
  document.getElementById('license-type-edit-id').value = '';
  document.getElementById('license-type-name').value = '';
  document.getElementById('license-type-sort').value = '100';
  hideError('license-type-error');
}

async function loadLicenseTypeAdminList() {
  const session = getSession();
  const listEl = document.getElementById('license-type-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetLicenseTypeForm();
  try {
    const rows = await rpc('admin_list_license_types', { p_admin_employee_code: session.employeeCode });
    listEl.innerHTML = rows.map((t) => `
      <div class="supply-item" data-id="${t.id}" style="${t.active ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${t.type_name}</span><span>${t.active ? '有効' : '停止中'}</span></div>
        <div class="row2">表示順${t.sort_order}</div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-license-btn" data-name="${t.type_name}" data-sort="${t.sort_order}">編集</button>
          <button type="button" class="reject-btn toggle-license-btn" data-active="${t.active}">${t.active ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-license-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('license-type-edit-id').value = item.dataset.id;
        document.getElementById('license-type-name').value = btn.dataset.name;
        document.getElementById('license-type-sort').value = btn.dataset.sort;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-license-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_license_type_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadLicenseTypeAdminList();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveLicenseType() {
  const session = getSession();
  const id = document.getElementById('license-type-edit-id').value;
  const name = document.getElementById('license-type-name').value.trim();
  const sort = Number(document.getElementById('license-type-sort').value || 100);
  hideError('license-type-error');
  if (!name) { showError('license-type-error', '種別名を入力してください。'); return; }
  const btn = document.getElementById('license-type-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_license_type', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_type_name: name, p_sort_order: sort });
    await loadLicenseTypeAdminList();
  } catch (e) {
    showError('license-type-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 健康診断管理(管理者) ----------

let healthAdminFilter = '';

async function loadHealthAdminList() {
  const session = getSession();
  const listEl = document.getElementById('health-admin-warning-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_health_warnings', { p_admin_employee_code: session.employeeCode, p_filter: healthAdminFilter || null });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する社員はいません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="employee-row" data-code="${r.employee_code}">
        <div class="employee-avatar">${(r.employee_name || '?').charAt(0)}</div>
        <div class="employee-row-body">
          <div class="employee-row-name">${r.employee_name}</div>
          <div class="employee-row-meta">${r.last_checkup_date ? `最終受診: ${new Date(r.last_checkup_date).toLocaleDateString('ja-JP')}` : '未受診'}${r.next_due_date ? `・次回: ${new Date(r.next_due_date).toLocaleDateString('ja-JP')}` : ''}</div>
          <div class="employee-row-flags">
            ${r.is_overdue ? '<span class="mini-tag danger">期限超過</span>' : ''}
            ${r.needs_retest ? '<span class="mini-tag warn">再検査確認待ち</span>' : ''}
          </div>
        </div>
        <span style="color:var(--text-faint);">${icon('chevron-right')}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.employee-row').forEach((el) => {
      el.addEventListener('click', () => openEmployeeDetail(el.dataset.code, 'qual'));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveAdminHealthRecord() {
  const session = getSession();
  const date = document.getElementById('health-admin-date').value;
  hideError('health-admin-error');
  if (!date) { showError('health-admin-error', '受診日を入力してください。'); return; }
  const btn = document.getElementById('health-admin-submit');
  btn.disabled = true;
  try {
    await rpc('admin_record_health_checkup', {
      p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode,
      p_checkup_date: date, p_checkup_type: document.getElementById('health-admin-type').value.trim() || null,
      p_institution: document.getElementById('health-admin-institution').value.trim() || null,
      p_next_due_date: document.getElementById('health-admin-next').value || null,
      p_result_confirmed: document.getElementById('health-admin-confirmed').checked,
      p_needs_retest: document.getElementById('health-admin-retest').checked,
      p_note: document.getElementById('health-admin-note').value.trim() || null,
    });
    showScreen('employee-detail');
    await loadEmployeeDetailQual();
  } catch (e) {
    showError('health-admin-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 日報(社員) ----------
// 社員が人工を直接入力することは一切ない。現場と勤務区分(終日/午前/午後)を選ぶと、
// 人工(終日=1.0・午前後=各0.5)は画面表示・送信ともにJS側で自動計算する。
// 通常は1〜2現場まで(2現場の場合は午前+午後の組み合わせのみ)。3現場以上は入力自体は
// 止めず「特殊日報」として送信できるが、通常のスプレッドシート反映対象からは外れ、
// 管理者確認キュー(daily-report-admin)へ回る。

const DR_HEADCOUNT_BY_WORK_TYPE = { '終日': 1.0, '午前': 0.5, '午後': 0.5 };
let dailyReportEntrySeq = 0;
let dailyReportQualAttachment = null; // { driveFileId, driveFileUrl } (資格証の写真/PDF、任意)
// 代理入力の対象(本人以外の社員、または外注作業員)。self以外はnippo_admin/executiveのみ選べる。
let dailyReportTarget = { type: 'self', employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
let dailyReportIsNippoAdmin = false;
let dailyReportTargetIsDriver = false;
// 通勤早出・残業・現場・営業・運搬・資格取得を、社員名をコードへ埋め込まず社員マスタの
// フラグ(employees.can_overtime等)で対象者制御するための現在値。
let dailyReportPermissions = { is_driver: false, can_overtime: false, can_input_site_duty: false, can_input_sales: false, can_input_transport: false, can_input_qualification: false };

async function refreshDailyReportTargetIsDriver() {
  const session = getSession();
  if (dailyReportTarget.type === 'subcontractor') {
    dailyReportTargetIsDriver = false;
    dailyReportPermissions = { is_driver: false, can_overtime: false, can_input_site_duty: false, can_input_sales: false, can_input_transport: false, can_input_qualification: false };
    return;
  }
  const code = dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : session.employeeCode;
  if (!code) { dailyReportTargetIsDriver = false; return; }
  try {
    const rows = await rpc('get_my_daily_report_permissions', { p_employee_code: session.employeeCode, p_target_employee_code: code });
    dailyReportPermissions = (rows && rows[0]) || dailyReportPermissions;
    dailyReportTargetIsDriver = !!dailyReportPermissions.is_driver;
  } catch (e) {
    dailyReportTargetIsDriver = false;
    dailyReportPermissions = { is_driver: false, can_overtime: false, can_input_site_duty: false, can_input_sales: false, can_input_transport: false, can_input_qualification: false };
  }
}

function addDailyReportEntry(prefill) {
  const template = document.getElementById('daily-report-entry-template');
  const clone = template.content.cloneNode(true);
  hydrateIcons(clone);
  const entryId = `dr-entry-${++dailyReportEntrySeq}`;
  const wrap = clone.querySelector('.daily-report-entry');
  wrap.dataset.entryId = entryId;

  const siteSelect = clone.querySelector('.dr-site-select');
  const siteSearch = clone.querySelector('.dr-site-search');
  const newSiteWrap = clone.querySelector('.dr-new-site-wrap');
  const newSiteToggleBtn = clone.querySelector('.dr-new-site-toggle-btn');
  populateSiteSelect(siteSelect, '', true).then(() => {
    if (prefill && prefill.site_id) siteSelect.value = String(prefill.site_id);
  });
  siteSearch.addEventListener('input', () => populateSiteSelect(siteSelect, siteSearch.value.trim(), true));
  siteSelect.addEventListener('change', () => {
    if (siteSelect.value === '__new__') newSiteWrap.style.display = 'block';
  });
  newSiteToggleBtn.addEventListener('click', () => {
    siteSelect.value = '__new__';
    newSiteWrap.style.display = 'block';
    wrap.querySelector('.dr-new-site-name').focus();
  });

  const workTypeSelect = clone.querySelector('.dr-work-type');
  if (prefill && prefill.work_type) workTypeSelect.value = prefill.work_type;
  workTypeSelect.addEventListener('change', updateDailyReportTotal);
  if (prefill && prefill.is_leader) clone.querySelector('.dr-is-leader').checked = true;
  if (prefill && prefill.is_night_shift) clone.querySelector('.dr-is-night-shift').checked = true;
  if (prefill && prefill.notes) clone.querySelector('.dr-notes').value = prefill.notes;
  if (prefill && prefill.overtime_hours != null) clone.querySelector('.dr-overtime-hours').value = prefill.overtime_hours;
  if (prefill && prefill.is_early_commute) clone.querySelector('.dr-is-early-commute').checked = true;
  if (prefill && prefill.is_commute_overtime) clone.querySelector('.dr-is-commute-overtime').checked = true;
  if (prefill && prefill.early_commute_hours != null) clone.querySelector('.dr-early-commute-hours').value = prefill.early_commute_hours;
  if (prefill && prefill.commute_overtime_hours != null) clone.querySelector('.dr-commute-overtime-hours').value = prefill.commute_overtime_hours;
  if (prefill && prefill.is_over_100km) clone.querySelector('.dr-is-over-100km').checked = true;
  const isBusinessTripEl = clone.querySelector('.dr-is-business-trip');
  const overnightWrap = clone.querySelector('.dr-overnight-wrap');
  const isOvernightEl = clone.querySelector('.dr-is-overnight');
  const overnightNightsWrap = clone.querySelector('.dr-overnight-nights-wrap');
  const overnightNightsEl = clone.querySelector('.dr-overnight-nights');
  if (prefill && prefill.is_business_trip) isBusinessTripEl.checked = true;
  if (prefill && prefill.is_overnight) isOvernightEl.checked = true;
  if (prefill && prefill.overnight_nights != null) overnightNightsEl.value = prefill.overnight_nights;
  overnightWrap.style.display = isBusinessTripEl.checked ? 'block' : 'none';
  overnightNightsWrap.style.display = isOvernightEl.checked ? 'block' : 'none';
  isBusinessTripEl.addEventListener('change', () => {
    overnightWrap.style.display = isBusinessTripEl.checked ? 'block' : 'none';
    if (!isBusinessTripEl.checked) { isOvernightEl.checked = false; overnightNightsWrap.style.display = 'none'; }
  });
  isOvernightEl.addEventListener('change', () => {
    overnightNightsWrap.style.display = isOvernightEl.checked ? 'block' : 'none';
  });
  if (prefill && prefill.is_transport) clone.querySelector('.dr-is-transport').checked = true;
  if (prefill && prefill.is_field_duty) clone.querySelector('.dr-is-field-duty').checked = true;
  if (prefill && prefill.is_sales) clone.querySelector('.dr-is-sales').checked = true;
  // 対象者フラグに基づき、該当する社員(または代理入力対象)にだけ各項目を表示する
  // (氏名のハードコードではなく社員マスタの権限フラグで判定する)。
  clone.querySelector('.dr-driver-fields').style.display = dailyReportTargetIsDriver ? 'block' : 'none';
  clone.querySelector('.dr-overtime-wrap').style.display = dailyReportPermissions.can_overtime ? 'block' : 'none';
  const canOtherDuty = dailyReportPermissions.can_input_site_duty || dailyReportPermissions.can_input_sales || dailyReportPermissions.can_input_transport;
  clone.querySelector('.dr-other-duty-group').style.display = canOtherDuty ? 'block' : 'none';
  clone.querySelector('.dr-site-duty-wrap').style.display = dailyReportPermissions.can_input_site_duty ? 'block' : 'none';
  clone.querySelector('.dr-sales-wrap').style.display = dailyReportPermissions.can_input_sales ? 'block' : 'none';
  clone.querySelector('.dr-transport-wrap').style.display = dailyReportPermissions.can_input_transport ? 'block' : 'none';

  clone.querySelector('.dr-remove-entry-btn').addEventListener('click', () => {
    document.querySelector(`[data-entry-id="${entryId}"]`).remove();
    updateDailyReportTotal();
  });

  document.getElementById('daily-report-entry-list').appendChild(clone);
  updateDailyReportTotal();
}

// ================= 外注（応援）人数の登録(P0-3) =================
// 職長が自分の日報登録時に、当日その現場へ入った外注を「会社+人数」で登録する。社員自身の日報
// (submit_daily_report)には手を加えず、独立RPC submit_subcontractor_headcount_report を使う。
let drScCompanies = null;
async function loadDrScCompanies() {
  if (drScCompanies) return drScCompanies;
  try {
    const session = getSession();
    const rows = await rpc('assignment_list_subcontractor_companies', { p_employee_code: session.employeeCode });
    drScCompanies = Array.isArray(rows) ? rows : [];
  } catch (e) { drScCompanies = []; }
  return drScCompanies;
}
// §7: 1行 = 会社×現場 につき 終日/午前/午後 の人数を同時入力。人工 = 終日×1.0 + (午前+午後)×0.5。
function updateDrScTotals() {
  let people = 0; let hc = 0;
  document.querySelectorAll('#dr-sc-list .dr-sc-entry').forEach((el) => {
    const fd = Number(el.querySelector('.dr-sc-fullday').value) || 0;
    const am = Number(el.querySelector('.dr-sc-am').value) || 0;
    const pm = Number(el.querySelector('.dr-sc-pm').value) || 0;
    const rowPeople = fd + am + pm;
    const rowHc = fd * 1.0 + (am + pm) * 0.5;
    people += rowPeople; hc += rowHc;
    const sum = el.querySelector('.dr-sc-row-summary');
    if (sum) sum.textContent = `合計 ${rowPeople}名 / ${String(rowHc).replace(/\.0$/, '')}人工`;
  });
  const p = document.getElementById('dr-sc-total-people'); const h = document.getElementById('dr-sc-total-headcount');
  if (p) p.textContent = String(people);
  if (h) h.textContent = String(hc).replace(/\.0$/, '');
}
async function addDailyReportSubcontractorLine(prefill) {
  const tmpl = document.getElementById('dr-sc-entry-template');
  const clone = tmpl.content.cloneNode(true);
  const wrap = clone.querySelector('.dr-sc-entry');
  const companySel = clone.querySelector('.dr-sc-company');
  const companies = await loadDrScCompanies();
  companySel.innerHTML = '<option value="">選択してください</option>' + companies.map((c) => `<option value="${c.id}">${c.company_name}</option>`).join('');
  if (prefill && prefill.subcontractor_company_id) companySel.value = String(prefill.subcontractor_company_id);
  const siteSel = clone.querySelector('.dr-sc-site-select');
  const siteSearch = clone.querySelector('.dr-sc-site-search');
  populateSiteSelect(siteSel, '', false).then(() => { if (prefill && prefill.site_id) siteSel.value = String(prefill.site_id); });
  siteSearch.addEventListener('input', () => populateSiteSelect(siteSel, siteSearch.value.trim(), false));
  const fdInput = clone.querySelector('.dr-sc-fullday');
  const amInput = clone.querySelector('.dr-sc-am');
  const pmInput = clone.querySelector('.dr-sc-pm');
  if (prefill) {
    if (prefill.fullday != null) fdInput.value = prefill.fullday;
    if (prefill.am != null) amInput.value = prefill.am;
    if (prefill.pm != null) pmInput.value = prefill.pm;
  }
  if (prefill && prefill.notes) clone.querySelector('.dr-sc-notes').value = prefill.notes;
  [fdInput, amInput, pmInput].forEach((inp) => inp.addEventListener('input', updateDrScTotals));
  clone.querySelector('.dr-sc-remove').addEventListener('click', () => { wrap.remove(); updateDrScTotals(); });
  document.getElementById('dr-sc-list').appendChild(clone);
  updateDrScTotals();
}
async function loadDrScSection(dateStr) {
  const card = document.getElementById('daily-report-subcontractor-card');
  if (!card) return;
  // §6: 外注（応援）は「誰の日報」で外注（応援）を選んだ時だけ表示する専用モード。
  // 通常社員フォームは別途 setDailyReportMode で非表示にする(外注選択時は通常フォームを出さない)。
  const showIt = (dailyReportTarget.type === 'subcontractor_support');
  card.style.display = showIt ? '' : 'none';
  if (!showIt) return;
  const list = document.getElementById('dr-sc-list');
  list.innerHTML = '';
  document.getElementById('dr-sc-status').textContent = '';
  hideError('dr-sc-error');
  try {
    const session = getSession();
    const rows = await rpc('get_my_subcontractor_headcount_report', { p_employee_code: session.employeeCode, p_report_date: dateStr });
    if (rows && rows.length > 0) {
      // 既存(company×site×work_type別)を、会社×現場ごとに 終日/午前/午後 の1行へ集約してprefillする。
      const grouped = new Map();
      for (const r of rows) {
        const key = `${r.subcontractor_company_id}__${r.site_id}`;
        if (!grouped.has(key)) grouped.set(key, { subcontractor_company_id: r.subcontractor_company_id, site_id: r.site_id, fullday: 0, am: 0, pm: 0, notes: r.notes });
        const g = grouped.get(key);
        const n = Number(r.subcontractor_headcount != null ? r.subcontractor_headcount : r.headcount) || 0;
        if (r.work_type === '午前') g.am += n; else if (r.work_type === '午後') g.pm += n; else g.fullday += n;
      }
      for (const g of grouped.values()) {
        // eslint-disable-next-line no-await-in-loop
        await addDailyReportSubcontractorLine(g);
      }
    }
  } catch (e) { /* 取得失敗でも新規追加は可能 */ }
  if (document.querySelectorAll('#dr-sc-list .dr-sc-entry').length === 0) await addDailyReportSubcontractorLine();
  updateDrScTotals();
}
async function doSubmitSubcontractorHeadcount() {
  const session = getSession();
  hideError('dr-sc-error');
  const dateStr = document.getElementById('daily-report-date').value;
  if (!dateStr) { showError('dr-sc-error', '日付を選択してください。'); return; }
  const entries = [];
  for (const el of document.querySelectorAll('#dr-sc-list .dr-sc-entry')) {
    const companyId = el.querySelector('.dr-sc-company').value;
    const siteId = el.querySelector('.dr-sc-site-select').value;
    const notes = el.querySelector('.dr-sc-notes').value.trim() || null;
    const fd = Number(el.querySelector('.dr-sc-fullday').value) || 0;
    const am = Number(el.querySelector('.dr-sc-am').value) || 0;
    const pm = Number(el.querySelector('.dr-sc-pm').value) || 0;
    if (!companyId) { showError('dr-sc-error', '外注会社を選択してください。'); return; }
    if (!siteId || siteId === '__new__') { showError('dr-sc-error', '外注の現場を選択してください。'); return; }
    if (fd + am + pm < 1) { showError('dr-sc-error', '終日・午前・午後のいずれかに人数を入力してください。'); return; }
    // §7/§8: 1行(会社×現場)を 終日/午前/午後 の勤務区分ごとに分けて保存する(人数>0のみ)。
    if (fd > 0) entries.push({ company_id: companyId, headcount: String(fd), site_id: siteId, work_type: '終日', is_night_shift: false, notes });
    if (am > 0) entries.push({ company_id: companyId, headcount: String(am), site_id: siteId, work_type: '午前', is_night_shift: false, notes });
    if (pm > 0) entries.push({ company_id: companyId, headcount: String(pm), site_id: siteId, work_type: '午後', is_night_shift: false, notes });
  }
  if (entries.length === 0) { showError('dr-sc-error', '外注を1件以上追加してください。'); return; }
  const btn = document.getElementById('dr-sc-submit');
  btn.disabled = true;
  try {
    const r = await rpc('submit_subcontractor_headcount_report', { p_actor_employee_code: session.employeeCode, p_report_date: dateStr, p_entries: entries });
    const info = Array.isArray(r) ? r[0] : r;
    document.getElementById('dr-sc-status').textContent = `登録しました（${info.entry_count}社・合計${info.total_people}名・${Number(info.total_headcount)}人工）`;
  } catch (e) {
    showError('dr-sc-error', e.message || '外注の登録に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ワンタップで現場を差し込む(昨日と同じ現場・よく使う現場)。空の入力欄が無ければ1件追加してから入れる。
function applyRecentSiteToEntry(siteId, siteName) {
  let entryEls = Array.from(document.querySelectorAll('.daily-report-entry'));
  let target = entryEls.find((el) => !el.querySelector('.dr-site-select').value);
  if (!target) {
    if (entryEls.length >= 2) return; // 通常は最大2現場
    addDailyReportEntry();
    entryEls = Array.from(document.querySelectorAll('.daily-report-entry'));
    target = entryEls[entryEls.length - 1];
  }
  const select = target.querySelector('.dr-site-select');
  populateSiteSelect(select, siteName, true).then(() => { select.value = String(siteId); });
}

// 日報の対象日について、配置カレンダー(別プロジェクト)に登録された本人の配置先を
// 「タップで現場を入れられるチップ」として提示する(2026-08-31、Shota指示: 打ちやすくするため)。
// 既存の applyRecentSiteToEntry / チップUI をそのまま再利用する(重複実装しない)。
// 「昨日の現場」チップ(loadDailyReportRecentSites)と同じ仕組み・見た目で、出典が配置予定なだけ。
// 配置テーブルが無い環境(Production)や本人以外(外注代理入力)ではエリアを隠すだけ。
async function loadDailyReportAssignmentChips(dateStr) {
  const area = document.getElementById('daily-report-assignment-sites');
  const row = document.getElementById('daily-report-assignment-sites-row');
  if (!area || !row) return;
  // 本人・社員の日報のみ対象(外注作業員の代理入力は配置カレンダーの社員配置とは別)。
  if (dailyReportTarget.type === 'subcontractor') { area.style.display = 'none'; return; }
  const code = dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : getSession().employeeCode;
  try {
    const rows = normalizeSchedule(await rpc('assignment_get_my_schedule', { p_employee_code: code, p_date_from: dateStr, p_date_to: dateStr }));
    // site_idがある配置だけをチップにする(現場未設定・休み等は日報の現場入力には使えない)。
    const withSite = rows.filter((r) => r && r.site_id && r.assignment_kind !== 'off');
    if (withSite.length === 0) { area.style.display = 'none'; row.innerHTML = ''; return; }
    // 同一現場の重複を除く
    const seen = new Set();
    const uniq = withSite.filter((r) => { const k = String(r.site_id); if (seen.has(k)) return false; seen.add(k); return true; });
    area.style.display = 'block';
    row.innerHTML = uniq.map((r) => {
      const haul = r.assignment_kind === 'haul' ? '🚚 ' : '';
      const name = safeText(r.label, '現場');
      return `<button type="button" class="filter-chip dr-assignment-site-chip" data-site-id="${r.site_id}" data-site-name="${String(name).replace(/"/g, '&quot;')}">📍 ${name}${haul ? '（運搬）' : ''}</button>`;
    }).join('');
    row.querySelectorAll('.dr-assignment-site-chip').forEach((btn) => {
      btn.addEventListener('click', () => applyRecentSiteToEntry(btn.dataset.siteId, btn.dataset.siteName));
    });
  } catch (e) {
    // 配置テーブルが無い/RPC未デプロイの環境ではエラーになる。エリアを隠すだけで日報入力は通常通り。
    area.style.display = 'none'; row.innerHTML = '';
  }
}

async function loadDailyReportRecentSites() {
  const area = document.getElementById('daily-report-recent-sites');
  const row = document.getElementById('daily-report-recent-sites-row');
  const params = dailyReportTarget.type === 'subcontractor'
    ? { p_employee_code: null, p_worker_type: 'subcontractor', p_subcontractor_worker_id: dailyReportTarget.subcontractorWorkerId }
    : { p_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : getSession().employeeCode, p_worker_type: 'employee', p_subcontractor_worker_id: null };
  if (dailyReportTarget.type === 'subcontractor' && !dailyReportTarget.subcontractorWorkerId) { area.style.display = 'none'; return; }
  try {
    const rows = await rpc('get_recent_daily_report_sites', params);
    if (!rows || rows.length === 0) { area.style.display = 'none'; return; }
    area.style.display = 'block';
    row.innerHTML = rows.map((r) => `
      <button type="button" class="filter-chip dr-recent-site-chip" data-site-id="${r.site_id}" data-site-name="${r.site_name}">${r.is_yesterday ? '昨日: ' : ''}${r.site_name}</button>
    `).join('');
    row.querySelectorAll('.dr-recent-site-chip').forEach((btn) => {
      btn.addEventListener('click', () => applyRecentSiteToEntry(btn.dataset.siteId, btn.dataset.siteName));
    });
  } catch (e) { area.style.display = 'none'; }
}

function updateDailyReportTotal() {
  const entries = document.querySelectorAll('.daily-report-entry');
  let total = 0;
  entries.forEach((el) => { total += DR_HEADCOUNT_BY_WORK_TYPE[el.querySelector('.dr-work-type').value] || 0; });
  document.getElementById('daily-report-total-headcount').textContent = total.toFixed(1);
  document.getElementById('daily-report-special-warning').style.display = entries.length >= 3 ? 'block' : 'none';
}

// 代理入力の対象に応じてget_my_daily_report_for_date相当のデータを取る。
// 本人以外はadmin_search_daily_reportsで代用する(1日分だけに絞り込む)。
async function fetchDailyReportForTarget(dateStr) {
  const session = getSession();
  if (dailyReportTarget.type === 'self') {
    return rpc('get_my_daily_report_for_date', { p_employee_code: session.employeeCode, p_report_date: dateStr });
  }
  const rows = await rpc('admin_search_daily_reports', {
    p_admin_employee_code: session.employeeCode, p_date_from: dateStr, p_date_to: dateStr,
    p_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : null,
    p_site_id: null, p_validation_status: null,
    p_worker_type: dailyReportTarget.type === 'subcontractor' ? 'subcontractor' : 'employee',
    p_subcontractor_company_id: null, p_report_status: null,
  });
  const filtered = dailyReportTarget.type === 'subcontractor'
    ? rows.filter((r) => r.subcontractor_worker_name === dailyReportTarget.workerName)
    : rows;
  return filtered.map((r) => ({
    site_id: r.site_id, work_type: r.work_type, reflected: !!r.reflected_to_sheet_at,
    report_status: r.report_status, is_leader: r.is_leader, is_night_shift: r.is_night_shift, notes: r.notes,
    overtime_hours: r.overtime_hours, is_early_commute: r.is_early_commute, is_commute_overtime: r.is_commute_overtime,
    is_over_100km: r.is_over_100km, is_transport: r.is_transport,
    is_field_duty: r.is_field_duty, is_sales: r.is_sales,
    early_commute_hours: r.early_commute_hours, commute_overtime_hours: r.commute_overtime_hours,
  }));
}

async function loadDailyReportForDate(dateStr) {
  const hint = document.getElementById('daily-report-existing-hint');
  const submitBtn = document.getElementById('daily-report-submit');
  const addBtn = document.getElementById('daily-report-add-entry');
  hint.style.display = 'none';
  submitBtn.disabled = false;
  addBtn.disabled = false;
  document.getElementById('daily-report-entry-list').innerHTML = '';
  dailyReportEntrySeq = 0;
  await refreshDailyReportTargetIsDriver();
  document.getElementById('daily-report-qual-wrap').style.display = dailyReportPermissions.can_input_qualification ? 'block' : 'none';
  document.getElementById('daily-report-has-qualification').checked = false;
  document.getElementById('daily-report-qual-fields').style.display = 'none';
  document.getElementById('daily-report-qual-name').value = '';
  document.getElementById('daily-report-qual-date').value = dateStr;
  document.getElementById('daily-report-qual-file-label').textContent = '撮影・選択する';
  document.getElementById('daily-report-qual-file-status').textContent = '';
  dailyReportQualAttachment = null;
  loadDailyReportRecentSites();
  loadDailyReportAssignmentChips(dateStr);
  loadDrScSection(dateStr);

  let existing = [];
  try {
    existing = await fetchDailyReportForTarget(dateStr);
  } catch (e) { /* 取得できなくても新規入力は続けられる */ }

  if (existing.length > 0) {
    const reflected = existing[0].reflected;
    hint.style.display = 'block';
    if (reflected) {
      hint.textContent = 'この日の日報は既にスプレッドシートへ反映済みです。内容を修正すると再反映されます。';
    } else {
      hint.textContent = 'この日は入力済みです。内容を修正して「日報を提出する」を押すと上書きされます。';
    }
    // 以前は残業/通勤早出/通勤残業/通勤100km超/現場作業/営業/運搬を再表示用に渡し忘れており、
    // DBには正しく保存されているのに再読み込みすると入力欄が空に見える不具合があった
    // (保存自体は既存のまま無事故だった)。existingの全項目をそのままprefillへ渡す。
    existing.forEach((e) => addDailyReportEntry({
      site_id: e.site_id, work_type: e.work_type, is_leader: e.is_leader, is_night_shift: e.is_night_shift, notes: e.notes,
      overtime_hours: e.overtime_hours, is_early_commute: e.is_early_commute, is_commute_overtime: e.is_commute_overtime,
      early_commute_hours: e.early_commute_hours, commute_overtime_hours: e.commute_overtime_hours,
      is_over_100km: e.is_over_100km, is_transport: e.is_transport, is_field_duty: e.is_field_duty, is_sales: e.is_sales,
      is_business_trip: e.is_business_trip, is_overnight: e.is_overnight, overnight_nights: e.overnight_nights,
    }));
  } else {
    addDailyReportEntry();
  }
}

async function resetDailyReportForm() {
  hideError('daily-report-error');
  const session = getSession();
  dailyReportTarget = { type: 'self', employeeCode: session.employeeCode, employeeName: session.employeeName, subcontractorWorkerId: null, workerName: null };
  document.getElementById('daily-report-target-type').value = 'self';
  document.getElementById('daily-report-target-employee-wrap').style.display = 'none';
  document.getElementById('daily-report-target-worker-wrap').style.display = 'none';

  try {
    dailyReportIsNippoAdmin = await rpc('check_nippo_admin', { p_employee_code: session.employeeCode });
  } catch (e) { dailyReportIsNippoAdmin = false; }
  document.getElementById('daily-report-proxy-wrap').style.display = dailyReportIsNippoAdmin ? 'block' : 'none';

  const dateInput = document.getElementById('daily-report-date');
  // 日報履歴の詳細画面から「この日の内容を修正する」で来た場合は、今日ではなくその日を開く
  // (resetDailyReportFormは画面遷移のたびに自動で走るため、ここで両方が競合してentryが
  // 二重に読み込まれる不具合を避けるため、ここで一本化する)。
  const target = dailyReportPrefillDate || todayJST();
  dailyReportPrefillDate = null;
  dateInput.value = target;
  loadDailyReportForDate(target);
}

async function doSubmitDailyReport(isDraft) {
  const session = getSession();
  hideError('daily-report-error');
  const dateStr = document.getElementById('daily-report-date').value;
  if (!dateStr) { showError('daily-report-error', '日付を選択してください。'); return; }

  if (dailyReportTarget.type === 'employee' && !dailyReportTarget.employeeCode) { showError('daily-report-error', '代理入力する社員を選択してください。'); return; }
  if (dailyReportTarget.type === 'subcontractor' && !dailyReportTarget.subcontractorWorkerId) { showError('daily-report-error', '外注作業員を選択してください。'); return; }

  const entryEls = Array.from(document.querySelectorAll('.daily-report-entry'));
  if (entryEls.length === 0) { showError('daily-report-error', '現場を1件以上入力してください。'); return; }

  const entries = [];
  for (const el of entryEls) {
    const siteSelect = el.querySelector('.dr-site-select');
    let siteId = siteSelect.value || null;
    let newSiteName = null;
    if (siteId === '__new__') {
      newSiteName = el.querySelector('.dr-new-site-name').value.trim();
      if (!newSiteName) { showError('daily-report-error', '新しい現場名を入力してください。'); return; }
      siteId = null;
    } else if (!siteId) {
      showError('daily-report-error', '現場を選択してください。'); return;
    }
    const overtimeVal = el.querySelector('.dr-overtime-hours').value;
    const earlyCommuteChecked = el.querySelector('.dr-is-early-commute').checked;
    const commuteOvertimeChecked = el.querySelector('.dr-is-commute-overtime').checked;
    const earlyCommuteHoursVal = el.querySelector('.dr-early-commute-hours').value;
    const commuteOvertimeHoursVal = el.querySelector('.dr-commute-overtime-hours').value;
    if (earlyCommuteChecked && !earlyCommuteHoursVal) { showError('daily-report-error', '通勤早出の時間を入力してください。'); return; }
    if (commuteOvertimeChecked && !commuteOvertimeHoursVal) { showError('daily-report-error', '通勤残業の時間を入力してください。'); return; }
    entries.push({
      site_id: siteId, new_site_name: newSiteName, work_type: el.querySelector('.dr-work-type').value,
      is_leader: el.querySelector('.dr-is-leader').checked, is_night_shift: el.querySelector('.dr-is-night-shift').checked,
      notes: el.querySelector('.dr-notes').value.trim() || null,
      overtime_hours: overtimeVal ? Number(overtimeVal) : null,
      // 通勤早出・通勤残業は「チェックしたのに時間が0/未入力」を防ぐため、チェックされている
      // 場合だけ時間を送る(サーバー側もis_early_commute等をhours>0から再計算するため、
      // ここで矛盾した値を送っても最終的にはサーバー側の値が優先される)。
      early_commute_hours: earlyCommuteChecked && earlyCommuteHoursVal ? Number(earlyCommuteHoursVal) : null,
      commute_overtime_hours: commuteOvertimeChecked && commuteOvertimeHoursVal ? Number(commuteOvertimeHoursVal) : null,
      is_over_100km: el.querySelector('.dr-is-over-100km').checked,
      is_transport: el.querySelector('.dr-is-transport').checked,
      is_field_duty: el.querySelector('.dr-is-field-duty').checked,
      is_sales: el.querySelector('.dr-is-sales').checked,
      is_business_trip: el.querySelector('.dr-is-business-trip').checked,
      is_overnight: el.querySelector('.dr-is-overnight').checked,
      overnight_nights: el.querySelector('.dr-overnight-nights').value ? Number(el.querySelector('.dr-overnight-nights').value) : null,
    });
  }

  // 資格取得(対象者のみ表示される欄。チェックされていれば必須項目を確認する)。
  const hasQualification = dailyReportPermissions.can_input_qualification && document.getElementById('daily-report-has-qualification').checked;
  const qualName = document.getElementById('daily-report-qual-name').value.trim();
  const qualDate = document.getElementById('daily-report-qual-date').value;
  if (hasQualification && !qualName) { showError('daily-report-error', '資格名を入力してください。'); return; }
  if (hasQualification && !qualDate) { showError('daily-report-error', '資格取得日を選択してください。'); return; }

  const btn = document.getElementById('daily-report-submit');
  btn.disabled = true;
  try {
    let r;
    let editRequiresApproval = false;
    if (dailyReportTarget.type === 'self' && !isDraft) {
      // 本人が自分の日報を編集する経路だけ、修正申請の仕組み(request_daily_report_edit)を通す。
      // 既に確認・反映済みの日を書き換えようとした場合だけ理由の入力を求め、承認待ちになる
      // (代理入力・外注入力は既存どおり管理者の直接権限としてsubmit_daily_reportを使う)。
      let reason = null;
      for (;;) {
        try {
          const editResult = await rpc('request_daily_report_edit', {
            p_employee_code: session.employeeCode, p_report_date: dateStr, p_entries: entries, p_reason: reason,
          });
          const er = editResult && editResult[0];
          editRequiresApproval = !!(er && er.requires_approval);
          r = { is_special: false, total_headcount: entries.reduce((s, e) => s + (e.work_type === '終日' ? 1 : 0.5), 0), entry_count: entries.length };
          break;
        } catch (editErr) {
          if (!reason && /修正理由を入力してください/.test(editErr.message || '')) {
            reason = window.prompt('この日はすでに確認・反映済みのため、修正には理由が必要です。修正理由を入力してください。');
            if (!reason || !reason.trim()) { throw new Error('修正には理由の入力が必要です。'); }
            continue;
          }
          throw editErr;
        }
      }
    } else {
      const result = await rpc('submit_daily_report', {
        p_actor_employee_code: session.employeeCode, p_report_date: dateStr, p_entries: entries, p_is_draft: !!isDraft,
        p_target_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : null,
        p_target_worker_type: dailyReportTarget.type === 'subcontractor' ? 'subcontractor' : 'employee',
        p_target_subcontractor_worker_id: dailyReportTarget.type === 'subcontractor' ? dailyReportTarget.subcontractorWorkerId : null,
      });
      r = result && result[0];
    }

    let qualWarning = '';
    if (hasQualification && !isDraft) {
      // 資格・免許は既存の社員マスタ側と同じ仕組み(submit_qualification)へそのまま登録する
      // (日報専用の別テーブルを新設しない。将来「資格・免許」画面と同じ一覧に出てくる)。
      try {
        await rpc('submit_qualification', {
          p_employee_code: dailyReportTarget.type === 'employee' ? dailyReportTarget.employeeCode : session.employeeCode,
          p_qualification_name: qualName, p_qualification_number: null, p_obtained_date: qualDate,
          p_expiry_date: null, p_renewal_deadline: null, p_note: `日報(${dateStr})から登録`,
          p_photo_drive_file_id: dailyReportQualAttachment ? dailyReportQualAttachment.driveFileId : null,
          p_photo_drive_file_url: dailyReportQualAttachment ? dailyReportQualAttachment.driveFileUrl : null,
          p_pdf_drive_file_id: null, p_pdf_drive_file_url: null, p_category: 'qualification', p_license_type_id: null,
        });
      } catch (e2) {
        qualWarning = ' ※資格取得の登録には失敗しました。「資格・免許」画面から改めて登録してください。';
      }
    }

    if (isDraft) { showDone(`日報を下書き保存しました(${dateStr})。提出は完了していません。`, 'menu-apply'); return; }

    if (editRequiresApproval) {
      showDone(`この日はすでに確認・反映済みのため、修正内容を管理者確認待ちとして登録しました(${dateStr})。管理者が承認すると反映されます。` + qualWarning, 'menu-apply');
      return;
    }

    // 提出直後に、同日・同現場の他社員の日報との整合性を確認する(要確認があっても提出自体は完了扱い)。
    let consistencyWarning = '';
    try {
      const issues = await rpc('run_daily_report_consistency_check', { p_report_date: dateStr });
      if (issues && issues.length > 0) {
        consistencyWarning = ' ⚠ 内容に確認が必要な点があります(日報履歴から詳細を確認してください)。';
      }
    } catch (e3) { /* 整合性チェックの失敗で提出完了メッセージ自体は止めない */ }

    const msg = (r && r.is_special
      ? `日報を受け付けました(${dateStr}、${r.entry_count}現場)。3現場以上のため特殊日報として管理者が確認します。`
      : `日報を受け付けました(${dateStr}、合計${r ? Number(r.total_headcount).toFixed(1) : ''}人工)。`) + qualWarning + consistencyWarning;
    showDone(msg, 'menu-apply');
  } catch (e) {
    showError('daily-report-error', e.message || '送信に失敗しました。もう一度お試しください。');
  } finally {
    btn.disabled = false;
  }
}

// 日報の状態表示を全画面(リスト/カレンダー/詳細/ホーム)で統一する。
// 「本人または管理者が確認すべき状態」だけを🔴で示し、提出済み・承認済み等の正常状態は
// 赤くしない(2026-08-26、ユーザー指示)。
function dailyReportStatusBadgeHtml(r) {
  if (r.report_status === 'cancelled') return '<span class="mini-tag muted">取消済み</span>';
  if (r.needs_review) return '<span class="mini-tag danger">🔴 要確認</span>';
  if (r.report_status === 'rejected') return `<span class="mini-tag danger">🔴 修正依頼あり${r.rejected_reason ? '：' + r.rejected_reason : ''}</span>`;
  if (r.report_status === 'confirmed') return '<span class="mini-tag done">✅ 承認済み</span>';
  if (r.report_status === 'submitted') return '<span class="mini-tag muted">提出済み(管理者確認待ち)</span>';
  return '<span class="mini-tag muted">下書き</span>';
}

let dailyReportSummaryPeriodType = 'pay_period';
let dailyReportPeriodYear = null;
let dailyReportPeriodMonth = null;

// 給与期間(前月26日〜当月25日)の実日付範囲をJS側でも計算する。SQL側の
// get_my_daily_report_month_summary(p_period_type='pay_period')と全く同じ定義
// (scripts/lib/attendance-sheet-payroll-reflect.jsのpayPeriodRangeとも同じ)。
// リスト表示(get_my_daily_reports)へ渡す期間を、集計と完全に一致させるために使う。
function computeDailyReportPeriodBounds(year, month, periodType) {
  if (periodType === 'calendar') {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    const fmt = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    return { start: fmt(start), end: fmt(end) };
  }
  const start = new Date(Date.UTC(year, month - 2, 26));
  const end = new Date(Date.UTC(year, month - 1, 25));
  const fmt = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return { start: fmt(start), end: fmt(end) };
}
let dailyReportViewMode = 'list';
let dailyReportCalYear = null;
let dailyReportCalMonth = null;
let dailyReportCalEventsByDate = new Map();
let dailyReportCalDayInfoByDate = new Map();
let personalEventEditingId = null;

function pad2(n) { return String(n).padStart(2, '0'); }

function setDailyReportView(mode) {
  dailyReportViewMode = mode;
  document.querySelectorAll('.dr-view-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));
  document.getElementById('my-daily-report-list-view').style.display = mode === 'list' ? 'block' : 'none';
  document.getElementById('my-daily-report-calendar-view').style.display = mode === 'calendar' ? 'block' : 'none';
  if (mode === 'calendar') {
    if (dailyReportCalYear == null) {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      dailyReportCalYear = now.getFullYear();
      dailyReportCalMonth = now.getMonth() + 1;
    }
    loadDailyReportCalendar();
  }
}

function shiftDailyReportCalMonth(delta) {
  let m = dailyReportCalMonth + delta;
  let y = dailyReportCalYear;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  dailyReportCalYear = y;
  dailyReportCalMonth = m;
  loadDailyReportCalendar();
}

async function loadDailyReportCalendar() {
  const session = getSession();
  const grid = document.getElementById('dr-cal-grid');
  const label = document.getElementById('dr-cal-month-label');
  label.textContent = `${dailyReportCalYear}年${dailyReportCalMonth}月`;
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('dr-cal-day-detail').innerHTML = '';
  try {
    const [rows, eventRows] = await Promise.all([
      rpc('get_my_home_calendar_month', { p_employee_code: session.employeeCode, p_year: dailyReportCalYear, p_month: dailyReportCalMonth }),
      rpc('get_my_calendar_events', { p_employee_code: session.employeeCode, p_year: dailyReportCalYear, p_month: dailyReportCalMonth }),
    ]);
    const byDate = new Map((rows || []).map((r) => [r.calendar_date, r]));
    dailyReportCalDayInfoByDate = byDate;
    dailyReportCalEventsByDate = new Map();
    (eventRows || []).forEach((ev) => {
      const list = dailyReportCalEventsByDate.get(ev.event_date) || [];
      list.push(ev);
      dailyReportCalEventsByDate.set(ev.event_date, list);
    });
    const today = todayJST();

    const firstDow = new Date(Date.UTC(dailyReportCalYear, dailyReportCalMonth - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(dailyReportCalYear, dailyReportCalMonth, 0)).getUTCDate();

    grid.innerHTML = '';
    for (let i = 0; i < firstDow; i++) {
      const empty = document.createElement('div');
      empty.className = 'dr-cal-cell empty';
      grid.appendChild(empty);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${dailyReportCalYear}-${pad2(dailyReportCalMonth)}-${pad2(day)}`;
      const info = byDate.get(dateStr);
      const dow = new Date(Date.UTC(dailyReportCalYear, dailyReportCalMonth - 1, day)).getUTCDay();
      const cell = document.createElement('div');
      cell.className = 'dr-cal-cell';
      if (dow === 0) cell.classList.add('sunday');
      if (dow === 6) cell.classList.add('saturday');
      if (info && (info.is_national_holiday || info.is_company_holiday)) cell.classList.add('holiday');
      if (dateStr === today) cell.classList.add('today');

      const dots = [];
      if (info) {
        // 色の意味(2026-08-27修正、ユーザー指示): 赤=要確認・修正依頼(異常・対応必要)のみ。
        // 提出済みは緑、未提出はオレンジ、休み(有給以外)はグレー、有給は別色(青)にする。
        if (info.requires_attention) dots.push('<span class="dr-cal-dot warn"></span>');
        else if (info.report_status === 'submitted' || info.report_status === 'confirmed') dots.push('<span class="dr-cal-dot done"></span>');
        if (info.is_paid_leave) dots.push(`<span class="dr-cal-dot ${info.leave_category === 'paid_leave' ? 'leave' : 'rest'}"></span>`);
        if (!info.report_status && !info.is_paid_leave && dateStr < today && dow !== 0) dots.push('<span class="dr-cal-dot missing"></span>');
      } else if (dateStr < today && dow !== 0) {
        dots.push('<span class="dr-cal-dot missing"></span>');
      }
      const birthdayMark = info && info.birthday_names && info.birthday_names.length > 0
        ? `<div class="dr-cal-birthday">🎂${info.birthday_names.length > 1 ? info.birthday_names.length + '名' : ''}</div>` : '';
      const eventMark = info && info.personal_event_titles && info.personal_event_titles.length > 0
        ? `<div class="dr-cal-birthday">📌${info.personal_event_titles.length > 1 ? info.personal_event_titles.length + '件' : ''}</div>` : '';

      cell.innerHTML = `<span class="dr-cal-daynum">${day}</span><div class="dr-cal-dots">${dots.join('')}</div>${birthdayMark}${eventMark}`;
      cell.addEventListener('click', () => onDailyReportCalDayClick(dateStr, info));
      grid.appendChild(cell);
    }
  } catch (e) {
    grid.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

function onDailyReportCalDayClick(dateStr, info) {
  const detailEl = document.getElementById('dr-cal-day-detail');
  const holidayName = info && (info.national_holiday_name || info.company_holiday_name);
  const birthdayLine = info && info.birthday_names && info.birthday_names.length > 0 ? `🎂 ${info.birthday_names.join('・')}さん 誕生日` : '';
  const events = dailyReportCalEventsByDate.get(dateStr) || [];
  const eventsHtml = events.map((ev) => `
    <div class="field-row" data-event-id="${ev.id}" style="cursor:pointer;">
      <span>${ev.start_time ? ev.start_time.slice(0, 5) + ' ' : ''}${ev.title}</span>
      <span class="icon-slot" data-icon="chevron-right"></span>
    </div>
  `).join('');

  // 要確認理由(item#7): 「要確認」だけの抽象表示にせず、consistency_issuesの具体的な理由文を並べる。
  const reasonsHtml = info && info.attention_reasons && info.attention_reasons.length > 0
    ? `<div class="card" style="border:1px solid var(--danger);margin-bottom:10px;">
        <div class="row1"><span class="mini-tag danger">要確認</span></div>
        <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;">${info.attention_reasons.map((m) => `<li>${m}</li>`).join('')}</ul>
      </div>` : '';

  const leaveLine = info && info.is_paid_leave
    ? `<div class="hint-inline">${info.leave_category_label || '休暇'}${info.leave_is_pending ? '(承認待ち)' : ''}${info.is_half_day_leave ? '(半休)' : ''}</div>` : '';

  const reportBlock = (info && info.report_status)
    ? `<button type="button" data-open-detail="${dateStr}">この日の日報を確認する</button>`
    : `${leaveLine || '<div class="hint-inline">この日の日報はありません</div>'}
       <button type="button" class="secondary" data-open-input="${dateStr}">日報を書く</button>`;

  detailEl.innerHTML = `
    <div class="card">
      <div class="row1"><span>${dateStr}</span>${holidayName ? `<span class="mini-tag info">${holidayName}</span>` : ''}</div>
      ${birthdayLine ? `<div class="hint-inline">${birthdayLine}</div>` : ''}
      ${reasonsHtml}
      ${reportBlock}
      <div class="section-title" style="margin:12px 0 4px;font-size:13px;">自分の予定</div>
      ${eventsHtml || '<div class="hint-inline">この日の予定はありません</div>'}
      <button type="button" class="secondary" data-add-event="${dateStr}" style="margin-top:8px;">予定を追加</button>
    </div>
  `;
  const openDetailBtn = detailEl.querySelector('[data-open-detail]');
  if (openDetailBtn) openDetailBtn.addEventListener('click', () => openMyDailyReportDetail(dateStr));
  const openInputBtn = detailEl.querySelector('[data-open-input]');
  if (openInputBtn) {
    openInputBtn.addEventListener('click', () => {
      dailyReportTarget = { type: 'self', employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
      dailyReportPrefillDate = dateStr;
      showScreen('daily-report');
    });
  }
  const markRestBtn = detailEl.querySelector('[data-mark-rest]');
  if (markRestBtn) markRestBtn.addEventListener('click', () => openQuickRestRegisterForm(dateStr));
  detailEl.querySelectorAll('[data-event-id]').forEach((el) => {
    el.addEventListener('click', () => openPersonalEventForm(Number(el.dataset.eventId), dateStr));
  });
  detailEl.querySelector('[data-add-event]').addEventListener('click', () => openPersonalEventForm(null, dateStr));
}

// 「会社都合休み」は社員本人が申請する区分から削除した(ユーザー指示、2026-08-30)。
// 会社都合休みが必要な場合は管理側で設定する仕組みとして別途分離する方針のため、
// このoptions配列(社員自身の休暇申請・簡易登録の両方で共有)からは除外する。
const LEAVE_CATEGORY_OPTIONS = [
  { value: 'paid_leave', label: '有給休暇' },
  { value: 'regular_leave', label: '普通休暇' },
  { value: 'absence', label: '欠勤' },
  { value: 'other_leave', label: 'その他休暇' },
];

// item#10: ホーム/カレンダーからの「今日は休みとして登録する」簡易導線。既存のsubmit_paid_leave_request
// (leave_category対応版)をそのまま呼ぶ(1日・終日固定の簡易フォーム)。給与締め済み期間や承認後の
// 変更が絡む場合も、通常の申請と同じ承認フローに乗るため既存ルールから外れない。
// ホーム画面の「今日は休みとして登録する」から直接開く(カレンダー画面へ遷移してから開く)。
async function openQuickRestRegisterFromHome(dateStr) {
  showScreen('my-daily-reports');
  setDailyReportView('calendar');
  await loadDailyReportCalendar();
  openQuickRestRegisterForm(dateStr);
}

function openQuickRestRegisterForm(dateStr) {
  const detailEl = document.getElementById('dr-cal-day-detail');
  detailEl.innerHTML = `
    <div class="card">
      <div class="form-title" style="font-size:14px;">${dateStr} を休みとして登録</div>
      <label>区分</label>
      <select id="qr-category">${LEAVE_CATEGORY_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}</select>
      <label>理由・メモ(任意)</label>
      <input type="text" id="qr-reason" placeholder="例: 私用のため">
      <div class="error" id="qr-error"></div>
      <button type="button" id="qr-submit">登録する</button>
      <button type="button" class="secondary" id="qr-cancel" style="margin-top:6px;">キャンセル</button>
    </div>
  `;
  detailEl.querySelector('#qr-cancel').addEventListener('click', () => onDailyReportCalDayClick(dateStr, dailyReportCalDayInfoByDate.get(dateStr)));
  detailEl.querySelector('#qr-submit').addEventListener('click', async () => {
    const session = getSession();
    const category = detailEl.querySelector('#qr-category').value;
    const reason = detailEl.querySelector('#qr-reason').value.trim() || null;
    try {
      await rpc('submit_paid_leave_request', {
        p_employee_code: session.employeeCode, p_start_date: dateStr, p_end_date: dateStr, p_is_half_day: false,
        p_reason: reason, p_note: null, p_leave_category: category,
      });
      await loadDailyReportCalendar();
      await renderHomeDailyReportStatusBanner(session);
    } catch (e) {
      document.getElementById('qr-error').textContent = e.message || '登録に失敗しました。';
    }
  });
}

// ---------- 個人予定の登録・編集フォーム(カレンダー日詳細から開く) ----------

function openPersonalEventForm(eventId, dateStr) {
  personalEventEditingId = eventId;
  const existing = eventId ? (dailyReportCalEventsByDate.get(dateStr) || []).find((e) => e.id === eventId) : null;
  const detailEl = document.getElementById('dr-cal-day-detail');
  detailEl.innerHTML = `
    <div class="card">
      <div class="form-title" style="font-size:14px;">${eventId ? '予定を編集' : '予定を追加'}</div>
      <label>日付</label>
      <input type="date" id="pev-date" value="${dateStr}">
      <label>予定名</label>
      <input type="text" id="pev-title" placeholder="例: ○○建設とゴルフ" value="${existing ? existing.title.replace(/"/g, '&quot;') : ''}">
      <label>開始時間(任意)</label>
      <input type="time" id="pev-start" value="${existing && existing.start_time ? existing.start_time.slice(0, 5) : ''}">
      <label>終了時間(任意)</label>
      <input type="time" id="pev-end" value="${existing && existing.end_time ? existing.end_time.slice(0, 5) : ''}">
      <label>場所(任意)</label>
      <input type="text" id="pev-location" value="${existing && existing.location ? existing.location.replace(/"/g, '&quot;') : ''}">
      <label>相手先(任意)</label>
      <input type="text" id="pev-counterpart" value="${existing && existing.counterpart ? existing.counterpart.replace(/"/g, '&quot;') : ''}">
      <label>備考(任意)</label>
      <input type="text" id="pev-note" value="${existing && existing.note ? existing.note.replace(/"/g, '&quot;') : ''}">
      <div class="checkbox-row">
        <input type="checkbox" id="pev-notify" ${existing && existing.notify_enabled ? 'checked' : ''}>
        <label>通知する(将来の通知機能に対応予定)</label>
      </div>
      <div class="hint-inline" id="pev-error" style="color:var(--danger);display:none;"></div>
      <button type="button" id="pev-save">保存する</button>
      ${eventId ? '<button type="button" class="secondary" id="pev-delete">この予定を削除する</button>' : ''}
      <button type="button" class="link" id="pev-cancel">キャンセル</button>
    </div>
  `;
  document.getElementById('pev-save').addEventListener('click', () => savePersonalEvent(dateStr));
  document.getElementById('pev-cancel').addEventListener('click', () => onDailyReportCalDayClick(dateStr, null));
  const delBtn = document.getElementById('pev-delete');
  if (delBtn) delBtn.addEventListener('click', () => deletePersonalEvent(eventId, dateStr));
}

async function savePersonalEvent(originalDateStr) {
  const session = getSession();
  const errEl = document.getElementById('pev-error');
  errEl.style.display = 'none';
  const title = document.getElementById('pev-title').value.trim();
  if (!title) { errEl.textContent = '予定名を入力してください。'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('pev-save');
  btn.disabled = true;
  try {
    const params = [
      session.employeeCode, document.getElementById('pev-date').value, title,
      document.getElementById('pev-start').value || null, document.getElementById('pev-end').value || null,
      document.getElementById('pev-location').value.trim() || null, document.getElementById('pev-counterpart').value.trim() || null,
      document.getElementById('pev-note').value.trim() || null, document.getElementById('pev-notify').checked,
    ];
    if (personalEventEditingId) {
      await rpc('update_my_calendar_event', {
        p_employee_code: params[0], p_event_id: personalEventEditingId, p_event_date: params[1], p_title: params[2],
        p_start_time: params[3], p_end_time: params[4], p_location: params[5], p_counterpart: params[6], p_note: params[7], p_notify_enabled: params[8],
      });
    } else {
      await rpc('add_my_calendar_event', {
        p_employee_code: params[0], p_event_date: params[1], p_title: params[2],
        p_start_time: params[3], p_end_time: params[4], p_location: params[5], p_counterpart: params[6], p_note: params[7], p_notify_enabled: params[8],
      });
    }
    await loadDailyReportCalendar();
    renderHomeUpcomingEvents(session);
  } catch (e) {
    errEl.textContent = e.message || '保存に失敗しました。';
    errEl.style.display = 'block';
    btn.disabled = false;
  }
}

async function deletePersonalEvent(eventId, dateStr) {
  const session = getSession();
  try {
    await rpc('delete_my_calendar_event', { p_employee_code: session.employeeCode, p_event_id: eventId });
    await loadDailyReportCalendar();
    renderHomeUpcomingEvents(session);
  } catch (e) { /* 失敗しても画面は再読み込みされるので静かに無視 */ }
}

function initDailyReportPeriodIfNeeded() {
  if (dailyReportPeriodYear == null) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    dailyReportPeriodYear = now.getFullYear();
    dailyReportPeriodMonth = now.getMonth() + 1;
  }
}

function isDailyReportPeriodCurrent() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return dailyReportPeriodYear === now.getFullYear() && dailyReportPeriodMonth === (now.getMonth() + 1);
}

function renderDailyReportPeriodNav() {
  const { start, end } = computeDailyReportPeriodBounds(dailyReportPeriodYear, dailyReportPeriodMonth, dailyReportSummaryPeriodType);
  document.getElementById('dr-period-label').textContent = dailyReportSummaryPeriodType === 'pay_period'
    ? `${start} 〜 ${end}` : `${dailyReportPeriodYear}年${dailyReportPeriodMonth}月`;
  document.getElementById('dr-period-reset').style.display = isDailyReportPeriodCurrent() ? 'none' : '';
}

function navigateDailyReportPeriod(delta) {
  dailyReportPeriodMonth += delta;
  if (dailyReportPeriodMonth < 1) { dailyReportPeriodMonth = 12; dailyReportPeriodYear -= 1; }
  else if (dailyReportPeriodMonth > 12) { dailyReportPeriodMonth = 1; dailyReportPeriodYear += 1; }
  loadMyDailyReports();
}

function resetDailyReportPeriodToCurrent() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  dailyReportPeriodYear = now.getFullYear();
  dailyReportPeriodMonth = now.getMonth() + 1;
  loadMyDailyReports();
}

async function loadMyDailyReports() {
  const session = getSession();
  initDailyReportPeriodIfNeeded();
  document.querySelectorAll('.dr-view-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === 'list'));
  document.getElementById('my-daily-report-list-view').style.display = 'block';
  document.getElementById('my-daily-report-calendar-view').style.display = 'none';
  dailyReportViewMode = 'list';
  renderDailyReportPeriodNav();
  const list = document.getElementById('my-daily-report-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  loadMyDailyReportSummary();
  try {
    // item#2: リスト表示の期間を、上の集計(給与期間/今月)と完全に一致させる
    // (以前はp_limit=30件の単純な最新順で、集計期間と食い違うことがあった)。
    const { start, end } = computeDailyReportPeriodBounds(dailyReportPeriodYear, dailyReportPeriodMonth, dailyReportSummaryPeriodType);
    const rows = await rpc('get_my_daily_reports', { p_employee_code: session.employeeCode, p_period_start: start, p_period_end: end });
    if (rows.length === 0) { list.innerHTML = '<div class="empty-state">この期間の日報はありません</div>'; return; }
    list.innerHTML = '';
    rows.forEach((r) => {
      const isCancelled = r.report_status === 'cancelled';
      // 休日(システム自動登録): 本人が出していない休日日報。人工0・タップ詳細なしのお休み表示にする。
      if (!isCancelled && r.is_system_holiday) {
        const hdiv = document.createElement('div');
        hdiv.className = 'history-item is-holiday-auto';
        hdiv.innerHTML = `
          <div class="row1"><span>${r.report_date}</span><span class="mini-tag muted">お休み</span></div>
          <div class="row2">休日（システム自動登録）</div>
          <div class="hint-inline">勤務予定がないため、システムが休日として記録しました</div>
        `;
        list.appendChild(hdiv);
        return;
      }
      const div = document.createElement('div');
      div.className = 'history-item' + (isCancelled ? ' is-cancelled' : '');
      div.style.cursor = 'pointer';
      if (isCancelled) div.style.opacity = '0.6';
      const parts = [];
      if (Number(r.overtime_hours) > 0) parts.push(`残業 ${Number(r.overtime_hours)}h`);
      if (r.is_early_commute) parts.push(`通勤早出 ${Number(r.early_commute_hours)}h`);
      if (r.is_commute_overtime) parts.push(`通勤残業 ${Number(r.commute_overtime_hours)}h`);
      if (r.is_over_100km) parts.push('通勤100km超');
      const headcountHtml = isCancelled
        ? '<span style="text-decoration:line-through;">取消</span>'
        : `${Number(r.total_headcount).toFixed(1)}人工`;
      div.innerHTML = `
        <div class="row1"><span>${r.report_date}</span><span>${headcountHtml}</span></div>
        <div class="row2"${isCancelled ? ' style="text-decoration:line-through;"' : ''}>${r.site_names.map((n, i) => `${n}(${r.work_types[i]})`).join('・')}</div>
        ${!isCancelled && parts.length > 0 ? `<div class="hint-inline">${parts.join(' / ')}</div>` : ''}
        ${!isCancelled && r.is_special ? '<span class="mini-tag warn">特殊日報(管理者確認中)</span>' : ''}
        ${!isCancelled && r.reflected ? '<span class="mini-tag muted">シート反映済み</span>' : ''}
        ${dailyReportStatusBadgeHtml(r)}
        ${!isCancelled && r.attention_reasons && r.attention_reasons.length > 0 ? `<ul style="margin:4px 0 0 16px;padding:0;font-size:12px;color:var(--danger);">${r.attention_reasons.map((m) => `<li>${m}</li>`).join('')}</ul>` : ''}
        <div class="hint-inline">タップして詳細を確認</div>
      `;
      div.addEventListener('click', () => openMyDailyReportDetail(r.report_date));
      list.appendChild(div);
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

async function loadMyDailyReportSummary() {
  const session = getSession();
  initDailyReportPeriodIfNeeded();
  const el = document.getElementById('my-daily-report-summary');
  document.querySelectorAll('.dr-summary-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.period === dailyReportSummaryPeriodType);
  });
  el.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_daily_report_month_summary', {
      p_employee_code: session.employeeCode, p_year: dailyReportPeriodYear, p_month: dailyReportPeriodMonth,
      p_period_type: dailyReportSummaryPeriodType,
    });
    const s = rows && rows[0];
    if (!s) { el.innerHTML = '<div class="hint">集計を取得できませんでした。</div>'; return; }
    const fmtN = (n) => Number(n || 0).toFixed(1).replace(/\.0$/, '');
    el.innerHTML = `
      <div class="summary-period-label">${s.period_start} 〜 ${s.period_end}</div>
      <div class="summary-grid">
        <div><span class="summary-label">出勤日数</span><span class="summary-value">${fmtN(s.work_days)}日</span></div>
        <div><span class="summary-label">総人工</span><span class="summary-value">${fmtN(s.total_headcount)}人工</span></div>
        <div><span class="summary-label">残業時間</span><span class="summary-value">${fmtN(s.overtime_hours)}h</span></div>
        <div><span class="summary-label">通勤早出</span><span class="summary-value">${s.early_commute_count}回 / ${fmtN(s.early_commute_hours)}h</span></div>
        <div><span class="summary-label">通勤残業</span><span class="summary-value">${s.commute_overtime_count}回 / ${fmtN(s.commute_overtime_hours)}h</span></div>
        <div><span class="summary-label">通勤100km超</span><span class="summary-value">${s.over_100km_count}回</span></div>
        <div><span class="summary-label">リーダー</span><span class="summary-value">${s.leader_count}回</span></div>
        <div><span class="summary-label">有給</span><span class="summary-value">${fmtN(s.paid_leave_days)}日</span></div>
        <div><span class="summary-label">休暇(有給以外)</span><span class="summary-value">${fmtN(s.other_leave_days)}日</span></div>
        <div><span class="summary-label">欠勤</span><span class="summary-value">${fmtN(s.absence_days)}日</span></div>
        <div><span class="summary-label">半日勤務</span><span class="summary-value">${s.half_day_work_count}回</span></div>
        <div><span class="summary-label">日曜出勤</span><span class="summary-value">${s.sunday_work_count}回</span></div>
        <div><span class="summary-label">現場作業</span><span class="summary-value">${s.field_duty_count}回</span></div>
        <div><span class="summary-label">営業</span><span class="summary-value">${s.sales_count}回</span></div>
        <div><span class="summary-label">運搬</span><span class="summary-value">${s.transport_count}回</span></div>
        <div><span class="summary-label">資格取得</span><span class="summary-value">${s.qualification_count}件</span></div>
      </div>
    `;
  } catch (e) {
    el.innerHTML = '<div class="hint">集計の読み込みに失敗しました。</div>';
  }
}

let myDailyReportDetailDate = null;
let dailyReportPrefillDate = null;

async function openMyDailyReportDetail(dateStr) {
  myDailyReportDetailDate = dateStr;
  showScreen('my-daily-report-detail'); // enter hook(renderMyDailyReportDetailBody)が本文を描画する
}

// 詳細本文の読み込み・描画のみを行う。showScreenを呼ばないことで、
// SCREEN_ENTER_HOOKS['my-daily-report-detail'] → openMyDailyReportDetail → showScreen → hook…
// という再帰(詳細を1回開くだけでopenが数千回呼ばれ、fetchが暴発してERR_INSUFFICIENT_RESOURCES
// になる既存バグ)を断つ。取消後の再描画・戻る/進むでの再入場は、この本文描画のみを呼ぶ。
async function renderMyDailyReportDetailBody(dateStr) {
  const session = getSession();
  const body = document.getElementById('my-daily-report-detail-body');
  body.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_daily_report_detail', { p_employee_code: session.employeeCode, p_report_date: dateStr });
    if (!rows || rows.length === 0) { body.innerHTML = '<div class="empty-state">この日の日報は見つかりませんでした</div>'; return; }
    const isCancelled = rows.every((r) => r.report_status === 'cancelled');
    const cancelledMeta = rows.find((r) => r.cancelled_at) || {};
    const anyReflected = rows.some((r) => r.reflected);
    const cancelledBannerHtml = isCancelled ? `
      <div class="card" style="margin-bottom:10px;border:1px solid var(--muted);background:rgba(128,128,128,0.08);">
        <div style="font-weight:700;margin-bottom:4px;">この日報は取消済みです</div>
        <div class="hint-inline">出勤日数・人工・残業・給与・旅費・各種集計の対象から除外されています。</div>
        ${cancelledMeta.cancel_reason ? `<div class="field-row"><span>取消理由</span><span>${cancelledMeta.cancel_reason}</span></div>` : ''}
        ${cancelledMeta.cancelled_at ? `<div class="field-row"><span>取消日時</span><span>${new Date(cancelledMeta.cancelled_at).toLocaleString('ja-JP')}</span></div>` : ''}
        <div class="hint-inline" style="margin-top:6px;">日付を間違えた場合は、正しい日付で日報を登録し直してください。</div>
      </div>` : '';
    const cancelButtonHtml = !isCancelled ? `
      <div style="margin-top:6px;">
        <button type="button" class="btn-secondary" id="my-daily-report-cancel-btn" style="width:100%;color:var(--danger);border-color:var(--danger);">この日報を取り消す（誤登録として無効にする）</button>
        <div class="hint-inline" style="margin-top:4px;">取消すると出勤・給与等の集計対象から除外されます。取消しても履歴には「取消済み」として残ります。${anyReflected ? '（この日報は既に集計シートへ反映済みのため、取消は管理者に依頼が必要な場合があります）' : ''}</div>
      </div>` : '';
    body.innerHTML = `<div class="form-title" style="font-size:15px;">${dateStr}</div>` + cancelledBannerHtml + rows.map((r) => `
      <div class="card" style="margin-bottom:10px;${isCancelled ? 'opacity:0.7;' : ''}">
        <div style="margin-bottom:6px;">${dailyReportStatusBadgeHtml(r)}</div>
        ${r.needs_review ? (r.consistency_issues || []).map((iss) => `<div class="hint-inline">・${iss.message}</div>`).join('') : ''}
        <div class="field-row"><span>現場</span><span>${r.site_name || ''}</span></div>
        <div class="field-row"><span>勤務区分</span><span>${r.work_type || ''}</span></div>
        <div class="field-row"><span>人工</span><span>${r.work_type === '終日' ? '1.0' : '0.5'}</span></div>
        <div class="field-row"><span>リーダー</span><span>${r.is_leader ? 'あり' : 'なし'}</span></div>
        <div class="field-row"><span>残業時間</span><span>${r.overtime_hours != null ? r.overtime_hours + 'h' : '-'}</span></div>
        <div class="field-row"><span>通勤早出</span><span>${r.is_early_commute ? `あり(${r.early_commute_hours}h)` : 'なし'}</span></div>
        <div class="field-row"><span>通勤残業</span><span>${r.is_commute_overtime ? `あり(${r.commute_overtime_hours}h)` : 'なし'}</span></div>
        <div class="field-row"><span>通勤100km超</span><span>${r.is_over_100km ? 'あり' : 'なし'}</span></div>
        <div class="field-row"><span>出張</span><span>${r.is_business_trip ? (r.is_overnight ? `あり(宿泊${r.overnight_nights || ''}日)` : 'あり(日帰り)') : 'なし'}</span></div>
        <div class="field-row"><span>現場作業</span><span>${r.is_field_duty ? 'あり' : 'なし'}</span></div>
        <div class="field-row"><span>営業</span><span>${r.is_sales ? 'あり' : 'なし'}</span></div>
        <div class="field-row"><span>運搬</span><span>${r.is_transport ? 'あり' : 'なし'}</span></div>
        <div class="field-row"><span>資格取得</span><span>${(r.qualification_names || []).join('・') || 'なし'}</span></div>
        <div class="field-row"><span>備考</span><span>${r.notes || '-'}</span></div>
        <div class="field-row"><span>提出日時</span><span>${new Date(r.submitted_at).toLocaleString('ja-JP')}</span></div>
        <div class="field-row"><span>シート反映</span><span>${r.reflected ? '反映済み' : '未反映'}</span></div>
        ${r.report_status === 'rejected' && r.rejected_reason ? `<div class="field-row"><span>差し戻し理由</span><span>${r.rejected_reason}</span></div>` : ''}
      </div>
    `).join('') + cancelButtonHtml;
    const cancelBtn = document.getElementById('my-daily-report-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelMyDailyReport(dateStr));
  } catch (e) {
    body.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

// 日報の取消(soft delete / void)。確認ダイアログ→理由入力→cancel_daily_report RPC。
// 「人工0」ではなく明確な取消として無効化する(2026-09-01、ユーザー指示)。
async function cancelMyDailyReport(dateStr) {
  const session = getSession();
  if (!window.confirm(`${dateStr} の日報を取り消しますか？\n\n取消すと、出勤・人工・残業・給与・旅費などの集計対象から除外されます。\n履歴には「取消済み」として残ります。\n\n（日付を間違えた場合は、取消したうえで正しい日付で登録し直してください）`)) {
    return;
  }
  const reason = window.prompt('取消理由を入力してください（例: 日付を間違えて登録した / 現場を間違えた など）');
  if (reason === null) return; // キャンセル
  if (!reason.trim()) { alert('取消理由を入力してください。'); return; }
  try {
    const res = await rpc('cancel_daily_report', { p_employee_code: session.employeeCode, p_report_date: dateStr, p_reason: reason.trim() });
    const row = Array.isArray(res) ? res[0] : res;
    const hadReflected = row && (row.out_had_reflected === true || row.out_had_reflected === 'true');
    let msg = 'この日報を取消しました。集計対象から除外されます。';
    if (hadReflected) msg += '\n（集計シートへの反映解除は自動処理で行われます）';
    alert(msg);
    await renderMyDailyReportDetailBody(dateStr); // 本文のみ再描画(取消済みバナー表示、showScreen再帰を避ける)
  } catch (e) {
    alert(e.message || '取消に失敗しました。');
  }
}

// ---------- 日報の特殊ケース確認(管理者) ----------

let dailyReportAdminStatus = 'open';
async function loadDailyReportAdminList() {
  const session = getSession();
  const list = document.getElementById('daily-report-admin-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_daily_report_exceptions', { p_admin_employee_code: session.employeeCode, p_status: dailyReportAdminStatus || null });
    if (rows.length === 0) { list.innerHTML = '<div class="empty-state">該当する日報はありません</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="history-item">
        <div class="row1"><span>${r.context.employee_name}</span><span>${r.context.report_date}</span></div>
        <div class="row2">${r.message}</div>
        ${r.status === 'open' ? `<button type="button" class="secondary" data-resolve-id="${r.id}">対応済みにする</button>` : `<span class="mini-tag muted">対応済み</span>`}
      </div>
    `).join('');
    list.querySelectorAll('[data-resolve-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('resolve_error', { p_id: Number(btn.dataset.resolveId), p_status: 'resolved', p_resolution: `${session.employeeName}が確認しスプレッドシートへ手動反映` });
          loadDailyReportAdminList();
        } catch (e) { btn.disabled = false; }
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

// ---------- 日報の要確認一覧(管理者、同日同現場の整合性チェック結果) ----------

async function loadDailyReportNeedsReviewAdmin() {
  const session = getSession();
  const list = document.getElementById('daily-report-needs-review-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_needs_review_daily_reports', { p_admin_employee_code: session.employeeCode, p_date_from: null, p_date_to: null });
    if (!rows || rows.length === 0) { list.innerHTML = '<div class="empty-state">要確認の日報はありません</div>'; return; }
    // 比較しやすいよう、日付+現場でグループ化して表示する。
    const groups = new Map();
    rows.forEach((r) => {
      const key = `${r.report_date}__${r.site_id}`;
      if (!groups.has(key)) groups.set(key, { report_date: r.report_date, site_name: r.site_name, rows: [] });
      groups.get(key).rows.push(r);
    });
    list.innerHTML = '';
    groups.forEach((g) => {
      const wrap = document.createElement('div');
      wrap.className = 'card';
      wrap.style.marginBottom = '10px';
      // §3: 判断に必要な情報(社員番号・対象日・日報現場・配置現場・勤務区分・人工・提出日時・理由)を
      // 出し、各日報に【問題なしとして確定】【修正依頼】【日報を取消】を用意する。
      const memberLines = g.rows.map((r) => {
        const siteMismatch = r.assignment_site && r.site_name && r.assignment_site !== r.site_name;
        return `
        <div class="card" style="margin-top:8px;padding:10px;background:var(--surface-2,rgba(255,255,255,0.03));">
          <div class="row1"><span style="font-weight:700;">${r.employee_name}</span><span class="mini-tag">${r.employee_code}</span></div>
          <div class="field-row"><span>日報現場</span><span>${r.site_name || '(未設定)'}</span></div>
          <div class="field-row"><span>配置現場</span><span>${r.assignment_site || '(配置なし)'}${siteMismatch ? ' <span class="mini-tag danger">不一致</span>' : ''}</span></div>
          <div class="field-row"><span>勤務区分 / 人工</span><span>${r.work_type || '-'} / ${Number(r.headcount || 0)}人工${r.overtime_hours ? ' ・残業' + r.overtime_hours + 'h' : ''}</span></div>
          <div class="field-row"><span>提出日時</span><span>${r.submitted_at ? new Date(r.submitted_at).toLocaleString('ja-JP') : '-'}</span></div>
          <div class="mini-tag danger" style="display:block;margin-top:4px;">⚠ ${(r.consistency_issues || []).map((iss) => iss.message).join(' / ') || r.review_reason || '要確認'}</div>
          <div class="button-row" style="margin-top:8px;">
            <button type="button" class="secondary" data-ack-id="${r.id}">問題なしとして確定</button>
            <button type="button" class="link" data-correct-id="${r.id}">修正依頼</button>
            <button type="button" class="link" data-cancel-id="${r.id}" style="color:var(--danger);">日報を取消</button>
          </div>
        </div>`;
      }).join('');
      wrap.innerHTML = `<div class="row1"><span style="font-weight:700;">${g.report_date}</span><span>${g.site_name || ''}</span></div>${memberLines}`;
      list.appendChild(wrap);
    });
    // 問題なしとして確定 → report_status=confirmed(要確認一覧から消える)。
    list.querySelectorAll('[data-ack-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('admin_confirm_daily_reports', { p_admin_employee_code: session.employeeCode, p_daily_report_ids: [Number(btn.dataset.ackId)], p_action: 'confirmed', p_reason: null });
          loadDailyReportNeedsReviewAdmin();
        } catch (e) { alert(e.message || '確定に失敗しました。'); btn.disabled = false; }
      });
    });
    // 修正依頼 → 本人へ差し戻し(rejected)。本人HOMEの「今日やること」へ表示され理由が通知される。
    list.querySelectorAll('[data-correct-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = window.prompt('修正依頼の理由を入力してください（本人へ通知されます）。');
        if (!reason || !reason.trim()) return;
        btn.disabled = true;
        try {
          await rpc('admin_resolve_daily_report_review', { p_admin_employee_code: session.employeeCode, p_daily_report_id: Number(btn.dataset.correctId), p_action: 'request_correction', p_reason: reason.trim() });
          loadDailyReportNeedsReviewAdmin();
        } catch (e) { alert(e.message || '修正依頼に失敗しました。'); btn.disabled = false; }
      });
    });
    // 日報を取消 → 論理取消(集計・人工・Spreadsheet反映の対象外、監査ログ保持)。
    list.querySelectorAll('[data-cancel-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('この日報を取り消しますか？\n\n取消すと、集計・人工・Spreadsheet反映の対象から除外されます。\n履歴には「取消済み」として残ります。')) return;
        const reason = window.prompt('取消理由を入力してください。');
        if (reason === null) return;
        if (!reason.trim()) { alert('取消理由を入力してください。'); return; }
        btn.disabled = true;
        try {
          await rpc('admin_cancel_daily_report_by_id', { p_admin_employee_code: session.employeeCode, p_report_id: Number(btn.dataset.cancelId), p_reason: reason.trim() });
          loadDailyReportNeedsReviewAdmin();
        } catch (e) { alert(e.message || '取消に失敗しました。'); btn.disabled = false; }
      });
    });
  } catch (e) {
    // §4: 取得失敗と0件を混同しない。
    list.innerHTML = '<div class="empty-state" style="color:var(--danger);">読み込みに失敗しました。</div><button type="button" class="secondary" id="nr-retry" style="margin-top:8px;">再読み込み</button>';
    const rb = document.getElementById('nr-retry');
    if (rb) rb.addEventListener('click', () => loadDailyReportNeedsReviewAdmin());
  }
}

// ---------- 日報の修正申請一覧(管理者、確認済み/反映済みの日報を本人が修正しようとした申請) ----------

async function loadDailyReportEditRequestsAdmin() {
  const session = getSession();
  const list = document.getElementById('daily-report-edit-requests-list');
  list.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_daily_report_edit_requests', { p_admin_employee_code: session.employeeCode, p_status: 'pending' });
    if (!rows || rows.length === 0) { list.innerHTML = '<div class="empty-state">修正申請はありません</div>'; return; }
    list.innerHTML = rows.map((r) => `
      <div class="history-item">
        <div class="row1"><span>${r.employee_name}</span><span>${r.report_date}</span></div>
        <div class="row2">理由: ${r.reason}</div>
        <div class="hint-inline">申請日時: ${new Date(r.requested_at).toLocaleString('ja-JP')}</div>
        <div class="button-row" style="margin-top:8px;">
          <button type="button" data-approve-id="${r.id}">承認して反映</button>
          <button type="button" class="secondary" data-reject-id="${r.id}">却下</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-approve-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await rpc('admin_decide_daily_report_edit_request', { p_admin_employee_code: session.employeeCode, p_request_id: Number(btn.dataset.approveId), p_action: 'approved', p_reason: null });
          loadDailyReportEditRequestsAdmin();
        } catch (e) { btn.disabled = false; }
      });
    });
    list.querySelectorAll('[data-reject-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const reason = window.prompt('却下理由を入力してください(任意)。') || null;
        btn.disabled = true;
        try {
          await rpc('admin_decide_daily_report_edit_request', { p_admin_employee_code: session.employeeCode, p_request_id: Number(btn.dataset.rejectId), p_action: 'rejected', p_reason: reason });
          loadDailyReportEditRequestsAdmin();
        } catch (e) { btn.disabled = false; }
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">読み込みに失敗しました</div>';
  }
}

// ---------- 申請管理(管理者、全申請横断検索) ----------

let areqFilters = { type: '', status: '', name: '', dateFrom: '', dateTo: '', site: '', partner: '' };
let areqRows = [];
let areqSort = { col: 'requested_at', dir: 'desc' };

async function loadAdminAllRequests() {
  const session = getSession();
  const listEl = document.getElementById('areq-list');
  const countEl = document.getElementById('areq-count');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    areqRows = await rpc('admin_search_requests', {
      p_admin_employee_code: session.employeeCode,
      p_request_type: areqFilters.type || null,
      p_employee_code: null,
      p_employee_name: areqFilters.name || null,
      p_status_group: areqFilters.status || null,
      p_date_from: areqFilters.dateFrom || null,
      p_date_to: areqFilters.dateTo || null,
      p_site_name: areqFilters.site || null,
      p_partner_name: areqFilters.partner || null,
      p_keyword: null,
    });
    countEl.textContent = `${areqRows.length}件`;
    renderAreqAll();
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
    document.getElementById('areq-table-body').innerHTML = '';
  }
}

// スマホはカード一覧(#areq-list)、PC(768px以上)はCSSで表形式(#areq-table-wrap)に
// 切り替える。データ取得は共通(areqRows)で、並び替えもここで両方に反映する。
function renderAreqAll() {
  const sorted = sortAreqRows(areqRows);
  renderAreqCards(sorted);
  renderAreqTable(sorted);
}

function sortAreqRows(rows) {
  const { col, dir } = areqSort;
  if (!col) return rows;
  const sorted = rows.slice().sort((a, b) => {
    let av = a[col]; let bv = b[col];
    if (col === 'employee_name' || col === 'source_type' || col === 'site_name' || col === 'status' || col === 'status_group') {
      av = av || ''; bv = bv || '';
      return String(av).localeCompare(String(bv), 'ja');
    }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (col === 'requested_at' || col === 'updated_at') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
    return av > bv ? 1 : av < bv ? -1 : 0;
  });
  if (dir === 'desc') sorted.reverse();
  return sorted;
}

function renderAreqCards(rows) {
  const listEl = document.getElementById('areq-list');
  if (rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する申請はありません。</div>'; return; }
  listEl.innerHTML = rows.map((r) => {
    const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '';
    const statusClass = r.status_group === 'approved' ? 'done' : (r.status_group === 'rejected' ? 'rejected' : '');
    return `
      <div class="history-item" data-type="${r.source_type}" data-id="${r.source_id}">
        <div class="row1"><span>${r.employee_name}・${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}</span><span>${amountStr}</span></div>
        <div class="row2">${new Date(r.requested_at).toLocaleDateString('ja-JP')}　${r.summary || ''}</div>
        <span class="status-badge ${statusClass}">${STATUS_GROUP_LABEL[r.status_group] || r.status}</span>
        ${r.requires_special_review ? '<span class="mini-tag danger">事前申請なし</span>' : ''}
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', () => openRequestDetail(el.dataset.type, el.dataset.id));
  });
}

function renderAreqTable(rows) {
  const bodyEl = document.getElementById('areq-table-body');
  document.querySelectorAll('#screen-admin-all-requests .areq-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === areqSort.col);
    th.classList.toggle('desc', th.dataset.sort === areqSort.col && areqSort.dir === 'desc');
  });
  if (rows.length === 0) { bodyEl.innerHTML = `<tr><td colspan="9"><div class="hint">該当する申請はありません。</div></td></tr>`; return; }
  bodyEl.innerHTML = rows.map((r) => {
    const amountStr = r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '-';
    const statusClass = r.status_group === 'approved' ? 'done' : (r.status_group === 'rejected' ? 'rejected' : '');
    return `
      <tr data-type="${r.source_type}" data-id="${r.source_id}">
        <td>${r.employee_name}</td>
        <td>${REQUEST_TYPE_LABEL[r.source_type] || r.source_type}${r.requires_special_review ? ' <span class="mini-tag danger">事前申請なし</span>' : ''}</td>
        <td>${new Date(r.requested_at).toLocaleDateString('ja-JP')}</td>
        <td>${r.site_name || '-'}</td>
        <td>${amountStr}</td>
        <td>${STATUS_LABEL[r.status] || r.status}</td>
        <td><span class="status-badge ${statusClass}">${STATUS_GROUP_LABEL[r.status_group] || r.status_group}</span></td>
        <td>${r.updated_at ? new Date(r.updated_at).toLocaleString('ja-JP') : '-'}</td>
        <td><button type="button" class="areq-table-detail-btn">詳細</button></td>
      </tr>
    `;
  }).join('');
  bodyEl.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => openRequestDetail(tr.dataset.type, tr.dataset.id));
  });
}

let currentRequestDetail = null;

async function openRequestDetail(sourceType, sourceId) {
  currentRequestDetail = { sourceType, sourceId: Number(sourceId) };
  showScreen('request-detail');
}

// showScreen('request-detail')のたびにSCREEN_ENTER_HOOKSから呼ばれる(通常のクリック遷移でも
// ブラウザの戻る/進むでも、currentRequestDetailに入っている対象を毎回最新の状態で再取得する)。
async function loadRequestDetailContent() {
  if (!currentRequestDetail) return;
  const { sourceType, sourceId } = currentRequestDetail;
  const session = getSession();
  document.getElementById('rdetail-title').textContent = REQUEST_TYPE_LABEL[sourceType] || sourceType;
  document.getElementById('rdetail-fields').innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('rdetail-history').innerHTML = '';
  document.getElementById('rdetail-actions').innerHTML = '';
  hideError('rdetail-error');

  try {
    const rows = await rpc('admin_search_requests', {
      p_admin_employee_code: session.employeeCode, p_request_type: sourceType, p_employee_code: null, p_employee_name: null,
      p_status_group: null, p_date_from: null, p_date_to: null, p_site_name: null, p_partner_name: null, p_keyword: null,
    });
    const r = rows.find((x) => String(x.source_id) === String(sourceId));
    if (!r) { document.getElementById('rdetail-fields').innerHTML = '<div class="hint">見つかりませんでした。</div>'; return; }

    document.getElementById('rdetail-fields').innerHTML = [
      ['申請者', r.employee_name], ['申請日時', new Date(r.requested_at).toLocaleString('ja-JP')],
      ['対象日', r.target_date || '-'], ['現在のステータス', STATUS_GROUP_LABEL[r.status_group] || r.status],
      ['現場', r.site_name || '-'], ['取引先', r.partner_name || '-'], ['金額', r.amount != null ? `${Number(r.amount).toLocaleString()}円` : '-'],
      ['内容', r.summary || '-'],
      ...(r.approver_name ? [['承認者', r.approver_name], ['承認日時', r.decided_at ? new Date(r.decided_at).toLocaleString('ja-JP') : '-']] : []),
    ].map(([label, value]) => `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`).join('');

    const targetTable = sourceType === 'entertainment_preapproval' ? 'entertainment_preapprovals'
      : sourceType === 'qualification' ? 'employee_qualifications' : 'employee_requests';
    const history = await rpc('admin_get_request_audit_log', { p_admin_employee_code: session.employeeCode, p_target_table: targetTable, p_target_id: Number(sourceId) }).catch(() => []);
    const historyEl = document.getElementById('rdetail-history');
    historyEl.innerHTML = history.length === 0 ? '<div class="hint">変更履歴はありません。</div>' : history.map((h) => `
      <div class="change-request-item"><div class="row1"><span>${h.action}</span></div><div class="row2">${h.actor_name}・${new Date(h.created_at).toLocaleString('ja-JP')}</div></div>
    `).join('');

    renderRequestDetailActions(sourceType, r);
  } catch (e) {
    document.getElementById('rdetail-fields').innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function renderRequestDetailActions(sourceType, r) {
  const box = document.getElementById('rdetail-actions');
  // 自己承認防止(バックエンド側でも必ず拒否されるが、UI上でも操作できないことを明示する)。
  const session = getSession();
  if (r.employee_code && session && r.employee_code === session.employeeCode) {
    box.innerHTML = '<div class="hint">自分自身の申請は承認できません。別の管理者による承認が必要です。</div>';
    return;
  }
  if (['expense_reimbursement', 'paid_leave', 'meeting'].includes(sourceType)) {
    if (r.status_group !== 'pending') { box.innerHTML = '<div class="hint">この申請は既に処理済みです。</div>'; return; }
    box.innerHTML = `
      <button type="button" id="rdetail-approve">承認する</button>
      <button type="button" class="secondary" id="rdetail-needs-info">差し戻す(要修正)</button>
      <button type="button" class="secondary" id="rdetail-reject">却下する</button>
      <div id="rdetail-reason-box" style="display:none;">
        <label>理由<span class="required-mark">(必須)</span></label>
        <textarea id="rdetail-reason"></textarea>
        <button type="button" id="rdetail-reason-confirm">確定する</button>
      </div>
    `;
    document.getElementById('rdetail-approve').addEventListener('click', () => doRequestDetailDecide('approved', null));
    document.getElementById('rdetail-needs-info').addEventListener('click', () => { const box = document.getElementById('rdetail-reason-box'); box.dataset.action = 'needs_info'; revealReasonBox(box); });
    document.getElementById('rdetail-reject').addEventListener('click', () => { const box = document.getElementById('rdetail-reason-box'); box.dataset.action = 'rejected'; revealReasonBox(box); });
    document.getElementById('rdetail-reason-confirm').addEventListener('click', () => {
      const reason = document.getElementById('rdetail-reason').value.trim();
      if (!reason) { showError('rdetail-error', '理由を入力してください。'); return; }
      doRequestDetailDecide(document.getElementById('rdetail-reason-box').dataset.action, reason);
    });
  } else if (sourceType === 'supply_item') {
    if (r.status_group !== 'pending') { box.innerHTML = '<div class="hint">この申請は既に処理済みです。</div>'; return; }
    box.innerHTML = `
      <div class="hint" style="margin-bottom:10px;">承認(実際に支給品を渡す)は「支給品の記録・検索」画面から行ってください。</div>
      <button type="button" class="secondary" id="rdetail-supply-reject">却下する</button>
      <div id="rdetail-reason-box" style="display:none;">
        <label>却下理由<span class="required-mark">(必須)</span></label>
        <textarea id="rdetail-reason"></textarea>
        <button type="button" id="rdetail-reason-confirm">確定する</button>
      </div>
    `;
    document.getElementById('rdetail-supply-reject').addEventListener('click', () => { revealReasonBox(document.getElementById('rdetail-reason-box')); });
    document.getElementById('rdetail-reason-confirm').addEventListener('click', async () => {
      const reason = document.getElementById('rdetail-reason').value.trim();
      if (!reason) { showError('rdetail-error', '却下理由を入力してください。'); return; }
      const session = getSession();
      try {
        await rpc('admin_decide_supply_request', { p_admin_employee_code: session.employeeCode, p_request_id: currentRequestDetail.sourceId, p_rejection_reason: reason });
        showScreen('admin-all-requests');
      } catch (e) { showError('rdetail-error', e.message || '処理に失敗しました。'); }
    });
  } else if (sourceType === 'entertainment_preapproval') {
    if (r.status_group !== 'pending' && r.status_group !== 'special_review') { box.innerHTML = '<div class="hint">この申請は既に処理済みです。</div>'; return; }
    const special = r.status_group === 'special_review';
    box.innerHTML = `
      ${special ? `${icon('alert-triangle')}<div class="preapproval-warning">この接待は事前申請されていません。例外承認の理由を入力してください。</div>
        <label>例外承認理由(管理者入力)<span class="required-mark">(必須)</span></label>
        <div class="hint-inline">申請者本人の説明ではなく、管理者が「なぜ事後でも承認するか」を記録する欄です</div>
        <textarea id="rdetail-ent-reason"></textarea>` : ''}
      <button type="button" id="rdetail-ent-approve">${special ? '例外承認する' : '承認する'}</button>
      <button type="button" class="secondary" id="rdetail-ent-reject">却下する</button>
      <div id="rdetail-ent-reject-box" style="display:none;">
        <label>却下理由<span class="hint-inline" style="display:inline;">(任意、入力すると申請者に伝わります)</span></label>
        <textarea id="rdetail-ent-reject-reason"></textarea>
        <button type="button" id="rdetail-ent-reject-confirm">却下を確定する</button>
      </div>
    `;
    document.getElementById('rdetail-ent-approve').addEventListener('click', async () => {
      const session = getSession();
      const reasonEl = document.getElementById('rdetail-ent-reason');
      try {
        await rpc('admin_decide_entertainment_preapproval', { p_admin_employee_code: session.employeeCode, p_id: currentRequestDetail.sourceId, p_action: 'approved', p_exception_reason: reasonEl ? reasonEl.value.trim() : null });
        showScreen('admin-all-requests');
      } catch (e) { showError('rdetail-error', e.message || '処理に失敗しました。'); }
    });
    document.getElementById('rdetail-ent-reject').addEventListener('click', () => {
      revealReasonBox(document.getElementById('rdetail-ent-reject-box'));
    });
    document.getElementById('rdetail-ent-reject-confirm').addEventListener('click', async () => {
      const session = getSession();
      const reason = document.getElementById('rdetail-ent-reject-reason').value.trim();
      try {
        await rpc('admin_decide_entertainment_preapproval', { p_admin_employee_code: session.employeeCode, p_id: currentRequestDetail.sourceId, p_action: 'rejected', p_exception_reason: reason || null });
        showScreen('admin-all-requests');
      } catch (e) { showError('rdetail-error', e.message || '処理に失敗しました。'); }
    });
  } else if (sourceType === 'qualification') {
    box.innerHTML = `<button type="button" class="secondary" data-nav="qual-admin">資格・免許管理で確認する</button>`;
    box.querySelector('[data-nav]').addEventListener('click', () => showScreen('qual-admin'));
  } else {
    box.innerHTML = '<div class="hint">この種類の申請はここからは操作できません。</div>';
  }
}

async function doRequestDetailDecide(action, reason) {
  const session = getSession();
  hideError('rdetail-error');
  try {
    await rpc('admin_decide_request', { p_admin_employee_code: session.employeeCode, p_request_id: currentRequestDetail.sourceId, p_action: action, p_rejection_reason: reason });
    showScreen('admin-all-requests');
  } catch (e) {
    showError('rdetail-error', e.message || '処理に失敗しました。');
  }
}

// ---------- 管理者管理(追加・解除・変更履歴) ----------

let armAllEmployees = [];

async function loadAdminRoleManagement() {
  const session = getSession();
  await Promise.all([loadAdminRoleCurrentList(), loadAdminRoleHistory()]);
  try {
    armAllEmployees = await rpc('list_active_employees', { p_admin_employee_code: session.employeeCode });
  } catch (e) { /* 無視 */ }
  document.getElementById('arm-add-search').value = '';
  document.getElementById('arm-add-candidates').innerHTML = '';
  hideError('arm-error');
}

async function loadAdminRoleCurrentList() {
  const session = getSession();
  const listEl = document.getElementById('arm-current-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_admin_roles', { p_admin_employee_code: session.employeeCode });

    // 社員別にまとめて表示する(1人が複数の権限を持てることが一目で分かるようにする、
    // ユーザー指摘への対応: 「1つのselectから1種類だけ選ぶ構造に見える」)。既存の3区分別
    // 一覧(管理者/日報担当/その他)は個別の解除操作用にそのまま残し、これは追加の要約view。
    const byEmployeeEl = document.getElementById('arm-by-employee-list');
    if (byEmployeeEl) {
      const byEmployee = new Map();
      rows.forEach((r) => {
        if (!byEmployee.has(r.employee_code)) byEmployee.set(r.employee_code, { name: r.employee_name, roles: [] });
        byEmployee.get(r.employee_code).roles.push(r.role_type);
      });
      const entries = [...byEmployee.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'ja'));
      byEmployeeEl.innerHTML = entries.length === 0 ? '<div class="hint">権限を持つ社員はいません。</div>' : entries.map(([code, info]) => `
        <div class="employee-row" style="cursor:default;">
          <span class="employee-avatar">${info.name.slice(0, 1)}</span>
          <div class="employee-row-body">
            <div class="employee-row-name">${info.name}(${code})</div>
            <div class="employee-row-meta">${info.roles.map((rt) => `<span class="mini-tag">${ADMIN_ROLE_LABEL[rt] || rt}</span>`).join(' ')}</div>
          </div>
        </div>
      `).join('');
    }

    const renderRows = (items, roleType) => items.map((r) => `
      <div class="employee-row" data-code="${r.employee_code}" style="cursor:default;">
        <span class="employee-avatar">${r.employee_name.slice(0, 1)}</span>
        <div class="employee-row-body">
          <div class="employee-row-name">${r.employee_name}(${r.employee_code})</div>
          <div class="employee-row-meta">付与: ${r.granted_by}・${new Date(r.granted_at).toLocaleDateString('ja-JP')}</div>
        </div>
        <button type="button" class="reject-btn arm-revoke-btn" data-role-type="${roleType}" style="width:auto;margin:0;">解除</button>
      </div>
    `).join('');

    const general = rows.filter((r) => r.role_type === 'general_admin');
    listEl.innerHTML = general.length === 0 ? '<div class="hint">管理者がいません。</div>' : renderRows(general, 'general_admin');
    listEl.querySelectorAll('.arm-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doRevokeAdminRole(e.target.closest('.employee-row').dataset.code, btn.dataset.roleType));
    });

    const nippoEl = document.getElementById('arm-nippo-list');
    const nippo = rows.filter((r) => r.role_type === 'nippo_admin');
    nippoEl.innerHTML = nippo.length === 0 ? '<div class="hint">日報担当はいません。</div>' : renderRows(nippo, 'nippo_admin');
    nippoEl.querySelectorAll('.arm-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doRevokeAdminRole(e.target.closest('.employee-row').dataset.code, btn.dataset.roleType));
    });

    const otherEl = document.getElementById('arm-other-list');
    const others = rows.filter((r) => !['general_admin', 'nippo_admin'].includes(r.role_type));
    otherEl.innerHTML = others.length === 0 ? '<div class="hint">専門権限を持つ社員はいません。</div>' : others.map((r) => `
      <div class="employee-row" data-code="${r.employee_code}" style="cursor:default;">
        <span class="employee-avatar">${r.employee_name.slice(0, 1)}</span>
        <div class="employee-row-body">
          <div class="employee-row-name">${r.employee_name}(${r.employee_code})</div>
          <div class="employee-row-meta">${ADMIN_ROLE_LABEL[r.role_type] || r.role_type}・付与: ${r.granted_by}・${new Date(r.granted_at).toLocaleDateString('ja-JP')}</div>
        </div>
        <button type="button" class="reject-btn arm-revoke-btn" data-role-type="${r.role_type}" style="width:auto;margin:0;">解除</button>
      </div>
    `).join('');
    otherEl.querySelectorAll('.arm-revoke-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => doRevokeAdminRole(e.target.closest('.employee-row').dataset.code, btn.dataset.roleType));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadAdminRoleHistory() {
  const session = getSession();
  const listEl = document.getElementById('arm-history-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_role_change_history', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">変更履歴はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => {
      const d = r.detail || {};
      const label = r.action === 'admin_role_granted' ? '追加' : '解除';
      return `
        <div class="change-request-item">
          <div class="row1"><span>${d.target_employee_name || ''}を管理者${label}</span></div>
          <div class="row2">${r.actor_name}・${new Date(r.created_at).toLocaleString('ja-JP')}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function renderAdminRoleCandidates(query) {
  const listEl = document.getElementById('arm-add-candidates');
  const q = (query || '').trim();
  if (!q) { listEl.innerHTML = ''; return; }
  const matches = armAllEmployees.filter((e) => e.employee_name.includes(q) || e.employee_code.includes(q)).slice(0, 8);
  listEl.innerHTML = matches.map((e) => `
    <button type="button" class="candidate-item" data-code="${e.employee_code}" data-name="${e.employee_name}">${e.employee_name}(${e.employee_code})</button>
  `).join('');
  listEl.querySelectorAll('.candidate-item').forEach((btn) => {
    btn.addEventListener('click', () => doGrantAdminRole(btn.dataset.code, btn.dataset.name));
  });
}

const ADMIN_ROLE_LABEL = {
  general_admin: '全体管理者', nippo_admin: '日報担当', accounting_admin: '経理承認担当',
  hr_admin: '社員管理担当', subcontractor_admin: '外注管理担当', site_admin: '現場管理担当', device_admin: '端末承認担当',
  expense_approval_exempt: '経費承認免除',
};

async function doGrantAdminRole(employeeCode, employeeName) {
  const session = getSession();
  hideError('arm-error');
  const roleType = document.getElementById('arm-role-type-select').value;
  const roleLabel = ADMIN_ROLE_LABEL[roleType] || roleType;
  if (!window.confirm(`${employeeName}(${employeeCode})を${roleLabel}に追加しますか?`)) return;
  try {
    await rpc('admin_grant_admin_role', { p_admin_employee_code: session.employeeCode, p_target_employee_code: employeeCode, p_role_type: roleType });
    document.getElementById('arm-add-search').value = '';
    document.getElementById('arm-add-candidates').innerHTML = '';
    await Promise.all([loadAdminRoleCurrentList(), loadAdminRoleHistory()]);
  } catch (e) {
    showError('arm-error', e.message || '追加に失敗しました。');
  }
}

async function doRevokeAdminRole(employeeCode, roleType) {
  const session = getSession();
  hideError('arm-error');
  if (!window.confirm(`社員番号${employeeCode}を解除しますか?`)) return;
  try {
    await rpc('admin_revoke_admin_role', { p_admin_employee_code: session.employeeCode, p_target_employee_code: employeeCode, p_role_type: roleType || 'general_admin' });
    await Promise.all([loadAdminRoleCurrentList(), loadAdminRoleHistory()]);
  } catch (e) {
    showError('arm-error', e.message || '解除に失敗しました。');
  }
}

// ---------- 日報管理(管理者/日報担当) ----------

let drmFilters = { name: '', workerType: '', status: '', dateFrom: '', dateTo: '', site: null, companyId: '' };
let drmSelectedDate = null; // 日報管理で選択中の1日(YYYY-MM-DD)。日付ナビで前後移動する。

// 日報管理の日付ナビ(＜ 2026年9月2日(水) ＞ 今日)。選択日を1日だけ表示する主軸。
function renderDrmDateNav() {
  const nav = document.getElementById('drm-date-nav');
  if (!nav) return;
  const today = todayJST();
  const shift = (days) => { const d = new Date(drmSelectedDate + 'T00:00:00'); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  nav.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <button type="button" class="secondary" id="drm-date-prev" style="flex:none;width:auto;padding:8px 14px;">‹</button>
      <div style="flex:1;min-width:0;text-align:center;font-weight:700;font-size:16px;">${formatJpDateWithDow(drmSelectedDate)}</div>
      <button type="button" class="secondary" id="drm-date-next" style="flex:none;width:auto;padding:8px 14px;">›</button>
    </div>
    <div style="display:flex;justify-content:center;margin-top:6px;">
      <button type="button" class="link" id="drm-date-today" ${drmSelectedDate === today ? 'disabled' : ''}>今日</button>
    </div>`;
  // 日付切替時は、選択日のすべての集計(件数要約・内訳バケット・サマリーカード・未提出バナー・一覧)を
  // 選択日で再取得する。renderだけ日付を変えて中身が本日固定のまま、という状態を作らない。
  const setDate = (d) => { drmSelectedDate = d; drmFilters.dateFrom = d; drmFilters.dateTo = d; document.getElementById('drm-date-from').value = d; document.getElementById('drm-date-to').value = d; renderDrmDateNav(); loadDrmSummary(); loadDrmMissingBanner(); loadDailyReportManagementList(); };
  document.getElementById('drm-date-prev').addEventListener('click', () => setDate(shift(-1)));
  document.getElementById('drm-date-next').addEventListener('click', () => setDate(shift(1)));
  const todayBtn = document.getElementById('drm-date-today');
  if (todayBtn) todayBtn.addEventListener('click', () => setDate(today));
}

// 選択日が今日なら「本日」、過去/未来日なら「9月1日」のように表示する接頭辞。
// 過去日を見ているのに「本日の社員/本日の未提出」と表示される矛盾をなくす。
function drmDayPrefix() {
  if (drmSelectedDate === todayJST()) return '本日';
  const d = new Date(drmSelectedDate + 'T00:00:00');
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 未提出バナー(選択日)。日付切替でも選択日で再取得する。
async function loadDrmMissingBanner() {
  const session = getSession();
  const missingEl = document.getElementById('drm-missing-today-list');
  const bannerCount = document.getElementById('drm-missing-count');
  const pfx = drmDayPrefix();
  if (bannerCount) bannerCount.textContent = `${pfx}の未提出 -`;
  try {
    const missing = await rpc('admin_get_daily_report_missing', { p_admin_employee_code: session.employeeCode, p_date: drmSelectedDate });
    if (bannerCount) bannerCount.textContent = `${pfx}の未提出 ${missing.length}名`;
    if (missingEl) missingEl.innerHTML = missing.length === 0
      ? `<div class="hint">${pfx}は全員提出済みです。</div>`
      : missing.map((m) => `<span class="mini-tag danger" style="display:inline-block;margin:2px 4px 2px 0;">${m.employee_name}</span>`).join('');
  } catch (e) {
    if (missingEl) missingEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

// 選択日「その1日だけ」の件数要約(合計・社員・外注・提出済み・差し戻し・下書き・取消)。
// 過去/未来日が混ざって数字が変動する状態をなくす。カード(=会社×現場×勤務区分/社員×日)単位で数える。
async function renderDrmDaySummary() {
  const el = document.getElementById('drm-day-summary');
  if (!el) return;
  const session = getSession();
  try {
    // 内訳バケット(admin_daily_report_breakdown)を単一の正として、社員の「提出済み(対象内)」件数を得る。
    const [rows, bdRows] = await Promise.all([
      rpc('admin_search_daily_reports', {
        p_admin_employee_code: session.employeeCode, p_date_from: drmSelectedDate, p_date_to: drmSelectedDate,
        p_employee_code: null, p_site_id: null, p_validation_status: null,
        p_worker_type: null, p_subcontractor_company_id: null, p_report_status: null,
      }),
      rpc('admin_daily_report_breakdown', { p_admin_employee_code: session.employeeCode, p_date: drmSelectedDate }).catch(() => []),
    ]);
    const bd = (bdRows && bdRows[0]) || {};
    // 社員は「同一社員×同一日=1名」で数える(drmGroupKeyが社員は date|employee|employee_code)。
    const groups = new Map();
    rows.forEach((r) => { const k = drmGroupKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const cards = Array.from(groups.values()).map((g) => ({ worker: g[0].worker_type, status: (g.every((r) => r.report_status === 'cancelled') ? 'cancelled' : (g.find((r) => r.report_status !== 'cancelled') || g[0]).report_status) }));
    const active = cards.filter((c) => c.status !== 'cancelled');
    const emp = active.filter((c) => c.worker === 'employee');
    const sc = active.filter((c) => c.worker === 'subcontractor');
    // 通常提出=submitted/confirmed(通常日報は自動確定するため二重定義しない)。差し戻しは要確認側。
    const empSubmitted = emp.filter((c) => c.status === 'submitted' || c.status === 'confirmed').length;
    const empRejected = emp.filter((c) => c.status === 'rejected').length;
    const empDraft = emp.filter((c) => c.status === 'draft').length;
    // 配置外(要確認)= 提出したが日報提出対象(配置あり)でない社員 = 提出者 − 対象内提出(bucket)。
    const offAssign = Math.max(0, empSubmitted - Number(bd.target_submitted || 0));
    el.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;">合計 ${active.length}件（社員 ${emp.length}名 / 外注 ${sc.length}件）</div>
      <div class="drm-day-sum-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;font-size:14px;overflow-wrap:anywhere;">
        <span>社員 提出済み ${empSubmitted}名</span><span>外注 ${sc.length}件</span>
        ${offAssign > 0 ? `<span style="color:var(--warning,#e0a021);">└ うち配置外(要確認) ${offAssign}名</span><span></span>` : ''}
        <span>差し戻し ${empRejected}名</span><span>下書き ${empDraft}名</span>
        <span>取消 ${cards.length - active.length}件</span>
      </div>`;
  } catch (e) { el.innerHTML = ''; }
}
let drmRows = [];
let drmSelected = new Set(); // 選択中のグループキー(report_date|personKey)
let drmSort = { col: 'report_date', dir: 'desc' };

const DRM_STATUS_LABEL = { draft: '下書き', submitted: '提出済み', confirmed: '確認済み', rejected: '差し戻し' };

async function loadDailyReportManagement() {
  const session = getSession();
  // 日報管理は「日付」を主軸に。既定は本日の1日だけを表示(過去・未来日は日付ナビで移動)。
  const today = todayJST();
  drmSelectedDate = drmSelectedDate || today;
  drmFilters = { name: '', workerType: '', status: '', dateFrom: drmSelectedDate, dateTo: drmSelectedDate, site: null, companyId: '' };
  drmSelected.clear();
  document.getElementById('drm-search-name').value = '';
  document.getElementById('drm-search-site').value = '';
  document.getElementById('drm-selected-site-label').style.display = 'none';
  document.getElementById('drm-site-candidates').innerHTML = '';
  document.getElementById('drm-date-from').value = drmSelectedDate;
  document.getElementById('drm-date-to').value = drmSelectedDate;
  renderDrmDateNav();
  document.getElementById('drm-advanced').style.display = 'none';
  document.getElementById('drm-missing-today-list').style.display = 'none';
  document.getElementById('drm-missing-toggle').textContent = '未提出者を表示する';
  document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
  document.querySelectorAll('#drm-status-filter .filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));

  loadDrmMissingBanner();

  try {
    const companies = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: false });
    document.getElementById('drm-company-select').innerHTML = '<option value="">すべての外注会社</option>' + companies.map((c) => `<option value="${c.id}">${c.company_name}</option>`).join('');
  } catch (e) { /* 無視 */ }

  loadDrmSummary();
  loadDailyReportManagementList();
}

const DRM_SUMMARY_CARDS = [
  { key: 'submitted_count', label: '本日の提出' },
  { key: 'missing_count', label: '本日の未提出' },
  { key: 'pending_confirm_count', label: '確認待ち' },
  { key: 'rejected_count', label: '差し戻し' },
  { key: 'confirmed_count', label: '確認済み' },
  { key: 'exempt_count', label: '日報対象外' },
];

// 本日の社員を「提出対象(提出済み/未提出)」と「対象外(休日/有給/その他休暇/その他)」へ
// 重複なく分類して表示する。各数字はタップで対象者一覧へ遷移する(誰なのかが分かる)。
async function loadDrmBreakdown() {
  const session = getSession();
  const el = document.getElementById('drm-breakdown');
  if (!el) return;
  try {
    const rows = await rpc('admin_daily_report_breakdown', { p_admin_employee_code: session.employeeCode, p_date: drmSelectedDate });
    const b = rows && rows[0];
    if (!b) { el.innerHTML = ''; return; }
    const num = (bucket, n, cls) => `<button type="button" class="drm-bd-num ${cls || ''}" data-bucket="${bucket}">${n}</button>`;
    el.innerHTML = `
      <div class="card drm-breakdown-card">
        <div class="drm-bd-row drm-bd-total"><span>${drmDayPrefix()}の社員</span><strong>${b.total_employees}名</strong></div>
        <div class="drm-bd-row"><span>├ 日報提出対象</span><strong>${b.target_total}名</strong></div>
        <div class="drm-bd-row drm-bd-sub"><span>│　├ 提出済み</span>${num('target_submitted', b.target_submitted + '名', 'good')}</div>
        <div class="drm-bd-row drm-bd-sub"><span>│　└ 未提出</span>${num('missing', b.target_missing + '名', b.target_missing > 0 ? 'alert' : '')}</div>
        <div class="drm-bd-row"><span>└ 日報対象外</span><strong>${b.exempt_total}名</strong></div>
        <div class="drm-bd-row drm-bd-sub"><span>　├ 休日/勤務予定なし</span>${num('holiday', b.exempt_holiday + '名')}</div>
        <div class="drm-bd-row drm-bd-sub"><span>　├ 有給</span>${num('paid_leave', b.exempt_paid_leave + '名')}</div>
        <div class="drm-bd-row drm-bd-sub"><span>　├ その他休暇</span>${num('other_leave', b.exempt_other_leave + '名')}</div>
        <div class="drm-bd-row drm-bd-sub"><span>　└ その他対象外</span>${num('other_exempt', b.exempt_other + '名')}</div>
      </div>`;
    el.querySelectorAll('.drm-bd-num').forEach((btn) => {
      btn.addEventListener('click', () => openDailyReportPeople(btn.dataset.bucket));
    });
    return b;
  } catch (e) {
    // §4: 取得失敗は空表示にせず、古い件数も残さず、明示エラー+再読み込み。
    el.innerHTML = '<div class="card drm-breakdown-card"><div class="hint" style="color:var(--danger);">内訳の読み込みに失敗しました。</div><button type="button" class="secondary" id="drm-bd-retry" style="margin-top:8px;">再読み込み</button></div>';
    const rb = document.getElementById('drm-bd-retry');
    if (rb) rb.addEventListener('click', () => loadDrmSummary());
    return null;
  }
}

async function loadDrmSummary() {
  const session = getSession();
  const grid = document.getElementById('drm-summary-grid');
  grid.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const [rows, bd] = await Promise.all([
      rpc('admin_get_daily_report_summary', { p_admin_employee_code: session.employeeCode, p_date: drmSelectedDate }),
      loadDrmBreakdown(),
    ]);
    const d = Object.assign({}, rows && rows[0]);
    if (bd) d.exempt_count = bd.exempt_total; // 対象外は breakdown から
    const pfx = drmDayPrefix();
    grid.innerHTML = DRM_SUMMARY_CARDS.map((c) => {
      const count = d ? (d[c.key] || 0) : 0;
      const label = c.label.replace('本日', pfx); // 過去日を見ている時は「9月1日の提出」等
      return `
        <button type="button" class="dash-card drm-summary-card" data-card="${c.key}" title="タップで${label}の対象者を表示">
          <span class="dash-card-top"><span class="dash-card-count ${count === 0 ? 'zero' : 'alert'}">${count}</span></span>
          <span class="dash-card-label">${label}</span>
        </button>
      `;
    }).join('');
    grid.querySelectorAll('.drm-summary-card').forEach((btn) => {
      btn.addEventListener('click', () => applyDrmCardFilter(btn.dataset.card));
    });
  } catch (e) {
    // §4: 取得失敗はカードの古い件数を残さず、明示エラー+再読み込み導線。
    grid.innerHTML = '<div class="hint" style="color:var(--danger);">読み込みに失敗しました。</div><button type="button" class="secondary" id="drm-sum-retry" style="margin-top:8px;">再読み込み</button>';
    const rb = document.getElementById('drm-sum-retry');
    if (rb) rb.addEventListener('click', () => loadDrmSummary());
  }
}

// 分類別の対象者一覧画面へ。bucket 例: missing/exempt/holiday/paid_leave/other_leave/other_exempt/
// target_submitted/anomaly/unconfirmed。
const DRP_TITLES = {
  missing: '本日の未提出', target_submitted: '本日の提出', exempt: '日報対象外',
  holiday: '休日 / 勤務予定なし', paid_leave: '有給', other_leave: 'その他休暇', other_exempt: 'その他対象外',
  anomaly: '要確認の日報', unconfirmed: '配置を未確認の社員',
};
let dailyReportPeopleState = null;
function openDailyReportPeople(bucket, title) {
  // 対象者一覧も選択日で取得する(本日固定にしない)。過去日なら見出しも「9月1日の…」にする。
  const t = (title || DRP_TITLES[bucket] || '対象者一覧').replace('本日', drmDayPrefix());
  dailyReportPeopleState = { bucket, title: t, date: drmSelectedDate };
  showScreen('daily-report-people');
}
async function loadDailyReportPeople() {
  if (!dailyReportPeopleState) return;
  const session = getSession();
  const { bucket, title, date } = dailyReportPeopleState;
  document.getElementById('drp-title').textContent = title;
  const listEl = document.getElementById('drp-list');
  const subEl = document.getElementById('drp-sub');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  subEl.textContent = '';
  try {
    const rows = await rpc('admin_list_daily_report_people', { p_admin_employee_code: session.employeeCode, p_date: date, p_bucket: bucket });
    // §4: 取得成功して初めて件数を出す。0件は「対象者はいません」と明示(取得失敗と混同しない)。
    subEl.textContent = `${(rows || []).length}名`;
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">対象者はいません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="history-item">
        <div class="row1"><span>${r.employee_name}</span><span class="mini-tag">${r.employee_code}</span></div>
        ${r.line1 ? `<div class="row2">${r.line1}</div>` : ''}
        ${r.line2 ? `<div class="row2">${r.line2}</div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    // §4: 取得失敗は 0件 と絶対に混同しない。古い件数も残さず、再読み込み導線を出す。
    subEl.textContent = '取得エラー';
    listEl.innerHTML = '<div class="hint" style="color:var(--danger);">読み込みに失敗しました。通信状況をご確認ください。</div><button type="button" class="secondary" id="drp-retry" style="margin-top:8px;">再読み込み</button>';
    const rb = document.getElementById('drp-retry');
    if (rb) rb.addEventListener('click', () => loadDailyReportPeople());
  }
}

// 本日サマリーの数字カードのタップで、その状態の本日分だけに日報一覧を絞り込む。
// 未提出カードは一覧(=提出済みの行)には現れないため、未提出者リストを開いてそこへ誘導する。
const DRM_CARD_TO_STATUS = {
  submitted_count: '',        // 本日の提出(提出済み/確認済み/差し戻しすべて)
  pending_confirm_count: 'submitted', // 確認待ち(=提出済みで未確認)
  rejected_count: 'rejected',
  confirmed_count: 'confirmed',
};
function applyDrmCardFilter(cardKey) {
  const today = todayJST();
  // 未提出/対象外は日報一覧(=提出済みの行)には出ないため、専用の対象者一覧へ遷移する。
  if (cardKey === 'missing_count') { openDailyReportPeople('missing'); return; }
  if (cardKey === 'exempt_count') { openDailyReportPeople('exempt'); return; }
  const status = DRM_CARD_TO_STATUS[cardKey] || '';
  // 本日分に日付を固定
  drmFilters.dateFrom = today; drmFilters.dateTo = today;
  document.getElementById('drm-date-from').value = today;
  document.getElementById('drm-date-to').value = today;
  // 外注/自社の絞り込みは「すべて」に戻す(カードは全員対象のため)
  drmFilters.workerType = '';
  document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((b, i) => b.classList.toggle('active', i === 0));
  // 状態フィルタを同期
  drmFilters.status = status;
  document.querySelectorAll('#drm-status-filter .filter-chip').forEach((b) => {
    b.classList.toggle('active', (b.dataset.status || '') === status);
  });
  loadDailyReportManagementList();
  const listEl = document.getElementById('drm-list');
  if (listEl) listEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drmGroupKey(r) {
  // 外注(応援)は作業員名を持たないため、従来キー(worker_name)だと同日の別会社・別現場が
  // 1カードに束ねられていた。外注は日報行(id)ごとに独立カードにし、会社×現場×勤務区分を分ける。
  if (r.worker_type === 'subcontractor') return `${r.report_date}|sc|${r.id}`;
  return `${r.report_date}|${r.worker_type}|${r.employee_code}`;
}

async function loadDailyReportManagementList() {
  const session = getSession();
  const listEl = document.getElementById('drm-list');
  const countEl = document.getElementById('drm-count');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('drm-table-body').innerHTML = '';
  try {
    drmRows = await rpc('admin_search_daily_reports', {
      p_admin_employee_code: session.employeeCode,
      p_date_from: drmFilters.dateFrom || null, p_date_to: drmFilters.dateTo || null,
      p_employee_code: null, p_site_id: drmFilters.site || null,
      p_validation_status: null,
      p_worker_type: drmFilters.workerType || null,
      p_subcontractor_company_id: drmFilters.companyId ? Number(drmFilters.companyId) : null,
      p_report_status: drmFilters.status || null,
    });
    if (drmFilters.name) {
      const q = drmFilters.name;
      drmRows = drmRows.filter((r) => (r.employee_name || '').includes(q) || (r.subcontractor_worker_name || '').includes(q));
    }
    countEl.textContent = `${drmRows.length}件`;
    renderDrmAll();
    renderDrmDaySummary();
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function drmGroupSortValue(g, col) {
  const f = g.first;
  if (col === 'person_name') return f.worker_type === 'subcontractor' ? (f.subcontractor_worker_name || '') : (f.employee_name || '');
  if (col === 'company_name') return f.subcontractor_company_name || '';
  return f[col];
}

function sortDrmGroups(groupList) {
  const { col, dir } = drmSort;
  if (!col) return groupList;
  const sorted = groupList.slice().sort((a, b) => {
    let av = drmGroupSortValue(a, col);
    let bv = drmGroupSortValue(b, col);
    if (col === 'worker_type' || col === 'person_name' || col === 'company_name' || col === 'report_status') {
      av = av || ''; bv = bv || '';
      return String(av).localeCompare(String(bv), 'ja');
    }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (col === 'submitted_at') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
    return av > bv ? 1 : av < bv ? -1 : 0;
  });
  if (dir === 'desc') sorted.reverse();
  return sorted;
}

// 日報一覧/詳細の担当者表示ラベル(§9: 「null(外注:)」を出さない)。外注は3モデルを吸収する:
//  1) 応援(会社×現場×人数)モデル … 作業員名が無いので「外注（応援） 会社名」+ 人数/人工。
//  2) 旧・作業員紐付けモデル … 作業員名(外注:会社名)。
//  3) 社員 … 氏名。いずれの値も欠けたら (不明) を出し、null文字は絶対に出さない。
// item12: 'YYYY-MM-DD' → '2026年9月2日(火)' (詳細の日付を明確化)。
function formatJpDateWithDow(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日(${dow})`;
}

function drmWorkerLabel(f) {
  if (f && f.worker_type === 'subcontractor') {
    // 会社未設定(subcontractor_company_id NULL)の既存データは「会社未設定・要修正」と明示(推測しない)。
    const co = f.subcontractor_company_name || '会社未設定・要修正';
    if (f.subcontractor_worker_name) return `${f.subcontractor_worker_name}(外注:${co})`;
    const ppl = (f.subcontractor_headcount != null && f.subcontractor_headcount !== '') ? ` ${Number(f.subcontractor_headcount)}名` : '';
    return `外注（応援） ${co}${ppl}`;
  }
  return (f && f.employee_name) || '(不明)';
}

function renderDrmAll() {
  // report_date + 対象者 でグループ化し、現場1/現場2を横に並べる(スプレッドシートの
  // 「1日=現場1行+現場2行」構造とも対応させやすいよう、スロット順に並べる)。
  const groups = new Map();
  drmRows.forEach((r) => {
    const key = drmGroupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  let groupList = Array.from(groups.entries()).map(([key, rows]) => {
    rows.sort((a, b) => (a.entry_slot || 0) - (b.entry_slot || 0));
    return { key, rows, first: rows[0] };
  });
  // item13: 通常一覧では「全スロットが取消済み」の日報グループを除外する(集計・人工・シート反映の
  // 対象外なので一覧にも残さない)。「取消」タブを選んだ時だけ取消済みを表示する。監査履歴はDBに残る。
  if (drmFilters.status !== 'cancelled') {
    groupList = groupList.filter((g) => g.rows.some((r) => r.report_status !== 'cancelled'));
  }
  groupList = sortDrmGroups(groupList);

  document.querySelectorAll('#screen-daily-report-management .areq-table th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === drmSort.col);
    th.classList.toggle('desc', th.dataset.sort === drmSort.col && drmSort.dir === 'desc');
  });

  const listEl = document.getElementById('drm-list');
  if (groupList.length === 0) { listEl.innerHTML = '<div class="hint">該当する日報はありません。</div>'; document.getElementById('drm-table-body').innerHTML = '<tr><td colspan="12"><div class="hint">該当する日報はありません。</div></td></tr>'; return; }

  listEl.innerHTML = groupList.map((g) => {
    const f = g.first;
    const personName = drmWorkerLabel(f);
    const sites = g.rows.map((r) => `${r.site_name || '(現場不明)'}・${r.work_type || ''}`).join(' / ');
    const statusBadgeClass = f.report_status === 'confirmed' ? 'done' : (f.report_status === 'rejected' ? 'rejected' : '');
    return `
      <div class="history-item" data-key="${g.key}">
        <div class="row1"><span>${personName}</span><span>${f.report_date}</span></div>
        <div class="row2">${sites}</div>
        <span class="status-badge ${statusBadgeClass}">${DRM_STATUS_LABEL[f.report_status] || f.report_status}</span>
        ${f.validation_status === 'anomaly' ? '<span class="mini-tag danger">要確認</span>' : ''}
        ${g.rows.some((r) => r.reflect_override_work_type) ? '<span class="mini-tag info">反映値を調整済み</span>' : ''}
        ${g.rows.every((r) => r.reflected_to_sheet_at) ? '<span class="mini-tag info">シート反映済み</span>' : ''}
        <div class="checkbox-row"><input type="checkbox" class="drm-row-check" data-key="${g.key}" ${drmSelected.has(g.key) ? 'checked' : ''}><label>選択</label></div>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.drm-row-check').forEach((cb) => {
    cb.addEventListener('change', () => { toggleDrmSelect(cb.dataset.key, cb.checked); });
  });
  listEl.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('drm-row-check') || ev.target.tagName === 'LABEL') return;
      openDailyReportDetail(el.dataset.key);
    });
  });

  const bodyEl = document.getElementById('drm-table-body');
  bodyEl.innerHTML = groupList.map((g) => {
    const f = g.first;
    const site1 = g.rows[0] || {};
    const site2 = g.rows[1] || {};
    const personName = f.worker_type === 'subcontractor' ? f.subcontractor_worker_name : f.employee_name;
    const statusBadgeClass = f.report_status === 'confirmed' ? 'done' : (f.report_status === 'rejected' ? 'rejected' : '');
    const reflected = g.rows.every((r) => r.reflected_to_sheet_at);
    return `
      <tr data-key="${g.key}">
        <td><input type="checkbox" class="drm-row-check" data-key="${g.key}" ${drmSelected.has(g.key) ? 'checked' : ''}></td>
        <td>${f.report_date}</td>
        <td>${f.worker_type === 'subcontractor' ? '外注' : '社員'}</td>
        <td>${personName || '(不明)'}</td>
        <td>${f.subcontractor_company_name || '-'}</td>
        <td>${site1.site_name || '-'}</td>
        <td>${site1.work_type || '-'}</td>
        <td>${site2.site_name ? `${site2.site_name}(${site2.work_type || ''})` : '-'}</td>
        <td>${f.submitted_at ? new Date(f.submitted_at).toLocaleString('ja-JP') : '-'}</td>
        <td>${DRM_STATUS_LABEL[f.report_status] || f.report_status}${g.rows.some((r) => r.reflect_override_work_type) ? ' <span class="mini-tag info">調整済み</span>' : ''}</td>
        <td><span class="status-badge ${statusBadgeClass}">${f.confirmed_by ? f.confirmed_by : (f.report_status === 'confirmed' || f.report_status === 'rejected' ? '-' : '未確認')}</span></td>
        <td>${reflected ? '反映済み' : '未反映'}</td>
      </tr>
    `;
  }).join('');
  bodyEl.querySelectorAll('.drm-row-check').forEach((cb) => {
    cb.addEventListener('change', () => { toggleDrmSelect(cb.dataset.key, cb.checked); });
  });
  bodyEl.querySelectorAll('tr[data-key]').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('drm-row-check')) return;
      openDailyReportDetail(tr.dataset.key);
    });
  });

  updateDrmBulkBar();
}

// 日報1件(グループ=同一日・同一対象者の現場1/2スロット)の詳細画面。
// 「原本(本人が提出した内容)」は表示専用、「スプレッドシートへ反映する内容」は
// 管理者が調整できる(reflect_override_*)。既にloadDailyReportManagementListで
// 取得済みのdrmRowsから該当グループを探すだけで、追加のRPC呼び出しは不要。
let currentDrdGroupKey = null;
// 日報詳細の「原本」表示: 社員が入力した給与・勤怠・手当に必要な全項目をグループ表示する。
// 給与判定に直結するP0項目(現場/勤務区分/人工/リーダー/夜勤/残業/出張/100km/通勤/早出)は
// false/0でも「あり/なし」を明示して未登録と区別する。副次項目は値がある時のみ表示する。
function drdFieldRow(label, value) {
  return `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`;
}
function drdEmployeeOriginalHtml(r, effWorkType, effLeader, effNight) {
  const yn = (v) => (v ? 'あり' : 'なし');
  const num = (v) => (v == null ? 0 : Number(v));
  const site = r.site_name || r.site_raw_name || '-';
  // 【勤務情報】P0: 常に表示
  const work = [
    drdFieldRow('現場', site),
    drdFieldRow('勤務区分', (r.work_type || '-') + (r.is_leader ? '・リーダー' : '') + (r.is_night_shift ? '・夜勤' : '')),
    drdFieldRow('人工', num(r.headcount) + '人工'),
    drdFieldRow('リーダー/職長', yn(r.is_leader)),
    drdFieldRow('夜勤', yn(r.is_night_shift)),
    drdFieldRow('残業時間', num(r.overtime_hours) > 0 ? num(r.overtime_hours) + '時間' : 'なし'),
  ].join('');
  // 【勤怠・手当】P0 + 副次(値ありのみ)
  const attend = [];
  attend.push(drdFieldRow('早出', num(r.early_commute_hours) > 0 ? num(r.early_commute_hours) + '時間' : 'なし'));
  attend.push(drdFieldRow('通勤時間外', num(r.commute_overtime_hours) > 0 ? num(r.commute_overtime_hours) + '時間' : 'なし'));
  attend.push(drdFieldRow('100km以上', yn(r.is_over_100km)));
  attend.push(drdFieldRow('出張', r.is_business_trip ? ('あり' + (r.is_overnight ? `（${num(r.overnight_nights)}泊）` : '')) : 'なし'));
  if (r.is_business_trip && (r.business_trip_allowance_eligible || num(r.business_trip_allowance_amount) > 0)) {
    attend.push(drdFieldRow('出張手当', (r.business_trip_allowance_eligible ? '対象' : '対象外') + (num(r.business_trip_allowance_amount) > 0 ? `（${num(r.business_trip_allowance_amount).toLocaleString()}円）` : '')));
  }
  if (r.is_transport) attend.push(drdFieldRow('運搬/交通', 'あり'));
  if (r.is_field_duty) attend.push(drdFieldRow('現場作業', 'あり'));
  if (r.is_sales) attend.push(drdFieldRow('営業', 'あり'));
  if (r.is_out_of_prefecture || r.prefecture) attend.push(drdFieldRow('県外', r.prefecture || 'あり'));
  if (r.is_absence) attend.push(drdFieldRow('欠勤', 'あり'));
  // 【作業内容】
  const content = [];
  const memo = r.notes || r.note;
  if (memo) content.push(drdFieldRow('備考', String(memo).replace(/</g, '&lt;')));
  return `
    <div class="field-subgroup"><div class="field-subhead">勤務情報</div>${work}</div>
    <div class="field-subgroup"><div class="field-subhead">勤怠・手当</div>${attend.join('')}</div>
    ${content.length ? `<div class="field-subgroup"><div class="field-subhead">作業内容</div>${content.join('')}</div>` : ''}`;
}

async function openDailyReportDetail(groupKey) {
  currentDrdGroupKey = groupKey;
  const rows = drmRows.filter((r) => drmGroupKey(r) === groupKey).sort((a, b) => (a.entry_slot || 0) - (b.entry_slot || 0));
  showScreen('daily-report-detail');
  if (rows.length === 0) {
    document.getElementById('drd-title').textContent = '日報詳細';
    document.getElementById('drd-meta').textContent = '該当する日報が見つかりませんでした。';
    document.getElementById('drd-slots').innerHTML = '';
    document.getElementById('drd-history').innerHTML = '';
    return;
  }
  const f = rows[0];
  const personName = drmWorkerLabel(f);
  // item12: 詳細上部に必ず「年月日(曜日)」を大きく表示。氏名・社員番号/外注・状態も併記。
  const idLabel = f.worker_type === 'subcontractor' ? '外注' : (f.employee_code ? `社員番号 ${f.employee_code}` : '');
  document.getElementById('drd-title').textContent = formatJpDateWithDow(f.report_date);
  // 外注(応援)は 合計人数・合計人工 を要約表示(§9)。取消済み行は合計から除外。
  const activeRows = rows.filter((r) => r.report_status !== 'cancelled');
  let metaText = `${personName}${idLabel ? '（' + idLabel + '）' : ''} ・ 提出状況: ${DRM_STATUS_LABEL[f.report_status] || f.report_status}`;
  if (f.worker_type === 'subcontractor') {
    const totalPeople = activeRows.reduce((a, r) => a + (r.subcontractor_headcount != null ? Number(r.subcontractor_headcount) : 0), 0);
    const totalManDays = activeRows.reduce((a, r) => a + Number(r.headcount || 0), 0);
    metaText = `外注（応援）｜合計 ${totalPeople}名 / ${totalManDays}人工　${metaText}`;
  }
  document.getElementById('drd-meta').textContent = metaText;

  document.getElementById('drd-slots').innerHTML = rows.map((r, idx) => {
    const effWorkType = r.reflect_override_work_type || r.work_type;
    const effLeader = r.reflect_override_work_type ? r.reflect_override_is_leader : r.is_leader;
    const effNight = r.reflect_override_work_type ? r.reflect_override_is_night_shift : r.is_night_shift;
    return `
      <div class="card" data-slot-id="${r.id}">
        <div class="form-title" style="font-size:15px;">現場${idx + 1}${rows.length > 1 ? `（${idx + 1}件目 / 全${rows.length}件）` : ''}</div>
        <div class="field-group">
          ${f.worker_type === 'subcontractor' ? `
          <div class="field-row"><span class="field-label">外注会社</span><span class="field-value">${f.subcontractor_company_name || '(会社未設定)'}</span></div>
          <div class="field-row"><span class="field-label">現場</span><span class="field-value">${r.site_name || r.site_raw_name || '-'}</span></div>
          <div class="field-row"><span class="field-label">勤務区分</span><span class="field-value">${r.work_type || '-'}${r.is_night_shift ? '・夜勤' : ''}</span></div>
          <div class="field-row"><span class="field-label">人数</span><span class="field-value">${r.subcontractor_headcount != null ? Number(r.subcontractor_headcount) + '名' : '-'}</span></div>
          <div class="field-row"><span class="field-label">人工</span><span class="field-value">${Number(r.headcount || 0)}人工</span></div>
          ${r.notes || r.note ? `<div class="field-row"><span class="field-label">備考</span><span class="field-value">${String(r.notes || r.note).replace(/</g, '&lt;')}</span></div>` : ''}
          ` : drdEmployeeOriginalHtml(r, effWorkType, effLeader, effNight)}
          <div class="field-row"><span class="field-label">スプレッドシート反映</span><span class="field-value">${r.report_status === 'cancelled' ? '対象外(取消済み)' : (r.reflected_to_sheet_at ? `反映済み(${new Date(r.reflected_to_sheet_at).toLocaleString('ja-JP')})` : '未反映')}</span></div>
          ${r.reflect_override_work_type ? `<div class="field-row"><span class="field-label">反映値を調整</span><span class="field-value">${r.reflect_override_by || ''} ${r.reflect_override_at ? new Date(r.reflect_override_at).toLocaleString('ja-JP') : ''}${r.reflect_override_reason ? `(${r.reflect_override_reason})` : ''}</span></div>` : ''}
        </div>
        ${r.report_status === 'cancelled'
          ? '<div class="mini-tag muted">この行は取消済みです(集計・人工・シート反映の対象外)</div>'
          : `<button type="button" class="secondary drd-cancel-row" data-report-id="${r.id}" data-date="${r.report_date}" style="color:var(--danger);border-color:var(--danger);">この日報を取消する</button>`}
        <div class="form-title" style="font-size:14px;">スプレッドシートへ反映する内容</div>
        <label>現場</label>
        <input type="text" class="drd-site-search" data-slot-id="${r.id}" placeholder="現場名で検索" value="${r.reflect_override_site_name || r.site_name || ''}">
        <input type="hidden" class="drd-site-id" data-slot-id="${r.id}" value="${r.reflect_override_site_id || r.site_id || ''}">
        <div class="drd-site-candidates" data-slot-id="${r.id}"></div>
        <label>勤務区分</label>
        <div class="filter-row drd-worktype" data-slot-id="${r.id}">
          <button type="button" class="filter-chip ${effWorkType === '終日' ? 'active' : ''}" data-work-type="終日">終日</button>
          <button type="button" class="filter-chip ${effWorkType === '午前' ? 'active' : ''}" data-work-type="午前">午前</button>
          <button type="button" class="filter-chip ${effWorkType === '午後' ? 'active' : ''}" data-work-type="午後">午後</button>
        </div>
        <label class="checkbox-row"><input type="checkbox" class="drd-leader" data-slot-id="${r.id}" ${effLeader ? 'checked' : ''}> リーダーとして参加</label>
        <label class="checkbox-row"><input type="checkbox" class="drd-night" data-slot-id="${r.id}" ${effNight ? 'checked' : ''}> 夜勤</label>
        <label>調整理由(任意)</label>
        <textarea class="drd-reason" data-slot-id="${r.id}"></textarea>
        <button type="button" class="drd-save" data-slot-id="${r.id}">保存(反映値を調整して再反映予約)</button>
        ${r.reflect_override_work_type ? `<button type="button" class="secondary drd-clear" data-slot-id="${r.id}">原本に戻す</button>` : ''}
        <div class="hint drd-result" data-slot-id="${r.id}"></div>
      </div>
    `;
  }).join('');

  wireDailyReportDetailSlots(rows);

  const historyEl = document.getElementById('drd-history');
  historyEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const session = getSession();
    const histories = await Promise.all(rows.map((r) => rpc('admin_get_daily_report_audit_log', { p_admin_employee_code: session.employeeCode, p_daily_report_id: r.id }).catch(() => [])));
    const merged = histories.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    historyEl.innerHTML = merged.length === 0 ? '<div class="hint">変更履歴はありません。</div>' : merged.map((h) => `
      <div class="change-request-item"><div class="row1"><span>${h.action}</span></div><div class="row2">${h.actor_name}・${new Date(h.created_at).toLocaleString('ja-JP')}</div></div>
    `).join('');
  } catch (e) {
    historyEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function wireDailyReportDetailSlots(rows) {
  const slotsEl = document.getElementById('drd-slots');
  // §10: 管理者が誤登録の日報行(外注含む)を id 指定で論理取消する。取消後は集計・人工・
  // Spreadsheet 反映対象から除外され、監査ログが残る。
  slotsEl.querySelectorAll('.drd-cancel-row').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reportId = Number(btn.dataset.reportId);
      if (!window.confirm('この日報を取り消しますか？\n\n取消すと、出勤・人工・給与・Spreadsheet反映の集計対象から除外されます。\n履歴には「取消済み」として残ります。')) return;
      const reason = window.prompt('取消理由を入力してください（例: 誤って登録した / 会社・人数を間違えた など）');
      if (reason === null) return;
      if (!reason.trim()) { alert('取消理由を入力してください。'); return; }
      btn.disabled = true;
      try {
        const session = getSession();
        const res = await rpc('admin_cancel_daily_report_by_id', { p_admin_employee_code: session.employeeCode, p_report_id: reportId, p_reason: reason.trim() });
        const hadReflected = Array.isArray(res) && res[0] && res[0].out_had_reflected;
        alert('この日報を取消しました。集計・人工・Spreadsheet反映の対象から除外されます。' + (hadReflected ? '\n\n※既にシート反映済みだったため、次回の反映処理で訂正されます。' : ''));
        // 一覧(drmRows)を再取得してから同じ詳細を開き直す(取消済み表示に更新)。
        await loadDailyReportManagementList();
        if (currentDrdGroupKey) openDailyReportDetail(currentDrdGroupKey);
        else showScreen('daily-report-management');
      } catch (e) {
        alert(e.message || '取消に失敗しました。');
        btn.disabled = false;
      }
    });
  });
  slotsEl.querySelectorAll('.drd-worktype').forEach((row) => {
    row.querySelectorAll('.filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.filter-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  let siteSearchTimer = null;
  slotsEl.querySelectorAll('.drd-site-search').forEach((input) => {
    input.addEventListener('input', () => {
      clearTimeout(siteSearchTimer);
      const slotId = input.dataset.slotId;
      const q = input.value.trim();
      const candEl = slotsEl.querySelector(`.drd-site-candidates[data-slot-id="${slotId}"]`);
      siteSearchTimer = setTimeout(async () => {
        if (!q) { candEl.innerHTML = ''; return; }
        const session = getSession();
        try {
          const sites = await rpc('admin_search_sites_simple', { p_admin_employee_code: session.employeeCode, p_query: q });
          candEl.innerHTML = sites.map((s) => `<button type="button" class="candidate-item" data-id="${s.id}" data-name="${s.site_name}">${s.site_name}</button>`).join('');
          candEl.querySelectorAll('.candidate-item').forEach((btn) => {
            btn.addEventListener('click', () => {
              input.value = btn.dataset.name;
              slotsEl.querySelector(`.drd-site-id[data-slot-id="${slotId}"]`).value = btn.dataset.id;
              candEl.innerHTML = '';
            });
          });
        } catch (e) { /* 無視 */ }
      }, 250);
    });
  });

  slotsEl.querySelectorAll('.drd-save').forEach((btn) => {
    btn.addEventListener('click', () => doSaveDailyReportReflectOverride(btn.dataset.slotId));
  });
  slotsEl.querySelectorAll('.drd-clear').forEach((btn) => {
    btn.addEventListener('click', () => doClearDailyReportReflectOverride(btn.dataset.slotId));
  });
}

async function doSaveDailyReportReflectOverride(slotId) {
  const session = getSession();
  const slotsEl = document.getElementById('drd-slots');
  const resultEl = slotsEl.querySelector(`.drd-result[data-slot-id="${slotId}"]`);
  const siteIdInput = slotsEl.querySelector(`.drd-site-id[data-slot-id="${slotId}"]`);
  const siteSearchInput = slotsEl.querySelector(`.drd-site-search[data-slot-id="${slotId}"]`);
  const workTypeBtn = slotsEl.querySelector(`.drd-worktype[data-slot-id="${slotId}"] .filter-chip.active`);
  const leader = slotsEl.querySelector(`.drd-leader[data-slot-id="${slotId}"]`).checked;
  const night = slotsEl.querySelector(`.drd-night[data-slot-id="${slotId}"]`).checked;
  const reason = slotsEl.querySelector(`.drd-reason[data-slot-id="${slotId}"]`).value.trim();
  if (!workTypeBtn) { resultEl.textContent = '勤務区分を選択してください。'; return; }
  const siteId = siteIdInput.value ? Number(siteIdInput.value) : null;
  const newSiteName = siteId ? null : siteSearchInput.value.trim();
  if (!siteId && !newSiteName) { resultEl.textContent = '現場を選択または入力してください。'; return; }
  resultEl.textContent = '保存中...';
  try {
    await rpc('admin_set_daily_report_reflect_override', {
      p_admin_employee_code: session.employeeCode, p_daily_report_id: Number(slotId),
      p_site_id: siteId, p_new_site_name: newSiteName, p_work_type: workTypeBtn.dataset.workType,
      p_is_leader: leader, p_is_night_shift: night, p_reason: reason || null,
    });
    resultEl.textContent = '保存しました(次回のスプレッドシート反映処理で更新されます)。';
    await loadDailyReportManagementList();
  } catch (e) {
    resultEl.textContent = e.message || '保存に失敗しました。';
  }
}

async function doClearDailyReportReflectOverride(slotId) {
  const session = getSession();
  const slotsEl = document.getElementById('drd-slots');
  const resultEl = slotsEl.querySelector(`.drd-result[data-slot-id="${slotId}"]`);
  resultEl.textContent = '処理中...';
  try {
    await rpc('admin_clear_daily_report_reflect_override', { p_admin_employee_code: session.employeeCode, p_daily_report_id: Number(slotId), p_reason: null });
    resultEl.textContent = '原本に戻しました(次回のスプレッドシート反映処理で更新されます)。';
    await loadDailyReportManagementList();
    const g = drmRows.find((r) => String(r.id) === String(slotId));
    if (g) openDailyReportDetail(drmGroupKey(g));
  } catch (e) {
    resultEl.textContent = e.message || '処理に失敗しました。';
  }
}

function toggleDrmSelect(key, checked) {
  if (checked) drmSelected.add(key); else drmSelected.delete(key);
  document.querySelectorAll(`.drm-row-check[data-key="${key}"]`).forEach((cb) => { cb.checked = checked; });
  updateDrmBulkBar();
}

function updateDrmBulkBar() {
  const bar = document.getElementById('drm-bulk-bar');
  bar.style.display = drmSelected.size > 0 ? 'block' : 'none';
  document.getElementById('drm-selected-count').textContent = `${drmSelected.size}件を選択中`;
  document.getElementById('drm-bulk-reason-box').style.display = 'none';
}

function drmSelectedRowIds() {
  const ids = [];
  drmSelected.forEach((key) => {
    drmRows.filter((r) => drmGroupKey(r) === key).forEach((r) => ids.push(Number(r.id)));
  });
  return ids;
}

async function doDrmBulkConfirm(action, reason) {
  const session = getSession();
  const ids = drmSelectedRowIds();
  if (ids.length === 0) return;
  try {
    await rpc('admin_confirm_daily_reports', { p_admin_employee_code: session.employeeCode, p_daily_report_ids: ids, p_action: action, p_reason: reason || null });
    drmSelected.clear();
    await loadDailyReportManagementList();
  } catch (e) {
    window.alert(e.message || '処理に失敗しました。');
  }
}

// ---------- 外注会社・外注作業員マスター管理(管理者/日報担当) ----------

async function loadSubcontractorCompanyAdmin() {
  const session = getSession();
  const listEl = document.getElementById('sc-company-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('sc-company-edit-id').value = '';
  document.getElementById('sc-company-name').value = '';
  document.getElementById('sc-company-notes').value = '';
  hideError('sc-company-error');
  try {
    const rows = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: true });
    listEl.innerHTML = rows.map((c) => `
      <div class="supply-item" data-id="${c.id}" style="${c.status === 'active' ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${c.company_name}</span><span>${c.worker_count}名</span></div>
        <div class="row2">${c.notes || ''}</div>
        <div class="qual-verify-btns">
          <button type="button" class="secondary view-sc-workers-btn" data-name="${c.company_name}">所属作業員を見る(${c.worker_count}名)</button>
          <button type="button" class="edit-sc-company-btn" data-name="${c.company_name}" data-notes="${c.notes || ''}">編集</button>
          <button type="button" class="reject-btn toggle-sc-company-btn" data-active="${c.status === 'active'}">${c.status === 'active' ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-sc-company-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('sc-company-edit-id').value = item.dataset.id;
        document.getElementById('sc-company-name').value = btn.dataset.name;
        document.getElementById('sc-company-notes').value = btn.dataset.notes;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-sc-company-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_subcontractor_company_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadSubcontractorCompanyAdmin();
      });
    });
    listEl.querySelectorAll('.view-sc-workers-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        subcontractorWorkerCompanyFilter = { id: Number(item.dataset.id), name: btn.dataset.name };
        subcontractorWorkerFilterJustSet = true;
        showScreen('subcontractor-worker-admin');
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveSubcontractorCompany() {
  const session = getSession();
  const id = document.getElementById('sc-company-edit-id').value;
  const name = document.getElementById('sc-company-name').value.trim();
  const notes = document.getElementById('sc-company-notes').value.trim();
  hideError('sc-company-error');
  if (!name) { showError('sc-company-error', '会社名を入力してください。'); return; }
  const btn = document.getElementById('sc-company-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_subcontractor_company', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_company_name: name, p_notes: notes || null });
    await loadSubcontractorCompanyAdmin();
  } catch (e) {
    showError('sc-company-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

let subcontractorWorkerCompanyFilter = null; // {id, name} | null。外注会社一覧の「所属作業員を見る」から絞り込む。
let subcontractorWorkerFilterJustSet = false; // 直前にドリルダウンから来た場合だけtrue(メニューから直接来た場合はフィルタを解除する)。
function resetSubcontractorWorkerForm() {
  document.getElementById('sc-worker-edit-id').value = '';
  document.getElementById('sc-worker-name').value = '';
  document.getElementById('sc-worker-furigana').value = '';
  document.getElementById('sc-worker-birth-date').value = '';
  document.getElementById('sc-worker-blood-type').value = '';
  document.getElementById('sc-worker-phone').value = '';
  document.getElementById('sc-worker-address').value = '';
  document.getElementById('sc-worker-emergency-name').value = '';
  document.getElementById('sc-worker-emergency-relation').value = '';
  document.getElementById('sc-worker-emergency-phone').value = '';
  document.getElementById('sc-worker-qualifications').value = '';
  document.getElementById('sc-worker-qualification-expiry').value = '';
  document.getElementById('sc-worker-safety-doc').value = '';
  document.getElementById('sc-worker-health-checkup-date').value = '';
  document.getElementById('sc-worker-next-health-checkup').value = '';
  document.getElementById('sc-worker-notes').value = '';
  hideError('sc-worker-error');
}

async function loadSubcontractorWorkerAdmin() {
  const session = getSession();
  const listEl = document.getElementById('sc-worker-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetSubcontractorWorkerForm();
  const titleEl = document.getElementById('sc-worker-list-title');
  const clearBtn = document.getElementById('sc-worker-clear-filter-btn');
  if (subcontractorWorkerCompanyFilter) {
    titleEl.textContent = `${subcontractorWorkerCompanyFilter.name}の作業員`;
    clearBtn.style.display = 'block';
  } else {
    titleEl.textContent = '登録済みの外注作業員';
    clearBtn.style.display = 'none';
  }
  try {
    const companies = await rpc('admin_list_subcontractor_companies', { p_admin_employee_code: session.employeeCode, p_include_inactive: false });
    document.getElementById('sc-worker-company-select').innerHTML = companies.map((c) => `<option value="${c.id}">${c.company_name}</option>`).join('');
    if (subcontractorWorkerCompanyFilter) document.getElementById('sc-worker-company-select').value = subcontractorWorkerCompanyFilter.id;
    const rows = await rpc('admin_list_subcontractor_workers', {
      p_admin_employee_code: session.employeeCode,
      p_company_id: subcontractorWorkerCompanyFilter ? subcontractorWorkerCompanyFilter.id : null,
      p_include_inactive: true,
    });
    if (rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する作業員はいません。</div>'; return; }
    listEl.innerHTML = rows.map((w) => `
      <div class="supply-item" data-id="${w.id}" style="${w.status === 'active' ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${w.worker_name}${w.furigana ? `(${w.furigana})` : ''}</span><span>${w.company_name}</span></div>
        <div class="row2">${[w.phone, w.address].filter(Boolean).join('・')}</div>
        ${w.emergency_contact_name ? `<div class="row2">緊急連絡先: ${w.emergency_contact_name}${w.emergency_contact_relation ? `(${w.emergency_contact_relation})` : ''}${w.emergency_contact_phone ? `・${w.emergency_contact_phone}` : ''}</div>` : ''}
        ${w.qualifications ? `<div class="row2">資格: ${w.qualifications}${w.qualification_expiry_date ? `(期限: ${w.qualification_expiry_date})` : ''}</div>` : ''}
        ${w.safety_document_status ? `<div class="row2">安全書類: ${w.safety_document_status}</div>` : ''}
        ${w.health_checkup_date || w.next_health_checkup_date ? `<div class="row2">健康診断: ${w.health_checkup_date ? `受診日${w.health_checkup_date}` : ''}${w.next_health_checkup_date ? `・次回目安${w.next_health_checkup_date}` : ''}</div>` : ''}
        ${w.blood_type ? `<div class="row2">血液型: ${w.blood_type}${w.blood_type === '不明' ? '' : '型'}</div>` : ''}
        ${w.notes ? `<div class="row2">${w.notes}</div>` : ''}
        <div class="qual-verify-btns">
          <button type="button" class="edit-sc-worker-btn" data-id="${w.id}">編集</button>
          <button type="button" class="reject-btn toggle-sc-worker-btn" data-active="${w.status === 'active'}">${w.status === 'active' ? '停止する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-sc-worker-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = rows.find((r) => String(r.id) === btn.dataset.id);
        document.getElementById('sc-worker-edit-id').value = w.id;
        document.getElementById('sc-worker-name').value = w.worker_name;
        document.getElementById('sc-worker-furigana').value = w.furigana || '';
        document.getElementById('sc-worker-birth-date').value = w.birth_date || '';
        document.getElementById('sc-worker-blood-type').value = w.blood_type || '';
        document.getElementById('sc-worker-phone').value = w.phone || '';
        document.getElementById('sc-worker-address').value = w.address || '';
        document.getElementById('sc-worker-emergency-name').value = w.emergency_contact_name || '';
        document.getElementById('sc-worker-emergency-relation').value = w.emergency_contact_relation || '';
        document.getElementById('sc-worker-emergency-phone').value = w.emergency_contact_phone || '';
        document.getElementById('sc-worker-qualifications').value = w.qualifications || '';
        document.getElementById('sc-worker-qualification-expiry').value = w.qualification_expiry_date || '';
        document.getElementById('sc-worker-safety-doc').value = w.safety_document_status || '';
        document.getElementById('sc-worker-health-checkup-date').value = w.health_checkup_date || '';
        document.getElementById('sc-worker-next-health-checkup').value = w.next_health_checkup_date || '';
        document.getElementById('sc-worker-notes').value = w.notes || '';
        document.getElementById('sc-worker-company-select').value = w.subcontractor_company_id;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-sc-worker-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_subcontractor_worker_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_active: btn.dataset.active !== 'true' });
        loadSubcontractorWorkerAdmin();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSaveSubcontractorWorker() {
  const session = getSession();
  const id = document.getElementById('sc-worker-edit-id').value;
  const companyId = document.getElementById('sc-worker-company-select').value;
  const name = document.getElementById('sc-worker-name').value.trim();
  const notes = document.getElementById('sc-worker-notes').value.trim();
  hideError('sc-worker-error');
  if (!name) { showError('sc-worker-error', '作業員名を入力してください。'); return; }
  if (!companyId) { showError('sc-worker-error', '外注会社を選択してください。'); return; }
  const btn = document.getElementById('sc-worker-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_subcontractor_worker', {
      p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_subcontractor_company_id: Number(companyId), p_worker_name: name, p_notes: notes || null,
      p_birth_date: document.getElementById('sc-worker-birth-date').value || null,
      p_phone: document.getElementById('sc-worker-phone').value.trim() || null,
      p_address: document.getElementById('sc-worker-address').value.trim() || null,
      p_qualifications: document.getElementById('sc-worker-qualifications').value.trim() || null,
      p_safety_document_status: document.getElementById('sc-worker-safety-doc').value.trim() || null,
      p_furigana: document.getElementById('sc-worker-furigana').value.trim() || null,
      p_emergency_contact_name: document.getElementById('sc-worker-emergency-name').value.trim() || null,
      p_emergency_contact_relation: document.getElementById('sc-worker-emergency-relation').value.trim() || null,
      p_emergency_contact_phone: document.getElementById('sc-worker-emergency-phone').value.trim() || null,
      p_blood_type: document.getElementById('sc-worker-blood-type').value || null,
      p_qualification_expiry_date: document.getElementById('sc-worker-qualification-expiry').value || null,
      p_health_checkup_date: document.getElementById('sc-worker-health-checkup-date').value || null,
      p_next_health_checkup_date: document.getElementById('sc-worker-next-health-checkup').value || null,
    });
    await loadSubcontractorWorkerAdmin();
  } catch (e) {
    showError('sc-worker-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 使用目的マスター管理(管理者) ----------

function resetPurposeForm() {
  document.getElementById('purpose-edit-id').value = '';
  document.getElementById('purpose-name').value = '';
  hideError('purpose-error');
}

async function loadPurposeAdminList() {
  const session = getSession();
  const listEl = document.getElementById('purpose-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  resetPurposeForm();
  try {
    const rows = await rpc('admin_list_expense_purposes', { p_admin_employee_code: session.employeeCode });
    listEl.innerHTML = rows.map((p) => `
      <div class="supply-item" data-id="${p.id}" style="${p.is_active ? '' : 'opacity:.5;'}">
        <div class="row1"><span>${p.name}</span><span>${p.is_active ? '有効' : '無効'}</span></div>
        <div class="qual-verify-btns">
          <button type="button" class="edit-purpose-btn" data-name="${p.name}">編集</button>
          <button type="button" class="reject-btn toggle-purpose-btn" data-active="${p.is_active}">${p.is_active ? '無効化する' : '再開する'}</button>
        </div>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-purpose-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.supply-item');
        document.getElementById('purpose-edit-id').value = item.dataset.id;
        document.getElementById('purpose-name').value = btn.dataset.name;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    listEl.querySelectorAll('.toggle-purpose-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.supply-item');
        await rpc('admin_set_expense_purpose_active', { p_admin_employee_code: session.employeeCode, p_id: Number(item.dataset.id), p_is_active: btn.dataset.active !== 'true' });
        loadPurposeAdminList();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doSavePurpose() {
  const session = getSession();
  const id = document.getElementById('purpose-edit-id').value;
  const name = document.getElementById('purpose-name').value.trim();
  hideError('purpose-error');
  if (!name) { showError('purpose-error', '使用目的名を入力してください。'); return; }
  const btn = document.getElementById('purpose-submit');
  btn.disabled = true;
  try {
    await rpc('admin_upsert_expense_purpose', { p_admin_employee_code: session.employeeCode, p_id: id ? Number(id) : null, p_name: name });
    await loadPurposeAdminList();
  } catch (e) {
    showError('purpose-error', e.message || '保存に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 常用伝票 ----------

let jdFilters = { partner: '', dateFrom: '', dateTo: '' };
let jdWorkerSeq = 0;
const JD_STATUS_LABEL = { draft: '下書き', pending_confirm: '確認待ち', confirmed: '確認済み', completed: '完了' };

async function loadJoyoDenpyoList() {
  const session = getSession();
  const listEl = document.getElementById('jd-list');
  const countEl = document.getElementById('jd-count');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('search_my_joyo_denpyo', {
      p_employee_code: session.employeeCode, p_date_from: jdFilters.dateFrom || null, p_date_to: jdFilters.dateTo || null,
      p_site_id: null, p_partner_name: jdFilters.partner || null,
    });
    countEl.textContent = `${rows.length}件`;
    if (rows.length === 0) { listEl.innerHTML = '<div class="hint">該当する常用伝票はありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="history-item" data-id="${r.id}">
        <div class="row1"><span>${r.site_name}${r.partner_name ? '・' + r.partner_name : ''}</span><span>${r.report_date}</span></div>
        <div class="row2">作業員${r.worker_count}名</div>
        <span class="status-badge ${r.status === 'completed' ? 'done' : ''}">${JD_STATUS_LABEL[r.status] || r.status}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openJoyoDenpyoDetail(el.dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function jdWorkerRowHtml(prefill) {
  const id = `jdw-${++jdWorkerSeq}`;
  const type = (prefill && prefill.worker_type) || 'employee';
  return `
    <div class="card jd-worker-row" data-row-id="${id}" data-worker-type="${type}" data-employee-id="${(prefill && prefill.employee_id) || ''}" data-subcontractor-worker-id="${(prefill && prefill.subcontractor_worker_id) || ''}">
      <div class="row1"><span>${type === 'subcontractor' ? '外注' : '社員'}</span>
        <button type="button" class="remove-item-btn jd-worker-remove">削除</button>
      </div>
      <input type="text" class="jd-worker-name" placeholder="作業員名" value="${(prefill && prefill.worker_name) || ''}">
      <input type="number" class="jd-worker-headcount" placeholder="人工(任意)" step="0.5" min="0" value="${prefill && prefill.headcount != null ? prefill.headcount : ''}">
    </div>
  `;
}

function addJoyoDenpyoWorkerRow(prefill) {
  const wrap = document.getElementById('jd-workers-list');
  wrap.insertAdjacentHTML('beforeend', jdWorkerRowHtml(prefill));
  wireJdWorkerRow(wrap.lastElementChild);
  updateJdWorkersSummary();
}

function wireJdWorkerRow(el) {
  el.querySelector('.jd-worker-remove').addEventListener('click', () => { el.remove(); updateJdWorkersSummary(); });
}

// 常用伝票は「何名で作業したか」をお客様へ証明する書類のため、人工(payroll用の
// 端数を含む作業量)とは別に、実際の人数(合計人数)を常に分かるようにしておく。
function updateJdWorkersSummary() {
  const rows = Array.from(document.querySelectorAll('#jd-workers-list .jd-worker-row'));
  const named = rows.filter((el) => el.querySelector('.jd-worker-name').value.trim());
  const totalHeadcount = named.reduce((sum, el) => sum + (Number(el.querySelector('.jd-worker-headcount').value) || 0), 0);
  document.getElementById('jd-workers-summary-count').textContent = `${named.length}名`;
  document.getElementById('jd-workers-summary-headcount').textContent = totalHeadcount.toFixed(1).replace(/\.0$/, '');
}

async function doPrefillJoyoDenpyoWorkers() {
  const session = getSession();
  const date = document.getElementById('jd-date').value;
  const siteId = document.getElementById('jd-site-select').value;
  if (!date || !siteId || siteId === '__new__') { showError('jd-form-error', '先に日付と現場を選択してください。'); return; }
  hideError('jd-form-error');
  try {
    const rows = await rpc('get_daily_report_workers_for_prefill', { p_employee_code: session.employeeCode, p_report_date: date, p_site_id: Number(siteId) });
    if (rows.length === 0) { window.alert('その日・その現場の日報が見つかりませんでした。'); return; }
    document.getElementById('jd-workers-list').innerHTML = '';
    rows.forEach((r) => addJoyoDenpyoWorkerRow(r));
  } catch (e) {
    showError('jd-form-error', e.message || '取り込みに失敗しました。');
  }
}

let jdPhotoUpload = null; // 常用伝票の原本写真({driveFileId, driveFileUrl})。新しい写真を選んだ時だけ入る。

async function handleJdPhotoFile(file) {
  if (!file) return;
  const statusEl = document.getElementById('jd-photo-status');
  const labelEl = document.getElementById('jd-photo-label');
  statusEl.textContent = 'アップロード中...';
  try {
    const session = getSession();
    jdPhotoUpload = await uploadReceiptPhoto(session.employeeCode, file);
    statusEl.textContent = 'アップロード完了';
    labelEl.textContent = file.name;
  } catch (e) {
    statusEl.textContent = 'アップロードに失敗しました。';
    return;
  }
  runJoyoDenpyoOcr(file, statusEl);
}

// 常用伝票の原本写真をAIで読み取り、空欄のフィールドだけを自動入力する
// (本人が既に入力済みの内容を勝手に上書きしない)。confidenceがlowの項目は
// .ocr-needs-checkで視覚的に強調し、本人へ確認・修正を促す(highの項目は強調しない)。
function markJdOcrField(el, confidence) {
  if (!el) return;
  if (confidence === 'low') el.classList.add('ocr-needs-check');
  else el.classList.remove('ocr-needs-check');
}

function fillJdOcrTextField(elId, field) {
  if (!field || field.value == null || field.value === '') return;
  const el = document.getElementById(elId);
  if (!el || el.value.trim() !== '') { markJdOcrField(el, null); return; }
  el.value = field.value;
  markJdOcrField(el, field.confidence);
}

async function runJoyoDenpyoOcr(file, statusEl) {
  statusEl.textContent = 'AIが内容を読み取っています...';
  try {
    const session = getSession();
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await fetch(`${N8N_BASE_URL}/webhook/joyo-denpyo-ocr-proxy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeCode: session.employeeCode, mimeType: file.type || 'image/jpeg', base64: b64 }),
    });
    const extracted = await res.json();
    if (!extracted || !extracted.is_denpyo) {
      statusEl.textContent = '常用伝票として読み取れませんでした。手入力で確認してください。';
      return;
    }
    if (extracted.report_date && extracted.report_date.value) {
      // jd-dateはresetJoyoDenpyoForm()が常に本日日付を初期値として入れているため、
      // fillJdOcrTextFieldの「空欄なら埋める」判定ではOCRの日付が永久に反映されない。
      // 本日の初期値のままなら未入力とみなし、OCRの読み取り結果で上書きする。
      const dateEl = document.getElementById('jd-date');
      if (dateEl.value === todayJST()) {
        dateEl.value = extracted.report_date.value;
        markJdOcrField(dateEl, extracted.report_date.confidence);
      }
    }
    fillJdOcrTextField('jd-partner-name', extracted.partner_name);
    fillJdOcrTextField('jd-work-description', extracted.work_description);
    fillJdOcrTextField('jd-vehicle-info', extracted.vehicle_info);
    fillJdOcrTextField('jd-materials-info', extracted.materials_info);

    const siteSearchEl = document.getElementById('jd-site-search');
    if (extracted.site_name && extracted.site_name.value && siteSearchEl.value.trim() === '') {
      siteSearchEl.value = extracted.site_name.value;
      await populateSiteSelect(document.getElementById('jd-site-select'), extracted.site_name.value);
      markJdOcrField(siteSearchEl, extracted.site_name.confidence);
    }

    const workersList = document.getElementById('jd-workers-list');
    if (Array.isArray(extracted.workers) && extracted.workers.length > 0 && workersList.children.length === 0) {
      extracted.workers.forEach((w) => {
        if (!w.worker_name) return;
        addJoyoDenpyoWorkerRow({ worker_type: 'employee', worker_name: w.worker_name, headcount: w.headcount });
        const row = workersList.lastElementChild;
        markJdOcrField(row.querySelector('.jd-worker-name'), w.confidence);
      });
    }

    const lowCount = [extracted.report_date, extracted.site_name, extracted.partner_name, extracted.work_description, extracted.vehicle_info, extracted.materials_info, ...(extracted.workers || [])]
      .filter((f) => f && f.confidence === 'low').length;
    statusEl.textContent = lowCount > 0
      ? `AIが内容を読み取りました。赤枠の項目は読み取り精度が低いため、内容を確認してください(${lowCount}件)。`
      : 'AIが内容を読み取りました。内容を確認してください(間違っていれば修正できます)。';
  } catch (e) {
    statusEl.textContent = 'アップロード完了(自動読み取りは利用できませんでした。手入力してください)。';
  }
}

// 常用伝票の取引先(business_partners)候補をdatalistへ読み込む(経費フローのpopulateVendorList
// と同じ「検索型選択、入力値が完全一致すればIDを解決、一致しなければ新規取引先名として送信」
// という既存パターンを再利用する)。
let jdPartnerNameToId = new Map();
async function populateJdPartnerList() {
  try {
    const rows = await rpc('search_business_partners', { p_query: null });
    jdPartnerNameToId = new Map(rows.map((v) => [v.partner_name, v.id]));
    document.getElementById('jd-partner-list').innerHTML = rows.map((v) => `<option value="${v.partner_name}">`).join('');
  } catch (e) { /* 取引先候補が引けなくても自由入力は継続できる */ }
}

function resetJoyoDenpyoForm() {
  document.getElementById('jd-edit-id').value = '';
  document.getElementById('jd-form-title').textContent = '常用伝票を作成する';
  document.getElementById('jd-date').value = todayJST();
  document.getElementById('jd-site-search').value = '';
  populateSiteSelect(document.getElementById('jd-site-select'), '');
  populateJdPartnerList();
  document.getElementById('jd-partner-name').value = '';
  document.getElementById('jd-work-description').value = '';
  document.getElementById('jd-vehicle-info').value = '';
  document.getElementById('jd-materials-info').value = '';
  document.getElementById('jd-notes').value = '';
  document.getElementById('jd-workers-list').innerHTML = '';
  updateJdWorkersSummary();
  document.getElementById('jd-photo-input').value = '';
  document.getElementById('jd-photo-label').textContent = '写真を選ぶ';
  document.getElementById('jd-photo-status').textContent = '';
  jdPhotoUpload = null;
  hideError('jd-form-error');
  document.querySelectorAll('#screen-joyo-denpyo-form .ocr-needs-check').forEach((el) => el.classList.remove('ocr-needs-check'));
}

function collectJoyoDenpyoWorkers() {
  return Array.from(document.querySelectorAll('.jd-worker-row')).map((el) => ({
    worker_type: el.dataset.workerType || 'employee',
    employee_id: el.dataset.employeeId || null,
    subcontractor_worker_id: el.dataset.subcontractorWorkerId || null,
    worker_name: el.querySelector('.jd-worker-name').value.trim(),
    headcount: el.querySelector('.jd-worker-headcount').value || null,
  })).filter((w) => w.worker_name);
}

async function doSubmitJoyoDenpyo(isDraft) {
  hideError('jd-form-error');
  const session = getSession();
  const editId = document.getElementById('jd-edit-id').value;
  const date = document.getElementById('jd-date').value;
  const siteSelect = document.getElementById('jd-site-select');
  const siteId = siteSelect.value && siteSelect.value !== '__new__' ? Number(siteSelect.value) : null;
  const newSiteName = !siteId ? document.getElementById('jd-site-search').value.trim() : null;
  if (!date) { showError('jd-form-error', '日付を入力してください。'); return; }
  if (!siteId && !newSiteName) { showError('jd-form-error', '現場を選択または入力してください。'); return; }

  const payload = {
    p_report_date: date, p_site_id: siteId, p_new_site_name: newSiteName,
    p_partner_name: document.getElementById('jd-partner-name').value.trim() || null,
    p_business_partner_id: jdPartnerNameToId.get(document.getElementById('jd-partner-name').value.trim()) || null,
    p_work_description: document.getElementById('jd-work-description').value.trim() || null,
    p_vehicle_info: document.getElementById('jd-vehicle-info').value.trim() || null,
    p_materials_info: document.getElementById('jd-materials-info').value.trim() || null,
    p_notes: document.getElementById('jd-notes').value.trim() || null,
    p_workers: collectJoyoDenpyoWorkers(), p_is_draft: !!isDraft,
    p_photo_drive_file_id: jdPhotoUpload ? jdPhotoUpload.driveFileId : null,
    p_photo_drive_file_url: jdPhotoUpload ? jdPhotoUpload.driveFileUrl : null,
  };
  try {
    if (editId) {
      await rpc('update_joyo_denpyo', { p_actor_employee_code: session.employeeCode, p_id: Number(editId), ...payload });
    } else {
      await rpc('create_joyo_denpyo', { p_actor_employee_code: session.employeeCode, ...payload });
    }
    showScreen('joyo-denpyo-list');
    await loadJoyoDenpyoList();
  } catch (e) {
    showError('jd-form-error', e.message || '保存に失敗しました。');
  }
}

async function openJoyoDenpyoDetail(id) {
  const session = getSession();
  showScreen('joyo-denpyo-detail');
  document.getElementById('jd-detail-fields').innerHTML = '<div class="hint">読み込み中...</div>';
  document.getElementById('jd-detail-workers').innerHTML = '';
  document.getElementById('jd-detail-actions').innerHTML = '';
  try {
    const rows = await rpc('get_joyo_denpyo_detail', { p_actor_employee_code: session.employeeCode, p_id: Number(id) });
    const d = rows && rows[0];
    if (!d) { document.getElementById('jd-detail-fields').innerHTML = '<div class="hint">見つかりませんでした。</div>'; return; }
    document.getElementById('jd-detail-fields').innerHTML = [
      ['日付', d.report_date], ['現場', d.site_name], ['取引先', d.partner_name || '-'],
      ['作業内容', d.work_description || '-'], ['使用車両', d.vehicle_info || '-'], ['使用資材等', d.materials_info || '-'],
      ['備考', d.notes || '-'], ['状態', JD_STATUS_LABEL[d.status] || d.status],
      ['作成者', d.created_by_name || '-'], ['作成日時', new Date(d.created_at).toLocaleString('ja-JP')],
      ['相手先確認', d.customer_confirmation || '-'],
    ].map(([label, value]) => `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`).join('')
      + (d.photo_drive_file_url ? `<div class="field-row"><span class="field-label">伝票原本の写真</span><span class="field-value"><a class="file-link" href="${d.photo_drive_file_url}" target="_blank" rel="noopener">写真を見る</a></span></div>` : '');
    const workers = d.workers || [];
    const totalHeadcount = workers.reduce((sum, w) => sum + (Number(w.headcount) || 0), 0);
    document.getElementById('jd-detail-workers').innerHTML =
      (workers.length === 0 ? '<div class="hint">作業員未登録</div>' : `
        <div class="stat-mini-row">
          <div class="stat-mini"><span class="stat-mini-label">合計人数</span><span class="stat-mini-value">${workers.length}名</span></div>
          <div class="stat-mini"><span class="stat-mini-label">合計人工</span><span class="stat-mini-value">${totalHeadcount.toFixed(1).replace(/\.0$/, '')}</span></div>
        </div>
      `)
      + workers.map((w) => `
      <div class="history-item"><div class="row1"><span>${w.worker_name}</span><span>${w.headcount != null ? w.headcount + '人工' : ''}</span></div><div class="row2">${w.worker_type === 'subcontractor' ? '外注' : '社員'}</div></div>
    `).join('');

    const actionsEl = document.getElementById('jd-detail-actions');
    let html = `<div class="form-title" style="font-size:15px;">操作</div>`;
    if (d.status === 'draft') html += `<button type="button" class="jd-edit-btn">編集する</button><button type="button" class="secondary jd-status-btn" data-status="pending_confirm">確認待ちにする</button>`;
    else if (d.status === 'pending_confirm') {
      html += `<button type="button" class="jd-edit-btn">編集する</button>
        <label>相手先確認者名(任意)</label><input type="text" id="jd-customer-confirm-name">
        <button type="button" class="jd-status-btn" data-status="confirmed">確認済みにする</button>`;
    } else if (d.status === 'confirmed') {
      html += `<button type="button" class="jd-status-btn" data-status="completed">完了にする</button>`;
    } else {
      html += `<div class="hint">完了済みです。</div>`;
    }
    html += `<button type="button" class="secondary jd-print-open-btn">PDFで表示・印刷する</button>`;
    actionsEl.innerHTML = html;

    const historyRows = await rpc('get_joyo_denpyo_photo_history', { p_actor_employee_code: session.employeeCode, p_id: Number(id) });
    const historyWrap = document.getElementById('jd-photo-history-wrap');
    const historyListEl = document.getElementById('jd-photo-history-list');
    if (historyRows && historyRows.length > 0) {
      historyWrap.style.display = '';
      document.getElementById('jd-photo-history-toggle').textContent = `写真の変更履歴を見る(${historyRows.length}件)`;
      historyListEl.innerHTML = historyRows.map((h) => `
        <div class="history-item">
          <div class="row1"><span>${h.replaced_by_name || '-'}が差し替え</span><span>${new Date(h.replaced_at).toLocaleString('ja-JP')}</span></div>
          <div class="row2">${h.old_photo_drive_file_url ? `<a class="file-link" href="${h.old_photo_drive_file_url}" target="_blank" rel="noopener">差し替え前の写真</a>` : '(差し替え前の写真なし)'}</div>
        </div>
      `).join('');
    } else {
      historyWrap.style.display = 'none';
    }
    const editBtn = actionsEl.querySelector('.jd-edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => openJoyoDenpyoForm(d));
    actionsEl.querySelector('.jd-print-open-btn').addEventListener('click', () => openJoyoDenpyoPrint([id]));
    actionsEl.querySelectorAll('.jd-status-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const status = btn.dataset.status;
        const nameInput = document.getElementById('jd-customer-confirm-name');
        try {
          await rpc('set_joyo_denpyo_status', { p_actor_employee_code: session.employeeCode, p_id: Number(id), p_status: status, p_customer_confirmation: nameInput ? nameInput.value.trim() || null : null });
          await openJoyoDenpyoDetail(id);
        } catch (e) { window.alert(e.message || '更新に失敗しました。'); }
      });
    });
  } catch (e) {
    document.getElementById('jd-detail-fields').innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function openJoyoDenpyoForm(existing) {
  resetJoyoDenpyoForm();
  if (existing) {
    document.getElementById('jd-edit-id').value = existing.id;
    document.getElementById('jd-form-title').textContent = '常用伝票を編集する';
    document.getElementById('jd-date').value = existing.report_date;
    document.getElementById('jd-site-search').value = existing.site_name;
    populateSiteSelect(document.getElementById('jd-site-select'), existing.site_name).then(() => {
      document.getElementById('jd-site-select').value = String(existing.site_id);
    });
    document.getElementById('jd-partner-name').value = existing.partner_name || '';
    document.getElementById('jd-work-description').value = existing.work_description || '';
    document.getElementById('jd-vehicle-info').value = existing.vehicle_info || '';
    document.getElementById('jd-materials-info').value = existing.materials_info || '';
    document.getElementById('jd-notes').value = existing.notes || '';
    (existing.workers || []).forEach((w) => addJoyoDenpyoWorkerRow(w));
    // 既存の写真を新しく選び直さない限り、送信時にp_photo_drive_file_*はnullのままとなり、
    // サーバー側(update_joyo_denpyo)のCOALESCEで既存の写真がそのまま維持される。
    if (existing.photo_drive_file_url) {
      document.getElementById('jd-photo-label').textContent = '登録済みの写真があります(変更する場合のみ選び直してください)';
    }
  }
  showScreen('joyo-denpyo-form');
}

let jdaStatusFilter = '';
let jdaRows = [];
let jdaSelected = new Set();
// ---------- 常用台帳集計(Phase C-6): 月次マトリクス(社員別/外注会社別/現場別)+任意期間の総人工 ----------
// admin_get_attendance_matrix(出面集計)と同じJSONB matrix構造・UI構成をそのまま踏襲する
// (SKILL-003: 既存パターンの再利用。データソースはjoyo_denpyoでdaily_reportsとは別)。
let jdsView = 'employee';
let jdsSiteFilter = '';
let jdsCompanyFilter = '';
let jdsPartnerFilter = '';
let jdsMatrixRequestSeq = 0;

function currentJdsMonth() {
  const v = document.getElementById('jds-month').value;
  if (!v) return null;
  const [year, month] = v.split('-').map(Number);
  return { year, month };
}
function updateJdsMonthDisplay() {
  const v = document.getElementById('jds-month').value;
  if (!v) return;
  const [y, m] = v.split('-').map(Number);
  document.getElementById('jds-month-display').textContent = `${y}年${m}月`;
}
function shiftJdsMonth(delta) {
  const input = document.getElementById('jds-month');
  const [y, m] = (input.value || todayJST().slice(0, 7)).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  input.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  input.dispatchEvent(new Event('change'));
}

async function loadJdsFilterOptions() {
  const session = getSession();
  const ym = currentJdsMonth();
  if (!ym) return;
  try {
    const rows = await rpc('admin_list_joyo_denpyo_matrix_filter_options', { p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month });
    const opts = (rows && rows[0]) || { sites: [], subcontractor_companies: [] };
    const siteSelect = document.getElementById('jds-site-filter');
    const curSite = siteSelect.value;
    siteSelect.innerHTML = '<option value="">すべての現場</option>' + (opts.sites || []).map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
    siteSelect.value = curSite;
    const companySelect = document.getElementById('jds-company-filter');
    const curCompany = companySelect.value;
    companySelect.innerHTML = '<option value="">すべての外注会社</option>' + (opts.subcontractor_companies || []).map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    companySelect.value = curCompany;
    const partnerSelect = document.getElementById('jds-partner-filter');
    const curPartner = partnerSelect.value;
    partnerSelect.innerHTML = '<option value="">すべての取引先</option>' + (opts.business_partners || []).map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    partnerSelect.value = curPartner;
  } catch (e) { /* 無視 */ }
}

function jdsViewLabel() {
  if (jdsView === 'employee') return '社員';
  if (jdsView === 'subcontractor_company') return '外注会社';
  if (jdsView === 'business_partner') return '取引先';
  return '現場';
}

async function loadJdsTotals() {
  const session = getSession();
  const ym = currentJdsMonth();
  if (!ym) return;
  const cardEl = document.getElementById('jds-totals-card');
  cardEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const monthStart = `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
    const monthEnd = `${ym.year}-${String(ym.month).padStart(2, '0')}-${String(daysInMonth(ym.year, ym.month)).padStart(2, '0')}`;
    const rows = await rpc('admin_get_joyo_denpyo_totals', { p_admin_employee_code: session.employeeCode, p_date_from: monthStart, p_date_to: monthEnd });
    const t = (rows && rows[0]) || { total_headcount: 0, denpyo_count: 0, site_count: 0, worker_count: 0 };
    cardEl.innerHTML = `
      <div class="section-title" style="margin-top:0;">${ym.year}年${ym.month}月の総人工</div>
      <div style="display:flex; justify-content:space-between; font-weight:700; font-size:14.5px;"><span>総人工</span><span>${t.total_headcount}人工</span></div>
      <div class="hint" style="margin-top:5px;">伝票数: ${t.denpyo_count}件・現場数: ${t.site_count}件・実人数: ${t.worker_count}人</div>
    `;
  } catch (e) {
    cardEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function loadJdsMatrix() {
  const session = getSession();
  const mySeq = ++jdsMatrixRequestSeq;
  const wrapEl = document.getElementById('jds-matrix-wrap');
  const ym = currentJdsMonth();
  if (!ym) return;
  wrapEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_joyo_denpyo_matrix', {
      p_admin_employee_code: session.employeeCode, p_year: ym.year, p_month: ym.month, p_view: jdsView,
      p_site_id: jdsSiteFilter ? Number(jdsSiteFilter) : null,
      p_employee_code: null,
      p_subcontractor_company_id: jdsCompanyFilter ? Number(jdsCompanyFilter) : null,
      p_business_partner_id: jdsPartnerFilter ? Number(jdsPartnerFilter) : null,
    });
    if (mySeq !== jdsMatrixRequestSeq) return;
    const colCount = daysInMonth(ym.year, ym.month);
    document.getElementById('jds-hint').textContent = rows.length === 0 ? 'この期間の常用伝票データはありません。' : `${rows.length}件(${ym.year}年${ym.month}月)。行をタップすると、その対象で常用伝票一覧を絞り込んで確認できます。`;
    if (rows.length === 0) { wrapEl.innerHTML = ''; return; }
    let headers = '';
    for (let i = 1; i <= colCount; i++) headers += `<th>${i}</th>`;
    const bodyRows = rows.map((r) => {
      let cells = '';
      for (let i = 1; i <= colCount; i++) {
        const v = r.daily[String(i)];
        cells += v ? `<td class="am-cell-value">${v}</td>` : '<td class="am-cell-empty">-</td>';
      }
      return `<tr class="am-row-clickable" data-group-id="${r.group_id}" data-group-label="${r.group_label}">
        <td>${r.group_label}</td>${cells}<td class="am-total-col">${r.month_total}</td>
      </tr>`;
    }).join('');
    const colTotals = [];
    for (let i = 1; i <= colCount; i++) {
      colTotals.push(rows.reduce((sum, r) => sum + (Number(r.daily[String(i)]) || 0), 0));
    }
    const grandTotal = rows.reduce((sum, r) => sum + Number(r.month_total || 0), 0);
    const totalRow = `<tr><td>合計</td>${colTotals.map((t) => `<td class="am-total-col">${t || '-'}</td>`).join('')}<td class="am-total-col">${grandTotal}</td></tr>`;
    wrapEl.innerHTML = `
      <table class="attendance-matrix-table">
        <thead><tr><th>${jdsViewLabel()}</th>${headers}<th>月合計</th></tr></thead>
        <tbody>${bodyRows}${totalRow}</tbody>
      </table>
    `;
    if (jdsView === 'employee') {
      wrapEl.querySelectorAll('.am-row-clickable').forEach((el) => {
        el.addEventListener('click', () => {
          jdaEmployeeFilter = { code: el.dataset.groupId, name: el.dataset.groupLabel };
          jdaEmployeeFilterJustSet = true;
          showScreen('joyo-denpyo-admin');
        });
      });
    }
  } catch (e) {
    if (mySeq === jdsMatrixRequestSeq) wrapEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function loadJoyoDenpyoSummary() {
  loadJdsTotals();
  loadJdsFilterOptions();
  loadJdsMatrix();
}

let jdaEmployeeFilter = null; // {code, name} | null。社員詳細から「この社員の常用伝票を見る」で遷移した時だけ設定する。
let jdaEmployeeFilterJustSet = false;

async function loadJoyoDenpyoAdminList() {
  const session = getSession();
  const listEl = document.getElementById('jda-list');
  const countEl = document.getElementById('jda-count');
  const filterHint = document.getElementById('jda-employee-filter-hint');
  const clearBtn = document.getElementById('jda-clear-employee-filter-btn');
  if (jdaEmployeeFilter) {
    filterHint.style.display = '';
    filterHint.textContent = `${jdaEmployeeFilter.name}さんの常用伝票を表示中`;
    clearBtn.style.display = '';
  } else {
    filterHint.style.display = 'none';
    clearBtn.style.display = 'none';
  }
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  jdaSelected.clear();
  updateJdaBulkBar();
  try {
    const siteId = document.getElementById('jda-site-select').value || null;
    jdaRows = await rpc('admin_search_joyo_denpyo', {
      p_admin_employee_code: session.employeeCode,
      p_date_from: document.getElementById('jda-date-from').value || null,
      p_date_to: document.getElementById('jda-date-to').value || null,
      p_site_id: siteId ? Number(siteId) : null,
      p_partner_name: document.getElementById('jda-search-partner').value.trim() || null,
      p_status: jdaStatusFilter || null,
      p_employee_code: jdaEmployeeFilter ? jdaEmployeeFilter.code : null,
    });
    countEl.textContent = `${jdaRows.length}件`;
    if (jdaRows.length === 0) { listEl.innerHTML = '<div class="hint">該当する常用伝票はありません。</div>'; return; }
    listEl.innerHTML = jdaRows.map((r) => `
      <div class="history-item" data-id="${r.id}">
        <div class="row1"><span>${r.site_name}${r.partner_name ? '・' + r.partner_name : ''}</span><span>${r.report_date}</span></div>
        <div class="row2">作成者: ${r.created_by_name || '-'}・作業員${r.worker_count}名${r.has_photo ? '・写真あり' : '・写真なし'}</div>
        <span class="status-badge ${r.status === 'completed' ? 'done' : ''}">${JD_STATUS_LABEL[r.status] || r.status}</span>
        <div class="checkbox-row"><input type="checkbox" class="jda-row-check" data-id="${r.id}"><label>選択</label></div>
      </div>
    `).join('');
    listEl.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('jda-row-check') || ev.target.tagName === 'LABEL') return;
        openJoyoDenpyoDetail(el.dataset.id);
      });
    });
    listEl.querySelectorAll('.jda-row-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) jdaSelected.add(cb.dataset.id); else jdaSelected.delete(cb.dataset.id);
        updateJdaBulkBar();
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

function updateJdaBulkBar() {
  document.getElementById('jda-bulk-bar').style.display = jdaSelected.size > 0 ? 'block' : 'none';
}

// ---------- 常用伝票 PDF・印刷 ----------

function jdPrintPageHtml(d) {
  const workers = d.workers || [];
  const totalHeadcount = workers.reduce((sum, w) => sum + (Number(w.headcount) || 0), 0);
  const workerRows = workers.length === 0 ? '<tr><td colspan="3">-</td></tr>' : workers.map((w) => `
    <tr><td>${w.worker_type === 'subcontractor' ? '外注' : '社員'}</td><td>${w.worker_name}</td><td>${w.headcount != null ? w.headcount + '人工' : '-'}</td></tr>
  `).join('') + `<tr class="jd-print-total-row"><td colspan="2"><strong>合計人数: ${workers.length}名</strong></td><td><strong>合計 ${totalHeadcount.toFixed(1).replace(/\.0$/, '')}人工</strong></td></tr>`;
  return `
    <div class="jd-print-page">
      <div class="jd-print-header">
        <div>
          <div class="jd-print-company">株式会社迅翔興業</div>
          <div class="jd-print-title">常用伝票</div>
        </div>
        <div class="jd-print-meta">日付: ${d.report_date}<br>作成者: ${d.created_by_name || '-'}<br>作成日時: ${new Date(d.created_at).toLocaleString('ja-JP')}</div>
      </div>
      <table class="jd-print-table">
        <tr><th>現場</th><td>${d.site_name}</td></tr>
        <tr><th>取引先</th><td>${d.partner_name || '-'}</td></tr>
        <tr><th>作業内容</th><td>${(d.work_description || '-').replace(/\n/g, '<br>')}</td></tr>
        <tr><th>使用車両</th><td>${d.vehicle_info || '-'}</td></tr>
        <tr><th>使用資材等</th><td>${d.materials_info || '-'}</td></tr>
        <tr><th>備考</th><td>${(d.notes || '-').replace(/\n/g, '<br>')}</td></tr>
      </table>
      <table class="jd-print-workers-table">
        <thead><tr><th>区分</th><th>作業員名</th><th>人工</th></tr></thead>
        <tbody>${workerRows}</tbody>
      </table>
      <div class="jd-print-signature">
        <div class="jd-print-signature-box">
          <div class="jd-print-signature-label">相手先確認欄</div>
          <div class="jd-print-signature-value">${d.customer_confirmation || ''}</div>
        </div>
        <div class="jd-print-signature-box">
          <div class="jd-print-signature-label">確認日時</div>
          <div class="jd-print-signature-value">${d.customer_confirmed_at ? new Date(d.customer_confirmed_at).toLocaleString('ja-JP') : ''}</div>
        </div>
      </div>
    </div>
  `;
}

async function openJoyoDenpyoPrint(ids) {
  const session = getSession();
  showScreen('joyo-denpyo-print');
  const contentEl = document.getElementById('jd-print-content');
  contentEl.innerHTML = '<div class="hint no-print">読み込み中...</div>';
  try {
    const details = await Promise.all(ids.map((id) => rpc('get_joyo_denpyo_detail', { p_actor_employee_code: session.employeeCode, p_id: Number(id) })));
    const rows = details.map((r) => r && r[0]).filter(Boolean);
    if (rows.length === 0) { contentEl.innerHTML = '<div class="hint no-print">表示できる伝票がありませんでした。</div>'; return; }
    contentEl.innerHTML = rows.map(jdPrintPageHtml).join('');
  } catch (e) {
    contentEl.innerHTML = '<div class="hint no-print">読み込みに失敗しました。</div>';
  }
}

// ---------- 社内イベント ----------

async function renderHomeEventsArea(session) {
  const area = document.getElementById('home-events-area');
  try {
    const rows = await rpc('get_my_company_events', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { area.innerHTML = ''; return; }
    area.innerHTML = `
      <div class="section-title">社内イベント</div>
      <div id="home-events-list"></div>
    `;
    document.getElementById('home-events-list').innerHTML = rows.map((r) => `
      <div class="history-item" data-id="${r.id}">
        <div class="row1"><span>${r.title}</span><span>${new Date(r.start_at).toLocaleDateString('ja-JP')}</span></div>
        <div class="row2">${r.my_response ? '回答済み: ' + EVENT_RESPONSE_LABEL[r.my_response] : '回答受付中です'}</div>
      </div>
    `).join('');
    document.getElementById('home-events-list').querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openEventDetail(el.dataset.id));
    });
  } catch (e) { area.innerHTML = ''; }
}

const EVENT_RESPONSE_LABEL = { attending: '参加する', not_attending: '不参加', undecided: '未定' };

async function loadEventsList() {
  const session = getSession();
  const listEl = document.getElementById('events-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('get_my_company_events', { p_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">現在回答受付中のイベントはありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="history-item" data-id="${r.id}">
        <div class="row1"><span>${r.title}</span><span>${new Date(r.start_at).toLocaleString('ja-JP')}</span></div>
        <div class="row2">${r.location || ''}</div>
        <span class="status-badge ${r.my_response ? 'done' : ''}">${r.my_response ? EVENT_RESPONSE_LABEL[r.my_response] : '未回答'}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openEventDetail(el.dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

let currentEventDetail = null;
async function openEventDetail(id) {
  const session = getSession();
  showScreen('event-detail');
  document.getElementById('event-detail-fields').innerHTML = '<div class="hint">読み込み中...</div>';
  hideError('event-response-error');
  document.getElementById('event-response-hint').textContent = '';
  try {
    const rows = await rpc('get_my_company_events', { p_employee_code: session.employeeCode });
    const e = (rows || []).find((r) => String(r.id) === String(id));
    if (!e) { document.getElementById('event-detail-fields').innerHTML = '<div class="hint">見つかりませんでした(回答期限を過ぎている可能性があります)。</div>'; return; }
    currentEventDetail = e;
    document.getElementById('event-detail-title').textContent = e.title;
    document.getElementById('event-detail-fields').innerHTML = [
      ['日時', new Date(e.start_at).toLocaleString('ja-JP') + (e.end_at ? ' 〜 ' + new Date(e.end_at).toLocaleString('ja-JP') : '')],
      ['場所', e.location || '-'], ['内容', e.description || '-'],
      ['回答期限', e.response_deadline ? new Date(e.response_deadline).toLocaleString('ja-JP') : '-'],
    ].map(([label, value]) => `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`).join('');
    document.querySelectorAll('#event-response-chips .filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.response === e.my_response));
    document.getElementById('event-companion-count').value = e.my_companion_count || 0;
    document.getElementById('event-comment').value = e.my_comment || '';
    const deadlinePassed = e.response_deadline && new Date(e.response_deadline) < new Date();
    document.getElementById('event-response-submit').disabled = !!deadlinePassed;
    if (deadlinePassed) document.getElementById('event-response-hint').textContent = '回答期限を過ぎているため回答できません。';
  } catch (e2) {
    document.getElementById('event-detail-fields').innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doRespondToEvent() {
  const session = getSession();
  hideError('event-response-error');
  const activeChip = document.querySelector('#event-response-chips .filter-chip.active');
  if (!activeChip || !currentEventDetail) { showError('event-response-error', '参加・不参加・未定のいずれかを選択してください。'); return; }
  const btn = document.getElementById('event-response-submit');
  btn.disabled = true;
  try {
    await rpc('respond_to_company_event', {
      p_employee_code: session.employeeCode, p_event_id: currentEventDetail.id, p_response: activeChip.dataset.response,
      p_companion_count: Number(document.getElementById('event-companion-count').value) || 0,
      p_comment: document.getElementById('event-comment').value.trim() || null,
    });
    await openEventDetail(currentEventDetail.id);
    document.getElementById('event-response-hint').textContent = '回答しました。回答期限までは変更できます。';
  } catch (e) {
    showError('event-response-error', e.message || '回答に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

async function loadEventAdminList() {
  const session = getSession();
  const listEl = document.getElementById('event-admin-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_list_company_events', { p_admin_employee_code: session.employeeCode });
    if (!rows || rows.length === 0) { listEl.innerHTML = '<div class="hint">まだイベントがありません。</div>'; return; }
    listEl.innerHTML = rows.map((r) => `
      <div class="history-item" data-id="${r.id}">
        <div class="row1"><span>${r.title}</span><span>${new Date(r.start_at).toLocaleString('ja-JP')}</span></div>
        <div class="row2">参加${r.attending_count}・不参加${r.not_attending_count}・未定${r.undecided_count}・未回答${r.no_response_count}(同伴${r.total_companion_count}名)</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openEventResponsesAdmin(el.dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doCreateEvent() {
  const session = getSession();
  hideError('event-create-error');
  const title = document.getElementById('event-create-title').value.trim();
  const start = document.getElementById('event-create-start').value;
  if (!title || !start) { showError('event-create-error', 'タイトルと日時を入力してください。'); return; }
  const btn = document.getElementById('event-create-submit');
  btn.disabled = true;
  try {
    await rpc('admin_create_company_event', {
      p_admin_employee_code: session.employeeCode, p_title: title,
      p_description: document.getElementById('event-create-description').value.trim() || null,
      p_location: document.getElementById('event-create-location').value.trim() || null,
      p_start_at: new Date(start).toISOString(),
      p_end_at: document.getElementById('event-create-end').value ? new Date(document.getElementById('event-create-end').value).toISOString() : null,
      p_response_deadline: document.getElementById('event-create-deadline').value ? new Date(document.getElementById('event-create-deadline').value).toISOString() : null,
    });
    ['event-create-title', 'event-create-start', 'event-create-end', 'event-create-location', 'event-create-description', 'event-create-deadline'].forEach((id) => { document.getElementById(id).value = ''; });
    await loadEventAdminList();
  } catch (e) {
    showError('event-create-error', e.message || '作成に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

let currentEventResponsesId = null;
async function openEventResponsesAdmin(id) {
  const session = getSession();
  currentEventResponsesId = id;
  showScreen('event-responses-admin');
  const listEl = document.getElementById('event-responses-list');
  listEl.innerHTML = '<div class="hint">読み込み中...</div>';
  try {
    const rows = await rpc('admin_get_company_event_responses', { p_admin_employee_code: session.employeeCode, p_event_id: Number(id) });
    const counts = { attending: 0, not_attending: 0, undecided: 0, no_response: 0 };
    rows.forEach((r) => { counts[r.response || 'no_response'] += 1; });
    document.getElementById('event-responses-summary').textContent = `参加${counts.attending}・不参加${counts.not_attending}・未定${counts.undecided}・未回答${counts.no_response}`;
    listEl.innerHTML = rows.map((r) => `
      <div class="history-item">
        <div class="row1"><span>${r.employee_name}</span><span>${r.response ? EVENT_RESPONSE_LABEL[r.response] : '未回答'}</span></div>
        <div class="row2">${r.comment || ''}${r.companion_count ? `(同伴${r.companion_count}名)` : ''}</div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="hint">読み込みに失敗しました。</div>';
  }
}

async function doNotifyUnansweredEvent() {
  const session = getSession();
  if (!currentEventResponsesId) return;
  const btn = document.getElementById('event-notify-unanswered-btn');
  btn.disabled = true;
  try {
    const count = await rpc('admin_notify_unanswered_company_event', { p_admin_employee_code: session.employeeCode, p_event_id: Number(currentEventResponsesId) });
    window.alert(`${count}名へ通知を送信しました。`);
  } catch (e) {
    window.alert(e.message || '通知の送信に失敗しました。');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 案内AI「ポッくん」 ----------
//
// v1はルールベースの意図マッチング(外部AI APIは呼ばない)。理由:
// (1) 経費申請/日報/接待事前申請/有給申請/アプリの使い方など、聞かれる内容は
//     ある程度あらかじめ列挙できる範囲であり、案内先の画面へ直接遷移させることが
//     目的の中心のため、固定の意図テーブル+複数の言い回しパターンで十分自然に対応できる。
// (2) 外部LLM APIの従量課金は、迅翔興業の共通運用ルール(COST-001/COST-002、
//     system_rules)により人間の明示承認なしに自律導入してはならない。
// (3) このv1はDBへの問い合わせを一切行わないため、権限違反(他社員の情報や給与・人事情報の
//     漏洩)が構造的に発生しない設計になっている。
//
// 将来、会社制度への質問や仕事相談など「本当のAIアシスタント」へ育てる場合は、
// handleAiGuideMessage()の中身をLLM API呼び出しに差し替えるだけで良いように、
// UI・意図判定・画面遷移(action)の3層を分離してある。ただしその際もCOST-001の
// 人間承認、および社員ごとの閲覧権限を超えないサーバー側チェックが必須。

let aiGuideHistory = []; // { role: 'user'|'bot', text }[] (画面をリロードすると消える、永続化はしない)

// 給与・人事考課・経営情報など、この案内が答えるべきでない話題は最優先で弾く
// (社員ごとの閲覧権限を超えないようにするための境界線、DBには一切問い合わせない)。
const AI_GUIDE_BOUNDARY = {
  patterns: [/給料/, /給与/, /賞与/, /年収/, /人事考課/, /評価/, /他の社員/, /他人の/, /経営/, /決算/, /利益/],
  responses: ['給与・人事・経営に関わることは、この案内では回答できません。担当者に直接ご確認ください。'],
};

const AI_GUIDE_INTENTS = [
  {
    key: 'expense',
    patterns: [/経費/, /立替/, /領収書/, /レシート/],
    responses: [
      '経費の立替申請は「経費」→「立替・会社経費」から、領収書の写真をアップロードするだけでOKです。日付・金額はAIが自動で読み取ります。',
      '領収書は「経費」画面の「複数の領収書をまとめて選ぶ」から、まとめて選択することもできますよ。',
    ],
    action: { label: '経費申請を開く', nav: 'expense-select' },
  },
  {
    key: 'daily_report',
    patterns: [/日報/],
    responses: ['今日の日報はホーム画面の「日報」から入力できます。現場と勤務区分(終日・午前・午後)を選ぶだけで人工は自動計算されます。'],
    action: { label: '日報を開く', nav: 'daily-report' },
  },
  {
    key: 'entertainment',
    patterns: [/接待/, /会食/],
    responses: [
      '接待・会食は、実施前に「接待・会食 事前申請」から申請してください。もし事前申請が間に合わなかった場合は「特別後日申請」から、理由を書いて申請できます。',
    ],
    action: { label: '接待事前申請を開く', nav: 'my-entertainment' },
  },
  {
    key: 'leave',
    patterns: [/有給/, /休み/, /休暇/],
    responses: ['有給休暇の申請は「有給休暇」から、希望日を選んで送信するだけです。残日数もその画面で確認できます。'],
    action: { label: '有給申請を開く', nav: 'leave' },
  },
  {
    key: 'joyo_denpyo',
    patterns: [/常用伝票/, /現場伝票/],
    responses: ['現場の常用伝票は「常用伝票」から作成・確認できます。'],
    action: { label: '常用伝票を開く', nav: 'joyo-denpyo-list' },
  },
  {
    key: 'supply',
    patterns: [/支給品/, /制服/, /安全用品/],
    responses: ['制服や安全用品の支給申請は「支給品」からできます。'],
    action: { label: '支給品を開く', nav: 'supply-request' },
  },
  {
    key: 'qualification',
    patterns: [/資格/, /免許/],
    responses: ['資格・免許の登録や期限確認は「自分の情報」→「資格・免許」からできます。'],
    action: { label: '資格・免許を開く', nav: 'my-qual' },
  },
  {
    key: 'meeting',
    patterns: [/会議費/, /会議/],
    responses: ['会議費の申請は「会議」から申請できます。'],
    action: { label: '会議費申請を開く', nav: 'meeting' },
  },
];

const AI_GUIDE_QUICK_REPLIES = ['経費申請したい', '日報の入力方法', '接待の事前申請ってどうする？', '有給申請したい'];

const AI_GUIDE_FALLBACK = [
  'すみません、うまく理解できませんでした。経費申請・日報・有給・接待の事前申請などは下のボタンからも選べます。',
  'その内容はまだお答えできません。下のボタンからよく聞かれる内容を選ぶか、担当者に直接お尋ねください。',
];

function matchAiGuideIntent(text) {
  if (AI_GUIDE_BOUNDARY.patterns.some((p) => p.test(text))) return { responses: AI_GUIDE_BOUNDARY.responses, action: null };
  const hit = AI_GUIDE_INTENTS.find((intent) => intent.patterns.some((p) => p.test(text)));
  if (hit) return { responses: hit.responses, action: hit.action || null };
  return { responses: AI_GUIDE_FALLBACK, action: null };
}

function renderAiGuideMessages() {
  const el = document.getElementById('ai-guide-messages');
  el.innerHTML = aiGuideHistory.map((m, i) => {
    if (m.role === 'action') {
      return `<button type="button" class="ai-guide-msg-action" data-nav="${m.nav}">${m.label}${icon('chevron-right')}</button>`;
    }
    return `<div class="ai-guide-msg ${m.role === 'user' ? 'user' : 'bot'}${m.pending ? ' pending' : ''}">${m.text}</div>`;
  }).join('');
  hydrateIcons(el);
  el.querySelectorAll('.ai-guide-msg-action').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('ai-guide-panel').classList.remove('open');
      showScreen(btn.dataset.nav);
    });
  });
  el.scrollTop = el.scrollHeight;
}

// 既知の定型パターン(経費・日報・有給等)は従来通り即答(無料・瞬時)。パターンに
// 一致しない自由な会話だけ、pokkun-chat Edge Function(LLM)へ回す(COST-002の
// 「不要な課金を避ける」方針に沿って、課金が発生するのは未知の発話だけに絞る)。
async function handleAiGuideMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  aiGuideHistory.push({ role: 'user', text: trimmed });
  renderAiGuideMessages();

  if (AI_GUIDE_BOUNDARY.patterns.some((p) => p.test(trimmed))) {
    aiGuideHistory.push({ role: 'bot', text: pick(AI_GUIDE_BOUNDARY.responses) });
    renderAiGuideMessages();
    return;
  }
  const hit = AI_GUIDE_INTENTS.find((intent) => intent.patterns.some((p) => p.test(trimmed)));
  if (hit) {
    aiGuideHistory.push({ role: 'bot', text: pick(hit.responses) });
    if (hit.action) aiGuideHistory.push({ role: 'action', label: hit.action.label, nav: hit.action.nav });
    renderAiGuideMessages();
    return;
  }

  aiGuideHistory.push({ role: 'bot', text: '…', pending: true });
  renderAiGuideMessages();
  try {
    const session = getSession();
    const history = aiGuideHistory
      .filter((m) => (m.role === 'user' || m.role === 'bot') && !m.pending)
      .slice(-8)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
    const res = await fetch(`${SUPABASE_URL}/functions/v1/pokkun-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, 'x-device-token': currentDeviceToken || '' },
      body: JSON.stringify({ employee_code: session.employeeCode, message: trimmed, history }),
    });
    const data = await res.json().catch(() => ({}));
    const pendingIdx = aiGuideHistory.findIndex((m) => m.pending);
    if (pendingIdx !== -1) aiGuideHistory.splice(pendingIdx, 1);
    if (res.ok && data.reply) {
      aiGuideHistory.push({ role: 'bot', text: data.reply });
    } else {
      aiGuideHistory.push({ role: 'bot', text: (data && data.error) || pick(AI_GUIDE_FALLBACK) });
    }
  } catch (e) {
    const pendingIdx = aiGuideHistory.findIndex((m) => m.pending);
    if (pendingIdx !== -1) aiGuideHistory.splice(pendingIdx, 1);
    aiGuideHistory.push({ role: 'bot', text: pick(AI_GUIDE_FALLBACK) });
  }
  renderAiGuideMessages();
}

function openAiGuidePanel() {
  const panel = document.getElementById('ai-guide-panel');
  panel.classList.add('open');
  if (aiGuideHistory.length === 0) {
    aiGuideHistory.push({ role: 'bot', text: 'こんにちは、ポッくんです。申請の仕方やアプリの使い方について何でも聞いてください。' });
    renderAiGuideMessages();
  }
  document.getElementById('ai-guide-input').focus();
}

// 会話ウィンドウを閉じたら履歴は残さない(ユーザー指示、個人の会話内容を保持し続けない)。
function closeAiGuidePanel() {
  document.getElementById('ai-guide-panel').classList.remove('open');
  aiGuideHistory = [];
}

// ---------- 初期化 ----------

// 2026-09-01の運用方針変更。以前は「Stagingは開発者だけが使うテスト環境」だったが、
// 通常利用版(A)と先行更新版(B)の2本立てに変え、**どちらも全社員が実利用する**構成にした。
// 両方とも同じ本番Supabaseを見るため、業務データは完全に共通である。
// 違いは「新しい修正がどちらに先に入るか」だけなので、表示も
// 「本番ではありません」ではなく「先行更新版・データは同じ」と伝える。
// IS_STAGING は「先行更新版のビルドかどうか」を表すフラグとして引き続き使う。
function applyStagingIndicator() {
  if (!IS_STAGING) return;
  document.body.classList.add('is-staging');
  document.title = '迅翔興業 社員ポータル（先行更新版）';
  const titleEl = document.getElementById('app-header-title');
  if (titleEl) titleEl.textContent = '社員ポータル｜先行更新版';
  const versionEl = document.getElementById('staging-build-version');
  if (versionEl) versionEl.textContent = APP_BUILD_VERSION || '-';
  const timeEl = document.getElementById('staging-build-time');
  if (timeEl) timeEl.textContent = BUILD_DEPLOYED_AT ? new Date(BUILD_DEPLOYED_AT).toLocaleString('ja-JP') : '不明';
}

function init() {
  applyStagingIndicator();
  hydrateIcons(document);

  document.getElementById('login-btn').addEventListener('click', doSubmitEmployeeCode);
  document.getElementById('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmitEmployeeCode(); });

  document.getElementById('pin-entry-submit').addEventListener('click', doVerifyPin);
  document.getElementById('pin-entry-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerifyPin(); });
  document.getElementById('pin-entry-switch').addEventListener('click', switchEmployee);
  // 暗証番号をお忘れの方 (E-15)
  document.getElementById('pin-forgot-link').addEventListener('click', openPinForgot);
  document.getElementById('pin-forgot-back').addEventListener('click', () => showScreen('pin-entry'));
  document.getElementById('pin-forgot-submit').addEventListener('click', doPinForgotReset);
  document.getElementById('pin-forgot-request-submit').addEventListener('click', doPinResetRequest);
  // 弱い暗証番号のお願いから変更画面へ (E-13)
  document.getElementById('pin-weak-change-btn').addEventListener('click', () => showScreen('pin-change'));
  document.getElementById('pin-change-forgot-link').addEventListener('click', () => {
    const card = document.getElementById('pin-change-forgot-card');
    card.style.display = card.style.display === 'none' ? '' : 'none';
    attachPinRevealToggles();
  });
  document.getElementById('pin-change-reset-submit').addEventListener('click', doPinChangeReset);
  // 暗証番号欄すべてに表示/非表示を付ける (E-14)
  attachPinRevealToggles();

  document.getElementById('pin-register-identify').addEventListener('click', doIdentifyForRegister);
  document.getElementById('pin-register-submit').addEventListener('click', doRegisterPin);
  document.getElementById('pin-register-back').addEventListener('click', resetRegisterSteps);
  document.getElementById('pin-register-switch').addEventListener('click', switchEmployee);

  document.getElementById('device-pending-retry').addEventListener('click', retryDevicePending);
  document.getElementById('device-pending-switch').addEventListener('click', switchEmployee);

  document.getElementById('logout-btn').addEventListener('click', switchEmployee);
  document.getElementById('logout-btn-2').addEventListener('click', switchEmployee);

  document.getElementById('leave-submit').addEventListener('click', doSubmitLeave);
  ['leave-start', 'leave-end', 'leave-half'].forEach((id) => {
    document.getElementById(id).addEventListener('change', updateLeaveDaysDisplay);
  });

  document.getElementById('expense-add-item').addEventListener('click', () => addExpenseItem());
  document.getElementById('expense-submit').addEventListener('click', doSubmitExpense);
  document.getElementById('expense-batch-input').addEventListener('change', (e) => {
    addExpenseItemsBatch(e.target.files);
    e.target.value = '';
  });

  document.getElementById('meeting-submit').addEventListener('click', doSubmitMeeting);

  wireQtySelectCustomToggle('supply-req-qty');
  wireQtySelectCustomToggle('supply-ih-qty');
  let shaSearchTimer = null;
  const shaDebouncedReload = () => { clearTimeout(shaSearchTimer); shaSearchTimer = setTimeout(() => loadSupplyHoldingsAdmin(), 300); };
  document.getElementById('sha-search-employee').addEventListener('input', shaDebouncedReload);
  document.getElementById('sha-search-item').addEventListener('input', shaDebouncedReload);
  document.getElementById('sha-held-only').addEventListener('change', loadSupplyHoldingsAdmin);
  document.getElementById('supply-req-add-btn').addEventListener('click', doAddSupplyReqItem);
  document.getElementById('supply-req-submit').addEventListener('click', doSubmitSupplyRequestBulk);
  document.getElementById('supply-ih-add-btn').addEventListener('click', doAddSupplyIhItem);
  document.getElementById('supply-ih-submit').addEventListener('click', doSubmitSupplyInitialHoldingBulk);
  document.getElementById('supply-ih-precision').addEventListener('change', toggleSupplyIhPrecisionFields);
  document.getElementById('my-supply-initial-holding-btn').addEventListener('click', () => showScreen('supply-initial-holding'));
  document.getElementById('supply-master-requires-size').addEventListener('change', (e) => {
    document.getElementById('supply-master-size-options-wrap').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('admin-employee-select').addEventListener('change', loadAdminEmployeeDetail);
  document.getElementById('admin-issue-submit').addEventListener('click', doAdminRecordIssuance);
  document.getElementById('admin-search-btn').addEventListener('click', doAdminSearch);
  document.getElementById('admin-reset-pin-btn').addEventListener('click', doAdminResetPin);

  document.getElementById('anon-submit-btn').addEventListener('click', doSubmitAnonConsultation);
  document.getElementById('anon-thread-send').addEventListener('click', doSendAnonThreadMessage);
  document.getElementById('anon-admin-status-filter').addEventListener('change', loadAnonAdminList);
  document.getElementById('anon-admin-status-select').addEventListener('change', doAdminChangeAnonStatus);
  document.getElementById('anon-admin-reply-btn').addEventListener('click', doAdminReplyAnon);

  document.getElementById('announce-submit').addEventListener('click', doCreateAnnouncement);
  document.querySelectorAll('input[name="announce-target"]').forEach((el) => {
    el.addEventListener('change', () => {
      const showPicker = document.getElementById('announce-target-select').checked;
      document.getElementById('announce-employee-picker').style.display = showPicker ? 'block' : 'none';
    });
  });
  document.querySelectorAll('input[name="announce-display-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      const showDate = document.getElementById('announce-display-until').checked;
      document.getElementById('announce-display-until-box').style.display = showDate ? 'block' : 'none';
    });
  });
  document.getElementById('announce-employee-search').addEventListener('input', (e) => renderAnnounceEmployeeChecklist(e.target.value));
  document.getElementById('announce-attachment-input').addEventListener('change', (e) => handleAnnounceAttachment(e.target.files[0]));

  document.getElementById('qual-submit').addEventListener('click', doSubmitQualification);
  document.getElementById('qual-photo-input').addEventListener('change', (e) => handleQualFile(e.target.files[0], 'photo'));
  document.getElementById('qual-pdf-input').addEventListener('change', (e) => handleQualFile(e.target.files[0], 'pdf'));
  document.getElementById('qual-admin-filter').addEventListener('change', loadQualAdminList);
  let qualSearchTimer = null;
  document.getElementById('qual-admin-search').addEventListener('input', () => {
    clearTimeout(qualSearchTimer);
    qualSearchTimer = setTimeout(() => loadQualAdminList(), 300);
  });
  document.getElementById('qual-category-qualification').addEventListener('click', () => setQualCategory('qualification'));
  document.getElementById('qual-category-license').addEventListener('click', () => setQualCategory('license'));
  document.querySelectorAll('#screen-qual-admin .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-qual-admin .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      qualAdminCategoryFilter = btn.dataset.cat;
      loadQualAdminList();
    });
  });

  document.getElementById('health-submit').addEventListener('click', doSubmitHealthCheckup);
  document.getElementById('health-file-input').addEventListener('change', (e) => handleHealthFile(e.target.files[0]));
  document.getElementById('health-admin-submit').addEventListener('click', doSaveAdminHealthRecord);
  document.getElementById('employee-detail-record-health-btn').addEventListener('click', () => {
    ['health-admin-date', 'health-admin-type', 'health-admin-institution', 'health-admin-next', 'health-admin-note'].forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('health-admin-confirmed').checked = false;
    document.getElementById('health-admin-retest').checked = false;
    hideError('health-admin-error');
    showScreen('health-admin-record');
  });
  document.querySelectorAll('#screen-health-admin .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-health-admin .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      healthAdminFilter = btn.dataset.healthFilter;
      loadHealthAdminList();
    });
  });

  document.getElementById('ent-submit').addEventListener('click', doSubmitEntertainmentPreapproval);
  document.getElementById('ent-update-submit').addEventListener('click', doUpdateEntertainmentActuals);
  document.getElementById('entertainment-admin-filter').addEventListener('change', loadEntertainmentAdminList);
  document.getElementById('ent-late-submit').addEventListener('click', doSubmitEntertainmentLatePreapproval);
  document.getElementById('ent-late-ack').addEventListener('change', (e) => {
    document.getElementById('ent-late-submit').disabled = !e.target.checked;
  });

  document.getElementById('status-outing-submit').addEventListener('click', doSubmitStatusOuting);
  document.getElementById('status-late-submit').addEventListener('click', doSubmitStatusLate);
  document.getElementById('status-early-submit').addEventListener('click', doSubmitStatusEarly);

  document.getElementById('action-item-submit').addEventListener('click', doCreateActionItem);
  document.getElementById('propose-site-submit').addEventListener('click', () => doProposeSite(false));
  document.getElementById('propose-site-force-create-btn').addEventListener('click', () => doProposeSite(true));

  document.getElementById('license-type-submit').addEventListener('click', doSaveLicenseType);
  document.getElementById('purpose-submit').addEventListener('click', doSavePurpose);

  document.getElementById('arm-add-search').addEventListener('input', (e) => renderAdminRoleCandidates(e.target.value));

  let drmSiteSearchTimer = null;
  document.getElementById('drm-search-site').addEventListener('input', (e) => {
    clearTimeout(drmSiteSearchTimer);
    const q = e.target.value.trim();
    drmSiteSearchTimer = setTimeout(async () => {
      const session = getSession();
      const candEl = document.getElementById('drm-site-candidates');
      if (!q) { candEl.innerHTML = ''; return; }
      try {
        const rows = await rpc('admin_search_sites_simple', { p_admin_employee_code: session.employeeCode, p_query: q });
        candEl.innerHTML = rows.map((s) => `<button type="button" class="candidate-item" data-id="${s.id}" data-name="${s.site_name}">${s.site_name}</button>`).join('');
        candEl.querySelectorAll('.candidate-item').forEach((btn) => {
          btn.addEventListener('click', () => {
            drmFilters.site = Number(btn.dataset.id);
            document.getElementById('drm-selected-site-label').style.display = 'block';
            document.getElementById('drm-selected-site-label').textContent = `絞り込み中: ${btn.dataset.name}(解除するには検索欄を空にして再検索)`;
            candEl.innerHTML = '';
            document.getElementById('drm-search-site').value = '';
            loadDailyReportManagementList();
          });
        });
      } catch (e2) { /* 無視 */ }
    }, 250);
  });
  let drmNameSearchTimer = null;
  document.getElementById('drm-search-name').addEventListener('input', (e) => {
    clearTimeout(drmNameSearchTimer);
    drmNameSearchTimer = setTimeout(() => { drmFilters.name = e.target.value.trim(); loadDailyReportManagementList(); }, 300);
  });
  document.getElementById('drm-company-select').addEventListener('change', (e) => {
    drmFilters.companyId = e.target.value;
    loadDailyReportManagementList();
  });
  ['drm-date-from', 'drm-date-to'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      drmFilters.dateFrom = document.getElementById('drm-date-from').value;
      drmFilters.dateTo = document.getElementById('drm-date-to').value;
      loadDailyReportManagementList();
    });
  });
  document.getElementById('drm-toggle-advanced').addEventListener('click', () => {
    const el = document.getElementById('drm-advanced');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('drm-missing-toggle').addEventListener('click', () => {
    const el = document.getElementById('drm-missing-today-list');
    const show = el.style.display === 'none';
    el.style.display = show ? 'block' : 'none';
    document.getElementById('drm-missing-toggle').textContent = show ? '未提出者を隠す' : '未提出者を表示する';
  });
  document.getElementById('drm-notify-btn').addEventListener('click', async () => {
    const session = getSession();
    const btn = document.getElementById('drm-notify-btn');
    btn.disabled = true;
    try {
      const count = await rpc('admin_notify_missing_daily_reports', { p_admin_employee_code: session.employeeCode, p_date: todayJST() });
      window.alert(`${count}名へ通知を送信しました。`);
    } catch (e) {
      window.alert(e.message || '通知の送信に失敗しました。');
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('drm-autoconfirm-btn').addEventListener('click', async () => {
    const session = getSession();
    const btn = document.getElementById('drm-autoconfirm-btn');
    const resultEl = document.getElementById('drm-autoconfirm-result');
    btn.disabled = true;
    resultEl.textContent = '実行中...';
    try {
      const count = await rpc('admin_run_auto_confirm_sweep', { p_admin_employee_code: session.employeeCode, p_date: todayJST() });
      resultEl.textContent = `${count}件を自動確認しました。`;
      loadDrmSummary();
      loadDailyReportManagementList();
    } catch (e) {
      resultEl.textContent = e.message || '自動確認の実行に失敗しました。';
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll('#screen-daily-report-management .areq-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      drmSort = { col, dir: drmSort.col === col && drmSort.dir === 'asc' ? 'desc' : 'asc' };
      renderDrmAll();
    });
  });
  document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#drm-worker-type-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      drmFilters.workerType = btn.dataset.workerType;
      loadDailyReportManagementList();
    });
  });
  document.querySelectorAll('#drm-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#drm-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      drmFilters.status = btn.dataset.status;
      loadDailyReportManagementList();
    });
  });
  document.getElementById('drm-select-all').addEventListener('change', (e) => {
    const groups = new Set(drmRows.map((r) => drmGroupKey(r)));
    if (e.target.checked) { groups.forEach((k) => drmSelected.add(k)); } else { drmSelected.clear(); }
    renderDrmAll();
  });
  document.getElementById('drm-bulk-confirm').addEventListener('click', () => doDrmBulkConfirm('confirmed', null));
  document.getElementById('drm-bulk-reject').addEventListener('click', () => { revealReasonBox(document.getElementById('drm-bulk-reason-box')); });
  document.getElementById('drm-bulk-reason-confirm').addEventListener('click', () => {
    const reason = document.getElementById('drm-bulk-reason').value.trim();
    if (!reason) return;
    doDrmBulkConfirm('rejected', reason);
  });

  document.getElementById('sc-company-submit').addEventListener('click', doSaveSubcontractorCompany);
  document.getElementById('sc-worker-submit').addEventListener('click', doSaveSubcontractorWorker);

  document.querySelectorAll('.dr-summary-tab').forEach((btn) => {
    btn.addEventListener('click', () => { dailyReportSummaryPeriodType = btn.dataset.period; loadMyDailyReports(); });
  });
  document.querySelectorAll('.dr-view-tab').forEach((btn) => {
    btn.addEventListener('click', () => setDailyReportView(btn.dataset.view));
  });
  document.getElementById('ed-supply-correction-submit').addEventListener('click', doRecordSupplyCorrection);
  document.getElementById('ed-supply-view-joyo-denpyo-btn').addEventListener('click', () => {
    jdaEmployeeFilter = { code: currentEmployeeDetailCode, name: document.getElementById('employee-detail-name').textContent };
    jdaEmployeeFilterJustSet = true;
    showScreen('joyo-denpyo-admin');
  });
  document.getElementById('dr-period-prev').addEventListener('click', () => navigateDailyReportPeriod(-1));
  document.getElementById('dr-period-next').addEventListener('click', () => navigateDailyReportPeriod(1));
  document.getElementById('dr-period-reset').addEventListener('click', resetDailyReportPeriodToCurrent);
  document.getElementById('dr-cal-prev').addEventListener('click', () => shiftDailyReportCalMonth(-1));
  document.getElementById('dr-cal-next').addEventListener('click', () => shiftDailyReportCalMonth(1));
  document.getElementById('myinfo-push-toggle').addEventListener('change', (e) => togglePushNotifications(e.target.checked));
  document.getElementById('my-daily-report-detail-edit-btn').addEventListener('click', () => {
    if (!myDailyReportDetailDate) return;
    dailyReportTarget = { type: 'self', employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
    dailyReportPrefillDate = myDailyReportDetailDate;
    showScreen('daily-report');
  });

  let areqSearchTimer = null;
  document.getElementById('areq-search-name').addEventListener('input', (e) => {
    clearTimeout(areqSearchTimer);
    areqSearchTimer = setTimeout(() => { areqFilters.name = e.target.value.trim(); loadAdminAllRequests(); }, 300);
  });
  document.querySelectorAll('#areq-type-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#areq-type-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      areqFilters.type = btn.dataset.type;
      loadAdminAllRequests();
    });
  });
  document.querySelectorAll('#areq-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#areq-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      areqFilters.status = btn.dataset.status;
      loadAdminAllRequests();
    });
  });
  document.getElementById('areq-toggle-advanced').addEventListener('click', () => {
    const el = document.getElementById('areq-advanced');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  ['areq-date-from', 'areq-date-to', 'areq-site', 'areq-partner'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      areqFilters.dateFrom = document.getElementById('areq-date-from').value;
      areqFilters.dateTo = document.getElementById('areq-date-to').value;
      areqFilters.site = document.getElementById('areq-site').value.trim();
      areqFilters.partner = document.getElementById('areq-partner').value.trim();
      loadAdminAllRequests();
    });
  });
  // PC版のテーブル表示: 見出しクリックで並び替え(再取得はせずareqRowsをクライアント側で並び替え)
  document.querySelectorAll('#screen-admin-all-requests .areq-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      areqSort = { col, dir: areqSort.col === col && areqSort.dir === 'asc' ? 'desc' : 'asc' };
      renderAreqAll();
    });
  });

  document.getElementById('daily-report-date').addEventListener('change', (e) => loadDailyReportForDate(e.target.value));
  document.getElementById('daily-report-add-entry').addEventListener('click', () => addDailyReportEntry());
  document.getElementById('daily-report-add-special-entry').addEventListener('click', () => addDailyReportEntry());
  document.getElementById('daily-report-submit').addEventListener('click', () => doSubmitDailyReport(false));
  document.getElementById('daily-report-save-draft').addEventListener('click', () => doSubmitDailyReport(true));
  onId('dr-sc-add', 'click', () => addDailyReportSubcontractorLine());
  onId('dr-sc-submit', 'click', doSubmitSubcontractorHeadcount);
  document.getElementById('daily-report-has-qualification').addEventListener('change', (e) => {
    document.getElementById('daily-report-qual-fields').style.display = e.target.checked ? 'block' : 'none';
  });
  document.getElementById('daily-report-qual-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('daily-report-qual-file-status');
    statusEl.textContent = 'アップロード中...';
    try {
      const session = getSession();
      const result = await uploadReceiptPhoto(session.employeeCode, file);
      dailyReportQualAttachment = { driveFileId: result.driveFileId, driveFileUrl: result.driveFileUrl };
      document.getElementById('daily-report-qual-file-label').textContent = file.name;
      statusEl.textContent = 'アップロード完了';
    } catch (e2) {
      statusEl.textContent = 'アップロードに失敗しました。もう一度お試しください。';
      dailyReportQualAttachment = null;
    }
  });

  document.getElementById('daily-report-target-type').addEventListener('change', (e) => {
    const session = getSession();
    const type = e.target.value;
    document.getElementById('daily-report-target-employee-wrap').style.display = type === 'employee' ? 'block' : 'none';
    document.getElementById('daily-report-target-worker-wrap').style.display = type === 'subcontractor' ? 'block' : 'none';
    // §6: 外注（応援）モードでは通常の社員日報フォームを完全に非表示にし、外注専用フォームだけ出す。
    const isSupport = type === 'subcontractor_support';
    const normalForm = document.getElementById('daily-report-normal-form');
    if (normalForm) normalForm.style.display = isSupport ? 'none' : '';
    if (isSupport) {
      dailyReportTarget = { type: 'subcontractor_support', employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
      loadDrScSection(document.getElementById('daily-report-date').value);
      return;
    }
    if (type === 'self') {
      dailyReportTarget = { type: 'self', employeeCode: session.employeeCode, employeeName: session.employeeName, subcontractorWorkerId: null, workerName: null };
      loadDailyReportForDate(document.getElementById('daily-report-date').value);
    } else {
      dailyReportTarget = { type, employeeCode: null, employeeName: null, subcontractorWorkerId: null, workerName: null };
    }
    loadDrScSection(document.getElementById('daily-report-date').value);
  });
  document.getElementById('daily-report-target-employee-search').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    const results = document.getElementById('daily-report-target-employee-results');
    if (q.length < 1) { results.innerHTML = ''; return; }
    const session = getSession();
    try {
      const rows = await rpc('list_employees_for_participant_select', { p_employee_code: session.employeeCode });
      const matches = rows.filter((r) => r.employee_name.includes(q) || r.employee_code.includes(q)).slice(0, 8);
      results.innerHTML = matches.map((r) => `<button type="button" class="candidate-item" data-code="${r.employee_code}" data-name="${r.employee_name}">${r.employee_name}(${r.employee_code})</button>`).join('');
      results.querySelectorAll('.candidate-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          dailyReportTarget = { type: 'employee', employeeCode: btn.dataset.code, employeeName: btn.dataset.name, subcontractorWorkerId: null, workerName: null };
          document.getElementById('daily-report-target-employee-label').style.display = 'block';
          document.getElementById('daily-report-target-employee-label').textContent = `選択中: ${btn.dataset.name}(${btn.dataset.code})`;
          results.innerHTML = ''; e.target.value = '';
          loadDailyReportForDate(document.getElementById('daily-report-date').value);
        });
      });
    } catch (err) { /* 無視 */ }
  });
  document.getElementById('daily-report-target-worker-search').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    const results = document.getElementById('daily-report-target-worker-results');
    try {
      const rows = await rpc('search_subcontractor_workers', { p_query: q || null });
      results.innerHTML = rows.map((r) => `<button type="button" class="candidate-item" data-id="${r.id}" data-name="${r.worker_name}">${r.worker_name}(${r.company_name})</button>`).join('');
      results.querySelectorAll('.candidate-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          dailyReportTarget = { type: 'subcontractor', employeeCode: null, employeeName: null, subcontractorWorkerId: Number(btn.dataset.id), workerName: btn.dataset.name };
          document.getElementById('daily-report-target-worker-label').style.display = 'block';
          document.getElementById('daily-report-target-worker-label').textContent = `選択中: ${btn.dataset.name}`;
          results.innerHTML = ''; e.target.value = '';
          loadDailyReportForDate(document.getElementById('daily-report-date').value);
        });
      });
    } catch (err) { /* 無視 */ }
  });
  document.querySelectorAll('#screen-daily-report-admin .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-daily-report-admin .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      dailyReportAdminStatus = btn.dataset.status;
      loadDailyReportAdminList();
    });
  });

  document.getElementById('myinfo-photo-input').addEventListener('change', (e) => handleMyPhotoFile(e.target.files[0]));
  document.getElementById('myinfo-photo-remove-btn').addEventListener('click', handleMyPhotoRemove);
  document.getElementById('profile-edit-submit').addEventListener('click', doSubmitProfileEdit);
  document.getElementById('pin-change-submit').addEventListener('click', doSubmitPinChange);
  SCREEN_ENTER_HOOKS['pin-change'] = resetPinChangeForm;
  document.getElementById('info-change-filter').addEventListener('change', loadInfoChangeAdmin);
  document.getElementById('supply-master-submit').addEventListener('click', doSaveSupplyMasterItem);
  document.getElementById('employee-detail-edit-basic-btn').addEventListener('click', openEmployeeEditBasic);
  document.getElementById('employee-edit-submit').addEventListener('click', doSaveEmployeeBasic);
  document.getElementById('employee-detail-revoke-all-devices-btn').addEventListener('click', async () => {
    if (!confirm(`${currentEmployeeDetailCode}のログイン中の全端末を無効化しますか?全ての端末で次回利用時に暗証番号の再入力が必要になります。`)) return;
    const session = getSession();
    try {
      await rpc('admin_revoke_all_employee_devices', { p_admin_employee_code: session.employeeCode, p_target_employee_code: currentEmployeeDetailCode });
      await loadEmployeeDetailDevices();
    } catch (e) {
      alert(e.message);
    }
  });
  document.getElementById('admin-issue-master').addEventListener('change', toggleAdminIssueOtherWrap);

  document.querySelectorAll('#employee-detail-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchEmployeeDetailTab(btn.dataset.tab));
  });

  document.querySelectorAll('#employee-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#employee-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      employeeStatusFilter = btn.dataset.status;
      loadEmployeeDirectory();
    });
  });
  document.getElementById('employee-search-input').addEventListener('input', () => {
    clearTimeout(employeeSearchTimer);
    employeeSearchTimer = setTimeout(loadEmployeeDirectory, 300);
  });

  const imageZoomOverlay = document.getElementById('image-zoom-overlay');
  const closeImageZoom = () => imageZoomOverlay.classList.remove('open');
  imageZoomOverlay.addEventListener('click', closeImageZoom);
  document.getElementById('image-zoom-close').addEventListener('click', (e) => { e.stopPropagation(); closeImageZoom(); });
  // 領収書ギャラリー操作(前/次/閉じる/スワイプ)
  document.getElementById('rg-close').addEventListener('click', (e) => { e.stopPropagation(); closeReceiptGallery(); });
  document.getElementById('rg-prev').addEventListener('click', (e) => { e.stopPropagation(); rgStep(-1); });
  document.getElementById('rg-next').addEventListener('click', (e) => { e.stopPropagation(); rgStep(1); });
  (() => {
    const stage = document.getElementById('rg-stage'); let sx = null;
    stage.addEventListener('touchstart', (e) => { sx = e.changedTouches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 40) rgStep(dx < 0 ? 1 : -1); sx = null; }, { passive: true });
  })();

  document.getElementById('ai-guide-fab').addEventListener('click', openAiGuidePanel);
  document.getElementById('ai-guide-close').addEventListener('click', closeAiGuidePanel);
  document.getElementById('ai-guide-quick-replies').innerHTML = AI_GUIDE_QUICK_REPLIES.map((q) => `<button type="button">${q}</button>`).join('');
  document.getElementById('ai-guide-quick-replies').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => handleAiGuideMessage(btn.textContent));
  });
  const aiGuideSend = () => {
    const input = document.getElementById('ai-guide-input');
    handleAiGuideMessage(input.value);
    input.value = '';
  };
  document.getElementById('ai-guide-send').addEventListener('click', aiGuideSend);
  document.getElementById('ai-guide-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') aiGuideSend(); });

  document.getElementById('admin-exit-btn').addEventListener('click', () => {
    inAdminMode = false;
    enterMenu();
  });

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      if (el.disabled) return;
      // 完了画面(screen-done)からの遷移は、完了画面自体を履歴に残さず置き換える
      // (この後さらに「戻る」を押しても完了画面へ戻ってくる=無限ループに見える、を防ぐ)。
      const leavingDone = document.getElementById('screen-done').classList.contains('active');
      if (el.classList.contains('back-to-origin')) { goBackToOrigin(target); return; }
      if (target === 'menu') { enterMenu(leavingDone); return; }
      if (target === 'expense') { showScreen('expense-select', { replace: leavingDone }); return; }
      if (target === 'expense-advance') { enterExpenseScreen('employee_advance'); return; }
      if (target === 'expense-company') { enterExpenseScreen('company_expense'); return; }
      if (target === 'expense-bulk-advance') { enterExpenseBulkScreen('employee_advance'); return; }
      if (target === 'expense-bulk-company') { enterExpenseBulkScreen('company_expense'); return; }
      showScreen(target, { replace: leavingDone });
    });
  });

  SCREEN_ENTER_HOOKS.leave = () => { updateLeaveDaysDisplay(); loadLeaveBalance(); };
  SCREEN_ENTER_HOOKS['leave-history'] = loadLeaveHistory;
  SCREEN_ENTER_HOOKS.history = loadHistory;
  SCREEN_ENTER_HOOKS['supply-request'] = () => { hideError('supply-req-error'); resetSupplyRequestScreen(); };
  SCREEN_ENTER_HOOKS['supply-initial-holding'] = () => { hideError('supply-ih-error'); resetSupplyInitialHoldingScreen(); };
  SCREEN_ENTER_HOOKS['supply-request-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadSupplyRequestAdminList();
    loadSupplyDeliveryQueue();
  };
  SCREEN_ENTER_HOOKS['my-supply'] = loadMySupply;
  SCREEN_ENTER_HOOKS.myinfo = loadMyInfo;
  SCREEN_ENTER_HOOKS['my-change-requests'] = loadMyChangeRequests;
  SCREEN_ENTER_HOOKS.admin = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminEmployeeSelects();
    document.getElementById('admin-search-results').innerHTML = '';
  };
  SCREEN_ENTER_HOOKS['anon-consult'] = loadMyAnonConsultations;
  SCREEN_ENTER_HOOKS['anon-submit'] = () => { hideError('anon-submit-error'); document.getElementById('anon-content').value = ''; };
  SCREEN_ENTER_HOOKS['anon-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAnonAdminList();
  };
  SCREEN_ENTER_HOOKS.announcements = loadAnnouncements;
  const announceArchiveBtn = document.getElementById('announce-show-archived-btn');
  if (announceArchiveBtn) announceArchiveBtn.addEventListener('click', () => loadAnnouncements(true));
  SCREEN_ENTER_HOOKS['admin-dashboard'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminDashboard();
  };
  SCREEN_ENTER_HOOKS['admin-request-list'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminRequestList();
  };
  SCREEN_ENTER_HOOKS['admin-announce'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    hideError('announce-error');
    loadAnnounceAdminEmployeeSelect();
    loadAnnounceAdminList();
  };
  SCREEN_ENTER_HOOKS['qual-submit'] = resetQualForm;
  SCREEN_ENTER_HOOKS['my-qual'] = loadMyQualifications;
  SCREEN_ENTER_HOOKS['qual-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadQualAdminList();
  };
  SCREEN_ENTER_HOOKS['category-review'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadCategoryReview();
  };
  SCREEN_ENTER_HOOKS['employee-directory'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    document.getElementById('employee-search-input').value = '';
    employeeStatusFilter = 'active';
    document.querySelectorAll('#employee-status-filter .filter-chip').forEach((b) => b.classList.toggle('active', b.dataset.status === 'active'));
    loadEmployeeDirectory();
  };
  SCREEN_ENTER_HOOKS['employee-create'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    resetEmployeeCreateForm();
  };
  onId('ec-submit', 'click', doCreateEmployee);
  SCREEN_ENTER_HOOKS['info-change-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadInfoChangeAdmin();
  };
  SCREEN_ENTER_HOOKS['supply-master-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadSupplyMasterAdmin();
  };
  SCREEN_ENTER_HOOKS['supply-holdings-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadSupplyHoldingsAdmin();
  };
  SCREEN_ENTER_HOOKS['health-submit'] = resetHealthForm;
  SCREEN_ENTER_HOOKS['my-qual'] = () => { loadMyQualifications(); loadMyHealthSummary(); };
  SCREEN_ENTER_HOOKS['my-health'] = loadMyHealthList;
  SCREEN_ENTER_HOOKS['entertainment-submit'] = resetEntertainmentForm;
  SCREEN_ENTER_HOOKS['status-submit'] = loadStatusSubmitScreen;
  SCREEN_ENTER_HOOKS['admin-status-board'] = loadAdminStatusBoard;
  SCREEN_ENTER_HOOKS['my-action-items'] = loadMyActionItems;
  SCREEN_ENTER_HOOKS['admin-action-item-create'] = resetActionItemCreateForm;
  SCREEN_ENTER_HOOKS['propose-site'] = resetProposeSiteForm;
  SCREEN_ENTER_HOOKS['status-board-general'] = loadStatusBoardGeneral;
  SCREEN_ENTER_HOOKS['entertainment-late-submit'] = resetEntertainmentLateForm;
  SCREEN_ENTER_HOOKS['my-entertainment'] = loadMyEntertainmentList;
  SCREEN_ENTER_HOOKS['entertainment-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadEntertainmentAdminList();
  };
  SCREEN_ENTER_HOOKS['site-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    populateSitePrefectureSelect();
    loadSiteAdminList();
    loadAllSitesList();
  };
  SCREEN_ENTER_HOOKS['device-approval-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadDeviceApprovalList();
  };
  SCREEN_ENTER_HOOKS['meeting'] = resetMeetingForm;
  document.getElementById('site-create-submit').addEventListener('click', () => doCreateSite(false));
  let siteListSearchTimer = null;
  document.getElementById('site-list-search').addEventListener('input', (e) => {
    clearTimeout(siteListSearchTimer);
    siteListSearchTimer = setTimeout(() => { siteListQuery = e.target.value.trim(); loadAllSitesList(); }, 300);
  });

  // ---------- 有給管理・社員別集計・出面集計(管理者) ----------
  SCREEN_ENTER_HOOKS['leave-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    document.getElementById('la-search').value = '';
    loadLeaveAdmin();
  };
  SCREEN_ENTER_HOOKS['employee-summary'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    if (!document.getElementById('es-month').value) document.getElementById('es-month').value = todayJST().slice(0, 7);
    loadEmployeeSummary();
  };
  SCREEN_ENTER_HOOKS['attendance-matrix'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    if (!document.getElementById('am-month').value) document.getElementById('am-month').value = todayJST().slice(0, 7);
    updateAmMonthDisplay();
    loadAttendanceFilterOptions();
    loadAttendanceMatrix();
  };
  SCREEN_ENTER_HOOKS['bulk-expense-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadBulkExpenseAdminList();
  };
  document.getElementById('la-search').addEventListener('input', () => {
    clearTimeout(employeeSearchTimer);
    employeeSearchTimer = setTimeout(loadLeaveAdmin, 300);
  });
  document.getElementById('leave-grant-submit').addEventListener('click', doSubmitLeaveGrant);
  document.getElementById('leave-grant-method').addEventListener('change', (e) => {
    document.getElementById('leave-grant-statutory-wrap').style.display = e.target.value === 'legal_statutory' ? '' : 'none';
    updateLeaveGrantStatutoryHint();
  });
  document.getElementById('leave-grant-schedule').addEventListener('change', updateLeaveGrantStatutoryHint);
  document.getElementById('leave-grant-date').addEventListener('change', (e) => {
    if (!document.getElementById('leave-grant-period-start').value) document.getElementById('leave-grant-period-start').value = e.target.value;
    if (!document.getElementById('leave-grant-period-end').value && e.target.value) {
      const d = new Date(e.target.value); d.setFullYear(d.getFullYear() + 1); d.setDate(d.getDate() - 1);
      document.getElementById('leave-grant-period-end').value = d.toISOString().slice(0, 10);
    }
  });
  document.getElementById('leave-grant-manual-adjustment').addEventListener('change', (e) => {
    document.getElementById('leave-grant-adjustment-reason-wrap').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('employee-detail-leave-method').addEventListener('change', updateEmployeeDetailStatutoryHint);
  document.getElementById('ep-submit').addEventListener('click', doSubmitExpensePayment);
  document.getElementById('ep-schedule-save').addEventListener('click', async () => {
    const session = getSession();
    if (!expensePaymentTarget) return;
    const d = document.getElementById('ep-schedule-date').value;
    if (!d) { showError('ep-error', '精算予定日を入力してください。'); return; }
    hideError('ep-error');
    try {
      await rpc('admin_set_expense_payment_schedule', { p_admin_employee_code: session.employeeCode, p_employee_request_id: Number(expensePaymentTarget.requestId), p_scheduled_payment_date: d });
      await loadExpensePaymentSchedule(expensePaymentTarget.requestId);
    } catch (e) { showError('ep-error', e.message || '精算予定日の設定に失敗しました。'); }
  });

  document.getElementById('expense-bulk-receipts-input').addEventListener('change', (e) => {
    handleBulkReceiptFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('expense-bulk-camera-input').addEventListener('change', (e) => {
    handleBulkReceiptFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('expense-bulk-cover-input').addEventListener('change', (e) => {
    if (e.target.files[0]) handleBulkCoverSheetFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('expense-bulk-apply-all').addEventListener('click', applyBulkSiteAndPurposeToAll);
  document.getElementById('expense-bulk-submit').addEventListener('click', doSubmitExpenseBulk);
  document.getElementById('expense-bulk-bulk-site').addEventListener('input', (e) => populateSiteSelect(e.target, ''));

  document.querySelectorAll('#bea-status-filter .filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#bea-status-filter .filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      bulkExpenseAdminFilter = chip.dataset.status || '';
      loadBulkExpenseAdminList();
    });
  });
  onId('bea-open-ledger-btn', 'click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '開いています...';
    try {
      const session = getSession();
      const link = await rpc('admin_get_expense_ledger_link', { p_admin_employee_code: session.employeeCode });
      if (link) window.open(link, '_blank');
      else alert('台帳はまだ作成されていません(経費が確定されると自動生成されます)。');
    } catch (err) {
      alert(err.message || '台帳リンクの取得に失敗しました。');
    } finally {
      btn.disabled = false;
      btn.textContent = '経費台帳・月次集計(Spreadsheet)を開く';
    }
  });
  document.getElementById('bed-select-all').addEventListener('click', () => {
    document.querySelectorAll('.bed-item-check').forEach((cb) => { cb.checked = true; bulkExpenseSelectedItems.add(cb.dataset.id); });
    updateBulkExpenseSelectedCount();
  });
  document.getElementById('bed-select-none').addEventListener('click', () => {
    document.querySelectorAll('.bed-item-check').forEach((cb) => { cb.checked = false; });
    bulkExpenseSelectedItems.clear();
    updateBulkExpenseSelectedCount();
  });
  document.getElementById('bed-approve-selected').addEventListener('click', () => doDecideBulkExpenseSelected('approved'));
  document.getElementById('bed-reject-selected').addEventListener('click', () => doDecideBulkExpenseSelected('rejected'));
  document.getElementById('bed-hold-selected').addEventListener('click', () => doDecideBulkExpenseSelected('on_hold'));
  document.getElementById('bed-confirm-reason').addEventListener('click', () => {
    const reason = document.getElementById('bed-reason').value.trim();
    if (!reason) { showError('bed-error', '理由を入力してください。'); return; }
    submitBulkExpenseDecision(bulkExpensePendingDecision, reason);
  });
  document.getElementById('employee-detail-grant-leave-btn').addEventListener('click', () => {
    const nameEl = document.getElementById('employee-detail-name');
    openLeaveGrant(currentEmployeeDetailCode, nameEl ? nameEl.textContent : '');
  });
  document.getElementById('employee-detail-leave-policy-save').addEventListener('click', doSaveLeavePolicy);
  document.getElementById('es-month').addEventListener('change', loadEmployeeSummary);
  document.getElementById('am-month').addEventListener('change', () => { updateAmMonthDisplay(); loadAttendanceFilterOptions(); loadAttendanceMatrix(); });
  document.getElementById('am-month-prev').addEventListener('click', () => shiftAmMonth(-1));
  document.getElementById('am-month-next').addEventListener('click', () => shiftAmMonth(1));
  document.getElementById('am-month-today').addEventListener('click', () => {
    document.getElementById('am-month').value = todayJST().slice(0, 7);
    document.getElementById('am-month').dispatchEvent(new Event('change'));
  });
  document.getElementById('am-year').addEventListener('change', loadAttendanceMatrix);
  document.getElementById('am-site-filter').addEventListener('change', (e) => { attendanceSiteFilter = e.target.value; loadAttendanceMatrix(); });
  document.getElementById('am-employee-filter').addEventListener('change', (e) => { attendanceEmployeeFilter = e.target.value; loadAttendanceMatrix(); });
  document.getElementById('am-company-filter').addEventListener('change', (e) => { attendanceCompanyFilter = e.target.value; loadAttendanceMatrix(); });
  document.querySelectorAll('#am-view-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      attendanceView = btn.dataset.view;
      document.querySelectorAll('#am-view-filter .filter-chip').forEach((c) => c.classList.toggle('active', c === btn));
      loadAttendanceMatrix();
    });
  });
  document.querySelectorAll('#am-period-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      attendancePeriod = btn.dataset.period;
      document.querySelectorAll('#am-period-filter .filter-chip').forEach((c) => c.classList.toggle('active', c === btn));
      document.getElementById('am-month-group').style.display = attendancePeriod === 'month' ? 'block' : 'none';
      document.getElementById('am-year').style.display = attendancePeriod === 'year' ? 'block' : 'none';
      document.querySelector('label[for="am-year"]').style.display = attendancePeriod === 'year' ? 'block' : 'none';
      if (attendancePeriod === 'year' && !document.getElementById('am-year').value) {
        document.getElementById('am-year').value = new Date(todayJST()).getFullYear();
      }
      loadAttendanceMatrix();
    });
  });

  // ---------- 常用伝票 ----------
  SCREEN_ENTER_HOOKS['joyo-denpyo-list'] = () => { jdFilters = { partner: '', dateFrom: '', dateTo: '' }; document.getElementById('jd-search-partner').value = ''; document.getElementById('jd-search-date-from').value = ''; document.getElementById('jd-search-date-to').value = ''; loadJoyoDenpyoList(); };
  SCREEN_ENTER_HOOKS['joyo-denpyo-form'] = () => { if (!document.getElementById('jd-edit-id').value) resetJoyoDenpyoForm(); };
  SCREEN_ENTER_HOOKS['joyo-denpyo-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    if (!jdaEmployeeFilterJustSet) jdaEmployeeFilter = null;
    jdaEmployeeFilterJustSet = false;
    jdaStatusFilter = '';
    document.querySelectorAll('#jda-status-filter .filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
    document.getElementById('jda-search-partner').value = '';
    document.getElementById('jda-date-from').value = '';
    document.getElementById('jda-date-to').value = '';
    populateSiteSelect(document.getElementById('jda-site-select'), '');
    loadJoyoDenpyoAdminList();
  };
  document.getElementById('jda-clear-employee-filter-btn').addEventListener('click', () => { jdaEmployeeFilter = null; loadJoyoDenpyoAdminList(); });
  document.getElementById('jda-date-from').addEventListener('change', loadJoyoDenpyoAdminList);
  document.getElementById('jda-date-to').addEventListener('change', loadJoyoDenpyoAdminList);
  document.getElementById('jda-site-select').addEventListener('change', loadJoyoDenpyoAdminList);

  // ---------- 常用台帳集計(Phase C-6) ----------
  SCREEN_ENTER_HOOKS['joyo-denpyo-summary'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    if (!document.getElementById('jds-month').value) document.getElementById('jds-month').value = todayJST().slice(0, 7);
    jdsView = 'employee';
    document.querySelectorAll('#jds-view-filter .filter-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
    jdsSiteFilter = '';
    jdsCompanyFilter = '';
    jdsPartnerFilter = '';
    document.getElementById('jds-site-filter').value = '';
    document.getElementById('jds-company-filter').value = '';
    document.getElementById('jds-partner-filter').value = '';
    document.getElementById('jds-range-result').style.display = 'none';
    updateJdsMonthDisplay();
    loadJoyoDenpyoSummary();
  };
  document.getElementById('jds-month').addEventListener('change', () => { updateJdsMonthDisplay(); loadJoyoDenpyoSummary(); });
  document.getElementById('jds-month-prev').addEventListener('click', () => shiftJdsMonth(-1));
  document.getElementById('jds-month-next').addEventListener('click', () => shiftJdsMonth(1));
  document.getElementById('jds-month-today').addEventListener('click', () => {
    document.getElementById('jds-month').value = todayJST().slice(0, 7);
    document.getElementById('jds-month').dispatchEvent(new Event('change'));
  });
  document.getElementById('jds-site-filter').addEventListener('change', (e) => { jdsSiteFilter = e.target.value; loadJdsMatrix(); });
  document.getElementById('jds-company-filter').addEventListener('change', (e) => { jdsCompanyFilter = e.target.value; loadJdsMatrix(); });
  onId('jds-partner-filter', 'change', (e) => { jdsPartnerFilter = e.target.value; loadJdsMatrix(); });
  onId('jds-open-ledger-btn', 'click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '開いています...';
    try {
      const session = getSession();
      const link = await rpc('admin_get_joyo_denpyo_ledger_link', { p_admin_employee_code: session.employeeCode });
      if (link) window.open(link, '_blank');
      else alert('台帳はまだ作成されていません(伝票が確定されると自動生成されます)。');
    } catch (err) {
      alert(err.message || '台帳リンクの取得に失敗しました。');
    } finally {
      btn.disabled = false;
      btn.textContent = '月次台帳(Spreadsheet)を開く';
    }
  });
  document.querySelectorAll('#jds-view-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      jdsView = btn.dataset.view;
      document.querySelectorAll('#jds-view-filter .filter-chip').forEach((c) => c.classList.toggle('active', c === btn));
      loadJdsMatrix();
    });
  });
  document.getElementById('jds-range-calc-btn').addEventListener('click', async () => {
    const session = getSession();
    const from = document.getElementById('jds-range-from').value;
    const to = document.getElementById('jds-range-to').value;
    const resultEl = document.getElementById('jds-range-result');
    if (!from || !to) { alert('開始日と終了日を指定してください。'); return; }
    if (from > to) { alert('開始日は終了日より前にしてください。'); return; }
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div class="hint">集計中...</div>';
    try {
      const rows = await rpc('admin_get_joyo_denpyo_totals', { p_admin_employee_code: session.employeeCode, p_date_from: from, p_date_to: to });
      const t = (rows && rows[0]) || { total_headcount: 0, denpyo_count: 0, site_count: 0, worker_count: 0 };
      resultEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-weight:700; font-size:14.5px;"><span>${from} 〜 ${to}</span><span>${t.total_headcount}人工</span></div>
        <div class="hint" style="margin-top:5px;">伝票数: ${t.denpyo_count}件・現場数: ${t.site_count}件・実人数: ${t.worker_count}人</div>
      `;
    } catch (e) {
      resultEl.innerHTML = '<div class="hint">集計に失敗しました。</div>';
    }
  });

  document.getElementById('jd-new-btn').addEventListener('click', () => openJoyoDenpyoForm(null));
  document.getElementById('jd-prefill-btn').addEventListener('click', doPrefillJoyoDenpyoWorkers);
  document.getElementById('jd-photo-input').addEventListener('change', (e) => handleJdPhotoFile(e.target.files[0]));
  document.getElementById('jd-add-worker-btn').addEventListener('click', () => addJoyoDenpyoWorkerRow(null));
  document.getElementById('jd-photo-history-toggle').addEventListener('click', () => {
    const el = document.getElementById('jd-photo-history-list');
    el.style.display = el.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('jd-workers-list').addEventListener('input', (e) => {
    if (e.target.classList.contains('jd-worker-name') || e.target.classList.contains('jd-worker-headcount')) updateJdWorkersSummary();
  });
  document.getElementById('jd-submit').addEventListener('click', () => doSubmitJoyoDenpyo(false));
  document.getElementById('jd-save-draft').addEventListener('click', () => doSubmitJoyoDenpyo(true));
  let jdSiteSearchTimer = null;
  document.getElementById('jd-site-search').addEventListener('input', (e) => {
    clearTimeout(jdSiteSearchTimer);
    jdSiteSearchTimer = setTimeout(() => populateSiteSelect(document.getElementById('jd-site-select'), e.target.value.trim()), 250);
  });
  let jdSearchTimer = null;
  document.getElementById('jd-search-partner').addEventListener('input', (e) => {
    clearTimeout(jdSearchTimer);
    jdSearchTimer = setTimeout(() => { jdFilters.partner = e.target.value.trim(); loadJoyoDenpyoList(); }, 300);
  });
  ['jd-search-date-from', 'jd-search-date-to'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      jdFilters.dateFrom = document.getElementById('jd-search-date-from').value;
      jdFilters.dateTo = document.getElementById('jd-search-date-to').value;
      loadJoyoDenpyoList();
    });
  });
  document.getElementById('jda-search-partner').addEventListener('input', () => {
    clearTimeout(jdSearchTimer);
    jdSearchTimer = setTimeout(() => loadJoyoDenpyoAdminList(), 300);
  });
  document.querySelectorAll('#jda-status-filter .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#jda-status-filter .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      jdaStatusFilter = btn.dataset.status;
      loadJoyoDenpyoAdminList();
    });
  });
  document.getElementById('jd-print-btn').addEventListener('click', () => window.print());
  document.getElementById('jda-select-all').addEventListener('change', (e) => {
    document.querySelectorAll('.jda-row-check').forEach((cb) => { cb.checked = e.target.checked; if (e.target.checked) jdaSelected.add(cb.dataset.id); else jdaSelected.delete(cb.dataset.id); });
    updateJdaBulkBar();
  });
  document.getElementById('jda-bulk-print-btn').addEventListener('click', () => openJoyoDenpyoPrint(Array.from(jdaSelected)));

  // ---------- 社内イベント ----------
  SCREEN_ENTER_HOOKS.events = loadEventsList;
  SCREEN_ENTER_HOOKS['event-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadEventAdminList();
  };
  document.querySelectorAll('#event-response-chips .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#event-response-chips .filter-chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('event-response-submit').addEventListener('click', doRespondToEvent);
  document.getElementById('event-create-submit').addEventListener('click', doCreateEvent);
  document.getElementById('event-notify-unanswered-btn').addEventListener('click', doNotifyUnansweredEvent);

  SCREEN_ENTER_HOOKS['license-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadLicenseTypeAdminList();
  };
  SCREEN_ENTER_HOOKS['health-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadHealthAdminList();
  };
  SCREEN_ENTER_HOOKS['daily-report'] = resetDailyReportForm;
  SCREEN_ENTER_HOOKS['my-daily-reports'] = loadMyDailyReports;
  SCREEN_ENTER_HOOKS['my-daily-report-detail'] = () => { if (myDailyReportDetailDate) renderMyDailyReportDetailBody(myDailyReportDetailDate); };
  SCREEN_ENTER_HOOKS['first-login-codes-admin'] = loadFirstLoginCodesAdmin;
  SCREEN_ENTER_HOOKS['daily-report-needs-review-admin'] = loadDailyReportNeedsReviewAdmin;
  SCREEN_ENTER_HOOKS['daily-report-edit-requests-admin'] = loadDailyReportEditRequestsAdmin;
  SCREEN_ENTER_HOOKS['daily-report-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadDailyReportAdminList();
  };
  SCREEN_ENTER_HOOKS['purpose-admin'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadPurposeAdminList();
  };
  SCREEN_ENTER_HOOKS['admin-all-requests'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminAllRequests();
  };
  SCREEN_ENTER_HOOKS['admin-role-management'] = () => {
    if (!isAdmin()) { enterMenu(); return; }
    loadAdminRoleManagement();
  };
  SCREEN_ENTER_HOOKS['daily-report-management'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadDailyReportManagement();
  };
  SCREEN_ENTER_HOOKS['daily-report-people'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadDailyReportPeople();
  };
  SCREEN_ENTER_HOOKS['request-detail'] = () => { loadRequestDetailContent(); };
  SCREEN_ENTER_HOOKS['my-request-detail'] = () => { loadMyRequestDetailContent(); };
  SCREEN_ENTER_HOOKS['subcontractor-company-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    loadSubcontractorCompanyAdmin();
  };
  SCREEN_ENTER_HOOKS['subcontractor-worker-admin'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
    if (!subcontractorWorkerFilterJustSet) subcontractorWorkerCompanyFilter = null;
    subcontractorWorkerFilterJustSet = false;
    loadSubcontractorWorkerAdmin();
  };
  document.getElementById('sc-worker-clear-filter-btn').addEventListener('click', () => {
    subcontractorWorkerCompanyFilter = null;
    loadSubcontractorWorkerAdmin();
  });
  SCREEN_ENTER_HOOKS['daily-report-detail'] = async () => {
    if (!(await isNippoAdmin())) { enterMenu(); return; }
  };

  // sessionStorageに前回のセッション表示情報が残っていても、実際にRPCを呼ぶための
  // 端末トークン(currentDeviceToken)はページを開き直すたびにリセットされる
  // (JSのメモリ変数のため)。ここでlocalStorageの端末トークンと突き合わせて一致する
  // 場合だけ、サーバーへ問い合わせずにそのままメニューへ進む(タブ内リロードを軽くする)。
  // 一致しない・存在しない場合はstartLoginFlow()側でトークンの検証からやり直す。
  // 配置カレンダー専用URLから飛ばされてきた場合の戻り先を、この時点で覚えておく。
  // 以降どの経路(暗証番号ログイン・初回登録・端末承認待ちからの復帰)で
  // ホームへ入っても enterMenu() が必ずカレンダーへ帰す。
  rememberLoginReturn();

  const session = getSession();
  const deviceAuth = getDeviceAuth();
  if (session && session.employeeId && deviceAuth && deviceAuth.token && deviceAuth.employeeCode === session.employeeCode) {
    currentDeviceToken = deviceAuth.token;
    enterMenu();
  } else {
    startLoginFlow();
  }

  // PWAをホーム画面に追加して使う実機では、アプリを開いたままだと新しいバージョンの
  // Service Workerが有効化されても画面上のHTML/JSは古いまま(再読み込みするまで反映されない)。
  // sw.js側でskipWaiting+clients.claim済みなので、制御が新しいSWへ切り替わった瞬間に
  // 自動で1回だけ再読み込みし、実機でも次に開いたときには必ず最新版になるようにする。
  if ('serviceWorker' in navigator) {
    let swRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swRefreshing) return;
      swRefreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
