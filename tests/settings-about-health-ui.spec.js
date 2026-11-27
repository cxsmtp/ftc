// @ts-check
//
// SETTINGS → ABOUT & HEALTH ON SCREEN, AND THE VERSION AT THE SIDEBAR'S FOOT
// (features/settings-admin.js loadSystemHealthCard / loadReleaseNotesCard /
// showSidebarVersion; owner decision, 27 Nov 2026: no placeholders, every
// figure from a route; the version on the left, not in the account menu).
//
// By value against the routes the page reads:
//   • "This server" shows the version, build, release channel, database checks,
//     mail relay, backups and retention GET /api/admin/system-health answers;
//   • the release notes card shows the newest version GET /docs/release-notes.md
//     holds, its headings under the card's (no axe heading-order break);
//   • the sidebar's foot says "Version <v>" (GET /api/config), and "v<major.minor>"
//     while the sidebar is collapsed, the full text kept for screen readers; the
//     account menu no longer carries a version;
//   • axe-clean, light and dark.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { loginViaApi, openSettingsSection, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { openAccountMenu } = require("./chrome-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

async function openAboutHealth(page) {
  await loginViaApi(page, "superadmin");
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await page.locator("#admin-settings-tab").waitFor({ state: "visible", timeout: 15000 });
  await openSettingsSection(page, "health");
  await expect(page.locator("#system-health-body .settings-facts-list").first()).toBeVisible({ timeout: 15000 });
}
const fact = (page, label) => page.locator("#system-health-body .settings-facts-list > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");

test("This server shows the route's figures, by value", async ({ page }) => {
  await openAboutHealth(page);
  const d = await (await page.request.get("/api/admin/system-health")).json();
  await expect(fact(page, "Version")).toHaveText(d.version);
  expect(d.build.commit, "PRECONDITION: the test server is no release image").toBeNull();
  await expect(fact(page, "Build")).toHaveText("Unknown (not a release image)");
  await expect(fact(page, "Release channel")).toHaveText("Unknown (not a release image)");
  await expect(fact(page, "Database check")).toHaveText(d.database_integrity_ok ? "Passed at start-up" : /Failed/);
  await expect(fact(page, "Maintenance mode")).toHaveText(d.maintenance ? "On" : "Off");
  await expect(fact(page, "Mail relay")).toHaveText(d.smtp_healthy === null ? "Not checked yet" : /Answering|Not answering/);
  expect(d.backups, "PRECONDITION: no backups folder is mounted on the test server").toEqual({ visible: false, reason: "not_configured" });
  await expect(fact(page, "Backups")).toContainText("Not visible to the app");
  await expect(fact(page, "Event history kept")).toHaveText(`${d.event_retention_days} days`);
  await expect(fact(page, "Data volume")).toHaveText(typeof d.data_free_gib === "number" ? `${d.data_free_gib} GiB free` : "Could not be read");
  await expect(fact(page, "Node.js"), "a superadmin's detail").toHaveText(d.node_version);
  await expect(fact(page, "Database size")).toContainText(typeof d.database_size_mib === "number" ? `${d.database_size_mib} MiB` : "Could not be read");
  // Nothing on the card is a placeholder dash.
  const dds = await page.locator("#system-health-body dd").allTextContents();
  expect(dds.filter((t) => !t.trim() || t.trim() === "—"), "every fact has a value").toEqual([]);
});

test("the release notes card shows the newest version, under the card's heading", async ({ page }) => {
  await openAboutHealth(page);
  const md = await (await page.request.get("/docs/release-notes.md")).text();
  const newest = (md.match(/^## (.+)$/m) || [])[1];
  expect(newest, "PRECONDITION: the document names a version").toBeTruthy();
  await expect(page.locator("#release-notes-body h4").first()).toHaveText(newest.trim());
  expect(await page.locator("#release-notes-body h2, #release-notes-body h3").count(), "no heading above the card's own level").toBe(0);
  await expect(page.locator("#release-notes-card [data-action='release-notes-open']")).toBeVisible();
});

test("the version sits at the sidebar's foot, short when collapsed, and not in the account menu", async ({ page }) => {
  await openAboutHealth(page);
  const v = (await (await page.request.get("/api/config")).json()).version;
  const foot = page.locator("#admin-sidebar-version");
  await expect(foot).toBeVisible();
  await expect(foot.locator(".asv-long")).toHaveText(`Version ${v}`);
  await expect(foot.locator(".asv-short"), "the short form waits for the collapsed sidebar").toBeHidden();
  // Geometry: at the foot of the sidebar, below its last item.
  const g = await page.evaluate(() => {
    const f = document.getElementById("admin-sidebar-version").getBoundingClientRect();
    const items = [...document.querySelectorAll("#admin-sidebar .admin-nav-item")].filter((b) => b.getBoundingClientRect().height > 0);
    return { footTop: f.top, lastBottom: Math.max(...items.map((b) => b.getBoundingClientRect().bottom)) };
  });
  expect(g.footTop, "below the last sidebar item").toBeGreaterThanOrEqual(g.lastBottom);
  await page.locator("#admin-sidebar-toggle").click();
  await expect(page.locator("#admin-sidebar.collapsed")).toBeVisible();
  await expect(foot.locator(".asv-short")).toHaveText(`v${v.split(".").slice(0, 2).join(".")}`);
  await expect(foot.locator(".asv-short")).toBeVisible();
  const longBox = await foot.locator(".asv-long").evaluate((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, text: el.textContent }; });
  expect(longBox.text, "the full version stays for screen readers").toBe(`Version ${v}`);
  expect(longBox.w * longBox.h, "…visually hidden").toBeLessThanOrEqual(1);
  await page.locator("#admin-sidebar-toggle").click();   // restore the per-browser choice
  await openAccountMenu(page);
  await expect(page.locator("#profile-menu-overlay")).not.toContainText(v);
  await expect(page.locator("#profile-menu-overlay [data-action='do-logout']"), "CONTROL: the menu is open").toBeVisible();
});

for (const theme of ["light", "dark"]) {
  test(`About & health is axe-clean (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await openAboutHealth(page);
    await expect(page.locator("#release-notes-body h4").first()).toBeVisible({ timeout: 15000 });
    const res = await new AxeBuilder({ page }).include("#admin-settings-tab").include("#admin-sidebar").analyze();
    const bad = res.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
