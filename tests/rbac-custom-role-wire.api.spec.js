"use strict";

// CUSTOM ROLES ON THE WIRE — what the server tells the SPA about a custom role,
// and the class rule every account door applies to one.
//
//   1. the sign-in answer, GET /api/me (in both views) and GET /api/admin/me
//      carry `role_info`, and an admin-class role's `permissions`, so the SPA
//      decides the view switch, the role chip and its offers from the first
//      paint (a participant control carries no `permissions`);
//   2. a People row holding a custom role names it (`role_label`) and its scope
//      (`role_scope`); a built-in row carries neither;
//   3. an UNSCOPED custom-role account is a privileged target at every account
//      door — only a superadmin blocks, approves, denies, unlocks, mails a code
//      to or edits it — beside a scoped custom role a regular admin may act on
//      and a superadmin control;
//   4. `role_changed` records a custom role's label, both directions;
//   5. an organiser in Participant View reads their own guide (the docs gate
//      asks the account's live class, not the view), a participant does not,
//      and the superadmin guide stays an unscoped role's;
//   6. GET /api/admin/roles says per role what THIS session may give
//      (`can_give`) and take (`can_take`), by the role change's own
//      escalation rule, and the route agrees both ways.

const { test, expect, request } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, registerPost } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }
const HISTORY = (id) => `/api/admin/participants/${id}/events?paginated=1&limit=200`;
const details = (e) => (typeof e.details === "string" ? JSON.parse(e.details) : (e.details || {}));

test.describe("RBAC — custom roles on the wire", () => {
  let sa, saCsrf, allRole, grantedRole, allUser, grantedUser, plainUser, regAdmin, pendingAllUser;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    const mkRole = async (label, scope_mode, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label, scope_mode, permissions } });
      expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).role;
    };
    const stamp = Date.now();
    allRole = await mkRole(`Wire desk ${stamp}`, "all", ["participants.view"]);
    grantedRole = await mkRole(`Wire scoped ${stamp}`, "granted", ["events.view", "participants.view"]);
    const give = async (u, role) => {
      const r = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role } });
      expect(r.ok(), `assign ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
    };
    allUser = await makeParticipant(sa, saCsrf, "wireall");
    await give(allUser, allRole.id);
    grantedUser = await makeParticipant(sa, saCsrf, "wiregrant");
    await give(grantedUser, grantedRole.id);
    // An unscoped holder still WAITING for approval (registered, verified, not
    // approved), for the bulk approve, which passes over approved rows silently.
    {
      const email = `wire-pending-${stamp}@acme.com`;
      const anon = await request.newContext({ baseURL: BASE });
      try {
        const c = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
        const reg = await registerPost(anon, "/api/register", { headers: H(c), data: {
          email, password: PARTICIPANT_PASS, nickname: `wire_pending_${stamp}`.slice(0, 40),
          firstName: "Wire", lastName: "Pending", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" } });
        expect(reg.ok(), `register pending: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      } finally { await anon.dispose(); }
      const row = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
      expect(row, "PRECONDITION: the pending holder is listed").toBeTruthy();
      const v = await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(saCsrf) });
      expect(v.ok(), `verify pending: ${v.status()}`).toBeTruthy();
      pendingAllUser = { id: row.id, email };
      await give(pendingAllUser, allRole.id);
      const back = (await (await sa.get("/api/admin/participants?kind=all&limit=5000")).json()).participants.find(p => p.id === row.id);
      expect(back && back.verified && !back.approved, "PRECONDITION: verified and still waiting for approval").toBeTruthy();
    }
    plainUser = await makeParticipant(sa, saCsrf, "wireplain");
    regAdmin = await makeParticipant(sa, saCsrf, "wireadmin");
    const pr = await sa.post(`/api/admin/participants/${regAdmin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `promote admin: ${pr.status()}`).toBeTruthy();
  });

  test("the sign-in answer, /api/me in both views and /api/admin/me carry the role", async () => {
    const l = await apiLogin(allUser.email, PARTICIPANT_PASS);
    try {
      const want = { id: allRole.id, label: allRole.label, scope_mode: "all", builtin: false };
      expect(l.body.role_info, "the sign-in answer names the role").toEqual(want);
      expect(l.body.permissions).toEqual(["panel.access", "participants.view"]);

      const me = await json(await l.api.get("/api/me"));
      expect(me.isAdminView, "PRECONDITION: the account signed into admin view").toBe(true);
      expect(me.userRole).toBe(allRole.id);
      expect(me.role_info).toEqual(want);
      expect(me.permissions, "an admin-class role's permissions ride /api/me").toEqual(["panel.access", "participants.view"]);
      const adm = await json(await l.api.get("/api/admin/me"));
      expect(adm.role_info).toEqual(want);

      // Participant View: /api/admin/me is closed to the session, so /api/me is
      // the only way the SPA learns the account can switch back.
      const tg = await l.api.post("/api/toggle-admin-view", { headers: H(l.csrf), data: { mode: "participant" } });
      expect(tg.ok(), `toggle: ${tg.status()} ${await tg.text()}`).toBeTruthy();
      const me2 = await json(await l.api.get("/api/me"));
      expect(me2.isAdminView, "the session is in participant view now").toBe(false);
      expect(me2.role_info, "the role still rides /api/me in participant view").toEqual(want);
      expect(me2.permissions).toEqual(["panel.access", "participants.view"]);
      expect((await l.api.get("/api/admin/me")).status(), "control: the admin read is closed in this view").toBe(401);
    } finally { await l.api.dispose(); }

    // Control: a participant's answer names a role of scope `none` and carries
    // no permissions at all.
    const p = await apiLogin(plainUser.email, PARTICIPANT_PASS);
    try {
      expect(p.body.role_info).toEqual({ id: "participant", label: "Participant", scope_mode: "none", builtin: true });
      expect(p.body).not.toHaveProperty("permissions");
      const pme = await json(await p.api.get("/api/me"));
      expect(pme.role_info.scope_mode).toBe("none");
      expect(pme).not.toHaveProperty("permissions");
    } finally { await p.api.dispose(); }
  });

  test("a People row names a custom role and gives its class; a built-in row carries no label", async () => {
    const d = await json(await sa.get("/api/admin/participants?kind=all&limit=5000"));
    const row = (id) => d.participants.find(p => p.id === id);
    expect(row(allUser.id), "PRECONDITION: the unscoped holder is listed with kind=all").toBeTruthy();
    expect(row(allUser.id).role).toBe(allRole.id);
    expect(row(allUser.id).role_label).toBe(allRole.label);
    expect(row(allUser.id).role_class).toBe("all");
    expect(row(grantedUser.id).role_label).toBe(grantedRole.label);
    expect(row(grantedUser.id).role_class).toBe("granted");
    for (const id of [plainUser.id, regAdmin.id]) {
      expect(row(id), `PRECONDITION: built-in row ${id} listed`).toBeTruthy();
      expect(row(id), "a built-in role carries no label").not.toHaveProperty("role_label");
    }
    // The class is the server's for every row (the client never decides privilege from it alone).
    expect(row(plainUser.id).role_class, "CONTROL: a participant is class none").toBe("none");
    expect(row(regAdmin.id).role_class, "CONTROL: an admin is class all").toBe("all");
    // The scope MODE is not a row field: whether a row is out of reach is privileged_target.
    expect(row(allUser.id)).not.toHaveProperty("role_scope");
  });

  test("an unscoped custom-role account is a privileged target at every account door", async () => {
    const a = await apiLogin(regAdmin.email, PARTICIPANT_PASS);
    try {
      const h = H(a.csrf);
      const doors = [
        ["block", () => a.api.post(`/api/admin/participants/${allUser.id}/block`, { headers: h, data: { blocked: true } })],
        ["email code", () => a.api.post(`/api/admin/participants/${allUser.id}/login-code/email`, { headers: h })],
        ["unlock", () => a.api.post(`/api/admin/participants/${allUser.id}/unlock`, { headers: h })],
        ["deny", () => a.api.post(`/api/admin/participants/${allUser.id}/deny`, { headers: h, data: { reason: "x" } })],
        ["approve", () => a.api.post(`/api/admin/participants/${allUser.id}/approve`, { headers: h })],
        ["profile", () => a.api.put(`/api/admin/participants/${allUser.id}`, { headers: h, data: { secondaryEmail: `x-${Date.now()}@acme.com` } })],
        ["tag", () => a.api.post(`/api/admin/participants/${allUser.id}/tags`, { headers: h, data: { tag: "wire-x" } })],
      ];
      for (const [name, go] of doors) {
        const r = await go();
        expect(r.status(), `${name}: a regular admin is refused on an unscoped custom-role account (${await r.text()})`).toBe(403);
      }
      // The bulk approve skips such an account rather than failing the batch. It
      // passes over an already-approved row silently, so the holder here is one
      // still waiting for approval.
      const ba = await a.api.post("/api/admin/participants/bulk-approve", { headers: h, data: { userIds: [pendingAllUser.id] } });
      expect(ba.ok(), `bulk-approve: ${ba.status()}`).toBeTruthy();
      const bab = await json(ba);
      expect(bab.skippedPrivileged, `the bulk approve counts it as privileged (${JSON.stringify(bab)})`).toBe(1);
      expect(bab.approved, "and approves nobody").toBe(0);

      // Control: a SCOPED custom role is not a privileged target for a global admin.
      const ok = await a.api.post(`/api/admin/participants/${grantedUser.id}/block`, { headers: h, data: { blocked: true } });
      expect(ok.status(), `control: a regular admin blocks a scoped custom-role account (${await ok.text()})`).toBe(200);
      const back = await a.api.post(`/api/admin/participants/${grantedUser.id}/block`, { headers: h, data: { blocked: false } });
      expect(back.status()).toBe(200);
    } finally { await a.api.dispose(); }

    // Control: the superadmin acts on the unscoped account.
    const sb = await sa.post(`/api/admin/participants/${allUser.id}/block`, { headers: H(saCsrf), data: { blocked: true } });
    expect(sb.status(), `control: a superadmin blocks it (${await sb.text()})`).toBe(200);
    const su = await sa.post(`/api/admin/participants/${allUser.id}/block`, { headers: H(saCsrf), data: { blocked: false } });
    expect(su.status()).toBe(200);
    const sba = await sa.post("/api/admin/participants/bulk-approve", { headers: H(saCsrf), data: { userIds: [pendingAllUser.id] } });
    expect(sba.ok(), `control bulk-approve: ${sba.status()}`).toBeTruthy();
    expect((await json(sba)).approved, "control: a superadmin's bulk approve approves it").toBe(1);
  });

  test("role_changed records a custom role's label, both directions", async () => {
    const u = await makeParticipant(sa, saCsrf, "wirehist");
    const to = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: allRole.id } });
    expect(to.ok(), `to custom: ${to.status()}`).toBeTruthy();
    const back = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: "participant" } });
    expect(back.ok(), `back: ${back.status()}`).toBeTruthy();
    const ev = (await json(await sa.get(HISTORY(u.id)))).events.filter(e => e.event_type === "role_changed").map(details);
    const up = ev.find(d => d.to === allRole.id);
    const down = ev.find(d => d.from === allRole.id);
    expect(up, "PRECONDITION: the move into the custom role was recorded").toBeTruthy();
    expect(up.to_label).toBe(allRole.label);
    expect(up, "a built-in role carries no label").not.toHaveProperty("from_label");
    expect(down.from_label).toBe(allRole.label);
    expect(down).not.toHaveProperty("to_label");
  });

  test("an organiser in Participant View reads their own guide; a participant does not", async () => {
    const comp = await makeCompetition(sa, saCsrf, "wire-guide");
    const ea = await makeParticipant(sa, saCsrf, "wireguide");
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
    const l = await apiLogin(ea.email, PARTICIPANT_PASS);
    try {
      expect((await l.api.get("/docs/user-guide/event-admin.md")).status(), "control: the guide opens in admin view").toBe(200);
      const tg = await l.api.post("/api/toggle-admin-view", { headers: H(l.csrf), data: { mode: "participant" } });
      expect(tg.ok(), `toggle: ${tg.status()}`).toBeTruthy();
      expect((await json(await l.api.get("/api/me"))).isAdminView, "PRECONDITION: participant view").toBe(false);
      expect((await l.api.get("/docs/user-guide/event-admin.md")).status(), "the organiser's own guide still opens in participant view").toBe(200);
      expect((await l.api.get("/docs/user-guide/superadmin.md")).status(), "the superadmin guide stays an unscoped role's").toBe(401);
    } finally { await l.api.dispose(); }
    const p = await apiLogin(plainUser.email, PARTICIPANT_PASS);
    try {
      expect((await p.api.get("/docs/user-guide/event-admin.md")).status(), "a participant gets no gated guide").toBe(401);
      expect((await p.api.get("/docs/user-guide/participant.md")).status(), "control: the participant guide is open").toBe(200);
    } finally { await p.api.dispose(); }
  });

  test("the roles list says what this session may give and take, by the role change's own rule", async () => {
    // A role holding a superadmin-only permission (users.manage): its holder may
    // move an account OFF it (every permission is theirs) but may not GIVE it
    // (only a superadmin gives a superadmin-only permission) — the asymmetry
    // proves the two flags are two answers, not one.
    const stamp = Date.now();
    const rr = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `Role keeper ${stamp}`, scope_mode: "all", permissions: ["users.view", "users.manage"] } });
    expect(rr.ok(), `create: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    const keeper = (await rr.json()).role;
    const k1 = await makeParticipant(sa, saCsrf, "wirekeep1");
    const k2 = await makeParticipant(sa, saCsrf, "wirekeep2");
    const target = await makeParticipant(sa, saCsrf, "wirekeept");
    for (const u of [k1, k2]) {
      const g = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: keeper.id } });
      expect(g.ok(), `give keeper: ${g.status()}`).toBeTruthy();
    }
    const flags = async (api) => Object.fromEntries((await json(await api.get("/api/admin/roles"))).roles.map(r => [r.id, { give: r.can_give, take: r.can_take }]));

    // CONTROL: the superadmin may give and take every role.
    const sf = await flags(sa);
    for (const id of ["participant", "event_admin", "admin", "superadmin", keeper.id]) expect(sf[id], `superadmin: ${id}`).toEqual({ give: true, take: true });

    const a = await apiLogin(regAdmin.email, PARTICIPANT_PASS);
    try {
      const af = await flags(a.api);
      expect(af.superadmin, "a regular admin neither gives nor takes superadmin").toEqual({ give: false, take: false });
      expect(af.admin, "but may give and take admin (every permission is theirs)").toEqual({ give: true, take: true });
    } finally { await a.api.dispose(); }

    const k = await apiLogin(k1.email, PARTICIPANT_PASS);
    try {
      const kf = await flags(k.api);
      expect(kf[keeper.id], "its own role: taken off an account, never given").toEqual({ give: false, take: true });
      // The flags are the route's answer, both ways.
      const give = await k.api.patch(`/api/admin/users/${target.id}/role`, { headers: H(k.csrf), data: { role: keeper.id } });
      expect(give.status(), `giving it is refused (${await give.text()})`).toBe(403);
      expect((await json(give)).code).toBe("role_escalation");
      const take = await k.api.patch(`/api/admin/users/${k2.id}/role`, { headers: H(k.csrf), data: { role: "participant" } });
      expect(take.status(), `taking it off another holder is allowed (${await take.text()})`).toBe(200);
    } finally { await k.api.dispose(); }
  });
});
