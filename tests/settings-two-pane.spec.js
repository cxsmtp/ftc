"use strict";

// SETTINGS IN TWO PANES (settings-admin.js installSettingsShell): a section list
// beside ONE section, a <select> picker on phones, the chosen section
// remembered per browser.
//
// What it locks:
//   • every section the built-in superadmin (the break-glass session) is owed is
//     listed and reachable, and choosing one shows it ALONE (the others hidden);
//   • each section is compact: at 1440x900 the page is no taller than 1.5 x the
//     viewport, measured per section (geometry, not markup);
//   • the list is built from the markup: a card dropped into the content column
//     outside any section is adopted and rendered (the other lane's
//     "Platform look" card), with a CONTROL that an unclaimed hidden card adds
//     no list entry;
//   • a save still works (Save Name, read back from the server; the default
//     restored in a finally);
//   • phone 390: the picker replaces the list, switches sections, and nothing
//     scrolls sideways;
//   • the remembered section survives a reload;
//   • the list is grouped under PEOPLE, RECORDS and SYSTEM captions (not
//     buttons), its link items open the page they name (People, Groups, Roles &
//     permissions, Audit log) or the guides (Get help), and a link to a page the
//     role is not offered is not listed (CONTROL: a role with settings.view
//     alone);
//   • CxOne API audit opens the Audit page searching for Checkmarx One.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, clickTab, openSettingsSection } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const EXPECTED = ["signin", "cxone-audit", "general", "branding", "email", "updates", "health", "about"];
// The whole list as rendered, captions and link items included, in order.
const EXPECTED_MENU = [
  "PEOPLE", "People", "Groups", "Roles & permissions", "Sign-in",
  "RECORDS", "Audit log", "CxOne API audit",
  "SYSTEM", "General", "Branding", "Email (SMTP)", "Updates", "Backups & health", "Get help", "About",
];

async function openSettings(page) {
  await clickTab(page, "Settings");
  // The superadmin cards are shown by the loader; wait until the list settles
  // on every section this session is owed (break-glass loads last).
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("#settings-section-list li:not([hidden]) [data-section]")].map((b) => b.dataset.section)),
    { timeout: 15000 }).toEqual(EXPECTED);
}

test("every section is listed, reachable alone, and fits in 1.5 viewports at 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openSettings(page);
  for (const key of EXPECTED) {
    await openSettingsSection(page, key);
    const g = await page.evaluate((k) => {
      const secs = [...document.querySelectorAll("#admin-settings-tab .settings-section")];
      const shown = secs.filter((s) => getComputedStyle(s).display !== "none").map((s) => s.dataset.settingsSection);
      const cur = document.querySelector('#settings-section-list [aria-current="true"]');
      return { shown, current: cur && cur.dataset.section, pageH: document.documentElement.scrollHeight, vh: window.innerHeight,
        cardsShown: [...document.querySelectorAll(`#admin-settings-tab .settings-section[data-settings-section="${k}"] .settings-card`)]
          .filter((c) => c.getBoundingClientRect().height > 0).length };
    }, key);
    expect(g.shown, `only ${key} is on screen: ${JSON.stringify(g)}`).toEqual([key]);
    expect(g.current, "the list marks the section it shows").toBe(key);
    expect(g.cardsShown, `${key} renders at least one card`).toBeGreaterThan(0);
    expect(g.pageH, `${key} is compact: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.vh * 1.5);
  }
});

test("a card added to the content column outside any section is adopted and listed", async ({ page }) => {
  await adminLogin(page);
  await openSettings(page);
  const r = await page.evaluate(async () => {
    const bento = document.querySelector("#admin-settings-tab .settings-bento");
    const mk = (id, section, hidden) => {
      const c = document.createElement("div");
      c.className = "card settings-card"; c.id = id;
      if (section) c.setAttribute("data-settings-section", section);
      if (hidden) c.style.display = "none";
      c.appendChild(document.createElement("h3")).textContent = id;
      bento.appendChild(c);
    };
    mk("probe-look-card", null, false);          // the other lane's shape: no section named
    mk("probe-hidden-card", "nowhere", true);    // CONTROL: hidden, unknown section
    await new Promise((res) => setTimeout(res, 50));
    return {
      lookIn: document.getElementById("probe-look-card").closest(".settings-section")?.dataset.settingsSection || null,
      sections: [...document.querySelectorAll("#settings-section-list li:not([hidden]) [data-section]")].map((b) => b.dataset.section),
    };
  });
  expect(r.lookIn, "an unclaimed card lands in General").toBe("general");
  expect(r.sections, "CONTROL: a hidden card adds no entry, and the list is unchanged").toEqual(EXPECTED);
  await openSettingsSection(page, "general");
  await expect(page.locator("#probe-look-card")).toBeVisible();
});

test("Save Name still saves from its section; the default is restored afterwards", async ({ page }) => {
  const name = `Two Pane ${Date.now().toString(36).slice(-6)}`;
  try {
    await adminLogin(page);
    await openSettings(page);
    await openSettingsSection(page, "general");
    await page.locator("#settings-platform-name").fill(name);
    const saved = page.waitForResponse((x) => x.url().includes("/api/admin/settings") && x.request().method() === "PATCH");
    await page.locator('[data-action="save-platform-name"]').click();
    expect((await saved).ok(), "the PATCH succeeded").toBe(true);
    const d = await (await page.request.get("/api/admin/settings")).json();
    expect(d.platform_name, "the server holds the new name").toBe(name);
  } finally {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const r = await sa.patch("/api/admin/settings", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { platform_name: "Checkmarx Enablement Platform" } });
      expect(r.ok(), `restore: ${await r.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
  }
});

test("the chosen section is remembered across a reload", async ({ page }) => {
  await adminLogin(page);
  await openSettings(page);
  await openSettingsSection(page, "email");
  await page.reload();
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await clickTab(page, "Settings");
  await expect(page.locator('#admin-settings-tab .settings-section[data-settings-section="email"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#admin-settings-tab .settings-section[data-settings-section="general"]'), "CONTROL: the default is not also shown").toBeHidden();
});

test("phone 390: a section picker replaces the list and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await adminLogin(page);
  await openSettings(page);
  const pick = page.locator("#settings-section-pick");
  await expect(pick).toBeVisible();
  await expect(page.locator("#settings-section-list"), "the desktop list steps aside").toBeHidden();
  for (const key of ["cxone-audit", "email", "health", "general"]) {
    await pick.selectOption(key);
    await expect(page.locator(`#admin-settings-tab .settings-section[data-settings-section="${key}"]`)).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over, `${key}: no sideways page scroll`).toBeLessThanOrEqual(0);
    const wide = await page.evaluate(() => [...document.querySelectorAll("#admin-settings-tab .settings-section:not([hidden]) *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(".cxone-wd-scroll")).map((el) => el.id || el.className).slice(0, 5));
    expect(wide, `${key}: nothing pokes past the right edge`).toEqual([]);
  }
});

// The rendered menu: captions are headings, never buttons; every item is a button.
const menuText = (page) => page.evaluate(() => [...document.querySelectorAll("#settings-section-list .settings-nav-group:not([hidden])")].flatMap((g) => [
  (g.querySelector(".settings-nav-caption")?.textContent || "").trim().toUpperCase(),
  ...[...g.querySelectorAll("li:not([hidden]) > button")].map((b) => (b.firstChild?.textContent || "").trim()),
]));

test("the list is grouped under People, Records and System, with link items in place", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openSettings(page);
  await expect.poll(() => menuText(page), { timeout: 15000 }).toEqual(EXPECTED_MENU);
  const shape = await page.evaluate(() => ({
    captionsAreButtons: [...document.querySelectorAll("#settings-section-list .settings-nav-caption")].filter((c) => c.closest("button,[role=button]") || c.tagName === "BUTTON").length,
    captions: document.querySelectorAll("#settings-section-list .settings-nav-caption").length,
    listsNamed: [...document.querySelectorAll("#settings-section-list ul")].every((ul) => document.getElementById(ul.getAttribute("aria-labelledby") || "")),
  }));
  expect(shape.captions, "three captions").toBe(3);
  expect(shape.captionsAreButtons, "a caption is not a button").toBe(0);
  expect(shape.listsNamed, "each group's list is named by its caption").toBe(true);
});

test("a link item opens its page through the sidebar's door; Get help opens the guides", async ({ page }) => {
  await adminLogin(page);
  for (const [key, pane] of [["teams", "#admin-groups-tab"], ["roles", "#admin-users-tab"], ["people", "#admin-participants-tab"], ["audit", "#admin-audit-tab"]]) {
    await openSettings(page);
    await page.locator(`#settings-section-list [data-action="settings-link"][data-settings-link="${key}"]`).click();
    await expect(page.locator(pane), `${key} opens its page`).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#admin-settings-tab"), `CONTROL: ${key} left Settings`).toBeHidden();
  }
  await openSettings(page);
  await page.locator('#settings-section-list [data-action="settings-link"][data-settings-link="help"]').click();
  await expect(page.locator("#help-drawer-overlay"), "Get help opens the help drawer").toBeVisible({ timeout: 15000 });
});

test("CxOne API audit opens the Audit page searching for Checkmarx One activity", async ({ page }) => {
  await adminLogin(page);
  await openSettings(page);
  await openSettingsSection(page, "cxone-audit");
  const read = page.waitForRequest((r) => r.url().includes("/api/admin/audit?") && new URL(r.url()).searchParams.get("q") === "Checkmarx One");
  await page.locator('[data-action="settings-open-cxone-audit"]').click();
  await expect(page.locator("#admin-audit-tab")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#audit-search")).toHaveValue("Checkmarx One");
  const q = new URL((await read).url()).searchParams;
  expect(q.get("q_event_types") || "", "the search names the Checkmarx One activity keys").toContain("cxone_provisioned");
});

test("CONTROL — a role holding settings.view alone is offered no link to a page it cannot open", async ({ page }) => {
  const { PARTICIPANT_PASS } = require("./helpers");
  const { loginViaApi } = require("./ui-admin-helpers");
  const { H, makeParticipant } = require("./event-admin-helpers");
  const { api: sa, csrf } = await apiLogin("superadmin");
  let who;
  try {
    const r = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `Settings only ${Date.now()}`, scope_mode: "all", permissions: ["settings.view"] } });
    expect(r.ok(), `role: ${await r.text()}`).toBeTruthy();
    who = await makeParticipant(sa, csrf, "setonly");
    const a = await sa.patch(`/api/admin/users/${who.id}/role`, { headers: H(csrf), data: { role: (await r.json()).role.id } });
    expect(a.ok(), `assign: ${await a.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
  await loginViaApi(page, who.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  // POSITIVE: its own section (Backups & health reads settings.view) and Get help.
  await expect.poll(() => menuText(page), { timeout: 15000 }).toEqual(expect.arrayContaining(["Backups & health", "Get help"]));
  const menu = await menuText(page);
  for (const gone of ["People", "Groups", "Roles & permissions", "Audit log", "CxOne API audit", "RECORDS"]) expect(menu, `no "${gone}" for a role that cannot open it`).not.toContain(gone);
});
