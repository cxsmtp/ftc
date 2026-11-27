// @ts-check
//
// v8.11.7 — KEYBOARD AND FOCUS MANAGEMENT ON THE ADMIN SURFACE.
//
// Five findings from a UI audit, all measured in a real browser, all in the same
// layer: what the keyboard can reach and where focus goes. None of them is
// visible to an axe scan, which is why they had no coverage — axe checks that a
// control HAS an accessible name and a role, not that the role's keyboard
// contract is implemented or that focus goes anywhere sensible.
const { test, expect } = require("./isolated-test");
const { BASE, getSuperadminPass } = require("./helpers");
const { clickTab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

async function admin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

test("the skip link MOVES FOCUS, it does not merely scroll", async ({ page }) => {
  // Measured before: `{hash:"#main-content", active:"BODY"}` — the bypass
  // scrolled and left focus on <body>, so a screen-reader user who took it was
  // still reading the header. `tabindex="-1"` on the target is the whole fix.
  await page.goto("/");
  await page.locator("#login-page.active").waitFor({ state: "visible", timeout: 20000 });
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link"), "the skip link is the first tab stop").toBeFocused();
  await page.keyboard.press("Enter");
  const active = await page.evaluate(() => document.activeElement && document.activeElement.id);
  expect(active, "focus must land ON the main region").toBe("main-content");
});

test("every admin pane has its own heading, and switching tabs focuses it", async ({ page }) => {
  // Two findings, one cause. `_focusTarget` (ui/nav.js) queries `h1,h2`, so a
  // pane with neither dumped focus onto an unnamed <div> whose first text was
  // "× Clear3 participants … All". And the cards inside those panes are <h3>,
  // so with no h2 above them the document skipped a level (axe heading-order).
  await admin(page);
  const TABS = ["competitions", "tasks", "participants", "groups", "submissions",
    "rankings", "analytics", "logs", "settings"];
  const bad = [];
  for (const slug of TABS) {
    await clickTab(page, slug);
    await page.waitForTimeout(350);
    const got = await page.evaluate((s) => {
      const pane = document.getElementById(`admin-${s}-tab`);
      const h = pane && pane.querySelector("h2");
      const a = document.activeElement;
      return { hasH2: !!h, h2: h ? h.textContent.trim() : null, landed: a ? a.tagName : null };
    }, slug);
    if (!got.hasH2) bad.push(`${slug}: no <h2> in the pane`);
    // The focus target is the pane's own heading — an H2 — rather than the
    // container div that carries no name at all.
    if (got.landed !== "H2") bad.push(`${slug}: tab switch left focus on ${got.landed}, not the heading`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
});

test("the row kebab implements the menu contract it declares", async ({ page }) => {
  // `role="menu"` is a promise about keyboard behaviour. Measured before:
  // ArrowDown / ArrowUp / Home all left focus on the first item (8 menuitems,
  // 0 responsive), the menu had no accessible name, and Tab past the last item
  // wrapped to the header Logout button while the destructive menu stayed open
  // and overlaying the table.
  await admin(page);
  await clickTab(page, "participants");
  await page.locator("#admin-participants-tab .kebab-btn").first().waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#admin-participants-tab .kebab-btn").first().click();
  const portal = page.locator("#kebab-portal");
  await expect(portal).toBeVisible({ timeout: 10000 });

  await expect(portal, "the menu must be NAMED — rows here are near-identical by design")
    .toHaveAttribute("aria-label", /.+/);

  const items = portal.locator('[role="menuitem"]');
  const n = await items.count();
  expect(n, "the fixture must offer several items, or the arrow-key test is vacuous").toBeGreaterThan(2);

  const focusedText = () => page.evaluate(() => (document.activeElement || {}).textContent?.trim() || null);
  // v8.12.6 — WAIT for focus to arrive before sampling it. toggleKebab moves
  // focus into the portal on a setTimeout(0), so the portal can be visible while
  // focus is still on the ⋮ trigger: `first` then read the TRIGGER's text, the
  // arrow keys acted from there, and "ArrowUp must move it back" compared a menu
  // item against the trigger. Intermittent, and it named the arrow keys.
  await expect.poll(() => page.evaluate(() =>
    !!document.getElementById("kebab-portal")?.contains(document.activeElement)
  ), { timeout: 5000, message: "focus must move INTO the open menu" }).toBe(true);
  const first = await focusedText();
  await page.keyboard.press("ArrowDown");
  const second = await focusedText();
  expect(second, "ArrowDown must move focus").not.toBe(first);
  await page.keyboard.press("ArrowUp");
  expect(await focusedText(), "ArrowUp must move it back").toBe(first);
  await page.keyboard.press("End");
  const last = await focusedText();
  expect(last, "End must reach the last item").not.toBe(first);
  await page.keyboard.press("Home");
  expect(await focusedText(), "Home must return to the first").toBe(first);

  // Tab from the LAST item must stay inside the menu, not wrap to the document.
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(() =>
    !!document.getElementById("kebab-portal")?.contains(document.activeElement));
  expect(inside, "Tab past the last item must not escape an open destructive menu").toBe(true);
});

test("a row menu closed before its click-outside listener is armed leaves nothing behind: the next menu opens and stays open", async ({ page }) => {
  // v8.12.6 — found as a suite flake that was deterministic under load. The
  // menu's click-outside listener is armed a task after it opens; input is
  // scheduled ahead of timers, so an Escape landing first closed the menu with
  // nothing to remove, and the timer then added a listener bound to the OLD
  // trigger that nothing would ever remove. Every later menu was then closed by
  // it the moment it opened (`ev.target !== btn`), leaking one more each time.
  // The race is reproduced deterministically here: open and close in ONE task,
  // so the close provably precedes the timer.
  await admin(page);
  await clickTab(page, "participants");
  const kebabs = page.locator("#admin-participants-tab .kebab-btn");
  await expect.poll(() => kebabs.count(), { timeout: 20000, message: "the table must offer at least two row menus" }).toBeGreaterThan(1);
  const openedThenClosed = await page.evaluate(() => {
    const btns = document.querySelectorAll("#admin-participants-tab .kebab-btn");
    btns[0].click();
    const opened = document.getElementById("kebab-portal")?.classList.contains("open") === true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const closed = !document.getElementById("kebab-portal")?.classList.contains("open");
    return { opened, closed };
  });
  expect(openedThenClosed, "precondition: the first menu opened, then closed in the same task").toEqual({ opened: true, closed: true });
  // Let the menu's pending timer run — a timer queued after it runs after it, so
  // this is an ordering, not a sleep — then a real click on ANOTHER row's menu.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await kebabs.nth(1).click();
  await expect(page.locator("#kebab-portal"), "the next menu must open — a leaked listener closed it the moment it opened").toBeVisible({ timeout: 5000 });
  expect(await page.locator("#kebab-portal [role='menuitem']").count(), "…and stay open with its items").toBeGreaterThan(0);
});

test.describe("the mobile drawer is modal", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("it traps Tab, marks the page behind it inert, and takes its turn on the Escape stack", async ({ page }) => {
    // Measured before, at this viewport: focus stayed on the hamburger and never
    // entered the drawer, and 7 of 16 Tab stops landed in the page BEHIND its
    // 45%-black scrim while `mobile-open` was still true.
    await admin(page);
    await page.locator("#admin-mobile-menu-btn").click();
    await expect(page.locator("#admin-sidebar.mobile-open")).toBeVisible({ timeout: 10000 });

    await expect.poll(() => page.evaluate(() =>
      !!document.getElementById("admin-sidebar")?.contains(document.activeElement)
    ), { timeout: 5000, message: "focus must move INTO the drawer" }).toBe(true);

    expect(await page.evaluate(() => document.querySelector(".admin-content")?.inert === true),
      "the page behind the scrim must be inert — a scrim stops clicks, not Tab").toBe(true);

    // Twelve stops is well past the nine nav items, so an untrapped drawer would
    // certainly have escaped by now.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const out = await page.evaluate(() =>
        !document.getElementById("admin-sidebar")?.contains(document.activeElement));
      expect(out, `Tab stop ${i + 1} escaped the open drawer`).toBe(false);
    }

    // THE ESCAPE STACK. A modal opened on top must take the first Escape by
    // itself: before this the drawer's private listener fired on the same event
    // and closed BOTH.
    const modal = page.evaluate(() => window.showModal({ title: "Probe", message: "x", confirmText: "OK" }));
    await expect(page.locator("#modal-overlay")).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-overlay")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#admin-sidebar.mobile-open"),
      "one Escape must close the MODAL only, not the drawer underneath it").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#admin-sidebar.mobile-open"),
      "…and the next Escape closes the drawer").toBeHidden({ timeout: 10000 });
    await modal.catch(() => {});

    expect(await page.evaluate(() => document.querySelector(".admin-content")?.inert === true),
      "closing must release the inert, or the page is dead to the keyboard").toBe(false);
  });
});

// THE SHARED CONFIRM OPENS AT ITS TOP. Its primary takes focus on open, and
// moving focus there scrolled a long message to its foot, past its title. The
// box is shared, so a modal opened over another (which settles the first as
// Cancel) starts from the top too, not where the first was left.
test.describe("the shared confirm opens at its top", () => {
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`a long message keeps its title in view while its primary takes focus (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/");
      await expect(page.locator('html[data-booted="1"]'), "PRECONDITION: the app booted").toBeAttached({ timeout: 20000 });
      const open = (title) => page.evaluate((t) => {
        window.showModal({ title: t, message: Array.from({ length: 150 }, (_, i) => `<p>Line ${i + 1}</p>`).join(""), confirmText: "Close", cancelText: "" }).catch(() => {});
      }, title);
      const read = () => page.evaluate(() => {
        const box = document.getElementById("modal-box");
        const t = document.getElementById("modal-title").getBoundingClientRect(), b = box.getBoundingClientRect();
        return { title: document.getElementById("modal-title").textContent, overflows: box.scrollHeight - box.clientHeight, scrollTop: box.scrollTop,
          titleInView: t.top >= b.top - 0.5 && t.bottom <= b.bottom + 0.5, focus: document.activeElement && document.activeElement.id };
      });
      await open("First long message");
      await expect(page.locator("#modal-overlay.open")).toBeVisible();
      const first = await read();
      expect(first.overflows, `PRECONDITION: the message is longer than the box: ${JSON.stringify(first)}`).toBeGreaterThan(200);
      expect(first, "it opens at its top, its title in view, its primary focused").toMatchObject({ scrollTop: 0, titleInView: true, focus: "modal-confirm-btn" });
      // Read to its foot, then a second modal takes the box over.
      await page.evaluate(() => { const b = document.getElementById("modal-box"); b.scrollTop = b.scrollHeight; });
      expect((await read()).scrollTop, "PRECONDITION: the first was scrolled to its foot").toBeGreaterThan(200);
      await open("Second long message");
      await expect(page.locator("#modal-title")).toHaveText("Second long message");
      expect(await read(), "the second opens at its top as well").toMatchObject({ scrollTop: 0, titleInView: true, focus: "modal-confirm-btn" });
      await page.keyboard.press("Escape");
      await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
    });
  }
});
