"use strict";
// The resolved token set of every look x mode x ambient, for SOURCE scanners that
// measure colour pairs without a browser (tests/interactive-contrast.spec.js,
// the hint-heading lock in tests/layout-integrity.spec.js). It reads the SAME
// data and alias map that scripts/build-theme-tokens.js generates the CSS from,
// so a scan here measures what ships; tests/theme-tokens.spec.js holds the
// generated block to that data.
//
// Each combo: { look, theme, ambient, label, tokens } where tokens maps a custom
// property name ("--surface2", "--accent-ink", …) to its hex value. Legacy names
// resolve through LEGACY_ALIASES exactly as the stylesheet's alias rule does.
const { looks, ambients } = require("../scripts/theme/looks");
const { LEGACY_ALIASES, DEFAULT_AMBIENT, kebab } = require("../scripts/build-theme-tokens");

function resolve(mode) {
  const t = {};
  for (const [k, v] of Object.entries(mode)) if (typeof v === "string" && v.startsWith("#")) t[`--${kebab(k)}`] = v;
  // The rich-text colours, named as the generator emits them (--rt-<name>, --rt-hl-<name>).
  for (const [name, v] of Object.entries(mode.rtInk || {})) t[`--rt-${name}`] = v;
  for (const [name, v] of Object.entries(mode.rtHighlight || {})) t[`--rt-hl-${name}`] = v;
  t["--on-status"] = mode.scheme === "dark" ? mode.bg : "#ffffff";
  if (!t["--focus"]) t["--focus"] = t["--accent-ink"];
  for (const [legacy, now] of Object.entries(LEGACY_ALIASES)) if (t[`--${now}`]) t[`--${legacy}`] = t[`--${now}`];
  return t;
}

/** Every combo; `{ ambients: "default" }` keeps one ambient per ambient-lit look. */
function lookCombos({ ambients: which = "all" } = {}) {
  const out = [];
  for (const [id, look] of Object.entries(looks)) {
    for (const theme of ["light", "dark"]) {
      const base = { ...look[theme], scheme: theme };
      if (!look.ambient) { out.push({ look: id, theme, ambient: null, label: `${id}/${theme}`, tokens: resolve(base) }); continue; }
      const ids = which === "all" ? Object.keys(ambients) : [DEFAULT_AMBIENT[id]];
      for (const a of ids) {
        out.push({ look: id, theme, ambient: a, label: `${id}/${theme}/${a}`, tokens: resolve({ ...base, ...ambients[a][theme] }) });
      }
    }
  }
  return out;
}

module.exports = { lookCombos, LOOK_IDS: Object.keys(looks) };
