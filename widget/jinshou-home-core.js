// 迅翔興業 社員ホームウィジェット 本体 (Scriptable版 / v1)
// ---------------------------------------------------------------------------
// このファイルは「本体」で、社員のiPhoneには直接貼らない。
// 社員が貼るのは25行ほどの短い読み込み用スクリプトだけで、そちらが
// このファイルをネット越しに取ってきて importModule で読み込む。
//
//   社員のiPhone            公開URL(このファイル)         Supabase
//   ├ 読み込み用(短い)  →  jinshou-home-core.js   →  assignment_get_my_widget
//   └ 設定(社員番号・トークン)は読み込み用の側だけが持つ
//
// こうしている理由:
//   ・500行の貼り付けは、途中で1文字欠けるだけで動かなくなる(実機で発生した)
//   ・直したいときに、社員へ貼り直しをお願いしなくて済む
//
// 【設計上の約束】
//   ・このファイルは公開URLに置くので、秘密は一切持たない。
//     社員番号・トークン・接続先は、呼び出す側から run(cfg) で渡してもらう。
//   ・ロック画面では detail=minimal で取得する。現場名はサーバから受け取らない。
//   ・表示の組み立て(buildView)は素のJavaScriptにしてあり、Windows側の
//     scripts/test-widget-view.js から同じ関数を直接テストできる。
// ---------------------------------------------------------------------------

// ===========================================================================
// 1. 表示の組み立て(Scriptableに依存しない純粋な部分)
// ===========================================================================

const FAMILY_DETAIL = {
    small: 'full',
    medium: 'full',
    large: 'full',
    extraLarge: 'full',
    accessoryRectangular: 'minimal',
    accessoryInline: 'minimal',
    accessoryCircular: 'minimal',
};

const FAMILY_DAYS = {
    small: 2,
    medium: 2,
    large: 7,
    extraLarge: 7,
    accessoryRectangular: 2,
    accessoryInline: 2,
    accessoryCircular: 1,
};

// 画面に出す版番号。iPhoneへ届いたのが古い版かどうかを、実機を見ただけで判別するため。
// 見た目を変えたら必ず1つ上げる(2026-09-05、届いていた版が古く「変わっていない」と
// 見えた実例があったため)。
const WIDGET_VERSION = 'v6';

function isLockScreen(family) {
    return String(family || '').startsWith('accessory');
}

/** '2026-09-05' → '9/5(金)' */
function shortDate(day) {
    const m = Number(day.date.slice(5, 7));
    const d = Number(day.date.slice(8, 10));
    return `${m}/${d}(${day.weekday})`;
}

/** 1件の配置を1行の文字列にする。現場名が無い(minimal)ときは件数だけ。 */
function assignmentLine(item) {
    if (!item) return '';
    const mark = item.kind === 'haul' ? '🚚' : '';
    const name = item.site || '(現場名は非表示)';
    return `${mark}${name}`;
}

function timeLine(item) {
    if (!item) return '';
    const parts = [];
    if (item.meeting_time) parts.push(`${item.meeting_time}集合`);
    if (item.time_label) parts.push(item.time_label);
    return parts.join(' / ');
}

/**
 * 誰と行くか。サーバが返す members をそのまま出す。
 * members は **自分が先頭**で、運搬で入っている人には🚚が付く。
 * 自分が運搬担当の日に「あなたがトラックに乗る」と分かるようにするため、
 * 自分も必ず含める(2026-09-06 実機指摘)。
 * ロック画面用の minimal では members が返らないので、その場合は空になる。
 * 長すぎると行が潰れるので文字数で切るが、自分が先頭なので自分の名前は必ず残る。
 */
function withLine(item) {
    const raw = (item && item.members) || '';
    if (!raw) return '';
    const MAX = 32;
    return raw.length > MAX ? raw.slice(0, MAX) + '…' : raw;
}

/**
 * ウィジェットに出す内容を決める。
 * 返り値は描画方法に依存しない素のデータなので、テストからそのまま検証できる。
 */
function buildView(data, family) {
    const lock = isLockScreen(family);
    const days = data.days || [];
    const today = days.find((d) => d.day_kind === 'today') || null;
    const tomorrow = days.find((d) => d.day_kind === 'tomorrow') || null;
    const s = data.summary || {};

    const badges = [];
    if (Number(s.unconfirmed_total) > 0) badges.push({ kind: 'unconfirmed', text: `未確認${s.unconfirmed_total}` });
    if (Number(s.daily_report_pending) > 0) badges.push({ kind: 'report', text: `日報未提出${s.daily_report_pending}` });

    // ウィジェット面に出す行動の導線。押した先は既存の画面(新しい画面は作らない)。
    //
    // 2026-09-05: 以前は「未確認があるとき」「日報が未提出のとき」しか出していなかったため、
    // 実機では配置の無い日にどちらも出ず、ウィジェットから何もできなかった。
    // ホーム画面から1タップで確認・日報へ入れることがこのウィジェットの目的なので、
    // 導線は常に出し、状況に応じて文言と件数だけを変える。
    // 3つとも、押した先で実際に操作できる画面へ入る。
    //   配置表 … その日の配置カレンダー
    //   日報   … その日の日報の入力画面(日付が入った状態)
    //   確認   … ホームの「配置予定」カード。ここに「配置を確認する」ボタンが並んでいる
    const actions = [];
    const day = today || tomorrow;
    if (day) {
        actions.push({ key: 'calendar', label: '配置表', url: `calendar/?date=${day.date}` });
        const rp = day.daily_report || {};
        actions.push({
            key: 'report',
            label: rp.submitted ? '日報を直す' : '日報を書く',
            url: `?next=daily-report&date=${day.date}`,
        });
    }
    // 未確認の件数は、今日と明日を合わせて出す(「何件残っているか」が知りたいため)。
    const pending = (Number(today && today.unconfirmed) || 0) + (Number(tomorrow && tomorrow.unconfirmed) || 0);
    actions.push({
        key: 'confirm',
        label: pending > 0 ? `確認 ${pending}件` : '確認',
        url: '?next=assignment-confirm',
    });

    const view = {
        family,
        lock,
        title: lock ? '迅翔' : '迅翔興業',
        badges,
        updatedAt: (data.generated_at || '').slice(11, 16),
        rows: [],
        actions,
        footer: '',
        url: null,
    };

    // ロック画面: 現場名を持っていないので件数と時刻だけを出す
    if (lock) {
        if (family === 'accessoryCircular') {
            view.rows.push({ main: String(s.today_count || 0), sub: '件' });
        } else {
            const t = today ? `今日 ${today.count}件` : '今日 0件';
            const first = today && today.assignments[0];
            const tm = first && first.meeting_time ? ` ${first.meeting_time}` : '';
            const tm2 = tomorrow ? ` / 明日 ${tomorrow.count}件` : '';
            view.rows.push({ main: `${t}${tm}${tm2}`, sub: '' });
            if (family === 'accessoryRectangular' && badges.length) {
                view.rows.push({ main: badges.map((b) => b.text).join(' '), sub: '', warn: true });
            }
        }
        view.actions = [];
        view.url = 'calendar/';
        return view;
    }

    // 小: 今日を主役にして、明日は1行だけ
    if (family === 'small') {
        if (today && today.count > 0) {
            const first = today.assignments[0];
            view.rows.push({
                label: `今日 ${shortDate(today)}`,
                main: assignmentLine(first),
                sub: timeLine(first),
                color: first.color,
                confirmed: first.confirmed,
                important: first.has_important,
                more: today.count > 1 ? `ほか${today.count - 1}件` : '',
                url: `calendar/?date=${today.date}`,
            });
        } else {
            view.rows.push({ label: today ? `今日 ${shortDate(today)}` : '今日', main: '配置なし', sub: '', color: null });
        }
        view.footer = tomorrow
            ? `明日 ${tomorrow.count}件${tomorrow.unconfirmed > 0 ? ` ・未確認${tomorrow.unconfirmed}` : ''}`
            : '';
        // 小サイズは3つ並べる面積が無い。面全体を押すと配置表が開くので、
        // ボタンは日報と確認だけ残す(こちらは面全体からは行けないため)。
        // 幅が狭いので文字も短くする(「日報を書く」だと2つ並べたとき潰れる)。
        view.actions = actions.filter((a) => a.key !== 'calendar')
            .map((a) => (a.key === 'report'
                ? { ...a, label: /直す/.test(a.label) ? '日報直す' : '日報' }
                : a));
        view.url = 'calendar/';
        return view;
    }

    // 中: 今日と明日を並べる
    if (family === 'medium') {
        for (const day of [today, tomorrow]) {
            if (!day) continue;
            const first = day.assignments[0];
            view.rows.push({
                label: `${day.day_kind === 'today' ? '今日' : '明日'} ${shortDate(day)}`,
                main: day.count > 0 ? assignmentLine(first) : '配置なし',
                sub: day.count > 0 ? timeLine(first) : '',
                color: first ? first.color : null,
                confirmed: first ? first.confirmed : null,
                important: first ? first.has_important : false,
                more: day.count > 1 ? `ほか${day.count - 1}件` : '',
                needsReport: !!(day.daily_report && day.daily_report.required && !day.daily_report.submitted),
                // 誰と行くか(中サイズも1行だけ入る)
                withWho: day.count > 0 ? withLine(first) : '',
                url: `calendar/?date=${day.date}`,
                inlineLabel: true,
            });
        }
        // 更新時刻は見出しへ出す(下に行を足すと実機の高さに収まらない)
        view.footer = '';
        view.url = 'calendar/';
        return view;
    }

    // 大: 予定のある日と今日だけを出す。
    // 以前は1週間を全部並べていたが、予定の無い日が「—」だけで場所を取り、
    // 面積の大半が空白になっていた(2026-09-06 実機指摘)。空いた分は文字を大きくし、
    // 誰と行くか(同行者)を出すのに使う。
    const shownDays = days.filter((d) => d.count > 0 || d.day_kind === 'today').slice(0, 5);
    for (const day of (shownDays.length ? shownDays : days.slice(0, 2))) {
        const first = day.assignments[0];
        view.rows.push({
            label: shortDate(day),
            main: day.count > 0 ? assignmentLine(first) : '配置なし',
            sub: day.count > 0 ? timeLine(first) : '',
            // 誰と行くか。サーバは自分以外のメンバーを短い名前で返す。
            withWho: day.count > 0 ? withLine(first) : '',
            color: first ? first.color : null,
            confirmed: first ? first.confirmed : null,
            important: first ? first.has_important : false,
            more: day.count > 1 ? `+${day.count - 1}` : '',
            holiday: !!day.is_holiday,
            weekend: day.weekday === '土' || day.weekday === '日',
            needsReport: !!(day.daily_report && day.daily_report.required && !day.daily_report.submitted),
            empty: day.count === 0,
            url: `calendar/?date=${day.date}`,
        });
    }
    view.footer = `今週 ${data.summary.week_count}件 ・ 更新 ${view.updatedAt} ・ ${WIDGET_VERSION}`;
    view.url = 'calendar/';
    return view;
}

/** 通信できなかったときに出す内容 */
function buildErrorView(family, message, cachedAt) {
    return {
        family,
        lock: isLockScreen(family),
        title: '迅翔興業',
        badges: [],
        rows: [{ main: message, sub: cachedAt ? `最後に取れたのは ${cachedAt}` : '', warn: true }],
        footer: '',
        updatedAt: '',
        url: 'calendar/',
    };
}

// ===========================================================================
// 2. データ取得(失敗しても最後に取れた内容を出す)
// ===========================================================================

const CACHE_FILE = 'jinshou-widget-cache.json';

function cachePath() {
    const fm = FileManager.local();
    return fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
}

function readCache() {
    const fm = FileManager.local();
    const p = cachePath();
    if (!fm.fileExists(p)) return null;
    try { return JSON.parse(fm.readString(p)); } catch (e) { return null; }
}

function writeCache(data) {
    try { FileManager.local().writeString(cachePath(), JSON.stringify(data)); } catch (e) { /* 書けなくても表示は続ける */ }
}

async function fetchPayload(cfg, detail, days) {
    const req = new Request(`${cfg.url}/rest/v1/rpc/assignment_get_my_widget`);
    req.method = 'POST';
    req.headers = {
        apikey: cfg.anon,
        Authorization: `Bearer ${cfg.anon}`,
        'Content-Type': 'application/json',
        'X-Device-Token': cfg.token,
    };
    req.body = JSON.stringify({ p_employee_code: cfg.code, p_detail: detail, p_days: days });
    req.timeoutInterval = 15;
    const res = await req.loadJSON();
    if (!res || res.v !== 1) throw new Error(res && res.message ? res.message : '取得に失敗しました');
    return res;
}

// ===========================================================================
// 3. 描画
// ===========================================================================

// 色は Scriptable の Color を使うため、読み込み時ではなく描画時に作る
// (Windows側のテストが同じファイルを require できるようにするため)。
function palette() {
    return {
        bg1: new Color('#12213f'),
        bg2: new Color('#0f1c33'),
        text: new Color('#f2f5fa'),
        sub: new Color('#9fb0cc'),
        accent: new Color('#d99a08'),
        warn: new Color('#ff8f6b'),
        ok: new Color('#7fd48a'),
    };
}

function paintWidget(view, portalUrl) {
    const COLORS = palette();
    const w = new ListWidget();
    if (!view.lock) {
        const g = new LinearGradient();
        g.colors = [COLORS.bg1, COLORS.bg2];
        g.locations = [0, 1];
        w.backgroundGradient = g;
        w.setPadding(12, 12, 12, 12);
    }
    if (view.url) w.url = portalUrl + view.url;

    if (view.lock) {
        for (const r of view.rows) {
            const t = w.addText(r.main);
            t.font = Font.systemFont(view.family === 'accessoryCircular' ? 20 : 13);
            if (r.sub) {
                const s2 = w.addText(r.sub);
                s2.font = Font.systemFont(10);
            }
        }
        return w;
    }

    // 見出し
    const head = w.addStack();
    head.centerAlignContent();
    const title = head.addText(view.title);
    title.font = Font.semiboldSystemFont(12.5);
    title.textColor = COLORS.accent;
    if (view.family === 'medium' && view.updatedAt) {
        head.addSpacer(5);
        const u = head.addText(`${view.updatedAt} ${WIDGET_VERSION}`);
        u.font = Font.systemFont(10);
        u.textColor = COLORS.sub;
    }
    head.addSpacer();
    for (const b of view.badges) {
        const bt = head.addText(b.text);
        bt.font = Font.semiboldSystemFont(11);
        bt.textColor = b.kind === 'unconfirmed' ? COLORS.warn : COLORS.accent;
        head.addSpacer(6);
    }
    w.addSpacer(view.family === 'large' ? 6 : 8);

    for (const r of view.rows) {
        const row = w.addStack();
        row.layoutHorizontally();
        row.centerAlignContent();
        if (r.url) row.url = portalUrl + r.url;

        if (r.color) {
            const bar = row.addStack();
            bar.size = new Size(3, view.family === 'large' ? 34 : 30);
            bar.backgroundColor = new Color(String(r.color).replace('#', ''));
            bar.cornerRadius = 2;
            row.addSpacer(6);
        }

        const col = row.addStack();
        col.layoutVertically();
        const mainText = r.main + (r.more ? ` ${r.more}` : '');
        if (r.inlineLabel && r.label) {
            // 中サイズ: 日付と現場名を同じ行に置いて2行に収める
            const line = col.addStack();
            line.layoutHorizontally();
            line.bottomAlignContent();
            const l = line.addText(`${r.label} `);
            l.font = Font.boldSystemFont(9.5);
            l.textColor = COLORS.accent;
            const m2 = line.addText(mainText);
            m2.font = Font.semiboldSystemFont(13);
            m2.textColor = r.empty ? COLORS.sub : COLORS.text;
            m2.lineLimit = 1;
        } else {
            if (r.label) {
                const l = col.addText(r.label);
                l.font = Font.systemFont(view.family === 'large' ? 12 : 11.5);
                l.textColor = r.holiday || r.weekend ? COLORS.warn : COLORS.sub;
            }
            const m = col.addText(mainText);
            m.font = Font.semiboldSystemFont(view.family === 'large' ? 15 : 15);
            m.textColor = r.empty ? COLORS.sub : COLORS.text;
            m.lineLimit = 1;
        }
        if (r.sub) {
            const s2 = col.addText(r.sub);
            s2.font = Font.systemFont(view.family === 'large' ? 12 : 11.5);
            s2.textColor = COLORS.sub;
            s2.lineLimit = 1;
        }
        // 誰と行くか。空いている場所に出す(2026-09-06 実機要望)。
        if (r.withWho) {
            const w2 = col.addText(r.withWho);
            w2.font = Font.systemFont(view.family === 'large' ? 11.5 : 11);
            w2.textColor = COLORS.sub;
            w2.lineLimit = 1;
        }

        row.addSpacer();
        const marks = [];
        if (r.important) marks.push('❗');
        if (r.confirmed === false) marks.push('未');
        else if (r.confirmed === true) marks.push('✓');
        if (r.needsReport) marks.push('日報');
        if (marks.length) {
            const mk = row.addText(marks.join(' '));
            mk.font = Font.systemFont(11.5);
            mk.textColor = r.confirmed === false || r.needsReport ? COLORS.warn : COLORS.ok;
        }
        w.addSpacer(view.family === 'large' ? 7 : 8);
    }

    w.addSpacer();

    // 実機でここが原因でウィジェット全体が真っ白になったことがある(2026-09-05)。
    // ボタンは「あれば便利」なものなので、描けなかったときは黙って諦め、
    // 配置の一覧だけは必ず出す。1か所の失敗で全部が見えなくなるのを防ぐ。
    if (view.actions && view.actions.length) try {
        // 2026-09-05 実機指摘「ボタンが小さすぎる」。
        //
        // ここは実機で一度ウィジェットが真っ白になった場所である。原因を切り分けた結果、
        // size / centerAlignContent / borderWidth / minimumScaleFactor / spacing といった
        // 新しい書き方をまとめて足したことが引き金だった。実機で確実に動いていた書き方
        // (setPadding + cornerRadius + backgroundColor + font)はそのまま残し、
        // 大きさの数値だけを上げる方針に変えた。
        // 余白を上下11pt・左右16ptにすると、15ptの文字と合わせておおむね40ptになり、
        // 指1本で押せる大きさになる。
        // 横いっぱいに等分する。中に addSpacer を入れた入れ物は「余っている幅まで広がる」ので、
        // 3つ並べれば自然に3等分になる。size で幅を決めると中身の幅に縮んでしまい、
        // 右側に空白が残る(2026-09-05 実機指摘)。
        const small = view.family === 'small';
        const bar = w.addStack();
        bar.layoutHorizontally();
        view.actions.forEach((a, i) => {
            const b = bar.addStack();
            b.layoutHorizontally();
            b.setPadding(small ? 10 : 13, 4, small ? 10 : 13, 4);
            b.cornerRadius = 10;
            // 確認は残件があるときだけ目立たせる(いつも黄色いと目が慣れて効かなくなる)
            const urgent = a.key === 'confirm' && /\d+件/.test(a.label);
            b.backgroundColor = urgent
                ? new Color('#d99a08', 0.32) : new Color('#9fb0cc', 0.22);
            b.url = portalUrl + a.url;
            b.addSpacer();
            const t = b.addText(a.label);
            t.font = Font.semiboldSystemFont(small ? 13 : 15);
            t.textColor = urgent ? COLORS.accent : COLORS.text;
            t.lineLimit = 1;
            t.minimumScaleFactor = 0.7;
            b.addSpacer();
            if (i < view.actions.length - 1) bar.addSpacer(small ? 5 : 7);
        });
        w.addSpacer(6);
    } catch (e) {
        // ボタンが描けなくても一覧は出す(理由はScriptableのログに残る)
        console.log('ボタンを描けませんでした: ' + (e && e.message ? e.message : e));
    }

    if (view.footer) {
        const f = w.addText(view.footer);
        f.font = Font.systemFont(10);
        f.textColor = COLORS.sub;
    }
    return w;
}

// ===========================================================================
// 4. 実行(読み込み用スクリプトから呼ばれる入口)
// ===========================================================================

/**
 * cfg = { url, anon, code, token, portal }
 * 設定はこのファイルには持たせず、呼び出す側から渡してもらう。
 */
async function run(cfg) {
    const family = (typeof config !== 'undefined' && config.widgetFamily) || 'medium';
    const inWidget = typeof config !== 'undefined' && config.runsInWidget;
    const detail = FAMILY_DETAIL[family] || 'full';
    const days = FAMILY_DAYS[family] || 7;

    let view;
    try {
        const data = await fetchPayload(cfg, detail, days);
        if (detail === 'full') writeCache(data);
        view = buildView(data, family);
    } catch (e) {
        const cached = detail === 'full' ? readCache() : null;
        view = cached
            ? Object.assign(buildView(cached, family), { footer: `つながりません(${(cached.generated_at || '').slice(11, 16)}時点)` })
            : buildErrorView(family, `つながりません: ${e.message}`, null);
    }

    const w = paintWidget(view, cfg.portal);
    if (inWidget) Script.setWidget(w);
    else await w.presentMedium();
    return w;
}

module.exports = {
    run,
    buildView, buildErrorView, isLockScreen, shortDate, assignmentLine, timeLine,
    FAMILY_DETAIL, FAMILY_DAYS,
};
