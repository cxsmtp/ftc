"use strict";

// EVERY LOOK, ON THE APP'S OWN SCREENS: axe, day and night.
//
// The token generator (scripts/build-theme-tokens.js) measures token PAIRS. A
// hand-written rule combines tokens in pairs it never measures (an ink on a
// tinted fill, a chip on a card), and every look resolves them to different
// colours, so a look can drop a real screen below AA with every generated pair
// passing. The other axe gates scan the app in the house look alone (Ambient:
// tests/ui-*.spec.js by day, tests/dark-theme-a11y.spec.js by night), and the
// per-look scan there covers only the sign-in screen, its code step and the
// look picker. This scans the screens people work in, in each look the
// generator defines (scripts/theme/looks.js), day and night:
//   • the organiser's Events list (live, upcoming and late-entry badges), the
//     Challenge library, People, Live rankings and a live event's workspace;
//   • the participant's event list, challenge list and leaderboard.
// The look and the mode are ASSERTED before each scan (data-look, data-theme
// and the look's own --bg), so a scan that silently ran in the house look
// cannot pass for the look it names. Each screen is scanned once its own rows
// are on it, never on an empty pane.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, settleFiniteAnimations } = require("./helpers");
const { adminLogin, loginViaApi, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const AxeBuilder = require("@axe-core/playwright").default;
const { looks } = require("../scripts/theme/looks");

test.use({ baseURL: BASE });

let fx;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const s = await apiLogin("superadmin");
  try {
    // The entry clock: the participant's own row is on the board (the scan reads
    // it) from entering, without opening a challenge; this file is about colour,
    // not about when a clock starts.
    const live = await makeCompetition(s.api, s.csrf, "looks-live", { clock_start: "entry" });
    const late = await makeCompetition(s.api, s.csrf, "looks-late", { event_kind: "booth" });
    const upcoming = await makeCompetition(s.api, s.csrf, "looks-upc", { start_time: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    // Two challenges nobody solves keep the live event live (fixture item 1).
    for (const label of ["looks-a", "looks-b"]) {
      const t = await makeTask(s.api, s.csrf, label);
      await assignTask(s.api, s.csrf, t.id, [live.id]);
    }
    const r = await s.api.post(`/api/admin/competitions/${late.id}/end-now`, { headers: H(s.csrf), data: {} });
    expect(r.ok(), `end now: ${r.status()} ${await r.text()}`).toBeTruthy();
    const rows = await (await s.api.get("/api/admin/competitions")).json();
    const st = (id) => { const c = rows.find((x) => x.id === id); return [c.status, !!c.late_entry_window_open]; };
    expect(st(live.id), "PRECONDITION: a live event").toEqual(["live", false]);
    expect(st(late.id), "PRECONDITION: an ended booth in its late-entry window").toEqual(["ended", true]);
    expect(st(upcoming.id), "PRECONDITION: an upcoming event").toEqual(["upcoming", false]);
    fx = { live, late, upcoming };
  } finally { await s.api.dispose(); }
});

const COMBOS = Object.keys(looks).flatMap((id) => ["light", "dark"].map((mode) => ({ id, mode })));

/** A fresh browser in this look and mode (its own choice, as Appearance stores it). */
async function inLook(browser, { id, mode }) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, colorScheme: mode, reducedMotion: "reduce" });
  await ctx.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) { /* no storage */ } }, [id, mode]);
  return ctx;
}

/** Assert the page wears this look and mode, then scan `sel`; returns readable violations. */
async function scan(page, sel, what, { id, mode }) {
  const got = await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme,
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()]);
  expect(got, `${what} ${id}/${mode}: the page really is in this look and mode`).toEqual([id, mode, looks[id][mode].bg.toLowerCase()]);
  await settleFiniteAnimations(page);
  const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
  return (r.violations || []).filter((v) => AXE_GATED_IMPACTS.has(v.impact)).flatMap((v) => v.nodes.map((n) =>
    `${what} ${id}/${mode}: [${v.impact}] ${v.id} — ${(n.target || []).join(" ")}\n      ${(n.failureSummary || "").replace(/\s+/g, " ").slice(0, 220)}`));
}

/** Open an admin section by its sidebar item and wait for its own content. */
async function section(page, tabId, ready) {
  await page.evaluate((t) => window.adminTab(document.querySelector(`.admin-nav-item[data-tab-id="${t}"]`), t), tabId);
  await page.locator(`#${tabId}`).waitFor({ state: "visible", timeout: 15000 });
  await ready();
}

test.describe("every look, on the app's own screens", () => {
  for (const combo of COMBOS) {
    test(`the organiser's and the participant's screens are clean in ${combo.id}, ${combo.mode}`, async ({ browser }) => {
      test.setTimeout(150_000);
      const bad = [];
      // This test's own participant, in the live and the upcoming event (two, so
      // the list is shown rather than the sole-event landing). Made before the
      // organiser's browser sign-in, which ends every superadmin API session.
      const s = await apiLogin("superadmin");
      let p;
      try {
        p = await makeParticipant(s.api, s.csrf, `looks${combo.id}${combo.mode}`);
        await enrol(s.api, s.csrf, fx.live.id, [p.id]);
        await enrol(s.api, s.csrf, fx.upcoming.id, [p.id]);
      } finally { await s.api.dispose(); }

      const org = await inLook(browser, combo);
      try {
        const page = await org.newPage();
        await adminLogin(page);
        await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
        await section(page, "admin-competitions-tab", async () => {
          await expect(page.locator("#admin-competitions-tab"), "the Events list shows this file's events").toContainText(fx.live.name, { timeout: 15000 });
          await expect(page.locator("#admin-competitions-tab"), "including the late-entry one").toContainText(fx.late.name);
        });
        await expect(page.locator("#admin-competitions-tab .status-badge.late-entry").first(),
          "PRECONDITION: a late-entry badge is on the scanned list").toBeVisible();
        bad.push(...await scan(page, "#admin-competitions-tab", "Events", combo));
        await section(page, "admin-tasks-tab", () => expect(page.locator("#admin-task-body tr").first()).toBeVisible({ timeout: 15000 }));
        bad.push(...await scan(page, "#admin-tasks-tab", "Challenge library", combo));
        await section(page, "admin-participants-tab", () => expect(page.locator("#admin-participants-body tr").first()).toBeVisible({ timeout: 15000 }));
        bad.push(...await scan(page, "#admin-participants-tab", "People", combo));
        await section(page, "admin-rankings-tab", () => expect(page.locator("#admin-rankings-tab"), "the live event is on the rankings page").toContainText(fx.live.name, { timeout: 15000 }));
        bad.push(...await scan(page, "#admin-rankings-tab", "Live rankings", combo));
        await page.evaluate(({ i, n }) => window.openEventWorkspace(i, n), { i: fx.live.id, n: fx.live.name });
        await expect(page.locator("#ws-title")).toHaveText(fx.live.name, { timeout: 15000 });
        await page.locator("#ws-overview .ws-card").first().waitFor({ state: "visible", timeout: 15000 });
        bad.push(...await scan(page, "#admin-page", "Workspace", combo));
      } finally { await org.close(); }

      const part = await inLook(browser, combo);
      try {
        const page = await part.newPage();
        await loginViaApi(page, p.email, PARTICIPANT_PASS);
        await page.goto("/");
        await expect(page.locator(`#comp-grid .comp-card[data-comp-id="${fx.live.id}"]`), "the event list shows the participant's events").toBeVisible({ timeout: 30000 });
        bad.push(...await scan(page, "#competitions-page", "Event list", combo));
        const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
        const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: fx.live.id } });
        expect(sel.ok(), `select: ${sel.status()}`).toBeTruthy();
        await page.goto("/");
        await expect(page.locator("#task-grid [data-task-id]").first(), "the challenge list shows the event's challenges").toBeVisible({ timeout: 30000 });
        bad.push(...await scan(page, "#tasks-page", "Challenge list", combo));
        await page.locator("#nav-leaderboard").click();
        await expect(page.locator("#leaderboard-page"), "the leaderboard shows").toBeVisible({ timeout: 15000 });
        await expect(page.locator("#leaderboard-page")).toContainText(p.nickname, { timeout: 15000 });
        bad.push(...await scan(page, "#leaderboard-page", "Leaderboard", combo));
      } finally { await part.close(); }

      expect(bad, `moderate+ axe violations:\n  ${bad.join("\n  ")}`).toEqual([]);
    });
  }
});
