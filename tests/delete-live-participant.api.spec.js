// @ts-check
//
// v7.21.20 — deleting a participant who is inside a LIVE competition.
//
// Reported as "the superadmin cannot delete this user": a participant who had
// registered through a /join self-enroll link and entered the live competition
// could not be deleted from the admin's point of view.
//
// The server's refusal was correct and its remedy (remove them from the
// competition, then delete) really worked — but the CLIENT discarded the
// response and showed a bare "Failed to delete user.", so the superadmin was
// told only that it had not worked. No reason, no remedy. That is the shape the
// report took, and it is the same class as v7.21.14's tag dialogs, here on a
// destructive superadmin action.
//
// Two halves are locked: the refusal now carries a reason the client can show
// AND a machine-readable code, and `force` lets a superadmin through in one
// step instead of sending them on a hunt mid-event.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, pollAdminLogs } = require("./helpers");
const Database = require("better-sqlite3");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/**
 * The reported scenario, end to end: a LIVE competition with self-enrollment on,
 * a participant who registered THROUGH the join link, signed in, and entered.
 *
 * Built rather than faked because the report is specifically about a join-link
 * registration — that path defers enrolment to first sign-in
 * (`pending_self_enroll_comp_id`), so a participant who merely registered is in
 * a different state from one who has actually entered, and only the second
 * reaches the guard.
 */
async function joinLinkParticipantInLiveComp(sa, saCsrf, tag) {
  const stamp = `${Date.now()}${tag}`;
  const comp = (await (await sa.post("/api/admin/competitions", {
    headers: h(saCsrf),
    data: {
      name: `JoinDel ${stamp}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      duration_minutes: 240,
      self_enroll_enabled: true,
    },
  })).json()).competition.id;

  const se = await (await sa.get(`/api/admin/competitions/${comp}/self-enroll`)).json();
  expect(se.token, "the competition must issue a self-enroll token").toBeTruthy();

  const email = `joindel-${stamp}@company.com`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: h(ac),
    data: {
      firstName: "Join", lastName: "Del", nickname: `joindel${stamp}`, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC",
      password: PARTICIPANT_PASS, joinToken: se.token,
    },
  });
  expect(reg.status(), `register through the join link: ${await reg.text()}`).toBe(200);
  await anon.dispose();

  const user = (await (await sa.get("/api/admin/participants?limit=5000")).json())
    .participants.find(p => p.email === email);
  expect(user, "the join-link registration created an account").toBeTruthy();
  // registerPost's default rewinds the account to unverified and never signed in
  // (a join-link one keeps its approval, and its row: the registration enrolled
  // it at once, as no `deferJoin` is asked for). Verified here as before; the
  // emailed-code sign-in below would verify it anyway.
  await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: { "x-csrf-token": saCsrf } });

  const { api: pa, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
  const sel = await pa.post("/api/select-competition", { headers: h(pc), data: { competitionId: comp } });
  expect(sel.status(), `the participant enters the live competition: ${await sel.text()}`).toBe(200);
  await pa.dispose();

  // The state the guard actually reads — asserted, so a fixture that stopped
  // producing it would fail as a fixture rather than as a passing test.
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const row = db.prepare("SELECT active_competition_id FROM users WHERE id=?").get(user.id);
    expect(row.active_competition_id, "the participant is IN the live competition").toBe(comp);
    expect(db.prepare("SELECT COUNT(*) c FROM competition_users WHERE user_id=?").get(user.id).c,
      "…and enrolled in it").toBeGreaterThan(0);
  } finally { db.close(); }

  return { comp, user, email };
}

test.describe("v7.21.20 — deleting a participant inside a live competition", () => {
  test("the refusal SAYS why, names the competition, and is machine-readable", async () => {
    // The reported defect is that the admin learned nothing. A generic message
    // is indistinguishable from a broken feature, which is exactly how it was
    // reported — so the wording and the code are both part of the contract now.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await joinLinkParticipantInLiveComp(sa, csrf, "a");
      const r = await sa.delete(`/api/admin/participants/${f.user.id}`, { headers: { "x-csrf-token": csrf } });
      expect(r.status(), "the guard still fires by default").toBe(400);
      const d = await r.json();
      expect(d.error, "the message must name the competition, not just fail").toContain("JoinDel");
      expect(d.error, "…and state the remedy").toMatch(/Remove them from the event first/i);
      expect(d.code, "…and be machine-readable, so the client can offer the way out")
        .toBe("participant_in_live_competition");
      expect(d.competitionId, "…identifying which competition").toBe(f.comp);
      expect(d.competitionName).toContain("JoinDel");

      // The refusal must be a refusal.
      const still = await (await sa.get("/api/admin/participants?limit=5000")).json();
      expect(still.participants.some(p => p.id === f.user.id), "nothing may have been deleted").toBe(true);
    } finally { await sa.dispose(); }
  });

  test("force=1 lets the superadmin through in ONE step", async () => {
    // The half that makes the report go away. Without it the remedy is a hunt —
    // find the competition, find the participant in it, remove them, come back,
    // delete — and during a live event the superadmin doing the cleanup is the
    // person least able to afford it.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await joinLinkParticipantInLiveComp(sa, csrf, "b");
      const r = await sa.delete(`/api/admin/participants/${f.user.id}?force=1`, { headers: { "x-csrf-token": csrf } });
      expect(r.status(), `force must complete the delete: ${await r.text()}`).toBe(200);

      const after = await (await sa.get("/api/admin/participants?limit=5000")).json();
      expect(after.participants.some(p => p.id === f.user.id), "the account is gone").toBe(false);

      // The cascade must have run, not merely the users row — a half-deleted
      // participant would keep scoring on the board.
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) c FROM competition_users WHERE user_id=?").get(f.user.id).c,
          "membership rows are swept with the account").toBe(0);
      } finally { db.close(); }
    } finally { await sa.dispose(); }
  });

  test("a forced delete is DISTINGUISHABLE in the audit trail", async () => {
    // Overriding a safety guard mid-event must not look like an ordinary
    // deletion afterwards.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await joinLinkParticipantInLiveComp(sa, csrf, "c");
      expect((await sa.delete(`/api/admin/participants/${f.user.id}?force=1`, { headers: { "x-csrf-token": csrf } })).status()).toBe(200);

      const db = new Database(TEST_DB_PATH, { readonly: true });
      let details = null;
      try {
        // The delete event is ORPHANED (the user row is gone), so it lives in the
        // app log mirror rather than user_events — read it back through the API.
        // v8.12.5 — polled: the orphaned event reaches the mirror post-commit.
        const entries = await pollAdminLogs(sa, `stream=app&q=${encodeURIComponent(f.user.id)}&limit=200`,
          (es) => JSON.stringify(es).includes("forced_from_live_competition"),
          { what: "the forced deletion's audit line" }).catch(() => []);
        details = JSON.stringify(entries);
      } finally { db.close(); }
      expect(details, "the deletion is recorded at all").toContain(f.user.id);
      expect(details, "…and records that it overrode the live-competition guard")
        .toContain("forced_from_live_competition");
    } finally { await sa.dispose(); }
  });

  test("the documented remedy still works, and needs no force", async () => {
    // The gentler path must keep working — force is an addition, not a
    // replacement, and the refusal still recommends this one first.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await joinLinkParticipantInLiveComp(sa, csrf, "d");
      const rem = await sa.delete(`/api/admin/competitions/${f.comp}/users/${f.user.id}`, { headers: { "x-csrf-token": csrf } });
      expect(rem.status(), `remove from the competition: ${await rem.text()}`).toBe(200);
      const del = await sa.delete(`/api/admin/participants/${f.user.id}`, { headers: { "x-csrf-token": csrf } });
      expect(del.status(), "…and the plain delete then succeeds with no override").toBe(200);
    } finally { await sa.dispose(); }
  });

  test("a participant NOT in a live competition is deleted without any of this", async () => {
    // POSITIVE CONTROL. Without it, "400 then 200-with-force" is equally
    // satisfied by a guard that refuses everyone.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const email = `plaindel-${stamp}@company.com`;
      const { api: anon, csrf: ac } = await freshCtx();
      await registerPost(anon, "/api/register", { headers: h(ac), data: {
        firstName: "Plain", lastName: "Del", nickname: `plaindel${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS } });
      await anon.dispose();
      const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
        .participants.find(p => p.email === email);
      expect(u, "control participant exists").toBeTruthy();
      const r = await sa.delete(`/api/admin/participants/${u.id}`, { headers: { "x-csrf-token": csrf } });
      expect(r.status(), "an ordinary participant deletes with no guard at all").toBe(200);
    } finally { await sa.dispose(); }
  });
});
