/*
 * main.js — wires the digital twin to the dashboard.
 * Owns the simulation clock (RAF loop, 1 tick = 1 simulated day),
 * filters, KPI cards, risk panel, movement feed and regional table.
 */
(function () {
  "use strict";

  if (typeof d3 === "undefined" || typeof topojson === "undefined") {
    const b = document.getElementById("offline-banner");
    if (b) b.style.display = "block";
    return;
  }

  const sim = Twin.createSim(9);
  const filters = { brand: "All", region: "All", band: "All" };
  let playing = true;
  let speed = 1;     // simulated days per real second
  let acc = 0;       // fractional-day accumulator
  let lastTs = null;
  let lastEventCount = 0;

  // ---------------- helpers ----------------
  function $(sel) { return document.querySelector(sel); }
  function fmtMoney(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    return "$" + Math.round(v / 1e3) + "k";
  }
  function fmtDate(d) {
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // ---------------- filter controls ----------------
  function buildFilters() {
    const chips = $("#brand-chips");
    ["All"].concat(Twin.BRANDS).forEach(function (b) {
      const btn = document.createElement("button");
      btn.className = "chip" + (b === "All" ? " active" : "");
      btn.dataset.brand = b;
      if (b !== "All") {
        const dot = document.createElement("i");
        dot.style.background = Twin.BRAND_COLORS[b];
        btn.appendChild(dot);
      }
      btn.appendChild(document.createTextNode(b));
      btn.addEventListener("click", function () {
        filters.brand = b;
        chips.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("active"); });
        btn.classList.add("active");
        render();
      });
      chips.appendChild(btn);
    });

    const rs = $("#region-select");
    ["All"].concat(Twin.REGIONS).forEach(function (r) {
      const o = document.createElement("option");
      o.value = r; o.textContent = r;
      rs.appendChild(o);
    });
    rs.addEventListener("change", function () { filters.region = rs.value; render(); });

    const bs = $("#band-select");
    ["All"].concat(Twin.BANDS.map(function (b) { return b.id; })).forEach(function (b) {
      const o = document.createElement("option");
      o.value = b; o.textContent = b;
      bs.appendChild(o);
    });
    bs.addEventListener("change", function () { filters.band = bs.value; render(); });
  }

  // ---------------- sim controls ----------------
  function buildControls() {
    const play = $("#btn-play");
    play.addEventListener("click", function () {
      playing = !playing;
      play.textContent = playing ? "⏸" : "▶";
      play.title = playing ? "Pause" : "Play";
    });
    const sp = $("#speed");
    sp.addEventListener("change", function () { speed = parseFloat(sp.value); });
  }

  // ---------------- KPI cards ----------------
  function renderKpis() {
    const deere = Twin.unitsInStock(sim, { brand: "John Deere", region: filters.region, band: filters.band });
    const transit = Twin.unitsInTransit(sim, filters);
    const value = deere.reduce(function (s, u) { return s + u.value; }, 0);
    const interest = deere.reduce(function (s, u) { return s + u.interest; }, 0);
    const aged = deere.filter(function (u) { return u.invDays > 180; }).length;
    const avgDays = deere.length
      ? Math.round(deere.reduce(function (s, u) { return s + u.invDays; }, 0) / deere.length) : 0;

    $("#kpi-stock").textContent = deere.length;
    $("#kpi-transit").textContent = transit.length;
    $("#kpi-value").textContent = fmtMoney(value);
    $("#kpi-interest").textContent = fmtMoney(interest);
    $("#kpi-aging").textContent = aged;
    $("#kpi-days").textContent = avgDays + "d";

    const agedEl = $("#kpi-aging");
    agedEl.classList.toggle("bad", aged >= 8);
    agedEl.classList.toggle("warn", aged > 0 && aged < 8);
  }

  // ---------------- risk panel ----------------
  function renderRisk() {
    const r = sim.risk;
    if (!r) return;
    const score = $("#risk-score");
    score.textContent = r.score;
    score.className = "risk-score " + (r.score >= 67 ? "high" : r.score >= 34 ? "med" : "low");
    const fill = $("#risk-fill");
    fill.style.width = r.score + "%";
    fill.className = r.score >= 67 ? "high" : r.score >= 34 ? "med" : "low";
    $("#risk-meta").textContent =
      r.aged180 + " units 180+d · avg " + Math.round(r.avgDS) + "d supply · " +
      fmtMoney(r.exposure) + " interest accrued";

    const ul = $("#alerts-list");
    ul.innerHTML = "";
    if (!sim.alerts.length) {
      const li = document.createElement("li");
      li.className = "ok";
      li.textContent = "No active alerts — network position healthy.";
      ul.appendChild(li);
    }
    sim.alerts.forEach(function (a) {
      const li = document.createElement("li");
      li.className = a.severity;
      li.textContent = a.text;
      ul.appendChild(li);
    });
  }

  // ---------------- movement feed ----------------
  const FEED_ICONS = { ship: "🚚", arrival: "📦", transfer: "🔁", sale: "💰", competitor: "🏁" };
  function renderFeed() {
    const ul = $("#feed-list");
    const events = sim.events.slice(-14).reverse();
    const fresh = sim.events.length !== lastEventCount;
    lastEventCount = sim.events.length;
    ul.innerHTML = "";
    events.forEach(function (e, i) {
      const li = document.createElement("li");
      li.className = "ev-" + e.type + (fresh && i === 0 ? " new" : "");
      const when = fmtDate(Twin.simDate(sim, e.day));
      li.innerHTML = "<span class='ev-ic'>" + (FEED_ICONS[e.type] || "•") + "</span>" +
        "<span class='ev-when'>" + when + "</span> " + e.text;
      ul.appendChild(li);
    });
  }

  // ---------------- regional table ----------------
  function renderRegionTable() {
    const tb = $("#region-table");
    tb.innerHTML = "";
    Twin.REGIONS.forEach(function (region) {
      const hubs = Twin.HUBS.filter(function (h) { return h.region === region && !h.factory; });
      if (!hubs.length) return;
      let jd = 0, comp = 0, value = 0, dsSum = 0, dsN = 0;
      hubs.forEach(function (h) {
        Twin.hubStock(sim, h.id).forEach(function (u) {
          if (u.brand === "John Deere") jd++; else comp++;
          value += u.value;
        });
        const ds = Twin.daysSupply(sim, h.id);
        if (ds > 0) { dsSum += ds; dsN++; }
      });
      const ds = dsN ? Math.round(dsSum / dsN) : 0;
      const idx = sim.market.regions[region];
      const tr = document.createElement("tr");
      const dsClass = ds > 200 ? "bad" : ds > 0 && ds < 50 ? "warn" : "";
      const idxClass = idx < 0.97 ? "bad" : idx > 1.03 ? "good" : "";
      tr.innerHTML =
        "<td>" + region + "</td>" +
        "<td>" + jd + "</td>" +
        "<td>" + comp + "</td>" +
        "<td>" + fmtMoney(value) + "</td>" +
        "<td class='" + dsClass + "'>" + (ds || "–") + "</td>" +
        "<td class='" + idxClass + "'>" + idx.toFixed(3) + "</td>";
      tb.appendChild(tr);
    });
  }

  // ---------------- band chart legend ----------------
  function buildLegend() {
    const el = $("#band-legend");
    Twin.BRANDS.forEach(function (b) {
      const span = document.createElement("span");
      span.className = "lg";
      span.innerHTML = "<i style='background:" + Twin.BRAND_COLORS[b] + "'></i>" + b;
      el.appendChild(span);
    });
  }

  // ---------------- render orchestration ----------------
  function render() {
    $("#sim-date").textContent = fmtDate(Twin.simDate(sim));
    renderKpis();
    TwinMap.renderTick(sim, filters);
    TwinCharts.renderAll(sim, filters);
    renderRisk();
    renderFeed();
    renderRegionTable();
  }

  // ---------------- simulation clock ----------------
  function loop(ts) {
    requestAnimationFrame(loop);
    if (lastTs === null) { lastTs = ts; return; }
    const dt = Math.min(0.25, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!playing) return;
    acc += dt * speed;
    let ticked = false, guard = 0;
    while (acc >= 1 && guard++ < 10) {
      Twin.tick(sim);
      acc -= 1;
      ticked = true;
    }
    if (acc >= 1) acc = 0; // dropped frames at very high speed
    if (ticked) render();
    TwinMap.frame(Math.max(0, Math.min(0.999, acc)));
  }

  // ---------------- resize ----------------
  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      TwinMap.init("#map", sim, filters);
      render();
      renderForecastPanel();
    }, 200);
  });

  // ---------------- real-data forecast panel ----------------
  let forecastData = null;

  function renderForecastPanel() {
    if (!forecastData) return;
    const de = forecastData.series.DE_REV;
    const titn = forecastData.series.TITN_INV;
    if (de) TwinCharts.forecastChart("#chart-forecast-de", de.recent, de.forecast, "#3fa535");
    if (titn) TwinCharts.forecastChart("#chart-forecast-titn", titn.recent, titn.forecast, "#2d9cdb");

    const o = forecastData.outlook;
    if (o) {
      Twin.setDemandScale(sim, o.demandScale);
      const yoyPct = (o.avgYoY * 100).toFixed(1);
      const cls = o.avgYoY >= 0 ? "pos" : "neg";
      $("#outlook-body").innerHTML =
        "Next-4-quarter demand outlook (" + o.basis + "):" +
        "<span class='big " + cls + "'>" + (o.avgYoY >= 0 ? "+" : "") + yoyPct + "% YoY</span>" +
        "The twin's retail demand is scaled by <b>×" + o.demandScale.toFixed(3) + "</b> — " +
        "watch days-supply and the risk score respond to the real-world outlook. " +
        "<br>Data: SEC EDGAR (Deere, CNH, AGCO, Titan Machinery) + FRED macro features, fetched " +
        forecastData.generatedAt.slice(0, 10) + ".";
    }
  }

  fetch("data/external/forecast-output.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j) { forecastData = j; renderForecastPanel(); } })
    .catch(function () { /* panel keeps its instructions */ });

  // ---------------- boot ----------------
  buildFilters();
  buildControls();
  buildLegend();
  TwinMap.init("#map", sim, filters);
  render();
  requestAnimationFrame(loop);
})();
