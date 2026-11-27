// @ts-check
//
// v8.13.4 — THE CLIENT READS NO SCREEN, SO PLAYWRIGHT 1.64'S FORWARDED SCREEN IS
// INERT HERE.
//
// Playwright 1.64 began forwarding a device descriptor's `screen` into the
// browser context — for every project that spreads `devices[...]`, AND for every
// browser.newContext() made under such a project, which inherits it. Before,
// no screen was set (Chromium and WebKit reported the viewport, Firefox a fixed
// 1366x768). Measured after the bump:
//   • the chromium buckets (viewport 1280x800) report window.screen 1920x1080,
//     the Desktop Chrome descriptor's — not a screen anyone configured;
//   • every Windows / macOS laptop project reports its DESCRIPTOR's screen
//     (1920x1080, or 1792x1120 for Desktop Safari), not the laptop's, and
//     windows-chrome-desktop-portrait is a 1080x1920 viewport on a LANDSCAPE
//     screen;
//   • a portrait isMobile context under chromium reports screen.orientation
//     "landscape-primary" (Chromium derives a mobile orientation from the
//     SCREEN);
//   • the phone projects gained a realistic screen — iOS keeps a portrait screen
//     in landscape, exactly as the real device does.
//
// It was deliberately NOT overridden. Layout, CSS `(orientation: …)`, the meta
// viewport's `width=device-width` and every width/height/pointer query this app
// uses resolve against the VIEWPORT, and were measured unchanged on all three
// engines (a 390x844 isMobile context on a 1920x1080 screen: innerWidth 390,
// `(orientation: portrait)` true). Pinning `screen` to the viewport would have
// made the phone projects LESS like the phones they model.
//
// That decision holds for exactly as long as the client never asks for the
// screen. This file is what keeps it true: no `window.screen` / `screen.*` read,
// no `window.orientation` / `orientationchange`, and no
// `device-width` / `device-height` / `device-aspect-ratio` media feature, in any
// client script (public/js/** and the classic public/*.js) or stylesheet
// (public/*.css). If a feature genuinely needs one, that is the moment to give
// the projects in playwright.config.js a coherent `screen` — the matrix's
// screens are NOT representative today — and to re-point this lock.
//
// Comments are stripped first, by a lexer that knows where strings, templates
// and regex literals are — a slash-star inside a string literal must not open a
// "comment" that hides the code after it (the v8.13.3 lesson). It produces TWO
// views, and each rule reads the one that matches what it looks for:
//   • the CODE view blanks string, template and regex TEXT too (a template's
//     `${…}` substitution stays — that is code), and the identifier rules read
//     it, so copy such as "shown on screen. Then…" is not a read of the screen
//     global (the pre-release review: the first draft flagged exactly that);
//   • the TEXT view keeps strings, because a media feature lives INSIDE a
//     matchMedia string and an event name inside an addEventListener string.
// The device-* rule matches the media-feature SHAPE — `(max-device-width:` —
// so the meta-viewport string `width=device-width` is not a query. Stated
// limit: a LOCAL binding named `screen` is still flagged by the member rule;
// rename it, since a local shadowing the screen global hides a real read from
// every reader, this scanner included. The vocabulary is self-checked against
// planted snippets in both directions, so neither a pattern that matches
// nothing nor one that flags "screen readers" can pass.
const { test, expect, devices } = require("./isolated-test");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * Blank JS comments (newlines and length kept). With `{ code: true }` the TEXT
 * of strings, templates and regex literals is blanked as well — delimiters and a
 * template's `${…}` substitution code are kept — so identifier rules read code
 * only. Without it, strings/templates/regex are left intact.
 */
function stripJsComments(src, { code = false } = {}) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const KW_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|instanceof|yield|await|else|do)$/;
  const tpl = []; // brace depth at which each open template substitution closes
  let depth = 0;
  let i = 0;
  const prevSignificant = (k) => { let j = k - 1; while (j >= 0 && /\s/.test(out[j])) j--; return j; };
  const scanTemplateText = (k) => {
    while (k < n) {
      const c = src[k];
      if (c === "\\") { k += 2; continue; }
      if (c === "`") return { next: k + 1, opened: false };
      if (c === "$" && src[k + 1] === "{") return { next: k + 2, opened: true };
      k++;
    }
    return { next: n, opened: false };
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const end = e === -1 ? n : e; blank(i, end); i = end; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e === -1 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      if (code) blank(i + 1, Math.min(k, n));
      i = k + 1; continue;
    }
    if (c === "`") {
      const r = scanTemplateText(i + 1);
      if (code) blank(i + 1, r.opened ? r.next - 2 : r.next - 1);
      if (r.opened) { tpl.push(depth); depth++; }
      i = r.next; continue;
    }
    if (c === "/") {
      const j = prevSignificant(i);
      const prev = j < 0 ? "" : out[j];
      const before = src.slice(Math.max(0, j - 12), j + 1);
      if (j < 0 || "(,=:[!&|?{};+-*%<>~^".includes(prev) || KW_BEFORE_REGEX.test(before)) {
        let k = i + 1, inClass = false;
        while (k < n && src[k] !== "\n") {
          const ch = src[k];
          if (ch === "\\") { k += 2; continue; }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          k++;
        }
        if (code) blank(i + 1, Math.min(k, n));
        i = k + 1; continue;
      }
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        const r = scanTemplateText(i + 1);
        if (code) blank(i + 1, r.opened ? r.next - 2 : r.next - 1);
        if (r.opened) { tpl.push(depth); depth++; }
        i = r.next; continue;
      }
      i++; continue;
    }
    i++;
  }
  return out.join("");
}

/** Blank CSS comments (newlines and length kept); quoted strings kept. */
function stripCssComments(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      i = k + 1; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      for (let k = i; k < end; k++) if (out[k] !== "\n") out[k] = " ";
      i = end; continue;
    }
    i++;
  }
  return out.join("");
}

// A device-* media feature reads the SCREEN in every engine; the viewport's own
// features (width, height, orientation, aspect-ratio) are what this app uses.
// Matched as a FEATURE — opened by `(` (or `min-`/`max-` after it) and closed by
// `:` or `)` — so the meta-viewport `width=device-width` is not one.
// Media Queries 4 RANGE syntax reads the screen just the same — `(device-width <
// 600px)`, `(400px <= device-width)` — so a feature named first may be followed
// by a comparison, and a VALUE may come first (the fix-delta review: the
// narrowed rule missed both). A value-first form starts with a number, which the
// meta-viewport's `width=device-width` never does.
const DEVICE_MEDIA = { name: "a device-width/height/aspect-ratio media feature", re: /\(\s*(?:(?:min-|max-)?device-(?:width|height|aspect-ratio)\s*[:)<>=]|[\d.]+[a-z%]*(?:\s*\/\s*[\d.]+)?\s*[<>]?=?\s*device-(?:width|height|aspect-ratio)\b)/ };

// Read over the CODE view (string/template/regex text blanked).
const JS_CODE_RULES = [
  { name: "window.screen (or self/globalThis/top/parent.screen)", re: /\b(?:window|self|globalThis|top|parent)\s*\??\.\s*screen\b/ },
  // The bare global: `screen.width`, `screen?.orientation`, `screen["availHeight"]`.
  // Not `e.screenX` (no word boundary after `screen`), not `S.screen` (a member).
  { name: "a member read off the screen global", re: /(?<![\w$.])screen\s*(?:\??\.\s*[A-Za-z_$]|\[)/ },
  // `const { width } = screen;` / `= screen,` — the global taken whole.
  { name: "the screen global assigned or destructured", re: /=\s*screen\s*(?:[;,)\n]|$)/ },
  { name: "window.orientation", re: /\b(?:window|self|globalThis)\s*\??\.\s*orientation\b/ },
];
// Read over the TEXT view (strings kept): the event name and the media feature
// both live inside string literals.
const JS_TEXT_RULES = [
  { name: "the orientationchange event", re: /orientationchange/ },
  DEVICE_MEDIA,
];
const CSS_RULES = [DEVICE_MEDIA];

/** Both views of one JS source, each read by its own rules. */
function jsFindings(src) {
  return [
    ...findings(stripJsComments(src, { code: true }), JS_CODE_RULES),
    ...findings(stripJsComments(src), JS_TEXT_RULES),
  ];
}

function findings(stripped, rules) {
  const out = [];
  const lines = stripped.split("\n");
  lines.forEach((line, idx) => {
    for (const r of rules) if (r.re.test(line)) out.push({ line: idx + 1, rule: r.name, text: line.trim().slice(0, 140) });
  });
  return out;
}

function clientFiles() {
  const js = [], css = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith(".js")) js.push(r);
    }
  })(path.join("public", "js"));
  for (const e of fs.readdirSync(path.join(ROOT, "public"), { withFileTypes: true })) {
    if (!e.isFile()) continue;
    if (e.name.endsWith(".js")) js.push(path.join("public", e.name));
    else if (e.name.endsWith(".css")) css.push(path.join("public", e.name));
  }
  return { js, css };
}

test.describe("v8.13.4 — the client reads no screen, so the forwarded screen stays inert", () => {
  test("the scanner's vocabulary flags every screen read and nothing that is not one", () => {
    const flagJs = (s) => jsFindings(s).length > 0;
    const flagCss = (s) => findings(stripCssComments(s), CSS_RULES).length > 0;
    // POSITIVE: each shape a real read can take.
    const reads = [
      "const w = window.screen.width;",
      "if (screen.width < 600) go();",
      "const o = screen?.orientation?.type;",
      "const h = screen['availHeight'];",
      "const { width } = screen;",
      "use(self.screen);",
      "if (window.orientation === 90) x();",
      "addEventListener('orientationchange', f);",
      "const mq = matchMedia('(max-device-width: 600px)');",
      // The v8.13.3 trap: a slash-star inside a STRING must not open a "comment"
      // that runs to the next real one and swallows the read in between...
      'const accept = "image/*";\nconst w = screen.width;\n/* a later comment */',
      // ...nor may one inside a REGEX literal (here, a character class).
      "const re = /[/*]/;\nconst w = screen.width;\n/* a later comment */",
      // A template's ${…} substitution is CODE, so blanking template text must
      // not blank it.
      "const t = `${screen.width}px wide`;",
      "const t = `a ${'b'} ${window.screen.availWidth}`;",
    ];
    for (const s of reads) expect(flagJs(s), `should flag: ${JSON.stringify(s)}`).toBe(true);
    expect(flagCss("@media (max-device-width:600px){a{b:c}}")).toBe(true);
    expect(flagCss("@media (device-aspect-ratio: 16/9){a{b:c}}")).toBe(true);
    // Range syntax, both orders (the fix-delta review).
    expect(flagCss("@media (device-width < 600px){a{b:c}}")).toBe(true);
    expect(flagCss("@media (400px <= device-width <= 700px){a{b:c}}")).toBe(true);
    expect(flagCss("@media (16/9 < device-aspect-ratio){a{b:c}}")).toBe(true);
    expect(flagCss("@media (width < 600px){a{b:c}}"), "a VIEWPORT range query is not a screen read").toBe(false);
    // CONTROL: what the client really contains and must stay legal.
    const legal = [
      "// window.screen.width is deliberately never read",
      "/* screen.orientation */ const a = 1;",
      "announce('so screen readers convey it');",
      "const x = e.screenX + e.screenY;",
      "const s = S.screen; const o = { screen: 1 };",
      "const mq = matchMedia('(max-width:600px) and (orientation: portrait)');",
      "const t = `on screen ${n} rows`;",
      // The pre-release review's shapes: copy that ENDS a sentence with
      // "screen" (string and template text), a regex BODY, and the
      // meta-viewport value — none of them is a read of the screen.
      "toast('Shown on screen. Then press Save.');",
      "const msg = \"Fits the screen. Rotate to see more.\";",
      "const t = `Too small a screen.${hint}`;",
      "const re = /screen.width/;",
      "meta.content = 'width=device-width, initial-scale=1';",
    ];
    for (const s of legal) expect(flagJs(s), `should NOT flag: ${JSON.stringify(s)}`).toBe(false);
    expect(flagCss("@media screen and (max-width:480px) and (orientation:portrait){a{b:c}}")).toBe(false);
    expect(flagCss("/* never use max-device-width here */ a{b:c}")).toBe(false);
    // And a slash-star inside a CSS string must not hide the rule after it.
    expect(flagCss('a::after{content:"/*"}\n@media (max-device-width:600px){a{b:c}}')).toBe(true);
  });

  test("no client script or stylesheet reads the screen or a device-* media feature", () => {
    const { js, css } = clientFiles();
    // Anti-vacuity: a moved directory or a renamed extension must not empty the
    // scan and pass in silence. Floors at the shipped counts' order of magnitude.
    expect(js.length, "client .js files scanned").toBeGreaterThanOrEqual(40);
    expect(css.length, "public/*.css stylesheets scanned").toBeGreaterThanOrEqual(4);
    const bad = [];
    for (const rel of js) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const f of jsFindings(src)) bad.push(`${rel}:${f.line} — ${f.rule}: ${f.text}`);
    }
    for (const rel of css) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const f of findings(stripCssComments(src), CSS_RULES)) bad.push(`${rel}:${f.line} — ${f.rule}: ${f.text}`);
    }
    expect(bad, "Playwright 1.64 forwards the device descriptor's screen, which is NOT the " +
      "configured viewport (see playwright.config.js). Reading it makes the cross-device " +
      "matrix measure screens nobody chose — give the projects a coherent `screen` first, " +
      "then re-point this lock:\n" + bad.join("\n")).toEqual([]);
  });

  // The PREMISE, held so the prose stays true: if Playwright stops forwarding the
  // descriptor's screen, the comments in playwright.config.js, README and the
  // header above describe something that no longer happens — this fails first.
  test("the premise: the chromium project's window.screen is the descriptor's, not its viewport", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "the chromium buckets spread Desktop Chrome");
    const want = devices["Desktop Chrome"].screen;
    expect(want, "Desktop Chrome descriptor carries a screen").toBeTruthy();
    await page.setContent("<!doctype html><title>s</title><p>s</p>");
    const got = await page.evaluate(() => ({ w: screen.width, h: screen.height, iw: innerWidth, ih: innerHeight }));
    expect({ w: got.w, h: got.h }, "window.screen is forwarded from the Desktop Chrome descriptor").toEqual({ w: want.width, h: want.height });
    expect({ w: got.iw, h: got.ih }, "the viewport is the configured 1280x800, not the screen").toEqual({ w: 1280, h: 800 });
  });
});
