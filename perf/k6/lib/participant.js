import { sleep } from "k6";
import { get, safeJson } from "./http.js";
import { mutateWithRetry } from "./csrf.js";
import {
  pageLoad, selectComp, taskList, taskDetail, submitAnswer,
  revealHint, leaderboard, pulsePoll,
  correctSubmissions, wrongSubmissions, staleSubmissions, hintsRevealed, sessionErrors,
} from "./metrics.js";
import { shuffle } from "./data.js";

// v6.12.10 — chunked sleep so `maybeKeepalive` has a chance to fire at
// ~60-s cadence even during a long "thinking" pause. Pre-v6.12.10 the
// participant's task loop called `maybeKeepalive` once at the top of
// each task iteration (participant.js line 82), then went into
// `sleep(30 + Math.random()*270)` — up to 300 s uninterrupted — plus
// subsequent submit/wait chains, stretching the gap between two
// actual keepalive CALLS to as much as 7-8 minutes per task iteration.
// The 5-minute keepalive debounce means a ping fires every ~7-8
// minutes at best. On a 65-min iteration under the full-scale k6 run,
// a combination of k6 HTTP queue backpressure + k6 cookie-jar edge
// cases + network hiccups accumulates and the 60-min cookie TTL
// expires before the next keepalive fires.
//
// This helper slices `sleep(N)` into chunks of ≤60 s and calls
// `maybeKeepalive` between each chunk. The 5-min debounce inside
// `maybeKeepalive` still gates the actual HTTP ping frequency — this
// just guarantees the debounce is evaluated at least once per minute
// of wall clock, so a ping fires the moment the 5-min window elapses
// rather than at the end of the current task body. Result: keepalive
// cadence converges to its debounce limit (~5 min) regardless of
// `sleep()` call patterns in the caller.
function sleepWithKeepalive(seconds, maybeKeepalive) {
  let remaining = seconds;
  while (remaining > 0) {
    const chunk = remaining > 60 ? 60 : remaining;
    sleep(chunk);
    remaining -= chunk;
    if (maybeKeepalive) maybeKeepalive();
  }
}

// v7.2.x — idle back-off for a participant with nothing left to do: the
// competition has ended, or they've already solved every task. Without it, such
// an iteration finishes in ~16 s (login → see all tasks solved → logout), so a
// VU re-logs-in ~4×/min for the rest of the run — degenerate load that inflates
// iteration counts and, if a per-IP rate limit is active, trips the login
// limiter. A real finished participant lingers on the leaderboard; this models
// that with a randomised 0.5–1.5× back-off (default ~45–135 s). Env-tunable via
// ENDED_BACKOFF_S; set to 0 to restore the old tight-loop behaviour.
const ENDED_BACKOFF_S = parseInt(__ENV.ENDED_BACKOFF_S || "90", 10);
function idleBackoff() {
  if (ENDED_BACKOFF_S > 0) sleep(ENDED_BACKOFF_S * (0.5 + Math.random()));
}

/**
 * Participant behavior state machine.
 * Simulates a realistic participant during a live competition.
 *
 * @param {string} baseUrl
 * @param {string} csrfToken - current CSRF token (may be updated by retries)
 * @param {object} seedData - seed data with tasks and competition info
 * @param {object} loginData - login response data
 */
export function runParticipant(baseUrl, csrfToken, seedData, loginData) {
  let csrf = csrfToken;

  // v6.10.53 — session-keepalive tracker hoisted above the pollUntilLive
  // call (was defined just before the task loop). Session cookies expire
  // at 60 min with rolling:false, so long-running VUs must hit
  // /api/session/keepalive or get 401'd. Under the full-scale 15-min
  // start offset + ramp, a VU can spend 15-20 min inside pollUntilLive
  // alone — if keepalive fires only afterward, the session has already
  // expired and the first post-live request gets 401. Pre-v6.10.53 the
  // perf run reported session_errors=48 vs a <5 threshold, mostly
  // these pre-live expiries. Defining maybeKeepalive up-front lets
  // pollUntilLive ping it on the same cadence the task loop uses.
  //
  // v6.10.67 — interval tightened 10 min → 5 min. v6.10.63's 210-min
  // perf run reported session_errors=347 and iteration_duration max
  // = 67 min. Keepalive at 10 min meant a VU stuck in pollUntilLive
  // (20-min cap) or a long task-think/submit chain could reach the
  // 60-min session TTL between keepalive pings. 5 min halves the
  // window so a single missed beat (network hiccup, browser-probe
  // starving the event loop, etc.) can't push past the TTL. Cost:
  // one extra /api/session/keepalive per VU per 5 min — at 300 VUs
  // that's +1 req/s spread across the whole run, rounding error
  // against the 100+ req/s baseline.
  // v6.12.10 — maybeKeepalive now returns false on a 401/403 response
  // so callers can detect a dead session immediately and bail out of
  // the current task loop. The outer k6 scenario re-enters
  // `participantScenario` on every iteration, so bailing triggers a
  // fresh login on the next iter. Pre-v6.12.10 maybeKeepalive returned
  // undefined and the caller had to wait until the next task-detail
  // GET to pick up the 401 — typically 5-7 minutes of dead-session
  // requests accumulating 401s on status-poll / leaderboard / submit
  // before the task-detail gate finally caught it.
  let lastKeepalive = Date.now();
  let sessionDead = false;
  // v7.2.x — tightened 5 min → 3 min (env KEEPALIVE_INTERVAL_S). A 240-min /
  // 300-VU run with a full 30-task active phase had iterations of 60-90 min
  // (max 66 min) and reported session_errors=315 + csrf_failures=168: a long
  // active iteration occasionally outran the 60-min session TTL when k6's HTTP
  // queue (worse under high VU count, and worse still over WAN RTT) delayed a
  // beat. 3 min widens the margin to the TTL (and is closer to a real active
  // user, whose browser keepalives on every interaction — far more often than
  // every 5 min). Cost is trivial: ~1.7 keepalives/VU per 5 min vs 1, a rounding
  // error against the 50-170 req/s baseline. Harness-only — the server's session
  // TTL is unchanged; this just stops the simulation manufacturing session churn
  // a real user wouldn't hit.
  const _KEEPALIVE_INTERVAL_MS = (parseInt(__ENV.KEEPALIVE_INTERVAL_S || "180", 10)) * 1000;
  const maybeKeepalive = () => {
    if (sessionDead) return false;
    if (Date.now() - lastKeepalive < _KEEPALIVE_INTERVAL_MS) return true;
    const r = mutateWithRetry("post", `${baseUrl}/api/session/keepalive`, {}, csrf, baseUrl, { name: "session-keepalive" });
    if (r._newCsrfToken) csrf = r._newCsrfToken;
    lastKeepalive = Date.now();
    if (r.status === 401 || r.status === 403) {
      sessionDead = true;
      sessionErrors.add(1);
      return false;
    }
    return true;
  };

  // Load initial page (static assets)
  const pageRes = get(`${baseUrl}/`, { tags: { name: "page-load" } });
  pageLoad.add(pageRes.timings.duration);

  // Select competition
  const compRes = mutateWithRetry("post", `${baseUrl}/api/select-competition`,
    { competitionId: seedData.competitionId }, csrf, baseUrl, { name: "select-competition" });
  selectComp.add(compRes.timings.duration);
  if (compRes._newCsrfToken) csrf = compRes._newCsrfToken;

  // Fetch task list
  const tasksRes = get(`${baseUrl}/api/tasks`, { tags: { name: "task-list" } });
  taskList.add(tasksRes.timings.duration);

  // Wait for competition to start (poll status). v6.10.38 — abort the
  // iteration if pollUntilLive gives up: the subsequent submit/hint/
  // leaderboard calls all require a live comp and would otherwise
  // bang against a 403 gate for the rest of the iteration, recording
  // failure-path timings that pollute the real-traffic baselines.
  // v6.10.53 — pass maybeKeepalive so long live-waits don't expire
  // the session (see hoisted-definition comment above).
  // v7.2.x — pollUntilLive returns false when the comp is ended (or, early in
  // ramp, still upcoming after the 20-min budget). Back off before returning so
  // the VU doesn't immediately re-login into the same dead/ended state.
  if (!pollUntilLive(baseUrl, maybeKeepalive)) { idleBackoff(); return; }

  // Randomize task order
  const tasks = shuffle(seedData.tasks);

  // v7.2.x — track whether this iteration did REAL work (touched an unsolved
  // task) and whether the comp ended mid-loop, to drive the post-loop back-off.
  let didWork = false;
  let ended = false;

  // Solve tasks with realistic behavior
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!maybeKeepalive()) return;

    // View task detail
    const detailRes = get(`${baseUrl}/api/tasks/${task.id}`, { tags: { name: "task-detail" } });
    taskDetail.add(detailRes.timings.duration);
    if (detailRes.status === 401) { sessionErrors.add(1); return; }

    // v6.10.73 — safeJson returns null on transport-null body; treat
    // that as "unknown state" and skip the iteration rather than
    // crashing the goja runtime.
    const detail = safeJson(detailRes);
    if (!detail) { sessionErrors.add(1); return; }
    if (detail.solved) continue;
    didWork = true; // an unsolved task → this iteration is doing genuine load
    // v8.9.1 — the detail payload carries the challenge's GRADING HASH, and the
    // submit route has REQUIRED it since v7.20.9: a submission without one is
    // treated as stale and refused 409 `task_changed` (no penalty, no row). This
    // harness never sent it, so every "correct" submit below had been a refusal
    // — counted as wrong by submitCorrect's fallback — for eleven releases. The
    // hash is per task (it changes only when an admin edits the key), so it is
    // read once per detail view, exactly as the SPA does it.
    task.gradingHash = detail.grading_hash || "";

    // Thinking time: 30s to 5min — v6.12.10: chunked so keepalive
    // ticks every ~60 s of wall clock rather than going dark for the
    // full think window.
    sleepWithKeepalive(30 + Math.random() * 270, maybeKeepalive);
    if (sessionDead) return;

    // Roll for behavior
    const roll = Math.random();

    if (roll < 0.60) {
      // 60%: Submit correct answer
      csrf = submitCorrect(baseUrl, csrf, task);
    } else if (roll < 0.75) {
      // 15%: Submit wrong, then correct
      csrf = submitWrong(baseUrl, csrf, task);
      sleepWithKeepalive(30 + Math.random() * 90, maybeKeepalive);
      if (sessionDead) return;
      csrf = submitCorrect(baseUrl, csrf, task);
    } else if (roll < 0.85) {
      // 10%: Reveal hint, then submit correct
      csrf = doRevealHint(baseUrl, csrf, task);
      sleepWithKeepalive(15 + Math.random() * 45, maybeKeepalive);
      if (sessionDead) return;
      csrf = submitCorrect(baseUrl, csrf, task);
    } else if (roll < 0.95) {
      // 10%: Navigate away (skip this task)
      // Just continue to next task
    } else {
      // 5%: Submit wrong 2-3 times, never solve
      const wrongCount = 2 + Math.floor(Math.random() * 2);
      for (let w = 0; w < wrongCount; w++) {
        csrf = submitWrong(baseUrl, csrf, task);
        sleepWithKeepalive(20 + Math.random() * 40, maybeKeepalive);
        if (sessionDead) return;
      }
    }

    // Between tasks: occasional leaderboard check (30% chance)
    if (Math.random() < 0.30) {
      const lbRes = get(`${baseUrl}/api/leaderboard`, { tags: { name: "leaderboard" } });
      leaderboard.add(lbRes.timings.duration);
      if (lbRes.status === 401) { sessionErrors.add(1); return; }
    }

    // The pulse: the participant's one regular poll, as in the SPA. Its
    // `status` member is the /api/status body.
    const stRes = get(`${baseUrl}/api/participant/pulse`, { tags: { name: "pulse-poll" } });
    pulsePoll.add(stRes.timings.duration);
    // v6.12.10 — bail on 401 from the poll too. Pre-fix, a 401 on
    // the poll was silently absorbed (no handler), so a dead
    // session only got caught on the next iter's task-detail — up to
    // one full task-body's worth of wasted dead-session traffic.
    if (stRes.status === 401) { sessionErrors.add(1); return; }

    // Check if competition ended. /api/status response (v6.x onward)
    // returns a flat shape: `{status, start, end, competition_name,
    // competition_fully_ended, ...}` — the old nested
    // `status.competition.status` shape was from an earlier spec.
    // v6.10.73 — safeJson gives null on transport-null body; treat the
    // null as "can't tell, carry on" (don't break out of the loop on a
    // momentary hiccup).
    const status = (safeJson(stRes) || {}).status || {};
    if (status.status === "ended" || status.competition_fully_ended) { ended = true; break; }
  }

  // Final leaderboard check
  const finalLb = get(`${baseUrl}/api/leaderboard`, { tags: { name: "leaderboard" } });
  leaderboard.add(finalLb.timings.duration);

  // Some users logout (50%)
  if (Math.random() < 0.5) {
    mutateWithRetry("post", `${baseUrl}/api/logout`, {}, csrf, baseUrl, { name: "logout" });
  }

  // v7.2.x — if the comp ended, or the field has solved out (every task already
  // solved → no real work this pass), idle before the iteration returns so the
  // re-login cadence drops from ~16 s to ~1–2 min. Represents a finished user
  // lingering on the board rather than a bot re-logging-in in a tight loop.
  if (ended || !didWork) idleBackoff();
}

function submitCorrect(baseUrl, csrf, task) {
  // v8.9.1 — `gradingHash` rides every submit (see the detail read above).
  const res = mutateWithRetry("post", `${baseUrl}/api/tasks/${task.id}/submit`,
    { answer: task.correctAnswer, gradingHash: task.gradingHash }, csrf, baseUrl, { name: "submit-answer" });
  submitAnswer.add(res.timings.duration);
  if (res._newCsrfToken) csrf = res._newCsrfToken;
  // v6.10.73 — wrapped json() returns null on transport error (see
  // _wrap in csrf.js). Treat null as "unknown — assume wrong" rather
  // than crashing (the v6.10.72 run's one VU stack trace was here,
  // where `const body = res.json(); body.correct` blew up on null).
  const body = res.json() || {};
  // v8.9.1 — a 409 `task_changed` is NOT a wrong answer: it is the server
  // refusing to grade at all (stale or missing hash). Counting it as wrong is
  // how the missing-hash defect stayed invisible — the scenario reported a
  // plausible wrong-answer rate over a submit path that graded nothing. It
  // gets its own counter, and a threshold on it (competition-live) so the
  // next regression of this shape fails the run rather than colouring it.
  if (res.status === 409 && body.task_changed) { staleSubmissions.add(1); return csrf; }
  if (body.correct) correctSubmissions.add(1);
  else wrongSubmissions.add(1); // answer might have been wrong if task was already solved
  return csrf;
}

function submitWrong(baseUrl, csrf, task) {
  const wrongAnswer = `wrong-${Math.random().toString(36).slice(2, 8)}`;
  const res = mutateWithRetry("post", `${baseUrl}/api/tasks/${task.id}/submit`,
    { answer: wrongAnswer, gradingHash: task.gradingHash }, csrf, baseUrl, { name: "submit-answer" });
  submitAnswer.add(res.timings.duration);
  if (res._newCsrfToken) csrf = res._newCsrfToken;
  const body = res.json() || {};
  if (res.status === 409 && body.task_changed) { staleSubmissions.add(1); return csrf; }
  wrongSubmissions.add(1);
  return csrf;
}

function doRevealHint(baseUrl, csrf, task) {
  const res = mutateWithRetry("post", `${baseUrl}/api/tasks/${task.id}/hint`,
    {}, csrf, baseUrl, { name: "reveal-hint" });
  revealHint.add(res.timings.duration);
  if (res._newCsrfToken) csrf = res._newCsrfToken;
  hintsRevealed.add(1);
  return csrf;
}

function pollUntilLive(baseUrl, maybeKeepalive) {
  // Poll status every 5 s until competition is live; returns true when
  // live, false if the timeout elapsed. /api/status is flat-shaped:
  // `{status, start, end, ...}` — the old nested `d.competition.status`
  // / `d.started` checks would never match, so VUs quietly idled for
  // the full budget then pushed submissions against an "upcoming"
  // competition that rightly returned 403.
  //
  // v6.10.38 — timeout raised from 5 min (60 iter) → 20 min (240 iter).
  // Full-scale seed uses `--competition-start-offset 900` (15 min); a
  // VU ramping in at t=0 would blow past the old 5-min cap and proceed
  // with submissions against an upcoming comp. 20 min covers any
  // realistic offset plus ramp-up buffer. Returning a bool lets the
  // caller skip the task loop rather than banging against a dead gate.
  //
  // v6.10.53 — accept a `maybeKeepalive` callback and invoke it every
  // loop iteration. /api/status is not a keepalive itself (the session
  // probe endpoints specifically don't reset the 60-min expiry window
  // on their own); without this, VUs that spent 15-20 min inside the
  // poll would hit their session-expiry on the first post-live call
  // and record a session_errors entry. maybeKeepalive handles its own
  // ~10-min debouncing internally, so calling it every 5 s costs a
  // trivial `if (Date.now() - lastKeepalive < ...) return` most times.
  for (let i = 0; i < 240; i++) {
    const res = get(`${baseUrl}/api/participant/pulse`, { tags: { name: "pulse-poll" } });
    pulsePoll.add(res.timings.duration);
    // v6.10.73 — safeJson on transport-null body. A momentary network
    // hiccup just means "keep polling" rather than "crash the poller".
    const d = (safeJson(res) || {}).status || {};
    if (d.status === "live") return true;
    // v7.2.x — an ended comp will never become live again in this run, so stop
    // polling immediately instead of burning the full 20-min budget (the caller
    // backs off and ends the iteration). Only "upcoming" warrants waiting.
    if (d.status === "ended" || d.competition_fully_ended) return false;
    if (maybeKeepalive) maybeKeepalive();
    sleep(5);
  }
  return false;
}
