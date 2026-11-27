// @ts-check
//
// THE TYPE SYSTEM HAS ONE SOURCE. Every family, size and weight the SPA draws
// comes from the type-token block at the top of public/styles.css (the hand-written
// `:root` block that opens with "TYPE — the one block"): --font-display /
// --font-text / --font-mono, --fs-* / --lh-* and --fw-*. The v8.16 visual QA
// measured 3-5 families, 10-22 sizes and 5-9 weights PER SCREEN, from 34 literal
// sizes in the stylesheet and ~180 inline size/weight literals in public/js; the
// fix is mechanical, so the guard is a scanner, not a sentence.
//
// It refuses:
//   1. a literal font-size or font-weight in styles.css outside the token block;
//   2. a literal font-size or font-weight in public/js/** (inline style strings
//      and element.style assignments alike);
//   3. a literal font-family anywhere in styles.css or public/js/** except the
//      token definitions. A literal is anything but var(--…) or inherit;
//   4. any of the three in the static markup's inline styles (public/*.html,
//      HTML comments stripped): the shell's own `style=""` attributes draw on
//      the same screens.
// public/fonts.css (@font-face names), and the two standalone pages that cannot
// load styles.css (unsubscribe.css, verify-pages.css) are out of scope by design.
// A browser arm holds the one size with no declaration at all: a <button> with no
// class takes its container's size and family, never the engine's control default.
//
// A size derived from geometry (the avatar emoji sized to its box, the timer
// ring's measured fit) rides a custom property (`--av-fs`, `--gauge-fit-fs`) so
// the declaration stays a token reference; a type choice uses the scale.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { stripJsComments } = require("./doc-registry");

const ROOT = path.join(__dirname, "..");
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
const ALLOWED = /^(?:var\(--[a-z0-9-]+\)|inherit)$/;
const lineOf = (src, i) => src.slice(0, i).split("\n").length;

/** Literal type declarations in one CSS-ish source; offsets in [skipFrom, skipTo) are exempt. */
function cssOffenders(src, label, skipFrom = -1, skipTo = -1) {
  const out = [];
  for (const m of src.matchAll(/font-(size|weight|family)\s*:\s*([^;}\n"'`]+?)\s*(?:!important)?\s*(?=[;}\n"'`])/g)) {
    if (m.index >= skipFrom && m.index < skipTo) continue;
    if (!ALLOWED.test(m[2].trim())) out.push(`${label}:${lineOf(src, m.index)}  font-${m[1]}:${m[2].trim()}`);
  }
  return out;
}
/** element.style.fontSize = "…" and friends. */
function styleAssignOffenders(src, label) {
  const out = [];
  for (const m of src.matchAll(/\.font(Size|Weight|Family)\s*=\s*([^;\n]+)/g)) {
    const v = m[2].trim();
    if (!/var\(--[a-z0-9-]+\)/.test(v) && !/^(['"])\1$/.test(v)) out.push(`${label}:${lineOf(src, m.index)}  .font${m[1]}=${v}`);
  }
  return out;
}
function tokenBlock(css) {
  const start = css.indexOf("/* TYPE — the one block");
  const open = css.lastIndexOf(":root{", start);
  const end = css.indexOf("\n}\n", start);
  return { open, end };
}
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("the scanner's detectors catch a planted literal (anti-vacuity, always on)", () => {
  expect(cssOffenders(".x{font-size:.8rem;font-weight:700}", "planted")).toHaveLength(2);
  expect(cssOffenders(".x{font-family:monospace}", "planted")).toHaveLength(1);
  expect(cssOffenders(".x{font-size:var(--fs-14);font-weight:var(--fw-semibold);font-family:var(--font-mono)}", "ok")).toEqual([]);
  expect(cssOffenders("`<b style=\"font-size:12px\">`", "planted-js")).toHaveLength(1);
  expect(cssOffenders(stripHtml('<span style="font-size:.7rem;padding:1px 6px">x</span><!-- style="font-size:9px" -->'), "planted-html"),
    "a literal in markup is caught; one inside an HTML comment is not").toHaveLength(1);
  expect(styleAssignOffenders("d.style.fontSize='0.8rem';d.style.fontFamily=item;", "planted")).toHaveLength(2);
  expect(styleAssignOffenders("d.style.fontSize='var(--fs-13)';", "ok")).toEqual([]);
  const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  const { open, end } = tokenBlock(css);
  expect(open, "the type-token block is found").toBeGreaterThan(-1);
  const block = css.slice(open, end);
  for (const t of ["--font-display:", "--font-text:", "--font-mono:", "--fw-regular:", "--fw-semibold:", "--fs-body:", "--fs-label:"]) {
    expect(block, `the token block defines ${t}`).toContain(t);
  }
  expect((block.match(/--fs-[a-z0-9-]+:/g) || []).length, "the scale is a real set of steps").toBeGreaterThanOrEqual(20);
});

test("no literal font-size, font-weight or font-family outside the type tokens", () => {
  const offenders = [];
  const cssRaw = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  const css = stripCss(cssRaw);
  const { open, end } = tokenBlock(cssRaw);
  offenders.push(...cssOffenders(css, "public/styles.css", open, end));
  const files = jsFiles(path.join(ROOT, "public", "js"));
  expect(files.length, "anti-vacuity: the SPA modules are found").toBeGreaterThan(20);
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const src = stripJsComments(fs.readFileSync(f, "utf8"));
    offenders.push(...cssOffenders(src, rel), ...styleAssignOffenders(src, rel));
  }
  const pages = fs.readdirSync(path.join(ROOT, "public")).filter((n) => n.endsWith(".html"));
  expect(pages, "anti-vacuity: the shell markup is scanned").toContain("index.html");
  for (const n of pages) offenders.push(...cssOffenders(stripHtml(fs.readFileSync(path.join(ROOT, "public", n), "utf8")), `public/${n}`));
  expect(offenders,
    "a literal type value bypasses the scale. Use var(--fs-<role>) / var(--fw-regular|semibold) / " +
    "var(--font-display|text|mono) — see .claude/DESIGN_SYSTEM.md \"Type\":\n  " + offenders.join("\n  ")).toEqual([]);
});

// A <button> with no class of its own draws its CONTAINER's family and size. The
// bare `button` rule named the family only, so such a button fell to the
// engine's control default: 13.33 px in Chromium and Firefox, 16 px in WebKit —
// a size outside the scale, and a different one per engine. Measured by value in
// a real page, beside a .btn control that keeps its own role size.
test("a bare <button> draws its container's size and family, never the engine's default", async ({ page }) => {
  const { BASE } = require("./helpers");
  await page.goto(`${BASE}/`);
  await page.locator("#login-page").waitFor({ state: "attached", timeout: 20000 });
  const got = await page.evaluate(() => {
    const box = document.createElement("div");
    box.style.fontSize = "var(--fs-18)";
    box.style.fontFamily = "var(--font-mono)";
    const bare = document.createElement("button"); bare.type = "button"; bare.textContent = "bare";
    const role = document.createElement("button"); role.type = "button"; role.className = "btn"; role.textContent = "btn";
    box.append(bare, role);
    document.body.appendChild(box);
    const cs = (el) => getComputedStyle(el);
    const out = { box: cs(box).fontSize, boxFamily: cs(box).fontFamily, bare: cs(bare).fontSize, bareFamily: cs(bare).fontFamily,
      btn: cs(role).fontSize, btnRole: getComputedStyle(document.documentElement).getPropertyValue("--fs-btn").trim() };
    box.remove();
    return out;
  });
  expect(got.box, "PRECONDITION: the container is the 18 px step").toBe("18px");
  expect(got.bare, `the bare button takes the container's size: ${JSON.stringify(got)}`).toBe(got.box);
  expect(got.bareFamily, "…and its family").toBe(got.boxFamily);
  // CONTROL: a .btn keeps the button role's size (15 px), whatever its container.
  expect(got.btn, `a .btn keeps the role size: ${JSON.stringify(got)}`).toBe("15px");
  expect(got.btn).not.toBe(got.box);
});
