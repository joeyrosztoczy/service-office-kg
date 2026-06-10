#!/usr/bin/env node
/*
 * feature-lab.js — systematic search for more predictive features.
 *
 * Tests candidate features (weather, farm-margin composites, yield curve,
 * consumer sentiment, machinery industrial production, dealer-channel
 * cross-series) against the production baseline, scoring:
 *
 *   MAPE1 / dir1   one-quarter-ahead walk-forward accuracy
 *   MAPE2 / dir2   two-quarters-ahead recursive accuracy (features capped
 *                  at the origin date — zero lookahead)
 *   sevCap         severity capture on big-move quarters (|YoY| >= 12%):
 *                  mean(sign-aligned predicted growth) / mean(|actual|).
 *                  1.0 = magnitude right; < 1 = underreaction.
 *   dirBig2        2-step direction accuracy on big movers only
 *                  (can we call severity 2 quarters ahead?)
 *
 * Baseline comparisons are computed on the SAME evaluation quarters as
 * each variant so row-count differences can't flatter anyone.
 *
 * Usage: node scripts/feature-lab.js [TARGET_KEY]   (default DE_REV)
 */
const fs = require("fs");
const path = require("path");
const Forecast = require(path.join(__dirname, "..", "js", "forecast.js"));
const H = Forecast.helpers;

const ext = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "external", "external-data.json"), "utf8"));
const F = ext.fred;
const TARGET_KEY = process.argv[2] || "DE_REV";
const target = ext.edgar[TARGET_KEY].obs;

function shiftDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// feature builders: fn(asOf) -> value | null
// ---------------------------------------------------------------------
const yoyOf = (key) => (asOf) => (F[key] ? H.yoy(F[key].obs, asOf) : null);
const d12Of = (key) => (asOf) => (F[key] ? H.delta12(F[key].obs, asOf) : null);
const levelOf = (key, scale) => (asOf) => {
  if (!F[key]) return null;
  const v = H.valueAsOf(F[key].obs, asOf);
  return v == null ? null : v * (scale || 1);
};
const minus = (a, b) => (asOf) => {
  const x = a(asOf), y = b(asOf);
  return x == null || y == null ? null : x - y;
};

// dealer-channel cross-series (quarterly SEC filings, 45-day filing lag)
const TINV = ext.edgar.TITN_INV.obs, TREV = ext.edgar.TITN_REV.obs;
function channelSts(asOf) {
  const eff = shiftDays(asOf, -45);
  const inv = H.valueAsOf(TINV, eff);
  const revs = TREV.filter((o) => o.date <= eff).slice(-4);
  if (inv == null || revs.length < 4) return null;
  return inv / revs.reduce((s, o) => s + o.value, 0);
}
function channelStsYoY(asOf) {
  const now = channelSts(asOf), ago = channelSts(H.addMonths(asOf, -12));
  return now == null || ago == null || ago <= 0 ? null : Math.log(now / ago);
}
function channelInvYoY(asOf) {
  const eff = shiftDays(asOf, -45);
  const now = H.valueAsOf(TINV, eff), ago = H.valueAsOf(TINV, shiftDays(H.addMonths(asOf, -12), -45));
  return now == null || ago == null || ago <= 0 ? null : Math.log(now / ago);
}

const BASE = [
  { name: "corn_yoy", fn: yoyOf("CORN") },
  { name: "soy_yoy", fn: yoyOf("SOY") },
  { name: "wheat_yoy", fn: yoyOf("WHEAT") },
  { name: "prime_d12", fn: d12Of("PRIME") },
  { name: "agppi_yoy", fn: yoyOf("PPI_AG_MACH") },
  { name: "unrate_d12", fn: d12Of("UNRATE") },
  { name: "ppi_yoy", fn: yoyOf("PPI_ALL") },
];

const CANDIDATES = {
  fert_yoy: { fn: yoyOf("FERT") },
  diesel_yoy: { fn: yoyOf("DIESEL") },
  margin_fert: { fn: minus(yoyOf("CORN"), yoyOf("FERT")), desc: "corn YoY minus fertilizer YoY (farm margin)" },
  afford: { fn: minus(yoyOf("CORN"), yoyOf("PPI_AG_MACH")), desc: "corn YoY minus machinery PPI YoY (affordability)" },
  curve_level: { fn: levelOf("CURVE"), desc: "10Y-3M spread level (recession lead)" },
  curve_d12: { fn: d12Of("CURVE") },
  umcsent_yoy: { fn: yoyOf("UMCSENT"), desc: "consumer sentiment YoY" },
  ip_ag_yoy: { fn: yoyOf("IP_AG_MACH"), desc: "machinery industrial production YoY" },
  houst_yoy: { fn: yoyOf("HOUST"), desc: "housing starts YoY" },
  drought_lvl: { fn: levelOf("DROUGHT", 0.01), desc: "CONUS D2+ drought area (frac)" },
  drought_d12: { fn: (asOf) => { const v = d12Of("DROUGHT")(asOf); return v == null ? null : v * 0.01; } },
  channel_sts: { fn: channelStsYoY, desc: "Titan dealer stock-to-sales YoY (45d lag)" },
  channel_inv: { fn: channelInvYoY, desc: "Titan dealer inventory YoY (45d lag)" },
};

// ---------------------------------------------------------------------
// lab row builder / model (mirrors production, arbitrary feature lists)
// ---------------------------------------------------------------------
function spanOk(t, a, b) {
  const d = (new Date(t[b].date) - new Date(t[a].date)) / 86400000;
  return d >= 330 && d <= 400;
}

function buildRows(t, feats, capDate) {
  const rows = [];
  for (let i = 5; i < t.length; i++) {
    if (!(t[i].value > 0 && t[i - 1].value > 0 && t[i - 4].value > 0 && t[i - 5].value > 0)) continue;
    if (!spanOk(t, i - 4, i) || !spanOk(t, i - 5, i - 1)) continue;
    let asOf = t[i - 1].date;
    if (capDate && asOf > capDate) asOf = capDate; // zero-lookahead cap for recursion
    const x = [1, Math.log(t[i - 1].value / t[i - 5].value)];
    let ok = true;
    for (const f of feats) {
      const v = f.fn(asOf);
      if (v == null || !Number.isFinite(v)) { ok = false; break; }
      x.push(v);
    }
    if (!ok) continue;
    rows.push({ i, date: t[i].date, x, y: Math.log(t[i].value / t[i - 4].value) });
  }
  return rows;
}

const LAMBDAS = [0.1, 0.5, 2, 8, 32];
function chooseLam(rows) {
  const evalN = Math.min(8, rows.length - 8);
  if (evalN < 3) return 8;
  let best = 8, bestErr = Infinity;
  for (const lam of LAMBDAS) {
    let err = 0;
    for (let j = rows.length - evalN; j < rows.length; j++) {
      const m = Forecast.fitRidge(rows.slice(0, j), lam);
      err += Math.abs(Forecast.predictRow(m, rows[j].x) - rows[j].y);
    }
    if (err < bestErr) { bestErr = err; best = lam; }
  }
  return best;
}

// ensemble growth prediction for one row given training rows
function predictGrowth(train, row) {
  const m = Forecast.fitRidge(train, chooseLam(train));
  const yModel = Forecast.predictRow(m, row.x);
  // level-space ensemble with momentum, then back to growth space
  return Math.log(0.5 * (Math.exp(yModel) + Math.exp(row.x[1])));
}

// one-step walk-forward over given rows
function walk1(rows, minTrain) {
  const out = [];
  for (let j = minTrain; j < rows.length; j++) {
    out.push({ i: rows[j].i, date: rows[j].date, yActual: rows[j].y, yPred: predictGrowth(rows.slice(0, j), rows[j]) });
  }
  return out;
}

// two-step recursive: stand at quarter i-2, predict quarter i
function walk2(feats, evalIs) {
  const out = [];
  for (const i of evalIs) {
    const originDate = target[i - 2].date;
    const known = target.slice(0, i - 1); // through index i-2
    const rowsK = buildRows(known, feats, originDate);
    if (rowsK.length < 14) continue;
    // step 1: predict quarter i-1
    const ext1 = known.map((o) => ({ date: o.date, value: o.value }));
    const sim1 = { i: ext1.length, date: target[i - 1].date };
    const x1 = [1, Math.log(ext1[ext1.length - 1].value / ext1[ext1.length - 4 - 1 + 0].value)];
    // build x for step1 properly: momentum = log(T[i-2]/T[i-6])
    x1[1] = Math.log(known[known.length - 1].value / known[known.length - 5].value);
    let ok = true;
    for (const f of feats) { const v = f.fn(originDate); if (v == null) { ok = false; break; } x1.push(v); }
    if (!ok) continue;
    const g1 = predictGrowth(rowsK, { x: x1, y: 0 });
    const p1 = known[known.length - 4].value * Math.exp(g1);
    // step 2: predict quarter i using predicted i-1
    const x2 = [1, Math.log(p1 / known[known.length - 4].value)];
    for (const f of feats) { const v = f.fn(originDate); if (v == null) { ok = false; break; } x2.push(v); }
    if (!ok) continue;
    const g2 = predictGrowth(rowsK, { x: x2, y: 0 });
    out.push({ i, date: target[i].date, yActual: Math.log(target[i].value / target[i - 4].value), yPred: g2 });
  }
  return out;
}

// ---------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------
const BIG = 0.12;
function scoreGrowth(pts) {
  if (!pts.length) return null;
  let ape = 0, dir = 0;
  for (const p of pts) {
    ape += Math.abs(Math.exp(p.yPred - p.yActual) - 1); // level error implied by growth error
    if (Math.sign(p.yPred) === Math.sign(p.yActual)) dir++;
  }
  const big = pts.filter((p) => Math.abs(p.yActual) >= BIG);
  let sevCap = null, dirBig = null;
  if (big.length >= 4) {
    const num = big.reduce((s, p) => s + p.yPred * Math.sign(p.yActual), 0);
    const den = big.reduce((s, p) => s + Math.abs(p.yActual), 0);
    sevCap = num / den;
    dirBig = big.filter((p) => Math.sign(p.yPred) === Math.sign(p.yActual)).length / big.length;
  }
  return { n: pts.length, mape: ape / pts.length, dir: dir / pts.length, sevCap, dirBig, nBig: big.length };
}

function evalVariant(feats) {
  const rows = buildRows(target, feats);
  const w1 = walk1(rows, 12);
  const evalIs = w1.map((p) => p.i);
  const w2 = walk2(feats, evalIs);
  return { dates1: w1.map((p) => p.date), s1: scoreGrowth(w1), s2: scoreGrowth(w2), w1, w2 };
}

function restrict(w, dates) {
  const set = new Set(dates);
  return w.filter((p) => set.has(p.date));
}

// ---------------------------------------------------------------------
// run
// ---------------------------------------------------------------------
console.log("FEATURE LAB — target: " + TARGET_KEY + " (" + ext.edgar[TARGET_KEY].company + ")");
console.log("big-move threshold |YoY| >= " + BIG * 100 + "%; sevCap 1.0 = magnitude right, <1 = underreaction\n");

// lead-lag profile of every candidate vs target growth
console.log("Lead-lag correlation of candidate (at t-k quarters) vs actual YoY growth (at t):");
const rowsBase = buildRows(target, BASE);
const growths = rowsBase.map((r) => ({ date: r.date, i: r.i, y: r.y }));
function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy || 1);
}
for (const [name, c] of Object.entries(CANDIDATES)) {
  const line = [];
  for (let k = 1; k <= 4; k++) {
    const xs = [], ys = [];
    for (const g of growths) {
      if (g.i - k < 0) continue;
      const v = c.fn(target[g.i - k].date);
      if (v == null || !Number.isFinite(v)) continue;
      xs.push(v); ys.push(g.y);
    }
    line.push("k=" + k + ": " + (xs.length > 10 ? corr(xs, ys).toFixed(2) : "  — "));
  }
  console.log("  " + name.padEnd(13) + line.join("   "));
}

// baseline
const base = evalVariant(BASE);
console.log("\nBASELINE (production features)");
console.log("  1-step: MAPE " + (base.s1.mape * 100).toFixed(1) + "%  dir " + (base.s1.dir * 100).toFixed(0) +
  "%  sevCap " + (base.s1.sevCap === null ? "—" : base.s1.sevCap.toFixed(2)) + "  (n=" + base.s1.n + ", big=" + base.s1.nBig + ")");
console.log("  2-step: MAPE " + (base.s2.mape * 100).toFixed(1) + "%  dir " + (base.s2.dir * 100).toFixed(0) +
  "%  sevCap " + (base.s2.sevCap === null ? "—" : base.s2.sevCap.toFixed(2)) + "  dirBig2 " +
  (base.s2.dirBig === null ? "—" : (base.s2.dirBig * 100).toFixed(0) + "%") + "  (n=" + base.s2.n + ")");

// single-candidate sweep
console.log("\nSWEEP: baseline + one candidate (baseline re-scored on the variant's quarters)\n");
console.log("candidate      n   MAPE1  ΔMAPE1   dir1   MAPE2  ΔMAPE2  sevCap2 (base)  dirBig2 (base)");
console.log("-".repeat(95));
const results = [];
for (const [name, c] of Object.entries(CANDIDATES)) {
  const v = evalVariant(BASE.concat([{ name, fn: c.fn }]));
  if (!v.s1 || !v.s2 || v.s1.n < 20) { console.log(name.padEnd(13) + "  insufficient rows"); continue; }
  const b1 = scoreGrowth(restrict(base.w1, v.w1.map((p) => p.date)));
  const b2 = scoreGrowth(restrict(base.w2, v.w2.map((p) => p.date)));
  const r = { name, v, b1, b2 };
  results.push(r);
  console.log(
    name.padEnd(13) + String(v.s1.n).padStart(4) +
    ((v.s1.mape * 100).toFixed(1) + "%").padStart(8) +
    (((v.s1.mape - b1.mape) * 100).toFixed(1) + "pp").padStart(8) +
    ((v.s1.dir * 100).toFixed(0) + "%").padStart(7) +
    ((v.s2.mape * 100).toFixed(1) + "%").padStart(8) +
    (((v.s2.mape - b2.mape) * 100).toFixed(1) + "pp").padStart(8) +
    ((v.s2.sevCap === null ? "  —" : v.s2.sevCap.toFixed(2)) + " (" + (b2.sevCap === null ? "—" : b2.sevCap.toFixed(2)) + ")").padStart(14) +
    ((v.s2.dirBig === null ? " —" : (v.s2.dirBig * 100).toFixed(0) + "%") + " (" + (b2.dirBig === null ? "—" : (b2.dirBig * 100).toFixed(0) + "%") + ")").padStart(13)
  );
}

// combo round: take candidates that improved 2-step MAPE or sevCap, try pairs/triples
const good = results
  .filter((r) => r.v.s2.mape < r.b2.mape - 0.002 ||
    (r.v.s2.sevCap !== null && r.b2.sevCap !== null && r.v.s2.sevCap > r.b2.sevCap + 0.04))
  .sort((a, b) => (a.v.s2.mape - a.b2.mape) - (b.v.s2.mape - b.b2.mape))
  .slice(0, 4)
  .map((r) => r.name);
console.log("\nCOMBO ROUND with: " + (good.join(", ") || "(none qualified)"));
const combos = [];
for (let a = 0; a < good.length; a++)
  for (let b = a + 1; b < good.length; b++) combos.push([good[a], good[b]]);
if (good.length >= 3) combos.push(good.slice(0, 3));
if (good.length >= 1) combos.push([good[0]]);
console.log("\ncombo                                  n   MAPE1   dir1   MAPE2  ΔMAPE2  sevCap2 (base)  dirBig2 (base)");
console.log("-".repeat(108));
for (const combo of combos) {
  const feats = BASE.concat(combo.map((n) => ({ name: n, fn: CANDIDATES[n].fn })));
  const v = evalVariant(feats);
  if (!v.s1 || !v.s2) continue;
  const b2 = scoreGrowth(restrict(base.w2, v.w2.map((p) => p.date)));
  console.log(
    combo.join("+").padEnd(37) + String(v.s1.n).padStart(4) +
    ((v.s1.mape * 100).toFixed(1) + "%").padStart(8) +
    ((v.s1.dir * 100).toFixed(0) + "%").padStart(7) +
    ((v.s2.mape * 100).toFixed(1) + "%").padStart(8) +
    (((v.s2.mape - b2.mape) * 100).toFixed(1) + "pp").padStart(8) +
    ((v.s2.sevCap === null ? "  —" : v.s2.sevCap.toFixed(2)) + " (" + (b2.sevCap === null ? "—" : b2.sevCap.toFixed(2)) + ")").padStart(14) +
    ((v.s2.dirBig === null ? " —" : (v.s2.dirBig * 100).toFixed(0) + "%") + " (" + (b2.dirBig === null ? "—" : (b2.dirBig * 100).toFixed(0) + "%") + ")").padStart(13)
  );
}
