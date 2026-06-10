#!/usr/bin/env node
/*
 * fetch-external.js — pulls real-world series from the public internet and
 * caches them under data/external/external-data.json for the forecasting
 * layer. No API keys required.
 *
 * Sources:
 *  - FRED (fredgraph.csv, no key): macro features — prime rate, ag-machinery
 *    PPI, corn/soy/wheat prices, unemployment, all-commodities PPI.
 *  - SEC EDGAR XBRL companyconcept API (no key, UA header required):
 *    manufacturer demand proxies (Deere, CNH, AGCO quarterly revenues) and
 *    the dealer-channel inventory proxy (Titan Machinery InventoryNet —
 *    a publicly traded ag dealer group; UCC bulk data is not freely
 *    accessible, this is the closest public substitute).
 *
 * Usage: node scripts/fetch-external.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const UA = "service-office-kg digital twin research (jrosztoczy@gmail.com)";
const OUT_DIR = path.join(__dirname, "..", "data", "external");

function curl(url, extraArgs) {
  const args = ["-sf", "--max-time", "40", "-H", "User-Agent: " + UA].concat(extraArgs || [], [url]);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return execFileSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      lastErr = e;
      const wait = 1500 * Math.pow(2, attempt);
      console.error("  retry " + (attempt + 1) + " for " + url.slice(0, 90) + " in " + wait + "ms");
      execFileSync("sleep", [String(wait / 1000)]);
    }
  }
  throw lastErr;
}

// ---------------- FRED ----------------
// Each feature has fallback series ids — FRED's bot protection intermittently
// 404s individual series, and some (IMF commodity prices) may be withdrawn.
const FRED_FEATURES = [
  { key: "PRIME",       name: "Bank prime loan rate (%)",                 candidates: ["MPRIME"], required: true },
  { key: "PPI_AG_MACH", name: "PPI: agricultural machinery & equipment",  candidates: ["WPU111"], required: true },
  { key: "CORN",        name: "Corn price (IMF global or BLS PPI)",       candidates: ["PCORNUSDM", "WPU012202"], required: true },
  { key: "SOY",         name: "Soybean price (IMF global)",               candidates: ["PSOYBUSDM"], required: false },
  { key: "WHEAT",       name: "Wheat price (IMF global or grains PPI)",   candidates: ["PWHEAMTUSDM", "WPU0121"], required: false },
  { key: "UNRATE",      name: "US unemployment rate (%)",                 candidates: ["UNRATE"], required: false },
  { key: "PPI_ALL",     name: "PPI: all commodities",                     candidates: ["PPIACO"], required: false },
  // feature-lab additions: farm-margin inputs, cycle leads, consumer
  { key: "FERT",        name: "PPI: fertilizer materials",                candidates: ["WPU0651"], required: false },
  { key: "DIESEL",      name: "PPI: No. 2 diesel fuel",                   candidates: ["WPU057303"], required: false },
  { key: "CURVE",       name: "10Y minus 3M Treasury spread (%)",         candidates: ["T10Y3MM"], required: false },
  { key: "UMCSENT",     name: "U. Michigan consumer sentiment",           candidates: ["UMCSENT"], required: false },
  { key: "IP_AG_MACH",  name: "Industrial production: ag/constr/mining machinery", candidates: ["IPG3331S"], required: false },
  { key: "HOUST",       name: "Housing starts (SAAR, thousands)",         candidates: ["HOUST"], required: false },
];

// ---------------- US Drought Monitor (weekly, no key) ----------------
function fetchDrought() {
  const url = "https://usdmdataservices.unl.edu/api/USStatistics/GetDroughtSeverityStatisticsByAreaPercent" +
    "?aoi=conus&startdate=1/1/2000&enddate=12/31/2026&statisticsType=1";
  const csv = curl(url);
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",");
  const iDate = header.indexOf("ValidStart"), iD2 = header.indexOf("D2");
  if (iDate < 0 || iD2 < 0) throw new Error("USDM format changed: " + lines[0]);
  // monthly average of % CONUS area in severe-or-worse drought (D2+)
  const byMonth = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const v = parseFloat(c[iD2]);
    if (!c[iDate] || !Number.isFinite(v)) continue;
    const m = c[iDate].slice(0, 7);
    (byMonth[m] = byMonth[m] || []).push(v);
  }
  const obs = Object.keys(byMonth).sort().map(function (m) {
    return { date: m + "-01", value: byMonth[m].reduce(function (s, v) { return s + v; }, 0) / byMonth[m].length };
  });
  if (obs.length < 60) throw new Error("USDM: only " + obs.length + " months");
  return obs;
}

function tryFredSeries(id) {
  const csv = curl("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + id);
  const lines = csv.trim().split("\n").slice(1);
  const obs = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    const v = parseFloat(raw);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(v)) obs.push({ date: date, value: v });
  }
  if (obs.length < 24) throw new Error("FRED " + id + ": only " + obs.length + " observations");
  return obs;
}

function fetchFredFeature(feature) {
  for (const id of feature.candidates) {
    try {
      execFileSync("sleep", ["2"]); // stay under FRED rate limits
      return { id: id, obs: tryFredSeries(id) };
    } catch (e) {
      console.error("  " + feature.key + ": series " + id + " unavailable (" + e.message.split("\n")[0].slice(0, 60) + ")");
    }
  }
  return null;
}

// ---------------- St. Louis Fed Financial Stress Index (weekly, no key) ----
// Purpose-built composite of 18 financial-market stress measures (credit
// spreads, implied vol, Treasuries). The best single "exogenous shock"
// detector — it spiked weeks before COVID/2008/2022 hit ag revenue.
function fetchStress() {
  const csv = curl("https://fred.stlouisfed.org/graph/fredgraph.csv?id=STLFSI4");
  const lines = csv.trim().split("\n").slice(1);
  const weekly = [];
  for (const line of lines) {
    const [date, raw] = line.split(",");
    const v = parseFloat(raw);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(v)) weekly.push({ date: date, value: v });
  }
  if (weekly.length < 200) throw new Error("STLFSI4: only " + weekly.length + " weeks");
  // monthly = the most stressed (max) reading in the month, so mid-month
  // spikes survive aggregation into the quarterly model's feature
  const byMonth = {};
  for (const w of weekly) {
    const m = w.date.slice(0, 7);
    byMonth[m] = byMonth[m] == null ? w.value : Math.max(byMonth[m], w.value);
  }
  const monthly = Object.keys(byMonth).sort().map(function (m) { return { date: m + "-01", value: byMonth[m] }; });
  return { weekly: weekly, monthly: monthly };
}
const EDGAR_SERIES = [
  { series: "DE_REV",   company: "Deere & Co",                cik: "0000315189", kind: "duration",
    tags: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"] },
  { series: "CNH_REV",  company: "CNH Industrial (Case IH / New Holland)", cik: "0001567094", kind: "duration",
    tags: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"] },
  { series: "AGCO_REV", company: "AGCO (Fendt / Massey Ferguson)", cik: "0000880266", kind: "duration",
    tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"] },
  { series: "TITN_INV", company: "Titan Machinery (public ag dealer group)", cik: "0001409171", kind: "instant",
    tags: ["InventoryNet"] },
  { series: "TITN_REV", company: "Titan Machinery (public ag dealer group)", cik: "0001409171", kind: "duration",
    tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"] },
];

function fetchConcept(cik, tag) {
  const url = "https://data.sec.gov/api/xbrl/companyconcept/CIK" + cik + "/us-gaap/" + tag + ".json";
  try {
    const j = JSON.parse(curl(url));
    return (j.units && j.units.USD) || [];
  } catch (e) {
    return []; // tag not filed by this company
  }
}

function days(a, b) { return (new Date(b) - new Date(a)) / 86400000; }

/* Reduce raw XBRL facts to one clean quarterly series.
 * - duration concepts: keep ~3-month facts; derive missing Q4s as
 *   annual minus the three quarters inside the same fiscal year.
 * - instant concepts (inventory): one value per period end.
 * Latest filing wins on duplicates (restatements). */
function toQuarterly(facts, kind) {
  const byEnd = new Map();
  const annuals = [];
  for (const f of facts) {
    if (typeof f.val !== "number") continue;
    if (kind === "instant") {
      const prev = byEnd.get(f.end);
      if (!prev || (f.filed || "") > prev.filed) byEnd.set(f.end, { value: f.val, filed: f.filed || "" });
    } else {
      const d = days(f.start, f.end);
      if (d >= 70 && d <= 100) {
        const prev = byEnd.get(f.end);
        if (!prev || (f.filed || "") > prev.filed) byEnd.set(f.end, { value: f.val, filed: f.filed || "" });
      } else if (d >= 330 && d <= 380) {
        annuals.push(f);
      }
    }
  }
  if (kind === "duration") {
    for (const a of annuals) {
      if (byEnd.has(a.end)) continue;
      const inside = [...byEnd.entries()].filter(([end]) => days(a.start, end) > 0 && days(end, a.end) > 0);
      if (inside.length === 3) {
        const sum = inside.reduce((s, [, v]) => s + v.value, 0);
        byEnd.set(a.end, { value: a.val - sum, filed: a.filed || "" });
      }
    }
  }
  return [...byEnd.entries()]
    .map(([date, v]) => ({ date, value: v.value }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

function fetchEdgar(spec) {
  const seen = new Set();
  let facts = [];
  for (const tag of spec.tags) {
    for (const f of fetchConcept(spec.cik, tag)) {
      const key = (f.start || "") + "|" + f.end;
      if (!seen.has(key)) { seen.add(key); facts.push(f); }
    }
  }
  const obs = toQuarterly(facts, spec.kind);
  if (obs.length < 12) throw new Error(spec.series + ": only " + obs.length + " quarters");
  return obs;
}

// ---------------- main ----------------
const out = { fetchedAt: new Date().toISOString(), fred: {}, edgar: {} };

console.log("Fetching FRED series…");
for (const f of FRED_FEATURES) {
  const got = fetchFredFeature(f);
  if (!got) {
    if (f.required) throw new Error("Required FRED feature " + f.key + " unavailable from all candidates");
    console.log("  " + f.key.padEnd(12) + "SKIPPED (optional, all candidates failed)");
    continue;
  }
  const obs = got.obs;
  out.fred[f.key] = { name: f.name, fredId: got.id, freq: "monthly", obs };
  console.log("  " + f.key.padEnd(12) + obs.length + " obs  " + obs[0].date + " .. " + obs[obs.length - 1].date + "  [" + got.id + "]");
}

console.log("Fetching US Drought Monitor…");
try {
  const obs = fetchDrought();
  out.fred.DROUGHT = { name: "CONUS area in severe+ drought (D2+, %)", fredId: "USDM", freq: "monthly", obs };
  console.log("  DROUGHT     " + obs.length + " obs  " + obs[0].date + " .. " + obs[obs.length - 1].date + "  [USDM D2+]");
} catch (e) {
  console.log("  DROUGHT     SKIPPED (" + e.message.split("\n")[0].slice(0, 60) + ")");
}

console.log("Fetching St. Louis Fed Financial Stress Index…");
try {
  const stress = fetchStress();
  out.fred.STRESS = { name: "St. Louis Fed Financial Stress Index (monthly max)", fredId: "STLFSI4", freq: "monthly", obs: stress.monthly };
  out.stressWeekly = { name: "STLFSI4 weekly", fredId: "STLFSI4", obs: stress.weekly };
  const m = stress.monthly;
  console.log("  STRESS      " + m.length + " months  " + m[0].date + " .. " + m[m.length - 1].date + "  [STLFSI4]");
} catch (e) {
  console.log("  STRESS      SKIPPED (" + e.message.split("\n")[0].slice(0, 60) + ")");
}

console.log("Fetching SEC EDGAR series…");
for (const s of EDGAR_SERIES) {
  const obs = fetchEdgar(s);
  out.edgar[s.series] = { company: s.company, cik: s.cik, kind: s.kind, tags: s.tags, freq: "quarterly", obs };
  console.log("  " + s.series.padEnd(10) + obs.length + " quarters  " + obs[0].date + " .. " + obs[obs.length - 1].date +
    "  (" + s.company + ")");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "external-data.json"), JSON.stringify(out));
console.log("\nWrote data/external/external-data.json");
