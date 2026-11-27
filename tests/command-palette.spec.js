"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// THE COMMAND PALETTE (features/command-palette.js): the signed-in header's
// Search button and Ctrl/⌘+K.
//
//   • it opens from the keyboard and from the button, focus lands in the box,
//     Escape closes it and focus returns to the opener; a press outside its
//     panel closes it (a search, not a form: operator ruling, 14 Nov 2026) and a
//     press inside it does not;
//   • ROLE GATING, by value: a participant's palette holds no organiser page or
//     action; an event admin's holds no superadmin page (Settings), no
//     global-admin page (Roles & permissions) and no global-admin action (New event,
//     New template, the platform exports), and lists only their own event — each
//     beside a superadmin CONTROL that does see them, so an empty or broken
//     palette cannot pass the negative arms;
//   • INSIDE AN EVENT WORKSPACE: its sections and its ⋯ menu's safe doors are
//     offered, never the irreversible ones (End now, Delete event), which the ⋯
//     menu itself does hold (the control); an Actions item runs; Invite is the
//     header's own predicate (not on an ended event, nor for a competitor); a
//     recent door the role no longer has is not brought back; an event's status
//     reads as on the Events list (Late entry open);
//   • a participant's jump to one of their events opens it even when the list's
//     filter hides its card (an ended event), and from inside another event the
//     leave is answered before the new event is selected;
//   • Ctrl+K does nothing while the profile-completion gate is up;
//   • Enter on "Question bank" navigates there (asserted by the pane shown
//     and the sidebar's aria-current, with the Events pane as the start state);
//   • a Help result opens the help drawer AT that heading (the heading is in
//     the drawer's viewport and the drawer is not at its top);
//   • at 390 px it is a full-screen sheet with no horizontal overflow;
//   • axe finds no gated-impact violation in it.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, waitForAdminPage } = require("./helpers");
const { loginViaApi, adminLogin, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { buildWorld, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const { openPalette } = require("./chrome-helpers");

test.use({ baseURL: BASE });

let W = null;          // the event-admin world (mine / theirs / ea / …)
let P = null;          // a participant enrolled in two events of their own
test.beforeAll(async () => {
  test.setTimeout(120_000);
  W = await buildWorld();
  const p = await makeParticipant(W.sa, W.saCsrf, "palette");
  const a = await makeCompetition(W.sa, W.saCsrf, "pal-a");
  const b = await makeCompetition(W.sa, W.saCsrf, "pal-b");
  await enrol(W.sa, W.saCsrf, a.id, [p.id]);
  await enrol(W.sa, W.saCsrf, b.id, [p.id]);
  P = { ...p, events: [a, b] };
});
test.afterAll(async () => {
  if (W) { for (const k of ["sa", "eaApi", "zeroApi"]) { try { await W[k].dispose(); } catch (_) { /* gone */ } } }
});

/** Every option the palette shows for `query`: [{section, label}]. */
async function options(page, query) {
  const input = page.locator("#cp-input");
  await input.fill(query);
  return page.evaluate(() => [...document.querySelectorAll("#cp-list .cp-group")].flatMap((g) => {
    const section = g.querySelector(".cp-group-h").textContent.trim();
    return [...g.querySelectorAll(".cp-opt")].map((o) => ({ section, label: o.querySelector(".cp-label").textContent.trim() }));
  }));
}
const labels = (opts, section) => opts.filter((o) => !section || o.section === section).map((o) => o.label);

async function signInParticipant(page) {
  await loginViaApi(page, P.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 60000 });
  await expect(page.locator("#app-search-btn")).toBeVisible({ timeout: 20000 });
}
async function signInEventAdmin(page) {
  await loginViaApi(page, W.ea.email, PARTICIPANT_PASS);
  await page.goto("/");
  await waitForAdminPage(page);
  // The events model the Events section reads, and the nav builder's hides.
  await expect.poll(() => page.evaluate(() => (window.S.adminCompetitionsData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
}
async function signInSuperadmin(page) {
  await adminLogin(page);
  await waitForAdminPage(page);
  await expect.poll(() => page.evaluate(() => (window.S.adminCompetitionsData || []).length), { timeout: 20000 }).toBeGreaterThan(0);
}

test.describe("command palette", () => {
  test("Ctrl+K opens it with focus in the box; Escape closes it and focus returns to the opener", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInSuperadmin(page);
    await page.locator("#app-search-btn").focus();
    await page.keyboard.press("Control+k");
    const overlay = page.locator("#command-palette-overlay");
    await expect(overlay).toBeVisible();
    await expect(page.locator("#cp-input"), "focus is in the search box").toBeFocused();
    await expect(overlay.locator("[role=dialog]")).toHaveAttribute("aria-modal", "true");
    // Arrow keys move the active option, mirrored on aria-activedescendant.
    const first = await page.locator("#cp-input").getAttribute("aria-activedescendant");
    await page.keyboard.press("ArrowDown");
    const second = await page.locator("#cp-input").getAttribute("aria-activedescendant");
    expect(first && second && first !== second, `ArrowDown moved the active option (${first} → ${second})`).toBe(true);
    await expect(page.locator(`#${second}`)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(page.locator("#app-search-btn"), "focus returns to the opener").toBeFocused();
    // The Search button opens it too.
    await openPalette(page);
    await expect(page.locator("#cp-input")).toBeFocused();
  });

  test("a press outside the palette's panel closes it; a press inside the panel does not", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInSuperadmin(page);
    await openPalette(page);
    const overlay = page.locator("#command-palette-overlay");
    await expect(overlay).toBeVisible();
    // CONTROL: a press inside the panel, on its search box, keeps it open.
    await page.locator("#cp-input").click();
    await expect(overlay, "a press inside the panel keeps it open").toBeVisible();
    const b = await overlay.locator(".cp-panel").boundingBox();
    const pt = { x: 24, y: 870 };
    expect(pt.x < b.x || pt.x > b.x + b.width || pt.y < b.y || pt.y > b.y + b.height,
      `PRECONDITION: the press point lies outside the panel ${JSON.stringify(b)}`).toBe(true);
    await page.mouse.click(pt.x, pt.y);
    await expect(overlay, "a press outside the panel closes it").toHaveCount(0);
  });

  test("Enter on 'Question bank' goes there", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInSuperadmin(page);
    await expect(page.locator("#admin-tasks-tab"), "PRECONDITION: the library is not already showing").toBeHidden();
    await openPalette(page);
    const opts = await options(page, "question bank");
    expect(labels(opts, "Go to")[0], `the best match first: ${JSON.stringify(opts)}`).toBe("Question bank");
    await page.keyboard.press("Enter");
    await expect(page.locator("#command-palette-overlay")).toHaveCount(0);
    await expect(page.locator("#admin-tasks-tab")).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.admin-nav-item[data-tab-id="admin-tasks-tab"]')).toHaveAttribute("aria-current", "page");
  });

  test("role gating: an event admin never sees superadmin or global-admin doors, nor another organiser's event (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // CONTROL: the superadmin sees every door the event admin must not.
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await signInSuperadmin(sp);
      await openPalette(sp);
      const all = await options(sp, "");
      // RBAC sidebar — Logs has no sidebar item (Audit's Raw logs); Roles & permissions
      // carries the same tier signal (every global admin, never an event admin).
      for (const want of ["Settings", "Roles & permissions", "Question bank", "People"]) expect(labels(all, "Go to"), `CONTROL: the superadmin's Go to has ${want}`).toContain(want);
      for (const want of ["New event", "New template", "Export people (CSV)", "New question"]) expect(labels(all, "Actions"), `CONTROL: the superadmin's Actions has ${want}`).toContain(want);
      const ev = await options(sp, W.theirs.name);
      expect(labels(ev, "Events"), "CONTROL: the superadmin finds the decoy event").toContain(W.theirs.name);
    } finally { await ctx.close(); }

    await signInEventAdmin(page);
    await openPalette(page);
    const opts = await options(page, "");
    const go = labels(opts, "Go to"), acts = labels(opts, "Actions");
    expect(go, "POSITIVE: the event admin's own pages are offered").toContain("Events");
    expect(go).toContain("Question bank");
    expect(acts, "POSITIVE: an action they may take").toContain("New question");
    for (const gone of ["Settings", "Roles & permissions"]) expect(go, `${gone} is not an event admin's page`).not.toContain(gone);
    for (const gone of ["New event", "New template", "Export people (CSV)", "Export challenges"]) expect(acts, `${gone} is not an event admin's action`).not.toContain(gone);
    // Typing never surfaces them either (they are not merely ranked out).
    // "New event" is ALSO the sidebar page where every event starts; an event
    // admin legitimately goes there (they start events from templates), so for
    // the two create doors only the Actions entry is withheld.
    for (const [q, door, sections] of [["settings", "Settings", ["Go to", "Actions"]], ["roles", "Roles & permissions", ["Go to", "Actions"]], ["new event", "New event", ["Actions"]], ["new template", "New template", ["Go to", "Actions"]]]) {
      const hit = await options(page, q);
      expect(hit.filter((o) => sections.includes(o.section)).map((o) => o.label), `"${q}" finds no ${door}`).not.toContain(door);
    }
    const mine = await options(page, W.mine.name);
    expect(labels(mine, "Events"), "POSITIVE: their own event").toContain(W.mine.name);
    const theirs = await options(page, W.theirs.name);
    expect(labels(theirs, "Events"), "another organiser's event is not listed").not.toContain(W.theirs.name);
  });

  test("role gating: a participant sees no organiser door, and finds their own events and their guide", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInParticipant(page);
    await openPalette(page);
    const opts = await options(page, "");
    expect(labels(opts, "Go to"), "POSITIVE: the participant's pages").toEqual(expect.arrayContaining(["Events", "Profile", "Appearance"]));
    const all = opts.map((o) => o.label);
    for (const gone of ["Question bank", "People", "Settings", "Roles & permissions", "Templates", "Groups", "Teams", "Live rankings", "New event", "New question", "Invite people", "Sign up at the desk", "Switch to Participant View", "Switch to Admin View"]) {
      expect(all, `${gone} is not a participant's`).not.toContain(gone);
    }
    for (const q of ["library", "settings", "new event", "invite"]) {
      const hit = await options(page, q);
      expect(hit.filter((o) => o.section === "Go to" || o.section === "Actions").map((o) => o.label), `"${q}" finds no organiser door`).toEqual([]);
    }
    const ev = await options(page, P.events[1].name);
    expect(labels(ev, "Events"), "their own event by name").toContain(P.events[1].name);
    const decoy = await options(page, W.theirs.name);
    expect(labels(decoy, "Events"), "an event they are not in is not listed").not.toContain(W.theirs.name);
    // The guide's headings arrive (fetched through the drawer's pipeline).
    await page.locator("#cp-input").fill("time on platform");
    await expect(page.locator("#cp-list .cp-opt", { hasText: "Time on platform" }).first(), "a Help result from participant.md").toBeVisible({ timeout: 15000 });
  });

  test("a Help result opens the help drawer at that heading", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInParticipant(page);
    await openPalette(page);
    // A heading in the MIDDLE of the guide, so "at the heading" means the top
    // of the drawer (the guide's last sections can only scroll to the end).
    await page.locator("#cp-input").fill("hints");
    const hit = page.locator("#cp-list .cp-opt", { hasText: "5. Hints" }).first();
    await expect(hit).toBeVisible({ timeout: 15000 });
    await expect(hit.locator(".cp-hint")).toHaveText("Participant guide");
    await hit.click();
    await expect(page.locator("#command-palette-overlay")).toHaveCount(0);
    const target = page.locator('#help-drawer-body [id="5-hints"]');
    await expect(target, "the drawer rendered the guide").toBeAttached({ timeout: 15000 });
    // Polled: screenshots above the heading decode late, and the drawer
    // re-aligns as each one lands.
    await expect.poll(() => page.evaluate(() => {
      const body = document.getElementById("help-drawer-body"), h = document.getElementById("5-hints");
      const b = body.getBoundingClientRect(), r = h.getBoundingClientRect();
      return { scrolled: body.scrollTop > 200, atTop: r.top >= b.top - 2 && r.top < b.top + 80 };
    }), { message: "the drawer opened at the heading, not at its top", timeout: 10000 }).toEqual({ scrolled: true, atTop: true });
  });

  test("at 390 px it is a full-screen sheet with no horizontal overflow, and axe finds nothing gated", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signInParticipant(page);
    await openPalette(page);
    await page.locator("#cp-input").fill("e");
    const g = await page.evaluate(() => {
      const p = document.querySelector(".cp-panel").getBoundingClientRect();
      const list = document.getElementById("cp-list");
      return { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listOverflow: list.scrollWidth - list.clientWidth, opts: list.querySelectorAll(".cp-opt").length };
    });
    expect(g.opts, "PRECONDITION: results rendered").toBeGreaterThan(0);
    expect(g, "full screen").toMatchObject({ x: 0, y: 0, w: 390, h: 844 });
    expect(g.pageOverflow, "no page side-scroll").toBeLessThanOrEqual(0);
    expect(g.listOverflow, "no side-scroll in the results").toBeLessThanOrEqual(0);
    await page.waitForTimeout(150);
    const res = await new AxeBuilder({ page }).include("#command-palette-overlay").analyze();
    const bad = res.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), "axe on the palette").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The palette's doors inside an event, a participant's jumps, and the gate.
// ─────────────────────────────────────────────────────────────────────────────
const { H, makeTask, assignTask, grantEventAdmin } = require("./event-admin-helpers");

/** Every option the palette shows for `query`, with its hint. */
async function optionsWithHints(page, query) {
  await page.locator("#cp-input").fill(query);
  return page.evaluate(() => [...document.querySelectorAll("#cp-list .cp-group")].flatMap((g) => {
    const section = g.querySelector(".cp-group-h").textContent.trim();
    return [...g.querySelectorAll(".cp-opt")].map((o) => ({ section, label: o.querySelector(".cp-label").textContent.trim(),
      hint: (o.querySelector(".cp-hint")?.textContent || "").trim() }));
  }));
}

/** The labels (with hints) one query offers in one section. A query per door,
 *  because an empty query shows each section capped (SECTION_CAP), so a door
 *  past the cap would read as withheld. */
async function offered(page, query, section) {
  return (await optionsWithHints(page, query)).filter((o) => o.section === section);
}

/** Open an event's workspace the way the Events list does, and wait for its header. */
async function openWorkspace(page, ev) {
  await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), ev.id), { timeout: 20000 }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: ev.id, n: ev.name });
  await expect(page.locator("#ws-title")).toHaveText(ev.name, { timeout: 15000 });
  await expect(page.locator("#ws-quick .ws-more-btn")).toBeVisible();
}

let X = null;          // this block's own events and people
test.describe("command palette — inside an event, a participant's jumps, and the gate", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // A session of its own: the browser sign-ins above (one session per
    // principal) ended the world's superadmin API session.
    const { api: sa, csrf: c } = await require("./helpers").apiLogin("superadmin");
    try {
    const live = await makeCompetition(sa, c, "pal-ws-live");
    const ended = await makeCompetition(sa, c, "pal-ws-ended");
    const late = await makeCompetition(sa, c, "pal-ws-late", { event_kind: "booth", self_enroll_enabled: true });
    const compete = await makeCompetition(sa, c, "pal-ws-cmp", { staff_compete: true });
    // A participant in a live event (with a challenge), an ended one and an
    // upcoming one; the ended one is enrolled while live, then ended.
    const p = await makeParticipant(sa, c, "paljump");
    const pLive = await makeCompetition(sa, c, "pal-p-live");
    const pEnded = await makeCompetition(sa, c, "pal-p-ended");
    const pUpc = await makeCompetition(sa, c, "pal-p-upc", { start_time: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    const t = await makeTask(sa, c, "pal-p-live");
    await assignTask(sa, c, t.id, [pLive.id]);
    await enrol(sa, c, pLive.id, [p.id]);
    await enrol(sa, c, pEnded.id, [p.id]);
    await enrol(sa, c, pUpc.id, [p.id]);
    // A competing organiser: an event admin of the staff-compete event who holds a row in it.
    const eaC = await makeParticipant(sa, c, "palcmp");
    await grantEventAdmin(sa, c, compete.id, eaC.id);
    await enrol(sa, c, compete.id, [eaC.id]);
    for (const ev of [ended, late, pEnded]) {
      const r = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(c), data: {} });
      expect(r.ok(), `end now: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    // Preconditions, from the server.
    const rows = await (await sa.get("/api/admin/competitions")).json();
    const row = (id) => rows.find((x) => x.id === id);
    expect(row(ended.id).status, "PRECONDITION: the ended event is ended").toBe("ended");
    expect(!!row(ended.id).late_entry_window_open, "…with no late window (a tournament)").toBe(false);
    expect([row(late.id).status, row(late.id).late_entry_window_open], "PRECONDITION: the booth is ended with its late window open").toEqual(["ended", true]);
    expect(row(pUpc.id).status, "PRECONDITION: the participant's third event is upcoming").toBe("upcoming");
    const cl = await (await require("./helpers").apiLogin(eaC.email, PARTICIPANT_PASS)).api;
    try {
      const mine = (await (await cl.get("/api/admin/competitions")).json()).find((x) => x.id === compete.id);
      expect(mine && mine.competing, "PRECONDITION: the organiser competes in their staff-compete event").toBe(true);
    } finally { await cl.dispose(); }
    X = { live, ended, late, compete, p, pLive, pEnded, pUpc, eaC };
    } finally { await sa.dispose(); }
  });

  test("in a workspace it offers the event's sections and its ⋯ menu's safe doors, never End now or Delete (the ⋯ menu holds them: control); an action runs", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInSuperadmin(page);
    await openWorkspace(page, X.live);
    // CONTROL: the workspace's own ⋯ menu does hold the irreversible doors.
    await page.locator("#ws-quick .ws-more-btn").click();
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator('[data-action="comp-end-now"]')).toHaveText(/End now/);
    await expect(portal.locator('[data-action="comp-delete"]')).toHaveText(/Delete event/);
    await page.keyboard.press("Escape");
    await openPalette(page);
    const here = `In ${X.live.name}`;
    for (const sec of ["Overview", "Settings"]) {
      expect((await offered(page, sec, "Go to")).filter((o) => o.hint === here).map((o) => o.label), `the workspace's ${sec} section`).toContain(sec);
    }
    expect((await offered(page, "invite", "Actions")).find((o) => o.label === "Invite people"), "Invite, to this event").toMatchObject({ hint: `To ${X.live.name}` });
    // The header Invite's second choice (the desk sign-up moved there from the ⋯
    // menu), and no Organisers door (the Overview's card is the one place).
    expect((await offered(page, "desk", "Actions")).find((o) => o.label === "Sign up at the desk"), "the desk sign-up, in this event").toMatchObject({ hint: here });
    expect((await offered(page, "organisers", "Actions")).map((o) => o.label), "no Organisers door").not.toContain("Organisers");
    for (const door of ["Edit settings", "History", "Clone"]) {
      expect((await offered(page, door, "Actions")).filter((o) => o.hint === here).map((o) => o.label), `the ⋯ menu's ${door}`).toContain(door);
    }
    // Stage B (owner ruling, 27 Nov 2026) — the ⋯ menu has no Add from bank (the
    // event's one door is its Questions section's), so neither does the palette.
    for (const door of ["End now", "Delete event", "Add from bank"]) {
      expect((await offered(page, door, "Actions")).map((o) => o.label), `${door} is never offered`).not.toContain(door);
    }
    // An Actions item RUNS: History opens the event's history.
    await page.locator("#cp-input").fill("history");
    await page.locator("#cp-list .cp-opt", { hasText: "History" }).first().click();
    await expect(page.locator("#command-palette-overlay")).toHaveCount(0);
    await expect(page.locator("#hist-overlay"), "the History door ran").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#hist-overlay")).toContainText(X.live.name);
  });

  test("Invite follows the header: none on an ended event (live: control), and an ended event still taking late entries reads 'Late entry open', as on the Events list", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInSuperadmin(page);
    await openWorkspace(page, X.ended);
    await expect(page.locator('#ws-quick .ws-invite-btn'), "PRECONDITION: the header offers no Invite on an ended event").toHaveCount(0);
    await openPalette(page);
    expect((await offered(page, "history", "Actions")).map((o) => o.label), "POSITIVE: the ended event's own doors are offered").toContain("History");
    expect((await offered(page, "invite", "Actions")).map((o) => o.label), "no Invite to an event that takes no new members").not.toContain("Invite people");
    await page.keyboard.press("Escape");
    await openWorkspace(page, X.live);
    await expect(page.locator('#ws-quick .ws-invite-btn'), "CONTROL: a live event's header offers Invite").toHaveCount(1);
    await openPalette(page);
    expect((await offered(page, "invite", "Actions")).map((o) => o.label), "CONTROL: and so does the palette").toContain("Invite people");
    // Each event's status, by the one table the Events list uses.
    const hintOf = async (ev) => (await optionsWithHints(page, ev.name)).find((o) => o.section === "Events" && o.label === ev.name)?.hint;
    expect(await hintOf(X.late), "an ended booth in its late-entry window").toBe("Late entry open");
    expect(await hintOf(X.ended), "CONTROL: an ended event with no window").toBe("Ended");
    expect(await hintOf(X.live), "CONTROL: a live event").toBe("Live");
  });

  test("a competing organiser is offered none of the event's writes, Invite included (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await signInSuperadmin(sp);
      await openWorkspace(sp, X.compete);
      await openPalette(sp);
      for (const door of ["Invite people", "Edit settings"]) {
        expect((await offered(sp, door, "Actions")).map((o) => o.label), `CONTROL: the superadmin (not competing) is offered ${door}`).toContain(door);
      }
    } finally { await ctx.close(); }
    await loginViaApi(page, X.eaC.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page);
    await openWorkspace(page, X.compete);
    await openPalette(page);
    expect((await offered(page, "history", "Actions")).map((o) => o.label), "POSITIVE: a read-only door is still offered").toContain("History");
    for (const gone of ["Invite people", "Add from bank", "Edit settings", "Clone", "Sign up at the desk"]) {
      expect((await offered(page, gone, "Actions")).map((o) => o.label), `${gone} is not a competitor's`).not.toContain(gone);
    }
  });

  test("a recent door the role does not have is not brought back (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const seed = ["go:admin-settings-tab", "act:new-event", "ws:comp-delete", "go:admin-tasks-tab"];
    const seedFn = (ids) => { try { localStorage.setItem("ha:cp-recent", JSON.stringify(ids)); } catch (_) { /* no storage */ } };
    const recent = async (pg) => (await optionsWithHints(pg, "")).filter((o) => o.section === "Recent").map((o) => o.label);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await sp.addInitScript(seedFn, seed);
      await signInSuperadmin(sp);
      await openPalette(sp);
      const r = await recent(sp);
      expect(r, "CONTROL: the superadmin's recents come back").toEqual(expect.arrayContaining(["Settings", "New event", "Question bank"]));
      expect(r, "an irreversible door is never an item, so never a recent").not.toContain("Delete event");
    } finally { await ctx.close(); }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(seedFn, seed);
    await signInEventAdmin(page);
    await openPalette(page);
    const r = await recent(page);
    expect(r, "POSITIVE: a recent the event admin may use").toContain("Question bank");
    for (const gone of ["Settings", "New event", "Delete event"]) expect(r, `${gone} is not brought back for an event admin`).not.toContain(gone);
  });

  test("a participant's jump opens an event the list's filter hides (an ended one), and from inside another event the leave is answered first", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaApi(page, X.p.email, PARTICIPANT_PASS);
    await page.goto("/");
    await expect(page.locator(`#comp-grid .comp-card[data-comp-id="${X.pLive.id}"]`), "PRECONDITION: the event list is showing").toBeVisible({ timeout: 60000 });
    await expect(page.locator(`#comp-grid .comp-card[data-comp-id="${X.pEnded.id}"]`), "PRECONDITION: the default filter hides the ended event's card").toHaveCount(0);
    await openPalette(page);
    await page.locator("#cp-input").fill(X.pEnded.name);
    await page.locator("#cp-list .cp-opt", { hasText: X.pEnded.name }).first().click();
    await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { message: "the ended event opened", timeout: 15000 }).toBe(X.pEnded.id);

    // From INSIDE a live event, jump to the upcoming one. The witness is the
    // order the server sees: the deselect (leaving for the list) is ANSWERED
    // before the new event's select is SENT, so it cannot land after it and
    // forget the event just picked.
    const sel = await page.request.post("/api/select-competition", { headers: H((await (await page.request.get("/api/csrf-token")).json()).csrfToken), data: { competitionId: X.pLive.id } });
    expect(sel.ok(), `select: ${sel.status()}`).toBeTruthy();
    await page.goto("/");
    await expect(page.locator("#nav-challenges:not([aria-disabled=true])"), "PRECONDITION: inside the live event").toBeVisible({ timeout: 60000 });
    const log = [];
    page.on("request", (r) => { const u = new URL(r.url()).pathname; if (/\/api\/(de)?select-competition$/.test(u)) log.push(`sent ${u}`); });
    // "answered" is the response's arrival (its headers): the server has applied
    // that request by then, which is the moment the client's fetch settles.
    page.on("response", (r) => { const u = new URL(r.url()).pathname; if (/\/api\/(de)?select-competition$/.test(u)) log.push(`answered ${u}`); });
    await openPalette(page);
    await page.locator("#cp-input").fill(X.pUpc.name);
    await page.locator("#cp-list .cp-opt", { hasText: X.pUpc.name }).first().click();
    await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { message: "the upcoming event opened", timeout: 15000 }).toBe(X.pUpc.id);
    await expect.poll(() => log.filter((l) => l.startsWith("answered")).length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    // The first four (the pending page re-selects on its own poll later).
    expect(log.slice(0, 4), "the leave is answered before the pick is sent").toEqual(["sent /api/deselect-competition", "answered /api/deselect-competition", "sent /api/select-competition", "answered /api/select-competition"]);
    await expect.poll(async () => (await (await page.request.get("/api/me")).json()).competitionId,
      { message: "the server holds the event just picked", timeout: 10000 }).toBe(X.pUpc.id);
  });

  // THE JUMP WAITS FOR THE LEAVE, THEN RE-ASKS. A card the participant picks
  // while the jump's leave is still unanswered is the later ask: the jump must
  // stand down, not supersede it (its select would drop the card's own answer).
  test("a card picked while the jump's leave is unanswered wins, and the jump stands down (control: with nothing picked, the held jump goes on)", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaApi(page, X.p.email, PARTICIPANT_PASS);
    /** Inside the live event, as a fresh boot finds the participant. */
    const enterLive = async () => {
      const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await page.request.post("/api/select-competition", { headers: H(c), data: { competitionId: X.pLive.id } });
      expect(sel.ok(), `select: ${sel.status()}`).toBeTruthy();
      await page.goto("/");
      await expect(page.locator("#nav-challenges:not([aria-disabled=true])"), "PRECONDITION: inside the live event").toBeVisible({ timeout: 60000 });
    };
    // Every (de)select the page sends is HELD until released, so the order is the test's.
    const held = [];
    const heldNow = () => held.map((r) => { const p = new URL(r.request().url()).pathname; return p.endsWith("/deselect-competition") ? "deselect" : `select ${(r.request().postDataJSON() || {}).competitionId}`; });
    const release = async (what) => {
      const i = heldNow().indexOf(what);
      expect(i, `a held ${what} (held: ${JSON.stringify(heldNow())})`).toBeGreaterThanOrEqual(0);
      const [r] = held.splice(i, 1);
      await r.continue();
    };
    const SELECTS = (u) => /\/api\/(de)?select-competition$/.test(u.pathname);
    const hold = () => page.route(SELECTS, (r) => { held.push(r); });
    const letGo = async () => { await page.unroute(SELECTS); while (held.length) await held.shift().continue().catch(() => {}); };
    const jump = async (ev) => {
      await openPalette(page);
      await page.locator("#cp-input").fill(ev.name);
      await page.locator("#cp-list .cp-opt", { hasText: ev.name }).first().click();
      await expect.poll(heldNow, { message: "the jump's leave is sent and held", timeout: 15000 }).toEqual(["deselect"]);
    };
    // What the jump's own wait sees once the leave is answered: by then its
    // continuation (registered first on the same promise) has run.
    const afterLeave = () => page.evaluate(async () => { await window.S._leaveInFlight; await new Promise((r) => setTimeout(r, 0));
      return { seq: window.S._compSelectSeq, current: window.S.currentCompetitionId }; });

    try {
      // ── CONTROL: nothing is picked while the leave is held; the jump goes on.
      await enterLive();
      await hold();
      await jump(X.pUpc);
      expect(await page.evaluate(() => window.S.currentCompetitionId), "the tab has left the live event").toBeNull();
      await release("deselect");
      await expect.poll(heldNow, { message: "CONTROL: the jump's select is sent once the leave is answered", timeout: 15000 }).toEqual([`select ${X.pUpc.id}`]);
      await release(`select ${X.pUpc.id}`);
      await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { message: "CONTROL: the jump opened its event", timeout: 15000 }).toBe(X.pUpc.id);
      await letGo();

      // ── SUBJECT: a card is picked while the jump's leave is held.
      await enterLive();
      await hold();
      await jump(X.pUpc);
      await page.locator(`#comp-grid .comp-card[data-comp-id="${X.pLive.id}"] .card-open`).click();
      await expect.poll(heldNow, { message: "the card's own select is sent", timeout: 15000 }).toEqual(["deselect", `select ${X.pLive.id}`]);
      const before = await page.evaluate(() => window.S._compSelectSeq);
      await release("deselect");
      const after = await afterLeave();
      expect(after.seq, "the jump made no pick of its own once the leave was answered").toBe(before);
      expect(heldNow(), "and sent no select").toEqual([`select ${X.pLive.id}`]);
      await release(`select ${X.pLive.id}`);
      await expect.poll(() => page.evaluate(() => window.S.currentCompetitionId), { message: "the card's event is the one entered", timeout: 15000 }).toBe(X.pLive.id);
      await expect.poll(async () => (await (await page.request.get("/api/me")).json()).competitionId,
        { message: "the server holds the card's event", timeout: 10000 }).toBe(X.pLive.id);
    } finally { await letGo(); }
  });

  test("Ctrl+K does nothing while the profile-completion gate is up (control: it opens before the gate)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInParticipant(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#command-palette-overlay"), "CONTROL: Ctrl+K opens it with no gate").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#command-palette-overlay")).toHaveCount(0);
    // The real gate (non-dismissible, deliberately on no Escape stack).
    await page.evaluate(() => { window.openProfileCompletionGate(["company"]); });
    const gate = page.locator("#profile-gate-overlay");
    await expect(gate).toBeVisible({ timeout: 15000 });
    await gate.locator("input, select").first().focus();
    await page.keyboard.press("Control+k");
    await page.locator("#app-search-btn").evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator("#command-palette-overlay"), "the palette never opens under the gate").toHaveCount(0);
    expect(await page.evaluate(() => !!document.activeElement.closest("#profile-gate-overlay")), "focus stays in the gate").toBe(true);
  });
});
