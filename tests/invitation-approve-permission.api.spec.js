"use strict";

// An invitation to an existing, verified, unapproved account approves it. That
// is the same write as POST …/participants/:id/approve, so it needs the same
// permission: a custom role that may invite (participants.enrol) but not
// approve (participants.approve) leaves the account pending and counts it as
// skippedUnapproved. Control: a built-in event admin, who holds the approval
// permission, approves the same kind of account through the same door.

const { test, expect, request } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, registerPost, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, grantEventAdmin, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/** Registered and verified, never approved. */
async function makePending(sa, saCsrf, label) {
  const tag = uniq(label);
  const email = `inv-pend-${tag}@acme.com`;
  const anon = await request.newContext({ baseURL: BASE });
  try {
    const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", {
      headers: H(csrf),
      data: {
        email, password: PARTICIPANT_PASS,
        nickname: `ip_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
        firstName: "Pending", lastName: String(label), company: "Acme", title: "Engineer",
        country: "GB", timezone: "Europe/London",
      },
    });
    expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  } finally { await anon.dispose(); }
  const row = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
  expect(row, `${label} is listed`).toBeTruthy();
  const v = await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(saCsrf) });
  expect(v.ok(), `verify ${label}: ${v.status()}`).toBeTruthy();
  const after = await approvedOf(sa, row.id);
  expect(after, `precondition: ${label} is verified but not approved`).toBe(0);
  return { id: row.id, email };
}

async function approvedOf(sa, id) {
  const row = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.id === id);
  return row ? Number(row.approved) : null;
}

test.describe("invitation auto-approve asks for the approval permission", () => {
  let sa, saCsrf, comp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    sa = s.api; saCsrf = s.csrf;
    comp = await makeCompetition(sa, saCsrf, "inv-approve");
  });

  test("a role that may invite but not approve leaves the account pending", async () => {
    const role = await sa.post("/api/admin/roles", {
      headers: H(saCsrf),
      data: { label: `Inviter ${Date.now()}`, scope_mode: "granted", permissions: ["events.view", "participants.view", "participants.enrol"] },
    });
    expect(role.ok(), `create role: ${role.status()} ${await role.text()}`).toBeTruthy();
    const roleId = (await role.json()).role.id;
    const inviter = await makeParticipant(sa, saCsrf, "inviter");
    const pr = await sa.patch(`/api/admin/users/${inviter.id}/role`, { headers: H(saCsrf), data: { role: roleId } });
    expect(pr.ok(), `assign role: ${pr.status()} ${await pr.text()}`).toBeTruthy();
    await grantEventAdmin(sa, saCsrf, comp.id, inviter.id);

    const target = await makePending(sa, saCsrf, "no-approve");
    const l = await apiLogin(inviter.email, PARTICIPANT_PASS);
    const r = await l.api.post("/api/admin/invitations", {
      headers: H(l.csrf), data: { emails: [target.email], competitionIds: [comp.id] },
    });
    expect(r.ok(), `invite: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    expect(body.skippedUnapproved, "the account is counted as left pending").toBe(1);
    expect(await approvedOf(sa, target.id), "the account is still not approved").toBe(0);
    await l.api.dispose();
  });

  test("control: a built-in event admin approves the same kind of account", async () => {
    const ea = await makeParticipant(sa, saCsrf, "ea-inviter");
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
    const target = await makePending(sa, saCsrf, "with-approve");
    const l = await apiLogin(ea.email, PARTICIPANT_PASS);
    const r = await l.api.post("/api/admin/invitations", {
      headers: H(l.csrf), data: { emails: [target.email], competitionIds: [comp.id] },
    });
    expect(r.ok(), `invite: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).skippedUnapproved).toBe(0);
    expect(await approvedOf(sa, target.id), "the event admin's invitation approves").toBe(1);
    await l.api.dispose();
  });

  test("a COMPETING admin's invitation leaves a rival pending; the same invitation approves a non-rival (CONTROL)", async () => {
    // The auto-approve is the approve door, so it asks the rival question too
    // (lib/staff-compete.js competitorRivalDenied): a competitor never approves
    // somebody on the board they compete on.
    const Database = require("better-sqlite3");
    const approvedNow = (id) => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT approved FROM users WHERE id=?").get(id).approved; } finally { d.close(); } };
    const compete = await makeCompetition(sa, saCsrf, "inv-rival", { staff_compete: true });
    const actor = await makeParticipant(sa, saCsrf, "inv-rival-actor");
    const rival = await makeParticipant(sa, saCsrf, "inv-rival-target");
    await enrol(sa, saCsrf, compete.id, [actor.id, rival.id]);
    const pr = await sa.post(`/api/admin/participants/${actor.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `make admin: ${await pr.text()}`).toBeTruthy();
    // The rival waits for approval while it holds its row (an approval taken
    // back by hand), so only the rival question can keep it pending.
    { const d = new Database(TEST_DB_PATH); try { d.prepare("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?").run(rival.id); } finally { d.close(); } }
    expect(approvedNow(rival.id), "PRECONDITION: the rival is pending").toBe(0);
    const other = await makePending(sa, saCsrf, "inv-nonrival");
    const l = await apiLogin(actor.email, PARTICIPANT_PASS);
    try {
      // The invitation names an event the actor does not compete in.
      const r = await l.api.post("/api/admin/invitations", {
        headers: H(l.csrf), data: { emails: [rival.email, other.email], competitionIds: [comp.id] },
      });
      expect(r.ok(), `invite: ${r.status()} ${await r.text()}`).toBeTruthy();
      expect((await r.json()).skippedUnapproved, "the rival is counted as left pending").toBe(1);
      expect(approvedNow(rival.id), "a competitor's invitation does not approve a rival").toBe(0);
      expect(approvedNow(other.id), "CONTROL: the same invitation approves a non-rival").toBe(1);
    } finally { await l.api.dispose(); }
  });

  test("a REGULAR admin's invitation leaves a pending PRIVILEGED account pending (a custom role on every event, or one holding what the admin lacks); a superadmin's approves it (CONTROL)", async () => {
    // The auto-approve is the approve door, so it asks the approve door's peer
    // rule too (lib/rbac.js privilegedTargetFor): POST …/:id/approve refuses a
    // regular admin on these accounts, and a file of addresses must not do what
    // the button may not.
    const Database = require("better-sqlite3");
    const approvedNow = (id) => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT approved FROM users WHERE id=?").get(id).approved; } finally { d.close(); } };
    const mkRole = async (label, scope_mode, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${uniq("r")}`, scope_mode, permissions } });
      expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).role.id;
    };
    const roleAll = await mkRole("Inv desk lead", "all", ["participants.view"]);
    const roleGranted = await mkRole("Inv scoped deleter", "granted", ["events.view", "events.delete"]);
    // A verified account holding the role, waiting for approval (the approval
    // taken back by hand, as the rival arm does: an approved account is what the
    // role route needs to give it the role).
    const pendingHolder = async (label, roleId) => {
      const u = await makeParticipant(sa, saCsrf, label);
      const g = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: roleId } });
      expect(g.ok(), `give ${label} its role: ${g.status()} ${await g.text()}`).toBeTruthy();
      { const d = new Database(TEST_DB_PATH); try { d.prepare("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?").run(u.id); } finally { d.close(); } }
      expect(approvedNow(u.id), `PRECONDITION: ${label} is pending`).toBe(0);
      return u;
    };
    const allHolder = await pendingHolder("inv-priv-all", roleAll);
    const grantedHolder = await pendingHolder("inv-priv-gr", roleGranted);
    const plain = await makePending(sa, saCsrf, "inv-priv-plain");

    const admin = await makeParticipant(sa, saCsrf, "inv-priv-admin");
    const pr = await sa.post(`/api/admin/participants/${admin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `make admin: ${await pr.text()}`).toBeTruthy();
    const l = await apiLogin(admin.email, PARTICIPANT_PASS);
    try {
      // The approve door itself refuses this admin on both accounts.
      for (const u of [allHolder, grantedHolder]) {
        const door = await l.api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(l.csrf) });
        expect(door.status(), `PRECONDITION: the approve door refuses the regular admin: ${await door.text()}`).toBe(403);
      }
      const r = await l.api.post("/api/admin/invitations", {
        headers: H(l.csrf), data: { emails: [allHolder.email, grantedHolder.email, plain.email], competitionIds: [comp.id] },
      });
      expect(r.ok(), `invite: ${r.status()} ${await r.text()}`).toBeTruthy();
      expect((await r.json()).skippedUnapproved, "both privileged accounts are counted as left pending").toBe(2);
      expect(approvedNow(allHolder.id), "a custom role on every event stays pending").toBe(0);
      expect(approvedNow(grantedHolder.id), "a role holding what the admin lacks stays pending").toBe(0);
      expect(approvedNow(plain.id), "CONTROL: the same invitation approves a participant").toBe(1);
    } finally { await l.api.dispose(); }

    // CONTROL: a superadmin's invitation approves the same kind of account.
    const r2 = await sa.post("/api/admin/invitations", {
      headers: H(saCsrf), data: { emails: [allHolder.email, grantedHolder.email], competitionIds: [comp.id] },
    });
    expect(r2.ok(), `superadmin invite: ${r2.status()} ${await r2.text()}`).toBeTruthy();
    expect((await r2.json()).skippedUnapproved).toBe(0);
    expect(approvedNow(allHolder.id), "the superadmin's invitation approves the custom role on every event").toBe(1);
    expect(approvedNow(grantedHolder.id), "…and the role holding events.delete").toBe(1);
  });
});

// AN ORGANISER'S INVITATION APPROVES ONLY AN ACCOUNT IT MAKES THEIRS (sweep
// #340). The auto-approve is the approve door, and for an actor scoped to their
// events that door asks the scope question too (lib/event-admin.js
// participantDenied): the account must be a participant in one of their events.
// So the approval is written once the enrolment has run, and only if the account
// now belongs to one of their events; one whose every enrolment was skipped stays
// pending and is reported in `leftPending`. A global admin's invitation is
// unchanged (the CONTROLS).
test.describe("an organiser's invitation approves only an account it puts into one of their events", () => {
  const Database = require("better-sqlite3");
  const one = (q, ...a) => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(q).get(...a); } finally { d.close(); } };
  const write = (q, ...a) => { const d = new Database(TEST_DB_PATH); try { return d.prepare(q).run(...a); } finally { d.close(); } };
  const approvedNow = (id) => one("SELECT approved FROM users WHERE id=?", id).approved;
  const inEvent = (compId, id) => !!one("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?", compId, id);
  const approvals = (id) => one("SELECT COUNT(*) AS n FROM user_events WHERE user_id=? AND event_type='approved'", id).n;
  let sa, saCsrf, A, org;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    sa = s.api; saCsrf = s.csrf;
    A = await makeCompetition(sa, saCsrf, "inv-scope-a");
    org = await makeParticipant(sa, saCsrf, "inv-scope-org");
    await grantEventAdmin(sa, saCsrf, A.id, org.id);
  });
  test.afterAll(async () => { await sa.dispose(); });

  const staffTag = async (id) => {
    const r = await sa.post(`/api/admin/participants/${id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
    expect(r.ok(), `staff tag: ${await r.text()}`).toBeTruthy();
  };

  test("an account whose only enrolment is skipped stays pending and is reported; one the invitation enrols is approved (CONTROL)", async () => {
    const staff = await makePending(sa, saCsrf, "inv-scope-staff");
    await staffTag(staff.id);
    const plain = await makePending(sa, saCsrf, "inv-scope-plain");
    // The sign-up's own record (the registerPost fixture rewinds the account to
    // pending afterwards) stays: what matters is that no new one is written.
    const recorded = approvals(staff.id);
    const l = await apiLogin(org.email, PARTICIPANT_PASS);
    try {
      const door = await l.api.post(`/api/admin/participants/${staff.id}/approve`, { headers: H(l.csrf) });
      expect(door.status(), `PRECONDITION: the Approve button refuses this organiser: ${await door.text()}`).toBe(403);
      const r = await l.api.post("/api/admin/invitations", { headers: H(l.csrf), data: { emails: [staff.email, plain.email], competitionIds: [A.id] } });
      expect(r.ok(), `invite: ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      expect(body.skippedStaff, "PRECONDITION: the staff spectator's enrolment is skipped").toBe(1);
      expect(body.leftPending, "the account left waiting is reported").toEqual([staff.email.toLowerCase()]);
      expect(approvedNow(staff.id), "…and stays pending").toBe(0);
      expect(approvals(staff.id), "…with no approval recorded").toBe(recorded);
      expect([approvedNow(plain.id), inEvent(A.id, plain.id)], "CONTROL: the account the invitation enrols is approved").toEqual([1, true]);
    } finally { await l.api.dispose(); }
    // CONTROL: a global admin's same invitation approves it (the scope question
    // never refuses them), and the staff spectator still gets no row.
    const r2 = await sa.post("/api/admin/invitations", { headers: H(saCsrf), data: { emails: [staff.email], competitionIds: [A.id] } });
    expect(r2.ok(), await r2.text()).toBeTruthy();
    expect((await r2.json()).leftPending).toEqual([]);
    expect([approvedNow(staff.id), inEvent(A.id, staff.id)], "CONTROL: the superadmin's invitation approves it").toEqual([1, false]);
  });

  test("an account already in the organiser's event is approved though nothing new is written; across two events one enrolment is enough", async () => {
    // Already a member: approved, enrolled, then the approval taken back by hand.
    const member = await makeParticipant(sa, saCsrf, "inv-scope-member");
    await enrol(sa, saCsrf, A.id, [member.id]);
    write("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?", member.id);
    expect(approvedNow(member.id), "PRECONDITION: pending, with a row in the event").toBe(0);
    // Two events: a spectator on A, a competitor on B (staff compete there).
    const B = await makeCompetition(sa, saCsrf, "inv-scope-b", { staff_compete: true });
    await grantEventAdmin(sa, saCsrf, B.id, org.id);
    const staff = await makePending(sa, saCsrf, "inv-scope-two");
    await staffTag(staff.id);
    const l = await apiLogin(org.email, PARTICIPANT_PASS);
    try {
      const r = await l.api.post("/api/admin/invitations", { headers: H(l.csrf), data: { emails: [member.email, staff.email], competitionIds: [A.id, B.id] } });
      expect(r.ok(), `invite: ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      expect(body.leftPending, "nobody is left waiting").toEqual([]);
      expect(approvedNow(member.id), "the member of their event is approved").toBe(1);
      expect([approvedNow(staff.id), inEvent(A.id, staff.id), inEvent(B.id, staff.id)], "approved through the event that took them").toEqual([1, false, true]);
    } finally { await l.api.dispose(); }
  });

  test("an organiser's account waiting for approval is an administrator's to approve: left pending, counted; a superadmin's invitation approves it (CONTROL)", async () => {
    const peer = await makePending(sa, saCsrf, "inv-scope-peer");
    write("UPDATE users SET role='event_admin' WHERE id=?", peer.id);
    const l = await apiLogin(org.email, PARTICIPANT_PASS);
    try {
      const r = await l.api.post("/api/admin/invitations", { headers: H(l.csrf), data: { emails: [peer.email], competitionIds: [A.id] } });
      expect(r.ok(), `invite: ${await r.text()}`).toBeTruthy();
      expect((await r.json()).skippedUnapproved, "counted as left pending").toBe(1);
      expect([approvedNow(peer.id), inEvent(A.id, peer.id)], "neither approved nor enrolled").toEqual([0, false]);
    } finally { await l.api.dispose(); }
    const r2 = await sa.post("/api/admin/invitations", { headers: H(saCsrf), data: { emails: [peer.email], competitionIds: [A.id] } });
    expect(r2.ok(), await r2.text()).toBeTruthy();
    expect(approvedNow(peer.id), "CONTROL: the superadmin's invitation approves it").toBe(1);
  });
});

// The selection bar's Approve (bulk approve) asks what a row's Approve asks: a rival's account (one
// the actor competes against) is not theirs to approve. Skipped and counted.
test.describe("bulk approval skips a rival's account, as the Approve button refuses it", () => {
  test("a competing admin's bulk approval leaves a rival pending and counts it; a non-rival in the same batch is approved (CONTROL)", async () => {
    const Database = require("better-sqlite3");
    const approvedNow = (id) => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT approved FROM users WHERE id=?").get(id).approved; } finally { d.close(); } };
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const compete = await makeCompetition(sa, saCsrf, "bulk-rival", { staff_compete: true });
      const actor = await makeParticipant(sa, saCsrf, "bulk-rival-actor");
      const rival = await makeParticipant(sa, saCsrf, "bulk-rival-target");
      await enrol(sa, saCsrf, compete.id, [actor.id, rival.id]);
      const pr = await sa.post(`/api/admin/participants/${actor.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
      expect(pr.ok(), `make admin: ${await pr.text()}`).toBeTruthy();
      { const d = new Database(TEST_DB_PATH); try { d.prepare("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?").run(rival.id); } finally { d.close(); } }
      const other = await makePending(sa, saCsrf, "bulk-nonrival");
      const l = await apiLogin(actor.email, PARTICIPANT_PASS);
      try {
        const door = await l.api.post(`/api/admin/participants/${rival.id}/approve`, { headers: H(l.csrf) });
        expect(door.status(), `PRECONDITION: the Approve button refuses the rival: ${await door.text()}`).toBe(403);
        const r = await l.api.post("/api/admin/participants/bulk-approve", { headers: H(l.csrf), data: { userIds: [rival.id, other.id] } });
        expect(r.ok(), `bulk approve: ${await r.text()}`).toBeTruthy();
        const body = await r.json();
        expect([body.approved, body.skippedRival], "the rival is skipped and counted").toEqual([1, 1]);
        expect(approvedNow(rival.id), "…and stays pending").toBe(0);
        expect(approvedNow(other.id), "CONTROL: the non-rival in the same batch is approved").toBe(1);
      } finally { await l.api.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("an organiser's bulk approval counts an organiser's account in their event as not theirs to approve, and an account outside their events as out of scope", async () => {
    const Database = require("better-sqlite3");
    const run = (q, ...a) => { const d = new Database(TEST_DB_PATH); try { return d.prepare(q).run(...a); } finally { d.close(); } };
    const approvedNow = (id) => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT approved FROM users WHERE id=?").get(id).approved; } finally { d.close(); } };
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const A = await makeCompetition(sa, saCsrf, "bulk-class");
      const org = await makeParticipant(sa, saCsrf, "bulk-class-org");
      await grantEventAdmin(sa, saCsrf, A.id, org.id);
      // In the organiser's event and waiting, but an organiser's account.
      const peer = await makeParticipant(sa, saCsrf, "bulk-class-peer");
      await enrol(sa, saCsrf, A.id, [peer.id]);
      run("UPDATE users SET role='event_admin', approved=0, approved_at=NULL, approved_by=NULL WHERE id=?", peer.id);
      // Waiting, and in none of the organiser's events.
      const outside = await makePending(sa, saCsrf, "bulk-class-out");
      // CONTROL: waiting, a participant, in their event.
      const mine = await makeParticipant(sa, saCsrf, "bulk-class-mine");
      await enrol(sa, saCsrf, A.id, [mine.id]);
      run("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?", mine.id);
      const l = await apiLogin(org.email, PARTICIPANT_PASS);
      try {
        const r = await l.api.post("/api/admin/participants/bulk-approve", { headers: H(l.csrf), data: { userIds: [peer.id, outside.id, mine.id] } });
        expect(r.ok(), `bulk approve: ${await r.text()}`).toBeTruthy();
        const b = await r.json();
        expect([b.approved, b.skippedPrivileged, b.skippedOutOfScope], "each refusal in its own count").toEqual([1, 1, 1]);
        expect([approvedNow(peer.id), approvedNow(outside.id), approvedNow(mine.id)]).toEqual([0, 0, 1]);
      } finally { await l.api.dispose(); }
    } finally { await sa.dispose(); }
  });
});
