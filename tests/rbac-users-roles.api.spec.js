"use strict";

// USERS & ROLES — custom roles end to end, against a real server.
//
//   1. a custom GRANT-SCOPED role sees exactly its granted events (asserted by
//      value: the other event's name appears nowhere), beside a superadmin
//      control that sees both;
//   2. a permission it lacks is refused at the gate (`permission_denied`); a
//      permission added to, or removed from, the role is honoured at the very
//      next request (the role cache is cleared on the save's commit);
//   3. the escalation rule: an account manager cannot give a role holding a
//      permission their own role does not hold, and a negative control (a
//      role inside their set) succeeds;
//   4. a role in use cannot be deleted; once nobody holds it, it can;
//   5. built-in roles are read-only; unknown permissions are refused by name;
//   6. a platform-wide permission (the raw logs, the every-event export) needs a
//      role that acts on every event: the form refuses it for a scoped role, and
//      a stored grant from before the rule grants nothing;
//   7. Users & roles marks a RIVAL, whose role change is refused.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, buildWorld, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }

test.describe("RBAC — Users & roles and custom roles", () => {
  /** @type {any} */ let w;
  let viewer, viewerUser, viewerApi;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();
    const r = await w.sa.post("/api/admin/roles", {
      headers: H(w.saCsrf),
      data: { label: `Viewer ${Date.now()}`, scope_mode: "granted", permissions: ["events.view", "participants.view"] },
    });
    expect(r.ok(), `create role: ${r.status()} ${await r.text()}`).toBeTruthy();
    viewer = (await r.json()).role;
    expect(viewer.permissions, "panel.access is implicit").toEqual(["events.view", "panel.access", "participants.view"]);

    viewerUser = await makeParticipant(w.sa, w.saCsrf, "viewer");
    const pr = await w.sa.patch(`/api/admin/users/${viewerUser.id}/role`, { headers: H(w.saCsrf), data: { role: viewer.id } });
    expect(pr.ok(), `assign role: ${pr.status()} ${await pr.text()}`).toBeTruthy();
    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, viewerUser.id);
    const l = await apiLogin(viewerUser.email, PARTICIPANT_PASS);
    viewerApi = l.api;
  });

  test("a custom scoped role sees exactly its granted events", async () => {
    const me = await json(await viewerApi.get("/api/admin/me"));
    expect(me.isEventAdmin, "a granted-scope role is scoped like an event admin").toBe(true);
    expect(me.role_info.id).toBe(viewer.id);
    expect(me.permissions).toContain("events.view");
    expect(me.permissions).not.toContain("events.edit");

    const mineList = await viewerApi.get("/api/admin/competitions");
    expect(mineList.status()).toBe(200);
    const body = await mineList.text();
    expect(body, "its own event is listed").toContain(w.mine.name);
    expect(body, "the other organiser's event appears nowhere").not.toContain(w.theirs.name);
    expect(body).not.toContain(w.theirs.id);

    const ctl = await (await w.sa.get("/api/admin/competitions")).text();
    expect(ctl, "superadmin control: both events exist").toContain(w.theirs.name);
    expect(ctl).toContain(w.mine.name);

    // The row predicates bind it too: the out-of-scope event's history is refused.
    const hist = await viewerApi.get(`/api/admin/competitions/${w.theirs.id}/events`);
    expect(hist.status()).toBe(403);
    expect((await json(hist)).code).toBe("event_admin_out_of_scope");
    const ownHist = await viewerApi.get(`/api/admin/competitions/${w.mine.id}/events`);
    expect(ownHist.status(), "control: its own event's history opens").toBe(200);
  });

  // The role-definition cache (lib/rbac.js, 2 s) is cleared on every role save's
  // commit (`invalidateRoleCaches`), so the FIRST request after the save sees the
  // new set. A poll would pass on the TTL alone, so each arm reads once, and only
  // inside the TTL of an entry it knows was filled after its own flush: an
  // unchanged save first empties the cache, the viewer's read refills it, and the
  // whole sequence must land inside 2 s or the arm says it proved nothing.
  const roleNow = async () => (await json(await w.sa.get("/api/admin/roles"))).roles.find(r => r.id === viewer.id);
  async function flushRoleCache() {
    const cur = await roleNow();
    const r = await w.sa.put(`/api/admin/roles/${viewer.id}`, { headers: H(w.saCsrf), data: { expectedVersion: cur.version, permissions: cur.permissions } });
    expect(r.ok(), `unchanged save: ${r.status()} ${await r.text()}`).toBeTruthy();
    return Date.now();
  }
  const INSIDE_TTL_MS = 1800;

  test("a missing permission is refused, and an added one is honoured at the very next request", async () => {
    const flushed = await flushRoleCache();
    const before = await viewerApi.get("/api/admin/tasks");
    expect(before.status(), "PRECONDITION: the permission is missing (and the role is now cached)").toBe(403);
    const b = await json(before);
    expect(b.code).toBe("permission_denied");
    expect(b.permission).toBe("challenges.view");

    const cur = await roleNow();
    const put = await w.sa.put(`/api/admin/roles/${viewer.id}`, {
      headers: H(w.saCsrf),
      data: { expectedVersion: cur.version, permissions: [...cur.permissions, "challenges.view"] },
    });
    expect(put.ok(), `edit role: ${put.status()} ${await put.text()}`).toBeTruthy();
    const sentAt = Date.now();
    const after = await viewerApi.get("/api/admin/tasks");
    expect(sentAt - flushed, "INCONCLUSIVE: the read must land inside the cached entry's 2 s").toBeLessThan(INSIDE_TTL_MS);
    expect(after.status(), "the first request after the save holds the added permission").toBe(200);

    // A stale version is refused, not merged.
    const stale = await w.sa.put(`/api/admin/roles/${viewer.id}`, {
      headers: H(w.saCsrf), data: { expectedVersion: cur.version, label: "Clobber" },
    });
    expect(stale.status()).toBe(409);
    expect((await json(stale)).code).toBe("role_version_stale");
  });

  test("a removed permission is refused at the very next request: the role cache is cleared on commit", async () => {
    // Its own starting point: the role holds challenges.view (the arm above, or this save).
    const start = await roleNow();
    if (!start.permissions.includes("challenges.view")) {
      const r = await w.sa.put(`/api/admin/roles/${viewer.id}`, { headers: H(w.saCsrf), data: { expectedVersion: start.version, permissions: [...start.permissions, "challenges.view"] } });
      expect(r.ok(), `give the role challenges.view: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const flushed = await flushRoleCache();
    const warm = await viewerApi.get("/api/admin/tasks");
    expect(warm.status(), "CONTROL: the permission is held (and the role is now cached)").toBe(200);
    const cur = await roleNow();
    expect(cur.permissions, "PRECONDITION: the role holds challenges.view").toContain("challenges.view");
    try {
      const put = await w.sa.put(`/api/admin/roles/${viewer.id}`, {
        headers: H(w.saCsrf),
        data: { expectedVersion: cur.version, permissions: cur.permissions.filter(p => p !== "challenges.view") },
      });
      expect(put.ok(), `edit role: ${put.status()} ${await put.text()}`).toBeTruthy();
      const sentAt = Date.now();
      const after = await viewerApi.get("/api/admin/tasks");
      expect(sentAt - flushed, "INCONCLUSIVE: the read must land inside the cached entry's 2 s").toBeLessThan(INSIDE_TTL_MS);
      expect(after.status(), "the first request after the save is refused").toBe(403);
      const a = await json(after);
      expect(a.code).toBe("permission_denied");
      expect(a.permission).toBe("challenges.view");
    } finally {
      // Put it back, as the earlier arm left it.
      const now = await roleNow();
      if (!now.permissions.includes("challenges.view")) {
        const r = await w.sa.put(`/api/admin/roles/${viewer.id}`, { headers: H(w.saCsrf), data: { expectedVersion: now.version, permissions: [...now.permissions, "challenges.view"] } });
        expect(r.ok(), "the permission is restored").toBeTruthy();
      }
    }
  });

  test("escalation is refused; a role inside the actor's own set is allowed", async () => {
    const mk = async (label, scope_mode, permissions) => {
      const r = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: `${label} ${Date.now()}`, scope_mode, permissions } });
      expect(r.ok(), `create ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).role;
    };
    const userMgr = await mk("Account manager", "all", ["users.view", "users.manage", "events.view"]);
    const tiny = await mk("Tiny", "all", ["events.view"]);
    const mgr = await makeParticipant(w.sa, w.saCsrf, "mgr");
    expect((await w.sa.patch(`/api/admin/users/${mgr.id}/role`, { headers: H(w.saCsrf), data: { role: userMgr.id } })).ok()).toBeTruthy();
    const target = await makeParticipant(w.sa, w.saCsrf, "target");
    const l = await apiLogin(mgr.email, PARTICIPANT_PASS);

    const toAdmin = await l.api.patch(`/api/admin/users/${target.id}/role`, { headers: H(l.csrf), data: { role: "admin" } });
    expect(toAdmin.status(), "admin holds permissions the manager does not").toBe(403);
    expect((await json(toAdmin)).code).toBe("role_escalation");
    const toViewer = await l.api.patch(`/api/admin/users/${target.id}/role`, { headers: H(l.csrf), data: { role: viewer.id } });
    expect(toViewer.status(), "the viewer role holds participants.view, which the manager lacks").toBe(403);

    const ok = await l.api.patch(`/api/admin/users/${target.id}/role`, { headers: H(l.csrf), data: { role: tiny.id } });
    expect(ok.status(), `negative control: ${await ok.text()}`).toBe(200);
    const users = await json(await l.api.get("/api/admin/users"));
    expect(users.users.find(u => u.id === target.id)?.role, "the role was really written").toBe(tiny.id);

    const mkRole = await l.api.post("/api/admin/roles", { headers: H(l.csrf), data: { label: "Nope", scope_mode: "all", permissions: [] } });
    expect(mkRole.status()).toBe(403);
    expect((await json(mkRole)).code).toBe("permission_denied");
  });

  test("built-in tiers: an admin sees Users & roles but cannot change roles; an event admin sees neither", async () => {
    const adm = await makeParticipant(w.sa, w.saCsrf, "regadmin");
    expect((await w.sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(w.saCsrf), data: { role: "admin" } })).ok()).toBeTruthy();
    const l = await apiLogin(adm.email, PARTICIPANT_PASS);
    expect((await l.api.get("/api/admin/users")).status()).toBe(200);
    expect((await l.api.get("/api/admin/roles")).status()).toBe(200);
    const pr = await l.api.patch(`/api/admin/users/${viewerUser.id}/role`, { headers: H(l.csrf), data: { role: "participant" } });
    expect(pr.status()).toBe(403);
    const ea = await w.eaApi.get("/api/admin/users");
    expect(ea.status()).toBe(403);
    expect((await json(ea)).code).toBe("event_admin_forbidden");
  });

  test("a role in use cannot be deleted; built-ins are read-only; unknown permissions are refused", async () => {
    const del = await w.sa.delete(`/api/admin/roles/${viewer.id}`, { headers: H(w.saCsrf) });
    expect(del.status()).toBe(409);
    const d = await json(del);
    expect(d.code).toBe("role_in_use");
    expect(d.user_count).toBe(1);

    expect((await w.sa.patch(`/api/admin/users/${viewerUser.id}/role`, { headers: H(w.saCsrf), data: { role: "participant" } })).ok()).toBeTruthy();
    const del2 = await w.sa.delete(`/api/admin/roles/${viewer.id}`, { headers: H(w.saCsrf) });
    expect(del2.status(), `delete once unused: ${await del2.text()}`).toBe(200);
    const roles = (await json(await w.sa.get("/api/admin/roles"))).roles;
    expect(roles.some(r => r.id === viewer.id), "the role is gone").toBe(false);
    expect(roles.filter(r => r.builtin).map(r => r.id).sort()).toEqual(["admin", "event_admin", "participant", "superadmin"]);

    const b = await w.sa.put("/api/admin/roles/admin", { headers: H(w.saCsrf), data: { expectedVersion: 1, label: "Boss" } });
    expect(b.status()).toBe(409);
    expect((await json(b)).code).toBe("role_builtin");
    const u = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: "Odd", scope_mode: "all", permissions: ["events.teleport"] } });
    expect(u.status()).toBe(400);
    expect((await json(u)).code).toBe("role_permission_unknown");
    const ng = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: "Odd2", scope_mode: "all", permissions: ["challenges.sealed_reveal"] } });
    expect(ng.status()).toBe(400);
    expect((await json(ng)).code).toBe("role_permission_not_grantable");
  });

  test("a platform-wide permission needs a role that acts on every event: the form refuses it for a scoped role, a stored grant gives nothing, an unscoped role holds it (CONTROL)", async () => {
    // The raw logs, the every-event export and the IP-ban alerts read about every
    // event; a role scoped to its events is bound exactly as an event admin, who
    // holds none of them.
    for (const perm of ["audit.raw_logs", "export.platform", "ops.alerts"]) {
      const r = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: `Scoped ${perm} ${Date.now()}`, scope_mode: "granted", permissions: ["events.view", perm] } });
      expect(r.status(), `${perm}: ${await r.text()}`).toBe(400);
      expect(await json(r)).toMatchObject({ code: "role_permission_needs_every_event", permission: perm });
    }
    // A grant stored before the rule: written straight to the table, so no
    // cached copy of the role exists yet and every read below is of the row.
    const Database = require("better-sqlite3");
    const roleId = `role_pw${Date.now().toString(16)}`;
    const db = new Database(TEST_DB_PATH);
    try {
      const at = new Date().toISOString();
      db.prepare("INSERT INTO roles (id, label, description, builtin, scope_mode, rank, created_by_id, created_at, updated_at, version) VALUES (?,?,?,0,'granted',1,NULL,?,?,1)")
        .run(roleId, `Old scoped logs ${Date.now()}`, "", at, at);
      for (const p of ["panel.access", "events.view", "audit.raw_logs", "export.platform", "ops.alerts"]) db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?,?)").run(roleId, p);
    } finally { db.close(); }
    const holder = await makeParticipant(w.sa, w.saCsrf, "pwhold");
    const as = await w.sa.patch(`/api/admin/users/${holder.id}/role`, { headers: H(w.saCsrf), data: { role: roleId } });
    expect(as.ok(), `assign the stored role: ${await as.text()}`).toBeTruthy();
    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, holder.id);
    const l = await apiLogin(holder.email, PARTICIPANT_PASS);
    const me = await json(await l.api.get("/api/admin/me"));
    expect(me.permissions, "PRECONDITION: the role's other grant is live").toContain("events.view");
    expect(me.permissions, "the platform-wide grants give nothing").not.toContain("audit.raw_logs");
    expect(me.permissions).not.toContain("export.platform");
    expect(me.permissions).not.toContain("ops.alerts");
    for (const path of ["/api/admin/logs?limit=5", "/api/admin/export/competitions", "/api/admin/alerts"]) {
      const r = await l.api.get(path);
      expect(r.status(), `${path}: ${(await r.text()).slice(0, 200)}`).toBe(403);
      expect((await json(r)).code).toBe("permission_denied");
    }
    const listed = (await json(await w.sa.get("/api/admin/roles"))).roles.find(r => r.id === roleId);
    expect(listed.permissions, "the roles list shows what the role really holds").toEqual(["events.view", "panel.access"]);

    // CONTROL: an unscoped role holds both, and its holder reads both.
    const wide = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: `Wide logs ${Date.now()}`, scope_mode: "all", permissions: ["events.view", "audit.raw_logs", "export.platform", "ops.alerts"] } });
    expect(wide.ok(), await wide.text()).toBeTruthy();
    const wideHolder = await makeParticipant(w.sa, w.saCsrf, "pwwide");
    expect((await w.sa.patch(`/api/admin/users/${wideHolder.id}/role`, { headers: H(w.saCsrf), data: { role: (await json(wide)).role.id } })).ok()).toBeTruthy();
    const lw = await apiLogin(wideHolder.email, PARTICIPANT_PASS);
    for (const path of ["/api/admin/logs?limit=5", "/api/admin/export/competitions", "/api/admin/alerts"]) {
      const r = await lw.api.get(path);
      expect(r.status(), `control ${path}: ${(await r.text()).slice(0, 200)}`).toBe(200);
    }
  });

  test("Users & roles marks a RIVAL, whose role the competing account manager may not change; a non-rival is not marked (CONTROL)", async () => {
    const comp = await makeCompetition(w.sa, w.saCsrf, "ua-rival", { staff_compete: true });
    const actor = await makeParticipant(w.sa, w.saCsrf, "uaractor");
    const rival = await makeParticipant(w.sa, w.saCsrf, "uarival");
    const other = await makeParticipant(w.sa, w.saCsrf, "uaother");
    await enrol(w.sa, w.saCsrf, comp.id, [actor.id, rival.id]);
    for (const [u, role] of [[actor, "superadmin"], [rival, "admin"], [other, "admin"]]) {
      const r = await w.sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(w.saCsrf), data: { role } });
      expect(r.ok(), `make ${role}: ${await r.text()}`).toBeTruthy();
    }
    const l = await apiLogin(actor.email, PARTICIPANT_PASS);
    const users = (await json(await l.api.get("/api/admin/users"))).users;
    expect(users.find(u => u.id === rival.id).rival_in, "the rival is marked with the shared event").toMatchObject({ id: comp.id, name: comp.name });
    expect(users.find(u => u.id === other.id).rival_in, "CONTROL: a non-rival is not").toBeNull();
    const refused = await l.api.patch(`/api/admin/users/${rival.id}/role`, { headers: H(l.csrf), data: { role: "participant" } });
    expect(refused.status(), await refused.text()).toBe(403);
    expect((await json(refused)).code).toBe("competitor_cannot_edit");
    const ok = await l.api.patch(`/api/admin/users/${other.id}/role`, { headers: H(l.csrf), data: { role: "participant" } });
    expect(ok.status(), `CONTROL: a non-rival's role changes: ${await ok.text()}`).toBe(200);
    // The built-in superadmin never competes: it sees nobody as a rival.
    const sa = (await json(await w.sa.get("/api/admin/users"))).users;
    expect(sa.find(u => u.id === rival.id).rival_in).toBeNull();
  });

  test("Add user creates an admin account; an existing address is answered user_exists", async () => {
    const email = `newadmin-${Date.now()}@acme.com`;
    const r = await w.sa.post("/api/admin/users", { headers: H(w.saCsrf), data: { email, role: "admin", first_name: "New", last_name: "Admin" } });
    expect(r.status(), await r.text()).toBe(200);
    const id = (await r.json()).id;
    const list = await json(await w.sa.get("/api/admin/users"));
    const row = list.users.find(u => u.id === id);
    expect(row && row.role).toBe("admin");
    expect(row.status).toBe("active");
    const again = await w.sa.post("/api/admin/users", { headers: H(w.saCsrf), data: { email, role: "admin" } });
    expect(again.status()).toBe(409);
    expect((await json(again)).id).toBe(id);
    // People is participants (and organisers): the admin account is not in the
    // default list, and is with ?kind=all (control).
    const people = await json(await w.sa.get("/api/admin/participants?limit=5000"));
    expect(people.participants.some(p => p.id === id), "an admin account is not listed in People").toBe(false);
    expect(people.participants.some(p => p.id === w.ea.id), "an event admin (organiser) still is").toBe(true);
    const everyone = await json(await w.sa.get("/api/admin/participants?limit=5000&kind=all"));
    expect(everyone.participants.some(p => p.id === id), "control: kind=all lists it").toBe(true);
  });

  test("Add user takes a personal address, and its record says the corporate-email rule was passed over (a work address: control)", async () => {
    // Operator ruling, 24 Nov 2026: a platform user may use any valid address,
    // personal ones included; like the rule's other bypasses, it is recorded.
    const Database = require("better-sqlite3");
    const stamp = Date.now();
    const added = async (email) => {
      const r = await w.sa.post("/api/admin/users", { headers: H(w.saCsrf), data: { email, role: "admin", first_name: "Free", last_name: "Mail" } });
      expect(r.status(), `add ${email}: ${await r.text()}`).toBe(200);
      const id = (await r.json()).id;
      const d = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const rows = d.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='user_added'").all(id);
        expect(rows.length, `one user_added row for ${email}`).toBe(1);
        return JSON.parse(rows[0].details);
      } finally { d.close(); }
    };
    const free = await added(`contractor-${stamp}@gmail.com`);
    expect(free).toMatchObject({ via: "users_and_roles", bypassed_free_email_rule: true });
    const work = await added(`staffer-${stamp}@acme.com`);
    expect(work.via).toBe("users_and_roles");
    expect(work, "a work address passes the rule: no marker").not.toHaveProperty("bypassed_free_email_rule");
  });

  test("History says so in words on the Add user record and on a superadmin's edit (CONTROL: no flag, no note)", async ({ page }) => {
    const { BASE } = require("./helpers");
    await page.goto(`${BASE}/`);
    await expect(page.locator("html[data-booted='1']")).toBeAttached({ timeout: 20000 });
    expect(await page.evaluate(() => typeof window.formatEventChange), "PRECONDITION: the History renderer is on window").toBe("function");
    const said = (event_type, details) => page.evaluate(([t, d]) => window.formatEventChange({ event_type: t, details: d }), [event_type, details]);
    const NOTE = "work-address rule was skipped";
    expect(await said("user_added", { via: "users_and_roles", bypassed_free_email_rule: true }), "Add user, personal address").toContain(NOTE);
    expect(await said("user_added", { via: "users_and_roles" }), "CONTROL: a work address").not.toContain(NOTE);
    expect(await said("edited", { changes: { company: { from: "A", to: "B" } }, bypassed_free_email_rule: true }), "a superadmin's edit").toContain(NOTE);
    expect(await said("edited", { changes: { company: { from: "A", to: "B" } } }), "CONTROL: an ordinary edit").not.toContain(NOTE);
  });
});

test.describe("a platform-wide grant stored on a scoped role before the rule is removed once, and recorded", () => {
  // `_readRoleDef` already honours nothing of it; the boot migration in db.js
  // (`every_event_grants_pruned_at`) deletes the rows, so the role's next save
  // does not remove them unrecorded. Driven through db.js in a throwaway
  // DATA_DIR (every test server is a first boot, which has nothing to prune).
  test("the one shot deletes it and records it, keeps an unscoped role's grants (CONTROL), and does not run again", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const Database = require("better-sqlite3");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-prune-"));
    const dbPath = path.join(dir, "hackathon.db");
    const boot = () => {
      const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
      });
      expect(r.status, `db.js boot: ${r.stdout}${r.stderr}`).toBe(0);
    };
    const withDb = (fn, readonly = false) => { const d = new Database(dbPath, { readonly }); try { return fn(d); } finally { d.close(); } };
    const MARKER = "SELECT value FROM settings WHERE key='every_event_grants_pruned_at'";
    const perms = (id) => withDb(d => d.prepare("SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission").all(id).map(r => r.permission), true);
    const records = () => withDb(d => d.prepare("SELECT setting_key, event_type, changed_by, details FROM settings_events WHERE setting_key IN ('role:role_pwscoped','role:role_pwwide') ORDER BY changed_at").all(), true);
    try {
      boot();
      expect(withDb(d => d.prepare(MARKER).get(), true), "a fresh database records the one shot, with nothing to do").toBeTruthy();
      // A database from before the rule: no marker, and two roles holding the grants.
      withDb(d => {
        d.prepare("DELETE FROM settings WHERE key='every_event_grants_pruned_at'").run();
        const at = new Date().toISOString();
        const role = (id, scope, list) => {
          d.prepare("INSERT INTO roles (id, label, description, builtin, scope_mode, rank, created_by_id, created_at, updated_at, version) VALUES (?,?,?,0,?,1,NULL,?,?,1)").run(id, `Label ${id}`, "", scope, at, at);
          for (const p of list) d.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?,?)").run(id, p);
        };
        role("role_pwscoped", "granted", ["events.view", "audit.raw_logs", "export.platform", "ops.alerts"]);
        role("role_pwwide", "all", ["events.view", "audit.raw_logs", "ops.alerts"]);
      });
      boot();
      expect(perms("role_pwscoped"), "the scoped role keeps only what it is honoured for").toEqual(["events.view"]);
      expect(perms("role_pwwide"), "CONTROL: an unscoped role keeps its platform-wide grants").toEqual(["audit.raw_logs", "events.view", "ops.alerts"]);
      const rec = records();
      expect(rec.length, "one record, for the one role it changed").toBe(1);
      expect(rec[0]).toMatchObject({ setting_key: "role:role_pwscoped", event_type: "role_updated", changed_by: "system" });
      expect(JSON.parse(rec[0].details)).toEqual({ label: "Label role_pwscoped", permissions_removed: ["audit.raw_logs", "export.platform", "ops.alerts"], via: "platform_wide_rule" });
      expect(withDb(d => d.prepare(MARKER).get(), true), "the marker is written").toBeTruthy();
      // A grant written after the one shot is not touched by the next boot: it
      // ran once (`_readRoleDef` still honours nothing of it).
      withDb(d => d.prepare("INSERT INTO role_permissions (role_id, permission) VALUES ('role_pwscoped','audit.raw_logs')").run());
      boot();
      expect(perms("role_pwscoped"), "the next boot does not run it again").toEqual(["audit.raw_logs", "events.view"]);
      expect(records().length).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
