"use strict";

// v8.15.1 — AUTOMATIC CERTIFICATES AND THE CONGRATULATIONS EMAIL.
//
// When an event becomes fully ended, every eligible participant is issued their
// certificate (if they have not collected it already) and is sent ONE email
// congratulating them, with the certificate PDF attached and a link to it.
// A Program has no common end, so its completers are dispatched one by one, at
// the correct answer that completes them.
//
// ONE DISPATCHER FOR EVERY END PATH. The end paths (End Now, the scheduler's time
// expiry, the all-solved auto-end, a session's end, deleting the last upcoming
// session, Close late entries now) do not issue or send anything themselves:
// each calls `enqueueCertificateDispatch`, which UPSERTS a row in the durable
// queue `certificate_dispatch_jobs` (keyed on the event, so a second end of the
// same event moves its row rather than adding one). The worker drains due rows.
// Everything the worker decides it decides at RUN time, against the event as it
// is then — revived since? the job is dropped and the next end re-enqueues it.
//
// NEVER TWICE. `certificate_emails` is keyed on the certificate's identity, its
// badge token, and a row is written BEFORE the send (`sending`) — so whatever
// re-runs the worker (a revive and re-end, a restart, a second end path for one
// end, the scheduler noticing an end End Now already enqueued), a certificate
// that has a row is never mailed again by the worker. Only an admin's explicit
// Resend sends one again. A NEW certificate — the first mint after a revive, or
// a re-issue after a superadmin revoke — has a new token and is mailed once.
// After a revive the certificate someone already holds is unchanged (the mint is
// idempotent and its facts are frozen), so a revive never sends a corrected one.
//
// AT MOST ONCE ACROSS A CRASH. A row still `sending` at boot was cut by a crash
// mid-send; whether the relay took it is unknowable, so it becomes `unknown` and
// is NOT retried automatically (a retry could deliver twice). The admin list
// shows it and Resend is the remedy. Graceful shutdown drains in-flight sends
// (`certificateDispatchBusy` joins the drain; each send is `trackDetachedSend`).
//
// ELIGIBILITY IS THE MINT'S OWN. The worker never re-derives who qualifies: it
// asks routes/badge.js `_autoIssueCertificate`, which runs `_mintEligibility`
// (placement 1-3, participation, completion; no dry-run event, nobody off the
// board — staff, event admins, benchmark) with `fresh:true`, because a mint
// persists rank and score. A LATE ENTRANT whose late window is still open is
// DEFERRED, not minted: a mint in the window could only issue participation and
// would keep it for ever (the mint is idempotent), so the job waits for the
// window to close. An EVENT job whose late window is still open waits for it to
// close whatever its pass found: somebody may still join, or answer for the first
// time, after the pass, and nothing else would ever issue them a certificate (the
// scheduler skips an ended event, and a window that lapses by itself is no end
// path). Close late entries now re-enqueues the job, which runs it at once.
// Blocked, denied and unapproved accounts are skipped: by the pass's own query,
// and again by every send (automatic, retry, Issue again) after its render, the
// last await (`_holderIneligible`): an account blocked, denied or no longer
// approved since, a holder no longer in the event (automatic and retry only) or a
// certificate revoked meanwhile is settled `skipped`, never retried, and gets no
// mail and no share link (sweep #212). An admin's Resend is refused instead
// (409), so the ledger keeps its last real outcome.
//
// THE EMAIL IS BULK-OPTIONAL. `certificate_awarded` is in `_BULK_EMAIL_REASONS`
// (lib/email.js): it carries List-Unsubscribe and is suppressed for an opted-out
// address. It notifies of something the holder can always collect from the
// platform (the event's Challenges page), so it is not a mail an account depends on — and a
// participant who unsubscribed from event mail asked not to receive exactly this.
// A suppression is recorded (`suppressed` in the ledger, `email_sent
// {skipped:"unsubscribed"}` on the person) and the certificate is still issued.
//
// THE SWITCH. `email.enabled` in the certificate config (defaults <- global <-
// event; lib/certificate-config.js), default ON for every kind. Off: the job is
// dropped and nothing is minted on anybody's behalf either — the participant
// collects as before. `email.subject` / `email.intro` adjust the wording.
//
// GRANDFATHERED. An attempt-kind event whose effective end precedes the first
// boot of this release (`settings.certificate_dispatch_floor_at`) is never
// dispatched, so an upgrade mails nobody about events that finished before it.
//
// RESTORED (operator ruling, 17 Nov 2026, "Choose at restore"). A restored
// database sees every event that ended after its backup was taken as newly ended.
// The restore's step 4 chooses: `scripts/restore-mail.sh mark-sent` writes
// `settings.restore_mail_floor_at` (the restore instant, only ever moved forward),
// which joins the grandfather floor (`automaticMailFloor`, the later of the two):
// an event job whose event ended before it is dropped, a Program completer's job
// queued before it is dropped (`queued_before_restore`), and a failed send first
// tried before it is not retried. `resend` writes nothing, so all of it goes out
// again. lib/team-reports.js reads the same floor (`restoreMailFloor`). An admin's
// own sends (Resend, Issue again) are explicit acts, held by neither floor.
//
// UNDER TEST nothing runs by itself: the shared test server's relay is dead by
// design, so `POST /api/test/certificate-dispatch-tick` drives one pass.

const db = require("../db");
const { now } = require("./time");
const { log } = require("./log");
const { swallowed } = require("./best-effort");
const { leaderboardComputeCount } = require("./leaderboard");
const { getCompetition, competitionFullyEnded, competitionEffectiveEnd, isDryRunCompetition } = require("./competitions");
const { eventPolicy } = require("./event-policy");
const { lateEntryWindowOpen, lateEntryDeadline } = require("./late-entry");
const { resolveCertificateConfig, certificateTier, fillTokens } = require("./certificate-config");
const { trackDetachedSend, _runBounded } = require("./util");
const { BASE_URL } = require("./config");

// Event jobs wait this long after the end before they run, so an End Now
// pressed by mistake and revived at once mails nobody (the worker re-checks the
// end at run time and drops a revived event's job).
const EVENT_SETTLE_MS = 5 * 60_000;
// A Program completion settles briefly (a recalculate or an edit right after).
const COMPLETION_SETTLE_MS = 60_000;
// How often the worker looks for due jobs and due retries.
const TICK_MS = 60_000;
// Parallel issues+sends within one pass (each is a rasterise, a PDF and SMTP).
const CONCURRENCY = 4;
// New sends one pass may start for one job before it re-arms itself, so one big
// event cannot hold a pass for minutes. A soft cap: each lane checks it before
// its issue and counts its send after, so lanes already past the check may each
// start one more (at most MAX_SENDS_PER_PASS + CONCURRENCY - 1 in a pass).
const MAX_SENDS_PER_PASS = 100;
// A failed send is retried this many times in all, then left failed for an admin.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000];
// A job whose issuing keeps failing (the rasteriser missing) is retried this long.
const RENDER_RETRY_MS = 30 * 60_000;
const MAX_JOB_PASSES = 48;
// A participant's issue that failed for any reason but the renderer (a write
// lock another process held, say) is retried this long after, by a later pass,
// at most MAX_ISSUE_RETRIES times in a row (counted in `last_error`, never in
// `passes`, which capped passes also spend). Then the pass carries on as if it
// had not failed: a failure that never clears costs that one participant their
// automatic certificate (it stays claimable), never the late entrants still to
// come, whom the late window's close issues.
const ISSUE_RETRY_MS = 5 * 60_000;
const MAX_ISSUE_RETRIES = 12;

// THE EMAIL'S PDF LINK SAYS IT CAME FROM THE EMAIL (sweep #402). Mail scanners and
// link prefetchers fetch every link in a mail, signed out, exactly as the holder's
// own click from it arrives, and the PDF route records every fetch as a download.
// The link carries `?from=email`, so routes/badge.js records those fetches
// `via: "email_link"` and History says they may be a mail scanner's rather than
// claim the holder took the certificate (the PDF is attached to the mail anyway).
// A marker, never a capability: the token in the path is the access, and the
// route answers the same with or without it. The two helpers below spell it out
// (`from=email`) rather than share constants: a query read outside /api/admin/
// must compare a literal for tests/query-param-repeated.api.spec.js to see it
// typed (Express 5 makes a repeated key an array, which equals no string, so a
// doubled marker is an ordinary download).
/** The congratulations email's link to a certificate's PDF. */
function certificateMailPdfUrl(token) {
  return `${BASE_URL}/badge/${token}/certificate.pdf?from=email`;
}
/** True when this request came through that link (the marker, exactly once). */
function isCertificateMailLink(req) {
  return !!req && req.query?.from === "email";
}

let _issuer = null;          // { issue(userId, comp, {boards}), renderPdf(row, comp), boardsFor(comp), podium(comp) } from routes/badge.js
// v8.15.1 — one board memo per JOB (keyed on its enqueue instant), kept across
// the back-to-back passes of one run (a pass that reached its send cap comes
// straight back), so ranking N participants builds each board once rather than
// once per participant or once per pass. Dropped when the job closes, defers or
// is re-armed for a TIMED retry (a render or issue failure): the boards are
// fresh when built, not final, as who counts on a board can still change (a
// `staff` or `benchmark` tag, a role, a removal), so a retry half an hour on
// ranks on boards built again. A re-end re-enqueues with a new instant, so a new
// memo. The automatic issue's write re-asks who counts and resets the memo when
// its person no longer does (routes/badge.js `_eligibilityBoards`).
const _jobBoards = new Map();
const _JOB_BOARDS_MAX = 16;
function _boardsKey(job) { return `${job.competition_id}|${job.user_id}|${job.enqueued_at}`; }
function _boardsFor(job, comp) {
  const k = _boardsKey(job);
  let b = _jobBoards.get(k);
  if (!b) {
    b = _issuer.boardsFor ? _issuer.boardsFor(comp) : null;
    _jobBoards.set(k, b);
    while (_jobBoards.size > _JOB_BOARDS_MAX) _jobBoards.delete(_jobBoards.keys().next().value);
  }
  return b;
}
let _running = null;         // the in-flight pass (single flight)
let _kickArmed = false;
let _interval = null;
let _stopping = false;

// TEST-ONLY: a park INSIDE a send (`_sendFor`), after its PDF render and before
// its re-checks (an admin Resend's `recheck`, the holder's `_holderIneligible`).
// Armed only by the NODE_ENV=test hook `POST /api/test/certificate-send-delay`
// (server.js); unarmed, `_sendFor` awaits nothing here. A render takes
// milliseconds for a test-sized certificate, so without the park a test can
// neither end an admin's session between a Resend's render and its re-check nor
// stop the server while a pass is inside a send. Its OWN state, apart from
// lib/middleware.js `testAdminCommitPark` (grep `testAdminCommitPark(` for what
// parks there), so arming one parks nothing of the other's.
// `parked` counts the sends that entered since arming, `enteredAt` is when the
// first did (this process's clock), and each is let go `ms` later, or at once
// by `releaseTestCertificateSendPark`.
const _testSendPark = { ms: 0, parked: 0, enteredAt: 0, waiters: new Set() };
function setTestCertificateSendDelay(ms) {
  _testSendPark.ms = ms | 0; _testSendPark.parked = 0; _testSendPark.enteredAt = 0;
  return testCertificateSendDelay();
}
function testCertificateSendDelay() {
  return { delayMs: _testSendPark.ms, parked: _testSendPark.parked, enteredAt: _testSendPark.enteredAt };
}
function _testSendParkPoint() {
  _testSendPark.parked++;
  if (!_testSendPark.enteredAt) _testSendPark.enteredAt = Date.now();
  return new Promise(r => {
    const go = () => { clearTimeout(t); _testSendPark.waiters.delete(go); r(); };
    const t = setTimeout(go, _testSendPark.ms);
    _testSendPark.waiters.add(go);
  });
}
/** Lets every send parked now go on at once; answers how many it released. */
function releaseTestCertificateSendPark() {
  const n = _testSendPark.waiters.size;
  for (const go of [..._testSendPark.waiters]) go();
  return n;
}

/** Wired by routes/badge.js at registration: the mint and the PDF live there. */
function setCertificateIssuer(issuer) { _issuer = issuer; }

/**
 * The PDF of an ISSUED certificate row, through the one render the holder's
 * and the organiser's downloads use (`_certificatePdfFor`, routes/badge.js).
 * For the top-three ZIP (routes/export-import.js), which cannot require a
 * route module. Rejects with BadgeRenderUnavailable like the render itself.
 */
function renderIssuedCertificatePdf(row, comp) {
  if (!_issuer || typeof _issuer.renderPdf !== "function") return Promise.reject(new Error("certificate renderer not registered"));
  return _issuer.renderPdf(row, comp);
}

/**
 * The podium of every board an ended event ranks on (routes/badge.js
 * `_placementPodium`): `[{timeslotId, timeslotName, late, places: [{userId,
 * rank, held}]}]`, each place a 1st/2nd/3rd the mint awards, `held` when a
 * certificate already fills it. For the top-three ZIP, to say what is missing.
 */
function placementPodium(comp) {
  if (!_issuer || typeof _issuer.podium !== "function") throw new Error("certificate podium not registered");
  return _issuer.podium(comp);
}

function _nowIso() { return now().toISOString(); }
function _isRenderUnavailable(e) {
  try { return e instanceof require("./badge").BadgeRenderUnavailable; } catch (_) { return false; }
}
function _floor() {
  try { return db.prepare("SELECT value FROM settings WHERE key='certificate_dispatch_floor_at'").get()?.value || null; }
  catch (_) { return null; }
}
// The restore's mark-sent floor (scripts/restore-mail.sh), or null: read per
// pass, uncached, like the grandfather floor. A floor more than a day ahead (a
// host clock running fast, a hand-written value) would silently stop every
// automatic mail until that date, so it is ignored, and said once.
let _futureFloorWarned = false;
function restoreMailFloor() {
  let v = null;
  try { v = db.prepare("SELECT value FROM settings WHERE key='restore_mail_floor_at'").get()?.value || null; }
  catch (_) { return null; }
  if (!v) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  if (ms > now().getTime() + 86_400_000) {
    if (!_futureFloorWarned) {
      _futureFloorWarned = true;
      try { log.warn({ restore_mail_floor_at: v }, "certificate dispatch: the restore's mail floor is more than a day ahead; ignored"); }
      catch (e) { swallowed("certificate-dispatch:future-floor-log", e); }
    }
    return null;
  }
  return v;
}
// The floor automatic certificate mail is judged against: the grandfather floor,
// or the restore's when later (ISO strings compare in time order). Null without
// the grandfather floor: fail closed, never mail history.
function automaticMailFloor() {
  const g = _floor();
  if (!g) return null;
  const r = restoreMailFloor();
  return r && r > g ? r : g;
}

/**
 * Queue the certificates of an event (or, with `userId`, of one Program
 * completer). Best-effort and synchronous: an end path must never fail on it.
 * Upserts, so calling it from two end paths for one end is one job.
 */
function enqueueCertificateDispatch(competitionId, { userId = "", reason = "ended", delayMs } = {}) {
  try {
    if (!competitionId) return false;
    // UNCACHED: the end path that calls this has just written the end.
    const comp = db.prepare("SELECT * FROM competitions WHERE id=?").get(competitionId);
    if (!comp) return false;
    // Event team reports — EVERY END PATH calls this function, so the team's
    // wrap-up (or late delta) is queued here, once, rather than beside each end
    // path where a new one could forget it. A Program completer's call is not an
    // end of the event and queues nothing. Own try: it must never cost a certificate.
    if (!userId) {
      try { require("./team-reports").enqueueTeamReport(comp, reason); }
      catch (e) { swallowed("certificate-dispatch:team-report-enqueue", e); }
    }
    const completion = eventPolicy(comp).certificate === "completion";
    // A Program has no common end: its certificates are dispatched per completer.
    if (completion && !userId) return false;
    // Only an event that IS over now gets a job (the session-delete paths call this
    // on every delete; most do not end anything). A stamped `ended_at` that is not
    // in the future is an end even in the millisecond it was written.
    if (!completion) {
      const endedAtMs = comp.ended_at ? Date.parse(comp.ended_at) : NaN;
      const hardEnded = Number.isFinite(endedAtMs) && endedAtMs <= now().getTime()
        && !db.prepare("SELECT 1 FROM competition_timeslots WHERE competition_id=? LIMIT 1").get(competitionId);
      if (!hardEnded && !competitionFullyEnded(comp)) return false;
    }
    const settle = Number.isFinite(delayMs) ? Math.max(0, delayMs) : (userId ? COMPLETION_SETTLE_MS : EVENT_SETTLE_MS);
    const t = now().getTime();
    db.prepare(
      `INSERT INTO certificate_dispatch_jobs (competition_id, user_id, reason, due_at, enqueued_at, passes)
       VALUES (?,?,?,?,?,0)
       ON CONFLICT(competition_id, user_id) DO UPDATE SET
         reason=excluded.reason, due_at=excluded.due_at, enqueued_at=excluded.enqueued_at, passes=0, last_error=NULL`
    ).run(competitionId, String(userId || ""), reason, new Date(t + settle).toISOString(), new Date(t).toISOString());
    _kickDispatch(settle);
    return true;
  } catch (e) {
    try { log.warn({ competition_id: competitionId, err: e.message }, "certificate dispatch: enqueue failed"); } catch (e2) { swallowed("certificate-dispatch:enqueue-log", e2); }
    return false;
  }
}

/**
 * An answer that finishes a Program learner (correct, or spending their last
 * attempt): if they passed (60% or more), queue their
 * certificate. Cheap when it does not apply (kind check first).
 */
function enqueueCompletionCertificate(competitionId, userId) {
  try {
    const comp = getCompetition(competitionId);
    if (!comp || eventPolicy(comp).certificate !== "completion") return false;
    // Program grades (27 Nov 2026): a learner is done once every scoring
    // challenge is solved or out of attempts, and a certificate is theirs at 60%
    // or more. Under it nothing is queued (the worker would refuse it anyway).
    const st = require("./program-grade").programStanding(userId, comp);
    if (!st.finished || !st.grade || !st.grade.passed) return false;
    return enqueueCertificateDispatch(competitionId, { userId, reason: "completed" });
  } catch (_) { return false; }
}

/**
 * Queue a completion certificate for each member of these events whom an
 * organiser's edit of challenge `taskId` has just made complete: it left their
 * count (unassigned, hidden, unpublished, made a qualifying question) or an
 * earlier answer to it turned correct (Recalculate). A completing correct answer
 * is the only other trigger, and such a learner may never send another.
 *
 * ONLY THE ONES THIS EDIT COMPLETED: complete now and without a correct answer
 * to `taskId` before the edit (`solvedBefore`, compId → Set of user ids, read
 * before a write that changes answers; else read now, which a change to the
 * count leaves as it was). Anyone else complete now was complete before, so
 * mailing them would mail history (a completion from before automatic issue,
 * or one made while the design's email was off). The callers pass only events
 * whose count the edit changed. Members holding a certificate of this event
 * (revoked included: automatic issue never replaces one) are not asked; the
 * worker decides at run time anyway. Non-completion events are skipped.
 */
function enqueueCompletersOf(competitionIds, { taskId, solvedBefore = null } = {}) {
  let queued = 0;
  if (!taskId) return queued;
  for (const id of new Set((competitionIds || []).filter(Boolean))) {
    try {
      const comp = getCompetition(id);
      if (!comp || eventPolicy(comp).certificate !== "completion") continue;
      const solved = solvedBefore ? (solvedBefore.get(id) || new Set()) : new Set(db.prepare(
        "SELECT DISTINCT user_id FROM submissions WHERE task_id=? AND competition_id=? AND is_correct=1").all(taskId, id).map(r => r.user_id));
      const rows = db.prepare(
        `SELECT cu.user_id FROM competition_users cu
          WHERE cu.competition_id=? AND NOT EXISTS (SELECT 1 FROM achievement_badges b
            WHERE b.user_id=cu.user_id AND b.competition_id=cu.competition_id)`).all(id);
      for (const r of rows) if (!solved.has(r.user_id) && enqueueCompletionCertificate(id, r.user_id)) queued++;
    } catch (e) { swallowed("certificate-dispatch:completers", e); }
  }
  return queued;
}

function _kickDispatch(afterMs) {
  if (process.env.NODE_ENV === "test" || _stopping) return;
  // A job due later is picked up by the interval; only an immediate one is kicked.
  if (afterMs > 0 || _kickArmed) return;
  _kickArmed = true;
  setImmediate(() => {
    _kickArmed = false;
    runCertificateDispatch().catch((e) => swallowed("certificate-dispatch:tick", e, { level: "warn" }));
  });
}

/** For the shutdown drain: is a pass running or about to? */
function certificateDispatchBusy() { return !!_running || _kickArmed; }

/**
 * One pass: every due job, then every due retry. Single flight — a call while a
 * pass runs returns that pass. `force` treats everything as due and
 * `competitionId` narrows the pass to one event's jobs and retries (test hook
 * only: a spec's forced pass would otherwise also redo every other event's).
 */
// MAIL WAITS WHILE THE INSTANCE IS OUT OF SERVICE: maintenance mode is on
// (operator ruling, 17 Nov 2026: a copied or restored database started with a
// working relay mailed real people), or the database failed its boot integrity
// or schema check (ruling, 24 Nov 2026: a corrupt or half-migrated database
// minted and mailed while /readyz refused traffic). server.js hands in its one
// instance-health gate (`_instanceInService`, which also holds the Checkmarx One
// runners); a held pass does nothing and leaves every job queued (`held: true`),
// so the copy and restore steps, which start in maintenance, send nothing until
// it is lifted, and a failed check sends nothing until the database is fixed and
// the server restarted. An admin's own sends (Resend, Issue again) are not
// passes and are not held.
let _mailHeld = null;
function setCertificateMailHold(fn) { _mailHeld = typeof fn === "function" ? fn : null; }

const _passOut = () => ({ jobs: 0, issued: 0, sent: 0, failed: 0, suppressed: 0, skipped: 0, deferred: 0, dropped: 0, retried: 0, boardBuilds: 0 });
// `maxSends` lowers this pass's MAX_SENDS_PER_PASS, never raises it. Only the
// test hook passes it (POST /api/test/certificate-dispatch-tick), so a lock can
// prove the cap with a handful of certificates instead of rendering a hundred.
function runCertificateDispatch({ force = false, competitionId = null, maxSends = null } = {}) {
  if (_running) return _running;
  // Both answered BEFORE the pass starts: returning inside it before its first
  // await would run its `finally` (`_running = null`) before `_running` is
  // assigned, so every later call would get this answer again.
  if (_mailHeld && _mailHeld()) return Promise.resolve({ ..._passOut(), held: true });
  if (!_issuer) return Promise.resolve(_passOut());
  const cap = Number.isInteger(maxSends) && maxSends > 0 ? Math.min(maxSends, MAX_SENDS_PER_PASS) : MAX_SENDS_PER_PASS;
  _running = (async () => {
    const out = _passOut();
    try {
      const cutoff = force ? "9999-12-31T23:59:59.999Z" : _nowIso();
      const jobs = db.prepare(
        `SELECT * FROM certificate_dispatch_jobs WHERE due_at <= ? ${competitionId === null ? "" : "AND competition_id = ?"} ORDER BY due_at LIMIT 20`
      ).all(...(competitionId === null ? [cutoff] : [cutoff, competitionId]));
      for (const job of jobs) {
        if (_stopping) break;
        out.jobs++;
        // The board cost of this job, as computed builds of its event's board.
        const _b0 = leaderboardComputeCount(job.competition_id);
        await _processJob(job, out, { force, cap });
        out.boardBuilds += leaderboardComputeCount(job.competition_id) - _b0;
      }
      if (!_stopping) await _retryFailed(out, { force, competitionId });
    } catch (e) {
      try { log.error({ err: e.message }, "certificate dispatch pass failed"); } catch (e2) { swallowed("certificate-dispatch:pass-log", e2); }
    } finally {
      _running = null;
    }
    return out;
  })();
  return _running;
}

function _dropJob(job, why, out) {
  _jobBoards.delete(_boardsKey(job));
  db.prepare("DELETE FROM certificate_dispatch_jobs WHERE competition_id=? AND user_id=? AND enqueued_at=?")
    .run(job.competition_id, job.user_id, job.enqueued_at);
  if (out) out.dropped++;
  try { log.info({ competition_id: job.competition_id, user_id: job.user_id || null, why }, "certificate dispatch: job closed"); } catch (e2) { swallowed("certificate-dispatch:job-closed-log", e2); }
}

/**
 * Why this event's certificates are NOT issued automatically, or null when they
 * are: the run-time gates the worker asks of an event (never of one job). One
 * definition, read by the worker and by the top-3 download, which says this
 * reason instead of "nobody placed".
 *   no_floor            — the grandfather floor is missing (fail closed)
 *   ended_before_floor  — an attempt kind that ended before automatic issue began
 *   dry_run             — a test / dry-run event
 *   email_disabled      — the certificate design's congratulations email is off
 */
function automaticIssueRefusal(comp) {
  const completion = eventPolicy(comp).certificate === "completion";
  const floor = automaticMailFloor();
  if (!floor) return "no_floor";   // fail closed: never mail history
  if (!completion) {
    const effEnd = competitionEffectiveEnd(comp);
    if (!effEnd || effEnd.toISOString() < floor) return "ended_before_floor";
  }
  if (isDryRunCompetition(comp.id)) return "dry_run";
  const cfg = resolveCertificateConfig(db, comp.id);
  if (!cfg.email || cfg.email.enabled !== true) return "email_disabled";
  return null;
}

async function _processJob(job, out, { force, cap = MAX_SENDS_PER_PASS }) {
  const comp = getCompetition(job.competition_id);
  if (!comp) return _dropJob(job, "event_gone", out);
  const completion = eventPolicy(comp).certificate === "completion";
  if (!completion && !competitionFullyEnded(comp)) return _dropJob(job, "not_ended", out);
  const refusal = automaticIssueRefusal(comp);
  if (refusal) return _dropJob(job, refusal, out);
  // A Program completer's job queued before a mark-sent restore: their
  // certificate was (or was not) mailed in the timeline the restore discarded.
  const _restored = restoreMailFloor();
  if (job.user_id && _restored && job.enqueued_at < _restored) return _dropJob(job, "queued_before_restore", out);

  const members = db.prepare(
    `SELECT cu.user_id FROM competition_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.competition_id=? ${job.user_id ? "AND cu.user_id=?" : ""}
        AND COALESCE(u.blocked,0)=0 AND u.denied_at IS NULL AND COALESCE(u.approved,0)=1
      ORDER BY cu.user_id`
  ).all(...(job.user_id ? [comp.id, job.user_id] : [comp.id])).map(r => r.user_id);

  let deferUntil = null, renderFailed = false, issueFailed = false, started = 0, capped = false;
  const boards = _boardsFor(job, comp);
  // PER-SESSION QUESTION SETS — an event ranking per session AND overall issues
  // each person's certificate from their own board, then the overall board's
  // when they placed there (a placement or nothing: `{board: "overall"}`), each
  // sent through the same ledger. An event with one board asks once, as before.
  const overall = !!(_issuer.overallBeside && _issuer.overallBeside(comp));
  const tasks = members.map((userId) => async () => {
    for (const board of overall ? [null, "overall"] : [null]) {
      if (await _issueAndSend(userId, board) === "stop") return;
    }
  });
  const _issueAndSend = async (userId, board) => {
    if (_stopping) { capped = true; return "stop"; }
    if (started >= cap) { capped = true; return "stop"; }
    let r;
    try {
      r = await _issuer.issue(userId, comp, board ? { boards, board } : { boards });
    } catch (e) {
      if (_isRenderUnavailable(e)) renderFailed = true;
      else {
        // Taken as transient: the job is kept for a later pass, which skips
        // everyone already issued, so one failed write never loses a
        // participant's certificate and email while the job closes.
        issueFailed = true;
        try { log.error({ competition_id: comp.id, user_id: userId, err: e.message }, "certificate dispatch: issue failed"); } catch (e2) { swallowed("certificate-dispatch:issue-log", e2); }
      }
      return;
    }
    if (r.defer) {
      out.deferred++;
      const d = r.defer instanceof Date ? r.defer : new Date(r.defer);
      if (Number.isFinite(d.getTime()) && (!deferUntil || d > deferUntil)) deferUntil = d;
      return;
    }
    // Not placed on the overall board is no certificate to skip: the person's
    // own board answered for them.
    if (board && r.skip) return;
    if (r.skip || !r.row) { out.skipped++; return; }
    if (r.minted) out.issued++;
    // The ledger claim at the top of `_sendFor` is THE never-twice guard: a
    // certificate with a row (any status) answers `in_flight` and sends nothing.
    started++;
    const res = await _sendFor(r.row, comp, { via: "automatic", actor: "system", context: {} });
    if (res.status === "in_flight") { started--; out.skipped++; return; }
    if (res.status === "sent") out.sent++;
    else if (res.status === "suppressed") out.suppressed++;
    else if (res.status === "failed") out.failed++;
    else if (res.status === "skipped") out.skipped++;
    else if (res.status === "render_unavailable") renderFailed = true;
    return null;
  };
  await _runBounded(tasks, CONCURRENCY);

  if (capped && !_stopping) {
    // More to do: leave the job due now and come straight back.
    db.prepare("UPDATE certificate_dispatch_jobs SET due_at=?, passes=passes+1 WHERE competition_id=? AND user_id=? AND enqueued_at=?")
      .run(_nowIso(), job.competition_id, job.user_id, job.enqueued_at);
    _kickDispatch(0);
    return;
  }
  if (_stopping) return;
  if (renderFailed) {
    if ((job.passes || 0) + 1 >= MAX_JOB_PASSES) return _dropJob(job, "render_unavailable_gave_up", out);
    _jobBoards.delete(_boardsKey(job));   // a timed retry builds fresh boards
    db.prepare("UPDATE certificate_dispatch_jobs SET due_at=?, passes=passes+1, last_error='render_unavailable' WHERE competition_id=? AND user_id=? AND enqueued_at=?")
      .run(new Date(now().getTime() + RENDER_RETRY_MS).toISOString(), job.competition_id, job.user_id, job.enqueued_at);
    return;
  }
  if (issueFailed) {
    const prior = /^issue_failed:(\d+)$/.exec(job.last_error || "");
    const n = (prior ? Number(prior[1]) : 0) + 1;
    if (n <= MAX_ISSUE_RETRIES) {
      _jobBoards.delete(_boardsKey(job));   // a timed retry builds fresh boards
      db.prepare("UPDATE certificate_dispatch_jobs SET due_at=?, last_error=? WHERE competition_id=? AND user_id=? AND enqueued_at=?")
        .run(new Date(now().getTime() + ISSUE_RETRY_MS).toISOString(), `issue_failed:${n}`, job.competition_id, job.user_id, job.enqueued_at);
      return;
    }
    try { log.warn({ competition_id: comp.id, user_id: job.user_id || null, retries: n - 1 }, "certificate dispatch: an issue kept failing; carrying on without it"); } catch (e2) { swallowed("certificate-dispatch:issue-gave-up-log", e2); }
  }
  // An event job with its late window still open waits for it to close even when
  // no late entrant deferred on this pass: one who joins, or first answers, after
  // it is issued only by this job's next pass (the header).
  if (!job.user_id) {
    const effEnd = competitionEffectiveEnd(comp);
    if (lateEntryWindowOpen(comp, effEnd, now().getTime())) {
      const dl = lateEntryDeadline(comp, effEnd);
      if (dl && (!deferUntil || dl > deferUntil)) deferUntil = dl;
    }
  }
  if (deferUntil) {
    // Late entrants still inside their window: come back a minute after it closes,
    // with fresh boards (the late board moves until then).
    _jobBoards.delete(_boardsKey(job));
    db.prepare("UPDATE certificate_dispatch_jobs SET due_at=?, reason='late_entry_pending', passes=passes+1 WHERE competition_id=? AND user_id=? AND enqueued_at=?")
      .run(new Date(deferUntil.getTime() + 60_000).toISOString(), job.competition_id, job.user_id, job.enqueued_at);
    return;
  }
  _dropJob(job, "done", null);
}

async function _retryFailed(out, { force, competitionId = null }) {
  const cutoff = force ? "9999-12-31T23:59:59.999Z" : _nowIso();
  const rows = db.prepare(
    `SELECT e.badge_token, e.updated_at FROM certificate_emails e
      WHERE e.status='failed' AND e.next_attempt_at IS NOT NULL AND e.next_attempt_at <= ? AND e.attempts < ?
        ${competitionId === null ? "" : "AND e.competition_id = ?"}
      ORDER BY e.next_attempt_at LIMIT 50`
  ).all(...(competitionId === null ? [cutoff, MAX_ATTEMPTS] : [cutoff, MAX_ATTEMPTS, competitionId]));
  const _restored = restoreMailFloor();
  for (const { badge_token, updated_at } of rows) {
    if (_stopping) break;
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=? AND revoked_at IS NULL").get(badge_token);
    const comp = row ? getCompetition(row.competition_id) : null;
    // A retry honours the switch and the dry-run tag as they are NOW: an organiser
    // who turned the email off after a failed send asked for no more attempts.
    // Nor is a send last tried before a mark-sent restore retried: it belongs to
    // the timeline the restore discarded (an admin's Resend since is retried).
    const live = comp && !isDryRunCompetition(comp.id) && resolveCertificateConfig(db, comp.id).email?.enabled === true
      && !(_restored && updated_at < _restored);
    if (!row || !comp || !live) {
      db.prepare("UPDATE certificate_emails SET next_attempt_at=NULL, updated_at=? WHERE badge_token=?").run(_nowIso(), badge_token);
      continue;
    }
    out.retried++;
    // `_sendFor` re-asks the holder's account, membership and the certificate's
    // revocation after its render, as the first pass's query did before it.
    const res = await _sendFor(row, comp, { via: "retry", actor: "system", context: {} });
    if (res.status === "sent") out.sent++;
    else if (res.status === "failed") out.failed++;
    else if (res.status === "suppressed") out.suppressed++;
    else if (res.status === "skipped") out.skipped++;
  }
}

/**
 * The congratulation, per tier. Built from the FROZEN certificate (basis, rank,
 * score_snapshot, late_entrant) — never from a live board — so the mail says
 * what the attached certificate says.
 */
function _ordinal(n) { return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`; }
// Operator ruling, 29 Oct 2026 — warm, polite and per tier. The paragraph is the
// design's `email.message_<tier>` (editable); the facts around it (placing among
// late entrants, score, code) are still computed from the frozen certificate.
function certificateEmailCopy(row, { eventName, platformName, intro, code, pdfUrl, messages = {}, shareUrl = null, verifyUrl = null }) {
  const { escapeHtml: E } = require("./sanitise");
  const tier = certificateTier({ basis: row.basis, rank: row.rank });
  const fill = (s) => E(fillTokens(String(s || ""), { platformName, eventName }));
  const lead = `<p>${fill(messages[tier] || messages.participation || `Thank you for taking part in ${eventName}.`)}</p>`;
  const podium = tier === "gold" || tier === "silver" || tier === "bronze";
  const facts = [];
  // The board a place was on (owner decision, 27 Nov 2026), from the FROZEN
  // columns, as the certificate prints it: "overall" or the session's name.
  if (podium && row.board_kind === "overall") facts.push(`You placed <strong>${_ordinal(row.rank)}</strong> overall, across every session.`);
  else if (podium && row.board_kind === "session" && row.board_name) facts.push(`You placed <strong>${_ordinal(row.rank)}</strong> in ${E(row.board_name)}.`);
  if (podium && row.late_entrant) facts.push(`You placed <strong>${_ordinal(row.rank)}</strong> among the late entrants.`);
  else if (row.late_entrant) facts.push("You joined as a late entrant, and your certificate says so.");
  // A place on a board ranked by percentages (frozen `score_permille`) states the
  // percentage it was ranked on, as the certificate prints it; else the points.
  if (podium && Number.isFinite(row.score_permille)) facts.push(`Your final score was <strong>${E(require("./badge").permilleText(row.score_permille))}</strong> of the points your session offered.`);
  else if (podium && Number.isFinite(row.score_snapshot)) facts.push(`Your final score was <strong>${E(String(row.score_snapshot))} points</strong>.`);
  // Program grades (27 Nov 2026): the band and percentage the certificate was
  // issued with, from its frozen columns, as the certificate prints them.
  {
    const PG = require("./program-grade");
    const label = row.grade_band ? PG.gradeLabel(row.grade_band) : null;
    const pct = PG.formatGradePercent(row.grade_permille);
    if (tier === "completion" && label && pct) facts.push(`Your grade: <strong>${E(label)} (${E(pct)})</strong>.`);
  }
  const factLine = facts.length ? `<p>${facts.join(" ")}</p>` : "";
  const extra = intro ? `<p>${E(intro)}</p>` : "";
  const codeLine = code
    ? `<p>Your certificate code is <strong>${E(code)}</strong>. Anyone can check it at <a href="${E(verifyUrl || `${BASE_URL}/credential`)}">${E(`${BASE_URL}/credential`)}</a> with your surname.</p>`
    : "";
  const share = shareUrl
    ? `<p style="margin:20px 0"><a href="${E(shareUrl)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#0a66c2;color:#ffffff;text-decoration:none;font-weight:600">Copy my LinkedIn post</a></p>`
      + `<p style="font-size:0.9em;color:#555">The button opens a page with a short post ready to copy, with the verification link, and opens LinkedIn for you. It works once and for seven days, with no sign-in. If the button does not work, open this address: ${E(shareUrl)}</p>`
    : "";
  const body = `${lead}${factLine}${extra}<p>Your certificate is attached to this email as a PDF. You can also download it from the link below at any time, or by signing in to ${E(platformName)}: it is on the event's Challenges page.</p>${codeLine}${share}<p>Thank you again for being part of it — we hope to see you at the next one.</p>`;
  return { tier, body, linkUrl: pdfUrl, linkText: "Download your certificate (PDF)" };
}

function _subjectFor(cfg, platformName, eventName) {
  const thing = fillTokens(cfg.email.subject, { platformName, eventName }).replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    || `Your certificate for ${eventName}`;
  return `${platformName} — ${thing}`;
}

// Claim the certificate's ledger row for one send. Answers `{claimed, prev}`:
// `prev` is the row as it was (null when this claim created it), so a send
// refused before it went out can put the ledger back exactly.
function _ledgerClaim(row, via) {
  const ts = _nowIso();
  const ins = db.prepare(
    `INSERT INTO certificate_emails (badge_token, user_id, competition_id, status, attempts, first_attempt_at, updated_at)
     VALUES (?,?,?,'sending',1,?,?) ON CONFLICT(badge_token) DO NOTHING`
  ).run(row.token, row.user_id, row.competition_id, ts, ts);
  if (ins.changes === 1) return { claimed: true, prev: null };
  // The automatic pass never re-sends: a row means this certificate was handled.
  if (via === "automatic") return { claimed: false };
  // A retry or an admin resend claims the existing row unless a send is in flight.
  const prev = db.prepare("SELECT * FROM certificate_emails WHERE badge_token=?").get(row.token);
  const up = db.prepare(
    `UPDATE certificate_emails SET status='sending', attempts=attempts+1, next_attempt_at=NULL, updated_at=?
      WHERE badge_token=? AND status != 'sending'${via === "retry" ? " AND status='failed'" : ""}`
  ).run(ts, row.token);
  return up.changes === 1 ? { claimed: true, prev } : { claimed: false };
}

function _ledgerRestore(row, prev) {
  if (!prev) { db.prepare("DELETE FROM certificate_emails WHERE badge_token=? AND status='sending'").run(row.token); return; }
  db.prepare(
    `UPDATE certificate_emails SET status=?, attempts=?, last_error=?, next_attempt_at=?, sent_at=?, updated_at=?
      WHERE badge_token=? AND status='sending'`
  ).run(prev.status, prev.attempts, prev.last_error, prev.next_attempt_at, prev.sent_at, prev.updated_at, row.token);
}

// Why this certificate's holder may no longer be mailed, asked synchronously
// after the send's last await (the render): the certificate revoked meanwhile,
// the account blocked, denied or no longer approved, or (for the automatic pass
// and its retry, which mail members only) the holder no longer in the event.
// Null when the send may go ahead (sweep #212).
function _holderIneligible(row, comp, via) {
  if (db.prepare("SELECT 1 FROM achievement_badges WHERE token=? AND revoked_at IS NOT NULL").get(row.token)) return "revoked";
  const u = db.prepare("SELECT blocked, denied_at, approved FROM users WHERE id=?").get(row.user_id);
  if (!u || u.blocked || u.denied_at || !u.approved) return "account_inactive";
  if ((via === "automatic" || via === "retry")
      && !db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, row.user_id)) return "not_member";
  return null;
}
// What an admin's Resend is told when the holder may no longer be mailed.
const _RESEND_REFUSED = {
  account_inactive: { code: "account_inactive", error: "Not sent: this participant's account is blocked, denied or not approved." },
  revoked: { code: "certificate_revoked", error: "Not sent: this certificate has been revoked." },
};

/**
 * Send (or re-send) ONE certificate's email. Never throws. Answers
 * `{status}`: sent | failed | suppressed | skipped (the holder may no longer be
 * mailed: `_holderIneligible`; settled, never retried) | in_flight |
 * render_unavailable | gone | refused (with `refusal`: `recheck`, asked after the
 * last await and before the send, answered — an admin's Resend re-asks the admin
 * there, and is refused for a holder `_holderIneligible` names; nothing is sent
 * and the ledger is put back as it was).
 */
async function _sendFor(row, comp, { via, actor, context, recheck = null }) {
  const email = require("./email");
  const { formatCredentialCode } = require("./badge");
  const claim = _ledgerClaim(row, via);
  if (!claim.claimed) return { status: "in_flight" };
  let status = "failed", errorCode = null;
  try {
    const user = db.prepare("SELECT id, email, secondary_email, first_name, nickname FROM users WHERE id=?").get(row.user_id);
    if (!user) { status = "gone"; return { status }; }
    const to = email.getUserEmails(user);
    const platformName = require("./settings").getPlatformName();
    const cfg = resolveCertificateConfig(db, comp.id);
    const eventName = String(comp.name || "");
    let pdf;
    try {
      pdf = await _issuer.renderPdf(row, comp);
    } catch (e) {
      if (_isRenderUnavailable(e)) { status = "render_unavailable"; errorCode = "render_unavailable"; return { status }; }
      throw e;
    }
    if (_testSendPark.ms) await _testSendParkPoint();
    // The last await before the send is behind us: re-ask whoever must still be
    // allowed to send (synchronously, so nothing changes between this and the send
    // starting).
    if (recheck) {
      const refusal = recheck();
      if (refusal) { status = "refused"; return { status, refusal }; }
    }
    // The holder, re-asked here for every send: the pass's query (or the
    // retry's claim) was read before the render's await (sweep #212).
    const why = _holderIneligible(row, comp, via);
    if (why) {
      if (via === "resend") { status = "refused"; return { status, refusal: { status: 409, ..._RESEND_REFUSED[why] } }; }
      status = "skipped"; errorCode = why; return { status };
    }
    const pdfUrl = certificateMailPdfUrl(row.token);
    const suppressed = email.isUnsubscribedAddress(to);
    // The one-time LinkedIn share link is minted only for a mail that will go out:
    // an opted-out address gets no mail, so it gets no live capability either.
    const share = require("./certificate-share");
    const shareUrl = suppressed ? null : share.shareLinkUrl(share.mintShareLink(db, row.token));
    const verifyUrl = row.public_code ? `${BASE_URL}/credential?code=${encodeURIComponent(row.public_code)}` : null;
    const copy = certificateEmailCopy(row, {
      eventName, platformName, intro: fillTokens(cfg.email.intro, { platformName, eventName }),
      code: row.public_code ? formatCredentialCode(row.public_code) : null, pdfUrl,
      messages: {
        gold: cfg.email.message_gold, silver: cfg.email.message_silver, bronze: cfg.email.message_bronze,
        participation: cfg.email.message_participation, completion: cfg.email.message_completion,
      },
      shareUrl, verifyUrl,
    });
    const { html, text } = email.buildEmail(platformName, {
      greeting: user.first_name || user.nickname,
      body: copy.body, linkUrl: copy.linkUrl, linkText: copy.linkText,
      fallbackNote: `You are receiving this because you took part in ${eventName}.`,
    });
    const ok = await trackDetachedSend(email.sendEmailLogged(user.id, {
      to, subject: _subjectFor(cfg, platformName, eventName), html, text,
      attachments: [{ filename: pdf.filename, content: pdf.pdf, contentType: "application/pdf" }],
    }, "certificate_awarded", { competitionId: comp.id }).catch(() => false));
    status = ok ? "sent" : (suppressed ? "suppressed" : "failed");
    if (!ok && !suppressed) errorCode = "smtp_failed";
    return { status };
  } catch (e) {
    errorCode = "internal_error";
    try { log.error({ competition_id: comp.id, user_id: row.user_id, err: e.message }, "certificate email failed"); } catch (e2) { swallowed("certificate-dispatch:email-log", e2); }
    return { status: "failed" };
  } finally {
    if (status === "refused") { try { _ledgerRestore(row, claim.prev); } catch (e2) { swallowed("certificate-dispatch:ledger-restore", e2); } }
    else _settleLedger(row, status, errorCode, { via, actor, context, comp });
  }
}

function _settleLedger(row, status, errorCode, { via, actor, context, comp }) {
  try {
    const ts = _nowIso();
    const cur = db.prepare("SELECT attempts FROM certificate_emails WHERE badge_token=?").get(row.token);
    if (!cur) return;                       // the certificate was deleted meanwhile (cascade)
    const attempts = cur.attempts || 1;
    let stored = status, next = null;
    if (status === "render_unavailable") stored = "failed";
    if (status === "gone") stored = "failed";
    if (stored === "failed" && status !== "gone" && attempts < MAX_ATTEMPTS) {
      next = new Date(now().getTime() + RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]).toISOString();
    }
    db.prepare(
      `UPDATE certificate_emails SET status=?, last_error=?, next_attempt_at=?, updated_at=?,
         sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END
       WHERE badge_token=?`
    ).run(stored, stored === "sent" || stored === "suppressed" ? null : errorCode, next, ts, stored, ts, row.token);
    if (status === "gone") return;
    const { recordUserEvent } = require("./audit");
    if (db.prepare("SELECT 1 FROM users WHERE id=?").get(row.user_id)) {
      recordUserEvent(row.user_id, "certificate_emailed", actor || "system", {
        competition_id: comp.id, competition_name: comp.name,
        basis: row.basis || null, rank: row.rank, tier: certificateTier({ basis: row.basis, rank: row.rank }),
        status: stored, attempt: attempts, via,
        ...(next ? { next_attempt_at: next } : {}),
        ...(errorCode && stored === "failed" ? { error: errorCode } : {}),
        ...(stored === "skipped" ? { skipped: errorCode } : {}),
        ...(context || {}),
      });
    }
  } catch (e) {
    try { log.error({ err: e.message }, "certificate email: ledger update failed"); } catch (e2) { swallowed("certificate-dispatch:ledger-update-log", e2); }
  }
}

/**
 * An admin's Resend: send this certificate's email again now, whatever the
 * ledger says (except a send already in flight), even with the event's switch
 * off — it is an explicit act. Opt-outs are still honoured.
 */
function resendCertificateEmail(row, comp, { actor, context, recheck }) {
  if (!_issuer) return Promise.resolve({ status: "failed" });
  return _sendFor(row, comp, { via: "resend", actor, context, recheck });
}

/**
 * The email of a certificate a superadmin issued again (routes/badge.js Issue
 * again). An explicit act, so neither floor holds it back (an upgrade's, a
 * restore's); the event's email switch and the dry-run tag do, as for every
 * automatic send. Answers the send's promise, or null when nothing is sent.
 */
function sendReissuedCertificate(row, comp, { actor, context }) {
  if (!_issuer || isDryRunCompetition(comp.id) || resolveCertificateConfig(db, comp.id).email?.enabled !== true) return null;
  return _sendFor(row, comp, { via: "reissue", actor, context });
}

/** Has the certificate's holder opted out of these emails? (The send is then suppressed.) */
function holderOptedOut(userId) {
  try {
    const email = require("./email");
    const user = db.prepare("SELECT id, email, secondary_email FROM users WHERE id=?").get(userId);
    return !!user && !!email.isUnsubscribedAddress(email.getUserEmails(user));
  } catch (e) { swallowed("certificate-dispatch:opted-out", e); return false; }
}

/** The ledger row for a certificate, for the admin list. */
function certificateEmailState(token) {
  return db.prepare("SELECT status, attempts, last_error, next_attempt_at, sent_at, updated_at FROM certificate_emails WHERE badge_token=?").get(token) || null;
}

/** The ledger rows for many certificates in ONE query (a Map by badge token):
 *  a list must not ask once per certificate. */
function certificateEmailStates(tokens) {
  const out = new Map();
  if (!Array.isArray(tokens) || !tokens.length) return out;
  for (const r of db.prepare(
    "SELECT badge_token, status, attempts, last_error, next_attempt_at, sent_at, updated_at FROM certificate_emails WHERE badge_token IN (SELECT value FROM json_each(?))"
  ).all(JSON.stringify(tokens))) {
    const { badge_token: t, ...rest } = r;
    out.set(t, rest);
  }
  return out;
}

/** Jobs waiting for an event (the admin list says "pending"). */
function pendingDispatchFor(competitionId) {
  return db.prepare("SELECT user_id, reason, due_at FROM certificate_dispatch_jobs WHERE competition_id=? ORDER BY due_at").all(competitionId);
}

/** Boot: a send cut by a crash is `unknown`, never retried automatically. */
function recoverInterruptedCertificateSends() {
  try {
    const r = db.prepare("UPDATE certificate_emails SET status='unknown', last_error='interrupted', next_attempt_at=NULL, updated_at=? WHERE status='sending'")
      .run(_nowIso());
    if (r.changes) log.warn({ count: r.changes }, "certificate email: sends interrupted by the last shutdown are marked unknown (not retried)");
    return r.changes;
  } catch (e) { swallowed("certificate-dispatch:recover-interrupted", e, { level: "warn" }); return 0; }
}

function startCertificateDispatcher() {
  _stopping = false;
  recoverInterruptedCertificateSends();
  if (process.env.NODE_ENV === "test" || _interval) return;
  _interval = setInterval(() => { runCertificateDispatch().catch((e) => swallowed("certificate-dispatch:tick", e, { level: "warn" })); }, TICK_MS);
  _interval.unref();
  setImmediate(() => { runCertificateDispatch().catch((e) => swallowed("certificate-dispatch:tick", e, { level: "warn" })); });
}

function stopCertificateDispatcher() {
  _stopping = true;
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  setCertificateIssuer, renderIssuedCertificatePdf, enqueueCertificateDispatch, enqueueCompletionCertificate, enqueueCompletersOf,
  runCertificateDispatch, certificateDispatchBusy, resendCertificateEmail, sendReissuedCertificate, holderOptedOut,
  certificateEmailState, pendingDispatchFor, automaticIssueRefusal, placementPodium, restoreMailFloor,
  certificateMailPdfUrl, isCertificateMailLink, certificateEmailCopy,
  startCertificateDispatcher, stopCertificateDispatcher, setCertificateMailHold,
  MAX_ATTEMPTS, EVENT_SETTLE_MS,
  certificateEmailStates,
  setTestCertificateSendDelay, testCertificateSendDelay, releaseTestCertificateSendPark,
};
