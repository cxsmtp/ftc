// @ts-check
//
// THE PRIVILEGED-TARGET RULE COVERS CUSTOM ROLES (lib/rbac.js privilegedTargetFor).
//
// Every sign-in is an emailed code to the account's PRIMARY address, so an admin
// who can move another account's primary to a mailbox they read can confirm the
// change (/confirm-email takes the code mailed there) and then sign in as that
// account. The peer-admin rule exists to stop that: only a superadmin manages an
// account that is privileged for the actor. It used to be spelt with the two
// built-in role literals, so an account holding a CUSTOM unscoped role — or a
// custom role holding a permission the actor lacks — was editable by any regular
// admin, and taking it over took that role's permissions.
//
// Each refusal has a control: the same door on a plain participant (a regular
// admin may), the same door for a superadmin (who may), and a built-in event
// admin's account (a role inside the regular admin's own set, so unchanged).
// Refusals write nothing, and the file reads the row back to prove it.
//
// The rival half (a competitor moving a rival's addresses) is the same takeover
// through the competitor lock: the profile stays editable, the addresses do not.

const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { BASE, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

function read(fn) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
function row(id) {
  return read(db => db.prepare("SELECT email, secondary_email, pending_email, phone, blocked, denied_at, approved FROM users WHERE id=?").get(id));
}
const tagsOf = (id) => read(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=? ORDER BY tag").all(id).map(r => r.tag));
const groupsOf = (id) => read(db => db.prepare("SELECT group_id FROM group_members WHERE user_id=? ORDER BY group_id").all(id).map(r => r.group_id));
const groupNamed = (name) => read(db => { const g = db.prepare("SELECT id FROM groups WHERE name=?").get(name); return g ? g.id : null; });
const enrolled = (compId) => read(db => db.prepare("SELECT user_id FROM competition_users WHERE competition_id=? ORDER BY user_id").all(compId).map(r => r.user_id)).sort();
const grantsFor = (userId, compId) => read(db => db.prepare("SELECT COUNT(*) AS n FROM attempt_grants WHERE user_id=? AND competition_id=?").get(userId, compId).n);
async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }

let W;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const s = await apiLogin("superadmin");
  const sa = s.api, saCsrf = s.csrf;

  const mkRole = async (label, scope_mode, permissions) => {
    const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${uniq("r")}`, scope_mode, permissions } });
    expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).role;
  };
  const giveRole = async (userId, roleId) => {
    const r = await sa.patch(`/api/admin/users/${userId}/role`, { headers: H(saCsrf), data: { role: roleId } });
    expect(r.ok(), `assign role ${roleId}: ${r.status()} ${await r.text()}`).toBeTruthy();
  };

  // An UNSCOPED custom role holding nothing the regular admin lacks (so only its
  // class makes it privileged), and a SCOPED one holding a superadmin-only
  // permission (so only the permission makes it privileged).
  const roleAll = await mkRole("Desk lead", "all", ["participants.view"]);
  const roleGranted = await mkRole("Scoped deleter", "granted", ["events.view", "events.delete"]);

  const victimAll = await makeParticipant(sa, saCsrf, "victimall");
  await giveRole(victimAll.id, roleAll.id);
  const victimGranted = await makeParticipant(sa, saCsrf, "victimgr");
  await giveRole(victimGranted.id, roleGranted.id);
  const plain = await makeParticipant(sa, saCsrf, "plain");

  // A built-in event admin: every permission it holds is the regular admin's too.
  const evt = await makeCompetition(sa, saCsrf, "ptarget");
  const organiser = await makeParticipant(sa, saCsrf, "organiser");
  await grantEventAdmin(sa, saCsrf, evt.id, organiser.id);

  const admin = await makeParticipant(sa, saCsrf, "regadmin");
  const pr = await sa.post(`/api/admin/participants/${admin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(pr.ok(), `promote admin: ${pr.status()} ${await pr.text()}`).toBeTruthy();
  const a = await apiLogin(admin.email, PARTICIPANT_PASS);
  const me = await json(await a.api.get("/api/admin/me"));
  expect(me.isSuperAdmin, "the actor is a REGULAR admin").toBe(false);
  expect(me.role_info && me.role_info.id, "…holding the built-in admin role").toBe("admin");

  // A user-backed admin who AUTHORS the sealed challenge a compete event needs
  // (the built-in superadmin has no account to author with).
  const author = await makeParticipant(sa, saCsrf, "ptauthor");
  const ar = await sa.post(`/api/admin/participants/${author.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(ar.ok(), `promote author: ${ar.status()} ${await ar.text()}`).toBeTruthy();
  const au = await apiLogin(author.email, PARTICIPANT_PASS);

  W = { sa, saCsrf, roleAll, roleGranted, victimAll, victimGranted, plain, organiser, admin, adminApi: a.api, adminCsrf: a.csrf,
    authorApi: au.api, authorCsrf: au.csrf, giveRole };
});

/**
 * A fresh account for one test: verified, holding `roleId` (none: a
 * participant), and `pending` when the approval is taken back by hand (an
 * approved account is what the role route needs to give it the role).
 */
async function holderOf(label, roleId, { pending = false } = {}) {
  const u = await makeParticipant(W.sa, W.saCsrf, label);
  if (roleId) await W.giveRole(u.id, roleId);
  if (pending) {
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?").run(u.id); } finally { db.close(); }
    expect(row(u.id).approved, `PRECONDITION: ${label} is pending`).toBe(0);
  }
  return u;
}

test.describe("privileged targets include custom roles", () => {
  test("a regular admin cannot stage a custom unscoped role's addresses; a superadmin and a participant control can", async () => {
    const v = W.victimAll;
    const before = row(v.id);
    expect(before.pending_email, "precondition: nothing staged").toBeNull();

    const primary = await W.adminApi.put(`/api/admin/participants/${v.id}`, {
      headers: H(W.adminCsrf), data: { email: `takeover-${uniq("p")}@acme.com` } });
    expect(primary.status(), "staging the primary to the actor's mailbox is the takeover's first step").toBe(403);
    expect((await json(primary)).error).toMatch(/Only superadmins/);
    const secondary = await W.adminApi.put(`/api/admin/participants/${v.id}`, {
      headers: H(W.adminCsrf), data: { secondaryEmail: `takeover2-${uniq("s")}@acme.com` } });
    expect(secondary.status()).toBe(403);
    expect(row(v.id), "a refusal wrote nothing").toEqual(before);

    // Control: the same edit on a plain participant goes through for the same actor.
    const okSec = `plain-sec-${uniq("c")}@acme.com`;
    const plainPut = await W.adminApi.put(`/api/admin/participants/${W.plain.id}`, {
      headers: H(W.adminCsrf), data: { secondaryEmail: okSec } });
    expect(plainPut.status(), `regular admin on a participant: ${await plainPut.text()}`).toBe(200);
    expect(row(W.plain.id).secondary_email).toBe(okSec);

    // Control: a superadmin may edit the custom-role account.
    const saSec = `sa-sec-${uniq("c")}@acme.com`;
    const saPut = await W.sa.put(`/api/admin/participants/${v.id}`, { headers: H(W.saCsrf), data: { secondaryEmail: saSec } });
    expect(saPut.status(), `superadmin control: ${await saPut.text()}`).toBe(200);
    expect(row(v.id).secondary_email).toBe(saSec);
  });

  test("every account door refuses a regular admin on BOTH kinds of privileged custom role, beside participant and superadmin controls", async () => {
    // Each kind once: a role on every event (privileged by its class) and a
    // role scoped to its events holding events.delete (privileged only because
    // it holds what the admin lacks). A door that asked the class alone — the
    // old `_isGlobalRole` spelling — passes the first and lets the second
    // through, so both are driven at every door.
    const adminGroup = await json(await W.adminApi.post("/api/admin/groups", { headers: H(W.adminCsrf), data: { name: `PT bulk ${uniq("g")}` } }));
    expect(adminGroup.group && adminGroup.group.id, `the regular admin's own group: ${JSON.stringify(adminGroup)}`).toBeTruthy();
    for (const [kind, v] of [["a custom role on every event", W.victimAll], ["a scoped role holding events.delete", W.victimGranted]]) {
      // What a superadmin gave the account, for the two removal doors to find.
      const tag = `keep${uniq("t").replace(/[^a-z0-9]/gi, "").slice(-12)}`;
      const tg = await W.sa.post(`/api/admin/participants/${v.id}/tags`, { headers: H(W.saCsrf), data: { tag } });
      expect(tg.status(), `superadmin tags ${kind}: ${await tg.text()}`).toBe(200);
      const gName = `PT keep ${uniq("g")}`;
      const gg = await json(await W.sa.post(`/api/admin/participants/${v.id}/groups`, { headers: H(W.saCsrf), data: { newName: gName } }));
      const group = (gg.groups || []).find(g => g.name === gName);
      expect(group, `superadmin groups ${kind}: ${JSON.stringify(gg)}`).toBeTruthy();
      const seedName = `PT seed ${uniq("g")}`;
      const before = { row: row(v.id), tags: tagsOf(v.id), groups: groupsOf(v.id) };
      expect(before.tags, "PRECONDITION: the tag is there to remove").toContain(tag);
      expect(before.groups, "PRECONDITION: the membership is there to remove").toContain(group.id);
      const doors = [
        ["approve", () => W.adminApi.post(`/api/admin/participants/${v.id}/approve`, { headers: H(W.adminCsrf) })],
        ["deny", () => W.adminApi.post(`/api/admin/participants/${v.id}/deny`, { headers: H(W.adminCsrf), data: { reason: "x" } })],
        ["block", () => W.adminApi.post(`/api/admin/participants/${v.id}/block`, { headers: H(W.adminCsrf) })],
        ["unlock", () => W.adminApi.post(`/api/admin/participants/${v.id}/unlock`, { headers: H(W.adminCsrf) })],
        ["email a sign-in code", () => W.adminApi.post(`/api/admin/participants/${v.id}/login-code/email`, { headers: H(W.adminCsrf) })],
        ["edit the profile", () => W.adminApi.put(`/api/admin/participants/${v.id}`, { headers: H(W.adminCsrf), data: { phone: "+44 20 7946 0101" } })],
        ["add a tag", () => W.adminApi.post(`/api/admin/participants/${v.id}/tags`, { headers: H(W.adminCsrf), data: { tag: "vip" } })],
        ["remove a tag", () => W.adminApi.delete(`/api/admin/participants/${v.id}/tags/${encodeURIComponent(tag)}`, { headers: H(W.adminCsrf) })],
        ["add to a group", () => W.adminApi.post(`/api/admin/participants/${v.id}/groups`, { headers: H(W.adminCsrf), data: { newName: `G ${uniq("g")}` } })],
        ["remove from a group", () => W.adminApi.delete(`/api/admin/participants/${v.id}/groups/${group.id}`, { headers: H(W.adminCsrf) })],
        ["seed a new group", () => W.adminApi.post("/api/admin/groups", { headers: H(W.adminCsrf), data: { name: seedName, userIds: [v.id] } })],
        ["add to a group in bulk", () => W.adminApi.post(`/api/admin/groups/${adminGroup.group.id}/members`, { headers: H(W.adminCsrf), data: { userIds: [v.id] } })],
        ["remove from a group's member list", () => W.adminApi.delete(`/api/admin/groups/${group.id}/members/${v.id}`, { headers: H(W.adminCsrf) })],
      ];
      for (const [name, call] of doors) {
        const r = await call();
        expect(r.status(), `${name} on ${kind}: ${await r.text()}`).toBe(403);
      }
      expect({ row: row(v.id), tags: tagsOf(v.id), groups: groupsOf(v.id) }, `no door wrote anything on ${kind}`).toEqual(before);
      expect(groupNamed(seedName), "the refused seed created no group").toBeNull();
      // CONTROL: a superadmin passes the removal doors on the same account.
      const ok1 = await W.sa.delete(`/api/admin/participants/${v.id}/tags/${encodeURIComponent(tag)}`, { headers: H(W.saCsrf) });
      expect(ok1.status(), `superadmin removes the tag from ${kind}: ${await ok1.text()}`).toBe(200);
      const ok2 = await W.sa.delete(`/api/admin/groups/${group.id}/members/${v.id}`, { headers: H(W.saCsrf) });
      expect(ok2.status(), `superadmin removes ${kind} from the group: ${await ok2.text()}`).toBe(200);
      expect(tagsOf(v.id)).not.toContain(tag);
      expect(groupsOf(v.id)).not.toContain(group.id);
    }

    // CONTROLS: the same regular admin passes each tag and group door on a participant.
    const p = W.plain;
    const add = await W.adminApi.post(`/api/admin/participants/${p.id}/tags`, { headers: H(W.adminCsrf), data: { tag: "vip" } });
    expect(add.status(), "regular admin tags a participant").toBe(200);
    const rm = await W.adminApi.delete(`/api/admin/participants/${p.id}/tags/vip`, { headers: H(W.adminCsrf) });
    expect(rm.status(), "…and removes the tag").toBe(200);
    expect(tagsOf(p.id)).not.toContain("vip");
    const seedName = `PT seed ok ${uniq("g")}`;
    const seed = await W.adminApi.post("/api/admin/groups", { headers: H(W.adminCsrf), data: { name: seedName, userIds: [p.id] } });
    expect(seed.status(), `regular admin seeds a group with a participant: ${await seed.text()}`).toBe(200);
    const seeded = groupNamed(seedName);
    expect(seeded, "the seeded group exists").toBeTruthy();
    expect(groupsOf(p.id)).toContain(seeded);
    const bulk = await W.adminApi.post(`/api/admin/groups/${adminGroup.group.id}/members`, { headers: H(W.adminCsrf), data: { userIds: [p.id] } });
    expect(bulk.status(), `regular admin adds a participant in bulk: ${await bulk.text()}`).toBe(200);
    expect(groupsOf(p.id)).toContain(adminGroup.group.id);
    const out = await W.adminApi.delete(`/api/admin/groups/${adminGroup.group.id}/members/${p.id}`, { headers: H(W.adminCsrf) });
    expect(out.status(), "…and removes them from the member list").toBe(200);
    const out2 = await W.adminApi.delete(`/api/admin/participants/${p.id}/groups/${seeded}`, { headers: H(W.adminCsrf) });
    expect(out2.status(), "…and from the seeded group").toBe(200);
    expect(groupsOf(p.id)).not.toContain(adminGroup.group.id);
    expect(groupsOf(p.id)).not.toContain(seeded);
  });

  test("bulk approve skips a pending privileged custom-role account for a regular admin and counts it; a superadmin approves it (CONTROL)", async () => {
    const pAll = await holderOf("bulkall", W.roleAll.id, { pending: true });
    const pGranted = await holderOf("bulkgr", W.roleGranted.id, { pending: true });
    const pPlain = await holderOf("bulkplain", null, { pending: true });
    const r = await json(await W.adminApi.post("/api/admin/participants/bulk-approve", {
      headers: H(W.adminCsrf), data: { userIds: [pAll.id, pGranted.id, pPlain.id] } }));
    expect(r, "the regular admin's batch").toMatchObject({ ok: true, approved: 1, skippedPrivileged: 2 });
    expect(row(pAll.id).approved, "a custom role on every event stays pending").toBe(0);
    expect(row(pGranted.id).approved, "a role holding events.delete stays pending").toBe(0);
    expect(row(pPlain.id).approved, "CONTROL: the participant in the same batch is approved").toBe(1);
    const s = await json(await W.sa.post("/api/admin/participants/bulk-approve", {
      headers: H(W.saCsrf), data: { userIds: [pAll.id, pGranted.id] } }));
    expect(s, "CONTROL: the superadmin's batch").toMatchObject({ ok: true, approved: 2, skippedPrivileged: 0 });
    expect(row(pAll.id).approved).toBe(1);
    expect(row(pGranted.id).approved).toBe(1);
  });

  test("on an event where staff compete, assign, invitation and attempt grants skip or refuse a privileged custom-role account for a regular admin; a superadmin and a participant are the CONTROLS", async () => {
    const vAll = await holderOf("cmpall", W.roleAll.id);
    const vGranted = await holderOf("cmpgr", W.roleGranted.id);
    const pA = await makeParticipant(W.sa, W.saCsrf, "cmpplaina");
    const pI = await makeParticipant(W.sa, W.saCsrf, "cmpplaini");
    const evt = await makeCompetition(W.sa, W.saCsrf, "cmpassign", { staff_compete: true });

    // ASSIGN: the regular admin's batch enrols the participant and skips both.
    const a = await json(await W.adminApi.post("/api/admin/competitions/assign", {
      headers: H(W.adminCsrf), data: { userIds: [vAll.id, vGranted.id, pA.id], competitionIds: [evt.id] } }));
    expect(a, "the regular admin's assign").toMatchObject({ ok: true, assigned: 1, skippedPrivileged: 2 });
    expect(enrolled(evt.id), "only the participant holds a row").toEqual([pA.id].sort());

    // INVITATION (its event and its group): the same two skips, counted.
    const grp = await json(await W.adminApi.post("/api/admin/groups", { headers: H(W.adminCsrf), data: { name: `PT inv ${uniq("g")}` } }));
    const inv = await json(await W.adminApi.post("/api/admin/invitations", {
      headers: H(W.adminCsrf), data: { emails: [vAll.email, vGranted.email, pI.email], competitionIds: [evt.id], groupIds: [grp.group.id] } }));
    expect(inv, `the regular admin's invitation: ${JSON.stringify(inv)}`).toMatchObject({ ok: true, skippedPrivileged: 2, skippedPrivilegedGroups: 2 });
    expect(enrolled(evt.id), "the invited participant joins; neither privileged account does").toEqual([pA.id, pI.id].sort());
    expect(groupsOf(vAll.id)).not.toContain(grp.group.id);
    expect(groupsOf(vGranted.id)).not.toContain(grp.group.id);
    expect(groupsOf(pI.id), "CONTROL: the participant is added to the group").toContain(grp.group.id);

    // CONTROL: the superadmin enrols both.
    const s = await json(await W.sa.post("/api/admin/competitions/assign", {
      headers: H(W.saCsrf), data: { userIds: [vAll.id, vGranted.id], competitionIds: [evt.id] } }));
    expect(s, "the superadmin's assign").toMatchObject({ ok: true, assigned: 2, skippedPrivileged: 0 });

    // ATTEMPT GRANT on a capped (sealed) challenge of the event: a peer door too.
    const task = await makeTask(W.authorApi, W.authorCsrf, "cmpgrant", { answer_sealed: true, correct_answer: `K${uniq("k").replace(/[^a-z0-9]/gi, "")}`, attempt_cap: 1 });
    await assignTask(W.authorApi, W.authorCsrf, task.id, [evt.id]);
    const grant = (api, csrf, userId) => api.post(`/api/admin/tasks/${task.id}/attempt-grant`, { headers: H(csrf), data: { userId, competitionId: evt.id, extra: 1 } });
    for (const [kind, v] of [["a custom role on every event", vAll], ["a role holding events.delete", vGranted]]) {
      const no = await grant(W.adminApi, W.adminCsrf, v.id);
      expect(no.status(), `a regular admin grants to ${kind}: ${await no.text()}`).toBe(403);
      expect(grantsFor(v.id, evt.id), `nothing was written for ${kind}`).toBe(0);
      const yes = await grant(W.sa, W.saCsrf, v.id);
      expect(yes.status(), `CONTROL: the superadmin grants to ${kind}: ${await yes.text()}`).toBe(200);
      expect(grantsFor(v.id, evt.id)).toBe(1);
    }
    const okP = await grant(W.adminApi, W.adminCsrf, pA.id);
    expect(okP.status(), `CONTROL: the regular admin grants to a participant: ${await okP.text()}`).toBe(200);
  });

  test("a scoped custom role holding a permission the actor lacks is privileged; a built-in event admin is not", async () => {
    const r = await W.adminApi.put(`/api/admin/participants/${W.victimGranted.id}`, {
      headers: H(W.adminCsrf), data: { secondaryEmail: `gr-${uniq("s")}@acme.com` } });
    expect(r.status(), "the role holds events.delete, which a regular admin does not").toBe(403);

    // Control: the built-in event admin's permissions all lie inside the admin's,
    // so a regular admin manages that account as before.
    const sec = `org-${uniq("s")}@acme.com`;
    const ok = await W.adminApi.put(`/api/admin/participants/${W.organiser.id}`, {
      headers: H(W.adminCsrf), data: { secondaryEmail: sec } });
    expect(ok.status(), `regular admin on an event admin: ${await ok.text()}`).toBe(200);
    expect(row(W.organiser.id).secondary_email).toBe(sec);
  });

  test("People rows carry the predicate's answer for the asking actor", async () => {
    const byId = async (api) => {
      const d = await json(await api.get("/api/admin/participants?kind=all&limit=5000"));
      return new Map(d.participants.map(p => [p.id, p]));
    };
    const mine = await byId(W.adminApi);
    expect(mine.get(W.victimAll.id)).toMatchObject({ role_class: "all", privileged_target: true });
    expect(mine.get(W.victimGranted.id)).toMatchObject({ role_class: "granted", privileged_target: true });
    expect(mine.get(W.organiser.id)).toMatchObject({ role_class: "granted", privileged_target: false });
    expect(mine.get(W.plain.id)).toMatchObject({ role_class: "none", privileged_target: false });
    const sa = await byId(W.sa);
    for (const id of [W.victimAll.id, W.victimGranted.id, W.organiser.id, W.plain.id]) {
      expect(sa.get(id).privileged_target, "a superadmin may manage every account").toBe(false);
    }
  });

  test("a custom role holding Delete accounts deletes a participant but no privileged account; a superadmin does (CONTROL)", async () => {
    // participants.delete is platform-wide, so only an unscoped role can hold it.
    const rr = await W.sa.post("/api/admin/roles", { headers: H(W.saCsrf), data: {
      label: `Deleter ${uniq("r")}`, scope_mode: "all", permissions: ["participants.view", "participants.delete"] } });
    expect(rr.ok(), `create the deleter role: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    const actor = await holderOf("deleter", (await rr.json()).role.id);
    const a = await apiLogin(actor.email, PARTICIPANT_PASS);
    const exists = (id) => read(db => !!db.prepare("SELECT 1 FROM users WHERE id=?").get(id));
    const del = (api, csrf, id) => api.delete(`/api/admin/participants/${id}`, { headers: H(csrf) });

    const vAll = await holderOf("delall", W.roleAll.id);
    const vGranted = await holderOf("delgr", W.roleGranted.id);
    const vAdmin = await makeParticipant(W.sa, W.saCsrf, "deladmin");
    const pr = await W.sa.post(`/api/admin/participants/${vAdmin.id}/role`, { headers: H(W.saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `promote: ${pr.status()} ${await pr.text()}`).toBeTruthy();
    for (const [v, why] of [[vAll, "an unscoped custom role"], [vGranted, "a role holding events.delete, which the actor lacks"], [vAdmin, "a regular admin"]]) {
      const r = await del(a.api, a.csrf, v.id);
      expect(r.status(), `deleting ${why}: ${await r.text()}`).toBe(403);
      expect(exists(v.id), `${why} is still there`).toBe(true);
    }
    // CONTROLS: the same actor deletes a participant; a superadmin deletes the admin.
    const plain = await makeParticipant(W.sa, W.saCsrf, "delplain");
    const ok = await del(a.api, a.csrf, plain.id);
    expect(ok.status(), `deleting a participant: ${await ok.text()}`).toBe(200);
    expect(exists(plain.id)).toBe(false);
    const saOk = await del(W.sa, W.saCsrf, vAdmin.id);
    expect(saOk.status(), `a superadmin deletes the admin: ${await saOk.text()}`).toBe(200);
    expect(exists(vAdmin.id)).toBe(false);
  });
});

test.describe("the competitor lock covers a rival's addresses", () => {
  test("a competing admin cannot move a rival's addresses; other profile fields and an echo pass, and a non-competing admin may", async () => {
    const evt = await makeCompetition(W.sa, W.saCsrf, "rivaladdr", { staff_compete: true });
    const actor = await makeParticipant(W.sa, W.saCsrf, "rivactor");
    const rival = await makeParticipant(W.sa, W.saCsrf, "rival");
    await enrol(W.sa, W.saCsrf, evt.id, [actor.id, rival.id]);
    const pr = await W.sa.post(`/api/admin/participants/${actor.id}/role`, { headers: H(W.saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `promote competing admin: ${pr.status()} ${await pr.text()}`).toBeTruthy();
    const a = await apiLogin(actor.email, PARTICIPANT_PASS);
    const list = await json(await a.api.get("/api/admin/participants?kind=all&limit=5000"));
    expect(list.participants.find(p => p.id === rival.id).rival_in, "precondition: the two compete on one board").toMatchObject({ id: evt.id });

    const before = row(rival.id);
    for (const data of [{ email: `steal-${uniq("p")}@acme.com` }, { secondaryEmail: `steal2-${uniq("s")}@acme.com` }]) {
      const r = await a.api.put(`/api/admin/participants/${rival.id}`, { headers: H(a.csrf), data });
      expect(r.status(), `moving ${Object.keys(data)[0]}: ${await r.text()}`).toBe(403);
      const b = await json(r);
      expect(b.code).toBe("competitor_cannot_edit");
      expect(b.competitionId).toBe(evt.id);
    }
    expect(row(rival.id), "nothing staged or stored").toEqual(before);

    // The profile itself stays editable, and an echo of the stored addresses is no move.
    const phone = "+44 20 7946 0000";
    const ok = await a.api.put(`/api/admin/participants/${rival.id}`, { headers: H(a.csrf), data: { phone, email: before.email } });
    expect(ok.status(), `a non-address field with an echoed primary: ${await ok.text()}`).toBe(200);
    expect(row(rival.id).phone).toBe(phone);

    // Control: the regular admin who competes nowhere moves the same secondary.
    const sec = `free-${uniq("s")}@acme.com`;
    const ctl = await W.adminApi.put(`/api/admin/participants/${rival.id}`, { headers: H(W.adminCsrf), data: { secondaryEmail: sec } });
    expect(ctl.status(), `non-competing admin: ${await ctl.text()}`).toBe(200);
    expect(row(rival.id).secondary_email).toBe(sec);
  });
});

// ── THE SOURCE HALF: every privileged-target door asks the one predicate ──────
//
// The behavioural arms above drive each door against each KIND of privileged
// role. This scanner holds the shape that keeps them honest when a door is
// added or rewritten: the rule used to be spelt per door — two role literals,
// or the role's class — beside `!req.session.isSuperAdmin`, and both spellings
// let a custom role through (a role scoped to its events that holds what the
// actor lacks has no class to catch it). So:
//   (1) no condition anywhere in server.js or routes/ pairs a superadmin
//       negation with a role literal or a class test (`_isGlobalRole`,
//       `isGlobalClassRole`, `roleIdsOfClass`) — the hand-rolled rule;
//   (2) every door in DOORS calls the predicate (lib/rbac.js
//       privilegedTargetFor, imported as `_privilegedTarget`), and the group
//       helper they share calls it too;
//   (3) the client's predicate reads the server's answer for a custom role.
// A new peer door joins DOORS; a renamed door fails (2) by name.
test.describe("every privileged-target door asks the one predicate (source)", () => {
  const fs = require("fs");
  const path = require("path");
  const { stripJsComments } = require("./doc-registry");
  const ROOT = path.join(__dirname, "..");
  const src = (rel) => stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));

  // The statement around a match: out to the enclosing group's opener, the
  // statement's `;`, or a block boundary, counting (), [] and {} so an argument
  // such as `{ live: true }` does not end it early.
  function windowAround(s, i, len) {
    let depth = 0, a = 0;
    for (let k = i - 1; k >= 0; k--) {
      const c = s[k];
      if ((c === ";" || c === "}") && depth === 0) { a = k + 1; break; }
      if (c === ")" || c === "]" || c === "}") depth++;
      else if (c === "(" || c === "[" || c === "{") { if (depth === 0) { a = k + 1; break; } depth--; }
    }
    depth = 0;
    let b = s.length;
    for (let k = i + len; k < s.length; k++) {
      const c = s[k];
      if ((c === ";" || c === "{") && depth === 0) { b = k; break; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) { b = k; break; } depth--; }
    }
    return s.slice(a, b);
  }
  const SA_NEG = /!\s*(?:req\.session\.isSuperAdmin|isSA)\b/g;
  const ROLE_TEST = /\b(?:_isGlobalRole|isGlobalClassRole|roleIdsOfClass)\s*\(|===\s*["'](?:admin|superadmin)["']|["'](?:admin|superadmin)["']\s*===/;
  /** [{line, text}] for each hand-rolled privileged test in already-stripped source, plus how many negations it read. */
  function handRolled(s) {
    const hits = [];
    let n = 0, m;
    SA_NEG.lastIndex = 0;
    while ((m = SA_NEG.exec(s))) {
      n++;
      const w = windowAround(s, m.index, m[0].length);
      if (ROLE_TEST.test(w)) hits.push({ line: s.slice(0, m.index).split("\n").length, text: w.replace(/\s+/g, " ").trim().slice(0, 160) });
    }
    return { hits, n };
  }

  test("no condition pairs a superadmin negation with a role literal or a role-class test", () => {
    // Anti-vacuity: each spelling the rule ever had is seen, and the predicate
    // and an unrelated superadmin-only rule are not.
    for (const planted of [
      'if (_isGlobalRole(targetRole, { live: true }) && !req.session.isSuperAdmin) { x(); }',
      'if ((targetRole === "admin" || targetRole === "superadmin") && !req.session.isSuperAdmin) { x(); }',
      'const skip = isGlobalClassRole(existing.role)\n    && !req.session.isSuperAdmin && existing.id !== me;',
      'if (targetIsPrivileged === "admin" && !isSA) { x(); }',
    ]) expect(handRolled(planted).hits.length, `the scanner sees: ${planted}`).toBe(1);
    for (const fine of [
      'if (task.locked && !req.session.isSuperAdmin) { x(); }',
      'if (_privilegedTarget(req, targetRole)) { x(); }',
      // A class test in the statement BEFORE the negation is another statement.
      'if (_isGlobalRole(r, { live: true })) { a(); } if (!req.session.isSuperAdmin) { b(); }',
    ]) expect(handRolled(fine).hits, `the scanner passes: ${fine}`).toEqual([]);

    const files = ["server.js", ...fs.readdirSync(path.join(ROOT, "routes")).filter(f => f.endsWith(".js")).map(f => "routes/" + f)];
    let negations = 0;
    const offenders = [];
    for (const rel of files) {
      const r = handRolled(src(rel));
      negations += r.n;
      for (const h of r.hits) offenders.push(`${rel}:${h.line}  ${h.text}`);
    }
    // Floor: the tree negates the superadmin flag dozens of times.
    expect(negations).toBeGreaterThan(20);
    expect(offenders, "a privileged-target rule spelt by hand — ask lib/rbac.js privilegedTargetFor").toEqual([]);
  });

  test("every privileged-target door, and the group helper, calls the one predicate; the client reads its answer", () => {
    // [file, method, route, the call its handler must make, how many times at least]
    const DOORS = [
      ["routes/participants.js", "post", "/api/admin/competitions/assign", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/:id/tags", "_privilegedTarget(req", 1],
      ["routes/participants.js", "delete", "/api/admin/participants/:id/tags/:tag", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/:id/approve", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/:id/deny", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/bulk-approve", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/:id/block", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/:id/unlock", "_privilegedTarget(req", 1],
      ["routes/participants.js", "post", "/api/admin/participants/:id/login-code/email", "_privilegedTarget(req", 1],
      ["routes/participants.js", "put", "/api/admin/participants/:id", "_privilegedTarget(req", 1],
      ["routes/participants.js", "delete", "/api/admin/participants/:id", "_privilegedTarget(req", 1],
      ["routes/groups.js", "post", "/api/admin/participants/:id/groups", "_privilegedTarget(req", 1],
      ["routes/groups.js", "delete", "/api/admin/participants/:id/groups/:groupId", "_privilegedTarget(req", 1],
      ["routes/groups.js", "post", "/api/admin/groups", "_privilegedGroupTargets(req", 1],
      ["routes/groups.js", "post", "/api/admin/groups/:id/members", "_privilegedGroupTargets(req", 1],
      ["routes/groups.js", "delete", "/api/admin/groups/:id/members/:userId", "_privilegedGroupTargets(req", 1],
      // The compete-event skip, the group skip and the auto-approve.
      ["routes/invitations.js", "post", "/api/admin/invitations", "_privilegedTarget(req", 3],
      ["routes/challenges.js", "post", "/api/admin/tasks/:id/attempt-grant", "privilegedTargetFor(req", 1],
    ];
    const REG = /\n[ \t]*app\.(?:get|post|put|delete|patch)\(/g;
    const missing = [];
    for (const [rel, method, route, call, min] of DOORS) {
      const s = src(rel);
      const key = `app.${method}(${JSON.stringify(route)}`;
      const at = s.indexOf(key);
      if (at < 0) { missing.push(`${rel}: no ${method.toUpperCase()} ${route} registration`); continue; }
      REG.lastIndex = at + key.length;
      const next = REG.exec(s);
      const handler = s.slice(at, next ? next.index : s.length);
      const n = handler.split(call).length - 1;
      if (n < min) missing.push(`${rel}: ${method.toUpperCase()} ${route} calls ${call}…) ${n} time(s), wants ${min}`);
    }
    // The group helper the three group-member doors share.
    const g = src("routes/groups.js");
    const helper = g.slice(g.indexOf("function _privilegedGroupTargets("), g.indexOf("\n}\n", g.indexOf("function _privilegedGroupTargets(")));
    if (!/_privilegedTarget\(req,/.test(helper)) missing.push("routes/groups.js: _privilegedGroupTargets does not call _privilegedTarget(req, …)");
    // Each module's local name really is the predicate.
    for (const rel of ["routes/participants.js", "routes/groups.js", "routes/invitations.js"]) {
      if (!/privilegedTargetFor:\s*_privilegedTarget\b/.test(src(rel))) missing.push(`${rel}: _privilegedTarget is not lib/rbac.js privilegedTargetFor`);
    }
    // The client predicate decides a custom role by the server's answer.
    const c = src("public/js/features/participants-admin.js");
    const fnAt = c.indexOf("export function targetPrivilegedFor(");
    const fn = c.slice(fnAt, c.indexOf("\n}", fnAt));
    if (fnAt < 0 || !/\.privileged_target\b/.test(fn)) missing.push("public/js/features/participants-admin.js: targetPrivilegedFor does not read the row's privileged_target");
    expect(missing, "privileged-target doors that do not ask lib/rbac.js privilegedTargetFor").toEqual([]);
  });
});
