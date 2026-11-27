"use strict";

// THE PERMISSION CATALOGUE AND THE ROUTE GATE (role-based access control).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE
//
// `users.role` is the role KEY. The four built-in roles keep their stored
// strings (`participant`, `event_admin`, `admin`, `superadmin`) and their
// permissions are FROZEN HERE IN CODE (`BUILTIN_ROLE_PERMISSIONS`), never
// stored: nothing an operator does to the database can change what a built-in
// role may do, and the equivalence lock (tests/rbac-builtin-equivalence.api.spec.js)
// proves they answer every admin route exactly as they did before roles existed.
// Only CUSTOM roles have `role_permissions` rows.
//
// Each role has a SCOPE MODE (its "class"):
//   none     — not an admin of anything (participant). Fails closed: an unknown
//              role key resolves here, with no permissions.
//   granted  — acts only on the events it holds `competition_admins` rows for
//              (the event-admin shape). Every `lib/event-admin.js` row predicate
//              binds it exactly as it binds an event admin.
//   all      — unscoped (admin, superadmin).
// Scope and permissions are orthogonal: the permission says WHICH ENDPOINTS,
// the scope says WHICH ROWS.
//
// `ADMIN_ROUTE_PERMISSIONS` decides every `/api/admin/*` route (plus `/metrics`):
// one permission per route. A route in no entry is refused for every role but
// the two built-in global ones (whose router 404 is unchanged). The scanner in
// tests/functional-core-b.api.spec.js holds the map to the live registrations in
// both directions and requires every catalogue permission to be used.
//
// Deps: `../db` and `./event-admin`, both LAZILY (lib/event-admin.js requires
// this module for `roleClass`, and lib/middleware.js requires both).

let _db = null;
function db() { if (!_db) _db = require("../db"); return _db; }

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS = Object.freeze([
  { id: "panel", label: "Admin panel" },
  { id: "events", label: "Events" },
  { id: "templates", label: "Templates" },
  { id: "challenges", label: "Challenges" },
  { id: "participants", label: "Participants" },
  { id: "groups", label: "Groups" },
  { id: "certificates", label: "Certificates" },
  { id: "insight", label: "Rankings, analytics and audit" },
  { id: "export", label: "Exports and imports" },
  { id: "settings", label: "Platform settings and operations" },
  { id: "users", label: "Users and roles" },
]);

// grantable:false — only the built-in roles hold it (a decision about the
// HUMAN, not about an endpoint: the sealed-answer reveal, the perf seeder, the
// break-glass account's own name; the platform's Checkmarx One key and its
// account removals, a tenant credential covering every event — operator ruling,
// 14 Nov 2026; and the mail server, whose password sends as the platform —
// owner decision, 27 Nov 2026). The role form refuses one by name, and a grant stored before it
// became non-grantable grants nothing and is pruned at boot (db.js).
const _P = (id, section, label, grantable = true) => ({ id, section, label, grantable });
const PERMISSIONS = Object.freeze([
  _P("panel.access", "panel", "Open the admin panel"),
  _P("events.view", "events", "See events, their sessions, organisers and history"),
  _P("events.edit", "events", "Edit event settings, tags and sessions"),
  _P("events.run", "events", "End events and sessions, close late entry"),
  _P("events.join_link", "events", "Reveal and regenerate join links"),
  _P("events.clone", "events", "Clone an event or start one from a template"),
  _P("events.create", "events", "Create events"),
  _P("events.organisers", "events", "Add and remove event organisers"),
  _P("events.delete", "events", "Delete events"),
  _P("templates.view", "templates", "See event templates"),
  _P("templates.manage", "templates", "Create, edit and delete event templates"),
  _P("challenges.view", "challenges", "See challenges, versions, attachments and feedback"),
  _P("challenges.edit", "challenges", "Create and edit challenges"),
  _P("challenges.assign", "challenges", "Assign challenges to events"),
  _P("challenges.delete", "challenges", "Delete challenges and feedback"),
  _P("challenges.lock", "challenges", "Lock challenges and recalculate scores"),
  _P("challenges.sealed_reveal", "challenges", "Reveal a sealed answer", false),
  _P("participants.view", "participants", "See participants and their history"),
  _P("participants.edit", "participants", "Edit participant profiles, tags and group membership"),
  _P("participants.approve", "participants", "Approve and deny accounts"),
  _P("participants.block", "participants", "Block and unblock accounts"),
  _P("participants.signin_codes", "participants", "Email or reveal sign-in codes"),
  _P("participants.impersonate", "participants", "View as a participant"),
  _P("participants.enrol", "participants", "Enrol, remove and invite participants"),
  _P("participants.verify", "participants", "Mark accounts verified"),
  _P("participants.delete", "participants", "Delete accounts"),
  _P("groups.view", "groups", "See groups"),
  _P("groups.manage", "groups", "Create, edit and delete groups"),
  _P("certificates.view", "certificates", "See and download certificates, preview designs"),
  _P("certificates.send", "certificates", "Resend certificate emails"),
  _P("certificates.design", "certificates", "Edit certificate designs"),
  _P("certificates.revoke", "certificates", "Revoke certificates and issue them again"),
  _P("certificates.lookup", "certificates", "Look up a certificate by its code"),
  _P("leaderboard.view", "insight", "See live rankings"),
  _P("analytics.view", "insight", "See analytics"),
  _P("audit.view", "insight", "See the audit trail"),
  _P("audit.raw_logs", "insight", "See the raw request and application logs"),
  _P("export.data", "export", "Export event, participant and challenge data"),
  _P("export.platform", "export", "Export every event on the platform"),
  _P("export.settings", "export", "Export platform settings"),
  _P("data.import", "export", "Import challenges and participants"),
  _P("settings.view", "settings", "See platform settings"),
  _P("settings.edit", "settings", "Change platform settings"),
  _P("ops.alerts", "settings", "See and acknowledge operational alerts"),
  _P("ops.metrics", "settings", "Read platform metrics"),
  _P("ops.retention_view", "settings", "See data retention"),
  _P("ops.retention_purge", "settings", "Purge old event data"),
  _P("ops.cxone", "settings", "Manage Checkmarx One defaults and account removals", false),
  _P("ops.email", "settings", "Send test email, manage unsubscribed addresses"),
  _P("ops.smtp", "settings", "Change the mail server (SMTP) the platform sends through", false),
  _P("ops.perf_seed", "settings", "Seed performance data", false),
  _P("breakglass.self", "settings", "Manage the break-glass account", false),
  _P("users.view", "users", "See platform users and roles"),
  _P("users.manage", "users", "Add platform users and change roles"),
  _P("roles.manage", "users", "Create, edit and delete custom roles"),
]);
const PERMISSION_IDS = new Set(PERMISSIONS.map(p => p.id));
const _PERM_BY_ID = new Map(PERMISSIONS.map(p => [p.id, p]));

// ─────────────────────────────────────────────────────────────────────────────
// The built-in roles — FROZEN. Changing any of these sets changes what today's
// four roles may do, which the equivalence lock refuses.
// ─────────────────────────────────────────────────────────────────────────────

// `Object.freeze` does not stop `Set#add`, so a frozen set refuses its mutators.
class _FrozenSet extends Set {
  add(v) { if (this._sealed) throw new TypeError("built-in role permissions are frozen"); return super.add(v); }
  delete() { throw new TypeError("built-in role permissions are frozen"); }
  clear() { throw new TypeError("built-in role permissions are frozen"); }
}
function _frozenSet(items) {
  const s = new _FrozenSet(items);
  Object.defineProperty(s, "_sealed", { value: true });
  return Object.freeze(s);
}

const _EVENT_ADMIN_PERMS = [
  "panel.access",
  "events.view", "events.edit", "events.run", "events.join_link", "events.clone",
  "templates.view",
  "challenges.view", "challenges.edit", "challenges.assign",
  "participants.view", "participants.edit", "participants.approve", "participants.block",
  "participants.signin_codes", "participants.impersonate", "participants.enrol",
  "groups.view", "groups.manage",
  "certificates.view", "certificates.send",
  "leaderboard.view", "analytics.view", "audit.view",
  "export.data",
];
const _ADMIN_PERMS = [
  ..._EVENT_ADMIN_PERMS,
  "events.create", "events.organisers", "templates.manage", "certificates.design",
  "audit.raw_logs", "export.platform", "settings.view",
  "ops.alerts", "ops.metrics", "ops.retention_view",
  // Users & roles: an admin SEES the platform's users and roles; only a
  // superadmin changes them (users.manage / roles.manage are superadmin-only).
  "users.view",
];
const BUILTIN_ROLE_PERMISSIONS = Object.freeze({
  participant: _frozenSet([]),
  event_admin: _frozenSet(_EVENT_ADMIN_PERMS),
  admin: _frozenSet(_ADMIN_PERMS),
  superadmin: _frozenSet(PERMISSIONS.map(p => p.id).filter(id => id !== "breakglass.self")),
});
const BUILTIN_ROLES = Object.freeze({
  participant: Object.freeze({ id: "participant", label: "Participant", scope_mode: "none", rank: 0,
    description: "Takes part in events. No access to the admin panel." }),
  event_admin: Object.freeze({ id: "event_admin", label: "Event admin", scope_mode: "granted", rank: 1,
    description: "Runs only the events they are made an organiser of." }),
  admin: Object.freeze({ id: "admin", label: "Admin", scope_mode: "all", rank: 2,
    description: "Runs every event. Cannot change platform settings, roles or delete data." }),
  superadmin: Object.freeze({ id: "superadmin", label: "Superadmin", scope_mode: "all", rank: 3,
    description: "Everything, including platform settings, roles and deletion." }),
});
const BUILTIN_ROLE_IDS = Object.freeze(Object.keys(BUILTIN_ROLES));

/** A permission the built-in admin role does not hold — only a superadmin may grant it. */
function isSuperOnlyPermission(perm) {
  return PERMISSION_IDS.has(perm) && !BUILTIN_ROLE_PERMISSIONS.admin.has(perm);
}

// PLATFORM-WIDE PERMISSIONS: what their routes do reaches beyond any one event,
// so nothing narrows them to the events a role holds. Some read about EVERY event
// (the raw request and application logs, the export of every event, the IP-ban
// alerts, each naming the live event and its venue's address; the metrics,
// retention, settings, the settings export, the unsubscribe list); some change
// what every event shares (platform settings and the platform look, the global
// certificate design (both design layers are global admins' by operator ruling,
// 29 Oct 2026), event templates, imports, which write accounts and enrolments
// platform-wide); some act on a person or a role, which no event bounds (deleting
// an account removes it from every event; Users & roles); and two put an event
// in someone's hands, which stays a global admin's (the organiser grant, operator
// ruling; a blank create, which leaves the new event outside the creator's
// scope: a scoped role creates by clone or template, as an event admin does).
// A role scoped to its events (`granted`) is bound exactly as an event admin, who
// holds none of these, so it cannot hold one either: the role form refuses one by
// name (routes/users.js), and a stored grant from before the rule grants nothing
// (`_readRoleDef`), so the gate, the routes' own guards (`customRoleAllows`) and
// the permissions /api/admin/me reports all agree without a check of their own.
// Every OTHER permission a scoped role may hold is one whose routes narrow to its
// events: the scoped-handler scanner in tests/functional-core-b.api.spec.js holds
// each such route to a lib/event-admin.js predicate, the superadmin-tier ones too.
const PLATFORM_WIDE_PERMISSIONS = Object.freeze(new Set([
  "audit.raw_logs", "export.platform", "ops.alerts",
  "events.create", "events.organisers", "templates.manage", "certificates.design",
  "participants.delete", "export.settings", "data.import", "settings.view", "settings.edit",
  "ops.metrics", "ops.retention_view", "ops.retention_purge", "ops.email",
  "users.view", "users.manage", "roles.manage",
]));
function isPlatformWidePermission(perm) {
  return PLATFORM_WIDE_PERMISSIONS.has(perm);
}

// ─────────────────────────────────────────────────────────────────────────────
// Every admin route, decided. `rows`: 'scoped' — the handler narrows rows with
// a lib/event-admin.js predicate; 'open' — no entity to check.
// ─────────────────────────────────────────────────────────────────────────────

const _R = (perm, rows = "scoped") => Object.freeze({ perm, rows });
const ADMIN_ROUTE_PERMISSIONS = new Map(Object.entries({
  // ── the panel itself ──────────────────────────────────────────────────────
  "GET /api/admin/me": _R("panel.access", "open"),
  "POST /api/admin/logout": _R("panel.access", "open"),
  "POST /api/admin/attachment-staging": _R("panel.access", "open"),
  "PATCH /api/admin/attachment-staging/:id": _R("panel.access", "open"),
  "DELETE /api/admin/attachment-staging/:id": _R("panel.access", "open"),
  "POST /api/admin/join-qr": _R("panel.access", "open"),

  // ── events ────────────────────────────────────────────────────────────────
  "GET /api/admin/competitions": _R("events.view"),
  "GET /api/admin/competition-tags": _R("events.view"),
  "GET /api/admin/competitions/:id/delivery": _R("events.view"),
  "GET /api/admin/competitions/:id/admins": _R("events.view"),
  "GET /api/admin/competitions/:id/overview-pulse": _R("events.view"),   // competitionDenied in routes/event-overview.js
  // Event team + persona reports (routes/event-team.js). The team, its targets and
  // Send now follow whoever edits the event (scoped: an event admin on their own
  // events, admins on any); the domain list that bounds it is a superadmin's.
  "GET /api/admin/competitions/:id/team": _R("events.view"),
  "POST /api/admin/competitions/:id/team": _R("events.edit"),
  "DELETE /api/admin/competitions/:id/team/:memberId": _R("events.edit"),
  "PUT /api/admin/competitions/:id/team-targets": _R("events.edit"),
  "GET /api/admin/competitions/:id/team-report": _R("participants.view"),
  "GET /api/admin/competitions/:id/team-report/preview": _R("participants.view"),
  "GET /api/admin/competitions/:id/team-report/leads.csv": _R("export.data"),
  "POST /api/admin/competitions/:id/team-report/send": _R("events.edit"),
  "POST /api/admin/competitions/:id/leads/:userId/contacted": _R("participants.edit"),
  "GET /api/admin/team-report-domains": _R("settings.view", "open"),
  "PUT /api/admin/team-report-domains": _R("settings.edit", "open"),
  "GET /api/admin/competitions/:id/timeslots": _R("events.view"),
  "GET /api/admin/competitions/:id/groups": _R("events.view"),
  "GET /api/admin/competitions/:id/events": _R("events.view"),
  "GET /api/admin/competitions/:id/timeslots/:tsId/events": _R("events.view"),
  "PUT /api/admin/competitions/:id": _R("events.edit"),
  "POST /api/admin/competitions/:id/tags": _R("events.edit"),
  "DELETE /api/admin/competitions/:id/tags/:tag": _R("events.edit"),
  "PUT /api/admin/competitions/:id/cxone": _R("events.edit"),
  "PUT /api/admin/competitions/:id/look": _R("events.edit"),   // competitionDenied in routes/event-look.js
  "DELETE /api/admin/competitions/:id/cxone": _R("events.edit"),
  "POST /api/admin/competitions/:id/timeslots": _R("events.edit"),
  "PUT /api/admin/competitions/:id/timeslots/:tsId": _R("events.edit"),
  "DELETE /api/admin/competitions/:id/timeslots/:tsId": _R("events.edit"),
  "POST /api/admin/competitions/:id/timeslots/bulk-delete": _R("events.edit"),
  // The caller's own address, for the event form's Trusted network IPs (the
  // field the event PUT writes): routes/admin-misc.js. No event to narrow.
  "GET /api/admin/my-address": _R("events.edit", "open"),
  "POST /api/admin/competitions/:id/end-now": _R("events.run"),
  "POST /api/admin/competitions/:id/timeslots/:tsId/end-now": _R("events.run"),
  "POST /api/admin/competitions/:id/late-entry/close": _R("events.run"),
  "GET /api/admin/competitions/:id/self-enroll": _R("events.join_link"),
  "POST /api/admin/competitions/:id/self-enroll/regenerate": _R("events.join_link"),
  "POST /api/admin/competitions/:id/clone": _R("events.clone"),
  "POST /api/admin/event-templates/:id/spawn": _R("events.clone"),
  "POST /api/admin/competitions": _R("events.create"),
  "POST /api/admin/competitions/:id/admins": _R("events.organisers"),
  "DELETE /api/admin/competitions/:id/admins/:uid": _R("events.organisers"),
  "DELETE /api/admin/competitions/:id": _R("events.delete"),

  // ── templates ─────────────────────────────────────────────────────────────
  "GET /api/admin/event-templates": _R("templates.view"),
  "GET /api/admin/event-templates/:id": _R("templates.view"),
  "POST /api/admin/event-templates": _R("templates.manage"),
  "PUT /api/admin/event-templates/:id": _R("templates.manage"),
  "DELETE /api/admin/event-templates/:id": _R("templates.manage"),
  "POST /api/admin/competitions/:id/save-as-template": _R("templates.manage"),
  // v8.17.0 — template protection and recovery, global admins only.
  "GET /api/admin/event-templates/deleted": _R("templates.manage", "open"),
  "POST /api/admin/event-templates/restore-builtins": _R("templates.manage", "open"),
  "POST /api/admin/event-templates/:id/protect": _R("templates.manage", "open"),
  "POST /api/admin/event-templates/:id/restore": _R("templates.manage", "open"),
  "POST /api/admin/event-templates/:id/reset": _R("templates.manage", "open"),

  // ── challenges ────────────────────────────────────────────────────────────
  "GET /api/admin/tasks": _R("challenges.view"),
  "GET /api/admin/task-tags": _R("challenges.view"),
  "GET /api/admin/tasks/:id/versions": _R("challenges.view"),
  "GET /api/admin/tasks/:id/attachments": _R("challenges.view"),
  "GET /api/admin/tasks/:taskId/attachments/:aid": _R("challenges.view"),
  "GET /api/admin/tasks/:id/feedback": _R("challenges.view"),
  "POST /api/admin/tasks": _R("challenges.edit"),
  "PUT /api/admin/tasks/:id": _R("challenges.edit"),
  "POST /api/admin/tasks/:id/publish": _R("challenges.edit"),
  "PATCH /api/admin/tasks/:id/visibility": _R("challenges.edit"),
  "POST /api/admin/tasks/:id/restore": _R("challenges.edit"),
  "POST /api/admin/tasks/:id/tags": _R("challenges.edit"),
  "DELETE /api/admin/tasks/:id/tags/:tag": _R("challenges.edit"),
  "POST /api/admin/tasks/:id/attachments": _R("challenges.edit"),
  "PATCH /api/admin/tasks/:id/attachments/:aid": _R("challenges.edit"),
  "DELETE /api/admin/tasks/:id/attachments/:aid": _R("challenges.edit"),
  "POST /api/admin/tasks/:id/attempt-grant": _R("challenges.edit"),
  "POST /api/admin/tasks/:id/competitions": _R("challenges.assign"),
  "PUT /api/admin/tasks/:id/competitions": _R("challenges.assign"),
  "DELETE /api/admin/tasks/:id/competitions/:cid": _R("challenges.assign"),
  "POST /api/admin/tasks/assign-competitions": _R("challenges.assign"),
  "DELETE /api/admin/tasks/:id": _R("challenges.delete"),
  "DELETE /api/admin/tasks/:id/feedback": _R("challenges.delete"),
  "DELETE /api/admin/tasks/:id/feedback/:userId": _R("challenges.delete"),
  "POST /api/admin/tasks/:id/lock": _R("challenges.lock"),
  "POST /api/admin/tasks/:id/recalculate": _R("challenges.lock"),
  // The route is `requireAdmin` + an inline `actingIsSuperAdmin` refusal (the
  // ACTING human decides); `taskViewDenied` binds the seat's scope inside it.
  "POST /api/admin/tasks/:id/sealed-reveal": _R("challenges.sealed_reveal"),

  // ── participants ──────────────────────────────────────────────────────────
  "GET /api/admin/participants": _R("participants.view"),
  "GET /api/admin/participants/picker": _R("participants.view"),
  "GET /api/admin/tags": _R("participants.view"),
  "GET /api/admin/participants/:id/events": _R("participants.view"),
  "PUT /api/admin/participants/:id": _R("participants.edit"),
  "POST /api/admin/participants/:id/tags": _R("participants.edit"),
  "DELETE /api/admin/participants/:id/tags/:tag": _R("participants.edit"),
  "POST /api/admin/participants/:id/unlock": _R("participants.edit"),
  "POST /api/admin/participants/:id/groups": _R("participants.edit"),
  "DELETE /api/admin/participants/:id/groups/:groupId": _R("participants.edit"),
  "POST /api/admin/participants/:id/approve": _R("participants.approve"),
  "POST /api/admin/participants/:id/deny": _R("participants.approve"),
  "POST /api/admin/participants/bulk-approve": _R("participants.approve"),
  "POST /api/admin/participants/:id/block": _R("participants.block"),
  "POST /api/admin/participants/:id/login-code/email": _R("participants.signin_codes"),
  "POST /api/admin/participants/:id/login-code/reveal": _R("participants.signin_codes"),
  "POST /api/admin/participants/:id/impersonate": _R("participants.impersonate"),
  "POST /api/admin/competitions/assign": _R("participants.enrol"),
  "DELETE /api/admin/competitions/:id/users/:uid": _R("participants.enrol"),
  "POST /api/admin/invitations": _R("participants.enrol"),
  "POST /api/admin/participants/desk-invite": _R("participants.enrol"),
  "POST /api/admin/participants/:id/verify": _R("participants.verify"),
  "DELETE /api/admin/participants/:id": _R("participants.delete"),
  "POST /api/admin/participants/:id/role": _R("users.manage"),

  // ── users and roles (routes/users.js; the role PATCH shares the handler of
  //    the participant role route above, routes/participants.js) ──────────
  "GET /api/admin/users": _R("users.view", "open"),
  "POST /api/admin/users": _R("users.manage", "open"),
  "PATCH /api/admin/users/:id/role": _R("users.manage"),
  "GET /api/admin/roles": _R("users.view", "open"),
  "POST /api/admin/roles": _R("roles.manage", "open"),
  "PUT /api/admin/roles/:id": _R("roles.manage", "open"),
  "DELETE /api/admin/roles/:id": _R("roles.manage", "open"),

  // ── groups ────────────────────────────────────────────────────────────────
  "GET /api/admin/groups": _R("groups.view"),
  "GET /api/admin/groups/:id/members": _R("groups.view"),
  "GET /api/admin/groups/:id/picker": _R("groups.view"),
  "GET /api/admin/groups/:id/competitions": _R("groups.view"),
  "POST /api/admin/groups": _R("groups.manage"),
  "PUT /api/admin/groups/:id": _R("groups.manage"),
  "DELETE /api/admin/groups/:id": _R("groups.manage"),
  "POST /api/admin/groups/:id/members": _R("groups.manage"),
  "DELETE /api/admin/groups/:id/members/:userId": _R("groups.manage"),
  "DELETE /api/admin/competitions/:id/groups/:groupId": _R("groups.manage"),

  // ── certificates ──────────────────────────────────────────────────────────
  "GET /api/admin/competitions/:id/certificates": _R("certificates.view"),
  "GET /api/admin/competitions/:id/certificates/:userId/certificate.pdf": _R("certificates.view"),
  "GET /api/admin/competitions/:id/certificates/:userId/badge.png": _R("certificates.view"),
  "GET /api/admin/competitions/:id/certificates/top3.zip": _R("certificates.view"),
  "GET /api/admin/competitions/:id/certificate-config": _R("certificates.view"),
  "POST /api/admin/certificate-config/preview": _R("certificates.view"),
  "POST /api/admin/competitions/:id/certificates/resend": _R("certificates.send"),
  "GET /api/admin/certificate-config": _R("certificates.design"),
  "PUT /api/admin/certificate-config": _R("certificates.design"),
  "DELETE /api/admin/certificate-config": _R("certificates.design"),
  "PUT /api/admin/competitions/:id/certificate-config": _R("certificates.design"),
  "DELETE /api/admin/competitions/:id/certificate-config": _R("certificates.design"),
  "POST /api/admin/badges/:token/revoke": _R("certificates.revoke"),
  "POST /api/admin/competitions/:id/certificates/reissue": _R("certificates.revoke"),
  "GET /api/admin/credential/:code": _R("certificates.lookup"),

  // ── rankings, analytics, audit ────────────────────────────────────────────
  "GET /api/admin/leaderboard": _R("leaderboard.view"),
  // Program grades (27 Nov 2026): the Progress card's per-learner grades.
  "GET /api/admin/competitions/:id/grades": _R("leaderboard.view"),
  "GET /api/admin/analytics/challenges": _R("analytics.view"),
  "GET /api/admin/submissions": _R("audit.view"),
  // The Audit page (routes/audit.js): every source narrowed in SQL per row.
  "GET /api/admin/audit": _R("audit.view"),
  "GET /api/admin/logs": _R("audit.raw_logs", "open"),
  "GET /api/admin/logs/files": _R("audit.raw_logs", "open"),

  // ── exports and imports ───────────────────────────────────────────────────
  "GET /api/admin/export/tasks": _R("export.data"),
  "GET /api/admin/export/participants": _R("export.data"),
  "GET /api/admin/export/competition-activity": _R("export.data"),
  "GET /api/admin/competitions/:id/free-text-responses": _R("export.data"),
  "GET /api/admin/competitions/:id/export/full": _R("export.data"),
  "GET /api/admin/participants/:id/export/full": _R("export.data"),
  "GET /api/admin/export/competitions": _R("export.platform", "open"),
  "GET /api/admin/export/settings": _R("export.settings", "open"),
  "POST /api/admin/import/tasks": _R("data.import", "open"),
  "POST /api/admin/import/participants": _R("data.import", "open"),

  // ── platform settings and operations ──────────────────────────────────────
  "GET /api/admin/settings": _R("settings.view", "open"),
  "GET /api/admin/settings/events": _R("settings.view", "open"),
  "PATCH /api/admin/settings": _R("settings.edit", "open"),
  "PUT /api/admin/platform-look": _R("settings.edit", "open"),
  "GET /api/admin/alerts": _R("ops.alerts", "open"),
  "POST /api/admin/alerts/:id/ack": _R("ops.alerts", "open"),
  "GET /metrics": _R("ops.metrics", "open"),
  "GET /api/admin/retention": _R("ops.retention_view", "open"),
  "GET /api/admin/system-health": _R("settings.view", "open"),
  "POST /api/admin/retention/purge": _R("ops.retention_purge", "open"),
  "GET /api/admin/default-cxone": _R("ops.cxone", "open"),
  "PUT /api/admin/default-cxone": _R("ops.cxone", "open"),
  "DELETE /api/admin/default-cxone": _R("ops.cxone", "open"),
  "GET /api/admin/cxone/withdrawals": _R("ops.cxone", "open"),
  "POST /api/admin/cxone/withdrawals/retry": _R("ops.cxone", "open"),
  "POST /api/admin/cxone/withdrawals/dismiss": _R("ops.cxone", "open"),
  "POST /api/admin/test-email": _R("ops.email", "open"),
  "GET /api/admin/smtp-settings": _R("settings.view", "open"),
  "PUT /api/admin/smtp-settings": _R("ops.smtp", "open"),
  "DELETE /api/admin/smtp-settings": _R("ops.smtp", "open"),
  "POST /api/admin/smtp-settings/test": _R("ops.smtp", "open"),
  "GET /api/admin/unsubscribed": _R("ops.email", "open"),
  "DELETE /api/admin/unsubscribed/:email": _R("ops.email", "open"),
  "POST /api/admin/perf/bulk-seed-users": _R("ops.perf_seed", "open"),
  "POST /api/admin/perf/bulk-seed-history": _R("ops.perf_seed", "open"),
  "GET /api/admin/breakglass-username": _R("breakglass.self", "open"),
  "PATCH /api/admin/breakglass-username": _R("breakglass.self", "open"),
}));

// Routes classified before the code that registers them has merged. The
// classification scanner accepts an entry here that is not (yet) live, and
// fails once it IS live, so the list cannot go stale silently.
const PENDING_ADMIN_ROUTES = Object.freeze(new Set([]));

// Routes whose permission is not grantable and that refuse INLINE, after their
// own scope check, on a fact about the HUMAN (the sealed reveal asks
// `actingIsSuperAdmin`). The gate passes them for every admin tier, so the
// refusal keeps its own words; a custom role cannot hold the permission.
const INLINE_REFUSAL_ROUTES = Object.freeze(new Set(["POST /api/admin/tasks/:id/sealed-reveal"]));

// The built-in EVENT ADMIN's refusal copy, per route, for every route it is
// refused at the gate (compatibility: code `event_admin_forbidden` and these
// exact sentences, which tests/fixtures/rbac-legacy-routes.json pins). A route
// this tier lacks the permission for and that is NOT here is passed through to
// the route's own `requireSuperAdmin`, whose answer it always got. Each reason
// names who can act instead, or the door this tier has instead (a blank event:
// a template or a clone, operator ruling, 14 Nov 2026).
const EVENT_ADMIN_DENY_COPY = new Map(Object.entries({
  "POST /api/admin/competitions":
    "Event admins cannot create a blank event. Start one from a template, or clone one of your events.",
  "POST /api/admin/competitions/:id/admins":
    "Only an administrator can add an event organiser. Ask one to make this change.",
  "GET /api/admin/team-report-domains":
    "Only an administrator can open the list of email domains in Settings. The domains your event's team may use are shown under its Team & reports.",
  "DELETE /api/admin/competitions/:id/admins/:uid":
    "Only an administrator can remove an event organiser. Ask one to make this change.",
  "POST /api/admin/competitions/:id/save-as-template":
    "Only an administrator can save an event as a template. You can clone your own event instead.",
  "POST /api/admin/event-templates":
    "Only an administrator can create event templates. You can spawn an existing template or clone your own event.",
  "PUT /api/admin/event-templates/:id":
    "Only an administrator can change an event template. Ask one to make this change.",
  "DELETE /api/admin/event-templates/:id":
    "Only an administrator can delete an event template. Ask one to make this change.",
  "GET /api/admin/event-templates/deleted":
    "Only an administrator can see deleted event templates. Ask one to restore a template.",
  "POST /api/admin/event-templates/restore-builtins":
    "Only an administrator can restore the built-in event templates. Ask one to make this change.",
  "POST /api/admin/event-templates/:id/protect":
    "Only an administrator can protect or unprotect an event template. Ask one to make this change.",
  "POST /api/admin/event-templates/:id/restore":
    "Only an administrator can restore a deleted event template. Ask one to make this change.",
  "POST /api/admin/event-templates/:id/reset":
    "Only an administrator can reset a built-in event template. Ask one to make this change.",
  "GET /api/admin/certificate-config":
    "Only an administrator can open the platform certificate design. You can preview your event's certificate.",
  "PUT /api/admin/certificate-config":
    "Only an administrator can change the platform certificate design. Ask one to make this change.",
  "DELETE /api/admin/certificate-config":
    "Only an administrator can reset the platform certificate design. Ask one to make this change.",
  "PUT /api/admin/competitions/:id/certificate-config":
    "Only an administrator can change an event's certificate design. You can preview and download certificates.",
  "DELETE /api/admin/competitions/:id/certificate-config":
    "Only an administrator can reset an event's certificate design. You can preview and download certificates.",
  "GET /api/admin/breakglass-username":
    "Only the break-glass account itself can see its username.",
  "PATCH /api/admin/breakglass-username":
    "Only the break-glass account itself can change its username.",
  "GET /api/admin/logs":
    "The request log covers the whole platform, so it is not available to event admins.",
  "GET /api/admin/logs/files":
    "The request log covers the whole platform, so it is not available to event admins.",
  "GET /api/admin/settings":
    "Platform settings apply to every event, so they are not available to event admins.",
  "GET /api/admin/settings/events":
    "Platform settings apply to every event, so they are not available to event admins.",
  "GET /api/admin/alerts":
    "Operational alerts cover the whole platform. To allow a venue's network, edit Trusted network IPs on your own event.",
  "POST /api/admin/alerts/:id/ack":
    "Operational alerts cover the whole platform, so they are not available to event admins.",
  "GET /api/admin/system-health":
    "The platform's health covers every event, so it is not available to event admins.",
  "GET /api/admin/retention":
    "Data retention applies to every event, so it is not available to event admins.",
  "GET /api/admin/export/competitions":
    "That export covers every event on the platform. Use Export Activity on one of your own events instead.",
  "GET /metrics":
    "Platform metrics cover every event, so they are not available to event admins.",
  "GET /api/admin/cxone/withdrawals":
    "Only a superadmin can see the Checkmarx One accounts waiting to be removed for deleted participants.",
  "POST /api/admin/cxone/withdrawals/retry":
    "Only a superadmin can manage the removal of Checkmarx One accounts belonging to deleted participants.",
  "POST /api/admin/cxone/withdrawals/dismiss":
    "Only a superadmin can manage the removal of Checkmarx One accounts belonging to deleted participants.",
}));

/** The refusal a CUSTOM role gets for a permission it does not hold. */
function permissionDeniedCopy(perm) {
  const p = _PERM_BY_ID.get(perm);
  const what = p ? p.label.charAt(0).toLowerCase() + p.label.slice(1) : "do this";
  return `Your role does not allow you to ${what}. Ask an administrator to change your role.`;
}
const PERMISSION_DENIED_COPY = Object.freeze(Object.fromEntries(PERMISSIONS.map(p => [p.id, permissionDeniedCopy(p.id)])));

// ── route matching (moved unchanged from lib/event-admin.js) ────────────────
// A global middleware runs BEFORE Express has matched a route, so `req.route` is
// not yet set. The pattern list is matched by hand: equal segment count,
// literals must be equal, `:param` matches anything, and where more than one
// pattern fits, the one with MORE LITERAL segments wins — which is what
// Express's registration order effectively yields for the pairs that exist
// (`/participants/picker` vs `/participants/:id/...`).
let _PATTERNS = null;
function _patterns() {
  if (_PATTERNS) return _PATTERNS;
  const byMethod = new Map();
  for (const key of ADMIN_ROUTE_PERMISSIONS.keys()) {
    const sp = key.indexOf(" ");
    const method = key.slice(0, sp);
    const segs = key.slice(sp + 1).split("/").filter(Boolean);
    if (!byMethod.has(method)) byMethod.set(method, []);
    byMethod.get(method).push({ key, segs, literals: segs.filter(s => !s.startsWith(":")).length });
  }
  _PATTERNS = byMethod;
  return byMethod;
}

/** `METHOD /pattern` for this request, or null when nothing is registered. */
function routeKeyFor(method, path) {
  const list = _patterns().get(String(method || "").toUpperCase());
  if (!list) return null;
  const segs = String(path || "").split("/").filter(Boolean);
  let best = null;
  for (const p of list) {
    if (p.segs.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const ps = p.segs[i];
      if (ps.startsWith(":")) continue;
      if (ps !== segs[i]) { ok = false; break; }
    }
    if (ok && (!best || p.literals > best.literals)) best = p;
  }
  return best ? best.key : null;
}

/** The permission a request needs, or null when the route is not an admin route we decide. */
function routePermissionFor(method, path) {
  const key = routeKeyFor(method, path);
  return key ? ADMIN_ROUTE_PERMISSIONS.get(key).perm : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roles: class and permissions
// ─────────────────────────────────────────────────────────────────────────────

function isBuiltinRole(roleId) {
  return typeof roleId === "string" && Object.prototype.hasOwnProperty.call(BUILTIN_ROLES, roleId);
}

// Custom role definitions, cached 2 s (the role and scope caches' terms) and
// cleared in full whenever a role is created, edited or deleted.
const _roleDefCache = new Map(); // roleId → { ts, def }
const _ROLE_DEF_TTL_MS = 2_000;
const _ROLE_DEF_MAX = 500;

function _readRoleDef(roleId) {
  let row = null;
  try {
    row = db().prepare("SELECT id, label, scope_mode, rank, builtin FROM roles WHERE id=?").get(roleId);
  } catch (e) {
    // Before the roles table exists (an older database mid-boot) a custom role
    // cannot be resolved: fail closed.
    require("./best-effort").swallowed("rbac:role-read", e);
    return null;
  }
  if (!row || row.builtin) return null;
  const scope = ["none", "granted", "all"].includes(row.scope_mode) ? row.scope_mode : "none";
  const perms = new Set(db().prepare("SELECT permission FROM role_permissions WHERE role_id=?").all(roleId)
    .map(r => r.permission)
    // A stored permission that is not (or is no longer) in the catalogue, or is
    // not grantable, grants nothing — nor does a platform-wide one held by a
    // role that is not unscoped.
    .filter(p => PERMISSION_IDS.has(p) && _PERM_BY_ID.get(p).grantable
      && (scope === "all" || !PLATFORM_WIDE_PERMISSIONS.has(p))));
  return { id: row.id, label: row.label, scope_mode: scope, rank: row.rank, builtin: false, perms };
}

/** A role's definition — built-in from code, custom from the table — or null for an unknown key. */
function roleDefinition(roleId, { live = false } = {}) {
  if (!roleId) return null;
  if (isBuiltinRole(roleId)) {
    const b = BUILTIN_ROLES[roleId];
    return { ...b, builtin: true, perms: BUILTIN_ROLE_PERMISSIONS[roleId] };
  }
  if (!live) {
    const hit = _roleDefCache.get(roleId);
    if (hit && (Date.now() - hit.ts) < _ROLE_DEF_TTL_MS) return hit.def;
  }
  const def = _readRoleDef(roleId);
  if (_roleDefCache.size >= _ROLE_DEF_MAX) {
    const oldest = _roleDefCache.keys().next().value;
    if (oldest !== undefined) _roleDefCache.delete(oldest);
  }
  _roleDefCache.set(roleId, { ts: Date.now(), def });
  return def;
}

/** 'none' | 'granted' | 'all'. An unknown or missing role is 'none' (fail closed). */
function roleClass(roleId, opts) {
  const d = roleDefinition(roleId, opts);
  return d ? d.scope_mode : "none";
}

/** Is this role an admin tier of any kind (a class other than none)? */
function isAdminClassRole(roleId, opts) {
  return roleClass(roleId, opts) !== "none";
}

/**
 * Is this role an UNSCOPED admin (class `all`: the built-in admin and
 * superadmin, and every custom unscoped role)? The "privileged target" rule
 * (only a superadmin may act on such an account) asks this.
 */
function isGlobalClassRole(roleId, opts) {
  return roleClass(roleId, opts) === "all";
}

/** The permission set a role holds (an empty set for an unknown role). */
function rolePermissions(roleId, opts) {
  const d = roleDefinition(roleId, opts);
  return d ? d.perms : new Set();
}

function roleHasPermission(roleId, perm, opts) {
  return rolePermissions(roleId, opts).has(perm);
}

/** Every role id whose class is `cls` (built-in and custom), for SQL `json_each` lists. */
function roleIdsOfClass(cls) {
  const ids = BUILTIN_ROLE_IDS.filter(id => BUILTIN_ROLES[id].scope_mode === cls);
  try {
    for (const r of db().prepare("SELECT id FROM roles WHERE builtin=0 AND scope_mode=?").all(cls)) ids.push(r.id);
  } catch (e) { require("./best-effort").swallowed("rbac:class-list", e); }
  return ids;
}

/**
 * For a CUSTOM role at a route's own tier guard (`requireSuperAdmin`,
 * `requireGlobalAdmin`) or at a commit-time re-check: does the role hold — read
 * LIVE, uncached — the permission THIS route needs? A built-in role is never
 * asked this (its guard keeps its own answer, which the equivalence lock pins).
 * An explicit `perm` overrides the route lookup.
 */
function customRoleAllows(req, roleId, perm) {
  if (!roleId || isBuiltinRole(roleId)) return false;
  let need = perm || null;
  if (!need) {
    const path = require("./util").normaliseRoutePath((req && (req.path || req.originalUrl)) || "");
    need = routePermissionFor(req && req.method, path);
  }
  if (!need) return false;
  const def = roleDefinition(roleId, { live: true });
  return !!def && def.scope_mode !== "none" && def.perms.has(need);
}

/**
 * May THIS actor move an account from `fromRole` to `toRole`? (The route has
 * already asked for `users.manage`.) The escalation rule: nobody hands out, or
 * takes away, more than they hold.
 *   • the target role must exist (built-in, or a custom role row);
 *   • assigning the built-in superadmin, or any role holding a superadmin-only
 *     permission, needs a superadmin;
 *   • the new role's permissions, and the account's CURRENT role's, must each
 *     be a subset of the actor's.
 * Returns null, or `{status, code, error}`. Built-in superadmins pass every arm
 * (they hold every permission), so today's role route answers as before.
 */
function roleAssignDenied(req, fromRole, toRole) {
  const to = roleDefinition(toRole, { live: true });
  if (!to) return { status: 400, code: "role_unknown", error: "That role does not exist." };
  const actor = actorPermissions(req);
  const actorIsSuper = actor.builtinAccount || actor.role === "superadmin";
  const needsSuper = toRole === "superadmin" || [...to.perms].some(isSuperOnlyPermission);
  if (needsSuper && !actorIsSuper) {
    return { status: 403, code: "role_escalation", error: "Only a superadmin can give this role, because it includes superadmin-only permissions." };
  }
  const outside = [...to.perms].filter(p => !actor.perms.has(p));
  if (outside.length) {
    return { status: 403, code: "role_escalation", error: "You cannot give a role that can do more than your own role can." };
  }
  const from = roleDefinition(fromRole || "participant", { live: true });
  if (from && [...from.perms].some(p => !actor.perms.has(p))) {
    return { status: 403, code: "role_escalation", error: "You cannot change the role of an account that can do more than you can." };
  }
  return null;
}

/**
 * Is the account holding `targetRole` a PRIVILEGED TARGET for this actor — one
 * only a superadmin may manage (its profile and addresses, approve, deny,
 * block, unlock, an emailed sign-in code, tags, group membership)? The ONE
 * server predicate for every such door; the People rows carry its answer
 * (`privileged_target`) so the client offers exactly what the routes accept.
 *   • an unscoped (class `all`) role, built-in or custom;
 *   • any role holding a permission the actor's own role lacks: managing an
 *     account includes moving the address its sign-in codes go to, so it is
 *     taking what that account may do (the rule `roleAssignDenied` states for a
 *     role change);
 *   • a role key with no definition (fails closed).
 * A superadmin is never refused here. A scoped actor is also refused every
 * non-participant target by `participantDenied` (lib/event-admin.js).
 * `opts.live` (default true) reads the target role uncached; `opts.actor`
 * passes a precomputed `actorPermissions(req)` for a whole page of rows.
 */
function privilegedTargetFor(req, targetRole, { live = true, actor = null } = {}) {
  if (req && req.session && req.session.isSuperAdmin) return false;
  const def = roleDefinition(targetRole || "participant", { live });
  if (!def) return true;
  if (def.scope_mode === "all") return true;
  const mine = (actor || actorPermissions(req)).perms;
  for (const p of def.perms) if (!mine.has(p)) return true;
  return false;
}

/** Clear every cached role definition (after a role is created, edited or deleted). */
function invalidateRoleCaches() {
  _roleDefCache.clear();
  try { require("./event-admin").invalidateEventAdminScope(null); } catch (e) { require("./best-effort").swallowed("rbac:scope-clear", e); }
}

/**
 * What the session's actor may do: `{ role, class, perms, builtinAccount }`.
 * The built-in break-glass account holds every permission. Under an
 * admin-shaped impersonation the SEAT answers (the organiser's panel).
 */
/**
 * Does the ACTING admin hold `perm`, read live? Under impersonation the acting
 * admin is the HAND (the admin at the keyboard, never the seat); otherwise it is
 * the session's own account. A hand blocked, denied, unverified, unapproved or
 * deleted holds nothing. `actorPermissions` answers about the SEAT, which in a
 * participant-shaped impersonation is the participant (operator ruling, 23 Nov
 * 2026: viewing as a participant shows their certificate code and link only to a
 * hand holding `certificates.lookup`).
 */
function handHolds(req, perm) {
  const role = require("./event-admin").actingAdminLiveRole(req);
  return !!role && rolePermissions(role, { live: true }).has(perm);
}

// SWEEP #501 (operator ruling, 23 Nov 2026): while "Require account approval" is
// on, an account made through an invitation from a role that cannot approve
// accounts waits for approval, and such a role's desk sign-up is refused. Both
// read the role LIVE (no 2 s cache: they are asked at a commit) and fail closed.
const _APPROVER_ROW = "SELECT role, blocked, denied_at, approved FROM users WHERE ";
function _rowMayApprove(u) {
  return !!u && !u.blocked && !u.denied_at && !!u.approved
    && rolePermissions(u.role || "participant", { live: true }).has("participants.approve");
}
/**
 * May the person who made this invitation approve accounts NOW? `invited_by_id`
 * names the account (the seat whose permissions were checked when it was made);
 * an older invitation names an address in `invited_by` instead, read by the
 * primary's NOCASE index. The built-in superadmin (`invited_by` "superadmin", no
 * row) may. An inviter whose account is gone, blocked, denied or unapproved, or an
 * invitation naming nobody (`admin`, the column's old default), may not.
 */
function inviterMayApproveNow(inv) {
  if (!inv) return false;
  if (inv.invited_by_id) return _rowMayApprove(db().prepare(`${_APPROVER_ROW}id=?`).get(inv.invited_by_id));
  if (inv.invited_by === "superadmin") return true;
  if (typeof inv.invited_by === "string" && inv.invited_by.includes("@")) {
    return _rowMayApprove(db().prepare(`${_APPROVER_ROW}email=? COLLATE NOCASE`).get(inv.invited_by));
  }
  return false;
}
/** May the session's own account (the SEAT under impersonation) approve accounts NOW? */
function actorMayApproveNow(req) {
  const s = req && req.session;
  if (!s) return false;
  if (s.builtinId === "superadmin" && !s.impersonator) return true;
  return !!s.userId && _rowMayApprove(db().prepare(`${_APPROVER_ROW}id=?`).get(s.userId));
}

function actorPermissions(req) {
  const s = req && req.session;
  if (s && s.builtinId === "superadmin" && !s.impersonator) {
    return { role: "superadmin", class: "all", perms: new Set(PERMISSIONS.map(p => p.id)), builtinAccount: true };
  }
  const role = require("./event-admin").actorRole(req);
  const def = roleDefinition(role);
  return { role, class: def ? def.scope_mode : "none", perms: def ? def.perms : new Set(), builtinAccount: false };
}

/**
 * The gate's decision for ONE role on ONE route, as a pure function of the
 * role's definition — so the equivalence lock can ask it for every route and
 * every built-in role without a request.
 *   { next: true }                         — pass to the route
 *   { status, code, error }                — refuse here
 */
function guardDecision(roleId, routeKey) {
  const builtin = isBuiltinRole(roleId);
  // Today's two global roles were never refused at this gate; their route's own
  // guard answers (and an unknown route keeps the router's 404).
  if (builtin && BUILTIN_ROLES[roleId].scope_mode === "all") return { next: true };
  if (!routeKey || !ADMIN_ROUTE_PERMISSIONS.has(routeKey)) {
    return roleId === "event_admin"
      ? { status: 403, code: "event_admin_unclassified", error: "That part of the admin panel is not available for your role." }
      : { status: 403, code: "admin_route_unclassified", error: "That part of the admin panel is not available for your role." };
  }
  const perm = ADMIN_ROUTE_PERMISSIONS.get(routeKey).perm;
  if (rolePermissions(roleId).has(perm)) return { next: true };
  if (roleId === "event_admin") {
    if (EVENT_ADMIN_DENY_COPY.has(routeKey)) {
      return { status: 403, code: "event_admin_forbidden", error: EVENT_ADMIN_DENY_COPY.get(routeKey) };
    }
    // A superadmin-only permission, or a route that refuses inline: the route's
    // own guard answers, as it always did (requireSuperAdmin / requirePermission).
    if (isSuperOnlyPermission(perm) || INLINE_REFUSAL_ROUTES.has(routeKey)) return { next: true };
    // Any other permission this tier lacks is refused here, so a route whose own
    // guard is only `requireAdmin` can never be reached on a missing permission.
    return { status: 403, code: "event_admin_forbidden", error: permissionDeniedCopy(perm), permission: perm };
  }
  return { status: 403, code: "permission_denied", error: permissionDeniedCopy(perm), permission: perm };
}

/**
 * The default-deny gate. Mounted globally, immediately after `impersonationGuard`
 * (server.js mounts it under its historical name, `eventAdminGuard`).
 *
 * ORDERING, and both clauses are load-bearing:
 *   - it must sit AFTER `session`, or there is no identity to read;
 *   - it must return early for a PARTICIPANT-SHAPED impersonation, because
 *     `req.session.userId` is then the TARGET and the role read would answer
 *     about the wrong person;
 *   - it must RUN for an ADMIN-SHAPED impersonation (an organiser impersonated in
 *     their own panel), because there the seat IS the person the decision is
 *     about.
 */
function permissionGuard() {
  return function eventAdminGuardMw(req, res, next) {
    if (!req.session || (req.session.impersonator && !req.session.isAdmin)) return next();
    if (!req.session.isAdmin) return next();          // requireAdmin answers
    if (req.session.builtinId === "superadmin" && !req.session.impersonator) return next();

    const raw = require("./util").normaliseRoutePath(req.path || "");
    if (!raw.startsWith("/api/admin/") && raw !== "/metrics") return next();

    const role = require("./event-admin").actorRole(req);
    const key = routeKeyFor(req.method, raw);
    const d = guardDecision(role, key);
    if (d.next) return next();
    if (d.code === "event_admin_unclassified" || d.code === "admin_route_unclassified") {
      // Resolved lazily, INSIDE the branch. `server.js` mounts this guard above
      // its own `const reqContext = …`, so capturing either binding at mount time
      // is a TDZ error at boot — the v8.1.0 (PR 20) trap, which `node --check`
      // cannot see. Requiring here also keeps both modules off the hot path.
      try {
        const { log } = require("./log");
        const { reqContext } = require("./audit");
        log.error({ route: `${req.method} ${raw}`, ...reqContext(req) },
          "admin route is not classified for the event-admin tier — refusing");
      } catch (e) { /* never let logging break the refusal */ require("./best-effort").swallowed("event-admin:unclassified-route-log", e); }
    }
    const body = { error: d.error, code: d.code };
    if (d.permission) body.permission = d.permission;
    return res.status(d.status).json(body);
  };
}

module.exports = {
  SECTIONS, PERMISSIONS, PERMISSION_IDS, BUILTIN_ROLES, BUILTIN_ROLE_IDS, BUILTIN_ROLE_PERMISSIONS,
  ADMIN_ROUTE_PERMISSIONS, PENDING_ADMIN_ROUTES, INLINE_REFUSAL_ROUTES, EVENT_ADMIN_DENY_COPY, PERMISSION_DENIED_COPY,
  isSuperOnlyPermission, isPlatformWidePermission, PLATFORM_WIDE_PERMISSIONS, permissionDeniedCopy,
  routeKeyFor, routePermissionFor,
  isBuiltinRole, roleDefinition, roleClass, isAdminClassRole, isGlobalClassRole, rolePermissions, roleHasPermission,
  roleIdsOfClass, invalidateRoleCaches, customRoleAllows, roleAssignDenied, privilegedTargetFor, actorPermissions, handHolds, inviterMayApproveNow, actorMayApproveNow, guardDecision, permissionGuard,
};
