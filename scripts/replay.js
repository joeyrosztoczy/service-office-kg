#!/usr/bin/env node
/*
 * replay.js — plays the digital twin back over ~2.5 years (913 days,
 * ending "today"), writes docs/replay-data.json for the playback chart
 * (docs/replay.html) and prints a quarterly digest + headline insights.
 *
 * Usage: node scripts/replay.js
 */
const fs = require("fs");
const path = require("path");
const Twin = require(path.join(__dirname, "..", "js", "data.js"));

const TOTAL_DAYS = 913; // ~2.5 years
const MS_DAY = 86400000;
const NOW = Date.now();
const dateFor = (d) => new Date(NOW - (TOTAL_DAYS - d) * MS_DAY);
const iso = (d) => dateFor(d).toISOString().slice(0, 10);
const fmtM = (v) => "$" + (v / 1e6).toFixed(1) + "M";
const fmtK = (v) => "$" + Math.round(v / 1e3) + "k";

const sim = Twin.createSim(9); // includes 150-day warmup with history

// ---- per-day sales taken from sale records (records carry sim day) ----
const salesByDay = {};
const marginByAge = { fresh: { n: 0, m: 0 }, mid: { n: 0, m: 0 }, aged: { n: 0, m: 0 } };
function recordSale(s) {
  const r = (salesByDay[s.day] = salesByDay[s.day] || { deere: 0, comp: 0, revenue: 0, margin: 0 });
  if (s.brand === "John Deere") {
    r.deere++;
    r.revenue += s.price;
    r.margin += s.margin;
    const b = s.invDays <= 120 ? "fresh" : s.invDays <= 180 ? "mid" : "aged";
    marginByAge[b].n++;
    marginByAge[b].m += s.margin;
  } else {
    r.comp++;
  }
}
sim.sales.forEach(recordSale); // warmup sales are all still in memory

// ---- daily series: warmup from sim.history, then live capture ----------
const series = sim.history.map((h) => ({
  day: h.day, date: iso(h.day),
  stock: h.stock, transit: h.transit,
  valueDeere: h.valueDeere, exposure: Math.round(h.exposure),
  riskScore: h.riskScore,
}));

function snapshot() {
  const inStock = sim.fleet.filter((u) => u.status === "in_stock");
  const deere = inStock.filter((u) => u.brand === "John Deere").length;
  series.push({
    day: sim.day, date: iso(sim.day),
    stock: inStock.length, transit: sim.fleet.length - inStock.length,
    stockDeere: deere, stockComp: inStock.length - deere,
    valueDeere: sim.risk.totalValue, exposure: Math.round(sim.risk.exposure),
    riskScore: sim.risk.score, aged180: sim.risk.aged180,
    avgDS: Math.round(sim.risk.avgDS),
  });
}

while (sim.day < TOTAL_DAYS) {
  Twin.tick(sim);
  for (let i = sim.sales.length - 1; i >= 0 && sim.sales[i].day === sim.day; i--) {
    recordSale(sim.sales[i]);
  }
  snapshot();
}

fs.mkdirSync(path.join(__dirname, "..", "docs"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "..", "docs", "replay-data.json"),
  JSON.stringify({ generatedAt: new Date(NOW).toISOString(), totalDays: TOTAL_DAYS, days: series })
);

// ---- quarterly digest ---------------------------------------------------
const Q_LEN = 91;
const nQ = Math.ceil(TOTAL_DAYS / Q_LEN);
const rows = [];
for (let q = 0; q < nQ; q++) {
  const d0 = q * Q_LEN + 1, d1 = Math.min((q + 1) * Q_LEN, TOTAL_DAYS);
  const span = series.filter((s) => s.day >= d0 && s.day <= d1);
  if (!span.length) continue;
  const end = span[span.length - 1];
  let deereSold = 0, compSold = 0, revenue = 0, margin = 0;
  for (let d = d0; d <= d1; d++) {
    const r = salesByDay[d];
    if (r) { deereSold += r.deere; compSold += r.comp; revenue += r.revenue; margin += r.margin; }
  }
  rows.push({
    q: "Q" + (q + 1), end: end.date,
    avgStock: Math.round(span.reduce((s, x) => s + x.stock, 0) / span.length),
    endDeere: end.stockDeere != null ? end.stockDeere : "–",
    endValue: end.valueDeere, endExposure: end.exposure,
    avgRisk: Math.round(span.reduce((s, x) => s + x.riskScore, 0) / span.length),
    maxRisk: Math.max(...span.map((x) => x.riskScore)),
    aged180: end.aged180 != null ? end.aged180 : "–",
    deereSold, compSold, revenue, margin,
  });
}

console.log("\n=== 9R Digital Twin — 2.5-year inventory playback (ending " + iso(TOTAL_DAYS) + ") ===\n");
console.log(
  "Qtr  ending      avgStock  endJD  endValue   exposure  avgRisk(max)  aged180  JDsold  CompSold  JDrevenue   JDmargin");
rows.forEach((r) => {
  console.log(
    [
      r.q.padEnd(4), r.end.padEnd(11),
      String(r.avgStock).padStart(8), String(r.endDeere).padStart(6),
      fmtM(r.endValue).padStart(9), fmtK(r.endExposure).padStart(9),
      (r.avgRisk + " (" + r.maxRisk + ")").padStart(12),
      String(r.aged180).padStart(8), String(r.deereSold).padStart(7),
      String(r.compSold).padStart(9), fmtM(r.revenue).padStart(10),
      fmtM(r.margin).padStart(10),
    ].join("  ")
  );
});

// ---- headline insights ---------------------------------------------------
const live = series.filter((s) => s.stockDeere != null);
const first = series[0], last = series[series.length - 1];
const minStock = series.reduce((a, b) => (b.stock < a.stock ? b : a));
const maxStock = series.reduce((a, b) => (b.stock > a.stock ? b : a));
const minVal = series.reduce((a, b) => (b.valueDeere < a.valueDeere ? b : a));
const maxVal = series.reduce((a, b) => (b.valueDeere > a.valueDeere ? b : a));
const maxExp = series.reduce((a, b) => (b.exposure > a.exposure ? b : a));
const maxAged = live.reduce((a, b) => ((b.aged180 || 0) > (a.aged180 || 0) ? b : a));

let highDays = 0, streak = 0, bestStreak = 0, bestStreakEnd = null;
series.forEach((s) => {
  if (s.riskScore >= 67) {
    highDays++; streak++;
    if (streak > bestStreak) { bestStreak = streak; bestStreakEnd = s.date; }
  } else streak = 0;
});

const monthly = {};
Object.keys(salesByDay).forEach((d) => {
  const m = dateFor(+d).getMonth();
  (monthly[m] = monthly[m] || { deere: 0 }).deere += salesByDay[d].deere;
});
const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const seasonRow = monthNames.map((n, i) => n + ":" + ((monthly[i] && monthly[i].deere) || 0)).join("  ");

const totDeere = rows.reduce((s, r) => s + r.deereSold, 0);
const totComp = rows.reduce((s, r) => s + r.compSold, 0);
const totRev = rows.reduce((s, r) => s + r.revenue, 0);
const totMargin = rows.reduce((s, r) => s + r.margin, 0);

console.log("\n--- Headlines ---");
console.log("Network stock:    " + first.stock + " -> " + last.stock + " units  (low " + minStock.stock + " on " + minStock.date + ", high " + maxStock.stock + " on " + maxStock.date + ")");
console.log("Deere stock now:  " + last.stockDeere + " units in stock, " + last.transit + " in transit, avg days-supply " + last.avgDS);
console.log("Deere value:      " + fmtM(first.valueDeere) + " -> " + fmtM(last.valueDeere) + "  (low " + fmtM(minVal.valueDeere) + " " + minVal.date + ", high " + fmtM(maxVal.valueDeere) + " " + maxVal.date + ")");
console.log("Floor-plan int.:  " + fmtK(first.exposure) + " -> " + fmtK(last.exposure) + " accrued  (peak " + fmtK(maxExp.exposure) + " on " + maxExp.date + ")");
console.log("Aged 180+ units:  now " + last.aged180 + "  (worst " + maxAged.aged180 + " on " + maxAged.date + ")");
console.log("Risk:             now " + last.riskScore + "; " + highDays + " high-risk days (>=67); longest streak " + bestStreak + "d ending " + bestStreakEnd);
console.log("Retail (2.5y):    " + totDeere + " Deere sold for " + fmtM(totRev) + " (gross margin " + fmtM(totMargin) + ", avg " + fmtK(totMargin / Math.max(1, totDeere)) + "/unit); competitors sold " + totComp + " (Deere share " + Math.round((100 * totDeere) / (totDeere + totComp)) + "%)");
console.log("Margin by age sold: fresh <=120d: " + marginByAge.fresh.n + " units avg " + fmtK(marginByAge.fresh.m / Math.max(1, marginByAge.fresh.n)) +
  " | 121-180d: " + marginByAge.mid.n + " avg " + fmtK(marginByAge.mid.m / Math.max(1, marginByAge.mid.n)) +
  " | 180+d: " + marginByAge.aged.n + " avg " + fmtK(marginByAge.aged.m / Math.max(1, marginByAge.aged.n)));
console.log("Deere sales by month:  " + seasonRow);
console.log("\nWrote docs/replay-data.json (" + series.length + " days)");
