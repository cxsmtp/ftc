// @ts-check
//
// A READ-ONLY RICH TEXT BOX SWITCHES ITS WHOLE TOOLBAR OFF, SAYS WHY, AND
// SWITCHES IT BACK ON when the box is editable again (operator ruling, 25 Nov
// 2026). `createRichEditor` (public/js/ui/richtext.js) returns
// `setReadOnly(reason, {also})`, the one writer of a body's editability after
// creation (a functional-core-b Docs-hygiene scanner refuses any other): every
// toolbar control `disabled`, at full strength with a --muted glyph, the edges
// dashed, open menus closed, and the reason on a line under the buttons as each
// control's and the body's description. Before it, a locked or sealed challenge's
// body was made read-only by four document-wide sweeps and its toolbar stayed
// live: the colour, font, size and table menus opened and the code-language menu
// opened on a right-click, each pick doing nothing (accept-and-ignore).
//
// WHO SEES WHICH REASON. Each follows the predicate of the door it names
// (challenges-admin.js `_tfLockedReason`, `_tfSealedReason`):
//   • locked, a reader who may unlock it (the row menu's Unlock:
//     `adminCan('challenges.lock')`, not competing): "Unlock it from its row's ⋯
//     menu"; anyone else: "only a superadmin can unlock it";
//   • sealed, a reader offered the reveal (`can_reveal_answer`): "Reveal it
//     (recorded)…", or inside an organiser's panel what the reveal does not grant;
//     anyone else: "only the person who created it can edit it";
//   • competing in an event that holds it: the competitor's sentence;
//   • a challenge the reader may not edit for any other reason (`can_edit` false:
//     an organiser's own-challenge rule): "you can only edit challenges you
//     created" — that form used to open EDITABLE, with a Save the PUT refused.
//
// EVERY ARM HAS A CONTROL: the same toolbar on an editable challenge (or the
// author's own sealed one) is on, so "disabled" is not a toolbar that is always
// off, and the look overrides are seen not to apply there.
//
// SINGLE SESSION PER USER: a browser signed in as the built-in superadmin purges
// the API context that built the world, so every fixture is built in beforeAll.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, freshCtx, codeLogin, PARTICIPANT_PASS } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { loginViaApi, adminLogin, clickTab, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const RO = {
  lockedUnlock: "Read-only: this question is locked. Unlock it from its row's ⋯ menu to edit it.",
  locked: "Read-only: this question is locked, and only a superadmin can unlock it.",
  sealed: "Read-only: its answer is sealed, so only the person who created it can edit it.",
  sealedReveal: "Read-only: its answer is sealed. Reveal it (recorded) to see and edit it.",
  sealedRevealPanel: "Read-only: its answer is sealed. Revealing it shows it to you; editing still follows this organiser's rules.",
  competing: "Read-only: you are competing in an event that holds this question.",
  notMine: "Read-only: you can only edit questions you created.",
  lockedNotMine: "Read-only: this question is locked, and you can only edit questions you created.",
};
const SEALED_NOTE_FIRST = "This question's answer is sealed by the person who created it.";
// The 15 tb() buttons and the More toggle, by name: a renamed, added or lost
// control fails here by name rather than as a count.
const LABELS = ["Bold", "Italic", "Underline", "Strikethrough", "Text Color", "Highlight", "Font", "Font Size",
  "Clear Formatting", "Numbered List", "Bullet List", "Insert Link", "Inline Code", "Code Block", "Table", "More formatting"].sort();
const EDITORS = ["#tf-desc", "#tf-explanation", "#tf-hint"];
const DESC = `<p>Alpha Bravo</p><pre><code>let a = 1;</code></pre><table><tbody><tr><td>c1</td><td>c2</td></tr><tr><td>c3</td><td>c4</td></tr></tbody></table>`;

let sa, saCsrf, author, other, competitor, sup, ea, co;
const T = {};

async function makeAdmin(label, role = "admin") {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}

/** An API context signed in as `email`, for building that user's own challenges. */
async function userCtx(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${li.status()} ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}

/** Upload one small ZIP attachment to challenge `id` as `api`'s caller. */
async function attach(api, csrf, id) {
  const { buildZip } = require("../lib/zip-writer");
  const buffer = await buildZip([{ name: "readme.txt", data: "attachment" }]);
  const r = await api.post(`/api/admin/tasks/${id}/attachments`, { headers: { "x-csrf-token": csrf }, multipart: { file: { name: "kit.zip", mimeType: "application/zip", buffer } } });
  expect(r.ok(), `attach: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** What the open editor offers for attachments: the add button, and each chip's actions. */
async function attachWrites(page, chips) {
  await expect(page.locator("#tf-attachments-list [role='listitem']"), "PRECONDITION: the challenge's attachments are listed").toHaveCount(chips);
  return page.evaluate(() => ({
    add: getComputedStyle(document.getElementById("tf-attach-add-btn")).display !== "none",
    actions: [...document.querySelectorAll("#tf-attachments-list .tf-attach-chip-action")].map(a => a.getAttribute("title")),
  }));
}

async function lock(id) {
  const r = await sa.post(`/api/admin/tasks/${id}/lock`, { headers: H(saCsrf) });
  expect(r.ok(), `lock: ${r.status()} ${await r.text()}`).toBeTruthy();
  expect((await r.json()).locked, "the challenge is now locked").toBe(1);
}

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  author = await makeAdmin("rtroauthor");
  other = await makeAdmin("rtroother");
  competitor = await makeAdmin("rtrocomp");
  sup = await makeAdmin("rtrosup", "superadmin");
  ea = await makeParticipant(sa, saCsrf, "rtroea");
  co = await makeParticipant(sa, saCsrf, "rtroco");
  const rich = { description: DESC, explanation: "<p>Explained here</p>", hint: "<p>A hint</p>" };

  T.plain = await makeTask(sa, saCsrf, "rtroplain", rich);
  T.locked = await makeTask(sa, saCsrf, "rtrolocked", rich);
  // One attachment each, so the editor's attachment writes can be judged too.
  await attach(sa, saCsrf, T.plain.id);
  await attach(sa, saCsrf, T.locked.id);
  await lock(T.locked.id);

  const a = await userCtx(author.email);
  try {
    T.sealed = await makeTask(a.api, a.csrf, "rtrosealed", { ...rich, answer_sealed: 1, correct_answer: `KEY_${uniq("k")}` });
    await attach(a.api, a.csrf, T.sealed.id);
    T.sealedLocked = await makeTask(a.api, a.csrf, "rtrosealedlocked", { ...rich, answer_sealed: 1 });
  } finally { await a.api.dispose(); }
  await lock(T.sealedLocked.id);

  // The competitor: a regular admin enrolled in a staff-compete event holding SEALED.
  const compete = await makeCompetition(sa, saCsrf, "rtrocompete", { staff_compete: true });
  await assignTask(sa, saCsrf, T.sealed.id, [compete.id]);
  await enrol(sa, saCsrf, compete.id, [competitor.id]);

  // An event two organisers run: `co`'s challenges are ea's to see, never to edit.
  const mine = await makeCompetition(sa, saCsrf, "rtromine");
  await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
  await grantEventAdmin(sa, saCsrf, mine.id, co.id);
  const c = await userCtx(co.email);
  try {
    T.coPlain = await makeTask(c.api, c.csrf, "rtrocoplain", rich);
    T.coSealed = await makeTask(c.api, c.csrf, "rtrocosealed", { ...rich, answer_sealed: 1, correct_answer: `COKEY_${uniq("k").replace(/[^a-zA-Z0-9]/g, "")}` });
    await assignTask(c.api, c.csrf, T.coPlain.id, [mine.id]);
    await attach(c.api, c.csrf, T.coPlain.id);
    await assignTask(c.api, c.csrf, T.coSealed.id, [mine.id]);
  } finally { await c.api.dispose(); }
  const e = await userCtx(ea.email);
  try {
    T.eaOwn = await makeTask(e.api, e.csrf, "rtroeaown", rich);
    await assignTask(e.api, e.csrf, T.eaOwn.id, [mine.id]);
    const rows = await (await e.api.get("/api/admin/tasks")).json();
    const seen = rows.find(t => t.id === T.coPlain.id);
    expect(seen, "PRECONDITION: the organiser sees the co-organiser's challenge").toBeTruthy();
    expect(seen.can_edit, "PRECONDITION: …and may not edit it").toBe(false);
    expect(seen.can_see_answer, "PRECONDITION: …though nothing about it is withheld").not.toBe(false);
    expect(rows.find(t => t.id === T.eaOwn.id)?.can_edit, "PRECONDITION: the organiser's own challenge is theirs to edit").not.toBe(false);
  } finally { await e.api.dispose(); }
});

test.afterAll(async () => { await sa?.dispose(); });

/** Open the Challenges page and wait until the model holds every id the test opens. */
async function openChallenges(page, ids) {
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30_000 });
  await clickTab(page, "Challenges");
  await expect.poll(() => page.evaluate(want => want.every(id => (window.adminTasksData || []).some(t => t.id === id)), ids),
    { message: "the challenge model holds the fixtures", timeout: 20_000 }).toBe(true);
}

async function edit(page, id) {
  await page.evaluate(i => window.editTask(i), id);
  await expect(page.locator("#admin-task-form")).toBeVisible();
  await expect(page.locator("#edit-task-id")).toHaveValue(id);
}

/** Everything one editor's toolbar says about its state, read in one go. */
function toolbar(page, sel) {
  return page.evaluate(s => {
    const el = document.querySelector(s);
    const bar = el.querySelector(".rich-toolbar"), body = el.querySelector(".rich-body");
    const note = bar.querySelector(".rt-ro-note"), more = bar.querySelector(".rt-more"), moreBtn = bar.querySelector(".rt-more-btn");
    const btns = [...bar.querySelectorAll("button")];
    return {
      labels: btns.map(b => b.getAttribute("aria-label")).sort(),
      disabled: btns.map(b => b.disabled),
      describedBy: [...new Set(btns.map(b => b.getAttribute("aria-describedby")))],
      bodyDescribedBy: body.getAttribute("aria-describedby"),
      noteId: note && note.id,
      noteHidden: !note || note.hidden,
      noteText: note ? note.textContent : null,
      noteShown: !!note && note.getClientRects().length > 0,
      editable: body.isContentEditable,
      isReadonly: el.classList.contains("is-readonly"),
      moreHidden: more.hidden,
      expanded: moreBtn.getAttribute("aria-expanded"),
    };
  }, sel);
}

async function expectOff(page, sel, reason, also) {
  const t = await toolbar(page, sel);
  expect(t.labels, `${sel}: the toolbar's controls, by name`).toEqual(LABELS);
  expect(t.disabled.every(Boolean), `${sel}: every control is switched off`).toBe(true);
  expect(t.noteHidden, `${sel}: the reason line is shown`).toBe(false);
  expect(t.noteText, `${sel}: …and says why`).toBe(reason);
  const ids = [t.noteId, ...(also ? [also] : [])].join(" ");
  expect(t.describedBy, `${sel}: each control is described by the reason`).toEqual([ids]);
  expect(t.bodyDescribedBy, `${sel}: …and so is the body`).toBe(ids);
  expect(t.editable, `${sel}: the body is read-only`).toBe(false);
  expect(t.isReadonly, `${sel}: the editor carries is-readonly`).toBe(true);
  expect(t.moreHidden, `${sel}: More is collapsed`).toBe(true);
  expect(t.expanded).toBe("false");
}

async function expectOn(page, sel) {
  const t = await toolbar(page, sel);
  expect(t.labels, `${sel}: the toolbar's controls, by name`).toEqual(LABELS);
  expect(t.disabled.some(Boolean), `${sel}: CONTROL: no control is switched off`).toBe(false);
  expect(t.noteHidden, `${sel}: no reason line`).toBe(true);
  expect(t.noteText, `${sel}: …and it holds nothing`).toBe("");
  expect(t.describedBy, `${sel}: no control carries a description`).toEqual([null]);
  expect(t.bodyDescribedBy, `${sel}: …nor the body`).toBeNull();
  expect(t.editable, `${sel}: the body is editable`).toBe(true);
  expect(t.isReadonly, `${sel}: no is-readonly`).toBe(false);
}

/** The look, by value against a --muted probe in the same toolbar. */
function look(page, sel) {
  return page.evaluate(s => {
    const el = document.querySelector(s), bar = el.querySelector(".rich-toolbar");
    const probe = document.createElement("span"); probe.style.color = "var(--muted)"; bar.appendChild(probe);
    const muted = getComputedStyle(probe).color; probe.remove();
    const cs = (n, p) => getComputedStyle(n, p);
    const btns = [...bar.querySelectorAll("button")];
    const nodes = btns.flatMap(b => [b, ...b.querySelectorAll("*")]);
    const glyph = l => bar.querySelector(`button[aria-label="${l}"] [style]`);
    const body = el.querySelector(".rich-body");
    return {
      muted,
      opacities: [...new Set(nodes.map(n => cs(n).opacity))],
      btnColours: [...new Set(btns.map(b => cs(b).color))],
      styledColours: [...new Set(btns.flatMap(b => [...b.querySelectorAll("[style]")]).map(n => cs(n).color))],
      highlightBg: cs(glyph("Highlight")).backgroundColor,
      textColourUnderline: cs(glyph("Text Color")).borderBottomColor,
      linkColour: cs(glyph("Insert Link")).color,
      editorBorder: cs(el).borderTopStyle,
      barBorder: cs(bar).borderBottomStyle,
      bodyColour: cs(body).color,
      pColour: body.querySelector("p") ? cs(body.querySelector("p")).color : null,
      bodyCursor: cs(body).cursor,
      placeholder: cs(body, "::before").content,
    };
  }, sel);
}

/** Press everything on a read-only toolbar every way there is, and see nothing change. */
async function pressEverything(page, sel) {
  const before = await page.evaluate(() => window.descEditor.getHtml());
  // (a) The user's path: trusted clicks on every visible control.
  for (const b of await page.locator(`${sel} .rich-toolbar button`).all()) {
    const box = await b.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  // (b) The guards themselves: each button's own handlers, called directly — a
  // disabled control receives no dispatched mouse event, so only this reaches them.
  await page.evaluate(s => {
    for (const b of document.querySelectorAll(`${s} .rich-toolbar button`)) {
      if (b.onmousedown) b.onmousedown(new MouseEvent("mousedown", { cancelable: true }));
      if (b.onkeydown) b.onkeydown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
      if (b.onclick) b.onclick(new MouseEvent("click", { cancelable: true }));
    }
  }, sel);
  // (c) A right-click on the code block opens the browser's menu, not the
  // editor's language pick (whose handler would also cancel the event).
  await page.evaluate(() => { window.__cm = null; document.addEventListener("contextmenu", e => { window.__cm = e.defaultPrevented; }, { once: true }); });
  await page.locator(`${sel} .rich-body pre`).first().click({ button: "right" });
  expect(await page.evaluate(() => window.__cm), "the right-click reached the page and was left to the browser").toBe(false);
  expect(await page.evaluate(() => window.descEditor.getHtml()), "no press changed the text").toBe(before);
  await expect(page.locator(".color-pop, .drop-pop, .code-lang-menu, #link-dlg-url"), "no menu or dialog opened").toHaveCount(0);
  const t = await toolbar(page, sel);
  expect(t.moreHidden, "More stayed collapsed").toBe(true);
  expect(t.expanded).toBe("false");
}

test.describe("A read-only rich text box switches its toolbar off and says why", () => {
  test("a locked challenge: every control in all three toolbars off at full strength with the Unlock reason, no press changes anything, the keyboard skips them; a sealed one offers the reveal", async ({ page }) => {
    await adminLogin(page);
    await openChallenges(page, [T.locked.id, T.sealed.id]);
    await edit(page, T.locked.id);
    for (const sel of EDITORS) await expectOff(page, sel, RO.lockedUnlock);
    await expect(page.locator("#save-task-btn"), "no Save on a locked challenge").toBeHidden();
    // The Unlock promise only to a reader who could then edit it: a locked challenge
    // that is not theirs says both, whoever may unlock (the reason's own judge, by value).
    expect(await page.evaluate(() => { const S = window.S, was = S._tfAnswerVisible; S._tfAnswerVisible = true;
      try { return [window._tfLockedReason({ can_edit: false, competing_in: [] }), window._tfLockedReason({ can_edit: true, competing_in: [] })]; }
      finally { S._tfAnswerVisible = was; } }), "PRECONDITION: this reader may unlock; a challenge not theirs gets no Unlock promise")
      .toEqual([RO.lockedNotMine, RO.lockedUnlock]);
    // The lock refuses attachment writes too: no add button, and a chip offers Download only.
    expect(await attachWrites(page, 1), "a locked challenge offers no attachment writes").toEqual({ add: false, actions: ["Download"] });
    // The reason is what a screen reader hears on each control.
    for (const b of await page.locator("#tf-desc .rich-toolbar > button").all()) {
      await expect(b).toHaveAccessibleDescription(RO.lockedUnlock);
    }

    // LOOK: full strength, muted glyphs (the inline-coloured ones too), dashed edges.
    const L = await look(page, "#tf-desc");
    expect(L.opacities, "no control or glyph is faded").toEqual(["1"]);
    expect(L.btnColours, "every control is --muted").toEqual([L.muted]);
    expect(L.styledColours, "…and every inline-coloured glyph").toEqual([L.muted]);
    expect(L.highlightBg, "the Highlight glyph's yellow fill goes").toBe("rgba(0, 0, 0, 0)");
    expect(L.textColourUnderline, "the Text Color glyph's red underline is --muted").toBe(L.muted);
    expect(L.editorBorder, "the editor's edge is dashed").toBe("dashed");
    expect(L.barBorder, "…and the toolbar's").toBe("dashed");
    expect(L.bodyColour, "the body's text is --muted").toBe(L.muted);
    expect(L.pColour, "…its paragraphs too").toBe(L.muted);
    expect(L.bodyCursor).toBe("not-allowed");

    // HOVER lights nothing: a lit control reads as live.
    for (const b of await page.locator("#tf-desc .rich-toolbar > button").all()) {
      const box = await b.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const st = await b.evaluate(el => { el.getAnimations().forEach(a => a.finish()); const c = getComputedStyle(el); return { color: c.color, bg: c.backgroundColor }; });
      expect(st.color, `hovering ${await b.getAttribute("aria-label")} keeps it --muted`).toBe(L.muted);
      expect(st.bg, "…on no fill").toBe("rgba(0, 0, 0, 0)");
    }
    await page.mouse.move(0, 0);

    await pressEverything(page, "#tf-desc");

    // KEYBOARD: from the top of the form through the whole of it, no toolbar
    // control takes the focus — and the walk did cross the editor (CONTROL). Every
    // field above the editor is disabled, so the walk starts from a stand-in
    // control placed first in the form (focusing it also moves the browser's
    // sequential-navigation starting point, which the clicks above left inside
    // the body, past the toolbar).
    await page.evaluate(() => {
      const b = document.createElement("button"); b.id = "__walk-start"; b.type = "button"; b.textContent = "start";
      document.querySelector("#admin-task-form").prepend(b); b.focus();
    });
    let crossed = false, onToolbar = [];
    for (let i = 0; i < 250 && !crossed; i++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => {
        const a = document.activeElement, d = document.querySelector("#tf-desc");
        return { bar: !!a?.closest(".rich-toolbar"), label: a?.getAttribute("aria-label") || a?.id || a?.tagName,
          after: !!a && a !== d && !d.contains(a) && !!a.closest("#admin-task-form") && !!(d.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) };
      });
      if (f.bar) onToolbar.push(f.label);
      crossed = f.after;
    }
    expect(crossed, "CONTROL: the walk reached a control after the description editor").toBe(true);
    expect(onToolbar, "no switched-off control took the focus").toEqual([]);
    await page.evaluate(() => document.getElementById("__walk-start")?.remove());

    const axe = await new AxeBuilder({ page }).include("#admin-task-form").analyze();
    const gated = axe.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact));
    expect(gated.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(", ")}`), "no gated axe violation on the read-only form").toEqual([]);

    // The built-in superadmin is offered the reveal on a sealed challenge it did
    // not write: the reason names that door, beside the editor's Reveal button.
    await edit(page, T.sealed.id);
    await expect(page.locator("#tf-reveal-row"), "the reveal is offered in the editor").toBeVisible();
    await expectOff(page, "#tf-desc", RO.sealedReveal, "tf-sealed-note");
  });

  test("CONTROL and back on: an editable challenge's toolbar is on and acts; a menu open when the form turns locked closes; leaving the locked form for another challenge or a New Challenge turns it back on", async ({ page }) => {
    await adminLogin(page);
    await openChallenges(page, [T.plain.id, T.locked.id]);
    await edit(page, T.plain.id);
    for (const sel of EDITORS) await expectOn(page, sel);
    expect(await attachWrites(page, 1), "CONTROL: an editable challenge offers every attachment write").toEqual({ add: true, actions: ["Rename", "Download", "Remove"] });
    const L = await look(page, "#tf-desc");
    expect(L.editorBorder, "CONTROL: a solid edge").toBe("solid");
    expect(L.highlightBg, "CONTROL: the Highlight glyph keeps its fill (the override is the read-only state's)").not.toBe("rgba(0, 0, 0, 0)");
    expect(L.linkColour, "CONTROL: the link icon keeps its colour").not.toBe(L.muted);
    expect(L.bodyColour, "CONTROL: the body's text is not --muted").not.toBe(L.muted);

    // More, then Text Color, opens its menu…
    await page.locator("#tf-desc .rt-more-btn").click();
    await page.locator("#tf-desc button[aria-label='Text Color']").click();
    await expect(page.locator("#tf-desc .color-pop"), "CONTROL: the colour menu opens").toHaveCount(1);
    // …and the language menu opens on an editable body, cancelling the browser's.
    await page.evaluate(() => { window.__cm = null; document.addEventListener("contextmenu", e => { window.__cm = e.defaultPrevented; }, { once: true }); });
    await page.locator("#tf-desc .rich-body pre").first().click({ button: "right" });
    await expect(page.locator(".code-lang-menu"), "CONTROL: an editable body's right-click opens the language menu").toHaveCount(1);
    expect(await page.evaluate(() => window.__cm)).toBe(true);
    await expect(page.locator("#tf-desc .color-pop"), "both menus are open").toHaveCount(1);
    expect((await toolbar(page, "#tf-desc")).expanded, "…and More is expanded").toBe("true");

    // Turned locked with both open: they close, More collapses, all off.
    await edit(page, T.locked.id);
    await expect(page.locator(".color-pop, .drop-pop, .code-lang-menu"), "the open menus closed").toHaveCount(0);
    for (const sel of EDITORS) await expectOff(page, sel, RO.lockedUnlock);

    // Back to the editable challenge: on again, and a real press acts.
    await edit(page, T.plain.id);
    for (const sel of EDITORS) await expectOn(page, sel);
    await page.evaluate(() => {
      const p = document.querySelector("#tf-desc .rich-body p"), tx = p.firstChild, i = tx.data.indexOf("Bravo");
      const r = document.createRange(); r.setStart(tx, i); r.setEnd(tx, i + 5);
      document.querySelector("#tf-desc .rich-body").focus();
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.locator("#tf-desc button[aria-label='Bold']").click();
    expect(await page.evaluate(() => window.descEditor.getHtml()), "CONTROL: Bold acts on an editable body").toContain("<b>Bravo</b>");
    // The keyboard reaches the toolbar on an editable form.
    await page.locator("#tf-title").focus();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Bold");
    }
    expect(reached, "CONTROL: Tab from the title reaches Bold").toBe(true);

    // Locked, then Cancel, then + New Challenge: on again.
    await edit(page, T.locked.id);
    await expectOff(page, "#tf-desc", RO.lockedUnlock);
    await page.locator("[data-action='close-task-form']").click();
    await page.locator("[data-action='open-task-form']").click();
    await expect(page.locator("#task-form-title")).toHaveText("New question");
    for (const sel of EDITORS) await expectOn(page, sel);
    await expect(page.locator("#tf-attach-add-btn"), "a new challenge offers its attachments again").toBeVisible();
    expect((await look(page, "#tf-explanation")).placeholder, "CONTROL: an empty editable body shows its placeholder")
      .toContain("Explain how to arrive at the correct answer");
  });

  test("another admin: a sealed challenge's toolbar is off with the author rule and the editor's sealed note as its description, a locked one names the superadmin, a locked sealed one both; the author's own stays on", async ({ page, browser }) => {
    await loginViaApi(page, other.email, PARTICIPANT_PASS);
    await openChallenges(page, [T.sealed.id, T.locked.id, T.sealedLocked.id]);
    await edit(page, T.sealed.id);
    await expect(page.locator("#tf-sealed-note"), "PRECONDITION: the sealed note is shown").toBeVisible();
    await expect(page.locator("#tf-reveal-row"), "PRECONDITION: a regular admin is offered no reveal").toBeHidden();
    await expectOff(page, "#tf-desc", RO.sealed, "tf-sealed-note");
    await expectOff(page, "#tf-explanation", RO.sealed, "tf-sealed-note");
    const desc = await page.locator("#tf-desc .rich-toolbar button[aria-label='Bold']").evaluate(b => b.getAttribute("aria-describedby"));
    expect(desc).toBe(`${await page.locator("#tf-desc .rt-ro-note").getAttribute("id")} tf-sealed-note`);
    const accDesc = page.locator("#tf-desc .rich-toolbar button[aria-label='Bold']");
    await expect(accDesc, "the description carries the short reason").toHaveAccessibleDescription(new RegExp(RO.sealed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(accDesc, "…and the editor's own sealed note").toHaveAccessibleDescription(new RegExp(SEALED_NOTE_FIRST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const L = await look(page, "#tf-explanation");
    expect(L.placeholder, "the withheld explanation's empty box invites no edit").toBe("none");
    // The seal leaves attachments editable (v8.12.0): another global admin keeps every attachment write.
    expect(await attachWrites(page, 1), "a sealed challenge keeps its attachment writes for a global admin").toEqual({ add: true, actions: ["Rename", "Download", "Remove"] });
    await pressEverything(page, "#tf-desc");

    await edit(page, T.locked.id);
    await expectOff(page, "#tf-desc", RO.locked);
    await edit(page, T.sealedLocked.id);
    await expectOff(page, "#tf-desc", `${RO.locked} Its answer is also sealed by the person who created it.`, "tf-sealed-note");

    // CONTROL: the author's own sealed challenge, in a context of its own.
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const p2 = await ctx.newPage();
      await loginViaApi(p2, author.email, PARTICIPANT_PASS);
      await openChallenges(p2, [T.sealed.id]);
      await edit(p2, T.sealed.id);
      for (const sel of EDITORS) await expectOn(p2, sel);
      await expect(p2.locator("#save-task-btn"), "CONTROL: the author may save").toBeVisible();
    } finally { await ctx.close(); }
  });

  test("a competitor sees the competitor's reason", async ({ page }) => {
    await loginViaApi(page, competitor.email, PARTICIPANT_PASS);
    await openChallenges(page, [T.sealed.id]);
    expect(await page.evaluate(id => (window.adminTasksData.find(t => t.id === id).competing_in || []).length, T.sealed.id),
      "PRECONDITION: the row says this reader competes in an event holding it").toBeGreaterThan(0);
    await edit(page, T.sealed.id);
    await expectOff(page, "#tf-desc", RO.competing, "tf-sealed-note");
    await expect(page.locator("#save-task-btn")).toBeHidden();
  });

  test("an organiser opening a co-organiser's challenge gets a read-only form with no Save, and the reason; their own challenge stays editable", async ({ page }) => {
    await loginViaApi(page, ea.email, PARTICIPANT_PASS);
    await openChallenges(page, [T.coPlain.id, T.eaOwn.id]);
    await edit(page, T.coPlain.id);
    await expect(page.locator("#save-task-btn"), "no Save the server would refuse").toBeHidden();
    await expect(page.locator("#tf-title"), "the fields are read-only").toBeDisabled();
    await expect(page.locator("#tf-answer")).toBeDisabled();
    for (const sel of EDITORS) await expectOff(page, sel, RO.notMine);
    expect(await attachWrites(page, 1), "nor an attachment write the routes would refuse: Download only").toEqual({ add: false, actions: ["Download"] });
    await expect(page.locator("#tf-scoring-locked-note"), "no note saying the rest can still be edited").toBeHidden();
    // CONTROL: their own challenge, same session.
    await edit(page, T.eaOwn.id);
    await expect(page.locator("#save-task-btn")).toBeVisible();
    expect((await attachWrites(page, 0)).add, "CONTROL: their own challenge offers Add attachment").toBe(true);
    await expect(page.locator("#tf-title")).toBeEnabled();
    for (const sel of EDITORS) await expectOn(page, sel);
  });

  test("a superadmin in an organiser's panel: the sealed reason says the reveal does not grant editing, and after revealing through the editor the re-entered form is read-only by the organiser's own-challenge rule", async ({ page }) => {
    await loginViaApi(page, sup.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const imp = await page.request.post(`/api/admin/participants/${ea.id}/impersonate`,
      { headers: { "x-csrf-token": csrfToken, "content-type": "application/json" }, data: { view: "admin" } });
    expect(imp.ok(), `enter the organiser's panel: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    await openChallenges(page, [T.coSealed.id]);
    await expect(page.locator("#impersonation-banner"), "PRECONDITION: inside the organiser's panel").toBeVisible();
    await edit(page, T.coSealed.id);
    await expect(page.locator("#tf-reveal-row")).toBeVisible();
    await expectOff(page, "#tf-desc", RO.sealedRevealPanel, "tf-sealed-note");

    await page.locator("#tf-reveal-row button[data-action='task-reveal-sealed']").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10_000 });
    await expect(page.locator("#modal-title")).toHaveText("Reveal sealed answer");
    const posted = page.waitForResponse(r => r.url().includes(`/api/admin/tasks/${T.coSealed.id}/sealed-reveal`) && r.request().method() === "POST", { timeout: 15_000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-title")).toHaveText("Impersonation mode", { timeout: 10_000 });
    await page.locator("#modal-confirm-btn").click();
    expect((await posted).status()).toBe(200);
    // Re-entered on the reloaded row: the key is now shown, and the seat still
    // may not edit a co-organiser's challenge.
    await expect(page.locator("#tf-answer"), "the reveal took: the key is in the box").toHaveValue(/^COKEY_/, { timeout: 20_000 });
    await expect(page.locator("#tf-sealed-note")).toContainText("because you revealed it as a superadmin");
    await expect(page.locator("#save-task-btn"), "no Save the seat's rule would refuse").toBeHidden();
    await expect(page.locator("#tf-answer")).toBeDisabled();
    for (const sel of EDITORS) await expectOff(page, sel, RO.notMine);
  });
});
