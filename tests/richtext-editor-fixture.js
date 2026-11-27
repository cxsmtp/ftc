// @ts-check
//
// The challenge editor's description field, driven the way an organiser drives it:
// shared by tests/richtext-undo.spec.js. tests/richtext-colours.spec.js keeps its own
// copies (it also sets a look and mode before the page loads).
//
// This module must NOT require ./isolated-test: that module registers the per-file
// server recycle at import time, and a helper that imported it would register a
// second one for whichever spec loaded it (the ui-admin-helpers.js rule). It needs
// only `expect` and ./helpers.
"use strict";

const { expect } = require("@playwright/test");
const { getSuperadminPass, waitForAdminPage } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const BODY = "#tf-desc .rich-body";

/** Sign the built-in superadmin in, then open a new challenge's form; returns a CSRF token. */
async function openEditor(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await waitForAdminPage(page, 30000);
  await page.locator("button[data-tab-id='admin-tasks-tab']").click();
  await page.locator("#new-task-btn, [data-action='open-task-form']").first().click();
  await page.locator(BODY).waitFor({ state: "visible", timeout: 15000 });
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

const setDesc = (page, html) => page.evaluate((h) => window.descEditor.setHtml(h), html);
const getDesc = (page) => page.evaluate(() => window.descEditor.getHtml());

/** Select `len` characters from `at` in the first text node of the description holding `text` (or a bare caret). */
const selectIn = (page, text, at, len) => page.evaluate(([text, at, len, sel]) => {
  const body = document.querySelector(sel);
  body.focus();
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let t; while ((t = w.nextNode()) && !t.data.includes(text));
  if (!t) throw new Error(`no text node holds ${text}`);
  const i = t.data.indexOf(text) + at;
  const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + len);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}, [text, at, len, BODY]);
/** A bare caret `offset` characters into the first text holding `text`. */
const caretIn = (page, text, offset) => selectIn(page, text, offset, 0);
const selected = (page) => page.evaluate(() => getSelection().toString());

const undo = (page, keys = "Control+z") => page.keyboard.press(keys);
const redo = (page, keys = "Control+Shift+z") => page.keyboard.press(keys);
// The browser's own Undo and Redo (its Edit and context menus) arrive as a
// beforeinput; true when the editor took it for a step of its own.
const menuInput = (page, inputType) => page.evaluate(([t, sel]) => {
  const e = new InputEvent("beforeinput", { inputType: t, bubbles: true, cancelable: true });
  document.querySelector(sel).dispatchEvent(e);
  return e.defaultPrevented;
}, [inputType, BODY]);
const menuUndo = (page) => menuInput(page, "historyUndo");
const menuRedo = (page) => menuInput(page, "historyRedo");
// Whether the browser has an Undo and a Redo of its own ([undo, redo]).
const browserHistory = (page) => page.evaluate(() => [document.queryCommandEnabled("undo"), document.queryCommandEnabled("redo")]);
// One task later: the editor's code-marking observer (a microtask) has had its turn.
const tick = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 0)));

const toolbar = (page) => page.locator("#tf-desc .rich-toolbar");
/** Press a toolbar button with the pointer, as an organiser clicks it. */
const press = (page, label) => toolbar(page).locator(`button[aria-label='${label}']`).click();
/** Open the Table menu and press one of its items. */
async function openTableItem(page, label) {
  await press(page, "Table");
  const item = toolbar(page).locator(".drop-pop [role='menuitem']").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
  await expect(item).toHaveCount(1);
  await item.click();
  await expect(toolbar(page).locator(".drop-pop")).toHaveCount(0);
}

module.exports = { BODY, openEditor, setDesc, getDesc, selectIn, caretIn, selected, undo, redo, menuUndo, menuRedo,
  browserHistory, tick, toolbar, press, openTableItem };
