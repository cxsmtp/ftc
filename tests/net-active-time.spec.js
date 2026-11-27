// v8.1.0 — PRs 34/35: NET ACTIVE TIME.
//
// Elapsed time is the wrong number for a multi-day event: a Competition running
// Friday to Monday reports ~72 hours for everybody, which ranks nobody and tells
// an organiser nothing. Net active time counts five-minute buckets in which a
// request arrived carrying evidence a human was doing something.
//
// THE COMPLETION FREEZE IS THE RULE NOBODY WOULD WRITE UNPROMPTED, and without it
// the feature is actively unfair — a finisher who stays on the platform reading
// the board keeps accruing while one who closes the tab does not, so on a score
// tie the leader who sticks around LOSES to a slower finisher who left.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, BASE, codeLogin } = require("./helpers");

// `page.request` resolves relative URLs against this; without it the browser
// half fails with a bare "Invalid URL" that names nothing.
test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const ACTIVE = (c) => ({ ...H(c), "X-Client-Active": "1" });
const TAG = `np${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeEvent(api, csrf, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Ev`, timezone: "UTC",
      // The ENTRY clock: these tests count presence from entering the event, and
      // presence waits for the solve clock, which on the first-open clock (the
      // default) starts only at a first opened challenge. When a clock starts
      // is not this file's subject.
      clock_start: "entry",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, ...extra,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function makeTask(api, csrf, compId, answer = "right") {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: answer, status: "published" },
  });
  const id = (await r.json()).id;
  await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  return id;
}

async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Net", lastName: "Time", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email, nickname: label };
}

async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/** Read the stored bucket row directly — the observable the write path owns. */
function presenceRow(compId, userId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT buckets, last_bucket FROM competition_presence WHERE competition_id=? AND user_id=?")
      .get(compId, userId) || null;
  } finally { db.close(); }
}

test.describe("v8.1.0 — net active time, the write path", () => {
  test("an ACTIVE request counts a bucket; an ordinary poll counts NOTHING", async () => {
    // The entire premise: elapsed time already measures "the event was running".
    // Presence must only move when a human is doing something, which is what the
    // header carries — so the negative half is the load-bearing one.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const u = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [comp.id], userIds: [u.id] } });
    const p = await enter(u.email, comp.id);

    // A background poll — no header. This is what a parked tab sends.
    await p.api.get("/api/status");
    expect(presenceRow(comp.id, u.id), "a tab nobody is looking at accrues nothing").toBeNull();

    // Now with the header.
    await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    const row = presenceRow(comp.id, u.id);
    expect(row, "an active request counts").toBeTruthy();
    expect(row.buckets).toBe(1);
  });

  test("repeat requests in the SAME bucket count once — idempotent by construction", async () => {
    // No read-then-write and no process-local map: the `WHERE last_bucket <
    // excluded` on the conflict branch is the whole mechanism.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const u = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [comp.id], userIds: [u.id] } });
    const p = await enter(u.email, comp.id);

    for (let i = 0; i < 8; i++) await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    expect(presenceRow(comp.id, u.id).buckets, "eight active requests inside one bucket are one bucket").toBe(1);
  });

  test("measure_presence OFF records nothing — and it is OFF by default", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf);           // no flag
    const list = await (await api.get("/api/admin/competitions")).json();
    expect(list.find(c => c.id === comp.id).measure_presence, "default OFF").toBeFalsy();

    const u = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [comp.id], userIds: [u.id] } });
    const p = await enter(u.email, comp.id);
    await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    expect(presenceRow(comp.id, u.id), "opt-in means opt-in").toBeNull();
  });

  test("THE COMPLETION FREEZE — a finisher stops accruing", async () => {
    // Without this, on a score tie the finisher who stays to read the board loses
    // to a slower finisher who closed the tab. There is a control below: the
    // SAME event, an UNfinished participant, who keeps accruing.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const taskId = await makeTask(api, csrf, comp.id);
    const done = await makeParticipant(api, csrf);
    const busy = await makeParticipant(api, csrf);
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { competitionIds: [comp.id], userIds: [done.id, busy.id] },
    });
    expect((await asg.json()).assigned).toBe(2);

    const pd = await enter(done.email, comp.id);
    const pb = await enter(busy.email, comp.id);
    // Both accrue their first bucket.
    await pd.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    await pb.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    const before = presenceRow(comp.id, done.id).buckets;
    expect(before).toBe(1);

    // One of them finishes everything.
    const view = await (await pd.api.get(`/api/tasks/${taskId}`)).json();
    const sub = await pd.api.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": pd.csrf }, multipart: { answer: "right", gradingHash: view.grading_hash || "" },
    });
    expect((await sub.json()).correct, "precondition: they finished").toBe(true);

    // Move both into a LATER bucket, then have both act again.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE competition_presence SET last_bucket = last_bucket - 5 WHERE competition_id=?").run(comp.id); }
    finally { db.close(); }

    await pd.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    await pb.api.get("/api/status", { headers: { "X-Client-Active": "1" } });

    expect(presenceRow(comp.id, done.id).buckets, "a FINISHER's clock has stopped").toBe(before);
    // THE CONTROL. Without it, "the finisher did not accrue" is equally satisfied
    // by a build where presence stopped working entirely.
    expect(presenceRow(comp.id, busy.id).buckets, "an UNfinished participant keeps accruing").toBe(2);
  });

  test("a non-member accrues nothing, even reaching the same endpoint", async () => {
    // Membership is enforced by the write's own SELECT rather than by middleware
    // ordering — `/api/status` does not carry the membership guard, and that
    // guard `return next()`s for staff before any membership read.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const member = await makeParticipant(api, csrf);
    const outsider = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [comp.id], userIds: [member.id] } });

    const p = await enter(member.email, comp.id);
    await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    expect(presenceRow(comp.id, member.id), "the member accrues").toBeTruthy();
    expect(presenceRow(comp.id, outsider.id), "a non-member has no row at all").toBeNull();
  });

  test("a Booth Event REFUSES to record — the window is too short for the bucket to mean anything", async () => {
    // Nine buckets over 45 minutes means two attendees present throughout both
    // score nine and fall through to userId lex order: quantisation noise
    // dressed up as a measurement.
    const { api, csrf } = await sa();
    const r = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `${uniq()} Booth`, event_kind: "booth", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
        measure_presence: true,
      },
    });
    expect(r.status(), `must be refused: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/Booth Event/);
    expect(body.error, "the stored value never surfaces").not.toMatch(/\bbooth\b/);

    // THE CONTROL — a Competition and a Program may both record.
    for (const kind of ["tournament", "program"]) {
      const ok = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: {
          name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
          start_time: new Date(Date.now() - 3600e3).toISOString(),
          ...(kind === "program" ? { deadline_at: new Date(Date.now() + 86400e3).toISOString() } : { duration_minutes: 600 }),
          measure_presence: true,
        },
      });
      expect(ok.status(), `${kind} may record: ${await ok.text()}`).toBe(200);
    }
  });
});

test.describe("v8.1.0 — net active time, the read path", () => {
  test("presence is ADMIN-ONLY — the participant board never carries it", async () => {
    // Structural, not a name list: a lock naming the five public fields passes
    // while a leak arrives under an `_`-prefixed one (the v7.28.0 rule).
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    await makeTask(api, csrf, comp.id);
    const a = await makeParticipant(api, csrf);
    const b = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [comp.id], userIds: [a.id, b.id] } });
    const pa = await enter(a.email, comp.id);
    await pa.api.get("/api/status", { headers: { "X-Client-Active": "1" } });

    const board = await (await pa.api.get("/api/leaderboard")).json();
    const entries = board.board || [];
    expect(entries.length, "somebody is on the board").toBeGreaterThan(0);
    for (const e of entries) {
      for (const k of Object.keys(e)) {
        expect(k.startsWith("_"), `participant entry must carry no internal field (${k})`).toBe(false);
      }
      expect(e).not.toHaveProperty("presenceMs");
      expect(e).not.toHaveProperty("elapsedMs");
    }

    // ...and the ADMIN board DOES carry it, or "absent from the participant
    // board" is satisfied by a build where the field never exists.
    const adminBoard = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const rows = Array.isArray(adminBoard) ? adminBoard : (adminBoard.board || []);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("presenceMs");
    expect(rows[0]).toHaveProperty("elapsedMs");
  });

  test("the tie-break ranks on presence ONLY among finishers, and only when asked", async () => {
    // The one-way door. For a NON-finisher, elapsed runs to the event end for
    // everybody, so presence would be the only separator — and LOWER would win,
    // ranking the participant who barely turned up above the one who worked for
    // hours and still did not finish.
    const { presenceMsByUser } = require("../lib/presence");
    expect(typeof presenceMsByUser, "the batched read exists").toBe("function");

    // Driven at the comparator, because manufacturing two same-score finishers
    // with different presence through the API needs clock control the suite does
    // not have — and the comparator IS the rule.
    const { sortLeaderboard } = require("../lib/leaderboard");
    const mk = (id, allSolved, presence, solve) =>
      ({ userId: id, score: 100, allSolved, _presenceMs: presence, solveTimeMs: solve });

    // Two finishers, identical score and elapsed, different presence.
    const finishers = sortLeaderboard([mk("b", true, 60_000, 5000), mk("a", true, 30_000, 5000)], true);
    expect(finishers[0].userId, "the more efficient finisher wins").toBe("a");
    // ...and with the basis OFF the pair falls back to the userId tie-break.
    const off = sortLeaderboard([mk("b", true, 60_000, 5000), mk("a", true, 30_000, 5000)], false);
    expect(off[0].userId, "opt-in means opt-in").toBe("a");   // lex order, not presence
    const offRev = sortLeaderboard([mk("z", true, 10_000, 5000), mk("a", true, 90_000, 5000)], false);
    expect(offRev[0].userId, "with the basis off, presence is ignored entirely").toBe("a");

    // A NON-finisher pair is never ranked on presence, even with the basis on.
    const unfinished = sortLeaderboard([mk("z", false, 10_000, 5000), mk("a", false, 90_000, 5000)], true);
    expect(unfinished[0].userId, "presence must not rank non-finishers").toBe("a");
    // A MIXED pair is never ranked on PRESENCE either — that is this test's
    // subject and it is unchanged. What v8.3.11 changed is what decides it
    // instead: the FINISHER now wins outright.
    //
    // WHY THAT HAD TO CHANGE, because this line used to assert the opposite.
    // Ordering a finisher pair on presence while ordering every pair touching a
    // non-finisher on elapsed made the comparator NON-TRANSITIVE: a non-finisher
    // whose elapsed lands between two finishers' closes a three-row cycle, and
    // `buildLeaderboardEntries`' users query has no ORDER BY, so the resolved
    // order was SQLite's and got frozen into `achievement_badges.rank` and the
    // group-board snapshot. Partitioning on a per-row property is what restores a
    // strict weak ordering. See lib/leaderboard.js and tests/presence-display.spec.js
    // ("the ranking comparators are strict weak orderings").
    //
    // The fixture is chosen so NEITHER old rule would pick the finisher: `z` has
    // the HIGHER presence (10_000 vs 90_000 is the other way round, so make it so)
    // and loses the id tie-break. Only the partition can produce this answer.
    const mixed = sortLeaderboard([mk("z", true, 90_000, 5000), mk("a", false, 10_000, 5000)], true);
    expect(mixed[0].userId,
      "on a presence-ranked event a score-tied FINISHER outranks a non-finisher, " +
      "even with more presence and a losing id tie-break"
    ).toBe("z");
    // THE CONTROL: with the basis OFF the same pair falls through exactly as it
    // always did, so the partition is scoped to events that opted in.
    const mixedOff = sortLeaderboard([mk("z", true, 90_000, 5000), mk("a", false, 10_000, 5000)], false);
    expect(mixedOff[0].userId, "with the basis off, a mixed pair still uses elapsed then id").toBe("a");
  });

  test("the participant is TOLD, on the event that records — and only there", async ({ page }) => {
    // Rendered per event because the recording is gated per event: a blanket
    // privacy notice would be false on every event that does not record, and an
    // absent one would be a silent measurement.
    const { api, csrf } = await sa();
    const recording = await makeEvent(api, csrf, { measure_presence: true });
    const quiet = await makeEvent(api, csrf);
    await makeTask(api, csrf, recording.id);
    await makeTask(api, csrf, quiet.id);
    const u = await makeParticipant(api, csrf);
    const other = await makeParticipant(api, csrf);   // never solves → no auto-end
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { competitionIds: [recording.id, quiet.id], userIds: [u.id, other.id] },
    });
    // `assigned` counts (participant x event) PAIRS, not participants — two of
    // each here. Asserted because the assign endpoint silently SKIPS ineligible
    // users, so a precondition that quietly did nothing would surface much later
    // as an empty page.
    expect((await asg.json()).assigned, "2 participants x 2 events").toBe(4);

    // Establish the session BEFORE navigating (v7.21.26).
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, u.email, H(csrfToken));
    const pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;

    await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: recording.id } });
    await page.goto("/");
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    // VISIBLE, not merely present. `toContainText` reads textContent and passes
    // on a `hidden` element, so a build that never shows the note satisfies it —
    // measured: that mutation passed until this became toBeVisible.
    await expect(page.locator("#presence-note"), "the recording event says so")
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator("#presence-note"))
      .toContainText(/records how much time you spend/i);

    // THE CONTROL — the other event does NOT claim it. Without this, "the notice
    // is shown" is equally satisfied by one that is always on, which would be a
    // false statement on every event that does not record.
    await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: quiet.id } });
    await page.reload();
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#presence-note"), "an event that does not record says nothing").toBeHidden();
  });

  test("/metrics reports the presence table", async () => {
    const { api } = await sa();
    const body = await (await api.get("/metrics")).text();
    expect(body).toMatch(/hack_arena_presence_rows \d+/);
  });
});

// ── v8.1.0 — the desk fallback, the at-desk shortcut, and the one-credential rule ──
test.describe("v8.1.0 — at the desk", () => {
  test("desk-invite creates a usable walk-up and hands over a code, with NO email", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf);
    const email = `${uniq()}@company.example`;
    const r = await api.post("/api/admin/participants/desk-invite", {
      headers: H(csrf), data: { email, competitionId: comp.id },
    });
    expect(r.status(), `desk-invite: ${await r.text()}`).toBe(200);
    const d = await r.json();
    // Grouped for reading ALOUD across a desk.
    expect(d.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    // The account is immediately usable: verified, approved, in the event, and
    // PASSWORDLESS — which is what makes it code-eligible at all.
    const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email);
    expect(u, "the account exists").toBeTruthy();
    expect(u.verified, "verified — the organiser IS the identity check").toBeTruthy();
    expect(u.approved, "approved — they are standing right there").toBeTruthy();
    expect(u.can_use_code, "and it has NO password, so a code works").toBe(1);

    // THE CODE ACTUALLY SIGNS THEM IN. Without this, "a code was returned" is
    // satisfied by a string the redeem endpoint refuses.
    const { api: p, csrf: pc } = await freshCtx();
    const redeem = await p.post("/api/auth/code/redeem", {
      headers: H(pc), data: { email, code: d.code },
    });
    expect(redeem.status(), "200-always, even on success").toBe(200);
    expect((await redeem.json()).ok, "the code the desk read out works").toBe(true);
    const me = await (await p.get("/api/me")).json();
    expect(me.email, "and they are signed in as themselves").toBe(email);
    await p.dispose();
  });

  test("desk-invite still requires a work email, and refuses a duplicate", async () => {
    // The corporate-email rule is enforced on every registration path; a desk
    // shortcut that dropped it would be the easiest way around it on the platform.
    const { api, csrf } = await sa();
    const free = await api.post("/api/admin/participants/desk-invite", {
      headers: H(csrf), data: { email: `${uniq()}@gmail.com` },
    });
    expect(free.status(), "a personal address is refused").toBe(400);
    expect((await free.json()).error).toMatch(/work email/i);

    const email = `${uniq()}@company.example`;
    expect((await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } })).status()).toBe(200);
    const dup = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
    expect(dup.status(), "and a second attempt names the remedy").toBe(409);
    expect((await dup.json()).error).toMatch(/Show sign-in code/i);
  });



  test("the admin list says which accounts can use a code", async () => {
    // The row action is gated on this, and the server re-checks it — so the
    // affordance is never offered where it would be refused.
    const { api, csrf } = await sa();
    const walkup = await (await api.post("/api/admin/participants/desk-invite", {
      headers: H(csrf), data: { email: `${uniq()}@company.example` },
    })).json();
    // Every account signs in with codes now; the one an organiser cannot hand a
    // code to is an inactive one. Blocking toggles, so assert it took.
    const blocked = await makeParticipant(api, csrf);
    const bl = await api.post(`/api/admin/participants/${blocked.id}/block`, { headers: H(csrf) });
    expect(bl.ok(), `block: ${bl.status()}`).toBeTruthy();
    expect((await bl.json()).blocked, "PRECONDITION: the block took").toBe(1);

    const list = await (await api.get("/api/admin/participants?limit=1000")).json();
    const byId = Object.fromEntries(list.participants.map(p => [p.id, p]));
    expect(byId[walkup.id].can_use_code, "a walk-up can").toBe(1);
    expect(byId[blocked.id].can_use_code, "a blocked account cannot").toBe(0);
    expect(byId[blocked.id].code_blocked_reason, "and the row says why").toBe("account_inactive");
  });

  test("the admin list reports RECORDING and the active count, only for events that measure", async () => {
    const { api, csrf } = await sa();
    const recording = await makeEvent(api, csrf, { measure_presence: true });
    const quiet = await makeEvent(api, csrf);
    const u = await makeParticipant(api, csrf);
    await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { competitionIds: [recording.id], userIds: [u.id] } });
    const p = await enter(u.email, recording.id);
    await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });

    const list = await (await api.get("/api/admin/competitions")).json();
    const rec = list.find(c => c.id === recording.id);
    const qui = list.find(c => c.id === quiet.id);
    expect(rec.presence_active_recent, "one participant active in the last hour").toBe(1);
    // ABSENT, not zero: "does not measure" and "measures, nobody active" are
    // different facts and the pill must be able to tell them apart.
    expect(Object.prototype.hasOwnProperty.call(qui, "presence_active_recent"),
      "an event that does not record carries no count at all").toBe(false);
  });
});
