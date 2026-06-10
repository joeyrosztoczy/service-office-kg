/* Tests for the forecasting engine. Run: node test/forecast.test.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Forecast = require("../js/forecast.js");

// ---- 1. linear solver -----------------------------------------------------
{
  const x = Forecast.solve(
    [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]],
    [8, -11, -3]
  );
  assert.ok(Math.abs(x[0] - 2) < 1e-9 && Math.abs(x[1] - 3) < 1e-9 && Math.abs(x[2] - (-1)) < 1e-9,
    "gaussian elimination solves known system, got " + x);
}

// ---- synthetic world: quarterly target driven by a macro signal ------------
function syntheticData(n) {
  const seasonal = [0.8, 1.15, 1.0, 1.05];
  const macroObs = [];
  const target = [];
  let date = "2008-03-31";
  const mdate = (q, m) => Forecast.helpers.addMonths("2007-01-01", q * 3 + m);
  // monthly macro: slow sine wave
  for (let m = 0; m < n * 3 + 24; m++) {
    macroObs.push({ date: Forecast.helpers.addMonths("2006-01-01", m), value: 100 + 25 * Math.sin(m / 9) });
  }
  // target growth follows macro YoY with a lag, plus seasonality
  let level = 100;
  for (let q = 0; q < n; q++) {
    const asOf = date;
    const g = Forecast.helpers.yoy(macroObs, asOf) || 0;
    level *= Math.exp(g * 0.25 + 0.005);
    target.push({ date: date, value: level * seasonal[q % 4] });
    date = Forecast.helpers.addMonths(date, 3);
  }
  return { target, macros: { CORN: { obs: macroObs } } };
}

// ---- 2. no lookahead: future values must not change past predictions -------
{
  const { target, macros } = syntheticData(40);
  const wf1 = Forecast.walkForward(target, macros, { minTrain: 12 });
  const mutated = target.map((t) => ({ ...t }));
  mutated[mutated.length - 1].value *= 1.7; // corrupt only the final quarter
  const wf2 = Forecast.walkForward(mutated, macros, { minTrain: 12 });
  for (let i = 0; i < wf1.points.length - 1; i++) {
    assert.strictEqual(wf1.points[i].model, wf2.points[i].model,
      "prediction at " + wf1.points[i].date + " changed when future data changed — lookahead!");
  }
}

// ---- 3. model learns the macro link on synthetic data ----------------------
{
  const { target, macros } = syntheticData(48);
  const wf = Forecast.walkForward(target, macros, { minTrain: 12 });
  assert.ok(wf.points.length >= 20, "enough test points: " + wf.points.length);
  const mEns = Forecast.metrics(wf.points, "ensemble");
  const mSeas = Forecast.metrics(wf.points, "seasonalNaive");
  assert.ok(mEns.mape < 0.05, "ensemble accurate on learnable synthetic, MAPE " + mEns.mape);
  assert.ok(mEns.mape < mSeas.mape, "ensemble beats seasonal naive (" + mEns.mape + " vs " + mSeas.mape + ")");

  const sd = Forecast.residualStd(wf.points);
  const fc = Forecast.forecast(target, macros, 4, sd);
  assert.strictEqual(fc.length, 4, "4-step forecast produced");
  fc.forEach((f) => {
    assert.ok(Number.isFinite(f.pred) && f.pred > 0, "finite positive forecast");
    assert.ok(f.lo < f.pred && f.pred < f.hi, "interval brackets point forecast");
  });
}

// ---- 4. real cached data smoke test (when cache present) -------------------
const cache = path.join(__dirname, "..", "data", "external", "external-data.json");
if (fs.existsSync(cache)) {
  const ext = JSON.parse(fs.readFileSync(cache, "utf8"));
  for (const key of ["DE_REV", "TITN_INV"]) {
    const wf = Forecast.walkForward(ext.edgar[key].obs, ext.fred, { minTrain: 12 });
    const mEns = Forecast.metrics(wf.points, "ensemble");
    const mSeas = Forecast.metrics(wf.points, "seasonalNaive");
    assert.ok(Number.isFinite(mEns.mape) && mEns.mape < 0.2, key + " ensemble MAPE sane: " + mEns.mape);
    assert.ok(mEns.mape < mSeas.mape, key + " ensemble beats seasonal naive");
  }
  console.log("real-data smoke test included");
}

console.log("forecast tests OK");
