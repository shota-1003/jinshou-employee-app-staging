'use strict';

// Candidate adapter for employee-app and subcontractor-app. Call after login and
// after the existing report and eligible site list have been fetched successfully.
(function (root) {
  const handoff = root.KyDailyReportHandoff;
  if (!handoff) throw new Error('ky-daily-report-handoff.js must load first');
  const error = (message) => ({ kind: 'notice', message });

  async function suggestion({ actorKind, actorCode, actorKey, date, existing, eligibleSiteIds, rpc }) {
    if (!Array.isArray(existing) || (actorKind === 'worker' && !Array.isArray(eligibleSiteIds))) {
      handoff.clear();
      return error('日報または現場候補を確認できませんでした。通常の入力画面から確認してください。');
    }
    const pending = handoff.consume(actorKind, actorCode, date);
    if (!pending) return { kind: 'none' };
    if (existing.length) return error('この日の日報は入力済みです。内容を確認してください。KYから自動で上書きしません。');
    let source;
    try {
      source = await rpc('site_ky_daily_report_source', {
        p_actor_kind: actorKind, p_actor_code: actorCode,
        p_site_key: pending.siteKey, p_date: date,
      });
    } catch (_) {
      return error('KYの日報候補を取得できませんでした。通常の入力画面から確認してください。');
    }
    const expectedKey = actorKind === 'worker' ? actorKey : 'employee:' + actorCode;
    if (typeof expectedKey !== 'string' ||
        (actorKind === 'worker' && !/^worker:[1-9]\d*$/.test(expectedKey))) {
      return error('本人情報を確認できませんでした。通常の入力画面から確認してください。');
    }
    const item = handoff.reportSource(source, pending, expectedKey);
    if (!item) return error('KYの終業署名または本人情報を確認できませんでした。通常の入力画面から確認してください。');
    let siteIds = eligibleSiteIds;
    if (actorKind === 'employee') {
      if (!item.siteName) return error('KYの現場名を確認できませんでした。通常の入力画面から確認してください。');
      try {
        const found = await rpc('search_sites', {
          p_query: item.siteName, p_employee_code: actorCode, p_daily_report_only: true,
        });
        siteIds = Array.isArray(found) ? found.map((site) => site.id) : null;
      } catch (_) { siteIds = null; }
    }
    const inList = Array.isArray(siteIds) && siteIds.some((id) => Number(id) === item.siteId);
    const canAddSignedWorkerSite = actorKind === 'worker' && !inList &&
      item.dailyReportSiteEligible && !!item.siteName;
    if (!inList && !canAddSignedWorkerSite) {
      return error('この現場は日報で選択できません。会社の担当者に確認してください。');
    }
    return { kind: 'prefill', siteId: item.siteId, siteName: item.siteName, notes: item.notes,
      addSignedWorkerSite: canAddSignedWorkerSite,
      message: 'KYから現場と作業内容の候補を入れました。勤務区分・人工・残業等を確認してから、ご自身で提出してください。' };
  }

  root.KyDailyReportAdapters = { suggestion };
})(typeof window === 'undefined' ? globalThis : window);
