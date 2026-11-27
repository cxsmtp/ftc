// @ts-check
//
// THE LOOKS' TOKENS ARE GENERATED, MEASURED AND APPLIED.
//
// public/styles.css carries a generated block (two looks, day and night, six
// ambient light colours) written by scripts/build-theme-tokens.js from
// scripts/theme/looks.js. A hand edit there is invisible in review and drifts
// from the data every contrast check measures, so:
//   1. the committed block equals what the generator builds from the data now;
//   2. the generator's own WCAG pass finds no pair below AA (and measures many);
//   3. in a real page each look really paints its own canvas, an [data-stage] element is
//      the look's night mode on a day page, and a legacy name (--surface2)
//      resolves to the look's --surface-2 — with an unknown stored look falling
//      back to the house default;
//   4. the brand violet pair (late entry, the shared pool, "you compete here")
//      never takes the ambient accent, so no colour choice makes late entry
//      read as Upcoming or Live.
const { test, expect } = require("./isolated-test");
const { BASE, appearanceSettled } = require("./helpers");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

test("the generated look-token block in styles.css is exactly what the data builds", () => {
  const gen = require("../scripts/build-theme-tokens");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const i = css.indexOf(gen.BEGIN), j = css.indexOf(gen.END);
  expect(i, "the block's BEGIN marker").toBeGreaterThan(-1);
  expect(j, "the block's END marker follows it").toBeGreaterThan(i);
  expect(css.slice(i, j + gen.END.length), "run `npm run theme:tokens` — the block is stale or hand-edited").toBe(gen.build());
});

test("every look's text pairs clear WCAG AA (the generator's own measurement)", () => {
  const { measure } = require("../scripts/build-theme-tokens");
  const { fails, n } = measure();
  expect(n, "anti-vacuity: hundreds of pairs are measured").toBeGreaterThan(500);
  expect(fails, fails.join("\n")).toEqual([]);
});

test("the Pending fill, the hover well's link ink, the medals on your own row and a missing key are measured by the generator", () => {
  // Each plant fails ONE pair, so each new CHECKS row is proved measured: the
  // named failure is reported with the row, and the same plant passes without it.
  const gen = require("../scripts/build-theme-tokens");
  const real = gen.measure();
  expect(real.fails, real.fails.join("\n")).toEqual([]);
  const data = () => JSON.parse(JSON.stringify(require("../scripts/theme/looks")));
  const without = (a, b) => gen.CHECKS.filter(([x, y]) => !(x === a && y === b));
  const rowFor = (a, b) => gen.CHECKS.find(([x, y]) => x === a && y === b);
  for (const [a, b, need] of [["onWarn", "warnStrong", 4.5], ["accentInk", "surface3", 4.5], ["gold", "accentSoft", 3], ["silver", "accentSoft", 3], ["bronze", "accentSoft", 3]]) {
    expect(rowFor(a, b), `the generator measures ${a} on ${b}`).toEqual([a, b, need]);
  }
  // [what, plant, the failure it must name, the row it belongs to]
  const PLANTS = [
    ["a Pending label as light as its fill", (d) => { d.looks.signature.dark.onWarn = d.looks.signature.dark.warnStrong; }, "signature/dark: onWarn on warnStrong", ["onWarn", "warnStrong"]],
    // A hover well a little darker: Glacier's link ink falls under AA on it while
    // body, muted and every rich-text ink still clear it.
    ["a hover well Glacier's link cannot be read on", (d) => { d.looks.ambient.light.surface3 = "#d9dce0"; }, "ambient/light/cyan: accentInk on surface3", ["accentInk", "surface3"]],
    // By day no gold can fail 3:1 on the accent tint and pass 4.5:1 on the card
    // (the tint is never much darker than the card), so this plant fails both
    // rows; the tint row's failure is still its own (absent without the row).
    ["a gold as pale as the accent tint", (d) => { d.looks.signature.light.gold = "#c0b6d8"; }, "signature/light: gold on accentSoft = ", ["gold", "accentSoft"]],
  ];
  for (const [what, plant, named, [a, b]] of PLANTS) {
    const d = data(); plant(d);
    const fails = gen.measure(d).fails;
    expect(fails.join("\n"), `${what}: reported`).toContain(named);
    const rest = gen.measure(d, without(a, b)).fails;
    expect(rest.join("\n"), `${what}: the failure is the ${a}/${b} row's`).not.toContain(named);
    if (a !== "gold") expect(rest, `${what}: the plant fails that row alone`).toEqual([]);
  }
  // A key a look leaves out is a named failure, never a skipped pair: without it
  // --warn-strong is not emitted and the Pending chip would paint no fill.
  const d = data(); delete d.looks.signature.dark.warnStrong;
  expect(gen.measure(d).fails, "a missing key").toEqual(["signature/dark: warnStrong missing (needed for onWarn on warnStrong)"]);
  expect(gen.build(), "the generated block names the Pending pair").toMatch(/--warn-strong:#[0-9a-f]{6};--on-warn:#[0-9a-f]{6}/);
});

test("each look paints its own palette; the stage resolves dark; legacy names follow", async ({ page }) => {
  const { looks } = require("../scripts/theme/looks");
  const seen = new Set();
  for (const [id, look] of Object.entries(looks)) {
    for (const mode of ["light", "dark"]) {
      await page.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) {} }, [id, mode]);
      await page.goto("/");
      await page.locator("#login-page .auth-card").waitFor({ state: "visible", timeout: 20000 });
      const got = await page.evaluate(() => {
        // The one-card sign-in has no stage of its own, so plant one: any
        // [data-stage] element (the workspace presenter view is one) must
        // resolve the look's night canvas on a day page.
        const h = document.documentElement, cs = getComputedStyle(h);
        const stage = document.createElement("div"); stage.setAttribute("data-stage", ""); document.body.appendChild(stage);
        return {
          look: h.dataset.look, theme: h.dataset.theme,
          bg: cs.getPropertyValue("--bg").trim(), s2: cs.getPropertyValue("--surface-2").trim(),
          legacy: cs.getPropertyValue("--surface2").trim(),
          stageBg: getComputedStyle(stage).getPropertyValue("--bg").trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      });
      const want = mode;
      expect(got.look, `${id}/${mode}: html[data-look]`).toBe(id);
      expect(got.theme, `${id}/${mode}: html[data-theme]`).toBe(want);
      expect(got.bg.toLowerCase(), `${id}/${mode}: --bg is the look's ${want} canvas`).toBe(look[want].bg.toLowerCase());
      expect(got.legacy, `${id}/${mode}: --surface2 resolves to the look's --surface-2`).toBe(got.s2);
      expect(got.stageBg.toLowerCase(), `${id}/${mode}: a [data-stage] element is the look's night canvas`).toBe(look.dark.bg.toLowerCase());
      seen.add(got.bodyBg);
    }
  }
  expect(seen.size, "CONTROL: every look paints its own canvas by day and by night").toBe(Object.keys(looks).length * 2);
  // An unknown stored look is the house default, never a page with no palette.
  await page.addInitScript(() => { try { localStorage.setItem("hck-look", "nonsense"); localStorage.setItem("hck-theme", "light"); } catch (_) {} });
  await page.goto("/");
  await page.locator("#login-page").waitFor({ state: "visible", timeout: 20000 });
  expect(await page.evaluate(() => document.documentElement.dataset.look), "the house default is Ambient").toBe("ambient");
  expect((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim())).toLowerCase())
    .toBe(looks.ambient.light.bg.toLowerCase());
});

test("the Look & theme picker applies a look, a mode and an ambient colour, and keeps them", async ({ page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem("lp-seeded")) { localStorage.removeItem("hck-look"); localStorage.removeItem("hck-ambient"); localStorage.setItem("hck-theme", "light"); sessionStorage.setItem("lp-seeded", "1"); } } catch (_) {} });
  await page.goto("/");
  await page.locator("#look-picker-btn").click();
  const dlg = page.locator("#look-picker-overlay [role=dialog]");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.card-open[data-look-id="ambient"]'), "the house look (Ambient) starts pressed").toHaveAttribute("aria-pressed", "true");
  await dlg.locator('.card-open[data-look-id="signature"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-look", "signature");
  await expect(dlg.locator('.card-open[data-look-id="signature"]'), "Signature stays selectable").toHaveAttribute("aria-pressed", "true");
  await dlg.locator('.card-open[data-look-id="ambient"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-look", "ambient");
  await expect(dlg.locator('.card-open[data-look-id="ambient"]'), "the pressed state follows, and focus stays on it").toBeFocused();
  await dlg.locator('[data-action="look-picker-ambient"][data-ambient-id="rose"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-ambient", "rose");
  await dlg.locator('[data-action="look-picker-mode"][data-mode="dark"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent-ink").trim());
  const { ambients } = require("../scripts/theme/looks");
  expect(accent.toLowerCase(), "the rose ambient's night accent ink is in force").toBe(ambients.rose.dark.accentInk.toLowerCase());
  await page.keyboard.press("Escape");
  await expect(page.locator("#look-picker-overlay")).toHaveCount(0);
  await expect(page.locator("#look-picker-btn"), "focus returns to the opener").toBeFocused();
  // Kept across a reload, before first paint.
  await page.reload();
  expect(await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.ambient, localStorage.getItem("hck-theme")]))
    .toEqual(["ambient", "rose", "dark"]);
});

test("A0: each look's own night character wins, and every look draws one type family", async ({ page }) => {
  // The Signature night block once keyed on a bare :root[data-theme="dark"]
  // (0,2,0), which out-ranked every other look's (0,1,0) character block: at
  // night Ambient painted Signature's violet motif ink. Only a page with NO
  // look is Signature now.
  const got = {};
  for (const id of ["signature", "ambient"]) {
    await page.addInitScript((l) => { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", "dark"); }, id);
    await page.goto("/");
    await page.locator("#login-page").waitFor({ state: "visible", timeout: 20000 });
    got[id] = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { look: document.documentElement.dataset.look, theme: document.documentElement.dataset.theme,
        ink: cs.getPropertyValue("--motif-ink").trim(),
        text: cs.getPropertyValue("--font-text").trim(), display: cs.getPropertyValue("--font-display").trim(),
        body: getComputedStyle(document.body).fontFamily, legacy: cs.getPropertyValue("--font-body").trim() };
    });
    expect([got[id].look, got[id].theme], `${id}: the look is applied at night`).toEqual([id, "dark"]);
  }
  expect(got.signature.ink, "CONTROL: Signature's night ink").toBe("rgb(173 150 255 / .075)");
  // Chromium substitutes var() in a computed custom property: the glow-tinted
  // inks come back as the default ambient's triplet at their own alpha.
  const { ambients } = require("../scripts/theme/looks");
  expect(got.ambient.ink, "Ambient keeps its own (glow-tinted) motif ink at night").toBe(`rgb(${ambients.ice.dark.glow} / .16)`);
  for (const [id, g] of Object.entries(got)) {
    expect(g.text, `${id}: one text family`).toBe(got.signature.text);
    expect(g.display, `${id}: one display family`).toBe(got.signature.display);
    expect(g.body.replace(/\s/g, ""), `${id}: the page body draws Inter Text`).toMatch(/^"?InterText"?,/);
    expect(g.legacy, `${id}: the legacy --font-body resolves to --font-text`).toBe(g.text);
  }
  expect(got.signature.text, "Inter Text opens the stack, with no Aptos left").toMatch(/^"?Inter Text"?,/);
  expect(got.signature.text, "no Aptos in the stack").not.toContain("Aptos");
});

test("the look ids, ambient colours and house defaults agree wherever they are listed", () => {
  // One list in the data (scripts/theme/looks.js) and five hand-kept copies: the
  // server's validation (lib/platform-look.js), the classic boot script and the
  // ES module (they cannot share code), the generator's default colour and the
  // API description. A look added to one and not another is offered but
  // refused, or painted but never offered.
  const fs = require("fs");
  const path = require("path");
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const { looks, ambients } = require("../scripts/theme/looks");
  const ids = Object.keys(looks).sort(), amb = Object.keys(ambients).sort();
  expect(ids.length, "anti-vacuity: the data names looks").toBeGreaterThan(1);
  expect(amb.length, "anti-vacuity: the data names ambient colours").toBeGreaterThan(1);
  const platform = read("lib/platform-look.js");
  const arr = (src, name) => JSON.parse(src.match(new RegExp(`const ${name} = Object\\.freeze\\((\\[[^\\]]*\\])\\)`))[1]).sort();
  expect(arr(platform, "LOOK_IDS"), "lib/platform-look.js LOOK_IDS").toEqual(ids);
  expect(arr(platform, "AMBIENT_IDS"), "lib/platform-look.js AMBIENT_IDS").toEqual(amb);
  const boot = read("public/theme-boot.js");
  const keys = (src, name) => [...src.match(new RegExp(`var ${name} = \\{([^}]*)\\}`))[1].matchAll(/([a-z]+):/g)].map((m) => m[1]).sort();
  expect(keys(boot, "LOOKS"), "public/theme-boot.js LOOKS").toEqual(ids);
  expect(keys(boot, "AMBIENTS"), "public/theme-boot.js AMBIENTS").toEqual(amb);
  const mod = read("public/js/ui/theme.js");
  const listIds = (src, name) => { const a = src.indexOf(`export const ${name} = [`); return [...src.slice(a, src.indexOf("];", a)).matchAll(/\bid: "([a-z]+)"/g)].map((m) => m[1]).sort(); };
  expect(listIds(mod, "LOOKS"), "public/js/ui/theme.js LOOKS").toEqual(ids);
  expect(listIds(mod, "AMBIENTS"), "public/js/ui/theme.js AMBIENTS").toEqual(amb);
  // The default colour of each ambient-lit look, three copies.
  const obj = (src, re) => JSON.parse(src.match(re)[1].replace(/([a-z]+):/g, '"$1":'));
  const want = obj(read("scripts/build-theme-tokens.js"), /const DEFAULT_AMBIENT = (\{[^}]*\});/);
  expect(Object.keys(want).sort(), "the generator lights every ambient-lit look").toEqual(ids.filter((id) => looks[id].ambient).sort());
  expect(obj(boot, /var DEFAULT_AMBIENT = (\{[^}]*\});/), "public/theme-boot.js DEFAULT_AMBIENT").toEqual(want);
  expect(obj(mod, /export const DEFAULT_AMBIENT = (\{[^}]*\});/), "public/js/ui/theme.js DEFAULT_AMBIENT").toEqual(want);
  // The house default: what a browser paints when nobody chose.
  const house = boot.match(/var HOUSE_LOOK = "([a-z]+)", HOUSE_MODE = "([a-z]+)";/);
  expect(house, "theme-boot.js names the house look and mode").toBeTruthy();
  expect([mod.match(/export const HOUSE_LOOK = "([a-z]+)";/)[1], mod.match(/export const HOUSE_MODE = "([a-z]+)";/)[1]], "ui/theme.js HOUSE_LOOK / HOUSE_MODE").toEqual([house[1], house[2]]);
  expect(ids, "the house look is a look").toContain(house[1]);
  // Every look and ambient enum in the API description.
  const sw = read("swagger.yaml");
  const enums = (key) => [...sw.matchAll(new RegExp(`\\b${key}: \\{ type: string,[^}\\n]*?enum: \\[([^\\]]*)\\]`, "g"))]
    .map((m) => m[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter((s) => s && s !== "null").sort());
  const lookEnums = [...enums("look"), ...enums("default_look")];
  expect(lookEnums.length, "anti-vacuity: swagger's look enums were found").toBeGreaterThanOrEqual(6);
  for (const e of lookEnums) expect(e, "a swagger look enum").toEqual(ids);
  const ambEnums = enums("ambient");
  expect(ambEnums.length, "anti-vacuity: swagger's ambient enums were found").toBeGreaterThanOrEqual(2);
  for (const e of ambEnums) expect(e, "a swagger ambient enum").toEqual(amb);
});

// LATE ENTRY KEEPS ITS OWN HUE. The late-entry badges (and the shared-pool and
// "you compete here" chips, which share the pair) are the BRAND violet pair,
// fixed per look and mode. They took the ACCENT, and Ambient's accent is the
// viewer's ambient colour: with Amber, an ended event still taking late entries
// read as Upcoming's amber twin; with Emerald, as Live's green.
const _hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const _hueGap = (a, b) => { const d = Math.abs(_hue(a) - _hue(b)) % 360; return Math.min(d, 360 - d); };

test("the brand pair (late entry) is violet in every look, mode and ambient colour, far from Upcoming's and Live's hues", () => {
  const { lookCombos } = require("./look-tokens");
  const combos = lookCombos();
  expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
  const bad = [];
  for (const { label, tokens: t } of combos) {
    if (!t["--brand-ink"] || !t["--brand-soft"]) { bad.push(`${label}: no brand pair`); continue; }
    const h = _hue(t["--brand-ink"]);
    if (h < 240 || h > 290) bad.push(`${label}: brand ink ${t["--brand-ink"]} is not violet (hue ${h.toFixed(0)})`);
    if (_hueGap(t["--brand-ink"], t["--warn"]) < 90) bad.push(`${label}: late entry's ink is Upcoming's hue`);
    if (_hueGap(t["--brand-ink"], t["--ok"]) < 90) bad.push(`${label}: late entry's ink is Live's hue`);
    if (t["--badge-purple-fg"] !== t["--brand-ink"] || t["--purple-pill"] !== t["--brand-soft"]) bad.push(`${label}: the legacy purple names are not the brand pair`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
  // CONTROL: the ACCENT does collide where the bug was, so the pair is what
  // keeps the hues apart (a measure that could not see the collision would pass).
  const amber = combos.find((c) => c.label === "ambient/light/amber").tokens;
  const emerald = combos.find((c) => c.label === "ambient/light/emerald").tokens;
  expect(_hueGap(amber["--accent-ink"], amber["--warn"]), "CONTROL: Amber's accent is Upcoming's hue").toBeLessThan(30);
  expect(_hueGap(emerald["--accent-ink"], emerald["--ok"]), "CONTROL: Emerald's accent is Live's hue").toBeLessThan(30);
  // Every rule of a chip that keeps the pair's hue (late entry, the shared
  // pool, "you compete here") paints its fill and ink from the pair, never the
  // accent or anything else. Each chip must be found (anti-vacuity per chip).
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const PAIR_CHIPS = { "late entry": /late-entry/, "the shared pool": /\.shared-pool\b/, "you compete here": /\.status-badge\.competing\b/ };
  const PAIR = /^var\(--(brand-ink|brand-soft|badge-purple-fg|purple-pill)\)$/;
  for (const [chip, re] of Object.entries(PAIR_CHIPS)) {
    const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => re.test(m[1]) && !/header-late-entry|comp-form/.test(m[1]) && /(^|;)\s*(background(-color)?|color)\s*:/.test(m[2]));
    expect(rules.length, `anti-vacuity: the ${chip} chip's rules are found`).toBeGreaterThanOrEqual(chip === "late entry" ? 3 : 2);
    for (const [, sel, body] of rules) {
      for (const [, prop, val] of body.matchAll(/(?:^|;)\s*(background(?:-color)?|color)\s*:\s*([^;]+)/g)) {
        expect(val.trim(), `${sel.trim()} paints its ${prop} from the brand pair`).toMatch(PAIR);
      }
    }
  }
});

test("in a page lit Amber or Emerald, a late-entry badge (and the shared-pool and competing chips) is not Upcoming's or Live's twin", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login-page").waitFor({ state: "attached", timeout: 20000 });
  await appearanceSettled(page);   // the app's own look read is done repainting <html>
  const read = (look, theme, ambient) => page.evaluate(([l, t, a]) => {
    const html = document.documentElement;
    html.setAttribute("data-look", l); html.setAttribute("data-theme", t); html.setAttribute("data-ambient", a);
    const box = document.createElement("div");
    box.innerHTML = '<span class="badge comp-badge comp-late-entry">Late entry open</span><span class="badge comp-badge comp-upcoming">Upcoming</span>'
      + '<span class="badge comp-badge comp-live">Live</span><span class="status-badge late-entry">late</span><span class="ws-chip ws-chip-late-entry">late</span>'
      + '<span class="badge shared-pool">Shared</span><span class="status-badge competing">Competing</span>';
    document.body.appendChild(box);
    const c = (sel) => getComputedStyle(box.querySelector(sel)).color;
    const out = { late: c(".comp-late-entry"), upcoming: c(".comp-upcoming"), live: c(".comp-live"), status: c(".status-badge.late-entry"), chip: c(".ws-chip"),
      pool: c(".shared-pool"), competing: c(".status-badge.competing"),
      accentInk: getComputedStyle(html).getPropertyValue("--accent-ink").trim() };
    box.remove();
    return out;
  }, [look, theme, ambient]);
  const hex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("");
  for (const [theme, ambient] of [["light", "amber"], ["dark", "amber"], ["light", "emerald"], ["dark", "emerald"]]) {
    const r = await read("ambient", theme, ambient);
    const why = JSON.stringify({ theme, ambient, ...r });
    expect(_hueGap(r.accentInk, hex(r.upcoming)) < 30 || _hueGap(r.accentInk, hex(r.live)) < 30, `PRECONDITION: this accent is a status hue: ${why}`).toBe(true);
    for (const k of ["late", "status", "chip", "pool", "competing"]) {
      expect(_hueGap(hex(r[k]), hex(r.upcoming)), `${k} is not Upcoming's hue: ${why}`).toBeGreaterThanOrEqual(90);
      expect(_hueGap(hex(r[k]), hex(r.live)), `${k} is not Live's hue: ${why}`).toBeGreaterThanOrEqual(90);
    }
  }
});

// Flat Design 3.0's construction rules over one stylesheet: no backdrop-filter,
// no blur or drop-shadow filter, and every BLURRED shadow layer a soft-shadow
// tier token (`shadowTokenOk` says which custom-property names count in that
// sheet). A hand-written blurred layer is how inset key lighting (a bezel), a
// tinted glow or a heavy drop comes back; a FLAT layer (blur 0: a ring, an inset
// edge or bar) is construction, not lighting. Comments are blanked first,
// keeping lines, so a comment quoting a forbidden value trips nothing and the
// reported line numbers stay true. Returns each rule (with the selector that
// owns it: an at-rule's own prelude for keyframes) for the caller's own checks.
function flatDesignScan(raw, shadowTokenOk) {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const rules = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let at = 0, line = 1;   // a running line count: one pass, not a slice per rule
  for (let m; (m = re.exec(css));) {
    for (; at < m.index; at++) if (css.charCodeAt(at) === 10) line++;
    rules.push({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2], line });
  }
  const bad = [];
  let shadowLayers = 0;   // anti-vacuity: the shadow arm read box-shadows at all
  for (const r of rules) {
    if (/backdrop-filter\s*:/.test(r.body)) bad.push(`${r.line} ${r.sel}: backdrop-filter`);
    if (/(^|;)\s*filter\s*:[^;]*(drop-shadow|blur)\(/.test(r.body)) bad.push(`${r.line} ${r.sel}: a blur or drop-shadow filter`);
    for (const decl of r.body.match(/(?:^|;)\s*box-shadow\s*:[^;]*/g) || []) {
      const v = decl.replace(/^[;\s]*box-shadow\s*:/, "").replace(/!important/, "").trim();
      if (/^(none|0|initial|inherit|unset)$/.test(v)) continue;
      for (const layer0 of v.split(/,(?![^(]*\))/)) {
        const layer = layer0.trim();
        shadowLayers++;
        const tok = /^var\((--[\w-]+)\)$/.exec(layer);
        if (tok && shadowTokenOk(tok[1])) continue;
        if (/^var\(/.test(layer)) { bad.push(`${r.line} ${r.sel}: a shadow from a token that is not a soft-shadow tier (${layer})`); continue; }
        const n = layer.replace(/\binset\b/, " ").replace(/rgba?\([^)]*\)|var\([^)]*\)|#[0-9a-f]+\b|\b[a-z][a-z-]*\b/gi, " ").trim().split(/\s+/).filter((t) => /^-?[\d.]+(px|rem|em)?$/.test(t));
        if (n.length >= 3 && parseFloat(n[2]) > 0) {
          bad.push(`${r.line} ${r.sel}: ${/\binset\b/.test(layer) ? "inset lighting (a blurred inset shadow)" : "a hand-written blurred shadow or glow (use a tier token)"} (${layer})`);
        }
      }
    }
  }
  return { rules, bad, shadowLayers };
}

test("Flat Design 3.0: no blur, no hand-written blurred shadow or inset lighting, and no gradient outside the allowed set", () => {
  // The looks differ by colour and corner radii only (operator ruling, 13 Nov
  // 2026); construction is Flat Design 3.0's: soft neutral shadows, no
  // skeuomorphism. A source scanner, because the next rule written is the one
  // that brings a bezel, a glass layer or a glow back.
  const raw = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // The shell's tiers: --sh-1/2/3, or a legacy alias of one.
  const { rules, bad, shadowLayers } = flatDesignScan(raw, (name) => /^--(sh-[123]|shadow(-[123])?)$/.test(name));
  expect(rules.length, "anti-vacuity: the stylesheet parsed into rules").toBeGreaterThan(2000);
  expect(shadowLayers, "anti-vacuity: the stylesheet's box-shadow layers were read").toBeGreaterThan(100);
  // Gradients main itself used, plus data graphics; each entry says why, and each must still exist.
  const ALLOWED = [
    [/^\.ha-ring$/, "a countdown ring: conic progress plus a radial mask, a data graphic"],
    [/(^|, ?)(html\[data-theme="light"\] )?\.countdown$/, "the one gradient text: the countdown"],
    [/^\.skeleton/, "the loading shimmer (main)"],
    [/^\.lp-mini-gauge$/, "the look picker's preview of the time ring, a data graphic"],
    [/^(\[data-look="ambient"\] )?\.qa-gauge(\.qa-gauge-warn)?$/, "the time ring, a data graphic"],
    [/^\.podium-num::after$/, "the ribbon: hard-stop flat bands, not a smooth gradient"],
  ];
  const seen = new Set();
  for (const r of rules) {
    if (!/(linear|radial|conic)-gradient\(/.test(r.body)) continue;
    const parts = r.sel.split(/,(?![^(]*\))/).map((p) => p.trim());
    const ok = ALLOWED.findIndex(([rx]) => parts.every((p) => rx.test(p)) || rx.test(r.sel));
    if (ok < 0) bad.push(`${r.line} ${r.sel}: a gradient outside the allowed set`);
    else seen.add(ok);
  }
  ALLOWED.forEach(([rx, why], i) => { if (!seen.has(i)) bad.push(`stale allowance ${rx} (${why}): no gradient rule matches it any more — delete it`); });
  expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
});

// THE STANDALONE SHEETS. The pages opened from an email link and the public
// certificate pages cannot load styles.css, so each has its own sheet
// (verify-pages.css, unsubscribe.css) that declares the few tokens it uses. The
// checks above read styles.css alone, so nothing held these: unsubscribe.css
// drew its card shadow by hand (a third tier-1 value, the same in both modes),
// and verify-pages.css rounded corners with a name the shell does not have
// (--radius-lg) beside literal 8px and 12px. Derived, not listed: a sheet added
// beside them cannot escape by being new (fonts.css declares only faces).
// The maintenance page (server.js _MAINTENANCE_HTML) is the one standalone page
// whose sheet is its own <style> block, under its own CSP: it drew a 16px card on
// a 64px-blurred shadow, held by nothing, so its block is read here too.
function maintenanceStyle() {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const at = src.indexOf("const _MAINTENANCE_HTML = `");
  const m = at < 0 ? null : /<style>([\s\S]*?)<\/style>/.exec(src.slice(at, src.indexOf("`;", at)));
  if (!m) throw new Error("PRECONDITION: server.js _MAINTENANCE_HTML and its <style> block were found");
  return m[1];
}
function standaloneSheets() {
  const dir = path.join(__dirname, "..", "public");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".css") && !["fonts.css", "styles.css"].includes(f))
    .map((f) => ({ f, raw: fs.readFileSync(path.join(dir, f), "utf8") }))
    .concat([{ f: "server.js _MAINTENANCE_HTML", raw: maintenanceStyle() }]);
}
const _noComments = (raw) => raw.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Flat Design 3.0 in one standalone sheet: every shadow is one of the sheet's
 *  OWN tier tokens (--shadow-1/2/3, declared in it: a var() naming nothing voids
 *  the declaration, and the shell's --sh-* do not exist there), and no gradient. */
function standaloneFlatFindings(raw) {
  const declared = new Set([..._noComments(raw).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const { rules, bad, shadowLayers } = flatDesignScan(raw, (name) => /^--shadow-[123]$/.test(name) && declared.has(name));
  for (const r of rules) if (/(linear|radial|conic)-gradient\(/.test(r.body)) bad.push(`${r.line} ${r.sel}: a gradient (a standalone sheet has none)`);
  return { bad, shadowLayers };
}

test("Flat Design 3.0 in the standalone sheets: every shadow is the sheet's own tier token, nothing blurs, no gradient", () => {
  // Planted controls: each kind is caught, and the shapes the sheets use pass.
  const planted = standaloneFlatFindings(":root{--shadow-1:0 1px 2px #000}.a{box-shadow:0 1px 3px rgba(0,0,0,.08)}"
    + ".b{box-shadow:var(--sh-1)}.c{box-shadow:var(--shadow-2)}.d{backdrop-filter:blur(4px)}.e{background:linear-gradient(red,blue)}");
  expect(planted.bad.length, `hand-written, the shell's token, an undeclared tier, a backdrop blur, a gradient: ${JSON.stringify(planted.bad)}`).toBe(5);
  const clean = standaloneFlatFindings(":root{--shadow-1:0 1px 2px #000}/* .z{box-shadow:0 2px 8px #000} */"
    + ".a{box-shadow:var(--shadow-1)}.b{box-shadow:none}.c{box-shadow:inset 0 0 0 1px #000}");
  expect(clean.bad, "a declared tier, none, a flat edge and a comment pass").toEqual([]);

  const sheets = standaloneSheets();
  expect(sheets.length, "anti-vacuity: the standalone sheets and the maintenance page's block were found").toBeGreaterThanOrEqual(3);
  const bad = [];
  let layers = 0;
  for (const { f, raw } of sheets) {
    const r = standaloneFlatFindings(raw);
    layers += r.shadowLayers;
    bad.push(...r.bad.map((b) => `${f}:${b}`));
  }
  expect(layers, "anti-vacuity: the sheets' box-shadow layers were read").toBeGreaterThanOrEqual(4);
  expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
});

/** Corner radii in one standalone sheet: named with the shell's radius tokens
 *  (DESIGN_SYSTEM.md §4: --r-s/--r-m/--r-l/--r-xl; the --radius* names are only
 *  legacy aliases, and new code names the new tokens), each declared in the
 *  sheet at Signature's value, and no literal radius beside them. A circle (50%)
 *  or a square corner (0) is geometry, not a radius token. */
function radiusFindings(raw, shape) {
  const css = _noComments(raw);
  const bad = [];
  const declared = new Set();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    const [name, val] = [m[1], m[2].trim()];
    declared.add(name);
    if (/^--radius/.test(name)) bad.push(`declares the legacy name ${name} (the shell's names are ${Object.keys(shape).join(", ")})`);
    else if (shape[name] !== undefined && val !== shape[name]) bad.push(`${name} is ${val}; Signature's is ${shape[name]}`);
  }
  let radii = 0;
  for (const m of css.matchAll(/(?:^|[;{\s])(border(?:-[a-z]+)*-radius)\s*:\s*([^;}]+)/g)) {
    radii++;
    const value = m[2].replace(/!important/, "").trim();
    for (const part of value.split(/\s+(?![^(]*\))/)) {
      const tok = /^var\((--[\w-]+)\)$/.exec(part);
      if (tok && shape[tok[1]] === undefined) bad.push(`${m[1]}:${value} names ${tok[1]}, not one of the shell's radius tokens`);
      else if (tok && !declared.has(tok[1])) bad.push(`${m[1]}:${value} names ${tok[1]}, which this sheet does not declare (the declaration is void)`);
      else if (!tok && !/^(0|50%)$/.test(part)) bad.push(`${m[1]}:${value} is a literal radius (name a token)`);
    }
  }
  return { bad, radii };
}

test("the standalone sheets round corners with the shell's radius tokens, declared at Signature's values", () => {
  const { looks } = require("../scripts/theme/looks");
  const s = looks.signature.shape;
  const shape = { "--r-s": s.rs, "--r-m": s.rm, "--r-l": s.rl, "--r-xl": s.rxl };
  expect(Object.values(shape).every((v) => /^\d+px$/.test(v)), `PRECONDITION: Signature's shape is read from the data: ${JSON.stringify(shape)}`).toBe(true);
  // Planted controls: each kind is caught, and the shapes the sheets use pass.
  const planted = radiusFindings(":root{--radius-md:8px;--r-m:14px}.a{border-radius:12px}.b{border-radius:var(--radius-lg)}.c{border-top-left-radius:var(--r-l)}", shape);
  expect(planted.bad.length, `a legacy name, a wrong value, a literal, a name the shell lacks, an undeclared token: ${JSON.stringify(planted.bad)}`).toBe(5);
  const clean = radiusFindings(`:root{--r-s:${s.rs};--r-m:${s.rm}}/* .z{border-radius:12px} */.a{border-radius:var(--r-m)}.b{border-radius:var(--r-s) var(--r-s) 0 0}.c{border-radius:50%}`, shape);
  expect(clean.bad, "declared tokens, a per-corner list, a circle and a comment pass").toEqual([]);

  const sheets = standaloneSheets();
  expect(sheets.length, "anti-vacuity: the standalone sheets and the maintenance page's block were found").toBeGreaterThanOrEqual(3);
  const bad = [];
  let radii = 0;
  for (const { f, raw } of sheets) {
    const r = radiusFindings(raw, shape);
    radii += r.radii;
    bad.push(...r.bad.map((b) => `${f}: ${b}`));
  }
  expect(radii, "anti-vacuity: the sheets' radius declarations were read").toBeGreaterThanOrEqual(6);
  expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
});

// THE CHROME IS THE CARD'S SURFACE. The app's header and footer paint --surface
// (DESIGN_SYSTEM.md §7); the pages opened from an email link painted a fourth
// dark surface of their own (#131028, between --bg and --surface), so the header
// of the same email journey changed colour between the result page and the app.
test("the pages opened from an email paint their header and footer with the card's surface, in both modes", async ({ page }) => {
  // "system" makes the page follow each emulated scheme, whatever the house mode.
  await page.addInitScript(() => { try { localStorage.setItem("hck-theme", "system"); } catch (_) { /* no storage */ } });
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/verified.html");
    await page.locator("footer").waitFor({ state: "visible", timeout: 15000 });
    const got = await page.evaluate(() => {
      const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
      return { theme: document.documentElement.dataset.theme, header: bg("header"), footer: bg("footer"), card: bg(".card"), body: bg("body") };
    });
    const why = JSON.stringify({ scheme, ...got });
    expect(got.theme, `PRECONDITION: the page resolved ${scheme}: ${why}`).toBe(scheme);
    expect(got.card, `PRECONDITION: the card is painted by the sheet: ${why}`).not.toBe("rgba(0, 0, 0, 0)");
    expect(got.header, `the header is the card's surface: ${why}`).toBe(got.card);
    expect(got.footer, `the footer is the card's surface: ${why}`).toBe(got.card);
    // CONTROL: the chrome is not the page's canvas, so two unstyled reads (or
    // one element read twice) cannot satisfy the two above.
    expect(got.header, `the header is not the canvas: ${why}`).not.toBe(got.body);
  }
});
