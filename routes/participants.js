"use strict";

// Participant admin routes: bulk-assign, remove-from-competition, the
// participants list + picker, user tags, lifecycle (verify/role/approve/deny/
// bulk-approve/block/unlock, the sign-in codes), profile edit, and delete.
// (v7.0.0 refactor: route split.)

const { v4: uuid } = require("uuid");
const db = require("../db");
const { invalidateEventAdminScope, competitionDenied, participantDenied, groupWriteDenied, scopedCompetitionIds, scopeFilterSql, outOfScopeCompetitionIds, actorId, competitorIds } = require("../lib/event-admin"); // v8.7.0 — the event-admin scope primitive
// RBAC — role class: an unscoped (class `all`) role, built-in or custom, is a privileged target.
const { isGlobalClassRole: _isGlobalRole, roleClass: _roleClass, isBuiltinRole: _isBuiltinRole, roleDefinition: _roleDefinition, roleAssignDenied: _roleAssignDenied, roleIdsOfClass: _roleIdsOfClass, privilegedTargetFor: _privilegedTarget, actorPermissions: _actorPermissions, actorMayApproveNow: _actorMayApproveNow, customRoleAllows: _customRoleAllows } = require("../lib/rbac");
const { getAdminIdentity, recordCompetitionEvent, recordOrphanedAuditEvent, recordTimeslotEvent, recordUserEvent, reqContext, runTxnWithMirrorBuffer } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { eventPolicy } = require("../lib/event-policy");
const { scheduledEnd, _invalidateCompetitionCache, competitionStatus, competitionEffectiveEnd, getCompetition, getCompetitionTimeslots, getTimeslot, closeAbsenceAndRestoreAnchor, recordRemovalAbsence, lateEntryWindowOpen, lateEntryJoinCutoff, lateEntryStateFor, competitionAdmission, lateWindowAdmissionDenied, lateWindowRemovalDenied, lateEntryMailLineFor, eventEndMailText } = require("../lib/competitions");
const { BASE_URL, BULK_ADMIN_MAX, PERF_SPAN_SLOW_MS } = require("../lib/config");
const { enqueueCxOneProvision, requeueDeferredCxOneProvision } = require("../lib/cxone");
const { emailIsTaken } = require("../lib/email-identity");
const { buildEmail, getUserEmails, sendEmailLogged, sendUnlockEmail, sendLoginCodeEmail } = require("../lib/email");
const { reconcileCompetitionMembership, reconcileUserGroupCompetitions, detectBoundGroupClashes } = require("../lib/group-sync");
const { invalidateLeaderboardCache, invalidateGroupLeaderboardSnapshot } = require("../lib/leaderboard");
const { log, sanitiseForLog } = require("../lib/log");
const { _invalidateMeCache } = require("../lib/me-cache");
const { deleteUserCascade } = require("../lib/account-reaper");
const { csrfProtection, rateLimit, destructiveAdminLimit, bulkAdminLimit, requireAdmin, requireSuperAdmin, requirePermission, testAdminEmailDelay, adminAuthzDenied, testAdminCommitPark } = require("../lib/middleware");

/**
 * v8.3.36 — does THIS admin save stage a new primary address?
 *
 * One predicate, because four sites branch on it (the second same-slot clause,
 * the immediately-active corporate-email check, the write, and the mail) and a
 * re-derived comparison is how those four come to disagree about which address
 * is live. Case-insensitive, mirroring `emailChanged` on the self path.
 */
function _adminStagesPrimary(user, newEmail) {
  return (newEmail || "").toLowerCase() !== ((user && user.email) || "").toLowerCase();
}
const { getCachedParticipantsPage, invalidateAdminParticipantsCache, setCachedParticipantsPage } = require("../lib/participants-cache");
const { escapeHtml, sanitiseAvatar, validateAvatarDataUri, persistAvatar, deleteAvatarImage } = require("../lib/sanitise");
const { _resyncStatusObservationAfterRevive } = require("../lib/scheduler");
const { clearCompetitionSessionForUser, invalidateOtherSessions, SESSION_END } = require("../lib/sessions");
const { getPlatformName, getRequireAccountApproval } = require("../lib/settings");
const { isLockedNow, clearLockout } = require("../lib/lockout"); // v7.29.0 — one definition of "is this account locked"
const { issueCode, formatCode, isCodeEligible, codeBlockedReason, hasSignedIn, CODE_VIA_DESK, CODE_VIA_EMAIL, codeRecentlySent, deskCodeLive, liftResendSuppression } = require("../lib/login-code"); // v7.29.0 — the desk fallback

/**
 * WHICH condition refuses the DESK reveal ("Show sign-in code"), or null.
 *
 * Narrower than `codeBlockedReason` (which governs emailed codes for every role):
 *   * participants only — a desk code is read off the organiser's own screen, so
 *     revealing an admin's would let one admin sign in as another;
 *   * approved only — a desk code proves nothing about the mailbox, so redeeming
 *     one never approves (routes/auth.js), and handing out a code that will be
 *     refused is the "affordance that lies" defect;
 *   * never signed in only (operator ruling, 14 Nov 2026; lib/login-code.js
 *     `hasSignedIn`) — a shown code is a full session as the person, so it is for
 *     the walk-up just added at the desk or whose first code never arrived; after
 *     a first sign-in the desk can only email a code to the sign-in address.
 *     Last, so a remedy named for an earlier reason is still the next step.
 * The ONE spelling for the reveal route, the row projection (`can_use_code`) and
 * the desk-invite duplicate remedy, so the three cannot disagree. Every row that
 * reaches it carries `login_time` and `last_login_time` (`hasSignedIn` throws
 * without them).
 */
function _codeBlockedReason(u) {
  if ((u.role || "participant") !== "participant") return "not_participant";
  const r = codeBlockedReason(u);
  if (r) return r;
  if (!u.approved) return "not_approved";
  if (hasSignedIn(u)) return "signed_in_before";
  return null;
}
const { formatEmailDate, now } = require("../lib/time");
const { _invalidateUserTagsCache, isStaff } = require("../lib/user-tags");
const { staffCompeteOn, authoredAssignedTasks, competitorEditDenied, competitorRivalDenied, rivalsOf, refuseCompetitor, competitorRefusalBody } = require("../lib/staff-compete"); // v8.12.0
const { actingAdminCompetesInTargetEvents, organiserPanelOpensTo } = require("../lib/impersonation"); // v8.12.1 — the event-admin view's entry refusal
const { _capsOk, _firstNonStringField, isValidTimezone, _runBoundedWithDeadline, awaitDeliveryWithDeadline, isFreeEmail, isValidEmailFormat, normaliseEmail, sameSlotEmails, NO_PASSWORD_HASH, validateUrl, _nicknameCharsOk, NICKNAME_CHARSET_ERROR, profileVersionSql, clampPagingIndex, profileTextControlField, profileTextControlBody } = require("../lib/util");
const { validateBody } = require("../lib/validate");

/**
 * Thrown out of the admin profile transaction when the optimistic-concurrency
 * compare-and-swap matched no row, i.e. `users.updated_at` moved between the
 * admin's last read and this write. A CLASS, never a string match on the
 * message: a refusal identified by its prose is one copy-edit away from being
 * caught as a 500.
 */
class StaleRowError extends Error {
  constructor(currentUpdatedAt) {
    super("profile row changed under this write");
    this.code = "STALE_ROW";
    this.currentUpdatedAt = currentUpdatedAt || null;
  }
}

// ext-audit v7.15.14 — how long a request will wait on its post-commit SMTP
// fan-out before replying and letting the rest finish detached. Comfortably
// under the client's 30 s abort (public/js/core/api.js fetchWithLoading).
const EMAIL_FANOUT_DEADLINE_MS = 10_000;

/**
 * v8.8.7 — WHICH EVENTS DOES THIS PERSON ORGANISE, with enough on each row for
 * the client to render it as a status badge rather than as a name.
 *
 * ONE definition, called by both payloads that carry `event_admin_for`. The
 * picker's own comment already warns that "a field present on one and absent on
 * the other is a column that empties itself depending on whether a competition
 * happens to be focused" — and the two queries were byte-identical apart from
 * their loop, so adding seven columns and a status computation twice is exactly
 * how that comment comes true.
 *
 * THE EXTRA COLUMNS ARE NOT OPTIONAL. `lateEntryWindowOpen` asks `eventPolicy`,
 * which THROWS on a row with no `event_kind` rather than guessing a kind — the
 * same strictness `eventPolicyForWire` has, and for the same reason. So a
 * hand-written SELECT that forgets one does not degrade, it 500s the admin list.
 *
 * Narrowed by the VIEWER's own scope, exactly as before: a colleague's
 * co-organised event shows only where the two overlap.
 */
function _eventAdminForMap(req, userIds) {
  const map = {};
  if (!userIds.length) return map;
  const scope = scopeFilterSql(req, "ca.competition_id");
  const rows = db.prepare(
    `SELECT ca.user_id, c.id, c.name, c.start_time, c.duration_minutes, c.ended_at, c.ended_manually,
            c.event_kind, c.late_entry_enabled, c.late_entry_deadline_at
       FROM competition_admins ca JOIN competitions c ON c.id=ca.competition_id
      WHERE ca.user_id IN (SELECT value FROM json_each(?))${scope.clause}
      ORDER BY c.name COLLATE NOCASE`
  ).all(JSON.stringify(userIds), ...scope.params);

  // Batch the timeslots ONCE for the distinct events on this page — the N+1 the
  // competitions column beside this one was fixed for in v6.20.x.
  const compIds = [...new Set(rows.map(r => r.id))];
  const slotsByComp = new Map();
  if (compIds.length) {
    for (const s of db.prepare(
      // One json_each(?) bind, so the statement text is constant (db.prepare is memoised by SQL text).
      `SELECT * FROM competition_timeslots WHERE competition_id IN (SELECT value FROM json_each(?)) ORDER BY start_time`
    ).all(JSON.stringify(compIds))) {
      if (!slotsByComp.has(s.competition_id)) slotsByComp.set(s.competition_id, []);
      slotsByComp.get(s.competition_id).push(s);
    }
  }
  // ONE clock for the whole page, so two rows of one response cannot land on
  // opposite sides of a late-entry deadline (v8.8.0).
  const nowMs = Date.now();
  for (const r of rows) {
    const slots = slotsByComp.get(r.id) || [];
    (map[r.user_id] = map[r.user_id] || []).push({
      id: r.id,
      name: r.name,
      status: competitionStatus(r, slots),
      late_entry_window_open: lateEntryWindowOpen(r, competitionEffectiveEnd(r, slots), nowMs),
    });
  }
  return map;
}

module.exports = function register(app) {
app.post("/api/admin/competitions/assign", requireAdmin, bulkAdminLimit, csrfProtection, async (req, res) => {
  let { userIds, competitionIds, groupIds } = req.body;
  // v6.20.0: assignment can target participants directly (userIds), whole
  // groups (groupIds, live-synced), or both. At least one of the two is required.
  if (userIds === undefined) userIds = [];
  if (groupIds === undefined) groupIds = [];
  if (!Array.isArray(userIds)) return res.status(400).json({ error: "userIds must be an array" });
  if (!Array.isArray(groupIds)) return res.status(400).json({ error: "groupIds must be an array" });
  if (userIds.length === 0 && groupIds.length === 0)
    return res.status(400).json({ error: "userIds or groupIds array required" });
  if (!Array.isArray(competitionIds) || competitionIds.length === 0)
    return res.status(400).json({ error: "competitionIds array required" });
  // v6.16.11 — dedupe input arrays (matches bulk-invite's `_seen`
  // pattern at server.js:~8742). A scripted caller passing the same
  // uid/cid twice would otherwise hit BULK_ADMIN_MAX faster than
  // expected (counted before the loop short-circuits via
  // `INSERT OR IGNORE`) and produce noisier audit batch_ids.
  // v6.16.14 — reject 400 if non-string entries present. Pre-fix
  // v6.16.11 silently filtered them via `.filter(typeof === "string")`
  // — a scripted caller's tampered request got zero feedback. Now
  // reject with explicit error so the caller sees the contract violation.
  if (userIds.some(x => typeof x !== "string"))
    return res.status(400).json({ error: "userIds must be an array of strings" });
  if (competitionIds.some(x => typeof x !== "string"))
    return res.status(400).json({ error: "competitionIds must be an array of strings" });
  if (groupIds.some(x => typeof x !== "string"))
    return res.status(400).json({ error: "groupIds must be an array of strings" });
  userIds = Array.from(new Set(userIds));
  competitionIds = Array.from(new Set(competitionIds));
  groupIds = Array.from(new Set(groupIds));
  if (groupIds.length > 200)
    return res.status(400).json({ error: "Cannot bind more than 200 groups in a single request." });
  // v6.9.12: per-request cap matches bulk-approve. Prevents a single
  // POST from triggering N users × M comps of serial CxOne provisioning
  // (each ~500 ms upstream) and an unbounded email-send loop.
  if (userIds.length > BULK_ADMIN_MAX)
    return res.status(400).json({ error: `Cannot assign more than ${BULK_ADMIN_MAX} users in a single request.` });
  if (competitionIds.length > 50)
    return res.status(400).json({ error: "Cannot assign to more than 50 events in a single request." });

  // v8.7.0 — ONLY THE COMPETITIONS ARE SCOPED HERE, and the asymmetry is the
  // decision worth stating. Adding people to your own event is the ordinary
  // case of the event-admin role, so ANY participant may be a target and
  // `memberTargetsDenied` is deliberately NOT applied to `userIds` — an
  // organiser enrolling a walk-up who is in no event yet is the normal flow,
  // and refusing it would make the role unable to do its main job.
  //
  // What they may not do is reach into somebody else's event. That is refused
  // by NAME rather than skipped: a bulk route that silently drops half its
  // targets and reports success is the "control that appears to work" failure,
  // and here the dropped half is the one the actor most needs told about.
  //
  // Refused BEFORE the group binds and the per-comp writes below, so a refused
  // assign leaves nothing behind.
  const _oosComps = outOfScopeCompetitionIds(req, competitionIds);
  if (_oosComps.length) {
    const _oosNames = _oosComps.map(cid => { const c = getCompetition(cid); return c ? `"${c.name}"` : cid; });
    return res.status(403).json({
      error: `You are not an organiser of ${_oosNames.join(", ")}. Ask an administrator to add you to it, or remove it from this assignment.`,
      code: "event_admin_out_of_scope",
      competitionIds: _oosComps,
    });
  }
  // v8.12.0 — a competitor may not enrol anybody into the event they compete in
  // (every mutating door on that event is theirs to be refused at; this is the
  // one that changes WHO is on the board beside them). Refused by name, before
  // any write, like the scope refusal above.
  for (const cid of competitionIds) {
    const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), cid));
    if (_cmp) return _cmp;
  }
  // v8.7.0 — a group is a TRANSITIVE membership writer, so `groupViewDenied` is
  // not enough here. Binding one makes `reconcileCompetitionMembership` move
  // membership across EVERY competition that group is bound to, including ones
  // outside this actor's scope — the hole `groupWriteDenied` exists to close.
  for (const gid of groupIds) {
    const _gDenied = groupWriteDenied(req, gid);
    if (_gDenied) return res.status(403).json({ error: _gDenied.message, code: _gDenied.code });
  }

  const assignedBy = getAdminIdentity(req);
  const assignedAt = now().toISOString();
  const batchId = uuid();
  const insert = db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)");
  // v6.12.0: close any open absence row for this (user, comp). The DELETE
  // path opens a row when the user was removed WITH login_time set; the re-add
  // stamps returned_at=now() the next time that user is bulk-assigned to the
  // same comp. Idempotent — if no absence is open it is a no-op.
  // buildLeaderboardEntries subtracts SUM(returned_at - removed_at) from
  // solveTimeMs per user, so the gap during which they had no access doesn't
  // count against their time-to-solve.
  //
  // v8.1.0 — that close, and the anchor restore that must accompany it, now
  // live in closeAbsenceAndRestoreAnchor (lib/competitions.js) rather than in a
  // prepared statement per re-add site. Three copies of the rule is how the
  // next one arrives without the restore.
  // v6.12.1: re-adding a user who previously participated restores their
  // session membership. Without this, the freshly-inserted
  // competition_users row has timeslot_id=NULL, and:
  //   • the UI's /api/select-competition flow offers them the slot
  //     chooser (needsTimeslotChoice=true) even though their history
  //     pins them to a specific slot,
  //   • the per-slot leaderboard admit gate filters them out
  //     (`s.timeslot_id = cu.timeslot_id` never matches on NULL),
  //   • auto-end scans and admin visibility miss them.
  // Look up the pinned slot from submissions/hint_reveals; if found,
  // write it back onto the new row. If the user has no history
  // (pre-assigned and removed before ever starting), timeslot_id stays
  // NULL and the chooser correctly re-surfaces.
  // v6.16.5 — gate the historical-slot restore on slot existence. Pre-fix
  // a removed user's history could pin them to a slot the admin had
  // since deleted (DELETE timeslot blocked only on CURRENT
  // competition_users references; the removed user's history rows
  // weren't a barrier). Re-add then wrote a non-existent slot id back,
  // and the per_slot leaderboard's `cu.timeslot_id = ts.id` join filter
  // silently dropped the user — they vanished from rankings.
  const restoreSlot = db.prepare(
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
  );
  let assigned = 0;

  // Validate competitions — reject manually ended ones; auto-ended may be revivable
  //
  // v8.12.6 — AND AN EVENT STILL TAKING LATE ENTRIES IS ADMITTED. Before this, a
  // Booth Event inside its late-entry window refused the assign outright — and
  // because this loop `return`s, one such event in a multi-event request refused
  // the WHOLE request, and a `groupIds` bind to it too. Everyone added through the
  // window is a LATE ENTRANT by construction: their row's `assigned_at` is now,
  // after the end, which `isLateEntry` classifies late; nothing here writes a
  // classification. ONE clock for the request, so two events of one request
  // cannot land on opposite sides of a deadline.
  const nowMs = Date.now();
  const validComps = [];
  // compId → effective end, for every event admitted through its window. The
  // effective end is what the took-part check and the mail line are asked about.
  const lateComps = new Map();
  for (const cid of competitionIds) {
    const comp = getCompetition(cid);
    if (!comp) continue;
    if (competitionStatus(comp) === "ended") {
      const _slots = getCompetitionTimeslots(comp.id);
      // v7.2.x (audit, correctness #5) — reject a NATURALLY-ended comp that is
      // NOT revivable, i.e. no slot (multi-slot) and not the comp itself
      // (single-slot) has a scheduled end still in the future. Assigning there
      // strands the membership (the revive block can't re-activate it) and fires
      // a misleading "invited" email with all-past dates; a groupIds bind would
      // dangle (reconcile early-returns on ended). Auto-ended-EARLY comps (all
      // solved before the scheduled end) keep a future scheduled end → still
      // revivable → allowed through to the revive block below. Mirrors that
      // block's own revivability test (scheduled end = start + duration > now), so
      // it covers BOTH single- and multi-slot. A MANUALLY-ended comp is never
      // revivable here.
      const _revivable = !comp.ended_manually && (_slots.length === 0
        ? scheduledEnd(comp) > now()
        : _slots.some(ts => scheduledEnd(ts) > now()));
      // v8.12.6 — THE ORDER IS THE DECISION. A revivable event keeps its revive
      // path, ahead of the late-entry window: the only shape that is both is a
      // legacy v8.0.0 auto-ended Booth Event whose schedule is still running,
      // which v8.3.11 deliberately keeps revivable, so it behaves exactly as it
      // did. Everything else ended is admitted ONLY through its window
      // (`competitionAdmission`, lib/competitions.js — the one predicate every
      // door asks), and refused with the message it always had otherwise.
      if (!_revivable) {
        if (competitionAdmission(comp, { slots: _slots, nowMs }) === "late") {
          lateComps.set(comp.id, competitionEffectiveEnd(comp, _slots));
          validComps.push(comp);
          continue;
        }
        if (comp.ended_manually) {
          return res.status(400).json({ error: `Cannot assign participants to ended event "${comp.name}". It was ended manually by an admin.` });
        }
        return res.status(400).json({ error: `Cannot assign participants to ended event "${comp.name}". Its scheduled time has passed.` });
      }
    }
    validComps.push(comp);
  }

  // v7.11.0 (spec req 7) — a participant may not be in ≥2 groups bound to the SAME
  // competition (the group-level leaderboard would double-count them across two
  // group averages). Check each target comp across (already-bound ∪ groupIds)
  // BEFORE any mutation — so the whole assign is atomic — and HARD-BLOCK (409) with
  // a message naming each clashing participant + the groups they're in, suggesting
  // removal from all but one. Only clashes the NEW bind is involved in are surfaced.
  if (groupIds.length) {
    for (const comp of validComps) {
      const clashes = detectBoundGroupClashes(comp.id, groupIds);
      if (clashes.length) {
        const detail = clashes.map(c => `${c.nickname} (in ${c.groups.join(" + ")})`).join("; ");
        return res.status(409).json({
          error: `Can't add these groups to "${comp.name}" — the same participant is in more than one of its groups: ${detail}. Remove each listed participant from all but one of those groups (either the group already on the event or the one you're adding) before proceeding.`,
          clash: { competitionId: comp.id, competitionName: comp.name, conflicts: clashes },
        });
      }
    }
  }

  // v7.12.3 (audit #11) — commit the group→competition BINDS here, synchronously,
  // immediately after the clash check with NO intervening await. better-sqlite3 is
  // synchronous and this is a single-process server, so detectBoundGroupClashes →
  // INSERT is now race-free: a concurrent assign/member-add cannot slip a second
  // bound group in between the check and the write. Pre-fix the bind ran only AFTER
  // the awaited SMTP fan-out + per-comp reconcile below — a multi-second TOCTOU window
  // in which the guarded ≥2-bound-groups state could be committed by another request.
  // The awaited reconcileCompetitionMembership passes stay below (they re-fetch the comp).
  let groupsBound = 0;
  if (groupIds.length) {
    const bindStmt = db.prepare("INSERT OR IGNORE INTO competition_groups (competition_id, group_id, assigned_by, assigned_at) VALUES (?,?,?,?)");
    for (const comp of validComps) {
      for (const gid of groupIds) {
        if (!db.prepare("SELECT id FROM groups WHERE id=?").get(gid)) continue;
        if (bindStmt.run(comp.id, gid, assignedBy, assignedAt).changes > 0) {
          groupsBound++;
          // audit-event-logging audit (v7.7.15) — first-class bind event, parity
          // with group_unbound (routes/groups.js) so "who bound which group to
          // which competition" is in the trail, not only on competition_groups.assigned_by.
          try { recordCompetitionEvent(comp.id, "group_bound", assignedBy, { group_id: gid, ...reqContext(req), ...(lateComps.has(comp.id) ? { late_entry: true } : {}) }); } catch (e) { swallowed("participants:group-bound-audit", e); }
        }
      }
    }
  }

  // Insert assignments — track which competitions are new for each user + provision CxOne
  const newCompsPerUser = new Map(); // uid -> [comp, ...]
  const affectedCompIds = new Set(); // v6.10.24: for leaderboard-cache invalidation
  let skippedStaff = 0;
  // v6.13.21 — "approve first, then assign" invariant. Pre-fix the
  // assignment path silently accepted any user, including unapproved
  // and blocked accounts. Those users couldn't actually enter the
  // competition (login refuses), so the assignment created a stranded
  // competition_users row, queued a misleading "you have been invited
  // to participate" email, and triggered useless CxOne provisioning
  // against accounts that would never use them. Skip with explicit
  // counters so the admin sees what the request actually did, mirroring
  // the existing skippedStaff pattern.
  let skippedUnapproved = 0, skippedBlocked = 0;
  // v8.12.0 — STAFF CAN COMPETE, and three new skips are its consequence.
  //
  // `skippedStaff` used to be per USER ("staff join competitions on their own"
  // — they need no row, `requireParticipantInCompetition` admits them without
  // one). It is per (user, event) PAIR now: a staff member is assignable ONLY
  // to an event whose "Staff can compete" switch is on, and a request naming
  // two events may legitimately enrol them in one and skip the other. Counted
  // per pair so the toast can say what was skipped rather than who.
  //
  // `skippedAuthors` — on a compete event a sealed challenge's key is readable
  // by its AUTHOR, so enrolling the author of an assigned challenge would seat
  // a competitor who knows an answer. Refused at the assignment of the
  // challenge too (routes/challenges.js); this is the same rule from the other
  // door, and it names the challenges so the admin can act on it.
  //
  // `skippedPrivileged` — the peer-admin doctrine (v7.14.2): a REGULAR admin may
  // not manage an admin or superadmin account, and enrolling one as a competitor
  // is managing it. A superadmin may; anybody may enrol THEMSELVES, which is
  // the ordinary way an organiser joins the event they will compete in.
  const skippedAuthors = [];
  let skippedPrivileged = 0;
  // v8.12.6 — somebody who played an event taking late entries before it ended
  // cannot be given a NEW row through its window (`lateWindowAdmissionDenied`):
  // they would land back on its final board, or on the late board with their
  // event points. Counted per (user, event) pair like the skips above.
  let skippedTookPart = 0;
  const _actorId = actorId(req);
  for (const uid of userIds) {
    const user = db.prepare("SELECT id, nickname, first_name, last_name, email, approved, blocked, role FROM users WHERE id=?").get(uid);
    if (!user) continue;
    const _staffUser = isStaff(uid);
    if (user.blocked)   { skippedBlocked++;   continue; }
    if (!user.approved) { skippedUnapproved++; continue; }
    for (const comp of validComps) {
      // Staff enter a non-compete event on their own, with no row — so writing
      // one is skipped. A row they ALREADY hold (assigned before the tag, or before
      // this release) is a membership, and takes the idempotent path below like
      // anybody's: reporting it as a staff skip left a group-origin row never
      // promoted to direct, so the live sync could still auto-remove it. The join
      // door reads membership first for the same reason.
      const _held = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, uid);
      if (_staffUser && !staffCompeteOn(comp) && !_held) { skippedStaff++; continue; }
      // …and the same for the two compete-event skips below: a held row is a
      // membership, so re-assigning a peer admin (or an author) who already
      // holds one changes nothing but the promotion, and reporting that as a
      // privileged or author skip told the operator something was refused when
      // nothing was asked. The invitation door (`_heldInv`) has always honoured
      // the held row for all three; the first draft here honoured it for the
      // spectator skip alone, so the two dialogs named different reasons for
      // that one pair.
      if (staffCompeteOn(comp) && !_held) {
        if (_privilegedTarget(req, user.role) && uid !== _actorId) { skippedPrivileged++; continue; }
        const _authored = authoredAssignedTasks(db, uid, comp.id);
        if (_authored.length) {
          skippedAuthors.push({ userId: uid, nickname: user.nickname, competitionId: comp.id, competitionName: comp.name, tasks: _authored });
          continue;
        }
      }
      // v8.12.6 — asked LAST of the skips and only for a NEW row: a held row is a
      // membership, and the held-row branch in the transaction below makes it a
      // true no-op through the window.
      const _late = lateComps.has(comp.id);
      if (_late && !_held && lateWindowAdmissionDenied(comp, uid, lateComps.get(comp.id))) { skippedTookPart++; continue; }
      // v6.16.10 — wrap the per-(user, comp) writes in a single txn
      // so the v6.12.0 invariant ("re-add closes the absence and
      // restores the slot atomically") matches the implementation.
      // Pre-fix the four writes (insertCU + closeAbsence + restoreSlot
      // + audit events) ran as independent statements; SIGKILL between
      // them could leave the user "assigned" but with the absence row
      // not closed (gap subtraction misses) or the slot not restored
      // (per-slot leaderboard skips them). A concurrent /api/leaderboard
      // reader between insertCU and restoreSlot could also build a
      // board where the user appears with no slot.
      let didInsert = false;
      const perCompTxn = db.transaction(() => {
        // v7.21.32 — read the pre-state, because the PROMOTION below is a durable
        // change that happens on an already-member row and used to return before
        // any emit. `direct_assigned` decides whether live group-sync may ever
        // auto-remove this participant again, so flipping it is exactly the kind
        // of state change an operator asks about later.
        const prevDirect = db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?")
          .get(comp.id, uid);
        const result = insert.run(comp.id, uid, assignedBy, assignedAt);
        // v8.12.6 — THROUGH THE LATE-ENTRY WINDOW A HELD ROW OF SOMEBODY WHO WAS IN
        // THE EVENT BEFORE IT ENDED IS A TRUE NO-OP: no `direct_assigned`
        // promotion, no tombstone clear, `assigned_at` untouched (INSERT OR IGNORE
        // already left it). The promotion would hand an ORIGINAL group-origin
        // participant a new solo row on a team board that is not yet frozen (a
        // board whose flag was off at the end is frozen lazily), which is a
        // post-end rewrite of a finished result. It is reported as already
        // assigned, like any re-assign that changes nothing.
        //
        // (review) — A LATE ENTRANT'S held row takes the ordinary promotion below.
        // That reason cannot reach them: `_computeGroupLeaderboard` drops late
        // entrants before it builds a group or a solo row, and they were never on
        // the final roster. What the no-op DID do to them was discard the admin's
        // explicit direct assignment — so a group-added walk-up stayed
        // group-origin, and leaving the group took them out of the event, the
        // opposite of what "assign them directly" has meant since v6.20.0. The
        // FULL classification (`lateEntryStateFor(...).isLate`), never a bare
        // join-time test: it keeps `isLateEntry`'s backstop, under which a joiner
        // after the end who had finished by it (a schedule re-timed under them)
        // is an ordinary member on the final board.
        if (result.changes === 0 && _late && !lateEntryStateFor(comp, uid, getCompetitionTimeslots(comp.id)).isLate) return;
        // v6.20.0: a direct (manual) assignment always promotes the row to
        // direct_assigned=1 — so a later group desync won't auto-remove it —
        // and clears any group-removal tombstone. Runs whether the row is new
        // or a pre-existing group-origin row being "promoted" to direct.
        db.prepare("UPDATE competition_users SET direct_assigned=1 WHERE competition_id=? AND user_id=?").run(comp.id, uid);
        db.prepare("DELETE FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").run(comp.id, uid);
        if (result.changes === 0) {
          // Already a member: no new-row side effects, but the promotion above may
          // still have changed something durable. Emit only when it actually did,
          // so a re-assign that changes nothing stays silent.
          if (prevDirect && !prevDirect.direct_assigned) {
            recordCompetitionEvent(comp.id, "membership_promoted", assignedBy, {
              user_id: uid, nickname: user.nickname, from_direct_assigned: 0, to_direct_assigned: 1,
              batch_id: batchId, ...(_late ? { late_entry: true } : {}), ...reqContext(req),
            });
            recordUserEvent(uid, "membership_promoted", assignedBy, {
              competition_id: comp.id, competition_name: comp.name, batch_id: batchId, ...(_late ? { late_entry: true } : {}), ...reqContext(req),
            });
          }
          return;
        }
        didInsert = true;
        // v6.12.0: re-add closes any open absence row.
        // v8.1.0: ...and restores the solve-clock anchor the removal recorded on
        // it. Shared with the group-sync and self-enroll re-adds so the rule has
        // one definition — see lib/competitions.js for why a re-add that only
        // closes the row re-anchors a finisher's clock to the rejoin and clamps
        // their solveTimeMs to 0, winning the sole score tie-break.
        closeAbsenceAndRestoreAnchor(uid, comp.id, assignedAt);
        // v6.12.1: restore pinned slot from history on re-add.
        // 7 placeholders: subquery × 2 (user, comp) + slot-existence comp + outer (user, comp).
        restoreSlot.run(uid, comp.id, uid, comp.id, comp.id, uid, comp.id);
        // v8.12.6 — `late_entry` records the CIRCUMSTANCE of the write (it went
        // through the window), an immutable fact; lateness itself stays derived per
        // read (lib/late-entry.js decision 3).
        recordUserEvent(uid, "added_to_competition", assignedBy, { competition_id: comp.id, competition_name: comp.name, batch_id: batchId, ...(_late ? { late_entry: true } : {}), ...reqContext(req) });
        recordCompetitionEvent(comp.id, "user_added", assignedBy, { user_id: uid, nickname: user.nickname, batch_id: batchId, ...(_late ? { late_entry: true } : {}), ...reqContext(req) });
      });
      // runTxnWithMirrorBuffer (v6.16.9) keeps audit-log mirror lines
      // in lockstep with txn commit/rollback so a per-comp failure
      // doesn't leak ghost "user_added" lines to app.jsonl.
      runTxnWithMirrorBuffer(() => perCompTxn());
      if (didInsert) {
        assigned++;
        affectedCompIds.add(comp.id);
        if (!newCompsPerUser.has(uid)) newCompsPerUser.set(uid, []);
        newCompsPerUser.get(uid).push(comp);
        // v6.9.17: CxOne provisioning is deferred off the hot path so
        // the handler returns in N×M DB-inserts instead of N×M HTTP
        // roundtrips.
        // v6.16.14: routed through the CxOne queue (max 5 in-flight)
        // so a 1000-user × 50-comp bulk-assign can't fan out 50000
        // concurrent IDP calls and saturate the upstream connection
        // pool / trigger token-endpoint thundering-herd.
        enqueueCxOneProvision(user, comp.id, "assign");
      } else {
        // Already a member: provisions nobody — except a member whose Checkmarx
        // One set-up was deferred (the account it reached was being removed) and
        // is not being retried any more. Re-assigning them is that set-up's
        // remedy, and its History row says so.
        requeueDeferredCxOneProvision(user, comp.id, "assign_after_deferral");
      }
    }
  }

  // Re-activate competitions/timeslots that were auto-ended (not manually) and scheduled end is still in the future.
  // v6.9.12: wrap UPDATE + event-write pairs in db.transaction() so a
  // crash between the two can't leave `ended_at=NULL` without a
  // corresponding revival audit row. Pre-v6.9.12 the write-then-event
  // pair was non-atomic and would have left inconsistent audit state on
  // process exit mid-revival.
  const revivedNames = [];
  const revivedCompIds = new Set();
  for (const comp of validComps) {
    // audit v7.7.37 (C4) — only revive a comp/timeslot that actually gained a NEW
    // participant in THIS request. The assign-driven revive exists because a new
    // participant breaks the all-solved auto-end condition; reviving when every
    // requested user was skipped (blocked/unapproved/staff), already a member
    // (INSERT OR IGNORE changes=0 — the direct_assigned promotion path), or a
    // groupIds-only bind that adds nobody, un-ends an all-solved comp that nothing
    // will ever re-end (retracting badge-minting + answer-reveal until scheduled
    // end). affectedCompIds is populated only where didInsert fired.
    if (!affectedCompIds.has(comp.id)) continue;
    // v8.12.6 — an admission through the late-entry window never revives: the
    // window extends PLAY, not the event. Unreachable today (the validation loop
    // admits a revivable event on its revive path instead, so nothing in
    // `lateComps` has a future scheduled end), and stated here so the next edit to
    // either loop cannot make a late admission un-end a finished event.
    if (lateComps.has(comp.id)) continue;
    // Revive auto-ended timeslots whose scheduled end is still in the future
    const slots = getCompetitionTimeslots(comp.id);
    let anySlotRevived = false;
    for (const ts of slots) {
      if (ts.ended_at && !ts.ended_manually) {
        const tsEnd = scheduledEnd(ts);
        if (tsEnd > now()) {
          // runTxnWithMirrorBuffer (ext-audit F4): the recordTimeslotEvent
          // emit is NOT the last statement — _resyncStatusObservationAfterRevive
          // writes after it — so a rollback past the emit would strand a ghost
          // app.jsonl mirror line. Buffer the mirror until commit.
          runTxnWithMirrorBuffer(db.transaction(() => {
            const _rNow = now().toISOString();
            db.prepare("UPDATE competition_timeslots SET ended_at=NULL, ended_manually=0, updated_at=? WHERE id=?").run(_rNow, ts.id);
            db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(_rNow, comp.id);
            recordTimeslotEvent(ts.id, "revived", assignedBy, { via: "participant_assignment", ...reqContext(req) });
            _resyncStatusObservationAfterRevive("timeslot", ts.id);
          }));
          log.info({ ...reqContext(req), competition_id: comp.id, competition_name: sanitiseForLog(comp.name), timeslot_id: ts.id, timeslot_name: sanitiseForLog(ts.name), actor: sanitiseForLog(assignedBy), via: "participant_assignment" }, "Session revived");
          revivedNames.push(`${comp.name} → ${ts.name}`);
          revivedCompIds.add(comp.id);
          anySlotRevived = true;
        }
      }
    }
    // Revive the competition itself if it was auto-ended
    if (comp.ended_at && !comp.ended_manually) {
      if (slots.length === 0) {
        // Single-slot: check competition's own scheduled end
        // Shadowing the imported helper would be a trap, hence the local name.
        const compSchedEnd = scheduledEnd(comp);
        if (compSchedEnd > now()) {
          runTxnWithMirrorBuffer(db.transaction(() => {
            _invalidateCompetitionCache(comp.id);
            db.prepare("UPDATE competitions SET ended_at=NULL, ended_manually=0, updated_at=? WHERE id=?").run(now().toISOString(), comp.id);
            recordCompetitionEvent(comp.id, "revived", assignedBy, { via: "participant_assignment", ...reqContext(req) });
            _resyncStatusObservationAfterRevive("competition", comp.id);
          }));
          log.info({ ...reqContext(req), competition_id: comp.id, competition_name: sanitiseForLog(comp.name), actor: sanitiseForLog(assignedBy), via: "participant_assignment" }, "Competition revived");
          revivedNames.push(comp.name);
          revivedCompIds.add(comp.id);
        }
      } else if (anySlotRevived) {
        // Multi-slot: if any timeslot was revived, clear competition-level ended_at too
        runTxnWithMirrorBuffer(db.transaction(() => {
          _invalidateCompetitionCache(comp.id);
          db.prepare("UPDATE competitions SET ended_at=NULL, ended_manually=0, updated_at=? WHERE id=?").run(now().toISOString(), comp.id);
          recordCompetitionEvent(comp.id, "revived", assignedBy, { via: "timeslot_revival_cascade", ...reqContext(req) });
          _resyncStatusObservationAfterRevive("competition", comp.id);
        }));
        log.info({ ...reqContext(req), competition_id: comp.id, competition_name: sanitiseForLog(comp.name), actor: sanitiseForLog(assignedBy), via: "timeslot_revival_cascade" }, "Competition revived");
        revivedCompIds.add(comp.id);
      }
    }
  }
  // concurrency-cache audit (#1): every revive branch above bumps
  // competitions.updated_at, so the 1s _competitionCache MUST be busted for
  // each affected comp — otherwise a concurrent stale PUT /api/admin/
  // competitions/:id reads the pre-revive updated_at via getCompetition(),
  // its expectedUpdatedAt check compares old==old and the 409 is skipped
  // (last-writer-wins). The timeslot-only revive branch (multi-slot comp whose
  // own ended_at is NULL) bumped updated_at WITHOUT invalidating; this
  // catch-all covers it (the single-slot + cascade branches already did so).
  for (const compId of revivedCompIds) _invalidateCompetitionCache(compId);
  // Revival resurrects a board that was fully computed; bust the cache
  // so /api/leaderboard rebuilds from the un-ended state.
  for (const compId of revivedCompIds) invalidateLeaderboardCache(compId);
  // v7.15.2 (audit): the group board is FROZEN into group_leaderboard_snapshots
  // once a comp fully ends, and reviving it must drop that snapshot — exactly as
  // the competition-PUT and timeslot revive paths do. Missing it here meant a
  // comp revived by assigning new participants, then re-ended, served the
  // PRE-revive team averages forever: the new cohort never appeared.
  for (const compId of revivedCompIds) invalidateGroupLeaderboardSnapshot(compId);
  // v6.10.24: assignment writer-lock invariant. A bulk-assign that
  // re-adds a participant with historical submissions surfaces them
  // on the leaderboard immediately (see buildLeaderboardEntries'
  // history-fallback clause). Without cache invalidation the 5-s TTL
  // swallows the change, and admins staring at the participants tab
  // would see "User re-added" but the leaderboard stays stale until
  // the next writer (submit / hint / recalc) flushes. Union with
  // `revivedCompIds` covers both revival and plain re-add paths.
  for (const compId of affectedCompIds) {
    if (!revivedCompIds.has(compId)) invalidateLeaderboardCache(compId);
  }
  // v6.16.4 — per-user /api/me cache invalidation. The documented
  // writer-lock invariant ("any membership change calls
  // _invalidateMeCache(userId)") was followed by the per-user remove
  // route (server.js:8208+) but missed by bulk-assign. Up to 2 s
  // post-write the participant's /api/me kept returning the prior
  // comp list; the SPA's auto-resume / picker logic could read
  // stale data on the very next poll after a fresh enrolment. Walk
  // newCompsPerUser.keys() so we hit only users who actually got a
  // new row, not every uid in the request.
  for (const uid of newCompsPerUser.keys()) _invalidateMeCache(uid);

  // Send notification emails only to users who got new assignments
  const platformName = getPlatformName();
  const baseUrl = BASE_URL;
  let emailsSent = 0;
  // v7.2.x (audit, perf) — collect the notification sends and dispatch them
  // through a bounded pool AFTER the loop, instead of awaiting each SMTP
  // round-trip inline (up to BULK_ADMIN_MAX serial hops blocked the response).
  const _assignEmailTasks = [];
  // v8.12.6 (review) — the mail lists only what is TRUE of this recipient, for
  // which it needs to know whether they hold a row once the request is done.
  const _holdsRow = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?");

  for (const [uid, newComps] of newCompsPerUser) {
    // v8.12.6 — `id` is selected now: `sendEmailLogged(user.id, …)` below records
    // the send on the participant's History only when it is handed an id, and this
    // SELECT never carried one, so every assignment mail went unrecorded there.
    const user = db.prepare("SELECT id, email, secondary_email, first_name, nickname, timezone FROM users WHERE id=?").get(uid);
    if (!user) continue;

    const _named = []; // the events this mail lists: its History row names them (sendEmailLogged `about`)
    const compList = validComps.map(c => {
      const isNew = newComps.some(nc => nc.id === c.id);
      // v8.12.6 (review) — AN EVENT THIS REQUEST SKIPPED THEM FROM IS NOT LISTED.
      // The mail goes to everybody who got a new row ANYWHERE in the request, and
      // it used to list EVERY requested event, labelling each one they did not
      // newly get "(already enrolled)" — which for somebody skipped (took part
      // before the end, staff on a non-compete event, an author, a peer admin)
      // is false: they hold no row there at all.
      if (!isNew && !_holdsRow.get(c.id, uid)) return "";
      const label = isNew ? '' : ' <em style="color:#888">(already enrolled)</em>';
      const slots = getCompetitionTimeslots(c.id);
      // v8.12.6 — an event taking late entries names its late-entry DEADLINE, in
      // the recipient's zone, instead of a start and an end that are both past.
      // (review) — and only where THIS recipient can play there
      // (`lateEntryMailLineFor`): an ordinary member who was in it before it
      // ended cannot, and there is nothing in a finished event to invite them to,
      // so it is left out rather than promised or listed with past dates. Asked
      // only for an event admitted through its window here (`lateComps`): a
      // legacy booth the request REVIVED is live again, and its dates are real.
      let lateLine = null;
      if (lateComps.has(c.id)) {
        lateLine = lateEntryMailLineFor(c, uid, { slots, tz: user.timezone, nowMs });
        if (!lateLine) return "";
      }
      let compHtml;
      if (lateLine) {
        compHtml = `<li><strong>${escapeHtml(c.name)}</strong>${label}<br/>${lateLine}</li>`;
      } else if (slots.length > 0) {
        // Multi-session: show only session dates, not competition-level dates
        const slotList = slots.map(s => {
          const sStart = new Date(s.start_time);
          const sEnd = scheduledEnd(s);
          return `<li><strong>${escapeHtml(s.name)}</strong>: ${formatEmailDate(sStart, user.timezone)} — ${formatEmailDate(sEnd, user.timezone)}</li>`;
        }).join("");
        compHtml = `<li><strong>${escapeHtml(c.name)}</strong>${label}<br/><em>Choose one of the available sessions:</em><ul style="margin:4px 0">${slotList}</ul></li>`;
      } else {
        // Single-session: show competition dates. The end is "No fixed deadline"
        // for an open-ended Program (eventEndMailText), asked of the event as it
        // stands now: this request may have revived it since `validComps` was read.
        const start = new Date(c.start_time);
        compHtml = `<li><strong>${escapeHtml(c.name)}</strong>${label}<br/>Starts: ${formatEmailDate(start, user.timezone)}<br/>Ends: ${eventEndMailText(getCompetition(c.id) || c, { slots, tz: user.timezone })}</li>`;
      }
      return compHtml;
    }).map((h, i) => { if (h) _named.push(validComps[i].id); return h; }).join("");
    // Nothing true left to say (unreachable while a new row through the window is
    // a late entrant by construction) — no mail rather than an empty list.
    if (!compList) continue;

    const { html, text } = buildEmail(platformName, {
      greeting: user.first_name || user.nickname,
      body: `<p>You have been invited to participate in the following event(s):</p>`
        + `<ul style="margin:12px 0">${compList}</ul>`,
      linkUrl: baseUrl, linkText: "Go to " + platformName,
      fallbackNote: "If you believe this was sent in error, please contact your event organiser.",
    });
    _assignEmailTasks.push(() => sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — You have been invited to participate`, html, text }, "competition_assignment", { competitionIds: _named }).then(ok => { if (ok) emailsSent++; }));
  }
  // ext-audit v7.15.14 — the DB work is already committed; do not let SMTP push
  // the response past the client's 30 s abort, which would report a timeout for
  // an operation that succeeded and invite a re-send on retry.
  const _assignMail = await _runBoundedWithDeadline(_assignEmailTasks, 8, EMAIL_FANOUT_DEADLINE_MS);

  // v6.20.0: reconcile each bound competition (live sync) so current group
  // members are enrolled immediately. Reconciliation re-fetches the competition
  // so it sees any just-revived state. (The binds themselves were committed
  // synchronously right after the clash check — audit #11 — to keep check+bind
  // atomic; only the awaited membership sync remains here.)
  // v6.20.x — when a bind enrolls more than RECONCILE_MAX_PER_CALL members in
  // one pass the overflow drains via detached follow-up passes; surface
  // `membersDeferred:true` so the admin knows enrollment is still completing in
  // the background (the count itself finishes asynchronously).
  let membersDeferred = false;
  if (groupIds.length) {
    for (const comp of validComps) {
      const rc = await reconcileCompetitionMembership(getCompetition(comp.id), { actor: assignedBy, context: reqContext(req) });
      if (rc && rc.deferred) membersDeferred = true;
    }
  }

  // concurrency-cache audit (#8): reconcileCompetitionMembership early-returns
  // on ended comps, so any bound-group membership change made while a comp was
  // ended was a no-op for it. Now that a revived comp is live/upcoming again,
  // re-converge it to its bound groups' current desired membership. Comps in
  // the groupIds bind loop above were already reconciled — skip those.
  const _reconciledIds = new Set(groupIds.length ? validComps.map(c => c.id) : []);
  for (const compId of revivedCompIds) {
    if (_reconciledIds.has(compId)) continue;
    const rc = await reconcileCompetitionMembership(getCompetition(compId), { actor: assignedBy, context: reqContext(req) });
    if (rc && rc.deferred) membersDeferred = true;
  }

  invalidateAdminParticipantsCache();
  // `emailsDeferred` — the assignment is committed; some invitation emails were
  // still in flight when we replied, so `emailsSent` is a floor, not a total.
  res.json({ ok: true, assigned, emailsSent, revived: revivedNames, skippedStaff, skippedUnapproved, skippedBlocked, skippedPrivileged, skippedAuthors, skippedTookPart, groupsBound,
    // v8.12.6 — the events this request admitted people to THROUGH their late
    // window, so the dialog can say they joined as late entrants. Absent when none.
    ...(lateComps.size ? { lateEntryCompetitionIds: [...lateComps.keys()] } : {}),
    ...(membersDeferred ? { membersDeferred: true } : {}), ...(_assignMail.deferred ? { emailsDeferred: true } : {}) });
});

app.delete("/api/admin/competitions/:id/users/:uid", requireAdmin, csrfProtection, async (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — a NAMED event, so refuse rather than narrow. Before any write:
  // this handler opens an absence row and evicts the participant's session, and
  // a refused removal must leave every one of those untouched.
  //
  // v8.12.0 — THE ONE CARVE-OUT FROM THE COMPETITOR LOCK: a competitor may
  // remove THEMSELVES. It is their escape hatch — the lock refuses every other
  // change to the event on the strength of their row, so the row must be
  // theirs to drop, or a sole superadmin who joined their own event would be
  // locked out of it with no way back but hand-written SQL. Removing anybody
  // ELSE from the board they compete on is refused like every other door.
  //
  // The carve-out bypasses the event-admin SCOPE gate as well as the lock, and
  // for the carve-out's own reason: an event admin enrolled by a global admin
  // into a compete event they do NOT organise is bound by the lock on every
  // challenge it holds, and the refusal's remedy names self-removal — a door
  // this scope gate then shut on them, with the participant-side Leave scoped
  // to self-enrolment. A remedy that is not true is worse than none
  // (FROZEN_REMEDY). Their own row is the one thing on that event that is
  // theirs; anybody else's still takes both gates.
  const _selfRemoval = req.params.uid === actorId(req);
  if (!_selfRemoval) {
    const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
    if (_cmp) return _cmp;
    const _rmDenied = competitionDenied(req, comp.id);
    if (_rmDenied) return res.status(403).json({ error: _rmDenied.message, code: _rmDenied.code });
  }
  // v8.12.6 — AN ENDED EVENT REFUSES EVERY REMOVAL, EXCEPT A LATE ENTRANT'S WHILE
  // ITS LATE-ENTRY WINDOW IS OPEN (operator decision). Everybody who was in the
  // event before it ended stays, so its final results cannot change;
  // `lateWindowRemovalDenied` (lib/competitions.js) is the one predicate, and it is
  // the same one the participants list publishes as `late_entrant`, so the Remove
  // the pane offers cannot disagree with this refusal. The self carve-out above
  // still applies first — a competitor who is a late entrant may take themselves
  // out while the window is open, and nobody may once it has closed.
  //
  // Asked in this ORDER for the reason every gate here is: 404, then the
  // competitor lock and scope, then this — so an out-of-scope actor never learns
  // anything about another organiser's member.
  const _endedStatus = competitionStatus(comp) === "ended";
  let _lateRemoval = false;
  if (_endedStatus) {
    const _rm = lateWindowRemovalDenied(comp, req.params.uid);
    if (_rm) return res.status(_rm.status).json({ error: _rm.message, code: _rm.code });
    _lateRemoval = true;
  }
  const user = db.prepare("SELECT id, email, secondary_email, first_name, nickname FROM users WHERE id=?").get(req.params.uid);
  if (!user) return res.status(404).json({ error: "User not found" });
  // Get the participant's chosen session + login_time before deleting.
  // v6.12.0: login_time decides whether to open an absence row. A user
  // who was only pre-assigned (never called /api/select-competition, so
  // cu.login_time IS NULL) wasn't actively competing — removing them is
  // a no-op for time-to-solve accounting. Only open an absence when
  // they HAD started (login_time non-null), so the re-add path can close
  // it and buildLeaderboardEntries can subtract the gap from solveTimeMs.
  // v8.12.6 — `assigned_at` too: the absence row records it beside the anchor,
  // so a re-add restores the ORIGINAL join time and a remove-and-re-add cannot
  // change whether a member who had entered is a late entrant (one removed
  // before entering has no absence row, so a re-add through the late-entry
  // window makes them one).
  const cuRow = db.prepare("SELECT timeslot_id, login_time, last_login_time, assigned_at FROM competition_users WHERE competition_id=? AND user_id=?").get(req.params.id, req.params.uid);
  const chosenTs = cuRow?.timeslot_id ? getTimeslot(cuRow.timeslot_id) : null;
  const adminId = getAdminIdentity(req);
  // v6.20.0: if the participant is ALSO in a group bound to this competition,
  // record a per-competition exclusion tombstone so live-sync reconciliation
  // won't immediately re-add them. The manual removal wins; the tombstone is
  // cleared by an explicit direct re-assign.
  const inBoundGroup = db.prepare(
    "SELECT 1 FROM group_members gm JOIN competition_groups cg ON cg.group_id=gm.group_id WHERE cg.competition_id=? AND gm.user_id=? LIMIT 1"
  ).get(req.params.id, req.params.uid);
  let didRemove = false; // audit v7.7.37 (C6) — track whether the DELETE matched a real membership
  const removeUserTxn = db.transaction(() => {
    // v6.12.0: open an absence row BEFORE the DELETE so the row's
    // timeslot_id survives (DELETE wipes it). Scope absence to the
    // user's slot so per_slot leaderboards subtract correctly.
    // v8.1.0: the row also CARRIES the solve-clock anchor, because the DELETE
    // below is what destroys `competition_users.login_time` and this is the
    // only chance to record it. The re-add restores it
    // (closeAbsenceAndRestoreAnchor); without it the lazy stamp re-anchors the
    // clock to the re-add moment, which for a finisher clamps solveTimeMs to 0
    // — the best possible value on the sole score tie-break. Written for anybody
    // who ENTERED, on either clock (lib/competitions.js `recordRemovalAbsence`).
    recordRemovalAbsence(req.params.uid, comp.id, cuRow, now().toISOString());
    const r = db.prepare("DELETE FROM competition_users WHERE competition_id=? AND user_id=?").run(req.params.id, req.params.uid);
    didRemove = r.changes > 0;
    if (r.changes > 0) {
      // v8.12.6 — `late_entrant` marks a removal made through the late-entry
      // window: on an ended event only a late entrant can reach this line.
      recordUserEvent(req.params.uid, "removed_from_competition", adminId, { competition_id: comp.id, competition_name: comp.name, ...(_lateRemoval ? { late_entrant: true } : {}), ...reqContext(req) });
      recordCompetitionEvent(comp.id, "user_removed", adminId, { user_id: req.params.uid, nickname: user.nickname, ...(_lateRemoval ? { late_entrant: true } : {}), ...reqContext(req) });
      // v6.20.x — record the group-exclusion tombstone INSIDE the txn, gated on
      // an actual removal. If the user is in a group bound to this competition,
      // live-sync reconciliation would otherwise re-add them; the manual removal
      // wins (cleared only by an explicit direct re-assign). Pre-fix this ran
      // outside the txn AND fired even when the DELETE matched nothing — a
      // spurious tombstone could suppress a legitimate future group enrollment.
      if (inBoundGroup) {
        db.prepare("INSERT OR IGNORE INTO competition_group_exclusions (competition_id, user_id, excluded_at, excluded_by) VALUES (?,?,?,?)")
          .run(req.params.id, req.params.uid, now().toISOString(), adminId);
      }
    }
    // Clear the user-row navigation hint so a later auto-resume on login
    // doesn't silently drop them back into the competition they were just
    // removed from.
    db.prepare("UPDATE users SET active_competition_id=NULL WHERE id=? AND active_competition_id=?")
      .run(req.params.uid, comp.id);
    // v6.8.0: purge any pending email_reminders for this (user, comp) so
    // the background dispatcher doesn't later deliver a reminder for a
    // competition the user is no longer participating in.
    db.prepare("DELETE FROM email_reminders WHERE user_id=? AND competition_id=?")
      .run(req.params.uid, req.params.id);
  });
  // runTxnWithMirrorBuffer (ext-audit F4): the removed_from_competition /
  // user_removed emits are followed by the active_competition_id UPDATE +
  // email_reminders DELETE in the same txn, so a rollback past an emit would
  // strand ghost app.jsonl mirror lines.
  runTxnWithMirrorBuffer(() => removeUserTxn());
  invalidateAdminParticipantsCache();
  // v6.9.12: the removed user's submissions stay in the DB but they
  // disappear from the leaderboard (aggregation filters on current
  // competition_users membership). Bust the cache so that removal is
  // visible on the admin + participant board immediately instead of
  // lingering for the 5-s TTL.
  invalidateLeaderboardCache(comp.id);
  // Surgically clear competitionId/timeslotId from any live session the user
  // holds that points at this competition. Without this, /api/me and the
  // session probes would keep echoing the stale "still in this competition"
  // state to the client, leaving the UI in an impossible "you're in X" view
  // until a stricter endpoint (tasks, submit, leaderboard) 403'd via
  // requireParticipantInCompetition. The user stays logged in — their next
  // request just lands on the competition picker with clean state.
  let clearedSessions = 0;
  try {
    ({ clearedCount: clearedSessions } = clearCompetitionSessionForUser(req.params.uid, comp.id));
  } catch (e) { swallowed("participants:remove-clear-sessions", e); }
  if (clearedSessions > 0) {
    try { recordUserEvent(req.params.uid, "competition_session_cleared", adminId, { competition_id: comp.id, competition_name: comp.name, cleared: clearedSessions, ...reqContext(req) }); } catch (e) { swallowed("participants:session-cleared-audit", e); }
  }
  // v6.8.5: the participant's /api/me response may already be cached from a
  // poll that landed 1-2 s before the removal. Evict so the next /api/me
  // returns the self-healed state (competitionId cleared) instead of the
  // stale "still assigned" payload.
  _invalidateMeCache(req.params.uid);
  const platformName = getPlatformName();
  // Include session info in email
  const slots = getCompetitionTimeslots(comp.id);
  let sessionInfo = '';
  if (slots.length > 0) {
    if (chosenTs) {
      sessionInfo = `<p>You were enrolled in session: <strong>${escapeHtml(chosenTs.name)}</strong>.</p>`;
    }
    const slotList = slots.map(s => `<li>${escapeHtml(s.name)}</li>`).join('');
    sessionInfo += `<p style="margin-top:8px">Available sessions were:</p><ul style="margin:4px 0">${slotList}</ul>`;
  }
  // audit v7.7.37 (C6) — only email + report removed:true when the DELETE actually
  // removed a membership. Pre-fix a no-op DELETE (already removed / never a member,
  // e.g. a double-click by two admins) still sent a confusing "access removed"
  // email and reported success. The audit emits + tombstone are already gated the
  // same way inside the txn.
  if (!didRemove) return res.json({ ok: true, removed: false });
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Your access to <strong>${escapeHtml(comp.name)}</strong> has been removed by an organiser.</p>${sessionInfo}`,
    fallbackNote: "If you believe this was done in error, please contact your event organiser.",
  });
  // Bounded (awaitDeliveryWithDeadline): the committed removal must not wait on
  // the pooled relay's queue past the browser's abort.
  const emailDelivered = await awaitDeliveryWithDeadline(sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — Event Access Update`, html, text }, "removed_from_competition", { competitionId: comp.id }), EMAIL_FANOUT_DEADLINE_MS, "participants:removal-mail");
  res.json({ ok: true, removed: true, emailDelivered, ...(emailDelivered === null ? { emailDeferred: true } : {}) });
});

// v7.15.9 — THE single column list for every query that returns a participant row
// to an admin surface. There were four hand-maintained copies (the main list's
// two branches plus the picker's member / non-member-search / non-member-browse
// SELECTs), and they drifted: the picker copies omitted job_function, city,
// personal_title and phone, so the Edit-Profile dialog — which renders entirely
// from whichever payload loaded the list — showed those inputs EMPTY, and a
// superadmin save then submitted the blanks and wiped the data. v7.15.8 patched
// two of the four copies; the third (non-member browse, i.e. editing someone who
// is NOT in the focused competition) was still short, which is exactly the shape
// of bug a shared constant prevents. ADD A NEW USER COLUMN HERE ONCE and every
// admin surface gets it. The regression lock diffs the payloads against each
// other, so a fifth copy added later fails the moment it drifts.
const _PARTICIPANT_ROW_COLUMNS = `u.id, u.first_name, u.last_name, u.nickname, u.email, u.secondary_email, u.avatar,
            u.company, u.title, u.personal_title, u.phone, u.job_function, u.city,
            u.certificate_given_name, u.certificate_family_name,
            u.verified, u.blocked, u.approved, u.approved_at, u.approved_by,
            u.denied_at, u.denied_by, u.denied_reason,
            u.locked_until, u.login_time, u.last_login_time, u.created_at, u.country, u.timezone,
            u.linkedin_url, u.registered_via, u.invitation_id, u.invited_at, u.invited_by, u.role,
            u.pending_email, ${profileVersionSql("u")} AS updated_at`;
// `updated_at` is here because it is the optimistic-concurrency fingerprint the
// Edit-Profile dialog echoes back: the dialog renders entirely from whichever
// payload loaded the list, so a row that reaches it without the column can send
// no expectation and silently falls through to the unchecked path — the control
// present and inert, which is worse than absent. Not a secret; `GET /api/me`
// publishes the same value to the participant.
// v8.3.36 — `pending_email` is here because an admin primary-email change is now
// STAGED rather than applied. Without it the admin's own dialog re-opens showing
// the OLD address with nothing to say a correction is in flight — so the
// operator cannot tell a save that worked from one that did not, and would
// naturally re-type it. Gate the affordance and the EXPLANATION together
// (v7.14.2). The value is not a secret: `GET /api/me` already publishes it to
// the participant, and the pending CODE is never projected anywhere.
// The client is handed `can_use_code` and its reason, never the facts behind
// them: a client deriving the answer for itself would offer a code the server
// refuses, and the person handed it would be refused at every redemption.
// `_withCodeEligibility` below computes both from the lifecycle
// columns the row already has — through `_codeBlockedReason`, the
// one place this file spells the rule, which ends by consulting lib/login-code's
// `isCodeEligible` so a condition added there still refuses here. Second
// spellings are how the kebab came to offer a code the server refuses.
// (Written here rather than as a SQL comment: a backtick inside the template
// literal would terminate it, which is how this was found.)
// Same list without the `u.` alias, for the un-joined branch.
const _PARTICIPANT_ROW_COLUMNS_BARE = _PARTICIPANT_ROW_COLUMNS.replace(/u\./g, "");

/**
 * v8.1.3 — `can_use_code` (the affordance) and `code_blocked_reason` (the
 * explanation), computed together from one predicate so they can never disagree.
 *
 * Gate the affordance and the EXPLANATION together (v7.14.2): a row action that
 * silently is not there reads as a broken feature, and it was reported as one.
 * The client obeys `can_use_code` and renders the reason; it recombines nothing,
 * because it cannot see `password_set_at` and must not learn to guess at it.
 */
function _withCodeEligibility(row) {
  const reason = _codeBlockedReason(row);
  return { ...row, can_use_code: reason ? 0 : 1, code_blocked_reason: reason };
}

/**
 * Every People row, as the asking actor's menu needs it: the code-reveal facts
 * above, the role's class (`role_class`), and whether the row is a privileged
 * target FOR THIS ACTOR (`privileged_target`, lib/rbac.js privilegedTargetFor —
 * the predicate every account door enforces), so the client offers what the
 * routes accept and never re-derives the rule for a custom role it cannot see
 * into. `actor` is computed once per page.
 */
function _withAccountFacts(req, row, actor) {
  return {
    ..._withCodeEligibility(row),
    role_class: _roleClass(row.role || "participant"),
    privileged_target: _privilegedTarget(req, row.role, { live: false, actor }),
  };
}

// RBAC — A ROW HOLDING A CUSTOM ROLE says what that role is called
// (`role_label`), so the People row names it. Never what it may do: whether the
// row is out of this actor's reach is `privileged_target` (above), the
// server's own verdict. A built-in role carries no label: the SPA knows the four.
function _customRoleWire(role) {
  if (!role || _isBuiltinRole(role)) return {};
  const d = _roleDefinition(role);
  return { role_label: d ? d.label : null };
}

// May this session delete accounts? Exactly what DELETE /api/admin/participants/:id
// admits at its `requireSuperAdmin`: a superadmin (built-in or user-backed; the
// flag is re-read live by requireAdmin before any list is built), or a custom role
// holding `participants.delete`, read live (`customRoleAllows`). Never through an
// impersonation, whose seat is a participant or a built-in event admin: neither
// session carries `isSuperAdmin`, and the custom-role arm refuses it.
function _mayDeleteAccounts(req) {
  const s = req.session;
  if (s.isSuperAdmin) return true;
  if (!s.isAdmin || !s.userId || s.impersonator) return false;
  const u = db.prepare("SELECT role FROM users WHERE id=?").get(s.userId);
  return !!u && _customRoleAllows(req, u.role, "participants.delete");
}

// v8.12.7 — WHICH OF THIS PAGE'S PARTICIPANTS HOLD A CHECKMARX ONE ACCOUNT THE
// PLATFORM CREATED (cxone_realm_accounts, lib/cxone-ledger.js). The delete
// confirm names it, so whoever may delete learns before the click that deleting
// the person will also try to remove an account from the customer's tenant (operator
// ruling, 24 Nov 2026: anyone who can delete). One batched query per PAGE, never
// per row, and only for a session that may delete (`_mayDeleteAccounts`): anyone
// else has no way to act on the answer, and a realm binding is not theirs to learn.
// Returns a Set; an empty one for everyone else, so no row carries the key at
// all unless it is true (absent, never `false`, like `late_entrant`).
function _cxoneRealmAccountSet(req, ids, mayDelete) {
  if (!mayDelete || !ids.length) return new Set();
  // One bound JSON parameter (json_each): no SQLite variable limit to chunk
  // around, and a constant statement text.
  const rows = db.prepare("SELECT DISTINCT user_id FROM cxone_realm_accounts WHERE user_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids));
  return new Set(rows.map(r => r.user_id));
}


app.get("/api/admin/participants", requireAdmin, rateLimit(60_000, 120, "admin-participants"), (req, res) => {
  const competitionId = req.query.competitionId;
  // v8.7.0 — A NAMED EVENT IS REFUSED, NOT NARROWED. On an admin surface an
  // empty list for an out-of-scope competition is indistinguishable from an
  // event nobody has joined, so the actor reads it as a fact about the event
  // rather than about their own permissions.
  const _listDenied = competitionId ? competitionDenied(req, competitionId) : null;
  if (_listDenied) return res.status(403).json({ error: _listDenied.message, code: _listDenied.code });
  // v8.13.3 — and an event that does not EXIST is a 404, by the same reasoning one
  // step on: an unscoped admin used to get an empty 200 for any id at all, which
  // reads as "nobody has joined" (and was the body a crafted `?competitionId=_all`
  // cached over the pane's own unfiltered read). After the scope check, so an event
  // admin's answer for an id outside their events stays the 403 that discloses
  // nothing; /api/admin/leaderboard and analytics already 404 an unknown event.
  if (competitionId && !getCompetition(competitionId)) return res.status(404).json({ error: "Event not found" });
  // null = UNSCOPED (admin / superadmin). [] = an event admin with no grants,
  // who must see NOTHING. The two are different answers and every branch below
  // keeps them apart — collapsing them is the fail-open this feature guards.
  const _scopeIds = scopedCompetitionIds(req);
  // "Is this user in one of MY events", as a WHERE fragment. Written once
  // because TWO queries here need it — the row set and the pending-approval
  // count — and a second, subtly different copy is how the badge comes to
  // count work the list cannot show. The `1=0` branch is REQUIRED, not
  // defensive — the naive "only filter when there are ids" shape drops the
  // clause and yields an UNFILTERED query for exactly the actor who must see
  // nothing. (`IN ()` itself is accepted by SQLite and evaluates false; `1=0` is
  // the portable, explicit spelling — see lib/event-admin.js scopeFilterSql.)
  const _userInScopeSql = (col, connector) => {
    if (_scopeIds === null) return { clause: "", params: [] };
    if (!_scopeIds.length) return { clause: ` ${connector} 1=0`, params: [] };
    return {
      clause: ` ${connector} EXISTS (SELECT 1 FROM competition_users cu`
        + ` WHERE cu.user_id=${col} AND cu.competition_id IN (SELECT value FROM json_each(?)))`,
      params: [JSON.stringify(_scopeIds)],
    };
  };
  // v8.13.3 — clampPagingIndex (lib/util): still lenient below (0, -5, 'abc' read
  // as page 1), and now bounded ABOVE. The bind is the PRODUCT (page-1)*limit, so a
  // page of 2e15 with limit 5000 already overflowed int64 → SQLITE_MISMATCH → a
  // generic 500; at the 1e9 cap the product peaks at ~5e12, an exact integer.
  const page = clampPagingIndex(req.query.page, 1);
  // v6.10.54 — limit cap raised 200 → 5000 so the admin Participants
  // tab can fetch its full list in a single atomic DB read rather than
  // stitching multiple paged responses client-side. Auditor finding:
  // even with the v6.10.51 `, id` tiebreaker making each page's
  // ordering stable, the multi-page walk was not snapshot-consistent
  // — concurrent inserts / deletes between page fetches could drop or
  // duplicate rows. Single-fetch is the simplest correctness fix; it
  // trades response size for atomicity. At 5000 users × ~25 columns
  // the JSON is ~500 KB on the wire (admin dashboard, internal
  // network — fine). Deployments larger than 5000 still land in the
  // multi-page path — see the v6.10.64 note below on why that's OK.
  //
  // v6.10.64 — the multi-page walk above 5000 rows is structurally
  // INSERT-drift-free: ORDER BY created_at ASC means new registrations
  // always append at the END of the ordered set (biggest created_at),
  // so existing OFFSET positions don't shift under concurrent inserts.
  // The only remaining drift source is DELETE: if user N is deleted
  // between page 1 (OFFSET 0) and page 2 (OFFSET 5000), all rows
  // N+1..total shift up by one and the row that WAS at position 5000
  // is now at 4999 — appearing in page 1 AND skipped by page 2.
  //
  // v6.10.72 — auditor re-flagged this (Low). Accepted as a documented
  // release-readiness caveat rather than a fix target. To trigger it
  // the deployment needs BOTH (a) >5000 users (realistic tournament
  // scale is <500; the 5000 cap was already a comfort margin on that
  // scale) AND (b) a user deletion mid-tournament between two
  // successive admin page-fetches. Tournament operators don't purge
  // users during a live event — and if they must, the scoped view
  // (competitionId filter) isn't affected because its total is
  // recomputed per-page from the join. Cursor-based pagination
  // (WHERE (created_at, id) > (?, ?)) would close the edge too, but
  // would require a client-loop refactor + server cursor encoding
  // for a failure mode no real deployment is expected to hit. The
  // 5000 cap stays documented in the response-shape (limit is
  // clamped server-side) so operators above that scale know they're
  // in the multi-page path.
  //
  // v6.10.78 — auditor re-flagged AGAIN (Low). Position unchanged:
  // the condition needs both halves (>5000 users AND mid-tournament
  // deletion) and neither fits the Hack Arena product shape. The
  // engineering cost of cursor pagination (client loop refactor +
  // cursor encode/decode + server branching) is non-trivial; if a
  // >5000-user customer ever reports an actual consistency issue on
  // the unscoped admin Participants tab, revisit — but we're not
  // carrying that work ahead of signal.
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 200));

  // v6.10.89 — perf-span. v6.10.85 WAN run: admin_participants
  // p(90)=3.61s (threshold 3s). Handler does 4-5 queries: count +
  // list + user_tags (scoped) + competition_users (scoped) +
  // pending-approval count. Any one of them could be the slow step.
  // Timings captured at each boundary; logged only if total wall-
  // clock > 300 ms.
  const tHandler = process.hrtime.bigint();
  // v8.7.0 — the cache key carries the ACTOR (lib/participants-cache.js). An
  // event admin's body for the identical (competition, page, limit) tuple is a
  // NARROWED one, so without the actor a superadmin's platform-wide page would
  // be served to an event admin — or an event admin's narrowed page to a
  // superadmin, which reads as participants having vanished.
  // v8.12.7 — whether the session may delete accounts is part of the key too:
  // `has_cxone_realm_account` rides the page only for one that may
  // (`_mayDeleteAccounts`), so one user id must never share an entry across the two.
  // v8.13.3 — and every IDENTITY the body reads, not only the seat. `rival_in`
  // (rivalsOf) and the group chips' `competing` (_competingGroups) are computed from
  // competitorIds(req) = the seat AND, under impersonation, the HAND, while the seat
  // alone keyed the entry — so an organiser's own pane and an admin looking through
  // that organiser's seat shared one entry within the TTL: either the organiser was
  // served `rival_in` naming a compete event outside their scope, or the seat was
  // served a body offering doors the guard then refuses. A built-in hand yields
  // [seat], whose body really is the seat's own, so sharing that entry is right.
  // A future body field that reads anything else must be added here too.
  // RBAC — PEOPLE LEAVES OUT PLATFORM-WIDE STAFF. The platform's admin accounts
  // live on Users & roles; the cross-event list leaves out accounts whose role is
  // of class `all` (see the SQL below) unless the caller asks for `?kind=all` (an event workspace does, so an event's roster keeps
  // the staff who compete in it). An event's own roster (`competitionId`) is
  // never narrowed by role. The kind is part of the cache key.
  // `?kind=admins` — only the accounts holding a role other than Participant:
  // the rows Roles & permissions offers their account doors on (owner decision,
  // 27 Nov 2026), in the same shape and with the same per-row answers as People.
  const _kind = req.query.kind === "all" ? "all" : req.query.kind === "admins" ? "admins" : "participants";
  const _mayDelete = _mayDeleteAccounts(req);
  const _cacheActor = (competitorIds(req).join("+") || "builtin") + (_mayDelete ? ":del" : "") + `|k=${_kind === "all" ? "a" : _kind === "admins" ? "s" : "p"}`;
  const cachedBody = getCachedParticipantsPage(competitionId, page, limit, _cacheActor);
  if (cachedBody) return res.json(cachedBody);

  // When a competition is selected, return only its members; use the picker endpoint for mixed views
  let users, total;
  if (competitionId) {
    total = db.prepare(
      "SELECT COUNT(*) as c FROM users u JOIN competition_users cu ON cu.user_id=u.id WHERE cu.competition_id=?"
    ).get(competitionId).c;
    users = db.prepare(
      `SELECT ${_PARTICIPANT_ROW_COLUMNS}
       FROM users u
       JOIN competition_users cu ON cu.user_id=u.id
       WHERE cu.competition_id=?
       ORDER BY u.created_at, u.id
       LIMIT ? OFFSET ?`
    ).all(competitionId, limit, (page - 1) * limit);
  } else {
    // v8.7.0 — THE ALL-PARTICIPANTS BRANCH is where an event admin would
    // otherwise be handed the whole platform directory. Narrow it to people
    // enrolled in at least one of their events: the same rule
    // `participantDenied` enforces per row, expressed as a filter so the list
    // and the row actions can never disagree about who is visible. The
    // competition-scoped branch above needs no equivalent — its competition has
    // already been proved in scope.
    //
    // Sweep #501 (operator ruling, 23 Nov 2026): "the organisers should see who's
    // waiting FOR THEIR EVENTS ONLY". An account that signed up through an
    // invitation from a role that cannot approve waits for approval, in no event,
    // its invitation still live. It is listed to an organiser of an event that
    // invitation names (`waiting_for` says which, theirs only), so they can ask an
    // administrator to approve it; nobody else scoped sees it. They cannot act on
    // it themselves (the row actions ask `participantDenied`: not in their
    // events), which is why the pending badge below still counts members only.
    const _vis0 = (() => {
      const base = _userInScopeSql("users.id", "WHERE");
      if (!_scopeIds || !_scopeIds.length) return base;
      return {
        clause: `${base.clause.replace(/^ WHERE /, " WHERE (")} OR (users.approved=0 AND COALESCE(users.blocked,0)=0 AND users.denied_at IS NULL`
          + ` AND EXISTS (SELECT 1 FROM invitations wi, json_each(wi.competition_ids) wj`
          + ` WHERE wi.id=users.invitation_id AND wi.used_at IS NULL AND wj.value IN (SELECT value FROM json_each(?)))))`,
        params: [...base.params, JSON.stringify(_scopeIds)],
      };
    })();
    // Participants and the grant-scoped organisers (event admins, custom
    // `granted` roles) stay: an organiser's badge, profile and the "view their
    // panel" door start from their People row. The unscoped (class `all`) admin
    // accounts are Users & roles only.
    const _vis = _kind === "all" ? _vis0
      : _kind === "admins" ? { clause: (_vis0.clause ? `${_vis0.clause} AND` : " WHERE") + " COALESCE(users.role, 'participant') <> 'participant'", params: _vis0.params }
      : { clause: (_vis0.clause ? `${_vis0.clause} AND` : " WHERE") + " COALESCE(users.role, 'participant') NOT IN (SELECT value FROM json_each(?))",
          params: [..._vis0.params, JSON.stringify(_roleIdsOfClass("all"))] };
    total = db.prepare(`SELECT COUNT(*) as c FROM users${_vis.clause}`).get(..._vis.params).c;
    users = db.prepare(
      `SELECT ${_PARTICIPANT_ROW_COLUMNS_BARE}
       FROM users${_vis.clause} ORDER BY created_at, id
       LIMIT ? OFFSET ?`
    ).all(..._vis.params, limit, (page - 1) * limit);
  }
  const tListQuery = process.hrtime.bigint();
  // Sweep #501: the events a waiting account's live invitation names, for the
  // rows on this page (an organiser is named only their own events).
  const _waitingMap = new Map();
  {
    const _ids = users.filter(u => !u.approved).map(u => u.id);
    if (_ids.length) {
      const rows = db.prepare(
        `SELECT u.id AS user_id, c.id AS cid, c.name AS cname
           FROM users u JOIN invitations wi ON wi.id=u.invitation_id AND wi.used_at IS NULL, json_each(wi.competition_ids) wj
           JOIN competitions c ON c.id=wj.value
          WHERE u.id IN (SELECT value FROM json_each(?)) AND u.approved=0 AND COALESCE(u.blocked,0)=0 AND u.denied_at IS NULL
          ORDER BY c.name COLLATE NOCASE`
      ).all(JSON.stringify(_ids));
      const _inScope = _scopeIds === null ? null : new Set(_scopeIds);
      for (const r of rows) {
        if (_inScope && !_inScope.has(r.cid)) continue;
        if (!_waitingMap.has(r.user_id)) _waitingMap.set(r.user_id, []);
        _waitingMap.get(r.user_id).push({ id: r.cid, name: r.cname });
      }
    }
  }

  // v6.3.0: scope the tag fetch to the page's user IDs instead of loading
  // the global user_tags table. Pre-fix this endpoint hit every admin
  // dashboard poll for a full-table scan — at 5k users it's a few hundred
  // rows that were filtered to ~30 in JS. Now it's an indexed IN-list lookup
  // bounded by the current page.
  const userIds = users.map(u => u.id);
  const allTags = userIds.length
    ? db.prepare(
        "SELECT user_id, tag FROM user_tags WHERE user_id IN (SELECT value FROM json_each(?))"
      ).all(JSON.stringify(userIds))
    : [];
  const tagMap = {};
  for (const t of allTags) { (tagMap[t.user_id] = tagMap[t.user_id] || []).push(t.tag); }
  // v6.20.0: page-scoped group membership, same shape as tags.
  // v8.7.0 — narrowed on the SAME rule `GET /api/admin/groups` and
  // `groupViewDenied` use (created by me, OR bound to one of my events), because
  // these are the same groups. Left global this chip list is a directory of every
  // cohort any organiser has ever named, rendered one row at a time — the leak the
  // competitions column below was narrowed to close, arriving through the chip
  // beside it. It also keeps the chip's remove affordance honest: the client
  // renders a `.tag-x` per chip and `DELETE /api/admin/participants/:id/groups/:groupId`
  // refuses exactly the groups this predicate hides, so an unnarrowed column
  // offers a control the server is certain to refuse (v7.14.2).
  //
  // `_scopeIds === []` keeps ONLY the created-by arm, which is what
  // `groupViewDenied` answers for that actor — the list and the per-entity
  // predicate must never disagree about one group.
  const _grpVis = (() => {
    if (_scopeIds === null) return { clause: "", params: [] };
    const boundArm = _scopeIds.length
      ? ` OR EXISTS (SELECT 1 FROM competition_groups cgs
                      WHERE cgs.group_id=g.id AND cgs.competition_id IN (SELECT value FROM json_each(?)))`
      : "";
    return { clause: ` AND (g.created_by_id = ?${boundArm})`, params: _scopeIds.length ? [actorId(req), JSON.stringify(_scopeIds)] : [actorId(req)] };
  })();
  const allGroups = userIds.length
    ? db.prepare(
        `SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id
         WHERE gm.user_id IN (SELECT value FROM json_each(?))${_grpVis.clause} ORDER BY g.name COLLATE NOCASE`
      ).all(JSON.stringify(userIds), ..._grpVis.params)
    : [];
  // v8.12.0 — THE ANSWER ON THE CHIP: a group bound to an event the actor competes
  // in cannot have members added or removed by them (`competitorGroupDenied` on
  // every membership door), so the row's `×` and `+ group` need to know which
  // groups those are. ONE query for the page, not one per chip.
  const _actorGrp = competitorIds(req); // v8.12.1 — the seat AND the hand, like every competitor door
  const _competingGroups = new Set(_actorGrp.length
    ? db.prepare(`SELECT DISTINCT cg.group_id FROM competition_groups cg
                    JOIN competition_users cu ON cu.competition_id = cg.competition_id
                    JOIN competitions c ON c.id = cg.competition_id
                   WHERE cu.user_id IN (SELECT value FROM json_each(?)) AND c.staff_compete = 1`).all(JSON.stringify(_actorGrp)).map(r => r.group_id)
    : []);
  const groupMap = {};
  for (const g of allGroups) { (groupMap[g.user_id] = groupMap[g.user_id] || []).push({ id: g.id, name: g.name, ...(_competingGroups.has(g.id) ? { competing: true } : {}) }); }
  const tTagsQuery = process.hrtime.bigint();

  // Get competition assignments for these users (including chosen timeslot)
  // v8.7.0 — narrowed to the actor's OWN events ("the events column shows only
  // their events"). The row filter above does not close this: a participant the
  // actor may legitimately see is usually in other people's events too, so left
  // unfiltered this column is a directory of every event on the platform,
  // rendered one row at a time.
  const _compScope = scopeFilterSql(req, "c.id");
  const compAssignments = userIds.length
    ? db.prepare(
        `SELECT cu.user_id, c.id, c.name, c.start_time, c.duration_minutes, c.ended_at, c.ended_manually,
                c.event_kind, c.late_entry_enabled, c.late_entry_deadline_at,
                cu.timeslot_id, ct.name as timeslot_name, cu.assigned_at
         FROM competition_users cu JOIN competitions c ON c.id=cu.competition_id
         LEFT JOIN competition_timeslots ct ON ct.id=cu.timeslot_id
         WHERE cu.user_id IN (SELECT value FROM json_each(?))${_compScope.clause}
         ORDER BY c.start_time`
      ).all(JSON.stringify(userIds), ..._compScope.params)
    : [];
  // v6.20.x — batch-load timeslots for the distinct competitions in this page
  // ONCE, then pass `slots` to competitionStatus below. Pre-fix each assignment
  // row called competitionStatus(a) with no slots → a per-row
  // getCompetitionTimeslots query (N+1): a 200-user page where each is in 3
  // comps issued up to 600 individual timeslot SELECTs per response, and the
  // 5s response cache is cleared on every admin write so the N+1 recurs during
  // a live event. Mirrors the slots-batching in /api/me and /api/status.
  const _apCompIds = [...new Set(compAssignments.map(a => a.id))];
  const _apSlotsByComp = new Map();
  if (_apCompIds.length) {
    for (const s of db.prepare(
      `SELECT * FROM competition_timeslots WHERE competition_id IN (SELECT value FROM json_each(?)) ORDER BY start_time`
    ).all(JSON.stringify(_apCompIds))) {
      if (!_apSlotsByComp.has(s.competition_id)) _apSlotsByComp.set(s.competition_id, []);
      _apSlotsByComp.get(s.competition_id).push(s);
    }
  }
  const compMap = {};
  // v8.8.0 — ONE clock for the whole page (see the twin in routes/challenges.js).
  const _leNow = Date.now();
  for (const a of compAssignments) {
    const _slots = _apSlotsByComp.get(a.id) || [];
    const _effEnd = competitionEffectiveEnd(a, _slots);
    const _winOpen = lateEntryWindowOpen(a, _effEnd, _leNow);
    // v8.12.6 — `late_entrant: true` on an entry iff this member may be REMOVED
    // from this ended event through its late-entry window — the SAME predicate
    // the DELETE enforces (`lateWindowRemovalDenied`), so the Remove the pane
    // offers can never be one the server refuses for the reason it names. A
    // placing-certificate holder still counts: the server refuses that removal
    // WITH its own reason ("revoke the certificate first"), which is the
    // explanation an organiser needs, not a claim that they are not a late
    // entrant. Otherwise the key is ABSENT (never false), so a stale client fails
    // closed and offers no Remove.
    //
    // A cheap JS prefilter first — the window must be open and the row written
    // after the event's effective end, or `isLateEntry` cannot answer late —
    // so the per-row query runs only for genuine late-entrant candidates. The
    // predicate needs the full competition row (`eventPolicy` throws on a partial
    // one), which `getCompetition` supplies from its 1 s cache. The picker below
    // deliberately does not carry the flag: nothing removes from it.
    //
    // v8.12.6 (review) — AND `late_entry_playing: true` iff this member is a late
    // entrant PLAYING through the open window (`lateEntryStateFor(...).canPlay`,
    // the play gate's own answer). The two differ, and conflating them was a
    // defect: removable is narrower than late, because a member who classifies
    // late but has a footprint at or before the end (an imported membership can)
    // is a late entrant (ranked in the Late entrants section, playing on) whom the
    // removal refuses. So the pane badges and warns on `late_entry_playing` — the
    // account-delete speed bump fires on exactly that — and offers Remove on
    // `late_entrant` alone. Same cheap prefilter (canPlay needs the same join-time
    // test), and ONE classification per candidate row, handed to the removal
    // predicate rather than recomputed. ABSENT, never false.
    let _lateEntrant = false, _latePlaying = false;
    if (_winOpen && a.assigned_at) {
      const _cut = lateEntryJoinCutoff(a, _effEnd);
      if (_cut && new Date(a.assigned_at).getTime() > _cut.getTime()) {
        const _full = getCompetition(a.id);
        const _le = _full ? lateEntryStateFor(_full, a.user_id, _slots) : null;
        _latePlaying = !!(_le && _le.canPlay);
        const _rm = _full ? lateWindowRemovalDenied(_full, a.user_id, _slots, { codeOnly: true, state: _le }) : { code: "gone" };
        _lateEntrant = !_rm || _rm.code === "late_entrant_has_certificate";
      }
    }
    (compMap[a.user_id] = compMap[a.user_id] || []).push({
      id: a.id, name: a.name, status: competitionStatus(a, _slots),
      timeslot_id: a.timeslot_id || null, timeslot_name: a.timeslot_name || null,
      late_entry_window_open: _winOpen,
      // What a certificate here attests (`attempt` | `completion`): a completion
      // certificate is issued while the event is still live, so the profile card
      // asks about those events too, not only the ended ones.
      certificate: eventPolicy(a).certificate,
      ...(_lateEntrant ? { late_entrant: true } : {}),
      ...(_latePlaying ? { late_entry_playing: true } : {}),
    });
  }
  const tCompsQuery = process.hrtime.bigint();

  // v8.7.0 — WHICH EVENTS DOES THIS PERSON ORGANISE. `role` already rides the
  // row, but the role alone cannot answer "which of my events is she running?",
  // and the scope is the half an admin actually acts on — the role is granted
  // once, the events change constantly.
  //
  // ONE query for the whole page, like the tags and groups above: a per-row
  // lookup would be an N+1 on a list the admin panel polls every 15 s.
  //
  // Narrowed by the VIEWER's own scope when the viewer is an event admin, so a
  // colleague's co-organised event shows only where the two overlap. Without
  // that this field would re-open, on the participant row, exactly the leak the
  // competitions column above was just narrowed to close.
  // v8.8.7 — through the shared builder, which also carries each event's status
  // and late-entry window so the role cell can render badges rather than a name.
  const eventAdminMap = _eventAdminForMap(req, userIds);

  // v8.12.0 — THE ANSWER ON THE ROW: which rows are RIVALS of the actor (share a
  // compete event with them), so the pane withholds the account doors — block,
  // deny, approve, verify, impersonate, reset, role, delete, the benchmark tag —
  // WITH the reason rather than offering what the server refuses (v7.14.2). One
  // query for the page; `null` for the built-in superadmin and for a row that
  // shares no compete event with the actor.
  const _rivalMap = rivalsOf(db, competitorIds(req), users.map(u => u.id));
  const _cxoneHeld = _cxoneRealmAccountSet(req, users.map(u => u.id), _mayDelete); // v8.12.7
  const _actorFacts = _actorPermissions(req);
  const participants = users.map(u => ({ ..._withAccountFacts(req, u, _actorFacts), tags: tagMap[u.id] || [], groups: groupMap[u.id] || [], competitions: compMap[u.id] || [], event_admin_for: eventAdminMap[u.id] || [], rival_in: _rivalMap.get(u.id) || null, ...(_waitingMap.has(u.id) ? { waiting_for: _waitingMap.get(u.id) } : {}), ...(_cxoneHeld.has(u.id) ? { has_cxone_realm_account: true } : {}), ..._customRoleWire(u.role) }));
  // Exclude currently-locked users from the pending-approval count —
  // they show as "Locked" under `pStatus()` and need Unlock, not
  // Approve, to become usable. Keeping them in the badge was misleading
  // (the admin's "approve these 3 pending users" action couldn't
  // actually complete for the locked rows post-v6.10.19's approval
  // lockout gate). The Locked filter still lists them.
  // v6.14.0 — denied users are blocked by construction so the
  // existing blocked=0 filter already excludes them, but pin the
  // intent down with an explicit denied_at IS NULL clause so the
  // count is robust against any future out-of-band write that
  // decouples blocked from denied_at.
  // v8.7.0 — SCOPED, because this number drives the sidebar badge. A global
  // count tells an event admin that twelve people are waiting while the list
  // they can act on shows none: a badge that cannot be cleared, counting work
  // that is not theirs, on the one control that exists to say "act now".
  const _pendScope = _userInScopeSql("users.id", "AND");
  const pendingApproval = db.prepare(
    `SELECT COUNT(*) as c FROM users WHERE verified=1 AND approved=0 AND blocked=0 AND denied_at IS NULL AND (locked_until IS NULL OR locked_until <= ?)${_pendScope.clause}`
  ).get(now().toISOString(), ..._pendScope.params).c;
  const tPendingQuery = process.hrtime.bigint();
  const body = { participants, total, page, limit, pendingApproval };
  setCachedParticipantsPage(competitionId, page, limit, body, _cacheActor);
  res.json(body);
  // v6.10.89 — perf-span. Measures each major query boundary so the
  // next run pins which stage dominates the 3.61 s p(90): list (incl.
  // count), user_tags page scope, competition_users page scope, or
  // pending-approval count. Assembly is sandwiched between queries
  // so its cost shows up as the gap between tListQuery and
  // tTagsQuery only if it's significant; in practice those lines
  // are tight loops.
  const tRespond = process.hrtime.bigint();
  const preludeMs  = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
  const listMs     = Number(tListQuery    - tHandler)     / 1e6;
  const tagsMs     = Number(tTagsQuery    - tListQuery)   / 1e6;
  const compsMs    = Number(tCompsQuery   - tTagsQuery)   / 1e6;
  const pendingMs  = Number(tPendingQuery - tCompsQuery)  / 1e6;
  const respMs     = Number(tRespond      - tPendingQuery)/ 1e6;
  const totalMs    = preludeMs + listMs + tagsMs + compsMs + pendingMs + respMs;
  // v6.10.91 — revert v6.10.90's every-call logging to threshold-gated.
  // Diagnostic established the server-side split: list ~2 ms, tags ~0.3 ms,
  // comps ~6 ms, pending ~1.5 ms, total ~12 ms median — far below the
  // 3.6 s k6 observes. Logger stays on as the tripwire for real
  // server-side regression (e.g. if `comps_ms` ever grew 60× on a
  // missing-index change).
  if (totalMs > PERF_SPAN_SLOW_MS) {
    log.warn({
      req_id: req.id,
      endpoint: "/api/admin/participants",
      scope: competitionId ? "competition" : "global",
      page, limit,
      row_count: users.length,
      total_ms: totalMs.toFixed(1),
      prelude_ms: preludeMs.toFixed(1),
      list_ms: listMs.toFixed(2),
      tags_ms: tagsMs.toFixed(2),
      comps_ms: compsMs.toFixed(2),
      pending_ms: pendingMs.toFixed(2),
      respond_ms: respMs.toFixed(2),
    }, "[perf-span] slow /api/admin/participants");
  }
});

// v6.8.6: the picker endpoint previously dumped the full users table on
// every admin-tab load. At 5 k users that's ~5 000 rows (~500 KB) on each
// participant-tab navigation — fine for typical tournaments (~100 users)
// but a real tail cost as deployments grow. The fix: server-side filtering
// + a hard row cap. Members of the selected competition are always
// included regardless of limit (the picker's invariant is "show who's in
// already"); non-members are LIKE-filtered by `search` if provided, then
// sliced to fit `limit`.
//
// Response shape changed from `[user...]` to `{users, total, members,
// truncated, searchApplied}` so the client can surface a banner when the
// non-member half was truncated. The only caller is public/app.js —
// updated in lockstep.
const _PICKER_LIMIT_DEFAULT = 500;
const _PICKER_LIMIT_MAX     = 5000;
app.get("/api/admin/participants/picker", requireAdmin, rateLimit(60_000, 120, "admin-picker"), (req, res) => {
  const competitionId = req.query.competitionId;
  const timeslotId = req.query.timeslotId;
  if (!competitionId) return res.status(400).json({ error: "competitionId required" });
  // v8.7.0 — a NAMED event, so refuse rather than narrow (an empty picker for
  // an out-of-scope event reads as an event nobody has joined).
  //
  // v8.8.11 — THE PARAGRAPH THAT WAS HERE WAS FLATLY FALSE, AND DANGEROUSLY SO.
  // It said "the NON-MEMBER pool below is deliberately left platform-wide… an
  // event admin may add any participant… narrowing it would leave an organiser
  // unable to enrol the walk-up standing in front of them". `_nmVis` sixty lines
  // below narrows exactly that pool, and has since v8.7.0. The comment was the
  // retired first pass, and it argued for the one change that would turn this
  // endpoint into a participant-directory leak for the event-admin tier.
  //
  // The use case it named is real and is served elsewhere: an organiser enrols
  // somebody new through the desk invite or their event's own join link, not by
  // finding a stranger in this list.
  const _pickDenied = competitionDenied(req, competitionId);
  if (_pickDenied) return res.status(403).json({ error: _pickDenied.message, code: _pickDenied.code });
  // v8.13.3 — an event that does not exist is a 404 rather than every user on the
  // platform listed as a non-member of it (the list route's rule; see there).
  if (!getCompetition(competitionId)) return res.status(404).json({ error: "Event not found" });
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = _PICKER_LIMIT_DEFAULT;
  limit = Math.min(limit, _PICKER_LIMIT_MAX);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  // Members of this competition ALWAYS come back in full — they're the
  // invariant the picker UI relies on (cannot render "who's in" if we
  // truncate them away). Non-members are the expensive bucket.
  // v7.15.8 — the picker SELECTs MUST carry the full profile column set, not just
  // the identity fields the picker UI itself renders. When a competition is
  // FOCUSED, loadAdminParticipants() populates S.adminParticipantsData from THIS
  // endpoint, and the admin Edit-Profile dialog renders entirely from that array.
  // Omitting job_function / city / personal_title / phone made those inputs render
  // EMPTY for every admin working inside a focused competition — and because a
  // superadmin's save submits what the form shows, saving after changing one field
  // wiped the others. (fillRequired now blocks the wipe, but the blank display was
  // the actual defect and would still mislead.) Keep this list in step with the
  // main /api/admin/participants SELECT.
  //
  // v8.8.11 — THAT REASON HAS EXPIRED AND THE COLUMNS STAY. The focused
  // Participants tab no longer reads this endpoint at all (it was the source of
  // the oldest-500 truncation); its live consumer is now the Grant Attempts
  // roster, which renders from this payload and is driven end to end by
  // `attempt-caps-reach.spec.js` / `attempt-caps-ui.spec.js`. The parity lock
  // against the main list's column set is what keeps the two in step, not this
  // sentence.
  const memberRows = db.prepare(
    `SELECT ${_PARTICIPANT_ROW_COLUMNS},
            1 as in_competition,
            cu.timeslot_id as chosen_timeslot_id,
            ct.name as chosen_timeslot_name
     FROM competition_users cu JOIN users u ON u.id=cu.user_id
     LEFT JOIN competition_timeslots ct ON ct.id=cu.timeslot_id
     WHERE cu.competition_id=?
     ORDER BY u.created_at, u.id`
  ).all(competitionId);
  // Non-member pool: total size (for the truncated flag) and then the
  // search-filtered slice. The LIKE pattern escapes %/_ so a literal
  // "john_doe" search doesn't get wildcard-promoted.
  const _searchEsc = search ? `%${search.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` : null;
  // v8.7.0 — THE NON-MEMBER POOL IS NARROWED FOR AN EVENT ADMIN, and this is a
  // correction to the first pass, which left it platform-wide on the grounds
  // that the ASSIGN route lets an organiser enrol anybody.
  //
  // Those are different questions. Adding is an action; this pool is a READ, and
  // it returns `_PARTICIPANT_ROW_COLUMNS` — email, secondary email, phone,
  // company, city, LinkedIn URL — searchable across the whole platform. The
  // operator's rule is explicit and is about seeing: "see only participants who
  // have been assigned to their events". Left open, an event admin could type
  // three letters here and read the contact details of every account on the
  // platform, which is a directory, not an enrolment control.
  //
  // What it costs, stated: an organiser can no longer pick a stranger out of a
  // list. The remedy is real and is the one the brief names — INVITE them by
  // email, which works for an existing account too and attaches them to the
  // event. The people who remain pickable are those already in one of their
  // OTHER events, which is the case this dialog is actually for.
  const _pickScope = scopedCompetitionIds(req);
  const _nmVis = _pickScope === null
    ? { clause: "", params: [] }
    : (!_pickScope.length
        ? { clause: " AND 1=0", params: [] }
        : { clause: ` AND EXISTS (SELECT 1 FROM competition_users _pv WHERE _pv.user_id=u.id`
                  + ` AND _pv.competition_id IN (SELECT value FROM json_each(?)))`,
            params: [JSON.stringify(_pickScope)] });
  const nonMemberTotal = db.prepare(
    `SELECT COUNT(*) AS c FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM competition_users cu WHERE cu.user_id=u.id AND cu.competition_id=?)${_nmVis.clause}`
  ).get(competitionId, ..._nmVis.params).c;
  // audit v7.7.31 (M27) — non-members are capped by `limit` INDEPENDENTLY of
  // the member count (the documented contract: "members always in full;
  // non-members capped by ?limit="). Pre-fix this was `limit - memberRows.length`,
  // so a competition with ≥limit members returned ZERO candidates — and the
  // client's truncated-refetch then still got zero, breaking candidate search
  // entirely on any well-populated competition.
  const nonMemberSlots = limit;
  let nonMemberRows = [];
  let nonMemberMatching = nonMemberTotal;
  if (nonMemberSlots > 0) {
    if (_searchEsc) {
      nonMemberMatching = db.prepare(
        `SELECT COUNT(*) AS c FROM users u
         WHERE NOT EXISTS (SELECT 1 FROM competition_users cu WHERE cu.user_id=u.id AND cu.competition_id=?)
           AND (LOWER(u.first_name) LIKE ? ESCAPE '\\' OR LOWER(u.last_name) LIKE ? ESCAPE '\\'
                OR LOWER(u.nickname) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(u.secondary_email,'')) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(u.company,'')) LIKE ? ESCAPE '\\')${_nmVis.clause}`
      ).get(competitionId, _searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc, ..._nmVis.params).c;
      nonMemberRows = db.prepare(
        `SELECT ${_PARTICIPANT_ROW_COLUMNS},
                0 as in_competition, NULL as chosen_timeslot_id, NULL as chosen_timeslot_name
         FROM users u
         WHERE NOT EXISTS (SELECT 1 FROM competition_users cu WHERE cu.user_id=u.id AND cu.competition_id=?)
           AND (LOWER(u.first_name) LIKE ? ESCAPE '\\' OR LOWER(u.last_name) LIKE ? ESCAPE '\\'
                OR LOWER(u.nickname) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(u.secondary_email,'')) LIKE ? ESCAPE '\\'
                OR LOWER(COALESCE(u.company,'')) LIKE ? ESCAPE '\\')${_nmVis.clause}
         ORDER BY u.created_at, u.id
         LIMIT ?`
      ).all(competitionId, _searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc, ..._nmVis.params, nonMemberSlots);
    } else {
      nonMemberRows = db.prepare(
        `SELECT ${_PARTICIPANT_ROW_COLUMNS},
                0 as in_competition, NULL as chosen_timeslot_id, NULL as chosen_timeslot_name
         FROM users u
         WHERE NOT EXISTS (SELECT 1 FROM competition_users cu WHERE cu.user_id=u.id AND cu.competition_id=?)${_nmVis.clause}
         ORDER BY u.created_at, u.id
         LIMIT ?`
      ).all(competitionId, ..._nmVis.params, nonMemberSlots);
    }
  }
  const users = [...memberRows, ...nonMemberRows];
  // If timeslotId filter: sort participants in that timeslot (or no choice yet) to top
  if (timeslotId) {
    users.sort((a, b) => {
      const aMatch = a.in_competition && (a.chosen_timeslot_id === timeslotId || !a.chosen_timeslot_id) ? 0 : 1;
      const bMatch = b.in_competition && (b.chosen_timeslot_id === timeslotId || !b.chosen_timeslot_id) ? 0 : 1;
      return aMatch - bMatch;
    });
  }
  // Attach competition assignments for badge rendering (including chosen timeslot)
  // v8.7.0 — narrowed exactly as the main list is, and NOT optional. When a
  // competition is focused the client populates S.adminParticipantsData from
  // THIS endpoint (see the v7.15.8 note above), so an unfiltered column here
  // would re-open the leak the main list just closed, through the door an
  // organiser actually uses.
  const userIds = users.map(u => u.id);
  const _compScope = scopeFilterSql(req, "c.id");
  const compAssignments = userIds.length
    ? db.prepare(
        `SELECT cu.user_id, c.id, c.name, c.start_time, c.duration_minutes, c.ended_at, c.ended_manually,
                c.event_kind, c.late_entry_enabled, c.late_entry_deadline_at,
                cu.timeslot_id, ct.name as timeslot_name
         FROM competition_users cu JOIN competitions c ON c.id=cu.competition_id
         LEFT JOIN competition_timeslots ct ON ct.id=cu.timeslot_id
         WHERE cu.user_id IN (SELECT value FROM json_each(?))${_compScope.clause}
         ORDER BY c.start_time`
      ).all(JSON.stringify(userIds), ..._compScope.params)
    : [];
  // v6.20.x — batch-load timeslots for the distinct competitions in this page
  // ONCE, then pass `slots` to competitionStatus below. Pre-fix each assignment
  // row called competitionStatus(a) with no slots → a per-row
  // getCompetitionTimeslots query (N+1): a 200-user page where each is in 3
  // comps issued up to 600 individual timeslot SELECTs per response, and the
  // 5s response cache is cleared on every admin write so the N+1 recurs during
  // a live event. Mirrors the slots-batching in /api/me and /api/status.
  const _apCompIds = [...new Set(compAssignments.map(a => a.id))];
  const _apSlotsByComp = new Map();
  if (_apCompIds.length) {
    for (const s of db.prepare(
      `SELECT * FROM competition_timeslots WHERE competition_id IN (SELECT value FROM json_each(?)) ORDER BY start_time`
    ).all(JSON.stringify(_apCompIds))) {
      if (!_apSlotsByComp.has(s.competition_id)) _apSlotsByComp.set(s.competition_id, []);
      _apSlotsByComp.get(s.competition_id).push(s);
    }
  }
  const compMap = {};
  // v8.8.0 — ONE clock for the whole page (see the twin in routes/challenges.js).
  const _leNow = Date.now();
  for (const a of compAssignments) {
    const _slots = _apSlotsByComp.get(a.id) || [];
    (compMap[a.user_id] = compMap[a.user_id] || []).push({
      id: a.id, name: a.name, status: competitionStatus(a, _slots),
      timeslot_id: a.timeslot_id || null, timeslot_name: a.timeslot_name || null,
      late_entry_window_open: lateEntryWindowOpen(a, competitionEffectiveEnd(a, _slots), _leNow),
      certificate: eventPolicy(a).certificate,
    });
  }
  // Tag fetch scoped to the users we're actually returning (pre-v6.8.6 this
  // was an unconditional full-table scan of user_tags — cheap at typical
  // scale but 5 k-user deployments were doing it on every picker load).
  const tagMap = {};
  const groupMap = {};
  if (userIds.length) {
    const rows = db.prepare(
      `SELECT user_id, tag FROM user_tags WHERE user_id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(userIds));
    for (const t of rows) { (tagMap[t.user_id] = tagMap[t.user_id] || []).push(t.tag); }
    // v8.7.0 — the same narrowing the main list applies, for the reason recorded
    // there. Both payloads feed ONE client model (the v7.15.8 note above), so a
    // column narrowed on one endpoint and global on the other is decided by
    // whichever happened to load last.
    const _grpVis = (() => {
      const ids = scopedCompetitionIds(req);
      if (ids === null) return { clause: "", params: [] };
      const boundArm = ids.length
        ? ` OR EXISTS (SELECT 1 FROM competition_groups cgs
                        WHERE cgs.group_id=g.id AND cgs.competition_id IN (SELECT value FROM json_each(?)))`
        : "";
      return { clause: ` AND (g.created_by_id = ?${boundArm})`, params: ids.length ? [actorId(req), JSON.stringify(ids)] : [actorId(req)] };
    })();
    const grows = db.prepare(
      `SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id
       WHERE gm.user_id IN (SELECT value FROM json_each(?))${_grpVis.clause} ORDER BY g.name COLLATE NOCASE`
    ).all(JSON.stringify(userIds), ..._grpVis.params);
    for (const g of grows) { (groupMap[g.user_id] = groupMap[g.user_id] || []).push({ id: g.id, name: g.name }); }
  }
  // v8.7.0 — the same `event_admin_for` the main list carries. Both payloads
  // feed ONE client model, and v7.15.9 records what happens when the two drift:
  // whichever endpoint loaded last decides what the dialog renders, so a field
  // present on one and absent on the other is a column that empties itself
  // depending on whether a competition happens to be focused.
  // v8.8.7 — the same builder as the main list, for the reason the comment above
  // gives: two copies of this query are how the two payloads drift.
  const eventAdminMap = _eventAdminForMap(req, userIds);
  // v8.12.0 — THE ANSWER ON THE ROW: which rows are RIVALS of the actor (share a
  // compete event with them), so the pane withholds the account doors — block,
  // deny, approve, verify, impersonate, reset, role, delete, the benchmark tag —
  // WITH the reason rather than offering what the server refuses (v7.14.2). One
  // query for the page; `null` for the built-in superadmin and for a row that
  // shares no compete event with the actor.
  const _rivalMap = rivalsOf(db, competitorIds(req), users.map(u => u.id));
  const _cxoneHeld = _cxoneRealmAccountSet(req, users.map(u => u.id), _mayDeleteAccounts(req)); // v8.12.7
  const _actorFacts = _actorPermissions(req);
  const enriched = users.map(u => ({ ..._withAccountFacts(req, u, _actorFacts), competitions: compMap[u.id] || [], tags: tagMap[u.id] || [], groups: groupMap[u.id] || [], event_admin_for: eventAdminMap[u.id] || [], rival_in: _rivalMap.get(u.id) || null, ...(_cxoneHeld.has(u.id) ? { has_cxone_realm_account: true } : {}) }));
  res.json({
    users: enriched,
    // v8.8.11 — NOT global for an event admin: `nonMemberTotal` carries the
    // `_nmVis` scope clause, so this is "everyone in MY events" for that tier and
    // the whole platform for a global admin. Unfiltered by SEARCH, which is what
    // the retired "regardless of filter" half meant.
    total: memberRows.length + nonMemberTotal,
    members: memberRows.length,
    matchingNonMembers: nonMemberMatching,       // useful when search is set
    truncated: nonMemberMatching > nonMemberRows.length,
    searchApplied: !!search,
  });
});

app.post("/api/admin/participants/:id/tags", requireAdmin, csrfProtection, (req, res) => {
  // batch 7 — boundary validation (see lib/validate.js); `tag` is a validated,
  // trimmed, ≤50-char string from here on.
  const _v = validateBody(req.body, { tag: { type: "string", required: true, max: 50, label: "Tag" } });
  if (_v.error) return res.status(400).json({ error: _v.error });
  const tag = _v.values.tag;
  const user = db.prepare("SELECT id, role FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.7.0 — tags drive leaderboard exclusion (`staff`) and benchmark grouping,
  // so tagging somebody reaches every event they are in. Restrict to
  // participants the actor can already see, before the INSERT.
  // v8.12.0 — the BENCHMARK tag takes a rival off the ranked board on a compete
  // event, so it is a rival door (competitorRivalDenied); any other tag is not a
  // board input where staff compete (the staff tag is inert there).
  if (tag === "benchmark") { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  const _tagDenied = participantDenied(req, req.params.id);
  if (_tagDenied) return res.status(403).json({ error: _tagDenied.message, code: _tagDenied.code });
  // v6.20.x — a regular admin may not tag a privileged colleague (parity with
  // block/approve/role/edit-profile guards). Tags drive leaderboard exclusion
  // (staff) + benchmark grouping, so peer tampering shouldn't be possible.
  if (_privilegedTarget(req, user.role)) {
    return res.status(403).json({ error: "Only a superadmin can modify tags on an admin or superadmin account." });
  }
  const trimmed = tag;
  let inserted = false;
  try { inserted = db.prepare("INSERT INTO user_tags (user_id, tag) VALUES (?,?)").run(req.params.id, trimmed).changes > 0; }
  catch (e) {
    // duplicate tag
    swallowed("participants:tag-insert", e);
  }
  if (inserted) {
    recordUserEvent(req.params.id, "tag_added", getAdminIdentity(req), { tag: trimmed, ...reqContext(req) });
    _invalidateUserTagsCache(req.params.id);
    db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(req.params.id).forEach(r => invalidateLeaderboardCache(r.competition_id));
    _invalidateMeCache(req.params.id); // staff tag flips /api/me's `isStaff` field
    invalidateAdminParticipantsCache();
  }
  const tags = db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, tags });
});

app.delete("/api/admin/participants/:id/tags/:tag", requireAdmin, csrfProtection, (req, res) => {
  // v8.3.17 — `req.params` IS ALREADY DECODED. Decoding again is not belt-and-braces,
  // it is a second, wrong transformation. See the note at the competition twin
  // (routes/competitions.js) for the two measured consequences; all three tag
  // DELETEs carried it.
  const tag = req.params.tag;
  const _tgtUser = db.prepare("SELECT role FROM users WHERE id=?").get(req.params.id);
  // v8.7.0 — the POST twin's reasoning, and this route has no 404 of its own, so
  // the scope check is also what stops an event admin probing for ids: an
  // unknown user is in none of their events and refuses identically.
  if (req.params.tag === "benchmark") { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; } // v8.12.0 — see the add door
  const _untagDenied = participantDenied(req, req.params.id);
  if (_untagDenied) return res.status(403).json({ error: _untagDenied.message, code: _untagDenied.code });
  // v6.20.x — a regular admin may not modify tags on a privileged colleague
  // (parity with the POST-tags guard + block/approve/role).
  if (_tgtUser && _privilegedTarget(req, _tgtUser.role)) {
    return res.status(403).json({ error: "Only a superadmin can modify tags on an admin or superadmin account." });
  }
  // Block removing staff tag from admin/superadmin users
  if (tag === "staff") {
    if (_tgtUser && _isGlobalRole(_tgtUser.role)) {
      return res.status(400).json({ error: "Cannot remove staff tag from admin/superadmin users. Demote to participant first." });
    }
  }
  const r = db.prepare("DELETE FROM user_tags WHERE user_id=? AND tag=?").run(req.params.id, tag);
  if (r.changes > 0) {
    recordUserEvent(req.params.id, "tag_removed", getAdminIdentity(req), { tag, ...reqContext(req) });
    _invalidateUserTagsCache(req.params.id);
    db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(req.params.id).forEach(r2 => invalidateLeaderboardCache(r2.competition_id));
    _invalidateMeCache(req.params.id); // staff tag flips /api/me's `isStaff` field
    invalidateAdminParticipantsCache();
    // audit v7.7.32 (RM4) — removing the `staff` tag restores group-sync
    // eligibility (reconcile skips staff), so re-run reconciliation for the
    // user's group-bound competitions. Mirrors the approve/unblock paths.
    if (tag === "staff") reconcileUserGroupCompetitions(req.params.id, { actor: getAdminIdentity(req) }).catch((e) => swallowed("participants:group-reconcile", e, { level: "warn" }));
  }
  const tags = db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, tags });
});

const PERMANENT_TAGS = ["benchmark", "staff"];
app.get("/api/admin/tags", requireAdmin, (req, res) => {
  // v8.7.0 — the FREE-TEXT tags are narrowed to those held by participants this
  // actor can see; a platform-wide DISTINCT would turn this filter menu into a
  // directory of every label any organiser has ever invented, including ones
  // naming other people's events or cohorts.
  //
  // PERMANENT_TAGS stay in the response UNCONDITIONALLY, and that is not an
  // oversight. `staff` and `benchmark` are platform vocabulary rather than
  // somebody's data — the analytics filter bar renders its exclusion chips from
  // this list, so dropping them because no visible participant happens to carry
  // one would silently remove the controls that decide who counts on a board.
  const _tagScope = scopedCompetitionIds(req);
  let tags;
  if (_tagScope === null) {
    tags = db.prepare("SELECT DISTINCT tag FROM user_tags ORDER BY tag").all().map(r => r.tag);
  } else if (!_tagScope.length) {
    tags = [];
  } else {
    tags = db.prepare(
      `SELECT DISTINCT ut.tag FROM user_tags ut
        WHERE EXISTS (SELECT 1 FROM competition_users cu
                       WHERE cu.user_id=ut.user_id AND cu.competition_id IN (SELECT value FROM json_each(?)))
        ORDER BY ut.tag`
    ).all(JSON.stringify(_tagScope)).map(r => r.tag);
  }
  const merged = [...new Set([...PERMANENT_TAGS, ...tags])].sort();
  res.json(merged);
});

app.post("/api/admin/participants/:id/verify", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  // A role scoped to its events reaches this route by holding Mark accounts
  // verified, and verifies only people in its events; asked before the lookup,
  // so an id outside its reach is no oracle (scope before existence).
  { const denied = participantDenied(req, req.params.id); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  const adminId = getAdminIdentity(req);
  // v6.16.7 — superadmin manual verify on a denied user used to leave
  // an inconsistent shape (verified=1, denied_at IS NOT NULL,
  // blocked=1). The pStatus priority correctly showed "Denied" so the
  // visual stayed sane, but the operator's intent ("get this user
  // moving") was silently incomplete — they then had to /approve to
  // reverse the denial. Reject here with explicit guidance so the
  // operator goes down the proper "Approve" reverse-deny path that
  // clears denied_at + sets blocked=0 + sets approved=1 atomically.
  if (user.denied_at) {
    return res.status(400).json({
      error: "User has been denied. Click Approve to reverse the denial in one step (clears denied_at + blocked=0 + approved=1) instead of manual verify.",
    });
  }
  // ── v8.3.22 — MANUAL VERIFY DOES ONE THING. ──
  //
  // v6.9.19 bundled a recovery `reset_code` into this transaction and returned it
  // as `resetLink` + `resetBundled:true`, so a superadmin could share a
  // credential out-of-band alongside the verify. The CLIENT never rendered it:
  // `verifyUser()` (public/js/features/participants-admin.js) discards the
  // response body and toasts "User verified!", and its own confirmation dialog
  // told the admin to run **Reset Password** afterwards. So the link was
  // reachable only with curl, and v8.3.21's documentation true-up found the
  // superadmin guide describing a popup that cannot appear.
  //
  // Removing the two response fields alone would have been worse than leaving
  // them: the code would still be minted, now reachable by nobody at all, while
  // keeping its two side effects. Both are gone with it:
  //
  //   * it spent the account's ONE live credential (v7.29.0) — the same UPDATE
  //     cleared `login_code_hash/at/via` and `login_code_sends`, so verifying a
  //     walk-up silently cancelled the sign-in code an organiser had just read
  //     off their screen at the desk. Verifying an account is not a reason to
  //     invalidate a credential somebody is holding.
  //   * it wrote a `password_reset {via:"manual_verify_bundle"}` audit row for a
  //     reset nobody performed.
  //
  // The use case v6.9.19 named — a passwordless account that also cannot receive
  // its verification mail — is served by the control that IS reachable and IS
  // documented: **Show sign-in code**, a one-time code the organiser hands over,
  // which signs the person in with no mail (the verify dialog names it).
  //
  // v7.2.0 — a manual verify also lifts any verification grace
  // (self_enroll_grace_until → NULL); the account is now fully verified, so the
  // header countdown clears and login no longer depends on the grace.
  //
  // ── v8.3.23 — THE VERIFICATION RECEIPT IS LEFT ALONE. ──
  //
  // This statement used to end `verify_code=NULL`, which was correct while
  // clearing the code was how "consumed" was recorded. v7.23.10 moved that
  // marker to `verified` precisely so a SECOND request could tell "already done"
  // from "never existed", and left the code standing as a 48h idempotency
  // RECEIPT — `_completeVerification` resolves the row `WHERE verify_code=?`, so
  // without it the SELECT finds nothing and answers "Verification Failed".
  //
  // Clearing it here re-created that exact failure through a door v7.23.10 did
  // not cover: an admin verifies a stuck account by hand, the participant then
  // clicks the link still sitting in their inbox, and is told their verification
  // failed for an account that is verified — an answer they can do nothing with.
  //
  // Nothing is leaked by keeping it: the code grants no session and proves only
  // mailbox control, which this row has already been credited with. It is bounded
  // at both ends — the handler drops it opportunistically past CODE_EXPIRY_MS,
  // and `sweepStaleVerifyCodes` sweeps verified rows on the hourly tick.
  //
  // `/confirm-email` is the ONE place that must still clear it, and for a reason
  // that does not apply here: that statement REPLACES `users.email`, so the
  // receipt would vouch for an address the account no longer has.
  const verifyTxn = db.transaction(() => {
    const r = db.prepare("UPDATE users SET verified=1, first_verified_at=COALESCE(first_verified_at, ?), self_enroll_grace_until=NULL WHERE id=?").run(now().toISOString(), req.params.id);
    if (r.changes > 0 && !user.verified) recordUserEvent(req.params.id, "verified", adminId, { ...reqContext(req) });
  });
  runTxnWithMirrorBuffer(() => verifyTxn());
  _invalidateMeCache(req.params.id);
  invalidateAdminParticipantsCache();
  // audit v7.7.36 (C7) — a manual verify that flips verified 0→1 makes a grace
  // participant board-eligible; bust every enrolled comp's board (mirrors the
  // self-verify + confirm-email paths). No-op when the user was already verified.
  if (!user.verified) { try { db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(req.params.id).forEach(r => invalidateLeaderboardCache(r.competition_id)); } catch (e) { swallowed("participants:verify-board-bust", e); } }
  res.json({ ok: true });
});

// RBAC — ONE role-change handler behind two doors: the historical participant
// route (superadmin-tier, unchanged) and the Users & roles route, which asks
// for the `users.manage` permission. Built-in and custom roles alike; the
// escalation rule (`roleAssignDenied`) keeps anybody from handing out, or
// taking away, more than their own role holds.
app.post("/api/admin/participants/:id/role", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => _roleChangeHandler(req, res));
app.patch("/api/admin/users/:id/role", requireAdmin, requirePermission("users.manage"), destructiveAdminLimit, csrfProtection, (req, res) => _roleChangeHandler(req, res));
function _roleChangeHandler(req, res) {
  // v6.16.7 — _invalidateMeCache moved to AFTER the txn commit (was
  // line 9320). Pre-fix the order was invalidate-then-update: a
  // concurrent /api/me request landing in the brief window between
  // cache clear and txn commit would re-populate with the OLD role,
  // where it stayed for up to 2 s (the _meCache TTL). Documented
  // writer-lock invariant ("after the DB commit") was inverted.
  // Mitigated by post-role-change session invalidation, but the
  // ordering is still wrong on principle — and the same shape
  // appears on PUT /api/admin/participants/:id and DELETE.
  const user = db.prepare("SELECT id, role FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  const role = req.body?.role;
  // v8.7.0 — `event_admin` joins the accepted set. Moving somebody INTO it here
  // grants the tier with ZERO events (the scope is granted per event, from the
  // competition's own organiser route); moving them OUT of it cascades every
  // grant away inside the same transaction, which is what "demote altogether"
  // means and why it is superadmin-only.
  // RBAC — or any custom role that exists (read live).
  if (typeof role !== "string" || !_roleDefinition(role, { live: true }))
    return res.status(400).json({ error: "Invalid role. Must be participant, event_admin, admin, superadmin, or a custom role." });
  // Prevent self-demotion
  if (req.session.userId === req.params.id && role !== "superadmin") {
    const current = user.role || "participant";
    if (_roleClass(current, { live: true }) !== "none")
      return res.status(400).json({ error: "You cannot demote yourself." });
  }
  // RBAC — the escalation rule. A built-in superadmin passes every arm.
  { const _esc = _roleAssignDenied(req, user.role || "participant", role);
    if (_esc) return res.status(_esc.status).json({ error: _esc.error, code: _esc.code }); }
  const adminId = getAdminIdentity(req);
  const oldRole = user.role || "participant";
  // v8.1.7 — hoisted out of the txn body so the side effects BELOW can key on
  // what actually changed. See the `staffRemoved` note after the commit.
  let tagDelta = 0;
  let eventAdminGrantsCleared = 0; // v8.7.0 — reported on the role_changed event
  const roleTxn = db.transaction(() => {
    db.prepare("UPDATE users SET role=? WHERE id=?").run(role, req.params.id);
    // v7.21.32 — emit on the TAG delta, not on the role delta. The staff tag
    // decides leaderboard exclusion, and this write is unconditional while the
    // role_changed emit below is not: posting the role a user already has still
    // adds or removes `staff`, and used to leave no trace at all. The event types
    // match the dedicated tag routes so one consistent trail is queryable.
    // RBAC — by class: every unscoped (class `all`) role carries `staff`.
    if (_isGlobalRole(role, { live: true })) {
      tagDelta = db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, 'staff')").run(req.params.id).changes;
      if (tagDelta) recordUserEvent(req.params.id, "tag_added", adminId, { tag: "staff", via: "role_change", ...reqContext(req) });
    } else {
      tagDelta = db.prepare("DELETE FROM user_tags WHERE user_id=? AND tag='staff'").run(req.params.id).changes;
      if (tagDelta) recordUserEvent(req.params.id, "tag_removed", adminId, { tag: "staff", via: "role_change", ...reqContext(req) });
    }
    // v8.7.0 — LEAVING the event-admin tier drops every event grant, in this
    // same transaction. A row left behind would be inert (the role gate refuses
    // first) but would silently re-arm the moment somebody was granted the tier
    // again — a scope nobody chose, restored by a later unrelated action.
    // RBAC — leaving any grant-scoped (class `granted`) role for one that is not.
    if (_roleClass(oldRole, { live: true }) === "granted" && _roleClass(role, { live: true }) !== "granted") {
      eventAdminGrantsCleared = db.prepare("DELETE FROM competition_admins WHERE user_id=?").run(req.params.id).changes;
    }
    // A custom role's id means nothing to a reader, and nothing at all once the
    // role is deleted, so its label at the time rides the record (History shows it).
    const _customLabel = (r) => (_isBuiltinRole(r) ? null : ((_roleDefinition(r, { live: true }) || {}).label || null));
    const _fromL = _customLabel(oldRole), _toL = _customLabel(role);
    if (oldRole !== role) recordUserEvent(req.params.id, "role_changed", adminId, { from: oldRole, to: role, ...(_fromL ? { from_label: _fromL } : {}), ...(_toL ? { to_label: _toL } : {}), event_admin_grants_cleared: eventAdminGrantsCleared, ...reqContext(req) });
  });
  runTxnWithMirrorBuffer(() => roleTxn());
  _invalidateMeCache(req.params.id);
  _invalidateUserTagsCache(req.params.id); // v6.20.x — role flip toggles the staff tag
  invalidateAdminParticipantsCache();
  // v8.1.7 — THE TWO SIDE EFFECTS BELOW FOLLOW THE TAG, NOT THE ROLE.
  //
  // v7.21.32 made the staff write unconditional and keyed only its AUDIT emit on
  // the tag delta — its own note says posting the role a user already has still
  // adds or removes `staff`. These two stayed on the ROLE delta, so a same-role
  // POST that stripped the tag from a participant-role helper made them board-
  // and group-eligible while busting no cached board and, more durably, skipping
  // the reconcile that the dedicated DELETE /tags/staff route runs
  // unconditionally — leaving a group-bound member silently un-enrolled until
  // some unrelated later trigger. Only an API client can reach it (the SPA kebab
  // never posts the current role), but the endpoint accepts and acts on that
  // call shape, which is the same premise v7.21.32's own fix rested on.
  //
  // Both conditions are a strict SUPERSET of what they were: the role clause is
  // kept alongside the tag clause rather than replaced. Narrowing to the tag
  // alone would be a second, unreported behaviour change — an admin→superadmin
  // move changes no tag and so would stop busting, which is almost certainly
  // fine and is not this fix's to decide.
  const staffRemoved = tagDelta > 0 && !_isGlobalRole(role, { live: true });
  // v6.9.12: the `staff` user-tag filters the target in or out of public
  // leaderboards across every competition they touch. Invalidate only the
  // competitions the user is enrolled in (avoids clearing every cached
  // competition on a single-user role change).
  if (tagDelta > 0 || oldRole !== role) db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(req.params.id).forEach(r => invalidateLeaderboardCache(r.competition_id));
  // audit v7.7.38 (SEC2, RM4 sibling) — losing the staff tag makes the user
  // eligible for group-desired enrollment that reconcileCompetitionMembership
  // skips for staff. Reconcile so a group-bound member isn't left unenrolled
  // (mirrors the staff-untag route, which reconciles on the tag delta alone).
  if (staffRemoved || (oldRole !== role && !_isGlobalRole(role, { live: true }))) reconcileUserGroupCompetitions(req.params.id, { actor: adminId }).catch((e) => swallowed("participants:group-reconcile", e, { level: "warn" }));
  // Force re-login so the new role takes effect immediately. The target user's
  // existing sessions still carry the OLD isAdmin / isSuperAdmin flags from when
  // they logged in — without invalidating those sessions, a demoted admin would
  // keep admin powers until their session naturally expires (up to 60 minutes).
  if (oldRole !== role) {
    try {
      const { purgedCount } = invalidateOtherSessions("userId", req.params.id, null, SESSION_END.ended);
      if (purgedCount > 0) recordUserEvent(req.params.id, "sessions_invalidated", adminId, { reason: "role_change", purged: purgedCount, ...reqContext(req) });
    } catch (e) { swallowed("participants:role-change-session-purge", e); }
  }
  // v8.7.0 — both the role and the scope moved, so the event-admin caches must
  // be dropped by id, after the commit, like every other writer here.
  invalidateEventAdminScope(req.params.id);
  const tags = db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, role, tags, event_admin_grants_cleared: eventAdminGrantsCleared });
}

app.post("/api/admin/participants/:id/approve", requireAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.7.0 — after the 404 and before the write, so a refused approval commits
  // nothing and sends no "you can now log in" mail.
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });
  // v6.20.x — peer-admin guard, matching /deny, /block, /unlock.
  // A regular admin must not act on an admin/superadmin target. Approve is
  // monotone so direct escalation isn't possible, but the deny-reversal branch
  // below clears blocked/denied_at on the target — a peer admin could use it to
  // un-block a privileged colleague. Close the surface for defence-in-depth.
  const targetRole = user.role || "participant";
  if (_privilegedTarget(req, targetRole)) {
    return res.status(403).json({ error: "Only superadmins can approve admin or superadmin accounts." });
  }
  if (user.approved) return res.json({ ok: true, already: true });
  // Approve must match every login-time gate — otherwise a scripted /
  // tampered request can flip a user to approved=1 while login still
  // rejects them, and we'd send them an "approved, you can now log in"
  // email that lies. Login sequence: blocked → locked_until → unverified
  // → not approved → bcrypt. Approve mirrors the first three.
  if (!user.verified) return res.status(400).json({ error: "User has not yet verified their email. Approval is not meaningful until the account is verified." });
  // v6.14.0 — denied users are blocked by construction (deny sets
  // blocked=1). Approving a denied user is a deliberate "reverse the
  // denial" action and must clear the denial state in the same
  // transaction. Regular blocked-but-not-denied users still need an
  // explicit unblock first — this branch only exempts the denial case.
  const isDeniedReversal = !!user.denied_at;
  if (user.blocked && !isDeniedReversal) return res.status(400).json({ error: "User is blocked. Unblock first before approving." });
  if (isLockedNow(user)) {
    return res.status(400).json({ error: "User is currently locked out after too many failed logins. Unlock first before approving, or wait for the lockout to expire." });
  }
  const approvedBy = getAdminIdentity(req);
  const approveTxn = db.transaction(() => {
    if (isDeniedReversal) {
      db.prepare(
        "UPDATE users SET approved=1, approved_at=?, approved_by=?, " +
        "denied_at=NULL, denied_by=NULL, denied_reason=NULL, " +
        "blocked=0 WHERE id=?"
      ).run(now().toISOString(), approvedBy, user.id);
      recordUserEvent(user.id, "approved", approvedBy, { via: "deny_reversal", ...reqContext(req) });
    } else {
      db.prepare("UPDATE users SET approved=1, approved_at=?, approved_by=? WHERE id=?")
        .run(now().toISOString(), approvedBy, user.id);
      recordUserEvent(user.id, "approved", approvedBy, { ...reqContext(req) });
    }
  });
  runTxnWithMirrorBuffer(() => approveTxn());
  // v6.16.14 — symmetric with bulk-approve (which already invalidates
  // per-user). Pre-fix the single-user /approve only invalidated the
  // admin-participants cache. The user's `/api/me` cache wouldn't
  // normally be populated pre-approval (login refuses pre-approval),
  // but the deny-reversal branch handles users whose `denied_at` was
  // non-NULL — they may have had session state and `/api/me` reads
  // landing inside the 2 s TTL would surface stale `approved=0`.
  _invalidateMeCache(user.id);
  invalidateAdminParticipantsCache();
  // audit v7.7.32 (RM4) — the user just became ELIGIBLE. Re-run reconciliation
  // for every bound competition they're group-desired for, so a member added to
  // a group (bound to an upcoming/live comp) BEFORE approval is now enrolled
  // instead of silently skipped forever. Fire-and-forget (mirrors sessions.js).
  reconcileUserGroupCompetitions(user.id, { actor: approvedBy }).catch((e) => swallowed("participants:group-reconcile", e, { level: "warn" }));
  // CxOne provisioning happens when user is assigned to a competition, not on approval
  // Send approval notification email
  const platformName = getPlatformName();
  const baseUrl = BASE_URL;
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Your ${escapeHtml(platformName)} account has been approved. You can now log in and access the platform.</p>`,
    linkUrl: baseUrl, linkText: "Go to " + platformName,
    fallbackNote: "If you did not register for this platform, you can safely ignore this message.",
  });
  // Bounded (EMAIL_FANOUT_DEADLINE_MS): the pooled relay's queue must not hold
  // the answer to a committed approval past the browser's 30 s abort, which
  // reads as "try again". A send still queued then answers emailDeferred.
  const emailDelivered = await awaitDeliveryWithDeadline(sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — Your Account Has Been Approved`, html, text }, "account_approved", { competitionId: null }), EMAIL_FANOUT_DEADLINE_MS, "participants:approve-mail");
  res.json({ ok: true, emailDelivered, ...(emailDelivered === null ? { emailDeferred: true } : {}) });
});

// v6.14.0 — explicit "Deny approval" terminal action for self-registered
// users. Only valid for users who are NOT yet approved; once approved,
// the row is monotone — block them or, superadmin-only, delete them.
// Sets denied_at/by/reason + blocked=1 in one transaction, sends the
// `account_denied` email, kills any live session as defence in depth.
// Idempotent: a second deny on an already-denied row returns
// {already:true} without re-sending the email or writing a duplicate
// audit row. Approving a denied user later (POST /approve) clears the
// denial in one click — see /approve above.
app.post("/api/admin/participants/:id/deny", requireAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.7.0 — denial is terminal for the account and mails the person, so it is
  // refused before either.
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });
  const targetRole = user.role || "participant";
  // Same peer-admin guard /approve enforces. A regular admin cannot
  // deny an admin/superadmin target — that's a privilege-escalation
  // surface (a peer admin could mass-deny their colleagues).
  if (_privilegedTarget(req, targetRole)) {
    return res.status(403).json({ error: "Only superadmins can deny admin or superadmin accounts." });
  }
  if (user.approved) {
    return res.status(400).json({ error: "User is already approved. Block them instead — approval is monotone, denial is only valid for not-yet-approved accounts." });
  }
  if (user.denied_at) {
    return res.json({ ok: true, already: true });
  }
  // Optional reason. Trim + 500-char cap matches the rest of the
  // free-text caps the platform applies to admin-supplied strings
  // (e.g. competition descriptions). Empty string means "no reason"
  // and the email body uses a generic phrasing.
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  const deniedBy = getAdminIdentity(req);
  const deniedAt = now().toISOString();
  const denyTxn = db.transaction(() => {
    db.prepare(
      "UPDATE users SET denied_at=?, denied_by=?, denied_reason=?, blocked=1 WHERE id=?"
    ).run(deniedAt, deniedBy, reason || null, user.id);
    recordUserEvent(user.id, "denied", deniedBy, reason ? { reason, ...reqContext(req) } : { ...reqContext(req) });
  });
  runTxnWithMirrorBuffer(() => denyTxn());
  invalidateAdminParticipantsCache();
  _invalidateMeCache(user.id);
  // Defence in depth: the user usually has no live session pre-
  // approval, but if one exists (somehow), kill it so login refuses
  // them on the very next request.
  try {
    const { purgedCount } = invalidateOtherSessions("userId", user.id, null, SESSION_END.ended);
    if (purgedCount > 0) recordUserEvent(user.id, "sessions_invalidated", deniedBy, { reason: "denied", purged: purgedCount, ...reqContext(req) });
  } catch (e) { swallowed("participants:deny-session-purge", e); }
  // Send the `account_denied` notification. Includes the optional
  // reason in the body if the admin filled it in. Subject is
  // intentionally neutral ("Application Update") rather than blunt
  // ("DENIED") — the body carries the actual outcome.
  const platformName = getPlatformName();
  const reasonHtml = reason
    ? `<p><strong>Reason from the organiser:</strong> ${escapeHtml(reason)}</p>`
    : "";
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Thank you for registering on ${escapeHtml(platformName)}. After review, your account application has not been approved at this time.</p>${reasonHtml}`,
    fallbackNote: "If you believe this was made in error, please reply to this email or contact your event organiser.",
  });
  // Bounded like the approval's mail, for the same reason.
  const emailDelivered = await awaitDeliveryWithDeadline(sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — Account Application Update`, html, text }, "account_denied", { competitionId: null }), EMAIL_FANOUT_DEADLINE_MS, "participants:deny-mail");
  res.json({ ok: true, emailDelivered, ...(emailDelivered === null ? { emailDeferred: true } : {}) });
});

app.post("/api/admin/participants/bulk-approve", requireAdmin, bulkAdminLimit, csrfProtection, async (req, res) => {
  let { userIds } = req.body;
  if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: "No users specified" });
  // v6.16.14 — reject non-string entries (matches bulk-assign).
  if (userIds.some(x => typeof x !== "string"))
    return res.status(400).json({ error: "userIds must be an array of strings" });
  // v6.16.11 — dedupe input.
  userIds = Array.from(new Set(userIds));
  if (userIds.length > BULK_ADMIN_MAX) return res.status(400).json({ error: `Cannot approve more than ${BULK_ADMIN_MAX} users in a single request.` });
  const approvedBy = getAdminIdentity(req);
  const approvedAt = now().toISOString();
  const batchId = uuid();
  const platformName = getPlatformName();
  const baseUrl = BASE_URL;
  let approved = 0;
  let emailFailures = 0;
  let skipped = 0;
  let skippedPrivileged = 0;
  // v8.7.0 — its OWN counter, not folded into `skipped`. That one already means
  // "did not meet the account preconditions" (unverified / blocked / lost the
  // lockout race), and an operator reading it cannot act on a number that
  // silently mixes in "not yours to approve" — the two have different remedies.
  let skippedOutOfScope = 0;
  // A RIVAL's account (lib/staff-compete.js competitorRivalDenied: someone the
  // actor competes against) is not theirs to approve, as at the single Approve:
  // skipped and counted, like every precondition here.
  let skippedRival = 0;
  // v6.16.6 — per-batch cache hygiene. Pre-fix the admin cache was
  // invalidated ONCE at the end of the loop, so during a long batch
  // (200 users × slow SMTP) admin pages showed stale "Pending"
  // status for already-approved users until the batch finished. The
  // per-user /api/me cache wasn't invalidated at all — a participant
  // who polled /api/me right after their own approval kept seeing
  // approved=0 until the 2-s TTL expired. Fix invalidates the admin
  // cache every BULK_CACHE_FLUSH_EVERY rows (24 keeps the latency
  // tax negligible) and the per-user cache after every successful
  // approval row.
  const BULK_CACHE_FLUSH_EVERY = 24;
  // D-07: collect approved users during the DB loop, then send all emails via a
  // BOUNDED pool (v7.2.x audit — was an unbounded Promise.allSettled) so N
  // approvals take ~ceil(N/8) SMTP hops without N simultaneous connections.
  const pendingEmails = [];
  for (const uid of userIds) {
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
    if (!user || user.approved) continue;
    // Same preconditions as the single-user /approve. Skip rather than 400 so
    // a mixed-batch POST still lands the eligible rows; `skipped` reports the
    // count so the operator isn't lied to about "approved N user(s)".
    if (!user.verified || user.blocked) { skipped++; continue; }
    // v7.2.x (audit) — peer-admin guard, mirroring the single-user /approve. A
    // regular admin must not approve an admin/superadmin colleague via the bulk
    // path (parity + defence-in-depth: bulk-approve was the one approval route
    // lacking it). Skip rather than 400 so the eligible rows still land.
    const _tRole = user.role || "participant";
    if (_privilegedTarget(req, _tRole)) { skippedPrivileged++; continue; }
    // v8.7.0 — SKIPPED, not refused, matching every other precondition on this
    // route: a mixed batch must still land the rows the actor may act on. The
    // count is reported, because a skip counter with no consumer is the v7.21.2
    // defect — it would tell the operator "approved 8" and never say why the
    // other four are still pending.
    // The scope question has two answers, each with its own count (and sentence
    // on screen): not in the organiser's events, or an organiser's or an
    // administrator's account that only an administrator may approve.
    const _scopeNo = participantDenied(req, uid);
    if (_scopeNo) { if (_scopeNo.code === "event_admin_target_privileged") skippedPrivileged++; else skippedOutOfScope++; continue; }
    if (competitorRivalDenied(db, competitorIds(req), uid)) { skippedRival++; continue; }
    // v6.16.8 — locked_until check moved INTO the UPDATE WHERE clause.
    // Pre-fix the in-memory `isLockedNow` could go stale: the 30-s
    // lockout-expiry poller (server.js:5320) might clear `locked_until`
    // between the SELECT and the UPDATE, leaving the user technically
    // eligible but reported as `skipped`. Resolving the gate inside
    // the WHERE clause means SQLite reads the truly-current row at
    // UPDATE time, and `r.changes === 0` indicates "still locked"
    // unambiguously.
    const bulkApproveTxn = db.transaction(() => {
      // v6.16.13 — `denied_at IS NULL` predicate. Pre-fix the WHERE
      // clause filtered on `verified=1 AND blocked=0 AND (locked_until
      // IS NULL OR locked_until <= ?)`. Single-user /approve has an
      // explicit `isDeniedReversal` branch that clears
      // denied_at/by/reason + sets blocked=0 + records `via:
      // "deny_reversal"`. Bulk-approve had no such branch and no
      // denied_at filter. Normal lifecycle (denied implies blocked=1
      // by v6.14.0 invariant) made `blocked=0` filter denied users
      // adequately — but the platform documents the out-of-band-split
      // case (requireParticipant v6.16.6, requireAdmin v6.16.10
      // re-check denied_at independently of blocked). If the
      // invariant splits, bulk-approve would silently approve a denied
      // user without clearing denial. Adding the predicate forces such
      // rows to surface as `skipped` (r.changes===0) and forces the
      // operator down the explicit /approve reverse-deny path that
      // does the cleanup atomically.
      const r = db.prepare(
        "UPDATE users SET approved=1, approved_at=?, approved_by=? WHERE id=? AND verified=1 AND blocked=0 AND denied_at IS NULL AND (locked_until IS NULL OR locked_until <= ?)"
      ).run(approvedAt, approvedBy, user.id, now().toISOString());
      // Surface "lost the race" as a skip so the response counters stay
      // truthful. The user's still-locked row will be picked up on a
      // subsequent batch or the next single /approve call.
      if (r.changes === 0) return false;
      recordUserEvent(user.id, "approved", approvedBy, { via: "bulk", batch_id: batchId, ...reqContext(req) });
      return true;
    });
    if (!runTxnWithMirrorBuffer(() => bulkApproveTxn())) { skipped++; continue; }
    _invalidateMeCache(user.id);
    approved++;
    // audit v7.7.38 (R1) — reconcile group→competition membership on the bulk path
    // too. The RM4 fix (v7.7.32) added this to the single /approve, unblock, and
    // staff-untag handlers because reconcileCompetitionMembership SKIPS an
    // unapproved group-desired member; bulk-approve does the identical approved
    // 0→1 transition but was missed, so a cohort approved in bulk (the normal
    // pre-event flow) was silently never enrolled into its group-bound comps.
    reconcileUserGroupCompetitions(user.id, { actor: approvedBy }).catch((e) => swallowed("participants:group-reconcile", e, { level: "warn" }));
    if (approved % BULK_CACHE_FLUSH_EVERY === 0) invalidateAdminParticipantsCache();
    const { html, text } = buildEmail(platformName, {
      greeting: user.first_name || user.nickname,
      body: `<p>Your ${escapeHtml(platformName)} account has been approved. You can now log in and access the platform.</p>`,
      linkUrl: baseUrl, linkText: "Go to " + platformName,
      fallbackNote: "If you did not register for this platform, you can safely ignore this message.",
    });
    // v7.2.x (audit, perf) — push a THUNK, not a started promise, so the pool
    // below bounds concurrency (was an unbounded Promise.allSettled = up to 1000
    // simultaneous SMTP connections).
    pendingEmails.push(() => sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — Your Account Has Been Approved`, html, text }, "account_approved_bulk", { competitionId: null }).then(ok => { if (!ok) emailFailures++; }, () => { emailFailures++; }));
  }
  if (approved > 0) invalidateAdminParticipantsCache();
  // Fire all approval emails in parallel; count failures for the response.
  const _approveMail = await _runBoundedWithDeadline(pendingEmails, 8, EMAIL_FANOUT_DEADLINE_MS); // bounded fan-out; each thunk records its own failure into emailFailures
  // emailFailures lets the UI tell the operator how many approval emails
  // never left the process (typically SMTP down). Approval itself always
  // succeeds for eligible rows — only notification delivery can fail partially.
  // `skipped` counts users that didn't meet preconditions (unverified or blocked).
  // `emailsDeferred` means the approvals are committed but some notifications
  // were still sending when we replied — emailFailures is a floor, not a total.
  res.json({ ok: true, approved, emailFailures, skipped, skippedPrivileged, skippedOutOfScope, skippedRival, emailsDeferred: !!_approveMail.deferred });
});

app.post("/api/admin/participants/:id/block", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  // v6.16.13 — _invalidateMeCache moved to AFTER blockTxn (matches
  // v6.16.7 ordering pattern fixed in /role + PUT participant +
  // DELETE participant). Pre-fix the call ran before the SELECT,
  // before the txn — a concurrent /api/me landing in the window
  // between cache-clear and txn-commit would re-populate with the
  // OLD `blocked=0` state, surviving up to 2 s. invalidateOtherSessions
  // below evicts live sessions so the practical exploit window is
  // narrow, but the cache-ordering invariant still requires the
  // post-txn placement.
  const user = db.prepare("SELECT id, role, blocked, locked_until, email, secondary_email, first_name, nickname FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.7.0 — blocking purges every live session for the target, platform-wide —
  // not merely inside one event — so it is refused before the toggle is even
  // computed.
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });
  const newBlocked = user.blocked ? 0 : 1;
  const targetRole = user.role || "participant";

  if (newBlocked === 1 && req.session.userId && req.session.userId === user.id) {
    return res.status(400).json({ error: "You cannot block your own account." });
  }
  // Regular admins may not block/unblock any privileged account. Without this,
  // one regular admin could lock peer admins out of the platform — interfering
  // with incident response and (for blocking) immediately purging their sessions.
  // Email-takeover was closed earlier; this closes the operational-interference
  // half of the same "peer-admin tampering" class.
  if (_privilegedTarget(req, targetRole)) {
    return res.status(403).json({ error: "Only superadmins can block or unblock admin or superadmin accounts." });
  }

  const adminId = getAdminIdentity(req);
  const blockTxn = db.transaction(() => {
    if (newBlocked === 0) {
      // NOT clearLockout() (v7.29.0): this is one statement that also clears
      // `blocked`, so splitting it would put two writes where the unblock
      // currently has one. Composite writes keep their own SQL; see lib/lockout.js.
      db.prepare("UPDATE users SET blocked=0, locked_until=NULL, failed_login_count=0, failed_login_first=NULL WHERE id=?").run(user.id);
      recordUserEvent(user.id, "unblocked", adminId, { ...reqContext(req) });
    } else {
      db.prepare("UPDATE users SET blocked=1 WHERE id=?").run(user.id);
      recordUserEvent(user.id, "blocked", adminId, { ...reqContext(req) });
    }
  });
  runTxnWithMirrorBuffer(() => blockTxn());
  _invalidateMeCache(req.params.id);
  invalidateAdminParticipantsCache();
  // audit v7.7.32 (RM4) — UNBLOCKing restores eligibility; re-run group-bound
  // reconciliation so a member skipped while blocked is now enrolled (mirrors
  // the approve path). No-op on block (reconcile re-skips a blocked user).
  if (newBlocked === 0) reconcileUserGroupCompetitions(user.id, { actor: adminId }).catch((e) => swallowed("participants:group-reconcile", e, { level: "warn" }));
  // When blocking, kill every active session for the target so the lockout is
  // immediate rather than deferred to the next request (which would otherwise
  // honour an in-flight session up to 60 minutes after the block).
  if (newBlocked === 1) {
    try {
      const { purgedCount } = invalidateOtherSessions("userId", user.id, null, SESSION_END.ended);
      if (purgedCount > 0) recordUserEvent(user.id, "sessions_invalidated", adminId, { reason: "blocked", purged: purgedCount, ...reqContext(req) });
    } catch (e) { swallowed("participants:block-session-purge", e); }
  }
  res.json({ ok: true, blocked: newBlocked });
});

// v7.14.0 — enter impersonation. Any admin may impersonate a PARTICIPANT-role
// account (admin/superadmin targets are off-limits for everyone, matching the
// peer-admin-tampering doctrine on block/role/edit), and — since v8.7.0 — a
// GLOBAL admin may impersonate an EVENT ADMIN (`participantDenied` refuses a
// fellow organiser for the event-admin tier, so that door is a global admin's).
// The target must be able to pass requireParticipant — impersonating a blocked /
// denied / unapproved account would fail every participant request anyway — so
// ineligible targets are rejected up front with a stable reason. UNVERIFIED is
// deliberately NOT one of them (v7.15.8); the gates that must agree on that
// were four at v7.21.4 — this one, requireParticipant, POST /api/session/keepalive
// and GET /api/session/status — and the event-admin view (v8.12.1) added
// requireAdmin, GET /api/admin/me, the toggle's admin-view gate and the docs
// gate. A count in prose is not an enumeration: grep for the v7.15.8 citations
// before adding a lifecycle read that asks the TARGET's `verified`. Mechanics
// mirror toggle-admin-view: snapshot the admin identity, regenerate (session
// fixation defence on the privilege change), then assume the target's identity.
//
// v8.12.1 — THE VIEW IS CHOSEN AT ENTRY (`view: "participant" | "admin"`,
// default participant, so every pre-existing caller is unchanged). The admin
// view exists for an `event_admin` target only — a participant has no admin
// panel to show — and sets `isAdmin=true` on the impersonation session, NEVER
// `isSuperAdmin`: the target is not a superadmin, and the write tier is decided
// from the ACTING admin's row by impersonationGuard (lib/impersonation.js), not
// from a session flag. In the participant view both flags stay unset and admin
// endpoints reject the session, as they always have. Three refusals are the
// admin view's own, in ladder order after the existing ones: a NESTED entry
// (an impersonation session asking to impersonate — the marker would be
// overwritten with the target's identity), the acting tier (belt and braces —
// `participantDenied` already refuses an event-admin actor a fellow organiser,
// and the built-in account passes), and the acting admin COMPETING in an event
// the target organises (the competitor lock is asked about the seat inside the
// panel, so it must be asked about the human here — and re-asked on every
// write by the guard). The row is refused outright rather than opened in the
// participant view, so a declined admin view never silently becomes a
// different impersonation. Exit: POST /api/impersonation/exit
// (routes/participant.js); switch: POST /api/toggle-admin-view, which carries
// the marker.
app.post("/api/admin/participants/:id/impersonate", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  if (req.session.impersonator) {
    // Defence in depth: the guard's `_IMPERSONATION_BLOCKED_RE` arm answers this
    // path first with the same code (403), so this line is unreachable while
    // the guard is mounted — stated, not claimed as the client's answer.
    return res.status(409).json({ error: "You are already impersonating somebody. Exit that impersonation first.", code: "impersonation_nested" });
  }
  const target = db.prepare("SELECT id, role, email, first_name, last_name, nickname, blocked, denied_at, verified, approved, self_enroll_grace_until FROM users WHERE id=?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.7.0 — impersonation assumes the person's identity EVERYWHERE, including
  // events this actor does not manage, so the scope check is what keeps it from
  // being a way around every other predicate in this file. Before regenerate().
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });

  const targetRole = target.role || "participant";
  if (targetRole === "admin" || targetRole === "superadmin") {
    return res.status(403).json({ error: "Cannot impersonate an admin or superadmin account." });
  }
  // RBAC — an account holding a CUSTOM role is not impersonable (neither view):
  // only the built-in event admin's panel has the seat-keyed carve-outs.
  if (!_isBuiltinRole(targetRole)) {
    return res.status(403).json({ error: "Cannot impersonate an account that holds a custom role.", code: "impersonation_target_custom_role" });
  }
  const reason = target.blocked ? "blocked"
    : target.denied_at ? "denied"
    : !target.approved ? "not_approved"
    // v7.15.8 — UNVERIFIED is deliberately NOT a refusal any more. An admin's
    // reason to impersonate an unverified participant is precisely that the
    // account is stuck: they want to see what that person sees. Verification
    // state gates the PARTICIPANT signing in themselves; it grants the admin
    // nothing extra, the action is still admin-gated, audited, and read-only for
    // a regular admin. blocked / denied / not-approved remain refusals — those
    // are deliberate administrative stops, not a state to be inspected.
    : null;
  if (reason) return res.status(409).json({ error: "impersonation_target_inactive", reason });

  // v8.12.1 — the view. Validated AFTER the scope and lifecycle refusals, so an
  // out-of-scope or inactive target answers exactly what it always did
  // (event-admin-matrix and the v8.8.6 locks read those codes), and the admin
  // view's own refusals come last.
  const _viewRaw = req.body && req.body.view;
  if (_viewRaw !== undefined && _viewRaw !== "participant" && _viewRaw !== "admin") {
    return res.status(400).json({ error: 'view must be "participant" or "admin".', code: "impersonation_view_invalid" });
  }
  const view = _viewRaw === "admin" ? "admin" : "participant";
  if (view === "admin") {
    if (targetRole !== "event_admin") {
      return res.status(400).json({ error: "Only an event admin can be impersonated in their admin view — this account has no admin panel.", code: "impersonation_view_unavailable" });
    }
    // The acting tier: a global admin or the built-in superadmin. An event-admin
    // actor is already refused a fellow organiser by participantDenied above
    // (event_admin_target_privileged), so this arm is defence in depth, stated
    // rather than inferred — `req.session.userId` is still the ACTOR here, before
    // regenerate, which is the only place the question can be asked.
    if (req.session.builtinId !== "superadmin") {
      const _actRole = req.session.userId ? db.prepare("SELECT role FROM users WHERE id=?").get(req.session.userId)?.role : null;
      if (!organiserPanelOpensTo(_actRole)) {
        return res.status(403).json({ error: "Only an administrator can open an event admin's own view.", code: "event_admin_forbidden" });
      }
    }
    { const _cmp = refuseCompetitor(res, actingAdminCompetesInTargetEvents(db, actorId(req), target.id)); if (_cmp) return _cmp; }
  }

  // Actor + snapshot captured BEFORE regenerate (the fresh session is empty).
  const actor = getAdminIdentity(req);
  const impersonator = {
    userId: req.session.userId || null,
    userEmail: req.session.userEmail || null,
    userFirstName: req.session.userFirstName || null,
    userLastName: req.session.userLastName || null,
    userRole: req.session.userRole || null,
    builtinId: req.session.builtinId || null,
    isSuperAdmin: !!req.session.isSuperAdmin,
    competitionId: req.session.competitionId || null,
    timeslotId: req.session.timeslotId || null,
    started_at: now().toISOString(),
    // v8.12.1 — the view in force; POST /api/toggle-admin-view moves it.
    view,
  };
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Session error" });
    req.session.impersonator = impersonator;
    req.session.userId = target.id;
    req.session.userEmail = target.email || null;
    req.session.userFirstName = target.first_name || null;
    req.session.userLastName = target.last_name || null;
    // v8.12.1 — the target's REAL role rides the cosmetic mirror (it used to be
    // hard-coded "participant"); nothing authorises on it, `/api/me` reads the
    // DB row, but the access log's `role` is what a reader believes.
    req.session.userRole = targetRole;
    if (view === "admin") {
      req.session.isAdmin = true;
      req.session.isSuperAdmin = false;
    }
    // NOTE: no invalidateOtherSessions here — the target's own live session (if
    // any) keeps working; lib/sessions.js treats this session as the ADMIN's
    // for single-session enforcement (see the ownership rules there).
    try {
      recordUserEvent(target.id, "impersonation_started", actor, {
        admin_user_id: impersonator.userId,
        read_only: !impersonator.isSuperAdmin,
        target_nickname: target.nickname || null,
        target_role: targetRole,
        view,
        ...reqContext(req),
      });
    } catch (e) {
      // non-fatal — impersonation already established
      swallowed("participants:impersonation-started-audit", e);
    }
    res.json({
      ok: true,
      readOnly: !impersonator.isSuperAdmin,
      view,
      target: { id: target.id, nickname: target.nickname || null, email: target.email || null, role: targetRole },
    });
  });
});

// v7.29.0 — THE DESK FALLBACK. Mint a sign-in code and show it on the ADMIN's
// screen instead of emailing it.
//
// This is an explicit, narrow carve-out from "no production response ever
// contains a credential", and without it that rule is a lockout: the on-site
// event makes an email round trip the only way in, corporate gateways greylist
// first contact (a 5-30 minute deferral is correct behaviour, not an outage), and
// the person who can fix it is standing three feet from the person who has the
// problem.
//
// ADMIN, not superadmin, by the v7.16.5 reasoning: it is the admin RUNNING the
// event who is in the room, and a control they cannot reach is no control at all.
// The exposure is bounded — participant-role targets only, single-use, a
// ten-minute TTL, and every reveal audited against BOTH parties.
//
// IT DOES NOT REFUSE THE WAY THE PUBLIC ENDPOINTS DO, and that asymmetry is
// deliberate. Those answer 200-always for anti-enumeration; this one is
// admin-gated with no enumeration surface, and an admin hitting a route that
// silently succeeds while producing nothing is v7.14.2 at API level. It says why.
app.post("/api/admin/participants/:id/login-code/reveal", requireAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied; operator ruling,
  // 19 Sep 2026: every account-level door on a rival, every tier). The answer is
  // a WORKING CREDENTIAL for the rival's account, so a competing organiser could
  // read one out and sign in as them — exactly what the ruling closed for the
  // password reset. Asked where its sibling, Email sign-in code, asks it.
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.7.0 — the response CONTAINS A WORKING CREDENTIAL, so scope is checked
  // before the ladder below and before any code is minted.
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });
  // v8.1.3 — the ladder is `_codeBlockedReason`, the SAME function the row
  // projection and the desk-invite duplicate remedy read, so the row can never
  // offer what this refuses (finding #20: it did, for every unapproved
  // passwordless account, and the redemption then failed blaming expiry).
  const blocked = _codeBlockedReason(user);
  if (blocked) {
    // Each refusal names the remedy that ACTUALLY works for THIS account —
    // v7.29.0's FROZEN_REMEDY lesson and v7.21.14's IP-ban alert. /approve
    // refuses an unverified account and /verify is superadmin-only, so an
    // unverified target must be told both steps AND which tier owns the first,
    // or this becomes one more instruction pointing at a hidden control.
    const refusal = {
      // Kept at 403 (and this wording) because swagger documents it as the
      // not-a-participant answer.
      not_participant: [403, "Sign-in codes are for participant accounts only."],
      account_inactive: [409, "This account is blocked or denied — unblock it or reverse the denial first."],
      not_approved: [409, user.verified
        ? "This account has not been approved yet, and a sign-in code is refused until it is. Approve it first, then show the code."
        : "This account has not been verified or approved yet, and a sign-in code is refused until it is. A superadmin can Verify it; then approve it, then show the code."],
      not_eligible: [409, "This account cannot use a sign-in code."],
      signed_in_before: [409, "This person has signed in before, so a code is no longer shown at the desk. Use Email sign-in code to send one to their sign-in address."],
    }[blocked];
    return res.status(refusal[0]).json({ error: refusal[1], code: blocked });
  }
  // CODE_VIA_DESK, stated rather than left to the NULL default: an admin read
  // this off their own screen, so it proves nothing about the participant's
  // mailbox and must never verify the account. The default is already the safe
  // answer, but a blank provenance would say "the caller did not know" about a
  // path that knows exactly.
  const issued = issueCode(user, CODE_VIA_DESK);
  // v8.8.9 — no refusal branch, because a desk mint cannot be refused. The only
  // null `issueCode` returns is the EMAIL send budget, which this path does not
  // spend (see lib/login-code.js). The 429 that used to be here answered "this
  // account has already been sent the maximum number of codes" about a path that
  // sends nothing, and it fired on the ordinary walk-up who had already pressed
  // "send another" twice — the case the reveal exists for. A guard that cannot
  // fire is the thing this codebase removes rather than keeps as reassurance; if
  // issueCode ever grows a second null, the crash here is loud and this comment
  // names the contract it broke.
  const adminId = getAdminIdentity(req);
  // Audited against BOTH parties: on the participant's row so it shows in their
  // History, and mirrored so an investigator filtering by admin sees it too.
  try {
    recordUserEvent(user.id, "login_code_revealed", adminId, { ...reqContext(req), reissued: !!issued.reissued });
  } catch (e) { swallowed("participants:code-revealed-audit", e); }
  // v8.1.3 — the minutes ACTUALLY LEFT, from the mint itself. This used to be a
  // flat `Math.round(LOGIN_CODE_TTL_MS / 60000)`, i.e. always ten — and
  // `login_code_at` is anchored to the FIRST mint of the window and deliberately
  // not moved on a re-issue, so on this feature's own headline scenario (the
  // emailed code greylisted at T+0, the attendee reaching the desk at T+8) the
  // admin read out "about 10 minutes" for a code that died in two. The attendee
  // typed it at T+11, met the client's generic "may have expired", and nothing
  // on either screen gave anyone a reason to suspect the TTL.
  //
  // Taken from `issued` rather than re-derived here: the arithmetic lives with
  // the anchor in lib/login-code, and the emailed-code path already reads the
  // same field. A second copy is how the two paths come to quote different
  // numbers for one code.
  res.json({ ok: true, code: formatCode(issued.code), expires_in_minutes: issued.expiresInMinutes });
});

// ── v8.1.0 — THE AT-DESK INVITE SHORTCUT ────────────────────────────────────
//
// A walk-up is standing at the desk and needs to be in the event NOW. Every
// existing path costs an email round trip: an invitation waits for them to open
// their inbox, and self-registration waits for an emailed code. At a stand
// with a queue, "check your email" is the answer that loses the visitor.
//
// This creates the account and hands the organiser a sign-in code to read out —
// no mail involved at any point, which is also why it is immune to the
// greylisting that makes the desk fallback necessary in the first place.
//
// THE ACCOUNT IT MAKES IS DELIBERATELY MINIMAL, and every one of these is a
// decision rather than a shortcut:
//
//   * **verified=1 and approved=1** — the organiser standing in front of them IS
//     the identity check and IS the approval. That is exactly what an invitation
//     already asserts, so this claims nothing new; it just skips the round trip.
//   * **NO password** (`password_set_at` stays NULL, the hash the fixed
//     `NO_PASSWORD_HASH` placeholder), so the account signs in with the code
//     this hands over and, after that, with emailed codes (its role's default
//     method). Its holder may set a password later, under Profile.
//   * **`profile_policy` from the event's kind**, so a booth walk-up created at
//     the desk gets the same eight-field deal as one who scanned the QR. Without
//     it they would meet the non-dismissible completion gate asking for two
//     fields nobody collected — the exact trap PR 31 exists to prevent.
//   * **`registration_competition_id` = the event** (v8.12.8, operator ruling),
//     so the completion gate reads that event's LIVE sign-up form exactly as it
//     does for the walk-up who scanned the QR two metres away: a field the
//     organiser later makes mandatory is demanded of the desk account too. Until
//     v8.12.8 the desk stamped only the KIND, so the two doors at one stand drifted
//     apart the moment an organiser configured the form. `profile_policy` stays
//     beside it as the fallback for a deleted event (the pair's reasoning is in
//     db.js).
//
// Admin-tier, not superadmin: it is the admin RUNNING the event who is in the
// room (the v7.16.5 reasoning, and the same tier as the reveal it composes).
//
// v8.12.7 — AUTHORISED TWICE: when the headers arrive (the pre-checks) and again
// inside the write, so an admin revoked, narrowed or signed out in between
// creates nothing and is handed no code. The event's kind is read at that
// second moment too.
app.post("/api/admin/participants/desk-invite", requireAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
  const _v = validateBody(req.body, {
    email: { type: "string", required: true, max: 200, label: "Email" },
    firstName: { type: "string", max: 100, label: "First name" },
    lastName: { type: "string", max: 100, label: "Last name" },
    competitionId: { type: "string", max: 64, label: "Event" },
  });
  if (_v.error) return res.status(400).json({ error: _v.error });
  {
    // The names AS SENT: validateBody's values are trimmed, and a trim strips an
    // edge tab or line break every other door refuses (types checked just above).
    const ctl = profileTextControlField({
      first_name: typeof req.body.firstName === "string" ? req.body.firstName : undefined,
      last_name: typeof req.body.lastName === "string" ? req.body.lastName : undefined,
    });
    if (ctl) return res.status(400).json(profileTextControlBody(ctl));
  }
  const email = normaliseEmail(_v.values.email);
  if (!isValidEmailFormat(email)) return res.status(400).json({ error: "That is not a valid email address." });
  // Sweep #501 (operator ruling, 23 Nov 2026): while new accounts wait for
  // approval, an account made here could not sign in at the desk (a desk code
  // never approves), so a role that cannot approve accounts is refused, with the
  // reason. Asked before the address is looked at, so the refusal tells such a
  // role nothing about it; asked again at commit (1b below).
  if (_deskApprovalWithheld(req)) return res.status(403).json({ error: DESK_APPROVAL_REQUIRED, code: "desk_approval_required" });

  // The corporate-email rule is NOT relaxed here. It is enforced on every other
  // registration path without exception (the only carve-out is an explicit
  // invitation, which blesses one admin-validated address), and a desk shortcut
  // that quietly dropped it would be the easiest way around it on the platform.
  if (isFreeEmail(email)) {
    return res.status(400).json({ error: "A work email is required — a personal address cannot be used on its own." });
  }
  if (emailIsTaken(email)) {
    return res.status(409).json({ error: _deskDuplicateRemedy(email), code: "email_taken" });
  }

  let comp = null;
  if (_v.values.competitionId) {
    comp = getCompetition(_v.values.competitionId);
    if (!comp) return res.status(404).json({ error: "Event not found." });
    // v8.7.0 — refused here, before the create transaction, so a refused desk
    // invite leaves no real user row behind. v8.12.7 — and every check in this
    // block is asked AGAIN inside that transaction (below): these answers are as
    // old as the request's headers.
    // v8.12.0 — a competitor may not seat a new participant beside themselves.
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const _deskDenied = competitionDenied(req, comp.id);
    if (_deskDenied) return res.status(403).json({ error: _deskDenied.message, code: _deskDenied.code });
    // v8.12.6 — the desk admits an event still taking late entries, and the walk-up
    // it creates is a late entrant by construction (their row is written after the
    // end). The same one predicate every door asks (`competitionAdmission`). No
    // took-part check is needed: a brand-new account has no footprint.
    if (!competitionAdmission(comp)) return res.status(409).json({ error: DESK_EVENT_CLOSED });
  } else if (scopedCompetitionIds(req) !== null) {
    // v8.7.0 — AN EVENT ADMIN MUST NAME AN EVENT, and this is a real refusal
    // rather than a formality. The competition is optional for a global admin,
    // who can legitimately create an account ahead of any event. An event admin
    // has no such remit, and the account it would produce is worse than useless:
    // enrolled nowhere, it falls outside every scope INCLUDING its creator's, so
    // it would not appear in their own participants list and no row action would
    // reach it. Refusing is the only outcome that does not strand a real person
    // behind an account nobody can administer.
    return res.status(400).json({ error: DESK_EVENT_REQUIRED, code: "event_admin_competition_required" });
  }

  const id = uuid();
  const createdAt = now().toISOString();
  const adminId = getAdminIdentity(req);
  // The fixed placeholder hash, so the NOT NULL column is filled (every other
  // create does the same). `password_set_at` stays NULL, so no password signs
  // in (`hasUsablePassword`).
  const throwaway = NO_PASSWORD_HASH;

  // v8.12.7 (external audit F1) — EVERYTHING THE PRE-CHECKS ABOVE DECIDED IS
  // RE-ASKED INSIDE THE WRITE, FIRST, with nothing awaited in between (v7.15.13).
  //
  // They were decided when the request HEADERS arrived. Only the test park is
  // awaited before this write, but the write commits an ACCOUNT, verified and
  // approved, and hands over a live sign-in code, so the re-check is made at
  // commit, where no await can open a window between check and write: with an
  // await between them, an admin blocked during it still created the account
  // and received the code (measured, with the request parked across it). The
  // commit park (`testAdminCommitPark`) holds that window open for the tests.
  //
  // The order is the pre-checks' own, and each step has a reason to be where it is:
  //   1. WHO IS ACTING (`adminAuthzDenied`) — lifecycle and role, uncached; both
  //      people under impersonation; the session tombstone (a sign-in elsewhere,
  //      a colleague's role change). First, so a revoked admin learns nothing
  //      about the event or the address.
  //   1b. WHETHER THEY MAY APPROVE the account, while approval is required (sweep
  //      #501): read live, so the setting switched on or the permission taken away
  //      since the headers refuses here.
  //   2. THE EVENT, RE-READ uncached. Deleted since the headers → the 404 the
  //      pre-check gives, and AHEAD of the scope re-ask: deleting an event
  //      cascades `competition_admins`, so an organiser would otherwise be told
  //      they do not organise it. And `fresh`, not `comp`, is what the INSERT
  //      stamps — `event_kind` can change while the event is upcoming (v8.3.0),
  //      and `profile_policy` is the completion gate's fallback for a desk
  //      account whose event is later deleted (v8.12.8: the live answer comes
  //      from `registration_competition_id`, which is `fresh.id` for the same
  //      reason — the event that EXISTS at commit, never one a 404 would have
  //      refused). A PERSIST does not read a cache: `getCompetition` holds a row
  //      for a second.
  //   3. THE COMPETITOR LOCK — seat AND hand, uncached, before scope (the
  //      v8.12.0 order, as in the pre-check).
  //   4. SCOPE, on a FRESH role and grant set. `adminAuthzDenied` ADMITS
  //      event_admin, a grant revoke writes NO tombstone (DELETE …/admins/:uid),
  //      and an out-of-band narrowing (an import overwrite, direct SQL) neither
  //      tombstones nor clears the 2 s role/scope caches — which a request of the
  //      actor's own warmed at the headers. So THIS actor's entries are dropped
  //      and read again. `actorId` is the SEAT under impersonation, which is
  //      whose scope is in question; guarded on the id, because no id clears
  //      EVERY actor's caches. Dropping a cache inside the transaction is safe:
  //      nothing has been written yet, so the re-filled entry holds committed
  //      state, and a rollback leaves only a cold cache.
  //   5. THE EMAIL and THE ADMISSION — the v8.1.7 and v8.12.6 re-checks, below.
  //
  // A refusal throws out of the transaction, so nothing is created and no code
  // is issued; `commitRefusal` carries the answer out.
  await testAdminCommitPark();

  // v8.1.7 — THE DUPLICATE CHECK IS RE-TAKEN INSIDE THE WRITE, and the nickname
  // is resolved there rather than above.
  //
  // `emailIsTaken` above is asked at the headers. With an await between it and
  // this write (the test park), a second request — a double-clicked desk form,
  // two desks working one queue, or an ordinary registration — can create the
  // account in between, and the loser's INSERT would then trip
  // `uq_users_email_nocase`: answered by the catch's generic 409 at best (a 500
  // without it), never the purpose-written 409 that names the remedy for THAT
  // account. Atomicity is never at risk; the MESSAGE is.
  // Same shape as the v7.15.14 import re-check.
  //
  // The pre-check above stays: it is the common path and it refuses before the
  // transaction, where this one is the authority.
  //
  // The nickname probe moves in for the same reason and gets a stronger
  // property than the email does: a synchronous SELECT with no await before the
  // INSERT is genuine mutual exclusion on a single-process, synchronous-driver
  // server, so a nickname collision here is now unreachable rather than merely
  // handled. (Hence `_deskInviteNickname` is no longer async — an await between
  // the probe and the INSERT is the whole defect.)
  let nickname = null;
  let duplicateEmail = false;
  // v8.12.6 — RE-ASKED INSIDE THE WRITE. A late-entry deadline is a wall-clock
  // instant, and the desk is exactly where somebody arrives at the last minute,
  // so the admission decided at the headers is re-made at commit — the v7.15.13
  // rule. A window that closed in between refuses with the SAME 409 the
  // pre-check gives, and because it throws inside the transaction no account is
  // created.
  let eventClosed = false;
  let lateAdmission = false;
  let commitRefusal = null;   // { status, ...body } — a v8.12.7 commit-time refusal
  let fresh = null;           // the event as it stands AT COMMIT
  const refuse = (r) => { commitRefusal = r; throw new Error("desk_commit_refused"); };
  const txn = db.transaction(() => {
    // 1. who is acting
    const _authz = adminAuthzDenied(req);
    if (_authz) refuse(_authz);
    // 1b. whether they may approve the account, while approval is required (read
    // live, so a role that lost the permission, or the setting switched on, since
    // the headers refuses here and nothing is created)
    if (_deskApprovalWithheld(req)) refuse({ status: 403, error: DESK_APPROVAL_REQUIRED, code: "desk_approval_required" });
    if (comp) {
      // 2. the event, re-read
      fresh = db.prepare("SELECT * FROM competitions WHERE id=?").get(comp.id) || null;
      if (!fresh) refuse({ status: 404, error: "Event not found." });
      // 3. the competitor lock
      const _cmp = competitorEditDenied(db, competitorIds(req), fresh.id);
      if (_cmp) refuse({ status: 403, ...competitorRefusalBody(_cmp) });
    }
    // 4. scope, on a fresh role and grant set
    { const _me = actorId(req); if (_me) invalidateEventAdminScope(_me); }
    if (fresh) {
      const _sc = competitionDenied(req, fresh.id);
      if (_sc) refuse({ status: 403, error: _sc.message, code: _sc.code });
    } else if (scopedCompetitionIds(req) !== null) {
      refuse({ status: 400, error: DESK_EVENT_REQUIRED, code: "event_admin_competition_required" });
    }
    // 5. the email and the admission
    if (emailIsTaken(email)) { duplicateEmail = true; throw new Error("email_taken"); }
    if (fresh) {
      const _adm = competitionAdmission(fresh);
      if (!_adm) { eventClosed = true; throw new Error("event_closed"); }
      lateAdmission = _adm === "late";
    }
    nickname = _deskInviteNickname(email);
    // v8.12.8 — `registration_competition_id` is bound beside `profile_policy`,
    // both from `fresh` (the event as it stands AT COMMIT, inside this
    // transaction and after every re-check above — do not hoist either read out
    // of it). NULL when no event was named, which is every account a global
    // admin creates ahead of any event: exactly the join link's own rule, where
    // a sign-up that did not arrive through an event carries no pointer.
    db.prepare(`INSERT INTO users (id, first_name, last_name, nickname, email, password_hash,
        verified, first_verified_at, approved, approved_at, approved_by, role, registered_via,
        profile_policy, registration_competition_id, created_at)
      VALUES (?,?,?,?,?,?,1,?,1,?,?,'participant','desk',?,?,?)`)
      .run(id, _v.values.firstName || "", _v.values.lastName || "", nickname, email, throwaway,
           createdAt, createdAt, adminId, fresh ? (fresh.event_kind || null) : null,
           fresh ? fresh.id : null, createdAt);
    recordUserEvent(id, "user_added", adminId, { via: "desk_invite", email, ...reqContext(req) });
    if (fresh) {
      db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,1)")
        .run(fresh.id, id, adminId, createdAt);
      recordUserEvent(id, "added_to_competition", adminId, { competition_id: fresh.id, competition_name: fresh.name, via: "desk_invite", ...(lateAdmission ? { late_entry: true } : {}), ...reqContext(req) });
      recordCompetitionEvent(fresh.id, "user_added", adminId, { user_id: id, nickname, via: "desk_invite", ...(lateAdmission ? { late_entry: true } : {}), ...reqContext(req) });
    }
  });
  // v8.12.7 — `.immediate()`: a transaction that READS and then WRITES, whose
  // failure refuses the admin (Recurring rules → The driver). Deferred, an
  // external writer (an operator's sqlite3 session, `scripts/purge.sh --apply`)
  // turns the read→write upgrade into SQLITE_BUSY at once — a 500 at the desk
  // with a queue behind it; taking the write lock at BEGIN waits out
  // `busy_timeout` instead. Precedent: `recordSealedReveal` (v8.12.6 F3).
  try { runTxnWithMirrorBuffer(() => txn.immediate()); }
  catch (e) {
    // v8.12.7 — a commit-time refusal answers exactly what the pre-check would
    // have: the same status, the same code, the same sentence.
    if (commitRefusal) { const { status, ...body } = commitRefusal; return res.status(status).json(body); }
    // The loser of the race gets the SAME named 409 the pre-check would have
    // given it, remedy and all — an admin with a queue needs the next step, not
    // a stack trace.
    if (duplicateEmail) return res.status(409).json({ error: _deskDuplicateRemedy(email), code: "email_taken" });
    if (eventClosed) return res.status(409).json({ error: DESK_EVENT_CLOSED });
    // DEFENCE IN DEPTH, and it changes nothing observable today: with both the
    // email re-check and the nickname probe inside this transaction there is no
    // await between either read and the INSERT, so no unique index on `users` is
    // reachable from here. It is kept so a future indexed column cannot quietly
    // turn a duplicate back into a 500, and it deliberately does NOT reuse the
    // email wording — that would name the wrong field. Nothing in the suite
    // exercises this branch.
    if (e && (e.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(e.message || ""))) {
      return res.status(409).json({ error: "That account could not be created — something about it is already taken. Try again.", code: "conflict" });
    }
    throw e;
  }

  invalidateAdminParticipantsCache();
  if (comp) invalidateLeaderboardCache(comp.id);

  // CODE_VIA_DESK — no mail is involved at any point on this path, which is also
  // why it is immune to the greylisting that makes the desk fallback necessary.
  const issued = issueCode({ id, login_code_at: null, login_code_sends: 0 }, CODE_VIA_DESK);
  try { recordUserEvent(id, "login_code_revealed", adminId, { ...reqContext(req), via: "desk_invite" }); } catch (e) { swallowed("participants:desk-code-revealed-audit", e); }
  res.json({
    ok: true, id, nickname, email,
    code: formatCode(issued.code),
    // Always a fresh mint on an account created a statement ago, so this is the
    // full window — but read from the mint like every other path, so the three
    // places a code's life is quoted cannot describe one code differently.
    expires_in_minutes: issued.expiresInMinutes,
    // v8.12.6 — they joined through the event's late-entry window, so the code
    // dialog can tell the organiser they play as a late entrant.
    ...(lateAdmission ? { lateEntry: true } : {}),
  });
});

// v8.12.6 — one sentence for both desk refusals (the pre-check and the re-check
// inside the write), so the two cannot word one outcome two ways.
const DESK_EVENT_CLOSED = "That event has finished and is not taking late entries.";
// Sweep #501: the desk refusal for a role that cannot approve accounts, while
// "Require account approval" is on. The client words it the same way
// (public/js/ui/nav.js DESK_APPROVAL_REASON).
const DESK_APPROVAL_REQUIRED = "New accounts wait for approval on this platform, and your role cannot approve them, so an account made at the desk could not sign in. Use Invite instead (they then wait for approval), or ask an administrator.";
function _deskApprovalWithheld(req) { return getRequireAccountApproval() && !_actorMayApproveNow(req); }
// v8.12.7 — the same rule for the event-admin "name an event" refusal, which
// since this release is also re-asked inside the write (an admin narrowed to
// event admin while the account was being prepared).
const DESK_EVENT_REQUIRED = "Choose which of your events this person is joining — an account created without one would not appear in your participants list.";

/**
 * The desk duplicate-email refusal names the remedy that works for THAT account,
 * as the desk reveal's own gate (`_codeBlockedReason`) sees it: never signed in →
 * Show sign-in code; signed in before → Email sign-in code; an admin → sign in
 * themselves; waiting for approval or unverified → approve (or verify) first;
 * blocked or denied → reverse that first. An address held only as a secondary, or
 * reserved by a pending change, has no account to act on and says so. An
 * instruction that is not true is worse than none.
 *
 * Admin-gated with no enumeration surface (unlike the public code endpoints), so
 * naming the account's state discloses nothing a listing does not.
 */
function _deskDuplicateRemedy(email) {
  const existing = db.prepare(
    "SELECT role, approved, verified, blocked, denied_at, login_time, last_login_time FROM users WHERE email=? COLLATE NOCASE"
  ).get(email);
  const opener = "Someone already has that email address.";
  // v9.0.0 — an address held only as somebody's SECONDARY signs nobody in, so
  // pointing at that account's desk code would send the walk-up to type an
  // address that never works: say what the address is instead.
  if (!existing && db.prepare("SELECT 1 FROM users WHERE secondary_email=? COLLATE NOCASE").get(email)) {
    return `${opener} It is another account's secondary email, which never signs anyone in — ask the person for the address they sign in with, or use a different one.`;
  }
  // No committed row means the collision is another account's in-flight
  // `pending_email` reservation — real, but there is no account to act on yet.
  if (!existing) return `${opener} Another account is part-way through changing its address to it — wait for that to expire, or use a different address.`;
  switch (_codeBlockedReason(existing)) {
    case null:
      return `${opener} Find them in the list and use Show sign-in code instead.`;
    case "signed_in_before":
      return `${opener} They have signed in before, so find them in the list and use Email sign-in code: a code is shown at the desk only for an account that has never signed in.`;
    case "not_participant":
      return `${opener} It belongs to an admin account — ask them to sign in on the sign-in screen themselves (with their password, or Email me a code instead).`;
    case "not_approved":
      return existing.verified
        ? `${opener} That account is waiting for approval — approve it on their row, then use Show sign-in code.`
        : `${opener} That account is not verified or approved yet — a superadmin can Verify it, then approve it, and Show sign-in code will work.`;
    case "account_inactive":
      return `${opener} That account is blocked or denied — unblock or reverse the denial on their row before it can sign in at all.`;
    default:
      // An admin/superadmin account, or a condition this build has not learnt.
      return `${opener} It belongs to an account that cannot use a sign-in code — find it in the list to see what state it is in.`;
  }
}

/**
 * A free nickname derived from the address, so the desk types one field.
 *
 * v8.1.7 — SYNCHRONOUS, and called from inside the create transaction. The body
 * was always synchronous (better-sqlite3 is), but being declared `async` put an
 * await between the probe and the INSERT, which is the only thing that made a
 * collision possible at all.
 */
function _deskInviteNickname(email) {
  const base = (email.split("@")[0] || "guest").replace(/[^a-z0-9_]/gi, "").slice(0, 24).toLowerCase() || "guest";
  let candidate = base.length >= 3 ? base : `${base}usr`;
  for (let i = 0; i < 50; i++) {
    if (!db.prepare("SELECT 1 FROM users WHERE nickname=? COLLATE NOCASE").get(candidate)) return candidate;
    candidate = `${base}${require("node:crypto").randomInt(10000)}`;
  }
  return `${base}${Date.now().toString(36)}`;
}

app.post("/api/admin/participants/:id/unlock", requireAdmin, csrfProtection, async (req, res) => {
  // v7.21.32 — failed_login_count / failed_login_first are SELECTed because the
  // audit emit below reports what was actually cleared. Without them the fix read
  // undefined and emitted nothing, which is the very gap it exists to close.
  const user = db.prepare("SELECT id, role, locked_until, email, secondary_email, first_name, nickname, failed_login_count, failed_login_first FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.7.0 — clearing a lockout is an account-wide credential action, so it is
  // limited to participants the actor already sees.
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });

  const targetRole = user.role || "participant";
  if (_privilegedTarget(req, targetRole)) {
    return res.status(403).json({ error: "Only superadmins can unlock admin or superadmin accounts." });
  }
  const wasLocked = isLockedNow(user);
  const adminId = getAdminIdentity(req);
  const unlockTxn = db.transaction(() => {
    const r = clearLockout(user.id);
    // v7.21.32 — emit on what the statement actually CLEARED, not on wasLocked.
    // The failed-login counter is durable account state, not in-process
    // bookkeeping, so an admin zeroing it before the lockout could fire — nine
    // failures then a reset, repeatedly — used to leave the trail completely
    // empty. A genuine no-op still emits nothing.
    const cleared = user.failed_login_count || 0;
    if (r.changes > 0 && (wasLocked || cleared > 0 || user.locked_until || user.failed_login_first)) {
      recordUserEvent(user.id, "unlocked", adminId, {
        was_locked: wasLocked, cleared_failed_logins: cleared, ...reqContext(req),
      });
    }
  });
  runTxnWithMirrorBuffer(() => unlockTxn());
  if (wasLocked) invalidateAdminParticipantsCache();
  _invalidateMeCache(req.params.id);
  // sendUnlockEmail now reports delivery so the admin sees whether SMTP
  // actually accepted the message. Prior fire-and-forget call silently
  // swallowed ECONNREFUSED while the UI promised the user was notified.
  // Bounded like the approval's mail, for the same reason.
  let emailDelivered = null;
  if (wasLocked) {
    const unlockMail = sendUnlockEmail(user, req);
    emailDelivered = await awaitDeliveryWithDeadline(unlockMail, EMAIL_FANOUT_DEADLINE_MS, "participants:unlock-mail");
  }
  res.json({ ok: true, ...(wasLocked ? { emailDelivered, ...(emailDelivered === null ? { emailDeferred: true } : {}) } : {}) });
});

// "Email sign-in code" — the admin row action that replaced Reset Password. It
// mints an EMAILED code exactly as POST /api/auth/code/request would, on the
// participant's behalf, to the account's PRIMARY address: the admin learns
// nothing and holds nothing (contrast the desk reveal, which hands the code to
// the admin's screen). Same eligibility, re-send suppression and account send
// cap as the public door (not its per-origin share), so it cannot be used to
// flood an inbox; routes/auth.js `_sendSignInCode` is that door's copy. A regular admin may not
// send one to a privileged account (the peer-admin rule). Unlike the public
// door it REPORTS DELIVERY — an admin door has nobody to hide the answer from —
// waiting at most EMAIL_FANOUT_DEADLINE_MS: `sent:false, reason:"send_failed"`
// lifts the re-send suppression so a retry mints at once, and a send still
// queued at the deadline answers `deferred:true` and finishes detached.
app.post("/api/admin/participants/:id/login-code/email", requireAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });
  const targetRole = user.role || "participant";
  if (_privilegedTarget(req, targetRole)) {
    return res.status(403).json({ error: "Only superadmins can email a sign-in code to an admin or superadmin account." });
  }
  if (!isCodeEligible(user)) {
    return res.status(409).json({
      error: user.denied_at
        ? "User has been denied — reverse the denial via Approve before emailing a sign-in code."
        : "User is blocked — unblock them before emailing a sign-in code.",
      code: "account_inactive",
    });
  }
  if (codeRecentlySent(user)) {
    return res.json({ ok: true, sent: false, reason: "recently_sent",
      message: "A sign-in code was emailed to this account less than two minutes ago — ask them to check their inbox." });
  }
  // A live DESK code is never replaced from here either: whoever was shown it is
  // typing it (lib/login-code.js `deskCodeLive`, the entry screen's own rule).
  if (deskCodeLive(user)) {
    return res.json({ ok: true, sent: false, reason: "desk_code_live",
      message: "A sign-in code shown at the desk for this account is still live — ask them to type it. Once it expires you can email one." });
  }
  // The desk alternative is named only where the desk can use it (the desk
  // ladder: an approved participant who has never signed in).
  const _deskAlt = _codeBlockedReason(user) === null
    ? "Use Show sign-in code at the desk, or try again in a few minutes."
    : "Try again in a few minutes.";
  const issued = issueCode(user, CODE_VIA_EMAIL, null, { mintedTo: user.email });
  if (!issued) {
    return res.json({ ok: true, sent: false, reason: "send_cap_reached",
      message: `This account has been sent the maximum number of codes for now. ${_deskAlt}` });
  }
  const adminId = getAdminIdentity(req);
  try { recordUserEvent(user.id, "login_code_requested", adminId, { ...reqContext(req), via: "admin_email", reissued: !!issued.reissued }); } catch (e) { swallowed("participants:code-requested-audit", e); }
  const _ctx = reqContext(req);
  const delivered = await awaitDeliveryWithDeadline(sendLoginCodeEmail(user, issued, { to: user.email }).catch(err => {
    log.error({ ..._ctx, err: err && err.message ? err.message : String(err) }, "sendLoginCodeEmail(admin) rejected");
    return false;
  }), EMAIL_FANOUT_DEADLINE_MS);
  if (delivered === false) {
    liftResendSuppression(user.id, issued.code);
    return res.json({ ok: true, sent: false, reason: "send_failed",
      message: `The sign-in code email to ${user.email} could not be sent. ${_deskAlt}` });
  }
  if (delivered === null) {
    return res.json({ ok: true, sent: true, deferred: true,
      message: `The sign-in code email to ${user.email} is still being sent — ask them to check their inbox in a minute.` });
  }
  res.json({ ok: true, sent: true, message: `A sign-in code was emailed to ${user.email}.` });
});

app.put("/api/admin/participants/:id", requireAdmin, csrfProtection, async (req, res) => {
  // v6.16.7 — _invalidateMeCache moved to AFTER the profile txn.
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.7.0 — a profile edit changes the person's identity on every event they
  // are in, and can stage an email change, so it is refused before any
  // validation, any avatar row and the write transaction.
  const _paDenied = participantDenied(req, req.params.id);
  if (_paDenied) return res.status(403).json({ error: _paDenied.message, code: _paDenied.code });
  const { firstName, lastName, nickname, company, title, email, secondaryEmail, country, timezone, linkedinUrl, jobFunction, city, personalTitle, phone, avatar,
    // v8.3.37 — THE CERTIFICATE NAME WAS RENDERED, EDITED, SENT AND DISCARDED.
    // The shared form renders both fields for this dialog, `_PARTICIPANT_ROW_COLUMNS`
    // selects them so they arrive pre-filled, they are in the dirty snapshot, the
    // client sent them on every save — and this handler named them nowhere, so the
    // save reported success and stored nothing. A control that appears to work.
    // Found while making the body sparse, which is what made the omission visible:
    // the keys are now sent only when an admin actually edits them.
    certificateGivenName, certificateFamilyName } = req.body;
  // ext-audit batch 4 — reject a non-string body field before fillRequired/
  // fillOptional call .trim() on it (which would 500). Clean 400 instead.
  const _nonStr = _firstNonStringField(req.body, ["firstName", "lastName", "nickname", "company", "title", "email", "secondaryEmail", "country", "timezone", "linkedinUrl", "jobFunction", "city", "personalTitle", "phone", "avatar",
    "certificateGivenName", "certificateFamilyName"]);
  if (_nonStr) return res.status(400).json({ error: `${_nonStr} must be text` });
  const capHit = _capsOk({
    first_name: firstName, last_name: lastName, nickname, company, title, country,
    personal_title: personalTitle, phone,
    job_function: jobFunction, city, secondary_email: secondaryEmail, linkedin_url: linkedinUrl,
  });
  if (capHit) return res.status(400).json({ error: `${capHit.field} must be at most ${capHit.max} characters.` });
  const isSA = !!req.session.isSuperAdmin;
  // A privileged target (lib/rbac.js `privilegedTargetFor`: an unscoped role,
  // built-in or custom, or one holding a permission this actor lacks) is a
  // superadmin's to edit. The attack chain this closes: stage the target's
  // primary address to a mailbox the actor reads, confirm it with the code
  // mailed there (/confirm-email), then sign in as the target with an emailed
  // code — every account signs in by its primary address. Only superadmins can
  // touch a privileged account; support of participants stays possible.
  const targetRole = user.role || "participant";
  const targetIsPrivileged = _privilegedTarget(req, targetRole);
  if (targetIsPrivileged && !isSA) {
    return res.status(403).json({ error: "Only superadmins can edit admin or superadmin accounts." });
  }
  // A control character is refused outright, never silently kept like a value
  // the actor may not change (lib/util.js profileTextOk).
  {
    const ctl = profileTextControlField({ first_name: firstName, last_name: lastName, company, title,
      personal_title: personalTitle, phone, job_function: jobFunction, city, country,
      certificate_given_name: certificateGivenName, certificate_family_name: certificateFamilyName });
    if (ctl) return res.status(400).json(profileTextControlBody(ctl));
  }
  // Superadmin can overwrite any field; regular admin can only fill blank fields
  const fillRequired = (current, incoming) => current && !isSA ? current : (incoming?.trim() || current);
  const fillOptional = (current, incoming) => current && !isSA ? current : (incoming !== undefined ? (incoming?.trim() || null) : current);
  const newFirst = fillRequired(user.first_name, firstName);
  const newLast = fillRequired(user.last_name, lastName);
  const newNick = fillRequired(user.nickname, nickname);
  // Mandatory too (see above) — never clearable by an admin save.
  const newCompany = fillRequired(user.company, company);
  const newTitle = fillRequired(user.title, title);
  const newPersonalTitle = fillOptional(user.personal_title, personalTitle);
  const newPhone = fillOptional(user.phone, phone);
  // Email policy: superadmin can change both slots on any target. Regular
  // admins can change both slots on non-privileged (participant) targets;
  // any attempt to touch email fields on admin/superadmin targets already
  // 403'd above. Admin support of normal participants is the routine use
  // case (a user emails asking "please change my primary to the new
  // address") and blocking it for regular admins is over-restrictive.
  const canEditEmail = isSA || !targetIsPrivileged;
  // v6.16.22 — NFC-normalise so encoding variants collide on uniqueness.
  const newEmail = canEditEmail ? (email ? normaliseEmail(email) : user.email) : user.email;
  const newSecondary = canEditEmail
    ? (secondaryEmail !== undefined ? (secondaryEmail ? normaliseEmail(secondaryEmail) : null) : user.secondary_email)
    : user.secondary_email;
  // THE RIVAL DOOR ON THE ADDRESSES (lib/staff-compete.js competitorRivalDenied).
  // The profile stays editable for a rival, but moving either address is an
  // account door: a primary staged to a mailbox the actor reads is confirmed by
  // its code and then signs in as the rival. Refused for every tier, before any
  // other check reads the new value; an echo of the stored addresses passes.
  const _secondaryMoves = String(newSecondary || "").toLowerCase() !== String(user.secondary_email || "").toLowerCase();
  if (_adminStagesPrimary(user, newEmail) || _secondaryMoves) {
    const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id));
    if (_cmp) return _cmp;
  }
  // v7.15.8 (user-field audit) — these four are MANDATORY profile fields, so they
  // take fillRequired, not fillOptional. fillOptional maps an empty incoming
  // value to NULL for a superadmin, which silently WIPED a required field: an
  // admin who opened a profile and saved could null job_function / city, and the
  // participant was then thrown into the non-dismissible profile-completion gate
  // on their next entry ("it told me the city was missing, but it was filled").
  // PUT /api/me has always refused to clear these (400 on an empty string); the
  // admin path must not be the back door that does it silently. fillRequired
  // keeps the current value when the incoming one is blank, so an admin can
  // still CHANGE them — just never erase them.
  const newCountry = fillRequired(user.country, country);
  const newTimezone = fillRequired(user.timezone, timezone);
  // ext-audit v7.21.1 (A7) — fillRequired blocks whitespace (it trims and falls
  // back), but nothing checked the zone was REAL. An admin could store
  // timezone:"Nowhere", and this row's timezone is later fed to Intl by
  // formatEmailDate when the platform mails that participant — so the throw
  // lands in a background email send, far from the admin who caused it.
  if (newTimezone && !isValidTimezone(newTimezone))
    return res.status(400).json({ error: "Please select a valid timezone." });
  const newJobFunction = fillRequired(user.job_function, jobFunction);
  const newCity = fillRequired(user.city, city);
  // A non-empty LinkedIn URL must validate as http:// or https://.
  const _adminCandidateLinkedin = fillOptional(user.linkedin_url, linkedinUrl);
  if (_adminCandidateLinkedin && _adminCandidateLinkedin.trim() && !validateUrl(_adminCandidateLinkedin))
    return res.status(400).json({ error: "LinkedIn URL must be a valid http:// or https:// URL." });
  const newLinkedin = validateUrl(_adminCandidateLinkedin);
  // v7.21.26 — the avatar, under the SAME fill-a-blank-field doctrine as every
  // other field on this route. `default1` is the avatar's unset state, so a
  // regular admin may set one where the participant never chose one and only a
  // superadmin may replace a chosen one; an incoming value they may not apply is
  // silently kept, exactly as fillRequired/fillOptional keep a populated field.
  //
  // Validate here but PERSIST after every other check has passed — the same
  // reason PUT /api/me does: an image row inserted before a nickname/email
  // rejection is a ~256 KB blob leaked outside any transaction, with nothing to
  // roll it back.
  let _pendingAvatar = null;
  let newAvatar = user.avatar;
  const avatarUnset = !user.avatar || user.avatar === "default1";
  if (avatar !== undefined && avatar !== null && avatar !== "" && (isSA || avatarUnset)) {
    if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
      _pendingAvatar = validateAvatarDataUri(avatar);
      if (!_pendingAvatar) return res.status(400).json({ error: "Avatar image rejected: unsupported format or exceeds 256 KB size limit." });
      newAvatar = null;                      // resolved to a real ref at persist time
    } else {
      // The TARGET's own current picture only (lib/sanitise.js sanitiseAvatar:
      // `current`); any other stored picture is refused like a dead ref.
      newAvatar = sanitiseAvatar(avatar, { current: user.avatar });
      if (newAvatar === null) return res.status(400).json({ error: "Avatar image rejected: unsupported format or exceeds 256 KB size limit." });
      // v8.3.34 — `undefined` means the ref named no image row (a stale value
      // from a dialog opened before another writer replaced the avatar). Keep
      // what the row already has: writing the dead ref would leave a dangling
      // avatar AND make the reclaim below delete the live blob.
      if (newAvatar === undefined) newAvatar = user.avatar;
    }
  }
  // Validate nickname if changed
  if (newNick !== user.nickname && newNick.length < 3)
    return res.status(400).json({ error: "Nickname must be at least 3 characters" });
  if (newNick !== user.nickname && !_nicknameCharsOk(newNick))
    return res.status(400).json({ error: NICKNAME_CHARSET_ERROR });
  if (newNick !== user.nickname && db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE AND id!=?").get(newNick, user.id))
    return res.status(409).json({ error: "Nickname already taken" });
  // Reject malformed primary/secondary up front — but ONLY when the value
  // actually changes (audit v7.7.32, mirroring the nickname-when-changed carve-out
  // above + the self-edit path). isValidEmailFormat now rejects non-ASCII
  // (v7.7.12), but legacy accounts (v7.2.x–v7.7.11) may carry a Unicode address;
  // re-validating an unchanged stored value would 400 and block the admin from
  // filling any blank field on that account. A CHANGED address still validates.
  if (newEmail !== user.email && !isValidEmailFormat(newEmail))
    return res.status(400).json({ error: "Please enter a valid email address." });
  if (newSecondary && newSecondary !== user.secondary_email && !isValidEmailFormat(newSecondary))
    return res.status(400).json({ error: "Please enter a valid secondary email address." });
  if (newEmail !== user.email && emailIsTaken(newEmail, user.id))
    return res.status(409).json({ error: "Email already registered" });
  if (newSecondary && emailIsTaken(newSecondary, user.id))
    return res.status(409).json({ error: "This secondary email is already in use by another account." });
  if (sameSlotEmails(newEmail, newSecondary))
    return res.status(400).json({ error: "Primary and secondary email must be different." });
  // v8.3.36 — THE SECOND PAIR, and it only becomes reachable once the primary is
  // STAGED. The new secondary applies IMMEDIATELY while the new primary waits
  // for confirmation, so the pair that is live between save and confirm is
  // (CURRENT primary, NEW secondary). An admin swapping the two addresses would
  // otherwise commit primary == secondary — a state neither per-column NOCASE
  // index can see, and which then 400s every subsequent profile save. This is
  // routes/participant.js's v7.7.37 (C5) clause, which the admin door needs for
  // the same reason the self door does.
  if (_adminStagesPrimary(user, newEmail) && sameSlotEmails(user.email, newSecondary))
    return res.status(400).json({ error: "That secondary email is the participant's current primary — the primary change is not confirmed yet, so the two would collide." });
  // "At least one company email" — mirrors registration and self-edit.
  // Regular admins MUST honour the rule; a superadmin can still save a
  // two-free-email state because their whole role is to override (support
  // exceptions, VIP accounts, migrated users). The bypass is recorded in the
  // audit event so it is visible rather than silent.
  // v8.3.36 — validate the state that is LIVE between save and confirm as well as
  // the one that exists after it. A staged primary does not take effect, so the
  // active pair is (current primary, new secondary); the post-confirm pair is
  // (new primary, new secondary). The self path has made this distinction since
  // v7.5.0 and the admin path needs it for the same reason: neither the live
  // account nor the future one may end up with two free addresses.
  const _activePrimaryAdmin = _adminStagesPrimary(user, newEmail) ? (user.email || "") : (newEmail || "");
  const secondaryFreeAdmin = newSecondary ? isFreeEmail(newSecondary) : true;
  const primaryFreeAdmin = isFreeEmail(newEmail || "");
  const violatesCompanyRule = (isFreeEmail(_activePrimaryAdmin) && secondaryFreeAdmin)
    || (primaryFreeAdmin && secondaryFreeAdmin);
  if (violatesCompanyRule && !isSA) {
    return res.status(400).json({ error: "At least one email address must be a company email, not a free email service." });
  }
  // v8.3.37 — the certificate name, through the SAME two-tier rule every other
  // optional field on this route uses: a regular admin may fill a blank one, a
  // superadmin may replace it, and "" clears it.
  //
  // DECLARED HERE, above the diff block that reads it. `const` is in the
  // temporal dead zone until its declaration, and `node --check` cannot see a
  // read-before-declare — it surfaces as a 500 from a route that was working,
  // which is exactly how v8.1.0 (PR 20) paid for this twice.
  const newCertGiven = fillOptional(user.certificate_given_name, certificateGivenName);
  const newCertFamily = fillOptional(user.certificate_family_name, certificateFamilyName);

  // Compute what actually changed for the event details
  const profileChanges = {};
  const diff = (k, oldV, newV) => { if ((oldV || null) !== (newV || null)) profileChanges[k] = { from: oldV || null, to: newV || null }; };
  diff("first_name", user.first_name, newFirst);
  diff("last_name", user.last_name, newLast);
  diff("nickname", user.nickname, newNick);
  diff("company", user.company, newCompany);
  diff("title", user.title, newTitle);
  diff("personal_title", user.personal_title, newPersonalTitle);
  diff("phone", user.phone, newPhone);
  // v8.3.36 — `email` is NO LONGER a committed change on this route: the primary
  // is staged, not applied, so recording it in `profileChanges` would put a
  // `from`/`to` on the `edited` event for a column this request does not write.
  // The stage gets its own event (`email_change_requested`) below, exactly as
  // the self path does.
  diff("secondary_email", user.secondary_email, newSecondary);
  diff("country", user.country, newCountry);
  diff("timezone", user.timezone, newTimezone);
  diff("job_function", user.job_function, newJobFunction);
  diff("city", user.city, newCity);
  diff("linkedin_url", user.linkedin_url, newLinkedin);
  diff("certificate_given_name", user.certificate_given_name, newCertGiven);
  diff("certificate_family_name", user.certificate_family_name, newCertFamily);
  if (_pendingAvatar) newAvatar = persistAvatar(_pendingAvatar);
  diff("avatar", user.avatar, newAvatar);
  const adminId = getAdminIdentity(req);

  // v6.16.5 — admin-changed primary email triggers re-verification +
  // SMTP rollback, mirroring the self-edit contract at PUT /api/me.
  // Pre-fix the admin path wrote `email=newEmail` directly — a
  // typo'd address was silently saved and every subsequent mailout
  // (verification reset, password reset, reminders, account-denied)
  // went to a non-existent inbox until the operator noticed. The
  // self-edit contract is symmetrical: the user must prove ownership
  // of the new address before the platform trusts it. Admin-driven
  // edits are no different in that respect; a confirmation round-trip
  // is the cheapest defence against the typo class. Bulk migrations
  // that intentionally bypass re-verification can use the import
  // endpoint (which writes verified=1 directly).
  const adminEmailChanged = (newEmail || "").toLowerCase() !== (user.email || "").toLowerCase();
  // v8.3.36 — a PENDING code, not a verify code. The mail now points at
  // `/confirm-email`, which owns the swap; `/verify` is for proving an address
  // already on the row.
  const _adminPendingCode = adminEmailChanged ? uuid() : null;
  const _adminPendingAt = adminEmailChanged ? now().toISOString() : null;
  // ── optimistic concurrency on the PROFILE fields ────────────────────────────
  //
  // The dialog echoes the `updated_at` it was rendered from. Read as a STRING or
  // not at all — every other body field here is type-guarded before it reaches a
  // bind (`_firstNonStringField` above), and an array would otherwise be SPREAD
  // by better-sqlite3 as positional bindings.
  //
  // Absent means UNCHECKED, the `competitions` back-compat arm: a scripted
  // caller and every existing test keep working, and only a client that opts in
  // gets the 409.
  const _expUpd = (typeof req.body?.expectedUpdatedAt === "string" && req.body.expectedUpdatedAt)
    ? req.body.expectedUpdatedAt : null;
  const _newUpdatedAt = now().toISOString();

  const profileTxn = db.transaction(() => {
    // v8.3.36 — `email` is NOT in this statement any more. An admin primary
    // change is STAGED below and committed by /confirm-email; every other field,
    // the secondary included, still applies at once.
    //
    // A COMPARE-AND-SWAP, and the transaction's FIRST statement. The
    // pre-transaction shape `routes/competitions.js` uses is refused here for
    // the reason documented at line ~483 of this very file: a value re-read
    // outside the write can move between the check and the write, so the guard
    // fails OPEN and the second writer wins silently — which is the defect. `IS`
    // rather than `=`, so a row whose `updated_at` is NULL (one the backfill
    // could not reach) is not refused for ever by an unknown comparison; the
    // `? IS NULL` arm is the unchecked/back-compat path.
    const _swapped = db.prepare(`UPDATE users SET first_name=?, last_name=?, nickname=?, company=?, title=?, personal_title=?, phone=?, job_function=?, city=?, secondary_email=?, country=?, timezone=?, linkedin_url=?, avatar=?, certificate_given_name=?, certificate_family_name=?, updated_at=? WHERE id=? AND (? IS NULL OR ${profileVersionSql()} IS ?)`)
      .run(newFirst, newLast, newNick, newCompany, newTitle, newPersonalTitle, newPhone, newJobFunction||null, newCity||null, newSecondary, newCountry, newTimezone, newLinkedin, newAvatar, newCertGiven, newCertFamily, _newUpdatedAt, user.id, _expUpd, _expUpd);
    // better-sqlite3 rolls back on a throw, so the staged email write, the
    // credential revocation and the `edited` audit event below cannot land
    // either — a refused save leaves no trace of a half-success.
    if (_swapped.changes === 0) throw new StaleRowError(_expUpd);
    if (adminEmailChanged) {
      // ══════════════════════════════════════════════════════════════════════
      // v8.3.36 — STAGED, NOT APPLIED. This is the redesign v8.3.34 named and
      // deferred, and it deletes the defect rather than reporting it.
      //
      // What it replaces: the handler used to commit `email=<new>, verified=0`
      // and a fresh verify_code, THEN await SMTP, then compensate on failure.
      // `verified=0` is read by two things that act durably —
      // `requireParticipant`, which DESTROYS the session of an unverified
      // participant (and the SPA polls every 15 s), and
      // `ACTIVE_PARTICIPANT_SQL`, which drops them from the scoring set so a
      // submit landing in the window could AUTO-END the competition. A
      // compensating UPDATE can restore a column; it cannot restore a deleted
      // session row or reopen an ended event.
      //
      // Staging removes the window by having nothing to roll back. The live
      // `email`, `verified` state and session are untouched until the
      // participant clicks a link sent to the NEW address, and /confirm-email —
      // which already owns the swap, its re-checks and its revocations — does
      // the rest. `PUT /api/me` has worked this way since v7.5.0; this is a
      // convergence onto it, not a new mechanism.
      //
      // ALL THREE COLUMNS, ATOMICALLY, WITH A FRESH CODE. /confirm-email
      // resolves the row BY the code, so writing `pending_email` while leaving
      // an older `pending_email_code` in place would let a participant's stale
      // link resolve and commit the ADMIN's address under a mail describing a
      // different one.
      //
      // It deliberately OVERWRITES a participant's own staged change rather
      // than voiding it separately: there is one pending slot, the admin's is
      // the newer instruction, and the participant's already-mailed link
      // carries the old code and simply stops resolving. The v7.5.0 hazard this
      // replaces — a stale self-link reverting a COMMITTED admin correction —
      // is now impossible by construction, because nothing is committed.
      db.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
        .run(newEmail, _adminPendingCode, _adminPendingAt, user.id);
    }
    // NOTE (v8.3.36): there is deliberately NO `else if (user.pending_email)`
    // cancel branch here, unlike `PUT /api/me`. The admin dialog pre-fills the
    // CURRENT address, so every unrelated admin save would otherwise cancel a
    // correction that is already in flight — the exact defect v8.3.34 recorded
    // for the participant's own dialog, newly created on the door where the
    // operator has no cancel affordance and, until this release, no way even to
    // SEE that a change was pending. An admin cancels by staging a different
    // address, or by letting the 48 h code expire.
    // NO ADDRESS EDIT HERE REVOKES THE LIVE SIGN-IN CODE. A code is mailed to the
    // PRIMARY address and redeemed against it only, so a SECONDARY change
    // protects nothing by clearing it and would destroy a code the person may be
    // typing; the primary is only STAGED here, and /confirm-email clears the code
    // in the same UPDATE that swaps the address.
    //
    // STATED RATHER THAN IMPLIED, because it is a real change of capability: an
    // email edit is a CORRECTION, not a compromise response. It does not take
    // an account away from whoever holds the old mailbox, because the old
    // mailbox stays the account's address until the participant confirms. The
    // control that DOES act immediately is Block.
    if (Object.keys(profileChanges).length) {
      const evDetails = { changes: profileChanges };
      // Superadmin bypass of the company-email rule is legal but auditable.
      if (violatesCompanyRule && isSA) evDetails.bypassed_free_email_rule = true;
      // v8.3.36 — `verification_reset` is gone with the write it described: this
      // route no longer clears `verified`. The stage has its own event below.
      recordUserEvent(user.id, "edited", adminId, { ...evDetails, ...reqContext(req) });
    }
  });
  try {
    runTxnWithMirrorBuffer(() => profileTxn());
  } catch (e) {
    // The image row is inserted before the transaction (it must exist for the
    // UPDATE to reference it), so a failed save has to hand it back.
    if (_pendingAvatar && newAvatar) { try { deleteAvatarImage(newAvatar); } catch (avatarErr) { swallowed("participants:reclaim-pending-avatar", avatarErr); } }
    if (e instanceof StaleRowError) {
      // Re-read AFTER the rollback: `user.updated_at` was read at the top of the
      // handler and is by definition the value that just lost, so handing it
      // back would send the dialog round the same 409.
      const _cur = db.prepare(`SELECT ${profileVersionSql()} AS updated_at FROM users WHERE id=?`).get(req.params.id);
      return res.status(409).json({
        error: "This profile was modified since you opened it. Reload to see the latest values, then retry.",
        conflict: true,
        currentUpdatedAt: _cur?.updated_at || null,
      });
    }
    throw e;
  }
  // Reclaim the replaced image once the new one is committed.
  if (newAvatar !== user.avatar) { try { deleteAvatarImage(user.avatar); } catch (e) { swallowed("participants:reclaim-replaced-avatar", e); } }
  _invalidateMeCache(req.params.id);
  // v8.3.36 — the leaderboard bust is GONE with the write that needed it. It
  // existed because the txn flipped `verified=0` and the board filters on
  // `u.verified=1`, so the participant had to drop off immediately. Staging
  // changes no board input at all; /confirm-email busts the boards when the swap
  // actually lands. `_invalidateMeCache` stays — `GET /api/me` publishes
  // `pending_email`, so the note the participant sees must not be 2 s stale.
  // UNCONDITIONAL, because the version bump is. The transaction stamps
  // `updated_at` on every save that commits — including one whose fields all
  // happened to match — and that column now rides `_PARTICIPANT_ROW_COLUMNS`, so
  // leaving the bust behind `profileChanges` would let the 5 s list cache serve
  // a stale fingerprint to the NEXT dialog, which would then be 409'd on a save
  // that had no real conflict. That is the fail-open shape line ~483 of this
  // file documents, reached through the cache instead of through a re-read.
  invalidateAdminParticipantsCache();

  // v8.3.36 — THE STAGE IS A STATE CHANGE AND GETS ITS OWN EVENT. `email` is no
  // longer in `profileChanges`, so on an email-only save the `edited` event
  // above does not fire — and a state-changing admin action with no audit row
  // breaks the v7.21.32 standing rule. Same event name and shape the self path
  // uses, attributed to the ACTING ADMIN so the participant's History
  // distinguishes an organiser's correction from their own request.
  if (adminEmailChanged) {
    try {
      recordUserEvent(user.id, "email_change_requested", adminId, {
        ...reqContext(req), pending_email: newEmail, via: "admin_edit",
        ...(user.pending_email && user.pending_email !== newEmail
          ? { superseded_pending: user.pending_email } : {}),
      });
    } catch (e) { swallowed("participants:admin-email-change-audit", e); }
  }

  // SMTP send — mirrors PUT /api/me's contract exactly, which after v8.3.36 it
  // finally can: async I/O lives outside the writer txn (a better-sqlite3
  // transaction is synchronous and cannot span an await at all), and because the txn committed only a
  // PENDING there is nothing for a failure to undo.
  if (adminEmailChanged) {
    const baseUrl = BASE_URL;
    const platformName = getPlatformName();
    const link = `${baseUrl}/confirm-email?code=${encodeURIComponent(_adminPendingCode)}`;
    const { html, text } = buildEmail(platformName, {
      greeting: newFirst || user.first_name || user.nickname,
      body: `<p>An organiser has asked to change the email address on your ${escapeHtml(platformName)} account to this one. Open the link below to confirm it. Until you do, your existing email address and access are unchanged. This link will expire in 48 hours.</p>`,
      linkUrl: link, linkText: "Confirm New Email Address",
      fallbackNote: "If you did not expect this, you can ignore this email — nothing changes unless you confirm, and you can contact your event organiser.",
    });
    // Test-only: park the handler between the commit and the send. It used to
    // exist to prove the window HURT; it now proves the window is HARMLESS —
    // a participant polling mid-flight stays signed in and stays verified.
    if (process.env.NODE_ENV === "test") {
      const d = testAdminEmailDelay();
      if (d > 0) await new Promise(r => setTimeout(r, d));
    }
    // Bounded like every single-mail admin door: `null` is still queued.
    const delivered = await awaitDeliveryWithDeadline(sendEmailLogged(user.id, { to: newEmail, subject: `${platformName} — Confirm Your New Email Address`, html, text }, "admin_email_change_verification", { competitionId: null }), EMAIL_FANOUT_DEADLINE_MS, "participants:email-change-mail");
    // v8.3.36 — NO ROLLBACK, AND NO 503. The pending stays staged whatever SMTP
    // did, on the self path's own reasoning: there is no lockout risk because
    // the live account is untouched, and an undelivered pending simply expires
    // in 48 h. Retrying is a re-save; abandoning it costs nothing. Everything
    // this branch used to carry — the compensating UPDATE, the
    // `email_change_reverted` event, the session-loss report v8.3.34 added, the
    // 503 — described a provisional commit that no longer happens.
    return res.json({
      ok: true,
      emailChanged: false,
      emailChangePending: true,
      pendingEmail: newEmail,
      emailDelivered: delivered,
      ...(delivered === null ? { emailDeferred: true } : {}),
      message: delivered === null
        ? `The change to ${newEmail} is staged and the confirmation email is still being sent. Their current email stays active until they confirm.`
        : delivered
        ? `A confirmation link was sent to ${newEmail}. Their current email stays active until they confirm.`
        : `The change to ${newEmail} is staged, but the confirmation email could not be delivered. Their current email stays active — check SMTP and save again, or the staged change expires in 48 hours.`,
    });
  }
  res.json({ ok: true });
});

app.delete("/api/admin/participants/:id", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  // v6.16.7 — _invalidateMeCache moved to AFTER the delete txn.
  // v6.9.24: block self-delete. A superadmin mid-session hitting
  // "Delete me" would vaporize their own record, their session row,
  // and every audit trail they're the `changed_by` on. If they've
  // genuinely meant to step down, role-change to `participant` is
  // the right path (keeps audit lineage intact) — self-delete is
  // never the right action for the operator on the seat.
  if (req.session.userId === req.params.id) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }
  const user = db.prepare("SELECT id, email, nickname, role, active_competition_id FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // v8.12.0 — THE RIVAL DOOR (lib/staff-compete.js competitorRivalDenied): a
  // competitor may not act on the account of somebody on the board they compete
  // on. Asked right after the 404, ABOVE the scope and peer-admin gates, so every
  // tier hears the same reason for the same act (the competition doors' order).
  { const _cmp = refuseCompetitor(res, competitorRivalDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // A PRIVILEGED TARGET is a superadmin's to delete (lib/rbac.js
  // privilegedTargetFor, the predicate every peer door asks): a custom role
  // holding participants.delete may not delete an admin, a superadmin or any
  // account whose role can do more than its own. A superadmin is never refused.
  if (_privilegedTarget(req, user.role)) {
    return res.status(403).json({ error: "Only superadmins can delete admin or superadmin accounts." });
  }
  // v7.21.20 — the live-competition guard is a SPEED BUMP for a superadmin, not
  // a wall.
  //
  // Reported as "the superadmin cannot delete this user": a participant who had
  // registered through a /join link and entered the live competition could not
  // be deleted at all from the admin's point of view. The refusal was correct
  // and its remedy (remove them from the competition, then delete) really works
  // — but the client discarded the message, so the admin saw a bare "Failed to
  // delete user." with no reason and nothing to act on.
  //
  // Surfacing the message is half the fix. The other half is this: the remedy is
  // a hunt — find the competition, find the participant inside it, remove them,
  // come back, delete — and during a live event the superadmin doing the cleanup
  // is the person least able to afford it. `force` lets them through in one
  // step, after a confirmation that names the competition. It is not a
  // relaxation of the rule: the route is already superadmin-only, the guard
  // still fires by default for everyone, and the override is recorded on the
  // audit event so the deletion of an actively-competing participant is never
  // indistinguishable from an ordinary one.
  const force = req.query.force === "1" || req.query.force === "true" || req.body?.force === true;
  let liveComp = null;
  let lateEntrantPlaying = false;
  if (user.active_competition_id) {
    const comp = getCompetition(user.active_competition_id);
    if (comp && competitionStatus(comp) === "live") liveComp = comp;
    // v8.12.6 — a LATE ENTRANT playing an ended event inside its late-entry window
    // is actively competing too: they are on its late board, submitting, and
    // deleting them takes their scores off it. The speed bump keyed on "live"
    // alone and deleted them with no warning.
    else if (comp && lateEntryStateFor(comp, user.id).canPlay) { liveComp = comp; lateEntrantPlaying = true; }
  }
  if (liveComp && !force) {
    // v8.12.6 (review) — "Remove them from the event first" is a remedy only if the
    // removal would be accepted. A late entrant the window's removal rule refuses
    // is playing (so this fires) and NOT removable, so for them the gentler option
    // does not exist as it stands, and the refusal must not name it.
    // `removable: false` says so to the client, which otherwise offers it, and
    // `removalRefused` carries WHICH rule refused (the removal door's own code),
    // so each refusal states its own reason: one who had started playing before
    // the end is kept for good (`not_late_entrant`), one holding a placing
    // certificate only until it is revoked (`late_entrant_has_certificate`).
    const _lateRm = lateEntrantPlaying ? lateWindowRemovalDenied(liveComp, user.id, undefined, { codeOnly: true }) : null;
    const _lateWhy = !_lateRm ? null
      : _lateRm.code === "late_entrant_has_certificate"
        ? "They hold a placing certificate for it, so they can be removed from it only once that certificate is revoked"
        : _lateRm.code === "not_late_entrant"
          ? "They had started playing before it ended, so they cannot be removed from it instead"
          : "They cannot be removed from it instead";
    return res.status(400).json({
      error: lateEntrantPlaying
        ? (_lateWhy
          ? `Cannot delete a participant who is playing "${liveComp.name}" as a late entrant. ${_lateWhy}; confirm to delete them anyway.`
          : `Cannot delete a participant who is playing "${liveComp.name}" as a late entrant. Remove them from the event first, or confirm to delete them anyway.`)
        : `Cannot delete a participant who is actively competing in "${liveComp.name}". Remove them from the event first, or confirm to delete them anyway.`,
      // The client uses these to offer the one-step override rather than making
      // the admin go and find the competition themselves.
      code: "participant_in_live_competition",
      competitionId: liveComp.id,
      competitionName: liveComp.name,
      ...(lateEntrantPlaying ? { lateEntrant: true } : {}),
      ...(_lateRm ? { removable: false, removalRefused: _lateRm.code } : {}),
    });
  }
  const adminId = getAdminIdentity(req);
  const counts = {
    competition_memberships: db.prepare("SELECT COUNT(*) as c FROM competition_users WHERE user_id=?").get(req.params.id).c,
    hint_reveals: db.prepare("SELECT COUNT(*) as c FROM hint_reveals WHERE user_id=?").get(req.params.id).c,
    submissions: db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id=?").get(req.params.id).c,
    tags: db.prepare("SELECT COUNT(*) as c FROM user_tags WHERE user_id=?").get(req.params.id).c,
    user_events: db.prepare("SELECT COUNT(*) as c FROM user_events WHERE user_id=?").get(req.params.id).c,
    // v6.16.4 — pre-fix these three tables were orphaned on user-delete.
    // task_feedback (no FK), challenge_events (FK to tasks only), and
    // competition_user_absences (no FK; added in v6.12.0 with the
    // documented invariant "rows are never deleted") all kept the
    // user_id of a deleted user alive in their respective aggregates:
    // task_feedback rendered as NULL-name rows in the admin feedback
    // list; challenge_events kept counting the deleted participant in
    // analytics; absences distorted solveTimeMs if the UUID ever
    // recycled via import/restore. Cascaded counts captured for the
    // audit row so an operator can see exactly what was swept.
    task_feedback: db.prepare("SELECT COUNT(*) as c FROM task_feedback WHERE user_id=?").get(req.params.id).c,
    challenge_events: db.prepare("SELECT COUNT(*) as c FROM challenge_events WHERE user_id=?").get(req.params.id).c,
    competition_user_absences: db.prepare("SELECT COUNT(*) as c FROM competition_user_absences WHERE user_id=?").get(req.params.id).c,
  };
  // v7.6.0 — the full cascade + cache busts + session purge live in
  // lib/account-reaper.js's deleteUserCascade (shared with the unverified-account
  // reaper) so the two destructive paths can never drift apart.
  // v8.12.7 — the Checkmarx One counts (lib/cxone-ledger.js
  // `cxoneDeletionCounts`), read by the cascade BEFORE it deletes the history:
  // accounts scheduled for removal, MATCHED accounts left in place (the tenant's
  // administrator decides), CREATED accounts the ledger does not hold
  // (`cxone_accounts_unrecorded`: removed in the tenant by hand), and set-up
  // records that cannot be read (`cxone_records_unreadable`: someone checks the
  // tenant). Each only when non-zero, counts only. The reaper records the same.
  const { purgedSessions, cxoneCounts: _cxoneCounts } = deleteUserCascade(req.params.id);
  recordOrphanedAuditEvent("user", user.id, "deleted", adminId, {
    email: user.email,
    nickname: user.nickname,
    // v7.21.20 — a deletion that overrode the live-competition guard must be
    // distinguishable from an ordinary one in the trail.
    ...(liveComp ? { forced_from_live_competition: { id: liveComp.id, name: liveComp.name, ...(lateEntrantPlaying ? { late_entrant: true } : {}) } } : {}),
    role: user.role || "participant",
    cascaded: counts,
    purged_sessions: purgedSessions,
    ..._cxoneCounts,
    ...reqContext(req),
  });
  res.json({ ok: true, ..._cxoneCounts });
});

// ── Export / Import ──────────────────────────────────────────────────────────
};
