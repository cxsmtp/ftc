// v6.10.51 — minimal in-tree replacement for jslib's textSummary so the
// scenario doesn't need to fetch from `https://jslib.k6.io/...` at
// script-load time. The k6-summary helper is ~200 lines that mostly
// formats numeric values with units; this file reproduces the parts the
// release/perf scenario actually relies on:
//
//   1. THRESHOLDS section — every metric with a `thresholds` map gets a
//      ✓/✗ line per expression, plus the metric's primary value.
//   2. Metric tables grouped by category (CUSTOM, HTTP, EXECUTION,
//      NETWORK, BROWSER, WEB_VITALS) — each metric formatted on a single
//      line with the standard avg/min/med/max/p(90)/p(95) shape for
//      trends, count/rate for counters, value for gauges, percentage for
//      rates.
//
// Output deliberately mirrors jslib's text shape close enough that an
// operator skimming the run output sees the same structure.

const NS_PER_MS = 1e6;

function _isTimeMetric(m) { return m && m.contains === "time"; }

function _fmtDuration(ms) {
  if (ms == null) return "";
  if (ms < 1) return `${(ms * 1000).toFixed(2)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS - m * 60;
  return `${m}m${s}s`;
}

function _fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function _fmtCount(n) {
  if (n == null) return "";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function _fmtRate(r) {
  if (r == null) return "";
  return r.toFixed(2) + "/s";
}

function _fmtMetricValue(name, m) {
  if (!m) return "";
  const v = m.values || {};
  if (m.type === "trend") {
    const fmt = _isTimeMetric(m) ? _fmtDuration : (x) => (x == null ? "" : x.toFixed(2));
    return `avg=${fmt(v.avg)} min=${fmt(v.min)} med=${fmt(v.med)} max=${fmt(v.max)} p(90)=${fmt(v["p(90)"])} p(95)=${fmt(v["p(95)"])}`;
  }
  if (m.type === "counter") {
    const isBytes = name === "data_received" || name === "data_sent" || name === "browser_data_received" || name === "browser_data_sent";
    if (isBytes) return `${_fmtBytes(v.count)}  ${_fmtRate(v.rate)}`.replace(/\/s$/, "/s").replace("kB/s", "kB/s");
    return `${_fmtCount(v.count)}  ${_fmtRate(v.rate)}`;
  }
  if (m.type === "gauge") return `${v.value} (min=${v.min} max=${v.max})`;
  if (m.type === "rate") return `${(v.rate * 100).toFixed(2)}% ${v.passes}/${v.passes + v.fails}`;
  return JSON.stringify(v);
}

// Threshold result usually carries `lastFailed` + `ok`. Some k6 versions
// return `{ ok: bool }` only. We tolerate both.
function _thresholdMark(result) {
  if (!result) return " ";
  if (result.ok === true) return "✓";
  if (result.ok === false) return "✗";
  return " ";
}

// Pull the value the threshold expression operates on so the operator
// can see "p(90)=2.85s" alongside the threshold expression.
function _thresholdValueShort(name, m, expr) {
  if (!m || !m.values) return "";
  const v = m.values;
  const fmt = _isTimeMetric(m) ? _fmtDuration : ((x) => x == null ? "" : x.toString());
  // Match the `<stat>(...) <op> <num>` shape (e.g. "p(90)<3000", "count<5", "rate<0.01").
  const match = expr.match(/^([a-zA-Z()0-9.]+)\s*[<>=!]+\s*\d/);
  if (!match) return "";
  const stat = match[1];
  if (stat in v) {
    if (stat === "rate") return `rate=${(v.rate * 100).toFixed(2)}%`;
    if (stat === "count") return `count=${v.count}`;
    return `${stat}=${fmt(v[stat])}`;
  }
  return "";
}

function _categoryFor(name) {
  if (/^browser_(http_req_(duration|failed)|page_load|login_render|comp_select_render|task_list_render|task_detail_render|submit_render|leaderboard_render|data_(received|sent))$/.test(name)) return "BROWSER";
  if (/^browser_web_vital_/.test(name)) return "WEB_VITALS";
  if (/^http_req_(duration|failed|sending|connecting|tls_handshaking|waiting|receiving|blocked)$|^http_reqs$|^http_req_duration\{/.test(name)) return "HTTP";
  if (/^iteration_duration$|^iterations$|^vus(_max)?$|^checks(_total)?$|^dropped_iterations$/.test(name)) return "EXECUTION";
  if (/^data_(received|sent)$/.test(name)) return "NETWORK";
  return "CUSTOM";
}

export function textSummary(data, opts) {
  const indent = (opts && opts.indent) || "";
  const lines = [];
  // Thresholds section (matches k6 default output shape)
  lines.push("");
  lines.push(`${indent}█ THRESHOLDS`);
  lines.push("");
  const metricNames = Object.keys(data.metrics).sort();
  for (const name of metricNames) {
    const m = data.metrics[name];
    if (!m || !m.thresholds) continue;
    const exprs = Object.keys(m.thresholds);
    if (exprs.length === 0) continue;
    lines.push(`${indent}    ${name}`);
    for (const expr of exprs) {
      const result = m.thresholds[expr];
      const mark = _thresholdMark(result);
      const value = _thresholdValueShort(name, m, expr);
      lines.push(`${indent}    ${mark} '${expr}' ${value}`);
    }
    lines.push("");
  }
  // Metrics by category
  lines.push(`${indent}█ TOTAL RESULTS`);
  lines.push("");
  const grouped = { CUSTOM: [], HTTP: [], EXECUTION: [], NETWORK: [], BROWSER: [], WEB_VITALS: [] };
  for (const name of metricNames) {
    const cat = _categoryFor(name);
    grouped[cat] = grouped[cat] || [];
    grouped[cat].push(name);
  }
  for (const cat of ["CUSTOM", "HTTP", "EXECUTION", "NETWORK", "BROWSER", "WEB_VITALS"]) {
    if (!grouped[cat] || grouped[cat].length === 0) continue;
    lines.push(`${indent}    ${cat}`);
    // Pad metric names so values align like jslib's output.
    const maxNameLen = grouped[cat].reduce((m, n) => Math.max(m, n.length), 0);
    for (const name of grouped[cat]) {
      const m = data.metrics[name];
      const dots = ".".repeat(Math.max(2, maxNameLen - name.length + 4));
      lines.push(`${indent}    ${name}${dots}: ${_fmtMetricValue(name, m)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
