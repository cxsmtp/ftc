// @ts-check
//
// v8.11.6 — HOVER AND FOCUS TEXT MUST MEET AA, AND axe CANNOT SEE EITHER.
//
// axe samples the RESTING state, so every `:hover{color:…}` and
// `:focus-visible{color:…}` rule in this stylesheet has shipped unmeasured —
// *Recurring rules* says exactly that ("the axe gate cannot see it, because axe
// samples the RESTING state and these states live behind a hover or a toggle"),
// and it was true of nine live rules at once.
//
// The measured defect: `--accent` (#7C3AED) is 3.13:1 on `--surface` and 2.92:1
// on `--surface2` in the DARK theme, and nine rules used it as hover or focus
// TEXT — so hovering HALVED the contrast of a control that was readable at rest
// (`--accent2` 6.54:1, `--muted` 5.20:1). CLAUDE.md had already recorded the
// token as unusable dark text at v7.21.0 ("--accent measures 2.89:1 on dark and
// FAILS"); nothing held it.
//
// WHY A STYLESHEET SCAN RATHER THAN NINE HOVERED NODES. A live-node test needs a
// fixture per site, and the failure mode is the site added LATER — the thing a
// fixture-driven test structurally cannot cover. This reads the rules and
// resolves the tokens for both themes, so a tenth rule is measured the day it is
// written. What it cannot know is which BACKGROUND a given element really sits
// on, so it measures against both card surfaces and requires a DECISION for
// anything that fails: fix the rule, or declare it here with its reason
// (*Recurring rules*: a decision per item, never blanket coverage).
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

// Strip comments first — a comment quoting `color:var(--accent)` in an
// explanation would otherwise be scanned as a rule (*Recurring rules*).
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

// THE LOOKS. Every look x mode x ambient light colour has its own palette,
// generated into styles.css from scripts/theme/looks.js; tests/look-tokens.js
// resolves each one, legacy token names included, from that same data.
const { lookCombos } = require("./look-tokens");

const hex = (s) => {
  const m = /^#([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const ratio = (a, b) => {
  const [x, y] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
};

// A rule is EXEMPT only with a reason. Each of these paints onto something other
// than a plain card surface, so measuring it against --surface/--surface2 would
// be wrong about working code — the one way a scanner gets deleted.
const EXEMPT = new Map([
  [".tag .tag-x:hover", "white on the solid --accent chip fill, not on a card surface"],
  [".group-tag .tag-x:hover", "white on the solid --group-accent chip fill"],
]);

test.describe("v8.11.6 — hover and focus text meets AA in every look, day and night", () => {
  for (const { theme, label, tokens: tok } of lookCombos()) {
    test(`every :hover / :focus-visible colour rule clears 4.5:1 in ${label}`, () => {
      expect(Object.keys(tok).length, "the token block must resolve, or this scan measures nothing")
        .toBeGreaterThan(20);
      const surfaces = [["--surface", hex(tok["--surface"])], ["--surface2", hex(tok["--surface2"])]];
      for (const [name, c] of surfaces) expect(c, `${name} must resolve to a hex`).toBeTruthy();

      // MODEL THE ONE CASCADE THIS STYLESHEET ACTUALLY USES. Thirteen rules pair a
      // base colour with an `html[data-theme="light"] <same selector>` override —
      // the established idiom for a token that reads in one theme and not the
      // other. Without modelling it the light pass flags a base rule that light
      // never applies, which is a scanner wrong about working code.
      const lightOverridden = new Set();
      for (const [, sel2, body2] of SRC.matchAll(/([^{}]*html\[data-theme="light"\][^{}]*)\{([^}]*)\}/g)) {
        if (!/(?:^|;)\s*color\s*:/.test(body2)) continue;
        lightOverridden.add(sel2.trim().replace(/\s+/g, " ").replace(/html\[data-theme="light"\]\s*/g, ""));
      }

      const bad = [];
      let scanned = 0;
      // Every rule whose SELECTOR carries :hover or :focus-visible and whose body
      // sets a `color:` — the two states axe never samples.
      for (const [, selector, body] of SRC.matchAll(/([^{}]*(?::hover|:focus-visible)[^{}]*)\{([^}]*)\}/g)) {
        const sel = selector.trim().replace(/\s+/g, " ");
        if (!sel || sel.startsWith("@")) continue;
        const cm = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(body);
        if (!cm) continue;
        let val = cm[1].trim();
        const vm = /^var\((--[\w-]+)\)$/.exec(val);
        if (vm) val = tok[vm[1]] || "";
        const fg = hex(val);
        if (!fg) continue;               // a keyword or a computed value — out of scope
        // A rule that paints its OWN background is not text on a card, so
        // measuring it against --surface/--surface2 would be wrong about working
        // code — the one way a scanner gets deleted (*Recurring rules*). Those
        // surfaces are tinted composites and belong to whichever check owns that
        // component; this scan is deliberately about the plain-card case.
        if (/(?:^|;)\s*background(?:-color)?\s*:\s*(?!none\b)/.test(body)) continue;
        // A light-only rule is not part of the dark pass, and vice versa.
        const isLightRule = /html\[data-theme="light"\]/.test(sel);
        if (isLightRule !== (theme === "light")) { if (isLightRule) continue; }
        scanned++;
        if (EXEMPT.has(sel)) continue;
        if (theme === "light" && !isLightRule && lightOverridden.has(sel)) continue;
        for (const [sname, sc] of surfaces) {
          const r = ratio(fg, sc);
          if (r < 4.5) bad.push(`${sel} → ${val} on ${sname} = ${r}:1`);
        }
      }
      // Anti-vacuity: a rename that empties the match set must fail loudly rather
      // than pass in silence.
      expect(scanned, "the scan found almost no hover/focus colour rules — it has gone vacuous")
        .toBeGreaterThanOrEqual(12);
      expect(bad, `hover/focus text below AA in ${theme}:\n  ${bad.join("\n  ")}`).toHaveLength(0);
    });
  }
});

// v8.11.8 — THE iOS-ZOOM ESCAPE BLOCK MUST NOT BE BEATEN BY A LATER RULE.
//
// `@media (pointer: coarse)` re-asserts `font-size:16px` on nine controls,
// because iOS Safari zooms a focused control under 16px and does NOT zoom back
// out — leaving a phone user stranded mid-page-jump. Measured at 820x1180 with
// hasTouch, FIVE of the nine were inert: `.filter-select`, `.filter-card
// input[type=date]`, `.picker-search`, `.page-jump input` and `.picker-filter`
// rendered at 13.12-13.6px. The split was exactly declaration ORDER — the four
// that won declare their own font-size BEFORE the block, the five that lost
// declare it after, at equal specificity, and a media query adds none.
//
// This is a SOURCE scan rather than a render, deliberately: the failure is a
// property of the cascade, so a rule added tomorrow after the block breaks it
// again, and only reading the file can see that.
test("v8.11.8: no rule after the coarse-pointer escape block re-sets font-size on its selectors", () => {
  const block = /@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/.exec(SRC);
  expect(block, "the coarse-pointer escape block must exist").toBeTruthy();
  const body = block[1];
  const at = block.index;
  const sels = body.slice(0, body.lastIndexOf("{"))
    .split(",").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
  expect(sels.length, "the block must guard several controls, or this scan is vacuous")
    .toBeGreaterThanOrEqual(8);

  const after = SRC.slice(at + block[0].length);
  const bad = [];
  for (const sel of sels) {
    // A later rule whose selector list CONTAINS this one and which sets a
    // font-size wins at equal specificity — which is what happened to five.
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[,{}])\\s*${esc}\\s*(,[^{}]*)?\\{[^}]*font-size`, "m");
    if (re.test(after)) bad.push(sel);
  }
  expect(bad, `these lose to a LATER font-size rule, so the 16px escape is inert:\n  ${bad.join("\n  ")}`)
    .toHaveLength(0);
});

// v8.11.8 — A `:has()` SELECTOR MAY NOT SHARE A LIST WITH ITS OWN FALLBACK.
//
// A selector LIST is rejected WHOLE when any part of it fails to parse, so
// `main:has(#admin-page.active),main.admin-active{…}` discarded the fallback on
// exactly the engines that needed it — dead by construction. Proven identically
// on chromium 153, firefox 155 and webkit 26.6 via `insertRule`: a list pairing
// an unknown pseudo-class with a plain selector is a SyntaxError on all three,
// while the plain selector alone parses.
//
// No behavioural test can catch this: every engine in the matrix SUPPORTS
// `:has()`, so the fallback is unreachable there whether or not it parses. A
// source rule is the only thing that can hold it.
test("v8.11.8: no :has() selector list carries a non-:has() fallback beside it", () => {
  const bad = [];
  let lists = 0;
  for (const [, selector] of SRC.matchAll(/([^{}]*:has\([^{}]*)\{/g)) {
    const sel = selector.trim();
    if (!sel || sel.startsWith("@")) continue;
    lists++;
    const parts = sel.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1 && parts.some((p) => !p.includes(":has("))) {
      bad.push(sel.replace(/\s+/g, " "));
    }
  }
  expect(lists, "the scan found no :has() rules — it has gone vacuous").toBeGreaterThanOrEqual(1);
  expect(bad, `an engine without :has() discards these lists WHOLE, fallback included:\n  ${bad.join("\n  ")}`)
    .toHaveLength(0);
});
