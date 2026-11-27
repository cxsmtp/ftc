"use strict";

// Orphaned image sweep. The `images` table holds every picture the platform has
// stored (lib/sanitise.js: an avatar upload, each image pasted into a
// challenge's description, explanation or hint; earlier certificates' share
// PNGs), and nothing deleted a row once the text that named it changed: an image
// edited out of a description, an avatar replaced while a second account still
// named it, an import or save refused after its images were stored. This sweep
// reclaims rows NOTHING references.
//
// WHAT COUNTS AS A REFERENCE. An image is reached two ways:
//   * by PATH, `/api/images/<uuid>`, inside stored text (rich text, an avatar,
//     the JSON of a version snapshot or a frozen team board). Each such column is
//     listed under `scan` below;
//   * by bare ID: `achievement_badges.image_id` (a certificate's stored share
//     PNG, served by routes/badge.js `_storedBadgePng`), listed under `ids`.
// EVERY text or blob column of every table is a decision, recorded in
// lib/image-refs.js: scanned, an id holder, or exempt with its reason. A test reads the schema of a
// booted database and fails on a column with no decision and on an entry naming
// a column that no longer exists (tests/image-sweep.spec.js), so a new column
// that can carry a picture cannot be forgotten. Scanning a column that never
// holds one only keeps an image longer; exempting one that does deletes a
// picture somebody sees, so a doubtful column is scanned.
//
// THE PASS IS ONE SYNCHRONOUS RUN, on purpose. The references are collected and
// the unreferenced rows deleted with no await between them, so no request can
// move a reference from a row not yet read to one already read while the sweep
// is collecting (one process, one connection: *Architecture*). That is NOT a
// bound on its cost: once any stored image is past the grace period (an avatar
// or a challenge picture in use is, a week after it was stored), every pass
// reads every scanned column in full (`LIKE '%/api/images/%'`, filtered by SQLite
// in C and streamed, but a leading-% LIKE uses no index), task_versions.snapshot
// included, which grows with every challenge save. No sound cheap exit was found:
// an image proven referenced may be unreferenced by the next pass, and asking
// image by image costs a full scan per image. So the pass measures its reference
// collection (`images_refs_ms`, `images_refs_rows` in its result) and logs a
// warning above IMAGE_REFS_WARN_MS; the cost at scale is unmeasured (CLAUDE.md,
// *Known open gaps*). `limit` bounds only the DELETEs: at most that many images
// go per run, oldest first in batches of DELETE_BATCH, the rest on the next pass.
//
// IT RUNS ONLY WHILE THE INSTANCE IS IN SERVICE (lib/event-retention.js passes
// server.js `_instanceInService` as `isHealthy`; no predicate holds it): its
// safety rests on reading every holder in full, which a database that failed its
// integrity check cannot promise, and a copied or restored database started in
// maintenance must not lose pictures before the operator has looked at it.
//
// THE GRACE PERIOD (7 days) is for saves in flight: a challenge save stores its
// images before the row that names them commits (attachments are awaited in
// between), and a profile save stores an avatar just before its UPDATE. Nothing
// younger than the grace is ever a candidate.
//
// Direction: image-sweep → { db, best-effort, image-refs } (plus a lazy log). Required lazily by
// lib/event-retention.js, whose daily pass (and POST /api/test/purge-events)
// runs it.

const db = require("../db");
const { swallowed } = require("./best-effort");
const { imageRefDecisions, IMAGE_REF_HOLDERS, IMAGE_REF_EXEMPT_REASONS } = require("./image-refs");

const IMAGE_SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_PURGE_MAX_PER_RUN = 500; // rows are blobs (up to 8 MB each): a far lower cap than the event tables'
const DELETE_BATCH = 100;
// A reference collection slower than this is logged at warn: the whole pass holds
// the event loop, and nothing else measures it.
const IMAGE_REFS_WARN_MS = 1000;

// Case-INSENSITIVE, as everything else that reads a path is (the LIKE pre-filter
// below and imageIsReferenced, Express's routing of GET /api/images/:id), so a
// link typed `/API/Images/<id>` counts; the id is kept as written (an older
// certificate's id is case-sensitive base64url), and `add` also records it lower
// case. The id class is the rich-text sanitiser's own ([\w-], lib/sanitise.js
// _transformImg), so an id holding `_` is never read short.
const IMAGE_PATH_RE = /\/api\/images\/([\w-]+)/gi;
const _quote = (n) => `"${String(n).replace(/"/g, '""')}"`;

// Every image id something references, read in one pass. A holder that cannot be
// read THROWS: a reference set missing a holder would delete what it names, so
// the caller stops the sweep rather than delete on a partial set.
function collectReferencedImageIds(conn = db) {
  const refs = new Set();
  const add = (id) => { if (id) { refs.add(id); refs.add(String(id).toLowerCase()); } };
  let rowsRead = 0;
  for (const d of imageRefDecisions()) {
    if (d.kind === "scan") {
      const stmt = conn.prepare(`SELECT ${_quote(d.column)} AS v FROM ${_quote(d.table)} WHERE ${_quote(d.column)} LIKE '%/api/images/%'`);
      for (const r of stmt.iterate()) {
        rowsRead++;
        const s = typeof r.v === "string" ? r.v : (Buffer.isBuffer(r.v) ? r.v.toString("utf8") : String(r.v));
        for (const m of s.matchAll(IMAGE_PATH_RE)) add(m[1]);
      }
    } else if (d.kind === "ids") {
      const stmt = conn.prepare(`SELECT ${_quote(d.column)} AS v FROM ${_quote(d.table)} WHERE ${_quote(d.column)} IS NOT NULL AND ${_quote(d.column)} <> ''`);
      for (const r of stmt.iterate()) { rowsRead++; add(String(r.v)); }
    }
  }
  return { refs, rowsRead };
}

// Does anything still name this one image? The per-image form of the pass above,
// over the same manifest, for a reclaim made at once (lib/sanitise.js
// deleteAvatarImage, when an avatar is replaced). A holder that cannot be read
// answers true: keep the image.
function imageIsReferenced(imgId, conn = db) {
  const id = String(imgId || "");
  // `_` is a LIKE wildcard, so an id holding one matches more than itself: the
  // answer can only err towards keeping.
  if (!/^[\w-]+$/.test(id)) return true;
  const pattern = `%/api/images/${id}%`;
  for (const d of imageRefDecisions()) {
    try {
      if (d.kind === "scan" && conn.prepare(`SELECT 1 FROM ${_quote(d.table)} WHERE ${_quote(d.column)} LIKE ? LIMIT 1`).get(pattern)) return true;
      if (d.kind === "ids" && conn.prepare(`SELECT 1 FROM ${_quote(d.table)} WHERE ${_quote(d.column)} = ? LIMIT 1`).get(id)) return true;
    } catch (e) { swallowed("image-sweep:holder-unreadable", e, { level: "warn" }); return true; }
  }
  return false;
}

// One sweep. opts: { nowMs, graceMs, limit, refsWarnMs } (the last overrides
// IMAGE_REFS_WARN_MS: the test hook's way to see the warning). Returns
// { images_purged, images_purged_ids, images_capped, images_refs_ms,
// images_refs_rows }: `images_purged_ids` the ids the DELETEs removed (at most
// `limit`), which lib/event-retention.js writes into its `events_purged` record
// so an operator can tell which pictures went and restore one from a backup; the
// last two are the reference collection's wall time (ms, the event loop held
// throughout) and the holder rows it read, both 0 when no image was past the
// grace period.
function sweepOrphanedImages(opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const graceMs = opts.graceMs != null ? opts.graceMs : IMAGE_SWEEP_GRACE_MS;
  const limit = opts.limit != null ? opts.limit : IMAGE_PURGE_MAX_PER_RUN;
  const warnMs = typeof opts.refsWarnMs === "number" ? opts.refsWarnMs : IMAGE_REFS_WARN_MS;
  const cutoffIso = new Date(nowMs - graceMs).toISOString();
  const out = { images_purged: 0, images_purged_ids: [], images_capped: false, images_refs_ms: 0, images_refs_rows: 0 };
  // Ids only, through idx_images_created (created_at, id): no blob is read.
  const old = db.prepare("SELECT id FROM images WHERE created_at < ? ORDER BY created_at ASC, id ASC").all(cutoffIso);
  if (!old.length || !(limit > 0)) return out;
  const t0 = process.hrtime.bigint();
  const { refs, rowsRead } = collectReferencedImageIds();
  out.images_refs_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  out.images_refs_rows = rowsRead;
  if (out.images_refs_ms > warnMs) {
    try { require("./log").log.warn({ tag: "image-sweep", images_refs_ms: out.images_refs_ms, images_refs_rows: rowsRead, threshold_ms: warnMs },
      "image sweep: collecting the image references held the event loop longer than its threshold"); }
    catch (e) { swallowed("image-sweep:slow-refs-log", e); }
  }
  const orphans = [];
  for (const { id } of old) {
    if (refs.has(id) || refs.has(String(id).toLowerCase())) continue;
    if (orphans.length >= limit) { out.images_capped = true; break; }
    orphans.push(id);
  }
  // The age is re-asserted in the DELETE, so a row's timestamp is the bound
  // whatever the list says; RETURNING names exactly the rows that went.
  const del = db.prepare("DELETE FROM images WHERE id IN (SELECT value FROM json_each(?)) AND created_at < ? RETURNING id");
  for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
    const batch = orphans.slice(i, i + DELETE_BATCH);
    try {
      const gone = db.transaction(() => del.all(JSON.stringify(batch), cutoffIso).map(r => r.id))();
      out.images_purged += gone.length;
      out.images_purged_ids.push(...gone);
    }
    catch (e) { swallowed("image-sweep:delete-batch", e, { level: "warn" }); break; }
  }
  return out;
}

module.exports = {
  sweepOrphanedImages, collectReferencedImageIds, imageIsReferenced, imageRefDecisions,
  IMAGE_REF_HOLDERS, IMAGE_REF_EXEMPT_REASONS,
  IMAGE_SWEEP_GRACE_MS, IMAGE_PURGE_MAX_PER_RUN, IMAGE_REFS_WARN_MS,
};
