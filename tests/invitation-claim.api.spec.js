// @ts-check
//
// THE INVITATION CLAIM AT AN EXISTING ACCOUNT'S EMAILED-CODE SIGN-IN
// (lib/invitation-claim.js `claimInvitationsForAccount`, called by the code
// redeem in routes/auth.js for an EMAILED code only).
//
// POST /api/admin/invitations never stores an invitation for an address an
// account already holds (it enrols directly), so a live invitation meets an
// existing account only when it was stored before the account existed: an
// invitee who registered on their own before using it (before email-first the
// invitation's link then answered "already registered" and left it live), or a
// held sign-up whose inviter may not approve (tests/enrol-only-approval.api.spec.js
// drives that path to "the first sign-in joins the event"). The arms below plant
// the invitation row for an existing participant, as
// tests/signin-hardening.api.spec.js does, and drive the real redeem.
//
// What the claim grants, each with its control:
//   * the invitation's events (a direct row assigned by the inviter, recorded
//     `added_to_competition` / `user_added` with via "invitation_existing_account"
//     and the sign-in request's context) and its groups (`group_added`), and a
//     group bound to an event enrols the person there through group sync; a
//     DESK-code sign-in claims nothing (a desk code proves no inbox); somebody
//     removed and invited back gets their join time and solve-clock anchor back;
//   * what it still skips, the same per-event rules every admission door asks:
//     an event that has ended and takes no late entries; through a Booth Event's
//     late-entry window, somebody who took part before the end
//     (`late_entry_took_part`); a staff spectator (the `staff` tag, an event
//     where staff do not compete); an author of one of a staff-compete event's
//     challenges; and a group whose event's team board already holds the person
//     through another group. The invitation is claimed whatever was skipped, and
//     the claim goes on past a skip: in every arm the skipped event or group is
//     listed BEFORE a grant on the same invitation that must go through, so a
//     skip that ended the claim (a `break` or `return` where the code
//     `continue`s) fails its arm.
//   * DECIDED (19 Sep 2026, operator; ROLES_AND_PERMISSIONS.md): the claim
//     applies no privileged rule — an admin-role account claiming a REGULAR
//     admin's invitation into a staff-compete event is enrolled, where that
//     admin's direct assign of the same pair is `skippedPrivileged`.
const path = require("path");
const crypto = require("crypto");
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, TEST_DB_PATH, TEST_DATA_DIR, findLogLine } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { liveBooth, expireEvent, participantCtx, submit, rawBackdate, MIN } = require("./late-entry-fixture");

const LOGS = path.join(TEST_DATA_DIR, "logs");

// better-sqlite3 opened per call, never at module scope (the per-file recycle
// recreates the database file).
function sql(fn, readonly = true) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, readonly ? { readonly: true } : {});
  try { return fn(db); } finally { db.close(); }
}
const cuRow = (compId, userId) => sql(db => db.prepare("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));
const inGroup = (groupId, userId) => sql(db => db.prepare("SELECT * FROM group_members WHERE group_id=? AND user_id=?").get(groupId, userId));
const invitationRow = (id) => sql(db => db.prepare("SELECT used_at, user_id FROM invitations WHERE id=?").get(id));
function userEvents(userId, type) {
  return sql(db => db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type=? ORDER BY rowid").all(userId, type))
    .map(r => ({ by: r.changed_by, d: JSON.parse(r.details || "{}") }));
}
function compEvents(compId, type) {
  return sql(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type=? ORDER BY rowid").all(compId, type))
    .map(r => ({ by: r.changed_by, d: JSON.parse(r.details || "{}") }));
}

/**
 * A live invitation for `email`, stored as it would have been before the account
 * existed. `inviter` is the account recorded as having sent it.
 */
function plantInvitation(email, inviter, { compIds = [], groupIds = [] } = {}) {
  const id = crypto.randomUUID();
  sql(db => db.prepare(
    "INSERT INTO invitations (id, email, competition_ids, group_ids, invited_by, invited_by_id, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, email, JSON.stringify(compIds), JSON.stringify(groupIds), inviter.email, inviter.id, new Date().toISOString()), false);
  expect(invitationRow(id), "PRECONDITION: the planted invitation is live").toEqual({ used_at: null, user_id: null });
  return id;
}

/** Every invitation-claim skip line in the app log for `userId`, oldest first (read once the expected one landed). */
function claimSkips(userId) {
  const fs = require("fs");
  const out = [];
  for (const f of fs.readdirSync(LOGS).filter(f => f.startsWith("app-") && f.endsWith(".jsonl")).sort()) {
    for (const l of fs.readFileSync(path.join(LOGS, f), "utf8").split("\n")) {
      let j; try { j = JSON.parse(l); } catch (_) { continue; }
      if (j && j.tag === "invitation" && j.user_id === userId) out.push(j);
    }
  }
  return out;
}

/**
 * The skip's app-log line, by its reason: it names the invitation by its
 * fingerprint, never its id, and carries the sign-in's context. Then the claim
 * logged no other skip (the joined grants on the same invitation log nothing).
 */
async function expectSkipLogged(userId, invitationId, reason, key, id) {
  const line = await findLogLine(LOGS, j => j.tag === "invitation" && j.user_id === userId && j.reason === reason && j[key] === id,
    { what: `the ${reason} skip of ${id} in the app log` });
  expect(line.level, "logged as a warning").toBe("warn");
  expect(line.invitation_fp, "the invitation by its fingerprint").toMatch(/^if_/);
  expect(JSON.stringify(line), "never the invitation id itself").not.toContain(invitationId);
  expect(line.ip, "with the sign-in request's context").toBeTruthy();
  expect(claimSkips(userId).map(j => [j.reason, j[key]]), "CONTROL: no skip logged for a grant that went through").toEqual([[reason, id]]);
}

/** Sign in by an EMAILED code (the door that claims); the browser is then dropped. */
async function emailedCodeSignIn(email) {
  const s = await apiLogin(email);
  await s.api.dispose();
}

async function makeGroup(api, csrf, label, userIds = []) {
  const r = await api.post("/api/admin/groups", { headers: H(csrf), data: { name: `IC ${label} ${crypto.randomUUID().slice(0, 8)}`, userIds } });
  expect(r.ok(), `create group ${label}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).group.id;
}
async function bindGroup(api, csrf, groupId, compId) {
  const r = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { groupIds: [groupId], competitionIds: [compId] } });
  expect(r.ok(), `bind group: ${await r.text()}`).toBeTruthy();
}
async function compRow(api, compId) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const row = list.find(c => c.id === compId);
  expect(row, `event ${compId} is in the admin list`).toBeTruthy();
  return row;
}
async function promote(api, csrf, userId, role) {
  const r = await api.post(`/api/admin/participants/${userId}/role`, { headers: H(csrf), data: { role } });
  expect(r.ok(), `promote to ${role}: ${await r.text()}`).toBeTruthy();
}

let sa, saCsrf, inviter;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  // The invitations' sender: a user-backed REGULAR admin, so the attribution of
  // every grant can be read back by value (and the 19 Sep ruling's contrast has a
  // non-superadmin inviter).
  const r = await makeParticipant(sa, saCsrf, "icinviter");
  await promote(sa, saCsrf, r.id, "admin");
  inviter = r;
});
test.afterAll(async () => { await sa?.dispose(); });

test.describe("an existing account's emailed-code sign-in claims its live invitation", () => {
  test("enrolled in the invitation's event and added to its group, by the inviter and with the sign-in's context; the group's bound event follows; a desk-code sign-in claims nothing (CONTROL)", async () => {
    const E = await makeCompetition(sa, saCsrf, "ic-event");
    const Eb = await makeCompetition(sa, saCsrf, "ic-bound");
    const G = await makeGroup(sa, saCsrf, "grp");
    await bindGroup(sa, saCsrf, G, Eb.id);
    const p = await makeParticipant(sa, saCsrf, "icp");
    const inv = plantInvitation(p.email, inviter, { compIds: [E.id], groupIds: [G] });

    // CONTROL FIRST — a DESK code signs the person in and claims nothing: it was
    // read out by an organiser and proves nothing about the inbox.
    const rv = await sa.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: H(saCsrf) });
    expect(rv.status(), `desk reveal: ${await rv.text()}`).toBe(200);
    const desk = await freshCtx();
    try {
      const rd = await desk.api.post("/api/auth/code/redeem", { headers: H(desk.csrf), data: { email: p.email, code: (await rv.json()).code } });
      expect((await rd.json()).ok, "PRECONDITION: the desk code signs in").toBe(true);
    } finally { await desk.api.dispose(); }
    expect(invitationRow(inv), "a desk-code sign-in leaves the invitation live").toEqual({ used_at: null, user_id: null });
    expect(cuRow(E.id, p.id), "…enrols nobody").toBeFalsy();
    expect(inGroup(G, p.id), "…and adds nobody to its group").toBeFalsy();

    await emailedCodeSignIn(p.email);

    const claimed = invitationRow(inv);
    expect(claimed.user_id, "the emailed code claims the invitation for this account").toBe(p.id);
    expect(claimed.used_at).toBeTruthy();
    const row = cuRow(E.id, p.id);
    expect(row, "enrolled in the invitation's event").toBeTruthy();
    expect(row.assigned_by, "assigned by the inviter").toBe(inviter.email);
    expect(row.direct_assigned, "a direct membership, not a group one").toBe(1);
    const added = userEvents(p.id, "added_to_competition").filter(e => e.d.competition_id === E.id);
    expect(added, "one join on the person's History").toHaveLength(1);
    expect(added[0].by, "attributed to the inviter").toBe(inviter.email);
    expect(added[0].d.via).toBe("invitation_existing_account");
    expect(added[0].d.competition_name).toBe(E.name);
    expect(added[0].d.ip, "with the sign-in request's source address").toBeTruthy();
    expect(added[0].d.late_entry, "a live event's join is not a late entry").toBeUndefined();
    const ua = compEvents(E.id, "user_added").filter(e => e.d.user_id === p.id);
    expect(ua, "and on the event's History").toHaveLength(1);
    expect(ua[0].by).toBe(inviter.email);
    expect(ua[0].d.via).toBe("invitation_existing_account");
    const gm = inGroup(G, p.id);
    expect(gm, "added to the invitation's group").toBeTruthy();
    expect(gm.added_by).toBe(inviter.email);
    const ga = userEvents(p.id, "group_added").filter(e => e.d.group_id === G);
    expect(ga).toHaveLength(1);
    expect(ga[0].by).toBe(inviter.email);
    expect(ga[0].d.via).toBe("invitation_existing_account");
    // The group is bound to Eb, so group sync (after the claim commits, detached)
    // enrols the new member there as a GROUP member.
    await expect.poll(() => cuRow(Eb.id, p.id)?.direct_assigned ?? null,
      { message: "the group's bound event enrols the new member through the group" }).toBe(0);
  });

  test("somebody removed from the event and invited back gets their join time and solve-clock anchor back, as at every re-add", async () => {
    // Re-anchoring a returning player at the claim would restart their clock
    // (CLAUDE.md, *Solve clock*: a rejoin restores the saved anchor).
    const E = await makeCompetition(sa, saCsrf, "ic-readd");
    const p = await makeParticipant(sa, saCsrf, "icreadd");
    await enrol(sa, saCsrf, E.id, [p.id]);
    const pc = await participantCtx(p.email, E.id);   // they enter: the anchor is stamped
    await pc.api.dispose();
    const before = cuRow(E.id, p.id);
    expect(before.login_time, "PRECONDITION: they entered the event").toBeTruthy();
    const rm = await sa.delete(`/api/admin/competitions/${E.id}/users/${p.id}`, { headers: H(saCsrf) });
    expect(rm.status(), `remove: ${await rm.text()}`).toBe(200);
    expect(cuRow(E.id, p.id), "PRECONDITION: removed").toBeFalsy();
    plantInvitation(p.email, inviter, { compIds: [E.id] });

    await emailedCodeSignIn(p.email);

    const after = cuRow(E.id, p.id);
    expect(after, "re-added by the claim").toBeTruthy();
    expect(after.login_time, "the solve-clock anchor is restored, not restarted").toBe(before.login_time);
    expect(after.assigned_at, "and the join time").toBe(before.assigned_at);
    const absences = sql(db => db.prepare("SELECT returned_at FROM competition_user_absences WHERE competition_id=? AND user_id=?").all(E.id, p.id));
    expect(absences, "the removal's absence is closed").toHaveLength(1);
    expect(absences[0].returned_at).toBeTruthy();
  });
});

test.describe("what the claim still skips — each with a grant on the same invitation that goes through", () => {
  test("an event that has ended and takes no late entries is skipped (a Competition's end, a Booth Event whose window has closed); a live event on the same invitation is joined", async () => {
    const live = await makeCompetition(sa, saCsrf, "ic-live");
    const t = await liveBooth(sa, saCsrf, { kind: "tournament" });
    const b = await liveBooth(sa, saCsrf);
    await expireEvent(t.comp.id, { agoMinutes: 30 });
    await expireEvent(b.comp.id, { agoMinutes: 49 * 60 });
    for (const id of [t.comp.id, b.comp.id]) {
      const c = await compRow(sa, id);
      expect(c.status, `PRECONDITION: ${c.name} has ended`).toBe("ended");
      expect(c.late_entry_window_open, `PRECONDITION: ${c.name} takes no late entries`).toBe(false);
    }
    const p = await makeParticipant(sa, saCsrf, "icended");
    const inv = plantInvitation(p.email, inviter, { compIds: [t.comp.id, b.comp.id, live.id] });

    await emailedCodeSignIn(p.email);

    expect(invitationRow(inv).user_id, "the invitation is claimed whatever was skipped").toBe(p.id);
    expect(cuRow(live.id, p.id), "CONTROL: the live event on the same invitation is joined").toBeTruthy();
    expect(cuRow(t.comp.id, p.id), "an ended Competition is skipped").toBeFalsy();
    expect(cuRow(b.comp.id, p.id), "a Booth Event whose late-entry window has closed is skipped").toBeFalsy();
    expect(userEvents(p.id, "added_to_competition").map(e => e.d.competition_id), "only the live event's join is recorded").toEqual([live.id]);
    for (const id of [t.comp.id, b.comp.id]) {
      await findLogLine(LOGS, j => j.tag === "invitation" && j.user_id === p.id && j.competition_id === id
        && /ended and is not taking late entries/.test(String(j.msg)), { what: `the skip of ${id} in the app log` });
    }
  });

  test("through a Booth Event's open late-entry window: somebody who took part before the end is skipped (late_entry_took_part) while the live event and the group listed after it on the same invitation are joined; a newcomer's invitation admits them as a late entrant (CONTROL)", async () => {
    const b = await liveBooth(sa, saCsrf, { tasks: 1 });
    // What the same invitation grants AFTER the skipped event: the claim must go
    // on past the skip to the rest of the invitation.
    const live = await makeCompetition(sa, saCsrf, "ic-played-live");
    const loose = await makeGroup(sa, saCsrf, "played-loose");
    const played = await makeParticipant(sa, saCsrf, "icplayed");
    const fresh = await makeParticipant(sa, saCsrf, "icfresh");
    await enrol(sa, saCsrf, b.comp.id, [played.id]);
    const pc = await participantCtx(played.email, b.comp.id);
    try { expect((await (await submit(pc.api, pc.csrf, b.taskIds[0])).json()).correct, "PRECONDITION: they played").toBe(true); }
    finally { await pc.api.dispose(); }
    const rm = await sa.delete(`/api/admin/competitions/${b.comp.id}/users/${played.id}`, { headers: H(saCsrf) });
    expect(rm.status(), `removed while live: ${await rm.text()}`).toBe(200);
    const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
    // The fixture trap (tests/late-entry-fixture.js): moving the start re-timed the
    // event, so the answer is put back before the end it was given before.
    rawBackdate("submissions", "submitted_at", b.comp.id, played.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
    const c = await compRow(sa, b.comp.id);
    expect(c.status, "PRECONDITION: the event has ended").toBe("ended");
    expect(c.late_entry_window_open, "PRECONDITION: its late-entry window is open").toBe(true);
    expect(cuRow(b.comp.id, played.id), "PRECONDITION: they hold no row").toBeFalsy();
    expect(cuRow(live.id, played.id) || inGroup(loose, played.id), "PRECONDITION: nor a row in the live event or a place in the group").toBeFalsy();

    // The skipped event comes FIRST, so the grants after it show the claim went on.
    const invPlayed = plantInvitation(played.email, inviter, { compIds: [b.comp.id, live.id], groupIds: [loose] });
    const invFresh = plantInvitation(fresh.email, inviter, { compIds: [b.comp.id] });
    await emailedCodeSignIn(played.email);
    await emailedCodeSignIn(fresh.email);

    expect(invitationRow(invPlayed).user_id, "the invitation is claimed whatever was skipped").toBe(played.id);
    expect(cuRow(b.comp.id, played.id), "no new row for somebody who took part before the end").toBeFalsy();
    const liveRow = cuRow(live.id, played.id);
    expect(liveRow, "CONTROL: the live event listed after the skipped one on the same invitation is joined").toBeTruthy();
    expect(liveRow.assigned_by, "…assigned by the inviter").toBe(inviter.email);
    expect(userEvents(played.id, "added_to_competition").filter(e => e.d.via === "invitation_existing_account").map(e => e.d.competition_id),
      "only the live event's join is recorded, none for the skipped one").toEqual([live.id]);
    expect(inGroup(loose, played.id), "CONTROL: …and so is the invitation's group").toBeTruthy();
    expect(userEvents(played.id, "group_added").filter(e => e.d.via === "invitation_existing_account").map(e => e.d.group_id),
      "…recorded as the invitation's").toEqual([loose]);
    await findLogLine(LOGS, j => j.tag === "invitation" && j.code === "late_entry_took_part"
      && j.user_id === played.id && j.competition_id === b.comp.id, { what: "the took-part skip in the app log" });

    expect(invitationRow(invFresh).user_id).toBe(fresh.id);
    const row = cuRow(b.comp.id, fresh.id);
    expect(row, "CONTROL: a newcomer is admitted through the window").toBeTruthy();
    expect(new Date(row.assigned_at).getTime(), "…after the end, so as a late entrant").toBeGreaterThan(effEnd.getTime());
    const added = userEvents(fresh.id, "added_to_competition").filter(e => e.d.competition_id === b.comp.id);
    expect(added).toHaveLength(1);
    expect(added[0].d).toMatchObject({ via: "invitation_existing_account", late_entry: true });
    expect(compEvents(b.comp.id, "user_added").filter(e => e.d.user_id === fresh.id).map(e => e.d.late_entry)).toEqual([true]);
  });

  test("a staff spectator is skipped where staff do not compete and joined where they do (CONTROL)", async () => {
    const off = await makeCompetition(sa, saCsrf, "ic-staff-off", { staff_compete: false });
    const on = await makeCompetition(sa, saCsrf, "ic-staff-on", { staff_compete: true });
    const s = await makeParticipant(sa, saCsrf, "icstaff");
    const tg = await sa.post(`/api/admin/participants/${s.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
    expect(tg.ok(), `tag staff: ${await tg.text()}`).toBeTruthy();
    expect((await tg.json()).tags, "PRECONDITION: tagged staff").toContain("staff");
    const inv = plantInvitation(s.email, inviter, { compIds: [off.id, on.id] });

    await emailedCodeSignIn(s.email);

    expect(invitationRow(inv).user_id).toBe(s.id);
    expect(cuRow(off.id, s.id), "a staff spectator gets no row on an event where staff do not compete").toBeFalsy();
    expect(cuRow(on.id, s.id), "CONTROL: and is enrolled where staff compete").toBeTruthy();
    await expectSkipLogged(s.id, inv, "staff_spectator", "competition_id", off.id);
  });

  test("an author of one of a staff-compete event's challenges is skipped there and joins another staff-compete event; an admin-role claimant is enrolled where a regular admin's direct assign is skippedPrivileged (DECIDED 19 Sep 2026)", async () => {
    const authored = await makeCompetition(sa, saCsrf, "ic-authored", { staff_compete: true });
    const other = await makeCompetition(sa, saCsrf, "ic-other", { staff_compete: true });
    const contrast = await makeCompetition(sa, saCsrf, "ic-contrast", { staff_compete: true });
    const a = await makeParticipant(sa, saCsrf, "icauthor");
    await promote(sa, saCsrf, a.id, "admin");
    // The admin authors a sealed challenge (a staff-compete event holds sealed
    // challenges only) and assigns it to `authored` — before the invitation
    // exists, as this sign-in would otherwise claim it.
    const as = await apiLogin(a.email);
    try {
      const t = await makeTask(as.api, as.csrf, "icauthored", { answer_sealed: true });
      await assignTask(as.api, as.csrf, t.id, [authored.id]);
    } finally { await as.api.dispose(); }
    // The contrast: the REGULAR admin who sent the invitation cannot enrol a
    // fellow admin into a staff-compete event directly.
    const r = await apiLogin(inviter.email);
    try {
      const d = await (await r.api.post("/api/admin/competitions/assign", { headers: H(r.csrf), data: { userIds: [a.id], competitionIds: [contrast.id] } })).json();
      expect(d.skippedPrivileged, `CONTRAST: the direct assign of the same pair is refused: ${JSON.stringify(d)}`).toBe(1);
    } finally { await r.api.dispose(); }
    expect(cuRow(contrast.id, a.id), "CONTRAST: no row from the direct assign").toBeFalsy();
    const inv = plantInvitation(a.email, inviter, { compIds: [authored.id, other.id] });

    await emailedCodeSignIn(a.email);

    expect(invitationRow(inv).user_id).toBe(a.id);
    expect(cuRow(authored.id, a.id), "an author of one of its challenges cannot compete there").toBeFalsy();
    await expectSkipLogged(a.id, inv, "challenge_author", "competition_id", authored.id);
    const row = cuRow(other.id, a.id);
    expect(row, "CONTROL + RULING: the admin-role account is enrolled in the other staff-compete event, no privileged rule asked").toBeTruthy();
    expect(row.assigned_by).toBe(inviter.email);
  });

  test("a group whose event's team board already holds the person through another group is skipped; a group bound nowhere, and one bound to an event without a team board, are joined (CONTROLS)", async () => {
    const gl = await makeCompetition(sa, saCsrf, "ic-board", { group_leaderboard_enabled: true });
    const nogl = await makeCompetition(sa, saCsrf, "ic-noboard", { group_leaderboard_enabled: false });
    const p = await makeParticipant(sa, saCsrf, "icclash");
    const held = await makeGroup(sa, saCsrf, "held", [p.id]);
    await bindGroup(sa, saCsrf, held, gl.id);
    const clash = await makeGroup(sa, saCsrf, "clash");
    await bindGroup(sa, saCsrf, clash, gl.id);
    const heldNo = await makeGroup(sa, saCsrf, "heldno", [p.id]);
    await bindGroup(sa, saCsrf, heldNo, nogl.id);
    const noBoard = await makeGroup(sa, saCsrf, "noboard");
    await bindGroup(sa, saCsrf, noBoard, nogl.id);
    const loose = await makeGroup(sa, saCsrf, "loose");
    expect(inGroup(held, p.id) && inGroup(heldNo, p.id), "PRECONDITION: already in a group bound to each event").toBeTruthy();
    const inv = plantInvitation(p.email, inviter, { groupIds: [clash, loose, noBoard] });

    await emailedCodeSignIn(p.email);

    expect(invitationRow(inv).user_id).toBe(p.id);
    expect(inGroup(clash, p.id), "a second group bound to an event whose team board holds them is skipped").toBeFalsy();
    expect(inGroup(loose, p.id), "CONTROL: a group bound nowhere is joined").toBeTruthy();
    expect(inGroup(noBoard, p.id), "CONTROL: the same shape on an event without a team board is joined").toBeTruthy();
    expect(userEvents(p.id, "group_added").filter(e => e.d.via === "invitation_existing_account").map(e => e.d.group_id).sort(),
      "only the joined groups are recorded").toEqual([loose, noBoard].sort());
    await expectSkipLogged(p.id, inv, "group_clash", "group_id", clash);
  });

  test("an event and a group that no longer exist are skipped and logged; the live event and the group listed after them are joined (CONTROLS)", async () => {
    const live = await makeCompetition(sa, saCsrf, "ic-gone-live");
    const loose = await makeGroup(sa, saCsrf, "gone-loose");
    const goneComp = crypto.randomUUID(), goneGroup = crypto.randomUUID();
    const p = await makeParticipant(sa, saCsrf, "icgone");
    const inv = plantInvitation(p.email, inviter, { compIds: [goneComp, live.id], groupIds: [goneGroup, loose] });

    await emailedCodeSignIn(p.email);

    expect(invitationRow(inv).user_id, "the invitation is claimed whatever was skipped").toBe(p.id);
    expect(cuRow(live.id, p.id), "CONTROL: the live event listed after the missing one is joined").toBeTruthy();
    expect(inGroup(loose, p.id), "CONTROL: the group listed after the missing one is joined").toBeTruthy();
    const dl = await findLogLine(LOGS, j => j.tag === "invitation" && j.user_id === p.id && j.reason === "event_deleted" && j.competition_id === goneComp,
      { what: "the missing event's skip in the app log" });
    const gl = await findLogLine(LOGS, j => j.tag === "invitation" && j.user_id === p.id && j.reason === "group_deleted" && j.group_id === goneGroup,
      { what: "the missing group's skip in the app log" });
    for (const line of [dl, gl]) {
      expect(line.level).toBe("warn");
      expect(line.invitation_fp).toMatch(/^if_/);
      expect(JSON.stringify(line), "never the invitation id itself").not.toContain(inv);
    }
    expect(claimSkips(p.id).map(j => j.reason).sort(), "CONTROL: nothing logged for the grants that went through").toEqual(["event_deleted", "group_deleted"]);
  });
});
