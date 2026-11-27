// @ts-check
//
// COLOUR AND MOTION COME FROM THE TOKENS, AT THE SITES THAT HAD BYPASSED THEM.
//
// The palette is generated per look, mode and ambient colour (scripts/theme/looks.js)
// and the motion tokens are declared once; a literal written beside them ignores the
// look, or picks a duration the system never chose. Held here:
//   1. the solved and dry-run chips fill from tokens (--accent-soft, --surface-3) and
//      their labels clear AA on the fill in every look, mode and ambient colour: a
//      hex tint stayed violet whatever the accent; 1b. so do the ended chips
//      (--muted on --surface-2, a --border hairline by day), which carried a grey
//      hex tint and a literal black edge by day; 1c. so do a row menu's danger and
//      warning hover tints (--red-soft, --yellow-soft), whose labels clear AA on
//      them: by day a stale hex tint replaced them; 1d. and the locked and denied
//      status chips, whose day rules kept a stale hex label and edge; 1e. a
//      leaderboard row's medal is the look's metal ink (--gold, --silver, --bronze),
//      3:1 on the card and on your own row and told apart, the podium paints its
//      tokens, and the tier chips and Rankings discs are the strong/on pairs; 1f. the
//      Pending chip is --warn-strong with an --on-warn label; 1g. a status fill's
//      label is --on-status; 1h. a hover is the --surface-3 well; 1i. an outlined
//      filter button's edge is --border-strong; 1j. the busy overlay's words and
//      spinner are --text on the veil; 1k. the live, pulse, error and tag-× rings
//      are tokens (each of these once had a literal for one mode only); 1l. and a
//      pager's controls that do not apply (First, −10, Prev, the Go to page box
//      and Go) show a dashed --border-strong edge and --muted text on their own
//      fill at full strength, where opacity had composited their labels to 2.5:1;
//   2. the idle search glyph is solid --muted, dimmed by its colour and never by
//      opacity (at .7 it fell to 3.3:1 on the input by day); 2b. so is a menu
//      item's icon (a danger or warning item's keeps its status ink), and no svg
//      or ::before/::after in the stylesheet takes an opacity between 0 and 1;
//      2c. nor does any rule in the three stylesheets (keyframe stops aside), or
//      any style attribute in the static markup, but the OPACITY_ALLOWED entries,
//      each with its reason (a fade composites the label below AA); 2d. a disabled
//      field (any input but a checkbox or radio, a select, a textarea, the file
//      and colour inputs included) keeps its own fill with a dashed
//      --border-strong edge and a --muted value, placeholder and file button at
//      full strength (GrayText under forced colours), as do a disabled option, a
//      link-styled button and an inert chip; the global fade is left for a
//      checkbox's or radio's box and an element with no rule of its own;
//   3. an accent tint is rgb(var(--glow) / a): no literal violet outside the
//      generated block but the VIOLET_ALLOWED entries, each with its reason (the
//      role badge's colour, Signature's motif ink), and in a real page the tints
//      take the ambient colour;
//   4. every transition names its duration and its easing (left out, they are 0 s
//      and the browser's `ease`), each a motion token or a fixed timing
//      DESIGN_SYSTEM §6 names, in styles.css and in the inline styles public/js
//      writes, and the rise curve is var(--ease-rise), never written out;
//   5. no colour literal is tuned to one mode: outside the generated block, no
//      colour literal in a mode rule, no translucent white or black, no translucent
//      literal in a ring or keyframe, and no white or translucent white or black in
//      the inline styles public/js writes, but the ONE_MODE_ALLOWED entries.
// Not held: keyframe animations name their own durations (§6), and the standalone
// unsubscribe and verify sheets keep their own token copies.
const { test, expect } = require("./isolated-test");
const { BASE, appearanceSettled } = require("./helpers");
const { stripJsComments } = require("./doc-registry");
const { lookCombos } = require("./look-tokens");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
const RAW = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
// Blank comments but keep every offset and line: a comment quoting the old literal
// must not count, and positions found in CSS are positions in RAW.
const blankCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const CSS = blankCssComments(RAW);
const lineOf = (i) => RAW.slice(0, i).split("\n").length;

const rgbOf = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const parseRgb = (s) => {
  const m = String(s).match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!m) return null;
  const a = m[4] == null ? 1 : (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
  return { rgb: [+m[1], +m[2], +m[3]], a };
};
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const blend = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));

/** Paint the page as one look x mode x ambient colour, in place. */
const paint = (page, { look, theme, ambient }) => page.evaluate(([l, t, a]) => {
  const h = document.documentElement;
  h.setAttribute("data-look", l); h.setAttribute("data-theme", t);
  if (a) h.setAttribute("data-ambient", a); else h.removeAttribute("data-ambient");
}, [look, theme, ambient]);

async function signInPage(page) {
  // Reduced motion: no colour may still be mid-transition when it is read after
  // the look changes under it.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("#login-page").waitFor({ state: "attached", timeout: 20000 });
  // The app's own look read repaints <html> when it answers; painted before
  // that, a combo read the house look instead (Ice under a Cyan paint).
  await appearanceSettled(page);
}

/**
 * Plant an open row menu as the SPA draws one (`.kebab-menu.open`, a note, then a
 * plain, a warning and a danger item, each with an icon); items carry `data-k`
 * (`plain`, `km-warning`, `km-danger`).
 */
const plantKebabMenu = (page, id) => page.evaluate((menuId) => {
  const NS = "http://www.w3.org/2000/svg";
  const icon = () => {
    const s = document.createElementNS(NS, "svg");
    for (const [k, v] of [["width", "14"], ["height", "14"], ["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"]]) s.setAttribute(k, v);
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", "M4 12h16"); s.appendChild(p);
    return s;
  };
  const menu = document.createElement("div"); menu.className = "kebab-menu open"; menu.id = menuId;
  menu.style.top = "140px"; menu.style.left = "24px";
  const note = document.createElement("div"); note.className = "kebab-note";
  note.append(icon(), document.createTextNode("Some actions are withheld"));
  menu.appendChild(note);
  for (const [cls, text] of [["", "Edit"], ["km-warning", "Lock"], ["km-danger", "Delete"]]) {
    const b = document.createElement("button"); b.type = "button"; if (cls) b.className = cls;
    b.dataset.k = cls || "plain"; b.append(icon(), document.createTextNode(text));
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
}, id);

test.describe("1. the solved and dry-run chips", () => {
  test("fill from the look's tokens, and their labels clear AA on the fill, in every look, mode and ambient colour", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-chips"; box.className = "card";
      for (const [cls, text] of [["badge solved", "Solved"], ["badge draft", "test/dry run"]]) {
        const s = document.createElement("span"); s.className = cls; s.textContent = text; box.appendChild(s);
      }
      document.body.appendChild(box);
    });
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const solvedFill = {};
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate(() => {
        const cs = (sel) => getComputedStyle(document.querySelector(`#cts-chips ${sel}`));
        return { solBg: cs(".solved").backgroundColor, solFg: cs(".solved").color, drBg: cs(".draft").backgroundColor, drFg: cs(".draft").color };
      });
      const t = c.tokens, why = `${c.label}: ${JSON.stringify(r)}`;
      const sb = parseRgb(r.solBg), sf = parseRgb(r.solFg), db = parseRgb(r.drBg), df = parseRgb(r.drFg);
      if (!sb || sb.a !== 1 || String(sb.rgb) !== String(rgbOf(t["--accent-soft"]))) bad.push(`solved fill is not --accent-soft ${t["--accent-soft"]} — ${why}`);
      if (!sf || String(sf.rgb) !== String(rgbOf(t["--accent-ink"]))) bad.push(`solved label is not --accent-ink — ${why}`);
      if (!db || db.a !== 1 || String(db.rgb) !== String(rgbOf(t["--surface-3"]))) bad.push(`dry-run fill is not --surface-3 ${t["--surface-3"]} — ${why}`);
      if (!df || String(df.rgb) !== String(rgbOf(t["--muted"]))) bad.push(`dry-run label is not --muted — ${why}`);
      if (sb && sf && ratio(sf.rgb, sb.rgb) < 4.5) bad.push(`solved label ${ratio(sf.rgb, sb.rgb).toFixed(2)}:1 on its fill — ${why}`);
      if (db && df && ratio(df.rgb, db.rgb) < 4.5) bad.push(`dry-run label ${ratio(df.rgb, db.rgb).toFixed(2)}:1 on its fill — ${why}`);
      solvedFill[c.label] = r.solBg;
    }
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: the solved chip follows the ambient colour — a fixed tint would not.
    expect(solvedFill["ambient/light/amber"], "the Amber and Ice solved chips differ").not.toBe(solvedFill["ambient/light/ice"]);
    expect(solvedFill["ambient/dark/rose"], "…by night too").not.toBe(solvedFill["ambient/dark/emerald"]);
  });
});

test.describe("1b. the ended chips", () => {
  test("paint --muted on --surface-2 by day and by night, any edge a --border hairline, in every look, mode and ambient colour", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-ended"; box.className = "card";
      // The event chip (People, Challenges, the Events list's sessions) and the
      // status chip (the events page, pickers, the Events list's Status column).
      for (const [cls, text] of [["badge comp-badge comp-ended", "Spring CTF"], ["status-badge ended", "Ended"]]) {
        const s = document.createElement("span"); s.className = cls; s.textContent = text; box.appendChild(s);
      }
      document.body.appendChild(box);
    });
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const fills = {};
    let dayEdges = 0;
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate(() => {
        const out = {};
        for (const [k, sel] of [["event chip", ".comp-ended"], ["status chip", ".status-badge.ended"]]) {
          const cs = getComputedStyle(document.querySelector(`#cts-ended ${sel}`));
          out[k] = {
            bg: cs.backgroundColor, fg: cs.color, style: cs.borderTopStyle,
            widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
            colours: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
          };
        }
        return out;
      });
      const t = c.tokens;
      for (const [k, x] of Object.entries(r)) {
        const why = `${k} in ${c.label}: ${JSON.stringify(x)}`;
        const bg = parseRgb(x.bg), fg = parseRgb(x.fg);
        if (!bg || bg.a !== 1 || String(bg.rgb) !== String(rgbOf(t["--surface-2"]))) bad.push(`fill is not --surface-2 ${t["--surface-2"]} — ${why}`);
        if (!fg || String(fg.rgb) !== String(rgbOf(t["--muted"]))) bad.push(`label is not --muted ${t["--muted"]} — ${why}`);
        if (bg && fg && ratio(fg.rgb, bg.rgb) < 4.5) bad.push(`label ${ratio(fg.rgb, bg.rgb).toFixed(2)}:1 on its fill — ${why}`);
        // By day the chip keeps its 1px hairline; whatever edge it draws, in any
        // mode, is the look's --border, never a literal.
        if (c.theme === "light") {
          if (x.style !== "solid" || !x.widths.every((w) => w === "1px")) bad.push(`by day the edge is a 1px solid hairline — ${why}`);
          else dayEdges++;
        }
        x.colours.forEach((col, i) => {
          if (!(parseFloat(x.widths[i]) > 0)) return;
          const p = parseRgb(col);
          if (!p || p.a !== 1 || String(p.rgb) !== String(rgbOf(t["--border"]))) bad.push(`edge ${["top", "right", "bottom", "left"][i]} ${col} is not --border ${t["--border"]} — ${why}`);
        });
      }
      fills[c.label] = r["status chip"].bg;
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(dayEdges, "anti-vacuity: both chips drew their day edge in every day combo").toBe(2 * combos.filter((c) => c.theme === "light").length);
    // CONTROL: the fill follows the look and the mode, which one fixed tint would not.
    expect(fills["signature/light"], "Signature and Ambient fill differently by day").not.toBe(fills["ambient/light/ice"]);
    expect(fills["ambient/dark/ice"], "…and night differs from day").not.toBe(fills["ambient/light/ice"]);
  });
});

test.describe("1c. the danger and warning menu items' hover tints", () => {
  test("a hovered danger item fills --red-soft and a warning item --yellow-soft, by day and by night, and each label clears AA on its tint, in every look, mode and ambient colour", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    await plantKebabMenu(page, "cts-tint");
    const read = (k) => page.evaluate((key) => {
      const m = document.getElementById("cts-tint");
      const el = m.querySelector(`[data-k="${key}"]`), cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color, hovered: el.matches(":hover"), menuBg: getComputedStyle(m).backgroundColor };
    }, k);
    const away = () => page.mouse.move(2, 2);
    // [item, its label's ink, its hover tint]: the tokens the base rules name, by
    // their generated names (--red-soft is --danger-soft, --yellow-soft --warn-soft).
    const ITEMS = [["km-danger", "--danger", "--danger-soft"], ["km-warning", "--warn", "--warn-soft"], ["plain", "--text", "--surface-2"]];
    const bad = [];
    const tint = {};
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    for (const c of combos) {
      await paint(page, c);
      const t = c.tokens;
      tint[c.label] = {};
      for (const [k, ink, fill] of ITEMS) {
        await away();
        const rest = await read(k);
        expect(rest.hovered, `PRECONDITION: the ${k} item is not hovered at rest (${c.label})`).toBe(false);
        // CONTROL: at rest the item paints no fill, so the tint below is the hover's.
        if (rest.bg !== "rgba(0, 0, 0, 0)") bad.push(`${k} at rest paints ${rest.bg} — ${c.label}`);
        await page.locator(`#cts-tint [data-k="${k}"]`).hover();
        const h = await read(k);
        const why = `${k} hovered in ${c.label}: ${JSON.stringify(h)}`;
        expect(h.hovered, `PRECONDITION: the ${k} item matches :hover (${c.label})`).toBe(true);
        const bg = parseRgb(h.bg), fg = parseRgb(h.fg), menu = parseRgb(h.menuBg);
        // THE TOKEN: an opaque fill equal to the look's own tint, never a literal.
        if (!bg || bg.a !== 1 || String(bg.rgb) !== String(rgbOf(t[fill]))) bad.push(`the hover fill is not ${fill} ${t[fill]} — ${why}`);
        if (!fg || String(fg.rgb) !== String(rgbOf(t[ink]))) bad.push(`the label is not ${ink} ${t[ink]} — ${why}`);
        // AA on what the eye gets: the fill composited over the menu.
        if (bg && fg && menu) {
          const r = ratio(fg.rgb, blend(bg.rgb, menu.rgb, bg.a));
          if (r < 4.5) bad.push(`the label reads ${r.toFixed(2)}:1 on its hover tint — ${why}`);
        }
        tint[c.label][k] = h.bg;
      }
      await away();
    }
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: each tint follows the mode (a fixed tint would not), and the status
    // tints are not the plain hover's well.
    for (const look of ["signature", "ambient"]) {
      const day = combos.find((x) => x.look === look && x.theme === "light"), night = combos.find((x) => x.look === look && x.theme === "dark");
      for (const k of ["km-danger", "km-warning"]) {
        expect(tint[day.label][k], `${k}: ${look}'s day and night tints differ`).not.toBe(tint[night.label][k]);
        expect(tint[day.label][k], `${k}: its tint is not the plain hover's well (${look})`).not.toBe(tint[day.label].plain);
      }
    }
  });
});

test.describe("1d. the locked and denied status chips", () => {
  test("paint the look's status tokens by day as by night (locked --warn on --warn-soft; denied --danger on --danger-soft with a --danger edge), each label clearing AA, in every look, mode and ambient colour", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-status"; box.className = "card";
      for (const [cls, text] of [["status-badge locked", "Locked"], ["status-badge denied", "Denied"]]) {
        const s = document.createElement("span"); s.className = cls; s.textContent = text; box.appendChild(s);
      }
      document.body.appendChild(box);
    });
    // [chip, its label's ink, its fill, its edge (null: draws none)]
    const CHIPS = [[".locked", "--warn", "--warn-soft", null], [".denied", "--danger", "--danger-soft", "--danger"]];
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const fills = {};
    let edges = 0;
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate((sels) => Object.fromEntries(sels.map((sel) => {
        const cs = getComputedStyle(document.querySelector(`#cts-status ${sel}`));
        return [sel, { bg: cs.backgroundColor, fg: cs.color, style: cs.borderTopStyle, widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth], colours: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor] }];
      })), CHIPS.map((x) => x[0]));
      const t = c.tokens;
      fills[c.label] = {};
      for (const [sel, ink, fill, edge] of CHIPS) {
        const x = r[sel], why = `${sel} in ${c.label}: ${JSON.stringify(x)}`;
        const bg = parseRgb(x.bg), fg = parseRgb(x.fg);
        if (!bg || bg.a !== 1 || String(bg.rgb) !== String(rgbOf(t[fill]))) bad.push(`the fill is not ${fill} ${t[fill]} — ${why}`);
        if (!fg || String(fg.rgb) !== String(rgbOf(t[ink]))) bad.push(`the label is not ${ink} ${t[ink]} — ${why}`);
        if (bg && fg && ratio(fg.rgb, bg.rgb) < 4.5) bad.push(`the label reads ${ratio(fg.rgb, bg.rgb).toFixed(2)}:1 on its fill — ${why}`);
        if (edge) {
          if (x.style !== "solid" || !x.widths.every((w) => w === "1px")) bad.push(`the edge is not a 1px solid line — ${why}`);
          else edges++;
          for (const col of x.colours) {
            const p = parseRgb(col);
            if (!p || p.a !== 1 || String(p.rgb) !== String(rgbOf(t[edge]))) bad.push(`an edge ${col} is not ${edge} ${t[edge]} — ${why}`);
          }
        }
        fills[c.label][sel] = x.bg;
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(edges, "anti-vacuity: the denied chip drew its edge in every combination").toBe(combos.length);
    // CONTROL: each chip follows the mode, which one fixed colour would not.
    for (const look of ["signature", "ambient"]) {
      const day = combos.find((x) => x.look === look && x.theme === "light"), night = combos.find((x) => x.look === look && x.theme === "dark");
      for (const [sel] of CHIPS) expect(fills[day.label][sel], `${sel}: ${look}'s day and night fills differ`).not.toBe(fills[night.label][sel]);
    }
  });
});

// ── 1e-1k. colours that were tuned for one mode only ──────────────────────────
// Each site below once wrote a literal for one mode (or a night literal that was
// never right by day); it now paints a look token in both, measured here in every
// look x mode x ambient colour.
/** CIEDE2000 colour difference of two sRGB triplets. */
function deltaE2000(rgb1, rgb2) {
  const lab = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const [fx, fy, fz] = xyz.map(f);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const [L1, a1, b1] = lab(rgb1), [L2, a2, b2] = lab(rgb2);
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => { if (!b && !a) return 0; const h = Math.atan2(b, a) * deg; return h < 0 ? h + 360 : h; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2)), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}
/**
 * In the page, `window.__ctsBg(el)`: the colour an element's text is drawn on —
 * its own background and its ancestors', composited down to the first opaque one.
 */
const installBgProbe = (page) => page.evaluate(() => {
  window.__ctsBg = (el) => {
    const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let out = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop().rgb : [255, 255, 255];
    while (layers.length) { const l = layers.pop(); out = out.map((v, i) => Math.round(l.rgb[i] * l.a + v * (1 - l.a))); }
    return out;
  };
});
const sameRgb = (css, hex) => { const p = parseRgb(css); return !!p && p.a === 1 && String(p.rgb) === String(rgbOf(hex)); };
/** The day and night combo of each look, for the per-look controls. */
const dayNight = (combos) => ["signature", "ambient"].map((look) => [
  combos.find((x) => x.look === look && x.theme === "light"), combos.find((x) => x.look === look && x.theme === "dark" && x.ambient === (look === "ambient" ? combos.find((y) => y.look === look && y.theme === "light").ambient : null)),
]);

test.describe("1e. leaderboard medals, the podium and the metal fills", () => {
  test("a row's medal paints the look's metal ink by day and by night, 3:1 on the card and on your own row, the three told apart; the podium and the metal fills paint only their tokens", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    await page.evaluate(() => {
      // Rows as the board draws them (features/leaderboard.js rankIcon), into the
      // board's own table: one plain row and one of your own per place.
      const body = document.getElementById("lb-body");
      const rows = [];
      for (const r of [1, 2, 3]) for (const me of [false, true]) {
        rows.push(`<tr class="${me ? "me" : ""}" data-cts="${r}${me ? "m" : ""}"><td><span class="lb-rank">${window.medalTinted(r, { showOrdinal: true })}</span></td><td>name</td></tr>`);
      }
      body.innerHTML = rows.join("");
      // The podium, as the board draws it, into its own row.
      document.getElementById("podium-row").innerHTML = [2, 1, 3].map((r) => `<div class="podium-slot ps${r}"><div class="podium-num m${r}">${window.medalTinted(r)}</div><div class="podium-block p${r}" aria-hidden="true"><span class="podium-roman">I</span></div></div>`).join("");
      // The metal fills: the certificate tier chips and the Rankings top-three discs.
      const box = document.createElement("div"); box.id = "cts-metal"; box.className = "card";
      box.innerHTML = ["gold", "silver", "bronze"].map((m) => `<span class="ic-tier ic-tier-${m}">${m}</span><span class="rk-cert-medal rk-cert-${m}">1</span>`).join("");
      document.body.appendChild(box);
    });
    await installBgProbe(page);
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const METAL = { 1: "--gold", 2: "--silver", 3: "--bronze" };
    const bad = [];
    const ink = {};
    let measured = 0;
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate(() => {
        const out = { rows: {}, podium: {}, metal: {} };
        for (const tr of document.querySelectorAll("#lb-body tr[data-cts]")) {
          const m = tr.querySelector(".medal");
          out.rows[tr.dataset.cts] = { cls: m.className, color: getComputedStyle(m).color, text: getComputedStyle(tr.querySelector("td")).color, under: window.__ctsBg(m), td: getComputedStyle(tr.querySelector("td")).backgroundColor };
        }
        for (const b of document.querySelectorAll("#podium-row .podium-block")) {
          const cs = getComputedStyle(b);
          out.podium[b.className] = { bg: cs.backgroundColor, top: cs.borderTopColor, height: parseFloat(cs.height) };
        }
        for (const el of document.querySelectorAll("#cts-metal > span")) out.metal[el.className] = { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color };
        return out;
      });
      const t = c.tokens;
      ink[c.label] = {};
      for (const [key, x] of Object.entries(r.rows)) {
        const place = +key[0], mine = key.endsWith("m"), want = METAL[place];
        const why = `place ${place}${mine ? " (your row)" : ""} in ${c.label}: ${JSON.stringify(x)}`;
        if (mine && !sameRgb(x.td, t["--accent-soft"])) bad.push(`PRECONDITION: your row's cell is --accent-soft — ${why}`);
        const got = parseRgb(x.color);
        if (!sameRgb(x.color, t[want])) bad.push(`medal is not ${want} ${t[want]} — ${why}`);
        if (got && ratio(got.rgb, x.under) < 3) bad.push(`medal ${ratio(got.rgb, x.under).toFixed(2)}:1 on ${x.under} — ${why}`);
        if (x.color === x.text) bad.push(`medal is the row's text colour (an inherited ink) — ${why}`);
        else measured++;
        if (!mine) ink[c.label][place] = got ? got.rgb : null;
      }
      const [g, s, b] = [1, 2, 3].map((p) => ink[c.label][p]);
      if (g && s && b) for (const [n, x, y] of [["gold-silver", g, s], ["gold-bronze", g, b], ["silver-bronze", s, b]]) {
        const d = deltaE2000(x, y);
        if (d < 10) bad.push(`${n} medals ΔE2000 ${d.toFixed(2)} (< 10) in ${c.label}`);
      }
      const heights = [];
      for (const p of [1, 2, 3]) {
        const x = r.podium[`podium-block p${p}`], why = `podium p${p} in ${c.label}: ${JSON.stringify(x)}`;
        if (!x) { bad.push(`no podium block p${p} — ${c.label}`); continue; }
        if (!sameRgb(x.bg, t["--surface-2"])) bad.push(`podium block is not --surface-2 ${t["--surface-2"]} — ${why}`);
        if (p === 1 && !sameRgb(x.top, t["--gold-deco"])) bad.push(`first place's top edge is not --gold-deco ${t["--gold-deco"]} — ${why}`);
        heights.push(x.height);
      }
      if (!(heights[0] > heights[1] && heights[1] > heights[2])) bad.push(`the podium steps down 1 > 2 > 3 (the cue that is not colour): ${heights} — ${c.label}`);
      for (const m of ["gold", "silver", "bronze"]) {
        for (const cls of [`ic-tier ic-tier-${m}`, `rk-cert-medal rk-cert-${m}`]) {
          const x = r.metal[cls], why = `${cls} in ${c.label}: ${JSON.stringify(x)}`;
          if (!sameRgb(x.bg, t[`--${m}-strong`])) bad.push(`fill is not --${m}-strong — ${why}`);
          if (!sameRgb(x.fg, t[`--on-${m}`])) bad.push(`label is not --on-${m} — ${why}`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(measured, "anti-vacuity: every medal in every combination was measured").toBe(6 * combos.length);
    // CONTROL: the ink follows the mode, which one literal would not.
    for (const [day, night] of dayNight(combos)) expect(String(ink[day.label][1]), `${day.look}'s day and night gold differ`).not.toBe(String(ink[night.label][1]));
  });
});

test.describe("1f. the Pending chip", () => {
  test("fills --warn-strong with an --on-warn label by day and by night, at AA, apart from the soft warning chip", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-pending"; box.className = "card";
      box.innerHTML = '<span class="status-badge pending">Pending</span><span class="status-badge unconfirmed">Unverified</span>';
      document.body.appendChild(box);
    });
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const fill = {};
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate(() => {
        const cs = (s) => getComputedStyle(document.querySelector(`#cts-pending ${s}`));
        return { bg: cs(".pending").backgroundColor, fg: cs(".pending").color, softBg: cs(".unconfirmed").backgroundColor };
      });
      const t = c.tokens, why = `${c.label}: ${JSON.stringify(r)}`;
      const bg = parseRgb(r.bg), fg = parseRgb(r.fg);
      if (!sameRgb(r.bg, t["--warn-strong"])) bad.push(`fill is not --warn-strong ${t["--warn-strong"]} — ${why}`);
      if (!sameRgb(r.fg, t["--on-warn"])) bad.push(`label is not --on-warn ${t["--on-warn"]} — ${why}`);
      if (bg && fg && ratio(fg.rgb, bg.rgb) < 4.5) bad.push(`label ${ratio(fg.rgb, bg.rgb).toFixed(2)}:1 on its fill — ${why}`);
      // CONTROL: the soft warning chip beside it still fills --warn-soft.
      if (!sameRgb(r.softBg, t["--warn-soft"])) bad.push(`CONTROL: the unconfirmed chip is not --warn-soft — ${why}`);
      if (r.bg === r.softBg) bad.push(`the Pending fill is the soft chip's — ${why}`);
      fill[c.label] = r.bg;
    }
    expect(bad, bad.join("\n")).toEqual([]);
    for (const [day, night] of dayNight(combos)) expect(fill[day.label], `${day.look}'s day and night fills differ`).not.toBe(fill[night.label]);
  });
});

test.describe("1g. status-filled chips", () => {
  test("the exclude pill and the active difficulty chips label their status fill with --on-status, at AA, by day and by night", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-onstatus"; box.className = "card";
      box.innerHTML = '<span class="tag-pill-exclude" data-k="exclude">web</span>'
        + ["easy", "medium", "hard"].map((d) => `<button type="button" class="chip chip-active chip-${d}" data-k="${d}">${d}</button>`).join("");
      document.body.appendChild(box);
    });
    const FILL = { exclude: "--danger", easy: "--ok", medium: "--warn", hard: "--danger" };
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const label = {};
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#cts-onstatus [data-k]")].map((el) => [el.dataset.k, { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }])));
      const t = c.tokens;
      for (const [k, want] of Object.entries(FILL)) {
        const x = r[k], why = `${k} in ${c.label}: ${JSON.stringify(x)}`;
        if (!sameRgb(x.bg, t[want])) bad.push(`fill is not ${want} — ${why}`);
        if (!sameRgb(x.fg, t["--on-status"])) bad.push(`label is not --on-status ${t["--on-status"]} — ${why}`);
        const bg = parseRgb(x.bg), fg = parseRgb(x.fg);
        if (bg && fg && ratio(fg.rgb, bg.rgb) < 4.5) bad.push(`label ${ratio(fg.rgb, bg.rgb).toFixed(2)}:1 on its fill — ${why}`);
      }
      label[c.label] = r.medium.fg;
    }
    expect(bad, bad.join("\n")).toEqual([]);
    for (const [day, night] of dayNight(combos)) expect(label[day.label], `${day.look}'s day and night labels differ`).not.toBe(label[night.label]);
  });
});

test.describe("1h. hover wells", () => {
  test("a hovered toolbar button, menu item, picker, code-language item and Analytics row fill --surface-3 by day and by night, visibly apart from their resting fill, and their text reads on it", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-hover"; box.className = "card";
      box.style.cssText = "position:fixed;top:80px;left:16px;z-index:5000;display:grid;gap:8px;width:360px";
      box.innerHTML = '<div class="rich-editor"><div class="rich-toolbar"><button type="button" data-k="toolbar">B</button></div></div>'
        + '<div class="drop-pop" style="position:static;display:block"><div data-k="drop">Heading 2</div></div>'
        + '<button type="button" class="picker-btn" data-k="pickbtn"><span class="picker-btn-name">Choose</span></button>'
        + '<button type="button" class="picker-card" data-k="pickcard">An event</button>'
        + '<pre><code id="cts-code">x</code></pre>';
      document.body.appendChild(box);
      // The real code-language menu, opened as a right-click on a code block opens it.
      window.showCodeLangMenu({ preventDefault() {}, clientX: 420, clientY: 90 }, document.getElementById("cts-code"));
      document.querySelector('.code-lang-menu [role="menuitem"]').dataset.k = "codelang";
      // A row of the real Analytics table (the pane is hidden: it is hovered below
      // through the browser's own :hover state, which needs no box).
      const tr = document.createElement("tr"); tr.dataset.k = "analytics";
      tr.innerHTML = "<td>Challenge</td><td>3</td>";
      document.querySelector("#analytics-table tbody").appendChild(tr);
    });
    expect(await page.locator('.code-lang-menu [role="menuitem"]').count(), "PRECONDITION: the real code-language menu is open").toBeGreaterThan(1);
    await installBgProbe(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId: rowNode } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '#analytics-table tbody tr[data-k="analytics"]' });
    expect(rowNode, "PRECONDITION: the Analytics row is found").toBeGreaterThan(0);
    const KEYS = ["toolbar", "drop", "pickbtn", "pickcard", "codelang", "analytics"];
    const read = (k) => page.evaluate((key) => {
      const el = document.querySelector(`[data-k="${key}"]`), cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color, under: window.__ctsBg(el), hovered: el.matches(":hover") };
    }, k);
    const away = () => page.mouse.move(2, 2);
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const well = {};
    let hovered = 0;
    for (const c of combos) {
      await paint(page, c);
      const t = c.tokens;
      for (const k of KEYS) {
        await away();
        const rest = await read(k);
        if (rest.hovered) bad.push(`PRECONDITION: ${k} is not hovered at rest — ${c.label}`);
        if (k === "analytics") await cdp.send("CSS.forcePseudoState", { nodeId: rowNode, forcedPseudoClasses: ["hover"] });
        else await page.locator(`[data-k="${k}"]`).hover();
        const h = await read(k);
        if (k === "analytics") await cdp.send("CSS.forcePseudoState", { nodeId: rowNode, forcedPseudoClasses: [] });
        const why = `${k} in ${c.label}: rest ${JSON.stringify(rest)}, hovered ${JSON.stringify(h)}`;
        if (!h.hovered) { bad.push(`PRECONDITION: ${k} matches :hover — ${why}`); continue; }
        hovered++;
        // CONTROL: at rest the item is not already the well, so the hover is a change.
        if (sameRgb(rest.bg, t["--surface-3"])) bad.push(`${k} already paints --surface-3 at rest — ${why}`);
        if (!sameRgb(h.bg, t["--surface-3"])) bad.push(`${k} hovered is not --surface-3 ${t["--surface-3"]} — ${why}`);
        const fg = parseRgb(h.fg), hb = parseRgb(h.bg);
        if (fg && hb && ratio(fg.rgb, hb.rgb) < 4.5) bad.push(`${k}'s text ${ratio(fg.rgb, hb.rgb).toFixed(2)}:1 on the hover well — ${why}`);
        if (hb) { const d = deltaE2000(hb.rgb, rest.under); if (d < 1.8) bad.push(`${k}'s hover is ΔE2000 ${d.toFixed(2)} from its resting fill (< 1.8) — ${why}`); }
        if (k === "toolbar") well[c.label] = h.bg;
      }
    }
    await away();
    await page.evaluate(() => document.querySelectorAll(".code-lang-menu").forEach((m) => m.remove()));
    expect(bad, bad.join("\n")).toEqual([]);
    expect(hovered, "anti-vacuity: every item was hovered in every combination").toBe(KEYS.length * combos.length);
    for (const [day, night] of dayNight(combos)) expect(well[day.label], `${day.look}'s day and night wells differ`).not.toBe(well[night.label]);
  });
});

test.describe("1i. filter buttons", () => {
  test("an outlined filter button draws a --border-strong edge by day and by night; a chosen one its --accent-strong fill's edge", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-edges"; box.className = "card";
      box.innerHTML = '<button type="button" class="filter-btn" data-k="off">All</button><button type="button" class="filter-btn active" data-k="on">Live</button>';
      document.body.appendChild(box);
    });
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const edge = {};
    for (const c of combos) {
      await paint(page, c);
      const r = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#cts-edges [data-k]")].map((el) => {
        const cs = getComputedStyle(el);
        return [el.dataset.k, { colours: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor], width: cs.borderTopWidth }];
      })));
      const t = c.tokens;
      for (const [k, want] of [["off", "--border-strong"], ["on", "--accent-strong"]]) {
        const x = r[k], why = `${k} in ${c.label}: ${JSON.stringify(x)}`;
        if (x.width !== "1px") bad.push(`PRECONDITION: a 1px edge — ${why}`);
        x.colours.forEach((col, i) => { if (!sameRgb(col, t[want])) bad.push(`${["top", "right", "bottom", "left"][i]} edge is not ${want} ${t[want]} — ${why}`); });
      }
      edge[c.label] = r.off.colours[0];
    }
    expect(bad, bad.join("\n")).toEqual([]);
    for (const [day, night] of dayNight(combos)) expect(edge[day.label], `${day.look}'s day and night edges differ`).not.toBe(edge[night.label]);
  });
});

test.describe("1j. the busy overlay", () => {
  test("Sending invitations: the words and the spinner's arc read on the veil by day and by night", async ({ page }) => {
    const { loginViaApi } = require("./ui-admin-helpers");
    const { getSuperadminPass } = require("./helpers");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginViaApi(page, "superadmin", getSuperadminPass());
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await appearanceSettled(page);
    // The invitation is held, then answered here — never sent on to the server.
    let release, sent = 0;
    const held = new Promise((r) => { release = r; });
    await page.route("**/api/admin/invitations", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent++;
      await held;
      await route.abort();
    });
    try {
      await page.evaluate(() => window.openInviteDialog());
      const overlay = page.locator("#invite-overlay");
      await expect(overlay).toBeVisible({ timeout: 15000 });
      await overlay.locator("#invite-emails").fill("cts-busy-veil@acme.com");
      await overlay.locator("#invite-submit-btn").click();
      const blocker = overlay.locator("#invite-blocker");
      await expect(blocker, "PRECONDITION: the blocker is up while the request is held").toBeVisible({ timeout: 10000 });
      await expect.poll(() => sent, { message: "PRECONDITION: the held request was sent" }).toBe(1);
      expect((await blocker.boundingBox()).height, "the blocker has a box").toBeGreaterThan(20);
      const combos = lookCombos();
      expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
      const bad = [];
      const label = {};
      for (const c of combos) {
        await paint(page, c);
        const r = await page.evaluate(() => {
          const b = document.getElementById("invite-blocker"), cs = (s) => getComputedStyle(b.querySelector(s));
          return { veil: getComputedStyle(b).backgroundColor, card: getComputedStyle(b.closest(".invite-card")).backgroundColor,
            label: cs(".invite-blocker-label").color, sub: cs(".invite-blocker-sub").color, arc: cs(".spinner").borderTopColor };
        });
        const t = c.tokens, why = `${c.label}: ${JSON.stringify(r)}`;
        const veil = parseRgb(r.veil), card = parseRgb(r.card);
        if (!veil || !(veil.a > 0 && veil.a < 1)) { bad.push(`PRECONDITION: the veil is translucent — ${why}`); continue; }
        if (!card || card.a !== 1) { bad.push(`PRECONDITION: the card is opaque — ${why}`); continue; }
        const under = blend(veil.rgb, card.rgb, veil.a);
        for (const [k, need] of [["label", 4.5], ["sub", 4.5], ["arc", 3]]) {
          if (!sameRgb(r[k], t["--text"])) bad.push(`${k} is not --text ${t["--text"]} — ${why}`);
          const p = parseRgb(r[k]);
          if (p && ratio(p.rgb, under) < need) bad.push(`${k} ${ratio(p.rgb, under).toFixed(2)}:1 on the veil (need ${need}) — ${why}`);
        }
        label[c.label] = r.label;
      }
      expect(bad, bad.join("\n")).toEqual([]);
      for (const [day, night] of dayNight(combos)) expect(label[day.label], `${day.look}'s day and night words differ`).not.toBe(label[night.label]);
    } finally {
      release();
    }
    await expect(page.locator("#invite-blocker"), "the answered request takes the blocker down").toHaveCount(0, { timeout: 15000 });
    await page.unroute("**/api/admin/invitations");
  });
});

test.describe("1k. rings", () => {
  test("the live dot's ring (seen apart from its chip), the live pulse, the error rings and a tag's × hover ring are drawn from the look's tokens, by day and by night", async ({ page }) => {
    await signInPage(page);
    // The pulse is an animation: read its first keyframe, so motion stays on here.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      const box = document.createElement("div"); box.id = "cts-rings"; box.className = "card";
      box.style.cssText = "position:fixed;top:80px;left:16px;z-index:5000";
      box.innerHTML = '<span class="status-badge live"><span class="live-dot" data-k="livedot"></span>Live</span>'
        + '<span class="ws-dot live ws-dot-live" data-k="pulse"></span>'
        + '<input class="error" data-k="error" aria-label="probe">'
        + '<div class="form-group field-error"><input data-k="fielderror" aria-label="probe 2"></div>'
        + '<span class="tag">web<span class="tag-x" data-k="tagx">×</span></span>';
      document.body.appendChild(box);
    });
    const read = () => page.evaluate(() => {
      const el = (k) => document.querySelector(`#cts-rings [data-k="${k}"]`);
      // Settle every transition; hold the pulse at its first keyframe.
      for (const a of document.getElementById("cts-rings").getAnimations({ subtree: true })) {
        if (a.animationName === "ws-pulse") { a.pause(); a.currentTime = 0; } else if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish();
      }
      const ring = (k) => getComputedStyle(el(k)).boxShadow;
      return { livedot: ring("livedot"), liveChip: getComputedStyle(el("livedot").parentElement).backgroundColor, pulse: ring("pulse"), pulseAnim: getComputedStyle(el("pulse")).animationName,
        error: ring("error"), fielderror: ring("fielderror"), tagx: ring("tagx"), tagInk: getComputedStyle(el("tagx")).color, tagHovered: el("tagx").matches(":hover") };
    });
    const colourOf = (shadow) => parseRgb(shadow);
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const pulse = {};
    for (const c of combos) {
      await paint(page, c);
      await page.mouse.move(2, 2);
      const r = await read();
      const t = c.tokens, why = `${c.label}: ${JSON.stringify(r)}`;
      if (r.pulseAnim !== "ws-pulse") bad.push(`PRECONDITION: the live dot pulses — ${why}`);
      for (const [k, want] of [["error", "--danger-soft"], ["fielderror", "--danger-soft"]]) {
        const p = colourOf(r[k]);
        if (!p || p.a !== 1 || String(p.rgb) !== String(rgbOf(t[want]))) bad.push(`${k} ring is not ${want} ${t[want]} — ${why}`);
      }
      // The live dot sits on a chip filled with --ok-soft, so its ring is the live
      // ink at .2 over that fill, and must read apart from it (a ring in the chip's
      // own colour cannot be seen).
      const ld = colourOf(r.livedot), chip = parseRgb(r.liveChip);
      if (!ld || String(ld.rgb) !== String(rgbOf(t["--ok"])) || Math.abs(ld.a - 0.2) > 0.01) bad.push(`the live dot's ring is not --ok ${t["--ok"]} / .2 — ${why}`);
      else if (!chip || chip.a !== 1) bad.push(`PRECONDITION: the live chip has an opaque fill — ${why}`);
      else { const d = deltaE2000(blend(ld.rgb, chip.rgb, ld.a), chip.rgb); if (d < 5) bad.push(`the live dot's ring is ΔE2000 ${d.toFixed(2)} from its chip's fill (< 5): it cannot be seen — ${why}`); }
      const p = colourOf(r.pulse);
      if (!p || String(p.rgb) !== String(rgbOf(t["--ok"])) || Math.abs(p.a - 0.45) > 0.01) bad.push(`the live pulse starts at --ok ${t["--ok"]} / .45 — ${why}`);
      pulse[c.label] = r.pulse;
      // At rest the × draws no ring; hovered, a 1px inset ring in the chip's own ink.
      if (r.tagx !== "none") bad.push(`the tag's × draws a ring at rest — ${why}`);
      await page.locator('#cts-rings [data-k="tagx"]').hover();
      const h = await read();
      const hw = `${c.label} hovered: ${JSON.stringify(h)}`;
      if (!h.tagHovered) { bad.push(`PRECONDITION: the × is hovered — ${hw}`); continue; }
      const ring = colourOf(h.tagx);
      if (!ring || !/inset/.test(h.tagx) || h.tagx.indexOf(h.tagInk) !== 0 || !sameRgb(h.tagInk, t["--on-accent"])) bad.push(`the hovered × is not an inset ring in the chip's ink --on-accent ${t["--on-accent"]} — ${hw}`);
    }
    await page.mouse.move(2, 2);
    expect(bad, bad.join("\n")).toEqual([]);
    for (const [day, night] of dayNight(combos)) expect(pulse[day.label], `${day.look}'s day and night pulse differ`).not.toBe(pulse[night.label]);
  });
});

// ── 1l. a pager's controls that do not apply ─────────────────────────────────
test.describe("1l. a pager's controls that do not apply", () => {
  test("First, −10, Prev, the Go to page box and Go show a dashed --border-strong edge and --muted text at full strength, clearing AA on their own fill, in every look, mode and ambient colour", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    // The Raw logs pager as index.html mounts it (#audit-pagination), ids renamed:
    // the bar written by the real paginationHtml (with −10/+10), the page box
    // inside the same .pagination, then the real syncPageJump closes the box.
    await page.evaluate(() => {
      const el = (tag, props = {}, attrs = {}) => { const n = Object.assign(document.createElement(tag), props); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
      const wrap = el("div", { id: "cts-pager", className: "pagination" });
      const bar = el("span", { id: "cts-pager-bar", className: "pagination-bar" });
      window.setSafeHtml(bar, window.paginationHtml("cts", { page: 1, totalPages: 3, totalLabel: "60 total", pageSize: 20, jump10: true }));
      const jump = el("span", { id: "cts-jump", className: "page-jump", hidden: true });
      jump.append(el("label", { htmlFor: "cts-input", textContent: "Go to page" }),
        el("input", { id: "cts-input", type: "text" }, { inputmode: "numeric", autocomplete: "off", "aria-describedby": "cts-note" }),
        el("button", { textContent: "Go" }, { "data-action": "cts-go" }),
        el("span", { id: "cts-note", className: "page-jump-note" }));
      wrap.append(bar, jump);
      document.body.appendChild(wrap);
      window.syncPageJump({ jump: "cts-jump", input: "cts-input", note: "cts-note" }, false, "Go to page needs the exact total");
    });
    const SEL = {
      first: '[data-action="cts-page-first"]', back10: '[data-action="cts-page-back10"]', prev: '[data-action="cts-page-prev"]',
      input: "#cts-input", go: '[data-action="cts-go"]',
      next: '[data-action="cts-page-next"]', fwd10: '[data-action="cts-page-fwd10"]', last: '[data-action="cts-page-last"]',
    };
    const OFF = ["first", "back10", "prev", "input", "go"], ON = ["next", "fwd10", "last"];
    const read = () => page.evaluate((sel) => Object.fromEntries(Object.entries(sel).map(([k, s]) => {
      const n = document.querySelector(`#cts-pager ${s}`), cs = getComputedStyle(n);
      let op = 1;
      for (let e = n; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
      return [k, {
        disabled: n.disabled, op, fg: cs.color, bg: cs.backgroundColor,
        styles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
        colours: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
        widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      }];
    })), SEL);
    // PRECONDITION: page 1 of 3 with the box closed — the five are disabled, the three are not.
    const pre = await read();
    for (const k of OFF) expect(pre[k].disabled, `PRECONDITION: ${k} is disabled on page 1 with the box closed`).toBe(true);
    for (const k of ON) expect(pre[k].disabled, `PRECONDITION: ${k} applies on page 1 of 3`).toBe(false);
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    let measured = 0;
    const edgeIs = (x, style, token, t, why) => {
      if (!x.styles.every((s) => s === style)) bad.push(`the edge is not ${style} on all four sides — ${why}`);
      // A 0-width edge still computes its style and colour: it must be drawn.
      if (!x.widths.every((w) => parseFloat(w) >= 1)) bad.push(`the edge is not drawn on all four sides (widths ${x.widths}) — ${why}`);
      x.colours.forEach((col, i) => {
        const p = parseRgb(col);
        if (!p || p.a !== 1 || String(p.rgb) !== String(rgbOf(t[token]))) bad.push(`edge ${["top", "right", "bottom", "left"][i]} ${col} is not ${token} ${t[token]} — ${why}`);
      });
    };
    for (const c of combos) {
      await paint(page, c);
      const r = await read(), t = c.tokens;
      // A page button keeps its own fill (--surface by day, --surface2 by night); the box is an input (--surface).
      const fillOf = (k) => (k === "input" || c.theme === "light" ? "--surface" : "--surface2");
      for (const k of OFF) {
        const x = r[k], why = `${k} in ${c.label}: ${JSON.stringify(x)}`;
        const fg = parseRgb(x.fg), bg = parseRgb(x.bg);
        if (x.op !== 1) bad.push(`it is faded (opacity ${x.op}) — ${why}`);
        if (!fg || fg.a !== 1 || String(fg.rgb) !== String(rgbOf(t["--muted"]))) bad.push(`the label is not --muted ${t["--muted"]} — ${why}`);
        if (!bg || bg.a !== 1 || String(bg.rgb) !== String(rgbOf(t[fillOf(k)]))) bad.push(`the fill is not ${fillOf(k)} ${t[fillOf(k)]} — ${why}`);
        if (fg && bg && ratio(fg.rgb, bg.rgb) < 4.5) bad.push(`the label reads ${ratio(fg.rgb, bg.rgb).toFixed(2)}:1 on its fill — ${why}`);
        edgeIs(x, "dashed", "--border-strong", t, why);
        measured++;
      }
      // CONTROL, same paint: a page button that applies has a solid --border-strong
      // edge (the same by day and by night) and --text, at full strength.
      for (const k of ON) {
        const x = r[k], why = `${k} in ${c.label}: ${JSON.stringify(x)}`;
        const fg = parseRgb(x.fg);
        if (x.op !== 1) bad.push(`an enabled control is faded (opacity ${x.op}) — ${why}`);
        if (!fg || String(fg.rgb) !== String(rgbOf(t["--text"]))) bad.push(`an enabled label is not --text ${t["--text"]} — ${why}`);
        edgeIs(x, "solid", "--border-strong", t, why);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(measured, "anti-vacuity: five disabled controls measured in every combination").toBe(5 * combos.length);
    // CONTROL: the box opened takes back its own edge (--control) and --text, and Go its solid one.
    await page.evaluate(() => window.syncPageJump({ jump: "cts-jump", input: "cts-input", note: "cts-note" }, true));
    for (const c of combos.filter((x) => x.ambient === null || x.ambient === "ice")) {
      await paint(page, c);
      const r = await read(), t = c.tokens;
      expect(r.input.disabled || r.go.disabled, `PRECONDITION: the box and Go apply once opened (${c.label})`).toBe(false);
      const why = (k) => `${k} opened in ${c.label}: ${JSON.stringify(r[k])}`;
      edgeIs(r.input, "solid", "--control", t, why("input"));
      edgeIs(r.go, "solid", "--border-strong", t, why("go"));
      for (const k of ["input", "go"]) {
        const fg = parseRgb(r[k].fg);
        if (!fg || String(fg.rgb) !== String(rgbOf(t["--text"]))) bad.push(`the opened ${k} is not --text — ${why(k)}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

test.describe("2. the search glyph", () => {
  test("idles as solid --muted, never dimmed by opacity, and turns to the accent ink when the box holds text", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const w = document.createElement("div"); w.className = "search-wrap"; w.id = "cts-search";
      const i = document.createElement("input"); i.setAttribute("aria-label", "probe");
      w.appendChild(i); document.body.appendChild(w);
    });
    const read = () => page.evaluate(() => {
      const w = document.getElementById("cts-search"), g = getComputedStyle(w, "::before");
      return { opacity: g.opacity, color: g.color, content: g.content, bg: getComputedStyle(w.querySelector("input")).backgroundColor };
    });
    const bad = [];
    let seen = 0;
    for (const c of lookCombos()) {
      await paint(page, c);
      await page.evaluate(() => document.getElementById("cts-search").classList.remove("has-value"));
      const idle = await read();
      const why = `${c.label}: ${JSON.stringify(idle)}`;
      expect(idle.content, `anti-vacuity: the glyph is drawn (${c.label})`).not.toBe("none");
      seen++;
      const col = parseRgb(idle.color), bg = parseRgb(idle.bg);
      if (idle.opacity !== "1") bad.push(`idle glyph opacity ${idle.opacity} — ${why}`);
      if (!col || String(col.rgb) !== String(rgbOf(c.tokens["--muted"]))) bad.push(`idle glyph is not --muted ${c.tokens["--muted"]} — ${why}`);
      // What the eye gets: the glyph composited at its opacity over the input.
      if (col && bg) {
        const eff = blend(col.rgb, bg.rgb, parseFloat(idle.opacity) * col.a);
        const r = ratio(eff, bg.rgb);
        if (r < 4.5) bad.push(`idle glyph reads ${r.toFixed(2)}:1 on the input — ${why}`);
      }
      await page.evaluate(() => document.getElementById("cts-search").classList.add("has-value"));
      const on = await read();
      const oc = parseRgb(on.color);
      if (on.opacity !== "1" || !oc || String(oc.rgb) !== String(rgbOf(c.tokens["--accent-ink"]))) bad.push(`filled glyph is not the accent ink at full strength — ${c.label}: ${JSON.stringify(on)}`);
    }
    expect(seen, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

// ── 2b. glyphs are dimmed by colour ──────────────────────────────────────────
// A glyph rule: one whose selector reaches an svg (the svg itself or anything in
// it; `:has(svg)` is the element holding it, not the glyph) or a ::before/::after,
// the two ways this stylesheet draws an icon.
const GLYPH_SELECTOR = (part) => /(^|[\s>+~])svg\b/i.test(part) || /::?(before|after)\s*$/i.test(part);
/** [{at, sel, value}] for every glyph rule in `src`, with its opacity declarations. */
function glyphRules(src) {
  const out = [];
  for (const m of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (!sel.split(/,(?![^(]*\))/).some((p) => GLYPH_SELECTOR(p.trim()))) continue;
    const values = [...m[2].matchAll(/(?:^|;)\s*opacity\s*:\s*([^;]+)/g)].map((d) => d[1].replace(/!important/, "").trim());
    out.push({ at: m.index + (m[1].length - m[1].trimStart().length), sel, values });
  }
  return out;
}
/** The glyph rules that take an opacity strictly between 0 and 1 (or one this cannot read). */
function glyphOpacities(src) {
  const out = [];
  for (const r of glyphRules(src)) {
    for (const v of r.values) {
      const n = /^[\d.]+%$/.test(v) ? parseFloat(v) / 100 : /^[\d.]+$/.test(v) ? parseFloat(v) : NaN;
      if (n === 0 || n === 1) continue;
      out.push({ ...r, value: v });
    }
  }
  return out;
}
// Each glyph allowed an opacity between 0 and 1, keyed by its selector, with the
// reason it is not a dimmed glyph (checked both ways). None today.
const GLYPH_OPACITY_ALLOWED = new Map();

test.describe("2b. glyphs are dimmed by colour", () => {
  test("no svg and no ::before or ::after in the stylesheet takes an opacity between 0 and 1", () => {
    // The detector, on planted text first (anti-vacuity).
    expect(glyphOpacities(".a button svg{flex-shrink:0;opacity:.7}"), "a dimmed icon").toHaveLength(1);
    expect(glyphOpacities(".w::before{content:\"\";opacity:0.7}.b:hover svg path{opacity:40%}.c::after{opacity:var(--o)}"), "a pseudo glyph, a path in an svg, an unreadable value").toHaveLength(3);
    expect(glyphOpacities(".a svg{opacity:1}.b::after{opacity:0}.c{opacity:.5}.d:has(svg){opacity:.5}.e:hover svg{color:inherit}"), "full, hidden, not a glyph").toEqual([]);
    const rules = glyphRules(CSS);
    expect(rules.length, "anti-vacuity: the stylesheet's glyph rules are read").toBeGreaterThan(100);
    const bad = [], seen = new Set();
    for (const g of glyphOpacities(CSS)) {
      if (GLYPH_OPACITY_ALLOWED.has(g.sel)) { seen.add(g.sel); continue; }
      bad.push(`styles.css:${lineOf(g.at)} ${g.sel} {opacity:${g.value}} — dim a glyph by its colour token (--muted at rest), never by opacity; a glyph that is not dimmed needs a GLYPH_OPACITY_ALLOWED entry with its reason`);
    }
    for (const [sel, why] of GLYPH_OPACITY_ALLOWED) if (!seen.has(sel)) bad.push(`stale GLYPH_OPACITY_ALLOWED entry ${sel} (${why}): it takes no such opacity any more — delete it`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  test("a menu item's icon idles in --muted at full strength and takes its item's ink on hover; a danger or warning item's keeps its status ink; the menu note's icon is --muted", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    await plantKebabMenu(page, "cts-km");
    const read = () => page.evaluate(() => {
      const m = document.getElementById("cts-km");
      const one = (el) => {
        const svg = el.querySelector("svg");
        let o = 1;
        for (let n = svg; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
        return { glyph: getComputedStyle(svg).color, ink: getComputedStyle(el).color, opacity: o, hovered: el.matches(":hover") };
      };
      return {
        menuBg: getComputedStyle(m).backgroundColor,
        note: one(m.querySelector(".kebab-note")), plain: one(m.querySelector('[data-k="plain"]')),
        warning: one(m.querySelector('[data-k="km-warning"]')), danger: one(m.querySelector('[data-k="km-danger"]')),
      };
    });
    const away = () => page.mouse.move(2, 2);
    const bad = [];
    const idlePlain = {};
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    for (const c of combos) {
      await paint(page, c);
      await away();
      const r = await read();
      const t = c.tokens, why = `${c.label}: ${JSON.stringify(r)}`;
      expect(r.plain.hovered || r.danger.hovered, `PRECONDITION: nothing is hovered at rest (${c.label})`).toBe(false);
      const bg = parseRgb(r.menuBg);
      for (const [k, want] of [["note", "--muted"], ["plain", "--muted"], ["warning", "--warn"], ["danger", "--danger"]]) {
        const g = parseRgb(r[k].glyph);
        if (r[k].opacity !== 1) bad.push(`${k} icon is dimmed by opacity ${r[k].opacity} — ${why}`);
        if (!g || String(g.rgb) !== String(rgbOf(t[want]))) bad.push(`${k} icon at rest is not ${want} ${t[want]} — ${why}`);
        else if (bg && ratio(g.rgb, bg.rgb) < 4.5) bad.push(`${k} icon reads ${ratio(g.rgb, bg.rgb).toFixed(2)}:1 on the menu — ${why}`);
      }
      // A status item's icon is its label's ink, at rest and hovered.
      for (const k of ["warning", "danger"]) if (r[k].glyph !== r[k].ink) bad.push(`${k} icon ${r[k].glyph} is not its label's ink ${r[k].ink} — ${why}`);
      idlePlain[c.label] = r.plain.glyph;
      for (const k of ["plain", "danger"]) {
        await page.locator(`#cts-km [data-k="${k === "plain" ? "plain" : "km-danger"}"]`).hover();
        const h = (await read())[k];
        const hw = `${c.label} hovered: ${JSON.stringify(h)}`;
        expect(h.hovered, `PRECONDITION: the ${k} item matches :hover (${c.label})`).toBe(true);
        const want = k === "plain" ? "--text" : "--danger";
        const g = parseRgb(h.glyph);
        if (h.opacity !== 1) bad.push(`hovered ${k} icon is dimmed by opacity ${h.opacity} — ${hw}`);
        if (!g || String(g.rgb) !== String(rgbOf(t[want])) || h.glyph !== h.ink) bad.push(`hovered ${k} icon is not its label's ink ${want} ${t[want]} — ${hw}`);
      }
      await away();
    }
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: at rest the plain icon is not its label's ink, so the hover is a real change.
    for (const c of combos) expect(idlePlain[c.label], `the resting icon differs from --text (${c.label})`).not.toBe(`rgb(${rgbOf(c.tokens["--text"]).join(", ")})`);
  });
});

// ── 3. accent tints ──────────────────────────────────────────────────────────
// A violet literal: hue 245-280 and clearly saturated, the range every old accent
// literal sat in (124,58,237 / 109,40,217 / #7c5cfc / #6d28d9). Syntax colours
// (One Dark's #c678dd, hue 286) and the generated block are outside it.
const VIOLET = (rgb) => {
  const [r, g, b] = rgb.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d * 255 < 60) return false;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const hue = (h * 60 + 360) % 360;
  return hue >= 245 && hue <= 280;
};
/** Every literal violet in `src` outside [skipFrom, skipTo), with the declaration it sits in. */
function violetLiterals(src, skipFrom = -1, skipTo = -1) {
  const out = [];
  const re = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi;
  for (const m of src.matchAll(re)) {
    if (m.index >= skipFrom && m.index < skipTo) continue;
    let rgb;
    if (m[1]) {
      const h = m[1].length <= 4 ? m[1].slice(0, 3).split("").map((x) => x + x).join("") : m[1].slice(0, 6);
      rgb = rgbOf(h);
    } else rgb = [+m[2], +m[3], +m[4]];
    if (!VIOLET(rgb)) continue;
    const start = Math.max(src.lastIndexOf(";", m.index), src.lastIndexOf("{", m.index)) + 1;
    const prop = src.slice(start, m.index).split(":")[0].trim();
    out.push({ at: m.index, literal: m[0], prop });
  }
  return out;
}
// Each literal violet allowed in styles.css, with its reason (checked both ways).
const VIOLET_ALLOWED = new Map([
  ["--role-admin", "the admin role badge's own colour, kept apart from the look's accent on purpose so a role is never read as a call to action"],
  ["--motif-ink", "Signature's motif ink by day and by night, in the hand-written look-character block (DESIGN_SYSTEM §1): Signature has no ambient colour, and its night control is pinned by tests/theme-tokens.spec.js; Ambient's ink is already a glow tint"],
]);

// ── 2c. No surface is faded in a stylesheet ─────────────────────────────────
// The three sheets, comments blanked, every `selector{body}` block (an @media
// block's rules are read one by one); a @keyframes stop (from, to, N%) is an
// animation, not a resting state, and is skipped. Each `opacity` and each
// `filter`/`backdrop-filter` opacity() strictly between 0 and 1, a percentage
// between, or a value this cannot read (var(), calc()) is a fade. So is one in a
// style attribute of the static markup (public/*.html, comments removed).
const SHEETS = ["public/styles.css", "public/verify-pages.css", "public/unsubscribe.css"];
const KEYFRAME_STOP = /^(?:from|to|[\d.]+%)(?:\s*,\s*(?:from|to|[\d.]+%))*$/i;
const opacityNumber = (v) => {
  const s = v.replace(/!important/i, "").trim();
  return /^[\d.]+%$/.test(s) ? parseFloat(s) / 100 : /^[\d.]+$/.test(s) ? parseFloat(s) : NaN;
};
/** The fades in one declaration body: [{ prop, value }]. */
function bodyFades(body) {
  const out = [];
  for (const d of body.matchAll(/(?:^|;)\s*opacity\s*:\s*([^;]+)/gi)) out.push({ prop: "opacity", value: d[1].trim() });
  for (const d of body.matchAll(/(?:^|;)\s*((?:-webkit-)?(?:backdrop-)?filter)\s*:\s*([^;]+)/gi)) {
    for (const f of d[2].matchAll(/opacity\(\s*([^)]*)\)/gi)) out.push({ prop: `${d[1]} opacity()`, value: f[1].trim() || "(empty)" });
  }
  return out.filter((f) => { const n = opacityNumber(f.value); return !(n === 0 || n === 1); });
}
/** { blocks, fades: [{ at, sel, prop, value }] } for a stylesheet's raw text. */
function surfaceOpacities(raw) {
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const fades = [];
  let blocks = 0;
  for (const m of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    blocks++;
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (KEYFRAME_STOP.test(sel)) continue;
    for (const f of bodyFades(m[2])) fades.push({ at: m.index + (m[1].length - m[1].trimStart().length), sel, ...f });
  }
  return { blocks, fades };
}
/** The fades in a page's style attributes: [{ at, prop, value }]. */
function markupOpacities(raw) {
  const src = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  for (const m of src.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const f of bodyFades(m[1] ?? m[2])) out.push({ at: m.index, ...f });
  }
  return out;
}
// Each rule allowed an opacity between 0 and 1, keyed `file|selector` (the
// selector as written, whitespace collapsed), with the reason it stands. Checked
// both ways: a rule rewritten under another spelling needs its key updated here,
// and an entry that matches nothing is stale.
const OPACITY_ALLOWED = new Map([
  ['public/styles.css|:disabled,[aria-disabled="true"],.is-disabled',
    "the box cue of a disabled native checkbox or radio (the seal switch included), its label at full strength (CLAUDE.md " +
    "CSS rules: only their box stays faded), and the read-only avatar grid's container (pictures, not text; kept dimmed " +
    "by operator ruling, 25 Nov 2026). Every disabled field and option draws itself at full strength (2d), as do .btn, " +
    "the pager's buttons, a link-styled button and the marked rows, tabs, tiles and chips, each by a rule of its own; " +
    "any other disabled or marked element still falls back to the fade, which 2d's unstyled control shows"],
  ['public/styles.css|#admin-profile-overlay .avatar-grid[aria-disabled="true"] .avatar-option',
    "emoji avatar pictures a regular admin may not change: pictures, not text; kept dimmed by operator ruling, 25 Nov 2026"],
  ["public/styles.css|#self-enroll-overlay .self-enroll-card.se-inactive .self-enroll-qr",
    "an inactive link's QR image tile (the event code drawn in it is part of an inactive control); when the QR cannot " +
    "be drawn its text fallback 'QR unavailable' fades with it: accepted for now"],
  ["public/styles.css|footer .footer-logo img.logo-dark", "a logotype (SC 1.4.3 exempts logotypes)"],
  ["public/styles.css|footer .footer-logo img.logo-light", "a logotype (SC 1.4.3 exempts logotypes)"],
  ["public/verify-pages.css|footer .footer-logo img.logo-dark", "a logotype (SC 1.4.3 exempts logotypes)"],
  ["public/verify-pages.css|footer .footer-logo img.logo-light", "a logotype (SC 1.4.3 exempts logotypes)"],
]);

test.describe("2c. no surface is faded in a stylesheet", () => {
  test("no rule in the stylesheets, and no style attribute in the static markup, takes an opacity between 0 and 1 unless it is a recorded decision", () => {
    // The detector, on planted text first (anti-vacuity).
    const planted = (src) => surfaceOpacities(src).fades;
    expect(planted(".a:disabled{opacity:.4}.b{opacity:40%}.c{color:red;opacity:var(--o)}@media(x){.d{opacity:.5}}"),
      "a fade, a percentage, an unreadable value, a rule inside @media").toHaveLength(4);
    expect(planted(".f{filter:opacity(.5)}.g{-webkit-backdrop-filter:blur(0) opacity(50%)}.h{filter:brightness(1.1)}"),
      "a filter's opacity() is a fade too; another filter is not").toHaveLength(2);
    expect(planted(".e{opacity:1}.f{opacity:0}.g{opacity:100%!important}.h{filter:opacity(1)}@keyframes k{0%{opacity:0}50%{opacity:.5}to{opacity:1}}" +
      "@keyframes j{from,40%{opacity:.2}}"), "full, hidden, and keyframe stops pass").toEqual([]);
    expect(planted(".x{color:red}/* .y{opacity:.5} */"), "a rule quoted in a comment is not a rule").toEqual([]);
    expect(planted(".x{color:red}/* .y{opacity:.5} */".replace("/*", "").replace("*/", "")), "…the same rule uncommented is").toHaveLength(1);
    expect(markupOpacities('<p style="color:red;opacity:.5">x</p><i style=\'filter:opacity(.3)\'></i><!-- <b style="opacity:.5"> -->'),
      "a style attribute's fade is found; one inside an HTML comment is not").toHaveLength(2);

    const bad = [], seen = new Set();
    let blocks = 0;
    for (const file of SHEETS) {
      const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
      const r = surfaceOpacities(raw);
      blocks += r.blocks;
      for (const f of r.fades) {
        const key = `${file}|${f.sel}`;
        if (OPACITY_ALLOWED.has(key)) { seen.add(key); continue; }
        bad.push(`${file}:${raw.slice(0, f.at).split("\n").length} ${f.sel} {${f.prop}:${f.value}} — never fade a surface: ` +
          "show a control that does not apply with a dashed --border-strong edge and --muted text at opacity:1; a rule that " +
          "must keep a fade needs an OPACITY_ALLOWED entry with its reason (a rewritten selector: update its key)");
      }
    }
    expect(blocks, "anti-vacuity: the three sheets' rules are read").toBeGreaterThan(1000);
    const pages = fs.readdirSync(path.join(ROOT, "public")).filter((n) => n.endsWith(".html"));
    expect(pages, "anti-vacuity: the shell markup is read").toContain("index.html");
    let attrs = 0;
    for (const n of pages) {
      const raw = fs.readFileSync(path.join(ROOT, "public", n), "utf8");
      attrs += (raw.match(/\sstyle\s*=/gi) || []).length;
      for (const f of markupOpacities(raw)) bad.push(`public/${n}:${raw.slice(0, f.at).split("\n").length} style="${f.prop}:${f.value}" — never fade a surface in markup`);
    }
    expect(attrs, "anti-vacuity: the shell's style attributes are read").toBeGreaterThan(50);
    for (const [key, why] of OPACITY_ALLOWED) if (!seen.has(key)) bad.push(`stale OPACITY_ALLOWED entry ${key} (${why}): it takes no such opacity any more — delete it`);
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

// The disabled fields 2d plants: [kind, tag, attrs, wrapper class, the ENABLED
// twin's edge token]. Every kind is planted twice, disabled and enabled (-on).
const DIS_KINDS = [
  ["text", "input", { type: "text", value: "Ada" }, "", "--control"],
  ["email", "input", { type: "email", value: "ada@example.com" }, "", "--control"],
  ["number", "input", { type: "number", value: "7" }, "", "--control"],
  ["date", "input", { type: "date", value: "2026-11-25" }, "", "--control"],
  ["time", "input", { type: "time", value: "14:30" }, "", "--control"],
  ["search", "input", { type: "search", value: "abc" }, "", "--control"],
  ["tel", "input", { type: "tel", value: "555 0100" }, "", "--control"],
  ["url", "input", { type: "url", value: "https://example.com" }, "", "--control"],
  ["password", "input", { type: "password", value: "secret" }, "", "--control"],
  ["file", "input", { type: "file" }, "", "--control"],
  ["color", "input", { type: "color", value: "#6a3df0" }, "", "--control"],
  ["select", "select", {}, "", "--control"],
  ["textarea", "textarea", { value: "Some text" }, "", "--control"],
  ["placeholder", "input", { type: "text", placeholder: "No limit" }, "", "--control"],
  ["filter-select", "select", { className: "filter-select" }, "", "--border"],
  ["cw-colour", "input", { type: "color", value: "#6a3df0" }, "cw-colour", "--control"],
  ["field-error", "input", { type: "text", value: "Ada" }, "form-group field-error", "--red"],
  ["filter-card-date", "input", { type: "date", value: "2026-11-25" }, "filter-card", "--border"],
  ["listbox", "select", { size: 3 }, "", "--control"],
];

/** Plant every DIS_KINDS field (disabled and an enabled twin), the non-fields and the residue in #cts-dis. */
const plantDisabledFields = (page) => page.evaluate((kinds) => {
  const el = (tag, props = {}, attrs = {}) => { const n = Object.assign(document.createElement(tag), props); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const box = el("div", { id: "cts-dis", className: "card" });
  // A stand-in for an engine's own disabled look (WebKit fades a disabled value
  // and sets its text fill): a rule below the field rule's specificity, which the
  // field rule must override. A constructed sheet, as the CSP refuses <style>.
  const engine = new CSSStyleSheet();
  engine.replaceSync("[data-engine-look]:disabled{-webkit-text-fill-color:rgb(255, 0, 0);opacity:.4}");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, engine];
  for (const [k, tag, attrs, wrap] of kinds) {
    for (const on of [false, true]) {
      const id = `cts-dis-${k}${on ? "-on" : ""}`;
      const props = { id, disabled: !on };
      const extra = {};
      for (const [a, v] of Object.entries(attrs)) {
        if (a === "value" && tag !== "select") continue;
        if (a === "className") props.className = v; else extra[a] = String(v);
      }
      const n = el(tag, props, on ? extra : { ...extra, "data-engine-look": "" });
      if (tag === "select") {
        n.append(el("option", { textContent: "Option A", value: "a" }), el("option", { textContent: "Option B", value: "b" }));
        // The listbox's second option is itself disabled: (h) reads it.
        if (k === "listbox") n.append(el("option", { textContent: "Not for you", value: "c", disabled: true }));
      }
      if ("value" in attrs && tag !== "select") n.value = attrs.value;
      const holder = el(wrap === "cw-colour" ? "label" : "div", { className: wrap || "form-group" });
      holder.append(n);
      if (wrap === "cw-colour") holder.append(el("span", { textContent: "Frame" }));
      box.append(holder);
    }
  }
  // Text-bearing non-fields the global fade used to reach.
  box.append(el("button", { id: "cts-dis-ce-link", className: "ce-link", disabled: true, textContent: "Add choice" }));
  box.append(el("span", { id: "cts-dis-tag-inert", className: "group-tag tag-inert", textContent: "Team A" }, { "aria-disabled": "true" }));
  box.append(el("button", { id: "cts-dis-org-pick", className: "ws-org-pick", disabled: true, textContent: "Ada Lovelace" }));
  // RESIDUE: what the global rule still fades.
  const row = (type, id) => { const l = el("label", { className: "checkbox-row", id: `${id}-row` }); l.append(el("input", { type, id, disabled: true }), el("span", { textContent: `A ${type}` })); return l; };
  box.append(row("checkbox", "cts-dis-cb"), row("radio", "cts-dis-radio"));
  box.append(el("div", { id: "cts-dis-unstyled", className: "x", textContent: "No rule of its own" }, { "aria-disabled": "true" }));
  document.body.appendChild(box);
}, DIS_KINDS);

/** Every planted control's computed state: opacity product, ink, fill, edges, shadow, pseudo-elements. */
const readDisabledFields = (page) => page.evaluate(() => {
  const opProduct = (n) => { let op = 1; for (let e = n; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity); return op; };
  const out = {};
  for (const n of document.querySelectorAll("#cts-dis [id^='cts-dis-']")) {
    const cs = getComputedStyle(n);
    // The first opaque fill under the element, for a text that sits on its parent.
    let under = "rgba(0, 0, 0, 0)";
    for (let e = n; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { under = b; break; } }
    const r = {
      disabled: !!n.disabled, op: opProduct(n), own: parseFloat(cs.opacity), fg: cs.color, fill: cs.webkitTextFillColor,
      bg: cs.backgroundColor, under, shadow: cs.boxShadow,
      styles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
      colours: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
      widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
    };
    if (n.placeholder) { const p = getComputedStyle(n, "::placeholder"); r.ph = { fg: p.color, fill: p.webkitTextFillColor, op: p.opacity }; }
    if (n.type === "file") r.fileBtn = getComputedStyle(n, "::file-selector-button").color;
    if (n.id.startsWith("cts-dis-listbox")) {
      r.options = [...n.options].map((o) => ({ disabled: o.disabled, fg: getComputedStyle(o).color, op: parseFloat(getComputedStyle(o).opacity) }));
    }
    out[n.id.slice("cts-dis-".length)] = r;
  }
  return out;
});

test.describe("2d. a disabled field reads at full strength", () => {
  test("a disabled field keeps its own fill and reads at full strength: a dashed --border-strong edge and --muted value, placeholder and file button, clearing AA, in every look, mode and ambient colour", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    await plantDisabledFields(page);
    // DETECTOR SELF-CHECK: a fade on an ancestor is read as one.
    await page.evaluate(() => { document.getElementById("cts-dis-text").parentElement.style.opacity = "0.5"; });
    expect((await readDisabledFields(page)).text.op, "the opacity product sees an ancestor's fade").toBeCloseTo(0.5, 5);
    await page.evaluate(() => { document.getElementById("cts-dis-text").parentElement.style.opacity = ""; });

    const pre = await readDisabledFields(page);
    for (const [k] of DIS_KINDS) {
      expect(pre[k] && pre[k].disabled, `PRECONDITION: ${k} is planted disabled`).toBe(true);
      expect(pre[`${k}-on`] && pre[`${k}-on`].disabled, `PRECONDITION: ${k}-on is planted enabled`).toBe(false);
    }
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    let measured = 0;
    const is = (col, hex) => { const p = parseRgb(col); return !!p && p.a === 1 && String(p.rgb) === String(rgbOf(hex)); };
    const edgeIs = (x, style, token, t, why) => {
      if (!x.styles.every((s) => s === style)) bad.push(`the edge is not ${style} on all four sides — ${why}`);
      if (!x.widths.every((w) => parseFloat(w) >= 1)) bad.push(`the edge is not drawn on all four sides (widths ${x.widths}) — ${why}`);
      x.colours.forEach((col, i) => { if (!is(col, t[token])) bad.push(`edge ${["top", "right", "bottom", "left"][i]} ${col} is not ${token} ${t[token]} — ${why}`); });
    };
    for (const c of combos) {
      await paint(page, c);
      const r = await readDisabledFields(page), t = c.tokens;
      for (const [k, , , , onEdge] of DIS_KINDS) {
        const x = r[k], on = r[`${k}-on`], why = `${k} in ${c.label}: ${JSON.stringify(x)}`;
        if (x.op !== 1) bad.push(`it is faded (opacity ${x.op}) — ${why}`);                                      // (a)
        if (!is(x.fg, t["--muted"])) bad.push(`the value is not --muted ${t["--muted"]} — ${why}`);              // (b)
        if (!is(x.fill, t["--muted"])) bad.push(`the text fill is not --muted ${t["--muted"]} — ${why}`);
        edgeIs(x, "dashed", "--border-strong", t, why);                                                          // (c)
        if (x.bg !== on.bg) bad.push(`it does not keep its own fill (${x.bg}; enabled ${on.bg}) — ${why}`);      // (d)
        const bg = parseRgb(x.bg);
        if (!bg || bg.a !== 1 || ratio(rgbOf(t["--muted"]), bg.rgb) < 4.5) bad.push(`--muted reads under 4.5:1 on its fill ${x.bg} — ${why}`); // (e)
        if (x.shadow !== "none") bad.push(`a disabled field keeps a ring (${x.shadow}) — ${why}`);
        // CONTROL, same paint: the enabled twin is at full strength in --text, on a solid edge of its own.
        const onWhy = `${k}-on in ${c.label}: ${JSON.stringify(on)}`;
        if (on.op !== 1) bad.push(`an enabled field is faded — ${onWhy}`);
        if (!is(on.fg, t["--text"])) bad.push(`an enabled value is not --text ${t["--text"]} — ${onWhy}`);
        edgeIs(on, "solid", onEdge, t, onWhy);
        measured++;
      }
      // The error ring belongs to a field that can be corrected: the enabled twin keeps it.
      if (r["field-error-on"].shadow === "none") bad.push(`CONTROL: the enabled field-error twin has no ring — ${c.label}`);
      // (f) the placeholder, (g) the file button, (h) a disabled option.
      const ph = r.placeholder.ph;
      if (!ph || !is(ph.fg, t["--muted"]) || !is(ph.fill, t["--muted"]) || ph.op !== "1") bad.push(`the placeholder is not --muted at full strength — ${c.label}: ${JSON.stringify(ph)}`);
      if (!is(r.file.fileBtn, t["--muted"])) bad.push(`the file button is not --muted — ${c.label}: ${r.file.fileBtn}`);
      const opts = r["listbox-on"].options;
      const dOpt = opts.find((o) => o.disabled), eOpt = opts.find((o) => !o.disabled);
      if (!dOpt || dOpt.op !== 1 || !is(dOpt.fg, t["--muted"])) bad.push(`a disabled option is not --muted at full strength — ${c.label}: ${JSON.stringify(opts)}`);
      if (!eOpt || eOpt.op !== 1 || !is(eOpt.fg, t["--text"])) bad.push(`CONTROL: an enabled option is not --text — ${c.label}: ${JSON.stringify(opts)}`);
      // Non-fields: full strength, --muted, at AA on what they sit on.
      for (const k of ["ce-link", "tag-inert", "org-pick"]) {
        const x = r[k], why = `${k} in ${c.label}: ${JSON.stringify(x)}`, u = parseRgb(x.under);
        if (x.op !== 1) bad.push(`it is faded (opacity ${x.op}) — ${why}`);
        if (!is(x.fg, t["--muted"])) bad.push(`it is not --muted ${t["--muted"]} — ${why}`);
        if (!u || ratio(rgbOf(t["--muted"]), u.rgb) < 4.5) bad.push(`it reads under 4.5:1 on ${x.under} — ${why}`);
      }
      // RESIDUE, the global entry's reason: a checkbox's or radio's box keeps the
      // fade, its label does not; an element with no rule of its own still fades.
      for (const k of ["cb", "radio"]) {
        if (r[k].own !== 0.5) bad.push(`the disabled ${k} box is not at the recorded 0.5 (${r[k].own}) — ${c.label}`);
        if (r[`${k}-row`].op !== 1) bad.push(`the ${k}'s label is faded (${r[`${k}-row`].op}) — ${c.label}`);
      }
      if (r.unstyled.own !== 0.5) bad.push(`anti-vacuity: the global fade no longer reaches an unstyled aria-disabled element (${r.unstyled.own}) — ${c.label}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(measured, "anti-vacuity: every disabled kind measured in every combination").toBe(DIS_KINDS.length * combos.length);
  });

  test("under forced colours a disabled value and placeholder take the system's GrayText, never the author's --muted", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    await plantDisabledFields(page);
    const read = () => page.evaluate(() => {
      const probe = document.getElementById("cts-graytext") || Object.assign(document.body.appendChild(document.createElement("span")), { id: "cts-graytext", textContent: "probe" });
      probe.style.cssText = "forced-color-adjust:none;color:GrayText";
      const muted = document.getElementById("cts-muted") || Object.assign(document.body.appendChild(document.createElement("span")), { id: "cts-muted", textContent: "probe" });
      muted.style.cssText = "forced-color-adjust:none;color:var(--muted)";
      const t = document.getElementById("cts-dis-text"), p = document.getElementById("cts-dis-placeholder");
      return {
        gray: getComputedStyle(probe).color, muted: getComputedStyle(muted).color,
        fill: getComputedStyle(t).webkitTextFillColor, phFill: getComputedStyle(p, "::placeholder").webkitTextFillColor,
      };
    });
    // CONTROL: without forced colours the value is the author's --muted, and that is not GrayText.
    await page.emulateMedia({ forcedColors: "none" });
    const off = await read();
    expect(off.fill, "CONTROL: the value is --muted outside forced colours").toBe(off.muted);
    expect(off.muted, "PRECONDITION: GrayText and --muted differ, so the arm can tell them apart").not.toBe(off.gray);
    await page.emulateMedia({ forcedColors: "active" });
    const on = await read();
    expect(on.fill, `the value takes GrayText under forced colours: ${JSON.stringify(on)}`).toBe(on.gray);
    expect(on.phFill, `the placeholder takes GrayText under forced colours: ${JSON.stringify(on)}`).toBe(on.gray);
  });

  test("a disabled select's arrow and a disabled date field's digits are drawn in --muted, not --text (pixel witness)", async ({ page }) => {
    await signInPage(page);
    await page.locator('html[data-booted="1"]').waitFor({ state: "attached", timeout: 20000 });
    // A small fixed box over the page so every crop is in the viewport.
    await page.evaluate(() => {
      const box = document.createElement("div");
      box.id = "cts-px"; box.className = "card";
      box.style.cssText = "position:fixed;top:8px;left:8px;z-index:99999;width:320px;display:grid;gap:8px;padding:12px";
      for (const on of [false, true]) {
        const s = document.createElement("select"); s.id = `cts-px-select${on ? "-on" : ""}`; s.disabled = !on;
        s.append(Object.assign(document.createElement("option"), { textContent: "Option A" }));
        const d = document.createElement("input"); d.type = "date"; d.value = "2026-11-25"; d.id = `cts-px-date${on ? "-on" : ""}`; d.disabled = !on;
        box.append(s, d);
      }
      document.body.appendChild(box);
    });
    const crop = (id, what) => page.evaluate(([i, w]) => {
      const n = document.getElementById(i), r = n.getBoundingClientRect(), cs = getComputedStyle(n), px = (v) => parseFloat(v);
      const top = r.top + px(cs.borderTopWidth), bottom = r.bottom - px(cs.borderBottomWidth);
      if (w === "arrow") { const right = r.right - px(cs.borderRightWidth); return { x: right - 28, y: top, width: 28, height: bottom - top }; }
      // The date's digits: the content box, short of the right-hand picker region.
      const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
      return { x: left, y: top + 2, width: Math.max(20, r.width - px(cs.paddingLeft) - px(cs.paddingRight) - 48), height: bottom - top - 4 };
    }, [id, what]);
    const pixels = async (clip) => {
      const png = await page.screenshot({ clip, animations: "disabled" });
      // Decoded in the page (no new dependency): a Blob, createImageBitmap, an OffscreenCanvas.
      return page.evaluate(async (bytes) => {
        const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext("2d");
        g.drawImage(bmp, 0, 0);
        return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data);
      }, [...png]);
    };
    const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    /** { fill, ink, far }: the crop's commonest pixel, the pixel farthest from it, and how many lie over 40 from it. */
    const inkOf = (data) => {
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) { const k = `${data[i]},${data[i + 1]},${data[i + 2]}`; counts.set(k, (counts.get(k) || 0) + 1); }
      const fill = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
      // Farthest by the SUM of its channels: by the largest alone, a coloured
      // antialiasing fringe can tie with the glyph's core.
      const sum = (a, b) => a.reduce((t, v, i) => t + Math.abs(v - b[i]), 0);
      let ink = fill, best = -1, far = 0;
      for (let i = 0; i < data.length; i += 4) {
        const p = [data[i], data[i + 1], data[i + 2]], d = sum(p, fill);
        if (dist(p, fill) > 40) far++;
        if (d > best) { best = d; ink = p; }
      }
      return { fill, ink, far };
    };
    const combos = lookCombos().filter((c) => (c.look === "ambient" && c.ambient === "ice") || c.look === "signature");
    expect(combos.length, "anti-vacuity: the house look and Signature, by day and by night").toBe(4);
    const bad = [];
    for (const c of combos) {
      await paint(page, c);
      const muted = rgbOf(c.tokens["--muted"]), text = rgbOf(c.tokens["--text"]);
      for (const [id, what] of [["cts-px-select", "arrow"], ["cts-px-date", "digits"]]) {
        for (const on of [false, true]) {
          const k = `${id}${on ? "-on" : ""}`, x = inkOf(await pixels(await crop(k, what)));
          const why = `${k} (${what}) in ${c.label}: ink ${x.ink}, fill ${x.fill}, ${x.far} inked pixels; --muted ${muted}, --text ${text}`;
          if (x.far < 20) bad.push(`anti-vacuity: the crop holds no glyph — ${why}`);
          const dm = dist(x.ink, muted), dt = dist(x.ink, text);
          // The glyph's core is the ink itself (measured 0 off), so "nearer" is also
          // "within 12": a faded glyph is a blend toward the fill and fails it.
          if (!on && !(dm < dt && dm <= 12)) bad.push(`a disabled ${what} is not drawn in --muted (${dm} from --muted, ${dt} from --text) — ${why}`);
          if (on && !(dt < dm && dt <= 12)) bad.push(`CONTROL: an enabled ${what} is not drawn in --text (${dt} from --text, ${dm} from --muted) — ${why}`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

test.describe("3. accent tints", () => {
  test("an accent tint is rgb(var(--glow) / a): no literal violet outside the generated tokens", () => {
    // The detector, on planted text first (anti-vacuity).
    expect(violetLiterals(".a{border:1px solid rgba(124,58,237,.35)}"), "planted rgba()").toHaveLength(1);
    expect(violetLiterals(".a{background:#7c5cfc1a}.b{background:#6d28d915}.c{x:rgb(109 40 217 / .06)}"), "planted hex and space rgb()").toHaveLength(3);
    expect(violetLiterals(".a{border:1px solid rgb(var(--glow) / .35);color:#c678dd;background:#1d4ed8}"), "a glow tint, a syntax colour and a blue are not violet").toEqual([]);
    const gen = require("../scripts/build-theme-tokens");
    const from = RAW.indexOf(gen.BEGIN), to = RAW.indexOf(gen.END);
    expect(from, "the generated block is found").toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const bad = [], seen = new Set();
    for (const v of violetLiterals(CSS, from, to)) {
      if (VIOLET_ALLOWED.has(v.prop)) { seen.add(v.prop); continue; }
      bad.push(`styles.css:${lineOf(v.at)} ${v.prop}: ${v.literal} — an accent tint is rgb(var(--glow) / a); a fixed violet that is not the accent needs a VIOLET_ALLOWED entry with its reason`);
    }
    for (const [prop, why] of VIOLET_ALLOWED) if (!seen.has(prop)) bad.push(`stale VIOLET_ALLOWED entry ${prop} (${why}): no literal violet is declared there any more — delete it`);
    expect(bad, bad.join("\n")).toEqual([]);
    const glowTints = (CSS.match(/rgb\(var\(--glow\)\s*\/\s*[\d.]+\)/g) || []).length;
    expect(glowTints, "anti-vacuity: the accent tints are written as glow tints").toBeGreaterThanOrEqual(14);
  });

  test("in a real page the accent tints take the look's accent: the ambient colour, by day and by night", async ({ page }) => {
    await signInPage(page);
    await page.evaluate(() => {
      const mk = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; parent.appendChild(e); return e; };
      const box = mk("div", "", document.body); box.id = "cts-tints";
      mk("span", "cat-ribbon", box).textContent = "Web";
      mk("span", "kind-chip", box).textContent = "Competition";
      const tb = mk("tbody", "", mk("table", "lb-table", box));
      mk("td", "", mk("tr", "me", tb)).textContent = "me";
      mk("button", "picker-card picker-card-active", box).textContent = "card";
      const row = mk("label", "picker-row", box);
      const cb = mk("input", "picker-row-check", row); cb.type = "checkbox"; cb.checked = true;
      const inv = mk("div", "", box); inv.id = "invite-overlay";
      mk("div", "invite-result", inv).textContent = "sent";
      const sel = mk("tr", "comp-selected", document.getElementById("admin-comp-body"));
      sel.id = "cts-comp-selected"; mk("td", "", sel).textContent = "event";
    });
    // [what, how to read it, alpha by day, alpha by night]
    const SITES = [
      ["category ribbon edge", "#cts-tints .cat-ribbon|borderTopColor", 0.35, 0.35],
      ["event-kind chip edge", "#cts-tints .kind-chip|borderTopColor", 0.35, 0.35],
      ["your own leaderboard row", "#cts-tints .lb-table tr.me|backgroundColor", 0.06, 0.08],
      ["the chosen picker card", "#cts-tints .picker-card-active|backgroundColor", 0.12, 0.12],
      ["a ticked picker row", "#cts-tints .picker-row|backgroundColor", 0.08, 0.12],
      ["the invitation result", "#cts-tints .invite-result|backgroundColor", 0.08, 0.12],
      ["the selected Events row", "#cts-comp-selected|backgroundColor", 0.06, 0.08],
    ];
    const read = () => page.evaluate((sites) => {
      const out = { glow: getComputedStyle(document.documentElement).getPropertyValue("--glow").trim() };
      for (const [, spec] of sites) { const [sel, prop] = spec.split("|"); out[spec] = getComputedStyle(document.querySelector(sel))[prop]; }
      return out;
    }, SITES);
    const bad = [];
    const byLook = {};
    for (const c of [
      { look: "ambient", theme: "light", ambient: "amber" }, { look: "ambient", theme: "dark", ambient: "amber" },
      { look: "ambient", theme: "light", ambient: "emerald" }, { look: "signature", theme: "light", ambient: null },
      { look: "signature", theme: "dark", ambient: null },
    ]) {
      await paint(page, c);
      const r = await read();
      const glow = r.glow.split(/\s+/).map(Number);
      expect(glow, `PRECONDITION: --glow is a triplet in ${JSON.stringify(c)}`).toHaveLength(3);
      for (const [what, spec, day, night] of SITES) {
        const got = parseRgb(r[spec]);
        const want = c.theme === "dark" ? night : day;
        if (!got || String(got.rgb) !== String(glow) || Math.abs(got.a - want) > 0.005) {
          bad.push(`${what} in ${c.look}/${c.theme}/${c.ambient || "-"}: ${r[spec]}, want rgb(${glow.join(" ")} / ${want})`);
        }
      }
      byLook[`${c.look}/${c.theme}/${c.ambient || "-"}`] = r["#cts-tints .cat-ribbon|borderTopColor"];
    }
    await page.evaluate(() => { document.getElementById("cts-comp-selected")?.remove(); });
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: the edge really moves with the ambient colour (a fixed violet would not).
    expect(byLook["ambient/light/amber"]).not.toBe(byLook["ambient/light/emerald"]);
    expect(byLook["ambient/light/amber"]).not.toBe(byLook["signature/light/-"]);
  });
});

// ── 4. motion ────────────────────────────────────────────────────────────────
// A fixed timing outside the duration tokens, each named in DESIGN_SYSTEM §6, keyed
// by where it is written (a stylesheet rule's selector, or a script and its exact
// value); checked both ways.
const FIXED_TIMINGS = new Map([
  ["styles.css .tasks-meter i", "the solved meter's fill, 600 ms"],
  ["styles.css .ws-kpi-bar-fill", "the workspace KPI bars' fill, 700 ms on the rise curve"],
  ["styles.css .ws-bar-fill", "the solve-rate bars' fill, 700 ms on the rise curve"],
  ["public/js/features/leaderboard.js transform 360ms var(--ease-spring)", "the leaderboard row slide (FLIP), 360 ms, inside the 400 ms timer that clears it"],
]);
const DURATION = /^-?(\d+\.?\d*|\.\d+)m?s$/;
const EASING_LITERAL = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\)|linear\(.*\))$/;
/**
 * The offences in one transition declaration of property `prop`; `fixedOk` admits
 * a literal duration. Each item of the shorthand names BOTH halves: left out, the
 * duration is 0 s and the easing the browser's `ease`, values the system never
 * chose. A longhand (`transition-duration`, `-timing-function`, `-delay`) names one
 * half by definition, and `none` animates nothing.
 */
function timingOffences(value, fixedOk, prop = "transition") {
  const out = [];
  for (const entry of value.replace(/!important/g, "").split(/,(?![^(]*\))/)) {
    const toks = entry.trim().match(/var\([^)]*\)|[a-z-]+\([^)]*\)|\S+/gi) || [];
    let duration = false, easing = false, flagged = false;
    for (const tok of toks) {
      if (/^var\(--duration-(fast|normal|slow)\)$/.test(tok)) { duration = true; continue; }
      if (/^var\(--ease-(out|spring|rise)\)$/.test(tok)) { easing = true; continue; }
      // A var() that is not a motion token holds the place of either half; it is
      // the offence, so the half it may stand for is not reported missing as well.
      if (/^var\(/.test(tok)) { flagged = true; out.push(`${tok}: not a motion token (a fallback is a literal)`); continue; }
      if (DURATION.test(tok)) { duration = true; if (!fixedOk) out.push(`${tok}: a literal duration`); continue; }
      if (EASING_LITERAL.test(tok)) { easing = true; out.push(`${tok}: a literal easing`); continue; }
      // Anything else is a property name or none/all.
    }
    if (prop !== "transition" || flagged || !toks.length || (toks.length === 1 && /^none$/i.test(toks[0]))) continue;
    if (!duration) out.push(`${entry.trim()}: names no duration (0 s, not a --duration-* token)`);
    if (!easing) out.push(`${entry.trim()}: names no easing (the browser's \`ease\`, not an --ease-* token)`);
  }
  return out;
}
/** [{sel, prop, value, at}] for every transition declaration in CSS-like text. */
function transitions(src) {
  const out = [];
  for (const m of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    for (const d of m[2].matchAll(/(?:^|;)\s*(transition(?:-duration|-timing-function|-delay)?)\s*:\s*([^;]+)/g)) {
      out.push({ sel, prop: d[1], value: d[2].trim(), at: m.index });
    }
  }
  return out;
}

test.describe("4. motion", () => {
  test("every transition names its duration and its easing, each a motion token or a named fixed timing, and the rise curve is var(--ease-rise)", () => {
    // The detector, on planted text first (anti-vacuity).
    expect(timingOffences("transform .12s ease,box-shadow .18s ease", false), "planted literals").toHaveLength(4);
    expect(timingOffences(".2s", false, "transition-duration"), "a bare duration").toHaveLength(1);
    expect(timingOffences(".2s", false), "a bare duration in the shorthand, which names no easing either").toHaveLength(2);
    expect(timingOffences("transform var(--duration-fast,150ms) ease", false), "a fallback and a keyword").toHaveLength(2);
    expect(timingOffences("transform .7s cubic-bezier(.2,.7,.2,1)", true), "a hand-written curve, even with a fixed timing").toHaveLength(1);
    expect(timingOffences("color var(--duration-fast) var(--ease-out),opacity var(--duration-normal)", false),
      "an item with no easing: the browser's `ease`").toEqual(["opacity var(--duration-normal): names no easing (the browser's `ease`, not an --ease-* token)"]);
    expect(timingOffences("color var(--ease-out)", false), "an item with no duration: 0 s").toEqual(["color var(--ease-out): names no duration (0 s, not a --duration-* token)"]);
    expect(timingOffences("color var(--duration-fast) var(--ease-out),opacity var(--duration-normal) var(--ease-spring) var(--duration-fast)", false), "tokens pass").toEqual([]);
    expect(timingOffences("var(--duration-fast),var(--duration-normal)", false, "transition-duration"), "a duration longhand names no easing").toEqual([]);
    expect(timingOffences("var(--ease-out)", false, "transition-timing-function"), "an easing longhand names no duration").toEqual([]);
    expect(timingOffences("none!important", false)).toEqual([]);

    const bad = [], fixedSeen = new Set();
    // styles.css
    const decls = transitions(CSS);
    expect(decls.length, "anti-vacuity: the stylesheet's transitions are read").toBeGreaterThan(60);
    for (const t of decls) {
      const key = `styles.css ${t.sel}`;
      const fixed = FIXED_TIMINGS.has(key);
      const off = timingOffences(t.value, fixed, t.prop);
      if (fixed && timingOffences(t.value, false, t.prop).length > off.length) fixedSeen.add(key);
      for (const o of off) bad.push(`styles.css:${lineOf(t.at)} ${t.sel} — ${o}`);
    }
    // Inline styles and style assignments public/js writes.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith(".js") ? [p] : [];
    });
    const files = walk(path.join(ROOT, "public", "js"));
    expect(files.length, "anti-vacuity: the SPA modules are found").toBeGreaterThan(20);
    let jsSites = 0;
    for (const f of files) {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      // [property, value]: a style property written in camelCase is the same longhand.
      const vals = [
        ...[...src.matchAll(/(?<![\w-])(transition(?:-duration|-timing-function|-delay)?)\s*:\s*([^;"'`}]+)/g)].map((m) => [m[1], m[2]]),
        ...[...src.matchAll(/\.style\.(transition(?:Duration|TimingFunction|Delay)?)\s*=\s*(['"`])(.*?)\2/g)]
          .map((m) => [m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), m[3]]),
      ];
      for (const [prop, v] of vals) {
        if (!v.trim()) continue;
        jsSites++;
        const key = `${rel} ${v.trim()}`;
        const fixed = FIXED_TIMINGS.has(key);
        const off = timingOffences(v.trim(), fixed, prop);
        if (fixed && timingOffences(v.trim(), false, prop).length > off.length) fixedSeen.add(key);
        for (const o of off) bad.push(`${rel} — ${v.trim()} — ${o}`);
      }
    }
    expect(jsSites, "anti-vacuity: the inline transitions public/js writes are read").toBeGreaterThanOrEqual(4);
    for (const [key, why] of FIXED_TIMINGS) if (!fixedSeen.has(key)) bad.push(`stale FIXED_TIMINGS entry ${key} (${why}): it writes no literal duration any more — delete it (and its line in DESIGN_SYSTEM §6)`);
    // The rise curve is named, never written out: only its own definition spells it.
    const curve = /cubic-bezier\(\s*0?\.2\s*,\s*0?\.7\s*,\s*0?\.2\s*,\s*1\s*\)/g;
    const spelled = [...CSS.matchAll(curve)].map((m) => ({ m, line: lineOf(m.index), def: /--ease-rise\s*:\s*$/.test(CSS.slice(Math.max(0, m.index - 40), m.index)) }));
    expect(spelled.filter((s) => s.def), "the --ease-rise definition is found").toHaveLength(1);
    for (const s of spelled.filter((x) => !x.def)) bad.push(`styles.css:${s.line} writes the rise curve by hand — use var(--ease-rise)`);
    expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
    expect((CSS.match(/var\(--ease-rise\)/g) || []).length, "anti-vacuity: the rise curve is used by name").toBeGreaterThanOrEqual(4);
  });
});

// ── 5. no colour literal is tuned to one mode ────────────────────────────────
// A literal written for one mode is wrong in the other: a white hover overlay is
// invisible by day, a day-only label leaves the night one unmeasured. Every colour
// is a look token in both modes; the scan finds, outside the generated block,
//   (a) any colour literal in a mode rule (one under [data-theme], [data-stage] or
//       prefers-color-scheme),
//   (b) translucent white or black anywhere (an overlay or ring tuned for one
//       mode's surfaces),
//   (c) any translucent colour literal in a box-shadow or a keyframe (a ring or
//       pulse drawn in one mode's hue),
// one finding per declaration, each needing an ALLOW entry with its reason. A var()
// and its fallback are not literals, and rgb(var(--x) / a) is a token tint. The
// inline styles public/js writes are held too: no translucent white or black, and
// no white text.
/** Blank every url(...) so a data URI's quotes, semicolons and `black` strokes are not CSS. */
function blankUrls(src) {
  return src.replace(/url\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)/gi, (m) => "url(" + " ".repeat(m.length - 5) + ")");
}
/** `v` without its var(...) groups (nested parentheses included). */
function dropVars(v) {
  let out = "", i = 0;
  while (i < v.length) {
    if (v.startsWith("var(", i)) {
      let d = 0, j = i + 3;
      for (; j < v.length; j++) { if (v[j] === "(") d++; else if (v[j] === ")") { d--; if (!d) break; } }
      i = j + 1; continue;
    }
    out += v[i++];
  }
  return out;
}
/** Each colour literal in a declaration value: {text, translucent, white, black}. */
function colourLiterals(value) {
  const v = dropVars(value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'));
  const out = [];
  for (const m of v.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])|\b(rgba?|hsla?)\(([^)]*)\)|(?<![\w-])(white|black)(?![\w-])/gi)) {
    if (m[1]) {
      const h = m[1].toLowerCase(), full = h.length <= 4 ? h.split("").map((x) => x + x).join("") : h;
      const a = full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1;
      out.push({ text: m[0], translucent: a < 1, white: full.slice(0, 6) === "ffffff", black: full.slice(0, 6) === "000000" });
    } else if (m[2]) {
      const args = m[3].trim();
      if (!args.split(/[/,]/)[0].trim()) continue;   // rgb(var(--glow) / .08): a token tint
      const parts = args.split(/\s*[/,]\s*|\s+/).filter(Boolean);
      const alpha = args.includes("/") ? args.split("/")[1].trim() : (parts[3] || "1");
      const a = alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
      const ch = parts.slice(0, 3).map(Number), isRgb = /^rgb/i.test(m[2]);
      out.push({ text: m[0], translucent: a < 1, white: isRgb && ch.every((x) => x === 255), black: isRgb && ch.every((x) => x === 0) });
    } else out.push({ text: m[0], translucent: false, white: /white/i.test(m[4]), black: /black/i.test(m[4]) });
  }
  return out;
}
/**
 * Every declaration in CSS-like text: {ctx (the at-rules and selectors it sits in,
 * outermost first), sel, prop, value, at}. Quoted strings and url()s cannot open or
 * close a block; offsets are offsets in `src`.
 */
function cssDeclarations(src) {
  const s = blankUrls(src);
  const out = [], stack = [];
  let start = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "{") { stack.push(s.slice(start, i).trim().replace(/\s+/g, " ")); start = i + 1; continue; }
    if (c !== ";" && c !== "}") continue;
    const text = s.slice(start, i), colon = text.indexOf(":");
    if (stack.length && colon > 0) {
      const prop = text.slice(0, colon).trim().toLowerCase();
      if (/^(--)?[a-z-]+$/.test(prop)) out.push({ ctx: [...stack], sel: stack[stack.length - 1], prop, value: text.slice(colon + 1).trim(), at: start + (text.length - text.trimStart().length) });
    }
    if (c === "}") stack.pop();
    start = i + 1;
  }
  return out;
}
const MODE_CONTEXT = /\[data-theme|\[data-stage|prefers-color-scheme/;
/** The findings: one per declaration, tagged with the clauses it breaks. */
function oneModeLiterals(src) {
  const out = [];
  for (const d of cssDeclarations(src)) {
    const lits = colourLiterals(d.value);
    if (!lits.length) continue;
    const tags = [];
    if (d.ctx.some((p) => MODE_CONTEXT.test(p))) tags.push("a");
    if (lits.some((l) => l.translucent && (l.white || l.black))) tags.push("b");
    if (lits.some((l) => l.translucent) && (d.prop === "box-shadow" || d.ctx.some((p) => /^@(-webkit-)?keyframes\b/.test(p)))) tags.push("c");
    if (tags.length) out.push({ ...d, tags, literals: lits.map((l) => l.text), key: `${d.ctx.join(" > ")} { ${d.prop} }` });
  }
  return out;
}
/** The inline-style offences in one public/js file (comments stripped). */
function jsOneModeLiterals(src) {
  const out = [];
  const judge = (prop, value, at) => {
    const lits = colourLiterals(value);
    if (lits.some((l) => l.translucent && (l.white || l.black))) out.push({ at, what: `${prop}:${value.trim()} (translucent white or black)` });
    else if (/^color$/i.test(prop) && lits.some((l) => l.white && !l.translucent)) out.push({ at, what: `${prop}:${value.trim()} (white text)` });
  };
  let sites = 0;
  for (const m of src.matchAll(/(?<![\w-])(color|background(?:-color)?|border(?:-[a-z]+)*|box-shadow|outline(?:-color)?)\s*:\s*([^;"'`}]+)/gi)) { sites++; judge(m[1], m[2], m.index); }
  for (const m of src.matchAll(/\.style\.(color|background(?:Color)?|border\w*|boxShadow|outline\w*)\s*=\s*(['"`])(.*?)\2/g)) { sites++; judge(m[1], m[3], m.index); }
  return { out, sites };
}
// Each finding allowed, keyed by a pattern over "<context> { <property> }", with
// its reason; every entry must still match (checked both ways).
const ONE_MODE_ALLOWED = [
  [/^html\[data-theme="light"\] \{ --(overlay|code-bg|code-fg) \}$/,
    "the day block of the hand-written per-mode variables (--overlay, --code-bg, --code-fg): each mode has its own value, measured where it is used"],
  [/pre code \.hljs-[\s\S]* \{ color \}$/,
    "the highlight.js day palette: each mode has its own syntax palette, each measured on its --code-bg (tests/code-blocks.spec.js)"],
  // Inline code's tint, one entry per mode: translucent on purpose, as it sits over
  // any rich-text highlight, and tuned for each mode's surfaces.
  [/^\.rich-body code,#task-detail-card code,#task-preview-overlay code \{ background \}$/, "inline code's night tint (white .07)"],
  [/^html\[data-theme="light"\] \.rich-body code,html\[data-theme="light"\] #task-detail-card code,html\[data-theme="light"\] #task-preview-overlay code \{ background \}$/, "inline code's day tint (black .06)"],
  [/\[data-look="signature"\]\[data-theme="dark"\][^{]* \{ --motif-ink \}$/,
    "Signature's night motif ink, the hand-written look-character block (DESIGN_SYSTEM §1; VIOLET_ALLOWED in arm 3): Signature has no ambient colour, so its per-mode ink is written here"],
  [/^\.admin-sidebar-overlay \{ background \}$/, "the drawer's scrim, which darkens whatever page lies under it in either mode"],
  [/^\.group-tag \.tag-x:hover \{ background \}$/, "on a group chip's own fill (#1d4ed8 in both modes), so the lightening is the same by day and at night"],
  [/^\.podium-num::before \{ border \}$/, "a dashed ring drawn on the podium's metal disc, whose fill is the same in both modes"],
  [/^\.ap-amb i \{ box-shadow \}$/, "an inset edge on an ambient-colour swatch, darkening the swatch's own colour whatever the mode"],
];

test.describe("5. no colour literal is tuned to one mode", () => {
  test("outside the generated tokens, no colour literal in a mode rule, no translucent white or black, no translucent literal in a ring or keyframe; no white or translucent white or black in public/js inline styles", () => {
    // The detector, on planted text first (anti-vacuity).
    const planted = blankCssComments([
      'html[data-theme="light"] .x{color:#fff}',                     // (a)
      ".y:hover{background:rgba(255,255,255,.06)}",                   // (b)
      ".z{border:1px solid #00000020}",                               // (b)
      '[data-theme="dark"] .w{background:rgb(0 0 0 / .2)}',           // (a)+(b), one finding
      "@keyframes p{0%{box-shadow:0 0 0 0 rgba(29,115,70,.45)}}",     // (c)
      ".clean{color:var(--text);background:var(--surface)}",
      ".fallback{border:1px solid var(--border, rgba(255,255,255,.12))}",
      'html[data-theme="light"] .tint{background:rgb(var(--glow) / .06)}',
      ".mask{mask:url(\"data:image/svg+xml;utf8,<svg stroke='black'/>\")}",
      // A comment quoting an old rule (built from parts: no comment opener in a string).
      "/" + '* html[data-theme="light"] .old{color:#fff} *' + "/",
    ].join("\n"));
    const found = oneModeLiterals(planted);
    expect(found.map((f) => `${f.sel}:${f.tags.join("")}`), "planted findings, one per declaration").toEqual([
      'html[data-theme="light"] .x:a', ".y:hover:b", ".z:b", '[data-theme="dark"] .w:ab', "0%:c",
    ]);
    expect(oneModeLiterals(".a{x:#fff}.b{y:rgba(0,0,0,.5)}").length, "an unread literal would pass").toBe(1);
    // The real sheet, comments blanked, the generated block left out.
    const gen = require("../scripts/build-theme-tokens");
    // Offsets in CSS are offsets in RAW (the markers are comments, blanked in CSS).
    const from = RAW.indexOf(gen.BEGIN), to = RAW.indexOf(gen.END) + gen.END.length;
    expect(from, "the generated block is found").toBeGreaterThan(-1);
    const scanned = CSS.slice(0, from) + CSS.slice(from, to).replace(/[^\n]/g, " ") + CSS.slice(to);
    const decls = cssDeclarations(scanned);
    expect(new Set(decls.map((d) => d.ctx.join(" > "))).size, "anti-vacuity: the stylesheet's rules are read").toBeGreaterThan(1000);
    const bad = [], seen = new Set();
    for (const f of oneModeLiterals(scanned)) {
      const i = ONE_MODE_ALLOWED.findIndex(([rx]) => rx.test(f.key));
      if (i >= 0) { seen.add(i); continue; }
      bad.push(`styles.css:${lineOf(f.at)} ${f.key} = ${f.literals.join(" ")} [${f.tags.join("")}] — a colour is a look token in both modes (a translucent ink over a token is rgb(var(--x) / a)); a reviewed exception needs a ONE_MODE_ALLOWED entry with its reason`);
    }
    ONE_MODE_ALLOWED.forEach(([rx, why], i) => { if (!seen.has(i)) bad.push(`stale ONE_MODE_ALLOWED entry ${rx} (${why}): nothing matches it any more — delete it`); });
    // The inline styles public/js writes.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith(".js") ? [p] : [];
    });
    expect(jsOneModeLiterals("item.onmouseenter=()=>item.style.background='rgba(255,255,255,.06)';x='<div style=\"color:#fff\">';y='color:var(--text)'").out,
      "planted: a JS hover overlay and white text").toHaveLength(2);
    let jsSites = 0;
    for (const f of walk(path.join(ROOT, "public", "js"))) {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      const { out, sites } = jsOneModeLiterals(src);
      jsSites += sites;
      for (const o of out) bad.push(`${rel}:${src.slice(0, o.at).split("\n").length} ${o.what} — an inline colour is a look token in both modes (a hover is a class with a stylesheet rule)`);
    }
    expect(jsSites, "anti-vacuity: the colours public/js writes inline are read").toBeGreaterThan(100);
    expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
  });
});
