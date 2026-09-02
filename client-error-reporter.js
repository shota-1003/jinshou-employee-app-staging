// このファイルは自動生成の複製です。手で編集しないでください。
// 正本: webapp/lib/client-error-reporter.js (node scripts/sync-webapp-shared-lib.js で同期)
'use strict';
// 迅翔興業 全Webアプリ共通のクライアント側エラー報告モジュール(2026-09-02、ユーザー指示)。
//
// 【正本】このファイルが唯一の実装であり、各webapp/*/配下にあるclient-error-reporter.jsは
// すべて node scripts/sync-webapp-shared-lib.js による自動コピーの複製物(手で編集しない)。
// 各Webアプリ(webapp/employee-app・webapp/mail-secretary・webapp/ai-ops-center・
// webapp/assignment-calendar)はNetlifyへ個別ディレクトリとしてデプロイされ、実行時に
// webapp/lib/を相対パスで参照できない(scripts/lib/netlify-deploy.jsが各appディレクトリを
// 単独でデプロイする構成のため)。そのため「1箇所だけ書く」を実現する手段として、
// このファイルをbuild/deploy前に各appディレクトリへ機械的にコピーする方式を採る
// (ロジックを手で複製するのではなく、正本を機械コピーするだけ)。
//
// 【既存基盤の再利用(SKILL-002/003)】新しいインシデント管理基盤・新しいエラーテーブルは
// 作らない。既存のreport_error()/queue_error_notification()(database/supabase/
// 202608291600_error-auto-healing.sql)へそのまま接続するだけの薄い層。
//
// 使い方(各app.js側):
//   <script src="client-error-reporter.js"></script> をapp.js/index.htmlのscriptタグより前に読み込む。
//   window.ClientErrorReporter.init({ supabaseUrl, supabaseAnonKey, agentName, getEmployeeCode });
//   window.ClientErrorReporter.reportHttpError(endpoint, status, message, extra);
//   window.ClientErrorReporter.reportRuntimeError(error, extra); // window.onerror等から
//   window.ClientErrorReporter.reportRealtimeDisconnect(channelName, reason);
//   init()を呼ぶだけでwindow.onerror/unhandledrejectionは自動フックされる。

(function (global) {
  var CONFIG = null;
  // 2026-09-02追加(ユーザー指示■3: 重複エラー抑制): 同一fingerprintを短時間に何度も
  // report_error()へPOSTしてネットワーク往復を無駄打ちしないよう、クライアント側でも
  // 簡易クールダウンを設ける(サーバー側のreport_error()自体は既にfingerprint単位で
  // 1行に集約するが、"1分間に100回fetchが失敗する"ようなケースでPOST自体を100回送るのは
  // 無駄なため、送信頻度そのものを間引く。DB側の集約ロジックとは独立した、送信側の間引き)。
  var lastSentAt = {}; // fingerprint -> timestamp(ms)
  var CLIENT_DEDUPE_WINDOW_MS = 5000;

  function nowIso() { return new Date().toISOString(); }

  function genRequestId() {
    // crypto.randomUUID()が使えない古い環境向けの単純フォールバック(セキュリティ用途ではない、
    // 相関ID生成のみが目的)。
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function init(opts) {
    CONFIG = {
      supabaseUrl: opts.supabaseUrl,
      supabaseAnonKey: opts.supabaseAnonKey,
      agentName: opts.agentName,
      getEmployeeCode: opts.getEmployeeCode || function () { return null; },
      getDeviceToken: opts.getDeviceToken || function () { return null; },
    };
    // 2026-09-02追加(ユーザー指示■1: JavaScript runtime error / Unhandled Promise rejection)。
    global.addEventListener('error', function (ev) {
      reportRuntimeError(ev.error || new Error(ev.message), { source: ev.filename, line: ev.lineno, col: ev.colno });
    });
    global.addEventListener('unhandledrejection', function (ev) {
      var reason = ev.reason;
      reportRuntimeError(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandled_promise_rejection' });
    });
  }

  function severityForStatus(status) {
    if (status === 401 || status === 403 || status >= 500) return 3;
    if (status === 429) return 2; // レート制限、一時的な可能性が高いが要監視
    return 2;
  }
  function categoryForStatus(status) {
    if (status === 401) return 'auth_401';
    if (status === 403) return 'auth_403';
    if (status === 429) return 'rate_limited_429';
    if (status === 408) return 'timeout_408';
    if (status >= 500) return 'server_5xx';
    if (status === 404) return 'not_found_404';
    return 'client_4xx';
  }

  function postJson(path, body) {
    return fetch(CONFIG.supabaseUrl + '/rest/v1/' + path, {
      method: 'POST',
      headers: { apikey: CONFIG.supabaseAnonKey, Authorization: 'Bearer ' + CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) { return res.json().catch(function () { return null; }); });
  }

  // fingerprint単位でreport_error()→(新規/再発時のみ)queue_error_notification()を呼ぶ共通経路。
  function sendReport(errorType, message, context, fingerprint, severity) {
    if (!CONFIG) return; // init()未呼び出しでも他機能を壊さない
    var now = Date.now();
    if (lastSentAt[fingerprint] && (now - lastSentAt[fingerprint]) < CLIENT_DEDUPE_WINDOW_MS) return;
    lastSentAt[fingerprint] = now;
    try {
      context = Object.assign({
        request_id: genRequestId(),
        route: global.location ? global.location.pathname : null,
        url: global.location ? global.location.href : null,
        employee_code: CONFIG.getEmployeeCode() || null,
        occurred_at: nowIso(),
        user_agent: global.navigator ? global.navigator.userAgent : null,
      }, context || {});
      postJson('rpc/report_error', {
        p_source_agent: CONFIG.agentName,
        p_error_type: errorType,
        p_message: String(message || '').slice(0, 500),
        p_context: context,
        p_fingerprint: fingerprint,
        p_severity: severity,
      }).then(function (rows) {
        var row = Array.isArray(rows) ? rows[0] : rows;
        if (!row || !row.id) return;
        // 通知cooldownは既存queue_error_notification()へ完全に委譲(独自ロジックを重複させない)。
        postJson('rpc/queue_error_notification', { p_error_id: row.id, p_min_interval_minutes: 60 }).catch(function () {});
      }).catch(function () {});
    } catch (e) { /* 報告自体の失敗はアプリ動作へ影響させない */ }
  }

  function reportHttpError(endpoint, status, message, extra) {
    var category = categoryForStatus(status);
    var fingerprint = 'client_http_error:' + (CONFIG ? CONFIG.agentName : 'unknown') + ':' + category;
    sendReport('client_http_error', 'Production ' + status + ': ' + endpoint + (message ? ' - ' + message : ''),
      Object.assign({ endpoint: endpoint, status_code: status }, extra || {}), fingerprint, severityForStatus(status));
  }

  function reportFetchFailure(endpoint, reason, extra) {
    // ネットワーク遮断・timeout・CORS等、HTTPステータス自体が返らない失敗。
    var fingerprint = 'client_fetch_failure:' + (CONFIG ? CONFIG.agentName : 'unknown') + ':' + endpoint;
    sendReport('client_fetch_failure', 'Production通信失敗: ' + endpoint + (reason ? ' - ' + reason : ''),
      Object.assign({ endpoint: endpoint }, extra || {}), fingerprint, 3);
  }

  function reportRuntimeError(err, extra) {
    var msg = (err && err.message) || String(err);
    // stackの先頭数行だけをfingerprintに使い、同じ箇所で起きる大量の同種エラーを1件へ集約する。
    var stackKey = (err && err.stack) ? err.stack.split('\n').slice(0, 2).join('|') : msg;
    var fingerprint = 'client_runtime_error:' + (CONFIG ? CONFIG.agentName : 'unknown') + ':' + stackKey.slice(0, 150);
    sendReport('client_runtime_error', msg, Object.assign({ stack: (err && err.stack) ? String(err.stack).slice(0, 2000) : null }, extra || {}), fingerprint, 2);
  }

  function reportRealtimeDisconnect(channelName, reason) {
    var fingerprint = 'client_realtime_disconnect:' + (CONFIG ? CONFIG.agentName : 'unknown') + ':' + channelName;
    sendReport('client_realtime_disconnect', 'Realtime切断: ' + channelName + (reason ? ' - ' + reason : ''),
      { channel: channelName, reason: reason }, fingerprint, 2);
  }

  global.ClientErrorReporter = {
    init: init,
    reportHttpError: reportHttpError,
    reportFetchFailure: reportFetchFailure,
    reportRuntimeError: reportRuntimeError,
    reportRealtimeDisconnect: reportRealtimeDisconnect,
  };
})(window);
