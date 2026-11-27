// v8.16.0 — two integration findings, locked:
//  (1) the event workspace's Organisers card never stays on "Loading…": it shows
//      the organisers, "No organisers yet", or (a failed read) a load failure
//      with Try again — never an empty list standing in for a failure;
//  (2) the participant board of an ENDED event titles itself "Final standings"
//      and drops the "Updates automatically" line; a live one keeps both. The
//      line names no interval: the board is re-read when it moves, not on a beat.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE } = require("./helpers");
const { adminLogin, loginViaApi, clickTab, viewComp, openOverviewDetail } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;

async function participant(sa, h) {
  const stamp = uniq();
  const email = `wsfb_${stamp}@acme.com`;
  const { api: anon, csrf } = await freshCtx();
  await registerPost(anon, "/api/register", { headers: H(csrf), data: {
    firstName: "Final", lastName: "Board", nickname: `wsfb_${stamp}`, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC", email,
  } });
  await anon.dispose();
  const me = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
  expect(me, `participant ${email} created`).toBeTruthy();
  await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
  await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
  return { id: me.id, email };
}

async function liveEvent(sa, h, label) {
  const r = await sa.post("/api/admin/competitions", { headers: h, data: {
    name: `WSFB ${label} ${uniq()}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180, event_kind: "tournament",
  } });
  expect(r.ok(), `create event: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

test.describe("the workspace Organisers card settles", () => {
  test("no organisers reads 'No organisers yet'; a failed read is a load failure whose Try again recovers", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const comp = await liveEvent(sa, h, "orgs");
    try {
      // The FIRST read fails; later ones are real.
      let failed = 0;
      await page.route(`**/api/admin/competitions/${comp.id}/admins`, (route) => {
        if (route.request().method() === "GET" && failed === 0) { failed++; return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }); }
        return route.continue();
      });
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, comp.name);
      await openOverviewDetail(page);
      const card = page.locator("#ws-ov-orgs");
      await expect(card.locator(".load-failed"), "a failed read is shown as a failure").toContainText("Could not load organisers", { timeout: 15000 });
      await expect(card, "…never as 'nobody organises this'").not.toContainText("No organisers yet");
      expect(failed, "the failing read really ran").toBe(1);
      await card.locator('[data-action="ws-organisers-retry"]').click();
      await expect(card, "Try again reads again and settles").toContainText("No organisers yet", { timeout: 15000 });
      await expect(card).not.toContainText("Loading");
    } finally {
      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  test("CONTROL: a granted organiser is listed by name", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const comp = await liveEvent(sa, h, "orgs2");
    const p = await participant(sa, h);
    try {
      const g = await sa.post(`/api/admin/competitions/${comp.id}/admins`, { headers: h, data: { userId: p.id } });
      expect(g.ok(), `grant: ${await g.text()}`).toBeTruthy();
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, comp.name);
      await openOverviewDetail(page);
      const card = page.locator("#ws-ov-orgs");
      await expect(card).toContainText(p.email, { timeout: 15000 });
      await expect(card).not.toContainText("Loading");
    } finally {
      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: h }).catch(() => {});
      await sa.delete(`/api/admin/participants/${p.id}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });
});

test.describe("the participant board of an ended event is final", () => {
  test("live: 'Live Rankings' + 'Updates automatically'; ended: 'Final standings', no live line", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const comp = await liveEvent(sa, h, "final");
    const me = await participant(sa, h);
    const other = await participant(sa, h);
    try {
      const as = await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [me.id, other.id], competitionIds: [comp.id] } });
      expect(as.ok(), `assign: ${as.status()} ${await as.text()}`).toBeTruthy();
      expect((await as.json()).assigned, "PRECONDITION: both participants were assigned").toBe(2);
      await loginViaApi(page, me.email, PARTICIPANT_PASS);
      let pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } });
      expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      await page.goto("/");
      await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click({ timeout: 20000 });
      const title = page.locator("#lb-page-title");
      const sub = page.locator("#lb-subtitle");
      // POSITIVE CONTROL — a live event keeps the live copy.
      await expect(sub).toContainText("Updates automatically", { timeout: 15000 });
      await expect(sub, "it promises no fixed interval").not.toContainText(/every \d/);
      await expect(title).toHaveText("Live Rankings");

      expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: h, data: {} })).ok(), "End Now").toBeTruthy();
      pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const dis = await page.request.post("/api/dismiss-ended", { headers: H(pc), data: { competitionId: comp.id } });
      expect(dis.ok(), `dismiss-ended: ${dis.status()} ${await dis.text()}`).toBeTruthy();
      await page.reload();
      for (let i = 0; i < 12; i++) {
        if (!(await page.locator("#modal-overlay.open").count())) break;
        const shown = await page.locator("#modal-box").textContent();
        await page.locator("#modal-confirm-btn").click().catch(() => {});
        // Settled once this dialog is gone: the overlay closed, or another dialog replaced it.
        await expect.poll(async () => !(await page.locator("#modal-overlay.open").count()) || (await page.locator("#modal-box").textContent()) !== shown,
          { message: "the confirmed dialog closed" }).toBe(true);
      }
      if (!(await page.locator("#leaderboard-page.active").count())) {
        await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click({ timeout: 15000 });
      }
      await expect(title, "an ended event's board is final").toHaveText("Final standings", { timeout: 15000 });
      await expect(sub, "…the sub line still names the event").toContainText(comp.name);
      await expect(sub, "…and promises no live updates").not.toContainText("Updates");
      await expect(page.locator("#lb-live-badge")).toBeHidden();
    } finally {
      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: h }).catch(() => {});
      for (const p of [me, other]) await sa.delete(`/api/admin/participants/${p.id}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });
});
