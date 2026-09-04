'use strict';

/* 配置カレンダー専用URLの起動処理
 *
 * ■ この画面の位置づけ
 *   社員ポータル(../index.html)の中からも配置カレンダーは開けるが、それとは別に
 *   「スマホのホーム画面から配置カレンダーだけを直接開く」ための入口がこのページ。
 *   表示するカレンダー本体は ../assignment-calendar.js とまったく同じもので、
 *   同じRPC・同じ配置データを見る(カレンダーを2つ作らない)。
 *
 * ■ ログインを2回させない仕組み
 *   端末の認証情報(端末トークン)は localStorage の 'jinshou_device_auth' に入っている。
 *   社員ポータルとこのページは同じオリジン(shota-1003.github.io)にあるため、
 *   localStorage はそのまま共有される。つまり社員ポータルで一度ログインしていれば、
 *   このページは何も聞かずに同じ社員として開く。
 *   逆に、このページで先にログインが必要になった場合は社員ポータルのログイン画面へ送り、
 *   終わったらこのページへ戻す(?next=calendar)。認証もマスターもポータル側の1本のまま。
 *
 * ■ ここに認証の実装を持たせない
 *   暗証番号の入力・初回登録・端末承認待ちの案内は、すべて社員ポータル側にある画面を使う。
 *   同じ画面をこちらにも作ると、片方だけ直し忘れる事故が起きるため。
 */

// デプロイ時に scripts/deploy-employee-portal-staging.js /
// promote-employee-portal-to-production.js が書き換える(app.js と同じ書式にしてある)。
const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
const IS_STAGING = true;

const DEVICE_AUTH_KEY = 'jinshou_device_auth'; // 社員ポータルと同じキー(共通の端末認証)
const PORTAL_URL = '../index.html';
// ホームウィジェットから「この日を開いて」と渡されたときに一時的に覚えておく場所。
// ログインを挟むとURLのクエリが消えるため、同一オリジンのsessionStorageで受け渡す。
const WANT_DATE_KEY = 'jinshou_calendar_want_date';

let currentDeviceToken = null;

// ?date=YYYY-MM-DD を取り出す。形式が違うものは無視する(不正な値で画面を壊さない)。
function wantedDate() {
    let d = null;
    try {
        d = new URLSearchParams(location.search).get('date');
        if (!d) d = sessionStorage.getItem(WANT_DATE_KEY);
    } catch (e) { return null; }
    return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null;
}

function consumeWantedDate() {
    const d = wantedDate();
    try { sessionStorage.removeItem(WANT_DATE_KEY); } catch (e) { /* 消せなくても表示はできる */ }
    return d;
}

function getDeviceAuth() {
    try { return JSON.parse(localStorage.getItem(DEVICE_AUTH_KEY)); } catch (e) { return null; }
}

// 社員ポータルの rpc() と同じ経路・同じヘッダーで呼ぶ。
async function rpc(name, params) {
    const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
    };
    if (currentDeviceToken) headers['X-Device-Token'] = currentDeviceToken;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST', headers, body: JSON.stringify(params || {}),
    });
    const text = await res.text();
    if (!res.ok) {
        let message = `通信エラー(${res.status})`;
        try { const p = JSON.parse(text); if (p && p.message) message = p.message; } catch (e) { /* JSONでなければそのまま */ }
        // 端末が無効化された・退職/利用停止になった等でセッションが切れた場合は、
        // このページで粘らずに社員ポータルのログイン画面へ送る(認証画面は1か所だけ)。
        if (message === 'セッションが確認できませんでした。再度ログインしてください'
            || message === 'このアカウントは現在ご利用いただけません') {
            showNeedLogin(message);
        }
        throw new Error(message);
    }
    return text ? JSON.parse(text) : null;
}

function show(id) {
    for (const el of document.querySelectorAll('[data-boot-screen]')) {
        el.style.display = (el.id === id) ? '' : 'none';
    }
}

function showNeedLogin(message) {
    const msgEl = document.getElementById('boot-login-message');
    if (msgEl && message) msgEl.textContent = message;
    show('boot-login');
}

function goPortalLogin() {
    // ログインが終わったらこのページへ戻ってくる(app.js側が ?next=calendar を見て戻す)。
    // 開きたい日付は戻り先URLに乗らないので、こちら側で預かっておく。
    const d = wantedDate();
    if (d) { try { sessionStorage.setItem(WANT_DATE_KEY, d); } catch (e) { /* 覚えられなくてもログインは進む */ } }
    location.href = `${PORTAL_URL}?next=calendar`;
}

async function start() {
    document.getElementById('boot-login-btn').addEventListener('click', goPortalLogin);
    document.getElementById('boot-retry-btn').addEventListener('click', () => location.reload());
    for (const el of document.querySelectorAll('[data-go-portal]')) {
        el.addEventListener('click', () => { location.href = PORTAL_URL; });
    }
    if (IS_STAGING) {
        document.body.classList.add('is-staging');
        document.title = '迅翔 配置カレンダー（先行更新版）';
    }

    const auth = getDeviceAuth();
    if (!auth || !auth.token || !auth.employeeCode) {
        showNeedLogin('この端末はまだログインしていません。');
        return;
    }
    currentDeviceToken = auth.token;

    let info = null;
    try {
        const rows = await rpc('resume_employee_session', { p_employee_code: auth.employeeCode });
        info = rows && rows[0];
        if (!info) throw new Error('セッションを確認できませんでした。');
    } catch (e) {
        const msg = e.message || '';
        if (msg.includes('承認待ち')) {
            show('boot-pending');
            return;
        }
        // showNeedLogin は rpc() 側で既に出している場合がある。それ以外は通信エラー扱い。
        if (document.getElementById('boot-login').style.display === 'none') {
            document.getElementById('boot-error-message').textContent = msg || '読み込みに失敗しました。';
            show('boot-error');
        }
        return;
    }

    document.getElementById('cal-user-name').textContent = `${info.out_employee_name}さん`;
    show('boot-calendar');

    const root = document.getElementById('assignment-calendar-root');
    try {
        window.AssignmentCalendar.mount(root, {
            rpc,
            employeeCode: auth.employeeCode,
            employeeName: info.out_employee_name,
            // ホームウィジェットの行をタップして来たときは、その日を開いた状態で始める
            initialDate: consumeWantedDate(),
            // 現場管理アプリはまだ無い。用意できたらここで site_id を渡して遷移させる
            // (社員ポータル内から開いたときと同じ扱いにする)。
            onOpenSite: null,
        });
    } catch (e) {
        document.getElementById('boot-error-message').textContent = '配置カレンダーを開けませんでした。時間をおいてもう一度お試しください。';
        show('boot-error');
    }
}

// Service Workerはこのフォルダ配下だけを担当する(社員ポータル側とスコープを分ける)。
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくても通常利用はできる */ });
    });
}

document.addEventListener('DOMContentLoaded', start);
