/* Invariant tests for the digital twin simulation core. Run: node test/sim.test.js */
const assert = require("assert");
const Twin = require("../js/data.js");

const sim = Twin.createSim(9);

// warmup should have produced history and a populated world
assert.ok(sim.history.length >= 140, "history built during warmup");
assert.ok(sim.fleet.length > 200, "fleet populated, got " + sim.fleet.length);
assert.ok(sim.sales.length > 50, "sales occurred during warmup, got " + sim.sales.length);

// run two more simulated years
for (let i = 0; i < 730; i++) Twin.tick(sim);

let stock = 0, transit = 0;
for (const u of sim.fleet) {
  assert.ok(u.status === "in_stock" || u.status === "in_transit", "valid status: " + u.status);
  assert.ok(Number.isFinite(u.value) && u.value > 100000, "sane value for " + u.model + ": " + u.value);
  assert.ok(Number.isFinite(u.interest) && u.interest >= 0, "sane interest");
  assert.ok(Twin.HUB_BY_ID[u.hub], "unit at known hub");
  if (u.status === "in_transit") {
    transit++;
    assert.ok(u.transit && u.transit.daysDone <= u.transit.daysTotal, "transit progress bounded");
    assert.ok(Twin.HUB_BY_ID[u.transit.to], "transit destination known");
  } else {
    stock++;
    assert.strictEqual(u.transit, null);
  }
  assert.ok(["John Deere", "Case IH", "New Holland", "Fendt", "Versatile"].includes(u.brand));
}
assert.ok(stock > 100, "world still has stock after 2y, got " + stock);
assert.ok(sim.fleet.length >= 200 && sim.fleet.length <= 900,
  "fleet self-regulates (200–900), got " + sim.fleet.length);

const last = sim.history[sim.history.length - 1];
for (const k of ["valueDeere", "valueAll", "exposure", "stock", "transit", "riskScore"]) {
  assert.ok(Number.isFinite(last[k]), "history field finite: " + k);
}
assert.ok(last.riskScore >= 0 && last.riskScore <= 100, "risk score in range");
assert.strictEqual(last.stock, stock, "history stock matches fleet");
assert.strictEqual(last.transit, transit, "history transit matches fleet");

// filters
const deere = Twin.unitsInStock(sim, { brand: "John Deere" });
assert.ok(deere.every(u => u.brand === "John Deere"));
const na = Twin.unitsInStock(sim, { region: "North America" });
assert.ok(na.every(u => Twin.HUB_BY_ID[u.hub].region === "North America"));
const band = Twin.unitsInStock(sim, { band: Twin.BANDS[1].id });
assert.ok(band.every(u => u.band === Twin.BANDS[1].id));

// days supply sane for every hub
for (const h of Twin.HUBS) {
  if (h.factory) continue;
  const ds = Twin.daysSupply(sim, h.id);
  assert.ok(Number.isFinite(ds) && ds >= 0 && ds <= 400, "days supply sane at " + h.id + ": " + ds);
}

// market indices bounded
assert.ok(sim.market.global >= 0.94 && sim.market.global <= 1.06);
for (const r of Twin.REGIONS) {
  assert.ok(sim.market.regions[r] >= 0.92 && sim.market.regions[r] <= 1.08);
}

assert.ok(sim.alerts.length >= 0 && sim.events.length > 0 && sim.events.length <= 80);

console.log("OK — day", sim.day,
  "| fleet", sim.fleet.length, "(stock " + stock + ", transit " + transit + ")",
  "| sales", sim.sales.length,
  "| Deere value $" + (last.valueDeere / 1e6).toFixed(1) + "M",
  "| exposure $" + (last.exposure / 1e3).toFixed(0) + "k",
  "| risk", last.riskScore);
