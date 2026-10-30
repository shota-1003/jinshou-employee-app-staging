'use strict';
// システム管理(AI統括管理社員)の画面。社員ポータルと同じログイン(端末トークン)を使う。
// 判定・権限の正本はDB側のRPC(ops_*)。この画面のボタン出し分けは見た目のためだけ。

const SUPABASE_URL = 'https://tcxbtanumtuyfrqtjtvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UVAjFJSjIs7Sl2tMpLWRkQ_uyDw9eyW';
const DEVICE_AUTH_KEY = 'jinshou_device_auth';
const DEVICE_AUTH_COOKIE = 'jinshou_device_auth';
const REFRESH_MS = 120000;           // 通信量を抑えるため2分おき(操作したときはすぐ更新)
const MONITOR_STALE_MIN = 25;        // 見張りは10分おき。25分以上止まっていたら画面だけで赤く知らせる
const AGENT_STALE_MIN = 5;           // AI社員は1分おきに生存を書く

const STATUS_JA = { ok: '正常', warn: '注意', error: '異常', unknown: '確認不能', unmonitored: '未監視', partial: '一部のみ監視' };
const WORK_STATUS_JA = {
  open: '受付済み', queued: 'AIの作業待ち', running: 'AIが作業中', waiting_input: '次の指示待ち', fix_ready: '修正済み・確認待ち',
  approved: '本番反映の承認済み', releasing: '本番へ反映中', deployed: '本番反映済み', done: '完了', failed: '修正できず', cancelled: '中断', rejected: '却下',
};
const KIND_JA = { bug_report: '不具合報告', fix_request: 'AI修正', direct_session: '相談しながら修正', improvement: '改善' };
const ROLE_JA = { fixer: '修正担当', app_admin: 'アプリ管理者', system_admin: 'システム管理者' };
const STANDARD_JA = { executive: '社長(全権限)', system_admin: 'システム管理者', app_admin: 'アプリ管理者', fixer: '修正担当', staff: '一般社員' };
const RANK_JA = ['一般社員', '修正担当', 'アプリ管理者', 'システム管理者', '社長'];

const $ = (s) => document.querySelector(s);
let auth = null;
let access = null;
let dash = null;
let chatLastId = 0;
let chatWaitTimer = null;

function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function getAuth() {
  for (const raw of [(() => { try { return localStorage.getItem(DEVICE_AUTH_KEY); } catch { return null; } })(), readCookie(DEVICE_AUTH_COOKIE)]) {
    try { const p = JSON.parse(raw); if (p && p.token && p.employeeCode) return p; } catch { /* 無いものとして扱う */ }
  }
  return null;
}

// 画面で起きた失敗(ログイン情報が見つからない・通信失敗・送信失敗・JSエラー)を本番の errors へ残す。
// 2026-10-27 スマホから「開いたのに届かない」ことがあり、画面側の記録が無く原因を追えなかったため。
// 報告はポータルと同じ client-error-reporter.js(見張りの client_errors 検査がこの記録を数える)。
const REPORTER = window.ClientErrorReporter || null;
if (REPORTER) {
  REPORTER.init({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, agentName: 'ops-center-client',
    getEmployeeCode: () => (auth ? auth.employeeCode : null) });
}
function report(kind, endpoint, message, status) {
  if (!REPORTER) return;
  const extra = { screen: 'ops', standalone: !!(window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)) };
  if (kind === 'http') REPORTER.reportHttpError(endpoint, status, message, extra);
  else if (kind === 'fetch') REPORTER.reportFetchFailure(endpoint, message, extra);
  else REPORTER.reportRuntimeError(new Error(`ops画面: ${message}`), Object.assign({ stage: endpoint }, extra));
}

// rawParams=true のときは p_employee_code を足さない(各アプリの既存の処理は引数の名前が違う。例 p_admin_employee_code)
async function rpc(name, params, rawParams) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'X-Device-Token': auth.token },
      body: JSON.stringify(rawParams ? params : { p_employee_code: auth.employeeCode, ...params }),
    });
  } catch (e) {
    report('fetch', name, e && e.message);
    throw new Error('通信できませんでした。電波の良い場所でもう一度お試しください。');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = `通信エラー(${res.status})`;
    try { const j = JSON.parse(text); if (j.message) msg = j.message; } catch { /* そのまま */ }
    report('http', name, msg, res.status);
    // DB側の決まったエラーは日本語。英語のまま返ってきたもの(内部のエラー)は、利用者向けの日本語に置き換える(原文は上の記録に残る)
    if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(msg)) {
      msg = res.status >= 500 ? 'システムの内部でエラーが起きました。少し待ってからもう一度お試しください。続く場合は「依頼」から報告してください。'
        : 'この操作を受け付けられませんでした。画面を「更新」してからもう一度お試しください。';
    }
    if (/セッションが確認できません|ご利用いただけません/.test(msg)) showLogin();
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function ago(ts) {
  if (!ts) return '記録なし';
  const m = (Date.now() - new Date(ts).getTime()) / 60000;
  if (m < 1) return 'たった今'; if (m < 60) return `${Math.round(m)}分前`; if (m < 48 * 60) return `${Math.round(m / 60)}時間前`;
  return `${Math.round(m / 1440)}日前`;
}
function jst(ts) { return ts ? new Date(ts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000); }
function showLogin() { $('#app').hidden = true; $('#login-needed').hidden = false; }

// ---------------- 管理画面 ----------------
async function loadDashboard() {
  dash = await rpc('ops_dashboard', {});
  render();
  $('#updated').textContent = `更新 ${jst(dash.generated_at)}`;
}

function render() {
  const apps = dash.apps.filter((a) => a.app_name !== 'ops-center');
  const self = dash.apps.find((a) => a.app_name === 'ops-center');
  const count = (s) => apps.filter((a) => a.overall_status === s).length;
  const tiles = [
    ['err', count('error'), '異常のアプリ'],
    ['warn', count('warn') + count('partial'), '注意のアプリ'],
    ['ok', count('ok'), '正常のアプリ'],
    ['unk', count('unmonitored') + count('unknown'), '未監視・確認不能'],
  ];
  if (dash.requests) tiles.push(['', dash.requests.pending, '承認待ちの申請'], ['', dash.requests.needs_review, '要確認の申請']);
  tiles.push(['', dash.ai_running, 'AIが作業中'], ['', dash.ai_queued, 'AIの作業待ち']);
  $('#tiles').innerHTML = tiles.map(([c, n, l]) => `<div class="tile ${c}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

  // 見張り・AI社員そのものが止まっていないか(DBの値を信じず、最終時刻の古さで画面が判断する)
  const warnings = [];
  const monMin = dash.monitor_last_run ? (Date.now() - new Date(dash.monitor_last_run).getTime()) / 60000 : Infinity;
  const hb = self && self.checks.find((c) => c.check_key === 'agent_heartbeat');
  const hbMin = hb ? (Date.now() - new Date(hb.checked_at).getTime()) / 60000 : Infinity;
  if (monMin > MONITOR_STALE_MIN) warnings.push(`見張りが${Number.isFinite(monMin) ? `${Math.round(monMin)}分` : '一度も'}動いていません。下の状態は古い可能性があります。`);
  if (hbMin > AGENT_STALE_MIN) warnings.push(`AI社員(会話・修正担当)が${Number.isFinite(hbMin) ? `${Math.round(hbMin)}分` : 'まだ一度も'}応答していません。会話の返事や修正が止まっています。`);
  $('#banner').hidden = !warnings.length;
  // 復旧手順(タスク名)はシステム管理者だけに出す。他の人には「管理者が対応する」とだけ伝える
  const recovery = access && access.global_rank >= 3
    ? '復旧手順: 24時間用PCのタスク「AICompanyBrain-OpsAgent」「AICompanyBrain-OpsFleetMonitor」を確認してください'
    : 'システム管理者に連絡が必要です。急ぎの場合は社長かシステム管理者へお知らせください。';
  $('#banner').innerHTML = warnings.map(esc).join('<br>') + (warnings.length ? `<br><span class="hint">${esc(recovery)}</span>` : '');

  $('#apps').innerHTML = dash.apps.map((a) => `
    <article class="app s-${esc(a.overall_status)}" data-app="${esc(a.app_name)}">
      <div class="app-head"><h3>${esc(a.display_name)}</h3><span class="badge ${esc(a.overall_status)}">${esc(STATUS_JA[a.overall_status] || a.overall_status)}</span></div>
      <ul class="checks">${a.checks.length ? a.checks.map((c) => `
        <li><span class="dot ${esc(c.status)}" title="${esc(STATUS_JA[c.status] || c.status)}"></span>
          <span><span class="lab">${esc(c.label)}:</span> ${esc(c.summary || STATUS_JA[c.status])}</span></li>`).join('')
        : '<li><span class="dot"></span><span>見張り方が未登録です(未監視)</span></li>'}</ul>
      <div class="app-foot">
        <span>最終確認 ${esc(ago(a.last_checked_at))}</span>
        ${a.open_items ? `<span>対応中の依頼 ${esc(a.open_items)}件</span>` : ''}
        ${a.production_url ? `<a href="${esc(a.production_url)}" target="_blank" rel="noopener">開く</a>` : ''}
        ${a.app_name !== 'ops-center' ? `<button class="btn sm" data-report="${esc(a.app_name)}">依頼</button>` : ''}
      </div>
    </article>`).join('');

  $('#items').innerHTML = dash.work_items.length ? dash.work_items.map((w) => `
    <div class="item" data-item="${esc(w.id)}">
      <span class="badge ${w.status === 'failed' || w.status === 'rejected' ? 'error' : w.status === 'fix_ready' || w.status === 'waiting_input' ? 'warn' : w.status === 'done' || w.status === 'deployed' ? 'ok' : ''}">${esc(WORK_STATUS_JA[w.status] || w.status)}</span>
      <div><div class="t">#${esc(w.id)} ${esc(w.title)}</div>
        <div class="m">${esc(appName(w.app_name))}・${esc(KIND_JA[w.kind] || w.kind)}・${esc(w.requested_by_name || 'AIの見張り')}・${esc(jst(w.updated_at))}${w.result_summary ? `・${esc(w.result_summary)}` : ''}</div></div>
      <span class="m">›</span>
    </div>`).join('') : '<div class="empty">表示できる依頼はありません。</div>';

  $('#events').innerHTML = dash.recent_events.length ? dash.recent_events.map((e) => `
    <div class="row">${esc(jst(e.created_at))} ${esc(appName(e.app_name))}: ${esc(STATUS_JA[e.from_status] || '初回')} → <b>${esc(STATUS_JA[e.to_status] || e.to_status)}</b> ${esc(e.summary || '')}</div>`).join('')
    : '<div class="empty">まだ変化の記録はありません。</div>';
}

function appName(id) { const a = dash && dash.apps.find((x) => x.app_name === id); return a ? a.display_name : id; }
// 「2 files changed, 5 insertions(+), 1 deletion(-)」を日本語にする
function diffJa(stat) {
  return String(stat || '').replace(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
    (_, f, a, d) => `${f}個のファイルを変更(追加 ${a || 0}行・削除 ${d || 0}行)`);
}

// ---------------- 承認待ち・未処理(全アプリ) ----------------
// 一覧はDBの ops_pending_items(読むだけ)。承認・差し戻しは、下の対応表にある「各アプリの既存の処理」だけを呼ぶ。
// DBから届くのは操作の名前(approve/return)だけで、呼ぶ処理名はここに固定する(届いた名前の処理をそのまま呼ばない)。
// 権限・二重処理の確認は、呼ばれた各アプリの処理が自分で行う(例: 既に処理済みなら「承認待ちの状態ではありません」で止まる)。
const PENDING_ACTIONS = {
  'portal.request': {
    approve: { label: '承認する', verb: '承認', done: '承認しました', call: (it) => rpc('admin_decide_request', { p_admin_employee_code: auth.employeeCode, p_request_id: Number(it.id), p_action: 'approved', p_rejection_reason: null }, true) },
    return: { label: '差し戻す', verb: '差し戻し', done: '差し戻しました', needReason: '差し戻しの理由(申請者に表示されます)',
      call: (it, reason) => rpc('admin_decide_request', { p_admin_employee_code: auth.employeeCode, p_request_id: Number(it.id), p_action: 'needs_review', p_rejection_reason: reason }, true) },
  },
};
let pending = null;
let pendingFilter = null;
// 件名が空のもの(採用の下書きは本番30件中26件が件名なし)は、本文の書き出しで見分けられるようにする
function pendingTitle(it) {
  const body = it.detail && it.detail['本文'];
  if (/^\((件名なし|内容の要約なし)\)$/.test(it.title) && body) return `${body.replace(/\s+/g, ' ').slice(0, 40)}…`;
  return it.title;
}

async function loadPending() {
  pending = await rpc('ops_pending_items', {});
  if (!pending.sources.length) { $('#pending-area').hidden = true; return; }
  $('#pending-area').hidden = false;
  if (pendingFilter && !pending.sources.some((s) => s.source === pendingFilter)) pendingFilter = null;
  renderPending();
}
function renderPending() {
  const total = pending.sources.reduce((n, s) => n + s.count, 0);
  $('#pending-sources').innerHTML = [`<button class="chip ${pendingFilter ? '' : 'on'}" data-pfilter="">すべて ${total}件</button>`]
    .concat(pending.sources.map((s) => `<button class="chip ${pendingFilter === s.source ? 'on' : ''}" data-pfilter="${esc(s.source)}">${esc(s.label)} ${esc(s.count)}件</button>`)).join('');
  const list = pending.items.filter((it) => !pendingFilter || it.source === pendingFilter);
  $('#pending-list').innerHTML = list.length ? list.map((it, i) => `
    <div class="item" data-pidx="${pending.items.indexOf(it)}">
      <span class="badge ${it.age_days >= 3 ? 'warn' : ''}">${esc(it.status_label)}</span>
      <div><div class="t">${esc(it.kind_label)}: ${esc(pendingTitle(it))}</div>
        <div class="m">${esc(appName(it.app_name))}・${esc(it.who_label)} ${esc(it.who)}・${esc(jst(it.created_at))}・<span class="${it.age_days >= 3 ? 'age-old' : ''}">${esc(it.age_days)}日たっています</span>${it.actions.length ? '・この画面で処理できます' : ''}</div></div>
      <span class="m">›</span>
    </div>`).join('') : '<div class="empty">承認待ち・未処理はありません。</div>';
  const shown = list.length; const all = pendingFilter ? (pending.sources.find((s) => s.source === pendingFilter) || {}).count : total;
  if (all > shown) $('#pending-list').insertAdjacentHTML('beforeend', `<div class="empty">ほかに${esc(all - shown)}件あります(古い順に表示)。残りは各アプリで確認してください。</div>`);
}
function openPending(idx) {
  const it = pending.items[idx];
  const acts = PENDING_ACTIONS[it.source] || {};
  const usable = it.actions.filter((a) => acts[a]);
  const detail = Object.entries(it.detail || {}).filter(([k]) => k !== '本文');
  $('#dlg-item-body').innerHTML = `
    <h2>${esc(it.kind_label)}: ${esc(pendingTitle(it))}</h2>
    <dl class="kv">
      <dt>アプリ</dt><dd>${esc(appName(it.app_name))}</dd>
      <dt>${esc(it.who_label)}</dt><dd>${esc(it.who)}</dd>
      <dt>日時</dt><dd>${esc(jst(it.created_at))}(${esc(it.age_days)}日たっています)</dd>
      <dt>状態</dt><dd><b>${esc(it.status_label)}</b></dd>
      ${detail.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'number' && k === '金額' ? `${v.toLocaleString('ja-JP')}円` : v)}</dd>`).join('')}
    </dl>
    ${it.detail && it.detail['本文'] ? `<div><div class="hint">本文</div><pre class="box prewrap">${esc(it.detail['本文'])}</pre></div>` : ''}
    ${it.action_note ? `<p class="hint">${esc(it.action_note)}</p>` : ''}
    <p id="pending-error" class="error" hidden></p>
    <div class="dlg-actions">
      ${usable.map((a) => `<button class="btn ${a === 'approve' ? 'primary' : 'danger'}" data-pact="${esc(a)}">${esc(acts[a].label)}</button>`).join('')}
      ${it.link_url ? `<a class="btn" href="${esc(it.link_url)}" target="_blank" rel="noopener">${esc(it.link_label || 'アプリで開く')}</a>` : ''}
      <button class="btn" data-close>閉じる</button>
    </div>`;
  const dlg = $('#dlg-item');
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-pact]').forEach((b) => b.addEventListener('click', async () => {
    const act = acts[b.dataset.pact];
    let reason = null;
    if (act.needReason) {
      reason = window.prompt(act.needReason);
      if (reason == null) return;
      if (!reason.trim()) { $('#pending-error').textContent = '理由を入力してください'; $('#pending-error').hidden = false; return; }
    } else if (!window.confirm(`「${it.kind_label}: ${pendingTitle(it)}」を${act.verb}します。よろしいですか？`)) return;
    dlg.querySelectorAll('[data-pact]').forEach((x) => { x.disabled = true; });   // 二度押しで2回呼ばない
    try {
      await act.call(it, reason && reason.trim());
      toast(act.done);
      dlg.close();
    } catch (err) {
      $('#pending-error').textContent = err.message; $('#pending-error').hidden = false;
    } finally {
      loadPending().catch(() => {});
    }
  }));
}

// ---------------- 依頼 ----------------
function openNewItem(appNameValue) {
  const sel = $('#new-form [name=app]');
  sel.innerHTML = dash.apps.filter((a) => a.app_name !== 'ops-center').map((a) => `<option value="${esc(a.app_name)}">${esc(a.display_name)}</option>`).join('');
  if (appNameValue) sel.value = appNameValue;
  syncKindOptions();
  $('#new-error').hidden = true;
  $('#dlg-new').showModal();
}
function syncKindOptions() {
  const app = dash.apps.find((a) => a.app_name === $('#new-form [name=app]').value);
  const rank = app ? app.my_rank : 0;
  for (const opt of $('#new-form [name=kind]').options) opt.disabled = opt.value !== 'bug_report' && rank < 1;
  if (rank < 1) $('#new-form [name=kind]').value = 'bug_report';
}

async function submitNewItem(ev) {
  ev.preventDefault();
  const f = new FormData($('#new-form'));
  $('#new-submit').disabled = true;
  try {
    const id = await rpc('ops_submit_work_item', { p_app_name: f.get('app'), p_kind: f.get('kind'), p_title: f.get('title'), p_body: f.get('body'), p_priority: f.get('priority') });
    $('#dlg-new').close(); $('#new-form').reset();
    toast(`依頼 #${id} を受け付けました`);
    await loadDashboard();
  } catch (e) { $('#new-error').textContent = e.message; $('#new-error').hidden = false; } finally { $('#new-submit').disabled = false; }
}

async function openItem(id) {
  const w = await rpc('ops_get_work_item', { p_item_id: Number(id) });
  const canAct = w.my_rank >= 1;
  const canApprove = w.status === 'fix_ready' && w.my_rank >= 2 && !(w.app_sensitivity === 'high' && w.my_rank < 3);
  const closed = ['done', 'deployed', 'cancelled', 'rejected'].includes(w.status);
  const tests = w.test_result;
  $('#dlg-item-body').innerHTML = `
    <h2>#${esc(w.id)} ${esc(w.title)}</h2>
    <dl class="kv">
      <dt>状態</dt><dd><b>${esc(WORK_STATUS_JA[w.status] || w.status)}</b>${w.result_summary ? ` — ${esc(w.result_summary)}` : ''}</dd>
      <dt>アプリ</dt><dd>${esc(appName(w.app_name))}${w.app_sensitivity === 'high' ? '(重要データ: 承認はシステム管理者か社長)' : ''}</dd>
      <dt>種類</dt><dd>${esc(KIND_JA[w.kind] || w.kind)}</dd>
      <dt>依頼者</dt><dd>${esc(w.requested_by_name || 'AIの見張り')}・${esc(jst(w.created_at))}</dd>
      ${w.branch_name && w.my_rank >= 3 ? `<dt>作業ブランチ</dt><dd>${esc(w.branch_name)}</dd>` : ''}
      ${tests ? `<dt>自動テスト</dt><dd>${tests.ran ? (tests.passed ? '合格' : '不合格') + (w.my_rank >= 3 ? `(「${esc(tests.cmd)}」終了コード ${esc(tests.exit)})` : '') : esc(tests.note || '')}</dd>` : ''}
    </dl>
    ${w.diff_summary && w.my_rank >= 2 ? `<div><div class="hint">変更したファイル</div><pre class="box">${esc(diffJa(w.diff_summary))}</pre></div>` : ''}
    <div class="thread">${w.messages.map((m) => `<div class="msg ${esc(m.role)}">${m.role === 'user' ? `<b>${esc(m.author || '')}</b>\n` : ''}${esc(m.content)}<span class="ts">${esc(jst(m.created_at))}</span></div>`).join('')}</div>
    ${canAct && !closed ? `<form id="item-msg-form" class="chat-form"><textarea name="c" rows="2" placeholder="AIへの追加の指示(送るとAIが作業を再開します)"></textarea>
      <div class="chat-actions"><button class="btn primary sm">指示を送る</button></div></form>` : ''}
    <p id="item-error" class="error" hidden></p>
    <div class="dlg-actions">
      ${canApprove ? '<button class="btn primary" data-decide="approve">本番反映を承認</button><button class="btn danger" data-decide="reject">却下</button>' : ''}
      ${w.status === 'fix_ready' && !canApprove ? '<span class="hint">承認はアプリ管理者以上(重要データのアプリはシステム管理者・社長)が行います。</span>' : ''}
      ${!closed ? '<button class="btn ghost" data-decide="cancel">中断</button>' : ''}
      ${!closed && canAct ? '<button class="btn ghost" data-decide="close">完了にする</button>' : ''}
      <button class="btn" data-close>閉じる</button>
    </div>`;
  const dlg = $('#dlg-item');
  if (!dlg.open) dlg.showModal();
  const mf = $('#item-msg-form');
  if (mf) mf.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await rpc('ops_add_work_message', { p_item_id: w.id, p_content: mf.c.value }); toast('指示を送りました'); await openItem(w.id); loadDashboard(); }
    catch (err) { $('#item-error').textContent = err.message; $('#item-error').hidden = false; }
  });
  dlg.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', async () => {
    const d = b.dataset.decide;
    const label = { approve: '本番反映を承認', reject: '却下', cancel: '中断', close: '完了に' }[d];
    if (!window.confirm(`この依頼を${label}します。よろしいですか？`)) return;
    const note = d === 'reject' ? window.prompt('却下の理由(任意)') : null;
    try { await rpc('ops_decide_work_item', { p_item_id: w.id, p_decision: d, p_note: note }); toast(`${label}しました`); await openItem(w.id); loadDashboard(); }
    catch (err) { $('#item-error').textContent = err.message; $('#item-error').hidden = false; }
  }));
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
}

// ---------------- 会話 ----------------
function appendChat(list) {
  const log = $('#chat-log');
  for (const m of list) {
    chatLastId = Math.max(chatLastId, m.id);
    const el = document.createElement('div');
    el.className = `msg ${m.role}${m.role === 'user' && (m.status === 'pending' || m.status === 'answering') ? ' pending' : ''}`;
    el.dataset.id = m.id;
    el.textContent = m.content;
    const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = jst(m.created_at); el.appendChild(ts);
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}
async function loadChat() {
  const list = await rpc('ops_chat_history', { p_after_id: chatLastId });
  if (list && list.length) {
    if (list.some((m) => m.role === 'ai')) document.querySelectorAll('.msg.pending').forEach((e) => e.classList.remove('pending'));
    appendChat(list);
  }
  if (!$('#chat-log').children.length) appendChat([{ id: 0, role: 'ai', content: 'AI統括管理社員です。システムの状況・申請の件数・修正の進み具合など、記録に基づいてお答えします。', created_at: new Date().toISOString() }]);
  return list || [];
}
async function sendChat(ev) {
  if (ev) ev.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await rpc('ops_chat_send', { p_content: text });
    await loadChat();
    waitForAnswer();
  } catch (e) { toast(`送れませんでした: ${e.message}`); input.value = text; voice.speakNext = false; setVoiceStatus(''); }
}
// 返事が来るまでだけ短い間隔で見に行く(最長3分)。来たら止める。
function waitForAnswer() {
  clearInterval(chatWaitTimer);
  const started = Date.now();
  chatWaitTimer = setInterval(async () => {
    const list = await loadChat().catch(() => []);
    if (list.some((m) => m.role === 'ai') || Date.now() - started > 180000) {
      clearInterval(chatWaitTimer);
      const reply = list.filter((m) => m.role === 'ai').pop();
      if (reply && voice.speakNext) speak(reply.content);
      voice.speakNext = false;
      if (!list.some((m) => m.role === 'ai') && Date.now() - started > 180000) {
        toast('AI社員の返事が遅れています。上の赤い表示が出ていないか確認してください。');
        report('stage', 'chat_no_reply', '質問から3分たっても返事が画面に出ない');
      }
      loadDashboard().catch(() => {});
    }
  }, 4000);
}

// ---------------- 音声(共有PC向け。スマホは文字で十分) ----------------
// ブラウザに入っている音声認識(日本語)と読み上げを使う。追加の費用・外部APIの契約は無い。
// マイクが無い・許可されていない・聞き取れないときは、理由を日本語で出して文字入力で続けられるようにする。
const voice = { sr: null, listening: false, speakNext: false };
const VOICE_ERR_JA = {
  'not-allowed': 'マイクの使用が許可されていません。アドレス欄の左の鍵のマークを押し、マイクを「許可」にしてください。文字で入力しても使えます。',
  'service-not-allowed': 'このブラウザでは音声入力が使えない設定です。文字で入力してください。',
  'audio-capture': 'マイクが見つかりません。マイクがつながっているか確認してください。文字で入力しても使えます。',
  'no-speech': '声が聞こえませんでした。もう一度「話しかける」を押してからお話しください。文字で入力しても使えます。',
  network: '音声の聞き取りに必要な通信ができませんでした。文字で入力してください。',
  'language-not-supported': 'このブラウザは日本語の音声入力に対応していません。文字で入力してください。',
};
function setVoiceStatus(msg, info) {
  const el = $('#voice-status');
  el.textContent = msg || ''; el.hidden = !msg; el.classList.toggle('info', !!info);
}
function jaVoice() {
  const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  const ja = vs.filter((v) => /^ja/i.test(v.lang));
  return ja.find((v) => /Nanami|Google|Natural/i.test(v.name)) || ja[0] || null;
}
// 読み上げ用に整える(#12 → 12番、URLは読まない、長すぎる返事は途中まで)
function forSpeech(t) {
  return String(t).replace(/https?:\/\/\S+/g, '').replace(/#(\d+)/g, '$1番').replace(/・/g, '、').replace(/[()（）]/g, '、')
    .replace(/\n+/g, '。').replace(/。{2,}/g, '。').slice(0, 700);
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(forSpeech(text));
  u.lang = 'ja-JP'; u.rate = 1.05;
  const v = jaVoice(); if (v) u.voice = v;
  if (!v && speechSynthesis.getVoices().length) setVoiceStatus('このPCには日本語の読み上げ音声がないため、うまく読めないことがあります。返事は画面でもお読みいただけます。');
  else setVoiceStatus('返事を読み上げています。', true);
  u.onend = u.onerror = () => { $('#btn-stop-speak').hidden = true; if ($('#voice-status').classList.contains('info')) setVoiceStatus(''); };
  $('#btn-stop-speak').hidden = false;
  speechSynthesis.speak(u);
}
function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const b = $('#btn-stop-speak'); if (b) b.hidden = true;
}
function micIdle() { const b = $('#btn-mic'); b.classList.remove('listening'); b.textContent = '🎤 話しかける'; }
function startListening(SR) {
  stopSpeaking();
  const input = $('#chat-input');
  const base = input.value.trim() ? `${input.value.trim()} ` : '';
  let finalText = ''; let errCode = null;
  const r = new SR();
  r.lang = 'ja-JP'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  r.onstart = () => {
    voice.listening = true;
    const b = $('#btn-mic'); b.classList.add('listening'); b.textContent = '■ 聞いています(押すと終わる)';
    setVoiceStatus('どうぞお話しください。話し終わると自動で送ります。', true);
  };
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
    }
    input.value = base + finalText + interim;
  };
  r.onerror = (e) => { errCode = e.error; };
  r.onend = () => {
    voice.listening = false; voice.sr = null; micIdle();
    if (errCode && errCode !== 'aborted') { input.value = (base + finalText).trim(); setVoiceStatus(VOICE_ERR_JA[errCode] || '音声を聞き取れませんでした。もう一度お試しいただくか、文字で入力してください。'); return; }
    if (!finalText.trim()) { if (errCode !== 'aborted') setVoiceStatus(VOICE_ERR_JA['no-speech']); return; }
    input.value = (base + finalText).trim();
    voice.speakNext = $('#voice-reply').checked;
    setVoiceStatus('送りました。返事を待っています…', true);
    sendChat(null);
  };
  try { r.start(); voice.sr = r; } catch { micIdle(); setVoiceStatus('音声入力を始められませんでした。文字で入力してください。'); }
}
function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#btn-mic'); const chk = $('#voice-reply');
  const wide = window.matchMedia && matchMedia('(min-width: 900px)').matches;
  // 読み上げの既定: 共有PC(広い画面)は読み上げる、スマホは読まない。選んだ値は端末ごとに覚える
  let saved = null; try { saved = localStorage.getItem('ops_voice_reply'); } catch { /* 使えない端末 */ }
  chk.checked = saved == null ? wide : saved === '1';
  chk.addEventListener('change', () => { try { localStorage.setItem('ops_voice_reply', chk.checked ? '1' : '0'); } catch { /* 無視 */ } if (!chk.checked) stopSpeaking(); });
  if (!('speechSynthesis' in window)) $('#voice-reply-wrap').hidden = true;
  else speechSynthesis.getVoices();   // Chrome は最初に呼ぶと声の一覧を読み込み始める
  $('#btn-stop-speak').addEventListener('click', () => { stopSpeaking(); setVoiceStatus(''); });
  $('#btn-voice-check').addEventListener('click', () => { voiceCheck().catch((e) => setVoiceStatus(`音声の確認を続けられませんでした: ${e.message}`)); });
  if (!SR) {
    btn.disabled = true;
    btn.title = 'このブラウザは音声入力に対応していません';
    if (wide) setVoiceStatus('このブラウザは「話しかける」に対応していません(会社のPCでは Chrome か Edge で使えます)。文字で入力すれば同じことができます。');
    return;
  }
  btn.addEventListener('click', () => { if (voice.listening && voice.sr) voice.sr.stop(); else startListening(SR); });
}

// 共有PCのスピーカーとマイクの確認(人が聞いて・話す)。結果は会話として送るので、AI操作の記録に端末つきで残る
// (開発の担当は、この記録で実機の確認ができたかを確かめる。自動の確認では、本物のマイク・スピーカーは確かめられない)
async function voiceCheck() {
  stopSpeaking();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const v = jaVoice();
  const r = { tts: 'speechSynthesis' in window, voice: v ? v.name : null, mic: !!SR, heard: false, micText: '', micError: null };
  if (r.tts) {
    setVoiceStatus('音声の確認 1/3: これから読み上げます。スピーカーの音を聞いてください。', true);
    await new Promise((res) => {
      const u = new SpeechSynthesisUtterance('音声の確認です。この声が聞こえたら、次の画面で、オーケーを押してください。');
      u.lang = 'ja-JP'; if (v) u.voice = v; u.onend = res; u.onerror = res;
      speechSynthesis.speak(u); setTimeout(res, 15000);
    });
    r.heard = window.confirm('音声の確認 2/3: 読み上げの声が聞こえましたか？\n聞こえたら「OK」、聞こえなかったら「キャンセル」を押してください。');
  }
  if (SR) {
    window.alert('音声の確認 3/3: 「OK」を押したあと、マイクに向かって「音声の確認です」と話してください。\n(マイクの使用の許可を聞かれたら「許可」を押してください)');
    const got = await new Promise((res) => {
      const rec = new SR(); let t = ''; let err = null;
      rec.lang = 'ja-JP'; rec.interimResults = false; rec.maxAlternatives = 1;
      rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i += 1) if (e.results[i].isFinal) t += e.results[i][0].transcript; };
      rec.onerror = (e) => { err = e.error; };
      rec.onend = () => res({ t, err });
      try { rec.start(); setVoiceStatus('どうぞ「音声の確認です」と話してください。', true); } catch { res({ t: '', err: 'start-failed' }); }
    });
    r.micText = got.t.trim(); r.micError = got.err;
  }
  const ua = (navigator.userAgent.match(/(Edg|Chrome|Firefox|Version)\/[\d.]+/) || [''])[0].replace('Edg/', 'Edge/').replace('Version/', 'Safari/');
  const micJa = !r.mic ? 'このブラウザは音声入力に対応していない'
    : r.micText ? `「${r.micText.slice(0, 40)}」と聞き取れた` : `聞き取れなかった(${VOICE_ERR_JA[r.micError] ? VOICE_ERR_JA[r.micError].split('。')[0] : '声が届かなかった'})`;
  $('#chat-input').value = `【音声の確認】読み上げ: ${!r.tts ? 'このブラウザは読み上げに対応していない' : r.heard ? '聞こえた' : '聞こえなかった'}(声: ${r.voice || '日本語の声なし'}) / マイク: ${micJa} / ブラウザ: ${ua}`;
  voice.speakNext = $('#voice-reply').checked;
  await sendChat(null);
  setVoiceStatus(r.heard && r.micText ? '音声の確認ができました(読み上げ・マイクとも使えます)。結果は記録しました。'
    : 'うまくいかなかった点がありました。結果は記録しました。システム管理者に知らせてください。', r.heard && !!r.micText);
}

// ---------------- 権限・アプリ追加(システム管理者・社長) ----------------
async function loadAdmin() {
  if (access.global_rank < 3) return;
  $('#admin-area').hidden = false;
  $('#role-form [name=app]').innerHTML = '<option value="">全アプリ</option>' + access.apps.map((a) => `<option value="${esc(a.app_name)}">${esc(a.display_name)}</option>`).join('');
  $('#template-apps').innerHTML = access.apps.filter((a) => a.app_name !== 'ops-center').map((a) =>
    `<label class="chk"><input type="checkbox" name="tapp" value="${esc(a.app_name)}"> ${esc(a.display_name)}${a.sensitivity === 'high' ? '(重要データ)' : ''}</label>`).join('');
  const people = await rpc('ops_member_overview', {});
  const withRoles = people.filter((p) => p.standard !== 'staff');
  const staffCount = people.length - withRoles.length;
  $('#members').innerHTML = withRoles.map((p) => {
    const detail = p.roles.length
      ? p.roles.map((r) => `${ROLE_JA[r.role]}(${r.app_name ? appName(r.app_name) : '全アプリ'})`).join('・')
      : '全アプリ・全権限';
    const by = p.roles.length ? `付与 ${esc(p.roles[0].granted_by || '')} ${esc(jst(p.roles[0].granted_at))}` : '';
    return `<div class="row"><b>${esc(p.employee_code)} ${esc(p.employee_name)}</b> — ${esc(STANDARD_JA[p.standard])}: ${esc(detail)} <span class="hint">${by}</span></div>`;
  }).join('') + `<div class="row">ほかの ${staffCount} 人は一般社員です(不具合の報告・自分の申請の確認・質問ができます)。</div>`;
}
// ---------------- 社員AI操作報告 ----------------
// 見られる範囲はDB(ops_ai_reports)が決める: 社長・全アプリのシステム管理者=全員分 / 担当アプリの管理者=担当アプリの依頼 / ほか=自分の分だけ
const EVENT_JA = {
  question: '質問・指示', instruction: '追加の指示', answer: 'AIの回答', refusal: '拒否', work_created: '依頼の登録',
  ai_started: 'AIの作業開始', ai_result: 'AIの作業結果', ai_report: 'AIの報告', approval: '承認・却下', release: '本番反映',
  completed: '完了', error: 'エラー・未解決', cancelled: '中断', note: '状態の変化',
};
const ACTOR_JA = { employee: '社員', ai: 'AI', approver: '承認者', system: 'システム' };
let reports = null;

function reportFilters() {
  const f = $('#reports-form');
  return { p_from: f.from.value || null, p_to: f.to.value || null, p_employee: (f.employee.value || '').trim() || null,
    p_app: f.app.value || null, p_only_alert: f.alert.checked };
}
async function loadReports(ev) {
  if (ev) ev.preventDefault();
  reports = await rpc('ops_ai_reports', reportFilters());
  const area = $('#reports-area');
  area.hidden = false;
  const self = reports.scope === 'self';
  $('#reports-title').textContent = self ? '自分のAI操作の記録' : '社員AI操作報告';
  $('#reports-form [name=employee]').hidden = self;
  if (self) $('#reports-hint').textContent = 'あなたがAIに指示した内容とAIの作業の記録です。ほかの人の記録は表示されません。';
  else if (reports.scope === 'apps') $('#reports-hint').textContent = 'あなたの担当アプリの依頼の記録と、あなた自身の記録を表示します。記録は誰も消したり書き換えたりできません。';
  $('#reports').innerHTML = reports.cases.length ? reports.cases.map((c) => `
    <div class="row clickable" data-case="${esc(c.case_no)}">
      <b>${esc(c.case_no)}</b> ${esc(jst(c.opened_at))} ${self ? '' : `${esc(c.employee_name || '')}(${esc(c.employee_code || '')})`}
      <span class="hint">${esc(c.device || '')}</span>
      ${c.alerts ? `<span class="badge error">権限外の試行 ${esc(c.alerts)}</span>` : ''}
      ${c.refusals && !c.alerts ? `<span class="badge warn">拒否 ${esc(c.refusals)}</span>` : ''}
      ${c.approvals ? `<span class="badge ok">承認・却下 ${esc(c.approvals)}</span>` : ''}
      ${(c.apps || []).map((a) => `<span class="badge">${esc(a)}</span>`).join('')}
      <div class="hint">${esc(c.first_instruction || '')}${c.last_summary ? ` → ${esc(c.last_summary)}` : ''}</div>
    </div>`).join('') : '<div class="row">この条件の記録はありません。</div>';
}

// 報告書の項目(社長指示の15項目)を、記録から組み立てる
function reportFields(d) {
  const ev = d.events; const c = d.case;
  const of = (types) => ev.filter((e) => types.includes(e.type));
  const last = ev[ev.length - 1];
  const approvals = of(['approval']);
  const releases = of(['release']);
  // 質問だけの受付番号(依頼なし)は、最後に回答・拒否した時点で完了
  const done = d.work_items.length
    ? of(['completed', 'release']).filter((e) => e.type === 'completed' || /反映しました|合格/.test(e.summary))
    : of(['answer', 'refusal']);
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const tests = d.work_items.map((w) => (w.tests && w.tests.ran != null ? `#${w.id}: ${w.tests.ran ? (w.tests.passed ? '合格' : '不合格') : (w.tests.note || 'なし')}` : null)).filter(Boolean);
  return [
    ['受付番号', c.case_no],
    ['指示した社員', `${c.employee_name || '不明'}(社員番号 ${c.employee_code || '-'})`],
    ['指示日時', jst(c.opened_at)],
    ['操作した端末', uniq([c.device].concat(of(['question', 'instruction', 'work_created']).map((e) => e.device))).join('、') || '記録なし'],
    ['対象アプリ', uniq(ev.map((e) => e.app)).join('、') || '特定のアプリなし(質問)'],
    ['指示内容', of(['question', 'instruction', 'work_created']).map((e) => `${jst(e.at)} ${e.content || e.summary}`).join('\n') || '記録なし'],
    ['AIが実行した作業', of(['answer', 'ai_started', 'ai_result', 'ai_report', 'work_created']).filter((e) => e.actor === 'ai').map((e) => `${jst(e.at)} ${e.summary}`).join('\n') || 'なし'],
    ['参照した情報の種類', uniq(ev.flatMap((e) => e.info || [])).join('、') || 'なし'],
    ['変更したファイル・設定', uniq(ev.flatMap((e) => e.files || [])).join('\n') || 'なし'],
    ['テスト結果', tests.join('\n') || 'なし'],
    ['承認した担当者', approvals.map((e) => `${e.employee_name || ''}: ${e.summary}(${jst(e.at)})`).join('\n') || 'なし'],
    ['本番反映の有無', releases.some((e) => /反映しました|合格/.test(e.summary)) ? 'あり' : 'なし'],
    ['作業完了日時', done.length ? jst(done[done.length - 1].at) : '未完了'],
    ['最終結果', last ? last.summary : '記録なし'],
    ['エラー・未解決事項', of(['error', 'refusal']).map((e) => `${jst(e.at)} ${e.summary}`).join('\n') || 'なし'],
  ];
}

async function openReport(caseNo) {
  const d = await rpc('ops_ai_report_detail', { p_case_no: caseNo });
  const fields = reportFields(d);
  $('#dlg-report-body').innerHTML = `
    <h2>AI操作報告書 ${esc(d.case.case_no)}</h2>
    <dl class="kv">${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="pre">${esc(v)}</dd>`).join('')}</dl>
    <h3 class="card-title">時系列の記録</h3>
    <div class="list compact">${d.events.map((e) => `
      <div class="row ${e.severity === 'alert' ? 'alert' : ''}">
        <b>${esc(jst(e.at))} ${esc(EVENT_JA[e.type] || e.type)}</b> <span class="hint">${esc(ACTOR_JA[e.actor] || e.actor)} ${esc(e.employee_name || '')} ${esc(e.device || '')}</span>
        ${e.severity !== 'normal' ? `<span class="badge ${e.severity === 'alert' ? 'error' : 'warn'}">${e.severity === 'alert' ? '権限外の試行' : '重要'}</span>` : ''}
        <div>${esc(e.summary)}</div>
        ${e.content ? `<div class="pre hint">${esc(e.content)}</div>` : ''}
      </div>`).join('')}</div>
    ${d.work_items.length ? `<h3 class="card-title">修正履歴との照合</h3>
      <div class="list compact">${d.work_items.map((w) => `
        <div class="row clickable" data-item="${esc(w.id)}"><b>#${esc(w.id)} ${esc(w.title)}</b> — ${esc(WORK_STATUS_JA[w.status] || w.status)}
          <div class="hint">アプリ ${esc(w.app)}${w.commit ? `・修正の版 ${esc(String(w.commit).slice(0, 8))}` : ''}${w.decided_by ? `・判断 ${esc(w.decided_by)} ${esc(jst(w.decided_at))}` : ''}${w.protected_change ? '・認証/権限/監査に触れる修正(承認は社長のみ)' : ''}</div>
        </div>`).join('')}</div>` : ''}
    <div class="dlg-actions">
      <button class="btn ghost" data-report-export>報告書を出力(テキスト)</button>
      <button class="btn ghost" data-report-print>印刷</button>
      <button class="btn" data-close>閉じる</button>
    </div>`;
  const dlg = $('#dlg-report');
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-report-print]').addEventListener('click', () => window.print());
  dlg.querySelector('[data-report-export]').addEventListener('click', () => {
    const text = [`AI操作報告書 ${d.case.case_no}`, '', ...fields.map(([k, v]) => `■${k}\n${v}`), '', '■時系列の記録',
      ...d.events.map((e) => `${jst(e.at)} [${EVENT_JA[e.type] || e.type}] ${ACTOR_JA[e.actor] || e.actor} ${e.employee_name || ''}: ${e.summary}${e.content ? `\n    ${String(e.content).replace(/\n/g, '\n    ')}` : ''}`),
      '', `出力: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ${access.employee_name}`].join('\n');
    download(`AI操作報告書_${d.case.case_no}.txt`, text, 'text/plain');
  });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportReportsCsv() {
  if (!reports || !reports.cases.length) { toast('出力する記録がありません'); return; }
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['受付番号', '指示日時', '社員番号', '氏名', '端末', 'アプリ', '最初の指示', '最後の状態', '権限外の試行', '拒否', '承認・却下', '依頼番号']]
    .concat(reports.cases.map((c) => [c.case_no, jst(c.opened_at), c.employee_code, c.employee_name, c.device, (c.apps || []).join('・'),
      c.first_instruction, c.last_summary, c.alerts, c.refusals, c.approvals, (c.work_items || []).join('・')]));
  download(`社員AI操作報告_${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
}

async function submitTemplate(ev) {
  ev.preventDefault();
  const f = ev.target;
  const template = f.template.value;
  const apps = [...document.querySelectorAll('#template-apps input[name=tapp]:checked')].map((x) => x.value);
  if (template === 'app_admin' && !apps.length) { toast('アプリ管理者にするアプリを1つ以上選んでください'); return; }
  const target = f.target.value.trim();
  const scope = template === 'staff' ? '' : `(担当アプリ: ${apps.length ? apps.map(appName).join('・') : '全アプリ'})`;
  if (!window.confirm(`社員番号 ${target} を「${STANDARD_JA[template]}」${scope}にします。今の役割は標準の内容に置きかわります。よろしいですか？`)) return;
  try {
    const r = await rpc('ops_apply_role_template', { p_target_employee_code: target, p_template: template, p_apps: template === 'staff' || !apps.length ? null : apps });
    toast(`${STANDARD_JA[template]}にしました(付けた役割 ${r.added}件・外した役割 ${r.removed}件)`); loadAdmin();
  } catch (e) { toast(e.message); }
}
async function submitRole(ev) {
  ev.preventDefault();
  const f = ev.target; const active = ev.submitter && ev.submitter.name === 'grant';
  try {
    await rpc('ops_set_member_role', { p_target_employee_code: f.target.value.trim(), p_app_name: f.app.value || null, p_role: f.role.value, p_active: active });
    toast(active ? '付与しました' : '取り消しました'); loadAdmin();
  } catch (e) { toast(e.message); }
}
async function submitApp(ev) {
  ev.preventDefault();
  const f = ev.target;
  try {
    await rpc('ops_register_app', { p_app_name: f.app_name.value.trim(), p_display_name: f.display_name.value.trim(), p_production_url: f.url.value.trim() || null,
      p_description: null, p_sensitivity: f.high.checked ? 'high' : 'normal', p_category: 'business',
      p_fix_target: f.repo_dir.value.trim() ? { repo_dir: f.repo_dir.value.trim() } : {} });
    toast('登録しました。次の見張り(10分以内)から状態が表示されます'); f.reset(); await loadDashboard();
  } catch (e) { toast(e.message); }
}

async function init() {
  auth = getAuth();
  if (!auth) {
    let hasLocal = false; try { hasLocal = localStorage.getItem(DEVICE_AUTH_KEY) != null; } catch { /* 使えない端末 */ }
    report('stage', 'no_auth', `ログイン情報が見つからない(保存あり=${hasLocal} cookieあり=${document.cookie.includes(DEVICE_AUTH_COOKIE)})`);
    showLogin(); return;
  }
  try {
    access = await rpc('ops_my_access', {});
  } catch (e) {
    if (!$('#login-needed').hidden) return;
    // 白い画面のまま止めない。何が起きたかを画面に出す
    $('#login-needed').hidden = false;
    $('#login-needed h2').textContent = 'システム管理画面を開けませんでした';
    $('#login-needed p').textContent = `${e.message} — 少し待って「更新」を押すか、社員ポータルを開き直してください。`;
    return;
  }
  $('#app').hidden = false;
  $('#who').textContent = `${access.employee_name}(${RANK_JA[access.global_rank] || '一般社員'})`;
  await Promise.all([loadDashboard(), loadChat()]);
  loadPending().catch((e) => toast(`承認待ちの一覧を読めませんでした: ${e.message}`));
  loadAdmin().catch((e) => toast(e.message));
  $('#reports-form [name=app]').innerHTML = '<option value="">全アプリ</option>' + access.apps.map((a) => `<option value="${esc(a.app_name)}">${esc(a.display_name)}</option>`).join('');
  loadReports().catch((e) => toast(`AI操作の記録を読めませんでした: ${e.message}`));
  setupVoice();
  setInterval(() => { if (!document.hidden) { loadDashboard().catch(() => {}); loadPending().catch(() => {}); } }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDashboard().catch(() => {}); });
}

document.addEventListener('click', (e) => {
  const pf = e.target.closest('[data-pfilter]'); if (pf) { pendingFilter = pf.dataset.pfilter || null; renderPending(); return; }
  const pi = e.target.closest('[data-pidx]'); if (pi) { openPending(Number(pi.dataset.pidx)); return; }
  const rc = e.target.closest('[data-case]'); if (rc) { openReport(rc.dataset.case).catch((err) => toast(err.message)); return; }
  const rep = e.target.closest('[data-report]'); if (rep) { e.stopPropagation(); openNewItem(rep.dataset.report); return; }
  const it = e.target.closest('[data-item]'); if (it) { openItem(it.dataset.item).catch((err) => toast(err.message)); }
});
$('#btn-refresh').addEventListener('click', () => Promise.all([loadDashboard(), loadPending()]).then(() => toast('更新しました')).catch((e) => toast(e.message)));
$('#btn-new-item').addEventListener('click', () => openNewItem());
$('#new-form').addEventListener('submit', submitNewItem);
$('#new-form [name=app]').addEventListener('change', syncKindOptions);
$('#new-form [value=cancel]').addEventListener('click', () => $('#dlg-new').close());
$('#chat-form').addEventListener('submit', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat(e); });
$('#role-form').addEventListener('submit', submitRole);
$('#template-form').addEventListener('submit', submitTemplate);
$('#template-form [name=template]').addEventListener('change', (e) => {
  const staff = e.target.value === 'staff';
  $('#template-apps').hidden = staff; $('#template-apps-hint').hidden = staff;
});
$('#app-form').addEventListener('submit', submitApp);
$('#reports-form').addEventListener('submit', (e) => loadReports(e).catch((err) => toast(err.message)));
$('#reports-csv').addEventListener('click', exportReportsCsv);
init();
