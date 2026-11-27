#!/usr/bin/env node
// Generates the LOOK TOKEN block of public/styles.css from scripts/theme/looks.js.
//
//   node scripts/build-theme-tokens.js          rewrite the block in place
//   node scripts/build-theme-tokens.js --check  exit 1 if the block is stale
//
// Either way it measures every text pair (WCAG 2.x relative luminance) and exits 1
// on the first failure, so a palette edit that drops a pair below AA cannot ship.
// The block lives INSIDE styles.css because that file must stay one file with no
// @import (a failed import silently voids every var()).
//
// SELECTOR CONTRACT. theme-boot.js always resolves html[data-theme] to light or
// dark and sets html[data-look] (and data-ambient when one was chosen), so no
// prefers-color-scheme variants are emitted. Any element can carry the attributes,
// which is how the look picker's mini previews nest. An element marked
// [data-stage] takes the page's look but always renders its NIGHT mode (the
// full-screen join QR). `:root` without a look falls back to Signature.
"use strict";
const fs = require("fs");
const path = require("path");
const { looks, ambients } = require("./theme/looks");

const CSS_PATH = path.join(__dirname, "..", "public", "styles.css");
const BEGIN = "/* BEGIN GENERATED LOOK TOKENS";
const END = "/* END GENERATED LOOK TOKENS */";
const DEFAULT_AMBIENT = { ambient: "ice" };
// LEGACY NAMES -> the token each one now is. Every rule written before the looks
// keeps working through these; tests/look-tokens.js resolves them the same way.
const LEGACY_ALIASES = {
  surface2: "surface-2", accent2: "accent-ink",
  green: "ok", yellow: "warn", red: "danger", easy: "ok", medium: "warn", hard: "danger",
  "badge-green-fg": "ok", "badge-yellow-fg": "warn", "badge-red-fg": "danger", "badge-draft-fg": "muted",
  // The purple pair is the BRAND violet, never the accent: an ambient accent of
  // amber or green would otherwise make late entry read as Upcoming or Live.
  "badge-purple-fg": "brand-ink", "green-soft": "ok-soft", "yellow-soft": "warn-soft", "red-soft": "danger-soft",
  "green-pill": "ok-soft", "yellow-pill": "warn-soft", "red-pill": "danger-soft", "purple-pill": "brand-soft",
  "shadow-1": "sh-1", "shadow-2": "sh-2", "shadow-3": "sh-3", shadow: "sh-1",
  // One type family for every look (Inter, see public/fonts.css): the old per-look
  // font names alias the shared tokens for one release, then go.
  "font-sans": "font-text", "font-body": "font-text", "font-label": "font-text", "font-num": "font-display",
  radius: "r-m", "radius-md": "r-s", "radius-xl": "r-l",
};

const hex2rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const parse = (c) => {
  if (c.startsWith("#")) return { rgb: hex2rgb(c), a: 1 };
  const m = c.match(/rgba?\(([^)]+)\)/)[1].split(",").map(Number);
  return { rgb: m.slice(0, 3), a: m[3] ?? 1 };
};
const lum = (rgb) => {
  const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const A = lum(a), B = lum(b); return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); };
const trip = (h) => hex2rgb(h).join(" ");
const kebab = (k) => k.replace(/([A-Z])/g, "-$1").replace(/(\d)/, "-$1").toLowerCase();

function modeVars(mode) {
  const out = [];
  const SKIP = new Set(["scheme", "shadowRgb", "glow", "rtInk", "rtHighlight"]);
  for (const [k, v] of Object.entries(mode)) if (!SKIP.has(k)) out.push(`--${kebab(k)}:${v}`);
  // The rich-text colours: a name's ink and its highlight tint (see looks.js).
  for (const [name, v] of Object.entries(mode.rtInk || {})) out.push(`--rt-${name}:${v}`);
  for (const [name, v] of Object.entries(mode.rtHighlight || {})) out.push(`--rt-hl-${name}:${v}`);
  const d = mode.scheme === "dark";
  out.push(`--glow:${mode.glow || trip(mode.accent)}`);
  // The live ink as a triplet, for a ring that fades it (the workspace's live pulse).
  out.push(`--ok-rgb:${trip(mode.ok)}`);
  out.push(`--shadow-rgb:${mode.shadowRgb}`);
  // Text that sits ON a filled status colour (a danger button, a solved pill).
  out.push(`--on-status:${d ? mode.bg : "#ffffff"}`);
  // Flat Design 3.0's three soft tiers (the values main used), in the look's shadow tint.
  out.push(`--sh-1:0 1px ${d ? 3 : 2}px rgb(${mode.shadowRgb} / ${d ? 0.12 : 0.06})`);
  out.push(`--sh-2:0 4px 12px rgb(${mode.shadowRgb} / ${d ? 0.24 : 0.08}),0 1px 2px rgb(${mode.shadowRgb} / ${d ? 0.18 : 0.06})`);
  out.push(`--sh-3:0 12px 32px rgb(${mode.shadowRgb} / ${d ? 0.4 : 0.14}),0 2px 6px rgb(${mode.shadowRgb} / ${d ? 0.22 : 0.08})`);
  out.push(`color-scheme:${mode.scheme}`);
  return out.join(";");
}
const accentOnly = (vars) => vars.split(";").filter((v) => /^--(accent|on-accent|glow|focus)/.test(v)).join(";");

// Looks differ by colour and corner radii only, never by construction or font:
// the type tokens live once, in the hand-written :root block above this one.
function common(look) {
  const s = look.shape;
  return [`--r-s:${s.rs}`, `--r-m:${s.rm}`, `--r-l:${s.rl}`, `--r-xl:${s.rxl}`, `--control-h:${s.control}`].join(";");
}

function build() {
  let css = `${BEGIN} — scripts/build-theme-tokens.js from scripts/theme/looks.js.
   Do not hand-edit: change the data and run \`npm run theme:tokens\`. */\n`;
  for (const [id, look] of Object.entries(looks)) {
    const L = `[data-look="${id}"]`;
    const sig = id === "signature";
    const amb = look.ambient ? ambients[DEFAULT_AMBIENT[id]] : null;
    const withAmb = (mode, which) => (amb ? { ...mode, ...amb[which] } : mode);
    // `focus` follows the accent ink on the ambient looks, which carry no focus key.
    const fill = (mode, which) => { const m = withAmb(mode, which); if (!m.focus) m.focus = m.accentInk; return m; };
    const light = sig ? `:root,${L}` : L;
    const dark = sig
      ? `:root:not([data-look])[data-theme="dark"],${L}[data-theme="dark"],:root:not([data-look]) [data-stage],${L} [data-stage]`
      : `${L}[data-theme="dark"],${L} [data-stage]`;
    css += `${light}{${common(look)};${modeVars(fill(look.light, "light"))}}\n`;
    css += `${dark}{${modeVars(fill(look.dark, "dark"))}}\n`;
    if (look.ambient) {
      for (const [aid, a] of Object.entries(ambients)) {
        const A = `${L}[data-ambient="${aid}"]`;
        css += `${A}:not([data-theme="dark"]){${accentOnly(modeVars({ ...look.light, ...a.light, focus: a.light.accentInk }))}}\n`;
        css += `${A}[data-theme="dark"],${A} [data-stage]{${accentOnly(modeVars({ ...look.dark, ...a.dark, focus: a.dark.accentInk }))}}\n`;
      }
    }
  }
  // LEGACY NAMES. Every rule written before the looks keeps working: each old
  // token is the new one under its old name. Declared on every element that
  // carries a look (and every stage), so a nested preview re-resolves them.
  css += `:root,[data-look],[data-stage]{${Object.entries(LEGACY_ALIASES).map(([k, v]) => `--${k}:var(--${v})`).join(";")}}\n`;
  css += END;
  return css;
}

// ---------- contrast ----------
const CHECKS = [
  ["text", "bg", 4.5], ["text", "surface", 4.5], ["text", "surface2", 4.5], ["text", "surface3", 4.5], ["text2", "surface", 4.5],
  ["muted", "bg", 4.5], ["muted", "surface", 4.5], ["muted", "surface2", 4.5], ["muted", "surface3", 4.5],
  ["accentInk", "surface", 4.5], ["accentInk", "surface2", 4.5], ["accentInk", "bg", 4.5], ["accentInk", "accentSoft", 4.5],
  ["text", "accentSoft", 4.5],
  ["brandInk", "surface", 4.5], ["brandInk", "surface2", 4.5], ["brandInk", "bg", 4.5], ["brandInk", "brandSoft", 4.5],
  ["onAccent", "accentStrong", 4.5], ["onAccent", "accentHover", 4.5], ["onGold", "goldStrong", 4.5], ["onSilver", "silverStrong", 4.5], ["onBronze", "bronzeStrong", 4.5], ["gold", "surface", 4.5],
  ["silver", "surface", 4.5], ["bronze", "surface", 4.5],
  ["ok", "surface", 4.5], ["ok", "okSoft", 4.5], ["warn", "surface", 4.5], ["warn", "warnSoft", 4.5],
  ["danger", "surface", 4.5], ["danger", "dangerSoft", 4.5], ["danger", "surface2", 4.5], ["ok", "surface2", 4.5], ["warn", "surface2", 4.5],
  ["onStatus", "ok", 4.5], ["onStatus", "warn", 4.5], ["onStatus", "danger", 4.5],
  // The bright warning fill (the Pending chip) and its label; the hover well, which
  // carries links (the Analytics rows); a medal as a graphic on your own row.
  ["onWarn", "warnStrong", 4.5], ["accentInk", "surface3", 4.5],
  ["gold", "accentSoft", 3], ["silver", "accentSoft", 3], ["bronze", "accentSoft", 3],
  ["control", "surface", 3], ["focus", "bg", 3], ["focus", "surface", 3], ["accent", "bg", 3],
];
// THE RICH-TEXT COLOURS (looks.js rtInk / rtHighlight). Rich text is drawn on the
// canvas (the participant's challenge), a card, a well (the editor, the hint and
// solution panels, a table head) and, at worst, a hover well; under a highlight sits
// body or muted text (a hint), a link, or any ink. Every such pair is held to AA.
const RICH_LAYERS = ["bg", "surface", "surface2", "surface3"];
// `data` defaults to the real palette; a spec passes a planted one to prove a pair is
// measured (tests/richtext-colours.spec.js), and `checks` a list without one row to
// prove a planted failure is that row's alone (tests/theme-tokens.spec.js).
function measure(data = { looks, ambients }, checks = CHECKS) {
  const fails = [];
  let n = 0, rich = 0;
  const run = (label, m) => {
    const mm = { ...m, onStatus: m.scheme === "dark" ? m.bg : "#ffffff" };
    const get = (k) => (mm[k] ? parse(mm[k]).rgb : null);
    for (const [a, b, need] of checks) {
      const A = get(a), B = get(b);
      // A key a look leaves out is a failure, never a skipped pair: its token would
      // not be emitted, and whatever reads it would paint nothing.
      if (!A || !B) { for (const k of [a, b]) if (!get(k)) fails.push(`${label}: ${k} missing (needed for ${a} on ${b})`); continue; }
      n++;
      const r = ratio(A, B);
      if (r < need) fails.push(`${label}: ${a} on ${b} = ${r.toFixed(2)} (need ${need})`);
    }
    const inks = mm.rtInk || {}, tints = mm.rtHighlight || {};
    const names = Object.keys(inks);
    if (!names.length) fails.push(`${label}: no rich-text colours (rtInk)`);
    if ([...names].sort().join() !== Object.keys(tints).sort().join()) fails.push(`${label}: rtInk and rtHighlight name different colours`);
    const pair = (fgName, fg, bgName, bg) => {
      n++; rich++;
      const r = fg && bg ? ratio(parse(fg).rgb, parse(bg).rgb) : 0;
      if (r < 4.5) fails.push(`${label}: ${fgName} on ${bgName} = ${r.toFixed(2)} (need 4.5)`);
    };
    for (const name of names) {
      for (const layer of RICH_LAYERS) pair(`rtInk.${name}`, inks[name], layer, mm[layer]);
      const over = [["text", mm.text], ["muted", mm.muted], ["accentInk", mm.accentInk], ...names.map((x) => [`rtInk.${x}`, inks[x]])];
      for (const [fgName, fg] of over) pair(fgName, fg, `rtHighlight.${name}`, tints[name]);
    }
  };
  for (const [id, look] of Object.entries(data.looks)) {
    for (const modeName of ["light", "dark"]) {
      const base = look[modeName];
      if (look.ambient) {
        for (const [aid, a] of Object.entries(data.ambients)) {
          const m = { ...base, ...a[modeName] };
          m.focus = m.accentInk;
          run(`${id}/${modeName}/${aid}`, m);
        }
      } else run(`${id}/${modeName}`, base);
    }
  }
  return { fails, n, rich };
}

function main() {
  const { fails, n } = measure();
  if (fails.length) { console.error(fails.join("\n")); console.error(`${fails.length} contrast failure(s)`); process.exit(1); }
  const src = fs.readFileSync(CSS_PATH, "utf8");
  const i = src.indexOf(BEGIN), j = src.indexOf(END);
  if (i < 0 || j < i) { console.error("styles.css has no generated look-token block"); process.exit(1); }
  const next = src.slice(0, i) + build() + src.slice(j + END.length);
  if (process.argv.includes("--check")) {
    if (next !== src) { console.error("the look-token block is stale: run `npm run theme:tokens`"); process.exit(1); }
    console.log(`look tokens up to date; ${n} contrast pairs pass`);
    return;
  }
  if (next !== src) fs.writeFileSync(CSS_PATH, next);
  console.log(`look tokens written; ${n} contrast pairs pass`);
}

if (require.main === module) main();
module.exports = { build, measure, CHECKS, BEGIN, END, LEGACY_ALIASES, DEFAULT_AMBIENT, kebab };
