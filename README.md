# 9R Global Digital Twin

An animated, living dashboard that models the worldwide inventory of **John Deere 9R-series tractors** (9R wheeled, 9RX four-track, 9RT two-track) alongside their **competitor horsepower equivalents** — Case IH Steiger/Quadtrac, New Holland T9, Fendt 1000/1100 Vario MT, and Versatile 4WD — so a Deere dealership can watch inventory levels, movement, and valuation evolve and manage floor-plan risk.

![dashboard](docs/screenshot.png)

## What it does

- **Animated world map** — pulsing dots at 16 dealer hubs across 6 regions, sized by units in stock and colored by Deere vs. competitor majority. Animated arcs show every unit in transit: factory shipments out of Waterloo Works and dealer-to-dealer rebalancing transfers, each with a dot moving along the arc in sync with the simulation clock.
- **Inventory levels** — KPI cards (units in stock / in transit, inventory value, floor-plan interest accrued, 180+ day units, average days in inventory) plus a stacked **HP-band chart** comparing Deere against each competitor brand in the 350–449, 450–549, 550–649 and 650+ hp classes.
- **Movement** — a live feed of factory shipments, arrivals, transfers, competitor deliveries and retail sales.
- **Valuation** — every unit carries invoice, depreciation by days-in-inventory, and a drifting global + regional market index; the trend chart tracks total Deere stock value against accrued floor-plan interest over the trailing year.
- **Risk management** — a 0–100 network risk score blending aged-inventory share, days-of-supply, and interest-exposure ratio; an alert list (overstocked hubs, thin allocation, aged units, soft regional markets); and a regional position table with days-supply and market-index flags.
- **Simulation controls** — play/pause, 0.5–5 simulated days per second, and filters by brand, region, and HP band.

## Run it

No build step, no dependencies to install:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

or just open `index.html` in a browser (D3 and the world map load from a CDN, so you need to be online).

## How it works

| File | Role |
|---|---|
| `js/data.js` | The twin itself: hub network, model catalog with representative MSRPs, deterministic daily simulation (production, shipments, transfers, sales, depreciation, floor-plan interest, market drift), and risk/alert derivation. Runs in the browser and under Node. |
| `js/map.js` | D3 world map: pulsing hub inventory dots, animated transit arcs, hover tooltips with per-hub stock, value, days-supply and aging. |
| `js/charts.js` | HP-band stacked bars, valuation/exposure trend, aging buckets. |
| `js/main.js` | Simulation clock (1 tick = 1 simulated day), filters, KPIs, risk panel, feed, regional table. |
| `test/sim.test.js` | Invariant tests — run `node test/sim.test.js`. |

The world is **synthetic but self-regulating**: factory output and competitor deliveries adapt to network stock levels, sales follow regional demand with hemispheric seasonality (pre-planting peaks), and dealers push aged stock first. A fixed PRNG seed makes every load reproducible; change the seed in `js/main.js` (`Twin.createSim(9)`) for a different world.

### Key modeling assumptions (tune in `js/data.js`)

- Floor plan: 7.9% APR after a 120-day interest-free period.
- Depreciation: ~0.07%/day of invoice, floored at 55%, scaled by market indices.
- Transit: ~700 km/day overland, +10 days for inter-region (ocean) legs.
- Days supply: trailing 90-day Deere sales rate per hub, capped at 400.

## Going live

This ships with simulated data on purpose — swap the generator for real feeds without touching the UI:

1. Replace `createSim`/`tick` in `js/data.js` with fetches of your DMS / John Deere Operations Center inventory exports.
2. Feed real valuations from auction comps or guide books into `computeValue`.
3. Point movement events at your transport-management or allocation data.

## Historical playback

```bash
node scripts/replay.js   # replays ~2.5 years, prints a quarterly digest
# then open docs/replay.html (served over http) for the playback charts
```

Writes `docs/replay-data.json` and reports stock/value/exposure/risk trajectories, sales seasonality, Deere vs competitor share, and realized margin by inventory age at sale.

## Tests

```bash
node test/sim.test.js
```

Runs the twin for ~2.5 simulated years and asserts fleet self-regulation, valuation sanity, transit bookkeeping, filter correctness, and bounded risk scores.

---

*Synthetic data for planning and demo purposes — not actual John Deere inventory or pricing.*
