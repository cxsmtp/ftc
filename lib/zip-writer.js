"use strict";

// v8.15.0 — A MINIMAL ZIP WRITER for the full event and person exports.
//
// The platform READS ZIPs with yauzl and had nothing that writes one; adding a
// dependency for a few CSV files is not worth a lockfile change (which forces a
// CI image rebuild — see "Dependency bump" in CLAUDE.md). This writes the plain
// PKZIP format every spreadsheet tool and OS opens: one local header + data per
// entry, a central directory, and the end record. DEFLATE (method 8) through
// Node's own zlib, asynchronously, so a large export never blocks the event loop
// on compression; no ZIP64 (each entry and the whole archive must stay under
// 4 GiB, which an export of one event cannot approach — refused loudly if so),
// no encryption, no comments.
//
// PURE — requires only zlib and util, so a spec may require it at module scope.

const zlib = require("zlib");
const { promisify } = require("util");
const _deflateRaw = promisify(zlib.deflateRaw);

const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS date/time, in UTC — the format has no zone, and an export is stamped
// once for every entry so the archive is internally consistent.
function _dosDateTime(d) {
  const time = ((d.getUTCHours() & 31) << 11) | ((d.getUTCMinutes() & 63) << 5) | ((Math.floor(d.getUTCSeconds() / 2)) & 31);
  const date = (((d.getUTCFullYear() - 1980) & 127) << 9) | (((d.getUTCMonth() + 1) & 15) << 5) | (d.getUTCDate() & 31);
  return { time, date };
}

const _LIMIT = 0xFFFFFFFF;

/**
 * The awaited half of building a ZIP: each entry's name checked and its data
 * deflated. Names are UTF-8 paths (bit 11 set: `a.csv`, `dir/b.csv`, `1-张伟.pdf`); a name with `..`, a
 * leading `/`, a backslash, or one already used is refused, so the writer cannot
 * produce a path-traversal archive. Hand the result (or any subset of it, in any
 * order) to `assembleZip`, which awaits nothing: a route that must re-check
 * after its LAST await (the top-three certificates ZIP) deflates first, checks,
 * then assembles only what may still go out.
 * @param {{name: string, data: Buffer|string}[]} entries
 * @returns {Promise<{name: string, nameBuf: Buffer, raw: number, comp: Buffer, crc: number}[]>}
 */
async function deflateZipEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const name = String(e.name);
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || seen.has(name)) {
      throw new Error(`zip-writer: refusing entry name ${JSON.stringify(name)}`);
    }
    seen.add(name);
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const comp = await _deflateRaw(raw);
    if (raw.length >= _LIMIT || comp.length >= _LIMIT) throw new Error("zip-writer: entry too large for a non-ZIP64 archive");
    out.push({ name, nameBuf: Buffer.from(name, "utf8"), raw: raw.length, comp, crc: crc32(raw) });
  }
  return out;
}

/**
 * The synchronous half: the archive's headers around entries `deflateZipEntries`
 * prepared (a subset of them is fine; a repeated name is still refused).
 * @param {{date?: Date}} [opts]
 * @returns {Buffer}
 */
function assembleZip(prepared, opts = {}) {
  const stamp = _dosDateTime(opts.date instanceof Date ? opts.date : new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const e of prepared) {
    if (seen.has(e.name)) throw new Error(`zip-writer: refusing entry name ${JSON.stringify(e.name)}`);
    seen.add(e.name);
    const { nameBuf, comp, crc } = e;
    const flags = 0x0800; // bit 11: the name is UTF-8
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed: 2.0 (deflate)
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(8, 8);           // method: deflate
    lh.writeUInt16LE(stamp.time, 10);
    lh.writeUInt16LE(stamp.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.raw, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(stamp.time, 12);
    ch.writeUInt16LE(stamp.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.raw, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
    if (offset >= _LIMIT) throw new Error("zip-writer: archive too large for a non-ZIP64 archive");
  }
  if (prepared.length > 0xFFFF) throw new Error("zip-writer: too many entries");
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Build a ZIP archive (both halves at once).
 * @param {{name: string, data: Buffer|string}[]} entries  see `deflateZipEntries`
 * @param {{date?: Date}} [opts]
 * @returns {Promise<Buffer>}
 */
async function buildZip(entries, opts = {}) {
  return assembleZip(await deflateZipEntries(entries), opts);
}

module.exports = { buildZip, deflateZipEntries, assembleZip, crc32 };
