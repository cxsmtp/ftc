"use strict";

// Participant-group routes: comp↔group bindings, group CRUD, members,
// server-paginated picker, and the per-participant group chip. Live-sync to
// bound competitions runs through lib/group-sync. (v7.0.0 refactor: route split.)

const { v4: uuid } = require("uuid");
const db = require("../db");
const { rateLimit, requireAdmin, csrfProtection } = require("../lib/middleware");
const { getCompetition, competitionStatus, competitionAdmission, competitionEffectiveEnd } = require("../lib/competitions");
const { lateEntryDeadline } = require("../lib/late-entry");
const { eventPolicyForWire } = require("../lib/event-policy"); // v8.1.0 (PR 12)
const { getAdminIdentity, recordCompetitionEvent, recordUserEvent, recordOrphanedAuditEvent, runTxnWithMirrorBuffer , reqContext } = require("../lib/audit");
const { reconcileCompetitionMembership, reconcileGroupBoundCompetitions, _clearTombstonesForGroupLeave, detectMemberAddClashes, findGroupByName } = require("../lib/group-sync");
const { BULK_ADMIN_MAX } = require("../lib/config");
// v8.7.0 — the event-admin scope. Every predicate returns null when ALLOWED and
// `{code,message}` when refused; the message is rendered to the actor, so it is
// passed through rather than replaced with a generic one.
const {
  actorId, competitorIds, scopedCompetitionIds, scopeFilterSql,
  competitionDenied, participantDenied, memberTargetsDenied,
  groupViewDenied, groupWriteDenied, groupDeleteDenied,
} = require("../lib/event-admin");
const { competitorIn, competitorEditDenied, competitorGroupDenied, refuseCompetitor } = require("../lib/staff-compete"); // v8.12.0

function _deny403(res, denied) {
  return res.status(403).json({ error: denied.message, code: denied.code });
}

// v7.11.1 — shared 409 body for a member-add that would put a participant in ≥2
// groups bound to the same competition (spec req 7 back-door guard).
function _memberClashResponse(res, groupId, groupName, clashes) {
  const detail = clashes.map(c =>
    `${c.nickname} (already in ${c.conflicts.map(x => `${x.groups.join(" + ")} on "${x.competitionName}"`).join("; ")})`
  ).join("; ");
  return res.status(409).json({
    error: `Can't add to "${groupName}" — a participant can only be in one group per event, and this would clash: ${detail}. Remove each listed participant from the other group(s), or unbind a group from the event, then try again.`,
    clash: { groupId, groupName, conflicts: clashes },
  });
}
const { invalidateAdminParticipantsCache } = require("../lib/participants-cache");
const { _groupNameOk, GROUP_NAME_MAX, _groupNameKey, clampPagingIndex, _firstNonStringField } = require("../lib/util");
const { now } = require("../lib/time");

// Bulk fan-out cap (matches the assign / invite / bulk-approve routes in server.js).

// v7.1.x — a regular admin may not add/remove a privileged colleague (admin or
// superadmin) to/from a group. Groups are live-synced to bound competitions, so
// peer tampering could enroll/remove an admin from competitions via a bound
// group — the same vector the per-participant group routes already block
// (POST/DELETE /api/admin/participants/:id/groups). The BULK routes
// (create-with-members, bulk-add, single-remove) must enforce the identical
// gate, else the per-participant guard is trivially bypassable. Returns the
// subset of ids that are privileged targets, or [] when the actor is a
// superadmin (who may modify anyone).
function _privilegedGroupTargets(req, userIds) {
  if (req.session.isSuperAdmin || !userIds.length) return [];
  // One bound JSON parameter (json_each), never spliced placeholders: the
  // statement text is constant whatever the request sends. Each role is decided
  // once by the ONE privileged-target predicate (lib/rbac.js privilegedTargetFor).
  const rows = db.prepare("SELECT id, role FROM users WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(userIds));
  const actor = _actorPermissions(req);
  const byRole = new Map();
  return rows.filter(r => {
    const k = r.role || "participant";
    if (!byRole.has(k)) byRole.set(k, _privilegedTarget(req, k, { actor }));
    return byRole.get(k);
  }).map(r => r.id);
}
// RBAC — the privileged-target rule (an unscoped role, built-in or custom, or one
// holding a permission the actor lacks) is lib/rbac.js privilegedTargetFor.
const { privilegedTargetFor: _privilegedTarget, actorPermissions: _actorPermissions } = require("../lib/rbac");
const PRIVILEGED_GROUP_TARGET_ERROR = "Only a superadmin can modify group membership on an admin or superadmin account.";

module.exports = function register(app) {
app.get("/api/admin/competitions/:id/groups", requireAdmin, (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — a NAMED event is refused rather than answered with an empty list:
  // on an admin surface "no groups" and "not your event" are indistinguishable.
  const _cd = competitionDenied(req, req.params.id);
  if (_cd) return _deny403(res, _cd);
  const groups = db.prepare(
    `SELECT g.id, g.name, cg.assigned_at,
       (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
     FROM competition_groups cg JOIN groups g ON g.id=cg.group_id
     WHERE cg.competition_id=? ORDER BY g.name COLLATE NOCASE`
  ).all(req.params.id);
  res.json({ groups });
});

// Unbind a group from a competition → reconcile (removes that group's
// now-orphaned group-only members per the live-sync rules).
app.delete("/api/admin/competitions/:id/groups/:groupId", requireAdmin, csrfProtection, async (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — BOTH ends, and both before the DELETE. The competition side is the
  // obvious one; the group side matters because unbinding reconciles membership,
  // and a group shared with an event outside this actor's scope must not be
  // reshaped from here (groupWriteDenied's transitive-effect rule).
  // v8.12.0 — a competitor may not unbind a group from the event they compete in.
  { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
  const _cd = competitionDenied(req, req.params.id);
  if (_cd) return _deny403(res, _cd);
  const _gd = groupWriteDenied(req, req.params.groupId);
  if (_gd) return _deny403(res, _gd);
  const adminId = getAdminIdentity(req);
  const r = db.prepare("DELETE FROM competition_groups WHERE competition_id=? AND group_id=?").run(req.params.id, req.params.groupId);
  if (r.changes > 0) {
    recordCompetitionEvent(comp.id, "group_unbound", adminId, { group_id: req.params.groupId, ...reqContext(req) });
    await reconcileCompetitionMembership(getCompetition(comp.id), { actor: adminId, context: reqContext(req) });
  }
  res.json({ ok: true, unbound: r.changes > 0 });
});
app.get("/api/admin/groups", requireAdmin, (req, res) => {
  // v8.7.0 — an event admin sees the groups they CREATED, union the groups bound
  // to one of their events. It is a SQL predicate rather than a post-filter
  // because this list already carries per-row COUNT subqueries and may later
  // page: a JS filter would leave the counts right and the page size wrong.
  //
  // ids === [] (an event admin with no grants) keeps ONLY the created-by arm,
  // which is exactly what `groupViewDenied` answers for the same actor — the
  // list and the per-entity predicate must never disagree about one group.
  const _scope = scopedCompetitionIds(req);
  let where = "";
  let params = [];
  if (_scope !== null) {
    const boundArm = _scope.length
      ? ` OR EXISTS (SELECT 1 FROM competition_groups cgs
                      WHERE cgs.group_id=g.id AND cgs.competition_id IN (SELECT value FROM json_each(?)))`
      : "";
    // A null actor id (the built-in superadmin) is unscoped and never reaches
    // here; were it to, `created_by_id = NULL` is never true, so this fails closed.
    where = ` WHERE (g.created_by_id = ?${boundArm})`;
    params = _scope.length ? [actorId(req), JSON.stringify(_scope)] : [actorId(req)];
  }
  const rows = db.prepare(`
    SELECT g.id, g.name,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id)        AS member_count,
      (SELECT COUNT(*) FROM competition_groups cg WHERE cg.group_id=g.id)   AS competition_count
    FROM groups g${where} ORDER BY g.name COLLATE NOCASE
  `).all(...params);
  // v8.7.0 — THE ANSWER PER ROW, not the rule. Both are genuinely different
  // questions: `can_write` is refused when the group is ALSO bound to an event
  // outside this actor's scope (membership live-syncs into every bound event, so
  // editing would move people in somebody else's), while `can_delete` is
  // creator-only. A group can therefore be writable and undeletable, or neither,
  // and the client cannot work that out from anything it can see.
  //
  // `true` for every unscoped actor, so admin / superadmin behaviour is unchanged
  // and no predicate runs for them.
  const _eaScoped = scopedCompetitionIds(req) !== null;
  // v8.12.0 — THE COMPETITOR LOCK FOLDED INTO THE SAME TWO ANSWERS. A group bound
  // to an event the actor competes in cannot be written or deleted by them (every
  // membership door refuses `competitor_cannot_edit`), so the flags say so and
  // `competing` names the event — the same answer-not-the-rule shape, or the
  // Groups pane offered Members and Delete on exactly the rows the server refuses.
  //
  // `can_bind` is the SCOPE answer alone — "may I bind this group to another
  // event" (the assign route asks `groupWriteDenied` and not the competitor
  // lock there, because binding changes the TARGET event's roster, not the
  // group's) — so a picker that binds does not withhold a group the server would
  // accept, which is v7.14.2 with the sides swapped.
  const _actor = actorId(req);
  res.json(rows.map(g => {
    const _cmp = _actor ? competitorGroupDenied(db, _actor, g.id) : null;
    const _scopeOk = !_eaScoped || !groupWriteDenied(req, g.id);
    return {
      ...g,
      can_write:  !_cmp && _scopeOk,
      can_bind:   _scopeOk,
      can_delete: !_cmp && (!_eaScoped || !groupDeleteDenied(req, g.id)),
      ...(_cmp ? { competing: { competition_id: _cmp.competitionId, competition_name: _cmp.competitionName } } : {}),
    };
  }));
});

app.post("/api/admin/groups", requireAdmin, csrfProtection, (req, res) => {
  const { name, userIds } = req.body;
  if (!_groupNameOk(name)) return res.status(400).json({ error: `Group name is required and must be ${GROUP_NAME_MAX} characters or fewer.` });
  const trimmed = name.trim();
  // v8.11.1 (external audit F4) — THE FOURTH WAY INTO GROUP MEMBERSHIP.
  //
  // The sibling route's comment (POST /groups/:id/members, below) enumerates
  // "the three ways into group membership" and adds `memberTargetsDenied` so
  // they cannot give three different answers. This create's `userIds` seed is a
  // fourth way, and it was the one that enumeration missed: it applied only
  // `_privilegedGroupTargets` — the peer-ADMIN guard, a different rule — so the
  // very target id the members route refuses 403 was accepted here, and the
  // group's own members list then read that participant's name, nickname and
  // EMAIL straight back (`groupViewDenied` passes: the actor created the group).
  //
  // MEASURED as a complete chain for a ZERO-GRANT organiser — the actor who must
  // see least, and the state left behind by revoking somebody's last event: they
  // read participant ids out of `GET /api/leaderboard` as an ordinary enrolled
  // participant, fed them straight into this route, and read the victim's email
  // out of the group. No out-of-band knowledge at any step, and their own
  // participants list was empty throughout.
  //
  // ABOVE the name checks, per this file's own house rule stated on the members
  // route ("before any body validation, so a refused request cannot even be told
  // whether its payload was well-formed"). It moves nothing for an ordinary
  // admin: `memberTargetsDenied` returns null immediately for an unscoped actor,
  // so a duplicate-name 409 is byte-identical at any ordering. A seedless create
  // is likewise untouched — an empty target list returns null — which is what
  // keeps a zero-grant organiser's ordinary "create a group" working.
  const _mtSeed = memberTargetsDenied(req, Array.isArray(userIds) ? userIds.filter(x => typeof x === "string") : []);
  if (_mtSeed) return _deny403(res, _mtSeed);
  // ext-audit v7.15.6 — Unicode-aware key: COLLATE NOCASE folds ASCII only,
  // so "Äudit Team" and "äudit Team" both passed this check.
  if (findGroupByName(trimmed))
    return res.status(409).json({ error: "A group with this name already exists." });
  const id = uuid();
  const adminId = getAdminIdentity(req);
  const createdAt = now().toISOString();
  const ids = Array.isArray(userIds) ? Array.from(new Set(userIds.filter(x => typeof x === "string"))) : [];
  // v6.20.6 — bound the initial-members fanout. Mirror the cap on
  // POST /api/admin/groups/:id/members so a single create call can't
  // trigger reconciliation across an arbitrarily large desired set.
  if (ids.length > BULK_ADMIN_MAX) return res.status(400).json({ error: `Cannot create a group with more than ${BULK_ADMIN_MAX} members in a single request.` });
  if (_privilegedGroupTargets(req, ids).length) return res.status(403).json({ error: PRIVILEGED_GROUP_TARGET_ERROR });
  // v7.21.32 — computed ONCE per request, not per member: reqContext reads the
  // same request every time, and this loop runs up to BULK_ADMIN_MAX times.
  const rctx = reqContext(req);
  try {
    // runTxnWithMirrorBuffer (ext-audit F4): each recordUserEvent("group_added")
    // emit is followed by further INSERTs in the loop, so a rollback past an
    // emit would strand ghost app.jsonl mirror lines. Buffer until commit.
    runTxnWithMirrorBuffer(db.transaction(() => {
      // v8.7.0 — `created_by` keeps its email (the audit trail); `created_by_id`
      // is the AUTHORIZATION column, and it is a user id because an email moves
      // (PUT /api/me stages a change) and an event admin who corrected their own
      // address would otherwise lose ownership of every group they had created.
      db.prepare("INSERT INTO groups (id, name, name_key, created_at, created_by, created_by_id) VALUES (?,?,?,?,?,?)").run(id, trimmed, _groupNameKey(trimmed), createdAt, adminId, actorId(req));
      const insMember = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)");
      for (const uid of ids) {
        if (!db.prepare("SELECT id FROM users WHERE id=?").get(uid)) continue;
        if (insMember.run(id, uid, createdAt, adminId).changes > 0)
          recordUserEvent(uid, "group_added", adminId, { group_id: id, name: trimmed, ...rctx });
      }
    }));
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "A group with this name already exists." });
    throw e;
  }
  invalidateAdminParticipantsCache();
  recordOrphanedAuditEvent("group", id, "group_created", adminId, { name: trimmed, members: ids.length, ...reqContext(req) });
  const member_count = db.prepare("SELECT COUNT(*) c FROM group_members WHERE group_id=?").get(id).c;
  res.json({ ok: true, group: { id, name: trimmed, member_count, competition_count: 0 } });
});

app.put("/api/admin/groups/:id", requireAdmin, csrfProtection, (req, res) => {
  const { name } = req.body;
  if (!_groupNameOk(name)) return res.status(400).json({ error: `Group name is required and must be ${GROUP_NAME_MAX} characters or fewer.` });
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  // v8.7.0 — a rename is visible in every event this group is bound to, so it
  // needs the WRITE predicate (every binding in scope), not merely the view one.
  const _gd = groupWriteDenied(req, req.params.id);
  if (_gd) return _deny403(res, _gd);
  const trimmed = name.trim();
  if (findGroupByName(trimmed, req.params.id))
    return res.status(409).json({ error: "A group with this name already exists." });
  const adminId = getAdminIdentity(req);
  try { db.prepare("UPDATE groups SET name=?, name_key=? WHERE id=?").run(trimmed, _groupNameKey(trimmed), req.params.id); }
  catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "A group with this name already exists." });
    throw e;
  }
  invalidateAdminParticipantsCache();
  recordOrphanedAuditEvent("group", req.params.id, "group_renamed", adminId, { from: group.name, to: trimmed, ...reqContext(req) });
  res.json({ ok: true, group: { id: req.params.id, name: trimmed } });
});

app.delete("/api/admin/groups/:id", requireAdmin, csrfProtection, async (req, res) => {
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  // v8.7.0 — deleting is CREATOR-ONLY (a stricter rule than groupWriteDenied's):
  // the delete cascades the bindings and reconciles every bound competition, and
  // "I can see this group because my event uses it" is not a mandate to destroy
  // a group somebody else made. Refused BEFORE the cascade, so a refusal leaves
  // the bindings and the membership intact.
  const _gd = groupDeleteDenied(req, req.params.id);
  if (_gd) return _deny403(res, _gd);
  // v8.12.0 — a delete unbinds the group from, and reconciles, every bound
  // event: the competitor lock's transitive door, refused like the unbind is.
  { const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  const adminId = getAdminIdentity(req);
  // Capture bound competitions before the FK cascade wipes the bindings, so we
  // can reconcile each one (dropping this group's now-orphaned group-only members).
  const boundCompIds = db.prepare("SELECT competition_id FROM competition_groups WHERE group_id=?").all(req.params.id).map(r => r.competition_id);
  db.prepare("DELETE FROM groups WHERE id=?").run(req.params.id); // cascades group_members + competition_groups
  invalidateAdminParticipantsCache();
  recordOrphanedAuditEvent("group", req.params.id, "group_deleted", adminId, { name: group.name, ...reqContext(req) });
  for (const cid of boundCompIds) await reconcileCompetitionMembership(getCompetition(cid), { actor: adminId, context: reqContext(req) });
  res.json({ ok: true });
});

app.post("/api/admin/groups/:id/members", requireAdmin, csrfProtection, async (req, res) => {
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  // v8.7.0 — before any body validation, so a refused request cannot even be
  // told whether its payload was well-formed. Membership live-syncs into every
  // bound competition, so a group shared with an event outside this scope is
  // refused outright rather than partially applied.
  const _gd = groupWriteDenied(req, req.params.id);
  if (_gd) return _deny403(res, _gd);
  // v8.12.0 — membership live-syncs into every bound event, so a competitor may
  // not add people to a group bound to the event they compete in (they would be
  // enrolling people onto their own board). Same transitive shape as the scope
  // rule above; refused before the body is read.
  { const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  let { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: "userIds array required" });
  if (userIds.some(x => typeof x !== "string")) return res.status(400).json({ error: "userIds must be an array of strings" });
  userIds = Array.from(new Set(userIds));
  if (userIds.length > BULK_ADMIN_MAX) return res.status(400).json({ error: `Cannot add more than ${BULK_ADMIN_MAX} members in a single request.` });
  if (_privilegedGroupTargets(req, userIds).length) return res.status(403).json({ error: PRIVILEGED_GROUP_TARGET_ERROR });
  // v8.7.0 — AND the targets must be participants this actor can already SEE.
  //
  // The operator's rule for this tab is explicit and is about both halves:
  // "limit the actions to participants and events they can see". Without this,
  // the three ways into group membership gave three different answers — the
  // per-participant chip route refused an out-of-scope target, this bulk route
  // accepted one, and the picker did not offer them — which is the shape a
  // reader "simplifies" by deleting whichever check looks redundant.
  //
  // It is deliberately NOT the same call the competition-assign route declined
  // to make: there the actor is enrolling somebody into their OWN event, which
  // is that role's main job. Here they are editing a reusable cohort object.
  const _mt = memberTargetsDenied(req, userIds);
  if (_mt) return _deny403(res, _mt);
  // v7.11.1 (req 7 back-door) — block if adding any of these members to this group
  // would leave them in ≥2 groups bound to the same competition. Checked BEFORE any
  // write so the add is atomic.
  const _mc = detectMemberAddClashes(req.params.id, userIds);
  if (_mc.length) return _memberClashResponse(res, req.params.id, group.name, _mc);
  const adminId = getAdminIdentity(req);
  const addedAt = now().toISOString();
  const insMember = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)");
  let added = 0;
  const rctx = reqContext(req);   // once per request; the loop can run BULK_ADMIN_MAX times
  // runTxnWithMirrorBuffer (ext-audit batch 3): the recordUserEvent("group_added")
  // emit fires inside the loop, followed by further INSERTs for the remaining
  // userIds, so a rollback past an emit would strand ghost app.jsonl lines. The
  // auditor reproduced exactly this (member-add rollback → 0 memberships but a
  // permanent group_added JSONL event).
  runTxnWithMirrorBuffer(db.transaction(() => {
    for (const uid of userIds) {
      if (!db.prepare("SELECT id FROM users WHERE id=?").get(uid)) continue;
      if (insMember.run(req.params.id, uid, addedAt, adminId).changes > 0) {
        added++;
        recordUserEvent(uid, "group_added", adminId, { group_id: req.params.id, name: group.name, ...rctx });
      }
    }
  }));
  invalidateAdminParticipantsCache();
  if (added > 0) await reconcileGroupBoundCompetitions(req.params.id, { actor: adminId });
  res.json({ ok: true, added });
});

app.delete("/api/admin/groups/:id/members/:userId", requireAdmin, csrfProtection, async (req, res) => {
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  // v8.7.0 — a removal reconciles every bound competition, so it is the same
  // transitive write as an add; the privileged-target guard below is orthogonal
  // and unchanged.
  const _gd = groupWriteDenied(req, req.params.id);
  if (_gd) return _deny403(res, _gd);
  // v8.12.0 — a removal reconciles the bound events too (a group-only member
  // leaves them), so the competitor lock's transitive door applies here as well.
  { const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  if (_privilegedGroupTargets(req, [req.params.userId]).length) return res.status(403).json({ error: PRIVILEGED_GROUP_TARGET_ERROR });
  const adminId = getAdminIdentity(req);
  const r = db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(req.params.id, req.params.userId);
  if (r.changes > 0) {
    recordUserEvent(req.params.userId, "group_removed", adminId, { group_id: req.params.id, name: group.name, ...reqContext(req) });
    // v6.20.x — clear manual-removal tombstones so a later re-add via the group
    // re-enrolls this user (only where no other bound group still wants them).
    _clearTombstonesForGroupLeave(req.params.id, req.params.userId);
    invalidateAdminParticipantsCache();
    await reconcileGroupBoundCompetitions(req.params.id, { actor: adminId });
  }
  res.json({ ok: true });
});

// v6.20.6 — server-paginated candidate picker for the "add members to group"
// dialog. Mirrors /api/admin/participants/picker: members are always
// returned in full; the candidate pool (non-members) is server-side
// search/page'd. Pre-fix the dialog loaded
// /api/admin/participants?limit=5000 and filtered client-side — past
// 5 000 users, anyone after the cap was invisible to search.
app.get("/api/admin/groups/:id/picker", requireAdmin, rateLimit(60_000, 120, "admin-group-picker"), (req, res) => {
  const groupId = req.params.id;
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const _gd = groupViewDenied(req, groupId);
  if (_gd) return _deny403(res, _gd);
  // v8.7.0 — the CANDIDATE pool is narrowed to participants of this actor's
  // events; the MEMBER list below deliberately is not. A member the actor cannot
  // otherwise see is still a fact about this group, and hiding them would make
  // the dialog misreport who is in it (and silently disagree with the clash
  // guard, which counts every membership).
  const _scope = scopedCompetitionIds(req);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(limit, 500);
  // v8.13.3 — clamped ABOVE as well as below (lib/util clampPagingIndex). The old
  // `Number.isFinite` guard let a value past int64 (1e20 WRITTEN OUT — `?offset=1e20`
  // itself reads as 1, parseInt stopping at the "e") through to the OFFSET bind (SQLITE_MISMATCH →
  // a generic 500) and turned a ~309-digit Infinity into page ONE; both now land on
  // the empty past-the-end page, as any over-range offset already did.
  const offset = clampPagingIndex(req.query.offset);
  const members = db.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.nickname, u.email
     FROM group_members gm JOIN users u ON u.id=gm.user_id
     WHERE gm.group_id=? ORDER BY u.nickname COLLATE NOCASE`
  ).all(groupId);
  const _searchEsc = search ? `%${search.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` : null;
  // Candidate filter: any user NOT already a member. Match name/email/tag
  // — keeping the "search by tag" capability the in-browser filter had.
  const buildFilter = (asCount) => {
    const base = asCount ? "SELECT COUNT(*) AS c" : "SELECT u.id, u.first_name, u.last_name, u.nickname, u.email";
    let where = `FROM users u WHERE NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id=u.id AND gm.group_id=?)`;
    const params = [groupId];
    // v8.7.0 — spliced into BOTH the count and the rows query (buildFilter serves
    // both), or `candidatesTotal` would advertise participants the page can never
    // reach. The empty-scope arm is `1=0`, never an omitted clause — an omitted
    // SQLite syntax error, so the naive shape would leave the one actor who must
    // see nobody with an unfiltered pool.
    if (_scope !== null) {
      if (_scope.length === 0) {
        where += " AND 1=0";
      } else {
        where += ` AND EXISTS (SELECT 1 FROM competition_users cu
                                WHERE cu.user_id=u.id AND cu.competition_id IN (SELECT value FROM json_each(?)))`;
        params.push(JSON.stringify(_scope));   // one bind: constant statement text
      }
    }
    if (_searchEsc) {
      where += ` AND (
        LOWER(u.first_name) LIKE ? ESCAPE '\\' OR LOWER(u.last_name) LIKE ? ESCAPE '\\'
        OR LOWER(u.nickname) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(u.secondary_email,'')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(u.company,'')) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM user_tags ut WHERE ut.user_id=u.id AND LOWER(ut.tag) LIKE ? ESCAPE '\\'))`;
      params.push(_searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc, _searchEsc);
    }
    return { sql: `${base} ${where}`, params };
  };
  const countQ = buildFilter(true);
  const candidatesTotal = db.prepare(countQ.sql).get(...countQ.params).c;
  const rowsQ = buildFilter(false);
  const candidates = db.prepare(`${rowsQ.sql} ORDER BY u.nickname COLLATE NOCASE LIMIT ? OFFSET ?`).all(...rowsQ.params, limit, offset);
  // Attach tags (search-by-tag relies on this for display too)
  const candIds = candidates.map(c => c.id);
  const tagMap = {};
  if (candIds.length) {
    for (const t of db.prepare("SELECT user_id, tag FROM user_tags WHERE user_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(candIds))) {
      (tagMap[t.user_id] = tagMap[t.user_id] || []).push(t.tag);
    }
  }
  res.json({
    id: group.id,
    name: group.name,
    members,
    candidates: candidates.map(c => ({ ...c, tags: tagMap[c.id] || [] })),
    candidatesTotal,
    candidatesOffset: offset,
    candidatesLimit: limit,
    searchApplied: !!search,
  });
});

// v6.20.6 — list every non-ended competition with a flag saying whether
// this group is currently bound to it. v8.12.6 — plus every ended event still
// taking LATE ENTRIES (the one admission predicate), because binding a group
// there enrols its members as late entrants and the dialog is where that is done. Replaces the N+1 client-side fan-out
// that opened the binding modal (one /competitions request + one
// /competitions/:id/groups request per competition). On a WAN-served
// admin with many active competitions, that was the dominant latency.
app.get("/api/admin/groups/:id/competitions", requireAdmin, (req, res) => {
  if (!db.prepare("SELECT id FROM groups WHERE id=?").get(req.params.id))
    return res.status(404).json({ error: "Group not found" });
  const _gd = groupViewDenied(req, req.params.id);
  if (_gd) return _deny403(res, _gd);
  const bound = new Set(db.prepare("SELECT competition_id FROM competition_groups WHERE group_id=?").all(req.params.id).map(r => r.competition_id));
  // v8.7.0 — this payload IS the bind dialog's card list (that is the v6.20.6
  // point of the endpoint), so narrowing it here is what stops an event admin
  // being offered somebody else's event to bind to. `scopeFilterSql` carries the
  // `1=0` empty-scope branch, so a grantless actor is offered nothing.
  const _cs = scopeFilterSql(req, "id");
  const comps = db.prepare(`SELECT * FROM competitions WHERE 1=1${_cs.clause}`).all(..._cs.params);
  // v7.1.4 (audit #4) — batch-load every timeslot once and group by competition,
  // then pass the slots to competitionStatus(). Previously this called
  // competitionStatus(c) TWICE per competition, each of which queried timeslots
  // — an N+1 (2N) in the very endpoint added to KILL the binding-dialog N+1.
  const slotsByComp = new Map();
  for (const s of db.prepare("SELECT * FROM competition_timeslots ORDER BY start_time").all()) {
    let arr = slotsByComp.get(s.competition_id);
    if (!arr) { arr = []; slotsByComp.set(s.competition_id, arr); }
    arr.push(s);
  }
  const out = [];
  // ONE clock for the whole page, so two cards of one response cannot land on
  // opposite sides of a late-entry deadline.
  const nowMs = Date.now();
  for (const c of comps) {
    const _slots = slotsByComp.get(c.id) || [];
    const status = competitionStatus(c, _slots);
    // v8.12.6 — `competitionAdmission` rather than `status === "ended"`: an ended
    // event with its late-entry window open is still bindable (its bind admits late
    // entrants and nothing else); one past its window is frozen, as before.
    const _adm = competitionAdmission(c, { slots: _slots, nowMs });
    if (!_adm) continue; // ended and not taking late entries — frozen, can't bind/unbind
    const _lateOpen = _adm === "late";
    out.push({
      id: c.id,
      name: c.name,
      status,
      start_time: c.start_time,
      duration_minutes: c.duration_minutes,
      bound: bound.has(c.id),
      // v8.1.0 (PR 12) — the NINTH attach point, and it is a server projection
      // rather than a competition row the client already holds: the group-bind
      // dialog builds its cards from THIS payload and nothing else (that is the
      // v6.20.6 point of the endpoint — it replaced an N+1 fan-out). Without the
      // kind here the dialog is the one admin surface that cannot label what it is
      // binding a group to.
      event_kind: c.event_kind,
      policy: eventPolicyForWire(c),
      // v8.12.0 — binding or unbinding reaches the competitor lock (the bind
      // through the assign route, the unbind through its own door), so the
      // dialog withholds an event the actor competes in — with the reason.
      competing: competitorIn(db, competitorIds(req), c.id),
      // v8.12.6 — the server's own answer, so the dialog can label the card and
      // say what binding does now; the client never re-derives the window.
      late_entry_window_open: _lateOpen,
      ...(_lateOpen ? { late_entry_deadline_effective: (() => { const d = lateEntryDeadline(c, competitionEffectiveEnd(c, _slots)); return d ? d.toISOString() : null; })() } : {}),
    });
  }
  out.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  res.json({ competitions: out });
});

// List the members of one group (for the manage-members UI).
app.get("/api/admin/groups/:id/members", requireAdmin, (req, res) => {
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const _gd = groupViewDenied(req, req.params.id);
  if (_gd) return _deny403(res, _gd);
  // v8.7.0 — the member list is NOT narrowed to scope; see the picker above for
  // why a group must report its whole membership once the group itself is visible.
  const members = db.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.nickname, u.email
     FROM group_members gm JOIN users u ON u.id=gm.user_id
     WHERE gm.group_id=? ORDER BY u.nickname COLLATE NOCASE`
  ).all(req.params.id);
  res.json({ id: group.id, name: group.name, members });
});

// Per-participant convenience wrappers (drive the Participants-table "+ group"
// chip). Add accepts an existing groupId OR a newName to create on the fly.
app.post("/api/admin/participants/:id/groups", requireAdmin, csrfProtection, async (req, res) => {
  const _tgtUser = db.prepare("SELECT id, role FROM users WHERE id=?").get(req.params.id);
  if (!_tgtUser) return res.status(404).json({ error: "User not found" });
  // v6.20.x — a regular admin may not group a privileged colleague. Groups are
  // live-synced to competitions, so peer tampering could enroll/remove an admin
  // from competitions via a bound group; gate it like the other admin routes.
  if (_privilegedTarget(req, _tgtUser.role)) {
    return res.status(403).json({ error: "Only a superadmin can modify group membership on an admin or superadmin account." });
  }
  // v8.7.0 — the PARTICIPANT is checked first, before the `newName` branch below
  // can create a group: a refused request must leave nothing behind, and a group
  // created for a participant the actor may not touch would be exactly that.
  const _pd = participantDenied(req, req.params.id);
  if (_pd) return _deny403(res, _pd);
  let { groupId, newName } = req.body || {};
  // v8.13.3 — both fields are TEXT, and a body that says otherwise is a malformed
  // request, not a lookup. better-sqlite3 FLATTENS a one-element array, so
  // `{groupId:[gid]}` was accepted and wrote `group_id` into the audit trail as an
  // ARRAY, while `[]`, `[g,g]`, `{}` and `true` threw at the bind (a generic 500).
  // After participantDenied, so a refused actor learns nothing about the payload's
  // shape; before the `newName` branch, so a refusal leaves no group behind.
  { const _ns = _firstNonStringField(req.body, ["groupId", "newName"]); if (_ns) return res.status(400).json({ error: `${_ns} must be text` }); }
  const adminId = getAdminIdentity(req);
  const ts = now().toISOString();
  if (!groupId && newName) {
    if (!_groupNameOk(newName)) return res.status(400).json({ error: `Group name must be ${GROUP_NAME_MAX} characters or fewer.` });
    const trimmed = newName.trim();
    const existing = findGroupByName(trimmed);
    if (existing) groupId = existing.id;
    else {
      groupId = uuid();
      // v8.7.0 — the SECOND create site in this file (the chip's create-on-the-fly).
      // It must stamp ownership too, or a group made from this dialog would be
      // deletable by nobody but a global admin. See the create route for why the
      // column is an id rather than the email beside it.
      try { db.prepare("INSERT INTO groups (id, name, name_key, created_at, created_by, created_by_id) VALUES (?,?,?,?,?,?)").run(groupId, trimmed, _groupNameKey(trimmed), ts, adminId, actorId(req)); }
      catch (e) { if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "A group with this name already exists." }); throw e; }
      recordOrphanedAuditEvent("group", groupId, "group_created", adminId, { name: trimmed, members: 0, ...reqContext(req) });
    }
  }
  if (!groupId) return res.status(400).json({ error: "groupId or newName required" });
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(groupId);
  if (!group) return res.status(404).json({ error: "Group not found" });
  // v8.7.0 — the GROUP side. A group just created from `newName` is owned by this
  // actor and bound to nothing, so this can only refuse the pick-an-existing-group
  // path — which is the one that can reach an event the actor does not manage.
  const _gd = groupWriteDenied(req, groupId);
  if (_gd) return _deny403(res, _gd);
  // v8.12.0 — the competitor lock's transitive door (see POST /groups/:id/members).
  { const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), groupId)); if (_cmp) return _cmp; }
  // v7.11.1 (req 7 back-door) — block if adding this participant to this group would
  // put them in ≥2 groups bound to the same competition. (A freshly-created group
  // from `newName` is bound nowhere, so this never blocks the create+add path.)
  const _mc = detectMemberAddClashes(groupId, [req.params.id]);
  if (_mc.length) return _memberClashResponse(res, groupId, group.name, _mc);
  if (db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)").run(groupId, req.params.id, ts, adminId).changes > 0) {
    recordUserEvent(req.params.id, "group_added", adminId, { group_id: groupId, name: group.name, ...reqContext(req) });
    invalidateAdminParticipantsCache();
    await reconcileGroupBoundCompetitions(groupId, { actor: adminId });
  }
  const groups = db.prepare("SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=? ORDER BY g.name COLLATE NOCASE").all(req.params.id);
  res.json({ ok: true, groups });
});

app.delete("/api/admin/participants/:id/groups/:groupId", requireAdmin, csrfProtection, async (req, res) => {
  const _tgtUser = db.prepare("SELECT role FROM users WHERE id=?").get(req.params.id);
  // v6.20.x — parity with the POST-groups guard: regular admins can't modify
  // group membership on a privileged colleague.
  if (_tgtUser && _privilegedTarget(req, _tgtUser.role)) {
    return res.status(403).json({ error: "Only a superadmin can modify group membership on an admin or superadmin account." });
  }
  // v8.7.0 — both ends, before the DELETE and its reconcile. This route does not
  // 404 a missing group (it renders `group?.name`), so for an unscoped actor the
  // behaviour is byte-identical; for an event admin a missing group is refused by
  // groupWriteDenied's own "Group not found." rather than silently no-opping.
  const _pd = participantDenied(req, req.params.id);
  if (_pd) return _deny403(res, _pd);
  const _gd = groupWriteDenied(req, req.params.groupId);
  if (_gd) return _deny403(res, _gd);
  // v8.12.0 — the competitor lock's transitive door (see DELETE /groups/:id/members/:userId).
  { const _cmp = refuseCompetitor(res, competitorGroupDenied(db, competitorIds(req), req.params.groupId)); if (_cmp) return _cmp; }
  const group = db.prepare("SELECT id, name FROM groups WHERE id=?").get(req.params.groupId);
  const adminId = getAdminIdentity(req);
  if (db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(req.params.groupId, req.params.id).changes > 0) {
    recordUserEvent(req.params.id, "group_removed", adminId, { group_id: req.params.groupId, name: group?.name, ...reqContext(req) });
    // v6.20.x — clear tombstones so a later group re-add re-enrolls the user.
    _clearTombstonesForGroupLeave(req.params.groupId, req.params.id);
    invalidateAdminParticipantsCache();
    await reconcileGroupBoundCompetitions(req.params.groupId, { actor: adminId });
  }
  const groups = db.prepare("SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=? ORDER BY g.name COLLATE NOCASE").all(req.params.id);
  res.json({ ok: true, groups });
});
};
