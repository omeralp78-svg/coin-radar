/**
 * Coin Radar - Otomatik Tarama Scripti
 *
 * Bu script GitHub Actions uzerinde 15 dakikada bir calisir. index.html'deki
 * taraycida calisan sistemle AYNI Firestore veritabanini kullanir ve AYNI
 * sinyal tespit algoritmasini calistirir (detectSignalsForSymbol) - boylece
 * hangisi calistirirsa calistirsin ayni sonuc uretilir, celiski olmaz.
 *
 * ONEMLI: Bu dosyadaki detectSignalsForSymbol / computeATRPercent gibi
 * fonksiyonlar index.html icindekiyle BIREBIR AYNI olmali. Birinde bir
 * esik/mantik degisikligi yaparsan digerinde de yapmalisin, yoksa iki
 * sistem farkli sinyaller uretmeye baslar.
 */

const admin = require("firebase-admin");

// ---------- Ayarlar ----------
const API_BASE = "https://fapi.binance.com";
const TOP_N = 30;
const WATCHLIST_RETENTION_DAYS = 14;
const HOURLY_FETCH_LIMIT = 500;

const DEFAULT_CFG = {
    USE_DYNAMIC: true,
    PUMP_ATR_MULT: 3, PULLBACK_ATR_MULT: 1, REENTRY_ATR_MULT: 1.5,
    PUMP_THRESHOLD: 20, PULLBACK_MIN: 5, REENTRY_THRESHOLD: 10,
    PUMP_WINDOW_HOURS: 6, PULLBACK_WINDOW_HOURS: 96, REENTRY_WINDOW_HOURS: 168,
    NEAR_TERM_HOURS: 48, ISOLATION_MULT: 50
};

const KEYS = {
    snapshots: "pumpwatch_snapshots",
    klines: "pumpwatch_klines_hourly",
    btcKlines: "pumpwatch_btc_hourly",
    watchlist: "pumpwatch_watchlist",
    signals: "pumpwatch_signals_v2",
    config: "pumpwatch_config",
    notified: "pumpwatch_notified"
};

// ---------- Firebase Admin baglantisi ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function storeGet(key, fallback) {
    const doc = await db.collection("pumpwatch").doc(key).get();
    return doc.exists ? doc.data().value : fallback;
}
async function storeSet(key, value) {
    await db.collection("pumpwatch").doc(key).set({ value });
}

// ---------- Yardimci fonksiyonlar (index.html ile ayni) ----------

function todayStr() { return new Date().toISOString().slice(0, 10); }

function parseHourKey(key) { return new Date(key.replace("_", "T") + ":00:00Z").getTime(); }

async function fetch24hrTickers() {
    const res = await fetch(API_BASE + "/fapi/v1/ticker/24hr");
    if (!res.ok) throw new Error("Binance 24hr ticker hatasi: " + res.status);
    const data = await res.json();
    return data
        .filter(t => t.symbol.endsWith("USDT") && !t.symbol.includes("_"))
        .map(t => ({
            symbol: t.symbol,
            changePercent: parseFloat(t.priceChangePercent),
            price: parseFloat(t.lastPrice),
            volume: parseFloat(t.quoteVolume)
        }));
}

async function fetchHourlyKlines(symbol, limit) {
    const url = `${API_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Saatlik veri alinamadi: " + symbol);
    const arr = await res.json();
    return arr.map(k => {
        const d = new Date(k[0]);
        const dateKey = d.toISOString().slice(0, 13).replace("T", "_");
        return { date: dateKey, open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
    });
}

async function safeFetchJson(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { return null; }
}

function resampleToDaily(hourlyRows) {
    const byDate = {};
    for (const r of hourlyRows) {
        const day = r.date.slice(0, 10);
        if (!byDate[day]) byDate[day] = { date: day, high: r.high, low: r.low, close: r.close };
        else {
            byDate[day].high = Math.max(byDate[day].high, r.high);
            byDate[day].low = Math.min(byDate[day].low, r.low);
            byDate[day].close = r.close;
        }
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

function computeATRPercent(hourlyRows, period = 14) {
    const daily = resampleToDaily(hourlyRows);
    if (daily.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < daily.length; i++) {
        const tr = Math.max(
            daily[i].high - daily[i].low,
            Math.abs(daily[i].high - daily[i - 1].close),
            Math.abs(daily[i].low - daily[i - 1].close)
        );
        trs.push(tr);
    }
    const recentTrs = trs.slice(-period);
    const atr = recentTrs.reduce((a, b) => a + b, 0) / recentTrs.length;
    const lastClose = daily[daily.length - 1].close;
    return lastClose ? (atr / lastClose) * 100 : null;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function computeThresholds(atrPct, cfg) {
    if (cfg.USE_DYNAMIC && atrPct != null) {
        return {
            pump: clamp(atrPct * cfg.PUMP_ATR_MULT, 6, 100),
            pullback: clamp(atrPct * cfg.PULLBACK_ATR_MULT, 2, 50),
            reentry: clamp(atrPct * cfg.REENTRY_ATR_MULT, 3, 60),
            source: "ATR", atrPct
        };
    }
    return { pump: cfg.PUMP_THRESHOLD, pullback: cfg.PULLBACK_MIN, reentry: cfg.REENTRY_THRESHOLD, source: "SABIT", atrPct };
}

function computeBtcChangeBetween(btcMap, startKey, endKey) {
    const startRow = btcMap.get(startKey);
    const endRow = btcMap.get(endKey);
    if (!startRow || !endRow || startRow.close === 0) return null;
    return ((endRow.close - startRow.close) / startRow.close) * 100;
}

// index.html'deki ile BIREBIR AYNI algoritma
function detectSignalsForSymbol(symbol, rows, btcMap, cfg, previousSignals) {
    const n = rows.length;
    const signals = {};
    if (n < cfg.PUMP_WINDOW_HOURS + 20) return signals;

    const atrPct = computeATRPercent(rows, 14);
    const thresholds = computeThresholds(atrPct, cfg);
    const windowH = cfg.PUMP_WINDOW_HOURS;

    let i = windowH;
    while (i < n) {
        const base = rows[i - windowH].close;
        const changePct = base === 0 ? 0 : ((rows[i].high - base) / base) * 100;
        if (changePct < thresholds.pump) { i++; continue; }

        let pumpEndIdx = i;
        let pumpHigh = rows[i].high;
        let j = i + 1;
        while (j < n && j <= i + windowH && rows[j].high >= pumpHigh * 0.995) {
            if (rows[j].high > pumpHigh) { pumpHigh = rows[j].high; pumpEndIdx = j; }
            j++;
        }
        const pumpStartIdx = Math.max(0, pumpEndIdx - windowH);
        const pumpStartPrice = rows[pumpStartIdx].close;
        const pumpChangePct = pumpStartPrice === 0 ? 0 : ((pumpHigh - pumpStartPrice) / pumpStartPrice) * 100;

        const btcChangePct = computeBtcChangeBetween(btcMap, rows[pumpStartIdx].date, rows[pumpEndIdx].date);
        let isIsolated = null;
        if (btcChangePct != null) {
            const excessMove = pumpChangePct - btcChangePct;
            isIsolated = excessMove >= pumpChangePct * (cfg.ISOLATION_MULT / 100);
        }

        let pullbackIdx = null, pullbackPct = 0;
        const pullbackWindowEnd = Math.min(n - 1, pumpEndIdx + cfg.PULLBACK_WINDOW_HOURS);
        for (let k = pumpEndIdx + 1; k <= pullbackWindowEnd; k++) {
            const dd = ((pumpHigh - rows[k].close) / pumpHigh) * 100;
            if (dd >= thresholds.pullback) { pullbackIdx = k; pullbackPct = dd; break; }
        }
        if (pullbackIdx === null) { i = pumpEndIdx + 1; continue; }

        let reentryIdx = null, reentryPct = null;
        const reentryWindowEnd = Math.min(n - 1, pumpEndIdx + cfg.REENTRY_WINDOW_HOURS);
        for (let k = pullbackIdx + 1; k <= reentryWindowEnd; k++) {
            const winStart = Math.max(pullbackIdx, k - windowH);
            const base2 = rows[winStart].close;
            const chg = base2 === 0 ? 0 : ((rows[k].high - base2) / base2) * 100;
            if (chg >= thresholds.reentry) { reentryIdx = k; reentryPct = chg; break; }
        }

        let status;
        if (reentryIdx !== null) status = "CONFIRMED";
        else {
            const hoursAvailableAfterPump = (n - 1) - pumpEndIdx;
            status = hoursAvailableAfterPump > cfg.REENTRY_WINDOW_HOURS ? "EXPIRED" : "WATCHING";
        }

        const key = symbol + "_" + rows[pumpEndIdx].date;
        const prev = previousSignals[key];

        signals[key] = {
            symbol, pumpTimestamp: rows[pumpEndIdx].date, pumpChangePct, pumpHigh,
            pullbackTimestamp: rows[pullbackIdx].date, pullbackPrice: rows[pullbackIdx].close, pullbackPct,
            reentryTimestamp: reentryIdx != null ? rows[reentryIdx].date : null, reentryPct,
            status, atrPct,
            thresholdsUsed: { pump: thresholds.pump, pullback: thresholds.pullback, reentry: thresholds.reentry, source: thresholds.source },
            btcConcurrentChangePct: btcChangePct, isIsolatedPump: isIsolated,
            squeezeChecked: prev ? prev.squeezeChecked : false,
            squeezeAllPass: prev ? prev.squeezeAllPass : null,
            squeezeCheckedAt: prev ? prev.squeezeCheckedAt : null
        };

        i = (reentryIdx != null ? reentryIdx : pullbackIdx) + 1;
    }
    return signals;
}

// Klasik short-squeeze kontrolu (index.html'deki computeClassicSqueeze ile ayni)
function computeClassicSqueeze(dailyKlines35, oiHist48, fundingRate) {
    if (!dailyKlines35 || dailyKlines35.length < 21) return { available: false };
    const closes = dailyKlines35.map(k => parseFloat(k[4]));
    const n = closes.length;
    function bbWidthAt(idx) {
        if (idx < 19) return null;
        const w = closes.slice(idx - 19, idx + 1);
        const mean = w.reduce((a, b) => a + b, 0) / w.length;
        const variance = w.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / w.length;
        const std = Math.sqrt(variance);
        return ((mean + 2 * std) - (mean - 2 * std)) / mean * 100;
    }
    const widths = [];
    for (let i = 19; i < n; i++) { const w = bbWidthAt(i); if (w != null) widths.push(w); }
    if (widths.length < 6) return { available: false };
    const currentWidth = widths[widths.length - 1];
    const historicalAvg = widths.slice(0, -1).reduce((a, b) => a + b, 0) / (widths.length - 1);
    const bbSqueeze = currentWidth < historicalAvg * 0.6;
    const priceNow = closes[n - 1];
    const price48hAgo = closes[n - 3] != null ? closes[n - 3] : closes[0];
    const price48hChangePct = ((priceNow - price48hAgo) / price48hAgo) * 100;
    const priceFlat = Math.abs(price48hChangePct) <= 4;
    let oi48Change = null;
    if (oiHist48 && oiHist48.length >= 2) {
        const oldest = parseFloat(oiHist48[0].sumOpenInterest);
        const newest = parseFloat(oiHist48[oiHist48.length - 1].sumOpenInterest);
        oi48Change = oldest === 0 ? null : ((newest - oldest) / oldest) * 100;
    }
    const oiRising = oi48Change != null && oi48Change > 5;
    const fundingNeg = fundingRate != null && fundingRate < -0.005;
    return { available: true, allPass: bbSqueeze && oiRising && priceFlat && fundingNeg, bbSqueeze, oiRising, priceFlat, fundingNeg };
}

async function checkSqueeze(symbol) {
    const [dailyKlines35, oiHist48, fundingHist] = await Promise.all([
        safeFetchJson(`${API_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=35`),
        safeFetchJson(`${API_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=49`),
        safeFetchJson(`${API_BASE}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`)
    ]);
    const fundingRate = fundingHist && fundingHist.length ? parseFloat(fundingHist[0].fundingRate) * 100 : null;
    return computeClassicSqueeze(dailyKlines35, oiHist48, fundingRate);
}

// ---------- Telegram ----------
async function sendTelegramMessage(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) { console.log("Telegram bilgileri eksik, mesaj atlanıyor."); return; }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    if (!res.ok) console.error("Telegram gonderim hatasi:", await res.text());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Ana akis ----------
async function main() {
    console.log("Tarama basliyor:", new Date().toISOString());

    const cfg = { ...DEFAULT_CFG, ...(await storeGet(KEYS.config, {})) };
    const today = todayStr();

    // 1) Top30 + watchlist
    const tickers = await fetch24hrTickers();
    tickers.sort((a, b) => b.changePercent - a.changePercent);
    const top30 = tickers.slice(0, TOP_N);

    const snapshots = await storeGet(KEYS.snapshots, {});
    snapshots[today] = top30;
    await storeSet(KEYS.snapshots, snapshots);

    const watchlist = await storeGet(KEYS.watchlist, {});
    for (const t of top30) {
        if (!watchlist[t.symbol]) watchlist[t.symbol] = { firstSeen: today, lastSeen: today };
        else watchlist[t.symbol].lastSeen = today;
    }
    for (const sym of Object.keys(watchlist)) {
        const daysSince = (new Date(today) - new Date(watchlist[sym].lastSeen)) / 86400000;
        if (daysSince > WATCHLIST_RETENTION_DAYS) delete watchlist[sym];
    }
    await storeSet(KEYS.watchlist, watchlist);

    // 2) BTC referans serisi
    let btcKlinesStore = await storeGet(KEYS.btcKlines, {});
    try {
        const btcKlines = await fetchHourlyKlines("BTCUSDT", HOURLY_FETCH_LIMIT);
        for (const k of btcKlines) btcKlinesStore[k.date] = { open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume };
        await storeSet(KEYS.btcKlines, btcKlinesStore);
    } catch (e) { console.warn("BTC verisi alinamadi:", e.message); }
    const btcMap = new Map(Object.entries(btcKlinesStore));

    // 3) Watchlist'teki her sembol icin saatlik veri
    const symbols = Object.keys(watchlist);
    const klinesStore = await storeGet(KEYS.klines, {});
    for (const symbol of symbols) {
        try {
            const klines = await fetchHourlyKlines(symbol, HOURLY_FETCH_LIMIT);
            if (!klinesStore[symbol]) klinesStore[symbol] = {};
            for (const k of klines) klinesStore[symbol][k.date] = { open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume };
        } catch (e) { console.warn(symbol, "hata:", e.message); }
        await sleep(120);
    }
    await storeSet(KEYS.klines, klinesStore);

    // 4) Sinyalleri hesapla
    const previousSignals = await storeGet(KEYS.signals, {});
    const signals = {};
    for (const symbol of Object.keys(klinesStore)) {
        const dateMap = klinesStore[symbol];
        const dates = Object.keys(dateMap).sort();
        const rows = dates.map(d => ({ date: d, ...dateMap[d] })).filter(r => r.low != null);
        Object.assign(signals, detectSignalsForSymbol(symbol, rows, btcMap, cfg, previousSignals));
    }

    // 5) Yakin zamanda listesi (index.html'deki renderSignals filtresiyle ayni mantik)
    const latestDate = Object.keys(snapshots).sort().pop();
    const todaysSymbols = new Set((snapshots[latestDate] || []).map(r => r.symbol));
    const nowMs = Date.now();

    const watchingList = [];
    for (const sig of Object.values(signals)) {
        if (sig.status !== "WATCHING") continue;
        if (todaysSymbols.has(sig.symbol)) continue;
        const hoursSincePullback = Math.round((nowMs - parseHourKey(sig.pullbackTimestamp)) / 3600000);
        if (hoursSincePullback > cfg.NEAR_TERM_HOURS) continue;
        sig._hoursSincePullback = hoursSincePullback;
        watchingList.push(sig);
    }

    // 6) Bu adaylar icin sikisma kontrolu yap
    for (const sig of watchingList) {
        try {
            const sq = await checkSqueeze(sig.symbol);
            const key = sig.symbol + "_" + sig.pumpTimestamp;
            if (sq.available) {
                signals[key].squeezeChecked = true;
                signals[key].squeezeAllPass = sq.allPass;
                signals[key].squeezeCheckedAt = today;
                sig.squeezeAllPass = sq.allPass;
            }
        } catch (e) { console.warn("squeeze check hata:", sig.symbol, e.message); }
        await sleep(150);
    }

    await storeSet(KEYS.signals, signals);

    // 7) Bildirim gerekenleri belirle (daha once bildirilmemis olanlar)
    const notified = await storeGet(KEYS.notified, {});
    const newItems = [];
    const newSqueezeItems = [];

    for (const sig of watchingList) {
        const key = sig.symbol + "_" + sig.pumpTimestamp;
        const prevNotif = notified[key];
        if (!prevNotif) {
            newItems.push(sig);
            notified[key] = { notifiedAt: new Date().toISOString(), squeezeNotified: !!sig.squeezeAllPass };
        } else if (sig.squeezeAllPass && !prevNotif.squeezeNotified) {
            newSqueezeItems.push(sig);
            prevNotif.squeezeNotified = true;
        }
    }
    // Eski bildirim kayitlarini cok fazla birikmesin diye 30 gunden eskilerini temizle
    for (const k of Object.keys(notified)) {
        const age = (Date.now() - new Date(notified[k].notifiedAt).getTime()) / 86400000;
        if (age > 30) delete notified[k];
    }
    await storeSet(KEYS.notified, notified);

    // 8) Telegram mesaji gonder
    if (newItems.length || newSqueezeItems.length) {
        let msg = "🪙 <b>Coin Radar - Yeni Sinyal</b>\n\n";
        if (newItems.length) {
            msg += "🔮 <b>Yeni aday(lar) - yakında tekrar patlayabilir:</b>\n";
            for (const s of newItems) {
                const tag = s.isIsolatedPump === true ? "🔒" : s.isIsolatedPump === false ? "🌐" : "";
                const sq = s.squeezeAllPass ? " 🎯" : "";
                msg += `• <b>${s.symbol}</b> ${tag}${sq} — Patlama +${s.pumpChangePct.toFixed(1)}%, Düşüş -${s.pullbackPct.toFixed(1)}%, ${s._hoursSincePullback}s önce\n`;
            }
            msg += "\n";
        }
        if (newSqueezeItems.length) {
            msg += "🎯 <b>Mevcut aday(lar) klasik sıkışma sinyali verdi:</b>\n";
            for (const s of newSqueezeItems) {
                msg += `• <b>${s.symbol}</b> — Bollinger sıkışması + OI + negatif funding üçü birden sağlanıyor\n`;
            }
        }
        msg += "\n⚠️ Yatırım tavsiyesi değildir. Detaylar için siteyi aç.";
        await sendTelegramMessage(msg);
        console.log("Telegram mesaji gonderildi:", newItems.length, "yeni aday,", newSqueezeItems.length, "yeni sikisma");
    } else {
        console.log("Bildirilecek yeni bir sey yok.");
    }

    console.log("Tarama tamamlandi:", new Date().toISOString());
}

main().catch(err => {
    console.error("HATA:", err);
    process.exit(1);
});
