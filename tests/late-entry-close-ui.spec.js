// @ts-check
//
// v8.12.8 — "CLOSE LATE ENTRIES NOW", THE CLIENT HALF.
//
// The server half (late-entry-close.api.spec.js) closes a finished Booth Event's
// OPEN late-entry window at a server-resolved instant, for any admin or superadmin
// and for an event admin on the events they organise, and publishes the one
// predicate it refuses with as `can_close_late_entries` on every admin row. None of
// that reaches an organiser at a stand unless the client OFFERS it, says what it
// does before it happens, and shows the event as closed afterwards — and a
// server-only suite stays green with every line of this file's subject reverted
// (the v8.7.7 lesson: a client defect is invisible to a test that replays the wire).
//
// ── WHAT EACH ARM PINS ─────────────────────────────────────────────────────────
//   U1   the Events-row menu offers it on a window-open booth — and on NOTHING else
//        (a live booth, a lapsed window, late entries off, a Competition);
//   U2   a COMPETITOR is withheld it, on the menu AND the banner, WITH the reason —
//        and a non-competing admin on the same event is offered it (the control);
//   U3   an event admin closes their own booth end to end, and never sees another's;
//   U4   the confirm names the deadline being replaced, and Cancel sends nothing;
//   U5   the close lands, the row leaves the default view — through the close
//        handler's OWN reload, the 15 s poll stopped — AND the toast says where it
//        went; with the Ended chip already on it does not say so (control);
//   U6   pressed from the scope BANNER while on the Challenges tab: the banner stops
//        saying "late entry open", focus lands on a live control, the challenge's
//        late-entry badge and the late entrant's Remove item go;
//   U6b  the same banner fix on the End Now path (a live booth ended from the banner);
//   U6c  a banner render that lands WHILE the confirm is open (the 15 s poll's
//        category change, a tab return) is held until the dialog closes — so the
//        dialog still has a button to hand focus back to, and focus ends on All events,
//        never on <body>; the same close with nothing rendered mid-confirm is the
//        control;
//   U6d  the Cancel half of U6c, reached through a real tab return: focus stays on a
//        live Close button, and the held repaint is carried out, not dropped;
//   U6e  a tab return (or any other explicit render) keeps focus on the control the
//        admin was on — × Clear, End Now, the SAME session's chip — rather than
//        moving it to All events;
//   U6f  the same hold for the scope SWITCHER, which also hands focus back into
//        the banner when it closes;
//   U7   History renders the close at second precision, "(automatic)" only for an
//        automatic deadline;
//   U8   a STALE offer (the window closed behind the admin's back) still confirms,
//        still asks the server, and reports "already closed" — never a silent no-op;
//   U9   the three pieces of copy that name the control appear only where it exists.
//
// ── FIXTURES ────────────────────────────────────────────────────────────────────
// Every booth is built through the built-in superadmin's API session and ENDED with
// the REAL End Now (which opens the window at once) — never a raw write — except
// the LAPSED control, which is time-expired past its 48-hour window. The browser is
// a USER-BACKED regular admin (GA) wherever the tier does not matter, because a
// built-in-superadmin browser would be purged by the `sa()` login a test needs for
// its own fixtures (single session per user). Ended rows are reached through the
// chip-clearing helpers: the Events table's default chips hide Ended.
//
// Booth names end in a fixed word AFTER their unique token, so no name is a
// substring of another (`has-text` is a substring match, and "LE x1" would match
// "LE x10").
//
// TOASTS: a negative assertion on a toast is read from ONE snapshot taken after
// the positive match — never a retrying `not.toContainText`, which passes as soon
// as the toast fades (the v8.12.6 lesson).

const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const {
  adminLogin, loginViaApi, clickTab, openKebab, viewComp, filterComps, awaitCompModel, narrowChallengesTable, narrowEventsTable, narrowPeopleTable } = require("./ui-admin-helpers");
const {
  H, uniq, MIN, sa, makeParticipant, liveBooth, enrol, expireEvent, rawGetComp, rawAll,
} = require("./late-entry-fixture");
const { makeAdmin } = require("./admin-inflight-helpers");
const { grantEventAdmin, makeParticipant: makeEaParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const CLOSE_SEL = '[data-action="comp-close-late-entries"]';

// ─── local helpers ─────────────────────────────────────────────────────────────

/** A booth name no other name contains (see the header). */
const boothName = (word) => `LEC ${uniq()} ${word} stand`;

/** A live booth, ended with the REAL End Now so its late-entry window is open. */
async function openBooth(api, csrf, word, opts = {}) {
  const b = await liveBooth(api, csrf, { ...opts, create: { name: boothName(word), ...(opts.create || {}) } });
  const r = await api.post(`/api/admin/competitions/${b.comp.id}/end-now`, { headers: H(csrf), data: {} });
  expect(r.ok(), `end now: ${r.status()} ${await r.text()}`).toBeTruthy();
  return b;
}

/** The superadmin's list row for one event. */
async function saRow(api, id) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const row = (Array.isArray(list) ? list : []).find((c) => c.id === id);
  expect(row, `the event ${id} is in the superadmin's list`).toBeTruthy();
  return row;
}

/** Pin the late-entry deadline (a superadmin edit of an ended event). */
async function pinDeadline(api, csrf, id, iso) {
  const row = await saRow(api, id);
  const put = await api.put(`/api/admin/competitions/${id}`, {
    headers: H(csrf), data: { late_entry_deadline_at: iso, expectedUpdatedAt: row.updated_at },
  });
  expect(put.status(), `pin the deadline: ${await put.text()}`).toBe(200);
}

/** Close through the API (for arms whose subject is what happens AFTER a close). */
async function apiClose(api, csrf, id) {
  const r = await api.post(`/api/admin/competitions/${encodeURIComponent(id)}/late-entry/close`, { headers: H(csrf) });
  const body = await r.json();
  expect(r.status(), `close: ${JSON.stringify(body)}`).toBe(200);
  expect(body.closed, "PRECONDITION: the API close really closed it").toBe(true);
  return body;
}

/** Any account, signed into the admin panel in this page. */
async function adminPanelAs(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const me = await page.request.get("/api/admin/me");
  expect(me.ok(), `${email} had no live admin session: ${me.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

/** The Events table narrowed to one named event, and that row. */
async function eventRow(page, name) {
  await clickTab(page, "Events");
  await filterComps(page, name);
  const row = page.locator("#admin-comp-body tr", { hasText: name }).first();
  await expect(row, `the events table narrowed to "${name}"`).toBeVisible({ timeout: 15000 });
  return row;
}

/** The page's own model row — so a missing menu item is never a missing row. */
async function modelRow(page, id) {
  await page.waitForFunction((cid) => (window.S?.adminCompetitionsData || []).some((c) => c.id === cid), id, { timeout: 20000 });
  return page.evaluate((cid) => (window.S.adminCompetitionsData || []).find((c) => c.id === cid), id);
}

/** Records every late-entry close request that leaves the browser. */
function closeRecorder(page) {
  /** @type {string[]} */ const posts = [];
  const on = (rq) => { if (rq.method() === "POST" && rq.url().includes("/late-entry/close")) posts.push(rq.url()); };
  page.on("request", on);
  return { posts, stop: () => page.off("request", on) };
}

/** The toast carrying `text`, read ONCE after it appears. */
async function toastText(page, text) {
  const t = page.locator("#toast-stack .toast", { hasText: text }).last();
  await expect(t, `a toast saying "${text}"`).toBeVisible({ timeout: 15000 });
  return t.innerText();
}

/**
 * A tab switch away and back, as the browser reports it — the path main.js's
 * resume takes, which re-renders the scope banner EXPLICITLY on every return
 * whether or not anything changed (the `blurAndFocus` shape, ended-popup.spec).
 */
async function tabAwayAndBack(page) {
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

/**
 * What has keyboard focus, in words a failure can be read by: "body", "detached",
 * or the focused banner control's data-action (plus its event id, and whether it
 * is the very node that was marked BEFORE a render — so a render that silently
 * did not repaint cannot pass as one that repainted and restored focus).
 */
function bannerFocus(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    if (!a.isConnected) return "detached";
    if (!a.closest("#admin-scope-banner")) return `outside the banner: ${a.tagName}#${a.id}.${a.className}`;
    const id = a.getAttribute("data-comp-id"), ts = a.getAttribute("data-ts-id");
    return `${a.getAttribute("data-action") || a.className}${id ? `[${id}]` : ""}${ts ? `/ts:${ts}` : ""}${a.__markedBeforeRender ? " (the node from before the render)" : ""}`;
  });
}

/**
 * The workspace HEADER's controls (Invite, the join pill, the ⋯ trigger) — where
 * End now and Close late entries now live, in the ⋯ menu. Same words as
 * `bannerFocus`: the focused control's data-action, "body" or "detached".
 */
function headerFocus(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    if (!a.isConnected) return "detached";
    if (!a.closest("#ws-record")) return `outside the header: ${a.tagName}#${a.id}.${a.className}`;
    return `${a.getAttribute("data-action") || a.className}${a.__markedBeforeRender ? " (the node from before the render)" : ""}`;
  });
}

/** Open the workspace header's ⋯ menu with the MOUSE (Chromium focuses the trigger). */
async function openHeaderMenu(page) {
  const more = page.locator("#ws-quick .ws-more-btn");
  await expect(more).toBeVisible({ timeout: 10000 });
  await more.click();
  await expect(page.locator("#kebab-portal.open")).toBeVisible({ timeout: 5000 });
  return page.locator("#kebab-portal");
}

/** Mark a banner control, so `bannerFocus` can tell the pre-render node from its replacement. */
const markBeforeRender = (loc) => loc.evaluate((el) => { el.__markedBeforeRender = true; });

const closedAuditRows = (id) => rawAll("SELECT * FROM competition_events WHERE competition_id=? AND event_type='late_entry_closed'", [id]);

// ═══════════════════════════════════════════════════════════════════════════════

test.describe("v8.12.8 — Close late entries now: the client", () => {
  /** @type {any} */ let GA, CA, OPEN, LIVE, LAPSED, OFF, TOURN, COMPETE;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const { api, csrf } = await sa();
    try {
      GA = await makeAdmin(api, csrf, "closeuiga");
      CA = await makeAdmin(api, csrf, "closeuica");

      ({ comp: OPEN } = await openBooth(api, csrf, "open"));
      ({ comp: LIVE } = await liveBooth(api, csrf, { create: { name: boothName("live") } }));
      ({ comp: LAPSED } = await liveBooth(api, csrf, { create: { name: boothName("lapsed") } }));
      await expireEvent(LAPSED.id, { agoMinutes: 49 * 60 });              // past the 48 h window
      ({ comp: OFF } = await openBooth(api, csrf, "latesoff", { create: { late_entry_enabled: false } }));
      ({ comp: TOURN } = await openBooth(api, csrf, "competition", { kind: "tournament" }));

      // A booth where staff COMPETE, with CA enrolled. A compete event holds
      // SEALED challenges only and `liveBooth` always assigns an unsealed one, so
      // it is created here with no challenge (the A8 fixture, late-entry-close).
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: boothName("compete"), event_kind: "booth", start_time: new Date(Date.now() - 5 * MIN).toISOString(),
        duration_minutes: 180, self_enroll_enabled: true, staff_compete: true } });
      expect(cr.ok(), `create the compete booth: ${await cr.text()}`).toBeTruthy();
      COMPETE = (await cr.json()).competition;
      await enrol(api, csrf, COMPETE.id, CA.id);
      const en = await api.post(`/api/admin/competitions/${COMPETE.id}/end-now`, { headers: H(csrf), data: {} });
      expect(en.ok(), `end the compete booth: ${await en.text()}`).toBeTruthy();

      // Preconditions, asserted: every fixture is in the state its name says.
      const row = (id) => saRow(api, id);
      const o = await row(OPEN.id);
      expect(o.status, "OPEN has ended").toBe("ended");
      expect(o.late_entry_window_open, "…with its window open").toBe(true);
      expect(o.can_close_late_entries, "…so the superadmin is offered the close").toBe(true);
      expect((await row(LIVE.id)).status, "LIVE is live").toBe("live");
      const l = await row(LAPSED.id);
      expect(l.status, "LAPSED has ended").toBe("ended");
      expect(l.late_entry_window_open, "…and its window has lapsed").toBeFalsy();
      expect((await row(OFF.id)).late_entry_enabled, "OFF takes no late entries").toBeFalsy();
      expect((await row(TOURN.id)).event_kind, "TOURN is a Competition").toBe("tournament");
      const c = await row(COMPETE.id);
      expect(c.staff_compete, "staff compete in COMPETE").toBeTruthy();
      expect(c.late_entry_window_open, "…and its window is open").toBe(true);
    } finally { await api.dispose(); }
  });

  test("U1 — the Events menu offers Close late entries now on a window-open booth, and on nothing else", async ({ page }) => {
    await adminPanelAs(page, GA.email);
    const portal = page.locator("#kebab-portal");

    await openKebab(page, await eventRow(page, OPEN.name));
    expect((await modelRow(page, OPEN.id)).can_close_late_entries, "PRECONDITION: the server offers it to a regular admin").toBe(true);
    const item = portal.locator(CLOSE_SEL);
    await expect(item, "a window-open booth offers it").toHaveCount(1);
    await expect(item).toContainText("Close late entries now");
    await expect(item, "…as a destructive item").toHaveClass(/km-danger/);
    await page.keyboard.press("Escape");

    for (const [comp, why] of [[LIVE, "a live booth"], [LAPSED, "a lapsed window"], [OFF, "late entries off"], [TOURN, "a Competition"]]) {
      await openKebab(page, await eventRow(page, comp.name));
      // The row IS there — so the absence below is the flag, not a missing row.
      expect((await modelRow(page, comp.id)).can_close_late_entries, `the server does not offer it on ${why}`).toBe(false);
      await expect(portal.locator(CLOSE_SEL), `CONTROL: ${why} offers no close`).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
  });

  test("U2 — a COMPETITOR is withheld it on the menu and the banner WITH the reason; a non-competing admin is offered it", async ({ page, browser }) => {
    await adminPanelAs(page, CA.email);
    const row = await eventRow(page, COMPETE.name);
    const m = await modelRow(page, COMPETE.id);
    expect(m.competing, "PRECONDITION: CA competes here").toBe(true);
    expect(m.late_entry_window_open, "PRECONDITION: …and the window is open").toBe(true);
    expect(m.can_close_late_entries, "the server withholds it from a competitor").toBe(false);

    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator(".kebab-note"), "the reason is on the menu").toContainText("You are competing in this event");
    await expect(portal.locator(CLOSE_SEL), "…and the close is not").toHaveCount(0);
    await page.keyboard.press("Escape");

    await viewComp(page, COMPETE.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText("Ended · late entry open");
    // The workspace header's ⋯ menu is the one place for the close.
    const hdrMenu = page.locator("#ws-quick .kebab-menu");
    await expect(hdrMenu.locator(".kebab-note"), "the header menu gives the same reason").toContainText("You are competing in this event");
    await expect(hdrMenu.locator(CLOSE_SEL), "…and offers no close").toHaveCount(0);
    // Nor the exports the server refuses a competitor (the file holds every rival's answers).
    await expect(hdrMenu.locator('[data-action="ws-export-zip"]'), "no Export everything for a competitor").toHaveCount(0);
    await expect(banner.locator(CLOSE_SEL), "the status chip carries no controls").toHaveCount(0);

    // CONTROL — the SAME event, an admin who does not compete: offered in both places.
    const ctx2 = await browser.newContext({ baseURL: BASE });
    const p2 = await ctx2.newPage();
    try {
      await adminPanelAs(p2, GA.email);
      expect((await modelRow(p2, COMPETE.id)).competing, "PRECONDITION: GA does not compete").toBe(false);
      await openKebab(p2, await eventRow(p2, COMPETE.name));
      await expect(p2.locator("#kebab-portal").locator(CLOSE_SEL), "a non-competitor is offered it").toHaveCount(1);
      await p2.keyboard.press("Escape");
      await viewComp(p2, COMPETE.name);
      await expect(p2.locator("#ws-quick .kebab-menu").locator(CLOSE_SEL), "…in the workspace header's ⋯ menu too").toHaveCount(1);
      await expect(p2.locator("#ws-quick .kebab-menu").locator('[data-action="ws-export-zip"]'), "CONTROL: a non-competitor is offered Export everything").toHaveCount(1);
    } finally { await ctx2.close(); }
  });

  test("U3 — an event admin closes their OWN booth from its menu, and never sees another organiser's", async ({ page }) => {
    test.setTimeout(120_000);
    let OWN, THEIRS, EA;
    {
      const { api, csrf } = await sa();
      try {
        ({ comp: OWN } = await openBooth(api, csrf, "eaown"));
        ({ comp: THEIRS } = await openBooth(api, csrf, "eatheirs"));
        EA = await makeEaParticipant(api, csrf, "closeuiea");
        await grantEventAdmin(api, csrf, OWN.id, EA.id);
      } finally { await api.dispose(); }
    }
    await adminPanelAs(page, EA.email);
    await clickTab(page, "Events");
    await awaitCompModel(page);
    expect(await page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), THEIRS.id),
      "another organiser's booth is not in this event admin's list at all").toBe(false);
    expect((await modelRow(page, OWN.id)).can_close_late_entries, "their own booth is offered").toBe(true);

    await openKebab(page, await eventRow(page, OWN.name));
    await page.locator("#kebab-portal").locator(CLOSE_SEL).click();
    const modal = page.locator("#modal-overlay");
    await expect(modal.locator("#modal-title")).toHaveText("Close late entries now", { timeout: 10000 });
    await modal.locator("#modal-confirm-btn").click();
    await toastText(page, `Late entries for “${OWN.name}” are closed.`);

    const after = rawGetComp(OWN.id);
    expect(after.late_entry_deadline_at, "the deadline was pinned").toBeTruthy();
    const rows = closedAuditRows(OWN.id);
    expect(rows.length, "one audit row").toBe(1);
    expect(rows[0].changed_by, "attributed to the event admin").toBe(EA.email);
    expect(rawGetComp(THEIRS.id).late_entry_deadline_at, "CONTROL: the other booth is untouched").toBeNull();
  });

  test("U4 — the confirm names the deadline it replaces; Cancel sends nothing and changes nothing", async ({ page }) => {
    let PIN, pinIso;
    {
      const { api, csrf } = await sa();
      try {
        ({ comp: PIN } = await openBooth(api, csrf, "pinned"));
        pinIso = new Date(Date.now() + 3 * 60 * MIN).toISOString();
        await pinDeadline(api, csrf, PIN.id, pinIso);
      } finally { await api.dispose(); }
    }
    expect(rawGetComp(PIN.id).late_entry_deadline_at, "PRECONDITION: the pin landed").toBe(pinIso);

    await adminPanelAs(page, GA.email);
    const rec = closeRecorder(page);
    try {
      await openKebab(page, await eventRow(page, PIN.name));
      await page.locator("#kebab-portal").locator(CLOSE_SEL).click();
      const modal = page.locator("#modal-overlay");
      await expect(modal.locator("#modal-title")).toHaveText("Close late entries now", { timeout: 10000 });
      const pinText = await page.evaluate((iso) => window.fmtDt(iso, "long", { withZone: true }), pinIso);
      expect(pinText, "PRECONDITION: the page can format the pin").toBeTruthy();
      const body = modal.locator("#modal-body");
      await expect(body, "the dialog names the event").toContainText(PIN.name);
      await expect(body, "…and the deadline it replaces, with its zone").toContainText(`instead of at ${pinText}`);
      await expect(body).toContainText("Only a superadmin can reopen it.");
      await modal.locator("#modal-cancel-btn").click();
      await expect(modal).toBeHidden({ timeout: 10000 });
      await page.waitForTimeout(500);   // any request the click could have fired has left by now
    } finally { rec.stop(); }
    expect(rec.posts, "Cancel sends nothing").toEqual([]);
    expect(rawGetComp(PIN.id).late_entry_deadline_at, "the pin is unchanged").toBe(pinIso);
    expect(closedAuditRows(PIN.id).length, "no audit row").toBe(0);
  });

  test("U5 — the close lands, the row leaves the default view, and the toast says where it went", async ({ page }) => {
    test.setTimeout(120_000);
    let A, B;
    {
      const { api, csrf } = await sa();
      try {
        ({ comp: A } = await openBooth(api, csrf, "defaultchips"));
        ({ comp: B } = await openBooth(api, csrf, "endedchip"));
      } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);

    // The default chips — Live, Upcoming, Late entry — show A without clearing
    // anything (filterComps clears them only for a row they would hide).
    await clickTab(page, "Events");
    await filterComps(page, A.name);
    const row = page.locator("#admin-comp-body tr", { hasText: A.name }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(() => [...window.S.compStatusFilters].sort()),
      "PRECONDITION: the default chips, which hide Ended").toEqual(["late-entry", "live", "upcoming"]);
    // The 15 s admin poll reloads this list too, and it has run since boot — so
    // its next tick lands inside any wait long enough to be comfortable, and a
    // close handler that forgot to reload would pass on the poll's reload
    // (measured with the reload removed: the row left ~14.4 s after the toast,
    // inside the 15 s wait this arm used to allow). Stop it, so the handler's own
    // reload is the only thing that can move the row.
    await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
    await openKebab(page, row);
    await page.locator("#kebab-portal").locator(CLOSE_SEL).click();
    await page.locator("#modal-overlay #modal-confirm-btn").click();
    const t1 = await toastText(page, `Late entries for “${A.name}” are closed.`);
    expect(t1, "the row is about to vanish, so the toast says where it went").toContain("It is now listed under Ended.");
    expect(rawGetComp(A.id).late_entry_deadline_at, "the close really landed").toBeTruthy();
    // A third of the poll period, as a second guard should the poll ever be
    // restarted underneath this test.
    await expect(page.locator("#admin-comp-body tr", { hasText: A.name }),
      "the row leaves the default view — through the close handler's own reload, the poll being stopped").toHaveCount(0, { timeout: 5000 });

    // With the Ended chip on it is there, and reads plain Ended with nothing late left on its menu.
    await page.locator('#comp-status-filters [data-status="ended"]').click();
    const endedRow = page.locator("#admin-comp-body tr", { hasText: A.name }).first();
    await expect(endedRow).toBeVisible({ timeout: 15000 });
    await expect(endedRow.locator(".status-badge")).toHaveText(/Ended/);
    await openKebab(page, endedRow);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator(CLOSE_SEL), "no close on a closed window").toHaveCount(0);
    await expect(portal.locator('[data-action="comp-manage-participants"]'), "…nor Manage Participants").toHaveCount(0);
    await expect(portal.locator('[data-action="comp-self-enroll"]'), "…nor the Join Link").toHaveCount(0);
    await page.keyboard.press("Escape");

    // CONTROL — the Ended chip is already part of the view, so the row does not
    // vanish and the toast must not claim it did.
    expect(await page.evaluate(() => window.S.compStatusFilters.size), "PRECONDITION: every chip is on (All)").toBe(0);
    await narrowEventsTable(page, B.name);
    const rowB = page.locator("#admin-comp-body tr", { hasText: B.name }).first();
    await expect(rowB).toBeVisible({ timeout: 15000 });
    await openKebab(page, rowB);
    await page.locator("#kebab-portal").locator(CLOSE_SEL).click();
    await page.locator("#modal-overlay #modal-confirm-btn").click();
    const t2 = await toastText(page, `Late entries for “${B.name}” are closed.`);
    expect(t2, "CONTROL: nothing to explain when the row stays in view").not.toContain("listed under Ended");
    await expect(rowB, "…and it does stay").toBeVisible();
  });

  test("U6 — pressed from the header's ⋯ menu on the Challenges tab: the status chip repaints, focus lands on the ⋯ trigger, the late-entry badge and the late entrant's Remove go", async ({ page }) => {
    test.setTimeout(120_000);
    let EV, taskTitle, LATE;
    {
      const { api, csrf } = await sa();
      try {
        const b = await openBooth(api, csrf, "banner");
        EV = b.comp;
        const tasks = await (await api.get("/api/admin/tasks")).json();
        taskTitle = (tasks.find((t) => t.id === b.taskIds[0]) || {}).title;
        expect(taskTitle, "PRECONDITION: the booth's challenge").toBeTruthy();
        // Admitted THROUGH the window by the real assign door: a late entrant who
        // has not played, i.e. removable while the window is open.
        LATE = await makeParticipant(api, csrf, `${uniq()}lat`);
        await enrol(api, csrf, EV.id, LATE.id);
      } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    await clickTab(page, "Events");
    await viewComp(page, EV.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText("Ended · late entry open until");

    // PRECONDITIONS on the two tabs that must change.
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, LATE.email);
    const pRow = page.locator("#admin-participants-body tr", { hasText: LATE.email }).first();
    await expect(pRow).toBeVisible({ timeout: 20000 });
    await openKebab(page, pRow);
    await expect(page.locator('#kebab-portal [data-action="participant-uninvite"]'),
      "PRECONDITION: the late entrant can be removed while the window is open").toHaveCount(1);
    await page.keyboard.press("Escape");

    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, taskTitle);
    const tRow = page.locator("#admin-task-body tr", { hasText: taskTitle }).first();
    await expect(tRow).toBeVisible({ timeout: 20000 });
    const badge = tRow.locator(`.comp-badge[data-comp-id="${EV.id}"]`);
    await expect(badge, "PRECONDITION: the challenge carries the event's late-entry badge").toHaveClass(/comp-late-entry/);

    // Press Close with the MOUSE from the header's ⋯ menu (the dispatcher hands
    // focus to the ⋯ trigger, which the confirm then returns focus to).
    await (await openHeaderMenu(page)).locator(CLOSE_SEL).click();
    await page.locator("#modal-overlay #modal-confirm-btn").click();
    await toastText(page, `Late entries for “${EV.name}” are closed.`);

    // WITHOUT moving focus: the header and strip repaint, and focus stays on a
    // live control.
    await expect.poll(async () => (await banner.innerText()).replace(/\s+/g, " "),
      { timeout: 10000, message: "the status chip stops saying the window is open" }).not.toContain("late entry open");
    await expect(banner).toContainText("Ended");
    await expect(page.locator("#ws-quick .kebab-menu").locator(CLOSE_SEL), "…and the ⋯ menu stops offering the close").toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => headerFocus(page),
      { timeout: 5000, message: "focus lands on the ⋯ trigger, never on <body>" }).toBe("kebab-toggle");
    await expect(badge, "the challenge's badge reads the closed window").not.toHaveClass(/comp-late-entry/, { timeout: 15000 });
    await expect(badge).toHaveClass(/comp-ended/);

    await clickTab(page, "Participants");
    await narrowPeopleTable(page, LATE.email);
    await expect(pRow).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => {
      await openKebab(page, pRow);
      const n = await page.locator('#kebab-portal [data-action="participant-uninvite"]').count();
      await page.keyboard.press("Escape");
      return n;
    }, { timeout: 20000, message: "once the window is closed nobody can be removed" }).toBe(0);
  });

  test("U6b — the End Now path: ending a live booth from the ⋯ menu leaves it offering the close, focus on the ⋯ trigger", async ({ page }) => {
    test.setTimeout(120_000);
    let EV;
    {
      const { api, csrf } = await sa();
      try {
        ({ comp: EV } = await liveBooth(api, csrf, { create: { name: boothName("endnow") } }));
      } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    await clickTab(page, "Events");
    await viewComp(page, EV.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText(" left");

    await (await openHeaderMenu(page)).locator('[data-action="comp-end-now"]').click();
    const modal = page.locator("#modal-overlay");
    await expect(modal.locator("#modal-title")).toHaveText("End Event Now", { timeout: 10000 });
    // A person READS the dialog. For longer than one tick of the strip's live
    // countdown — which, had it repainted the header behind the dialog, would
    // have replaced the ⋯ trigger the dialog hands focus back to.
    await page.waitForTimeout(1600);
    await modal.locator("#modal-confirm-btn").click();
    // The 10-second countdown confirm proceeds on its own.
    await toastText(page, "Event ended.");
    await expect.poll(async () => (await banner.innerText()).replace(/\s+/g, " "),
      { timeout: 15000, message: "the status chip repaints to the late-entry state" }).toContain("Ended · late entry open until");
    await expect(page.locator("#ws-quick .kebab-menu").locator(CLOSE_SEL), "…and the ⋯ menu offers the close straight away").toHaveCount(1, { timeout: 10000 });
    await expect.poll(() => headerFocus(page),
      { timeout: 5000, message: "focus lands on the ⋯ trigger, never on <body>" }).toBe("kebab-toggle");
  });

  test("U6c — a header render landing WHILE the confirm is open still leaves focus on the ⋯ trigger, never on <body>; control: nothing rendered mid-confirm", async ({ page }) => {
    test.setTimeout(150_000);
    let MID, CTRL;
    {
      const { api, csrf } = await sa();
      try {
        ({ comp: CTRL } = await openBooth(api, csrf, "quietconfirm"));
        ({ comp: MID } = await openBooth(api, csrf, "midconfirm"));
      } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    const banner = page.locator("#admin-scope-banner");
    const modal = page.locator("#modal-overlay");

    // Close from the header's ⋯ menu with the MOUSE (the confirm hands focus back
    // to the ⋯ trigger as it closes), optionally with something re-rendering the
    // header while the confirm is up.
    const closeFromBanner = async (comp, midConfirm) => {
      await clickTab(page, "Events");
      await viewComp(page, comp.name);
      await expect(banner).toContainText("Ended · late entry open until");
      await (await openHeaderMenu(page)).locator(CLOSE_SEL).click();
      await expect(modal.locator("#modal-title")).toHaveText("Close late entries now", { timeout: 10000 });
      if (midConfirm) {
        await midConfirm();
        // A person reads the dialog — for longer than a tick, so a held render
        // must stay held while the dialog is still up, not merely for one tick.
        await page.waitForTimeout(1300);
        await expect(modal, "PRECONDITION: the render landed while the confirm was still open").toHaveClass(/\bopen\b/);
      }
      await modal.locator("#modal-confirm-btn").click();
      await toastText(page, `Late entries for “${comp.name}” are closed.`);
      await expect.poll(async () => (await banner.innerText()).replace(/\s+/g, " "),
        { timeout: 10000, message: "the banner stops saying the window is open" }).not.toContain("late entry open");
      await expect.poll(() => headerFocus(page),
        { timeout: 5000, message: "focus lands on the ⋯ trigger, never on <body>" }).toBe("kebab-toggle");
    };

    // CONTROL — nothing renders while the confirm is up: focus lands on the trigger.
    await closeFromBanner(CTRL, null);

    // The subject. `renderScopeBanner()` (which repaints the header too) is exactly
    // what the 15 s poll calls when the open event's category changes, and what a
    // tab return calls, while THIS admin's confirm is open. A header painted then
    // whose buttons changed would replace the ⋯ trigger the confirm hands focus
    // back to; the render is HELD until the dialog has gone. The mid-confirm
    // write below changes the header (a dry-run chip in the model), so the
    // render is real: it must not paint behind the dialog, and must paint after.
    expect(await page.evaluate(() => typeof window.renderScopeBanner), "PRECONDITION: the render is reachable").toBe("function");
    const dryChip = page.locator("#ws-rec-chips .ws-chip-dry");
    await closeFromBanner(MID, async () => {
      await page.evaluate((id) => {
        const c = (window.S.adminCompetitionsData || []).find((x) => x.id === id);
        if (c) c.tags = [...(c.tags || []), "test/dry run"];
        window.renderScopeBanner();
      }, MID.id);
      await page.waitForTimeout(300);
      await expect(dryChip, "the header render is held while the confirm is open").toHaveCount(0);
    });
  });

  test("U6d — Cancel after a TAB RETURN during the confirm: focus returns to a live ⋯ trigger, and the ⋯ menu still offers the close", async ({ page }) => {
    test.setTimeout(120_000);
    let EV;
    {
      const { api, csrf } = await sa();
      try { ({ comp: EV } = await openBooth(api, csrf, "cancelreturn")); } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    await clickTab(page, "Events");
    await viewComp(page, EV.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText("Ended · late entry open until");
    const rec = closeRecorder(page);
    try {
      await (await openHeaderMenu(page)).locator(CLOSE_SEL).click();
      const modal = page.locator("#modal-overlay");
      await expect(modal.locator("#modal-title")).toHaveText("Close late entries now", { timeout: 10000 });
      await tabAwayAndBack(page);
      await page.waitForTimeout(1300);   // the admin reads on; ticks pass while the dialog is up
      await expect(modal, "PRECONDITION: the tab return happened while the confirm was open").toHaveClass(/\bopen\b/);
      await modal.locator("#modal-cancel-btn").click();
      await expect(modal).not.toHaveClass(/\bopen\b/, { timeout: 10000 });

      // Focus must be on a LIVE control: the ⋯ trigger the confirm returns to,
      // never <body> or a node the held header render detached.
      await expect.poll(() => headerFocus(page),
        { timeout: 5000, message: "focus on the live ⋯ trigger — never <body>, never a detached node" })
        .toBe("kebab-toggle");
      await expect(page.locator("#ws-quick .kebab-menu").locator(CLOSE_SEL), "Cancel left the close on offer").toHaveCount(1);
    } finally { rec.stop(); }
    // CONTROL: Cancel really cancelled.
    expect(rec.posts, "Cancel sends nothing").toEqual([]);
    expect(rawGetComp(EV.id).late_entry_deadline_at, "the window is untouched").toBeNull();
  });

  test("U6e — a tab return, or any explicit banner render, keeps focus on the control the admin was on", async ({ page }) => {
    test.setTimeout(120_000);
    let EV;
    {
      const { api, csrf } = await sa();
      try { ({ comp: EV } = await liveBooth(api, csrf, { create: { name: boothName("keepfocus") } })); } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    await clickTab(page, "Events");
    await viewComp(page, EV.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner, "PRECONDITION: a live banner, whose countdown changes every second").toContainText(" left");

    // × Clear, through a real TAB RETURN.
    const clear = banner.locator('[data-action="scope-clear"]');
    await clear.focus();
    await markBeforeRender(clear);
    await page.waitForTimeout(1300);   // over a tick of the live countdown
    expect(await bannerFocus(page), "CONTROL: the 1 s tick never detaches the control you are on")
      .toBe("scope-clear (the node from before the render)");
    await tabAwayAndBack(page);
    // A NEW node: the tab return really repainted the banner (so it is not stale),
    // and focus followed to the same control rather than jumping to All events.
    await expect.poll(() => bannerFocus(page),
      { timeout: 5000, message: "focus stays on × Clear, in the repainted banner" }).toBe("scope-clear");

    // The header's ⋯ trigger (End Now's home now) through the explicit render
    // the 15 s poll makes on a category change: focus stays on it.
    const more = page.locator("#ws-quick .ws-more-btn");
    await more.focus();
    await page.evaluate(() => window.renderScopeBanner());
    await expect.poll(() => headerFocus(page),
      { timeout: 5000, message: "focus stays on the ⋯ trigger through the header render" }).toMatch(/^kebab-toggle/);
    await expect(banner, "CONTROL: nothing ended — the event is still live").toContainText(" left");

    // A SESSION CHIP. Every chip carries the same data-action, so "the same
    // control" is the same SESSION: focus the second chip, and a render must
    // not hand focus to the first.
    let TWO, first, second;
    {
      const { api, csrf } = await sa();
      try {
        const start = Date.now() + 2 * 60 * MIN;
        const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
          name: boothName("twosessions"), start_time: new Date(start).toISOString(), duration_minutes: 60 } });
        expect(cr.ok(), `create the two-session event: ${await cr.text()}`).toBeTruthy();
        TWO = (await cr.json()).competition;
        const slot = async (name, at) => {
          const r = await api.post(`/api/admin/competitions/${TWO.id}/timeslots`, { headers: H(csrf), data: {
            name, start_time: new Date(at).toISOString(), duration_minutes: 60 } });
          expect(r.ok(), `create session ${name}: ${await r.text()}`).toBeTruthy();
          return (await r.json()).timeslot;
        };
        first = await slot("First sitting", start);
        second = await slot("Second sitting", start + 2 * 60 * MIN);
      } finally { await api.dispose(); }
    }
    await clickTab(page, "Events");
    await viewComp(page, TWO.name);
    const chips = banner.locator('[data-action="comp-focus-ts"]');
    await expect(chips, "PRECONDITION: the banner offers both sessions as chips").toHaveCount(2);
    await expect(chips.first(), "PRECONDITION: …the FIRST chip is the other session").toHaveAttribute("data-ts-id", first.id);
    const chip2 = banner.locator(`[data-action="comp-focus-ts"][data-ts-id="${second.id}"]`);
    await chip2.focus();
    await markBeforeRender(chip2);
    await tabAwayAndBack(page);
    await expect.poll(() => bannerFocus(page),
      { timeout: 5000, message: "focus stays on the SECOND session's chip, in the repainted banner" }).toBe(`comp-focus-ts[${TWO.id}]/ts:${second.id}`);
  });

  // U6f (closing the scope SWITCHER handed focus back to Switch) was retired with
  // the switcher itself: an organiser now changes event from the Events list,
  // never from inside a workspace. U6c and U6g hold the same rule for the
  // dialogs that remain.

  test("U6g — an alert or session warning that pops while focus is on a banner control hands focus back to it", async ({ page }) => {
    test.setTimeout(120_000);
    let EV;
    {
      const { api, csrf } = await sa();
      try { ({ comp: EV } = await liveBooth(api, csrf, { create: { name: boothName("popups") } })); } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    await clickTab(page, "Events");
    await viewComp(page, EV.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner, "PRECONDITION: a live banner, whose countdown changes every second").toContainText(" left");
    // Both open ON THEIR OWN (the 20 s alerts poll; the idle timer) while focus
    // may be on a banner control, capture that control as the place to hand focus
    // back to, and move focus into themselves — so the tick no longer sees focus
    // inside the banner. Without the pause, the live countdown replaced the
    // captured control and focus fell to <body>.
    const popups = [
      { why: "the session-expiry warning", open: () => page.evaluate(() => window._showSessionWarning()),
        overlay: "#session-warn-overlay", close: '#session-warn-overlay [data-action="session-warn-stay"]' },
      { why: "the IP-ban alert",
        open: async () => {
          const { api, csrf } = await sa();
          try {
            const r = await api.post("/api/test/raise-ip-ban-alert", { headers: { "x-csrf-token": csrf, "content-type": "application/json" },
              data: { ip: "203.0.113.88", count4xx: 103, competitionId: EV.id, competitionName: EV.name } });
            expect(r.ok(), `raise the alert: ${r.status()}`).toBeTruthy();
          } finally { await api.dispose(); }
          await page.evaluate(() => window._adminAlertTick());
        },
        overlay: "#admin-alert-overlay", close: '#admin-alert-overlay [data-action="admin-alert-dismiss"]' },
    ];
    try {
      for (const p of popups) {
        const clear = banner.locator('[data-action="scope-clear"]');
        await clear.focus();
        expect(await bannerFocus(page), `PRECONDITION (${p.why}): focus starts on × Clear`).toBe("scope-clear");
        await p.open();
        await expect(page.locator(p.overlay), `PRECONDITION: ${p.why} opened`).toBeVisible({ timeout: 10000 });
        await page.waitForTimeout(1300);                       // at least one tick of the live countdown
        await page.locator(p.close).click();
        await expect(page.locator(p.overlay)).toHaveCount(0, { timeout: 10000 });
        await expect.poll(() => bannerFocus(page),
          { timeout: 5000, message: `closing ${p.why} hands focus back to × Clear, never to <body>` }).toBe("scope-clear");
      }
    } finally {
      // An alert left open is served to every later test on this worker as a
      // blocking modal (the v7.16.7 rule).
      const { api, csrf } = await sa();
      try { await api.post("/api/test/clear-ip-ban-alerts", { headers: { "x-csrf-token": csrf } }); } finally { await api.dispose(); }
    }
  });

  test("U6h — a tab return does not scroll the page back to the banner", async ({ page }) => {
    test.setTimeout(120_000);
    let EV;
    {
      const { api, csrf } = await sa();
      try { ({ comp: EV } = await liveBooth(api, csrf, { create: { name: boothName("scroll") } })); } finally { await api.dispose(); }
    }
    await page.setViewportSize({ width: 1280, height: 420 });
    await adminPanelAs(page, GA.email);
    await clickTab(page, "Events");
    await viewComp(page, EV.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText(" left");
    await banner.locator('[data-action="scope-clear"]').focus();
    // The admin scrolls down the page with focus still on a banner control —
    // the designed state straight after acting from the banner.
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    const before = await page.evaluate(() => document.scrollingElement.scrollTop);
    expect(before, "PRECONDITION: the page really scrolled, so the banner is off screen").toBeGreaterThan(100);
    await tabAwayAndBack(page);
    await expect.poll(() => bannerFocus(page), { timeout: 5000, message: "the tab return repainted and put focus back on × Clear" }).toBe("scope-clear");
    expect(await page.evaluate(() => document.scrollingElement.scrollTop), "the page stays where the admin left it").toBe(before);
  });

  test("U7 — History shows the close at second precision, and says when the deadline was the automatic one", async ({ page }) => {
    test.setTimeout(120_000);
    let AUTO, PINNED, autoClose, pinClose, pinIso;
    {
      const { api, csrf } = await sa();
      try {
        ({ comp: AUTO } = await openBooth(api, csrf, "histauto"));
        autoClose = await apiClose(api, csrf, AUTO.id);
        ({ comp: PINNED } = await openBooth(api, csrf, "histpin"));
        pinIso = new Date(Date.now() + 2 * 60 * MIN).toISOString();
        await pinDeadline(api, csrf, PINNED.id, pinIso);
        pinClose = await apiClose(api, csrf, PINNED.id);
      } finally { await api.dispose(); }
    }
    expect(autoClose.previous_deadline_pinned, "PRECONDITION: AUTO followed the end").toBe(false);
    expect(pinClose.previous_deadline_pinned, "PRECONDITION: PINNED was pinned").toBe(true);

    await adminPanelAs(page, GA.email);
    const historyOf = async (comp) => {
      await openKebab(page, await eventRow(page, comp.name));
      await page.locator('#kebab-portal [data-action="comp-history"]').click();
      const ov = page.locator("#hist-overlay");
      await expect(ov).toBeVisible({ timeout: 15000 });
      const line = ov.locator("#hist-body tr", { hasText: "Late entries closed early at" });
      await expect(line, "the close has its own History sentence").toHaveCount(1);
      const text = (await line.innerText()).replace(/\s+/g, " ");
      await ov.locator('[data-action="history-close"]').click();
      await expect(ov).toHaveCount(0, { timeout: 10000 });
      return text;
    };

    const autoText = await historyOf(AUTO);
    const autoAt = await page.evaluate((iso) => window.fmtDt(iso, "full"), autoClose.closed_at);
    const autoFrom = await page.evaluate((iso) => window.fmtDt(iso, "long"), autoClose.previous_deadline);
    expect(autoText, "the press instant, to the second").toContain(`Late entries closed early at ${autoAt}`);
    expect(autoText, "the deadline it replaced, marked automatic").toContain(`the deadline was ${autoFrom} (automatic)`);

    const pinText = await historyOf(PINNED);
    const pinAt = await page.evaluate((iso) => window.fmtDt(iso, "full"), pinClose.closed_at);
    const pinFrom = await page.evaluate((iso) => window.fmtDt(iso, "long"), pinIso);
    expect(pinText).toContain(`Late entries closed early at ${pinAt}`);
    expect(pinText).toContain(`the deadline was ${pinFrom}`);
    expect(pinText, "CONTROL: a pinned deadline is not called automatic").not.toContain("(automatic)");
  });

  test("U8 — a STALE offer still confirms, still asks the server, and reports that it was already closed", async ({ page }) => {
    test.setTimeout(120_000);
    let EV;
    {
      const { api, csrf } = await sa();
      try { ({ comp: EV } = await openBooth(api, csrf, "stale")); } finally { await api.dispose(); }
    }
    await adminPanelAs(page, GA.email);
    await openKebab(page, await eventRow(page, EV.name));
    const item = page.locator("#kebab-portal").locator(CLOSE_SEL);
    await expect(item, "the menu was rendered while the window was open").toHaveCount(1);

    // Behind the admin's back: a colleague closes it, and the model catches up
    // while the menu the admin is looking at stays open (it is a copy).
    {
      const { api, csrf } = await sa();
      try { await apiClose(api, csrf, EV.id); } finally { await api.dispose(); }
    }
    await page.evaluate(() => window.loadAdminCompetitions({ keepPage: true }));
    await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).find((c) => c.id === id)?.can_close_late_entries, EV.id),
      { timeout: 10000, message: "PRECONDITION: the model now says the window is closed" }).toBe(false);
    await expect(item, "PRECONDITION: …while the stale menu item is still there").toBeVisible();

    const rec = closeRecorder(page);
    try {
      await item.click();
      const modal = page.locator("#modal-overlay");
      await expect(modal.locator("#modal-title"), "the confirm still shows — never a silent no-op").toHaveText("Close late entries now", { timeout: 10000 });
      const resp = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/late-entry/close"), { timeout: 15000 });
      await modal.locator("#modal-confirm-btn").click();
      expect((await resp).status(), "the server was asked").toBe(200);
      await toastText(page, `Late entries for “${EV.name}” were already closed.`);
    } finally { rec.stop(); }
    expect(rec.posts.length, "one request left the browser").toBe(1);
    expect(closedAuditRows(EV.id).length, "the idempotent answer wrote nothing more").toBe(1);
  });

  test("U9a — the editor's lock note names the close only while the window is open", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await awaitCompModel(page);
    const openEditor = async (id) => {
      await page.waitForFunction((cid) => (window.S?.adminCompetitionsData || []).some((c) => c.id === cid), id, { timeout: 20000 });
      await page.evaluate((cid) => window.editCompetition(cid), id);
      await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
    };
    const closeForm = async () => {
      await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
      await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 10000 });
    };

    await openEditor(OPEN.id);
    const note = page.locator("#comp-late-entry-lock-note");
    await expect(note, "the switch is locked on an ended event").toBeVisible();
    await expect(note, "…and the remedy is the new control").toContainText("Close late entries now");
    expect(await note.innerText(), "the old superadmin-only remedy is gone").not.toContain("deadline below to now");
    await closeForm();

    // CONTROL — the switch is locked just the same after the window has lapsed,
    // but there is no door left to close, so no remedy is named.
    await openEditor(LAPSED.id);
    await expect(note, "PRECONDITION: the lapsed booth's switch is locked too").toBeVisible();
    await expect(note).toContainText("the event has ended");
    expect(await note.innerText(), "CONTROL: no remedy named once the window has lapsed").not.toContain("Close late entries");
    await closeForm();
  });

  test("U9b — the Join Link dialog names the close for an organiser, and not for a competitor", async ({ page, browser }) => {
    const joinLinkNote = async (p, comp) => {
      await openKebab(p, await eventRow(p, comp.name));
      await p.locator('#kebab-portal [data-action="comp-self-enroll"]').click();
      const ov = p.locator("#self-enroll-overlay");
      await expect(ov).toBeVisible({ timeout: 15000 });
      const n = ov.locator("#self-enroll-late-note");
      await expect(n, "PRECONDITION: the late-entry note renders on a window-open event").toBeVisible();
      const text = (await n.innerText()).replace(/\s+/g, " ");
      await p.keyboard.press("Escape");
      await expect(ov).toHaveCount(0, { timeout: 10000 });
      return text;
    };

    await adminPanelAs(page, GA.email);
    expect(await joinLinkNote(page, OPEN), "an organiser is told how to close it sooner").toContain("Close late entries now");

    const ctx2 = await browser.newContext({ baseURL: BASE });
    const p2 = await ctx2.newPage();
    try {
      await adminPanelAs(p2, CA.email);
      expect((await modelRow(p2, COMPETE.id)).competing, "PRECONDITION: CA competes").toBe(true);
      expect(await joinLinkNote(p2, COMPETE), "CONTROL: a competitor is not pointed at a control they are withheld").not.toContain("Close late entries");
    } finally { await ctx2.close(); }
  });
});
