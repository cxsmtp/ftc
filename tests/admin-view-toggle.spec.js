// @ts-check
//
// v7.15.31 — browser coverage for the admin ⇄ participant view toggle.
//
// `POST /api/toggle-admin-view` has solid API coverage, but the CLIENT half had
// none. That half is not cosmetic: `toggleAdminView` (public/js/ui/nav.js) rides
// a session REGENERATION, so it must re-fetch the CSRF token, and on the way
// down to participant view it must stop three admin-only background loops.
//
// The only thing guarding the loop teardown was a source regex:
//
//   expect(read("public/js/ui/nav.js")).toMatch(/S\.scopeBannerInterval[\s\S]{0,200}S\.adminCompPollInterval/)
//
// which passes as long as those two identifiers appear within 200 characters of
// each other — deleting every clearInterval() call keeps it green. The tests
// below replace that with the observable state: the timers are running before
// the toggle (a positive control, without which "null afterwards" proves
// nothing) and stopped after it.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { getSuperadminPass, BASE, codeLogin } = require("./helpers");
const { openAccountMenu, pressAccountMenuItem, accountMenuViewLabel } = require("./chrome-helpers");

test.use({ baseURL: BASE });

async function csrf(req) {
  return (await (await req.get("/api/csrf-token")).json()).csrfToken;
}

async function apiLoginAs(request, email, password) {
  const token = await csrf(request);
  const r = await codeLogin(request, email, { "x-csrf-token": token, "content-type": "application/json" }, { password: password });
  return r;
}

// A user-backed admin, built from scratch so nothing here mutates the shared
// seed fixtures (promoting `carol` in place would leak an admin role into every
// later test on this worker).
async function createUserBackedAdmin(request) {
  const stamp = `${Date.now()}${Math.floor(process.hrtime()[1] / 1000)}`;
  const email = `viewtoggle_${stamp}@acme.com`;
  const password = "ViewToggle!2026";

  let token = await csrf(request);
  const reg = await registerPost(request, "/api/register", {
    headers: { "x-csrf-token": token, "content-type": "application/json" },
    data: {
      firstName: "View", lastName: "Toggle", nickname: `vtoggle_${stamp}`,
      email, company: "Acme Corp", title: "Engineer", country: "US",
      timezone: "America/New_York", jobFunction: "Software Developer / Engineer",
      city: "New York", password,
    },
  });
  expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();

  // Superadmin lifts the account to a verified, approved admin.
  const sa = await apiLoginAs(request, "superadmin", getSuperadminPass());
  expect(sa.ok(), "superadmin login").toBeTruthy();
  const list = await (await request.get(`/api/admin/participants?search=${encodeURIComponent(email)}&limit=50`)).json();
  const user = (list.participants || []).find(p => p.email === email);
  expect(user, "the new account must be findable").toBeTruthy();

  for (const path of [`verify`, `approve`]) {
    token = await csrf(request);
    await request.post(`/api/admin/participants/${user.id}/${path}`, { headers: { "x-csrf-token": token } });
  }
  token = await csrf(request);
  const role = await request.post(`/api/admin/participants/${user.id}/role`, {
    headers: { "x-csrf-token": token, "content-type": "application/json" },
    data: { role: "admin" },
  });
  expect(role.ok(), `promote to admin: ${role.status()} ${await role.text()}`).toBeTruthy();

  // Log the superadmin back out so the caller's context is clean — the platform
  // enforces one session per user, and leaving this context signed in as
  // superadmin would silently authenticate the page as the wrong identity.
  token = await csrf(request);
  await request.post("/api/admin/logout", { headers: { "x-csrf-token": token } });
  return { email, password, id: user.id };
}

async function adminPageFor(page, email, password) {
  const r = await apiLoginAs(page.request, email, password);
  expect(r.ok(), `login ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => typeof window.toggleAdminView === "function", { timeout: 20000 });
}

// Read the three admin-only interval handles out of live state.
const TIMERS = ["adminCompPollInterval", "scopeBannerInterval"];
async function timerState(page) {
  return page.evaluate((keys) => {
    const out = {};
    for (const k of keys) out[k] = window.S[k] == null ? null : "running";
    return out;
  }, TIMERS);
}

test.describe("Admin ⇄ participant view toggle (v7.15.31)", () => {
  test("switching to Participant View stops every admin-only background loop", async ({ page }) => {
    const admin = await createUserBackedAdmin(page.request);
    await adminPageFor(page, admin.email, admin.password);

    // Drive the app into the state where all three loops are genuinely
    // running, using the real starters rather than planting handles.
    await page.evaluate(() => window.loadAdminCompetitions());
    await page.waitForFunction(() => (window.S.adminCompetitionsData || []).length > 0, { timeout: 15000 });
    const scoped = await page.evaluate(() => {
      // A LIVE/upcoming competition: the header-timer tick clears its own
      // interval once a competition has ended, which would race the assertion
      // below and make it look flaky rather than wrong.
      const comps = window.S.adminCompetitionsData;
      const comp = comps.find(c => c.name === "Test Live")
        || comps.find(c => (c.status || "") !== "ended")
        || comps[0];
      // renderScopeBanner only arms its interval when BOTH the id and the name
      // are set — it reads the name to decide the banner is meaningful.
      window.S.adminSelectedCompetitionId = comp.id;
      window.S.adminSelectedCompetitionName = comp.name;
      window.renderScopeBanner();          // → scopeBannerInterval (the workspace's live strip)
      window.startAdminCompPoll();         // → adminCompPollInterval
      return comp.name;
    });
    expect(scoped, "a competition must be in scope for the banner loop to arm").toBeTruthy();

    // POSITIVE CONTROL. Without this the assertion after the toggle is
    // satisfied by timers that were never started, which is precisely how the
    // old source regex managed to prove nothing.
    const before = await timerState(page);
    for (const k of TIMERS) {
      expect(before[k], `${k} must be RUNNING before the toggle, or the test below is vacuous`).toBe("running");
    }

    // The view item lives in the account menu (tests/chrome-helpers.js).
    const menu = await openAccountMenu(page);
    const toggle = menu.locator("[data-action='toggle-admin-view']");
    await expect(toggle, "an admin backed by a real user account gets the toggle").toBeVisible();
    await expect(toggle).toHaveText("Switch to Participant View");
    await toggle.click();

    // The participant shell takes over.
    await expect(page.locator("#admin-page")).toBeHidden({ timeout: 15000 });
    await expect.poll(() => accountMenuViewLabel(page), { timeout: 15000 }).toBe("Switch to Admin View");

    await expect.poll(async () => (await timerState(page)).adminCompPollInterval, { timeout: 10000 }).toBeNull();
    const after = await timerState(page);
    for (const k of TIMERS) {
      expect(after[k],
        `${k} still running in participant view — it polls an admin endpoint under a session that is no longer admin`
      ).toBeNull();
    }
  });

  test("the toggle refreshes CSRF across the session regeneration, so the way back works", async ({ page }) => {
    const admin = await createUserBackedAdmin(page.request);
    await adminPageFor(page, admin.email, admin.password);

    await pressAccountMenuItem(page, "toggle-admin-view", "false");
    await expect(page.locator("#admin-page")).toBeHidden({ timeout: 15000 });
    await expect.poll(() => accountMenuViewLabel(page), { timeout: 15000 }).toBe("Switch to Admin View");

    // Toggling back is itself a CSRF-protected POST on the REGENERATED session.
    // If toggleAdminView had not re-fetched the token, this 403s and the user
    // is stranded in participant view with no way back short of a reload.
    await pressAccountMenuItem(page, "toggle-admin-view", "true");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => accountMenuViewLabel(page), { timeout: 15000 }).toBe("Switch to Participant View");

    // Admin privileges are real again, not just repainted.
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isAdmin, "the server agrees this session is an admin again").toBeTruthy();

    // And the admin poll is back — the teardown must be reversible.
    await expect.poll(async () => page.evaluate(() => window.S.adminCompPollInterval == null),
      { timeout: 10000 }).toBe(false);
  });

  test("a plain participant is offered no view toggle", async ({ page }) => {
    const r = await apiLoginAs(page.request, "alice@acme.com", require("./helpers").PARTICIPANT_PASS);
    expect(r.ok(), `alice login: ${r.status()}`).toBeTruthy();
    await page.goto("/");
    await page.waitForFunction(() => typeof window.toggleAdminView === "function", { timeout: 20000 });
    // viewSwitchOffered (public/js/ui/nav.js) offers the item to an admin tier
    // only; its absence is what stops a participant even attempting the
    // privilege transition. The item lives in the account menu, so open it.
    const menu = await openAccountMenu(page);
    await expect(menu.locator("[data-action='do-logout']"), "CONTROL: the menu rendered").toBeVisible();
    await expect(menu.locator("[data-action='toggle-admin-view']")).toHaveCount(0);
  });

  test("the built-in superadmin has no user account, so it gets no participant view", async ({ page }) => {
    // viewSwitchOffered also needs a user account (S.currentUser.id). The
    // built-in superadmin is not a row in `users`, so there is no participant
    // identity to switch into — offering the item would produce a toggle that
    // cannot work.
    const r = await apiLoginAs(page.request, "superadmin", getSuperadminPass());
    expect(r.ok(), "superadmin login").toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    const menu = await openAccountMenu(page);
    await expect(menu.locator("[data-action='do-logout']"), "CONTROL: the menu rendered").toBeVisible();
    await expect(menu.locator("[data-action='toggle-admin-view']")).toHaveCount(0);
  });
});
