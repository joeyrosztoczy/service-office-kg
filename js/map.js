/*
 * map.js — animated world map.
 *
 * Pulsing dots show in-stock inventory per hub (sized by unit count,
 * colored by dominant brand). Animated arcs show units in transit:
 * factory shipments and dealer-to-dealer transfers, with a dot moving
 * along each arc in sync with the simulation clock.
 */
const TwinMap = (function () {
  "use strict";

  let container, svg, gGrat, gMap, gArcs, gDots, gHubs, projection, geoPath, tooltip;
  let width = 960, height = 540;
  let arcItems = [];          // { unit, pathEl, dotEl, len }
  let worldFeatures = null;   // cached topojson countries
  let lastSim = null, lastFilters = null;

  function shortName(h) {
    return h.name.split(",")[0].split(" (")[0];
  }

  function init(selector, sim, filters) {
    container = document.querySelector(selector);
    lastSim = sim; lastFilters = filters;
    width = container.clientWidth || 960;
    height = container.clientHeight || 540;

    d3.select(container).selectAll("svg").remove();
    svg = d3.select(container).append("svg")
      .attr("viewBox", "0 0 " + width + " " + height)
      .attr("preserveAspectRatio", "xMidYMid meet");

    projection = d3.geoNaturalEarth1()
      .fitExtent([[6, 6], [width - 6, height - 6]], { type: "Sphere" });
    geoPath = d3.geoPath(projection);

    svg.append("path").attr("class", "sphere").attr("d", geoPath({ type: "Sphere" }));
    gGrat = svg.append("g");
    gGrat.append("path").attr("class", "graticule").attr("d", geoPath(d3.geoGraticule10()));
    gMap = svg.append("g").attr("class", "countries");
    gArcs = svg.append("g");
    gDots = svg.append("g");
    gHubs = svg.append("g");

    tooltip = d3.select(container).selectAll(".map-tooltip").data([0])
      .join("div").attr("class", "map-tooltip").style("opacity", 0);

    if (worldFeatures) {
      drawCountries();
    } else {
      fetch("vendor/countries-110m.json")
        .then(function (r) { return r.json(); })
        .then(function (world) {
          worldFeatures = topojson.feature(world, world.objects.countries).features;
          drawCountries();
        })
        .catch(function () {
          // offline: hubs + arcs still render on the graticule
          console.warn("world-atlas unavailable; rendering without country shapes");
        });
    }
  }

  function drawCountries() {
    gMap.selectAll("path").data(worldFeatures).join("path").attr("d", geoPath);
  }

  // Curved arc between two hubs, lifted perpendicular to the chord.
  function arcPath(fromId, toId) {
    const a = Twin.HUB_BY_ID[fromId], b = Twin.HUB_BY_ID[toId];
    const p0 = projection([a.lon, a.lat]), p1 = projection([b.lon, b.lat]);
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    let nx = -dy / dist, ny = dx / dist;
    if (ny > 0) { nx = -nx; ny = -ny; } // always bow upward
    const lift = Math.min(70, dist * 0.18);
    const cx = mx + nx * lift, cy = my + ny * lift;
    return "M" + p0[0].toFixed(1) + "," + p0[1].toFixed(1) +
      "Q" + cx.toFixed(1) + "," + cy.toFixed(1) +
      " " + p1[0].toFixed(1) + "," + p1[1].toFixed(1);
  }

  function hubTooltipHtml(d) {
    const sim = lastSim;
    const ds = d.hub.factory ? null : Twin.daysSupply(sim, d.hub.id);
    const comp = d.total - d.deere;
    let html = "<b>" + d.hub.name + "</b><br>" + d.hub.region;
    if (d.hub.factory) {
      const out = Twin.unitsInTransit(sim).filter(function (u) { return u.transit.from === d.hub.id; }).length;
      return html + "<br>9R production source · " + out + " units en route";
    }
    html += "<br>In stock: <b>" + d.total + "</b> (Deere " + d.deere + " · competitors " + comp + ")";
    html += "<br>Stock value: <b>$" + (d.value / 1e6).toFixed(1) + "M</b>";
    html += "<br>Deere days supply: <b>" + (ds || "–") + "</b>";
    if (d.aged > 0) html += "<br><span class='warn'>" + d.aged + " Deere unit(s) aged 180+ days</span>";
    return html;
  }

  function renderTick(sim, filters) {
    lastSim = sim; lastFilters = filters;

    // ---- hubs --------------------------------------------------------
    const hubData = Twin.HUBS.map(function (h) {
      const units = sim.fleet.filter(function (u) {
        return u.status === "in_stock" && u.hub === h.id && Twin.matchesFilters(u, filters);
      });
      const deere = units.filter(function (u) { return u.brand === "John Deere"; }).length;
      const aged = units.filter(function (u) { return u.brand === "John Deere" && u.invDays > 180; }).length;
      const value = units.reduce(function (s, u) { return s + u.value; }, 0);
      return { hub: h, total: units.length, deere: deere, aged: aged, value: value };
    });

    const groups = gHubs.selectAll("g.hub").data(hubData, function (d) { return d.hub.id; })
      .join(function (enter) {
        const g = enter.append("g").attr("class", "hub");
        g.append("circle").attr("class", "pulse");
        g.append("circle").attr("class", "core");
        g.filter(function (d) { return d.hub.factory; })
          .append("text").attr("class", "factory-label").attr("dy", -12)
          .attr("text-anchor", "middle").text(function (d) { return shortName(d.hub); });
        g.on("mousemove", function (event, d) {
          const p = d3.pointer(event, container);
          tooltip.style("opacity", 1)
            .style("left", Math.min(p[0] + 14, width - 230) + "px")
            .style("top", (p[1] + 12) + "px")
            .html(hubTooltipHtml(d));
        }).on("mouseleave", function () { tooltip.style("opacity", 0); });
        return g;
      });

    groups.attr("transform", function (d) {
      const p = projection([d.hub.lon, d.hub.lat]);
      return "translate(" + p[0] + "," + p[1] + ")";
    });

    groups.select("circle.core")
      .attr("r", function (d) {
        if (d.hub.factory) return 5;
        return d.total ? 3 + Math.sqrt(d.total) * 1.9 : 1.6;
      })
      .attr("class", function (d) {
        if (d.hub.factory) return "core factory";
        if (!d.total) return "core empty";
        return "core " + (d.deere * 2 >= d.total ? "deere" : "comp");
      });

    groups.select("circle.pulse")
      .attr("r", function (d) {
        if (d.hub.factory) return 5;
        return d.total ? 3 + Math.sqrt(d.total) * 1.9 : 0;
      })
      .attr("class", function (d) {
        if (d.hub.factory) return "pulse factory";
        return "pulse " + (d.deere * 2 >= d.total ? "deere" : "comp");
      });

    // ---- transit arcs ------------------------------------------------
    const transits = Twin.unitsInTransit(sim, filters);

    const paths = gArcs.selectAll("path.arc").data(transits, function (d) { return d.id; })
      .join("path")
      .attr("class", "arc")
      .attr("stroke", function (d) { return Twin.BRAND_COLORS[d.brand]; })
      .attr("d", function (d) { return arcPath(d.transit.from, d.transit.to); });

    const dots = gDots.selectAll("circle.mover").data(transits, function (d) { return d.id; })
      .join("circle")
      .attr("class", "mover")
      .attr("r", 3.2)
      .attr("fill", function (d) { return Twin.BRAND_COLORS[d.brand]; });

    arcItems = [];
    const dotByUnit = {};
    dots.each(function (d) { dotByUnit[d.id] = this; });
    paths.each(function (d) {
      const dot = dotByUnit[d.id];
      if (dot) arcItems.push({ unit: d, pathEl: this, dotEl: dot, len: this.getTotalLength() });
    });

    frame(0);
  }

  // Called every animation frame; frac is the fractional day [0,1).
  function frame(frac) {
    for (let i = 0; i < arcItems.length; i++) {
      const it = arcItems[i];
      const tr = it.unit.transit;
      if (!tr) continue;
      const t = Math.max(0, Math.min(1, (tr.daysDone + frac) / tr.daysTotal));
      const p = it.pathEl.getPointAtLength(t * it.len);
      it.dotEl.setAttribute("cx", p.x);
      it.dotEl.setAttribute("cy", p.y);
    }
  }

  return { init: init, renderTick: renderTick, frame: frame };
})();
