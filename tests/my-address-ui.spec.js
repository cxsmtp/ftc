"use strict";

// USE MY CURRENT ADDRESS — the event form's half (features/competitions-admin.js
// useMyAddressForTrustedIps), beside Trusted network IPs.
//
//   * a public address is added after what was typed (a trailing comma tidied),
//     once, and the note says it is the venue's only while the organiser is on
//     the venue's network; pressing again adds nothing and says it is listed;
//     an empty field takes the address alone, and the saved event stores it;
//   * any other range adds nothing and warns, in the status ink, that the
//     platform is probably not reading the proxy's forwarded address
//     (TRUST_PROXY) — a range the form does not know too (fail closed); a
//     refusal says why in its own words, a failure says it could not read;
//   * unstubbed, this shared server (every client is 127.0.0.1) answers
//     loopback, end to end: the 127.0.0.1 → loopback path;
//   * the button follows the field it fills: disabled with it while the
//     schedule has several sessions, its last answer withdrawn;
//   * it is offered with `events.edit`, the route's permission: a role that may
//     create but not edit events keeps the field without the button (and never
//     asks), beside a role holding both, which gets it and an answer.
// The client half stubs the read (page.route); the server half is
// tests/my-address.api.spec.js and tests/trusted-networks-e2e.api.spec.js.

const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { BASE, PARTICIPANT_PASS, TEST_DB_PATH, apiLogin, waitForAdminPage } = require("./helpers");
const { adminLogin, clickTab, loginViaApi, openCompCreateForm, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const ROUTE = "**/api/admin/my-address";
const FIELD = "#comp-trusted-ips";
const BTN = "#comp-trusted-ips-mine";
const NOTE = "#comp-trusted-ips-mine-note";

/** Answer the address read with `answer` ({status, body}); returns the call count. */
async function stubMyAddress(page, answer) {
  const calls = { n: 0 };
  await page.unroute(ROUTE).catch(() => {});
  await page.route(ROUTE, (route) => {
    calls.n++;
    return route.fulfill({ status: answer.status || 200, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  return calls;
}

async function openForm(page, kind = "tournament") {
  await adminLogin(page);
  await clickTab(page, "Events");
  await openCompCreateForm(page, kind);
  await expect(page.locator(FIELD), "PRECONDITION: the field renders for this kind").toBeVisible();
}

test.describe("Use my current address — the event form", () => {
  test("a public address is added once, after what was typed, and the note says it holds only on the venue's network", async ({ page }) => {
    const calls = await stubMyAddress(page, { body: { ip: "203.0.113.7", range: "public" } });
    await openForm(page);
    await expect(page.locator(BTN), "the button sits beside the field").toHaveText("Use my current address");
    await expect(page.locator("#comp-trusted-ips-help"), "and the help names it").toContainText("Use my current address adds the address the platform sees you at");
    await expect(page.locator(NOTE), "nothing said before it is pressed").toBeHidden();
    await expect(page.locator(NOTE), "a status region already in the page, so the answer written into it is announced")
      .toHaveAttribute("role", "status");

    await page.locator(FIELD).fill("198.51.100.0/24, ");
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toBeVisible();
    await expect(page.locator(FIELD), "appended after what was typed, the dangling comma tidied").toHaveValue("198.51.100.0/24, 203.0.113.7");
    await expect(page.locator(NOTE)).toHaveText("Added 203.0.113.7, the address the platform sees you at now: it is your venue's address only while you are on the venue's network. Save to apply it.");
    await expect(page.locator(NOTE), "a quiet note, not a warning").not.toHaveClass(/is-warn/);
    expect(calls.n, "one read per press").toBe(1);

    // Pressed again: listed already, so nothing changes but the note.
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toHaveText("203.0.113.7, the address the platform sees you at now, is already in the list.");
    await expect(page.locator(FIELD), "never added twice").toHaveValue("198.51.100.0/24, 203.0.113.7");
    expect(calls.n).toBe(2);
    // Listed in another case: still the same address.
    await stubMyAddress(page, { body: { ip: "2001:db8::1", range: "public" } });
    await page.locator(FIELD).fill("2001:DB8::1");
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toHaveText("2001:db8::1, the address the platform sees you at now, is already in the list.");
    await expect(page.locator(FIELD)).toHaveValue("2001:DB8::1");
  });

  test("an empty field takes the address alone, and the saved event stores it", async ({ page }) => {
    await stubMyAddress(page, { body: { ip: "203.0.113.42", range: "public" } });
    await openForm(page);
    const name = `MyAddr save ${Date.now()}`;
    await page.locator("#comp-name").fill(name);
    await page.locator("#comp-date").fill("2032-05-04");
    await page.locator("#comp-time").fill("10:00");
    await page.locator("#comp-tz").fill("UTC");
    await page.locator("#comp-dur-h").fill("2");
    await expect(page.locator(FIELD), "PRECONDITION: a blank field").toHaveValue("");
    await page.locator(BTN).click();
    await expect(page.locator(FIELD), "the address alone, no leading comma").toHaveValue("203.0.113.42");
    await page.locator('[data-action="comp-save"]').first().click();
    const confirm = page.locator("#modal-overlay");
    await expect(confirm).toContainText("Create Competition?", { timeout: 10000 });
    await confirm.locator("button", { hasText: /^Create$/ }).first().click();
    // The column is the truth: what the button added reached the save.
    await expect.poll(() => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return (db.prepare("SELECT trusted_network_ips FROM competitions WHERE name=?").get(name) || {}).trusted_network_ips ?? null; }
      finally { db.close(); }
    }, { timeout: 15000, message: "the event saved with the address the button added" }).toBe("203.0.113.42");
  });

  test("any range but public adds nothing and warns that TRUST_PROXY is probably wrong; a refusal and a failure say so", async ({ page }) => {
    const calls = await stubMyAddress(page, { body: { ip: "10.1.2.3", range: "private" } });
    await openForm(page);
    await page.locator(FIELD).fill("198.51.100.7");
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toHaveText("The platform sees you at 10.1.2.3, a private network address: not a public address, so it is not your venue's and nothing was added. If the platform runs behind a proxy, its TRUST_PROXY setting is probably wrong: tell whoever runs the server.");
    await expect(page.locator(NOTE), "a warning, in the status ink").toHaveClass(/is-warn/);
    await expect(page.locator(FIELD), "nothing added").toHaveValue("198.51.100.7");
    expect(calls.n, "PRECONDITION: the read was made").toBe(1);

    // The warning is legible: axe over the field's group while it shows.
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).include("#comp-trusted-ips-group").analyze();
    const bad = (results.violations || []).filter((v) => AXE_GATED_IMPACTS.has(v.impact));
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), "the field, button and warning pass axe").toEqual([]);

    // A range the form has no words for is still a warning, never an addition.
    await stubMyAddress(page, { body: { ip: "198.18.0.1", range: "benchmarking" } });
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toContainText("The platform sees you at 198.18.0.1, an address it cannot place: not a public address");
    await expect(page.locator(FIELD), "an unknown range adds nothing").toHaveValue("198.51.100.7");

    // No address at all.
    await stubMyAddress(page, { body: { ip: null, range: "unknown" } });
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toHaveText("The platform could not tell which address you are at, so nothing was added.");

    // A refusal says why, in its own words.
    await stubMyAddress(page, { status: 403, body: { error: "Your role does not allow you to edit event settings, tags and sessions. Ask an administrator to change your role.", code: "permission_denied", permission: "events.edit" } });
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toHaveText("Your role does not allow you to edit event settings, tags and sessions. Ask an administrator to change your role.");
    await expect(page.locator(NOTE)).toHaveClass(/is-warn/);

    // A server failure (asked twice: the read retries a 5xx once) gets the plain sentence.
    const failing = await stubMyAddress(page, { status: 500, body: { error: "Internal details nobody should read" } });
    await page.locator(BTN).click();
    await expect(page.locator(NOTE)).toHaveText("Could not read your current address. Try again.");
    expect(failing.n, "the 5xx was retried once").toBe(2);
    await expect(page.locator(FIELD), "still nothing added").toHaveValue("198.51.100.7");
  });

  test("unstubbed, this server sees 127.0.0.1: the loopback answer warns and adds nothing", async ({ page }) => {
    await openForm(page);
    await page.locator(FIELD).fill("");
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/my-address");
    await page.locator(BTN).click();
    const res = await answered;
    expect(res.status(), "the real route answered").toBe(200);
    expect(await res.json()).toEqual({ ip: "127.0.0.1", range: "loopback" });
    await expect(page.locator(NOTE)).toHaveText("The platform sees you at 127.0.0.1, a loopback address: not a public address, so it is not your venue's and nothing was added. If the platform runs behind a proxy, its TRUST_PROXY setting is probably wrong: tell whoever runs the server.");
    await expect(page.locator(FIELD), "a loopback address is never added").toHaveValue("");
  });

  test("the button follows the field: disabled with it for several sessions, its answer withdrawn, and back", async ({ page }) => {
    await stubMyAddress(page, { body: { ip: "203.0.113.9", range: "public" } });
    await openForm(page);
    await page.locator(BTN).click();
    await expect(page.locator(NOTE), "PRECONDITION: an answer is showing").toBeVisible();
    await page.locator('label[for="comp-mode-multi"]').click();
    await expect(page.locator(FIELD), "PRECONDITION: the field is disabled for several sessions").toBeDisabled();
    await expect(page.locator(BTN), "the button goes with it").toBeDisabled();
    await expect(page.locator(NOTE), "and its last answer is withdrawn").toBeHidden();
    await expect(page.locator("#comp-trusted-ips-note"), "the reason is what is read instead").toContainText("single-session events only");
    await page.locator('label[for="comp-mode-single"]').click();
    await expect(page.locator(FIELD)).toBeEnabled();
    await expect(page.locator(BTN), "back with the field").toBeEnabled();
  });

  test("one read at a time, and an answer that lands after the field was disabled changes nothing", async ({ page }) => {
    await openForm(page);
    // Hold the read open until released, counting what is asked.
    let release;
    const held = new Promise((r) => { release = r; });
    let asked = 0;
    await page.route(ROUTE, async (route) => {
      asked++;
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ip: "203.0.113.10", range: "public" }) });
    });
    await expect(page.locator(FIELD), "PRECONDITION: a blank field").toHaveValue("");
    const out = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/admin/my-address");
    await page.locator(BTN).click();
    await out;
    await page.locator(BTN).click();   // pressed again while the first read is out
    await page.locator('label[for="comp-mode-multi"]').click();
    await expect(page.locator(FIELD), "PRECONDITION: the field is disabled before the answer lands").toBeDisabled();
    release();
    // The press has finished once its read has (nothing it does after that waits).
    await expect.poll(() => page.evaluate(() => document.getElementById("comp-trusted-ips")._myAddrBusy),
      { message: "the held read finished" }).toBe(false);
    expect(asked, "a second press while the first read is out asks nothing").toBe(1);
    await expect(page.locator(FIELD), "a late answer writes nothing into a field since disabled").toHaveValue("");
    await expect(page.locator(NOTE), "and says nothing").toBeHidden();
  });
});

test.describe("Use my current address — offered with events.edit", () => {
  let sa, saCsrf, creator, creatorEditor;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    const stamp = Date.now();
    const mk = async (label, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${stamp}`, scope_mode: "all", permissions } });
      expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const role = (await r.json()).role;
      const u = await makeParticipant(sa, saCsrf, `myaddrui${label.replace(/\W/g, "").toLowerCase()}`);
      const g = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: role.id } });
      expect(g.ok(), `assign ${label}: ${g.status()} ${await g.text()}`).toBeTruthy();
      return u;
    };
    creator = await mk("Creator only", ["events.view", "events.create"]);
    creatorEditor = await mk("Creator editor", ["events.view", "events.create", "events.edit"]);
  });
  test.afterAll(async () => { if (sa) await sa.dispose(); });

  async function openAs(page, who) {
    const asked = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/admin/my-address") asked.push(r.method()); });
    await loginViaApi(page, who.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page);
    await openCompCreateForm(page, "tournament");
    await expect(page.locator(FIELD), "PRECONDITION: the create form carries the field").toBeVisible();
    return asked;
  }

  test("a role that may create but not edit events keeps the field without the button; one that may edit gets both", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const asked = await openAs(cp, creatorEditor);
      await expect(cp.locator(BTN), "CONTROL: a role holding events.edit is offered it").toBeVisible();
      await cp.locator(BTN).click();
      await expect(cp.locator(NOTE), "CONTROL: and the route answers it").toContainText("The platform sees you at 127.0.0.1, a loopback address");
      expect(asked, "CONTROL: the read was made").toEqual(["GET"]);
    } finally { await ctx.close(); }

    const asked = await openAs(page, creator);
    await expect(page.locator(BTN), "no button for a role its route refuses").toHaveCount(0);
    await expect(page.locator(NOTE)).toHaveCount(0);
    await expect(page.locator("#comp-trusted-ips-help"), "nor a help sentence naming it").not.toContainText("Use my current address");
    await expect(page.locator(FIELD), "the field itself stays, to be typed").toBeEnabled();
    expect(asked, "the address is never asked for").toEqual([]);
  });
});
