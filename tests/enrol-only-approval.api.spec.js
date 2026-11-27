// SWEEP #501 (operator rulings, 23 Nov 2026) — AN INVITATION APPROVES ONLY
// THROUGH AN INVITER WHO MAY APPROVE.
//
// While "Require account approval" is on, an account made through an invitation
// from a role that holds `participants.enrol` but not `participants.approve`
// (only a custom role can) WAITS for approval, as any held sign-up does: it
// claims nothing (the invitation stays live) and is enrolled nowhere; once an
// administrator approves it, its first emailed-code sign-in claims the
// invitation. The inviter's permission is read when the invitation is USED, and
// an inviter who is gone counts as unable to approve. Meanwhile "the organisers
// should see who's waiting FOR THEIR EVENTS ONLY": People lists the account to
// the organisers of the events the invitation names, with those events, and to
// nobody else scoped. Such a role's desk sign-up is refused with the reason (a
// desk code never approves, so the account could not sign in).
//
// Every arm has its control: an approving role's invitee, approval off, a
// built-in event admin at the desk, another event's organiser.
const { test, expect } = require("./isolated-test");
const { freshCtx, apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const addr = (tag) => `${tag}-${Date.now()}-${++seq}@enrol-only.example`;
const FORM = { firstName: "Ada", lastName: "Waiting", company: "Analytical", title: "Engineer", country: "GB", timezone: "Europe/London" };
const DESK_SENTENCE = "New accounts wait for approval on this platform, and your role cannot approve them, so an account made at the desk could not sign in. Use Invite instead (they then wait for approval), or ask an administrator.";

/** Prove `email` and register through the real doors; the registration's answer. */
async function register(email) {
  const { api, csrf } = await freshCtx();
  try {
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    const c = await (await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email))).json();
    expect(c && c.via, `PRECONDITION: a proof was mailed to ${email}`).toBe("proof");
    const rd = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code: c.code } });
    expect((await rd.json()).ok).toBe(true);
    const t = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const r = await api.post("/api/register", { headers: H(t), data: { ...FORM, email } });
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  } finally { await api.dispose(); }
}
const userRow = (email) => sql(db => db.prepare("SELECT id, approved, approved_by, invitation_id FROM users WHERE LOWER(email)=LOWER(?)").get(email));
const invRow = (email) => sql(db => db.prepare("SELECT id, used_at, user_id, invited_by, invited_by_id FROM invitations WHERE LOWER(email)=LOWER(?) ORDER BY created_at DESC LIMIT 1").get(email));
const memberships = (userId) => sql(db => db.prepare("SELECT COUNT(*) n FROM competition_users WHERE user_id=?").get(userId).n);
const approvedEvents = (userId) => sql(db => db.prepare("SELECT COUNT(*) n FROM user_events WHERE user_id=? AND event_type='approved'").get(userId).n);

test.describe("sweep #501 — while approval is on, an invitation from a role that cannot approve makes a waiting account", () => {
  let sa, saCsrf, comp, other, roles = {}, org, orgOther, approver;

  async function asRole(label, key) {
    const u = await makeParticipant(sa, saCsrf, label);
    const g = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: roles[key].id } });
    expect(g.ok(), `give ${key}: ${await g.text()}`).toBeTruthy();
    return u;
  }
  async function setApproval(on) {
    const r = await sa.patch("/api/admin/settings", { headers: H(saCsrf), data: { require_account_approval: on } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  async function invite(who, email, compIds) {
    const s = await apiLogin(who.email);
    try {
      const r = await s.api.post("/api/admin/invitations", { headers: H(s.csrf), data: { emails: [email], competitionIds: compIds } });
      expect(r.ok(), `invite ${email}: ${await r.text()}`).toBeTruthy();
    } finally { await s.api.dispose(); }
    const inv = invRow(email);
    expect(inv && inv.used_at, `PRECONDITION: a live invitation for ${email}`).toBe(null);
    return inv;
  }

  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "eo501");
    other = await makeCompetition(sa, saCsrf, "eo501other");
    const mkRole = async (key, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `EO501 ${key} ${Date.now()}`, scope_mode: "granted", permissions } });
      expect(r.ok(), await r.text()).toBeTruthy();
      roles[key] = (await r.json()).role;
    };
    await mkRole("enrol", ["events.view", "participants.view", "participants.enrol"]);
    await mkRole("approve", ["events.view", "participants.view", "participants.enrol", "participants.approve"]);
    org = await asRole("eo501org", "enrol");
    await grantEventAdmin(sa, saCsrf, comp.id, org.id);
    orgOther = await asRole("eo501orgx", "enrol");
    await grantEventAdmin(sa, saCsrf, other.id, orgOther.id);
    approver = await asRole("eo501appr", "approve");
    await grantEventAdmin(sa, saCsrf, comp.id, approver.id);
  });

  test("the account waits, enrolled nowhere, its invitation live; an approving role's invitee and approval off are approved (controls)", async () => {
    await setApproval(true);
    try {
      const a = addr("held");
      const inv = await invite(org, a, [comp.id]);
      expect(inv.invited_by_id, "the invitation names the inviting account").toBe(org.id);
      const body = await register(a);
      expect(body).toMatchObject({ ok: true, pendingApproval: true });
      const u = userRow(a);
      expect(u).toMatchObject({ approved: 0, approved_by: null, invitation_id: inv.id });
      expect(invRow(a).used_at, "the invitation is still live").toBe(null);
      expect(memberships(u.id), "enrolled nowhere while it waits").toBe(0);
      expect(approvedEvents(u.id)).toBe(0);
      // CONTROL: a role that may approve.
      const b = addr("byapprover");
      await invite(approver, b, [comp.id]);
      expect((await register(b)).pendingApproval).toBeUndefined();
      const ub = userRow(b);
      expect(ub).toMatchObject({ approved: 1, approved_by: "invitation" });
      expect(memberships(ub.id)).toBe(1);
    } finally { await setApproval(false); }
    // CONTROL: approval off, the same role's invitee is approved as before.
    const c = addr("off");
    await invite(org, c, [comp.id]);
    expect((await register(c)).pendingApproval).toBeUndefined();
    expect(userRow(c).approved).toBe(1);
  });

  test("the inviter's permission is read when the invitation is used: lost since, it waits; gained since, it is approved; an inviter gone, or named only by the old default, waits", async () => {
    const x = await asRole("eo501lost", "approve");
    await grantEventAdmin(sa, saCsrf, comp.id, x.id);
    const y = await asRole("eo501gain", "enrol");
    await grantEventAdmin(sa, saCsrf, comp.id, y.id);
    const z = await asRole("eo501gone", "approve");
    await grantEventAdmin(sa, saCsrf, comp.id, z.id);
    const bLost = addr("lost"), eGain = addr("gain"), cGone = addr("gone"), dLegacy = addr("legacy");
    await invite(x, bLost, [comp.id]);
    await invite(y, eGain, [comp.id]);
    await invite(z, cGone, [comp.id]);
    const dInv = await invite(approver, dLegacy, [comp.id]);
    // Since the invitations were made:
    expect((await sa.patch(`/api/admin/users/${x.id}/role`, { headers: H(saCsrf), data: { role: roles.enrol.id } })).ok()).toBeTruthy();
    expect((await sa.patch(`/api/admin/users/${y.id}/role`, { headers: H(saCsrf), data: { role: roles.approve.id } })).ok()).toBeTruthy();
    const del = await sa.delete(`/api/admin/participants/${z.id}`, { headers: H(saCsrf) });
    expect(del.ok(), await del.text()).toBeTruthy();
    sql(db => db.prepare("UPDATE invitations SET invited_by='admin', invited_by_id=NULL WHERE id=?").run(dInv.id));
    await setApproval(true);
    try {
      expect((await register(bLost)).pendingApproval, "the inviter lost the permission: it waits").toBe(true);
      expect((await register(eGain)).pendingApproval, "CONTROL: the inviter gained it: approved").toBeUndefined();
      expect((await register(cGone)).pendingApproval, "the inviter is gone: it waits").toBe(true);
      expect((await register(dLegacy)).pendingApproval, "an invitation naming nobody: it waits").toBe(true);
    } finally { await setApproval(false); }
  });

  test("an invitation made before the inviter was recorded by account is judged by its inviter's address: an approver's is approved, an enrol-only role's waits", async () => {
    const a = addr("legacyok"), b = addr("legacywait");
    const ia = await invite(approver, a, [comp.id]);
    const ib = await invite(org, b, [comp.id]);
    // As an invitation from before 9.2.8 reads: the inviter's address, no account id.
    sql(db => db.prepare("UPDATE invitations SET invited_by_id=NULL WHERE id IN (?,?)").run(ia.id, ib.id));
    expect(invRow(a), "PRECONDITION: named by the approver's address alone").toMatchObject({ invited_by: approver.email, invited_by_id: null });
    expect(invRow(b), "PRECONDITION: named by the enrol-only role's address alone").toMatchObject({ invited_by: org.email, invited_by_id: null });
    await setApproval(true);
    try {
      expect((await register(a)).pendingApproval, "the approver's address: approved").toBeUndefined();
      expect(userRow(a)).toMatchObject({ approved: 1, approved_by: "invitation" });
      expect((await register(b)).pendingApproval, "the enrol-only role's address: it waits").toBe(true);
      expect(userRow(b).approved).toBe(0);
    } finally { await setApproval(false); }
  });

  test("someone who may approve inviting the address again makes the live invitation theirs: the invitee is approved; an enrol-only role's re-invite of an approver's invitation changes nothing (CONTROL)", async () => {
    const w = addr("reinvite");
    const first = await invite(org, w, [comp.id]);
    expect(first.invited_by_id, "PRECONDITION: the enrol-only role's invitation").toBe(org.id);
    // The approver invites the same address to the SAME event: nothing to add.
    const s = await apiLogin(approver.email);
    try {
      const r = await s.api.post("/api/admin/invitations", { headers: H(s.csrf), data: { emails: [w], competitionIds: [comp.id] } });
      expect(r.ok(), await r.text()).toBeTruthy();
    } finally { await s.api.dispose(); }
    const now = invRow(w);
    expect(now.id, "the same live invitation").toBe(first.id);
    expect(now, "now the approver's").toMatchObject({ invited_by: approver.email, invited_by_id: approver.id });
    const summary = sql(db => db.prepare("SELECT details FROM orphan_events WHERE event_type='batch_sent' ORDER BY rowid DESC LIMIT 1").get());
    expect(JSON.parse(summary.details).inviter_replaced, "recorded on the batch's summary").toBe(1);
    await setApproval(true);
    try {
      expect((await register(w)).pendingApproval, "an approver asked for it: approved").toBeUndefined();
      expect(userRow(w)).toMatchObject({ approved: 1, approved_by: "invitation" });
    } finally { await setApproval(false); }
    // CONTROL: the other way round, the approver's invitation stays theirs.
    const v = addr("reinvitectl");
    await invite(approver, v, [comp.id]);
    const s2 = await apiLogin(org.email);
    try {
      const r = await s2.api.post("/api/admin/invitations", { headers: H(s2.csrf), data: { emails: [v], competitionIds: [comp.id] } });
      expect(r.ok(), await r.text()).toBeTruthy();
    } finally { await s2.api.dispose(); }
    expect(invRow(v), "CONTROL: still the approver's").toMatchObject({ invited_by: approver.email, invited_by_id: approver.id });
    // CONTROL: a role that cannot approve, re-inviting another such role's
    // invitation (to its own event), takes nothing over.
    const u = addr("reinvitenon");
    await invite(org, u, [comp.id]);
    const s3 = await apiLogin(orgOther.email);
    try {
      const r = await s3.api.post("/api/admin/invitations", { headers: H(s3.csrf), data: { emails: [u], competitionIds: [other.id] } });
      expect(r.ok(), await r.text()).toBeTruthy();
    } finally { await s3.api.dispose(); }
    expect(invRow(u), "CONTROL: still the first inviter's").toMatchObject({ invited_by: org.email, invited_by_id: org.id });
  });

  test("a waiting invitee is listed to the organisers of the invitation's events only, named with those events; an administrator approves, and the first sign-in joins the event", async () => {
    const w = addr("waiting");
    let u;
    await setApproval(true);
    try {
      await invite(org, w, [comp.id]);
      expect((await register(w)).pendingApproval).toBe(true);
      u = userRow(w);
      const listOf = async (who) => {
        const s = who === "superadmin" ? { api: sa } : await apiLogin(who.email);
        try {
          const r = await s.api.get("/api/admin/participants?limit=5000");
          expect(r.ok(), await r.text()).toBeTruthy();
          return await r.json();
        } finally { if (who !== "superadmin") await s.api.dispose(); }
      };
      for (const who of [org, approver]) {
        const body = await listOf(who);
        const row = body.participants.find(p => p.id === u.id);
        expect(row, `listed to an organiser of the invitation's event (${who.email})`).toBeTruthy();
        expect(row.waiting_for).toEqual([{ id: comp.id, name: comp.name }]);
        expect(row.competitions).toEqual([]);
      }
      const foreign = await listOf(orgOther);
      expect(JSON.stringify(foreign), "another event's organiser is told nothing about them").not.toContain(w.toLowerCase());
      const all = (await listOf("superadmin")).participants.find(p => p.id === u.id);
      expect(all.waiting_for, "CONTROL: an administrator sees them, with the event").toEqual([{ id: comp.id, name: comp.name }]);
      // An organiser who may approve cannot approve them here (not in their events).
      const ap = await apiLogin(approver.email);
      try {
        const r = await ap.api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(ap.csrf) });
        expect(r.status(), "only an administrator approves a waiting invitee").toBe(403);
      } finally { await ap.api.dispose(); }
      expect(userRow(w).approved).toBe(0);
      // Before approval the code says so and claims nothing.
      const { api, csrf } = await freshCtx();
      await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
      await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: w } });
      const c1 = await (await api.get("/api/test/last-login-code?email=" + encodeURIComponent(w))).json();
      const early = await (await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email: w, code: c1.code } })).json();
      expect(early).toMatchObject({ ok: false, error: "pending_approval" });
      expect(invRow(w).used_at).toBe(null);
      await api.dispose();
    } finally { await setApproval(false); }
    const okA = await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
    expect(okA.ok(), await okA.text()).toBeTruthy();
    const s = await apiLogin(w);
    await s.api.dispose();
    expect(invRow(w).user_id, "the first sign-in claims the invitation").toBe(u.id);
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, u.id).n),
      "and joins its event").toBe(1);
  });

  test("an invitation naming two events: each event's organiser is shown the waiting invitee with only their own event named", async () => {
    const w = addr("twoevents");
    await setApproval(true);
    try {
      await invite(org, w, [comp.id]);
      expect((await register(w)).pendingApproval).toBe(true);
    } finally { await setApproval(false); }
    const u = userRow(w);
    // The invitation also names the other organiser's event (an administrator's
    // invitation can name several events; its inviter stays the enrol-only role).
    sql(db => db.prepare("UPDATE invitations SET competition_ids=? WHERE id=?").run(JSON.stringify([comp.id, other.id]), u.invitation_id));
    const rowFor = async (who) => {
      const s = await apiLogin(who.email);
      try {
        const body = await (await s.api.get("/api/admin/participants?limit=5000")).json();
        return { row: body.participants.find(p => p.id === u.id), blob: JSON.stringify(body) };
      } finally { await s.api.dispose(); }
    };
    const a = await rowFor(org);
    expect(a.row.waiting_for, "the organiser of the first event is named only theirs").toEqual([{ id: comp.id, name: comp.name }]);
    expect(a.blob, "nor is the other event named anywhere in their answer").not.toContain(other.name);
    const b = await rowFor(orgOther);
    expect(b.row.waiting_for, "the other event's organiser is named only theirs").toEqual([{ id: other.id, name: other.name }]);
    const all = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.id === u.id);
    expect(all.waiting_for.map(c => c.id).sort(), "CONTROL: an administrator is named both").toEqual([comp.id, other.id].sort());
  });

  test("the desk sign-up is refused to such a role while approval is on, before the address is looked at; approval off and a built-in event admin are served (controls)", async () => {
    const s = await apiLogin(org.email);
    const desk = (email) => s.api.post("/api/admin/participants/desk-invite", { headers: H(s.csrf), data: { email, firstName: "Desk", lastName: "Walkup", competitionId: comp.id } });
    try {
      await setApproval(true);
      try {
        const e1 = addr("desk");
        const r = await desk(e1);
        expect(r.status()).toBe(403);
        expect(await r.json()).toEqual({ error: DESK_SENTENCE, code: "desk_approval_required" });
        expect(userRow(e1), "nothing was created").toBeUndefined();
        // An address already in use gets the same refusal, never the duplicate's.
        const taken = await desk(org.email);
        expect(taken.status()).toBe(403);
        expect((await taken.json()).code).toBe("desk_approval_required");
        // CONTROL: a built-in event admin (who holds the permission) is served.
        const ea = await makeParticipant(sa, saCsrf, "eo501ea");
        await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
        const es = await apiLogin(ea.email);
        try {
          const ok = await es.api.post("/api/admin/participants/desk-invite", { headers: H(es.csrf), data: { email: addr("deskea"), firstName: "Desk", lastName: "Walkup", competitionId: comp.id } });
          expect(ok.status(), await ok.text()).toBe(200);
        } finally { await es.api.dispose(); }
      } finally { await setApproval(false); }
      // CONTROL: approval off, the same role is served.
      const e2 = addr("deskoff");
      const r2 = await desk(e2);
      expect(r2.status(), await r2.text()).toBe(200);
      expect(userRow(e2).approved).toBe(1);
    } finally { await s.api.dispose(); }
  });
});
