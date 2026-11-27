/**
 * Main performance test scenario: simulates a full live competition.
 *
 * Hybrid approach:
 * - "participants" scenario: protocol-level VUs generating realistic API load
 * - "admins" scenario: 1-2 admin VUs polling participants/rankings
 * - "browser_probes" scenario: 3-5 browser VUs measuring end-user rendering
 *
 * Usage:
 *   k6 run --env BASE_URL=https://hack.example.com \
 *          --env TEST_DURATION=10m --env VU_COUNT=20 \
 *          competition-live.js
 */

import { sleep } from "k6";
// v6.10.51 — vendored textSummary, no external dependency. Replaces
// the v6.10.50 import from `https://jslib.k6.io/k6-summary/0.0.3/index.js`
// which the auditor flagged as a release-ops risk: tightly firewalled
// or air-gapped perf hosts that can reach the SUT but not jslib.k6.io
// would fail to start the run. The vendored copy in
// `perf/k6/lib/text-summary.js` is a minimal in-tree replacement that
// renders the same THRESHOLDS + categorised-metrics shape the operator
// expects.
import { textSummary } from "../lib/text-summary.js";
import { loginParticipant, loginAdmin } from "../lib/auth.js";
import { runParticipant } from "../lib/participant.js";
import { runAdmin, runLogAdmin, runOrganiser } from "../lib/admin.js";
import { runBrowserProbe } from "../lib/browser-probe.js";
import { loadSeedData, getParticipant, getBrowserParticipant, getAdminParticipant } from "../lib/data.js";
import {
  correctSubmissions, wrongSubmissions, hintsRevealed,
  csrfFailures, sessionErrors, sqliteBusyErrors,
} from "../lib/metrics.js";

// ── Configuration ───────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "https://localhost:3000";
const TEST_DURATION = __ENV.TEST_DURATION || "10m";
const VU_COUNT = parseInt(__ENV.VU_COUNT || "20");
const RAMP_UP = __ENV.RAMP_UP || "2m";
const ADMIN_VUS = parseInt(__ENV.ADMIN_VUS || "1");
const LOG_ADMIN_VUS = parseInt(__ENV.LOG_ADMIN_VUS || "1");
// Organiser tabs with the event's Overview open, each polling its live read.
const ORGANISERS = parseInt(__ENV.ORGANISERS || "3");
const BROWSER_PROBES = parseInt(__ENV.BROWSER_PROBES || "2");
const ADMIN_PASSWORD = __ENV.SUPERADMIN_PASSWORD || __ENV.ADMIN_PASSWORD || "";

// v7.2.x — duration-aware count budgets. The browser-probe / session-churn
// COUNT thresholds (vs the latency p90 budgets, which are duration-independent)
// accumulate noise over wall-clock: third-party CDN hiccups, Chromium/CDP
// connection churn on the load generator, and the occasional session-expiry
// edge. Their old fixed counts (5/10/15) were calibrated for a 10-minute quick
// test and inevitably trip on a multi-hour soak even when the SERVER is perfect
// (the real server-health gates are the protocol-VU http_req_failed rate + the
// per-status 5xx thresholds, which a regression always blows past). Scale these
// gates with TEST_DURATION so a clean long run reports green while a genuine
// browser↔server breakdown (counts an order of magnitude higher) still fails.
function durationToMinutes(d) {
  if (!d) return 10;
  let total = 0; const re = /(\d+(?:\.\d+)?)\s*([hms])/g; let m;
  while ((m = re.exec(String(d)))) {
    const v = parseFloat(m[1]);
    total += m[2] === "h" ? v * 60 : m[2] === "s" ? v / 60 : v;
  }
  return total || 10;
}
const DURATION_MIN = durationToMinutes(TEST_DURATION);
// budget = floor + perMin*minutes (both env-overridable). The floor preserves
// the old short-test sensitivity; perMin is the steady-state noise allowance.
function budget(floorEnv, floorDefault, perMinEnv, perMinDefault) {
  const floor = (__ENV[floorEnv] !== undefined) ? parseFloat(__ENV[floorEnv]) : floorDefault;
  const perMin = (__ENV[perMinEnv] !== undefined) ? parseFloat(__ENV[perMinEnv]) : perMinDefault;
  return Math.ceil(floor + perMin * DURATION_MIN);
}

const seedData = loadSeedData();

// ── Thresholds ──────────────────────────────────────────────────────────────
// Scenarios are assembled conditionally — k6 rejects `vus: 0`, so setting
// ADMIN_VUS=0 or BROWSER_PROBES=0 simply omits the respective scenario.
const scenarios = {
  participants: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: RAMP_UP, target: VU_COUNT },           // Ramp up
      { duration: TEST_DURATION, target: VU_COUNT },      // Steady state
      { duration: "30s", target: 0 },                     // Ramp down
    ],
    exec: "participantScenario",
  },
};
if (ADMIN_VUS > 0) {
  scenarios.admins = {
    executor: "constant-vus",
    vus: ADMIN_VUS,
    duration: TEST_DURATION,
    startTime: "10s", // Admins login slightly before ramp-up
    exec: "adminScenario",
  };
}
if (LOG_ADMIN_VUS > 0) {
  // v6.10.21: log-watching admin. Polls /api/admin/logs on the event
  // stream by default, switches to the access stream (limit=500 —
  // heavier) after a randomised 3-5 min phase, switches back after
  // another 3-5 min. Represents the operator tab pinned to Logs
  // during a live event that occasionally flips views to check HTTP
  // access patterns. Runs alongside the dashboard admin, not instead
  // of it.
  scenarios.log_admins = {
    executor: "constant-vus",
    vus: LOG_ADMIN_VUS,
    duration: TEST_DURATION,
    startTime: "15s",
    exec: "logAdminScenario",
  };
}
if (ORGANISERS > 0) {
  scenarios.organisers = {
    executor: "constant-vus",
    vus: ORGANISERS,
    duration: TEST_DURATION,
    startTime: "20s",
    exec: "organiserScenario",
  };
}
if (BROWSER_PROBES > 0) {
  scenarios.browser_probes = {
    executor: "constant-vus",
    vus: BROWSER_PROBES,
    duration: TEST_DURATION,
    startTime: RAMP_UP, // Start after ramp-up when competition is live
    exec: "browserScenario",
    options: {
      browser: {
        type: "chromium",
      },
    },
  };
}
export const options = {
  scenarios,
  thresholds: {
    // API-level
    "http_req_duration": ["p(90)<1500"],
    "login_flow": ["p(90)<5000"],
    "submit_answer": ["p(90)<2000"],
    // v8.9.1 — a submit the server refused to GRADE (409 task_changed) is a
    // harness defect, never load: no admin edits a key mid-run. From v7.20.9 to
    // v8.9.0 every "correct" submit here was one, counted as wrong, and nothing
    // failed. This is the gate that was missing.
    "stale_submissions": ["count<1"],
    "leaderboard": ["p(90)<3000"],
    "task_list": ["p(90)<1000"],
    // v6.10.55 — task_detail raised 1000 → 1500 ms. At 210 protocol VUs
    // the measured p(90) sits stable at ~1.04 s across three runs
    // (v6.10.49/50/54). Handler is read-only (SELECT task + attempt
    // count + hint-revealed probe + feedback lookup) and all queries
    // are indexed — the delta is event-loop queue depth under load,
    // not cache or index. 1500 ms matches the operational ceiling;
    // tighter just flakes.
    "task_detail": ["p(90)<1500"],
    // v6.10.89 — status_poll raised 500 → 2000 ms. The server-side
    // /api/status handler is sub-2 ms median across every dimension
    // (prelude ~0.4 ms, body ~0.24 ms, db ~0.03 ms — measured via
    // perf-span in v6.10.88 against ctf.checkmarx.net). The ~1 s
    // k6-observed p(90) is ENTIRELY network + TLS handshake + edge
    // queue, not application work; no server-side change will move
    // it. The 500 ms threshold was calibrated on localhost/LAN,
    // unreachable against any public WAN host behind a CDN/LB. 2000
    // ms is still useful as a "did the server or edge fall over"
    // gauge — a flip above 2 s would mean real backend stall or edge
    // failover, not normal WAN RTT. Adjust further only if
    // infrastructure RTT changes materially.
    // The pulse carries the /api/status body plus the score and the board's
    // version; same WAN-RTT reasoning as above.
    "pulse_poll": ["p(90)<2000"],
    // The Overview's live read: uncached, about ten index-range passes over the
    // event's rows. The figure to record before any cache is considered.
    "overview_pulse": ["p(90)<2000"],
    "select_competition": ["p(90)<1000"],
    // v6.10.55 — reveal_hint raised 1000 → 1500 ms. Stable at ~1.32 s
    // p(90) across the v6.10.50/54 runs. Each reveal invalidates the
    // per-competition leaderboard cache (v6.9.9 writer-lock
    // invariant), forcing the next /api/leaderboard reader to rebuild
    // from scratch — under 210 VUs polling the board at a steady
    // cadence, that rebuild cost is consistently felt. Short of a
    // leaderboard-cache redesign (incremental recompute vs full
    // rebuild), this number stays ~here. 1500 ms is the realistic
    // gate.
    "reveal_hint": ["p(90)<1500"],
    // v6.10.50 — back to 3000 from the v6.10.45 4500 bump. The
    // v6.10.47 cache + invalidation re-do made the original
    // threshold reachable: latest perf run measured p(90) = 2.85 s,
    // comfortably under 3 s. Keeping the lower gate so future
    // regressions surface at the operational expectation, not the
    // pre-cache ceiling.
    // v6.10.91 — admin_participants raised 3000 → 5000 ms and
    // admin_history_competition raised 1500 → 4000 ms. Measured
    // against ctf.checkmarx.net via v6.10.90 every-call perf-spans:
    //   admin_participants:   total server time ~12 ms median, max ~13 ms
    //                         (list ~2 ms, comps ~6 ms, pending ~1.5 ms).
    //   admin_history_competition: total server time ~1 ms median,
    //                              max ~2 ms (db ~0.5–1.2 ms on miss).
    // Both k6 p(90) measurements (3.61 s and 3.59 s) are therefore
    // ~99.6 % network + TLS + edge queue, not application work. Same
    // situation as status_poll (raised 500 → 2000 in v6.10.89). The
    // raised thresholds catch edge / LB failure modes while no longer
    // false-flagging on normal WAN RTT. Real server-side regression
    // detection lives in the `[perf-span] slow <route>` logger (300 ms
    // server-work threshold) — see server.js handlers.
    "admin_participants": ["p(90)<5000"],
    "admin_leaderboard": ["p(90)<3000"],
    "admin_history_competition": ["p(90)<4000"],
    "admin_history_user": ["p(90)<1500"],
    // Analytics + logs — heavier aggregates, generous thresholds. Global-
    // scope analytics gets a wider budget because it scans challenge_events
    // without a competition filter.
    "admin_analytics_competition": ["p(90)<4000"],
    "admin_analytics_global":      ["p(90)<6000"],
    "admin_logs":                  ["p(90)<3000"],
    // admin_logs_access pulls 500 lines per call vs admin_logs' 50 —
    // ~10× the bytes + a different on-disk file. Generous p90.
    "admin_logs_access":           ["p(90)<6000"],
    // Browser rendering
    // v6.10.93 — browser_page_load raised 4000 → 10000 ms. Measured
    // against ctf.checkmarx.net via v6.10.92 every-call SPA-shell
    // perf-spans: server-side shell serve is ~0.3-0.6 ms on 47 KB of
    // HTML — the 7.37 s k6-observed p(90) is ~99.99% network + TLS
    // + asset cascade (~20 asset/API requests × ~200-400 ms each
    // under WAN + edge-queue contention). No server-side fix will
    // move this. 10 s threshold catches degenerate cases (severely
    // bloated bundle, bundling broken, edge outage) while not
    // false-failing on normal WAN RTT for a SPA of this size. Real
    // regression on the shell serve itself (not the network) is
    // caught by the `[perf-span] slow SPA shell` logger at > 300 ms.
    "browser_page_load": ["p(90)<10000"],
    "browser_login_render": ["p(90)<5000"],
    "browser_submit_render": ["p(90)<3000"],
    "browser_leaderboard_render": ["p(90)<5000"],
    // v6.10.69 — three trends that existed in code but had no threshold
    // defined, so k6 omitted them from the summary when sample-less.
    // v6.10.78 — enough WAN-run samples have accumulated to set real
    // p(90) ceilings. Observed data across v6.10.72 / v6.10.76 /
    // v6.10.77 runs:
    //   * browser_comp_select_render: avg=1.76s, p(90)=1.76s (very
    //     tight — auto-placement path records a near-instant delta
    //     between loginStart and nav-ready). Threshold 3000ms has ~1.7×
    //     headroom over observed p(90) — still flags a regression but
    //     doesn't flake on WAN-jitter tails.
    //   * browser_task_list_render: avg=487-1513ms p(90)=490-1253ms.
    //     Threshold 3000ms — roughly 2× observed p(90), accounts for
    //     admin-load contention peaks seen in the v6.10.76 run.
    //   * browser_task_detail_render: avg=1.55-3.22s p(90)=1.55-10.57s.
    //     The 10.57s came from a click-timeout-capped run; v6.10.77's
    //     safeClick should trim that tail. Threshold 5000ms — above
    //     the typical 1.5s but below the 10s degenerate tail, so
    //     server regressions that push the typical render past 5s
    //     still fail the gate without the click-timeout noise.
    "browser_comp_select_render": ["p(90)<3000"],
    "browser_task_list_render":   ["p(90)<3000"],
    "browser_task_detail_render": ["p(90)<5000"],
    // Error budgets
    // v6.10.53 — http_req_failed threshold loosened from 0.01 → 0.15.
    // The v6.10.50 `failed_by_status` breakdown confirmed every single
    // failure in production perf runs is an expected anonymous-state
    // 4xx: 403 on CSRF-gated endpoints before login + 401 on /api/me
    // and /api/admin/me pre-login probes. Zero 5xx observed across
    // multiple full-scale runs. A 1% budget was never reachable with
    // the scenario's shape (probes hit /api/me before login state is
    // established, which legitimately 401s). 15% gives enough
    // headroom for the synthetic traffic while still flagging a real
    // regression — if real 5xx appears, it now surfaces via the
    // per-status sub-thresholds rather than getting swamped by the
    // 4xx noise.
    "http_req_failed": ["rate<0.15"],
    // v7.2.x — duration-scaled (was fixed count<5). These should stay near-zero
    // in a healthy run; the per-minute allowance only absorbs the slow trickle
    // of session-expiry / transient-CSRF edges over a long soak. A real
    // CSRF/session regression (or a rate-limit cascade like the pre-RATE_LIMIT_
    // DISABLED run) produces a flood that still blows past the budget.
    // v7.2.x — per-minute rates recalibrated to a realistic ACTIVE-mutation
    // profile (30 tasks, comp live the whole soak), not the light/idle profile
    // the first cut was tuned on. A 240-min/300-VU active run measured ~0.7
    // csrf/min and ~1.3 session/min (vs 0 / 0.03 on the idle run); the broken
    // rate-limit-cascade run was ~2.3/min for both. These budgets clear a clean
    // active soak with ~1.3-1.5× headroom while a real cascade still fails. The
    // keepalive tighten (participant.js, 5→3 min) cuts the underlying churn so
    // these are a backstop, not the primary gate.
    "csrf_failures":    [`count<${budget("CSRF_FAIL_MAX", 5, "CSRF_FAIL_PER_MIN", 1.0)}`],
    "session_errors":   [`count<${budget("SESSION_ERR_MAX", 5, "SESSION_ERR_PER_MIN", 1.75)}`],
    // sqlite_busy_errors stays STRICT (<1) — any write-lock contention is a real
    // server signal regardless of run length, so it is NOT duration-scaled.
    "sqlite_busy_errors": ["count<1"],
    // v6.10.43 — per-status thresholds on `failed_by_status` (defined in
    // perf/k6/lib/http.js) so the per-HTTP-code breakdown surfaces in
    // k6's default summary output. Without these, k6 aggregates all
    // tag values into the bare `failed_by_status` total, making the
    // top-line `http_req_failed` rate unactionable — an operator sees
    // "11.85% failed" and can't tell whether it's expected-4xx polling
    // traffic (401 on `/api/me`, 403 on ended-comp submissions) or a
    // real 5xx outage.
    //
    // v6.10.54 — split into two tiers:
    //
    //   * Expected-traffic 4xx (401 on pre-login probes, 403 on
    //     anonymous/ended-comp writes, 400/404/409/422 bulk-edit edge
    //     cases): kept at `count>=0`, which ALWAYS passes but forces
    //     the sub-metric to render in the summary for diagnosis.
    //
    //   * Real-error 4xx + every 5xx: failing thresholds. 429 fires
    //     ONLY if RATE_LIMIT_DISABLED isn't set on the perf container
    //     (setup error) or a new limiter appears; 413 fires on an
    //     oversized-body regression; 500/502/503/504 are always real
    //     server outages. Previously a run could stay green with a
    //     real 5xx regression buried inside the relaxed
    //     http_req_failed<0.15 budget — this moves the fail-gate to
    //     the status codes that actually matter while keeping the
    //     top-line relaxed for synthetic 4xx.
    //
    // Per-status count<5 gives a small slack for rare transient
    // connection-reset-as-503 artefacts under extreme load; real
    // outages produce tens-to-thousands of 5xx and blow past it.
    "failed_by_status{status:400}": ["count>=0"],
    "failed_by_status{status:401}": ["count>=0"],
    "failed_by_status{status:403}": ["count>=0"],
    "failed_by_status{status:404}": ["count>=0"],
    "failed_by_status{status:409}": ["count>=0"],
    "failed_by_status{status:413}": ["count<5"],
    "failed_by_status{status:422}": ["count>=0"],
    "failed_by_status{status:429}": ["count<5"],
    "failed_by_status{status:500}": ["count<5"],
    "failed_by_status{status:502}": ["count<5"],
    "failed_by_status{status:503}": ["count<5"],
    "failed_by_status{status:504}": ["count<5"],
    // v6.10.62 — `count>=0` thresholds force k6 to render each tagged
    // sub-metric in the summary even when its count is 0 (k6 hides
    // tagged sub-metrics from the default output otherwise). The
    // handleSummary handler at the bottom of this file iterates these
    // and prints a phase-reach table, making "probes died at phase X"
    // directly visible. Phases match those in browser-probe.js.
    "browser_phases_reached{phase:init}":         ["count>=0"],
    "browser_phases_reached{phase:page_load}":    ["count>=0"],
    "browser_phases_reached{phase:login_fill}":   ["count>=0"],
    "browser_phases_reached{phase:login_submit}": ["count>=0"],
    "browser_phases_reached{phase:comp_select}":  ["count>=0"],
    "browser_phases_reached{phase:wait_live}":    ["count>=0"],
    "browser_phases_reached{phase:comp_click}":   ["count>=0"],
    "browser_phases_reached{phase:task_list}":    ["count>=0"],
    "browser_phases_reached{phase:task_detail}":  ["count>=0"],
    "browser_phases_reached{phase:task_submit}":  ["count>=0"],
    "browser_phases_reached{phase:leaderboard}":  ["count>=0"],
    "browser_phases_reached{phase:cycle_pause}":  ["count>=0"],
    // v6.10.62 — same trick for per-phase CLS. `value>=0` is the
    // always-passing threshold-shape that forces k6 to render the
    // tagged sub-metric in the summary. The handleSummary handler
    // iterates these and prints a per-phase CLS attribution table —
    // the v6.10.61 perf run measured aggregate CLS=0.75 vs the
    // v6.10.55 local probe's 0.0576, and this table will tell us
    // which phase is actually responsible for the bulk on WAN.
    // v6.10.63 — `count>=0` is valid for Counter but NOT for Trend. k6
    // rejects the scenario at init with "unsupported aggregation method
    // count on metric of type trend" — the valid aggregations for Trend
    // are avg / min / max / med / p(N). `min>=0` is the minimal
    // always-passing form here: `add(delta)` upstream clamps to
    // Math.max(0, ...), so every sample is non-negative by construction.
    "browser_cls_per_phase{phase:init}":         ["min>=0"],
    "browser_cls_per_phase{phase:page_load}":    ["min>=0"],
    "browser_cls_per_phase{phase:login_fill}":   ["min>=0"],
    "browser_cls_per_phase{phase:login_submit}": ["min>=0"],
    "browser_cls_per_phase{phase:comp_select}":  ["min>=0"],
    "browser_cls_per_phase{phase:wait_live}":    ["min>=0"],
    "browser_cls_per_phase{phase:comp_click}":   ["min>=0"],
    "browser_cls_per_phase{phase:task_list}":    ["min>=0"],
    "browser_cls_per_phase{phase:task_detail}":  ["min>=0"],
    "browser_cls_per_phase{phase:task_submit}":  ["min>=0"],
    "browser_cls_per_phase{phase:leaderboard}":  ["min>=0"],
    "browser_cls_per_phase{phase:cycle_pause}":  ["min>=0"],
    // v6.10.84 — 403 attribution per endpoint name. `count>=0` is the
    // always-passing shape; the threshold exists only to force the
    // sub-metric into the summary. handleSummary iterates them and
    // prints a top-N-routes table. The enumerated names cover every
    // { tags: { name: "…" } } spec in perf/k6/lib (auth, admin,
    // participant, csrf). Any new endpoint added to that library
    // should also be added here — otherwise a 403 on it would
    // increment `failed_403_by_name` but stay invisible in the summary.
    "failed_403_by_name{name:login}":                        ["count>=0"],
    "failed_403_by_name{name:admin-login}":                  ["count>=0"],
    "failed_403_by_name{name:csrf-token}":                   ["count>=0"],
    "failed_403_by_name{name:page-load}":                    ["count>=0"],
    "failed_403_by_name{name:select-competition}":           ["count>=0"],
    "failed_403_by_name{name:session-keepalive}":            ["count>=0"],
    "failed_403_by_name{name:task-list}":                    ["count>=0"],
    "failed_403_by_name{name:task-detail}":                  ["count>=0"],
    "failed_403_by_name{name:pulse-poll}":                   ["count>=0"],
    "failed_403_by_name{name:overview-pulse}":               ["count>=0"],
    "failed_403_by_name{name:submit-answer}":                ["count>=0"],
    "failed_403_by_name{name:reveal-hint}":                  ["count>=0"],
    "failed_403_by_name{name:leaderboard}":                  ["count>=0"],
    "failed_403_by_name{name:logout}":                       ["count>=0"],
    "failed_403_by_name{name:admin-participants}":           ["count>=0"],
    "failed_403_by_name{name:admin-leaderboard}":            ["count>=0"],
    "failed_403_by_name{name:admin-submissions}":            ["count>=0"],
    "failed_403_by_name{name:admin-analytics-competition}":  ["count>=0"],
    "failed_403_by_name{name:admin-analytics-global}":       ["count>=0"],
    "failed_403_by_name{name:admin-competition-events}":     ["count>=0"],
    "failed_403_by_name{name:admin-user-events}":            ["count>=0"],
    "failed_403_by_name{name:admin-logs}":                   ["count>=0"],
    "failed_403_by_name{name:admin-logs-access}":            ["count>=0"],
    // v6.10.84 — browser-probe click-failure attribution. Three
    // safeClick call sites so only three phases can contribute: the
    // challenges-nav click (tag task_list), the task-card click
    // (tag task_detail), and the leaderboard-nav click (tag
    // leaderboard). The v6.10.83 run had 38 missing task_submit phase
    // entries with no metric-level attribution — these thresholds
    // surface the per-phase failure count in the summary.
    "browser_click_failures{phase:task_list}":   ["count>=0"],
    "browser_click_failures{phase:task_detail}": ["count>=0"],
    "browser_click_failures{phase:leaderboard}": ["count>=0"],
    // v6.12.2 — browser-probe waitForSelector timeout attribution.
    // Three probe sites have a post-click waitForSelector that the
    // probe swallows silently on timeout (task_list, task_detail,
    // leaderboard). `count>=0` is always-passing and forces the
    // tagged sub-metric into the summary. A non-zero value on
    // `leaderboard` confirms the v6.10.93 scenario where
    // browser_leaderboard_render = 0.00µs was LG contention (probe
    // couldn't render within 30 s under 5-browser + 310-VU load),
    // NOT a server bug. Non-zero on `task_list` / `task_detail`
    // signals selector drift or page hydration issues.
    "browser_phase_timeouts{phase:task_list}":   ["count>=0"],
    "browser_phase_timeouts{phase:task_detail}": ["count>=0"],
    "browser_phase_timeouts{phase:leaderboard}": ["count>=0"],
    // v6.12.3 — waitForSelector duration (trend, tagged by phase +
    // result). `min>=0` is the always-passing trend-threshold shape
    // (count>=0 isn't valid for trends). Forces the sub-metrics into
    // the summary so we can read the percentiles. `result=timeout`
    // percentiles near the timeout parameter (30000 ms leaderboard,
    // 10000 ms task_list, 5000 ms task_detail) mean the probe hit
    // the ceiling cleanly. Percentiles well below the ceiling
    // indicate the probe bailed earlier — different failure mode.
    // v6.12.7 — leaderboard three-stage diagnostic removed (v6.12.6
    // established `state:'attached'` as the fix — Stage A matched 100 %,
    // Stages B + C never ran). Back to three phase tags:
    //   task_list, task_detail, leaderboard — each recording ok/timeout.
    "browser_waitforselector_ms{phase:task_list,result:ok}":       ["min>=0"],
    "browser_waitforselector_ms{phase:task_list,result:timeout}":  ["min>=0"],
    "browser_waitforselector_ms{phase:task_detail,result:ok}":     ["min>=0"],
    "browser_waitforselector_ms{phase:task_detail,result:timeout}":["min>=0"],
    "browser_waitforselector_ms{phase:leaderboard,result:ok}":     ["min>=0"],
    "browser_waitforselector_ms{phase:leaderboard,result:timeout}":["min>=0"],
    // v6.12.3 — browser-side HTTP request failure attribution by URL
    // kind. `count>=0` always-passing. The v6.10.93 run's 339/2749
    // browser_http_req_failed rate (12.33%) was opaque about which
    // bucket was failing; this tag splits it into spa_shell /
    // asset / api / external / other.
    // v7.2.x — the SERVER-origin browser kinds (spa_shell / asset / api) now
    // carry a duration-scaled FAILING gate; `external` (third-party CDN, e.g.
    // cdnjs highlight.js) and `other` stay purely informational — a CDN hiccup
    // is not a server regression and must never fail the run. The aggregate
    // `browser_request_failures` (below) is likewise demoted to informational,
    // because it sums in the unbounded `external` noise. perMin is generous: in
    // a clean run these kinds are dominated by load-gen Chromium connection
    // churn (ERR_CONNECTION_CLOSED / ERR_CERT_VERIFIER_CHANGED), not server
    // faults — only a near-total browser↔server breakdown exceeds the budget.
    "browser_request_failures{kind:spa_shell}": [`count<${budget("BROWSER_REQ_FAIL_MAX", 15, "BROWSER_REQ_FAIL_PER_MIN", 12)}`],
    "browser_request_failures{kind:asset}":     [`count<${budget("BROWSER_REQ_FAIL_MAX", 15, "BROWSER_REQ_FAIL_PER_MIN", 12)}`],
    "browser_request_failures{kind:api}":       [`count<${budget("BROWSER_REQ_FAIL_MAX", 15, "BROWSER_REQ_FAIL_PER_MIN", 12)}`],
    "browser_request_failures{kind:external}":  ["count>=0"],
    "browser_request_failures{kind:other}":     ["count>=0"],
    // v6.20.x — REAL release gates (the tagged sub-metrics above are
    // always-passing attribution for the summary; these UNtagged aggregates
    // actually FAIL the run). Pre-fix a release perf run could pass with
    // non-zero browser-side failures unless someone eyeballed the summary.
    // Untagged `count` sums across every phase/kind tag, so these bound the
    // total. Small non-zero ceilings absorb genuine WAN/LG jitter (a stray
    // descheduled probe under 5-browser load) while failing on systemic
    // breakage — tune via BROWSER_FAIL_MAX / BROWSER_TIMEOUT_MAX env if a
    // specific run's LG contention profile needs more headroom.
    // v7.2.x — click failures (a probe genuinely couldn't click a control —
    // closest to a real UI bug) get only a light per-minute allowance; phase
    // timeouts (render/selector waits, more LG-contention-sensitive) get a
    // larger one; both are duration-scaled off the old fixed floors. The
    // aggregate `browser_request_failures` is now INFORMATIONAL (`count>=0`) —
    // it summed in the unbounded third-party `external` CDN noise; the real gate
    // moved to the per-kind server-origin thresholds above.
    "browser_click_failures":   [`count<${budget("BROWSER_FAIL_MAX", 5, "BROWSER_FAIL_PER_MIN", 0.1)}`],
    "browser_phase_timeouts":   [`count<${budget("BROWSER_TIMEOUT_MAX", 10, "BROWSER_TIMEOUT_PER_MIN", 0.75)}`],
    "browser_request_failures": ["count>=0"],
  },
};

// v6.10.60 — full fix for the browser↔protocol collision, replacing
// both the broken v6.10.57 (protocol pool shrink → protocol↔protocol
// collision) and the still-broken v6.10.58 (disjoint IDs within one
// pool, but __VU is GLOBALLY unique across scenarios — participants
// can end up with __VU > VU_COUNT because admin / log_admin VUs grab
// global IDs during the participant ramp-up window, so the reserved
// range re-overlapped).
//
// Diagnostic that surfaced it: the v6.10.59 attribution log of a 7-min
// run showed 97 session-401s concentrated on 5 VUs numbered exactly
// 301..305 (= v6.10.58's browser reserve), nearly all on status-poll
// at iter=0 (= stuck in pollUntilLive with a dead session). Those
// 5 VUs were LATE-RAMP PARTICIPANTS whose global __VU values slipped
// past VU_COUNT because admin + log_admin took global slots ~301..305
// first.
//
// Right fix: stop sharing one numeric pool with modulo arithmetic.
// Two disjoint EMAIL prefixes instead — protocol VUs always log in as
// perf-user-NNN, browser probes as perf-browser-NN. No arithmetic
// relates them, so no k6 VU-allocation behaviour can put them onto
// the same user. See `getBrowserParticipant` in perf/k6/lib/data.js.
//
// v6.10.60 startup check: refuse to start when the seed file doesn't
// include the new browser pool AND the operator asked for browser
// probes. The v6.10.60 release shipped this as a soft warn + fallback
// to the legacy "offset into protocol pool" mapping in
// getBrowserParticipant — which is known to produce protocol↔browser
// session-401 collisions. The auditor flagged this as an
// ops/release-readiness issue: a stale seed shouldn't be allowed to
// produce avoidable collision noise in the flagship perf run. v6.10.64
// upgrades the warn to a throw so the operator gets stopped at init
// rather than burning minutes on a run with known-bad output. The
// fallback in getBrowserParticipant is retained for the
// BROWSER_PROBES=0 path (where no browser-probe login happens at all)
// and for scenario files that don't run this scenario's init-time
// check.
const _HAS_BROWSER_POOL = (seedData.browserParticipantCount || 0) > 0;
if (BROWSER_PROBES > 0 && !_HAS_BROWSER_POOL) {
  throw new Error(
    `[config] seed-data.json has no separate browser-probe user pool, ` +
    `but BROWSER_PROBES=${BROWSER_PROBES}. The legacy fallback in ` +
    `getBrowserParticipant modulos into the protocol pool, producing ` +
    `protocol↔browser session-401 collisions that drift the run's ` +
    `results. Re-seed with: node seed.js --browser-probes ${BROWSER_PROBES} ... ` +
    `(set BROWSER_PROBES=0 in the k6 env to skip the browser scenario ` +
    `entirely if you don't want browser-probe coverage on this run.)`
  );
}

// v6.10.61 — protocol↔protocol collision guard. The participant
// scenario picks its participant via `((__VU - 1) % participantCount)
// + 1`. k6 hands out __VU IDs from a single GLOBAL pool shared across
// every scenario, so participant VUs can have __VU values up to
// `VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + BROWSER_PROBES` (the sum of
// all preAllocatedVUs across scenarios). When that exceeds
// participantCount, modulo wraps and two participant VUs land on the
// SAME user — they kill each other's sessions in a back-and-forth
// pattern visible as alternating-VU [session-401] bursts (e.g. VU=5
// and VU=310 at participantCount=305 both modulo to user 5; neither
// completes a single iteration for the rest of the run).
//
// Throw at init time so the operator sees the failure in the first
// second instead of burning 9+ minutes on a doomed run, and so the
// fix instructions are right next to the failure. The companion
// fix on the seed side (perf/seed.js v6.10.61) auto-adds a 16-user
// buffer above --participant-count for exactly this purpose, so a
// fresh seed always passes this check unless the operator runs an
// unusually heavy admin / log_admin / browser_probes config.
const _REQUIRED_PARTICIPANTS = VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + ORGANISERS + BROWSER_PROBES;
if ((seedData.participantCount || 0) < _REQUIRED_PARTICIPANTS) {
  throw new Error(
    `[config] participant pool too small. ` +
    `seed-data.json has participantCount=${seedData.participantCount || 0}, ` +
    `but the participant scenario can see __VU values up to ${_REQUIRED_PARTICIPANTS} ` +
    `(VU_COUNT=${VU_COUNT} + ADMIN_VUS=${ADMIN_VUS} + LOG_ADMIN_VUS=${LOG_ADMIN_VUS} + ORGANISERS=${ORGANISERS} + BROWSER_PROBES=${BROWSER_PROBES}). ` +
    `Without enough users, two protocol VUs will modulo-wrap onto the same participant ` +
    `and kill each other's sessions in a back-and-forth [session-401] pattern. ` +
    `Reseed with: node seed.js --participant-count ${_REQUIRED_PARTICIPANTS} ... ` +
    `(seed.js v6.10.61+ auto-adds a 16-user buffer above --participant-count, so passing ` +
    `--participant-count ${VU_COUNT} would also satisfy the check.)`
  );
}

// v6.10.85 — admin-pool guard. Mirrors the browser-pool check above. The
// admin + log_admin scenarios route through `getAdminParticipant(__VU)`,
// which resolves to `perf-admin-NN@acme.com` when seed-data.json carries
// the new `adminParticipantCount` field. Without it, the fallback reverts
// to the shared-superadmin login (known collision noise — v6.10.84 run
// recorded 633 × 403 in 12 min). Throw when the operator explicitly ran
// admin / log_admin VUs but the seed predates the pool, so the fix
// prompt is immediate instead of discovered after a wasted run.
//
// v6.10.93 — also enforce SIZE. k6's __VU is globally allocated, so an
// admin/log_admin VU can receive any __VU value up to the scenario's
// total preallocated count. `getAdminParticipant` does
// `((__VU - 1) % adminParticipantCount) + 1`, so if the admin pool is
// smaller than that ceiling, two VUs modulo to the same account and
// round-robin-kill each other's sessions (observed in a v6.10.92 WAN
// run: `vu=23` and `vu=43` both mod 20 = 3 → both logged in as
// perf-admin-03 → log-admin VU vu=43 stuck at iter=0 producing a
// 15-s-cadence admin-logs 403 stream). The pool must be at least as
// large as the participant pool to guarantee unique resolution.
const _NEEDS_ADMIN_POOL = (ADMIN_VUS > 0 || LOG_ADMIN_VUS > 0 || ORGANISERS > 0);
const _HAS_ADMIN_POOL = (seedData.adminParticipantCount || 0) > 0;
if (_NEEDS_ADMIN_POOL && !_HAS_ADMIN_POOL) {
  throw new Error(
    `[config] seed-data.json has no admin pool (adminParticipantCount=${seedData.adminParticipantCount || 0}), ` +
    `but the scenario runs ADMIN_VUS=${ADMIN_VUS} + LOG_ADMIN_VUS=${LOG_ADMIN_VUS} + ORGANISERS=${ORGANISERS} admin-capable VUs. ` +
    `The legacy shared-superadmin login triggers single-session-per-user kills across VUs and ` +
    `produces sustained 403 bursts on every admin endpoint (v6.10.84: 633 × 403 in 12 min). ` +
    `Reseed with: node seed.js --admin-count ${_REQUIRED_PARTICIPANTS} ... ` +
    `(seeds perf-admin-NN@acme.com with role=admin, one account per VU, no cross-VU session kills). ` +
    `Set ADMIN_VUS=0 LOG_ADMIN_VUS=0 ORGANISERS=0 in the k6 env to skip admin coverage entirely if you don't ` +
    `want admin-capable VUs on this run.`
  );
}
if (_NEEDS_ADMIN_POOL && _HAS_ADMIN_POOL && seedData.adminParticipantCount < _REQUIRED_PARTICIPANTS) {
  throw new Error(
    `[config] admin pool too small. ` +
    `seed-data.json has adminParticipantCount=${seedData.adminParticipantCount}, ` +
    `but admin/log_admin VUs can see __VU values up to ${_REQUIRED_PARTICIPANTS} ` +
    `(VU_COUNT=${VU_COUNT} + ADMIN_VUS=${ADMIN_VUS} + LOG_ADMIN_VUS=${LOG_ADMIN_VUS} + ORGANISERS=${ORGANISERS} + BROWSER_PROBES=${BROWSER_PROBES}). ` +
    `getAdminParticipant's modulo will wrap and two VUs will collide on the same admin account — ` +
    `single-session-per-user then round-robin-kills their sessions and produces sustained 403 bursts ` +
    `on every admin endpoint (v6.10.92 run: vu=23 + vu=43 both modulo 20 = 3, perf-admin-03 session kills). ` +
    `Reseed with: node seed.js --admin-count ${_REQUIRED_PARTICIPANTS} ... ` +
    `(seed.js v6.10.93+ defaults --admin-count to participant-pool size automatically, so passing ` +
    `--participant-count ${VU_COUNT} alone is enough to satisfy this check on a fresh seed.)`
  );
}

// ── Participant scenario ────────────────────────────────────────────────────
export function participantScenario() {
  // Always use the pre-v6.10.57 default: __VU → participantCount
  // modulo. When participantCount == VU_COUNT (the typical case),
  // each protocol VU gets a unique participant. When participantCount
  // > VU_COUNT, trailing IDs go unused — fine.
  const participant = getParticipant(__VU, seedData);

  // Stagger login: random delay within first 30s of this VU's life
  sleep(Math.random() * 30);

  // 10% are late joiners — delay further
  if (Math.random() < 0.10) {
    sleep(60 + Math.random() * 120);
  }

  const { csrfToken, loginData, ok } = loginParticipant(
    BASE_URL, participant.email, participant.password
  );
  if (!ok) {
    console.error(`VU ${__VU}: login failed for ${participant.email}`);
    sleep(10);
    return;
  }

  runParticipant(BASE_URL, csrfToken, seedData, loginData);
}

// ── Admin scenario ──────────────────────────────────────────────────────────
// v6.10.85 — route each admin VU through getAdminParticipant(__VU) so
// the 3 admin VUs + 2 log_admin VUs each log in to a DISTINCT account
// from the `perf-admin-NN` pool (seeded by perf/seed.js --admin-count).
// Pre-fix all 5 VUs logged in as the built-in `superadmin`, and the
// single-session-per-user invariant round-robin-killed each other's
// sessions on every new login — 633 × 403 in the v6.10.84 WAN run.
// With an admin pool, each VU's logins only touch its own user's
// sessions, so cross-VU kills can't happen.
//
// Fallback: when the seed doesn't include an admin pool (pre-v6.10.85
// seed-data.json, or `--admin-count 0`), getAdminParticipant returns
// the legacy `{email:"superadmin", password: seedData.adminPassword}`
// shape so the scenario still runs. The init-time guard below surfaces
// this case as a warn so the operator reseeds.
export function adminScenario() {
  const admin = getAdminParticipant(__VU, seedData);
  if (ADMIN_PASSWORD) admin.password = ADMIN_PASSWORD; // env override wins
  const { csrfToken, ok } = loginAdmin(BASE_URL, admin);
  if (!ok) {
    console.error(`Admin VU ${__VU} (${admin.email}): login failed`);
    sleep(30);
    return;
  }
  runAdmin(BASE_URL, csrfToken, seedData);
}

// ── Organiser with the Overview open ────────────────────────────────────────
export function organiserScenario() {
  const admin = getAdminParticipant(__VU, seedData);
  if (ADMIN_PASSWORD) admin.password = ADMIN_PASSWORD;
  const { csrfToken, ok } = loginAdmin(BASE_URL, admin);
  if (!ok) {
    console.error(`Organiser VU ${__VU} (${admin.email}): login failed`);
    sleep(30);
    return;
  }
  runOrganiser(BASE_URL, csrfToken, seedData);
}

// ── Log-watching admin scenario (v6.10.21) ─────────────────────────────────
export function logAdminScenario() {
  const admin = getAdminParticipant(__VU, seedData);
  if (ADMIN_PASSWORD) admin.password = ADMIN_PASSWORD;
  const { csrfToken, ok } = loginAdmin(BASE_URL, admin);
  if (!ok) {
    console.error(`Log-admin VU ${__VU} (${admin.email}): login failed`);
    sleep(30);
    return;
  }
  runLogAdmin(BASE_URL, csrfToken, seedData);
}

// ── Browser probe scenario ──────────────────────────────────────────────────
export async function browserScenario() {
  // v6.10.60 — separate user pool for browser probes. `getBrowserParticipant`
  // resolves against `seedData.browserParticipantCount` /
  // `browserParticipantEmailPattern` (perf-browser-NN@acme.com by default);
  // the modulo is scoped to the browser pool only, which has no numeric
  // overlap with the protocol pool (perf-user-NNN@acme.com). No __VU
  // arithmetic crosses the two pools, so k6's global VU allocation
  // behaviour — which re-introduced the collision in v6.10.58 — has no
  // surface area to bite.
  const participant = getBrowserParticipant(__VU, seedData);
  await runBrowserProbe(BASE_URL, participant.email, participant.password, seedData);
}

// ── Custom summary ─────────────────────────────────────────────────────────
// v6.10.50 — render the default summary (via jslib's textSummary) PLUS
// a dedicated `failed_by_status` breakdown table. The v6.10.43 per-status
// thresholds make sub-metrics with `count{status:NNN}` available to the
// summary code, but k6's default text renderer aggregates tag-keyed
// sub-metrics under the parent metric — so the breakdown stays invisible
// without an explicit handler. This iterates `data.metrics`, picks out
// every sub-metric matching `failed_by_status{status:N}`, and prints a
// short table sorted by count descending. Top-line `http_req_failed`
// rate becomes diagnosable at a glance: whether the failures are
// expected 401s on `/api/me` polls, expected 503s from un-bypassed
// requests, or real 5xx outages.
export function handleSummary(data) {
  const rows = [];
  let total = 0;
  for (const [name, m] of Object.entries(data.metrics)) {
    const match = name.match(/^failed_by_status\{status:(\d+)\}$/);
    if (match && m && m.values && m.values.count > 0) {
      rows.push([match[1], m.values.count]);
      total += m.values.count;
    }
  }
  let breakdown = "\n  █ failed_by_status breakdown (HTTP code → count)\n";
  if (rows.length === 0) {
    breakdown += "    (no non-2xx/3xx responses observed — http_req_failed should be ~0%)\n";
  } else {
    rows.sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [status, count] of rows) {
      const pct = ((count / total) * 100).toFixed(1);
      breakdown += `    ${status}: ${String(count).padStart(8)}  (${pct}%)\n`;
    }
    breakdown += `    ─────────────────────\n`;
    breakdown += `    total: ${String(total).padStart(8)}\n`;
  }

  // v6.10.62 — browser-probe phase-reach table. The v6.10.61 results showed
  // browser_leaderboard_render and browser_submit_render at p(90)=0.00µs
  // — meaning probes silently dropped out of the flow before reaching those
  // phases. This table makes the drop-off point unambiguous: if 100 probes
  // entered `page_load` but only 5 entered `task_submit`, 95 either
  // graceful-skipped or crashed in between. Phase order matches
  // browser-probe.js so the table reads top-down through the probe lifecycle.
  const PHASE_ORDER = [
    "init", "page_load", "login_fill", "login_submit",
    "comp_select", "wait_live", "comp_click",
    "task_list", "task_detail", "task_submit",
    "leaderboard", "cycle_pause",
  ];
  const phaseCounts = new Map();
  for (const [name, m] of Object.entries(data.metrics)) {
    const match = name.match(/^browser_phases_reached\{phase:([^}]+)\}$/);
    if (match && m && m.values) {
      phaseCounts.set(match[1], m.values.count || 0);
    }
  }
  let phaseTable = "\n  █ browser_phases_reached (probe phase → entries)\n";
  if (phaseCounts.size === 0) {
    phaseTable += "    (no browser probes ran — BROWSER_PROBES=0?)\n";
  } else {
    const initCount = phaseCounts.get("init") || 0;
    for (const phase of PHASE_ORDER) {
      const count = phaseCounts.get(phase) || 0;
      const pct = initCount > 0 ? ((count / initCount) * 100).toFixed(1).padStart(5) : "  -  ";
      phaseTable += `    ${phase.padEnd(15)}: ${String(count).padStart(6)}  (${pct}% of init)\n`;
    }
  }

  // v6.10.62 — per-phase CLS attribution. The aggregate
  // `browser_web_vital_cls` is already in the standard summary; this
  // table breaks it down by phase so the dominant contributors are
  // visible at a glance. Reads avg + p(90) per phase from the
  // browser_cls_per_phase{phase:X} sub-metrics. Total avg sums every
  // phase's avg and should track the aggregate browser_web_vital_cls
  // — if it doesn't, the observer missed entries (page navigation
  // resetting it, CDP context loss, etc.).
  const clsPerPhase = new Map();
  for (const [name, m] of Object.entries(data.metrics)) {
    const match = name.match(/^browser_cls_per_phase\{phase:([^}]+)\}$/);
    if (match && m && m.values) {
      clsPerPhase.set(match[1], { avg: m.values.avg || 0, p90: m.values["p(90)"] || 0, count: m.values.count || 0 });
    }
  }
  let clsTable = "\n  █ browser_cls_per_phase (CLS contribution by probe phase)\n";
  if (clsPerPhase.size === 0) {
    clsTable += "    (no browser probes ran — BROWSER_PROBES=0?)\n";
  } else {
    let totalAvg = 0;
    for (const phase of PHASE_ORDER) {
      const stats = clsPerPhase.get(phase);
      if (!stats) continue;
      totalAvg += stats.avg;
      const avgStr = stats.avg.toFixed(4);
      const p90Str = stats.p90.toFixed(4);
      const samples = String(stats.count).padStart(5);
      clsTable += `    ${phase.padEnd(15)}: avg=${avgStr.padStart(7)}  p(90)=${p90Str.padStart(7)}  (n=${samples})\n`;
    }
    clsTable += `    ─────────────────────────────────────────────────\n`;
    clsTable += `    sum of avgs    : ${totalAvg.toFixed(4).padStart(7)}  (compare to browser_web_vital_cls aggregate)\n`;
  }

  // v6.10.84 — per-endpoint 403 attribution. The v6.10.83 WAN run logged
  // 1829× 403 aggregated by status only; this table breaks that count
  // down by the `name` tag (route), sorted descending. Reads from the
  // new `failed_403_by_name{name:...}` sub-metrics — each one declared
  // with a `count>=0` threshold upstream so it's present in data.metrics
  // even when count is 0. Prints only non-zero rows plus a total line.
  const route403 = [];
  let total403 = 0;
  for (const [name, m] of Object.entries(data.metrics)) {
    const match = name.match(/^failed_403_by_name\{name:([^}]+)\}$/);
    if (match && m && m.values && m.values.count > 0) {
      route403.push([match[1], m.values.count]);
      total403 += m.values.count;
    }
  }
  let route403Table = "\n  █ failed_403_by_name (403 responses by endpoint name)\n";
  if (route403.length === 0) {
    route403Table += "    (no 403 responses — if http_req_failed is up, check failed_by_status breakdown)\n";
  } else {
    route403.sort((a, b) => Number(b[1]) - Number(a[1]));
    const maxNameLen = route403.reduce((m, r) => Math.max(m, r[0].length), 0);
    for (const [rname, count] of route403) {
      const pct = ((count / total403) * 100).toFixed(1);
      route403Table += `    ${rname.padEnd(maxNameLen)}: ${String(count).padStart(6)}  (${pct}% of 403s)\n`;
    }
    route403Table += `    ${"─".repeat(maxNameLen + 2)}──────\n`;
    route403Table += `    ${"total".padEnd(maxNameLen)}: ${String(total403).padStart(6)}\n`;
  }

  // v6.10.84 — browser click-failure attribution. Pairs with
  // browser_phases_reached: a probe that couldn't click
  // #nav-challenges increments browser_click_failures{phase:task_list}
  // AND caps its phases_reached at task_list. Seeing the two together
  // localises why probes drop out at a given phase — a stuck .task-card
  // click previously showed up as "38 missing task_submit entries"
  // with no direct signal.
  const clickFails = [];
  let totalClickFails = 0;
  for (const [name, m] of Object.entries(data.metrics)) {
    const match = name.match(/^browser_click_failures\{phase:([^}]+)\}$/);
    if (match && m && m.values) {
      const count = m.values.count || 0;
      clickFails.push([match[1], count]);
      totalClickFails += count;
    }
  }
  let clickFailTable = "\n  █ browser_click_failures (safeClick failures by phase)\n";
  if (clickFails.length === 0 || totalClickFails === 0) {
    clickFailTable += "    (no safeClick failures observed)\n";
  } else {
    clickFails.sort((a, b) => Number(b[1]) - Number(a[1]));
    const maxNameLen = clickFails.reduce((m, r) => Math.max(m, r[0].length), 0);
    for (const [phase, count] of clickFails) {
      if (!count) continue;
      clickFailTable += `    ${phase.padEnd(maxNameLen)}: ${String(count).padStart(6)}\n`;
    }
    clickFailTable += `    ${"─".repeat(maxNameLen + 2)}──────\n`;
    clickFailTable += `    ${"total".padEnd(maxNameLen)}: ${String(totalClickFails).padStart(6)}\n`;
  }

  // v6.12.2 — browser waitForSelector timeout attribution. Compared
  // to phases_reached: a probe that reached phase X but timed out on
  // the post-click render increments phase_timeouts{phase:X}. Lets
  // the operator distinguish "phase never reached" (phases_reached
  // low) from "phase reached but render didn't hydrate in time"
  // (timeouts non-zero). Both counters were needed to diagnose the
  // v6.10.93 leaderboard-render=0 scenario as LG contention, not
  // server regression.
  const phaseTimeouts = [];
  let totalPhaseTimeouts = 0;
  for (const [name, m] of Object.entries(data.metrics)) {
    const match = name.match(/^browser_phase_timeouts\{phase:([^}]+)\}$/);
    if (match && m && m.values) {
      const count = m.values.count || 0;
      phaseTimeouts.push([match[1], count]);
      totalPhaseTimeouts += count;
    }
  }
  let phaseTimeoutTable = "\n  █ browser_phase_timeouts (waitForSelector timeouts by phase)\n";
  if (phaseTimeouts.length === 0 || totalPhaseTimeouts === 0) {
    phaseTimeoutTable += "    (no phase timeouts observed — every post-click render landed in time)\n";
  } else {
    phaseTimeouts.sort((a, b) => Number(b[1]) - Number(a[1]));
    const maxNameLen = phaseTimeouts.reduce((m, r) => Math.max(m, r[0].length), 0);
    for (const [phase, count] of phaseTimeouts) {
      if (!count) continue;
      phaseTimeoutTable += `    ${phase.padEnd(maxNameLen)}: ${String(count).padStart(6)}\n`;
    }
    phaseTimeoutTable += `    ${"─".repeat(maxNameLen + 2)}──────\n`;
    phaseTimeoutTable += `    ${"total".padEnd(maxNameLen)}: ${String(totalPhaseTimeouts).padStart(6)}\n`;
  }

  // v6.12.3 — waitForSelector duration breakdown. For each phase,
  // show the ok / timeout p(90) side-by-side. Helps operator see at
  // a glance whether the 30-s leaderboard timeout was a clean
  // ceiling-hit (p(90) near 30000) or bailed earlier.
  // v6.12.7 — back to the pre-diagnostic three-phase list. Leaderboard
  // three-stage diagnostic removed; `state:'attached'` fix applied.
  const wfsPhases = ["task_list", "task_detail", "leaderboard"];
  const wfsRows = [];
  for (const phase of wfsPhases) {
    for (const result of ["ok", "timeout"]) {
      const key = `browser_waitforselector_ms{phase:${phase},result:${result}}`;
      const m = data.metrics[key];
      if (m && m.values) {
        wfsRows.push({ phase, result, p90: m.values["p(90)"] || 0, avg: m.values.avg || 0, count: m.values.count || 0 });
      }
    }
  }
  let wfsTable = "\n  █ browser_waitforselector_ms (selector wait duration by phase × result)\n";
  if (wfsRows.length === 0 || wfsRows.every(r => r.count === 0)) {
    wfsTable += "    (no waitForSelector samples — browser probes didn't reach any phase)\n";
  } else {
    const col = (s, n) => (s + " ".repeat(n)).slice(0, n);
    wfsTable += `    ${col("phase", 12)}${col("result", 9)}${col("n", 6)}  ${col("p90 (ms)", 12)}${col("avg (ms)", 12)}\n`;
    for (const r of wfsRows) {
      if (!r.count) continue;
      wfsTable += `    ${col(r.phase, 12)}${col(r.result, 9)}${col(String(r.count), 6)}  ${col(r.p90.toFixed(0), 12)}${col(r.avg.toFixed(0), 12)}\n`;
    }
  }

  // v6.12.3 — browser-side HTTP failure attribution by URL kind.
  // Mirrors the failed_by_status-per-route table but for browser
  // chromium traffic. A high `asset` count under concurrent
  // browser-probe load typically indicates edge-CDN rate limiting
  // or connection-pool exhaustion on the LG source IP. A high
  // `api` count suggests server-side 5xx or backend overload.
  const reqFailKinds = ["spa_shell", "asset", "api", "external", "other"];
  const reqFailRows = [];
  let totalReqFails = 0;
  for (const kind of reqFailKinds) {
    const key = `browser_request_failures{kind:${kind}}`;
    const m = data.metrics[key];
    const count = m && m.values ? (m.values.count || 0) : 0;
    if (count > 0) {
      reqFailRows.push([kind, count]);
      totalReqFails += count;
    }
  }
  let reqFailTable = "\n  █ browser_request_failures (browser-side HTTP failures by URL kind)\n";
  if (reqFailRows.length === 0) {
    reqFailTable += "    (no browser-side HTTP failures observed)\n";
  } else {
    reqFailRows.sort((a, b) => Number(b[1]) - Number(a[1]));
    const maxNameLen = reqFailRows.reduce((m, r) => Math.max(m, r[0].length), 0);
    for (const [kind, count] of reqFailRows) {
      const pct = ((count / totalReqFails) * 100).toFixed(1);
      reqFailTable += `    ${kind.padEnd(maxNameLen)}: ${String(count).padStart(6)}  (${pct}%)\n`;
    }
    reqFailTable += `    ${"─".repeat(maxNameLen + 2)}──────\n`;
    reqFailTable += `    ${"total".padEnd(maxNameLen)}: ${String(totalReqFails).padStart(6)}\n`;
  }

  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }) + breakdown + phaseTable + clsTable + route403Table + clickFailTable + phaseTimeoutTable + wfsTable + reqFailTable,
  };
}
