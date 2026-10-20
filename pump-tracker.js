#!/usr/bin/env node
/**
 * pump-tracker.js — تتبع عملات pump.fun الجديدة التي تُشترى بكثرة
 *
 * ماذا يفعل:
 *  1) يتصل ببث PumpPortal المجاني ويراقب العملات الجديدة وصفقاتها.
 *  2) يطلق "إشارة" عندما تجتمع: شراء كثيف + مشترون كثر + ضغط شراء حديث + فلاتر أمان.
 *  3) يجرّب كل إشارة ورقياً (paper trading): يسجل سعر الدخول ثم القيمة بعد 3 و10 و30 دقيقة،
 *     ويطبع نسبة النجاح ومتوسط الربح الصافي، لتعرف هل الإشارات تربح فعلاً أم لا.
 *
 * التشغيل (Node 22 أو أحدث، بدون تثبيت أي حزمة):
 *    node pump-tracker.js
 * الملفات الناتجة: signals.jsonl و results.jsonl في نفس المجلد.
 *
 * لإظهار الإشارات في الموقع (اختياري) اضبط قبل التشغيل:
 *    REPORT_URL=https://fbgcusnjbdppqqjohcoq.supabase.co/functions/v1/report REPORT_KEY=<المفتاح السري> node pump-tracker.js
 *
 * تنبيه: هذه أداة تتبع وتجربة، وليست نصيحة استثمارية ولا ضماناً لربح.
 * أغلب العملات الجديدة تخسر قيمتها، والتجربة الورقية لا تحسب الانزلاق ولا سرعة البوتات.
 */
const fs = require('fs');

const CFG = {
  url: 'wss://pumpportal.fun/api/data',
  minAgeSec: 60,        // لا إشارة قبل مرور دقيقة (تجنب فوضى البداية)
  maxAgeSec: 900,       // ولا بعد 15 دقيقة (تجنب المتأخر)
  minBuys: 15,          // أقل عدد عمليات شراء
  minBuyers: 10,        // أقل عدد مشترين مختلفين
  minBuyShare: 0.65,    // حصة الشراء من حجم SOL الكلي
  minRecentShare: 0.6,  // حصة الشراء في آخر 60 ثانية
  maxSameAmount: 0.4,   // أقصى نسبة شراء بنفس المبلغ (علامة بوتات)
  maxCreatorPct: 10,    // أقصى حصة للمطوّر %
  maxTop10Pct: 45,      // أقصى تركّز لأكبر 10 محافظ مشاهَدة %
  minMcSol: 30,         // نطاق القيمة السوقية بالـ SOL
  maxMcSol: 150,
  maxCoinsPerCreator: 2,
  horizonsMin: [3, 10, 30],
  feePerSide: 0.01,     // رسوم pump.fun التقريبية 1% لكل جهة
  maxTracked: 150,
  trackMinutes: 35,
  summaryEveryMin: 5,
};
const SUPPLY = 1e9;
const coins = new Map();   // mint -> coin
const byCreator = new Map();
const open = [];           // صفقات ورقية قيد المتابعة
const done = [];           // صفقات انتهت
let clock = () => Date.now();
let ws = null, tries = 0;

const log = (f, o) => { try { fs.appendFileSync(f, JSON.stringify(o) + '\n'); } catch (_) {} };
// إرسال اختياري إلى Supabase ليظهر في الموقع (اضبط REPORT_URL و REPORT_KEY)
const REPORT_URL = process.env.REPORT_URL, REPORT_KEY = process.env.REPORT_KEY;
function report(body) {
  if (!REPORT_URL || !REPORT_KEY) return;
  fetch(REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tracker-key': REPORT_KEY }, body: JSON.stringify(body) }).catch(() => {});
}
const pct = (x) => (x * 100).toFixed(0) + '%';

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function stats(c) {
  const bal = c.bal;
  const arr = Object.entries(bal).filter(([k, v]) => k !== c.pool && v > 0).map(([, v]) => v).sort((a, b) => b - a);
  const top10 = arr.slice(0, 10).reduce((s, v) => s + v, 0) / SUPPLY * 100;
  const creator = (bal[c.creator] || 0) / SUPPLY * 100;
  const tot = c.buyV + c.sellV;
  const counts = {};
  let mx = 0;
  for (const a of c.amts) { counts[a] = (counts[a] || 0) + 1; if (counts[a] > mx) mx = counts[a]; }
  return {
    top10, creator,
    buyShare: tot ? c.buyV / tot : 0,
    same: c.amts.length >= 6 ? mx / c.amts.length : 0,
    creatorSold: c.initBuy > 0 && (bal[c.creator] || 0) < c.initBuy * 0.5,
    buyers: c.buyers.size,
  };
}

function recentShare(c, now) {
  c.recent = c.recent.filter((r) => now - r.t < 60000);
  let b = 0, s = 0;
  for (const r of c.recent) r.buy ? (b += r.sol) : (s += r.sol);
  return b + s ? b / (b + s) : 0;
}

function check(c, now) {
  if (c.signaled) return;
  const age = (now - c.t) / 1000;
  if (age < CFG.minAgeSec || age > CFG.maxAgeSec) return;
  if (c.buys < CFG.minBuys || c.buyers.size < CFG.minBuyers) return;
  if (c.mc < CFG.minMcSol || c.mc > CFG.maxMcSol) return;
  if ((byCreator.get(c.creator) || []).length > CFG.maxCoinsPerCreator) return;
  const s = stats(c);
  const rs = recentShare(c, now);
  if (s.buyShare < CFG.minBuyShare || rs < CFG.minRecentShare) return;
  if (s.same > CFG.maxSameAmount || s.creatorSold) return;
  if (s.creator > CFG.maxCreatorPct || s.top10 > CFG.maxTop10Pct) return;

  c.signaled = true;
  const sig = {
    time: new Date(now).toISOString(), mint: c.mint, name: c.name, symbol: c.symbol,
    ageSec: Math.round(age), mcSol: +c.mc.toFixed(1), buys: c.buys, buyers: s.buyers,
    buyShare: +s.buyShare.toFixed(2), recentShare: +rs.toFixed(2),
    creatorPct: +s.creator.toFixed(1), top10Pct: +s.top10.toFixed(1),
  };
  log('signals.jsonl', sig);
  report({ signal: sig });
  console.log(`\n[إشارة] ${c.name} (${c.symbol}) | عمر ${Math.round(age / 60 * 10) / 10}د | MC ${sig.mcSol} SOL | شراء ${c.buys} من ${s.buyers} محفظة | حصة الشراء ${pct(s.buyShare)} (آخر دقيقة ${pct(rs)}) | مطوّر ${sig.creatorPct}% | أكبر10 ${sig.top10Pct}%\n  https://pump.fun/coin/${c.mint}`);
  open.push({ sig, entryMc: c.mc, entryT: now, c, got: {} });
}

function settle(now) {
  for (let i = open.length - 1; i >= 0; i--) {
    const p = open[i];
    for (const h of CFG.horizonsMin) {
      if (p.got[h] === undefined && now - p.entryT >= h * 60000) {
        const ratio = p.c.mc / p.entryMc;
        const net = ratio * (1 - CFG.feePerSide) / (1 + CFG.feePerSide) - 1;
        p.got[h] = +net.toFixed(4);
      }
    }
    if (Object.keys(p.got).length === CFG.horizonsMin.length) {
      const res = { ...p.sig, entryMc: +p.entryMc.toFixed(1), net: p.got };
      log('results.jsonl', res);
      report({ result: { mint: res.mint, net: res.net } });
      done.push(res);
      console.log(`[نتيجة] ${p.sig.symbol}: ` + CFG.horizonsMin.map((h) => `${h}د ${(p.got[h] * 100).toFixed(0)}%`).join(' | '));
      open.splice(i, 1);
    }
  }
}

function summary() {
  if (!done.length) { console.log(`\n[ملخص] إشارات منتهية: 0 | قيد المتابعة: ${open.length} | عملات مراقَبة: ${coins.size}`); return; }
  console.log(`\n[ملخص] إشارات منتهية: ${done.length} | قيد المتابعة: ${open.length}`);
  for (const h of CFG.horizonsMin) {
    const v = done.map((d) => d.net[h]).sort((a, b) => a - b);
    const win = v.filter((x) => x > 0).length / v.length;
    const avg = v.reduce((s, x) => s + x, 0) / v.length;
    const med = v[Math.floor(v.length / 2)];
    console.log(`  بعد ${h}د: نسبة الربح ${pct(win)} | المتوسط ${(avg * 100).toFixed(1)}% | الوسيط ${(med * 100).toFixed(1)}%`);
  }
  console.log('  (قبل الانزلاق؛ الواقع أسوأ. لا تثق بأقل من 50 إشارة.)');
}

function cleanup(now) {
  for (const [m, c] of coins) {
    if (now - c.t > CFG.trackMinutes * 60000 && !open.some((p) => p.c === c)) {
      send({ method: 'unsubscribeTokenTrade', keys: [m] });
      coins.delete(m);
    }
  }
}

function handle(d) {
  if (!d || !d.mint) return;
  const now = clock();
  if (d.txType === 'create') {
    if (coins.has(d.mint) || coins.size >= CFG.maxTracked) return;
    const c = {
      mint: d.mint, name: d.name || '?', symbol: d.symbol || '?', creator: d.traderPublicKey, pool: d.bondingCurveKey,
      t: now, bal: {}, initBuy: Number(d.initialBuy) || 0, buyV: 0, sellV: 0, buys: 0, sells: 0,
      buyers: new Set(), amts: [], recent: [], mc: Number(d.marketCapSol) || 0, signaled: false,
    };
    c.bal[c.creator] = c.initBuy;
    coins.set(d.mint, c);
    const l = byCreator.get(c.creator) || [];
    l.push(d.mint);
    byCreator.set(c.creator, l);
    send({ method: 'subscribeTokenTrade', keys: [d.mint] });
  } else if (d.txType === 'buy' || d.txType === 'sell') {
    const c = coins.get(d.mint);
    if (!c) return;
    const w = d.traderPublicKey, sol = Number(d.solAmount) || 0;
    if (w && d.newTokenBalance != null) c.bal[w] = Number(d.newTokenBalance);
    if (d.marketCapSol != null) c.mc = Number(d.marketCapSol) || c.mc;
    const buy = d.txType === 'buy';
    if (buy) {
      c.buys++; c.buyV += sol; if (w) c.buyers.add(w);
      if (c.amts.length < 300) c.amts.push(sol.toFixed(2));
    } else { c.sells++; c.sellV += sol; }
    c.recent.push({ t: now, sol, buy });
    check(c, now);
  }
}

function start() {
  const WS = globalThis.WebSocket || require('ws');
  ws = new WS(CFG.url);
  ws.onopen = () => {
    tries = 0;
    console.log('متصل بـ PumpPortal. بانتظار العملات الجديدة... (Ctrl+C للإيقاف)');
    send({ method: 'subscribeNewToken' });
    for (const m of coins.keys()) send({ method: 'subscribeTokenTrade', keys: [m] });
  };
  ws.onmessage = (ev) => { try { handle(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())); } catch (_) {} };
  ws.onclose = () => { tries++; console.log('انقطع الاتصال، إعادة المحاولة...'); setTimeout(start, Math.min(15000, 1000 * tries)); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

if (require.main === module) {
  start();
  setInterval(() => { const n = clock(); settle(n); cleanup(n); }, 5000);
  setInterval(summary, CFG.summaryEveryMin * 60000);
} else {
  module.exports = { handle, settle, summary, setClock: (f) => { clock = f; }, state: { coins, open, done } };
}
