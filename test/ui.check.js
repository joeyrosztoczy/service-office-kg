/* Headless UI smoke test: loads the dashboard, fails on console/page errors,
 * asserts core widgets rendered, saves docs/screenshot.png.
 * Run: PLAYWRIGHT_BROWSERS_PATH=<path> node test/ui.check.js <url>
 */
const { chromium } = require("playwright");

(async () => {
  const url = process.argv[2] || "http://localhost:8080";
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(3500); // let a few sim days tick + map topo load

  const checks = await page.evaluate(() => ({
    kpiStock: document.querySelector("#kpi-stock").textContent,
    kpiValue: document.querySelector("#kpi-value").textContent,
    riskScore: document.querySelector("#risk-score").textContent,
    hubs: document.querySelectorAll("#map g.hub").length,
    arcs: document.querySelectorAll("#map path.arc").length,
    countries: document.querySelectorAll("#map .countries path").length,
    bandBars: document.querySelectorAll("#chart-bands rect").length,
    valuationPaths: document.querySelectorAll("#chart-valuation path").length,
    feedItems: document.querySelectorAll("#feed-list li").length,
    alertItems: document.querySelectorAll("#alerts-list li").length,
    regionRows: document.querySelectorAll("#region-table tr").length,
    bannerShown: getComputedStyle(document.getElementById("offline-banner")).display !== "none",
  }));

  console.log(JSON.stringify(checks, null, 2));

  const fs = require("fs");
  fs.mkdirSync("docs", { recursive: true });
  await page.screenshot({ path: "docs/screenshot.png", fullPage: true });
  await browser.close();

  const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
  if (errors.length) fail("console errors:\n" + errors.join("\n"));
  if (checks.bannerShown) fail("offline banner visible — CDN libs did not load");
  if (!(parseInt(checks.kpiStock) > 0)) fail("KPI stock not populated");
  if (checks.hubs < 15) fail("hubs missing on map");
  if (checks.bandBars < 4) fail("band chart empty");
  if (checks.feedItems < 5) fail("feed empty");
  if (checks.regionRows < 5) fail("region table empty");
  if (!/^\d+$/.test(checks.riskScore)) fail("risk score not rendered");
  console.log("UI OK");
})().catch((e) => { console.error(e); process.exit(1); });
