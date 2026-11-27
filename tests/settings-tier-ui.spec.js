// @ts-check
//
// v7.26.0 — the Settings tab is superadmin-only, in the UI as well as on the wire.
//
// The server half is locked in tests/email-sender-name.spec.js (a regular admin
// gets 403 from `PATCH /api/admin/settings`). This file locks the CLIENT half,
// which had no coverage at all. Three gating changes ship in v7.26.0 and each of
// these mutations passed the ENTIRE suite before this spec existed:
//
//   (a) `settingsLi.style.display = ''` — a regular admin gets a Settings tab
//       whose three cards are all hidden, i.e. an empty pane, which is exactly
//       the "an empty tab reads as a broken feature" failure (v7.14.2) that the
//       nav code cites as its own justification;
//   (b) deleting the platform-name card's gate — a regular admin sees the input
//       and the Save button, and Save 403s: affordance without permission;
//   (c) inverting either ternary — a SUPERADMIN loses the tab.
//
// Both directions are asserted, because `buildAdminNav()` re-runs on the
// participant-view toggle and a one-way hide would never come back.
//
// The nearest existing assertion cannot see any of this: `ui-admin-rankings`
// counts `.admin-nav-item`, which selects the BUTTON while the gate hides the
// enclosing `<li>` (so the count is unchanged at 9), and it runs as a superadmin.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");
const { adminLogin, openSettingsSection } = require("./ui-admin-helpers");

// Route page.goto() and page.request.* at THIS worker's server rather than a
// config-level default, which would collapse every worker onto one port.
test.use({ baseURL: BASE });

/** Mint a verified + approved REGULAR admin and return usable credentials. */
async function makeRegularAdmin(tag) {
  const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
  const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const email = `stier${tag}-${stamp}@acme.com`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: { "x-csrf-token": ac, "content-type": "application/json" },
    data: {
      firstName: "S", lastName: "Tier", nickname: `stier${tag}${stamp}`, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC",
    },
  });
  expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  await anon.dispose();
  const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
    .participants.find(p => p.email === email);
  expect(u, "the freshly-registered admin-to-be must be findable").toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: h });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: h });
  const roleR = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: h, data: { role: "admin" } });
  expect(roleR.ok(), `promote to admin: ${roleR.status()}`).toBeTruthy();
  return { email, password: PARTICIPANT_PASS, id: u.id };
}

/** Sign the BROWSER in as a REGULAR admin and land on the admin panel. */
async function regularAdminLogin(page, email, password) {
  const doPost = async () => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: password });
  };
  let r = await doPost();
  if (!r.ok()) { await page.waitForTimeout(300); r = await doPost(); }
  expect(r.ok(), `login ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  // buildAdminNav() renders asynchronously. Competitions is present for both
  // tiers, so it is the settled-nav signal — never Settings, which is the thing
  // under test.
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']")
    .first().waitFor({ state: "visible", timeout: 30000 });
}

const settingsNavItem = (page) =>
  page.locator("li:has(> [data-action='admin-tab'][data-tab-id='admin-settings-tab'])");

test.describe("the Settings tab: offered to a regular admin, its superadmin-only cards hidden", () => {
  // 8.17.0 — the operator ruled that admins edit the platform certificate
  // design, so Settings is now OFFERED to a regular admin (settings.view /
  // certificates.design) and its superadmin-only cards hide themselves (the
  // third test below, and tests/settings-admin-certificates.spec.js by value).
  test("a REGULAR admin has the Settings nav item (for the certificate designer)", async ({ page }) => {
    const admin = await makeRegularAdmin("nav");
    await regularAdminLogin(page, admin.email, admin.password);

    // PRECONDITIONS, asserted rather than assumed: without these, "no Settings
    // item" is equally satisfied by a failed login or a participant view.
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isAdmin, "the fixture IS an admin").toBe(true);
    expect(me.isSuperAdmin, "...and is NOT a superadmin").toBeFalsy();
    await expect(page.locator("[data-action='admin-tab'][data-tab-id='admin-tasks-tab']").first(),
      "the admin sidebar really rendered").toBeVisible();

    await expect(settingsNavItem(page), "Settings is shown to a regular admin").toBeVisible();
  });

  test("a SUPERADMIN still has it — and the card explains what the name reaches", async ({ page }) => {
    // The other direction. Without this, a mutation that hides the item
    // unconditionally passes the test above.
    await adminLogin(page);
    const me = await (await page.request.get("/api/admin/me")).json();
    expect(me.isSuperAdmin, "the control really is a superadmin").toBe(true);

    await expect(settingsNavItem(page), "Settings IS shown for a superadmin").toBeVisible();
    await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
    await expect(page.locator("#platform-name-card")).toBeVisible();
    await expect(page.locator("#settings-platform-name")).toBeVisible();
    // v7.14.2 — gate the affordance and the EXPLANATION together. The card had
    // no help text at all while the value already drove the header, the subjects
    // and the badge page; it now also sets the sender name, so it says so.
    await expect(page.locator("#platform-name-card .settings-help")).toContainText(/sender name/i);
    // The client cap must match the server's 120, not the old 80 — the form must
    // not silently refuse a name the API would accept.
    await expect(page.locator("#settings-platform-name")).toHaveAttribute("maxlength", "120");
  });

  test("the New accounts card says what is true of every account: an emailed code makes it, not how it signs in", async ({ page }) => {
    // Accounts may sign in with a password (a profile choice), so a card saying
    // every account signs in with an emailed code is false.
    await adminLogin(page);
    await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
    await openSettingsSection(page, "accounts");
    const help = page.locator("#account-approval-card .settings-help");
    await expect(help).toBeVisible();
    await expect(help).toHaveText("A new account is made once its owner confirms the address with an emailed code. Hold new accounts for approval, or let them play straight away.");
    await expect(help).not.toContainText("Every account signs in with an emailed code");
  });

  test("the platform-name card carries its OWN gate, not just the hidden nav item", async ({ page }) => {
    // Defence in depth: `loadAdminSettings` gates all three cards, so the pane is
    // correct even if it is reached some other way. Driven by calling the loader
    // directly, because the nav item that would normally invoke it is (correctly)
    // not there for this tier.
    const admin = await makeRegularAdmin("card");
    await regularAdminLogin(page, admin.email, admin.password);

    const ran = await page.evaluate(async () => {
      if (typeof window.loadAdminSettings !== "function") return false;
      await window.loadAdminSettings();
      return true;
    });
    expect(ran, "loadAdminSettings is reachable on window — else this test proves nothing").toBe(true);

    for (const id of ["#platform-name-card", "#account-approval-card", "#cxone-card", "#unsubscribe-card"]) {
      expect(await page.locator(id).evaluate(el => el.style.display),
        `${id} is display:none for a regular admin`).toBe("none");
    }
  });
});
