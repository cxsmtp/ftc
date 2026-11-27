"use strict";

// A small QR Code encoder (ISO/IEC 18004), written for the certificate's
// verification mark. No dependency: the certificate needs one short URL turned
// into a module matrix, and a new npm package means a lockfile change, a CI image
// rebuild and more supply-chain surface for ~200 lines of well-specified maths.
//
// Scope, deliberately narrow:
//   * BYTE mode only (UTF-8). A verification URL is not worth the alphanumeric
//     mode's saving, and byte mode is the one every reader handles.
//   * Error-correction level M (~15% recoverable): a printed certificate gets
//     folded and photographed at an angle, so L is too thin and Q/H cost size.
//   * Versions 1-10 (up to 213 bytes at M). `encodeQr` THROWS above that rather
//     than silently truncating — a QR that encodes a different URL than the one
//     printed beside it is worse than none. The caller decides what to draw.
//
// The structure follows the reference algorithm (finder/timing/alignment
// patterns, format and version information, Reed-Solomon over GF(256) with
// polynomial 0x11D, block interleaving, the eight data masks with the standard
// penalty score). It is pure and deterministic: the same text always yields the
// same matrix, which the certificate's byte-identical render contract needs.

// Per error-correction level, indexed by version (index 0 unused).
//   M (~15%): the certificate's verification mark (the default; byte-identical
//             to the encoder's first release, which the certificate render
//             contract relies on).
//   H (~30%): the EVENT JOIN QR, which carries the event code as a label in a
//             reserved centre area (see `encodeQr`'s `centre` option).
// Format bits: L=1, M=0, Q=3, H=2.
const ECL = {
  M: { ecc: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5], format: 0 },
  H: { ecc: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28], blocks: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8], format: 2 },
};
const MAX_VERSION = 10;

function _ecl(level) {
  const e = ECL[level || "M"];
  if (!e) throw new RangeError(`unknown QR error-correction level: ${level}`);
  return e;
}

function _rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function _dataCodewords(ver, level) {
  const e = _ecl(level);
  return Math.floor(_rawDataModules(ver) / 8) - e.ecc[ver] * e.blocks[ver];
}

/** Bytes of payload a version holds in byte mode (level M unless named). */
function byteCapacity(ver, level) {
  const countBits = ver <= 9 ? 8 : 16;
  return Math.floor((_dataCodewords(ver, level) * 8 - 4 - countBits) / 8);
}

function _gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function _rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = _gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = _gfMul(root, 0x02);
  }
  return result;
}

function _rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= _gfMul(coef, factor); });
  }
  return result;
}

function _alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const _bit = (x, i) => ((x >>> i) & 1) !== 0;

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

/**
 * Data + ECC codewords, interleaved, for `bytes` at version `ver`. The array
 * also carries `blockOf[i]` (the block the i-th interleaved codeword belongs
 * to), `eccLen` and `numBlocks`, which the centre reservation needs to count
 * damage per block.
 */
function _codewords(bytes, ver, level) {
  const e = _ecl(level);
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0x4, 4);                                   // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = _dataCodewords(ver, level) * 8;
  put(0, Math.min(4, capBits - bits.length));    // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }

  const numBlocks = e.blocks[ver];
  const eccLen = e.ecc[ver];
  const raw = Math.floor(_rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = _rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = _rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  const blockOf = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= numShort) { out.push(blk[i]); blockOf.push(j); }
    });
  }
  out.blockOf = blockOf;
  out.eccLen = eccLen;
  out.numBlocks = numBlocks;
  return out;
}

function _penalty(m) {
  const n = m.length;
  let score = 0;
  // Rule 1: runs of five or more same-coloured modules, rows and columns.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass ? m[b][a] : m[a][b];
        const prev = pass ? m[b - 1][a] : m[a][b - 1];
        if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  // Rule 3: finder-like 1:1:3:1:1 runs with four light modules on one side.
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) for (let b = 0; b + 11 <= n; b++) {
      let h1 = true, h2 = true;
      for (let k = 0; k < 11; k++) {
        const v = (pass ? m[b + k][a] : m[a][b + k]) ? 1 : 0;
        if (v !== P1[k]) h1 = false;
        if (v !== P2[k]) h2 = false;
      }
      if (h1) score += 40;
      if (h2) score += 40;
    }
  }
  // Rule 4: dark/light balance.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Encode `text` (UTF-8) as a QR Code. Returns `{ version, size, modules, mask }`
 * where `modules[y][x]` is true for a dark module. Throws RangeError when the
 * text exceeds version 10's capacity.
 *
 * `opts.level` - "M" (default) or "H".
 * `opts.centre` - `{ w, h }` as FRACTIONS of the symbol's width (e.g. 0.36 x
 *   0.16): a box in the middle the caller will cover with a label. The box is
 *   RESERVED, not overlaid blindly: every data module inside it is cleared to
 *   light, the encoder counts, per Reed-Solomon block, the codewords that lose
 *   a module, and it moves up a version (more modules, more ECC) until every
 *   block's damage stays inside HALF its error-correction budget minus one
 *   spare codeword, so the symbol still decodes with room left for wear.
 *   Function patterns (finders, timing, alignment, format) inside the box keep
 *   their values; the label plate covers them visually, and a reader locates
 *   the symbol from its three finders. Returned as `centre: { x, y, w, h }` in
 *   modules, plus `damage` (worst block) and `budget`. Refuses (RangeError)
 *   rather than drawing a label the symbol cannot afford.
 */
function encodeQr(text, opts) {
  const o = opts || {};
  const level = o.level || "M";
  _ecl(level);
  const bytes = [...Buffer.from(String(text == null ? "" : text), "utf8")];
  let ver = 1;
  while (ver <= MAX_VERSION && byteCapacity(ver, level) < bytes.length) ver++;
  if (ver > MAX_VERSION) throw new RangeError(`QR payload too long (${bytes.length} bytes; max ${byteCapacity(MAX_VERSION, level)})`);
  // `opts.version` raises the floor (never lowers it below what the text needs).
  if (Number.isInteger(o.version) && o.version > ver && o.version <= MAX_VERSION) ver = o.version;
  if (!o.centre) return _encodeAt(bytes, ver, level, null);
  for (let v = ver; v <= MAX_VERSION; v++) {
    const q = _encodeAt(bytes, v, level, o.centre);
    if (q.damage <= q.budget) return q;
  }
  throw new RangeError("QR centre label does not fit inside the error-correction budget");
}

function _centreBox(size, centre) {
  // Whole modules, centred, odd-sized so the box is symmetric about the middle,
  // and never reaching the finder patterns' rows and columns.
  const odd = (n) => (n % 2 ? n : n + 1);
  const cap = size - 18;
  const w = Math.min(cap, odd(Math.max(3, Math.round(size * Number(centre.w || 0)))));
  const h = Math.min(cap, odd(Math.max(3, Math.round(size * Number(centre.h || 0)))));
  return { x: (size - w) / 2, y: (size - h) / 2, w, h };
}

function _encodeAt(bytes, ver, level, centre) {
  const ecl = _ecl(level);
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = _alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));

  const drawFormat = (mask) => {
    const data = (ecl.format << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, _bit(bits, i));
    setFn(8, 7, _bit(bits, 6));
    setFn(8, 8, _bit(bits, 7));
    setFn(7, 8, _bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, _bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, _bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, _bit(bits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserve the area
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = _bit(bits, i);
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setFn(a, c, b); setFn(c, a, b);
    }
  }

  const cw = _codewords(bytes, ver, level);
  const box = centre ? _centreBox(size, centre) : null;
  const inBox = (x, y) => !!box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
  const hit = new Set();      // interleaved codeword indices that lose a module
  const cleared = [];         // data-area modules inside the box
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x]) {
          if (i < cw.length * 8) {
            modules[y][x] = _bit(cw[i >>> 3], 7 - (i & 7));
            if (inBox(x, y)) hit.add(i >>> 3);
            i++;
          }
          if (inBox(x, y)) cleared.push([x, y]);
        }
      }
    }
  }

  const applyMask = (mask) => {
    const f = MASKS[mask];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!isFn[y][x] && f(x, y)) modules[y][x] = !modules[y][x];
    }
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask); drawFormat(mask);
    const s = _penalty(modules);
    if (s < bestScore) { bestScore = s; best = mask; }
    applyMask(mask); // XOR undoes it
  }
  applyMask(best); drawFormat(best);
  if (!box) return { version: ver, size, modules, mask: best };
  // The reservation: data modules under the label are light (the plate is
  // light too, so what a reader samples there is what this wrote).
  for (const [x, y] of cleared) modules[y][x] = false;
  const perBlock = new Array(cw.numBlocks).fill(0);
  for (const k of hit) perBlock[cw.blockOf[k]]++;
  const damage = Math.max(0, ...perBlock);
  const budget = Math.floor(cw.eccLen / 2) - 1;
  return { version: ver, size, modules, mask: best, level, centre: box, damage, budget };
}

/**
 * A complete, self-contained SVG of a QR symbol: light plate, a quiet zone of
 * four modules, the dark modules as one path and - when the symbol was encoded
 * with a `centre` box - a light label plate there carrying `label` (the event
 * code). `px` is the width in user units; the SVG scales.
 */
function qrSvg(qr, { label = "", px = 512, dark = "#0b0d12", light = "#ffffff", title = "" } = {}) {
  const quiet = 4;
  const n = qr.size + quiet * 2;
  const m = px / n;
  const f = (v) => Number(v.toFixed(3));
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(px)} ${f(px)}" width="${f(px)}" height="${f(px)}" shape-rendering="crispEdges">`;
  if (title) out += `<title>${esc(title)}</title>`;
  out += `<rect width="${f(px)}" height="${f(px)}" fill="${light}"/>`;
  out += `<path fill="${dark}" d="${qrSvgPath(qr, quiet * m, quiet * m, qr.size * m)}"/>`;
  if (qr.centre) {
    const b = qr.centre;
    const x = (b.x + quiet) * m, y = (b.y + quiet) * m, w = b.w * m, h = b.h * m;
    out += `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${light}"/>`;
    // A hairline frame inside the plate marks the label off for the eye.
    out += `<rect x="${f(x + m * 0.5)}" y="${f(y + m * 0.5)}" width="${f(w - m)}" height="${f(h - m)}" rx="${f(m * 0.6)}" fill="none" stroke="${dark}" stroke-width="${f(m * 0.35)}"/>`;
    const t = String(label || "").slice(0, 16);
    if (t) {
      // Fit the text to the plate: a monospaced glyph advances ~0.6 em.
      const fs = Math.min(h * 0.56, (w - m * 2.2) / (Math.max(1, t.length) * 0.62));
      out += `<text x="${f(x + w / 2)}" y="${f(y + h / 2)}" text-anchor="middle" dominant-baseline="central" font-family="'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace" font-weight="700" font-size="${f(fs)}" fill="${dark}">${esc(t)}</text>`;
    }
  }
  return out + "</svg>";
}

/**
 * One SVG path covering every dark module, placed at (x, y) and `px` wide in
 * total (quiet zone NOT included — the caller draws the light backing plate so
 * it can choose the colours). Horizontal runs are merged to keep the path short.
 */
function qrSvgPath(qr, x, y, px) {
  const m = px / qr.size;
  const f = (v) => Number(v.toFixed(3));
  let d = "";
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      let run = 1;
      while (c + run < qr.size && qr.modules[r][c + run]) run++;
      d += `M${f(x + c * m)} ${f(y + r * m)}h${f(run * m)}v${f(m)}h${f(-run * m)}z`;
      c += run - 1;
    }
  }
  return d;
}

module.exports = { encodeQr, qrSvgPath, qrSvg, byteCapacity, _gfMul, _rsRemainder, _rsDivisor, MAX_VERSION };
