// @ts-check
//
// The challenge play bar's time ring, and the events page's progress strip that
// shares its renderer (participant-tasks.js playStatsHtml / paintGauge).
//
// THE RING'S WORDS ADAPT TO WHAT IS LEFT — "3d" over "18h", a clock under a day,
// "42 s" in the final minute — and must sit INSIDE the ring's inner disc at every
// width. Measured as geometry, not markup: every corner of the value's (and the
// unit's) box is within the disc's radius of the ring's centre. A control proves
// the fit is doing the work: unfitted, the long clock overflows the disc.
//
// The strip: a live run the tab has played shows on the events list with the
// same readouts and a Continue button that is on screen without scrolling, and
// pressing Events inside the live event is plain navigation (no confirm).
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const DAY = 86400e3, HOUR = 3600e3, MIN = 60e3;
const CASES = [
  { rem: 3 * DAY + 18 * HOUR + 5 * MIN, fmt: "days", val: /^3d$/, unit: /^18h$/ },
  { rem: 23 * HOUR + 59 * MIN + 30e3, fmt: "clock", val: /^23:59:\d\d$/, unit: null },
  { rem: 9 * MIN + 30e3, fmt: "clock", val: /^9:\d\d$/, unit: /^left$/ },
  { rem: 42e3, fmt: "secs", val: /^4[0-2] s$/, unit: /^left$/ },
];

let fx;
test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    // TWO challenges and a second, idle participant: nothing can auto-end the
    // event under the test (fixture checklist item 1).
    const comp = await makeCompetition(sa, csrf, "ring", { duration_minutes: 600 });
    const t1 = await makeTask(sa, csrf, "ring-a");
    const t2 = await makeTask(sa, csrf, "ring-b");
    for (const t of [t1, t2]) await assignTask(sa, csrf, t.id, [comp.id]);
    const p = await makeParticipant(sa, csrf, "ring");
    const idle = await makeParticipant(sa, csrf, "ring-idle");
    await enrol(sa, csrf, comp.id, [p.id, idle.id]);
    fx = { comp, t1, t2, p };
  } finally { await sa.dispose(); }
});

async function openChallenge(page) {
  await loginViaApi(page, fx.p.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
  await page.evaluate((id) => window.openTask(id), fx.t1.id);
  await page.locator("#task-detail-page.active #qa-stats .qa-gauge:not([hidden])").waitFor({ state: "visible", timeout: 15000 });
}

/** Set the window's end, wait one tick, and read the ring's geometry. */
function ringAt(page, rem, sel) {
  return page.evaluate(async ([ms, s]) => {
    // @ts-ignore — S keys are live window properties (main.js boot)
    window.hackathonEndTime = new Date(Date.now() + ms);
    await new Promise((r) => setTimeout(r, 1150));
    const g = document.querySelector(s);
    if (!g || g.hidden) return null;
    const r = g.getBoundingClientRect();
    const inner = parseFloat(getComputedStyle(g).getPropertyValue("--qa-inner"));
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width * inner / 2;
    const worst = (el) => {
      if (!el || !el.getClientRects().length) return null;
      const b = el.getBoundingClientRect();
      return Math.max(...[[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]]
        .map(([x, y]) => Math.hypot(x - cx, y - cy)));
    };
    const val = g.querySelector(".qa-gauge-val"), unit = g.querySelector(".qa-gauge-unit");
    const out = { fmt: g.dataset.fmt, val: val.textContent, unit: unit.getClientRects().length ? unit.textContent : null,
      rad, ring: r.width, valW: val.getBoundingClientRect().width, valFs: parseFloat(getComputedStyle(val).fontSize),
      valFar: worst(val), unitFar: worst(unit), unfittedW: null };
    // The control: the same words at the look's own size, unfitted.
    const keep = val.style.fontSize;
    val.style.fontSize = "";
    out.unfittedW = val.getBoundingClientRect().width;
    val.style.fontSize = keep;
    return out;
  }, [rem, sel]);
}

for (const width of [360, 390, 1440]) {
  test(`the ring's words adapt and stay inside the ring at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 800 });
    await openChallenge(page);
    for (const c of CASES) {
      let m = null;
      await expect.poll(async () => { m = await ringAt(page, c.rem, "#qa-stats .qa-gauge"); return m && m.fmt; },
        { timeout: 10000, message: `the ring takes the ${c.fmt} format` }).toBe(c.fmt);
      expect(m.val, `value for ${c.rem} ms`).toMatch(c.val);
      // A phone's ring is smaller and keeps only the days' second line.
      const unitShown = c.unit && (width > 760 || c.fmt === "days");
      if (unitShown) expect(m.unit, `unit for ${c.rem} ms`).toMatch(c.unit);
      else expect(m.unit, "no unit drawn here").toBeNull();
      expect(m.valW, "the value is really drawn").toBeGreaterThan(8);
      expect(m.valFs, "and readable").toBeGreaterThanOrEqual(8);
      expect(m.valFar, `value ${m.val} inside the disc (r=${m.rad.toFixed(1)}): ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.rad + 1);
      if (m.unitFar != null) expect(m.unitFar, `unit inside the disc: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.rad + 1);
      if (c.fmt === "clock" && !c.unit) {
        expect(m.unfittedW, "CONTROL: unfitted, the long clock is wider than the value is drawn — the fit did the work")
          .toBeGreaterThan(m.valW + 1);
      }
    }
    // One clock: the header's countdown steps aside while a challenge is open.
    await expect(page.locator("#header-timer")).toBeHidden();
    // Back is a 44 px close key named for what it does.
    const close = page.getByRole("button", { name: "Back to Challenges" });
    await expect(close).toBeVisible();
    const b = await close.boundingBox();
    expect(b && b.width).toBeGreaterThanOrEqual(44);
    expect(b && b.height).toBeGreaterThanOrEqual(44);
  });
}

for (const width of [360, 390, 1440]) {
  test(`Events is plain navigation and the strip offers Continue without scrolling at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 800 });
    await openChallenge(page);
    const modals = [];
    await page.exposeFunction("__modalSeen", (t) => modals.push(t));
    await page.evaluate(() => {
      const ov = document.getElementById("modal-overlay");
      new MutationObserver(() => { if (ov.classList.contains("open")) window.__modalSeen(ov.textContent.slice(0, 60)); })
        .observe(ov, { attributes: true, attributeFilter: ["class"] });
    });
    await page.locator("#qa-playbar .qa-close").click();
    await page.locator("#tasks-page.active").waitFor({ state: "visible" });
    // Events from inside the live event: straight to the list.
    await page.locator("#nav-competitions").click();
    await page.locator("#competitions-page.active").waitFor({ state: "visible", timeout: 10000 });
    expect(modals, "no confirm on the way to the list").toEqual([]);
    const row = page.locator(`#ev-progress .ev-prog[data-comp-id="${fx.comp.id}"]`);
    await expect(row, "the run under way is on the strip").toBeVisible({ timeout: 10000 });
    await expect(row.locator(".qa-prog-n")).toContainText("/ 2");
    await expect(row.locator(".qa-gauge"), "the same time ring").toBeVisible();
    const go = row.getByRole("button", { name: /^Continue/ });
    await expect(go).toBeVisible();
    const gb = await go.boundingBox();
    const vh = page.viewportSize().height;
    expect(gb && gb.y + gb.height, "Continue is on the first screen").toBeLessThanOrEqual(vh);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
    // Continue goes back in (the same event, no "Switch Event?").
    await go.click();
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });
    expect(modals, "returning to the same live event asks nothing").toEqual([]);
  });
}
