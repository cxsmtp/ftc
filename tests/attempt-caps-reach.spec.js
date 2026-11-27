// v8.1.4 — the attempt-cap feature an operator could not REACH, and two things
// it reported wrongly.
//
// Three shipped strings — the exhausted panel's "Ask an organiser if you need
// another try", the exhausted-refusal toast, and the competition form's own hint
// — promised a remedy that existed only as a raw endpoint:
// `POST /api/admin/tasks/:id/attempt-grant` had ZERO client callers. An organiser
// at a desk, sent there by the participant's own screen, had no screen to help
// from. The same release's recalculate returned `attempts_exhausted_after` /
// `attempts_exhausted_who` that nothing read, and computed them over a population
// far wider than what the run had actually caused.
//
// FIXTURE DISCIPLINE (checklist items 1-3): every test owns its event, its
// challenges and its participants, and every capped fixture enrols a SECOND
// participant who never submits, so the all-solved auto-end cannot end the event
// underneath an assertion.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { adminLogin, clickTab, findSeededTaskRow, openKebab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ar${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

/** A superadmin API context of its own. Never used alongside `adminLogin(page)`
 *  for the same principal in one test — two sessions for one account trip the
 *  single-session rule and silently kill the first (v7.19.0). */
async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** Take a fresh CSRF token off any request context. */
const tok = async (api) => (await (await api.get("/api/csrf-token")).json()).csrfToken;

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Reach", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  // `approve` REFUSES an unverified account, so the order is not optional.
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify ${label}: ${await v.text()}`).toBeTruthy();
  const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(a.ok(), `approve ${label}: ${await a.text()}`).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

async function makeEvent(api, csrf, { kind = "tournament", cap = null, name = null, minutes = 600, startMs = -3600e3 } = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: name || `${uniq()} Ev`, event_kind: kind,
      start_time: new Date(Date.now() + startMs).toISOString(),
      duration_minutes: minutes, timezone: "UTC",
      ...(cap === null ? {} : { attempt_cap: cap }),
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function makeTask(api, csrf, { cap = null, answer_type = "text", correct = "right", tags = [] } = {}) {
  const title = `${uniq()} T`;
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: {
      title, description: "d", difficulty: "easy", answer_type, correct_answer: correct, status: "published",
      ...(cap === null ? {} : { attempt_cap: cap }),
    },
  });
  expect(r.ok(), `create task: ${await r.text()}`).toBeTruthy();
  // Take the id the create RETURNS — resolving by title matches a challenge an
  // earlier test in this same file made (the v8.1.0 fixture trap).
  const { id } = await r.json();
  expect(id, "the create returns the new challenge's id").toBeTruthy();
  for (const t of tags) {
    const tr = await api.post(`/api/admin/tasks/${id}/tags`, { headers: H(csrf), data: { tag: t } });
    expect(tr.ok(), `tag ${t}: ${await tr.text()}`).toBeTruthy();
  }
  return { id, title };
}

async function assignTask(api, csrf, taskId, compIds) {
  const r = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: compIds } });
  expect(r.ok(), `assign challenge: ${await r.text()}`).toBeTruthy();
}

async function enrol(api, csrf, users, compId) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [compId] },
  });
  expect(r.ok(), `enrol: ${await r.text()}`).toBeTruthy();
  // The assign endpoint SILENTLY SKIPS staff / benchmark / blocked / unapproved
  // users, so a skipped precondition would otherwise surface much later as an
  // empty roster in the grant dialog.
  expect((await r.json()).assigned, "everybody was really enrolled").toBe(users.length);
}

/** Sign a participant in on their own context and put them in the event. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = await tok(api);
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/** One submission through the real path. The grading token is REQUIRED since
 *  v7.20.9 F1 — a submit without one is 409 `task_changed` before the cap is
 *  ever examined, so a probe that omitted it would measure the wrong refusal. */
async function submit(api, csrf, taskId, answer) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** The newest toast's text, captured ONCE and returned as a STRING.
 *
 *  Toasts self-dismiss — 4 s for a success, 6-15 s for an error scaled by length
 *  — so a pair of `expect(locator)` assertions about one toast can straddle its
 *  removal, and the second then fails on a missing element rather than on its own
 *  claim. Capturing the string first makes every later assertion about the
 *  MESSAGE, which is what these tests are actually asserting. */
async function lastToast(page, re) {
  let text = "";
  await expect.poll(async () => {
    text = await page.evaluate(() => {
      const all = [...document.querySelectorAll("#toast-stack .toast")];
      return all.length ? (all[all.length - 1].textContent || "").trim() : "";
    });
    return text;
  }, { timeout: 20000, intervals: [100, 200, 400, 800], message: `waiting for a toast matching ${re}` }).toMatch(re);
  return text;
}

/** Open a participant's challenge detail view in the browser.
 *
 *  The settle signal is the challenge's OWN card, never `#main-nav`: `showMain()`
 *  reveals the nav for ANY page, so waiting on it goes true partway through boot
 *  and boot's own later routing yanks the detail view back to the list (v8.1.0). */
async function openChallenge(page, comp, taskId, email) {
  const c0 = await tok(page.request);
  const li = await codeLogin(page.request, email, H(c0));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const csrf = await tok(page.request);
  const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: comp.id } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  // Establish the session BEFORE navigating (v7.21.26).
  await page.goto("/");
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  const card = page.locator(`#task-grid [data-task-id="${taskId}"]`);
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.click();
  await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
}

test.describe("v8.1.4 — the attempt-cap remedy is reachable", () => {
  test("an admin can grant attempts from the challenge kebab, and the participant can act again", async ({ page }) => {
    // THE LOAD-BEARING TEST. It is not enough that the POST returns 200: the
    // whole point of the finding is that the copy on a participant's screen
    // named a remedy nobody could perform, so the assertion is the participant's
    // RECOVERED ABILITY to submit.
    //
    // Everything admin-side goes through `page.request` — a second superadmin API
    // context would trip the single-session rule and kill the browser session
    // this test is driving (v7.19.0).
    await adminLogin(page);
    const csrf = await tok(page.request);
    const api = page.request;

    const comp = await makeEvent(api, csrf, { cap: null });
    const task = await makeTask(api, csrf, { cap: 1, correct: "the-answer" });
    await assignTask(api, csrf, task.id, [comp.id]);
    const p1 = await makeParticipant(api, csrf, uniq());
    // The second participant never submits, so the all-solved auto-end cannot
    // end this event underneath the grant.
    const p2 = await makeParticipant(api, csrf, uniq());
    await enrol(api, csrf, [p1, p2], comp.id);

    // Burn the one attempt, on the participant's own context.
    const ctx = await enter(p1.email, comp.id);
    try {
      expect((await submit(ctx.api, ctx.csrf, task.id, "wrong")).body.correct).toBe(false);
      // PRECONDITION, ASSERTED: they really are locked out before the grant, or
      // "they can submit afterwards" proves nothing at all.
      const blocked = await submit(ctx.api, ctx.csrf, task.id, "the-answer");
      expect(blocked.status, "the refusal is a 200 (a 4xx would feed the scanner counter)").toBe(200);
      expect(blocked.body.refused).toBe("attempts_exhausted");
    } finally { await ctx.api.dispose(); }

    // ── the control an operator actually reaches ────────────────────────────
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, task.title);   // paginated table — filter first
    await expect(row.first()).toBeVisible({ timeout: 15000 });
    await openKebab(page, row.first());                       // the kebab is a TOGGLE — use the hardened helper
    const grant = page.locator('#kebab-portal [data-action="task-attempt-grant"]');
    await expect(grant, "the Grant Attempts item exists on a capped challenge").toBeVisible({ timeout: 10000 });
    await grant.click();

    const overlay = page.locator("#attempt-grant-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await expect(overlay.locator("#ag-comp"), "the capped event is offered").toContainText(comp.name);
    // The roster is loaded per event; wait for the real rows, not for the card.
    const pick = overlay.locator(`#ag-people input[value="${p1.id}"]`);
    await pick.waitFor({ state: "attached", timeout: 15000 });
    await pick.check();
    await expect(overlay.locator("#ag-selected"), "the chosen participant is echoed back").toContainText(p1.nickname);
    await overlay.locator("#ag-extra").fill("1");
    await overlay.locator("#ag-save").click();

    const confirm = page.locator("#modal-overlay");
    await expect(confirm).toContainText("Grant Attempts", { timeout: 10000 });
    await expect(confirm, "the confirmation says grants ADD rather than set a total").toContainText(/adds to/i);
    await confirm.locator("button", { hasText: /^Grant$/ }).first().click();

    await lastToast(page, /Granted 1 extra attempt/i);

    // THE ASSERTION THIS TEST EXISTS FOR — the participant is no longer stuck.
    const ctx2 = await enter(p1.email, comp.id);
    try {
      const again = await submit(ctx2.api, ctx2.csrf, task.id, "the-answer");
      expect(again.status).toBe(200);
      expect(again.body.refused, "the grant really restored an attempt").toBeFalsy();
      expect(again.body.correct, "…and the submission was graded for real").toBe(true);
    } finally { await ctx2.api.dispose(); }
  });

  // Mutations this catches: the kebab item removed; `task-attempt-grant` not
  // registered in main.js; the dialog never POSTing; the POST omitting `extra`
  // or sending the wrong participant.

  test("a grant the server REFUSES is surfaced, not swallowed", async ({ page }) => {
    // The uncapped refusal (409 `not_capped`) is reachable from a live dialog:
    // the admin opens it while the challenge is capped and the cap is cleared
    // underneath them — a second tab, or a colleague. A swallowed refusal leaves
    // the dialog closing with nothing having happened, which is indistinguishable
    // from a broken feature (v7.21.14).
    await adminLogin(page);
    const csrf = await tok(page.request);
    const api = page.request;

    const comp = await makeEvent(api, csrf, { cap: null });
    const task = await makeTask(api, csrf, { cap: 2 });
    await assignTask(api, csrf, task.id, [comp.id]);
    const p1 = await makeParticipant(api, csrf, uniq());
    const p2 = await makeParticipant(api, csrf, uniq());
    await enrol(api, csrf, [p1, p2], comp.id);

    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, task.title);
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-attempt-grant"]').click();
    const overlay = page.locator("#attempt-grant-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    const pick = overlay.locator(`#ag-people input[value="${p1.id}"]`);
    await pick.waitFor({ state: "attached", timeout: 15000 });
    await pick.check();

    // …and NOW the cap goes away. Neither level carries one afterwards, so the
    // server answers 409 `not_capped`.
    const clear = await api.put(`/api/admin/tasks/${task.id}`, { headers: H(csrf), data: { attempt_cap: null } });
    expect(clear.ok(), `clearing the cap: ${await clear.text()}`).toBeTruthy();

    await overlay.locator("#ag-save").click();
    await page.locator("#modal-overlay button", { hasText: /^Grant$/ }).first().click({ timeout: 15000 });

    // The server's OWN reason, not a generic "Failed."
    const toast = await lastToast(page, /no attempt cap in this event/i);
    expect(toast, "and it is not dressed up as a success").not.toMatch(/Granted/i);
    // …and the dialog is still open, so the admin can correct and retry rather
    // than being returned to a table with no idea what happened.
    await expect(overlay, "a refusal leaves the dialog up").toBeVisible();
  });

  // Mutation this catches: `if(!r.ok){ ... }` replaced by a bare close, or by a
  // generic "Failed." that drops `d.error`.

  test("the recalculate toast NAMES who it stranded — and says nothing when it stranded nobody", async ({ page }) => {
    // SCOPE, STATED. This drives the CLIENT half, which is where the defect was:
    // the server has returned `attempts_exhausted_after` / `_who` since v8.1.0
    // and no client read either. The response is stubbed because
    // `recalculateTaskScores()` sends no `confirm_live`, so the real endpoint
    // refuses a challenge in a LIVE event — and a live capped event is the only
    // place stranding can happen. The SERVER half is driven for real in the next
    // test; neither lock can satisfy the other.
    await adminLogin(page);
    const csrf = await tok(page.request);
    const task = await makeTask(page.request, csrf, { cap: 1 });

    const stub = (body) => page.route(`**/api/admin/tasks/${task.id}/recalculate`, r =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));

    // ── the POSITIVE CONTROL, first: a run that stranded nobody ─────────────
    // Without this, "the toast names them" is equally satisfied by copy that is
    // always present.
    await stub({ ok: true, total_submissions: 4, flipped: 1, hints_rescaled: 0, unresolved: 0,
                 frozen_skipped: 0, attempts_exhausted_after: 0, attempts_exhausted_who: [], task_id: task.id });
    await page.evaluate((id) => { window.recalculateTaskScores(id); }, task.id);
    await page.locator("#modal-overlay button", { hasText: /^Recalculate$/ }).first().click({ timeout: 15000 });
    const clean = await lastToast(page, /Recalculated 4 submission/i);
    expect(clean, "a run that stranded nobody must not claim it did").not.toMatch(/no attempts left/i);
    expect(clean).not.toMatch(/Grant Attempts/i);

    // ── and now a run that really did strand two people ─────────────────────
    await page.unroute(`**/api/admin/tasks/${task.id}/recalculate`);
    await stub({ ok: true, total_submissions: 4, flipped: 2, hints_rescaled: 0, unresolved: 0, frozen_skipped: 0,
                 attempts_exhausted_after: 2, task_id: task.id,
                 attempts_exhausted_who: [
                   { user_id: "u-1", competition_id: "c-1", nickname: "strandedalpha", competition_name: "Ev" },
                   { user_id: "u-2", competition_id: "c-1", nickname: "strandedbeta", competition_name: "Ev" },
                 ] });
    await page.evaluate((id) => { window.recalculateTaskScores(id); }, task.id);
    await page.locator("#modal-overlay button", { hasText: /^Recalculate$/ }).first().click({ timeout: 15000 });
    const named = await lastToast(page, /2 participants now have no attempts left/i);
    expect(named, "…by NAME, because the remedy is per-participant").toMatch(/strandedalpha/);
    expect(named).toMatch(/strandedbeta/);
    expect(named, "…and it names the control that fixes it").toMatch(/Grant Attempts/i);
  });

  // Mutations this catches: the `_strand` clause deleted; it rendered
  // unconditionally; `attempts_exhausted_who` read but only as a count.

  test("the strand report is scoped to what THIS recalculate caused", async () => {
    // Two defects in one scan: it walked every `competition_tasks` row and every
    // participant who had ever submitted, so it reported people in FROZEN events
    // the same handler had just refused to re-grade, and it reported the
    // identical set again on a zero-flip re-run. A report that says the same
    // thing whether or not you did anything is not a report.
    const { api, csrf } = await sa();
    try {
      const task = await makeTask(api, csrf, { cap: 1, correct: "right" });

      // LIVE event — this is the one the recalculate really re-grades.
      const live = await makeEvent(api, csrf, { cap: null });
      // A second event that will be ENDED by the time we recalculate. Its
      // participant is exhausted-and-unsolved in exactly the same way, and must
      // NOT be reported: its submissions are frozen and were not touched.
      const doomed = await makeEvent(api, csrf, { cap: null });
      await assignTask(api, csrf, task.id, [live.id, doomed.id]);

      // THE TWO DECOYS ARE WHAT MAKE THIS DISCRIMINATING, and both are
      // exhausted-and-unsolved on a capped challenge — i.e. exactly what the old
      // scan reported, and exactly what this run did NOT cause:
      //   • `frozenWrong` is in the event that will be frozen, so their row is
      //     never re-graded;
      //   • `liveWrong` is in the LIVE event but their row does not move (wrong
      //     before, wrong after), so this run took nothing away from them.
      // `liveIdle` never submits, which is also what stops the all-solved
      // auto-end closing the live event once the other two are finished.
      const liveP = await makeParticipant(api, csrf, uniq());
      const liveWrong = await makeParticipant(api, csrf, uniq());
      const liveIdle = await makeParticipant(api, csrf, uniq());
      const frozenWrong = await makeParticipant(api, csrf, uniq());
      const frozenIdle = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, [liveP, liveWrong, liveIdle], live.id);
      await enrol(api, csrf, [frozenWrong, frozenIdle], doomed.id);

      const solver = await enter(liveP.email, live.id);
      try {
        expect((await submit(solver.api, solver.csrf, task.id, "right")).body.correct,
          "the solver used their one attempt on a correct answer").toBe(true);
      } finally { await solver.api.dispose(); }
      for (const [who, comp] of [[liveWrong, live], [frozenWrong, doomed]]) {
        const c = await enter(who.email, comp.id);
        try {
          const s = await submit(c.api, c.csrf, task.id, "nope");
          expect(s.body.correct, `${who.nickname} spent their one attempt on a wrong answer`).toBe(false);
        } finally { await c.api.dispose(); }
      }

      // Break the answer BEFORE freezing the second event: once a session has
      // ended the scoring freeze refuses the PUT outright, so the order here is
      // load-bearing rather than incidental.
      const put = await api.put(`/api/admin/tasks/${task.id}`, { headers: H(csrf), data: { correct_answer: "something-else" } });
      expect(put.ok(), `break the answer: ${await put.text()}`).toBeTruthy();

      // Freeze the second event. Asserted, because with everyone finished the
      // all-solved auto-end can have closed it already (checklist item 1) — it
      // cannot here, because `frozenIdle` never submitted.
      const en = await api.post(`/api/admin/competitions/${doomed.id}/end-now`, { headers: H(csrf) });
      expect(en.ok(), `end the frozen event: ${await en.text()}`).toBeTruthy();

      const rc = await api.post(`/api/admin/tasks/${task.id}/recalculate`, { headers: H(csrf), data: { confirm_live: true } });
      expect(rc.ok(), `recalculate: ${rc.status()} ${await rc.text()}`).toBeTruthy();
      const body = await rc.json();
      expect(body.flipped, "exactly the solver's row flipped").toBe(1);
      expect(body.frozen_skipped, "…and the frozen event's rows were skipped").toBeGreaterThan(0);

      const who = (body.attempts_exhausted_who || []).map(x => x.user_id);
      expect(body.attempts_exhausted_after, "exactly the one person this run stranded").toBe(1);
      expect(who, "the participant whose correct row this run took away IS reported").toContain(liveP.id);
      expect(who, "the FROZEN event's exhausted participant is NOT — nothing re-graded them").not.toContain(frozenWrong.id);
      expect(who, "nor is one this run did not touch, however exhausted they already were").not.toContain(liveWrong.id);
      expect(who, "nor one who never submitted").not.toContain(liveIdle.id);
      expect((body.attempts_exhausted_who || [])[0].nickname,
        "the NAME rides the report, because the remedy is per-participant").toBe(liveP.nickname);

      // A ZERO-FLIP RE-RUN CLAIMS NOTHING. The rows are already incorrect, so
      // this run causes nothing — and the old scan, which read the current
      // population rather than its own effect, reported the same person again.
      const rc2 = await api.post(`/api/admin/tasks/${task.id}/recalculate`, { headers: H(csrf), data: { confirm_live: true } });
      expect(rc2.ok(), await rc2.text()).toBeTruthy();
      const body2 = await rc2.json();
      expect(body2.flipped, "nothing left to flip").toBe(0);
      expect(body2.attempts_exhausted_after, "…so nobody was stranded by THIS run").toBe(0);
    } finally { await api.dispose(); }
  });

  // Mutations this catches: the scan reverted to walking `competition_tasks`;
  // the correct→incorrect direction filter dropped (an incorrect→correct flip
  // would then report); `user_id` dropped from the submissions SELECT.

  test("restoring a file-answer version onto a LIVE Booth Event is refused", async () => {
    // PR 30 enumerated six mutation paths and this is the seventh. Restore
    // writes `answer_type` straight from the snapshot and had no fit check at
    // all; its only competition gate is the ended-session freeze, and
    // `lib/challenge-fit.js` deliberately SKIPS ended events — so the two gates
    // cover disjoint lifecycles and a LIVE Booth Event was protected by neither.
    const { api, csrf } = await sa();
    try {
      // v1 is a FILE challenge; v2 converts it to text so the assign is allowed.
      const task = await makeTask(api, csrf, { answer_type: "file", correct: "right" });
      const put = await api.put(`/api/admin/tasks/${task.id}`, {
        headers: H(csrf), data: { answer_type: "text", correct_answer: "right" },
      });
      expect(put.ok(), `convert to text: ${await put.text()}`).toBeTruthy();

      const booth = await makeEvent(api, csrf, { kind: "booth", minutes: 120 });
      const ordinary = await makeEvent(api, csrf, { kind: "tournament" });
      await assignTask(api, csrf, task.id, [booth.id]);

      const versions = await (await api.get(`/api/admin/tasks/${task.id}/versions`)).json();
      const fileVer = versions.find(v => { try { return JSON.parse(v.snapshot).answer_type === "file"; } catch { return false; } });
      expect(fileVer, "there is a file-answer version to restore").toBeTruthy();

      const rest = await api.post(`/api/admin/tasks/${task.id}/restore`, { headers: H(csrf), data: { versionId: fileVer.id } });
      expect(rest.status(), `restore onto a live Booth Event: ${await rest.text()}`).toBe(409);
      const d = await rest.json();
      expect(d.code).toBe("file_answer_unsupported");
      expect(d.error, "the refusal names the event a walk-up cannot answer it at").toContain(booth.name);
      // …and it really did not write.
      const after = (await (await api.get("/api/admin/tasks")).json()).find(t => t.id === task.id);
      expect(after.answer_type, "a refusal writes nothing").toBe("text");

      // ── POSITIVE CONTROL ────────────────────────────────────────────────────
      // The SAME restore onto an ordinary Competition still succeeds — without
      // this, "the restore was refused" is equally satisfied by a build that
      // broke version restore for everybody.
      const twin = await makeTask(api, csrf, { answer_type: "file", correct: "right" });
      const put2 = await api.put(`/api/admin/tasks/${twin.id}`, {
        headers: H(csrf), data: { answer_type: "text", correct_answer: "right" },
      });
      expect(put2.ok(), await put2.text()).toBeTruthy();
      await assignTask(api, csrf, twin.id, [ordinary.id]);
      const tv = await (await api.get(`/api/admin/tasks/${twin.id}/versions`)).json();
      const twinFileVer = tv.find(v => { try { return JSON.parse(v.snapshot).answer_type === "file"; } catch { return false; } });
      const ok = await api.post(`/api/admin/tasks/${twin.id}/restore`, { headers: H(csrf), data: { versionId: twinFileVer.id } });
      expect(ok.ok(), `restore onto a Competition must still work: ${ok.status()} ${await ok.text()}`).toBeTruthy();
      const twinAfter = (await (await api.get("/api/admin/tasks")).json()).find(t => t.id === twin.id);
      expect(twinAfter.answer_type, "…and it really restored").toBe("file");
    } finally { await api.dispose(); }
  });

  test("restoring a needs:-tagged version onto a LIVE Booth Event is refused", async () => {
    // The tag half of the same hole: restore REPLACES `task_tags` wholesale from
    // the snapshot, so a `needs:` tag can come back without the challenge's own
    // columns moving at all. Driven separately because the answer_type path and
    // the tag path are two different reads of the prospective state.
    const { api, csrf } = await sa();
    try {
      const task = await makeTask(api, csrf, { tags: ["needs:desktop"] });   // v2 snapshot carries the tag
      const del = await api.delete(`/api/admin/tasks/${task.id}/tags/${encodeURIComponent("needs:desktop")}`, { headers: H(csrf) });
      expect(del.ok(), `remove the tag: ${await del.text()}`).toBeTruthy();

      const booth = await makeEvent(api, csrf, { kind: "booth", minutes: 120 });
      await assignTask(api, csrf, task.id, [booth.id]);   // allowed: no needs: tag right now

      const versions = await (await api.get(`/api/admin/tasks/${task.id}/versions`)).json();
      const tagVer = versions.find(v => {
        try { return (JSON.parse(v.snapshot).tags || []).includes("needs:desktop"); } catch { return false; }
      });
      expect(tagVer, "there is a needs:-tagged version to restore").toBeTruthy();

      const rest = await api.post(`/api/admin/tasks/${task.id}/restore`, { headers: H(csrf), data: { versionId: tagVer.id } });
      expect(rest.status(), `restore a needs: tag onto a live Booth Event: ${await rest.text()}`).toBe(409);
      const d = await rest.json();
      expect(d.code).toBe("needs_tool");
      expect(d.error).toMatch(/desktop/i);
      const tagsAfter = await (await api.get("/api/admin/tasks")).json();
      expect((tagsAfter.find(t => t.id === task.id).tags || []),
        "a refusal writes no tags either").not.toContain("needs:desktop");
    } finally { await api.dispose(); }
  });

  // Mutations these two catch: the `taskConflictingEvent` call removed from
  // restore; the prospective tag list read as the CURRENT one (the tag test then
  // passes the restore); the check placed after the write transaction.

  test("the card does not show two different attempt totals after a cap is lowered below spend", async ({ page }) => {
    // Lowering a cap below a participant's existing spend is permitted (cap edits
    // validate only the 1..1000 range), and `attemptState` leaves `used` raw
    // while clamping `left` to 0 — so the header's "5 attempt(s)" sat beside
    // "you have used all 3 attempts" in the locked panel, on one screen.
    // Enforcement was always right; only the two numbers disagreed, and
    // disagreeing numbers read as a broken feature.
    const { api, csrf } = await sa();
    try {
      const comp = await makeEvent(api, csrf, { cap: null });
      const task = await makeTask(api, csrf, { cap: 5, correct: "the-answer" });
      await assignTask(api, csrf, task.id, [comp.id]);
      const p1 = await makeParticipant(api, csrf, uniq());
      const p2 = await makeParticipant(api, csrf, uniq());   // never submits — no auto-end
      await enrol(api, csrf, [p1, p2], comp.id);

      const ctx = await enter(p1.email, comp.id);
      try {
        for (let i = 0; i < 5; i++) {
          const s = await submit(ctx.api, ctx.csrf, task.id, `wrong-${i}`);
          expect(s.status, `attempt ${i + 1}`).toBe(200);
          expect(s.body.refused, `attempt ${i + 1} was really spent`).toBeFalsy();
        }
      } finally { await ctx.api.dispose(); }

      // Now the cap drops UNDER what they already spent.
      const put = await api.put(`/api/admin/tasks/${task.id}`, { headers: H(csrf), data: { attempt_cap: 3 } });
      expect(put.ok(), `lower the cap: ${await put.text()}`).toBeTruthy();

      await openChallenge(page, comp, task.id, p1.email);
      const panel = page.locator(".attempts-exhausted-body");
      await expect(panel, "the panel is showing at all").toBeVisible({ timeout: 15000 });
      await expect(panel, "the panel reports what they SPENT").toContainText("all 5 attempts");
      await expect(panel, "…not the ceiling, which understates it").not.toContainText("all 3 attempts");
      // The header is the other half of the contradiction; assert the pair agree.
      await expect(page.locator("#task-detail-card .attempts-count"), "the header still says five").toHaveText("5 attempts");
    } finally { await api.dispose(); }
  });

  // Mutation this catches: `_spent` reverted to `t.attempts_cap` — the panel then
  // says three while the header says five.
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.3.11 — THE RECOVERY LOOP, DRIVEN END TO END FROM A BROWSER.
//
// v8.1.4 shipped the Grant Attempts control on the doctrine that "a control they
// cannot reach is no control at all" — and then hid it at two independent points
// from the ONE state the route exists to serve. A capped event auto-ends once
// everybody is solved-or-exhausted; both revive gates refuse while that predicate
// holds; so the grant is what un-finishes the exhausted participant and unlocks
// the reopen. Both `_taskMayHaveCap` (the kebab gate) and `openAttemptGrant` (the
// event dropdown) filtered `status !== 'ended'`, so from a browser the loop was
// dead at step one and reachable only with curl.
//
// TWO INDEPENDENT FILTERS IS WHY THE MUTATIONS ARE RUN SEPARATELY: restoring
// either one alone leaves the other assertion green, so a partial fix would look
// complete to a lock that only checked the end result.
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.11 — an auto-ended capped event is recoverable from the UI", () => {
  /**
   * The state the whole loop exists for, built the way it really arises.
   *
   * ONE challenge capped at 1, TWO participants: one solves it, one spends their
   * single attempt on a wrong answer. Neither has solved everything, so the
   * pre-v8.1.0 predicate would have left this running to its deadline; the
   * v8.1.0 solved-OR-exhausted predicate ends it on the burner's submit.
   *
   * DELIBERATELY NO IDLE THIRD PARTICIPANT. Fixture checklist item 1 exists to
   * stop the auto-end firing UNDER an assertion — here the auto-end IS the
   * precondition, so a spectator who never submits would prevent the state this
   * test is about.
   *
   * The burner's context is returned STILL OPEN rather than re-established later:
   * they have the page in front of them throughout, which is both the realistic
   * shape and the one that keeps `select-competition`'s behaviour on an ended
   * event out of a test that is not about it.
   */
  async function autoEndedCappedFixture(api, csrf) {
    const comp = await makeEvent(api, csrf, { cap: null });
    const task = await makeTask(api, csrf, { cap: 1, correct: "the-answer" });
    await assignTask(api, csrf, task.id, [comp.id]);
    const solver = await makeParticipant(api, csrf, uniq());
    const burner = await makeParticipant(api, csrf, uniq());
    await enrol(api, csrf, [solver, burner], comp.id);

    const sctx = await enter(solver.email, comp.id);
    try {
      expect((await submit(sctx.api, sctx.csrf, task.id, "the-answer")).body.correct,
        "the solver really solved the only challenge").toBe(true);
      const mid = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      expect(mid.status, "one solver is not everybody — still live at this point").toBe("live");
    } finally { await sctx.api.dispose(); }

    const bctx = await enter(burner.email, comp.id);
    const spent = await submit(bctx.api, bctx.csrf, task.id, "wrong");
    expect(spent.body.correct, "the burner spent their one attempt on a wrong answer").toBe(false);
    expect(spent.body.attempts_left, "…and it was their last").toBe(0);

    // PRECONDITION, ASSERTED. Without this every later assertion is about an
    // ordinary live event and the test measures nothing at all.
    const ended = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
    expect(ended.status, "precondition: solved-or-exhausted auto-ended the event").toBe("ended");
    expect(ended.ended_at, "…as a real auto-end, not a clock expiry").toBeTruthy();

    return { comp, task, solver, burner, bctx };
  }

  /**
   * The reopen, exactly as the toast instructs: a SUPERADMIN extends the duration.
   *
   * TWO PRECONDITIONS THE GATE IMPOSES, and getting either wrong makes the test
   * fail for a reason that has nothing to do with the fix:
   *   • `_scheduleMoved` (v8.1.9) requires the request to actually MOVE
   *     start/duration/deadline — a save that round-trips the stored values is a
   *     deliberate no-op, so the duration must really change;
   *   • the derived scheduled end must be in the FUTURE. The fixture starts an
   *     hour ago with a ten-hour duration and was ended by `ended_at` rather than
   *     by the clock, so any longer duration satisfies this; an "extension"
   *     landing inside an already-elapsed window would silently do nothing.
   * The route is also superadmin-only once the effective end has passed, which is
   * precisely the tier the new toast names.
   */
  async function extendAsSuperadmin(api, csrf, compId, minutes = 900) {
    const before = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(minutes, "the extension must really move the duration, or v8.1.9 refuses it")
      .toBeGreaterThan(before.duration_minutes);
    const r = await api.put(`/api/admin/competitions/${compId}`, {
      headers: H(csrf), data: { duration_minutes: minutes },
    });
    expect(r.ok(), `extend the ended event: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  }

  test("grant from the kebab → superadmin extends → the exhausted participant submits again", async ({ page }) => {
    // THE LOAD-BEARING TEST. Every step is driven through the surface an organiser
    // actually has: the Challenges kebab, the Grant Attempts dialog, and then the
    // reopen the toast tells them to ask a superadmin for.
    //
    // Everything admin-side rides `page.request` — `adminLogin` signs the browser
    // in as the superadmin, and a second superadmin API context would trip the
    // single-session rule and kill the session this test is driving (v7.19.0).
    await adminLogin(page);
    const csrf = await tok(page.request);
    const api = page.request;

    const { comp, task, burner, bctx } = await autoEndedCappedFixture(api, csrf);
    try {
      // ── 1. the kebab still OFFERS the control on an ended event ─────────────
      // Mutation: restore `.filter(c=>c.status!=='ended')` in `_taskMayHaveCap`.
      // The challenge's only event is this one, so the filter empties `comps`,
      // the gate returns false and the item is never rendered.
      await clickTab(page, "Challenges");
      const row = await findSeededTaskRow(page, task.title);   // paginated table — filter first
      await expect(row.first()).toBeVisible({ timeout: 15000 });
      await openKebab(page, row.first());
      const grant = page.locator('#kebab-portal [data-action="task-attempt-grant"]');
      await expect(grant,
        "Grant Attempts is offered on a challenge whose only event has ENDED").toBeVisible({ timeout: 10000 });
      await grant.click();

      // ── 2. …and the dialog OFFERS the ended event, labelled ────────────────
      // Mutation: restore `&&x.status!=='ended'` in the dialog's own filter. The
      // dropdown then has no options at all and the dialog takes its
      // nothing-to-grant branch, so the name assertion goes red.
      const overlay = page.locator("#attempt-grant-overlay");
      await expect(overlay).toBeVisible({ timeout: 15000 });
      const select = overlay.locator("#ag-comp");
      await expect(select, "the ENDED event is in the dropdown").toContainText(comp.name);
      await expect(select,
        "…and says so, so the admin is not told to grant into an event they think is running")
        .toContainText(/—\s*ended/);

      const pick = overlay.locator(`#ag-people input[value="${burner.id}"]`);
      await pick.waitFor({ state: "attached", timeout: 15000 });
      await pick.check();
      await overlay.locator("#ag-extra").fill("1");
      await overlay.locator("#ag-save").click();
      await page.locator("#modal-overlay button", { hasText: /^Grant$/ }).first().click({ timeout: 15000 });

      // ── 3. the toast names the SECOND step and the tier that can perform it ─
      // Mutation: drop the `d.competition_ended` branch. "Granted 1 extra
      // attempt" alone is the v7.14.2 failure with the sides swapped — the
      // affordance worked and the outcome silently did not, so the admin walks
      // away believing the participant can act.
      //
      // CAPTURE WHATEVER THE PLATFORM SAID, then assert about it — never poll for
      // the success text directly. A refusal toast self-dismisses inside the poll
      // window, so polling for /Granted/ reports `Received: ""`, which is equally
      // true of a dialog that never submitted, a hung fetch and a server 409. It
      // was measured: reverting the SERVER half alone produced exactly that
      // uninformative message. Capturing first makes the refusal itself the
      // failure text.
      const toast = await lastToast(page, /\S/);
      expect(toast, "the grant was accepted on an ENDED event").toMatch(/Granted 1 extra attempt/i);
      expect(toast, "the toast says the event is still ended").toMatch(/has ended/i);
      expect(toast, "…names the remedy: extend the duration to reopen it").toMatch(/extend/i);
      expect(toast, "…and names the tier, because reopening past the end is superadmin-only")
        .toMatch(/superadmin/i);

      // ── 4. the recovery really was a GRANT, not a cap raise ────────────────
      // Without this the whole test is satisfied by a tester who rescued the
      // fixture the wrong way — raising the challenge's cap changes the rules for
      // every event holding it, which is exactly what the per-participant grant
      // exists to avoid.
      const evs = await (await api.get(`/api/admin/participants/${burner.id}/events?limit=200`)).json();
      const granted = (evs.events || []).find(e => e.event_type === "attempt_grant");
      expect(granted, "the burner's own history records the grant").toBeTruthy();
      expect(granted.details.competition_id).toBe(comp.id);
      expect(granted.details.extra).toBe(1);
      const taskRow = (await (await api.get("/api/admin/tasks")).json()).find(t => t.id === task.id);
      expect(taskRow.attempt_cap, "…and the challenge's own cap was NOT touched").toBe(1);

      // ── 5. the reopen the toast promised actually works ────────────────────
      // This is where a client-only fix would still be caught: revert the SERVER
      // half so the grant 409s on an ended event and step 2 above still passes,
      // while nothing here can.
      const put = await extendAsSuperadmin(api, csrf, comp.id);
      expect(put.allSolved,
        "the grant un-finished the burner, so the all-solved gate no longer holds").toBe(false);
      expect(put.newStatus, "…and the event really reopened").toBe("live");

      // ── 6. and the participant this was all for can act ────────────────────
      const again = await submit(bctx.api, bctx.csrf, task.id, "the-answer");
      expect(again.status, "no lifecycle refusal — the event is live again").toBe(200);
      expect(again.body.refused, "no cap refusal — the grant restored an attempt").toBeFalsy();
      expect(again.body.correct, "…and the submission was graded for real").toBe(true);
    } finally { await bctx.api.dispose(); }
  });

  test("WITHOUT the grant the same extension leaves it ended — the control", async () => {
    // THE ANTI-VACUITY CONTROL, and it carries most of the weight of the test
    // above. "The participant resumed" is equally satisfied by a build in which
    // the all-solved revive gate does not exist at all — a strictly worse change,
    // invisible to every other assertion in this file, and one that would let any
    // save silently reopen a settled event (the v8.1.9 defect).
    //
    // Identical fixture, identical superadmin extension, ONE difference: no grant.
    const { api, csrf } = await sa();
    let bctx = null;
    try {
      const f = await autoEndedCappedFixture(api, csrf);
      bctx = f.bctx;

      const put = await extendAsSuperadmin(api, csrf, f.comp.id);
      expect(put.allSolved,
        "everyone is still solved-or-exhausted, so the gate holds").toBe(true);
      expect(put.newStatus, "…and the event stays ended").toBe("ended");
      const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === f.comp.id);
      expect(row.ended_at, "ended_at was not cleared").toBeTruthy();

      const blocked = await submit(bctx.api, bctx.csrf, f.task.id, "the-answer");
      expect(blocked.status, "the burner is refused on the lifecycle, before the cap").toBe(403);
      expect(blocked.body.error, "…and told the event has ended").toMatch(/has ended/i);
    } finally { if (bctx) await bctx.api.dispose(); }
  });
});
