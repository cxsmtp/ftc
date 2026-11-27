// @ts-check
//
// v8.13.4 — WHAT THE BUILT-IN SUPERADMIN SAW, before and after.
//
// The SPA treats any `csrf_invalid` as a forced sign-out: it shows "Signed out"
// and, for that one trigger, posts /api/logout. Both requests carry the token
// the page holds — so when THAT token is the stale one, the logout is refused as
// well. For a user account the server had already destroyed the session on the
// first refusal, so the dialog was true. For the built-in superadmin it was not:
// the server kept that session (the handler keyed on `userId`, which the
// built-in account does not have), the dialog said "Signed out", and the reload
// it ended in put the superadmin straight back into the admin panel.
//
// The same shape made the built-in account's own LOGOUT button a no-op whenever
// the page's token was stale: the logout POST was refused, the session survived,
// and `location.reload()` re-authenticated.
//
// THE TOKEN IS MADE STALE IN PLACE (`window.S.csrfToken`), and that is the whole
// difference between a lock and a test that passes either way: with a GOOD
// token in S, the interceptor's own follow-up logout succeeds and signs the
// built-in out regardless, so a stale HEADER on one request discriminates
// nothing (the critic's correction to the scoping report's first draft).
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, getSuperadminPass, PARTICIPANT_PASS, waitForAdminPage } = require("./helpers");
const { loginViaApi, fillBreakGlass, submitLogin } = require("./ui-admin-helpers");
const { makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const STALE = "stale-and-worthless";

/** The built-in superadmin, signed in on this page, admin panel on screen. */
async function intoAdminAsBuiltin(page) {
  await page.goto("/");
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await waitForAdminPage(page);
  expect(await page.evaluate(() => !!(window.S && window.S.isSuperAdmin)),
    "PRECONDITION: the page booted as the built-in superadmin").toBe(true);
}

/**
 * Run `trigger` (which reloads the page) and assert where the NEW document lands.
 * The shell paints #login-page on every load and hides #admin-page until boot
 * routes, so a DOM check made at first paint cannot tell "signed out" from "boot
 * has not routed yet" (the pre-release review). So this waits for the new
 * document's boot to ASK — its /api/admin/me, which only boot sends, answered —
 * lets two frames pass for it to route, and only then reads the DOM once. The
 * server is asked as well, so the claim holds at both ends.
 */
async function expectSignedOutAfter(page, trigger, why) {
  // The new document's boot asks /api/session/status FIRST and, signed out,
  // stops there (no 401-bound identity reads): its answer is the witness.
  // Only an answer seen AFTER the reload navigated counts: the old document's
  // own sign-out asks the same endpoint.
  let navigated = false;
  const seen = [];
  const onNav = (f) => { if (f === page.mainFrame()) navigated = true; };
  const onResp = (r) => { if (navigated && new URL(r.url()).pathname === "/api/session/status") seen.push(r.status()); };
  page.on("framenavigated", onNav);
  page.on("response", onResp);
  try {
    await trigger();
    await expect.poll(() => seen.length, { timeout: 20_000, message: `${why} — the reloaded page's boot asked /api/session/status` }).toBeGreaterThan(0);
  } finally { page.off("framenavigated", onNav); page.off("response", onResp); }
  expect(seen[0], `${why} — the reloaded page's boot asked`).toBe(200);
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await page.locator("#admin-page").isVisible(), `${why} — boot did not route to the admin panel`).toBe(false);
  expect(await page.locator("#login-page").isVisible(), `${why} — the sign-in card is on screen`).toBe(true);
  expect((await page.request.get("/api/admin/me")).status(), `${why} — and the server agrees`).toBe(401);
}

/**
 * Accept the "Signed out" dialog. The overlay is shared by every dialog and opens
 * on an animation, and once a click on its confirm timed out as not stable with
 * nothing to say why (seen once, not reproduced) — so the title is asserted, the
 * animations drained, and a failure names what was on screen.
 */
async function acceptSignedOut(page) {
  await expect(page.locator("#modal-title")).toHaveText("Signed out", { timeout: 10_000 });
  await page.evaluate(() => Promise.all((document.getElementById("modal-overlay")?.getAnimations({ subtree: true }) || []).map((a) => a.finished.catch(() => {}))));
  try {
    await page.locator("#modal-confirm-btn").click({ timeout: 10_000 });
  } catch (e) {
    const seen = await page.evaluate(() => ({
      href: location.href,
      overlay: document.getElementById("modal-overlay")?.className,
      title: document.getElementById("modal-title")?.textContent,
      body: (document.getElementById("modal-body") || document.getElementById("modal-message"))?.textContent,
    })).catch((x) => ({ unreadable: String(x) }));
    throw new Error(`could not accept the "Signed out" dialog: ${e.message}\non screen: ${JSON.stringify(seen)}`);
  }
}

test.describe("v8.13.4 — a stale token signs the built-in superadmin out, and the dialog says so truthfully", () => {

  test("the interceptor's 'Signed out' is TRUE for the built-in superadmin: the reload lands on the sign-in card", async ({ page }) => {
    await intoAdminAsBuiltin(page);
    // Stale IN PLACE, then a request built from it: the follow-up logout the
    // interceptor posts carries the same stale token and is refused too.
    await page.evaluate((stale) => {
      window.S.csrfToken = stale;
      fetch("/api/session/keepalive", { method: "POST", headers: { "X-CSRF-Token": window.S.csrfToken } }).catch(() => {});
    }, STALE);

    // PRE-v8.13.4: the built-in session survived both refusals, so this reload
    // booted straight back into #admin-page under a dialog that had just said
    // "Signed out".
    await expectSignedOutAfter(page, () => acceptSignedOut(page), "the reload after 'Signed out' lands on the sign-in card");
  });

  test("the built-in superadmin's Logout button signs it out even with a stale token on the page", async ({ page }) => {
    await intoAdminAsBuiltin(page);
    await page.evaluate((stale) => { window.S.csrfToken = stale; }, STALE);
    // PRE-v8.13.4: the logout POST was refused, the session survived and the
    // reload re-authenticated — Logout did nothing.
    await expectSignedOutAfter(page, () => require("./chrome-helpers").pressAccountMenuItem(page, "do-logout"),
      "Logout with a stale token still signs the built-in superadmin out");
  });

  test("Impersonate with a stale token says 'Signed out' rather than a raw refusal over a dead admin panel", async ({ page }) => {
    // The target is made BEFORE the page signs in: the built-in superadmin is
    // single-session, so the page's sign-in purges this context, never the reverse.
    const { api: sa, csrf } = await apiLogin("superadmin");
    let target;
    try { target = await makeParticipant(sa, csrf, "csrfend-ui-imp"); } finally { await sa.dispose(); }

    await intoAdminAsBuiltin(page);
    // Record every toast ever shown: the defect was a toast that fades, so a
    // read after the fact would pass whether or not it had appeared.
    await page.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(ms => {
        for (const m of ms) for (const n of m.addedNodes) {
          const st = document.getElementById("toast-stack");
          if (st && n.nodeType === 1 && st.contains(n)) window.__toasts.push(n.textContent || "");
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.evaluate(({ id, stale }) => {
      window.S.csrfToken = stale;
      window.impersonateParticipant(id, "csrfend-target", "participant");
    }, { id: target.id, stale: STALE });

    await expect(page.locator("#modal-title")).toHaveText("Impersonate participant");
    await page.locator("#modal-confirm-btn").click();

    // The first POST is refused and — since v8.13.4 — ENDS the built-in session,
    // so the one retry (a fresh token, a fresh anonymous session) is refused
    // 401. That is the admin's own session gone, not a refusal to impersonate.
    await expect(page.locator("#modal-title")).toHaveText("Signed out", { timeout: 8_000 });
    expect(await page.evaluate(() => window.__toasts),
      "no raw refusal was toasted over the dead panel").toEqual([]);
    await expectSignedOutAfter(page, () => acceptSignedOut(page), "and the dialog's reload lands on the sign-in card");
  });

  test("an attachment upload with a stale token says 'Signed out', never the raw token in the editor", async ({ page }) => {
    // The challenge editor uploads by XHR, which never passes through the fetch
    // interceptor — so before the pre-release review a refused token rendered as
    // the literal `csrf_invalid` inside the form, over a session the server had
    // already ended. The form and its file input are static markup, so the upload
    // is driven through the function the Upload button calls.
    await intoAdminAsBuiltin(page);
    const zip = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]); // an empty archive
    await page.locator("#tf-attach-file").setInputFiles({ name: "stale.zip", mimeType: "application/zip", buffer: zip });
    await page.evaluate((stale) => {
      window.S.csrfToken = stale;
      window._uploadAttachmentNow();
    }, STALE);

    await expect(page.locator("#modal-title")).toHaveText("Signed out", { timeout: 10_000 });
    expect(await page.locator("#tf-attach-error").textContent(),
      "the raw refusal is not written into the editor").not.toContain("csrf_invalid");
    await expectSignedOutAfter(page, () => acceptSignedOut(page), "and the dialog's reload lands on the sign-in card");
  });

  test("Participant View with a stale token says 'Signed out', never the toggle's own refusal", async ({ page }) => {
    // The toggle is a USER-account door (it is offered only to an account with a
    // `users` row, S.currentUser.id), and it posts through `_sessionTransitionPost`, which bypasses the
    // interceptor. The stale token ENDS the session; the helper's one retry then
    // meets a fresh anonymous session, which this route answers with 403 "Not a
    // user session" — and that raw sentence was toasted over a dead admin panel.
    const { api: sa, csrf } = await apiLogin("superadmin");
    let admin;
    try {
      admin = await makeParticipant(sa, csrf, "csrfend-ui-toggle");
      const rr = await sa.post(`/api/admin/participants/${admin.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { role: "admin" },
      });
      expect(rr.ok(), `PRECONDITION: promote to admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }

    await page.goto("/");
    await loginViaApi(page, admin.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page);
    const toggle = (await require("./chrome-helpers").openAccountMenu(page)).locator('[data-action="toggle-admin-view"][data-on="false"]');
    await expect(toggle, "PRECONDITION: a user-backed admin is offered Participant View").toBeVisible();
    await page.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(ms => {
        for (const m of ms) for (const n of m.addedNodes) {
          const st = document.getElementById("toast-stack");
          if (st && n.nodeType === 1 && st.contains(n)) window.__toasts.push(n.textContent || "");
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.evaluate((stale) => { window.S.csrfToken = stale; }, STALE);
    await toggle.click();

    await expect(page.locator("#modal-title")).toHaveText("Signed out", { timeout: 10_000 });
    expect(await page.evaluate(() => window.__toasts),
      "no raw refusal was toasted over the dead panel").toEqual([]);
    await expectSignedOutAfter(page, () => acceptSignedOut(page), "and the dialog's reload lands on the sign-in card");
  });

  test("a FORM sign-in offers Participant View to a user-backed admin and NOT to the built-in superadmin", async ({ page, browser }) => {
    // v8.13.4 (fix-delta review). `doLogin` assigns the login body to
    // S.currentUser for every sign-in, and the built-in superadmin's body carries
    // no id — it has no `users` row and so no participant view. Offering it the
    // toggle ended in a false "Signed out" over a live session. Only a FORM
    // sign-in reaches this: after a reload, boot reads S.currentUser from
    // /api/me, which the built-in account cannot answer, and the toggle was
    // never offered — which is why the API-login-then-reload tests above never saw it.
    async function formSignIn(p, email, pass) {
      await p.goto("/");
      await p.locator("#login-email").fill(email);
      await fillBreakGlass(p, pass);
      await submitLogin(p);
      await waitForAdminPage(p);
    }
    await formSignIn(page, "superadmin", getSuperadminPass());
    expect(await page.evaluate(() => !!(window.S && window.S.isSuperAdmin && window.S.currentUser)),
      "PRECONDITION: a form sign-in assigned the built-in superadmin's login body to S.currentUser").toBe(true);
    await expect(page.locator('#profile-menu-btn'), "PRECONDITION: the header rendered").toBeVisible();
    const saMenu = await require("./chrome-helpers").openAccountMenu(page);
    await expect(saMenu.locator('[data-action="do-logout"]'), "PRECONDITION: the menu rendered").toBeVisible();
    await expect(saMenu.locator('[data-action="toggle-admin-view"]'),
      "the built-in superadmin is not offered a participant view it does not have").toHaveCount(0);

    // CONTROL — without it "no toggle" is satisfied by a build that offers it to nobody.
    const { api: sa, csrf } = await apiLogin("superadmin");
    let admin;
    try {
      admin = await makeParticipant(sa, csrf, "csrfend-ui-formtoggle");
      const rr = await sa.post(`/api/admin/participants/${admin.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { role: "admin" },
      });
      expect(rr.ok(), `PRECONDITION: promote to admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
    const ctx = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx.newPage();
      await formSignIn(p2, admin.email, PARTICIPANT_PASS);
      await expect((await require("./chrome-helpers").openAccountMenu(p2)).locator('[data-action="toggle-admin-view"][data-on="false"]'),
        "a user-backed admin IS offered Participant View after a form sign-in").toBeVisible();
    } finally { await ctx.close(); }
  });

  test("History words a refused-token sign-out, and every reason an impersonation window closes for", async ({ page }) => {
    // `sessions_invalidated` had no case in the renderer at all, so every row —
    // a role change, a block, and now a refused token — rendered as the bare
    // event type with its reason hidden. The label map for `impersonation_ended`
    // had no words for three reasons the server records. Driven through the
    // renderer the History dialog itself calls.
    await page.goto("/");
    await page.waitForFunction(() => typeof window.formatEventChange === "function");
    const out = await page.evaluate(() => {
      const f = (event_type, details) => window.formatEventChange({ event_type, details });
      return {
        csrf: f("sessions_invalidated", { reason: "csrf_invalid", acting_as: "seat@acme.com", ip: "203.0.113.9" }),
        role: f("sessions_invalidated", { reason: "role_change", purged: 2 }),
        blocked1: f("sessions_invalidated", { reason: "blocked", purged: 1 }),
        pwChanged: f("sessions_invalidated", { reason: "password_changed", purged: 2 }),
        pwReset: f("sessions_invalidated", { reason: "password_reset", purged: 2 }),
        ended: ["csrf_invalid", "login", "linkedin_callback", "password_reset"]
          .map(reason => f("impersonation_ended", { reason, duration_ms: 120000 })),
      };
    });
    expect(out.csrf).toContain("Signed out — a request carried an out-of-date security token while impersonating seat@acme.com");
    expect(out.csrf, "with the address it came from").toContain("203.0.113.9");
    // An admin's role change, block or deny ends EVERY session the account
    // holds — the purge excludes none — so the count is never "other" sessions
    // there (the pre-release review: "1 other session signed out — account
    // blocked" on a participant whose only session it was). A password change
    // keeps the session that asked, so there it IS the others.
    expect(out.role).toContain("Signed out of all 2 sessions — role changed");
    expect(out.blocked1).toContain("Signed out of 1 session — account blocked");
    expect(out.blocked1, "never 'other' for an admin-driven purge").not.toMatch(/\bother\b/);
    expect(out.pwChanged).toContain("2 other sessions signed out — password changed");
    // A RESET is completed from the emailed link's page, whose session is not one
    // of the account's, and the route regenerates — every session ends (the
    // fix-delta review found it worded "other").
    expect(out.pwReset).toContain("Signed out of all 2 sessions — password reset");
    for (const line of out.ended) {
      expect(line, "every reason has words — never the raw `ended (<code>)` fallback").not.toMatch(/ended \(/);
      expect(line).toContain("after 2 min");
    }
    expect(out.ended[0]).toContain("out-of-date security token");
  });
});
