'use strict';

/* 配置カレンダー(現場・人員配置カレンダー/勤務配置管理)モジュール
 *
 * ■ 統合前提の作り
 *   このファイルは「社員ポータル本体へそのまま持ち込める部品」として書いている。
 *   グローバルへ出すのは window.AssignmentCalendar 1つだけで、Supabaseのキーも
 *   セッションも自前では持たない。呼び出し側(=いまはStandaloneシェル、統合後は
 *   webapp/employee-app/app.js)から rpc() と社員番号を渡してもらう。
 *
 *     AssignmentCalendar.mount(rootElement, {
 *         rpc: (name, params) => Promise,   // ポータル本体の rpc() をそのまま渡す
 *         employeeCode: '0001',
 *         employeeName: '関口 翔太',
 *         onOpenSite: (siteId) => {},       // 将来の現場管理アプリへの遷移(任意)
 *         defaultView: 'month' | 'me',
 *     });
 *
 *   統合時にこのファイルを書き換える必要はない(app.jsから上記の形で呼ぶだけ)。
 *
 * ■ 表示の設計方針
 *   実運用のLifeBearは、月表示の1日セルに現場が5件+「+9」まで並ぶ密度で、
 *   管理者はスクロールせずに翌日以降の現場状況を把握している。一般的なカレンダーUIの
 *   ような余白の大きい月表示にすると、この運用がそのまま成立しなくなる。
 *   そのため「1日セルに何件入るか」を最優先の制約として実装している。
 */

(function () {
    const WEEK_LABELS = ['月', '火', '水', '木', '金', '土', '日'];
    // 月表示のセルは1日あたり54px程度しかないため、六曜は1文字へ縮める
    // (日別詳細では「先勝」のように正式名で出す)。
    const ROKUYOU_SHORT = { '先勝': '先', '友引': '友', '先負': '負', '仏滅': '仏', '大安': '大', '赤口': '赤' };
    const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
    const CACHE_KEY = 'assignment_calendar_my_cache';

    // 職長は assignment_members.role へ文字列で入る。サーバー側の警告判定
    // (assignment_validate_day の no_leader)が role ILIKE '%職長%' を見ているため、
    // 画面から付ける文字列もここに固定して両者がずれないようにする。
    const LEADER_ROLE = '職長';

    // 下請け請負は「普通の外注応援」と一目で違って見える必要がある。
    // 既存の種別色(青・黄緑・緑・濃青緑・オレンジ)と重ならない濃いピンクを専用色にし、
    // 月表示のタグ・日別の左帯・バッジのすべてで同じ色を使う。
    const SUBCONTRACT_COLOR = '#c2185b';
    function isLeaderRole(role) { return !!role && String(role).includes(LEADER_ROLE); }

    // 人の区分。色だけに頼らず必ず文字も出す(色覚差への配慮)。
    //
    // 2026-09-02: 表示の元を day_role(その日その人が何として数えられているか)へ変更した。
    // 以前は社員マスターの職種を出していたため、「チップは事務なのに人数は職人」という
    // 食い違いが実機で起きていた。人数サマリーと同じ判定元を使う。
    const ROLE_LABELS = {
        craft: { key: 'own-field', label: '職人' },
        office: { key: 'own-office', label: '事務' },
        sales: { key: 'own-sales', label: '営業' },
        haul: { key: 'own-haul', label: '運搬' },
        other: { key: 'own-other', label: 'その他' },
    };
    function memberRoleTag(m) {
        const isSub = m.member_type === 'subcontractor' || m.member_type === 'subcontractor_company';
        if (isSub) {
            return ((m.assignment_kind || 'work') === 'haul')
                ? { key: 'sub-haul', label: '外注運搬' }
                : { key: 'sub-field', label: '外注' };
        }
        // その配置が運搬なら、その行は運搬として見せる(人数は日単位で別途判定)。
        if ((m.assignment_kind || 'work') === 'haul') return ROLE_LABELS.haul;
        const r = ROLE_LABELS[m.day_role];
        if (!r) return ROLE_LABELS.craft;
        // 「その他」は何のその他かを出す(ラーメン店・研修など)
        if (m.day_role === 'other' && m.headcount_role_label) {
            return { key: r.key, label: m.headcount_role_label };
        }
        return r;
    }

    // ---------------------------------------------------------------
    // 小さなユーティリティ
    // ---------------------------------------------------------------
    function pad(n) { return String(n).padStart(2, '0'); }

    // new Date().toISOString() はUTCになるため、深夜0〜9時JSTに「今日」が前日へずれる。
    // 配置は日本時間の暦日で運用するので、今日の判定は必ずこの関数を通す。
    function todayJST() {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
    function ymd(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
    function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
    function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
    function dowOf(s) { return parseYmd(s).getDay(); }
    function labelDate(s) { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日(${DOW_JP[d.getDay()]})`; }

    // 六曜は rokuyou.js が計算する。読み込まれていない場合は表示しないだけで、
    // カレンダーの他の機能は通常どおり動く(統合作業の順序に依存させない)。
    function rokuyouOf(dateStr) {
        try {
            const R = (typeof window !== 'undefined' && window.Rokuyou) || null;
            return R ? R.of(dateStr) : '';
        } catch (_) { return ''; }
    }

    function el(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    // 背景色の明度から文字色を決める。カテゴリ色は管理者が自由に変えられるため、
    // 黄色系を選ばれても文字が読めなくならないようにする。
    function isLightColor(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return false;
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) > 176;
    }

    // ---------------------------------------------------------------
    // 本体
    // ---------------------------------------------------------------
    function mount(root, ctx) {
        const rpc = ctx.rpc;
        const me = ctx.employeeCode;
        const store = ctx.storage || window.localStorage;

        const today = todayJST();
        const state = {
            view: ctx.defaultView || 'month',
            year: Number(today.slice(0, 4)),
            month: Number(today.slice(5, 7)),
            selected: today,
            // スクロール時に上部へ残す1週間の起点(月曜)。月では区切らない。
            weekStart: null,
            // 月表示・週ストリップの両方がここだけを見る日付ごとのキャッシュ。
            // 別々に持つと「月表示には出るが週ストリップには出ない」ズレが起きる。
            cache: { schedules: new Map(), holidays: new Map(), counts: new Map(), loaded: new Set() },
            month_data: null,
            day_data: null,
            issues: null,
            confirmation: null,
            categories: [],
            employees: [],
            isAdmin: false,
            // 2026-09-01 権限仕様変更: 配置の追加・編集・移動・並び替えは認証済み社員なら
            // 誰でも行える。isAdmin は「影響範囲の大きい操作」だけの門番として残す。
            canEdit: false,
            showNames: false,
            maxChipsOverride: null,   // null = 画面の高さから自動計算
            mine: [],
            offline: false,
        };

        root.classList.add('ac-root');
        root.innerHTML = '';
        const elHeader = el('div', 'ac-header');
        // 日別一覧を下までスクロールしても日付移動できるように、
        // 月グリッドとは別に「日付バー」を常に画面上部へ残す。
        // 月全体を固定すると画面を占領しすぎるので、1行(52px)だけにしている。
        //
        // 【重要】以前は position:sticky で留めていたが、iPhone実機では
        // 配置一覧を下へスクロールすると日付バーが画面外へ消えてしまっていた。
        // stickyは「最も近いスクロール祖先」を基準に効くため、ページ全体が
        // スクロールする構成では環境差で外れる。そこで、スクロールする領域を
        // .ac-bodywrap の内側だけに閉じ込め、ヘッダーと日付バーはその外に置く
        // 構造へ変更した(スクロールできない位置にあるので構造的に消えない)。
        // 上部に残すのは「別の日付ナビゲーション」ではなく、同じ月カレンダーが
        // 1週間ぶんに縮んだもの。日付だけの帯では現場名が見えず、
        // 「その日に何があるか」が分からないため実運用に足りなかった。
        const elWeekNav = el('div', 'ac-weeknav');
        const elWeekPrev = el('button', 'ac-datearrow', '‹');
        const elWeekTrack = el('div', 'ac-weektrack');
        const elWeekNext = el('button', 'ac-datearrow', '›');
        elWeekPrev.setAttribute('aria-label', '前の7日へ');
        elWeekNext.setAttribute('aria-label', '次の7日へ');
        elWeekPrev.addEventListener('click', () => shiftWeek(-1));
        elWeekNext.addEventListener('click', () => shiftWeek(1));
        elWeekNav.append(elWeekPrev, elWeekTrack, elWeekNext);
        elWeekNav.style.display = 'none';
        const elOffline = el('div', 'ac-offline', '通信できないため、端末に保存された最後の内容を表示しています');
        elOffline.style.display = 'none';
        const elBody = el('div', 'ac-bodywrap');
        const elToast = el('div', 'ac-toast');
        elToast.hidden = true;
        root.append(elHeader, elWeekNav, elOffline, elBody, elToast);

        let toastTimer = null;
        function toast(msg) {
            elToast.textContent = msg;
            elToast.hidden = false;
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => { elToast.hidden = true; }, 2600);
        }
        function fail(e) { toast(e && e.message ? e.message : '通信に失敗しました'); }

        // -----------------------------------------------------------
        // ヘッダー
        // -----------------------------------------------------------
        function renderHeader() {
            elHeader.innerHTML = '';
            if (state.view === 'me') {
                elHeader.append(el('div', 'ac-ym', '自分の予定'));
                elHeader.append(el('div', 'ac-spacer'));
                // 一般社員も「あの現場にいつ行ったか」を自分の履歴から探せるようにする
                // (検索対象はサーバー側で自分が入っている配置だけに絞られる)。
                elHeader.append(btn('🔍', openSearchSheet, 'ac-icon'));
                if (state.canEdit) elHeader.append(btn('配置表', () => { state.view = 'month'; render(); }));
                return;
            }
            const ym = el('div', 'ac-ym', `${state.year}年${state.month}月`);
            elHeader.append(
                btn('◀', () => shiftMonth(-1), 'ac-icon'),
                ym,
                btn('▶', () => shiftMonth(1), 'ac-icon'),
                btn('今日', goToday),
                btn('日付', openJumpSheet),
                // 月の延べ人工。画面を数字だらけにしないよう、押したときだけシートで出す。
                btn('月集計', openMonthTotalSheet),
                el('div', 'ac-spacer'),
                btn('🔍', openSearchSheet, 'ac-icon'),
                btn('☰', openMenuSheet, 'ac-icon'),
            );
        }
        function btn(label, onClick, extra) {
            const b = el('button', 'ac-hbtn' + (extra ? ' ' + extra : ''), label);
            b.addEventListener('click', onClick);
            return b;
        }

        function shiftMonth(delta) {
            let y = state.year, m = state.month + delta;
            if (m < 1) { m = 12; y -= 1; }
            if (m > 12) { m = 1; y += 1; }
            state.year = y; state.month = m;
            syncSelectedToMonth();
            Promise.all([loadMonth(), loadDay()]).then(render);
        }

        // 月を移動したのに日別詳細だけ前の月の日付のまま、という状態を作らない。
        // 表示中の月に今日が含まれるならその日、含まれないなら1日を選ぶ。
        function syncSelectedToMonth() {
            const prefix = `${state.year}-${pad(state.month)}`;
            if (state.selected.startsWith(prefix)) return;
            const t = todayJST();
            state.selected = t.startsWith(prefix) ? t : `${prefix}-01`;
        }
        function goToday() {
            const t = todayJST();
            state.year = Number(t.slice(0, 4));
            state.month = Number(t.slice(5, 7));
            state.selected = t;
            Promise.all([loadMonth(), loadDay()]).then(render);
        }
        function jumpTo(dateStr) {
            state.year = Number(dateStr.slice(0, 4));
            state.month = Number(dateStr.slice(5, 7));
            state.selected = dateStr;
            state.view = 'month';
            Promise.all([loadMonth(), loadDay()]).then(render);
        }

        // -----------------------------------------------------------
        // 1週間ストリップ(スクロール時に上部へ残る、縮んだ月カレンダー)
        //
        // 日付だけの帯では「その日に何があるか」が分からず、現場を確認するために
        // 結局スクロールで戻る必要があった。そこで、別のナビゲーションUIを足すのではなく
        // 月カレンダーの同じセル(現場名・色・+N)を1週間ぶんだけ残す形にした。
        //
        // 週は「月曜始まりの7日」だが、月では区切らない。8/31→9/1、12/31→1/1 も
        // 同じ連続した週として扱う(現在表示月という概念はヘッダーにだけ残す)。
        // -----------------------------------------------------------
        // 横スワイプのたびに作り直すと、位置合わせのスクロールを次のスワイプと
        // 誤認して週が飛ぶ。そこで前後4週ぶんを先に作っておき、端に近づいたときだけ
        // 作り直す(ふだんのスワイプは純粋な横スクロールで、DOMは動かさない)。
        const WEEK_SPAN = 4;                   // 中心の前後に何週ぶん作るか
        const WEEK_PANES = WEEK_SPAN * 2 + 1;
        const WEEK_CHIP_ROW = 12;
        const WEEK_DAYNUM_H = 13;
        let weekBase = null;      // トラックの中心にある週(月曜)
        let weekCentering = false;

        function mondayOf(iso) {
            const d = dowOf(iso);            // 0=日 .. 6=土
            return addDays(iso, d === 0 ? -6 : 1 - d);
        }

        // 週ストリップに使える高さ。固定領域が画面の30%を超えないように決める。
        function weekStripHeight() {
            const vh = window.innerHeight || 700;
            const headerH = Math.round(elHeader.getBoundingClientRect().height) || 38;
            const dayHead = elBody.querySelector('.ac-dayhead');
            const dayH = dayHead ? Math.round(dayHead.getBoundingClientRect().height) : 86;
            // 割り切れて30%ちょうどになると要件の境界に当たるので2px引いておく。
            return Math.max(52, Math.min(120, Math.floor(vh * 0.30) - headerH - dayH - 2));
        }

        // トラックを weekBase を中心に作り直し、中央の週を表示位置にする。
        function buildWeekTrack(base) {
            weekBase = base;
            const h = weekStripHeight();
            const chips = Math.max(1, Math.floor((h - WEEK_DAYNUM_H - 4) / WEEK_CHIP_ROW));
            elWeekTrack.style.height = `${h}px`;
            elWeekTrack.innerHTML = '';
            for (let w = -WEEK_SPAN; w <= WEEK_SPAN; w += 1) {
                const startDate = addDays(base, w * 7);
                const pane = el('div', 'ac-weekpane');
                pane.dataset.start = startDate;
                for (let i = 0; i < 7; i += 1) pane.append(weekCell(addDays(startDate, i), chips));
                elWeekTrack.append(pane);
            }
            centerWeekTrack(WEEK_SPAN);
        }

        // 位置合わせ自体もスクロールなので、その間はスワイプ検出を止める。
        function centerWeekTrack(index) {
            weekCentering = true;
            const put = () => { elWeekTrack.scrollLeft = elWeekTrack.clientWidth * index; };
            put();
            setTimeout(put, 0);
            setTimeout(() => { put(); weekCentering = false; }, 140);
        }

        // 中身だけを描き直す(週は動かさない)。保存・削除のあとに使う。
        function refreshWeekCells() {
            if (!weekBase || elWeekNav.style.display === 'none') return;
            const keep = elWeekTrack.scrollLeft;
            const h = weekStripHeight();
            const chips = Math.max(1, Math.floor((h - WEEK_DAYNUM_H - 4) / WEEK_CHIP_ROW));
            elWeekTrack.style.height = `${h}px`;
            for (const pane of elWeekTrack.children) {
                const startDate = pane.dataset.start;
                pane.innerHTML = '';
                for (let i = 0; i < 7; i += 1) pane.append(weekCell(addDays(startDate, i), chips));
            }
            elWeekTrack.scrollLeft = keep;
        }

        function renderWeekStrip() {
            if (state.view === 'me') { elWeekNav.style.display = 'none'; return; }
            const want = mondayOf(state.selected);
            if (!weekBase) { buildWeekTrack(want); return; }
            // 選んだ日がいまのトラックの中にあれば、その週へ寄せるだけ
            const diff = Math.round((Date.parse(want) - Date.parse(weekBase)) / 86400000 / 7);
            if (Math.abs(diff) <= WEEK_SPAN) { refreshWeekCells(); centerWeekTrack(WEEK_SPAN + diff); }
            else buildWeekTrack(want);
        }

        // 週セルは月表示のセルより幅が狭いので、現場名をもう少し詰めて出す。
        // (CSSのellipsisだけだと1文字しか読めないことがある)
        function shortLabel(label) {
            const t = String(label || '');
            return t.length > 7 ? t.slice(0, 7) : t;
        }

        function weekCell(date, maxChips) {
            const d = dowOf(date);
            const list = (state.cache.schedules.get(date) || []);
            const hol = state.cache.holidays.get(date);
            const isSel = date === state.selected;
            const cell = el('div', 'ac-wcell'
                + (isSel ? ' ac-on' : '')
                + (date === todayJST() ? ' ac-today' : '')
                + (d === 6 ? ' ac-sat' : '') + (d === 0 ? ' ac-sun' : '')
                + (hol ? ' ac-holiday' : ''));
            const head = el('div', 'ac-wnum');
            head.append(el('span', 'ac-wdow', DOW_JP[d]));
            head.append(el('span', null, Number(date.slice(8, 10))));
            const hc = state.cache.counts.get(date);
            if (hc && hc.total) head.append(el('span', 'ac-wcount', `${hc.total}`));
            cell.append(head);
            // 現場名は月表示と同じ色のチップで出す。「その日に何があるか」が
            // 見えることが目的なので、日付だけの帯にはしない。
            const shown = list.slice(0, maxChips);
            for (const x of shown) {
                // 週ストリップも月表示・日別と同じ色ルールにそろえる。
                // 下請け請負だけは専用色にして、どの画面でも同じ見え方にする。
                const c = x.is_subcontracted ? SUBCONTRACT_COLOR : (x.color || '#1a73e8');
                const chip = el('div', 'ac-wchip', (x.is_subcontracted ? '下請 ' : '') + shortLabel(x.label));
                chip.style.background = c;
                chip.title = x.label + (x.is_subcontracted ? '（下請け請負）' : '');
                cell.append(chip);
            }
            if (list.length > shown.length) {
                cell.append(el('div', 'ac-wmore', `+${list.length - shown.length}`));
            }
            cell.addEventListener('click', () => selectDate(date));
            return cell;
        }

        // 横スワイプで週が変わったら、その週を「表示中の週」にする。
        // 端(前後1週ぶん)まで来たらトラックを作り直して、いくらでも続けて動かせるようにする。
        let weekScrollTimer = null;
        elWeekTrack.addEventListener('scroll', () => {
            if (weekCentering) return;
            clearTimeout(weekScrollTimer);
            weekScrollTimer = setTimeout(() => {
                if (weekCentering) return;
                const paneW = elWeekTrack.clientWidth;
                if (!paneW) return;
                const idx = Math.round(elWeekTrack.scrollLeft / paneW);
                const pane = elWeekTrack.children[idx];
                if (!pane) return;
                state.weekStart = pane.dataset.start;
                ensureWeekData(state.weekStart);
                if (idx <= 1 || idx >= WEEK_PANES - 2) {
                    ensureWeekData(state.weekStart).then(() => buildWeekTrack(state.weekStart));
                }
            }, 140);
        });

        // ‹ › は1週間ぶん確実に動かす。スワイプが効きにくい場面の逃げ道。
        function shiftWeek(delta) {
            const paneW = elWeekTrack.clientWidth;
            if (!paneW || !weekBase) return;
            const idx = Math.round(elWeekTrack.scrollLeft / paneW) + delta;
            if (idx < 0 || idx >= WEEK_PANES) {
                const target = addDays(state.weekStart || mondayOf(state.selected), delta * 7);
                state.weekStart = target;
                ensureWeekData(target).then(() => buildWeekTrack(target));
                return;
            }
            const pane = elWeekTrack.children[idx];
            state.weekStart = pane.dataset.start;
            centerWeekTrack(idx);
            ensureWeekData(state.weekStart);
        }

        // 表示しようとしている週(前後2週ぶんを含む)のデータが手元に無ければ取りに行く。
        async function ensureWeekData(weekStart) {
            const from = addDays(weekStart, -Math.floor(WEEK_PANES / 2) * 7);
            const to = addDays(weekStart, Math.floor(WEEK_PANES / 2) * 7 + 6);
            let missing = false;
            for (let d = from; d <= to; d = addDays(d, 1)) {
                if (!state.cache.loaded.has(d)) { missing = true; break; }
            }
            if (!missing) return;
            try {
                const data = await rpc('assignment_get_range', {
                    p_employee_code: me, p_from: from, p_to: to,
                });
                mergeRange(data, from, to);
            } catch (e) { fail(e); }
        }

        // 取得した期間を日付ごとのキャッシュへ入れる。
        // 月表示・週ストリップの両方がここだけを見るようにして、
        // 「月表示には出るが週ストリップには出ない」というズレを作らない。
        function mergeRange(data, from, to) {
            for (const x of (data.schedules || [])) {
                if (!state.cache.schedules.has(x.date)) state.cache.schedules.set(x.date, []);
                const arr = state.cache.schedules.get(x.date);
                const i = arr.findIndex((y) => y.id === x.id);
                if (i >= 0) arr[i] = x; else arr.push(x);
            }
            for (const h of (data.holidays || [])) state.cache.holidays.set(h.date, h.name);
            for (const h of (data.headcounts || [])) state.cache.counts.set(h.date, h);
            const f = from || data.date_from;
            const t = to || data.date_to;
            if (f && t) {
                for (let d = f; d <= t; d = addDays(d, 1)) {
                    if (!data.schedules.some((x) => x.date === d)) state.cache.schedules.set(d, state.cache.schedules.get(d) || []);
                    state.cache.loaded.add(d);
                }
            }
        }

        // 月グリッドが画面外へ出たら週ストリップを出す(同じカレンダーが縮んで残るイメージ)。
        // 出したり消したりが細かく起きないよう、境界に少し幅を持たせている。
        function syncWeekStripVisibility() {
            if (state.view === 'me') { elWeekNav.style.display = 'none'; return; }
            const wrapEl = elBody.querySelector('.ac-monthwrap');
            if (!wrapEl) { elWeekNav.style.display = 'none'; return; }
            const bottom = wrapEl.getBoundingClientRect().bottom - elBody.getBoundingClientRect().top;
            const shown = elWeekNav.style.display !== 'none';
            const threshold = shown ? 24 : 0;
            const want = bottom <= threshold;
            if (want === shown) return;
            elWeekNav.style.display = want ? '' : 'none';
            if (want) {
                state.weekStart = mondayOf(state.selected);
                renderWeekStrip();
                ensureWeekData(state.weekStart);
            }
        }

        // 日付バーやカレンダーから日を選んだときの共通処理。
        // 月をまたいだ場合は月データも読み直す(操作としては日付が連続して見える)。
        function selectDate(date) {
            const monthChanged = Number(date.slice(0, 4)) !== state.year || Number(date.slice(5, 7)) !== state.month;
            state.selected = date;
            state.year = Number(date.slice(0, 4));
            state.month = Number(date.slice(5, 7));
            state.weekStart = mondayOf(date);
            const jobs = monthChanged ? [loadMonth(), loadDay()] : [loadDay()];
            Promise.all(jobs).then(() => {
                render();
                scrollToDayPanel();
                syncWeekStripVisibility();
                if (elWeekNav.style.display !== 'none') renderWeekStrip();
            });
        }

        // -----------------------------------------------------------
        // データ取得
        // -----------------------------------------------------------
        async function loadMonth() {
            try {
                state.month_data = await rpc('assignment_get_month', {
                    p_employee_code: me, p_year: state.year, p_month: state.month,
                });
                state.isAdmin = !!state.month_data.is_admin;
                // 月データを取得できた時点で認証済み社員であることが確定しているため編集可。
                state.canEdit = true;
                state.categories = state.month_data.categories || [];
                // 月表示は月曜始まりの6週間ぶんを返す(前月末・翌月初を含む)。
                mergeRange(state.month_data);
                state.offline = false;
            } catch (e) { state.offline = true; fail(e); }
        }
        async function loadDay() {
            try {
                state.day_data = await rpc('assignment_get_day', { p_employee_code: me, p_date: state.selected });
                if (state.canEdit) {
                    const [issues, conf] = await Promise.all([
                        rpc('assignment_validate_day', { p_employee_code: me, p_date: state.selected }),
                        rpc('assignment_get_confirmation_status', { p_employee_code: me, p_date: state.selected }),
                    ]);
                    state.issues = issues; state.confirmation = conf;
                }
            } catch (e) { fail(e); }
        }
        async function loadMine() {
            const from = addDays(todayJST(), -3);
            const to = addDays(todayJST(), 30);
            try {
                state.mine = await rpc('assignment_get_my_schedule', {
                    p_employee_code: me, p_date_from: from, p_date_to: to,
                });
                state.offline = false;
                // 現場は電波が悪いことがある。最後に取得できた自分の予定は端末へ残し、
                // 圏外でも「明日どこへ行くか」だけは必ず見られるようにする。
                try { store.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows: state.mine })); } catch (_) { /* 容量超過は無視 */ }
            } catch (e) {
                try {
                    const cached = JSON.parse(store.getItem(CACHE_KEY) || 'null');
                    if (cached && Array.isArray(cached.rows)) { state.mine = cached.rows; state.offline = true; return; }
                } catch (_) { /* 壊れたキャッシュは無視 */ }
                fail(e);
            }
        }
        async function loadEmployees() {
            if (state.employees.length) return;
            try { state.employees = await rpc('list_employees_for_selector', { p_employee_code: me }); }
            catch (e) { fail(e); }
        }

        // -----------------------------------------------------------
        // 月グリッド
        // -----------------------------------------------------------
        function buildMonthCells() {
            const first = new Date(state.year, state.month - 1, 1);
            // 月曜始まり(LifeBearと同じ)。getDay()は日曜=0なので月曜起点へずらす。
            const lead = (first.getDay() + 6) % 7;
            const start = new Date(first);
            start.setDate(first.getDate() - lead);
            const cells = [];
            for (let i = 0; i < 42; i += 1) {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                cells.push(ymd(d));
            }
            // 6週目が完全に翌月なら描画しない(縦の無駄を削る)
            const lastWeek = cells.slice(35);
            if (lastWeek.every((s) => Number(s.slice(5, 7)) !== state.month)) return cells.slice(0, 35);
            return cells;
        }

        // 1日セルの高さと、そこへ入る予定件数を決める。
        //
        // 以前は「画面の高さ×0.70 ÷ 週数」で計算していたが、これだと
        // グリッドより上にあるもの(開発用シェルのバナー、ログイン中の表示、
        // アプリのヘッダー、曜日行)の高さを無視するため、実機のSafariのように
        // 表示領域が狭い環境では1日あたり4件程度しか出せなかった。
        //
        // 実際に使える高さは「画面の高さ − グリッドの開始位置」で決まるので、
        // 描画済みのグリッドの位置を実測して割り当てる。
        // LifeBearと同じく、既定では月表示に画面をいっぱい使い、
        // 日別詳細はその下に置く(日をタップすると自動でそこへスクロールする)。
        const CHIP_ROW = 13;   // チップ12px + 上マージン1px
        const DAYNUM_H = 14;
        function computeLayout(weeks, gridTop) {
            // 画面の高さではなく「スクロール領域の高さ」を基準にする。
            // 上部が固定になったぶん、月表示に使える高さはここで決まる。
            const h = elBody.clientHeight || window.innerHeight || 800;
            const available = Math.max(240, h - (gridTop || 0));
            const cell = Math.max(72, Math.min(170, Math.floor(available / weeks)));
            const chips = Math.max(3, Math.floor((cell - DAYNUM_H) / CHIP_ROW));
            return { cell, chips };
        }

        // グリッドを描いたあとに実際の開始位置を測り、想定とずれていたら1度だけ組み直す。
        // (初回描画時点ではグリッドがまだDOMに無く、開始位置が分からないため)
        let lastGridTop = null;
        function reflowMonthIfNeeded() {
            const grid = elBody.querySelector('.ac-grid');
            if (!grid) return;
            // スクロール領域の先頭からグリッドまでの距離(曜日行のぶん)
            const top = Math.round(grid.getBoundingClientRect().top - elBody.getBoundingClientRect().top);
            if (lastGridTop !== null && Math.abs(top - lastGridTop) < 4) return;
            lastGridTop = top;
            render();
        }

        function renderMonth(container) {
            const data = state.month_data || { schedules: [], holidays: [] };
            const byDate = new Map();
            for (const s of data.schedules) {
                if (!byDate.has(s.date)) byDate.set(s.date, []);
                byDate.get(s.date).push(s);
            }
            const holidays = new Map((data.holidays || []).map((h) => [h.date, h.name]));
            // 人数はクライアントで足し算しない。予定の人数を単純に合計すると、
            // 二重配置された社員が2人と数えられ、休み・会議の人まで現場人数に混ざる。
            const headcounts = new Map((data.headcounts || []).map((h) => [h.date, h]));

            // 曜日行と月グリッドを1つの入れ物に入れる。
            // 直接 container へ並べると、曜日行の sticky が月グリッドを抜けたあとも
            // 効き続けて、その下の日別詳細の操作バーへ覆いかぶさってしまう。
            const monthWrap = el('div', 'ac-monthwrap');
            const dow = el('div', 'ac-dow');
            for (const w of WEEK_LABELS) dow.append(el('div', null, w));
            monthWrap.append(dow);
            container.append(monthWrap);

            const cells = buildMonthCells();
            const layout = computeLayout(cells.length / 7, lastGridTop);
            // ユーザーがメニューで表示件数を明示指定した場合はそちらを優先する
            const chipLimit = state.maxChipsOverride || layout.chips;

            const grid = el('div', 'ac-grid');
            grid.style.gridAutoRows = `${layout.cell}px`;
            attachSwipe(grid);
            const t = todayJST();
            for (const date of cells) {
                const inMonth = Number(date.slice(5, 7)) === state.month;
                const d = dowOf(date);
                const hol = holidays.get(date);
                const cell = el('div', 'ac-cell'
                    + (inMonth ? '' : ' ac-other')
                    + (date === t ? ' ac-today' : '')
                    + (date === state.selected ? ' ac-sel' : '')
                    + (d === 6 ? ' ac-sat' : '') + (d === 0 ? ' ac-sun' : '')
                    + (hol ? ' ac-holiday' : ''));
                cell.dataset.date = date;

                const list = byDate.get(date) || [];
                const hc = headcounts.get(date);

                const head = el('div', 'ac-daynum');
                head.append(el('span', null, Number(date.slice(8, 10))));
                // 六曜。葬儀・通夜の日程で「友引かどうか」をカレンダー上で即座に見るために常時表示する。
                const roku = rokuyouOf(date);
                if (roku) {
                    const rk = el('span', 'ac-rokuyou' + (roku === '友引' ? ' ac-tomobiki' : ''), ROKUYOU_SHORT[roku] || roku);
                    rk.title = roku;
                    head.append(rk);
                }
                // その日に現場へ出ている実人数。LifeBearには無いが、配置判断で毎回必要になる。
                if (hc && hc.total) head.append(el('span', 'ac-headcount', `${hc.total}人`));
                cell.append(head);

                // 祝日名は日付行の余白へ押し込むと、人数バッジと取り合って消える。
                // LifeBearと同じく、チップとして予定の先頭に並べる。
                if (hol) cell.append(el('div', 'ac-chip ac-holchip', hol));

                const base = hol ? Math.max(2, chipLimit - 1) : chipLimit;
                const limit = state.showNames ? Math.max(2, Math.floor(base / 2)) : base;
                list.slice(0, limit).forEach((s) => {
                    const chipColor = s.is_subcontracted ? SUBCONTRACT_COLOR : (s.color || '#1a73e8');
                    const chip = el('div', 'ac-chip'
                        + (isLightColor(chipColor) ? ' ac-light' : '')
                        + (s.is_subcontracted ? ' ac-subcchip' : '')
                        + (s.status === 'confirmed' ? '' : ' ac-draft'),
                        (s.is_subcontracted ? '下請 ' : '') + s.label);
                    chip.style.background = chipColor;
                    chip.title = `${s.label} (${s.member_count}名)`;
                    cell.append(chip);
                    if (state.showNames && s.member_names) cell.append(el('div', 'ac-chipnames', s.member_names));
                });
                // 「+N」はチップ1件分の行を消費せず、セル右下へ重ねて表示する
                // (LifeBearと同じ5件表示のままでも、こちらは1件多く現場名を出せる)。
                if (list.length > limit) {
                    cell.append(el('div', 'ac-more', `+${list.length - limit}`));
                    cell.classList.add('ac-has-more');   // 最後のチップの右端をバッジぶん空ける
                }

                cell.addEventListener('click', () => selectDate(date));
                grid.append(cell);
            }
            monthWrap.append(grid);
        }

        // -----------------------------------------------------------
        // 日別詳細
        // -----------------------------------------------------------
        function renderDay(container) {
            const day = state.day_data;
            const wrap = el('div', 'ac-day');

            // 操作バーは「情報行」と「操作行」の2段に固定する。
            // 以前は1行に全ボタンを詰めて横スクロールさせていたため、
            // スクロール位置によってボタンの位置が毎回変わり、押し間違えやすかった。
            const head = el('div', 'ac-dayhead');

            const info = el('div', 'ac-dayinfo');
            const title = el('div', 'ac-daytitle', labelDate(state.selected));
            const rokuFull = rokuyouOf(state.selected);
            if (rokuFull) {
                title.append(el('span', 'ac-rokuyou-full' + (rokuFull === '友引' ? ' ac-tomobiki' : ''), rokuFull));
            }
            if (day && day.holiday) title.append(el('span', 'ac-hol', day.holiday));
            info.append(title);
            // 人数は2段に分ける。狭いスマホで1行に詰め込むと右端が切れて
            // 「時間重複」「確認」が見えなくなるため(実機で確認済み)。
            //   1段目: 職人35 / 事務2 / 運搬5 / 計42   ← まず知りたいのは役割
            //   2段目: 自社25 / 外注17 と 重複・確認    ← 所属の内訳は補助
            // どの数も同じ人を二度数えない(サーバー側で employee_id 単位に1区分へ寄せている)。
            if (day && day.headcount && day.headcount.total > 0) {
                const h = day.headcount;
                const roleRow = el('div', 'ac-hcrow');
                const put = (cls, label, n, tip) => {
                    if (!n) return;
                    const b = el('span', `ac-hc ${cls}`, `${label}${n}`);
                    b.title = tip;
                    roleRow.append(b);
                };
                put('ac-hc-craft', '職人', h.craft, '自社の職人。同じ人が複数現場に入っていても1人として数えます。');
                put('ac-hc-office', '事務', h.office, '事務・総務・経理など、現場に出ない社員。');
                put('ac-hc-sales', '営業', h.sales, '営業の社員、またはその日ずっと営業活動だった社員。');
                put('ac-hc-sub', '外注', h.sub, '外注の作業人数。会社まとめの行は登録された人数で数えます。');
                put('ac-hc-haul', '運搬', h.haul, '運搬だけを担当した人の数(自社＋外注)。運んでそのまま現場で働く人は職人として数えます。');
                // 「その他」は押すと内訳(研修・健康診断など、種別ごと)が開く。
                // 上部を詰め込まないため、通常は人数だけを出す。
                if (h.other > 0) {
                    const ob = el('button', 'ac-hc ac-hc-other ac-hc-tap', `その他${h.other}`);
                    ob.title = 'その日ずっと現場以外の用事だった人。押すと内訳が見られます。';
                    ob.addEventListener('click', () => openOtherBreakdown(h));
                    roleRow.append(ob);
                }
                roleRow.append(el('span', 'ac-hc ac-hc-total', `計${h.total}人`));
                info.append(roleRow);

                const subRow = el('div', 'ac-hcrow ac-hcrow2');
                const own = el('span', 'ac-hc ac-hc-own', `自社${h.employees}`);
                own.title = '自社社員の実人数。二重配置されていても1人として数えます。';
                subRow.append(own);
                if (h.double_booked > 0) {
                    const db = el('span', 'ac-hc ac-hc-warn', `⚠時間重複${h.double_booked}`);
                    db.title = '同じ社員の時間帯が重なっている人数。午前A現場→午後B現場のように重なっていない移動は数えません。';
                    subRow.append(db);
                }
                if (state.confirmation && Number(state.confirmation.total) > 0) {
                    const c = state.confirmation;
                    const okAll = Number(c.confirmed) === Number(c.total);
                    // 母数は社員のみ(外注はポータルのアカウントを持たないため確認できない)
                    const b = el('span', 'ac-hc' + (okAll ? ' ac-hc-ok' : ' ac-hc-warn'), `確認${c.confirmed}/${c.total}`);
                    b.title = '確認できるのは社員のみです。外注は母数に含めていません。';
                    subRow.append(b);
                    if (Number(c.important_total) > 0) {
                        const okImp = Number(c.important_confirmed) === Number(c.important_total);
                        subRow.append(el('span', 'ac-hc' + (okImp ? ' ac-hc-ok' : ' ac-hc-warn'),
                            `重要${c.important_confirmed}/${c.important_total}`));
                    }
                }
                info.append(subRow);
            }
            head.append(info);

            if (state.canEdit) {
                const bar = el('div', 'ac-daybar');
                // いちばん使う「配置を追加」を最も大きく、いちばん押しやすい位置に置く
                const add = el('button', 'ac-actbtn ac-actmain', '＋ 配置を追加');
                add.addEventListener('click', () => openEntrySheet(null));
                const more = el('button', 'ac-actbtn ac-actmore', '⋯');
                more.title = 'その他の操作';
                more.addEventListener('click', openDayMenuSheet);
                // 「確定して通知」はその日の全員へ通知が飛ぶため、配置担当・管理者のみ。
                if (state.isAdmin) {
                    const conf = el('button', 'ac-actbtn ac-actsub', '確定して通知');
                    conf.addEventListener('click', confirmDay);
                    bar.append(add, conf, more);
                } else {
                    bar.append(add, more);
                }
                head.append(bar);
            }
            wrap.append(head);

            if (state.canEdit && state.issues && state.issues.issues && state.issues.issues.length) {
                const box = el('div', 'ac-issues');
                for (const i of state.issues.issues) {
                    const line = el('div', 'ac-issue ac-' + i.severity, i.message);
                    // 意図した複数現場配置なら承認して警告から外せるようにする。
                    // 本当に危険な二重配置が警告の山に埋もれないようにするため。
                    // 「職長が指定されていません」は押すとその現場の編集が開く。
                    // 警告だけ出して直す場所が無い状態にしない。
                    if (i.rule === 'no_leader') {
                        const target = (state.day_data && state.day_data.schedules || [])
                            .find((s2) => s2.label === i.label || (i.message || '').includes(s2.label));
                        if (target) {
                            line.classList.add('ac-issue-tap');
                            line.append(el('span', 'ac-issuego', '職長を決める ›'));
                            line.addEventListener('click', () => openLeaderSheet(target));
                        }
                    }
                    if (i.rule === 'double_booking' && i.employee_code) {
                        const row = el('div', 'ac-issuebtns');
                        const b = el('button', 'ac-btn ac-sm', '意図した配置として承認');
                        b.addEventListener('click', () => approveDoubleBooking(i.employee_code, true));
                        // 承認だけでは「直したい」場合に一覧から自分で探し直す必要があった。
                        // どの配置を直すかをその場で選べるようにする。
                        const e = el('button', 'ac-btn ac-sm ac-primary', '編集する');
                        e.addEventListener('click', () => openIssueEditPicker(i));
                        row.append(b, e);
                        line.append(row);
                    } else if (i.rule === 'double_booking_approved' && i.employee_code) {
                        const row = el('div', 'ac-issuebtns');
                        const b = el('button', 'ac-btn ac-sm', '承認を取り消す');
                        b.addEventListener('click', () => approveDoubleBooking(i.employee_code, false));
                        const e = el('button', 'ac-btn ac-sm', '編集する');
                        e.addEventListener('click', () => openIssueEditPicker(i));
                        row.append(b, e);
                        line.append(row);
                    }
                    box.append(line);
                }
                wrap.append(box);
            }

            if (!day || !day.schedules.length) {
                wrap.append(el('div', 'ac-empty', 'この日の配置はまだ登録されていません'));
            } else {
                const unconfirmedBySchedule = new Map(
                    ((state.confirmation && state.confirmation.sites) || []).map((s) => [s.schedule_id, s]));
                for (const s of day.schedules) {
                    wrap.append(renderSchedule(s, unconfirmedBySchedule.get(s.id)));
                }
            }
            container.append(wrap);
        }
        // 月グリッドの左右スワイプで前月・翌月へ。LifeBearと同じ手の動きで月を送れるようにする。
        // (年単位の移動は「日付」ボタンからの直接指定で行う。スワイプだけに頼らせない)
        function attachSwipe(target) {
            let x0 = null, y0 = null, moved = false;
            target.addEventListener('touchstart', (ev) => {
                if (ev.touches.length !== 1) { x0 = null; return; }
                x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; moved = false;
            }, { passive: true });
            target.addEventListener('touchmove', (ev) => {
                if (x0 === null) return;
                const dx = ev.touches[0].clientX - x0;
                const dy = ev.touches[0].clientY - y0;
                // 縦スクロールの途中で誤って月が変わらないよう、横方向が明確に優位なときだけ拾う
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) moved = true;
            }, { passive: true });
            target.addEventListener('touchend', (ev) => {
                if (x0 === null || !moved) { x0 = null; return; }
                const dx = ev.changedTouches[0].clientX - x0;
                x0 = null;
                shiftMonth(dx < 0 ? 1 : -1);
            }, { passive: true });
        }

        // 日をタップしたら、月グリッドを丸ごとスクロールさせずに日別詳細まで自動で送る
        // (毎回自分でスクロールさせると、翌日の配置を確認する操作が1手増える)。
        function scrollToDayPanel() {
            const panel = elBody.querySelector('.ac-day');
            if (!panel) return;
            // スクロールするのは .ac-bodywrap だけ(ヘッダーと日付バーはその外にある)
            const top = panel.getBoundingClientRect().top - elBody.getBoundingClientRect().top + elBody.scrollTop;
            // smoothは環境によって無視されスクロール自体が起きないことがあるため即時移動にする。
            elBody.scrollTop = Math.max(0, top);
            // プログラムからのスクロールでは scroll イベントに頼らず直接判定する
            syncWeekStripVisibility();
        }

        function actionBtn(label, onClick, extra) {
            const b = el('button', 'ac-btn ac-sm' + (extra ? ' ' + extra : ''), label);
            b.addEventListener('click', onClick);
            return b;
        }

        function renderSchedule(s, conf) {
            const box = el('div', 'ac-sched');
            // 左帯は種別色。下請け請負だけは専用色にして、流し見でも区別できるようにする。
            box.style.borderLeftColor = s.is_subcontracted ? SUBCONTRACT_COLOR : (s.color || '#1a73e8');
            if (s.is_subcontracted) box.classList.add('ac-subc');

            // 現場ヘッダーは独立した大きなタップ領域にする。
            // 人数の多い現場では社員名チップが画面を埋め、現場自体を押しにくかった。
            const top = el('div', 'ac-schedtop ac-sitehead');
            top.setAttribute('role', 'button');
            top.title = '現場の配置詳細を開く';
            top.addEventListener('click', (ev) => {
                if (ev.target.closest('.ac-ord')) return;
                openDetailSheet(s.id);
            });
            const name = el('div', 'ac-schedname', s.label);
            top.append(name);
            // 種別バッジ自体にも種別色を塗る。左の細い帯だけでは実機で見分けが付かない、
            // という指摘への対応。色だけに頼らないよう文字(仕事/常傭/応援…)は必ず出す。
            const catBadge = el('span', 'ac-badge ac-catbadge', s.category_name);
            const catColor = s.color || '#1a73e8';
            catBadge.style.background = catColor;
            catBadge.style.borderColor = catColor;
            catBadge.style.color = isLightColor(catColor) ? '#16202e' : '#fff';
            top.append(catBadge);
            // 下請け請負は種別より先に、いちばん目立つ位置へ出す。
            if (s.is_subcontracted) {
                const sc = el('span', 'ac-badge ac-subcbadge', '下請け');
                sc.title = '協力会社だけで施工する現場です(自社は入りません)';
                top.append(sc);
            }
            if (s.status !== 'confirmed') top.append(el('span', 'ac-badge ac-warn', '未確定'));
            if (conf && Number(conf.total) > 0) {
                const ok = Number(conf.confirmed) === Number(conf.total);
                top.append(el('span', 'ac-badge' + (ok ? ' ac-ok' : ' ac-warn'), `${conf.confirmed}/${conf.total}確認`));
            }
            if (state.canEdit) {
                // 並び替えは↑↓を採用している。理由は README ではなくここに書く:
                // ドラッグ&ドロップは、手袋や片手操作、スクロールとの競合で現場では誤操作が多い。
                // ↑↓なら押す位置が固定で、連打で一気に上まで運べる。
                const up = el('button', 'ac-ord', '↑');
                up.title = '上へ';
                up.addEventListener('click', (ev) => { ev.stopPropagation(); moveScheduleOrder(s.id, -1); });
                const down = el('button', 'ac-ord', '↓');
                down.title = '下へ';
                down.addEventListener('click', (ev) => { ev.stopPropagation(); moveScheduleOrder(s.id, 1); });
                // 削除は詳細画面に集約する。一覧に置くと、見ようとして隣を押す事故が起きる。
                top.append(up, down);
            }
            box.append(top);

            // 現場名の右に人数を大きく出す(「京田辺 4人」が一目で読めることを優先)。
            // 人数は「その現場で実際に作業する人」。運搬は別バッジにする。
            const cnt = el('span', 'ac-sitecount', `${s.member_count}人`);
            cnt.title = s.subcontractor_count > 0
                ? `作業 社員 ${s.employee_count}人 / 外注 ${s.subcontractor_count}人`
                : `作業 社員 ${s.employee_count}人`;
            top.insertBefore(cnt, top.children[1] || null);
            // 職長は現場を回すうえで最初に見たい情報なので、現場名の帯に出す。
            const leader = (s.members || []).find((m) => isLeaderRole(m.role));
            if (leader) {
                const lb = el('span', 'ac-badge ac-leadbadge', `職長 ${leader.short_name || leader.name}`);
                lb.title = 'この現場の職長';
                top.insertBefore(lb, top.children[2] || null);
            } else if (s.leader_undecided) {
                // 「まだ誰も決めていない」ではなく「今は決められないと判断済み」の印。
                const ub = el('span', 'ac-badge ac-leadundecided', '職長未定');
                ub.title = '職長は今は決められないと判断済みです。あとから決められます。';
                top.insertBefore(ub, top.children[2] || null);
            }
            if (s.haul_count > 0) {
                const hb = el('span', 'ac-badge ac-haul', `🚚${s.haul_count}`);
                hb.title = 'この現場へ運搬で入っている人数です。作業人数とは別に数えています。';
                top.insertBefore(hb, top.children[2] || null);
            }

            const meta = [];
            if (s.meeting_time) meta.push(`集合 ${s.meeting_time}`);
            if (s.start_time) meta.push(`開始 ${s.start_time}`);
            if (s.end_time) meta.push(`終了 ${s.end_time}`);
            if (s.prime_contractor) meta.push(`元請 ${s.prime_contractor}`);
            // 内訳は外注が入っている現場だけ出す(全員社員の現場で毎回2行使わない)
            // 外注が入っている現場だけ内訳を出す。全員社員の現場は現場名の右の「4人」で足りる。
            if (s.subcontractor_count > 0) {
                meta.push(`社員${s.employee_count}人 外注${s.subcontractor_count}人`);
            }
            if (!s.counts_as_deployment) meta.push('※配置人数に含めない種別');
            box.append(el('div', 'ac-schedmeta', meta.join(' ／ ')));

            // 通知済みなのに未確認の人だけを色で示す。未確認者の名前を別バッジで
            // もう一度並べると、同じ名前が2回出て日別詳細の行数が無駄に増える。
            const mem = el('div', 'ac-members');
            for (const m of s.members) {
                const confirmed = m.notification_status === 'confirmed';
                const waiting = m.notification_status === 'notified';
                const haul = m.assignment_kind === 'haul';
                const tag = memberRoleTag(m);
                const chip = el('span', 'ac-mem ac-role-' + tag.key
                    + (confirmed ? ' ac-confirmed' : (waiting ? ' ac-unconfirmed' : ''))
                    + (haul ? ' ac-haulmem' : '')
                    + (m.member_type === 'subcontractor' ? ' ac-sub' : ''), '');
                // 色だけに頼らず、必ず文字でも区分が分かるようにする(色覚差への配慮)。
                if (haul) chip.append(el('span', 'ac-haulmark', '🚚'));
                chip.append(el('span', 'ac-rtag', tag.label));
                chip.append(document.createTextNode(m.name || '(不明)'));
                if (isLeaderRole(m.role)) chip.append(el('span', 'ac-leadtag', '職長'));
                else if (m.role) chip.append(el('span', 'ac-role', m.role));
                // 現場と違う時間の人だけ時間を出す(全員に付けると一覧性が落ちる)
                if (!m.is_allday && (m.start_time || m.end_time || haul)) {
                    chip.append(el('span', 'ac-mt', m.time_label));
                } else if (m.meeting_time) {
                    chip.append(el('span', 'ac-mt', m.meeting_time));
                }
                // 2026-09-02: 一覧の社員チップから直接操作できるようにした。
                // 「今日だけ役割を変える」「別現場へ移す」を現場詳細まで開かずに済ませたい、
                // という実機の要望による。押せることが分かるよう記号を付ける。
                if (state.canEdit && m.member_type === 'employee') {
                    chip.classList.add('ac-tappable');
                    chip.append(el('span', 'ac-chevron', '▾'));
                    chip.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        openMemberActionSheet(m, s);
                    });
                }
                // (以前は)一覧では社員名をタップしても何も起きないようにしていた。
                // 人数の多い現場では名前チップが画面を埋めるため、
                // 現場を見たいのに社員を押してしまう事故が起きていた。
                // 「1人を別の現場へ移す」操作は現場詳細の中から行う。
                mem.append(chip);
            }
            box.append(mem);

            if (s.note) box.append(el('div', 'ac-note', s.note));

            // 行のタップは「見る」だけにする。編集は詳細画面の編集ボタンから。
            // 確認するつもりで触っただけで編集状態に入ってしまうのは誤操作の元になる。
            // 行全体ではなく現場ヘッダーを押したときだけ詳細を開く。
            // 社員名の並びを押しても何も起きないので、確認するつもりで
            // 触っただけで画面が変わる事故が起きない。
            return box;
        }

        // -----------------------------------------------------------
        // 配置の詳細(閲覧)。編集は明示的に編集ボタンを押したときだけ。
        // -----------------------------------------------------------
        function openDetailSheet(scheduleId) {
            const s = (state.day_data.schedules || []).find((x) => x.id === scheduleId);
            if (!s) return;
            const conf = ((state.confirmation && state.confirmation.sites) || []).find((c) => c.schedule_id === s.id);

            const footer = [];
            if (state.canEdit) {
                footer.push(sheetBtn('編集する', () => { api.close(); openEntrySheet(s); }, 'ac-primary'));
                footer.push(sheetBtn('翌日へコピー', async () => {
                    api.close();
                    await copyScheduleToDate(s.id, s.label, addDays(state.selected, 1));
                }));
                footer.push(sheetBtn('削除', async () => { api.close(); await deleteSchedule(s); }, 'ac-danger'));
            }
            // 現場は文字列ではなく site_id で持っているので、将来の現場管理アプリ
            // (元請・工期・工程・写真・日報・請求)へそのまま渡せる。
            // 統合先が受け口(ctx.onOpenSite)を用意したときだけボタンを出す。
            if (s.site_id && ctx.onOpenSite) {
                footer.push(sheetBtn('現場管理を見る', () => { api.close(); ctx.onOpenSite(s.site_id); }));
            }

            const api = sheet(s.label, (box, sheetApi) => {
                function row(label, value) {
                    if (value === null || value === undefined || value === '') return;
                    const r = el('div', 'ac-drow');
                    r.append(el('div', 'ac-dlabel', label));
                    r.append(el('div', 'ac-dvalue', value));
                    box.append(r);
                }

                const head = el('div', 'ac-dhead');
                head.style.borderLeftColor = s.color || '#1a73e8';
                head.append(el('div', 'ac-dsite', s.label));
                const sub = [labelDate(state.selected), s.category_name];
                if (s.status !== 'confirmed') sub.push('未確定');
                head.append(el('div', 'ac-dsub', sub.join(' ／ ')));
                head.append(el('div', 'ac-dcount', `${s.member_count}人`));
                box.append(head);

                row('日付', labelDate(state.selected) + (rokuyouOf(state.selected) ? `（${rokuyouOf(state.selected)}）` : ''));
                row('種別', s.category_name + (s.counts_as_deployment ? '' : '（配置人数に含めない）'));
                if (s.is_subcontracted) row('請負区分', '下請け請負（協力会社だけで施工）');
                if (s.prime_contractor) row('元請', s.prime_contractor);
                row('集合時間', s.meeting_time);
                row('開始 / 終了', [s.start_time, s.end_time].filter(Boolean).join(' 〜 '));

                const emps = s.members.filter((m) => m.member_type === 'employee' && m.assignment_kind !== 'haul');
                const hauls = s.members.filter((m) => m.assignment_kind === 'haul');
                const subsCo = s.members.filter((m) => m.member_type === 'subcontractor_company');
                const subsNamed = s.members.filter((m) => m.member_type === 'subcontractor');

                if (emps.length) {
                    const wrap2 = el('div', 'ac-members');
                    for (const m of emps) {
                        const dtag = memberRoleTag(m);
                        const chip = el('span', 'ac-mem ac-role-' + dtag.key
                            + (m.notification_status === 'confirmed' ? ' ac-confirmed' : ''), '');
                        chip.append(el('span', 'ac-rtag', dtag.label));
                        chip.append(document.createTextNode(m.name));
                        if (isLeaderRole(m.role)) chip.append(el('span', 'ac-leadtag', '職長'));
                        else if (m.role) chip.append(el('span', 'ac-role', m.role));
                        // 誰が何時から何時までいるのかは、詳細では必ず出す
                        chip.append(el('span', 'ac-mt', m.time_label || '終日'));
                        // 「1人を別の現場へ移す」操作はここに置く。
                        // 一覧に置くと、現場を見たいのに社員を押してしまう事故が起きた。
                        if (state.canEdit) {
                            chip.classList.add('ac-movable');
                            chip.addEventListener('click', () => { api.close(); openMemberActionSheet(m, s); });
                        }
                        wrap2.append(chip);
                    }
                    const r = el('div', 'ac-drow');
                    r.append(el('div', 'ac-dlabel', `社員（${emps.length}人）`));
                    r.append(wrap2);
                    box.append(r);
                }

                // 運搬は色ではなくアイコン+文字で、独立した行として出す
                if (hauls.length) {
                    const wrap3 = el('div', 'ac-members');
                    for (const m of hauls) {
                        const chip = el('span', 'ac-mem ac-haulmem'
                            + (m.notification_status === 'confirmed' ? ' ac-confirmed' : ''), '');
                        chip.append(el('span', 'ac-haulmark', '🚚運搬'));
                        chip.append(document.createTextNode(m.name));
                        chip.append(el('span', 'ac-mt', m.time_label || '終日'));
                        // 運んでそのまま働く人は作業員。運搬だけの人が運搬要員。
                        chip.append(el('span', 'ac-role', m.is_haul_only ? '運搬要員' : '作業員'));
                        wrap3.append(chip);
                    }
                    const r = el('div', 'ac-drow');
                    r.append(el('div', 'ac-dlabel', `運搬（${hauls.length}人）`));
                    r.append(wrap3);
                    box.append(r);
                }

                for (const m of subsCo) {
                    const r = el('div', 'ac-drow');
                    r.append(el('div', 'ac-dlabel', '外注'));
                    const v = el('div', 'ac-dvalue');
                    v.append(el('div', 'ac-dstrong', `${m.company_name}　${m.headcount}人`));
                    // 作業員名は任意登録。入っているときだけ出す。
                    if (m.workers && m.workers.length) {
                        v.append(el('div', 'ac-dsmall', '（' + m.workers.map((w) => w.name + (w.phone ? ` ${w.phone}` : '')).join('、') + '）'));
                    } else {
                        v.append(el('div', 'ac-dsmall', '（作業員名は未登録）'));
                    }
                    r.append(v);
                    box.append(r);
                }
                if (subsNamed.length) row('外注（個人指定）', subsNamed.map((m) => m.name).join('、'));

                row('備考', s.note);
                if (s.important_note) {
                    const r = el('div', 'ac-drow');
                    r.append(el('div', 'ac-dlabel', '重要連絡'));
                    const v = el('div', 'ac-dvalue');
                    v.append(el('div', 'ac-important', s.important_note));
                    const done = s.members.filter((m) => m.member_type === 'employee' && m.important_confirmed_at).length;
                    const all = s.members.filter((m) => m.member_type === 'employee').length;
                    v.append(el('div', 'ac-dsmall', `本人確認 ${done}/${all}`));
                    r.append(v);
                    box.append(r);
                }
                if (conf && Number(conf.total) > 0) {
                    row('確認状況', `${conf.confirmed} / ${conf.total} 確認済み`
                        + (conf.unconfirmed_names ? `　未確認: ${conf.unconfirmed_names}` : ''));
                }

                // この予定に関する変更履歴
                const hist = el('div', 'ac-drow');
                hist.append(el('div', 'ac-dlabel', '変更履歴'));
                const hv = el('div', 'ac-dvalue', '読み込み中...');
                hist.append(hv);
                box.append(hist);
                rpc('assignment_get_change_log', { p_employee_code: me, p_date: state.selected })
                    .then((rows) => {
                        const mine = rows.filter((r) => (r.summary || '').includes(s.label)).slice(0, 6);
                        hv.textContent = '';
                        if (!mine.length) { hv.append(el('div', 'ac-dsmall', 'この予定の変更はまだありません')); return; }
                        for (const r of mine) {
                            const t = new Date(r.created_at);
                            hv.append(el('div', 'ac-dsmall',
                                `${pad(t.getHours())}:${pad(t.getMinutes())} ${r.changed_by} — ${r.summary}`));
                        }
                    })
                    .catch(() => { hv.textContent = '（履歴を取得できませんでした）'; });
            }, footer);
        }

        // -----------------------------------------------------------
        // その日の二次的な操作(操作バーの「⋯」)
        // -----------------------------------------------------------
        // 月の延べ人工。「月間売上 ÷ 月間人工」で1人工あたりの出来高を出すための数字。
        // 同じ社員が20日働けば20人工。1日の中で複数現場・作業+運搬でも、その日は1人工。
        async function openMonthTotalSheet() {
            let d = null;
            try {
                d = await rpc('assignment_get_month_headcount',
                    { p_employee_code: me, p_year: state.year, p_month: state.month });
            } catch (e) { fail(e); return; }

            sheet(`${state.year}年${state.month}月 の月間集計`, (box) => {
                box.append(el('div', 'ac-schedmeta',
                    '延べ人工です。同じ人が20日働けば20人工、同じ日に何現場入っても1人工として数えます。'));
                const rows = [
                    ['職人', d.craft, 'ac-hc-craft'],
                    ['事務', d.office, 'ac-hc-office'],
                    ['営業', d.sales, 'ac-hc-sales'],
                    ['外注', d.sub, 'ac-hc-sub'],
                    ['運搬', d.haul, 'ac-hc-haul'],
                    ['その他', d.other, 'ac-hc-other'],
                ];
                const list = el('div', 'ac-list');
                for (const [label, n, cls] of rows) {
                    const it = el('div', 'ac-listitem ac-mrow');
                    const nm = el('div', 'ac-mrowname');
                    nm.append(el('span', `ac-hc ${cls}`, label));
                    it.append(nm);
                    it.append(el('div', 'ac-dstrong', `${n} 人工`));
                    // その他は内訳、外注は通常/下請けの内訳を出す
                    if (label === 'その他' && Number(n) > 0) {
                        it.classList.add('ac-tappable');
                        it.append(el('span', 'ac-chevron', '▾'));
                        it.addEventListener('click', () => openMonthOtherSheet(d));
                    }
                    if (label === '外注' && Number(n) > 0) {
                        it.append(el('div', 'ac-sub2',
                            `通常の応援 ${d.sub_normal} 人工／下請け請負 ${d.sub_contracted} 人工`));
                    }
                    list.append(it);
                }
                box.append(list);

                const total = el('div', 'ac-listitem');
                total.append(el('div', 'ac-menutitle', '計'));
                total.append(el('div', 'ac-dstrong', `${d.total} 人工`));
                box.append(total);

                box.append(el('div', 'ac-schedmeta',
                    `参考: この月に1日でも配置された社員は ${d.unique_employees} 人`
                    + `／配置のあった日は ${d.worked_days} 日`));
            });
        }

        function openMonthOtherSheet(d) {
            sheet(`${state.year}年${state.month}月 その他の内訳`, (box) => {
                box.append(el('div', 'ac-schedmeta', '種別ごとの延べ人工です。'));
                const rows = d.other_breakdown || [];
                if (!rows.length) { box.append(el('div', 'ac-empty', '内訳はありません')); return; }
                const list = el('div', 'ac-list');
                for (const r of rows) {
                    const it = el('div', 'ac-listitem');
                    it.append(el('div', 'ac-menutitle', r.label));
                    it.append(el('div', 'ac-sub2', `${r.count} 人工`));
                    list.append(it);
                }
                box.append(list);
            });
        }

        // 「その他」の内訳。種別名(研修・健康診断・ラーメン店…)ごとの人数を出す。
        // 種別は管理者が自由に追加できるので、ここは追加した名前がそのまま並ぶ。
        function openOtherBreakdown(h) {
            sheet('その他の内訳', (box) => {
                box.append(el('div', 'ac-schedmeta',
                    'その日ずっと現場以外の用事だった人を、種別ごとに分けています。'
                    + '現場作業と半々の人は職人・事務として数えており、ここには入りません。'));
                const rows = (h.other_breakdown || []);
                if (!rows.length) { box.append(el('div', 'ac-empty', '内訳はありません')); return; }
                const list = el('div', 'ac-list');
                for (const r of rows) {
                    const it = el('div', 'ac-listitem');
                    it.append(el('div', 'ac-menutitle', r.label));
                    it.append(el('div', 'ac-sub2', `${r.count}人`));
                    list.append(it);
                }
                box.append(list);
                box.append(el('div', 'ac-schedmeta',
                    '種別は「⋯ → カレンダー設定」から追加できます(管理者のみ)。'
                    + '追加した種別に「その他」の枠を付けると、ここへ名前で出ます。'));
            });
        }

        function openDayMenuSheet() {
            sheet(`${labelDate(state.selected)} の操作`, (box, api) => {
                // 2026-09-01 権限仕様: コピー・履歴・LINE共有は社員誰でも使える。
                // 一斉通知と予実照合は影響範囲が大きいので管理者のみに残す。
                const items = [
                    ['前日・別の日からコピー', '現場を選んでコピーできます（1現場だけ／複数）', () => { api.close(); openCopySheet(); }],
                    ['LINE共有用のテキスト', '全体LINEへ貼り付ける文面を作ります', () => { api.close(); openLineSheet(); }],
                    ['この日の変更履歴', '誰が・いつ・何を変えたか（社員も見られます）', () => { api.close(); openHistorySheet(); }],
                ];
                if (state.isAdmin) {
                    items.splice(1, 0, ['未確認の人へ再通知', '通知済みでまだ確認していない人だけに送ります', async () => {
                        api.close();
                        try {
                            const r = await rpc('assignment_notify_unconfirmed', { p_employee_code: me, p_date: state.selected });
                            toast(`${r.renotified}名へ再通知しました`);
                        } catch (e) { fail(e); }
                    }]);
                    items.push(['勤怠(日報)と予実照合', '予定と実際の日報を突き合わせます', async () => {
                        api.close();
                        try {
                            const r = await rpc('assignment_reconcile_attendance', { p_employee_code: me, p_date: state.selected });
                            toast(`一致${r.matched} / 現場違い${r.mismatched} / 日報なし${r.absent}`);
                            await loadDay(); render();
                        } catch (e) { fail(e); }
                    }]);
                }
                for (const [title, desc, fn] of items) {
                    const it = el('div', 'ac-listitem');
                    it.append(el('div', 'ac-menutitle', title));
                    it.append(el('div', 'ac-sub2', desc));
                    it.addEventListener('click', fn);
                    box.append(it);
                }
            });
        }

        // -----------------------------------------------------------
        // 社員チップを押したときの操作メニュー。
        // 「表示だけに見える」という実機の指摘への対応で、操作をここへ集約する。
        function openMemberActionSheet(member, fromSchedule) {
            sheet(member.name, (box, api) => {
                box.append(el('div', 'ac-schedmeta', fromSchedule.label + '／' + (member.time_label || '終日')));
                const items = [
                    ['当日の役割を変える', dayRoleText(member),
                        () => { api.close(); openDayRoleSheet(member, fromSchedule); }],
                    ['別の現場へ移す', 'この日の他の現場へ移します',
                        () => { api.close(); openMoveSheet(member, fromSchedule); }],
                    ['時間を変える', member.time_label || '終日',
                        () => { api.close(); openEntrySheet(fromSchedule); }],
                    [isLeaderRole(member.role) ? '職長を解除する' : 'この人を職長にする',
                        isLeaderRole(member.role) ? '現在この現場の職長です' : 'この現場の職長にします',
                        async () => { api.close(); await toggleLeader(member, fromSchedule); }],
                    ['運搬を追加する', '同じ人を運搬にも入れます(兼務できます)',
                        () => { api.close(); openEntrySheet(fromSchedule); }],
                ];
                const list = el('div', 'ac-list');
                for (const [title, desc, fn] of items) {
                    const it = el('div', 'ac-listitem');
                    it.append(el('div', 'ac-menutitle', title));
                    if (desc) it.append(el('div', 'ac-sub2', desc));
                    it.addEventListener('click', fn);
                    list.append(it);
                }
                box.append(list);
            });
        }

        function dayRoleText(m) {
            if (!m.headcount_role) {
                return '自動（いまは' + (ROLE_LABELS[m.day_role] || ROLE_LABELS.craft).label + '）';
            }
            if (m.headcount_role === 'other') {
                return 'その他（' + (m.headcount_role_label || '内訳なし') + '）';
            }
            return (ROLE_LABELS[m.headcount_role] || ROLE_LABELS.craft).label + '（この日だけ）';
        }

        // その日・その配置だけの役割を決める。社員マスターは書き換えない。
        function openDayRoleSheet(member, fromSchedule) {
            sheet(member.name + ' の当日の役割', (box, api) => {
                box.append(el('div', 'ac-schedmeta',
                    'この日・この現場だけの役割です。社員マスターの区分は変わらないので、'
                    + '翌日はいつもどおりに戻ります。'));
                const choices = [
                    ['', '自動', '種別と社員マスターから判定します'],
                    ['craft', '職人', '現場作業として数えます'],
                    ['office', '事務', '事務仕事として数えます'],
                    ['sales', '営業', '営業として数えます'],
                    ['haul', '運搬', '運搬として数えます'],
                ];
                const list = el('div', 'ac-list');
                for (const [val, label, desc] of choices) {
                    const it = el('div', 'ac-listitem' + ((member.headcount_role || '') === val ? ' ac-on' : ''));
                    it.append(el('div', 'ac-menutitle', label));
                    it.append(el('div', 'ac-sub2', desc));
                    it.addEventListener('click', async () => {
                        api.close();
                        await saveDayRole(member, fromSchedule, val, null);
                    });
                    list.append(it);
                }
                box.append(list);

                // 「その他」は何のその他かまで決めないと後から分からないので、
                // 選べる名前を並べて選ばせる(種別マスターの「その他」枠がそのまま候補)。
                box.append(el('div', 'ac-label', 'その他（内訳を選ぶ）'));
                const others = (state.categories || []).filter((c) => c.headcount_group === 'other');
                const tokens = el('div', 'ac-tokens');
                for (const c of others) {
                    const on = member.headcount_role === 'other' && member.headcount_role_label === c.name;
                    const t = el('button', 'ac-token' + (on ? ' ac-on' : ''), c.name);
                    t.addEventListener('click', async () => {
                        api.close();
                        await saveDayRole(member, fromSchedule, 'other', c.name);
                    });
                    tokens.append(t);
                }
                if (!others.length) {
                    tokens.append(el('div', 'ac-schedmeta', '「その他」の種別がまだありません。'));
                }
                box.append(tokens);
                box.append(el('div', 'ac-schedmeta',
                    'ここに無い業務(ラーメン店・研修など)は、「⋯ → カレンダー設定」で種別を追加し、'
                    + '枠を「その他」にすると候補に出ます(管理者のみ)。'));
            });
        }

        // 役割の保存。既存の保存RPCへ、その配置のメンバーをそのまま渡し直す。
        async function saveDayRole(member, fromSchedule, role, label) {
            const members = (fromSchedule.members || []).map((x) => memberToPayload(x,
                x.member_id === member.member_id
                    ? { headcount_role: role, headcount_role_label: role === 'other' ? (label || '') : '' }
                    : {}));
            try {
                await saveScheduleWithMembers(fromSchedule, members, {});
                toast(role ? '当日の役割を変えました' : '自動に戻しました');
            } catch (e) { fail(e); }
        }

        // 画面が持っているメンバー表示用のデータを、保存RPCが受け取る形へ戻す。
        function memberToPayload(x, patch) {
            let base;
            if (x.member_type === 'employee') {
                base = {
                    member_type: 'employee', employee_code: x.employee_code,
                    role: x.role || '', meeting_time: x.meeting_time || '',
                    start_time: x.start_time || '', end_time: x.end_time || '',
                    assignment_kind: x.assignment_kind || 'work',
                    headcount_role: x.headcount_role || '',
                    headcount_role_label: x.headcount_role_label || '',
                };
            } else if (x.member_type === 'subcontractor_company') {
                base = {
                    member_type: 'subcontractor_company',
                    subcontractor_company_id: x.subcontractor_company_id,
                    headcount: x.headcount || 1,
                    workers: (x.workers || []).map((w) => ({
                        subcontractor_worker_id: w.subcontractor_worker_id || null,
                        name: w.name || '', phone: w.phone || '',
                    })),
                };
            } else {
                base = { member_type: 'subcontractor', subcontractor_worker_id: x.subcontractor_worker_id };
            }
            return Object.assign(base, patch || {});
        }

        // 現場の内容はそのままに、メンバーだけ入れ替えて保存する共通処理。
        async function saveScheduleWithMembers(s, members, extra) {
            await rpc('assignment_save_schedule', Object.assign({
                p_employee_code: me, p_schedule_id: s.id, p_date: state.selected,
                p_site_id: s.site_id, p_category_id: s.category_id, p_title: s.title || null,
                p_start_time: s.start_time || null, p_end_time: s.end_time || null,
                p_meeting_time: s.meeting_time || null, p_note: s.note || null,
                p_important_note: s.important_note || null,
                p_members: members, p_status: s.status,
            }, extra || {}));
            await Promise.all([loadMonth(), loadDay()]);
            render();
        }

        // 職長の付け外し。編集画面を開かずにここからも切り替えられるようにする。
        async function toggleLeader(member, fromSchedule) {
            const on = !isLeaderRole(member.role);
            const members = (fromSchedule.members || []).map((x) => memberToPayload(x,
                x.member_id === member.member_id ? { role: on ? LEADER_ROLE : '' } : {}));
            try {
                // 職長を決めたら「職長未定」の印は外す
                await saveScheduleWithMembers(fromSchedule, members, on ? { p_leader_undecided: false } : {});
                toast(on ? member.name + ' を職長にしました' : '職長を解除しました');
            } catch (e) { fail(e); }
        }

        // 職長を決める / 今は決められない(職長未定)を選ぶ
        function openLeaderSheet(s) {
            sheet(s.label + ' の職長', (box, api) => {
                box.append(el('div', 'ac-schedmeta',
                    '職長を選ぶか、今は決められない場合は「職長未定」にしてください。'
                    + '未定にすると警告は出なくなり、あとから決め直せます。'));
                const emps = (s.members || []).filter((m) => m.member_type === 'employee'
                    && (m.assignment_kind || 'work') !== 'haul');
                const list = el('div', 'ac-list');
                for (const m of emps) {
                    const it = el('div', 'ac-listitem' + (isLeaderRole(m.role) ? ' ac-on' : ''));
                    it.append(el('div', 'ac-menutitle', m.name));
                    it.append(el('div', 'ac-sub2', isLeaderRole(m.role) ? '現在の職長' : 'この人を職長にする'));
                    it.addEventListener('click', async () => { api.close(); await toggleLeader(m, s); });
                    list.append(it);
                }
                if (!emps.length) {
                    list.append(el('div', 'ac-empty', 'この現場にはまだ社員が入っていません。'));
                }
                box.append(list);

                const und = el('button', 'ac-btn' + (s.leader_undecided ? ' ac-primary' : ''),
                    s.leader_undecided ? '職長未定のまま' : '職長未定にする（いまは決められない）');
                und.style.width = '100%';
                und.addEventListener('click', async () => {
                    api.close();
                    const members = (s.members || []).map((x) => memberToPayload(x,
                        isLeaderRole(x.role) ? { role: '' } : {}));
                    try {
                        await saveScheduleWithMembers(s, members, { p_leader_undecided: true });
                        toast('職長未定にしました');
                    } catch (e) { fail(e); }
                });
                box.append(und);
                if (s.leader_undecided) {
                    const clear = el('button', 'ac-btn', '未定をやめる（また警告を出す）');
                    clear.style.width = '100%';
                    clear.style.marginTop = '6px';
                    clear.addEventListener('click', async () => {
                        api.close();
                        try {
                            await saveScheduleWithMembers(s, (s.members || []).map((x) => memberToPayload(x, {})),
                                { p_leader_undecided: false });
                            toast('未定をやめました');
                        } catch (e) { fail(e); }
                    });
                    box.append(clear);
                }
            });
        }

        // 「この人を別の現場へ移す」(同じ日の中での移動)
        // -----------------------------------------------------------
        function openMoveSheet(member, fromSchedule) {
            sheet(`${member.name} を移す`, (box, api) => {
                box.append(el('div', 'ac-schedmeta', `現在: ${fromSchedule.label}`));
                const others = (state.day_data.schedules || []).filter((x) => x.id !== fromSchedule.id);
                if (!others.length) {
                    box.append(el('div', 'ac-empty', 'この日には他の配置がありません。先に移動先の現場を登録してください。'));
                } else {
                    box.append(el('div', 'ac-label', '移動先を選ぶ'));
                    const list = el('div', 'ac-list');
                    list.style.maxHeight = 'none';
                    for (const t of others) {
                        const it = el('div', 'ac-listitem');
                        const nm = el('div', null, t.label);
                        nm.style.borderLeft = `5px solid ${t.color || '#1a73e8'}`;
                        nm.style.paddingLeft = '6px';
                        nm.style.fontWeight = '700';
                        it.append(nm);
                        it.append(el('div', 'ac-sub2',
                            `${t.category_name}${t.meeting_time ? ' ／ 集合 ' + t.meeting_time : ''} ／ ${t.members.length}名`));
                        it.addEventListener('click', async () => {
                            try {
                                const r = await rpc('assignment_move_member', {
                                    p_employee_code: me, p_member_id: member.member_id,
                                    p_to_schedule_id: t.id, p_reason: null,
                                });
                                api.close();
                                toast(`${r.name} ${r.from_label} → ${r.to_label}`
                                    + (r.renotified ? `（本人へ再通知しました）` : ''));
                                await Promise.all([loadMonth(), loadDay()]);
                                render();
                            } catch (e) { fail(e); }
                        });
                        list.append(it);
                    }
                    box.append(list);
                }

                const off = el('div', 'ac-field');
                off.style.marginTop = '10px';
                const remove = sheetBtn(`${member.name} をこの現場から外す`, async () => {
                    const ok = await confirmSheet(`${member.name} を ${fromSchedule.label} から外します。`, '外す', true);
                    if (!ok) return;
                    const rest = fromSchedule.members
                        .filter((x) => x.member_id !== member.member_id)
                        .map((x) => (x.member_type === 'employee'
                            ? { member_type: 'employee', employee_code: x.employee_code, role: x.role || '', meeting_time: x.meeting_time || '' }
                            : { member_type: 'subcontractor', subcontractor_worker_id: x.subcontractor_worker_id }));
                    try {
                        const r = await rpc('assignment_save_schedule', {
                            p_employee_code: me, p_schedule_id: fromSchedule.id, p_date: state.selected,
                            p_site_id: fromSchedule.site_id, p_category_id: fromSchedule.category_id,
                            p_title: fromSchedule.title || null,
                            p_start_time: fromSchedule.start_time || null, p_end_time: fromSchedule.end_time || null,
                            p_meeting_time: fromSchedule.meeting_time || null, p_note: fromSchedule.note || null,
                            p_members: rest, p_status: fromSchedule.status,
                        });
                        api.close();
                        toast(`${member.name} を外しました` + (r.renotified ? '（本人へ通知しました）' : ''));
                        await Promise.all([loadMonth(), loadDay()]);
                        render();
                    } catch (e) { fail(e); }
                }, 'ac-danger');
                remove.style.width = '100%';
                off.append(remove);
                box.append(off);
            });
        }

        // -----------------------------------------------------------
        // 社員向け「自分の予定」
        // -----------------------------------------------------------
        function renderMine(container) {
            if (!state.mine.length) {
                container.append(el('div', 'ac-empty', 'これから先の配置はまだありません'));
                return;
            }
            const t = todayJST();
            const tomorrow = addDays(t, 1);
            const sorted = state.mine.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            for (const row of sorted) {
                if (row.date < t) continue;
                const isNext = row.date === t || row.date === tomorrow;
                const card = el('div', 'ac-mycard' + (isNext ? ' ac-next' : ''));
                card.style.borderLeftColor = row.color || '#12213f';
                card.append(el('div', 'ac-mydate',
                    `${labelDate(row.date)}${row.date === t ? '（今日）' : row.date === tomorrow ? '（明日）' : ''}`));
                card.append(el('div', 'ac-mysite', row.label));
                if (row.meeting_time) {
                    const mt = el('div', 'ac-mymeet', '集合 ');
                    mt.append(el('b', null, row.meeting_time));
                    card.append(mt);
                }
                if (row.role) card.append(el('div', 'ac-myrow', `役割: ${row.role}`));
                if (row.members) card.append(el('div', 'ac-myrow', `メンバー(${row.member_count}人): ${row.members}`));
                if (row.prime_contractor) card.append(el('div', 'ac-myrow', `元請: ${row.prime_contractor}`));
                if (row.note) card.append(el('div', 'ac-myrow', `備考: ${row.note}`));
                if (row.important_note) {
                    const imp = el('div', 'ac-important');
                    imp.append(el('div', 'ac-importanthead', '重要連絡・持ち物'));
                    imp.append(el('div', null, row.important_note));
                    card.append(imp);
                }

                const b = el('button', 'ac-confirmbtn' + (row.notification_status === 'confirmed' ? ' ac-done' : ''),
                    row.notification_status === 'confirmed'
                        ? '✓ 確認済み'
                        : (row.important_note ? '重要連絡もあわせて確認しました' : '確認しました'));
                if (row.notification_status !== 'confirmed') {
                    b.addEventListener('click', async () => {
                        b.disabled = true;
                        try {
                            await rpc('assignment_confirm_my_assignment', { p_employee_code: me, p_member_id: row.member_id });
                            row.notification_status = 'confirmed';
                            toast('確認しました');
                            render();
                        } catch (e) { b.disabled = false; fail(e); }
                    });
                }
                card.append(b);
                container.append(card);
            }
        }

        // -----------------------------------------------------------
        // シートの共通部分
        // -----------------------------------------------------------
        function sheet(title, buildBody, footerButtons) {
            const back = el('div', 'ac-sheet');
            const body = el('div', 'ac-sheetbody');
            const head = el('div', 'ac-sheethead');
            const h = el('h3', null, title);
            const close = el('button', 'ac-hbtn ac-icon', '✕');
            const scroll = el('div', 'ac-sheetscroll');
            head.append(h, close);
            body.append(head, scroll);
            if (footerButtons && footerButtons.length) {
                const foot = el('div', 'ac-sheetfoot');
                for (const b of footerButtons) foot.append(b);
                body.append(foot);
            }
            back.append(body);
            const api = {
                close() { back.remove(); },
                setTitle(t) { h.textContent = t; },
                scroll,
            };
            close.addEventListener('click', api.close);
            back.addEventListener('click', (ev) => { if (ev.target === back) api.close(); });
            buildBody(scroll, api);
            root.append(back);
            return api;
        }
        function sheetBtn(label, onClick, extra) {
            const b = el('button', 'ac-btn' + (extra ? ' ' + extra : ''), label);
            b.addEventListener('click', onClick);
            return b;
        }

        // ブラウザ標準の confirm() はPWAだと「localhost では次のように表示されています」の
        // ような出所表示付きのダイアログになり、業務アプリの画面としては読みにくい。
        // 見た目と文言を自分で制御できるよう、モジュール内のシートで確認を取る。
        function confirmSheet(message, okLabel, danger) {
            return new Promise((resolve) => {
                let done = false;
                const finish = (v) => { if (!done) { done = true; resolve(v); } };
                const api = sheet('確認', (box) => {
                    const p = el('div', null, message);
                    p.style.fontSize = '14px';
                    p.style.lineHeight = '1.7';
                    p.style.whiteSpace = 'pre-wrap';
                    p.style.padding = '4px 2px 10px';
                    box.append(p);
                }, [
                    sheetBtn('キャンセル', () => { finish(false); api.close(); }),
                    sheetBtn(okLabel || 'OK', () => { finish(true); api.close(); }, danger ? 'ac-danger' : 'ac-primary'),
                ]);
                // 背景タップや✕で閉じられた場合もキャンセル扱いにする
                const origClose = api.close;
                api.close = () => { finish(false); origClose(); };
            });
        }

        // -----------------------------------------------------------
        // 日付ジャンプ(1ヶ月ずつスワイプさせない)
        // -----------------------------------------------------------
        function openJumpSheet() {
            sheet('日付を指定して移動', (box, api) => {
                const f = el('div', 'ac-field');
                f.append(el('div', 'ac-label', '年月日を直接指定'));
                const input = el('input', 'ac-input');
                input.type = 'date';
                input.value = state.selected;
                f.append(input);
                box.append(f);

                const go = el('div', 'ac-field');
                go.append(sheetBtn('この日へ移動', () => {
                    if (!input.value) return;
                    api.close();
                    jumpTo(input.value);
                }, 'ac-primary'));
                box.append(go);

                const yf = el('div', 'ac-field');
                yf.append(el('div', 'ac-label', '年を選ぶ(過去の履歴もそのまま開けます)'));
                const years = el('div', 'ac-tokens');
                const nowY = Number(todayJST().slice(0, 4));
                for (let y = nowY - 8; y <= nowY + 2; y += 1) {
                    const t = el('button', 'ac-token' + (y === state.year ? ' ac-on' : ''), `${y}`);
                    t.addEventListener('click', () => {
                        state.year = y; api.close(); syncSelectedToMonth();
                        Promise.all([loadMonth(), loadDay()]).then(render);
                    });
                    years.append(t);
                }
                yf.append(years);
                box.append(yf);

                const mf = el('div', 'ac-field');
                mf.append(el('div', 'ac-label', '月を選ぶ'));
                const months = el('div', 'ac-tokens');
                for (let m = 1; m <= 12; m += 1) {
                    const t = el('button', 'ac-token' + (m === state.month ? ' ac-on' : ''), `${m}月`);
                    t.addEventListener('click', () => {
                        state.month = m; api.close(); syncSelectedToMonth();
                        Promise.all([loadMonth(), loadDay()]).then(render);
                    });
                    months.append(t);
                }
                mf.append(months);
                box.append(mf);
            });
        }

        // -----------------------------------------------------------
        // 検索
        // -----------------------------------------------------------
        function openSearchSheet() {
            sheet('検索', (box, api) => {
                const input = el('input', 'ac-input');
                input.placeholder = '社員名・外注名・現場名・元請・種別・備考';
                box.append(input);
                const hint = el('div', 'ac-schedmeta', '数年前の履歴もそのまま検索できます。');
                box.append(hint);
                const results = el('div');
                box.append(results);

                let timer = null;
                async function run() {
                    const q = input.value.trim();
                    results.innerHTML = '';
                    if (!q) return;
                    try {
                        const r = await rpc('assignment_search', { p_employee_code: me, p_query: q, p_limit: 200 });
                        hint.textContent = `${r.total}件`;
                        if (!r.rows.length) { results.append(el('div', 'ac-empty', '該当なし')); return; }
                        for (const row of r.rows) {
                            const item = el('div', 'ac-result');
                            item.append(el('div', 'ac-rdate', `${row.date}（${DOW_JP[dowOf(row.date)]}）`));
                            const lbl = el('div', 'ac-rlabel', row.label);
                            lbl.style.borderLeft = `5px solid ${row.color || '#1a73e8'}`;
                            lbl.style.paddingLeft = '5px';
                            item.append(lbl);
                            item.append(el('div', 'ac-rmem', `${row.category_name}${row.members ? ' ／ ' + row.members : ''}`));
                            item.addEventListener('click', () => { api.close(); jumpTo(row.date); });
                            results.append(item);
                        }
                    } catch (e) { fail(e); }
                }
                input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
                setTimeout(() => input.focus(), 60);
            });
        }

        // -----------------------------------------------------------
        // 配置の登録・編集(連続高速入力)
        // -----------------------------------------------------------
        async function openEntrySheet(existing) {
            await loadEmployees();
            let sites = [];
            try { sites = await rpc('search_sites', { p_query: '', p_employee_code: me }); } catch (e) { fail(e); }

            const draft = {
                schedule_id: existing ? existing.id : null,
                site_id: existing ? existing.site_id : null,
                site_name: existing ? (existing.site_name || existing.label) : null,
                title: existing && !existing.site_id ? existing.title : '',
                category_id: existing ? existing.category_id
                    : (state.categories.find((c) => c.code === 'work') || state.categories[0] || {}).id,
                start_time: existing ? (existing.start_time || '') : '',
                end_time: existing ? (existing.end_time || '') : '',
                meeting_time: existing ? (existing.meeting_time || '') : '',
                note: existing ? (existing.note || '') : '',
                important_note: existing ? (existing.important_note || '') : '',
                is_subcontracted: existing ? !!existing.is_subcontracted : false,
                members: existing
                    ? existing.members.filter((m) => m.member_type === 'employee').map((m) => ({
                        member_type: 'employee', employee_code: m.employee_code, name: m.name,
                        role: m.role || '', meeting_time: m.meeting_time || '',
                        start_time: m.start_time || '', end_time: m.end_time || '',
                        assignment_kind: m.assignment_kind || 'work',
                    }))
                    : [],
                // 外注は「会社 + 人数」が基本。作業員名(workers)は任意。
                subs: existing
                    ? existing.members.filter((m) => m.member_type === 'subcontractor_company').map((m) => ({
                        member_type: 'subcontractor_company',
                        subcontractor_company_id: m.subcontractor_company_id,
                        company_name: m.company_name,
                        short_name: m.company_short_name,
                        headcount: m.headcount || 1,
                        workers: (m.workers || []).map((w) => ({
                            subcontractor_worker_id: w.subcontractor_worker_id || null,
                            name: w.name || '', phone: w.phone || '',
                        })),
                    }))
                    : [],
            };
            let savedCount = 0;

            const api = sheet(
                `${labelDate(state.selected)} の配置を${existing ? '編集' : '登録'}`,
                (box) => buildEntryForm(box, draft, sites),
                [
                    sheetBtn('登録して次の現場へ', async () => {
                        if (await saveDraft(draft)) {
                            savedCount += 1;
                            // 日付と種別は保ったまま、現場とメンバーだけ空にする。
                            // 翌日の配置は「現場を変えて同じ操作を繰り返す」ため、これが最短経路になる。
                            draft.schedule_id = null; draft.site_id = null; draft.site_name = null;
                            draft.title = ''; draft.members = []; draft.subs = [];
                            draft.meeting_time = ''; draft.note = '';
                            api.setTitle(`${labelDate(state.selected)} の配置を登録（${savedCount}件登録済み）`);
                            api.scroll.innerHTML = '';
                            buildEntryForm(api.scroll, draft, sites);
                            api.scroll.scrollTop = 0;
                        }
                    }, 'ac-primary'),
                    sheetBtn('登録して閉じる', async () => {
                        if (await saveDraft(draft)) api.close();
                    }),
                ],
            );
        }

        function buildEntryForm(box, draft, sites) {
            // 1) 現場(検索して選ぶ。フリーテキスト入力はしない)
            const siteField = el('div', 'ac-field');
            siteField.append(el('div', 'ac-label', '現場（現場マスターから選ぶ）'));
            const picked = el('div', 'ac-picked');
            const siteSearch = el('input', 'ac-input');
            siteSearch.placeholder = '現場名で絞り込み';
            const siteList = el('div', 'ac-list');

            function renderSitePick() {
                picked.innerHTML = '';
                if (draft.site_id) {
                    picked.append(el('span', null, draft.site_name));
                    const clear = el('button', 'ac-btn ac-sm', '変更');
                    clear.addEventListener('click', () => { draft.site_id = null; draft.site_name = null; renderSitePick(); });
                    picked.append(el('div', 'ac-spacer'), clear);
                    picked.style.display = 'flex';
                    siteSearch.style.display = 'none';
                    siteList.style.display = 'none';
                } else {
                    picked.style.display = 'none';
                    siteSearch.style.display = 'block';
                    siteList.style.display = 'block';
                    renderSiteList();
                }
            }
            function renderSiteList() {
                const q = siteSearch.value.trim();
                siteList.innerHTML = '';
                const filtered = sites.filter((s) => !q || s.site_name.includes(q)).slice(0, 60);
                for (const s of filtered) {
                    const it = el('div', 'ac-listitem', s.site_name);
                    if (s.recently_used) it.append(el('span', 'ac-sublabel', '最近'));
                    it.addEventListener('click', () => { draft.site_id = s.id; draft.site_name = s.site_name; renderSitePick(); });
                    siteList.append(it);
                }
                if (!filtered.length) siteList.append(el('div', 'ac-empty', '該当する現場がありません（現場マスターへの追加が必要です）'));
            }
            siteSearch.addEventListener('input', renderSiteList);
            siteField.append(picked, siteSearch, siteList);

            // 現場を伴わない予定(会議・休み等)のためのタイトル
            const titleField = el('div', 'ac-field');
            titleField.append(el('div', 'ac-label', '現場がない予定の名前（会議・休み・車検など）'));
            const titleInput = el('input', 'ac-input');
            titleInput.value = draft.title || '';
            titleInput.placeholder = '現場を選んだ場合は空のままで構いません';
            titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
            titleField.append(titleInput);

            // 2) 種別
            const catField = el('div', 'ac-field');
            const catLabel = el('div', 'ac-label ac-labelrow');
            catLabel.append(el('span', null, '種別（色）'));
            // 「種別はどこから追加するのか」が分からない、という指摘への対応。
            // 実際に種別を選ぶこの場所からも設定画面へ行けるようにする。
            //
            // 2026-09-01: 管理者だけに出す。種別は会社全体で共有するマスターで、
            // 更新は assignment_upsert_category が require_assignment_admin で弾いている。
            // それまでは一般社員にもこのリンクが見えており、開いて操作してから
            // 権限エラーになる状態だった(データは守られていたが、押せる場所に
            // 押せない操作を置かない。⚙カレンダー設定と同じ扱いに揃える)。
            if (state.isAdmin) {
                const catEdit = el('button', 'ac-linkbtn', '種別を追加・編集');
                catEdit.addEventListener('click', openCategorySheet);
                catLabel.append(catEdit);
            }
            catField.append(catLabel);
            const cats = el('div', 'ac-tokens ac-onerow');
            for (const c of state.categories) {
                const t = el('button', 'ac-token ac-cat' + (c.id === draft.category_id ? ' ac-on' : ''), c.name);
                t.style.borderLeftColor = c.color;
                t.addEventListener('click', () => {
                    draft.category_id = c.id;
                    cats.querySelectorAll('.ac-token').forEach((x) => x.classList.remove('ac-on'));
                    t.classList.add('ac-on');
                });
                cats.append(t);
            }
            catField.append(cats);

            // 3) メンバー(社員マスターからタップで複数選択)
            const memField = el('div', 'ac-field');
            const memLabel = el('div', 'ac-label ac-labelrow');
            memLabel.append(el('span', null, '社員（タップで選択／もう一度タップで解除）'));
            const memCount = el('span', 'ac-selcount', '0人');
            memLabel.append(memCount);
            memField.append(memLabel);
            // 社員が30名を超えると、トークンだけで画面9行ぶんになり、
            // その下の外注入力まで毎回スクロールすることになる。
            // 絞り込みを付け、選択済みは常に先頭へ出して、指の移動を減らす。
            const memFilter = el('input', 'ac-input');
            memFilter.placeholder = '社員名で絞り込み';
            const memTokens = el('div', 'ac-tokens');
            function renderMembers() {
                memTokens.innerHTML = '';
                const q = memFilter.value.trim();
                const selected = [];
                const rest = [];
                // 運搬は別枠で管理するので、ここでは現場作業(work)だけを見る。
                // 同じ人が運搬と作業を兼務できるようにするための区別。
                const isWork = (m) => m.member_type === 'employee' && (m.assignment_kind || 'work') === 'work';
                for (const e of state.employees) {
                    const on = draft.members.some((m) => isWork(m) && m.employee_code === e.employee_code);
                    if (on) selected.push(e);
                    else if (!q || e.employee_name.includes(q) || e.employee_code.includes(q)) rest.push(e);
                }
                memCount.textContent = `${selected.length}人`;
                for (const e of selected.concat(rest)) {
                    const on = draft.members.some((m) => isWork(m) && m.employee_code === e.employee_code);
                    const t = el('button', 'ac-token' + (on ? ' ac-on' : ''), e.employee_name);
                    t.addEventListener('click', () => {
                        const i = draft.members.findIndex((m) => isWork(m) && m.employee_code === e.employee_code);
                        if (i >= 0) draft.members.splice(i, 1);
                        else draft.members.push({
                            member_type: 'employee', employee_code: e.employee_code, name: e.employee_name,
                            role: '', meeting_time: '', start_time: '', end_time: '', assignment_kind: 'work',
                        });
                        renderMembers(); renderDetailRows();
                    });
                    memTokens.append(t);
                }
                if (!selected.length && !rest.length) {
                    memTokens.append(el('div', 'ac-schedmeta', '該当する社員がいません'));
                }
            }
            memFilter.addEventListener('input', renderMembers);
            memField.append(memFilter);
            memField.append(memTokens);
            renderMembers();

            // 外注は「協力会社を選ぶ → 人数を入れる」で完了する。
            // 実運用では作業員の個人名まで入力しないため、名前は任意扱いにしている。
            const subField = el('div', 'ac-field');
            const subHead = el('div', 'ac-label', '外注（協力会社と人数）');
            subField.append(subHead);
            const subPicked = el('div');
            const addCoBtn = el('button', 'ac-btn', '＋ 協力会社を追加');
            addCoBtn.addEventListener('click', openCompanyPicker);

            function renderSubPicked() {
                subPicked.innerHTML = '';
                for (const sub of draft.subs) {
                    const card = el('div', 'ac-subcard');

                    const top = el('div', 'ac-subtop');
                    top.append(el('div', 'ac-subname', sub.company_name));
                    const remove = el('button', 'ac-del', '✕');
                    remove.title = 'この協力会社を外す';
                    remove.addEventListener('click', () => {
                        draft.subs.splice(draft.subs.indexOf(sub), 1);
                        renderSubPicked();
                    });
                    top.append(el('div', 'ac-spacer'), remove);
                    card.append(top);

                    // 人数(この数字が人工集計の正。作業員名の件数ではない)
                    const cnt = el('div', 'ac-subcount');
                    const minus = el('button', 'ac-step', '−');
                    const num = el('span', 'ac-stepnum', `${sub.headcount}人`);
                    const plus = el('button', 'ac-step', '＋');
                    minus.addEventListener('click', () => {
                        sub.headcount = Math.max(1, (sub.headcount || 1) - 1);
                        num.textContent = `${sub.headcount}人`;
                    });
                    plus.addEventListener('click', () => {
                        sub.headcount = Math.min(99, (sub.headcount || 1) + 1);
                        num.textContent = `${sub.headcount}人`;
                    });
                    cnt.append(el('span', 'ac-steplabel', '人数'), minus, num, plus);
                    card.append(cnt);

                    // 作業員名(任意)
                    const wrapW = el('div', 'ac-subworkers');
                    function renderWorkers() {
                        wrapW.innerHTML = '';
                        for (const w of sub.workers) {
                            const chip = el('span', 'ac-mem ac-sub', w.name || '(名前なし)');
                            const x = el('button', 'ac-del', '✕');
                            x.addEventListener('click', () => {
                                sub.workers.splice(sub.workers.indexOf(w), 1);
                                renderWorkers();
                            });
                            chip.append(x);
                            wrapW.append(chip);
                        }
                        const addW = el('button', 'ac-btn ac-sm', '＋ 名前を追加（任意）');
                        addW.addEventListener('click', () => openWorkerPicker(sub, renderWorkers));
                        wrapW.append(addW);
                    }
                    renderWorkers();
                    card.append(wrapW);

                    subPicked.append(card);
                }
                if (!draft.subs.length) {
                    subPicked.append(el('div', 'ac-schedmeta',
                        '外注が入る場合だけ追加してください。会社と人数だけで登録できます。'));
                }
            }

            // 協力会社の選択
            function openCompanyPicker() {
                sheet('協力会社を選ぶ', async (box, api) => {
                    box.append(el('div', 'ac-empty', '読み込み中...'));
                    try {
                        const rows = await rpc('assignment_list_subcontractor_companies', { p_employee_code: me });
                        box.innerHTML = '';
                        if (!rows.length) {
                            box.append(el('div', 'ac-empty', '協力会社が登録されていません（外注会社マスターへの登録が必要です）'));
                            return;
                        }
                        const list = el('div', 'ac-list');
                        list.style.maxHeight = 'none';
                        for (const co of rows) {
                            if (draft.subs.some((x) => x.subcontractor_company_id === co.id)) continue;
                            const it = el('div', 'ac-listitem');
                            it.append(el('div', 'ac-menutitle', co.company_name));
                            it.append(el('div', 'ac-sub2',
                                `月表示では「${co.label}3」のように出ます${co.recently_used ? ' ／ 最近使用' : ''}`));
                            it.addEventListener('click', () => {
                                draft.subs.push({
                                    member_type: 'subcontractor_company',
                                    subcontractor_company_id: co.id,
                                    company_name: co.company_name,
                                    short_name: co.short_name,
                                    headcount: 1,
                                    workers: [],
                                });
                                api.close();
                                renderSubPicked();
                            });
                            list.append(it);
                        }
                        box.append(list);
                    } catch (e) { box.innerHTML = ''; fail(e); }
                });
            }

            // 作業員名(任意)。マスター登録済みは選択、未登録はその場で入力。
            function openWorkerPicker(sub, onDone) {
                sheet(`${sub.company_name} の作業員名（任意）`, async (box, api) => {
                    box.append(el('div', 'ac-schedmeta',
                        '名前は分かる場合だけで構いません。人数は上で入力した数が正になります。'));

                    box.append(el('div', 'ac-label', 'マスターに登録済みの作業員から選ぶ'));
                    const list = el('div', 'ac-list');
                    box.append(list);
                    try {
                        const rows = await rpc('search_subcontractor_workers', { p_query: '' });
                        const mine = rows.filter((w) => w.subcontractor_company_id === sub.subcontractor_company_id);
                        if (!mine.length) {
                            list.append(el('div', 'ac-empty', 'この会社の作業員はマスターに登録されていません'));
                        }
                        for (const w of mine) {
                            if (sub.workers.some((x) => x.subcontractor_worker_id === w.id)) continue;
                            const it = el('div', 'ac-listitem', w.worker_name);
                            it.addEventListener('click', () => {
                                sub.workers.push({ subcontractor_worker_id: w.id, name: w.worker_name, phone: '' });
                                api.close(); onDone();
                            });
                            list.append(it);
                        }
                    } catch (e) { fail(e); }

                    box.append(el('div', 'ac-label', 'マスターに無い人をその場で入力'));
                    const nameIn = el('input', 'ac-input');
                    nameIn.placeholder = '氏名';
                    const phoneIn = el('input', 'ac-input');
                    phoneIn.type = 'tel';
                    phoneIn.placeholder = '電話番号（任意）';
                    const addBtn = sheetBtn('この名前を追加', () => {
                        const nm = nameIn.value.trim();
                        if (!nm) { toast('氏名を入力してください'); return; }
                        sub.workers.push({ subcontractor_worker_id: null, name: nm, phone: phoneIn.value.trim() });
                        api.close(); onDone();
                    }, 'ac-primary');
                    addBtn.style.width = '100%';
                    box.append(nameIn, phoneIn, addBtn);
                });
            }

            subField.append(subPicked, addCoBtn);
            renderSubPicked();

            // 4) 時間・備考
            const timeField = el('div', 'ac-field');
            timeField.append(el('div', 'ac-label', '集合 / 開始 / 終了'));
            const timeRow = el('div', 'ac-row');
            const meetIn = timeInput(draft.meeting_time, (v) => { draft.meeting_time = v; });
            const startIn = timeInput(draft.start_time, (v) => { draft.start_time = v; });
            const endIn = timeInput(draft.end_time, (v) => { draft.end_time = v; });
            timeRow.append(meetIn, startIn, endIn);
            timeField.append(timeRow);

            const noteField = el('div', 'ac-field');
            noteField.append(el('div', 'ac-label', '備考'));
            const noteIn = el('textarea', 'ac-input');
            noteIn.rows = 2;
            noteIn.value = draft.note || '';
            noteIn.addEventListener('input', () => { draft.note = noteIn.value; });
            noteField.append(noteIn);

            // 備考とは別に「必ず読んでほしい連絡」を持たせる。
            // 社員側では確認ボタンの直前に強調表示され、押した時点で既読が記録される。
            const impField = el('div', 'ac-field');
            impField.append(el('div', 'ac-label', '重要連絡・持ち物（本人の確認を取りたいこと）'));
            const impIn = el('textarea', 'ac-input ac-importantinput');
            impIn.rows = 2;
            impIn.placeholder = '例: フルハーネスと資格証を必ず持参';
            impIn.value = draft.important_note || '';
            impIn.addEventListener('input', () => { draft.important_note = impIn.value; });
            impField.append(impIn);
            impField.append(el('div', 'ac-schedmeta',
                '入力すると、社員の画面で赤く表示され、「確認しました」を押した時刻が記録されます。'));

            // 5) メンバーごとの役割・集合時間(必要なときだけ触る)
            const detailField = el('div', 'ac-field');
            detailField.append(el('div', 'ac-label', '社員ごとの時間・役割（必要な人だけ）'));
            const detailRows = el('div');
            detailField.append(detailRows);
            detailField.append(el('div', 'ac-schedmeta',
                '時間を入れなければ「終日」（現場の時間があればその時間）になります。'
                + '午前だけ／午後だけの人がいる場合に開いてください。'));

            // その社員の時間を1行で表す。未入力なら「終日」。
            function memberTimeText(m) {
                if (m.start_time || m.end_time) return `${m.start_time || ''}〜${m.end_time || ''}`;
                if (draft.start_time || draft.end_time) return `現場と同じ（${draft.start_time || ''}〜${draft.end_time || ''}）`;
                return '終日';
            }

            function openMemberTimeSheet(m, onDone) {
                sheet(`${m.name} の時間`, (box, api) => {
                    box.append(el('div', 'ac-schedmeta',
                        '入力しなければ終日として扱います。'
                        + '同じ日に別の現場へ入る場合は、時間を入れておくと重複を正しく判定できます。'));
                    const f = el('div', 'ac-field');
                    f.append(el('div', 'ac-label', '開始 / 終了'));
                    const r = el('div', 'ac-row');
                    const st = timeInput(m.start_time, (v) => { m.start_time = v; });
                    const en = timeInput(m.end_time, (v) => { m.end_time = v; });
                    r.append(st, en);
                    f.append(r);
                    const rf = el('div', 'ac-field');
                    rf.append(el('div', 'ac-label', '役割（任意）'));
                    const roleIn = el('input', 'ac-input');
                    roleIn.placeholder = '例: 職長';
                    roleIn.value = m.role || '';
                    roleIn.addEventListener('input', () => { m.role = roleIn.value; });
                    rf.append(roleIn);
                    const mf = el('div', 'ac-field');
                    mf.append(el('div', 'ac-label', '集合時間（任意）'));
                    mf.append(timeInput(m.meeting_time, (v) => { m.meeting_time = v; }));
                    const clear = sheetBtn('時間を消して終日に戻す', () => {
                        m.start_time = ''; m.end_time = '';
                        api.close(); onDone();
                    });
                    const ok = sheetBtn('この内容にする', () => { api.close(); onDone(); }, 'ac-primary');
                    ok.style.width = '100%';
                    clear.style.width = '100%';
                    box.append(f, rf, mf, clear, ok);
                });
            }

            function renderDetailRows() {
                detailRows.innerHTML = '';
                const work = draft.members.filter((m) => m.member_type === 'employee' && (m.assignment_kind || 'work') === 'work');
                for (const m of work) {
                    const row = el('div', 'ac-mrow');
                    const nm = el('div', 'ac-mrowname', m.name);
                    const tm = el('button', 'ac-mrowtime', memberTimeText(m));
                    tm.addEventListener('click', () => openMemberTimeSheet(m, renderDetailRows));
                    // 職長はここで直接切り替えられるようにする。以前は「役割（任意）」の
                    // 自由入力に「職長」と打つしかなく、警告(職長が指定されていません)は
                    // 出るのに指定する場所が見つからない状態だった。
                    // 保存先はこれまでどおり role なので、集計・警告の判定は変えていない。
                    const lead = el('button', 'ac-leadbtn' + (isLeaderRole(m.role) ? ' ac-on' : ''), '職長');
                    lead.title = '職長にする / 解除する';
                    lead.addEventListener('click', () => {
                        m.role = isLeaderRole(m.role) ? '' : LEADER_ROLE;
                        renderDetailRows();
                    });
                    row.append(nm, tm, lead);
                    // 職長以外の役割(手元・レッカー等)を入れている場合はそのまま出す
                    if (m.role && !isLeaderRole(m.role)) row.append(el('span', 'ac-role', m.role));
                    detailRows.append(row);
                }
                if (!work.length) detailRows.append(el('div', 'ac-schedmeta', '社員を選ぶとここに表示されます'));
                renderHaulRows();
            }

            // ---------- 下請け請負 ----------
            // 現場単位のスイッチにした。会社ごとに選ばせるより1タップで済み、
            // 「この現場は自社が入らない」という現場の性質そのものを表せるため。
            const subcField = el('div', 'ac-field');
            subcField.append(el('div', 'ac-label', '請負区分'));
            const subcBtn = el('button', 'ac-token' + (draft.is_subcontracted ? ' ac-on' : ''),
                draft.is_subcontracted ? '下請け請負（自社は入らない）' : '通常（自社＋外注応援）');
            subcBtn.addEventListener('click', () => {
                draft.is_subcontracted = !draft.is_subcontracted;
                subcBtn.textContent = draft.is_subcontracted ? '下請け請負（自社は入らない）' : '通常（自社＋外注応援）';
                subcBtn.classList.toggle('ac-on', draft.is_subcontracted);
            });
            subcField.append(subcBtn);
            subcField.append(el('div', 'ac-schedmeta',
                '下請け請負にすると、自社社員が0人でも警告を出しません。'
                + '現場一覧・月表示に「下請け」と専用色で表示され、人数は外注として数えます。'));
            box.append(subcField);

            // ---------- 運搬(運送要員) ----------
            // 迅翔興業ではトラックで資材・人員を運ぶ担当がいる。LifeBearではタイヤ印で
            // 識別していた。運搬だけの人も、運搬してそのまま現場で働く人もいるため、
            // 現場作業とは別枠にして「両方に入れる」ことができるようにしている。
            const haulField = el('div', 'ac-field');
            haulField.append(el('div', 'ac-label', '🚚 運搬（この現場への運搬担当）'));
            const haulRows = el('div');
            const addHaulBtn = el('button', 'ac-btn', '＋ 運搬担当を追加');
            addHaulBtn.addEventListener('click', () => {
                sheet('運搬担当を選ぶ', (box, api) => {
                    box.append(el('div', 'ac-schedmeta',
                        '運搬は時間帯で管理することが多いため、追加したあと時間を入れてください。'
                        + '同じ人を現場作業にも入れて構いません（兼務できます）。'));
                    const filt = el('input', 'ac-input');
                    filt.placeholder = '社員名で絞り込み';
                    const toks = el('div', 'ac-tokens');
                    function draw() {
                        toks.innerHTML = '';
                        const q = filt.value.trim();
                        for (const e of state.employees) {
                            if (q && !e.employee_name.includes(q) && !e.employee_code.includes(q)) continue;
                            if (draft.members.some((m) => m.assignment_kind === 'haul' && m.employee_code === e.employee_code)) continue;
                            const t = el('button', 'ac-token', e.employee_name);
                            t.addEventListener('click', () => {
                                draft.members.push({
                                    member_type: 'employee', employee_code: e.employee_code, name: e.employee_name,
                                    role: '', meeting_time: '', start_time: '', end_time: '', assignment_kind: 'haul',
                                });
                                api.close(); renderDetailRows();
                            });
                            toks.append(t);
                        }
                        if (!toks.children.length) toks.append(el('div', 'ac-schedmeta', '選べる社員がいません'));
                    }
                    filt.addEventListener('input', draw);
                    box.append(filt, toks);
                    draw();
                });
            });
            function renderHaulRows() {
                haulRows.innerHTML = '';
                const hauls = draft.members.filter((m) => m.assignment_kind === 'haul');
                for (const m of hauls) {
                    const row = el('div', 'ac-mrow');
                    const nm = el('div', 'ac-mrowname');
                    nm.append(el('span', 'ac-haulmark', '🚚'), document.createTextNode(m.name));
                    const r = el('div', 'ac-row');
                    r.style.flex = '1';
                    r.append(timeInput(m.start_time, (v) => { m.start_time = v; }),
                             timeInput(m.end_time, (v) => { m.end_time = v; }));
                    const del = el('button', 'ac-ord', '×');
                    del.addEventListener('click', () => {
                        const i = draft.members.indexOf(m);
                        if (i >= 0) draft.members.splice(i, 1);
                        renderDetailRows();
                    });
                    row.append(nm, r, del);
                    haulRows.append(row);
                }
                if (!hauls.length) haulRows.append(el('div', 'ac-schedmeta', '運搬がある場合だけ追加してください'));
            }
            haulField.append(haulRows, addHaulBtn);

            renderDetailRows();

            // 並び順は実際の操作順に合わせる。管理者が毎回触るのは「現場」と「社員」の2つで、
            // 種別は既定の「仕事」のままがほとんどのため、色選択を先頭に置くと
            // 社員の選択が画面の下へ押し出されてスクロールが1回増える。
            box.append(siteField, memField, subField, catField, titleField, timeField, noteField, impField,
                       detailField, haulField);
            renderSitePick();
        }

        function timeInput(value, onChange) {
            const i = el('input', 'ac-input');
            i.type = 'time';
            i.value = value || '';
            i.addEventListener('change', () => onChange(i.value));
            return i;
        }

        async function saveDraft(draft) {
            if (!draft.site_id && !String(draft.title || '').trim()) {
                toast('現場を選ぶか、予定の名前を入力してください');
                return false;
            }
            if (!draft.category_id) { toast('種別を選んでください'); return false; }
            try {
                await rpc('assignment_save_schedule', {
                    p_employee_code: me,
                    p_schedule_id: draft.schedule_id,
                    p_date: state.selected,
                    p_site_id: draft.site_id,
                    p_category_id: draft.category_id,
                    p_title: draft.title || null,
                    p_start_time: draft.start_time || null,
                    p_end_time: draft.end_time || null,
                    p_meeting_time: draft.meeting_time || null,
                    p_note: draft.note || null,
                    p_important_note: draft.important_note || null,
                    p_is_subcontracted: !!draft.is_subcontracted,
                    p_members: draft.members.concat(draft.subs.map((x) => ({
                        member_type: 'subcontractor_company',
                        subcontractor_company_id: x.subcontractor_company_id,
                        headcount: x.headcount || 1,
                        workers: (x.workers || []).map((w) => ({
                            subcontractor_worker_id: w.subcontractor_worker_id || null,
                            name: w.name || '', phone: w.phone || '',
                        })),
                    }))),
                    p_status: 'draft',
                });
                toast('登録しました');
                await Promise.all([loadMonth(), loadDay()]);
                render();
                return true;
            } catch (e) { fail(e); return false; }
        }

        // 1件を1つ上/下へ動かして、その日の並び順すべてをまとめて保存する。
        // サーバー側は「その日の全idを順番に受け取る」設計なので、
        // 将来ドラッグ操作を足す場合もこの関数を差し替えるだけで済む。
        async function moveScheduleOrder(scheduleId, delta) {
            const ids = (state.day_data.schedules || []).map((x) => x.id);
            const i = ids.indexOf(scheduleId);
            const j = i + delta;
            if (i < 0 || j < 0 || j >= ids.length) return;
            ids[i] = ids[j]; ids[j] = scheduleId;
            try {
                await rpc('assignment_set_schedule_order', {
                    p_employee_code: me, p_date: state.selected, p_schedule_ids: ids,
                });
                await Promise.all([loadMonth(), loadDay()]);
                render();
            } catch (e) { fail(e); }
        }

        // 重複警告から直接「どの配置を直すか」を選んで編集画面へ入る。
        // 同じ社員が複数の現場に入っているため、警告を見た人が一覧から
        // 該当の現場を自分で探し直すことになっていた。
        function openIssueEditPicker(issue) {
            const targets = (issue.targets || []).filter((t) => t && t.schedule_id);
            if (!targets.length) { toast('対象の配置が見つかりませんでした'); return; }
            const open = (scheduleId) => {
                const sched = (state.day_data.schedules || []).find((x) => x.id === scheduleId);
                if (!sched) { toast('対象の配置が見つかりませんでした'); return; }
                openEntrySheet(sched);
            };
            if (targets.length === 1) { open(targets[0].schedule_id); return; }
            sheet('どちらを編集しますか？', (box, api) => {
                box.append(el('div', 'ac-schedmeta',
                    `${issue.employee_name || ''} の時間が重なっています。直したい方を選んでください。`));
                for (const t of targets) {
                    const b = el('button', 'ac-pickrow');
                    b.append(el('div', 'ac-pickname', t.label));
                    b.append(el('div', 'ac-picktime', t.time_label || '終日'));
                    b.addEventListener('click', () => { api.close(); open(t.schedule_id); });
                    box.append(b);
                }
            });
        }

        async function approveDoubleBooking(employeeCode, approve) {
            try {
                const r = await rpc('assignment_approve_double_booking', {
                    p_employee_code: me, p_target_employee_code: employeeCode,
                    p_date: state.selected, p_approve: approve, p_reason: null,
                });
                toast(`${r.employee_name} の複数現場配置を${approve ? '承認しました' : '承認取消しました'}`);
                await loadDay();
                render();
            } catch (e) { fail(e); }
        }

        async function deleteSchedule(s) {
            const ok = await confirmSheet(
                `「${s.label}」の配置を削除します。\nこの現場に入っている ${s.members.length}名 の配置も一緒に消えます。`,
                '削除する', true);
            if (!ok) return;
            try {
                await rpc('assignment_delete_schedule', { p_employee_code: me, p_schedule_id: s.id, p_reason: null });
                toast('削除しました');
                await Promise.all([loadMonth(), loadDay()]);
                render();
            } catch (e) { fail(e); }
        }

        // 「A現場は昨日と同じ、B現場はメンバー変更、C現場は終了」が日常なので、
        // 全部コピーだけでなく現場を選んでコピーできるようにする。
        function openCopySheet() {
            let from = addDays(state.selected, -1);
            sheet(`${labelDate(state.selected)} へコピー`, (box, api) => {
                const selected = new Set();
                let rows = [];

                const dateRow = el('div', 'ac-field');
                dateRow.append(el('div', 'ac-label', 'どの日からコピーするか'));
                const dateInput = el('input', 'ac-input');
                dateInput.type = 'date';
                dateInput.value = from;
                dateRow.append(dateInput);
                box.append(dateRow);

                const listWrap = el('div');
                box.append(listWrap);

                const foot = el('div', 'ac-field');
                const copySelected = el('button', 'ac-btn ac-primary', '選んだ現場をコピー');
                copySelected.style.width = '100%';
                foot.append(copySelected);
                // 「その日を全部コピー」は一度に大量の配置を書き換えるため管理者のみ
                // (2026-09-01 権限仕様 §6。サーバー側でも同じ判定を行う)。
                const copyAll = el('button', 'ac-btn', 'この日を全部コピー');
                if (state.isAdmin) {
                    copyAll.style.width = '100%';
                    copyAll.style.marginTop = '6px';
                    foot.append(copyAll);
                }
                box.append(foot);

                async function run(ids) {
                    try {
                        const r = await rpc('assignment_copy_schedules', {
                            p_employee_code: me, p_from_date: from, p_to_date: state.selected,
                            p_schedule_ids: ids, p_replace: false,
                        });
                        api.close();
                        toast(r.copied
                            ? `${r.copied}件コピーしました${r.skipped ? `（同じ現場${r.skipped}件はそのまま）` : ''}`
                            : 'コピーできる配置がありませんでした');
                        await Promise.all([loadMonth(), loadDay()]);
                        render();
                    } catch (e) { fail(e); }
                }
                copySelected.addEventListener('click', () => {
                    if (!selected.size) { toast('コピーする現場を選んでください'); return; }
                    run([...selected]);
                });
                copyAll.addEventListener('click', () => run(null));

                async function reload() {
                    listWrap.innerHTML = '';
                    listWrap.append(el('div', 'ac-empty', '読み込み中...'));
                    try {
                        rows = await rpc('assignment_list_copy_source', {
                            p_employee_code: me, p_from_date: from, p_to_date: state.selected,
                        });
                    } catch (e) { listWrap.innerHTML = ''; fail(e); return; }
                    listWrap.innerHTML = '';
                    if (!rows.length) {
                        listWrap.append(el('div', 'ac-empty', `${labelDate(from)} には配置がありません`));
                        return;
                    }
                    const label = el('div', 'ac-label ac-labelrow');
                    label.append(el('span', null, `${labelDate(from)} の配置（タップで選択）`));
                    const selCount = el('span', 'ac-selcount', '0件');
                    label.append(selCount);
                    listWrap.append(label);

                    const list = el('div', 'ac-list');
                    list.style.maxHeight = 'none';
                    for (const row of rows) {
                        const it = el('div', 'ac-listitem' + (row.already_exists ? ' ac-disabled' : ''));
                        const nm = el('div', 'ac-menutitle', row.label);
                        nm.style.borderLeft = `5px solid ${row.color || '#1a73e8'}`;
                        nm.style.paddingLeft = '6px';
                        it.append(nm);
                        it.append(el('div', 'ac-sub2', row.already_exists
                            ? 'この日に同じ現場が既にあります'
                            : `${row.category_name} ／ ${row.member_count}人 ／ ${row.members}`));
                        if (!row.already_exists) {
                            it.addEventListener('click', () => {
                                if (selected.has(row.schedule_id)) { selected.delete(row.schedule_id); it.classList.remove('ac-picked-row'); }
                                else { selected.add(row.schedule_id); it.classList.add('ac-picked-row'); }
                                selCount.textContent = `${selected.size}件`;
                            });
                        }
                        list.append(it);
                    }
                    listWrap.append(list);
                }
                dateInput.addEventListener('change', () => {
                    if (!dateInput.value || dateInput.value === state.selected) return;
                    from = dateInput.value;
                    selected.clear();
                    reload();
                });
                reload();
            });
        }

        // 詳細画面から「この現場だけ翌日へコピー」
        async function copyScheduleToDate(scheduleId, label, toDate) {
            try {
                const r = await rpc('assignment_copy_schedules', {
                    p_employee_code: me, p_from_date: state.selected, p_to_date: toDate,
                    p_schedule_ids: [scheduleId], p_replace: false,
                });
                if (r.copied) toast(`${label} を ${labelDate(toDate)} へコピーしました`);
                else toast(`${labelDate(toDate)} には既に同じ現場があります`);
                await loadMonth();
                render();
            } catch (e) { fail(e); }
        }

        async function confirmDay() {
            const errs = ((state.issues && state.issues.issues) || []).filter((i) => i.severity === 'error');
            if (errs.length) {
                const msg = errs.map((i) => '・' + i.message).join('\n');
                const ok = await confirmSheet(
                    `次の問題があります。\n\n${msg}\n\nこのまま確定して社員へ通知しますか?`,
                    'このまま確定する', true);
                if (!ok) return;
            }
            try {
                const r = await rpc('assignment_confirm_day', { p_employee_code: me, p_date: state.selected });
                toast(`確定しました（${r.notified}名へ通知）`);
                await Promise.all([loadMonth(), loadDay()]);
                render();
            } catch (e) { fail(e); }
        }

        // -----------------------------------------------------------
        // LINE共有・履歴・カテゴリ・メニュー
        // -----------------------------------------------------------
        function openLineSheet() {
            sheet('LINE共有用テキスト', async (box) => {
                const area = el('textarea', 'ac-input');
                area.rows = 16;
                area.value = '読み込み中...';
                box.append(area);
                const row = el('div', 'ac-field');
                const copy = sheetBtn('コピーする', async () => {
                    try {
                        await navigator.clipboard.writeText(area.value);
                        toast('コピーしました。LINEへ貼り付けてください');
                    } catch (_) {
                        area.select();
                        toast('テキストを選択しました。長押しでコピーしてください');
                    }
                }, 'ac-primary');
                row.append(copy);
                box.append(row);
                box.append(el('div', 'ac-schedmeta',
                    '社員ポータルの個別通知とは別に、移行期のあいだは全体LINEへも貼り付けて共有します。'));
                try {
                    area.value = await rpc('assignment_get_line_share_text', { p_employee_code: me, p_date: state.selected });
                } catch (e) { area.value = ''; fail(e); }
            });
        }

        // 誰でも配置を編集できる代わりに、「誰が・いつ・何を・どう変えたか」を
        // 社員自身がこの画面から必ず追えるようにする(2026-09-01 権限仕様 §4)。
        // 管理者はここから削除前の状態へ戻せる(§5)。戻した操作自体も履歴に残る。
        const CHANGE_TYPE_LABEL = {
            create: '追加', update: '変更', delete: '削除', move: '移動',
            order: '並び替え', copy: 'コピー', confirm: '確定', restore: '復元',
        };

        function openHistorySheet() {
            sheet(`${labelDate(state.selected)} の変更履歴`, async (box) => {
                async function reload() {
                    box.innerHTML = '';
                    box.append(el('div', 'ac-empty', '読み込み中...'));
                    let rows = [];
                    try { rows = await rpc('assignment_get_change_log', { p_employee_code: me, p_date: state.selected }); }
                    catch (e) { box.innerHTML = ''; fail(e); return; }
                    box.innerHTML = '';
                    box.append(el('div', 'ac-schedmeta',
                        'この日の配置を誰が変更したかの記録です。削除しても記録は消えません。'));
                    if (!rows.length) { box.append(el('div', 'ac-empty', '変更履歴はありません')); return; }
                    for (const r of rows) {
                        const item = el('div', 'ac-result');
                        const t = new Date(r.created_at);
                        const who = r.changed_by_employee_code
                            ? `${r.changed_by}（${r.changed_by_employee_code}）`
                            : r.changed_by;
                        item.append(el('div', 'ac-rdate',
                            `${pad(t.getHours())}:${pad(t.getMinutes())}　${CHANGE_TYPE_LABEL[r.change_type] || r.change_type}　${who}`));
                        item.append(el('div', 'ac-rmem', r.summary));
                        const meta = [];
                        if (r.site_name) meta.push(`現場: ${r.site_name}`);
                        if (r.target_employee_name) meta.push(`対象: ${r.target_employee_name}`);
                        if (r.reason) meta.push(`理由: ${r.reason}`);
                        if (meta.length) item.append(el('div', 'ac-schedmeta', meta.join('　')));
                        // 「この状態に戻す」は影響が大きいため管理者のみ。
                        if (state.isAdmin && r.can_restore) {
                            const btns = el('div', 'ac-issuebtns');
                            const b = el('button', 'ac-btn ac-sm ac-primary', 'この状態に戻す');
                            b.addEventListener('click', async () => {
                                // 確認はアプリ内の確認シートで行う。window.confirm は
                                // 画面の見た目が揃わないうえ、実ブラウザでの検証もできない。
                                const ok = await confirmSheet(
                                    `${r.summary}\n\nこの削除を取り消して、削除する直前の状態へ戻します。`,
                                    'この状態に戻す', false);
                                if (!ok) return;
                                b.disabled = true;
                                try {
                                    await rpc('assignment_restore_schedule',
                                        { p_employee_code: me, p_change_log_id: r.id, p_reason: '変更履歴から復元' });
                                    toast('削除する前の状態へ戻しました');
                                    // 月グリッドにも戻さないと、復元したのに月表示から消えたままになる
                                    await Promise.all([loadMonth(), loadDay()]);
                                    render();
                                    await reload();
                                } catch (e) { b.disabled = false; fail(e); }
                            });
                            btns.append(b);
                            item.append(btns);
                        }
                        box.append(item);
                    }
                }
                await reload();
            });
        }

        function openCategorySheet() {
            sheet('種別・カテゴリー管理', async (box) => {
                async function reload() {
                    box.innerHTML = '';
                    box.append(el('div', 'ac-schedmeta',
                        '月表示のチップの色と、配置人数に数えるかどうかをここで決めます。'
                        + '休み・会議など現場へ出ない種別は「人数に数える」を外してください。'));

                    let rows = [];
                    try { rows = await rpc('assignment_list_categories', { p_employee_code: me, p_include_inactive: true }); }
                    catch (e) { fail(e); return; }

                    for (let i = 0; i < rows.length; i += 1) {
                        const c = rows[i];
                        const card = el('div', 'ac-catcard');

                        const top = el('div', 'ac-cattop');
                        const swatch = el('input', 'ac-catcolor');
                        swatch.type = 'color';
                        swatch.value = c.color;
                        const name = el('input', 'ac-input ac-catname');
                        name.value = c.name;
                        top.append(swatch, name);
                        card.append(top);

                        const opts = el('div', 'ac-catopts');
                        const deploy = el('button', 'ac-token' + (c.counts_as_deployment ? ' ac-on' : ''),
                            c.counts_as_deployment ? '人数に数える' : '人数に数えない');
                        deploy.addEventListener('click', () => {
                            c.counts_as_deployment = !c.counts_as_deployment;
                            deploy.textContent = c.counts_as_deployment ? '人数に数える' : '人数に数えない';
                            deploy.classList.toggle('ac-on', c.counts_as_deployment);
                        });
                        const active = el('button', 'ac-token' + (c.is_active ? ' ac-on' : ''),
                            c.is_active ? '使う' : '使わない');
                        active.addEventListener('click', () => {
                            c.is_active = !c.is_active;
                            active.textContent = c.is_active ? '使う' : '使わない';
                            active.classList.toggle('ac-on', c.is_active);
                        });
                        // 上部の人数サマリーでどの枠に数えるか。
                        // 「自動」は社員の職種(職人/事務/営業)で判定する従来どおりの動き。
                        // 「その他」にすると、その種別名が“その他”の内訳へ出る
                        // (研修・健康診断・ラーメン店 など、会社の業務が増えたときはここで足す)。
                        const GROUPS = [
                            { v: null, label: '自動(職種で判定)' },
                            { v: 'haul', label: '運搬' },
                            { v: 'sales', label: '営業' },
                            { v: 'other', label: 'その他' },
                        ];
                        const gi = Math.max(0, GROUPS.findIndex((g) => g.v === (c.headcount_group || null)));
                        let gIdx = gi;
                        const group = el('button', 'ac-token' + (c.headcount_group ? ' ac-on' : ''),
                            `枠: ${GROUPS[gi].label}`);
                        group.title = '上部の人数サマリーでこの種別をどこに数えるか';
                        group.addEventListener('click', () => {
                            gIdx = (gIdx + 1) % GROUPS.length;
                            c.headcount_group = GROUPS[gIdx].v;
                            group.textContent = `枠: ${GROUPS[gIdx].label}`;
                            group.classList.toggle('ac-on', !!c.headcount_group);
                        });
                        const up = el('button', 'ac-ord', '↑');
                        const down = el('button', 'ac-ord', '↓');
                        up.addEventListener('click', () => moveCategory(rows, i, -1));
                        down.addEventListener('click', () => moveCategory(rows, i, 1));
                        const save = el('button', 'ac-btn ac-sm ac-primary', '保存');
                        save.addEventListener('click', async () => {
                            try {
                                await rpc('assignment_upsert_category', {
                                    p_employee_code: me, p_id: c.id, p_name: name.value,
                                    p_color: swatch.value, p_sort_order: c.sort_order,
                                    p_is_active: c.is_active, p_counts_as_deployment: c.counts_as_deployment,
                                    p_headcount_group: c.headcount_group || null,
                                });
                                toast('保存しました');
                                await loadMonth(); await loadDay(); render();
                            } catch (e) { fail(e); }
                        });
                        opts.append(deploy, group, active, el('div', 'ac-spacer'), up, down, save);
                        card.append(opts);

                        if (c.usage_count > 0) {
                            card.append(el('div', 'ac-sub2', `${c.usage_count}件の配置で使用中`));
                        }
                        box.append(card);
                    }

                    async function moveCategory(list, idx, delta) {
                        const j = idx + delta;
                        if (j < 0 || j >= list.length) return;
                        const a = list[idx], b = list[j];
                        const tmp = a.sort_order; a.sort_order = b.sort_order; b.sort_order = tmp;
                        try {
                            for (const x of [a, b]) {
                                await rpc('assignment_upsert_category', {
                                    p_employee_code: me, p_id: x.id, p_name: x.name, p_color: x.color,
                                    p_sort_order: x.sort_order, p_is_active: x.is_active,
                                    p_counts_as_deployment: x.counts_as_deployment,
                                });
                            }
                            await loadMonth(); render();
                            reload();
                        } catch (e) { fail(e); }
                    }

                    // --- 新しい種別の追加 ---
                    const add = el('div', 'ac-catcard ac-catadd');
                    add.append(el('div', 'ac-label', '＋ 種別を追加'));
                    const newTop = el('div', 'ac-cattop');
                    const newColor = el('input', 'ac-catcolor');
                    newColor.type = 'color';
                    newColor.value = '#1a73e8';
                    const newName = el('input', 'ac-input ac-catname');
                    newName.placeholder = '種別の名前（例: 夜間工事）';
                    newTop.append(newColor, newName);
                    add.append(newTop);
                    const addBtn = el('button', 'ac-btn ac-primary', 'この種別を追加');
                    addBtn.style.width = '100%';
                    addBtn.addEventListener('click', async () => {
                        if (!newName.value.trim()) { toast('種別の名前を入力してください'); return; }
                        try {
                            await rpc('assignment_upsert_category', {
                                p_employee_code: me, p_id: null, p_name: newName.value,
                                p_color: newColor.value, p_sort_order: null, p_is_active: true,
                                p_counts_as_deployment: true,
                            });
                            toast('追加しました');
                            await loadMonth(); render();
                            reload();
                        } catch (e) { fail(e); }
                    });
                    add.append(addBtn);
                    box.append(add);
                }
                reload();
            });
        }

        // 外注会社の表示略称(月表示で「人手3」と出すための短い名前)
        function openCompanyShortNameSheet() {
            sheet('外注会社の表示略称', async (box) => {
                box.append(el('div', 'ac-schedmeta',
                    '月表示の1日セルは狭いため、「株式会社ひとで工業 3人」ではなく「人手3」と出します。'
                    + '略称を空にすると正式名称をそのまま使います。会社の追加や正式名称の変更は社員ポータルの外注マスターで行います。'));
                let rows = [];
                try { rows = await rpc('assignment_list_subcontractor_companies', { p_employee_code: me }); }
                catch (e) { fail(e); return; }
                for (const co of rows) {
                    const card = el('div', 'ac-catcard');
                    card.append(el('div', 'ac-menutitle', co.company_name));
                    const row = el('div', 'ac-cattop');
                    const input = el('input', 'ac-input');
                    input.value = co.short_name || '';
                    input.placeholder = '略称（例: 人手）';
                    const save = el('button', 'ac-btn ac-sm ac-primary', '保存');
                    save.addEventListener('click', async () => {
                        try {
                            await rpc('assignment_set_company_short_name', {
                                p_employee_code: me, p_company_id: co.id, p_short_name: input.value,
                            });
                            toast('保存しました');
                            await loadMonth(); await loadDay(); render();
                        } catch (e) { fail(e); }
                    });
                    row.append(input, save);
                    card.append(row);
                    box.append(card);
                }
            });
        }

        // カレンダー設定(種別・略称などの入口をまとめる)
        function openSettingsSheet() {
            sheet('カレンダー設定', (box, api) => {
                const items = [
                    ['種別・カテゴリー管理', '色・並び順・人数集計の対象かどうか。新しい種別の追加もここ', () => { api.close(); openCategorySheet(); }],
                    ['外注会社の表示略称', '月表示で「人手3」のように短く出すための略称', () => { api.close(); openCompanyShortNameSheet(); }],
                    ['メールから抽出された予定候補', 'メール秘書AIが見つけた日付を候補として取り込む', () => { api.close(); openMailCandidateSheet(); }],
                ];
                for (const [title, desc, fn] of items) {
                    const it = el('div', 'ac-listitem');
                    it.append(el('div', 'ac-menutitle', title));
                    it.append(el('div', 'ac-sub2', desc));
                    it.addEventListener('click', fn);
                    box.append(it);
                }
            });
        }

        function openMenuSheet() {
            sheet('メニュー', (box, api) => {
                const items = [
                    ['自分の予定を見る', '社員として自分の配置を確認する画面', () => { api.close(); state.view = 'me'; loadMine().then(render); }],
                    [state.showNames ? '月表示: 社員名を隠す' : '月表示: 社員名も出す',
                        '現場名の下に配置された人の姓を出す（そのぶん表示件数は減ります）', () => {
                            state.showNames = !state.showNames; api.close(); render();
                        }],
                    [`月表示の件数: ${state.maxChipsOverride ? state.maxChipsOverride + '件' : '自動（画面の高さに合わせる）'}`,
                        'タップするたびに切り替わります', () => {
                            const cur = state.maxChipsOverride;
                            state.maxChipsOverride = cur === null ? 3 : (cur >= 9 ? null : cur + 1);
                            api.close(); render();
                        }],
                ];
                if (state.isAdmin) {
                    items.push(['⚙ カレンダー設定', '種別の追加・色の変更・外注会社の略称', () => { api.close(); openSettingsSheet(); }]);
                }
                for (const [title, desc, fn] of items) {
                    const it = el('div', 'ac-listitem');
                    it.append(el('div', 'ac-menutitle', title));
                    if (desc) it.append(el('div', 'ac-sub2', desc));
                    it.addEventListener('click', fn);
                    box.append(it);
                }
            });
        }

        function openMailCandidateSheet() {
            sheet('メール秘書AIが抽出した予定候補', async (box) => {
                box.append(el('div', 'ac-empty', '読み込み中...'));
                try {
                    const rows = await rpc('assignment_list_mail_candidates', { p_employee_code: me, p_days_ahead: 90 });
                    box.innerHTML = '';
                    box.append(el('div', 'ac-schedmeta',
                        'メールから抽出された日付は、そのままでは確定予定にしません。取り込むと「候補」として登録され、内容を確認して確定するまで社員へ通知されません。'));
                    if (!rows.length) { box.append(el('div', 'ac-empty', '候補はありません')); return; }
                    for (const r of rows) {
                        const item = el('div', 'ac-result');
                        item.append(el('div', 'ac-rdate', r.date));
                        item.append(el('div', 'ac-rlabel', r.title));
                        if (r.already_imported) {
                            item.append(el('div', 'ac-rmem', '取り込み済み'));
                        } else {
                            const b = el('button', 'ac-btn ac-sm', '候補として取り込む');
                            b.addEventListener('click', async () => {
                                try {
                                    await rpc('assignment_import_mail_candidate', { p_employee_code: me, p_calendar_event_id: r.calendar_event_id });
                                    toast('候補として取り込みました');
                                    jumpTo(r.date);
                                } catch (e) { fail(e); }
                            });
                            item.append(b);
                        }
                        box.append(item);
                    }
                } catch (e) { box.innerHTML = ''; fail(e); }
            });
        }

        // -----------------------------------------------------------
        // 全体描画
        // -----------------------------------------------------------
        // stickyの吸着位置に使うヘッダー高さを実測して反映する。
        // Safe Area(ノッチ)や狭幅時のpadding変更で高さが変わるため、固定値にしない。
        function syncHeaderHeight() {
            const h = Math.round(elHeader.getBoundingClientRect().height);
            if (h > 0) root.style.setProperty('--ac-header-h', `${h}px`);
            const d = elWeekNav.style.display === 'none'
                ? 0 : Math.round(elWeekNav.getBoundingClientRect().height);
            root.style.setProperty('--ac-datebar-h', `${d}px`);
            root.style.setProperty('--ac-stick-h', `${h + d}px`);
        }

        // このモジュールの上に別の帯(開発用シェルのSTAGING帯、統合後は社員ポータルの
        // ヘッダー等)がある場合、その高さぶんだけ自分の高さを縮める。
        // これをやらないと画面からはみ出し、結局ページ全体がスクロールしてしまう。
        function syncHostOffset() {
            const top = Math.max(0, Math.round(root.getBoundingClientRect().top));
            const cur = parseInt(root.style.getPropertyValue('--ac-host-offset') || '0', 10) || 0;
            // 自分自身の高さを変えると rect.top も動きうるので、実際に変わったときだけ書く
            if (Math.abs(top - cur) >= 1) root.style.setProperty('--ac-host-offset', `${top}px`);
        }

        function render() {
            renderHeader();
            syncHostOffset();
            syncHeaderHeight();
            elOffline.style.display = state.offline ? 'block' : 'none';
            elBody.innerHTML = '';
            if (state.view === 'me') {
                renderMine(elBody);
            } else {
                renderMonth(elBody);
                renderDay(elBody);
                reflowMonthIfNeeded();
                syncWeekStripVisibility();
            }
        }

        // 月グリッドが画面外へ出たら、同じカレンダーが1週間ぶんに縮んで上部へ残る。
        // requestAnimationFrame はタブが非表示のときに止まるため、
        // スクロール量に追従できないことがある。単純な間引きにしておく。
        let stripTimer = null;
        elBody.addEventListener('scroll', () => {
            if (stripTimer) return;
            stripTimer = setTimeout(() => {
                stripTimer = null;
                syncWeekStripVisibility();
            }, 60);
        }, { passive: true });

        // 画面の回転・サイズ変更で「1セルに何件入るか」が変わるため、描画をやり直す。
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { if (state.view === 'month') render(); }, 200);
        });
        // iOS Safariはスクロール中にツールバーが伸縮して表示領域の高さが変わる。
        // window.resize が飛ばないことがあるため visualViewport でも追従する。
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => { syncHostOffset(); syncHeaderHeight(); }, 120);
            });
        }

        // 初期ロード。管理者かどうかはサーバーの判定(is_assignment_admin)を正とする。
        (async function init() {
            await loadMonth();
            if (!state.canEdit && !ctx.defaultView) state.view = 'me';
            if (state.view === 'me') await loadMine(); else await loadDay();
            render();
        })();

        return {
            refresh: () => Promise.all([loadMonth(), loadDay()]).then(render),
            goToDate: jumpTo,
            destroy: () => { root.innerHTML = ''; root.classList.remove('ac-root'); },
        };
    }

    window.AssignmentCalendar = { mount };
})();
