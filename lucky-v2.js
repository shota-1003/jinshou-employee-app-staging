(function () {
  'use strict';
  let frame = null;
  let dispose = null;
  const prizeIds = { blue: '1000', green: '2000', red: '3000', gold: '5000', rainbow: '10000', hotel: 'hotel' };
  function close() { if (dispose) dispose(); }
  function show(result, preview = false, forcedMode) {
    close();
    const previous = document.activeElement;
    const prize = result.won === false ? 'missA' : prizeIds[result.theme];
    if (!prize) throw new Error('賞品の種類を確認できませんでした');
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const r = random[0] / 4294967296;
    const mode = forcedMode || (result.won === false ? 'normal' : prize === 'hotel' && r < .08 ? 'silent' : r < .18 ? 'revival' : prize !== '1000' && r < .30 ? 'upgrade' : r < .36 ? 'goldhint' : r < .42 ? 'delay' : 'normal');
    const shell = document.createElement('dialog');
    shell.setAttribute('aria-label', 'ラッキー賞');
    shell.style.cssText = 'position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#08090e;';
    frame = document.createElement('iframe');
    const player = frame;
    player.title = 'ラッキー賞の演出';
    player.src = './lucky-premium/portable.html';
    player.allow = 'autoplay';
    player.style.cssText = 'width:100%;height:100%;border:0;display:block';
    shell.append(player);
    const exit = document.createElement('button');
    exit.textContent = '閉じる';
    exit.style.cssText = 'position:absolute;top:8px;right:10px;z-index:5;color:white;background:#15151b;border:1px solid #766243;border-radius:4px;padding:8px';
    shell.append(exit);
    const receive = e => {
      if (e.origin !== location.origin || e.source !== player.contentWindow) return;
      if (e.data?.type === 'lucky-player-ready') player.contentWindow.postMessage({ type: 'lucky-player-result', prize, mode, preview }, location.origin);
      if (e.data?.type === 'lucky-player-close') close();
    };
    dispose = () => { window.removeEventListener('message', receive); shell.close(); shell.remove(); frame = null; dispose = null; previous?.focus(); };
    window.addEventListener('message', receive);
    shell.addEventListener('cancel', e => { e.preventDefault(); close(); });
    exit.addEventListener('click', close);
    document.body.append(shell);
    shell.showModal();
  }

  const reasonText = {
    yesterday_report: '昨日分の日報を提出してください',
    today_report: '今日分の日報を提出してください',
    subcontractor_reports: '同じ現場の外注さんの日報を待っています',
    off: '今日は抽選対象の出勤日ではありません',
    sunday: '日曜日は抽選がお休みです',
  };
  let cleanupHome = null;
  function mountHome({ rpc, employeeCode, isCurrent }) {
    cleanupHome?.();
    const anchor = document.getElementById('home-lucky-card');
    if (!anchor) return;
    anchor.style.display = 'none';
    const card = document.createElement('section');
    card.style.cssText = 'padding:16px;margin:12px 0;border:1px solid #c6a56c;border-radius:12px;background:#fffaf0;color:#332914';
    card.hidden = true;
    const heading = document.createElement('strong'); heading.textContent = '今日のラッキー賞';
    const message = document.createElement('p'); message.setAttribute('aria-live', 'polite');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'approve-btn'; button.hidden = true;
    card.append(heading, message, button); anchor.after(card);
    let disposed = false, checking = false, claiming = false, result = null, drawDate = null;
    function alive() { return !disposed && isCurrent(); }
    async function refresh() {
      if (!alive()) { cleanupHome?.(); return; }
      if (document.hidden || checking || claiming) return;
      checking = true;
      try {
        const status = await rpc('lucky_v2_status', { p_employee_code: employeeCode });
        if (!alive()) return;
        card.hidden = !status?.enabled;
        drawDate = status?.date || null;
        heading.textContent = drawDate ? `${drawDate} のラッキー賞` : 'ラッキー賞';
        result = status?.state === 'claimed' ? status.result : null;
        button.hidden = !(status?.state === 'ready' || result);
        button.textContent = result ? '結果をもう一度見る' : '抽選を引く';
        message.textContent = result ? '今日の抽選は完了しました' : status?.state === 'ready' ? '日報がそろいました。抽選を引けます！' : status?.state === 'waiting' ? (status.reasons || []).map(r => reasonText[r] || '必要な日報の提出を待っています').join('。') : '配置の確定・参加条件を確認中です';
      } catch { if (alive()) { button.hidden = true; message.textContent = '抽選の状態を確認できません。通信状況を確認してください。'; } }
      finally { checking = false; }
    }
    button.addEventListener('click', async () => {
      if (claiming || !alive()) return;
      if (result) { show(result); return; }
      claiming = true; button.disabled = true;
      try {
        const received = await rpc('lucky_v2_claim', { p_employee_code: employeeCode, p_draw_date: drawDate });
        if (!alive()) return;
        result = received;
        show(received);
        button.textContent = '結果をもう一度見る';
        message.textContent = '今日の抽選は完了しました';
      } catch { if (alive()) message.textContent = '抽選を確認できませんでした。もう一度お試しください。'; }
      finally { claiming = false; button.disabled = false; }
    });
    const timer = setInterval(refresh, 15000);
    const visibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visibility);
    cleanupHome = () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); card.remove(); cleanupHome = null; close(); };
    void refresh();
  }
  window.LuckyV2 = { show, close, mountHome };
})();
