"use strict";

// Task-attachment validation + storage-budget helpers + the ATTACHMENT_*
// limit constants. Cohesive leaf: the challenge admin routes, the participant
// download route, and export-import all import from here. The on-disk dirs +
// boot/periodic sweep schedulers stay in server.js (lifecycle GC); this module
// is pure validation + budget logic. (v7.0.0 refactor: extracted from server.js.)
// Deps: db, config (DATA_DIR / UPLOADS_DIR), log (_freeSpaceBytes), fs, yauzl, crypto.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yauzl = require("yauzl");
const { swallowed } = require("./best-effort");
const db = require("../db");
const { DATA_DIR, UPLOADS_DIR } = require("./config");
const { _freeSpaceBytes } = require("./log");
const { refuseBeforeBody } = require("./http");

const ATTACHMENT_MAX_BYTES        = 64 * 1024 * 1024;
const ATTACHMENT_MAX_PER_TASK     = 10;
const ATTACHMENT_MAX_UNCOMPRESSED = 500 * 1024 * 1024;
const ATTACHMENT_ZIP_BOMB_RATIO   = 100;
const ATTACHMENT_MAX_ENTRIES      = 10_000;
// v6.13.18 — per-admin staging quota (rows + bytes) and a free-disk floor
// applied before either upload route accepts a file. Closes the "compromised
// admin fills disk" attack: a token bound to a single admin can no longer
// stack 30 × 64-MB ZIPs/min indefinitely while the 1-hour janitor window
// runs out, and it can't push the volume past the disk-full edge regardless
// of what other paths (logs, DB, sessions) are doing on the same volume.
const ATTACHMENT_STAGING_MAX_PER_ADMIN       = 20;
const ATTACHMENT_STAGING_MAX_BYTES_PER_ADMIN = 512 * 1024 * 1024;
// ext-audit v7.15.13 — a GLOBAL ceiling across all admins.
//
// The per-admin cap above bounds one admin, not the server: N admins uploading
// concurrently each got their own 512 MB, so the volume the platform could be
// asked to absorb scaled with the number of admin accounts. The free-disk floor
// is the only other brake, and it is checked BEFORE the bytes land, so it
// notices the problem one upload too late. This cap is deliberately several
// times the per-admin one — normal parallel work by a few admins never
// approaches it, while a fleet-wide pile-up is stopped.
const ATTACHMENT_STAGING_MAX_BYTES_GLOBAL = 4 * 1024 * 1024 * 1024;
const ATTACHMENT_FREE_DISK_MIN_BYTES         = 1 * 1024 * 1024 * 1024;
const ATTACHMENT_MIME_ALLOW = new Set([
  "application/zip", "application/x-zip-compressed",
  "application/octet-stream", "application/x-compressed",
  "application/x-zip",
]);

/**
 * Verify `filePath` is a structurally valid, unencrypted ZIP archive with no
 * zip-bomb characteristics. Returns `{size_bytes, entries}` on success or
 * rejects with an Error whose `.code` is one of: "not_a_zip" | "encrypted" |
 * "zip_bomb" | "too_many_entries" | "too_large" | "corrupted".
 *
 * Streams the central directory only — never decompresses. O(entries). No
 * allocation spikes (yauzl's lazyEntries mode drives entry emission on
 * demand). Fails fast on the first encrypted entry rather than walking the
 * whole archive.
 *
 * Encryption detection covers all three general-purpose bitflag positions
 * the ZIP spec reserves for it (bit 0 = traditional PKWARE, bit 6 = strong
 * encryption / AE-x, bit 13 = masked central-directory headers).
 */
function validateUnencryptedZip(filePath) {
  return new Promise((resolve, reject) => {
    const mkErr = (msg, code) => Object.assign(new Error(msg), { code });
    fs.stat(filePath, (statErr, st) => {
      if (statErr) return reject(mkErr("stat failed", "corrupted"));
      if (st.size > ATTACHMENT_MAX_BYTES) return reject(mkErr("too large", "too_large"));
      yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
        if (openErr) return reject(mkErr("not a valid zip", "not_a_zip"));
        let uncompressedSum = 0, entryCount = 0, done = false;
        const finish = (err, val) => { if (done) return; done = true; try { zip.close(); } catch (closeErr) { console.error("[zip-validate] close failed:", closeErr.message); } err ? reject(err) : resolve(val); };
        // yauzl itself emits an "encrypted entries not supported" error as
        // soon as it sees bit 0 in a central-directory record (it refuses to
        // decode the filename). Re-classify that specific error as our
        // `encrypted` code so the admin sees a meaningful message instead of
        // the generic `corrupted`.
        zip.on("error", err => {
          const msg = (err && err.message) || "";
          const code = /encrypt/i.test(msg) ? "encrypted" : "corrupted";
          finish(mkErr(msg || code, code));
        });
        zip.on("end", () => {
          if (uncompressedSum > ATTACHMENT_MAX_UNCOMPRESSED) return finish(mkErr("zip bomb: uncompressed too large", "zip_bomb"));
          if (st.size > 0 && uncompressedSum / st.size > ATTACHMENT_ZIP_BOMB_RATIO) return finish(mkErr("zip bomb: compression ratio", "zip_bomb"));
          finish(null, { size_bytes: st.size, entries: entryCount });
        });
        zip.on("entry", entry => {
          if (done) return;
          entryCount++;
          if (entryCount > ATTACHMENT_MAX_ENTRIES) return finish(mkErr("too many entries", "too_many_entries"));
          const gp = entry.generalPurposeBitFlag || 0;
          if (gp & 0x0001) return finish(mkErr("encrypted entry", "encrypted"));
          if (gp & 0x0040) return finish(mkErr("strong-encryption entry", "encrypted"));
          if (gp & 0x2000) return finish(mkErr("encrypted central directory", "encrypted"));
          if (typeof entry.uncompressedSize === "number" && entry.uncompressedSize > 0) {
            uncompressedSum += entry.uncompressedSize;
          }
          zip.readEntry();
        });
        zip.readEntry();
      });
    });
  });
}

function _unlinkAttachmentTempSync(filePath) {
  if (!filePath) return;
  try {
    const safe = path.join(UPLOADS_DIR, path.basename(filePath));
    fs.unlinkSync(safe);
  } catch (e) { swallowed("attachments:unlink-temp", e); }
}

function _streamSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("data", b => hash.update(b));
    s.on("end", () => resolve(hash.digest("hex")));
    s.on("error", reject);
  });
}

function _attachmentValidationMessage(code) {
  return ({
    not_a_zip: "File is not a valid ZIP archive.",
    encrypted: "Encrypted ZIPs are not allowed. Upload an unencrypted ZIP.",
    zip_bomb: "ZIP rejected (suspiciously large uncompressed size).",
    too_many_entries: `ZIP contains too many entries (limit: ${ATTACHMENT_MAX_ENTRIES}).`,
    too_large: `ZIP exceeds the ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB limit.`,
    corrupted: "ZIP file is corrupted or unreadable.",
  })[code] || "Invalid ZIP file.";
}

function _slugForDownload(name) {
  return String(name || "attachment").replace(/[^\w\-. ]+/g, "_").replace(/\s+/g, "_").slice(0, 120) || "attachment";
}

// Sweep #72 — the server's mirror of public/js/ui/download.js `fileNameSlug`,
// the one any-script rule a certificate file names its holder by (letters of
// any script, accents kept; operator ruling, 14 Nov 2026). public/js is a
// browser-only module graph the server cannot load, so the top-three ZIP, which
// names its files on the server, keeps this copy; its body is held identical to
// the client's by a Docs-hygiene lock (tests/functional-core-b.api.spec.js).
function fileNameSlug(text, { max = 40, fallback = 'file' } = {}) {
  const s = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...s].slice(0, max).join('') || fallback;
}

// v6.13.18 — attachment storage budget. Returns null on success, or
// `{ status, error }` on rejection. Three checks, ordered by cost:
//   (a) free disk floor (statfs is one syscall, no DB round-trip)
//   (b) per-admin row count (single COUNT(*) on staging table)
//   (c) per-admin byte total + this file's size (single SUM())
// Caller passes `incomingFileSize` so the byte check accounts for the
// file we're about to accept. For the pre-multer middleware path,
// pass 0 (the byte check is repeated post-multer with the real size).
// ext-audit v7.15.11 — IN-FLIGHT reservations.
//
// _checkAttachmentStorageBudget reads COUNT/SUM from the staging table, but the
// caller then does ZIP validation + sha256 + rename (all async) BEFORE inserting
// the row. Every concurrent upload therefore passed the same check against the
// same committed state: a probe of 30 simultaneous uploads produced 30 rows
// against a limit of 20, and at 64 MB each that is ~1.9 GB admitted past a
// 512 MB cap.
//
// The server is single-process by hard invariant (see CLAUDE.md), and JS is
// single-threaded, so a check-then-reserve performed in ONE synchronous block
// cannot interleave — this is a real mutual exclusion here, not an approximation.
// Reserve before the async work, release when the row lands (the DB row then
// accounts for it) or when the upload fails.
const _stagingInFlight = new Map();          // adminId -> { count, bytes }
let _stagingInFlightGlobalBytes = 0;         // sum across every admin

function _inFlightFor(adminId) {
  return _stagingInFlight.get(adminId) || { count: 0, bytes: 0 };
}

/**
 * Atomically check the budget INCLUDING other in-flight uploads and reserve a
 * slot. Returns `{ ok: true, release }` or `{ ok: false, status, error }`.
 * The caller MUST call release() exactly once (a finally block).
 */
function reserveAttachmentBudget(adminId, incomingFileSize) {
  const size = Math.max(0, incomingFileSize || 0);
  const err = _checkAttachmentStorageBudget(adminId, incomingFileSize, _inFlightFor(adminId));
  if (err) return { ok: false, ...err };
  // Global ceiling: committed staging bytes across EVERY admin, plus everything
  // currently in flight, plus this file. Checked in the same synchronous block
  // as the reservation below, so (single-process, single-threaded) no concurrent
  // upload can slip between the two.
  {
    const committedAll = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM task_attachments_staging").get().bytes;
    if (committedAll + _stagingInFlightGlobalBytes + size > ATTACHMENT_STAGING_MAX_BYTES_GLOBAL) {
      const cap = Math.round(ATTACHMENT_STAGING_MAX_BYTES_GLOBAL / (1024 * 1024));
      return { ok: false, status: 507, error: `Server-wide staging quota exceeded (${cap} MB). Ask other admins to finish or discard pending uploads, then try again.` };
    }
  }
  // The GLOBAL reservation is taken even when there is no admin identity —
  // otherwise such an upload is MEASURED against the ceiling but never
  // CONTRIBUTES to it, and unbounded anonymous-identity uploads could run
  // concurrently past it. Only the per-admin bookkeeping needs an id.
  _stagingInFlightGlobalBytes += size;
  let globalReleased = false;
  const releaseGlobal = () => {
    if (globalReleased) return;
    globalReleased = true;
    _stagingInFlightGlobalBytes = Math.max(0, _stagingInFlightGlobalBytes - size);
  };
  if (!adminId) return { ok: true, release: releaseGlobal };
  const cur = _inFlightFor(adminId);
  const next = { count: cur.count + 1, bytes: cur.bytes + size };
  _stagingInFlight.set(adminId, next);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;                  // idempotent — double-release must not under-count
      released = true;
      const c = _inFlightFor(adminId);
      const n = { count: Math.max(0, c.count - 1), bytes: Math.max(0, c.bytes - size) };
      if (n.count === 0 && n.bytes === 0) _stagingInFlight.delete(adminId);
      else _stagingInFlight.set(adminId, n);
      releaseGlobal();
    },
  };
}

/**
 * ext-audit v7.15.13 — PRE-MULTER gate.
 *
 * Every budget check above runs after `uploadAttachment.single("file")`, i.e.
 * after multer has already streamed the whole body to disk — so the bytes we
 * are deciding about are on the filesystem before we decide. That is backwards
 * when the reason for refusing is that the filesystem is full.
 *
 * This middleware runs BEFORE multer and refuses using the DECLARED
 * Content-Length. The declared length is client-controlled, so it is not a
 * security boundary — multer's own 64 MB limit and the post-multer reservation
 * (which uses the REAL size) remain the enforcement. What this buys is that an
 * honest request that cannot possibly be accepted is refused without writing
 * anything, which is exactly the low-disk case.
 *
 * @param {(req) => string} adminIdOf — how to derive the acting admin from req.
 */
function preflightAttachmentBudget(adminIdOf) {
  return (req, res, next) => {
    // ext-audit v7.15.15 — RESERVE, do not merely check.
    //
    // v7.15.13/14 checked free space and per-admin/global quota here and then
    // let multer stream the body, taking the real reservation only afterwards.
    // Checking without reserving is the same check-then-act defect that
    // v7.15.11 fixed for staging, reintroduced one layer earlier: N concurrent
    // uploads all measured the same state and all passed, so 30 × 64 MB could
    // write ~1.9 GB through a gate meant to hold a 1 GB floor.
    //
    // The reservation below is taken against the DECLARED size (or multer's
    // maximum when the request is chunked and declares none) and is swapped for
    // one against the REAL size by the route handler once multer has finished.
    // Held reservations are conservative — they can over-count a request that
    // declares more than it sends, which is the safe direction.
    // A chunked upload declares no length. Skipping the gate entirely would make
    // `Transfer-Encoding: chunked` a way around it, so fall back to assuming the
    // largest body multer would accept — if there is not room for THAT, there is
    // no point streaming it to disk to find out.
    const declaredRaw = parseInt(req.headers["content-length"], 10);
    const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : ATTACHMENT_MAX_BYTES;
    let adminId = "";
    try { adminId = adminIdOf(req) || ""; } catch (_) { adminId = ""; }
    let err = _checkAttachmentStorageBudget(adminId, declared, _inFlightFor(adminId));
    if (!err) {
      // The global ceiling is the condition this gate most needs to catch early
      // — server-wide staging pressure is exactly when you don't want to write
      // the body first. _checkAttachmentStorageBudget knows only the per-admin
      // quota, so apply the global one here too.
      const committedAll = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM task_attachments_staging").get().bytes;
      if (committedAll + _stagingInFlightGlobalBytes + declared > ATTACHMENT_STAGING_MAX_BYTES_GLOBAL) {
        const cap = Math.round(ATTACHMENT_STAGING_MAX_BYTES_GLOBAL / (1024 * 1024));
        err = { status: 507, error: `Server-wide upload quota exceeded (${cap} MB). Ask other admins to finish or discard pending uploads, then try again.` };
      }
    }
    if (!err) {
      const held = reserveAttachmentBudget(adminId, declared);
      if (!held.ok) {
        err = { status: held.status, error: held.error };
      } else {
        // The handler swaps this for a real-size reservation; this listener is
        // the backstop for every path that never reaches the handler (a multer
        // error, a client abort, a thrown middleware). release() is idempotent,
        // so an early explicit release plus this one cannot under-count.
        req._attachPreflightRelease = held.release;
        const _auto = () => { try { held.release(); } catch (e) { swallowed("attachments:preflight-release", e); } };
        res.on("finish", _auto);
        res.on("close", _auto);
        return next();
      }
    }
    if (!err) return next();
    refuseBeforeBody(req, res, err.status, { error: err.error });
  };
}

function _checkAttachmentStorageBudget(adminId, incomingFileSize, inFlight) {
  // ext-audit v7.15.12 — check BOTH filesystems. Temp uploads land in
  // UPLOADS_DIR and the durable copy in DATA_DIR, and docker-compose mounts
  // those as SEPARATE volumes — so checking only DATA_DIR let the upload
  // filesystem fill while the check reported plenty of room. Whichever is
  // tighter governs. (When they are the same mount this is one extra statfs.)
  // ext-audit v7.15.14 — the floor must account for the bytes we are about to
  // add AND those already in flight. Comparing raw free space against a 1 GB
  // floor answers "is there room now", not "will there still be room once this
  // upload and its concurrent siblings have landed" — so N simultaneous 64 MB
  // uploads each saw the same healthy reading and collectively crossed it.
  const projected = Math.max(0, incomingFileSize || 0) + _stagingInFlightGlobalBytes;
  for (const dir of [DATA_DIR, UPLOADS_DIR]) {
    const disk = _freeSpaceBytes(dir);
    if (disk && (disk.free - projected) < ATTACHMENT_FREE_DISK_MIN_BYTES) {
      return { status: 507, error: "Server storage is too low to accept new uploads. Try again later." };
    }
  }
  if (!adminId) return null;
  const committed = db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS bytes FROM task_attachments_staging WHERE admin_id=?"
  ).get(adminId);
  // Committed rows PLUS uploads already accepted and still being processed.
  const fly = inFlight || { count: 0, bytes: 0 };
  const row = { c: committed.c + fly.count, bytes: committed.bytes + fly.bytes };
  if (row.c >= ATTACHMENT_STAGING_MAX_PER_ADMIN) {
    return { status: 429, error: `You have ${row.c} staged attachments pending — finish or discard some before uploading more (limit: ${ATTACHMENT_STAGING_MAX_PER_ADMIN}).` };
  }
  if ((row.bytes + Math.max(0, incomingFileSize)) > ATTACHMENT_STAGING_MAX_BYTES_PER_ADMIN) {
    const cap = Math.round(ATTACHMENT_STAGING_MAX_BYTES_PER_ADMIN / (1024 * 1024));
    return { status: 413, error: `Per-admin staging quota exceeded (${cap} MB). Discard some pending uploads and try again.` };
  }
  return null;
}

// Checkmarx hardening (v7.7.19→v7.7.21) — every stored attachment relative path
// (task_attachments(_staging).storage_path) is resolved to its absolute on-disk
// path and asserted to stay strictly under DATA_DIR before it reaches any
// filesystem sink (read / unlink / copy / sendFile). Every storage_path is
// server-generated (a uuid() under a fixed attachments/ | attachments-staging/
// prefix), so a traversal is not reachable today; the containment check makes
// that invariant explicit + local at each sink and guards against a future
// writer regression.
//
// This used to live in a shared resolveAttachmentPath() helper, but Checkmarx's
// data-flow engine does NOT model sanitization that happens inside a called
// function — the taint propagated through the helper and the
// Absolute_Path_Traversal finding stayed open. As of v7.7.21 the
// `path.resolve(...)` + `.startsWith(base + path.sep)` containment guard is
// inlined LEXICALLY at every sink (the recognized SAST sanitizer pattern), so
// the helper is gone. Keep the guard inline when adding a new attachment sink —
// do not refactor it back into a helper.

module.exports = { preflightAttachmentBudget,
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_TASK, ATTACHMENT_STAGING_MAX_PER_ADMIN,
  ATTACHMENT_FREE_DISK_MIN_BYTES, ATTACHMENT_MIME_ALLOW,
  validateUnencryptedZip, _unlinkAttachmentTempSync, _streamSha256,
  _attachmentValidationMessage, _slugForDownload, fileNameSlug, reserveAttachmentBudget,
};
