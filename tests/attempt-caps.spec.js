// v8.1.0 — PR 22: attempt caps, server half.
//
// An event or a challenge can carry a ceiling on attempts, exhaustion is a named
// recoverable state, and the auto-end predicate understands it.
//
// THE FIXTURES ALL OWN THEIR OWN COMPETITION, CHALLENGES AND PARTICIPANTS, and
// several deliberately enrol a participant who never submits — with one
// participant solving one challenge the all-solved auto-end fires and ends the
// competition underneath the test (fixture checklist item 1).
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ac${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Cap", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

/** A live competition, N challenges, and the given participants enrolled. */
async function makeFixture(api, csrf, { compCap = null, taskCaps = [null], people = 1, minutes = 600 } = {}) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
      duration_minutes: minutes, timezone: "UTC",
      ...(compCap === null ? {} : { attempt_cap: compCap }),
    },
  });
  expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const tasks = [];
  for (let i = 0; i < taskCaps.length; i++) {
    const title = `${uniq()} T${i}`;
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: {
        title, description: "d", difficulty: "easy",
        answer_type: "text", correct_answer: `right${i}`, status: "published",
        ...(taskCaps[i] === null ? {} : { attempt_cap: taskCaps[i] }),
      },
    });
    expect(tr.ok(), `create task ${i}: ${await tr.text()}`).toBeTruthy();
    // Take the id the create RETURNS. The first draft fell back to
    // `.find(x => x.title.endsWith("T0"))`, which matches a task created by an
    // EARLIER TEST IN THIS FILE — so several tests silently measured another
    // test's cap and the failures pointed at the resolver instead of the fixture.
    const { id: tid } = await tr.json();
    expect(tid, "the create returns the new challenge's id").toBeTruthy();
    const asg = await api.post(`/api/admin/tasks/${tid}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign task ${i}: ${await asg.text()}`).toBeTruthy();
    const t = { id: (await asg.json()).copies[0].task_id, bankId: tid, title };   // the event's own copy (lib/event-copies.js): what its participants open and answer
    tasks.push(t);
  }

  const users = [];
  for (let i = 0; i < people; i++) users.push(await makeParticipant(api, csrf, uniq()));
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [comp.id] },
  });
  expect(asg.ok(), `assign users: ${await asg.text()}`).toBeTruthy();
  expect((await asg.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(users.length);
  return { comp, tasks, users };
}

/** Sign a participant in and put them into the competition. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/** One submission through the real path, carrying the grading token. */
async function submit(api, csrf, taskId, answer) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/**
 * v8.3.11 — the competition's `auto_ended` audit row, POLLED.
 *
 * Two independent reasons this may not be a single read, and either alone would
 * make the assertion flaky rather than wrong:
 *   • the submit path collects its event INSERTs and drains them POST-COMMIT on a
 *     `setImmediate` tick, so a read taken the instant the submit response
 *     returns races the drain (the standing rule in CLAUDE.md);
 *   • `/api/admin/competitions/:id/events` is cached for 5 s, so a first read
 *     that legitimately missed would then be SERVED FROM THAT CACHE for the whole
 *     of a short poll. `limit` is varied per attempt for no reason other than to
 *     move the cache key — it is part of the key, the row set is not affected.
 *
 * Returns the `details` blob, so the caller asserts about the RECORD rather than
 * about the fact that something was emitted.
 */
async function pollAutoEndedDetails(api, compId) {
  let found = null;
  let n = 0;
  await expect.poll(async () => {
    const r = await api.get(`/api/admin/competitions/${compId}/events?limit=${200 + (n++)}`);
    if (!r.ok()) return `HTTP ${r.status()}`;
    const rows = (await r.json()).events || [];
    found = rows.find(e => e.event_type === "auto_ended"
      && e.details && e.details.reason === "all_participants_solved") || null;
    return found ? "found" : `no auto_ended row yet (${rows.length} event(s) so far)`;
  }, {
    timeout: 20000, intervals: [100, 200, 400, 800, 1600],
    message: "the competition's auto_ended audit row never landed",
  }).toBe("found");
  return found.details;
}

test.describe("v8.1.0 — attempt caps", () => {
  test("the cap refuses the attempt after the last one, with 200 and no penalty", async () => {
    const { api, csrf } = await sa();
    try {
      // TWO participants: the second never submits, so the all-solved auto-end
      // cannot fire and end the competition mid-test.
      const f = await makeFixture(api, csrf, { taskCaps: [3], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        for (let i = 1; i <= 3; i++) {
          const r = await submit(p.api, p.csrf, f.tasks[0].id, `wrong-${i}`);
          expect(r.status, `attempt ${i} is accepted`).toBe(200);
          expect(r.body.refused, `attempt ${i} is not refused`).toBeFalsy();
          expect(r.body.attempts_left, `attempt ${i} reports what is left`).toBe(3 - i);
          expect(r.body.pointsDelta, "a wrong answer still costs the ordinary penalty").toBeLessThan(0);
        }
        const r4 = await submit(p.api, p.csrf, f.tasks[0].id, "wrong-4");
        // 200, NOT 4xx. A non-429 4xx feeds the scanner-reputation counter, which
        // blocks the WHOLE address for 15 minutes at 100 in ten — a room of
        // participants behind one NAT hitting a cap they were told about must not
        // lock the venue out of the API mid-event.
        expect(r4.status, "a refusal is a 200, or a venue behind one NAT gets banned").toBe(200);
        expect(r4.body.refused).toBe("attempts_exhausted");
        // The single most dangerous field: a 200 landing in the client's existing
        // `if (!d.correct)` branch renders "Incorrect. -5 pts penalty."
        expect(r4.body.pointsDelta, "the refusal takes NO penalty").toBe(0);
        expect(r4.body.attempts_left).toBe(0);
        expect(r4.body.correct).toBe(false);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a de-duplicated re-send does NOT spend an attempt", async () => {
    // The positive control for what an "attempt" is. Without it, "3 attempts then
    // refused" is equally satisfied by a build that counts requests — and a
    // double-click would then silently cost two of three.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [3], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const a = await submit(p.api, p.csrf, f.tasks[0].id, "same-answer");
        expect(a.body.attempts_left).toBe(2);
        const b = await submit(p.api, p.csrf, f.tasks[0].id, "same-answer"); // inside the 3 s window
        expect(b.body.deduped, "the second is folded into the first").toBe(true);
        // v8.13.1 (external audit) — and it says where the participant STANDS.
        // The repeat is usually a retry whose first response was lost, so the
        // card is still showing the count from before that answer; v8.1.0 sent
        // no attempt fields here at all ("unchanged"), which left it there.
        expect(b.body.attempts_left, "the dedup reports the CURRENT standing").toBe(2);
        expect(b.body.attempts_used).toBe(1);
        expect(b.body.attempts_cap).toBe(3);
        expect(b.body.pointsDelta, "and charges nothing").toBe(0);
        // A third DIFFERENT answer must still be attempt 2 of 3, not 3 of 3.
        const c = await submit(p.api, p.csrf, f.tasks[0].id, "other-answer");
        expect(c.body.attempts_left, "the dedup spent nothing").toBe(1);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("v8.13.1 — a folded repeat reports the standing, down to the LAST attempt", async () => {
    // The external auditor's case, at the wire. A participant whose answer's
    // response was lost resubmits it; the server folds the repeat into the
    // original and must tell them what that original cost, or the card goes on
    // saying "2 left" with 1 left and never shows the last-attempt warning.
    //
    // DIFFERENT wrong answers first, so the standing actually moves between the
    // repeats — a dedup that always echoed the cap, or one computed before the
    // original was charged, reads 3 or 2 here, never 1 and 0.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [3], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const t = f.tasks[0].id;
        expect((await submit(p.api, p.csrf, t, "wrong-a")).body.attempts_left, "precondition: attempt 1 charged").toBe(2);
        const w2 = await submit(p.api, p.csrf, t, "wrong-b");
        expect(w2.body.attempts_left, "precondition: attempt 2 charged").toBe(1);
        expect(w2.body.deduped, "precondition: a DIFFERENT answer is not folded").toBeFalsy();

        const again2 = await submit(p.api, p.csrf, t, "wrong-b"); // the retry, inside 3 s
        expect(again2.status).toBe(200);
        expect(again2.body.deduped, "the retry is folded into attempt 2").toBe(true);
        expect(again2.body.correct, "the original's own grade, verbatim").toBe(false);
        expect(again2.body.pointsDelta, "a fold charges nothing").toBe(0);
        expect(again2.body.attempts_left, "ONE left — what the card must now show").toBe(1);
        expect(again2.body.attempts_used).toBe(2);
        expect(again2.body.attempts_cap).toBe(3);

        // The last attempt, lost and retried: the fold says the budget is GONE.
        // It is answered as a fold, not as the exhausted refusal, because dedup
        // runs before the cap — and that is right: this request is the same
        // logical attempt, which the server already graded.
        expect((await submit(p.api, p.csrf, t, "wrong-c")).body.attempts_left, "precondition: the last attempt charged").toBe(0);
        const again3 = await submit(p.api, p.csrf, t, "wrong-c");
        expect(again3.body.deduped).toBe(true);
        expect(again3.body.refused, "a fold of the last attempt is not a refusal").toBeFalsy();
        expect(again3.body.pointsDelta).toBe(0);
        expect(again3.body.attempts_left, "the budget is spent — the client locks on this").toBe(0);
        expect(again3.body.attempts_used).toBe(3);

        // And the cap still binds a NEW answer: the fold did not reopen anything.
        const after = await submit(p.api, p.csrf, t, "wrong-d");
        expect(after.body.refused).toBe("attempts_exhausted");
        const me = await (await p.api.get("/api/me")).json();
        expect(me.score, "three wrong answers charged, the two folds nothing").toBe(-15);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("v8.13.1 — a fold reports the CURRENT standing, not the one as of the answer it folds into", async () => {
    // A, then a DIFFERENT B, then A again inside the window: the repeat folds
    // into A, but what the card must show is what is left NOW — B was charged
    // too. A standing computed "as of A" would say 2 and the card would offer
    // one more answer than the server will take before locking.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [3], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const t = f.tasks[0].id;
        expect((await submit(p.api, p.csrf, t, "answer-a")).body.attempts_left, "precondition: A charged").toBe(2);
        expect((await submit(p.api, p.csrf, t, "answer-b")).body.attempts_left, "precondition: B charged").toBe(1);
        const againA = await submit(p.api, p.csrf, t, "answer-a");
        expect(againA.body.deduped, "precondition: the repeat of A is folded (inside 3 s of A)").toBe(true);
        expect(againA.body.attempts_left, "what is left NOW, B included").toBe(1);
        expect(againA.body.attempts_used).toBe(2);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("v8.13.1 — an UNCAPPED fold carries no CAP keys, only the count — the control", async () => {
    // The cap fields are `attemptsWire`'s projection and absent when there is no
    // cap — the shape every client already reads as "this challenge has no limit".
    // Without this, the test above is equally satisfied by a build that invents
    // a cap for every challenge. (Since v8.13.2 the plain count rides along.)
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [null], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const first = await submit(p.api, p.csrf, f.tasks[0].id, "same-wrong");
        expect(first.body.deduped, "precondition: the first is graded").toBeFalsy();
        const again = await submit(p.api, p.csrf, f.tasks[0].id, "same-wrong");
        expect(again.body.deduped, "precondition: the repeat is folded").toBe(true);
        expect(again.body.correct).toBe(false);
        for (const k of ["attempts_left", "attempts_used", "attempts_cap"]) {
          expect(again.body, `an uncapped fold sends no ${k}`).not.toHaveProperty(k);
        }
        // v8.13.2 — the COUNT is not a cap field, and the fold carries it: the
        // repeat is usually a retry whose first response was lost, so the card's
        // "N attempt(s)" is from before that first answer. The fold stores none.
        expect(again.body.attempts, "the fold reports the one answer stored, not two").toBe(1);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("most-specific-wins: a challenge cap beats the event cap", async () => {
    const { api, csrf } = await sa();
    try {
      // Event says 5, this challenge says 2. The challenge wins.
      const f = await makeFixture(api, csrf, { compCap: 5, taskCaps: [2, null], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        expect((await submit(p.api, p.csrf, f.tasks[0].id, "w1")).body.attempts_left).toBe(1);
        expect((await submit(p.api, p.csrf, f.tasks[0].id, "w2")).body.attempts_left).toBe(0);
        const r3 = await submit(p.api, p.csrf, f.tasks[0].id, "w3");
        expect(r3.body.refused, "the CHALLENGE cap of 2 is what bound").toBe("attempts_exhausted");
        // The sibling challenge has no cap of its own, so it inherits the event's.
        const s1 = await submit(p.api, p.csrf, f.tasks[1].id, "x1");
        expect(s1.body.attempts_left, "an uncapped challenge falls back to the event cap").toBe(4);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("an uncapped challenge reports no CAP fields — only the count", async () => {
    // The cap keys are ABSENT rather than null, which is the shape a client
    // already handles. Also the negative control for the whole feature: with no
    // cap anywhere, nothing about submitting changes.
    //
    // v8.13.2 — retitled from "no attempt fields at all": the plain COUNT
    // (`attempts`) now rides every graded answer, capped or not (the external
    // audit's stale-header finding — see the describe below). What must stay
    // absent is everything that describes a CEILING.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [null], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const r = await submit(p.api, p.csrf, f.tasks[0].id, "nope");
        for (const k of ["attempts_left", "attempts_cap", "attempts_used"]) {
          expect(r.body, `an uncapped answer sends no ${k}`).not.toHaveProperty(k);
        }
        expect(r.body.attempts, "but it does say how many answers are stored").toBe(1);
        const view = await (await p.api.get(`/api/tasks/${f.tasks[0].id}`)).json();
        expect(view).not.toHaveProperty("attempts_left");
        expect(view, "and the RAW column is never on the participant wire").not.toHaveProperty("attempt_cap");
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the participant view carries the EFFECTIVE cap, and a grant moves it", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [2], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        let view = await (await p.api.get(`/api/tasks/${f.tasks[0].id}`)).json();
        expect(view.attempts_cap).toBe(2);
        expect(view.attempts_left).toBe(2);
        expect(view, "the base column stays off the wire").not.toHaveProperty("attempt_cap");

        await submit(p.api, p.csrf, f.tasks[0].id, "w1");
        await submit(p.api, p.csrf, f.tasks[0].id, "w2");
        const blocked = await submit(p.api, p.csrf, f.tasks[0].id, "w3");
        expect(blocked.body.refused).toBe("attempts_exhausted");

        const g = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, {
          headers: H(csrf), data: { userId: f.users[0].id, competitionId: f.comp.id, extra: 2 },
        });
        expect(g.ok(), `grant: ${g.status()} ${await g.text()}`).toBeTruthy();
        const gb = await g.json();
        expect(gb.attempts.left).toBe(2);

        view = await (await p.api.get(`/api/tasks/${f.tasks[0].id}`)).json();
        expect(view.attempts_cap, "the participant is shown base + grant, never the base").toBe(4);
        expect(view.attempts_left).toBe(2);
        const after = await submit(p.api, p.csrf, f.tasks[0].id, "right0");
        expect(after.body.correct, "and they can actually act again").toBe(true);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("grants ACCUMULATE — a second admin's grant does not discard the first", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [1], people: 2 });
      const one = { headers: H(csrf), data: { userId: f.users[0].id, competitionId: f.comp.id, extra: 1 } };
      const a = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, one);
      const b = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, one);
      expect(a.ok() && b.ok()).toBeTruthy();
      expect((await b.json()).granted_total, "an INSERT OR REPLACE would answer 1 and lose the first grant").toBe(2);
    } finally { await api.dispose(); }
  });

  test("a grant on an UNCAPPED challenge is refused by name, not silently stored", async () => {
    // "Nothing happened" is the failure a desk cannot diagnose.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [null], people: 1 });
      const g = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, {
        headers: H(csrf), data: { userId: f.users[0].id, competitionId: f.comp.id, extra: 1 },
      });
      expect(g.status()).toBe(409);
      expect((await g.json()).code).toBe("not_capped");
    } finally { await api.dispose(); }
  });

  test("a capped event AUTO-ENDS when everyone is solved-or-exhausted", async () => {
    const { api, csrf } = await sa();
    try {
      // One challenge, cap 2, two participants. One solves it; the other burns
      // both attempts. Nobody has "solved everything", so the OLD predicate would
      // leave this competition running to its deadline with nothing to wait for.
      const f = await makeFixture(api, csrf, { taskCaps: [2], people: 2 });
      const solver = await enter(f.users[0].email, f.comp.id);
      const burner = await enter(f.users[1].email, f.comp.id);
      try {
        expect((await submit(solver.api, solver.csrf, f.tasks[0].id, "right0")).body.correct).toBe(true);
        const stillLive = await (await api.get("/api/admin/competitions")).json();
        expect((stillLive.find(c => c.id === f.comp.id) || {}).status,
          "one solver is not everybody — it must still be live here").toBe("live");

        await submit(burner.api, burner.csrf, f.tasks[0].id, "w1");
        const last = await submit(burner.api, burner.csrf, f.tasks[0].id, "w2");
        expect(last.body.attempts_left).toBe(0);

        const after = await (await api.get("/api/admin/competitions")).json();
        const row = after.find(c => c.id === f.comp.id);
        expect(row.status, "solved-or-exhausted IS finished").toBe("ended");
        expect(row.ended_at, "and it is a real auto-end, not a clock expiry").toBeTruthy();

        // ── v8.3.11 — AND THE RECORD SAYS WHY IT FIRED ──────────────────────
        // Since v8.1.0 the predicate behind this event means "solved OR out of
        // attempts", while the emit still recorded `all_participants_solved` and
        // the History dialog rendered "all participants solved all challenges"
        // unconditionally. On this very fixture that is a FALSE CLAIM in the one
        // record an admin opens to find out what happened: exactly one of the two
        // participants solved anything at all.
        //
        // The number is asserted, not merely its presence: a build emitting the
        // count of PARTICIPANTS rather than the count of EXHAUSTED ones would
        // answer 2 here and still satisfy a `toBeTruthy`.
        const details = await pollAutoEndedDetails(api, f.comp.id);
        expect(details.exhausted_participants,
          "one of the two finished by running out of attempts, not by solving").toBe(1);
      } finally { await solver.api.dispose(); await burner.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("v8.3.11 — an ordinary all-solved auto-end says NOTHING about exhaustion", async () => {
    // THE ANTI-VACUITY CONTROL for the assertion above, and it has to be its own
    // fixture: "the key is present and correct" is equally satisfied by a build
    // that emits `exhausted_participants` unconditionally, which would put the
    // exhaustion sentence on the History of every ordinary event on the platform.
    //
    // The existing uncapped control ("the SAME shape UNCAPPED does not auto-end")
    // cannot serve here — it asserts the event stays LIVE, so it never produces an
    // `auto_ended` row at all and can say nothing about that row's shape.
    //
    // So: uncapped, and EVERYBODY genuinely solves everything. `exhausted` is 0,
    // the key is omitted, and the History renders byte-identically to every
    // pre-v8.3.11 row — absence is the existing shape, not a new one.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [null], people: 2 });
      const a = await enter(f.users[0].email, f.comp.id);
      const b = await enter(f.users[1].email, f.comp.id);
      try {
        expect((await submit(a.api, a.csrf, f.tasks[0].id, "right0")).body.correct).toBe(true);
        expect((await submit(b.api, b.csrf, f.tasks[0].id, "right0")).body.correct).toBe(true);

        // POSITIVE HALF FIRST — without it, "the key is absent" is satisfied by a
        // build in which this event never auto-ended and there is no row to read.
        const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
        expect(row.status, "everybody solving everything still auto-ends an uncapped event").toBe("ended");
        const details = await pollAutoEndedDetails(api, f.comp.id);

        // …and the negative half, asserted as ABSENCE rather than as falsiness: an
        // unconditional emit of the real count would write 0 here, which `toBeFalsy`
        // would happily accept while the key had in fact returned.
        expect(Object.prototype.hasOwnProperty.call(details, "exhausted_participants"),
          "nobody ran out of attempts, so the key must not be there at all").toBe(false);
      } finally { await a.api.dispose(); await b.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("v8.3.11 — the History renderer BRANCHES on exhausted_participants", async () => {
    // SCOPE, STATED HONESTLY: this proves the `auto_ended` arm exists and is keyed
    // on the field the server emits. It does NOT prove the sentence reads well —
    // that is a copy judgement no scanner can make. It is a source lock rather than
    // a browser one because reaching the History dialog's auto_ended line needs an
    // admin session, a fixture that auto-ended, and the dialog open on it, for a
    // claim about one `if` — and the field's presence/absence contract is already
    // driven end to end by the two tests above.
    const file = path.join(__dirname, "..", "public", "js", "features", "history.js");
    const raw = fs.readFileSync(file, "utf8");

    // STRIP COMMENTS FIRST, and this is not tidiness (v7.21.24): the comment block
    // the fix added sits immediately above the branch and NAMES the field twice, so
    // an unstripped scan reports a clean tree against a build whose branch has been
    // deleted and whose comment survives. One left-to-right alternation so whichever
    // form opens first wins, newlines preserved so a failure can name a line.
    const src = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ""));

    const start = src.indexOf("case 'auto_ended'");
    expect(start, "the auto_ended case still exists in history.js").toBeGreaterThan(-1);
    // The next `case '` bounds the arm; the branch's own template literal carries
    // `${ex}` and no case label, so this cannot over-run.
    const nextCase = src.indexOf("case '", start + 10);
    const arm = src.slice(start, nextCase > -1 ? nextCase : src.length);

    expect(arm, "the arm reads the field the server emits")
      .toMatch(/d\.exhausted_participants/);
    expect(arm, "…and still renders the ordinary sentence when nobody was exhausted")
      .toMatch(/all participants solved all challenges/);
    expect(arm, "…and a different one when somebody was")
      .toMatch(/ran out of attempts/);
  });

  test("the SAME shape UNCAPPED does not auto-end — the control", async () => {
    // Without this, "the capped event ended" is equally satisfied by a build that
    // ends events for some entirely different reason.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [null], people: 2 });
      const solver = await enter(f.users[0].email, f.comp.id);
      const burner = await enter(f.users[1].email, f.comp.id);
      try {
        await submit(solver.api, solver.csrf, f.tasks[0].id, "right0");
        await submit(burner.api, burner.csrf, f.tasks[0].id, "w1");
        await submit(burner.api, burner.csrf, f.tasks[0].id, "w2");
        await submit(burner.api, burner.csrf, f.tasks[0].id, "w3");
        const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
        expect(row.status, "an uncapped participant is never finished by running out").toBe("live");
      } finally { await solver.api.dispose(); await burner.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a grant on an ENDED event is PERMITTED — it is the only route out", async () => {
    // The revive paths refuse while everyone is solved-or-exhausted, so refusing
    // the grant too would make the state unrecoverable.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [1], people: 2 });
      const solver = await enter(f.users[0].email, f.comp.id);
      const burner = await enter(f.users[1].email, f.comp.id);
      try {
        await submit(solver.api, solver.csrf, f.tasks[0].id, "right0");
        await submit(burner.api, burner.csrf, f.tasks[0].id, "w1");
        const ended = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
        expect(ended.status, "precondition: the event has auto-ended").toBe("ended");

        const g = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, {
          headers: H(csrf), data: { userId: f.users[1].id, competitionId: f.comp.id, extra: 1 },
        });
        expect(g.ok(), `a grant on an ended event must be allowed: ${g.status()} ${await g.text()}`).toBeTruthy();
      } finally { await solver.api.dispose(); await burner.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the boundary is STRICT: zero, prose and fractions are refused", async () => {
    const { api, csrf } = await sa();
    try {
      const mk = (cap) => api.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title: `${uniq()} B`, description: "d", difficulty: "easy", answer_type: "text",
                correct_answer: "a", status: "published", attempt_cap: cap },
      });
      for (const bad of [0, -1, 1.5, "3 tries", "abc", 100000]) {
        const r = await mk(bad);
        expect(r.status(), `attempt_cap ${JSON.stringify(bad)} must be refused`).toBe(400);
      }
      // …and the positive control, or "everything 400s" passes the whole test.
      const ok = await mk(3);
      expect(ok.ok(), `a valid cap is accepted: ${await ok.text()}`).toBeTruthy();
      // "" means UNCAPPED, not invalid — a cleared number input must not 400.
      const cleared = await api.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title: `${uniq()} B2`, description: "d", difficulty: "easy", answer_type: "text",
                correct_answer: "a", status: "published", attempt_cap: "" },
      });
      expect(cleared.ok(), `an empty cap means uncapped: ${await cleared.text()}`).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("an edit can CLEAR a cap, which COALESCE alone cannot express", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { compCap: 4, taskCaps: [2], people: 1 });
      const t = f.tasks[0];
      // Say nothing → the cap is left alone.
      const untouched = await api.put(`/api/admin/tasks/${t.id}`, { headers: H(csrf), data: { title: `${t.title} v2` } });
      expect(untouched.ok(), await untouched.text()).toBeTruthy();
      let row = (await (await api.get("/api/admin/tasks")).json()).find(x => x.id === t.id);
      expect(row.attempt_cap, "an unrelated edit must not disturb the cap").toBe(2);
      // Explicit null → uncapped.
      const cleared = await api.put(`/api/admin/tasks/${t.id}`, { headers: H(csrf), data: { attempt_cap: null } });
      expect(cleared.ok(), await cleared.text()).toBeTruthy();
      row = (await (await api.get("/api/admin/tasks")).json()).find(x => x.id === t.id);
      expect(row.attempt_cap, "clearing has to be expressible").toBeFalsy();

      // Same on the competition, where the clear is written by its own statement.
      const cur = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
      expect(cur.attempt_cap).toBe(4);
      const cc = await api.put(`/api/admin/competitions/${f.comp.id}`, {
        headers: H(csrf), data: { attempt_cap: null, expectedUpdatedAt: cur.updated_at },
      });
      expect(cc.ok(), await cc.text()).toBeTruthy();
      const after = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
      expect(after.attempt_cap).toBeFalsy();
    } finally { await api.dispose(); }
  });

  test("the cap survives export → import, and a version restore", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [7], people: 1 });
      const t = f.tasks[0];

      const exp = await api.get(`/api/admin/export/tasks?competitionId=${f.comp.id}&include_attachment_content=0`);
      expect(exp.ok()).toBeTruthy();
      const file = await exp.json();
      const row = (file.tasks || []).find(x => x.title === t.title);
      expect(row, "the challenge is in the export").toBeTruthy();
      expect(row.attempt_cap, "…carrying its cap").toBe(7);

      // Import it under a new title so it lands as a create rather than a
      // conflict. The importer takes the WHOLE export envelope (`data`), not a
      // bare row array — it checks `data.type` before anything else.
      const renamed = { ...row, title: `${row.title} IMPORTED` };
      const imp = await api.post("/api/admin/import/tasks", {
        headers: H(csrf), data: { data: { ...file, tasks: [renamed] }, resolutions: {} },
      });
      expect(imp.ok(), `import: ${await imp.text()}`).toBeTruthy();
      const all = await (await api.get("/api/admin/tasks")).json();
      const landed = all.find(x => x.title === renamed.title);
      expect(landed, "the imported challenge exists").toBeTruthy();
      expect(landed.attempt_cap, "the importer HONOURS the cap — which is why it is exported").toBe(7);

      // Version restore: change the cap, then restore the earlier version.
      const put = await api.put(`/api/admin/tasks/${t.id}`, { headers: H(csrf), data: { attempt_cap: 2 } });
      expect(put.ok(), await put.text()).toBeTruthy();
      const versions = await (await api.get(`/api/admin/tasks/${t.id}/versions`)).json();
      expect(Array.isArray(versions) && versions.length, "there is a version to restore").toBeTruthy();
      // v8.12.4 — the version that holds cap 7, found by its snapshot rather than
      // assumed to be the last element; and the restore is ASSERTED, where it
      // used to sit behind `if (rest.ok())` and assert nothing when it failed.
      const snap = (v) => (typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : v.snapshot) || {};
      const target = versions.find(v => snap(v).attempt_cap === 7);
      expect(target, `a version holding cap 7: ${JSON.stringify(versions.map(v => [v.change_type, snap(v).attempt_cap]))}`).toBeTruthy();
      const rest = await api.post(`/api/admin/tasks/${t.id}/restore`, {
        headers: H(csrf), data: { versionId: target.id ?? target.version_id ?? target.version },
      });
      expect(rest.ok(), `restore: ${rest.status()} ${await rest.text()}`).toBeTruthy();
      const back = (await (await api.get("/api/admin/tasks")).json()).find(x => x.id === t.id);
      expect(back.attempt_cap,
        "the restore UPDATE's hand-maintained column list must carry attempt_cap — this is the v7.20.9 F4 shape"
      ).toBe(7);
    } finally { await api.dispose(); }
  });

  test("recalculate reports the participants it STRANDED", async () => {
    // A recalculate can flip a correct row to incorrect. On a capped challenge
    // that leaves someone exhausted with no correct submission and no way back,
    // through no action of their own — and `flipped` counts rows, which is
    // exactly what the admin asked for, so nothing on screen would say so.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [1], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        expect((await submit(p.api, p.csrf, f.tasks[0].id, "right0")).body.correct).toBe(true);
      } finally { await p.api.dispose(); }

      // Change the answer so the stored submission is no longer correct.
      const put = await api.put(`/api/admin/tasks/${f.tasks[0].id}`, {
        headers: H(csrf), data: { correct_answer: "something-else" },
      });
      expect(put.ok(), await put.text()).toBeTruthy();
      // `confirm_live` — the challenge is in a LIVE event, and recalculate refuses
      // that by default (rescoring mid-event). Confirming is the point here: the
      // stranding this test is about is only reachable on a live capped event.
      const rc = await api.post(`/api/admin/tasks/${f.tasks[0].id}/recalculate`, {
        headers: H(csrf), data: { confirm_live: true },
      });
      expect(rc.ok(), `recalculate: ${rc.status()} ${await rc.text()}`).toBeTruthy();
      const body = await rc.json();
      expect(body.flipped, "the row really did flip").toBeGreaterThan(0);
      expect(body.attempts_exhausted_after, "…and the admin is told somebody is now stranded").toBe(1);
      expect((body.attempts_exhausted_who || []).map(x => x.user_id),
        "…and WHO, because the remedy is per-participant").toContain(f.users[0].id);
    } finally { await api.dispose(); }
  });

  test("the grant endpoint refuses a non-participant target and a non-member", async () => {
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [2], people: 1 });
      // An admin target: the peer-admin doctrine stops at the participant tier.
      const admin = await makeParticipant(api, csrf, uniq());
      const promote = await api.post(`/api/admin/participants/${admin.id}/role`, { headers: H(csrf), data: { role: "admin" } });
      expect(promote.ok(), await promote.text()).toBeTruthy();
      const r1 = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, {
        headers: H(csrf), data: { userId: admin.id, competitionId: f.comp.id, extra: 1 },
      });
      expect(r1.status()).toBe(403);

      // A participant who is not enrolled in this event.
      const outsider = await makeParticipant(api, csrf, uniq());
      const r2 = await api.post(`/api/admin/tasks/${f.tasks[0].id}/attempt-grant`, {
        headers: H(csrf), data: { userId: outsider.id, competitionId: f.comp.id, extra: 1 },
      });
      expect(r2.status()).toBe(409);
      expect((await r2.json()).error).toMatch(/not enrolled/i);
    } finally { await api.dispose(); }
  });
});

// v8.13.2 (external audit, P3) — THE CARD'S "N attempt(s)" IS UPDATED FROM THE
// SUBMIT RESPONSE, AND AN UNCAPPED CHALLENGE'S RESPONSE CARRIED NO COUNT.
//
// The count lived only in the cap projection (`attempts_used`), so after a wrong
// answer on an uncapped challenge — the ordinary case — the score moved while the
// header kept the number from when the challenge was opened, until it was
// reopened. `attempts` is now on every graded, folded and refused answer, and it
// is the SAME number GET /api/tasks/:id sends as `attempts` (both read
// lib/attempts.js), so the card can never show two different counts for one
// challenge depending on how it got there.
test.describe("v8.13.2 — every answer carries the count the card prints", () => {
  test("uncapped: each answer reports the count INCLUDING itself, and it is the task view's own number", async () => {
    const { api, csrf } = await sa();
    try {
      // Two participants, so solving the one challenge does not auto-end the
      // event under the test (fixture checklist item 1).
      const f = await makeFixture(api, csrf, { taskCaps: [null], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const t = f.tasks[0].id;
        const before = await (await p.api.get(`/api/tasks/${t}`)).json();
        expect(before.attempts, "precondition: nothing submitted yet").toBe(0);
        const w1 = await submit(p.api, p.csrf, t, "wrong-1");
        expect(w1.body.correct, "precondition: graded wrong").toBe(false);
        expect(w1.body.attempts, "the first answer counts itself — not the pre-insert 0").toBe(1);
        const w2 = await submit(p.api, p.csrf, t, "wrong-2");
        expect(w2.body.attempts).toBe(2);
        const view = await (await p.api.get(`/api/tasks/${t}`)).json();
        expect(view.attempts, "the card's own number agrees with the last answer's").toBe(w2.body.attempts);
        const ok = await submit(p.api, p.csrf, t, "right0");
        expect(ok.body.correct, "precondition: the right answer is graded correct").toBe(true);
        expect(ok.body.attempts, "a correct answer is counted too").toBe(3);
        for (const k of ["attempts_left", "attempts_cap", "attempts_used"]) {
          expect(ok.body, `still no ${k} on an uncapped challenge`).not.toHaveProperty(k);
        }
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("capped: `attempts` equals `attempts_used` on a graded answer AND on the refusal — the control", async () => {
    // Without this, the test above is equally satisfied by a count that has
    // nothing to do with the cap's own count — two numbers for one fact, the
    // v8.13.1 two-counts-disagree defect through a new door.
    const { api, csrf } = await sa();
    try {
      const f = await makeFixture(api, csrf, { taskCaps: [2], people: 2 });
      const p = await enter(f.users[0].email, f.comp.id);
      try {
        const t = f.tasks[0].id;
        const w1 = await submit(p.api, p.csrf, t, "w1");
        expect(w1.body.attempts).toBe(1);
        expect(w1.body.attempts, "one count, two names").toBe(w1.body.attempts_used);
        const w2 = await submit(p.api, p.csrf, t, "w2");
        expect(w2.body.attempts_left, "precondition: that was the last attempt").toBe(0);
        expect(w2.body.attempts).toBe(2);
        expect(w2.body.attempts).toBe(w2.body.attempts_used);
        const r3 = await submit(p.api, p.csrf, t, "w3");
        expect(r3.body.refused, "precondition: refused, nothing stored").toBe("attempts_exhausted");
        expect(r3.body.attempts, "the refusal stored nothing, so the count did not move").toBe(2);
        expect(r3.body.attempts).toBe(r3.body.attempts_used);
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });
});
