"use strict";

// THE PROFILE CARD (public/js/features/profile-card.js) — the People row's
// compact read-only view of one person, opened by `participant-view-profile`
// (the row's View button and the kebab's "View profile").
//
// What it locks:
//   • it opens from the KEBAB item and from the row button, and shows the
//     person BY VALUE (their company, their primary email), with a negative
//     control (another person's company is not on it);
//   • SCOPE: an event admin's card lists only the events the server let them
//     see. The target is enrolled in the event admin's event AND in a DECOY
//     they do not organise; the decoy's name must appear nowhere in the card,
//     while a SUPERADMIN's card for the same person names both (the control
//     that keeps "absent" from passing on a card that lists nothing);
//   • each event's status reads as on the Events list (the one label table:
//     an ended Booth Event in its late-entry window is "Late entry open");
//   • axe-clean (moderate+), Escape closes it and focus returns to the opener;
//   • a bottom sheet at phone width with no sideways overflow.
//
// Fixtures: buildWorld() (event-admin-helpers) plus our own target, all in
// beforeAll; the browser logins below end the API sessions that built them.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, loginViaApi, clickTab, openKebab, AxeBuilder, AXE_GATED_IMPACTS, showAllParticipantColumns, narrowPeopleTable } = require("./ui-admin-helpers");
const { uniq, buildWorld, makeParticipant, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });
test.beforeEach(async ({ page }) => { await showAllParticipantColumns(page); });

let world, target, other, targetCompany, otherCompany;

test.beforeAll(async () => {
  world = await buildWorld();
  const { sa, saCsrf } = world;
  target = await makeParticipant(sa, saCsrf, "pcard");
  other = await makeParticipant(sa, saCsrf, "pcother");
  targetCompany = `Cardco ${uniq("c").slice(-8)}`;
  otherCompany = `Othercorp ${uniq("o").slice(-8)}`;
  for (const [u, company] of [[target, targetCompany], [other, otherCompany]]) {
    const r = await sa.put(`/api/admin/participants/${u.id}`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" }, data: { company },
    });
    expect(r.ok(), `set company: ${r.status()} ${await r.text()}`).toBeTruthy();
  }
  // The target sits in the event admin's event AND in the decoy.
  await enrol(sa, saCsrf, world.mine.id, [target.id, other.id]);
  await enrol(sa, saCsrf, world.theirs.id, [target.id]);
  // Preconditions, from the server, for each viewer.
  const saRow = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find((p) => p.id === target.id);
  expect(saRow.company).toBe(targetCompany);
  expect(saRow.competitions.map((c) => c.id).sort()).toEqual([world.mine.id, world.theirs.id].sort());
  const eaRow = (await (await world.eaApi.get("/api/admin/participants?limit=5000")).json()).participants.find((p) => p.id === target.id);
  expect(eaRow, "the event admin can see the target").toBeTruthy();
  expect(eaRow.competitions.map((c) => c.id), "the server narrows the event admin's row to their event").toEqual([world.mine.id]);
});

// Search People down to one person. `.fill()` returns while the table still
// holds the unfiltered rows (the search filters after a debounce) and this person
// is already among them, so a row found at once can be one the narrowing render
// is about to replace: a click on the replaced node reaches no handler and opens
// nothing (desk-reveal.spec.js met the same race). Wait for their row alone.
async function searchPeople(page, email) {
  await clickTab(page, "participants");
  await narrowPeopleTable(page, email);
  await expect.poll(() => page.evaluate((e) => {
    const rows = [...document.querySelectorAll("#admin-participants-body tr")];
    return rows.length === 1 && rows[0].textContent.includes(e);
  }, email), { timeout: 15000, intervals: [100, 200, 400, 800], message: `the table narrows to ${email} alone` }).toBe(true);
}

async function openPeople(page) {
  await searchPeople(page, target.email);
  const row = page.locator(`#admin-participants-body tr:has([data-action="participant-view-profile"][data-id="${target.id}"])`).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  return row;
}

const card = (page) => page.locator("#profile-card-overlay .pc-card");

test("opens from the kebab's View profile and shows the person by value — superadmin names every event", async ({ page }) => {
  await adminLogin(page);
  const row = await openPeople(page);
  await openKebab(page, row);
  await page.locator(`#kebab-portal [data-action="participant-view-profile"][data-id="${target.id}"]`).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator("#pc-title")).toHaveText(/Event pcard/);
  await expect(card(page)).toContainText(targetCompany);
  await expect(card(page)).toContainText(target.email);
  await expect(card(page), "NEGATIVE CONTROL: another person's company is not on this card").not.toContainText(otherCompany);
  // CONTROL for the scope test below: an unscoped viewer sees both events.
  await expect(card(page).locator(".pc-events")).toContainText(world.mine.name);
  await expect(card(page).locator(".pc-events")).toContainText(world.theirs.name);
  // Doors the kebab offers this row are offered here too.
  await expect(card(page).locator('[data-pc-act="edit"]')).toHaveText(/Edit profile/);
  await expect(card(page).locator('[data-pc-act="history"]')).toHaveText(/History/);
  await expect(card(page).locator('[data-pc-act="impersonate"]')).toHaveText(/Impersonate/);

  const results = await new AxeBuilder({ page }).include("#profile-card-overlay").analyze();
  const gated = results.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
  expect(gated.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(" ")).join(" | ")}`)).toEqual([]);

  // Escape closes; focus returns to this person's row — the menu button that
  // opened the card, or (when a table re-render replaced it) the row's View.
  await page.keyboard.press("Escape");
  await expect(page.locator("#profile-card-overlay")).toHaveCount(0);
  await expect.poll(() => page.evaluate((id) => {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return "body";
    const row = ae.closest("tr");
    return row && row.querySelector(`[data-action="participant-view-profile"][data-id="${id}"]`) ? "row" : `elsewhere:${ae.id || ae.className}`;
  }, target.id), { timeout: 3000, message: "focus is back on the target's row, not dropped to the page" }).toBe("row");
});

test("an event admin's card lists only their event — the decoy event's name is nowhere on it", async ({ page }) => {
  await loginViaApi(page, world.ea.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  const row = await openPeople(page);
  await row.locator(`[data-action="participant-view-profile"][data-id="${target.id}"]`).first().click();
  await expect(card(page)).toBeVisible();
  // POSITIVE: the card rendered the person and their in-scope event.
  await expect(card(page)).toContainText(targetCompany);
  await expect(card(page).locator(".pc-events")).toContainText(world.mine.name);
  // THE LOCK: by value, across the whole card (text and attributes).
  const html = await page.locator("#profile-card-overlay").evaluate((el) => el.outerHTML + "\n" + el.innerText);
  expect(html.includes(world.theirs.name), "the out-of-scope event's name must not reach the card").toBe(false);
  expect(html.includes(world.theirs.id), "…nor its id").toBe(false);
  // Edit profile is still offered (a participant target); Close works by button.
  await card(page).locator('[data-pc-act="close"]').click();
  await expect(page.locator("#profile-card-overlay")).toHaveCount(0);
});

// AN EVENT'S STATUS READS AS ON THE EVENTS LIST. The card had its own label
// table, so an ended Booth Event still taking late entries read "Late entry"
// here and "Late entry open" on the Events list; it now asks the one table
// (competition-picker.js COMP_CATEGORY_LABEL, by compDisplayCategory).
test("each event's status reads as on the Events list: 'Late entry open' for an ended booth in its window (controls: Ended, Live)", async ({ page }) => {
  test.setTimeout(120_000);
  const { apiLogin } = require("./helpers");
  const { makeCompetition, H } = require("./event-admin-helpers");
  const s = await apiLogin("superadmin");
  let who, late, ended, live;
  try {
    who = await makeParticipant(s.api, s.csrf, "pcstatus");
    late = await makeCompetition(s.api, s.csrf, "pc-late", { event_kind: "booth" });
    ended = await makeCompetition(s.api, s.csrf, "pc-ended");
    live = await makeCompetition(s.api, s.csrf, "pc-live");
    for (const ev of [late, ended, live]) await enrol(s.api, s.csrf, ev.id, [who.id]);
    for (const ev of [late, ended]) {
      const r = await s.api.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(s.csrf), data: {} });
      expect(r.ok(), `end now: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const row = (await (await s.api.get("/api/admin/participants?limit=5000")).json()).participants.find((p) => p.id === who.id);
    const by = Object.fromEntries(row.competitions.map((c) => [c.id, [c.status, !!c.late_entry_window_open]]));
    expect(by[late.id], "PRECONDITION: the booth is ended with its late window open").toEqual(["ended", true]);
    expect(by[ended.id], "PRECONDITION: the tournament is ended with no window").toEqual(["ended", false]);
    expect(by[live.id], "PRECONDITION: the third is live").toEqual(["live", false]);
  } finally { await s.api.dispose(); }
  await adminLogin(page);
  await searchPeople(page, who.email);
  const btn = page.locator(`#admin-participants-body [data-action="participant-view-profile"][data-id="${who.id}"]`).first();
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.click();
  await expect(card(page)).toBeVisible();
  const statusOf = (ev) => card(page).locator(`.pc-event[data-comp-id="${ev.id}"] .pc-ev-meta > :first-child`);
  await expect(statusOf(late), "the late-entry window's own label, as on the Events list").toHaveText("Late entry open");
  await expect(statusOf(ended), "CONTROL: an ended event with no window").toHaveText("Ended");
  await expect(statusOf(live), "CONTROL: a live event").toHaveText("Live");
});

test("phone: the card is a bottom sheet with no sideways overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await adminLogin(page);
  const row = await openPeople(page);
  // A phone's one row-action path is the row's ⋯ menu (the View button is
  // hidden at this width), so the card opens the way a phone user opens it.
  await openKebab(page, row);
  await page.locator(`#kebab-portal [data-action="participant-view-profile"][data-id="${target.id}"]`).click();
  await expect(card(page)).toBeVisible();
  await expect.poll(async () => (await card(page).boundingBox())?.height || 0).toBeGreaterThan(100);
  const g = await page.evaluate(() => {
    const c = document.querySelector("#profile-card-overlay .pc-card").getBoundingClientRect();
    const body = document.querySelector("#profile-card-overlay .pc-body");
    return { left: c.left, right: c.right, bottom: c.bottom, vw: window.innerWidth, vh: window.innerHeight,
      bodyOverflow: body.scrollWidth - body.clientWidth, docOverflow: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(Math.abs(g.bottom - g.vh), `anchored to the bottom edge: ${JSON.stringify(g)}`).toBeLessThanOrEqual(1);
  expect(g.left, JSON.stringify(g)).toBeGreaterThanOrEqual(0);
  expect(g.right, JSON.stringify(g)).toBeLessThanOrEqual(g.vw);
  expect(g.bodyOverflow, `no sideways scroll inside the card: ${JSON.stringify(g)}`).toBeLessThanOrEqual(0);
  expect(g.docOverflow, `no sideways page scroll: ${JSON.stringify(g)}`).toBeLessThanOrEqual(0);
});
