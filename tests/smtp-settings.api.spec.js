// @ts-check
//
// SETTINGS → EMAIL (SMTP): WHO SEES THE MAIL SERVER AND WHO CHANGES IT
// (routes/smtp-settings.js; owner decision, 27 Nov 2026).
//
//   • every reader of Settings (settings.view) sees the relay in force and where
//     it comes from, with the password reduced to set / not set, never sent;
//   • only a superadmin changes it: `ops.smtp` is not grantable, so the built-in
//     admin and a custom role (even one holding every grantable Settings
//     permission) are refused the save, the removal and the test, and the role
//     form refuses to grant it; an event admin does not read it;
//   • a write is validated field by field, before anything is stored.
// Delivery, the live swap, encryption and the restore are held against real
// relays in tests/smtp-settings-delivery.spec.js.
const { test, expect } = require("./isolated-test");
const { PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

const U = {};
test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    U.admin = await makeParticipant(sa, csrf, "smtpadmin");
    const a = await sa.patch(`/api/admin/users/${U.admin.id}/role`, { headers: H(csrf), data: { role: "admin" } });
    expect(a.ok(), `admin role: ${await a.text()}`).toBeTruthy();
    // A custom role holding every GRANTABLE settings permission.
    const r = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `SMTP readers ${Date.now()}`, scope_mode: "all",
      permissions: ["settings.view", "settings.edit", "ops.email", "ops.alerts"] } });
    expect(r.ok(), `role: ${await r.text()}`).toBeTruthy();
    U.custom = await makeParticipant(sa, csrf, "smtpcustom");
    const c = await sa.patch(`/api/admin/users/${U.custom.id}/role`, { headers: H(csrf), data: { role: (await r.json()).role.id } });
    expect(c.ok(), `custom role: ${await c.text()}`).toBeTruthy();
    U.ea = await makeParticipant(sa, csrf, "smtpea");
    const comp = await makeCompetition(sa, csrf, "smtp-ea-event");
    await grantEventAdmin(sa, csrf, comp.id, U.ea.id);
  } finally { await sa.dispose(); }
});

const VALID = { host: "relay.acme.test", port: 587, security: "starttls", username: "", sender: "no-reply@acme.test" };

test("every Settings reader sees the relay in force and its source; only a superadmin may change it", async () => {
  const sa = await apiLogin("superadmin");
  const ad = await apiLogin(U.admin.email, PARTICIPANT_PASS);
  const cu = await apiLogin(U.custom.email, PARTICIPANT_PASS);
  try {
    // The shared test server's relay comes from its environment.
    for (const [who, s, canEdit] of [["superadmin", sa, true], ["admin", ad, false], ["custom role", cu, false]]) {
      const g = await s.api.get("/api/admin/smtp-settings");
      expect(g.status(), `${who}: ${await g.text()}`).toBe(200);
      const b = await g.json();
      expect(b.in_use.source, who).toBe("environment");
      expect(typeof b.in_use.host, who).toBe("string");
      expect(Number.isInteger(b.in_use.port), who).toBe(true);
      expect(typeof b.in_use.password_set, who).toBe("boolean");
      expect(Object.keys(b.in_use), `${who}: no password value in the shape`).not.toContain("password");
      expect(b.can_edit, who).toBe(canEdit);
      expect(g.headers()["cache-control"]).toBe("no-store");
    }
    // The writes: refused to both non-superadmin tiers, by permission.
    for (const [who, s] of [["admin", ad], ["custom role", cu]]) {
      for (const [m, p, data] of [
        ["put", "/api/admin/smtp-settings", { ...VALID, expectedVersion: null }],
        ["delete", "/api/admin/smtp-settings", { expectedVersion: null }],
        ["post", "/api/admin/smtp-settings/test", { ...VALID, to: "x@acme.test" }],
      ]) {
        const r = await s.api[m](p, { headers: H(s.csrf), data });
        expect(r.status(), `${who} ${m} ${p}: ${await r.text()}`).toBe(403);
        expect((await r.json()).permission, `${who} ${m} ${p}`).toBe("ops.smtp");
      }
    }
    // CONTROL: the same write reaches the superadmin's handler (refused on its
    // value, not its caller), so the refusals above are about the caller.
    const bad = await sa.api.put("/api/admin/smtp-settings", { headers: H(sa.csrf), data: { ...VALID, host: "bad host", expectedVersion: null } });
    expect(bad.status(), await bad.text()).toBe(400);
    expect((await bad.json()).field).toBe("host");
  } finally { for (const s of [sa, ad, cu]) await s.api.dispose(); }
});

test("an event admin does not read the mail server", async () => {
  const ea = await apiLogin(U.ea.email, PARTICIPANT_PASS);
  const sa = await apiLogin("superadmin");
  try {
    const r = await ea.api.get("/api/admin/smtp-settings");
    expect(r.status(), await r.text()).toBe(403);
    expect((await sa.api.get("/api/admin/smtp-settings")).status(), "CONTROL: the route answers a reader").toBe(200);
  } finally { await ea.api.dispose(); await sa.api.dispose(); }
});

test("ops.smtp cannot be granted to a custom role", async () => {
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `SMTP grant ${Date.now()}`, scope_mode: "all", permissions: ["settings.view", "ops.smtp"] } });
    expect(r.status(), await r.text()).toBe(400);
    expect((await r.json()).code).toBe("role_permission_not_grantable");
    const ok = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `SMTP grant ok ${Date.now()}`, scope_mode: "all", permissions: ["settings.view"] } });
    expect(ok.status(), `CONTROL: the same role without it is made: ${await ok.text()}`).toBe(200);
  } finally { await sa.api.dispose(); }
});

test("a save is validated field by field and nothing is stored when it is refused", async () => {
  const sa = await apiLogin("superadmin");
  try {
    const before = await (await sa.api.get("/api/admin/smtp-settings")).json();
    for (const [field, patch] of [
      ["host", { host: "" }], ["host", { host: "smtp://relay.acme.test" }], ["host", { host: "relay.acme.test:25" }], ["host", { host: ["a"] }],
      ["port", { port: 0 }], ["port", { port: 70000 }], ["port", { port: "25x" }], ["port", { port: 2.5 }],
      ["security", { security: "none" }], ["security", { security: undefined }],
      ["username", { username: "user\nname" }], ["username", { username: 7 }],
      ["password", { username: "u", password: "pa\u0000ss" }], ["password", { username: "u", password: { toString: 1 } }],
      ["sender", { sender: "Name <no-reply@acme.test>" }], ["sender", { sender: "no-reply" }], ["sender", { sender: "a@b@acme.test" }],
    ]) {
      const r = await sa.api.put("/api/admin/smtp-settings", { headers: H(sa.csrf), data: { ...VALID, ...patch, expectedVersion: null } });
      expect(r.status(), `${JSON.stringify(patch)}: ${await r.text()}`).toBe(400);
      const b = await r.json();
      expect(b.field, JSON.stringify(patch)).toBe(field);
      expect(b.code, JSON.stringify(patch)).toBe("smtp_field_invalid");
    }
    // A username with no password to keep (the shared relay has none): refused.
    const np = await sa.api.put("/api/admin/smtp-settings", { headers: H(sa.csrf), data: { ...VALID, username: "someone", expectedVersion: null } });
    expect(np.status(), await np.text()).toBe(400);
    expect((await np.json()).code).toBe("smtp_password_required");
    const after = await (await sa.api.get("/api/admin/smtp-settings")).json();
    expect(after, "nothing was stored").toEqual(before);
    // CONTROL: a valid save is accepted (and removed again, back to the environment).
    const ok = await sa.api.put("/api/admin/smtp-settings", { headers: H(sa.csrf), data: { ...VALID, expectedVersion: null } });
    expect(ok.status(), await ok.text()).toBe(200);
    const okb = await ok.json();
    expect(okb.in_use).toMatchObject({ source: "app", host: VALID.host, port: 587, security: "starttls", username: "", sender: VALID.sender, password_set: false });
    const del = await sa.api.delete("/api/admin/smtp-settings", { headers: H(sa.csrf), data: { expectedVersion: okb.version } });
    expect(del.status(), await del.text()).toBe(200);
    expect((await del.json()).in_use.source).toBe("environment");
  } finally { await sa.api.dispose(); }
});
