#!/usr/bin/env node
/*
 * inflection-backtest.js — hardcore historical evaluation of the
 * forecasting system on real data over 5 / 10 / 15 year windows, with
 * focused tests on the industry's known inflection points.
 *
 * Three evaluations:
 *  1. WINDOWS    — one-step walk-forward accuracy restricted to the last
 *                  5 / 10 / 15 years (training always expands from the
 *                  start of data; only scoring is windowed).
 *  2. EPISODES   — the same one-step predictions scored inside known
 *                  industry regimes (2013-16 ag downturn, 2020 COVID,
 *                  2021-23 supercycle, 2024-25 destock, 2026 recovery).
 *  3. STRESS     — the brutal test: stand at the eve of each inflection,
 *                  truncate BOTH the target and every macro series at that
 *                  date (zero lookahead), forecast 4 quarters recursively,
 *                  and compare the path to what actually happened.
 *
 * Usage: node scripts/inflection-backtest.js
 */
const fs = require("fs");
const path = require("path");
const Forecast = require(path.join(__dirname, "..", "js", "forecast.js"));

const ext = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "external", "external-data.json"), "utf8"));

// dealer-channel cross-series features, except for the dealer itself
function macrosFor(targetKey) {
  const m = Object.assign({}, ext.fred);
  if (targetKey.indexOf("TITN") !== 0 && ext.edgar.TITN_INV && ext.edgar.TITN_REV) {
    m.CHANNEL_INV = { obs: ext.edgar.TITN_INV.obs };
    m.CHANNEL_REV = { obs: ext.edgar.TITN_REV.obs };
  }
  return m;
}

const SERIES = [
  { key: "DE_REV",   label: "Deere revenue" },
  { key: "CNH_REV",  label: "CNH revenue" },
  { key: "AGCO_REV", label: "AGCO revenue" },
  { key: "TITN_REV", label: "Titan dealer revenue" },
  { key: "TITN_INV", label: "Titan dealer inventory" },
];

const EPISODES = [
  { name: "2013-16 ag downturn (corn collapse)", from: "2013-10-01", to: "2016-12-31" },
  { name: "2020 COVID shock",                    from: "2020-01-01", to: "2020-12-31" },
  { name: "2021-23 supercycle boom",             from: "2021-01-01", to: "2023-09-30" },
  { name: "2024-25 destock / downturn",          from: "2023-10-01", to: "2025-12-31" },
  { name: "2026 stabilization",                  from: "2026-01-01", to: "2026-12-31" },
];

// stress origins: stand at this date knowing nothing after it
const STRESS = [
  { name: "Eve of the 2014 downturn",  origin: "2013-12-31" },
  { name: "Mid-collapse 2015",         origin: "2015-06-30" },
  { name: "Eve of COVID",              origin: "2020-01-31" },
  { name: "Boom onset",                origin: "2020-12-31" },
  { name: "Peak / eve of 2024 downturn", origin: "2023-10-31" },
  { name: "Mid-destock 2025",          origin: "2025-01-31" },
];

const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
const upct = (v) => (v * 100).toFixed(1) + "%";
const fmtB = (v) => "$" + (v / 1e9).toFixed(2) + "B";

const report = { generatedAt: new Date().toISOString(), windows: {}, episodes: {}, turningPoints: {}, stress: {} };

// precompute walk-forward points per series (expanding training window)
const WF = {};
for (const s of SERIES) {
  if (!ext.edgar[s.key]) continue;
  WF[s.key] = Forecast.walkForward(ext.edgar[s.key].obs, macrosFor(s.key), { minTrain: 12 }).points;
}

function score(points) {
  if (!points.length) return null;
  const m = Forecast.metrics(points, "ensemble");
  const ms = Forecast.metrics(points, "seasonalNaive");
  const mg = Forecast.metrics(points, "growthNaive");
  return { n: m.n, mape: m.mape, dirAcc: m.dirAcc, seasMape: ms.mape, grwMape: mg.mape, skill: 1 - m.mape / ms.mape };
}

// ---------------------------------------------------------------------
// 1. window metrics
// ---------------------------------------------------------------------
console.log("=== 1. Walk-forward accuracy by window (ensemble vs baselines) ===\n");
console.log("window   series     n   MAPE-ens  MAPE-seas  MAPE-grw  dirAcc   skill");
console.log("-".repeat(76));
for (const years of [15, 10, 5]) {
  const cutoff = new Date(Date.now() - years * 365.25 * 86400000).toISOString().slice(0, 10);
  for (const s of SERIES) {
    if (!WF[s.key]) continue;
    const pts = WF[s.key].filter((p) => p.date >= cutoff);
    const sc = score(pts);
    if (!sc || sc.n < 6) continue;
    report.windows[years + "y_" + s.key] = sc;
    console.log(
      (years + "y").padEnd(8) + s.key.padEnd(9) + String(sc.n).padStart(4) +
      upct(sc.mape).padStart(10) + upct(sc.seasMape).padStart(11) + upct(sc.grwMape).padStart(10) +
      upct(sc.dirAcc).padStart(8) + pct(sc.skill).padStart(8)
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------
// 2. episode scoring
// ---------------------------------------------------------------------
console.log("=== 2. Accuracy inside industry inflection episodes ===\n");
for (const ep of EPISODES) {
  console.log(ep.name + "  (" + ep.from + " → " + ep.to + ")");
  for (const s of SERIES) {
    if (!WF[s.key]) continue;
    const pts = WF[s.key].filter((p) => p.date >= ep.from && p.date <= ep.to);
    const sc = score(pts);
    if (!sc || sc.n < 3) continue;
    report.episodes[ep.name + "|" + s.key] = sc;
    const avgG = pts.reduce((a, p) => a + p.yActual, 0) / pts.length;
    console.log(
      "  " + s.key.padEnd(9) + String(sc.n).padStart(3) + "q" +
      "  actual avg YoY " + pct(avgG).padStart(7) +
      "  MAPE " + upct(sc.mape).padStart(6) + " (seas-naive " + upct(sc.seasMape) + ")" +
      "  dirAcc " + upct(sc.dirAcc)
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------
// 3. turning-point detection
//    a turning point: actual YoY growth flips sign and holds for >=2 quarters
// ---------------------------------------------------------------------
console.log("=== 3. Turning-point detection (sustained YoY sign flips) ===\n");
for (const s of SERIES) {
  const pts = WF[s.key];
  if (!pts) continue;
  const flips = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = Math.sign(pts[i - 1].yActual), cur = Math.sign(pts[i].yActual);
    if (prev !== 0 && cur !== 0 && cur !== prev && Math.sign(pts[i + 1].yActual) === cur) {
      // detection lag: quarters from flip until ensemble first calls the new sign
      let lag = null;
      for (let k = i; k < Math.min(i + 5, pts.length); k++) {
        if (Math.sign(Math.log(pts[k].ensemble / pts[k].seasonalNaive)) === cur) { lag = k - i; break; }
      }
      flips.push({
        date: pts[i].date,
        dir: cur > 0 ? "up" : "down",
        actualG: pts[i].yActual,
        caughtAtFlip: Math.sign(Math.log(pts[i].ensemble / pts[i].seasonalNaive)) === cur,
        grwNaiveAtFlip: Math.sign(Math.log(pts[i].growthNaive / pts[i].seasonalNaive)) === cur,
        lag: lag,
      });
    }
  }
  const caught = flips.filter((f) => f.caughtAtFlip).length;
  const grwCaught = flips.filter((f) => f.grwNaiveAtFlip).length;
  report.turningPoints[s.key] = flips;
  console.log(s.key + " (" + s.label + "): " + flips.length + " turning points; ensemble called " +
    caught + "/" + flips.length + " in the flip quarter (momentum baseline: " + grwCaught + "/" + flips.length + ")");
  flips.forEach((f) => console.log(
    "   " + f.date + "  " + f.dir.padEnd(4) + " actual " + pct(f.actualG).padStart(7) +
    "  called in flip quarter: " + (f.caughtAtFlip ? "YES" : "no ") +
    (f.lag === null ? "  (not within 4q)" : f.lag === 0 ? "" : "  (caught " + f.lag + "q later)")
  ));
  console.log("");
}

// ---------------------------------------------------------------------
// 4. stress tests: forecast 4 quarters from the eve of each inflection
//    with target AND macros truncated at the origin (zero lookahead)
// ---------------------------------------------------------------------
console.log("=== 4. Stress tests: 4-quarter recursive forecasts from historical origins ===");
console.log("    (target and all macro series truncated at the origin date)\n");
for (const st of STRESS) {
  console.log("◆ " + st.name + " — standing at " + st.origin);
  for (const s of SERIES) {
    const full = ext.edgar[s.key] && ext.edgar[s.key].obs;
    if (!full) continue;
    const known = full.filter((o) => o.date <= st.origin);
    const future = full.filter((o) => o.date > st.origin).slice(0, 4);
    if (known.length < 17 || future.length < 3) continue;

    const macrosThen = Forecast.truncateMacros(macrosFor(s.key), st.origin);
    const wfK = Forecast.walkForward(known, macrosThen, { minTrain: 12 });
    const sd = wfK.points.length >= 6 ? Forecast.residualStd(wfK.points) : 0.1;
    const fc = Forecast.forecast(known, macrosThen, future.length, sd, { minRows: 10 });
    if (!fc.length) continue;

    let ape = 0, n = 0, covered = 0;
    const steps = [];
    for (let i = 0; i < Math.min(fc.length, future.length); i++) {
      const e = (fc[i].pred - future[i].value) / future[i].value;
      ape += Math.abs(e); n++;
      if (future[i].value >= fc[i].lo && future[i].value <= fc[i].hi) covered++;
      steps.push("q" + (i + 1) + " " + pct(e));
    }
    const lastK = known[known.length - 1].value;
    const predChg = fc[Math.min(fc.length, future.length) - 1].pred / lastK - 1;
    const actChg = future[Math.min(fc.length, future.length) - 1].value / lastK - 1;
    const dirOK = Math.sign(predChg) === Math.sign(actChg);

    report.stress[st.name + "|" + s.key] = { pathMape: ape / n, coverage: covered / n, predChg, actChg, dirOK };
    console.log(
      "  " + s.key.padEnd(9) +
      " path-MAPE " + upct(ape / n).padStart(6) +
      "  pred " + n + "q-chg " + pct(predChg).padStart(7) + " vs actual " + pct(actChg).padStart(7) +
      "  direction " + (dirOK ? "RIGHT" : "WRONG") +
      "  80%CI coverage " + covered + "/" + n +
      "   [" + steps.join(", ") + "]"
    );
  }
  console.log("");
}

fs.writeFileSync(path.join(__dirname, "..", "docs", "inflection-report.json"), JSON.stringify(report));
console.log("Wrote docs/inflection-report.json");
