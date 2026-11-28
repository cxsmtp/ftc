"use strict";

// Achievement-badge image generator (v7.1.0).
//
// Renders the "I placed top-3" LinkedIn share badge — a 1200×627 PNG (the
// LinkedIn link-card ratio) built from a templated SVG and rasterised by
// @resvg/resvg-js. Design: "Editorial Laureate" (operator-chosen) from the
// DESIGN_SYSTEM dark palette.
//
// resvg cannot read woff2 and ignores the variable-weight axis, so we ship
// three STATIC subset Inter weights under lib/fonts/badge/*.ttf, with the Noto
// faces that draw the scripts Inter lacks (FALLBACK_FACES), and load them
// explicitly (loadSystemFonts:false for deterministic output). They live outside
// public/, which anyone may download: no browser reads them, and serving the
// 17 MB CJK face would cost a compression per request.
//
// The competition name + participant display name are USER-CONTROLLED, so
// every interpolated string is XML-escaped before it reaches the SVG.

const fs = require("fs");
const path = require("path");
const { swallowed } = require("./best-effort");

const FONT_DIR = path.join(__dirname, "fonts", "badge");
// ONE FAMILY. The platform type is Inter (operator ruling, 13 Nov 2026), so the
// certificate is set in Inter throughout (the
// name in ExtraBold, the title in SemiBold, the recognition line in Regular).
// Liberation Serif is gone. Inter is SIL OFL 1.1; the licence travels beside the
// files (LICENSE-inter.txt).
const FONT_FILES = ["inter-regular.ttf", "inter-semibold.ttf", "inter-extrabold.ttf"].map(f => path.join(FONT_DIR, f));

// THE FALLBACK FACES (operator ruling, 14 Nov 2026: ship a font covering the
// common scripts). Inter draws Latin, Greek and Cyrillic; these draw Arabic,
// Hebrew, Thai and Chinese, Japanese and Korean. One Bold weight each (the name,
// the text that matters, is ExtraBold). SIL OFL 1.1, unmodified Noto releases:
// LICENSE-noto.txt, with each file's source URL and SHA-256 in SOURCES-noto.txt.
//
// resvg does NOT fall back glyph by glyph. It shapes a line with Inter; at the
// first character Inter lacks it reshapes the WHOLE line with the first of these
// faces that has that character, and keeps the result only if that face drew
// every glyph, or if both shapings gave the same glyph count (it then copies
// the new glyphs in by position). `_drawPlan` models that rule, and admits only
// the case it can be sure of: one face drawing the whole line. `_fontFilesFor`
// hands a render only the faces its SVG needs, in this order, so the face resvg
// finds is the face `_fallbackFaceFor` names.
//
// resvg also advances a cluster (a letter and what joins it) by its WIDEST
// glyph rather than their sum, so a cluster of two spacing glyphs overlaps the
// next letter. That is why no Devanagari face ships (its spacing vowel signs and
// conjuncts share their consonant's cluster: राहुल would print as रहुल), why a
// spacing mark (Mc) is never drawable, and why Thai SARA AM is rewritten before
// it reaches the renderer (`_resvgText`). A face for another script needs the
// legibility arm of tests/badge-fonts.spec.js, against Chromium's shaping, first.
//
// `asc`/`desc` are the tallest and deepest ink each face draws, in em, Latin
// included where it has Latin (the CJK face draws all of "Dr. Åsa 张伟"), MEASURED
// by rendering (tests/badge-fonts.spec.js holds them to the shipped binaries):
// the certificate's name slot was drawn around Inter (ink to ~0.98 em above the
// baseline, ~0.24 em below), and Arabic dots below the line reach further, so
// `_nameExtentEm` makes room for exactly what a name needs. `markAsc` replaces
// `asc` when the name carries one of the face's nonspacing marks: Arabic vowel
// marks stack above the letters, and few typed names use them.
const FALLBACK_FACES = [
  { file: "noto-sans-arabic-bold.ttf", asc: 1.0, markAsc: 1.19, desc: 0.48 },
  { file: "noto-sans-hebrew-bold.ttf", asc: 0.78, desc: 0.25 },
  { file: "noto-sans-thai-bold.ttf", asc: 1.06, desc: 0.28 },
  { file: "noto-sans-cjk-sc-bold.otf", asc: 1.01, desc: 0.27 },
].map(f => Object.freeze({ ...f, path: path.join(FONT_DIR, f.file) }));

const BADGE_W = 1200;
const BADGE_H = 627;

// v7.12.5 — Checkmarx co-brand mark, inlined (white) into the top-right of every badge.
// Read once at module load from the repo's brand asset; a missing/unreadable file
// degrades to "no logo" rather than breaking badge rendering (mirrors the font/resvg
// defensive posture). The two paths carry fill="#FFFFFF" already, but we re-assert it.
const CHECKMARX_LOGO = (() => {
  try {
    const svg = fs.readFileSync(path.join(__dirname, "..", "public", "checkmarx-logo-white.svg"), "utf8");
    const ds = [...svg.matchAll(/<path[^>]*\bd="([^"]+)"[^>]*\/>/g)].map(m => m[1]);
    return ds.length ? { paths: ds, vbW: 1796 } : null;   // logo viewBox: 0 0 1796 455
  } catch { return null; }
})();
// Top-aligned so the VISIBLE glyphs start at `topY` (the art has ~120px top padding in
// its 455-tall viewBox). Returns "" when the asset is unavailable.
function checkmarxLogoGroup(x, topY, width) {
  if (!CHECKMARX_LOGO) return "";
  const s = width / CHECKMARX_LOGO.vbW;
  const y = topY - 120 * s;
  const inner = CHECKMARX_LOGO.paths.map(d => `<path fill="#FFFFFF" d="${d}"/>`).join("");
  return `<g transform="translate(${x} ${y}) scale(${s})">${inner}</g>`;
}

const RANK_LABELS = { 1: "1st Place", 2: "2nd Place", 3: "3rd Place" };

// True for the top-3 placement variant (gold/silver/bronze medal); anything else
// renders the generic "Participant" variant (no rank, no score). Shared by the
// renderer + routes/badge.js so the wire label and the PNG never disagree.
function isPlacementRank(rank) {
  return rank === 1 || rank === 2 || rank === 3;
}

// Does this board entry EARN a Gold, Silver or Bronze certificate? A place in
// the top three with points above zero (operator ruling, 14 Nov 2026): a
// top-three attempter on zero or less is issued participation, as the podium's
// certificate label and the team report's podium already had it. The ONE
// definition: the mint's verdict (routes/badge.js `_mintEligibility`, which
// the automatic issue, the claimable offer and the top-three download's podium
// all read) and the team report call it. The browser's copy is
// `public/js/ui/format.js` `earnsPlacement`, held to this body by
// tests/placement-points.spec.js.
function earnsPlacement(e) {
  return !!e && (e.rank === 1 || e.rank === 2 || e.rank === 3) && typeof e.score === "number" && e.score > 0;
}

// Headline label for a badge: "Nth Place" for the top-3, "Participant" otherwise.
function badgeRankLabel(rank) {
  return isPlacementRank(rank) ? RANK_LABELS[rank] : "Participant";
}

// Per-rank metal palettes (gold / silver / bronze). Ribbon stays brand-purple
// for all three so the badge always reads as Hack Arena.
const RANK_PALETTES = {
  1: { rankFrom: "#FCE08F", rankTo: "#E0A92E", discFrom: "#F7D26A", discMid: "#F4C44A", discTo: "#E0A92E",
       faceFrom: "#FCE08F", faceMid: "#F4C44A", faceTo: "#D49A22", ring: "#FFE9A8", innerRing: "#B8851A",
       dot: "#B8851A", starBg: "#5B3A04", star: "#FFF2C4", scoreFill: "#F4C44A" },
  2: { rankFrom: "#EEF1F6", rankTo: "#9AA0AD", discFrom: "#E4E7EC", discMid: "#C7CBD4", discTo: "#9AA0AD",
       faceFrom: "#F4F6F9", faceMid: "#C7CBD4", faceTo: "#8B919C", ring: "#FFFFFF", innerRing: "#7C828C",
       dot: "#7C828C", starBg: "#363B45", star: "#F7F9FC", scoreFill: "#C7CBD4" },
  3: { rankFrom: "#F2C8A2", rankTo: "#B06C38", discFrom: "#E2A877", discMid: "#D08B52", discTo: "#B06C38",
       faceFrom: "#EEBB8C", faceMid: "#D08B52", faceTo: "#A05C2E", ring: "#FBE6D2", innerRing: "#8A5A33",
       dot: "#8A5A33", starBg: "#4A2A12", star: "#FBE6D2", scoreFill: "#E2A877" },
};

// Generic participation variant — brand-purple seal (no metal), so it reads as
// "took part" and is visually distinct from the gold/silver/bronze placements.
const PARTICIPANT_PALETTE = {
  rankFrom: "#C4B5FD", rankTo: "#7C3AED", discFrom: "#A78BFA", discMid: "#8B5CF6", discTo: "#6D28D9",
  faceFrom: "#C4B5FD", faceMid: "#8B5CF6", faceTo: "#5B21B6", ring: "#DDD6FE", innerRing: "#6D28D9",
  dot: "#6D28D9", starBg: "#3B0F66", star: "#EDE9FE", scoreFill: "#A78BFA",
};

// THAI SARA AM, ready for resvg. The shaper decomposes SARA AM into NIKHAHIT and
// SARA AA, moves the NIKHAHIT back over any above-base marks, and keeps all of it
// in the consonant's cluster, which resvg advances by its widest glyph: กำพล
// would print with its SARA AA under the next letter. Doing that decomposition in the
// text (the shaper's own rule, HarfBuzz preprocess_text_thai) gives the same
// glyphs in the same order, with SARA AA a cluster of its own. Held against
// Chromium's shaping of the original text by tests/badge-fonts.spec.js.
const _THAI_ABOVE_BASE_MARK_RE = /^[\u0E31\u0E34-\u0E37\u0E3B\u0E47-\u0E4E]$/u;
function _resvgText(s) {
  const str = String(s == null ? "" : s);
  if (!str.includes("\u0E33")) return str;
  const out = [];
  for (const ch of str) {
    if (ch !== "\u0E33") { out.push(ch); continue; }
    let i = out.length;
    while (i > 0 && _THAI_ABOVE_BASE_MARK_RE.test(out[i - 1])) i--;
    out.splice(i, 0, "\u0E4D");
    out.push("\u0E32");
  }
  return out.join("");
}

// Every interpolated string is SVG `<text>` content, so it is also made ready
// for resvg's shaper here (`_resvgText`).
function escXml(s) {
  return _resvgText(s)
    .replace(/[\u0000-\u001f\u007f]/g, " ")   // strip control chars
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Greedy word-wrap to at most `maxLines` lines that each fit `maxWidth` px at
// `fontSize`, using an average Inter advance estimate. The final line is
// ellipsised if the text still overflows. Returns an array of (raw) strings.
function wrapToLines(text, fontSize, maxWidth, maxLines, advanceFactor = 0.58) {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * advanceFactor)));
  const ellip = s => s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars) { cur = candidate; continue; }
    if (cur) lines.push(cur);          // flush the full line
    cur = w;                            // a lone word longer than maxChars is ellipsised on output
    if (lines.length === maxLines) { cur = ""; break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const overflowed = lines.join(" ").split(/\s+/).filter(Boolean).length < words.length;
  return lines.slice(0, maxLines).map((ln, i, arr) => {
    if (ln.length > maxChars) return ellip(ln);                       // line itself too long
    if (overflowed && i === arr.length - 1) return ellip(ln);         // words dropped past maxLines
    return ln;
  });
}

// ── Text metrics (v7.15.1) ──────────────────────────────────────────────────
// The single-line badge fields used to be capped by CHARACTER COUNT, which does
// not track rendered width: at 22px, 28 uppercase "M"s are 595px but 28 "I"s are
// 190px. So a platform name that fits the strip with room to spare was still
// ellipsised (the reported bug), while a wide one could have overrun anyway.
//
// We read the real advances out of the Inter TTFs we already ship for resvg
// (hmtx + cmap format 4) and fit to the PIXEL budget instead. Defensive by the
// same doctrine as the resvg loader: any parse failure falls back to a
// deliberately GENEROUS average-advance estimate, so a corrupt or absent font
// shrinks text more than necessary rather than letting it collide.
const _FONT_BY_WEIGHT = { 400: "inter-regular.ttf", 600: "inter-semibold.ttf", 800: "inter-extrabold.ttf" };
const _FALLBACK_ADVANCE_EM = 0.75;   // over-estimates; over-estimating fails safe
const _metricsCache = new Map();

/**
 * Only the tables the metrics need, read at their offsets: the CJK face is 17 MB
 * and its outlines are resvg's business, never this module's.
 */
function _readFaceTables(file, tags) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    const numTables = head.readUInt16BE(4);
    const dir = Buffer.alloc(16 * numTables);
    fs.readSync(fd, dir, 0, dir.length, 12);
    const out = {};
    for (let i = 0; i < numTables; i++) {
      const tag = dir.toString("ascii", i * 16, i * 16 + 4).trim();
      if (!tags.includes(tag)) continue;
      const off = dir.readUInt32BE(i * 16 + 8), len = dir.readUInt32BE(i * 16 + 12);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      out[tag] = buf;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/**
 * One face's coverage and advances (hmtx + cmap). A BMP character is looked up
 * in the format-4 subtable, the last Unicode one, as this module always has; a
 * character beyond the BMP, or a face with no format-4 subtable, in format 12.
 * Null when the file is missing or its tables are not ones this reads.
 */
function _faceMetrics(file) {
  if (_metricsCache.has(file)) return _metricsCache.get(file);
  let m = null;
  try {
    const t = _readFaceTables(file, ["head", "hhea", "hmtx", "cmap"]);
    if (!t.head || !t.hhea || !t.hmtx || !t.cmap) throw new Error("missing font tables");
    const unitsPerEm = t.head.readUInt16BE(18);
    const numH = t.hhea.readUInt16BE(34);
    const hmtx = t.hmtx, c = t.cmap;
    let sub = 0, sub12 = -1;
    for (let i = 0, nt = c.readUInt16BE(2); i < nt; i++) {
      const o = 4 + i * 8, plat = c.readUInt16BE(o), enc = c.readUInt16BE(o + 2);
      const off = c.readUInt32BE(o + 4);
      const fmt = c.readUInt16BE(off);
      if (fmt === 4 && (plat === 0 || (plat === 3 && enc === 1))) sub = off;
      if (fmt === 12 && (plat === 0 || (plat === 3 && enc === 10))) sub12 = off;
    }
    if ((!sub && sub12 < 0) || !unitsPerEm || !numH) throw new Error("unsupported font tables");
    let gid4 = () => 0;
    if (sub) {
      const segX2 = c.readUInt16BE(sub + 6), seg = segX2 / 2;
      const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, roO = deltaO + segX2;
      gid4 = (cp) => {
        // The first segment whose end is at or past `cp` (ends ascend): a
        // binary search, since the CJK face has thousands of segments.
        let lo = 0, hi = seg - 1, i = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (cp > c.readUInt16BE(endO + mid * 2)) lo = mid + 1;
          else { i = mid; hi = mid - 1; }
        }
        if (i < 0) return 0;
        const start = c.readUInt16BE(startO + i * 2);
        if (cp < start) return 0;
        const ro = c.readUInt16BE(roO + i * 2);
        if (ro === 0) return (cp + c.readInt16BE(deltaO + i * 2)) & 0xffff;
        const g = c.readUInt16BE(roO + i * 2 + ro + (cp - start) * 2);
        return g === 0 ? 0 : (g + c.readInt16BE(deltaO + i * 2)) & 0xffff;
      };
    }
    const groups = sub12 >= 0 ? c.readUInt32BE(sub12 + 12) : 0;
    const gid12 = (cp) => {
      let lo = 0, hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, p = sub12 + 16 + mid * 12;
        if (cp < c.readUInt32BE(p)) hi = mid - 1;
        else if (cp > c.readUInt32BE(p + 4)) lo = mid + 1;
        else return c.readUInt32BE(p + 8) + (cp - c.readUInt32BE(p));
      }
      return 0;
    };
    const gidFor = (cp) => ((cp <= 0xffff && sub) ? gid4(cp) : (groups ? gid12(cp) : 0));
    const fallbackGid = gidFor(0x3f) || 0;   // "?" stands in for a glyph the subset lacks
    m = { unitsPerEm, hasGlyph: (cp) => gidFor(cp) !== 0, advanceEm(cp) {
      const g = gidFor(cp) || fallbackGid;
      return hmtx.readUInt16BE(Math.min(g, numH - 1) * 4) / unitsPerEm;
    } };
  } catch { m = null; }
  _metricsCache.set(file, m);
  return m;
}

function _loadFontMetrics(weight) {
  return _faceMetrics(path.join(FONT_DIR, _FONT_BY_WEIGHT[weight] || _FONT_BY_WEIGHT[800]));
}

/**
 * The fallback face that draws `cp` — the first in FALLBACK_FACES that has it,
 * as resvg picks — or null. Only asked for a character Inter lacks. A face whose
 * file is missing or unreadable draws nothing, so it is never answered here.
 */
const _fallbackMemo = new Map();
function _fallbackFaceFor(cp) {
  if (_fallbackMemo.has(cp)) return _fallbackMemo.get(cp);
  let hit = null;
  for (const f of FALLBACK_FACES) {
    const m = _faceMetrics(f.path);
    if (m && m.hasGlyph(cp)) { hit = { face: f, metrics: m }; break; }
  }
  // A pure answer per code point; bounded so a stream of distinct characters
  // cannot grow it without limit.
  if (_fallbackMemo.size >= 8192) _fallbackMemo.clear();
  _fallbackMemo.set(cp, hit);
  return hit;
}

// Characters a shaper draws as nothing (ZWNJ inside a Persian name, a variation
// selector): no font needs a glyph for them.
const _IGNORABLE_RE = /^\p{Default_Ignorable_Code_Point}$/u;

// Characters that never send resvg to another face: whitespace (its shaper draws
// a space a face lacks with that face's own space) and the default-ignorables.
const _passesAnyFace = (ch) => /\s/.test(ch) || _IGNORABLE_RE.test(ch);

/**
 * WHICH FACE DRAWS THIS ONE LINE of SVG text, by resvg's own rule (see
 * FALLBACK_FACES): `{ face: null }` when Inter draws every character; `{ face,
 * metrics }` when the characters Inter lacks all send resvg to that one fallback
 * face and it draws every character of the line, Inter's included ("Dr. 张伟" is
 * all the CJK face's, Latin and all); `null` when resvg would not draw it right:
 *   - the characters Inter lacks need two faces, or the face lacks a character
 *     of the line: resvg then keeps the face's glyphs only where its glyph COUNT
 *     happens to match Inter's, and a ligature cannot be predicted here ("Dr.
 *     محمد علي" and "Anna علي" print .notdef boxes);
 *   - a character no face draws (Georgian, Tamil, an emoji), or a control
 *     character (the renderer would print a space);
 *   - a spacing mark (Mc), whose cluster resvg advances by its widest glyph.
 * Judged on the text `_resvgText` sends. `{ face: null, unknown: true }` when
 * Inter's metrics cannot be read. The three Inter files share one character set,
 * so `weight` changes only whose advances `metrics` would give.
 */
function _drawPlan(text, weight = 800) {
  const m = _loadFontMetrics(weight);
  if (!m) return { face: null, unknown: true };
  const chars = [..._resvgText(text)];
  let fb = null;
  for (const ch of chars) {
    if (_passesAnyFace(ch)) continue;
    if (/^[\p{Mc}\p{Cc}]$/u.test(ch)) return null;
    const cp = ch.codePointAt(0);
    if (m.hasGlyph(cp)) continue;
    const f = _fallbackFaceFor(cp);
    if (!f || (fb && fb.face !== f.face)) return null;
    fb = f;
  }
  if (!fb) return { face: null };
  for (const ch of chars) {
    if (_IGNORABLE_RE.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (fb.metrics.hasGlyph(cp)) continue;
    if (/\s/.test(ch) && fb.metrics.hasGlyph(0x20)) continue;
    return null;
  }
  return { face: fb.face, metrics: fb.metrics };
}

const _MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
/** "12 March 2026", in UTC — the badge's date line. */
function badgeDateLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// A name part WRITTEN IN Han, kana or Hangul: every character but whitespace is
// one of those scripts, by Script_Extensions (so the prolonged sound mark ー and
// the iteration mark 々 count), and there is at least one.
const _CJK_NAME_CHAR_RE = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]$/u;
function _isCjkNamePart(s) {
  let any = false;
  for (const ch of String(s == null ? "" : s)) {
    if (/\s/.test(ch)) continue;
    if (!_CJK_NAME_CHAR_RE.test(ch)) return false;
    any = true;
  }
  return any;
}

// v7.21.27 — "Salutation First Last", for the certificate.
//
// The share BADGE keeps the nickname: it is the leaderboard handle and the thing
// a LinkedIn audience recognises. A certificate is a formal record of who did
// the thing, so it carries the person's actual name. Salutation is optional
// ("Prefer not to say" stores empty), so the parts are joined and collapsed
// rather than assembled positionally.
//
// FAMILY NAME FIRST, WITH NO SPACE, when both parts are written in Han, kana or
// Hangul (operator ruling, 14 Nov 2026): 伟 / 张 prints 张伟, 太郎 / 田中 prints
// 田中太郎, 민준 / 김 prints 김민준. Any other pair, a Latin given name with a Han
// family name included, keeps given name first with a space. The salutation,
// when there is one, still leads. Only the ORDER moves: the parts the credential
// lookup matches (`certificateNameParts`) are the same either way.
function certificateName({ personalTitle, firstName, lastName, certificateGivenName, certificateFamilyName } = {}) {
  // v8.1.0 (PR 24) — the CERTIFICATE name wins when it is set.
  //
  // BOTH parts are required for the override, deliberately: a half-filled pair
  // would silently mix a certificate given name with a profile surname, which is
  // the one combination nobody typed and nobody could predict. Either the person
  // stated how their name should appear on the certificate, or they did not.
  const g = String(certificateGivenName == null ? "" : certificateGivenName).trim();
  const f = String(certificateFamilyName == null ? "" : certificateFamilyName).trim();
  const usingCertName = !!(g && f);
  const trim = (v) => String(v == null ? "" : v).trim();
  const given = usingCertName ? g : trim(firstName);
  const family = usingCertName ? f : trim(lastName);
  if (!given && !family) return "";           // a salutation alone names nobody
  const name = (_isCjkNamePart(given) && _isCjkNamePart(family)) ? [`${family}${given}`] : [given, family];
  return [trim(personalTitle), ...name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * THE NAME A CERTIFICATE PRINTS for a user row, and whether it fell back to
 * `nickname`: `{ displayName, fallback }`, plus `salutationDropped: true` when
 * the salutation was left off (the share dialog says so). The one rule: the certificate, the
 * share card, the emailed PDF, the public page and /credential all read it
 * (routes/badge.js `_badgeName`), and so do the two places the app shows the
 * name a certificate would print before one exists (the admin board's
 * `certificatePrintedName`, the account's `certificate_printed_name`).
 *
 * The name is `certificateName`'s, printed only when the badge fonts can draw it
 * (`canRenderText`). When they cannot and a SALUTATION is what stands in the way
 * — a Latin "Dr." before an Arabic, Hebrew or Thai name, which resvg would draw
 * as empty boxes — the name prints without it (operator ruling, 14 Nov 2026).
 * Only the salutation is ever dropped, never another part or character: any
 * other name the fonts cannot draw ("Anna علي", a Devanagari name) prints
 * `nickname`, as does no usable name at all. The parts the credential lookup
 * matches never held the salutation, so dropping it moves nothing there.
 *
 * `fallbackFaces: false` is the coverage a certificate minted with the nickname
 * before the Noto faces shipped keeps (routes/badge.js `_mintedWithNickname`):
 * Inter alone, under the rule of that day, a whole name or the nickname, so such
 * a certificate keeps printing the nickname its lookup matches.
 */
function certificatePrintedName(user, nickname, { fallbackFaces = true } = {}) {
  const fields = {
    personalTitle: user && user.personal_title,
    firstName: user && user.first_name,
    lastName: user && user.last_name,
    // v8.1.0 (PR 24) — the certificate name wins when the participant set one.
    certificateGivenName: user && user.certificate_given_name,
    certificateFamilyName: user && user.certificate_family_name,
  };
  const full = certificateName(fields);
  if (full && canRenderText(full, { fallbackFaces })) return { displayName: full, fallback: false };
  if (full && fallbackFaces) {
    const bare = certificateName({ ...fields, personalTitle: "" });
    if (bare && bare !== full && canRenderText(bare)) return { displayName: bare, fallback: false, salutationDropped: true };
  }
  return { displayName: nickname, fallback: true };
}

/**
 * The two name PARTS the credential lookup will be matched against, frozen at
 * mint by PR 25. Kept beside `certificateName` so the printed name and the
 * matched parts can never come from different sources — which is the whole
 * failure mode `name_match_snapshot` exists to prevent.
 *
 * Returns `null` when there is no usable name, so a caller must decide rather
 * than storing an empty match key that would accept an empty surname.
 */
function certificateNameParts({ firstName, lastName, certificateGivenName, certificateFamilyName } = {}) {
  const g = String(certificateGivenName == null ? "" : certificateGivenName).trim();
  const f = String(certificateFamilyName == null ? "" : certificateFamilyName).trim();
  const given = (g && f) ? g : String(firstName == null ? "" : firstName).trim();
  const family = (g && f) ? f : String(lastName == null ? "" : lastName).trim();
  if (!given && !family) return null;
  return { given, family };
}

/**
 * THE FOLD used to compare a typed surname against a certificate's frozen name.
 *
 * A verifier is reading a name off paper and typing it, so the comparison has to
 * survive the differences that act of copying introduces — case, diacritics they
 * cannot type, and whether they keep the hyphen in a compound surname. It must
 * NOT survive a different name.
 *
 * Order is deliberate. NFKD then stripping combining marks folds `García` onto
 * `Garcia`, which a keyboard without the accent cannot otherwise produce. Then
 * upper-THEN-lower (the v7.15.7 approximation of full case folding) rather than a
 * bare `toLowerCase`, because that is what folds `Straße`/`STRASSE` together and
 * collapses Greek final sigma. Then everything that is not a letter or digit
 * goes, so `Doe-Smith`, `Doe Smith` and `doesmith` are one key.
 *
 * NOT STORED. `name_match_snapshot` freezes the name PARTS, never these keys —
 * frozen keys would freeze this algorithm at mint, and improving it would then
 * need a backfill over every certificate ever issued.
 */
/**
 * v8.1.0 (PR 25) — the label a badge carries, given how it was earned.
 *
 * `basis` is stored from this release on; a pre-v8.1.0 row has NULL and falls
 * back to deriving it from the rank exactly as before, so every existing badge
 * renders and reads identically.
 */
function badgeBasisLabel(basis, rank) {
  if (basis === "completion") return "Completed";
  // v8.15.0 — a PARTICIPATION basis is what the mint decided, and it wins over
  // the rank stored beside it. A late entrant minted while the late window is
  // open gets participation whatever their late-board rank (routes/badge.js
  // `_mintEligibility`), and that rank is frozen too — so reading the rank here
  // printed "1st Place" on a certificate the mint had refused to make a placing.
  if (basis === "participation") return "Participant";
  return badgeRankLabel(rank);
}

/**
 * Does this certificate attest a top-three PLACING? Read from `certificateTier`
 * (lib/certificate-config.js), the one rule: the frozen basis first, the rank
 * second, as `badgeBasisLabel` labels it — so a surface that branches on it can
 * never splice "Participant" or "Completed" into a placement sentence, nor draw
 * a medal for one. A late entrant minted while the window is open has basis
 * `participation` and a podium rank stored beside it; a Program completer has
 * basis `completion` and a board rank; neither is a placing. A legacy row
 * (basis NULL) derives it from the rank, as before.
 */
function isPlacementBasis(basis, rank) {
  const tier = certificateTier({ basis, rank });
  return tier === "gold" || tier === "silver" || tier === "bronze";
}

// v8.1.0 (PR 27) — the alphabet and length of a printed verification code.
//
// ONE-WAY DOOR: these are stamped onto PDFs that leave the building, so changing
// either later cannot reach a certificate already issued.
//
// Crockford base32 minus I, L, O and U — the same set the emailed sign-in codes
// use (v7.29.0) and for the same reason: this is read off paper and typed by a
// stranger, so the pairs that get misread must not exist. 12 characters is ~60
// bits, which is the secret; the surname is a second factor, not the entropy.
// v8.1.0 (PR 32) — the alphabet, the normaliser and the generator moved to
// `lib/human-code.js` when the Booth Event join code became the SECOND surface
// minting codes a human types. Two hand-written Crockford tables would agree on
// the day they were written and diverge silently afterwards, and the failure is
// invisible: one surface folds a mistyped `O` and the other does not, so the
// code "just doesn't work". These names are kept as the credential-specific
// bindings so every existing caller and lock is untouched.
const { HUMAN_CODE_ALPHABET: CREDENTIAL_ALPHABET, normaliseHumanCode, generateHumanCode, formatHumanCode } = require("./human-code");
// v8.8.14 — the stroked/ligature table, SHARED with nickname generation. Its
// header in lib/util.js says why the table is shared and the function is not.
const { _XLIT_MAP } = require("./util");
const CREDENTIAL_CODE_LEN = 12;

const normaliseCredentialCode = normaliseHumanCode;
/** A fresh code. Caller retries on the (astronomically unlikely) unique clash. */
const generateCredentialCode = (randomBytes) => generateHumanCode(randomBytes, CREDENTIAL_CODE_LEN);
/** How the code is PRINTED: grouped, because 12 characters in a row are miscopied. */
const formatCredentialCode = (code) => formatHumanCode(code, 4);

/**
 * Fold a name to the key a verifier's typing has to reach.
 *
 * v8.8.14 — THE STROKED LETTERS FOLD NOW, AND THAT WAS A GENUINE CERTIFICATE
 * READING AS FORGED. NFKD decomposes a letter into base + combining mark, so
 * stripping marks handles García/Garcia and Müller/Muller for free — but ø, ł,
 * đ and þ have NO canonical decomposition, so `Løvland` folded to `løvland`
 * and never matched the `Lovland` printed on the employer's screen. Measured
 * before the fix: 8 of 13 real Norwegian, Polish, Serbian, Icelandic, Maltese
 * and ligature names failed, while every accent case passed. The holder could
 * then burn the 10/hour per-code budget proving their own certificate real.
 *
 * IT APPLIES RETROACTIVELY TO EVERY CERTIFICATE EVER MINTED, with no migration
 * and no backfill — which is v8.1.0 (PR 25) being paid back exactly as designed.
 * `name_match_snapshot` freezes the PARTS and deliberately not the folded keys,
 * on the stated grounds that "teaching the fold a script it mishandles would
 * need a backfill over every certificate ever issued". This is that teaching.
 *
 * THE TAIL KEEPS UNICODE, AND THAT IS THE HALF NOT TO "SIMPLIFY". The obvious
 * implementation reuses `_transliterateAscii`, which ends by stripping to
 * [a-z0-9] — measured, that folds Παπαδόπουλος, Иванов and 李 to the EMPTY
 * STRING, and an empty key is dropped by `credentialMatchKeys`, so those
 * certificates would match NOTHING. A non-Latin surname must fold to itself.
 *
 * THE TABLE IS APPLIED LAST, AND THAT ORDERING IS THE WHOLE SUBTLETY. This
 * change's first draft applied it FIRST, which looks equivalent and is not: a
 * PRECOMPOSED letter that only becomes a table key after decomposing — Ǿ, Ǣ and
 * their case pairs, the Old Norse ø/æ carrying an acute or a macron — is not
 * itself in the table, so it sailed past the map, decomposed to `ø` + mark one
 * step later, and was never folded. MEASURED over every codepoint to U+2FFF:
 * the original fold had ZERO normalisation-invariance violations and that draft
 * introduced SIX, so `Sǿrensen` typed in NFC and the same name in NFD produced
 * DIFFERENT keys — a certificate unverifiable against its own name in the other
 * encoding, with a spurious "the holder's name has changed" beside it.
 *
 * Applying the table after every step that can only turn a letter INTO one of
 * its keys — the mark-strip and the case dance — is what makes the fold a
 * fixed point. Measured again: normalisation-invariance 0 and idempotence 0,
 * where the ORIGINAL fold was 0 and 1. Strictly better than what it replaced,
 * and the lock sweeps for both properties rather than trusting this paragraph.
 *
 * Lowercasing FIRST keeps the table lowercase-keyed. The
 * `toUpperCase().toLowerCase()` in the middle is untouched and still
 * load-bearing: v7.15.7's approximation of full case folding, and what collapses
 * Greek final sigma (ς/Σ). It also already turns ß into `ss`, so the table's own
 * ß entry is redundant here and harmless — it is the nickname path that needs it.
 *
 * ü -> ue IS STILL NOT IN THIS FOLD, and v8.8.18 did not put it here. The
 * mark-strip answers ü as `u`, so Müller/Muller matches; mapping it to `ue`
 * INSTEAD would break that in order to fix Müller/Mueller, because the two
 * spellings cannot both be ONE key. v8.8.14 recorded the shape that serves both
 * — emit them as ALTERNATIVES — and called it a policy question nobody had
 * asked. The operator asked on 7 September 2026, so it is answered in
 * `credentialMatchKeys` (a second key) and not here (a changed key). This
 * function is still the single canonical fold, and everything v8.8.14 measured
 * about its ORDER is untouched.
 */
function credentialNameKey(value) {
  // The table is applied LAST of the folding steps — see THE ORDER above. Every
  // earlier step can only turn a letter INTO one of its keys, never out of one.
  const folded = String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .toUpperCase().toLowerCase();
  let mapped = "";
  for (const ch of folded) mapped += (_XLIT_MAP[ch] || ch);
  return mapped.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The letters whose PRIMARY fold drops to a bare vowel and which have a standard
 * digraph spelling for when the diacritic cannot be typed.
 *
 * v8.8.18. THE MEMBERSHIP RULE IS NARROW AND IS THE WHOLE DESIGN: a letter
 * belongs here only if `credentialNameKey` already folds it to a BARE VOWEL and
 * a conventional two-letter spelling exists. So ä/ö/ü (German), å (Danish
 * Aagaard) and ø (Norwegian Soerensen) are in. æ/œ/ß are NOT — `_XLIT_MAP`
 * already folds them to ae/oe/ss, so the digraph IS their primary key and a
 * second one would be identical. And nothing is added just because it looks
 * similar: `þ` folds to `th` already, and there is no convention that spells a
 * stroked `đ` as two letters.
 *
 * NOT a widening of the fold — `credentialNameKey` is unchanged, and this
 * produces an ADDITIONAL key. That distinction is the point: a fold change
 * trades one spelling away for another (Müller/Muller for Müller/Mueller, which
 * is exactly why v8.8.14 refused it), whereas a second key serves both.
 */
const _DIGRAPH_MAP = { "ä": "ae", "ö": "oe", "ü": "ue", "å": "aa", "ø": "oe" };

/**
 * The same fold, with the digraph expansion applied first.
 *
 * NFC BEFORE THE MAP, AND THAT IS LOAD-BEARING. `ü` reaches this function as
 * either U+00FC or `u` + U+0308 depending on how the name was typed and stored,
 * and only the composed form is a key here. Composing first makes both encodings
 * hit the map, so the alternate key is normalisation-invariant exactly as
 * v8.8.14 measured the primary one to be — the property that release's own first
 * draft broke by applying a table at the wrong point.
 *
 * It then delegates, rather than reimplementing the pipeline: a second copy of
 * the mark-strip and the case dance is one edit away from disagreeing with the
 * canonical fold about a name neither author thought of.
 *
 * For a name containing none of these letters it returns exactly what
 * `credentialNameKey` returns, so the caller's Set simply dedupes it away.
 */
function credentialNameKeyDigraph(value) {
  const src = String(value == null ? "" : value).toLowerCase().normalize("NFC");
  let expanded = "";
  for (const ch of src) expanded += (_DIGRAPH_MAP[ch] || ch);
  return credentialNameKey(expanded);
}

/**
 * Every folded surname that counts as "the right name" for one certificate.
 *
 * The whole family name, plus each of its tokens when it has more than one — so
 * a compound surname can be verified by someone who types only the part they
 * were given, which is the common case for `García Hernández` and for a hyphen
 * a verifier drops. The GIVEN name is deliberately not a key: the lookup asks
 * for a surname, and accepting either half would double the guessing surface for
 * no benefit a verifier actually needs.
 *
 * A name PRINTED AS ONE WORD is also a key whole, as printed (operator ruling,
 * 14 Nov 2026): both parts in Han, kana or Hangul, which `certificateName` prints
 * family name first with no space (伟 / 张 prints 张伟), so a verifier cannot see
 * where the surname ends. It is composed from the frozen parts by that same rule,
 * so it reaches certificates already issued; any other pair gains nothing, and
 * the given name alone (伟) is still no key. The parts never hold the
 * salutation, so "Dr. 张伟" is no key: the page's hint says to leave it out.
 *
 * Returns an EMPTY set when there is no usable family name, so a certificate
 * minted without one matches nothing rather than matching everything — an empty
 * key must never be satisfied by an empty typed value.
 */
function credentialMatchKeys(parts) {
  const out = new Set();
  const family = parts && parts.family;
  if (!family) return out;

  // v8.8.18 — BOTH SPELLINGS, as alternatives. `add` emits the canonical fold
  // and its digraph expansion; for a name with none of those letters the two are
  // identical and the Set collapses them, so every existing certificate keeps
  // exactly the key set it had.
  const add = (v) => {
    const k = credentialNameKey(v);
    if (k) out.add(k);
    const d = credentialNameKeyDigraph(v);
    if (d) out.add(d);
  };

  add(family);
  // The TOKENS are split from the raw family name and expanded individually, not
  // sliced out of a folded string: `ue` is two characters where `ü` was one, so
  // splitting after expansion would put the boundaries in the wrong places on a
  // compound name.
  const raw = String(family).split(/[\s\-\u2010-\u2015]+/u).filter(t => credentialNameKey(t));
  if (raw.length > 1) for (const t of raw) add(t);
  // The whole name printed as one word (张伟): see above.
  if (_isCjkNamePart(parts.given) && _isCjkNamePart(family)) add(certificateName({ firstName: parts.given, lastName: family }));
  return out;
}

/**
 * Can the badge fonts actually DRAW this string?
 *
 * Nicknames are ASCII-restricted by platform rule; NAMES are full Unicode. Inter
 * draws Latin, Greek and Cyrillic and FALLBACK_FACES add Arabic, Hebrew, Thai,
 * Chinese, Japanese and Korean, each drawing a whole line by itself (`_drawPlan`:
 * resvg's rule). A name in any other script (Devanagari, Georgian, Tamil, an
 * emoji), or one mixing Latin into Arabic, Hebrew or Thai ("Dr. محمد علي"),
 * would rasterise as blank boxes or overlapping glyphs — a certificate naming
 * nobody, or misspelling them, which is worse than one carrying the nickname. An
 * UNKNOWN answer is treated as renderable: if metric parsing ever fails, every
 * certificate must not silently regress to nicknames. This answers for the text
 * it is given; which name a certificate prints, a salutation dropped included,
 * is `certificatePrintedName`'s decision.
 *
 * `fallbackFaces: false` asks what Inter alone could draw, by the rule of the day
 * (every character but whitespace in Inter): the decision a certificate minted
 * before the fallback faces shipped was frozen under (routes/badge.js
 * `_badgeArt`), which keeps such a certificate printing the name its credential
 * lookup matches.
 */
function canRenderText(text, { fallbackFaces = true } = {}) {
  const m = _loadFontMetrics(800);
  if (!m || typeof m.hasGlyph !== "function") return true;
  if (fallbackFaces) return _drawPlan(text) !== null;
  for (const ch of String(text == null ? "" : text)) {
    if (/\s/.test(ch)) continue;
    if (!m.hasGlyph(ch.codePointAt(0))) return false;
  }
  return true;
}

/**
 * How much further than Inter a name's ink reaches, in em: `above` past the
 * ~0.98 em the slot leaves over the baseline, `below` past Inter's 0.24 em.
 * Zero for a name Inter draws alone, so every Latin, Greek and Cyrillic layout
 * is exactly what it was; otherwise the face that draws the name
 * (FALLBACK_FACES `asc`/`desc`) decides. Every line of the name is drawn by
 * Inter or by that same face, so its reach covers them all.
 */
const _SLOT_ASC_EM = 0.98, _SLOT_DESC_EM = 0.24;
function _nameExtentEm(text) {
  const plan = _drawPlan(text);
  if (!plan || !plan.face) return { above: 0, below: 0 };
  const f = plan.face;
  const asc = (f.markAsc && /\p{Mn}/u.test(String(text == null ? "" : text))) ? f.markAsc : f.asc;
  return { above: Math.max(0, asc - _SLOT_ASC_EM), below: Math.max(0, f.desc - _SLOT_DESC_EM) };
}

/** Rendered width in px of `text` at `fontSize`, including SVG letter-spacing. */
function measureText(text, fontSize, weight = 800, letterSpacing = 0) {
  // What reaches the renderer (`_resvgText`), measured in the face that draws it.
  const chars = [..._resvgText(text)];
  if (!chars.length) return 0;
  const m = _loadFontMetrics(weight);
  const plan = m ? _drawPlan(text, weight) : null;
  let em = 0;
  for (const ch of chars) {
    // Inter's metrics unreadable: the generous stand-in, which fails safe.
    if (!m) { em += _FALLBACK_ADVANCE_EM; continue; }
    const cp = ch.codePointAt(0);
    // One fallback face draws the whole line, Inter's characters included.
    if (plan && plan.face) { em += plan.metrics.advanceEm(cp); continue; }
    if (m.hasGlyph(cp)) { em += m.advanceEm(cp); continue; }
    // A line no single face draws: each character in the face that has it; one
    // no face draws keeps the old stand-in ("?").
    const f = _fallbackFaceFor(cp);
    em += f ? f.metrics.advanceEm(cp) : m.advanceEm(cp);
  }
  // SVG letter-spacing is applied after every glyph except (visually) the last.
  return em * fontSize + letterSpacing * (chars.length - 1);
}

/**
 * Fit `text` into `maxWidth` px: keep it whole at `size` if it fits, else step
 * the font down to `minSize`, and only ellipsise when even the smallest legible
 * size overflows. Returns the string to render + the size to render it at.
 */
function fitToWidth(text, { maxWidth, size, minSize = size, weight = 800, letterSpacing = 0 }) {
  const raw = String(text == null ? "" : text);
  for (let s = size; s >= minSize; s--) {
    if (measureText(raw, s, weight, letterSpacing) <= maxWidth) return { text: raw, size: s };
  }
  const chars = [...raw];
  const fits = (n) => measureText(chars.slice(0, n).join("").trimEnd() + "…", minSize, weight, letterSpacing) <= maxWidth;
  let lo = 0, hi = chars.length;
  while (lo < hi) {                       // largest prefix whose ellipsised form fits
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return { text: chars.slice(0, lo).join("").trimEnd() + "…", size: minSize };
}

/**
 * Build the badge SVG string.
 * @param {object} o
 * @param {string} o.platformName  Platform wordmark (e.g. "Checkmarx Hack Arena").
 * @param {number} o.rank          1, 2 or 3 → placement variant; anything else → participant variant.
 * @param {string} o.competitionName
 * @param {string} o.displayName   The name DRAWN on the artwork. `_badgeArt`
 *                                 (routes/badge.js) composes it live as
 *                                 "Salutation First Last"; the nickname is the
 *                                 FALLBACK, used only when the badge fonts
 *                                 cannot draw the name (v8.1.1).
 * @param {string|null} o.dateLabel  Pre-formatted competition date (e.g. "6 Jun 2026").
 * @param {string|null} o.scoreLabel Pre-formatted score (e.g. "450 pts") or null to omit.
 *                                   Ignored for the participant variant (always score-less).
 */
/**
 * The SHARE badge: the same design as the certificate, on LinkedIn's OpenGraph
 * canvas (1200x627).
 *
 * Two canvases rather than one, deliberately. A 3:2 certificate posted to
 * LinkedIn is cropped or letterboxed by the card, and an OG-shaped certificate
 * wastes half an A4 page. The blurb, the laurel and the tagline are dropped here
 * — there is no room for them at this height and they carry no participant data.
 */
/**
 * v8.6.0 — the LATE-ENTRANT stat column, declared ONCE and pushed by BOTH SVG
 * builders.
 *
 * The two builders already carry a byte-for-byte duplicate of the headline/sub
 * label decision with nothing holding them together, and the failure mode is
 * silent and asymmetric: change one and the share PNG says "late entrant" while
 * the printed certificate does not, or the reverse. A certificate is required to
 * "explicitly say late entrant", so the two must not be able to disagree — hence
 * one declaration, and a scanner (*The mechanical locks*) that fails if either
 * builder stops pushing it.
 *
 * A STAT COLUMN rather than a word appended to `sub`, and that is a layout
 * decision rather than a preference. Both builders lay the bottom row out as
 * `ROW_W / cols.length` and fit each VALUE to its own column, so a fourth column
 * is handled by arithmetic that already exists — where `sub` is rendered at a
 * fixed size with no fitter, and "TOP-3 FINISHER — LATE ENTRY" at 12px with 1.4
 * letter-spacing would run into the next column. It also reads at the same weight
 * as the score and the date, which is what "explicitly" asks for.
 */
const LATE_ENTRY_STAT = Object.freeze({ label: "ENTRY", value: "LATE ENTRANT", fill: "#E8E4F2" });
// PER-SESSION QUESTION SETS (owner decision, 27 Nov 2026) — the board a PLACE was
// on, for a Competition ranking per session, overall or both: a stat column of
// the certificate (`o.board`: "Overall" or the session's name, frozen at mint)
// for the reason `LATE_ENTRY_STAT` is one — the bottom row fits each value to its
// own column, where `sub` has no fitter. Drawn only beside a placement, and only
// when the badge fonts can draw the name (an organiser typed it).
const BOARD_STAT_LABEL = "LEADERBOARD";
/**
 * A frozen percentage in tenths ("score_permille", "grade_permille" style) as
 * a board shows it: 1000 -> "100%", 875 -> "87.5%". The one wording for a
 * certificate's percentage score, shared by the routes and the mail.
 */
function permilleText(pm) { return `${pm / 10}%`; }

// Program grades (27 Nov 2026) — the grade a certificate was issued with, as both
// builders read it (`o.grade`: `{band, label, percent}` from routes/badge.js
// `_frozenGrade`), or null: absent, or a band this build does not know.
function _gradeOf(o) {
  const g = o && o.grade;
  if (!g || typeof g.band !== "string" || typeof g.label !== "string" || typeof g.percent !== "string") return null;
  return g;
}

function buildBadgeSvg(o) {
  // The frozen basis wins over the rank (isPlacementBasis, the certificate
  // tier's rule): a completion or participation certificate is drawn in the
  // participant palette whatever board rank was stored beside it, so a Program
  // completer's card never shows the placing that kind does not rank.
  const placement = isPlacementBasis(o.basis, o.rank);
  const p = placement ? RANK_PALETTES[o.rank] : PARTICIPANT_PALETTE;
  // v8.1.0 (PR 25) — a COMPLETION certificate says what it attests. "Participant"
  // would understate it (that label exists for someone who merely attempted) and
  // a rank label would publish a placing the platform refuses to show anywhere
  // else for this kind. `basis` is absent on every pre-v8.1.0 caller, so both
  // existing variants are byte-identical.
  const completion = o.basis === "completion";
  // Program grades (27 Nov 2026): a graded completion certificate names its band
  // and prints its percentage beside it; one issued without a grade is unchanged.
  const graded = completion && _gradeOf(o);
  const headlineLabel = graded ? graded.label : (completion ? "Completed" : (placement ? RANK_LABELS[o.rank] : "Participant"));
  const subLabel = graded ? "PROGRAM COMPLETED" : (completion ? "ALL CHALLENGES SOLVED" : (placement ? "TOP-3 FINISHER" : "PARTICIPATED"));

  const COL_CX = 430;                       // centre of the text column
  // Budget = the real gap from x=126 to the medallion's glow (990 - 148*0.62),
  // less a little clearance. Capping it lower than the space available is what
  // made a long-but-fittable platform name ellipsise (v7.15.1's original bug).
  const platformFit = fitToWidth((o.platformName || "Hack Arena").toUpperCase(),
    { maxWidth: 740, size: 16, minSize: 11, weight: 700, letterSpacing: 2.2 });
  const headFit = fitToWidth(CERT_HEADLINE, { maxWidth: 640, size: 34, minSize: 22, weight: 800, letterSpacing: 2.4 });
  const compSize = 23;
  const compLines = wrapToLines(String(o.competitionName || "").toUpperCase(), compSize, 640, 2);
  // Same fixed-slot treatment as the certificate; see there for why.
  const SLOT_TOP = 298, SLOT_BOTTOM = 478;
  const nameBudget = (SLOT_BOTTOM - SLOT_TOP) - (34 + 16 + compLines.length * 30);
  // Room for a script whose ink reaches past Inter's (none for Latin).
  const nx = _nameExtentEm(o.displayName || "");
  const nameFit = fitNameLines(o.displayName || "", {
    maxWidth: 640, size: 58, minSize: 16, weight: 800, letterSpacing: -0.8, heightBudget: nameBudget,
    extraEm: nx.above + nx.below,
  });
  const nameBaselines = nameFit.lines.map((_, i) => SLOT_TOP + nameFit.size * (1 + nx.above) + i * nameFit.lineHeight);
  const nameBottom = nameBaselines[nameBaselines.length - 1];
  const forY = nameBottom + nameFit.size * nx.below + 34;
  const compTop = forY + 16;
  const compY = compLines.map((_, i) => compTop + compSize + i * 30);

  const cols = [{ label: "ACHIEVEMENT UNLOCKED", value: headlineLabel, fill: "url(#ranktext)", sub: subLabel }];
  if (placement && o.scoreLabel != null) cols.push({ label: "SCORE", value: o.scoreLabel, fill: p.scoreFill });
  if (graded) cols.push({ label: "GRADE", value: graded.percent, fill: p.scoreFill });
  cols.push({ label: "DATE", value: o.dateLabel || "", fill: "#E8E4F2" });
  if (o.lateEntrant) cols.push({ ...LATE_ENTRY_STAT });
  const ROW_X = 96, ROW_W = 1008;
  const colW = ROW_W / cols.length;
  const statCols = cols.map((c, i) => {
    const x = ROW_X + i * colW;
    const vFit = fitToWidth(c.value, { maxWidth: colW - 40, size: 26, minSize: 15, weight: 800, letterSpacing: -0.3 });
    const sep = i === 0 ? "" :
      `<line x1="${(x - 20).toFixed(1)}" y1="512" x2="${(x - 20).toFixed(1)}" y2="600" stroke="#FFFFFF" stroke-opacity="0.10"/>`;
    const sub = c.sub
      ? `<text x="${x}" y="596" font-family="Inter" font-size="12" font-weight="600" letter-spacing="1.4" fill="#A78BFA">${escXml(c.sub)}</text>` : "";
    return `${sep}
  <text x="${x}" y="534" font-family="Inter" font-size="12" font-weight="600" letter-spacing="2" fill="#8B87A8">${escXml(c.label)}</text>
  <text x="${x}" y="572" font-family="Inter" font-size="${vFit.size}" font-weight="800" letter-spacing="-0.3" fill="${c.fill}">${escXml(vFit.text)}</text>
  ${sub}`;
  }).join("\n  ");

  const compText = compLines.map((ln, i) =>
    `<text x="${COL_CX}" y="${compY[i]}" text-anchor="middle" font-family="Inter" font-size="${compSize}" font-weight="800" letter-spacing="0.3" fill="#A78BFA">${escXml(ln)}</text>`
  ).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_W}" height="${BADGE_H}" viewBox="0 0 ${BADGE_W} ${BADGE_H}">
  ${badgeDefs(p)}

  <rect width="${BADGE_W}" height="${BADGE_H}" fill="url(#bg)"/>
  <rect width="${BADGE_W}" height="${BADGE_H}" fill="url(#glow)"/>
  <rect x="28" y="24" width="1144" height="579" rx="16" fill="none" stroke="#A78BFA" stroke-opacity="0.28"/>
  <polygon points="28,24 90,24 28,86" fill="url(#accentbar)" fill-opacity="0.9"/>
  <polygon points="1172,603 1110,603 1172,541" fill="url(#accentbar)" fill-opacity="0.9"/>

  ${checkmarxLogoGroup(96, 96, 190)}
  <rect x="98" y="136" width="10" height="10" rx="2" fill="url(#brandtext)" transform="rotate(45 103 141)"/>
  <text x="126" y="147" font-family="Inter" font-size="${platformFit.size}" font-weight="700" letter-spacing="2.2" fill="url(#brandtext)">${escXml(platformFit.text)}</text>

  <text x="96" y="216" font-family="Inter" font-size="${headFit.size}" font-weight="800" letter-spacing="2.4" fill="#F5F3FF">${escXml(headFit.text)}</text>
  ${ruleWithDiamond(96, 764, 244)}

  <line x1="250" y1="284" x2="330" y2="284" stroke="#FFFFFF" stroke-opacity="0.14"/>
  <line x1="530" y1="284" x2="610" y2="284" stroke="#FFFFFF" stroke-opacity="0.14"/>
  <text x="${COL_CX}" y="289" text-anchor="middle" font-family="Inter" font-size="13" font-weight="600" letter-spacing="3" fill="#8B87A8">${CERT_PRESENTED}</text>

  ${nameFit.lines.map((ln, i) => `<text x="${COL_CX}" y="${nameBaselines[i].toFixed(0)}" text-anchor="middle" font-family="Inter" font-size="${nameFit.size}" font-weight="800" letter-spacing="-0.8" fill="#FFFFFF">${escXml(ln)}</text>`).join("\n  ")}

  <text x="${COL_CX}" y="${forY.toFixed(0)}" text-anchor="middle" font-family="Inter" font-size="13" font-weight="600" letter-spacing="2.2" fill="#8B87A8">${CERT_FOR}</text>
  ${compText}

  ${ruleWithDiamond(96, 1104, 494)}
  ${statCols}

  ${medallionGroup(p, 990, 300, 0.62)}
</svg>`;
}

// v7.21.29 — A NAME IS NEVER CUT.
//
// `fitToWidth` shrinks and then ELLIPSISES, which is right for a competition
// label and wrong for a person: "Dr. Maria Jose Guadalupe Garcia-Hernandez" is an
// ordinary name once middle names are carried in the first- or last-name field,
// and a certificate that calls somebody "Dr. Maria Jose Guadalu…" is worse than
// one with smaller type.
//
// So the name gets its own fitter with NO ellipsis path at all: try one line at
// the design size, then two balanced lines, and if even that will not fit at the
// legible floor keep shrinking past it. Width scales linearly with font size, so
// a shrink always terminates — there is no input this can truncate.
// `extraEm` is the height a name in a deeper script needs on top of Inter's
// (`_nameExtentEm`), per line; 0 for every name Inter draws alone.
function fitNameLines(text, { maxWidth, size, minSize, weight = 800, letterSpacing = 0, maxLines = 2, hardFloor = 9, heightBudget = Infinity, extraEm = 0 }) {
  const lf = 1.16 + extraEm;
  const raw = String(text == null ? "" : text).trim().replace(/\s+/g, " ");
  if (!raw) return { lines: [""], size, lineHeight: size * lf };
  const words = raw.split(" ");
  const widest = (lines, s) => Math.max(...lines.map(l => measureText(l, s, weight, letterSpacing)));
  // Balanced split into `n` lines: pick the break that minimises the widest line,
  // so "Ada Byron King Lovelace" does not come out as one word over three.
  const wrapInto = (n) => {
    if (n === 1) return [words.join(" ")];
    if (words.length < n) return null;
    let best = null, bestW = Infinity;
    // Only 2 lines are ever asked for, so a single break point is enough.
    for (let i = 1; i < words.length; i++) {
      const cand = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
      const w = widest(cand, 100);
      if (w < bestW) { bestW = w; best = cand; }
    }
    return best;
  };
  // Choose the arrangement that yields the LARGEST type, not simply the first
  // that fits: a long name crammed onto one 32px line is legal but worse than the
  // same name on two 55px lines, and returning on the first success picks the
  // former because it tries one line first.
  let best = null;
  for (let n = 1; n <= maxLines; n++) {
    const lines = wrapInto(n);
    if (!lines) continue;
    // Cap by the HEIGHT the caller has as well as the width. Without this a long
    // name in a tight slot comes out as one small line, because a two-line
    // arrangement at a larger size is taller and gets rejected downstream — the
    // arrangements have to be compared under both constraints at once.
    const byHeight = Math.floor(heightBudget / (n * lf));
    const start = Math.min(size, Number.isFinite(byHeight) ? byHeight : size);
    for (let s = start; s >= minSize; s--) {
      if (widest(lines, s) <= maxWidth) {
        if (!best || s > best.size) best = { lines, size: s, lineHeight: s * lf };
        break;                       // largest size for THIS line count
      }
    }
  }
  if (best) return best;
  // Below the legible floor: still shrink rather than cut.
  const lines = wrapInto(maxLines) || [raw];
  for (let s = minSize; s >= hardFloor; s--) {
    if (widest(lines, s) <= maxWidth) return { lines, size: s, lineHeight: s * lf };
  }
  return { lines, size: hardFloor, lineHeight: hardFloor * lf };
}

// ── Share-card brand copy and ornaments ─────────────────────────────────────
//
// The 1200x627 share card (buildBadgeSvg) is LinkedIn's OpenGraph ratio and
// stays on its own fixed copy: it is a feed thumbnail, not the document. The
// printed certificate (buildCertificateSvg, below) is a SECOND canvas at 3:2 and
// reads every word from the configurable design (lib/certificate-config.js),
// whose defaults carry the same headline.
const CERT_HEADLINE = "CERTIFICATE OF ACHIEVEMENT";
const CERT_PRESENTED = "PRESENTED TO";
const CERT_FOR = "FOR SUCCESSFULLY COMPLETING THE";

/** The share card's medal, scaled and placed. */
function medallionGroup(p, cx, cy, scale) {
  return `<g transform="translate(${cx} ${cy}) scale(${scale})">
    <circle cx="0" cy="-8" r="148" fill="#7C3AED" fill-opacity="0.10"/>
    <circle cx="0" cy="-8" r="118" fill="#A78BFA" fill-opacity="0.08"/>
    <polygon points="-44,-30 -14,-30 -28,118 -58,86" fill="url(#ribbon)"/>
    <polygon points="44,-30 14,-30 28,118 58,86" fill="url(#ribbon)"/>
    <polygon points="-44,-30 -14,-30 -22,52 -50,30" fill="#5B21B6" fill-opacity="0.55"/>
    <polygon points="44,-30 14,-30 22,52 50,30" fill="#5B21B6" fill-opacity="0.55"/>
    <circle cx="0" cy="0" r="86" fill="url(#disc)"/>
    <circle cx="0" cy="0" r="86" fill="none" stroke="${p.ring}" stroke-opacity="0.7" stroke-width="2"/>
    <circle cx="0" cy="0" r="72" fill="url(#discface)"/>
    <circle cx="0" cy="0" r="72" fill="none" stroke="${p.innerRing}" stroke-opacity="0.5" stroke-width="1.5"/>
    <circle cx="0" cy="-60" r="3" fill="${p.dot}" fill-opacity="0.55"/><circle cx="42" cy="-42" r="3" fill="${p.dot}" fill-opacity="0.55"/>
    <circle cx="60" cy="0" r="3" fill="${p.dot}" fill-opacity="0.55"/><circle cx="42" cy="42" r="3" fill="${p.dot}" fill-opacity="0.55"/>
    <circle cx="0" cy="60" r="3" fill="${p.dot}" fill-opacity="0.55"/><circle cx="-42" cy="42" r="3" fill="${p.dot}" fill-opacity="0.55"/>
    <circle cx="-60" cy="0" r="3" fill="${p.dot}" fill-opacity="0.55"/><circle cx="-42" cy="-42" r="3" fill="${p.dot}" fill-opacity="0.55"/>
    <polygon points="0,-40 11.8,-12.4 41.9,-12.4 17.6,5.2 26.9,33.4 0,16 -26.9,33.4 -17.6,5.2 -41.9,-12.4 -11.8,-12.4" fill="${p.starBg}" fill-opacity="0.85"/>
    <polygon points="0,-31 9.1,-9.6 32.3,-9.6 13.6,4.0 20.7,25.8 0,12.4 -20.7,25.8 -13.6,4.0 -32.3,-9.6 -9.1,-9.6" fill="${p.star}"/>
    <path d="M -52 -52 A 74 74 0 0 1 30 -68" fill="none" stroke="#FFFFFF" stroke-opacity="0.45" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

/** The gradient/defs block, shared by both canvases. */
function badgeDefs(p) {
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0C0A17"/><stop offset="0.55" stop-color="#100D22"/><stop offset="1" stop-color="#171430"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.34" r="0.62">
      <stop offset="0" stop-color="#7C3AED" stop-opacity="0.30"/><stop offset="0.5" stop-color="#7C3AED" stop-opacity="0.10"/><stop offset="1" stop-color="#7C3AED" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accentbar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#A78BFA"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
    <linearGradient id="brandtext" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#A78BFA"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
    <linearGradient id="ranktext" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.rankFrom}"/><stop offset="1" stop-color="${p.rankTo}"/></linearGradient>
    <linearGradient id="disc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.discFrom}"/><stop offset="0.5" stop-color="${p.discMid}"/><stop offset="1" stop-color="${p.discTo}"/></linearGradient>
    <radialGradient id="discface" cx="0.38" cy="0.32" r="0.85"><stop offset="0" stop-color="${p.faceFrom}"/><stop offset="0.55" stop-color="${p.faceMid}"/><stop offset="1" stop-color="${p.faceTo}"/></radialGradient>
    <linearGradient id="ribbon" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#6D28D9"/></linearGradient>
  </defs>`;
}

/** A rule with a small diamond at its midpoint, as in the template. */
function ruleWithDiamond(x1, x2, y) {
  const cx = (x1 + x2) / 2;
  return `<line x1="${x1}" y1="${y}" x2="${cx - 18}" y2="${y}" stroke="#A78BFA" stroke-opacity="0.28"/>
  <line x1="${cx + 18}" y1="${y}" x2="${x2}" y2="${y}" stroke="#A78BFA" stroke-opacity="0.28"/>
  <rect x="${cx - 4}" y="${y - 4}" width="8" height="8" rx="1.5" fill="#A78BFA" fill-opacity="0.75" transform="rotate(45 ${cx} ${y})"/>`;
}

// ── Certificate artwork (v8.15.0 — the "Laureate" redesign) ─────────────────
//
// Drawn to the operator's gold reference and then pushed further: a deep
// layered ground (base, two lit pools, a vignette, faint security linework), a
// double metal frame with a guilloché band between its rules, a struck medal
// (reeded edge, bevelled rim, engraved rosette, faceted star, specular light),
// laurels built leaf by leaf along a curved stem, and a typographic hierarchy
// that is tracked per line rather than one size stacked on another.
//
// The artwork is vector: no bitmap is embedded in the SVG, so the render is
// byte-deterministic. The PDF (`renderBadgePdf`) carries it rendered ONCE as a
// 1536x1024 raster — about 144 pixels per inch on A4, colour rounded to 6 bits
// a channel to keep the emailed file small — not as vector paths.
//
// WHAT IS CONFIGURABLE AND WHAT IS NOT. `o.design` is the merged design from
// lib/certificate-config.js (defaults <- global <- event): every word that is
// not a fact about the holder, every colour, and the show/hide switches. The
// FACTS — name, event, score, date, basis, late entry, code — come from the
// frozen badge row via routes/badge.js `_badgeArt`, and no design key can
// replace or hide the late-entrant marker.
//
// THE TIER comes from the frozen `basis` first and the rank second
// (`certificateTier`): a participation certificate never wears a podium medal,
// even when the rank stored beside it is 3 or better (a late entrant's), and a
// legacy row with no basis derives it from rank as it always did.
const CERT_W = 1536;
const CERT_H = 1024;
const { certificateDefaults, certificateTier, fillTokens } = require("./certificate-config");
const { encodeQr, qrSvgPath } = require("./qr");

// ── colour helpers ──────────────────────────────────────────────────────────
function _rgb(hex) {
  const h = String(hex || "#000000").replace("#", "");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
}
function _hex(rgb) {
  return "#" + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}
/** Linear mix of two hex colours; t=0 is `a`, t=1 is `b`. */
function _mix(a, b, t) {
  const A = _rgb(a), B = _rgb(b);
  return _hex(A.map((v, i) => v + (B[i] - v) * t));
}
const _tint = (c, t) => _mix(c, "#FFFFFF", t);
const _shade = (c, t) => _mix(c, "#000000", t);
/** Luma (0-255) of a hex colour: what a camera's reader thresholds on. */
const _luma = (c) => { const [r, g, b] = _rgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/**
 * The verification QR's inks for any palette a design may choose: DARK modules
 * on a LIGHT plate, as every reader takes darker as dark. The darker of the
 * design's background and text colours draws the modules and the lighter one,
 * tinted half-way to white, the plate (the default palette's own pair, so it
 * renders as it always did); where those modules would sit under 128 of 255
 * in luma below that plate, it falls back to black on white. A light design (dark text on white)
 * once drew white modules on a grey plate: inverted and unreadable (sweep #215;
 * lock: tests/qr-decode.spec.js).
 */
function _qrInks(C) {
  const [dark, light] = _luma(C.background) <= _luma(C.text) ? [C.background, C.text] : [C.text, C.background];
  const plate = _tint(light, 0.5);
  return _luma(plate) - _luma(dark) >= 128 ? { modules: dark, plate } : { modules: "#000000", plate: "#FFFFFF" };
}

/**
 * A metal from one base colour: highlight, light, base, mid, deep, shadow. The
 * highlights are mixed toward a WARM white for warm metals and a cool one for
 * cool metals, which is what stops a derived gold reading as yellow plastic.
 */
function _metal(base) {
  const [r, , b] = _rgb(base);
  const white = r > b ? "#FFF6DE" : "#F4F7FF";
  return {
    hi: _mix(base, white, 0.82), light: _mix(base, white, 0.45), base,
    mid: _shade(base, 0.2), deep: _shade(base, 0.46), shadow: _shade(base, 0.7),
  };
}

const _f = (n) => Number(n.toFixed(2));

// ── typography helpers ──────────────────────────────────────────────────────
/**
 * A tracked line of text. SVG letter-spacing is added after EVERY glyph,
 * including the last, so a centred tracked line sits half a tracking unit left
 * of centre — invisible at 1px, obvious at 9px. The x is corrected for it.
 */
/** SVG font attributes for a measuring key: an Inter weight (400, 600, 800). */
function _fontAttrs(weight) {
  return `font-family="Inter" font-weight="${weight}"`;
}

function _tline(text, { x, y, size, weight = 600, ls = 0, fill, anchor = "middle", extra = "" }) {
  const dx = anchor === "middle" ? ls / 2 : anchor === "end" ? ls : 0;
  const a = anchor === "start" ? "" : ` text-anchor="${anchor}"`;
  return `<text x="${_f(x + dx)}" y="${_f(y)}"${a} ${_fontAttrs(weight)} font-size="${_f(size)}"` +
    `${ls ? ` letter-spacing="${_f(ls)}"` : ""} fill="${fill}"${extra}>${escXml(text)}</text>`;
}

/** Shrink a tracked line (tracking scales with size) until it fits. Never cuts. */
function _fitTracked(text, { maxWidth, size, minSize = 6, weight = 600, lsEm = 0 }) {
  let s = size;
  while (s > minSize && measureText(text, s, weight, s * lsEm) > maxWidth) s -= 0.5;
  // Below the floor keep shrinking proportionally: configured text is never cut.
  const w = measureText(text, s, weight, s * lsEm);
  if (w > maxWidth && w > 0) s = s * (maxWidth / w);
  return { size: s, ls: s * lsEm };
}

/**
 * Word-wrap into at most `maxLines` lines of near-equal width (a ragged block of
 * one long line and one orphan word reads as an accident). Widths are measured,
 * not estimated. Returns null when it cannot fit in `maxLines`.
 */
function _balancedWrap(text, { size, weight, ls = 0, maxWidth, maxLines }) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const width = (s) => measureText(s, size, weight, ls);
  const greedy = (limit) => {
    const lines = [];
    let cur = "";
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (!cur || width(cand) <= limit) cur = cand;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const full = greedy(maxWidth);
  if (full.length > maxLines || full.some(l => width(l) > maxWidth)) return null;
  if (full.length === 1) return full;
  // Tighten the limit while the line count holds — the narrowest limit that
  // still gives the same number of lines is the most balanced block.
  let lo = 0, hi = maxWidth, best = full;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const t = greedy(mid);
    if (t.length <= full.length && !t.some(l => width(l) > mid + 0.01)) { best = t; hi = mid; } else lo = mid;
  }
  return best;
}

// ── ornament builders ───────────────────────────────────────────────────────
/** A hairline that fades to nothing at both ends, with an optional centre diamond. */
function _rule(id, x1, x2, y, { diamond = null, gap = 16 } = {}) {
  const cx = (x1 + x2) / 2;
  if (!diamond) return `<rect x="${_f(x1)}" y="${_f(y - 0.6)}" width="${_f(x2 - x1)}" height="1.2" fill="url(#${id})"/>`;
  return `<rect x="${_f(x1)}" y="${_f(y - 0.6)}" width="${_f(cx - gap - x1)}" height="1.2" fill="url(#${id}L)"/>` +
    `<rect x="${_f(cx + gap)}" y="${_f(y - 0.6)}" width="${_f(x2 - cx - gap)}" height="1.2" fill="url(#${id}R)"/>` +
    _diamond(cx, y, 6.5, diamond);
}

/** A cut-gem diamond: four facets lit from the top left, with a metal keyline. */
function _diamond(cx, cy, r, { light, dark, edge }) {
  const T = [cx, cy - r], R = [cx + r, cy], B = [cx, cy + r], L = [cx - r, cy], C = [cx, cy];
  const tri = (a, b, fill) => `<polygon points="${_f(a[0])},${_f(a[1])} ${_f(b[0])},${_f(b[1])} ${_f(C[0])},${_f(C[1])}" fill="${fill}"/>`;
  return `<g>${tri(L, T, light)}${tri(T, R, _mix(light, dark, 0.35))}${tri(R, B, dark)}${tri(B, L, _mix(light, dark, 0.65))}` +
    `<polygon points="${_f(T[0])},${_f(T[1])} ${_f(R[0])},${_f(R[1])} ${_f(B[0])},${_f(B[1])} ${_f(L[0])},${_f(L[1])}" fill="none" stroke="${edge}" stroke-width="0.8"/></g>`;
}

/** Sampled sine waves between two points — the guilloché band of the frame. */
function _waveBand(x1, y1, x2, y2, { amp, period, phases, step = 2.5 }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len, nx = -uy, ny = ux;
  return phases.map(ph => {
    let d = "";
    for (let s = 0; s <= len + 0.001; s += step) {
      const o = amp * Math.sin((s / period) * Math.PI * 2 + ph);
      d += `${s ? "L" : "M"}${_f(x1 + ux * s + nx * o)} ${_f(y1 + uy * s + ny * o)}`;
    }
    return d;
  }).join("");
}

/**
 * A laurel branch: leaves set along a circular arc, alternating sides, largest at
 * the base and tapering to the tip, each an almond with a centre vein. Returned
 * for the LEFT side; the right is the same group mirrored, so the pair is exact.
 * Angles in degrees, clockwise from 12 o'clock, around (0,0).
 */
function _laurel({ radius, from, to, leaves, leafLen, leafW, fillId, vein, stem, stemW = 2 }) {
  const P = (deg, r = radius) => {
    const a = (deg * Math.PI) / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  };
  // The stem.
  const [sx, sy] = P(from), [ex, ey] = P(to);
  const sweep = to > from ? 1 : 0;
  let out = `<path d="M${_f(sx)} ${_f(sy)}A${radius} ${radius} 0 0 ${sweep} ${_f(ex)} ${_f(ey)}" fill="none" stroke="${stem}" stroke-width="${stemW}" stroke-linecap="round"/>`;
  for (let i = 0; i < leaves; i++) {
    const t = (i + 0.5) / leaves;
    const deg = from + (to - from) * t;
    const [px, py] = P(deg);
    // Tangent direction of travel along the stem.
    const tan = deg + (to > from ? 90 : -90);
    const scale = 1 - 0.42 * t;
    const L = leafLen * scale, W = leafW * scale;
    const side = i % 2 === 0 ? 1 : -1;
    // Leaves lean 38 degrees off the stem, toward the tip.
    const rot = tan + side * 38 * (to > from ? -1 : 1);
    const leaf = `M0 0C${_f(W)} ${_f(-L * 0.25)} ${_f(W * 0.9)} ${_f(-L * 0.75)} 0 ${_f(-L)}C${_f(-W * 0.9)} ${_f(-L * 0.75)} ${_f(-W)} ${_f(-L * 0.25)} 0 0Z`;
    out += `<g transform="translate(${_f(px)} ${_f(py)}) rotate(${_f(rot)})"><path d="${leaf}" fill="url(#${fillId})"/>` +
      `<path d="M0 ${_f(-L * 0.08)}L0 ${_f(-L * 0.86)}" stroke="${vein}" stroke-width="0.8" stroke-opacity="0.7" stroke-linecap="round"/></g>`;
  }
  // A berry pair at the base, the classical closing detail.
  const [bx, by] = P(from + (to - from) * 0.04, radius + leafW * 0.9);
  out += `<circle cx="${_f(bx)}" cy="${_f(by)}" r="${_f(leafW * 0.32)}" fill="url(#${fillId})"/>`;
  return out;
}

/** A 5-point star, faceted into ten triangles lit from the top left. */
function _facetedStar(rOut, rIn, m) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * 36 - 90) * Math.PI / 180;
    const r = i % 2 ? rIn : rOut;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const light = [-0.55, -0.83]; // unit vector toward the light
  let out = "";
  for (let i = 0; i < 10; i++) {
    const a = pts[i], b = pts[(i + 1) % 10];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const ml = Math.hypot(mx, my) || 1;
    const k = (mx / ml) * light[0] + (my / ml) * light[1]; // -1..1
    const fill = k > 0 ? _mix(m.light, m.hi, k) : _mix(m.light, m.deep, -k * 0.9);
    out += `<polygon points="0,0 ${_f(a[0])},${_f(a[1])} ${_f(b[0])},${_f(b[1])}" fill="${fill}"/>`;
  }
  const outline = pts.map(p => `${_f(p[0])},${_f(p[1])}`).join(" ");
  out += `<polygon points="${outline}" fill="none" stroke="${m.deep}" stroke-width="1" stroke-linejoin="round"/>`;
  return out;
}

/** An engraved rosette: phase-shifted rose curves, the guilloché of a banknote. */
function _rosette(r0, amp, petals, curves, step = 1.5) {
  let d = "";
  for (let c = 0; c < curves; c++) {
    const ph = (c / curves) * (Math.PI * 2 / petals);
    for (let deg = 0; deg <= 360; deg += step) {
      const a = deg * Math.PI / 180;
      const r = r0 + amp * Math.cos(petals * a + ph * petals);
      d += `${deg ? "L" : "M"}${_f(r * Math.sin(a))} ${_f(-r * Math.cos(a))}`;
    }
    d += "Z";
  }
  return d;
}

/** Points of a scalloped circle (an award rosette's edge). */
function _scallop(r, bumps, depth) {
  let d = "";
  const n = bumps * 8;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r - depth * (1 - Math.abs(Math.cos(bumps * a / 2)));
    d += `${i ? "L" : "M"}${_f(rr * Math.sin(a))} ${_f(-rr * Math.cos(a))}`;
  }
  return d + "Z";
}

/**
 * The centrepiece. A struck medal for the podium tiers; a scalloped award seal
 * for participation and completion (no podium metal on a certificate that
 * claims no placing). Drawn around (0,0), radius `R`.
 */
function _medalArt(tier, m, accent, R) {
  const podium = tier === "gold" || tier === "silver" || tier === "bronze";
  const a = _metal(accent);
  // Ribbon tails: a satin strip, V-notched, folded along its length (a lit half
  // and a shaded half) with a woven metal stripe inside each edge.
  const tail = (s) => {
    const S = [s * R * 0.2, R * 0.3], E = [s * R * 0.78, R * 1.62];
    const len = Math.hypot(E[0] - S[0], E[1] - S[1]);
    const d = [(E[0] - S[0]) / len, (E[1] - S[1]) / len], n = [-d[1], d[0]];
    const w = R * 0.4;
    const P = (base, k, back = 0) => [base[0] + n[0] * k - d[0] * back, base[1] + n[1] * k - d[1] * back];
    const pts = (arr) => arr.map(q => `${_f(q[0])},${_f(q[1])}`).join(" ");
    const notch = P(E, 0, R * 0.2);
    const halfA = [P(S, -w / 2), P(S, 0), notch, P(E, -w / 2)];
    const halfB = [P(S, 0), P(S, w / 2), P(E, w / 2), notch];
    const lit = s < 0 ? halfB : halfA, dim = s < 0 ? halfA : halfB;
    const stripe = (k) => `<line x1="${_f(P(S, k)[0])}" y1="${_f(P(S, k)[1])}" x2="${_f(P(E, k)[0])}" y2="${_f(P(E, k)[1])}" stroke="${m.light}" stroke-opacity="0.55" stroke-width="1.1"/>`;
    return `<polygon points="${pts(lit)}" fill="url(#ribbon)"/>` +
      `<polygon points="${pts(dim)}" fill="url(#ribbon)"/><polygon points="${pts(dim)}" fill="${a.shadow}" fill-opacity="0.42"/>` +
      stripe(w / 2 - 5) + stripe(-w / 2 + 5) +
      `<line x1="${_f(P(S, 0)[0])}" y1="${_f(P(S, 0)[1])}" x2="${_f(notch[0])}" y2="${_f(notch[1])}" stroke="${m.base}" stroke-opacity="0.8" stroke-width="2.2"/>` +
      `<polygon points="${pts([P(S, -w / 2), P(S, w / 2), P(E, w / 2), notch, P(E, -w / 2)])}" fill="none" stroke="${a.shadow}" stroke-opacity="0.6" stroke-width="0.8"/>`;
  };
  let out = `<g>${tail(-1)}${tail(1)}</g>`;
  out += `<circle cx="0" cy="12" r="${R + 2}" fill="#000000" fill-opacity="0.55" filter="url(#softshadow)"/>`;
  if (podium) {
    out += `<circle r="${R}" fill="url(#rim)"/>`;
    // Reeded edge.
    let ticks = "";
    for (let i = 0; i < 160; i++) {
      const ang = (i / 160) * Math.PI * 2, s = Math.sin(ang), c = -Math.cos(ang);
      ticks += `M${_f((R - 1.5) * s)} ${_f((R - 1.5) * c)}L${_f((R - 8) * s)} ${_f((R - 8) * c)}`;
    }
    out += `<path d="${ticks}" stroke="${m.deep}" stroke-opacity="0.5" stroke-width="1.1"/>`;
    // Bevel: lit top-left outer edge, shadowed inner edge.
    out += `<circle r="${R - 10}" fill="none" stroke="url(#bevelOut)" stroke-width="3.2"/>`;
    out += `<circle r="${R - 13}" fill="url(#face)"/>`;
    out += `<circle r="${R - 13}" fill="none" stroke="url(#bevelIn)" stroke-width="2.2"/>`;
    // Engraved rosette in the band, then the dotted ring the reference carries.
    out += `<g clip-path="url(#band)"><path d="${_rosette(R * 0.62, R * 0.1, 24, 6)}" fill="none" stroke="${m.deep}" stroke-opacity="0.32" stroke-width="0.7"/></g>`;
    let dots = "";
    for (let i = 0; i < 60; i++) {
      const ang = (i / 60) * Math.PI * 2;
      dots += `<circle cx="${_f((R - 22) * Math.sin(ang))}" cy="${_f(-(R - 22) * Math.cos(ang))}" r="1.5"/>`;
    }
    out += `<g fill="${m.deep}" fill-opacity="0.75">${dots}</g>`;
    // The recessed field and its star.
    out += `<circle r="${R * 0.5}" fill="url(#field)"/>`;
    out += `<circle r="${R * 0.5}" fill="none" stroke="${m.hi}" stroke-opacity="0.55" stroke-width="1.2"/>`;
    out += `<circle r="${R * 0.5 - 2}" fill="none" stroke="${m.shadow}" stroke-opacity="0.35" stroke-width="1.5"/>`;
    out += `<g transform="translate(0 2)">${_facetedStar(R * 0.42, R * 0.17, m)}</g>`;
  } else {
    // Award seal: scalloped edge, struck ring, engraved field, an emblem.
    out += `<path d="${_scallop(R, 30, 7)}" fill="url(#rim)"/>`;
    out += `<path d="${_scallop(R - 3, 30, 6)}" fill="none" stroke="${m.deep}" stroke-opacity="0.45" stroke-width="1"/>`;
    out += `<circle r="${R - 16}" fill="url(#face)"/>`;
    out += `<circle r="${R - 16}" fill="none" stroke="url(#bevelIn)" stroke-width="2.2"/>`;
    out += `<circle r="${R - 22}" fill="none" stroke="${m.deep}" stroke-opacity="0.6" stroke-width="0.9"/>`;
    out += `<g clip-path="url(#band)"><path d="${_rosette(R * 0.6, R * 0.1, 20, 5)}" fill="none" stroke="${m.deep}" stroke-opacity="0.3" stroke-width="0.7"/></g>`;
    out += `<circle r="${R * 0.48}" fill="url(#field)"/>`;
    out += `<circle r="${R * 0.48}" fill="none" stroke="${m.hi}" stroke-opacity="0.5" stroke-width="1.2"/>`;
    if (tier === "completion") {
      // A struck check: a light upper face over a dark lower one.
      const w = R * 0.2;
      out += `<path d="M${_f(-w * 1.5)} ${_f(w * 0.05)}L${_f(-w * 0.35)} ${_f(w * 1.15)}L${_f(w * 1.7)} ${_f(-w * 1.15)}" fill="none" stroke="${m.shadow}" stroke-width="${_f(w * 0.62)}" stroke-linecap="round" stroke-linejoin="round" transform="translate(1.5 2)"/>` +
        `<path d="M${_f(-w * 1.5)} ${_f(w * 0.05)}L${_f(-w * 0.35)} ${_f(w * 1.15)}L${_f(w * 1.7)} ${_f(-w * 1.15)}" fill="none" stroke="url(#emblem)" stroke-width="${_f(w * 0.5)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else {
      // A faceted hexagon: the platform's challenge cell, struck in relief.
      const hr = R * 0.3;
      const hp = [];
      for (let i = 0; i < 6; i++) { const ang = (i * 60 - 90) * Math.PI / 180; hp.push([hr * Math.cos(ang), hr * Math.sin(ang)]); }
      const light = [-0.55, -0.83];
      for (let i = 0; i < 6; i++) {
        const p1 = hp[i], p2 = hp[(i + 1) % 6];
        const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2, ml = Math.hypot(mx, my);
        const k = (mx / ml) * light[0] + (my / ml) * light[1];
        const fill = k > 0 ? _mix(m.light, m.hi, k) : _mix(m.light, m.deep, -k * 0.9);
        out += `<polygon points="0,0 ${_f(p1[0])},${_f(p1[1])} ${_f(p2[0])},${_f(p2[1])}" fill="${fill}"/>`;
      }
      out += `<polygon points="${hp.map(p => `${_f(p[0])},${_f(p[1])}`).join(" ")}" fill="none" stroke="${m.deep}" stroke-width="1"/>`;
      out += `<polygon points="${hp.map(p => `${_f(p[0] * 0.42)},${_f(p[1] * 0.42)}`).join(" ")}" fill="${m.deep}" fill-opacity="0.55"/>`;
    }
  }
  // Inner shadow and the specular sweep — the two things that make it metal.
  out += `<circle r="${R - 1}" fill="url(#innershade)"/>`;
  // A thin specular arc riding the rim, top left.
  out += `<path d="M${_f(-R * 0.97 * Math.sin(1.25))} ${_f(-R * 0.97 * Math.cos(1.25))}A${_f(R * 0.97)} ${_f(R * 0.97)} 0 0 1 ${_f(R * 0.97 * Math.sin(0.15))} ${_f(-R * 0.97 * Math.cos(0.15))}" fill="none" stroke="url(#rimspec)" stroke-width="1.8" stroke-linecap="round"/>`;
  out += `<path d="M${_f(-R * 0.78)} ${_f(-R * 0.18)}A${_f(R * 0.8)} ${_f(R * 0.8)} 0 0 1 ${_f(R * 0.2)} ${_f(-R * 0.78)}" fill="none" stroke="url(#specular)" stroke-width="${_f(R * 0.09)}" stroke-linecap="round"/>`;
  out += `<circle cx="${_f(-R * 0.52)}" cy="${_f(-R * 0.56)}" r="${_f(R * 0.05)}" fill="#FFFFFF" fill-opacity="0.55" filter="url(#glint)"/>`;
  return out;
}

/** The shield mark at the foot of the certificate. */
function _shieldArt(accent, m) {
  const a = _metal(accent);
  const shield = "M0 -40C14 -33 26 -31 36 -31L36 4C36 26 18 40 0 48C-18 40 -36 26 -36 4L-36 -31C-26 -31 -14 -33 0 -40Z";
  const inner = "M0 -33C11 -27 21 -25 29 -25L29 3C29 21 15 33 0 40C-15 33 -29 21 -29 3L-29 -25C-21 -25 -11 -27 0 -33Z";
  return `<path d="${shield}" fill="url(#shieldFill)"/>` +
    `<path d="${shield}" fill="none" stroke="url(#metalStroke)" stroke-width="1.6"/>` +
    `<path d="${inner}" fill="none" stroke="${m.base}" stroke-opacity="0.45" stroke-width="0.8"/>` +
    `<path d="M-11 -9L11 13M11 -9L-11 13" stroke="${a.shadow}" stroke-width="7" stroke-linecap="round" transform="translate(1 1.5)"/>` +
    `<path d="M-11 -9L11 13M11 -9L-11 13" stroke="url(#metalStroke)" stroke-width="5.2" stroke-linecap="round"/>`;
}

/** A field of hexagons that fades out: the platform motif, kept almost subliminal. */
function _hexField(x0, y0, cols, rows, r) {
  const w = Math.sqrt(3) * r;
  let d = "";
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = x0 + i * w + (j % 2 ? w / 2 : 0), cy = y0 + j * r * 1.5;
      for (let k = 0; k < 6; k++) {
        const ang = (k * 60 - 90) * Math.PI / 180;
        d += `${k ? "L" : "M"}${_f(cx + r * Math.cos(ang))} ${_f(cy + r * Math.sin(ang))}`;
      }
      d += "Z";
    }
  }
  return d;
}

/**
 * The certificate. `o` carries the frozen facts (see `_badgeArt`) plus `design`
 * (the merged config; the built-in reference when absent) and `verifyLink`
 * (the absolute URL the QR code encodes).
 *
 * Two deliberate departures from the reference, both about not mangling data:
 *  • The NAME renders as stored, never upper-cased: `toUpperCase()` turns ß into
 *    SS, and a wrong name is the worst defect a certificate can carry. Labels and
 *    the event name (admin-authored) are set in caps as drawn.
 *  • A NAME IS NEVER CUT (`fitNameLines`): it shrinks and wraps to two lines.
 */
function buildCertificateSvg(o) {
  const D = o.design || certificateDefaults();
  const T = D.text, C = D.colors, S = D.show;
  const tier = certificateTier({ basis: o.basis, rank: o.rank });
  const podium = tier === "gold" || tier === "silver" || tier === "bronze";
  const m = _metal(C[tier]);
  const frameM = C.frame ? _metal(C.frame) : m;
  const a = _metal(C.accent);
  // Program grades: a graded completion certificate takes its BAND's wording
  // (labels.excellent …), configurable like a tier's; colours and seal stay the
  // completion tier's.
  const graded = tier === "completion" ? _gradeOf(o) : null;
  const labels = (graded && D.labels[graded.band]) || D.labels[tier];
  const fill = (s) => fillTokens(s, { platformName: o.platformName || "Hack Arena" });
  const caps = (s) => fill(s).toUpperCase();

  const CX = 540;            // the text column's axis; the medal owns the right
  const COLW = 800;          // the column's measure
  const NAME_WEIGHT = 800, NAME_LS = -1;   // Inter ExtraBold, tracked in a touch at display size

  // ── header ──
  const hub = caps(T.hub_line);
  const hubFit = _fitTracked(hub, { maxWidth: 820, size: 15, minSize: 10, weight: 600, lsEm: 0.24 });
  const title = caps(T.title);
  const titleFit = _fitTracked(title, { maxWidth: COLW, size: 52, minSize: 26, weight: 600, lsEm: 0.16 });
  const presented = caps(T.presented_to);
  const leadIn = caps(T.lead_in);

  // ── the middle slot: name, lead-in, event, recognition ──
  // One fixed vertical slot holds the name, the lead-in, the event and the
  // recognition sentence, and everything in it is positioned from where the
  // line above actually ends. The NAME has priority: the event steps down a size
  // (and the sentence after it) before the name is asked to shrink, because the
  // name is the reason the document exists.
  const NAME_TOP = 364, SLOT_BOTTOM = 694;
  const EV_MAXW = COLW - 110;
  const eventRaw = String(o.competitionName || "").toUpperCase();
  const recog = fill(T.recognition);
  const GAP_LEAD = leadIn ? 44 : 16;
  const NAME_PRIORITY = 78;
  const _evFor = (size) => {
    const lines = _balancedWrap(eventRaw, { size, weight: 800, ls: size * 0.04, maxWidth: EV_MAXW, maxLines: 2 });
    return lines ? { size, lines } : null;
  };
  const _recFor = (size) => (recog ? _balancedWrap(recog, { size, weight: 400, ls: 0.3, maxWidth: COLW - 80, maxLines: 3 }) : []);
  // Room above and below for a script whose ink reaches past Inter's: Arabic
  // dots under the line, a stacked Thai mark. Zero for a Latin name.
  const nx = _nameExtentEm(o.displayName || "");
  let plan = null;
  for (const evTry of [40, 36, 32, 29, 26]) {
    const ev = _evFor(evTry) || (evTry === 26 ? { size: 26, lines: wrapToLines(eventRaw, 26, EV_MAXW, 2, 0.74) } : null);
    if (!ev) continue;
    const recSize = evTry >= 36 ? 22 : 20;
    const recLines = _recFor(recSize) || _recFor(16) || wrapToLines(recog, 16, COLW - 80, 3);
    const evLH = ev.size * 1.18, recLH = recSize * 1.62;
    // Exactly the offsets the layout below uses, from the name's last baseline.
    const fixedBelowName = GAP_LEAD + 24 + ev.size * 0.76 + (ev.lines.length - 1) * evLH + 28 +
      (recLines.length ? 40 + (recLines.length - 1) * recLH : 0);
    const nf = fitNameLines(o.displayName || "", {
      maxWidth: COLW - 20, size: 108, minSize: 24, weight: NAME_WEIGHT, letterSpacing: NAME_LS,
      heightBudget: SLOT_BOTTOM - NAME_TOP - fixedBelowName, extraEm: nx.above + nx.below,
    });
    const cand = { ev, recSize, recLines, evLH, recLH, nf };
    // Keep the largest name; a smaller event is only worth it for a real gain.
    if (!plan || nf.size > plan.nf.size + 2) plan = cand;
    if (nf.size >= NAME_PRIORITY) break;
  }
  const evSize = plan.ev.size, evLines = plan.ev.lines, evLs = evSize * 0.04, evLH = plan.evLH;
  const recSize = plan.recSize, recLines = plan.recLines, recLH = plan.recLH;
  const nameFit = plan.nf;
  const nameLH = nameFit.size * (1.12 + nx.above + nx.below);
  const nameBase = nameFit.lines.map((_, i) => NAME_TOP + nameFit.size * (0.86 + nx.above) + i * nameLH);
  const nameBottom = nameBase[nameBase.length - 1];
  const leadY = nameBottom + nameFit.size * nx.below + GAP_LEAD;
  const evY = evLines.map((_, i) => leadY + 24 + evSize * 0.76 + i * evLH);
  const rule2Y = evY[evY.length - 1] + 28;
  const recY = recLines.map((_, i) => rule2Y + 40 + i * recLH);

  // ── the stat row ──
  const cols = [{ label: caps(T.achievement_heading), value: labels.headline, fill: "url(#metalText)", sub: labels.sub ? caps(labels.sub) : "" }];
  if (podium && o.board && canRenderText(String(o.board))) cols.push({ label: BOARD_STAT_LABEL, value: String(o.board), fill: C.text });
  if (S.score && podium && o.scoreLabel != null) cols.push({ label: caps(T.score_heading), value: o.scoreLabel, fill: "url(#metalText)" });
  if (S.score && graded) cols.push({ label: caps(T.grade_heading), value: graded.percent, fill: "url(#metalText)" });
  if (S.date && o.dateLabel) cols.push({ label: caps(T.date_heading), value: o.dateLabel, fill: C.text });
  if (o.lateEntrant) cols.push({ ...LATE_ENTRY_STAT });
  const ROW_X1 = 140, ROW_X2 = 1120;
  const colW = (ROW_X2 - ROW_X1) / cols.length;
  const statCols = cols.map((c, i) => {
    const cx = ROW_X1 + colW * (i + 0.5);
    const lab = _fitTracked(c.label, { maxWidth: colW - 30, size: 13, minSize: 9, weight: 600, lsEm: 0.2 });
    const val = fitToWidth(c.value, { maxWidth: colW - 36, size: 40, minSize: 18, weight: 600, letterSpacing: -0.4 });
    const sep = i === 0 ? "" : `<rect x="${_f(ROW_X1 + colW * i - 0.5)}" y="742" width="1" height="104" fill="url(#vrule)"/>`;
    const subFit = c.sub ? _fitTracked(c.sub, { maxWidth: colW - 30, size: 12.5, minSize: 9, weight: 600, lsEm: 0.2 }) : null;
    return sep +
      _tline(c.label, { x: cx, y: 768, size: lab.size, ls: lab.ls, fill: C.muted }) +
      `<text x="${_f(cx)}" y="814" text-anchor="middle" font-family="Inter" font-size="${val.size}" font-weight="600" letter-spacing="-0.4" fill="${c.fill === LATE_ENTRY_STAT.fill ? C.text : c.fill}">${escXml(val.text)}</text>` +
      (subFit ? _tline(c.sub, { x: cx, y: 842, size: subFit.size, ls: subFit.ls, fill: _tint(C.accent, 0.35) }) : "");
  }).join("\n  ");

  // ── verification block ──
  // The code and where to take it are on the certificate (v8.8.20); a legacy
  // badge with no code renders NOTHING here, not a label over a blank. The QR
  // encodes the credential page with the code pre-filled (GET /credential reads
  // `?code=`, and `_scrubLogPath` already redacts it in every log). The printed
  // address is SHRINK-ONLY: a cut verification instruction is worse than none.
  let verifyBlock = "";
  if (o.publicCode && S.code) {
    const code = formatCredentialCode(o.publicCode);
    const where = String(o.verifyUrl || "").trim();
    const label = where ? `VERIFY AT ${where}` : "VERIFY THIS CERTIFICATE";
    let qr = null;
    if (S.qr && o.verifyLink) { try { qr = encodeQr(o.verifyLink); } catch { qr = null; } }
    const QX = 1146, QY = 842, QS = 86;
    // The light plate leaves the standard four-module quiet zone round the
    // symbol (qrSvgPath draws none; the caller owns it, as qrSvg's own `quiet`
    // does for the join QR): a narrower margin lets the frame stroke and a dark
    // background read as part of the code. With no QR the label keeps its 6 px.
    const pad = qr ? 4 * QS / qr.size : 6;
    const tx = qr ? QX + QS + pad + 14 : QX;
    if (qr) {
      const ink = _qrInks(C);
      const px = _f(QX - pad), py = _f(QY - pad), pw = _f(QS + 2 * pad);
      verifyBlock += `<rect x="${px}" y="${py}" width="${pw}" height="${pw}" rx="3" fill="${ink.plate}"/>` +
        `<rect x="${px}" y="${py}" width="${pw}" height="${pw}" rx="3" fill="none" stroke="${frameM.base}" stroke-opacity="0.8" stroke-width="1"/>` +
        `<path class="cert-qr" d="${qrSvgPath(qr, QX, QY, QS)}" fill="${ink.modules}"/>`;
    }
    const idHead = caps(T.id_heading);
    const idFit = _fitTracked(idHead, { maxWidth: 1478 - tx, size: 12, minSize: 8, weight: 600, lsEm: 0.2 });
    const codeFit = _fitTracked(code, { maxWidth: 1478 - tx, size: 21, minSize: 9, weight: 600, lsEm: 0.1 });
    verifyBlock += _tline(idHead, { x: tx, y: QY + 26, size: idFit.size, ls: idFit.ls, fill: C.muted, anchor: "start" }) +
      _tline(code, { x: tx, y: QY + 56, size: codeFit.size, ls: codeFit.ls, fill: "url(#metalText)", anchor: "start" });
    const vFit = _fitTracked(label, { maxWidth: 1478 - QX + pad, size: 11, minSize: 1, weight: 600, lsEm: 0.12 });
    verifyBlock += _tline(label, { x: _f(QX - pad), y: QY + QS + 30, size: vFit.size, ls: vFit.ls, fill: C.muted, anchor: "start" });
  }

  // ── laurel sprigs flanking the event's first line ──
  const evW = Math.max(...evLines.map(l => measureText(l, evSize, 800, evLs)));
  const sprig = (sx, flip) => `<g transform="translate(${_f(sx)} ${_f(evY[0] - evSize * 0.4)}) scale(${flip ? -0.56 : 0.56} 0.56)">` +
    _laurel({ radius: 62, from: 205, to: 310, leaves: 8, leafLen: 26, leafW: 8.5, fillId: "leafMetal", vein: m.deep, stem: m.mid, stemW: 2.4 }) +
    `</g>`;
  const sprigs = sprig(CX - evW / 2 - 8, false) + sprig(CX + evW / 2 + 8, true);

  // ── assembly ──
  const MX = 1232, MY = 318, MR = 118;
  const frame = (() => {
    const o1 = 22, o2 = 40, o3 = 50;
    let s = `<rect x="${o1}" y="${o1}" width="${CERT_W - o1 * 2}" height="${CERT_H - o1 * 2}" fill="none" stroke="url(#frameStroke)" stroke-width="1.8"/>` +
      `<rect x="${o2}" y="${o2}" width="${CERT_W - o2 * 2}" height="${CERT_H - o2 * 2}" fill="none" stroke="url(#frameStroke)" stroke-width="0.9"/>`;
    // The guilloché band between the two outer rules.
    const mid = (o1 + o2) / 2, inset = 92;
    const band = { amp: 4.2, period: 22, phases: [0, Math.PI * 2 / 3, Math.PI * 4 / 3] };
    s += `<path d="${_waveBand(inset, mid, CERT_W - inset, mid, band)}${_waveBand(inset, CERT_H - mid, CERT_W - inset, CERT_H - mid, band)}` +
      `${_waveBand(mid, inset, mid, CERT_H - inset, band)}${_waveBand(CERT_W - mid, inset, CERT_W - mid, CERT_H - inset, band)}" fill="none" stroke="${frameM.base}" stroke-opacity="0.72" stroke-width="0.7"/>`;
    const band2 = { amp: 2.2, period: 11, phases: [Math.PI / 2, Math.PI * 3 / 2] };
    s += `<path d="${_waveBand(inset, mid, CERT_W - inset, mid, band2)}${_waveBand(inset, CERT_H - mid, CERT_W - inset, CERT_H - mid, band2)}` +
      `${_waveBand(mid, inset, mid, CERT_H - inset, band2)}${_waveBand(CERT_W - mid, inset, CERT_W - mid, CERT_H - inset, band2)}" fill="none" stroke="${frameM.light}" stroke-opacity="0.38" stroke-width="0.5"/>`;
    // Corners: a violet gem triangle and a metal bracket with a diamond.
    const corner = (sx, sy) => {
      const X = (v) => (sx < 0 ? CERT_W - v : v), Y = (v) => (sy < 0 ? CERT_H - v : v);
      const tri = `${X(o1)},${Y(o1)} ${X(o1 + 70)},${Y(o1)} ${X(o1)},${Y(o1 + 70)}`;
      return `<polygon points="${tri}" fill="url(#gem)"/>` +
        `<line x1="${X(o1 + 70)}" y1="${Y(o1)}" x2="${X(o1)}" y2="${Y(o1 + 70)}" stroke="${frameM.light}" stroke-width="1.1"/>` +
        `<line x1="${X(o1 + 56)}" y1="${Y(o1)}" x2="${X(o1)}" y2="${Y(o1 + 56)}" stroke="${a.hi}" stroke-opacity="0.35" stroke-width="0.7"/>` +
        `<path d="M${X(o3 + 6)} ${Y(o3 + 46)}L${X(o3 + 6)} ${Y(o3 + 6)}L${X(o3 + 46)} ${Y(o3 + 6)}" fill="none" stroke="${frameM.base}" stroke-opacity="0.7" stroke-width="0.9"/>` +
        _diamond(X(o3 + 6), Y(o3 + 6), 4, { light: frameM.hi, dark: frameM.deep, edge: frameM.base });
    };
    s += corner(1, 1) + corner(-1, 1) + corner(1, -1) + corner(-1, -1);
    // Centre ornaments on the top and bottom rules.
    const centre = (y) => `<rect x="${768 - 40}" y="${y - 9}" width="80" height="18" fill="${C.background}"/>` +
      `<line x1="${768 - 38}" y1="${y}" x2="${768 - 16}" y2="${y}" stroke="${frameM.base}" stroke-width="0.9"/>` +
      `<line x1="${768 + 16}" y1="${y}" x2="${768 + 38}" y2="${y}" stroke="${frameM.base}" stroke-width="0.9"/>` +
      `<rect x="${768 - 9}" y="${y - 9}" width="18" height="18" fill="none" stroke="${frameM.light}" stroke-width="1" transform="rotate(45 768 ${y})"/>` +
      _diamond(768, y, 6, { light: a.hi, dark: a.deep, edge: frameM.light });
    s += centre(mid) + centre(CERT_H - mid);
    return s;
  })();

  const pattern = S.pattern ? (() => {
    // Security linework: a faint engraved rosette behind the name, concentric
    // halo rings round the medal, a fading hex field and two circuit traces.
    const rose = `<g transform="translate(${CX} 520)" opacity="0.075"><path d="${_rosette(300, 26, 36, 4, 1)}" fill="none" stroke="${frameM.base}" stroke-width="0.6"/>` +
      `<path d="${_rosette(236, 16, 28, 3, 1)}" fill="none" stroke="${a.light}" stroke-width="0.6"/></g>`;
    const hex = `<path d="${_hexField(1060, 560, 9, 9, 26)}" fill="none" stroke="${a.light}" stroke-width="0.8" mask="url(#hexMask)"/>`;
    const circuit = `<g fill="none" stroke="${a.light}" stroke-opacity="0.16" stroke-width="1">` +
      `<path d="M1500 640H1420L1392 668H1300"/><path d="M1500 700H1446L1414 732H1360L1340 752"/><path d="M1290 560H1352L1376 584"/></g>` +
      `<g fill="${a.light}" fill-opacity="0.22"><circle cx="1300" cy="668" r="2.6"/><circle cx="1340" cy="752" r="2.6"/><circle cx="1376" cy="584" r="2.6"/></g>`;
    return rose + hex + circuit;
  })() : "";

  const medal = S.medal ? `<g transform="translate(${MX} ${MY})">` +
    `<circle r="240" fill="url(#halo)"/>` +
    `<circle r="${MR + 16}" fill="none" stroke="${m.base}" stroke-opacity="0.35" stroke-width="5" filter="url(#ringglow)"/>` +
    `<circle r="${MR + 16}" fill="none" stroke="${m.light}" stroke-opacity="0.45" stroke-width="0.8"/>` +
    [205, 172].map((r, i) => `<circle r="${r}" fill="none" stroke="${i ? m.base : a.light}" stroke-opacity="${i ? 0.16 : 0.1}" stroke-width="${i ? 0.8 : 1}"${i ? "" : ' stroke-dasharray="1.5 5"'}/>`).join("") +
    `<g>${_laurel({ radius: 160, from: 205, to: 320, leaves: 17, leafLen: 46, leafW: 14, fillId: "leafAccent", vein: a.shadow, stem: a.mid, stemW: 2.6 })}</g>` +
    `<g transform="scale(-1 1)">${_laurel({ radius: 160, from: 205, to: 320, leaves: 17, leafLen: 46, leafW: 14, fillId: "leafAccent", vein: a.shadow, stem: a.mid, stemW: 2.6 })}</g>` +
    _medalArt(tier, m, C.accent, MR) + `</g>` : "";

  const shield = S.shield ? `<g transform="translate(768 884) scale(0.92)">` +
    `<g>${_laurel({ radius: 58, from: 200, to: 322, leaves: 8, leafLen: 20, leafW: 6.5, fillId: "leafMetal", vein: m.deep, stem: m.mid, stemW: 1.6 })}</g>` +
    `<g transform="scale(-1 1)">${_laurel({ radius: 58, from: 200, to: 322, leaves: 8, leafLen: 20, leafW: 6.5, fillId: "leafMetal", vein: m.deep, stem: m.mid, stemW: 1.6 })}</g>` +
    _shieldArt(C.accent, m) + `</g>` : "";

  const tagline = caps(T.footer_tagline);
  const tagFit = tagline ? _fitTracked(tagline, { maxWidth: 560, size: 14, minSize: 9, weight: 600, lsEm: 0.32 }) : null;
  const tagW = tagFit ? measureText(tagline, tagFit.size, 600, tagFit.ls) : 0;
  const presentedFit = presented ? _fitTracked(presented, { maxWidth: 400, size: 15, minSize: 10, weight: 600, lsEm: 0.3 }) : null;
  const presentedW = presentedFit ? measureText(presented, presentedFit.size, 600, presentedFit.ls) : 0;
  const leadFit = leadIn ? _fitTracked(leadIn, { maxWidth: COLW, size: 15, minSize: 10, weight: 600, lsEm: 0.22 }) : null;

  const wordmark = (S.logo && CHECKMARX_LOGO)
    ? checkmarxLogoGroup(124, 94, 232)
    : _tline(fill(T.wordmark), { x: 124, y: 132, size: 40, weight: 600, ls: -0.6, fill: C.text, anchor: "start" });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CERT_W}" height="${CERT_H}" viewBox="0 0 ${CERT_W} ${CERT_H}">
  <defs>
    <radialGradient id="poolA" cx="0.36" cy="0.46" r="0.62"><stop offset="0" stop-color="${C.glow}" stop-opacity="0.85"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></radialGradient>
    <radialGradient id="poolB" cx="0.8" cy="0.31" r="0.36"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.26"/><stop offset="0.6" stop-color="${C.accent}" stop-opacity="0.06"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="nameLight" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${C.text}" stop-opacity="0.075"/><stop offset="0.6" stop-color="${C.text}" stop-opacity="0.025"/><stop offset="1" stop-color="${C.text}" stop-opacity="0"/></radialGradient>
    <linearGradient id="titleFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${_mix(C.text, frameM.light, 0.25)}"/></linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${m.base}" stop-opacity="0.2"/><stop offset="0.45" stop-color="${m.base}" stop-opacity="0.07"/><stop offset="1" stop-color="${m.base}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.72"><stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.6"/></radialGradient>
    <linearGradient id="frameStroke" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${frameM.light}"/><stop offset="0.3" stop-color="${frameM.base}"/><stop offset="0.5" stop-color="${frameM.hi}"/><stop offset="0.7" stop-color="${frameM.mid}"/><stop offset="1" stop-color="${frameM.light}"/></linearGradient>
    <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a.light}"/><stop offset="0.5" stop-color="${C.accent}"/><stop offset="1" stop-color="${a.deep}"/></linearGradient>
    <linearGradient id="r1L" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${frameM.base}" stop-opacity="0"/><stop offset="1" stop-color="${frameM.base}" stop-opacity="0.85"/></linearGradient>
    <linearGradient id="r1R" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${frameM.base}" stop-opacity="0.85"/><stop offset="1" stop-color="${frameM.base}" stop-opacity="0"/></linearGradient>
    <linearGradient id="r1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${frameM.base}" stop-opacity="0"/><stop offset="0.5" stop-color="${frameM.base}" stop-opacity="0.85"/><stop offset="1" stop-color="${frameM.base}" stop-opacity="0"/></linearGradient>
    <linearGradient id="vrule" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${frameM.base}" stop-opacity="0"/><stop offset="0.5" stop-color="${frameM.base}" stop-opacity="0.7"/><stop offset="1" stop-color="${frameM.base}" stop-opacity="0"/></linearGradient>
    <linearGradient id="metalText" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.45" stop-color="${m.light}"/><stop offset="0.55" stop-color="${m.base}"/><stop offset="1" stop-color="${_tint(m.base, 0.15)}"/></linearGradient>
    <linearGradient id="nameFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${C.text}"/></linearGradient>
    <linearGradient id="eventFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${_tint(C.accent, 0.42)}"/><stop offset="1" stop-color="${_tint(C.accent, 0.12)}"/></linearGradient>
    <linearGradient id="rim" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.22" stop-color="${m.base}"/><stop offset="0.42" stop-color="${m.deep}"/><stop offset="0.58" stop-color="${m.light}"/><stop offset="0.78" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.shadow}"/></linearGradient>
    <linearGradient id="bevelOut" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.5" stop-color="${m.base}"/><stop offset="1" stop-color="${m.shadow}"/></linearGradient>
    <linearGradient id="bevelIn" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="${m.shadow}"/><stop offset="0.5" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.hi}"/></linearGradient>
    <radialGradient id="face" cx="0.36" cy="0.3" r="0.85"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.35" stop-color="${m.light}"/><stop offset="0.75" stop-color="${m.base}"/><stop offset="1" stop-color="${m.mid}"/></radialGradient>
    <radialGradient id="field" cx="0.4" cy="0.34" r="0.8"><stop offset="0" stop-color="${m.light}"/><stop offset="0.7" stop-color="${m.base}"/><stop offset="1" stop-color="${m.mid}"/></radialGradient>
    <radialGradient id="innershade" cx="0.42" cy="0.38" r="0.62"><stop offset="0.78" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.28"/></radialGradient>
    <linearGradient id="rimspec" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
    <linearGradient id="specular" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.42"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
    <linearGradient id="emblem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.hi}"/><stop offset="1" stop-color="${m.light}"/></linearGradient>
    <linearGradient id="ribbon" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a.light}"/><stop offset="0.45" stop-color="${C.accent}"/><stop offset="1" stop-color="${a.deep}"/></linearGradient>
    <linearGradient id="leafAccent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a.light}"/><stop offset="1" stop-color="${a.deep}"/></linearGradient>
    <linearGradient id="leafMetal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.5" stop-color="${m.base}"/><stop offset="1" stop-color="${m.deep}"/></linearGradient>
    <linearGradient id="shieldFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a.light}"/><stop offset="0.55" stop-color="${C.accent}"/><stop offset="1" stop-color="${a.shadow}"/></linearGradient>
    <linearGradient id="metalStroke" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.hi}"/><stop offset="0.5" stop-color="${m.base}"/><stop offset="1" stop-color="${m.light}"/></linearGradient>
    <radialGradient id="hexFade" cx="0.75" cy="0.6" r="0.55"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.2"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
    <mask id="hexMask"><rect x="1030" y="520" width="480" height="460" fill="url(#hexFade)"/></mask>
    <clipPath id="band"><path d="M0 ${-(MR - 24)}A${MR - 24} ${MR - 24} 0 1 1 0 ${MR - 24}A${MR - 24} ${MR - 24} 0 1 1 0 ${-(MR - 24)}ZM0 ${-(MR * 0.5 + 3)}A${MR * 0.5 + 3} ${MR * 0.5 + 3} 0 1 0 0 ${MR * 0.5 + 3}A${MR * 0.5 + 3} ${MR * 0.5 + 3} 0 1 0 0 ${-(MR * 0.5 + 3)}Z" clip-rule="evenodd"/></clipPath>
    <filter id="softshadow" x="-0.5" y="-0.5" width="2" height="2"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="ringglow" x="-0.2" y="-0.2" width="1.4" height="1.4"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="glint" x="-2" y="-2" width="5" height="5"><feGaussianBlur stdDeviation="2.5"/></filter>
  </defs>

  <rect width="${CERT_W}" height="${CERT_H}" fill="${C.background}"/>
  <rect width="${CERT_W}" height="${CERT_H}" fill="url(#poolA)"/>
  <rect width="${CERT_W}" height="${CERT_H}" fill="url(#poolB)"/>
  <ellipse cx="${CX}" cy="430" rx="470" ry="230" fill="url(#nameLight)"/>
  ${pattern}
  <rect width="${CERT_W}" height="${CERT_H}" fill="url(#vignette)"/>
  ${frame}

  ${wordmark}
  ${hub ? _diamond(130, 151, 5.5, { light: a.hi, dark: a.deep, edge: a.light }) + _tline(hub, { x: 146, y: 156, size: hubFit.size, ls: hubFit.ls, fill: _tint(C.accent, 0.55), anchor: "start" }) : ""}

  ${_tline(title, { x: CX, y: 264, size: titleFit.size, weight: 600, ls: titleFit.ls, fill: "url(#titleFill)" })}
  ${_rule("r1", CX - 400, CX + 400, 298, { diamond: { light: a.hi, dark: a.deep, edge: frameM.light } })}

  ${presented ? `<rect x="${_f(CX - presentedW / 2 - 108)}" y="345.4" width="84" height="1" fill="url(#r1L)"/><rect x="${_f(CX + presentedW / 2 + 24)}" y="345.4" width="84" height="1" fill="url(#r1R)"/>` +
    _tline(presented, { x: CX, y: 351, size: presentedFit.size, ls: presentedFit.ls, fill: frameM.light }) : ""}

  ${nameFit.lines.map((ln, i) => `<text class="cert-name" x="${CX}" y="${nameBase[i].toFixed(0)}" text-anchor="middle" ${_fontAttrs(NAME_WEIGHT)} font-size="${nameFit.size}" letter-spacing="${NAME_LS}" fill="url(#nameFill)">${escXml(ln)}</text>`).join("\n  ")}

  ${leadIn ? _tline(leadIn, { x: CX, y: leadY, size: leadFit.size, ls: leadFit.ls, fill: C.muted }) : ""}
  ${evLines.map((ln, i) => _tline(ln, { x: CX, y: evY[i], size: evSize, weight: 800, ls: evLs, fill: "url(#eventFill)" })).join("\n  ")}
  ${sprigs}

  ${_rule("r1", CX - 400, CX + 400, rule2Y, { diamond: { light: a.hi, dark: a.deep, edge: frameM.light } })}
  ${recLines.map((ln, i) => _tline(ln, { x: CX, y: recY[i], size: recSize, weight: 400, ls: 0.3, fill: _mix(frameM.light, C.muted, 0.35) })).join("\n  ")}

  ${_rule("r1", 140, 1396, 716, { diamond: { light: a.hi, dark: a.deep, edge: frameM.light } })}
  ${statCols}

  ${shield}
  ${verifyBlock}

  ${tagline ? `<rect x="${_f(768 - tagW / 2 - 132)}" y="961.5" width="108" height="1" fill="url(#r1L)"/><rect x="${_f(768 + tagW / 2 + 24)}" y="961.5" width="108" height="1" fill="url(#r1R)"/>` +
    _tline(tagline, { x: 768, y: 967, size: tagFit.size, ls: tagFit.ls, fill: _tint(C.accent, 0.4) }) : ""}

  ${medal}
</svg>`;
}

// ── Rasteriser ──────────────────────────────────────────────────────────────
// resvg is a native module; lazy + defensive (a missing binary degrades the
// feature to "unavailable" rather than wedging boot), mirroring the esbuild
// fallback in server.js.
let _resvgMod;
let _resvgUnavailable = false;
let _fontCache = null;

function _loadResvg() {
  if (_resvgUnavailable) return null;
  if (_resvgMod) return _resvgMod;
  try {
    _resvgMod = require("@resvg/resvg-js");
    return _resvgMod;
  } catch (e) {
    _resvgUnavailable = true;
    try { require("./log").log.error({ err: e.message }, "badge: @resvg/resvg-js unavailable — badge rendering disabled"); } catch (e2) { /* logging best-effort */ swallowed("badge:resvg-unavailable-log", e2); }
    return null;
  }
}

function _fontBuffers() {
  if (_fontCache) return _fontCache;
  _fontCache = FONT_FILES.filter(f => { try { return fs.existsSync(f); } catch { return false; } });
  return _fontCache;
}

/**
 * The font files ONE render needs: Inter always, then — in FALLBACK_FACES order —
 * only the fallback faces that draw a character of this SVG Inter lacks. resvg
 * reads every file it is handed on every render, and the CJK face is 17 MB, so a
 * Latin certificate is handed exactly the three Inter files it always was (and
 * renders byte for byte as before), and a Chinese one the CJK face as well.
 * Decided by the SVG's characters alone, so one SVG always renders the same.
 */
function _fontFilesFor(svg) {
  const base = _fontBuffers();
  const m = _loadFontMetrics(800);
  if (!m) return base;
  const need = new Set();
  // Only non-ASCII characters can need a face Inter lacks; the SVG is mostly
  // ASCII path data, so a native scan for them keeps this off the render's cost.
  for (const mm of String(svg == null ? "" : svg).matchAll(/[^\x00-\x7F]/gu)) {
    // A space or an ignorable Inter lacks is drawn by Inter all the same.
    if (_passesAnyFace(mm[0])) continue;
    const cp = mm[0].codePointAt(0);
    if (m.hasGlyph(cp)) continue;
    const f = _fallbackFaceFor(cp);
    if (f) need.add(f.face);
  }
  if (!need.size) return base;
  return [...base, ...FALLBACK_FACES.filter(f => need.has(f)).map(f => f.path)];
}

class BadgeRenderUnavailable extends Error {}

/**
 * Rasterise a badge SVG to a PNG Buffer. Uses resvg's renderAsync so the
 * (CPU-bound) rasterisation runs on the libuv threadpool instead of blocking
 * the event loop on the participant mint path. Rejects with BadgeRenderUnavailable
 * if resvg is missing.
 */
/** The intrinsic width an SVG declares — the two canvases are different sizes. */
function _svgWidth(svg) {
  const m = /<svg[^>]*\swidth="(\d+)"/.exec(String(svg || ""));
  return m ? Number(m[1]) : BADGE_W;
}

async function renderBadgePng(svg) {
  const mod = _loadResvg();
  if (!mod || typeof mod.renderAsync !== "function") throw new BadgeRenderUnavailable("badge rendering unavailable");
  const img = await mod.renderAsync(svg, {
    font: { fontFiles: _fontFilesFor(svg), loadSystemFonts: false, defaultFontFamily: "Inter" },
    // v7.21.29 — read the width off the SVG rather than assuming the share
    // canvas. The certificate is 1536x1024; rasterising it at 1200 would scale
    // it down and, worse, silently keep working.
    fitTo: { mode: "width", value: _svgWidth(svg) },
  });
  return img.asPng();
}

// ── Certificate PDF (v7.15.0) ───────────────────────────────────────────────
// Participants asked for a PDF of the certificate alongside the image (a PDF is
// what actually gets attached to an email or filed with a training record).
//
// Written by hand against zlib rather than pulling in a PDF library. resvg
// already gives us the rendered certificate as raw RGBA (`img.pixels`), and a
// single-page PDF containing one image is a small, fully-specified structure —
// so the alternative was a new runtime dependency, a rebuild + 4 GB re-push of
// the CI image (any lockfile change forces one), and more supply-chain surface,
// all to place one bitmap on one page. Everything below is plain PDF 1.4.
//
// The image is split into an RGB stream plus an 8-bit alpha /SMask because PDF
// has no RGBA colour space; both are Flate-compressed with Node's built-in zlib.
const A4_LANDSCAPE = { w: 841.89, h: 595.28 }; // points (72dpi), the common certificate size
const PDF_MARGIN = 36;                          // 0.5in breathing room around the art

// PDF text strings are Latin-1 unless written as a UTF-16BE hex string with a
// BOM. Participant names here are full Unicode (only the NICKNAME is restricted
// to ASCII — see the nickname-charset note in CLAUDE.md), and competition names
// are free text, so a Latin-1 literal silently mangles "José" or an em-dash.
// Always emit the hex form: it is valid for pure ASCII too, so there is no
// branch to get wrong.
function _pdfTextString(s) {
  const utf16 = Buffer.from("﻿" + String(s == null ? "" : s), "utf16le");
  for (let i = 0; i < utf16.length; i += 2) {           // utf16le -> utf16be
    const t = utf16[i]; utf16[i] = utf16[i + 1]; utf16[i + 1] = t;
  }
  return `<${utf16.toString("hex")}>`;
}

/**
 * Build a one-page PDF (Buffer) that centres `rgba` (w x h) on A4 landscape.
 * `title` becomes the document title in the PDF metadata / viewer tab.
 *
 * Async because it Flate-compresses up to ~3 MB of pixel data per call and the
 * route that calls it is PUBLIC: `deflateSync` on those buffers measured ~24 ms
 * of event-loop block, which a burst of downloads would multiply against a
 * single-process server. `zlib.deflate` runs on the libuv threadpool instead —
 * the same reason renderBadgePng/renderBadgePdf use resvg's async renderer.
 */
// 8-bit value -> nearest 6-bit level (rounded, clamped to the top level).
const _PDF_QUANT = Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, v + 2) & 0xfc);

async function buildPdfFromRgba(rgba, w, h, title) {
  const zlib = require("zlib");
  const deflate = require("util").promisify(zlib.deflate);
  const px = w * h;
  const rgb = Buffer.allocUnsafe(px * 3);
  const alpha = Buffer.allocUnsafe(px);
  // Size: the emailed PDF must stay under 400 KB. Nearly all of the raster's
  // entropy is anti-aliasing and gradient noise in the two lowest bits of each
  // channel (measured on the gold certificate: 686 KB at 8 bits, 493 KB at 7,
  // 347 KB at 6). So colour is rounded to 6 bits per channel (steps of 4/255),
  // which is below what a print or a screen at A4 shows; alpha stays exact.
  const Q = _PDF_QUANT;
  let opaque = true;
  for (let i = 0; i < px; i++) {
    rgb[i * 3] = Q[rgba[i * 4]];
    rgb[i * 3 + 1] = Q[rgba[i * 4 + 1]];
    rgb[i * 3 + 2] = Q[rgba[i * 4 + 2]];
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  const [rgbZ, alphaZ] = await Promise.all([deflate(rgb), opaque ? null : deflate(alpha)]);

  // Fit the art inside the margins, preserving aspect, and centre it.
  const availW = A4_LANDSCAPE.w - PDF_MARGIN * 2;
  const availH = A4_LANDSCAPE.h - PDF_MARGIN * 2;
  const scale = Math.min(availW / w, availH / h);
  const drawW = w * scale, drawH = h * scale;
  const x = (A4_LANDSCAPE.w - drawW) / 2, y = (A4_LANDSCAPE.h - drawH) / 2;

  // PDF y-axis points up and images draw into the unit square, so the CTM is
  // (width 0 0 height x y) — no flip needed, resvg's first row is the top row
  // and PDF /DecodeParms-free Flate images are read top-row-first as well.
  const content = Buffer.from(`q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`, "latin1");
  const contentZ = await deflate(content);

  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; }; // 1-based object numbers

  const catalogN = add(null);           // placeholder, filled after we know Pages
  const pagesN = add(null);
  const pageN = add(null);
  const contentN = add(Buffer.concat([
    Buffer.from(`<< /Length ${contentZ.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), contentZ, Buffer.from("\nendstream", "latin1"),
  ]));
  const smaskN = alphaZ ? add(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${alphaZ.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    alphaZ, Buffer.from("\nendstream", "latin1"),
  ])) : 0;
  const imgN = add(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8${smaskN ? ` /SMask ${smaskN} 0 R` : ""} /Length ${rgbZ.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    rgbZ, Buffer.from("\nendstream", "latin1"),
  ]));
  const infoN = add(Buffer.from(`<< /Title ${_pdfTextString(title)} /Producer ${_pdfTextString("Hack Arena")} >>`, "latin1"));

  objs[catalogN - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesN} 0 R >>`, "latin1");
  objs[pagesN - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageN} 0 R] /Count 1 >>`, "latin1");
  objs[pageN - 1] = Buffer.from(
    `<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${A4_LANDSCAPE.w} ${A4_LANDSCAPE.h}] ` +
    `/Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contentN} 0 R >>`, "latin1");

  // Serialise with a real xref table — byte offsets must be exact or strict
  // readers (Ghostscript, print drivers) reject the file.
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(offset);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogN} 0 R /Info ${infoN} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

/**
 * Rasterise a badge SVG and wrap it in a single-page A4-landscape PDF.
 * Same availability contract as renderBadgePng — throws BadgeRenderUnavailable
 * when resvg is missing, so the route can 503 rather than wedge.
 */
async function renderBadgePdf(svg, title) {
  const mod = _loadResvg();
  if (!mod || typeof mod.renderAsync !== "function") throw new BadgeRenderUnavailable("badge rendering unavailable");
  // renderAsync, NOT the synchronous `new Resvg(...).render()` — same reason
  // renderBadgePng gives above, and it matters MORE here: this route is public
  // and unauthenticated, so a burst of certificate downloads would otherwise
  // stall the (single-process) server for ~37 ms each while it rasterises.
  const img = await mod.renderAsync(svg, {
    font: { fontFiles: _fontFilesFor(svg), loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: _svgWidth(svg) },
  });
  return await buildPdfFromRgba(img.pixels, img.width, img.height, title || "Certificate");
}

/** True when the rasteriser + at least one font are usable (for boot diagnostics). */
function badgeRenderingAvailable() {
  const mod = _loadResvg();
  return !!(mod && typeof mod.renderAsync === "function") && _fontBuffers().length > 0;
}

module.exports = {
  permilleText,
  buildBadgeSvg,
  renderBadgePng,
  renderBadgePdf,
  buildPdfFromRgba,
  badgeRenderingAvailable,
  BadgeRenderUnavailable,
  isPlacementRank,
  earnsPlacement,
  isPlacementBasis,
  buildCertificateSvg,
  certificateName,
  certificateNameParts,
  certificatePrintedName,
  badgeBasisLabel,
  credentialNameKey,
  credentialNameKeyDigraph,
  normaliseCredentialCode,
  generateCredentialCode,
  formatCredentialCode,
  CREDENTIAL_ALPHABET,
  CREDENTIAL_CODE_LEN,
  credentialMatchKeys,
  canRenderText,
  badgeDateLabel,
  // exported for unit tests
  _fitNameLines: fitNameLines,
  _measureText: measureText,
  _fontFilesFor,
  _nameExtentEm,
  _drawPlan,
  _resvgText,
  FALLBACK_FACES,
  FONT_FILES,
};
