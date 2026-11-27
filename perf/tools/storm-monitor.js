#!/usr/bin/env node
"use strict";
/**
 * storm-monitor — the server's own view during a login storm.
 *
 * Signs in as the built-in superadmin (the only account with a password; its
 * boot-generated password is read from the data volume's .superadmin-password)
 * and scrapes GET /metrics every INTERVAL_MS into a JSONL file: RSS and heap,
 * the event-loop-blocked counter, detached-mail backlog, sign-in-code outcomes,
 * scanner blocks and rate-limit bucket count.
 *
 * It also runs the LIMITER CONTROL once at start: 130 GET /api/csrf-token from
 * its own (never allowlisted) address must meet at least one 429, or rate
 * limiting was off and a run with zero refusals proves nothing. Its own address
 * is not the load generator's, so the control cannot spend the storm's budget.
 *
 * Env: BASE_URL, SUPERADMIN_PASSWORD_FILE, OUT (jsonl), INTERVAL_MS (5000),
 *      DURATION_S (stop after), CONTROL (1).
 */
const fs = require("fs");

const BASE_URL = (process.env.BASE_URL || "http://hackarena-perf:3000").replace(/\/+$/, "");
const OUT = process.env.OUT || "/out/monitor.jsonl";
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || "5000", 10);
const DURATION_S = parseInt(process.env.DURATION_S || "900", 10);
const CONTROL = (process.env.CONTROL || "1") !== "0";
// The superadmin password is posted to /api/login, so plain http is refused
// unless the target is this machine or the operator opts in for a private
// container network (storm-podman.sh sets STORM_MONITOR_ALLOW_HTTP=1: the app
// container serves http on a podman network no other host can reach).
{
  const u = new URL(BASE_URL);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !loopback && process.env.STORM_MONITOR_ALLOW_HTTP !== "1") {
    throw new Error("storm-monitor: BASE_URL must be https (or loopback); set STORM_MONITOR_ALLOW_HTTP=1 for a private container network");
  }
}
const PW = fs.readFileSync(process.env.SUPERADMIN_PASSWORD_FILE || "/data/.superadmin-password", "utf8").trim();

let cookie = "";
let csrf = "";
async function req(method, path, body) {
  const headers = { cookie };
  if (csrf) headers["x-csrf-token"] = csrf;
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  for (const c of r.headers.getSetCookie?.() || []) cookie = c.split(";")[0];
  return r;
}
async function login() {
  cookie = ""; csrf = "";
  csrf = (await (await req("GET", "/api/csrf-token")).json()).csrfToken || "";
  const r = await req("POST", "/api/login", { email: "superadmin", password: PW });
  if (r.status !== 200) throw new Error(`superadmin login ${r.status}`);
  csrf = (await (await req("GET", "/api/csrf-token")).json()).csrfToken || "";
}

function parseMetrics(text) {
  const o = { codeRequests: {}, codeRedeems: {} };
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const m = /^([a-z_]+)(\{[^}]*\})?\s+([-0-9.eE+]+)$/.exec(line);
    if (!m) continue;
    const [, name, labels = "", val] = m;
    const v = Number(val);
    const outcome = (/outcome="([^"]+)"/.exec(labels) || [])[1];
    if (name === "hack_arena_process_memory_rss_bytes") o.rss = v;
    else if (name === "hack_arena_process_memory_heap_used_bytes") o.heapUsed = v;
    else if (name === "hack_arena_event_loop_blocked_ms_total") o.loopBlockedMs = v;
    else if (name === "hack_arena_detached_email_pending") o.emailPending = v;
    else if (name === "hack_arena_process_uptime_seconds") o.uptime = v;
    else if (name === "hack_arena_scanner_blocked_ips") o.scannerBlockedIps = v;
    else if (name === "hack_arena_scanner_blocks_total") o.scannerBlocks = (o.scannerBlocks || 0) + v;
    else if (name === "hack_arena_deferred_audit_pending") o.auditPending = v;
    else if (name === "hack_arena_smtp_healthy") o.smtpHealthy = v;
    else if (name === "hack_arena_cache_sizes" && /cache="rate_limit"/.test(labels)) o.rateLimitBuckets = v;
    else if (name === "hack_arena_login_code_requests_total" && outcome) o.codeRequests[outcome] = v;
    else if (name === "hack_arena_login_code_redeems_total" && outcome) o.codeRedeems[outcome] = v;
  }
  return o;
}

(async () => {
  const out = fs.createWriteStream(OUT, { flags: "a" });
  await login();
  if (CONTROL) {
    let n429 = 0;
    const saved = cookie;
    for (let i = 0; i < 130; i++) {
      const r = await fetch(BASE_URL + "/api/csrf-token");
      if (r.status === 429) n429++;
      await r.arrayBuffer();
    }
    cookie = saved;
    out.write(JSON.stringify({ t: Date.now(), control: { csrfRequests: 130, csrf429: n429, limiterOn: n429 > 0 } }) + "\n");
    console.log(`[monitor] limiter control: ${n429}/130 csrf-token requests answered 429 → limiter ${n429 > 0 ? "ON" : "OFF (run invalid)"}`);
  }
  const stopAt = Date.now() + DURATION_S * 1000;
  while (Date.now() < stopAt) {
    const t0 = Date.now();
    try {
      let r = await req("GET", "/metrics");
      if (r.status === 401 || r.status === 403) { await login(); r = await req("GET", "/metrics"); }
      const ms = Date.now() - t0;
      if (r.status === 200) out.write(JSON.stringify({ t: t0, scrapeMs: ms, ...parseMetrics(await r.text()) }) + "\n");
      else out.write(JSON.stringify({ t: t0, scrapeMs: ms, error: r.status }) + "\n");
    } catch (e) {
      out.write(JSON.stringify({ t: t0, error: String(e && e.message || e) }) + "\n");
    }
    await new Promise(res => setTimeout(res, Math.max(0, INTERVAL_MS - (Date.now() - t0))));
  }
  out.end();
})().catch(e => { console.error("[monitor] fatal:", e.message); process.exit(1); });
