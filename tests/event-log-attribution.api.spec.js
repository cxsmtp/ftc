// @ts-check
//
// v7.21.32 — the operator's two standing rules for the event log:
//
//   1. Any state-changing action MUST emit an event-log entry.
//   2. Every entry caused by a USER must be attributed to that user AND carry
//      their source IP.
//
// A full audit of all 133 mutating routes found 43 gaps. Most were rule 2 —
// an emit with the right actor and no `reqContext`, so the History dialogs
// answered "who" and never "from where" — and those are held by a mechanical
// scanner (`functional-core.api.spec.js > Docs hygiene > "every user-driven
// event emit carries the requester's IP"`), because prose does not enumerate.
//
// This file holds the ones a scanner CANNOT see: a state change with no emit at
// all, and an emit naming the wrong actor. Those are behavioural, so they are
// tested behaviourally.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, serverLogTail, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

function userEvents(userId, type) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT event_type, changed_by, details FROM user_events WHERE user_id=? AND event_type=? ORDER BY rowid")
      .all(userId, type).map(r => ({ type: r.event_type, actor: r.changed_by, d: JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}
function compEvents(compId, type) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT event_type, changed_by, details FROM competition_events WHERE competition_id=? AND event_type=? ORDER BY rowid")
      .all(compId, type).map(r => ({ type: r.event_type, actor: r.changed_by, d: JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}

/** A participant of our own (fixture checklist #3). */
async function ownParticipant(tag) {
  const s = `${Date.now()}${Math.floor(Math.random() * 1e5)}${tag}`;
  const email = `ev${s}@company.com`;
  const { api, csrf } = await freshCtx();
  const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
    firstName: "Ev", lastName: "Ent", nickname: `ev${s}`.slice(0, 20), email,
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS } });
  expect(r.status(), await r.text()).toBe(200);
  await api.dispose();

  const { api: sa, csrf: sc } = await apiLogin("superadmin");
  try {
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.email === email);
    expect(u, "registered").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": sc } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": sc } });
    return { email, id: u.id };
  } finally { await sa.dispose(); }
}

test.describe("v7.21.32 — state changes that emitted NOTHING", () => {
  test("promoting a group-origin membership to direct is recorded", async () => {
    // `direct_assigned` decides whether live group-sync may ever auto-remove this
    // participant again. The promotion runs on an ALREADY-MEMBER row, and the
    // handler returned before any emit in exactly that case — so an operator
    // asking "who made this membership permanent?" had no answer at all.
    const p = await ownParticipant("a");
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const compId = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: {
        name: `EvPromote ${stamp}`, start_time: new Date(stamp + 3600_000).toISOString(), duration_minutes: 120,
      }})).json()).competition.id;
      const groupId = (await (await api.post("/api/admin/groups", { headers: h(csrf), data: {
        name: `EvGroup ${stamp}`, userIds: [p.id],
      }})).json()).group.id;
      // Bind the group → the participant is enrolled with direct_assigned = 0.
      const bind = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: { groupIds: [groupId], competitionIds: [compId] } });
      expect(bind.ok(), await bind.text()).toBeTruthy();
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, p.id)?.direct_assigned,
          "the fixture must start group-origin, or the promotion never happens").toBe(0);
      } finally { db.close(); }

      expect(compEvents(compId, "membership_promoted").length, "nothing yet").toBe(0);
      // Now assign them DIRECTLY — an already-member row being promoted.
      const promote = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: { userIds: [p.id], competitionIds: [compId] } });
      expect(promote.ok(), await promote.text()).toBeTruthy();

      const ev = compEvents(compId, "membership_promoted");
      expect(ev.length, "the promotion is recorded").toBe(1);
      expect(ev[0].actor, "attributed to the admin").toBe("superadmin");
      expect(ev[0].d.from_direct_assigned).toBe(0);
      expect(ev[0].d.to_direct_assigned).toBe(1);
      expect(ev[0].d.ip, "and carries the source IP").toBeTruthy();
      expect(userEvents(p.id, "membership_promoted").length, "on the participant's History too").toBe(1);

      // POSITIVE CONTROL: re-assigning an already-DIRECT member changes nothing,
      // so it must stay silent — or the log fills with noise on every re-save.
      const again = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: { userIds: [p.id], competitionIds: [compId] } });
      expect(again.ok()).toBeTruthy();
      expect(compEvents(compId, "membership_promoted").length, "a no-op emits nothing").toBe(1);
    } finally { await api.dispose(); }
  });

  test("the staff tag added or removed by a ROLE change is recorded", async () => {
    // The staff tag decides leaderboard exclusion. The tag write is
    // unconditional but the only emit was gated on the ROLE changing, so posting
    // the role a user already has silently added or removed it — no
    // `role_changed`, no tag event, nothing.
    const p = await ownParticipant("b");
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // Promote → staff tag added, alongside role_changed.
      expect((await api.post(`/api/admin/participants/${p.id}/role`, { headers: h(csrf), data: { role: "admin" } })).ok()).toBeTruthy();
      const added = userEvents(p.id, "tag_added");
      expect(added.length, "the staff tag is recorded when it is added").toBe(1);
      expect(added[0].d.tag).toBe("staff");
      expect(added[0].d.via).toBe("role_change");
      expect(added[0].actor).toBe("superadmin");
      expect(added[0].d.ip, "with the source IP").toBeTruthy();

      // THE GAP: post the SAME role again. The role does not change, but the
      // INSERT OR IGNORE is a no-op too — so nothing should be logged.
      expect((await api.post(`/api/admin/participants/${p.id}/role`, { headers: h(csrf), data: { role: "admin" } })).ok()).toBeTruthy();
      expect(userEvents(p.id, "tag_added").length, "a genuine no-op stays silent").toBe(1);

      // Demote → staff tag removed.
      expect((await api.post(`/api/admin/participants/${p.id}/role`, { headers: h(csrf), data: { role: "participant" } })).ok()).toBeTruthy();
      const removed = userEvents(p.id, "tag_removed");
      expect(removed.length, "…and when it is removed").toBe(1);
      expect(removed[0].d.tag).toBe("staff");
      expect(removed[0].d.ip).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("clearing a failed-login counter is recorded even when no lockout had fired", async () => {
    // `failed_login_count` is durable account state, not in-process rate-limit
    // bookkeeping. The emit was gated on the account being LOCKED, so an admin
    // zeroing the counter before the threshold could fire — repeatedly — left the
    // audit trail completely empty.
    const p = await ownParticipant("c");
    const { api: anon, csrf: ac } = await freshCtx();
    try {
      // Three failures: counted, but well under the lockout threshold. Every
      // account signs in with an emailed code, so a wrong well-formed code is
      // the failure that counts.
      await anon.post("/api/test/reset-recent-code-sends", { headers: h(ac) });
      await anon.post("/api/auth/code/request", { headers: h(ac), data: { email: p.email } });
      for (let i = 0; i < 3; i++) {
        await anon.post("/api/auth/code/redeem", { headers: h(ac), data: { email: p.email, code: "ZZZZZZZZ" } });
      }
    } finally { await anon.dispose(); }
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const u = db.prepare("SELECT failed_login_count, locked_until FROM users WHERE id=?").get(p.id);
      expect(u.failed_login_count, "the fixture must have a counter to clear").toBeGreaterThan(0);
      expect(u.locked_until, "…and must NOT be locked, or this tests the old path").toBeFalsy();
    } finally { db.close(); }

    const { api, csrf } = await apiLogin("superadmin");
    try {
      expect((await api.post(`/api/admin/participants/${p.id}/unlock`, { headers: h(csrf) })).ok()).toBeTruthy();
      const ev = userEvents(p.id, "unlocked");
      expect(ev.length, "clearing the counter is recorded").toBe(1);
      expect(ev[0].d.was_locked, "…and says the account was not actually locked").toBe(false);
      expect(ev[0].d.cleared_failed_logins, "…and how many failures were erased").toBeGreaterThan(0);
      expect(ev[0].actor).toBe("superadmin");
      expect(ev[0].d.ip).toBeTruthy();

      // POSITIVE CONTROL: a second unlock has nothing to clear.
      expect((await api.post(`/api/admin/participants/${p.id}/unlock`, { headers: h(csrf) })).ok()).toBeTruthy();
      expect(userEvents(p.id, "unlocked").length, "a genuine no-op stays silent").toBe(1);
    } finally { await api.dispose(); }
  });
});

test.describe("v7.21.32 — events that named the wrong actor", () => {
  test("a self-enrolment is attributed to the PARTICIPANT, not to the mechanism", async () => {
    // The actor was the literal sentinel "self_enroll" — the mechanism rather
    // than the person — so an operator filtering the log by somebody's email to
    // reconstruct what they did would not see their own join at all.
    const p = await ownParticipant("d");
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    let compId, token;
    try {
      const stamp = Date.now();
      compId = (await (await sa.post("/api/admin/competitions", { headers: h(sc), data: {
        name: `EvJoin ${stamp}`, start_time: new Date(stamp - 60_000).toISOString(),
        duration_minutes: 240, self_enroll_enabled: true,
      }})).json()).competition.id;
      token = (await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json()).token;
      expect(token, "the competition issues a join token").toBeTruthy();
    } finally { await sa.dispose(); }

    const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const join = await api.post("/api/competitions/join", { headers: h(csrf), data: { token } });
      expect(join.status(), await join.text()).toBe(200);
    } finally { await api.dispose(); }

    const ev = userEvents(p.id, "self_enrolled");
    expect(ev.length, "the join is recorded").toBe(1);
    expect(ev[0].actor, "attributed to the person, not the mechanism").toBe(p.email);
    expect(ev[0].actor).not.toBe("self_enroll");
    expect(ev[0].d.ip, "and carries their source IP").toBeTruthy();

    const ce = compEvents(compId, "user_added");
    expect(ce.length).toBe(1);
    expect(ce[0].actor, "the competition's History agrees").toBe(p.email);
    expect(ce[0].d.ip).toBeTruthy();
    // The MECHANISM is still recorded — as data, which is where it belongs.
    expect(ce[0].d.via).toBe("self_enroll");
  });

  test("an impersonating admin's email-change staging is not logged as the participant", async () => {
    // Staging pending_email and mailing a 48h confirmation link is the most
    // takeover-adjacent write a superadmin can make while impersonating, and it
    // was the one emit in that handler with no impersonation trace.
    const p = await ownParticipant("e");
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const imp = await api.post(`/api/admin/participants/${p.id}/impersonate`, { headers: h(csrf) });
      expect(imp.status(), `impersonate: ${await imp.text()}`).toBe(200);
      // The session was regenerated — re-read CSRF, as the SPA does.
      const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const me = await (await api.get("/api/me")).json();
      const r = await api.put("/api/me", { headers: h(c2), data: {
        firstName: me.first_name, lastName: me.last_name, nickname: me.nickname,
        email: `changed-${Date.now()}@company.com`, secondaryEmail: me.secondary_email || "",
        company: me.company, title: me.title, personalTitle: me.personal_title || "",
        phone: me.phone || "", linkedinUrl: me.linkedin_url || "",
        country: me.country, timezone: me.timezone, jobFunction: me.job_function, city: me.city,
      }});
      expect(r.status(), `staged email change: ${await r.text()}`).toBe(200);
    } finally { await api.dispose(); }

    const ev = userEvents(p.id, "email_change_requested");
    expect(ev.length, "the staging is recorded").toBe(1);
    expect(ev[0].d.impersonated_by, "…and says an admin did it").toBeTruthy();
    expect(ev[0].actor, "the actor is the impersonation actor, not the participant alone")
      .not.toBe(p.email);
    expect(ev[0].d.ip, "with the source IP").toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.8.9 — THE DEFERRED EMITS, which the v7.21.32 scanner structurally could not
// see. Both hot paths queue their audit writes as `queueEvent(recordUserEvent,
// …)` and drain them post-commit on a setImmediate, so a scanner keyed on the
// CALL SHAPE never matched them — and every submission on the platform, the
// highest-volume user-caused event there is, carried no source IP.
//
// The source arm lives in functional-core-b; this is the behavioural half,
// because a spread that is PRESENT still proves nothing about the value landing:
// `req.ip` is a lazy getter onto the socket and the drain runs after the
// response, so capturing at the wrong moment yields a spread of undefined and a
// green scanner.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.8.9 — a deferred emit carries the requester's IP", () => {
  test("a SUBMISSION records ip / user_agent / req_id, not merely who and what", async () => {
    const p = await ownParticipant("sub");
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    let comp, taskId;
    try {
      const cr = await sa.post("/api/admin/competitions", { headers: h(sc), data: {
        name: `EvSub ${Date.now()}`, start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 600, event_kind: "tournament" } });
      // v8.12.3 — this create answered a bare 500 once in nine full runs at
      // WORKERS=18 and never again under 144 targeted repeats; the body names
      // nothing and the app log is wiped with the data directory before anyone
      // reads the report. So the failure carries the server's own error lines —
      // no mechanism is claimed until it names one.
      if (!cr.ok()) throw new Error(`create competition: ${cr.status()} ${await cr.text()}\nserver log:\n${serverLogTail()}`);
      comp = (await cr.json()).competition.id;

      const tr = await sa.post("/api/admin/tasks", { headers: h(sc), data: {
        title: `EvSub task ${Date.now()}`, description: "d", difficulty: "easy",
        answer_type: "text", correct_answer: "yes", status: "published" } });
      expect(tr.ok(), `create task: ${await tr.text()}`).toBeTruthy();
      const bankId = (await tr.json()).id;
      const ar = await sa.post(`/api/admin/tasks/${bankId}/competitions`, { headers: h(sc), data: { competitionIds: [comp] } });
      expect(ar.ok(), `assign: ${await ar.text()}`).toBeTruthy();
      taskId = (await ar.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): what a submission records
      // ASSERT the assign, because it SKIPS an ineligible user in silence.
      const as = await sa.post("/api/admin/competitions/assign", { headers: h(sc), data: { userIds: [p.id], competitionIds: [comp] } });
      expect(as.ok(), `enrol: ${await as.text()}`).toBeTruthy();
      expect((await as.json()).assigned, "the participant really was enrolled").toBe(1);
    } finally { await sa.dispose(); }

    const { api, csrf } = await freshCtx();
    try {
      const lr = await codeLogin(api, p.email, h(csrf));
      expect(lr.ok(), `login: ${await lr.text()}`).toBeTruthy();
      const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const sel = await api.post("/api/select-competition", { headers: h(c2), data: { competitionId: comp } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      // The grading token is REQUIRED since v7.20.9 (F1), so fetch the task first.
      const c3 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const detail = await api.get(`/api/tasks/${taskId}`);
      expect(detail.ok(), `task detail: ${await detail.text()}`).toBeTruthy();
      // The grading hash is REQUIRED since v7.20.9 (F1) — a submit without one is
      // treated as stale and refused 409 before anything is graded, so the task
      // must be fetched first. The wire is asymmetric: the task detail returns
      // `grading_hash` and the submit reads `gradingHash`.
      const gh = (await detail.json()).grading_hash;
      expect(gh, "the task detail carries the grading hash").toBeTruthy();
      const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(c3), data: { answer: "yes", gradingHash: gh } });
      expect(sub.ok(), `submit: ${await sub.text()}`).toBeTruthy();
    } finally { await api.dispose(); }

    // POLL: these emits are drained post-commit on a setImmediate, so a single
    // read after the response races the drain (the standing rule).
    await expect.poll(() => userEvents(p.id, "submission_correct").length,
      { timeout: 10000, intervals: [50, 100, 200, 400, 800] }).toBeGreaterThan(0);

    const [ev] = userEvents(p.id, "submission_correct");
    expect(ev.d.ip, "the submission names where it came from").toBeTruthy();
    expect(ev.d.req_id, "…and joins to the access log by request id").toBeTruthy();
    expect(ev.d.user_agent, "…and records the client").toBeTruthy();
    // CONTROL: it did not lose what it already carried.
    expect(ev.d.task_id, "the task is still recorded").toBe(taskId);
    expect(ev.d.correct, "…and the outcome").toBe(true);

    // The competition mirror is a SEPARATE emit through the same queue, so a fix
    // applied to one details object and not the other would pass on the row above.
    await expect.poll(() => compEvents(comp, "submission_correct").length,
      { timeout: 10000, intervals: [50, 100, 200, 400, 800] }).toBeGreaterThan(0);
    expect(compEvents(comp, "submission_correct")[0].d.ip,
      "the competition mirror carries it too").toBeTruthy();
  });
});
