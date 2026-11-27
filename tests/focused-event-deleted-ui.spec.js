// @ts-check
//
// v8.13.3 — a focused event that another admin deletes is NOTICED by the
// 15-second competitions poll, which clears the focus with a toast.
//
// GET /api/admin/submissions answers 404 "Event not found" for an event that
// does not exist (UNK-1, this release), and the Submissions pane sends the
// focused event's id on every load. Nothing on that path cleared a stale focus —
// the scope banner's deleted-event detector ran only on a category change, which
// a deletion is not — so the pane rendered "Could not load submissions" with a
// Retry that could never succeed (the pre-release review). The poll now asks the
// detector whenever the focused row vanishes from the list.
//
// The deletion is made through the PAGE's own session (`page.request`), because
// the built-in superadmin is single-session: an API login would sign the browser
// out. The client cannot tell a colleague's delete from this one — its model is
// only refreshed by the poll either way.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, viewComp, clickTab, loginViaApi } = require("./ui-admin-helpers");
const { makeCompetition, makeParticipant, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

let doomed, kept, solo, organiser;
test.beforeAll(async () => {
  const sa = await apiLogin("superadmin");
  // Upcoming and empty, so the superadmin DELETE is allowed (a live event with a
  // participant footprint refuses it).
  const future = { start_time: new Date(Date.now() + 86_400_000).toISOString() };
  doomed = await makeCompetition(sa.api, sa.csrf, "focus-doomed", future);
  kept = await makeCompetition(sa.api, sa.csrf, "focus-kept", future);
  // An organiser whose ONLY event this is: once it goes, their events list is
  // empty, which the detector used to read as "not loaded" (sweep finding #244).
  solo = await makeCompetition(sa.api, sa.csrf, "focus-solo", future);
  organiser = await makeParticipant(sa.api, sa.csrf, "focus-solo-org");
  await grantEventAdmin(sa.api, sa.csrf, solo.id, organiser.id);
  await sa.api.dispose();
});

async function deleteViaPage(page, id) {
  const t = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.delete(`/api/admin/competitions/${id}`, { headers: { "x-csrf-token": t.csrfToken } });
  expect(r.ok(), `delete ${id}: ${r.status()} ${await r.text()}`).toBeTruthy();
}

test("deleting the focused event clears the focus at the next poll, and Submissions stops asking for it", async ({ page }) => {
  test.setTimeout(90_000);
  await adminLogin(page);
  await clickTab(page, "Events");
  await viewComp(page, doomed.name);
  expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "PRECONDITION: the event is focused").toBe(doomed.id);
  await clickTab(page, "Submissions");

  await deleteViaPage(page, doomed.id);
  // The poll runs every 15 s; allow one full period plus slack.
  await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId), {
    timeout: 25_000, intervals: [500],
    message: "the competitions poll cleared the focus on the deleted event",
  }).toBeNull();
  await expect(page.locator("#toast-stack"), "…and said why").toContainText("The event you were viewing was deleted, or you no longer have access to it.");

  // And the Submissions pane no longer asks for the dead event: a reload of the
  // pane sends no competitionId at all.
  const sent = [];
  page.on("request", r => { if (r.url().includes("/api/admin/submissions")) sent.push(r.url()); });
  await clickTab(page, "Events");
  await clickTab(page, "Submissions");
  await expect.poll(() => sent.length, { message: "the Submissions pane reloaded" }).toBeGreaterThan(0);
  expect(sent.some(u => u.includes(doomed.id)), `no request names the deleted event: ${sent.join(" ")}`).toBe(false);
});

test("CONTROL — a focused event that still exists stays focused across a poll", async ({ page }) => {
  test.setTimeout(90_000);
  await adminLogin(page);
  await clickTab(page, "Events");
  await viewComp(page, kept.name);
  expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "PRECONDITION: the event is focused").toBe(kept.id);
  // Wait out one poll period (the poll is what is under test, so no fake clock),
  // proving it ran by the model being re-fetched.
  const polled = page.waitForResponse(r => r.url().includes("/api/admin/competitions") && r.request().method() === "GET", { timeout: 25_000 });
  await polled;
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "an existing event is not unfocused").toBe(kept.id);
});

test("an organiser whose only event is deleted is taken back to the Events list at the next poll", async ({ page }) => {
  test.setTimeout(90_000);
  await loginViaApi(page, organiser.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30_000 });
  await clickTab(page, "Events");
  await viewComp(page, solo.name);
  expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "PRECONDITION: the event is open").toBe(solo.id);
  expect(await page.evaluate(() => window.S.adminCompetitionsData.length), "PRECONDITION: it is their only event").toBe(1);
  await expect(page.locator("#admin-workspace")).toBeVisible();

  // A colleague deletes it (the organiser's browser keeps its own session).
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.delete(`/api/admin/competitions/${solo.id}`, { headers: { "x-csrf-token": sa.csrf } });
    expect(r.ok(), `delete: ${r.status()} ${await r.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }

  await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId), {
    timeout: 25_000, intervals: [500],
    message: "the poll's answer, an EMPTY list, closed the dead event",
  }).toBeNull();
  await expect(page.locator("#toast-stack")).toContainText("The event you were viewing was deleted, or you no longer have access to it.");
  await expect(page.locator("#admin-workspace"), "the workspace is gone").toBeHidden();
  await expect(page.locator("#admin-competitions-tab"), "and the Events list is on screen").toBeVisible();
});
