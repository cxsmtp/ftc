// @ts-check
//
// THE STICKY CHROME UNDER THE APP HEADER (ui/nav.js publishHeaderHeight,
// watchHeaderHeight, publishStripBottoms and watchStickyStrips; the route-focus
// scroll margins in styles.css).
//
// 1. THE HEADER'S PUBLISHED BOTTOM EDGE. `--header-bottom` is what every sticky
//    or fixed piece under the app header hangs from: the workspace strip's
//    sticky top, the route-focus scroll margins, the phone drawer, the account
//    menu. The signed-in header (`#app-header.is-app`, set by showMain) trims
//    only its padding, so its border box shrinks (69 -> 61 px at desktop widths)
//    while its content box keeps its height, and a ResizeObserver on the content
//    box (the default) never fired: the published value stayed at 69 px on a
//    desktop admin session, and the workspace strip stuck 8 px below the header
//    with the page scrolling through the gap.
//
// 2. A ROUTE FOCUS LANDS BELOW THE STRIP STUCK UNDER THE HEADER. Two pages keep
//    a strip stuck under the header (`data-sticky-strip`): the event workspace's
//    header on every section but the Overview, and the challenge view's play
//    bar. A route change focuses the destination's heading and the browser
//    scrolls it into view with its scroll margin, which counted the app header
//    alone, so the heading and the controls under it (the search box) parked
//    behind the strip; at 780x360 the workspace strip wraps to three lines
//    (176 px). The margin reads `--strip-bottom`, the strip's bottom edge while
//    it sticks, published on its page right before every route focus.
//    The workspace section switch, three ways in, at three sizes:
//      A. the first switch from a scrolled Overview, where nothing sticks: the
//         edge is measured in the switch itself, before the focus reads it;
//      B. from the bottom of a long list (the browser centres a target it finds
//         hidden, which parks it behind a tall strip on a short screen);
//      C. from a list scrolled so the new section's heading would sit behind
//         the strip (the browser leaves a target it thinks is visible where it
//         is, so this reaches every size).
//    Every switch goes through the command palette: a door that works from any
//    scroll position (the section tabs scroll away with the page). The
//    challenge view: a challenge opened from a list scrolled so its title would
//    sit behind the play bar.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, waitForAdminPage, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, loginViaApi } = require("./ui-admin-helpers");
const { H, makeCompetition, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { openPalette } = require("./chrome-helpers");

test.use({ baseURL: BASE, reducedMotion: "reduce" });

const OVERVIEW = "admin-event-overview-tab";
const PEOPLE = "admin-participants-tab";
const TASKS = "admin-tasks-tab";
const SEARCH = { [PEOPLE]: "#participants-search", [TASKS]: "#task-search" };
const LABEL = { [PEOPLE]: "Participants", [TASKS]: "Questions" };   // Stage B named the workspace section Questions (owner ruling, 27 Nov 2026)
const F = {};   // this file's own events, challenges and people

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    F.ev = await makeCompetition(sa, csrf, "sticky");
    // A live event of the participant's own, with challenges to open, and an
    // idle second participant (nothing here solves anything).
    F.play = await makeCompetition(sa, csrf, "sticky-play");
    F.tasks = [];
    for (const l of ["a", "b", "c"]) {
      const t = await makeTask(sa, csrf, `sticky-${l}`);
      Object.assign(t, { bankId: t.id, id: (await assignTask(sa, csrf, t.id, [F.play.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
      F.tasks.push(t);
    }
    F.p = await makeParticipant(sa, csrf, "sticky-p");
    F.idle = await makeParticipant(sa, csrf, "sticky-idle");
    await enrol(sa, csrf, F.play.id, [F.p.id, F.idle.id]);
  } finally { await sa.dispose(); }
});

test.afterAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    for (const c of [F.ev, F.play].filter(Boolean)) await api.delete(`/api/admin/competitions/${c.id}`, { headers: H(csrf) }).catch(() => {});
  } finally { await api.dispose(); }
});

/** Sign the superadmin in at this size and wait until the Events model holds this file's event. */
async function signInAt(page, vp) {
  await page.setViewportSize(vp);
  await adminLogin(page);
  await waitForAdminPage(page);
  await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), F.ev.id),
    { timeout: 20000, message: "PRECONDITION: the Events model holds this file's event" }).toBe(true);
}

/** Open the event's workspace on a section and wait until that section shows. */
async function openWorkspace(page, section) {
  await page.evaluate(({ id, n, tab }) => window.openEventWorkspace(id, n, { tab }), { id: F.ev.id, n: F.ev.name, tab: section });
  await expect(page.locator(`#admin-workspace[data-section="${section}"]`), `the workspace shows ${section}`).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator("#ws-record")).toBeVisible({ timeout: 10000 });
}

/** Room to scroll whatever the lists hold: a tall spacer at the end of each element. */
function addSpacers(page, ids) {
  return page.evaluate((ids) => {
    for (const id of ids) {
      const s = document.createElement("div");
      s.className = "sticky-spacer";
      s.style.height = "3000px";
      document.getElementById(id).appendChild(s);
    }
  }, ids);
}

/** Switch section through the command palette, as a person on a scrolled page does. */
async function switchSection(page, section) {
  await openPalette(page);
  await page.locator("#cp-input").fill(LABEL[section]);
  const opt = page.locator("#cp-list .cp-opt")
    .filter({ has: page.locator(".cp-label", { hasText: new RegExp(`^${LABEL[section]}`) }) })
    .filter({ has: page.locator(".cp-hint", { hasText: F.ev.name }) });
  await expect(opt, `the palette offers this event's ${LABEL[section]} section`).toHaveCount(1, { timeout: 10000 });
  await opt.click();
  await expect(page.locator("#command-palette-overlay")).toHaveCount(0);
  await expect(page.locator(`#admin-workspace[data-section="${section}"]`), `the switch opened ${section}`).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator(`#${section} > h2`), `${LABEL[section]}: the section's heading takes focus`).toBeFocused();
}

/** Where the strip, the focused heading and the controls under it lie. */
function landing(page, section) {
  return page.evaluate(({ section, search }) => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10 }; };
    const pane = document.getElementById(section);
    const heading = pane.querySelector(":scope > h2");
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const first = [...pane.querySelectorAll("input,button,select,textarea,a[href]")].find(shown);
    const strip = document.getElementById("ws-record");
    return {
      vh: innerHeight, scrollY: Math.round(scrollY),
      headerBottom: document.getElementById("app-header").getBoundingClientRect().bottom,
      strip: r(strip), stripPosition: getComputedStyle(strip).position,
      heading: r(heading), focused: document.activeElement === heading,
      first: first ? { what: first.id || first.className, ...r(first) } : null,
      search: r(document.querySelector(search)),
    };
  }, { section, search: SEARCH[section] });
}

/** The focused heading, the section's first control and its search box lie below the strip, on screen. */
function expectBelowStrip(g, label) {
  const why = `${label}: ${JSON.stringify(g)}`;
  expect(g.stripPosition, `PRECONDITION: the strip sticks on this section — ${why}`).toBe("sticky");
  expect(g.focused, `the section's heading has focus — ${why}`).toBe(true);
  expect(g.first, `PRECONDITION: the section draws a control — ${why}`).not.toBeNull();
  expect(g.heading.top, `the heading lies below the strip — ${why}`).toBeGreaterThanOrEqual(g.strip.bottom - 0.5);
  expect(g.first.top, `the first control lies below the strip — ${why}`).toBeGreaterThanOrEqual(g.strip.bottom - 0.5);
  expect(g.search.top, `the search box lies below the strip — ${why}`).toBeGreaterThanOrEqual(g.strip.bottom - 0.5);
  expect(g.first.bottom, `the first control is on screen — ${why}`).toBeLessThanOrEqual(g.vh + 0.5);
  expect(g.search.bottom, `the search box is on screen — ${why}`).toBeLessThanOrEqual(g.vh + 0.5);
}

const publishedHeaderBottom = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")));
const headerBottom = (page) => page.evaluate(() => Math.round(document.getElementById("app-header").getBoundingClientRect().bottom));
/** What the admin page publishes as the stuck strip's bottom edge ("" when nothing sticks). */
const stripVar = (page) => page.evaluate(() => getComputedStyle(document.getElementById("admin-page")).getPropertyValue("--strip-bottom").trim());
/** The strip's bottom edge, measured on screen (the page is scrolled, so the strip is stuck). */
const stuckStripBottom = (page) => page.evaluate(() => {
  const rec = document.getElementById("ws-record").getBoundingClientRect();
  const hb = document.getElementById("app-header").getBoundingClientRect().bottom;
  return { stuck: Math.abs(rec.top - hb) <= 0.5, edge: `${Math.ceil(rec.bottom)}px`, height: rec.height };
});

test.describe("the header's published bottom edge", () => {
  for (const vp of [{ width: 1280, height: 800 }, { width: 780, height: 360 }]) {
    test(`at ${vp.width}x${vp.height}, signed in, --header-bottom is the header's bottom edge and a section's strip sticks right under it`, async ({ page }) => {
      // Every value --header-bottom takes on, from the first paint.
      await page.addInitScript(() => {
        window.__headerBottoms = [];
        new MutationObserver(() => {
          const v = document.documentElement ? document.documentElement.style.getPropertyValue("--header-bottom") : "";
          if (v && window.__headerBottoms[window.__headerBottoms.length - 1] !== v) window.__headerBottoms.push(v);
        }).observe(document, { attributes: true, subtree: true, attributeFilter: ["style"] });
      });
      await signInAt(page, vp);
      await expect(page.locator("#app-header.is-app"), "PRECONDITION: the signed-in header").toHaveCount(1);
      const bottom = await headerBottom(page);
      await expect.poll(() => publishedHeaderBottom(page), {
        timeout: 5000, message: `--header-bottom is the header's bottom edge (${bottom}px)`,
      }).toBe(bottom);
      // THE PREMISE: the first value published, while the header still had its
      // signed-out padding, was lower down the page than where the signed-in
      // header ends — the bottom edge moved after the nav build published it.
      const seen = await page.evaluate(() => window.__headerBottoms.map((v) => parseFloat(v)));
      expect(seen[0], `PREMISE: the header's bottom edge moved after the first publish — ${JSON.stringify({ seen, bottom })}`).toBeGreaterThan(bottom);
      // The strip of a section hangs from it: scrolled, it sticks right under the header.
      await openWorkspace(page, PEOPLE);
      await addSpacers(page, [PEOPLE]);
      await page.evaluate(() => window.scrollTo(0, 600));
      await expect.poll(() => page.evaluate(() => scrollY), { message: "the window scrolled" }).toBeGreaterThan(300);
      const g = await page.evaluate(() => ({
        stripTop: document.getElementById("ws-record").getBoundingClientRect().top,
        headerBottom: document.getElementById("app-header").getBoundingClientRect().bottom,
        published: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")),
      }));
      expect(Math.abs(g.stripTop - g.headerBottom), `the strip sticks right under the header, with no gap — ${JSON.stringify(g)}`).toBeLessThanOrEqual(0.5);
      expect(g.published, `and at the published edge — ${JSON.stringify(g)}`).toBe(Math.round(g.headerBottom));
    });
  }
});

test.describe("a section switch lands below the workspace strip", () => {
  for (const vp of [{ width: 1280, height: 800 }, { width: 780, height: 360 }, { width: 390, height: 844 }]) {
    test(`at ${vp.width}x${vp.height}, the section's heading and its first controls land below the strip: from a scrolled Overview, from the bottom of a list, and from a list that would park them behind the strip`, async ({ page }) => {
      const at = `${vp.width}x${vp.height}`;
      await signInAt(page, vp);
      await openWorkspace(page, OVERVIEW);
      await addSpacers(page, [OVERVIEW, PEOPLE, TASKS]);
      // A. The first switch, from a scrolled Overview (nothing sticks there).
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => page.evaluate(() => scrollY), { message: `${at} PRECONDITION: the Overview is scrolled down` }).toBeGreaterThan(300);
      await switchSection(page, PEOPLE);
      expectBelowStrip(await landing(page, PEOPLE), `${at} A, from a scrolled Overview`);
      // B. From the bottom of a long list.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => page.evaluate(() => scrollY), { message: `${at} PRECONDITION: the list is scrolled to its end` }).toBeGreaterThan(300);
      await switchSection(page, TASKS);
      expectBelowStrip(await landing(page, TASKS), `${at} B, from the bottom of a list`);
      // C. The list scrolled so this section's heading sits behind the stuck
      // strip, 20 px above its bottom edge; the next section's heading starts
      // where this one does.
      const parked = await page.evaluate((pane) => {
        const h = document.querySelector(`#${pane} > h2`);
        const strip = document.getElementById("ws-record");
        const hb = document.getElementById("app-header").getBoundingClientRect().bottom;
        const target = hb + strip.getBoundingClientRect().height - 20;
        window.scrollTo(0, h.getBoundingClientRect().top + scrollY - target);
        return { heading: h.getBoundingClientRect().top, strip: strip.getBoundingClientRect().top, stripBottom: strip.getBoundingClientRect().bottom, hb };
      }, TASKS);
      expect(parked.heading > parked.hb && parked.heading < parked.stripBottom && Math.abs(parked.strip - parked.hb) <= 0.5,
        `${at} PRECONDITION: the heading sits behind the stuck strip — ${JSON.stringify(parked)}`).toBe(true);
      await switchSection(page, PEOPLE);
      expectBelowStrip(await landing(page, PEOPLE), `${at} C, from a list that would park it behind the strip`);
    });
  }
});

test.describe("opening a challenge lands its title below the play bar", () => {
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`at ${vp.width}x${vp.height}, a challenge opened from a list scrolled so its title would sit behind the play bar lands its title below the bar`, async ({ page }) => {
      const at = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      await loginViaApi(page, F.p.email, PARTICIPANT_PASS);
      await page.goto("/");
      await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
      await addSpacers(page, ["tasks-page", "task-detail-page"]);
      // Press a challenge card (its own control, pressed where it is: no
      // scrolling to it first). The view's route focus lands on the title, and
      // the view then hands focus to the answer box: the person sees the page
      // where that leaves it.
      const open = async (task) => {
        await page.evaluate(() => {
          window.__routeFocus = [];
          if (!window.__routeFocusLog) {
            window.__routeFocusLog = true;
            document.addEventListener("focusin", (e) => window.__routeFocus.push(e.target.classList.contains("qa-title") ? "title" : e.target.id || e.target.tagName));
          }
        });
        await page.evaluate((id) => document.querySelector(`#task-grid .task-card[data-task-id="${id}"] .card-open`).click(), task.id);
        await expect(page.locator("#task-detail-page.active #qa-playbar"), `${at} the challenge view opened`).toBeVisible({ timeout: 15000 });
        await expect(page.locator("#task-detail-card .qa-title"), `${at} the title is the challenge's`).toHaveText(task.title, { timeout: 15000 });
        await expect(page.locator("#ans-text"), `${at} the view hands focus to the answer box`).toBeFocused();
        expect(await page.evaluate(() => window.__routeFocus), `${at} the route focus went to the title first`).toEqual(["title", "ans-text"]);
      };
      const back = async () => {
        await page.locator("#qa-playbar .qa-close").click();
        await expect(page.locator("#tasks-page"), `${at} back on the list`).toHaveClass(/\bactive\b/);
      };
      // Where a title starts, and where the bar's bottom edge sits once stuck.
      await open(F.tasks[0]);
      await page.evaluate(() => window.scrollTo(0, 0));
      const titleDoc = await page.evaluate(() => document.querySelector("#task-detail-card .qa-title").getBoundingClientRect().top + scrollY);
      await page.evaluate(() => window.scrollTo(0, 800));
      const stuckBottom = await page.evaluate(() => document.getElementById("qa-playbar").getBoundingClientRect().bottom);
      await back();
      // The list scrolled so the next title would sit 20 px above the stuck bar's bottom edge.
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(titleDoc - (stuckBottom - 20)));
      await open(F.tasks[1]);
      const g = await page.evaluate(() => {
        const t = document.querySelector("#task-detail-card .qa-title").getBoundingClientRect();
        const bar = document.getElementById("qa-playbar");
        const b = bar.getBoundingClientRect();
        return { vh: innerHeight, scrollY: Math.round(scrollY), title: { top: t.top, bottom: t.bottom }, bar: { top: b.top, bottom: b.bottom }, barPosition: getComputedStyle(bar).position };
      });
      const why = `${at}: ${JSON.stringify({ g, titleDoc, stuckBottom })}`;
      expect(g.barPosition, `PRECONDITION: the play bar sticks — ${why}`).toBe("sticky");
      expect(Math.abs(g.bar.bottom - stuckBottom), `PRECONDITION: the page is scrolled, so the bar is stuck — ${why}`).toBeLessThanOrEqual(0.5);
      expect(g.title.top, `the title lies below the play bar — ${why}`).toBeGreaterThanOrEqual(g.bar.bottom - 0.5);
      expect(g.title.bottom, `and on screen — ${why}`).toBeLessThanOrEqual(g.vh + 0.5);
    });
  }
});

test("--strip-bottom is the stuck strip's bottom edge: unset on the Overview, the edge on a section, following a resize that re-wraps the strip and a header that moves, and unset once the workspace closes", async ({ page }) => {
  await signInAt(page, { width: 1280, height: 800 });
  await openWorkspace(page, OVERVIEW);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("ws-record")).position), "PRECONDITION: nothing sticks on the Overview").not.toBe("sticky");
  await expect.poll(() => stripVar(page), { message: "unset on the Overview" }).toBe("");
  await switchSection(page, PEOPLE);
  await addSpacers(page, [PEOPLE]);
  await page.evaluate(() => window.scrollTo(0, 600));
  const wide = await stuckStripBottom(page);
  expect(wide.stuck, `PRECONDITION: scrolled, the strip is stuck — ${JSON.stringify(wide)}`).toBe(true);
  await expect.poll(() => stripVar(page), { message: "the stuck strip's bottom edge on a section" }).toBe(wide.edge);
  // A narrower window wraps the strip to more lines, with no section change.
  await page.setViewportSize({ width: 780, height: 360 });
  await expect.poll(async () => (await stuckStripBottom(page)).height, { message: `PRECONDITION: the strip re-wraps taller than ${wide.height}px` }).toBeGreaterThan(wide.height);
  await expect.poll(async () => { const s = await stuckStripBottom(page); return s.stuck && (await stripVar(page)) === s.edge; },
    { message: "it follows the re-wrapped strip" }).toBe(true);
  // The header grows (padding only, so its content box keeps its height): the
  // header's published edge and the strip hanging from it both follow.
  await page.evaluate(() => { document.getElementById("app-header").style.paddingTop = "20px"; });
  await expect.poll(async () => (await publishedHeaderBottom(page)) === (await headerBottom(page)), { message: "--header-bottom follows a padding-only change" }).toBe(true);
  await expect.poll(async () => { const s = await stuckStripBottom(page); return s.stuck && (await stripVar(page)) === s.edge; },
    { message: "the strip's edge follows the header" }).toBe(true);
  await page.evaluate(() => { document.getElementById("app-header").style.paddingTop = ""; });
  // ← Events closes the workspace.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#admin-scope-banner .scope-clear").click();
  await expect(page.locator("#admin-workspace"), "the workspace closed").toBeHidden();
  await expect.poll(() => stripVar(page), { message: "unset once the workspace closes" }).toBe("");
});
