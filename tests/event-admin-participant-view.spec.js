"use strict";

// v8.7.3 — AN EVENT ADMIN SWITCHES TO PARTICIPANT VIEW, IN A REAL BROWSER.
//
// The reported defects, both reproduced against a real server before anything
// was changed, and neither catchable by anything in the suite today: the
// event-admin specs never leave `#admin-page`, and `admin-view-toggle.spec.js`
// drives a GLOBAL admin only.
//
//   1. "Could not load your competitions. The server did not respond
//      correctly." — an admin whose profile is incomplete lands in a
//      participant view where every one of 18 endpoints refuses, and is told
//      the server malfunctioned. The completion gate is admin-exempt at both
//      of its proactive sites, so nothing had ever asked them to fix it.
//   2. No **Admin View** button — `buildParticipantNav` gated it on
//      `admin || superadmin`, so an event admin who switched down had no way
//      back except a page reload.
//
// And one the class sweep found, which is the same round trip the report
// describes: `POST /api/toggle-admin-view` omitted `isEventAdmin`, and the
// client does `S.isEventAdmin=!!d.isEventAdmin` — so ONE trip through
// participant view silently gave the event admin a GLOBAL admin's panel.
//
// EVERY assertion here is paired with a control, because each has a build that
// satisfies it trivially:
//   • "the Admin View button renders"  ← a PARTICIPANT must not get one, or a
//     build that shows it to everybody passes.
//   • "Users & roles stays hidden after the round trip"  ← a REGULAR ADMIN must
//     still SEE Users & roles after the identical round trip, or a build that
//     hid it from everyone below superadmin passes.
//   • "the incomplete admin is stopped and told why"  ← the COMPLETE admin must
//     sail through with no modal, or a build that blocks participant view
//     outright passes.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const {
  H, makeParticipant, makeCompetition, enrol, grantEventAdmin, makeInvitedFreeEmailUser,
} = require("./event-admin-helpers");
const { apiLogin } = require("./helpers");

test.use({ baseURL: BASE });

const ADMIN_VIEW_BTN = "[data-action='toggle-admin-view'][data-on='true']";
const PARTICIPANT_VIEW_BTN = "[data-action='toggle-admin-view'][data-on='false']";
// The view items live in the account menu (tests/chrome-helpers.js).
const { openAccountMenu } = require("./chrome-helpers");
const inMenu = async (page, sel) => (await openAccountMenu(page)).locator(sel);
// Users & roles is shown to every global admin and never to the event-admin
// tier, so it carries this lock's tier signal (the Raw logs switch has its own
// lock in tests/event-admin-ui.spec.js).
const USERS_NAV = ".admin-nav-item[data-tab-id='admin-users-tab']";

/** Admin readiness: `.admin-nav-item` is STATIC markup, so `attached` is true
 *  before boot has resolved who we are (v8.3.33). Visible is the real signal. */
async function bootAdmin(page) {
  await page.goto("/");
  await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30000 });
}

/** Participant readiness: wait for a nav BUTTON, which cannot exist until
 *  buildParticipantNav has run (v8.6.4) — `#main-nav` itself ships static. */
async function waitParticipantNav(page) {
  await page.waitForSelector("#nav-competitions", { state: "visible", timeout: 30000 });
}

let world;

test.beforeAll(async () => {
  const s = await apiLogin("superadmin");
  const sa = s.api, saCsrf = s.csrf;

  const mine = await makeCompetition(sa, saCsrf, "pvui-mine");

  const ea = await makeParticipant(sa, saCsrf, "pvui-ea");
  await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
  await enrol(sa, saCsrf, mine.id, [ea.id]);
  // v8.12.0 — an admin enrolled in exactly ONE event is landed straight in it
  // when they switch to participant view (the sole-event landing, applied to
  // the toggle), so a test that needs the PICKER must give them a second event
  // (fixture-checklist item 10). The subject here is the picker's request
  // succeeding and listing their event, so `ea` holds two rows.
  const mine2 = await makeCompetition(sa, saCsrf, "pvui-mine2");
  await grantEventAdmin(sa, saCsrf, mine2.id, ea.id);
  await enrol(sa, saCsrf, mine2.id, [ea.id]);

  const plainAdmin = await makeParticipant(sa, saCsrf, "pvui-admin");
  const rr = await sa.post(`/api/admin/participants/${plainAdmin.id}/role`, {
    headers: H(saCsrf), data: { role: "admin" },
  });
  expect(rr.ok(), `promote to admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();

  const participant = await makeParticipant(sa, saCsrf, "pvui-plain");
  await enrol(sa, saCsrf, mine.id, [participant.id]);

  const incompleteEa = await makeInvitedFreeEmailUser(sa, saCsrf, "pvui-inc");
  await grantEventAdmin(sa, saCsrf, mine.id, incompleteEa.id);

  // Preconditions asserted, not assumed — a fixture that silently failed makes
  // every assertion below report the wrong thing.
  const l = await apiLogin(ea.email, PARTICIPANT_PASS);
  const me = await (await l.api.get("/api/admin/me")).json();
  expect(me.isEventAdmin, "the fixture really holds the event-admin tier").toBe(true);
  const inc = await apiLogin(incompleteEa.email, PARTICIPANT_PASS);
  const incMe = await (await inc.api.get("/api/me")).json();
  expect(incMe.missing_fields, "the invited fixture really is incomplete").toContain("corporate_email");
  await l.api.dispose(); await inc.api.dispose(); await sa.dispose();

  world = { mine, ea, plainAdmin, participant, incompleteEa };
});

test.describe("v8.7.3 — the participant view an event admin can actually use", () => {
  test("an event admin switches down, sees their events, and can get back", async ({ page }) => {
    const toasts = [];
    page.on("response", async r => {
      if (new URL(r.url()).pathname === "/api/my-competitions") toasts.push(`my-competitions -> ${r.status()}`);
    });

    await loginViaApi(page, world.ea.email, PARTICIPANT_PASS);
    await bootAdmin(page);

    await (await inMenu(page, PARTICIPANT_VIEW_BTN)).click();
    await waitParticipantNav(page);

    // The reported symptom, asserted as an ABSENCE and by its cause. The status
    // code is what discriminates: "no toast" alone is equally true of a build
    // whose toast is merely broken.
    expect(toasts, "the picker's own request must have succeeded").toContain("my-competitions -> 200");
    const grid = await page.locator("#comp-grid").innerText();
    expect(grid, "the reported sentence must be gone").not.toContain("did not respond correctly");
    expect(grid, "and their own event is listed").toContain(world.mine.name);

    // DEFECT 2 — the way back must exist, and must work.
    const back = await inMenu(page, ADMIN_VIEW_BTN);
    await expect(back, "an event admin needs a route back to the admin panel").toBeVisible();
    await back.click();
    await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30000 });
    await expect(page.locator("#admin-page")).toBeVisible();
  });

  test("CONTROL: a plain participant is offered no Admin View button", async ({ page }) => {
    // Without this, "the button renders" is satisfied by a build that renders it
    // for everybody — which would offer every participant a toggle the server
    // refuses (the v7.14.2 defect this fix exists to avoid, with the sides
    // swapped).
    await loginViaApi(page, world.participant.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitParticipantNav(page);
    const pm = await openAccountMenu(page);
    await expect(pm.locator("[data-action='do-logout']"), "CONTROL: the menu rendered").toBeVisible();
    await expect(pm.locator(ADMIN_VIEW_BTN)).toHaveCount(0);
  });

  test("the round trip does not turn an event admin into a global admin", async ({ page }) => {
    // `POST /api/toggle-admin-view` omitted `isEventAdmin`, so `!!undefined`
    // reset the flag and the panel came back with a GLOBAL admin's chrome.
    await loginViaApi(page, world.ea.email, PARTICIPANT_PASS);
    await bootAdmin(page);

    await expect(page.locator(USERS_NAV), "Users & roles is hidden for this tier before the trip").toBeHidden();

    await (await inMenu(page, PARTICIPANT_VIEW_BTN)).click();
    await waitParticipantNav(page);
    await (await inMenu(page, ADMIN_VIEW_BTN)).click();
    await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30000 });

    await expect(page.locator(USERS_NAV), "…and is still hidden after it").toBeHidden();
    await expect(page.locator("#new-competition-btn"),
      "an event admin may not create a blank event, so the button stays hidden").toBeHidden();
    expect(await page.evaluate(() => window.S && window.S.isEventAdmin),
      "the tier flag survived the toggle").toBe(true);
  });

  test("CONTROL: a regular admin still sees Users & roles after the identical round trip", async ({ page }) => {
    // Without this, "Users & roles is hidden" is satisfied by a build that hid it
    // from every tier below superadmin — a different, and wrong, rule.
    await loginViaApi(page, world.plainAdmin.email, PARTICIPANT_PASS);
    await bootAdmin(page);
    await expect(page.locator(USERS_NAV)).toBeVisible();

    await (await inMenu(page, PARTICIPANT_VIEW_BTN)).click();
    await waitParticipantNav(page);
    await (await inMenu(page, ADMIN_VIEW_BTN)).click();
    await page.waitForSelector(".admin-nav-item", { state: "visible", timeout: 30000 });

    await expect(page.locator(USERS_NAV), "a global admin keeps Users & roles across the trip").toBeVisible();
    expect(await page.evaluate(() => window.S && window.S.isEventAdmin)).toBe(false);
  });

  test("an admin with an incomplete profile is told why, and STAYS in the admin view", async ({ page }) => {
    await loginViaApi(page, world.incompleteEa.email, PARTICIPANT_PASS);
    await bootAdmin(page);

    await (await inMenu(page, PARTICIPANT_VIEW_BTN)).click();

    const overlay = page.locator("#modal-overlay.open");
    await expect(overlay, "the switch is explained rather than attempted").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#modal-title")).toContainText("complete profile");
    // It NAMES the field — a modal that merely says "incomplete" sends the
    // operator hunting, which is the v7.14.2 rule (the affordance and the
    // explanation move together).
    await expect(page.locator("#modal-body")).toContainText("company email");

    // Cancel keeps them exactly where they were. This is the anti-trap
    // assertion: the completion gate is non-dismissible and covers the header,
    // so opening THAT here would hide the Admin View button that is the escape.
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#admin-page")).toBeVisible();
    await expect(page.locator(".admin-nav-item").first()).toBeVisible();
    expect(await page.evaluate(() => window.S && window.S.isAdminView),
      "still in the admin view — the toggle never fired").toBe(true);
  });

  test("…and if they are already in participant view, the picker says the real reason", async ({ page }) => {
    // The residual path the pre-toggle explanation cannot cover: an admin who
    // RELOADS while the session is already participant-shaped, or whose
    // organiser makes a field mandatory mid-session (v8.4.0 resolves it LIVE).
    // Driven through the API so the session really is in participant mode
    // before boot runs.
    await loginViaApi(page, world.incompleteEa.email, PARTICIPANT_PASS);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const t = await page.request.post("/api/toggle-admin-view", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { mode: "participant" },
    });
    expect(t.ok(), "the server permits the toggle — only the client explains").toBeTruthy();

    await page.goto("/");
    await waitParticipantNav(page);

    // The view really is the participant one — asserted, because `/api/me` is
    // cached per user and the payload carries `isAdminView`: without the
    // toggle's cache bust this booted the ADMIN panel over a participant
    // session and the assertions below would have measured the wrong screen.
    expect(await page.evaluate(() => window.S && window.S.isAdminView),
      "boot resolved the participant view, not a cached admin one").toBe(false);
    // The TIER survives a reload taken in participant view. `isAdmin` is the
    // VIEW and is correctly false here; `isEventAdmin` describes the account,
    // and boot's participant branch never set it — so a refresh silently
    // changed what the admin panel would offer on the way back up.
    expect(await page.evaluate(() => window.S && window.S.isEventAdmin),
      "the event-admin tier is known even while in participant view").toBe(true);

    const grid = page.locator("#comp-grid");
    await expect(grid).toContainText("profile is incomplete", { timeout: 20000 });
    await expect(grid, "the server is not blamed for a 400 it explained")
      .not.toContainText("did not respond correctly");
    // The escape is on screen and not covered by anything.
    await expect(await inMenu(page, ADMIN_VIEW_BTN)).toBeVisible();
  });
});
