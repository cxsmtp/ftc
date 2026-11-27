"use strict";

// HTML/rich-text sanitization + image ingest + avatar validation.
// (Domain: cross-cutting. Deps: sanitize-html, db, uuid.) escapeHtml is the
// pure HTML-escape used across template strings; processRichText sanitizes
// task rich content and persists embedded data: URIs as /api/images rows.

const sanitiseHtml = require("sanitize-html");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { swallowed } = require("./best-effort");
const { now } = require("./time");
const { recordOrphanedAuditEvent } = require("./audit");

const AVATAR_MAX_BYTES = 256 * 1024; // 256 KB
const AVATAR_ALLOWED_TYPES = new Set(["png", "jpeg", "jpg", "gif", "webp"]);
// Defence against decompression-bomb avatars: a 256 KB JPEG can decode to a
// hundred-megapixel bitmap that exhausts client memory when rendered. Cap
// total pixels at ~16M (4096×4096), comfortably above any legitimate avatar
// resolution. Format-aware parsers below extract dimensions from the raw
// header without spinning up an image decoder.
const IMAGE_MAX_PIXELS = 16 * 1024 * 1024;
// v8.3.20 (external audit) — A BYTE CAP ON AN EMBEDDED RICH-TEXT IMAGE.
//
// `extractAndStoreImages` enforced a subtype allowlist and a PIXEL cap and no
// byte cap at all, and the pixel cap is trivially bypassed: `_getImageDimensions`
// reads the PNG IHDR at fixed offsets, so a valid 1x1 header plus megabytes of
// trailing filler passes every check. Measured: a 20,971,553-byte "PNG" imported
// successfully and `SELECT length(data) FROM images` returned exactly that, while
// the stored description was 94 characters — so the TASK_FIELD_CAPS clamp could
// never fire, because by then the bytes are an `/api/images/<uuid>` reference.
//
// The worst case is the challenge IMPORT (128 MB body ≈ 96 MB of decoded image
// bytes per request) into hackathon.db, which *Data storage* lists as BACKED UP,
// where an unreferenced rich-text image stays until the daily orphaned-image
// sweep (lib/image-sweep.js) reclaims it, at least a week later. The create/PUT path is bounded by accident rather than by
// design: it checks TASK_FIELD_CAPS BEFORE processRichText, so the base64 is
// still inline when the cap is measured.
//
// The cap therefore lives at the SINK, not at any one caller: this is the single
// place every rich-text write converges (each processRichText call, and the
// challenge import, which runs processRichText's two halves apart), so the
// ordering asymmetry (cap-then-process vs process-then-clamp) stops mattering.
// Rejection STRIPS the <img>, exactly as the pixel cap does, rather than letting the data: URI
// through — and the drop is COUNTED (see `takeDroppedImageCount`), because a
// silent drop is the v7.21.2 defect this very release invokes elsewhere.
//
// 8 MB, not 2. A first draft used 2 MB and would have silently deleted ordinary
// content: a genuine 1200x800 screenshot measures ~2.9 MB, which is 0.96 MP
// against a 16 MP pixel cap the module calls the legitimate bound — so the byte
// cap would have been the binding constraint on real images rather than on
// bombs. 8 MB clears any pasted screenshot and any phone photo, while still
// bounding a single embedded image to a twelfth of the import body limit.
const RICH_IMG_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per embedded image

// v8.3.20 — how many <img> the last processRichText pass STRIPPED for being
// over the byte cap. A module-level counter rather than a return value because
// `processRichText` is called at several sites with an established signature and
// only the importer reports a per-batch count; `takeDroppedImageCount()` reads
// and RESETS, so a caller measures its own pass. Single-process and synchronous
// (extractAndStoreImages is a plain String.replace, and the challenge import
// calls it and reads the count inside one transaction), so there is no
// interleaving to get wrong.
let _droppedOversizeImages = 0;
function takeDroppedImageCount() { const n = _droppedOversizeImages; _droppedOversizeImages = 0; return n; }

function _getImageDimensions(buf, kind) {
  try {
    if (kind === "png" && buf.length >= 24) {
      // PNG: 8-byte signature, then IHDR chunk: 4 length, 4 type, 4 width, 4 height (big-endian).
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        return { width: w, height: h };
      }
    }
    if (kind === "gif" && buf.length >= 10) {
      // GIF87a / GIF89a: signature 6 bytes, then little-endian width(2), height(2).
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
    }
    if (kind === "jpeg" || kind === "jpg") {
      // Walk JPEG markers until SOFn (0xFFC0..0xFFCF excluding 0xC4/0xC8/0xCC).
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i < buf.length - 9) {
          if (buf[i] !== 0xff) return null;
          let marker = buf[i + 1];
          // Skip padding bytes
          while (marker === 0xff && i + 1 < buf.length) { i++; marker = buf[i + 1]; }
          // SOFn frame headers carry the dimensions
          const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
          if (isSOF) {
            const h = buf.readUInt16BE(i + 5);
            const w = buf.readUInt16BE(i + 7);
            return { width: w, height: h };
          }
          // Skip this segment using its length
          if (i + 3 >= buf.length) return null;
          const segLen = buf.readUInt16BE(i + 2);
          i += 2 + segLen;
        }
      }
    }
    if (kind === "webp" && buf.length >= 30) {
      // RIFF....WEBP, then VP8 / VP8L / VP8X
      if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
        const fourcc = buf.toString("ascii", 12, 16);
        if (fourcc === "VP8 ") {
          const w = buf.readUInt16LE(26) & 0x3fff;
          const h = buf.readUInt16LE(28) & 0x3fff;
          return { width: w, height: h };
        }
        if (fourcc === "VP8L") {
          const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
          const w = ((b1 & 0x3f) << 8 | b0) + 1;
          const h = ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6) + 1;
          return { width: w, height: h };
        }
        if (fourcc === "VP8X") {
          const w = (buf[24] | buf[25] << 8 | buf[26] << 16) + 1;
          const h = (buf[27] | buf[28] << 8 | buf[29] << 16) + 1;
          return { width: w, height: h };
        }
      }
    }
  } catch (e) { /* malformed → treat as unknown */ swallowed("sanitise:malformed-input", e); }
  return null;
}

// Validate + persist a data:image/ avatar upload as an /api/images/<uuid> row.
// Returns the new ref, or null if the data URI is malformed / wrong type /
// over the byte cap / a pixel bomb. Called from sanitiseAvatar.
// ext-audit v7.15.13 — validation is SEPARATE from persistence.
//
// The two used to be one step, so the image row was written the moment an
// avatar was decoded. A caller that then rejected the request for an unrelated
// reason (PUT /api/me validates nickname, email and LinkedIn URL *after* the
// avatar) left the BLOB behind with nothing referencing it — every rejected
// save leaked a row up to the 256 KB cap, and the caller had no way to undo it
// because the INSERT was already committed outside any transaction.
//
// Splitting them lets a caller validate early (so a bad avatar still fails
// fast) and persist late (only once the whole update is going to succeed).
// Returns the decoded {buf, imgType} or null on any rejection.
function validateAvatarDataUri(dataUri) {
  if (!dataUri || !dataUri.startsWith("data:image/")) return null;
  const m = dataUri.match(/^data:image\/([^;]+);base64,(.+)$/);
  if (!m) return null;
  const imgType = m[1].toLowerCase();
  if (!AVATAR_ALLOWED_TYPES.has(imgType)) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > AVATAR_MAX_BYTES) return null;
  // Pixel-dimension cap: 256 KB byte limit doesn't catch a heavily-compressed
  // 50000×50000 bomb. If we can read dimensions, enforce them; otherwise the
  // byte cap is the only remaining defence (acceptable for an unknown format).
  const dims = _getImageDimensions(buf, imgType);
  if (dims && dims.width * dims.height > IMAGE_MAX_PIXELS) return null;
  if (dims && (dims.width <= 0 || dims.height <= 0)) return null;
  return { buf, imgType };
}

// Persist a previously-validated avatar. Call this ONLY once the surrounding
// update is committed to succeeding.
function persistAvatar({ buf, imgType }) {
  const id = uuid();
  db.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)")
    .run(id, buf, `image/${imgType}`, now().toISOString());
  return `/api/images/${id}`;
}

function storeAvatarFromDataUri(dataUri) {
  const v = validateAvatarDataUri(dataUri);
  return v ? persistAvatar(v) : null;
}

const ALLOWED_FONTS = ["Arial","Georgia","Times New Roman","Courier New","Verdana","Trebuchet MS","Inter"];
const FONT_SIZE_MAP = { "1":"0.65rem","2":"0.8rem","3":"0.9rem","4":"1.1rem","5":"1.3rem","6":"1.6rem","7":"2rem" };

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const VALID_AVATARS = new Set(["🦊","🐺","🦁","🐯","🦅","🐉","🤖","👾","🦄","🐼","🦋","🎩","🐸","🦉","🐧","🦈","🐙","🦀","🎭","🧙","🦖","🐝","🦚","🔥","default1"]);
// THREE return shapes, and callers must distinguish them (v8.3.35 — the header
// described two until the ref-resolution check below gained a third):
//   <string>   the value to store.
//   null       a `data:image/` upload was REJECTED (bad type / too large / a
//              pixel bomb). Callers answer 400 — the user supplied something
//              and it is not usable.
//   undefined  the value names nothing we can store: a `/api/images/...` link
//              whose row no longer exists, one that is not the account's own
//              current avatar (below), a malformed one, or a non-string. NOT a
//              rejection — the caller keeps whatever the row already had (or
//              falls back to "default1" via `|| "default1"` on the create paths).
//
// AN EXISTING PICTURE IS ACCEPTED ONLY AS THE ACCOUNT'S OWN CURRENT AVATAR
// (`current`, the row's avatar as stored; since 9.2.18). Any other
// `/api/images/<id>` is treated as a dead reference: an account could otherwise
// point its avatar at another person's photo or an older certificate's share
// image, which those pictures' own deletes (a replaced or erased avatar, the two
// erasure deletes of certificate images in lib/account-reaper.js and the event
// DELETE) then break. The SPA never sends one: it sends a preset, a new upload
// (`data:image/`) or the avatar it read from the row. A caller passing no
// `current` (a new account, the perf bulk seed) accepts no existing picture.
//
// `preserve` is the participant IMPORT: it asks only that the picture exists (no
// `current`: a file names its rows' avatars), and a link to one that does not is
// `undefined`, which the import counts (`avatar_links_dropped`).
function sanitiseAvatar(avatar, { preserve = false, current } = {}) {
  if (!avatar) return "default1";
  // v8.3.35 (self-review of v8.3.34) — TYPE FIRST, because the branches below
  // coerce. `RegExp#test` stringifies its argument, so `["/api/images/aaaa"]`
  // MATCHED the ref pattern; `Array.prototype.slice` then returned an ARRAY,
  // which better-sqlite3 spreads as positional bindings — reproduced through
  // the real route as a **500** on `PUT /api/admin/participants/:id`, whose
  // `_firstNonStringField` list does not include `avatar`. That is the v8.3.20
  // field-shape class, introduced by v8.3.34's own fix: the pre-fix branch was
  // an unconditional `return avatar`, so it never touched the value.
  // `undefined`, not "default1" — a malformed body must not silently REPLACE a
  // participant's real avatar.
  if (typeof avatar !== "string") return undefined;
  if (VALID_AVATARS.has(avatar)) return avatar;
  // Any picture link at all is decided here, never by the import's
  // "unknown safe string" branch below, which once stored a malformed one as is.
  if (/^\/api\/images\//i.test(avatar)) {
    if (!/^\/api\/images\/[a-f0-9-]+$/i.test(avatar)) return undefined;
    // v8.3.34 (external audit) — THE REF MUST RESOLVE.
    //
    // The shape check alone accepted a ref to an image row that no longer
    // exists, and that is reachable without any adversary: the profile editor
    // sends the WHOLE form, including the avatar it read when the dialog was
    // opened. So a save from a dialog opened before some other writer (the
    // participant's own second tab, or an admin editing the same participant
    // through `PUT /api/admin/participants/:id`) replaced the avatar re-writes
    // the OLD ref — which that writer's own `deleteAvatarImage` has already
    // reclaimed. The result is not merely a stale avatar: it is a DANGLING one,
    // broken everywhere it renders.
    //
    // Worse, it takes the live image with it. `PUT /api/me` reclaims the
    // previous blob whenever the value changed, so writing the dead ref W over
    // the live ref X deletes X as well: both blobs gone, and the row points at
    // neither.
    //
    // The import (`preserve`) asked the shape alone until 9.2.18, on the theory
    // that a file's rows could name pictures the same import creates; it creates
    // none from a link (a `data:image/` row gets a fresh id no file can name), so
    // a link must resolve there too, and, as at every door, name the account's
    // OWN current picture (an overwrite's; a new account has none): a file must
    // not hand one account another person's photo (the export inlines every
    // picture as `data:image/`, so no real round trip carries a link).
    if (avatar !== current) return undefined;
    const id = avatar.slice("/api/images/".length);
    const exists = db.prepare("SELECT 1 FROM images WHERE id=?").get(id);
    // `undefined` (not null) — a ref that names nothing is not a REJECTION the
    // way an oversized upload is; the caller keeps whatever the row already had
    // rather than 400ing a save whose other fields are perfectly good.
    return exists ? avatar : undefined;
  }
  if (typeof avatar === "string" && avatar.startsWith("data:image/")) return storeAvatarFromDataUri(avatar);
  // Import (preserve=true) path: accept unknown values ONLY if they look safe
  // (printable ASCII or emoji, no js: scheme, no control chars, <=200 chars).
  // Without this the import path would persist attacker-controlled strings like
  // "javascript:alert(1)" or path-traversal strings into users.avatar, which
  // then flow into <img src=> in every admin / leaderboard render.
  if (preserve && typeof avatar === "string") {
    const ok = avatar.length <= 200
      && /^[\x20-\x7E\u00A0-\uFFFF]+$/.test(avatar)
      && !/^\s*(javascript|vbscript|data|file)\s*:/i.test(avatar);
    if (ok) return avatar;
  }
  return "default1";
}

// HTML sanitizer (v6.8.0: sanitize-html only). Pre-v6.8.0 this chained a
// custom regex pass first, then sanitize-html as defence-in-depth. The regex
// pass was a maintenance burden (three near-identical branches for span /
// font / img; ad-hoc attribute parsing) and offered no net security benefit
// over sanitize-html alone — sanitize-html already runs on a proper HTML
// parser, which is the correct primitive. The config below reproduces the
// regex pass's acceptance surface:
//
// • Tags: structural (div/p/ol/ul/li/span/br/pre), inline text (b/strong/
//   i/em/u/s/del/strike), code/pre blocks with language-<lang> class,
//   anchors (forced target=_blank rel=noopener noreferrer), images
//   (data: and /api/images/<uuid> only), and legacy <font>.
// • Style allowlist: color / background-color (a literal, or a colour NAME's own
//   var(), see RICH_COLOURS below), font-family (restricted to
//   ALLOWED_FONTS), font-size (numeric + px/rem/em/%).
// • <font> is transformed to <span style="..."> with the same prop
//   translation rules the regex used to apply.
// • Bare URLs as <a href> are restricted to http:/https:; data: URIs are
//   only allowed on <img>.
function _transformAnchor(tagName, attribs) {
  const href = attribs.href || "";
  if (!/^https?:\/\//i.test(href)) return { tagName: "a", attribs: {} };
  return { tagName: "a", attribs: { href, target: "_blank", rel: "noopener noreferrer" } };
}
function _transformFont(tagName, attribs) {
  const props = [];
  if (attribs.color) {
    const v = attribs.color.trim();
    if (/^[#\w(),.\s]+$/.test(v)) props.push(`color:${v}`);
  }
  if (attribs.face) {
    const nv = attribs.face.replace(/['"]/g, "").trim().toLowerCase();
    if (ALLOWED_FONTS.some(f => f.toLowerCase() === nv)) props.push(`font-family:"${nv}"`);
  }
  if (attribs.size) {
    const sz = FONT_SIZE_MAP[attribs.size.trim()];
    if (sz) props.push(`font-size:${sz}`);
  }
  return { tagName: "span", attribs: props.length ? { style: props.join(";") } : {} };
}
// v6.16.53 — rich-text data: URI image subtype allowlist. Pre-fix
// `_transformImg` accepted ANY `data:image/*` subtype, including
// `data:image/svg+xml;base64,...` — which then got stored verbatim,
// served from same-origin /api/images/:id with a `Content-Type: image/
// svg+xml` header, and rendered as an SVG inline in the SPA. SVG can
// embed `<script>` and execute under the same-origin script-src 'self'
// CSP. Restricting subtypes to the avatar allowlist (png/jpeg/jpg/gif/
// webp) closes the surface. The list is intentionally narrower than
// AVATAR_ALLOWED_TYPES isn't yet defined at this point in the file
// (it's at line ~11470 after rate-limit middleware setup), so we
// inline the same set here.
const _RICH_IMG_ALLOWED_SUBTYPES = new Set(["png", "jpeg", "jpg", "gif", "webp"]);
function _transformImg(tagName, attribs) {
  const src = attribs.src || "";
  if (/^\/api\/images\/[\w-]+$/.test(src)) {
    return { tagName: "img", attribs: { src, style: "max-width:100%" } };
  }
  // data: URI — must be image/<allowed-subtype>;base64,...
  const m = /^data:image\/([a-z0-9+.-]+)(?:;|,)/i.exec(src);
  if (m && _RICH_IMG_ALLOWED_SUBTYPES.has(m[1].toLowerCase())) {
    return { tagName: "img", attribs: { src, style: "max-width:100%" } };
  }
  return { tagName: "", attribs: {} };
}
// ── v7.18.0 — tables ─────────────────────────────────────────────────────────
// Challenge authors need tables in the description / explanation / hint, and
// need to PASTE them from Word and from web pages. Word's clipboard HTML is the
// hostile case: it carries mso-* styles, <o:p>, conditional comments and a
// forest of nested <span>s, so the client normalises before insertion
// (public/js/ui/richtext.js) and this allowlist is the enforcement point.
//
// Kept deliberately narrow: structure + the presentational attributes a pasted
// table actually needs. No `id`, no `class` (nothing here is a hook), no
// event handlers, and no `width`/`height`/`border`/`bgcolor` presentation
// attributes — the equivalent CSS goes through the style allowlist below,
// which is regex-validated, whereas a bare attribute would not be.
const RICH_TABLE_TAGS = ["table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption"];

// THE RICH-TEXT COLOURS. The editor's Text colour and Highlight menus store a colour
// NAME as the custom property that draws it, `color:var(--rt-red)` or
// `background-color:var(--rt-hl-yellow)`, never a hex: a literal colour is readable
// in one mode at most (white vanishes by day, black at night), while each look x
// mode gives every name its own measured ink and tint (scripts/theme/looks.js
// rtInk / rtHighlight, generated into public/styles.css). Mirrored by RICH_COLOURS in
// public/js/ui/richtext.js (CI-locked).
//
// A colour value is therefore a literal (older content, a paste from Word or a web
// page, admitted as before) or EXACTLY a listed name's own var() for that property.
// Any other var() is dropped, never repaired: an unknown name draws nothing, the
// wrong kind (a tint as text) or the page's own tokens (`var(--bg)`) would draw in
// whatever colour the page has, unmeasured (inside a function too: `rgb(var(--glow))`),
// and a fallback (`var(--rt-red, #000)`) smuggles a literal back in.
const RICH_COLOURS = ["grey", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "pink"];
const _LITERAL_COLOUR = /^(?![\s\S]*var\()[#\w][\w(),.\s%-]*$/i;
const _INK_VALUES = [_LITERAL_COLOUR, new RegExp(`^var\\(--rt-(?:${RICH_COLOURS.join("|")})\\)$`)];
const _TINT_VALUES = [_LITERAL_COLOUR, new RegExp(`^var\\(--rt-hl-(?:${RICH_COLOURS.join("|")})\\)$`)];

// colspan / rowspan are the one place a pasted table can hurt us: sanitize-html
// validates attribute NAMES, never their values, so `colspan="100000"` would
// pass straight through and become a layout bomb in every participant's
// browser. Clamp to a value no real table exceeds, and drop anything that is
// not a positive integer rather than trying to repair it.
const _RICH_CELL_STYLES = {
  "text-align": [/^(left|right|center|justify)$/i],
  "vertical-align": [/^(top|middle|bottom|baseline)$/i],
  "background-color": _TINT_VALUES,
  color: _INK_VALUES,
  width: [/^\d{1,3}%$/],
};
// A table section (thead, tbody, tfoot) carries a tint and its alignment, as a row
// and a cell do. Mirrored by public/js/ui/richtext.js, whose renderer
// (RICH_SECTION_STYLES) and paste normaliser (RICH_STYLE_RULES) keep only these on a
// section (CI-locked).
const _RICH_SECTION_STYLES = {
  "background-color": _TINT_VALUES,
  "text-align": [/^(left|right|center|justify)$/i],
  "vertical-align": [/^(top|middle|bottom|baseline)$/i],
};

const _MAX_CELL_SPAN = 64;
function _clampSpan(v) {
  const n = parseInt(String(v ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return String(Math.min(n, _MAX_CELL_SPAN));
}
function _transformCell(tagName, attribs) {
  const out = {};
  const cs = _clampSpan(attribs.colspan);
  const rs = _clampSpan(attribs.rowspan);
  if (cs && cs !== "1") out.colspan = cs;
  if (rs && rs !== "1") out.rowspan = rs;
  if (attribs.style) out.style = attribs.style;   // still filtered by allowedStyles
  // Keep `scope` on a header cell: it is what tells a screen reader whether the
  // cell heads its column or its row, and a transformTags handler that returns
  // only the attributes it happens to care about silently drops it.
  if (tagName === "th") {
    const sc = String(attribs.scope || "").trim().toLowerCase();
    if (sc === "col" || sc === "row" || sc === "colgroup" || sc === "rowgroup") out.scope = sc;
  }
  return { tagName, attribs: out };
}

const _RICH_TEXT_OPTS = {
  allowedTags: [
    "b","strong","i","em","u","s","del","strike","pre",
    "code","a","br","div","p","ol","ul","li","span","img",
    ...RICH_TABLE_TAGS,
  ],
  nonTextTags: ["script", "style", "textarea", "noscript", "iframe", "object", "embed"],
  allowedAttributes: {
    code: ["class"],
    a: ["href", "target", "rel"],
    span: ["style"],
    img: ["src", "style"],
    table: ["style"],
    thead: ["style"], tbody: ["style"], tfoot: ["style"],
    tr: ["style"], caption: ["style"],
    td: ["colspan", "rowspan", "style"],
    th: ["colspan", "rowspan", "style", "scope"],
  },
  allowedClasses: { code: [/^language-[a-zA-Z0-9_-]+$/] },
  allowedSchemes: ["http", "https"],
  allowedSchemesByTag: { img: ["data", "http", "https"] },
  // Mirrored, tag by tag (all but img and "*"), by RICH_STYLE_RULES in
  // public/js/ui/richtext.js: what a paste keeps, so it shows what a save stores.
  // A change here changes it there too (CI-locked, tests/richtext-tables.spec.js).
  allowedStyles: {
    span: {
      color: _INK_VALUES,
      "background-color": _TINT_VALUES,
      "font-family": [/^["']?[a-zA-Z0-9 ,-]+["']?$/],
      "font-size": [/^\d+(\.\d+)?(px|rem|em|%)$/i],
    },
    img: { "max-width": [/^100%$/] },
    // The presentational properties a pasted table legitimately carries.
    // `width` is percent-only on purpose: a pixel width from a Word document is
    // sized for A4 and overflows a phone.
    table: {
      width: [/^\d{1,3}%$/],
      "background-color": _TINT_VALUES,
    },
    td: _RICH_CELL_STYLES,
    th: _RICH_CELL_STYLES,
    tr: { "background-color": _TINT_VALUES },
    thead: _RICH_SECTION_STYLES,
    tbody: _RICH_SECTION_STYLES,
    tfoot: _RICH_SECTION_STYLES,
    caption: { "text-align": [/^(left|right|center)$/i] },
    // EVERY TAG ALLOWED A STYLE NEEDS A RULE ABOVE. sanitize-html filters a style only
    // by the tag's own rule or a "*" rule; with neither, it keeps the style exactly as
    // written (a page token in var(), url(), position:fixed). This empty rule is that
    // "*": a tag given `style` in allowedAttributes without a rule of its own keeps no
    // declaration at all, and a tag with one is unchanged (its rule merged with
    // nothing). Locked in tests/richtext-colours.spec.js, beside a control that this
    // sanitize-html does keep an unruled style.
    "*": {},
  },
  transformTags: {
    a: _transformAnchor,
    font: _transformFont,
    img: _transformImg,
    td: _transformCell,
    th: _transformCell,
  },
};
function sanitiseRichText(html) {
  if (html == null) return null;
  if (!html) return "";
  return sanitiseHtml(html, _RICH_TEXT_OPTS);
}

// Optional outParamIds — if the caller passes an array, every newly-stored
// image id is pushed onto it so the caller can roll the ids up into its
// parent audit event (e.g. task_created / task_edited).
function extractAndStoreImages(html, outParamIds) {
  if (!html) return html;
  return html.replace(/<img\s+([^>]*)>/gi, (match, attrs) => {
    const srcM = attrs.match(/src\s*=\s*"(data:image\/([^;]+);base64,([^"]*))"/i);
    if (!srcM) return match;
    const kind = srcM[2].toLowerCase();
    // v6.16.53 — subtype allowlist (defence in depth alongside the
    // _transformImg gate above). An attacker who bypasses the
    // sanitiser by hand-crafting an <img> tag would be stopped here:
    // unrecognised subtypes (svg+xml, etc.) get the <img> stripped
    // without an INSERT into the images table.
    if (!_RICH_IMG_ALLOWED_SUBTYPES.has(kind)) return "";
    const buffer = Buffer.from(srcM[3], "base64");
    // v8.3.20 — the byte cap, checked on the DECODED buffer before the INSERT.
    // Must come first: the pixel cap reads a header that a padded file satisfies
    // while the payload is arbitrarily large.
    if (buffer.length > RICH_IMG_MAX_BYTES) { _droppedOversizeImages++; return ""; }
    // Apply the same pixel-dimension cap as avatars to prevent embedded image
    // bombs from being persisted. Strip the <img> on rejection rather than
    // letting it pass through with the dangerous data: URI.
    const dims = _getImageDimensions(buffer, kind);
    if (dims && (dims.width * dims.height > IMAGE_MAX_PIXELS || dims.width <= 0 || dims.height <= 0)) {
      return "";
    }
    const id = uuid();
    const mimeType = `image/${srcM[2]}`;
    db.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)")
      .run(id, buffer, mimeType, new Date().toISOString());
    if (Array.isArray(outParamIds)) outParamIds.push(id);
    return match.replace(srcM[1], `/api/images/${id}`);
  });
}

// The two halves are exported apart for the challenge import (server.js): the
// first is pure CPU (parse and filter), the second WRITES (an `images` row per
// embedded data: image). The import sanitises every row before its transaction,
// in slices that give the event loop back, and stores the images inside it, for
// the rows it writes, so a rolled-back import or a skipped row stores none.
function processRichText(html, outParamIds) {
  return extractAndStoreImages(sanitiseRichText(html), outParamIds);
}

// v8.9.0 — does a rich-text field carry anything a participant would actually
// see? `processRichText` SANITISES, it does not strip: an emptied editor can
// hand back "<p></p>", "<div><br></div>" or "&nbsp;", every one a non-empty
// string that reads as a PRESENT hint everywhere the column is tested by bare
// truthiness (routes/participant.js `hint_available: !!hint`, the hint route's
// `!task.hint`). The any-answer type forbids a hint, so its writers ask this
// rather than `!hint`, and an image counts as content even with no text.
function richTextHasContent(html) {
  if (html == null) return false;
  const s = String(html);
  if (!s) return false;
  if (/<img\b/i.test(s)) return true;
  const text = s.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|\u00a0/g, " ").trim();
  return text.length > 0;
}

// Delete a /api/images/<id> avatar image once nothing names it any more (the
// sweep's manifest: another account's avatar, a challenge's rich text or version
// snapshot, a frozen team board that copied it...). Used when a profile edit
// replaces an avatar (PUT /api/me, routes/participant.js, the admin edit) and by
// the participant import path (server.js), where a frozen board that copied the
// old avatar keeps it; and by the person's deletion (lib/account-reaper.js
// deleteUserCascade, `via: "account_deleted"`), which strikes the person's
// avatars from the frozen boards first, so erasure wins there for the avatar
// (the boards keep the person's nickname and id). Anything this
// leaves is the daily orphaned-image sweep's (lib/image-sweep.js). No-op for
// built-in avatar refs (which don't match the /api/images/<uuid> shape).
function deleteAvatarImage(avatarRef, opts = {}) {
  if (!avatarRef) return;
  const m = String(avatarRef).match(/^\/api\/images\/([a-f0-9-]+)$/i);
  if (!m) return;
  const imgId = m[1];
  // One list for this and the sweep, so they cannot disagree about what a
  // reference is.
  if (require("./image-sweep").imageIsReferenced(imgId)) return;
  const r = db.prepare("DELETE FROM images WHERE id=?").run(imgId);
  // Image rows have no owning entity once unreferenced — use the orphan helper
  // so the deletion is discoverable in app.jsonl under scope:"image".
  if (r.changes) try { recordOrphanedAuditEvent("image", imgId, "purged", "system", { via: opts.via === "account_deleted" ? "account_deleted" : "avatar_replacement" }); } catch (e) { swallowed("sanitise:image-purged-emit", e); }
}

module.exports = { RICH_TABLE_TAGS, RICH_COLOURS, escapeHtml, sanitiseAvatar, VALID_AVATARS, validateAvatarDataUri, persistAvatar, sanitiseRichText, extractAndStoreImages, processRichText, richTextHasContent, deleteAvatarImage, AVATAR_MAX_BYTES, RICH_IMG_MAX_BYTES, takeDroppedImageCount, _RICH_IMG_ALLOWED_SUBTYPES, _RICH_TEXT_OPTS };
