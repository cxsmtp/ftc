"use strict";

// THE STAFF-TEAMS DIRECTORY (Settings → People → Staff teams; data:
// lib/staff-teams.js).
//
//   GET    /api/admin/staff-teams                          teams.view: every team and its members
//   GET    /api/admin/staff-teams/:id                      teams.view: one team
//   POST   /api/admin/staff-teams                          teams.manage { name }
//   PUT    /api/admin/staff-teams/:id                      teams.manage { name, expectedUpdatedAt? } rename
//   DELETE /api/admin/staff-teams/:id                      teams.manage
//   POST   /api/admin/staff-teams/:id/members              teams.manage { name, email, default_role? }
//   PUT    /api/admin/staff-teams/:id/members/:memberId    teams.manage { name, email, default_role?, expectedUpdatedAt? }
//   DELETE /api/admin/staff-teams/:id/members/:memberId    teams.manage
//
// Both permissions are PLATFORM-WIDE (lib/rbac.js): a directory of people no
// event bounds, so a role scoped to its events can hold neither, and an event
// admin holds neither. Every route is guarded by `requirePermission`, which also
// refuses a session viewing as someone else. The directory is used from two
// event doors, each asking `teams.view` inline beside its own rules:
// routes/event-team.js (`POST …/team/staff-team`) and routes/competitions.js
// (`POST …/admins/staff-team`).
//
// Members are recipients, not accounts. Whether an address signs in as an
// account is read here (`has_account`) only for a reader who may see people
// (`participants.view`): it says whether an address has an account here.
//
// Every write is audited as an ORPHANED `staff_team` event (it names no event)
// with the request context, naming the team, member ids and the address's
// DOMAIN, never the address itself (the event team's rule: lib/event-team.js).

const db = require("../db");
const { requireAdmin, requirePermission, destructiveAdminLimit, csrfProtection } = require("../lib/middleware");
const { actorPermissions } = require("../lib/rbac");
const { getAdminIdentity, recordOrphanedAuditEvent, runTxnWithMirrorBuffer, reqContext } = require("../lib/audit");
const { ROLES, ROLE_LABELS } = require("../lib/event-team");
const { domainOf } = require("../lib/team-recipient");
const S = require("../lib/staff-teams");
const { now } = require("../lib/time");

function _teamWire(req, team, members) {
  const hasAccount = actorPermissions(req).perms.has("participants.view");
  return {
    id: team.id, name: team.name, updated_at: team.updated_at,
    member_count: members.length,
    members: members.map(m => S.memberWire(db, m, { hasAccount })),
  };
}

function _expectedOk(req, res, current, code, what) {
  const exp = req.body?.expectedUpdatedAt;
  if (exp === undefined || exp === null) return true;
  if (typeof exp !== "string") { res.status(400).json({ error: "expectedUpdatedAt must be the version the form was filled from.", code: "staff_team_version_invalid" }); return false; }
  if (exp !== current) { res.status(409).json({ error: `${what} was changed by someone else after you opened it. Reload to see their change.`, code }); return false; }
  return true;
}

function _team404(res) { return res.status(404).json({ error: "Staff team not found", code: "staff_team_not_found" }); }

module.exports = function register(app) {
  app.get("/api/admin/staff-teams", requireAdmin, requirePermission("teams.view"), (req, res) => {
    const by = S.membersByTeam(db);
    const perms = actorPermissions(req).perms;
    res.json({
      teams: S.listTeams(db).map(t => _teamWire(req, t, by.get(t.id) || [])),
      roles: ROLES.map(r => ({ id: r, label: ROLE_LABELS[r] })),
      can_manage: perms.has("teams.manage"),
      shows_accounts: perms.has("participants.view"),
      limits: { teams: S.MAX_TEAMS, members: S.MAX_MEMBERS, team_name: S.TEAM_NAME_MAX, member_name: S.MEMBER_NAME_MAX },
    });
  });

  app.get("/api/admin/staff-teams/:id", requireAdmin, requirePermission("teams.view"), (req, res) => {
    const team = S.getTeam(db, req.params.id);
    if (!team) return _team404(res);
    res.json({ team: _teamWire(req, team, S.listMembers(db, team.id)) });
  });

  app.post("/api/admin/staff-teams", requireAdmin, requirePermission("teams.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const v = S.validateTeamName(req.body?.name);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code, field: "name" });
    let out;
    const txn = db.transaction(() => {
      const clash = S.teamByName(db, v.name);
      if (clash) { out = { status: 409, body: { error: `A staff team called "${clash.name}" already exists.`, code: "staff_team_exists", id: clash.id } }; return; }
      if (db.prepare("SELECT COUNT(*) AS n FROM staff_teams").get().n >= S.MAX_TEAMS) {
        out = { status: 409, body: { error: `The directory holds at most ${S.MAX_TEAMS} staff teams. Delete one you no longer use first.`, code: "staff_team_too_many" } };
        return;
      }
      const team = S.insertTeam(db, v.name, getAdminIdentity(req));
      recordOrphanedAuditEvent("staff_team", team.id, "staff_team_created", getAdminIdentity(req), { name: team.name, ...reqContext(req) });
      out = { status: 201, body: { ok: true, team: _teamWire(req, team, []) } };
    });
    // IMMEDIATE: the name clash and the cap are read before the insert.
    runTxnWithMirrorBuffer(() => txn.immediate());
    res.status(out.status).json(out.body);
  });

  app.put("/api/admin/staff-teams/:id", requireAdmin, requirePermission("teams.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const team = S.getTeam(db, req.params.id);
    if (!team) return _team404(res);
    const v = S.validateTeamName(req.body?.name);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code, field: "name" });
    if (!_expectedOk(req, res, team.updated_at, "staff_team_changed", "This team")) return;
    if (v.name === team.name) return res.json({ ok: true, changed: false, team: _teamWire(req, team, S.listMembers(db, team.id)) });
    let out;
    const txn = db.transaction(() => {
      const clash = S.teamByName(db, v.name);
      if (clash && clash.id !== team.id) { out = { status: 409, body: { error: `A staff team called "${clash.name}" already exists.`, code: "staff_team_exists", id: clash.id } }; return; }
      db.prepare("UPDATE staff_teams SET name=?, updated_at=? WHERE id=?").run(v.name, now().toISOString(), team.id);
      recordOrphanedAuditEvent("staff_team", team.id, "staff_team_renamed", getAdminIdentity(req), { from: team.name, to: v.name, ...reqContext(req) });
      out = { status: 200, body: { ok: true, changed: true } };
    });
    runTxnWithMirrorBuffer(() => txn.immediate());
    if (out.status === 200) out.body.team = _teamWire(req, S.getTeam(db, team.id), S.listMembers(db, team.id));
    res.status(out.status).json(out.body);
  });

  app.delete("/api/admin/staff-teams/:id", requireAdmin, requirePermission("teams.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const team = S.getTeam(db, req.params.id);
    if (!team) return _team404(res);
    const members = S.listMembers(db, team.id);
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM staff_teams WHERE id=?").run(team.id);
      // The members go with it (ON DELETE CASCADE). Events the team was added to
      // keep what they took: an event's team and organisers are their own.
      recordOrphanedAuditEvent("staff_team", team.id, "staff_team_deleted", getAdminIdentity(req), {
        name: team.name, member_ids: members.map(m => m.id), ...reqContext(req),
      });
    });
    runTxnWithMirrorBuffer(() => txn());
    res.json({ ok: true, members_removed: members.length });
  });

  app.post("/api/admin/staff-teams/:id/members", requireAdmin, requirePermission("teams.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const team = S.getTeam(db, req.params.id);
    if (!team) return _team404(res);
    const v = S.validateMember(req.body);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code, field: v.field });
    let out;
    const txn = db.transaction(() => {
      out = S.insertMember(db, team.id, v, getAdminIdentity(req));
      if (out.member) {
        recordOrphanedAuditEvent("staff_team", team.id, "staff_team_member_added", getAdminIdentity(req), {
          team_name: team.name, member_id: out.member.id, name: v.name, domain: domainOf(v.email),
          ...(v.default_role ? { default_role: v.default_role } : {}), ...reqContext(req),
        });
      }
    });
    // IMMEDIATE: the cap and the repeat address are read before the insert.
    runTxnWithMirrorBuffer(() => txn.immediate());
    if (out.error) return res.status(409).json({ error: out.error, code: out.code });
    res.status(201).json({ ok: true, member: S.memberWire(db, out.member, { hasAccount: actorPermissions(req).perms.has("participants.view") }) });
  });

  app.put("/api/admin/staff-teams/:id/members/:memberId", requireAdmin, requirePermission("teams.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const team = S.getTeam(db, req.params.id);
    if (!team) return _team404(res);
    const m = S.getMember(db, team.id, req.params.memberId);
    if (!m) return res.status(404).json({ error: "Team member not found", code: "staff_member_not_found" });
    const v = S.validateMember(req.body);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code, field: v.field });
    if (!_expectedOk(req, res, m.updated_at, "staff_member_changed", "This member")) return;
    const changes = {};
    if (v.name !== m.name) changes.name = { from: m.name, to: v.name };
    // The address is named by its domain only, before and after.
    if (v.email !== m.email.toLowerCase()) changes.domain = { from: domainOf(m.email), to: domainOf(v.email), address_changed: true };
    if ((v.default_role || null) !== (m.default_role || null)) changes.default_role = { from: m.default_role || null, to: v.default_role || null };
    if (!Object.keys(changes).length) return res.json({ ok: true, changed: false, member: S.memberWire(db, m, { hasAccount: actorPermissions(req).perms.has("participants.view") }) });
    let refused = null;
    const txn = db.transaction(() => {
      if (changes.domain && db.prepare("SELECT 1 FROM staff_team_members WHERE team_id=? AND email=? AND id<>?").get(team.id, v.email, m.id)) {
        refused = { error: "That address is already in this team.", code: "staff_member_exists" };
        return;
      }
      db.prepare("UPDATE staff_team_members SET name=?, email=?, default_role=?, updated_at=? WHERE id=?").run(v.name, v.email, v.default_role, now().toISOString(), m.id);
      S.touchTeam(db, team.id);
      recordOrphanedAuditEvent("staff_team", team.id, "staff_team_member_updated", getAdminIdentity(req), {
        team_name: team.name, member_id: m.id, changes, ...reqContext(req),
      });
    });
    runTxnWithMirrorBuffer(() => txn.immediate());
    if (refused) return res.status(409).json(refused);
    res.json({ ok: true, changed: true, member: S.memberWire(db, S.getMember(db, team.id, m.id), { hasAccount: actorPermissions(req).perms.has("participants.view") }) });
  });

  app.delete("/api/admin/staff-teams/:id/members/:memberId", requireAdmin, requirePermission("teams.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const team = S.getTeam(db, req.params.id);
    if (!team) return _team404(res);
    const m = S.getMember(db, team.id, req.params.memberId);
    if (!m) return res.status(404).json({ error: "Team member not found", code: "staff_member_not_found" });
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM staff_team_members WHERE id=?").run(m.id);
      S.touchTeam(db, team.id);
      recordOrphanedAuditEvent("staff_team", team.id, "staff_team_member_removed", getAdminIdentity(req), {
        team_name: team.name, member_id: m.id, name: m.name, domain: domainOf(m.email), ...reqContext(req),
      });
    });
    runTxnWithMirrorBuffer(() => txn());
    res.json({ ok: true });
  });
};
