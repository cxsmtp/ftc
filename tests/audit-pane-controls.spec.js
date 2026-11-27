"use strict";

// THE AUDIT PANE'S CONTROLS (public/js/features/audit-admin.js), each by value
// beside a control:
//   - role controls: an event admin gets no Settings chip, no Raw logs switch and
//     no "?" for it (the tip goes with its control); a superadmin gets all three;
//     a custom role over every event without `audit.raw_logs` keeps the chip and
//     gets neither the switch nor its tip;
//   - the Event, Outcome, From and To filters send their parameters and narrow
//     the rows to the one planted row that matches all four;
//   - the pager pages like Raw logs, and a press after a filter change loads the
//     new filter's first page: never the old list's next page under the new
//     filters (rows of two filters mixed);
//   - When sorts in time order (not by digits read out of "Nov 5, 2026, …"), the
//     Actor column as text, and the shared comparator gives one order whatever
//     the input order (no cycles);
//   - the route's limiter (429) is a refusal for now: its sentence comes with
//     Try again, which a refusal of the filters themselves (400) never gets.
// Rows are planted in orphan_events ("Log events"), each run under its own token.

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const { H, buildWorld, makeParticipant, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE, timezoneId: "UTC", locale: "en-US" });

const T = uniq("apc").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
const TOKF = `f911f${T}`;   // the four filters
const TOKL = `f911l${T}`;   // the pager
const TOKW = `f911w${T}`;   // When / Actor sort

function openDb() {
  const Database = require("better-sqlite3");
  return new Database(TEST_DB_PATH);
}
const rid = () => require("crypto").randomUUID();

/** @type {any} */ let w;
let sup, reader;

async function signIn(page, email) {
  const r = await codeLogin(page.request, email);
  expect(r.ok(), `sign in ${email}: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
}
async function openAudit(page) {
  await page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]').evaluate(el => el.click());
  await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 20000 });
  await expect(page.locator("#admin-audit-body tr").first()).toBeVisible({ timeout: 20000 });
}
/** Type a search and wait until the list shows exactly `n` rows of the token. */
async function searchFor(page, tok, n) {
  await page.locator("#audit-search").fill(tok);
  await expect.poll(() => page.locator("#admin-audit-body td.audit-activity").evaluateAll(
    (els, t) => els.length && els.every(e => (e.dataset.eventType || "").startsWith(t)) ? els.length : -1, tok), { timeout: 15000 }).toBe(n);
}
const activity = (page) => page.locator("#admin-audit-body td.audit-activity").evaluateAll(els => els.map(e => e.dataset.eventType));

test.describe("The Audit pane's controls", () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();
    // The browser's superadmin is user-backed, so its sign-in does not end the
    // built-in account's API session the world was built with.
    sup = await makeParticipant(w.sa, w.saCsrf, "auditpanesa");
    const pr = await w.sa.post(`/api/admin/participants/${sup.id}/role`, { headers: H(w.saCsrf), data: { role: "superadmin" } });
    expect(pr.ok(), `promote: ${pr.status()} ${await pr.text()}`).toBeTruthy();
    // A custom role over every event that may read the audit trail but not the
    // raw logs: the switch is decided by the permission, not the tier.
    const rr = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: `Trail reader ${T}`, scope_mode: "all", permissions: ["panel.access", "audit.view", "events.view", "settings.view"] } });
    expect(rr.ok(), `create role: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    reader = await makeParticipant(w.sa, w.saCsrf, "auditpanereader");
    const ar = await w.sa.patch(`/api/admin/users/${reader.id}/role`, { headers: H(w.saCsrf), data: { role: (await rr.json()).role.id } });
    expect(ar.ok(), `assign role: ${ar.status()} ${await ar.text()}`).toBeTruthy();

    const db = openDb();
    try {
      const ins = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      const plant = db.transaction(() => {
        // The four filters: only r1 is in `mine`, a failure, on 10 March 2026.
        ins.run(rid(), "competition", w.mine.id, `${TOKF}_r1_failed`, "superadmin", "2026-03-10T12:00:00.000Z", w.mine.id, null, null);
        ins.run(rid(), "competition", w.mine.id, `${TOKF}_r2_done`, "superadmin", "2026-03-10T13:00:00.000Z", w.mine.id, null, null);
        ins.run(rid(), "competition", w.theirs.id, `${TOKF}_r3_failed`, "superadmin", "2026-03-10T12:30:00.000Z", w.theirs.id, null, null);
        ins.run(rid(), "competition", w.mine.id, `${TOKF}_r4_failed`, "superadmin", "2026-02-01T12:00:00.000Z", w.mine.id, null, null);
        // The pager: 60 newer rows by alice, 5 older rows by bob.
        for (let i = 0; i < 60; i++) ins.run(rid(), "export", "a", `${TOKL}_a`, `alice-${TOKL}@x.example`, new Date(Date.UTC(2026, 3, 1, 12, 0, i)).toISOString(), null, null, null);
        for (let i = 0; i < 5; i++) ins.run(rid(), "export", "b", `${TOKL}_b`, `bob-${TOKL}@x.example`, new Date(Date.UTC(2026, 0, 1, 12, 0, i)).toISOString(), null, null, null);
        // When / Actor: two months, and times whose digits mislead.
        const rows = [
          ["w1", "2026-10-31T23:00:00.000Z", "zed1"], ["w2", "2026-11-05T09:00:00.000Z", "amy2"],
          ["w3", "2026-11-05T10:05:00.000Z", "mia"], ["w4", "2026-11-05T10:50:00.000Z", "bob1"],
          ["w5", "2026-11-05T13:00:00.000Z", "alice2"],
        ];
        for (const [k, at, who] of rows) ins.run(rid(), "export", k, `${TOKW}_${k}`, `${who}-${TOKW}@x.example`, at, null, null, null);
      });
      plant();
    } finally { db.close(); }
  });

  test("an event admin gets no Settings chip, no Raw logs and no tip for it; a superadmin gets all three", async ({ browser }) => {
    test.setTimeout(120_000);
    const ctxA = await browser.newContext({ baseURL: BASE });
    const ctxB = await browser.newContext({ baseURL: BASE });
    try {
      const sa = await ctxA.newPage();
      await signIn(sa, sup.email);
      await openAudit(sa);
      await expect(sa.locator("#audit-view-raw"), "CONTROL: a superadmin has Raw logs").toBeVisible();
      await expect(sa.locator("#audit-view-raw-tip .help-tip-btn"), "…and its ?").toBeVisible();
      await expect(sa.locator('#audit-type-filters [data-type="setting"]'), "…and the Settings chip").toBeVisible();

      const ea = await ctxB.newPage();
      await signIn(ea, w.ea.email);
      await openAudit(ea);
      await expect(ea.locator("#audit-view-trail"), "CONTROL: the event admin's pane is on screen").toBeVisible();
      await expect(ea.locator("#audit-view-raw"), "no Raw logs for an event admin").toBeHidden();
      await expect(ea.locator("#audit-view-raw-tip"), "…and no ? about it").toBeHidden();
      await expect(ea.getByRole("button", { name: "About Raw logs" }), "nothing named for a door they lack").toHaveCount(0);
      await expect(ea.locator('#audit-type-filters [data-type="setting"]'), "no Settings chip").toBeHidden();
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test("a custom role holding the audit trail but not the raw logs gets no Raw logs and no tip for it, and keeps the Settings chip", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, reader.email);
    await openAudit(page);
    await expect(page.locator("#audit-view-trail"), "CONTROL: the role's pane is on screen").toBeVisible();
    await expect(page.locator('#audit-type-filters [data-type="setting"]'), "CONTROL: an unscoped role holding settings.view keeps the Settings chip").toBeVisible();
    await expect(page.locator("#audit-view-raw"), "no Raw logs without audit.raw_logs").toBeHidden();
    await expect(page.locator("#audit-view-raw-tip"), "…and no ? about it").toBeHidden();
    await expect(page.getByRole("button", { name: "About Raw logs" })).toHaveCount(0);
  });

  test("Event, Outcome, From and To send their parameters and narrow to the one matching row", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, sup.email);
    await openAudit(page);
    await searchFor(page, TOKF, 4);
    const sent = [];
    page.on("request", (r) => { if (r.url().includes("/api/admin/audit?")) sent.push(new URL(r.url())); });
    await page.locator("#audit-event").selectOption(w.mine.id);
    await page.locator("#audit-outcome").selectOption("failure");
    await page.locator("#audit-from").fill("2026-03-10");
    await page.locator("#audit-to").fill("2026-03-10");
    await page.locator("#audit-to").dispatchEvent("change");
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual([`${TOKF}_r1_failed`]);
    const last = sent[sent.length - 1];
    expect(last.searchParams.get("competitionId")).toBe(w.mine.id);
    expect(last.searchParams.get("outcome")).toBe("failure");
    expect(last.searchParams.get("from"), "the start of the local day").toBe("2026-03-10T00:00:00.000Z");
    expect(last.searchParams.get("to"), "the end of the local day").toBe("2026-03-10T23:59:59.999Z");
    expect(last.searchParams.get("q")).toBe(TOKF);
    await expect(page.locator("#audit-count")).toHaveText("Showing 1 of 1 record");
  });

  test("the pager pages like Raw logs: Next by cursor, a jump by the first page's anchor, and never a mix of two filters", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, sup.email);
    await openAudit(page);
    const sent = [];
    page.on("request", (r) => { if (r.url().includes("/api/admin/audit?")) sent.push(new URL(r.url())); });
    const lastSent = () => sent[sent.length - 1].searchParams;
    const bar = page.locator("#audit-pagination-bar");
    const btn = (a) => bar.locator(`button[data-action="audit-page-${a}"]`);
    const PAGE1 = Array(50).fill(`${TOKL}_a`);
    const PAGE2 = [...Array(10).fill(`${TOKL}_a`), ...Array(5).fill(`${TOKL}_b`)];   // bob's 5 are the oldest
    await searchFor(page, TOKL, 50);
    await expect(bar.locator(".page-info")).toHaveText("Page 1 of 2 (65 total)");
    await expect(page.locator("#audit-count")).toHaveText("Showing 1–50 of 65 records");
    await expect(btn("prev")).toBeDisabled();
    await expect(page.locator("#audit-page-input"), "an exact count: Go to page is open").toBeEnabled();

    await btn("next").click();
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE2);
    expect(lastSent().get("cursor"), "Next reads below the page it left").toBeTruthy();
    expect(lastSent().get("anchor")).toBeNull();
    await expect(page.locator("#audit-count")).toHaveText("Showing 51–65 of 65 records");
    await expect(bar.locator(".page-info")).toHaveText("Page 2 of 2 (65 total)");
    await expect(btn("next")).toBeDisabled();
    await expect(btn("last")).toBeDisabled();

    await btn("prev").click();
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE1);
    expect(lastSent().get("cursor"), "page 1 is read from the top").toBeNull();
    await btn("last").click();
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE2);
    expect(lastSent().get("anchor"), "Last jumps from the first page's anchor").toBeTruthy();
    expect(lastSent().get("offset")).toBe("50");
    await btn("first").click();
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE1);
    await page.locator("#audit-page-input").fill("9");
    await page.locator("#audit-page-input").press("Enter");
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE2);
    await expect(page.locator("#audit-page-jump-note")).toHaveText("Page 9 does not exist — showing page 2.");
    expect(lastSent().get("offset")).toBe("50");

    // A press after a filter change loads the new filter's first page.
    await btn("first").click();
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE1);
    const actors = () => page.locator("#admin-audit-body td.audit-actor").evaluateAll(els => [...new Set(els.map(e => e.textContent.trim()))]);
    expect(await actors(), "CONTROL: the first page is alice's").toEqual([`alice-${TOKL}@x.example`]);
    // The Actor box's `change` fires as focus leaves it for the button.
    await page.locator("#audit-actor").fill(`bob-${TOKL}@x.example`);
    await btn("next").click();
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(Array(5).fill(`${TOKL}_b`));
    expect(await actors(), "no row of the old filter is left").toEqual([`bob-${TOKL}@x.example`]);
    await expect(page.locator("#audit-count"), "the count belongs to the rows shown").toHaveText("Showing 1–5 of 5 records");
    await expect(btn("next")).toBeDisabled();

    // The page size: Raw logs' choices; a change starts again at page 1.
    await page.locator("#audit-actor").fill("");
    await page.locator("#audit-actor").dispatchEvent("change");
    await expect.poll(() => activity(page), { timeout: 15000 }).toEqual(PAGE1);
    await bar.locator('select[data-change-action="audit-page-size"]').selectOption("100");
    await expect.poll(() => activity(page).then(a => a.length), { timeout: 15000 }).toBe(65);
    await expect(bar.locator(".page-info")).toHaveText("Page 1 of 1 (65 total)");
    expect(await bar.locator('select[data-change-action="audit-page-size"] option').evaluateAll(o => o.map(x => x.value))).toEqual(["50", "100", "200", "500"]);
  });

  test("a 429 from the route's limiter shows its sentence with Try again; a 400 refusal does not offer it", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, sup.email);
    await openAudit(page);
    const AUDIT_API = /\/api\/admin\/audit\?/;
    const fail = page.locator("#admin-audit-body td.load-failed");
    const retry = fail.locator('button[data-action="audit-retry"]');
    const LIMITED = "Too many requests. Please try again later.";   // lib/middleware.js rateLimit's body
    await page.route(AUDIT_API, (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: LIMITED }) }));
    await page.locator("#audit-search").fill(TOKL);
    await expect(fail).toContainText(LIMITED, { timeout: 15000 });
    await expect(retry, "a limiter refusal is for now: Try again").toBeVisible();
    await page.unroute(AUDIT_API);
    await retry.click();
    await expect.poll(() => activity(page).then(a => a.length && a.every(k => k.startsWith(TOKL)) ? a.length : -1), { timeout: 15000 }).toBe(50);

    // CONTROL: a refusal of the filters themselves is not retried as it stands.
    const REFUSED = "`from` and `to` must be dates (ISO 8601).";
    await page.route(AUDIT_API, (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: REFUSED, code: "audit_date_invalid" }) }));
    await page.locator("#audit-search").fill(`${TOKL}_a`);
    await expect(fail).toContainText(REFUSED, { timeout: 15000 });
    await expect(retry, "no Try again for a refusal the same request would get again").toHaveCount(0);
    await page.unroute(AUDIT_API);
  });

  test("When sorts in time order and Actor as text; the comparator gives one order whatever the input order", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, sup.email);
    await openAudit(page);
    await searchFor(page, TOKW, 5);
    const order = async () => (await activity(page)).map(k => k.slice(TOKW.length + 1));
    expect(await order(), "CONTROL: the server's order, newest first").toEqual(["w5", "w4", "w3", "w2", "w1"]);
    const clear = page.locator(".tcol-bar[data-tcols-for='audit'] .tcol-clear");
    await expect(clear, "PRECONDITION: nothing to clear yet").toBeHidden();
    const sortBy = async (col, dir) => {
      await page.locator(`#admin-audit-tab th .tcol-hbtn[data-tcol-menu="${col}"]`).click();
      const pop = page.locator(".tcol-pop[role='dialog']");
      await expect(pop).toBeVisible();
      await pop.locator(`[data-tcol-sort="${dir}"]`).click();
      await pop.locator("[data-tcol-done]").click();
      await expect(pop).toHaveCount(0);
    };
    await sortBy("when", "asc");
    await expect.poll(order, { timeout: 5000 }).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    await sortBy("when", "desc");
    await expect.poll(order, { timeout: 5000, message: "descending is the server's newest-first order again" }).toEqual(["w5", "w4", "w3", "w2", "w1"]);
    await sortBy("actor", "asc");
    await expect.poll(order, { timeout: 5000 }).toEqual(["w5", "w2", "w4", "w3", "w1"]);   // alice2, amy2, bob1, mia, zed1
    // Sweep #311 — the bar's Clear drops the sort, and the rows go back to the
    // order the page drew them in (stamped at the first sort, three sorts ago).
    await expect(clear, "a sort can be cleared").toBeVisible();
    await expect(clear).toHaveText("Clear sort");
    await expect(page.locator(".tcol-bar[data-tcols-for='audit'] .tcol-note")).toContainText("Sorted by Actor on this page");
    await clear.click();
    await expect.poll(order, { timeout: 5000, message: "the server's order again" }).toEqual(["w5", "w4", "w3", "w2", "w1"]);
    await expect(page.locator("#admin-audit-tab th[data-tcol-dsort='actor']")).toHaveAttribute("aria-sort", "none");
    await expect(clear, "nothing left to clear").toBeHidden();
    await expect(page.locator(".tcol-bar[data-tcols-for='audit'] .tcol-note")).toHaveText("");

    const out = await page.evaluate(() => {
      const cmp = window.compareValues;
      const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
      const orders = (vals, asc) => new Set(perms(vals).map(p => JSON.stringify(p.slice().sort((x, y) => cmp(x, y, asc)))));
      return {
        mixed: [...orders(["1,240", "999", "5 apples"], true)],
        mixedDesc: [...orders(["1,240", "999", "5 apples"], false)],
        actors: [...orders(["zed1@x", "amy2@x", "mia@x"], true)],
        dates: [...orders(["Nov 5, 2026, 10:05:00 AM", "Oct 31, 2026, 11:00:00 PM", "Nov 5, 2026, 10:50:00 AM"], true)],
        numeric: ["10", "9", "2", "1,000", "-5", "45%"].sort((x, y) => cmp(x, y, true)),
        text: ["b", "a", "C"].sort((x, y) => cmp(x, y, true)),
        blanksAsc: ["", "a", "—", "b"].sort((x, y) => cmp(x, y, true)),
        blanksDesc: ["", "a", "—", "b"].sort((x, y) => cmp(x, y, false)),
      };
    });
    expect(out.mixed.length, "one order for every permutation (no cycle)").toBe(1);
    expect(out.mixedDesc.length).toBe(1);
    expect(out.actors.length).toBe(1);
    expect(out.dates.length).toBe(1);
    // Anti-vacuity: the comparator really orders (a constant 0 is also permutation-invariant).
    expect(out.numeric, "whole numbers numerically, not as text").toEqual(["-5", "2", "9", "10", "45%", "1,000"]);
    expect(out.text).toEqual(["a", "b", "C"]);
    expect(JSON.parse(out.actors[0]), "an address is text, not the digit inside it").toEqual(["amy2@x", "mia@x", "zed1@x"]);
    expect(out.blanksAsc.slice(-2).sort(), "blanks last ascending").toEqual(["", "—"]);
    expect(out.blanksDesc.slice(-2).sort(), "…and descending").toEqual(["", "—"]);
  });
});
