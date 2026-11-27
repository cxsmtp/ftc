// @ts-check
//
// EACH SETTINGS CARD FOLLOWS ITS ROUTE'S PERMISSION, AND SETTINGS OPENS FOR ANY
// OF THEM (operator ruling, 14 Nov 2026).
//
// A custom role given an operations permission gets the card that uses it — and
// only that card — with no request the gate refuses; a role holding none of the
// cards' permissions gets no Settings item at all (CONTROL). A card that edits a
// value also needs the permission that reads it. The built-in admin's view
// (Retention and Alerts) is held in tests/settings-admin-certificates.spec.js.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const settingsItem = (page) => page.locator("li:has(> [data-action='admin-tab'][data-tab-id='admin-settings-tab'])");
const shownCardHeadings = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#admin-settings-tab .settings-card")]
    .filter((c) => c.id !== "settings-load-failure" && c.style.display !== "none")
    .map((c) => (c.querySelector(".settings-heading")?.textContent || "").trim()));

/** Every refused (403) /api/ answer the page sees. */
function recordRefusals(page) {
  const refused = [];
  page.on("response", (r) => { try { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() === 403) refused.push(`${r.request().method()} ${u.pathname}`); } catch (_) { /* not a URL */ } });
  return refused;
}

const U = {};
test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const stamp = Date.now();
    for (const [key, permissions] of [
      ["alerts", ["ops.alerts"]],
      ["mail", ["ops.email"]],
      ["editor", ["settings.view", "settings.edit"]],
      ["none", ["events.view"]],
    ]) {
      const r = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `Cards ${key} ${stamp}`, scope_mode: "all", permissions } });
      expect(r.ok(), `role ${key}: ${await r.text()}`).toBeTruthy();
      const u = await makeParticipant(sa, csrf, `cards${key}`);
      const a = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(csrf), data: { role: (await r.json()).role.id } });
      expect(a.ok(), `assign ${key}: ${await a.text()}`).toBeTruthy();
      U[key] = u;
    }
  } finally { await sa.dispose(); }
});

async function openSettingsAs(page, who) {
  await loginViaApi(page, who.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await expect(settingsItem(page), "Settings is offered").toBeVisible({ timeout: 15000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await page.locator("#admin-settings-tab").waitFor({ state: "visible", timeout: 15000 });
  await expect(page.locator("#settings-section-list li:not([hidden])").first()).toBeAttached({ timeout: 15000 });
}

test("ops.alerts alone: Settings opens with the Alerts card and the release notes (an admin-shaped session's), and no read is refused", async ({ page }) => {
  const refused = recordRefusals(page);
  await openSettingsAs(page, U.alerts);
  await expect.poll(() => shownCardHeadings(page), { timeout: 15000 }).toEqual(["Blocked-address alerts", "Release notes"]);
  await expect(page.locator("#alerts-body"), "the card read its alerts").toContainText(/open alert/i);
  expect(refused, "no request the gate refuses").toEqual([]);
});

test("ops.email alone: the two email cards; the relay status is not read without ops.alerts", async ({ page }) => {
  const refused = recordRefusals(page);
  const alertsReads = [];
  page.on("request", (r) => { if (r.url().includes("/api/admin/alerts")) alertsReads.push(r.url()); });
  await openSettingsAs(page, U.mail);
  await expect.poll(() => shownCardHeadings(page), { timeout: 15000 }).toEqual(["Outbound email", "Unsubscribe list", "Release notes"]);
  await expect(page.locator("#email-relay-status"), "the card says how to check the relay instead").toHaveText("Send a test to check that email arrives.");
  await expect(page.locator("#unsubscribe-list-body"), "the list was read").not.toBeEmpty();
  expect(alertsReads, "no alerts read without ops.alerts").toEqual([]);
  expect(refused, "no request the gate refuses").toEqual([]);
});

test("settings.view + settings.edit: the platform cards it may change, and none of the operations cards", async ({ page }) => {
  const refused = recordRefusals(page);
  await openSettingsAs(page, U.editor);
  await expect.poll(() => shownCardHeadings(page), { timeout: 15000 })
    .toEqual(expect.arrayContaining(["Platform name", "Platform look", "New accounts", "Event team report domains", "Mail server (SMTP)", "This server"]));
  const shown = await shownCardHeadings(page);
  for (const h of ["Outbound email", "Unsubscribe list", "Default Checkmarx One integration", "Event history retention", "Blocked-address alerts", "Checkmarx One account removals"]) {
    expect(shown, `no "${h}" card without its permission`).not.toContain(h);
  }
  // The platform name card is filled from the settings read, by value.
  const { api: sa } = await apiLogin("superadmin");
  try {
    const name = (await (await sa.get("/api/admin/settings")).json()).platform_name;
    await expect(page.locator("#settings-platform-name")).toHaveValue(name);
  } finally { await sa.dispose(); }
  expect(refused, "no request the gate refuses").toEqual([]);
});

test("CONTROL — a role holding none of the cards' permissions gets no Settings item", async ({ page }) => {
  await loginViaApi(page, U.none.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await expect(page.locator("li:has(> [data-tab-id='admin-competitions-tab'])"), "CONTROL: its own item rendered").toBeVisible({ timeout: 15000 });
  await expect(settingsItem(page)).toBeHidden();
});

// THE APPEARANCE PAGE'S ORGANISATION DEFAULT writes the same platform look as the
// Settings "Platform look" card, so it is offered by that card's gate
// (settingsCardOffered("platform-look-card")), never by the built-in tier.
test("settings.view + settings.edit: the Appearance page offers the Organisation default, holding the look in force; a role without them is offered none (control)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { openAppearance } = require("./chrome-helpers");
  const { api: sa, csrf } = await apiLogin("superadmin");
  const DEFAULT = { look: "", mode: "", ambient: "", lock: false };
  try {
    // A look other than the house default, so the select's value says something.
    const r = await sa.put("/api/admin/platform-look", { headers: H(csrf), data: { look: "signature" } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const appearanceAs = async (who) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await loginViaApi(page, who.email, PARTICIPANT_PASS);
      await page.goto("/");
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
      return { ctx, page, overlay: await openAppearance(page) };
    };
    const ed = await appearanceAs(U.editor);
    try {
      await expect(ed.overlay.locator("#ap-org-look"), "the role that may change the platform look is offered the default").toBeVisible();
      await expect(ed.overlay.locator("#ap-org-look"), "…holding the look in force").toHaveValue("signature");
      // In Participant View the session is no longer admin-shaped, so the route
      // would refuse the save: the default is not offered there.
      await ed.page.keyboard.press("Escape");
      await expect(ed.page.locator("#appearance-overlay")).toHaveCount(0);
      const { pressAccountMenuItem } = require("./chrome-helpers");
      await pressAccountMenuItem(ed.page, "toggle-admin-view", "false");
      await expect(ed.page.locator("#admin-page")).toBeHidden({ timeout: 15000 });
      const pv = await openAppearance(ed.page);
      await expect(pv.locator("[data-action='appearance-look']").first(), "PRECONDITION: the page rendered in participant view").toBeVisible();
      await expect(pv.locator("#ap-org-look"), "participant view offers no organisation default").toHaveCount(0);
    } finally { await ed.ctx.close(); }
    const no = await appearanceAs(U.none);
    try {
      await expect(no.overlay.locator("[data-action='appearance-look']").first(), "CONTROL: the page rendered").toBeVisible();
      await expect(no.overlay.locator("#ap-org-look"), "CONTROL: a role without the platform look's permissions is offered no default").toHaveCount(0);
    } finally { await no.ctx.close(); }
  } finally {
    await sa.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT });
    await sa.dispose();
  }
});
