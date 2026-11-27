// @ts-check
//
// v8.12.4 — account- and participant-side controls no test had ever PRESSED.
//
// A coverage run showed each handler below never executing in a browser:
// the server half was covered through the API, the button that reaches it was
// not. (doLogout is NOT here: it appeared on the same list, but it navigates
// within the coverage poll's window, and ui-participant-b already clicks it —
// a coverage gap that is a measurement artefact rather than a missing test.)
// Every test presses the real control and reads the STORED result, with a
// control where "it did nothing" would otherwise pass.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, clickTab, loginViaApi } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const dbAll = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};
const dbRun = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...a); } finally { db.close(); }
};

/** Sign a participant in on the page's own context, then load the app. */
async function participantIn(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await page.goto("/");
}
async function confirmModal(page, expectText) {
  const ov = page.locator("#modal-overlay.open");
  await ov.waitFor({ state: "visible", timeout: 8000 });
  if (expectText) await expect(ov).toContainText(expectText);
  await page.locator("#modal-confirm-btn").click();
}

test.describe("v8.12.4 — signed-out and session controls", () => {
  // The status stub below answers through route.fetch(); a boot probe that
  // re-enters it as a test ends (Logout now navigates to the anonymous page,
  // which asks /api/session/status at once) must not fail the test when the
  // context closes under it. Unrouted before teardown, ignoring that last call.
  test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

  // The warning appears only when a session is inside its last minutes and the
  // person has been idle. Neither can be waited out in a test (the idle window
  // is 60 minutes), so the status reply is stubbed to "expires in 90 s" and the
  // activity clock is wound back; the monitor's own tick then raises the real
  // dialog, and the button presses go to the REAL server.
  async function raiseWarning(page) {
    await page.route("**/api/session/status", async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({ json: { ...body, active: true, expires_at: new Date(Date.now() + 90_000).toISOString() } });
    });
    await page.evaluate(async () => {
      // @ts-ignore — the SPA publishes its module exports on window (main.js boot)
      window._sessionMon.lastActivityAt = 0;
      // @ts-ignore
      await window._sessionMonTick();
    });
    await expect(page.locator("#session-warn-overlay")).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#session-warn-countdown")).toHaveText(/^1:[0-3]\d$/);
  }

  test("session warning → Stay logged in extends the session and keeps the person signed in", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, csrf, "warn-stay"); } finally { await sa.dispose(); }
    await participantIn(page, p.email);
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });
    await raiseWarning(page);
    const keep = page.waitForResponse(r => r.url().endsWith("/api/session/keepalive") && r.request().method() === "POST");
    await page.locator('[data-action="session-warn-stay"]').click();
    expect((await keep).status(), "the keepalive really reached the server").toBe(200);
    await expect(page.locator("#session-warn-overlay")).toHaveCount(0);
    expect((await page.request.get("/api/me")).status(), "still signed in").toBe(200);
  });

  test("an open session warning closes once the shared session was extended elsewhere, active tab or idle", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, csrf, "warn-slid"); } finally { await sa.dispose(); }
    await participantIn(page, p.email);
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });
    // The expiry the status reply reports: near at first, then an hour away once
    // another tab's writes have slid the session the tabs share.
    let leftMs = 90_000;
    await page.route("**/api/session/status", async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({ json: { ...body, active: true, expires_at: new Date(Date.now() + leftMs).toISOString() } });
    });
    const warn = page.locator("#session-warn-overlay");
    const tick = (active) => page.evaluate(async (a) => {
      // @ts-ignore — the SPA publishes its module exports on window (main.js boot)
      window._sessionMon.lastActivityAt = a ? Date.now() : 0;
      // @ts-ignore
      await window._sessionMonTick();
    }, active);

    await tick(false);
    await expect(warn).toBeVisible({ timeout: 8000 });
    // CONTROL: a tick that still reads the near expiry leaves the warning up.
    await tick(false);
    await expect(warn).toBeVisible();

    // The person comes back to this tab (activity) after working in another one:
    // the keepalive is skipped (an hour is left), and the warning must still go.
    leftMs = 59 * 60_000;
    await tick(true);
    await expect(warn, "an active tab drops the stale warning").toHaveCount(0);

    // Raised again, then the same slide seen by an IDLE tab.
    leftMs = 90_000;
    await tick(false);
    await expect(warn).toBeVisible({ timeout: 8000 });
    leftMs = 59 * 60_000;
    await tick(false);
    await expect(warn, "an idle tab drops the stale warning too").toHaveCount(0);
  });

  test("session warning → Logout now ends the session on the server, not just the page", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, csrf, "warn-out"); } finally { await sa.dispose(); }
    await participantIn(page, p.email);
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });
    await raiseWarning(page);
    const out = page.waitForResponse(r => r.url().endsWith("/api/logout") && r.request().method() === "POST");
    await page.locator('[data-action="session-warn-logout"]').click();
    expect((await out).status()).toBe(200);
    await page.waitForSelector("#login-email", { timeout: 20000 });
    expect((await page.request.get("/api/me")).status(), "the session is gone server-side").toBe(401);
  });
});

test.describe("v8.12.4 — participant controls", () => {
  test("the difficulty chips narrow the challenge list, and All restores it", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p, easy, hard;
    try {
      const comp = await makeCompetition(sa, csrf, "diff-ui");
      easy = await makeTask(sa, csrf, "diff-easy", { difficulty: "easy" });
      hard = await makeTask(sa, csrf, "diff-hard", { difficulty: "hard" });
      await assignTask(sa, csrf, easy.id, [comp.id]);
      await assignTask(sa, csrf, hard.id, [comp.id]);
      p = await makeParticipant(sa, csrf, "diff-ui");
      await enrol(sa, csrf, comp.id, [p.id]);
    } finally { await sa.dispose(); }
    await participantIn(page, p.email);   // exactly one event: the sole-event landing puts them in it
    await page.waitForSelector("#task-grid .task-card", { timeout: 30000 });
    const shown = () => page.locator("#task-grid .task-card").evaluateAll(
      (cs, t) => t.filter(x => cs.some(c => (c.textContent || "").includes(x))), [easy.title, hard.title]);
    await expect.poll(shown, { timeout: 8000 }).toEqual([easy.title, hard.title]);
    await page.locator('#diff-filters [data-action="filter-tasks"][data-filter="hard"]').click();
    await expect.poll(shown, { timeout: 8000 }).toEqual([hard.title]);
    await expect(page.locator('#diff-filters [data-filter="hard"]')).toHaveClass(/active/);
    await page.locator('#diff-filters [data-action="filter-tasks"][data-filter="all"]').click();
    await expect.poll(shown, { timeout: 8000 }).toEqual([easy.title, hard.title]);
  });

  test("a star rating is stored, and a second press CHANGES it rather than adding a row", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p, task;
    try {
      const comp = await makeCompetition(sa, csrf, "stars-ui");
      task = await makeTask(sa, csrf, "stars-ui");
      await assignTask(sa, csrf, task.id, [comp.id]);
      p = await makeParticipant(sa, csrf, "stars-ui");
      await enrol(sa, csrf, comp.id, [p.id]);
    } finally { await sa.dispose(); }
    const rating = () => dbAll("SELECT rating FROM task_feedback WHERE user_id=? AND task_id=?", p.id, task.id).map(r => r.rating);
    await participantIn(page, p.email);
    await page.locator(`.task-card:has-text("${task.title}")`).first().click();
    await page.waitForSelector("#star-rating", { timeout: 20000 });
    await page.locator('#star-rating [data-action="task-star"][data-value="4"]').click();
    await expect.poll(rating, { timeout: 8000 }).toEqual([4]);
    await expect(page.locator("#star-label")).toHaveText("Your rating: 4/5");
    await page.locator('#star-rating [data-action="task-star"][data-value="2"]').click();
    await expect.poll(rating, { timeout: 8000 }).toEqual([2]);
  });

  test("Remind me on the waiting page stores ONE reminder and the button turns into its confirmation", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let p, comp;
    try {
      comp = await makeCompetition(sa, csrf, "remind-ui", { start_time: new Date(Date.now() + 5 * 3_600_000).toISOString() });
      p = await makeParticipant(sa, csrf, "remind-ui");
      await enrol(sa, csrf, comp.id, [p.id]);
    } finally { await sa.dispose(); }
    const count = () => dbGet("SELECT COUNT(*) n FROM email_reminders WHERE user_id=? AND competition_id=?", p.id, comp.id).n;
    expect(count(), "PRECONDITION: none yet").toBe(0);
    await participantIn(page, p.email);   // the only event is upcoming → the waiting page
    const btn = page.locator(`#pending-reminder [data-action="request-reminder"][data-comp-id="${comp.id}"]`);
    await btn.waitFor({ state: "visible", timeout: 20000 });
    await btn.click();
    await expect.poll(count, { timeout: 8000 }).toBe(1);
    await expect(page.locator("#pending-reminder .pending-reminder-set")).toBeVisible();
    await expect(btn, "the control is replaced, so it cannot be pressed twice").toHaveCount(0);
  });
});

test.describe("v8.12.4 — superadmin settings and export controls", () => {
  test("Save Name stores the platform name and repaints it; the default is restored afterwards", async ({ page }) => {
    const name = `Tidy Platform ${uniq("pn").slice(-6)}`;
    try {
      await adminLogin(page);
      await clickTab(page, "Settings");
      await page.locator("#settings-platform-name").fill(name);
      await page.locator('[data-action="save-platform-name"]').click();
      await expect.poll(() => dbGet("SELECT value FROM settings WHERE key='platform_name'")?.value, { timeout: 8000 }).toBe(name);
      await expect(page).toHaveTitle(new RegExp(name));
    } finally {
      // A test that writes a global setting restores the hard-coded DEFAULT, in a
      // finally (Recurring rules). The page's login ended any earlier API
      // session for this user, so this one is fresh.
      const { api: sa, csrf } = await apiLogin("superadmin");
      try {
        const r = await sa.patch("/api/admin/settings", { headers: H(csrf), data: { platform_name: "Checkmarx Enablement Platform" } });
        expect(r.ok(), `restore: ${await r.text()}`).toBeTruthy();
      } finally { await sa.dispose(); }
    }
  });

  test("Remove on the unsubscribe list deletes that address and only that address", async ({ page }) => {
    const gone = `unsub-go-${uniq("u").toLowerCase()}@acme.com`, stay = `unsub-stay-${uniq("u").toLowerCase()}@acme.com`;
    const now = new Date().toISOString();
    for (const e of [gone, stay]) dbRun("INSERT INTO unsubscribed_emails (email, unsubscribed_at, reason) VALUES (?,?,?)", e, now, "test");
    try {
      await adminLogin(page);
      await clickTab(page, "Settings");
      await require("./ui-admin-helpers").openSettingsSection(page, "email");   // two panes: the list is in Email
      const btn = page.locator(`#unsubscribe-list-body [data-action="unsub-remove"][data-email="${gone}"]`);
      await btn.waitFor({ state: "visible", timeout: 15000 });
      await btn.click();
      await confirmModal(page, gone);
      await expect.poll(() => dbGet("SELECT email FROM unsubscribed_emails WHERE email=?", gone), { timeout: 8000 }).toBeUndefined();
      expect(dbGet("SELECT email FROM unsubscribed_emails WHERE email=?", stay), "the other address is untouched").toBeTruthy();
    } finally {
      dbRun("DELETE FROM unsubscribed_emails WHERE email IN (?,?)", gone, stay);
    }
  });

  test("Export on the Challenges pane downloads a JSON file carrying the challenges", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let task;
    try { task = await makeTask(sa, csrf, "export-ui"); } finally { await sa.dispose(); }
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const dl = page.waitForEvent("download");
    await page.locator("#export-tasks-btn").click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/^tasks-export-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(require("fs").readFileSync(await file.path(), "utf8"));
    expect(Array.isArray(data.tasks)).toBeTruthy();
    expect(data.tasks.map(t => t.title), "the file carries the challenge just made").toContain(task.title);
  });
});
