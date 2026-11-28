// @ts-check
//
// v7.27.0 — WHAT `navigated_away` MEANS, AND WHAT IT MUST NOT COUNT.
//
// The signal exists to find challenges participants BOUNCE OFF (the wording of
// the commit that introduced it, e764ec1), and swagger has said "leaves a
// challenge detail view WITHOUT SUBMITTING" since that same commit. Two things
// contradicted that from day one:
//
//   1. SOLVING emitted one. A correct submit ends `showCongrats -> loadTasks ->
//      showMain('tasks-page')`, and showMain is the departure hook — with
//      `_openedTaskId` still set, because fireNavigatedAway was its only other
//      writer. Measured before the fix: a `solved` row followed ~285 ms later by
//      a `navigated_away` for the same (user, task). Every solve produced one,
//      so `navigated_away >= solved` for any competition played through the UI.
//   2. RE-OPENING a solved challenge to review it emitted another, every time.
//
// Both are refused now — by the client on the solve path, and decisively by the
// `already_solved` gate in routes/participant.js, which is what makes the rule
// true for a second tab, a stale page, or a scripted caller.
//
// The same investigation found the mirror-image defect: the FIRST tab-hide
// nulled `_openedTaskId` for good, so every later switch reported nothing and
// the eventual real departure was never recorded at all. One Alt-Tab silenced
// the challenge for the rest of its life. Returning to a still-open detail view
// now re-arms it.
//
// WHY THESE TESTS LOOK LIKE THIS — the vacuity traps that bit while writing them:
//
//   * Every suppression assertion carries a POSITIVE CONTROL. "Zero rows" is
//     equally satisfied by a build where navigated_away never works at all, so
//     each one is paired with a case that MUST still record.
//   * Both refusals answer 200 (`deduped` / `skipped`), because a non-429 4xx
//     feeds the scanner-reputation counter that can lock out a whole venue
//     (v7.21.24). So a test may never infer suppression from the status code —
//     it reads the body and counts rows.
//   * The re-arm test drives the app's OWN visibilitychange handler. Whether
//     Chromium fires that event for a backgrounded Playwright page is not the
//     subject; what `_openedTaskId` does when it fires is.
//   * The fixture never lets one participant solve every published challenge —
//     that would trip the all-solved auto-end and change the lifecycle under the
//     test (CLAUDE.md competition-fixture checklist).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { fillBreakGlass, submitLogin } = require("./ui-admin-helpers");
const { freshCtx, apiLogin, gradingHashFor, PARTICIPANT_PASS, BASE, TEST_DB_PATH } = require("./helpers");
const { withLegacySharedAssign } = require("./event-admin-helpers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

/** navigated_away rows for one (user, task), newest last. */
function navRows(userId, taskId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(
      "SELECT competition_id, details, occurred_at, impersonated FROM challenge_events"
      + " WHERE user_id=? AND task_id=? AND event_type='navigated_away' ORDER BY occurred_at ASC"
    ).all(userId, taskId);
  } finally { db.close(); }
}

async function mkParticipant(sa, csrf, nick) {
  const email = `nav_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Nav", lastName: "Probe", nickname: nick, email, company: "Acme Ltd",
    title: "Eng", country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
    jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), await reg.text()).toBeLessThan(400);
  await anon.dispose();
  const u = (await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  expect(u, `participant ${nick} must exist`).toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email, nick };
}

async function mkComp(sa, csrf, name) {
  const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
  }});
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).competition.id;
}

async function mkTask(sa, csrf, title, compIds) {
  const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
    correct_answer: "right", explanation: "<p>e</p>", hint: "a hint", status: "published",
  }});
  expect(r.status(), await r.text()).toBe(200);
  const id = (await r.json()).id;
  const a = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: compIds } });
  expect(a.status(), await a.text()).toBe(200);
  // One event: the question it holds, its OWN copy (lib/event-copies.js). Several
  // (only under the previous model's mode, below): the one row they all hold.
  const copies = (await a.json()).copies || [];
  return compIds.length === 1 ? copies[0].task_id : id;
}

// ═══════════════════════════════════════════════════════════════════════════
// Server gate — the authoritative half
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.27.0 — a SOLVED challenge records no navigated_away", () => {
  test("solved is refused with skipped:already_solved; an UNSOLVED sibling still records", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = uniq();
    const compId = await mkComp(sa, csrf, `NavGate ${t}`);
    const solvedTask = await mkTask(sa, csrf, `Gate-solved ${t}`, [compId]);
    const openTask = await mkTask(sa, csrf, `Gate-open ${t}`, [compId]);
    const p = await mkParticipant(sa, csrf, `g1${t}`);
    // A second enrolled participant who never solves, so the all-solved auto-end
    // cannot fire and end the competition under the test.
    const idle = await mkParticipant(sa, csrf, `g1i${t}`);
    const asg = await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id, idle.id], competitionIds: [compId] } });
    expect((await asg.json()).assigned, "both must enrol").toBe(2);

    const { api, csrf: c } = await apiLogin(p.email, PARTICIPANT_PASS);
    expect((await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } })).ok()).toBeTruthy();

    const sub = await api.post(`/api/tasks/${solvedTask}/submit`, {
      headers: H(c), data: { answer: "right", gradingHash: await gradingHashFor(api, solvedTask) } });
    expect(sub.status(), await sub.text()).toBe(200);
    expect((await sub.json()).correct, "fixture: the submit must actually SOLVE it").toBe(true);

    // The whole point.
    const refused = await api.post(`/api/tasks/${solvedTask}/navigated-away`, { headers: H(c), data: { via: "spa_nav" } });
    expect(refused.status(), "must stay 200 — a 4xx here feeds the scanner-reputation counter").toBe(200);
    expect((await refused.json()).skipped).toBe("already_solved");
    expect(navRows(p.id, solvedTask), "a solved challenge records nothing").toHaveLength(0);

    // POSITIVE CONTROL — without this, "zero rows" is satisfied by a build in
    // which navigated_away never works at all.
    const ok = await api.post(`/api/tasks/${openTask}/navigated-away`, { headers: H(c), data: { via: "spa_nav" } });
    expect(ok.status()).toBe(200);
    const okBody = await ok.json();
    expect(okBody.skipped, "an unsolved challenge must NOT be refused").toBeFalsy();
    expect(okBody.deduped).toBeFalsy();
    expect(navRows(p.id, openTask), "an unsolved challenge still records").toHaveLength(1);

    // And it stays refused however many times it is retried.
    for (let i = 0; i < 3; i++) {
      const again = await api.post(`/api/tasks/${solvedTask}/navigated-away`, { headers: H(c), data: { via: "spa_nav" } });
      expect((await again.json()).skipped).toBe("already_solved");
    }
    expect(navRows(p.id, solvedTask), "re-opening a solved challenge to review it records nothing either").toHaveLength(0);
    await api.dispose();
  });

  test("a PRE-solve navigated_away is kept — bouncing then coming back to solve is the signal", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = uniq();
    const compId = await mkComp(sa, csrf, `NavPre ${t}`);
    const taskId = await mkTask(sa, csrf, `Pre ${t}`, [compId]);
    await mkTask(sa, csrf, `Pre-other ${t}`, [compId]);   // keeps all-solved from firing
    const p = await mkParticipant(sa, csrf, `g2${t}`);
    expect((await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [compId] } })).json()).assigned).toBe(1);

    const { api, csrf: c } = await apiLogin(p.email, PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } });

    const before = await api.post(`/api/tasks/${taskId}/navigated-away`, { headers: H(c), data: { via: "spa_nav" } });
    expect((await before.json()).skipped, "pre-solve must be recorded").toBeFalsy();
    expect(navRows(p.id, taskId)).toHaveLength(1);

    const sub = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: H(c), data: { answer: "right", gradingHash: await gradingHashFor(api, taskId) } });
    expect((await sub.json()).correct).toBe(true);

    // The gate is not retroactive at the API level: the earlier bounce survives.
    expect(navRows(p.id, taskId), "the pre-solve bounce must survive the solve").toHaveLength(1);
    await api.dispose();
  });

  test("the gate is COMPETITION-scoped — solving in one competition does not silence another", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = uniq();
    const compA = await mkComp(sa, csrf, `NavScope A ${t}`);
    const compB = await mkComp(sa, csrf, `NavScope B ${t}`);
    // ONE challenge, assigned to BOTH. This is the only arrangement in which a
    // gate that forgot its competition predicate differs from one that has it.
    // (One row in both events exists only in a database from before event-owned
    // copies, so it is built in the previous model's mode, through the test hook.)
    const shared = await withLegacySharedAssign(sa, csrf, () => mkTask(sa, csrf, `Shared ${t}`, [compA, compB]));
    await mkTask(sa, csrf, `Filler A ${t}`, [compA]);
    await mkTask(sa, csrf, `Filler B ${t}`, [compB]);
    const p = await mkParticipant(sa, csrf, `g3${t}`);
    // `assigned` counts (user x competition) pairs, so one participant into two
    // competitions is 2 — and both enrolments are load-bearing here.
    expect((await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [compA, compB] } })).json()).assigned).toBe(2);

    const { api, csrf: c } = await apiLogin(p.email, PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compA } });
    const sub = await api.post(`/api/tasks/${shared}/submit`, {
      headers: H(c), data: { answer: "right", gradingHash: await gradingHashFor(api, shared) } });
    expect((await sub.json()).correct).toBe(true);
    expect((await (await api.post(`/api/tasks/${shared}/navigated-away`, { headers: H(c), data: { via: "spa_nav" } })).json()).skipped)
      .toBe("already_solved");

    // Same task, other competition, unsolved there.
    await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compB } });
    const inB = await api.post(`/api/tasks/${shared}/navigated-away`, { headers: H(c), data: { via: "spa_nav" } });
    expect(inB.status()).toBe(200);
    expect((await inB.json()).skipped, "unsolved in THIS competition — must record").toBeFalsy();

    const rows = navRows(p.id, shared);
    expect(rows, "exactly one row, and it belongs to competition B").toHaveLength(1);
    expect(rows[0].competition_id).toBe(compB);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Client — the reported symptom, driven through the real UI
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.27.0 — the browser does not report a departure on the solve path", () => {
  test("solving through the UI writes NO navigated_away; a genuine departure still does", async ({ page }) => {
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = uniq();
    const compId = await mkComp(sa, csrf, `NavUI ${t}`);
    const solveMe = await mkTask(sa, csrf, `UIsolve ${t}`, [compId]);
    const leaveMe = await mkTask(sa, csrf, `UIleave ${t}`, [compId]);
    const p = await mkParticipant(sa, csrf, `u1${t}`);
    const idle = await mkParticipant(sa, csrf, `u1i${t}`);
    expect((await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id, idle.id], competitionIds: [compId] } })).json()).assigned).toBe(2);

    // THE CLIENT HALF NEEDS ITS OWN WITNESS. Row counts cannot see it: the
    // server gate refuses a solved challenge independently, so deleting the
    // clearOpenTask() call on the solve path leaves every DB assertion in this
    // file green (measured). The only client-observable difference is whether
    // the browser SENDS the request at all.
    const posted = [];
    page.on("request", (r) => {
      const m = /\/api\/tasks\/([^/]+)\/navigated-away$/.exec(r.url());
      if (m) posted.push(decodeURIComponent(m[1]));
    });

    await page.goto("/");
    await page.waitForSelector("#login-email", { timeout: 20000 });
    await page.fill("#login-email", p.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);
    // doLogin auto-selects when there is exactly one competition.
    await page.waitForSelector("#task-grid .task-card", { timeout: 30000 });

    // ── the reported case: open a challenge, solve it, get bounced to the list ──
    await page.locator(`.task-card:has-text("UIsolve ${t}")`).first().click();
    await page.waitForSelector("#ans-text", { timeout: 20000 });
    await page.fill("#ans-text", "right");
    await page.locator("[data-action='task-submit-answer']").first().click();
    await page.locator("#modal-overlay button:has-text('Submit')").first().click();
    const cont = page.locator("button:has-text('Continue')").last();   // showCongrats (ui/toast.js)
    await cont.waitFor({ state: "visible", timeout: 20000 });
    await cont.click();
    await page.waitForSelector("#tasks-page.active", { timeout: 20000 });
    await page.waitForTimeout(1500);   // any stray request would have landed by now

    expect(navRows(p.id, solveMe), "solving is not leaving").toHaveLength(0);
    expect(posted, "the client must not even SEND a departure for the challenge it just solved").toEqual([]);

    // ── POSITIVE CONTROL: an UNSOLVED challenge left by hand still records ──
    await page.locator(`.task-card:has-text("UIleave ${t}")`).first().click();
    await page.waitForSelector("#task-detail-page.active", { timeout: 20000 });
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await expect.poll(() => navRows(p.id, leaveMe).length, {
      timeout: 8000, intervals: [100, 200, 400, 800],
      message: "a real departure from an UNSOLVED challenge must still be recorded",
    }).toBe(1);
    // …and the request-level control, so "posted is empty" above cannot be
    // satisfied by a build that never sends one.
    expect(posted, "a genuine departure DOES send exactly one request").toEqual([leaveMe]);

    // ── and reviewing the SOLVED one afterwards still records nothing ──
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    await page.waitForSelector("#task-grid", { timeout: 20000 });
    // The list forces the Unsolved filter while the competition is live.
    await page.locator("#solve-filters .filter-btn[data-filter='all']").click();
    await page.locator(`.task-card:has-text("UIsolve ${t}")`).first().click();
    await page.waitForSelector("#task-detail-page.active", { timeout: 20000 });
    await page.waitForTimeout(2500);            // clear of the 2 s dedup window
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await page.waitForTimeout(1500);
    expect(navRows(p.id, solveMe), "reviewing a solved challenge records nothing").toHaveLength(0);
  });

  test("returning to a still-open challenge RE-ARMS it, so the real departure is still counted", async ({ page }) => {
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = uniq();
    const compId = await mkComp(sa, csrf, `NavArm ${t}`);
    const taskId = await mkTask(sa, csrf, `Arm ${t}`, [compId]);
    await mkTask(sa, csrf, `Arm-other ${t}`, [compId]);
    const p = await mkParticipant(sa, csrf, `u2${t}`);
    expect((await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [compId] } })).json()).assigned).toBe(1);

    await page.goto("/");
    await page.waitForSelector("#login-email", { timeout: 20000 });
    await page.fill("#login-email", p.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);
    await page.waitForSelector("#task-grid .task-card", { timeout: 30000 });
    await page.locator(`.task-card:has-text("Arm ${t}")`).first().click();
    await page.waitForSelector("#ans-text", { timeout: 20000 });

    // Drive the app's OWN handler. Whether headless Chromium backgrounds a page
    // is not the subject; what _openedTaskId does when visibilitychange fires is.
    const setHidden = (h) => page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, h);

    await setHidden(true);
    await expect.poll(() => navRows(p.id, taskId).length, { timeout: 8000, intervals: [100, 200, 400] }).toBe(1);

    // Back on the same challenge — this is the re-arm.
    await setHidden(false);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window._openedTaskId), "returning must re-arm the open challenge").toBe(taskId);

    // A SECOND switch, spaced past the 2 s server dedup, must be counted too.
    await page.waitForTimeout(2400);
    await setHidden(true);
    await expect.poll(() => navRows(p.id, taskId).length, {
      timeout: 8000, intervals: [100, 200, 400],
      message: "pre-fix the first hide nulled _openedTaskId for good, so this second switch reported nothing",
    }).toBe(2);

    // …and so must the eventual REAL departure — the one the old code lost entirely.
    await setHidden(false);
    await page.waitForTimeout(2400);
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await expect.poll(() => navRows(p.id, taskId).length, {
      timeout: 8000, intervals: [100, 200, 400],
      message: "the genuine departure after a tab switch must still be recorded",
    }).toBe(3);
  });

  test("the re-arm cannot fire for a challenge the participant has LEFT", async ({ page }) => {
    // Guards the other direction: rearmOpenTask keys on the active page, so a
    // stale resume id must never put a closed challenge back under observation.
    test.setTimeout(120_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    const t = uniq();
    const compId = await mkComp(sa, csrf, `NavStale ${t}`);
    const taskId = await mkTask(sa, csrf, `Stale ${t}`, [compId]);
    await mkTask(sa, csrf, `Stale-other ${t}`, [compId]);
    const p = await mkParticipant(sa, csrf, `u3${t}`);
    expect((await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [compId] } })).json()).assigned).toBe(1);

    await page.goto("/");
    await page.waitForSelector("#login-email", { timeout: 20000 });
    await page.fill("#login-email", p.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);
    await page.waitForSelector("#task-grid .task-card", { timeout: 30000 });
    await page.locator(`.task-card:has-text("Stale ${t}")`).first().click();
    await page.waitForSelector("#task-detail-page.active", { timeout: 20000 });

    // Leave by hand — one row, and _openedTaskId is cleared.
    await page.locator("#nav-leaderboard:not([aria-disabled=true])").click();
    await expect.poll(() => navRows(p.id, taskId).length, { timeout: 8000, intervals: [100, 200, 400] }).toBe(1);

    // Now hide/show the tab while on the LEADERBOARD. The resume id is stale.
    await page.waitForTimeout(2400);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window._openedTaskId), "no challenge is open — nothing to re-arm").toBeFalsy();
    expect(navRows(p.id, taskId), "a stale resume id must not manufacture a departure").toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The one-time backfill, driven against the REAL migration in db.js
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.27.0 — historical post-solve rows are backfilled away", () => {
  test("the boot migration removes at-or-after-solve rows and keeps everything else", () => {
    const Database = require("better-sqlite3");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navaway-backfill-"));
    // db.js is self-contained (better-sqlite3 / path / fs / crypto / uuid only —
    // no lib/config, so no BASE_URL), which is what lets the migration be driven
    // in a throwaway DATA_DIR instead of against a spawned server.
    const bootDb = () => execFileSync(process.execPath, ["-e", "require('./db.js')"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATA_DIR: tmp, UPLOADS_DIR: `${tmp}/uploads`, NODE_OPTIONS: "" },   // v7.15.30 — never inherit node flags into a spawned child
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();

    try {
      bootDb();                       // create the schema (and mark the backfill done)
      const dbPath = path.join(tmp, "hackathon.db");
      const db = new Database(dbPath);
      // better-sqlite3 turns foreign keys ON per connection. `submissions`
      // references users(id) and tasks(id), and creating faithful parent rows
      // would add a dozen NOT NULL columns that the DELETE under test never
      // reads — it joins submissions to challenge_events and nothing else.
      // Off for fixture construction only; the migration runs in its own process.
      db.pragma("foreign_keys = OFF");
      const ev = (id, user, task, comp, type, at) => db.prepare(
        "INSERT INTO challenge_events (id,user_id,task_id,competition_id,timeslot_id,event_type,details,occurred_at,impersonated) VALUES (?,?,?,?,NULL,?,NULL,?,0)"
      ).run(id, user, task, comp, type, at);
      const sub = (id, user, task, comp, correct, at) => db.prepare(
        "INSERT INTO submissions (id,user_id,task_id,competition_id,timeslot_id,answer,is_correct,points_delta,submitted_at,updated_at) VALUES (?,?,?,?,NULL,'a',?,0,?,?)"
      ).run(id, user, task, comp, correct, at, at);

      const T0 = "2026-01-01T10:00:00.000Z";
      const T1 = "2026-01-01T10:05:00.000Z";   // the solve
      const T2 = "2026-01-01T10:09:00.000Z";

      sub("s1", "u1", "t1", "c1", 1, T1);
      ev("e-pre",   "u1", "t1", "c1", "navigated_away", T0);  // BEFORE the solve — a real bounce, keep
      ev("e-post",  "u1", "t1", "c1", "navigated_away", T2);  // after the solve — remove
      ev("e-exact", "u1", "t1", "c1", "navigated_away", T1);  // the boundary, at the solve — remove
      ev("e-solved","u1", "t1", "c1", "solved",         T1);  // a different event type — never touched

      sub("s2", "u1", "t1", "c2", 0, T1);                     // WRONG in c2…
      ev("e-othercomp", "u1", "t1", "c2", "navigated_away", T2); // …so this survives (competition scope)

      sub("s3", "u2", "t1", "c1", 1, T1);                     // another user solved…
      ev("e-otheruser", "u3", "t1", "c1", "navigated_away", T2); // …must not delete u3's row

      db.prepare("DELETE FROM settings WHERE key='navaway_solved_backfill_at'").run();
      db.close();

      const out = bootDb();
      const after = new Database(dbPath, { readonly: true });
      const ids = after.prepare("SELECT id FROM challenge_events ORDER BY id").all().map(r => r.id);
      const marker = after.prepare("SELECT value FROM settings WHERE key='navaway_solved_backfill_at'").get();
      const removed = after.prepare("SELECT value FROM settings WHERE key='navaway_solved_backfill_removed'").get();
      after.close();

      expect(ids.sort(), "only at-or-after-solve rows for the SAME (user, task, competition) go")
        .toEqual(["e-othercomp", "e-otheruser", "e-pre", "e-solved"].sort());
      expect(marker, "the run must be marked so it does not repeat").toBeTruthy();
      expect(removed && removed.value).toBe("2");
      expect(out, "a non-zero removal is reported").toContain("navigated_away backfill");

      // Idempotent: a second boot with the marker present changes nothing.
      const out2 = bootDb();
      const again = new Database(dbPath, { readonly: true });
      const ids2 = again.prepare("SELECT id FROM challenge_events ORDER BY id").all().map(r => r.id);
      again.close();
      expect(ids2.sort()).toEqual(ids.sort());
      expect(out2, "a marked database must not re-run the backfill").not.toContain("navigated_away backfill");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
