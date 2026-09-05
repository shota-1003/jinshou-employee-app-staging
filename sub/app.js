'use strict';
// 迅翔興業 外注本人ポータル。社員ポータル(employee-app)と同じ「ソースは本番URL固定、
// Staging/Productionへはコピー先で差し替える」方式。外注本人はログインID+暗証番号で認証し、
// 端末トークン(X-Sub-Device-Token)で以後のRPCを呼ぶ。9ステップ: ①初回登録 ②基本情報
// ③会社紐付け ④資格 ⑤現場 ⑥終日/午前/午後 ⑦人工 ⑧残業 ⑨登録。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
// ↓ここはStaging/Productionのビルド差し替えマーカー(employee-appと同じ運用)。手で書き換えない。
const IS_STAGING = false; // BUILD_FLAG_IS_STAGING

const SUB_AUTH_KEY = 'jinshou_sub_auth'; // localStorage {loginCode, token}
let loginCode = null;
let deviceToken = null;
let currentWorker = null; // {name, company}

// ログイン情報の保存先を localStorage だけに頼らない(2026-09-05)。
// 外注端末の大半はLINEアプリ内ブラウザで、localStorageが次回起動時に残らないことがある。
// localStorage / cookie / sessionStorage の3か所へ書き、読むときはこの順で最初に見つかった
// ものを使う。cookieはHTTPS前提でSameSite=Laxを付ける(同一サイト遷移では送られる)。
const AUTH_MAX_AGE_DAYS = 180;

function readCookieAuth() {
  try {
    const m = (document.cookie || '').match(new RegExp('(?:^|; )' + SUB_AUTH_KEY + '=([^;]*)'));
    return m ? JSON.parse(decodeURIComponent(m[1])) : null;
  } catch (e) { return null; }
}
function writeCookieAuth(value) {
  try {
    const v = encodeURIComponent(JSON.stringify(value));
    const maxAge = AUTH_MAX_AGE_DAYS * 24 * 60 * 60;
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${SUB_AUTH_KEY}=${v}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
  } catch (e) {}
}
function deleteCookieAuth() {
  try { document.cookie = `${SUB_AUTH_KEY}=; Max-Age=0; Path=/; SameSite=Lax`; } catch (e) {}
}

function loadAuth() {
  const sources = [
    () => JSON.parse(localStorage.getItem(SUB_AUTH_KEY) || 'null'),
    () => readCookieAuth(),
    () => JSON.parse(sessionStorage.getItem(SUB_AUTH_KEY) || 'null'),
  ];
  for (const read of sources) {
    let a = null;
    try { a = read(); } catch (e) { a = null; }
    if (a && a.loginCode) {
      loginCode = a.loginCode;
      deviceToken = a.token || null;
      saveAuth(); // 見つかった値を他の保存先へも書き戻して冗長性を回復する
      return;
    }
  }
}
function saveAuth() {
  const value = { loginCode, token: deviceToken };
  try { localStorage.setItem(SUB_AUTH_KEY, JSON.stringify(value)); } catch (e) {}
  try { sessionStorage.setItem(SUB_AUTH_KEY, JSON.stringify(value)); } catch (e) {}
  writeCookieAuth(value);
}
function clearAuth() {
  try { localStorage.removeItem(SUB_AUTH_KEY); } catch (e) {}
  try { sessionStorage.removeItem(SUB_AUTH_KEY); } catch (e) {}
  deleteCookieAuth();
  loginCode = null; deviceToken = null; currentWorker = null;
}

// LINEアプリ内ブラウザ判定。UA末尾に " Line/26.13.0" のように付く。
function isLineInAppBrowser() {
  try { return / Line\//i.test(navigator.userAgent || ''); } catch (e) { return false; }
}

async function rpc(name, params) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
  if (deviceToken) headers['X-Sub-Device-Token'] = deviceToken;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(params || {}) });
  const txt = await res.text();
  let body; try { body = JSON.parse(txt); } catch (e) { body = txt; }
  if (!res.ok) {
    const msg = (body && body.message) ? body.message : `通信に失敗しました (${res.status})`;
    const err = new Error(msg); err.status = res.status; err.code = body && body.code; throw err;
  }
  return body;
}

function $(id) { return document.getElementById(id); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $('screen-' + id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}
function setErr(id, msg) { const el = $(id); if (el) { el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; } }
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`;
}

// ---- 起動 ----
// LINEアプリ内ブラウザ向けの案内(強制はしない)。?openExternalBrowser=1 を付けたリンクを
// LINE内で開くと、LINEが外部ブラウザ(Safari/Chrome)へ渡してくれる。
function setupLineBrowserNotice() {
  if (!isLineInAppBrowser()) return;
  const box = $('line-browser-notice');
  if (!box) return;
  const link = $('line-open-external');
  if (link) {
    const url = new URL(location.href);
    url.searchParams.set('openExternalBrowser', '1');
    link.setAttribute('href', url.toString());
  }
  const close = $('line-notice-close');
  if (close) close.addEventListener('click', () => { box.style.display = 'none'; });
  box.style.display = 'block';
}

async function boot() {
  // 失敗を errors テーブルへ残す。これが無かったため、外注側で何が起きているかを
  // 誰も観測できない状態が続いていた(2026-09-05)。
  try {
    if (window.ClientErrorReporter && window.ClientErrorReporter.init) {
      window.ClientErrorReporter.init({
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY,
        agentName: 'jinshou-subcontractor-app',
        getEmployeeCode: () => loginCode || null,
      });
    }
  } catch (e) { /* 監視の初期化失敗で本体を止めない */ }

  loadAuth();
  if (IS_STAGING) { const b = $('staging-banner'); if (b) b.style.display = 'block'; }
  setupLineBrowserNotice();
  bindEvents();
  if (loginCode && deviceToken) {
    // 端末トークンでセッション再開(IDは端末が保持・入力不要)
    try {
      const r = await rpc('subcontractor_resume_session', { p_login_code: loginCode });
      const row = Array.isArray(r) ? r[0] : r;
      if (row && row.out_worker_id) { currentWorker = { name: row.out_worker_name, company: row.out_company_name }; enterHome(); return; }
    } catch (e) { /* 期限切れ等 → 暗証番号ログインへ */ }
    // トークンが無効: この端末は登録済みなので暗証番号だけで再ログイン
    $('pin-entry-name').textContent = 'おかえりなさい';
    showScreen('pin-entry');
    return;
  }
  // QR/リンクから開いた初回登録(パターンB): ?fl=<作業員ID>&c=<初回登録コード>。
  try {
    const q = new URLSearchParams(location.search);
    const flLogin = q.get('fl'); const flCode = q.get('c');
    if (flLogin) { openFirstLogin({ loginCode: flLogin, code: flCode || '' }); return; }
  } catch (e) { /* パラメータ不正時は通常のwelcomeへ */ }
  showScreen('welcome');
}

function bindEvents() {
  // 入口: 外注登録(自己登録) / 機種変更(本人再確認)
  $('welcome-register-btn').addEventListener('click', openRegister);
  $('welcome-recover-btn').addEventListener('click', () => openRecover());
  $('welcome-first-login-btn').addEventListener('click', () => openFirstLogin());
  $('welcome-relink-btn').addEventListener('click', openRelink);
  $('register-submit').addEventListener('click', doSelfRegister);
  $('first-login-submit').addEventListener('click', doFirstLogin);
  $('relink-submit').addEventListener('click', doRelink);
  $('recover-submit').addEventListener('click', doRecover);
  $('recover-to-register').addEventListener('click', openRegister);
  $('registered-continue-btn').addEventListener('click', () => { enterHome(); openAttendance(); });
  $('registered-profile-btn').addEventListener('click', () => { enterHome(); openProfile(); });

  // 暗証番号ログイン(2回目以降・IDは端末が記憶)
  $('pin-entry-submit').addEventListener('click', doPinLogin);
  $('pin-entry-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPinLogin(); });
  $('pin-entry-switch').addEventListener('click', () => { showScreen('welcome'); });

  // ホーム
  $('home-attendance-btn').addEventListener('click', openAttendance);
  $('home-profile-btn').addEventListener('click', openProfile);
  $('home-logout-btn').addEventListener('click', doLogout);

  // もどる
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => showScreen(b.getAttribute('data-back'))));

  // プロフィール保存
  $('profile-save-btn').addEventListener('click', saveProfile);
  $('qual-add-btn').addEventListener('click', addQualification);
  $('health-add-btn').addEventListener('click', addHealthCheckup);

  // 1日最大2現場: 「＋もう1現場を追加」で2つ目の現場ブロックを出す。
  $('att-add-site-btn').addEventListener('click', () => { addAttBlock(); });

  $('att-submit-btn').addEventListener('click', submitAttendance);

  // 出勤履歴(月単位)
  $('home-history-btn').addEventListener('click', () => openHistory());
  $('hist-prev').addEventListener('click', () => { histYM = shiftYM(histYM, -1); loadHistory(); });
  $('hist-next').addEventListener('click', () => { histYM = shiftYM(histYM, 1); loadHistory(); });
  $('done-home-btn').addEventListener('click', enterHome);
}

async function doPinLogin() {
  const pin = $('pin-entry-code').value.trim();
  if (!pin) { setErr('pin-entry-error', '暗証番号を入力してください。'); return; }
  setErr('pin-entry-error', '');
  try {
    const r = await rpc('subcontractor_verify_pin', { p_login_code: loginCode, p_pin: pin });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('ログインに失敗しました。');
    deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    $('pin-entry-code').value = '';
    enterHome();
  } catch (e) {
    setErr('pin-entry-error', e.message || 'ログインに失敗しました。初回の方は下の「初回の方」からご登録ください。');
  }
}

// 会社選択肢を(認証不要で)読み込む
async function loadCompanyOptions(selectId) {
  try {
    const opts = await rpc('list_subcontractor_companies_public', {});
    $(selectId).innerHTML = '<option value="">選択してください</option>' + (opts || []).map((c) => `<option value="${c.company_id}">${escapeHtml(c.company_name)}</option>`).join('');
  } catch (e) { $(selectId).innerHTML = '<option value="">(会社一覧を取得できませんでした)</option>'; }
}
async function openRegister() {
  setErr('register-error', ''); showScreen('register');
  await loadCompanyOptions('reg-company');
}
async function openRelink() {
  setErr('relink-error', ''); showScreen('relink');
  await loadCompanyOptions('relink-company');
}

// 外注 自己登録(ID自動採番)。登録完了で loginCode/token を端末保持し、次回は暗証番号だけで再ログイン。
async function doSelfRegister() {
  setErr('register-error', '');
  const companyId = $('reg-company').value;
  const name = $('reg-name').value.trim();
  const phone = $('reg-phone').value.trim();
  const pin = $('reg-pin').value.trim();
  const pin2 = $('reg-pin2').value.trim();
  if (!companyId) { setErr('register-error', '所属する外注会社を選んでください。'); return; }
  if (!name) { setErr('register-error', '氏名を入力してください。'); return; }
  if (!phone) { setErr('register-error', '電話番号を入力してください。'); return; }
  if (!pin || pin.length < 4) { setErr('register-error', '暗証番号は4〜6桁で決めてください。'); return; }
  if (pin !== pin2) { setErr('register-error', '暗証番号(確認)が一致しません。'); return; }
  // 登録そのもの(通信・RPC)の成否と、登録後の画面遷移の成否を必ず分ける。
  // 以前は enterHome()/openProfile() まで同じ try に入っていたため、登録が成功した後に
  // 画面側で例外が起きると「登録に失敗しました」と表示され、実際にはDBに登録済みという
  // 食い違いが起きうる状態だった(2026-09-05)。
  let row = null;
  try {
    const r = await rpc('subcontractor_self_register', { p_company_id: Number(companyId), p_worker_name: name, p_pin: pin, p_furigana: $('reg-furigana').value.trim() || null, p_phone: phone });
    row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('登録に失敗しました。もう一度お試しください。');
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : '';
    // 既に登録済みの場合は行き止まりにせず、暗証番号でのログインへその場で誘導する。
    if (/既に登録があります|already/i.test(msg)) {
      openRecover({ companyId, name, notice: 'すでに登録があります。暗証番号でログインしてください。' });
      return;
    }
    setErr('register-error', msg || '登録に失敗しました。');
    return;
  }

  loginCode = row.out_login_code;
  deviceToken = row.out_device_token;
  currentWorker = { name: row.out_worker_name, company: row.out_company_name };
  saveAuth();
  ['reg-name', 'reg-furigana', 'reg-phone', 'reg-pin', 'reg-pin2'].forEach((id) => { const el = $(id); if (el) el.value = ''; });

  // 登録できたことをはっきり見せる。画面側で何かあっても登録の成功は取り消さない。
  try {
    $('registered-name').textContent = (currentWorker.name || '') + ' さん（' + (currentWorker.company || '') + '）';
    $('registered-login-code').textContent = loginCode || '-';
    showScreen('registered');
  } catch (e) {
    try { enterHome(); } catch (e2) { /* ホームも描けない場合でも登録済みの事実は保持する */ }
  }
}

// 登録済みの方の復帰。作業員IDを知らなくても 会社+氏名+暗証番号 で戻れる。
async function openRecover(prefill) {
  setErr('recover-error', (prefill && prefill.notice) || '');
  const phoneWrap = $('rec-phone-wrap');
  if (phoneWrap) phoneWrap.style.display = 'none';
  // 氏名は会社一覧の取得を待たずに先に入れる(利用者がすぐ操作を始めても消えないように)。
  if (prefill && prefill.name) $('rec-name').value = prefill.name;
  showScreen('recover');
  await loadCompanyOptions('rec-company');
  // 会社は選択肢が揃ってからでないと選べない。取得後に改めて選択する。
  if (prefill && prefill.companyId) $('rec-company').value = String(prefill.companyId);
}

async function doRecover() {
  const companyId = $('rec-company').value;
  const name = $('rec-name').value.trim();
  const pin = $('rec-pin').value.trim();
  const phone = $('rec-phone').value.trim();
  if (!companyId) { setErr('recover-error', '所属する外注会社を選んでください。'); return; }
  if (!name) { setErr('recover-error', '氏名を入力してください。'); return; }
  if (!pin) { setErr('recover-error', '暗証番号を入力してください。'); return; }
  setErr('recover-error', '');
  try {
    const r = await rpc('subcontractor_recover_device', {
      p_company_id: Number(companyId), p_worker_name: name, p_pin: pin, p_phone: phone || null,
    });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('ログインに失敗しました。');
    loginCode = row.out_login_code; deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    ['rec-name', 'rec-pin', 'rec-phone'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    enterHome();
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : '';
    // 同姓同名が複数いる場合だけ電話番号を追加で尋ねる。
    if (/電話番号も入力してください/.test(msg)) {
      const wrap = $('rec-phone-wrap');
      if (wrap) wrap.style.display = 'block';
    }
    setErr('recover-error', msg || 'ログインに失敗しました。');
  }
}

// 機種変更/別端末: 会社+氏名+電話+暗証番号で本人再確認 → 既存IDへ端末再紐付け(新規作成しない)。
async function doRelink() {
  setErr('relink-error', '');
  const companyId = $('relink-company').value;
  const name = $('relink-name').value.trim();
  const phone = $('relink-phone').value.trim();
  const pin = $('relink-pin').value.trim();
  if (!companyId || !name || !phone || !pin) { setErr('relink-error', '会社・氏名・電話番号・暗証番号をすべて入力してください。'); return; }
  try {
    const r = await rpc('subcontractor_relink_device', { p_company_id: Number(companyId), p_worker_name: name, p_phone: phone, p_pin: pin });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('本人確認に失敗しました。');
    loginCode = row.out_login_code; deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    ['relink-name', 'relink-phone', 'relink-pin'].forEach((id) => { $(id).value = ''; });
    enterHome();
  } catch (e) { setErr('relink-error', e.message || '本人確認に失敗しました。'); }
}

// パターンB(会社が先に登録): 作業員ID(login_code) + 初回登録コードで本人確認し、本人が暗証番号を設定。
// 既存の subcontractor_first_login RPC を再利用。QRから開いた場合は login_code/code を事前入力する。
function openFirstLogin(prefill) {
  setErr('first-login-error', '');
  if (prefill) {
    if (prefill.loginCode) $('fl-login-code').value = prefill.loginCode;
    if (prefill.code) $('fl-code').value = prefill.code;
  }
  showScreen('first-login');
}

async function doFirstLogin() {
  setErr('first-login-error', '');
  const lc = $('fl-login-code').value.trim();
  const code = $('fl-code').value.trim();
  const pin = $('fl-pin').value.trim();
  const pin2 = $('fl-pin2').value.trim();
  if (!lc) { setErr('first-login-error', '作業員IDを入力してください。'); return; }
  if (!/^\d{6}$/.test(code)) { setErr('first-login-error', '初回登録コード(6桁)を入力してください。'); return; }
  if (!pin || pin.length < 4) { setErr('first-login-error', '暗証番号は4〜6桁で決めてください。'); return; }
  if (pin !== pin2) { setErr('first-login-error', '暗証番号(確認)が一致しません。'); return; }
  try {
    const r = await rpc('subcontractor_first_login', { p_login_code: lc, p_code: code, p_pin: pin });
    const row = Array.isArray(r) ? r[0] : r;
    if (!row || !row.out_device_token) throw new Error('初回登録に失敗しました。');
    loginCode = lc; deviceToken = row.out_device_token;
    currentWorker = { name: row.out_worker_name, company: row.out_company_name };
    saveAuth();
    ['fl-login-code', 'fl-code', 'fl-pin', 'fl-pin2'].forEach((id) => { $(id).value = ''; });
    // QRのパラメータをURLから消す(戻る/再読込でコードが残らないように)。
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    enterHome();
    openProfile();
  } catch (e) { setErr('first-login-error', e.message || '初回登録に失敗しました。IDとコードをご確認ください。'); }
}

function doLogout() {
  rpc('subcontractor_logout', { p_login_code: loginCode }).catch(() => {});
  clearAuth();
  showScreen('welcome');
}

function enterHome() {
  $('home-worker-name').textContent = (currentWorker && currentWorker.name) || '';
  $('home-company-name').textContent = (currentWorker && currentWorker.company) ? '所属: ' + currentWorker.company : '';
  showScreen('home');
  loadRecent();
}

const WT_JP = { '終日': '終日', '午前': '午前', '午後': '午後' };
function mdLabel(dateStr) { const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[2])}/${Number(m[3])}` : String(dateStr); }
async function loadRecent() {
  // ホームの「最近の提出」: 直近の提出を数件プレビュー + 「出勤履歴をすべて見る」。
  try {
    const now = todayJST();
    const y = Number(now.slice(0, 4)), mo = Number(now.slice(5, 7));
    let rows = [];
    try { rows = (await rpc('get_my_subcontractor_attendance_month', { p_login_code: loginCode, p_year: y, p_month: mo })) || []; } catch (e) { rows = []; }
    // 先月分も少し補完(月初など今月が少ない場合)
    if (rows.length < 3) {
      const pm = mo === 1 ? 12 : mo - 1, py = mo === 1 ? y - 1 : y;
      try { const prev = (await rpc('get_my_subcontractor_attendance_month', { p_login_code: loginCode, p_year: py, p_month: pm })) || []; rows = rows.concat(prev); } catch (e) {}
    }
    $('home-recent-wrap').style.display = 'block';
    if (rows.length) {
      const top = rows.slice(0, 4);
      $('home-recent-list').innerHTML = top.map((x) => `<div class="recent-item">${mdLabel(x.report_date)}　${escapeHtml(x.site_name || '(現場未設定)')}　${escapeHtml(WT_JP[x.work_type] || x.work_type || '')}${x.reflected ? '<span class="chip">反映済</span>' : ''}</div>`).join('');
    } else {
      $('home-recent-list').innerHTML = '<div class="hint">まだ提出がありません。</div>';
    }
  } catch (e) { $('home-recent-wrap').style.display = 'none'; }
}

// ===== 出勤履歴(月単位・本人のみ) =====
let histYM = null; // {y, m}
function shiftYM(ym, delta) { let y = ym.y, m = ym.m + delta; while (m < 1) { m += 12; y -= 1; } while (m > 12) { m -= 12; y += 1; } return { y, m }; }
function openHistory() {
  const now = todayJST();
  histYM = { y: Number(now.slice(0, 4)), m: Number(now.slice(5, 7)) };
  showScreen('history');
  loadHistory();
}
async function loadHistory() {
  $('hist-month').textContent = `${histYM.y}年${histYM.m}月`;
  $('hist-list').innerHTML = '<div class="hint">読み込み中...</div>';
  let rows = [];
  try { rows = (await rpc('get_my_subcontractor_attendance_month', { p_login_code: loginCode, p_year: histYM.y, p_month: histYM.m })) || []; } catch (e) { $('hist-list').innerHTML = '<div class="hint">読み込みに失敗しました。</div>'; return; }
  // 統計: 出勤日数(distinct date) / 合計人工(sum headcount) / 残業合計(sum overtime)
  const days = new Set(rows.map((r) => r.report_date)).size;
  const manDays = rows.reduce((s, r) => s + (Number(r.headcount) || 0), 0);
  const ot = rows.reduce((s, r) => s + (Number(r.overtime_hours) || 0), 0);
  $('hist-days').textContent = days + '日';
  $('hist-mandays').textContent = (String(manDays).replace(/\.?0+$/, '') || '0') + '人工';
  $('hist-overtime').textContent = (String(ot).replace(/\.?0+$/, '') || '0') + 'h';
  // 日単位にまとめる(2現場は1日にまとめて表示)
  const byDate = {};
  rows.forEach((r) => { (byDate[r.report_date] = byDate[r.report_date] || []).push(r); });
  const dates = Object.keys(byDate).sort().reverse();
  if (!dates.length) { $('hist-list').innerHTML = '<div class="hint">この月の提出はありません。</div>'; return; }
  $('hist-list').innerHTML = dates.map((d) => {
    const es = byDate[d];
    const sites = es.map((e) => `${escapeHtml(e.site_name || '(現場)')} ${escapeHtml(WT_JP[e.work_type] || '')} ${String(Number(e.headcount)).replace(/\.?0+$/, '') || e.headcount}人工`).join(' / ');
    const needsRev = es.some((e) => e.needs_review);
    return `<button type="button" class="recent-item hist-day" data-date="${d}" style="width:100%;text-align:left;display:block;">
      <div style="font-weight:700;">${mdLabel(d)}${needsRev ? ' <span class="chip" style="background:#e0a021;color:#fff;">要確認</span>' : ''}</div>
      <div style="font-size:.9rem;color:#5b6b8a;">${sites}</div>
    </button>`;
  }).join('');
  $('hist-list').querySelectorAll('.hist-day').forEach((b) => b.addEventListener('click', () => openAttDetail(b.dataset.date)));
}

// ===== 出勤報告 詳細(訂正/取消) =====
let detailDate = null;
async function openAttDetail(dateStr) {
  detailDate = dateStr;
  showScreen('att-detail');
  $('detail-date').textContent = formatJpDate(dateStr) + ' の出勤報告';
  $('detail-status').textContent = '';
  $('detail-entries').innerHTML = '<div class="hint">読み込み中...</div>';
  let rows = [];
  try { rows = (await rpc('get_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: dateStr })) || []; } catch (e) {}
  if (!rows.length) { $('detail-entries').innerHTML = '<div class="hint">この日の有効な提出はありません。</div>'; $('detail-edit-btn').style.display = 'none'; $('detail-cancel-btn').style.display = 'none'; return; }
  $('detail-edit-btn').style.display = ''; $('detail-cancel-btn').style.display = '';
  const anyReview = rows.some((r) => r.needs_review);
  const anyConfirmed = rows.every((r) => r.report_status === 'confirmed');
  $('detail-status').innerHTML = anyConfirmed ? '<span class="chip" style="background:#dcfce7;color:#166534;">確認済み</span>' : anyReview ? '<span class="chip" style="background:#e0a021;color:#fff;">要確認</span>' : '<span class="chip" style="background:#dbeafe;color:#1d4ed8;">提出済み</span>';
  $('detail-entries').innerHTML = rows.map((r, i) => `
    <div class="card" style="margin:8px 0;padding:12px;">
      <div style="font-weight:700;margin-bottom:6px;">現場${(r.entry_slot || i + 1)}</div>
      <div class="recent-item">現場：${escapeHtml(r.site_name || '(未設定)')}</div>
      <div class="recent-item">勤務区分：${escapeHtml(WT_JP[r.work_type] || r.work_type || '')}</div>
      <div class="recent-item">人工：${String(Number(r.headcount)).replace(/\.?0+$/, '') || r.headcount}</div>
      <div class="recent-item">残業：${Number(r.overtime_hours || 0)}h</div>
      <div class="recent-item">夜勤：${r.is_night_shift ? 'あり' : 'なし'}</div>
      <div class="recent-item">出張：${r.is_business_trip ? 'あり' : 'なし'}</div>
      ${r.notes ? `<div class="recent-item">備考：${escapeHtml(r.notes)}</div>` : ''}
    </div>`).join('');
  $('detail-edit-btn').onclick = () => openAttendance(dateStr, 'history');
  $('detail-cancel-btn').onclick = async () => {
    if (!confirm('この日の出勤報告を取り消します。よろしいですか?\n(取消後、同じ日をもう一度登録できます)')) return;
    try {
      await rpc('cancel_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: dateStr });
      await loadHistory();
      showScreen('history');
    } catch (e) { alert(friendlyError(e, '取消に失敗しました。もう一度お試しください。')); }
  };
}
function formatJpDate(dateStr) { const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return String(dateStr); return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`; }

// ②③④ プロフィール
async function openProfile() {
  showScreen('profile');
  setErr('profile-error', '');
  try {
    const r = await rpc('get_my_subcontractor_profile', { p_login_code: loginCode });
    const p = Array.isArray(r) ? r[0] : r;
    if (!p) return;
    $('pf-name').value = p.worker_name || '';
    $('pf-furigana').value = p.furigana || '';
    $('pf-birth').value = p.birth_date || '';
    $('pf-phone').value = p.phone || '';
    $('pf-address').value = p.address || '';
    $('pf-blood').value = p.blood_type || '';
    $('pf-ec-name').value = p.emergency_contact_name || '';
    $('pf-ec-rel').value = p.emergency_contact_relation || '';
    $('pf-ec-phone').value = p.emergency_contact_phone || '';
    // 必須未入力(既存データが空の場合)は破壊的補完せず、開いた時に入力を促す(仕様1)
    const missing = !(p.worker_name) || !(p.phone) || !(p.blood_type) || !(p.emergency_contact_name) || !(p.emergency_contact_relation) || !(p.emergency_contact_phone);
    const notice = $('pf-required-notice'); if (notice) notice.style.display = missing ? 'block' : 'none';
    // ④⑤ 資格・健診(複数・共通マスター)。資格はマスター選択式。
    await loadQualMaster();
    await loadQualifications();
    await loadHealthCheckups();
    // ③ 会社
    if (p.company_locked) {
      $('pf-company-locked').style.display = 'block';
      $('pf-company-select-wrap').style.display = 'none';
      $('pf-company-name').textContent = p.company_name || '(未設定)';
    } else {
      $('pf-company-locked').style.display = 'none';
      $('pf-company-select-wrap').style.display = 'block';
      const opts = await rpc('get_subcontractor_company_options', { p_login_code: loginCode });
      $('pf-company-select').innerHTML = '<option value="">選択してください</option>' + (opts || []).map((c) => `<option value="${c.company_id}">${escapeHtml(c.company_name)}</option>`).join('');
    }
  } catch (e) { setErr('profile-error', e.message || '読み込みに失敗しました。'); }
}

async function saveProfile() {
  setErr('profile-error', '');
  // 必須: 氏名・電話・血液型・緊急連絡先(氏名・続柄・電話)。未入力は保存不可(仕様1)。
  const blood = $('pf-blood').value.trim(), ecName = $('pf-ec-name').value.trim(), ecRel = $('pf-ec-rel').value.trim(), ecPhone = $('pf-ec-phone').value.trim();
  const name = $('pf-name').value.trim(), phone = $('pf-phone').value.trim();
  const missing = !name || !phone || !blood || !ecName || !ecRel || !ecPhone;
  const notice = $('pf-required-notice'); if (notice) notice.style.display = missing ? 'block' : 'none';
  if (missing) { setErr('profile-error', '必須項目(氏名・電話・血液型・緊急連絡先の氏名/続柄/電話)をすべて入力してください。'); return; }
  const params = {
    p_login_code: loginCode,
    p_worker_name: name || null,
    p_furigana: $('pf-furigana').value.trim() || null,
    p_birth_date: $('pf-birth').value || null,
    p_phone: phone || null,
    p_address: $('pf-address').value.trim() || null,
    p_blood_type: blood || null,
    p_emergency_contact_name: ecName || null,
    p_emergency_contact_relation: ecRel || null,
    p_emergency_contact_phone: ecPhone || null,
  };
  if ($('pf-company-select-wrap').style.display !== 'none') {
    const cv = $('pf-company-select').value;
    if (cv) params.p_company_id = Number(cv);
  }
  try {
    const r = await rpc('update_my_subcontractor_profile', params);
    const row = Array.isArray(r) ? r[0] : r;
    if (row && row.company_name) currentWorker.company = row.company_name;
    if (params.p_worker_name) currentWorker.name = params.p_worker_name;
    $('done-title').textContent = '個人情報を保存しました';
    $('done-sub').textContent = '';
    showScreen('done');
  } catch (e) { setErr('profile-error', e.message || '保存に失敗しました。'); }
}

// ④ 資格(複数・専用マスター employee_qualifications を共通利用)
async function loadQualifications() {
  try {
    const rows = await rpc('get_my_subcontractor_qualifications', { p_login_code: loginCode });
    const list = $('pf-qual-list'); const empty = $('pf-qual-empty');
    if (!rows || !rows.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = rows.map((q) => `<div class="recent-item" data-qname="${escapeHtml(q.qualification_name)}">${escapeHtml(q.qualification_name)}${q.qualification_number ? '（' + escapeHtml(q.qualification_number) + '）' : ''}${q.expiry_date ? '<span class="chip">期限 ' + q.expiry_date + '</span>' : ''} <button type="button" class="qual-del" data-id="${q.id}" style="float:right;background:none;color:var(--danger);width:auto;margin:0;padding:0 6px;">削除</button></div>`).join('');
    list.querySelectorAll('.qual-del').forEach((b) => b.addEventListener('click', async () => { await rpc('delete_my_subcontractor_qualification', { p_login_code: loginCode, p_id: Number(b.dataset.id) }).catch(() => {}); loadQualifications(); }));
  } catch (e) { $('pf-qual-list').innerHTML = ''; }
}
// 資格マスターをカテゴリ別(optgroup)に読み込み、選択式にする(自由入力ではなくマスター選択・仕様2/3)
async function loadQualMaster() {
  try {
    const rows = await rpc('list_qualification_master', { p_login_code: loginCode });
    const sel = $('pf-qual-select');
    const cats = {};
    (rows || []).forEach((r) => { (cats[r.category] = cats[r.category] || []).push(r); });
    let html = '<option value="">選択してください</option>';
    Object.keys(cats).forEach((cat) => {
      // 免許は license_types_master 由来(license_type_id、idはnull)。資格は qualification_master 由来(id)。
      // 二重管理しないため、免許は共通の免許マスターから来る。値は免許なら "lic:<id>"、資格なら master id。
      html += `<optgroup label="${escapeHtml(cat)}">` + cats[cat].map((r) => {
        const v = (r.license_type_id != null) ? ('lic:' + r.license_type_id) : String(r.id);
        return `<option value="${v}" data-name="${escapeHtml(r.qualification_name)}">${escapeHtml(r.qualification_name)}</option>`;
      }).join('') + '</optgroup>';
    });
    // 最後に「その他（自由記入）」。選ぶと自由入力欄を出す。
    html += '<option value="__other__">その他（自由記入）</option>';
    sel.innerHTML = html;
    sel.onchange = () => { $('pf-qual-other-wrap').style.display = (sel.value === '__other__') ? 'block' : 'none'; };
  } catch (e) { $('pf-qual-select').innerHTML = '<option value="">(資格一覧を取得できませんでした)</option>'; }
}
async function addQualification() {
  setErr('qual-error', '');
  const sel = $('pf-qual-select');
  const val = sel.value;
  if (!val) { setErr('qual-error', '持っている資格を一覧から選んでください。'); return; }
  // 既に登録済みの資格名は重複警告(その他/マスターとも)。
  const existingNames = Array.from(document.querySelectorAll('#pf-qual-list .recent-item')).map((el) => (el.dataset.qname || '').trim());
  const targetName = (val === '__other__') ? $('pf-qual-other').value.trim() : (sel.options[sel.selectedIndex].dataset.name || '').trim();
  if (val === '__other__' && !targetName) { setErr('qual-error', '資格・免許名を入力してください。'); return; }
  if (targetName && existingNames.includes(targetName)) { setErr('qual-error', `「${targetName}」は既に登録済みです（重複登録はできません）。`); return; }
  try {
    if (val === '__other__') {
      await rpc('submit_my_subcontractor_qualification', { p_login_code: loginCode, p_qualification_name: targetName });
      $('pf-qual-other').value = '';
    } else if (val.startsWith('lic:')) {
      // 免許(共通の免許マスター license_types_master 由来)
      await rpc('submit_my_subcontractor_qualification_selected', { p_login_code: loginCode, p_license_type_id: Number(val.slice(4)) });
    } else {
      await rpc('submit_my_subcontractor_qualification_selected', { p_login_code: loginCode, p_master_id: Number(val) });
    }
    sel.value = ''; $('pf-qual-other-wrap').style.display = 'none';
    await loadQualifications();
  } catch (e) { setErr('qual-error', e.message || '資格の追加に失敗しました。'); }
}
// ⑤ 健康診断(専用マスター employee_health_checkups を共通利用)
async function loadHealthCheckups() {
  try {
    const rows = await rpc('get_my_subcontractor_health_checkups', { p_login_code: loginCode });
    const list = $('pf-health-list'); const empty = $('pf-health-empty');
    if (!rows || !rows.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = rows.map((h) => `<div class="recent-item">実施 ${h.checkup_date}${h.next_due_date ? '<span class="chip">次回 ' + h.next_due_date + '</span>' : ''}</div>`).join('');
  } catch (e) { $('pf-health-list').innerHTML = ''; }
}
async function addHealthCheckup() {
  setErr('health-error', '');
  const d = $('pf-health-date').value;
  if (!d) { setErr('health-error', '健康診断の実施日を入力してください。'); return; }
  try {
    await rpc('submit_my_subcontractor_health_checkup', { p_login_code: loginCode, p_checkup_date: d, p_next_due_date: $('pf-health-next').value || null });
    $('pf-health-date').value = ''; $('pf-health-next').value = '';
    await loadHealthCheckups();
  } catch (e) { setErr('health-error', e.message || '健康診断の追加に失敗しました。'); }
}

// ⑤〜⑨ 出面(1日最大2現場)
let attSiteOptionsHtml = '';
function updateAttTotal() {
  let total = 0;
  document.querySelectorAll('#att-blocks .att-site-block').forEach((b) => { total += Number(b.querySelector('.ab-headcount').value) || 0; });
  const el = $('att-total');
  if (el) {
    const t = total.toFixed(2).replace(/\.?0+$/, '') || '0';
    const isQuarter = Math.abs(total / 0.25 - Math.round(total / 0.25)) < 1e-9;
    el.textContent = '合計人工 ' + t + (total > 1 + 1e-9 || !isQuarter ? '（ご確認ください: 通常は合計1.0以内・0.25単位です）' : '');
    el.style.color = (total > 1 + 1e-9 || !isQuarter) ? 'var(--danger,#d9534f)' : '';
  }
  const addBtn = $('att-add-site-btn');
  const n = document.querySelectorAll('#att-blocks .att-site-block').length;
  if (addBtn) addBtn.style.display = n >= 2 ? 'none' : '';
}
function addAttBlock(prefill) {
  const list = $('att-blocks');
  if (list.querySelectorAll('.att-site-block').length >= 2) return null;
  const tpl = $('att-block-template');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const siteSel = node.querySelector('.ab-site');
  siteSel.innerHTML = attSiteOptionsHtml;
  const newWrap = node.querySelector('.ab-newsite-wrap');
  siteSel.addEventListener('change', () => { newWrap.style.display = (siteSel.value === '__new__') ? 'block' : 'none'; });
  const wt = node.querySelector('.ab-worktype');
  const hc = node.querySelector('.ab-headcount');
  wt.addEventListener('change', () => { hc.value = (wt.value === '終日') ? '1.0' : '0.5'; updateAttTotal(); });
  hc.addEventListener('change', updateAttTotal);
  node.querySelector('.ab-remove-btn').addEventListener('click', () => { node.remove(); renumberAttBlocks(); updateAttTotal(); });
  if (prefill) {
    if (prefill.site_id) siteSel.value = String(prefill.site_id);
    if (prefill.work_type) wt.value = prefill.work_type;
    if (prefill.headcount != null) hc.value = String(Number(prefill.headcount));
    if (prefill.overtime_hours != null) node.querySelector('.ab-overtime').value = prefill.overtime_hours;
    if (prefill.is_night_shift) node.querySelector('.ab-night').checked = true;
    if (prefill.is_business_trip) node.querySelector('.ab-trip').checked = true;
    if (prefill.notes) node.querySelector('.ab-notes').value = prefill.notes;
  }
  list.appendChild(node);
  renumberAttBlocks();
  updateAttTotal();
  return node;
}
function renumberAttBlocks() {
  const blocks = document.querySelectorAll('#att-blocks .att-site-block');
  blocks.forEach((b, i) => {
    b.querySelector('.att-block-title').textContent = '現場' + (i + 1);
    b.querySelector('.ab-remove-btn').style.display = (i === 0) ? 'none' : '';
  });
}
let attTargetDate = null; // 訂正時は対象日を指定(nullなら当日)
let attOrigin = 'home';   // 提出完了後の戻り先(home / history)
async function openAttendance(targetDate, origin) {
  attTargetDate = targetDate || todayJST();
  attOrigin = origin || 'home';
  showScreen('attendance');
  setErr('att-error', '');
  const d = attTargetDate;
  const isToday = (d === todayJST());
  $('att-date').textContent = d + (isToday ? ' の日報' : ' の日報（訂正）');
  // ⑤ 現場候補: 正式な現場マスター(配置カレンダー→最近→有効現場マスターの優先順)。カテゴリタグは出さない。
  let sites = [];
  try {
    const cand = await rpc('get_my_subcontractor_site_candidates', { p_login_code: loginCode, p_date: d });
    sites = (cand || []).filter((a) => a.site_id).map((a) => ({ id: a.site_id, label: (a.site_name || '(現場)') + (a.source === '配置' ? '（本日の配置）' : a.source === '最近' ? '（最近）' : '') }));
  } catch (e) {}
  const seen = {}; sites = sites.filter((s) => (seen[s.id] ? false : (seen[s.id] = true)));
  const opts = sites.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('');
  attSiteOptionsHtml = (opts || '') + '<option value="__new__">その他(一覧にない現場を入力)</option>';
  // ブロックを初期化(1現場)。既存登録があればそれで復元。
  $('att-blocks').innerHTML = '';
  let existing = [];
  try { existing = (await rpc('get_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: d })) || []; } catch (e) {}
  if (existing.length) {
    existing.slice(0, 2).forEach((x) => addAttBlock({ site_id: x.site_id, work_type: x.work_type, headcount: x.headcount, overtime_hours: x.overtime_hours, is_night_shift: x.is_night_shift, is_business_trip: x.is_business_trip, notes: x.notes }));
  } else {
    addAttBlock();
  }
  if (!sites.length) { const b0 = document.querySelector('#att-blocks .att-site-block'); if (b0) { b0.querySelector('.ab-site').value = '__new__'; b0.querySelector('.ab-newsite-wrap').style.display = 'block'; } }
  loadTodayAttendance(d);
}

async function loadTodayAttendance(d) {
  try {
    const r = await rpc('get_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: d });
    const rows = r || [];
    if (rows.length) {
      $('att-existing-wrap').style.display = 'block';
      $('att-existing-list').innerHTML = rows.map((x) => `<div class="recent-item">${escapeHtml(x.site_name || '(現場未設定)')}｜${escapeHtml(x.work_type || '')}｜残業${x.overtime_hours || 0}h${x.is_night_shift ? '｜夜勤' : ''}${x.reflected ? '<span class="chip">反映済</span>' : ''}</div>`).join('');
    } else { $('att-existing-wrap').style.display = 'none'; }
  } catch (e) { $('att-existing-wrap').style.display = 'none'; }
}

async function submitAttendance() {
  setErr('att-error', '');
  const blocks = Array.from(document.querySelectorAll('#att-blocks .att-site-block'));
  if (!blocks.length) { setErr('att-error', '現場を入力してください。'); return; }
  const entries = [];
  let totalHc = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const workType = b.querySelector('.ab-worktype').value;
    const siteVal = b.querySelector('.ab-site').value;
    const entry = { work_type: workType, overtime_hours: Number(b.querySelector('.ab-overtime').value || 0), is_night_shift: b.querySelector('.ab-night').checked, is_business_trip: b.querySelector('.ab-trip').checked, notes: b.querySelector('.ab-notes').value.trim() || null };
    if (siteVal === '__new__') {
      const nm = b.querySelector('.ab-newsite').value.trim();
      if (!nm) { setErr('att-error', `現場${i + 1}の現場名を入力してください。`); return; }
      entry.new_site_name = nm;
    } else if (siteVal) {
      entry.site_id = Number(siteVal);
    } else { setErr('att-error', `現場${i + 1}を選択してください。`); return; }
    const hc = Number(b.querySelector('.ab-headcount').value);
    if (!(hc > 0)) { setErr('att-error', `現場${i + 1}の人工を入力してください。`); return; }
    entry.headcount = hc;
    totalHc += hc;
    entries.push(entry);
  }
  const target = attTargetDate || todayJST();
  const isCorrection = (attOrigin === 'history') || (target !== todayJST());
  try {
    await rpc('submit_my_subcontractor_attendance', { p_login_code: loginCode, p_report_date: target, p_entries: entries });
    if (isCorrection) {
      // 訂正時は履歴へ戻して最新を表示(管理側・照合にも即時反映される)。
      await loadHistory();
      showScreen('history');
      return;
    }
    $('done-title').textContent = '日報を登録しました';
    $('done-sub').textContent = `${entries.length}現場｜合計${String(totalHc).replace(/\.?0+$/, '') || totalHc}人工`;
    showScreen('done');
  } catch (e) { setErr('att-error', friendlyError(e, '登録に失敗しました。もう一度お試しください。')); }
}

// DBの内部エラー文(例: column reference ... is ambiguous / relation ... / syntax error)を
// そのまま利用者へ見せない。意図的な日本語メッセージ(現場を選択してください 等)はそのまま表示。
// 技術的なエラーは汎用文言にし、詳細はconsole経由でerror log(client-error-reporter)へ残す。
function friendlyError(e, fallback) {
  const msg = (e && e.message) ? String(e.message) : '';
  try { console.error('[submit error]', msg); } catch (_) {}
  const technical = /ambiguous|column|relation|function|syntax|SQLSTATE|null value|constraint|permission denied|duplicate key|does not exist|PGRST|42\d\d\d|22\d\d\d|23\d\d\d/i.test(msg);
  const hasJa = /[぀-ヿ぀-ゟ゠-ヿ一-鿿]/.test(msg);
  return (msg && hasJa && !technical) ? msg : (fallback || '処理に失敗しました。もう一度お試しください。');
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Service Worker(収束保険つき)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const hadController = !!navigator.serviceWorker.controller;
      const check = () => { try { reg.update(); } catch (e) {} };
      setInterval(check, 15 * 60 * 1000);
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) nw.postMessage({ type: 'SKIP_WAITING' });
        });
      });
      // 初回インストール時はreloadしない(無限reload防止)。以後の切替でのみ1回だけreload。
      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (refreshed) return; refreshed = true;
        window.location.reload();
      });
    }).catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', boot);
