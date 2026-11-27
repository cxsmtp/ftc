// @ts-check
//
// WHAT A PARTICIPANT IS TOLD WHEN THEIR SESSION ENDS UNDER THEM — the client
// half of `participantSessionDenied` and of the purge reasons.
//
//   • A file answer refused at commit because ANOTHER TAB replaced the session
//     (signing in again as the same account) says so on the card, and the "try again" it
//     promises works: the interceptor gets this tab a token for the live
//     session. Without that, the retry carried the dead session's token, was
//     refused `csrf_invalid`, and the refusal destroyed the live session — both
//     tabs signed out. Two pages of ONE browser context share the cookie jar, as
//     two tabs do.
//     The token is fetched ONLY for the tab's own account acting as itself:
//     if the other tab signed in as somebody else, a fresh token would commit
//     this tab's retry under that account, and if the session is simply dead
//     (signed in from another browser) a fetch would mint an anonymous session
//     and lose the "Signed in elsewhere" context the popup reports.
//   • A purge that recorded why reads as what happened: a password reset says
//     so, whether it was finished in another browser or in this one while it
//     was signed in (the reset replaces this browser's own session, so the
//     reason is keyed on the id it then holds). A reset of ANOTHER account
//     finished here, an organiser's block and a reason this client does not
//     know get the neutral sign-out. None claims the participant was idle,
//     which is what all of them used to say.
//   • "Signed in elsewhere" gives the remedy the account has: a password change
//     for a user account, a restart for the built-in superadmin, which has no
//     password to change.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { loginViaApi, adminLogin } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { signIn, makeAdmin } = require("./admin-inflight-helpers");
const { SESSION_ENDED, dbGet } = require("./participant-inflight-fixture");

test.use({ baseURL: BASE });

test.describe("a participant whose session ends under them", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => {
    await sa?.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => {});
    await sa?.dispose();
  });

  /** A participant signed in through the page, on its own event, with the SPA booted. */
  async function signedIn(page, label, { fileTask = false } = {}) {
    const comp = await makeCompetition(sa, saCsrf, label);
    const t1 = (await makeTask(sa, saCsrf, `${label}1`, fileTask ? { answer_type: "file", correct_answer: "win" } : {})).id;
    const t2 = (await makeTask(sa, saCsrf, `${label}2`)).id;   // one solve must not end the event
    // The event's own copies (lib/event-copies.js): the cards its participant opens.
    const c1 = (await assignTask(sa, saCsrf, t1, [comp.id])).copies[0].task_id;
    await assignTask(sa, saCsrf, t2, [comp.id]);
    const p = await makeParticipant(sa, saCsrf, label);
    await enrol(sa, saCsrf, comp.id, [p.id]);
    await loginViaApi(page, p.email, PARTICIPANT_PASS);
    await page.goto(BASE + "/");
    // Exactly one event: the sole-event landing takes them straight in.
    await expect(page.locator("#nav-challenges:not([aria-disabled=true])")).toBeVisible({ timeout: 20_000 });
    return { p, comp, t1: c1 };
  }

  /**
   * A file answer sent from the page for `t1`, parked in its read window with
   * `act` run there, and the card's sentence awaited. Returns how many
   * /api/csrf-token requests the page sent from the park onward: the interceptor
   * hands the refusal to the card only after its probe (and any token fetch) has
   * finished, so the count is final once the sentence shows.
   */
  async function parkedUiAnswer(page, t1, act) {
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    await page.locator(`[data-task-id="${t1}"]`).first().click();
    await expect(page.locator("#ans-file")).toBeVisible({ timeout: 15_000 });
    await page.setInputFiles("#ans-file", { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("win") });
    let counting = false, tokenFetches = 0;
    const onReq = (q) => { if (counting && new URL(q.url()).pathname === "/api/csrf-token") tokenFetches++; };
    page.on("request", onReq);
    const delayMs = 4000;
    const arm = await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs } });
    expect(arm.ok()).toBeTruthy();
    try {
      await page.locator('[data-action="task-submit-answer"]').first().click();
      const tSend = Date.now();
      await page.locator("#modal-confirm-btn").click();   // the permanent-penalty confirm every graded submit raises
      for (;;) {
        if ((await (await sa.get("/api/test/submit-read-delay")).json()).parked >= 1) break;
        if (Date.now() - tSend > 10_000) throw new Error("PRECONDITION: the answer never reached the file-read park");
        await new Promise(r => setTimeout(r, 25));
      }
      counting = true;
      await act();
      expect(Date.now() - tSend, "PRECONDITION: the act landed while the answer was parked").toBeLessThan(delayMs);
      await expect(page.locator("#submit-result .result-msg.notice"), "the card says nothing was saved, and to try again")
        .toHaveText(SESSION_ENDED, { timeout: delayMs + 10_000 });
    } finally {
      page.off("request", onReq);
      const d = await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } });
      expect(d.ok(), "disarm the file-read park").toBeTruthy();
    }
    return { tokenFetches };
  }

  /** Make the booted SPA notice the dead session now, rather than at the monitor's next 30 s tick. */
  const poke = (page) => page.evaluate(() => { fetch("/api/me"); });

  /** Answer `t1` again from the page, as the participant would after reading the card. */
  async function retryFromPage(page, t1) {
    const answered = page.waitForResponse(r => r.url().includes(`/api/tasks/${t1}/submit`) && r.request().method() === "POST");
    await page.locator('[data-action="task-submit-answer"]').first().click();
    await page.locator("#modal-confirm-btn").click();
    return answered;
  }



  test("CONTROL: another tab signs in again as THIS account mid-upload: one token is fetched for the live session, and the retry is graded", async ({ page }) => {
    // The same account replacing its own session (a code sign-in in another tab
    // regenerates it): the live session is this tab's own, acting as itself, so
    // the interceptor fetches its token before handing the refusal to the card
    // (core/api.js `_liveSessionIsMine`), and the card's "try again" works. This
    // is what makes the two `toBe(0)` arms below mean something.
    const { p, t1 } = await signedIn(page, "pisuself", { fileTask: true });
    const other = page.context().request;   // same jar: the other tab's new session is this tab's too
    const token = async () => (await (await other.get("/api/csrf-token")).json()).csrfToken;
    const { tokenFetches } = await parkedUiAnswer(page, t1, async () => {
      const li = await codeLogin(other, p.email, H(await token()));
      expect(li.ok(), `the other tab signs in again as this account: ${await li.text()}`).toBeTruthy();
    });
    expect(tokenFetches, "this tab fetched a token for the live session (the control for the arms below)").toBe(1);

    const res = await retryFromPage(page, t1);
    expect(res.status(), "the retry carried the live session's token and was graded").toBe(200);
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=?", p.id, t1).c, "the answer was stored, once").toBe(1);
    expect((await other.get("/api/me")).status(), "the live session survived the retry").toBe(200);
  });

  test("another tab signs in as SOMEBODY ELSE mid-upload: no token is fetched for them, and this tab's retry never commits as that account", async ({ page }) => {
    const { p, comp, t1 } = await signedIn(page, "pisux", { fileTask: true });
    const y = await makeParticipant(sa, saCsrf, "pisuy");
    await enrol(sa, saCsrf, comp.id, [y.id]);
    const other = page.context().request;   // same jar: what the other tab signs in as, this tab's cookie names too
    const token = async () => (await (await other.get("/api/csrf-token")).json()).csrfToken;
    const { tokenFetches } = await parkedUiAnswer(page, t1, async () => {
      expect((await other.post("/api/logout", { headers: H(await token()) })).ok(), "the other tab signs out").toBeTruthy();
      const li = await codeLogin(other, y.email, H(await token()));
      expect(li.ok(), `and signs in as Y: ${await li.text()}`).toBeTruthy();
      const sel = await other.post("/api/select-competition", { headers: H(await token()), data: { competitionId: comp.id } });
      expect(sel.ok(), `Y enters the same event, so an answer from Y's session would be graded: ${await sel.text()}`).toBeTruthy();
    });
    expect.soft(tokenFetches, "no token was fetched for Y's session").toBe(0);

    const res = await retryFromPage(page, t1);
    expect(res.status(), "the retry carried X's dead token and was refused, as before").not.toBe(200);
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=?", y.id, t1).c, "nothing was stored for Y").toBe(0);
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=?", p.id, t1).c, "nor for X").toBe(0);
  });

  test("another tab enters impersonation of this very account mid-upload: no token is fetched, and the retry never commits under the impersonation", async ({ page }) => {
    const { p, comp, t1 } = await signedIn(page, "pisui2", { fileTask: true });
    const admin = await makeAdmin(sa, saCsrf, "pisui2a", "superadmin");   // user-backed: a built-in sign-in would end `sa`
    const other = page.context().request;
    const token = async () => (await (await other.get("/api/csrf-token")).json()).csrfToken;
    const { tokenFetches } = await parkedUiAnswer(page, t1, async () => {
      expect((await other.post("/api/logout", { headers: H(await token()) })).ok(), "the other tab signs out").toBeTruthy();
      const li = await codeLogin(other, admin.email, H(await token()));
      expect(li.ok(), `and signs in as a superadmin: ${await li.text()}`).toBeTruthy();
      const imp = await other.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(await token()), data: { view: "participant" } });
      expect(imp.ok(), `who impersonates this tab's account: ${await imp.text()}`).toBeTruthy();
      const sel = await other.post("/api/select-competition", { headers: H(await token()), data: { competitionId: comp.id } });
      expect(sel.ok(), `inside the same event, so an answer from that session would be graded: ${await sel.text()}`).toBeTruthy();
    });
    expect.soft(tokenFetches, "the live session is the same account, but impersonated: no token").toBe(0);

    const res = await retryFromPage(page, t1);
    expect(res.status(), "the retry carried the dead token and was refused, as before").not.toBe(200);
    expect(dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=?", p.id, t1).c, "nothing was stored").toBe(0);
  });












  test("an organiser's block: the popup is the neutral sign-out, naming no cause and never idleness", async ({ page }) => {
    const { p } = await signedIn(page, "pisub");
    await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
    const verdicts = await page.evaluate(() => ["a_reason_added_later", null].map(reason => window._classifySignout(
      { active: false, server_started_at: window._sessionMon.serverStartedAt, reason, kicked_by: null }, "Not authenticated").kind));
    expect(verdicts, "a recorded reason this client does not know is a purge, never idleness (null: the control)").toEqual(["unknown", "inactivity"]);
    const b = await sa.post(`/api/admin/participants/${p.id}/block`, { headers: H(saCsrf) });
    expect(b.ok()).toBeTruthy();
    expect((await b.json()).blocked, "the block TOOK").toBe(1);
    await poke(page);
    await expect(page.locator("#modal-title")).toHaveText("Signed out", { timeout: 15_000 });
    await expect(page.locator("#modal-body")).toHaveText("You were signed out. Please sign in again to continue.");
  });

  test("the built-in superadmin signed in from another browser: the popup gives a restart as the remedy, never a password change it cannot make", async ({ page }) => {
    let elsewhere = null;
    try {
      await sa.dispose();   // one session per principal: the page's sign-in below ends this file's anyway
      await adminLogin(page);
      await page.waitForFunction(() => window._sessionMon && window._sessionMon.serverStartedAt, null, { timeout: 15_000 });
      elsewhere = await apiLogin("superadmin");
      const st = await (await page.request.get("/api/session/status")).json();
      expect(st.kicked_by, `PRECONDITION: the server reports the built-in account signed in elsewhere: ${JSON.stringify(st)}`)
        .toMatchObject({ email: "superadmin", builtin: true });
      await page.evaluate(() => { window._sessionMonTick(); });
      await expect(page.locator("#modal-title")).toHaveText("Signed in elsewhere", { timeout: 15_000 });
      const msg = page.locator("#modal-body");
      await expect(msg).toContainText("the built-in superadmin account was signed in from another browser");
      await expect(msg).toContainText("If this wasn't you, restart the platform, or ask whoever runs it to");
      await expect(msg).toContainText("check who can read the password file");
      expect(await msg.textContent(), "no password change for an account that cannot make one").not.toMatch(/change your password/i);
    } finally {
      // The sign-in elsewhere is this file's superadmin from here on.
      ({ api: sa, csrf: saCsrf } = elsewhere || await apiLogin("superadmin"));
    }
  });
});
