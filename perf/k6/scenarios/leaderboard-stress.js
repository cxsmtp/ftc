/**
 * Focused stress test: leaderboard endpoint under increasing load.
 * Tests the O(N*M) buildLeaderboardEntries() query pattern.
 *
 * Usage:
 *   k6 run --env BASE_URL=https://hack.example.com \
 *          --env VU_COUNT=50 \
 *          leaderboard-stress.js
 */

import { sleep } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import { loginParticipant } from "../lib/auth.js";
import { getCsrfToken, mutateWithRetry } from "../lib/csrf.js";
import { get } from "../lib/http.js";
import { loadSeedData, getParticipant } from "../lib/data.js";
import { leaderboard } from "../lib/metrics.js";

const BASE_URL = __ENV.BASE_URL || "https://localhost:3000";
const VU_COUNT = parseInt(__ENV.VU_COUNT || "50");

const seedData = loadSeedData();

// v7.15.35 — ONE login per VU for the whole run.
//
// This scenario's header says it "tests the O(N*M) buildLeaderboardEntries()
// query pattern", but it used to re-authenticate on EVERY iteration: an
// iteration was login + select-competition + 20 polls, so a VU logged in
// roughly every 30 s. Measured on a limits-ON target, that made ~78% of its
// requests authentication and only ~15% leaderboard — it was mostly an auth
// benchmark wearing a leaderboard test's name.
//
// It also misrepresents the user it claims to model: a participant signs in
// once and then polls the board for the whole competition. The inflated
// /api/csrf-token volume is what drove that run into the per-IP CSRF cap and,
// through the 403s that followed, the scanner-reputation IP ban — a cascade
// that says more about the harness than about the leaderboard.
//
// Fix: one iteration now IS one participant session. The VU logs in once and
// polls until the test ends, so the ramp still shapes concurrency but the auth
// traffic is a fixed one-off per VU rather than a function of run length.
// NOTE this changes the request mix, so results are NOT directly comparable
// with pre-v7.15.35 runs recorded in RESULTS.md.
const POLL_MS   = parseInt(__ENV.POLL_INTERVAL_MS || "1500");
// Sum of the stage durations below. A VU polls until this deadline rather than
// finishing after a fixed poll count, which is what keeps it to one login.
const TOTAL_MS  = 5 * 60 * 1000;
// A dead session must not spin: after this many consecutive non-200s the VU
// ends its iteration (and ramping-vus may start a fresh one, re-authenticating
// deliberately). Without a bound, a failure cascade would reintroduce exactly
// the re-login amplification this change removes.
const MAX_CONSEC_FAILURES = 3;
const logins = new Counter("leaderboard_logins");

export const options = {
  scenarios: {
    leaderboard_hammering: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: Math.ceil(VU_COUNT * 0.25) },
        { duration: "1m", target: Math.ceil(VU_COUNT * 0.5) },
        { duration: "1m", target: VU_COUNT },
        { duration: "2m", target: VU_COUNT },   // Steady state
        { duration: "30s", target: 0 },
      ],
      exec: "default",
    },
  },
  thresholds: {
    "leaderboard": ["p(90)<3000", "p(95)<5000", "avg<2000"],
    "http_req_failed": ["rate<0.01"],
  },
};

export default function () {
  const participant = getParticipant(__VU, seedData);
  const { csrfToken, ok } = loginParticipant(BASE_URL, participant.email, participant.password);
  logins.add(1);
  if (!ok) {
    // Back off HARD. The original 5 s retry meant 20 VUs re-attempted at
    // ~4 logins/s the moment the target started refusing them — the harness
    // amplifying its own saturation, and the reason auth stayed at 64% of the
    // request mix even after the per-iteration login was removed. A real
    // client that cannot sign in does not retry twelve times a minute.
    sleep(20 + Math.random() * 20);
    return;
  }

  // Select competition
  mutateWithRetry("post", `${BASE_URL}/api/select-competition`,
    { competitionId: seedData.competitionId }, csrfToken, BASE_URL);

  // Poll the board for the remainder of the run on this one session. k6 resets
  // a VU's cookie jar between iterations, so keeping the session means keeping
  // the iteration open — hence a deadline rather than a fixed poll count.
  let consecFailures = 0;
  while (exec.instance.currentTestRunDuration < TOTAL_MS - 2000) {
    const res = get(`${BASE_URL}/api/leaderboard`, { tags: { name: "leaderboard" } });
    leaderboard.add(res.timings.duration);
    if (res.status === 200) {
      consecFailures = 0;
    } else if (++consecFailures >= MAX_CONSEC_FAILURES) {
      break;                       // session is genuinely gone; let the VU restart
    }
    sleep((POLL_MS / 1000) * (0.75 + Math.random() * 0.5));  // jitter, so VUs don't lock-step
  }
}
