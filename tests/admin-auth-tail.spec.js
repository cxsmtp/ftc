// @ts-check
// v8.1.7 — three narrow defects in the admin and auth tails. Each is a case
// where the platform did something correct and then described it wrongly, or
// stopped half-way through a side effect nobody could see it skip.
//
//   #34  POST /api/admin/participants/desk-invite checks `emailIsTaken` and then
//        awaits bcrypt for ~100 ms before its INSERT, with no in-transaction
//        re-check and no catch. Two concurrent requests for one address — a
//        double-clicked desk form, two desks working one queue — both passed the
//        check and the loser's INSERT tripped `uq_users_email_nocase`, escaping
//        as a generic 500 instead of the purpose-written 409 that names the
//        remedy. Atomicity held; the MESSAGE did not, at exactly the
//        queue-pressure moment the endpoint exists for.
//   #37  POST /api/admin/participants/:id/role writes the staff tag
//        UNCONDITIONALLY (v7.21.32) but kept its leaderboard bust and its
//        group reconcile on the ROLE delta — so a same-role POST that strips
//        the tag left a group-bound member silently un-enrolled.
//   #38  POST /api/reset-password regenerates the session and is reachable under
//        superadmin-origin impersonation, so it destroyed the `impersonator`
//        marker without emitting `impersonation_ended` — leaving a permanently
//        unclosed `impersonation_started` on the target's History. Nothing
//        recovers it: invalidateOtherSessions excludes the current id and the
//        expiry sweep only closes windows on rows that EXPIRE.
//
// Every test owns its fixtures — no seeded participant is authenticated as or
// mutated here.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `aat${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}
function dbAll(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

const enrolled = (compId, userId) =>
  dbGet("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?", compId, userId).c;

/** Register + verify + approve a fresh participant. Returns its id. */
async function mkParticipant(api, h, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", { headers: h, data: {
    firstName: "Tail", lastName: "Case", nickname: label, email,
    company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "Testville",
    password: PARTICIPANT_PASS,
  }});
  expect(reg.status(), `register ${email}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find((p) => p.email === email);
  expect(u, `${email} must exist after register (search returned ${(list.participants || []).length} row(s))`).toBeTruthy();
  // Order matters: POST /approve REFUSES an unverified account.
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: h })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: h })).ok()).toBeTruthy();
  return { id: u.id, email };
}

/** An UPCOMING competition — reconcile enrols into upcoming AND live, and an
 *  upcoming one carries no auto-end or scoring-freeze interactions at all. */
async function mkUpcomingComp(api, h, label) {
  const r = await api.post("/api/admin/competitions", { headers: h, data: {
    name: `${TAG} ${label}`, start_time: new Date(Date.now() + 3600e3).toISOString(),
    duration_minutes: 120, timezone: "UTC",
  }});
  expect(r.ok(), `create competition ${label}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition.id;
}

async function mkGroup(api, h, label, userIds) {
  const r = await api.post("/api/admin/groups", { headers: h, data: { name: `${TAG} ${label}`, userIds } });
  expect(r.ok(), `create group ${label}: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).group?.id;
  expect(id, `create group ${label} returned no id`).toBeTruthy();
  return id;
}

test.describe("v8.1.7 — the admin/auth tail", () => {

  // ── #34 ───────────────────────────────────────────────────────────────────
  // The window is `await bcrypt.hash` at cost 10 (~70-100 ms on the libuv
  // threadpool), which is an eternity in event-loop terms — so five requests
  // fired together all run their pre-check before any of them reaches its
  // INSERT. Stated honestly: if they somehow serialised, every loser would be
  // refused by the PRE-check with the identical 409 and this test would pass
  // without having exercised the fix. Five concurrent is what makes that
  // uninteresting rather than likely.
  test("#34: concurrent desk-invites for one address answer the NAMED 409, never a 500", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const email = `${uniq()}@company.example`;
      const N = 5;
      const rs = await Promise.all(Array.from({ length: N }, () =>
        api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } })
      ));
      const statuses = rs.map((r) => r.status());
      const bodies = await Promise.all(rs.map((r) => r.json().catch(() => ({}))));

      // THE DEFECT: the loser's INSERT tripped uq_users_email_nocase and reached
      // the generic error handler as "An internal error occurred" — a refusal the
      // admin cannot act on, for the one condition this endpoint has bespoke
      // copy for.
      expect(statuses.filter((s) => s >= 500),
        `desk-invite must never 500 on a duplicate (statuses=${JSON.stringify(statuses)}, bodies=${JSON.stringify(bodies)})`
      ).toEqual([]);

      // POSITIVE CONTROL — without it, "nothing 500'd" is equally satisfied by a
      // build where every desk-invite is refused for some unrelated reason.
      const winnerIdx = statuses.indexOf(200);
      expect(winnerIdx, `exactly one of ${N} concurrent invites must succeed (statuses=${JSON.stringify(statuses)})`).toBeGreaterThanOrEqual(0);
      expect(statuses.filter((s) => s === 200).length, "and only one").toBe(1);
      expect(bodies[winnerIdx].id, "the winner really created the walk-up account").toBeTruthy();
      // NB the route reuses the key `code` for two things: the sign-in code on
      // success, and the machine-readable refusal slug on a 409. Both are
      // asserted below, so read the status first.
      expect(bodies[winnerIdx].code, "and really handed over a sign-in code").toBeTruthy();

      // Every loser gets the purpose-written refusal, remedy and all.
      rs.forEach((r, i) => {
        if (i === winnerIdx) return;
        expect(r.status(), `loser ${i}: ${JSON.stringify(bodies[i])}`).toBe(409);
        expect(bodies[i].code).toBe("email_taken");
        expect(String(bodies[i].error || ""),
          "the 409 must still name a remedy, not just refuse").toContain("Someone already has that email address.");
      });

      // Atomicity was never in doubt — assert it so a "fix" that let two rows
      // through would fail here instead of looking green.
      expect(dbGet("SELECT COUNT(*) c FROM users WHERE LOWER(email)=LOWER(?)", email).c,
        "one address, one account").toBe(1);
    } finally { await api.dispose(); }
  });

  // ── #37 ───────────────────────────────────────────────────────────────────
  // The observable consequence, not "a function was called": a group-bound
  // member who loses the staff tag must end up ENROLLED in that group's
  // competition, because reconcileCompetitionMembership skips staff.
  test("#37: a SAME-role POST that removes the staff tag reconciles group-bound membership", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    try {
      const helper = await mkParticipant(api, h, uniq());
      const control = await mkParticipant(api, h, uniq());

      // The helper is a participant-ROLE account carrying the staff tag — the
      // exact shape an organiser's on-site helper has, and the only shape a
      // same-role POST can change anything about.
      expect((await api.post(`/api/admin/participants/${helper.id}/tags`, { headers: h, data: { tag: "staff" } })).ok()).toBeTruthy();

      const groupId = await mkGroup(api, h, "helpers", [helper.id, control.id]);
      const compId = await mkUpcomingComp(api, h, "helpers comp");
      const bind = await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [groupId], competitionIds: [compId] } });
      expect(bind.ok(), `bind group: ${await bind.text()}`).toBeTruthy();

      // PRECONDITION CONTROL: the bind's reconcile really ran to completion —
      // otherwise "the staff member is absent" would be satisfied by a reconcile
      // that had not happened yet, and this whole test would be vacuous.
      expect(enrolled(compId, control.id), "the non-staff member was enrolled by the bind").toBe(1);
      expect(enrolled(compId, helper.id), "precondition: reconcile skips staff, so the helper is NOT enrolled").toBe(0);

      // The call under test: the SAME role the account already has. v7.21.32
      // made the tag write unconditional, so this strips `staff`.
      const same = await api.post(`/api/admin/participants/${helper.id}/role`, { headers: h, data: { role: "participant" } });
      expect(same.ok(), `same-role POST: ${await same.text()}`).toBeTruthy();
      expect((await same.json()).tags, "the staff tag really was removed by the same-role POST").not.toContain("staff");

      // Catches: reverting the `staffRemoved ||` clause on the reconcile — the
      // helper stays un-enrolled for ever and this poll times out.
      await expect.poll(() => enrolled(compId, helper.id), {
        message: "losing the staff tag must reconcile the helper into the group-bound competition",
        timeout: 15_000, intervals: [100, 200, 400, 800, 1500],
      }).toBe(1);
    } finally { await api.dispose(); }
  });

  // POSITIVE CONTROL for the fix above: the pre-existing role-CHANGE trigger is
  // untouched. Without this, keying the reconcile on the tag alone (dropping the
  // role clause) would look like a clean pass.
  test("#37 control: the ordinary role-CHANGE demotion still reconciles", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    try {
      const target = await mkParticipant(api, h, uniq());
      const control = await mkParticipant(api, h, uniq());
      // Promote → the role route adds `staff`, which is what excludes them below.
      expect((await api.post(`/api/admin/participants/${target.id}/role`, { headers: h, data: { role: "admin" } })).ok()).toBeTruthy();

      const groupId = await mkGroup(api, h, "demote", [target.id, control.id]);
      const compId = await mkUpcomingComp(api, h, "demote comp");
      const bind = await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [groupId], competitionIds: [compId] } });
      expect(bind.ok(), `bind group: ${await bind.text()}`).toBeTruthy();
      expect(enrolled(compId, control.id), "the bind's reconcile ran").toBe(1);
      expect(enrolled(compId, target.id), "precondition: an admin is staff, so skipped").toBe(0);

      const demote = await api.post(`/api/admin/participants/${target.id}/role`, { headers: h, data: { role: "participant" } });
      expect(demote.ok(), `demote: ${await demote.text()}`).toBeTruthy();
      await expect.poll(() => enrolled(compId, target.id), {
        message: "a demotion to participant must still reconcile (v7.7.38 behaviour, unchanged)",
        timeout: 15_000, intervals: [100, 200, 400, 800, 1500],
      }).toBe(1);
    } finally { await api.dispose(); }
  });


});
