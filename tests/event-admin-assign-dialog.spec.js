"use strict";

// v8.7.7 — THE ASSIGN-TO-EVENTS DIALOG, IN A REAL BROWSER.
//
// THIS FILE IS THE ONLY LOCK ON THE FIX. The defect was entirely client-side:
// the dialog rendered its checkboxes from the SCOPED `/api/admin/competitions`
// while deriving its baseline from the UNFILTERED `task.competitions`, so every
// assignment it did not draw vanished from the desired state it submitted and
// the server read it as a removal the admin never asked for.
//
// `event-admin-assign-dialog.api.spec.js` replays what the fixed client puts on
// the wire, so it pins the SERVER CONTRACT — and it stays green with the client
// reverted, which is exactly why it cannot stand alone. Reverting
// `public/js/features/challenges-admin.js` turns THIS file red and nothing else.
//
// THE PRECONDITION IS ASSERTED, NOT ASSUMED: the dialog must genuinely NOT draw
// a checkbox for the out-of-scope event. Without that assertion "the save
// succeeded" is equally satisfied by a build where the dialog started rendering
// every event on the platform — which would be a scope leak, not a fix.
//
// Fixtures: `buildWorld()` from ./event-admin-helpers, never the seeded
// alice/bob/carol (tests/isolated-test.js fails the FILE if those are left
// promoted). No seedTestData() — the harness re-seeds per spec FILE and the seed
// is not idempotent.
//
// The browser signs in as the EVENT ADMIN, which invalidates `world.eaApi` under
// the single-session rule but leaves `world.sa` alive — so the read-backs below
// are done as the superadmin, whose view is unnarrowed. A narrowed reader would
// hide the very damage this test is looking for.

const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const {
  clickTab, openAddToEventsFor, findSeededTaskRow, loginViaApi,
} = require("./ui-admin-helpers");
const {
  H, buildWorld, makeParticipant, makeTask, assignTask,
} = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/**
 * Sign the BROWSER into the admin panel and prove the session survived.
 *
 * `#admin-page` is the settle signal rather than `.admin-nav-item` being
 * attached: the sidebar buttons are static markup in the shell, so `attached` is
 * true before boot has resolved who we are (v8.3.33).
 */
async function adminPanelLogin(page, email, password) {
  await loginViaApi(page, email, password);
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `${email} had no live admin session before goto("/"): `
    + `${meR.status()} ${await meR.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']")
    .first().waitFor({ state: "visible", timeout: 30000 });
  return await meR.json();
}

/** The assigned competition ids for a task, read as the SUPERADMIN (unnarrowed). */
async function assignedIdsAsSuperadmin(sa, taskId) {
  const r = await sa.get("/api/admin/tasks");
  expect(r.ok(), `tasks list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the task must be findable in the superadmin's list").toBeTruthy();
  return new Set((row.competitions || []).map(c => c.id));
}

/** Open the dialog for a challenge, from the Challenges tab kebab. */
async function openAssignDialog(page, title) {
  await clickTab(page, "Challenges");
  const row = await findSeededTaskRow(page, title);
  await expect(row.first(), `the challenge "${title}" is visible`).toBeVisible();
  // Stage B — the bank's one door into events (the selection bar's Add to events).
  return openAddToEventsFor(page, row.first());
}

/**
 * Save, accepting the live-removal confirmation when it appears, and report what
 * actually happened rather than timing out on a bare locator.
 *
 * The confirm is raised by JS AFTER the click, so sampling it once loses the
 * race; settle into either state first (the v8.3.22 lesson).
 */
async function saveDialog(page, overlay) {
  await overlay.locator("#assign-task-save-btn").click();
  const confirm = page.locator("#modal-confirm-btn");
  await expect
    .poll(async () => (await confirm.isVisible().catch(() => false)) ? "confirm" : "none",
      { timeout: 5000, intervals: [50, 100, 200, 400, 800] })
    .toBe("confirm");
  await confirm.click();

  // Diagnose rather than time out: an error toast names the server's refusal,
  // which is the whole content of this test's failure mode.
  const ok = page.locator(".toast.toast-success");
  const bad = page.locator(".toast.toast-error");
  const verdict = await Promise.race([
    ok.first().waitFor({ state: "visible", timeout: 20000 }).then(() => "success"),
    bad.first().waitFor({ state: "visible", timeout: 20000 }).then(() => "error"),
  ]).catch(() => "neither");
  if (verdict !== "success") {
    const msg = await bad.first().textContent().catch(() => "(no error toast)");
    throw new Error(`the save did not succeed (${verdict}); error toast said: ${msg}`);
  }
}

test.describe("v8.7.7 — an event admin saves the assign-to-events dialog", () => {
  /** @type {any} */ let world;
  let regular;      // an unscoped admin, for the control
  let shared;       // assigned to BOTH world.mine and world.theirs
  let sharedForGa;  // a second copy, so the control owns its own fixture

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    world = await buildWorld();

    regular = await makeParticipant(world.sa, world.saCsrf, "regadmin");
    const rr = await world.sa.post(`/api/admin/participants/${regular.id}/role`, {
      headers: H(world.saCsrf), data: { role: "admin" },
    });
    expect(rr.ok(), `promote regular admin: ${rr.status()} ${await rr.text()}`).toBeTruthy();

    // Created and assigned to `mine` BY THE EVENT ADMIN so the provenance arm of
    // taskUnassignDenied permits the removal they actually ask for — which is
    // what made the refusal name the OTHER event in the operator's report.
    for (const [label, holder] of [["ui", "shared"], ["uiga", "sharedForGa"]]) {
      const t = await makeTask(world.eaApi, world.eaCsrf, label);
      await assignTask(world.eaApi, world.eaCsrf, t.id, [world.mine.id]);
      await assignTask(world.sa, world.saCsrf, t.id, [world.theirs.id]);
      if (holder === "shared") shared = t; else sharedForGa = t;
    }

    for (const t of [shared, sharedForGa]) {
      const cur = await assignedIdsAsSuperadmin(world.sa, t.id);
      expect([...cur].sort(), `fixture ${t.title}: in BOTH events`)
        .toEqual([world.mine.id, world.theirs.id].sort());
    }
  });

  test("the reported flow — removing their own event leaves the other organiser's assignment intact", async ({ page }) => {
    const me = await adminPanelLogin(page, world.ea.email, PARTICIPANT_PASS);
    expect(me.isEventAdmin, "the fixture really holds the event-admin tier").toBe(true);
    expect(me.isSuperAdmin, "…and is NOT a superadmin").toBeFalsy();

    const overlay = await openAssignDialog(page, shared.title);

    // THE PRECONDITION. If the dialog were to start drawing the out-of-scope
    // event, this test would pass for the wrong reason — and that build would be
    // a scope leak rather than a fix.
    const mineBox = overlay.locator(`input[type="checkbox"][value="${world.mine.id}"]`);
    await expect(mineBox, "their own event IS rendered").toHaveCount(1);
    await expect(mineBox, "…and is ticked, the challenge being assigned to it").toBeChecked();
    await expect(overlay.locator(`input[type="checkbox"][value="${world.theirs.id}"]`),
      "the OUT-OF-SCOPE event is NOT rendered — the whole cause of the bug").toHaveCount(0);

    await mineBox.uncheck();
    await expect(overlay.locator("#assign-task-save-btn"), "Save is enabled by the change")
      .toBeEnabled();

    await saveDialog(page, overlay);
    await expect(page.locator("#assign-task-overlay"), "the dialog closed on success")
      .toHaveCount(0);

    const after = await assignedIdsAsSuperadmin(world.sa, shared.id);
    expect(after.has(world.mine.id), "their own assignment was removed").toBe(false);
    expect(after.has(world.theirs.id),
      "the other organiser's assignment SURVIVED — the fix").toBe(true);
  });

  test("CONTROL — a GLOBAL admin's dialog renders both events and behaves exactly as before", async ({ page }) => {
    // Without this, every assertion above is satisfied by a build that changed
    // the dialog for everybody. For an unscoped admin nothing is unrendered, so
    // the preserved set is empty and the payload is byte-identical to pre-fix.
    const me = await adminPanelLogin(page, regular.email, PARTICIPANT_PASS);
    expect(me.isAdmin, "the control really is an admin").toBeTruthy();
    expect(me.isEventAdmin, "…and is NOT scoped").toBeFalsy();

    const overlay = await openAssignDialog(page, sharedForGa.title);
    await expect(overlay.locator(`input[type="checkbox"][value="${world.mine.id}"]`),
      "an unscoped admin sees the first event").toHaveCount(1);
    await expect(overlay.locator(`input[type="checkbox"][value="${world.theirs.id}"]`),
      "…and the second, so nothing is unrendered for them").toHaveCount(1);

    await overlay.locator(`input[type="checkbox"][value="${world.mine.id}"]`).uncheck();
    await saveDialog(page, overlay);

    const after = await assignedIdsAsSuperadmin(world.sa, sharedForGa.id);
    expect(after.has(world.mine.id), "the unticked event was removed").toBe(false);
    expect(after.has(world.theirs.id), "the event they left ticked was kept").toBe(true);
  });
});
