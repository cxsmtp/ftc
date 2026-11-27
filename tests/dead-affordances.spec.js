// @ts-check
//
// v8.11.12 — THE TAIL OF THE UI AUDIT: affordances that promise something the
// platform does not do, and landmarks that lie about the page's shape.
//
// Each arm carries a CONTROL, because every assertion here is of the form "this
// is absent", which a build that removed the whole feature satisfies just as
// well as a build that fixed it.
const { test, expect } = require("./isolated-test");
const { apiLogin, getSuperadminPass, BASE, codeLogin, settleFiniteAnimations } = require("./helpers");

async function loginViaApi(page, email, password) {
  const post = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { password: pw });
  };
  let r = await post(password).catch(() => null);
  if (!r || !r.ok()) {
    await new Promise((res) => setTimeout(res, 300));
    r = await post(email === "superadmin" ? await getSuperadminPass() : password);
  }
  if (!r.ok()) throw new Error(`login(${email}) failed: ${r.status()}`);
}

test.describe("v8.11.12 — a dead region does not claim to be a control", () => {
  // ─── 1. THE RANKINGS CARD ──────────────────────────────────────────────────
  //
  // The wrapper was `role="button"` with a tabindex; that was deliberately undone
  // (nested-interactive), and `functional-core-a` pins it as no-longer-a-button.
  // The AFFORDANCE was left behind: a 980x181px region kept a hand cursor and a
  // hover lift while only the small `.rankings-card-view` button navigated.
  test("the all-live rankings card shows no pointer and no lift; its real button still does", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      await loginViaApi(page, "superadmin", await getSuperadminPass());
      await page.goto(BASE + "/");
      // The Rankings tab picks its live events out of the competitions MODEL and
      // renders once — with the model still empty it says "No live events" and
      // nothing re-enters it (the v8.2.3 `load-failure-states` class). And the
      // admin nav buttons are static markup, so clicking before boot has resolved
      // the role is the v8.3.33 class. Wait for BOTH before the click; a
      // full-suite prod run caught this racing (it had passed alone).
      await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
      await expect.poll(() => page.evaluate(() => (window.S?.adminCompetitionsData || []).length),
        { message: "the admin competitions model loaded", timeout: 20000 }).toBeGreaterThan(0);
      await page.click('button.admin-nav-item[data-tab-id="admin-rankings-tab"]');
      const card = page.locator("#admin-rankings-tab .rankings-picker-card").first();
      await expect(card, "the all-live board must render at least one picker card").toBeVisible({ timeout: 20000 });

      // PRECONDITION — this only means anything while the wrapper really is inert.
      expect(await card.getAttribute("role"), "the wrapper must still not be a button").toBeNull();
      expect(await card.getAttribute("tabindex")).toBeNull();

      const cursors = await card.evaluate((el) => ({
        card: getComputedStyle(el).cursor,
        td: (() => { const t = el.querySelector("tbody td"); return t ? getComputedStyle(t).cursor : null; })(),
        // the CONTROL: the one thing in here that DOES navigate
        btn: (() => { const b = el.querySelector(".rankings-card-view"); return b ? getComputedStyle(b).cursor : null; })(),
        // and the one thing that IS interactive inside the board
        th: (() => { const t = el.querySelector("th.sortable"); return t ? getComputedStyle(t).cursor : null; })(),
      }));
      expect(cursors.card, "a dead 980x181 region must not show a hand").not.toBe("pointer");
      expect(cursors.td, "the cursor is inherited, so the cells must not either").not.toBe("pointer");
      expect(cursors.btn, "CONTROL — the real navigation button keeps its affordance").toBe("pointer");
      if (cursors.th !== null)
        expect(cursors.th, "CONTROL — a sortable header sets its own cursor and keeps it").toBe("pointer");

      // The hover LIFT is the same claim by another means.
      const lifted = await card.evaluate((el) => {
        const before = getComputedStyle(el).transform;
        el.classList.add("__probe_hover");
        return { before };
      });
      expect(lifted.before, "the resting card must not already be translated").toMatch(/none|matrix\(1, 0, 0, 1, 0, 0\)/);
      const rules = await page.evaluate(() =>
        [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
          .filter((r) => r.selectorText && r.selectorText.includes("rankings-picker-card")
            && (r.selectorText.includes(":hover") || r.selectorText.includes(":focus-visible")))
          .map((r) => r.selectorText));
      expect(rules, "no hover lift and no focus ring on a wrapper nothing can focus").toEqual([]);
    } finally { await ctx.close(); }
  });

  // ─── 2. THE HELP DRAWER'S LANDMARKS ────────────────────────────────────────
  //
  // `role="dialog"` on an <aside> overrides its native sectioning semantics,
  // which promotes the nested <header> to a DOCUMENT-LEVEL banner — so an open
  // drawer put two unlabelled banners on the page.
  //
  // THE EXISTING axe SCAN COULD NOT SEE THIS, in two independent ways, and that
  // is why this arm counts landmarks itself rather than widening that scan:
  // `ui-participant-c.spec.js` includes ONLY `#help-drawer-overlay`, so the other
  // half of the comparison (`#app-header`) is out of scope; and
  // `landmark-no-duplicate-banner` is a BEST-PRACTICE rule, which its
  // `withTags(["wcag2a","wcag2aa"])` filter discards outright. Widening either
  // would make that test red for unrelated best-practice findings across the
  // whole document — wrong about working code.
  test("an open help drawer adds no second banner, and stays a modal dialog", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    try {
      await page.goto(BASE + "/");
      const census = () => page.evaluate(() => {
        const vis = (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed";
        const banners = [...document.querySelectorAll('header, [role="banner"]')]
          .filter((el) => vis(el))
          .filter((el) => !el.closest("[role=dialog], [role=complementary], article, aside, nav, section, main"))
          .map((el) => el.id || el.className || el.tagName);
        const d = document.querySelector(".help-drawer");
        return { banners, role: d && d.getAttribute("role"), modal: d && d.getAttribute("aria-modal"),
                 label: d && d.getAttribute("aria-label"), open: !!d };
      });

      const closed = await census();
      expect(closed.banners, "CONTROL — one banner before the drawer opens").toHaveLength(1);

      await page.click("#help-icon-btn");
      await page.waitForSelector("#help-drawer-overlay:not([hidden])", { timeout: 10000 });
      await page.waitForSelector(".help-drawer-body h1, .help-drawer-body p", { timeout: 10000 });

      const open = await census();
      expect(open.open, "the drawer must actually be open, or this asserts nothing").toBe(true);
      expect(open.banners, `an open drawer must add no banner — saw ${JSON.stringify(open.banners)}`).toHaveLength(1);

      // CONTROL — the fix must not have been "delete the dialog semantics".
      expect(open.role, "it is still a dialog").toBe("dialog");
      expect(open.modal, "and still modal — the focus trap depends on it").toBe("true");
      expect(open.label, "and still named").toBeTruthy();

      // ARIA in HTML: `dialog` is not an allowed role for <aside>.
      const tags = await page.evaluate(() => {
        const d = document.querySelector(".help-drawer");
        return { shell: d.tagName, head: d.querySelector(".help-drawer-head").tagName };
      });
      expect(tags.shell, "<aside role=dialog> is not allowed by ARIA in HTML").not.toBe("ASIDE");
      expect(tags.head, "a <header> inside a dialog is promoted to a page banner").not.toBe("HEADER");
    } finally { await ctx.close(); }
  });




  // ─── 4. SORTABLE HEADERS ARE TOUCH TARGETS ─────────────────────────────────
  //
  // 31.5-34.5px tall, in neither the 44px house standard nor the *Accepted
  // touch-target exception* register. SC 2.5.8's 24px minimum IS met, so this is
  // the house rule rather than an AA failure — and the register's own precedent
  // for a dense control is a coarse-pointer promotion.
  //
  // MEASURED, not asserted from the stylesheet: the first version of this rule
  // was inert because `#admin-page table th` (1-0-2) outranks anything without
  // an id, and a source check cannot see that.
  test("a sortable header is a 44px target on a coarse pointer, and unchanged on a fine one", async ({ browser }) => {
    const read = async (width, hasTouch) => {
      const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, hasTouch });
      const page = await ctx.newPage();
      try {
        await loginViaApi(page, "superadmin", await getSuperadminPass());
        await page.goto(BASE + "/");
        await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
        await expect(page.locator("th.sortable").first()).toBeAttached({ timeout: 20000 });
        // The admin tables re-render on a 15 s poll, so a single sample can land
        // mid-render and read a partial box — which is what made this arm flaky
        // once at WORKERS=18. Wait for the geometry to SETTLE (two consecutive
        // identical readings) rather than merely to exist.
        const sample = () => page.evaluate(() => ({
          coarse: matchMedia("(pointer:coarse)").matches,
          cards: matchMedia("(max-width:768px)").matches,
          heights: [...new Set([...document.querySelectorAll("th.sortable")]
            .map((t) => Math.round(t.getBoundingClientRect().height * 10) / 10).filter((h) => h > 0))].sort((a, b) => a - b),
        }));
        let prev = null, cur = null;
        await expect.poll(async () => {
          prev = cur; cur = await sample();
          return cur.heights.length > 0 && prev && JSON.stringify(prev.heights) === JSON.stringify(cur.heights);
        }, { timeout: 25000, intervals: [200, 300, 500, 800, 1000],
             message: () => `sortable header heights never settled (last: ${JSON.stringify(cur)})` }).toBe(true);
        return cur;
      } finally { await ctx.close(); }
    };

    // A TOUCH TABLET, not a phone. At 768px and below every admin table is a
    // set of cards whose heading row is on screen only for its select-all (the
    // sortable headings are kept for screen readers alone), so a phone has no
    // sortable header to tap and measuring one there measured an invisible box.
    // The coarse-pointer rule still decides every touch screen wider than that,
    // where the tables are tables: an iPad held sideways.
    const touch = await read(1024, true);
    expect(touch.coarse, "the fixture must actually present a coarse pointer").toBe(true);
    expect(touch.cards, "the fixture must be wide enough for real tables, not phone cards").toBe(false);
    expect(touch.heights.length, "the admin page must render sortable headers").toBeGreaterThan(0);
    for (const h of touch.heights)
      expect(h, `a sortable header is a touch target: ${JSON.stringify(touch.heights)}`).toBeGreaterThanOrEqual(44);

    // CONTROL — the desktop tables must not grow. Without this, "44 on a touch screen"
    // is satisfied by a build that made every admin table a third taller for
    // every mouse user, which is a worse product than the finding.
    const desktop = await read(1400, false);
    expect(desktop.coarse, "the control must present a FINE pointer").toBe(false);
    expect(desktop.heights.length, "the control must measure real headers, not an empty set").toBeGreaterThan(0);
    for (const h of desktop.heights)
      expect(h, `a fine pointer keeps the dense layout: ${JSON.stringify(desktop.heights)}`).toBeLessThan(40);
  });

  // ─── 5. THE COLLAPSED SIDEBAR RAIL ─────────────────────────────────────────
  //
  // Collapsed, the nine items are 55x44 icons with no visible label. The
  // ACCESSIBLE name survives (`.admin-nav-label` is opacity:0;width:0, which does
  // not remove text from the a11y tree), so this was a sighted-mouse defect only.
  test("a collapsed rail names its icons, and expanding removes the description again", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    try {
      await loginViaApi(page, "superadmin", await getSuperadminPass());
      await page.goto(BASE + "/");
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
      const sidebar = page.locator("#admin-sidebar");
      const items = page.locator("#admin-sidebar .admin-nav-item");
      await expect(items.first()).toBeVisible({ timeout: 20000 });

      // CONTROL — EXPANDED, the visible label is the label, so a title would be
      // noise and (on an element that already has a name) a duplicate description.
      if (await sidebar.evaluate((el) => el.classList.contains("collapsed")))
        await page.click("#admin-sidebar-toggle");
      await expect(sidebar).not.toHaveClass(/collapsed/);
      const expanded = await items.evaluateAll((els) => els.map((e) => e.getAttribute("title")));
      expect(expanded.filter(Boolean),
        "an expanded rail shows its labels, so it must carry no titles").toEqual([]);

      await page.click("#admin-sidebar-toggle");
      await expect(sidebar).toHaveClass(/collapsed/);
      // `.admin-nav-label` carries `transition:opacity`, so a sample taken on the
      // tick the class lands reads the PRE-fade value — the v8.2.3 trap. Drain it.
      await settleFiniteAnimations(page, "#admin-sidebar");
      const collapsed = await items.evaluateAll((els) => els.map((e) => ({
        title: e.getAttribute("title"),
        label: (e.querySelector(".admin-nav-label")?.textContent || "").trim(),
        labelVisible: e.querySelector(".admin-nav-label")
          ? getComputedStyle(e.querySelector(".admin-nav-label")).opacity : null,
      })));
      expect(collapsed.length, "nine items, or this asserts nothing").toBeGreaterThanOrEqual(5);
      for (const it of collapsed) {
        // The PRECONDITION: the label really is invisible in this state.
        expect(it.labelVisible, "the collapsed label must be the hidden one").toBe("0");
        expect(it.title, `every collapsed icon must name itself (${it.label})`).toBe(it.label);
      }

      // And it comes back off on expand, so the description is scoped to the
      // state that needs it.
      await page.click("#admin-sidebar-toggle");
      await expect(sidebar).not.toHaveClass(/collapsed/);
      const again = await items.evaluateAll((els) => els.map((e) => e.getAttribute("title")));
      expect(again.filter(Boolean), "expanding must remove them again").toEqual([]);
    } finally { await ctx.close(); }
  });

  // ─── 6. BOTH NAV LANDMARKS ARE NAMED ───────────────────────────────────────
  test("both <nav> landmarks are named, and the header one survives a role transition", async ({ browser }) => {
    // v8.12.4 — a USER-BACKED admin. The built-in superadmin has no user row,
    // so its view toggle is refused (403) and "the label survives the view
    // change" was measured across a change that never happened.
    const { makeParticipant } = require("./event-admin-helpers");
    const { PARTICIPANT_PASS } = require("./helpers");
    const { api: sa, csrf: sc } = await apiLogin("superadmin");
    let email;
    try {
      const who = await makeParticipant(sa, sc, "nav-landmark");
      const role = await sa.post(`/api/admin/participants/${who.id}/role`, {
        headers: { "x-csrf-token": sc, "content-type": "application/json" }, data: { role: "admin" } });
      expect(role.ok(), `promote: ${await role.text()}`).toBeTruthy();
      email = who.email;
    } finally { await sa.dispose(); }
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    try {
      await loginViaApi(page, email, PARTICIPANT_PASS);
      await page.goto(BASE + "/");
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });

      const navs = () => page.evaluate(() =>
        [...document.querySelectorAll("nav")]
          .filter((n) => n.offsetParent !== null)
          .map((n) => ({ id: n.id, label: n.getAttribute("aria-label") })));

      const asAdmin = await navs();
      // Lane chrome: the organiser shell has no top nav (the header's #main-nav is
      // empty and hidden there), so the sidebar is the rendered landmark; the
      // header one must still carry its name, ready for the participant view.
      expect(asAdmin.length, "the admin page renders its nav landmark").toBeGreaterThanOrEqual(1);
      expect(await page.locator("#main-nav").getAttribute("aria-label"), "#main-nav is named in the static markup").toBeTruthy();
      for (const n of asAdmin)
        expect(n.label, `<nav id="${n.id}"> must be named — two unnamed "navigation"s are indistinguishable`).toBeTruthy();
      expect(new Set(asAdmin.map((n) => n.label)).size,
        "and the names must differ, or naming them buys nothing").toBe(asAdmin.length);

      // THE CONTROL THAT MATTERS: buildParticipantNav replaces this element's
      // CHILDREN, so a label set in the static markup must survive. A label
      // applied by whichever builder ran last would not.
      await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
      await expect(page.locator("#admin-page"), "the view REALLY changed").toBeHidden({ timeout: 20000 });
      await expect(page.locator("#main-nav .nav-btn").first()).toBeVisible({ timeout: 20000 });
      const asParticipant = await navs();
      const main = asParticipant.find((n) => n.id === "main-nav");
      expect(main, "#main-nav must still be on the page").toBeTruthy();
      expect(main.label, "and still named after the view changed under it").toBeTruthy();
    } finally { await ctx.close(); }
  });
});
