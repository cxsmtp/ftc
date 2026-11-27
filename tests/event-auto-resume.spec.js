// v8.3.8 — "a participant is asked to choose an event ONCE".
//
// The choice a participant makes is re-entered on their next sign-in, and the
// ONLY thing that undoes it is going back to the event list. Before this the
// marker (`users.active_competition_id`) was written and read on a LIVE-only
// rule, which broke the promise in both directions at once: an event chosen the
// night before was not resumed the next morning, AND the login read then deleted
// the marker, so the choice was gone rather than merely unused.
//
// TWO CONTROLS CARRY MOST OF THE WEIGHT HERE, because almost every assertion in
// this file has a trivially-satisfying wrong implementation:
//   • "a Program is not resumed" is equally satisfied by a build where NOTHING
//     resumes — so every kind test runs against a resuming sibling, and the
//     Program test additionally proves the participant is still enrolled.
//   • "leaving the event list clears it" is equally satisfied by a build that
//     never sets the marker — so the same fixture is driven twice, once WITHOUT
//     the exit, and must resume.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin, TEST_DB_PATH } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ar${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// `startsInMin` is signed: negative starts the event in the past (i.e. LIVE).
async function makeEvent(api, csrf, { kind = "tournament", startsInMin = 60, durationMin = 600, ...extra } = {}) {
  const data = {
    name: `${uniq()} Ev`, timezone: "UTC", event_kind: kind,
    start_time: new Date(Date.now() + startsInMin * 60e3).toISOString(),
    ...extra,
  };
  // A Program's schedule is a DEADLINE, not a duration (v8.1.0 PR 16), and the
  // create refuses a duration for it — so the two kinds cannot share one body.
  if (kind === "program") data.deadline_at = new Date(Date.now() + 30 * 86400e3).toISOString();
  else data.duration_minutes = durationMin;
  const r = await api.post("/api/admin/competitions", { headers: H(csrf), data });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Resume", lastName: "Tester", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  // `?search=` is a NO-OP on this endpoint (it is page 1 ordered created_at ASC),
  // so the documented 5000 cap is what actually finds a just-created account.
  const all = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
  const u = all.find(p => p.email === email);
  expect(u, `the new participant must be findable (scanned ${all.length})`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

async function assign(api, csrf, compId, userIds) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { competitionIds: [compId], userIds },
  });
  expect(r.ok(), `assign: ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.assigned, `the assign must not have SKIPPED the participant (${JSON.stringify(d)})`).toBe(userIds.length);
}

// Sign in and hand back BOTH the login payload (which carries the resume verdict)
// and a live context.
async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const d = await li.json();
  return { api, d, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

const select = (api, csrf, competitionId) =>
  api.post("/api/select-competition", { headers: H(csrf), data: { competitionId } });

/**
 * A working sign-in code for the walk-up, from the admin side. Before its first
 * sign-in the desk shows one (Show sign-in code); after it the desk can only
 * EMAIL one (operator ruling, 14 Nov 2026), read back through the test-only
 * capture. Either way the code door under test is the same redeem.
 */
async function liveCode(api, csrf, walkId, email) {
  const rev = await api.post(`/api/admin/participants/${walkId}/login-code/reveal`, { headers: H(csrf), data: {} });
  if (rev.ok()) return (await rev.json()).code;
  expect((await rev.json()).code, "the desk refuses only an account that has signed in").toBe("signed_in_before");
  const em = await api.post(`/api/admin/participants/${walkId}/login-code/email`, { headers: H(csrf), data: {} });
  expect(em.ok(), `Email sign-in code: ${await em.text()}`).toBeTruthy();
  const lc = await (await api.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).json();
  expect(lc && lc.via, "the emailed code was captured").toBe("email");
  return lc.code;
}

test.describe("v8.3.8 — the event choice survives a sign-out", () => {

  test("an UPCOMING Competition is re-entered on the next sign-in", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 60 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    // v8.3.12 — A SECOND EVENT, so this test isolates the MARKER rule. With
    // exactly one event the sole-event landing rule fires first and this fixture
    // would be measuring that instead. Two events means the participant has a
    // choice to make, which is the only state in which the marker is the thing
    // under test.
    const other = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 120 });
    await assign(api, csrf, other.id, [p.id]);
    await api.dispose();

    const first = await signIn(p.email);
    expect(first.d.autoResumeCompetitionId, "nothing chosen yet — the picker is correct here").toBeFalsy();
    const s = await select(first.api, first.csrf, comp.id);
    expect(s.ok(), `select: ${await s.text()}`).toBeTruthy();
    await first.api.dispose();

    // A brand-new session: nothing but the durable marker can carry the choice.
    const second = await signIn(p.email);
    expect(second.d.autoResumeCompetitionId,
      "an event chosen while UPCOMING must still be the participant's event next time").toBe(comp.id);
    // And the resume is real, not merely announced: the session points there too,
    // which is what /api/me (and therefore boot's routing) reads.
    const me = await (await second.api.get("/api/me")).json();
    expect(me.competitionId).toBe(comp.id);
    await second.api.dispose();
  });

  test("a LIVE Booth Event is re-entered — the walk-up who steps away and comes back", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "booth", startsInMin: -30, durationMin: 120 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    await api.dispose();

    const first = await signIn(p.email);
    expect((await select(first.api, first.csrf, comp.id)).ok()).toBeTruthy();
    await first.api.dispose();

    const second = await signIn(p.email);
    expect(second.d.autoResumeCompetitionId).toBe(comp.id);
    await second.api.dispose();
  });

  test("v8.3.15: a PROGRAM is re-entered too — the last carve-out by KIND is gone", async () => {
    // FLIPPED at v8.3.15, on the operator's instruction. v8.3.8 excluded the kind
    // because a learner is routinely enrolled in several Programs at once, so
    // pinning them to whichever they opened last makes the others harder to
    // reach. That argument predates `left_event_at`: the opt-out is DURABLE
    // across a sign-out now, so it costs one click, once — against a carve-out
    // the participant cannot see and nothing on screen explains.
    const { api, csrf } = await sa();
    const prog = await makeEvent(api, csrf, { kind: "program" });
    // TWO events, so the marker is the thing under test rather than the
    // sole-event landing (which fires first when there is only one).
    const other = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 120 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, prog.id, [p.id]);
    await assign(api, csrf, other.id, [p.id]);
    await api.dispose();

    const a1 = await signIn(p.email);
    expect((await select(a1.api, a1.csrf, prog.id)).ok()).toBeTruthy();
    await a1.api.dispose();

    const a2 = await signIn(p.email);
    expect(a2.d.autoResumeCompetitionId,
      "they chose the Program and never went back to the list").toBe(prog.id);
    // ANTI-VACUITY: "a Program resumes" is equally satisfied by a build that
    // resumes whatever it likes. The same participant, having gone back to the
    // list, must NOT be put back in.
    const de = await a2.api.post("/api/deselect-competition", { headers: H(a2.csrf) });
    expect(de.ok(), `deselect: ${await de.text()}`).toBeTruthy();
    await a2.api.dispose();

    const a3 = await signIn(p.email);
    expect(a3.d.autoResumeCompetitionId,
      "CONTROL: the events list is still the opt-out, for a Program as for anything else").toBeFalsy();
    await a3.api.dispose();
  });

  test("v8.3.15: an ENDED event IS re-entered, even with a LIVE event beside it", async () => {
    // FLIPPED at v8.3.15. v8.3.8 refused an ended event on the argument that
    // "the next thing that participant wants is almost never the one that is
    // over" — a guess about intent, made against a participant who demonstrably
    // chose that event and never left it. Reviewing a finished event (the
    // answers, the final board, a certificate) is an ordinary thing to want.
    //
    // THE LIVE SIBLING IS WHAT MAKES THIS SHARP: the previous rule would have
    // cleared the marker and, with two events, asked. A rule that merely
    // preferred "any live event" would land on the wrong one. Only "the marker
    // wins" produces the ended one.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: -30, durationMin: 120 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    const live = await makeEvent(api, csrf, { kind: "tournament", startsInMin: -10, durationMin: 600 });
    await assign(api, csrf, live.id, [p.id]);

    const first = await signIn(p.email);
    expect((await select(first.api, first.csrf, comp.id)).ok()).toBeTruthy();
    await first.api.dispose();

    const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
    await api.dispose();

    const second = await signIn(p.email);
    expect(second.d.autoResumeCompetitionId,
      "an event that is over is still the event they chose and never left").toBe(comp.id);
    const me = await (await second.api.get("/api/me")).json();
    expect(me.competitionId, "and the session points at it — boot() routes off exactly this").toBe(comp.id);
    expect(me.competitionId,
      "NOT the live sibling: the marker decides, not a preference for something running").not.toBe(live.id);
    await second.api.dispose();
  });

  test("going back to the event list is the opt-out — and WITHOUT it the same fixture resumes", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 60 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    await api.dispose();

    // Round 1 — choose, then leave for the event list.
    const r1 = await signIn(p.email);
    expect((await select(r1.api, r1.csrf, comp.id)).ok()).toBeTruthy();
    const de = await r1.api.post("/api/deselect-competition", { headers: H(r1.csrf) });
    expect(de.ok(), `deselect: ${await de.text()}`).toBeTruthy();
    expect((await de.json()).cleared).toBe(true);
    // It clears the CURRENT session too, not only the next one.
    expect((await (await r1.api.get("/api/me")).json()).competitionId).toBeFalsy();
    await r1.api.dispose();

    const r2 = await signIn(p.email);
    expect(r2.d.autoResumeCompetitionId, "they said they were done with it").toBeFalsy();

    // Round 2 — the SAME participant and event, without the exit. This is what
    // stops the assertion above passing on a build that never sets the marker.
    expect((await select(r2.api, r2.csrf, comp.id)).ok()).toBeTruthy();
    await r2.api.dispose();
    const r3 = await signIn(p.email);
    expect(r3.d.autoResumeCompetitionId, "CONTROL: no exit, so the choice stands").toBe(comp.id);
    await r3.api.dispose();
  });

  test("deselect is idempotent, and succeeds when nothing was selected", async () => {
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    await api.dispose();

    const s = await signIn(p.email);
    const first = await s.api.post("/api/deselect-competition", { headers: H(s.csrf) });
    expect(first.ok()).toBeTruthy();
    expect((await first.json()).cleared, "nothing was pointing anywhere").toBe(false);
    const again = await s.api.post("/api/deselect-competition", { headers: H(s.csrf) });
    expect(again.ok(), "a second press must not be an error — this fires on navigation").toBeTruthy();
    await s.api.dispose();
  });

  test("a STAFF member resumes too, though they hold no assignment row", async () => {
    // select-competition lets staff into any event WITHOUT a competition_users
    // row, and persists the marker for them — while the login read insisted on
    // finding that row, so a staff member's marker was unreadable the moment it
    // was written. One half of a rule contradicting the other.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: -30, durationMin: 240 });
    const p = await makeParticipant(api, csrf);
    const tag = await api.post(`/api/admin/participants/${p.id}/tags`, { headers: H(csrf), data: { tag: "staff" } });
    expect(tag.ok(), `staff tag: ${await tag.text()}`).toBeTruthy();
    await api.dispose();

    const first = await signIn(p.email);
    expect(first.d.isStaff, "PRECONDITION: the tag must have taken").toBeTruthy();
    const sel = await select(first.api, first.csrf, comp.id);
    expect(sel.ok(), `staff select without an assignment: ${await sel.text()}`).toBeTruthy();
    await first.api.dispose();

    const second = await signIn(p.email);
    expect(second.d.autoResumeCompetitionId).toBe(comp.id);
    await second.api.dispose();
  });

  test("multi-session: an UPCOMING chosen session resumes, and brings the session with it", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 60 });
    const ts = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: H(csrf),
      data: { name: "Morning", start_time: new Date(Date.now() + 90 * 60e3).toISOString(), duration_minutes: 120, timezone: "UTC" },
    });
    expect(ts.ok(), `timeslot: ${await ts.text()}`).toBeTruthy();
    const slot = (await ts.json()).timeslot;
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    await api.dispose();

    const first = await signIn(p.email);
    expect((await select(first.api, first.csrf, comp.id)).ok()).toBeTruthy();
    const pick = await first.api.post("/api/select-timeslot", { headers: H(first.csrf), data: { timeslotId: slot.id } });
    expect(pick.ok(), `select-timeslot: ${await pick.text()}`).toBeTruthy();
    await first.api.dispose();

    const second = await signIn(p.email);
    expect(second.d.autoResumeCompetitionId, "choosing a session is choosing the event").toBe(comp.id);
    const me = await (await second.api.get("/api/me")).json();
    expect(me.timeslotId, "and the session choice comes back with it").toBe(slot.id);
    await second.api.dispose();
  });

  test("v8.3.15: multi-session — MY session having ended still resumes, and brings that session", async () => {
    // FLIPPED at v8.3.15 along with the single-slot ended case. What this test
    // still owns, and why it is not redundant: the participant is pinned to
    // THEIR OWN session, so the answer must come back carrying that session id
    // rather than the competition's aggregate view. A build that resumed the
    // competition and dropped the slot pointer would put them in a
    // multi-session event with no session — which `requireCompetitionContext`
    // then bounces to the session picker.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: -60, durationMin: 600 });
    const mk = async (name) => {
      const r = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(csrf),
        data: { name, start_time: new Date(Date.now() - 30 * 60e3).toISOString(), duration_minutes: 240, timezone: "UTC" },
      });
      expect(r.ok(), `timeslot ${name}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot;
    };
    const mine = await mk("Mine");
    const sibling = await mk("Sibling");

    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    await api.dispose();

    const first = await signIn(p.email);
    expect((await select(first.api, first.csrf, comp.id)).ok()).toBeTruthy();
    const pick = await first.api.post("/api/select-timeslot", {
      headers: H(first.csrf), data: { timeslotId: mine.id, confirmLive: true },
    });
    expect(pick.ok(), `select-timeslot: ${await pick.text()}`).toBeTruthy();
    await first.api.dispose();

    // End only THEIR session; the sibling keeps running.
    const { api: a2, csrf: c2 } = await sa();
    const en = await a2.post(`/api/admin/competitions/${comp.id}/timeslots/${mine.id}/end-now`, { headers: H(c2) });
    expect(en.ok(), `end session: ${await en.text()}`).toBeTruthy();
    const listed = await (await a2.get("/api/admin/competitions?limit=500")).json();
    const rows = Array.isArray(listed) ? listed : (listed.competitions || []);
    const row = rows.find(c => c.id === comp.id);
    expect(row && row.status, "PRECONDITION: the competition itself must still be live").toBe("live");
    void sibling;
    // TWO events, so the marker rule is what is being measured.
    const c2other = await makeEvent(a2, c2, { kind: "tournament", startsInMin: 120 });
    await assign(a2, c2, c2other.id, [p.id]);
    await a2.dispose();

    const second = await signIn(p.email);
    expect(second.d.autoResumeCompetitionId, "the event they chose, finished session and all").toBe(comp.id);
    const me = await (await second.api.get("/api/me")).json();
    expect(me.timeslotId,
      "and THEIR session comes back with it — not the live sibling, and not nothing").toBe(mine.id);
    await second.api.dispose();
  });
});

// v8.3.9 — the rule was built into ONE door. There are three ways an existing
// account gets a session, and only the password one applied it, so the feature
// was silently password-only. Each of the other two is driven end to end here,
// because "it is wired up" is exactly the claim the v8.3.8 release could have
// made and been wrong about.
test.describe("v8.3.9 — every sign-in door resumes, not just the password one", () => {



  // ── v8.3.12 — THE SECOND LANDING RULE, AND THE LOGIN CLOCKS ────────────────
  //
  // Reported from a live account: signing in with LinkedIn landed on the event
  // list while signing in with a password on the SAME account went straight into
  // the event, and the admin table's Last Login never moved for the LinkedIn one.
  //
  // Both are the v8.3.9 finding again — a rule at a fraction of its doors — but
  // one layer out. The "you have exactly one event, go there" rule lived only in
  // `doLogin()`, the PASSWORD door's CLIENT handler, so no other door could
  // possibly honour it; and `last_login_time` was written by the password door
  // and the code door and by neither LinkedIn door.

  // Build the reported shape: ONE event, ENDED, and no resume marker. It has to
  // be created LIVE and ended afterwards — the assign path is frozen once a
  // session has ended, so an already-ended event cannot be built into this state
  // from outside (fixture checklist).
  async function endedSoleEvent(api, csrf, userId) {
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: -30, durationMin: 600 });
    await assign(api, csrf, comp.id, [userId]);
    const end = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    return comp;
  }



  test("v8.3.12: the sole-event landing is the same answer at the PASSWORD door — and TWO events still ask", async () => {
    // The PARITY half. The bug was an asymmetry, so a lock that only drives
    // LinkedIn cannot see it come back the other way round.
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    const comp = await endedSoleEvent(api, csrf, p.id);
    // A password account (Profile, How you sign in), so the REAL password door
    // (POST /api/auth/password) answers, not the code door.
    const PW = `Resume-${Date.now().toString(36)}-pw!`;
    {
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      try {
        db.prepare("UPDATE users SET login_method='password', password_hash=?, password_set_at=? WHERE id=?")
          .run(require("bcrypt").hashSync(PW, 4), new Date().toISOString(), p.id);
      } finally { db.close(); }
    }

    const { api: a1, csrf: c1 } = await freshCtx();
    const li = await a1.post("/api/auth/password", { headers: H(c1), data: { email: p.email, password: PW } });
    expect(li.status(), `password door: ${await li.text()}`).toBe(200);
    const body = await li.json();
    expect(body.ok, `the password signs in: ${JSON.stringify(body)}`).toBe(true);
    expect(body.autoResumeCompetitionId,
      "the password door gets the SAME answer, from the SAME server-side rule"
    ).toBe(comp.id);
    const me = await (await a1.get("/api/me")).json();
    expect(me.competitionId, "and the session pointer is already set").toBe(comp.id);
    await a1.dispose();

    // THE ANTI-VACUITY CONTROL. Without it, "the sole event is landed in" is
    // equally satisfied by a build that lands a participant in whichever event it
    // finds first — which would be a far worse change and invisible above.
    const second = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 60 });
    await assign(api, csrf, second.id, [p.id]);
    await api.dispose();

    const { api: a2, csrf: c2 } = await freshCtx();
    const li2 = await a2.post("/api/auth/password", { headers: H(c2), data: { email: p.email, password: PW } });
    expect(li2.ok(), `second login: ${await li2.text()}`).toBeTruthy();
    expect((await li2.json()).ok, "the password signs in again").toBe(true);
    expect((await li2.json()).autoResumeCompetitionId,
      "with TWO events and no marker there is a choice to make, so the participant makes it"
    ).toBeFalsy();
    const me2 = await (await a2.get("/api/me")).json();
    expect(me2.competitionId, "…and nothing is pre-selected").toBeFalsy();
    await a2.dispose();
  });



  test("an emailed SIGN-IN CODE resumes the event they last chose", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "booth", startsInMin: -30, durationMin: 240 });
    const email = `${uniq()}@company.example`;
    // desk-invite creates a PASSWORDLESS account, which is the only kind the
    // code door serves (`password_set_at IS NULL`).
    const di = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
    expect(di.status(), `desk-invite: ${await di.text()}`).toBe(200);
    const walkId = (await di.json()).user?.id || (await (await api.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.email === email)?.id;
    expect(walkId, "the walk-up account must exist").toBeTruthy();
    // desk-invite collects only an address, so the account arrives with an empty
    // profile and select-competition would refuse it with `profile_incomplete`
    // — the gate, not the door under test. Fill it the way the completion gate
    // would have.
    const fill = await api.put(`/api/admin/participants/${walkId}`, {
      headers: H(csrf),
      data: {
        company: "Acme", title: "Engineer", country: "US",
        timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "New York",
      },
    });
    expect(fill.ok(), `fill profile: ${await fill.text()}`).toBeTruthy();
    await assign(api, csrf, comp.id, [walkId]);

    const redeem = async () => {
      const code = await liveCode(api, csrf, walkId, email);
      expect(code, "a code is in hand").toBeTruthy();
      const { api: a, csrf: ac } = await freshCtx();
      const rr = await a.post("/api/auth/code/redeem", { headers: H(ac), data: { email, code } });
      // 200 always — the contract. Branch on the PAYLOAD, never the status.
      expect(rr.status(), "the redeem endpoint answers 200 for every outcome").toBe(200);
      const d = await rr.json();
      expect(d.ok, `redeem refused: ${JSON.stringify(d)}`).toBeTruthy();
      return a;
    };

    const a1 = await redeem();
    const c1 = (await (await a1.get("/api/csrf-token")).json()).csrfToken;
    const sel = await select(a1, c1, comp.id);
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    await a1.dispose();

    const a2 = await redeem();
    const me = await (await a2.get("/api/me")).json();
    expect(me.competitionId, "redeeming a code IS signing in").toBe(comp.id);
    await a2.dispose();
    await api.dispose();
  });

  test("every login_success site applies the rule — a new sign-in door cannot skip it", () => {
    // The DURABLE guard, because the failure this release fixes is structural:
    // the rule was correct and implemented at one of three doors, and nothing
    // said so. `login_success` is the positive, structural signal for "this is a
    // sign-in" — impersonation enter/exit establish a session and deliberately
    // emit no such event, so they are excluded by what they ARE rather than by a
    // name list that would go stale.
    const fs = require("fs");
    const path = require("path");
    const roots = ["server.js", "routes/auth.js", "routes/participant.js", "routes/participants.js"];
    const hits = [];
    for (const rel of roots) {
      const abs = path.join(__dirname, "..", rel);
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      lines.forEach((ln, i) => {
        // Skip prose: only a real recordUserEvent(...) emit counts.
        if (!/recordUserEvent\([^)]*"login_success"/.test(ln)) return;
        const window = lines.slice(i, i + 40).join("\n");
        // v8.3.12 — the STAMP window is SYMMETRIC, and the asymmetry with the
        // resume is real rather than sloppy. `applyAutoResumeToSession` must run
        // AFTER the emit because it must follow `regenerate()` — the pointer has
        // to land on the session that will actually be saved — so a forward-only
        // window is exactly right for it. `stampLoginTimes` is a plain UPDATE with
        // no session dependency, and two doors do it BEFORE the emit (the password
        // door stamps ~57 lines earlier, alongside `clearLockout`). Requiring it
        // after would be a rule about layout rather than about the door.
        // 80 lines back, 40 forward. MEASURED rather than guessed: the password
        // door stamps 45 lines before its emit (alongside `clearLockout`, where it
        // belongs), and the closest two doors in this file are 189 lines apart —
        // so 80 leaves ~2x headroom for an edit without ever letting one door's
        // call satisfy another door's requirement.
        const around = lines.slice(Math.max(0, i - 80), i + 40).join("\n");
        hits.push({
          where: `${rel}:${i + 1}`,
          resume: /applyAutoResumeToSession\(/.test(window),
          // v8.3.12 — the SAME enumeration, a second requirement. `last_login_time`
          // was written by the password door and the code door and by NEITHER
          // LinkedIn door, so the admin Participants table's Last Login column
          // showed whenever the account last used a password — blank for every
          // account that has never had one. One list of doors, both rules, so a
          // fifth door cannot arrive missing either.
          stamp: /stampLoginTimes\(/.test(around),
        });
      });
    }
    // Anti-vacuity: if the event name is ever renamed this scanner would find
    // NOTHING and pass silently, which is the failure mode it exists to prevent.
    // One user sign-in door remains (the emailed code); the built-in superadmin's
    // break-glass sign-in has no user row and emits superadmin_login_success.
    expect(hits.length, "the scanner must actually be finding the sign-in door").toBeGreaterThanOrEqual(1);
    const missing = hits.filter(h => !h.resume).map(h => h.where);
    expect(missing,
      `a sign-in that does not resume the participant's chosen event: ${missing.join(", ")}`).toEqual([]);
    const unstamped = hits.filter(h => !h.stamp).map(h => h.where);
    expect(unstamped,
      `a sign-in that does not stamp login_time / last_login_time: ${unstamped.join(", ")}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.3.15 — THE LANDING RULE, MADE UNCONDITIONAL.
//
// Operator instruction, in one sentence: a participant who entered an event and
// did NOT go back to the events list is put straight back into that event at
// their next sign-in — whatever its STATUS, whatever its KIND, whatever else
// they are enrolled in, and whichever DOOR they came through.
//
// The permutations are driven rather than argued, because every one of those
// four axes was a real carve-out at some point in this feature's life and three
// were still live at v8.3.14: an ended event refused, a Program refused, and
// neither the LinkedIn nor the code door had ever been exercised against either.
//
// ANTI-VACUITY IS THE HARD PART. "It resumed" is satisfied by a build that
// resumes anything at all, so every block below is paired with a case that must
// NOT resume — they pressed Events, they were removed, the event was deleted, or
// they never chose in the first place.
test.describe("v8.3.15 — the marker wins; only the events list clears it", () => {

  // Build an event in a requested status and enrol the participant. An ENDED one
  // has to be created LIVE and ended afterwards: the assign path is frozen once a
  // session has ended, so an already-ended event cannot be built into this state
  // from outside (fixture checklist).
  async function eventInStatus(api, csrf, status, userId, kind = "tournament") {
    if (status === "upcoming") {
      const c = await makeEvent(api, csrf, { kind, startsInMin: 120, durationMin: 240 });
      await assign(api, csrf, c.id, [userId]);
      return c;
    }
    const c = await makeEvent(api, csrf, { kind, startsInMin: -20, durationMin: 600 });
    await assign(api, csrf, c.id, [userId]);
    if (status === "ended") {
      const en = await api.post(`/api/admin/competitions/${c.id}/end-now`, { headers: H(csrf) });
      expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
    }
    return c;
  }

  // Assert the status the fixture claims, so a test that silently built the wrong
  // thing fails as a PRECONDITION rather than as a landing-rule regression.
  async function assertStatus(api, compId, want) {
    const listed = await (await api.get("/api/admin/competitions?limit=500")).json();
    const rows = Array.isArray(listed) ? listed : (listed.competitions || []);
    const row = rows.find(c => c.id === compId);
    expect(row && row.status, `PRECONDITION: the fixture event must read "${want}"`).toBe(want);
  }

  test("every STATUS resumes at sign-in — live, upcoming and ended alike", async () => {
    const { api, csrf } = await sa();
    for (const status of ["live", "upcoming", "ended"]) {
      const p = await makeParticipant(api, csrf);
      const target = await eventInStatus(api, csrf, status, p.id);
      // A SECOND event, so the sole-event landing cannot answer for the marker.
      const decoy = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 300, durationMin: 60 });
      await assign(api, csrf, decoy.id, [p.id]);
      await assertStatus(api, target.id, status);

      const a1 = await signIn(p.email);
      expect((await select(a1.api, a1.csrf, target.id)).ok(), `select (${status})`).toBeTruthy();
      await a1.api.dispose();

      const a2 = await signIn(p.email);
      expect(a2.d.autoResumeCompetitionId, `a ${status} event they chose and never left`).toBe(target.id);
      const me = await (await a2.api.get("/api/me")).json();
      expect(me.competitionId, `and the session points at it (${status})`).toBe(target.id);
      await a2.api.dispose();
    }
    await api.dispose();
  });

  test("every KIND resumes — booth, competition and program, each of them ENDED", async () => {
    // Kind and status stacked, because those were the two carve-outs and a build
    // that dropped only one of them would pass a test that varied only the other.
    const { api, csrf } = await sa();
    for (const kind of ["booth", "tournament", "program"]) {
      const p = await makeParticipant(api, csrf);
      // A Program's schedule is a deadline, so it cannot be built "ended" the same
      // way; end-now is what finishes it either way.
      const target = kind === "program"
        ? await (async () => {
            // It must be LIVE before end-now will take it: an upcoming event is
            // refused with "Event is not currently live".
            const c = await makeEvent(api, csrf, { kind: "program", startsInMin: -20 });
            await assign(api, csrf, c.id, [p.id]);
            const en = await api.post(`/api/admin/competitions/${c.id}/end-now`, { headers: H(csrf) });
            expect(en.ok(), `end program: ${await en.text()}`).toBeTruthy();
            return c;
          })()
        : await eventInStatus(api, csrf, "ended", p.id, kind);
      const decoy = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 300, durationMin: 60 });
      await assign(api, csrf, decoy.id, [p.id]);
      await assertStatus(api, target.id, "ended");

      const a1 = await signIn(p.email);
      expect((await select(a1.api, a1.csrf, target.id)).ok(), `select (${kind})`).toBeTruthy();
      await a1.api.dispose();

      const a2 = await signIn(p.email);
      expect(a2.d.autoResumeCompetitionId, `an ended ${kind} is still the event they chose`).toBe(target.id);
      await a2.api.dispose();
    }
    await api.dispose();
  });

  test("being enrolled in a LIVE event elsewhere changes nothing", async () => {
    // The sharpest phrasing of "regardless of what else they are enrolled in":
    // three events, the chosen one is the FINISHED one, and the platform must
    // still put them there rather than in the one that is running.
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    const chosen = await eventInStatus(api, csrf, "ended", p.id);
    const live = await eventInStatus(api, csrf, "live", p.id);
    const upcoming = await eventInStatus(api, csrf, "upcoming", p.id);
    await assertStatus(api, chosen.id, "ended");
    await assertStatus(api, live.id, "live");

    const a1 = await signIn(p.email);
    expect((await a1.api.get("/api/my-competitions")).ok()).toBeTruthy();
    expect((await select(a1.api, a1.csrf, chosen.id)).ok()).toBeTruthy();
    await a1.api.dispose();

    const a2 = await signIn(p.email);
    expect((a2.d.competitions || []).length,
      "PRECONDITION: they really are in three events, or this proves nothing").toBe(3);
    expect(a2.d.autoResumeCompetitionId, "the marker, not the liveliest option").toBe(chosen.id);
    expect(a2.d.autoResumeCompetitionId).not.toBe(live.id);
    expect(a2.d.autoResumeCompetitionId).not.toBe(upcoming.id);
    await a2.api.dispose();
    await api.dispose();
  });

  test("an ENDED event resumes through the EMAILED CODE door too", async () => {
    const { api, csrf } = await sa();
    const email = `${uniq()}@company.example`;
    // desk-invite creates a PASSWORDLESS account, the only kind the code door
    // serves (`password_set_at IS NULL`).
    const di = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
    expect(di.status(), `desk-invite: ${await di.text()}`).toBe(200);
    const walkId = (await di.json()).user?.id
      || (await (await api.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email)?.id;
    expect(walkId, "the walk-up account must exist").toBeTruthy();
    // desk-invite collects only an address, so select-competition would refuse it
    // with `profile_incomplete` — the gate, not the door under test.
    const fill = await api.put(`/api/admin/participants/${walkId}`, {
      headers: H(csrf),
      data: { company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
              jobFunction: "Software Developer / Engineer", city: "New York" },
    });
    expect(fill.ok(), `fill profile: ${await fill.text()}`).toBeTruthy();

    const target = await eventInStatus(api, csrf, "ended", walkId, "booth");
    const decoy = await makeEvent(api, csrf, { kind: "booth", startsInMin: 300, durationMin: 60 });
    await assign(api, csrf, decoy.id, [walkId]);
    await assertStatus(api, target.id, "ended");

    const redeem = async () => {
      const code = await liveCode(api, csrf, walkId, email);
      const { api: a, csrf: ac } = await freshCtx();
      const rr = await a.post("/api/auth/code/redeem", { headers: H(ac), data: { email, code } });
      // 200 always — the contract. Branch on the PAYLOAD, never the status.
      expect(rr.status(), "the redeem endpoint answers 200 for every outcome").toBe(200);
      const d = await rr.json();
      expect(d.ok, `redeem refused: ${JSON.stringify(d)}`).toBeTruthy();
      return a;
    };

    const a1 = await redeem();
    const c1 = (await (await a1.get("/api/csrf-token")).json()).csrfToken;
    expect((await select(a1, c1, target.id)).ok()).toBeTruthy();
    await a1.dispose();

    const a2 = await redeem();
    expect((await (await a2.get("/api/me")).json()).competitionId,
      "redeeming a code IS signing in, and it lands where the password door would").toBe(target.id);

    // ANTI-VACUITY: the same door, after pressing Events, must land on the list.
    const c2 = (await (await a2.get("/api/csrf-token")).json()).csrfToken;
    expect((await a2.post("/api/deselect-competition", { headers: H(c2) })).ok()).toBeTruthy();
    await a2.dispose();

    const a3 = await redeem();
    expect((await (await a3.get("/api/me")).json()).competitionId,
      "CONTROL: the events list is the opt-out at this door too").toBeFalsy();
    await a3.dispose();
    await api.dispose();
  });



  test("REMOVED from the marked event: no resume, and the marker is dropped", async () => {
    // Not an exception to the rule — a condition that is not about the event.
    // Resuming here would 403 on the participant's very next request.
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    const target = await eventInStatus(api, csrf, "live", p.id);
    // TWO events must SURVIVE the removal. With one left the sole-event landing
    // fires and answers correctly — so the first draft of this test failed
    // against working code, measuring the wrong rule (the v8.3.12 lesson).
    for (const mins of [300, 400]) {
      const o = await makeEvent(api, csrf, { kind: "tournament", startsInMin: mins, durationMin: 60 });
      await assign(api, csrf, o.id, [p.id]);
    }

    const a1 = await signIn(p.email);
    expect((await select(a1.api, a1.csrf, target.id)).ok()).toBeTruthy();
    await a1.api.dispose();

    const rm = await api.delete(`/api/admin/competitions/${target.id}/users/${p.id}`, { headers: H(csrf) });
    expect(rm.ok(), `remove: ${await rm.text()}`).toBeTruthy();
    expect((await rm.json()).removed, "the removal must actually have removed them").toBe(true);
    await api.dispose();

    const a2 = await signIn(p.email);
    expect(a2.d.autoResumeCompetitionId, "they are not in it any more").toBeFalsy();
    expect((await (await a2.api.get("/api/me")).json()).competitionId,
      "and the session must not point at it either").toBeFalsy();
    await a2.api.dispose();
  });

  test("a DELETED marked event: no resume, and the sign-in still works", async () => {
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    const target = await eventInStatus(api, csrf, "upcoming", p.id);
    // TWO surviving events, for the same reason as the removal test above.
    const survivors = [];
    for (const mins of [300, 400]) {
      const o = await makeEvent(api, csrf, { kind: "tournament", startsInMin: mins, durationMin: 60 });
      await assign(api, csrf, o.id, [p.id]);
      survivors.push(o);
    }
    const other = survivors[0];

    const a1 = await signIn(p.email);
    expect((await select(a1.api, a1.csrf, target.id)).ok()).toBeTruthy();
    await a1.api.dispose();

    const del = await api.delete(`/api/admin/competitions/${target.id}`, { headers: H(csrf) });
    expect(del.ok(), `delete: ${await del.text()}`).toBeTruthy();
    await api.dispose();

    const a2 = await signIn(p.email);
    expect(a2.d.autoResumeCompetitionId, "there is nothing to resume into").toBeFalsy();
    expect((a2.d.competitions || []).some(c => c.id === other.id),
      "and the sign-in is otherwise unharmed — the other event is still offered").toBeTruthy();
    await a2.api.dispose();
  });

  test("NEVER entered anything: with two events they are still asked", async () => {
    // The control the whole block rests on. Every "it resumed" assertion above is
    // equally satisfied by a build that lands somebody somewhere unconditionally;
    // this is the case that must NOT land.
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    await eventInStatus(api, csrf, "live", p.id);
    await eventInStatus(api, csrf, "upcoming", p.id);
    await api.dispose();

    const a = await signIn(p.email);
    expect((a.d.competitions || []).length, "PRECONDITION: two events, so there IS a choice").toBe(2);
    expect(a.d.autoResumeCompetitionId, "they have chosen nothing, so they are asked").toBeFalsy();
    expect((await (await a.api.get("/api/me")).json()).competitionId).toBeFalsy();
    await a.api.dispose();
  });

  test("the pin survives a sign-out with no other action — many sign-ins, one choice", async () => {
    // "Asked to choose ONCE" taken literally: three sign-ins after the single
    // select, each in a brand-new context, so only the durable marker can carry
    // the answer. A marker cleared by the READ (which is what v8.3.8 fixed and
    // what a careless refactor would restore) fails on the second round.
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);
    const target = await eventInStatus(api, csrf, "ended", p.id);
    const other = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 300, durationMin: 60 });
    await assign(api, csrf, other.id, [p.id]);
    await api.dispose();

    const a1 = await signIn(p.email);
    expect((await select(a1.api, a1.csrf, target.id)).ok()).toBeTruthy();
    await a1.api.dispose();

    for (const round of [1, 2, 3]) {
      const a = await signIn(p.email);
      expect(a.d.autoResumeCompetitionId, `round ${round}: the choice must not be spent by reading it`).toBe(target.id);
      await a.api.dispose();
    }
  });
});

test.describe("the browser half — where boot() actually lands, and how a departure is reported", () => {

  test("v8.3.15: a fresh sign-in lands INSIDE a finished event, in a real browser", async ({ page }) => {
    // The API tests assert `me.competitionId`. This asserts what the participant
    // actually SEES, because the server pointing at an event and `boot()` routing
    // there are two different claims — and the reported symptom was always the
    // second one ("I get the events page").
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: -20, durationMin: 600 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    // A SECOND event, so the sole-event landing cannot be what puts them there.
    const other = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 300, durationMin: 60 });
    await assign(api, csrf, other.id, [p.id]);

    // Choose it while it is live, then end it — the assign path is frozen once a
    // session has ended, so it cannot be built into this state from outside.
    const first = await signIn(p.email);
    expect((await select(first.api, first.csrf, comp.id)).ok()).toBeTruthy();
    await first.api.dispose();
    const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
    await api.dispose();

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const li = await codeLogin(page.request, p.email, H(csrfToken));
    expect(li.ok(), `login: ${await li.text()}`).toBeTruthy();
    expect((await li.json()).autoResumeCompetitionId, "the server resumed it").toBe(comp.id);

    await page.goto("/");
    // An ended event routes into the challenge view, not the countdown — and the
    // status poll greets it with the "Event Ended" modal, which is correct
    // and is what a participant coming back to review actually sees.
    await page.locator("#tasks-page").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#competitions-page")).toBeHidden();
    await expect.poll(async () => (await (await page.request.get("/api/me")).json()).competitionId,
      { timeout: 10000, message: "the browser session must be inside the finished event" }).toBe(comp.id);
  });

  test("clicking the Events nav item clears the resume, and a reload lands on the list", async ({ page }) => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { kind: "tournament", startsInMin: 60 });
    const p = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [p.id]);
    await api.dispose();

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const li = await codeLogin(page.request, p.email, H(csrfToken));
    expect(li.ok(), `login: ${await li.text()}`).toBeTruthy();

    // Choose it once, the way a participant would, so there is something to
    // resume. boot() then routes straight in — the pending page, since it has
    // not started.
    // A login REGENERATES the session, so the pre-login token is dead — take a
    // fresh one before the first authenticated write.
    const { csrfToken: c2 } = await (await page.request.get("/api/csrf-token")).json();
    const sel = await page.request.post("/api/select-competition", {
      headers: H(c2), data: { competitionId: comp.id },
    });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#pending-page").waitFor({ state: "visible", timeout: 20000 });

    await page.locator('[data-action="nav-competitions"]').click();
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 15000 });

    // The write is fire-and-forget from the client's side, so poll for it rather
    // than assuming it landed before the render.
    await expect.poll(async () => {
      const me = await (await page.request.get("/api/me")).json();
      return me.competitionId || null;
    }, { timeout: 10000, message: "leaving for the event list must clear the session pointer" }).toBeNull();

    // A reload of the still-open tab therefore lands on the list, not back inside.
    await page.reload();
    await page.locator("#competitions-page").waitFor({ state: "visible", timeout: 20000 });

    // And the durable half: a brand-new sign-in no longer resumes. This runs
    // LAST, because one session per user is enforced — signing in elsewhere
    // invalidates the page's session, so anything after it would be asserting
    // against the login screen.
    const s = await signIn(p.email);
    expect(s.d.autoResumeCompetitionId).toBeFalsy();
    await s.api.dispose();
  });
});
