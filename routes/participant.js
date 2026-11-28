"use strict";

// Participant-facing routes: the current participant's account + session
// (GET/PUT /api/me, admin-view reflection), competition +
// timeslot selection, status / config / session keepalive, email reminders, and
// the participant challenge surface (list, detail, hint, navigated-away,
// feedback). "Participant" is the domain term; the table/route term stays
// `user`/`task`. The hot POST /api/tasks/:id/submit handler stays inline in
// server.js (perf-span source-introspection test pins its shape there).
// (v7.0.0 refactor: route split — extracted verbatim from server.js.)

const { v4: uuid } = require("uuid");
const crypto = require("crypto");
const db = require("../db");
const { rateLimit, testSelectTimeslotDelay, requireParticipant, requireCompleteProfile, requireCompetitionContext, requireParticipantInCompetition, tabEventMismatch, csrfProtection, applyAutoResumeToSession, stampClockOnFirstTouch } = require("../lib/middleware");
const { getCompetition, getCompetitionTimeslots, getTimeslot, hasTimeslots, timeslotStatus, timeslotEffectiveEnd, competitionStatus, competitionEffectiveEnd, competitionFullyEnded, ensureTaskNumbers, compareTaskNumbers, participantContentNotStarted, listParticipantCompetitions, autoResumeAllows, anchorLoginTime, userScoresOn, isOpenEnded } = require("../lib/competitions");
const { eventPolicyForWire, eventPolicy, clockStartsAtFirstOpen } = require("../lib/event-policy"); // v8.1.0 (PR 12/18)
const { _deferAudit, recordChallengeEvent, recordCompetitionEvent, recordTimeslotEvent, recordUserEvent, recordSealedReveal, sealRevealHistoryDetails, reqContext, getAdminIdentity } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { BASE_URL, PLATFORM_VERSION, SERVER_STARTED_AT, PERF_SPAN_SLOW_MS, LOGIN_CODE_TTL_MS, RATE_LIMIT_CONFIG_PER_MIN } = require("../lib/config");
const { buildEmail, sendEmailLogged, smtpHealthy } = require("../lib/email");
const { emailIsTaken } = require("../lib/email-identity");
const { getParticipantScore, invalidateLeaderboardCache, invalidateLeaderboardCacheForEntrant, leaderboardVersion } = require("../lib/leaderboard");
const { log, sanitiseForLog } = require("../lib/log");
const { _invalidateMeCache, getMeCached, setMeCached } = require("../lib/me-cache");
const { invalidateAdminParticipantsCache } = require("../lib/participants-cache");
const { sanitiseAvatar, validateAvatarDataUri, persistAvatar, deleteAvatarImage, escapeHtml, richTextHasContent } = require("../lib/sanitise");
const { POINTS, HINT_DEDUCTION_RATE, taskGradingHash } = require("../lib/scoring");
// v8.10.0 — the sealed answer. `sealedAnswerReadable` is the ONE predicate; the
// answer-reveal branches in GET /api/tasks/:id are its main consumers here.
// v8.12.2 — `answerSealed` / `isTaskAuthor` join it for the RECORDED disclosure
// to a superadmin (below), and the hint route asks the same question.
// v8.12.6 — `sealRevealUnrecorded` / `SEAL_UNRECORDED_REASON`: a sealed value
// the tier admits is withheld when its record cannot be written (below).
const { sealedAnswerReadable, sealedHintReadable, sealedHintDenied, sealRevealUnrecorded, SEAL_UNRECORDED_REASON, answerSealed, isTaskAuthor } = require("../lib/answer-seal");
const { participantCategories, topicNamesFor } = require("../lib/topics"); // a question's topic, else its legacy category tags (server-side parse only)
const { certificatePrintedName } = require("../lib/badge"); // the name a certificate issued now would print
const { parseChoices, parseCorrectIds, shuffleChoicesFor, choiceMode, gradeChoice, choiceIdsByText, legacySelectionIds } = require("../lib/choices");
const { _extractOldSessionId, lookupKickedSession, kickReasonOf } = require("../lib/sessions");
const { isEventAdmin, eventAdminCompetitionIds, impersonatorScopedCompetitionIds, impersonationScopeDenied, actingAdminId, actingIsSuperAdmin } = require("../lib/event-admin"); // v8.7.0 tier flag; v8.8.6 impersonation scope; v8.12.1 the seal's human; v8.12.2 the seal's superadmin
const { getPlatformName, getRequireAccountApproval } = require("../lib/settings");
const { roleClass, roleDefinition, handHolds, PERMISSIONS: _ALL_PERMS } = require("../lib/rbac"); // RBAC — role class and the permissions the panel shows
const { loginMethodWire } = require("../lib/login-method");

// RBAC — what an identity payload says about the role: its permissions (what
// the admin panel offers) and its id, label and scope mode. The built-in
// break-glass account holds every permission. Derived per request, never stored.
function _rolePayload(roleId, { builtinAccount = false } = {}) {
  if (builtinAccount) {
    return { permissions: _ALL_PERMS.map(p => p.id), roleInfo: { id: "superadmin", label: "Superadmin", scope_mode: "all", builtin: true } };
  }
  const d = roleDefinition(roleId);
  if (!d) return { permissions: [], roleInfo: { id: roleId || null, label: null, scope_mode: "none", builtin: false } };
  return { permissions: [...d.perms].sort(), roleInfo: { id: d.id, label: d.label, scope_mode: d.scope_mode, builtin: !!d.builtin } };
}
const { now } = require("../lib/time");
const { attemptState, outOfAttemptsTaskIds } = require("../lib/attempts"); // v8.1.0 — the attempt ceiling on the participant wire; #283 the list's `out_of_attempts`
const { isStaff } = require("../lib/user-tags");
const { staffCompeteOn, refuseCompetitor, competitorEventsForTask } = require("../lib/staff-compete"); // v8.12.0; refuseCompetitor v8.12.1 (the toggle's compete refusal); competitorEventsForTask v8.12.2 (the seal never opens to a competitor)
// A bank question id named in the session's event means that event's own copy (lib/event-copies.js).
// Per-session question sets: then a question outside the session the request
// plays answers the same 404 an unassigned one does (lib/session-tasks.js).
const { inSessionSql } = require("../lib/session-tasks");
const _resolveEventTask = [require("../lib/event-copies").resolveEventTaskParam(db, "id"), require("../lib/session-tasks").requireTaskInSession(db, "id")];
const { verificationGraceState } = require("../lib/self-enroll");
const { impersonationActor, impersonationEndedDetails, isImpersonating, actingAdminCompetesInTargetEvents, destroyImpersonationSession, restoreImpersonationTargetInactive, organiserPanelOpensTo } = require("../lib/impersonation");
const { _capsOk, _firstNonStringField, _profileMissingFields, isValidTimezone, isFreeEmail, isValidEmailFormat, normaliseEmail, sameSlotEmails, validateUrl, _nicknameCharsOk, NICKNAME_CHARSET_ERROR, PROFILE_GATE_JOIN, PROFILE_GATE_COLUMNS, profileVersionSql, awaitDeliveryWithDeadline, MAIL_REPORT_DEADLINE_MS, profileTextControlField, profileTextControlBody } = require("../lib/util");

// Slow-request threshold (ms) for the GET /api/status perf-span breakdown.
// Matches the server.js definition; no env gate beyond the env var itself.

/**
 * Thrown out of the profile transaction when the optimistic-concurrency
 * compare-and-swap matched no row, i.e. `users.updated_at` moved between the
 * caller's last read and this write.
 *
 * A CLASS, never a string match on the message. `routes/challenges.js` learnt
 * that the hard way: a refusal identified by its prose is one copy-edit away
 * from being caught as a 500, and the message is the half a reader is most
 * likely to reword.
 */
class StaleRowError extends Error {
  constructor(currentUpdatedAt) {
    super("profile row changed under this write");
    this.code = "STALE_ROW";
    this.currentUpdatedAt = currentUpdatedAt || null;
  }
}

module.exports = function register(app) {
app.get("/api/me", requireParticipant, (req, res) => {
  const uid = req.session.userId;
  // v7.14.0 — impersonation sessions BYPASS the 2-second me-cache in BOTH
  // directions: the cached payload embeds session-derived fields
  // (competitionId/timeslotId/isAdminView/score), so sharing one userId-keyed
  // entry between the participant's real session and an admin's impersonation
  // session would leak one session's context into the other's /api/me poll.
  const _imp = req.session.impersonator || null;
  const cachedPayload = _imp ? null : getMeCached(uid);
  if (cachedPayload) return res.json(cachedPayload);
  // v8.4.0 — `registration_competition_id` plus the two joined columns, because
  // `_profileMissingFields` now reads the registration event's CURRENT
  // configuration and throws on a row that cannot supply it. Aliased `u` so the
  // shared join fragment applies; the `_reg_`-prefixed keys are stripped before
  // the payload is built (below).
  // v8.4.0 — the SHARED gate fragment plus the columns only this payload needs,
  // rather than a hand-written superset. `_profileMissingFields` now reads the
  // registration event's CURRENT configuration and throws on a row that cannot
  // supply it, so the fifteen columns and the LEFT JOIN behind that answer have
  // exactly one definition (`lib/util.js`) — a second copy here is the drift a
  // scanner in `functional-core-b > Docs hygiene` exists to refuse. The two sets
  // are disjoint. The `_reg_`-prefixed join columns are gate INPUTS, not profile
  // fields, and are stripped below — v8.12.8 corrects this note, which claimed the
  // payload was hand-built when `uPublic` is in fact spread into it.
  const u = db.prepare(`SELECT ${PROFILE_GATE_COLUMNS},u.id,u.first_name,u.last_name,u.nickname,u.avatar,u.pending_email,u.certificate_given_name,u.certificate_family_name,u.role,u.verified,u.self_enroll_grace_until,u.login_method,u.password_set_at,u.password_hash,${profileVersionSql("u")} AS updated_at FROM users u ${PROFILE_GATE_JOIN} WHERE u.id=?`).get(req.session.userId);
  const userIsStaff = isStaff(req.session.userId);
  // Defence-in-depth for the "removed from competition" flow: if the session
  // still carries competitionId but the user is no longer assigned (and isn't
  // staff, who can join anything), clear the stale session fields here so the
  // client sees clean state on its next refresh instead of an impossible
  // "still in this competition" view. The primary fix runs at removal time
  // (clearCompetitionSessionForUser); this catches stragglers.
  let compId = req.session.competitionId;
  if (compId && !userIsStaff) {
    const stillAssigned = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, req.session.userId);
    if (!stillAssigned) {
      delete req.session.competitionId;
      delete req.session.timeslotId;
      compId = null;
    }
  }
  const score = compId ? getParticipantScore(req.session.userId, compId, req.session.timeslotId) : 0;
  const comp = compId ? db.prepare("SELECT name FROM competitions WHERE id=?").get(compId) : null;
  // Include user's competitions for page-refresh navigation.
  // v6.9.17's batched slot load (and the tag batch beside it) now live in the
  // shared listParticipantCompetitions — see lib/competitions.js for why.
  // v8.8.6 — narrowed to the acting organiser's own events when an EVENT ADMIN
  // is impersonating. `null` for every other tier and for the participant's own
  // session, so this is the same call it has always been for them.
  const _impScope = impersonatorScopedCompetitionIds(req);
  const competitions = listParticipantCompetitions(req.session.userId, { staff: userIsStaff, withTags: true, restrictToIds: _impScope });
  // Only computed when the answer is actually narrowed — an unscoped session pays
  // nothing for a number it will not send.
  const _allCompCount = _impScope === null ? 0
    : listParticipantCompetitions(req.session.userId, { staff: userIsStaff }).length;
  const tsId = req.session.timeslotId;
  const ts = tsId ? getTimeslot(tsId) : null;
  const missingFields = _profileMissingFields(u);
  // v7.2.0 — surface verification state for the header indicator. Drop the raw
  // self_enroll_grace_until column from the wire (internal); expose a normalised
  // `verified` boolean and, only while a verification grace is still active,
  // the `verification_grace_until` deadline the SPA counts down to.
  // The credential columns never reach the wire: only what lib/login-method.js
  // derives from them (the method, whether a password is set, whether one is owed).
  const { self_enroll_grace_until: _segRaw, verified: _verRaw, password_hash: _phRaw, password_set_at: _psaRaw, login_method: _lmRaw, ...uPublic } = u;
  // v8.12.8 — `_`-prefixed keys are internal by the house convention (`_compWire`,
  // `stripInternal`), and the gate's joined `_reg_event_kind` / `_reg_field_policy`
  // had been riding this payload since v8.4.0. Structural, so a join column added
  // to PROFILE_GATE_COLUMNS later cannot reach the wire either.
  for (const k of Object.keys(uPublic)) if (k.startsWith("_")) delete uPublic[k];
  const _grace = verificationGraceState(u);
  // v8.12.1 — `isEventAdmin` on this payload is the account's TIER (the
  // v8.7.3 reading: "a TIER, not a view", carried on every boot branch), so it
  // is the DB role rather than `isEventAdmin(req)`. The two agree everywhere
  // except under a participant-view impersonation of an organiser, where the
  // scope predicate deliberately answers false (lib/event-admin.js) while the
  // client still needs the tier — it is what makes the header offer the switch
  // into that organiser's admin view, and what routes the help drawer to their
  // guide. Nothing server-side authorises on this field.
  // RBAC — the account's role (`role_info`: id, label, scope mode) on every
  // answer, and what an admin-class role may do (`permissions`), so the SPA
  // decides its admin offers, the view switch and the role chip from the first
  // paint of either view (the sign-in answer and GET /api/admin/me carry the same).
  const _rpMe = _rolePayload(u.role || "participant");
  const payload = { ...uPublic, verified: _grace.verified, verification_grace_until: (!_grace.verified && _grace.active) ? _grace.graceUntil : null, score, competitionId: compId || null, competitionName: comp?.name || null, timeslotId: tsId || null, timeslotName: ts?.name || null, competitions, userRole: u.role || "participant", isEventAdmin: roleClass(u.role || "participant") === "granted", isAdminView: !!req.session.isAdmin, isSuperAdmin: !!req.session.isSuperAdmin, isStaff: userIsStaff, missing_fields: missingFields, profile_complete: missingFields.length === 0,
    // The name a certificate issued now would print (lib/badge.js
    // `certificatePrintedName`, the certificate's own rule), for the
    // Leaderboard card's rendition of one: the browser has no font coverage.
    certificate_printed_name: certificatePrintedName(u, u.nickname).displayName || "",
    role_info: _rpMe.roleInfo,
    ...(_rpMe.roleInfo.scope_mode !== "none" ? { permissions: _rpMe.permissions } : {}),
    // How this account signs in — never under impersonation: a credential is the
    // owner's alone, and the sign-in-method door refuses every impersonation tier.
    ...(_imp ? {} : loginMethodWire(u)) };
  // v7.14.0 — while impersonating, the payload IS the target's data; this block
  // tells the SPA to render the banner + apply the write tier. Never cached.
  if (_imp) {
    payload.impersonation = {
      active: true,
      superadmin: !!_imp.isSuperAdmin,
      admin_label: impersonationActor(req.session),
      // v8.12.1 — WHICH VIEW, and whether the target HAS two. The banner names
      // the view only for an organiser (a participant target has one view, and
      // saying "participant view" beside their name would be noise), and the
      // client keys its switch-related copy on `target_role` rather than
      // re-deriving it. `view` is the session's SHAPE (the same fact
      // `isAdminView` reports), stated here so a reader of this block alone
      // gets the whole picture.
      view: req.session.isAdmin ? "admin" : "participant",
      target_role: u.role || "participant",
      // v8.8.6 — the picker must not infer "this participant is in no events"
      // from an empty array, because under a scoped impersonation that sentence
      // is a lie: they ARE enrolled, and this viewer may simply not see those
      // events. The SERVER says which of the two it is; the count of what was
      // withheld rides along so the copy can be specific without naming any of
      // them.
      scoped_to_my_events: _impScope !== null,
      withheld_event_count: _impScope === null ? 0 : Math.max(0, _allCompCount - competitions.length),
      // Whether this view shows the participant's certificate code and link
      // (operator ruling, 23 Nov 2026: only to a hand holding certificates.lookup).
      // Only the wording shown before a certificate is fetched reads it; every
      // certificate answer says so for itself (`withheld`).
      certificate_codes: handHolds(req, "certificates.lookup"),
    };
    return res.json(payload);
  }
  setMeCached(uid, payload);
  res.json(payload);
});

// Session check for built-in superadmin (no userId) to survive page refresh.
// For user-backed admins we re-check the DB role — a participant demoted
// mid-session, deleted, or blocked must not keep reading this as authenticated.
app.get("/api/admin/me", (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: "Not authenticated" });
  if (req.session.builtinId === "superadmin") {
    const _bp = _rolePayload("superadmin", { builtinAccount: true });
    return res.json({ ok: true, role: "superadmin", isAdmin: true, isSuperAdmin: true, isEventAdmin: false, isBreakglass: true, smtp_healthy: smtpHealthy(), require_account_approval: getRequireAccountApproval(),
      permissions: _bp.permissions, role_info: _bp.roleInfo });
  }
  const row = req.session.userId
    ? db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(req.session.userId)
    : null;
  // v8.12.1 — under an admin-shaped impersonation the row is the TARGET
  // organiser's, and this endpoint used to DESTROY the session when it failed —
  // the acting admin's session, the one thing every impersonation path is
  // careful never to destroy (a blocked target would have signed the superadmin
  // out). The requireAdmin shape instead: restore the acting admin, close the
  // window on the target's History, answer the marker the client turns into a
  // toast and a reload. The role is part of the test, both directions, for the
  // reason requireAdmin gives.
  const _impMe = req.session.impersonator;
  if (_impMe && (!row || row.blocked || row.denied_at || !row.approved || row.role !== "event_admin")) {
    return restoreImpersonationTargetInactive(req, res);
  }
  // And the ACTING admin, re-read on every read of this endpoint for the
  // reason requireAdmin gives: the organiser's read surface is on the table.
  if (_impMe && _impMe.builtinId !== "superadmin") {
    const a = _impMe.userId ? db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(_impMe.userId) : null;
    if (!a || !organiserPanelOpensTo(a.role) || a.blocked || a.denied_at || !a.verified || !a.approved) {
      return destroyImpersonationSession(req, res); // v8.12.1 — closes the target's window first
    }
  }
  // v6.20.x — re-check the full lifecycle (verified/approved/denied), matching
  // login + requireAdmin, so an out-of-band-unverified user-backed admin can't
  // keep reading this endpoint as authenticated. v8.12.1 — an impersonation
  // session was decided above (the target's `verified` deliberately excluded).
  // RBAC — any role of a class other than `none` holds the admin panel.
  if (!_impMe && (!row || row.blocked || row.denied_at || !row.verified || !row.approved || roleClass(row.role, { live: true }) === "none")) {
    req.session.destroy(() => res.status(401).json({ error: "Not authenticated" }));
    return;
  }
  // v7.29.0 — smtp_healthy rides the endpoint the admin shell already polls.
  // smtpHealthy() has been probed every 5 minutes since it was written and
  // exposed ONLY as a Prometheus gauge, so no operator without a metrics stack
  // has ever been able to see it — the v7.21.2 class (a signal with no human
  // consumer). It matters most for the walk-up flow, where a greylisted first
  // contact is indistinguishable from "the platform is broken" at a desk.
  // null = not probed yet, which the client must NOT render as a failure.
  // v8.7.0 — the REAL role, not a hard-coded "admin". The SPA reads it to decide
  // which nav items exist, and an event admin reading "admin" would be offered
  // Logs and Settings, which the server then refuses (the v7.14.2 defect).
  const _rp = _rolePayload(row.role);
  const _granted = roleClass(row.role) === "granted";
  res.json({ ok: true, role: row.role, isAdmin: true, isSuperAdmin: row.role === "superadmin",
             isEventAdmin: _granted,
             eventAdminCompetitionCount: _granted ? eventAdminCompetitionIds(req.session.userId).length : null,
             // RBAC — what this role may do (the panel offers by permission) and which role it is.
             permissions: _rp.permissions, role_info: _rp.roleInfo,
             smtp_healthy: smtpHealthy(),
             // The approval switch, so the admin shell shows approval controls
             // only while sign-ups are actually held for an organiser.
             require_account_approval: getRequireAccountApproval(),
             // v8.12.1 — the same block /api/me carries, so a client booting the
             // admin shell from THIS payload can render the banner and the tier.
             ...(_impMe ? { impersonation: { active: true, superadmin: !!_impMe.isSuperAdmin, admin_label: impersonationActor(req.session), view: "admin", target_role: row.role } } : {}),
             // How this admin signs in (never under impersonation: the seat's
             // credential is not the acting admin's business).
             ...(_impMe ? {} : loginMethodWire(db.prepare("SELECT role, login_method, password_set_at, password_hash FROM users WHERE id=?").get(req.session.userId))) });
});

// v8.12.1 — UNDER IMPERSONATION THIS IS THE IN-SESSION VIEW SWITCH. Before
// this release the toggle was on `_IMPERSONATION_BLOCKED` for every tier: it
// regenerated restoring a FIXED field list, so the `impersonator` marker died
// and the admin was left holding an untracked, genuine participant session for
// the target (analytics stopped flagging, the audit lost its attribution, the
// exit endpoint 400'd "Not impersonating"). An admin impersonating an EVENT
// ADMIN needs both of that organiser's views — the participant app and the
// Event Admin Panel — and the toggle is the one control that already switches
// between them, so it learnt to carry the marker instead of being refused.
//
// Three things differ from the ordinary toggle, each a decision:
//   • the marker (and the target's name/email fields it snapshots) ride
//     `oldData` through the regenerate, so the session stays impersonating;
//   • BOTH lifecycles are re-read — the acting admin's, because a demoted
//     ex-admin must not be handed an admin-shaped seat by the toggle (v7.21.12,
//     the no-frozen-snapshot rule; the exit route makes the same check), and
//     the target's, because the admin view is granted only to a live
//     `event_admin` target. A participant-role target asking for the admin
//     view gets the same "You do not have admin access" a participant would;
//   • `isSuperAdmin` is NEVER set, whatever the target's role reads, and the
//     participant branch skips the auto-resume landing: impersonation must not
//     land on an event through the target's marker any more than the entry
//     does (v8.8.6 — the entry regenerates and sets no competitionId).
// The audit row lands on the TARGET's history attributed to the ACTING admin
// (`getAdminIdentity` resolves through the marker since v8.12.1), and
// `reqContext` spreads `impersonated_by` / `acting_as` beside it, so the
// switch is recorded as the organiser's panel being opened by somebody else.
app.post("/api/toggle-admin-view", csrfProtection, (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: "Not a user session" });
  const user = db.prepare("SELECT role, email, blocked, denied_at, verified, approved FROM users WHERE id=?").get(req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  const role = user.role || "participant";
  const imp = req.session.impersonator || null;
  let _actingRole = imp ? (imp.builtinId === "superadmin" ? "superadmin" : null) : null;
  if (imp && imp.builtinId !== "superadmin") {
    // The ACTING admin's lifecycle, re-read live — the exit route's check, and
    // the same three tiers it admits (an event admin may impersonate a
    // participant in their scope, v8.8.6, and must keep the no-op toggle).
    const adminRow = imp.userId
      ? db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(imp.userId)
      : null;
    const ar = adminRow?.role;
    if (!adminRow || roleClass(ar, { live: true }) === "none" || adminRow.blocked || adminRow.denied_at || !adminRow.verified || !adminRow.approved) {
      return destroyImpersonationSession(req, res); // v8.12.1 — closes the target's window first
    }
    _actingRole = ar;
  }
  // v7.22.8 — `req.body?.` not `req.body.`: Express 5 leaves req.body
  // UNDEFINED when no parser ran (a body-less POST), so the bare read threw
  // and this endpoint answered 500 to any API client that omitted the JSON
  // body — the batch-5 "malformed body must not 500" class, found by a test
  // driving the toggle without one. Absent mode already means participant
  // view, which is the right reading of an empty body.
  const mode = req.body?.mode;
  // v6.2.8: capture the pre-toggle admin/super flags so the audit can show
  // from/to explicitly. An admin dropping into participant-view sees a
  // different data set (no logs, no kebab overrides) — meaningful state
  // change that previously wasn't logged at all.
  const fromIsAdmin = !!req.session.isAdmin;
  const fromIsSuperAdmin = !!req.session.isSuperAdmin;
  // Regenerate session on privilege change to prevent session fixation
  // v8.12.1 — the impersonation marker and the target's identity fields ride
  // through the regenerate; without them the toggle IS an untracked exit.
  // The identity mirrors ride through for EVERY session, not only an
  // impersonating one: the pre-v8.12.1 toggle dropped `userEmail` (a fixed
  // field list), so an admin who had toggled views before impersonating
  // snapshotted a NULL email into the marker and every `impersonated_by` for
  // that window degraded to a UUID — the very thing `getAdminIdentity`'s live
  // read was added to route around. Keeping them is what makes the snapshot
  // trustworthy at entry (found by the v8.12.1 pre-release review).
  const oldData = { userId: req.session.userId, userRole: req.session.userRole, competitionId: req.session.competitionId, timeslotId: req.session.timeslotId,
    userEmail: req.session.userEmail, userFirstName: req.session.userFirstName, userLastName: req.session.userLastName,
    // How and when this session signed in (routes/auth.js `_signInAs`): a view
    // switch is not a new sign-in, so the forgotten-password window carries over.
    signInMethod: req.session.signInMethod, signedInAt: req.session.signedInAt, signInViaEmail: req.session.signInViaEmail,
    ...(imp ? { impersonator: imp } : {}) };
  // The lifecycle gate the admin view is granted on. Under impersonation the
  // TARGET's `verified` is deliberately not asked (v7.15.8 admits an unverified
  // target, and `requireAdmin`'s forced exit asks the same four columns), and
  // only the event-admin tier may be entered through somebody else's seat.
  // An organiser's panel opens only to the built-in global roles, exactly as at
  // entry (`organiserPanelOpensTo`): an event-admin actor is refused a fellow
  // organiser at entry already, and a custom role, even one of every event, is
  // refused the panel there; asking the role's CLASS here let such a role enter
  // the participant view and switch up into the organiser's seat.
  const adminViewRefused = imp
    ? (role !== "event_admin" || user.blocked || user.denied_at || !user.approved || !organiserPanelOpensTo(_actingRole))
    : (roleClass(role, { live: true }) === "none" || user.blocked || user.denied_at || !user.verified || !user.approved);
  // v6.20.x — full lifecycle gate (matches login + requireAdmin): an
  // unverified/unapproved/blocked/denied user can't flip into admin view.
  // v8.12.1 — refused BEFORE the regenerate, so a refusal changes nothing: it
  // used to run inside the callback, which had already replaced the session
  // (and its CSRF token) and left the flags unset — a refused switch that
  // silently demoted the session and broke the next write's token.
  if (mode === "admin" && adminViewRefused) return res.status(403).json({ error: "You do not have admin access" });
  // v8.12.1 — THE SAME COMPETE QUESTION THE ENTRY ASKS, asked here too. Entry
  // refuses the admin VIEW to an acting admin who competes in an event the
  // organiser runs (routes/participants.js, `actingAdminCompetesInTargetEvents`)
  // — reads included, because the organiser's panel is the read surface of a
  // board they compete on. The first draft asked it at entry only, and this
  // toggle is allowlisted past the guard's re-ask, so entering the PARTICIPANT
  // view (allowed) and switching up here reopened exactly the panel the entry
  // had refused (found by the v8.12.1 pre-release review). Same predicate, same
  // refusal shape, and BEFORE the regenerate so a refusal changes nothing.
  if (mode === "admin" && imp && imp.userId) {
    const _cmp = refuseCompetitor(res, actingAdminCompetesInTargetEvents(db, imp.userId, req.session.userId));
    if (_cmp) return _cmp;
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Session error" });
    Object.assign(req.session, oldData);
    if (mode === "admin") {
      req.session.isAdmin = true;
      req.session.isSuperAdmin = !imp && role === "superadmin";
    } else {
      req.session.isAdmin = false;
      req.session.isSuperAdmin = false;
      // v8.12.0 — SWITCHING TO PARTICIPANT VIEW IS A DOOR INTO THE PARTICIPANT
      // APP, so it takes the two landing rules a sign-in takes: the auto-resume
      // marker, then the sole-event landing. Only when the session carries no
      // event already — an admin who was mid-event keeps the pointer they came
      // in with, as before. The client routes off `competitionId` when its own
      // `S.currentCompetitionId` is null, which is what makes an admin enrolled
      // in exactly one event land in it rather than on a one-card list.
      // v8.12.1 — never under impersonation: the landing reads the TARGET's
      // marker, and an admin peeking must not be put into their event by it.
      if (!req.session.competitionId && !imp) {
        try { applyAutoResumeToSession(req, req.session.userId); } catch (e) { /* a landing is never worth a failed toggle */ swallowed("participant:toggle-auto-resume", e); }
      }
    }
    if (imp) req.session.impersonator.view = mode === "admin" ? "admin" : "participant";
    // v8.7.3 — THE VIEW IS PART OF WHAT `/api/me` REPORTS, so switching it must
    // bust that cache. Found by the browser lock below rather than by review.
    //
    // `_meCache` is keyed on `userId` ALONE, and the payload carries the
    // SESSION-derived `isAdminView` (plus `competitionId` / `timeslotId` /
    // `score`). So a page load within the 2 s TTL was served a body describing
    // the view the account had just LEFT: boot read `isAdminView: true`, built
    // the whole admin panel, and every admin request under it then 403'd
    // against a session that was participant-shaped — an admin panel that looks
    // right and works nowhere, with nothing on screen saying why.
    //
    // The codebase already knew this payload is cache-unsafe per session:
    // `/api/me` bypasses the cache in BOTH directions for an impersonation
    // session for exactly this reason. The admin-view toggle is the other
    // session-shape change and was never given the same treatment. This is the
    // standing writer rule — anything that changes what `/api/me` REPORTS
    // invalidates BY ID — applied to the one writer that had escaped it.
    _invalidateMeCache(req.session.userId);
    try {
      // v8.12.1 — attributed to the ACTING admin under impersonation, so the
      // target's History says whose hand switched the view; `reqContext`
      // carries `impersonated_by` / `acting_as` on the same row.
      recordUserEvent(req.session.userId, "admin_view_toggled", imp ? getAdminIdentity(req) : (user.email || "system"), { ...reqContext(req), role,
        mode: mode === "admin" ? "admin" : "participant",
        is_admin:       { from: fromIsAdmin,       to: !!req.session.isAdmin },
        is_superadmin:  { from: fromIsSuperAdmin,  to: !!req.session.isSuperAdmin }, });
    } catch (e) {
      // non-fatal — toggle already succeeded
      swallowed("participant:view-toggle-audit", e);
    }
    // v8.7.3 — `isEventAdmin` RIDES THIS RESPONSE, and its absence was the
    // sharpest half of the participant-view report.
    //
    // The client does `S.isEventAdmin=!!d.isEventAdmin` (public/js/ui/nav.js),
    // so an omitted key is `!!undefined` === FALSE: one toggle in either
    // direction silently demoted an event admin's PANEL to a global admin's for
    // the life of the tab. Five correct predicates were then fed a false flag —
    // the Logs nav item and "+ New Competition" reappeared, Analytics offered
    // the platform-wide scope, and "Make event admin" was offered — every one of
    // them a control this tier's own routes then refuse (v7.14.2, the defect
    // where the affordance and the server disagree).
    //
    // Every OTHER identity payload already carries it deliberately — `POST
    // /api/login` (server.js), `GET /api/me` and `GET /api/admin/me` above — and
    // login's own comment says omitting it "would leave the flag false for one
    // render". This endpoint was the single gap in that set.
    // v8.12.1 — `isEventAdmin` is the TIER of the seat (the role), so a switch
    // to the participant view under impersonation still reports an organiser
    // — `isEventAdmin(req)` answers about the guard and would read false there.
    // The impersonation block is the one `/api/me` and `/api/admin/me` carry,
    // so the client can re-render the banner without another round trip.
    res.json({ ok: true, mode, isAdmin: !!req.session.isAdmin, isSuperAdmin: !!req.session.isSuperAdmin, isEventAdmin: roleClass(role) === "granted", competitionId: req.session.competitionId || null,
      ...(imp ? { impersonation: { active: true, superadmin: !!imp.isSuperAdmin, admin_label: impersonationActor(req.session), view: req.session.impersonator.view, target_role: role } } : {}) });
  });
});

// v7.14.0 — exit participant impersonation. Deliberately NOT behind
// requireParticipant/requireAdmin: the session is participant-shaped while
// impersonating a participant (isAdmin unset) and ADMIN-SHAPED while in an
// event admin's panel (v8.12.1), so no one gate fits both — and the exit path
// must stay reachable even if the TARGET's lifecycle degrades (requireParticipant
// / requireAdmin would forced-exit it anyway). Gated inline on the impersonator
// marker; on the global impersonationGuard allowlist. Mirrors toggle-admin-view's
// acting-admin check: re-validate the ADMIN's lifecycle from the DB, regenerate
// (privilege elevation), restore the snapshotted admin identity + competition
// context.
app.post("/api/impersonation/exit", csrfProtection, (req, res) => {
  const imp = req.session.impersonator;
  if (!imp) return res.status(400).json({ error: "Not impersonating" });
  const targetId = req.session.userId || null;
  let adminRow = null;
  if (imp.builtinId !== "superadmin") {
    adminRow = imp.userId
      ? db.prepare("SELECT role, email, blocked, denied_at, verified, approved FROM users WHERE id=?").get(imp.userId)
      : null;
    const role = adminRow?.role;
    if (!adminRow || roleClass(role, { live: true }) === "none" || adminRow.blocked || adminRow.denied_at || !adminRow.verified || !adminRow.approved) {
      // The admin lost admin access mid-impersonation — no identity to hand
      // back. Destroy outright (same message as toggle-admin-view).
      return destroyImpersonationSession(req, res); // v8.12.1 — closes the target's window first
    }
  }
  const actor = impersonationActor(req.session);
  const isSuper = !!imp.isSuperAdmin;
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Session error" });
    if (imp.builtinId === "superadmin") {
      req.session.builtinId = "superadmin";
    } else {
      req.session.userId = imp.userId;
      req.session.userEmail = imp.userEmail || adminRow?.email || null;
      req.session.userFirstName = imp.userFirstName || null;
      req.session.userLastName = imp.userLastName || null;
      req.session.userRole = imp.userRole || adminRow?.role || null;
    }
    req.session.isAdmin = true;
    req.session.isSuperAdmin = isSuper;
    if (imp.competitionId) req.session.competitionId = imp.competitionId;
    if (imp.timeslotId) req.session.timeslotId = imp.timeslotId;
    if (targetId) {
      try {
        recordUserEvent(targetId, "impersonation_ended", actor, {
          ...impersonationEndedDetails(imp, "manual"),
          ...reqContext(req),
        });
      } catch (e) {
        // non-fatal — exit already succeeded
        swallowed("participant:impersonation-exit-audit", e);
      }
    }
    res.json({ ok: true, isAdmin: true, isSuperAdmin: isSuper });
  });
});

// ext-audit v7.15.13 — PUT /api/me accepts a 256 KB avatar upload and had no
// limiter of its own, so it inherited only the global body cap: one session
// could drive unbounded image writes. 30/min is far above any human editing
// their profile and far below a useful write-amplification channel.
//
// **Keyed by (IP, account), never by IP alone.** This is the endpoint the
// non-dismissible profile-completion gate uses to un-brick a participant — and
// the gate re-verifies after each save, so one user legitimately issues several
// PUTs. A plain per-IP bucket would put an entire venue/NAT cohort (200
// participants on one egress IP, all completing their profile in the same
// minute at the start of an event) into ONE 30/min bucket and brick the un-brick
// path for all of them. That is precisely the CTF-0026 failure /api/login was
// fixed for; see the rate-limit-keying section in CLAUDE.md.
//
// Runs AFTER requireParticipant so an expired session's 401 never consumes a
// bucket, and after it we still reach csrfProtection — a CSRF-failing request
// does consume one, which is intended (it is not a legitimate client).
app.put("/api/me", requireParticipant,
  rateLimit(60_000, 30, "me-update", { keyExtra: (req) => req.session?.userId || "" }),
  csrfProtection, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { firstName, lastName, nickname, company, title, email, secondaryEmail, avatar, country, timezone, linkedinUrl, jobFunction, city, personalTitle, phone } = req.body;
  // ext-audit batch 4 — a non-string body field (e.g. {company:["x"]}) would 500
  // at the `.trim()` calls below (optional chaining guards null, not type). Reject
  // up front so a malformed PUT /api/me is a clean 400, never a 500.
  const _nonStr = _firstNonStringField(req.body, ["firstName", "lastName", "nickname", "company", "title", "email", "secondaryEmail", "avatar", "country", "timezone", "linkedinUrl", "jobFunction", "city", "personalTitle", "phone"]);
  if (_nonStr) return res.status(400).json({ error: `${_nonStr} must be text` });
  const capHit = _capsOk({
    first_name: firstName, last_name: lastName, nickname, company, title, country,
    personal_title: personalTitle, phone,
    job_function: jobFunction, city, secondary_email: secondaryEmail, linkedin_url: linkedinUrl,
  });
  if (capHit) return res.status(400).json({ error: `${capHit.field} must be at most ${capHit.max} characters.` });

  // Every field is the account's own to edit, whatever door it registered
  // through: a legacy LinkedIn-registered account changes its names and LinkedIn
  // URL like anyone else (operator ruling, 14 Nov 2026). A blank name keeps the
  // stored one.
  const keepIfBlank = (current, incoming) => (incoming?.trim() || current);
  const newFirst = keepIfBlank(user.first_name, firstName);
  const newLast = keepIfBlank(user.last_name, lastName);
  const newNick = nickname?.trim() || user.nickname;
  // The base set refuses an explicit empty value: company, title, country and
  // timezone. A blank name, nickname or email keeps the stored one; every other
  // field may be emptied.
  if (company !== undefined && !company?.trim())
    return res.status(400).json({ error: "Company is required." });
  if (title !== undefined && !title?.trim())
    return res.status(400).json({ error: "Title is required." });
  // ext-audit v7.21.1 (A7) — these two were the only required profile fields here
  // NOT using `?.trim()`, so " " passed (truthy) and was then stored RAW below.
  if (country !== undefined && !country?.trim())
    return res.status(400).json({ error: "Country is required." });
  if (timezone !== undefined && !timezone?.trim())
    return res.status(400).json({ error: "Timezone is required." });
  // timezone reaches Intl (fmtDt, formatEmailDate, the competition-window
  // arithmetic), so an unvalidated one throws a RangeError far from this write.
  if (timezone !== undefined && !isValidTimezone(timezone.trim()))
    return res.status(400).json({ error: "Please select a valid timezone." });
  // Job function and City are optional for every account since the sign-up form
  // was simplified (29 Oct 2026); an event that requires one asks for it through
  // the completion gate (`_profileMissingFields`), which is the one judge.
  const newCompany = company !== undefined ? company.trim() : user.company;
  const newTitle = title !== undefined ? title.trim() : user.title;
  const newCountry = country !== undefined ? country.trim() : user.country;
  const newTimezone = timezone !== undefined ? timezone.trim() : user.timezone;
  const newJobFunction = jobFunction !== undefined ? jobFunction.trim() : user.job_function;
  const newCity = city !== undefined ? city.trim() : user.city;
  // v6.9.2: reject an invalid LinkedIn URL instead of silently coercing it
  // to empty. An empty string clears it.
  const _candidateLinkedin = linkedinUrl !== undefined ? (linkedinUrl?.trim() || null) : user.linkedin_url;
  if (_candidateLinkedin && _candidateLinkedin.trim() && !validateUrl(_candidateLinkedin))
    return res.status(400).json({ error: "LinkedIn URL must be a valid http:// or https:// URL." });
  const newLinkedin = validateUrl(_candidateLinkedin);
  const oldAvatar = user.avatar;
  // ext-audit v7.15.13 — VALIDATE the avatar here (so a bad one still fails fast
  // with the same 400) but DEFER the image-row INSERT until every other check
  // below has passed. Persisting here leaked a ~256 KB BLOB on each save that
  // was subsequently rejected for a nickname / email / URL reason, and the
  // INSERT was outside the update transaction so nothing rolled it back.
  let _pendingAvatar = null;                 // validated data URI, not yet stored
  let newAvatar = user.avatar;
  if (avatar) {
    if (typeof avatar === "string" && avatar.startsWith("data:image/")) {
      _pendingAvatar = validateAvatarDataUri(avatar);
      if (!_pendingAvatar) return res.status(400).json({ error: "Avatar image rejected: unsupported format or exceeds 256 KB size limit." });
      newAvatar = null;                      // resolved to a real ref at persist time
    } else {
      // A preset name or this account's own current /api/images/<uuid> ref — no
      // storage involved. Any other stored picture is refused like a dead ref
      // (lib/sanitise.js sanitiseAvatar: `current`).
      newAvatar = sanitiseAvatar(avatar, { current: user.avatar });
      if (newAvatar === null) return res.status(400).json({ error: "Avatar image rejected: unsupported format or exceeds 256 KB size limit." });
      // v8.3.34 — `undefined` means the ref named no image row (a stale value
      // from a dialog opened before another writer replaced the avatar). Keep
      // what the row already has: writing the dead ref would leave a dangling
      // avatar AND make the reclaim below delete the live blob.
      if (newAvatar === undefined) newAvatar = user.avatar;
    }
  }
  // v6.16.22 — NFC-normalise so encoding variants collide on uniqueness.
  const newEmail = email ? normaliseEmail(email) : user.email;
  const newSecondary = secondaryEmail !== undefined
    ? (secondaryEmail ? normaliseEmail(secondaryEmail) : null)
    : user.secondary_email;
  // v7.3.0 — optional personal title + phone (free to clear).
  const newPersonalTitle = personalTitle !== undefined ? (personalTitle?.trim() || null) : user.personal_title;
  // v8.1.0 (PR 24) — the certificate name. OPTIONAL and CLEARABLE: an empty
  // string means "use my profile name again", which has to be expressible or the
  // fields are a one-way door. Length-capped like every other free-text profile
  // field; no charset restriction, because the whole point is a name the profile
  // form may not carry (and the badge fonts now cover Cyrillic and Greek).
  const _certGivenIn = req.body.certificateGivenName;
  const _certFamilyIn = req.body.certificateFamilyName;
  for (const [k, v] of [["certificateGivenName", _certGivenIn], ["certificateFamilyName", _certFamilyIn]]) {
    if (v !== undefined && v !== null && typeof v !== "string") return res.status(400).json({ error: `${k} must be text` });
    if (typeof v === "string" && v.trim().length > 100) return res.status(400).json({ error: `${k} must be at most 100 characters.` });
  }
  // Single-line profile text carries no control character (lib/util.js
  // profileTextOk, one predicate for every door). Nothing above has written.
  {
    const ctl = profileTextControlField({ first_name: firstName, last_name: lastName, company, title,
      personal_title: personalTitle, phone, job_function: jobFunction, city, country,
      certificate_given_name: _certGivenIn, certificate_family_name: _certFamilyIn });
    if (ctl) return res.status(400).json(profileTextControlBody(ctl));
  }
  const newCertGiven = _certGivenIn !== undefined ? (String(_certGivenIn ?? "").trim() || null) : user.certificate_given_name;
  const newCertFamily = _certFamilyIn !== undefined ? (String(_certFamilyIn ?? "").trim() || null) : user.certificate_family_name;
  const newPhone = phone !== undefined ? (phone?.trim() || null) : user.phone;

  // Validate nickname — ONLY when it actually changes (v7.7.5, ext-audit F7).
  // Validating unconditionally bricked legacy users whose existing nickname
  // predates the printable-ASCII rule: the profile editor resubmits the nickname
  // unchanged, so `_nicknameCharsOk` would 400 and block saving ANY other field
  // (company/title/…) until they also renamed. A *changed* nickname must still
  // pass the charset + length + uniqueness checks.
  if (newNick !== user.nickname) {
    if (newNick.length < 3) return res.status(400).json({ error: "Nickname must be at least 3 characters" });
    if (!_nicknameCharsOk(newNick)) return res.status(400).json({ error: NICKNAME_CHARSET_ERROR });
    if (db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE AND id!=?").get(newNick, user.id))
      return res.status(409).json({ error: "This nickname is already taken." });
  }

  // Reject malformed addresses — but ONLY when the value actually changes
  // (audit v7.7.32, mirroring the nickname F7 carve-out above). isValidEmailFormat
  // now rejects non-ASCII (v7.7.12), yet v7.2.x–v7.7.11 deliberately ACCEPTED
  // Unicode emails. Validating an UNCHANGED stored value bricked those legacy
  // accounts: any PUT that merely repeats the address (editing only company/city,
  // or the non-dismissible profile-completion gate PUTing just the missing field)
  // would 400 and lock the user out with no self-service path. A CHANGED address
  // must still pass the (ASCII) format check.
  if (newEmail !== user.email && !isValidEmailFormat(newEmail))
    return res.status(400).json({ error: "Please enter a valid email address." });
  if (newSecondary && newSecondary !== user.secondary_email && !isValidEmailFormat(newSecondary))
    return res.status(400).json({ error: "Please enter a valid secondary email address." });

  // v7.5.0 — a primary-email CHANGE is now staged (pending_email) and confirmed
  // via a link sent to the new address; the current email + verified state stay
  // live until then (no logout, no re-verify dance). secondary_email still
  // applies immediately. See EMAIL_RULES.md.
  const emailChanged = newEmail.toLowerCase() !== user.email.toLowerCase();

  // Dual-email rule: at least one of (primary, secondary) must be a company
  // email. Validate the immediately-active state (current primary stays while a
  // change is pending; secondary applies now) AND the post-confirm state
  // (newEmail becomes primary) so neither the live nor the future account breaks.
  const secondaryFree = newSecondary ? isFreeEmail(newSecondary) : true;
  const activePrimary = emailChanged ? user.email : newEmail;
  if (isFreeEmail(activePrimary) && secondaryFree)
    return res.status(400).json({ error: "At least one email address must be a company email, not a free email service." });
  if (emailChanged && isFreeEmail(newEmail) && secondaryFree)
    return res.status(400).json({ error: "At least one email address must be a company email, not a free email service." });

  // The staged new primary must be free system-wide (committed slots + other
  // users' non-expired pendings).
  if (emailChanged && emailIsTaken(newEmail, user.id))
    return res.status(409).json({ error: "This email is already registered." });

  // Check secondary doesn't clash with another account's primary/secondary/pending.
  if (newSecondary && emailIsTaken(newSecondary, user.id))
    return res.status(409).json({ error: "This secondary email is already in use by another account." });
  // The staged new primary must differ from the (new) secondary slot too.
  if (sameSlotEmails(newEmail, newSecondary))
    return res.status(400).json({ error: "Primary and secondary email must be different." });
  // audit v7.7.37 (C5) — when the primary change is STAGED (pending), the new
  // secondary applies IMMEDIATELY while the live primary stays user.email, so the
  // immediately-active pair must ALSO be distinct. Pre-fix a natural swap
  // (primary→b, secondary→old-primary) committed the row with primary==secondary;
  // if the pending expired it was permanent, and every later PUT re-submitting the
  // current email hit sameSlotEmails(a,a) → 400, bricking all profile saves.
  if (emailChanged && sameSlotEmails(user.email, newSecondary))
    return res.status(400).json({ error: "Primary and secondary email must be different." });

  // Compute changes for audit trail
  const selfChanges = {};
  const diffField = (k, oldV, newV) => { if ((oldV || null) !== (newV || null)) selfChanges[k] = { from: oldV || null, to: newV || null }; };
  diffField("first_name", user.first_name, newFirst);
  diffField("last_name", user.last_name, newLast);
  diffField("nickname", user.nickname, newNick);
  diffField("company", user.company, newCompany);
  diffField("title", user.title, newTitle);
  diffField("personal_title", user.personal_title, newPersonalTitle);
  diffField("certificate_given_name", user.certificate_given_name, newCertGiven);
  diffField("certificate_family_name", user.certificate_family_name, newCertFamily);
  diffField("phone", user.phone, newPhone);
  diffField("job_function", user.job_function, newJobFunction);
  diffField("city", user.city, newCity);
  diffField("secondary_email", user.secondary_email, newSecondary);
  diffField("country", user.country, newCountry);
  diffField("timezone", user.timezone, newTimezone);
  diffField("linkedin_url", user.linkedin_url, newLinkedin);
  // Every rejection path is behind us — NOW it is safe to store the image.
  if (_pendingAvatar) newAvatar = persistAvatar(_pendingAvatar);
  if (newAvatar !== user.avatar) selfChanges.avatar = { from: user.avatar, to: newAvatar };
  // NOTE (v7.5.0): a primary-email change is NOT a committed field change here —
  // it's staged in pending_email and only diffed/committed at confirm time. The
  // `email` column is left untouched by this UPDATE. secondary_email DOES apply.
  const pendingCode = emailChanged ? uuid() : null;
  const pendingAt = emailChanged ? now().toISOString() : null;
  // ── optimistic concurrency on the PROFILE fields ────────────────────────────
  //
  // The client echoes the `updated_at` it last read from `GET /api/me`. Read as
  // a STRING or not at all: every other body field on this route is type-guarded
  // before it reaches a bind (`_firstNonStringField`), and an array here would
  // otherwise be SPREAD by better-sqlite3 as positional bindings — the class
  // v8.3.39 (F3) had to close on the participant import.
  //
  // Absent (or empty) means UNCHECKED, exactly as `competitions` behaves. That
  // back-compat arm is deliberate and is what the `? IS NULL` clause below
  // expresses: a scripted caller, a stale SPA and every existing test keep
  // working, and only a client that opts in gets the 409.
  const _expUpd = (typeof req.body?.expectedUpdatedAt === "string" && req.body.expectedUpdatedAt)
    ? req.body.expectedUpdatedAt : null;
  const _newUpdatedAt = now().toISOString();
  try {
    const profileTxn = db.transaction(() => {
      // A COMPARE-AND-SWAP, not a pre-transaction read-then-check.
      //
      // `routes/competitions.js` checks before the transaction and
      // `routes/participants.js:483-491` documents what that costs: the value
      // can move between the check and the write, so the guard fails OPEN and
      // the second writer wins silently — which is the whole defect. Folding the
      // comparison into this statement's own WHERE makes it atomic, and it is
      // the transaction's FIRST statement so nothing else has run when it loses.
      //
      // `IS`, not `=`: a row whose `updated_at` is NULL (one the backfill could
      // not reach) would compare unknown under `=` and refuse for ever.
      const _swapped = db.prepare(`UPDATE users SET first_name=?, last_name=?, nickname=?, company=?, title=?, personal_title=?, phone=?, job_function=?, city=?, secondary_email=?, avatar=?, country=?, timezone=?, linkedin_url=?, certificate_given_name=?, certificate_family_name=?, updated_at=? WHERE id=? AND (? IS NULL OR ${profileVersionSql()} IS ?)`)
        .run(newFirst, newLast, newNick, newCompany, newTitle, newPersonalTitle, newPhone, newJobFunction||null, newCity||null, newSecondary, newAvatar, newCountry, newTimezone, newLinkedin, newCertGiven, newCertFamily, _newUpdatedAt, user.id, _expUpd, _expUpd);
      // better-sqlite3 rolls the transaction back on a throw, so the staged
      // email write and the credential revocation below cannot land either.
      if (_swapped.changes === 0) throw new StaleRowError(_expUpd);
      if (emailChanged) {
        // Stage the new primary; current email + verified stay live until confirm.
        db.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
          .run(newEmail, pendingCode, pendingAt, user.id);
      } else if (user.pending_email) {
        // Re-submitting the current email cancels any prior pending change.
        db.prepare("UPDATE users SET pending_email=NULL, pending_email_code=NULL, pending_email_code_at=NULL WHERE id=?").run(user.id);
      }
      //
      // A SECONDARY-ADDRESS CHANGE LEAVES THE LIVE SIGN-IN CODE ALONE. A code is
      // mailed to the PRIMARY address and redeemed against it only, so the
      // secondary inbox never holds one, and clearing it here would only destroy
      // a code the person may be typing. The primary is only STAGED by this
      // handler; /confirm-email revokes the code when it swaps the address.
    });
    profileTxn();
    _invalidateMeCache(req.session.userId);
    // The version moved, and the admin Participants list is cached 5 s off a
    // payload that carries it. Without this bust an admin who opened an
    // Edit-Profile dialog inside that window holds a stale `updated_at` and is
    // 409'd on a save that had no real conflict — a spurious refusal created by
    // our own cache. Pre-v8.x this route busted only the me-cache, which was
    // correct while nothing on the admin wire moved on a self-edit.
    invalidateAdminParticipantsCache();
  } catch (e) {
    // The image row is written just before the transaction (it must exist for
    // the UPDATE to reference), so a failed commit would still orphan it — the
    // 409 below is a REACHABLE path (a nickname taken between our check and the
    // write). Reclaim the blob before returning.
    if (_pendingAvatar && newAvatar) { try { deleteAvatarImage(newAvatar); } catch (e) { swallowed("participant:reclaim-pending-avatar", e); } }
    if (e instanceof StaleRowError) {
      // Re-read AFTER the rollback, so the value handed back is the committed
      // one the client must re-sync to — `user.updated_at` was read at the top
      // of the handler and is by definition the value that just lost.
      const _cur = db.prepare(`SELECT ${profileVersionSql()} AS updated_at FROM users WHERE id=?`).get(user.id);
      return res.status(409).json({
        error: "Your profile was changed elsewhere since you opened it. Reload to see the latest values, then retry.",
        conflict: true,
        currentUpdatedAt: _cur?.updated_at || null,
      });
    }
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Nickname or email is already taken." });
    throw e;
  }
  // v7.14.0 — a profile edit under impersonation (superadmin-only; the guard
  // blocks regular admins) is attributed to the acting admin.
  //
  // v7.21.32 — hoisted OUT of the selfChanges block, which is where it used to
  // live. The email emits below need it too, and an email-only change leaves
  // selfChanges empty (the address is staged as pending_email, not applied), so
  // referencing it from there threw a ReferenceError that the surrounding
  // try/catch swallowed — the event simply never appeared. Every emit in this
  // handler is wrapped in a catch, so a scoping slip here is SILENT.
  const _impMe = isImpersonating(req);
  const selfIdentity = _impMe ? impersonationActor(req.session) : user.email;
  if (Object.keys(selfChanges).length) {
    try { recordUserEvent(user.id, "profile_updated_self", selfIdentity, { ...reqContext(req), changes: selfChanges, ...(_impMe ? { impersonated_by: impersonationActor(req.session) } : {}) }); } catch (e) { swallowed("participant:profile-updated-audit", e); }
  }
  if (emailChanged) {
    try { recordUserEvent(user.id, "email_change_requested", selfIdentity, { ...reqContext(req), pending_email: newEmail, ...(_impMe ? { impersonated_by: impersonationActor(req.session) } : {}) }); } catch (e) { swallowed("participant:email-change-requested-audit", e); }
  } else if (user.pending_email) {
    try { recordUserEvent(user.id, "email_change_cancelled", selfIdentity, { ...reqContext(req), was_pending: user.pending_email, ...(_impMe ? { impersonated_by: impersonationActor(req.session) } : {}) }); } catch (e) { swallowed("participant:email-change-cancelled-audit", e); }
  }

  // Clean up old avatar image blob if avatar changed to something different
  if (newAvatar !== oldAvatar) deleteAvatarImage(oldAvatar);

  // v7.5.0 — pending-email confirmation. The CURRENT email stays active (no
  // logout, no verified flip); we just send a confirmation link to the new
  // address. The swap happens only when the user clicks it (POST /confirm-email),
  // which re-checks system-wide uniqueness. The pending is staged regardless of
  // SMTP outcome (no lockout risk — the live account is untouched; an undelivered
  // pending simply expires in 48h or is replaced on the next edit), and we report
  // emailDelivered so the SPA can prompt a retry — mirroring registration.
  if (emailChanged) {
    const platformName = getPlatformName();
    const link = `${BASE_URL}/confirm-email?code=${encodeURIComponent(pendingCode)}`;
    const { html, text } = buildEmail(platformName, {
      greeting: newFirst || user.first_name || user.nickname,
      body: `<p>We received a request to change your ${escapeHtml(platformName)} sign-in email to <strong>${escapeHtml(newEmail)}</strong>. To confirm the change, open the link below within 48 hours. Until you confirm, your current email stays active and nothing changes.</p>`,
      linkUrl: link, linkText: "Confirm My New Email Address",
      fallbackNote: "If you did not request this, you can ignore this email — your account is unchanged.",
    });
    // Bounded (lib/util.js awaitDeliveryWithDeadline): the pooled relay's queue
    // must not hold this answer past the browser's own abort. `null` is still queued.
    const delivered = await awaitDeliveryWithDeadline(sendEmailLogged(user.id, { to: newEmail, subject: `${platformName} — Confirm Your New Email Address`, html, text }, "email_change_confirmation", { competitionId: null }), MAIL_REPORT_DEADLINE_MS, "participant:email-change-mail");
    _invalidateMeCache(user.id);
    return res.json({
      ok: true,
      emailChangePending: true,
      pendingEmail: newEmail,
      emailDelivered: delivered,
      ...(delivered === null ? { emailDeferred: true } : {}),
      message: delivered === null
        ? `Your email change to ${newEmail} is staged and the confirmation email is still being sent. Your current email stays active until you click the link in that message.`
        : delivered
        ? `Confirmation sent to ${newEmail}. Your current email stays active until you click the link in that message.`
        : `Your email change to ${newEmail} is staged, but the confirmation email could not be delivered. Your current email stays active — try again later or contact your event organiser.`,
    });
  }

  // No primary-email change (and any prior pending was cleared above).
  res.json({ ok: true, emailChanged: false, emailChangePending: false });
});

// (An account's password is set and changed by PUT /api/me/sign-in-method,
// routes/auth.js.)

// The /api/status body, shared by GET /api/status and the participant pulse
// (GET /api/participant/pulse) so the two can never describe a participant's
// window differently. `marks` (optional) receives the perf-span timestamps the
// status route reports when it is slow.
function _participantStatusPayload(req, marks) {
  const comp = req.competition;
  // For multi-slot: use the participant's timeslot times
  const ts = req.timeslot;
  // v6.20.x — reuse the timeslots fetched once in requireCompetitionContext
  // (req.competitionSlots) instead of letting each helper re-query. compEnd is
  // computed once and reused for both the non-timeslot activeEnd branch and the
  // competition_end field.
  const slots = req.competitionSlots;
  const compEnd = competitionEffectiveEnd(comp, slots);
  const activeStart = ts ? new Date(ts.start_time) : new Date(comp.start_time);
  const activeEnd = ts ? timeslotEffectiveEnd(ts) : compEnd;
  const activeStatus = ts ? timeslotStatus(ts) : req.competitionStatus;
  const fullyEnded = competitionFullyEnded(comp, slots);
  // ── v8.6.0 — THE LATE-ENTRY WINDOW, from THIS participant's point of view ────
  //
  // `status` and `end` on this endpoint have never described the EVENT — they
  // describe the caller's OWN window, which is why a multi-session competition
  // answers with the participant's timeslot rather than the competition. A late
  // entrant's window is open until the late deadline, so that is what they are
  // told, and every client mechanism built on those two fields — the countdown,
  // the ended popup, the `S._inLiveCompetition` keepalive arm that stops a
  // participant being signed out mid-answer — keeps working with no special case.
  //
  // The `late_entry` block rides alongside so the UI can SAY what is happening
  // rather than pretending the event is simply live: a countdown with no
  // explanation, on an event the picker lists as finished, is the kind of
  // contradiction an organiser gets asked about.
  const _le = req.lateEntry || { allowed: false, open: false, deadline: null, isLate: false, canPlay: false };
  const _lateActive = !!_le.canPlay;
  if (marks) marks.tCalc = process.hrtime.bigint();
  const cu = db.prepare("SELECT ended_popup_seen FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, req.session.userId);
  if (marks) marks.tDb = process.hrtime.bigint();
  return {
    status: _lateActive ? "live" : activeStatus,
    start: activeStart.toISOString(),
    end: (_lateActive && _le.deadline ? _le.deadline : activeEnd).toISOString(),
    competition_name: comp.name,
    competition_fully_ended: fullyEnded,
    competition_end: compEnd?.toISOString() || null,
    timeslot_name: ts?.name || null,
    ended_popup_seen: !!(cu?.ended_popup_seen),
    // v6.16.2 — surface the per-comp reveal flag so the SPA's
    // "answers will be revealed once all sessions end" popup copy
    // can be conditioned on it. Without this, the popup lies when
    // the comp has reveal_answers_on_end=false (the default).
    reveal_answers_on_end: !!comp.reveal_answers_on_end,
    // v8.1.0 (PR 12) — the kind and its resolved policy on the poll every
    // participant issues every 15 s. `end` deliberately stays NON-nullable: it is
    // derived from competitionEffectiveEnd, which never returns null for a real
    // competition, and publishing a nullable field the server cannot produce would
    // ship a client branch that never executes.
    event_kind: comp.event_kind,
    policy: eventPolicyForWire(comp),
    // OPEN-ENDED: the participant list's own `open_ended` (isOpenEnded, per
    // read). While it holds the header countdown and the play bar say "No fixed
    // deadline" instead of the time left (operator ruling, 14 Nov 2026); the
    // pulse re-reads it with `end`, so a deadline moved in counts down again
    // (the time left) at the next pulse. Only a deadline kind (no sessions, no
    // late window) is ever open-ended, so it describes the caller's window too.
    open_ended: isOpenEnded(comp, slots),
    // The event's OWN end, unchanged by the late window — so the client can render
    // "the event ended at X, you have until Y" rather than only the deadline. It is
    // already published as `competition_end` above; this block adds the three facts
    // that are not derivable from it.
    late_entry: {
      // Does this event run a late window at all? (policy + the per-event toggle)
      enabled: !!_le.allowed,
      // Is it open right now — for anyone, not just this caller?
      window_open: !!_le.open,
      // Is THIS caller a late entrant?
      is_late_entrant: !!_le.isLate,
      deadline: _le.deadline ? _le.deadline.toISOString() : null,
    },
  };
}

app.get("/api/status", requireParticipant, requireCompetitionContext, (req, res) => {
  // v6.10.87 — diagnostic-only unconditional perf-span. The v6.10.84
  // env-gated version and the v6.10.86 total-wall-clock fix BOTH failed
  // to produce log lines in back-to-back WAN runs despite
  // status_poll p(90)=1.05 s (threshold 500 ms). Something in the
  // gate chain (NODE_ENV / .maintenance file visibility inside the
  // container / fs.existsSync semantics) is still evaluating to
  // false. Rather than keep guessing, drop the gate: always time,
  // always log when total > 300 ms. hrtime.bigint is sub-microsecond
  // so the per-request overhead is noise, and the log write is
  // already rate-limited by the 300-ms threshold. Revert once we
  // have the breakdown.
  const tHandler = process.hrtime.bigint();
  const marks = {};
  const payload = _participantStatusPayload(req, marks);
  const tCalc = marks.tCalc, tDb = marks.tDb;
  res.json(payload);
  const tRespond = process.hrtime.bigint();
  const bodyMs = Number(tRespond - tHandler) / 1e6;
  const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
  const totalMs = preludeMs + bodyMs;
  // v6.10.89 — revert v6.10.88's every-call logging. The diagnostic
  // answered the question: server-side /api/status is sub-2 ms
  // median (prelude ~0.4 ms, body ~0.24 ms, db ~0.03 ms). The k6-
  // observed 1.05 s status_poll p(90) is entirely network +
  // TLS handshake + edge queue, NOT server work. Threshold restored
  // to 300 ms so the log stays quiet on a healthy WAN run; if
  // server-side time ever does exceed 300 ms under load (e.g. session
  // store contention, DB lock), the breakdown fires and surfaces
  // the cause. No env gate — that was the v6.10.87 bug that kept
  // producing zero log output.
  if (totalMs > PERF_SPAN_SLOW_MS) {
    const calcMs   = Number(tCalc - tHandler) / 1e6;
    const dbMs     = Number(tDb - tCalc) / 1e6;
    const respMs   = Number(tRespond - tDb) / 1e6;
    log.warn({
      req_id: req.id,
      endpoint: "/api/status",
      total_ms: totalMs.toFixed(1),
      prelude_ms: preludeMs.toFixed(1),
      body_ms: bodyMs.toFixed(2),
      calc_ms: calcMs.toFixed(2),
      db_ended_popup_ms: dbMs.toFixed(2),
      respond_ms: respMs.toFixed(2),
    }, "[perf-span] slow /api/status");
  }
});

// THE PARTICIPANT PULSE — one poll instead of three.
//
// A participant in a live event used to run three timers against the server:
// GET /api/status every 15 s (early end, extension, removal), GET /api/me every
// 15 s for the score pill, and GET /api/session/status every 30 s for the session
// monitor — plus the leaderboard every 15 s while its page was open. At 3000 tabs
// that is ~600 requests a second on a process whose one thread costs ~3 ms per
// request (perf/RESULTS.md), which is the whole thread. The pulse answers all of
// them in one request: the /api/status body byte-for-byte (`status`, built by the
// same function), the caller's score (the same `getParticipantScore` /api/me
// uses), the board's version (`lb_version`: the client fetches the board only
// when it moves — see lib/leaderboard.js `leaderboardVersion`), and the live
// session's half of GET /api/session/status (`session`), so the monitor need not
// ask while pulses answer.
//
// It is a POLL, exactly like the three it replaces: a GET, so it never slides the
// session; never on the presence action allow-list, so it banks presence only
// with `X-Client-Active` (sent within 60 s of user intent); competition-scoped
// through requireCompetitionContext, so the tab-event check, the profile gate and
// the lifecycle refusals answer it as they answered /api/status. A dead session
// gets requireParticipant's 401 and the client's one sign-out classifier, never a
// `session.active:false` here: the unauthenticated probe stays GET
// /api/session/status. The body is a pure function of state, so an unchanged
// pulse revalidates to 304 through Express's ETag.
app.get("/api/participant/pulse", requireParticipant, requireCompetitionContext, (req, res) => {
  // Timed like /api/status, whose slow-request line this poll inherited when it
  // became a participant's one regular poll.
  const tHandler = process.hrtime.bigint();
  const marks = {};
  const status = _participantStatusPayload(req, marks);
  const compId = req.competition.id;
  const uid = req.session.userId;
  const roleRow = db.prepare("SELECT role FROM users WHERE id=?").get(uid);
  const score = getParticipantScore(uid, compId, req.session.timeslotId);
  const tScore = process.hrtime.bigint();
  const lbVersion = leaderboardVersion(compId);
  const tVersion = process.hrtime.bigint();
  res.json({
    status,
    score,
    lb_version: lbVersion,
    session: {
      active: true,
      expires_at: req.session.cookie?.expires ? new Date(req.session.cookie.expires).toISOString() : null,
      server_started_at: SERVER_STARTED_AT,
      role: (roleRow && roleRow.role) || "participant",
      user_id: uid,
      impersonating: !!req.session.impersonator,
      admin_view: !!req.session.isAdmin,
    },
  });
  const tRespond = process.hrtime.bigint();
  const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
  const totalMs = preludeMs + Number(tRespond - tHandler) / 1e6;
  if (totalMs > PERF_SPAN_SLOW_MS) {
    const tStatus = marks.tDb || tHandler;
    log.warn({
      req_id: req.id,
      endpoint: "/api/participant/pulse",
      total_ms: totalMs.toFixed(1),
      prelude_ms: preludeMs.toFixed(1),
      status_ms: (Number(tStatus - tHandler) / 1e6).toFixed(2),
      score_ms: (Number(tScore - tStatus) / 1e6).toFixed(2),
      lb_version_ms: (Number(tVersion - tScore) / 1e6).toFixed(2),
      respond_ms: (Number(tRespond - tVersion) / 1e6).toFixed(2),
    }, "[perf-span] slow /api/participant/pulse");
  }
});

app.post("/api/dismiss-ended", requireParticipant, requireCompetitionContext, csrfProtection, (req, res) => {
  const r = db.prepare("UPDATE competition_users SET ended_popup_seen=1 WHERE competition_id=? AND user_id=?")
    .run(req.competition.id, req.session.userId);
  if (r.changes) {
    try {
      const selfEmail = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "self";
      recordUserEvent(req.session.userId, "ended_popup_dismissed", selfEmail, { ...reqContext(req), competition_id: req.competition.id, competition_name: req.competition.name, ...(isImpersonating(req) ? { impersonated_by: impersonationActor(req.session) } : {}) });
    } catch (e) { swallowed("participant:ended-popup-audit", e); }
  }
  res.json({ ok: true });
});

// /api/config is pre-login and tiny, but still hit on every page load —
// rate-limit to 120/min/IP so a hostile client can't use it as a cheap
// keepalive probe or amplifier (v6.8.0).
// `login_code_ttl_ms` is how long an emailed sign-in code lives
// (`LOGIN_CODE_TTL_MS`, operator-overridable): the sign-in card reopens the code
// step for an address it was mailed a code for only while that code can still
// work, so it reads the lifetime here rather than keeping a copy of the default.
app.get("/api/config", rateLimit(60_000, RATE_LIMIT_CONFIG_PER_MIN, "config"), (req, res) => {
  res.json({ platform_name: getPlatformName(), version: PLATFORM_VERSION, server_started_at: SERVER_STARTED_AT, login_code_ttl_ms: LOGIN_CODE_TTL_MS });
});

// Lightweight session-state probe used by the client's inactivity monitor.
// Does NOT touch the session, so polling this endpoint does not extend the expiry.
// Never returns 401 — reports active=false instead so the client can distinguish
// "logged out" (active=false) from "server restarted" (server_started_at changed).
app.get("/api/session/status", (req, res) => {
  const hasBuiltinAdmin = req.session.builtinId === "superadmin";
  let hasUser = !!req.session.userId;
  let role = null;
  if (hasBuiltinAdmin) {
    role = "superadmin";
  } else if (hasUser) {
    // Defence-in-depth: if the user row is gone (deleted) OR fails any part of
    // the account lifecycle, treat the session as inactive even though the
    // cookie is still valid — otherwise the SPA keeps a ghost authenticated
    // state forever. v7.2.x (audit, F3) — was blocked-only; now mirrors the
    // full requireParticipant gate (blocked / denied / unapproved / unverified-
    // past-grace), so a grace-expired or out-of-band-demoted session reads
    // inactive here too. A grace user still inside the 48h window stays active.
    // v7.21.4 — with ONE documented exception: under impersonation the
    // unverified clause is skipped, because the target's verification gates the
    // PARTICIPANT signing in, not an admin inspecting their view (v7.15.8).
    // This is a read-only probe (no session.destroy / no touch) — it reports
    // inactive; the keepalive path below is what tears the session down.
    const row = db.prepare("SELECT role, blocked, verified, approved, denied_at, self_enroll_grace_until FROM users WHERE id=?").get(req.session.userId);
    // v7.21.4 — see the keepalive note: !verified is NOT inactive under
    // impersonation. This probe is the one the SPA hits FIRST (_sessionMonTick
    // runs immediately inside startSessionMonitor, not after 30 s), so with
    // !verified applied here an admin impersonating an unverified participant
    // got "You were signed out due to inactivity" the instant the view loaded,
    // then reloaded into it again — a loop, not a one-off.
    if (!row || row.blocked || row.denied_at || !row.approved
        || (!req.session.impersonator && !row.verified && !verificationGraceState(row).active)) {
      hasUser = false;
    } else {
      role = row.role || "participant";
    }
  }
  const active = hasUser || hasBuiltinAdmin;
  const expiresAt = active && req.session.cookie?.expires ? new Date(req.session.cookie.expires).toISOString() : null;
  // v6.16.24 — when the session is gone, distinguish "kicked from another
  // browser" (single-session enforcement at login) from "idled out" so
  // the SPA can render the right popup. The kicked browser's cookie
  // still carries the OLD session id, even though the row is deleted —
  // _extractOldSessionId reads it out of the raw Cookie header before
  // express-session creates a fresh empty session for this request. If
  // the old id matches an entry in `_kickedSessions`, the response
  // includes `reason:"kicked"` plus the kicker's IP / UA / name so the
  // SPA's popup can say "Logged in from <name> at <ip>".
  //
  // A purge that is not a sign-in elsewhere records a REASON instead
  // (`SESSION_END` in lib/sessions.js: today only `ended`, any purge, named no
  // further), so the popup says what happened rather than claiming the user
  // was idle.
  let reason = null;
  let kickedBy = null;
  if (!active) {
    const oldSid = _extractOldSessionId(req);
    const ctx = oldSid ? lookupKickedSession(oldSid) : null;
    reason = kickReasonOf(ctx);
    if (reason === "kicked") {
      kickedBy = {
        ip: ctx.ip || null,
        user_agent: ctx.user_agent || null,
        first_name: ctx.first_name || null,
        last_name: ctx.last_name || null,
        email: ctx.email || null,
        builtin: ctx.builtin === true,
        passwordless: ctx.passwordless === true,
        at: ctx.at ? new Date(ctx.at).toISOString() : null,
      };
    }
  }
  // WHO a live session is, and in which VIEW, so a tab can tell "another tab
  // replaced my session" (same account acting as itself, in the view this tab
  // shows: refreshing its CSRF token makes its retry work) from "another tab
  // signed in as somebody else, entered impersonation or switched view"
  // (refreshing would commit its write under that account or view).
  res.json({
    active,
    expires_at: expiresAt,
    server_started_at: SERVER_STARTED_AT,
    role,
    user_id: hasUser ? req.session.userId : null,
    impersonating: hasUser ? !!req.session.impersonator : false,
    admin_view: active ? !!req.session.isAdmin : false,
    reason,
    kicked_by: kickedBy,
  });
});

// Explicit session keepalive — called by the client when it detects recent user
// activity (mousemove/keydown/etc). Resets cookie.maxAge → cookie.expires is
// refreshed to now + maxAge, persisted via session.save().
// Without this, sessions cannot slide forward (rolling:false / resave:false).
app.post("/api/session/keepalive", csrfProtection, (req, res) => {
  if (!req.session.userId && req.session.builtinId !== "superadmin") {
    return res.status(401).json({ error: "Not authenticated" });
  }
  // Defence-in-depth: if the backing user row has been deleted OR fails any
  // part of the account lifecycle, destroy the session and reject so the client
  // can't keep a ghost session alive (and keep sliding its expiry forward) via
  // its activity loop. v7.2.x (audit, F3) — was blocked-only; now mirrors the
  // full requireParticipant gate (blocked / denied / unapproved / unverified-
  // past-grace). A grace user still inside the 48h window is admitted, matching
  // requireParticipant. Session invalidation at delete/role-change time is the
  // primary mechanism; this covers out-of-band lifecycle splits + a grace
  // window that lapses by the clock with no DB write to purge the session.
  if (req.session.userId) {
    const row = db.prepare("SELECT blocked, verified, approved, denied_at, self_enroll_grace_until FROM users WHERE id=?").get(req.session.userId);
    // v7.21.4 — UNVERIFIED is not a refusal under impersonation. v7.15.8 made
    // "a stuck, unverified account is exactly the one an admin needs to look at"
    // the rule and moved TWO gates (the impersonate entry check and
    // requireParticipant). There were FOUR: this one and GET /api/session/status
    // still applied !verified, so the SPA's keepalive force-exited the admin
    // ~30 s in and wrote a spurious impersonation_ended{target_inactive} onto
    // the participant's History. Mirror requireParticipant exactly: blocked /
    // denied / unapproved still end the window for everyone.
    const _impersonating = !!req.session.impersonator;
    if (!row || row.blocked || row.denied_at || !row.approved || (!_impersonating && !row.verified && !verificationGraceState(row).active)) {
      // v7.14.0 — impersonation forced-exit (same as requireParticipant): the
      // failed lifecycle belongs to the TARGET; the session is the ADMIN's.
      // Restore the admin identity instead of destroying.
      if (req.session.impersonator) return restoreImpersonationTargetInactive(req, res);
      req.session.destroy(() => res.status(401).json({ error: "Account is no longer active" }));
      return;
    }
  }
  req.session.touch();
  // v7.14.4 — mutate a session DATA field, not just the cookie. express-session
  // decides whether to emit a refreshed Set-Cookie via isModified(), whose hash
  // EXCLUDES `cookie` — so a pure touch() slid the stored row while the browser
  // kept counting down to its original Expires. That made this endpoint a no-op
  // where it mattered most: every session died a hard ~60 minutes after login,
  // however active the user was, which is exactly the production logout this
  // fixes. One data field flips isModified() true and the refreshed cookie ships.
  req.session.keepaliveAt = Date.now();
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: "Failed to save session" });
    const expiresAt = req.session.cookie?.expires ? new Date(req.session.cookie.expires).toISOString() : null;
    res.json({ ok: true, expires_at: expiresAt });
  });
});

// ── Participant competition endpoints ────────────────────────────────────────

app.get("/api/my-competitions", requireParticipant, requireCompleteProfile, (req, res) => {
  // v6.16.3 — include reveal_answers_on_end so the SPA can gate the
  // session-ended popup copy off this endpoint as well as /api/me /
  // /api/login. See server.js login-handler comment for context.
  // v7.21.19 — `withTags` too. Found while writing the F8 lock: the participant
  // competition PICKER renders the dry-run badge from `c.tags`, and it is fed by
  // /api/me and login (which return tags) on the first paint and by THIS endpoint
  // on every subsequent load and on the 15 s poll — which did not. So the badge
  // appeared and then vanished a few seconds later, on a marker the participant
  // guide documents. Pre-dates the v7.21.18 rename (the old SELECT had no tags
  // either); no new exposure, since the same list already ships tags on the two
  // other surfaces.
  // v8.8.6 — the same narrowing as /api/me. Both are narrowed or the picker and
  // the boot payload disagree about what exists, which reads as a flickering list.
  res.json(listParticipantCompetitions(req.session.userId, { staff: isStaff(req.session.userId), withTags: true, withTimeslots: true, restrictToIds: impersonatorScopedCompetitionIds(req) }));
});

app.post("/api/select-competition", requireParticipant, csrfProtection, (req, res) => {
  _invalidateMeCache(req.session.userId);
  const { competitionId } = req.body;
  // batch 3 (F3): typeof guard — a non-string competitionId would 500 at the
  // getCompetition() / competition_users SQL bind below.
  if (!competitionId || typeof competitionId !== "string") return res.status(400).json({ error: "competitionId required" });
  const comp = getCompetition(competitionId);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // Verify user is assigned (staff can join any competition without DB assignment)
  const staffUser = isStaff(req.session.userId);
  let assigned = db.prepare("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?").get(competitionId, req.session.userId);
  if (!assigned && !staffUser) return res.status(403).json({ error: "You are not assigned to this event" });

  // v8.8.6 — THE LIST IS AN AFFORDANCE; THIS IS THE BOUNDARY. Narrowing the
  // picker alone leaves the change cosmetic: boot re-selects from the session
  // pointer and a hand-made POST needs no picker at all. Refused BEFORE the
  // session write, so an out-of-scope id never becomes context.
  {
    const _denied = impersonationScopeDenied(req, competitionId);
    if (_denied) return res.status(403).json({ error: _denied.message, code: _denied.code });
  }

  // Gate: participant must have a complete profile before entering a competition.
  // v8.4.0 — `SELECT *` carries `registration_competition_id` but NOT the joined
  // event columns `_profileMissingFields` needs, and the function throws rather
  // than guessing. The shared fragment supplies both.
  const _gateUser = db.prepare(`SELECT ${PROFILE_GATE_COLUMNS} FROM users u ${PROFILE_GATE_JOIN} WHERE u.id=?`).get(req.session.userId);
  if (_gateUser) {
    const _missing = _profileMissingFields(_gateUser);
    if (_missing.length) return res.status(400).json({ error: "profile_incomplete", missing: _missing });
  }

  req.session.competitionId = competitionId;
  const status = competitionStatus(comp);

  // v7.14.0 — under impersonation, selecting a competition is PURE NAVIGATION
  // (it is on the impersonationGuard allowlist precisely so a read-only admin
  // can open the target's challenge list). Every durable side effect is
  // suppressed for impersonation sessions — for superadmins too, since these
  // are entry BOOKKEEPING for the real participant, not deliberate actions:
  //   • competition_users.login_time — the solve-clock anchor
  //     (lib/leaderboard.js solveTimeMs); stamping it would permanently start
  //     the TARGET's clock the moment an admin peeked at their view.
  //   • competition_users.last_login_time + the first_joined /
  //     joined_competition_session audit events — "the participant entered"
  //     telemetry that would be false.
  //   • users.active_competition_id — the target's auto-resume marker.
  const _impNav = isImpersonating(req);
  // An event whose clock starts at the FIRST OPEN (lib/event-policy.js
  // `clockStartsAtFirstOpen`) writes no anchor on entry: the branches below take
  // their re-entry path (last_login_time and the re-entry record only), and the
  // anchor waits for `stampClockOnFirstTouch`.
  const _firstOpenClock = clockStartsAtFirstOpen(comp);

  // For multi-slot competitions, check if participant needs to pick a timeslot
  const slots = getCompetitionTimeslots(comp.id);
  const hasSlots = slots.length > 0;
  const chosenTimeslotId = assigned?.timeslot_id || null;
  let timeslotInfo = null;
  const _selfUid = req.session.userId;
  const _selfEmail = () => db.prepare("SELECT email FROM users WHERE id=?").get(_selfUid)?.email || "system";
  const _selfNick = () => db.prepare("SELECT nickname FROM users WHERE id=?").get(_selfUid)?.nickname;
  if (hasSlots && chosenTimeslotId) {
    const ts = getTimeslot(chosenTimeslotId);
    if (ts) {
      req.session.timeslotId = ts.id;
      const tsStatus = timeslotStatus(ts);
      if (assigned && !_impNav && (tsStatus === "live" || tsStatus === "ended")) {
        const loginNow = now().toISOString();
        if (!assigned.login_time && tsStatus === "live" && !_firstOpenClock) {
          // v8.12.0 — the honest anchor (lib/competitions.js anchorLoginTime).
          db.prepare("UPDATE competition_users SET login_time=?, last_login_time=? WHERE competition_id=? AND user_id=?")
            .run(anchorLoginTime(_selfUid, competitionId, loginNow), loginNow, competitionId, _selfUid);
          invalidateLeaderboardCacheForEntrant(competitionId);   // a new zero-score row: coalesced (lib/leaderboard.js)
          // v6.10.33 — defer audit writes (3 event inserts + log mirrors)
          // out of the hot path. Under ramp-up load the synchronous inserts
          // lengthened every select-competition's turn on the one event loop
          // (better-sqlite3 is synchronous — requests queue on the loop, not
          // on SQLite's lock), pushing its p(90) near 1 s. Events are write-only
          // audit rows — no downstream read in this request references them.
          // Mirrors the v6.8.2 submit-path deferral.
          const identity = _selfEmail();
          const nickname = _selfNick();
          // v6.16.5 — _deferAudit tracks outstanding work so graceful
          // shutdown can drain in-flight audit rows before db.close().
          _deferAudit(() => {
            try {
              recordUserEvent(_selfUid, "first_joined", identity, { ...reqContext(req), competition_id: competitionId, competition_name: comp.name, timeslot_id: ts.id, timeslot_name: ts.name });
              recordCompetitionEvent(competitionId, "first_joined", identity, { ...reqContext(req), user_id: _selfUid, nickname, timeslot_id: ts.id }, { mirror: false });
              recordTimeslotEvent(ts.id, "first_joined", identity, { ...reqContext(req), user_id: _selfUid, nickname }, { mirror: false });
            } catch (e) { swallowed("participant:timeslot-first-joined-audit", e); }
          });
        } else {
          db.prepare("UPDATE competition_users SET last_login_time=? WHERE competition_id=? AND user_id=?")
            .run(loginNow, competitionId, _selfUid);
          const identity = _selfEmail();
          _deferAudit(() => {
            try { recordUserEvent(_selfUid, "joined_competition_session", identity, { ...reqContext(req), competition_id: competitionId, competition_name: comp.name, timeslot_id: ts.id, timeslot_name: ts.name, last_login_time: loginNow }); } catch (e) { swallowed("participant:timeslot-rejoined-audit", e); }
          });
        }
      }
      timeslotInfo = { id: ts.id, name: ts.name, start_time: ts.start_time, duration_minutes: ts.duration_minutes, ended_at: ts.ended_at, status: tsStatus, effective_end: timeslotEffectiveEnd(ts)?.toISOString() || null };
    }
  } else if (hasSlots) {
    req.session.timeslotId = null;
  } else {
    req.session.timeslotId = null;
    if (assigned && !_impNav && (status === "live" || status === "ended")) {
      const loginNow = now().toISOString();
      if (!assigned.login_time && status === "live" && !_firstOpenClock) {
        // v8.12.0 — the honest anchor (lib/competitions.js anchorLoginTime).
        db.prepare("UPDATE competition_users SET login_time=?, last_login_time=? WHERE competition_id=? AND user_id=?")
          .run(anchorLoginTime(_selfUid, competitionId, loginNow), loginNow, competitionId, _selfUid);
        invalidateLeaderboardCacheForEntrant(competitionId);   // a new zero-score row: coalesced (lib/leaderboard.js)
        // v6.10.33 — same hot-path deferral as the multi-slot branch above.
        const identity = _selfEmail();
        const nickname = _selfNick();
        _deferAudit(() => {
          try {
            recordUserEvent(_selfUid, "first_joined", identity, { ...reqContext(req), competition_id: competitionId, competition_name: comp.name });
            recordCompetitionEvent(competitionId, "first_joined", identity, { ...reqContext(req), user_id: _selfUid, nickname }, { mirror: false });
          } catch (e) { swallowed("participant:first-joined-audit", e); }
        });
      } else {
        db.prepare("UPDATE competition_users SET last_login_time=? WHERE competition_id=? AND user_id=?")
          .run(loginNow, competitionId, _selfUid);
        const identity = _selfEmail();
        _deferAudit(() => {
          try { recordUserEvent(_selfUid, "joined_competition_session", identity, { ...reqContext(req), competition_id: competitionId, competition_name: comp.name, last_login_time: loginNow }); } catch (e) { swallowed("participant:rejoined-audit", e); }
        });
      }
    }
  }
  // Persist active competition in DB so it survives across sessions
  // For multi-slot: only persist if the participant's chosen timeslot is live
  // (v7.14.0 — skipped entirely under impersonation: auto-resume belongs to
  // the real participant, see the _impNav comment above.)
  if (!_impNav) {
    // ENTERING AN EVENT IS THE THING THAT PINS IT — v8.3.15. This used to be
    // conditional on the event's status: LIVE only before v8.3.8, then
    // "anything but ended", so the two most ordinary reasons to come back to an
    // event you had chosen (it has not started yet; it is over and you want to
    // read the answers) were the two the platform forgot. The status clause is
    // gone; ONE predicate, shared with the login read that consumes it.
    //
    // The `else` branch is gone with it, and its removal is not a tidy-up: it
    // CLEARED the marker for a status it disapproved of, so a participant who
    // opened an ended event lost the pin they had, silently, as a side effect of
    // looking at it.
    const priorActive = db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(req.session.userId)?.active_competition_id || null;
    const selfEmail = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "self";
    if (autoResumeAllows(comp)) {
      // v8.3.12 — choosing again SPENDS the departure: `left_event_at` records
      // "they went back to the list", and this is them coming back.
      db.prepare("UPDATE users SET active_competition_id=?, left_event_at=NULL WHERE id=?").run(competitionId, req.session.userId);
      if (priorActive !== competitionId) try { recordUserEvent(req.session.userId, "active_competition_changed", selfEmail, { ...reqContext(req), from: priorActive, to: competitionId }); } catch (e) { swallowed("participant:active-competition-audit", e); }
    }
  }
  const effEnd = competitionEffectiveEnd(comp);
  const allTimeslots = hasSlots ? slots.map(ts => ({
    id: ts.id, name: ts.name, start_time: ts.start_time, duration_minutes: ts.duration_minutes,
    ended_at: ts.ended_at, status: timeslotStatus(ts), effective_end: timeslotEffectiveEnd(ts)?.toISOString() || null,
  })) : [];
  res.json({
    ok: true,
    competition: {
      id: comp.id, name: comp.name, start_time: comp.start_time, duration_minutes: comp.duration_minutes,
      ended_at: comp.ended_at, status, effective_end: effEnd?.toISOString() || null,
      leaderboard_mode: comp.leaderboard_mode || "per_slot",
      // v6.16.3 — exposes the per-comp flag so the SPA can gate
      // session-ended copy off this response (used when the user picks
      // a comp from the picker without going through /api/me).
      reveal_answers_on_end: !!comp.reveal_answers_on_end,
      fully_ended: competitionFullyEnded(comp),
      // v8.1.0 (PR 12) — this response is how the SPA learns about a competition
      // picked from the picker WITHOUT going through /api/me (the v6.16.3 reason
      // the reveal flag is here), so it needs the kind and the policy for the same
      // reason: the view is routed off this payload.
      event_kind: comp.event_kind,
      policy: eventPolicyForWire(comp),
    },
    timeslots: allTimeslots,
    chosenTimeslot: timeslotInfo,
    needsTimeslotChoice: hasSlots && !chosenTimeslotId,
  });
});

// ── Timeslot selection (participant) ────────────────────────────────────────

// v8.3.8 — the deliberate exit, and the whole of the opt-out from auto-resume.
//
// Going back to the event list is the participant SAYING they are done with the
// event for now, so it clears both the session pointer and the durable marker.
// Without this the resume would be a one-way door: chosen once, re-entered on
// every sign-in for the life of the event, with nothing on any screen to undo it
// — which is the failure the ability to choose an event at all exists to avoid.
//
// PURE NAVIGATION, so it is on the impersonation ALLOWLIST for the same reason
// select-competition is (v7.14.0): a read-only admin who clicks "Events" must
// not meet a "not allowed" modal. The durable write is suppressed under
// impersonation exactly as its inverse is — the marker belongs to the real
// participant, and an admin peeking must not decide where they land next time.
//
// Idempotent, and it answers `ok` whether or not anything was pointing anywhere:
// the client calls it on the way to a page it is going to show regardless, so a
// refusal here would only ever strand the navigation.
app.post("/api/deselect-competition", requireParticipant, requireCompleteProfile, csrfProtection, (req, res) => {
  _invalidateMeCache(req.session.userId);
  const priorSession = req.session.competitionId || null;
  req.session.competitionId = null;
  req.session.timeslotId = null;
  let clearedMarker = false;
  if (!isImpersonating(req)) {
    const priorActive = db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(req.session.userId)?.active_competition_id || null;
    // v8.3.12 — RECORD THE DEPARTURE ITSELF, not just its effect. Clearing the
    // marker says "nothing is pinned"; it cannot say "they unpinned it", and the
    // sole-event landing rule needs to tell those apart or it puts a
    // single-event participant straight back in at the next sign-in and the
    // opt-out is real for everyone except the people it matters most to.
    // Stamped whether or not a marker was set, because pressing Events IS the
    // departure — someone who never chose has still now said "show me the list".
    db.prepare("UPDATE users SET left_event_at=? WHERE id=?").run(now().toISOString(), req.session.userId);
    if (priorActive) {
      db.prepare("UPDATE users SET active_competition_id=NULL WHERE id=?").run(req.session.userId);
      clearedMarker = true;
      const selfEmail = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "self";
      try { recordUserEvent(req.session.userId, "active_competition_changed", selfEmail, { ...reqContext(req), from: priorActive, to: null, reason: "left_event_view" }); } catch (e) { swallowed("participant:left-event-audit", e); }
    }
  }
  res.json({ ok: true, cleared: !!priorSession || clearedMarker });
});

app.post("/api/select-timeslot", requireParticipant, requireCompleteProfile, csrfProtection, async (req, res) => {
  _invalidateMeCache(req.session.userId);
  const { timeslotId, confirmLive } = req.body;
  // batch 3 (F3): typeof guard — a non-string timeslotId would 500 at the
  // getTimeslot() / SQL binds below.
  if (!timeslotId || typeof timeslotId !== "string") return res.status(400).json({ error: "timeslotId required" });
  const compId = req.session.competitionId;
  // v8.14.4 — the tab's own event, as on every competition-scoped route
  // (lib/middleware.js `tabEventMismatch`): a slot belongs to one event, so
  // nothing here can land on the wrong one, but a tab another tab moved is told
  // so rather than "Session not found in this event".
  if (!compId) {
    const _left = tabEventMismatch(req, null);
    if (_left) return res.status(409).json(_left);
    return res.status(400).json({ error: "No event selected. Select an event first." });
  }

  const comp = getCompetition(compId);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  { const _moved = tabEventMismatch(req, comp); if (_moved) return res.status(409).json(_moved); }
  const ts = getTimeslot(timeslotId);
  if (!ts || ts.competition_id !== compId) return res.status(404).json({ error: "Session not found in this event" });

  const _staffTagged = isStaff(req.session.userId);
  const assigned = db.prepare("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, req.session.userId);
  if (!assigned && !_staffTagged) return res.status(403).json({ error: "You are not assigned to this event" });
  // v8.12.0 — A COMPETING STAFF MEMBER IS A PARTICIPANT HERE. Every `staffUser`
  // exemption below (the slot lock, the history pin, the live-session confirm,
  // twice) exists because staff SPECTATE: they hold no row, so there is nothing
  // to lock and no board to protect. On an event where staff compete they hold
  // a row and ARE on the board, so a staff member who could switch sessions at
  // will would be the one participant with two slots' worth of history — the
  // split the history pin exists to prevent. `staffUser` therefore means
  // "staff-tagged AND NOT competing here", and every exemption reads that.
  const staffUser = _staffTagged && !(assigned && staffCompeteOn(comp));

  // Check locking: if participant already entered a live timeslot, they can't change (staff exempt)
  //
  // "Entered" is the solve-clock anchor on an entry-clock event. On a FIRST-OPEN
  // clock event (`clockStartsAtFirstOpen`) entering a live session stamps no
  // anchor, only `last_login_time`, so that column is what records the entry
  // there — the confirm promised "once you join, you cannot change your choice",
  // and opening no challenge must not reopen the choice.
  const _firstOpenClock = clockStartsAtFirstOpen(comp);
  const _enteredSlot = !!(assigned?.login_time || (_firstOpenClock && assigned?.last_login_time));
  if (!staffUser && _enteredSlot && assigned?.timeslot_id) {
    const currentTs = getTimeslot(assigned.timeslot_id);
    if (currentTs) {
      const currentStatus = timeslotStatus(currentTs);
      if (currentStatus === "live" || currentStatus === "ended") {
        return res.status(400).json({ error: "You have already entered a live session and cannot change your choice." });
      }
    }
  }
  // v6.12.0 — second lock scoped to remove+re-add. After an admin
  // removes + re-adds a participant, their competition_users row is
  // fresh (login_time=NULL, timeslot_id=NULL) so the login_time+
  // timeslot_id predicate above CANNOT fire even though the user has
  // a prior-session history recorded on submissions.timeslot_id /
  // hint_reveals.timeslot_id. Consult that history directly: if ANY
  // prior activity in this competition is pinned to a specific
  // timeslot_id different from the one being requested, reject.
  // Mirrors the product rule "re-added user cannot change slot";
  // without this the per-slot leaderboards would split a single
  // participant across two slots (submissions.timeslot_id = X stays
  // in slot X's board while cu.timeslot_id = Y would also attach
  // them to slot Y's board).
  if (!staffUser && (!_enteredSlot || !assigned?.timeslot_id)) {
    const priorSlot = db.prepare(
      `SELECT timeslot_id FROM (
         SELECT timeslot_id FROM submissions
           WHERE user_id=? AND competition_id=? AND timeslot_id IS NOT NULL
         UNION ALL
         SELECT timeslot_id FROM hint_reveals
           WHERE user_id=? AND competition_id=? AND timeslot_id IS NOT NULL
       ) LIMIT 1`
    ).get(req.session.userId, compId, req.session.userId, compId);
    if (priorSlot && priorSlot.timeslot_id && priorSlot.timeslot_id !== timeslotId) {
      // v6.16.12 — orphan-history relaxation. If the historical slot
      // no longer exists (admin deleted it between the user's removal
      // and re-add — see /api/admin/competitions/:id/timeslots/:tsId
      // DELETE), the user would otherwise be permanently stuck: can't
      // pick the deleted slot, can't pick any current slot. The
      // history-pinned lock at v6.12.0 is meant to prevent leaderboard
      // splitting across multiple ACTIVE slots; if the historical slot
      // is gone, that hazard doesn't apply, so let the user pick any
      // current slot. The submissions/hint_reveals rows still carry the
      // old timeslot_id (orphan-but-harmless: the per-slot leaderboard
      // join filters them out cleanly because they don't match any
      // current slot id).
      const priorSlotExists = db.prepare(
        "SELECT 1 FROM competition_timeslots WHERE id=?"
      ).get(priorSlot.timeslot_id);
      if (priorSlotExists) {
        return res.status(400).json({ error: "You previously entered a different session in this event and cannot change your choice." });
      }
      // else: priorSlot.timeslot_id orphaned, fall through to allow
      // the new slot pick.
    }
  }

  const tsStatus = timeslotStatus(ts);
  // Staff looking at an event they do not compete in may open an ENDED session
  // too, to read its challenges and board (a reported bug: an admin in
  // Participant View could not switch between an ended event's sessions). It
  // records nothing a participant's entry would: the solve-clock stamp is
  // live-only, and they hold no row to lock.
  if (tsStatus === "ended" && !staffUser) return res.status(400).json({ error: "This session has already ended." });

  // If timeslot is live, require confirmation (staff exempt — they can switch freely)
  if (!staffUser && tsStatus === "live" && !confirmLive) {
    return res.status(200).json({
      ok: false, requireConfirmation: true,
      message: "This session is currently live. Once you join, you cannot change your choice. Are you sure?",
    });
  }

  // v6.8.3 — wrap EVERY write that depends on the timeslot being non-ended
  // inside the same transaction as the status recheck. Previously only the
  // competition_users.timeslot_id write was transactional; the downstream
  // UPDATE competition_users SET login_time AND UPDATE users SET
  // active_competition_id ran outside, leaving a race where a timeslot
  // that ended between the tx commit and those later writes would still
  // mark the participant as "joined a live slot" — and next login would
  // auto-resume them into an ended competition. All writes now commit or
  // roll back together; re-read status inside the tx so the branch
  // decision (live vs upcoming) also sees a consistent snapshot.
  const priorTsId = assigned?.timeslot_id || null;
  const priorActive2 = db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(req.session.userId)?.active_competition_id || null;
  const selfEmail2 = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "self";
  const selfNick = db.prepare("SELECT nickname FROM users WHERE id=?").get(req.session.userId)?.nickname || null;
  // v7.14.0 — a select-timeslot under impersonation is only reachable from a
  // SUPERADMIN-origin session (impersonationGuard blocks regular-admin writes).
  // The slot CHOICE itself (competition_users.timeslot_id) + the reminder wipe
  // are the deliberate, confirmed action and go through; but the solve-clock
  // stamp (login_time), auto-resume (active_competition_id) and the
  // first_joined / joined_competition_session "participant entered" telemetry
  // are entry bookkeeping for the REAL participant and are suppressed — same
  // rationale as select-competition above.
  const _impSel = isImpersonating(req);
  const _impSelCtx = _impSel ? { impersonated_by: impersonationActor(req.session) } : {};
  // v8.8.9 — every emit below is DEFERRED past the commit, so the request
  // context is read here, while `req` is still in hand.
  const _selReqCtx = reqContext(req);
  const pendingEvents = [];
  const queueEvent = (fn, ...args) => pendingEvents.push([fn, args]);
  let txState = { rejected: null, freshStatus: null, firstTime: false, reminderCleared: false, activePinned: false, loginNowIso: null };

  { const _d = testSelectTimeslotDelay(); if (_d) await new Promise(r => setTimeout(r, _d)); }
  const selectTxn = db.transaction(() => {
    const fresh = db.prepare("SELECT * FROM competition_timeslots WHERE id=?").get(timeslotId);
    if (!fresh) { txState.rejected = "not_found"; return; }
    const freshStatus = timeslotStatus(fresh);
    if (freshStatus === "ended" && !staffUser) { txState.rejected = "ended"; return; }
    // ext-audit v7.15.15 — re-apply the LIVE-confirmation requirement here.
    //
    // Status is time-derived, so a slot that read `upcoming` at the top of the
    // handler can be `live` by the time this transaction runs — landing exactly
    // on the start boundary. The transaction re-read the status but only used it
    // to reject an ENDED slot, so a participant crossing that boundary was
    // stamped into a live session WITHOUT the "you cannot change your choice"
    // confirmation, and then told the session was still upcoming.
    if (!staffUser && freshStatus === "live" && !confirmLive) { txState.rejected = "needs_confirmation"; return; }
    txState.freshStatus = freshStatus;

    if (assigned) {
      db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?")
        .run(timeslotId, compId, req.session.userId);
    }
    // Wipe any prior reminder (user may re-set after re-selecting a slot).
    const delR = db.prepare("DELETE FROM email_reminders WHERE user_id=? AND competition_id=?")
      .run(req.session.userId, compId);
    if (delR.changes) txState.reminderCleared = true;

    if (freshStatus === "live" && !_impSel && _firstOpenClock) {
      // A first-open clock: entering the live session records the entry
      // (`last_login_time`, which the slot lock above reads) and starts nothing.
      const loginNow = now().toISOString();
      txState.loginNowIso = loginNow;
      db.prepare("UPDATE competition_users SET last_login_time=? WHERE competition_id=? AND user_id=?")
        .run(loginNow, compId, req.session.userId);
    } else if (freshStatus === "live" && !_impSel) {
      const loginNow = now().toISOString();
      txState.loginNowIso = loginNow;
      txState.firstTime = !assigned?.login_time;
      // v8.12.0 — a FIRST anchor is the honest one (lib/competitions.js
      // anchorLoginTime); a re-stamp keeps the clock as it was written.
      db.prepare("UPDATE competition_users SET login_time=?, last_login_time=? WHERE competition_id=? AND user_id=?")
        .run(txState.firstTime ? anchorLoginTime(req.session.userId, compId, loginNow) : loginNow, loginNow, compId, req.session.userId);
    }
    // v8.3.8/v8.3.15 — the solve-clock stamp above is LIVE-only and stays that
    // way; the auto-resume marker is a separate question and is decided by the
    // shared predicate, which no longer asks about status at all. Choosing a
    // SESSION is choosing the event, so it pins exactly as select-competition
    // does — including for a session that has not started, and for one that has
    // finished.
    if (!_impSel && autoResumeAllows(comp)) {
      db.prepare("UPDATE users SET active_competition_id=?, left_event_at=NULL WHERE id=?").run(compId, req.session.userId);
      txState.activePinned = true;
    }
  });
  selectTxn();
  if (txState.rejected === "needs_confirmation") {
    // Same shape the pre-transaction check returns, so the client's existing
    // confirm-then-retry path handles it with no change.
    return res.status(200).json({
      ok: false, requireConfirmation: true,
      message: "This session is currently live. Once you join, you cannot change your choice. Are you sure?",
    });
  }
  if (txState.rejected === "ended") return res.status(400).json({ error: "This session has already ended." });
  if (txState.rejected === "not_found") return res.status(404).json({ error: "Session not found in this event" });
  req.session.timeslotId = timeslotId;
  // v6.9.12: first-time timeslot join adds the user to the comp's
  // leaderboard (login_time set), so the board cache drops it the way
  // /api/select-competition does: the coalesced entrant bust (lib/leaderboard.js).
  // It moves no board version, so an open participant board shows the arrival
  // at its next periodic fetch (LB_FLOOR_MS, public/js/features/leaderboard.js).
  if (txState.firstTime) invalidateLeaderboardCacheForEntrant(compId);   // coalesced, see lib/leaderboard.js

  // All the audit-event writes below are deferred — they run after the tx
  // commits so they don't lengthen the transaction (and each request's turn
  // on the one event loop) during high-churn onboarding (the multi-slot
  // reveal + 200-user first-join storm).
  if (priorTsId !== timeslotId) {
    queueEvent(recordUserEvent, req.session.userId, "session_chosen", _impSel ? impersonationActor(req.session) : selfEmail2, { competition_id: compId, competition_name: comp.name, timeslot_id: ts.id, timeslot_name: ts.name, previous_timeslot_id: priorTsId || null, ..._selReqCtx, ..._impSelCtx });
  }
  if (txState.reminderCleared) {
    queueEvent(recordUserEvent, req.session.userId, "reminder_cleared", _impSel ? impersonationActor(req.session) : selfEmail2, { competition_id: compId, competition_name: comp.name, reason: "timeslot_selected", ..._selReqCtx, ..._impSelCtx });
  }
  // v8.3.15 — KEYED ON THE PIN MOVING, not on the session being live, which is
  // what it always meant. Stated honestly: the two agreed in every REACHABLE
  // case, because `select-competition` runs first and has already recorded the
  // pin by the time a session is chosen, so this emit is a no-op in the ordinary
  // flow and correctly stays one. What the rewrite buys is that the condition now
  // says what it is checking, and the dead `activeCleared` branch it replaced —
  // which could only fire for a status `select-timeslot` rejects outright — is
  // gone rather than sitting there looking reachable.
  if (txState.activePinned && priorActive2 !== compId) {
    queueEvent(recordUserEvent, req.session.userId, "active_competition_changed", selfEmail2, { ..._selReqCtx, from: priorActive2, to: compId, timeslot_id: ts.id });
  }
  // The rest stays live-only, and deliberately: `joined_competition_session` and
  // `first_joined` are about ENTERING a running session, which is a different
  // fact from having chosen one.
  if (txState.freshStatus === "live" && !_impSel) {
    if (!txState.firstTime) {
      queueEvent(recordUserEvent, req.session.userId, "joined_competition_session", selfEmail2, { ..._selReqCtx, competition_id: compId, competition_name: comp.name, timeslot_id: ts.id, timeslot_name: ts.name, last_login_time: txState.loginNowIso });
    } else {
      const details = { ..._selReqCtx, competition_id: compId, competition_name: comp.name, timeslot_id: ts.id, timeslot_name: ts.name };
      queueEvent(recordUserEvent, req.session.userId, "first_joined", selfEmail2, details);
      queueEvent(recordCompetitionEvent, compId, "first_joined", selfEmail2, { ..._selReqCtx, user_id: req.session.userId, nickname: selfNick, timeslot_id: ts.id }, { mirror: false });
      queueEvent(recordTimeslotEvent, ts.id, "first_joined", selfEmail2, { ..._selReqCtx, user_id: req.session.userId, nickname: selfNick }, { mirror: false });
    }
  }
  if (pendingEvents.length) {
    _deferAudit(() => {
      for (const [fn, args] of pendingEvents) {
        // `_selReqCtx` is the context captured at QUEUE time (above). This drain
        // runs on a setImmediate AFTER the response, so reading `req.ip` here —
        // a lazy getter onto the socket — would yield undefined (v8.8.9).
        try { fn(...args); } catch (e) { log.error({ ..._selReqCtx, err: e.message }, "deferred select-timeslot event persist failed"); }
      }
    });
  }

  const effEnd = timeslotEffectiveEnd(ts);
  res.json({
    ok: true,
    // ext-audit v7.15.15 — report the status the transaction actually committed
    // against, not the one read before it. On the start boundary these differ,
    // and answering "upcoming" for a slot the participant was just joined to as
    // LIVE sends the client to the wrong view.
    timeslot: { id: ts.id, name: ts.name, start_time: ts.start_time, duration_minutes: ts.duration_minutes, ended_at: ts.ended_at, status: txState.freshStatus || tsStatus, effective_end: effEnd?.toISOString() || null },
  });
});

// ── Email reminders ─────────────────────────────────────────────────────────

app.get("/api/competitions/:id/reminder", requireParticipant, requireCompleteProfile, (req, res) => {
  // v8.8.6 — scoped for SYMMETRY rather than because it discloses much: the
  // response carries no event name, only whether a reminder exists. Left
  // unscoped it would be a blind existence probe against an id the narrowed
  // picker no longer offers — small, but an undecided gap in a scope feature
  // reads as coverage, so it is decided here rather than recorded as a residual.
  {
    const _denied = impersonationScopeDenied(req, req.params.id);
    if (_denied) return res.status(403).json({ error: _denied.message, code: _denied.code });
  }
  const row = db.prepare("SELECT * FROM email_reminders WHERE user_id=? AND competition_id=?")
    .get(req.session.userId, req.params.id);
  res.json({ requested: !!row, sent: row?.sent === 1, timeslot_id: row?.timeslot_id || null });
});

// The last moment a start reminder is accepted: the dispatcher's 30 s tick plus
// a margin, so a reminder accepted here is normally claimed before its start
// passes (a long batch ahead of it can still delay it past the start, when it is
// skipped as any late reminder is).
const START_REMINDER_MIN_LEAD_MS = 60_000;
app.post("/api/competitions/:id/reminder", requireParticipant, requireCompleteProfile, csrfProtection, (req, res) => {
  {
    const _denied = impersonationScopeDenied(req, req.params.id);
    if (_denied) return res.status(403).json({ error: _denied.message, code: _denied.code });
  }
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  const assigned = db.prepare("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?")
    .get(req.params.id, req.session.userId);
  if (!assigned) return res.status(403).json({ error: "Not assigned to this event" });
  // v8.1.0 (PR 18) — a start reminder is refused for a kind that is not an
  // appointment. A three-week "starts in about 1 hour" mail for self-paced
  // material is the wrong model, and a DEADLINE reminder is a different mechanism
  // that is deliberately out of scope: email_reminders has PK
  // (user_id, competition_id), so a row could carry a start reminder or a deadline
  // reminder but never both, and re-meaning the column per kind would put two
  // semantics on the one value the v7.21.5 dispatcher binds into its claim.
  if (eventPolicy(comp).startReminder === "forbidden") {
    return res.status(400).json({
      error: "This event is self-paced, so there is no start time to remind you about. It stays open until its deadline.",
      code: "start_reminder_forbidden",
    });
  }

  // Determine which start time to use for the reminder
  let startTime, reminderTsId = "";
  const slots = getCompetitionTimeslots(comp.id);
  if (slots.length > 0) {
    // Multi-slot: use the chosen timeslot's start time
    const chosenTs = assigned.timeslot_id ? getTimeslot(assigned.timeslot_id) : null;
    if (!chosenTs) return res.status(400).json({ error: "Please choose a session before setting a reminder" });
    if (timeslotStatus(chosenTs) !== "upcoming") return res.status(400).json({ error: "Your chosen session is not upcoming" });
    startTime = chosenTs.start_time;
    reminderTsId = chosenTs.id;
  } else {
    // Single-slot: use competition start time
    if (competitionStatus(comp) !== "upcoming") return res.status(400).json({ error: "Event is not upcoming" });
    startTime = comp.start_time;
  }
  // NO TIME LEFT TO SEND IT (operator ruling, 25 Nov 2026): no reminder is mailed
  // once its event or session has started, and the dispatcher runs every 30 s,
  // so one set in the last minute would be accepted, promised "on its way now",
  // and then skipped. Refused instead, before any existing reminder is touched.
  // `startTime` is the participant's session's start where they have one.
  if (new Date(startTime).getTime() - Date.now() < START_REMINDER_MIN_LEAD_MS) {
    return res.status(400).json({
      error: "This event starts in under a minute, so there is no time left to send a reminder.",
      code: "start_reminder_too_late",
    });
  }

  // Delete any existing reminder for this competition (max 1 per participant per competition)
  const delPriorR = db.prepare("DELETE FROM email_reminders WHERE user_id=? AND competition_id=?")
    .run(req.session.userId, req.params.id);
  if (delPriorR.changes) try {
    const selfId = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "self";
    recordUserEvent(req.session.userId, "reminder_cleared", selfId, { ...reqContext(req), competition_id: req.params.id, competition_name: comp.name, reason: "reset_before_reset" });
  } catch (e) { swallowed("participant:reminder-cleared-audit", e); }

  // Schedule 1 hour before start
  const sendAt = new Date(new Date(startTime).getTime() - 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO email_reminders (user_id, competition_id, send_at, sent, created_at, timeslot_id) VALUES (?,?,?,0,?,?)")
    .run(req.session.userId, req.params.id, sendAt, now().toISOString(), reminderTsId);
  try {
    const identity = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "system";
    // v7.15.2 (audit) — a superadmin-tier impersonation session can reach this
    // write, so tag it like every other in-impersonation emit; otherwise the
    // participant's History shows a reminder they never asked for.
    const _impRem = isImpersonating(req) ? { impersonated_by: impersonationActor(req.session) } : {};
    recordUserEvent(req.session.userId, "reminder_requested", identity, { ...reqContext(req), competition_id: req.params.id, competition_name: comp.name, timeslot_id: reminderTsId || null, send_at: sendAt, ..._impRem });
  } catch (e) { swallowed("participant:reminder-requested-audit", e); }
  // v8.12.6 (sweep) — THE CONFIRMATION SAYS WHEN THE MAIL WILL REALLY COME. A
  // start under an hour away puts `send_at` in the past, so the next dispatcher
  // tick (≤ 30 s) sends it — while the SPA's toast promised "an email 1 hour
  // before the event starts". The server knows which case this is and the client
  // cannot (its start time can be a poll old, and its clock is not ours), so it
  // is ANSWERED here rather than re-derived there. Stored values and the audit
  // row above are unchanged; this is a response field only.
  res.json({ ok: true, requested: true, immediate: new Date(sendAt).getTime() <= Date.now() });
});

app.get("/api/tasks", requireParticipant, requireCompetitionContext, requireParticipantInCompetition, rateLimit(60_000, 120, "tasks-list"), (req, res) => {
  const compId = req.session.competitionId;
  const _gate = participantContentNotStarted(req);
  // v7.7.26 (audit M16) — carry a structured discriminator alongside the
  // message: the SPA must tell "your window isn't live yet" (route back to
  // the pending/session-picker view) apart from "you're no longer a member"
  // (eject to the competition picker). Message-text matching is brittle.
  if (_gate) return res.status(403).json({ error: _gate.needsSlot ? "Please choose a session to view challenges." : `${sanitiseForLog(_gate.name)} has not started yet`, not_started: true, needsSlot: !!_gate.needsSlot });
  ensureTaskNumbers(compId, req.competition);
  // Per-session question sets: the questions of the session this request plays
  // (lib/session-tasks.js `inSessionSql`; none named: every question).
  const tasks = db.prepare(
    `SELECT t.id, t.title, t.description, t.difficulty, t.answer_type, t.active, ct.task_number
     FROM tasks t
     JOIN competition_tasks ct ON ct.task_id=t.id AND ct.competition_id=?
     WHERE ct.competition_id=? AND t.status='published' AND t.active=1
       AND ${inSessionSql("ct.competition_id", "ct.task_id", "?")}
     ORDER BY ct.task_number, t.difficulty, t.title`
  ).all(compId, compId, req.session.timeslotId || null).sort((a, b) => compareTaskNumbers(a.task_number, b.task_number));   // numerically, not as text; the SQL order breaks ties
  const solved = db.prepare("SELECT DISTINCT task_id FROM submissions WHERE user_id=? AND competition_id=? AND is_correct=1")
    .all(req.session.userId, compId).map(r => r.task_id);
  // v7.21.0 — CATEGORIES. One batched read for the whole page rather than a
  // query per card, and only the parsed NAMES reach the wire: `categoriesFromTags`
  // drops every tag that is not `category:<name>`, so the free-text admin labels
  // on the same challenge (`needs-review`, author names, ticket ids) stay
  // server-side. See lib/categories.js — that one-directional filter is the
  // point of the module.
  const _catMap = new Map();
  if (tasks.length) {
    const _ph = "SELECT value FROM json_each(?)";
    for (const r of db.prepare(
      `SELECT task_id, tag FROM task_tags WHERE task_id IN (${_ph}) ORDER BY tag`
    ).all(JSON.stringify(tasks.map(t => t.id)))) {
      if (!_catMap.has(r.task_id)) _catMap.set(r.task_id, []);
      _catMap.get(r.task_id).push(r.tag);
    }
  }
  // For multi-slot: "ended" means the participant's timeslot has ended (submissions blocked)
  // v8.6.0 — and for a LATE ENTRANT inside an open window it does not, because they
  // can still submit. `hackathon_ended` is what the client reads to REPLACE the
  // answer box with a locked panel, so leaving it true would render a challenge the
  // server would happily accept as unanswerable — the affordance contradicting the
  // rule (v7.14.2), on the one participant the feature exists for.
  const mySlotEnded = (req.timeslot ? timeslotStatus(req.timeslot) === "ended" : req.competitionStatus === "ended")
    && !(req.lateEntry && req.lateEntry.canPlay);
  const fullyEnded = competitionFullyEnded(req.competition, req.competitionSlots);
  // Event team reports — `qualifying` (a boolean, never the tag) so the card says
  // "no points" rather than quoting the difficulty's points (lib/qualifying.js).
  // `qualifying` as scoring reads it (any `qualifying:` tag, a malformed key an
  // older import stored included), so the card agrees with the challenge's own
  // view and with what the answer can score.
  const { tagsMakeQualifying } = require("../lib/qualifying");
  // #283 — `out_of_attempts`, a boolean on every row: true where this
  // participant has not solved the challenge and has spent every attempt they
  // have on it (the cap in force plus any grant), so it would open as "No
  // attempts left". Next challenge passes over it. Derived in lib/attempts.js,
  // never recounted here, and never the cap or a count: those stay on the
  // challenge's own read. False on an uncapped challenge, a solved one and a
  // Quick question whose answer can be changed.
  const outOfAttempts = outOfAttemptsTaskIds(req.session.userId, req.competition, tasks.map(t => t.id));
  // Stage B — a question's TOPIC is its category (lib/topics.js); one with no
  // topic still reads its legacy `category:` tags.
  const _topicNames = topicNamesFor(db, tasks.map(t => t.id));
  res.json(tasks.map(t => ({ ...t, categories: participantCategories(_topicNames.get(t.id), _catMap.get(t.id) || []), qualifying: tagsMakeQualifying(_catMap.get(t.id) || []), solved: solved.includes(t.id), out_of_attempts: outOfAttempts.has(t.id), hackathon_ended: mySlotEnded, competition_fully_ended: fullyEnded })));
});

app.get("/api/tasks/:id", requireParticipant, requireCompetitionContext, requireParticipantInCompetition, _resolveEventTask, rateLimit(60_000, 120, "tasks-get"), (req, res) => {
  const compId = req.session.competitionId;
  // v6.20.x — withhold full challenge content (description, attachment list)
  // until the participant's window is live. See participantContentNotStarted.
  const _gate = participantContentNotStarted(req);
  // v7.7.26 (audit M16) — same structured discriminator as GET /api/tasks.
  if (_gate) return res.status(403).json({ error: _gate.needsSlot ? "Please choose a session to view challenges." : `${sanitiseForLog(_gate.name)} has not started yet`, not_started: true, needsSlot: !!_gate.needsSlot });
  // Verify task is in this competition
  const inComp = db.prepare("SELECT task_number FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, req.params.id);
  if (!inComp) return res.status(404).json({ error: "Challenge not found" });

  // v8.10.0 — `answer_sealed` and `created_by_id` join this SELECT because the
  // reveal branches below consult them (a column-naming SELECT is a list that
  // rots, and this one feeds the ONLY participant-reachable read of the key).
  const task = db.prepare("SELECT id,title,description,difficulty,answer_type,correct_answer,choices,explanation,hint,attachment_url,author_name,author_linkedin,attempt_cap,answer_sealed,created_by_id FROM tasks WHERE id=? AND active=1 AND status='published'").get(req.params.id);
  if (task) task.task_number = inComp.task_number || null;
  if (!task) return res.status(404).json({ error: "Challenge not found" });
  // THE FIRST OPEN STARTS THE SOLVE CLOCK on an event that runs that rule
  // (owner decision, 27 Nov 2026; lib/middleware.js `stampClockOnFirstTouch`
  // asks the rest: a scoring challenge, live or a late entrant's open window,
  // not impersonated, not yet started). Here, after the challenge is proved
  // assigned and published, so a 404 never starts anybody's clock.
  stampClockOnFirstTouch(req, task);
  const solved        = !!db.prepare("SELECT id FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1").get(req.session.userId, task.id, compId);
  // v8.13.2 — ONE count, read through lib/attempts.js: the card prints this as
  // "N attempt(s)", and the submit response updates it in place from the same
  // `attemptState().used` (server.js attemptsWire). A second hand-written COUNT
  // here would be the copy that drifts the day one of them gains a filter.
  const _attSt        = attemptState(req.session.userId, task, req.competition);
  const attempts      = _attSt.used;
  // Event team reports — whether this is a qualifying (Quick) question, and
  // whether its answer can be changed (operator ruling 395): such a question
  // takes a new pick past the attempt cap, so this read carries no cap keys for
  // it, as for an uncapped challenge (#283). Otherwise one with an older wrong
  // answer on the record opened as "No attempts left" while the submit would
  // take a pick, and the list's `out_of_attempts` said it was not spent.
  const _qualifying   = require("../lib/qualifying").isQualifyingTask(db, task.id);
  const _quickChangeable = require("../lib/qualifying").changeableQuickQuestion(task, _qualifying);
  const hintRevealed  = !!db.prepare("SELECT 1 FROM hint_reveals WHERE user_id=? AND task_id=? AND competition_id=?").get(req.session.userId, task.id, compId);
  const fullyEnded    = competitionFullyEnded(req.competition, req.competitionSlots);
  // For multi-slot: participant's own timeslot status (ended or live)
  // v8.6.0 — a late entrant inside an open window is not "ended" for this purpose;
  // see the twin in GET /api/tasks above.
  const mySlotEnded   = (req.timeslot ? timeslotStatus(req.timeslot) === "ended" : (req.competitionStatus === "ended"))
    && !(req.lateEntry && req.lateEntry.canPlay);
  // v6.16.0 — answer reveal is now a per-competition opt-in. Pre-fix
  // the platform unconditionally revealed correct answers +
  // explanations once every timeslot of a competition had ended,
  // which broke the "repeating event with reused question bank"
  // workflow. The flag defaults to 0 (no reveal). Operators flip
  // it on the edit modal when they want a post-mortem reveal.
  // The "ALL timeslots end" gate still applies on top — even with
  // the flag on, intra-comp answer-sharing between slots is still
  // prevented during the run.
  const revealSolution = fullyEnded && !!req.competition.reveal_answers_on_end;
  // v8.1.0 — `attempt_cap` is stripped here on purpose. It is the BASE cap, and the
  // participant is shown the EFFECTIVE one (base + any grant) below; shipping both
  // would put two numbers for one idea on the wire, and the raw one is wrong for
  // exactly the participant an admin has just helped. Named in the destructure
  // rather than deleted afterwards, so a future column has to make the same
  // decision explicitly.
  // v8.10.0 — `created_by_id` is destructured OUT: it is an internal user id and
  // the participant has no use for it. `answer_sealed` deliberately STAYS in the
  // spread — the participant is shown why no answer appeared, and a flag saying
  // "this one is sealed" is the whole of that explanation (v7.14.2: withhold the
  // thing WITH its reason). It discloses nothing: which challenges are sealed is
  // visible to every admin already and says nothing about the answer.
  const { hint, correct_answer, explanation, choices: _rawChoices, attempt_cap: _rawCap, created_by_id: _rawAuthor, ...taskBase } = task;
  // v8.10.0 — THE SEAL, on the ONE participant-reachable read of the key.
  //
  // A sealed challenge is excluded from the answer reveal even when its event
  // has `reveal_answers_on_end` on, and even for a participant who SOLVED it.
  // The solver case is the one worth stating: their submitted set WAS the correct
  // set, so it discloses nothing they do not know — but the rule is that the
  // value never reaches a client, and a build that echoes it back for one class
  // of reader is a build where the promise depends on who is asking. The client
  // renders an explanation in its place.
  //
  // The AUTHOR is exempt, so an author reviewing their own sealed challenge as a
  // participant still sees it. v8.12.1 — asked about the HUMAN: `actingAdminId`
  // is the acting admin under impersonation (so impersonating the author does
  // NOT reveal the key — the seal binds every tier) and the session's own user
  // otherwise, which for an admin in participant view is the admin themselves.
  //
  // v8.12.2 — AND A SUPERADMIN IS SHOWN IT, ON THE RECORD. The operator's ruling
  // reverses v8.10.0 for that one tier: a superadmin at the keyboard — in their
  // own participant view, or impersonating the author or any participant — is
  // shown the sealed answer, explanation and hint where the author would be,
  // and every such open is RECORDED (`_sealDisclosure` below) in the challenge's
  // History and the event log, naming the superadmin and, under impersonation,
  // the seat. The participant surface has no reveal control, so here the open
  // IS the reveal and the record is per open rather than per session; the tier
  // is a live role read (`actingIsSuperAdmin`), never a session flag, so a
  // regular admin impersonating the author still gets nothing — the hint
  // included, which is the v8.12.2 half of "nothing".
  //
  // AND NEVER TO A COMPETITOR. A superadmin who holds a row on an event where
  // staff compete is refused the reveal on the admin surface, and every admin
  // projection withholds the key from them (the v8.12.0 seal invariant: a
  // compete event holds sealed challenges precisely so a competing admin cannot
  // read the key). The passive display here asks the same question, over EVERY
  // compete event holding the challenge (`competitorEventsForTask`), not only
  // the one in hand — the pre-release review found this surface handing a
  // competing superadmin the key, explanation and hint free of charge after the
  // end-of-event reveal, where the reveal route had refused them.
  //
  // THE HAND, NOT THE SEAT (second pre-release review). The competitor question
  // here is about the PERSON at the keyboard — `actingAdminId`. Under
  // participant-view impersonation the seat is the target participant, and
  // every participant of a compete event "competes" there by definition, so
  // asking `competitorIds(req)` (seat AND hand, the ADMIN-surface rule) withheld
  // everything sealed from a superadmin looking through ANY participant of such
  // an event — the hint that participant paid for included — with a refusal
  // naming a reason that was false.
  const _sealActor = actingAdminId(req);
  const _handCompetes = answerSealed(task) && competitorEventsForTask(db, _sealActor, task.id).length > 0;
  const _sealSuper = answerSealed(task) && actingIsSuperAdmin(req) && !_handCompetes;
  const _sealHidesAnswer = !sealedAnswerReadable(task, _sealActor, _sealSuper);
  // v8.12.2 — THE HINT IS SEALED TOO, with ONE exemption the redact helpers
  // cannot see: the hint this participant PAID for (`hintRevealed`, their own
  // `hint_reveals` row) is theirs whatever the seal says — the paid reveal is
  // the hint's whole purpose. The end-of-event free reveal (`revealSolution`)
  // follows the seal exactly as the answer does. The exemption is a
  // PARTICIPANT's: `sealedHintReadable` admits the paid arm only for a human
  // whose deduction lands on this event's board (`userScoresOn` — a row, minus
  // the staff exclusion the compete switch lifts), never under impersonation,
  // where the paid row is the TARGET's and the reader is an admin. So an admin
  // in their OWN participant view, admitted to the event as staff without
  // competing in it, is refused the hint they could otherwise "buy" for a
  // deduction that lands on no board (the pre-release review's HIGH), and an
  // admin impersonating the author does not read the author's own paid hint;
  // a superadmin who does either is recorded.
  const _sealScores = answerSealed(task) && !req.session.impersonator && userScoresOn(req.session.userId, req.competition);
  const _hintOut = !!hint && (
    (hintRevealed && sealedHintReadable(task, _sealActor, _sealSuper, _sealScores))
    || (revealSolution && !_sealHidesAnswer)
  );
  // The client withholds the priced Show Hint control WITH its reason (v7.14.2)
  // when there is a hint this reader can never be given: `hint_available` says
  // there is nothing to buy, `hint_withheld` says why. Emitted only when the
  // seal is what withholds — never on an unsealed challenge, never for a reader
  // the seal admits.
  const _hintWithheld = !!hint && answerSealed(task) && !sealedHintReadable(task, _sealActor, _sealSuper, _sealScores);
  // …and WHY, so the panel never states a false reason (lib/answer-seal.js).
  const _hintWithheldReason = _handCompetes ? "competing_elsewhere" : (req.session.impersonator ? "impersonating" : "not_competing");
  // v7.19.0 — multiple choice. `choices` is destructured OUT of the spread on
  // purpose: the stored column is the author's ORDER, and the correct set lives
  // in correct_answer, so what a participant may see has to be rebuilt rather
  // than passed through. They get {id, text} only — never which are correct —
  // shuffled deterministically per (user, task) so "it's the third one" carries
  // no information between participants while a refresh keeps the same order.
  let _choicePayload = null;
  if (task.answer_type === "choice") {
    const parsed = parseChoices(_rawChoices);
    _choicePayload = {
      choices: shuffleChoicesFor(parsed, req.session.userId, task.id).map(c => ({ id: c.id, text: c.text })),
      // 'single' → radios, 'multi' → checkboxes. This does tell the participant
      // whether exactly one option is correct, which is inherent to rendering a
      // single-answer question as radios and is the conventional behaviour.
      choice_mode: choiceMode(parseCorrectIds(correct_answer)),
    };
  } else if (task.answer_type === "any" && parseChoices(_rawChoices).length >= 2) {
    // Event team reports — a PICK-ONE question (every option accepted). The
    // options keep the AUTHOR's order (they are often ordered buckets, "1–49",
    // "50–249"…), and nothing about correctness exists to withhold.
    _choicePayload = {
      choices: parseChoices(_rawChoices).map(c => ({ id: c.id, text: c.text })),
      choice_mode: "single",
      pick_one: true,
      // What they picked, so a later view shows their answer (every option was
      // accepted, so there is nothing else to mark). Their own latest answer
      // (rowid breaks a same-millisecond tie: a Quick question's answer can be
      // changed, operator ruling 395).
      ...(solved ? { my_choice_ids: parseCorrectIds(db.prepare(
        "SELECT answer_canonical FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1 ORDER BY submitted_at DESC, rowid DESC LIMIT 1"
      ).get(req.session.userId, task.id, compId)?.answer_canonical) } : {}),
    };
  }
  const myFb =db.prepare("SELECT rating FROM task_feedback WHERE user_id=? AND task_id=?").get(req.session.userId, task.id);
  // Bounded SELECT (≤ ATTACHMENT_MAX_PER_TASK rows) over the composite index
  // on (task_id, detached_at, order_idx). Leaks no sha256 / storage_path /
  // original_name to the client — participants only need id + label + size
  // to render the download list.
  const attachments = db.prepare(
    "SELECT id, display_name, size_bytes FROM task_attachments WHERE task_id=? AND detached_at IS NULL ORDER BY order_idx, created_at"
  ).all(task.id);
  // v8.12.2 — THE RECORD. Fires only when a sealed value is actually in THIS
  // response and the reader is a superadmin who is not the author. A GET that
  // writes, deliberately (the `data_exported` / `badge_image_downloaded`
  // precedent): the disclosure is the fact worth recording, and it happens
  // here. Wrapped so an audit failure can never turn a read into a 500, and it
  // touches nothing on `req.session` (a session write on a GET emits a
  // refreshed cookie — the v7.14.5 slide rule). Field NAMES only, never values.
  //
  // v8.12.6 — AND THE RECORD GATES THE DISCLOSURE. Here the open IS the reveal,
  // so this row is the only thing between a superadmin's read and a disclosure
  // nobody wrote down, and v8.12.2 swallowed its failure and shipped the values
  // anyway — the "on the record" promise failing OPEN (the explicit reveal route
  // never did: record first, marker after). A record that cannot be written
  // now WITHHOLDS exactly the fields it would have named, WITH the reason
  // (`SEAL_UNRECORDED_REASON`), and the response is still a 200 — the challenge
  // stays readable and the next open simply tries again. Nothing is written to
  // `req.session` on this path either. `_by` and `_ctx` are captured once, so
  // the log line names exactly the identity the record tried to write under.
  let _unrecorded = null;
  if (_sealSuper && !_sealHidesAnswer && !isTaskAuthor(task, _sealActor)) {
    const _fields = [];
    if (revealSolution || (task.answer_type === "choice" && solved)) _fields.push("correct_answer");
    // Only when there IS one: the History renders the field list as a sentence
    // ("Sealed answer, explanation revealed…"), and a record asserting an
    // explanation was disclosed that never existed is a false record.
    if (revealSolution && richTextHasContent(explanation)) _fields.push("explanation");
    // A hint this superadmin holds as a SCORING PARTICIPANT (their own paid
    // row, on a board their deduction landed on) was bought, not revealed —
    // it is listed only when the tier is what put it in this response.
    if (_hintOut && !(!!hint && hintRevealed && sealedHintReadable(task, _sealActor, false, _sealScores))) _fields.push("hint");
    if (_fields.length) {
      let _by = null, _ctx = null;
      try {
        _ctx = reqContext(req);
        _by = getAdminIdentity(req);
        recordSealedReveal(task.id, _by, sealRevealHistoryDetails(req, "participant_view", _fields),
          { task_title: task.title, competition_id: compId, ..._ctx });
      } catch (e) {
        _unrecorded = new Set(_fields);
        log.error({ ...(_ctx || {}), by: _by, task_id: task.id, competition_id: compId, fields: _fields, err: e.message },
          "sealed reveal could not be recorded; the sealed values were withheld");
      }
    }
  }
  // Withhold exactly what the record would have named: the answer and its
  // explanation travel together, the hint separately. `_unrecorded` can only be
  // set inside the block above, which already requires `!_sealHidesAnswer` and
  // (through `_sealSuper`) `!_handCompetes`, so it never overlaps either.
  const _answerUnrecorded = !!(_unrecorded && (_unrecorded.has("correct_answer") || _unrecorded.has("explanation")));
  const _hintUnrecorded = !!(_unrecorded && _unrecorded.has("hint"));
  const _answerHidden = _sealHidesAnswer || _answerUnrecorded;
  // v8.14.5 — THE SOLVER CONCESSION HOLDS ONLY WHILE THE SOLVE STILL MATCHES THE KEY.
  // Its premise (below) is that a solver's submitted set WAS the correct set, so
  // sending the key tells them nothing new. But an organiser may change the ticks
  // of a live challenge (only an ended session freezes them) and nothing re-grades
  // the solve, so after that edit the concession handed the solver the NEW key
  // mid-event: options they never picked, while everyone else is still answering.
  // So it is sent only when one of this participant's correct rows in this event
  // grades correct against the CURRENT key. A row from before answer_canonical is
  // re-derived from its labels as Recalculate does; one that cannot be counts as
  // not matching (fail closed). `answer_changed_since_solve` gives the reason, or
  // the solved card shows unmarked options and nothing to say why.
  const _choiceConcession = task.answer_type === "choice" && solved && !revealSolution && !_answerHidden;
  let _solveMatchesKey = false;
  if (_choiceConcession) {
    const _key = parseCorrectIds(correct_answer);
    const _byText = choiceIdsByText(parseChoices(_rawChoices));
    _solveMatchesKey = db.prepare("SELECT answer, answer_canonical FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1")
      .all(req.session.userId, task.id, compId)
      .some(s => {
        const ids = s.answer_canonical ? parseCorrectIds(s.answer_canonical) : legacySelectionIds(s.answer, _byText);
        return !!ids && gradeChoice(ids, _key);
      });
  }
  res.json({
    ...taskBase,
    hint_available: !!hint && !_hintWithheld && !_hintUnrecorded,
    hint_revealed:  hintRevealed,
    ...(_hintOut && !_hintUnrecorded ? { hint } : {}),
    ...(_hintWithheld ? { hint_withheld: true, hint_withheld_reason: _hintWithheldReason }
      : _hintUnrecorded ? { hint_withheld: true, hint_withheld_reason: SEAL_UNRECORDED_REASON } : {}),
    ..._choicePayload || {},
    // v7.20.1 — a participant who SOLVED a multiple-choice challenge gets the
    // correct ids too, so the review view can mark the options. This leaks
    // nothing: grading is all-or-nothing, so a solver's submitted set WAS the
    // correct set — they already know it (while it still is: v8.14.5, see
    // `_solveMatchesKey`). Deliberately scoped to `choice`
    // (there is nothing to mark on the other types) and to a solver; an
    // unsolved challenge in a non-revealing competition still says nothing.
    ...(_choiceConcession && _solveMatchesKey ? { correct_answer } : {}),
    ...(_choiceConcession && !_solveMatchesKey ? { answer_changed_since_solve: true } : {}),
    // v8.9.0 — an any-answer challenge has no key to reveal; the explanation
    // still ships. (For `text` the column may carry several accepted answers,
    // newline-separated; the client renders them all.)
    // v8.10.0 — a sealed challenge contributes NEITHER the key nor the
    // explanation to the reveal. The explanation is withheld because in this
    // threat model it is the key wearing prose: an author who seals so that
    // colleagues cannot learn the answer is not served by a platform that then
    // publishes "the answer is X because…". Stated in the create form and both
    // guides rather than left as a surprise.
    ...(revealSolution && !_answerHidden
      ? { ...(task.answer_type === "any" ? {} : { correct_answer }), explanation: explanation || null }
      : {}),
    // WHY SOMETHING THIS PARTICIPANT WOULD OTHERWISE HAVE HAD IS NOT THERE, so the
    // client can say so rather than rendering an empty Solution box (v7.20.4's
    // "the box must not be an empty shell", one condition over).
    //
    // TWO conditions, not one, and the second is easy to miss. The reveal is the
    // obvious case. The other is the v7.20.1 SOLVER concession: a participant who
    // solved a multiple-choice challenge normally gets the correct ids back so the
    // review view can MARK the options, even in an event that reveals nothing —
    // and the seal removes that. Without this second arm they meet plain unmarked
    // options with no badge and no explanation anywhere, which reads as the
    // platform having forgotten what they answered.
    //
    // Emitted only when the seal actually TOOK something: never mid-event on a
    // non-choice challenge, and never on an unsolved one, so the client renders
    // the panel exactly where a participant would otherwise be puzzled.
    //
    // A reason rides beside it ONLY for the one reader the box's sentence is
    // false for: a superadmin who COMPETES in an event holding the challenge
    // (every other superadmin is shown the answer here, recorded), whom "only a
    // superadmin can reveal it" would tell something untrue (final review).
    // v8.12.6 — and for the superadmin whose record could not be written, for
    // whom that sentence names the reader themselves as the remedy.
    ...((_answerHidden && (revealSolution || (task.answer_type === "choice" && solved)))
      ? { answer_sealed_withheld: true,
          ...(_handCompetes ? { answer_withheld_reason: "competing_elsewhere" }
            : _answerUnrecorded ? { answer_withheld_reason: SEAL_UNRECORDED_REASON } : {}) } : {}),
    solved,
    hackathon_ended: mySlotEnded,       // participant's slot has ended (submissions blocked)
    competition_fully_ended: fullyEnded, // ALL slots ended (answers revealed)
    attempts,
    // v8.1.0 — the attempt ceiling, PROJECTED not raw. `attempts_left` is what the
    // participant is told, so it is computed from the effective cap (base plus any
    // admin grant) rather than from `tasks.attempt_cap`, which a client deriving it
    // itself would get wrong for exactly the participant who has been helped.
    //
    // Absent entirely when the challenge is uncapped: "the key is missing" is the
    // shape a client already handles, where `attempts_left: null` would have to be
    // interpreted. The RAW column never ships — see the wire note in lib/attempts.js.
    // #283 — and absent for a Quick question whose answer can be changed: the
    // cap does not bind it (`_quickChangeable` above).
    ...(_attSt.capped && !_quickChangeable ? { attempts_cap: _attSt.effective, attempts_left: _attSt.left } : {}),
    attachments,
    my_rating: myFb?.rating || null,
    // Event team reports — a boolean, never the tag (lib/qualifying.js): the card
    // shows no difficulty, attempt count or rating, and no points.
    qualifying: _qualifying,
    // Operator ruling 395 (14 Nov 2026) — the offer of Change answer, from the
    // submit's own rule (`changeableQuickQuestion`, shared with server.js): an
    // answered qualifying pick-one question takes a new pick while this person
    // can still play and it is not locked. Present only when true.
    ...(solved && !mySlotEnded && _quickChangeable
      && !(db.prepare("SELECT locked FROM tasks WHERE id=?").get(task.id) || {}).locked
      ? { answer_changeable: true } : {}),
    // Snapshot of the grading basis at fetch time. Client echoes this back on
    // submit so we can detect "admin edited the answer between page-load and
    // submit" and reject with task_changed:true (no -5 penalty) instead of
    // silently re-grading against new criteria the participant never saw.
    grading_hash: taskGradingHash(task.answer_type, correct_answer, _rawChoices),
    // v7.21.0 — the challenge's categories, same one-directional filter as the
    // list endpoint: parsed NAMES only, never the raw tag list.
    categories: participantCategories(
      topicNamesFor(db, [task.id]).get(task.id),
      db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(task.id).map(r => r.tag)
    ),
  });
});

// Stable, short hash of the grading basis (answer_type + correct_answer). Used
// to detect mid-flight admin edits to a task between client load and submit —
// if the hash on submit differs from the hash issued at load, the grading
// criteria changed and we MUST refuse to score against new criteria.
// taskGradingHash now lives in lib/scoring.js (imported at the top) — shared by
// GET /api/tasks/:id (routes/participant.js) and the inline submit route.

app.post("/api/tasks/:id/hint", requireParticipant, requireCompetitionContext, requireParticipantInCompetition, _resolveEventTask, rateLimit(60_000, 30, "hint"), csrfProtection, (req, res) => {
  const compId = req.session.competitionId;
  // v6.16.2 — same lifecycle gates as /api/tasks/:id/submit. Pre-fix
  // a participant who selected an UPCOMING competition could call
  // this endpoint and reveal a hint (mutating hint_reveals + score
  // + audit) before the comp / their slot was live; symmetrically,
  // a participant whose slot had already ended could still trigger
  // a -30% deduction. Submissions had this check at server.js:5692-
  // 5694; hint reveals didn't, which the auditor flagged. Mirror
  // the same activeStatus + multi-slot timeslot requirement.
  const activeStatus = req.timeslot ? timeslotStatus(req.timeslot) : req.competitionStatus;
  const activeName = req.timeslot ? sanitiseForLog(req.timeslot.name) : sanitiseForLog(req.competition.name);
  // v8.6.0 — a LATE ENTRANT may still reveal a hint, on the same predicate the
  // submit path uses. Withholding hints from the one participant who is still
  // playing would leave them a locked control and no reason given (v7.14.2), and
  // the hint's cost is the same 30% deduction it is for everybody else.
  if (activeStatus === "ended" && !(req.lateEntry && req.lateEntry.canPlay)) return res.status(403).json({ error: `${activeName} has ended` });
  if (activeStatus === "upcoming") return res.status(403).json({ error: `${activeName} has not started yet` });
  if ((req.competitionSlots ? req.competitionSlots.length > 0 : hasTimeslots(compId)) && !req.session.timeslotId) return res.status(400).json({ error: "Please choose a session before revealing hints." }); // v7.2.x (audit, perf) — reuse req.competitionSlots
  // Verify task is in this competition
  const inComp = db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, req.params.id);
  if (!inComp) return res.status(404).json({ error: "Challenge not found" });

  // `attempt_cap` is named here because `attemptState` below THROWS on a row that
  // does not carry the key (v8.1.0) — a caller that under-selects must fail loudly
  // rather than silently resolving to "uncapped" and charging an exhausted
  // participant the very deduction this route refuses.
  // v8.12.2 — `answer_sealed` + `created_by_id` join it because a sealed hint
  // handed to a superadmin who is not the author is a recorded disclosure.
  const task = db.prepare("SELECT id,title,hint,difficulty,locked,attempt_cap,answer_type,answer_sealed,created_by_id FROM tasks WHERE id=? AND active=1 AND status='published'").get(req.params.id);
  if (!task)       return res.status(404).json({ error: "Challenge not found" });
  // v8.12.2 — A SEALED HINT IS REFUSED TO WHOEVER THE SEAL BINDS, BEFORE ANY
  // WRITE. Asked here, above the solved / already-revealed / fresh-reveal
  // branches, so no `hint_reveals` row is written and no deduction charged for
  // a hint the caller may not have. The paid exemption is a PARTICIPANT's — one
  // whose deduction lands on this event's board (`userScoresOn`), never a staff
  // spectator admitted without competing, and never under impersonation, where
  // the row would be the target's and the reader an admin. The author and a
  // superadmin (recorded below) pass. The refusal is a 4xx, deliberately: the
  // client withholds the control with the reason (`hint_withheld`), so the only
  // way here is a stale tab or a scripted caller, never a cohort behind a NAT.
  const _hintScores = !req.session.impersonator && userScoresOn(req.session.userId, req.competition);
  // The HAND, not the seat — the GET's own reasoning (see `_handCompetes` there).
  const _hintHandCompetes = answerSealed(task) && competitorEventsForTask(db, actingAdminId(req), task.id).length > 0;
  const _hintSuper = answerSealed(task) && actingIsSuperAdmin(req) && !_hintHandCompetes;
  const _hintWhy = _hintHandCompetes ? "competing_elsewhere" : (req.session.impersonator ? "impersonating" : "not_competing");
  // v8.12.2 — THE RECORDED DISCLOSURE OF A SEALED HINT. Every exit of this route
  // that carries `task.hint` runs through here first: the solver's free hint
  // below, the fresh reveal and the already-revealed re-fetch (ahead of the
  // `hint_reveals` write since v8.12.6 — see below). The
  // paid row belongs to the session's participant (under impersonation, the
  // target), but the reader is the acting human — a superadmin who is not the
  // author is shown a sealed hint, and that is what is written down, per open.
  // A superadmin who holds it as a SCORING PARTICIPANT (their own paid row on a
  // board the deduction landed on) bought it like anybody else; only a read the
  // tier alone admitted is a disclosure worth writing down.
  //
  // v8.12.6 — THE RECORD IS WRITTEN BEFORE ANYTHING IS SHOWN OR CHARGED, and a
  // record that cannot be written REFUSES the request. v8.12.2 swallowed the
  // failure and, on the fresh reveal, ran the record AFTER the `hint_reveals`
  // INSERT — so a failed record left the hint shown and the deduction taken
  // (under impersonation, from the TARGET) with no row in the challenge's
  // History. Now this returns true once it has sent the 503, and every exit
  // that carries the hint does `if (_sealedHintDisclosure()) return;` first:
  // the solver's free branch, and — ahead of the INSERT — the fresh reveal and
  // the paid re-fetch. Recording first is safe only because the record takes
  // the write lock up front (`.immediate`, lib/audit.js): a DEFERRED record as
  // the request's first write would fail at once under a brief external lock
  // that the INSERT used to absorb. A failed INSERT after a successful record
  // over-records a reveal the 500 never delivered — the safe direction, and the
  // explicit route's own record-then-marker shape. Do NOT move it back below.
  const _sealedHintDisclosure = () => {
    if (!_hintSuper || isTaskAuthor(task, actingAdminId(req)) || _hintScores) return false;
    let _by = null, _ctx = null;
    try {
      _ctx = reqContext(req);
      _by = getAdminIdentity(req);
      recordSealedReveal(task.id, _by, sealRevealHistoryDetails(req, "participant_hint", ["hint"]),
        { task_title: task.title, competition_id: compId, ..._ctx });
      return false;
    } catch (e) {
      log.error({ ...(_ctx || {}), by: _by, task_id: task.id, competition_id: compId, fields: ["hint"], err: e.message },
        "sealed hint reveal could not be recorded; the hint was withheld and nothing was charged");
      const u = sealRevealUnrecorded();
      res.status(503).json({ error: u.message, code: u.code, reason: u.reason });
      return true;
    }
  };
  // v8.9.0 — an any-answer challenge never stores a hint (every writer refuses
  // or clears one), so this arm is defence in depth: the invariant stated at the
  // read side too, with the same answer the client already handles.
  if (!task.hint || task.answer_type === "any")  return res.status(400).json({ error: "This challenge has no hint" });
  // Locked tasks freeze scoring — submissions return 423; hint reveals must
  // do the same, otherwise a locked task could still accrue -30% deductions.
  if (task.locked) return res.status(423).json({ error: "This challenge is locked and is no longer accepting submissions." });
  // THE SEALED-HINT REFUSAL, asked HERE: below "no hint" and "locked", so a
  // sealed challenge that HAS no hint is never refused with a sentence saying
  // its hint is sealed (second pre-release review), and still above the
  // solved / already-revealed / fresh-reveal branches, so no `hint_reveals` row
  // is written and no deduction charged for a hint the caller may not have.
  {
    const denied = sealedHintDenied(task, actingAdminId(req), _hintSuper, _hintScores, _hintWhy);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code, reason: denied.reason });
  }
  // A hint asked for before any open starts a first-open clock too (a client
  // that never opened the challenge); a no-op once the open has stamped it.
  stampClockOnFirstTouch(req, task);
  // v7.2.x (audit) — a participant who has already SOLVED this task gains nothing
  // from a hint; don't let them self-inflict a -30% deduction. Return the hint,
  // record no hint_reveals row. (hint_reveals is keyed (comp,user,task) — no
  // timeslot — so the solved check is comp-scoped to match.)
  if (db.prepare("SELECT 1 FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1").get(req.session.userId, task.id, compId)) {
    if (_sealedHintDisclosure()) return;
    return res.json({ hint: task.hint, pointsDeducted: 0, alreadySolved: true, score: getParticipantScore(req.session.userId, compId, req.session.timeslotId) });
  }
  // v8.1.0 — AN EXHAUSTED PARTICIPANT IS NOT CHARGED FOR A HINT THEY CAN NO
  // LONGER USE. This is the SAME argument as the solved branch above ("don't let
  // them self-inflict a -30% deduction"), applied to the other terminal state:
  // once the attempt budget is gone the challenge can never be answered again, so
  // a paid hint buys nothing and the deduction is permanent. The client hides the
  // priced button in this state, so the only way here is a stale tab — which is
  // exactly why the rule has to live on the server too.
  //
  // AN ALREADY-REVEALED HINT IS STILL RETURNED, FREE. It was paid for; exhaustion
  // must never take away something already bought, and the re-fetch the client
  // does on every open would otherwise start hiding it. `hint_reveals` is keyed
  // (comp, user, task) — no timeslot — so this lookup is comp-scoped to match.
  //
  // Refused with a 4xx, deliberately UNLIKE the submit path's 200: that one is
  // 200 because a room of participants behind one NAT mistyping a capped answer
  // would feed the scanner-reputation counter and ban the venue. Nothing here is
  // reachable in that volume — the affordance is hidden, so a refusal means one
  // stale tab, not a cohort.
  const alreadyRevealed = !!db.prepare("SELECT 1 FROM hint_reveals WHERE competition_id=? AND user_id=? AND task_id=?")
    .get(compId, req.session.userId, task.id);
  if (!alreadyRevealed && attemptState(req.session.userId, task, req.competition).exhausted) {
    // The remedy has to be one that actually works: an admin attempt grant makes
    // the challenge answerable again, at which point the hint is worth its cost.
    return res.status(403).json({
      error: "You have no attempts left on this challenge, so a hint cannot be revealed. Ask an organiser for another attempt.",
      code: "attempts_exhausted",
    });
  }

  // v8.12.6 — recorded BEFORE the `hint_reveals` write (the fresh reveal AND
  // the paid re-fetch both pass here), so a record that fails charges nobody.
  if (_sealedHintDisclosure()) return;
  // A qualifying question scores nothing (lib/qualifying.js), so its hint costs
  // nothing either: Recalculate already prices it at 0 (routes/challenges.js
  // `newHintCost`), and the card quotes 0 (`taskPts`). Only an older qualifying
  // challenge that is not a pick-one question can still have a hint.
  const deduction = require("../lib/qualifying").isQualifyingTask(db, task.id) ? 0 : Math.round(POINTS[task.difficulty] * HINT_DEDUCTION_RATE);
  // v6.8.0: timeslot_id normalised to NULL for no-slot rows (matches the
  // submissions convention). Hint-reveal queries that filter by timeslot
  // now work identically across the two tables without a COALESCE special
  // case.
  const tsId = req.session.timeslotId || null;
  // v6.10.83: updated_at mirrors revealed_at on INSERT; recalc's hint
  // rescale bumps it so /api/admin/submissions picks up the UPDATE drift.
  const revealedAtIso = now().toISOString();
  const inserted = db.prepare("INSERT OR IGNORE INTO hint_reveals (competition_id, user_id, task_id, points_deducted, revealed_at, timeslot_id, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(compId, req.session.userId, task.id, deduction, revealedAtIso, tsId, revealedAtIso);
  // Audit trail — only on actual first reveal (subsequent calls are no-ops and deduct nothing).
  if (inserted.changes > 0) {
    // v6.9.9: hint reveals feed into leaderboard score via the
    // hint_reveals aggregation in buildLeaderboardEntries — keep the
    // cache coherent with the writer-lock convention used by
    // submissions. Without this the 5-second TTL could serve a
    // participant's pre-deduction score to anyone polling the board
    // immediately after a reveal.
    invalidateLeaderboardCache(compId);
    try {
      // v7.14.0 — a hint reveal under impersonation is only reachable from a
      // superadmin-origin session (impersonationGuard). The hint_reveals row +
      // deduction are real; the challenge_events row is stamped impersonated=1
      // (analytics-excluded) and the audit events carry impersonated_by.
      const _impHint = isImpersonating(req);
      const _impHintCtx = _impHint ? { impersonated_by: impersonationActor(req.session) } : {};
      const selfId = db.prepare("SELECT email, nickname FROM users WHERE id=?").get(req.session.userId);
      const identity = selfId?.email || "system";
      const details = {
        ...reqContext(req),
        competition_id: compId,
        task_id: task.id,
        task_title: task.title,
        timeslot_id: tsId || null,
        points_deducted: deduction,
        ..._impHintCtx,
      };
      recordUserEvent(req.session.userId, "hint_revealed", identity, details);
      // DB-only for the other two scopes — user-scope mirror already covers it.
      recordCompetitionEvent(compId, "hint_revealed", identity, { ...reqContext(req), user_id: req.session.userId,
        nickname: selfId?.nickname || null,
        task_id: task.id,
        task_title: task.title,
        timeslot_id: tsId || null,
        points_deducted: deduction,
        ..._impHintCtx, }, { mirror: false });
      if (tsId) recordTimeslotEvent(tsId, "hint_revealed", identity, { ...reqContext(req), user_id: req.session.userId,
        nickname: selfId?.nickname || null,
        task_id: task.id,
        task_title: task.title,
        points_deducted: deduction,
        ..._impHintCtx, }, { mirror: false });
      recordChallengeEvent(req.session.userId, task.id, compId, tsId || null,
        "hint_revealed", { points_deducted: deduction, ..._impHintCtx }, _impHint);
    } catch (e) { swallowed("participant:hint-revealed-audit", e); }
  }
  _invalidateMeCache(req.session.userId);
  res.json({ hint: task.hint, pointsDeducted: inserted.changes ? deduction : 0, score: getParticipantScore(req.session.userId, compId, req.session.timeslotId) });
});

app.post("/api/tasks/:id/navigated-away",
  requireParticipant, rateLimit(60_000, 60, "navaway"),
  requireCompetitionContext, requireParticipantInCompetition, _resolveEventTask,
  csrfProtection,
  (req, res) => {
    const taskId = req.params.id;
    // typeof, not String(): String() throws on an object whose toString is not callable.
    const via = (typeof req.body?.via === "string" && req.body.via ? req.body.via : "spa_nav").slice(0, 32);
    const compId = req.session.competitionId;
    const inComp = db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, taskId);
    if (!inComp) return res.status(404).json({ error: "Challenge not found" });

    // v7.27.0 — A SOLVED CHALLENGE NEVER RECORDS ANOTHER navigated_away.
    //
    // The signal exists to find challenges participants BOUNCE OFF (the wording
    // of the commit that introduced it), and swagger has said "leaves a
    // challenge detail view WITHOUT SUBMITTING" since that same commit. Solving
    // is the opposite of bouncing, so a row written at or after the solve is
    // noise in every consumer that reads the column.
    //
    // This is the AUTHORITATIVE half of the fix; the client also stops firing on
    // the solve path (participant-tasks.js submitAnswer), which spares a pointless
    // round trip. The gate is what makes the rule true regardless of the client —
    // it also covers re-opening a solved challenge to review it, a second tab, a
    // stale page, and a scripted caller.
    //
    // The 2-second dedup below CANNOT reach this case by construction: it only
    // fires when the LAST event is itself a navigated_away, and on the solve path
    // it is `solved`.
    //
    // Scoped by competition on purpose — a task can be assigned to several, and
    // solving it in one must not silence the signal in another. Index-covered by
    // idx_submissions_user_task_comp_time (user_id, task_id, competition_id, …).
    //
    // Applied regardless of `impersonated`: the rule is about the challenge being
    // solved, not about who is looking. One rule, one definition.
    //
    // 200 with a reason, never a 4xx: this is background telemetry the SPA fires
    // on navigation, and a non-429 4xx feeds the scanner-reputation counter that
    // can lock a whole venue out (v7.21.24).
    const _alreadySolved = db.prepare(
      "SELECT 1 FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1 LIMIT 1"
    ).get(req.session.userId, taskId, compId);
    if (_alreadySolved) return res.json({ ok: true, skipped: "already_solved" });

    // v7.14.0 — background telemetry stays allowed under impersonation (it is
    // on the impersonationGuard allowlist so it never surfaces error modals);
    // the row is stamped impersonated=1 so analytics ignores it.
    const _impNav = isImpersonating(req);
    // The dedup window is scoped to the SAME stream. An impersonation session
    // and the participant's own session can be live at once on the same
    // (user, task) — an unscoped lookup let the impersonated row (which
    // analytics discards) swallow the participant's REAL event 2s later,
    // silently under-reporting navigated_away. `impersonated` is part of
    // idx_chev_comp_task_user_type, so the extra predicate stays index-covered.
    const last = db.prepare(
      "SELECT event_type, occurred_at FROM challenge_events WHERE user_id=? AND task_id=? AND competition_id=? AND impersonated=? ORDER BY occurred_at DESC LIMIT 1"
    ).get(req.session.userId, taskId, compId, _impNav ? 1 : 0);
    if (last && last.event_type === "navigated_away" &&
        (Date.now() - new Date(last.occurred_at).getTime()) < 2000) {
      return res.json({ ok: true, deduped: true });
    }

    recordChallengeEvent(
      req.session.userId, taskId, compId,
      req.session.timeslotId || null,
      "navigated_away", { via, ...(_impNav ? { impersonated_by: impersonationActor(req.session) } : {}) },
      _impNav
    );
    res.json({ ok: true });
  }
);

app.put("/api/tasks/:id/feedback", requireParticipant, requireCompetitionContext, requireParticipantInCompetition, _resolveEventTask, rateLimit(60_000, 30, "task-feedback"), csrfProtection, (req, res) => {
  // Number() throws on an object whose toString/valueOf is not callable (JSON can
  // send one), so only a number or a numeric string is converted.
  const rating = typeof req.body.rating === "number" || typeof req.body.rating === "string" ? Number(req.body.rating) : NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5" });
  const compId = req.session.competitionId;
  // ext-audit F2 (v7.7.5) — same lifecycle gate as GET /api/tasks/:id and the
  // hint/submit paths: you cannot rate a challenge whose content has not started
  // (an upcoming comp, or a multi-slot comp with no slot chosen). Pre-fix
  // feedback was the one task action with no not-started gate, so a participant
  // could leave feedback on (and thus signal engagement with) a competition
  // before it began.
  const _gate = participantContentNotStarted(req);
  if (_gate) return res.status(403).json({ error: _gate.needsSlot ? "Please choose a session before leaving feedback." : `${sanitiseForLog(_gate.name)} has not started yet` });
  const inComp = db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, req.params.id);
  if (!inComp) return res.status(404).json({ error: "Challenge not found" });
  const task = db.prepare("SELECT id, title FROM tasks WHERE id=? AND active=1 AND status='published'").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Challenge not found" });
  // Detect whether this is an update (replacing a prior rating) for the audit detail.
  const prior = db.prepare("SELECT rating FROM task_feedback WHERE user_id=? AND task_id=?").get(req.session.userId, req.params.id);
  db.prepare("INSERT INTO task_feedback (user_id, task_id, rating, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id, task_id) DO UPDATE SET rating=excluded.rating, updated_at=excluded.updated_at")
    .run(req.session.userId, req.params.id, rating, now().toISOString());
  try {
    // v7.14.0 — feedback under impersonation is superadmin-only (guard); the
    // rating row is real, the audit events carry impersonated_by.
    const _impFb = isImpersonating(req) ? { impersonated_by: impersonationActor(req.session) } : {};
    const self = db.prepare("SELECT email, nickname FROM users WHERE id=?").get(req.session.userId);
    const identity = self?.email || "system";
    const details = {
      ...reqContext(req),
      competition_id: compId,
      task_id: task.id,
      task_title: task.title,
      rating,
      is_update: !!prior,
      previous_rating: prior?.rating ?? null,
      ..._impFb,
    };
    recordUserEvent(req.session.userId, "feedback_submitted", identity, details);
    recordCompetitionEvent(compId, "feedback_submitted", identity, { ...reqContext(req), user_id: req.session.userId,
      nickname: self?.nickname || null,
      task_id: task.id,
      task_title: task.title,
      rating,
      is_update: !!prior,
      previous_rating: prior?.rating ?? null,
      ..._impFb, }, { mirror: false });
  } catch (e) { swallowed("participant:feedback-audit", e); }
  res.json({ ok: true, rating });
});
};
