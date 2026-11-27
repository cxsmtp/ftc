// @ts-check
// v7.2.0 — browser coverage for the instant-join "Verify email" header
// indicator. The API behaviour is locked in functional-core.api.spec.js
// ("instant-join 48h verification grace"); this asserts the SPA wiring:
// a grace participant sees the countdown chip next to their nickname and can
// open its "Resend verification email" dialog. New file — does not touch the
// existing regression specs.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
const Database = require("better-sqlite3");
const { AxeBuilder } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

// Register through a LIVE competition's join link (approved, verified=0)
// and have the organiser reveal a DESK code for it. A desk code proves no
// address, so redeeming it signs the account in UNVERIFIED with a 48-hour grace
// window — the state the chip exists for. (An EMAILED code would verify it.)
// Returns its email, the desk code and the competition id.
async function makeGraceAccount() {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const h = { "x-csrf-token": csrf, "content-type": "application/json" };
  const start = new Date(Date.now() - 30 * 60_000).toISOString(); // live now
  const cr = await sa.post("/api/admin/competitions", { headers: h, data: { name: `SE-vind-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, start_time: start, duration_minutes: 240 } });
  const compId = (await cr.json()).competition.id;
  const rv = await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json();
  await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { self_enroll_enabled: true, expectedUpdatedAt: rv.updated_at } });
  const { api, csrf: rcsrf } = await freshCtx();
  const email = `se-vind-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
  const nick = `sevind${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 28);
  const rr = await registerPost(api, "/api/register", { headers: { "x-csrf-token": rcsrf, "content-type": "application/json" }, data: {
    firstName: "Grace", lastName: "Indicator", nickname: nick, email, company: "Co", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Security Researcher", city: "Tel Aviv",
    joinToken: rv.token,
  } });
  const body = await rr.json();
  if (!body.ok) throw new Error(`join-link register did not sign the account in: ${JSON.stringify(body)}`);
  await api.dispose();
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const row = db.prepare("SELECT id, approved, verified FROM users WHERE LOWER(email)=LOWER(?)").get(email);
  db.close();
  expect(row, "PRECONDITION: the account exists").toBeTruthy();
  expect(row.approved, "PRECONDITION: a join-link sign-up is approved").toBe(1);
  expect(row.verified, "PRECONDITION: and not yet verified").toBe(0);
  const rev = await sa.post(`/api/admin/participants/${row.id}/login-code/reveal`, { headers: h });
  expect(rev.ok(), `desk reveal: ${rev.status()} ${await rev.text()}`).toBeTruthy();
  const deskCode = (await rev.json()).code;
  await sa.dispose();
  return { email, compId, deskCode };
}

async function cleanup(email, compId) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const id = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)?.id;
  db.close();
  const { api, csrf } = await apiLogin("superadmin");
  if (id) await api.delete(`/api/admin/participants/${id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
  await api.dispose();
}

test("grace participant sees the Verify-email countdown chip and can open the resend dialog", async ({ page }) => {
  const { email, compId, deskCode } = await makeGraceAccount();
  try {
    await page.goto("/");
    await page.waitForSelector("#login-email", { timeout: 5000 });
    // The walk-up types the code the organiser read out: Continue opens the code
    // step, and a live desk code is never superseded by an emailed one.
    await page.fill("#login-email", email);
    await page.click("#login-submit");
    await page.locator("#sc-code").fill(deskCode);
    await page.locator("#signin-code-overlay [data-action='signin-code-redeem']").click();

    // The chip renders next to the nickname with a live "… left" countdown.
    const chip = page.locator("#verify-indicator");
    await expect(chip).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#verify-countdown")).toContainText("left");

    // WCAG 2.5.3 — the chip is NAMED by what it shows, in that order: "Verify
    // email", then the countdown, then what a press does. The countdown is visible
    // text inside the chip, so the name carries it and must move with every tick
    // (renderVerifyIndicator writes both); a name that stayed "… — open
    // verification help" while the chip read "Verify email 47h 59m left" is what
    // axe 4.14's label-content-name-mismatch refused. The profile chip beside it
    // opens with the nickname it shows.
    const shown = (await page.locator("#verify-countdown").textContent()).trim();
    expect(shown, "PRECONDITION: a countdown is on screen").toMatch(/left$/);
    await expect(chip).toHaveAttribute("aria-label", `Verify email, ${shown} — open verification help`);
    const axe = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).include("#user-info").analyze();
    expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.html.slice(0, 160))),
      "the header chips name themselves by what they show").toEqual([]);

    // v7.2.x (audit, F8) — guard against the header-overlap regression: the
    // chip's own centre point must resolve to the chip (or a descendant), not
    // the theme-toggle that used to overlap it (intercepting this click) when
    // the non-wrapping header overran the viewport. Deterministically fails
    // pre-fix (header lacked flex-wrap), passes after.
    const hitsChip = await chip.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(hit && (hit === el || el.contains(hit)));
    });
    expect(hitsChip, "verify chip centre must not be obscured by another header element").toBe(true);

    // Clicking it opens the resend dialog (showModal: primary = Resend).
    await chip.click();
    await expect(page.locator("#modal-confirm-btn")).toHaveText(/Resend verification email/i);
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-confirm-btn")).toBeHidden({ timeout: 5000 });
  } finally {
    await cleanup(email, compId);
  }
});
