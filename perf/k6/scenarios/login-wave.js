/**
 * v7.15.33 — the synchronised login wave: the start of a hackathon.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every other scenario ramps gradually (competition-live defaults to
 * RAMP_UP=2m for VU_COUNT=20 — about one login every six seconds). A real
 * event does not arrive that way: the organiser says "go", and three hundred
 * people press Sign In inside a minute, all behind ONE venue NAT address.
 *
 * That is precisely the case CTF-0026 was built for — per-`(IP, email)` login
 * buckets so a roomful of distinct accounts stops sharing a single per-IP
 * bucket, plus a coarse per-IP backstop to keep single-IP brute force capped.
 * Until now the perf suite could not exercise it at all, because the perf
 * container runs with RATE_LIMIT_DISABLED=1 for its whole life (the flag is
 * needed to seed thousands of users past the 10/min register cap, but it was
 * never turned back off for the measurement). So the one failure mode a live
 * event reliably produces was the one thing never measured.
 *
 * Run this with the limiter ON. `perf/run-local.sh` does that by restarting
 * the target between the seed and the measurement.
 *
 * THE CONTROL IS LOAD-BEARING — DO NOT DROP IT
 * ────────────────────────────────────────────
 * "300 concurrent logins produced no 429" is a *vacuous* result if the limiter
 * happens to be switched off: with RATE_LIMIT_DISABLED=1 the wave passes no
 * matter how broken the keying is. So this scenario ALSO drives a deliberate
 * over-limit burst against ONE account and requires it to 429. Read the two
 * thresholds together:
 *
 *   login_wave_429      == 0   ← distinct accounts from one IP are NOT throttled
 *   limiter_control_429  > 0   ← …and the limiter was genuinely enabled
 *
 * If the control does not fire, the run is INVALID and the wave result means
 * nothing. Set CONTROL=0 only when you have already proven the limiter is on
 * some other way.
 *
 * Usage:
 *   k6 run --env BASE_URL=http://localhost:3100 \
 *          --env WAVE_SIZE=300 --env WAVE_WINDOW=60s \
 *          login-wave.js
 */

import http from "k6/http";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import { defaultHeaders, mutate } from "../lib/csrf.js";
import { loadSeedData, getParticipant } from "../lib/data.js";

const BASE_URL      = __ENV.BASE_URL || "http://localhost:3100";
// How many people press Sign In, and over how long. 300/60s is a mid-size
// event; a room of 60 arriving in 20s is just as valid a shape to test.
const WAVE_SIZE     = parseInt(__ENV.WAVE_SIZE || "300");
const WAVE_WINDOW   = __ENV.WAVE_WINDOW || "60s";
const CONTROL       = (__ENV.CONTROL || "1") !== "0";
// Must exceed RATE_LIMIT_LOGIN_PER_MIN (default 60) inside one window, or the
// control proves nothing. 90 leaves headroom if the deployment raised it a bit.
const CONTROL_HITS  = parseInt(__ENV.CONTROL_HITS || "90");

const seedData = loadSeedData();

// Each arrival must have its OWN account (see loginWave). A wave bigger than
// the seeded pool is a misconfigured run, not a server finding — the first
// version let the surplus fall into `other failures`, which reads as the
// server rejecting logins when in fact the harness ran out of identities.
if (WAVE_SIZE > (seedData.participantCount || 0)) {
  throw new Error(
    `WAVE_SIZE=${WAVE_SIZE} exceeds the ${seedData.participantCount || 0} seeded accounts. ` +
    `Every arrival needs a distinct account or they share a per-(IP,email) bucket and ` +
    `manufacture the very 429s this scenario exists to rule out. Seed a larger profile ` +
    `or lower --wave-size.`);
}

const waveFlow        = new Trend("login_wave_flow", true);
const wave429         = new Counter("login_wave_429");
const waveCsrf429     = new Counter("login_wave_csrf_429");
const waveOk          = new Counter("login_wave_ok");
const waveOther       = new Counter("login_wave_other_failure");
const control429      = new Counter("limiter_control_429");
const controlAttempts = new Counter("limiter_control_attempts");

// A login needs a CSRF token first, and `/api/csrf-token` is limited COARSELY
// per-IP (RATE_LIMIT_CSRF_PER_MIN, default 120) — it is not keyed by account
// the way login is. So the two limiters must be counted SEPARATELY: a wave
// that dies at the CSRF step never reaches the login limiter at all, and
// reporting one number would attribute the failure to the wrong mechanism (or
// worse, show login_429 == 0 and read as a pass while nobody actually got in).
function fetchCsrf(baseUrl) {
  const res = http.get(`${baseUrl}/api/csrf-token`, { headers: defaultHeaders(), tags: { name: "wave-csrf" } });
  if (res.status === 429) return { token: null, throttled: true };
  if (res.status !== 200) return { token: null, throttled: false };
  try { return { token: res.json("csrfToken"), throttled: false }; }
  catch (_) { return { token: null, throttled: false }; }
}

function windowSeconds(d) {
  const m = /^(\d+)(s|m)$/.exec(String(d).trim());
  if (!m) return 60;
  return parseInt(m[1]) * (m[2] === "m" ? 60 : 1);
}
const WINDOW_S = windowSeconds(WAVE_WINDOW);
// Arrival rate, not VUs: an OPEN model. A closed model (ramping-vus) would
// self-throttle when the server slows down — each VU waits for its own login
// before issuing the next — which is exactly the wrong shape here, because it
// would quietly reduce the offered load at the moment the server is under
// pressure and hide the very pile-up we are looking for.
//
// The rate is expressed as "WAVE_SIZE arrivals per WAVE_WINDOW" rather than a
// per-second integer. Rounding to whole arrivals/second overshoots badly at
// these sizes — ceil(200/60) = 4/s delivers 240, a 20% heavier wave than
// asked for, which then reads as unexplained extra load in the results.
const RATE_PER_SEC = (WAVE_SIZE / WINDOW_S).toFixed(2);

const scenarios = {};
if (CONTROL) {
  scenarios.limiter_control = {
    executor: "shared-iterations",
    vus: 6,
    iterations: CONTROL_HITS,
    maxDuration: "90s",
    exec: "limiterControl",
    startTime: "0s",
    tags: { phase: "control" },
  };
}
scenarios.login_wave = {
  executor: "constant-arrival-rate",
  duration: WAVE_WINDOW,
  // Pre-allocate generously: an arrival-rate executor that runs out of VUs
  // reports `dropped_iterations` and silently delivers less load than asked.
  preAllocatedVUs: Math.min(WAVE_SIZE, 200),
  maxVUs: Math.min(WAVE_SIZE, 400),
  rate: WAVE_SIZE,
  timeUnit: WAVE_WINDOW,
  exec: "loginWave",
  // Start after the control has finished AND its 1-minute per-IP window has
  // drained, so control traffic cannot contribute to the wave's own backstop
  // accounting or vice versa.
  startTime: CONTROL ? "95s" : "0s",
  tags: { phase: "wave" },
};

export const options = {
  scenarios,
  thresholds: {
    // THE headline assertion: a roomful of distinct accounts behind one NAT
    // address must all get in. Any 429 here is the CTF-0026 regression.
    "login_wave_429": ["count==0"],
    // …but getting in ALSO requires a CSRF token, and that endpoint is capped
    // per-IP with no account keying. If this fires, the per-(IP,email) login
    // fix is real but incomplete for a venue NAT: the participants are stopped
    // one step earlier. Same user-visible outcome — "I cannot sign in".
    "login_wave_csrf_429": ["count==0"],
    // Validity gate — see the header. Without this the line above is vacuous.
    ...(CONTROL ? { "limiter_control_429": ["count>0"] } : {}),
    // A login that fails for some OTHER reason (500, session error) is also a
    // failure of the wave, and must not be silently absorbed into "not a 429".
    "login_wave_other_failure": ["count==0"],
    // Latency under the herd. Login is bcrypt-bound (cost 10) and deliberately
    // expensive, so this is generous — the point is to catch a pile-up, not to
    // police milliseconds.
    "login_wave_flow": ["p(95)<15000"],
    "dropped_iterations": ["count==0"],
  },
};

// One DISTINCT account per arrival — that is the whole point. `iterationInTest`
// is monotonic across the scenario, unlike __VU which an arrival-rate executor
// recycles; recycling would put several arrivals on the SAME email and they
// would then legitimately share a per-(IP,email) bucket, manufacturing the
// 429s this test exists to prove absent.
export function loginWave() {
  const n = exec.scenario.iterationInTest + 1;
  if (n > (seedData.participantCount || 0)) {
    // Fewer seeded accounts than the requested wave — reusing one would make
    // the result meaningless, so record it as a failure rather than fake it.
    waveOther.add(1);
    return;
  }
  const p = getParticipant(n, seedData);
  const start = Date.now();
  const { token, throttled } = fetchCsrf(BASE_URL);
  if (throttled) { waveCsrf429.add(1); return; }
  if (!token) { waveOther.add(1); return; }
  // v8.15.0 — sign-in is an emailed code: request, read it from the relay
  // (MAILPIT_URL), redeem. Both doors answer 200 for every outcome; a 429 is the
  // limiter (per (IP, email), like the password door's was).
  const rq = mutate("post", `${BASE_URL}/api/auth/code/request`, { email: p.email }, token, { name: "wave-code-request" });
  if (rq.status === 429) { wave429.add(1); return; }
  if (rq.status !== 200) { waveOther.add(1); return; }
  const got = readCode(p.email, start - 1000);
  if (!got) { waveOther.add(1); return; }
  const res = mutate("post", `${BASE_URL}/api/auth/code/redeem`,
    { email: p.email, code: got.code }, token, { name: "wave-login" });

  if (res.status === 429) { wave429.add(1); return; }
  let body = null;
  try { body = res.status === 200 ? res.json() : null; } catch (_) { body = null; }
  if (!body || !body.ok) { waveOther.add(1); return; }
  waveOk.add(1);
  waveFlow.add(Date.now() - start);
}

// Deliberately exceed the per-(IP, email) budget for ONE account. This must
// 429 — if it does not, rate limiting is off and the wave result is void.
const _ctlToken = {};
export function limiterControl() {
  const p = getParticipant(1, seedData);
  // Reuse one token per VU. Fetching one per attempt would spend the coarse
  // per-IP CSRF budget instead of the per-(IP,email) LOGIN budget, so the
  // control would fire against the wrong limiter and prove nothing about the
  // mechanism it is supposed to be validating.
  if (!_ctlToken[__VU]) {
    const { token } = fetchCsrf(BASE_URL);
    if (!token) return;
    _ctlToken[__VU] = token;
  }
  // A MALFORMED code: it is counted by the per-(IP, email) redeem limiter like
  // any attempt, but is "a typo" to the lockout (lib/login-code.js), so the
  // control account is throttled without being locked.
  const res = mutate("post", `${BASE_URL}/api/auth/code/redeem`,
    { email: p.email, code: "X" }, _ctlToken[__VU], { name: "control-login" });
  controlAttempts.add(1);
  if (res.status === 429) control429.add(1);
  // A rotated token after a successful login must be picked up, or every
  // subsequent attempt 403s on CSRF and never reaches the limiter.
  if (res._newCsrfToken) _ctlToken[__VU] = res._newCsrfToken;
}

export function handleSummary(data) {
  const c = (m) => (data.metrics[m] && data.metrics[m].values.count) || 0;
  const w429 = c("login_wave_429"), ok = c("login_wave_ok"), other = c("login_wave_other_failure");
  const csrf429 = c("login_wave_csrf_429");
  const ctl = c("limiter_control_429"), ctlN = c("limiter_control_attempts");
  const valid = !CONTROL || ctl > 0;
  const lines = [
    "",
    "════════════════════════════════════════════════════════════",
    "  LOGIN WAVE — synchronised start-of-event herd",
    "════════════════════════════════════════════════════════════",
    // Report what was actually DELIVERED, not what was requested. An
    // arrival-rate executor schedules on a clock, so a 60s stage at 1/s
    // commonly yields 59 arrivals — printing the request made "60 offered / 59
    // signed in" look like a lost login when nothing had gone wrong.
    `  requested          : ${WAVE_SIZE} logins over ${WAVE_WINDOW} (${RATE_PER_SEC}/s, open model)`,
    `  delivered          : ${ok + w429 + csrf429 + other}`,
    `  signed in          : ${ok}`,
    `  throttled at LOGIN : ${w429}   ${w429 === 0 ? "← correct: distinct accounts share one IP freely" : "← CTF-0026 REGRESSION"}`,
    `  throttled at CSRF  : ${csrf429}  ${csrf429 === 0 ? "" : "← the per-IP /api/csrf-token cap fired FIRST; they never reached login"}`,
    `  other failures     : ${other}`,
    "",
    `  limiter control    : ${ctl} of ${ctlN} single-account attempts were 429`,
    `  RESULT             : ${!valid
      ? "INVALID — the control never fired, so rate limiting was OFF and the wave proves nothing"
      : (w429 === 0 && csrf429 === 0 && other === 0 ? "PASS" : "FAIL")}`,
    "════════════════════════════════════════════════════════════",
    "",
  ];
  return { stdout: lines.join("\n") };
}
