/*
 * charts.js — dashboard charts (d3).
 *
 *  - bandChart:      in-stock units by HP band, stacked by brand
 *                    (the "horsepower equivalents" competitive view)
 *  - valuationChart: Deere inventory value vs floor-plan interest over time
 *  - agingChart:     Deere stock aging buckets with value at risk
 */
const TwinCharts = (function () {
  "use strict";

  function clear(el) { d3.select(el).selectAll("*").remove(); }
  function fmtM(v) { return "$" + (v / 1e6).toFixed(1) + "M"; }
  function fmtK(v) { return "$" + Math.round(v / 1e3) + "k"; }

  // ---- inventory by HP band, stacked by brand ------------------------
  function bandChart(selector, sim, filters) {
    const el = document.querySelector(selector);
    const w = el.clientWidth || 360, h = el.clientHeight || 180;
    const M = { top: 16, right: 10, bottom: 22, left: 30 };
    clear(el);
    const svg = d3.select(el).append("svg").attr("viewBox", "0 0 " + w + " " + h);

    const units = Twin.unitsInStock(sim, filters);
    const data = Twin.BANDS.map(function (b) {
      const row = { band: b.id, total: 0 };
      Twin.BRANDS.forEach(function (br) { row[br] = 0; });
      units.forEach(function (u) { if (u.band === b.id) { row[u.brand]++; row.total++; } });
      return row;
    });

    const x = d3.scaleBand().domain(data.map(function (d) { return d.band; }))
      .range([M.left, w - M.right]).padding(0.35);
    const y = d3.scaleLinear().domain([0, d3.max(data, function (d) { return d.total; }) || 1])
      .nice().range([h - M.bottom, M.top]);

    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(0," + (h - M.bottom) + ")")
      .call(d3.axisBottom(x).tickSize(0).tickPadding(7));
    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(" + M.left + ",0)")
      .call(d3.axisLeft(y).ticks(4).tickSize(-(w - M.left - M.right)));

    data.forEach(function (d) {
      let y0 = 0;
      Twin.BRANDS.forEach(function (br) {
        const v = d[br];
        if (!v) return;
        svg.append("rect")
          .attr("x", x(d.band)).attr("width", x.bandwidth())
          .attr("y", y(y0 + v)).attr("height", Math.max(0, y(y0) - y(y0 + v)))
          .attr("rx", 2).attr("fill", Twin.BRAND_COLORS[br]).attr("opacity", 0.92);
        y0 += v;
      });
      if (d.total) {
        svg.append("text").attr("class", "bar-label")
          .attr("x", x(d.band) + x.bandwidth() / 2).attr("y", y(d.total) - 5)
          .attr("text-anchor", "middle").text(d.total);
      }
    });
  }

  // ---- valuation & floor-plan exposure trend --------------------------
  function valuationChart(selector, sim) {
    const el = document.querySelector(selector);
    const w = el.clientWidth || 360, h = el.clientHeight || 180;
    const M = { top: 12, right: 44, bottom: 20, left: 44 };
    clear(el);
    const svg = d3.select(el).append("svg").attr("viewBox", "0 0 " + w + " " + h);

    const hist = sim.history.slice(-365);
    if (!hist.length) return;

    const x = d3.scaleLinear()
      .domain(d3.extent(hist, function (d) { return d.day; }))
      .range([M.left, w - M.right]);
    const yVal = d3.scaleLinear()
      .domain([0, d3.max(hist, function (d) { return d.valueDeere; }) * 1.1])
      .range([h - M.bottom, M.top]);
    const yExp = d3.scaleLinear()
      .domain([0, Math.max(1, d3.max(hist, function (d) { return d.exposure; })) * 1.15])
      .range([h - M.bottom, M.top]);

    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(" + M.left + ",0)")
      .call(d3.axisLeft(yVal).ticks(4).tickFormat(function (v) { return "$" + Math.round(v / 1e6) + "M"; }));
    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(" + (w - M.right) + ",0)")
      .call(d3.axisRight(yExp).ticks(4).tickFormat(function (v) { return "$" + Math.round(v / 1e3) + "k"; }));
    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(0," + (h - M.bottom) + ")")
      .call(d3.axisBottom(x).ticks(5).tickFormat(function (d) {
        const dt = Twin.simDate(sim, d);
        return (dt.getMonth() + 1) + "/" + String(dt.getFullYear()).slice(2);
      }));

    const area = d3.area()
      .x(function (d) { return x(d.day); })
      .y0(yVal(0))
      .y1(function (d) { return yVal(d.valueDeere); })
      .curve(d3.curveMonotoneX);
    const lineVal = d3.line()
      .x(function (d) { return x(d.day); })
      .y(function (d) { return yVal(d.valueDeere); })
      .curve(d3.curveMonotoneX);
    const lineExp = d3.line()
      .x(function (d) { return x(d.day); })
      .y(function (d) { return yExp(d.exposure); })
      .curve(d3.curveMonotoneX);

    svg.append("path").datum(hist).attr("d", area).attr("fill", "rgba(63,165,53,0.16)");
    svg.append("path").datum(hist).attr("d", lineVal)
      .attr("fill", "none").attr("stroke", "#3fa535").attr("stroke-width", 2);
    svg.append("path").datum(hist).attr("d", lineExp)
      .attr("fill", "none").attr("stroke", "#e25563").attr("stroke-width", 1.6)
      .attr("stroke-dasharray", "4 3");

    const last = hist[hist.length - 1];
    svg.append("circle").attr("cx", x(last.day)).attr("cy", yVal(last.valueDeere))
      .attr("r", 3).attr("fill", "#3fa535");
    svg.append("text").attr("class", "spot-label")
      .attr("x", x(last.day) - 6).attr("y", yVal(last.valueDeere) - 8)
      .attr("text-anchor", "end").text(fmtM(last.valueDeere));
  }

  // ---- Deere stock aging buckets --------------------------------------
  function agingChart(selector, sim, filters) {
    const el = document.querySelector(selector);
    const w = el.clientWidth || 360, h = el.clientHeight || 160;
    clear(el);
    const svg = d3.select(el).append("svg").attr("viewBox", "0 0 " + w + " " + h);

    const f = { brand: "John Deere", region: filters.region, band: filters.band };
    const units = Twin.unitsInStock(sim, f);

    const defs = [
      { label: "0–60 days",   min: 0,   max: 60,  color: "#3fa535" },
      { label: "61–120 days", min: 61,  max: 120, color: "#c9cf3a" },
      { label: "121–180 days",min: 121, max: 180, color: "#f2a33c" },
      { label: "180+ days",   min: 181, max: 1e9, color: "#e25563" },
    ];
    const buckets = defs.map(function (b) {
      const us = units.filter(function (u) { return u.invDays >= b.min && u.invDays <= b.max; });
      return {
        label: b.label, color: b.color, n: us.length,
        value: us.reduce(function (s, u) { return s + u.value; }, 0),
      };
    });

    const maxN = d3.max(buckets, function (b) { return b.n; }) || 1;
    const rowH = h / buckets.length;
    const labelW = 92, valueW = 118;
    const barMax = Math.max(40, w - labelW - valueW);

    buckets.forEach(function (b, i) {
      const cy = i * rowH + rowH / 2;
      svg.append("text").attr("class", "row-label")
        .attr("x", labelW - 8).attr("y", cy + 4).attr("text-anchor", "end").text(b.label);
      svg.append("rect")
        .attr("x", labelW).attr("y", cy - 8)
        .attr("width", barMax).attr("height", 16)
        .attr("rx", 8).attr("fill", "rgba(255,255,255,0.05)");
      svg.append("rect")
        .attr("x", labelW).attr("y", cy - 8)
        .attr("width", Math.max(b.n ? 16 : 0, barMax * b.n / maxN)).attr("height", 16)
        .attr("rx", 8).attr("fill", b.color).attr("opacity", 0.9);
      svg.append("text").attr("class", "row-value")
        .attr("x", labelW + barMax + 8).attr("y", cy + 4)
        .text(b.n + " units · " + (b.value >= 1e6 ? fmtM(b.value) : fmtK(b.value)));
    });
  }

  function renderAll(sim, filters) {
    bandChart("#chart-bands", sim, filters);
    valuationChart("#chart-valuation", sim);
    agingChart("#chart-aging", sim, filters);
  }

  // ---- real-data series + forecast fan (dashboard forecast panel) -----
  function forecastChart(selector, recent, fc, color) {
    const el = document.querySelector(selector);
    const w = el.clientWidth || 360, h = el.clientHeight || 170;
    const M = { top: 12, right: 14, bottom: 22, left: 48 };
    clear(el);
    const svg = d3.select(el).append("svg").attr("viewBox", "0 0 " + w + " " + h);

    const hist = recent.map(function (o) { return { dt: new Date(o.date), v: o.value }; });
    const fut = fc.map(function (f) { return { dt: new Date(f.date), v: f.pred, lo: f.lo, hi: f.hi }; });
    const all = hist.concat(fut);
    if (!all.length) return;

    const x = d3.scaleTime().domain(d3.extent(all, function (d) { return d.dt; })).range([M.left, w - M.right]);
    const y = d3.scaleLinear()
      .domain([0, d3.max(all, function (d) { return d.hi || d.v; }) * 1.08])
      .nice().range([h - M.bottom, M.top]);

    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(" + M.left + ",0)")
      .call(d3.axisLeft(y).ticks(4).tickFormat(function (v) { return "$" + (v / 1e9).toFixed(1) + "B"; }));
    svg.append("g").attr("class", "axis")
      .attr("transform", "translate(0," + (h - M.bottom) + ")")
      .call(d3.axisBottom(x).ticks(5).tickFormat(d3.timeFormat("%b %y")));

    // divider between actuals and forecast
    if (hist.length && fut.length) {
      const xd = x(hist[hist.length - 1].dt);
      svg.append("line").attr("x1", xd).attr("x2", xd).attr("y1", M.top).attr("y2", h - M.bottom)
        .attr("stroke", "#7d92a5").attr("stroke-dasharray", "2 3").attr("opacity", 0.6);
    }

    // 80% interval fan
    const band = d3.area()
      .x(function (d) { return x(d.dt); })
      .y0(function (d) { return y(d.lo); })
      .y1(function (d) { return y(d.hi); })
      .curve(d3.curveMonotoneX);
    const fanPts = hist.length
      ? [{ dt: hist[hist.length - 1].dt, lo: hist[hist.length - 1].v, hi: hist[hist.length - 1].v }].concat(fut)
      : fut;
    svg.append("path").datum(fanPts).attr("d", band).attr("fill", color).attr("opacity", 0.14);

    const line = d3.line()
      .x(function (d) { return x(d.dt); })
      .y(function (d) { return y(d.v); })
      .curve(d3.curveMonotoneX);
    svg.append("path").datum(hist).attr("d", line)
      .attr("fill", "none").attr("stroke", color).attr("stroke-width", 2);
    svg.append("path").datum(hist.length ? [hist[hist.length - 1]].concat(fut) : fut).attr("d", line)
      .attr("fill", "none").attr("stroke", color).attr("stroke-width", 2).attr("stroke-dasharray", "5 4");

    fut.forEach(function (d) {
      svg.append("circle").attr("cx", x(d.dt)).attr("cy", y(d.v)).attr("r", 3)
        .attr("fill", color).attr("stroke", "#0c1116");
    });
  }

  return { renderAll: renderAll, forecastChart: forecastChart };
})();
