"use strict";

// Invitation routes: public invitation lookup + admin bulk-invite (which can
// pre-assign competitions and groups). (v7.0.0 refactor: route split.)

const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { getPlatformName } = require("../lib/settings");
const { isLockedNow } = require("../lib/lockout"); // v7.29.0 — one definition of "is this account locked"
const { rateLimit, bulkAdminLimit, requireAdmin, csrfProtection } = require("../lib/middleware");
const { getCompetition, competitionEffectiveEnd, competitionAdmission, lateWindowAdmissionDenied, lateEntryMailLine, eventEndMailText, closeAbsenceAndRestoreAnchor } = require("../lib/competitions");
const { log, sanitiseForLog } = require("../lib/log");
const { getAdminIdentity, recordUserEvent, recordCompetitionEvent, reqContext, runTxnWithMirrorBuffer, recordOrphanedAuditEvent, capabilityFingerprint } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { reconcileGroupBoundCompetitions, detectMultiGroupAddClashes, findGroupByName } = require("../lib/group-sync");
const { invalidateLeaderboardCache } = require("../lib/leaderboard");
const { _invalidateMeCache } = require("../lib/me-cache");
const { invalidateAdminParticipantsCache } = require("../lib/participants-cache");
const { buildEmail, isUnsubscribedAddress, sendEmailLogged } = require("../lib/email");
const { normaliseEmail, isValidEmailFormat, _groupNameOk, _runBoundedWithDeadline, _groupNameKey } = require("../lib/util");
const { escapeHtml } = require("../lib/sanitise");
const { now, formatEmailDate } = require("../lib/time");
const { BASE_URL, BULK_ADMIN_MAX } = require("../lib/config");
const { enqueueCxOneProvision } = require("../lib/cxone");
// v8.7.0 — the event-admin scope. Predicates return null when ALLOWED.
const { actorId, competitorIds, scopedCompetitionIds, outOfScopeCompetitionIds, groupWriteDenied, participantDenied } = require("../lib/event-admin");
const { actorPermissions: _actorPermissions, privilegedTargetFor: _privilegedTarget, actorMayApproveNow, inviterMayApproveNow } = require("../lib/rbac"); // RBAC — the privileged-target rule (an unscoped role, built-in or custom, or one holding a permission the actor lacks)
const { staffRowRefusal } = require("../lib/self-enroll"); // v8.12.0 — the staff row-writer rule
const { competitorEditDenied, competitorGroupDenied, competitorRivalDenied, refuseCompetitor, staffCompeteOn } = require("../lib/staff-compete"); // v8.12.0

// v7.1.4 (audit #5) bounded-concurrency fan-out for bulk-invite emails; v7.2.x
// extracted to lib/util._runBounded so participants/import share one impl.

// THE LIVE INVITATION FOR AN ADDRESS, asked once per invited address: by the
// re-invite merge, and by the race loser's re-read after its INSERT met another
// instance's row. `used_at IS NULL AND email=? COLLATE NOCASE` is a SEARCH of the
// partial UNIQUE index uq_invitations_live_email (db.js), as lib/invitation-claim.js
// asks it; `LOWER(email)=LOWER(?)` walks every unredeemed invitation for every
// address in the batch (no index holds that expression). Same answer: LOWER and
// NOCASE both fold ASCII only, and addresses are ASCII by rule. One SQL text for
// both sites, so they cannot drift (lock: tests/storm-hotpaths.api.spec.js).
const LIVE_INVITATION_SQL = "SELECT id, competition_ids, group_ids, last_send_success, invited_by, invited_by_id FROM invitations WHERE used_at IS NULL AND email=? COLLATE NOCASE";

module.exports = function register(app) {
app.get("/api/invitations/:id", rateLimit(60_000, 30, "invitation-lookup"), (req, res) => {
  const inv = db.prepare("SELECT * FROM invitations WHERE id=?").get(req.params.id);
  if (!inv || inv.used_at) return res.status(404).json({ error: "Invitation not found or already used" });
  const compIds = JSON.parse(inv.competition_ids || "[]");
  const competitions = compIds.length
    // One json_each(?) bind, so the statement text is constant (db.prepare is memoised by SQL text).
    ? db.prepare("SELECT name, start_time, duration_minutes FROM competitions WHERE id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(compIds))
        .map(c => ({ name: c.name, start_time: c.start_time, duration_minutes: c.duration_minutes }))
    : [];
  res.json({ email: inv.email, competitions, used: false });
});

app.post("/api/admin/invitations", requireAdmin, bulkAdminLimit, csrfProtection, async (req, res) => {
  const { emails, competitionIds, groupIds, newGroups } = req.body;
  if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: "No emails provided" });
  // v6.16.16 — symmetric with bulk-assign + bulk-approve (v6.16.14).
  // Pre-fix non-string entries were silently filtered (`continue`)
  // inside the iteration loop, so a scripted caller's tampered
  // request got zero feedback. Now reject explicitly so the contract
  // violation surfaces.
  if (emails.some(x => typeof x !== "string")) {
    return res.status(400).json({ error: "emails must be an array of strings" });
  }
  if (Array.isArray(competitionIds) && competitionIds.some(x => typeof x !== "string")) {
    return res.status(400).json({ error: "competitionIds must be an array of strings" });
  }
  if (emails.length > BULK_ADMIN_MAX) return res.status(400).json({ error: `Cannot invite more than ${BULK_ADMIN_MAX} emails in a single request.` });

  // v8.7.0 — AN EVENT ADMIN MAY ONLY INVITE INTO THEIR OWN EVENTS, so for them
  // the competition list stops being optional. An invitation naming no event is
  // a platform-wide account invitation: it creates a registered participant who
  // belongs to nobody's event, which is the one thing the role must not be able
  // to do. Both arms run BEFORE `validComps` and before the `newGroups` INSERT
  // below, so a refusal leaves no invitation, no group and no membership behind.
  const _scope = scopedCompetitionIds(req);
  if (_scope !== null) {
    if (!Array.isArray(competitionIds) || !competitionIds.length) {
      return res.status(400).json({
        error: "Choose at least one of your events to invite these people to. Event admins can only invite participants into an event they manage.",
        code: "event_admin_competition_required",
      });
    }
    // Named ids are refused rather than silently dropped: dropping them would
    // send the invitations minus the intent, and the admin would have no way to
    // tell from the response that half their selection had evaporated.
    const outside = outOfScopeCompetitionIds(req, competitionIds);
    if (outside.length) {
      return res.status(403).json({
        // The ids, deliberately not the names — the actor supplied these, and
        // resolving a name would disclose an event they do not manage.
        error: `You are not an organiser of ${outside.length === 1 ? "one of the selected events" : `${outside.length} of the selected events`} (${outside.join(", ")}). Remove it and try again, or ask an administrator to add you to it.`,
        code: "event_admin_out_of_scope",
      });
    }
  }

  // Validate competitions (optional — may be empty)
  //
  // v8.3.20 (external audit) — DEDUPED and CAPPED, which the sibling `groupIds`
  // loop below has always been and this one was not. A duplicated id enqueued
  // the same CxOne provisioning twice per invitee, and an unbounded list made
  // every redemption do unbounded work (it once also overflowed SQLite's
  // variable limit; the redemption now binds the list as one JSON value).
  // BULK_ADMIN_MAX is the same bound the email list already carries.
  const validComps = [];
  // v8.12.6 — an event still taking LATE ENTRIES is admitted, through the one
  // predicate every door asks (`competitionAdmission`). The old test here was
  // `effEnd > now`, which is exactly "upcoming or live" and nothing more — so an
  // event inside its late-entry window was silently DROPPED: a new invitee's
  // invitation was stored attached to nothing (`competition_ids "[]"`, measured)
  // and an existing account was not enrolled, with the response saying neither.
  // compId → effective end, for every event admitted through its window.
  const lateComps = new Map();
  const nowMs = Date.now();
  if (Array.isArray(competitionIds)) {
    if (competitionIds.length > BULK_ADMIN_MAX) {
      return res.status(400).json({ error: `Cannot invite to more than ${BULK_ADMIN_MAX} events in a single request.` });
    }
    const seenComp = new Set();
    for (const cid of competitionIds) {
      if (seenComp.has(cid)) continue;
      seenComp.add(cid);
      const comp = getCompetition(cid);
      if (!comp) continue;
      const adm = competitionAdmission(comp, { nowMs });
      if (!adm) continue;
      validComps.push(comp);
      if (adm === "late") lateComps.set(comp.id, competitionEffectiveEnd(comp));
    }
  }

  // v8.7.0 — the loop above silently drops an event that no longer exists or has
  // already finished. For a global admin that is the documented tolerance; for an
  // event admin it would reopen the hole the check above closed by another door —
  // name one ended event of your own and the invitation goes out attached to
  // nothing. Refused, and the message says which of the two it was.
  // v8.12.0 — a competitor may not invite people into the event they compete in.
  for (const comp of validComps) {
    const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
    if (_cmp) return _cmp;
  }
  if (_scope !== null && !validComps.length) {
    return res.status(400).json({
      error: "None of the selected events can still take new participants — they have finished and are not taking late entries, or they no longer exist. Pick an event of yours that is still running or still taking late entries.",
      code: "event_admin_competition_required",
    });
  }

  const invitedBy = getAdminIdentity(req);
  // v7.21.32 — once per request: this handler loops over the whole invite batch.
  const rctx = reqContext(req);
  const platformName = getPlatformName();
  const baseUrl = BASE_URL;
  const createdAt = now().toISOString();
  const compIdJson = JSON.stringify(validComps.map(c => c.id));
  // v6.20.0 — resolve target groups: existing ids (that exist) + any newGroups
  // names (created now). The invited address joins these immediately if it
  // already resolves to a user, or on registration (stored on the invitation row).
  const validGroupIds = [];
  {
    const seen = new Set();
    if (Array.isArray(groupIds)) {
      for (const gid of groupIds) {
        if (typeof gid !== "string" || seen.has(gid)) continue;
        if (db.prepare("SELECT id FROM groups WHERE id=?").get(gid)) {
          // v8.7.0 — an invited group is APPLIED, not merely referenced: an
          // existing invitee is inserted into it here and reconciled into every
          // competition it is bound to, so a group shared with an event outside
          // this actor's scope would move membership there. Same predicate the
          // group routes use, checked before this loop's sibling `newGroups`
          // branch creates anything, so a refusal leaves no group behind.
          //
          // Only groups that EXIST are asked about, preserving this loop's
          // existing tolerance of a stale id in the payload.
          const gd = groupWriteDenied(req, gid);
          if (gd) return res.status(403).json({ error: gd.message, code: gd.code });
          // v8.12.0 — a competitor may not put people into a group bound to the
          // event they compete in (membership live-syncs into it): the
          // transitive door, asked HERE, beside the scope gate and before the
          // `newGroups` branch below creates anything, so a refusal leaves no
          // group behind.
          const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), gid));
          if (_cmp) return _cmp;
          validGroupIds.push(gid); seen.add(gid);
        }
      }
    }
    if (Array.isArray(newGroups)) {
      // v8.12.0 — a `newGroups` NAME may resolve to an EXISTING group, which can
      // be bound to an event the actor competes in; ask about every such name
      // BEFORE the create loop, or an earlier name's INSERT lands before a later
      // name's refusal. A group created below is bound nowhere and needs no ask.
      for (const rawName of newGroups) {
        if (!_groupNameOk(rawName)) continue;
        const g0 = findGroupByName(rawName.trim());
        if (!g0) continue;
        // The SCOPE gate `groupIds` takes (`groupWriteDenied`, above) applies
        // to a NAME that resolves to an existing group too — it is the same
        // group, reached by a different spelling. Without it an event admin
        // could apply an invitee into a group bound to an event outside their
        // scope by naming it here while the id form was refused.
        const gd = groupWriteDenied(req, g0.id);
        if (gd) return res.status(403).json({ error: gd.message, code: gd.code });
        const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), g0.id));
        if (_cmp) return _cmp;
      }
      for (const rawName of newGroups) {
        if (!_groupNameOk(rawName)) continue;
        const trimmed = rawName.trim();
        let g = findGroupByName(trimmed);
        if (!g) {
          const gid = uuid();
          try {
            // v8.7.0 — the THIRD group-create site on the platform, and it needs
            // the ownership stamp for the same reason as the two in
            // routes/groups.js: `newGroups` is allowed here precisely BECAUSE the
            // group is this actor's, and that is only true once it is recorded.
            // Without it an event admin could create a group from the invite
            // dialog and then be refused every subsequent edit of it.
            db.prepare("INSERT INTO groups (id, name, name_key, created_at, created_by, created_by_id) VALUES (?,?,?,?,?,?)").run(gid, trimmed, _groupNameKey(trimmed), createdAt, invitedBy, actorId(req));
            recordOrphanedAuditEvent("group", gid, "group_created", invitedBy, { name: trimmed, members: 0, ...rctx });
            g = { id: gid };
          } catch (_) { g = findGroupByName(trimmed); }
        }
        if (g && !seen.has(g.id)) { validGroupIds.push(g.id); seen.add(g.id); }
      }
    }
  }
  const groupIdJson = JSON.stringify(validGroupIds);
  let invited = 0, assigned = 0;
  // v6.13.21 — surface re-invite skips for users who couldn't be
  // assigned because they're blocked or still unapproved (and the
  // auto-approve branch didn't fire because they weren't verified or
  // were locked out). Same shape as /api/admin/competitions/assign.
  let skippedBlocked = 0, skippedUnapproved = 0;
  // Sweep #340 — waiting accounts an ORGANISER's invitation could have approved
  // but left pending, because none of their events took the account (every
  // enrolment was skipped): the approve door would refuse the same approval.
  const leftPending = [];
  // v8.12.0 — an EXISTING invitee who is staff gets a row only on an event where
  // staff compete (the assign route's rule, applied at this door), counted per
  // (user, event) so the toast can say how many enrolments were withheld.
  let skippedStaff = 0;
  // v8.12.0 — the assign door's peer-admin skip, one door over: enrolling an
  // admin or superadmin as a COMPETITOR is a superadmin's act, so on a compete
  // event a non-superadmin caller's invitation skips that target and says so.
  let skippedPrivileged = 0;
  let skippedPrivilegedGroups = 0; // v8.12.0 — group adds withheld from a non-superadmin on an admin/superadmin target
  // ...and an author of one of the event's challenges, counted apart from the
  // spectator skip so the dialog can say which it was.
  let skippedAuthors = 0;
  // v8.12.6 — an existing account that played an event taking late entries
  // before it ended is not given a NEW row through its window (the assign door's
  // rule, counted the same way).
  let skippedTookPart = 0;
  const _actorIdInv = actorId(req);
  let emailsSent = 0;
  // Retries of previously-undelivered invitations whose send succeeded this
  // request. Distinct from `invited` (which only counts newly-created rows)
  // so the UI can say "N invitations sent, M retries succeeded" instead of
  // "0 invitations sent" when the admin was in fact recovering from a
  // prior SMTP outage.
  let resent = 0;
  const errors = [];
  const existingEmails = [];
  const alreadyInvited = []; // not-yet-registered addresses with a live unredeemed invitation
  // SWEEP #501 — whether the account behind this request may approve accounts
  // (read once, live). A live invitation whose inviter cannot approve becomes
  // THIS inviter's when they invite the address again: someone who may approve
  // asked for it, so the account it makes is approved like any of theirs, and
  // its acceptance is credited to them. Fingerprints of the rows so taken over
  // go on the batch's summary record.
  const _mayApproveNow = actorMayApproveNow(req);
  const inviterReplaced = [];
  const _takeOverForApproval = (inv) => {
    if (!_mayApproveNow || inviterMayApproveNow(inv)) return;
    const r = db.prepare("UPDATE invitations SET invited_by=?, invited_by_id=? WHERE id=? AND used_at IS NULL").run(invitedBy, actorId(req) || null, inv.id);
    if (r.changes) inviterReplaced.push(capabilityFingerprint(inv.id, "if_"));
  };
  // v6.3.2: existing users who were already assigned to every selected
  // competition — the INSERT OR IGNORE loop produced 0 new rows. Pre-fix
  // the response left this case uncategorised, so the UI dropped the
  // address from the "keep in textarea" set AND fell through to the
  // generic "No new invitations sent — all addresses were already invited
  // or invalid" toast, both of which are misleading: the admin's intent
  // (re-invite) was silently a no-op instead of being surfaced with a
  // clear "already assigned" label.
  const alreadyAssigned = [];
  // Invitations whose most recent send attempt failed. Returned as objects
  // `{email, link}` so the admin has the registration link available for
  // manual delivery — without that the invitation row is stranded until SMTP
  // recovers AND the admin re-invites the address (and even then the prior
  // alreadyInvited branch wouldn't re-send). See renderInvitationEmail below
  // for the retry logic that re-sends on subsequent admin invites.
  const undeliveredInvites = [];
  // v8.3.7 — kept SEPARATE from undeliveredInvites: same `false` from the sender,
  // opposite meaning to the operator, and only one of the two has a remedy that
  // involves a link.
  const unsubscribedInvites = [];
  // v7.1.4 (audit #5) — collect the invitation-email sends during the per-email
  // loop and dispatch them with bounded concurrency AFTER the loop, instead of
  // awaiting each SMTP round-trip inline (which serialised the whole request).
  const sendTasks = [];
  // v8.13.3 — `revealLink` false withholds the registration link from the response
  // (see `_linkRevealable` below): the mail is still re-sent to the invitee's own
  // mailbox, and the client already renders a link-less undelivered row as "retry
  // or check SMTP".
  const queueInviteSend = (invitationId, toEmail, html, text, regLink, isResend, revealLink = true) => {
    sendTasks.push(async () => {
      const ok = await sendEmailLogged(null, { to: toEmail, subject: `${platformName} — You are invited to participate`, html, text }, "invitation");
      if (ok) {
        db.prepare("UPDATE invitations SET last_send_success=1 WHERE id=?").run(invitationId);
        emailsSent++;
        if (isResend) resent++;
      } else if (isUnsubscribedAddress(toEmail)) {
        // v8.3.7 — AN OPT-OUT IS NOT A DELIVERY FAILURE, and reporting it as one
        // asked the admin to defeat it.
        //
        // `sendEmailLogged` answers `false` for every non-delivery — the right
        // shape for the send path, and the wrong one for the only caller that
        // reports non-delivery to a HUMAN. `invitation` is a suppressible reason,
        // so an address in `unsubscribed_emails` lands here having been
        // deliberately not sent — and it was then surfaced in
        // `undeliveredInvites` WITH the registration link and the copy "share it
        // manually", i.e. the platform telling an operator how to override a
        // recipient's own choice, in the belief they were routing around a broken
        // relay.
        //
        // It is reported separately, with no link. The remedy for an opt-out is
        // to re-subscribe the address (superadmin, Settings → Unsubscribed), not
        // to hand-deliver around it.
        unsubscribedInvites.push({ email: toEmail });
      } else {
        undeliveredInvites.push(revealLink ? { email: toEmail, link: regLink } : { email: toEmail, link: null, linkWithheld: true });
      }
    });
  };
  // v8.13.3 — THE REGISTRATION LINK IS THE INVITATION'S BEARER CAPABILITY, and a
  // re-invite can hand it to somebody whose remit does not cover it. The merge
  // below re-sends an UNCLAIMED invitation whose last send failed and, when SMTP
  // fails again, returns its link "to share manually" — so an event admin who
  // invited an address that already carried ANOTHER organiser's pending invitation
  // was given that invitation's live link. Redeeming it creates a verified,
  // approved account at the invitee's address, enrolled in every event and group
  // the invitation names, those outside the actor's scope included. A scoped actor
  // therefore gets the link only for an invitation that is wholly theirs to hand
  // out: every competition it already named is in their scope (and it named at
  // least one — an event-less invitation is platform-wide, which the role may not
  // create), and every group it already named is one they may write. The merge
  // itself still happens: adding their own event to a pending invitation is the
  // ordinary case. An unscoped admin sees every invitation and keeps the link.
  const _scopeForLinks = scopedCompetitionIds(req);
  const _linkRevealable = (existingCompIds, existingGroupIds) => {
    if (_scopeForLinks === null) return true;
    if (!existingCompIds.length) return false;
    if (existingCompIds.some(cid => !_scopeForLinks.includes(cid))) return false;
    return existingGroupIds.every(gid => !groupWriteDenied(req, gid));
  };

  // De-duplicate the input list (case-insensitive on the trimmed form). The
  // client also de-duplicates, but a tampered/scripted caller could send
  // the same address twice and we'd otherwise: create two invitation rows,
  // attempt two emails, and double-count `assigned` if it resolves to an
  // existing user. The dedup happens AFTER format normalisation so trim/
  // case-fold variants collapse to one entry.
  const _seen = new Set();
  const dedupedEmails = [];
  for (const e of emails) {
    if (typeof e !== "string") continue;
    const k = e.trim().toLowerCase();
    if (!k || _seen.has(k)) continue;
    _seen.add(k);
    dedupedEmails.push(e);
  }

  // v7.11.2 — invitation clash guard (spec req 7, CORRECTED model). Inviting a user to a
  // group is an INDIVIDUAL assignment unless that group is bound to a competition in its
  // OWN right, so only ACTUAL competition_groups bindings count — the invited-competition
  // selection is IRRELEVANT to the group clash. Reject BEFORE any write if the invited
  // group(s) would leave any invitee in ≥2 groups bound to the same competition.
  if (validGroupIds.length) {
    // (1) the invited groups themselves overlap on a competition → would clash for EVERY
    // invitee (existing or new). Evaluate the phantom new invitee (no prior memberships).
    const selfClash = detectMultiGroupAddClashes(validGroupIds, []);
    if (selfClash.length) {
      const detail = selfClash[0].conflicts.map(x => `${x.groups.join(" + ")} on "${x.competitionName}"`).join("; ");
      return res.status(409).json({
        error: `Can't send these invitations — the selected groups overlap on an event: ${detail}. Two groups bound to the same event would put every invitee in more than one group there. Pick groups that aren't both bound to the same event.`,
        clash: { conflicts: selfClash },
      });
    }
    // (2) existing invitees would end up in ≥2 groups bound to the same competition,
    // considering their CURRENT memberships + the invited group(s).
    // Resolve invitees exactly as the WRITE path below does (audit v7.12.3: a
    // pre-check that resolves differently lets an invite slip past the req-7 guard
    // and double-count someone on the team board) — by the PRIMARY address only
    // (v9.0.0: an address held only as a secondary is refused by name in the loop,
    // never resolved to its holder). `COLLATE NOCASE` hits the unique index.
    const _preparedExistingLookup = db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE");
    const existingUserIds = [];
    for (const e of dedupedEmails) {
      const em = sanitiseForLog(normaliseEmail(e));
      const u = _preparedExistingLookup.get(em);
      if (u) existingUserIds.push(u.id);
    }
    if (existingUserIds.length) {
      const userClashes = detectMultiGroupAddClashes(validGroupIds, existingUserIds);
      if (userClashes.length) {
        const detail = userClashes.map(c => `${c.nickname} (${c.conflicts.map(x => `${x.groups.join(" + ")} on "${x.competitionName}"`).join("; ")})`).join("; ");
        return res.status(409).json({
          error: `Can't send these invitations — an existing participant would end up in more than one group for the same event: ${detail}. Remove them from the other group, or pick a different group, before inviting.`,
          clash: { conflicts: userClashes },
        });
      }
    }
  }

  // audit v7.7.36 (P2) — accumulate the groups that actually gained a member
  // and reconcile each ONCE after the email loop, instead of reconciling every
  // selected group per existing-user email. reconcileCompetitionMembership
  // enumerates the full desired-member set + the comp's full membership on each
  // pass, so the pre-fix per-email reconcile was O(emails × group members).
  const _touchedGroupIds = new Set();
  for (const rawEmail of dedupedEmails) {
    // v6.16.9 — per-iteration error containment. Pre-fix a thrown
    // error inside the iteration body (FK violation on a deleted comp,
    // SQLite I/O hiccup, anything unexpected) propagated through the
    // for-loop and crashed the response handler at the Express default
    // error boundary. Emails 1..N-1 already processed silently landed
    // and the admin saw a bare 500 with no signal which addresses
    // were processed. Wrapping each iteration in try/catch + push to
    // errors[] mirrors how the format-validation branch above already
    // surfaces invalid emails. Per-iteration txns inside this loop
    // (existingPerEmailTxn, liveInviteMergeTxn, raceLoserMergeTxn)
    // remain atomic — the outer try only rescues unexpected throws
    // from the OUTER bookkeeping (SELECTs, JSON.parse, audit writes
    // outside any txn).
    try {
    // v6.16.22 — NFC-normalise so encoding variants of the same email
    // collapse to one canonical form before uniqueness check / storage.
    const email = sanitiseForLog(normaliseEmail(rawEmail));
    // Use the same format gate as registration / profile-edit / import
    // (local@domain.tld, no whitespace) — the previous `email.includes("@")`
    // accepted obviously malformed values and stranded invitations that
    // the stricter registration flow would later reject. The free-email
    // rule is intentionally NOT applied here: an admin invitation pre-
    // approves whatever address the admin chose, including personal
    // accounts.
    if (!isValidEmailFormat(email)) { errors.push(`Invalid email: ${rawEmail}`); continue; }

    // Check if already registered — by the PRIMARY address only (v9.0.0). A
    // secondary is an unconfirmed claim anyone can make about an address no
    // account holds, so an invitation to it must not enrol whoever claimed it
    // (operator ruling, 11 Nov 2026: a secondary never signs in or claims an
    // invitation). It is refused by name rather than stored, because a stored
    // invitation to a held address could never be redeemed (sign-up refuses a
    // taken address).
    const existing = db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
    if (!existing && db.prepare("SELECT 1 FROM users WHERE secondary_email=? COLLATE NOCASE").get(email)) {
      errors.push(`${rawEmail}: that address is another account's secondary email — invite the person by their own sign-in (primary) address`);
      continue;
    }
    if (existing) {
      // v6.16.6 — explicit gate on `denied_at`. Pre-fix the existing-user
      // branch fell through to the auto-approve check (which excludes
      // denied users via `!existing.blocked` — denied implies blocked
      // by v6.14.0 invariant) and then the assignment loop reported
      // them as `skippedBlocked`. The admin saw "already registered,
      // skipped" without any signal that the user was in the terminal
      // `denied` state. Surface explicitly so the operator knows to
      // either reverse the denial via /approve or pick a different
      // address. The deny lifecycle is one-way unless reversed; an
      // invitation cannot un-deny a user.
      if (existing.denied_at) {
        errors.push(`${rawEmail}: account has been denied — reverse the denial via Approve before re-inviting`);
        continue;
      }
      // v6.13.21 — auto-approve runs BEFORE the assignment loop so the
      // gate that follows can see the post-auto-approve state. Pre-fix
      // the order was insert-then-auto-approve, but the assignment loop
      // had no gate at all — blocked / unverified / locked users got
      // assigned anyway, even though login still rejected them. Now:
      //
      //   1. Auto-approve fires for verified+!approved+!blocked+!locked
      //      (same gates as the explicit /approve route — these are the
      //      conditions login itself enforces).
      //   2. Assignment runs only if the user is now approved AND not
      //      blocked. Anything that didn't qualify for auto-approve and
      //      isn't already approved gets surfaced via the new
      //      `skippedBlocked` / `skippedUnapproved` counters so the
      //      admin sees the truth instead of a silent no-op.
      const lockedNow = isLockedNow(existing);
      // v6.16.8 — per-email atomicity for the existing-user branch.
      // Pre-fix the auto-approve UPDATE, the assignment INSERT loop,
      // and the audit event writes all ran as separate SQLite
      // statements outside any transaction. SIGKILL between them
      // could leave the user approved without competition_users rows
      // populated (or vice versa), or with partial audit rows. Wrap
      // the whole per-email DB work in db.transaction() so a process
      // death rolls the iteration back cleanly. CxOne provisioning
      // remains deferred via setImmediate — the queued callbacks
      // run AFTER the txn commits and don't touch the DB.
      let didAssign = false;
      // v8.12.0 — a row this loop SKIPPED (staff, author, privileged peer) is
      // not "already a member": without this the same response said
      // `skippedStaff: 1` AND listed the address under `alreadyAssigned`, and
      // the dialog told the organiser there was nothing to do.
      let _skippedThisRow = false;
      let _autoApprovedThisRow = false;
      const _cxoneToProvision = [];
      // Approve is a RIVAL door (lib/staff-compete.js competitorRivalDenied): the
      // invitation's auto-approve is the same write as POST …/:id/approve, so it
      // asks the same authorization question. A rival's account is left pending
      // and counted as `skippedUnapproved`, never approved by the competing actor.
      // The auto-approve is an approval, so it needs the approval permission too:
      // a role that may invite but not approve leaves the account pending. And it
      // asks the approve door's peer rule (lib/rbac.js privilegedTargetFor): a
      // privileged account is a superadmin's to approve, so it stays pending.
      //
      // And it asks the approve door's SCOPE question (sweep #340; lib/event-
      // admin.js participantDenied): for an actor scoped to their events (an
      // event admin, a scoped custom role) an account is theirs to approve only
      // when it is a participant in one of their events. The role half is asked
      // here; the membership half only once the enrolment below has run, so for
      // such an actor the approval is written AFTER the loop, in the same
      // transaction, and only if the account now belongs to one of their events.
      // One whose every enrolment was skipped (a staff spectator, an author, a
      // late entrant who took part) stays pending and is reported in
      // `leftPending`, as the Approve button would have refused it. An unscoped
      // actor approves first, as before: the scope question never refuses it,
      // and the groups' reconcile after commit enrols only an approved account.
      const _scopedInv = scopedCompetitionIds(req) !== null;
      const _approveDenied = competitorRivalDenied(db, competitorIds(req), existing.id)
        || !_actorPermissions(req).perms.has("participants.approve")
        || _privilegedTarget(req, existing.role)
        || (_scopedInv && (existing.role || "participant") !== "participant");
      const _mayApprove = !_approveDenied && existing.verified && !existing.approved && !existing.blocked && !lockedNow;
      const _approveAfter = _mayApprove && _scopedInv;
      const _approveNow = () => {
        db.prepare("UPDATE users SET approved=1, approved_at=?, approved_by=? WHERE id=?")
          .run(createdAt, invitedBy, existing.id);
        recordUserEvent(existing.id, "approved", invitedBy, { via: "invitation_auto_approval", ...rctx });
        existing.approved = 1;  // reflect for the gate below
        _autoApprovedThisRow = true;
      };
      const existingPerEmailTxn = db.transaction(() => {
        if (_mayApprove && !_approveAfter) _approveNow();
        // Auto-assign to competitions (if any selected) — but only for
        // users whose state would actually let them log in.
        if (validComps.length) {
          // v8.12.0 — a blocked or unapproved address is SKIPPED and marked
          // `_skippedThisRow` like the staff/author/privileged skips below. For
          // these two the mark is belt and braces: the `alreadyAssigned` push
          // further down already sits inside a `!blocked && approved` guard, so
          // a lifecycle skip could never have been double-counted; the mark
          // keeps the five skips one shape.
          if (existing.blocked) {
            skippedBlocked++; _skippedThisRow = true;
          } else if (!existing.approved && !_approveAfter) {
            skippedUnapproved++; _skippedThisRow = true;
          } else {
            const insertCU = db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)");
            for (const comp of validComps) {
              // v8.12.0 — the staff row-writer rule (lib/self-enroll.js
              // staffRowRefusal): a spectator gets no row; an author of one of
              // the event's challenges cannot compete there either. Counted
              // apart, so the dialog names the right reason; the assign route
              // is where the author's challenges are listed by title.
              //
              // A row the account ALREADY holds is a membership and takes the
              // idempotent path (INSERT OR IGNORE, "already a member"), not a
              // skip — the assign door's rule. And the reasons answer in the
              // ASSIGN door's order (spectator, then the peer-admin rule, then
              // the author rule), so the two dialogs name the same reason for
              // the same pair: a peer-admin author invited by a regular admin is
              // a privileged skip at both.
              const _heldInv = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, existing.id);
              const _late = lateComps.has(comp.id);
              if (!_heldInv) {
                const _refusal = staffRowRefusal(existing, comp);
                if (_refusal === "spectator") { skippedStaff++; _skippedThisRow = true; continue; }
                if (staffCompeteOn(comp) && _privilegedTarget(req, existing.role)
                    && existing.id !== _actorIdInv) { skippedPrivileged++; _skippedThisRow = true; continue; }
                if (_refusal) { skippedAuthors++; _skippedThisRow = true; continue; }
                // v8.12.6 — last, and only for a NEW row, in the assign door's order.
                if (_late && lateWindowAdmissionDenied(comp, existing.id, lateComps.get(comp.id))) { skippedTookPart++; _skippedThisRow = true; continue; }
              }
              const r = insertCU.run(comp.id, existing.id, invitedBy, createdAt);
              if (r.changes > 0) {
                didAssign = true;
                // v8.12.6 — THE FOURTH RE-ADD SITE, and it was missing the rule the
                // other three share (`closeAbsenceAndRestoreAnchor`): a participant
                // removed from an event and then re-invited into it kept an OPEN
                // absence row and a fresh anchor, instead of their original
                // solve-clock anchor and join time. Now reachable in a new way — a
                // late entrant removed during the window and re-invited — so it is
                // closed here, inside the same transaction as the INSERT.
                closeAbsenceAndRestoreAnchor(existing.id, comp.id, createdAt);
                recordUserEvent(existing.id, "added_to_competition", invitedBy, { competition_id: comp.id, competition_name: comp.name, via: "invitation", ...(_late ? { late_entry: true } : {}), ...rctx });
                recordCompetitionEvent(comp.id, "user_added", invitedBy, { user_id: existing.id, nickname: existing.nickname, via: "invitation", ...(_late ? { late_entry: true } : {}), ...rctx });
                _cxoneToProvision.push(comp.id);
              }
            }
          }
        }
        // Sweep #340 — the organiser's approval, now that the enrolment has run.
        if (_approveAfter) {
          if (!participantDenied(req, existing.id)) _approveNow();
          else {
            // Nothing was written for it: every event of a scoped actor's
            // invitation is in their scope, so an enrolment would have made the
            // account theirs. Kept as an invariant, never as a silent state.
            if (didAssign) throw new Error("invitation: an account left pending was enrolled");
            leftPending.push(email);
          }
        }
        // v6.20.0 — apply target groups immediately for an existing user.
        // Reconciliation (which enrolls them into the groups' bound
        // competitions) runs after the txn commits since it is async.
        // v8.12.0 — THE PEER-ADMIN RULE AT THE GROUP DOOR. Only a superadmin may
        // put an admin or superadmin account into a group (`_privilegedGroupTargets`
        // on the four Groups-tab routes), because a group live-syncs into every
        // event it is bound to — compete events included, where the sync asks no
        // tier question. This was the one door a regular admin could reach it
        // through: inviting the address with a group ticked. Skipped and COUNTED
        // (`skippedPrivilegedGroups`), never silent.
        const _privTargetGrp = _privilegedTarget(req, existing.role)
          && existing.id !== _actorIdInv;
        if (_privTargetGrp && validGroupIds.length) skippedPrivilegedGroups++;
        for (const gid of _privTargetGrp ? [] : validGroupIds) {
          if (db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)").run(gid, existing.id, createdAt, invitedBy).changes > 0) {
            const gname = db.prepare("SELECT name FROM groups WHERE id=?").get(gid)?.name;
            recordUserEvent(existing.id, "group_added", invitedBy, { group_id: gid, name: gname, ...rctx });
            _touchedGroupIds.add(gid); // audit v7.7.36 (P2) — only reconcile groups that actually gained a member
          }
        }
      });
      // v6.16.9 — wrap with mirror buffer so a txn rollback mid-iteration
      // doesn't leak audit-log lines for events the DB will never have.
      runTxnWithMirrorBuffer(() => existingPerEmailTxn());
      // CxOne provisioning fires AFTER the txn commits — the queued
      // callbacks make HTTP calls, not DB writes, and were already
      // deferred via setImmediate pre-fix.
      // v6.16.14 — routed through the CxOne queue (max 5 in-flight).
      for (const cid of _cxoneToProvision) {
        enqueueCxOneProvision(existing, cid, "invite");
      }
      // v6.20.0 — reconcile the target groups' bound competitions so the
      // now-member existing user is enrolled live. audit v7.7.36 (P2) — DEFERRED
      // to one pass per touched group after the email loop (see below), not here.
      if (validComps.length && !existing.blocked && existing.approved) {
        // Outside the txn: same accounting that was here pre-fix.
        // Only count an assignment when INSERT OR IGNORE actually inserted
        // at least one row. Without this guard, re-inviting an already-
        // assigned user inflates `assigned` even though the membership table
        // is unchanged. If nothing was newly added for this address, surface
        // it as `alreadyAssigned` (v6.3.2) so the UI can distinguish "this
        // user was already a member of every selected competition" from the
        // generic "no op" bucket.
        if (didAssign) assigned++;
        else if (!_skippedThisRow) alreadyAssigned.push(email);
      } else if (!validComps.length) {
        existingEmails.push(email);
      }
      // _autoApprovedThisRow is currently informational only — it could
      // surface in the response as `auto_approved` count if the SPA
      // wants to distinguish; today the audit `user_events.approved`
      // row already captures it, so we don't echo separately.
      // concurrency-cache audit (#3): the existing-user branch directly enrolls
      // (INSERT OR IGNORE competition_users) and auto-approves — both are
      // documented writer-lock state changes. reconcileGroupBoundCompetitions
      // only covers group-bound comps (and only when groups were selected); the
      // direct competition enrollments + the approval flip were never
      // invalidated, so /api/me (2s) and the admin Participants list (5s) served
      // stale data. Bust them here (leaderboard too, for invariant symmetry).
      if (didAssign || _autoApprovedThisRow) {
        _invalidateMeCache(existing.id);
        invalidateAdminParticipantsCache();
        for (const cid of _cxoneToProvision) invalidateLeaderboardCache(cid);
      }
      continue;
    }

    // Cross-batch dedup: if a previous admin invitation for this address is
    // still unredeemed, do NOT create a second row. Multiple live links for
    // the same address mean only the first redeemed link succeeds — later
    // ones become dead at the existing-account check during registration,
    // which silently drops any extra competition-assignment intent and
    // confuses both the admin (the extra emails go out) and the invitee
    // (some links work, others mysteriously don't).
    //
    // BUT: a re-invite usually means "also assign these competitions" —
    // dropping the new competitionIds entirely would silently lose the
    // admin's intent. Merge (union) the new comp ids into the existing
    // row so the invitee gets BOTH the original AND the new competitions
    // when they eventually register. The address is reported in
    // `alreadyInvited` either way; if any comps were actually added we
    // also surface that count via the audit row attached to the admin
    // who re-invited them.
    // Helper: render the invitation email for a given invitation id + comp
    // list. Used both for first-time sends and for undelivered-retry sends
    // so the payload is identical (same link, same comp list).
    const renderInvitationEmail = (invId, comps) => {
      // v6.9.10: dedicated /register URL replaces the old
      // `/?invitation=…#register-page` fragment. The client-side
      // bootstrap still recognises the legacy fragment shape too, so
      // links that were already sent out continue to work.
      const regLink = `${baseUrl}/register?invitation=${invId}`;
      let compSection;
      if (comps.length) {
        const compList = comps.map(c => {
          // v8.12.6 — an event taking late entries names its late-entry deadline
          // instead of a start and an end that are both past. The two re-send
          // paths pass a column-naming SELECT, and `eventPolicy` throws on a row
          // with no `event_kind` rather than guessing, so the line reads the full
          // row. No recipient timezone: an invitee has no account yet, and
          // formatEmailDate falls back to UTC and says so.
          // (review) — the EVENT-level line, deliberately, where the assign and
          // group-sync mails ask about their recipient (`lateEntryMailLineFor`):
          // this mail goes only to an address with no account, whose row is
          // written at registration — after the end, by somebody with nothing on
          // record in the event — so "you can still take part as a late entrant"
          // is true of them by construction.
          const full = getCompetition(c.id);
          const lateLine = full ? lateEntryMailLine(full, { nowMs }) : null;
          if (lateLine) return `<li><strong>${escapeHtml(c.name)}</strong><br/>${lateLine}</li>`;
          // The end, or "No fixed deadline" for an open-ended Program: asked of
          // the full row too, which names the kind and the deadline.
          const start = new Date(c.start_time);
          return `<li><strong>${escapeHtml(c.name)}</strong><br/>Starts: ${formatEmailDate(start)}<br/>Ends: ${eventEndMailText(full || c)}</li>`;
        }).join("");
        compSection = `<p>You have been invited to participate in the following event(s):</p><ul style="margin:12px 0">${compList}</ul>`;
      } else {
        compSection = `<p>You have been invited to join <strong>${escapeHtml(platformName)}</strong>.</p>`;
      }
      const { html, text } = buildEmail(platformName, {
        body: compSection + `<p>To get started, create your account using the link below.</p>`,
        linkUrl: regLink, linkText: "Create Your Account",
        fallbackNote: "If you already have an account, simply log in — you have been assigned automatically.",
      });
      return { regLink, html, text };
    };

    const liveInvite = db.prepare(LIVE_INVITATION_SQL).get(email);
    if (liveInvite) {
      _takeOverForApproval(liveInvite);
      let existingCompIds;
      try { existingCompIds = JSON.parse(liveInvite.competition_ids || "[]"); } catch { existingCompIds = []; }
      if (!Array.isArray(existingCompIds)) existingCompIds = [];
      // v6.20.0 — union the re-invite's target groups into the live row too.
      let existingGroupIds;
      try { existingGroupIds = JSON.parse(liveInvite.group_ids || "[]"); } catch { existingGroupIds = []; }
      if (!Array.isArray(existingGroupIds)) existingGroupIds = [];
      const newlyAddedCompIds = validComps.map(c => c.id).filter(cid => !existingCompIds.includes(cid));
      const newlyAddedGroupIds = validGroupIds.filter(gid => !existingGroupIds.includes(gid));
      let mergedCompIds = existingCompIds;
      // v6.16.8 — wrap the merge UPDATE + per-comp audit events in a
      // single per-email txn so a SIGKILL mid-iteration can't leave
      // the invitations row updated without the matching audit rows.
      if (newlyAddedCompIds.length || newlyAddedGroupIds.length) {
        mergedCompIds = [...existingCompIds, ...newlyAddedCompIds];
        const mergedGroupIds = [...existingGroupIds, ...newlyAddedGroupIds];
        const liveInviteMergeTxn = db.transaction(() => {
          db.prepare("UPDATE invitations SET competition_ids=?, group_ids=? WHERE id=?")
            .run(JSON.stringify(mergedCompIds), JSON.stringify(mergedGroupIds), liveInvite.id);
          for (const cid of newlyAddedCompIds) {
            const compName = getCompetition(cid)?.name || cid;
            // v8.13.3 — the FINGERPRINT, never the id: this row is returned by the
            // History route to an organiser of ANY one of the invitation's events
            // and mirrored into app.jsonl for every admin, and the id is a live
            // bearer capability until it is claimed (lib/audit capabilityFingerprint).
            recordCompetitionEvent(cid, "invitation_competition_added", invitedBy, { invitation_fp: capabilityFingerprint(liveInvite.id, "if_"), email, competition_name: compName, ...rctx });
          }
        });
        try { runTxnWithMirrorBuffer(() => liveInviteMergeTxn()); } catch (e) { swallowed("invitations:live-invite-merge", e); }
      }
      // If the prior send failed, a plain alreadyInvited response would
      // strand the invitee forever — their invitation row exists but they
      // never got the mail, and without a second send attempt there's no
      // recovery path. An admin re-invite is the operator's intent to try
      // again, so re-send the mail here. On success, flip last_send_success
      // and report as a fresh send; on failure, keep last_send_success=0
      // and surface the link in undeliveredInvites so the admin can share
      // it manually.
      if (!liveInvite.last_send_success) {
        const allComps = mergedCompIds.length
          ? db.prepare(`SELECT id, name, start_time, duration_minutes FROM competitions WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(mergedCompIds))
          : [];
        const { regLink, html, text } = renderInvitationEmail(liveInvite.id, allComps);
        queueInviteSend(liveInvite.id, email, html, text, regLink, true, _linkRevealable(existingCompIds, existingGroupIds));
        continue;
      }
      alreadyInvited.push(email);
      continue;
    }

    // Create invitation. The DB has a partial unique index on
    // (email COLLATE NOCASE) WHERE used_at IS NULL, so a racing second
    // instance's INSERT fails with SQLITE_CONSTRAINT — we then re-read the
    // winning row and treat this request as a re-invite (merge comps, retry
    // send if needed), preserving cross-instance dedup atomically.
    const invId = uuid();
    let raceLoser = null;
    try {
      db.prepare("INSERT INTO invitations (id, email, competition_ids, group_ids, invited_by, invited_by_id, created_at, last_send_success) VALUES (?,?,?,?,?,?,?,0)")
        .run(invId, email, compIdJson, groupIdJson, invitedBy, actorId(req) || null, createdAt);
    } catch (e) {
      if (e && (e.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(e.message || ""))) {
        raceLoser = db.prepare(LIVE_INVITATION_SQL).get(email);
        if (raceLoser) _takeOverForApproval(raceLoser);
      } else {
        throw e;
      }
    }

    if (raceLoser) {
      // Cross-instance race: the other instance's row wins. Merge any comps
      // the losing request still intended to add, and if the winning row's
      // send failed previously, attempt a retry from this request.
      let existingCompIds;
      try { existingCompIds = JSON.parse(raceLoser.competition_ids || "[]"); } catch { existingCompIds = []; }
      if (!Array.isArray(existingCompIds)) existingCompIds = [];
      let existingGroupIds;
      try { existingGroupIds = JSON.parse(raceLoser.group_ids || "[]"); } catch { existingGroupIds = []; }
      if (!Array.isArray(existingGroupIds)) existingGroupIds = [];
      const newlyAddedCompIds = validComps.map(c => c.id).filter(cid => !existingCompIds.includes(cid));
      const newlyAddedGroupIds = validGroupIds.filter(gid => !existingGroupIds.includes(gid));
      let mergedCompIds = existingCompIds;
      // v6.16.8 — same per-email txn wrapping as the liveInvite branch above.
      if (newlyAddedCompIds.length || newlyAddedGroupIds.length) {
        mergedCompIds = [...existingCompIds, ...newlyAddedCompIds];
        const mergedGroupIds = [...existingGroupIds, ...newlyAddedGroupIds];
        const raceLoserMergeTxn = db.transaction(() => {
          db.prepare("UPDATE invitations SET competition_ids=?, group_ids=? WHERE id=?").run(JSON.stringify(mergedCompIds), JSON.stringify(mergedGroupIds), raceLoser.id);
          for (const cid of newlyAddedCompIds) {
            const compName = getCompetition(cid)?.name || cid;
            recordCompetitionEvent(cid, "invitation_competition_added", invitedBy, { invitation_fp: capabilityFingerprint(raceLoser.id, "if_"), email, competition_name: compName, ...rctx });
          }
        });
        try { runTxnWithMirrorBuffer(() => raceLoserMergeTxn()); } catch (e) { swallowed("invitations:race-loser-merge", e); }
      }
      if (!raceLoser.last_send_success) {
        const allComps = mergedCompIds.length
          ? db.prepare(`SELECT id, name, start_time, duration_minutes FROM competitions WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(mergedCompIds))
          : [];
        const { regLink, html, text } = renderInvitationEmail(raceLoser.id, allComps);
        queueInviteSend(raceLoser.id, email, html, text, regLink, true, _linkRevealable(existingCompIds, existingGroupIds));
      } else {
        alreadyInvited.push(email);
      }
      continue;
    }

    const { regLink, html, text } = renderInvitationEmail(invId, validComps);
    // The invitee may not be a registered user yet (userId null); we skip
    // event logging in that case. Track delivery separately from the
    // invitation-row creation: an admin needs to know if SMTP is broken
    // — the link still works if they share it manually, so it rides in
    // the undeliveredInvites response so the admin can share it.
    invited++;
    queueInviteSend(invId, email, html, text, regLink, false);
    } catch (e) {
      // v6.16.9 — per-iteration containment. See preamble.
      // v6.16.14 — sanitise the error message exposed to the response.
      // Pre-fix raw `e.message` propagated SQLite-level details
      // (`database is locked`, `FOREIGN KEY constraint failed: ...`,
      // `disk I/O error`, internal hostnames in upstream errors)
      // verbatim into operator-facing JSON. The full stack still goes
      // to the app log so an operator can grep for the request id; the
      // response surface gets a generic message so a leaked CSRF / rogue
      // admin tooling can't probe internal state via the bulk-invite
      // return shape.
      //
      // This line was a bare `console.error`, and the sentence above it has
      // promised since v6.16.14 that an operator could "grep for the request
      // id" — which that line never carried: the console.* override stamps
      // `{legacy:true}` and nothing else. The log.error below puts req_id, ip
      // and the session on it, so the claim is true for the first time.
      const _logId = crypto.randomBytes(4).toString("hex");
      log.error({ ...reqContext(req), tag: "invitations", email: sanitiseForLog(rawEmail), log_id: _logId, err: (e && e.message) || String(e), stack: (e && e.stack) || null }, "[invitations] iteration error");
      errors.push(`${rawEmail}: internal error (logId=${_logId})`);
    }
  }

  // audit v7.7.36 (P2) — reconcile each group that gained a member ONCE, now that
  // the whole batch is enrolled (mirrors the participants-import deferred reconcile).
  for (const gid of _touchedGroupIds) await reconcileGroupBoundCompetitions(gid, { actor: invitedBy });

  // v7.1.4 (audit #5) — fan the invitation emails out with bounded concurrency
  // (collected per-email above) instead of one serial SMTP round-trip per invitee.
  // ext-audit v7.15.14 — the invitations are already persisted; cap how long we
  // hold the response open for SMTP so the client never times out on committed
  // work (which reads as failure and invites a duplicate re-send).
  const _inviteMail = await _runBoundedWithDeadline(sendTasks, 8, 10_000);

  // v6.16.29 — batch-summary audit event. Per-iteration record* calls
  // lock the per-email trail; this row reconstructs the whole bulk
  // invite (admin / total / counts) as a single forensic record.
  try {
    recordOrphanedAuditEvent("invitation", "bulk", "batch_sent", invitedBy, {
      ...reqContext(req),
      total_emails: emails.length,
      competition_count: Array.isArray(competitionIds) ? competitionIds.length : 0, // audit v7.7.37 (C9) — competitionIds is optional; .length on undefined threw + swallowed the whole batch_sent event
      invited, assigned, emails_sent: emailsSent, resent,
      already_invited: alreadyInvited.length,
      already_assigned: alreadyAssigned.length,
      undelivered_invites: undeliveredInvites.length,
      unsubscribed_invites: unsubscribedInvites.length,
      skipped_blocked: skippedBlocked,
      skipped_unapproved: skippedUnapproved,
      skipped_took_part: skippedTookPart,
      left_pending: leftPending.length,
      errors_count: errors.length,
      ...(inviterReplaced.length ? { inviter_replaced: inviterReplaced.length, inviter_replaced_fps: inviterReplaced } : {}),
    });
  } catch (e) { swallowed("invitations:batch-sent-audit", e); }
  // `emailsDeferred` — the invitations are committed; some sends were still in
  // flight when we replied, so emailsSent / undeliveredInvites are provisional.
  res.json({ ok: true, invited, assigned, emailsSent, resent, errors, existingEmails, alreadyInvited, alreadyAssigned, undeliveredInvites, unsubscribedInvites, skippedBlocked, skippedUnapproved, skippedStaff, skippedPrivileged, skippedPrivilegedGroups, skippedAuthors, skippedTookPart, leftPending,
    // v8.12.6 — the events admitted through their late-entry window. Absent when none.
    ...(lateComps.size ? { lateEntryCompetitionIds: [...lateComps.keys()] } : {}),
    ...(_inviteMail.deferred ? { emailsDeferred: true } : {}) });
});

// ── CxOne per-competition endpoints ─────────────────────────────────────────
};
