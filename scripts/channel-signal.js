#!/usr/bin/env node
/*
 * channel-signal.js — builds the dealer-channel leading-indicator series
 * for docs/leading-indicator.html and the dashboard alert gauge.
 *
 * For each quarter we compute, exactly as the forecasting model sees it
 * (Titan Machinery SEC inventory ÷ trailing-4Q revenue, with a 45-day
 * filing lag), the dealer stock-to-sales ratio and its YoY change, and
 * line it up against Deere revenue YoY. We then detect "channel warning"
 * crossings (stsYoY above an amber/red threshold) and measure how many
 * quarters EARLY each crossing was relative to the manufacturer revenue
 * downturn that followed.
 *
 * Writes data/external/channel-signal.json
 * Usage: node scripts/channel-signal.js
 */
const fs = require("fs");
const path = require("path");
const Forecast = require(path.join(__dirname, "..", "js", "forecast.js"));
const H = Forecast.helpers;

const ext = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "external", "external-data.json"), "utf8"));
const TINV = ext.edgar.TITN_INV.obs;
const TREV = ext.edgar.TITN_REV.obs;
const DE = ext.edgar.DE_REV.obs;

const AMBER = 0.15; // stsYoY (log) amber threshold
const RED = 0.25;   // stsYoY red threshold

function shiftDays(d, n) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

// stock-to-sales as the model sees it at a given "as of" date (45-day lag)
function stsAsOf(asOf) {
  const eff = shiftDays(asOf, -45);
  const inv = H.valueAsOf(TINV, eff);
  const revs = TREV.filter((o) => o.date <= eff).slice(-4);
  if (inv == null || revs.length < 4) return null;
  const ttm = revs.reduce((s, o) => s + o.value, 0);
  return ttm > 0 ? { sts: inv / ttm, inv: inv, ttm: ttm } : null;
}

// Deere YoY at a quarter end (using the 3-month value at that quarter)
function deYoY(date) {
  const idx = DE.findIndex((o) => o.date === date);
  if (idx < 4) return null;
  return Math.log(DE[idx].value / DE[idx - 4].value);
}

// Build a quarterly grid off Titan's own quarter-end dates (most granular)
const points = [];
for (let i = 0; i < TINV.length; i++) {
  const date = TINV[i].date;
  const now = stsAsOf(date);
  const ago = stsAsOf(H.addMonths(date, -12));
  if (!now || !ago) continue;
  const stsYoY = Math.log(now.sts / ago.sts);
  // nearest Deere quarter within ~50 days, for the overlay
  let de = null, best = 1e9;
  for (const o of DE) {
    const d = Math.abs((new Date(o.date) - new Date(date)) / 86400000);
    if (d < best && d <= 50) { best = d; de = o.date; }
  }
  points.push({
    date: date,
    sts: +now.sts.toFixed(4),
    stsYoY: +stsYoY.toFixed(4),
    invYoY: +Math.log(now.inv / stsAsOf(H.addMonths(date, -12)).inv).toFixed(4),
    deYoY: de ? +(deYoY(de) || 0).toFixed(4) : null,
    deDate: de,
    level: stsYoY >= RED ? "red" : stsYoY >= AMBER ? "amber" : "normal",
  });
}

// Detect sustained warning crossings (>=2 consecutive quarters at/above amber)
const crossings = [];
for (let i = 1; i < points.length; i++) {
  const prev = points[i - 1], cur = points[i];
  if (prev.stsYoY < AMBER && cur.stsYoY >= AMBER) {
    // require it to hold the next quarter to avoid one-off blips
    if (i + 1 < points.length && points[i + 1].stsYoY >= AMBER - 0.02) {
      crossings.push({ start: cur.date, stsYoY: cur.stsYoY });
    }
  }
}

// For each crossing, find the first subsequent Deere quarter that went
// negative YoY, and report the lead in quarters.
const deQ = DE.map((o, i) => ({ date: o.date, yoy: i >= 4 ? Math.log(o.value / DE[i - 4].value) : null }))
  .filter((o) => o.yoy != null);
function quartersBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000 / 91.3);
}
for (const c of crossings) {
  const firstNeg = deQ.find((o) => o.date > c.start && o.yoy < 0);
  c.firstDeereDownturn = firstNeg ? firstNeg.date : null;
  c.leadQuarters = firstNeg ? quartersBetween(c.start, firstNeg.date) : null;
}

const out = {
  generatedAt: new Date().toISOString(),
  thresholds: { amber: AMBER, red: RED },
  note: "Dealer stock-to-sales (Titan Machinery SEC inventory / trailing-4Q revenue, 45-day filing lag) " +
        "vs Deere revenue YoY. Crossings flag channel overstock ahead of manufacturer downturns.",
  points: points,
  crossings: crossings,
};
fs.writeFileSync(path.join(__dirname, "..", "data", "external", "channel-signal.json"), JSON.stringify(out));

const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
console.log("Dealer channel leading-indicator signal\n");
console.log("date         sts    stsYoY   DeereYoY  level");
for (const p of points.filter((p) => p.date >= "2013-01-01")) {
  console.log("  " + p.date + "  " + p.sts.toFixed(3) + "  " + pct(p.stsYoY).padStart(7) +
    "   " + (p.deYoY == null ? "   —" : pct(p.deYoY).padStart(7)) + "   " +
    (p.level === "red" ? "🔴 RED" : p.level === "amber" ? "🟠 amber" : ""));
}
console.log("\nSustained channel-warning crossings and their lead time:");
for (const c of crossings) {
  console.log("  " + c.start + "  stsYoY " + pct(c.stsYoY) +
    (c.firstDeereDownturn ? "  → Deere turned negative " + c.firstDeereDownturn +
      "  (" + c.leadQuarters + " quarters early)" : "  → no subsequent downturn yet"));
}
console.log("\nWrote data/external/channel-signal.json");
