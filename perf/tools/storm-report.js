#!/usr/bin/env node
"use strict";
/**
 * storm-report — turns one perf/storm-podman.sh run directory into report.md
 * (raw numbers tables, pass/fail per criterion, refusal attribution) and
 * timeline.svg (arrivals / signed-in / app CPU over time). No dependencies.
 *
 *   node perf/tools/storm-report.js perf/results/storm/<label>
 */
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) { console.error("usage: storm-report.js <run dir>"); process.exit(1); }
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch (_) { return ""; } };
// Every loop below runs over records read from the run directory, so the
// inputs are bounded here: at most MAX_RECORDS lines per file, and a time span
// of at most MAX_SPAN_S seconds for the timeline's tick loop.
const MAX_RECORDS = 2000000;
const MAX_SPAN_S = 86400;
const jsonl = (f) => rd(f).split("\n").slice(0, MAX_RECORDS).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

// Keyed by names read from the run directory, so every lookup table here is a
// prototype-less object: a key such as "__proto__" or "constructor" is then an
// ordinary own key and can never reach Object.prototype.
const env = Object.create(null);
for (const l of rd("env.txt").split("\n")) { const i = l.indexOf("="); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1); }
const label = env.label || path.basename(dir);
// Escapes a run-directory value for an SVG text node or attribute (timeline.svg).
const escXml = (v) => String(v === undefined || v === null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const users = parseInt(env.users || "0", 10);
const summary = (() => { try { return JSON.parse(rd(`k6-summary-${label}.json`)); } catch (_) { return null; } })();
const M = summary ? summary.metrics : {};
const vals = (k) => (M[k] && M[k].values) || null;
const count = (k) => (vals(k) && vals(k).count) || 0;
const r1 = (v) => v === undefined || v === null || Number.isNaN(v) ? "-" : (Math.round(v * 10) / 10).toLocaleString("en-US");
const ms2s = (v) => v === undefined || v === null ? "-" : (v / 1000).toFixed(2) + " s";

// ── VU records ─────────────────────────────────────────────────────────────
const recs = jsonl("vu-records.jsonl");
const signed = recs.filter(r => r.outcome === "signed_in");
const t0 = recs.length ? Math.min(...recs.map(r => r.arrive)) : 0;
const refTally = Object.create(null);
for (const r of recs) for (const [k, n] of Object.entries(r.ref || {})) refTally[k] = (refTally[k] || 0) + n;
const attempts = Object.create(null);
for (const r of recs) attempts[r.attempts] = (attempts[r.attempts] || 0) + 1;
const lastSigned = signed.length ? Math.max(...signed.map(r => r.signed)) : null;

// ── Container stats ────────────────────────────────────────────────────────
function bytes(s) {
  const m = /([\d.]+)\s*([kKMGT]?i?B)/.exec(s || ""); if (!m) return null;
  const mult = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824, TB: 1e12 }[m[2]] || 1;
  return Number(m[1]) * mult;
}
const stats = Object.create(null);
const cpuSeries = [];
for (const l of rd("podman-stats.csv").split("\n")) {
  const p = l.split(";"); if (p.length < 4) continue;
  const [ts, name, cpu, mem] = p;
  const c = parseFloat(cpu); const used = bytes((mem || "").split("/")[0]);
  if (Number.isNaN(c)) continue;
  const s = stats[name] || (stats[name] = { n: 0, cpuSum: 0, cpuMax: 0, memMax: 0 });
  s.n++; s.cpuSum += c; s.cpuMax = Math.max(s.cpuMax, c); if (used) s.memMax = Math.max(s.memMax, used);
  if (name === "hackarena-perf") cpuSeries.push({ t: Number(ts), cpu: c, mem: used });
}
const vm = rd("vm-load.csv").split("\n").filter(Boolean).map(l => { const [t, rest] = l.split(";"); return { t: Number(t), l1: parseFloat(rest) }; }).filter(x => !Number.isNaN(x.l1));
const db = jsonl("db.jsonl");
const mon = jsonl("monitor.jsonl");
const control = (mon.find(x => x.control) || {}).control || null;
const scr = mon.filter(x => x.loopBlockedMs !== undefined).slice(0, MAX_RECORDS);
const inRun = scr.filter(x => !t0 || x.t >= t0 - 5000).slice(0, MAX_RECORDS);
const loopDelta = inRun.length > 1 ? inRun[inRun.length - 1].loopBlockedMs - inRun[0].loopBlockedMs : null;
const loopSpanS = inRun.length > 1 ? (inRun[inRun.length - 1].t - inRun[0].t) / 1000 : null;
let maxLoopRate = 0;   // worst 5-second window, ms blocked per second
for (let i = 1; i < inRun.length; i++) {
  const dt = (inRun[i].t - inRun[i - 1].t) / 1000;
  if (dt > 0) maxLoopRate = Math.max(maxLoopRate, (inRun[i].loopBlockedMs - inRun[i - 1].loopBlockedMs) / dt);
}
let restarted = false;
for (let i = 1; i < scr.length; i++) if (scr[i].uptime < scr[i - 1].uptime) restarted = true;
const lastMon = scr[scr.length - 1] || {};
const firstMon = inRun[0] || {};
const maxOf = (arr, k) => arr.reduce((m, x) => (typeof x[k] === "number" && x[k] > m ? x[k] : m), 0);

// ── Access log (server's own record of every answer) ───────────────────────
const access = {};
const accessDir = path.join(dir, "app-logs");
let accessLines = 0;
try {
  for (const f of fs.readdirSync(accessDir).filter(f => f.startsWith("access"))) {
    for (const l of fs.readFileSync(path.join(accessDir, f), "utf8").split("\n")) {
      if (!l) continue; let e; try { e = JSON.parse(l); } catch (_) { continue; }
      if (!e.path || (t0 && Date.parse(e.time || e.ts || e.t || 0) < t0 - 5000)) continue;
      const p = String(e.path).split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ":id").replace(/\?v=.*/, "");
      const route = p.startsWith("/js/") || p.endsWith(".css") ? "(static asset)" : p;
      const k = `${e.method} ${route}`;
      const a = access[k] || (access[k] = {});
      a[e.status] = (a[e.status] || 0) + 1; accessLines++;
    }
  }
} catch (_) { /* no access log copied */ }

// ── Criteria ───────────────────────────────────────────────────────────────
const signinP95 = vals("signin_e2e_ms") ? vals("signin_e2e_ms")["p(95)"] : null;
const pollP95 = vals("http_req_duration{phase:poll}") ? vals("http_req_duration{phase:poll}")["p(95)"] : null;
const ok = count("signin_ok");
const crit = [
  ["≥ 99.5 % of users signed in", `${ok}/${users} = ${users ? (100 * ok / users).toFixed(2) : "-"} %`, users && ok >= Math.ceil(users * 0.995)],
  ["p95 time-to-signed-in < 10 s (incl. mail)", ms2s(signinP95), signinP95 !== null && signinP95 < 10000],
  ["no 5xx", `${count("http_5xx")} seen by clients; ${count("http_no_answer")} requests got NO answer within the 60 s client deadline (access log 5xx: ${Object.values(access).reduce((n, a) => n + Object.entries(a).filter(([s]) => s >= 500).reduce((m, [, c]) => m + c, 0), 0)})`, count("http_5xx") === 0],
  ["no process restart", `${env.app_after || "?"}; uptime monotonic: ${!restarted}`, !restarted && /restarts=0/.test(env.app_after || "") && /running=true/.test(env.app_after || "")],
  ["steady polling p95 < 500 ms", `${r1(pollP95)} ms`, pollP95 !== null && pollP95 < 500],
];
const pass = crit.every(c => c[2]);

// ── Markdown ───────────────────────────────────────────────────────────────
const L = [];
L.push(`# Login storm — ${label}`, "");
L.push(`**Verdict: ${pass ? "PASS" : "FAIL"}** — mode ${env.mode} (${env.mode === "A" ? "load generator allowlisted" : "one NAT address, no allowlist"}), ${users} users, arrivals over ${env.window_s} s, hold ${env.hold_s} s.`, "");
L.push("| | |", "|---|---|");
L.push(`| commit | \`${(rd("commit.txt").split("\n")[0] || "?").trim()}\`${/dirty:/.test(rd("commit.txt")) ? " (working tree had uncommitted changes)" : ""} |`);
L.push(`| started / finished (UTC) | ${env.started_utc} / ${env.finished_utc} |`);
L.push(`| app container | --cpus ${env.app_cpus} --memory ${env.app_memory} (${env.app_image}) |`);
L.push(`| VM | ${env.vm_nproc} CPUs, ${env.vm_mem}; load before \`${env.vm_load_before}\`, after \`${env.vm_load_after}\`; 1-min load during run min ${r1(Math.min(...vm.map(x => x.l1)))} max ${r1(Math.max(...vm.map(x => x.l1)))} |`);
L.push(`| k6 / mailpit | ${env.k6_image} / ${env.mailpit_image} (--cpus 4 --memory 2g) |`);
L.push(`| limiter control (130 × csrf-token from a non-allowlisted address) | ${control ? `${control.csrf429} × 429 → limiter ${control.limiterOn ? "ON" : "OFF — RUN INVALID"}` : "not run"} |`);
L.push("");
L.push("## Criteria", "", "| criterion | measured | result |", "|---|---|---|");
for (const [c, m, p] of crit) L.push(`| ${c} | ${m} | ${p ? "PASS" : "**FAIL**"} |`);
L.push("");
L.push("## Sign-in", "", "| | count |", "|---|---|");
L.push(`| signed in | ${ok} |`, `| failed (gave up after patience / no mail) | ${count("signin_failed")} |`, `| reached the challenge page (tasks + leaderboard 200) | ${count("ready_ok")} |`);
L.push(`| still signed in at the common hold end | ${count("sessions_alive_at_end")} |`, `| mail never arrived | ${count("mail_not_received")} |`, `| POSTs sent with an empty CSRF token (the SPA's 429 path) | ${count("posts_with_empty_csrf")} |`);
L.push(`| attempts per user (request→redeem cycles) | ${Object.entries(attempts).map(([a, n]) => `${a}: ${n}`).join(", ")} |`);
if (lastSigned) L.push(`| last sign-in completed at | T+${((lastSigned - t0) / 1000).toFixed(1)} s |`);
L.push("");
L.push("| timing (ms) | p50 | p90 | p95 | p99 | max |", "|---|---|---|---|---|---|");
for (const [k, n] of [["signin_e2e_ms", "arrival → signed in (end to end, incl. mail)"], ["ready_e2e_ms", "arrival → challenge page loaded"], ["mail_wait_ms", "code requested → code read from inbox"], ["mail_latency_ms", "code requested → relay received it"]]) {
  const v = vals(k); if (v) L.push(`| ${n} | ${r1(v.med)} | ${r1(v["p(90)"])} | ${r1(v["p(95)"])} | ${r1(v["p(99)"])} | ${r1(v.max)} |`);
}
L.push("");
L.push("## Per-endpoint latency (k6, ms)", "", "A request that got no answer (status 0: the 60 s client deadline, a reset) is recorded by k6 with 0 ms timings, so where the refusal table shows `transport_*` rows the low percentiles below are diluted by zeros; read them with that table.", "", "| endpoint | requests | p50 | p90 | p95 | p99 | max |", "|---|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(M)) {
  const m = /^http_req_duration\{(name|phase):([^}]+)\}$/.exec(k); if (!m) continue;
  const reqs = M[`http_reqs{${m[1]}:${m[2]}}`] ? M[`http_reqs{${m[1]}:${m[2]}}`].values.count : "";
  L.push(`| ${m[1] === "phase" ? `**all ${m[2]} requests**` : m[2]} | ${reqs} | ${r1(v.values.med)} | ${r1(v.values["p(90)"])} | ${r1(v.values["p(95)"])} | ${r1(v.values["p(99)"])} | ${r1(v.values.max)} |`);
}
const all = vals("http_req_duration");
if (all) L.push(`| all requests (incl. Mailpit API) | ${count("http_reqs")} | ${r1(all.med)} | ${r1(all["p(90)"])} | ${r1(all["p(95)"])} | ${r1(all["p(99)"])} | ${r1(all.max)} |`);
L.push("");
L.push("## Refusals seen by the clients", "");
const refRows = Object.entries(refTally).sort((a, b) => b[1] - a[1]);
if (!refRows.length) L.push("None — every request answered 2xx/3xx (the boot identity probe's 401 is not a refusal).");
else { L.push("| endpoint status cause | count |", "|---|---|"); for (const [k, n] of refRows) L.push(`| ${k} | ${n} |`); }
L.push("");
if (accessLines) {
  L.push(`## Server access log (${accessLines} lines in the run window)`, "", "| route | statuses |", "|---|---|");
  for (const [k, a] of Object.entries(access).sort((x, y) => Object.values(y[1]).reduce((p, q) => p + q, 0) - Object.values(x[1]).reduce((p, q) => p + q, 0)).slice(0, 40)) {
    L.push(`| ${k} | ${Object.entries(a).map(([s, n]) => `${s}: ${n}`).join(", ")} |`);
  }
  L.push("");
}
L.push("## Server resources", "", "| container | samples | CPU avg % | CPU max % | memory max |", "|---|---|---|---|---|");
for (const [n, s] of Object.entries(stats)) L.push(`| ${n} | ${s.n} | ${r1(s.cpuSum / s.n)} | ${r1(s.cpuMax)} | ${s.memMax ? (s.memMax / 1048576).toFixed(0) + " MiB" : "-"} |`);
L.push("");
L.push("| server signal (/metrics, superadmin scrape every 5 s) | value |", "|---|---|");
L.push(`| RSS max | ${(maxOf(scr, "rss") / 1048576).toFixed(0)} MiB |`, `| heap used max | ${(maxOf(scr, "heapUsed") / 1048576).toFixed(0)} MiB |`);
L.push(`| event loop blocked during the run | ${loopDelta === null ? "-" : `${r1(loopDelta)} ms over ${r1(loopSpanS)} s (${r1(loopDelta / loopSpanS)} ms/s avg; worst 5-s window ${r1(maxLoopRate)} ms/s)`} |`);
L.push(`| detached mail sends pending, max (mail queue) | ${maxOf(scr, "emailPending")} |`);
L.push(`| sign-in code requests by outcome (during run) | ${Object.entries(lastMon.codeRequests || {}).map(([k, v]) => `${k} ${v - ((firstMon.codeRequests || {})[k] || 0)}`).join(", ")} |`);
L.push(`| sign-in code redeems by outcome (during run) | ${Object.entries(lastMon.codeRedeems || {}).map(([k, v]) => `${k} ${v - ((firstMon.codeRedeems || {})[k] || 0)}`).join(", ")} |`);
L.push(`| scanner blocks (total) / blocked IPs at end | ${lastMon.scannerBlocks || 0} / ${lastMon.scannerBlockedIps || 0} |`);
L.push(`| rate-limit buckets max | ${maxOf(scr, "rateLimitBuckets")} |`);
L.push(`| SMTP healthy at end | ${lastMon.smtpHealthy} |`);
L.push(`| /metrics scrape time max | ${maxOf(scr, "scrapeMs")} ms |`);
L.push(`| SQLite WAL size max | ${(maxOf(db, "walBytes") / 1048576).toFixed(1)} MiB (db file ${(maxOf(db, "dbBytes") / 1048576).toFixed(1)} MiB) |`);
L.push(`| session rows max (authenticated) | ${maxOf(db, "sessions")} (${maxOf(db, "authSessions")}) |`);
L.push("", "![timeline](timeline.svg)", "");
fs.writeFileSync(path.join(dir, "report.md"), L.join("\n"));

// ── SVG timeline ───────────────────────────────────────────────────────────
const W = 900, H = 380, PL = 60, PR = 60, PT = 30, PB = 40;
const tEnd = Math.max(t0 + 1000, ...recs.map(r => r.signed || r.arrive), ...cpuSeries.map(c => c.t)) ;
const tMin = t0 ? t0 - 10_000 : Math.min(...cpuSeries.map(c => c.t));
const xs = (t) => PL + ((t - tMin) / (tEnd - tMin)) * (W - PL - PR);
const yc = (n) => H - PB - (n / Math.max(1, users)) * (H - PT - PB);
const cpuMaxAxis = Math.max(100, Math.ceil(Math.max(0, ...cpuSeries.map(c => c.cpu)) / 100) * 100);
const yp = (c) => H - PB - (c / cpuMaxAxis) * (H - PT - PB);
function cum(times) {
  const s = times.filter(Boolean).sort((a, b) => a - b); const pts = [[tMin, 0]];
  s.forEach((t, i) => pts.push([t, i + 1])); pts.push([tEnd, s.length]);
  const step = Math.max(1, Math.floor(pts.length / 400));
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(([t, n]) => `${xs(t).toFixed(1)},${yc(n).toFixed(1)}`).join(" ");
}
const cpuPts = cpuSeries.filter(c => c.t >= tMin).map(c => `${xs(c.t).toFixed(1)},${yp(c.cpu).toFixed(1)}`).join(" ");
const ticks = [];
const spanS = Math.min(MAX_SPAN_S, Math.max(0, Number.isFinite((tEnd - tMin) / 1000) ? (tEnd - tMin) / 1000 : 0)); const stepS = spanS > 600 ? 120 : spanS > 240 ? 60 : spanS > 60 ? 20 : 5;
for (let s = 0; s <= spanS; s += stepS) { const x = xs(tMin + s * 1000); ticks.push(`<line x1="${x}" y1="${H - PB}" x2="${x}" y2="${H - PB + 4}" class="ax"/><text x="${x}" y="${H - PB + 16}" text-anchor="middle">${Math.round(s - 10)}</text>`); }
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="11">
<style>text{fill:#444}.ax{stroke:#999}.g{stroke:#e5e5e5}</style>
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${PL}" y="18" font-size="13" font-weight="600">${escXml(label)}: arrivals and sign-ins (left, users) vs app CPU % (right)</text>
${[0, 0.25, 0.5, 0.75, 1].map(f => `<line x1="${PL}" x2="${W - PR}" y1="${yc(users * f)}" y2="${yc(users * f)}" class="g"/><text x="${PL - 6}" y="${yc(users * f) + 4}" text-anchor="end">${Math.round(users * f)}</text><text x="${W - PR + 6}" y="${yc(users * f) + 4}">${Math.round(cpuMaxAxis * f)}%</text>`).join("\n")}
<line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" class="ax"/>${ticks.join("")}
<text x="${(W) / 2}" y="${H - 6}" text-anchor="middle">seconds since the first arrival</text>
<polyline fill="none" stroke="#9aa5b1" stroke-width="2" stroke-dasharray="5 3" points="${cum(recs.map(r => r.arrive))}"/>
<polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${cum(signed.map(r => r.signed))}"/>
<polyline fill="none" stroke="#dc2626" stroke-width="1.5" opacity="0.8" points="${cpuPts}"/>
<g transform="translate(${PL + 10},${PT + 8})"><rect width="300" height="54" fill="#fff" stroke="#ddd"/>
<line x1="8" x2="30" y1="14" y2="14" stroke="#9aa5b1" stroke-width="2" stroke-dasharray="5 3"/><text x="36" y="18">arrived (cumulative)</text>
<line x1="8" x2="30" y1="30" y2="30" stroke="#2563eb" stroke-width="2.5"/><text x="36" y="34">signed in (cumulative): ${ok}/${users}</text>
<line x1="8" x2="30" y1="46" y2="46" stroke="#dc2626" stroke-width="1.5"/><text x="36" y="50">app container CPU % (--cpus ${escXml(env.app_cpus)})</text></g>
</svg>`;
fs.writeFileSync(path.join(dir, "timeline.svg"), svg);
console.log(`report: ${path.join(dir, "report.md")} — ${pass ? "PASS" : "FAIL"}`);
