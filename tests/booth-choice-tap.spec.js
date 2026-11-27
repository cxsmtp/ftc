// v8.13.0 — a Booth Event's multiple-choice challenge, on a phone, is ONE screen
// of answer tiles; a tap opens the existing penalty confirm, naming the answer.
//
// What this file pins, and what each control is for:
//   • the view itself — no page scroll, the tiles inside the viewport, the header
//     / nav / footer gone and the countdown moved into the bar (and back again);
//   • WHO gets it — the event's wire policy (`choice_layout`), never its kind, on
//     a device the shared media query matches. Every positive has a control: the
//     same challenge in a Competition, and the same Booth Event on a desktop,
//     keep today's card, or "tiles render" is satisfied by a build that renders
//     them for everybody;
//   • the answer flow — nothing is sent until the confirm, the confirm names the
//     option (escaped), a double tap cannot be the confirmation, a wrong tile is
//     marked and cannot be re-sent, the attempts and the last-attempt warning
//     follow the server, a correct answer leaves the view and restores the chrome.
//
// Most expectations come from `matchMedia(window.CHOICE_TAP_MQ)`, never from a
// project name: the device query is the one thing the client asks. The query
// ITSELF is pinned by a fixed table of sizes and inputs ("the device query…").
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const {
  sa, SHORT, SQL_Q, eventWithChoices, participantIn, deviceContext, signInTo,
  openChallenge, tapState, countSubmits, pageSubmit, choiceIdsFor, H,
} = require("./booth-choice-tap-fixture");

const confirmOpen = (page) => page.locator("#modal-overlay.open");

test.describe("v8.13.0 — the booth tap-to-answer view", () => {
  test("one screen at 390x664: no page scroll, tiles in view, chrome hidden, countdown in the bar", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [SQL_Q] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser, { width: 390, height: 664 });
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      expect(s.mq, "precondition: a 390px touch screen matches the device query").toBe(true);
      expect(s.tap, "the tap card renders").toBe(true);
      expect(s.body, "the compact chrome and the fixed chain are both on").toMatch(/\bmcf\b.*\bmcf-fixed\b|\bmcf-fixed\b.*\bmcf\b/);
      expect(s.fit).toBe("fixed");
      expect(s.scrollH, "the PAGE does not scroll").toBeLessThanOrEqual(s.innerH);
      expect(s.lastBottom, "the last tile is inside the viewport").toBeLessThanOrEqual(s.innerH);
      expect(s.tileCount).toBe(4);
      for (const h of s.tileHeights) expect(h, "every tile is a big target").toBeGreaterThanOrEqual(56);
      expect(s.headerShown, "header hidden").toBe(false);
      expect(s.navShown, "bottom nav hidden").toBe(false);
      expect(s.footerShown, "footer hidden").toBe(false);
      expect(s.timerInBar, "the countdown is MOVED into the bar").toBe(true);
      expect(s.timerInHeader).toBe(false);
      // The penalty is stated before the first tap.
      await expect(page.locator("#mcf-howto")).toContainText("5 points");
      // Letters, in the order this participant sees the options.
      await expect(page.locator(".mcf-tile .mcf-letter")).toHaveText(["A", "B", "C", "D"]);
    } finally { await ctx.close(); }
  });

  for (const [w, h] of [[360, 560], [320, 568]]) {
    test(`short options fit one screen on a small phone (${w}x${h})`, async ({ browser }) => {
      const { api, csrf } = await sa();
      const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ title: "Which protocol encrypts web traffic?", choices: SHORT }] });
      const p = await participantIn(api, csrf, comp.id);
      const ctx = await deviceContext(browser, { width: w, height: h });
      const page = await ctx.newPage();
      try {
        await signInTo(page, p.email, comp.id);
        await openChallenge(page, ids[0]);
        const s = await tapState(page);
        expect(s.mq).toBe(true);
        expect(s.tap).toBe(true);
        expect(s.fit, `measured fit at ${w}x${h}`).toBe("fixed");
        expect(s.scrollH).toBeLessThanOrEqual(s.innerH);
        expect(s.lastBottom).toBeLessThanOrEqual(s.innerH);
        expect(s.scrollW, "no sideways scroll").toBeLessThanOrEqual(s.clientW);
      } finally { await ctx.close(); }
    });
  }

  test("a question that needs the smaller text step still fits one screen (320x568)", async ({ browser }) => {
    // Four two-line options under a short question: too tall at the design size
    // on the smallest phone, one screen once the text steps down. The 2-column
    // variant cannot help (two-line options), so only the text ladder gets here —
    // without it this falls back to scrolling.
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ title: "Pick the safe query", description: "<p>Which one?</p>", choices: SQL_Q.choices }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser, { width: 320, height: 568 });
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      const step = await page.evaluate(() => document.getElementById("task-detail-card").dataset.mcfStep);
      expect(s.fit, "one screen").toBe("fixed");
      expect(["s1", "s2"], `the text stepped down (step ${step})`).toContain(step);
      expect(s.scrollH).toBeLessThanOrEqual(s.innerH);
      expect(s.lastBottom).toBeLessThanOrEqual(s.innerH);
      for (const h of s.tileHeights) expect(h, "a smaller step never goes under the 44px target").toBeGreaterThanOrEqual(44);
    } finally { await ctx.close(); }
  });

  test("content that cannot fit SCROLLS with the same tiles — nothing is clipped", async ({ browser }) => {
    const { api, csrf } = await sa();
    const long = Array.from({ length: 8 }, (_, i) => ({
      text: `Option ${i + 1}: ` + "a deliberately long answer that keeps going well past what fits on one line of a phone ".slice(0, 110),
      ...(i === 0 ? { correct: true } : {}),
    }));
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ title: "A long one", choices: long }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser, { width: 390, height: 664 });
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const s = await tapState(page);
      expect(s.tap, "still the tap card").toBe(true);
      expect(s.fit).toBe("scroll");
      expect(s.body).toContain("mcf");
      expect(s.body, "the fixed chain is released, so the page scrolls").not.toContain("mcf-fixed");
      expect(s.tileCount).toBe(8);
      expect(s.scrollH, "the page really does scroll").toBeGreaterThan(s.innerH);
      expect(s.scrollW, "no sideways scroll").toBeLessThanOrEqual(s.clientW);
      // Every tile's text is fully inside its tile. Measured on the BLOCK boxes:
      // an inline span reports 0 for every scroll and client size, so a check on
      // `.mcf-text-body` could never fail (it passed with every option cut to one
      // line and an ellipsis).
      const boxes = await page.evaluate(() => [...document.querySelectorAll(".mcf-tile, .mcf-text")]
        .map((e) => ({ cw: e.clientWidth, clipped: e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1 })));
      expect(boxes.length, "precondition: tiles and their text boxes").toBe(16);
      expect(boxes.every((b) => b.cw > 0), "precondition: measurable block boxes").toBe(true);
      expect(boxes.filter((b) => b.clipped).length).toBe(0);
    } finally { await ctx.close(); }
  });

  test("CONTROLS: a Competition at phone size and a Booth Event on a desktop keep today's card", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp: comp1, ids: ids1 } = await eventWithChoices(api, csrf, { kind: "tournament", tasks: [SQL_Q] });
    const { comp: comp2, ids: ids2 } = await eventWithChoices(api, csrf, { tasks: [SQL_Q] });
    const p1 = await participantIn(api, csrf, comp1.id);
    const p2 = await participantIn(api, csrf, comp2.id);
    const phone = await deviceContext(browser, { width: 390, height: 664 });
    const desk = await deviceContext(browser, { width: 1280, height: 800, touch: false });
    try {
      const a = await phone.newPage();
      await signInTo(a, p1.email, comp1.id);
      await openChallenge(a, ids1[0]);
      const sa1 = await tapState(a);
      expect(sa1.mq, "precondition: the device DOES match — only the policy differs").toBe(true);
      expect(sa1.tap).toBe(false);
      expect(sa1.radios, "the standard radios").toBe(4);
      expect(sa1.body).not.toContain("mcf");
      // The standard card is the focus view: on a phone its play bar (Back, clock,
      // score) stands in for the app header — the tap view's chrome rules do not apply.
      expect(sa1.playbarShown, "the standard card's play bar").toBe(true);

      const b = await desk.newPage();
      await signInTo(b, p2.email, comp2.id);
      await openChallenge(b, ids2[0]);
      const sb = await tapState(b);
      expect(sb.mq, "precondition: a desktop does not match").toBe(false);
      expect(sb.tap).toBe(false);
      expect(sb.radios).toBe(4);
      // A payload with no policy reads as standard.
      expect(await b.evaluate(() => window.policyOrDefault(undefined).choice_layout)).toBe("standard");
      expect(await b.evaluate(() => window.policyOrDefault({}).choice_layout)).toBe("standard");
    } finally { await phone.close(); await desk.close(); }
  });

  test("the device query, pinned by a fixed table of sizes and inputs", async ({ browser }) => {
    // Every other arm derives its expectation from CHOICE_TAP_MQ itself, so it
    // agrees with whatever the query says; this table is what can disagree.
    // Deleting the portrait-tablet clause, measured, left every other arm green.
    const rows = [
      { w: 390, h: 664, touch: true, tap: true, why: "a phone" },
      { w: 664, h: 390, touch: true, tap: true, why: "a phone on its side" },
      { w: 932, h: 430, touch: true, tap: true, why: "a large phone on its side" },
      { w: 640, h: 1024, touch: true, tap: true, why: "a small tablet upright" },
      { w: 834, h: 1194, touch: true, tap: true, why: "a tablet upright" },
      { w: 1194, h: 834, touch: true, tap: false, why: "a tablet on its side" },
      { w: 1366, h: 768, touch: true, tap: false, why: "a touch laptop" },
      { w: 500, h: 800, touch: false, tap: true, why: "a narrow desktop window" },
      { w: 700, h: 1000, touch: false, tap: false, why: "a desktop window wider than a phone" },
      { w: 1280, h: 800, touch: false, tap: false, why: "a desktop" },
    ];
    const got = [];
    for (const r of rows) {
      const ctx = await browser.newContext({ viewport: { width: r.w, height: r.h }, hasTouch: r.touch, isMobile: r.touch, baseURL: BASE });
      try {
        const page = await ctx.newPage();
        await page.goto("/");
        await page.waitForFunction(() => typeof window.CHOICE_TAP_MQ === "string");
        got.push(`${r.why} ${r.w}x${r.h}: ${await page.evaluate(() => matchMedia(window.CHOICE_TAP_MQ).matches)}`);
      } finally { await ctx.close(); }
    }
    expect(got).toEqual(rows.map((r) => `${r.why} ${r.w}x${r.h}: ${r.tap}`));
  });

  test("a tap opens the confirm NAMING the answer, escaped; Cancel sends nothing", async ({ browser }) => {
    const { api, csrf } = await sa();
    const payload = `<img src=x onerror="window.__bctXss=1">`;
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ title: "Escape check", choices: [{ text: payload }, { text: "Right one", correct: true }, { text: "Third" }] }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      const posts = countSubmits(page);
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const tile = page.locator(".mcf-tile", { hasText: "<img" });
      await expect(tile, "the option text renders as text").toHaveCount(1);
      const letter = await tile.getAttribute("data-letter");
      // A dispatched click, which does NOT focus the tile: on iOS a tapped button
      // is not focused either, so the dialog's own focus return lands on <body>
      // and only the tap handler can put focus back on the tile.
      await tile.dispatchEvent("click");
      await expect(confirmOpen(page)).toBeVisible();
      await expect(page.locator("#modal-title")).toHaveText("Submit this answer?");
      await expect(page.locator("#modal-body .mcf-pick")).toContainText(payload);
      expect(await page.locator("#modal-body img").count(), "the option is TEXT in the confirm").toBe(0);
      // The visible text IS the accessible name (WCAG 2.5.3): no aria-label that
      // says something the button does not show.
      await expect(page.locator("#modal-confirm-btn")).toHaveText(`Submit answer ${letter}`);
      await expect(page.locator("#modal-confirm-btn")).not.toHaveAttribute("aria-label", /.*/);
      await expect(page.locator("#modal-cancel-btn")).toHaveText("Choose again");
      await expect(page.locator("#modal-body")).toContainText("5 points");
      await expect(tile, "the picked tile shows it was picked").toHaveClass(/is-chosen/);

      await page.locator("#modal-cancel-btn").click();
      await expect(confirmOpen(page)).toHaveCount(0);
      await page.waitForTimeout(300);
      expect(posts.n, "Cancel sends NOTHING").toBe(0);
      await expect(tile, "back at rest").not.toHaveClass(/is-chosen/);
      await expect(tile).not.toHaveAttribute("aria-disabled", "true");
      expect(await page.evaluate(() => document.activeElement?.dataset?.letter), "focus is back on the tile").toBe(letter);
      expect(await page.evaluate(() => window.__bctXss), "the payload never ran").toBeUndefined();
    } finally { await ctx.close(); }
  });

  test("a double tap cannot be the confirmation: one dialog, the arm, then one POST", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      const posts = countSubmits(page);
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const wrong = page.locator(".mcf-tile", { hasText: "Telnet" });
      // Two taps in quick succession on the same spot.
      await wrong.dispatchEvent("click");
      await wrong.dispatchEvent("click");
      await expect(confirmOpen(page)).toBeVisible();
      // ONE confirm: a second one would settle the first as a Cancel, whose
      // clean-up un-marks the tile under the dialog that is still asking about it.
      await page.waitForTimeout(100);
      await expect(wrong, "the tile stays marked while its confirm is up").toHaveClass(/is-chosen/);
      // The confirm button inside its 400 ms arm ignores an activation.
      await page.evaluate(() => document.getElementById("modal-confirm-btn").click());
      await page.waitForTimeout(150);
      expect(posts.n, "an activation inside the arm submits nothing").toBe(0);
      await expect(confirmOpen(page), "and the dialog is still up").toBeVisible();
      await page.waitForTimeout(450);
      await page.locator("#modal-confirm-btn").click();
      await expect(page.locator(".mcf-tile.is-tried")).toHaveCount(1);
      expect(posts.n, "exactly one answer was sent").toBe(1);
    } finally { await ctx.close(); }
  });

  test("a wrong tile is marked and cannot be re-sent; the attempts and the last-attempt warning follow the server", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { cap: 3, tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      const posts = countSubmits(page);
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      await expect(page.locator(".mcf-meta-2")).toHaveText("3 of 3 attempts left");
      // The status row is RESERVED: the result message takes the instruction's
      // place without growing it. (The tried tile itself does grow by its "Not
      // correct" line — deliberately, under its text rather than squeezing it — so
      // the row is what is measured, not the tiles' positions.)
      const statusH = () => page.evaluate(() => Math.round(document.querySelector(".mcf-status").getBoundingClientRect().height));
      const before = await statusH();

      const answer = async (text) => {
        await page.locator(".mcf-tile", { hasText: text }).click();
        await expect(confirmOpen(page)).toBeVisible();
        await page.waitForTimeout(450);
        await page.locator("#modal-confirm-btn").click();
        await expect(confirmOpen(page)).toHaveCount(0);
      };
      await answer("FTP");
      const ftp = page.locator(".mcf-tile", { hasText: "FTP" });
      await expect(ftp).toHaveClass(/is-tried/);
      await expect(ftp).toHaveAttribute("aria-disabled", "true");
      await expect(ftp).toContainText("Not correct");
      // NOT dimmed: the global `[aria-disabled="true"]{opacity:.5}` would composite
      // its text below AA, and axe exempts aria-disabled elements from the
      // contrast rule, so only a direct read can see it.
      expect(await ftp.evaluate((e) => getComputedStyle(e).opacity), "a tried tile is not dimmed").toBe("1");
      const msg = page.locator("#submit-result .result-msg.wrong");
      await expect(msg).toContainText("2 attempts left");
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      expect(await statusH(), "the message took the reserved row without growing it").toBe(before);
      // The status row is reserved: the message is on screen and nothing scrolls.
      const s = await tapState(page);
      expect(s.scrollH).toBeLessThanOrEqual(s.innerH);
      const box = await msg.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(s.innerH);
      await expect(page.locator(".mcf-meta-2")).toHaveText("2 of 3 attempts left");

      // Re-tapping the tried tile opens nothing and sends nothing.
      await ftp.click({ force: true });
      await page.waitForTimeout(300);
      await expect(confirmOpen(page)).toHaveCount(0);
      expect(posts.n).toBe(1);

      await answer("Telnet");
      await expect(page.locator(".mcf-meta-2.mcf-last"), "the bar says LAST attempt").toContainText("Last attempt");
      await expect(page.locator("#mcf-howto")).toContainText("This is your last attempt");
      await page.locator(".mcf-tile", { hasText: "Plain HTTP" }).click();
      await expect(confirmOpen(page)).toBeVisible();
      await expect(page.locator("#modal-body"), "the confirm repeats it").toContainText("This is your last attempt");
      await page.waitForTimeout(450);
      await page.locator("#modal-confirm-btn").click();

      // The last wrong answer locks the challenge: the standard locked card
      // replaces the tiles and the full chrome is back.
      await expect(page.locator(".attempts-exhausted")).toBeVisible({ timeout: 10000 });
      const after = await tapState(page);
      expect(after.tap).toBe(false);
      expect(after.body).not.toContain("mcf");
      expect(after.playbarShown, "the standard card's play bar is back").toBe(true);
      expect(after.timerInHeader, "the countdown went back to the header").toBe(true);
    } finally { await ctx.close(); }
  });

  test("a correct answer celebrates, returns to the list and restores the chrome", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      await page.locator(".mcf-tile", { hasText: "HTTPS" }).click();
      await page.waitForTimeout(450);
      await page.locator("#modal-confirm-btn").click();
      await expect(page.getByText("Challenge Solved!")).toBeVisible({ timeout: 10000 });
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator("#tasks-page.active")).toBeVisible();
      const s = await tapState(page);
      expect(s.body).not.toContain("mcf");
      expect(s.headerShown).toBe(true);
      expect(s.timerInHeader).toBe(true);
      // What lines up with the header (the sticky nav, the admin drawer) reads
      // --header-bottom, so it must describe the header actually on screen.
      // (A bare "> 0" held by construction: the publisher never writes a 0.)
      await expect.poll(() => page.evaluate(() => {
        const pub = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom"));
        const box = document.getElementById("app-header").getBoundingClientRect().bottom;
        return Math.abs(pub - box) <= 1 && box > 0;
      }), { message: "the published header edge matches the header on screen" }).toBe(true);
    } finally { await ctx.close(); }
  });

  test("the bar's Back returns to the list, and the countdown goes home", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      await page.getByRole("button", { name: "Back to challenges" }).click();
      await expect(page.locator("#tasks-page.active")).toBeVisible();
      const s = await tapState(page);
      expect(s.body).not.toContain("mcf");
      expect(s.timerInHeader).toBe(true);
      expect(s.headerShown).toBe(true);
      // The node went back to where it was: between the main nav and the day chip.
      const order = await page.evaluate(() => {
        const t = document.getElementById("header-timer");
        return [t.previousElementSibling?.id, t.nextElementSibling?.id];
      });
      expect(order).toEqual(["main-nav", "header-day"]);
    } finally { await ctx.close(); }
  });

  test("several correct answers: tick tiles, Submit names the count, the confirm lists every pick", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, {
      tasks: [{ title: "Which are secrets?", choices: [
        { text: "An API key", correct: true }, { text: "The README" },
        { text: "A database password", correct: true }, { text: "The licence file" }] }],
    });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      const posts = countSubmits(page);
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const btn = page.locator(".mcf-submit");
      await expect(btn).toHaveText("Select your answers");
      await page.locator(".mcf-check", { hasText: "An API key" }).click();
      await page.locator(".mcf-check", { hasText: "The README" }).click();
      await expect(btn).toHaveText("Submit answers (2 selected)");
      await expect(page.locator(".mcf-check.is-checked")).toHaveCount(2);
      const opts = await choiceIdsFor(page, ids[0]);
      const want = opts.filter((o) => /API key|README/.test(o.text)).map((o) => o.id).sort();
      await btn.click();
      await expect(page.locator("#modal-title")).toHaveText("Submit these 2 answers?");
      await expect(page.locator("#modal-body .mcf-pick")).toHaveCount(2);
      await expect(page.locator("#modal-body")).toContainText("Every correct option, and only those, must be selected.");
      await page.waitForTimeout(450);
      await page.locator("#modal-confirm-btn").click();
      await expect(page.locator("#submit-result .result-msg.wrong")).toBeVisible();
      expect(posts.n).toBe(1);
      const sent = JSON.parse(posts.bodies[0].match(/name="answer"\r\n\r\n([^\r]*)/)[1]);
      expect(sent.sort(), "the request carries exactly the ticked ids").toEqual(want);
      // A wrong SET says nothing about which option was wrong: no tile is marked.
      await expect(page.locator(".mcf-tile.is-tried")).toHaveCount(0);
      await expect(page.locator(".mcf-check.is-checked"), "the selection stays").toHaveCount(2);
    } finally { await ctx.close(); }
  });

  test("a repeated answer is not reported as a penalty — in the tap view AND on the standard card", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }, { choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    for (const [label, width, height, touch, taskId] of [["tap", 390, 664, true, ids[0]], ["desktop", 1280, 800, false, ids[1]]]) {
      const ctx = await deviceContext(browser, { width, height, touch });
      const page = await ctx.newPage();
      try {
        await signInTo(page, p.email, comp.id);
        await openChallenge(page, taskId);
        const ftp = (await choiceIdsFor(page, taskId)).find((o) => o.text === "FTP").id;
        // The same wrong answer, a moment ago, from the same session: the server
        // folds the next one into it (3-second window).
        const r = await pageSubmit(page, taskId, [ftp]);
        expect(r.ok(), `${label}: the first answer is graded`).toBeTruthy();
        if (label === "tap") {
          await page.locator(".mcf-tile", { hasText: "FTP" }).click();
        } else {
          await page.locator(".choice-option", { hasText: "FTP" }).click();
          await page.locator('[data-action="task-submit-answer"]').click();
        }
        await page.waitForTimeout(450);
        await page.locator("#modal-confirm-btn").click();
        const res = page.locator("#submit-result .result-msg");
        await expect(res).toHaveClass(/notice/);
        await expect(res).toContainText("already submitted a moment ago");
        await expect(res).not.toContainText("penalty");
      } finally { await ctx.close(); }
    }
  });

  test("a challenge edited under the participant is re-opened, never answered against the old version", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      // An admin changes which option is correct while the card is open — the
      // grading token the card holds no longer matches.
      const list = await (await api.get("/api/admin/tasks")).json();
      const row = (list.tasks || list).find((t) => t.id === ids[0]);
      const ch = JSON.parse(row.choices);
      const put = await api.put(`/api/admin/tasks/${ids[0]}`, {
        headers: H(csrf),
        data: { title: row.title, expectedUpdatedAt: row.updated_at,
          choices: ch.map((c) => ({ id: c.id, text: c.text, correct: c.text === "Plain HTTP" })) },
      });
      expect(put.ok(), `admin edit: ${await put.text()}`).toBeTruthy();
      const refetch = page.waitForRequest((r) => r.method() === "GET" && r.url().endsWith(`/api/tasks/${ids[0]}`));
      await page.locator(".mcf-tile", { hasText: "Telnet" }).click();
      await page.waitForTimeout(450);
      await page.locator("#modal-confirm-btn").click();
      await expect(page.locator(".toast", { hasText: "just updated" })).toBeVisible();
      await refetch;   // the card was re-opened with a fresh token
      await expect(page.locator(".mcf-card"), "still the tap view").toBeVisible();
      await expect(page.locator(".mcf-tile.is-tried"), "nothing was graded, so nothing is marked").toHaveCount(0);
    } finally { await ctx.close(); }
  });

  test("the hint is offered and revealed inside the question area", async ({ browser }) => {
    const { api, csrf } = await sa();
    const { comp, ids } = await eventWithChoices(api, csrf, { tasks: [{ choices: SHORT, hint: "<p>Look for the S.</p>" }] });
    const p = await participantIn(api, csrf, comp.id);
    const ctx = await deviceContext(browser);
    const page = await ctx.newPage();
    try {
      await signInTo(page, p.email, comp.id);
      await openChallenge(page, ids[0]);
      const show = page.locator('.mcf-q [data-action="task-reveal-hint"]');
      await expect(show).toBeVisible();
      // The hint follows the question, as on the standard card, so the reading
      // order (and a screen reader's) is the same; and the question is the
      // screen's one top-level heading, the app header's h1 being hidden here.
      const order = await page.evaluate(() => {
        const desc = document.querySelector(".mcf-q .mcf-desc");
        const hint = document.querySelector(".mcf-q #hint-area");
        const h1s = [...document.querySelectorAll("h1")].filter((h) => h.getClientRects().length);
        return {
          hintAfterDesc: !!(desc.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING),
          titleTag: document.getElementById("mcf-q-title").tagName,
          visibleH1: h1s.map((h) => h.id),
        };
      });
      expect(order).toEqual({ hintAfterDesc: true, titleTag: "H1", visibleH1: ["mcf-q-title"] });
      await show.click();
      await expect(confirmOpen(page)).toBeVisible();
      await page.locator("#modal-confirm-btn").click();
      await expect(page.locator(".mcf-q #hint-area")).toContainText("Look for the S.");
      const s = await tapState(page);
      expect(s.fit, "still one screen with the hint revealed").toBe("fixed");
      expect(s.scrollH, "the page does not scroll").toBeLessThanOrEqual(s.innerH);
    } finally { await ctx.close(); }
  });
});
