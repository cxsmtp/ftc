"use strict";

// v8.8.7 — THE ROLE CELL NAMES THE EVENTS AS BADGES, AND ONLY THE CURRENT ONES.
//
// v8.7.0 made the Role cell say WHICH events an organiser runs, because the role
// is granted once and the events change constantly. It rendered one name, or the
// bare count "3 events" with the names hidden in a `title` — so the common case
// answered the operator's question with a number and made them hover to learn
// anything at all.
//
// It now mirrors the participant events column beside it: `compDisplayCategory`
// decides the class and the tooltip, and only live / upcoming / late-entry
// events are shown, because those are the ones an operator can act on. Ended
// events are the bulk of any long-running platform and would crowd out the two
// that matter.
//
// THE MIDDLE STATE IS THE ONE WORTH THE FILE. Filtering creates a second empty
// case — they organise events, all of them finished — which must NOT render as
// "no events": zero grants is a real, deliberate state (removing somebody's last
// event leaves the role in place, v8.7.0), so conflating the two would tell the
// operator an organiser of three finished events has none. Every positive here
// carries a control, and the two empty states are each other's.

const { test, expect } = require("./isolated-test");
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { BASE, appearanceSettled } = require("./helpers");
const { adminLogin, clickTab, narrowPeopleTable } = require("./ui-admin-helpers");
const {
  H, makeParticipant, makeCompetition, grantEventAdmin,
} = require("./event-admin-helpers");
const { apiLogin } = require("./helpers");

test.use({ baseURL: BASE });

/** Promote to the tier, then grant. A grant alone does not set the role. */
async function makeOrganiser(sa, csrf, label, compIds) {
  const p = await makeParticipant(sa, csrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, {
    headers: H(csrf), data: { role: "event_admin" },
  });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  for (const cid of compIds) await grantEventAdmin(sa, csrf, cid, p.id);
  return p;
}

/** The row's own `event_admin_for` projection, read from the SERVER. */
async function eventAdminFor(api, email) {
  const r = await api.get("/api/admin/participants?limit=5000");
  expect(r.ok(), `participants: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  const rows = body.participants || body.users || body;
  const row = rows.find(u => u.email === email);
  expect(row, `the row for ${email} is in the list`).toBeTruthy();
  return row.event_admin_for || [];
}

async function findRow(page, email) {
  await narrowPeopleTable(page, email);
  // The search re-renders the table on a 160 ms debounce, and the row is often
  // on the unfiltered first page already: waiting for it to be visible returns
  // BEFORE the re-render, which then replaces it, and a style read lands on the
  // detached node (every computed value ""). Wait for the table to narrow.
  await expect.poll(() => page.locator("#admin-participants-body tr").evaluateAll(
    (trs, e) => trs.length > 0 && trs.every((tr) => tr.textContent.includes(e)), email),
  { message: `the table narrows to ${email}`, timeout: 15000 }).toBe(true);
  const row = page.locator(`#admin-participants-body tr:has-text('${email}')`).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  return row;
}

test.describe("v8.8.7 — the event-admin role cell renders its events as badges", () => {
  /** @type {any} */ let sa, csrf;
  let live, ended, late, both, pastOnly, none;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;

    live = await makeCompetition(sa, csrf, "rblive");

    // ENDED: started and finished in the past. A tournament, so no late-entry
    // window can reopen it — the category must land on `ended` for real.
    ended = await makeCompetition(sa, csrf, "rbended", {
      start_time: new Date(Date.now() - 3 * 3600_000).toISOString(),
      duration_minutes: 60,
      event_kind: "tournament",
    });

    // LATE ENTRY: a finished BOOTH event, whose join window outlives it by 48 h.
    // This is the third category the operator asked for and the one a naive
    // `status === 'live' || 'upcoming'` filter drops — the whole reason the cell
    // asks `compDisplayCategory` rather than reading the status directly.
    late = await makeCompetition(sa, csrf, "rblate", {
      start_time: new Date(Date.now() - 3 * 3600_000).toISOString(),
      duration_minutes: 60,
      event_kind: "booth",
      late_entry_enabled: true,
    });

    both = await makeOrganiser(sa, csrf, "rbboth", [live.id, ended.id, late.id]);
    pastOnly = await makeOrganiser(sa, csrf, "rbpast", [ended.id]);
    none = await makeOrganiser(sa, csrf, "rbnone", []);
  });

  test("the payload carries the category inputs, not merely id and name", async () => {
    // The client cannot classify what it was not sent, and `lateEntryWindowOpen`
    // THROWS on a row with no `event_kind` rather than guessing one — so a
    // projection that shipped only {id,name} would render every event as ended
    // with nothing erroring. Asserted on the wire, where a client test cannot
    // tell a missing field from a mis-styled badge.
    const evs = await eventAdminFor(sa, both.email);
    expect(evs.length, "all three grants are projected").toBe(3);

    const byId = Object.fromEntries(evs.map(e => [e.id, e]));
    expect(byId[live.id].status, "the live event says so").toBe("live");
    expect(byId[ended.id].status, "the finished tournament says so").toBe("ended");
    expect(byId[late.id].status, "a late-entry window does NOT reopen the event").toBe("ended");
    expect(byId[late.id].late_entry_window_open, "…it rides its own flag").toBe(true);
    expect(byId[ended.id].late_entry_window_open, "…which a tournament can never have").toBe(false);
    for (const e of evs) expect(typeof e.name, "every entry names its event").toBe("string");
  });

  test("the PICKER payload carries the same shape — the two must not drift", async () => {
    // The picker's own header warns that a field present on one payload and
    // absent on the other is a column that empties itself depending on whether a
    // competition happens to be focused. Both sites read ONE builder now; this
    // is what holds that.
    const r = await sa.get(`/api/admin/participants/picker?competitionId=${live.id}&search=${encodeURIComponent(both.email)}`);
    expect(r.ok(), `picker: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const rows = [...(body.users || [])];
    const row = rows.find(u => u.email === both.email);
    expect(row, "the organiser is in the picker payload").toBeTruthy();
    const byId = Object.fromEntries((row.event_admin_for || []).map(e => [e.id, e]));
    expect(byId[live.id] && byId[live.id].status, "the picker classifies too").toBe("live");
    expect(byId[late.id] && byId[late.id].late_entry_window_open,
      "…including the late-entry flag").toBe(true);
  });

  test("the cell badges the CURRENT events and drops the finished one", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    const row = await findRow(page, both.email);
    const cell = row.locator("td:has(> .role-badge)");

    await expect(cell.locator(".role-badge"), "the tier is still badged").toHaveText("Event admin");
    // …and the badge is a STYLED pill on a readable pair, by day and by night:
    // its rules were once deleted while this text check kept passing.
    // One page.evaluate finds the badge and reads its style in the same task, so
    // no re-render can replace the node between the two (a locator resolves,
    // then evaluates).
    const badgeLook = () => page.evaluate((email) => {
      const tr = [...document.querySelectorAll("#admin-participants-body tr")].find((t) => t.textContent.includes(email));
      const el = tr && tr.querySelector("td > .role-badge");
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const fg = rgb(cs.color), bg = rgb(cs.backgroundColor);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return { bg: cs.backgroundColor, parsed: fg.length >= 3 && bg.length >= 3, alpha: bg.length > 3 ? bg[3] : 1, padL: parseFloat(cs.paddingLeft), ratio: (hi + 0.05) / (lo + 0.05) };
    }, both.email);
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    const theme0 = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    try {
      for (const mode of ["light", "dark"]) {
        await page.evaluate((m) => { document.documentElement.setAttribute("data-theme", m); }, mode);
        const b = await badgeLook();
        expect(b, `${mode}: the badge is in the row`).toBeTruthy();
        expect(b.parsed, `${mode}: both colours are real values (${b.bg})`).toBe(true);
        expect(b.alpha, `${mode}: the badge has its own opaque fill (${b.bg})`).toBe(1);
        expect(b.padL, `${mode}: and its padding`).toBeGreaterThan(0);
        expect(b.ratio, `${mode}: its label reads at AA on its fill`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await page.evaluate((t) => { if (t === null) document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t); }, theme0);
    }

    const badges = cell.locator(".comp-badge");
    await expect(badges, "two of the three events are current").toHaveCount(2);
    await expect(cell, "the live event is named").toContainText(live.name);
    await expect(cell, "…and so is the one still taking late entries").toContainText(late.name);

    // THE CONTROL. Without it "the events are badged" is equally satisfied by a
    // build that badges every grant, which is the crowding this release removes.
    await expect(cell, "the finished event is NOT badged").not.toContainText(ended.name);

    // The colour comes from the shared category class, so this cell and the
    // events column beside it cannot disagree about what live looks like.
    await expect(cell.locator(`.comp-badge:has-text("${live.name}")`)).toHaveClass(/comp-live/);
    await expect(cell.locator(`.comp-badge:has-text("${late.name}")`)).toHaveClass(/comp-late-entry/);
  });

  test("a badge focuses its event, like the events column beside it", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    const row = await findRow(page, both.email);
    const badge = row.locator(`td:has(> .role-badge) .comp-badge:has-text("${live.name}")`);
    await expect(badge, "the badge announces itself as a control").toHaveAttribute("role", "button");
    await badge.click();
    await expect(page.locator("#admin-scope-banner"), "the event is focused")
      .toContainText(live.name, { timeout: 15000 });
  });

  test("nothing current means nothing rendered — no label of any kind", async ({ page }) => {
    // v8.8.10 — RE-POINTED. v8.8.7 gave the two empty states their own copy so an
    // organiser of three finished events would not read as one who organises
    // nothing. The operator's ruling is that NEITHER is worth telling: nothing
    // here is actionable, the role badge already says what the person is, and a
    // grey sentence where the badges go is noise on a dense table.
    //
    // Its subject is unchanged — what this cell shows when the filter empties it
    // — and only the answer moved, from two sentences to none.
    await adminLogin(page);
    await clickTab(page, "Participants");
    const cell = (await findRow(page, pastOnly.email)).locator("td:has(> .role-badge)");
    await expect(cell.locator(".role-badge"), "the tier is still stated").toHaveText("Event admin");
    await expect(cell.locator(".comp-badge"), "nothing current, so no badges").toHaveCount(0);
    // The label is GONE, both halves of it. Asserted by absence of the words
    // rather than of an element, because the point is that no copy is rendered
    // however it is marked up.
    await expect(cell, "…and no count of what has finished").not.toContainText(/finished/i);
    await expect(cell, "…and no 'no events' sentence").not.toContainText(/no (current )?events/i);
  });

  test("CONTROL — zero grants renders the same way, and a CURRENT event still badges", async ({ page }) => {
    // TWO controls in one, and both are needed. Without the first, "the label is
    // gone" is satisfied by a build that treats the two empty states differently
    // again in the other direction. Without the second, it is satisfied by a
    // build that stopped rendering badges at all — which would be a far worse
    // product than the label this release removes.
    await adminLogin(page);
    await clickTab(page, "Participants");

    const zeroCell = (await findRow(page, none.email)).locator("td:has(> .role-badge)");
    await expect(zeroCell.locator(".role-badge")).toHaveText("Event admin");
    await expect(zeroCell.locator(".comp-badge")).toHaveCount(0);
    await expect(zeroCell, "zero grants reads exactly like nothing-current now")
      .not.toContainText(/no events/i);

    const liveCell = (await findRow(page, both.email)).locator("td:has(> .role-badge)");
    await expect(liveCell.locator(".comp-badge"), "an organiser with current events still gets them")
      .toHaveCount(2);
  });

});
