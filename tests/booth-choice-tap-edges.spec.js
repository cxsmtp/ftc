// v8.13.0 — the booth tap-to-answer view at its edges: a rotation (including one
// made while the confirm is open), leaving a challenge while its answer is in
// flight, a late entrant's chip in the bar, an impersonating admin's way out,
// accessibility in both themes, the states that must keep today's card, the
// editor's choice cap, and the source rules no behaviour test can hold.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { AxeBuilder } = require("@axe-core/playwright");
const { BASE, PARTICIPANT_PASS, getSuperadminPass, codeLogin, settleFiniteAnimations } = require("./helpers");
const {
  sa, SHORT, eventWithChoices, participantIn, deviceContext, signInTo,
  openChallenge, tapState, countSubmits, pageSubmit, choiceIdsFor, H,
} = require("./booth-choice-tap-fixture");
const { expireEvent, makeParticipant, enrol, rawSetAssignedAt } = require("./late-entry-fixture");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// Strip comments in ONE left-to-right pass, both forms, leaving strings alone
// (the v7.21.24 rule: a `/*` inside a `//` line must not eat the code after it).
function stripJs(src) {
  return src.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || "");
}
const confirmOpen = (page) => page.locator("#modal-overlay.open");
const GATED = new Set(["moderate", "serious", "critical"]);

// Resize, then PROVE the page has processed it before a "nothing changed" read:
// the viewport has the new size, and two animation frames have run — the fit is
// scheduled from the resize event into the next frame, so the second frame
// cannot come before it. A fixed sleep passes on a stalled renderer with the
// guard removed, because nothing had run yet either way.
async function resizeAndSettle(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function answer(page, text) {
  await page.locator(".mcf-tile", { hasText: text }).click();
  await expect(confirmOpen(page)).toBeVisible();
  await page.waitForTimeout(450);
  await page.locator("#modal-confirm-btn").click();
  await expect(confirmOpen(page)).toHaveCount(0);
}

test.describe("v8.13.0 — the booth tap view at its edges", () => {
  test("rotation: landscape still fits; a rotation under the open confirm is applied when it closes", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser, { width: 390, height: 664 });
    const page = await ctx.newPage();
    try {
      const posts = countSubmits(page);
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      expect((await tapState(page)).fit).toBe("fixed");

      // A phone turned sideways still matches (coarse pointer, short screen).
      await page.setViewportSize({ width: 664, height: 390 });
      await expect.poll(async () => (await tapState(page)).fit).toBe("fixed");
      const land = await tapState(page);
      expect(land.mq).toBe(true);
      expect(land.scrollH).toBeLessThanOrEqual(land.innerH);
      expect(land.lastBottom).toBeLessThanOrEqual(land.innerH);

      // Rotate WHILE the confirm is open, to a size the device query does not
      // match: nothing is re-laid-out under the dialog...
      await page.locator(".mcf-tile", { hasText: "FTP" }).click();
      await expect(confirmOpen(page)).toBeVisible();
      await resizeAndSettle(page, 1024, 768);
      expect(await page.evaluate(() => window.matchMedia(window.CHOICE_TAP_MQ).matches), "precondition: 1024x768 does not match").toBe(false);
      expect((await tapState(page)).body, "postponed while the dialog is up").toContain("mcf");
      // ...and Cancel applies it at once — not at the next unrelated resize.
      await page.locator("#modal-cancel-btn").click();
      await expect.poll(async () => (await tapState(page)).fit).toBe("chrome");
      const wide = await tapState(page);
      expect(wide.body).not.toContain("mcf");
      expect(wide.headerShown, "the full chrome is back").toBe(true);
      expect(wide.timerInHeader).toBe(true);
      expect(wide.tileCount, "the tiles stay — an answer in progress is never swapped").toBe(4);
      await expect(page.locator(".mcf-back"), "one Back is enough").toBeHidden();
      expect(posts.n).toBe(0);

      // And back to portrait.
      await page.setViewportSize({ width: 390, height: 664 });
      await expect.poll(async () => (await tapState(page)).fit).toBe("fixed");
      const back = await tapState(page);
      expect(back.timerInBar).toBe(true);
      expect(back.headerShown).toBe(false);
    } finally { await ctx.close(); }
  });

  test("Reduce Motion: a style change applies at once, so the first fit sees the real layout", async ({ browser }) => {
    // The global reduced-motion rule used to give every property of every element
    // a one-frame transition (`transition-property` defaults to `all`), so the
    // first fit read `main`'s old padding and scrolled a question that fits.
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await signInTo(page, p.email, comp.id);
      // Directly: a class that changes `main`'s padding is in the computed style
      // in the same task, not a frame later.
      const sync = await page.evaluate(() => {
        const m = document.querySelector("main");
        const before = getComputedStyle(m).paddingBottom;
        document.body.classList.add("mcf");
        const after = getComputedStyle(m).paddingBottom;
        document.body.classList.remove("mcf");
        return { before, after };
      });
      expect(sync.before, "precondition: the phone layout reserves room for the bottom nav").not.toBe("8px");
      expect(sync.after, "applied synchronously under Reduce Motion").toBe("8px");
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      expect(s.fit, "one screen with Reduce Motion on").toBe("fixed");
    } finally { await ctx.close(); }
  });

  test("the scroll latch waits for a touch, and a width change re-tries it", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    const fit = () => page.evaluate(() => document.getElementById("task-detail-card").dataset.mcfFit);
    // An inline padding on <main> (an attribute style, which the CSP allows)
    // makes the page too tall for one screen until it is taken off again.
    const crowd = (on) => page.evaluate((v) => { document.querySelector("main").style.paddingBottom = v ? "420px" : ""; }, on);
    try {
      await signInTo(page, p.email, comp.id);
      await crowd(true);
      await openChallenge(page, ids[0]);
      await expect.poll(fit, { message: "too tall: scroll" }).toBe("scroll");
      // Nobody has touched it, so "scroll" was provisional: once there is room
      // again, the next measurement finds one screen.
      await crowd(false);
      await page.setViewportSize({ width: 390, height: 665 });
      await expect.poll(fit, { message: "provisional scroll is re-tried" }).toBe("fixed");

      // A touch on a card that is ALREADY scrolling latches at once — not at the
      // next failed fit, which re-measures inside the fixed-height chain and
      // throws a scrolled thumb back up. So a height-only change that would now
      // fit leaves it scrolling. (Review finding: the latch was set only by a fit
      // that FAILED after the touch, so this case flipped to one screen.)
      await crowd(true);
      await page.setViewportSize({ width: 390, height: 664 });
      await expect.poll(fit, { message: "too tall again, still untouched: scroll" }).toBe("scroll");
      await page.locator(".mcf-q-title").dispatchEvent("pointerdown");
      await crowd(false);
      await resizeAndSettle(page, 390, 665);
      expect(await fit(), "latched by the touch itself").toBe("scroll");
      await page.setViewportSize({ width: 391, height: 665 });
      await expect.poll(fit, { message: "a width change re-tries it" }).toBe("fixed");
      await page.setViewportSize({ width: 390, height: 665 });
      await expect.poll(fit).toBe("fixed");

      // Once the participant has touched the card, a scroll verdict holds through
      // a height-only change (the address bar coming and going)...
      await page.locator(".mcf-q-title").dispatchEvent("pointerdown");
      await crowd(true);
      await page.setViewportSize({ width: 390, height: 664 });
      await expect.poll(fit).toBe("scroll");
      await crowd(false);
      await resizeAndSettle(page, 390, 665);
      expect(await fit(), "latched: a height-only change does not flip it back").toBe("scroll");
      // ...and a width change (a rotation, a split screen) re-tries it.
      await page.setViewportSize({ width: 391, height: 665 });
      await expect.poll(fit, { message: "a width change re-tries the fit" }).toBe("fixed");
    } finally { await ctx.close(); }
  });

  test("a re-fit never moves a scrolled page: the ladder's measurement puts the scroll position back", async ({ browser }) => {
    // The review's reproduction: six 88-character options (under the static
    // pre-gate, so the ladder MEASURES) and a long question on a 360x560 phone.
    const long = (n) => `Option ${n}: ` + "a deliberately long answer that keeps going well past one line ".repeat(2).slice(0, 78);
    const choices = [1, 2, 3, 4, 5, 6].map((n) => ({ text: long(n), ...(n === 3 ? { correct: true } : {}) }));
    expect(choices.every((c) => c.text.length <= 90 && c.text.length > 80), "precondition: under the static pre-gate").toBe(true);
    const description = "<p>" + "A login form builds its database query from the username a visitor types into it. ".repeat(8) + "</p>";
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices, description }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser, { width: 360, height: 560 });
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      await expect.poll(async () => (await tapState(page)).fit, { message: "measured as too tall" }).toBe("scroll");
      // Scrolled WITHOUT a touch (a narrow desktop window, a scroll wheel), so
      // nothing has latched and the next resize runs the whole ladder again.
      const y = await page.evaluate(() => {
        const se = document.scrollingElement;
        const target = Math.min(600, se.scrollHeight - innerHeight - 40);
        se.scrollTop = target;
        return se.scrollTop;
      });
      expect(y, "precondition: the page really scrolled").toBeGreaterThan(200);
      await resizeAndSettle(page, 360, 561);
      const after = await page.evaluate(() => ({ y: document.scrollingElement.scrollTop, fit: document.getElementById("task-detail-card").dataset.mcfFit }));
      expect(after.fit).toBe("scroll");
      expect(Math.abs(after.y - y), `the page stayed where it was scrolled to (${y} → ${after.y})`).toBeLessThanOrEqual(2);
    } finally { await ctx.close(); }
  });

  test("an answer that lands after the participant moved on leaves the next challenge's tiles busy", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ title: "Alpha protocol", choices: SHORT }, { title: "Beta protocol", choices: SHORT }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      const gate = {};
      for (const id of ids) {
        gate[id] = { parked: false };
        gate[id].held = new Promise((r) => { gate[id].release = r; });
        await page.route(`**/api/tasks/${id}/submit`, async (route) => { gate[id].parked = true; await gate[id].held; await route.continue(); });
      }
      await openChallenge(page, ids[0]);
      await answer(page, "FTP");
      await expect.poll(() => gate[ids[0]].parked, { message: "Alpha's answer is in flight" }).toBe(true);
      await page.getByRole("button", { name: "Back to challenges" }).click();
      await openChallenge(page, ids[1]);
      await expect(page.locator(".mcf-q-title")).toHaveText("Beta protocol");
      await answer(page, "Telnet");
      await expect.poll(() => gate[ids[1]].parked, { message: "Beta's answer is in flight" }).toBe(true);
      const busy = () => page.evaluate(() => ({
        group: document.querySelector(".mcf-options")?.getAttribute("aria-busy") || null,
        disabled: document.querySelectorAll(".mcf-tile[data-mcf-busy]").length,
      }));
      expect(await busy(), "precondition: Beta's tiles say an answer is being sent").toEqual({ group: "true", disabled: 3 });

      gate[ids[0]].release();
      await expect(page.locator(".toast", { hasText: "Alpha protocol" })).toBeVisible({ timeout: 10000 });
      expect(await busy(), "Alpha's late answer must not unlock Beta's tiles while Beta's is still out").toEqual({ group: "true", disabled: 3 });

      gate[ids[1]].release();
      await expect(page.locator(".mcf-tile.is-tried", { hasText: "Telnet" })).toHaveCount(1, { timeout: 10000 });
      expect(await busy(), "Beta's own answer clears them").toEqual({ group: null, disabled: 0 });
    } finally { await ctx.close(); }
  });

  test("a question that scrolls inside its own box can be reached and scrolled by keyboard", async ({ browser }) => {
    const description = "<p>" + "A login form builds its database query from the username a visitor types. ".repeat(4) + "</p>"
      + "<p>" + "Which approach stops an attacker from changing what the query does, whatever they type? ".repeat(3) + "</p>";
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ title: "Long question", choices: SHORT, description }, { title: "Short question", choices: SHORT }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    const qState = () => page.evaluate(() => {
      const q = document.querySelector(".mcf-q");
      return { fit: document.getElementById("task-detail-card").dataset.mcfFit,
        scrolls: q.scrollHeight > q.clientHeight + 2, tabindex: q.getAttribute("tabindex"),
        role: q.getAttribute("role"), labelledby: q.getAttribute("aria-labelledby"), top: q.scrollTop };
    });
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      await expect.poll(async () => (await qState()).fit).toBe("fixed");
      const s = await qState();
      expect(s.scrolls, "precondition: the question scrolls inside its own box").toBe(true);
      expect(s, "a scrolling question is a named, focusable region").toMatchObject({ tabindex: "0", role: "region", labelledby: "mcf-q-title" });
      const r = await new AxeBuilder({ page }).include("#task-detail-card").withRules(["scrollable-region-focusable"]).analyze();
      expect(r.violations.map((v) => v.id)).toEqual([]);
      await page.locator(".mcf-q").focus();
      await page.keyboard.press("PageDown");
      await expect.poll(async () => (await qState()).top, { message: "the keyboard scrolls the question" }).toBeGreaterThan(0);

      // CONTROL: a question that fits needs no extra Tab stop.
      await page.getByRole("button", { name: "Back to challenges" }).click();
      await openChallenge(page, ids[1]);
      await expect.poll(async () => (await qState()).fit).toBe("fixed");
      const c = await qState();
      expect(c.scrolls).toBe(false);
      expect(c, "no Tab stop and no region for a question that fits").toMatchObject({ tabindex: null, role: null });
    } finally { await ctx.close(); }
  });

  test("a multiple-answer tile shows its focus ring for the keyboard, not after a tap", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ choices: [{ text: "An API key", correct: true }, { text: "The README" },
        { text: "A database password", correct: true }, { text: "The licence file" }] }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    const rings = () => page.evaluate(() => [...document.querySelectorAll(".mcf-check")].map((l) => ({
      text: l.querySelector(".mcf-text-body").textContent,
      tile: getComputedStyle(l).outlineStyle,
      box: getComputedStyle(l.querySelector(".ans-choice")).outlineStyle,
      focused: document.activeElement === l.querySelector(".ans-choice"),
    })));
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const readme = page.locator(".mcf-check", { hasText: "The README" });
      await readme.click();
      await readme.click();
      await expect(readme).not.toHaveClass(/is-checked/);
      const afterTap = (await rings()).find((r) => r.text === "The README");
      expect(afterTap.tile, "an unticked tile after a tap carries no ring (it read as selected)").toBe("none");

      // Where focus sits after two clicks on a label is not something to rely
      // on; start from the first checkbox in the order the participant sees, and
      // let the KEYBOARD move to the second.
      await page.locator(".mcf-check .ans-choice").first().focus();
      await page.keyboard.press("Tab");
      const all = await rings();
      const k = all.find((r) => r.focused);
      expect(k && all.indexOf(k), "precondition: Tab moved focus to the second checkbox").toBe(1);
      expect(k.tile, "the keyboard's ring is on the tile").toBe("solid");
      expect(k.box, "and not doubled on the checkbox inside it").toBe("none");
    } finally { await ctx.close(); }
  });

  test("a phone on its side is not capped like a tablet, and the last ten seconds do not move the bar", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser, { width: 844, height: 390 });
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      expect(s.mq && s.tap, "precondition: a landscape phone gets the tap view").toBe(true);
      const w = await page.evaluate(() => document.getElementById("task-detail-card").getBoundingClientRect().width);
      expect(w, "the portrait-tablet 640px column does not apply on a phone on its side").toBeGreaterThan(700);

      const sizes = await page.evaluate(() => {
        const t = document.querySelector(".mcf-clock #header-timer");
        if (!t) return null;
        const a = t.getBoundingClientRect();
        t.classList.add("urgent-final");
        const b = t.getBoundingClientRect();
        const edge = getComputedStyle(t).boxShadow;
        t.classList.remove("urgent-final");
        return { h0: a.height, h1: b.height, w0: Math.round(a.width), w1: Math.round(b.width), edge };
      });
      expect(sizes, "precondition: the countdown is in the bar").not.toBeNull();
      expect(sizes.h1, "the urgent edge does not grow the box").toBe(sizes.h0);
      expect(sizes.w1).toBe(sizes.w0);
      expect(sizes.edge, "the urgency is still drawn").not.toBe("none");
    } finally { await ctx.close(); }
  });

  test("leaving a challenge while its answer is in flight: the result is named, the next challenge is answerable", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ title: "Alpha protocol", choices: SHORT }, { title: "Beta protocol", choices: SHORT }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      let release;
      const held = new Promise((r) => { release = r; });
      let parked = false;
      await page.route(`**/api/tasks/${ids[0]}/submit`, async (route) => { parked = true; await held; await route.continue(); });

      await openChallenge(page, ids[0]);
      await answer(page, "FTP");
      await expect.poll(() => parked, { message: "the answer to Alpha must be in flight" }).toBe(true);
      await page.getByRole("button", { name: "Back to challenges" }).click();
      await openChallenge(page, ids[1]);
      await expect(page.locator(".mcf-q-title")).toHaveText("Beta protocol");

      // Beta is answerable while Alpha's answer is still out: the confirm opens.
      await page.locator(".mcf-tile", { hasText: "Telnet" }).click();
      await expect(confirmOpen(page), "a tap on the NEXT challenge must not be swallowed").toBeVisible();
      await page.locator("#modal-cancel-btn").click();
      await expect(confirmOpen(page)).toHaveCount(0);

      release();
      await expect(page.locator(".toast", { hasText: "Alpha protocol" })).toBeVisible({ timeout: 10000 });
      // Nothing of Alpha's outcome landed on Beta's card.
      await expect(page.locator(".mcf-q-title")).toHaveText("Beta protocol");
      await expect(page.locator(".mcf-tile.is-tried")).toHaveCount(0);
      await expect(page.locator("#submit-result")).toBeEmpty();
      await expect(page.locator(".mcf-meta-2")).toHaveText("3 of 3 attempts left");
      await expect(page.locator(".mcf-tile[aria-disabled='true']")).toHaveCount(0);
    } finally { await ctx.close(); }
  });

  test("a late entrant's chip moves into the bar, and the smallest phone still fits", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    // The event ends; the late-entry window (on by default for a Booth Event) opens;
    // somebody joins now — a late entrant, who may still play.
    await expireEvent(comp.id);
    const late = await makeParticipant(api, csrf, `bctlate${Date.now().toString(36)}`);
    await enrol(api, csrf, comp.id, late.id);
    const ctx = await deviceContext(browser, { width: 320, height: 568 });
    const page = await ctx.newPage();
    try {
      await signInTo(page, late.email, comp.id);
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      expect(s.tap, "a late entrant gets the tap view").toBe(true);
      const chip = page.locator(".mcf-clock #header-late-entry");
      await expect(chip, "the chip that explains the countdown moved with it").toBeVisible();
      await expect(chip).toHaveText("Late entry");
      expect(s.scrollW, "no sideways scroll at 320").toBeLessThanOrEqual(s.clientW);
      expect(s.fit).toBe("fixed");
      expect(s.lastBottom).toBeLessThanOrEqual(s.innerH);
    } finally { await ctx.close(); }
  });

  test("an impersonating admin keeps the Exit button, above the tap view", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      const t0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const li = await page.request.post("/api/login", { headers: H(t0), data: { email: "superadmin", password: getSuperadminPass() } });
      expect(li.ok(), `superadmin login: ${li.status()}`).toBeTruthy();
      const t1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const imp = await page.request.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(t1), data: {} });
      expect(imp.ok(), `impersonate: ${await imp.text()}`).toBeTruthy();
      const t2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await page.request.post("/api/select-competition", { headers: H(t2), data: { competitionId: comp.id } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      await page.goto("/");
      await page.locator("#impersonation-banner").waitFor({ state: "visible", timeout: 20000 });
      await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      expect(s.tap).toBe(true);
      expect(s.scrollH, "the bar's height is taken out of the one screen").toBeLessThanOrEqual(s.innerH);
      expect(s.lastBottom).toBeLessThanOrEqual(s.innerH);
      // The Exit button is what an elementFromPoint at its centre finds — nothing
      // in the tap view covers it.
      const exit = page.locator("#impersonation-banner [data-action='impersonation-exit']");
      await expect(exit).toBeVisible();
      const hit = await exit.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (at === el || el.contains(at));
      });
      expect(hit, "Exit is on top").toBe(true);
      // And the bar does not hide the tap view's own Back.
      const bar = await page.locator("#impersonation-banner").boundingBox();
      const backBox = await page.locator(".mcf-back").boundingBox();
      expect(backBox.y, "the tap view starts below the impersonation bar").toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    } finally { await ctx.close(); }
  });

  for (const theme of ["dark", "light"]) {
    test(`accessibility (${theme}): the tap view, a tried tile and the naming confirm pass axe`, async ({ browser }) => {
      const { api, csrf } = await sa();
      const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT, hint: "<p>Look for the S.</p>" }] });
      const p = await participantIn(api, csrf, comp.id);
      const ctx = await deviceContext(browser, { theme });
      const page = await ctx.newPage();
      try {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await signInTo(page, p.email, comp.id);
        await openChallenge(page, ids[0]);
        await answer(page, "FTP");
        await expect(page.locator(".mcf-tile.is-tried")).toHaveCount(1);
        await expect(page.locator("#submit-result .result-msg.wrong")).toBeVisible();
        const scan = async (sel) => {
          const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
          return r.violations.filter((v) => GATED.has(v.impact))
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
        };
        expect(await scan("#task-detail-card"), "the card, with a tried tile and the wrong-answer message").toEqual([]);

        await page.locator(".mcf-tile", { hasText: "Telnet" }).click();
        await expect(confirmOpen(page)).toBeVisible();
        await expect(page.locator(".mcf-tile.is-chosen")).toHaveCount(1);
        await settleFiniteAnimations(page);
        expect(await scan("#modal-box"), "the confirm naming the answer").toEqual([]);
        await page.locator("#modal-cancel-btn").click();
      } finally { await ctx.close(); }
    });
  }

  test("a solved, an exhausted and a finished challenge keep today's review card at phone size", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { cap: 1, tasks: [{ choices: SHORT }, { choices: SHORT }, { choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      const pick = async (taskId, text) => (await choiceIdsFor(page, taskId)).find((o) => o.text === text).id;
      expect((await pageSubmit(page, ids[0], [await pick(ids[0], "HTTPS")])).ok()).toBeTruthy();   // solved
      expect((await pageSubmit(page, ids[1], [await pick(ids[1], "FTP")])).ok()).toBeTruthy();     // exhausted (cap 1)

      await openChallenge(page, ids[0]);
      let s = await tapState(page);
      expect(s.mq, "precondition: the device matches").toBe(true);
      expect(s.tap, "solved → the standard card").toBe(false);
      expect(s.review, "with the read-only options").toBe(true);
      expect(s.body).not.toContain("mcf");

      await page.locator('#task-detail-page [data-action="show-main"]').first().click();
      await openChallenge(page, ids[1]);
      s = await tapState(page);
      expect(s.tap, "exhausted → the standard card").toBe(false);
      await expect(page.locator(".attempts-exhausted")).toBeVisible();
      expect(s.body).not.toContain("mcf");
    } finally { await ctx.close(); }

    // Finished: the event ends for an ORIGINAL member, so the third challenge is
    // reviewed, not answered. Moving the end into the past re-times the event, so
    // the join is back-dated too: somebody who joined within ten minutes of the end
    // IS a late entrant (v8.6.0) and may still play, which is the arm above.
    const end = await expireEvent(comp.id);
    rawSetAssignedAt(comp.id, p.id, new Date(end.getTime() - 50 * 60_000).toISOString());
    const ctx2 = await deviceContext(browser);
    const page2 = await ctx2.newPage();
    try {
      const t0 = (await (await page2.request.get("/api/csrf-token")).json()).csrfToken;
      expect((await codeLogin(page2.request, p.email, H(t0))).ok()).toBeTruthy();
      const t1 = (await (await page2.request.get("/api/csrf-token")).json()).csrfToken;
      expect((await page2.request.post("/api/select-competition", { headers: H(t1), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      await page2.request.post("/api/dismiss-ended", { headers: H(t1), data: {} });
      await page2.goto("/");
      await page2.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 30000 });
      await openChallenge(page2, ids[2]);
      const s = await tapState(page2);
      expect(s.tap, "ended → the standard card").toBe(false);
      expect(s.review).toBe(true);
      expect(s.body).not.toContain("mcf");
    } finally { await ctx2.close(); }
  });

  test("the editor stops at 20 choices, says so, and lets one go again", async ({ page }) => {
    await page.context().clearCookies();
    const t0 = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
    const li = await page.request.post(`${BASE}/api/login`, { headers: H(t0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(li.ok()).toBeTruthy();
    await page.goto(`${BASE}/`);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("button[data-tab-id='admin-tasks-tab']").click();
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#tf-atype").selectOption("choice");
    const rows = page.locator("#tf-choices-list .choice-row");
    const add = page.locator("#tf-add-choice");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#tf-choices-cap-note")).toBeHidden();
    for (let i = 2; i < 20; i++) await add.click();
    await expect(rows).toHaveCount(20);
    await expect(add, "the 21st is refused before it is offered").toBeDisabled();
    await expect(page.locator("#tf-choices-cap-note")).toBeVisible();
    await expect(page.locator("#tf-choices-cap-note")).toHaveText("That is the most a question can have: 20 choices.");
    await page.locator("#tf-choices-list [data-action='task-choice-remove']").last().click();
    await expect(rows).toHaveCount(19);
    await expect(add).toBeEnabled();
    await expect(page.locator("#tf-choices-cap-note")).toBeHidden();
  });

  test("SOURCE: the layout is decided by the policy (never the kind); the editor cap mirrors the server; hover is gated", () => {
    // 1. No tap-mode code decides by event kind.
    const tap = stripJs(read("public/js/features/choice-tap.js"));
    expect(tap, "choice-tap.js reads the wire policy, not event_kind").not.toMatch(/event_kind|eventKind/);
    expect(tap).not.toMatch(/["'`]booth["'`]/);
    expect(tap, "and it does read the policy key").toMatch(/choice_layout\s*!==\s*'tap'|choice_layout\s*===\s*'tap'/);
    const pt = stripJs(read("public/js/features/participant-tasks.js"));
    const tapRegion = pt.slice(pt.indexOf("export async function tapChoice"), pt.indexOf("export function tapChoiceToggled") + 400);
    expect(tapRegion.length, "anti-vacuity: the tap handlers were found").toBeGreaterThan(400);
    expect(tapRegion).not.toMatch(/event_kind|["'`]booth["'`]/);

    // 2. The policy key: one value per kind, on the wire, with a "standard" default.
    const pol = stripJs(read("lib/event-policy.js"));
    const kinds = pol.match(/choiceLayout\s*:\s*"(tap|standard)"/g) || [];
    expect(kinds.length, "every kind decides its choice layout").toBeGreaterThanOrEqual(3);
    expect(kinds.filter((k) => k.includes('"tap"')).length, "exactly one kind taps").toBe(1);
    expect(pol).toMatch(/choice_layout\s*:\s*p\.choiceLayout/);
    expect(stripJs(read("public/js/ui/format.js"))).toMatch(/choice_layout\s*:\s*["']standard["']/);

    // 3. The editor's cap is the server's (an irreducible client copy).
    const srv = read("lib/choices.js").match(/const\s+MAX_CHOICES\s*=\s*(\d+)/);
    const cli = read("public/js/features/challenges-admin.js").match(/export\s+const\s+TF_MAX_CHOICES\s*=\s*(\d+)/);
    expect(srv && cli, "both caps are declared").toBeTruthy();
    expect(Number(cli[1]), "the editor stops where the server does").toBe(Number(srv[1]));

    // 4. A tile's or an option's hover never sticks on a touch screen: every such
    //    rule sits inside @media(hover:hover).
    const css = read("public/styles.css").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const enclosing = (idx) => {
      const heads = []; let depth = 0;
      for (let i = idx; i >= 0; i--) {
        if (css[i] === "}") depth++;
        else if (css[i] === "{") {
          if (depth === 0) {
            const start = Math.max(css.lastIndexOf("}", i - 1), css.lastIndexOf(";", i - 1), css.lastIndexOf("{", i - 1)) + 1;
            heads.push(css.slice(start, i).trim());
          } else depth--;
        }
      }
      return heads;
    };
    let seen = 0;
    for (const sel of [".mcf-tile:hover", ".choice-option:hover"]) {
      let at = css.indexOf(sel);
      while (at !== -1) {
        seen++;
        const heads = enclosing(at);
        expect(heads.some((h) => /@media[^{]*hover\s*:\s*hover/.test(h)), `${sel} at offset ${at} must be inside @media(hover:hover); enclosed by: ${JSON.stringify(heads)}`).toBe(true);
        at = css.indexOf(sel, at + 1);
      }
    }
    expect(seen, "anti-vacuity: the hover rules were found").toBeGreaterThanOrEqual(2);
  });
});

test.describe("v8.13.1 — a lost answer's retry on the tap card", () => {
  test("the fold carries the count: the bar, the instruction and the NEXT confirm all say it is the last attempt", async ({ browser }) => {
    // The external auditor's finding, on the surface it was reported against. A
    // booth walk-up's answer reaches the server and spends the second-to-last
    // attempt, but its response is lost on the venue wi-fi; they tap the same
    // tile again, and the server folds the repeat into the original. Until
    // v8.13.1 the fold carried no count, so the card went on saying "2 of 2" with
    // one left — and the NEXT confirm, which reads `data-attempts-left`, omitted
    // the "This is your last attempt" warning before the answer that locks it.
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { cap: 2, tasks: [{ title: "Lost protocol", choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      expect((await tapState(page)).tap, "precondition: the phone gets the tap card").toBe(true);
      const card = page.locator("#task-detail-card");
      const bar = page.locator(".mcf-meta-2");
      await expect(card).toHaveAttribute("data-attempts-left", "2");
      await expect(bar).toHaveText("2 of 2 attempts left");

      // The answer REACHES the server (route.fetch) and is graded; only then does
      // the browser see a failure (route.abort). Dropping it before the server
      // would leave nothing to fold. Later requests pass through untouched.
      const lost = { body: null, at: 0 };
      let used = false;
      await page.route(`**/api/tasks/${ids[0]}/submit`, async (route) => {
        if (used) return route.continue();
        used = true;
        const resp = await route.fetch();
        lost.body = await resp.json().catch(() => null);
        lost.at = Date.now();
        await route.abort("failed");
      });
      await page.locator(".mcf-tile", { hasText: "FTP" }).click();
      await expect(confirmOpen(page)).toBeVisible();
      // CONTROL for the warning: with two left this confirm must NOT warn, or the
      // assertion at the end is satisfied by a confirm that always does.
      await expect(page.locator("#modal-box .mcf-confirm-last"), "control: two left, no last-attempt warning").toHaveCount(0);
      await page.waitForTimeout(450);   // the confirm arms 400 ms after it opens
      await page.locator("#modal-confirm-btn").click();
      await expect(confirmOpen(page)).toHaveCount(0);
      await expect(page.locator("#submit-result"), "precondition: the browser saw a failure")
        .toContainText(/could not be sent/i, { timeout: 15000 });
      expect(lost.body && lost.body.attempts_left, "precondition: the lost answer WAS graded, and charged").toBe(1);
      await expect(card, "precondition: the card still believes two are left").toHaveAttribute("data-attempts-left", "2");
      await expect(page.locator(".mcf-tile.is-tried"), "precondition: a failed send leaves the tile tappable").toHaveCount(0);

      // The retry: the same tile, inside the server's three-second fold window.
      const replyP = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/api/tasks/${ids[0]}/submit`));
      await answer(page, "FTP");
      const d = await (await replyP).json();
      expect(d.deduped, `precondition: the retry is folded (sent ${Date.now() - lost.at} ms after the lost answer was graded; the window is 3000 ms)`).toBe(true);
      expect(d.attempts_left, "precondition: the server reports the real standing").toBe(1);

      // The COUNT first: it is the finding, so it is what an unfixed build fails on.
      await expect(card, "the card takes the server's count").toHaveAttribute("data-attempts-left", "1");
      await expect(bar).toHaveText("Last attempt");
      await expect(bar).toHaveClass(/mcf-last/);
      await expect(page.locator("#mcf-howto")).toContainText("This is your last attempt.");
      const msg = page.locator("#submit-result .result-msg");
      await expect(msg, "a fold is not a graded wrong answer").toHaveClass(/notice/);
      await expect(msg).toContainText("already submitted a moment ago and was not correct");
      await expect(msg).toContainText("1 attempt left.");
      await expect(msg, "a fold charged nothing").not.toContainText(/penalty/i);
      await expect(page.locator(".mcf-tile.is-tried", { hasText: "FTP" }), "the folded answer's tile is marked, as a wrong one is").toHaveCount(1);

      // THE FINDING ITSELF: the next confirm warns before the irreversible answer.
      await page.locator(".mcf-tile", { hasText: "Telnet" }).click();
      await expect(confirmOpen(page)).toBeVisible();
      await expect(page.locator("#modal-box .mcf-confirm-last"), "the next confirm says it is the last attempt")
        .toContainText("This is your last attempt");
      await page.locator("#modal-cancel-btn").click();
      await expect(confirmOpen(page)).toHaveCount(0);
    } finally { await ctx.close(); }
  });
});
