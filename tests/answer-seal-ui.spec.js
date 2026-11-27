// @ts-check
//
// v8.10.0 — THE SEALED ANSWER, in a real browser.
//
// WHY THIS FILE EXISTS BESIDE THE API SPEC, rather than being folded into it.
// The server is the boundary and `answer-seal.api.spec.js` pins it: the key is
// never SENT. But three things are only true in a browser, and each of them is a
// way the feature could ship broken with that whole file green:
//
//  1. THE SAVE. `saveTask` posts `correct_answer` and `explanation` on EVERY save
//     from a form whose boxes are empty for a reader who was withheld the key. If
//     it posted what the boxes contain rather than OMITTING the fields, a
//     title-only save would WIPE the answer of a challenge the saver was never
//     allowed to read. The API spec cannot see this — it constructs its own
//     bodies. Only driving the real form can.
//  2. THE AFFORDANCES. A checkbox at create, an Unseal control for the author and
//     nobody else, and a badge an operator can actually find. A control that is
//     not rendered is not shipped.
//  3. THE EXPLANATIONS. Withholding the answer WITH its reason is the v7.14.2
//     rule; an empty Solution box and a blank Correct Answer field are the
//     failure it exists to prevent, and both look identical to a passing API
//     assertion.
//
// EVERY ARM CARRIES AN UNSEALED CONTROL for the reason the API spec states: "the
// answer is not shown" is equally satisfied by a build that shows nobody
// anything, which is a worse product than the leak.
const { test, expect } = require("./isolated-test");
// `freshCtx` rather than a direct `@playwright/test` import — see the v7.20.0
// harness scanner: a direct import opts the whole file out of per-file isolation.
const { BASE, apiLogin, freshCtx, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant } = require("./event-admin-helpers");
const { loginViaApi, clickTab, findSeededTaskRow, narrowChallengesTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

let sa, saCsrf, author, other, TAG, sealedTitle, plainTitle, sealedId, plainId;

async function makeAdmin(label) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;   // { id, email, nickname } — the browser signs in through loginViaApi
}

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  author = await makeAdmin("uisealauthor");
  other  = await makeAdmin("uisealother");
  TAG = uniq("u").replace(/[^a-zA-Z0-9]/g, "");
  sealedTitle = `UISealed ${TAG}`;
  plainTitle  = `UIPlain ${TAG}`;

  // Created through the API as the AUTHOR, so the browser arms start from a real
  // sealed challenge rather than depending on the create arm having run first
  // (fixture-checklist: a test must not need a predecessor).
  const { api: ctx, csrf: _ctxCsrf } = await freshCtx();
  try {
    const c1 = _ctxCsrf;
    const li = await codeLogin(ctx, author.email, H(c1));
    expect(li.ok(), `author login: ${li.status()} ${await li.text()}`).toBeTruthy();
    const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
    const mk = async (title, sealed, key) => {
      const r = await ctx.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
                correct_answer: key, explanation: `<p>WHY_${key}</p>`, status: "published",
                ...(sealed ? { answer_sealed: true } : {}) },
      });
      expect(r.ok(), `create ${title}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).id;
    };
    sealedId = await mk(sealedTitle, true,  `UIKEY_${TAG}`);
    plainId  = await mk(plainTitle,  false, `UIPLAIN_${TAG}`);
  } finally { await ctx.dispose(); }
});

test.afterAll(async () => { await sa?.dispose(); });

/** Sign in, open the Challenges tab, and narrow the paginated table to ONE row. */
async function openChallenges(page, email, title) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await page.goto("/");
  // `#admin-page` is not visible until boot has resolved the role, so it is the
  // signal that the admin model exists — `.admin-nav-item` is STATIC markup and
  // is attached before boot has decided anything (v8.3.33).
  await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
  await clickTab(page, "Challenges");
  // The table paginates at 30 rows and this file adds its own, so a bare row
  // lookup would depend on how full the table happens to be (v7.15.29). Wait for
  // the model first — the search input re-renders FROM it, so a fill that lands
  // before it arrives filters an empty array.
  await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), {
    message: "the challenge model loaded", timeout: 20_000,
  }).toBeGreaterThan(0);
  // `findSeededTaskRow` is the suite's OWN narrowing helper (v7.16.2's registry
  // requires one on this surface) — reused rather than re-implemented, because a
  // second copy is how the four that already existed came to drift (v7.21.25).
  const row = await findSeededTaskRow(page, title);
  await expect(row.first(), `the table narrowed to "${title}"`).toBeVisible({ timeout: 15_000 });
  return row.first();
}

test.describe("v8.10.0 — the sealed answer in the admin UI", () => {

  test("a non-author sees a Sealed badge, a preview that explains itself, and no answer anywhere in the page", async ({ page }) => {
    const row = await openChallenges(page, other.email, sealedTitle);
    // THE BADGE. It goes in the Status column (column 5), where "Shared" already
    // is — the Tags column is column 11 of 13 on a table forced to a 1372px
    // min-width, i.e. behind hundreds of pixels of in-card scroll at every
    // ordinary admin viewport (the v8.8.4 finding). Asserted by GEOMETRY, because
    // "the badge is present" is satisfied by a build that renders it back there.
    const badge = row.locator(".badge.sealed-answer");
    await expect(badge, "a non-author is told the answer is sealed").toHaveCount(1);
    await expect(badge).toHaveText(/sealed/i);
    // The geometry probe is v8.8.4's own, verbatim — that release added the
    // "Shared" badge to this very cell for this very reason, so measuring it a
    // second way would be a second definition of "on screen".
    const geom = await badge.evaluate((el, sel) => {
      const sc = el.closest(sel) || document.scrollingElement;
      const b = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
      return { scrollLeft: sc.scrollLeft, badgeLeft: b.left, badgeRight: b.right, cLeft: s.left, cRight: s.right };
    }, ".table-wrap, .card");
    expect(geom.scrollLeft, "the table is not pre-scrolled").toBe(0);
    expect(geom.badgeLeft, "the badge starts inside the visible box").toBeGreaterThanOrEqual(geom.cLeft - 1);
    expect(geom.badgeRight, "…and ends inside it, with no horizontal scrolling").toBeLessThanOrEqual(geom.cRight + 1);

    // THE PREVIEW — the row's default primary button and an unconditional kebab
    // item, so the cheapest way for any admin tier to read a solution.
    await row.locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay, "the preview says WHY there is no solution, rather than omitting the box")
      .toContainText("answer is sealed");
    await expect(overlay.locator(".task-preview-answer"), "and shows no Correct Answer block").toHaveCount(0);
    // BY VALUE over the whole document: a leak into a title attribute, a data-
    // attribute or an off-screen node still fails.
    expect(await page.content(), "neither the key nor the explanation is anywhere in the DOM")
      .not.toContain(`UIKEY_${TAG}`);
    expect(await page.content()).not.toContain(`WHY_UIKEY_${TAG}`);
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toBeHidden();

    // CONTROL: the UNSEALED twin previews normally for the same admin, in the
    // same session — so none of the above is a build that stopped showing
    // solutions.
    const prow = (await findSeededTaskRow(page, plainTitle)).first();
    await expect(prow, "the unsealed twin is findable").toBeVisible({ timeout: 15_000 });
    await expect(prow.locator(".badge.sealed-answer"), "an ordinary challenge carries no badge").toHaveCount(0);
    await prow.locator("[data-action='task-view']").first().click();
    await expect(page.locator("#task-preview-overlay .task-preview-answer"),
      "an ordinary challenge still shows its Correct Answer").toContainText(`UIPLAIN_${TAG}`);
  });

  test("the author sees their own answer, and the badge, and can unseal from the editor", async ({ page }) => {
    const row = await openChallenges(page, author.email, sealedTitle);
    await expect(row.locator(".badge.sealed-answer"), "the badge is a fact about the challenge, so the author sees it too").toBeVisible();

    // The kebab's Edit item is gated on `can_edit`, which is TRUE for the author.
    await page.evaluate(id => window.editTask(id), sealedId);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-answer"), "the author's own key is prefilled — this payload is the only source the editor has")
      .toHaveValue(`UIKEY_${TAG}`);
    await expect(page.locator("#tf-sealed-note"), "and the editor explains what sealed means here").toBeVisible();
    await expect(page.locator("#tf-seal-group"), "the CREATE checkbox is hidden on an edit — sealing is a create-time choice").toBeHidden();
    await expect(page.locator("#tf-unseal-row"), "the author is offered the one transition the server accepts").toBeVisible();
  });

  test("a save by a non-author cannot wipe an answer it was never shown", async ({ page }) => {
    // THE DESTRUCTIVE HAZARD, and the single most important arm in this file.
    //
    // `editTask` is on `window` and performs no server round trip, so a non-author
    // can render the form even though the kebab withholds the button. Their
    // `#tf-answer` box is EMPTY — the server sent no key — and `saveTask` posts
    // `correct_answer` unconditionally. If it posted the empty box, a save would
    // erase the answer of a challenge the saver may not read.
    //
    // Asserted on the WIRE, not on the outcome: the server refuses this caller
    // anyway (403), so "the answer survived" would pass against a client that
    // sent the blank. What must be true is that the field never left the browser.
    await openChallenges(page, other.email, sealedTitle);
    await page.evaluate(id => window.editTask(id), sealedId);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#tf-answer"), "the non-author's box is empty because nothing was sent").toHaveValue("");
    // FIRST, the affordance: this form is READ-ONLY for them, the same shape a
    // locked challenge already uses. `can_edit` is false so the kebab renders no
    // Edit item at all — `window.editTask` is the only way in — and a form that
    // looks editable and is not is the v7.14.2 defect.
    await expect(page.locator("#tf-answer"), "the answer box is disabled, not merely blank").toBeDisabled();
    await expect(page.locator("#tf-title"), "and so is everything else").toBeDisabled();
    await expect(page.locator("#save-task-btn"), "with no Save button offered").toBeHidden();
    await expect(page.locator("#tf-sealed-note"), "and the reason on screen").toBeVisible();

    // SECOND, the defence in depth underneath it. `saveTask` is exported on
    // `window`, so a stale tab, a scripted client or a future build that reopens
    // this form can still reach it — and it must never post the empty boxes,
    // because `correct_answer` and `explanation` are bound with COALESCE / a
    // direct write and an empty string would WIPE an answer this caller was never
    // shown. Asserted on the WIRE, because the server refuses this caller anyway
    // (403), so "the answer survived" would pass against a client that sent the
    // blank.
    const bodies = [];
    await page.route(`**/api/admin/tasks/${sealedId}`, async (route) => {
      if (route.request().method() === "PUT") { try { bodies.push(route.request().postDataJSON()); } catch (_) { bodies.push({}); } }
      await route.continue();
    });
    await page.evaluate(t => { document.getElementById("tf-title").value = t; }, `${sealedTitle} touched`);
    await page.evaluate(() => window.saveTask());
    await expect.poll(() => bodies.length, { message: "the save was attempted", timeout: 10_000 }).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(bodies[0], "correct_answer"),
      "the sealed key is OMITTED from the body, never sent blank — absent means 'leave it alone'").toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bodies[0], "explanation"),
      "and so is the explanation, which the seal covers for the same reason").toBe(false);
    expect(bodies[0].title, "CONTROL: the field they DID edit is still sent, so this is omission and not a broken save").toBe(`${sealedTitle} touched`);

    // And the stored value is untouched — read back as the AUTHOR, since a
    // redacted list would hide the damage from the only actor who could see it.
    const { api: ctx, csrf: _ctxCsrf } = await freshCtx();
    try {
      const c1 = _ctxCsrf;
      await codeLogin(ctx, author.email, H(c1));
      const rows = await (await ctx.get("/api/admin/tasks")).json();
      expect(rows.find(t => t.id === sealedId).correct_answer, "the key is exactly as it was").toBe(`UIKEY_${TAG}`);
    } finally { await ctx.dispose(); }
  });

  test("the create form offers the seal, and a challenge created with it is sealed for real", async ({ page }) => {
    await loginViaApi(page, author.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await expect(page.locator("#admin-task-form")).toBeVisible();
    const box = page.locator("#tf-answer-seal");
    await expect(box, "the checkbox is offered at CREATE").toBeVisible();
    await expect(box, "and starts UNTICKED — the decision is irreversible in the sealing direction").not.toBeChecked();
    // v8.17.0 — the full statement sits behind the "?" beside the switch.
    await page.locator("#tf-seal-tip").click();
    await expect(page.locator("#tf-seal-note"), "with its consequences stated before the click").toBeVisible();
    await expect(page.locator("#tf-unseal-row"), "and no Unseal control on a challenge that does not exist yet").toBeHidden();

    const created = `UIMade ${TAG}`;
    await page.fill("#tf-title", created);
    await page.fill("#tf-answer", `MADEKEY_${TAG}`);
    await box.check();
    await page.locator("#save-publish-btn").click();
    // Read back through the SUPERADMIN, i.e. the tier that must NOT see it — the
    // strongest available statement that the box did something real.
    await expect.poll(async () => {
      const rows = await (await sa.get("/api/admin/tasks")).json();
      const t = rows.find(x => x.title === created);
      return t ? `${t.answer_sealed}/${t.can_see_answer}/${t.correct_answer === undefined}` : "absent";
    }, { message: "the created challenge is sealed against the superadmin", timeout: 15_000 }).toBe("1/false/true");
  });
});

  // v8.10.0 — THE SCREENSHOT FOUND THIS, AND `npm test` CANNOT: the guide
  // captures live in `tests/_screenshots.spec.js`, which `testIgnore` keeps out
  // of the suite entirely. Both seal checkboxes were first written as a
  // hand-rolled `display:flex` label, which the global `input{width:100%}` rule
  // stretches to fill the flex column — a full-width bordered box with the tick
  // centred in it and the words shoved to the far right. The stylesheet's own
  // comment at `.checkbox-row` names that failure in as many words; the fix was
  // to use that class rather than invent a third copy of it.
  //
  // Asserted as GEOMETRY, not as a class name: a future rewrite may reach the
  // same layout another way, and what must not come back is the detachment.
  // v8.10.1 — SEALED AND "ANY ANSWER (FREE RESPONSE)" ARE MUTUALLY EXCLUSIVE, and
  // the form gates BOTH directions rather than letting the author reach a save
  // the server will refuse. Each arm asserts the affordance AND its explanation,
  // because withholding one without the other is the v7.14.2 defect.
  test("choosing the free-response type disables sealing, and says why", async ({ page }) => {
    await loginViaApi(page, author.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 10_000 });

    // PRECONDITION — on the default type it is offered and usable, or every
    // assertion below is satisfied by a checkbox that is always disabled.
    await expect(page.locator("#tf-answer-seal")).toBeEnabled();
    await expect(page.locator("#tf-seal-type-note")).toBeHidden();

    // Switching comes FIRST and the tick cannot precede it — with the seal
    // ticked the option is already disabled, so the pair is unreachable from
    // either end. That is the product working, and it is why this arm drives
    // the order a real author can actually take.
    await page.locator("#tf-atype").selectOption("any");

    await expect(page.locator("#tf-answer-seal")).toBeDisabled();
    await expect(page.locator("#tf-answer-seal")).not.toBeChecked();
    await expect(page.locator("#tf-seal-type-note")).toBeVisible();
    await expect(page.locator("#tf-seal-type-note")).toContainText(/no answer to seal/i);

    // AND BACK: switching away restores it, or the gate is a one-way trap.
    await page.locator("#tf-atype").selectOption("text");
    await expect(page.locator("#tf-answer-seal")).toBeEnabled();
    await expect(page.locator("#tf-seal-type-note")).toBeHidden();
  });

  test("ticking seal makes the free-response type unavailable, with the reason", async ({ page }) => {
    await loginViaApi(page, author.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 10_000 });

    const anyOptDisabled = () => page.evaluate(() =>
      document.querySelector('#tf-atype option[value="any"]').disabled);
    // PRECONDITION: it is selectable before the tick.
    expect(await anyOptDisabled(), "the option starts available").toBe(false);

    await page.locator("#tf-answer-seal").check();
    expect(await anyOptDisabled(), "ticking seal takes the free-response type away").toBe(true);
    await expect(page.locator("#tf-seal-type-note")).toBeVisible();
    await expect(page.locator("#tf-seal-type-note")).toContainText(/no answer to seal/i);
    // The other four stay available — it is the pair that is refused, not the
    // act of sealing, and a build that disabled the whole dropdown would pass a
    // check that only looked at `any`.
    const others = await page.evaluate(() => ["text", "json", "file", "choice"]
      .map(v => document.querySelector(`#tf-atype option[value="${v}"]`).disabled));
    expect(others, "every keyed answer type is still selectable").toEqual([false, false, false, false]);

    await page.locator("#tf-answer-seal").uncheck();
    expect(await anyOptDisabled(), "unticking gives it back").toBe(false);
  });

  test("a SEALED challenge's editor withholds the free-response type from its own author", async ({ page }) => {
    // The reachable route into the pair on an EDIT, and the one the PUT refuses:
    // sealing is create-only, so the checkbox is gone here and the OPTION gate is
    // the only thing standing between the author and a refused save.
    await loginViaApi(page, author.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), {
      message: "the challenge model loaded", timeout: 20_000 }).toBeGreaterThan(0);
    await page.evaluate(i => window.editTask(i), sealedId);
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 10_000 });

    // The create-only checkbox really is absent here — the precondition that
    // makes the option gate the ONLY protection on this form.
    await expect(page.locator("#tf-seal-group")).toBeHidden();
    expect(await page.evaluate(() =>
      document.querySelector('#tf-atype option[value="any"]').disabled),
      "the free-response type is unavailable on a sealed challenge").toBe(true);
    await expect(page.locator("#tf-seal-type-note")).toBeVisible();
    await expect(page.locator("#tf-seal-type-note")).toContainText(/sealed/i);

    // CONTROL: an UNSEALED challenge's editor offers it, so the disable above is
    // about the seal rather than about being on the edit form at all.
    await page.evaluate(i => window.editTask(i), plainId);
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 10_000 });
    expect(await page.evaluate(() =>
      document.querySelector('#tf-atype option[value="any"]').disabled),
      "CONTROL: an unsealed challenge may still be switched to free response").toBe(false);
  });

  // v8.10.1 — THE REASON MUST NAME THE SEAL, not authorship. `can_edit` is false
  // for every non-author, so the row menu previously told a SUPERADMIN "created
  // by someone else" — true of the row, and false as an explanation: a superadmin
  // can ordinarily edit anybody's challenge, so it names a rule that does not
  // bind them in place of the one that does. The v8.8.5 scoring-note precedent.
  test("the withheld row menu tells a superadmin the SEAL is why, not authorship", async ({ page }) => {
    await loginViaApi(page, other.email, PARTICIPANT_PASS);   // an admin who did not create it
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), {
      message: "the challenge model loaded", timeout: 20_000 }).toBeGreaterThan(0);

    const noteFor = async (title) => {
      await narrowChallengesTable(page, title);
      // Wait for the DEBOUNCED re-render to land (every row matches), or the
      // click below can hit a row the filter is about to replace: a detached
      // kebab opens nothing and the note reads "" (CLAUDE.md, filter first).
      await expect.poll(() => page.locator("#admin-task-body tr").evaluateAll(
        (rs, t) => rs.length > 0 && rs.every(r => r.textContent.includes(t)), title),
        { message: `the challenge table narrowed to ${title}`, timeout: 10_000 }).toBe(true);
      const row = page.locator("#admin-task-body tr", { hasText: title }).first();
      await row.waitFor({ state: "visible", timeout: 10_000 });
      return (await row.locator(".kebab-btn").first().evaluate(btn => {
        btn.click();
        const portal = document.getElementById("kebab-portal");
        const n = portal && portal.querySelector(".kebab-note");
        const text = n ? n.textContent : "";
        if (portal) portal.innerHTML = "";     // close it for the next lookup
        return text;
      }));
    };

    const sealedNote = await noteFor(sealedTitle);
    expect(sealedNote, "the sealed challenge names the seal").toMatch(/answer is sealed/i);
    expect(sealedNote, "and does NOT fall back to the authorship reason, which does not bind this tier")
      .not.toMatch(/created by someone else/i);
    // CONTROL: the same admin on an ORDINARY challenge somebody else created
    // gets no note at all, because a global admin may edit it — so the note
    // above is caused by the seal rather than by every menu having been
    // reworded, and the row menu is otherwise unchanged for this tier.
    expect((await noteFor(plainTitle)).trim(), "CONTROL: an unsealed challenge is editable, so there is no note")
      .toBe("");

    // The authorship branch survives for the tier it IS about — an event admin
    // on somebody else's unsealed challenge. That wording is asserted by
    // selector and not by text anywhere in the suite, so a ternary that dropped
    // it would go unnoticed; pinned at SOURCE because reaching it needs an
    // event-admin fixture this file deliberately does not carry.
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "public/js/features/challenges-admin.js"), "utf8");
    expect(src, "the non-sealed withheld menu keeps its own reason")
      .toContain("Created by someone else — you can use it, not change it");
  });

  test("the seal checkboxes sit beside their labels, not stretched across the form", async ({ page }) => {
    await loginViaApi(page, author.email, PARTICIPANT_PASS);
    await page.goto("/");
    // `#admin-page` is the readiness signal, not `.admin-nav-item` (v8.3.33).
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 10_000 });

    const geom = await page.evaluate(() => {
      const box = document.getElementById("tf-answer-seal").getBoundingClientRect();
      const label = document.querySelector("#tf-seal-group label");
      const span = label.querySelector("span");
      return { w: box.width, boxRight: box.right, spanLeft: span.getBoundingClientRect().left,
               labelW: label.getBoundingClientRect().width };
    });
    // A checkbox is a checkbox: a couple of dozen pixels, never a form-width box.
    expect(geom.w, "the checkbox is not stretched to the form's width").toBeLessThan(40);
    expect(geom.w, "and it is still big enough to hit").toBeGreaterThan(10);
    // ATTACHED: its label text begins within a normal gap of the box.
    expect(geom.spanLeft - geom.boxRight, "the label sits beside the box, not across the form")
      .toBeLessThan(24);
    // Anti-vacuity: the label really is the wide element, so "the box is narrow"
    // is a statement about the box rather than about an empty row.
    expect(geom.labelW, "the row itself spans the form").toBeGreaterThan(geom.w * 4);
  });

test.describe("v8.10.0 — the sealed answer on the participant's screen", () => {
  test("after an event that reveals answers, a sealed challenge says why it has none", async ({ page }) => {
    const iso = ms => new Date(Date.now() + ms).toISOString();
    const alice = await makeParticipant(sa, saCsrf, "uisealplayer");
    const bystander = await makeParticipant(sa, saCsrf, "uisealbystander");

    let compId, sId, pId;
    const { api: ctx, csrf: c1 } = await freshCtx();
    try {
      await codeLogin(ctx, author.email, H(c1));
      const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      const comp = await ctx.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: uniq("UI Seal Reveal"), start_time: iso(-60_000), duration_minutes: 60,
                event_kind: "tournament", reveal_answers_on_end: true },
      });
      expect(comp.ok(), `competition: ${comp.status()} ${await comp.text()}`).toBeTruthy();
      compId = (await comp.json()).competition.id;
      const mk = async (title, sealed, key) => {
        const r = await ctx.post("/api/admin/tasks", {
          headers: H(csrf),
          data: { title, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
                  correct_answer: key, explanation: `<p>WHY_${key}</p>`, status: "published",
                  ...(sealed ? { answer_sealed: true } : {}) },
        });
        expect(r.ok(), `${title}: ${r.status()} ${await r.text()}`).toBeTruthy();
        const id = (await r.json()).id;
        const a = await ctx.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
        expect(a.ok(), `assign ${title}: ${a.status()} ${await a.text()}`).toBeTruthy();
        return id;
      };
      sId = await mk(uniq("PSealed"), true,  `PKEY_${TAG}`);
      pId = await mk(uniq("PPlain"),  false, `PPLAIN_${TAG}`);
      // A SECOND enrollee who never solves, so the all-solved auto-end cannot end
      // the event under the test before it is deliberately ended (checklist 1).
      const asg = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [alice.id, bystander.id], competitionIds: [compId] } });
      expect(asg.ok()).toBeTruthy();
      expect((await asg.json()).assigned, "both really were enrolled — /assign SKIPS an ineligible user and still answers 200").toBe(2);
      // End it, so `reveal_answers_on_end` actually fires.
      const end = await ctx.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) });
      expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    } finally { await ctx.dispose(); }

    await loginViaApi(page, alice.email, PARTICIPANT_PASS);
    const pctx = page.request;
    const pc = (await (await pctx.get("/api/csrf-token")).json()).csrfToken;
    const sel = await pctx.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
    expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    // The competition has ENDED, so the 15-second status poll raises the
    // "Competition Ended" modal a moment after load and `#modal-overlay` then
    // intercepts every click on the page. Marking it seen up front is the v8.6.6
    // remedy — the alternative, waiting for the modal and dismissing it, races
    // the poll that raises it.
    const dis = await pctx.post("/api/dismiss-ended", { headers: H(pc) });
    expect(dis.ok(), `dismiss-ended: ${dis.status()}`).toBeTruthy();
    await page.goto("/");
    await page.waitForSelector("#nav-challenges:not([aria-disabled=true])", { state: "visible", timeout: 20_000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();

    const open = async (id) => {
      await page.evaluate(i => window.openTask(i), id);
      await page.waitForSelector("#task-detail-page.active", { timeout: 15_000 });
    };

    // CONTROL FIRST: the ordinary challenge IS revealed, so the sealed one's
    // silence below means something rather than being satisfied by a build in
    // which the reveal never fires at all.
    await open(pId);
    await expect(page.locator("#task-detail-card"), "an ordinary challenge publishes its answer").toContainText(`PPLAIN_${TAG}`);

    await open(sId);
    const card = page.locator("#task-detail-card");
    await expect(card, "the sealed one says WHY, rather than rendering nothing").toContainText("Answer not shown");
    await expect(card).toContainText("sealed its answer");
    // v8.12.2 second review — the box speaks for the ANSWER only. It used to add
    // "(and its hint), so nobody but them can see it", which is false on the
    // card where a participant's paid hint renders a few lines above.
    await expect(card, "the Answer-not-shown box makes no claim about the hint").not.toContainText("nobody but them");
    await expect(card).not.toContainText("and its hint");
    expect(await page.content(), "and neither the key nor its explanation is anywhere in the page")
      .not.toContain(`PKEY_${TAG}`);
    expect(await page.content()).not.toContain(`WHY_PKEY_${TAG}`);
  });
});
