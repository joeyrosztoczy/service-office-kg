# Data Wishlist — blocked or paid sources, ranked by value

What each unlocks for the digital twin, where to get it, and roughly what it costs.
The forecasting layer currently runs on free SEC EDGAR + FRED data; every item below
either replaces a proxy with the real measurement or adds a capability we can't
approximate at all.

Legend: 💰 paid · 🔑 free but requires signup/credentials · 🤝 you already have access as a Deere dealer

---

## Tier 1 — replaces our weakest proxies (get these first)

- [ ] **🤝 John Deere dealer systems (DTAC / EQUIP / Dealer Path / Operations Center exports)**
  - **Unlocks:** the twin's core — *actual* unit-level inventory (serial, model, hours, location, invoice, settlement dates), allocation pipeline, and your floor-plan terms. Replaces the entire synthetic fleet with your real one.
  - **Access:** you already have it as a dealer; the work is exports/API wiring, not money.
  - **Value: highest of all.** Everything else calibrates around this.

- [ ] **💰 AEM monthly tractor retail sales reports (4WD segment, US/Canada)**
  - **Unlocks:** the *ideal forecast target* — actual monthly 4WD-tractor unit sales for the industry. Today we forecast Deere total revenue (includes pricing, mix, finance); this is the real demand series for the 9R class.
  - **Access:** AEM membership, or often available through the OEM/dealer channel — **ask your Deere territory manager first, it may be free to you**.
  - **Cost if direct:** AEM membership scales with revenue; ag-dealer associations sometimes redistribute summaries.

- [ ] **💰 EDA / Fusable (formerly Equipment Data Associates)**
  - **Unlocks:** UCC-1 filing data parsed specifically for equipment — *who financed which competitor tractor, where, when*. This is the real version of our Titan Machinery proxy: county-level competitive market share, lender mix, financed-unit volumes by brand and HP class.
  - **Access:** subscription from Fusable (EDA Ag intelligence). This is the commercial answer to "use UCC data" — they've already done the 50-state aggregation.
  - **Cost:** quoted; typically $10–30k/yr depending on geography/segments. The single most valuable *paid* dataset for competitive intelligence.

- [ ] **💰 Used-values guide: Iron Solutions (IronGuides) or Sandhills/EquipmentWatch values**
  - **Unlocks:** real depreciation curves and current wholesale/retail values by model-year-hours-configuration. Replaces our linear 0.07%/day guess in `computeValue` — directly improves the valuation and margin-at-risk numbers.
  - **Access:** Iron Solutions subscription (dealer plans exist); Sandhills sells valuation products off TractorHouse/AuctionTime data.
  - **Cost:** low thousands/yr for dealer tiers.

## Tier 2 — strong additions once Tier 1 is flowing

- [ ] **💰 Auction sold-price data: AuctionTime/Sandhills results, Machinery Pete database**
  - **Unlocks:** transaction-level realized prices for aged/high-hour units — calibrates the "what does a 180+ day unit actually clear at" loss model and gives early warning when auction values roll over (they lead retail by ~2 quarters).
  - **Cost:** Machinery Pete subscriptions are modest; Sandhills data products are quoted.

- [ ] **💰 State UCC bulk files (direct, DIY version of EDA)**
  - **Unlocks:** same signal as EDA but raw — debtor, secured party, collateral text. Only worth it if EDA pricing doesn't fit; you'd need parsing for collateral descriptions ("JOHN DEERE 9RX 640 S/N...").
  - **Access/cost:** per-state bulk purchase, ~$300–$2,000/state + ongoing; quality varies wildly by state. Start with your trade-area states only.

- [ ] **🤝/💰 Dealer 20-group benchmarks (Spader, NCM, or Deere dealer-network composites)**
  - **Unlocks:** peer days-supply, turn rates, aged-% benchmarks — turns our risk score from self-referential into "vs. peers."
  - **Access:** you likely already belong to one; it's an export problem.

- [ ] **💰 S&P Global Mobility / Off-Highway Research forecasts**
  - **Unlocks:** professional unit forecasts for high-HP tractors by region — a benchmark to ensemble with (and grade) our model.
  - **Cost:** expensive (tens of k/yr). Only worth it at multi-store scale.

## Tier 3 — free, just needs a signup (quick wins, do anytime)

- [ ] **🔑 FRED API key** — replaces our scraping of `fredgraph.csv` (which hits bot-protection) with the stable official API. Free, 5 minutes.
- [ ] **🔑 USDA NASS QuickStats API key** — county-level planted acres, cash receipts, machinery expense by state → much sharper *local* demand features than national crop prices. Free.
- [ ] **🔑 UN Comtrade API key** — actual global trade flows for high-HP tractors (HS 8701.95, >130 kW) by origin/destination country → real data behind the world-map movement arcs. Free tier available.
- [ ] **🔑 USDA WASDE / ERS farm income forecasts** — already public; needs a parser, not a key. Net-farm-income forecast is the single best annual demand predictor in ag equipment.

---

## How each plugs in

| Item | Replaces / feeds |
|---|---|
| Deere dealer systems | `js/data.js` synthetic fleet → real fleet; KPIs become actuals |
| AEM 4WD sales | New forecast target in `scripts/backtest.js` (better than DE_REV) |
| EDA/Fusable or UCC bulk | Competitor hub inventories + regional share on the map |
| IronGuides / auction data | `computeValue` depreciation + aged-unit clearing prices |
| 20-group benchmarks | Risk-score calibration (peer percentile instead of heuristic) |
| NASS / WASDE / Comtrade | Macro features in `js/forecast.js`; real movement arcs |

**Recommended order:** dealer-system exports (free, highest value) → ask Deere rep for AEM 4WD numbers → IronGuides → EDA/Fusable quote → quick-win API keys along the way.
