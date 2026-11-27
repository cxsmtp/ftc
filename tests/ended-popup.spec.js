// @ts-check
//
// v7.20.5 — the "competition has ended" popup announces itself ONCE.
const { test, expect } = require("./isolated-test");
const { apiLogin, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });
const GUH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

/** An ENDED competition the given account is enrolled in, with one challenge. */
async function endedCompFor(page, email) {
  const { api: sa, csrf: sc } = await apiLogin("superadmin");
  const H = GUH(sc);
  const t = Date.now() + Math.floor(Math.random() * 1e5);
  const comp = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
    name: `EndPop ${t}`, start_time: new Date(t - 30 * 60_000).toISOString(),
    duration_minutes: 120 } })).json()).competition.id;
  const taskId = (await (await sa.post("/api/admin/tasks", { headers: H, data: {
    title: `EndPop task ${t}`, difficulty: "easy", answer_type: "text",
    correct_answer: "x", status: "published", description: "<p>q</p>" } })).json()).id;
  await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [comp] } });
  const ps = await (await sa.get("/api/admin/participants?limit=5000")).json();
  const who = (ps.participants || ps).find((p) => p.email === email);
  expect(who, `${email} must exist`).toBeTruthy();
  await sa.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [who.id], competitionIds: [comp] } });
  return { sa, saCsrf: sc, comp, taskId };
}

/** Hide the tab and bring it back — what a user does by switching windows. */
async function blurAndFocus(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function dismissIfOpen(page) {
  const modal = page.locator("#modal-overlay.open");
  await modal.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  let seen = false;
  for (let i = 0; i < 5 && await modal.isVisible().catch(() => false); i++) {
    seen = true;
    await page.locator("#modal-cancel-btn, #modal-confirm-btn").first().click({ timeout: 3000 }).catch(() => {});
    await modal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }
  return seen;
}

test.describe("The ended-competition popup shows once (v7.20.5)", () => {
  test("it does NOT come back every time the tab regains focus", async ({ page }) => {
    // Reported: "the pop-up pops up every time the focus comes back to that
    // tab". main.js's visibilitychange resume re-runs startHackathonTimer(),
    // which re-read the server's ended_popup_seen and ASSIGNED it — throwing
    // away the fact that this tab had already shown the popup. The dismiss POST
    // is fire-and-forget, so a focus landing before it commits re-read false.
    const { sa, saCsrf, comp } = await endedCompFor(page, "alice@acme.com");
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, "alice@acme.com", GUH(csrfToken));
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: comp } });
    await sa.post(`/api/admin/competitions/${comp}/end-now`, { headers: GUH(saCsrf) });

    // THE LOAD-BEARING SETUP: make the server never record the dismissal.
    //
    // Without this the test is VACUOUS — dismissing the popup fires
    // POST /api/dismiss-ended, the server flag becomes true, and the re-read on
    // focus is satisfied by the SERVER value alone. Reverting the fix still
    // passed (measured). The real-world cases are exactly the ones where that
    // POST does not take effect: an admin who is not a participant of the
    // competition, and the fire-and-forget race where focus lands before the
    // request commits. Failing the route reproduces both.
    await page.route("**/api/dismiss-ended", (route) => route.abort());

    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    expect(await dismissIfOpen(page), "the popup announces the end once").toBe(true);

    // Now the actual complaint: three focus round-trips, no popup.
    for (let i = 0; i < 3; i++) {
      await blurAndFocus(page);
      await page.waitForTimeout(1200);
      await expect(page.locator("#modal-overlay.open"),
        `the popup came back on tab focus #${i + 1}`).toHaveCount(0);
    }
    await sa.dispose();
  });

  test("an ADMIN viewing an ended competition is not nagged either", async ({ page }) => {
    // The reported case. An admin is not a participant of that competition, so
    // POST /api/dismiss-ended never records anything for them — the server flag
    // stays false for ever and the popup returned on every single focus.
    //
    // v8.12.4 — driven with a REAL admin who enters the finished event from
    // participant view (staff need no row to enter). The first draft signed in
    // as the built-in superadmin, which lands on the admin panel with no event
    // selected, so the popup could never fire and "it did not fire again" held
    // of a build with no popup at all. It now also asserts the popup appeared
    // ONCE, which is what makes "not again" mean something.
    const { makeParticipant } = require("./event-admin-helpers");
    const { loginViaApi } = require("./ui-admin-helpers");
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    let adminEmail, comp;
    try {
      const who = await makeParticipant(sa, sc, "endpop-admin");
      const role = await sa.post(`/api/admin/participants/${who.id}/role`, { headers: GUH(sc), data: { role: "admin" } });
      expect(role.ok(), `promote: ${await role.text()}`).toBeTruthy();
      adminEmail = who.email;
      const t = Date.now();
      comp = (await (await sa.post("/api/admin/competitions", { headers: GUH(sc), data: {
        name: `EndPopAdmin ${t}`, start_time: new Date(t - 30 * 60_000).toISOString(),
        duration_minutes: 120 } })).json()).competition.id;
      const end = await sa.post(`/api/admin/competitions/${comp}/end-now`, { headers: GUH(sc), data: {} });
      expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }

    await loginViaApi(page, adminEmail, PARTICIPANT_PASS);
    const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const tog = await page.request.post("/api/toggle-admin-view", { headers: GUH(c1), data: { mode: "participant" } });
    expect(tog.ok(), `participant view: ${await tog.text()}`).toBeTruthy();
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: comp } });
    expect(sel.ok(), `enter the ended event as staff: ${await sel.text()}`).toBeTruthy();

    // An admin's dismissal is never recorded, so the server flag stays false.
    await page.route("**/api/dismiss-ended", (route) => route.abort());
    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    expect(await dismissIfOpen(page), "the popup announces the end once").toBe(true);
    for (let i = 0; i < 3; i++) {
      await blurAndFocus(page);
      await page.waitForTimeout(1200);
      await expect(page.locator("#modal-overlay.open"),
        `an admin was nagged on tab focus #${i + 1}`).toHaveCount(0);
    }
  });

  test("the suppression is keyed on the COMPETITION, not global", async ({ page }) => {
    // Keying matters: suppressing globally would mean a participant entering a
    // SECOND ended competition is never told it had ended. Asserted on the
    // state the gate actually reads, because driving two full competition
    // switches through the UI tests the switch far more than the keying.
    const { sa, saCsrf, comp } = await endedCompFor(page, "alice@acme.com");
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, "alice@acme.com", GUH(csrfToken));
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: GUH(c2), data: { competitionId: comp } });
    await sa.post(`/api/admin/competitions/${comp}/end-now`, { headers: GUH(saCsrf) });

    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    await dismissIfOpen(page);

    const state = await page.evaluate((id) => ({
      shownFor: window.S._endedPopupShownFor,
      matchesThis: window.S._endedPopupShownFor === id,
    }), comp);
    expect(state.shownFor, "the tab records WHICH competition it announced").toBeTruthy();
    expect(state.matchesThis, "and it is this one").toBe(true);

    // A different competition id must NOT be covered by that record — which is
    // what keeps the second one announceable.
    const other = await page.evaluate((id) => window.S._endedPopupShownFor === id, "some-other-competition-id");
    expect(other, "the record must not suppress a different competition").toBe(false);
    await sa.dispose();
  });
});
