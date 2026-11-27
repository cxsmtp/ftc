"use strict";

// USERS AND ROLES — the platform's admin accounts and the roles they hold.
//
// People (routes/participants.js) is about participants; this module is about
// the accounts that run the platform: every account whose role is not
// `participant`, the roles themselves, and creating an admin account. Changing
// an account's role is the shared handler in routes/participants.js
// (`PATCH /api/admin/users/:id/role`, beside the historical participant route).
//
// Every route is guarded by `requirePermission` (lib/middleware.js), so a
// custom role's live permission set decides. Role writes are audited as
// settings events keyed `role:<id>` with `reqContext`, and every committed
// role write clears the role caches (`invalidateRoleCaches`) after the commit,
// so a permission edit reaches every holder within the caches' 2 s.

const crypto = require("crypto");
const db = require("../db");
const { csrfProtection, destructiveAdminLimit, requireAdmin, requirePermission, adminAuthzDenied } = require("../lib/middleware");
const { recordSettingsEvent, recordUserEvent, reqContext, getAdminIdentity, runTxnWithMirrorBuffer } = require("../lib/audit");
const { normaliseEmail, isValidEmailFormat, isFreeEmail, NO_PASSWORD_HASH, profileTextControlField, profileTextControlBody } = require("../lib/util");
const { emailIsTaken } = require("../lib/email-identity");
const { invalidateAdminParticipantsCache } = require("../lib/participants-cache");
const { _invalidateUserTagsCache } = require("../lib/user-tags");
const rbac = require("../lib/rbac");
const { competitorIds } = require("../lib/event-admin");
const { rivalsOf } = require("../lib/staff-compete");

const ROLE_LABEL_MAX = 60;
const ROLE_DESCRIPTION_MAX = 300;
// Printable text only: a role label is rendered on menus and in History.
const _CONTROL_RE = /[\u0000-\u001f\u007f]/;

function _roleRow(r) {
  const def = rbac.roleDefinition(r.id, { live: true });
  return {
    id: r.id, label: r.label, description: r.description || "",
    builtin: !!r.builtin, scope_mode: r.scope_mode, rank: r.rank, version: r.version,
    permissions: def ? [...def.perms].sort() : [],
    user_count: r.user_count || 0,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

function _readRoles() {
  return db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = r.id) AS user_count
                       FROM roles r ORDER BY r.builtin DESC, r.rank, lower(r.label)`).all().map(_roleRow);
}

/**
 * Validate a role's permission list for THIS actor. Returns `{perms}` or
 * `{status, code, error}`. Unknown or non-grantable permissions are refused by
 * name (never ignored); a platform-wide one (lib/rbac.js) needs an unscoped
 * role, since a role scoped to its events is bound exactly as an event admin; a
 * superadmin-only one needs a superadmin; none may lie outside the actor's own
 * set. `panel.access` is implicit for every admin role.
 */
function _validatePermissions(req, list, scope) {
  if (!Array.isArray(list) || list.some(p => typeof p !== "string")) {
    return { status: 400, code: "role_permissions_invalid", error: "permissions must be a list of permission names." };
  }
  const uniq = [...new Set(list)];
  const unknown = uniq.filter(p => !rbac.PERMISSION_IDS.has(p));
  if (unknown.length) return { status: 400, code: "role_permission_unknown", error: `Unknown permission: ${unknown[0]}.`, permission: unknown[0] };
  const ungrantable = uniq.filter(p => !rbac.PERMISSIONS.find(x => x.id === p).grantable);
  if (ungrantable.length) return { status: 400, code: "role_permission_not_grantable", error: `That permission belongs to the built-in roles only: ${ungrantable[0]}.`, permission: ungrantable[0] };
  const platformWide = scope === "all" ? [] : uniq.filter(rbac.isPlatformWidePermission);
  if (platformWide.length) {
    return { status: 400, code: "role_permission_needs_every_event", permission: platformWide[0],
      error: `A role that acts only on its own events cannot hold "${rbac.PERMISSIONS.find(x => x.id === platformWide[0]).label}": what it does reaches beyond any one event.` };
  }
  const actor = rbac.actorPermissions(req);
  const actorIsSuper = actor.builtinAccount || actor.role === "superadmin";
  const superOnly = uniq.filter(rbac.isSuperOnlyPermission);
  if (superOnly.length && !actorIsSuper) {
    return { status: 403, code: "role_escalation", error: "Only a superadmin can give a role superadmin-only permissions.", permission: superOnly[0] };
  }
  const outside = uniq.filter(p => !actor.perms.has(p));
  if (outside.length) return { status: 403, code: "role_escalation", error: "A role cannot be given a permission your own role does not hold.", permission: outside[0] };
  if (!uniq.includes("panel.access")) uniq.push("panel.access");
  return { perms: uniq.sort() };
}

function _validateLabel(label, { excludeId = null } = {}) {
  if (typeof label !== "string") return { status: 400, code: "role_label_required", error: "A role needs a name." };
  const t = label.trim();
  if (!t) return { status: 400, code: "role_label_required", error: "A role needs a name." };
  if (t.length > ROLE_LABEL_MAX || _CONTROL_RE.test(t)) return { status: 400, code: "role_label_invalid", error: `A role name is up to ${ROLE_LABEL_MAX} printable characters.` };
  const clash = db.prepare("SELECT id FROM roles WHERE lower(label) = lower(?) AND id IS NOT ?").get(t, excludeId);
  if (clash) return { status: 409, code: "role_label_taken", error: "Another role already has that name." };
  return { label: t };
}

function _validateDescription(d) {
  if (d === undefined || d === null) return { description: "" };
  if (typeof d !== "string" || d.length > ROLE_DESCRIPTION_MAX || _CONTROL_RE.test(d.replace(/\n/g, ""))) {
    return { status: 400, code: "role_description_invalid", error: `A role description is up to ${ROLE_DESCRIPTION_MAX} characters.` };
  }
  return { description: d.trim() };
}

const _send = (res, e) => res.status(e.status).json({ error: e.error, code: e.code, ...(e.permission ? { permission: e.permission } : {}) });

function _suggestNickname(email) {
  const base = (email.split("@")[0] || "admin").replace(/[^a-z0-9_]/gi, "").slice(0, 24).toLowerCase() || "admin";
  let candidate = base.length >= 3 ? base : `${base}adm`;
  for (let i = 0; i < 50; i++) {
    if (!db.prepare("SELECT 1 FROM users WHERE nickname=? COLLATE NOCASE").get(candidate)) return candidate;
    candidate = `${base}${crypto.randomInt(10000)}`;
  }
  return `${base}${Date.now().toString(36)}`;
}

module.exports = function register(app) {
  // ── the platform's admin accounts ──────────────────────────────────────────
  app.get("/api/admin/users", requireAdmin, requirePermission("users.view"), (req, res) => {
    const rows = db.prepare(`SELECT u.id, u.email, u.first_name, u.last_name, u.nickname, u.role, u.blocked, u.denied_at,
                                    u.verified, u.approved, u.last_login_time, u.created_at,
                                    r.label AS role_label, r.scope_mode AS scope_mode, r.builtin AS role_builtin, r.rank AS role_rank
                               FROM users u LEFT JOIN roles r ON r.id = u.role
                              WHERE COALESCE(u.role, 'participant') <> 'participant'
                              ORDER BY COALESCE(r.rank, 99) DESC, lower(u.email)`).all();
    const grants = new Map();
    if (rows.length) {
      for (const g of db.prepare(`SELECT ca.user_id, ca.competition_id, c.name FROM competition_admins ca
                                    JOIN competitions c ON c.id = ca.competition_id
                                   WHERE ca.user_id IN (SELECT value FROM json_each(?)) ORDER BY lower(c.name)`)
        .all(JSON.stringify(rows.map(r => r.id)))) {
        if (!grants.has(g.user_id)) grants.set(g.user_id, []);
        grants.get(g.user_id).push({ competition_id: g.competition_id, name: g.name });
      }
    }
    // A RIVAL (an account sharing a staff-compete event with the actor, seat or
    // hand) is marked, because the role change is a rival door the shared
    // handler refuses `competitor_cannot_edit`: the screen withholds Change role
    // with that reason rather than offer a refusal (lib/staff-compete.js).
    const rivals = rivalsOf(db, competitorIds(req), rows.map(r => r.id));
    res.json({
      users: rows.map(r => ({
        id: r.id, email: r.email, first_name: r.first_name, last_name: r.last_name, nickname: r.nickname,
        role: r.role, role_label: r.role_label || null,
        // A role key with no definition is shown, and fails closed everywhere.
        scope_mode: r.scope_mode || "none", role_builtin: !!r.role_builtin,
        status: r.blocked ? "blocked" : r.denied_at ? "denied" : !r.approved ? "pending" : "active",
        last_login_time: r.last_login_time || null, created_at: r.created_at,
        grants: grants.get(r.id) || [],
        rival_in: rivals.get(r.id) || null,
      })),
    });
  });

  // Add a platform user: a NEW account created with its role. An address an
  // account already holds is answered 409 `user_exists` with its id, and the
  // client changes that account's role instead (the shared role route).
  app.post("/api/admin/users", requireAdmin, requirePermission("users.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const b = req.body || {};
    for (const f of ["email", "role", "first_name", "last_name"]) {
      if (b[f] !== undefined && b[f] !== null && typeof b[f] !== "string") {
        return res.status(400).json({ error: `${f} must be text.`, code: "body_field_invalid" });
      }
    }
    {
      const ctl = profileTextControlField({ first_name: b.first_name, last_name: b.last_name });
      if (ctl) return res.status(400).json(profileTextControlBody(ctl));
    }
    const email = normaliseEmail(b.email || "");
    if (!email || !isValidEmailFormat(email)) return res.status(400).json({ error: "Enter a valid email address.", code: "email_invalid" });
    const role = typeof b.role === "string" ? b.role : "";
    if (!role || role === "participant") return res.status(400).json({ error: "Choose an admin role for the new user.", code: "role_required" });
    const first = (b.first_name || "").trim().slice(0, 80);
    const last = (b.last_name || "").trim().slice(0, 80);
    const esc = rbac.roleAssignDenied(req, "participant", role);
    if (esc) return _send(res, esc);
    const adminId = getAdminIdentity(req);
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    let exists = null;
    const txn = db.transaction(() => {
      // Re-asked at commit: the actor may have lost `users.manage` meanwhile.
      const denied = adminAuthzDenied(req, { perm: "users.manage" });
      if (denied) { const e = new Error("authz"); e.denied = denied; throw e; }
      // The PRIMARY address names an account; a SECONDARY is an unconfirmed claim
      // anyone can make about an address no account holds, so a match there is
      // refused outright — never offered as "give that account the role", which
      // would hand an admin role to whoever squatted the address.
      const taken = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
      if (taken) { exists = taken.id; throw new Error("exists"); }
      if (db.prepare("SELECT 1 FROM users WHERE secondary_email = ? COLLATE NOCASE").get(email)) throw new Error("secondary");
      if (emailIsTaken(email)) throw new Error("exists");
      db.prepare(`INSERT INTO users (id, first_name, last_name, nickname, email, password_hash,
          verified, first_verified_at, approved, approved_at, approved_by, role, registered_via, created_at)
        VALUES (?,?,?,?,?,?,1,?,1,?,?,?,'manual',?)`)
        .run(id, first, last, _suggestNickname(email), email, NO_PASSWORD_HASH, at, at, adminId, role, at);
      if (rbac.isGlobalClassRole(role, { live: true })) {
        db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?, 'staff')").run(id);
        recordUserEvent(id, "tag_added", adminId, { tag: "staff", via: "role_change", ...reqContext(req) });
      }
      // A platform user may sign in with a personal address (a contractor's, say):
      // the corporate-email rule is not asked here (operator ruling, 24 Nov 2026),
      // and, like its other bypasses, the record says when it was passed over.
      recordUserEvent(id, "user_added", adminId, { via: "users_and_roles", email, ...(isFreeEmail(email) ? { bypassed_free_email_rule: true } : {}), ...reqContext(req) });
      // A custom role's label at the time rides the record (History shows it; the id means nothing once the role is deleted).
      const _toLabel = rbac.isBuiltinRole(role) ? null : ((rbac.roleDefinition(role, { live: true }) || {}).label || null);
      recordUserEvent(id, "role_changed", adminId, { from: "participant", to: role, ...(_toLabel ? { to_label: _toLabel } : {}), via: "users_and_roles", ...reqContext(req) });
    });
    try { runTxnWithMirrorBuffer(() => txn.immediate()); }
    catch (e) {
      if (e.denied) return res.status(e.denied.status).json({ error: e.denied.error, code: e.denied.code });
      if (e.message === "exists") return res.status(409).json({ error: "An account already uses that address. Change its role instead.", code: "user_exists", id: exists });
      if (e.message === "secondary") return res.status(409).json({ error: "That address is another account's secondary email, so it cannot be given a role. Use the person's own sign-in (primary) address.", code: "email_is_secondary" });
      throw e;
    }
    _invalidateUserTagsCache(id);
    invalidateAdminParticipantsCache();
    res.json({ ok: true, id, role });
  });

  // ── roles ─────────────────────────────────────────────────────────────────
  app.get("/api/admin/roles", requireAdmin, requirePermission("users.view"), (req, res) => {
    res.json({
      // What THIS session may do with each role, by the escalation rule the role
      // change itself applies (`roleAssignDenied`): give it to an account
      // (`can_give`), or move an account off it (`can_take`). The dialogs offer
      // from these, so the offer and the refusal are one predicate.
      roles: _readRoles().map(r => ({ ...r,
        can_give: !rbac.roleAssignDenied(req, "participant", r.id),
        can_take: !rbac.roleAssignDenied(req, r.id, "participant") })),
      sections: rbac.SECTIONS,
      permissions: rbac.PERMISSIONS.map(p => ({ id: p.id, section: p.section, label: p.label, grantable: p.grantable, superadmin_only: rbac.isSuperOnlyPermission(p.id), every_event_only: rbac.isPlatformWidePermission(p.id) })),
    });
  });

  app.post("/api/admin/roles", requireAdmin, requirePermission("roles.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const b = req.body || {};
    const lab = _validateLabel(b.label); if (lab.status) return _send(res, lab);
    const desc = _validateDescription(b.description); if (desc.status) return _send(res, desc);
    const scope = b.scope_mode;
    if (scope !== "granted" && scope !== "all") {
      return res.status(400).json({ error: 'scope_mode must be "granted" (only the events they are made an organiser of) or "all".', code: "role_scope_invalid" });
    }
    const perms = _validatePermissions(req, b.permissions === undefined ? [] : b.permissions, scope); if (perms.status) return _send(res, perms);
    const id = "role_" + crypto.randomBytes(6).toString("hex");
    const at = new Date().toISOString();
    const adminId = getAdminIdentity(req);
    const actor = req.session.userId || null;
    const txn = db.transaction(() => {
      db.prepare(`INSERT INTO roles (id, label, description, builtin, scope_mode, rank, created_by_id, created_at, updated_at, version)
                  VALUES (?,?,?,0,?,?,?,?,?,1)`).run(id, lab.label, desc.description, scope, scope === "all" ? 2 : 1, actor, at, at);
      const ins = db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)");
      for (const p of perms.perms) ins.run(id, p);
      recordSettingsEvent(`role:${id}`, "role_created", adminId, { label: lab.label, scope_mode: scope, permissions: perms.perms, ...reqContext(req) });
    });
    try { runTxnWithMirrorBuffer(() => txn()); }
    catch (e) {
      if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ error: "Another role already has that name.", code: "role_label_taken" });
      throw e;
    }
    rbac.invalidateRoleCaches();
    res.json({ ok: true, role: _readRoles().find(r => r.id === id) });
  });

  app.put("/api/admin/roles/:id", requireAdmin, requirePermission("roles.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const row = db.prepare("SELECT * FROM roles WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Role not found.", code: "role_not_found" });
    if (row.builtin) return res.status(409).json({ error: "A built-in role cannot be changed. Create a custom role instead.", code: "role_builtin" });
    const b = req.body || {};
    if (!Number.isInteger(b.expectedVersion)) {
      return res.status(400).json({ error: "expectedVersion is required (the version you edited).", code: "role_version_required" });
    }
    const lab = b.label === undefined ? { label: row.label } : _validateLabel(b.label, { excludeId: row.id }); if (lab.status) return _send(res, lab);
    const desc = b.description === undefined ? { description: row.description || "" } : _validateDescription(b.description); if (desc.status) return _send(res, desc);
    if (b.scope_mode !== undefined && b.scope_mode !== row.scope_mode) {
      // Changing a role's scope would re-scope every holder at once — a
      // widening from `granted` to `all` most of all. Refused; make a new role.
      return res.status(409).json({ error: "A role's scope cannot be changed once it exists. Create a new role and move people to it.", code: "role_scope_locked" });
    }
    const before = [...rbac.roleDefinition(row.id, { live: true }).perms].sort();
    let perms = { perms: before };
    if (b.permissions !== undefined) { perms = _validatePermissions(req, b.permissions, row.scope_mode); if (perms.status) return _send(res, perms); }
    // Editing a role changes what its holders may do: the actor may not take
    // away a permission they do not hold either.
    const actor = rbac.actorPermissions(req);
    const removedOutside = before.filter(p => !perms.perms.includes(p) && !actor.perms.has(p));
    if (removedOutside.length) return res.status(403).json({ error: "You cannot remove a permission your own role does not hold.", code: "role_escalation", permission: removedOutside[0] });
    const added = perms.perms.filter(p => !before.includes(p));
    const removed = before.filter(p => !perms.perms.includes(p));
    const at = new Date().toISOString();
    const adminId = getAdminIdentity(req);
    let stale = false;
    const txn = db.transaction(() => {
      const upd = db.prepare("UPDATE roles SET label=?, description=?, updated_at=?, version=version+1 WHERE id=? AND version=? AND builtin=0")
        .run(lab.label, desc.description, at, row.id, b.expectedVersion);
      if (upd.changes === 0) { stale = true; throw new Error("stale"); }
      db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(row.id);
      const ins = db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)");
      for (const p of perms.perms) ins.run(row.id, p);
      const changes = {};
      if (lab.label !== row.label) changes.label = { from: row.label, to: lab.label };
      if (desc.description !== (row.description || "")) changes.description = { from: row.description || "", to: desc.description };
      if (added.length) changes.permissions_added = added;
      if (removed.length) changes.permissions_removed = removed;
      recordSettingsEvent(`role:${row.id}`, "role_updated", adminId, { label: lab.label, ...changes, ...reqContext(req) });
    });
    try { runTxnWithMirrorBuffer(() => txn()); }
    catch (e) {
      if (stale) return res.status(409).json({ error: "Somebody changed this role while you were editing it. Reload it and try again.", code: "role_version_stale" });
      if (/UNIQUE/.test(String(e.message))) return res.status(409).json({ error: "Another role already has that name.", code: "role_label_taken" });
      throw e;
    }
    rbac.invalidateRoleCaches();
    invalidateAdminParticipantsCache();
    res.json({ ok: true, role: _readRoles().find(r => r.id === row.id) });
  });

  app.delete("/api/admin/roles/:id", requireAdmin, requirePermission("roles.manage"), destructiveAdminLimit, csrfProtection, (req, res) => {
    const row = db.prepare("SELECT * FROM roles WHERE id=?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Role not found.", code: "role_not_found" });
    if (row.builtin) return res.status(409).json({ error: "A built-in role cannot be deleted.", code: "role_builtin" });
    const adminId = getAdminIdentity(req);
    let inUse = 0;
    const txn = db.transaction(() => {
      inUse = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role=?").get(row.id).n;
      if (inUse) throw new Error("in_use");
      const perms = db.prepare("SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission").all(row.id).map(r => r.permission);
      db.prepare("DELETE FROM roles WHERE id=? AND builtin=0").run(row.id);
      recordSettingsEvent(`role:${row.id}`, "role_deleted", adminId, { label: row.label, scope_mode: row.scope_mode, permissions: perms, ...reqContext(req) });
    });
    try { runTxnWithMirrorBuffer(() => txn.immediate()); }
    catch (e) {
      if (e.message === "in_use") {
        return res.status(409).json({ error: `${inUse} ${inUse === 1 ? "account holds" : "accounts hold"} this role. Give them another role first.`, code: "role_in_use", user_count: inUse });
      }
      throw e;
    }
    rbac.invalidateRoleCaches();
    res.json({ ok: true });
  });
};
