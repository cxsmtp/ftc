"use strict";

// Claiming a live invitation for an account at the moment it proves the
// invited inbox, never before: the redemption of an EMAILED sign-in code sent to
// that address, or a sign-up (routes/auth.js POST /api/register) behind its live
// address-proof grant; an account held for approval claims at its first sign-in.
// A registration form cannot be submitted for an existing address (no address
// proof is minted for one), and an unauthenticated form proves nothing about the
// inbox, so nothing is claimed without a proven inbox.
//
// The claim grants what the invitation grants, through the same per-event rules
// every admission door asks: `competitionAdmission` (ended and not taking late
// entries → skipped), the late-entry took-part refusal, the staff row-writer
// rule (`staffRowRefusal`), and the one-bound-group-per-competition clash guard
// for groups. A refusal skips that grant and is logged; it never blocks the
// sign-in. The invitation is claimed (used_at, user_id) whatever was skipped,
// as the registration path claims an invitation whose events were deleted.
//
// Top of its own small DAG: requires group-sync (the reconcile after commit), so
// nothing in lib/ may require this module.

const db = require("../db");
const { now } = require("./time");
const { log } = require("./log");
const { swallowed } = require("./best-effort");
const { recordUserEvent, recordCompetitionEvent, runTxnWithMirrorBuffer, reqContext, capabilityFingerprint } = require("./audit");
const { getCompetition, competitionAdmission, competitionEffectiveEnd, lateWindowAdmissionDenied, closeAbsenceAndRestoreAnchor } = require("./competitions");
const { staffRowRefusal } = require("./self-enroll");
const { detectMemberAddClashes, reconcileGroupBoundCompetitions } = require("./group-sync");
const { enqueueCxOneProvision } = require("./cxone");
const { _invalidateMeCache } = require("./me-cache");
const { invalidateAdminParticipantsCache } = require("./participants-cache");
const { invalidateLeaderboardCache } = require("./leaderboard");

function _jsonIds(raw) {
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string") : []; }
  catch { return []; }
}

/**
 * Claim every live invitation addressed to `email` onto `user`. Returns the
 * number of invitations claimed. Never throws (a failure is logged).
 */
function claimInvitationsForAccount(user, email, req) {
  let claimedCount = 0;
  const addedComps = [];
  const addedGroups = [];
  try {
    // `email=? COLLATE NOCASE` with `used_at IS NULL` is answered by the partial
    // uq_invitations_live_email index; LOWER(email) scanned every invitation on
    // every code redeem (same ASCII-only fold).
    const invs = db.prepare("SELECT * FROM invitations WHERE used_at IS NULL AND email=? COLLATE NOCASE").all(email);
    if (!invs.length) return 0;
    const ctx = req ? reqContext(req) : {};
    for (const invitation of invs) {
      const compIds = _jsonIds(invitation.competition_ids);
      const groupIds = _jsonIds(invitation.group_ids);
      const txn = db.transaction(() => {
        const nowIso = now().toISOString();
        const claimed = db.prepare("UPDATE invitations SET used_at=?, user_id=? WHERE id=? AND used_at IS NULL")
          .run(nowIso, user.id, invitation.id);
        if (!claimed.changes) return;
        claimedCount++;
        const insertCU = db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)");
        for (const cid of compIds) {
          const comp = getCompetition(cid);
          if (!comp) {
            log.warn({ ...ctx, tag: "invitation", invitation_fp: capabilityFingerprint(invitation.id, "if_"), user_id: user.id, competition_id: cid, reason: "event_deleted" },
              "invitation claim skipped an event that no longer exists");
            continue;
          }
          const adm = competitionAdmission(comp);
          if (!adm) {
            log.warn({ ...ctx, tag: "invitation", invitation_fp: capabilityFingerprint(invitation.id, "if_"), user_id: user.id, competition_id: cid },
              "invitation claim skipped an event that has ended and is not taking late entries");
            continue;
          }
          const late = adm === "late";
          if (late
              && !db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(cid, user.id)
              && lateWindowAdmissionDenied(comp, user.id, competitionEffectiveEnd(comp))) {
            log.warn({ ...ctx, tag: "invitation", invitation_fp: capabilityFingerprint(invitation.id, "if_"), user_id: user.id, competition_id: cid, code: "late_entry_took_part" },
              "invitation claim skipped an event the participant took part in before it ended");
            continue;
          }
          const staffRefusal = staffRowRefusal(user, comp);
          if (staffRefusal) {
            const spectator = staffRefusal === "spectator";
            log.warn({ ...ctx, tag: "invitation", invitation_fp: capabilityFingerprint(invitation.id, "if_"), user_id: user.id, competition_id: cid, reason: spectator ? "staff_spectator" : "challenge_author" },
              spectator ? "invitation claim skipped an event a staff member only watches (staff do not compete in it)"
                : "invitation claim skipped an event the participant wrote challenges for (staff compete there)");
            continue;
          }
          if (insertCU.run(cid, user.id, invitation.invited_by, nowIso).changes > 0) {
            closeAbsenceAndRestoreAnchor(user.id, cid, nowIso);
            addedComps.push(cid);
            recordUserEvent(user.id, "added_to_competition", invitation.invited_by, { ...ctx, competition_id: cid, competition_name: comp.name, via: "invitation_existing_account", ...(late ? { late_entry: true } : {}) });
            recordCompetitionEvent(cid, "user_added", invitation.invited_by, { ...ctx, user_id: user.id, via: "invitation_existing_account", ...(late ? { late_entry: true } : {}) });
          }
        }
        const insertGM = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)");
        for (const gid of groupIds) {
          const g = db.prepare("SELECT name FROM groups WHERE id=?").get(gid);
          if (!g) {
            log.warn({ ...ctx, tag: "invitation", invitation_fp: capabilityFingerprint(invitation.id, "if_"), user_id: user.id, group_id: gid, reason: "group_deleted" },
              "invitation claim skipped a group that no longer exists");
            continue;
          }
          if (detectMemberAddClashes(gid, [user.id]).length) {
            log.warn({ ...ctx, tag: "invitation", invitation_fp: capabilityFingerprint(invitation.id, "if_"), user_id: user.id, group_id: gid, reason: "group_clash" },
              "invitation claim skipped a group that would put the participant in two teams of one event");
            continue;
          }
          if (insertGM.run(gid, user.id, nowIso, invitation.invited_by).changes > 0) {
            addedGroups.push({ gid, actor: invitation.invited_by });
            recordUserEvent(user.id, "group_added", invitation.invited_by, { ...ctx, group_id: gid, name: g.name, via: "invitation_existing_account" });
          }
        }
      });
      runTxnWithMirrorBuffer(() => txn());
    }
  } catch (e) {
    try { log.error({ err: e && e.message, user_id: user.id }, "failed to apply an invitation to an existing account at sign-in"); } catch (e2) { swallowed("invitation-claim:failure-log", e2); }
  }
  if (claimedCount) {
    _invalidateMeCache(user.id);
    invalidateAdminParticipantsCache();
    for (const cid of addedComps) {
      try { invalidateLeaderboardCache(cid); } catch (e) { swallowed("invitation-claim:lb-bust", e); }
      try { enqueueCxOneProvision(user, cid, "invite_existing_account"); } catch (e) { swallowed("invitation-claim:cxone-enqueue", e); }
    }
    for (const { gid, actor } of addedGroups) {
      reconcileGroupBoundCompetitions(gid, { actor, context: req ? reqContext(req) : undefined }).catch((e) => swallowed("invitation-claim:group-reconcile", e, { level: "warn" }));
    }
  }
  return claimedCount;
}

module.exports = { claimInvitationsForAccount };
