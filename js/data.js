/*
 * data.js — digital twin simulation core.
 *
 * Generates and evolves a synthetic global fleet of John Deere 9R-series
 * tractors (9R / 9RX / 9RT) and competitor horsepower equivalents
 * (Case IH Steiger/Quadtrac, New Holland T9, Fendt 1000/1100 MT,
 * Versatile 4WD) across a network of dealer hubs.
 *
 * Tracks per-unit location, movement (factory shipments, dealer transfers),
 * valuation (depreciation + market index), floor-plan interest exposure,
 * aging, sales, and derives network risk metrics.
 *
 * UMD-ish wrapper so the same file runs in the browser (window.Twin)
 * and under Node for tests (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.Twin = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MS_DAY = 86400000;
  const WARMUP_DAYS = 150;        // history simulated before "today"
  const FLOOR_PLAN_APR = 0.079;   // floor plan annual rate
  const INTEREST_FREE_DAYS = 120; // interest-free flooring period

  // ------------------------------------------------------------------
  // Deterministic PRNG so every load shows the same believable world.
  // ------------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------
  // Network of dealer hubs (plus the Waterloo factory).
  // demand: relative sales velocity weight for the region around the hub.
  // ------------------------------------------------------------------
  const HUBS = [
    { id: "waterloo",     name: "Waterloo Works, IA (Factory)", lat: 42.49,  lon: -92.34,  region: "North America", demand: 0,   factory: true },
    { id: "fargo",        name: "Fargo, ND",                    lat: 46.88,  lon: -96.79,  region: "North America", demand: 1.4 },
    { id: "regina",       name: "Regina, SK",                   lat: 50.45,  lon: -104.62, region: "North America", demand: 1.2 },
    { id: "omaha",        name: "Omaha, NE",                    lat: 41.26,  lon: -95.93,  region: "North America", demand: 1.1 },
    { id: "wichita",      name: "Wichita, KS",                  lat: 37.69,  lon: -97.34,  region: "North America", demand: 1.0 },
    { id: "lubbock",      name: "Lubbock, TX",                  lat: 33.58,  lon: -101.86, region: "North America", demand: 0.9 },
    { id: "edmonton",     name: "Edmonton, AB",                 lat: 53.55,  lon: -113.49, region: "North America", demand: 0.8 },
    { id: "sorriso",      name: "Sorriso, MT (Brazil)",         lat: -12.55, lon: -55.72,  region: "South America", demand: 1.3 },
    { id: "londrina",     name: "Londrina, PR (Brazil)",        lat: -23.30, lon: -51.17,  region: "South America", demand: 0.9 },
    { id: "rosario",      name: "Rosario (Argentina)",          lat: -32.95, lon: -60.66,  region: "South America", demand: 0.8 },
    { id: "orleans",      name: "Orléans (France)",             lat: 47.90,  lon: 1.90,    region: "Europe",        demand: 0.7 },
    { id: "magdeburg",    name: "Magdeburg (Germany)",          lat: 52.13,  lon: 11.63,   region: "Europe",        demand: 0.8 },
    { id: "warsaw",       name: "Warsaw (Poland)",              lat: 52.23,  lon: 21.01,   region: "Europe",        demand: 0.7 },
    { id: "astana",       name: "Astana (Kazakhstan)",          lat: 51.17,  lon: 71.45,   region: "Central Asia",  demand: 0.6 },
    { id: "dubbo",        name: "Dubbo, NSW (Australia)",       lat: -32.25, lon: 148.60,  region: "Australia",     demand: 0.9 },
    { id: "perth",        name: "Perth, WA (Australia)",        lat: -31.95, lon: 115.86,  region: "Australia",     demand: 0.8 },
    { id: "bloemfontein", name: "Bloemfontein (South Africa)",  lat: -29.12, lon: 26.21,   region: "Africa",        demand: 0.5 },
  ];

  const HUB_BY_ID = {};
  HUBS.forEach(function (h) { HUB_BY_ID[h.id] = h; });

  const REGIONS = Array.from(new Set(HUBS.map(function (h) { return h.region; })));

  // ------------------------------------------------------------------
  // Model catalog: Deere 9R family + competitor HP equivalents.
  // msrp values are representative list prices (USD).
  // ------------------------------------------------------------------
  const MODELS = [
    // John Deere 9R (wheeled)
    { brand: "John Deere", model: "9R 390",        hp: 390, msrp: 562000 },
    { brand: "John Deere", model: "9R 440",        hp: 440, msrp: 627000 },
    { brand: "John Deere", model: "9R 490",        hp: 490, msrp: 688000 },
    { brand: "John Deere", model: "9R 540",        hp: 540, msrp: 742000 },
    { brand: "John Deere", model: "9R 590",        hp: 590, msrp: 801000 },
    { brand: "John Deere", model: "9R 640",        hp: 640, msrp: 858000 },
    // John Deere 9RX (four-track)
    { brand: "John Deere", model: "9RX 490",       hp: 490, msrp: 770000 },
    { brand: "John Deere", model: "9RX 540",       hp: 540, msrp: 824000 },
    { brand: "John Deere", model: "9RX 590",       hp: 590, msrp: 887000 },
    { brand: "John Deere", model: "9RX 640",       hp: 640, msrp: 952000 },
    { brand: "John Deere", model: "9RX 710",       hp: 710, msrp: 1048000 },
    { brand: "John Deere", model: "9RX 770",       hp: 770, msrp: 1117000 },
    { brand: "John Deere", model: "9RX 830",       hp: 830, msrp: 1189000 },
    // John Deere 9RT (two-track)
    { brand: "John Deere", model: "9RT 470",       hp: 470, msrp: 712000 },
    { brand: "John Deere", model: "9RT 520",       hp: 520, msrp: 769000 },
    { brand: "John Deere", model: "9RT 570",       hp: 570, msrp: 833000 },
    // Case IH
    { brand: "Case IH", model: "Steiger 420",      hp: 420, msrp: 545000 },
    { brand: "Case IH", model: "Steiger 470",      hp: 470, msrp: 608000 },
    { brand: "Case IH", model: "Steiger 525",      hp: 525, msrp: 671000 },
    { brand: "Case IH", model: "Steiger 580",      hp: 580, msrp: 734000 },
    { brand: "Case IH", model: "Steiger 645",      hp: 645, msrp: 812000 },
    { brand: "Case IH", model: "Quadtrac 525",     hp: 525, msrp: 793000 },
    { brand: "Case IH", model: "Quadtrac 645",     hp: 645, msrp: 948000 },
    { brand: "Case IH", model: "Quadtrac 715",     hp: 715, msrp: 1054000 },
    // New Holland
    { brand: "New Holland", model: "T9.435",       hp: 435, msrp: 528000 },
    { brand: "New Holland", model: "T9.480",       hp: 480, msrp: 571000 },
    { brand: "New Holland", model: "T9.530",       hp: 530, msrp: 624000 },
    { brand: "New Holland", model: "T9.580",       hp: 580, msrp: 678000 },
    { brand: "New Holland", model: "T9.645",       hp: 645, msrp: 742000 },
    { brand: "New Holland", model: "T9.700",       hp: 700, msrp: 818000 },
    // Fendt
    { brand: "Fendt", model: "1038 Vario",         hp: 380, msrp: 528000 },
    { brand: "Fendt", model: "1042 Vario",         hp: 415, msrp: 566000 },
    { brand: "Fendt", model: "1046 Vario",         hp: 476, msrp: 619000 },
    { brand: "Fendt", model: "1050 Vario",         hp: 517, msrp: 689000 },
    { brand: "Fendt", model: "1162 Vario MT",      hp: 618, msrp: 962000 },
    { brand: "Fendt", model: "1167 Vario MT",      hp: 673, msrp: 1021000 },
    // Versatile
    { brand: "Versatile", model: "Versatile 530",  hp: 530, msrp: 462000 },
    { brand: "Versatile", model: "Versatile 580",  hp: 580, msrp: 503000 },
    { brand: "Versatile", model: "Versatile 620",  hp: 620, msrp: 547000 },
  ];

  const BRANDS = ["John Deere", "Case IH", "New Holland", "Fendt", "Versatile"];
  const BRAND_COLORS = {
    "John Deere":  "#3fa535",
    "Case IH":     "#d7263d",
    "New Holland": "#2d9cdb",
    "Fendt":       "#f2a900",
    "Versatile":   "#b86bff",
  };
  // Share of the high-HP 4WD market used when seeding/spawning units.
  const BRAND_WEIGHTS = { "John Deere": 0.55, "Case IH": 0.17, "New Holland": 0.12, "Fendt": 0.10, "Versatile": 0.06 };

  const BANDS = [
    { id: "350–449 hp", min: 350, max: 449 },
    { id: "450–549 hp", min: 450, max: 549 },
    { id: "550–649 hp", min: 550, max: 649 },
    { id: "650+ hp",         min: 650, max: 99999 },
  ];

  // network stock targets that adaptive production steers toward
  const DEMAND_SUM = HUBS.reduce(function (s, h) { return s + h.demand; }, 0);
  const TARGET_DEERE = Math.round(DEMAND_SUM * 12);
  const TARGET_COMP = Math.round(DEMAND_SUM * 9);

  function bandOf(hp) {
    for (let i = 0; i < BANDS.length; i++) {
      if (hp >= BANDS[i].min && hp <= BANDS[i].max) return BANDS[i].id;
    }
    return BANDS[BANDS.length - 1].id;
  }

  const MODELS_BY_BRAND = {};
  BRANDS.forEach(function (b) {
    MODELS_BY_BRAND[b] = MODELS.filter(function (m) { return m.brand === b; });
  });

  // ------------------------------------------------------------------
  // Small math helpers
  // ------------------------------------------------------------------
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function haversineKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

  function weightedPick(rand, items, weightFn) {
    let total = 0;
    const w = items.map(function (it) { const v = Math.max(0, weightFn(it)); total += v; return v; });
    if (total <= 0) return pick(rand, items);
    let r = rand() * total;
    for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  }

  function poisson(rand, lambda) {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  }

  function pickBrand(rand) {
    let r = rand(), acc = 0;
    for (let i = 0; i < BRANDS.length; i++) {
      acc += BRAND_WEIGHTS[BRANDS[i]];
      if (r <= acc) return BRANDS[i];
    }
    return BRANDS[0];
  }

  // Seasonal demand: peaks pre-planting (N hemisphere ~March, S ~October).
  function seasonal(hub, day) {
    const doy = day % 365;
    const peak = hub.lat >= 0 ? 80 : 270;
    return 1 + 0.3 * Math.cos(((doy - peak) / 365) * 2 * Math.PI);
  }

  // ------------------------------------------------------------------
  // Units
  // ------------------------------------------------------------------
  function makeUnit(sim, brand, model, hubId, invDays, status) {
    const invoice = Math.round(model.msrp * (0.87 + sim.rand() * 0.06));
    const u = {
      id: "U" + (sim.nextId++),
      brand: brand,
      model: model.model,
      hp: model.hp,
      band: bandOf(model.hp),
      msrp: model.msrp,
      invoice: invoice,
      hub: hubId,
      status: status || "in_stock", // in_stock | in_transit
      invDays: invDays || 0,        // days sitting in dealer inventory
      interest: 0,                  // accrued floor-plan interest ($)
      transit: null,                // {from, to, daysTotal, daysDone}
      value: invoice,
    };
    u.value = computeValue(sim, u);
    return u;
  }

  function computeValue(sim, u) {
    const hub = HUB_BY_ID[u.transit ? u.transit.to : u.hub];
    const regionIdx = sim.market.regions[hub.region] || 1;
    const dep = Math.max(0.55, 1 - 0.0007 * u.invDays);
    return Math.round(u.invoice * dep * sim.market.global * regionIdx);
  }

  function startTransit(sim, u, fromId, toId) {
    const from = HUB_BY_ID[fromId], to = HUB_BY_ID[toId];
    const km = haversineKm(from, to);
    let days = Math.max(2, Math.round(km / 700));
    if (from.region !== to.region) days += 10; // port handling / ocean leg
    u.status = "in_transit";
    u.hub = fromId;
    u.transit = { from: fromId, to: toId, daysTotal: days, daysDone: 0 };
  }

  // ------------------------------------------------------------------
  // Queries / selectors
  // ------------------------------------------------------------------
  function matchesFilters(u, filters) {
    if (!filters) return true;
    if (filters.brand && filters.brand !== "All" && u.brand !== filters.brand) return false;
    if (filters.band && filters.band !== "All" && u.band !== filters.band) return false;
    if (filters.region && filters.region !== "All") {
      const hub = HUB_BY_ID[u.transit ? u.transit.to : u.hub];
      if (hub.region !== filters.region) return false;
    }
    return true;
  }

  function unitsInStock(sim, filters) {
    return sim.fleet.filter(function (u) { return u.status === "in_stock" && matchesFilters(u, filters); });
  }

  function unitsInTransit(sim, filters) {
    return sim.fleet.filter(function (u) { return u.status === "in_transit" && matchesFilters(u, filters); });
  }

  function hubStock(sim, hubId) {
    return sim.fleet.filter(function (u) { return u.status === "in_stock" && u.hub === hubId; });
  }

  // Trailing-90-day Deere sales rate -> days of supply at a hub.
  function daysSupply(sim, hubId) {
    const since = sim.day - 90;
    let sold = 0;
    for (let i = sim.sales.length - 1; i >= 0; i--) {
      const s = sim.sales[i];
      if (s.day < since) break;
      if (s.hub === hubId && s.brand === "John Deere") sold++;
    }
    const stock = sim.fleet.reduce(function (n, u) {
      return n + (u.status === "in_stock" && u.hub === hubId && u.brand === "John Deere" ? 1 : 0);
    }, 0);
    if (sold === 0) return stock > 0 ? 400 : 0;
    return Math.min(400, Math.round(stock / (sold / 90)));
  }

  function pushEvent(sim, type, text) {
    sim.events.push({ day: sim.day, type: type, text: text });
    if (sim.events.length > 80) sim.events.splice(0, sim.events.length - 80);
  }

  // ------------------------------------------------------------------
  // Risk / alerts
  // ------------------------------------------------------------------
  function computeRisk(sim) {
    const deere = sim.fleet.filter(function (u) { return u.status === "in_stock" && u.brand === "John Deere"; });
    const stockN = deere.length || 1;
    const aged180 = deere.filter(function (u) { return u.invDays > 180; }).length;
    const share180 = aged180 / stockN;

    let dsSum = 0, dsN = 0;
    HUBS.forEach(function (h) {
      if (h.factory) return;
      const ds = daysSupply(sim, h.id);
      if (ds > 0) { dsSum += ds; dsN++; }
    });
    const avgDS = dsN ? dsSum / dsN : 0;

    const totalValue = deere.reduce(function (s, u) { return s + u.value; }, 0) || 1;
    const exposure = deere.reduce(function (s, u) { return s + u.interest; }, 0);
    const expRatio = exposure / totalValue;

    const score = clamp(Math.round(
      38 * Math.min(1, share180 * 4) +
      34 * Math.min(1, avgDS / 300) +
      28 * Math.min(1, expRatio * 40)
    ), 0, 100);

    return { score: score, share180: share180, aged180: aged180, avgDS: avgDS, exposure: exposure, totalValue: totalValue };
  }

  function computeAlerts(sim) {
    const alerts = [];
    HUBS.forEach(function (h) {
      if (h.factory) return;
      const stock = hubStock(sim, h.id);
      const deereN = stock.filter(function (u) { return u.brand === "John Deere"; }).length;
      const ds = daysSupply(sim, h.id);
      if (ds > 200 && deereN >= 8) {
        alerts.push({ severity: "high", text: h.name + ": " + ds + " days supply (" + deereN + " Deere units) — overstocked, consider transfer or program pricing." });
      } else if (ds > 0 && ds < 30 && h.demand >= 0.9) {
        alerts.push({ severity: "med", text: h.name + ": only " + ds + " days supply — risk of lost sales, request allocation." });
      }
      const aged = stock.filter(function (u) { return u.brand === "John Deere" && u.invDays > 180; });
      if (aged.length >= 3) {
        alerts.push({ severity: "high", text: h.name + ": " + aged.length + " Deere units aged 180+ days accruing floor-plan interest." });
      }
    });
    REGIONS.forEach(function (r) {
      const idx = sim.market.regions[r];
      if (idx < 0.955) alerts.push({ severity: "med", text: r + " market index at " + idx.toFixed(3) + " — soft used/new values, expect valuation pressure." });
    });
    return alerts.slice(0, 8);
  }

  // ------------------------------------------------------------------
  // Daily tick
  // ------------------------------------------------------------------
  function tick(sim) {
    sim.day++;
    const rand = sim.rand;

    // 1. market random walk (global + per region)
    sim.market.global = clamp(sim.market.global + (rand() - 0.5) * 0.003, 0.94, 1.06);
    REGIONS.forEach(function (r) {
      sim.market.regions[r] = clamp(sim.market.regions[r] + (rand() - 0.5) * 0.004, 0.92, 1.08);
    });

    // 2. advance transits
    sim.fleet.forEach(function (u) {
      if (u.status !== "in_transit") return;
      u.transit.daysDone++;
      if (u.transit.daysDone >= u.transit.daysTotal) {
        u.hub = u.transit.to;
        u.status = "in_stock";
        u.invDays = 0;
        u.transit = null;
        pushEvent(sim, "arrival", u.brand + " " + u.model + " arrived at " + HUB_BY_ID[u.hub].name);
      }
    });

    const dealerHubs = HUBS.filter(function (h) { return !h.factory; });

    // network-level stock counts drive adaptive production so the world
    // self-regulates instead of flooding or draining
    const deereStockN = sim.fleet.filter(function (u) { return u.brand === "John Deere"; }).length;
    const compStockN = sim.fleet.length - deereStockN;

    // 3. factory production -> ship Deere units to needy hubs
    const built = poisson(rand, 1.5 * clamp(TARGET_DEERE / Math.max(1, deereStockN), 0.25, 2.0));
    for (let i = 0; i < built; i++) {
      const model = pick(rand, MODELS_BY_BRAND["John Deere"]);
      const dest = weightedPick(rand, dealerHubs, function (h) {
        const stock = hubStock(sim, h.id).filter(function (u) { return u.brand === "John Deere"; }).length;
        return Math.max(0.1, h.demand * seasonal(h, sim.day) * 14 - stock);
      });
      const u = makeUnit(sim, "John Deere", model, "waterloo", 0, "in_stock");
      startTransit(sim, u, "waterloo", dest.id);
      sim.fleet.push(u);
      pushEvent(sim, "ship", "Factory shipped " + u.model + " to " + dest.name);
    }

    // 4. competitor deliveries appear directly at hubs
    const comps = poisson(rand, 1.1 * clamp(TARGET_COMP / Math.max(1, compStockN), 0.25, 2.0));
    for (let i = 0; i < comps; i++) {
      let brand = pickBrand(rand);
      if (brand === "John Deere") brand = pick(rand, BRANDS.slice(1));
      const model = pick(rand, MODELS_BY_BRAND[brand]);
      const hub = weightedPick(rand, dealerHubs, function (h) { return h.demand; });
      sim.fleet.push(makeUnit(sim, brand, model, hub.id, 0, "in_stock"));
      pushEvent(sim, "competitor", brand + " " + model.model + " delivered to competing dealer near " + hub.name);
    }

    // 5. rebalancing transfers between hubs
    if (rand() < 0.25) {
      const over = dealerHubs.filter(function (h) { return daysSupply(sim, h.id) > 180; });
      const under = dealerHubs.filter(function (h) { const ds = daysSupply(sim, h.id); return ds > 0 && ds < 70; });
      if (over.length && under.length) {
        const from = pick(rand, over), to = pick(rand, under);
        const candidates = hubStock(sim, from.id).filter(function (u) { return u.brand === "John Deere"; });
        if (candidates.length && from.id !== to.id) {
          const u = pick(rand, candidates);
          startTransit(sim, u, from.id, to.id);
          pushEvent(sim, "transfer", "Transfer: " + u.model + " " + from.name + " → " + to.name);
        }
      }
    }

    // 6. retail sales
    dealerHubs.forEach(function (h) {
      const stock = hubStock(sim, h.id);
      if (!stock.length) return;
      const lambda = 0.16 * h.demand * (sim.demandScale || 1) * seasonal(h, sim.day) * (1 - Math.exp(-stock.length / 8));
      let n = Math.min(poisson(rand, lambda), stock.length);
      while (n-- > 0) {
        // bias sales toward older units (dealers push aged stock)
        const sorted = stock.filter(function (u) { return u.status === "in_stock"; })
          .sort(function (a, b) { return b.invDays - a.invDays; });
        if (!sorted.length) break;
        const u = sorted[Math.floor(Math.pow(rand(), 2) * sorted.length)];
        // retail realizes a markup over book value; aged/soft-market units
        // can still clear below invoice once depreciation eats the markup
        const price = Math.round(u.value * (1.04 + rand() * 0.10));
        sim.sales.push({ day: sim.day, hub: h.id, brand: u.brand, model: u.model, price: price, invDays: u.invDays, margin: price - u.invoice - Math.round(u.interest) });
        sim.fleet.splice(sim.fleet.indexOf(u), 1);
        pushEvent(sim, "sale", u.brand + " " + u.model + " sold at " + h.name + " for $" + (price / 1000).toFixed(0) + "k");
      }
    });
    if (sim.sales.length > 1200) sim.sales.splice(0, sim.sales.length - 1200);

    // 7. aging, interest accrual, revaluation
    sim.fleet.forEach(function (u) {
      if (u.status !== "in_stock") return;
      u.invDays++;
      if (u.invDays > INTEREST_FREE_DAYS) {
        u.interest += u.invoice * FLOOR_PLAN_APR / 365;
      }
      u.value = computeValue(sim, u);
    });

    // 8. history + risk
    const risk = computeRisk(sim);
    const inStock = sim.fleet.filter(function (u) { return u.status === "in_stock"; });
    const inTransit = sim.fleet.length - inStock.length;
    const valueAll = inStock.reduce(function (s, u) { return s + u.value; }, 0);
    sim.risk = risk;
    sim.alerts = computeAlerts(sim);
    sim.history.push({
      day: sim.day,
      valueDeere: risk.totalValue,
      valueAll: valueAll,
      exposure: risk.exposure,
      stock: inStock.length,
      transit: inTransit,
      riskScore: risk.score,
    });
    if (sim.history.length > 730) sim.history.splice(0, sim.history.length - 730);
  }

  // ------------------------------------------------------------------
  // World creation
  // ------------------------------------------------------------------
  function createSim(seed) {
    const sim = {
      rand: mulberry32(seed || 9),
      nextId: 1,
      day: 0,
      epoch: Date.now() - WARMUP_DAYS * MS_DAY, // sim day 0 maps to this date
      fleet: [],
      sales: [],
      events: [],
      alerts: [],
      history: [],
      market: { global: 1.0, regions: {} },
      risk: null,
      demandScale: 1, // forecast-driven demand multiplier (Forecast outlook)
    };
    REGIONS.forEach(function (r) { sim.market.regions[r] = 1.0; });

    // seed initial inventory at each dealer hub
    HUBS.forEach(function (h) {
      if (h.factory) return;
      const target = Math.round(6 + h.demand * 14 + sim.rand() * 6);
      for (let i = 0; i < target; i++) {
        const brand = pickBrand(sim.rand);
        const model = pick(sim.rand, MODELS_BY_BRAND[brand]);
        const invDays = Math.floor(Math.pow(sim.rand(), 1.6) * 240);
        const u = makeUnit(sim, brand, model, h.id, invDays, "in_stock");
        // back-fill interest for units already past the free period
        if (invDays > INTEREST_FREE_DAYS) {
          u.interest = u.invoice * FLOOR_PLAN_APR / 365 * (invDays - INTEREST_FREE_DAYS);
        }
        sim.fleet.push(u);
      }
    });

    // warm up: build believable history, sales rates and in-flight transits
    for (let d = 0; d < WARMUP_DAYS; d++) tick(sim);
    return sim;
  }

  function simDate(sim, day) {
    return new Date(sim.epoch + (day === undefined ? sim.day : day) * MS_DAY);
  }

  function setDemandScale(sim, s) {
    sim.demandScale = clamp(s, 0.5, 1.6);
  }

  return {
    createSim: createSim,
    tick: tick,
    setDemandScale: setDemandScale,
    simDate: simDate,
    matchesFilters: matchesFilters,
    unitsInStock: unitsInStock,
    unitsInTransit: unitsInTransit,
    hubStock: hubStock,
    daysSupply: daysSupply,
    HUBS: HUBS,
    HUB_BY_ID: HUB_BY_ID,
    REGIONS: REGIONS,
    MODELS: MODELS,
    BRANDS: BRANDS,
    BRAND_COLORS: BRAND_COLORS,
    BANDS: BANDS,
    FLOOR_PLAN_APR: FLOOR_PLAN_APR,
    INTEREST_FREE_DAYS: INTEREST_FREE_DAYS,
  };
});
