"use strict";

// A QR SYMBOL THE PLATFORM DRAWS READS BACK (sweep gap #215).
//
// lib/qr.js draws the two symbols people scan: the certificate's verification
// mark (level M, `BASE_URL/credential?code=…`) and the event join QR (level H,
// the event code over a reserved centre). tests/certificate-config.spec.js checks
// the encoder's own algebra, and tests/join-qr.spec.js its reservation (decoding
// each reserved symbol with this reader). This file READS the symbols back with
// an independent reader, tests/qr-decode.js (tables transcribed from ISO/IEC
// 18004, its own field arithmetic, Reed-Solomon CORRECTION), so a symbol fails
// here, whatever the encoder believes about it, when the standard's decoding
// would refuse it: a function pattern drawn wrong (a finder, a separator, a
// timing line, an alignment pattern, the dark module), format or version
// information past correction, a block past its correction capacity, or data
// that does not parse back to the text. (Finding a symbol in a photograph is a
// camera's problem this does not model: rasters here are axis-aligned.)
//
//   * the reader itself first: its transcribed tables agree with the standard's
//     BCH arithmetic, with Table 7's data codewords and fill every symbol
//     exactly; its Reed-Solomon decoder corrects a block up to the standard's
//     capacity and refuses one error more; and its function-pattern check covers
//     exactly the modules the standard's geometry gives, refusing ANY one of them
//     flipped (a separator or an alignment ring darkened among them);
//   * level M at every version 1-10, at both ends of each version's capacity and
//     through all eight masks, real verification links at every version one can
//     reach, and the mark as the certificate DRAWS it (its path, and the pixels
//     the renderer paints), on a dark design, a light one and two whose colours
//     sit close (a light design once drew its mark inverted, a defect this reader
//     found; now dark modules on a lighter plate whatever the palette, falling
//     back to black on white where those modules and that plate would sit under
//     128 luma apart);
//   * level H with the centre: the worst possible reading of every module under
//     the label still decodes inside each block's capacity less the one spare
//     codeword the encoder promises, with every function pattern intact, one
//     error past a block's capacity is refused (the negative control), and the
//     route's own SVG for a real event, rasterised at 120-1600 px with its label
//     drawn, reads back to the event's join link, the plate's box the one
//     function-pattern exemption (refused without it).

const { test, expect } = require("./isolated-test");
const { apiLogin } = require("./helpers");
const qr = require("../lib/qr");
const D = require("./qr-decode");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// resvg cannot read woff2, so the badge's Inter faces stand in for the label's
// monospace stack (a browser drawing the SVG as an image uses a system monospace
// face, narrower than Inter's capitals, so this draws MORE ink than a browser).
const FONT = {
  fontFiles: ["inter-regular.ttf", "inter-semibold.ttf", "inter-extrabold.ttf"].map(f => path.join(ROOT, "lib", "fonts", "badge", f)),
  loadSystemFonts: false, defaultFontFamily: "Inter", monospaceFamily: "Inter",
};
// The join QR's label box, read from the route so this follows the product.
const JOIN_QR_CENTRE = (() => {
  const m = /const JOIN_QR_CENTRE = Object\.freeze\(\{ w: ([\d.]+), h: ([\d.]+) \}\);/.exec(fs.readFileSync(path.join(ROOT, "routes", "export-import.js"), "utf8"));
  if (!m) throw new Error("routes/export-import.js no longer declares JOIN_QR_CENTRE as this file reads it");
  return { w: Number(m[1]), h: Number(m[2]) };
})();
const TOKEN = "Zk3_q9Lm-".repeat(4) + "Abcdefg";                  // 43 characters, a join token's length
const JOIN_BASES = ["https://x.io", "http://localhost:4567", "https://ctf.checkmarx.net", "https://hackarena.example.com",
  "https://hackathon-platform.events.example-corp.com"];

/** BCH systematic encode: `data` followed by the remainder of data·x^deg mod gen. */
function bch(data, gen, deg, totalBits) {
  let r = data << deg;
  for (let i = totalBits - 1; i >= deg; i--) if (r & (1 << i)) r ^= gen << (i - deg);
  return (data << deg) | r;
}
/** Byte-mode capacity, from the reader's own block table (never lib/qr.js's). */
function capacity(version, level) {
  const dataCodewords = D.blockLayout(version, level).reduce((s, b) => s + b.k, 0);
  return Math.floor((8 * dataCodewords - 4 - (version <= 9 ? 8 : 16)) / 8);
}
/** The smallest version whose capacity holds `len` bytes, from the same table. */
function versionFor(len, level) {
  for (let v = 1; v <= D.MAX_VERSION; v++) if (capacity(v, level) >= len) return v;
  return null;
}
/** A deterministic ASCII payload of exactly `len` bytes. */
function payload(len, seed) {
  const set = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&'()*+,;=%";
  let s = "";
  for (let i = 0; i < len; i++) s += set[(i * 31 + seed * 17 + (i >> 3)) % set.length];
  return s;
}
/** Flip one module of each listed interleaved codeword: exactly one byte error each. */
function flipCodewords(modules, version, positions) {
  const order = D.dataModuleOrder(version);
  const m = modules.map(r => r.slice());
  for (const p of positions) { const [x, y] = order[8 * p + 3]; m[y][x] = !m[y][x]; }
  return m;
}
/** Interleaved positions of block `b`'s codewords, spread over data and ECC, minus `skip`. */
function blockPositions(version, level, b, count, skip = new Set()) {
  const mine = D.interleaveMap(version, level).map((e, p) => ({ ...e, p })).filter(e => e.block === b && !skip.has(e.p));
  const step = Math.max(1, Math.floor(mine.length / Math.max(1, count)));
  const out = [];
  for (let i = 0; out.length < count && i < mine.length; i += step) out.push(mine[i].p);
  for (let i = 0; out.length < count && i < mine.length; i++) if (!out.includes(mine[i].p)) out.push(mine[i].p);
  return out;
}
const rejected = (fn) => {
  try { fn(); } catch (e) { if (e instanceof D.QrDecodeError) return e.code; throw e; }
  return null;
};
/** As `rejected`, with the reader's message: `{ code, message }`, or null when it read. */
const refusal = (fn) => {
  try { fn(); } catch (e) { if (e instanceof D.QrDecodeError) return { code: e.code, message: e.message }; throw e; }
  return null;
};
/**
 * How many modules the standard's function patterns hold at `version`, from its
 * geometry alone (not the reader's table): three finders of 7x7 and three
 * separators of 15, both timing lines between the separators (n - 16 modules
 * each), 25 per alignment pattern (Annex E: 2 centres per axis for versions 2-6,
 * 3 for 7-13, every pair but the three under a finder), less the 5 modules each
 * pattern centred on row or column 6 shares with a timing line, and the dark module.
 */
function functionModuleCount(version) {
  const n = 17 + 4 * version;
  const k = version === 1 ? 0 : version < 7 ? 2 : 3;
  const patterns = k === 0 ? 0 : k * k - 3;
  const onTiming = k === 0 ? 0 : 2 * (k - 2);
  return 3 * 49 + 3 * 15 + 2 * (n - 16) + 25 * patterns - 5 * onTiming + 1;
}
/** `m` with the modules at `cells` ([x, y]) inverted. */
const flipped = (m, cells) => { const out = m.map(r => r.slice()); for (const [x, y] of cells) out[y][x] = !out[y][x]; return out; };

test.describe("the reader itself (tests/qr-decode.js)", () => {
  test("its transcribed tables agree with the standard's arithmetic and with each other, and fill every symbol exactly", () => {
    let words = 0;
    for (const level of ["L", "M", "Q", "H"]) {
      D.FORMAT_WORDS[level].forEach((w, mask) => {
        const want = bch((D.LEVEL_BITS[level] << 3) | mask, 0x537, 10, 15) ^ 0x5412;
        expect(parseInt(w, 2), `format word ${level}/${mask}`).toBe(want);
        words++;
      });
    }
    for (const v of [7, 8, 9, 10]) {
      expect(parseInt(D.VERSION_WORDS[v], 2), `version word ${v}`).toBe(bch(v, 0x1f25, 12, 18));
      words++;
    }
    expect(words, "anti-vacuity: 32 format words and 4 version words checked").toBe(36);
    let layouts = 0;
    for (let v = 1; v <= D.MAX_VERSION; v++) {
      expect(D.dataModuleOrder(v).length, `version ${v}: the data region holds every codeword and the remainder bits`)
        .toBe(8 * D.TOTAL_CODEWORDS[v] + D.REMAINDER_BITS[v]);
      for (const level of ["L", "M", "Q", "H"]) {
        const blocks = D.blockLayout(v, level);
        expect(blocks.reduce((s, b) => s + b.c, 0), `${v}-${level}: blocks fill the symbol`).toBe(D.TOTAL_CODEWORDS[v]);
        // Table 9's block shapes against Table 7, transcribed apart: a typo in
        // any block's k (or its count) moves this sum.
        expect(blocks.reduce((s, b) => s + b.k, 0), `${v}-${level}: the blocks' data codewords are Table 7's`).toBe(D.DATA_CODEWORDS[v][level]);
        expect(new Set(blocks.map(b => b.ecc)).size, `${v}-${level}: one ECC length`).toBe(1);
        for (const b of blocks) {
          expect(Number.isInteger(b.capacity) && b.capacity > 0 && 2 * b.capacity <= b.ecc, `${v}-${level}: capacity ${b.capacity} of ${b.ecc}`).toBe(true);
        }
        expect(D.interleaveMap(v, level).length).toBe(D.TOTAL_CODEWORDS[v]);
        layouts++;
      }
    }
    expect(layouts).toBe(40);
  });

  test("Reed-Solomon: a block is corrected up to the standard's capacity and refused one error more", () => {
    const seen = new Set();
    let cases = 0;
    for (let v = 1; v <= D.MAX_VERSION; v++) {
      for (const level of ["L", "M", "Q", "H"]) {
        for (const b of D.blockLayout(v, level)) {
          const key = `${b.c}/${b.k}/${b.capacity}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const data = Array.from({ length: b.k }, (_, i) => (i * 73 + b.c * 11 + 5) & 0xff);
          const ecc = D.rsEncode(data, b.ecc);
          // Two implementations of the same arithmetic agree: this reader's
          // log/antilog field and the encoder's bitwise one.
          expect(ecc, `${key}: the reader's ECC is the encoder's`).toEqual(qr._rsRemainder(data, qr._rsDivisor(b.ecc)));
          const word = data.concat(ecc);
          expect(D.rsCorrect(word, b.ecc, b.capacity).errors, `${key}: a clean block`).toBe(0);
          // `count` errors at distinct places spread over data and ECC, each a
          // different non-zero value.
          const hit = (count) => {
            const w = word.slice();
            const at = [];
            for (let i = 0; i < count; i++) {
              const pos = (Math.floor((i * b.c) / count) + 3) % b.c;
              at.push(pos);
              w[pos] ^= 1 + ((i * 89 + 7) % 255);
            }
            expect(new Set(at).size, `${key}: ${count} distinct places`).toBe(count);
            return { w, at };
          };
          const ok = hit(b.capacity);
          const fixed = D.rsCorrect(ok.w, b.ecc, b.capacity);
          expect(fixed.word, `${key}: ${b.capacity} errors corrected`).toEqual(word);
          expect(fixed.positions, `${key}: at the right places`).toEqual(ok.at.slice().sort((x, y) => x - y));
          expect(rejected(() => D.rsCorrect(hit(b.capacity + 1).w, b.ecc, b.capacity)), `${key}: one error more is refused`).toBe("rs");
          cases++;
        }
      }
    }
    expect(cases, "anti-vacuity: every distinct block shape of versions 1-10").toBeGreaterThanOrEqual(30);
  });

  test("the function patterns: exactly the standard's modules are checked, and any ONE of them wrong is refused", () => {
    const text = "4K7MP2QX9RTV";
    let flips = 0;
    for (const v of [1, 2, 7, 10]) {
      const q = qr.encodeQr(text, { version: v });
      expect(q.version, "PRECONDITION: the version asked for").toBe(v);
      const n = q.size;
      // POSITIVE CONTROL: the clean symbol reads, and the check compared every
      // module the standard's geometry gives (counted here, not by the reader).
      const clean = D.decodeQr(q.modules);
      expect(clean.text).toBe(text);
      expect(clean.functionPatterns, `version ${v}: every function-pattern module compared, none exempt`).toEqual({ checked: functionModuleCount(v), exempt: 0 });
      const cells = D.functionPatternModules(v);
      expect(cells.length, `version ${v}: the reader's table holds the standard's count`).toBe(functionModuleCount(v));
      // Each one of them inverted ALONE is refused, by the function check.
      for (const { x, y, what } of cells) {
        expect(rejected(() => D.decodeQr(flipped(q.modules, [[x, y]]))), `version ${v}: ${what} at ${x},${y} inverted`).toBe("function");
        flips++;
      }
      if (v !== 7) continue;
      // Named, the two a finder- or alignment-based reader trips on and the
      // encoder's own checks never looked at: a separator module darkened (the
      // light band that ends a finder's 1:1:3:1:1 run, so a scan across it no
      // longer finds that ratio) and a module of an alignment pattern's light
      // ring darkened, on a timing line and off it.
      for (const [x, y, what] of [[7, 3, "top-left separator"], [n - 8, 5, "top-right separator"], [4, n - 8, "bottom-left separator"],
        [23, 22, "alignment pattern at 22,22"], [7, 22, "alignment pattern at 6,22"]]) {
        expect(q.modules[y][x], `PRECONDITION: ${what} module ${x},${y} is light as drawn`).toBe(false);
        expect(refusal(() => D.decodeQr(flipped(q.modules, [[x, y]]))), `${what}: one module darkened`)
          .toEqual({ code: "function", message: `${what}: module ${x},${y} is dark where the standard draws it light` });
      }
      // A label box exempts exactly the modules under it: the centre pattern's
      // ring darkened reads with the box over it, and is counted exempt, while
      // the same fault one pattern down (outside the box) is still refused.
      const box = { x: 20, y: 20, w: 5, h: 5 };
      const under = D.decodeQr(flipped(q.modules, [[23, 22]]), { labelBox: box });
      expect(under.text, "a fault under the box reads").toBe(text);
      expect(under.functionPatterns, "the box exempts its 25 modules, no more").toEqual({ checked: functionModuleCount(v) - 25, exempt: 25 });
      expect(rejected(() => D.decodeQr(flipped(q.modules, [[23, 38]]), { labelBox: box })), "the same fault outside the box").toBe("function");
      // ...and a box may not reach what locates the symbol, nor be anything but whole modules.
      for (const bad of [{ x: 8, y: 20, w: 5, h: 5 }, { x: 20, y: 6, w: 5, h: 5 }, { x: 20, y: 20, w: n - 28, h: 5 }, { x: 20.5, y: 20, w: 5, h: 5 }]) {
        expect(rejected(() => D.decodeQr(q.modules, { labelBox: bad })), `label box ${JSON.stringify(bad)} refused`).toBe("function");
      }
    }
    expect(flips, "anti-vacuity: every function-pattern module of four versions was flipped").toBe([1, 2, 7, 10].reduce((s, v) => s + functionModuleCount(v), 0));
  });
});

test.describe("level M: the certificate's verification mark", () => {
  test("every version 1-10 reads back exactly at both ends of its capacity, through all eight masks", () => {
    const masks = new Set();
    const check = (text, v, why) => {
      const q = qr.encodeQr(text);
      const r = D.decodeQr(q.modules);
      expect(r.text, why).toBe(text);
      expect(r.version, `${why}: the version a reader derives from the size`).toBe(v);
      expect(r.level, why).toBe("M");
      expect(r.mask, `${why}: the mask it reports is the one it used`).toBe(q.mask);
      expect(r.functionPatterns, `${why}: every finder, separator, timing, alignment and dark module as the standard draws it`)
        .toEqual({ checked: functionModuleCount(v), exempt: 0 });
      expect(r.format.copies, `${why}: both format copies are exact codewords`).toEqual([0, 0]);
      if (v >= 7) expect(r.versionInfo.copies, `${why}: both version copies exact`).toEqual([0, 0]);
      else expect(r.versionInfo, why).toBeNull();
      expect(r.errors, `${why}: nothing to correct`).toBe(0);
      expect(r.padOk && r.remainderOk, `${why}: terminator, pad codewords and remainder bits as the standard writes them`).toBe(true);
      expect(r.segments).toEqual([Buffer.byteLength(text)]);
      masks.add(r.mask);
    };
    for (let v = 1; v <= D.MAX_VERSION; v++) {
      const smallest = v === 1 ? 1 : capacity(v - 1, "M") + 1;
      check(payload(smallest, v), v, `version ${v}, ${smallest} bytes (one past version ${v - 1})`);
      check(payload(capacity(v, "M"), v + 50), v, `version ${v}, ${capacity(v, "M")} bytes (full)`);
    }
    expect(() => qr.encodeQr(payload(capacity(D.MAX_VERSION, "M") + 1, 1)), "CONTROL: one byte more than version 10 holds is refused").toThrow(RangeError);
    // Non-ASCII text travels as its UTF-8 bytes.
    const utf8 = "https://hack.example.com/credential?code=4K7MP2QX9RTV&n=Müller-Łukasz-张伟";
    check(utf8, versionFor(Buffer.byteLength(utf8), "M"), "UTF-8 bytes");
    // The penalty score picks the mask, and symbols of one shape keep picking
    // the same few, so walk payloads of every length until each mask has been
    // read back (deterministic: the same text always takes the same mask).
    for (let i = 0; i < 400 && masks.size < 8; i++) {
      const len = 1 + ((i * 37) % capacity(D.MAX_VERSION, "M"));
      check(payload(len, i), versionFor(len, "M"), `mask walk ${i} (${len} bytes)`);
    }
    expect([...masks].sort(), "all eight masks were read back").toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("real verification links read back at every version one can reach (3-10)", () => {
    const code = "4K7MP2QX9RTV";
    for (let v = 3; v <= D.MAX_VERSION; v++) {
      const room = capacity(v, "M") - "/credential?code=".length - code.length;   // the BASE_URL that fills version v
      const base = "https://" + "verify".repeat(40).slice(0, room - "https://".length - ".io".length) + ".io";
      const link = `${base}/credential?code=${code}`;
      expect(Buffer.byteLength(link), `version ${v}: the link is exactly full`).toBe(capacity(v, "M"));
      const q = qr.encodeQr(link);
      const r = D.decodeQr(q.modules);
      expect(r.text).toBe(link);
      expect(r.version, `a ${link.length}-byte link`).toBe(v);
      expect(r.errors).toBe(0);
    }
  });

  test("the certificate draws its mark so that it reads back: the path it writes, and the pixels the renderer paints", async () => {
    test.setTimeout(60_000);
    const badge = require("../lib/badge");
    const { Resvg } = require("@resvg/resvg-js");
    const verifyLink = "https://hack.example.com/credential?code=4K7MP2QX9RTV";
    const svg = badge.buildCertificateSvg({
      platformName: "Checkmarx Enablement Hub", competitionName: "India AI-Day 2026 Mumbai", displayName: "Jane Doe",
      dateLabel: "6 Aug 2026", scoreLabel: "400 pts", publicCode: "4K7MP2QX9RTV", verifyUrl: "hack.example.com/credential",
      verifyLink, rank: 1, basis: "placement",
    });
    const d = (/<path class="cert-qr" d="([^"]+)"/.exec(svg) || [])[1];
    expect(d, "the certificate draws a verification QR").toBeTruthy();
    const drawn = D.matrixFromSvgPath(d);
    const read = D.decodeQr(drawn.modules);
    expect(read.text, "the drawn path reads back to the verify link").toBe(verifyLink);
    expect(read.level).toBe("M");
    expect(read.errors).toBe(0);
    expect(read.functionPatterns, "no label, nothing exempt").toEqual({ checked: functionModuleCount(read.version), exempt: 0 });
    // The pixels: rendered as renderBadgePng renders a certificate (its own width,
    // the Inter faces), the mark read where its path puts it, darker = dark.
    const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)[1]);
    const img = new Resvg(svg, { font: FONT, fitTo: { mode: "width", value: width } }).render();
    const raster = { width: img.width, height: img.height, pixels: img.pixels };
    const box = { x: drawn.x, y: drawn.y, w: drawn.size * drawn.modulePx, h: drawn.size * drawn.modulePx };
    const painted = D.matrixFromRegion(raster, box, drawn.size);
    expect(painted.contrast, "the mark stands out from its plate").toBeGreaterThan(128);
    expect(D.decodeQr(painted.modules).text, "the painted mark reads back").toBe(verifyLink);
    // CONTROL: the region reader is not blind — a box one module off reads nothing
    // (the top-left finder's right edge then lands on its light separator).
    const off = D.matrixFromRegion(raster, { ...box, x: box.x + drawn.modulePx }, drawn.size);
    expect(rejected(() => D.decodeQr(off.modules)), "a misplaced read fails at the function patterns").toBe("function");
  });

  // The light plate is the symbol's quiet zone (lib/qr.js qrSvgPath draws none:
  // its caller owns it). It once left a fixed 6 px, 2.3-2.9 modules for a real
  // verify link, so the frame stroke and a dark background began inside the
  // four modules a reader expects to be light. Held for the shortest real link
  // (version 4) and a long host (version 6), in the SVG's geometry and in the
  // painted pixels.
  test("the certificate's mark sits on a plate leaving a four-module quiet zone, drawn and painted", async () => {
    test.setTimeout(60_000);
    const badge = require("../lib/badge");
    const { Resvg } = require("@resvg/resvg-js");
    const links = [
      { link: "https://hack.example.com/credential?code=4K7MP2QX9RTV", version: 4 },
      { link: `https://verify.${"a".repeat(40)}.example.com/credential?code=4K7MP2QX9RTV`, version: 6 },
    ];
    for (const { link, version } of links) {
      const svg = badge.buildCertificateSvg({
        platformName: "Checkmarx Enablement Hub", competitionName: "India AI-Day 2026 Mumbai", displayName: "Jane Doe",
        dateLabel: "6 Aug 2026", scoreLabel: "400 pts", publicCode: "4K7MP2QX9RTV", verifyUrl: "hack.example.com/credential",
        verifyLink: link, rank: 1, basis: "placement",
      });
      const d = (/<path class="cert-qr" d="([^"]+)"/.exec(svg) || [])[1];
      expect(d, `version ${version}: the certificate draws a verification QR`).toBeTruthy();
      const drawn = D.matrixFromSvgPath(d);
      expect(D.decodeQr(drawn.modules).version, `PRECONDITION: the link fills version ${version}`).toBe(version);
      // The plate: the first filled rect with the plate's corner radius, just ahead of the mark.
      const before = svg.slice(0, svg.indexOf('<path class="cert-qr"'));
      const plates = [...before.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="3" fill="#/g)];
      expect(plates.length, `version ${version}: a plate is drawn behind the mark`).toBeGreaterThan(0);
      const [px, py, pw, ph] = plates[plates.length - 1].slice(1, 5).map(Number);
      const m = drawn.modulePx, side = drawn.size * m;
      const margins = { left: drawn.x - px, top: drawn.y - py, right: px + pw - (drawn.x + side), bottom: py + ph - (drawn.y + side) };
      for (const [k, v] of Object.entries(margins)) {
        expect(v / m, `version ${version}: the plate's ${k} margin in modules`).toBeGreaterThanOrEqual(3.99);
      }
      // The pixels: the ring between the symbol and the symbol grown by four
      // modules is light all round (read at each module's centre).
      const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)[1]);
      const img = new Resvg(svg, { font: FONT, fitTo: { mode: "width", value: width } }).render();
      const raster = { width: img.width, height: img.height, pixels: img.pixels };
      const ring = (q) => {
        const g = D.matrixFromRegion(raster, { x: drawn.x - q * m, y: drawn.y - q * m, w: side + 2 * q * m, h: side + 2 * q * m }, drawn.size + 2 * q);
        const dark = [];
        for (let y = 0; y < g.modules.length; y++) for (let x = 0; x < g.modules.length; x++) {
          const inside = x >= q && y >= q && x < q + drawn.size && y < q + drawn.size;
          if (!inside && g.modules[y][x]) dark.push([x, y]);
        }
        return { dark, symbolDark: g.modules.some((row, y) => row.some((c, x) => c && x >= q && y >= q && x < q + drawn.size && y < q + drawn.size)) };
      };
      const four = ring(4);
      expect(four.symbolDark, `PRECONDITION (version ${version}): the reader sees the mark's dark modules`).toBe(true);
      expect(four.dark, `version ${version}: every cell of the four-module ring is light`).toEqual([]);
      // CONTROL: the reader can see dark there — six modules out reaches the
      // frame stroke and the dark design's background.
      expect(ring(6).dark.length, `CONTROL (version ${version}): six modules out the ring is not all light`).toBeGreaterThan(0);
    }
  });

  // A light design (dark text on white, which the validator accepts) once drew
  // white modules on a grey plate: inverted, low contrast, unreadable to a reader
  // that takes darker as dark (found by this reader). The modules are now the
  // darker of the design's background and text colours and the plate the lighter
  // one tinted half-way to white, and the mark falls back to black on white only
  // where THOSE two, the modules and the tinted plate, would sit under 128 of 255
  // apart in luma (lib/badge.js `_qrInks`). The two design colours are never
  // compared with each other: a pair only 26 apart (#000000 and #1A1A1A) keeps
  // its own ink, black on a #8D8D8D plate 141 away. The default (dark) design
  // keeps the inks it always had.
  test("every palette a design may choose draws a mark a reader reads: darker modules on a lighter plate", async () => {
    test.setTimeout(60_000);
    const badge = require("../lib/badge");
    const CC = require("../lib/certificate-config");
    const { Resvg } = require("@resvg/resvg-js");
    const verifyLink = "https://hack.example.com/credential?code=4K7MP2QX9RTV";
    const D0 = CC.certificateDefaults().colors;
    const cases = [
      { name: "the default dark design", layer: {}, modules: D0.background },
      { name: "a light design (dark text on white)", layer: { colors: { background: "#FFFFFF", text: "#111111" } }, modules: "#111111", plate: "#FFFFFF" },
      // #777777 (luma 119) against #8A8A8A tinted half-way to white (#C5C5C5, 197): 78 apart.
      { name: "a design whose modules would sit under 128 luma from their tinted plate", layer: { colors: { background: "#777777", text: "#8A8A8A" } }, modules: "#000000", plate: "#FFFFFF" },
      // #000000 (0) against #1A1A1A tinted half-way to white (#8D8D8D, 141): 141 apart, so no fallback.
      { name: "a close pair (26 luma apart) whose tinted plate still sits 141 from its modules", layer: { colors: { background: "#000000", text: "#1A1A1A" } }, modules: "#000000", plate: "#8D8D8D" },
    ];
    for (const c of cases) {
      expect(CC.validateCertificateConfig(c.layer).ok, `PRECONDITION (${c.name}): an organiser may save this design`).toBe(true);
      const svg = badge.buildCertificateSvg({
        platformName: "Checkmarx Enablement Hub", competitionName: "India AI-Day 2026 Mumbai", displayName: "Jane Doe",
        dateLabel: "6 Aug 2026", scoreLabel: "400 pts", publicCode: "4K7MP2QX9RTV", verifyUrl: "hack.example.com/credential",
        verifyLink, rank: 1, basis: "placement", design: CC.mergeCertificateConfig(CC.certificateDefaults(), c.layer),
      });
      const mark = /<path class="cert-qr" d="([^"]+)" fill="(#[0-9A-Fa-f]{6})"/.exec(svg);
      expect(mark, `${c.name}: the certificate draws a verification QR`).toBeTruthy();
      expect(mark[2].toUpperCase(), `${c.name}: the modules' ink`).toBe(c.modules.toUpperCase());
      if (c.plate) expect(svg, `${c.name}: the plate's ink`).toContain(`rx="3" fill="${c.plate}"`);
      const drawn = D.matrixFromSvgPath(mark[1]);
      const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)[1]);
      const img = new Resvg(svg, { font: FONT, fitTo: { mode: "width", value: width } }).render();
      const box = { x: drawn.x, y: drawn.y, w: drawn.size * drawn.modulePx, h: drawn.size * drawn.modulePx };
      const painted = D.matrixFromRegion({ width: img.width, height: img.height, pixels: img.pixels }, box, drawn.size);
      const read = D.decodeQr(painted.modules);
      expect(read.text, `${c.name}: the painted mark reads back, darker as dark`).toBe(verifyLink);
      expect(read.functionPatterns, `${c.name}: every function pattern painted as drawn`).toEqual({ checked: functionModuleCount(read.version), exempt: 0 });
      expect(painted.contrast, `${c.name}: and stands out from its plate`).toBeGreaterThan(128);
    }
  });

  test("NEGATIVE CONTROL: a symbol corrupted past a block's capacity is refused, and at the capacity it is corrected", () => {
    const text = "https://hack.example.com/credential?code=4K7MP2QX9RTV";
    for (const v of [4, 7, 10]) {
      const q = qr.encodeQr(text, { version: v });
      expect(q.version).toBe(v);
      const blocks = D.blockLayout(v, "M");
      const last = blocks.length - 1;
      const cap = blocks[last].capacity;
      const atCap = flipCodewords(q.modules, v, blockPositions(v, "M", last, cap));
      const r = D.decodeQr(atCap);
      expect(r.text, `version ${v}: ${cap} errors in one block are corrected`).toBe(text);
      expect(r.blocks[last].errors).toBe(cap);
      expect(rejected(() => D.decodeQr(flipCodewords(q.modules, v, blockPositions(v, "M", last, cap + 1)))),
        `version ${v}: ${cap + 1} errors in one block are refused`).toBe("rs");
    }
    // The format information is corrected up to three bits and refused past that.
    const q = qr.encodeQr(text);
    const flipFmt = (cells) => { const m = q.modules.map(r => r.slice()); for (const [x, y] of cells) m[y][x] = !m[y][x]; return m; };
    const n = q.size;
    const three = [[0, 8], [2, 8], [8, 1], [n - 1, 8], [n - 3, 8], [8, n - 2]];   // three bits in each copy
    expect(D.decodeQr(flipFmt(three)).text, "three bad format bits per copy are corrected").toBe(text);
    const many = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, n - 1], [8, n - 2], [8, n - 3], [8, n - 4], [8, n - 5], [8, n - 6], [8, n - 7]];
    expect(rejected(() => D.decodeQr(flipFmt(many))), "seven bad format bits per copy are refused").not.toBeNull();
  });
});

test.describe("level H: the event join QR with its code in the centre", () => {
  test("the worst possible reading of every module under the label still decodes, inside each block's capacity less one", () => {
    let symbols = 0, raised = 0;
    // The route's box, and one the smallest version cannot afford (the encoder
    // must move up a version, and count right to know it has to).
    for (const [centre, base] of [...JOIN_BASES.map(b => [JOIN_QR_CENTRE, b]), ...JOIN_BASES.slice(0, 4).map(b => [{ w: 0.6, h: 0.3 }, b])]) {
      const url = `${base}/join/${TOKEN}`;
      const q = qr.encodeQr(url, { level: "H", centre });
      const clean = qr.encodeQr(url, { level: "H", version: q.version });
      expect(clean.mask, "the reservation is made after the mask is chosen").toBe(q.mask);
      // As drawn (the box cleared to light). Read with NO label box: the encoder
      // clears data modules only, so every function pattern under its box (an
      // alignment pattern, from version 7) must still be whole.
      const drawn = D.decodeQr(q.modules);
      expect(drawn.text).toBe(url);
      expect(drawn.level).toBe("H");
      expect(drawn.errors, `${url.length} bytes: the box really took data modules`).toBeGreaterThan(0);
      expect(drawn.functionPatterns, `${url.length} bytes: every function pattern whole, none exempt`).toEqual({ checked: functionModuleCount(q.version), exempt: 0 });
      // The worst case: every data module under the label read as the opposite
      // of what the clean symbol holds there (whatever the plate, the frame or
      // the code's glyphs make of it).
      const fn = D.functionModules(q.version);
      const b = q.centre;
      const inBox = (x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
      const worst = q.modules.map((row, y) => row.map((v, x) => (!fn[y][x] && inBox(x, y) ? !clean.modules[y][x] : v)));
      const w = D.decodeQr(worst);
      expect(w.text, `${url.length} bytes: the worst reading decodes`).toBe(url);
      for (const [i, blk] of w.blocks.entries()) {
        expect(blk.errors, `${url.length} bytes, block ${i}: within its capacity ${blk.capacity} less the one spare codeword`).toBeLessThanOrEqual(blk.capacity - 1);
        expect(blk.errors, `${url.length} bytes, block ${i}: at least what the drawn symbol holds`).toBeGreaterThanOrEqual(drawn.blocks[i].errors);
      }
      // NEGATIVE CONTROL at the boundary: fill the worst block to its capacity
      // (corrected), then one codeword more (refused).
      const hitIdx = w.blocks.reduce((best, blk, i) => (blk.errors > w.blocks[best].errors ? i : best), 0);
      const rawWorst = D.readBlocks(worst).blocks[hitIdx].word, rawClean = D.readBlocks(clean.modules).blocks[hitIdx].word;
      const wrongAt = new Set();
      D.interleaveMap(q.version, "H").forEach((e, p) => { if (e.block === hitIdx && rawWorst[e.index] !== rawClean[e.index]) wrongAt.add(p); });
      expect(wrongAt.size, "the reader's error count is the codewords that differ").toBe(w.blocks[hitIdx].errors);
      const room = w.blocks[hitIdx].capacity - w.blocks[hitIdx].errors;
      const extra = blockPositions(q.version, "H", hitIdx, room + 1, wrongAt);
      expect(D.decodeQr(flipCodewords(worst, q.version, extra.slice(0, room))).text, "filled to capacity: corrected").toBe(url);
      expect(rejected(() => D.decodeQr(flipCodewords(worst, q.version, extra))), "one past capacity: refused").toBe("rs");
      if (centre !== JOIN_QR_CENTRE) {
        expect(q.version, `${url.length} bytes: the big box forced a larger version`).toBeGreaterThan(versionFor(url.length, "H"));
        raised++;
      }
      symbols++;
    }
    expect(symbols).toBe(JOIN_BASES.length + 4);
    expect(raised, "anti-vacuity: the version raise was exercised").toBe(4);
  });

  test("the route's SVG for a real event, rasterised at 120-1600 px with its code drawn, reads back to the join link", async () => {
    test.setTimeout(60_000);
    const { Resvg } = require("@resvg/resvg-js");
    const sa = await apiLogin("superadmin");
    try {
      const H = { "x-csrf-token": sa.csrf, "content-type": "application/json" };
      const c = await sa.api.post("/api/admin/competitions", { headers: H, data: {
        name: `QR read-back ${Date.now().toString(36)}`, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60,
      } });
      expect(c.ok(), `create: ${await c.text()}`).toBeTruthy();
      const compId = (await c.json()).competition.id;
      const reveal = await sa.api.get(`/api/admin/competitions/${compId}/self-enroll`);
      expect(reveal.ok(), `reveal: ${await reveal.text()}`).toBeTruthy();
      const link = await reveal.json();
      expect(link.url, "PRECONDITION: a real join link").toMatch(/\/join\/[A-Za-z0-9_-]{20,}$/);
      expect(link.join_code_display, "PRECONDITION: a printable code").toMatch(/^[A-Z0-9][A-Z0-9-]{2,15}$/);
      const read = async (data) => {
        const r = await sa.api.post("/api/admin/join-qr", { headers: H, data });
        expect(r.status(), JSON.stringify(data)).toBe(200);
        return r.text();
      };
      const svg = await read({ text: link.url, label: link.join_code_display });
      expect(svg, "the code is in the SVG").toContain(`>${link.join_code_display}</text>`);
      // The label plate's box, in modules, from what the SVG draws: the symbol's
      // grid from its run path, the plate from the light rect laid over it. It is
      // the reader's one function-pattern exemption, so it must sit on the grid.
      const sym = D.matrixFromSvgPath((/<path fill="#[0-9a-fA-F]+" d="([^"]+)"\/>/.exec(svg) || [])[1]);
      const plate = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#[0-9a-fA-F]+"\/>/.exec(svg);
      expect(plate, "the SVG lays a light plate over the symbol").toBeTruthy();
      const onGrid = (v, what) => {
        expect(Math.abs(v - Math.round(v)), `the plate's ${what} sits on the module grid`).toBeLessThan(0.01);
        return Math.round(v);
      };
      const labelBox = {
        x: onGrid((Number(plate[1]) - sym.x) / sym.modulePx, "left edge"), y: onGrid((Number(plate[2]) - sym.y) / sym.modulePx, "top edge"),
        w: onGrid(Number(plate[3]) / sym.modulePx, "width"), h: onGrid(Number(plate[4]) / sym.modulePx, "height"),
      };
      for (const px of [120, 200, 400, 800, 1200, 1600]) {
        const img = new Resvg(svg, { fitTo: { mode: "width", value: px }, font: FONT }).render();
        const grid = D.matrixFromPixels({ width: img.width, height: img.height, pixels: img.pixels });
        expect(grid.size, `${px} px: the grid the pixels give is the path's`).toBe(sym.size);
        const r = D.decodeQr(grid.modules, { labelBox });
        expect(r.text, `${px} px: the join link`).toBe(link.url);
        expect(r.level, `${px} px`).toBe("H");
        expect(r.errors, `${px} px: the plate and its code really cover data`).toBeGreaterThan(0);
        for (const blk of r.blocks) expect(blk.errors, `${px} px: a block inside its capacity less one`).toBeLessThanOrEqual(blk.capacity - 1);
        expect(r.functionPatterns.checked + r.functionPatterns.exempt, `${px} px: every function-pattern module either compared or under the plate`).toBe(functionModuleCount(r.version));
        expect(r.functionPatterns.exempt, `${px} px: the plate really covers a function pattern (the centre alignment pattern)`).toBeGreaterThan(0);
        // NEGATIVE CONTROL: the plate's box is the only exemption — without it the
        // covered alignment pattern reads wrong and the symbol is refused.
        expect(rejected(() => D.decodeQr(grid.modules)), `${px} px: read with no label box`).toBe("function");
        expect(grid.quietModules * grid.modulePx, `${px} px: a four-module quiet zone (to the pixel)`).toBeGreaterThanOrEqual(4 * grid.modulePx - 1);
      }
      // CONTROL: the same link with no code has nothing under a plate to correct,
      // and every function pattern reads with nothing exempt.
      const plain = await read({ text: link.url });
      const img = new Resvg(plain, { fitTo: { mode: "width", value: 400 }, font: FONT }).render();
      const r = D.decodeQr(D.matrixFromPixels({ width: img.width, height: img.height, pixels: img.pixels }).modules);
      expect(r.text).toBe(link.url);
      expect(r.errors, "no plate, nothing to correct").toBe(0);
      expect(r.functionPatterns, "no plate, nothing exempt").toEqual({ checked: functionModuleCount(r.version), exempt: 0 });
    } finally { await sa.api.dispose(); }
  });
});
