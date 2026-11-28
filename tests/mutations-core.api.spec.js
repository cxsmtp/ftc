// @ts-check
/**
 * Mutation (write) tests — exercises all create/update/delete flows.
 * Uses isolated data-test/ directory, never touches workspace data.
 */
const { test, expect } = require("./isolated-test");
const { registerPost, entryCode } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, gradingHashFor, TEST_DB_PATH } = require("./helpers");

const S = { ready: false };

async function ensureState() {
  if (S.ready) return;
  const { api } = await apiLogin("superadmin");
  const comps = await (await api.get("/api/admin/competitions")).json();
  S.liveComp = comps.find(c => c.name === "Test Live");
  S.upcomingComp = comps.find(c => c.name === "Test Upcoming");
  S.endedComp = comps.find(c => c.name === "Test Ended");
  const tasks = await (await api.get("/api/admin/tasks")).json();
  // The seeded challenges the Live event HOLDS: its own copies (lib/event-copies.js),
  // what its participants answer, rate and download; draft1 is in no event (the library row).
  const inLive = (title) => tasks.find(t => t.title === title && t.owner_competition_id === S.liveComp.id);
  S.tasks = tasks;
  S.easy1 = inLive("Challenge easy1");
  S.med1 = inLive("Challenge med1");
  S.hard1 = inLive("Challenge hard1");
  S.draft1 = tasks.find(t => t.title === "Challenge draft1" && !t.owner_competition_id);
  // v7.24.0 — ASSERT THE FIXTURE, so a bad precondition reports as a bad
  // precondition. `expectSubmitOk` has three times reported "Already solved" for
  // hard1 in a file whose submits never solve it, and v7.23.11's recorded
  // leading hypothesis was that easy1 and hard1 had resolved to the SAME id —
  // which would make the earlier easy1 solve surface on the hard1 submit,
  // exactly matching the symptom. That hypothesis is now either dead on every
  // run or caught at the moment it happens, instead of being re-derived by the
  // next reader from a message pointing at the wrong test.
  //
  // Note `/api/admin/tasks` does NOT paginate (checked, not assumed), so an
  // undefined here would mean the seed itself did not produce the row — also
  // worth failing on by name rather than as `Cannot read properties of
  // undefined`.
  for (const [k, v] of [["easy1", S.easy1], ["med1", S.med1], ["hard1", S.hard1], ["draft1", S.draft1]]) {
    expect(v, `seed fixture: "Challenge ${k}" is missing from /api/admin/tasks`).toBeTruthy();
  }
  const seedIds = [S.easy1.id, S.med1.id, S.hard1.id, S.draft1.id];
  expect(new Set(seedIds).size,
    `seed fixture: the four seeded challenges must be DISTINCT rows — got ${JSON.stringify(seedIds)}`)
    .toBe(4);
  const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
  S.alice = parts.find(p => p.email === "alice@acme.com");
  S.bob = parts.find(p => p.email === "bob@acme.com");
  S.carol = parts.find(p => p.email === "carol@acme.com");
  await api.dispose();
  S.ready = true;
}

async function aliceInLive() {
  await ensureState();
  const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  await api.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: S.liveComp.id },
  });
  return { api, csrf };
}

async function bobInLive() {
  await ensureState();
  const { api, csrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
  // v7.23.5 — ASSERT the select. It was fire-and-forget, so a refusal left bob
  // with NO competition context and every submit in this file then answered 403
  // — which surfaces as `expect(r.ok()).toBeTruthy()` failing inside whichever
  // test happened to run, naming the submission rather than the missing
  // context. Same class as the enterCompAsParticipant fix in the same release:
  // a test that does not assert its preconditions reports the wrong thing when
  // they break (v7.22.7).
  const sel = await api.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: S.liveComp.id },
  });
  expect(sel.ok(), `bobInLive: select-competition answered ${sel.status()} ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

function h(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }

// v7.23.6 — a submit that is REFUSED must say why.
//
// These read `expect(r.ok()).toBeTruthy()`, so a refusal reported only
// "Received: false" — no status, no body — and the artefact captured nothing
// either, which makes a flake here undiagnosable by construction. `submit wrong
// answer deducts points` flaked exactly that way twice; no mechanism is claimed,
// but the NEXT occurrence will name one. The submit endpoint has several
// distinct refusals (400 already-solved, 403 no competition context, 409
// task_changed from a stale grading hash, 400 not-live after an auto-end) and
// they are indistinguishable without the body.
async function expectSubmitOk(r, what, taskId) {
  if (r.ok()) return r.json();
  // v7.23.11 — name the TASK too. This has reported "Already solved" for hard1
  // three times now, on a file whose five submits never solve hard1 and whose
  // database is fresh per file. The leading hypothesis is that S.easy1 and
  // S.hard1 resolved to the SAME id — which would make the earlier easy1 solve
  // surface here — so the ids and the server's own title for the one under test
  // are printed. If they differ, that hypothesis dies and the next reader starts
  // somewhere else instead of re-deriving it.
  let ctx = "";
  try {
    const ids = `easy1=${S.easy1 && S.easy1.id} med1=${S.med1 && S.med1.id} hard1=${S.hard1 && S.hard1.id}`;
    const { api: sa } = await apiLogin("superadmin");
    const all = await (await sa.get("/api/admin/tasks?limit=500")).json();
    const rows = all.tasks || all;
    const hit = Array.isArray(rows) ? rows.find(t => t.id === taskId) : null;
    ctx = `\n  taskId=${taskId} title=${hit ? JSON.stringify(hit.title) : "(not found)"}\n  ${ids}`;
    // v7.28.0 — AND THE ROW ITSELF, which is the one fact that separates the
    // explanations still standing. The same-id hypothesis is now DEAD: the
    // v7.24.0 diagnostic fired on a full-suite run and printed four distinct
    // ids, so the "Already solved" was a genuine correct submission for
    // (bob, hard1, Test Live). What nothing has ever shown is WHERE it came
    // from, and the row answers that on sight:
    //   * answer "totally-wrong"  → this very test's own row, re-graded correct
    //                               by a recalculate, or a second pass over one
    //                               database;
    //   * any other answer        → some other writer solved it, and the answer
    //                               names which;
    //   * submitted_at before the file started → it predates the run, i.e. the
    //                               per-file recycle did not give us a fresh DB
    //                               (the v7.21.10 contamination class).
    // Print more of what we already have, rather than deriving a mechanism that
    // merely fits.
    const subs = await (await sa.get(`/api/admin/submissions?limit=200&taskId=${encodeURIComponent(taskId)}`)).json();
    const list = (subs.submissions || subs || []).filter(s => s && s.is_correct);
    ctx += `\n  correct submissions on this task: ${JSON.stringify(
      list.map(s => ({ who: s.nickname || s.user_id, answer: s.answer, at: s.submitted_at, comp: s.competition_id })))}`;
    await sa.dispose();
  } catch (e) { ctx = `${ctx}\n  (diagnostic failed: ${e.message})`; }
  expect(r.ok(), `${what}: submit refused with ${r.status()} ${await r.text()}${ctx}`).toBeTruthy();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Participant mutations", () => {
  test("update profile", async () => {
    const { api, csrf } = await aliceInLive();
    try {
      const r = await api.put("/api/me", { headers: h(csrf), data: { company: "NewCorp" } });
      expect(r.ok()).toBeTruthy();
      const me = await (await api.get("/api/me")).json();
      expect(me.company).toBe("NewCorp");
    } finally {
      // alice is shared by this whole file, so a failed assertion above would
      // otherwise leave every later test reading her company as "NewCorp".
      // Restored to the HARD-CODED seed value, never to one read at runtime.
      await api.put("/api/me", { headers: h(csrf), data: { company: "Acme Corp" } }).catch(() => {});
      await api.dispose();
    }
  });

  test("update avatar with valid emoji", async () => {
    const { api, csrf } = await aliceInLive();
    try {
      const r = await api.put("/api/me", { headers: h(csrf), data: { avatar: "🐺" } });
      expect(r.ok()).toBeTruthy();
      const me = await (await api.get("/api/me")).json();
      expect(me.avatar).toBe("🐺");
    } finally {
      // The seeded avatar, hard-coded: a failure above must not leave alice
      // wearing this test's emoji for the rest of the file.
      await api.put("/api/me", { headers: h(csrf), data: { avatar: "🦊" } }).catch(() => {});
      await api.dispose();
    }
  });

  test("submit correct answer awards points", async () => {
    const { api, csrf } = await bobInLive();
    const r = await api.post(`/api/tasks/${S.easy1.id}/submit`, {
      headers: h(csrf), data: { answer: "answer-easy1" , gradingHash: await gradingHashFor(api, S.easy1.id)},
    });
    const d = await expectSubmitOk(r, "correct answer to easy1", S.easy1.id);
    expect(d.correct).toBeTruthy();
    expect(d.points_delta || d.points || d.score).toBeGreaterThan(0);
    await api.dispose();
  });

  test("submit wrong answer deducts points", async () => {
    // v7.28.0 — THIS TEST OWNS ITS CHALLENGE, because sharing one is what made
    // it flaky.
    //
    // It used the seeded `hard1` and has reported `400 Already solved` FOUR
    // times across releases — a refusal that can only mean bob already had a
    // correct submission for (hard1, Test Live), which nothing in this file
    // produces. No mechanism has ever been established, and the previous three
    // hardenings all improved the MESSAGE rather than removing the dependency.
    // A test that asserts "a wrong answer is graded wrong" needs a challenge
    // nobody else can have solved, so it makes one; `expectSubmitOk` still
    // carries the diagnostic, so if this shape ever recurs elsewhere in the
    // file it names the row that caused it.
    //
    // The challenge is UNASSIGNED again in a finally, so the shared Test Live
    // fixture is byte-for-byte as it was — an extra unsolved challenge would
    // otherwise change what all-solved means for every later test.
    // `bobInLive()` is what normally resolves the fixture, and it runs LATER
    // here — so resolve it up front or S.liveComp is undefined at assign time.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let taskId = null;
    try {
      const mk = await sa.post("/api/admin/tasks", { headers: saH, data: {
        title: `Wrong-answer probe ${Date.now().toString(36)}`, description: "<p>x</p>",
        difficulty: "hard", answer_type: "text", correct_answer: "the-right-one", status: "published",
      }});
      expect(mk.status(), await mk.text()).toBe(200);
      taskId = (await mk.json()).id;
      const asg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saH, data: { competitionIds: [S.liveComp.id] },
      });
      expect(asg.status(), await asg.text()).toBe(200);

      const { api, csrf } = await bobInLive();
      try {
        const r = await api.post(`/api/tasks/${taskId}/submit`, {
          headers: h(csrf), data: { answer: "totally-wrong", gradingHash: await gradingHashFor(api, taskId) },
        });
        const d = await expectSubmitOk(r, "wrong answer to the probe challenge", taskId);
        expect(d.correct).toBeFalsy();
        // The DEDUCTION is what the test is named for, and nothing asserted it:
        // `correct:false` is equally satisfied by a build that deducted nothing.
        // The field is `pointsDelta` — note the sibling correct-answer test
        // reads `points_delta || points || score`, none of whose first two the
        // endpoint has ever sent, so it is really asserting the participant's
        // running TOTAL. Assert the delta itself here.
        expect(d.pointsDelta, "a wrong answer costs the PENALTY").toBeLessThan(0);
      } finally { await api.dispose(); }
    } finally {
      if (taskId) {
        await sa.delete(`/api/admin/tasks/${taskId}/competitions/${S.liveComp.id}`, { headers: saH }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  test("ext-audit batch 6: submit with a non-string answer → 4xx, never 500", async () => {
    // `(req.body.answer || "").trim()` let a truthy non-string reach .trim() → 500.
    // A non-string answer is now coerced to "" (graded wrong), never a 500.
    const { api, csrf } = await bobInLive();
    const r = await api.post(`/api/tasks/${S.hard1.id}/submit`, {
      headers: h(csrf), data: { answer: { a: 1 } , gradingHash: await gradingHashFor(api, S.hard1.id)},
    });
    expect(r.status(), "object answer must not 500").toBeLessThan(500);
    await api.dispose();
  });

  test("cannot resubmit already solved task", async () => {
    const { api, csrf } = await bobInLive();
    // v7.23.5 — ESTABLISH the precondition instead of inheriting it.
    //
    // This asserted the refusal while relying on an EARLIER TEST ("submit
    // correct answer") having solved easy1 as bob — a sibling's side effect,
    // which is the v7.21.39 class. It failed once in a full-suite run with
    // `Expected: 400, Received: 200`, i.e. the task simply was not solved yet,
    // and the message pointed at the refusal rather than at the missing
    // precondition. No contention mechanism is claimed; the dependency is
    // removed instead, so the test means the same thing run alone or in order.
    //
    // The first submit is idempotent for our purposes: 200-and-correct if this
    // test got there first, 400 "Already solved" if the sibling did.
    const first = await api.post(`/api/tasks/${S.easy1.id}/submit`, {
      headers: h(csrf), data: { answer: "answer-easy1", gradingHash: await gradingHashFor(api, S.easy1.id) },
    });
    const firstBody = await first.json().catch(() => ({}));
    const solved = (first.ok() && firstBody.correct)
      || (first.status() === 400 && /already solved/i.test(firstBody.error || ""));
    expect(solved, `easy1 must be SOLVED before the resubmit is asserted; `
      + `first submit answered ${first.status()} ${JSON.stringify(firstBody)}`).toBeTruthy();

    const r = await api.post(`/api/tasks/${S.easy1.id}/submit`, {
      headers: h(csrf), data: { answer: "answer-easy1" , gradingHash: await gradingHashFor(api, S.easy1.id)},
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("Already solved");
    await api.dispose();
  });

  // v8.12.4 — both hint tests asserted a 200 and nothing else, so "deducts
  // points" was satisfied by a free hint and "without double deduction" by a
  // second charge. Each now reveals from its own clean state and reads the
  // deduction and the running score off the response.
  async function _clearBobHint(taskId) {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("DELETE FROM hint_reveals WHERE task_id=? AND user_id=(SELECT id FROM users WHERE email='bob@acme.com')").run(taskId);
    } finally { db.close(); }
  }

  test("reveal hint deducts points", async () => {
    const { api, csrf } = await bobInLive();
    await _clearBobHint(S.med1.id);
    try {
      const r = await api.post(`/api/tasks/${S.med1.id}/hint`, { headers: h(csrf) });
      expect(r.ok(), await r.text()).toBeTruthy();
      const d = await r.json();
      expect(d.hint).toBeTruthy();
      // Medium is worth 100, and a hint costs HINT_DEDUCTION_RATE (30%) of it.
      expect(d.pointsDeducted, "a first reveal is charged").toBe(30);
    } finally { await _clearBobHint(S.med1.id); await api.dispose(); }
  });

  test("reveal hint again returns same hint without double deduction", async () => {
    const { api, csrf } = await bobInLive();
    await _clearBobHint(S.med1.id);
    try {
      const first = await (await api.post(`/api/tasks/${S.med1.id}/hint`, { headers: h(csrf) })).json();
      expect(first.pointsDeducted, "precondition: the first reveal is charged").toBe(30);
      const r = await api.post(`/api/tasks/${S.med1.id}/hint`, { headers: h(csrf) });
      expect(r.ok(), await r.text()).toBeTruthy();
      const again = await r.json();
      expect(again.hint, "the same hint comes back").toBe(first.hint);
      expect(again.pointsDeducted, "a second reveal is free").toBe(0);
      expect(again.score, "and the running score does not move").toBe(first.score);
    } finally { await _clearBobHint(S.med1.id); await api.dispose(); }
  });

  test("submit feedback rating", async () => {
    const { api, csrf } = await aliceInLive();
    const r = await api.put(`/api/tasks/${S.easy1.id}/feedback`, {
      headers: h(csrf), data: { rating: 4 },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  // `PUT /api/tasks/:id/feedback` is the only enum/range guard on the challenge
  // surface an ordinary participant can drive, and `task_feedback.rating` is
  // `INTEGER NOT NULL CHECK(rating>=1 AND rating<=5)` with NO integer check —
  // so SQLite happily stores 4.5 as a REAL (skewing the admin list's
  // `avg_rating` for ever) while 0 / 6 / NaN throw a raw SQLITE_CONSTRAINT out
  // of a synchronous handler, i.e. HTTP 500. The route guard is doing BOTH
  // jobs; `.toBe(400)` (never `toBeLessThan(500)`) is the point of the test.
  test("feedback rating outside 1-5 (or non-integer) is a 400, and nothing is stored", async () => {
    const { api, csrf } = await aliceInLive();
    const fb = (rating) => api.put(`/api/tasks/${S.easy1.id}/feedback`, { headers: h(csrf), data: { rating } });

    // Positive control FIRST — a good rating lands, and it is the value the
    // stored-state assertion below is measured against. (Ordering matters: the
    // row is `ON CONFLICT(user_id,task_id) DO UPDATE`, so a control sent AFTER
    // the 4.5 probe would overwrite a silently-accepted 4.5 and make the final
    // assertion vacuous.)
    const ok = await fb(3);
    expect(ok.ok(), `control rating 3 rejected: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await ok.json()).rating).toBe(3);

    for (const bad of [0, 6, 4.5, "abc"]) {
      const r = await fb(bad);
      expect(r.status(), `rating ${JSON.stringify(bad)} must be a 400, not ${r.status()}`).toBe(400);
      expect((await r.json()).error).toMatch(/rating must be 1-5/i);
    }
    await api.dispose();

    // The stored value is what catches a SILENT accept — 4.5 passes any
    // status-only test the moment the guard stops rejecting it.
    const { api: sa } = await apiLogin("superadmin");
    const rows = await (await sa.get(`/api/admin/tasks/${S.easy1.id}/feedback`)).json();
    const mine = rows.find(r => r.user_id === S.alice.id);
    expect(mine, "alice's feedback row must exist (the control wrote it)").toBeTruthy();
    expect(mine.rating, "a rejected probe must not have overwritten the control's rating").toBe(3);
    for (const row of rows) {
      expect(Number.isInteger(row.rating), `stored rating ${row.rating} is not an integer`).toBeTruthy();
      expect(row.rating).toBeGreaterThanOrEqual(1);
      expect(row.rating).toBeLessThanOrEqual(5);
    }
    await sa.dispose();
  });

  test("logout destroys session", async () => {
    const { api, csrf } = await aliceInLive();
    const r = await api.post("/api/logout", { headers: h(csrf) });
    expect(r.ok()).toBeTruthy();
    expect((await api.get("/api/me")).status()).toBe(401);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Registration", () => {
  // v8.3.16 — THE DUPLICATE FIXTURE IS A PRECONDITION, NOT A SIDE EFFECT.
  // `reject duplicate nickname` and `reject duplicate email` collide with
  // `dave_b` / `dave@acme.com`, which existed only because `register new
  // participant` had run first. Alone, both got a 200 where they expected a 409
  // — a refusal test passing for the opposite reason is the worst shape a
  // regression lock can take, so it is worth owning. Create-if-missing keeps the
  // full-file run byte-identical.
  test.beforeAll(async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
      firstName: "Dave", lastName: "Brown", nickname: "dave_b",
      email: "dave@acme.com", company: "TestCo", title: "QA",
      country: "UK", timezone: "Europe/London", avatar: "🐸",
    }});
    // 200 the first time, 409 if a sibling already created it — both mean the
    // collision target exists, which is all the two tests below need.
    expect([200, 409], `duplicate-collision fixture: ${await r.text()}`).toContain(r.status());
    await api.dispose();
  });

  test("register new participant", async () => {
    // Uses its OWN identity: the collision fixture is established in beforeAll,
    // so this test asserts only that a registration succeeds.
    const stamp = Date.now();
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
      firstName: "Dave", lastName: "Brown", nickname: `dave_probe_${stamp}`,
      email: `dave-probe-${stamp}@acme.com`, company: "TestCo", title: "QA",
      country: "UK", timezone: "Europe/London", avatar: "🐸",
    }});
    expect(r.ok(), `register probe: ${await r.text()}`).toBeTruthy();
    await api.dispose();
  });

  test("reject duplicate nickname", async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
      firstName: "Fake", lastName: "User", nickname: "dave_b",
      email: "fake@acme.com", company: "X", title: "Y",
      country: "US", timezone: "America/New_York",
    }});
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toContain("nickname");
    await api.dispose();
  });

  test("an existing email is never refused: it is sent a code, and no second account is made", async () => {
    // Email first: the entry screen answers an address that already has an
    // account exactly as it answers a new one ({ok:true}) and mails it a SIGN-IN
    // code, never an address proof — so no session can hold a sign-up grant for
    // it, the registration form refuses (403 email_proof_required, never a 409
    // telling a visitor the address is taken), and nothing is written.
    const { api, csrf } = await freshCtx();
    const entry = await entryCode(api, "dave@acme.com");
    expect(entry.answer).toEqual({ ok: true });
    expect(entry.mail, "a code was mailed to the typed address").toBeTruthy();
    expect(entry.mail.via, "a sign-in code, not an address proof").not.toBe("proof");
    const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
      firstName: "Fake", lastName: "User", nickname: "uniquenick123",
      email: "dave@acme.com", company: "X", title: "Y",
      country: "US", timezone: "America/New_York",
    }});
    expect(r.status()).toBe(403);
    expect(await r.json()).toMatchObject({ code: "email_proof_required" });
    await api.dispose();
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) c FROM users WHERE LOWER(email)='dave@acme.com'").get().c, "still one account").toBe(1);
      expect(db.prepare("SELECT COUNT(*) c FROM users WHERE nickname='uniquenick123'").get().c, "the typed nickname was not taken").toBe(0);
    } finally { db.close(); }
  });

  test("reject missing required fields", async () => {
    const { api, csrf } = await freshCtx();
    // A live grant (a proven corporate address), so the refusal is the form's
    // own field check and not the missing proof.
    const email = `missing-fields-${Date.now()}@acme.com`;
    const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
      firstName: "X", lastName: "Y", nickname: "zz", email,
    }});
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/Missing required fields/);
    await api.dispose();
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) c FROM users WHERE email=?").get(email).c).toBe(0); }
    finally { db.close(); }
  });

  test("reject free email without company email", async () => {
    // Email first: the corporate-email rule is enforced at the entry screen. A
    // free-mail address with no invitation is mailed NOTHING (no address proof),
    // so no grant exists and the form refuses before any field is read.
    const { api, csrf } = await freshCtx();
    const email = `free-${Date.now()}@gmail.com`;
    const entry = await entryCode(api, email);
    expect(entry.answer, "the entry screen's answer is uniform").toEqual({ ok: true });
    expect(entry.mail, "a free-mail address is sent no proof").toBeNull();
    const r = await registerPost(api, "/api/register", { headers: h(csrf), data: {
      firstName: "Free", lastName: "User", nickname: "freeuser99",
      email, company: "X", title: "Y",
      country: "US", timezone: "America/New_York",
    }});
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("email_proof_required");
    await api.dispose();
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) c FROM users WHERE email=?").get(email).c).toBe(0); }
    finally { db.close(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE FIELDS — personal_title + phone + Work-Title relabel (PR-2)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Profile fields — personal_title + phone (PR-2)", () => {
  // Register a fresh corporate participant, verify+approve via superadmin, then
  // log in with the password chosen at signup (auth-simplification: no reset dance).
  async function registerVerifyLogin(over) {
    const { api: reg, csrf } = await freshCtx();
    const data = {
      firstName: "Pat", lastName: "Two", nickname: over.nickname,
      email: over.email, company: "TestCo", title: "QA Engineer",
      country: "ES", timezone: "Europe/Madrid",
      jobFunction: "Software Developer / Engineer", city: "Madrid",
      password: PARTICIPANT_PASS, ...over.fields,
    };
    const r = await registerPost(reg, "/api/register", { headers: h(csrf), data });
    expect(r.ok(), `register ${over.email} failed: ${r.status()} ${await r.text()}`).toBeTruthy();
    await reg.dispose();
    const { api: sa } = await apiLogin("superadmin");
    const list = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(over.email)}`)).json()).participants;
    const row = list.find(p => p.email === over.email);
    expect(row, `registered user ${over.email} not found in admin list`).toBeTruthy();
    // verify + approve so the account can log in with its chosen password.
    const saCsrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: h(saCsrf) });
    await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: h(saCsrf) });
    await sa.dispose();
    const logged = await apiLogin(over.email, PARTICIPANT_PASS);
    return { ...logged, id: row.id };
  }

  test("register persists personalTitle + phone; participant export carries them", async () => {
    const email = "pr2.export@acme.com";
    const { api } = await registerVerifyLogin({
      email, nickname: "pr2_export_n",
      fields: { personalTitle: "Dr.", phone: "+34 600 111" },
    });
    await api.dispose();
    const { api: sa } = await apiLogin("superadmin");
    const exp = await (await sa.get("/api/admin/export/participants")).json();
    const u = exp.participants.find(p => p.email === email);
    expect(u).toBeTruthy();
    expect(u.personal_title).toBe("Dr.");
    expect(u.phone).toBe("+34 600 111");
    expect(u.title).toBe("QA Engineer"); // work title preserved
    await sa.dispose();
  });

  test("GET /api/me exposes personal_title + phone; PUT updates, clears, and caps them", async () => {
    const { api, csrf } = await registerVerifyLogin({
      email: "pr2.me@acme.com", nickname: "pr2_me_n",
      fields: { personalTitle: "Mr.", phone: "+34 600 222" },
    });
    let me = await (await api.get("/api/me")).json();
    expect(me.personal_title).toBe("Mr.");
    expect(me.phone).toBe("+34 600 222");

    // update both
    let r = await api.put("/api/me", { headers: h(csrf), data: { personalTitle: "Ms.", phone: "+1 555 0100" } });
    expect(r.ok()).toBeTruthy();
    me = await (await api.get("/api/me")).json();
    expect(me.personal_title).toBe("Ms.");
    expect(me.phone).toBe("+1 555 0100");

    // clear personal_title (optional → null)
    r = await api.put("/api/me", { headers: h(csrf), data: { personalTitle: "" } });
    expect(r.ok()).toBeTruthy();
    me = await (await api.get("/api/me")).json();
    expect(me.personal_title == null || me.personal_title === "").toBeTruthy();
    expect(me.phone).toBe("+1 555 0100"); // untouched

    // over-cap phone (>32) → 400
    r = await api.put("/api/me", { headers: h(csrf), data: { phone: "+" + "1".repeat(40) } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("phone");

    // over-cap personal_title (>20) → 400
    r = await api.put("/api/me", { headers: h(csrf), data: { personalTitle: "X".repeat(21) } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error.toLowerCase()).toContain("personal");
    await api.dispose();
  });

  test("participant import round-trips personal_title + phone + work title", async () => {
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const email = "pr2.import@acme.com";
    const envelope = {
      type: "hackarena-participants", version: 2,
      participants: [{
        first_name: "Im", last_name: "Ported", nickname: "pr2_import_n",
        email, secondary_email: "", company: "X", title: "Staff Engineer",
        personal_title: "Prof.", phone: "+44 20 7946",
        country: "GB", timezone: "Europe/London",
        job_function: "Software Developer / Engineer", city: "London",
        verified: 1, approved: 1,
      }],
    };
    const r = await sa.post("/api/admin/import/participants", { headers: h(csrf), data: { data: envelope, resolutions: {} } });
    expect(r.ok(), `import failed: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).imported).toBe(1);
    const exp = await (await sa.get("/api/admin/export/participants")).json();
    const u = exp.participants.find(p => p.email === email);
    expect(u).toBeTruthy();
    expect(u.personal_title).toBe("Prof.");
    expect(u.phone).toBe("+44 20 7946");
    expect(u.title).toBe("Staff Engineer");
    await sa.dispose();
  });

  test("superadmin admin-edit sets and clears personal_title + phone", async () => {
    // Fresh user with blank personal_title/phone.
    const email = "pr2.adminedit@acme.com";
    const { api } = await registerVerifyLogin({ email, nickname: "pr2_adminedit_n", fields: {} });
    await api.dispose();
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const list = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json()).participants;
    const row = list.find(p => p.email === email);
    expect(row).toBeTruthy();
    // set
    let r = await sa.put(`/api/admin/participants/${row.id}`, { headers: h(csrf), data: { personalTitle: "Prof.", phone: "+49 30 1234" } });
    expect(r.ok()).toBeTruthy();
    let after = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json()).participants.find(p => p.email === email);
    expect(after.personal_title).toBe("Prof.");
    expect(after.phone).toBe("+49 30 1234");
    // clear (superadmin may clear)
    r = await sa.put(`/api/admin/participants/${row.id}`, { headers: h(csrf), data: { personalTitle: "" } });
    expect(r.ok()).toBeTruthy();
    after = (await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json()).participants.find(p => p.email === email);
    expect(after.personal_title == null || after.personal_title === "").toBeTruthy();
    await sa.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — COMPETITION CRUD
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — competition CRUD", () => {
  // v7.21.39 — THE FIXTURE IS A PRECONDITION, NOT A SIDE EFFECT OF TEST #1.
  // "Mut Test Comp" used to exist only because `create competition` had run, so
  // every test below it passed for a reason that had nothing to do with them:
  // run any one alone and it failed with `expect(mc).toBeTruthy() → undefined`.
  // Create-if-missing, so the full file and a single `-g` run behave the same.
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    let mc = comps.find(c => c.name === "Mut Test Comp");
    if (!mc) {
      mc = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: {
        name: "Mut Test Comp", start_time: new Date(Date.now() + 10 * 3600_000).toISOString(), duration_minutes: 60,
      }})).json()).competition;
    }
    S.mutComp = mc;
    await api.dispose();
  });

  test("edit competition", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    const mc = comps.find(c => c.name === "Mut Test Comp");
    expect(mc).toBeTruthy();
    const r = await api.put(`/api/admin/competitions/${mc.id}`, { headers: h(csrf), data: {
      name: "Mut Test Comp Renamed", duration_minutes: 90,
    }});
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("superadmin cannot delete a live competition", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.delete(`/api/admin/competitions/${S.liveComp.id}`, { headers: { "x-csrf-token": csrf } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/live/i);
    await api.dispose();
  });

  test("superadmin can delete competition", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    // v7.21.39 — accept either name. "Renamed" only exists once `edit
    // competition` has run, so pinning to it made this test depend on a
    // SIBLING rather than on the beforeAll fixture; alone it failed on
    // `expect(mc).toBeTruthy() → undefined`. Deletion is what this asserts, and
    // it does not care which name the row is carrying.
    const mc = comps.find(c => c.name === "Mut Test Comp Renamed")
            || comps.find(c => c.name === "Mut Test Comp");
    expect(mc, "the competition-CRUD fixture must exist (beforeAll creates it)").toBeTruthy();
    const r = await api.delete(`/api/admin/competitions/${mc.id}`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("regular admin cannot delete competition", async () => {
    await ensureState();
    // Promote Carol to admin, login as Carol
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    await sa.dispose();
    let carolApi = null;
    try {
      const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      carolApi = api;
      const r = await api.delete(`/api/admin/competitions/${S.upcomingComp.id}`, { headers: { "x-csrf-token": csrf } });
      expect(r.status()).toBe(403);
    } finally {
      if (carolApi) await carolApi.dispose();
      // Demote Carol back to the HARD-CODED seed role — never one read at
      // runtime, which with three promoters in this file would faithfully
      // reinstate the previous leak. A failed assertion above would otherwise
      // leave her an admin (and auto-tagged `staff`) for the rest of the file,
      // which the runtime fixture guard fails the WHOLE file for.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf2), data: { role: "participant" } }).catch(() => {});
      await sa2.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPETITION CREATION SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Competition creation scenarios", () => {
  const _ids = [];

  test("create competition with minimal fields", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Minimal ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.competition.id).toBeTruthy();
    expect(d.competition.status).toBe("upcoming");
    _ids.push(d.competition.id);
    await api.dispose();
  });

  test("create competition with leaderboard_mode global", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Global LB ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 120, leaderboard_mode: "global",
    }});
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    _ids.push(d.competition.id);
    const all = await (await api.get("/api/admin/competitions")).json();
    const latest = all.find(c => c.id === d.competition.id);
    expect(latest.leaderboard_mode).toBe("global");
    await api.dispose();
  });

  test("create competition with per_slot leaderboard (default)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `PerSlot ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 90,
    }});
    expect(r.ok()).toBeTruthy();
    const all = await (await api.get("/api/admin/competitions")).json();
    const latest = all.find(c => c.name.startsWith("PerSlot"));
    expect(latest.leaderboard_mode).toBe("per_slot");
    _ids.push(latest.id);
    await api.dispose();
  });

  test("create live competition (start in past, end in future)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Live Now ${Date.now()}`, start_time: new Date(Date.now() - 30 * 60_000).toISOString(),
      duration_minutes: 120,
    }});
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.competition.status).toBe("live");
    _ids.push(d.competition.id);
    await api.dispose();
  });

  test("create already-ended competition (start and end in past)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Already Ended ${Date.now()}`, start_time: new Date(Date.now() - 5 * 3600_000).toISOString(),
      duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.competition.status).toBe("ended");
    _ids.push(d.competition.id);
    await api.dispose();
  });

  test("create competition with multi-day duration", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `MultiDay ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 2 * 1440 + 6 * 60, // 2 days 6 hours
    }});
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.competition.duration_minutes).toBe(2 * 1440 + 6 * 60);
    _ids.push(d.competition.id);
    await api.dispose();
  });

  test("reject competition with missing name", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      start_time: new Date().toISOString(), duration_minutes: 60,
    }});
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("reject competition with invalid start_time", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: "Bad Time", start_time: "not-a-date", duration_minutes: 60,
    }});
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/start time/i); // batch 7 — validateBody standardized the message ("Start time must be a valid date")
    await api.dispose();
  });

  test("reject competition with zero or negative duration", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: "Zero Dur", start_time: new Date().toISOString(), duration_minutes: 0,
    }});
    expect(r.status()).toBe(400);
    r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: "Neg Dur", start_time: new Date().toISOString(), duration_minutes: -10,
    }});
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("reject duplicate competition name", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const name = `Dupe Test ${Date.now()}`;
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    _ids.push((await r.json()).competition.id);
    // Same name again
    r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name, start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.status()).toBe(409);
    await api.dispose();
  });

  test("create competition then add two sessions", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `MultiSess ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 240,
    }});
    expect(r.ok()).toBeTruthy();
    const compId = (await r.json()).competition.id;
    _ids.push(compId);

    // Add session 1
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "APAC Morning", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120,
    }});
    expect(r.ok()).toBeTruthy();
    const ts1 = (await r.json()).timeslot;
    expect(ts1.name).toBe("APAC Morning");
    expect(ts1.status).toBe("upcoming");

    // Add session 2
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "EU Afternoon", start_time: new Date(now + 7200_000).toISOString(), duration_minutes: 120,
    }});
    expect(r.ok()).toBeTruthy();
    const ts2 = (await r.json()).timeslot;
    expect(ts2.name).toBe("EU Afternoon");

    // Verify competition has 2 timeslots
    const comps = await (await api.get("/api/admin/competitions")).json();
    const comp = comps.find(c => c.id === compId);
    expect(comp.timeslots.length).toBe(2);
    expect(comp.status).toBe("upcoming");
    await api.dispose();
  });

  test("create competition with live session and upcoming session", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Mixed Sess ${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 300,
    }});
    const compId = (await r.json()).competition.id;
    _ids.push(compId);

    // Live session
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Live Now", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    expect((await r.json()).timeslot.status).toBe("live");

    // Upcoming session
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Later", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120,
    }});
    expect((await r.json()).timeslot.status).toBe("upcoming");

    // Competition should be live (at least one slot active)
    const comps = await (await api.get("/api/admin/competitions")).json();
    expect(comps.find(c => c.id === compId).status).toBe("live");
    await api.dispose();
  });

  test("session name must be unique within competition", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Unique Name ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 240,
    }});
    const compId = (await r.json()).competition.id;
    _ids.push(compId);

    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Same Name", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();

    // Same name again — should fail
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Same Name", start_time: new Date(now + 7200_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.status()).toBe(409);
    await api.dispose();
  });

  test("session with different timezone offsets creates correct UTC times", async () => {
    // Simulates creating sessions with different start times (timezone conversion done client-side)
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `TZ Test ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 600,
    }});
    const compId = (await r.json()).competition.id;
    _ids.push(compId);

    // Session at 9 AM UTC
    const utc9am = new Date(now + 3600_000);
    utc9am.setUTCHours(9, 0, 0, 0);
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "UTC Morning", start_time: utc9am.toISOString(), duration_minutes: 180,
    }});
    expect(r.ok()).toBeTruthy();
    const ts = (await r.json()).timeslot;
    expect(new Date(ts.start_time).getUTCHours()).toBe(9);

    // Session at 2 PM UTC (as if user selected 2 PM in a different timezone, converted client-side)
    const utc2pm = new Date(utc9am);
    utc2pm.setUTCHours(14, 0, 0, 0);
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "UTC Afternoon", start_time: utc2pm.toISOString(), duration_minutes: 180,
    }});
    expect(r.ok()).toBeTruthy();
    const ts2 = (await r.json()).timeslot;
    expect(new Date(ts2.start_time).getUTCHours()).toBe(14);
    await api.dispose();
  });

  test("edit competition duration", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Edit Dur ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 60,
    }});
    const compId = (await r.json()).competition.id;
    _ids.push(compId);

    r = await api.put(`/api/admin/competitions/${compId}`, { headers: h(csrf), data: { duration_minutes: 180 } });
    expect(r.ok()).toBeTruthy();
    const comps = await (await api.get("/api/admin/competitions")).json();
    expect(comps.find(c => c.id === compId).duration_minutes).toBe(180);
    await api.dispose();
  });

  test("edit session duration and name", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Edit Sess ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 240,
    }});
    const compId = (await r.json()).competition.id;
    _ids.push(compId);

    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Original", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 60,
    }});
    const tsId = (await r.json()).timeslot.id;

    r = await api.put(`/api/admin/competitions/${compId}/timeslots/${tsId}`, {
      headers: h(csrf), data: { name: "Renamed", duration_minutes: 90 },
    });
    expect(r.ok()).toBeTruthy();
    const ts = (await r.json()).timeslot;
    expect(ts.name).toBe("Renamed");
    expect(ts.duration_minutes).toBe(90);
    await api.dispose();
  });

  test("cleanup: delete all test competitions", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    for (const id of _ids) {
      await api.delete(`/api/admin/competitions/${id}`, { headers: { "x-csrf-token": csrf } });
    }
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — TASK CRUD
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * v8.3.16 — `POST /api/admin/tasks/:id/lock` is a TOGGLE, so a test that calls
 * it and asserts the resulting value is really asserting what the PREVIOUS test
 * left behind. Four of them formed a lock → reject-edit → reject-restore →
 * unlock chain, and each failed alone with the opposite answer.
 *
 * Setting the state explicitly first makes each independent AND strictly
 * stronger: today the assertions are about a state the test established rather
 * than one it inherited.
 */
async function ensureTaskLocked(api, csrf, taskId, want) {
  const tasks = await (await api.get("/api/admin/tasks")).json();
  const t = (Array.isArray(tasks) ? tasks : tasks.tasks || []).find(x => x.id === taskId);
  expect(t, `task ${taskId} is listed`).toBeTruthy();
  if (!!t.locked === want) return;
  const r = await api.post(`/api/admin/tasks/${taskId}/lock`, { headers: h(csrf) });
  expect(r.ok(), `lock toggle to ${want}: ${await r.text()}`).toBeTruthy();
  expect((await r.json()).locked, `task is now ${want ? "locked" : "unlocked"}`).toBe(want ? 1 : 0);
}

test.describe("Admin — task CRUD", () => {
  // v7.21.39 — same reason as the competition block above: S.mutTask existed
  // only as a side effect of `create task`, so all 18 tests below it were
  // position-dependent and failed alone on `S.mutTask.id` being undefined.
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const tasks = await (await api.get("/api/admin/tasks")).json();
    let mt = (Array.isArray(tasks) ? tasks : tasks.tasks || []).find(t => t.title === "Mut Task 1" || t.title === "Mut Task 1 Updated");
    if (!mt) {
      mt = await (await api.post("/api/admin/tasks", { headers: h(csrf), data: {
        title: "Mut Task 1", description: "<p>test</p>", difficulty: "medium",
        answer_type: "text", correct_answer: "mut-answer", status: "draft",
        author_name: "Test Author", author_linkedin: "https://linkedin.com/in/testauthor",
      }})).json();
    }
    // v8.3.11 — ENSURE IT IS PUBLISHED. Five tests below (`cannot publish already
    // published`, both assign paths and the PUT sync) need a PUBLISHED shared task
    // and inherited that state from the `publish draft task` test seven lines down
    // — so each failed alone with a symptom naming something else entirely
    // (`Expected 400 / Received 200`, or an assign refused because
    // routes/challenges.js:194 rejects a draft). The publish test now owns its own
    // draft, which is the v7.21.39 pattern already applied to `create task`.
    if (mt.status !== "published") {
      await api.post(`/api/admin/tasks/${mt.id}/publish`, { headers: h(csrf) });
      mt = { ...mt, status: "published" };
    }
    S.mutTask = mt;
    await api.dispose();
  });

  test("create task", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/tasks", { headers: h(csrf), data: {
      title: `Mut Create Probe ${Date.now()}`, description: "<p>test</p>", difficulty: "medium",
      answer_type: "text", correct_answer: "mut-answer", status: "draft",
      author_name: "Test Author", author_linkedin: "https://linkedin.com/in/testauthor",
    }});
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).id).toBeTruthy();
    await api.dispose();
  });

  test("add and remove task tags", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Add tags
    let r = await api.post(`/api/admin/tasks/${S.mutTask.id}/tags`, { headers: h(csrf), data: { tag: "web" } });
    expect(r.ok()).toBeTruthy();
    let d = await r.json();
    expect(d.tags).toContain("web");
    r = await api.post(`/api/admin/tasks/${S.mutTask.id}/tags`, { headers: h(csrf), data: { tag: "crypto" } });
    expect(r.ok()).toBeTruthy();
    d = await r.json();
    expect(d.tags).toContain("web");
    expect(d.tags).toContain("crypto");
    // Verify in task list
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const updated = tasks.find(t => t.id === S.mutTask.id);
    expect(Array.isArray(updated.tags)).toBeTruthy();
    expect(updated.tags).toContain("web");
    expect(updated.tags).toContain("crypto");
    // Remove a tag
    r = await api.delete(`/api/admin/tasks/${S.mutTask.id}/tags/web`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    d = await r.json();
    expect(d.tags).not.toContain("web");
    expect(d.tags).toContain("crypto");
    // List all task tags
    const allTags = await (await api.get("/api/admin/task-tags")).json();
    expect(allTags).toContain("crypto");
    // Verify tag_added / tag_removed entries land in task_versions
    const versions = await (await api.get(`/api/admin/tasks/${S.mutTask.id}/versions`)).json();
    const changeTypes = versions.map(v => v.change_type);
    expect(changeTypes).toContain("tag_added");
    expect(changeTypes).toContain("tag_removed");
    await api.dispose();
  });

  test("task tag over 50 chars returns 400", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const longTag = "b".repeat(51);
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/tags`, { headers: h(csrf), data: { tag: longTag } });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  // v8.3.11 — its OWN draft, not the shared fixture. Publishing the shared task
  // here was the side effect five later tests silently depended on; asserting that
  // a publish works is this test's actual subject and needs no shared state.
  test("publish draft task", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const draft = await (await api.post("/api/admin/tasks", { headers: h(csrf), data: {
      title: `Mut Publish Probe ${Date.now()}`, description: "<p>test</p>", difficulty: "medium",
      answer_type: "text", correct_answer: "mut-answer", status: "draft",
      author_name: "Test Author", author_linkedin: "https://linkedin.com/in/testauthor",
    }})).json();
    expect(draft.id, "the draft fixture must have been created").toBeTruthy();
    const r = await api.post(`/api/admin/tasks/${draft.id}/publish`, { headers: h(csrf) });
    expect(r.ok(), `publish: ${r.status()}`).toBeTruthy();
    await api.dispose();
  });

  test("cannot publish already published task", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // The shared fixture is published by `beforeAll`, so this stands alone.
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/publish`, { headers: h(csrf) });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("toggle task visibility", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Hide
    let r = await api.patch(`/api/admin/tasks/${S.mutTask.id}/visibility`, { headers: h(csrf), data: { active: false } });
    expect(r.ok()).toBeTruthy();
    // Show
    r = await api.patch(`/api/admin/tasks/${S.mutTask.id}/visibility`, { headers: h(csrf), data: { active: true } });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("assign task to upcoming competition via POST", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/competitions`, {
      headers: h(csrf), data: { competitionIds: [S.upcomingComp.id] },
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).assigned).toBe(1);
    await api.dispose();
  });

  test("assign task to live competition via POST", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/competitions`, {
      headers: h(csrf), data: { competitionIds: [S.liveComp.id] },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("remove task from upcoming competition via DELETE", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.delete(`/api/admin/tasks/${S.mutTask.id}/competitions/${S.upcomingComp.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("PUT sync — assign and unassign atomically", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Get current state
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const cur = (tasks.find(t => t.id === S.mutTask.id)?.competitions || []).map(c => c.id);
    // Sync: add to upcoming, keep existing
    const r = await api.put(`/api/admin/tasks/${S.mutTask.id}/competitions`, {
      headers: h(csrf), data: {
        competitionIds: [...cur, S.upcomingComp.id],
        expectedAssignments: cur,
      },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.added).toBe(1);
    await api.dispose();
  });

  test("author fields visible in admin task list", async () => {
    // v8.3.16 — OWNS ITS PRECONDITION. It used to look the row up by the title
    // `edit task` gives it ("Mut Task 1 Updated") and assert the author values
    // that same sibling wrote, so alone it failed on `expect(t).toBeTruthy() →
    // undefined`. What it is actually about is that the admin list PROJECTS the
    // author columns, so it writes them itself and reads them back.
    const { api, csrf } = await apiLogin("superadmin");
    const put = await api.put(`/api/admin/tasks/${S.mutTask.id}`, { headers: h(csrf), data: {
      title: "Mut Task 1 Updated", author_name: "Updated Author",
      author_linkedin: "https://linkedin.com/in/testauthor",
    }});
    expect(put.ok(), `author fields written: ${await put.text()}`).toBeTruthy();
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const t = tasks.find(t => t.id === S.mutTask.id);
    expect(t, "the shared task is listed").toBeTruthy();
    expect(t.title).toBe("Mut Task 1 Updated");
    expect(t.author_name).toBe("Updated Author");
    expect(t.author_linkedin).toBe("https://linkedin.com/in/testauthor");
    await api.dispose();
  });

  test("superadmin can lock a challenge", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    await ensureTaskLocked(api, csrf, S.mutTask.id, false);
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/lock`, { headers: h(csrf) });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.locked).toBe(1);
    await api.dispose();
  });

  test("locked challenge rejects PUT edit", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    await ensureTaskLocked(api, csrf, S.mutTask.id, true);
    const r = await api.put(`/api/admin/tasks/${S.mutTask.id}`, { headers: h(csrf), data: { title: "Should Fail" } });
    expect(r.status()).toBe(403);
    await api.dispose();
  });

  test("locked challenge rejects restore", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // v8.3.16 — the version fixture is BUILT, not hoped for. This was
    // `if (versions.length > 0) { … }`, so on a task with no version history the
    // whole test asserted nothing — vacuous by construction, and silently so.
    // A PUT writes a version, and it has to happen while the task is UNLOCKED.
    await ensureTaskLocked(api, csrf, S.mutTask.id, false);
    const seed = await api.put(`/api/admin/tasks/${S.mutTask.id}`, { headers: h(csrf), data: {
      title: "Mut Task 1 Updated", author_name: "Updated Author",
    }});
    expect(seed.ok(), `version-seeding edit: ${await seed.text()}`).toBeTruthy();
    await ensureTaskLocked(api, csrf, S.mutTask.id, true);

    const versions = await (await api.get(`/api/admin/tasks/${S.mutTask.id}/versions`)).json();
    expect(versions.length, "there is a version to attempt a restore of").toBeGreaterThan(0);
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/restore`, { headers: h(csrf), data: { versionId: versions[versions.length - 1].id } });
    expect(r.status()).toBe(403);
    await api.dispose();
  });

  test("superadmin can unlock a challenge", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    await ensureTaskLocked(api, csrf, S.mutTask.id, true);
    const r = await api.post(`/api/admin/tasks/${S.mutTask.id}/lock`, { headers: h(csrf) });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.locked).toBe(0);
    await api.dispose();
  });

  test("GET feedback for a challenge (admin)", async () => {
    // v7.21.39 — S.easy1 comes from ensureState(); this test never called it and
    // so read it only because a sibling had. Alone: "Cannot read properties of
    // undefined (reading 'id')".
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const r = await api.get(`/api/admin/tasks/${S.easy1.id}/feedback`);
    expect(r.ok()).toBeTruthy();
    const fb = await r.json();
    expect(Array.isArray(fb)).toBeTruthy();
    await api.dispose();
  });

  test("regular admin cannot delete feedback", async () => {
    // v8.3.11 — the v7.21.39 sweep fixed this test's immediate sibling and missed
    // it: without ensureState() `S.carol` is undefined when the test runs alone,
    // and it fails as `Cannot read properties of undefined (reading 'id')`.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    await sa.dispose();
    let carolApi = null;
    try {
      const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      carolApi = api;
      const r = await api.delete(`/api/admin/tasks/${S.easy1.id}/feedback`, { headers: { "x-csrf-token": csrf } });
      expect(r.status()).toBe(403);
    } finally {
      if (carolApi) await carolApi.dispose();
      // Demote Carol back to the HARD-CODED seed role — never one read at
      // runtime, which with three promoters in this file would faithfully
      // reinstate the previous leak. A failed assertion above would otherwise
      // leave her an admin (and auto-tagged `staff`) for the rest of the file,
      // which the runtime fixture guard fails the WHOLE file for.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf2), data: { role: "participant" } }).catch(() => {});
      await sa2.dispose();
    }
  });

  test("superadmin can delete task (after unassigning from live)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Unassign from all competitions first (task was assigned to live + upcoming)
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const t = tasks.find(t => t.id === S.mutTask.id);
    if (t) {
      for (const c of t.competitions || []) {
        await api.delete(`/api/admin/tasks/${S.mutTask.id}/competitions/${c.id}`, { headers: { "x-csrf-token": csrf } });
      }
    }
    const r = await api.delete(`/api/admin/tasks/${S.mutTask.id}`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  // `POST /api/admin/tasks` whitelist-normalises `status` to exactly
  // draft|published. NOTE the scope: this is a guarantee of THIS ROUTE, not a
  // column invariant — `tasks.status` has no CHECK constraint and the
  // superadmin task-IMPORT path binds `t.status || "draft"` verbatim, so a
  // non-canonical value can still reach the column that way.
  //   • absent  → draft  — load-bearing because the column DEFAULT is
  //     'published' (db.js), so a create route that stopped binding status
  //     would make a half-finished challenge instantly assignable.
  //   • "Published" → draft — anything else would store a value no participant
  //     query (`status='published'`) can ever match, while the admin list still
  //     shows it and the assign route refuses it.
  test("task create normalises status: absent and non-canonical both become draft", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const uniq = `StatusNorm ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const base = { description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "x" };
    const made = [];
    const create = async (label, over) => {
      const title = `${uniq} ${label}`;
      const r = await api.post("/api/admin/tasks", { headers: h(csrf), data: { ...base, title, ...over } });
      expect(r.ok(), `create ${label} failed: ${r.status()} ${await r.text()}`).toBeTruthy();
      const d = await r.json();
      made.push({ id: d.id, title });
      return d;
    };
    try {
      const absent = await create("absent", {});
      expect(absent.status, "status omitted must default to draft, not the column DEFAULT 'published'").toBe("draft");

      const noncanon = await create("noncanonical", { status: "Published" });
      expect(noncanon.status, '"Published" must normalise to draft, not be stored verbatim').toBe("draft");

      const canon = await create("canonical", { status: "published" });
      expect(canon.status).toBe("published");

      // Re-read the STORED value — the create response echoes the same variable
      // the INSERT binds, so on its own it cannot prove what landed in the row.
      const tasks = await (await api.get("/api/admin/tasks")).json();
      const stored = (id) => {
        const row = tasks.find(t => t.id === id);
        expect(row, `created task ${id} missing from the admin list`).toBeTruthy();
        return row.status;
      };
      expect(stored(absent.id)).toBe("draft");
      expect(stored(noncanon.id)).toBe("draft");
      expect(stored(canon.id)).toBe("published");
      for (const { id } of made) expect(["draft", "published"]).toContain(stored(id));

      // The default has teeth downstream: a draft cannot be assigned.
      const asg = await api.post(`/api/admin/tasks/${absent.id}/competitions`, {
        headers: h(csrf), data: { competitionIds: [S.upcomingComp.id] },
      });
      expect(asg.status(), "a status-less (draft) challenge must not be assignable").toBe(400);
      expect((await asg.json()).error).toMatch(/only published/i);
    } finally {
      // The worker DB accumulates across this whole file — clean up.
      for (const { id } of made) await api.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("regular admin cannot delete task", async () => {
    await ensureState();
    // Promote Carol to admin, login as Carol
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    await sa.dispose();
    let carolApi = null;
    try {
      const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      carolApi = api;
      const r = await api.delete(`/api/admin/tasks/${S.easy1.id}`, { headers: { "x-csrf-token": csrf } });
      expect(r.status()).toBe(403);
    } finally {
      if (carolApi) await carolApi.dispose();
      // Demote Carol back to the HARD-CODED seed role — never one read at
      // runtime, which with three promoters in this file would faithfully
      // reinstate the previous leak. A failed assertion above would otherwise
      // leave her an admin (and auto-tagged `staff`) for the rest of the file,
      // which the runtime fixture guard fails the WHOLE file for.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf2), data: { role: "participant" } }).catch(() => {});
      await sa2.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMISSION ANSWER TYPES — json / file (v6.7.0)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Submission answer types", () => {
  const T = { ready: false };

  async function ensureTypeComp() {
    if (T.ready) return;
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const hdr = h(csrf);
    const now = Date.now();
    const r = await api.post("/api/admin/competitions", { headers: hdr, data: {
      name: `Sub-Types ${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 180,
    }});
    T.compId = (await r.json()).competition?.id;
    // Assign Alice AND Bob — Bob never submits, so Alice solving one task
    // in a given test cannot trigger the "all participants solved all tasks"
    // auto-end that would freeze the competition for the next test.
    await api.post("/api/admin/competitions/assign", { headers: hdr, data: {
      userIds: [S.alice.id, S.bob.id], competitionIds: [T.compId],
    }});
    await api.dispose();
    T.ready = true;
  }

  async function createTask(opts) {
    await ensureTypeComp();
    const { api, csrf } = await apiLogin("superadmin");
    const hdr = h(csrf);
    const r = await api.post("/api/admin/tasks", { headers: hdr, data: opts });
    const bankId = (await r.json()).id;
    const a = await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: hdr, data: { competitionIds: [T.compId] } });
    expect(a.ok(), `assign: ${a.status()} ${await a.text()}`).toBeTruthy();
    // The event's own copy (lib/event-copies.js): what alice answers and an admin locks.
    const tid = (await a.json()).copies[0].task_id;
    await api.dispose();
    return tid;
  }

  async function aliceInTypeComp() {
    await ensureTypeComp();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: T.compId } });
    return { api, csrf };
  }

  test("JSON submit — correct answer with re-ordered object keys still matches", async () => {
    const tid = await createTask({
      title: `JSON Correct ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "json", correct_answer: '{"a":1,"b":[1,2]}', status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: h(csrf), data: { answer: '{"b":[1,2],"a":1}' , gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).correct).toBeTruthy();
    await api.dispose();
  });

  test("JSON submit — different value is wrong", async () => {
    const tid = await createTask({
      title: `JSON Wrong ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "json", correct_answer: '{"a":1,"b":2}', status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: h(csrf), data: { answer: '{"a":1,"b":3}' , gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).correct).toBeFalsy();
    await api.dispose();
  });

  test("JSON submit — array order matters", async () => {
    const tid = await createTask({
      title: `JSON Array ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "json", correct_answer: "[1,2,3]", status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: h(csrf), data: { answer: "[3,2,1]" , gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).correct).toBeFalsy();
    await api.dispose();
  });

  test("JSON submit — malformed JSON is wrong, not a 500", async () => {
    const tid = await createTask({
      title: `JSON Malformed ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "json", correct_answer: '{"a":1}', status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: h(csrf), data: { answer: "{a:1", gradingHash: await gradingHashFor(api, tid) },
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).correct).toBeFalsy();
    await api.dispose();
  });

  test("File submit — matching content is correct", async () => {
    const tid = await createTask({
      title: `File OK ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "file", correct_answer: "hello-world", status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("hello-world") },
        gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).correct).toBeTruthy();
    await api.dispose();
  });

  test("File submit — wrong content is rejected", async () => {
    const tid = await createTask({
      title: `File Wrong ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "file", correct_answer: "right-answer", status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("wrong-answer") },
        gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).correct).toBeFalsy();
    await api.dispose();
  });

  // ── ext-audit v7.15.13 (MEDIUM): the file path must re-check state after the read ──
  // The task row, its competition assignment and the grading hash were all read
  // BEFORE `await fs.promises.readFile`, and that await yields the event loop.
  // An admin acting during the read was ignored entirely — a challenge locked
  // mid-read still graded and still awarded its points. The delay hook makes the
  // window deterministic; without it readFile finishes in well under a
  // millisecond and no admin write could ever land inside it.
  test("locking a challenge DURING the file read blocks the submission", async () => {
    const tid = await createTask({
      title: `File TOCTOU lock ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "file", correct_answer: "hello-world", status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    try {
      await sa.post("/api/test/submit-read-delay", {
        headers: { "content-type": "application/json" }, data: { delayMs: 1200 },
      });
      // Fire the submit but DON'T await it — it is now parked inside the read.
      const submitting = api.post(`/api/tasks/${tid}/submit`, {
        headers: { "x-csrf-token": csrf },
        multipart: { file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("hello-world") } , gradingHash: await gradingHashFor(api, tid)},
      });
      await new Promise(r => setTimeout(r, 400));           // inside the window
      const lock = await sa.post(`/api/admin/tasks/${tid}/lock`, {
        headers: { "x-csrf-token": sc, "content-type": "application/json" }, data: { locked: true },
      });
      expect(lock.ok(), `lock during read: ${await lock.text()}`).toBeTruthy();

      const r = await submitting;
      expect(r.status(),
        "a challenge locked during the file read must be refused, not graded against the pre-read snapshot"
      ).toBe(423);

      // And nothing was scored: no submission row for this task.
      const subs = await (await sa.get(`/api/admin/submissions?limit=200`)).json();
      const mine = (subs.submissions || []).filter(x => x.task_id === tid);
      expect(mine.length, "a refused submission must not be recorded").toBe(0);
    } finally {
      // The knob is process-global and does NOT auto-reset, so leaving it set
      // would slow every later file submit in this worker. Reset it with its own
      // client, so a failure that already disposed `sa` still clears it.
      const { api: reset, csrf: rc } = await apiLogin("superadmin");
      await reset.post("/api/test/submit-read-delay", {
        headers: { "x-csrf-token": rc, "content-type": "application/json" }, data: { delayMs: 0 },
      });
      await reset.dispose();
      await sa.dispose(); await api.dispose();
    }
  });

  test("File posted to a json task — 400 task_changed, no penalty", async () => {
    const tid = await createTask({
      title: `JSON Not File ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "json", correct_answer: '{"a":1}', status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: { "x-csrf-token": csrf },
      multipart: {
        file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from('{"a":1}') },
        gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.status()).toBe(400);
    const d = await r.json();
    expect(d.task_changed).toBeTruthy();
    await api.dispose();
  });

  test("Text posted to a file task — 400 task_changed, no penalty", async () => {
    const tid = await createTask({
      title: `File Not Text ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "file", correct_answer: "abc", status: "published",
    });
    const { api, csrf } = await aliceInTypeComp();
    const r = await api.post(`/api/tasks/${tid}/submit`, {
      headers: h(csrf), data: { answer: "abc" , gradingHash: await gradingHashFor(api, tid)},
    });
    expect(r.status()).toBe(400);
    const d = await r.json();
    expect(d.task_changed).toBeTruthy();
    await api.dispose();
  });

  test("cleanup: delete submission-types competition", async () => {
    if (!T.compId) return;
    const { api, csrf } = await apiLogin("superadmin");
    // Competition is live; end it before deleting (delete refuses on live comps).
    await api.post(`/api/admin/competitions/${T.compId}/end-now`, { headers: h(csrf) });
    await api.delete(`/api/admin/competitions/${T.compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — PARTICIPANT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
// ===========================================================================
// AUTO-END vs SELF-ENROLLMENT (v7.7.18)
// ===========================================================================
test.describe("Auto-end vs self-enrollment (v7.7.18)", () => {
  // Create a LIVE single-slot comp (optionally self-enroll-enabled), one published
  // task, assign alice, and have alice solve it -> every non-staff participant has
  // solved every published challenge (the all-solved auto-end trigger).
  async function liveCompAliceSolves(selfEnroll) {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = h(saCsrf);
    const uniq = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
    const body = { name: `AE ${selfEnroll ? "self" : "ctl"} ${uniq}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180 };
    if (selfEnroll) body.self_enroll_enabled = true;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: body })).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: `AE task ${uniq}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "win", status: "published" } })).json()).id;
    const tAsg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    expect(tAsg.ok(), `AE fixture: task→competition assign answered ${tAsg.status()} ${await tAsg.text()}`).toBeTruthy();
    // v8.3.11 — ASSERT THE ENROLMENT, because a skip here is INVISIBLE and looks
    // exactly like the auto-end being broken. `POST .../assign` silently SKIPS a
    // staff / benchmark / blocked / unapproved user, so a skipped alice has NO
    // `competition_users` row → `scoringParticipantIds` is empty → the scan
    // returns without deciding and the competition stays live. And the submit
    // below STILL succeeds and still grades `correct`, because
    // `requireParticipantInCompetition` `return next()`s for staff BEFORE any
    // membership read (v8.3.10) — so the only symptom is "the comp did not end",
    // pointing at the auto-end rather than at the fixture.
    //
    // Seen ONCE on a local run of this describe and NOT reproduced in five
    // subsequent runs, so NO mechanism is claimed; what is certain is that the
    // fixture never asserted the precondition that would name this one.
    const pAsg = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] } });
    const pAsgJ = await pAsg.json();
    expect(pAsgJ.assigned,
      `AE fixture: alice must be ENROLLED, not skipped — assign said ${JSON.stringify(pAsgJ)}`
    ).toBe(1);
    await sa.dispose();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const sel = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `AE fixture: select-competition answered ${sel.status()} ${await sel.text()}`).toBeTruthy();
    const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "win" , gradingHash: await gradingHashFor(api, taskId)} });
    expect((await r.json()).correct, "alice solves the only task").toBeTruthy();
    await api.dispose();
    return { compId, taskId };
  }
  async function compRow(compId) {
    const { api } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    await api.dispose();
    return comps.find(c => c.id === compId);
  }
  async function delComp(compId) {
    if (!compId) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  }

  test("all-solved auto-ends a normal comp but NOT a self-enroll-enabled comp", async () => {
    let ctl, selfC;
    try {
      ctl = (await liveCompAliceSolves(false)).compId;
      selfC = (await liveCompAliceSolves(true)).compId;
      const c = await compRow(ctl);
      const s = await compRow(selfC);
      // v8.3.11 — report the ROW on failure. "not ended" is equally true of a
      // suppressed auto-end, a competition whose `auto_end_on_all_solved` column
      // is off, and one whose kind forbids the rule; the bare status names none
      // of the three.
      expect(c.status, `normal comp auto-ends when all solved — row: ${JSON.stringify(c)}`).toBe("ended");
      expect(c.ended_at, "normal comp ended_at is set").toBeTruthy();
      expect(s.status, "self-enroll comp stays live when all solved").not.toBe("ended");
      expect(s.ended_at, "self-enroll comp ended_at stays NULL").toBeFalsy();
    } finally { await delComp(ctl); await delComp(selfC); }
  });

  // ── v7.15.16: the REFUSAL half of the revive gate ─────────────────────────
  // Every existing revive test takes a skip path (manual end, self-enroll, or
  // time-expired), so the all-solved computation itself never ran. Proven by
  // mutation: replacing it with a constant `false` passed 573 tests. This is the
  // case the gate exists for — extend an auto-ended comp whose participants HAVE
  // all solved everything, and it must stay ended.
  test("extending an ALL-SOLVED-ended comp does NOT revive it", async () => {
    let compId;
    try {
      compId = (await liveCompAliceSolves(false)).compId;
      expect((await compRow(compId)).status, "comp auto-ended on all-solved").toBe("ended");
      const before = await compRow(compId);

      const { api, csrf } = await apiLogin("superadmin");
      const put = await api.put(`/api/admin/competitions/${compId}`, {
        headers: h(csrf), data: { duration_minutes: 600 },      // extend, nothing else
      });
      expect(put.ok(), `PUT: ${put.status()} ${await put.text()}`).toBeTruthy();
      const pj = await put.json();
      await api.dispose();

      expect(pj.allSolved,
        "the gate must REPORT that everyone has already solved everything — this is the flag " +
        "the admin UI branches on to explain why the extend did not revive"
      ).toBe(true);
      const after = await compRow(compId);
      expect(after.status, "an all-solved comp must STAY ended when merely extended").toBe("ended");
      expect(after.ended_at, "and keep its ended_at").toBeTruthy();
      expect(after.ended_at, "the same ended_at, not a re-stamped one").toBe(before.ended_at);
    } finally { await delComp(compId); }
  });

  test("extending an ALL-SOLVED-ended TIMESLOT does not revive it either", async () => {
    // routes/sessions.js carries the same gate as routes/competitions.js and had
    // the same absence of coverage.
    let compId;
    try {
      await ensureState();
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      const saH = h(saCsrf);
      const uniq = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
      compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: {
        name: `AE ts ${uniq}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180,
      } })).json()).competition.id;
      const tsId = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: saH, data: {
        name: "Slot A", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 60,
      } })).json()).timeslot.id;
      const taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: {
        title: `AE ts task ${uniq}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "win", status: "published",
      } })).json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
      await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] } });
      await sa.dispose();

      const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
      await api.post("/api/select-timeslot", { headers: h(csrf), data: { timeslotId: tsId, confirmLive: true } });
      const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "win" , gradingHash: await gradingHashFor(api, taskId)} });
      expect((await sub.json()).correct, "alice solves the only task in her slot").toBeTruthy();
      await api.dispose();

      const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
      const slots = await (await sa2.get(`/api/admin/competitions/${compId}/timeslots`)).json();
      const slot = (Array.isArray(slots) ? slots : slots.timeslots || []).find(t => t.id === tsId);
      expect(slot.ended_at, "the slot auto-ended on all-solved").toBeTruthy();

      const put = await sa2.put(`/api/admin/competitions/${compId}/timeslots/${tsId}`, {
        headers: h(c2), data: { duration_minutes: 600, expectedUpdatedAt: slot.updated_at },
      });
      expect(put.ok(), `PUT slot: ${put.status()} ${await put.text()}`).toBeTruthy();
      const pj = await put.json();
      await sa2.dispose();
      expect(pj.allSolved, "the timeslot gate must report all-solved too").toBe(true);
      expect(pj.revived, "and must NOT revive the slot").toBeFalsy();
    } finally { await delComp(compId); }
  });

  test("extending an all-solved-ended comp REVIVES it once self-enrollment is enabled", async () => {
    let compId;
    try {
      compId = (await liveCompAliceSolves(false)).compId;
      expect((await compRow(compId)).status, "comp auto-ended first").toBe("ended");
      // Superadmin enables self-enroll AND extends the duration. The revive path
      // skips the all-solved gate for self-enroll comps, so it must revive.
      const { api, csrf } = await apiLogin("superadmin");
      const put = await api.put(`/api/admin/competitions/${compId}`, { headers: h(csrf), data: { self_enroll_enabled: true, duration_minutes: 600 } });
      expect(put.ok(), `revive PUT: ${put.status()}`).toBeTruthy();
      const pj = await put.json();
      await api.dispose();
      expect(pj.allSolved, "revive reports allSolved:false (gate skipped for self-enroll)").toBeFalsy();
      const after = await compRow(compId);
      expect(after.status, "comp revived to live").not.toBe("ended");
      expect(after.ended_at, "ended_at cleared on revive").toBeFalsy();
    } finally { await delComp(compId); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // v8.3.11 (F4) — TURNING SELF-ENROLLMENT OFF DOES NOT END THE EVENT
  //
  // The admin guide promised the suppressed event "ends at its scheduled time,
  // when you press End now, or WHEN YOU TURN SELF-ENROLLMENT OFF". That third
  // clause was never implemented and is now removed from the guide and the
  // README (v8.3.11 is a DOCS-ONLY fix here) — so these two tests are the whole
  // of the evidence that the corrected sentences are true. Without them the fix
  // is a prose edit nothing checks.
  //
  // WHY THE CLAUSE WAS NOT IMPLEMENTED INSTEAD, because the mutation below makes
  // someone re-open exactly that question:
  //   * it would create a FOURTH not-ended→ended writer, and each one must also
  //     freeze the group board, re-arm the status observation, bust two caches,
  //     emit `auto_ended` and loop per timeslot — the v7.15.6 enumeration this
  //     file keeps paying for;
  //   * it would end a LIVE event as a SIDE EFFECT of a settings save, which is
  //     the v8.1.9 defect with the sides swapped and is what v8.3.10's "a
  //     correction may not silently end the event" forbids;
  //   * and it would still do nothing for a Booth Event or a Program, which
  //     never auto-end on all-solved at all — so the guide needed correcting
  //     whichever way the code went.
  //
  // OWNED FIXTURES THROUGHOUT. These tests deliberately do NOT use the file's
  // `liveCompAliceSolves` helper: they need the SOLE scoring participant of the
  // event to be the one who solves, and the shared `alice` is re-passworded,
  // re-tagged and re-enrolled by other tests in this worker (v7.15.32). Each
  // test registers, verifies and approves its own participant.
  //
  // A Booth-Event control is deliberately absent — the "a Booth Event never
  // auto-ends on all-solved" half of v8.3.11 is locked in its own spec, and a
  // second copy here would be a rule with two owners.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Register + verify + approve a participant nobody else in this file touches. */
  async function f4Participant(sa, saH, label) {
    const email = `${label}@corp.example`;
    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", { headers: h(ac), data: {
      firstName: "Auto", lastName: "End", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    }});
    expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
    await anon.dispose();
    // limit=5000, never `?search=` — that parameter is a NO-OP on this endpoint
    // (v8.2.3), so a search-shaped lookup is really page 1 ordered created_at ASC
    // and a just-created account is the LAST thing it would find.
    const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, `${label} must be findable among ${(list.participants || []).length} participants`).toBeTruthy();
    expect((await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH })).ok(),
      `${label} verify`).toBeTruthy();
    expect((await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH })).ok(),
      `${label} approve`).toBeTruthy();
    return { id: u.id, email };
  }

  /**
   * A LIVE self-enroll-enabled Competition with one published challenge and one
   * enrolled participant, who has solved it — i.e. every scoring participant has
   * finished everything, which is precisely the state the auto-end fires on and
   * the suppression withholds.
   */
  async function f4AllSolvedSuppressed(label) {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = h(saCsrf);
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const p = await f4Participant(sa, saH, `${label}${uniq}`);

    const cr = await sa.post("/api/admin/competitions", { headers: saH, data: {
      name: `F4 ${label} ${uniq}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      duration_minutes: 180,
      self_enroll_enabled: true,
    }});
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const compId = (await cr.json()).competition.id;

    // The kind seeds `auto_end_on_all_solved` at create, and a Competition seeds
    // it ON. Assert it, or "the event did not end" is equally satisfied by a
    // fixture whose column happened to be 0 for a completely unrelated reason.
    //
    // Read through the session we already hold. A SECOND `apiLogin("superadmin")`
    // here would trip the single-session-per-user rule and silently kill `sa`,
    // whose next call then answers 401 — which surfaces further down as an
    // unrelated `task 1 created / Received: undefined` (v7.19.0).
    const row0 = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(row0 && row0.event_kind, "the fixture is a Competition (the kind that MAY auto-end)").toBe("tournament");
    expect(!!(row0 && row0.auto_end_on_all_solved), "auto_end_on_all_solved is ON for this fixture").toBe(true);

    // The assign endpoint SILENTLY SKIPS staff / benchmark / blocked / unapproved
    // users, so a skip would leave the event with ZERO scoring participants and
    // the auto-end scan would return before deciding anything (the fixture
    // checklist, item 4). Assert the count, so a bad precondition fails as one.
    const asgP = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [p.id], competitionIds: [compId] } });
    expect((await asgP.json()).assigned, `${p.email} must actually be enrolled`).toBe(1);
    await sa.dispose();

    /**
     * Publish one more challenge into the event. Takes its OWN superadmin session
     * for the same single-session reason as above — it is called again from the
     * re-arm test long after this fixture has finished, so it cannot close over
     * one, and holding one open would collide with `compRow` / `delComp`.
     */
    async function addTask(n, answer) {
      const { api, csrf } = await apiLogin("superadmin");
      const H = h(csrf);
      const cr2 = await api.post("/api/admin/tasks", { headers: H, data: {
        title: `F4 ${label} t${n} ${uniq}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: answer, status: "published",
      }});
      expect(cr2.ok(), `create task ${n}: ${cr2.status()} ${await cr2.text()}`).toBeTruthy();
      const t = await cr2.json();
      expect(t.id, `task ${n} created`).toBeTruthy();
      const asg = await api.post(`/api/admin/tasks/${t.id}/competitions`, { headers: H, data: { competitionIds: [compId] } });
      expect(asg.ok(), `assign task ${n}: ${asg.status()} ${await asg.text()}`).toBeTruthy();
      await api.dispose();
      return t.id;
    }

    /** Solve one challenge as the owned participant. */
    async function solve(taskId, answer) {
      const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
      const sel = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
      expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: {
        answer, gradingHash: await gradingHashFor(api, taskId),
      }});
      const sj = await sub.json();
      expect(sj.correct, `solve ${taskId}: ${JSON.stringify(sj)}`).toBeTruthy();
      await api.dispose();
    }

    const t1 = await addTask(1, "win1");
    await solve(t1, "win1");
    return { compId, addTask, solve, participant: p };
  }

  test("F4: disabling self-enrollment does NOT retroactively end an all-solved event — End Now does", async () => {
    let compId;
    try {
      const f = await f4AllSolvedSuppressed("off");
      compId = f.compId;

      // ── The positive control for the SUPPRESSION itself ──────────────────
      // Everyone in the event has now solved everything, so a Competition with
      // the join link CLOSED would already have auto-ended here. Still live means
      // the v7.7.18 suppression really fired — without this line the assertions
      // below are satisfied by a build in which nothing was ever going to end.
      const live = await compRow(compId);
      expect(live.status, "self-enroll suppression holds while everyone has solved everything").not.toBe("ended");
      expect(live.ended_at, "and ended_at is still NULL").toBeFalsy();

      // ── THE FIX. Flipping the switch off must change nothing about the ──────
      // event's lifecycle. MUTATION THIS KILLS: add an all-solved re-evaluation
      // to the `selfEnrollEnabledCol` 1→0 branch of PUT /api/admin/competitions
      // (i.e. build the clause the guide used to promise) and this goes red — on
      // purpose, so whoever builds it has to correct the guide in the same commit.
      const { api: sa, csrf } = await apiLogin("superadmin");
      const put = await sa.put(`/api/admin/competitions/${compId}`, {
        headers: h(csrf), data: { self_enroll_enabled: false },
      });
      expect(put.ok(), `disable self-enroll: ${put.status()} ${await put.text()}`).toBeTruthy();
      await sa.dispose();

      const afterFlip = await compRow(compId);
      expect(afterFlip.self_enroll_enabled,
        "precondition: the switch really is off now, so the assertion below is about the flip"
      ).toBeFalsy();
      expect(afterFlip.status,
        "turning self-enrollment OFF must not close an event retroactively — the all-solved " +
        "predicate is evaluated only in the submit transaction, and there is no submission left " +
        "to re-check once everyone has finished"
      ).not.toBe("ended");
      expect(afterFlip.ended_at, "and ended_at stays NULL").toBeFalsy();

      // ── The remedy the corrected guide now names, driven for real ──────────
      // "Press End now when you are done." A doc that names a remedy has to be
      // held to it (v7.29.0 FROZEN_REMEDY) — an instruction that is not true is
      // worse than no instruction.
      const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
      const en = await sa2.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(c2) });
      expect(en.ok(), `end-now: ${en.status()} ${await en.text()}`).toBeTruthy();
      await sa2.dispose();

      const closed = await compRow(compId);
      expect(closed.status, "End Now closes it, which is what the corrected copy tells the admin to do").toBe("ended");
      expect(closed.ended_at, "and stamps ended_at").toBeTruthy();
    } finally { await delComp(compId); }
  });

  test("F4: disabling self-enrollment RE-ARMS the rule — the next completing solve auto-ends", async () => {
    // THIS TEST IS THE ANTI-VACUITY CONTROL FOR THE ONE ABOVE, and it is also the
    // README claim the fix rewrites: "Disabling self-enrollment re-arms the rule
    // for the NEXT completing solve, but it does not close the event
    // retroactively." Pin only the first half and the suite says nothing about
    // the second; pin only the second and "it did not end" is satisfied by a
    // build where the auto-end is broken outright.
    //
    // MEASURED, not argued: with `autoEndOnAllSolvedApplies` forced to return
    // false — a build in which NOTHING ever auto-ends — the test above passes
    // untouched and only this one goes red. That is exactly the hole it fills.
    let compId;
    try {
      const f = await f4AllSolvedSuppressed("rearm");
      compId = f.compId;
      expect((await compRow(compId)).status, "suppressed while the link is open").not.toBe("ended");

      const { api: sa, csrf } = await apiLogin("superadmin");
      const put = await sa.put(`/api/admin/competitions/${compId}`, {
        headers: h(csrf), data: { self_enroll_enabled: false },
      });
      expect(put.ok(), `disable self-enroll: ${put.status()} ${await put.text()}`).toBeTruthy();
      await sa.dispose();
      expect((await compRow(compId)).status, "still live immediately after the flip").not.toBe("ended");

      // A second published challenge takes the cohort back to 1-of-2 solved, so
      // there IS a completing submission left to make. Solving it is the "next
      // solve" the corrected sentence promises will auto-end the event.
      const t2 = await f.addTask(2, "win2");
      expect((await compRow(compId)).status, "adding a challenge does not end anything either").not.toBe("ended");
      await f.solve(t2, "win2");

      const after = await compRow(compId);
      expect(after.status,
        "with the join link closed, the next completing solve auto-ends the event exactly as it " +
        "always did — this is what makes 'disabling re-arms the rule' a true sentence"
      ).toBe("ended");
      expect(after.ended_at, "the auto-end stamps ended_at").toBeTruthy();
    } finally { await delComp(compId); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.29 batch 4 — participant import / task export edges
//   M4: an import row whose nickname and email resolve to DIFFERENT existing
//       users must be split_identity (rename/keep), never a silent overwrite of
//       the nickname-matched account.
//   M7: import 'overwrite' must apply `approved` (not just verified/blocked),
//       so approved never drifts out of sync with approved_at/approved_by.
//   M6: a competition-scoped task export must not choke on the platform-wide
//       attachment set — an empty scoped export must still 200 (guards the
//       task_id IN (...) scoping + its empty-set edge).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.29 batch 4 — import identity + approved + scoped export", () => {
  const importP = async (sa, csrf, participants, resolutions) =>
    sa.post("/api/admin/import/participants", { headers: h(csrf), data: {
      data: { type: "hackarena-participants", version: 2, participants }, ...(resolutions ? { resolutions } : {}),
    }});

  test("M4: nickname↔email cross-match is split_identity (no wrong-account overwrite)", async () => {
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const nickA = `b4a_${s}`, nickB = `b4b_${s}`, emailA = `b4a_${s}@corp.com`, emailB = `b4b_${s}@corp.com`;
    // Seed A + B.
    let r = await importP(sa, csrf, [
      { first_name: "AAA", last_name: "One", nickname: nickA, email: emailA, company: "X", title: "E", country: "US", timezone: "America/New_York", job_function: "Software Developer / Engineer", city: "NYC", verified: 1, approved: 1 },
      { first_name: "BBB", last_name: "Two", nickname: nickB, email: emailB, company: "X", title: "E", country: "US", timezone: "America/New_York", job_function: "Software Developer / Engineer", city: "NYC", verified: 1, approved: 1 },
    ], {});
    expect(r.ok(), `seed import: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).imported).toBe(2);

    // Cross-matched row: A's nickname + B's email.
    const crossRow = [{ first_name: "CROSS", last_name: "Bad", nickname: nickA, email: emailB, company: "X", title: "E", country: "US", timezone: "America/New_York", job_function: "Software Developer / Engineer", city: "NYC", verified: 1, approved: 1 }];
    // Dry-run must type it split_identity.
    r = await importP(sa, csrf, crossRow);
    const dry = await r.json();
    expect(dry.dryRun).toBe(true);
    expect(dry.conflicts[0].conflictType, "nickname↔email cross-match must be split_identity").toBe("split_identity");
    expect(dry.conflicts[0].existingId, "split_identity carries no existingId (forces rename/keep)").toBeFalsy();

    // Forcing overwrite must be REJECTED, and BOTH A and B must be untouched.
    r = await importP(sa, csrf, crossRow, { "0": "overwrite" });
    expect(r.status(), "overwrite of a split_identity row must 4xx").toBeGreaterThanOrEqual(400);
    const exp = await (await sa.get("/api/admin/export/participants")).json();
    const A = exp.participants.find(p => p.email === emailA);
    const B = exp.participants.find(p => p.email === emailB);
    expect(A.first_name, "user A (nickname owner) must be untouched").toBe("AAA");
    expect(B.first_name, "user B (email owner) must be untouched").toBe("BBB");
    await sa.dispose();
  });

  test("M7: import overwrite restores `approved` (not just verified/blocked)", async () => {
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const email = `b4m7_${s}@corp.com`, nick = `b4m7_${s}`;
    // Seed the user PENDING (approved=0).
    let r = await importP(sa, csrf, [
      { first_name: "Pend", last_name: "Ing", nickname: nick, email, company: "X", title: "E", country: "US", timezone: "America/New_York", job_function: "Software Developer / Engineer", city: "NYC", verified: 1, approved: 0 },
    ], {});
    expect(r.ok()).toBeTruthy();
    let exp = await (await sa.get("/api/admin/export/participants")).json();
    expect(exp.participants.find(p => p.email === email).approved).toBeFalsy();

    // Re-import the SAME email with approved=1 + audit stamps, resolving overwrite.
    const row = [{ first_name: "Pend", last_name: "Ing", nickname: nick, email, company: "X", title: "E", country: "US", timezone: "America/New_York", job_function: "Software Developer / Engineer", city: "NYC", verified: 1, approved: 1, approved_at: new Date().toISOString(), approved_by: "migration" }];
    r = await importP(sa, csrf, row);            // dry-run → email conflict
    const dry = await r.json();
    expect(dry.conflicts.length).toBe(1);
    r = await importP(sa, csrf, row, { "0": "overwrite" });
    expect(r.ok(), `overwrite: ${await r.text()}`).toBeTruthy();
    exp = await (await sa.get("/api/admin/export/participants")).json();
    const u = exp.participants.find(p => p.email === email);
    expect(u.approved, "approved must be restored to 1 on overwrite").toBeTruthy();
    expect(u.approved_by, "approved_by audit stamp came through too").toBe("migration");
    await sa.dispose();
  });

  test("M6: a competition-scoped task export with no tasks returns 200 (scoped-attachment IN guard)", async () => {
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    // Empty competition (no assigned tasks) — exercises the empty exported-id set.
    const comp = (await (await sa.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `B4 Empty ${s}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition;
    const r = await sa.get(`/api/admin/export/tasks?competitionId=${comp.id}`);
    expect(r.status(), "scoped export of an empty comp must not 500/413").toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBe(0);
    await sa.dispose();
  });

  test("M6: export handler scopes the attachment query by task_id when competitionId is set (source lock)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "routes/export-import.js"), "utf8");
    // The compId branch must build a task_id IN (...) filter from the exported set,
    // not scan task_attachments platform-wide (the pre-fix 413-at-scale bug).
    expect(src).toMatch(/_exportedTaskIds/);
    expect(src).toMatch(/task_attachments WHERE detached_at IS NULL AND task_id IN/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.21.1 — TWO defects on POST /api/tasks/:id/submit
// ═══════════════════════════════════════════════════════════════════════════════
//
// A5 — the file path's auto-end suppression read a STALE competition.
// A9 — the 3-second dedup keyed on a HUMAN rendering that is not injective.
//
// better-sqlite3 is opened INSIDE the helper rather than at module scope: the
// per-file isolation harness recreates the database file in a `beforeAll`, and a
// handle taken at require time would read the previous file's unlinked inode and
// answer from the PREVIOUS database with no error at all (v7.20.2).
function withSubmitDb(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

/** Every submission row for one (alice, task), oldest first. */
function submissionRows(userId, taskId) {
  return withSubmitDb(db => db.prepare(
    "SELECT answer, answer_canonical, is_correct, points_delta FROM submissions WHERE user_id=? AND task_id=? ORDER BY submitted_at ASC, rowid ASC"
  ).all(userId, taskId));
}

async function v7211CompRow(compId) {
  const { api } = await apiLogin("superadmin");
  const body = await (await api.get("/api/admin/competitions")).json();
  await api.dispose();
  return (Array.isArray(body) ? body : body.competitions || []).find(c => c.id === compId);
}

async function v7211DelComp(compId) {
  if (!compId) return;
  const { api, csrf } = await apiLogin("superadmin");
  // A live comp refuses deletion — end it first. Both calls are best-effort:
  // this is cleanup, and a failure here must not mask the real assertion.
  await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(csrf) }).catch(() => {});
  await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  await api.dispose();
}

// ── A5: the file-submit auto-end suppression must read the CURRENT competition ─
//
// `req.competition` is snapshotted by requireCompetitionContext — i.e. before
// multer and before `await fs.promises.readFile`, so on the FILE path it can be
// a whole upload old. v7.15.13 re-read the TASK across that window but left the
// self-enrollment check on the stale row, so toggling self-enrollment during an
// upload produced the OPPOSITE auto-end decision in both directions:
//   • enabled during the upload → the comp auto-ended anyway, freezing it and
//     404ing the /join link that had just been opened (the worse direction);
//   • disabled during the upload → the comp stayed open when it should have
//     ended.
// Both directions are driven below, each against a control that differs ONLY in
// whether the toggle happens — so neither can pass by the auto-end being broken
// outright, and neither can pass by it firing unconditionally.
test.describe("Auto-end reads the FRESH competition on the file path (ext-audit v7.21.1)", () => {
  async function setSubmitReadDelay(ms) {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/test/submit-read-delay", { headers: h(csrf), data: { delayMs: ms } });
    expect(r.ok(), `submit-read-delay ${ms}: ${r.status()} ${await r.text()}`).toBeTruthy();
    await api.dispose();
  }

  /**
   * A LIVE single-slot competition whose ONLY published challenge takes a FILE
   * answer, with alice as its only participant — so alice solving it is exactly
   * the all-solved auto-end trigger.
   */
  async function fileAutoEndFixture(selfEnroll) {
    await ensureState();
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    const saH = h(sc);
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const body = {
      name: `AEF ${selfEnroll ? "self" : "ctl"} ${uniq}`,
      start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180,
    };
    if (selfEnroll) body.self_enroll_enabled = true;
    const compR = await sa.post("/api/admin/competitions", { headers: saH, data: body });
    expect(compR.ok(), `comp: ${compR.status()} ${await compR.text()}`).toBeTruthy();
    const compId = (await compR.json()).competition.id;
    const taskR = await sa.post("/api/admin/tasks", { headers: saH, data: {
      title: `AEF task ${uniq}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "file", correct_answer: "hello-world", status: "published",
    }});
    expect(taskR.ok(), `task: ${taskR.status()} ${await taskR.text()}`).toBeTruthy();
    const taskId = (await taskR.json()).id;
    const asg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    expect(asg.ok(), `assign task: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    const enr = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] } });
    expect(enr.ok(), `assign alice: ${enr.status()} ${await enr.text()}`).toBeTruthy();
    await sa.dispose();
    // The entire test turns on this flag, so prove the create body actually set
    // it rather than silently dropping it.
    const row = await v7211CompRow(compId);
    expect(!!row.self_enroll_enabled, `fixture starts with self_enroll_enabled=${selfEnroll}`).toBe(selfEnroll);
    expect(row.status, "fixture competition is live").toBe("live");
    return { compId, taskId };
  }

  async function setSelfEnroll(compId, on) {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${compId}`, {
      headers: h(csrf), data: { self_enroll_enabled: on },
    });
    expect(r.ok(), `toggle self_enroll_enabled=${on}: ${r.status()} ${await r.text()}`).toBeTruthy();
    await api.dispose();
  }

  /**
   * Alice uploads the correct file answer while the read window is held open.
   * `duringWindow` (when given) runs INSIDE that window, and the caller is told
   * whether the submit was still in flight at that moment — a toggle that landed
   * after the handler had already decided would make the whole test vacuous.
   */
  async function submitFileWithWindow(compId, taskId, duringWindow) {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const sel = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    const gh = await gradingHashFor(api, taskId);
    expect(gh, "the grading token is mandatory since v7.20.9 — without it nothing is graded").toBeTruthy();

    // Both the control and the subject run with the SAME delay, so the only
    // difference between them is whether `duringWindow` fires.
    await setSubmitReadDelay(2500);
    try {
      let settled = false;
      const submitting = api.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": csrf },
        multipart: {
          file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("hello-world") },
          gradingHash: gh,
        },
      });
      submitting.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(r => setTimeout(r, 500));       // now parked inside the read
      if (duringWindow) {
        await duringWindow();
        expect(settled,
          "the admin write must land INSIDE the file-read window — if the submit had already " +
          "returned, this test would prove nothing about the stale snapshot"
        ).toBe(false);
      }
      const r = await submitting;
      expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
      const d = await r.json();
      expect(d.correct, "alice solves the only challenge — this is the all-solved trigger").toBeTruthy();
    } finally {
      // The knob is process-global and does not auto-reset; leaving it set would
      // slow every later file submit on this worker. Its own client, so a failure
      // that already tore `api` down still clears it.
      await setSubmitReadDelay(0);
      await api.dispose();
    }
  }

  test("ENABLING self-enrollment during the file read suppresses the auto-end", async () => {
    let control, subject;
    try {
      // POSITIVE CONTROL — same fixture, same delay, no toggle. Proves the
      // all-solved auto-end fires at all on the file path; without it "the comp
      // did not end" is satisfied by an auto-end that never runs.
      const cf = await fileAutoEndFixture(false);
      control = cf.compId;
      await submitFileWithWindow(cf.compId, cf.taskId, null);
      const c = await v7211CompRow(cf.compId);
      expect(c.status, "control: a normal comp auto-ends when its only participant solves everything").toBe("ended");
      expect(c.ended_at, "control: ended_at is stamped by the all-solved auto-end").toBeTruthy();

      // SUBJECT — identical, except self-enrollment is switched ON while the
      // upload is being read. The /join link is now live, so the comp must NOT
      // be frozen (CLAUDE.md, "Auto-end vs self-enrollment").
      const f = await fileAutoEndFixture(false);
      subject = f.compId;
      await submitFileWithWindow(f.compId, f.taskId, () => setSelfEnroll(f.compId, true));
      const s = await v7211CompRow(f.compId);
      expect(s.self_enroll_enabled, "the toggle applied").toBeTruthy();
      expect(s.status,
        "self-enrollment opened DURING the upload — the handler must honour the CURRENT " +
        "competition, not the pre-multer snapshot, and leave the comp live"
      ).not.toBe("ended");
      expect(s.ended_at, "and stamp no ended_at").toBeFalsy();
    } finally { await v7211DelComp(control); await v7211DelComp(subject); }
  });

  test("DISABLING self-enrollment during the file read re-arms the auto-end", async () => {
    let control, subject;
    try {
      // POSITIVE CONTROL — self-enrollment stays ON throughout, so the comp must
      // stay live. Without it, "the comp ended" would also pass on a build that
      // auto-ends unconditionally.
      const cf = await fileAutoEndFixture(true);
      control = cf.compId;
      await submitFileWithWindow(cf.compId, cf.taskId, null);
      const c = await v7211CompRow(cf.compId);
      expect(c.status, "control: an open self-enroll comp is never auto-ended by all-solved").not.toBe("ended");
      expect(c.ended_at, "control: no ended_at").toBeFalsy();

      // SUBJECT — self-enrollment switched OFF mid-upload. The /join link is dead,
      // so the all-solved auto-end applies again.
      const f = await fileAutoEndFixture(true);
      subject = f.compId;
      await submitFileWithWindow(f.compId, f.taskId, () => setSelfEnroll(f.compId, false));
      const s = await v7211CompRow(f.compId);
      expect(s.self_enroll_enabled, "the toggle applied").toBeFalsy();
      expect(s.status,
        "self-enrollment closed DURING the upload — the stale snapshot still said 'open' and " +
        "suppressed the auto-end; the fresh row must let it fire"
      ).toBe("ended");
      expect(s.ended_at, "and stamp ended_at").toBeTruthy();
    } finally { await v7211DelComp(control); await v7211DelComp(subject); }
  });
});

// ── A9: the dedup key is the CANONICAL selection, not the human rendering ─────
//
// `submissions.answer` holds a HUMAN rendering for a choice task, and
// describeSelection() joins the picked options with " | " — so an option
// literally named "Ada | Grace" renders identically to picking the separate
// options "Ada" and "Grace". Two genuinely different selections therefore
// collided on the 3-second idempotency key and the second was silently
// swallowed as a duplicate. v7.20.9 made exactly this argument for recalculate
// and missed this site; the key is now COALESCE(answer_canonical, answer).
test.describe("Submit dedup keys on the canonical selection (ext-audit v7.21.1)", () => {
  const OPT_PAIR = "Ada | Grace";       // ONE option whose text contains the separator
  const OPT_A = "Ada";
  const OPT_B = "Grace";
  const OPT_RIGHT = "Neither of them";  // the only correct option

  // Both selections under test are WRONG on purpose: the `alreadySolved` guard
  // runs BEFORE the dedup, so a correct first submission would short-circuit the
  // second and the dedup would never be reached at all.
  async function fixture() {
    await ensureState();
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    const saH = h(sc);
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: {
      name: `Dedup ${uniq}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    const choiceR = await sa.post("/api/admin/tasks", { headers: saH, data: {
      title: `Dedup choice ${uniq}`, description: "<p>Pick</p>", difficulty: "easy", answer_type: "choice",
      choices: [{ text: OPT_PAIR }, { text: OPT_A }, { text: OPT_B }, { text: OPT_RIGHT, correct: true }],
      status: "published",
    }});
    expect(choiceR.ok(), `choice task: ${choiceR.status()} ${await choiceR.text()}`).toBeTruthy();
    const choiceBank = (await choiceR.json()).id;
    const textR = await sa.post("/api/admin/tasks", { headers: saH, data: {
      title: `Dedup text ${uniq}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "right-answer", status: "published",
    }});
    const textBank = (await textR.json()).id;
    // The event's own copies (lib/event-copies.js): the rows its answers are stored under.
    const held = [];
    for (const tid of [choiceBank, textBank]) {
      const a = await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
      expect(a.ok(), `assign ${tid}: ${a.status()} ${await a.text()}`).toBeTruthy();
      held.push((await a.json()).copies[0].task_id);
    }
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] } });
    await sa.dispose();
    return { compId, choiceId: held[0], textId: held[1] };
  }

  test("two DIFFERENT selections that render identically are both recorded", async () => {
    let compId;
    try {
      const f = await fixture();
      compId = f.compId;
      const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      try {
        await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: f.compId } });
        const view = await (await api.get(`/api/tasks/${f.choiceId}`)).json();
        const idOf = (text) => {
          const c = (view.choices || []).find(x => x.text === text);
          expect(c, `option "${text}" is on the participant's copy of the challenge`).toBeTruthy();
          return c.id;
        };
        const gh = view.grading_hash;
        expect(gh, "grading token").toBeTruthy();
        // The options are shuffled per participant, so these are resolved BY TEXT
        // and the submission carries IDs — never positions.
        const pairId = idOf(OPT_PAIR), aId = idOf(OPT_A), bId = idOf(OPT_B);

        const pick = (ids) => api.post(`/api/tasks/${f.choiceId}/submit`, {
          headers: { "x-csrf-token": csrf },
          multipart: { answer: JSON.stringify(ids), gradingHash: gh },
        });

        // Back-to-back, comfortably inside the 3-second idempotency window.
        const r1 = await pick([pairId]);            // the ONE option named "Ada | Grace"
        const r2 = await pick([aId, bId]);          // "Ada" AND "Grace" — a different answer
        expect(r1.ok(), `first: ${r1.status()} ${await r1.text()}`).toBeTruthy();
        expect(r2.ok(), `second: ${r2.status()} ${await r2.text()}`).toBeTruthy();
        const d1 = await r1.json(), d2 = await r2.json();
        expect(d1.correct, "selection 1 is wrong (so the alreadySolved guard cannot short-circuit)").toBeFalsy();
        expect(d2.correct, "selection 2 is wrong too").toBeFalsy();
        expect(d1.deduped, "the first submission is never a duplicate").toBeFalsy();
        expect(d2.deduped,
          "a genuinely different selection must NOT be swallowed as a duplicate just because " +
          'describeSelection renders both as "Ada | Grace"'
        ).toBeFalsy();

        let rows = submissionRows(S.alice.id, f.choiceId);
        expect(rows.length, "both attempts are recorded, and both are penalised").toBe(2);
        // The premise of the whole test: the two rows really do collide on the
        // HUMAN column. Without this the assertion above would pass on any build
        // where the renderings simply differ, proving nothing about the key.
        expect(rows[0].answer, "the stored human rendering of selection 1").toBe(OPT_PAIR);
        expect(rows[1].answer, "…is byte-identical to that of selection 2 — the collision is real").toBe(rows[0].answer);
        expect(rows[0].answer_canonical, "…while the canonical selections differ").not.toBe(rows[1].answer_canonical);
        expect(rows[1].points_delta, "the second attempt was really graded (a -5), not folded away").toBeLessThan(0);

        // POSITIVE CONTROL — the SAME selection twice inside the window still
        // dedupes. Without it, "both recorded" is equally satisfied by a build
        // with no dedup at all.
        const r3 = await pick([aId, bId]);
        expect(r3.ok(), `repeat: ${r3.status()} ${await r3.text()}`).toBeTruthy();
        expect((await r3.json()).deduped, "an identical repeat inside 3s is still folded into one attempt").toBeTruthy();
        rows = submissionRows(S.alice.id, f.choiceId);
        expect(rows.length, "and writes no third row").toBe(2);

        // POSITIVE CONTROL — the COALESCE must not have disabled the dedup for
        // the original answer types, whose answer_canonical is NULL.
        const tgh = await gradingHashFor(api, f.textId);
        const say = (a) => api.post(`/api/tasks/${f.textId}/submit`, { headers: h(csrf), data: { answer: a, gradingHash: tgh } });
        const t1 = await say("still-wrong");
        const t2 = await say("still-wrong");
        expect(t1.ok() && t2.ok(), "text submits").toBeTruthy();
        expect((await t1.json()).deduped, "first text attempt is not a duplicate").toBeFalsy();
        expect((await t2.json()).deduped,
          "a repeated TEXT answer inside 3s must still dedupe — answer_canonical is NULL for " +
          "text, so a non-COALESCE key would never match and the guard would be dead"
        ).toBeTruthy();
        expect(submissionRows(S.alice.id, f.textId).length, "one text row, not two").toBe(1);
      } finally { await api.dispose(); }
    } finally { await v7211DelComp(compId); }
  });
});
