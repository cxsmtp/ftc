import { sleep } from "k6";
import { get } from "./http.js";
import { mutateWithRetry } from "./csrf.js";
import {
  adminParticipants, adminLeaderboard, adminSubmissions,
  adminHistoryComp, adminHistoryUser,
  adminAnalyticsGlobal, adminAnalyticsComp, adminLogs, adminLogsAccess,
  overviewPulse, sessionErrors,
} from "./metrics.js";

// v6.12.11 — admin-side keepalive + 401/403 bail, mirroring the v6.12.10
// participant.js pattern. Pre-fix neither admin scenario called
// /api/session/keepalive nor handled 401/403 responses — so the 60-min
// absolute session TTL killed the admin/log-admin VU's session and the
// loop then banged against the dead session emitting a 403 every 10-30 s
// for the rest of the test (observed in the 70-min LAN run: vu=17 iter=0
// emitting [endpoint-403] path=admin-logs at 12-s cadence, hours after
// session death, with no re-login ever attempted).
//
// Factory so both runAdmin + runLogAdmin share one implementation. Each
// invocation returns a `{ maybeKeepalive, isDead, csrf }` triple:
//   * `maybeKeepalive()` — call at the top of every loop body. Pings
//     /api/session/keepalive when ≥5 min have passed since the last
//     ping. Returns false on 401/403 (session dead → caller returns so
//     k6 starts a fresh iter + fresh login). Returns true otherwise.
//   * `isDead()` — cheap read of the flag for call sites that want to
//     bail without re-issuing a keepalive (e.g. after a 401/403 on an
//     ordinary GET).
//   * `csrf` — returned via a getter because mutateWithRetry may issue
//     a new token on CSRF-error retry; the caller's closure-local csrf
//     variable needs to pick the update up.
//
// 5-min debounce matches participant.js. Session TTL is 60 min; debouncing
// at 5 min gives 12 pings per hour of runtime with cumulative ~1 req/s at
// 5 admin VUs × 2 admin types — rounding error against the 100+ req/s
// baseline of the protocol VUs.
function createKeepalive(baseUrl, csrfToken) {
  let csrf = csrfToken;
  let lastKeepalive = Date.now();
  let sessionDead = false;
  const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
  const maybeKeepalive = () => {
    if (sessionDead) return false;
    if (Date.now() - lastKeepalive < KEEPALIVE_INTERVAL_MS) return true;
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
  return {
    maybeKeepalive,
    isDead: () => sessionDead,
    markDead: () => { sessionDead = true; sessionErrors.add(1); },
    getCsrf: () => csrf,
  };
}

/**
 * Admin polling loop — simulates an admin watching participants, rankings,
 * analytics, and logs during a live event. Cadence roughly matches what the
 * UI itself drives (auto-refresh on the tab the admin is viewing).
 *
 * Cycle layout:
 *   every cycle  — Participants, Leaderboard, Submissions (the default tabs
 *                  an admin keeps open)
 *   every 2nd    — Analytics Challenges (competition scope) + Logs stream
 *                  — these are the heaviest read endpoints the admin dashboard
 *                    exposes; polling them at half the cadence matches a
 *                    realistic "look at analytics briefly, then back to
 *                    leaderboard" operator pattern without dominating the
 *                    request mix.
 *   every 3rd    — History dialogs (competition + random user event log)
 *                  AND global-scope analytics (cross-competition aggregates,
 *                  the heaviest variant — walks challenge_events without a
 *                  competition filter).
 */
export function runAdmin(baseUrl, csrfToken, seedData) {
  const compId = seedData.competitionId;
  let cycle = 0;
  // v6.12.11 — session keepalive + 401/403 bail; see createKeepalive.
  const ka = createKeepalive(baseUrl, csrfToken);

  while (true) {
    if (!ka.maybeKeepalive()) return;

    // Participants list
    const pRes = get(`${baseUrl}/api/admin/participants?competitionId=${compId}&limit=200`,
      { tags: { name: "admin-participants" } });
    adminParticipants.add(pRes.timings.duration);
    if (pRes.status === 401 || pRes.status === 403) { ka.markDead(); return; }

    // Admin leaderboard
    const lbRes = get(`${baseUrl}/api/admin/leaderboard?competitionId=${compId}`,
      { tags: { name: "admin-leaderboard" } });
    adminLeaderboard.add(lbRes.timings.duration);
    if (lbRes.status === 401 || lbRes.status === 403) { ka.markDead(); return; }

    // Submissions feed — paginated from v6.3.0 (limit=100 matches the default
    // page size the Submissions tab UI requests).
    const subRes = get(`${baseUrl}/api/admin/submissions?competitionId=${compId}&limit=100`,
      { tags: { name: "admin-submissions" } });
    adminSubmissions.add(subRes.timings.duration);
    if (subRes.status === 401 || subRes.status === 403) { ka.markDead(); return; }

    // Every 2nd cycle: Analytics tab (competition scope) + Logs stream —
    // both represent meaningful admin work during a live event and need
    // to be represented in the perf mix.
    if (cycle % 2 === 0) {
      const aCompRes = get(`${baseUrl}/api/admin/analytics/challenges?scope=competition&competitionId=${compId}`,
        { tags: { name: "admin-analytics-competition" } });
      adminAnalyticsComp.add(aCompRes.timings.duration);
      if (aCompRes.status === 401 || aCompRes.status === 403) { ka.markDead(); return; }

      // Default Logs tab view: last page of the "app" stream, no filter.
      const logsRes = get(`${baseUrl}/api/admin/logs?stream=app&limit=50`,
        { tags: { name: "admin-logs" } });
      adminLogs.add(logsRes.timings.duration);
      if (logsRes.status === 401 || logsRes.status === 403) { ka.markDead(); return; }
    }

    // Every 3rd cycle: sample history dialog + global-scope analytics
    if (cycle % 3 === 0) {
      const chRes = get(`${baseUrl}/api/admin/competitions/${compId}/events`,
        { tags: { name: "admin-competition-events" } });
      adminHistoryComp.add(chRes.timings.duration);
      if (chRes.status === 401 || chRes.status === 403) { ka.markDead(); return; }
      // Pick a random participant from the page and fetch their event history
      const participants = (pRes.json() || {}).participants || [];
      if (participants.length) {
        const p = participants[Math.floor(Math.random() * participants.length)];
        const uhRes = get(`${baseUrl}/api/admin/participants/${p.id}/events`,
          { tags: { name: "admin-user-events" } });
        adminHistoryUser.add(uhRes.timings.duration);
        if (uhRes.status === 401 || uhRes.status === 403) { ka.markDead(); return; }
      }
      // Global-scope analytics — the heaviest variant (no competition filter,
      // scans every row in challenge_events). Admins hit this when reviewing
      // cross-event trends.
      const aGlobalRes = get(`${baseUrl}/api/admin/analytics/challenges?scope=global&periodPreset=all`,
        { tags: { name: "admin-analytics-global" } });
      adminAnalyticsGlobal.add(aGlobalRes.timings.duration);
      if (aGlobalRes.status === 401 || aGlobalRes.status === 403) { ka.markDead(); return; }
    }
    cycle++;

    // Check if competition ended
    const lbData = lbRes.json();
    if (lbData && lbData.error) break; // competition may have ended

    // Poll interval: 15-30s
    sleep(15 + Math.random() * 15);
  }
}

/**
 * Log-watching admin VU (v6.10.21) — represents an admin whose tab is
 * pinned to the Logs pane during a live event. Starts in the app/event
 * stream at the UI-default limit=50, switches to the access stream at
 * limit=500 (the heavier request — ~10× the bytes + a different log
 * file), and switches back, alternating until the scenario ends.
 * Cadence is 10-15s, tighter than the main dashboard admin's 15-30s
 * because an operator actively watching logs refreshes more often.
 *
 * Phase durations default to 3-5 min (randomised per phase) so the
 * mix across a 10-min test lands at roughly 2 events / 1 access / 2
 * events and across a 210-min full run at ~30 phase switches. The
 * randomisation is deliberate — uniform phase lengths would align
 * every log-admin VU on the same switch instants, producing a
 * synthetic thundering-herd pattern that doesn't match real ops.
 */
export function runLogAdmin(baseUrl, csrfToken, seedData) {
  let stream = "app";
  let phaseStart = Date.now();
  let phaseMs = 3 * 60_000 + Math.random() * 2 * 60_000;
  let phases = 0;
  // v6.12.11 — session keepalive + 401/403 bail; see createKeepalive.
  // Pre-fix the loop only handled 429 (backoff) and 5xx (break); a 403
  // after the 60-min session-TTL went silently unhandled and the VU
  // looped forever emitting [endpoint-403] path=admin-logs at 10-15 s
  // cadence (observed for 70+ min on a single vu=17 iter=0 during a
  // LAN sustained run). With the keepalive the session stays alive
  // under normal operation; with the 401/403 bail the VU returns
  // immediately on any stale-session response so k6 starts a fresh
  // iteration with a fresh login.
  const ka = createKeepalive(baseUrl, csrfToken);

  while (true) {
    if (!ka.maybeKeepalive()) return;

    const isAccess = stream === "access";
    const limit = isAccess ? 500 : 50;
    const metric = isAccess ? adminLogsAccess : adminLogs;
    const tagName = isAccess ? "admin-logs-access" : "admin-logs";
    const res = get(
      `${baseUrl}/api/admin/logs?stream=${stream}&limit=${limit}`,
      { tags: { name: tagName } },
    );
    metric.add(res.timings.duration);

    // Rate-limit (60/min/IP) or server error → back off + stop so the
    // VU doesn't hammer a degraded endpoint.
    if (res.status === 429) { sleep(60); continue; }
    if (res.status >= 500) break;
    // v6.12.11 — bail on 401/403 so k6 re-enters logAdminScenario and
    // re-logs in. Previously this branch fell through to the sleep and
    // looped indefinitely against a dead session.
    if (res.status === 401 || res.status === 403) { ka.markDead(); return; }

    // Phase switch when the timer elapses.
    if (Date.now() - phaseStart >= phaseMs) {
      stream = isAccess ? "app" : "access";
      phaseStart = Date.now();
      phaseMs = 3 * 60_000 + Math.random() * 2 * 60_000;
      phases++;
    }

    // 10-15s refresh cadence.
    sleep(10 + Math.random() * 5);
  }
}

/**
 * An organiser with the event's workspace Overview open: the SPA reads
 * GET /api/admin/competitions/:id/overview-pulse on the workspace's 15 s events
 * poll while the Overview is on screen, uncached, about ten index-range passes
 * over the event's rows per read. Each ORGANISERS VU is one open tab.
 */
export function runOrganiser(baseUrl, csrfToken, seedData) {
  const compId = seedData.competitionId;
  const ka = createKeepalive(baseUrl, csrfToken);
  while (true) {
    if (!ka.maybeKeepalive()) return;
    const res = get(`${baseUrl}/api/admin/competitions/${compId}/overview-pulse`,
      { tags: { name: "overview-pulse" } });
    overviewPulse.add(res.timings.duration);
    if (res.status === 429) { sleep(60); continue; }
    if (res.status >= 500) break;
    if (res.status === 401 || res.status === 403) { ka.markDead(); return; }
    sleep(15);
  }
}
