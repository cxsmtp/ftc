"use strict";

// A CUSTOM ROLE SCOPED TO ITS EVENTS IS BOUND TO THEM ON THE SUPERADMIN-TIER
// ROUTES TOO.
//
// requireSuperAdmin and requireGlobalAdmin admit a custom role that holds the
// route's permission (lib/rbac.js customRoleAllows). For a role of scope
// `granted` that admission must not be a way past its events: every permission
// whose routes reach beyond one event is one such a role cannot hold
// (PLATFORM_WIDE_PERMISSIONS: the form refuses it by name, a stored grant gives
// nothing), and each route it CAN hold narrows to its events with the
// lib/event-admin.js predicate the built-in event admin meets.
//
// The world: the role's holder organises EVENT A only; EVENT B is the decoy,
// with its own participant, challenge and certificate. Every refusal sits beside
// a positive control inside A, so a build that refuses everything fails too.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin, withLegacySharedAssign } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }

// A certificate row, planted: the routes under test read it, they do not mint it.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function plantBadge(userId, competitionId, seed) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const token = `tok${seed}${Date.now().toString(36)}`;
    let code = "";
    for (let i = 0; i < 12; i++) code += CODE_ALPHABET[(seed * 7 + i * 13 + Date.now()) % CODE_ALPHABET.length];
    db.prepare(`INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot, created_at, public_code)
                VALUES (?,?,?,NULL,1,?,?,?,?)`).run(token, userId, competitionId, `img${token}`, "nick", new Date().toISOString(), code);
    return { token, code };
  } finally { db.close(); }
}

test.describe("RBAC — a custom role scoped to its events stays inside them on the superadmin-tier routes", () => {
  let sa, saCsrf, role, holder, u, A, B, Adel, pA, pB, tOwnA, tOwnAB, tTheirsA, bA, bB;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    const stamp = Date.now();
    // Upcoming, so no live-session confirmation or start-time lock stands
    // between the positive controls and the answer under test.
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    A = await makeCompetition(sa, saCsrf, "reachA", { start_time: future });
    B = await makeCompetition(sa, saCsrf, "reachB", { start_time: future });
    Adel = await makeCompetition(sa, saCsrf, "reachAdel", { start_time: future });
    const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: {
      label: `Scoped reach ${stamp}`, scope_mode: "granted",
      permissions: ["events.view", "events.delete", "challenges.view", "challenges.edit", "challenges.assign",
        "challenges.delete", "challenges.lock", "participants.view", "participants.verify",
        "certificates.view", "certificates.revoke", "certificates.lookup"] } });
    expect(r.ok(), `create role: ${r.status()} ${await r.text()}`).toBeTruthy();
    role = (await r.json()).role;
    holder = await makeParticipant(sa, saCsrf, "reachholder");
    const g = await sa.patch(`/api/admin/users/${holder.id}/role`, { headers: H(saCsrf), data: { role: role.id } });
    expect(g.ok(), `assign role: ${g.status()} ${await g.text()}`).toBeTruthy();
    await grantEventAdmin(sa, saCsrf, A.id, holder.id);
    await grantEventAdmin(sa, saCsrf, Adel.id, holder.id);
    pA = await makeParticipant(sa, saCsrf, "reachpa");
    pB = await makeParticipant(sa, saCsrf, "reachpb");
    await enrol(sa, saCsrf, A.id, [pA.id]);
    await enrol(sa, saCsrf, B.id, [pB.id]);
    u = await apiLogin(holder.email);
    // Its own challenge in A only; its own challenge ALSO used by B; and a
    // challenge in A it did not write.
    // An event's question is its OWN copy (lib/event-copies.js), so `tOwnA` and
    // `tTheirsA` are A's copies; ONE row used by two events exists only in a
    // database from before the copies, so `tOwnAB` is built that way (the
    // previous model's mode, through the test hook).
    const ownIn = async (api, csrf, t, cid) => ({ ...t, id: (await assignTask(api, csrf, t.id, [cid])).copies[0].task_id });
    tOwnA = await ownIn(u.api, u.csrf, await makeTask(u.api, u.csrf, "reachOwnA"), A.id);
    tOwnAB = await makeTask(u.api, u.csrf, "reachOwnAB");
    await withLegacySharedAssign(sa, saCsrf, async () => {
      await assignTask(u.api, u.csrf, tOwnAB.id, [A.id]);
      await assignTask(sa, saCsrf, tOwnAB.id, [B.id]);
    });
    // The LIBRARY question A holds a copy of, which it did not write (A's own copy
    // of it is A's question, which this role may edit as an organiser of A).
    tTheirsA = await makeTask(sa, saCsrf, "reachTheirsA");
    await assignTask(sa, saCsrf, tTheirsA.id, [A.id]);
    bA = plantBadge(pA.id, A.id, 1);
    bB = plantBadge(pB.id, B.id, 2);
  });

  test.afterAll(async () => { if (u) await u.api.dispose(); });

  test("every permission whose routes reach beyond one event is refused on such a role, a stored grant gives nothing, and an unscoped role holds them (CONTROL)", async () => {
    const rbac = require("../lib/rbac");
    const wide = [...rbac.PLATFORM_WIDE_PERMISSIONS];
    expect(wide.length, "PRECONDITION: the platform-wide set is the widened one").toBeGreaterThanOrEqual(19);
    for (const perm of ["events.organisers", "participants.delete", "templates.manage", "certificates.design", "users.manage", "data.import", "settings.view", "events.create"]) {
      expect(wide, `${perm} is one a scoped role may not hold`).toContain(perm);
    }
    for (const perm of wide) {
      const rr = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `Scoped ${perm} ${Date.now()}`, scope_mode: "granted", permissions: ["events.view", perm] } });
      expect(rr.status(), `${perm}: ${await rr.text()}`).toBe(400);
      expect(await json(rr)).toMatchObject({ code: "role_permission_needs_every_event", permission: perm });
    }
    const ok = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `Every event ${Date.now()}`, scope_mode: "all", permissions: wide } });
    expect(ok.ok(), `CONTROL: a role of every event may hold them all: ${ok.status()} ${await ok.text()}`).toBeTruthy();

    // A grant stored on the scoped role before the rule (written straight to
    // the table): the gate refuses each route, and the role reports none of it.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      for (const p of ["events.organisers", "participants.delete", "settings.view", "users.manage", "templates.manage"]) {
        db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?,?)").run(role.id, p);
      }
    } finally { db.close(); }
    const tries = [
      ["POST", `/api/admin/competitions/${B.id}/admins`, { userId: pB.id }, "add an organiser to another event"],
      ["POST", `/api/admin/competitions/${A.id}/admins`, { userId: pA.id }, "add an organiser even to its own event"],
      ["DELETE", `/api/admin/participants/${pB.id}`, undefined, "delete an account"],
      ["GET", "/api/admin/settings", undefined, "read platform settings"],
      ["GET", "/api/admin/users", undefined, "list the platform's admin accounts"],
      ["POST", `/api/admin/competitions/${A.id}/save-as-template`, { name: `T ${Date.now()}` }, "save an event as a template"],
    ];
    for (const [m, path, data, what] of tries) {
      const res = await u.api.fetch(path, { method: m, headers: H(u.csrf), data });
      expect(res.status(), `${what} (${m} ${path}): ${await res.text()}`).toBe(403);
    }
    const me = await json(await u.api.get("/api/admin/me"));
    for (const p of ["events.organisers", "participants.delete", "settings.view", "users.manage", "templates.manage"]) {
      expect(me.permissions, `the stored ${p} is not reported`).not.toContain(p);
    }
    expect(me.permissions, "CONTROL: the role's own permissions are reported").toContain("events.delete");
    const still = await json(await sa.get(`/api/admin/competitions/${B.id}/admins`));
    expect(JSON.stringify(still), "nobody was made an organiser of B").not.toContain(pB.id);
  });

  test("it deletes only its own events", async () => {
    const out = await u.api.delete(`/api/admin/competitions/${B.id}`, { headers: H(u.csrf) });
    expect(out.status(), await out.text()).toBe(403);
    expect((await json(out)).code).toBe("event_admin_out_of_scope");
    expect((await sa.get(`/api/admin/competitions/${B.id}/admins`)).status(), "B still exists").toBe(200);
    const mine = await u.api.delete(`/api/admin/competitions/${Adel.id}`, { headers: H(u.csrf) });
    expect(mine.status(), `CONTROL: its own event: ${await mine.text()}`).toBe(200);
  });

  test("it locks, recalculates, purges feedback of and deletes only its own challenges whose every event it organises", async () => {
    const post = (p) => u.api.post(p, { headers: H(u.csrf) });
    const del = (p) => u.api.delete(p, { headers: H(u.csrf) });
    const refused = async (res, code, what) => {
      expect(res.status(), `${what}: ${await res.text()}`).toBe(403);
      expect((await json(res)).code, what).toBe(code);
    };
    await refused(await post(`/api/admin/tasks/${tOwnAB.id}/lock`), "event_admin_scoring_locked", "lock a challenge another event also uses");
    await refused(await post(`/api/admin/tasks/${tTheirsA.id}/lock`), "event_admin_not_owner", "lock a challenge it did not write");
    await refused(await post(`/api/admin/tasks/${tOwnAB.id}/recalculate`), "event_admin_scoring_locked", "recalculate a challenge another event also uses");
    await refused(await del(`/api/admin/tasks/${tOwnAB.id}/feedback`), "event_admin_scoring_locked", "purge the feedback of a challenge another event also uses");
    await refused(await del(`/api/admin/tasks/${tOwnAB.id}/feedback/${pB.id}`), "event_admin_scoring_locked", "remove one rating on a challenge another event also uses");
    await refused(await del(`/api/admin/tasks/${tOwnAB.id}`), "event_admin_scoring_locked", "delete a challenge another event also uses");
    await refused(await del(`/api/admin/tasks/${tTheirsA.id}`), "event_admin_not_owner", "delete a challenge it did not write");
    const lockedNow = (id) => { const D = require("better-sqlite3"); const d = new D(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT locked FROM tasks WHERE id=?").get(id).locked; } finally { d.close(); } };
    expect(lockedNow(tOwnAB.id), "the refused lock changed nothing").toBe(0);

    // CONTROLS, on its own challenge used by its own event only.
    const l1 = await post(`/api/admin/tasks/${tOwnA.id}/lock`);
    expect(l1.status(), `CONTROL lock: ${await l1.text()}`).toBe(200);
    expect(lockedNow(tOwnA.id)).toBe(1);
    const l2 = await post(`/api/admin/tasks/${tOwnA.id}/lock`);
    expect(l2.status(), `CONTROL unlock: ${await l2.text()}`).toBe(200);
    const rc = await post(`/api/admin/tasks/${tOwnA.id}/recalculate`);
    expect(rc.status(), `CONTROL recalculate: ${await rc.text()}`).toBe(200);
    const fb = await del(`/api/admin/tasks/${tOwnA.id}/feedback`);
    expect(fb.status(), `CONTROL feedback purge: ${await fb.text()}`).toBe(200);
    const gone = await del(`/api/admin/tasks/${tOwnA.id}`);
    expect(gone.status(), `CONTROL delete: ${await gone.text()}`).toBe(200);
  });

  test("it verifies only people in its events, and an id outside them is no oracle", async () => {
    const v = (id) => u.api.post(`/api/admin/participants/${id}/verify`, { headers: H(u.csrf) });
    const out = await v(pB.id);
    expect(out.status(), await out.text()).toBe(403);
    const ghost = await v("00000000-0000-4000-8000-000000000000");
    expect(ghost.status(), "an unknown id answers as one outside its events").toBe(403);
    expect((await json(ghost)).code).toBe((await json(await v(pB.id))).code);
    const mine = await v(pA.id);
    expect(mine.status(), `CONTROL: someone in its event: ${await mine.text()}`).toBe(200);
  });

  test("it looks up and revokes only its own events' certificates; another event's code answers as an unknown one", async () => {
    const look = (code) => u.api.get(`/api/admin/credential/${code}`);
    const unknown = await look("ZZZZZZZZZZZZ");
    expect(unknown.status()).toBe(404);
    const other = await look(bB.code);
    expect(other.status(), await other.text()).toBe(404);
    expect(await json(other), "byte-for-byte the unknown-code answer").toEqual(await json(unknown));
    const mine = await look(bA.code);
    expect(mine.status(), `CONTROL: its own event's certificate: ${await mine.text()}`).toBe(200);
    const saOther = await sa.get(`/api/admin/credential/${bB.code}`);
    expect(saOther.status(), "CONTROL: the superadmin finds B's certificate, so the 404 above is the scope").toBe(200);

    const rv = (token) => u.api.post(`/api/admin/badges/${token}/revoke`, { headers: H(u.csrf), data: { reason: "test" } });
    const out = await rv(bB.token);
    expect(out.status(), await out.text()).toBe(403);
    expect((await json(out)).code).toBe("event_admin_out_of_scope");
    const D = require("better-sqlite3"); const d = new D(TEST_DB_PATH, { readonly: true });
    try { expect(d.prepare("SELECT revoked_at FROM achievement_badges WHERE token=?").get(bB.token).revoked_at, "B's certificate stands").toBeNull(); } finally { d.close(); }
    const ok = await rv(bA.token);
    expect(ok.status(), `CONTROL: revoke its own event's certificate: ${await ok.text()}`).toBe(200);
    // Issue again (the same permission) is scoped the same way.
    const ri = (compId, userId) => u.api.post(`/api/admin/competitions/${compId}/certificates/reissue`, { headers: H(u.csrf), data: { userId } });
    const outRi = await ri(B.id, pB.id);
    expect(outRi.status(), await outRi.text()).toBe(403);
    expect((await json(outRi)).code).toBe("event_admin_out_of_scope");
    const inRi = await ri(A.id, pA.id);
    expect([inRi.status(), (await json(inRi)).code], "CONTROL: in scope, it is answered on the merits (the event has not ended)").toEqual([409, "not_ended"]);
  });
});
