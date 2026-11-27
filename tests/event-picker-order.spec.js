// @ts-check
"use strict";

// THE ORDER OF EVERY ADMIN EVENT PICKER (operator ruling, 24 Nov 2026).
//
// `compareCompsForPicker` (public/js/features/competitions-admin.js) orders every
// list that asks "which event?": live first, then upcoming by SOONEST start, then
// ended by LATEST start, then name and id, a total order. Before the ruling every
// event after the live ones went by start ascending, so a picker listing ended
// events (Users & roles' Events dialog, the Audit event filter, Grant attempts)
// put the oldest finished event above the next upcoming one, and the Analytics
// picker kept an order of its own (each band by start, latest first).
//
// 1. THE COMPARATOR, run in the page (the module is browser-only). Every
//    permutation of a fixture holding live, upcoming and ended events, with ties
//    on start and on name, sorts to ONE order, and that order is the ruling's.
//    Permutation-invariance alone is satisfied by any total order, so the
//    placement checks say WHICH order, and two controls prove both checks can
//    fail: a comparator answering 0 gives many orders (stable sort keeps each
//    input as it came), and the previous rule, made total, gives one order that
//    the placement checks reject.
//
// 2. EVERY PICKER, in the browser, over six events this file owns: live, two
//    upcoming, one ended that takes late entries (a Booth Event) and two plain
//    ended ones. Their names sort in exactly the reverse of the expected order,
//    and they are created and assigned in scrambled orders, so no incidental
//    order (the server's start DESC, a name sort, creation or assignment order,
//    the previous comparator, Analytics' previous order) passes. Pickers that
//    list ended events show them last, newest first; the ones taking new members
//    show the late-entry event after the upcoming ones (late entry is a display
//    category, never a status); the ones that leave ended events out show the
//    rest live, then soonest.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, expectSpaBooted, openAnalyticsTab } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const HOUR = 3600e3, DAY = 864e5;
const BAND = ["live", "upcoming", "ended"];

// ── 1. The comparator ────────────────────────────────────────────────────────

/**
 * Eight events: 8! = 40320 orderings, the whole search space. `meta` is what each
 * row IS (its band and EFFECTIVE start offset), for the placement checks; the
 * comparator never sees it.
 *
 *   live:     Lima (-2h) and Kilo (-1h): start decides, against name order.
 *   upcoming: Delta and Charlie TIE on start (+1h): name decides, Charlie first,
 *             though Delta's id sorts first; Alpha (+3d) comes after both,
 *             though its name sorts first.
 *   ended:    two "Bravo"s TIE on start (-1d) AND name: only the id separates
 *             them; "Able" is a multi-session event whose own row says it began
 *             an hour ago, but its first session began 12 days ago, so it is the
 *             OLDEST ended event and comes last, though its name sorts first.
 */
function comparatorFixture(now) {
  const iso = (off) => new Date(now + off).toISOString();
  const ev = (id, name, status, off, extra = {}) => ({ id, name, status, start_time: iso(off), duration_minutes: 60, ...extra });
  const rows = [
    ev("l-1", "Lima", "live", -2 * HOUR, { duration_minutes: 600 }),
    ev("l-2", "Kilo", "live", -1 * HOUR, { duration_minutes: 600 }),
    ev("u-a", "Delta", "upcoming", 1 * HOUR),
    ev("u-b", "Charlie", "upcoming", 1 * HOUR),
    ev("u-c", "Alpha", "upcoming", 3 * DAY),
    ev("e-y", "Bravo", "ended", -1 * DAY),
    ev("e-x", "Bravo", "ended", -1 * DAY),
    ev("e-z", "Able", "ended", -1 * HOUR, {
      timeslots: [
        { id: "s-1", name: "Morning", start_time: iso(-12 * DAY), duration_minutes: 60, status: "ended" },
        { id: "s-2", name: "Afternoon", start_time: iso(-11 * DAY), duration_minutes: 60, status: "ended" },
      ],
    }),
  ];
  const meta = {
    "l-1": { band: 0, start: -2 * HOUR, name: "Lima" },
    "l-2": { band: 0, start: -1 * HOUR, name: "Kilo" },
    "u-a": { band: 1, start: 1 * HOUR, name: "Delta" },
    "u-b": { band: 1, start: 1 * HOUR, name: "Charlie" },
    "u-c": { band: 1, start: 3 * DAY, name: "Alpha" },
    "e-y": { band: 2, start: -1 * DAY, name: "Bravo" },
    "e-x": { band: 2, start: -1 * DAY, name: "Bravo" },
    "e-z": { band: 2, start: -12 * DAY, name: "Able" },
  };
  return { rows, meta };
}

/**
 * What is wrong with an order, judged against the ruling: bands live, upcoming,
 * ended; upcoming (and live) by soonest start; ended by LATEST start; a start tie
 * by name. Empty means the order is the ruling's. (An id tie is left to the
 * invariance check: the ruling fixes only that it is total.)
 */
function placementProblems(ids, meta) {
  const out = [];
  for (let i = 1; i < ids.length; i++) {
    const p = meta[ids[i - 1]], q = meta[ids[i]];
    if (p.band > q.band) out.push(`${ids[i]} (${BAND[q.band]}) comes after ${ids[i - 1]} (${BAND[p.band]})`);
    else if (p.band === q.band && p.start !== q.start) {
      const wrong = p.band === 2 ? p.start < q.start : p.start > q.start;
      if (wrong) out.push(`${BAND[p.band]}: ${ids[i - 1]} before ${ids[i]} is not ${p.band === 2 ? "latest" : "soonest"} start first`);
    } else if (p.band === q.band && p.name.localeCompare(q.name) > 0) {
      out.push(`start tie: ${ids[i - 1]} (${p.name}) before ${ids[i]} (${q.name}) is not name order`);
    }
  }
  return out;
}

/** Every ordering of `xs` (Heap's algorithm), each sorted by `cmp`; the distinct results. */
function ordersOf(xs, cmp) {
  const a = xs.slice(), c = new Array(a.length).fill(0), seen = new Set();
  let n = 0;
  const visit = () => { n++; seen.add(a.slice().sort(cmp).map((r) => r.id).join(">")); };
  visit();
  for (let i = 0; i < a.length;) {
    if (c[i] < i) { const j = i % 2 === 0 ? 0 : c[i]; [a[j], a[i]] = [a[i], a[j]]; visit(); c[i]++; i = 0; } else { c[i] = 0; i++; }
  }
  return { permutations: n, orders: [...seen] };
}

test.describe("compareCompsForPicker: one total order, the ruling's", () => {
  test("every permutation of live, upcoming and ended events (ties included) sorts to ONE order: live, upcoming soonest first, ended latest first", async ({ page }) => {
    const { rows, meta } = comparatorFixture(Date.now());
    await page.goto("/");
    await expectSpaBooted(page, "the sign-in page");
    // The same Heap's-algorithm walk as `ordersOf`, in the page, over the APP's
    // comparator (a function cannot cross into the page, so the walk is inlined).
    const res = await page.evaluate((input) => {
      const cmp = /** @type {any} */ (window).compareCompsForPicker;
      if (typeof cmp !== "function") return { error: `window.compareCompsForPicker is ${typeof cmp}` };
      const a = input.slice(), c = new Array(a.length).fill(0), seen = new Set();
      let n = 0;
      const visit = () => { n++; seen.add(a.slice().sort(cmp).map((r) => r.id).join(">")); };
      visit();
      for (let i = 0; i < a.length;) {
        if (c[i] < i) { const j = i % 2 === 0 ? 0 : c[i]; [a[j], a[i]] = [a[i], a[j]]; visit(); c[i]++; i = 0; } else { c[i] = 0; i++; }
      }
      return { permutations: n, orders: [...seen] };
    }, rows);
    expect(res.error, "PRECONDITION: boot exposes the app's comparator").toBeUndefined();
    expect(res.permutations, "PRECONDITION: every ordering of the eight events was sorted").toBe(40320);
    expect(res.orders, `one order however the rows arrive; got ${res.orders.length}: ${res.orders.slice(0, 4).join(" | ")}`).toHaveLength(1);
    const order = res.orders[0].split(">");
    expect(order.slice().sort(), "every event is listed once").toEqual(rows.map((r) => r.id).sort());
    expect(placementProblems(order, meta), `the order ${order.join(" > ")} breaks the ruling`).toEqual([]);
    // The readable statement of the same facts, for whoever reads a failure.
    const at = (id) => order.indexOf(id);
    expect(Math.max(at("u-a"), at("u-b"), at("u-c")), "every upcoming event comes before every ended one")
      .toBeLessThan(Math.min(at("e-x"), at("e-y"), at("e-z")));
    expect(at("e-z"), "the oldest ended event (by its first session) comes last").toBe(order.length - 1);
    expect(at("u-b"), "a start tie is broken by name: Charlie before Delta").toBeLessThan(at("u-a"));
  });

  test("control: a comparator answering 0 is NOT permutation-invariant, so the one-order check can fail", () => {
    const { rows } = comparatorFixture(Date.now());
    const res = ordersOf(rows, () => 0);
    expect(res.permutations).toBe(40320);
    // Array#sort is stable: each ordering comes back as it went in.
    expect(res.orders.length, "a do-nothing comparator gives one order per permutation").toBe(40320);
  });

  test("control: the previous rule (live first, then start ascending), made total, gives one order the placement checks reject", () => {
    const { rows, meta } = comparatorFixture(Date.now());
    const byNameThenId = (a, b) => meta[a.id].name.localeCompare(meta[b.id].name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const previous = (a, b) => {
      const la = meta[a.id].band === 0 ? 0 : 1, lb = meta[b.id].band === 0 ? 0 : 1;
      return la - lb || meta[a.id].start - meta[b.id].start || byNameThenId(a, b);
    };
    const res = ordersOf(rows, previous);
    expect(res.orders, "PRECONDITION: the control is itself a total order").toHaveLength(1);
    const problems = placementProblems(res.orders[0].split(">"), meta);
    expect(problems.some((p) => /\(upcoming\) comes after .* \(ended\)/.test(p)),
      `the previous rule put an ended event above an upcoming one, and the check says so: ${JSON.stringify(problems)}`).toBe(true);
    // Analytics' previous order: each band by start, latest first.
    const analytics = (a, b) => meta[a.id].band - meta[b.id].band || meta[b.id].start - meta[a.id].start || byNameThenId(a, b);
    const ap = placementProblems(ordersOf(rows, analytics).orders[0].split(">"), meta);
    expect(ap.some((p) => p.startsWith("upcoming:")),
      `Analytics' previous order listed the later upcoming event first, and the check says so: ${JSON.stringify(ap)}`).toBe(true);
  });
});

// ── 2. Every picker ──────────────────────────────────────────────────────────

const ALL = ["live", "soon", "later", "late", "recent", "old"];
const TAKERS = ["live", "soon", "later", "late"];
const NOT_ENDED = ["live", "soon", "later"];

test.describe("every admin event picker lists events in the shared order", () => {
  /** @type {Record<string, {id: string, name: string}>} */
  const EV = {};
  /** @type {{id: string, title: string}} */ let TASK;
  /** @type {{id: string, email: string}} */ let ORGANISER;
  /** @type {{id: string, email: string}} */ let PERSON;
  /** @type {{id: string, name: string}} */ let GROUP;

  /** The keys of this file's events, in the order shown; every other event dropped. */
  const keysOf = (ids) => ids.map((id) => Object.keys(EV).find((k) => EV[k].id === id)).filter(Boolean);

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    try {
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      const stamp = now.toString(36);
      // Names in the REVERSE of the expected order, so a name sort fails.
      const spec = {
        live: ["F live", { start_time: iso(now - HOUR), duration_minutes: 600 }],
        soon: ["E soon", { start_time: iso(now + 2 * HOUR), duration_minutes: 120 }],
        later: ["D later", { start_time: iso(now + 3 * DAY), duration_minutes: 120 }],
        // Built live so it can hold the challenge, then ended with End Now: a Booth
        // Event's late-entry window opens at its end.
        late: ["C late", { event_kind: "booth", start_time: iso(now - 3 * HOUR), duration_minutes: 600, late_entry_enabled: true }],
        recent: ["B recent", { start_time: iso(now - 2 * DAY), duration_minutes: 10 * 24 * 60 }],
        old: ["A old", { start_time: iso(now - 10 * DAY), duration_minutes: 20 * 24 * 60 }],
      };
      // Created in a scrambled order, so creation order (a task's events come back
      // in it) is not the expected order either.
      for (const key of ["old", "later", "live", "recent", "soon", "late"]) {
        const [label, data] = spec[key];
        const name = `PickOrder ${stamp} ${label}`;
        const r = await s.api.post("/api/admin/competitions", { headers: H(s.csrf), data: { name, timezone: "UTC", ...data } });
        expect(r.ok(), `create ${key}: ${r.status()} ${await r.text()}`).toBeTruthy();
        EV[key] = { id: (await r.json()).competition.id, name };
      }
      // A capped challenge every event holds (Grant attempts lists the capped
      // events that hold it, ended ones included), assigned in another order.
      TASK = await makeTask(s.api, s.csrf, "pickorder", { attempt_cap: 3 });
      await assignTask(s.api, s.csrf, TASK.id, ["recent", "live", "late", "old", "soon", "later"].map((k) => EV[k].id));
      for (const key of ["late", "recent", "old"]) {
        const r = await s.api.post(`/api/admin/competitions/${EV[key].id}/end-now`, { headers: H(s.csrf), data: {} });
        expect(r.ok(), `end ${key}: ${r.status()} ${await r.text()}`).toBeTruthy();
      }
      // Preconditions, by value.
      const list = await (await s.api.get("/api/admin/competitions")).json();
      const row = (key) => list.find((c) => c.id === EV[key].id);
      for (const [key, status] of [["live", "live"], ["soon", "upcoming"], ["later", "upcoming"], ["late", "ended"], ["recent", "ended"], ["old", "ended"]]) {
        expect(row(key) && row(key).status, `PRECONDITION: ${key} is ${status}`).toBe(status);
      }
      expect(row("late").late_entry_window_open, "PRECONDITION: the Booth Event takes late entries").toBe(true);
      expect(!!row("recent").late_entry_window_open || !!row("old").late_entry_window_open, "PRECONDITION: the other ended events take none").toBe(false);
      // An organiser, so Users & roles lists somebody with an Events button.
      ORGANISER = await makeParticipant(s.api, s.csrf, "pickorder-org");
      await grantEventAdmin(s.api, s.csrf, EV.live.id, ORGANISER.id);
      // Somebody to select for People's "Add to events", and a group to bind.
      PERSON = await makeParticipant(s.api, s.csrf, "pickorder-person");
      const gName = `PickOrder ${stamp} group`;
      const g = await s.api.post("/api/admin/groups", { headers: H(s.csrf), data: { name: gName } });
      expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
      GROUP = { id: (await g.json()).group.id, name: gName };
    } finally { await s.api.dispose(); }
  });

  test("Users & roles' Events dialog lists ended events last, the latest first", async ({ page }) => {
    await adminLogin(page);
    const item = page.locator('button.admin-nav-item[data-tab-id="admin-users-tab"]');
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.locator("#ua-body .ua-switch")).toBeVisible({ timeout: 15000 });
    await page.locator("#ua-users-list tr", { hasText: ORGANISER.email }).locator('[data-action="ua-events"]').click();
    const boxes = page.locator("#ua-events .ua-ev-list input[type=checkbox]");
    await expect.poll(async () => keysOf(await boxes.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: the dialog lists all six events", timeout: 15000 }).toBe(6);
    expect(keysOf(await boxes.evaluateAll((els) => els.map((e) => e.value))),
      "live, then upcoming by soonest start, then ended (the late-entry one too) by latest start").toEqual(ALL);
  });

  test("the Audit event filter lists ended events last, the latest first", async ({ page }) => {
    await adminLogin(page);
    await page.evaluate(() => /** @type {any} */ (window).adminTab(null, "admin-audit-tab"));
    const opts = page.locator("#audit-event option");
    await expect.poll(async () => keysOf(await opts.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: the filter lists all six events", timeout: 15000 }).toBe(6);
    expect(keysOf(await opts.evaluateAll((els) => els.map((e) => e.value))),
      "live, then upcoming by soonest start, then ended by latest start").toEqual(ALL);
  });

  test("the Analytics event picker uses the shared order (upcoming soonest first)", async ({ page }) => {
    await adminLogin(page);
    await openAnalyticsTab(page);
    await page.locator('#analytics-filterbar [data-action="analytics-set-scope"][data-value="competition"]').click();
    await page.locator('#analytics-filterbar [data-action="analytics-open-comp-picker"]').click();
    const cards = page.locator("#analytics-picker-overlay .picker-card[data-comp-id]");
    await expect.poll(async () => keysOf(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-comp-id")))).length,
      { message: "PRECONDITION: the picker lists all six events", timeout: 15000 }).toBe(6);
    expect(keysOf(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-comp-id")))),
      "live, then upcoming by soonest start, then ended by latest start").toEqual(ALL);
  });

  test("a challenge's Grant attempts, Assign to Events and bulk Assign list events in the shared order", async ({ page }) => {
    await adminLogin(page);
    await page.locator('.admin-nav-item[data-tab-id="admin-tasks-tab"]').click();
    await expect.poll(() => page.evaluate((id) => (/** @type {any} */ (window).S.adminTasksData || []).some((t) => t.id === id), TASK.id),
      { message: "PRECONDITION: the challenges model holds the fixture challenge", timeout: 15000 }).toBe(true);

    // Grant attempts lists every capped event holding the challenge, ended ones too.
    await page.evaluate((id) => /** @type {any} */ (window).openAttemptGrant(id), TASK.id);
    const grant = page.locator("#attempt-grant-overlay #ag-comp option");
    await expect.poll(async () => keysOf(await grant.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: Grant attempts lists all six events", timeout: 15000 }).toBe(6);
    expect(keysOf(await grant.evaluateAll((els) => els.map((e) => e.value))),
      "Grant attempts: live, then upcoming by soonest start, then ended by latest start").toEqual(ALL);
    await page.keyboard.press("Escape");
    await expect(page.locator("#attempt-grant-overlay")).toHaveCount(0);

    // Assign to Events leaves every ended event out (the late-entry one too).
    await page.evaluate((id) => /** @type {any} */ (window).openAssignTaskToComps(id), TASK.id);
    const assign = page.locator("#assign-task-overlay #assign-task-comp-list input[type=checkbox]");
    await expect.poll(async () => keysOf(await assign.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: Assign to Events lists the three events that have not ended", timeout: 15000 }).toBe(3);
    expect(keysOf(await assign.evaluateAll((els) => els.map((e) => e.value))),
      "Assign to Events: live, then upcoming by soonest start; no ended event").toEqual(NOT_ENDED);
    await page.keyboard.press("Escape");
    await expect(page.locator("#assign-task-overlay")).toHaveCount(0);

    // The selection bar's bulk Assign does the same.
    await page.evaluate((id) => { /** @type {any} */ (window).S.selectedChallenges.add(id); return /** @type {any} */ (window).openBulkAssignChallengesModal(); }, TASK.id);
    const bulk = page.locator("#challenge-bulk-assign-overlay #challenge-bulk-comp-list .picker-row-check");
    await expect.poll(async () => keysOf(await bulk.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: bulk Assign lists the three events that have not ended", timeout: 15000 }).toBe(3);
    expect(keysOf(await bulk.evaluateAll((els) => els.map((e) => e.value))),
      "bulk Assign: live, then upcoming by soonest start; no ended event").toEqual(NOT_ENDED);
  });

  test("Invite, Add to events and a group's Events list an event taking late entries after the upcoming ones", async ({ page }) => {
    await adminLogin(page);
    // A superadmin's Invite dialog reads the loaded events model.
    const ids = Object.values(EV).map((e) => e.id);
    await expect.poll(() => page.evaluate((want) => want.every((id) => (/** @type {any} */ (window).S.adminCompetitionsData || []).some((c) => c.id === id)), ids),
      { message: "PRECONDITION: the events model holds the fixture events", timeout: 15000 }).toBe(true);

    await page.evaluate(() => /** @type {any} */ (window).openInviteDialog());
    const invite = page.locator("#invite-overlay .invite-comp-cb");
    await expect.poll(async () => keysOf(await invite.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: Invite lists the four events that take new members", timeout: 15000 }).toBe(4);
    expect(keysOf(await invite.evaluateAll((els) => els.map((e) => e.value))),
      "Invite: live, then upcoming by soonest start, then the event taking late entries").toEqual(TAKERS);
    await page.keyboard.press("Escape");
    await expect(page.locator("#invite-overlay")).toHaveCount(0);

    await page.evaluate((id) => { /** @type {any} */ (window).S.selectedParticipants.add(id); return /** @type {any} */ (window).openBulkAssignModal(); }, PERSON.id);
    const add = page.locator("#bulk-assign-overlay #bulk-comp-list .picker-row-check");
    await expect.poll(async () => keysOf(await add.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: Add to events lists the four events that take new members", timeout: 15000 }).toBe(4);
    expect(keysOf(await add.evaluateAll((els) => els.map((e) => e.value))),
      "Add to events: live, then upcoming by soonest start, then the event taking late entries").toEqual(TAKERS);
    await page.keyboard.press("Escape");
    await expect(page.locator("#bulk-assign-overlay")).toHaveCount(0);

    // The group's Events dialog: the server lists these by NAME, which here is the
    // exact reverse of the expected order.
    await page.evaluate(([id, name]) => /** @type {any} */ (window).manageGroupCompetitions(id, name), [GROUP.id, GROUP.name]);
    const bind = page.locator("#gc-list .gc-cb");
    await expect.poll(async () => keysOf(await bind.evaluateAll((els) => els.map((e) => e.value))).length,
      { message: "PRECONDITION: the group's Events lists the four events that take new members", timeout: 15000 }).toBe(4);
    expect(keysOf(await bind.evaluateAll((els) => els.map((e) => e.value))),
      "a group's Events: live, then upcoming by soonest start, then the event taking late entries").toEqual(TAKERS);
  });
});
