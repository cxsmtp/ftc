// @ts-check
//
// v9.2.15 — EVERY CUSTOM EDIT IN THE CHALLENGE EDITOR UNDOES AS ONE STEP.
//
// Inline Code, Code Block, Insert Link (with Update and Remove Link), the Table menu's
// row, column and Delete table items and a code language picked from a code block's
// menu are the editor's own DOM work, which the browser's history never sees: Ctrl+Z
// passed over each and undid the typing before it instead, at places the change had
// split or moved since. Each is now a step of the editor's own (`_rtEdit`), on the
// stack the colour picks already use (`_rtStep`, tests/richtext-colours.spec.js §7):
// recorded while it runs, reversed node for node, the last first. This file holds:
//   1. each operation undoes and redoes as one step, leaving the browser's history
//      before it intact (the typed text undoes next, as the browser always did);
//   2. an Update that changes nothing, a cancelled dialog and a language already set
//      make no step; a read-only editor (a locked or sealed challenge) is not changed;
//   3. the keyboard: a toolbar button pressed with Enter keeps the focus, and Ctrl+Z,
//      Ctrl+Y, Cmd+Z and Cmd+Shift+Z from there take the step; Insert Link opens its
//      dialog from Enter instead of inserting `https://` at once; Ctrl+Z inside an
//      open toolbar menu leaves the editor's step (and the menu's selection) alone;
//   4. the steps and the browser's history together (typing ends a step, one stack
//      with the colour picks, a new step clears redo, loading other text forgets all);
//   5. source: every toolbar command, Table menu item, font menu item, colour swatch
//      and code-language pick is decided as the browser's step or the editor's own.
// The description field stands for all three: the explanation and hint fields are the
// same createRichEditor, with the same toolbar and listeners.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { stripJsComments } = require("./doc-registry");
const F = require("./richtext-editor-fixture");
const fs = require("fs");
const pathMod = require("path");

test.use({ baseURL: BASE });

const { BODY, setDesc, getDesc, selectIn, caretIn, selected, undo, redo, menuUndo, menuRedo, browserHistory, tick, toolbar, press, openTableItem } = F;
const focusedLabel = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.className || "");
const bodyHasFocus = (page) => page.evaluate((sel) => document.activeElement === document.querySelector(sel), BODY);

// ── 1. Each operation is one step ──────────────────────────────────────────
test.describe("Inline Code and Code Block undo as one step", () => {
  test("Inline Code and Code Block each undo as one step, before the typing ahead of them, and redo", async ({ page }) => {
    await F.openEditor(page);
    await setDesc(page, "<p>Alpha</p>");
    await caretIn(page, "Alpha", 5);
    await page.keyboard.type(" Bravo Charlie");
    expect(await getDesc(page), "PRECONDITION: the browser typed it").toBe("<p>Alpha Bravo Charlie</p>");
    expect(await page.evaluate((sel) => { window.__t = document.querySelector(sel).querySelector("p").firstChild; return window.__t.data; }, BODY),
      "PRECONDITION: the typed text is one text node").toBe("Alpha Bravo Charlie");
    await selectIn(page, "Bravo", 0, 5);
    await press(page, "Inline Code");
    const coded = "<p>Alpha <code>Bravo</code> Charlie</p>";
    expect(await getDesc(page)).toBe(coded);
    await tick(page);
    expect(await page.locator(`${BODY} code`).getAttribute("spellcheck"), "PRECONDITION: the code is marked, and the marking observer has had its turn").toBe("false");
    await undo(page);
    expect(await getDesc(page), "Ctrl+Z takes the code off, the typed text kept").toBe("<p>Alpha Bravo Charlie</p>");
    expect(await selected(page), "with the text it wrapped selected again").toBe("Bravo");
    expect(await page.evaluate((sel) => document.querySelector(sel).contains(window.__t) && window.__t.data, BODY),
      "node for node: the typed text is the same text node again, never re-parsed").toBe("Alpha Bravo Charlie");
    await redo(page);
    expect(await getDesc(page), "Ctrl+Shift+Z puts it back").toBe(coded);
    await undo(page);
    await undo(page);
    expect(await getDesc(page), "CONTROL: the browser's own step, the typing, undoes next, as it always did").toBe("<p>Alpha</p>");

    // Unwrapping inline code is one step too.
    await setDesc(page, "<p>x <code>y</code> z</p>");
    await caretIn(page, "y", 1);
    await press(page, "Inline Code");
    expect(await getDesc(page)).toBe("<p>x y z</p>");
    await undo(page);
    expect(await getDesc(page)).toBe("<p>x <code>y</code> z</p>");
    await redo(page, "Control+y");
    expect(await getDesc(page)).toBe("<p>x y z</p>");

    // Code Block, both ways.
    await setDesc(page, "<p>one</p><p>let a = 1;</p>");
    await selectIn(page, "let a = 1;", 0, 10);
    await press(page, "Code Block");
    const blocked = await getDesc(page);
    expect(blocked).toContain("<pre><code>let a = 1;</code></pre>");
    await undo(page);
    expect(await getDesc(page)).toBe("<p>one</p><p>let a = 1;</p>");
    await redo(page);
    expect(await getDesc(page)).toBe(blocked);
    await setDesc(page, "<pre><code>a = 1</code></pre>");
    await caretIn(page, "a = 1", 1);
    await press(page, "Code Block");
    expect(await getDesc(page)).toBe("<div>a = 1</div>");
    await undo(page);
    expect(await getDesc(page)).toBe("<pre><code>a = 1</code></pre>");
    await redo(page);
    expect(await getDesc(page), "the unwrap redoes").toBe("<div>a = 1</div>");
  });
});

test.describe("Insert Link, Update and Remove Link undo as one step", () => {
  test("a new link, an Update and Remove Link each undo and redo; an Update that changes nothing and a cancelled dialog make no step", async ({ page }) => {
    await F.openEditor(page);
    const dlg = page.locator("#link-dlg-url");
    const linked = (href, text = "docs") => `<p>see <a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a> here</p>`;
    // A new link on a selection.
    await setDesc(page, "<p>see docs here</p>");
    await selectIn(page, "docs", 0, 4);
    await press(page, "Insert Link");
    await dlg.fill("https://example.com/d");
    await page.locator("#link-dlg-ok").click();
    expect(await getDesc(page)).toBe(linked("https://example.com/d"));
    expect(await bodyHasFocus(page), "PRECONDITION: focus is back in the editor").toBe(true);
    await undo(page);
    expect(await getDesc(page)).toBe("<p>see docs here</p>");
    expect(await selected(page)).toBe("docs");
    await redo(page);
    expect(await getDesc(page)).toBe(linked("https://example.com/d"));
    // A new link at a bare caret, with its own text.
    await setDesc(page, "<p>see docs here</p>");
    await caretIn(page, "see", 3);
    await press(page, "Insert Link");
    await dlg.fill("https://example.com/s");
    await page.locator("#link-dlg-text").fill("site");
    await page.locator("#link-dlg-ok").click();
    expect(await getDesc(page)).toBe('<p>see<a href="https://example.com/s" target="_blank" rel="noopener noreferrer">site</a> docs here</p>');
    await undo(page);
    expect(await getDesc(page)).toBe("<p>see docs here</p>");
    // Update: the href changes as one step, and the caret is back in the link.
    await setDesc(page, linked("https://example.com/d"));
    await caretIn(page, "docs", 2);
    await press(page, "Insert Link");
    await expect(page.locator("#link-dlg-remove"), "PRECONDITION: the dialog is editing the link").toBeVisible();
    await dlg.fill("https://example.com/e");
    await page.locator("#link-dlg-ok").click();
    expect(await getDesc(page)).toBe(linked("https://example.com/e"));
    await undo(page);
    expect(await getDesc(page)).toBe(linked("https://example.com/d"));
    expect(await page.evaluate((sel) => !!getSelection().anchorNode && !!document.querySelector(`${sel} a`).contains(getSelection().anchorNode), BODY),
      "the selection is back inside the link").toBe(true);
    await redo(page, "Control+y");
    expect(await getDesc(page)).toBe(linked("https://example.com/e"));
    // An Update that changes nothing makes no step.
    await setDesc(page, linked("https://example.com/d"));
    await caretIn(page, "docs", 2);
    await press(page, "Insert Link");
    await expect(dlg).toHaveValue("https://example.com/d");
    await page.locator("#link-dlg-ok").click();
    await expect(dlg).toHaveCount(0);
    expect(await getDesc(page)).toBe(linked("https://example.com/d"));
    expect(await menuUndo(page), "an unchanged Update leaves no step").toBe(false);
    // Remove Link.
    await caretIn(page, "docs", 2);
    await press(page, "Insert Link");
    await page.locator("#link-dlg-remove").click();
    expect(await getDesc(page)).toBe("<p>see docs here</p>");
    await undo(page);
    expect(await getDesc(page), "Ctrl+Z puts the link back exactly").toBe(linked("https://example.com/d"));
    // A cancelled dialog makes no step.
    await setDesc(page, "<p>see docs here</p>");
    await selectIn(page, "docs", 0, 4);
    await press(page, "Insert Link");
    await page.locator("#link-dlg-cancel").click();
    expect(await getDesc(page)).toBe("<p>see docs here</p>");
    expect(await menuUndo(page), "a cancelled dialog leaves no step").toBe(false);
    // Enter on a dialog BUTTON is that button's press, never a submit: Enter on
    // Cancel inserts nothing (the URL box holds the prefilled https://), and Enter
    // on Remove Link removes the link (a submit would Update it to itself).
    await selectIn(page, "docs", 0, 4);
    await press(page, "Insert Link");
    await expect(dlg, "PRECONDITION: the dialog is open, its URL box prefilled").toHaveValue("https://");
    await page.locator("#link-dlg-cancel").focus();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    expect(await getDesc(page), "Enter on Cancel inserts no link").toBe("<p>see docs here</p>");
    expect(await menuUndo(page), "and makes no step").toBe(false);
    await setDesc(page, linked("https://example.com/d"));
    await caretIn(page, "docs", 2);
    await press(page, "Insert Link");
    await expect(page.locator("#link-dlg-remove"), "PRECONDITION: the dialog is editing the link").toBeVisible();
    await page.locator("#link-dlg-remove").focus();
    await page.keyboard.press("Enter");
    await expect(dlg).toHaveCount(0);
    expect(await getDesc(page), "Enter on Remove Link removes the link").toBe("<p>see docs here</p>");
    // CONTROL: Enter in the URL box still submits.
    await selectIn(page, "docs", 0, 4);
    await press(page, "Insert Link");
    await dlg.fill("https://example.com/k");
    await dlg.press("Enter");
    await expect(dlg).toHaveCount(0);
    expect(await getDesc(page), "Enter in the URL box inserts the link").toBe(linked("https://example.com/k"));
  });
});

const TABLE = '<table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p>end</p>';
const counts = (page) => page.evaluate((sel) => {
  const b = document.querySelector(sel), t = b.querySelector("table");
  return t ? { rows: t.querySelectorAll("tr").length, headCells: t.querySelectorAll("th").length, bodyCells: t.querySelectorAll("td").length } : null;
}, BODY);

test.describe("The Table menu's edits undo as one step", () => {
  test("every Table menu item that edits a table undoes as one step and redoes; Insert table… stays the browser's own step", async ({ page }) => {
    await F.openEditor(page);
    // A redo selects what the step left selected; a selection it cannot restore is
    // reported (`rich editor: selection not restored`), never silent.
    const unrestored = [];
    page.on("console", (m) => { if (/selection not restored/.test(m.text())) unrestored.push(m.text()); });
    const items = [
      ["Insert row above", { rows: 3, headCells: 2, bodyCells: 4 }],
      ["Insert row below", { rows: 3, headCells: 2, bodyCells: 4 }],
      ["Insert column left", { rows: 2, headCells: 3, bodyCells: 3 }],
      ["Insert column right", { rows: 2, headCells: 3, bodyCells: 3 }],
      ["Delete row", { rows: 1, headCells: 2, bodyCells: 0 }],
      ["Delete column", { rows: 2, headCells: 1, bodyCells: 1 }],
      ["Delete table", null],
    ];
    for (const [label, want] of items) {
      await setDesc(page, TABLE);
      await caretIn(page, "1", 0);
      await openTableItem(page, label);
      const after = await getDesc(page);
      expect(after, `${label}: changed the table`).not.toBe(TABLE);
      expect(await counts(page), `${label}: the table it leaves`).toEqual(want);
      await undo(page);
      expect(await getDesc(page), `${label}: Ctrl+Z gives the table back exactly`).toBe(TABLE);
      await redo(page, "Control+y");
      expect(await getDesc(page), `${label}: Ctrl+Y does it again`).toBe(after);
    }
    // The last row: Delete row takes the table.
    const one = "<table><tbody><tr><td>1</td></tr></tbody></table><p>end</p>";
    await setDesc(page, one);
    await caretIn(page, "1", 0);
    await openTableItem(page, "Delete row");
    expect(await getDesc(page)).toBe("<p>end</p>");
    await undo(page);
    expect(await getDesc(page)).toBe(one);

    // CONTROL: Insert table… is execCommand('insertHTML'), the browser's own step.
    await setDesc(page, "<p>x</p>");
    await caretIn(page, "x", 1);
    await openTableItem(page, "Insert table…");
    await page.locator("#table-insert-overlay #tbl-rows").fill("2");
    await page.locator("#table-insert-overlay #tbl-cols").fill("2");
    await page.locator("#table-insert-overlay #tbl-ok").click();
    await expect(page.locator(`${BODY} table`)).toHaveCount(1);
    expect(await menuUndo(page), "Insert table… is not a step of the editor's own").toBe(false);
    await undo(page);
    expect(await getDesc(page), "the browser's own undo takes the table out (measured exact in Chromium)").toBe("<p>x</p>");
    expect(unrestored, "every undo and redo restored its selection").toEqual([]);
  });

  test("a code language picked from a code block's menu undoes as one step, and focus returns to the editor; picking the language set makes no step", async ({ page }) => {
    await F.openEditor(page);
    await setDesc(page, "<pre><code>x = 1</code></pre>");
    const code = page.locator(`${BODY} code`);
    await code.click({ button: "right" });
    await page.locator(".code-lang-menu [aria-label='Python']").click();
    await expect(page.locator(".code-lang-menu")).toHaveCount(0);
    expect(await code.getAttribute("class")).toBe("language-python");
    expect(await bodyHasFocus(page), "PRECONDITION: focus is back in the editor").toBe(true);
    await undo(page);
    expect(await code.getAttribute("class"), "Ctrl+Z takes the language off").toBeNull();
    expect(await getDesc(page)).toBe("<pre><code>x = 1</code></pre>");
    await redo(page);
    expect(await code.getAttribute("class")).toBe("language-python");
    // Opened with no selection in the editor (as a keyboard's menu key can), the pick
    // still puts the focus back in the editor, so Ctrl+Z straight after it is taken.
    await setDesc(page, "<pre><code>x = 1</code></pre>");
    await page.evaluate((sel) => {
      getSelection().removeAllRanges();
      document.activeElement?.blur?.();
      const c = document.querySelector(`${sel} code`), r = c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 2, clientY: r.top + 2 }));
    }, BODY);
    await page.locator(".code-lang-menu [aria-label='Python']").click();
    expect(await code.getAttribute("class")).toBe("language-python");
    expect(await bodyHasFocus(page), "the focus is back in the editor").toBe(true);
    await undo(page);
    expect(await code.getAttribute("class"), "Ctrl+Z takes the language off").toBeNull();
    // The language already set (Auto-detect on a block with none) changes nothing.
    await setDesc(page, "<pre><code>x = 1</code></pre>");
    await code.click({ button: "right" });
    await page.locator(".code-lang-menu [aria-label='Auto-detect']").click();
    expect(await getDesc(page)).toBe("<pre><code>x = 1</code></pre>");
    expect(await menuUndo(page), "no step for a language that was already set").toBe(false);
  });
});

// ── 2. A read-only editor ───────────────────────────────────────────────────
test.describe("A read-only editor is not changed", () => {
  test("with the description read-only, Inline Code, a colour and Delete table change nothing and make no step; editable again, the same press does", async ({ page }) => {
    await F.openEditor(page);
    // Written straight to the attribute ON PURPOSE, past the editor's setReadOnly
    // (which would switch the toolbar off): the presses below must still reach the
    // inner guards (_rtStep, _rtEdit, insertLink), the defence under a disabled toolbar.
    const lock = (on) => page.evaluate(([sel, on]) => { document.querySelector(sel).contentEditable = on ? "false" : "true"; }, [BODY, on]);
    const pickRed = async () => {
      const bar = toolbar(page);
      if (await bar.locator(".rt-more-btn").getAttribute("aria-expanded") !== "true") await bar.locator(".rt-more-btn").click();
      await bar.locator("button[aria-label='Text Color']").click();
      await bar.locator('.color-pop [data-rt-swatch="red"]').click();
    };
    await setDesc(page, "<p>Alpha Bravo</p>" + TABLE);
    await lock(true);
    expect(await page.evaluate((sel) => document.querySelector(sel).isContentEditable, BODY), "PRECONDITION: the editor is read-only").toBe(false);
    await selectIn(page, "Bravo", 0, 5);
    await press(page, "Inline Code");
    await selectIn(page, "Alpha", 0, 5);
    await pickRed();
    await caretIn(page, "1", 0);
    await openTableItem(page, "Delete table");
    // Insert Link asks a read-only editor for no URL it could not use.
    await selectIn(page, "Bravo", 0, 5);
    await press(page, "Insert Link");
    expect(await page.locator("#link-dlg-url").count(), "Insert Link opens no dialog on a read-only editor").toBe(0);
    expect(await getDesc(page), "nothing in a read-only editor changed").toBe("<p>Alpha Bravo</p>" + TABLE);
    expect(await menuUndo(page), "and no step was kept").toBe(false);
    // CONTROL: editable again, the same presses act.
    await lock(false);
    await selectIn(page, "Bravo", 0, 5);
    await press(page, "Inline Code");
    await selectIn(page, "Alpha", 0, 5);
    await pickRed();
    expect(await getDesc(page)).toBe('<p><span style="color: var(--rt-red);">Alpha</span> <code>Bravo</code></p>' + TABLE);
    await selectIn(page, "Alpha", 0, 5);
    await press(page, "Insert Link");
    await expect(page.locator("#link-dlg-url"), "CONTROL: editable, Insert Link opens its dialog").toBeVisible();
    await page.locator("#link-dlg-cancel").click();
  });
});

// ── 3. The keyboard ─────────────────────────────────────────────────────────
test.describe("The toolbar's keyboard use undoes too", () => {
  test("with the focus on a toolbar button, Ctrl+Z, Ctrl+Y, Cmd+Z, Cmd+Shift+Z and the browser's own Undo and Redo take the editor's step; Bold stays the browser's", async ({ page }) => {
    await F.openEditor(page);
    // Inline Code pressed with Enter on a caret in code unwraps it and selects nothing
    // after, so the focus stays on the button (a wrap selects what it wrapped, which
    // moves the focus into the text).
    await setDesc(page, "<p>Alpha <code>Bravo</code></p>");
    await caretIn(page, "Bravo", 2);
    const btn = toolbar(page).locator("button[aria-label='Inline Code']");
    await btn.focus();
    await page.keyboard.press("Enter");
    const coded = "<p>Alpha <code>Bravo</code></p>", plain = "<p>Alpha Bravo</p>";
    expect(await getDesc(page)).toBe(plain);
    expect(await focusedLabel(page), "PRECONDITION: the focus is still on the button").toBe("Inline Code");
    // Before anything is typed in this page, the browser has no Undo or Redo of its own
    // to fire for these keys (Chromium on Linux binds none to Meta+Z): only the editor's
    // key handler, on the whole editor, can answer them from the button.
    expect(await browserHistory(page), "PRECONDITION: the browser has no Undo or Redo of its own here").toEqual([false, false]);
    // Restoring the selection after each key moves the focus into the text, so each key
    // is pressed with the focus put back on the button.
    for (const [keys, want] of [["Control+z", coded], ["Control+y", plain], ["Meta+z", coded], ["Meta+Shift+z", plain], ["Control+z", coded], ["Control+Shift+z", plain]]) {
      await btn.focus();
      await expect(btn).toBeFocused();
      await page.keyboard.press(keys);
      expect(await getDesc(page), `${keys} from the button`).toBe(want);
    }
    expect(await menuUndo(page), "the browser's own Undo takes the step").toBe(true);
    expect(await getDesc(page)).toBe(coded);
    expect(await menuRedo(page), "the browser's own Redo puts it back").toBe(true);
    expect(await getDesc(page)).toBe(plain);
    // Code Block pressed with Enter, then undone from its button.
    await setDesc(page, "<p>Delta</p>");
    await selectIn(page, "Delta", 0, 5);
    const block = toolbar(page).locator("button[aria-label='Code Block']");
    await block.focus();
    await page.keyboard.press("Enter");
    expect(await getDesc(page)).toContain("<pre><code>Delta</code></pre>");
    await block.focus();
    await page.keyboard.press("Control+z");
    expect(await getDesc(page), "Ctrl+Z from the Code Block button").toBe("<p>Delta</p>");
    // CONTROL: Bold by keyboard is execCommand, the browser's own step.
    await setDesc(page, "<p>Alpha Bravo</p>");
    await selectIn(page, "Bravo", 0, 5);
    await toolbar(page).locator("button[aria-label='Bold']").focus();
    await page.keyboard.press("Enter");
    expect(await getDesc(page)).toBe("<p>Alpha <b>Bravo</b></p>");
    expect(await menuUndo(page), "Bold is not a step of the editor's own").toBe(false);
  });

  test("Insert Link pressed with Enter opens its dialog, and the link it makes undoes; the Table menu works from the keyboard", async ({ page }) => {
    await F.openEditor(page);
    await setDesc(page, "<p>see docs here</p>");
    await selectIn(page, "docs", 0, 4);
    await toolbar(page).locator("button[aria-label='Insert Link']").focus();
    await page.keyboard.press("Enter");
    // The dialog's Enter is its own: the button's Enter must not submit the prefilled https://.
    await expect(page.locator("#link-dlg-url"), "the dialog stays open for the address").toBeVisible();
    expect(await getDesc(page), "nothing is inserted before the address is given").toBe("<p>see docs here</p>");
    await page.locator("#link-dlg-url").fill("https://example.com/k");
    await page.keyboard.press("Enter");
    await expect(page.locator("#link-dlg-url")).toHaveCount(0);
    expect(await getDesc(page)).toBe('<p>see <a href="https://example.com/k" target="_blank" rel="noopener noreferrer">docs</a> here</p>');
    await undo(page);
    expect(await getDesc(page)).toBe("<p>see docs here</p>");
    // The Table menu by keyboard.
    await setDesc(page, TABLE);
    await caretIn(page, "1", 0);
    await toolbar(page).locator("button[aria-label='Table']").focus();
    await page.keyboard.press("Enter");
    const menu = toolbar(page).locator(".drop-pop");
    await expect(menu.locator("[role='menuitem']").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator("[role='menuitem']").nth(2)).toHaveText("Insert row below");
    await expect(menu.locator("[role='menuitem']").nth(2)).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await counts(page)).toEqual({ rows: 3, headCells: 2, bodyCells: 4 });
    await undo(page);
    expect(await getDesc(page)).toBe(TABLE);
  });

  test("Ctrl+Z inside an open toolbar menu leaves the editor's step, the browser's history and the menu's selection alone", async ({ page }) => {
    await F.openEditor(page);
    await setDesc(page, TABLE);
    await caretIn(page, "end", 3);
    await page.keyboard.type("!");
    expect((await browserHistory(page))[0], "PRECONDITION: the browser has a step of its own (the typing)").toBe(true);
    await caretIn(page, "1", 0);
    await openTableItem(page, "Insert row below");
    const rowAdded = await getDesc(page);
    expect(rowAdded).toContain("<p>end!</p>");
    expect(await counts(page)).toEqual({ rows: 3, headCells: 2, bodyCells: 4 });
    await caretIn(page, "1", 0);
    await press(page, "Table");
    const menu = toolbar(page).locator(".drop-pop");
    await expect(menu.locator("[role='menuitem']").first()).toBeFocused();
    await page.keyboard.press("Control+z");
    expect(await getDesc(page), "neither the editor's step nor the typing was taken back").toBe(rowAdded);
    await expect(menu, "the menu is still open").toHaveCount(1);
    // The menu's item still acts on the cell it was opened in.
    await menu.locator("[role='menuitem']").filter({ hasText: /^Insert column right$/ }).click();
    expect(await counts(page)).toEqual({ rows: 3, headCells: 3, bodyCells: 6 });
    await undo(page);
    expect(await getDesc(page), "the column first").toBe(rowAdded);
    await undo(page);
    expect(await getDesc(page), "then the row").toBe(TABLE.replace("<p>end</p>", "<p>end!</p>"));
    await undo(page);
    expect(await getDesc(page), "then the browser's own step, the typing").toBe(TABLE);
  });
});

// ── 4. The steps and the browser's history together ────────────────────────
test.describe("The editor's steps and the browser's history together", () => {
  test("loading another text forgets every step; changes and colour picks share one stack; a new change clears redo; typing after a change ends its step", async ({ page }) => {
    await F.openEditor(page);
    // (E) Loading another text (opening another challenge) forgets every step.
    await setDesc(page, "<p>Alpha Bravo Charlie</p>");
    await selectIn(page, "Bravo", 0, 5);
    await press(page, "Inline Code");
    expect(await getDesc(page)).toBe("<p>Alpha <code>Bravo</code> Charlie</p>");
    await setDesc(page, "<p>new</p>");
    expect(await menuUndo(page), "no step outlives the text it was made in").toBe(false);
    await undo(page);
    expect(await getDesc(page)).toBe("<p>new</p>");
    // (C) One stack: a colour, Inline Code, then another colour come off the last first.
    const pick = async (name) => {
      const bar = toolbar(page);
      if (await bar.locator(".rt-more-btn").getAttribute("aria-expanded") !== "true") await bar.locator(".rt-more-btn").click();
      await bar.locator("button[aria-label='Text Color']").click();
      await bar.locator(`.color-pop [data-rt-swatch="${name}"]`).click();
      await expect(bar.locator(".color-pop")).toHaveCount(0);
    };
    await setDesc(page, "<p>Alpha Bravo Charlie</p>");
    await selectIn(page, "Charlie", 0, 7);
    await pick("red");
    await selectIn(page, "Alpha", 0, 5);
    await press(page, "Inline Code");
    await selectIn(page, "Bravo", 0, 5);
    await pick("blue");
    const red = '<span style="color: var(--rt-red);">Charlie</span>';
    expect(await getDesc(page)).toBe(`<p><code>Alpha</code> <span style="color: var(--rt-blue);">Bravo</span> ${red}</p>`);
    await undo(page);
    expect(await getDesc(page), "the last colour first").toBe(`<p><code>Alpha</code> Bravo ${red}</p>`);
    await undo(page);
    expect(await getDesc(page), "then the code").toBe(`<p>Alpha Bravo ${red}</p>`);
    await undo(page);
    expect(await getDesc(page), "then the first colour").toBe("<p>Alpha Bravo Charlie</p>");
    // (D) A new change after an undo leaves nothing to redo.
    await setDesc(page, "<p>Alpha Bravo</p><p>Delta</p>");
    await selectIn(page, "Alpha", 0, 5);
    await press(page, "Inline Code");
    await undo(page);
    await selectIn(page, "Delta", 0, 5);
    await press(page, "Code Block");
    const blocked = await getDesc(page);
    expect(blocked).toContain("<pre><code>Delta</code></pre>");
    await redo(page);
    expect(await getDesc(page), "the undone code does not come back over the new change").toBe(blocked);
    // (B) Typing after a change ends its step: Ctrl+Z takes back the typing only.
    await setDesc(page, "<p>Alpha Bravo Charlie</p>");
    await selectIn(page, "Bravo", 0, 5);
    await press(page, "Inline Code");
    await caretIn(page, "Charlie", 7);
    await page.keyboard.type("!");
    expect(await getDesc(page)).toBe("<p>Alpha <code>Bravo</code> Charlie!</p>");
    expect(await menuUndo(page), "the typing ended the step").toBe(false);
    await undo(page);
    expect(await getDesc(page), "only the typing goes; the code stays").toBe("<p>Alpha <code>Bravo</code> Charlie</p>");
  });
});

// ── 5. Source: every operation is decided ───────────────────────────────────
// Each operation the toolbar offers is decided here as the BROWSER's step (an
// execCommand, on its own history) or the EDITOR's own (a function that runs its
// DOM work through _rtEdit or _rtStep); a new one is unclassified until decided.
// This proves a function routes through a step somewhere, not that every branch of it
// does: a partially wrapped function passes, and the behavioural arms above hold the
// branches (Inline Code's wrap and unwrap, insertLink's three branches, each table item).
const RT = () => stripJsComments(fs.readFileSync(pathMod.join(__dirname, "..", "public", "js", "ui", "richtext.js"), "utf8"));
// Skip a quoted string or a template literal (with `${…}` nested) from index j.
function skipQuoted(src, j) {
  const q = src[j];
  j++;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") { j += 2; continue; }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") { j = balanced(src, j + 1).end + 1; continue; }
    j++;
  }
  return j + 1;
}
// From the opening bracket at index i, the text up to its matching close and the
// top-level comma-separated parts inside.
function balanced(src, i) {
  const parts = [];
  let depth = 0, start = i + 1, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === "`") { j = skipQuoted(src, j); continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) { parts.push(src.slice(start, j).trim()); return { end: j, parts }; } }
    else if (c === "," && depth === 1) { parts.push(src.slice(start, j).trim()); start = j + 1; }
    j++;
  }
  throw new Error(`unbalanced from ${i}`);
}
// A top-level function's body (this file closes each one at column 0).
function fnBody(src, name) {
  const m = new RegExp(`\\nexport (?:async )?function ${name}\\(|\\n(?:async )?function ${name}\\(`).exec(src);
  if (!m) return null;
  const end = src.indexOf("\n}", m.index + 1);
  return end < 0 ? null : src.slice(m.index, end + 2);
}
const STEP = /\b_rtEdit\(|\b_rtStep\(/;
/** Every operation the source offers: [key, the code its press runs]. */
function enumerateOps(src) {
  const ops = [];
  for (const m of src.matchAll(/(?<![\w.])tb\(/g)) {
    const { parts } = balanced(src, m.index + 2);
    const title = /^'([^']+)'$/.exec(parts[1] || "");
    if (title && parts.length === 3) ops.push([`toolbar:${title[1]}`, parts[2]]);
  }
  const table = fnBody(src, "toggleTablePop") || "";
  for (const m of table.matchAll(/\['([^']+)',\s*((?:async\s*)?\(\)=>\{[^{}]*\})\]/g)) ops.push([`table:${m[1]}`, m[2]]);
  const drop = fnBody(src, "toggleDropPop") || "";
  const dropActs = [...drop.matchAll(/activate=\(\)=>\{[^{}]*\};/g)].map((m) => m[0]);
  dropActs.forEach((a, i) => ops.push([`font menu:${["font", "size"][i] || i}`, a]));
  const colour = fnBody(src, "toggleColorPop") || "";
  const run = /const run=name=>\{/.exec(colour);
  if (run) ops.push(["colour menu:swatch", colour.slice(run.index, balanced(colour, run.index + run[0].length - 1).end + 1)]);
  const lang = fnBody(src, "showCodeLangMenu") || "";
  const act = /const activate=\(\)=>\{/.exec(lang);
  if (act) ops.push(["code language:pick", lang.slice(act.index, balanced(lang, act.index + act[0].length - 1).end + 1)]);
  return ops;
}
const MENUS = new Set(["toggleColorPop", "toggleDropPop", "toggleTablePop"]);
/** Why `code` (an operation's press) is the class `cls`, or the reason it is not. */
function judge(src, code, cls) {
  const callsFn = (fn) => new RegExp(`\\b${fn}\\(`).test(code);
  if (cls === "browser") return /document\.execCommand\(/.test(code) && !STEP.test(code) ? null : "not an execCommand of its own";
  if (cls === "menu") return [...MENUS].some(callsFn) ? null : "opens no enumerated menu";
  if (cls === "editor") return STEP.test(code) ? null : "runs no _rtEdit/_rtStep itself";
  const m = /^(browser|editor):(\w+)$/.exec(cls);
  if (!m) return `unknown class ${cls}`;
  if (!callsFn(m[2])) return `does not call ${m[2]}`;
  const body = fnBody(src, m[2]);
  if (!body) return `no function ${m[2]}`;
  if (m[1] === "editor") return STEP.test(body) ? null : `${m[2]} runs no _rtEdit/_rtStep`;
  return /document\.execCommand\(/.test(body) && !STEP.test(body) ? null : `${m[2]} is not an execCommand of its own`;
}
const RT_OPS = {
  "toolbar:Bold": "browser",
  "toolbar:Italic": "browser",
  "toolbar:Underline": "browser",
  "toolbar:Strikethrough": "browser",
  "toolbar:Text Color": "menu",
  "toolbar:Highlight": "menu",
  "toolbar:Font": "menu",
  "toolbar:Font Size": "menu",
  "toolbar:Clear Formatting": "browser",
  "toolbar:Numbered List": "browser",
  "toolbar:Bullet List": "browser",
  "toolbar:Insert Link": "editor:insertLink",
  "toolbar:Inline Code": "editor:toggleInlineCode",
  "toolbar:Code Block": "editor:toggleCodeBlock",
  "toolbar:Table": "menu",
  "table:Insert table…": "browser:insertTable",
  "table:Insert row above": "editor:tableInsertRow",
  "table:Insert row below": "editor:tableInsertRow",
  "table:Insert column left": "editor:tableInsertColumn",
  "table:Insert column right": "editor:tableInsertColumn",
  "table:Delete row": "editor:tableDeleteRow",
  "table:Delete column": "editor:tableDeleteColumn",
  "table:Delete table": "editor:tableDelete",
  "font menu:font": "browser",
  "font menu:size": "browser",
  "colour menu:swatch": "editor:applyRichColour",
  "code language:pick": "editor",
};
function unclassified(src) {
  const ops = enumerateOps(src);
  const bad = [];
  for (const [key, code] of ops) {
    if (!(key in RT_OPS)) { bad.push(`${key}: not decided in RT_OPS`); continue; }
    const why = judge(src, code, RT_OPS[key]);
    if (why) bad.push(`${key} (${RT_OPS[key]}): ${why}`);
  }
  const seen = new Set(ops.map(([k]) => k));
  for (const k of Object.keys(RT_OPS)) if (!seen.has(k)) bad.push(`${k}: listed in RT_OPS but not in the source`);
  return { ops, bad };
}

test.describe("Every editor operation is decided as the browser's step or the editor's own", () => {
  test("source: every toolbar command, Table menu item, font menu item, colour swatch and code-language pick is classified (RT_OPS)", () => {
    const src = RT();
    const { ops, bad } = unclassified(src);
    expect(ops.filter(([k]) => k.startsWith("toolbar:")).length, "anti-vacuity: the toolbar's commands were found").toBeGreaterThanOrEqual(14);
    expect(ops.filter(([k]) => k.startsWith("table:")).length, "anti-vacuity: the Table menu's items were found").toBeGreaterThanOrEqual(8);
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: a planted toolbar command is reported unclassified by the same enumerator.
    const planted = src.replace("bar.appendChild(sep());", "bar.appendChild(tb(g('Q'),'Quote',()=>wrapQuote(body)));bar.appendChild(sep());");
    expect(planted, "PRECONDITION: the plant landed").not.toBe(src);
    expect(unclassified(planted).bad, "CONTROL: a new command without a decision is reported").toContain("toolbar:Quote: not decided in RT_OPS");
    // CONTROL: a table item whose function loses its step is reported.
    const unwrapped = src.replace(/(export function tableDeleteColumn\([\s\S]*?)_rtEdit\(/, "$1(");
    expect(unwrapped, "PRECONDITION: the plant landed").not.toBe(src);
    expect(unclassified(unwrapped).bad, "CONTROL: an editor operation that no longer runs a step is reported")
      .toContain("table:Delete column (editor:tableDeleteColumn): tableDeleteColumn runs no _rtEdit/_rtStep");
  });
});
