/*
 * forecast.js — forecasting engine over real internet data.
 *
 * Targets are quarterly series (manufacturer revenues, dealer inventory)
 * from SEC EDGAR; features are engineered from FRED macro series.
 *
 * Model: ridge regression on year-over-year log growth — the YoY transform
 * removes the strong ag-equipment seasonality and scale, the regression
 * adds macro signal (crop prices, rates, machinery PPI) plus growth
 * momentum. Lambda is chosen by time-ordered cross-validation. Backtesting
 * is strict walk-forward: every prediction for quarter t uses only data
 * dated before t.
 *
 * UMD: browser (window.Forecast) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.Forecast = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------
  // date / series helpers
  // ------------------------------------------------------------------
  function addMonths(dateStr, k) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + k);
    return d.toISOString().slice(0, 10);
  }

  function valueAsOf(obs, date) {
    for (let i = obs.length - 1; i >= 0; i--) {
      if (obs[i].date <= date) return obs[i].value;
    }
    return null;
  }

  function trailingAvg(obs, date, months) {
    const vals = [];
    for (let i = obs.length - 1; i >= 0 && vals.length < months; i--) {
      if (obs[i].date <= date) vals.push(obs[i].value);
    }
    if (vals.length < Math.min(2, months)) return null;
    return vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
  }

  // YoY log growth of a 3-month trailing average, as of `date`
  function yoy(obs, date) {
    const now = trailingAvg(obs, date, 3);
    const ago = trailingAvg(obs, addMonths(date, -12), 3);
    if (now == null || ago == null || ago <= 0 || now <= 0) return null;
    return Math.log(now / ago);
  }

  // 12-month level change (for rates)
  function delta12(obs, date) {
    const now = valueAsOf(obs, date);
    const ago = valueAsOf(obs, addMonths(date, -12));
    if (now == null || ago == null) return null;
    return now - ago;
  }

  // ------------------------------------------------------------------
  // engineered macro features (each tolerant of a missing source series)
  // ------------------------------------------------------------------
  const MACRO_DEFS = [
    { name: "corn_yoy",   key: "CORN",        fn: yoy },     // crop revenue driver
    { name: "soy_yoy",    key: "SOY",         fn: yoy },
    { name: "wheat_yoy",  key: "WHEAT",       fn: yoy },
    { name: "prime_d12",  key: "PRIME",       fn: delta12 }, // financing cost shift
    { name: "agppi_yoy",  key: "PPI_AG_MACH", fn: yoy },     // equipment price inflation
    { name: "unrate_d12", key: "UNRATE",      fn: delta12 }, // macro cycle
    { name: "ppi_yoy",    key: "PPI_ALL",     fn: yoy },     // broad input costs
  ];

  function activeMacros(macros) {
    return MACRO_DEFS.filter(function (m) {
      return macros[m.key] && macros[m.key].obs && macros[m.key].obs.length > 30;
    });
  }

  // quarterly cadence guard (filings can skip/restate quarters)
  function spanOk(target, a, b) {
    const d = (new Date(target[b].date) - new Date(target[a].date)) / 86400000;
    return d >= 330 && d <= 400;
  }

  // ------------------------------------------------------------------
  // dataset: row i predicts target[i] from info available at target[i-1].date
  // ------------------------------------------------------------------
  function buildRows(target, macros) {
    const act = activeMacros(macros);
    const rows = [];
    for (let i = 5; i < target.length; i++) {
      if (!(target[i].value > 0 && target[i - 1].value > 0 &&
            target[i - 4].value > 0 && target[i - 5].value > 0)) continue;
      if (!spanOk(target, i - 4, i) || !spanOk(target, i - 5, i - 1)) continue;
      const asOf = target[i - 1].date;
      const x = [1, Math.log(target[i - 1].value / target[i - 5].value)]; // momentum
      let ok = true;
      for (const m of act) {
        const v = m.fn(macros[m.key].obs, asOf);
        if (v == null) { ok = false; break; }
        x.push(v);
      }
      if (!ok) continue;
      rows.push({ i: i, date: target[i].date, x: x, y: Math.log(target[i].value / target[i - 4].value) });
    }
    return { rows: rows, featureNames: ["intercept", "y_lag1"].concat(act.map(function (m) { return m.name; })) };
  }

  // ------------------------------------------------------------------
  // linear algebra: Gaussian elimination with partial pivoting
  // ------------------------------------------------------------------
  function solve(A, b) {
    const n = A.length;
    const M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      if (Math.abs(M[c][c]) < 1e-12) throw new Error("singular system");
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map(function (row, i) { return row[n] / M[i][i]; });
  }

  function fitRidge(rows, lambda) {
    const n = rows.length, p = rows[0].x.length;
    const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
    for (let j = 1; j < p; j++) {
      let s = 0;
      for (const r of rows) s += r.x[j];
      mu[j] = s / n;
      let v = 0;
      for (const r of rows) v += Math.pow(r.x[j] - mu[j], 2);
      sd[j] = Math.sqrt(v / n) || 1;
    }
    const A = [], b = [];
    for (let j = 0; j < p; j++) { A.push(new Array(p).fill(0)); b.push(0); }
    for (const r of rows) {
      const z = r.x.map(function (v, j) { return j === 0 ? 1 : (v - mu[j]) / sd[j]; });
      for (let j = 0; j < p; j++) {
        b[j] += z[j] * r.y;
        for (let l = 0; l < p; l++) A[j][l] += z[j] * z[l];
      }
    }
    for (let j = 1; j < p; j++) A[j][j] += lambda;
    return { w: solve(A, b), mu: mu, sd: sd };
  }

  function predictRow(model, x) {
    let y = model.w[0];
    for (let j = 1; j < x.length; j++) y += model.w[j] * ((x[j] - model.mu[j]) / model.sd[j]);
    return y;
  }

  const LAMBDAS = [0.1, 0.5, 2, 8, 32];

  // time-ordered CV on the tail of the training window — never sees the test point
  function chooseLambda(rows, minTrain) {
    const evalN = Math.min(8, rows.length - minTrain);
    if (evalN < 3) return 8;
    let best = LAMBDAS[0], bestErr = Infinity;
    for (const lam of LAMBDAS) {
      let err = 0;
      for (let j = rows.length - evalN; j < rows.length; j++) {
        const m = fitRidge(rows.slice(0, j), lam);
        err += Math.abs(predictRow(m, rows[j].x) - rows[j].y);
      }
      if (err < bestErr) { bestErr = err; best = lam; }
    }
    return best;
  }

  // ------------------------------------------------------------------
  // walk-forward backtest
  // ------------------------------------------------------------------
  function walkForward(target, macros, opts) {
    opts = opts || {};
    const minTrain = opts.minTrain || 12;
    const built = buildRows(target, macros);
    const rows = built.rows;
    const points = [];
    for (let j = minTrain; j < rows.length; j++) {
      const train = rows.slice(0, j);
      const model = fitRidge(train, chooseLambda(train, Math.min(minTrain, 8)));
      const r = rows[j];
      const base = target[r.i - 4].value;
      const yhat = predictRow(model, r.x);
      const modelLevel = base * Math.exp(yhat);
      const growthLevel = base * Math.exp(r.x[1]);
      points.push({
        date: r.date,
        actual: target[r.i].value,
        model: modelLevel,
        seasonalNaive: base,
        growthNaive: growthLevel,
        ensemble: 0.5 * (modelLevel + growthLevel), // headline forecaster
        yActual: r.y,
        yModel: yhat,
      });
    }
    return { points: points, featureNames: built.featureNames, nRows: rows.length };
  }

  function metrics(points, key) {
    let ape = 0, ae = 0, se = 0, dir = 0;
    const n = points.length;
    for (const p of points) {
      const e = p[key] - p.actual;
      ape += Math.abs(e) / Math.abs(p.actual);
      ae += Math.abs(e);
      se += e * e;
      const g = Math.log(p[key] / p.seasonalNaive); // implied YoY growth call
      if (Math.sign(g) === Math.sign(p.yActual)) dir++;
    }
    return { mape: ape / n, mae: ae / n, rmse: Math.sqrt(se / n), dirAcc: dir / n, n: n };
  }

  // std of log-growth residuals for the given level forecaster (default: ensemble)
  function residualStd(points, levelKey) {
    const key = levelKey || "ensemble";
    const errs = points.map(function (p) { return Math.log(p[key] / p.seasonalNaive) - p.yActual; });
    const m = errs.reduce(function (s, v) { return s + v; }, 0) / errs.length;
    return Math.sqrt(errs.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / errs.length);
  }

  // ------------------------------------------------------------------
  // final forecast: recursive multi-step with 80% interval from backtest
  // residuals (macro features frozen at their latest published values)
  // ------------------------------------------------------------------
  function forecast(target, macros, h, residStdLog, opts) {
    opts = opts || {};
    const minRows = opts.minRows || 16;
    const built = buildRows(target, macros);
    if (built.rows.length < minRows) return [];
    const model = fitRidge(built.rows, chooseLambda(built.rows, 12));
    const act = activeMacros(macros);
    const ext = target.map(function (t) { return { date: t.date, value: t.value }; });
    const out = [];
    const sd = residStdLog || 0.08;
    for (let s = 1; s <= h; s++) {
      const i = ext.length;
      const asOf = ext[i - 1].date;
      const x = [1, Math.log(ext[i - 1].value / ext[i - 5].value)];
      let ok = true;
      for (const m of act) {
        const v = m.fn(macros[m.key].obs, asOf);
        if (v == null) { ok = false; break; }
        x.push(v);
      }
      if (!ok) break;
      const yhatModel = predictRow(model, x);
      const date = addMonths(ext[i - 4].date, 12); // same fiscal quarter, next year
      const base = ext[i - 4].value;
      // ensemble of regression and growth momentum, matching the backtest
      const pred = base * 0.5 * (Math.exp(yhatModel) + Math.exp(x[1]));
      const yhat = Math.log(pred / base);
      const band = sd * Math.sqrt(s) * 1.2816; // 80% interval
      out.push({ date: date, pred: pred, lo: pred * Math.exp(-band), hi: pred * Math.exp(band), yhat: yhat, step: s });
      ext.push({ date: date, value: pred });
    }
    return out;
  }

  // Truncate every macro series at a historical date — required for honest
  // stress tests that launch forecasts from past origins.
  function truncateMacros(macros, date) {
    const out = {};
    for (const k in macros) {
      if (!macros[k] || !macros[k].obs) continue;
      out[k] = { obs: macros[k].obs.filter(function (o) { return o.date <= date; }) };
    }
    return out;
  }

  return {
    buildRows: buildRows,
    truncateMacros: truncateMacros,
    walkForward: walkForward,
    metrics: metrics,
    residualStd: residualStd,
    forecast: forecast,
    fitRidge: fitRidge,
    predictRow: predictRow,
    solve: solve,
    helpers: { addMonths: addMonths, yoy: yoy, delta12: delta12, trailingAvg: trailingAvg, valueAsOf: valueAsOf },
  };
});
