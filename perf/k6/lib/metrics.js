import { Trend, Counter } from "k6/metrics";

// API-level timings (protocol VUs)
export const pageLoad       = new Trend("page_load", true);
export const loginFlow      = new Trend("login_flow", true);
export const selectComp     = new Trend("select_competition", true);
export const taskList       = new Trend("task_list", true);
export const taskDetail     = new Trend("task_detail", true);
export const submitAnswer   = new Trend("submit_answer", true);
export const revealHint     = new Trend("reveal_hint", true);
export const leaderboard    = new Trend("leaderboard", true);
// The participant's one regular poll (GET /api/participant/pulse), which
// replaced /api/status, /api/me and /api/session/status in the SPA.
export const pulsePoll      = new Trend("pulse_poll", true);
export const csrfFetch      = new Trend("csrf_fetch", true);
export const adminParticipants = new Trend("admin_participants", true);
export const adminLeaderboard  = new Trend("admin_leaderboard", true);
export const adminSubmissions  = new Trend("admin_submissions", true);
export const adminHistoryComp  = new Trend("admin_history_competition", true);
export const adminHistoryUser  = new Trend("admin_history_user", true);
// Analytics tab — admin Analytics pane pulls /api/admin/analytics/challenges
// in both the global (all-time/all-competitions) and competition-scoped
// modes. Heaviest single call the admin dashboard makes — aggregates over
// the challenge_events table, joins tasks, filters tags/difficulties.
export const adminAnalyticsGlobal = new Trend("admin_analytics_global", true);
export const adminAnalyticsComp   = new Trend("admin_analytics_competition", true);
// Logs viewer — walks rotated JSONL files on disk. The cost scales with
// file size × file count, so this is a realistic representation of an
// admin reviewing events during a live competition.
//
// v6.10.21: two separate trends for the two streams.
//   admin_logs           — app/event stream, typical UI default (limit=50).
//   admin_logs_access    — access/HTTP stream with limit=500, the heavier
//                          request the new log-admin scenario alternates to.
export const adminLogs       = new Trend("admin_logs", true);
export const adminLogsAccess = new Trend("admin_logs_access", true);
// The event workspace Overview's live read, polled every 15 s by each open
// organiser tab (GET /api/admin/competitions/:id/overview-pulse; ORGANISERS VUs).
export const overviewPulse   = new Trend("overview_pulse", true);

// Browser rendering timings (probe VUs)
export const browserPageLoad     = new Trend("browser_page_load", true);
export const browserLoginRender  = new Trend("browser_login_render", true);
export const browserCompSelect   = new Trend("browser_comp_select_render", true);
export const browserTaskList     = new Trend("browser_task_list_render", true);
export const browserTaskDetail   = new Trend("browser_task_detail_render", true);
export const browserSubmit       = new Trend("browser_submit_render", true);
export const browserLeaderboard  = new Trend("browser_leaderboard_render", true);

// Counters
export const correctSubmissions  = new Counter("correct_submissions");
export const wrongSubmissions    = new Counter("wrong_submissions");
// v8.9.1 — a submit the server REFUSED TO GRADE (409 task_changed: stale or
// missing grading hash). Kept apart from wrong_submissions on purpose: from
// v7.20.9 to v8.9.0 every "correct" submit in this harness was one of these,
// and folding them into "wrong" is what made that invisible for eleven releases.
export const staleSubmissions    = new Counter("stale_submissions");
export const hintsRevealed       = new Counter("hints_revealed");
export const csrfFailures        = new Counter("csrf_failures");
export const sessionErrors       = new Counter("session_errors");
export const sqliteBusyErrors    = new Counter("sqlite_busy_errors");

// v6.10.33 — counts any non-2xx/3xx response, tagged by status code. The
// built-in `http_req_failed` rolls 401s from pre-login /api/me polls, 503s
// from requests that forgot the maintenance-bypass header, and real 5xx
// server errors all into one number — which makes the top-line rate
// useless for diagnosis. `failed_by_status` preserves the breakdown so
// an operator can see whether a spike is "expected 401s" or "new 500s".
export const failedByStatus      = new Counter("failed_by_status");

// v6.10.84 — 403-only attribution Counter keyed on request-name tag so
// the summary surfaces per-endpoint counts without enumerating every
// (status, name) pair in the threshold list. The v6.10.83 WAN run hit
// 1829× 403 with zero per-route attribution — neither `failed_by_status`
// (tagged on status only) nor `http_req_failed` (rate only) could answer
// "which endpoint is 403-ing?". This Counter is written by the 403
// branch in http.js/classify(); the competition-live scenario declares
// `count>=0` thresholds for each expected admin/participant endpoint
// name so every route that produces ≥1 × 403 renders in the summary.
export const failed403ByName    = new Counter("failed_403_by_name");

// v6.10.62 — counts each browser-probe phase entry, tagged by phase name
// (init, page_load, login_fill, login_submit, comp_select, wait_live,
// comp_click, task_list, task_detail, task_submit, leaderboard,
// cycle_pause). The v6.10.61 results showed `browser_leaderboard_render`
// + `browser_submit_render` both at p(90)=0.00µs — meaning the probes
// gracefully skipped those phases (or crashed before reaching them) and
// the missing trend rendered as zero, indistinguishable from "ran fast".
// This counter makes phase progression directly diagnosable: phases that
// every probe reached show high counts, phases the probes died before
// show zero. Pairs with the existing browser_*_render trends — together
// they answer "did it run AND was it fast" instead of just one or the
// other.
export const browserPhasesReached = new Counter("browser_phases_reached");

// v6.10.62 — per-phase CLS contribution. The v6.10.55 local CLS probe
// measured 0.0576 across the full flow; the v6.10.61 WAN run measured
// 0.75 (13× amplification) but the existing `browser_web_vital_cls`
// trend is a single end-of-iteration number — it can't tell you which
// phase generated the bulk of the shift. This per-phase trend is read
// at every `enterPhase()` call from a `PerformanceObserver` installed
// in the page, attributing the delta in cumulative CLS to the phase
// the probe was JUST in (i.e. CLS during phase N is recorded when
// enterPhase(N+1) is called). The next perf run will show which
// phases are the dominant CLS contributors on the WAN box, so the
// follow-up fix can target the right surface (header / comp-grid /
// task-grid / podium).
export const browserClsPerPhase = new Trend("browser_cls_per_phase");

// v6.10.84 — counts browser-probe click failures tagged by phase. The
// v6.10.83 WAN run's `browser_phases_reached{task_submit}=124/162`
// (76.5 % of probes that ran the submit phase ever reached it) had no
// corresponding error signal — `safeClick`'s failure path warns to
// stdout but doesn't record a metric, so "24 % of probes skipped
// submit" was only visible by subtracting phase counts. This Counter
// tags each failed .click() dispatch with its phase so the summary
// renders a direct "clicks failed by phase" column alongside the
// phases-reached table. Pairs with the existing `safeClick` caller
// pattern — no behaviour change, just the metric.
export const browserClickFailures = new Counter("browser_click_failures");

// v6.12.2 — counts browser-probe `waitForSelector` timeouts tagged by
// phase. The v6.10.93 WAN run had `browser_leaderboard_render=0.00µs`
// across 66 leaderboard phase entries: every single waitForSelector
// hit the 30-s ceiling. Pre-v6.12.2 this was only inferable by
// subtracting "phases reached" from "renders recorded"; now it's a
// first-class metric with the same phase tag vocabulary as
// `browser_phases_reached` + `browser_click_failures`. Fires in the
// `.catch()` branch of every `waitForSelector(..., {timeout:N})` that
// the probe currently swallows silently (task_list, task_detail,
// leaderboard). Distinguishing "phase entered + render succeeded" from
// "phase entered + render timed out" turns the 0.00µs metric into an
// actionable "the probe hit its ceiling under load" signal.
export const browserPhaseTimeouts = new Counter("browser_phase_timeouts");

// v6.12.3 — waitForSelector duration captured on EVERY call, including
// timeouts, tagged by {phase, result}. The existing
// `browser_*_render` trends only record on successful selector match;
// `browser_phase_timeouts` only counts timeouts. Neither answers the
// sharper question: "when a leaderboard selector times out, is it
// hitting exactly the 30 s ceiling (LG-internal or server stall) or
// bailing earlier around 10-15 s (render started but got interrupted)?"
// This Trend captures the full distribution. On timeout the value
// will cluster near the timeout parameter (30000 ms for leaderboard,
// 10000 for task_list, 5000 for task_detail); if something shorter
// emerges, the behaviour isn't "hit the ceiling" and needs different
// investigation. On success it's the actual render latency.
export const browserWaitForSelectorMs = new Trend("browser_waitforselector_ms", true);

// v6.12.3 — browser-side HTTP request failure attribution by URL kind.
// The v6.10.93 WAN run showed `browser_http_req_failed = 12.33%` (339
// of 2749 browser requests failed) without attribution — could have
// been SPA-shell HTML, CSS/JS assets, API endpoints, or external
// (fonts.googleapis, cdnjs.cloudflare). Fires via page.on('response')
// for any status>=400 and page.on('requestfailed') for transport-layer
// failures. Tagged by a coarse URL kind so the summary produces a
// breakdown like "spa_shell=0 api=5 asset=334 external=0" which
// immediately localises the failure class (edge throttling of asset
// fetches vs server-side 5xx on API vs SPA shell unavailable).
export const browserRequestFailures = new Counter("browser_request_failures");
