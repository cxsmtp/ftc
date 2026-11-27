// @ts-check
//
// The participant's answer box is sized in proportion to the question.
//
// A participant reads the question on the left (one column on a phone) and
// answers on the right. The answer control must not dwarf the question: a text
// answer is one line, a JSON answer a moderate monospace area (it grows with
// what is typed, up to a ceiling), a file answer a compact drop zone, and the
// Submit button sits right under the control — on screen without scrolling at
// common desktop sizes, and on a phone on the fixed bar at the thumb with
// nothing it covers. Nothing scrolls sideways, and on a phone the typing
// surface is at least 16 px (smaller zooms the page on iOS).
//
// On a phone the Submit bar also rides above the on-screen keyboard while the
// answer is typed (a stubbed visual viewport stands in for the keyboard).
//
// Measured as GEOMETRY, never markup (CLAUDE.md, Recurring rules — layout
// defects are locked as edges, widths and distances at real viewports).
//
// Before/after screenshots for a review: ANSWER_BOX_SHOTS=<dir>
// ANSWER_BOX_PHASE=<before|after> writes answer-<phase>-<type>-<w>x<h>.png.
const path = require("path");
const { test, expect } = require("./isolated-test");
const {
  H, uniq, sa, SHORT, eventWithChoices, participantIn, deviceContext, signInTo,
} = require("./booth-choice-tap-fixture");

const SHOTS = process.env.ANSWER_BOX_SHOTS || "";
const PHASE = process.env.ANSWER_BOX_PHASE || "shot";

// A question of ordinary length, the shape a real challenge has.
const DESC = "<p>The service below signs session tokens. Read the snippet, work out which header the attacker controls, and give the value that makes the server accept a forged token.</p><pre><code>if (req.headers['x-forwarded-user']) {\n  user = req.headers['x-forwarded-user'];\n}</code></pre>";

const TYPES = {
  text: { answer_type: "text", correct_answer: "admin" },
  json: { answer_type: "json", correct_answer: '{"user":"admin"}' },
  file: { answer_type: "file", correct_answer: "admin" },
  choice: { answer_type: "choice", choices: SHORT },
  any: { answer_type: "any", correct_answer: "" },
};

const VIEWPORTS = [[1440, 900], [1280, 720], [1024, 768], [390, 844], [360, 740]];

let fx;
test.beforeAll(async () => {
  const { api, csrf } = await sa();
  try {
    // A LIVE tournament holding one challenge of each answer type. Nobody
    // submits, and an idle second participant is enrolled, so nothing can
    // auto-end the event under the test (fixture checklist item 1).
    const create = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `ABP ${uniq()}`, event_kind: "tournament",
        start_time: new Date(Date.now() - 3600e3).toISOString(),
        timezone: "UTC", duration_minutes: 600,
      },
    });
    expect(create.ok(), `create event: ${await create.text()}`).toBeTruthy();
    const comp = (await create.json()).competition;
    const ids = {};
    for (const [type, spec] of Object.entries(TYPES)) {
      const r = await api.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title: `Forge the session token (${type})`, description: DESC, difficulty: "medium", status: "published", ...spec },
      });
      expect(r.ok(), `create ${type} challenge: ${await r.text()}`).toBeTruthy();
      ids[type] = (await r.json()).id;
      const a = await api.post(`/api/admin/tasks/${ids[type]}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      expect(a.ok(), `assign ${type}: ${await a.text()}`).toBeTruthy();
      expect((await a.json()).assigned, `the ${type} challenge is really assigned`).toBe(1);
    }
    const p = await participantIn(api, csrf, comp.id, `abp${uniq()}`);
    await participantIn(api, csrf, comp.id, `abpidle${uniq()}`);
    // The Booth Event, for the phone's tap layout.
    const booth = await eventWithChoices(api, csrf, { tasks: [{ title: "Which transport encrypts the session?" }] });
    const bp = await participantIn(api, csrf, booth.comp.id, `abpb${uniq()}`);
    fx = { comp, ids, p, booth, bp };
  } finally { await api.dispose(); }
});

/** Open a challenge in place and wait for its answer column to paint. */
async function open(page, id) {
  await page.evaluate((tid) => window.openTask(tid), id);
  await page.locator("#task-detail-page.active #task-detail-card.qa-card .qa-answer .qa-submit").waitFor({ state: "visible", timeout: 15000 });
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
  // Let the textarea's fit and the fonts settle before anyone measures.
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
}

/** Everything one assertion needs, in ONE evaluate (one frame). */
function measure(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement;
    const box = (el) => (el && el.getClientRects().length ? el.getBoundingClientRect().toJSON() : null);
    const ctl = document.querySelector("#task-detail-card #ans-text, #task-detail-card #ans-file, #task-detail-card .choice-fieldset");
    return {
      innerH: innerHeight, innerW: innerWidth, scrollW: se.scrollWidth, clientW: se.clientWidth,
      ctl: box(ctl), ctlTag: ctl && ctl.tagName,
      ctlFs: ctl ? parseFloat(getComputedStyle(ctl).fontSize) : null,
      sub: box(document.querySelector("#task-detail-card .qa-submit")),
      row: box(document.querySelector("#task-detail-card .qa-submit-row")),
      rowPos: getComputedStyle(document.querySelector("#task-detail-card .qa-submit-row")).position,
      question: box(document.querySelector("#task-detail-card .qa-question")),
      answer: box(document.querySelector("#task-detail-card .qa-answer")),
      title: box(document.querySelector("#task-detail-card .qa-title")),
    };
  });
}

/** Bottom of the page: what the fixed bar might hide is now in view. */
function measureAtBottom(page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.scrollingElement.scrollHeight);
    const ctl = document.querySelector("#task-detail-card #ans-text, #task-detail-card #ans-file, #task-detail-card .choice-fieldset");
    const res = document.querySelector("#task-detail-card #submit-result");
    const row = document.querySelector("#task-detail-card .qa-submit-row");
    const last = ctl.getBoundingClientRect().bottom;
    const out = { ctlBottom: last, resBottom: res ? res.getBoundingClientRect().bottom : null, rowTop: row.getBoundingClientRect().top };
    window.scrollTo(0, 0);
    return out;
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `answer-${PHASE}-${name}.png`) });
}

for (const [w, h] of VIEWPORTS) {
  const phone = w < 768;
  test(`every answer type is in proportion at ${w}x${h}`, async ({ browser }) => {
    const ctx = await deviceContext(browser, { width: w, height: h, touch: phone, theme: "light" });
    const page = await ctx.newPage();
    try {
      await signInTo(page, fx.p.email, fx.comp.id);
      // Read every type first (and shoot it), then judge: a failure on one type
      // still leaves the evidence for all of them.
      const seen = {};
      for (const type of Object.keys(TYPES)) {
        await open(page, fx.ids[type]);
        await shot(page, `${type}-${w}x${h}`);
        seen[type] = { m: await measure(page), b: phone ? await measureAtBottom(page) : null };
      }
      if (SHOTS) require("fs").writeFileSync(path.join(SHOTS, `answer-${PHASE}-metrics-${w}x${h}.json`), JSON.stringify(seen, null, 1));
      for (const type of Object.keys(TYPES)) {
        const { m, b } = seen[type];
        const why = `${type} at ${w}x${h}: ${JSON.stringify(m)}`;
        expect(m.ctl, `the answer control renders (${why})`).not.toBeNull();
        expect(m.scrollW, `nothing scrolls sideways (${why})`).toBeLessThanOrEqual(m.clientW + 1);
        expect(m.ctl.right, `the control is not clipped on the right (${why})`).toBeLessThanOrEqual(m.innerW + 0.5);
        expect(m.ctl.left, `the control is not clipped on the left (${why})`).toBeGreaterThanOrEqual(-0.5);
        // The submit button: wholly on screen, without scrolling, at every size.
        expect(m.sub.top, `Submit starts on screen (${why})`).toBeGreaterThanOrEqual(0);
        expect(m.sub.bottom, `Submit ends on screen (${why})`).toBeLessThanOrEqual(m.innerH + 0.5);
        expect(m.sub.height, `Submit is a full touch target (${why})`).toBeGreaterThanOrEqual(44);

        // The control's own size, per type.
        if (type === "text" || type === "any") {
          expect(m.ctlTag).toBe("INPUT");
          expect(m.ctl.height, `a text answer is one line (${why})`).toBeLessThanOrEqual(56);
          expect(m.ctl.height, `and still a comfortable target (${why})`).toBeGreaterThanOrEqual(44);
        } else if (type === "json") {
          expect(m.ctlTag).toBe("TEXTAREA");
          expect(m.ctl.height, `the JSON area is moderate (${why})`).toBeLessThanOrEqual(Math.min(220, h * 0.3));
          expect(m.ctl.height, `and holds a few lines (${why})`).toBeGreaterThanOrEqual(96);
        } else if (type === "file") {
          expect(m.ctl.height, `the file drop zone is compact (${why})`).toBeLessThanOrEqual(96);
          expect(m.ctl.height, `and is a real target (${why})`).toBeGreaterThanOrEqual(48);
        }
        if (type !== "choice") {
          expect(m.ctlFs, `the typing surface is at least 16 px (${why})`).toBeGreaterThanOrEqual(16);
        }

        if (!phone) {
          // Two columns: the answer column sits beside the question, never
          // wider than it, and Submit follows its control closely.
          expect(m.answer.left, `the answer column is beside the question (${why})`).toBeGreaterThan(m.question.right);
          expect(m.answer.width, `the answer column is not wider than the question (${why})`).toBeLessThanOrEqual(m.question.width + 1);
          expect(m.sub.top - m.ctl.bottom, `Submit is adjacent to its control (${why})`).toBeLessThanOrEqual(64);
          expect(m.sub.top, `Submit is below its control (${why})`).toBeGreaterThanOrEqual(m.ctl.bottom);
        } else {
          // One column; Submit rides the fixed bar at the thumb.
          expect(m.rowPos, `the submit bar is fixed on a phone (${why})`).toBe("fixed");
          expect(m.row.bottom, `the bar sits on the bottom edge (${why})`).toBeGreaterThan(m.innerH - 2);
          // Scrolled to the end, nothing the participant needs is under the bar.
          expect(b.ctlBottom, `the control clears the fixed bar (${why} ${JSON.stringify(b)})`).toBeLessThanOrEqual(b.rowTop);
          if (type !== "choice") {
            // The control is visible in the first screen, under the question.
            expect(m.ctl.top, `the control is reachable on the first screen (${why})`).toBeLessThan(m.row.top + 1);
          }
        }
      }

      // The JSON area grows with what is typed and stops at its ceiling.
      await open(page, fx.ids.json);
      const area = page.locator("#ans-text");
      const h0 = (await area.boundingBox()).height;
      await area.fill(JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: "e" } }, null, 2));
      await expect.poll(async () => (await area.boundingBox()).height, { message: "the area grows to fit the answer" }).toBeGreaterThan(h0 + 8);
      await area.fill("{\n" + Array.from({ length: 80 }, (_, i) => `  "k${i}": ${i},`).join("\n") + "\n}");
      await expect.poll(async () => (await area.boundingBox()).height, { message: "and stops at its ceiling" })
        .toBeLessThanOrEqual(Math.round(h * 0.45) + 2);
      expect(await area.evaluate((el) => el.scrollHeight > el.clientHeight), "the rest scrolls inside the area").toBe(true);
      await area.fill("");
      await expect.poll(async () => Math.round((await area.boundingBox()).height), { message: "and shrinks back when cleared" })
        .toBeLessThanOrEqual(Math.round(h0) + 1);
    } finally { await ctx.close(); }
  });
}

test("the Booth tap layout on a phone still fits one screen, Submit-free", async ({ browser }) => {
  const ctx = await deviceContext(browser, { width: 390, height: 844, touch: true, theme: "light" });
  const page = await ctx.newPage();
  try {
    await signInTo(page, fx.bp.email, fx.booth.comp.id);
    await page.evaluate((tid) => window.openTask(tid), fx.booth.ids[0]);
    await page.locator("#task-detail-card.mcf-card .mcf-tile").first().waitFor({ state: "visible", timeout: 15000 });
    await shot(page, "booth-tap-390x844");
    const s = await page.evaluate(() => {
      const se = document.scrollingElement;
      const tiles = [...document.querySelectorAll(".mcf-options .mcf-tile")].map((t) => t.getBoundingClientRect().toJSON());
      return { scrollW: se.scrollWidth, clientW: se.clientWidth, scrollH: se.scrollHeight, innerH: innerHeight, tiles };
    });
    expect(s.tiles.length, "precondition: the tap card rendered its four tiles").toBe(4);
    expect(s.scrollW, "nothing scrolls sideways").toBeLessThanOrEqual(s.clientW + 1);
    expect(s.scrollH, "one screen").toBeLessThanOrEqual(s.innerH);
    for (const t of s.tiles) {
      expect(t.bottom, "every tile on screen").toBeLessThanOrEqual(s.innerH);
      expect(t.height, "every tile a big target").toBeGreaterThanOrEqual(56);
    }
  } finally { await ctx.close(); }
});

// THE SUBMIT BAR RIDES ABOVE THE ON-SCREEN KEYBOARD (participant-tasks.js
// `_keyboardLift`, the phone stylesheet's `bottom: var(--qa-kb)`). An open
// keyboard shrinks only the VISUAL viewport, which a test browser never does on
// its own, so `window.visualViewport` is replaced before the app loads by a stub
// whose height and offset the test sets, firing the `resize` the app listens to.
// The lift applies only while the answer field has focus (a pinch-zoom also
// shrinks the visual viewport) and only past 40 px (a browser's toolbar moving
// is not a keyboard).
test("on a phone the Submit bar rides above the on-screen keyboard, only while the answer is being typed", async ({ browser }) => {
  const ctx = await deviceContext(browser, { width: 390, height: 844, touch: true, theme: "light" });
  await ctx.addInitScript(() => {
    const vv = new EventTarget();
    let h = null, top = 0;
    Object.defineProperties(vv, {
      height: { get: () => (h == null ? innerHeight : h) }, width: { get: () => innerWidth },
      offsetTop: { get: () => top }, offsetLeft: { value: 0 }, pageTop: { get: () => top + scrollY }, pageLeft: { value: 0 }, scale: { value: 1 },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
    window.__vvSet = (hh, tt = 0) => { h = hh; top = tt; vv.dispatchEvent(new Event("resize")); };
  });
  const page = await ctx.newPage();
  try {
    await signInTo(page, fx.p.email, fx.comp.id);
    await open(page, fx.ids.text);
    const read = () => page.evaluate(() => ({
      kb: document.documentElement.style.getPropertyValue("--qa-kb"),
      bottom: document.querySelector("#task-detail-card .qa-submit-row").getBoundingClientRect().bottom,
      innerH: innerHeight,
    }));
    expect((await read()).innerH, "PRECONDITION: the phone's viewport").toBe(844);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#task-detail-card .qa-submit-row")).position), "PRECONDITION: the fixed bar").toBe("fixed");

    // Typing, the keyboard opens and takes 300 px: the bar sits on its top edge.
    await page.locator("#ans-text").focus();
    await page.evaluate(() => window.__vvSet(544));
    await expect.poll(read, { message: "lifted by the keyboard's height" }).toEqual({ kb: "300px", bottom: 544, innerH: 844 });

    // CONTROL — the field loses focus (the keyboard is closing): back on the bottom edge.
    await page.evaluate(() => document.activeElement.blur());
    await expect.poll(read, { message: "not typing: the bar is on the bottom edge" }).toEqual({ kb: "0px", bottom: 844, innerH: 844 });

    // CONTROL — the visual viewport shrinks with focus elsewhere (a pinch-zoom).
    await page.evaluate(() => { document.body.setAttribute("tabindex", "-1"); document.body.focus(); window.__vvSet(500); });
    await expect.poll(read, { message: "a zoom with focus elsewhere does not float the bar" }).toEqual({ kb: "0px", bottom: 844, innerH: 844 });

    // CONTROL — typing, a 30 px gap (a toolbar, not a keyboard) moves nothing.
    await page.evaluate(() => window.__vvSet(844));
    await page.locator("#ans-text").focus();
    await page.evaluate(() => window.__vvSet(814));
    await expect.poll(read, { message: "under 40 px is not a keyboard" }).toEqual({ kb: "0px", bottom: 844, innerH: 844 });
    // …and the same focus with a real keyboard's gap still lifts it (the control that focus took).
    await page.evaluate(() => window.__vvSet(544));
    await expect.poll(read, { message: "the keyboard lifts it again" }).toEqual({ kb: "300px", bottom: 544, innerH: 844 });
  } finally { await ctx.close(); }
});
