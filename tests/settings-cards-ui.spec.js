// @ts-check
//
// THE SUPERADMIN SETTINGS CARDS IN THE BROWSER, and the approval-required mode
// end to end (public/js/features/settings-admin.js, admin-alerts.js, auth.js).
//
// Each route has API coverage; these hold the WIRING: what each card shows for
// each answer, that its controls send what they say, that a saved switch is
// read back from the server, and the screens a held account meets.
//
//  - Email: the relay's three states and a failed read, Send test email (refusal, success, the
//    re-read that follows).
//  - Data & retention: the server's figures, and a real sweep's time and count;
//    its unused-picture clean-up, removed or held (maintenance on).
//  - Alerts: an open alert's row and Review; a dismissal leaves the card at once.
//    At 390 px the card's sentence wraps inside the card.
//  - Sign-in & accounts: the approval switch saves for real and reads back, a
//    refused save puts the box back, and the Pending chip and the workspace's
//    join note follow it.
//  - With approval on: a held sign-up, a pending code sign-in and a pending
//    password sign-in each land on the pending page; with it off (CONTROL) the
//    same code sign-in lands in the app.
//
// The approval setting is global: every test that turns it on restores the
// hard-coded default (off) in a finally.
//
// ONE SESSION PER PRINCIPAL: signing the built-in superadmin in again (apiLogin)
// ends the browser's superadmin session, so once a test's page has signed in,
// its reads and writes go through the page's own session (`page.request`).

const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, BASE, TEST_DB_PATH, TEST_DATA_DIR } = require("./helpers");
const { adminLogin, clickTab, openSettingsSection, viewComp, login, signUpViaUi } = require("./ui-admin-helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

async function setApproval(on) {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const r = await api.patch("/api/admin/settings", { headers: H(csrf), data: { require_account_approval: !!on } });
    expect(r.ok(), `set approval ${on}: ${r.status()} ${await r.text()}`).toBeTruthy();
  } finally { await api.dispose(); }
}
async function approvalStored() {
  const { api } = await apiLogin("superadmin");
  try { return (await (await api.get("/api/admin/settings")).json()).require_account_approval; } finally { await api.dispose(); }
}
/** A registered account rewound to registerPost's fixture state: unverified and pending (no sign-up creates it). */
async function pendingAccount(label) {
  const email = `${label}@company.example`;
  const { api, csrf } = await freshCtx();
  try {
    const r = await registerPost(api, "/api/register", { headers: H(csrf), data: {
      firstName: "Held", lastName: "Back", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "X" } });
    expect(r.ok(), `register ${email}: ${await r.text()}`).toBeTruthy();
  } finally { await api.dispose(); }
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const row = d.prepare("SELECT approved, denied_at FROM users WHERE email=?").get(email);
    expect(row && row.approved, `PRECONDITION: ${email} is pending`).toBe(0);
  } finally { d.close(); }
  return email;
}
const pendingPage = (page) => page.locator("#pending-approval-page.active");

test.describe("Settings cards in the browser", () => {
  test.afterEach(async () => {
    const { api } = await apiLogin("superadmin");
    try { await api.post("/api/test/clear-ip-ban-alerts"); } finally { await api.dispose(); }
  });

  test("Email: the relay's three states, and Send test email sends the address and reads the relay again", async ({ page }) => {
    let smtp = true;
    let alertsReads = 0;
    await page.route("**/api/admin/alerts", (r) => {
      if (r.request().method() !== "GET") return r.continue();
      alertsReads++;
      if (smtp === "fail") return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) });
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ alerts: [], isSuperAdmin: true, smtp_healthy: smtp, cxone_withdrawals_attention: 0 }) });
    });
    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "email");
    const status = page.locator("#email-relay-status");
    await expect(status).toHaveText("The mail relay answered its last check.");
    await expect(status).toHaveClass(/settings-relay-ok/);
    for (const [v, text, cls] of [
      [false, "The mail relay failed its last check — sign-in codes and invitations may not arrive.", /settings-relay-bad/],
      [null, "The mail relay has not been checked since the last restart.", null],
      // The read itself failed: the card says it could not check, never a state.
      ["fail", "Could not check the mail relay. Send a test to find out.", null],
    ]) {
      smtp = v;
      await page.evaluate(() => window.loadEmailCard());
      await expect(status).toHaveText(text);
      if (cls) await expect(status).toHaveClass(cls);
      else await expect(status, "an unknown state claims neither health nor failure").not.toHaveClass(/settings-relay-(ok|bad)/);
    }
    // CONTROL — once the read answers again, so does the card.
    smtp = true;
    await page.evaluate(() => window.loadEmailCard());
    await expect(status).toHaveText("The mail relay answered its last check.");
    await expect(status).toHaveClass(/settings-relay-ok/);

    const posts = [];
    let answer = { status: 502, body: { error: "the relay refused the connection" } };
    await page.route("**/api/admin/test-email", (r) => {
      posts.push(r.request().postDataJSON());
      return r.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    });
    const to = page.locator("#settings-test-email-to");
    const send = page.locator('[data-action="send-test-email"]');
    // Not an address: nothing is sent.
    await to.fill("not-an-address");
    await send.click();
    await expect(page.locator("#toast-stack .toast").last()).toHaveText("Enter the address to send the test to.");
    expect(posts, "no request for a non-address").toEqual([]);
    // A refused send says why.
    await to.fill("ops@company.example");
    await send.click();
    await expect(page.locator("#toast-stack .toast").last()).toHaveText("The test email was not sent: the relay refused the connection");
    expect(posts).toEqual([{ to: "ops@company.example" }]);
    // A sent one says so, and the relay status is read again.
    answer = { status: 200, body: { ok: true } };
    smtp = true;
    const readsBefore = alertsReads;
    await send.click();
    await expect(page.locator("#toast-stack .toast").last()).toHaveText("Test email sent to ops@company.example.");
    await expect.poll(() => alertsReads, { message: "the relay status is re-read after a send" }).toBeGreaterThan(readsBefore);
    await expect(status).toHaveText("The mail relay answered its last check.");
  });

  test("Data & retention: the server's figures, then a real sweep's time and count", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    let before;
    try { before = await (await api.get("/api/admin/retention")).json(); } finally { await api.dispose(); }
    expect(before.last_purge, "PRECONDITION: no sweep has run in this server").toBeNull();
    expect(before.tables.length).toBeGreaterThan(0);

    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "general");
    const facts = () => page.locator("#retention-body .settings-facts").evaluate((dl) => {
      const out = {};
      const dts = [...dl.querySelectorAll("dt")];
      for (const dt of dts) out[dt.textContent] = dt.nextElementSibling.textContent;
      return out;
    });
    await expect(page.locator("#retention-body .settings-facts")).toBeVisible({ timeout: 15000 });
    const f0 = await facts();
    expect(f0["Kept for"]).toBe(`${before.retention_days} days`);
    expect(f0["Last sweep"]).toBe("Not since the last restart");
    expect(f0["Covers"]).toBe(before.tables.join(", "));

    const sweep = await page.request.post("/api/admin/retention/purge", { headers: H((await (await page.request.get("/api/csrf-token")).json()).csrfToken) });
    expect(sweep.ok(), `sweep: ${sweep.status()}`).toBeTruthy();
    const after = await (await page.request.get("/api/admin/retention")).json();
    expect(after.last_purge && typeof after.last_purge.at, "PRECONDITION: the sweep was recorded").toBe("string");
    expect(typeof after.last_purge.total, "PRECONDITION: the sweep says how many it removed").toBe("number");
    await page.evaluate(() => window.loadRetentionCard());
    const want = await page.evaluate((lp) => `${window.fmtDt(lp.at, "long")} · ${lp.total} removed`, after.last_purge);
    await expect.poll(async () => (await facts())["Last sweep"], { message: "the sweep's own time and count" }).toBe(want);
  });

  // The sweep holds its picture clean-up while the instance is out of service
  // (maintenance here; lib/event-retention.js), and the card says so, as a hold
  // can last until the database is fixed and the server restarted. CONTROL: a
  // sweep in service says how many unused pictures it removed.
  test("Data & retention: the last sweep's unused pictures, removed in service and held in maintenance", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "general");
    await expect(page.locator("#retention-body .settings-facts")).toBeVisible({ timeout: 15000 });
    const pictures = () => page.locator("#retention-body .settings-facts").evaluate((dl) => {
      const dt = [...dl.querySelectorAll("dt")].find((x) => x.textContent === "Unused pictures");
      return dt ? dt.nextElementSibling.textContent : null;
    });
    const token = async () => (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    // CONTROL: in service the clean-up runs and the card counts what it removed.
    const ok = await page.request.post("/api/admin/retention/purge", { headers: H(await token()) });
    expect(ok.ok(), `sweep: ${ok.status()}`).toBeTruthy();
    const okBody = await ok.json();
    expect(okBody.images_held, "PRECONDITION: in service the picture clean-up ran").toBe(false);
    expect(typeof okBody.images_purged, "PRECONDITION: and counted what it removed").toBe("number");
    await page.evaluate(() => window.loadRetentionCard());
    await expect.poll(pictures, { message: "CONTROL: the count of pictures removed" })
      .toBe(`${okBody.images_purged} removed${okBody.images_capped ? ", more on the next sweep" : ""}`);
    // Maintenance on: the same sweep holds the clean-up.
    const file = path.join(TEST_DATA_DIR, ".maintenance");
    const bypass = `retention-held-${uniq()}`;
    const csrf = await token();   // before the gate goes up
    let held;
    try {
      fs.writeFileSync(file, bypass);
      const r = await page.request.post("/api/admin/retention/purge", { headers: { ...H(csrf), "X-Maintenance-Bypass": bypass } });
      expect(r.ok(), `sweep in maintenance: ${r.status()} ${await r.text()}`).toBeTruthy();
      held = await r.json();
    } finally { fs.rmSync(file, { force: true }); }
    expect(held.images_held, "PRECONDITION: in maintenance the picture clean-up was held").toBe(true);
    await page.evaluate(() => window.loadRetentionCard());
    await expect.poll(pictures, { message: "the card says the clean-up was held, and why" })
      .toBe("Clean-up held: the database failed a start-up check, or maintenance is on");
  });

  test("Alerts: an open alert's row and Review; a dismissal leaves the card at once", async ({ page }) => {
    await adminLogin(page);   // the boot tick sees no alert yet
    const raised = await (await page.request.post("/api/test/raise-ip-ban-alert", { data: { ip: "198.51.100.77" } })).json();
    expect(raised.alert && raised.alert.id, "PRECONDITION: an alert is open").toBeTruthy();
    await clickTab(page, "settings"); await openSettingsSection(page, "general");
    const body = page.locator("#alerts-body");
    await expect(body.locator(".list-count")).toHaveText("1 open alert", { timeout: 15000 });
    await expect(body.locator(".settings-alert-row")).toContainText("198.51.100.77");
    const review = body.locator(`[data-action="settings-alert-open"][data-id="${raised.alert.id}"]`);
    await expect(review).toHaveAttribute("aria-label", "Review alert for 198.51.100.77");
    await review.click();
    const overlay = page.locator("#admin-alert-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("198.51.100.77");
    const acked = page.waitForResponse((r) => r.url().includes(`/api/admin/alerts/${raised.alert.id}/ack`) && r.request().method() === "POST");
    await overlay.locator('[data-action="admin-alert-dismiss"]').click();
    expect((await acked).ok(), "the dismissal was recorded").toBe(true);
    await expect(overlay).toHaveCount(0);
    await expect(body.locator(".list-count"), "the card reads the list again").toHaveText(/^No open alerts\./);
    await expect(review, "no Review for an alert that is gone").toHaveCount(0);
  });

  test("Alerts: at 390 px the card's sentence wraps inside the card", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await adminLogin(page);
    await clickTab(page, "settings"); await openSettingsSection(page, "general");
    const line = page.locator("#alerts-body .list-count");
    await expect(line).toHaveText(/^No open alerts\./, { timeout: 15000 });
    const g = await line.evaluate((p) => {
      const card = p.closest(".settings-card").getBoundingClientRect(), r = p.getBoundingClientRect();
      return { right: r.right, cardRight: card.right, sw: p.scrollWidth, cw: p.clientWidth, lines: Math.round(r.height / parseFloat(getComputedStyle(p).lineHeight)), vw: innerWidth };
    });
    expect(g.right, "the sentence ends inside its card").toBeLessThanOrEqual(g.cardRight + 0.5);
    expect(g.sw, "nothing overflows the line box").toBeLessThanOrEqual(g.cw + 1);
    expect(g.lines, "it wraps rather than running on").toBeGreaterThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "no sideways scroll").toBe(true);
  });
});

test.describe("Approval required: the switch and what a held account meets", () => {
  test("the switch saves for real and reads back, a refused save puts it back, and the Pending chip and join note follow it", async ({ page }) => {
    expect(await approvalStored(), "PRECONDITION: the default, off").toBe(false);
    // An event with its join link on, for the workspace's join note.
    const { api, csrf } = await apiLogin("superadmin");
    const evName = `Approval ${uniq()}`;
    try {
      const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: evName, event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120,
        self_enroll_enabled: true } });
      expect(r.ok(), await r.text()).toBeTruthy();
    } finally { await api.dispose(); }
    try {
      await adminLogin(page);
      // From here on the page's own session reads and writes (see the header).
      const stored = async () => (await (await page.request.get("/api/admin/settings")).json()).require_account_approval;
      const toast = page.locator("#toast-stack .toast").last();
      const saveBy = async (act) => {
        const saved = page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH");
        await act();
        return saved;
      };
      const openAccounts = async () => { await clickTab(page, "settings"); await openSettingsSection(page, "signin"); };
      const peopleLoaded = async () => {
        await clickTab(page, "Participants");
        await expect.poll(() => page.evaluate(() => (window.S.adminParticipantsData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
      };
      const joinNote = async () => {
        await clickTab(page, "Events");
        await viewComp(page, evName);
        await page.locator(".ws-join-pill").first().click();
        return page.locator("#ws-join-pop .ws-join-note");
      };
      const box = page.locator("#settings-require-approval");
      const chip = page.locator('#p-status-filters [data-value="pending"]');

      // CONTROL first, with the setting off: nobody waits, so the chip is hidden.
      await peopleLoaded();
      expect(await page.evaluate(() => (window.S.adminParticipantsData || []).some((p) => !p.approved && !p.denied_at)),
        "PRECONDITION: nobody is waiting, so only the setting can show the chip").toBe(false);
      await expect(chip).toHaveAttribute("hidden", "");

      // On, through the switch: saved for real, and read back after a reload.
      await openAccounts();
      await expect(box).not.toBeChecked();
      expect((await saveBy(() => box.check())).ok()).toBe(true);
      await expect(toast).toHaveText("New accounts now wait for admin approval.");
      expect(await stored(), "the server holds what the switch shows").toBe(true);
      // The People list follows the switch at once: the Pending chip shows…
      await peopleLoaded();
      await expect(chip).not.toHaveAttribute("hidden", "");
      // …but an event's join note does NOT say walk-ups wait: a sign-up through
      // the join link is approved whatever this setting (operator ruling, 3 Nov 2026).
      const noteOn = await joinNote();
      await expect(noteOn).toContainText("Walk-ups confirm their email with a code, then join at once.", { timeout: 15000 });
      await expect(noteOn, "no approval wait is claimed for a join-link walk-up").not.toContainText(/approv/i);
      // A reload reads the stored value back: the box, and the chip, from the server.
      await page.reload();
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
      await openAccounts();
      await expect(box, "the box shows the stored value after a reload").toBeChecked();
      await peopleLoaded();
      await expect(chip, "after a reload the chip follows the stored setting").not.toHaveAttribute("hidden", "");

      // Off again through the switch: the chip goes and the note says what walk-ups do.
      await openAccounts();
      expect((await saveBy(() => box.uncheck())).ok()).toBe(true);
      await expect(toast).toHaveText("New accounts are approved when they enter their first emailed code.");
      expect(await stored()).toBe(false);
      await peopleLoaded();
      await expect(chip).toHaveAttribute("hidden", "");
      await expect(await joinNote()).toContainText("Walk-ups confirm their email with a code, then join at once.", { timeout: 15000 });

      // A refused save puts the box back and says why; nothing is stored.
      await page.route("**/api/admin/settings", (r) => (r.request().method() === "PATCH"
        ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"The settings could not be saved."}' })
        : r.continue()));
      await openAccounts();
      // click(), not check(): check() asserts the box ends ticked, and the app
      // rightly puts it back as soon as the refused answer lands, which can be
      // before Playwright looks. The refused PATCH is awaited as the control
      // that the save was really attempted.
      const refusedSave = page.waitForRequest((rq) => rq.url().includes("/api/admin/settings") && rq.method() === "PATCH");
      await box.click();
      await refusedSave;
      await expect(toast).toHaveText("The settings could not be saved.");
      await expect(box, "the box never shows a state the server does not hold").not.toBeChecked();
      expect(await stored()).toBe(false);
    } finally { await setApproval(false); }
  });

  test("with approval on, a held sign-up, a pending code sign-in and a pending password sign-in land on the pending page", async ({ browser }) => {
    const held = `held${uniq()}`.slice(0, 18);
    const codeUser = await pendingAccount(`pc${uniq()}`.slice(0, 18));
    const pwUser = await pendingAccount(`pp${uniq()}`.slice(0, 18));
    const control = await pendingAccount(`pk${uniq()}`.slice(0, 18));
    // The password account: a usable password, verified, still unapproved.
    const PW = "Held-back-Passw0rd";
    {
      const bcrypt = require("bcrypt");
      const hash = await bcrypt.hash(PW, 4);
      const d = new Database(TEST_DB_PATH, { timeout: 5000 });
      try {
        const n = d.prepare("UPDATE users SET password_hash=?, password_set_at=?, login_method='password', verified=1 WHERE email=? AND approved=0")
          .run(hash, new Date().toISOString(), pwUser).changes;
        expect(n, "PRECONDITION: the password account was set up").toBe(1);
      } finally { d.close(); }
    }
    const fresh = async () => { const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } }); return { ctx, page: await ctx.newPage() }; };
    await setApproval(true);
    try {
      // 1. A sign-up through the entry screen is held.
      {
        const { ctx, page } = await fresh();
        try {
          await page.goto("/");
          const resp = await signUpViaUi(page, `${held}@company.example`);
          expect(await (await resp).json()).toEqual(expect.objectContaining({ ok: true, pendingApproval: true }));
          await expect(pendingPage(page)).toBeVisible({ timeout: 15000 });
          await expect(pendingPage(page)).toContainText("Account Pending Approval");
        } finally { await ctx.close(); }
      }
      // 2. A pending account's emailed code: consumed, and held.
      {
        const { ctx, page } = await fresh();
        try {
          const redeemed = page.waitForResponse((r) => r.url().includes("/api/auth/code/redeem"));
          await login(page, codeUser);
          expect(await (await redeemed).json()).toEqual(expect.objectContaining({ ok: false, error: "pending_approval" }));
          await expect(pendingPage(page)).toBeVisible({ timeout: 15000 });
        } finally { await ctx.close(); }
      }
      // 3. A pending password account: the right password, then held.
      {
        const { ctx, page } = await fresh();
        try {
          await page.goto("/");
          await page.locator("#login-email").waitFor({ state: "visible", timeout: 15000 });
          await page.fill("#login-email", pwUser);
          await page.click("#login-submit");
          await page.locator("#login-password-group:not([hidden])").waitFor({ state: "visible", timeout: 15000 });
          await page.fill("#login-password", PW);
          const door = page.waitForResponse((r) => r.url().includes("/api/auth/password") && r.request().method() === "POST");
          await page.click("#login-submit");
          expect(await (await door).json()).toEqual(expect.objectContaining({ ok: false, error: "pending_approval" }));
          await expect(pendingPage(page)).toBeVisible({ timeout: 15000 });
        } finally { await ctx.close(); }
      }
    } finally { await setApproval(false); }
    // CONTROL: with approval off, the same kind of account's emailed code signs
    // it in (and approves it) — so the pending page above is the setting's.
    {
      const { ctx, page } = await fresh();
      try {
        const redeemed = page.waitForResponse((r) => r.url().includes("/api/auth/code/redeem"));
        await login(page, control);
        expect((await (await redeemed).json()).ok).toBe(true);
        await expect(page.locator("#main-nav .nav-btn").first()).toBeVisible({ timeout: 20000 });
        await expect(pendingPage(page)).toHaveCount(0);
      } finally { await ctx.close(); }
    }
  });
});
