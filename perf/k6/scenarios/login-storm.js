/**
 * login-storm — N distinct participants sign in with emailed codes at once,
 * then stay signed in and poll like the SPA does.
 *
 * WHAT ONE VU IS
 * ──────────────
 * One VU is one person at the event start. It arrives at a fixed point inside
 * WINDOW (VU i of N arrives at (i-1)/N × WINDOW, so the offered load is a
 * constant N/WINDOW arrivals per second), and then does exactly what the SPA
 * does for a signed-out visitor who types their address and the code they were
 * mailed (public/js/features/auth.js `signinCodeRequest` / `signinCodeRedeem` /
 * `finishSignIn`):
 *
 *   page load   GET /  (+ the versioned stylesheet and JS bundle, STATIC=1)
 *               GET /api/config, GET /api/me (the identity probe the SPA made
 *               before it asked /api/session/status first; 401),
 *               GET /api/csrf-token
 *   request     POST /api/auth/code/request {email}
 *               (not modelled: the entry screen's POST /api/auth/sign-in-method
 *               before the code request)
 *   inbox       polls Mailpit's API for the message to that address and reads
 *               the code out of it — the code is minted per request, so no
 *               setup() pre-fetch is possible, and the wait is part of the
 *               measured time (mail latency is ALSO reported separately, from
 *               Mailpit's own receive timestamp)
 *   redeem      POST /api/auth/code/redeem {email, code}
 *   land        GET /api/csrf-token (regenerated session), GET /api/me,
 *               POST /api/select-competition, GET /api/my-competitions,
 *               GET /api/status, GET /api/tasks, GET /api/leaderboard
 *   stay        until the common hold end. POLL_MODE=pulse (default): every
 *               15 s +/-20 % /api/participant/pulse, /api/leaderboard when its
 *               version moved or every 60 s, a keepalive every 5 min.
 *               POLL_MODE=legacy: every 15 s /api/status + /api/me +
 *               /api/leaderboard, every 30 s /api/session/status
 *
 * Every VU polls until the SAME wall-clock instant (scenario start + WINDOW +
 * HOLD), so for at least HOLD minus the sign-in time every signed-in session is
 * simultaneously active. A VU whose final poll still answers 200 counts in
 * `sessions_alive_at_end` — the direct witness that N sessions coexisted.
 *
 * CSRF HANDLING IS THE SPA'S, NOT AN IDEALISED CLIENT'S
 * ─────────────────────────────────────────────────────
 * `loadCsrfToken` keeps no token when /api/csrf-token answers 429, and
 * `postWithCsrfRetry` never posts without one: it waits (Retry-After, else
 * capped exponential back-off with jitter, ~45 s at most) and gives up without
 * sending — exactly core/api.js. Posting with an empty token earned a 403
 * `csrf_invalid`, a countable 4xx for scanner reputation; `posts_with_empty_csrf`
 * stays as the witness that the model never does. A person who sees an error
 * tries again after RETRY_S, until PATIENCE_S.
 *
 * WHAT IT DOES NOT DO: submit answers, take hints, or open challenges — this is
 * the sign-in storm and the idle-but-open session load that follows it. For the
 * live-event mix see competition-live.js.
 *
 * Usage (perf/storm-podman.sh drives this; see perf/README.md):
 *   k6 run -e BASE_URL=http://hackarena-perf:3000 -e MAILPIT_URL=http://mailpit:8025 \
 *          -e USERS=1000 -e WINDOW_S=60 -e HOLD_S=240 -e RUN_LABEL=A-60s \
 *          perf/k6/scenarios/login-storm.js
 */

import http from "k6/http";
import { sleep } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import { loadSeedData, getParticipant } from "../lib/data.js";
import { readCode, clearMailbox } from "../lib/mailbox.js";

const BASE_URL    = (__ENV.BASE_URL || "http://hackarena-perf:3000").replace(/\/+$/, "");
const USERS       = parseInt(__ENV.USERS || "1000", 10);
const WINDOW_S    = parseFloat(__ENV.WINDOW_S || "60");
const HOLD_S      = parseFloat(__ENV.HOLD_S || "240");
const POLL_S      = parseFloat(__ENV.POLL_S || "15");
const SESSION_POLL_S = parseFloat(__ENV.SESSION_POLL_S || "30");
// How a signed-in VU polls (perf/README.md § "1000-user sign-in storm"):
//   pulse  (default) the SPA since v8.17.0: GET /api/participant/pulse every
//          POLL_S with +/-20 % jitter (an ACTIVE participant, so it never slows
//          to the idle 30 s), the leaderboard only when lb_version moved or at
//          least every LB_FLOOR_S (the board page assumed open: the pessimistic
//          case), and the throttled keepalive every KEEPALIVE_S. No
//          session-status poll: the pulse answers for it.
//   legacy the SPA before it: /api/status + /api/me + /api/leaderboard every
//          POLL_S, /api/session/status every SESSION_POLL_S.
const POLL_MODE   = (__ENV.POLL_MODE || "pulse") === "legacy" ? "legacy" : "pulse";
const LB_FLOOR_S  = parseFloat(__ENV.LB_FLOOR_S || "60");
const KEEPALIVE_S = parseFloat(__ENV.KEEPALIVE_S || "300");
const MAIL_TIMEOUT_S = parseFloat(__ENV.MAIL_TIMEOUT_S || "120");
const PATIENCE_S  = parseFloat(__ENV.PATIENCE_S || "300");
const RETRY_S     = parseFloat(__ENV.RETRY_S || "5");
const STATIC      = (__ENV.STATIC || "1") !== "0";
// What a browser sends: the server compresses dynamic bodies of 8 KB and more and
// serves the shell, stylesheet and bundle pre-compressed (1 KB threshold), so
// leaving this out would measure a cheaper server than participants get.
const ACCEPT_ENCODING = __ENV.ACCEPT_ENCODING === undefined ? "gzip, deflate, br" : __ENV.ACCEPT_ENCODING;
const BASE_HEADERS = ACCEPT_ENCODING ? { "accept-encoding": ACCEPT_ENCODING } : {};
const RUN_LABEL   = __ENV.RUN_LABEL || "storm";
const OUT_DIR     = __ENV.OUT_DIR || "";
// Targets the run is judged by (stated before running; perf/RESULTS.md).
const SIGNIN_P95_TARGET_MS = parseFloat(__ENV.SIGNIN_P95_TARGET_MS || "10000");
const POLL_P95_TARGET_MS   = parseFloat(__ENV.POLL_P95_TARGET_MS || "500");
const SUCCESS_TARGET       = parseFloat(__ENV.SUCCESS_TARGET || "0.995");

const seedData = loadSeedData();
if (USERS > (seedData.participantCount || 0)) {
  throw new Error(`USERS=${USERS} exceeds the ${seedData.participantCount || 0} seeded accounts — every VU needs its own account.`);
}
if (!seedData.competitionId) throw new Error("seed-data.json carries no competitionId — run perf/seed.js first.");

// ── Metrics ────────────────────────────────────────────────────────────────
const signinE2E   = new Trend("signin_e2e_ms", true);    // arrival → redeem answered ok
const readyE2E    = new Trend("ready_e2e_ms", true);     // arrival → first tasks + leaderboard loaded
const mailWait    = new Trend("mail_wait_ms", true);     // code request answered → code read from the inbox
const mailLatency = new Trend("mail_latency_ms", true);  // code request answered → Mailpit received it (its timestamp)
const signinOk    = new Counter("signin_ok");
const signinFail  = new Counter("signin_failed");
const readyOk     = new Counter("ready_ok");
const aliveAtEnd  = new Counter("sessions_alive_at_end");
const http5xx     = new Counter("http_5xx");
const httpTransport = new Counter("http_no_answer");  // status 0: timed out / reset before any answer
const refusals    = new Counter("refusals");          // tagged {name, status, cause}
const csrfEmpty   = new Counter("posts_with_empty_csrf");
const mailMissing = new Counter("mail_not_received");

const ENDPOINTS = ["page", "static", "config", "me-probe", "csrf-token", "code-request", "code-redeem",
  "me", "select-competition", "my-competitions", "status", "tasks", "leaderboard", "session-status", "pulse", "keepalive"];
const thresholds = {
  signin_ok: [`count>=${Math.ceil(USERS * SUCCESS_TARGET)}`],
  signin_e2e_ms: [`p(95)<${SIGNIN_P95_TARGET_MS}`],
  http_5xx: ["count==0"],
  "http_req_duration{phase:poll}": [`p(95)<${POLL_P95_TARGET_MS}`],
};
// A threshold per endpoint makes k6 keep the tagged sub-metric in the summary,
// which is how the per-endpoint percentile table is produced. The bound is
// deliberately unreachable: these are reporting hooks, not criteria.
for (const n of ENDPOINTS) { thresholds[`http_req_duration{name:${n}}`] = ["max>=0"]; thresholds[`http_reqs{name:${n}}`] = ["count>=0"]; }
thresholds["http_reqs{phase:poll}"] = ["count>=0"];

const maxDuration = Math.ceil(WINDOW_S + PATIENCE_S + HOLD_S + MAIL_TIMEOUT_S + 120);
export const options = {
  scenarios: {
    storm: {
      executor: "per-vu-iterations",
      vus: USERS,
      iterations: 1,
      maxDuration: `${maxDuration}s`,
      gracefulStop: "30s",
    },
  },
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  // Each VU is one browser: its own cookie jar and connections. The SPA's fetch
  // has no client deadline on these calls except fetchTransientRetry's 15 s.
  setupTimeout: "120s",
  noConnectionReuse: false,
};

// ── HTTP helpers ───────────────────────────────────────────────────────────
// Per-VU refusal tally ("<name> <status> <cause>" -> n), printed in the VU's
// STORMREC line so the report can say exactly who refused whom.
const _ref = {};
function classify(res, name, phase) {
  const s = res.status;
  if (s >= 500) http5xx.add(1, { name, status: String(s) });
  if (s === 0) httpTransport.add(1, { name });   // no answer inside the 60 s client deadline
  if (name === "me-probe" && s === 401) return res;   // the boot probe: 401 is the answer
  if (s >= 400 || s === 0) {
    let cause = "other";
    const b = typeof res.body === "string" ? res.body : "";
    if (s === 429) cause = b.indexOf("invalid requests") >= 0 ? "scanner_block" : "rate_limit";
    else if (s === 403 && b.indexOf("csrf") >= 0) cause = "csrf_invalid";
    else if (s === 401) cause = "unauthenticated";
    // k6 error codes: 1050 request timeout (the 60 s client deadline), 1211 dial
    // timeout, 1212 connection refused, 1220 reset, 1000 other.
    else if (s === 0) cause = `transport_${res.error_code || "?"}`;
    refusals.add(1, { name, status: String(s), cause, phase });
    const k = `${name} ${s} ${cause}`;
    _ref[k] = (_ref[k] || 0) + 1;
  }
  return res;
}
function get(path, name, phase, extra) {
  const res = http.get(`${BASE_URL}${path}`, Object.assign({ headers: BASE_HEADERS, tags: { name, phase }, timeout: "60s" }, extra || {}));
  return classify(res, name, phase);
}
function post(path, body, token, name, phase) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: Object.assign({ "content-type": "application/json", "x-csrf-token": token || "" }, BASE_HEADERS),
    tags: { name, phase }, timeout: "60s",
  });
  if (!token) csrfEmpty.add(1, { name });
  return classify(res, name, phase);
}
function jsonOf(res) { try { return res.json(); } catch (_) { return null; } }

// loadCsrfToken: keep the token only on a 200 that carries one; remember the
// status and Retry-After so ensureToken can wait as the SPA does.
function loadCsrf(state, phase) {
  const r = get("/api/csrf-token", "csrf-token", phase);
  state.lastTokenStatus = r.status;
  state.lastRetryAfter = parseInt((r.headers && r.headers["Retry-After"]) || "0", 10) || 0;
  const d = r.status === 200 ? jsonOf(r) : null;
  if (d && d.csrfToken) { state.csrf = d.csrfToken; return true; }
  return !!state.csrf;
}
// ensureToken: core/api.js `_ensureToken` — never post without a token. On a
// 429 (or 5xx) wait the server's Retry-After, else 1, 2, 4… s capped at 15 s,
// with ±25 % jitter, for at most TOKEN_WAIT_TRIES fetches; then give up.
const TOKEN_WAIT_TRIES = 7;
function ensureToken(state, phase) {
  if (state.csrf) return true;
  for (let i = 0; i < TOKEN_WAIT_TRIES; i++) {
    if (loadCsrf(state, phase) && state.csrf) return true;
    if (state.lastTokenStatus !== 429 && state.lastTokenStatus < 500) break;
    if (i === TOKEN_WAIT_TRIES - 1) break;   // the last ask: waiting after it would only delay the answer
    const base = state.lastRetryAfter > 0 ? state.lastRetryAfter * 1000 : Math.min(15000, 1000 * 2 ** i);
    sleep((Math.min(15000, base) * (0.75 + Math.random() * 0.5)) / 1000);
  }
  return !!state.csrf;
}
// postWithCsrfRetry: core/api.js — hold a token first (a local 503
// csrf_unavailable when none comes); on 403 csrf_invalid drop the dead token,
// wait for a real one, re-post once.
function postWithCsrfRetry(state, path, body, name, phase) {
  if (!ensureToken(state, phase)) return { status: 503, body: '{"error":"csrf_unavailable"}', headers: {}, timings: {} };
  let r = post(path, body, state.csrf, name, phase);
  if (r.status !== 403) return r;
  const d = jsonOf(r);
  if (!d || d.error !== "csrf_invalid") return r;
  state.csrf = "";
  if (!ensureToken(state, phase)) return r;
  return post(path, body, state.csrf, name, phase);
}


export function setup() {
  // A clean inbox: the code must come from THIS run's request.
  clearMailbox();
  return { scenarioStartMs: Date.now() };
}

// ── One person ─────────────────────────────────────────────────────────────
export default function () {
  const i = exec.vu.idInTest;                      // 1..USERS, one account each
  const startMs = exec.scenario.startTime;          // common origin for every VU
  const holdEnd = startMs + (WINDOW_S + HOLD_S) * 1000;
  const arriveAt = startMs + ((i - 1) / USERS) * WINDOW_S * 1000;
  const wait = arriveAt - Date.now();
  if (wait > 0) sleep(wait / 1000);

  const p = getParticipant(i, seedData);
  const email = p.email;
  const rec = { i, arrive: Date.now(), signed: null, ready: null, mailMs: null, mailLat: null, attempts: 0, outcome: "failed", alive: false };
  const state = { csrf: "" };
  const giveUp = rec.arrive + PATIENCE_S * 1000;

  // Page load.
  if (STATIC) {
    const page = get("/", "page", "load");
    const html = typeof page.body === "string" ? page.body : "";
    const assets = [];
    const re = /(?:href|src)="(\/(?:styles\.css|js\/core\/main\.js|fonts\.css)\?v=[^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) assets.push(m[1]);
    for (const a of assets) get(a, "static", "load", { responseType: "none" });
  }
  get("/api/config", "config", "load");
  get("/api/me", "me-probe", "load");
  loadCsrf(state, "load");

  // Request a code, then read it from the inbox, then redeem it. A person who
  // gets an error retries the step after RETRY_S, until PATIENCE_S.
  let signed = null;
  while (!signed && Date.now() < giveUp) {
    rec.attempts++;
    const rq = postWithCsrfRetry(state, "/api/auth/code/request", { email }, "code-request", "signin");
    const rqd = rq.status === 200 ? jsonOf(rq) : null;
    if (!rqd || !rqd.ok) { sleep(RETRY_S); continue; }
    const requestedAt = Date.now();
    const got = readCode(email, requestedAt - 1000, MAIL_TIMEOUT_S);
    if (!got) { mailMissing.add(1); break; }
    rec.mailMs = Date.now() - requestedAt;
    rec.mailLat = Math.max(0, got.createdMs - requestedAt);
    mailWait.add(rec.mailMs);
    mailLatency.add(rec.mailLat);
    // The code stays valid for 10 minutes: a refused redeem is retried with the
    // SAME code (the SPA's copy for a 429 says exactly that).
    while (Date.now() < giveUp) {
      const rd = postWithCsrfRetry(state, "/api/auth/code/redeem", { email, code: got.code }, "code-redeem", "signin");
      const d = rd.status === 200 ? jsonOf(rd) : null;
      if (d && d.ok) { signed = d; break; }
      if (rd.status === 200) break;   // a verdict on the code: requesting again is the remedy
      sleep(RETRY_S);
    }
  }
  rec.ref = _ref;   // same object: polls below keep adding to it
  if (!signed) {
    signinFail.add(1);
    console.log(`STORMREC ${JSON.stringify(rec)}`);
    return;
  }
  rec.signed = Date.now();
  rec.outcome = "signed_in";
  signinOk.add(1);
  signinE2E.add(rec.signed - rec.arrive);

  // finishSignIn → adoptNewSessionToken: the regenerated session's token; the
  // pre-sign-in one is dead, so it is dropped and a real one waited for. Then
  // the sole-event landing selects and enters the event.
  state.csrf = "";
  ensureToken(state, "land");
  get("/api/me", "me", "land");
  const compId = signed.autoResumeCompetitionId || seedData.competitionId;
  postWithCsrfRetry(state, "/api/select-competition", { competitionId: compId }, "select-competition", "land");
  get("/api/my-competitions", "my-competitions", "land");
  get("/api/status", "status", "land");
  const t = get("/api/tasks", "tasks", "land");
  const lb = get("/api/leaderboard", "leaderboard", "land");
  if (t.status === 200 && lb.status === 200) {
    rec.ready = Date.now();
    readyOk.add(1);
    readyE2E.add(rec.ready - rec.arrive);
  }

  // Stay signed in until the common hold end, polling as the SPA does.
  if (POLL_MODE === "pulse") {
    const jit = () => POLL_S * 1000 * (1 + (Math.random() * 2 - 1) * 0.2);
    let nextPulse = Date.now() + jit();
    let nextKa = Date.now() + KEEPALIVE_S * 1000;
    let lbSeen = null, lbAt = Date.now();
    let okP = true;
    while (true) {
      const next = Math.min(nextPulse, nextKa);
      if (next >= holdEnd) break;
      sleep(Math.max(0, next - Date.now()) / 1000);
      if (Date.now() >= nextPulse) {
        const p = get("/api/participant/pulse", "pulse", "poll");
        okP = p.status === 200;
        const d = okP ? jsonOf(p) : null;
        const v = d && typeof d.lb_version === "string" ? d.lb_version : null;
        if (v === null || v !== lbSeen || Date.now() - lbAt >= LB_FLOOR_S * 1000) {
          get("/api/leaderboard", "leaderboard", "poll");
          lbSeen = v; lbAt = Date.now();
        }
        nextPulse = Date.now() + jit();
      }
      if (Date.now() >= nextKa) {
        postWithCsrfRetry(state, "/api/session/keepalive", {}, "keepalive", "poll");
        nextKa += KEEPALIVE_S * 1000;
      }
    }
    const finP = get("/api/participant/pulse", "pulse", "poll");
    rec.alive = okP && finP.status === 200;
    if (rec.alive) aliveAtEnd.add(1);
    console.log(`STORMREC ${JSON.stringify(rec)}`);
    return;
  }
  let nextPoll = Date.now() + POLL_S * 1000;
  let nextSess = Date.now() + SESSION_POLL_S * 1000;
  let lastOk = true;
  while (true) {
    const next = Math.min(nextPoll, nextSess);
    if (next >= holdEnd) break;
    sleep(Math.max(0, next - Date.now()) / 1000);
    if (Date.now() >= nextPoll) {
      const s = get("/api/status", "status", "poll");
      get("/api/me", "me", "poll");
      get("/api/leaderboard", "leaderboard", "poll");
      lastOk = s.status === 200;
      nextPoll += POLL_S * 1000;
    }
    if (Date.now() >= nextSess) {
      get("/api/session/status", "session-status", "poll");
      nextSess += SESSION_POLL_S * 1000;
    }
  }
  // The witness: still signed in at the common end.
  const fin = get("/api/status", "status", "poll");
  rec.alive = lastOk && fin.status === 200;
  if (rec.alive) aliveAtEnd.add(1);
  console.log(`STORMREC ${JSON.stringify(rec)}`);
}

export function handleSummary(data) {
  const out = { stdout: textSummary(data) };
  if (OUT_DIR) out[`${OUT_DIR}/k6-summary-${RUN_LABEL}.json`] = JSON.stringify(data, null, 2);
  return out;
}

function fmt(v) { return v === undefined || v === null ? "-" : (Math.round(v * 10) / 10).toString(); }
function textSummary(data) {
  const m = data.metrics;
  const lines = [`\nlogin-storm ${RUN_LABEL}: USERS=${USERS} WINDOW=${WINDOW_S}s HOLD=${HOLD_S}s`];
  const c = (k) => (m[k] && m[k].values && m[k].values.count) || 0;
  lines.push(`  signed in: ${c("signin_ok")}/${USERS}  failed: ${c("signin_failed")}  ready: ${c("ready_ok")}  alive at end: ${c("sessions_alive_at_end")}`);
  lines.push(`  http 5xx: ${c("http_5xx")}  no answer (client deadline/reset): ${c("http_no_answer")}  refusals: ${c("refusals")}  posts with empty CSRF token: ${c("posts_with_empty_csrf")}  mail not received: ${c("mail_not_received")}`);
  for (const k of ["signin_e2e_ms", "ready_e2e_ms", "mail_wait_ms", "mail_latency_ms", "http_req_duration{phase:poll}"]) {
    const v = m[k] && m[k].values;
    if (v) lines.push(`  ${k}: p50 ${fmt(v.med)}  p90 ${fmt(v["p(90)"])}  p95 ${fmt(v["p(95)"])}  p99 ${fmt(v["p(99)"])}  max ${fmt(v.max)}`);
  }
  for (const [k, v] of Object.entries(m)) {
    if (v.thresholds) for (const [t, r] of Object.entries(v.thresholds)) if (!t.startsWith("max>=") && !t.startsWith("count>=0")) lines.push(`  threshold ${k} ${t}: ${r.ok ? "PASS" : "FAIL"}`);
  }
  return lines.join("\n") + "\n";
}
