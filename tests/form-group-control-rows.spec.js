// @ts-check
//
// v8.13.8 — A CLASSED <label> INSIDE A .form-group IS A CONTROL ROW, NOT A
// CAPTION.
//
// `.form-group label{display:block;font-size:.85rem;color:var(--muted);
// margin-bottom:6px}` is specificity (0,1,1). It out-ranked the (0,1,0) class
// rule of every classed label that sat in a form group — `.checkbox-row`,
// `.picker-row`, `.choice-correct` — so the row turned block (its box stacked
// above its text, or left only a word-space from it), its text took the muted
// caption colour and the caption's size, and it gained the caption's 6px gap.
// The rule is now `.form-group label:where(:not([class]))`: same specificity,
// classless captions only.
//
// WHAT THIS FILE PINS, in the real dialogs, as GEOMETRY and COMPUTED COLOUR (a
// markup assertion passes against a layout that brings the skew back another
// way — CLAUDE.md, *Evidence*):
//   1. Grant Attempts (`#ag-people`, `label.picker-row` with a radio): the radio
//      is beside the name, vertically inside the row body, the name is not the
//      muted token and not caption-sized, the row has no 6px gap. Light, plus a
//      dark colour pass.
//   2. The Create Event form: `Staff can compete`, `Mark as test / dry run` and
//      `Reveal correct answers…` (`label.checkbox-row`), plus a sweep over every
//      visible checkbox row in the form.
//   3. The challenge editor: `Seal the answer` (`label.checkbox-row`).
//   4. The multiple-choice tick (`label.choice-correct`): centred on its choice
//      input, no 6px gap.
//   5. CONTROLS in each dialog: a classless caption is still block, .85rem,
//      muted and 6px above its control — the narrowing must not have taken the
//      caption rule with it.
//
// Every "not muted" check carries a positive control in the same read: an
// element in the same dialog that IS muted resolves to the probe's value, so a
// probe that resolved to nothing (or to the text colour) cannot pass the check
// vacuously.
//
// Mutations this catches (each by a named assertion; see the RETURN of the
// v8.13.8 work): the caption rule widened back to every label; the caption
// rule's margin-bottom dropped; the narrowing written as a deny-list
// (`:not(.checkbox-row)`) that misses `.picker-row` and `.choice-correct`.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const {
  adminLogin, clickTab, findSeededTaskRow, openKebab, openCompCreateForm, rowMarking, textContrast,
} = require("./ui-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `fg${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const tok = async (api) => (await (await api.get("/api/csrf-token")).json()).csrfToken;

// The caption rule's values, as the browser computes them at the default 16px
// root: `var(--fs-14)` (.875rem on the type scale) is 14px.
const CAPTION_PX = "14px";

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Row", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `?search=` is ignored by this endpoint (CLAUDE.md); take the capped page
  // and filter here.
  const list = await (await api.get("/api/admin/participants?limit=500")).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify ${label}: ${await v.text()}`).toBeTruthy();
  const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(a.ok(), `approve ${label}: ${await a.text()}`).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

/** Light theme is the default; assert it rather than assume it, since every
 *  colour below is read against one theme's tokens. */
async function expectTheme(page, theme) {
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme),
    { message: `the page is in the ${theme} theme`, timeout: 5000 }).toBe(theme);
}

async function toDarkTheme(page) {
  // Nothing stored is the house mode, which follows the OS too (HOUSE_MODE "system"); "system" is stored
  // so the page follows the OS live whatever that default becomes.
  const was = await page.evaluate(() => { try { const v = localStorage.getItem("hck-theme"); localStorage.setItem("hck-theme", "system"); return v; } catch (_) { return "unreadable"; } });
  expect([null, "system"], "PRECONDITION: no stored theme pin (nothing, or \"system\")").toContain(was);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
}

/** One read of a control row: the box and the text it labels, as rectangles,
 *  plus the row's own display, gap and margin, and the text's first LINE box
 *  (a Range over the text, so a wrapped label is judged on its first line). */
async function rowGeometry(label, boxSel, textSel) {
  return label.evaluate((el, [bs, ts]) => {
    const box = el.querySelector(bs);
    const text = el.querySelector(ts);
    if (!box || !text) return { missing: { box: !!box, text: !!text } };
    const rect = n => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    const cs = getComputedStyle(el);
    const ts2 = getComputedStyle(text);
    return {
      box: rect(box), text: rect(text),
      firstLine: lines.length ? { top: lines[0].top, bottom: lines[0].bottom, left: lines[0].left } : null,
      display: cs.display, gap: parseFloat(cs.columnGap) || 0, marginBottom: cs.marginBottom,
      fontSize: ts2.fontSize, textColor: ts2.color, textContent: (text.textContent || "").trim(),
    };
  }, [boxSel, textSel]);
}

/** The `var(--text)` token resolved in an element's own cascade (a probe child,
 *  removed again), the counterpart of rowMarking's `muted`. */
async function textToken(locator) {
  return locator.evaluate(el => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text)";
    el.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
}

/** A classless caption, read whole. */
async function captionStyle(locator) {
  const s = await locator.evaluate(el => {
    const cs = getComputedStyle(el);
    return { display: cs.display, fontSize: cs.fontSize, color: cs.color, marginBottom: cs.marginBottom, cls: el.getAttribute("class") };
  });
  const { muted } = await rowMarking(locator);
  return { ...s, muted };
}

/** CONTROL 5: the caption rule still reaches a classless caption. */
async function expectCaption(locator, where) {
  await expect(locator, `${where}: the caption is on screen`).toBeVisible();
  const c = await captionStyle(locator);
  expect(c.cls, `${where}: PRECONDITION — the caption is classless, so the narrowed rule is the one under test`).toBeNull();
  expect(c.display, `${where}: CONTROL — a caption is still a block above its control`).toBe("block");
  expect(c.fontSize, `${where}: CONTROL — a caption is still --fs-14 (${CAPTION_PX})`).toBe(CAPTION_PX);
  expect(c.color, `${where}: CONTROL — a caption is still the muted token`).toBe(c.muted);
  expect(c.marginBottom, `${where}: CONTROL — a caption keeps its 6px gap to the control below`).toBe("6px");
  return c;
}

/** How many lines the row's text runs to (distinct line-box tops of its span). */
async function lineCount(label) {
  return label.locator("span").first().evaluate(el => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top))).size;
  });
}

/** Families 2 and 3: a `label.checkbox-row` reads as a row. */
async function expectCheckboxRow(label, name, caption) {
  await expect(label, `${name}: the row is on screen`).toBeVisible();
  const g = await rowGeometry(label, 'input[type="checkbox"]', "span");
  expect(g.missing, `${name}: the row has a box and a text span`).toBeUndefined();
  expect(g.textContent.length, `${name}: the text span is the visible label, not an empty node`).toBeGreaterThan(3);
  // GEOMETRY first: the claim is where the box is, whatever display reaches it.
  // The gap is the row's own `gap` (8px); under the caption's `display:block`
  // the gap does not apply and only a word-space separates box and text.
  expect(g.box.right + Math.max(g.gap, 6), `${name}: the box sits beside its text with the row's gap, not a word-space`)
    .toBeLessThanOrEqual(g.text.left + 0.5);
  expect(g.box.left, `${name}: the box is LEFT of its text, not above it`).toBeLessThan(g.text.left);
  expect(g.firstLine, `${name}: the text has a laid-out first line`).toBeTruthy();
  const boxMid = (g.box.top + g.box.bottom) / 2;
  expect(boxMid, `${name}: the box is level with the first text line (not above it)`).toBeGreaterThanOrEqual(g.firstLine.top);
  expect(boxMid, `${name}: the box is level with the first text line (not below it)`).toBeLessThanOrEqual(g.firstLine.bottom);
  const mk = await rowMarking(label);
  const txt = await textToken(label);
  expect(mk.muted, `${name}: PRECONDITION — the muted probe resolved to a colour that differs from the text token`).not.toBe(txt);
  expect(g.textColor, `${name}: the row's text is not the caption's muted colour`).not.toBe(mk.muted);
  expect(g.textColor, `${name}: …it is the text token`).toBe(txt);
  expect(g.marginBottom, `${name}: the row carries no caption gap below it`).toBe("0px");
  // Diagnostic, after the geometry: the class rule's display is the one in force.
  expect(g.display, `${name}: the row is a flex row (its own class), not the caption's block`).toBe("flex");
  // Anti-vacuity for the colour: the caption beside it IS muted under the same probe.
  expect(caption.color, `${name}: CONTROL — the dialog's caption reads muted under the same probe`).toBe(caption.muted);
  return g;
}

test.describe("v8.13.8 — a classed label inside a form group keeps its own layout", () => {
  test("Grant Attempts: each participant row puts the radio beside the name, full-size and unmuted", async ({ page }) => {
    await adminLogin(page);
    await expectTheme(page, "light");
    const api = page.request;
    const csrf = await tok(api);

    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `${uniq()} Ev`, event_kind: "tournament", start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
    });
    expect(cr.ok(), `create event: ${await cr.text()}`).toBeTruthy();
    const comp = (await cr.json()).competition;
    const title = `${uniq()} T`;
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published", attempt_cap: 2 },
    });
    expect(tr.ok(), `create task: ${await tr.text()}`).toBeTruthy();
    // Take the id the create RETURNS, never a lookup by title.
    const task = { id: (await tr.json()).id, title };
    expect(task.id, "the create returns the new challenge's id").toBeTruthy();
    const as = await api.post(`/api/admin/tasks/${task.id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(as.ok(), `assign: ${await as.text()}`).toBeTruthy();
    const p1 = await makeParticipant(api, csrf, uniq());
    const p2 = await makeParticipant(api, csrf, uniq());
    const en = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p1.id, p2.id], competitionIds: [comp.id] } });
    expect(en.ok(), `enrol: ${await en.text()}`).toBeTruthy();
    expect((await en.json()).assigned, "both participants were really enrolled").toBe(2);

    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, task.title);
    await expect(row.first()).toBeVisible({ timeout: 15000 });
    await openKebab(page, row.first());
    await page.locator('#kebab-portal [data-action="task-attempt-grant"]').click();
    const overlay = page.locator("#attempt-grant-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    const pRow = overlay.locator(`#ag-people label.picker-row:has(input[value="${p1.id}"])`);
    await expect(pRow, "the participant's row rendered").toBeVisible({ timeout: 15000 });
    await expect(overlay.locator("#ag-people label.picker-row"), "both enrolled participants are listed").toHaveCount(2);

    const caption = await expectCaption(overlay.locator('label[for="ag-comp"]'), "Grant Attempts 'Event'");

    const g = await pRow.evaluate(el => {
      const r = n => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
      const radio = el.querySelector("input.picker-row-check");
      const body = el.querySelector(".picker-row-body");
      const name = body && body.querySelector("strong");
      const full = body && body.querySelector("span");
      return {
        radio: radio && r(radio), body: body && r(body), name: name && r(name),
        display: getComputedStyle(el).display, marginBottom: getComputedStyle(el).marginBottom,
        nameColor: name && getComputedStyle(name).color, nameSize: name && getComputedStyle(name).fontSize,
        fullColor: full && getComputedStyle(full).color, fullText: full && full.textContent.trim(),
        modalSize: getComputedStyle(el.closest(".picker-modal")).fontSize,
      };
    });
    expect(g.radio && g.body && g.name, "the row has its radio, its body and the name").toBeTruthy();
    expect(g.radio.right, "Grant Attempts: the radio sits LEFT of the name, not stacked above it").toBeLessThanOrEqual(g.name.left);
    const radioMid = (g.radio.top + g.radio.bottom) / 2;
    expect(radioMid, "Grant Attempts: the radio is level with the row body (not above it)").toBeGreaterThanOrEqual(g.body.top);
    expect(radioMid, "Grant Attempts: the radio is level with the row body (not below it)").toBeLessThanOrEqual(g.body.bottom);
    expect(g.marginBottom, "Grant Attempts: the row carries no caption gap").toBe("0px");
    expect(g.nameSize, "Grant Attempts: the name is the dialog's size, not shrunk to the caption's .85rem").toBe(g.modalSize);
    expect(g.nameSize, "Grant Attempts: PRECONDITION — at this viewport the dialog text is larger than a caption").not.toBe(caption.fontSize);

    const mk = await rowMarking(pRow);
    const txt = await textToken(pRow);
    expect(mk.muted, "PRECONDITION — the muted probe differs from the text token").not.toBe(txt);
    expect(g.fullText, "PRECONDITION — the row carries the participant's full name in its muted span").toContain(p1.nickname);
    expect(g.fullColor, "CONTROL — the full-name span IS the muted token under the same probe").toBe(mk.muted);
    expect(mk.color, "Grant Attempts: the row's text is not the caption's muted colour").not.toBe(mk.muted);
    expect(g.nameColor, "Grant Attempts: the name is not muted").not.toBe(mk.muted);
    expect(g.nameColor, "Grant Attempts: the name is the text token").toBe(txt);
    const cn = await textContrast(pRow.locator(".picker-row-body strong"));
    expect(cn.ratio, `Grant Attempts: the name reads at AA on its row (${JSON.stringify(cn)})`).toBeGreaterThanOrEqual(4.5);

    // Dark: the same colour claims under the dark tokens.
    await toDarkTheme(page);
    const mkD = await rowMarking(pRow);
    const txtD = await textToken(pRow);
    const dark = await pRow.evaluate(el => ({
      name: getComputedStyle(el.querySelector(".picker-row-body strong")).color,
      full: getComputedStyle(el.querySelector(".picker-row-body span")).color,
    }));
    expect(txtD, "PRECONDITION — the dark text token differs from the light one").not.toBe(txt);
    expect(mkD.muted, "PRECONDITION — dark: the muted probe differs from the text token").not.toBe(txtD);
    expect(dark.full, "dark CONTROL — the full-name span is the dark muted token").toBe(mkD.muted);
    expect(dark.name, "Grant Attempts (dark): the name is not muted").not.toBe(mkD.muted);
    expect(dark.name, "Grant Attempts (dark): the name is the dark text token").toBe(txtD);
  });

  // Two kinds, because each carries rows the other withholds: a Competition has
  // Reveal answers, the group board, time on platform and its tie-break; a
  // Booth Event has Allow late entries. Staff
  // can compete, the dry-run tag and the CxOne opt-out are on both.
  const KIND_ROWS = {
    tournament: { label: "Competition", floor: 7, named: [
      ["Staff can compete", /^\s*Staff can compete\s*$/],
      ["Mark as test / dry run", /^\s*Mark as test \/ dry run\s*$/],
      ["Reveal correct answers", /^\s*Reveal correct answers/],
    ] },
    booth: { label: "Booth Event", floor: 4, named: [
      ["Allow late entries", /^\s*Allow late entries\s*$/],
      ["Mark as test / dry run", /^\s*Mark as test \/ dry run\s*$/],
    ] },
  };

  test("Create Event form: every tick-box row sits beside its words, in the text colour, with no caption gap", async ({ page }) => {
    await adminLogin(page);
    await expectTheme(page, "light");
    await clickTab(page, "Events");
    for (const [kind, spec] of Object.entries(KIND_ROWS)) {
      await openCompCreateForm(page, kind);
      const form = page.locator("#comp-form-overlay");
      const caption = await expectCaption(form.locator('label[for="comp-name"]'), `${spec.label} form 'Name'`);

      for (const [name, re] of spec.named) {
        const label = form.locator("label.checkbox-row").filter({ has: page.locator("span", { hasText: re }) });
        await expect(label, `PRECONDITION — exactly one '${name}' row in the ${spec.label} form`).toHaveCount(1);
        await expectCheckboxRow(label, `${spec.label} form '${name}'`, caption);
      }

      // The sweep: every visible tick-box row in the form, whatever it is
      // called. EXCLUDED: the sign-up matrix's "Show on form" cells
      // (.reg-matrix-shown) — their only text is screen-reader text, so there is
      // no visible line to align the box against, and they sit in a table cell,
      // not a form group. The floor keeps the sweep from passing over nothing.
      const all = form.locator("label.checkbox-row:not(.reg-matrix-shown):visible");
      const n = await all.count();
      expect(n, `${spec.label}: the sweep reaches the form's tick-box rows`).toBeGreaterThanOrEqual(spec.floor);
      for (let i = 0; i < n; i++) {
        const label = all.nth(i);
        const t = ((await label.locator("span").first().textContent()) || "").trim();
        await expectCheckboxRow(label, `${spec.label} form row ${i} '${t.slice(0, 40)}'`, caption);
      }
      await form.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
      await form.waitFor({ state: "hidden", timeout: 10000 });
    }
  });

  test("Challenge editor: the Seal the answer row sits beside its words, in the text colour, with no caption gap", async ({ page }) => {
    await adminLogin(page);
    await expectTheme(page, "light");
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 15000 });

    const caption = await expectCaption(page.locator('label[for="tf-title"]'), "Challenge editor 'Title'");
    await expectCheckboxRow(page.locator("#tf-seal-group label.checkbox-row"), "Challenge editor 'Seal the answer'", caption);
  });

  // A control row can WRAP (a long label on a phone). Its box stays on the
  // FIRST line, as the other multi-line checkbox rows do — centred on the whole
  // text block, a three-line row would put the box beside its second line. The
  // dialog is opened at desktop width and then narrowed, so the drawer and the
  // tab bar of the phone layout play no part.
  test("At phone width a WRAPPED tick-box row keeps its box on the first line (event form, challenge editor)", async ({ page }) => {
    await adminLogin(page);
    await expectTheme(page, "light");
    await clickTab(page, "Events");
    await openCompCreateForm(page, "tournament");
    const form = page.locator("#comp-form-overlay");
    const caption = await expectCaption(form.locator('label[for="comp-name"]'), "Competition form 'Name'");
    await page.setViewportSize({ width: 360, height: 800 });
    const reveal = form.locator("label.checkbox-row").filter({ has: page.locator("span", { hasText: /Reveal correct answers/ }) });
    await expect(reveal, "PRECONDITION — exactly one 'Reveal correct answers' row").toHaveCount(1);
    await reveal.scrollIntoViewIfNeeded();
    expect(await lineCount(reveal), "PRECONDITION — at 360px the 'Reveal correct answers' row wraps").toBeGreaterThanOrEqual(2);
    await expectCheckboxRow(reveal, "Competition form 'Reveal correct answers' at 360px", caption);
    await page.setViewportSize({ width: 1280, height: 900 });
    await form.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
    await form.waitFor({ state: "hidden", timeout: 10000 });

    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 15000 });
    const tCaption = await expectCaption(page.locator('label[for="tf-title"]'), "Challenge editor 'Title'");
    await page.setViewportSize({ width: 360, height: 800 });
    const seal = page.locator("#tf-seal-group label.checkbox-row");
    await seal.scrollIntoViewIfNeeded();
    expect(await lineCount(seal), "PRECONDITION — at 360px the 'Seal the answer' row wraps").toBeGreaterThanOrEqual(2);
    await expectCheckboxRow(seal, "Challenge editor 'Seal the answer' at 360px", tCaption);
  });

  test("Multiple choice: each correct-answer tick is centred on its choice and carries no caption gap", async ({ page }) => {
    await adminLogin(page);
    await expectTheme(page, "light");
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-title").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#tf-atype").selectOption("choice");
    const rows = page.locator("#tf-choices-list .choice-row");
    await expect(rows, "PRECONDITION — the editor opens with two choices").toHaveCount(2);

    await expectCaption(page.locator('label[for="tf-title"]'), "Challenge editor 'Title' (choice mode)");

    for (let i = 0; i < 2; i++) {
      const g = await rows.nth(i).evaluate(row => {
        const label = row.querySelector("label.choice-correct");
        const box = label && label.querySelector('input[type="checkbox"]');
        const text = row.querySelector("input.choice-text");
        const mid = n => { const b = n.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
        return label && box && text ? {
          boxMid: mid(box), textMid: mid(text), labelMarginBottom: getComputedStyle(label).marginBottom,
          boxH: box.getBoundingClientRect().height, textH: text.getBoundingClientRect().height,
        } : null;
      });
      expect(g, `choice ${i + 1}: the row has its tick and its text input`).toBeTruthy();
      expect(g.boxH, `choice ${i + 1}: PRECONDITION — the tick is laid out`).toBeGreaterThan(10);
      expect(g.textH, `choice ${i + 1}: PRECONDITION — the text input is laid out`).toBeGreaterThan(10);
      expect(Math.abs(g.boxMid - g.textMid), `Multiple choice ${i + 1}: the tick is centred on its choice (±1px)`).toBeLessThanOrEqual(1);
      expect(g.labelMarginBottom, `Multiple choice ${i + 1}: the tick's label carries no caption gap`).toBe("0px");
    }
  });
});
