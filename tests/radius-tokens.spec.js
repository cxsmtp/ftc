// @ts-check
//
// EVERY CORNER FOLLOWS THE LOOK. A look differs only by colour and corner radii
// (.claude/DESIGN_SYSTEM.md principle 4 and §4), so a corner radius is a TOKEN:
// a per-look rung (--r-s / --r-m / --r-l / --r-xl: Signature 8/12/18/26, Ambient
// 10/14/20/28), one of the two look-independent radii (--radius-sm 4 px,
// --pill-radius 999 px) or a legacy alias of a rung (--radius, --radius-md,
// --radius-xl). A literal 8px drew Signature's small corner in Ambient too.
//
// It refuses, in public/styles.css (comments stripped), every SPA script
// (public/js/** and the classic public/*.js: inline style strings, cssText,
// element.style.borderRadius and setProperty) and the static markup's inline
// styles (public/*.html):
//   1. an ON-LADDER literal: a length that is a rung of either look or one of
//      the two look-independent radii, derived from scripts/theme/looks.js and
//      the hand-written :root (never listed here), and any pill literal;
//   2. any other length literal that is not a recorded decision, value-wide
//      (OFF_LADDER) or for one rule (AT_SITE), each with its reason; a decision
//      that no longer matches anything is stale and fails too;
//   3. a var() in a radius that is not a radius token (an undefined name voids
//      the declaration, a spacing token detours the look).
// The idioms it accepts: 0, a percentage (50% is a circle), the CSS-wide
// keywords, and a calc()/min()/max()/clamp() that reads a radius token (an offset
// from the look's corner follows the look).
//
// Out of scope by design: the standalone pages that cannot load styles.css
// (unsubscribe.css, verify-pages.css and the maintenance page's own block, held
// by the standalone arms of tests/theme-tokens.spec.js) and mail markup (mail
// clients drop var()); none of them takes a look.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { stripJsComments } = require("./doc-registry");
const { looks: LOOK_DATA } = require("../scripts/theme/looks");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
const lineOf = (src, i) => src.slice(0, i).split("\n").length;

// The shared stripper removes comments outright, which shifts line numbers. A
// marker at the start of every line survives it (it sits outside any string or
// line comment), so an offender is reported at its real line.
const MARK = "\u0001";
function jsCode(src) {
  return stripJsComments(src.split("\n").map((l, i) => `${MARK}${i + 1}${MARK}${l}`).join("\n"));
}
function jsLineAt(code, idx) {
  const close = code.lastIndexOf(MARK, idx);
  const open = code.lastIndexOf(MARK, close - 1);
  return close > 0 && open >= 0 ? Number(code.slice(open + 1, close)) : lineOf(code, idx);
}

// ── The ladder, derived ────────────────────────────────────────────────────
const SHAPE_TOKEN = { rs: "--r-s", rm: "--r-m", rl: "--r-l", rxl: "--r-xl" };
function ladder() {
  const css = stripCss(read("public/styles.css"));
  const rootVal = (name) => {
    const m = css.match(new RegExp(`(?<![\\w-])${name}\\s*:\\s*([^;}\\n]+)`));
    return m ? m[1].trim() : null;
  };
  /** literal -> what to write instead */
  const onLadder = new Map();
  for (const [look, data] of Object.entries(LOOK_DATA)) {
    for (const [key, token] of Object.entries(SHAPE_TOKEN)) {
      const v = data.shape && data.shape[key];
      if (!v) continue;
      const was = onLadder.get(v);
      onLadder.set(v, `${was ? `${was}, ` : ""}var(${token}) (${look})`);
    }
  }
  const sm = rootVal("--radius-sm");
  const pill = rootVal("--pill-radius");
  if (sm) onLadder.set(sm, "var(--radius-sm)");
  if (pill) onLadder.set(pill, "var(--pill-radius)");
  // The tokens a radius may name: the rungs, the two look-independent radii and
  // every alias whose value is a rung (the generated LEGACY_ALIASES rule).
  const tokens = new Set(["--radius-sm", "--pill-radius", ...Object.values(SHAPE_TOKEN)]);
  for (const m of css.matchAll(/(?<![\w-])(--[a-z0-9-]+)\s*:\s*var\((--r-(?:s|m|l|xl))\)/g)) tokens.add(m[1]);
  const defined = (name) => new RegExp(`(?<![\\w-])${name}\\s*:`).test(css);
  return { onLadder, tokens, sm, pill, defined };
}

// ── Decisions, each with its reason ────────────────────────────────────────
const GEOMETRY = "a mark a few px across (a bar, pip, dash, rule or the look preview's miniature " +
  "diamond) rounds by its own size, not by the look's corner; growing it with the look would distort it";
const OFF_LADDER = {
  "1px": GEOMETRY,
  "2px": GEOMETRY,
  "3px": GEOMETRY,
  "6px": "grandfathered (CLAUDE.md, Accepted audit dispositions, Operations and UI)",
};
// Each literal decided for one rule: { file, where (a selector it sits in), value,
// reason }. None today (the keycap and the join QR's plate were aligned to the
// ladder, operator ruling 25 Nov 2026); the mechanism and its stale check stay.
const AT_SITE = [];
const KEYWORD = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const NUMBER_UNIT = /^(-?\d*\.?\d+)([a-z%]*)$/i;

/** Split a value at top level: whitespace and "/" separate, parentheses group. */
function topLevel(value) {
  const out = [];
  let cur = "", depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (/\s/.test(ch) || ch === "/")) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Judge one radius value. `ctx` = { file, where } (where: the CSS selector, or the
 * source line). Returns a list of { problem, value } and records every decision
 * it relied on in `used`.
 */
function judge(value, ctx, L, used, sites = AT_SITE) {
  const out = [];
  const v = value.replace(/\s*!important\s*$/i, "").trim();
  if (!v) return [{ problem: "an empty or computed value (a script expression cannot be judged: write the token)", value }];
  for (const tok of topLevel(v)) {
    const fn = tok.match(/^([a-z-]+)\((.*)\)$/is);
    if (fn) {
      const name = fn[1].toLowerCase();
      if (name === "var") {
        const [varName, ...fallback] = fn[2].split(",");
        if (!L.tokens.has(varName.trim())) out.push({ problem: `var(${varName.trim()}) is not a radius token (${[...L.tokens].join(", ")})`, value });
        if (fallback.length) out.push(...judge(fallback.join(","), ctx, L, used, sites));
        continue;
      }
      if (["calc", "min", "max", "clamp"].includes(name)) {
        const vars = [...fn[2].matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
        if (!vars.length) out.push({ problem: `${name}() of literals only: it reads no radius token`, value });
        for (const n of vars) if (!L.tokens.has(n)) out.push({ problem: `var(${n}) is not a radius token`, value });
        continue;
      }
      out.push({ problem: `${name}() is not a radius idiom`, value });
      continue;
    }
    if (KEYWORD.test(tok)) continue;
    const num = tok.match(NUMBER_UNIT);
    if (!num) { out.push({ problem: `"${tok}" is not a length or a token (computed in script? write the token)`, value }); continue; }
    const n = Number(num[1]);
    const unit = num[2].toLowerCase();
    if (n === 0 || unit === "%") continue;
    const lit = `${num[1]}${unit}`;
    if (L.onLadder.has(lit)) { out.push({ problem: `${lit} is on the ladder: write ${L.onLadder.get(lit)}`, value }); continue; }
    if (unit === "px" && n >= 100) { out.push({ problem: `${lit} is a pill: write var(--pill-radius)`, value }); continue; }
    if (OFF_LADDER[lit]) { used.add(`value:${lit}`); continue; }
    const site = sites.find((s) => s.file === ctx.file && s.value === lit && ctx.where.includes(s.where));
    if (site) { used.add(`site:${site.file}|${site.where}|${site.value}`); continue; }
    out.push({ problem: `${lit} is off the ladder and undecided: use a token, or record the decision (OFF_LADDER or AT_SITE, with its reason)`, value });
  }
  return out;
}

const DECL = /(?<![\w-])border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;{}\n"'`]*)/g;

/** The selector of the innermost block enclosing each offset of a comment-free stylesheet. */
function selectorsAt(css, offsets) {
  const want = [...new Set(offsets)].sort((a, b) => a - b);
  const out = new Map();
  const stack = [];
  let j = 0, boundary = 0;
  for (let i = 0; i < css.length; i++) {
    while (j < want.length && want[j] === i) out.set(want[j++], stack.length ? stack[stack.length - 1] : "");
    const ch = css[i];
    if (ch === "{") { stack.push(css.slice(boundary, i).replace(/\s+/g, " ").trim()); boundary = i + 1; }
    else if (ch === "}") { stack.pop(); boundary = i + 1; }
    else if (ch === ";") boundary = i + 1;
  }
  while (j < want.length) out.set(want[j++], "");
  return out;
}

/** Radius declarations in a comment-free source: [{ value, where, line }]. */
function declarations(code, kind, rawLines) {
  const found = [];
  const matches = [...code.matchAll(DECL)];
  const sel = kind === "css" ? selectorsAt(code, matches.map((m) => m.index)) : null;
  for (const m of matches) {
    const line = kind === "js" ? jsLineAt(code, m.index) : lineOf(code, m.index);
    const where = kind === "css" ? sel.get(m.index) : (rawLines[line - 1] || "");
    found.push({ value: m[1], where, line, text: m[0] });
  }
  if (kind === "js") {
    for (const m of code.matchAll(/\.borderRadius\s*=\s*([^;\n]+)/g)) {
      const line = jsLineAt(code, m.index);
      const q = m[1].trim().match(/^(['"])(.*)\1$/);
      found.push({ value: q ? q[2] : "", where: rawLines[line - 1] || "", line, text: m[0].trim() });
    }
    for (const m of code.matchAll(/setProperty\(\s*(['"])border(?:-(?:top|bottom)-(?:left|right))?-radius\1\s*,\s*([^)]*)\)/g)) {
      const line = jsLineAt(code, m.index);
      const q = m[2].trim().match(/^(['"])(.*)\1$/);
      found.push({ value: q ? q[2] : "", where: rawLines[line - 1] || "", line, text: m[0].trim() });
    }
  }
  return found;
}

function scan(rel, raw, kind, L, used, sites = AT_SITE) {
  const code = kind === "css" ? stripCss(raw) : kind === "html" ? stripHtml(raw) : jsCode(raw);
  const decls = declarations(code, kind, raw.split("\n"));
  const offenders = [];
  for (const d of decls) {
    for (const p of judge(d.value, { file: rel, where: d.where }, L, used, sites)) {
      const where = kind === "css" ? `  {${d.where.slice(0, 80)}}` : "";
      offenders.push(`${rel}:${d.line}${where}  ${d.text.trim()}  — ${p.problem}`);
    }
  }
  return { decls, offenders };
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

test("the ladder is derived from the looks' data and the hand-written :root, and the detectors catch planted literals (anti-vacuity, always on)", () => {
  const L = ladder();
  // The ladder is the data's, not a list: both looks, four rungs each, plus the two fixed radii.
  expect(Object.keys(LOOK_DATA).sort(), "the looks are found").toEqual(["ambient", "signature"]);
  for (const v of ["8px", "12px", "18px", "26px", "10px", "14px", "20px", "28px"]) {
    expect(L.onLadder.has(v), `${v} is a rung of a look`).toBe(true);
  }
  expect(L.sm, "--radius-sm is defined in the hand-written :root").toBe("4px");
  expect(L.pill, "--pill-radius is defined in the hand-written :root").toBe("999px");
  expect(L.onLadder.get("8px")).toContain("var(--r-s)");
  expect(L.onLadder.get("4px")).toBe("var(--radius-sm)");
  expect(L.onLadder.get("999px")).toBe("var(--pill-radius)");
  for (const t of ["--r-s", "--r-m", "--r-l", "--r-xl", "--radius-sm", "--pill-radius", "--radius", "--radius-md", "--radius-xl"]) {
    expect(L.tokens.has(t), `${t} is a radius token`).toBe(true);
    expect(L.defined(t), `${t} is defined in styles.css`).toBe(true);
  }
  // No recorded decision may name a value on the ladder: an on-ladder literal is never exempt.
  for (const v of [...Object.keys(OFF_LADDER), ...AT_SITE.map((s) => s.value)]) {
    expect(L.onLadder.has(v), `the decision for ${v} names a rung`).toBe(false);
  }

  const used = new Set();
  const planted = (src, kind, file = "planted") => scan(file, src, kind, L, used).offenders;
  // Positive: each on-ladder literal, in each surface, is refused.
  expect(planted(".x{border-radius:8px}", "css"), "a Signature rung in CSS").toHaveLength(1);
  expect(planted(".x{border-radius:10px}", "css"), "an Ambient rung in CSS").toHaveLength(1);
  expect(planted(".x{border-radius:999px}", "css"), "the pill literal").toHaveLength(1);
  expect(planted(".x{border-radius:9999px}", "css"), "any pill literal").toHaveLength(1);
  expect(planted(".x{border-radius:4px}", "css"), "the small fixed radius").toHaveLength(1);
  expect(planted(".x{border-radius:8px 8px 0 0}", "css"), "each literal corner of a shorthand").toHaveLength(2);
  expect(planted(".x{border-top-left-radius:12px}", "css"), "a longhand").toHaveLength(1);
  expect(planted(".x{border-radius:var(--r-s,8px)}", "css"), "a literal hidden in a var() fallback").toHaveLength(1);
  expect(planted(".x{border-radius:7px}", "css"), "an undecided off-ladder literal").toHaveLength(1);
  expect(planted(".x{border-radius:.5rem}", "css"), "a non-px length").toHaveLength(1);
  expect(planted(".x{border-radius:var(--s-2)}", "css"), "a spacing token is not a radius token").toHaveLength(1);
  expect(planted(".x{border-radius:var(--radius-lg)}", "css"), "an undefined name voids the declaration").toHaveLength(1);
  expect(planted(".x{border-radius:calc(8px + 2px)}", "css"), "an expression of literals only").toHaveLength(1);
  expect(planted("/* .x{border-radius:8px} */ .y{border-radius:var(--r-s)}", "css"), "a literal inside a CSS comment is not a declaration").toEqual([]);
  expect(planted("const s = `padding:4px;border-radius:8px;z-index:9`;", "js"), "a template-literal style string").toHaveLength(1);
  expect(planted("el.setAttribute('style','border-radius:4px');", "js"), "a quoted style string").toHaveLength(1);
  expect(planted("el.style.borderRadius = '8px';", "js"), "an element.style assignment").toHaveLength(1);
  expect(planted("el.style.borderRadius = r + 'px';", "js"), "a computed assignment cannot be judged").toHaveLength(1);
  expect(planted("el.style.setProperty('border-radius', '999px');", "js"), "a setProperty call").toHaveLength(1);
  expect(planted("x = `<i style=\"border-radius:${r}px\">`;", "js"), "a radius computed inside a template").toHaveLength(1);
  expect(planted("// border-radius:8px\n/* border-radius:4px */\nconst ok = 'border-radius:var(--pill-radius)';", "js"),
    "a literal inside a JS comment is not a declaration").toEqual([]);
  expect(planted('<span style="padding:1px 6px;border-radius:8px">x</span><!-- style="border-radius:4px" -->', "html"),
    "a literal in markup is caught; one inside an HTML comment is not").toHaveLength(1);
  // Negative controls: every accepted idiom passes.
  expect(planted(".x{border-radius:var(--r-s)}.y{border-radius:var(--pill-radius)!important}.z{border-radius:50%}" +
    ".a{border-radius:0}.b{border-radius:inherit}.c{border-radius:revert}.d{border-radius:var(--r-xl) var(--r-xl) 0 0}" +
    ".e{border-radius:calc(var(--r-s) + 2px)}.f{border-radius:2px}.g{border-radius:0 2px 2px 0}.h{border-radius:6px}" +
    ".i{border-radius:var(--radius-md)}.j{border-radius:50% / 30%}", "css"), "the idioms and the value-wide decisions pass").toEqual([]);
  expect(planted("el.style.borderRadius = 'var(--r-m)'; s = 'border-radius:50%;';", "js"), "token assignments pass").toEqual([]);
  // The two former site decisions are gone: their literals are undecided again.
  expect(planted(".ws-qr-full-code{border-radius:16px}", "css", "public/styles.css"), "the join QR plate's old literal").toHaveLength(1);
  expect(planted(".qa-keys-hint kbd{border-radius:5px}", "css", "public/styles.css"), "the keycap's old literal").toHaveLength(1);
  // A site decision holds only at its own rule (its own list: the real scan never sees it).
  const SITES = [{ file: "planted", where: ".planted-site", value: "16px", reason: "control" }];
  const siteUsed = new Set();
  const atSite = (src) => scan("planted", src, "css", L, siteUsed, SITES).offenders;
  expect(atSite(".planted-site{border-radius:16px}"), "the recorded site passes").toEqual([]);
  expect(siteUsed.has("site:planted|.planted-site|16px"), "…and is recorded as used (the stale check's input)").toBe(true);
  expect(atSite(".elsewhere{border-radius:16px}"), "the same value anywhere else is undecided").toHaveLength(1);
  expect(atSite(".planted-site{border-radius:17px}"), "another value at the site is undecided").toHaveLength(1);
  // The JS line marker reports the real line, past a comment that the stripper removes.
  const off = planted("/* one\ntwo\nthree */\nconst a = 1;\nconst s = 'border-radius:8px';", "js", "planted.js");
  expect(off, "one offender").toHaveLength(1);
  expect(off[0], "reported at its own line (5), not where stripping moved it").toMatch(/^planted\.js:5 /);
});

test("no literal corner radius on the ladder, and every other literal is a recorded decision", () => {
  const L = ladder();
  const used = new Set();
  const offenders = [];
  let cssDecls = 0, jsDecls = 0;

  const css = scan("public/styles.css", read("public/styles.css"), "css", L, used);
  offenders.push(...css.offenders);
  cssDecls = css.decls.length;

  const files = [...jsFiles(path.join(ROOT, "public", "js")),
    ...fs.readdirSync(path.join(ROOT, "public")).filter((n) => n.endsWith(".js")).map((n) => path.join(ROOT, "public", n))];
  expect(files.length, "anti-vacuity: the SPA modules are found").toBeGreaterThan(20);
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const r = scan(rel, fs.readFileSync(f, "utf8"), "js", L, used);
    offenders.push(...r.offenders);
    jsDecls += r.decls.length;
  }
  const pages = fs.readdirSync(path.join(ROOT, "public")).filter((n) => n.endsWith(".html"));
  expect(pages, "anti-vacuity: the shell markup is scanned").toContain("index.html");
  for (const n of pages) offenders.push(...scan(`public/${n}`, read(`public/${n}`), "html", L, used).offenders);

  // Anti-vacuity: the declaration pattern still matches the real syntax.
  expect(cssDecls, "the stylesheet's radius declarations are found").toBeGreaterThan(300);
  expect(jsDecls, "the scripts' inline radius declarations are found").toBeGreaterThan(20);

  expect(offenders,
    "a literal corner radius bypasses the look's ladder. Write var(--r-s|m|l|xl) by role, var(--radius-sm) or " +
    "var(--pill-radius), or record an off-ladder decision with its reason — see .claude/DESIGN_SYSTEM.md §4:\n  " +
    offenders.join("\n  ")).toEqual([]);

  // Both directions: a decision that no longer matches anything is stale.
  const stale = [
    ...Object.keys(OFF_LADDER).filter((v) => !used.has(`value:${v}`)).map((v) => `OFF_LADDER ${v}`),
    ...AT_SITE.filter((s) => !used.has(`site:${s.file}|${s.where}|${s.value}`)).map((s) => `AT_SITE ${s.file} ${s.where} ${s.value}`),
  ];
  expect(stale, "a recorded radius decision matches nothing: delete it").toEqual([]);
});
