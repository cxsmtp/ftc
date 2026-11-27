"use strict";

// THE BACKUPS THE APP CAN SEE (Settings → About & health).
//
// Backups are written OUTSIDE the app, by the host (deploy/podman/install.sh's
// backup before every start, or scripts/backup.sh), so the app sees them only
// where the operator mounts that folder into it, read-only, and names it in
// BACKUP_DIR (the Podman installer mounts /srv/<app>/backups at /app/backups).
// Each backup is a directory; a finished one holds BACKUP_COMPLETE, the last
// file either writer creates. The status says only coarse facts, never a path or
// a file name: how many there are, when the newest finished, whether it did, and
// (for the caller to give a superadmin only) its size. Read on each request: the
// folder changes under the app, and the walk is bounded.

const fs = require("fs");
const path = require("path");
const { swallowed } = require("./best-effort");

const BACKUP_DIR = String(process.env.BACKUP_DIR || "").trim() || null;
// A newest backup's size is summed over at most this many entries; past it the
// size is a floor (`newest_size_exact: false`), so a backup holding many
// attachments cannot hold the request thread.
const SIZE_WALK_MAX = 20000;

function _walkSize(dir) {
  let bytes = 0, seen = 0, exact = true;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { swallowed("backup-status:walk", e); exact = false; continue; }
    for (const e of ents) {
      if (++seen > SIZE_WALK_MAX) return { bytes, exact: false };
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; } catch (err) { swallowed("backup-status:stat", err); exact = false; } }
    }
  }
  return { bytes, exact };
}

/**
 * `{visible:false, reason}` (`not_configured`: no BACKUP_DIR; `unreadable`: it
 * cannot be listed) or `{visible:true, count, newest_at, newest_complete,
 * newest_size_mib, newest_size_exact}` (`newest_*` null when there is none).
 */
function backupStatus(dir = BACKUP_DIR) {
  if (!dir) return { visible: false, reason: "not_configured" };
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { swallowed("backup-status:list", e); return { visible: false, reason: "unreadable" }; }
  const backups = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    // complete: true (finished), false (no marker: interrupted or still being
    // written), null (the backup cannot be looked into).
    let at = null, complete = false;
    try { at = fs.statSync(path.join(p, "BACKUP_COMPLETE")).mtimeMs; complete = true; }
    catch (err) {
      if (err.code !== "ENOENT") { complete = null; swallowed("backup-status:marker", err); }
      try { at = fs.statSync(p).mtimeMs; } catch (err2) { swallowed("backup-status:dir", err2); }
    }
    if (at !== null) backups.push({ p, at, complete });
  }
  backups.sort((a, b) => b.at - a.at);
  const newest = backups[0] || null;
  const size = newest ? _walkSize(newest.p) : null;
  return {
    visible: true,
    count: backups.length,
    newest_at: newest ? new Date(newest.at).toISOString() : null,
    newest_complete: newest ? newest.complete : null,
    newest_size_mib: size ? Math.round(size.bytes / (1024 * 1024) * 10) / 10 : null,
    newest_size_exact: size ? size.exact : null,
  };
}

module.exports = { backupStatus, BACKUP_DIR, SIZE_WALK_MAX };
