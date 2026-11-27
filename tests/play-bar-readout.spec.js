// @ts-check
//
// THE PLAY BAR'S TEXT READOUT (operator ruling, 14 Nov 2026): "12 days left" for
// a Program, "Late entry" for a late entrant, the same at every width.
//
// The challenge view is the focus view: a phone hides the whole app header, and a
// Program's bar draws no time ring (its deadline is weeks out), so before this a
// Program learner on a phone saw no time at all, and a late entrant lost the
// header's Late entry chip. The readout is participant-tasks.js playStatsHtml's
// `.qa-when`, painted by paintWhen on the bar's one-second tick.
//
// Measured, not read off markup: the readout is visible, inside the play bar and
// in its row, with no sideways scroll, at a phone width and a desktop width.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const LE = require("./late-entry-fixture");

test.use({ baseURL: BASE });

const DAY = 86400e3, HOUR = 3600e3;
const WIDTHS = [390, 1440];

/** The readout's geometry against the bar's. */
async function readout(page) {
  return page.evaluate(() => {
    const bar = document.getElementById("qa-playbar");
    const w = bar && bar.querySelector(".qa-when");
    const left = w && w.querySelector(".qa-when-left"), late = w && w.querySelector(".qa-when-late");
    const shown = (el) => !!(el && !el.hidden && el.getClientRects().length && el.getBoundingClientRect().height > 0);
    const b = bar.getBoundingClientRect(), r = w && w.getBoundingClientRect();
    const back = bar.querySelector(".qa-close").getBoundingClientRect();
    return {
      shown: shown(w), left: shown(left) ? left.textContent : null, late: shown(late) ? late.textContent : null,
      ring: shown(bar.querySelector(".qa-gauge")),
      insideBar: !!r && r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
      // One row: the readout's middle is level with the Back key's, and so is
      // every other readout the bar shows (a fifth item must not wrap).
      sameRow: !!r && Math.abs((r.top + r.bottom) / 2 - (back.top + back.bottom) / 2) <= back.height / 2,
      oneRow: [...bar.querySelectorAll(".qa-close, .qa-stats > *")].filter(shown)
        .every((el) => { const e = el.getBoundingClientRect(); return Math.abs((e.top + e.bottom) / 2 - (back.top + back.bottom) / 2) <= back.height / 2; }),
      items: [...bar.querySelectorAll(".qa-close, .qa-stats > *")].filter(shown).length,
      header: shown(document.getElementById("header-timer")),
      sideways: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

async function openFirstChallenge(page, email, taskId) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
  await page.evaluate((id) => window.openTask(id), taskId);
  await page.locator("#task-detail-page.active #qa-playbar").waitFor({ state: "visible", timeout: 15000 });
}

test.describe("the play bar says the time left in words for a Program", () => {
  let fx;
  test.beforeAll(async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      // A Program twelve days and five hours from its deadline; a second, idle
      // participant and two challenges, so nothing can end it under the test.
      const program = await makeCompetition(sa, csrf, "readout-program", {
        event_kind: "program", start_time: new Date(Date.now() - HOUR).toISOString(), timezone: "UTC",
        deadline_at: new Date(Date.now() + 12 * DAY + 5 * HOUR).toISOString(), duration_minutes: undefined,
      });
      const tournament = await makeCompetition(sa, csrf, "readout-tournament");
      const tasks = [];
      for (const label of ["a", "b"]) tasks.push(await makeTask(sa, csrf, `readout-${label}`));
      for (const t of tasks) await assignTask(sa, csrf, t.id, [program.id]);
      const tt = await makeTask(sa, csrf, "readout-t");
      const tt2 = await makeTask(sa, csrf, "readout-t2");
      for (const t of [tt, tt2]) await assignTask(sa, csrf, t.id, [tournament.id]);
      const p = await makeParticipant(sa, csrf, "readout-p");
      const q = await makeParticipant(sa, csrf, "readout-q");
      const idle = await makeParticipant(sa, csrf, "readout-idle");
      await enrol(sa, csrf, program.id, [p.id, idle.id]);
      await enrol(sa, csrf, tournament.id, [q.id, idle.id]);
      fx = { program, tournament, task: tasks[0], ttask: tt, p, q };
    } finally { await sa.dispose(); }
  });

  for (const width of WIDTHS) {
    test(`"12 days left" in the bar of a Program's challenge at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width >= 768 ? 900 : 800 });
      await openFirstChallenge(page, fx.p.email, fx.task.id);
      let m = null;
      await expect.poll(async () => { m = await readout(page); return m.left; }, { timeout: 10000, message: "the readout is painted" })
        .toBe("12 days left");
      expect(m.ring, "a Program's bar draws no ring").toBe(false);
      expect(m.late, "and says nothing about late entry").toBeNull();
      expect(m.insideBar, `the readout sits inside the play bar: ${JSON.stringify(m)}`).toBe(true);
      expect(m.sameRow, `in the bar's row: ${JSON.stringify(m)}`).toBe(true);
      expect(m.oneRow, `Back, the track and the readout share one row: ${JSON.stringify(m)}`).toBe(true);
      expect(m.sideways, "no sideways scroll").toBeLessThanOrEqual(0);
      // On a phone the header steps aside, so the bar is the one place it is said.
      if (width < 760) expect(m.header, "the phone hides the header clock").toBe(false);
    });
  }

  // The score is said once on the challenge view (owner's decision, 27 Nov
  // 2026): the play bar shows it, so the header's score pill steps aside, and
  // comes back on the list (CONTROL).
  test("the header's score pill is hidden where the play bar shows the score, and shown on the list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaApi(page, fx.q.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
    await expect(page.locator("#header-score"), "CONTROL: the list shows the header's score").toBeVisible({ timeout: 15000 });
    await page.evaluate((id) => window.openTask(id), fx.ttask.id);
    await page.locator("#task-detail-page.active #qa-playbar").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#qa-playbar .qa-score"), "PRECONDITION: the bar shows the score").toBeVisible({ timeout: 10000 });
    await expect(page.locator("#header-score"), "the header does not repeat it").toBeHidden();
    await page.locator("#qa-playbar .qa-close").click();
    await expect(page.locator("#header-score"), "back on the list it shows again").toBeVisible({ timeout: 10000 });
  });

  test("CONTROL: a tournament's bar draws its ring and no text readout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openFirstChallenge(page, fx.q.email, fx.ttask.id);
    let m = null;
    await expect.poll(async () => { m = await readout(page); return m.ring; }, { timeout: 10000 }).toBe(true);
    expect(m.shown, `no readout beside the ring: ${JSON.stringify(m)}`).toBe(false);
  });
});

test.describe("the play bar says Late entry while a late entrant plays", () => {
  let fx;
  test.beforeAll(async () => {
    const { api, csrf } = await LE.sa();
    try {
      const { comp, taskIds } = await LE.liveBooth(api, csrf, { tasks: 2 });
      const late = await LE.makeParticipant(api, csrf, LE.uniq());
      const early = await LE.makeParticipant(api, csrf, LE.uniq());
      for (const u of [late, early]) await LE.enrol(api, csrf, comp.id, u.id);
      const end = await LE.expireEvent(comp.id);
      LE.rawSetAssignedAt(comp.id, late.id, new Date(end.getTime() + 5 * 60_000).toISOString());
      LE.rawSetAssignedAt(comp.id, early.id, new Date(end.getTime() - 60 * 60_000).toISOString());
      fx = { comp, taskId: taskIds[0], late, early };
    } finally { await api.dispose(); }
  });

  async function enterAndOpen(page, email) {
    await loginViaApi(page, email, PARTICIPANT_PASS);
    await page.goto("/");
    // The sole event lands straight in; otherwise press its card.
    const inside = page.locator("#nav-challenges:not([aria-disabled=true])");
    const card = page.locator(`#comp-grid [data-comp-id="${fx.comp.id}"] .card-open`).first();
    await expect.poll(async () => (await inside.isVisible().catch(() => false)) || (await card.isVisible().catch(() => false)), { timeout: 30000 }).toBe(true);
    if (!(await inside.isVisible().catch(() => false))) await card.click();
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    await page.evaluate((id) => window.openTask(id), fx.taskId);
    await page.locator("#task-detail-page.active #qa-playbar").waitFor({ state: "visible", timeout: 15000 });
  }

  for (const width of WIDTHS) {
    test(`"Late entry" in the bar beside the ring at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width >= 768 ? 900 : 800 });
      await enterAndOpen(page, fx.late.email);
      let m = null;
      await expect.poll(async () => { m = await readout(page); return m.late; }, { timeout: 15000, message: "the late readout is painted" })
        .toBe("Late entry");
      expect(m.ring, "the ring counts the late window down").toBe(true);
      expect(m.left, "a ring is drawn, so no time in words").toBeNull();
      expect(m.insideBar, `inside the play bar: ${JSON.stringify(m)}`).toBe(true);
      expect(m.sameRow, `in the bar's row: ${JSON.stringify(m)}`).toBe(true);
      expect(m.items, "Back, the track, the ring, the readout and the score").toBe(5);
      expect(m.oneRow, `all five share one row: ${JSON.stringify(m)}`).toBe(true);
      expect(m.sideways, "no sideways scroll").toBeLessThanOrEqual(0);
      if (width < 760) expect(m.header, "the phone hides the header, and with it its Late entry chip").toBe(false);
    });
  }

  test("CONTROL: an ordinary participant of the same ended booth is told nothing about late entry", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await enterAndOpen(page, fx.early.email);
    await expect.poll(() => page.evaluate(() => !!window.S && window.S.hackathonEnded), { timeout: 20000, message: "their event has ended" }).toBe(true);
    const m = await readout(page);
    expect(m.late, JSON.stringify(m)).toBeNull();
    expect(m.shown, JSON.stringify(m)).toBe(false);
  });
});
