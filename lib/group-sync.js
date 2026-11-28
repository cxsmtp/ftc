"use strict";

// Group→competition live-sync engine: the membership reconciler + its add/remove
// primitives + the detached overflow-drain + the assignment/removal mail builders.
// TOP OF THE DAG / widest fan-out — a STRICT CONSUMER of leaf libs only; nothing
// here may be require()d back by competitions/leaderboard/audit/cxone/email or any
// routes/* (that would close a cycle). The reconciler cluster (reconcile +
// _scheduleReconcileDrain + _reconcileDrainPending Set + RECONCILE_MAX_*) is an
// indivisible unit — mutual recursion via setImmediate, one shared dedup Set.
// (v7.0.0 refactor: extracted verbatim from server.js.)

const db = require("../db");
const { swallowed } = require("./best-effort");
const { now, formatEmailDate } = require("./time");
const { BASE_URL } = require("./config");
const { scheduledEnd, getCompetition, getTimeslot, getCompetitionTimeslots, competitionEffectiveEnd, closeAbsenceAndRestoreAnchor, recordRemovalAbsence, competitionAdmission, lateWindowAdmissionDenied, lateWindowRemovalDenied, lateEntryMailLineFor, eventEndMailText } = require("./competitions");
const { recordUserEvent, recordCompetitionEvent, runTxnWithMirrorBuffer } = require("./audit");
const { enqueueCxOneProvision } = require("./cxone");
const { getPlatformName } = require("./settings");
const { escapeHtml } = require("./sanitise");
// v8.12.0 — lazy: lib/self-enroll requires this module's sibling lib/competitions
// and lib/leaderboard, and this module is deliberately kept free of require-time
// cycles (see the header).
const staffRowRefusal = (user, comp) => require("./self-enroll").staffRowRefusal(user, comp);
const { _groupNameKey } = require("./util");
const { buildEmail, getUserEmails, sendEmailLogged, sendEmailBackground } = require("./email");
const { _invalidateMeCache } = require("./me-cache");
const { invalidateLeaderboardCache } = require("./leaderboard");
const { invalidateAdminParticipantsCache } = require("./participants-cache");
const { clearCompetitionSessionForUser } = require("./sessions");
const { log } = require("./log");

// Hard cap on members added/removed by a single reconcile pass. Pre-fix
// reconcile could enumerate the union of all bound groups' members in one
// HTTP request — at 200 groups × thousands of members that's a synchronous
// fanout in the request handler. The cap keeps a single trigger bounded;
// overflow is drained by detached follow-up passes (see _scheduleReconcileDrain).
const RECONCILE_MAX_PER_CALL = 500;
// Backstop on the detached drain chain: 200 × 500 = 100k members, far above any
// real event. If a comp is still un-drained after this many passes, log loudly
// rather than spin forever.
const RECONCILE_MAX_DRAIN_PASSES = 200;
// One pending drain per competition (deduped) so concurrent triggers don't pile
// up redundant passes. setImmediate detaches the work from the HTTP request that
// hit the cap, so that request returns after exactly one bounded pass.
const _reconcileDrainPending = new Set();
// ext-audit v7.20.9 (F8) — a COUNT of drain passes that are queued-or-running,
// so graceful shutdown can wait for them.
//
// A membership change larger than RECONCILE_MAX_PER_CALL finishes one bounded
// pass inside the request and detaches the remainder here. The shutdown drain
// waited on audit, CxOne and mail, but knew nothing about this — so a rolling
// deployment that landed during a large group bind closed the database
// mid-reconciliation and left the competition permanently under- or
// over-enrolled, with nothing scheduled to finish the job.
//
// The counter is incremented BEFORE setImmediate, not inside the callback:
// incrementing inside would leave a queued-but-not-yet-run pass invisible, and
// that queued window is exactly where the work was being lost.
let _reconcileDrainInFlight = 0;
function reconcileDrainPending() { return _reconcileDrainInFlight; }

// Add ONE user to ONE competition as a GROUP-origin member (direct_assigned=0).
// Mirrors the manual-assign per-(user,comp) txn (closeAbsence + restoreSlot +
// events). Honors the "skip ended" rule: never enrolls into — and never
// revives — a competition that has ended, unless (v8.12.6) it is still taking
// LATE ENTRIES, when the new row is a late entrant by construction and nothing
// about the event itself moves. INSERT OR IGNORE leaves an existing row
// untouched, so a user already present directly (direct_assigned=1) or via
// another bound group is not downgraded. Returns true iff a new row was added.
function addUserToCompetitionViaGroup(comp, uid, user, actor, opts = {}) {
  // v8.8.9 — the requester's ip/ua/req_id when a REQUEST drove this pass. The
  // reconciler has six request-driven entry points and every one passes a real
  // admin identity, so "background work, attributed system" was never true of
  // the common case (see reconcileCompetitionMembership below).
  const ctx = opts.context || {};
  // v6.20.x — opts.assumeNotEnded skips the per-user competitionStatus() recheck
  // (which runs an uncached getCompetitionTimeslots query). The reconciler already
  // early-returns on ended once per pass, so re-deriving status per user was an
  // N+1. opts.deferCacheBust lets the caller invalidate the leaderboard / admin-
  // participants caches ONCE after the whole batch instead of per inserted user
  // (invalidateAdminParticipantsCache is a full Map.clear()). _invalidateMeCache
  // stays per-user (it's keyed by uid and cheap).
  // v8.12.6 — the one admission predicate (`competitionAdmission`), so an event
  // still taking late entries admits here too. `opts.lateEntry` marks the emits
  // when the caller already knows it is writing through the window.
  if (!opts.assumeNotEnded && !competitionAdmission(comp)) return false; // frozen — no enroll, no revive
  let didInsert = false;
  const txn = db.transaction(() => {
    const r = db.prepare(
      "INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,0)"
    ).run(comp.id, uid, actor, now().toISOString());
    if (r.changes === 0) return; // already a member (direct or another group) — leave as-is
    didInsert = true;
    // v8.1.0 — closes the absence AND restores the solve-clock anchor the
    // removal preserved on it. Shared with the bulk-assign and self-enroll
    // re-adds so the three cannot drift; see lib/competitions.js for why a
    // re-add that only closed the row hands the participant a tie-break win.
    closeAbsenceAndRestoreAnchor(uid, comp.id, now().toISOString());
    db.prepare(
      `UPDATE competition_users SET timeslot_id=(
         SELECT timeslot_id FROM (
           SELECT timeslot_id FROM submissions
             WHERE user_id=? AND competition_id=? AND timeslot_id IS NOT NULL
           UNION ALL
           SELECT timeslot_id FROM hint_reveals
             WHERE user_id=? AND competition_id=? AND timeslot_id IS NOT NULL
         )
         WHERE timeslot_id IN (SELECT id FROM competition_timeslots WHERE competition_id=?)
         LIMIT 1
       ) WHERE user_id=? AND competition_id=? AND timeslot_id IS NULL`
    ).run(uid, comp.id, uid, comp.id, comp.id, uid, comp.id);
    recordUserEvent(uid, "added_to_competition", actor, { ...ctx, competition_id: comp.id, competition_name: comp.name, via: "group_sync", ...(opts.lateEntry ? { late_entry: true } : {}) });
    recordCompetitionEvent(comp.id, "user_added", actor, { ...ctx, user_id: uid, nickname: user.nickname, via: "group_sync", ...(opts.lateEntry ? { late_entry: true } : {}) });
  });
  runTxnWithMirrorBuffer(() => txn());
  if (didInsert) {
    enqueueCxOneProvision(user, comp.id, "group_sync");
    _invalidateMeCache(uid);
    if (!opts.deferCacheBust) {
      invalidateLeaderboardCache(comp.id);
      invalidateAdminParticipantsCache();
    }
  }
  return didInsert;
}

// Remove ONE user from ONE competition (shared by the manual DELETE route and
// the reconciler). Extracted verbatim from the DELETE handler: absence row if
// they had started, delete, clear nav hint, drop pending reminders, bust
// caches, evict live session, optional email. Caller is responsible for the
// lifecycle gate (manual route 400s on ended; reconcile skips ended).
//
// v8.1.7 — `context` is the caller's `reqContext(req)`, spread into all three
// emits. This module is request-agnostic by design (it is also driven by the
// reconciler, which has no request at all), so the context has to arrive as a
// parameter rather than be read here — the same shape as `extra` in
// lib/self-enroll. It exists because standing rule 2 says a USER-DRIVEN event
// carries the actor AND their source IP, and self-service leave
// (POST /api/competitions/:id/leave) is this helper's first request-driven
// caller: without it a participant's own departure was the one event class they
// might later dispute ("I never left") recorded with no ip/ua/req_id at all,
// while the ADMIN removal — emitting these same two event types inline — has
// always carried it. Omitted by the reconciler and correctly so: background
// work is attributed "system" with no reqContext, and that exemption is
// structural.
//
// v8.8.9 — THAT REASONING WAS ABOUT THE ACTOR, AND THE ACTOR IS NOT THE TEST.
// Measured: reconcileCompetitionMembership has SIX request-driven entry points
// (routes/sessions.js, routes/competitions.js, routes/groups.js x2,
// routes/participants.js x2) and every one passes a real admin identity, not
// "system" — so the pass is background WORK inside somebody's REQUEST, which is
// exactly the case CLAUDE.md's Audit trail section says the two are orthogonal
// for. `context` is threaded from those call sites now; a pass with no request
// behind it (the scheduler, a reaper) passes none and is still attributed
// "system" with no reqContext, which is the genuine structural exemption.
// v8.12.6 — `lateEntrant` marks a removal made through an event's late-entry
// window (only a late entrant can be removed then); it rides both emits, like
// `late_entry` on an add.
async function removeUserFromCompetition(comp, uid, { actor, sendEmail, reason, deferCacheBust, context, lateEntrant }) {
  const ctx = context || {};
  const user = db.prepare("SELECT id, email, secondary_email, first_name, nickname FROM users WHERE id=?").get(uid);
  if (!user) return { removed: false };
  // v8.12.6 — `assigned_at` too, recorded on the absence row beside the anchor so
  // a re-add restores the original join time (closeAbsenceAndRestoreAnchor).
  const cuRow = db.prepare("SELECT timeslot_id, login_time, last_login_time, assigned_at FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, uid);
  if (!cuRow) return { removed: false };
  const chosenTs = cuRow.timeslot_id ? getTimeslot(cuRow.timeslot_id) : null;
  let removed = false;
  const removeUserTxn = db.transaction(() => {
    // v8.1.0 — the absence row CARRIES the solve-clock anchor. The DELETE
    // below is what destroys `competition_users.login_time`, so recording it
    // here is the only chance; the re-add restores it from this row
    // (closeAbsenceAndRestoreAnchor). Without it the lazy stamp re-anchors the
    // clock to the rejoin moment, which for a finisher clamps solveTimeMs to
    // 0 — a WIN on the sole score tie-break. Written for anybody who ENTERED,
    // on either clock (lib/competitions.js `recordRemovalAbsence`).
    recordRemovalAbsence(uid, comp.id, cuRow, now().toISOString());
    const r = db.prepare("DELETE FROM competition_users WHERE competition_id=? AND user_id=?").run(comp.id, uid);
    if (r.changes > 0) {
      removed = true;
      recordUserEvent(uid, "removed_from_competition", actor, { competition_id: comp.id, competition_name: comp.name, ...(reason ? { via: reason } : {}), ...(lateEntrant ? { late_entrant: true } : {}), ...ctx });
      recordCompetitionEvent(comp.id, "user_removed", actor, { user_id: uid, nickname: user.nickname, ...(reason ? { via: reason } : {}), ...(lateEntrant ? { late_entrant: true } : {}), ...ctx });
    }
    db.prepare("UPDATE users SET active_competition_id=NULL WHERE id=? AND active_competition_id=?").run(uid, comp.id);
    db.prepare("DELETE FROM email_reminders WHERE user_id=? AND competition_id=?").run(uid, comp.id);
  });
  runTxnWithMirrorBuffer(() => removeUserTxn());
  if (!removed) return { removed: false };
  // v6.20.x — deferCacheBust lets the reconciler invalidate these once after the
  // batch instead of per removed user (invalidateAdminParticipantsCache is a full
  // Map.clear()). The manual DELETE route leaves it unset → busts immediately.
  if (!deferCacheBust) {
    invalidateAdminParticipantsCache();
    invalidateLeaderboardCache(comp.id);
  }
  let clearedSessions = 0;
  try { ({ clearedCount: clearedSessions } = clearCompetitionSessionForUser(uid, comp.id)); } catch (e) { swallowed("group-sync:session-clear", e); }
  if (clearedSessions > 0) {
    try { recordUserEvent(uid, "competition_session_cleared", actor, { competition_id: comp.id, competition_name: comp.name, cleared: clearedSessions, ...ctx }); } catch (e) { swallowed("group-sync:session-cleared-emit", e); }
  }
  _invalidateMeCache(uid);
  let emailDelivered = false;
  if (sendEmail) {
    const platformName = getPlatformName();
    const slots = getCompetitionTimeslots(comp.id);
    let sessionInfo = "";
    if (slots.length > 0) {
      if (chosenTs) sessionInfo = `<p>You were enrolled in session: <strong>${escapeHtml(chosenTs.name)}</strong>.</p>`;
      sessionInfo += `<p style="margin-top:8px">Available sessions were:</p><ul style="margin:4px 0">${slots.map(s => `<li>${escapeHtml(s.name)}</li>`).join("")}</ul>`;
    }
    const { html, text } = buildEmail(platformName, {
      greeting: user.first_name || user.nickname,
      body: `<p>Your access to <strong>${escapeHtml(comp.name)}</strong> has been removed by an organiser.</p>${sessionInfo}`,
      fallbackNote: "If you believe this was done in error, please contact your event organiser.",
    });
    emailDelivered = !!(await sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — Event Access Update`, html, text }, "removed_from_competition", { competitionId: comp.id }));
  }
  return { removed: true, emailDelivered };
}

// Reconcile one competition's membership against its bound groups.
//   desired = (∪ members of bound groups) − exclusions
//   ADD    desired members not already present (group-origin; skip ended events
//          that are not taking late entries)
//   REMOVE group-origin members (direct_assigned=0) no longer desired
// Direct (direct_assigned=1) members are never auto-removed. Ended competitions
// are frozen (early return) — unless (v8.12.6) one is still taking LATE ENTRIES,
// when ADD enrols desired members as late entrants and REMOVE takes out only
// group-origin LATE ENTRANTS, so everybody who was in it before it ended stays.
// Live + upcoming both add and remove as before.
// v6.20.6 — caps fanout per call (RECONCILE_MAX) and dispatches assignment/
// removal emails via sendEmailBackground so a slow SMTP hop doesn't wedge the
// HTTP request that triggered reconciliation. If desired or
// to-remove exceeds RECONCILE_MAX, the excess is left for the next reconcile
// trigger and a warn line is logged.
async function reconcileCompetitionMembership(comp, { actor, _depth = 0, context }) {
  if (!comp) return { added: 0, removed: 0, deferred: false };
  // v7.2.x (audit, perf) — fetch the comp's timeslots ONCE and thread them into
  // every competitionStatus() call + the per-user mail builders, instead of an
  // uncached getCompetitionTimeslots query per status-recheck and per email
  // (was up to N identical SELECTs per pass). now() is still read fresh inside
  // competitionStatus, so the per-iteration ended re-check stays time-accurate.
  const slots = getCompetitionTimeslots(comp.id);
  // v8.12.6 — THE ONE ADMISSION PREDICATE (`competitionAdmission`), so live sync
  // follows the same rule as every other door ON EVERY TRIGGER: a bind, a group
  // membership change, and the eligibility re-converges (approve, unblock, the
  // staff tag coming off, a role change, an invitation's groups, the import's
  // group rehydrate). A binding is the admin's standing statement that the group
  // belongs in the event, and admitting on the bind alone would need a second code
  // path while making "live sync" not live. The main board is protected either way:
  // everybody added now is a late entrant, the took-part check below keeps out
  // anybody who played the event, and REMOVE touches late entrants only.
  const adm = competitionAdmission(comp, { slots });
  if (!adm) return { added: 0, removed: 0, deferred: false }; // frozen
  const lateEffEnd = adm === "late" ? competitionEffectiveEnd(comp, slots) : null;
  const bound = db.prepare("SELECT group_id FROM competition_groups WHERE competition_id=?").all(comp.id).map(r => r.group_id);
  const desired = new Set();
  if (bound.length) {
    const ph = "SELECT value FROM json_each(?)";
    for (const r of db.prepare(`SELECT DISTINCT user_id FROM group_members WHERE group_id IN (${ph})`).all(JSON.stringify(bound))) desired.add(r.user_id);
  }
  for (const r of db.prepare("SELECT user_id FROM competition_group_exclusions WHERE competition_id=?").all(comp.id)) desired.delete(r.user_id);
  const current = db.prepare("SELECT user_id, direct_assigned FROM competition_users WHERE competition_id=?").all(comp.id);
  const currentSet = new Set(current.map(r => r.user_id));
  let addsRemaining = RECONCILE_MAX_PER_CALL;
  let removalsRemaining = RECONCILE_MAX_PER_CALL;
  let added = 0, removed = 0, deferred = false;
  // ADD. v6.20.x — assumeNotEnded skips the per-user competitionStatus() recheck
  // (uncached timeslot query) since we early-returned on ended above; deferCacheBust
  // batches the leaderboard/admin-participants invalidation to once after the loops.
  for (const uid of desired) {
    if (addsRemaining <= 0) { deferred = true; log.warn({ ...(context || {}), tag: "reconcile", phase: "add", competition_id: comp.id, cap: RECONCILE_MAX_PER_CALL }, "[reconcile] add cap reached — scheduling a follow-up drain pass"); break; }
    if (currentSet.has(uid)) continue;
    const user = db.prepare("SELECT id, nickname, first_name, last_name, email, secondary_email, timezone, approved, blocked FROM users WHERE id=?").get(uid);
    if (!user) continue;
    if (user.blocked || !user.approved) continue; // same skips as manual assign
    // v8.12.0 — the staff row-writer rule, as the manual assign applies it: a
    // staff-tagged member of a bound group gets a row only on an event where
    // staff compete, and never on one holding a challenge they authored. The
    // same `staffRowRefusal` the join link asks, so the four writers agree.
    if (staffRowRefusal(user, comp)) continue;
    // v8.12.6 — through the late-entry window, somebody who played the event
    // before it ended is not given a NEW row (the assign door's rule). A SILENT
    // skip, exactly like the staff refusal above: live sync reports to nobody, and
    // a desired member it cannot enrol is simply not enrolled.
    if (lateEffEnd && lateWindowAdmissionDenied(comp, uid, lateEffEnd)) continue;
    if (addUserToCompetitionViaGroup(comp, uid, user, actor, { assumeNotEnded: true, deferCacheBust: true, context, lateEntry: !!lateEffEnd })) {
      // Fire-and-forget — assignment email is informational, not a precondition
      // for the HTTP response to succeed.
      sendEmailBackground(user.id, _buildGroupSyncAssignmentMail(user, comp, slots), "competition_assignment", { competitionId: comp.id });
      addsRemaining--;
      added++;
    }
  }
  // REMOVE group-only members no longer desired
  for (const row of current) {
    if (removalsRemaining <= 0) { deferred = true; log.warn({ ...(context || {}), tag: "reconcile", phase: "remove", competition_id: comp.id, cap: RECONCILE_MAX_PER_CALL }, "[reconcile] remove cap reached — scheduling a follow-up drain pass"); break; }
    if (row.direct_assigned) continue;          // direct members are sticky
    if (desired.has(row.user_id)) continue;
    // v6.20.x — re-check ended on each iteration. competitionStatus derives from
    // wall-clock now(); because the loop awaits removeUserFromCompetition, the
    // comp's scheduled end can cross between the function-entry guard and a later
    // iteration. removeUserFromCompetition performs no status check of its own
    // (its comment delegates the lifecycle gate to the caller), so without this a
    // reconcile would mutate a competition that has just become "ended" and is
    // therefore frozen — the same invariant the manual DELETE route 400s on.
    //
    // v8.12.6 — the re-check asks the ADMISSION predicate now, and both halves of
    // that matter. Asking `status === "ended"` here, with the entry guard relaxed,
    // would make REMOVE a silent no-op for the WHOLE late window; and the window
    // itself can close (its deadline passes) or the event can end (and open one)
    // mid-loop, so the per-iteration answer is what decides.
    const a2 = competitionAdmission(comp, { slots });
    if (!a2) { deferred = false; break; }
    // Through the window only a group-origin LATE ENTRANT leaves — the same
    // predicate the manual DELETE enforces (`lateWindowRemovalDenied`), so the
    // group and the dialog cannot disagree about who is removable. Everybody else
    // is KEPT, the same as a frozen ended event keeps them today.
    const _lateRm = a2 === "late";
    if (_lateRm && lateWindowRemovalDenied(comp, row.user_id, slots, { codeOnly: true })) continue;
    // sendEmail:false → reconcile dispatches its own background email below.
    const { removed: didRemove } = await removeUserFromCompetition(comp, row.user_id, { actor, sendEmail: false, reason: "group_sync", deferCacheBust: true, context, lateEntrant: _lateRm });
    if (didRemove) {
      removalsRemaining--;
      removed++;
      try {
        const removedUser = db.prepare("SELECT id, email, secondary_email, first_name, nickname, timezone FROM users WHERE id=?").get(row.user_id);
        if (removedUser) sendEmailBackground(removedUser.id, _buildGroupSyncRemovalMail(removedUser, comp, slots), "removed_from_competition", { competitionId: comp.id });
      } catch (e) { swallowed("group-sync:removal-mail", e); }
    }
  }
  // v6.20.x — single batched cache bust after the loops (was once per added/
  // removed user). Only when something actually changed.
  if (added > 0 || removed > 0) {
    invalidateLeaderboardCache(comp.id);
    invalidateAdminParticipantsCache();
  }
  // v6.20.x — auto-drain the overflow. The per-pass cap keeps any single
  // trigger event-loop-friendly, but pre-fix the excess was only applied if
  // some unrelated future action happened to re-trigger reconcile — so a
  // >500-member bind could leave a competition PERMANENTLY under/over-enrolled.
  // Schedule a detached follow-up pass (yields to the event loop between
  // passes, so each remains bounded) that re-runs until the desired/current
  // diff is drained. A depth guard backstops any pathological loop.
  if (deferred && _depth < RECONCILE_MAX_DRAIN_PASSES) {
    _scheduleReconcileDrain(comp.id, actor, _depth + 1, context);
  } else if (deferred) {
    log.warn({ ...(context || {}), tag: "reconcile", competition_id: comp.id, drain_passes: RECONCILE_MAX_DRAIN_PASSES }, "[reconcile] competition still has a membership backlog after the drain-pass limit — a manual re-trigger may be required");
  }
  return { added, removed, deferred };
}

// v8.8.9 — `context` is the ALREADY-CAPTURED plain object, not `req`: this runs
// on a setImmediate after the response, so there is no request left to read.
// Carrying it is correct — the drain is the continuation of that admin's own
// action and is already attributed to their identity, so the rows it writes
// belong to the same request as the ones the first pass wrote.
function _scheduleReconcileDrain(compId, actor, depth, context) {
  if (_reconcileDrainPending.has(compId)) return;
  _reconcileDrainPending.add(compId);
  _reconcileDrainInFlight++;
  setImmediate(async () => {
    _reconcileDrainPending.delete(compId);
    try {
      const comp = getCompetition(compId);
      if (comp) await reconcileCompetitionMembership(comp, { actor, _depth: depth, context });
    } catch (e) { log.error({ ...(context || {}), tag: "reconcile", competition_id: compId, err: e && e.message }, "[reconcile] drain pass failed"); }
    finally { _reconcileDrainInFlight--; }
  });
}

// v6.20.6 — extract the mail builders from sendGroupSyncAssignmentEmail
// (and the equivalent removal body) so the reconciler can hand a ready
// mailOpts object to sendEmailBackground without keeping a Promise alive.
function _buildGroupSyncAssignmentMail(user, comp, slots) {
  const platformName = getPlatformName();
  if (!slots) slots = getCompetitionTimeslots(comp.id); // v7.2.x (audit) — reuse caller's slots; fall back if called standalone
  // v8.12.6 — an event taking late entries names its late-entry deadline, in the
  // recipient's zone, instead of a start and an end that are both past.
  // (review) — asked about THIS recipient (`lateEntryMailLineFor`), the one rule
  // every builder that knows its recipient follows. Live sync mails only after an
  // actual add, and a new row through the window is a late entrant by
  // construction, so the two answers agree here today; asking the person rather
  // than the event is what keeps them agreeing if that ever stops being true.
  const lateLine = lateEntryMailLineFor(comp, user.id, { slots, tz: user.timezone });
  let compHtml;
  if (lateLine) {
    compHtml = `<li><strong>${escapeHtml(comp.name)}</strong><br/>${lateLine}</li>`;
  } else if (slots.length > 0) {
    const slotList = slots.map(s => {
      const sStart = new Date(s.start_time);
      const sEnd = scheduledEnd(s);
      return `<li><strong>${escapeHtml(s.name)}</strong>: ${formatEmailDate(sStart, user.timezone)} — ${formatEmailDate(sEnd, user.timezone)}</li>`;
    }).join("");
    compHtml = `<li><strong>${escapeHtml(comp.name)}</strong><br/><em>Choose one of the available sessions:</em><ul style="margin:4px 0">${slotList}</ul></li>`;
  } else {
    // The end, or "No fixed deadline" for an open-ended Program (eventEndMailText).
    const start = new Date(comp.start_time);
    compHtml = `<li><strong>${escapeHtml(comp.name)}</strong><br/>Starts: ${formatEmailDate(start, user.timezone)}<br/>Ends: ${eventEndMailText(comp, { slots, tz: user.timezone })}</li>`;
  }
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>You have been invited to participate in the following event:</p><ul style="margin:12px 0">${compHtml}</ul>`,
    linkUrl: BASE_URL, linkText: "Go to " + platformName,
    fallbackNote: "If you believe this was sent in error, please contact your event organiser.",
  });
  return { to: getUserEmails(user), subject: `${platformName} — You have been invited to participate`, html, text };
}

function _buildGroupSyncRemovalMail(user, comp, slots) {
  const platformName = getPlatformName();
  if (!slots) slots = getCompetitionTimeslots(comp.id); // v7.2.x (audit) — reuse caller's slots; fall back if called standalone
  let sessionInfo = "";
  if (slots.length > 0) {
    sessionInfo = `<p style="margin-top:8px">Available sessions were:</p><ul style="margin:4px 0">${slots.map(s => `<li>${escapeHtml(s.name)}</li>`).join("")}</ul>`;
  }
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Your access to <strong>${escapeHtml(comp.name)}</strong> has been removed by an organiser.</p>${sessionInfo}`,
    fallbackNote: "If you believe this was done in error, please contact your event organiser.",
  });
  return { to: getUserEmails(user), subject: `${platformName} — Event Access Update`, html, text };
}

// Reconcile every competition a group is bound to (call after a group's
// membership changes or the group is deleted).
async function reconcileGroupBoundCompetitions(groupId, { actor, context }) {
  const compIds = db.prepare("SELECT competition_id FROM competition_groups WHERE group_id=?").all(groupId).map(r => r.competition_id);
  for (const cid of compIds) await reconcileCompetitionMembership(getCompetition(cid), { actor, context });
}

// audit v7.7.32 (RM4) — re-run reconciliation for every bound competition the
// user is group-desired for. reconcileCompetitionMembership SKIPS a desired
// member who is unapproved / blocked / staff, and reconciliation was only ever
// triggered by group bind/unbind + membership add/remove + group delete — never
// by a change to the user's OWN eligibility. So a user in a group bound to a
// comp, approved (or unblocked, or un-staffed) AFTER the bind, was silently
// never enrolled: they'd log in on event day to no competition. Call this from
// the approve / unblock / staff-tag-removal handlers. Idempotent + safe.
async function reconcileUserGroupCompetitions(userId, { actor, context }) {
  const compIds = db.prepare(
    `SELECT DISTINCT cg.competition_id
       FROM competition_groups cg
       JOIN group_members gm ON gm.group_id = cg.group_id
      WHERE gm.user_id = ?`
  ).all(userId).map(r => r.competition_id);
  for (const cid of compIds) {
    const comp = getCompetition(cid);
    if (comp) await reconcileCompetitionMembership(comp, { actor, context });
  }
}

// v6.20.x — when a user LEAVES a bound group, clear any manual-removal
// tombstones for that group's bound competitions, but only if the user is no
// longer in ANY group bound to that competition. Pre-fix the tombstone (written
// by a manual DELETE /competitions/:id/users/:uid) was clearable ONLY by a
// direct re-assign, so a leave+rejoin via the group never re-enrolled the user
// — a silent foot-gun. Scoping the clear to "no other bound group still wants
// them" preserves the tombstone's intent for users who remain group-desired.
function _clearTombstonesForGroupLeave(groupId, userId) {
  const boundCompIds = db.prepare("SELECT competition_id FROM competition_groups WHERE group_id=?").all(groupId).map(r => r.competition_id);
  for (const cid of boundCompIds) {
    const stillDesired = db.prepare(
      `SELECT 1 FROM competition_groups cg
         JOIN group_members gm ON gm.group_id = cg.group_id
        WHERE cg.competition_id = ? AND gm.user_id = ? LIMIT 1`
    ).get(cid, userId);
    if (!stillDesired) {
      db.prepare("DELETE FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").run(cid, userId);
    }
  }
}

// v7.11.0 (spec req 7) — a participant must not end up in ≥2 groups bound to the
// SAME competition: the group-level leaderboard would then double-count them across
// two group averages. Given the competition + the group(s) an admin is about to
// bind, return the participants who would violate this — but ONLY clashes that the
// NEW bind is actually involved in (a member in ≥2 groups of the resulting set,
// where ≥1 of those groups is being added now). A pre-existing clash between two
// already-bound groups is NOT surfaced here — this bind didn't cause it. Each entry:
// { userId, nickname, groups:[all clashing group names for that user] }. Empty
// array = no clash → safe to bind.
// v8.1.0 (PR 19) — CLASH DETECTION IS GATED ON group_leaderboard_enabled, PER
// COMPETITION.
//
// The rule these three enforce — a participant may not be in two groups bound to
// the SAME competition — exists solely because the group board averages each
// participant into exactly one group. With no team board there is no ambiguity to
// prevent, so the 409 was refusing a legitimate arrangement. It fired for EVERY
// competition regardless of the flag, which is why re-gating it is a real
// behaviour change to `tournament` events too: an admin with two groups sharing a
// member and the board switched off gets a success where they used to get a 409.
//
// PER COMPETITION, INSIDE THE SET — never an early return. Two of the three scan a
// group's WHOLE set of bound competitions, so bailing out early would silently
// drop a real clash against a Competition the same group is also bound to. The
// filter therefore lives in the SQL that builds that set.
//
// It also makes the "every end transition must freeze the team board" invariant
// UNREACHABLE for a kind that cannot enable the board, rather than merely raced.
function detectBoundGroupClashes(competitionId, newGroupIds) {
  // Scoped to ONE competition, so the per-competition test is this line.
  const _c = db.prepare("SELECT group_leaderboard_enabled FROM competitions WHERE id=?").get(competitionId);
  if (!_c || !_c.group_leaderboard_enabled) return [];
  const newSet = new Set(newGroupIds);
  const already = db.prepare("SELECT group_id FROM competition_groups WHERE competition_id=?")
    .all(competitionId).map(r => r.group_id).filter(g => !newSet.has(g));
  const all = Array.from(new Set([...already, ...newGroupIds]));
  if (all.length < 2) return [];
  const ph = "SELECT value FROM json_each(?)";
  const rows = db.prepare(
    `SELECT gm.user_id, gm.group_id, g.name AS group_name, u.nickname
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id IN (${ph})`
  ).all(JSON.stringify(all));
  const byUser = new Map(); // userId → { nickname, groups: Map<groupId,name> }
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { userId: r.user_id, nickname: r.nickname, groups: new Map() });
    byUser.get(r.user_id).groups.set(r.group_id, r.group_name);
  }
  const clashes = [];
  for (const u of byUser.values()) {
    if (u.groups.size >= 2 && [...u.groups.keys()].some(g => newSet.has(g))) {
      clashes.push({ userId: u.userId, nickname: u.nickname, groups: [...u.groups.values()] });
    }
  }
  return clashes;
}

// v7.11.1 (spec req 7 — back-door guard). Adding member(s) to a group that is
// already BOUND to competitions can create the same clash the bind guard prevents
// (a participant in ≥2 groups bound to ONE competition). Given the target group +
// the users being added, return the users who would violate this — a user being
// added who is ALREADY in another group bound to one of the TARGET group's bound
// competitions. Empty array = safe. Each entry:
// { userId, nickname, conflicts:[{competitionName, groups:[other clashing group names]}] }.
// Returns [] when the target group is bound nowhere (adding a member can't clash).
function detectMemberAddClashes(groupId, userIds) {
  const uids = Array.from(new Set((userIds || []).filter(x => typeof x === "string")));
  if (!uids.length) return [];
  // v8.1.0 (PR 19) — only competitions whose team board is ON can clash. Filtered
  // in the SET rather than by an early return, so a group bound to both a
  // board-enabled and a board-disabled competition still reports the real clash.
  const boundComps = db.prepare(
    `SELECT cg.competition_id FROM competition_groups cg
       JOIN competitions c ON c.id = cg.competition_id
      WHERE cg.group_id=? AND c.group_leaderboard_enabled = 1`
  ).all(groupId).map(r => r.competition_id);
  if (!boundComps.length) return [];
  const cph = "SELECT value FROM json_each(?)";
  const uph = "SELECT value FROM json_each(?)";
  const rows = db.prepare(
    `SELECT gm.user_id, u.nickname, comp.id AS comp_id, comp.name AS comp_name, g.name AS other_group_name
       FROM competition_groups cg
       JOIN group_members gm ON gm.group_id = cg.group_id
       JOIN groups g ON g.id = cg.group_id
       JOIN users u ON u.id = gm.user_id
       JOIN competitions comp ON comp.id = cg.competition_id
      WHERE cg.competition_id IN (${cph})
        AND cg.group_id != ?
        AND gm.user_id IN (${uph})`
  ).all(JSON.stringify(boundComps), groupId, JSON.stringify(uids));
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, { userId: r.user_id, nickname: r.nickname, comps: new Map() });
    const u = byUser.get(r.user_id);
    if (!u.comps.has(r.comp_id)) u.comps.set(r.comp_id, { competitionName: r.comp_name, groups: new Set() });
    u.comps.get(r.comp_id).groups.add(r.other_group_name);
  }
  return [...byUser.values()].map(u => ({
    userId: u.userId, nickname: u.nickname,
    conflicts: [...u.comps.values()].map(c => ({ competitionName: c.competitionName, groups: [...c.groups] })),
  }));
}

// v7.11.2 — invitation clash guard. The invite dialog adds a user to MULTIPLE groups
// at once, and (per the spec correction) inviting someone to a competition + a group is
// an INDIVIDUAL assignment unless that group is bound to the competition in its own
// right — so the competition selection is IRRELEVANT to the group clash; only ACTUAL
// competition_groups bindings count. For each user in `userIds`, considering their
// existing bound-group memberships PLUS being added to ALL of `groupIds`, return those
// who would end up in ≥2 groups bound to the same competition. Passing an EMPTY
// `userIds` evaluates the "phantom new invitee" (no prior memberships) so a caller can
// detect a self-overlap among `groupIds` (≥2 of them bound to one competition) that
// would hit every new registrant — returned once with userId=null. Each entry:
// { userId, nickname, conflicts:[{competitionName, groups:[names]}] }.
function detectMultiGroupAddClashes(groupIds, userIds) {
  const gids = Array.from(new Set((groupIds || []).filter(x => typeof x === "string")));
  if (!gids.length) return [];
  const uids = Array.from(new Set((userIds || []).filter(x => typeof x === "string")));
  const gph = "SELECT value FROM json_each(?)";
  // Competitions the INVITED groups are bound to (added for every user, since the
  // invitation adds them to all these groups).
  const invitedBindings = db.prepare(
    `SELECT cg.competition_id, g.name AS gname, comp.name AS cname
       FROM competition_groups cg
       JOIN groups g ON g.id = cg.group_id
       JOIN competitions comp ON comp.id = cg.competition_id
      WHERE cg.group_id IN (${gph}) AND comp.group_leaderboard_enabled = 1`
  ).all(JSON.stringify(gids));
  let existing = [];
  const nick = new Map();
  if (uids.length) {
    const uph = "SELECT value FROM json_each(?)";
    existing = db.prepare(
      `SELECT gm.user_id, cg.competition_id, g.name AS gname, comp.name AS cname
         FROM group_members gm
         JOIN competition_groups cg ON cg.group_id = gm.group_id
         JOIN groups g ON g.id = gm.group_id
         JOIN competitions comp ON comp.id = cg.competition_id
        WHERE gm.user_id IN (${uph}) AND comp.group_leaderboard_enabled = 1`
    ).all(JSON.stringify(uids));
    for (const r of db.prepare(`SELECT id, nickname FROM users WHERE id IN (${uph})`).all(JSON.stringify(uids))) nick.set(r.id, r.nickname);
  }
  const conflictsFor = (uid) => {
    const repr = new Map(); // compId -> { name, groups:Set<groupName>, involvesInvited:bool }
    const add = (cid, cname, gname, invited) => {
      if (!repr.has(cid)) repr.set(cid, { name: cname, groups: new Set(), involvesInvited: false });
      const e = repr.get(cid); e.groups.add(gname); if (invited) e.involvesInvited = true;
    };
    if (uid != null) for (const r of existing) if (r.user_id === uid) add(r.competition_id, r.cname, r.gname, false);
    for (const r of invitedBindings) add(r.competition_id, r.cname, r.gname, true);
    const out = [];
    // audit v7.12.3 (#10) — only surface a clash the INVITED group(s) actually
    // participate in, mirroring detectBoundGroupClashes' involvement filter. Without
    // this, a PRE-EXISTING legacy clash (a user already in 2 groups bound to comp X)
    // 409-blocked every unrelated invitation for that user even when the selected
    // group touched neither X nor any 2-group comp. The phantom-invitee case (uid=null)
    // builds repr solely from invitedBindings, so involvesInvited is always true → unaffected.
    for (const [, v] of repr) if (v.groups.size >= 2 && v.involvesInvited) out.push({ competitionName: v.name, groups: [...v.groups] });
    return out;
  };
  const clashes = [];
  if (uids.length) {
    for (const uid of uids) { const c = conflictsFor(uid); if (c.length) clashes.push({ userId: uid, nickname: nick.get(uid) || "", conflicts: c }); }
  } else {
    const c = conflictsFor(null); if (c.length) clashes.push({ userId: null, nickname: null, conflicts: c });
  }
  return clashes;
}

/**
 * Find a group by its case-folded canonical name (ext-audit v7.15.6/.7).
 *
 * Replaces `WHERE name=? COLLATE NOCASE`, which folds ASCII only and let
 * "Äudit Team" and "äudit Team" coexist. v7.15.7 makes this an INDEXED probe on
 * groups.name_key: the previous version scanned every group and normalised each
 * name in JS, and the participant import called it inside its per-participant
 * group loop — O(memberships x groups) of synchronous event-loop work on a big
 * import. Pass `excludeId` when renaming (ignore the row itself).
 */
function findGroupByName(name, excludeId) {
  const key = _groupNameKey(name);
  if (!key) return null;
  const row = excludeId
    ? db.prepare("SELECT id, name FROM groups WHERE name_key=? AND id<>?").get(key, excludeId)
    : db.prepare("SELECT id, name FROM groups WHERE name_key=?").get(key);
  return row || null;
}

module.exports = {
  findGroupByName,
  removeUserFromCompetition,
  reconcileCompetitionMembership, reconcileGroupBoundCompetitions,
  reconcileUserGroupCompetitions, detectBoundGroupClashes, detectMemberAddClashes,
  detectMultiGroupAddClashes,
  _clearTombstonesForGroupLeave,
  reconcileDrainPending,
};
