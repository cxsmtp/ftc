// @ts-check
//
// CHECKMARX ONE DEFAULTS AND ACCOUNT REMOVALS ARE SUPERADMIN-ONLY (operator
// ruling, 14 Nov 2026). `ops.cxone` reads, replaces and clears the platform's
// Checkmarx One key — a tenant credential covering every event — and decides
// the account removals. It is NOT grantable: the role editor does not offer it,
// the role form refuses it by name, a grant stored on a custom role before the
// ruling grants nothing, and boot removes such grants once, on the record.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant } = require("./event-admin-helpers");

async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }

test.describe("ops.cxone is superadmin-only (operator ruling, 14 Nov 2026)", () => {
  test("the catalogue marks it not grantable, and the role form refuses it by name — for an unscoped role too", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const cat = await json(await api.get("/api/admin/roles"));
      const entry = (cat.permissions || []).find((p) => p.id === "ops.cxone");
      expect(entry, "PRECONDITION: the catalogue lists it").toBeTruthy();
      expect(entry.grantable, "the editor offers it to no role").toBe(false);
      for (const scope of ["all", "granted"]) {
        const r = await api.post("/api/admin/roles", { headers: H(csrf), data: { label: `CX ${scope} ${Date.now()}`, scope_mode: scope, permissions: ["settings.view", "ops.cxone"] } });
        expect(r.status(), `${scope}: ${await r.text()}`).toBe(400);
        expect(await json(r)).toMatchObject({ code: "role_permission_not_grantable", permission: "ops.cxone" });
      }
      // CONTROL: the same role without it is created.
      const ok = await api.post("/api/admin/roles", { headers: H(csrf), data: { label: `CX ok ${Date.now()}`, scope_mode: "all", permissions: ["settings.view"] } });
      expect(ok.status(), await ok.text()).toBe(200);
    } finally { await api.dispose(); }
  });

  test("a grant stored before the ruling gives nothing: the key and the removals are refused to its holder; the built-in superadmin reads both (CONTROL)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const roleId = `role_cx${Date.now().toString(16)}`;
    const db = new Database(TEST_DB_PATH);
    try {
      const at = new Date().toISOString();
      db.prepare("INSERT INTO roles (id, label, description, builtin, scope_mode, rank, created_by_id, created_at, updated_at, version) VALUES (?,?,?,0,'all',1,NULL,?,?,1)")
        .run(roleId, `Old CX holder ${Date.now()}`, "", at, at);
      for (const p of ["panel.access", "settings.view", "ops.cxone"]) db.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?,?)").run(roleId, p);
    } finally { db.close(); }
    try {
      const holder = await makeParticipant(sa, csrf, "cxold");
      const as = await sa.patch(`/api/admin/users/${holder.id}/role`, { headers: H(csrf), data: { role: roleId } });
      expect(as.ok(), `assign the stored role: ${await as.text()}`).toBeTruthy();
      const l = await apiLogin(holder.email, PARTICIPANT_PASS);
      try {
        const me = await json(await l.api.get("/api/admin/me"));
        expect(me.permissions, "PRECONDITION: the role's other grant is live").toContain("settings.view");
        expect(me.permissions, "the stored ops.cxone grant gives nothing").not.toContain("ops.cxone");
        for (const path of ["/api/admin/default-cxone", "/api/admin/cxone/withdrawals"]) {
          const r = await l.api.get(path);
          expect(r.status(), `${path}: ${(await r.text()).slice(0, 200)}`).toBe(403);
        }
        const put = await l.api.put("/api/admin/default-cxone", { headers: H(l.csrf), data: { cxone_group_name: "x" } });
        expect(put.status(), "nor may it replace the key").toBe(403);
      } finally { await l.api.dispose(); }
      const listed = (await json(await sa.get("/api/admin/roles"))).roles.find((r) => r.id === roleId);
      expect(listed.permissions, "the roles list shows what the role really holds").toEqual(["panel.access", "settings.view"]);
      // CONTROL: the superadmin reads both.
      for (const path of ["/api/admin/default-cxone", "/api/admin/cxone/withdrawals"]) {
        expect((await sa.get(path)).status(), `control ${path}`).toBe(200);
      }
    } finally { await sa.dispose(); }
  });
});

test.describe("a non-grantable grant stored on a custom role is removed once, and recorded", () => {
  // `_readRoleDef` already honours nothing of it; the boot migration in db.js
  // (`ungrantable_grants_pruned_at`) deletes the rows. Driven through db.js in a
  // throwaway DATA_DIR (every test server is a first boot, which has nothing to prune).
  test("the one shot deletes it and records it, keeps every other grant (CONTROL), and does not run again", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-prune-"));
    const dbPath = path.join(dir, "hackathon.db");
    const boot = () => {
      const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
      });
      expect(r.status, `db.js boot: ${r.stdout}${r.stderr}`).toBe(0);
    };
    const withDb = (fn, readonly = false) => { const d = new Database(dbPath, { readonly }); try { return fn(d); } finally { d.close(); } };
    const MARKER = "SELECT value FROM settings WHERE key='ungrantable_grants_pruned_at'";
    const perms = (id) => withDb(d => d.prepare("SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission").all(id).map(r => r.permission), true);
    const records = () => withDb(d => d.prepare("SELECT setting_key, event_type, changed_by, details FROM settings_events WHERE setting_key IN ('role:role_cxa','role:role_cxb') ORDER BY changed_at").all(), true);
    try {
      boot();
      expect(withDb(d => d.prepare(MARKER).get(), true), "a fresh database records the one shot, with nothing to do").toBeTruthy();
      // A database from before the ruling: no marker, one role holding the grant.
      withDb(d => {
        d.prepare("DELETE FROM settings WHERE key='ungrantable_grants_pruned_at'").run();
        const at = new Date().toISOString();
        const role = (id, list) => {
          d.prepare("INSERT INTO roles (id, label, description, builtin, scope_mode, rank, created_by_id, created_at, updated_at, version) VALUES (?,?,?,0,'all',1,NULL,?,?,1)").run(id, `Label ${id}`, "", at, at);
          for (const p of list) d.prepare("INSERT INTO role_permissions (role_id, permission) VALUES (?,?)").run(id, p);
        };
        role("role_cxa", ["settings.view", "ops.cxone", "ops.alerts"]);
        role("role_cxb", ["settings.view", "ops.alerts"]);
      });
      boot();
      expect(perms("role_cxa"), "the grant nothing honours is removed, the rest kept").toEqual(["ops.alerts", "settings.view"]);
      expect(perms("role_cxb"), "CONTROL: a role without it is untouched").toEqual(["ops.alerts", "settings.view"]);
      const rec = records();
      expect(rec.length, "one record, for the one role it changed").toBe(1);
      expect(rec[0]).toMatchObject({ setting_key: "role:role_cxa", event_type: "role_updated", changed_by: "system" });
      expect(JSON.parse(rec[0].details)).toEqual({ label: "Label role_cxa", permissions_removed: ["ops.cxone"], via: "superadmin_only_rule" });
      expect(withDb(d => d.prepare(MARKER).get(), true), "the marker is written").toBeTruthy();
      // A row written after the one shot is not touched by the next boot.
      withDb(d => d.prepare("INSERT INTO role_permissions (role_id, permission) VALUES ('role_cxb','ops.cxone')").run());
      boot();
      expect(perms("role_cxb"), "the next boot does not run it again").toEqual(["ops.alerts", "ops.cxone", "settings.view"]);
      expect(records().length).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
