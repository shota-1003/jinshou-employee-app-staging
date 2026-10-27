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
  approved: '本番反映の承認済み', deployed: '本番反映済み', done: '完了', failed: '修正できず', cancelled: '中断', rejected: '却下',
};
const KIND_JA = { bug_report: '不具合報告', fix_request: 'AI修正', direct_session: '相談しながら修正', improvement: '改善' };
const ROLE_JA = { fixer: '修正担当', app_admin: 'アプリ管理者', system_admin: 'システム管理者' };
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

async function rpc(name, params) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'X-Device-Token': auth.token },
      body: JSON.stringify({ p_employee_code: auth.employeeCode, ...params }),
    });
  } catch { throw new Error('通信できませんでした。電波の良い場所でもう一度お試しください。'); }
  const text = await res.text();
  if (!res.ok) {
    let msg = `通信エラー(${res.status})`;
    try { const j = JSON.parse(text); if (j.message) msg = j.message; } catch { /* そのまま */ }
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
  $('#banner').innerHTML = warnings.map(esc).join('<br>') + (warnings.length ? '<br><span class="hint">復旧手順: 24時間用PCのタスク「AICompanyBrain-OpsAgent」「AICompanyBrain-OpsFleetMonitor」を確認(システム管理者)</span>' : '');

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
      ${w.branch_name ? `<dt>作業ブランチ</dt><dd>${esc(w.branch_name)}</dd>` : ''}
      ${tests ? `<dt>テスト</dt><dd>${tests.ran ? (tests.passed ? '合格' : `不合格(終了コード ${esc(tests.exit)})`) + `「${esc(tests.cmd)}」` : esc(tests.note || '')}</dd>` : ''}
    </dl>
    ${w.diff_summary ? `<div><div class="hint">変更したファイル</div><pre class="box">${esc(w.diff_summary)}</pre></div>` : ''}
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
  ev.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await rpc('ops_chat_send', { p_content: text });
    await loadChat();
    waitForAnswer();
  } catch (e) { toast(e.message); input.value = text; }
}
// 返事が来るまでだけ短い間隔で見に行く(最長3分)。来たら止める。
function waitForAnswer() {
  clearInterval(chatWaitTimer);
  const started = Date.now();
  chatWaitTimer = setInterval(async () => {
    const list = await loadChat().catch(() => []);
    if (list.some((m) => m.role === 'ai') || Date.now() - started > 180000) {
      clearInterval(chatWaitTimer);
      if (!list.some((m) => m.role === 'ai') && Date.now() - started > 180000) toast('AI社員の返事が遅れています。上の赤い表示が出ていないか確認してください。');
      loadDashboard().catch(() => {});
    }
  }, 4000);
}

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#btn-mic');
  if (!SR) { btn.hidden = true; return; }
  btn.addEventListener('click', () => {
    const r = new SR(); r.lang = 'ja-JP'; r.interimResults = false;
    btn.disabled = true; btn.textContent = '🎤 聞いています…';
    r.onresult = (e) => { $('#chat-input').value += e.results[0][0].transcript; };
    r.onend = () => { btn.disabled = false; btn.textContent = '🎤 話す'; };
    r.onerror = () => { toast('音声を聞き取れませんでした'); };
    r.start();
  });
}

// ---------------- 権限・アプリ追加(システム管理者・社長) ----------------
async function loadAdmin() {
  if (access.global_rank < 3) return;
  $('#admin-area').hidden = false;
  $('#role-form [name=app]').innerHTML = '<option value="">全アプリ</option>' + access.apps.map((a) => `<option value="${esc(a.app_name)}">${esc(a.display_name)}</option>`).join('');
  const members = await rpc('ops_list_members', {});
  $('#members').innerHTML = members.length ? members.map((m) => `<div class="row">${esc(m.employee_code)} ${esc(m.employee_name)} — ${esc(ROLE_JA[m.role])}(${esc(m.app_name ? appName(m.app_name) : '全アプリ')})・付与 ${esc(m.granted_by || '')} ${esc(jst(m.granted_at))}</div>`).join('')
    : '<div class="empty">まだ誰にも権限を付与していません(社長は常に全権限)。</div>';
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
  if (!auth) { showLogin(); return; }
  try {
    access = await rpc('ops_my_access', {});
  } catch (e) { if (!$('#login-needed').hidden) return; toast(e.message); return; }
  $('#app').hidden = false;
  $('#who').textContent = `${access.employee_name}(${RANK_JA[access.global_rank] || '一般社員'})`;
  await Promise.all([loadDashboard(), loadChat()]);
  loadAdmin().catch((e) => toast(e.message));
  setupMic();
  setInterval(() => { if (!document.hidden) loadDashboard().catch(() => {}); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDashboard().catch(() => {}); });
}

document.addEventListener('click', (e) => {
  const rep = e.target.closest('[data-report]'); if (rep) { e.stopPropagation(); openNewItem(rep.dataset.report); return; }
  const it = e.target.closest('[data-item]'); if (it) { openItem(it.dataset.item).catch((err) => toast(err.message)); }
});
$('#btn-refresh').addEventListener('click', () => loadDashboard().then(() => toast('更新しました')).catch((e) => toast(e.message)));
$('#btn-new-item').addEventListener('click', () => openNewItem());
$('#new-form').addEventListener('submit', submitNewItem);
$('#new-form [name=app]').addEventListener('change', syncKindOptions);
$('#new-form [value=cancel]').addEventListener('click', () => $('#dlg-new').close());
$('#chat-form').addEventListener('submit', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat(e); });
$('#role-form').addEventListener('submit', submitRole);
$('#app-form').addEventListener('submit', submitApp);
init();
