#!/usr/bin/env node
/*
 * shock-monitor.js — real-time macro-shock detector built on the weekly
 * St. Louis Fed Financial Stress Index (STLFSI4).
 *
 * WHY AN OVERLAY, NOT A FORECAST FEATURE:
 *   Financial stress has almost no lead correlation with NEXT quarter's ag
 *   revenue (|corr| ~0.1) — stress spikes are sudden and mean-revert, so a
 *   quarterly regression learns nothing from it. But stress reacts to
 *   exogenous shocks (COVID, 2008) WEEKS before they show up in quarterly
 *   manufacturer data. So it is worthless as a predictor yet invaluable as
 *   a coincident nowcast / risk overlay: it converts "blind to the shock"
 *   into "flagged the shock ~1 quarter before the print, mid-quarter."
 *
 * Classifies the weekly index, extracts shock episodes, measures the lead
 * to the subsequent ag-revenue trough, and emits the current status plus a
 * recommended forecast-interval widening + demand dampener for the twin.
 *
 * Writes data/external/shock-signal.json
 * Usage: node scripts/shock-monitor.js
 */
const fs = require("fs");
const path = require("path");
const Forecast = require(path.join(__dirname, "..", "js", "forecast.js"));
const H = Forecast.helpers;

const ext = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "external", "external-data.json"), "utf8"));
const W = ext.stressWeekly.obs;     // weekly STLFSI4
const DE = ext.edgar.DE_REV.obs;    // Deere revenue (shock impact reference)

// thresholds on the normalized index (0 = average conditions)
const WATCH = 0.5, STRESS = 1.0, SHOCK = 2.0;
function classify(v) { return v >= SHOCK ? "shock" : v >= STRESS ? "stress" : v >= WATCH ? "watch" : "calm"; }

const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

// ---- episodes: contiguous runs at/above WATCH, tagged by peak severity ----
const episodes = [];
let cur = null;
for (const w of W) {
  if (w.value >= WATCH) {
    if (!cur) cur = { start: w.date, peak: w.value, peakDate: w.date };
    else if (w.value > cur.peak) { cur.peak = w.value; cur.peakDate = w.date; }
  } else if (cur) { cur.end = w.date; episodes.push(cur); cur = null; }
}
if (cur) { cur.end = W[W.length - 1].date; episodes.push(cur); }

// keep meaningful episodes (peak >= STRESS) and measure lead to ag trough
function agTroughAfter(startDate, withinMonths) {
  let trough = 99, tdate = null;
  for (let i = 4; i < DE.length; i++) {
    if (DE[i].date < startDate) continue;
    const months = (new Date(DE[i].date) - new Date(startDate)) / 86400000 / 30.4;
    if (months > withinMonths) break;
    const yoy = Math.log(DE[i].value / DE[i - 4].value);
    if (yoy < trough) { trough = yoy; tdate = DE[i].date; }
  }
  return tdate ? { trough: trough, date: tdate, leadMonths: Math.round((new Date(tdate) - new Date(startDate)) / 86400000 / 30.4) } : null;
}

const majorEpisodes = episodes
  .filter((e) => e.peak >= STRESS)
  .map((e) => {
    const onset = W.find((w) => w.date >= e.start && w.value >= STRESS);
    const ag = (DE[0].date <= e.start) ? agTroughAfter(e.start, 12) : null;
    return {
      start: e.start, end: e.end, peak: +e.peak.toFixed(2), peakDate: e.peakDate,
      level: classify(e.peak),
      onsetDate: onset ? onset.date : e.start,
      agTrough: ag,
    };
  });

// ---- current status ----
const latest = W[W.length - 1];
const recent4 = W.slice(-4);
const rising = recent4.length > 1 && recent4[recent4.length - 1].value > recent4[0].value;
const level = classify(latest.value);
// interval-widening + demand dampener scale with active stress above WATCH
const stressExcess = Math.max(0, latest.value - WATCH);
const intervalMult = +(1 + Math.min(1.5, stressExcess * 0.6)).toFixed(2);   // widen CI up to 2.5x
const demandDampen = +(1 - Math.min(0.35, stressExcess * 0.12)).toFixed(3); // cut demand up to 35%

// weekly series for the chart (downsample pre-2015 to monthly to keep it light)
const chart = W.filter((w) => w.date >= "2015-01-01" || w.date.slice(8) === "01" || w.value >= WATCH)
  .map((w) => ({ date: w.date, v: +w.value.toFixed(2), level: classify(w.value) }));

const out = {
  generatedAt: new Date().toISOString(),
  thresholds: { watch: WATCH, stress: STRESS, shock: SHOCK },
  rationale: "Weekly St. Louis Fed Financial Stress Index (STLFSI4). Overlay, not a forecast feature: " +
    "detects exogenous shocks (COVID, 2008) ~1 quarter before they hit quarterly ag revenue.",
  current: {
    date: latest.date, value: +latest.value.toFixed(2), level: level, rising: rising,
    intervalMult: intervalMult, demandDampen: demandDampen,
  },
  episodes: majorEpisodes,
  weekly: chart,
  deRevYoY: DE.map((o, i) => i >= 4 ? { date: o.date, yoy: +Math.log(o.value / DE[i - 4].value).toFixed(4) } : null).filter(Boolean),
};
fs.writeFileSync(path.join(__dirname, "..", "data", "external", "shock-signal.json"), JSON.stringify(out));

console.log("Macro shock monitor (STLFSI4 weekly)\n");
console.log("Major stress episodes (peak >= " + STRESS + ") and ag-revenue impact:");
for (const e of majorEpisodes) {
  console.log("  " + e.onsetDate + "  peak " + e.peak.toFixed(2).padStart(5) + " (" + e.level + ")" +
    (e.agTrough ? "  → Deere revenue trough " + pct(e.agTrough.trough) + " at " + e.agTrough.date +
      "  (" + e.agTrough.leadMonths + " mo later)" : "  (pre-2008, no Deere data)"));
}
console.log("\nCurrent: " + out.current.date + "  STLFSI " + out.current.value + "  [" + level.toUpperCase() + "]" +
  (rising ? " rising" : "") + "  → CI x" + intervalMult + ", demand x" + demandDampen);
console.log("\nWrote data/external/shock-signal.json");
