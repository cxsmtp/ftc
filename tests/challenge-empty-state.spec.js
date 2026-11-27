"use strict";

// v8.8.4 — THE EMPTY CHALLENGE LIST STOPS BLAMING A FILTER THAT IS NOT SET.
//
// `hasFilter` counted `S.adminSelectedCompetitionId` as a filter. Focusing an
// event does NOT filter the Challenges tab — it sorts the event's own challenges
// to the top (challenges-admin.js:441) and dims the rest (:579), which is the
// finding v8.8.3 had to correct in the guides as well. So an event admin whose
// whole visible set is empty, with an event focused, was told "No challenges
// match the current filters." and sent hunting for a control that is not set.
// The same render already disagreed with itself: the list-count call twelve lines
// below deliberately does not treat a focus as narrowing.
//
// THE FIXTURE IS THE WHOLE DIFFICULTY. Every event admin sees the `public-domain`
// pool, so this state needs a world with NO shared-pool challenge in it — which is
// why it cannot live in event-admin-ui.spec.js, whose fixture deliberately has one.
// The event admin here has one granted event holding nothing, and created nothing.

const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const { clickTab, filterComps, loginViaApi, narrowChallengesTable } = require("./ui-admin-helpers");
const { buildWorld } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

test.describe("v8.8.4 — an empty challenge list names the truth", () => {
  /** @type {any} */ let world;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    world = await buildWorld();
    // Deliberately no challenges: none created by the event admin, none assigned
    // to their event, and none tagged public-domain anywhere in this file.
    const seen = await world.eaApi.get("/api/admin/tasks");
    expect(seen.ok(), `tasks: ${seen.status()}`).toBeTruthy();
    expect(await seen.json(), "PRECONDITION — the event admin can see no challenge at all")
      .toEqual([]);
  });

  async function signInAsEventAdmin(page) {
    // Signed in through page.request BEFORE the first navigation (an emailed
    // code, as every account but the built-in signs in), so the SPA boots signed in.
    await loginViaApi(page, world.ea.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 30000 });
  }

  test("with an event FOCUSED and nothing visible, it says so — it does not blame a filter", async ({ page }) => {
    await signInAsEventAdmin(page);

    // Focus their own event through the real control, so the state under test is
    // one an operator can actually reach.
    await clickTab(page, "Events");
    await filterComps(page, world.mine.name);
    await page.locator(`tr:has-text("${world.mine.name}") [data-action="comp-open"]`).first().click();
    await expect(page.locator("#admin-scope-banner"), "the event is focused")
      .toContainText(world.mine.name, { timeout: 15000 });

    await clickTab(page, "Challenges");
    const empty = page.locator("#admin-task-body .table-empty-row");
    await expect(empty, "the list is empty").toHaveCount(1);
    await expect(empty, "a focus removes no rows, so no filter is to blame")
      .not.toContainText(/match the current filters/i);
    await expect(empty, "…it says the truth instead").toContainText(/no challenges yet/i);
  });

  test("CONTROL — a REAL filter is still named as one", async ({ page }) => {
    // Without this, "the message does not mention filters" is satisfied by a build
    // that removed the filtered empty state altogether — which would be a worse
    // answer than the one being fixed, since a search that matches nothing is
    // exactly when an operator needs telling why the table is empty.
    await signInAsEventAdmin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, "zzz-no-such-challenge-zzz");
    const empty = page.locator("#admin-task-body .table-empty-row");
    await expect(empty, "a search that matches nothing IS a filter, and says so")
      .toContainText(/match the current filters/i, { timeout: 15000 });
  });
});
