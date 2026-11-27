// @ts-check
//
// OPENING AN EVENT ON A SHORT SCREEN KEEPS ITS HEADER IN VIEW, AND OPENING
// ANOTHER EVENT IS ANNOUNCED (ui/nav.js route focus; features/event-workspace.js).
//
// A route change moves focus to where the person arrived (`_focusAdminTab`),
// and focus() scrolls its target into view. The workspace's Overview took focus
// on its own visually hidden heading, which sits BELOW the event's header, the
// KPI band and the section tabs: on a phone held sideways (750x340, 780x360)
// opening an event scrolled the page 300-400 px down, and the event's name, its
// status, the join pill, Invite and the ⋯ menu ended up above the screen. The
// Overview's route focus is the event's name (#ws-title, the pane's
// `data-route-focus`), so the header stays in view; every other section keeps
// its own heading.
//
// A route is the PLACE: the pane and the event it shows. Opening ANOTHER event
// while an Overview is on screen (the command palette, a report link) is a move
// and is announced (focus on the new event's name), while showing the place
// already shown moves nothing, and the panel's own landing (at sign-in, and
// again when a role edit takes its page away) is never announced: it would
// strand the skip link.
//
// Every arm runs with touch and mobile emulation on the shortest screens in the
// device matrix; tests/cross-device.spec.js holds the open on the matrix's two
// landscape phone projects (mobile-webkit-landscape in WebKit,
// mobile-chrome-samsung-landscape in Chromium); Firefox has no phone project.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, waitForAdminPage } = require("./helpers");
const { loginViaApi, adminLogin } = require("./ui-admin-helpers");
const { H, makeCompetition, makeParticipant } = require("./event-admin-helpers");
const { openPalette } = require("./chrome-helpers");

test.use({ baseURL: BASE, viewport: { width: 750, height: 340 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

const OVERVIEW = "admin-event-overview-tab";
const F = {};   // this file's own events, role and people

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    F.a = await makeCompetition(sa, csrf, "wsf-a");
    F.b = await makeCompetition(sa, csrf, "wsf-b");
    // Enough live events that the Events list scrolls on a 340 px screen.
    F.fill = [];
    for (let i = 0; i < 5; i++) F.fill.push(await makeCompetition(sa, csrf, `wsf-fill${i}`));
    // A role whose landing is not the Events pane: its first page (People) is
    // opened by the panel itself at sign-in, which nobody asked for.
    const rr = await sa.post("/api/admin/roles", { headers: H(csrf), data: { label: `WSF desk ${Date.now()}`, scope_mode: "all", permissions: ["participants.view", "groups.view"] } });
    expect(rr.ok(), `create role: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    F.role = (await rr.json()).role;
    F.desk = await makeParticipant(sa, csrf, "wsfdesk");
    const gr = await sa.patch(`/api/admin/users/${F.desk.id}/role`, { headers: H(csrf), data: { role: F.role.id } });
    expect(gr.ok(), `assign the role: ${gr.status()} ${await gr.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
});

test.afterAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    for (const c of [F.a, F.b, ...(F.fill || [])].filter(Boolean)) await api.delete(`/api/admin/competitions/${c.id}`, { headers: H(csrf) }).catch(() => {});
  } finally { await api.dispose(); }
});

/** Sign the superadmin in and wait until the Events model holds every event named. */
async function signIn(page, events) {
  await adminLogin(page);
  await waitForAdminPage(page);
  await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id)), events.map((e) => e.id)),
    { timeout: 20000, message: "PRECONDITION: the Events model holds this file's events" }).toBe(true);
}

/** Where the header's parts lie, against the screen and the sticky app header. */
function headerGeometry(page) {
  return page.evaluate((ov) => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) };
    };
    const a = document.activeElement;
    return {
      vh: window.innerHeight, vw: document.documentElement.clientWidth, scrollY: Math.round(window.scrollY),
      headerBottom: Math.round(document.getElementById("app-header").getBoundingClientRect().bottom),
      active: a ? (a.id || `${a.tagName.toLowerCase()}.${[...a.classList].join(".")}`) : null,
      title: box("#ws-title"), invite: box('#ws-quick [data-action="ws-invite"]'), more: box("#ws-quick .ws-more-btn"),
      ownHeading: box(`#${ov} h2`),
    };
  }, OVERVIEW);
}

/** The part lies wholly on screen, below the sticky app header. */
function onScreen(g, part) {
  const b = g[part];
  return !!b && b.h > 0 && b.top >= g.headerBottom - 1 && b.bottom <= g.vh + 1 && b.left >= -1 && b.right <= g.vw + 1;
}

/** Focus is on the open event's name, and its name, Invite and ⋯ are on screen. */
async function expectHeaderInView(page, ev, label) {
  await expect(page.locator("#ws-title"), `${label}: the workspace is the event's`).toHaveText(ev.name, { timeout: 15000 });
  await expect(page.locator(`#${OVERVIEW}`), `${label}: on its Overview`).toBeVisible();
  await expect(page.locator("#ws-title"), `${label}: focus is on the event's name`).toBeFocused();
  const g = await headerGeometry(page);
  for (const part of ["title", "invite", "more"]) expect(onScreen(g, part), `${label}: the header's ${part} is on screen below the app header — ${JSON.stringify(g)}`).toBe(true);
  return g;
}

/** Press an Events row's name, the list's own door (at these widths the rows
 *  are cards and the Open button gives way to the row's ⋮ menu). */
async function pressOpen(page, ev) {
  const cell = page.locator(`#admin-comp-body td.ev-name-cell[data-comp-id="${ev.id}"]`);
  await expect(cell, `PRECONDITION: the Events list offers ${ev.name}`).toBeVisible({ timeout: 15000 });
  await cell.click();
}

test.describe("workspace route focus on a short screen", () => {
  for (const vp of [{ width: 750, height: 340 }, { width: 780, height: 360 }]) {
    test(`opened from the Events list at ${vp.width}x${vp.height}, focus is on the event's name and its header is on screen (the Overview's own heading is below the screen: the premise)`, async ({ page }) => {
      await page.setViewportSize(vp);
      await signIn(page, [F.a]);
      await pressOpen(page, F.a);
      const g = await expectHeaderInView(page, F.a, `open from the list at ${vp.width}x${vp.height}`);
      // THE PREMISE: the Overview's own (visually hidden) heading lies below the
      // screen's bottom edge, so focusing it, as the Overview once did, scrolls
      // the header away — the defect is reachable at this size.
      expect(g.ownHeading && g.ownHeading.top > g.vh, `the Overview's own heading is below the screen — ${JSON.stringify(g)}`).toBe(true);
    });
  }

  test("opened from an Events list scrolled down first, the page comes back to the event's header", async ({ page }) => {
    await signIn(page, [F.a, ...F.fill]);
    // This file's event whose row the list draws last, scrolled to the bottom
    // edge of the screen.
    const ids = F.fill.map((e) => e.id);
    await expect.poll(() => page.evaluate((ids) => ids.filter((id) => document.querySelector(`#admin-comp-body td.ev-name-cell[data-comp-id="${id}"]`)).length, ids),
      { timeout: 15000, message: "PRECONDITION: the list draws every filler event" }).toBe(ids.length);
    const lastId = await page.evaluate((ids) => {
      const cells = [...document.querySelectorAll("#admin-comp-body td.ev-name-cell")].filter((td) => ids.includes(td.dataset.compId));
      const td = cells[cells.length - 1];
      td.scrollIntoView({ block: "end" });
      return td.dataset.compId;
    }, ids);
    expect(await page.evaluate(() => window.scrollY), "PRECONDITION: the Events list is scrolled well down").toBeGreaterThan(300);
    const ev = F.fill.find((e) => e.id === lastId);
    await pressOpen(page, ev);
    await expectHeaderInView(page, ev, "open from a scrolled list");
  });

  test("a section switch focuses that section's heading; back on the Overview focus is on the event's name and the header is on screen", async ({ page }) => {
    await signIn(page, [F.a]);
    await pressOpen(page, F.a);
    await expectHeaderInView(page, F.a, "open");
    // The phone's Section sheet (the tab strip's door at this width).
    await page.locator("#ws-section-pick").click();
    await page.locator('#ws-section-sheet [data-section="admin-participants-tab"]').click();
    await expect(page.locator("#admin-participants-tab h2"), "Participants: its own heading takes focus").toBeFocused();
    // Scrolled down in the section, then back to the Overview.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY), "PRECONDITION: the section is scrolled down").toBeGreaterThan(100);
    await page.locator("#ws-section-pick").click();
    await page.locator(`#ws-section-sheet [data-section="${OVERVIEW}"]`).click();
    await expectHeaderInView(page, F.a, "back on the Overview");
  });

  test("leaving an event's Participants for the People page is a move too: the same pane, another place, and its heading takes focus", async ({ page }) => {
    await signIn(page, [F.a]);
    await pressOpen(page, F.a);
    await expectHeaderInView(page, F.a, "open");
    await page.locator("#ws-section-pick").click();
    await page.locator('#ws-section-sheet [data-section="admin-participants-tab"]').click();
    await expect(page.locator("#admin-participants-tab h2"), "PRECONDITION: the event's Participants section is announced").toBeFocused();
    // The sidebar's People item, through the phone's drawer: the drawer hands
    // focus back to the section bar as it closes, so the heading takes it again
    // only if this move is announced.
    await page.locator("#admin-mobile-menu-btn").click();
    await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
    await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
    await expect(page.locator("#admin-workspace"), "the People page is every event's: the workspace closed").toBeHidden();
    await expect(page.locator("#admin-participants-tab"), "on the People page").toBeVisible();
    await expect(page.locator("#admin-participants-tab h2"), "the People page's heading takes focus").toBeFocused();
  });

  test("opening another event from the palette while an Overview shows focuses the new event's name; showing the same Overview again moves nothing (control)", async ({ page }) => {
    await signIn(page, [F.a, F.b]);
    await pressOpen(page, F.a);
    await expectHeaderInView(page, F.a, "the first event");
    // CONTROL (the place already shown is not announced again): the same
    // event's Overview rendered again leaves focus where the person put it.
    await page.locator('#ws-quick [data-action="ws-invite"]').focus();
    await page.evaluate(({ id, n, tab }) => window.openEventWorkspace(id, n, { tab }), { id: F.a.id, n: F.a.name, tab: OVERVIEW });
    await expect(page.locator('#ws-quick [data-action="ws-invite"]'), "showing the same Overview again moves no focus").toBeFocused();
    // Another event, from the command palette.
    await openPalette(page);
    await page.locator("#cp-input").fill(F.b.name);
    const opt = page.locator("#cp-list .cp-opt", { hasText: F.b.name }).first();
    await expect(opt, "the palette offers the second event").toBeVisible({ timeout: 10000 });
    await opt.click();
    await expect(page.locator("#command-palette-overlay")).toHaveCount(0);
    await expectHeaderInView(page, F.b, "another event from the palette");
  });

  test("the panel's own landing moves no focus, at sign-in and when a role edit takes its page away; a page the person opens is announced (control)", async ({ page }) => {
    await loginViaApi(page, F.desk.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page);
    await expect(page.locator("#admin-participants-tab"), "the landing is the role's first page (People)").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#admin-competitions-tab"), "never the Events pane").toBeHidden();
    // The landing is complete (its read answered) before focus is read.
    await expect(page.locator("#admin-participants-body tr").first()).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(() => document.activeElement === document.body), "the sign-in landing leaves focus on the document, not the pane's heading").toBe(true);
    // CONTROL: a page the person opens IS announced (focus routing works here).
    await page.locator("#admin-mobile-menu-btn").click();
    await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
    await page.locator('.admin-nav-item[data-tab-id="admin-groups-tab"]').click();
    await expect(page.locator("#admin-groups-tab h2"), "the Groups page's heading takes focus").toBeFocused();
    // A role edit takes Groups away: the next nav build re-reads the role and
    // the panel lands on the role's first page again (`_relandIfPaneRefused`),
    // which nobody asked for either.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const live = (await (await sa.get("/api/admin/roles")).json()).roles.find((r) => r.id === F.role.id);
      expect(live && live.permissions, "PRECONDITION: the role still opens People and Groups").toEqual(expect.arrayContaining(["groups.view", "participants.view"]));
      const ed = await sa.put(`/api/admin/roles/${F.role.id}`, { headers: H(csrf), data: { permissions: ["participants.view"], expectedVersion: live.version } });
      expect(ed.ok(), `edit the role: ${ed.status()} ${await ed.text()}`).toBeTruthy();
    } finally { await sa.dispose(); }
    await page.evaluate(() => window.buildAdminNav());
    await expect(page.locator("#admin-participants-tab"), "the re-landing shows the role's remaining page").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#admin-groups-tab")).toBeHidden();
    expect(await page.evaluate(() => document.activeElement === document.querySelector("#admin-participants-tab h2")), "the re-landing does not take focus to the pane's heading").toBe(false);
  });
});
