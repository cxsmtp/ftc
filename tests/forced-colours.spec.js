// @ts-check
//
// FORCED COLOURS (Windows High Contrast): A DRAWN CHECKBOX STILL SAYS "CHECKED".
//
// Two controls reset their native chrome (appearance:none) and draw their
// checked state with a fill, an ink and a shadow: the participant's answer key
// on the standard challenge card, and the challenge editor's switch (Seal the
// answer). Forced colours replace exactly those, so a picked answer and an
// unpicked one looked the same before a submit that costs points. In forced
// colours both are now drawn in the system's own selection colours.
//
// The witness is the colour the page computes for the checked control under
// forced colours, beside the system's Highlight read from a probe element, and
// beside the unchecked control's (they must differ). Controls: the same reads
// with forced colours off show the look's own accent, not Highlight, so the
// forced-colours branch is what draws them.
//
// Both are RECORDED EXCEPTIONS to the rule that a checkbox or radio resets its
// chrome with `appearance:revert`, never `none` (operator ruling, 14 Nov 2026).
// A source arm holds the record: every `appearance:none` in the stylesheet is one
// of the two, and each keeps a forced-colours branch for its checked state.
const { test, expect } = require("./isolated-test");
const { H, uniq, sa, SHORT, participantIn, signInTo, openChallenge } = require("./booth-choice-tap-fixture");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { BASE } = require("./helpers");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

let fx;
test.beforeAll(async () => {
  const { api, csrf } = await sa();
  try {
    // A LIVE tournament (the standard card, not the Booth tap layout) holding
    // one multiple-choice challenge; nobody answers, and an idle second
    // participant keeps it from ending (fixture checklist item 1).
    const create = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Forced colours ${uniq()}`, event_kind: "tournament", timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600 } });
    expect(create.ok(), `create event: ${await create.text()}`).toBeTruthy();
    const comp = (await create.json()).competition;
    const r = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `Which transport encrypts the session? ${uniq()}`, description: "<p>Pick one.</p>", difficulty: "easy",
      status: "published", answer_type: "choice", choices: SHORT } });
    expect(r.ok(), `create challenge: ${await r.text()}`).toBeTruthy();
    const bankId = (await r.json()).id;
    const a = await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    const ab = await a.json();
    expect(ab.assigned, "the challenge is really assigned").toBe(1);
    const taskId = ab.copies[0].task_id;   // the event's own copy (lib/event-copies.js): what its participants open and answer
    const p = await participantIn(api, csrf, comp.id, `fc${uniq()}`);
    await participantIn(api, csrf, comp.id, `fcidle${uniq()}`);
    fx = { comp, taskId, p };
  } finally { await api.dispose(); }
});

/** The computed background of `sel`'s checked and unchecked members, and the system Highlight. */
function keyColours(page, checkedSel, uncheckedSel) {
  return page.evaluate(([c, u]) => {
    const probe = document.createElement("span");
    probe.style.background = "Highlight";
    document.body.appendChild(probe);
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const bg = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; };
    return { checked: bg(c), unchecked: u ? bg(u) : null, highlight, forced: matchMedia("(forced-colors: active)").matches };
  }, [checkedSel, uncheckedSel]);
}

test("the participant's picked answer key is drawn in the system's selection colour (forced colours), distinct from the rest", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInTo(page, fx.p.email, fx.comp.id);
  await openChallenge(page, fx.taskId);
  const card = page.locator("#task-detail-card.qa-card");
  await expect(card, "PRECONDITION: the standard card (qa-card), not the tap layout").toBeVisible();
  const options = card.locator(".choice-option");
  await expect(options).toHaveCount(SHORT.length);
  await options.nth(0).click();
  await expect(options.nth(0).locator("input")).toBeChecked();
  await expect(options.nth(1).locator("input")).not.toBeChecked();
  const sel = ["#task-detail-card.qa-card .choice-option input:checked", "#task-detail-card.qa-card .choice-option input:not(:checked)"];

  const normal = await keyColours(page, ...sel);
  expect(normal.forced, "PRECONDITION: forced colours are off").toBe(false);
  expect(normal.checked, `CONTROL: off, the picked key is the look's accent, not the system colour: ${JSON.stringify(normal)}`).not.toBe(normal.highlight);

  await page.emulateMedia({ forcedColors: "active" });
  // Polled: every input carries `transition: all`, so a read straight after the
  // switch sees the colour mid-transition.
  let forced = null;
  await expect.poll(async () => { forced = await keyColours(page, ...sel); return forced.forced && forced.checked === forced.highlight; },
    { message: "the picked key is drawn in Highlight under forced colours", timeout: 5000 }).toBe(true);
  expect(forced.checked, `and differs from an unpicked key: ${JSON.stringify(forced)}`).not.toBe(forced.unchecked);
  const edge = await options.nth(0).evaluate((l) => [getComputedStyle(l).borderTopWidth, getComputedStyle(l).borderTopColor]);
  const plain = await options.nth(1).evaluate((l) => [getComputedStyle(l).borderTopWidth, getComputedStyle(l).borderTopColor]);
  expect(edge, `the picked row's edge is heavier than an unpicked row's: ${JSON.stringify({ edge, plain })}`).not.toEqual(plain);
  await page.emulateMedia({ forcedColors: "none" });
});

test("the editor's Seal switch, on, is drawn in the system's selection colour (forced colours)", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await clickTab(page, "challenges");
  await page.locator("[data-action='open-task-form']").first().click();
  const sw = page.locator("#tf-answer-seal");
  await expect(sw, "PRECONDITION: a new challenge offers the seal switch").toBeVisible({ timeout: 10000 });
  await expect(sw).toBeEnabled();
  await expect(sw).not.toBeChecked();
  const off = await keyColours(page, "#admin-task-form .ce-switch input[type=checkbox]:not(:checked)", null);
  await sw.check();
  await expect(sw).toBeChecked();
  const normal = await keyColours(page, "#admin-task-form .ce-switch input[type=checkbox]:checked", null);
  expect(normal.checked, `CONTROL: off, the switch is the look's accent, not the system colour: ${JSON.stringify(normal)}`).not.toBe(normal.highlight);
  await page.emulateMedia({ forcedColors: "active" });
  // Polled past the switch's own background transition.
  let forced = null;
  await expect.poll(async () => { forced = await keyColours(page, "#admin-task-form .ce-switch input[type=checkbox]:checked", null); return forced.forced && forced.checked === forced.highlight; },
    { message: "the switch, on, is drawn in Highlight under forced colours", timeout: 5000 }).toBe(true);
  await sw.uncheck();
  await expect.poll(async () => (await keyColours(page, "#admin-task-form .ce-switch input[type=checkbox]:not(:checked)", null)).checked,
    { message: `and off it is not (${JSON.stringify(off)})`, timeout: 5000 }).not.toBe(forced.highlight);
  await page.emulateMedia({ forcedColors: "none" });
});


// ── THE RECORD: appearance:none only where it was decided ────────────────────
const APPEARANCE_NONE_EXCEPTIONS = [
  { selector: "#task-detail-card.qa-card .choice-option input",
    forced: "#task-detail-card.qa-card .choice-option input:checked",
    why: "the participant's answer key, drawn as a lettered tile" },
  { selector: '#admin-task-form .ce-switch input[type="checkbox"]',
    forced: '#admin-task-form .ce-switch input[type="checkbox"]:checked',
    why: "the challenge editor's Seal switch" },
];

/** CSS with its comments removed; quoted strings are copied as they are. */
function stripCssComments(src) {
  let out = "";
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) break; i = e + 2; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += ch; i++;
  }
  return out;
}
const normSel = (s) => s.replace(/\s+/g, " ").trim();
/** Every innermost rule: its selectors and its declarations. */
const rulesOf = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].split(",").map(normSel), body: m[2] }));
/** The selectors of every appearance:none rule (the prefixed spelling too). */
const appearanceNoneSelectors = (css) => rulesOf(css)
  .filter(r => /(^|[;\s])(-webkit-)?appearance\s*:\s*none\b/i.test(" " + r.body))
  .flatMap(r => r.selectors);
/** The rules inside each `@media (forced-colors: active)` block. */
function forcedColourSelectors(css) {
  const out = [];
  const re = /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    for (const r of rulesOf(css.slice(re.lastIndex, i - 1))) out.push(...r.selectors);
  }
  return out;
}

test("SOURCE: appearance:none is only on the two recorded exceptions, each with a forced-colours branch", () => {
  const css = stripCssComments(fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8"));
  // Planted controls: a new rule is found; one quoted inside a comment is not.
  const planted = appearanceNoneSelectors(stripCssComments(".zz-new input{margin:0;appearance:none}\n/* .zz-quoted input{appearance:none} */"));
  expect(planted, "CONTROL: the scanner finds a new appearance:none, and not one quoted in a comment").toEqual([".zz-new input"]);
  expect(appearanceNoneSelectors(css).sort(), "every appearance:none in the stylesheet is a recorded exception")
    .toEqual(APPEARANCE_NONE_EXCEPTIONS.map(e => normSel(e.selector)).sort());
  const forced = forcedColourSelectors(css);
  expect(forced.length, "PRECONDITION: the forced-colours blocks were read").toBeGreaterThan(0);
  for (const e of APPEARANCE_NONE_EXCEPTIONS) {
    expect(forced, `${e.why}: a forced-colours branch draws its checked state`).toContain(normSel(e.forced));
  }
});
