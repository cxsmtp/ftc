"use strict";

// AN ORGANISER'S OWN PANEL OPENS ONLY TO THE BUILT-IN GLOBAL ROLES — AT ENTRY,
// AT THE VIEW SWITCH AND ON EVERY READ INSIDE IT.
//
// A custom role of every event may hold View as a participant, and so may look
// at an event admin as a participant. Entry refuses it the organiser's own
// panel (`{view:"admin"}`); the view switch asked the acting role's CLASS
// instead, so the same role could enter the participant view and switch up into
// the organiser's seat, reading with the organiser's grants rather than its own.
// One predicate now decides all four places (lib/impersonation.js
// `organiserPanelOpensTo`). The panel's two live re-checks (requireAdmin and
// GET /api/admin/me) are driven by an OUT-OF-BAND role change (direct SQL,
// which writes no tombstone), so nothing but the re-check can end the panel.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }
const csrfOf = async (api) => (await (await api.get("/api/csrf-token")).json()).csrfToken;

test.describe("Impersonation — a custom role never takes an organiser's seat", () => {
  let sa, saCsrf, E, ea, role, viewer;
  const admins = [];

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    E = await makeCompetition(sa, saCsrf, "panelE");
    ea = await makeParticipant(sa, saCsrf, "panelea");
    await grantEventAdmin(sa, saCsrf, E.id, ea.id);
    const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: {
      label: `Viewer of every event ${Date.now()}`, scope_mode: "all",
      permissions: ["events.view", "participants.view", "participants.impersonate"] } });
    expect(r.ok(), `create role: ${r.status()} ${await r.text()}`).toBeTruthy();
    role = (await r.json()).role;
    viewer = await makeParticipant(sa, saCsrf, "panelviewer");
    const g = await sa.patch(`/api/admin/users/${viewer.id}/role`, { headers: H(saCsrf), data: { role: role.id } });
    expect(g.ok(), `assign role: ${g.status()} ${await g.text()}`).toBeTruthy();
    for (const label of ["paneladm1", "paneladm2", "paneladm3", "paneladm4"]) {
      const a = await makeParticipant(sa, saCsrf, label);
      const p = await sa.post(`/api/admin/participants/${a.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
      expect(p.ok(), `promote ${label}: ${p.status()} ${await p.text()}`).toBeTruthy();
      admins.push(a);
    }
  });

  test("the custom role views the organiser as a participant, but neither entry nor the view switch opens their panel; a built-in admin's switch does (CONTROL)", async () => {
    const s = await apiLogin(viewer.email);
    try {
      const asAdmin = await s.api.post(`/api/admin/participants/${ea.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
      expect(asAdmin.status(), `entry to the panel: ${await asAdmin.text()}`).toBe(403);
      expect((await json(asAdmin)).code).toBe("event_admin_forbidden");
      const asPart = await s.api.post(`/api/admin/participants/${ea.id}/impersonate`, { headers: H(s.csrf), data: { view: "participant" } });
      expect(asPart.status(), `PRECONDITION: the participant view is the role's to open: ${await asPart.text()}`).toBe(200);
      const up = await s.api.post("/api/toggle-admin-view", { headers: H(await csrfOf(s.api)), data: { mode: "admin" } });
      expect(up.status(), `the switch into the organiser's panel: ${await up.text()}`).toBe(403);
      const me = await json(await s.api.get("/api/me"));
      expect(me.isAdminView, "the session is still the participant view").toBe(false);
      expect((await s.api.get("/api/admin/me")).status(), "and no admin read opens to it").not.toBe(200);
    } finally { await s.api.dispose(); }

    const c = await apiLogin(admins[0].email);
    try {
      const asPart = await c.api.post(`/api/admin/participants/${ea.id}/impersonate`, { headers: H(c.csrf), data: { view: "participant" } });
      expect(asPart.status(), await asPart.text()).toBe(200);
      const up = await c.api.post("/api/toggle-admin-view", { headers: H(await csrfOf(c.api)), data: { mode: "admin" } });
      expect(up.status(), `CONTROL: a built-in admin switches into the panel: ${await up.text()}`).toBe(200);
      expect((await json(up)).isAdmin).toBe(true);
    } finally { await c.api.dispose(); }
  });

  test("the panel ends on its next read once the acting admin's role becomes a custom one, at both live re-checks; an unchanged admin keeps it (CONTROL)", async () => {
    const enter = async (who) => {
      const s = await apiLogin(who.email);
      const imp = await s.api.post(`/api/admin/participants/${ea.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
      expect(imp.status(), `enter the organiser's panel: ${await imp.text()}`).toBe(200);
      expect((await s.api.get("/api/admin/me")).status(), "PRECONDITION: the panel reads").toBe(200);
      return s;
    };
    const s2 = await enter(admins[1]);
    const s3 = await enter(admins[2]);
    const s4 = await enter(admins[3]);
    try {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      try {
        const up = db.prepare("UPDATE users SET role=? WHERE id=?");
        up.run(role.id, admins[1].id);
        up.run(role.id, admins[2].id);
      } finally { db.close(); }
      const me2 = await s2.api.get("/api/admin/me");
      expect(me2.status(), `GET /api/admin/me after the change: ${await me2.text()}`).not.toBe(200);
      expect((await s2.api.get("/api/admin/me")).status(), "the session is gone, not merely refused once").not.toBe(200);
      const list3 = await s3.api.get(`/api/admin/competitions/${E.id}/admins`);
      expect(list3.status(), `an admin read through requireAdmin after the change: ${await list3.text()}`).not.toBe(200);
      expect((await s3.api.get("/api/admin/me")).status(), "and the session is gone").not.toBe(200);
      const me4 = await s4.api.get("/api/admin/me");
      expect(me4.status(), `CONTROL: an admin whose role did not change keeps the panel: ${await me4.text()}`).toBe(200);
    } finally {
      for (const s of [s2, s3, s4]) await s.api.dispose();
    }
  });
});
