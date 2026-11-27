// @ts-check
//
// A SIGN-IN THROUGH A BOOTH EVENT'S LATE-ENTRY WINDOW DOES NOT RE-ADMIT SOMEBODY
// WHO PLAYED IT.
//
// Two doors enrol at a sign-in, both through lib/self-enroll.js `_enrolAtSignIn`:
//   * a sign-in code requested from the event's join link and redeemed in the
//     same browser (the code is bound to the event: routes/auth.js
//     `_consumeCodeBoundEnroll`);
//   * the join a join-link registration deferred to the first sign-in
//     (`pending_self_enroll_comp_id`, consumed by `_consumePendingSelfEnroll`).
// Through the late-entry window (`competitionAdmission` = "late") neither may give
// a NEW row to somebody who took part before the end: the second try would put a
// finisher back on the late board (`late_entry_took_part`, the rule the join link,
// assign, invitation and group doors answer in tests/late-entry-assignment.api.spec.js).
// There is nobody to tell at that moment, so the refusal is logged; the sign-in
// itself goes through. Each refusal has its control: a newcomer through the same
// door is admitted as a late entrant. Nor is a row PROMOTED: an original member's
// group row is left exactly as it was, where a late entrant's is promoted
// (lib/self-enroll.js `_selfEnrollEnrollTxn`).
//
// THE FIXTURE TRAP (tests/late-entry-fixture.js): an event is ended by moving its
// start into the past, which re-times everything done while it was live to AFTER
// the new end; the "took part before the end" answers are back-dated explicitly.
const path = require("path");
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, PARTICIPANT_PASS, BASE, TEST_DB_PATH, TEST_DATA_DIR, findLogLine } = require("./helpers");
const { H, uniq, makeParticipant, enrol } = require("./event-admin-helpers");
const { liveBooth, expireEvent, participantCtx, submit, rawBackdate, rawSetAssignedAt, MIN } = require("./late-entry-fixture");

test.use({ baseURL: BASE });

const LOGS = path.join(TEST_DATA_DIR, "logs");

function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const cuRow = (compId, userId) => sql(db => db.prepare("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));
const userRow = (id) => sql(db => db.prepare("SELECT login_code_comp_id, pending_self_enroll_comp_id, login_time, approved FROM users WHERE id=?").get(id));
function selfEnrolled(userId, compId) {
  return sql(db => db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='self_enrolled' ORDER BY rowid").all(userId))
    .map(r => ({ by: r.changed_by, d: JSON.parse(r.details || "{}") })).filter(e => e.d.competition_id === compId);
}
function joinsOnEvent(compId, userId) {
  return sql(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='user_added' ORDER BY rowid").all(compId))
    .map(r => ({ by: r.changed_by, d: JSON.parse(r.details || "{}") })).filter(e => e.d.user_id === userId && e.d.via === "self_enroll");
}
function promotions(compId, userId) {
  return sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='membership_promoted' ORDER BY rowid").all(compId))
    .map(r => JSON.parse(r.details || "{}")).filter(d => d.user_id === userId);
}
const tookPartLine = (userId, compId) => findLogLine(LOGS,
  j => j.tag === "self_enroll" && j.code === "late_entry_took_part" && j.user_id === userId && j.competition_id === compId,
  { what: `the late_entry_took_part refusal for ${userId} in the app log` });

async function joinToken(api, compId) {
  const r = await api.get(`/api/admin/competitions/${compId}/self-enroll`);
  expect(r.ok(), `reveal join link: ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.enabled, "PRECONDITION: the join link is open").toBe(true);
  return d.token;
}

/** PRECONDITION, read the way a visitor's browser reads it: ended, and taking late entries. */
async function expectLateWindowOpen(api, token) {
  const r = await api.get(`/api/competitions/self-enroll/${token}`);
  expect(r.status(), "PRECONDITION: the join link still opens the event").toBe(200);
  expect(await r.json(), "PRECONDITION: ended, with its late-entry window open").toMatchObject({ status: "ended", late_entry_window_open: true });
}

async function removeWhileLive(api, csrf, compId, userId) {
  const r = await api.delete(`/api/admin/competitions/${compId}/users/${userId}`, { headers: H(csrf) });
  expect(r.status(), `remove while live: ${await r.text()}`).toBe(200);
  expect(cuRow(compId, userId), "PRECONDITION: removed").toBeFalsy();
}

/**
 * One browser asks for a code from the event's join link, then redeems it: the
 * code is bound to the event, and the binding counts in the browser that asked.
 */
async function signInFromLink(playwright, who, token, compId) {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  try {
    const h = { "x-csrf-token": (await (await ctx.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" };
    await ctx.post("/api/test/reset-recent-code-sends", { headers: h });
    expect((await ctx.post("/api/auth/code/request", { headers: h, data: { email: who.email, joinToken: token } })).status()).toBe(200);
    expect(userRow(who.id).login_code_comp_id, "PRECONDITION: the code is bound to the event").toBe(compId);
    const c = await (await ctx.get("/api/test/last-login-code?email=" + encodeURIComponent(who.email))).json();
    const rd = await (await ctx.post("/api/auth/code/redeem", { headers: h, data: { email: who.email, code: c.code } })).json();
    expect(rd.ok, `the sign-in itself goes through: ${JSON.stringify(rd)}`).toBe(true);
  } finally { await ctx.dispose(); }
}

let sa, saCsrf;
test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
test.afterAll(async () => { await sa?.dispose(); });

test("a code requested from the join link in the late-entry window does not re-admit somebody who played the event; a newcomer's joins them as a late entrant (CONTROL)", async ({ playwright }) => {
  const b = await liveBooth(sa, saCsrf, { tasks: 1 });
  const token = await joinToken(sa, b.comp.id);
  const played = await makeParticipant(sa, saCsrf, "lwplayed");
  const fresh = await makeParticipant(sa, saCsrf, "lwfresh");
  await enrol(sa, saCsrf, b.comp.id, [played.id]);
  const pc = await participantCtx(played.email, b.comp.id);
  try { expect((await (await submit(pc.api, pc.csrf, b.taskIds[0])).json()).correct, "PRECONDITION: they played").toBe(true); }
  finally { await pc.api.dispose(); }
  await removeWhileLive(sa, saCsrf, b.comp.id, played.id);
  const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
  rawBackdate("submissions", "submitted_at", b.comp.id, played.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
  await expectLateWindowOpen(sa, token);

  await signInFromLink(playwright, played, token, b.comp.id);
  expect(cuRow(b.comp.id, played.id), "no new row for somebody who took part before the end").toBeFalsy();
  expect(selfEnrolled(played.id, b.comp.id), "and no join recorded").toEqual([]);
  expect(joinsOnEvent(b.comp.id, played.id)).toEqual([]);
  await tookPartLine(played.id, b.comp.id);

  await signInFromLink(playwright, fresh, token, b.comp.id);
  const row = cuRow(b.comp.id, fresh.id);
  expect(row, "CONTROL: a newcomer's code from the same link joins them").toBeTruthy();
  expect(row.assigned_by).toBe("self_enroll");
  expect(new Date(row.assigned_at).getTime(), "…after the end: a late entrant").toBeGreaterThan(effEnd.getTime());
  const mine = selfEnrolled(fresh.id, b.comp.id);
  expect(mine, "the join is the person's own").toHaveLength(1);
  expect(String(mine[0].by).toLowerCase()).toBe(fresh.email.toLowerCase());
  expect(mine[0].d.late_entry, "marked a late entry").toBe(true);
  expect(mine[0].d.ip, "with the sign-in request's context").toBeTruthy();
  expect(joinsOnEvent(b.comp.id, fresh.id).map(e => e.d.late_entry)).toEqual([true]);
});

test("through the same door a held row is left exactly as it was: an original group member who played is not promoted; a late entrant's group row is (CONTROL)", async ({ playwright }) => {
  // Neither a new row nor a PROMOTED one: a held row of somebody who was in the
  // event before it ended is a true no-op through the window (promoting it would
  // reshape the final roster); a late entrant's is promoted, as at the join link.
  const b = await liveBooth(sa, saCsrf, { tasks: 1 });
  const token = await joinToken(sa, b.comp.id);
  const orig = await makeParticipant(sa, saCsrf, "lworig");
  const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `LW ${uniq("grp")}`, userIds: [orig.id] } });
  expect(g.ok(), `create group: ${await g.text()}`).toBeTruthy();
  const groupId = (await g.json()).group.id;
  const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [groupId], competitionIds: [b.comp.id] } });
  expect(bind.ok(), `bind the group while live: ${await bind.text()}`).toBeTruthy();
  expect(cuRow(b.comp.id, orig.id)?.direct_assigned, "PRECONDITION: a group-origin row").toBe(0);
  const pc = await participantCtx(orig.email, b.comp.id);
  try { expect((await (await submit(pc.api, pc.csrf, b.taskIds[0])).json()).correct, "PRECONDITION: they played").toBe(true); }
  finally { await pc.api.dispose(); }
  const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
  rawSetAssignedAt(b.comp.id, orig.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
  rawBackdate("submissions", "submitted_at", b.comp.id, orig.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
  // A walk-up added to the bound group in the window: a group-origin LATE ENTRANT.
  const late = await makeParticipant(sa, saCsrf, "lwlate");
  const add = await sa.post(`/api/admin/groups/${groupId}/members`, { headers: H(saCsrf), data: { userIds: [late.id] } });
  expect(add.ok(), `add to the group in the window: ${await add.text()}`).toBeTruthy();
  const lateRow = cuRow(b.comp.id, late.id);
  expect(lateRow?.direct_assigned, "PRECONDITION: a group-origin row").toBe(0);
  expect(new Date(lateRow.assigned_at).getTime(), "PRECONDITION: made after the end").toBeGreaterThan(effEnd.getTime());
  await expectLateWindowOpen(sa, token);
  const before = cuRow(b.comp.id, orig.id);

  await signInFromLink(playwright, orig, token, b.comp.id);
  const after = cuRow(b.comp.id, orig.id);
  expect(after.direct_assigned, "an original member's row is not promoted").toBe(0);
  expect(after.assigned_at, "…its join time untouched").toBe(before.assigned_at);
  expect(promotions(b.comp.id, orig.id), "…and nothing recorded").toEqual([]);

  await signInFromLink(playwright, late, token, b.comp.id);
  expect(cuRow(b.comp.id, late.id).direct_assigned, "CONTROL: a late entrant's group row is promoted by the same door").toBe(1);
  const pr = promotions(b.comp.id, late.id);
  expect(pr, "CONTROL: …and the promotion is on the event's History").toHaveLength(1);
  expect(pr[0]).toMatchObject({ via: "self_enroll", late_entry: true });
});

test("the join a join-link registration deferred to the first sign-in, consumed in the late-entry window: somebody who played the event is not re-admitted and the marker is cleared; a newcomer's marker admits them as a late entrant (CONTROL)", async () => {
  const b = await liveBooth(sa, saCsrf, { tasks: 1 });
  const token = await joinToken(sa, b.comp.id);

  /** A NEW account registered through the join link, its join deferred to the first sign-in (marker set, no row). */
  const registerViaJoin = async (label) => {
    const tag = uniq(label);
    const email = `lw-${tag}@acme.com`;
    const anon = await freshCtx();
    try {
      const reg = await registerPost(anon.api, "/api/register", {
        headers: H(anon.csrf),
        data: {
          email, password: PARTICIPANT_PASS, joinToken: token,
          firstName: "Late", lastName: String(label), company: "Acme", title: "Engineer",
          country: "GB", timezone: "Europe/London",
        },
        deferJoin: true,
      });
      expect(reg.ok(), `register through the join link: ${await reg.text()}`).toBeTruthy();
    } finally { await anon.api.dispose(); }
    const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)).id;
    expect(userRow(id), "PRECONDITION: approved through the link, never signed in, the join deferred")
      .toMatchObject({ approved: 1, login_time: null, pending_self_enroll_comp_id: b.comp.id });
    expect(cuRow(b.comp.id, id), "PRECONDITION: no row until the first sign-in").toBeFalsy();
    return { id, email };
  };
  const played = await registerViaJoin("lwmplayed");
  const fresh = await registerViaJoin("lwmfresh");

  // They PLAY without signing in: every sign-in door consumes the marker, so the
  // only way to an account that took part and still holds one is an answer given
  // for them in a superadmin's impersonation (it stamps no sign-in and consumes
  // nothing), to which they were assigned while the event was live.
  await enrol(sa, saCsrf, b.comp.id, [played.id]);
  // On THIS file's superadmin session: a second sign-in of the built-in account
  // would end it (one session per principal). Entering and leaving regenerate the
  // session, so its CSRF token is re-read after each.
  const st = await sa.post(`/api/admin/participants/${played.id}/impersonate`, { headers: H(saCsrf) });
  expect(st.status(), `impersonate: ${await st.text()}`).toBe(200);
  saCsrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
  expect((await sa.post("/api/select-competition", { headers: H(saCsrf), data: { competitionId: b.comp.id } })).ok()).toBeTruthy();
  expect((await (await submit(sa, saCsrf, b.taskIds[0])).json()).correct, "PRECONDITION: an answer given for them").toBe(true);
  expect((await sa.post("/api/impersonation/exit", { headers: H(saCsrf) })).ok(), "back to the superadmin").toBeTruthy();
  saCsrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
  await removeWhileLive(sa, saCsrf, b.comp.id, played.id);
  expect(userRow(played.id), "PRECONDITION: still never signed in, the deferred join still pending")
    .toMatchObject({ login_time: null, pending_self_enroll_comp_id: b.comp.id });
  const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
  rawBackdate("submissions", "submitted_at", b.comp.id, played.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
  await expectLateWindowOpen(sa, token);

  await (await apiLogin(played.email)).api.dispose();
  expect(cuRow(b.comp.id, played.id), "no new row for somebody who took part before the end").toBeFalsy();
  expect(userRow(played.id).pending_self_enroll_comp_id, "the marker is cleared: a settled answer, not retried at every sign-in").toBeNull();
  expect(selfEnrolled(played.id, b.comp.id).filter(e => e.d.late_entry), "no late join recorded").toEqual([]);
  await tookPartLine(played.id, b.comp.id);

  await (await apiLogin(fresh.email)).api.dispose();
  const row = cuRow(b.comp.id, fresh.id);
  expect(row, "CONTROL: a newcomer's deferred join goes through in the window").toBeTruthy();
  expect(new Date(row.assigned_at).getTime(), "…after the end: a late entrant").toBeGreaterThan(effEnd.getTime());
  expect(userRow(fresh.id).pending_self_enroll_comp_id, "marker consumed").toBeNull();
  expect(selfEnrolled(fresh.id, b.comp.id).filter(e => e.d.late_entry).length, "the sign-in's join is marked a late entry").toBe(1);
});
