"use strict";

// v8.8.8 — WHAT THE NARROWING WOULD HAVE SILENTLY DELETED.
//
// Scoping `task.competitions` removes information from the screen as well as
// from the wire, and two of the things it removes are load-bearing:
//
//   * the "this challenge is in live event(s)" confirmation is BUILT from that
//     array, and an event admin may still legally edit the cosmetic fields of a
//     challenge another organiser is running (v8.8.5 froze the scoring ones and
//     deliberately left the rest). Narrowing the array to nothing would delete
//     the warning at the moment it matters most; and
//   * the events cell would read "None" for a challenge that is in use, on the
//     column an operator reads to decide whether it is safe to touch.
//
// Neither is visible from the API — the server's job there is done once it emits
// the counts — so this file drives the real screen. Every positive has a control,
// because "the chip is present" is equally satisfied by a build that renders it
// on every row, and "the warning appeared" by one that warns unconditionally.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { loginViaApi, clickTab, findSeededTaskRow, openKebab } = require("./ui-admin-helpers");
const { H, buildWorld, makeTask, assignTask } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const PASS = "testpass123";

/**
 * The event admin, in the browser, with the tier asserted as a precondition.
 *
 * The shape `event-admin-ui.spec.js` established: `loginViaApi` can succeed on a
 * retry, and a session that did not survive otherwise surfaces 30 s later as a
 * locator timeout naming nothing. Competitions is the settle signal because both
 * tiers have it and it is not what these tests are about.
 */
async function eaLogin(page, world) {
  await loginViaApi(page, world.ea.email, PASS);
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `no live admin session before goto("/"): ${meR.status()} ${await meR.text()}`).toBeTruthy();
  expect((await meR.json()).isEventAdmin, "the fixture really holds the tier").toBe(true);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']")
    .first().waitFor({ state: "visible", timeout: 30000 });
}

test.describe("v8.8.8 — the withheld-event signals on the Challenges tab", () => {
  /** @type {any} */ let w;
  let ownedShared;  // theirs to edit, live in an event they cannot see
  let ownedAlone;   // the control — no withheld events at all
  let ownedQuiet;   // theirs, in an UPCOMING event they cannot see

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();

    // OWNED by the event admin (so `can_edit` is true and the edit form opens)
    // AND held by an event they do not organise. That is the only shape that can
    // produce a withheld LIVE event on a challenge they are allowed to change.
    ownedShared = await makeTask(w.eaApi, w.eaCsrf, "ownshared");
    await assignTask(w.sa, w.saCsrf, ownedShared.id, [w.theirs.id]);

    ownedAlone = await makeTask(w.eaApi, w.eaCsrf, "ownalone");
    await assignTask(w.eaApi, w.eaCsrf, ownedAlone.id, [w.mine.id]);

    // The control's fixture is built HERE, not in its own test body: a browser
    // `loginViaApi` as this same account invalidates every other session it holds
    // (single session per user), so an API call made after the first browser test
    // gets 401 Not authenticated — the v7.19.0 trap, measured 3 of 3 runs.
    const upcoming = await w.sa.post("/api/admin/competitions", {
      headers: H(w.saCsrf),
      data: {
        name: `EA tcs-upcoming ${Date.now()}`,
        start_time: new Date(Date.now() + 3 * 3600_000).toISOString(),
        duration_minutes: 600, event_kind: "tournament",
      },
    });
    expect(upcoming.ok(), `create upcoming: ${await upcoming.text()}`).toBeTruthy();
    ownedQuiet = await makeTask(w.eaApi, w.eaCsrf, "ownquiet");
    await assignTask(w.sa, w.saCsrf, ownedQuiet.id, [(await upcoming.json()).competition.id]);
  });

  test("the events cell says something was withheld, and names nothing", async ({ page }) => {
    await eaLogin(page, w);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, ownedShared.title);
    await expect(row.first(), "the challenge is listed").toBeVisible();

    const chip = row.first().locator(".comp-withheld");
    await expect(chip, "the withheld chip renders").toHaveCount(1);
    await expect(chip, "…and states the count rather than the name").toContainText(/1 elsewhere/i);
    await expect(row.first(), "the other organiser's event is not named")
      .not.toContainText(w.theirs.name);

    // It is NOT a control: there is nothing here this actor may open, so offering
    // a focus affordance would be the v7.14.2 defect the narrowing just removed.
    await expect(chip, "no focus affordance").not.toHaveAttribute("data-action", /.+/);
  });

  test("CONTROL — a challenge with nothing withheld carries no chip", async ({ page }) => {
    // Without this, "the chip appears" is satisfied by a build that renders it on
    // every row, which would be a worse answer than the leak it replaces.
    await eaLogin(page, w);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, ownedAlone.title);
    await expect(row.first()).toBeVisible();
    await expect(row.first().locator(".comp-withheld"), "nothing withheld, no chip").toHaveCount(0);
    await expect(row.first(), "its own event is named as usual").toContainText(w.mine.name);
  });

  test("the live-edit warning SURVIVES the narrowing and says what it cannot name", async ({ page }) => {
    // The whole reason the server counts what it withheld. Before this test, a
    // narrowing that dropped the count would have removed this confirmation
    // entirely, and nothing else in the suite would have gone red.
    await eaLogin(page, w);
    await clickTab(page, "Challenges");

    const row = await findSeededTaskRow(page, ownedShared.title);
    await expect(row.first()).toBeVisible();
    // Edit lives in the row kebab, which PORTALS to #kebab-portal on <body> —
    // so the button is never a descendant of the row (v7.7.x). `openKebab` is the
    // hardened opener the suite already has: the kebab is a TOGGLE, so a single
    // blind click closes whatever another test left open (v7.21.25).
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-edit"]').first().click();
    await expect(page.locator("#tf-title"), "the edit form opened").toBeVisible({ timeout: 15000 });

    await page.locator("#tf-title").fill(`${ownedShared.title} edited`);
    await page.locator('[data-action="save-task"]:visible').first().click();

    const modal = page.locator("#modal-overlay");
    await expect(modal, "the live-event confirmation fired").toBeVisible({ timeout: 15000 });
    await expect(modal, "…and states the situation it cannot name")
      .toContainText(/you do not organise/i);
    await expect(modal, "…without naming the event").not.toContainText(w.theirs.name);
  });

  test("CONTROL — no live event, no confirmation", async ({ page }) => {
    // Without this, "the warning appeared" is satisfied by a build that warns on
    // every save, which trains an operator to click through the one that matters.
    await eaLogin(page, w);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, ownedQuiet.title);
    await expect(row.first()).toBeVisible();
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-edit"]').first().click();
    await expect(page.locator("#tf-title")).toBeVisible({ timeout: 15000 });
    await page.locator("#tf-title").fill(`${ownedQuiet.title} edited`);

    // WATCH THE WIRE, not the form. The confirmation fires BEFORE the request is
    // built, so a PUT reaching the server is proof the gate did not stand in the
    // way — where "the dialog closed" would also be satisfied by a save that
    // failed for an unrelated reason, and would make this control depend on the
    // edit form's close behaviour rather than on its subject.
    const put = page.waitForRequest(
      r => r.method() === "PUT" && r.url().includes(`/api/admin/tasks/${ownedQuiet.id}`),
      { timeout: 15000 });
    await page.locator('[data-action="save-task"]:visible').first().click();
    await put;
    await expect(page.locator("#modal-overlay"), "nothing stood in the way")
      .toBeHidden();
  });
});
