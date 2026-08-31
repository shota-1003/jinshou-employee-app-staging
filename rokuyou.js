'use strict';

/* 六曜(先勝・友引・先負・仏滅・大安・赤口)の算出。
 *
 * ■ なぜ必要か
 *   葬儀・通夜の日程を決める際、その日が「友引」かどうかを即座に確認できることに
 *   実務上の意味がある(友引の日は火葬場が休みのことが多く、葬儀を避ける慣習がある)。
 *   カレンダーを見た瞬間に判断できる必要があるため、月表示に常時表示する。
 *
 * ■ なぜ人手登録ではなく計算なのか
 *   六曜は「旧暦(天保暦)の月と日」から一意に決まる:
 *       六曜 = (旧暦月 + 旧暦日) mod 6
 *       0=大安 1=赤口 2=先勝 3=友引 4=先負 5=仏滅
 *   毎年データを登録する運用にすると、登録漏れの年だけ表示が消える。
 *   過去数年の履歴も未来の予定も同じ精度で見たいので、日付から必ず算出する。
 *
 * ■ 旧暦の求め方(天保暦の規則)
 *   1. 朔(新月)の瞬間を求め、その日を旧暦1日とする。
 *   2. 冬至(太陽黄経270度)を含む月を11月とする。
 *   3. 中気(太陽黄経が30度の倍数になる瞬間)を含まない月を閏月とし、
 *      直前の月と同じ月番号を与える。
 *   朔と太陽黄経は Meeus "Astronomical Algorithms" の計算式で求める。
 *   求めるのは「JSTでの暦日」なので、分単位の誤差は結果に影響しない。
 *
 * ■ 祝日とは別データ
 *   祝日は company_holidays テーブル(会社の休業日として編集され得る)。
 *   六曜は編集対象ではない純粋な暦の計算結果なので、DBには持たせない。
 *
 * ブラウザでは window.Rokuyou、Nodeでは module.exports で使える。
 */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.Rokuyou = api;
}(typeof self !== 'undefined' ? self : this, function () {

    const NAMES = ['大安', '赤口', '先勝', '友引', '先負', '仏滅'];
    const RAD = Math.PI / 180;

    function sin(deg) { return Math.sin(deg * RAD); }
    function norm360(x) { return ((x % 360) + 360) % 360; }

    // --- 暦日 ⇔ ユリウス日 -------------------------------------------------
    // 0時UTC基準のユリウス日。実行環境のタイムゾーンに依存しないよう
    // Date.UTC を使わず整数演算で行う(DEV-002)。
    function gregorianToJD(y, m, d) {
        if (m <= 2) { y -= 1; m += 12; }
        const a = Math.floor(y / 100);
        const b = 2 - a + Math.floor(a / 4);
        return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + b - 1524.5;
    }
    function jdToGregorian(jd) {
        const z = Math.floor(jd + 0.5);
        let a = z;
        if (z >= 2299161) {
            const alpha = Math.floor((z - 1867216.25) / 36524.25);
            a = z + 1 + alpha - Math.floor(alpha / 4);
        }
        const b = a + 1524;
        const c = Math.floor((b - 122.1) / 365.25);
        const d = Math.floor(365.25 * c);
        const e = Math.floor((b - d) / 30.6001);
        const day = b - d - Math.floor(30.6001 * e);
        const month = e < 14 ? e - 1 : e - 13;
        const year = month > 2 ? c - 4716 : c - 4715;
        return { y: year, m: month, d: day };
    }

    // JST(UTC+9)での「何日目か」を表す整数。日付の前後関係の比較に使う。
    function jdToJstDayNumber(jd) { return Math.floor(jd + 0.5 + 9 / 24); }
    function dateToJstDayNumber(y, m, d) { return Math.floor(gregorianToJD(y, m, d) + 0.5 + 9 / 24); }

    // 地球時(TT)と世界時(UT)の差。1年で数十秒のオーダーで、暦日の判定には
    // ほぼ影響しないが、朔が真夜中直前に起きる年のずれを避けるため補正する。
    function deltaTSeconds(year) {
        if (year >= 2005 && year < 2050) {
            const t = year - 2000;
            return 62.92 + 0.32217 * t + 0.005589 * t * t;
        }
        if (year >= 1986 && year < 2005) {
            const t = year - 2000;
            return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t
                + 0.000651814 * t * t * t * t + 0.00002373599 * t * t * t * t * t;
        }
        if (year >= 2050 && year <= 2150) {
            const u = (year - 1820) / 100;
            return -20 + 32 * u * u - 0.5628 * (2150 - year);
        }
        const u = (year - 1820) / 100;
        return -20 + 32 * u * u;
    }

    // --- 朔(新月) ---------------------------------------------------------
    // Meeus 第49章。k=0 が2000年1月6日の新月。
    function newMoonJD(k) {
        const T = k / 1236.85;
        const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
        let jde = 2451550.09766 + 29.530588861 * k
            + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;

        const E = 1 - 0.002516 * T - 0.0000074 * T2;
        const M = 2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3;          // 太陽の平均近点角
        const M1 = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4; // 月の平均近点角
        const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;  // 月の緯度引数
        const Om = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;

        jde += -0.40720 * sin(M1)
            + 0.17241 * E * sin(M)
            + 0.01608 * sin(2 * M1)
            + 0.01039 * sin(2 * F)
            + 0.00739 * E * sin(M1 - M)
            - 0.00514 * E * sin(M1 + M)
            + 0.00208 * E * E * sin(2 * M)
            - 0.00111 * sin(M1 - 2 * F)
            - 0.00057 * sin(M1 + 2 * F)
            + 0.00056 * E * sin(2 * M1 + M)
            - 0.00042 * sin(3 * M1)
            + 0.00042 * E * sin(M + 2 * F)
            + 0.00038 * E * sin(M - 2 * F)
            - 0.00024 * E * sin(2 * M1 - M)
            - 0.00017 * sin(Om)
            - 0.00007 * sin(M1 + 2 * M)
            + 0.00004 * sin(2 * M1 - 2 * F)
            + 0.00004 * sin(3 * M)
            + 0.00003 * sin(M1 + M - 2 * F)
            + 0.00003 * sin(2 * M1 + 2 * F)
            - 0.00003 * sin(M1 + M + 2 * F)
            + 0.00003 * sin(M1 - M + 2 * F)
            - 0.00002 * sin(M1 - M - 2 * F)
            - 0.00002 * sin(3 * M1 + M)
            + 0.00002 * sin(4 * M1);

        // 主要な惑星摂動(Meeusの追加補正のうち影響の大きいもの)
        const A1 = 299.77 + 0.107408 * k - 0.009173 * T2;
        const A2 = 251.88 + 0.016321 * k;
        const A3 = 251.83 + 26.651886 * k;
        const A4 = 349.42 + 36.412478 * k;
        const A5 = 84.66 + 18.206239 * k;
        const A6 = 141.74 + 53.303771 * k;
        const A7 = 207.14 + 2.453732 * k;
        const A8 = 154.84 + 7.306860 * k;
        const A9 = 34.52 + 27.261239 * k;
        const A10 = 207.19 + 0.121824 * k;
        const A11 = 291.34 + 1.844379 * k;
        const A12 = 161.72 + 24.198154 * k;
        const A13 = 239.56 + 25.513099 * k;
        const A14 = 331.55 + 3.592518 * k;
        jde += 0.000325 * sin(A1) + 0.000165 * sin(A2) + 0.000164 * sin(A3)
            + 0.000126 * sin(A4) + 0.000110 * sin(A5) + 0.000062 * sin(A6)
            + 0.000060 * sin(A7) + 0.000056 * sin(A8) + 0.000047 * sin(A9)
            + 0.000042 * sin(A10) + 0.000040 * sin(A11) + 0.000037 * sin(A12)
            + 0.000035 * sin(A13) + 0.000023 * sin(A14);

        // TT → UT
        const approxYear = 2000 + k / 12.3685;
        return jde - deltaTSeconds(approxYear) / 86400;
    }

    // --- 太陽黄経 ---------------------------------------------------------
    function solarLongitude(jd) {
        const T = (jd - 2451545.0) / 36525;
        const T2 = T * T;
        const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T2;
        const M = 357.52911 + 35999.05029 * T - 0.0001537 * T2;
        const C = (1.914602 - 0.004817 * T - 0.000014 * T2) * sin(M)
            + (0.019993 - 0.000101 * T) * sin(2 * M)
            + 0.000289 * sin(3 * M);
        const Om = 125.04 - 1934.136 * T;
        return norm360(L0 + C - 0.00569 - 0.00478 * sin(Om));
    }

    // 中気の番号(0..11)。太陽黄経を30度ごとに区切ったもの。
    // 270度(冬至)は9番で、これを含む月が旧暦11月になる。
    function majorTermIndex(jd) { return Math.floor(solarLongitude(jd) / 30); }

    // 指定年の冬至(太陽黄経270度)のJDを二分法で求める
    function winterSolsticeJD(year) {
        let lo = gregorianToJD(year, 12, 15);
        let hi = gregorianToJD(year, 12, 25);
        for (let i = 0; i < 60; i += 1) {
            const mid = (lo + hi) / 2;
            // 270度をまたぐかどうかを、270度基準の相対角で判定する
            const rel = norm360(solarLongitude(mid) - 270);
            if (rel < 180) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
    }

    // --- 朔の検索 ---------------------------------------------------------
    // 指定のJST日番号以下で最大の朔(その日が旧暦1日になる朔)のkを返す
    function newMoonIndexOnOrBefore(dayNumber) {
        let k = Math.round((dayNumber - 2451550.09766 - 0.5 - 9 / 24) / 29.530588861);
        // 推定から前後にずらして厳密に合わせる
        while (jdToJstDayNumber(newMoonJD(k)) > dayNumber) k -= 1;
        while (jdToJstDayNumber(newMoonJD(k + 1)) <= dayNumber) k += 1;
        return k;
    }

    // --- 旧暦への変換 -----------------------------------------------------
    function kyureki(year, month, day) {
        const dn = dateToJstDayNumber(year, month, day);
        const kCur = newMoonIndexOnOrBefore(dn);
        const lunarDay = dn - jdToJstDayNumber(newMoonJD(kCur)) + 1;

        // この日が属する「旧暦年」の基準となる11月(冬至を含む月)を求める。
        // 冬至は12月下旬なので、対象日の年とその前年の冬至を見て、
        // 対象の月の開始より前にある方を基準にする。
        let anchorYear = year;
        let k11 = month11Index(anchorYear);
        if (k11 > kCur) { anchorYear = year - 1; k11 = month11Index(anchorYear); }
        const k11Next = month11Index(anchorYear + 1);

        // 基準の11月から次の11月までが13か月なら、その間に閏月がある
        const monthsInYear = k11Next - k11;
        let leapK = -1;
        if (monthsInYear === 13) {
            for (let k = k11; k < k11Next; k += 1) {
                if (!hasMajorTerm(k)) { leapK = k; break; }
            }
        }

        // 基準の11月から順に月番号を割り当てる
        let num = 11;
        let isLeap = false;
        for (let k = k11; k <= kCur; k += 1) {
            if (k === k11) { num = 11; isLeap = false; continue; }
            if (k === leapK) { isLeap = true; continue; }   // 閏月は前月と同じ番号
            num = num % 12 + 1;
            isLeap = false;
        }

        return { month: num, day: lunarDay, isLeap };
    }

    // 指定年の冬至を含む月(旧暦11月)を開始する朔のkを返す
    function month11Index(year) {
        const ws = winterSolsticeJD(year);
        return newMoonIndexOnOrBefore(jdToJstDayNumber(ws));
    }

    // 朔kで始まる月が中気を含むか。月の長さ(約29.53日)より中気の間隔(約30.4日)の方が
    // 長いため、月内で中気番号が変わらなければ中気を含まない=閏月になる。
    function hasMajorTerm(k) {
        const a = majorTermIndex(newMoonJD(k));
        const b = majorTermIndex(newMoonJD(k + 1));
        return a !== b;
    }

    // --- 公開API ---------------------------------------------------------
    // 'YYYY-MM-DD' または (y, m, d) を受け取り六曜名を返す
    function of(a, b, c) {
        let y, m, d;
        if (typeof a === 'string') {
            const p = a.split('-');
            y = Number(p[0]); m = Number(p[1]); d = Number(p[2]);
        } else { y = a; m = b; d = c; }
        if (!y || !m || !d) return '';
        const kr = kyureki(y, m, d);
        return NAMES[(kr.month + kr.day) % 6];
    }

    return { of, kyureki, NAMES, _internal: { newMoonJD, solarLongitude, winterSolsticeJD, jdToGregorian, jdToJstDayNumber } };
}));
