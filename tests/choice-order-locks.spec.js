// @ts-check
//
// v8.14.5 — THE OPTION ORDER, from the shuffle to what the participant's card draws.
//
// The server half (shuffled, per person, stable, a true permutation) already had
// locks. What did not: the shuffle varying by CHALLENGE, its exact draw, the
// impersonation seat, and every browser surface — the card, the review, the
// marks on it, the single/multi fallback, the grading-token race. Each test was
// written against a mutation that survived the whole suite before it existed
// (named in its comment), and was seen failing with that mutation applied.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const {
  H, uniq, storedIds, makeTier, asPlayer, mkChoice, liveEvent, playerIn, readTask,
} = require("./choice-locks-fixture");
const { signInTo, openChallenge, pageSubmit, choiceIdsFor } = require("./booth-choice-tap-fixture");

test.use({ baseURL: BASE });

const tagOf = (label) => uniq(label).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
const ten = (T) => Array.from({ length: 10 }, (_, i) => ({ text: `Opt${i}_${T}`, ...(i === 0 ? { correct: true } : {}) }));

/** Options whose text is markup or carries quotes: they must render as typed. */
const markupOptions = (T) => [
  { text: `<b>bold ${T}</b>`, correct: true },
  { text: `a<b ${T}` },
  { text: `He said "yes" & left ${T}` },
  { text: `<img src=x onerror="window.__xss=1">${T}` },
  { text: `Plain one ${T}` }, { text: `Plain two ${T}` }, { text: `Plain three ${T}` }, { text: `Plain four ${T}` },
];

test.describe("v8.14.5 — the option order a participant sees", () => {
  test("the shuffle: its golden order, an inclusive draw, and a different order per challenge", async () => {
    // Survived before: the draw `% (i + 1)` → `% i` (Sattolo: nothing keeps its
    // place, and every 2-option challenge reads reversed for everyone), and the
    // seed dropping the task id (one participant, one order for every challenge).
    // A changed draw also reorders every participant's options on deploy.
    const { shuffleChoicesFor } = require("../lib/choices");
    const opts = (n) => Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(97 + i).repeat(8), text: `T${i}` }));
    const order = (n, u, t) => shuffleChoicesFor(opts(n), u, t).map((c) => c.id[0]).join("");
    expect(order(4, "u1", "t1"), "golden: 4 options").toBe("cbda");
    expect(order(20, "u1", "t1"), "golden: 20 options").toBe("fjktaehbqdrmcpognlsi");

    const users = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const asAuthored = users.filter((u) => order(2, u, "t1") === "ab").length;
    expect(asAuthored, "a 2-option challenge shows the author order to about half").toBeGreaterThan(60);
    expect(asAuthored).toBeLessThan(140);
    expect(users.filter((u) => order(4, u, "t1")[0] === "a").length, "an option can keep its place").toBeGreaterThan(20);

    const perTask = new Set(Array.from({ length: 20 }, (_, i) => order(10, "u1", `t${i}`)));
    expect(perTask.size, "one participant, twenty challenges, twenty orders").toBe(20);
  });

  test("one participant sees two identically-worded challenges in different orders", async () => {
    // The route half of the per-challenge key: shuffleChoicesFor(…, task.id).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("twin");
    const a = await mkChoice(sa, csrf, ten(T));
    const b = await mkChoice(sa, csrf, ten(T));
    const ev = await liveEvent(sa, csrf, "twin", [a, b]);
    const p = await playerIn(sa, csrf, "twin", [ev.id]);
    const s = await asPlayer(p.email, ev.id);
    const textsOf = async (id) => (await readTask(s.api, id)).choices.map((c) => c.text);
    const [oa, ob] = [await textsOf(a), await textsOf(b)];
    expect([...oa].sort(), "PRECONDITION: the same option set").toEqual([...ob].sort());
    expect(oa, "…in a different order").not.toEqual(ob);
    await s.api.dispose(); await sa.dispose();
  });

  test("an admin looking through a participant's account sees that participant's own order", async () => {
    // Survived before: keying the shuffle on the acting admin under impersonation.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("imp");
    const id = await mkChoice(sa, csrf, ten(T));
    const ev = await liveEvent(sa, csrf, "imp", [id]);
    const p = await playerIn(sa, csrf, "imp", [ev.id]);
    const own = await asPlayer(p.email, ev.id);
    const ownOrder = (await readTask(own.api, id)).choices.map((c) => c.id);
    await own.api.dispose();

    const admin = await makeTier(sa, csrf, "imp-admin", "admin");
    const enter = await admin.api.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(admin.csrf) });
    expect(enter.ok(), `impersonate: ${await enter.text()}`).toBeTruthy();
    const c2 = (await (await admin.api.get("/api/csrf-token")).json()).csrfToken;
    const sel = await admin.api.post("/api/select-competition", { headers: H(c2), data: { competitionId: ev.id } });
    expect(sel.ok(), `select under impersonation: ${await sel.text()}`).toBeTruthy();
    expect((await readTask(admin.api, id)).choices.map((c) => c.id)).toEqual(ownOrder);
    await admin.api.dispose(); await sa.dispose();
  });

  test("the answer card draws the options in the server's order, as literal text", async ({ page }) => {
    // Survived before, separately: the card re-sorting the options by text, and
    // the card dropping esc() around an option's text (participant-tasks.js).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("card");
    const idBank = await mkChoice(sa, csrf, markupOptions(T));
    const ev = await liveEvent(sa, csrf, "card", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "card", [ev.id]);
    await sa.dispose();

    await signInTo(page, p.email, ev.id);
    const served = await choiceIdsFor(page, id);
    const texts = served.map((c) => c.text);
    expect(texts, "PRECONDITION: the served order is not the author order")
      .not.toEqual(markupOptions(T).map((o) => o.text));
    expect(texts, "PRECONDITION: nor alphabetical").not.toEqual([...texts].sort((x, y) => x.localeCompare(y)));
    await openChallenge(page, id);
    const drawn = await page.evaluate(() => [...document.querySelectorAll(".choice-fieldset .choice-option")].map((l) => ({
      id: l.querySelector("input.ans-choice")?.value, text: l.querySelector("span")?.textContent,
    })));
    expect(drawn, "the card draws exactly what was served, in that order").toEqual(served);
    expect(await page.locator(".choice-fieldset b, .choice-fieldset img").count(), "no option became markup").toBe(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).__xss), "no handler ran").toBeUndefined();
  });

  test("the review after solving keeps the order, the literal text, and marks the right options", async ({ page }) => {
    // Survived before: the review reversing its rows, dropping esc(), and swapping
    // its markers (the correct row drawn empty, the others filled).
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("rev");
    const singleBank = await mkChoice(sa, csrf, markupOptions(T));
    const multiBank = await mkChoice(sa, csrf, [
      { text: `M1_${T}`, correct: true }, { text: `M2_${T}` }, { text: `M3_${T}`, correct: true }, { text: `M4_${T}` }]);
    const ev = await liveEvent(sa, csrf, "rev", [singleBank, multiBank]);
    const [single, multi] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "rev", [ev.id]);
    await sa.dispose();

    await signInTo(page, p.email, ev.id);
    for (const [id, multiAnswer] of [[single, false], [multi, true]]) {
      const served = await choiceIdsFor(page, id);
      const right = storedIds(id).correct;
      const sub = await pageSubmit(page, id, right);
      expect((await sub.json()).correct, "PRECONDITION: solved").toBe(true);
      await openChallenge(page, id);
      await page.locator("#choice-review").waitFor({ state: "visible" });
      const rows = await page.evaluate(() => [...document.querySelectorAll("#choice-review .choice-review-row")].map((r) => ({
        text: r.querySelector(".tpc-text")?.textContent,
        correct: r.classList.contains("is-correct"),
        // The review tile keeps its key (A, B, …) and ticks only a right option.
        tick: r.querySelectorAll(".tpc-badge svg polyline").length,
        key: (r.querySelector(".choice-key")?.textContent || "").trim(),
      })));
      expect(rows.map((r) => r.text), "the review keeps the served order, literally").toEqual(served.map((c) => c.text));
      const correctTexts = served.filter((c) => right.includes(c.id)).map((c) => c.text);
      expect(rows.filter((r) => r.correct).map((r) => r.text), "PRECONDITION: the right rows are marked").toEqual(correctTexts);
      for (const r of rows) {
        expect(r.tick, `${multiAnswer ? "multi" : "single"}: a tick only on a right option (${r.text})`).toBe(r.correct ? 1 : 0);
      }
      expect(rows.map((r) => r.key), "every review tile keeps its key, in order")
        .toEqual(rows.map((_, i) => String.fromCharCode(65 + i)));
      expect(await page.locator("#choice-review b, #choice-review img").count()).toBe(0);
      await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    }
  });

  test("a challenge whose single/multi mode is missing renders one-answer radios", async ({ page }) => {
    // Survived before: `choice_mode==='multi'` → `!=='single'`, which turned an
    // absent or unknown mode into checkboxes. Radios are the safe reading.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("mode");
    const opts = (k) => [{ text: `${k}1_${T}`, correct: true }, { text: `${k}2_${T}`, correct: true }, { text: `${k}3_${T}` }];
    const controlBank = await mkChoice(sa, csrf, opts("C"));
    const strippedBank = await mkChoice(sa, csrf, opts("S"));
    const ev = await liveEvent(sa, csrf, "mode", [controlBank, strippedBank]);
    const [control, stripped] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "mode", [ev.id]);
    await sa.dispose();

    await signInTo(page, p.email, ev.id);
    const kinds = () => page.evaluate(() => ({
      types: [...document.querySelectorAll(".choice-fieldset input.ans-choice")].map((i) => i.getAttribute("type")),
      legend: document.querySelector(".choice-fieldset legend")?.textContent,
    }));
    await openChallenge(page, control);
    expect(await kinds(), "CONTROL: a multi challenge renders checkboxes")
      .toEqual({ types: ["checkbox", "checkbox", "checkbox"], legend: "Choose all that apply" });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();

    let stripped0 = 0;
    await page.route(`**/api/tasks/${stripped}`, async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      delete j.choice_mode;
      stripped0++;
      await route.fulfill({ response: r, json: j });
    });
    await openChallenge(page, stripped);
    expect(stripped0, "PRECONDITION: the card read went through the stub").toBeGreaterThan(0);
    expect(await kinds()).toEqual({ types: ["radio", "radio", "radio"], legend: "Choose one" });
  });

  test("a superseded read of the same challenge never replaces the newer read's grading token", async ({ page }) => {
    // Survived before: storing the token ABOVE openTask's post-parse staleness
    // check. A double open straddling an admin edit then refused the answer on
    // screen with task_changed.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const T = tagOf("tok");
    const idBank = await mkChoice(sa, csrf, [{ text: `Pick me ${T}`, correct: true }, { text: `Not me ${T}` }, { text: `Other ${T}` }]);
    const ev = await liveEvent(sa, csrf, "tok", [idBank]);
    const [id] = ev.ids;   // the event's own copies (lib/event-copies.js)
    const p = await playerIn(sa, csrf, "tok", [ev.id]);

    await signInTo(page, p.email, ev.id);
    // Hold the FIRST read's body after its headers arrived (fetch resolves at headers).
    await page.evaluate((taskId) => {
      const w = /** @type {any} */ (window);
      w.__held = 0; w.__gate = new Promise((r) => { w.__release = r; });
      const orig = Response.prototype.json; let done = false;
      Response.prototype.json = async function () {
        const v = await orig.call(this);
        if (!done && this.url.endsWith(`/api/tasks/${taskId}`)) { done = true; w.__h1 = v && v.grading_hash; w.__held++; await w.__gate; }
        return v;
      };
      w.__o1 = false; w.openTask(taskId).then(() => { w.__o1 = true; });
    }, id);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__held), { timeout: 10000 }).toBe(1);
    const h1 = await page.evaluate(() => /** @type {any} */ (window).__h1);
    expect(h1, "PRECONDITION: the held read carries a token").toBeTruthy();

    // An option-text edit changes the question, so it changes the token.
    const { opts, correct } = storedIds(id);
    const put = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: {
      choices: opts.map((o) => ({ id: o.id, text: o.text === `Other ${T}` ? `Other edited ${T}` : o.text, correct: correct.includes(o.id) })) } });
    expect(put.ok(), `edit: ${await put.text()}`).toBeTruthy();
    await sa.dispose();

    await page.evaluate((taskId) => { const w = /** @type {any} */ (window); w.__o2 = false; w.openTask(taskId).then(() => { w.__o2 = true; }); }, id);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__o2), { timeout: 15000 }).toBe(true);
    const h2 = await page.evaluate((taskId) => /** @type {any} */ (window)._taskGradingHashes.get(taskId), id);
    expect(h2, "PRECONDITION: the newer read stored a different token").not.toBe(h1);
    await page.evaluate(() => /** @type {any} */ (window).__release());
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__o1), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate((taskId) => /** @type {any} */ (window)._taskGradingHashes.get(taskId), id),
      "the dropped read did not overwrite it").toBe(h2);

    // And the answer on screen is graded, not refused.
    await page.getByText(`Pick me ${T}`, { exact: true }).click();
    const resp = page.waitForResponse((r) => r.url().endsWith(`/api/tasks/${id}/submit`) && r.request().method() === "POST");
    await page.locator("[data-action='task-submit-answer'][data-mode='choice']").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 8000 });
    await page.locator("#modal-confirm-btn").click();
    const r = await resp;
    const body = await r.text();
    expect(r.status(), body).toBe(200);
    expect(JSON.parse(body).correct).toBe(true);
  });
});
