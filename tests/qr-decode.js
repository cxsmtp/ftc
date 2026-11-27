"use strict";

// AN INDEPENDENT QR CODE READER, FOR THE SUITE.
//
// lib/qr.js draws the two symbols people scan: the certificate's verification
// mark (level M) and the event join QR (level H, the event code over a reserved
// centre). Checks phrased in the encoder's own numbers (its block table, its
// budget, its remainder function) stay green when the encoder is wrong in the
// same way twice, so this reads a symbol BACK, through the steps the standard's
// decoding takes (not a camera's: finding a symbol in a photograph, at an angle
// and under glare, is only approximated by `matrixFromPixels`, axis-aligned):
//
//   * the module matrix, from a raster (`matrixFromPixels`: the symbol located by
//     the bounding box of its dark pixels and its size by the timing pattern) or
//     from the run path lib/qr.js draws (`matrixFromSvgPath`), or a boolean
//     matrix as given;
//   * the FUNCTION PATTERNS a reader finds and samples a symbol by
//     (`checkFunctionPatterns`): every module of the three finders with their
//     light separators, both timing lines, every alignment pattern that does not
//     overlap a finder and the always-dark module, compared with the pattern the
//     standard draws; one module wrong is refused. A label box the caller names
//     (the join QR's centre plate) exempts exactly the modules under it, and may
//     not reach the finders, separators, timing lines or format information;
//   * the format information: both copies, the nearest of the 32 valid words by
//     Hamming distance (at most 3 corrected), and the distance reported, so a
//     clean symbol can be required to carry an exact codeword;
//   * the version information from version 7 up: both copies against the word
//     for the version the size implies, at most 3 bits off, the distance reported;
//   * unmasked, the data modules walked in the standard's placement order, the
//     Reed-Solomon blocks de-interleaved and each one CORRECTED (Berlekamp-Massey,
//     Chien search, Forney): the join QR clears data modules under its label on
//     purpose, so a reader that only checked syndromes would refuse every one;
//   * byte mode decoded, the terminator and pad codewords checked.
//
// INDEPENDENT ON PURPOSE. Every table is transcribed from ISO/IEC 18004:2015
// (Table 7 for the data codewords, Table 9 for the block structure and
// correction capacity, Annex E for the alignment centres, Annex C for the format
// words, Annex D for the version words, Table 10 for the masks), never computed
// from or copied out of lib/qr.js, and the arithmetic is log/antilog GF(256)
// rather than the encoder's bitwise multiply. tests/qr-decode.spec.js checks each
// transcription against something it was not copied from, as far as one exists:
// the format and version words against the standard's BCH arithmetic, the total
// codewords and remainder bits against the data region the geometry leaves, and
// the blocks against those totals, Table 7 and one ECC length per level (so a
// mistyped c or k shows, at every level). The alignment centres and the masks
// are checked by decoding the encoder's own symbols (every version 1-10, all
// eight masks, level M). The misdecode values p are held only to a sane range
// (a positive integer capacity of at most half the block's ECC): a typo in p
// that stays in that range, or one adding a p the standard does not have, would pass.
//
// Scope: versions 1-10 (the encoder's range), all four levels, byte mode only
// (the only mode the encoder writes; any other mode indicator is refused by
// name). Throws QrDecodeError, whose `code` says which stage refused:
// size | function | format | version | layout | rs | mode | length | utf8 | locate | path.

class QrDecodeError extends Error {
  constructor(code, message) { super(message); this.name = "QrDecodeError"; this.code = code; }
}

// ── GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1, generator 2 ───────
const EXP = new Array(512);
const LOG = new Array(256).fill(-1);
(function buildField() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const gdiv = (a, b) => {
  if (b === 0) throw new QrDecodeError("rs", "division by zero in GF(256)");
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const gpow = (a, k) => (k === 0 ? 1 : a === 0 ? 0 : EXP[(LOG[a] * k) % 255]);
const alphaPow = (p) => EXP[((p % 255) + 255) % 255];

// ── ISO/IEC 18004:2015 tables, versions 1-10 ─────────────────────────────────
// Table 9: per version and level, the block groups [count, c, k] (c codewords
// per block, k of them data). Blocks of the first group come first.
const BLOCKS = {
  1: { L: [[1, 26, 19]], M: [[1, 26, 16]], Q: [[1, 26, 13]], H: [[1, 26, 9]] },
  2: { L: [[1, 44, 34]], M: [[1, 44, 28]], Q: [[1, 44, 22]], H: [[1, 44, 16]] },
  3: { L: [[1, 70, 55]], M: [[1, 70, 44]], Q: [[2, 35, 17]], H: [[2, 35, 13]] },
  4: { L: [[1, 100, 80]], M: [[2, 50, 32]], Q: [[2, 50, 24]], H: [[4, 25, 9]] },
  5: { L: [[1, 134, 108]], M: [[2, 67, 43]], Q: [[2, 33, 15], [2, 34, 16]], H: [[2, 33, 11], [2, 34, 12]] },
  6: { L: [[2, 86, 68]], M: [[4, 43, 27]], Q: [[4, 43, 19]], H: [[4, 43, 15]] },
  7: { L: [[2, 98, 78]], M: [[4, 49, 31]], Q: [[2, 32, 14], [4, 33, 15]], H: [[4, 39, 13], [1, 40, 14]] },
  8: { L: [[2, 121, 97]], M: [[2, 60, 38], [2, 61, 39]], Q: [[4, 40, 18], [2, 41, 19]], H: [[4, 40, 14], [2, 41, 15]] },
  9: { L: [[2, 146, 116]], M: [[3, 58, 36], [2, 59, 37]], Q: [[4, 36, 16], [4, 37, 17]], H: [[4, 36, 12], [4, 37, 13]] },
  10: { L: [[2, 86, 68], [2, 87, 69]], M: [[4, 69, 43], [1, 70, 44]], Q: [[6, 43, 19], [2, 44, 20]], H: [[6, 43, 15], [2, 44, 16]] },
};
// Table 9's misdecode-protection codewords p: where the standard keeps some
// error-correction codewords back, a block corrects (c - k - p) / 2 errors, not
// (c - k) / 2. Every other version 1-10 entry has p = 0.
const MISDECODE = { "1L": 3, "1M": 2, "1Q": 1, "1H": 1, "2L": 2, "3L": 1 };
// Table 9 again: total codewords per version (the data region's capacity).
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
// Table 7: data codewords per version and level, transcribed apart from Table 9
// so the one checks the other (the k of every block of a level sums to this).
const DATA_CODEWORDS = {
  1: { L: 19, M: 16, Q: 13, H: 9 }, 2: { L: 34, M: 28, Q: 22, H: 16 },
  3: { L: 55, M: 44, Q: 34, H: 26 }, 4: { L: 80, M: 64, Q: 48, H: 36 },
  5: { L: 108, M: 86, Q: 62, H: 46 }, 6: { L: 136, M: 108, Q: 76, H: 60 },
  7: { L: 156, M: 124, Q: 88, H: 66 }, 8: { L: 194, M: 154, Q: 110, H: 86 },
  9: { L: 232, M: 182, Q: 132, H: 100 }, 10: { L: 274, M: 216, Q: 154, H: 122 },
};
// Remainder bits after the last codeword (Table 1).
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
// Annex E, Table E.1: row/column coordinates of the alignment pattern centres.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
// Annex C, Table C.1: the 15-bit format information AFTER masking, most
// significant bit first, indexed [level][mask].
const FORMAT_WORDS = {
  L: ["111011111000100", "111001011110011", "111110110101010", "111100010011101",
    "110011000101111", "110001100011000", "110110001000001", "110100101110110"],
  M: ["101010000010010", "101000100100101", "101111001111100", "101101101001011",
    "100010111111001", "100000011001110", "100111110010111", "100101010100000"],
  Q: ["011010101011111", "011000001101000", "011111100110001", "011101000000110",
    "010010010110100", "010000110000011", "010111011011010", "010101111101101"],
  H: ["001011010001001", "001001110111110", "001110011100111", "001100111010000",
    "000011101100010", "000001001010101", "000110100001100", "000100000111011"],
};
// Annex D, Table D.1: the 18-bit version information, most significant bit first.
const VERSION_WORDS = {
  7: "000111110010010100", 8: "001000010110111100", 9: "001001101010011001", 10: "001010010011010011",
};
// Table 10: data mask conditions; i is the ROW, j the COLUMN.
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

const sizeOf = (version) => 17 + 4 * version;
const popcount = (x) => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };

/** The blocks of (version, level): `{ c, k, ecc, capacity }` in block order. */
function blockLayout(version, level) {
  const groups = BLOCKS[version] && BLOCKS[version][level];
  if (!groups) throw new QrDecodeError("layout", `no block table for version ${version} level ${level}`);
  const p = MISDECODE[`${version}${level}`] || 0;
  const out = [];
  for (const [count, c, k] of groups) {
    for (let i = 0; i < count; i++) out.push({ c, k, ecc: c - k, capacity: (c - k - p) / 2 });
  }
  return out;
}

/**
 * Whether (x, y) lies in a corner block a finder owns: the finder, its separator
 * and the format information beside it. An alignment centre there is not drawn.
 */
const onFinderCorner = (x, y, n) => (x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8);

/** True where a module belongs to a function pattern (never carries data). */
function functionModules(version) {
  const n = sizeOf(version);
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const fill = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fn[y][x] = true; };
  // Each finder with its separator and the format information beside it; the
  // bottom-left block also holds the always-dark module at (8, n - 8).
  fill(0, 0, 9, 9);
  fill(n - 8, 0, 8, 9);
  fill(0, n - 8, 9, 8);
  // Alignment patterns at every pair of centres, except where a finder sits.
  // Decided by the corners alone: from version 7 a pattern centres ON a timing
  // line, so testing "already a function module" would drop it.
  for (const cy of ALIGN[version]) for (const cx of ALIGN[version]) {
    if (!onFinderCorner(cx, cy, n)) fill(cx - 2, cy - 2, 5, 5);
  }
  for (let i = 0; i < n; i++) { fn[6][i] = true; fn[i][6] = true; }
  if (version >= 7) { fill(n - 11, 0, 3, 6); fill(0, n - 11, 6, 3); }
  return fn;
}

/**
 * Every module of the function patterns as the standard draws them (section
 * 6.3), `[{ x, y, dark, what }]`, each module once: the three finders (7x7: a
 * dark ring, a light ring, a dark 3x3 core), each with its one-module light
 * separator on the two sides facing the symbol; the timing patterns along row 6
 * and column 6 between the separators, dark on even coordinates; a 5x5 alignment
 * pattern (dark ring, light ring, dark centre) at every pair of Annex E centres
 * that does not overlap a finder; and the always-dark module at (8, n - 8).
 * Where two patterns share a module (from version 7 an alignment pattern sits on
 * a timing line) they must agree, or this table is wrong and says so.
 */
function functionPatternModules(version) {
  const n = sizeOf(version);
  const want = new Map();
  const put = (x, y, dark, what) => {
    const key = y * n + x;
    const had = want.get(key);
    if (had && had.dark !== dark) throw new Error(`the function-pattern table disagrees with itself at ${x},${y}: ${had.what} and ${what}`);
    if (!had) want.set(key, { x, y, dark, what });
  };
  for (const [fx, fy, name] of [[0, 0, "top-left"], [n - 7, 0, "top-right"], [0, n - 7, "bottom-left"]]) {
    for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
      put(fx + dx, fy + dy, Math.max(Math.abs(dx - 3), Math.abs(dy - 3)) !== 2, `${name} finder`);
    }
  }
  for (let i = 0; i < 8; i++) {
    put(i, 7, false, "top-left separator"); put(7, i, false, "top-left separator");
    put(n - 8 + i, 7, false, "top-right separator"); put(n - 8, i, false, "top-right separator");
    put(i, n - 8, false, "bottom-left separator"); put(7, n - 8 + i, false, "bottom-left separator");
  }
  for (let i = 8; i <= n - 9; i++) {
    put(i, 6, i % 2 === 0, "timing row");
    put(6, i, i % 2 === 0, "timing column");
  }
  for (const cy of ALIGN[version]) for (const cx of ALIGN[version]) {
    if (onFinderCorner(cx, cy, n)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, `alignment pattern at ${cx},${cy}`);
    }
  }
  put(8, n - 8, true, "dark module");
  return [...want.values()];
}

/**
 * Compare every function-pattern module of `m` with the standard's pattern and
 * refuse the symbol (QrDecodeError "function") at the first one that differs,
 * naming it: a reader finds a symbol by its finders and separators and samples
 * it by its timing and alignment patterns, so a symbol drawing one of them wrong
 * is not one a reader can rely on, whatever its data says. `labelBox`
 * (`{ x, y, w, h }` in whole modules), when given, exempts exactly the modules
 * inside it: a label plate over the centre (the join QR's) covers whatever lies
 * there, and Reed-Solomon corrects the data it hides. The box must keep clear of
 * the nine-module band on every side (finders, separators, timing lines, format
 * information), so it cannot hide what locates the symbol. Returns
 * `{ checked, exempt }`: the modules compared and the modules the box exempted.
 */
function checkFunctionPatterns(m, version, labelBox) {
  const n = sizeOf(version);
  let inBox = () => false;
  if (labelBox !== undefined && labelBox !== null) {
    const { x, y, w, h } = labelBox;
    if (![x, y, w, h].every(Number.isInteger) || w < 1 || h < 1) {
      throw new QrDecodeError("function", `a label box is whole modules, not ${JSON.stringify(labelBox)}`);
    }
    if (x < 9 || y < 9 || x + w > n - 9 || y + h > n - 9) {
      throw new QrDecodeError("function", `label box ${x},${y} ${w}x${h} reaches the finders, separators, timing lines or format information of a ${n}-module symbol`);
    }
    inBox = (mx, my) => mx >= x && mx < x + w && my >= y && my < y + h;
  }
  let checked = 0, exempt = 0;
  for (const { x, y, dark, what } of functionPatternModules(version)) {
    if (inBox(x, y)) { exempt++; continue; }
    if (Boolean(m[y][x]) !== dark) {
      throw new QrDecodeError("function", `${what}: module ${x},${y} is ${dark ? "light" : "dark"} where the standard draws it ${dark ? "dark" : "light"}`);
    }
    checked++;
  }
  return { checked, exempt };
}

/**
 * The data modules `[x, y]` in the standard's placement order: two-module
 * columns from the right edge, alternately upward and downward, the right module
 * of each pair first, the vertical timing column skipped. Codeword k's bits
 * (most significant first) are entries 8k .. 8k + 7.
 */
function dataModuleOrder(version) {
  const n = sizeOf(version);
  const fn = functionModules(version);
  const out = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      if (!fn[y][right]) out.push([right, y]);
      if (!fn[y][right - 1]) out.push([right - 1, y]);
    }
    upward = !upward;
  }
  return out;
}

/** Interleaved codeword index → `{ block, index }` (index within that block, data then ECC). */
function interleaveMap(version, level) {
  const blocks = blockLayout(version, level);
  const map = [];
  const maxK = Math.max(...blocks.map(b => b.k));
  for (let i = 0; i < maxK; i++) blocks.forEach((b, bi) => { if (i < b.k) map.push({ block: bi, index: i }); });
  const e = blocks[0].ecc;
  for (let i = 0; i < e; i++) blocks.forEach((b, bi) => map.push({ block: bi, index: b.k + i }));
  return map;
}

function bitsToInt(bits) { let v = 0; for (const b of bits) v = (v << 1) | (b ? 1 : 0); return v >>> 0; }

function readFormat(m) {
  const n = m.length;
  const bit = ([x, y]) => (m[y][x] ? 1 : 0);
  // Both copies, most significant bit first.
  const copy1 = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  const copy2 = [[8, n - 1], [8, n - 2], [8, n - 3], [8, n - 4], [8, n - 5], [8, n - 6], [8, n - 7],
    [n - 8, 8], [n - 7, 8], [n - 6, 8], [n - 5, 8], [n - 4, 8], [n - 3, 8], [n - 2, 8], [n - 1, 8]];
  const read = [bitsToInt(copy1.map(bit)), bitsToInt(copy2.map(bit))];
  let best = null;
  for (const level of ["L", "M", "Q", "H"]) {
    FORMAT_WORDS[level].forEach((w, mask) => {
      const word = parseInt(w, 2);
      const d = read.map(r => popcount(r ^ word));
      const dist = Math.min(d[0], d[1]);
      if (!best || dist < best.distance) best = { level, mask, distance: dist, copies: d };
    });
  }
  if (best.distance > 3) throw new QrDecodeError("format", `format information unreadable (nearest valid word is ${best.distance} bits away)`);
  return best;
}

function readVersionInfo(m, version) {
  const n = m.length;
  const bitsA = [], bitsB = [];
  // Bit b (17 the most significant) sits at column n-11+(b mod 3), row b div 3
  // in the block left of the top-right finder, and transposed in the block
  // above the bottom-left finder.
  for (let b = 17; b >= 0; b--) {
    bitsA.push(m[Math.floor(b / 3)][n - 11 + (b % 3)] ? 1 : 0);
    bitsB.push(m[n - 11 + (b % 3)][Math.floor(b / 3)] ? 1 : 0);
  }
  const want = parseInt(VERSION_WORDS[version], 2);
  const d = [popcount(bitsToInt(bitsA) ^ want), popcount(bitsToInt(bitsB) ^ want)];
  const distance = Math.min(d[0], d[1]);
  if (distance > 3) throw new QrDecodeError("version", `version information does not say version ${version} (${distance} bits away)`);
  return { distance, copies: d };
}

/** Syndromes S_0 .. S_{nsym-1}: the received block evaluated at alpha^0 .. alpha^(nsym-1). */
function syndromes(word, nsym) {
  const S = new Array(nsym);
  for (let j = 0; j < nsym; j++) {
    const a = EXP[j];
    let s = 0;
    for (const c of word) s = gmul(s, a) ^ c;
    S[j] = s;
  }
  return S;
}

/**
 * Correct one Reed-Solomon block (`word` = data then ECC, first byte the highest
 * power; generator roots alpha^0 .. alpha^(nsym-1), as the standard's Annex A
 * defines). Corrects at most `capacity` errors and throws QrDecodeError("rs")
 * beyond that, or when the corrected word still fails its syndromes.
 */
function rsCorrect(word, nsym, capacity) {
  const n = word.length;
  const S = syndromes(word, nsym);
  if (S.every(s => s === 0)) return { word: word.slice(), errors: 0, positions: [] };
  // Berlekamp-Massey: the shortest LFSR generating the syndromes is the error
  // locator Lambda(x) = 1 + L1 x + ... (coefficients lowest power first).
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let r = 0; r < nsym; r++) {
    let d = S[r];
    for (let i = 1; i <= L; i++) d ^= gmul(C[i] || 0, S[r - i]);
    if (d === 0) { m++; continue; }
    const T = C.slice();
    const coef = gdiv(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
    if (2 * L <= r) { L = r + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (C.length - 1 !== L || L > capacity) {
    throw new QrDecodeError("rs", `block holds more errors than it can correct (locator degree ${C.length - 1}, capacity ${capacity})`);
  }
  // Chien search: byte i sits at power n-1-i, and it is in error when
  // Lambda(alpha^-(n-1-i)) = 0.
  const evalAt = (poly, x) => { let v = 0; for (let k = poly.length - 1; k >= 0; k--) v = gmul(v, x) ^ poly[k]; return v; };
  const positions = [];
  for (let i = 0; i < n; i++) if (evalAt(C, alphaPow(-(n - 1 - i))) === 0) positions.push(i);
  if (positions.length !== L) {
    throw new QrDecodeError("rs", `block holds more errors than it can correct (${positions.length} of ${L} locator roots in range)`);
  }
  // Forney, first root alpha^0: e = X * Omega(X^-1) / Lambda'(X^-1), where
  // Omega = S(x) Lambda(x) mod x^nsym and characteristic 2 drops the sign.
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let k = 0; k <= i && k < C.length; k++) omega[i] ^= gmul(S[i - k], C[k]);
  const out = word.slice();
  for (const i of positions) {
    const p = n - 1 - i;
    const X = alphaPow(p), Xinv = alphaPow(-p);
    let deriv = 0;
    for (let k = 1; k < C.length; k += 2) deriv ^= gmul(C[k], gpow(Xinv, k - 1));
    if (deriv === 0) throw new QrDecodeError("rs", "error locator has a repeated root");
    out[i] ^= gmul(X, gdiv(evalAt(omega, Xinv), deriv));
  }
  if (syndromes(out, nsym).some(s => s !== 0)) throw new QrDecodeError("rs", "corrected block still fails its syndromes");
  return { word: out, errors: L, positions };
}

/** Systematic Reed-Solomon encoding with this module's own field: the ECC bytes for `data`. */
function rsEncode(data, nsym) {
  // g(x) = (x - alpha^0)(x - alpha^1)...(x - alpha^(nsym-1)), highest power first.
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let k = 0; k < g.length; k++) { next[k] ^= g[k]; next[k + 1] ^= gmul(g[k], EXP[i]); }
    g = next;
  }
  const rem = new Array(nsym).fill(0);
  for (const byte of data) {
    const f = byte ^ rem[0];
    rem.shift(); rem.push(0);
    for (let k = 0; k < nsym; k++) rem[k] ^= gmul(g[k + 1], f);
  }
  return rem;
}

function parseByteMode(data, version) {
  const bits = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  let p = 0;
  const take = (len) => { let v = 0; for (let i = 0; i < len; i++) v = (v << 1) | bits[p++]; return v; };
  const bytes = [];
  const segments = [];
  for (;;) {
    if (bits.length - p < 4) { p = bits.length; break; }          // the terminator may be cut short
    const mode = take(4);
    if (mode === 0) break;                                          // terminator 0000
    if (mode !== 0b0100) throw new QrDecodeError("mode", `mode indicator ${mode.toString(2).padStart(4, "0")} is not byte mode`);
    const countBits = version <= 9 ? 8 : 16;
    if (bits.length - p < countBits) throw new QrDecodeError("length", "character count runs past the data");
    const count = take(countBits);
    if (bits.length - p < 8 * count) throw new QrDecodeError("length", `byte segment of ${count} bytes runs past the data`);
    for (let i = 0; i < count; i++) bytes.push(take(8));
    segments.push(count);
  }
  // After the terminator: zero bits to the byte boundary, then the pad codewords
  // 11101100 and 00010001 alternately (section 7.4.10).
  let padOk = true;
  while (p % 8 !== 0) { if (bits[p++] !== 0) padOk = false; }
  for (let pad = 0xec; p + 8 <= bits.length; pad ^= 0xec ^ 0x11) { if (take(8) !== pad) padOk = false; }
  return { bytes: Buffer.from(bytes), segments, padOk };
}

/**
 * Everything before error correction: the function patterns checked
 * (`checkFunctionPatterns`, `opts.labelBox` its only exemption), the format and
 * version information, then the unmasked codewords walked out of the data region
 * and de-interleaved into their Reed-Solomon blocks, AS READ (`blocks[i].word` =
 * data then ECC). Throws QrDecodeError.
 */
function readBlocks(m, opts = {}) {
  if (!Array.isArray(m) || !m.length || !m.every(r => Array.isArray(r) && r.length === m.length)) {
    throw new QrDecodeError("size", "not a square module matrix");
  }
  const n = m.length;
  const version = (n - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new QrDecodeError("size", `${n} modules is not a version 1-${MAX_VERSION} symbol`);
  }
  const functionPatterns = checkFunctionPatterns(m, version, opts.labelBox);
  const format = readFormat(m);
  const versionInfo = version >= 7 ? readVersionInfo(m, version) : null;
  const order = dataModuleOrder(version);
  const total = TOTAL_CODEWORDS[version];
  if (order.length !== 8 * total + REMAINDER_BITS[version]) {
    throw new QrDecodeError("layout", `version ${version} has ${order.length} data modules, the standard ${8 * total + REMAINDER_BITS[version]}`);
  }
  const mask = MASKS[format.mask];
  const bits = order.map(([x, y]) => (m[y][x] ? 1 : 0) ^ (mask(y, x) ? 1 : 0));
  const codewords = [];
  for (let k = 0; k < total; k++) codewords.push(bitsToInt(bits.slice(8 * k, 8 * k + 8)));
  const remainderOk = bits.slice(8 * total).every(b => b === 0);
  const layout = blockLayout(version, format.level);
  if (layout.reduce((s, b) => s + b.c, 0) !== total) throw new QrDecodeError("layout", "block table does not fill the symbol");
  const words = layout.map(() => []);
  interleaveMap(version, format.level).forEach(({ block }, i) => words[block].push(codewords[i]));
  return {
    version, level: format.level, mask: format.mask, versionInfo, remainderOk, functionPatterns,
    format: { distance: format.distance, copies: format.copies },
    blocks: layout.map((b, i) => ({ ...b, word: words[i] })),
  };
}

/**
 * Decode a module matrix (`m[y][x]`, true = dark). Returns
 * `{ text, bytes, version, level, mask, format, versionInfo, functionPatterns, blocks, errors, padOk, remainderOk, segments }`,
 * where `functionPatterns` is `{ checked, exempt }` and `blocks[i]` is
 * `{ c, k, ecc, capacity, errors, positions }`. `opts.labelBox` names a label
 * plate over the symbol (see `checkFunctionPatterns`). Throws QrDecodeError.
 */
function decodeQr(m, opts = {}) {
  const { version, level, mask, versionInfo, remainderOk, functionPatterns, format, blocks: raw } = readBlocks(m, opts);
  const blocks = raw.map(({ word, ...b }) => {
    const fixed = rsCorrect(word, b.ecc, b.capacity);
    return { ...b, errors: fixed.errors, positions: fixed.positions, data: fixed.word.slice(0, b.k) };
  });
  const data = [].concat(...blocks.map(b => b.data));
  const parsed = parseByteMode(data, version);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(parsed.bytes); }
  catch (_) { throw new QrDecodeError("utf8", "byte segment is not UTF-8"); }
  return {
    text, bytes: parsed.bytes, segments: parsed.segments, version, level, mask, format, versionInfo, functionPatterns,
    blocks: blocks.map(({ data: _d, ...rest }) => rest),
    errors: blocks.reduce((s, b) => s + b.errors, 0), padOk: parsed.padOk, remainderOk,
  };
}

/**
 * The module matrix a run path draws: `qrSvgPath`'s `M x y h w v m h -w z`
 * rectangles, one module tall. The grid is taken from the path itself (the
 * module from the rectangle height, the origin from the top-left finder), and a
 * rectangle off that grid is refused: a reader samples the grid, not the path.
 * Returns `{ modules, size, x, y, modulePx }` (the symbol's box in path units).
 */
function matrixFromSvgPath(d) {
  const re = /M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)z/g;
  const rects = [];
  let consumed = 0;
  for (const mm of String(d).matchAll(re)) {
    const [x, y, w, h, back] = mm.slice(1).map(Number);
    if (!(w > 0) || !(h > 0) || Math.abs(back + w) > 1e-6) throw new QrDecodeError("path", `not a closed run: ${mm[0]}`);
    rects.push({ x, y, w, h });
    consumed += mm[0].length;
  }
  if (!rects.length || consumed !== String(d).length) throw new QrDecodeError("path", "path holds something other than module runs");
  const mod = rects[0].h;
  if (rects.some(r => Math.abs(r.h - mod) > 1e-3)) throw new QrDecodeError("path", "runs of different heights");
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const n = Math.round((Math.max(...rects.map(r => r.x + r.w)) - x0) / mod);
  const tol = mod * 0.01;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  for (const r of rects) {
    const col = Math.round((r.x - x0) / mod), row = Math.round((r.y - y0) / mod), run = Math.round(r.w / mod);
    if (Math.abs(x0 + col * mod - r.x) > tol || Math.abs(y0 + row * mod - r.y) > tol || Math.abs(run * mod - r.w) > tol) {
      throw new QrDecodeError("path", `run at ${r.x},${r.y} is off the module grid`);
    }
    if (row >= n || col + run > n) throw new QrDecodeError("path", "run outside the symbol");
    for (let c = col; c < col + run; c++) {
      if (m[row][c]) throw new QrDecodeError("path", `module ${c},${row} drawn twice`);
      m[row][c] = true;
    }
  }
  return { modules: m, size: n, x: x0, y: y0, modulePx: mod };
}

function _luminance(img) {
  const { width, height, pixels } = img;
  const lum = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = pixels[4 * i + 3] / 255;
    const over = (c) => c * a + 255 * (1 - a);   // over a white page
    lum[i] = 0.2126 * over(pixels[4 * i]) + 0.7152 * over(pixels[4 * i + 1]) + 0.0722 * over(pixels[4 * i + 2]);
  }
  return lum;
}

/**
 * Sample the module grid of a symbol in a raster (`{ width, height, pixels }`,
 * RGBA rows top-down, as @resvg/resvg-js renders). Axis-aligned, as a printed or
 * on-screen QR is: the symbol is the bounding box of the dark pixels (the
 * finders own three corners), the module size first estimated from the
 * top-left finder (seven modules wide), and the size settled by the TIMING
 * PATTERNS, which alternate dark and light along row 6 and column 6 of a symbol
 * of the right size only. Each module is read at its centre pixel. Returns
 * `{ modules, size, modulePx, box: {x, y, w, h}, quietModules }`.
 */
function matrixFromPixels(img, opts = {}) {
  const { width, height } = img;
  const lum = _luminance(img);
  let lo = 255, hi = 0;
  for (const v of lum) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const thr = opts.threshold === undefined ? (lo + hi) / 2 : opts.threshold;
  const dark = (x, y) => lum[y * width + x] < thr;
  let top = -1, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!dark(x, y)) continue;
      if (top < 0) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top < 0 || hi - lo < 64) throw new QrDecodeError("locate", "no dark symbol on a light ground");
  const w = right - left + 1, h = bottom - top + 1;
  let run = 0;
  while (left + run < width && dark(left + run, top)) run++;
  const est = run / 7;
  const sample = (n, x, y) => dark(Math.min(width - 1, Math.floor(left + (x + 0.5) * (w / n))), Math.min(height - 1, Math.floor(top + (y + 0.5) * (h / n))));
  let best = null;
  for (let v = 1; v <= 40; v++) {
    const n = sizeOf(v);
    if (w / n < 1) break;
    let ok = 0, all = 0;
    for (let i = 8; i <= n - 9; i++) {
      all += 2;
      if (sample(n, i, 6) === (i % 2 === 0)) ok++;
      if (sample(n, 6, i) === (i % 2 === 0)) ok++;
    }
    const score = { v, n, exact: ok === all, closeness: Math.abs(w / n - est) };
    if (score.exact && (!best || score.closeness < best.closeness)) best = score;
  }
  if (!best) throw new QrDecodeError("locate", "no symbol size has a clean timing pattern");
  const n = best.n;
  const modules = Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => sample(n, x, y)));
  const mpx = w / n;
  const quietModules = Math.min(left, top, width - 1 - right, height - 1 - bottom) / mpx;
  return { modules, size: n, modulePx: mpx, box: { x: left, y: top, w, h }, quietModules };
}

/**
 * Sample a symbol whose place in a raster is already known (`box` in pixels,
 * `size` modules) — a QR printed inside a larger artwork. The threshold is the
 * midpoint of the box's own luminance range, so the polarity is what a reader
 * assumes: darker is a dark module.
 */
function matrixFromRegion(img, box, size) {
  const { width } = img;
  const lum = _luminance(img);
  let lo = 255, hi = 0;
  for (let y = Math.floor(box.y); y < Math.ceil(box.y + box.h); y++) {
    for (let x = Math.floor(box.x); x < Math.ceil(box.x + box.w); x++) {
      const v = lum[y * width + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const thr = (lo + hi) / 2;
  const m = box.w / size;
  const modules = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
    lum[Math.floor(box.y + (y + 0.5) * m) * width + Math.floor(box.x + (x + 0.5) * m)] < thr));
  return { modules, contrast: hi - lo };
}

module.exports = {
  QrDecodeError,
  decodeQr,
  readBlocks,
  rsCorrect,
  rsEncode,
  syndromes,
  matrixFromSvgPath,
  matrixFromPixels,
  matrixFromRegion,
  functionModules,
  functionPatternModules,
  checkFunctionPatterns,
  dataModuleOrder,
  interleaveMap,
  blockLayout,
  FORMAT_WORDS,
  VERSION_WORDS,
  LEVEL_BITS,
  TOTAL_CODEWORDS,
  DATA_CODEWORDS,
  REMAINDER_BITS,
  MAX_VERSION,
  gf: { gmul, gdiv, gpow, EXP, LOG },
};
