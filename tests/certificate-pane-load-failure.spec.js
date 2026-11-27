// @ts-check
//
// AN EVENT'S CERTIFICATES SECTION SAYS WHEN A READ FAILED, AND TRY AGAIN WORKS.
//
// The workspace's Certificates section draws two cards from two reads
// (public/js/features/certificate-wizard.js): the issued list
// (GET /api/admin/competitions/:id/certificates) and the design
// (GET /api/admin/competitions/:id/certificate-config). Each has its own failure
// branch: "Could not load …" with a Try again button. What this file holds, per
// read, with the read failed once by a 500 and once by an aborted request (no
// response at all):
//   • the failure is said IN THAT CARD, as an alert, with Try again — never the
//     list's empty state ("None yet", "0 certificates"), a half-drawn designer,
//     the server's data, or the loading line left standing;
//   • the OTHER card is drawn whole from its own read (CONTROL: the route fails
//     exactly one read, and the section is neither blank nor all-failed);
//   • Try again sends the read again (counted at the network, each failure drawn
//     afresh, never the earlier node left standing), and once the read answers
//     the card is drawn from the server's answer, by value: the event's own
//     design (its title) and the one issued certificate (its holder's name).
// The 500 alone, as rows of the table every pane joins, is in
// tests/load-failure-states.spec.js.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const STAMP = Date.now().toString(36);
const TITLE = `PANE PROBE ${STAMP}`.toUpperCase();
const BOOM = { status: 500, contentType: "application/json", body: JSON.stringify({ error: "Boom" }) };

// ONE read-only world: a live PROGRAM with its own design (a distinctive title,
// the congratulations email off) and one issued completion certificate,
// collected by its holder. A Program, because it is UNRANKED: opening a ranked
// event also runs the Rankings loader, whose top-three card reads the same
// issued list (rankings-admin.js `_rkRefreshIssued`), and a read the section did
// not send would be counted as one it did. Nothing below writes to the world.
let EV, HOLDER_NAME;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const sa = await apiLogin("superadmin");
  const sessions = [];
  try {
    const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
      name: `Cert pane ${STAMP}`, event_kind: "program", timezone: "UTC",
      start_time: new Date(Date.now() - 600_000).toISOString(),
      deadline_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    } });
    expect(r.status(), await r.text()).toBe(200);
    EV = (await r.json()).competition;
    expect(EV.policy && EV.policy.ranking_enabled, "PRECONDITION: an unranked kind").toBe(false);
    const t = await makeTask(sa.api, sa.csrf, "certpane", { correct_answer: "right" });
    await assignTask(sa.api, sa.csrf, t.id, [EV.id]);
    const p = await makeParticipant(sa.api, sa.csrf, "certpaneholder");
    await enrol(sa.api, sa.csrf, EV.id, [p.id]);
    const put = await sa.api.put(`/api/admin/competitions/${EV.id}/certificate-config`, { headers: H(sa.csrf),
      data: { config: { email: { enabled: false }, text: { title: TITLE } } } });
    expect(put.status(), `the event's own design: ${await put.text()}`).toBe(200);
    // Solving the Program's one challenge completes it (a Program's all-solved
    // end is seeded off, so the event stays live), and the holder collects the
    // completion certificate.
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    sessions.push(s);
    expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: EV.id } })).ok()).toBeTruthy();
    const sub = await s.api.post(`/api/tasks/${t.id}/submit`, { headers: H(s.csrf), data: { answer: "right", gradingHash: await gradingHashFor(s.api, t.id) } });
    expect(sub.ok(), await sub.text()).toBeTruthy();
    const mint = await s.api.post(`/api/competitions/${EV.id}/badge`, { headers: H(s.csrf), data: {} });
    expect(mint.ok(), `the holder collects their certificate: ${await mint.text()}`).toBeTruthy();
    // PRECONDITIONS, from the server itself: one certificate, and the event's
    // own design with the probe title.
    const list = await (await sa.api.get(`/api/admin/competitions/${EV.id}/certificates`)).json();
    expect(list.certificates.length, "PRECONDITION: exactly one certificate is issued").toBe(1);
    expect(list.certificates[0].tier, "PRECONDITION: a completion certificate").toBe("completion");
    HOLDER_NAME = list.certificates[0].name;
    expect(HOLDER_NAME, "PRECONDITION: the holder has a printed name").toBeTruthy();
    const cfg = await (await sa.api.get(`/api/admin/competitions/${EV.id}/certificate-config`)).json();
    expect(cfg.overridden, "PRECONDITION: the event has its own design").toBe(true);
    expect(cfg.effective.text.title).toBe(TITLE);
  } finally {
    for (const x of sessions) await x.api.dispose();
    await sa.api.dispose();
  }
});

/**
 * Fail ONE read of this event by plan ("500" | "abort"), then let it through.
 * A URL predicate, not a glob: the Overview's summary read of the same list
 * (`?summary=1`) is another read and must never be caught. Returns the count of
 * GETs the route saw.
 */
async function planRead(page, pathname, plan) {
  const seen = { n: 0 };
  await page.route((u) => u.pathname === pathname && !u.search, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    seen.n++;
    const step = plan.shift();
    if (step === "500") return route.fulfill(BOOM);
    if (step === "abort") return route.abort();
    return route.continue();
  });
  return seen;
}

async function openCerts(page) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), EV.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-event-certs-tab" }), { id: EV.id, n: EV.name });
  await expect(page.locator("#ws-certs")).toBeVisible({ timeout: 15000 });
}

/**
 * Everything the card holds as data: every text node in it, shown or hidden,
 * and every form control's value. The card's innerText sees neither a
 * control's value nor a subtree drawn `hidden`, and the designer holds the
 * title exactly so: as the value of an <input> in its Wording panel, which is
 * drawn closed.
 */
const cardHolds = (card) => card.evaluate((el) => ({
  text: el.textContent || "",
  values: [...el.querySelectorAll("input, textarea, select")].map((c) => String(c.value || "")),
}));

/**
 * The card states the failure, and only the failure: the alert with Try again;
 * no empty-state claim and no loading line left up, as the card reads on
 * screen; and nothing of the server's data anywhere in it (`cardHolds`). A
 * node the failure before carried (marked `__earlier` before Try again) must
 * be gone: each failure is drawn afresh.
 */
async function expectFailureIn(card, { says, notShown, falseClaims }) {
  const alert = card.locator('.load-failure[role="alert"]');
  await expect(alert).toBeVisible({ timeout: 15000 });
  await expect(alert).toContainText(says);
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(await alert.evaluate((el) => !!el.__earlier), "a fresh failure node, not the earlier one left standing").toBe(false);
  const text = await card.innerText();
  expect(text, "the loading line is gone").not.toMatch(/Loading/);
  for (const re of falseClaims) expect(text, `no empty-state claim for a failed read: ${re}`).not.toMatch(re);
  const held = await cardHolds(card);
  for (const v of notShown) {
    expect(held.text, `nothing of the server's data is in the card's text, shown or hidden: ${v}`).not.toContain(v);
    expect(held.values.filter((x) => x.includes(v)), `no form control in the card holds the server's data as its value: ${v}`).toEqual([]);
  }
}

test("the design read failing (a 500, then an aborted request) says so in the design card; Try again reads it again and draws the event's own design", async ({ page }) => {
  await adminLogin(page);
  const seen = await planRead(page, `/api/admin/competitions/${EV.id}/certificate-config`, ["500", "abort"]);
  await openCerts(page);
  const design = page.locator("#ws-certs-design");
  const issued = page.locator("#ws-certs-issued");
  const fail = { says: "Could not load the certificate design.", notShown: [TITLE], falseClaims: [/uses the platform design/i, /own certificate design/i] };

  // A 500: the alert in the design card, and no designer at all.
  await expectFailureIn(design, fail);
  await expect(design.locator(".cw"), "no half-drawn designer").toHaveCount(0);
  await expect(design.locator("[data-cw]"), "no design buttons").toHaveCount(0);
  // CONTROL: the issued list read its own answer and is drawn whole.
  await expect(issued.locator(".ic-title")).toHaveText("1 certificate", { timeout: 15000 });
  await expect(issued.locator("td.ic-lead b")).toHaveText(HOLDER_NAME);
  await expect(issued.locator(".load-failure"), "CONTROL: only the failed read's card admits a failure").toHaveCount(0);
  expect(seen.n, "one read so far").toBe(1);

  // Try again → the read is sent again and aborted (no response at all).
  await design.locator(".load-failure").evaluate((el) => { el.__earlier = true; });
  await design.locator("[data-cw-retry]").click();
  await expect.poll(() => seen.n, { message: "Try again sends the read again" }).toBe(2);
  await expectFailureIn(design, fail);
  await expect(design.locator(".cw")).toHaveCount(0);

  // Try again → the read goes through: the designer, drawn from the server's
  // answer (this event's own design, by its title).
  await design.locator(".load-failure").evaluate((el) => { el.__earlier = true; });
  await design.locator("[data-cw-retry]").click();
  await expect.poll(() => seen.n, { message: "Try again sends the read again" }).toBe(3);
  await expect(design.locator(".cw")).toBeVisible({ timeout: 15000 });
  await expect(design.locator("#cw-scope")).toHaveText("This event has its own certificate design.");
  // CONTROL for the failure probe: on the drawn designer, before its Wording
  // panel is opened, `cardHolds` finds the title in a form control's value, so
  // the failure arm "no form control holds it" is not blind to it.
  expect((await cardHolds(design)).values.some((x) => x.includes(TITLE)), "CONTROL: the probe sees the title the designer holds").toBe(true);
  await design.locator('[data-cw-panel="text"]').click();
  await expect(design.locator("#cw-t-title"), "the server's design, by value").toHaveValue(TITLE);
  await expect(design.locator(".load-failure"), "the failure is gone once the read answers").toHaveCount(0);
  await expect(design.locator('[data-cw="save"]'), "the superadmin may change the design").toBeVisible();
});

test("the issued list's read failing (an aborted request, then a 500) says so in the list's card; Try again reads it again and lists the holder", async ({ page }) => {
  await adminLogin(page);
  const seen = await planRead(page, `/api/admin/competitions/${EV.id}/certificates`, ["abort", "500"]);
  await openCerts(page);
  const design = page.locator("#ws-certs-design");
  const issued = page.locator("#ws-certs-issued");
  const fail = { says: "Could not load the issued certificates.", notShown: [HOLDER_NAME], falseClaims: [/None yet/i, /\b0 certificates\b/i, /Certificate emails are off/i] };

  // An aborted request: the alert in the list's card, and no list.
  await expectFailureIn(issued, fail);
  await expect(issued.locator(".ic-head, table"), "no half-drawn list").toHaveCount(0);
  // CONTROL: the design read its own answer and is drawn whole.
  await expect(design.locator("#cw-scope")).toHaveText("This event has its own certificate design.", { timeout: 15000 });
  await expect(design.locator(".load-failure"), "CONTROL: only the failed read's card admits a failure").toHaveCount(0);
  expect(seen.n, "one read so far").toBe(1);

  // Try again → a 500.
  await issued.locator(".load-failure").evaluate((el) => { el.__earlier = true; });
  await issued.locator("[data-ic-retry]").click();
  await expect.poll(() => seen.n, { message: "Try again sends the read again" }).toBe(2);
  await expectFailureIn(issued, fail);
  await expect(issued.locator(".ic-head, table")).toHaveCount(0);

  // Try again → the read goes through: the list the server sent, by value.
  await issued.locator(".load-failure").evaluate((el) => { el.__earlier = true; });
  await issued.locator("[data-ic-retry]").click();
  await expect.poll(() => seen.n, { message: "Try again sends the read again" }).toBe(3);
  await expect(issued.locator(".ic-title")).toHaveText("1 certificate", { timeout: 15000 });
  await expect(issued.locator("td.ic-lead b"), "the holder the server listed").toHaveText(HOLDER_NAME);
  expect((await cardHolds(issued)).text, "CONTROL: the failure probe sees the holder the list draws").toContain(HOLDER_NAME);
  await expect(issued.locator(".ic-note")).toContainText("Certificate emails are off");
  await expect(issued.locator(".load-failure"), "the failure is gone once the read answers").toHaveCount(0);
});
