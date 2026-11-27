// @ts-check
//
// v8.12.6 (EXTERNAL AUDIT F1) — THE EDITOR'S UPLOAD SPEAKS THE REFUSALS THE REST
// OF THE SPA ALREADY UNDERSTANDS.
//
// The attachment editor uploads through an XMLHttpRequest (for its progress
// bar), and an XHR never passes through `installFetchInterceptor`. So when the
// server refuses a staging upload because the organiser a superadmin was
// impersonating stopped qualifying mid-upload, it answers the forced-exit shape
// every fetch caller turns into a toast and a reload — `{error:
// "impersonation_ended", reason: "target_inactive"}` — and the editor rendered
// the machine token "impersonation_ended" as its error message. The server side
// of that refusal is driven for real in admin-inflight-authz.api.spec.js; here
// the response is FULFILLED, because what is under test is the client's reading
// of it, and a real mid-upload demotion through a browser adds nothing but time.
//
// The CONTROL is what keeps the branch honest: any OTHER refusal must still be
// rendered as the server's own sentence, on the form, with no reload — or "the
// token is not shown" is equally satisfied by a build that shows nothing.
//
// v8.12.6 (review fix) — "NEVER SHOWN" IS ASSERTED OVER EVERY WRITE, NOT ONE READ.
// The first version checked `#tf-attach-error` with a RETRYING negative, and the
// branch under test reloads the page 900 ms after its toast: once the reload
// lands the fresh document's empty markup satisfies the negative, so a build that
// painted the raw token beside the toast passed (measured, the `else` dropped).
// A single snapshot would only move the race. So a MutationObserver reports every
// text ever written to the element through an exposed binding, which survives the
// reload, and the arm first writes a PROBE through it — or "nothing was recorded"
// would be equally satisfied by an observer that never attached.
//
// The last two arms are the participant side of the same shape: a participant
// write refused because the ADMIN impersonating them lost access mid-request
// (`impersonatingHandDenied`) must read as that — the right cause in the toast,
// and never a result panel, red or otherwise, on the challenge.
const { test, expect } = require("./isolated-test");
const { zipOf, BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { adminLogin, clickTab, loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

/**
 * Record every text written into `selector` from now on, across the reload the
 * page is about to do (`exposeFunction` bindings survive navigation; a `window`
 * variable would not). Returns the live array, after proving the observer is
 * attached by writing a probe through it and restoring the element.
 */
async function recordWrites(page, selector, name) {
  const seen = [];
  await page.exposeFunction(name, (t) => { seen.push(String(t)); });
  await page.evaluate(async ({ selector, name }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no ${selector} to observe`);
    // From the RECORDS, not from the element when the callback runs: a write
    // followed by another in the same task would otherwise never be seen.
    new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === "characterData") window[name](r.target.data);
        for (const n of r.addedNodes) window[name](n.nodeType === 1 ? n.outerHTML : n.textContent);
      }
    }).observe(el, { childList: true, characterData: true, subtree: true });
    const was = el.innerHTML;
    el.textContent = "__f1probe__";
    await new Promise(r => setTimeout(r, 0));
    el.innerHTML = was;
  }, { selector, name });
  await expect.poll(() => seen.some(t => t.includes("__f1probe__")), { message: `the recorder on ${selector} is live`, timeout: 5000 }).toBe(true);
  return seen;
}

test.use({ baseURL: BASE });

async function openAttachPicker(page) {
  await adminLogin(page);
  await clickTab(page, "Challenges");
  await page.locator("[data-action='open-task-form']").first().click();
  await page.locator("#admin-task-form").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#tf-attach-add-btn").click();
  await page.locator("#tf-attach-file").setInputFiles({ name: "kit.zip", mimeType: "application/zip", buffer: zipOf("README.txt", "f1 ui") });
}

test.describe("v8.12.6 (F1) — the editor's XHR upload and the commit-time refusals", () => {
  test("a seat that stopped qualifying mid-upload: the toast and the reload the fetch interceptor gives, never the raw token", async ({ page }) => {
    await openAttachPicker(page);
    await page.route("**/api/admin/attachment-staging", route => route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({ error: "impersonation_ended", reason: "target_inactive", code: "admin_access_revoked" }),
    }));
    const written = await recordWrites(page, "#tf-attach-error", "__f1AttachErr");
    const reloaded = page.waitForEvent("framenavigated", { predicate: f => f === page.mainFrame(), timeout: 15_000 });
    await page.locator("button[data-action='confirm-attach-upload']").click();
    await expect(page.locator(".toast").filter({ hasText: "Impersonation ended" }).first(),
      "the interceptor's own toast").toBeVisible({ timeout: 10_000 });
    await reloaded;   // …and the page goes back to the admin's own view, as the interceptor does
    expect(written.filter(t => t.includes("impersonation_ended")),
      "the machine token was never written into the editor's error, not even for the moment before the reload").toEqual([]);
  });

  test("CONTROL: any other refusal is the server's own sentence, on the form, with no reload", async ({ page }) => {
    await openAttachPicker(page);
    const sentence = "Your administrator access has ended, so nothing was saved.";
    await page.route("**/api/admin/attachment-staging", route => route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({ error: sentence, code: "admin_access_revoked" }),
    }));
    await page.evaluate(() => { window.__f1NoReload = true; });
    await page.locator("button[data-action='confirm-attach-upload']").click();
    await expect(page.locator("#tf-attach-error")).toHaveText(sentence, { timeout: 10_000 });
    // The branch that reloads also toasts, synchronously, in the same handler —
    // so its absence here is observable at once rather than after the reload's delay.
    await expect(page.locator(".toast").filter({ hasText: "Impersonation ended" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__f1NoReload), "still the same document").toBe(true);
  });

  test("v8.13.4: the commit-time 'session ended' 401 is the server's sentence on the form, never a 'Signed out' dialog", async ({ page }) => {
    // v8.13.4 (fix-delta review) — the XHR learned to announce a 401 as a sign-out,
    // and the first draft caught EVERY 401, including this one, whose sentence is
    // worded to stay true when the browser still holds a live session.
    await openAttachPicker(page);
    const sentence = "Your session ended before this finished, so nothing was saved. Try again — if you are asked to sign in, do that first.";
    await page.route("**/api/admin/attachment-staging", route => route.fulfill({
      status: 401, contentType: "application/json",
      body: JSON.stringify({ error: sentence, code: "admin_session_ended" }),
    }));
    await page.evaluate(() => { window.__f1NoReload2 = true; });
    await page.locator("button[data-action='confirm-attach-upload']").click();
    await expect(page.locator("#tf-attach-error")).toHaveText(sentence, { timeout: 10_000 });
    await expect(page.locator("#modal-title"), "no sign-out dialog").not.toHaveText("Signed out");
    expect(await page.evaluate(() => window.__f1NoReload2), "still the same document").toBe(true);
  });

  test("v8.13.4 CONTROL: a bare 401 from the upload IS announced as a sign-out", async ({ page }) => {
    await openAttachPicker(page);
    await page.route("**/api/admin/attachment-staging", route => route.fulfill({
      status: 401, contentType: "application/json",
      body: JSON.stringify({ error: "Not authenticated", code: "admin_session_ended" }),
    }));
    await page.locator("button[data-action='confirm-attach-upload']").click();
    await expect(page.locator("#modal-title")).toHaveText("Signed out", { timeout: 10_000 });
  });

  // ── the participant side ──────────────────────────────────────────────────

  async function participantOnChallenge(page, label) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, label);
      const b1 = await makeTask(sa, csrf, `${label}1`, { correct_answer: "right" });
      const b2 = await makeTask(sa, csrf, `${label}2`, { correct_answer: "right" });   // one solve must not end the event
      // The event's own copies (lib/event-copies.js): the cards its participants open.
      const t1 = { ...b1, id: (await assignTask(sa, csrf, b1.id, [comp.id])).copies[0].task_id };
      await assignTask(sa, csrf, b2.id, [comp.id]);
      const p = await makeParticipant(sa, csrf, label);
      await enrol(sa, csrf, comp.id, [p.id]);
      await loginViaApi(page, p.email, PARTICIPANT_PASS);
      await page.goto(BASE + "/");
      // Exactly one event: the sole-event landing takes them straight in.
      await expect(page.locator("#nav-challenges:not([aria-disabled=true])")).toBeVisible({ timeout: 20_000 });
      await page.locator("#nav-challenges:not([aria-disabled=true])").click();
      await page.locator(`[data-task-id="${t1.id}"]`).first().click();
      await expect(page.locator("#ans-text")).toBeVisible({ timeout: 15_000 });
    } finally { await sa.dispose(); }
  }

  test("a participant write refused because the impersonating ADMIN lost access: the toast says so, and no result is ever painted", async ({ page }) => {
    await participantOnChallenge(page, "f1uip");
    const painted = await recordWrites(page, "#submit-result", "__f1SubmitResult");
    await page.route("**/api/tasks/*/submit", route => route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({ error: "impersonation_ended", reason: "actor_inactive", code: "admin_access_revoked" }),
    }));
    const reloaded = page.waitForEvent("framenavigated", { predicate: f => f === page.mainFrame(), timeout: 15_000 });
    await page.fill("#ans-text", "anything");
    await page.locator('[data-action="task-submit-answer"]').first().click();
    await page.locator("#modal-confirm-btn").click();   // the permanent-penalty confirm every graded submit raises
    const toast = page.locator(".toast").filter({ hasText: "Impersonation ended" }).first();
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast, "the cause is the admin's access, not the participant's account").toContainText("your administrator access has ended");
    await expect(toast).not.toContainText("no longer active");
    await reloaded;
    expect(painted.filter(t => /result-msg/.test(t)),
      "no result — least of all a red 'wrong answer' — was ever painted for a submission nobody graded").toEqual([]);
  });

  test("each forced-exit reason names its own cause; an absent one keeps the original sentence", async ({ page }) => {
    await adminLogin(page);
    // ONE synchronous evaluate: each call schedules the 900 ms reload, and
    // nothing can navigate the page away between statements of one task.
    const said = await page.evaluate(() => ["session_ended", "actor_inactive", "target_inactive", undefined].map((r) => {
      window.announceImpersonationEnded(r);
      const all = document.querySelectorAll(".toast");
      return all.length ? all[all.length - 1].textContent : null;
    }));
    expect(said[0]).toMatch(/signed out or changed elsewhere, so nothing was saved/);
    expect(said[1]).toMatch(/your administrator access has ended/);
    // CONTROL: the shape every pre-existing refusal sends, and an absent reason.
    expect(said[2]).toMatch(/the impersonated account is no longer active/);
    expect(said[3]).toMatch(/the impersonated account is no longer active/);
  });
});
