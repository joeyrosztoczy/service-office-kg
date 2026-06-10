#!/usr/bin/env node
/*
 * backtest.js — walk-forward backtests of the forecasting engine against
 * real internet data (SEC EDGAR financials + FRED macro features), then
 * produces the live 4-quarter forecast used by the dashboard.
 *
 * Reads  data/external/external-data.json   (from scripts/fetch-external.js)
 * Writes docs/backtest-report.json          (per-quarter predictions + metrics)
 *        data/external/forecast-output.json (dashboard forecast panel feed)
 *
 * Usage: node scripts/backtest.js
 */
const fs = require("fs");
const path = require("path");
const Forecast = require(path.join(__dirname, "..", "js", "forecast.js"));

const dataPath = path.join(__dirname, "..", "data", "external", "external-data.json");
if (!fs.existsSync(dataPath)) {
  console.error("Run scripts/fetch-external.js first.");
  process.exit(1);
}
const ext = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// macro dict per target: dealer-channel series added as cross-series
// features, except when the target IS the dealer (self-prediction)
function macrosFor(targetKey) {
  const m = Object.assign({}, ext.fred);
  if (targetKey.indexOf("TITN") !== 0 && ext.edgar.TITN_INV && ext.edgar.TITN_REV) {
    m.CHANNEL_INV = { obs: ext.edgar.TITN_INV.obs };
    m.CHANNEL_REV = { obs: ext.edgar.TITN_REV.obs };
  }
  return m;
}

const TARGETS = [
  { key: "DE_REV",   label: "Deere quarterly revenue (demand proxy)" },
  { key: "CNH_REV",  label: "CNH Industrial quarterly revenue" },
  { key: "AGCO_REV", label: "AGCO quarterly revenue" },
  { key: "TITN_REV", label: "Titan Machinery (dealer) revenue" },
  { key: "TITN_INV", label: "Titan Machinery (dealer) inventory — UCC-style channel proxy" },
];

const fmtB = (v) => "$" + (v / 1e9).toFixed(2) + "B";
const pct = (v) => (v * 100).toFixed(1) + "%";

const report = { generatedAt: new Date().toISOString(), series: {} };
const dashboard = { generatedAt: new Date().toISOString(), series: {}, outlook: null };

console.log("Walk-forward backtests on real data (model vs naive baselines)\n");
console.log("series     n-test   MAPE-ens  MAPE-model  MAPE-seasNaive  MAPE-grwNaive    MAE-ens  dirAcc  skill");
console.log("-".repeat(104));

for (const t of TARGETS) {
  const series = ext.edgar[t.key];
  if (!series) { console.log(t.key + ": missing from cache, skipped"); continue; }
  const target = series.obs;

  const macros = macrosFor(t.key);
  const wf = Forecast.walkForward(target, macros, { minTrain: 12 });
  if (wf.points.length < 6) { console.log(t.key + ": too few test points (" + wf.points.length + "), skipped"); continue; }

  const mEns = Forecast.metrics(wf.points, "ensemble");
  const mModel = Forecast.metrics(wf.points, "model");
  const mSeas = Forecast.metrics(wf.points, "seasonalNaive");
  const mGrw = Forecast.metrics(wf.points, "growthNaive");
  const skill = 1 - mEns.mape / mSeas.mape; // % error reduction vs seasonal naive

  const sd = Forecast.residualStd(wf.points);
  const fc = Forecast.forecast(target, macros, 4, sd);

  console.log(
    t.key.padEnd(9) +
    String(mEns.n).padStart(7) +
    pct(mEns.mape).padStart(12) +
    pct(mModel.mape).padStart(12) +
    pct(mSeas.mape).padStart(16) +
    pct(mGrw.mape).padStart(15) +
    fmtB(mEns.mae).padStart(11) +
    pct(mEns.dirAcc).padStart(8) +
    pct(skill).padStart(7)
  );

  report.series[t.key] = {
    label: t.label, company: series.company,
    featureNames: wf.featureNames,
    points: wf.points,
    metrics: { ensemble: mEns, model: mModel, seasonalNaive: mSeas, growthNaive: mGrw, skillVsSeasonal: skill, residualStdLog: sd },
    forecast: fc,
  };
  dashboard.series[t.key] = {
    label: t.label, company: series.company,
    recent: target.slice(-12),
    forecast: fc,
  };
}

// Demand outlook for the twin: average predicted YoY growth across the next
// 4 quarters of Deere revenue (our brand's demand proxy).
const deFc = report.series.DE_REV && report.series.DE_REV.forecast;
if (deFc && deFc.length) {
  const avgYoY = deFc.reduce((s, f) => s + f.yhat, 0) / deFc.length;
  dashboard.outlook = {
    basis: "Deere revenue forecast, next " + deFc.length + " quarters",
    avgYoY: avgYoY,
    demandScale: Math.max(0.6, Math.min(1.5, 1 + avgYoY)),
  };
  console.log("\nDemand outlook (Deere revenue, avg next-4Q YoY): " +
    (avgYoY >= 0 ? "+" : "") + pct(avgYoY) + "  -> twin demand scale " + dashboard.outlook.demandScale.toFixed(3));
  deFc.forEach((f) => console.log("  " + f.date + "  " + fmtB(f.pred) +
    "  (80% CI " + fmtB(f.lo) + " – " + fmtB(f.hi) + ", YoY " + (f.yhat >= 0 ? "+" : "") + pct(f.yhat) + ")"));
}

fs.writeFileSync(path.join(__dirname, "..", "docs", "backtest-report.json"), JSON.stringify(report));
fs.writeFileSync(path.join(__dirname, "..", "data", "external", "forecast-output.json"), JSON.stringify(dashboard));
console.log("\nWrote docs/backtest-report.json and data/external/forecast-output.json");
