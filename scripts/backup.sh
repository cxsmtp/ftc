#!/usr/bin/env bash
# Hack Arena — atomic backup of the platform's SQLite databases.
#
# Why this script exists:
#   The platform stores everything in ONE SQLite file under DATA_DIR/
#     - hackathon.db   (users, competitions, tasks, submissions, *_events,
#                       AND the express_session session store — there is no
#                       separate sessions.db file)
#   plus an `attachments/` directory of admin-uploaded ZIPs and
#   `logs/`. A naive `cp` of hackathon.db while the server is writing
#   produces a torn copy: a copy that mid-statement, with WAL frames
#   that don't match the main file. This script uses SQLite's online-
#   backup API (`.backup` command) which holds a read lock for the
#   duration of the copy and produces a consistent snapshot even
#   while the server is running. The attachment files are copied before
#   and after that snapshot and then checked against the files it names
#   (see "THE SNAPSHOT AND THE FILES IT NAMES" below); logs are copied once.
#
# Usage:
#   DATA_DIR=<data-dir> scripts/backup.sh [output-dir] [--reuse]
#
#   e.g. on the bundled docker-compose host, as root:
#     sudo DATA_DIR=/opt/hackarena/data scripts/backup.sh
#
# DATA_DIR is REQUIRED (no default) — see "DATA_DIR" below. Put it AFTER `sudo`:
# sudo resets the environment, so an exported DATA_DIR, or one written in front
# of `sudo`, never reaches the script and it refuses.
#
# Requires the `sqlite3` CLI on PATH (checked below). Note the shipped
# container does NOT contain it — the runtime stage is a bare node:*-alpine —
# so run this on the HOST against the mounted data volume, not with
# `docker exec`.
#
# If `output-dir` is omitted the script writes to <repo>/backups/<UTC-timestamp>/
# — beside the checkout this script lives in, whatever the current directory.
# On a docker-compose host that checkout is the image's build context, which is
# why .dockerignore is an allow-list (v8.13.3): a default backup holds the live
# database and both HMAC secrets, and must never ride into the next image.
# Every backup is a self-contained directory you can `tar czvf` and ship
# off-host. The online-backup format is bit-identical to a regular SQLite
# file so `sqlite3 path/hackathon.db` works on the backup directly for
# inspection.
#
# ---------------------------------------------------------------------------
# RESTORING: DELETE hackathon.db-wal AND hackathon.db-shm. THIS IS NOT OPTIONAL.
# ---------------------------------------------------------------------------
# A `.backup` snapshot is fully checkpointed and carries no WAL of its own. If
# you drop it onto a data directory that still has the OLD -wal / -shm beside
# it, SQLite replays those stale frames on top of the file you just restored:
# the post-backup writes come back, and `PRAGMA integrity_check` still reports
# `ok`, so nothing tells the operator the restore did not take. Measured: a
# snapshot holding 1 row restored to 201 rows this way.
#
# A CLEAN shutdown checkpoints and removes both files, so the hazard is
# invisible in a rehearsal that stops the server politely — and live exactly
# when you actually need a restore, because an unclean stop (kill -9, OOM,
# power loss, the 20-second shutdown watchdog firing) is what leaves them
# behind. `RESTORE.txt` is written into every backup directory with the
# correct sequence, because whoever restores is often not whoever read the
# README.
#
#   sudo systemctl stop hackarena          # or: docker compose down
#   rm -f <DATA_DIR>/hackathon.db-wal <DATA_DIR>/hackathon.db-shm
#   rsync -a --delete <backup-dir>/ <DATA_DIR>/
#   DATA_DIR=<DATA_DIR> scripts/restore-mail.sh mark-sent   # or: resend (the email choice)
#   chown -R <owner> <DATA_DIR>            # data_dir_owner in BACKUP_METADATA.txt
#   sudo systemctl start hackarena
#
# The chown is not optional when the backup or the restore ran as root: rsync -a
# copies ownership, and a data directory left owned by root is one the server's
# own user (uid 1000 in the shipped image) cannot write — it does not come up.
#
# (`rsync --delete` also removes them for you, since they are absent from the
# backup — the explicit `rm` is belt-and-braces and makes a `cp`-based restore
# safe too.) <DATA_DIR> is a placeholder, not a shell variable: pasted into a
# shell where DATA_DIR is unset (any `sudo` shell), a "$DATA_DIR"/ in that rsync
# line expands to `/`. RESTORE.txt carries the real, absolute path instead.
#
# DATA_DIR — REQUIRED, and nothing is guessed (v8.13.4, operator decision). Until
# then this script fell back to <repo>/data, the directory beside the checkout it
# lives in. That was a guess about where the live volume is, and on a host whose
# checkout holds or links the live data directory it is the live volume; the
# server has refused the same guess since v8.8.26 (lib/data-dir.js). Unset or
# empty, the script stops with an ERROR naming the variable BEFORE it creates,
# clears or reads anything; a value that is not a directory is refused the same
# way. The value is then resolved to an ABSOLUTE path, CDPATH-safely, because
# RESTORE.txt bakes it into an `rm -f` and an `rsync -a --delete`: a relative
# `DATA_DIR=./data` would otherwise send a later restore to whatever ./data is in
# the restorer's working directory.

# ---------------------------------------------------------------------------
# COVERAGE MANIFEST — every DATA_DIR-resident path the codebase declares must
# appear below as either COVERS (this script copies it) or EXEMPT (deliberately
# left out, with the reason). A Docs-hygiene test extracts the
# `path.join(DATA_DIR, "…")` literals from server.js / db.js / lib / routes and
# fails if any is missing here, so adding a new file under DATA_DIR forces a
# decision instead of silently falling out of the backup. That is not
# hypothetical: `attachments-staging` was added in the attachment-staging work
# and went unbacked-up until v7.21.34.
#
#   BACKUP_COVERS: hackathon.db
#   BACKUP_COVERS: attachments
#   BACKUP_COVERS: attachments-staging
#   BACKUP_COVERS: logs
#   BACKUP_COVERS: .unsubscribe-secret
#   BACKUP_COVERS: .grading-secret
#   BACKUP_EXEMPT: .superadmin-password — regenerated on every boot; a restored
#                  one would be stale and would mislead the operator.
#   BACKUP_EXEMPT: .maintenance — restoring a maintenance gate would 503 users
#                  on the way back up.
# ---------------------------------------------------------------------------

set -euo pipefail

# ROOT_DIR is the checkout this script lives in. It names the DEFAULT OUTPUT
# directory and version.json, and nothing else — never the data directory.
# `CDPATH=` and `--` on every cd below: with CDPATH exported, a bare relative
# name is looked up through it first, may land in a DIFFERENT directory, and
# cd prints the path, so the captured value becomes two lines (measured).
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

# v8.13.4 (operator decision) — DATA_DIR IS REQUIRED. NOTHING IS GUESSED.
# `${DATA_DIR:-}` rather than a bare `$DATA_DIR`: under `set -u` the bare form
# aborts on an UNSET value with bash's own "unbound variable", which names
# nothing an operator can act on. (An EMPTY value is refused by either form.)
# This block is above every check that reads the volume and above the first
# mkdir, so a refusal writes nothing.
if [[ -z "${DATA_DIR:-}" ]]; then
  echo "ERROR: DATA_DIR is required — the data directory to back up (the volume holding hackathon.db)." >&2
  echo "       There is deliberately no default: a path guessed from where this script sits is, on a" >&2
  echo "       host whose checkout holds or links the live data directory, the live volume — and the" >&2
  echo "       server refuses the same guess (lib/data-dir.js, v8.8.26)." >&2
  echo "       e.g.  sudo DATA_DIR=/opt/hackarena/data scripts/backup.sh [output-dir]" >&2
  echo "       Put DATA_DIR AFTER sudo: sudo resets the environment, so an exported DATA_DIR, or" >&2
  echo "       'DATA_DIR=... sudo scripts/backup.sh', never reaches this script." >&2
  echo "       Cron reads no shell profile either: write DATA_DIR into the crontab line itself." >&2
  exit 1
fi
if [[ ! -d "$DATA_DIR" ]]; then
  echo "ERROR: DATA_DIR is not a directory: $DATA_DIR" >&2
  exit 1
fi
# Absolute, so RESTORE.txt names the volume wherever it is read from (header).
# Into a temporary first: a failed substitution would otherwise blank DATA_DIR
# before the error message could name it. PHYSICAL (-P), not logical: when
# DATA_DIR is a symlink to the volume — this repo's own ./data is one — the
# logical path makes the owner recorded below the LINK's, and the restore's
# `chown -R` changes only the link (GNU chown -R does not follow a symlink named
# on its command line), leaving the restored database unwritable (v8.13.4
# fix-delta review).
_ABS_DATA_DIR="$(CDPATH= cd -P -- "$DATA_DIR" && pwd -P)" || {
  echo "ERROR: cannot enter DATA_DIR: $DATA_DIR" >&2
  exit 1
}
DATA_DIR="$_ABS_DATA_DIR"
# v8.13.4 review — the data directory's OWNER, recorded for the restore. The
# documented runner is root (sudo, root's crontab), and a root `rsync -a` restore
# copies the backup's ownership onto the data directory: everything becomes
# root's, the shipped image's `node` user (uid 1000) can no longer write its
# own database, and the restored platform does not come back up (measured:
# SQLITE_READONLY at the WAL pragma). RESTORE.txt hands it back to this owner.
DATA_OWNER="$(stat -L -c '%u:%g' "$DATA_DIR" 2>/dev/null || stat -L -f '%u:%g' "$DATA_DIR" 2>/dev/null || true)"
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 CLI not found on PATH. Install via your OS package manager (apt/brew/yum)." >&2
  exit 1
fi
# v8.11.1 (external audit F8) — REFUSE BEFORE ANYTHING IS CREATED OR CLEARED.
#
# The database loop below used to `echo WARN ... ; continue` on a missing source
# and fall through to every remaining step, so a run against an unmounted or
# empty volume wrote BACKUP_COMPLETE, exited 0, and produced a directory holding
# only logs, secrets and metadata. That marker is not decoration: the RESTORE.txt
# this same script writes tells the operator to check it before restoring, and
# the restore is `rsync -a --delete` — so the certified empty backup WIPES the
# live volume, the app then recreates an empty schema, `/readyz` answers ready
# and `PRAGMA integrity_check` says ok. Nothing anywhere reports a problem.
# README recommends running this from cron/systemd, where stdout is discarded
# and the exit code is the only signal, so the WARN was invisible by design.
#
# `-s`, NOT `-f`: a zero-byte hackathon.db passes `-f`, and sqlite3 `.backup`
# then succeeds on it and produces a valid, empty, 0-table database — the same
# certified-empty backup by another route, and self-perpetuating, because the
# boot after that restore recreates a schema the NEXT backup snapshots happily.
#
# ABOVE `mkdir -p "$OUT_DIR"` and above the `rm -f BACKUP_COMPLETE` below, which
# is load-bearing twice: a failed run leaves no empty timestamped directory for a
# daily cron to accrete, and a `--reuse` run against a volume that has since
# unmounted does not strip the marker off the last GOOD backup it was pointed at.
if [[ ! -s "$DATA_DIR/hackathon.db" ]]; then
  echo "ERROR: no database at $DATA_DIR/hackathon.db (missing or empty)." >&2
  echo "       Refusing to write a backup with no database — a directory that" >&2
  echo "       carries BACKUP_COMPLETE and no data is worse than no backup," >&2
  echo "       because restoring it deletes the live volume." >&2
  echo "       Check DATA_DIR is correct and the data volume is mounted." >&2
  exit 1
fi

# Output directory. Default = <repo>/backups/YYYY-MM-DDTHH-MM-SSZ/ (not the cwd).
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT_DIR="${1:-$ROOT_DIR/backups/$TIMESTAMP}"
mkdir -p "$OUT_DIR"
# Absolute for the DATA_DIR reason: RESTORE.txt names this directory as the
# rsync SOURCE, and a relative one means nothing to a restorer standing elsewhere.
OUT_DIR="$(CDPATH= cd -- "$OUT_DIR" && pwd)"

# v8.3.20 (external audit) — A BACKUP DIRECTORY IS WRITTEN ONCE, AND SAYS WHEN
# IT IS FINISHED.
#
# Two defects, both about a destination that already holds a backup. The output
# is written straight into its final location with no completion marker, so an
# interrupted run — a full disk, a failed copy, a Ctrl-C, under `set -e` —
# left a directory carrying a FRESH database beside the PREVIOUS
# run's logs and metadata, indistinguishable from a good backup. And because
# nothing deletes, a second run into the same destination RESURRECTS files the
# retention purge had removed and accretes attachments deleted since.
#
# Refusing a non-empty destination kills both at the root, rather than patching
# each symptom. It is strictly better than adding `--delete` to the rsyncs,
# which was the obvious fix and was DANGEROUS on the premise that held until
# v8.11.1: the missing-database branch only WARNed and continued, so a run
# against an unmounted or fresh volume sailed through and `--delete` would then
# wipe the only good copy of the attachments while leaving the old database in
# place — converting a non-destructive accretion defect into a data-destroying
# one. External audit F8 removed that premise: such a run now REFUSES before
# anything is created. `--delete` on the backup-side rsyncs is still not adopted
# — it was rejected on its own terms too — but the reason quoted here no longer
# applies, and saying so is the point of correcting it rather than deleting it.
#
# The default path is a per-second UTC timestamp, so this never fires on the
# documented workflow; it only stops a hand-supplied destination being reused.
if [[ -e "$OUT_DIR/hackathon.db" || -e "$OUT_DIR/BACKUP_METADATA.txt" ]] && [[ "${2:-}" != "--reuse" ]]; then
  echo "ERROR: $OUT_DIR already holds a backup." >&2
  echo "       Each backup is a self-contained directory. Pass a fresh path (the" >&2
  echo "       default <repo>/backups/<UTC-timestamp>/ is already unique), or pass" >&2
  echo "       --reuse as the second argument to overwrite this one in place." >&2
  exit 1
fi
# Clear any completion marker BEFORE writing anything, so an aborted run leaves
# a directory that visibly is not finished. Written at the very end on success.
rm -f "$OUT_DIR/BACKUP_COMPLETE"

echo "Hack Arena backup"
echo "  DATA_DIR : $DATA_DIR"
echo "  OUT_DIR  : $OUT_DIR"
echo "  TIMESTAMP: $TIMESTAMP"

# ---------------------------------------------------------------------------
# THE SNAPSHOT AND THE FILES IT NAMES
# ---------------------------------------------------------------------------
# The database is snapshotted at one instant, the attachment files are copied
# over a stretch of time, and the server keeps working in between. A challenge
# delete commits its row deletion and THEN unlinks its files
# (routes/challenges.js), so a single copy taken after the snapshot could miss a
# file the snapshot still names — and the run used to certify that backup
# (measured: exit 0, BACKUP_COMPLETE, integrity ok, a referenced ZIP absent).
# Copying first and snapshotting second only moves the gap onto uploads, because
# every file is written before its row.
#
# So, per attempt: copy (A), snapshot, copy again (B), then RECONCILE the
# snapshot's own task_attachments rows against what landed here, by path and
# size. Every file the server writes is in place before its row commits and
# outlives the row, so a file the snapshot names existed at the snapshot
# instant: copy A holds it unless it was uploaded after A, and copy B holds it
# unless it was deleted after the snapshot. Only a file both uploaded and deleted
# inside one attempt escapes both; its row is then gone from the live database
# too, so the next attempt's snapshot no longer names it. BACKUP_MAX_ATTEMPTS
# bounds the retries, and running out of them refuses to certify.
#
# A referenced file the LIVE volume has also lost (its row still there) is not a
# race, and no retry can fix it. Nothing in the product removes such a row while
# its challenge has submissions, so refusing would end every future backup: it
# is counted instead (BACKUP_COMPLETE, BACKUP_METADATA.txt, stderr and syslog),
# and the backup is exactly as complete as the volume. The live file is checked
# for a row this backup does hold too: a --reuse directory keeps every file an
# earlier run copied, so a loss since then would pass as verified unreported.
# That file is reported the same way, marked as held here, and stays verified.
#
# attachments-staging/ is copied the same way but only REPORTED: its rows
# legitimately outlive their files (a promotion renames the file away before it
# deletes the row; the row sweep unlinks before it deletes), and the server
# expires every staging row within an hour anyway. Backup-side copies are never
# deleted (no --delete): files the snapshot does not name are reaped by the
# first boot after a restore.
#
# Every sqlite3 call whose output is read runs with `-init /dev/null -batch
# -noheader -list`: sqlite3 reads ~/.sqliterc (the passwd home's, /root's under
# sudo) even when handed SQL, and a `.echo on`, `.headers on` or `.mode box`
# there turns "1" into something else. Every such read is a plain assignment,
# so a sqlite3 error aborts under set -e, and its output is parsed strictly.
BACKUP_MAX_ATTEMPTS=3
SRC="$DATA_DIR/hackathon.db"
DST="$OUT_DIR/hackathon.db"
# The only storage_path shapes the server writes (attachments/<uuid>.zip and
# attachments-staging/<uuid>.zip; a SOURCE lock ties these to its generators).
# Anything else is refused: an unchecked `../x` would be "verified" outside this
# directory.
_ATT_RE='^attachments/[A-Za-z0-9][A-Za-z0-9._-]*$'
_STG_RE='^attachments-staging/[A-Za-z0-9][A-Za-z0-9._-]*$'
# Field separator for the row reads: the unit separator, which the path regex
# rejects. A stored value holding one, or a line break, shifts the fields, so a
# row read back with a surplus field or an unknown state is refused, and so is a
# read whose row count differs from the snapshot's COUNT(*).
_US=$'\x1f'

_incomplete_note() {
  echo "       $OUT_DIR is incomplete (no BACKUP_COMPLETE) and safe to delete." >&2
}

# rsync exit 24 ("some files vanished before they could be transferred") is a
# file the live server deleted mid-copy. Tolerated, because whether the backup is
# complete is decided by the reconcile below, not by rsync; every other non-zero
# status is returned, and set -e aborts with it.
_copy_tree() {
  local name="$1" when="$2" rc=0
  [[ -d "$DATA_DIR/$name" ]] || return 0
  echo "  copying $name/ ($when) ..."
  mkdir -p "$OUT_DIR/$name"
  rsync -a "$DATA_DIR/$name/" "$OUT_DIR/$name/" || rc=$?
  if [[ "$rc" -eq 24 ]]; then
    case "$name" in
      attachments|attachments-staging)
        echo "  ... files under $name/ were deleted on the live volume during the copy; checked below" ;;
      *)
        echo "  ... files under $name/ were deleted on the live volume during the copy" ;;
    esac
    return 0
  fi
  return "$rc"
}

_file_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null; }
# A regular file (not a link) of exactly the size the row records.
_file_is() { [[ -f "$1" && ! -L "$1" ]] && [[ "$(_file_size "$1")" == "$2" ]]; }
# Ids come from the database and may hold anything: never print them raw.
_safe_id() { local v="$1"; printf '%s' "${v//[^A-Za-z0-9._-]/?}"; }

# Online-backup the SQLite database. Requires the `sqlite3` CLI on
# PATH; better-sqlite3's .backup API is Node-side only. The CLI is
# universally available and produces bit-identical output to the API.
# Sessions live in the `express_session` table INSIDE hackathon.db (the
# store is constructed against the same connection in server.js) — there is
# no separate sessions.db file, so hackathon.db is the only DB to back up.
_snapshot_db() {
  for DB_NAME in hackathon.db; do
    # v8.11.1 (F8) — this was `WARN … ; continue`, the branch that let a
    # database-less run reach BACKUP_COMPLETE. The precondition above now refuses
    # that case before anything is created; this stays as defence in depth for a
    # source that vanishes between the two, and it FAILS rather than skipping.
    if [[ ! -s "$SRC" ]]; then
      echo "ERROR: $DB_NAME not found (or empty) at $SRC — refusing to continue." >&2
      exit 1
    fi
    echo "  backing up $DB_NAME ..."
    # The .backup command holds a read lock for the duration; concurrent
    # writers retry per SQLite's busy-handler. Adds a 30-s timeout so a
    # stuck write lock doesn't hang the script forever.
    sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$SRC" ".backup '$DST'"
    # v8.11.1 (F8) — and the SNAPSHOT is checked, not merely the source. `.backup`
    # exits 0 on an empty or truncated source, so verifying what actually landed is
    # what makes BACKUP_COMPLETE mean "the database is in here". One cheap read of
    # the copy; a real deployment has dozens of tables. Anything but a number —
    # an error, or output an rc file reshaped — refuses.
    _TABLES="$(sqlite3 -init /dev/null -batch -noheader -list "$DST" "SELECT COUNT(*) FROM sqlite_master" 2>/dev/null || echo 0)"
    if [[ ! "$_TABLES" =~ ^[0-9]+$ ]] || [[ "$_TABLES" -lt 1 ]]; then
      echo "ERROR: the $DB_NAME snapshot at $DST has no tables — refusing to certify it." >&2
      exit 1
    fi
    echo "  ... $DB_NAME snapshot verified ($_TABLES schema objects)"
  done
}

# Sets _VERDICT (ok | retry | refuse), _WHY (the refusal's reason) and the
# counts and lists below. Always returns 0, so set -e still governs every
# command inside; never call it as `x || y`, which suspends set -e in it.
_reconcile_attachments() {
  _VERDICT=ok; _WHY=""; _REF_COUNT=0; _LOST_COUNT=0; _LOST_HELD_COUNT=0; _LOST=""; _RACED=""; _UNRECOGNISED=""
  local has expected rows missing="" held="" rel size aid tid state extra live live_rows
  if [[ ! "$(_file_size "$DST" || true)" =~ ^[0-9]+$ ]]; then
    _VERDICT=refuse; _WHY="stat cannot report file sizes on this host, so no attachment can be checked"
    return 0
  fi
  has="$(sqlite3 -init /dev/null -batch -noheader -list "$DST" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_attachments'")"
  case "$has" in
    1) ;;
    # Absent only in a database the platform never wrote (its CREATE is fatal at
    # boot), such as a one-table fixture: nothing names an attachment.
    0) echo "  (the snapshot has no task_attachments table: no attachment references to check)"
       return 0 ;;
    *) _VERDICT=refuse; _WHY="the check for the snapshot's task_attachments table printed an unexpected answer"
       return 0 ;;
  esac
  expected="$(sqlite3 -init /dev/null -batch -noheader -list "$DST" "SELECT COUNT(*) FROM task_attachments")"
  if [[ ! "$expected" =~ ^[0-9]+$ ]]; then
    _VERDICT=refuse; _WHY="the snapshot's task_attachments row count was not a number"
    return 0
  fi
  rows="$(sqlite3 -init /dev/null -batch -noheader -list -separator "$_US" "$DST" \
    "SELECT storage_path, size_bytes, id, task_id, CASE WHEN detached_at IS NULL THEN 'attached' ELSE 'detached' END FROM task_attachments ORDER BY storage_path")"
  # Every line read counts, an empty one too (a stored value can begin with a
  # line break); only an empty result, which the here-string turns into one
  # empty line, has no rows to read.
  if [[ -n "$rows" ]]; then
    while IFS="$_US" read -r rel size aid tid state extra; do
      _REF_COUNT=$((_REF_COUNT + 1))
      # Every row counts, detached ones too: a version restore re-attaches them.
      if [[ -n "$extra" || ! "$rel" =~ $_ATT_RE || ! "$size" =~ ^[0-9]+$ ]] \
         || [[ "$state" != attached && "$state" != detached ]]; then
        _UNRECOGNISED+="    attachment=$(_safe_id "$aid") challenge=$(_safe_id "$tid")"$'\n'
        continue
      fi
      # THE LIVE FILE FIRST, THE LIVE ROW AFTER: a file found gone here was
      # unlinked after its row's deletion committed, so the row query below
      # cannot still see that row. The other order can mistake a race for a loss.
      live=gone; _file_is "$DATA_DIR/$rel" "$size" && live=present
      if _file_is "$OUT_DIR/$rel" "$size"; then
        [[ "$live" == present ]] || held+="$rel$_US$size$_US$aid$_US$tid$_US$state"$'\n'
        continue
      fi
      missing+="$rel$_US$size$_US$aid$_US$tid$_US$state$_US$live"$'\n'
    done <<< "$rows"
  fi
  if [[ -n "$_UNRECOGNISED" ]]; then
    _VERDICT=refuse; _WHY="the snapshot names attachment files by a path this script does not recognise (the platform writes only attachments/<name>)"
    return 0
  fi
  if [[ "$_REF_COUNT" -ne "$expected" ]]; then
    _VERDICT=refuse; _WHY="the snapshot holds $expected task_attachments rows but $_REF_COUNT were read back"
    return 0
  fi
  [[ -n "$missing" || -n "$held" ]] || return 0
  live_rows="$(sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$SRC" "SELECT storage_path FROM task_attachments")"
  # Held here, gone live: a loss only while the live row remains (else the race).
  while IFS="$_US" read -r rel size aid tid state; do
    [[ -n "$rel" ]] && grep -Fxq -- "$rel" <<< "$live_rows" || continue
    _LOST_COUNT=$((_LOST_COUNT + 1)); _LOST_HELD_COUNT=$((_LOST_HELD_COUNT + 1))
    _LOST+="  lost_on_live_volume: $rel size=$size attachment=$(_safe_id "$aid") challenge=$(_safe_id "$tid") ($state; this backup holds a copy)"$'\n'
  done <<< "$held"
  while IFS="$_US" read -r rel size aid tid state live; do
    [[ -n "$rel" ]] || continue
    if ! grep -Fxq -- "$rel" <<< "$live_rows"; then
      _RACED+="    $rel (deleted after the snapshot)"$'\n'
    elif [[ "$live" == present ]]; then
      _RACED+="    $rel (on the live volume, not yet copied)"$'\n'
    else
      _LOST_COUNT=$((_LOST_COUNT + 1))
      _LOST+="  lost_on_live_volume: $rel size=$size attachment=$(_safe_id "$aid") challenge=$(_safe_id "$tid") ($state)"$'\n'
    fi
  done <<< "$missing"
  [[ -z "$_RACED" ]] || _VERDICT=retry
  return 0
}

# Report only: staging rows legitimately outlive their files (header above).
_count_staging_without_file() {
  _STAGING_WITHOUT_FILE=0
  local has rows rel
  has="$(sqlite3 -init /dev/null -batch -noheader -list "$DST" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_attachments_staging'")"
  case "$has" in
    1) ;;
    0) return 0 ;;
    *) echo "ERROR: the check for the snapshot's task_attachments_staging table printed an unexpected answer." >&2
       echo "       Refusing to certify a backup this script could not read the way it expects." >&2
       _incomplete_note
       exit 1 ;;
  esac
  rows="$(sqlite3 -init /dev/null -batch -noheader -list "$DST" "SELECT storage_path FROM task_attachments_staging")"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    if [[ ! "$rel" =~ $_STG_RE || ! -f "$OUT_DIR/$rel" || -L "$OUT_DIR/$rel" ]]; then
      _STAGING_WITHOUT_FILE=$((_STAGING_WITHOUT_FILE + 1))
    fi
  done <<< "$rows"
}

_ATTEMPT=0
while :; do
  _ATTEMPT=$((_ATTEMPT + 1))
  _copy_tree attachments "before the snapshot"
  _copy_tree attachments-staging "before the snapshot"
  _snapshot_db
  _copy_tree attachments "after the snapshot"
  _copy_tree attachments-staging "after the snapshot"
  _reconcile_attachments
  case "$_VERDICT" in
    ok) break ;;
    refuse)
      echo "ERROR: $_WHY." >&2
      echo "       Refusing to certify a backup that cannot say whether its attachment files are in it." >&2
      printf '%s' "$_UNRECOGNISED" >&2
      _incomplete_note
      exit 1 ;;
    retry)
      if [[ "$_ATTEMPT" -lt "$BACKUP_MAX_ATTEMPTS" ]]; then
        echo "  NOTE: attachment files this snapshot names were not in this backup when it was checked;"
        echo "        taking a new snapshot (attempt $((_ATTEMPT + 1)) of $BACKUP_MAX_ATTEMPTS):"
        printf '%s' "$_RACED"
        continue
      fi
      echo "ERROR: after $BACKUP_MAX_ATTEMPTS snapshots, the latest still names attachment files that were not" >&2
      echo "       in this backup when it was checked:" >&2
      printf '%s' "$_RACED" >&2
      echo "       Refusing to certify a backup whose database names files it does not hold." >&2
      echo "       Run the backup again; attachments uploaded and deleted again while it ran are the usual cause." >&2
      _incomplete_note
      exit 1 ;;
    *)
      echo "ERROR: the attachment check reached no verdict — refusing to certify." >&2
      _incomplete_note
      exit 1 ;;
  esac
done
_count_staging_without_file
# A file lost on the live volume that this backup holds is still in it.
_LOST_GONE=$((_LOST_COUNT - _LOST_HELD_COUNT))
_VERIFIED=$((_REF_COUNT - _LOST_GONE))
echo "  ... attachments: $_REF_COUNT referenced, $_VERIFIED in this backup, $_LOST_COUNT lost on the live volume itself"
if [[ "$_LOST_COUNT" -gt 0 ]]; then
  echo "WARNING: $_LOST_COUNT attachment file(s) the database references are missing or damaged on the live" >&2
  echo "         volume itself ($DATA_DIR). Listed in BACKUP_METADATA.txt:" >&2
  printf '%s' "$_LOST" >&2
  if [[ "$_LOST_GONE" -gt 0 ]]; then
    echo "         $_LOST_GONE of them are not in this backup either, so a restore brings back the same gap." >&2
    echo "         An earlier backup may still hold them: copy each one back into $DATA_DIR/attachments/" >&2
    echo "         from the newest backup that has it at the listed size, before retention deletes that backup." >&2
  fi
  if [[ "$_LOST_HELD_COUNT" -gt 0 ]]; then
    echo "         This backup still holds a copy of $_LOST_HELD_COUNT of them (marked so above): copy each one back" >&2
    echo "         into $DATA_DIR/attachments/ from $OUT_DIR/attachments/." >&2
  fi
  if [[ "$_LOST_HELD_COUNT" -eq 0 ]]; then
    _HINT="copy them back from an earlier backup before retention deletes it"
  elif [[ "$_LOST_GONE" -eq 0 ]]; then
    _HINT="this backup holds a copy of each: copy them back from it"
  else
    _HINT="this backup holds a copy of $_LOST_HELD_COUNT; copy the rest back from an earlier backup before retention deletes it"
  fi
  # Cron discards this script's output, and a certified run exits 0, so the
  # documented cron line would surface nothing: syslog is the one place it shows.
  if command -v logger >/dev/null 2>&1; then
    logger -t hackarena-backup "WARNING: $_LOST_COUNT attachment file(s) the database references are missing from the live volume $DATA_DIR; listed in $OUT_DIR/BACKUP_METADATA.txt; $_HINT" \
      || echo "         (could not write this warning to syslog: logger failed)" >&2
  fi
fi
if [[ "$_STAGING_WITHOUT_FILE" -gt 0 ]]; then
  echo "  NOTE: $_STAGING_WITHOUT_FILE unfinished upload(s) under attachments-staging/ have no file in this backup;"
  echo "        they expire within an hour of the restore."
fi
_copy_tree logs "after the snapshot"

# v6.16.41 — persistent unsubscribe HMAC secret. Loss invalidates every
# already-sent unsubscribe URL, so include it in the backup. Mode 0o600
# is preserved by `cp -p`. Best-effort: a fresh deploy that hasn't yet
# generated the file is fine.
if [[ -f "$DATA_DIR/.unsubscribe-secret" ]]; then
  echo "  copying .unsubscribe-secret ..."
  cp -p "$DATA_DIR/.unsubscribe-secret" "$OUT_DIR/.unsubscribe-secret"
fi

# v7.20.9 — persistent grading-revision HMAC key. It keys the opaque token a
# participant echoes back on submit; losing it only invalidates in-flight
# tokens (one "reload the challenge" notice), so this is a convenience rather
# than a correctness backup — but it costs nothing and keeps a restored volume
# behaving identically. Same 0o600 / best-effort treatment as above.
if [[ -f "$DATA_DIR/.grading-secret" ]]; then
  echo "  copying .grading-secret ..."
  cp -p "$DATA_DIR/.grading-secret" "$OUT_DIR/.grading-secret"
fi

# Capture the platform version + boot-time metadata so the restorer
# knows what schema the DB was at (idempotent migrations are forward
# compatible but the operator may want to know).
{
  echo "backup_taken_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "data_dir: $DATA_DIR"
  echo "data_dir_owner: ${DATA_OWNER:-unknown}"
  echo "platform_version: $(grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' "$ROOT_DIR/version.json" 2>/dev/null | tr -d '"' || echo unknown)"
  echo "host: $(hostname || echo unknown)"
  echo "snapshot_attempts: $_ATTEMPT"
  echo "attachments_referenced: $_REF_COUNT"
  echo "attachments_lost_on_live_volume: $_LOST_COUNT"
  printf '%s' "$_LOST"
  echo "staging_rows_without_file: $_STAGING_WITHOUT_FILE"
} > "$OUT_DIR/BACKUP_METADATA.txt"

# Ship the restore procedure WITH the backup. Whoever restores under pressure
# is often not whoever read the README, and the stale-WAL trap below is silent
# when you get it wrong (integrity_check still says `ok`).
if [[ -n "$DATA_OWNER" ]]; then
  _OWNER_NOTE="($DATA_OWNER is the owner this directory had when the backup was taken.)"
else
  _OWNER_NOTE="(The owner could not be recorded here; the shipped image runs as uid 1000.)"
fi
cat > "$OUT_DIR/RESTORE.txt" <<RESTORE
Hack Arena — restoring this backup
==================================

Taken from : $DATA_DIR
At         : $TIMESTAMP

0. Check this backup FINISHED. A completed run writes BACKUP_COMPLETE as its
   very last act; a directory without it was interrupted, and its database and
   its attachments may be from different runs.
       test -f "$OUT_DIR/BACKUP_COMPLETE" && echo OK || echo "INCOMPLETE — do not restore"

   BACKUP_COMPLETE also certifies that every attachment file this database
   names is present under attachments/ here, except any counted on its
   attachments_lost_on_live_volume line that BACKUP_METADATA.txt does not mark
   "this backup holds a copy": those were already missing from the live volume
   when the backup ran, and a restore brings back that same gap, not a new
   one. (A file it does mark that way is here, and the restore puts it back.)
   An earlier backup may still hold the others: after the restore, copy each
   one into $DATA_DIR/attachments/ from the newest backup that has it at the
   listed size, and chown it like the rest of the directory. attachments/ may
   also hold files the database no longer names; the first start after a
   restore removes them.

1. Stop the server.
       docker compose down            # or: sudo systemctl stop hackarena

2. Remove any stale write-ahead log left by the OLD database.
       rm -f "$DATA_DIR"/hackathon.db-wal "$DATA_DIR"/hackathon.db-shm

   *** DO NOT SKIP STEP 2. *** This snapshot is fully checkpointed and has no
   WAL of its own. If the old -wal/-shm are still present, SQLite REPLAYS them
   on top of the database you just restored — the writes you were trying to
   roll back come straight back, and PRAGMA integrity_check still reports "ok",
   so nothing warns you. A clean shutdown removes these files, so this only
   bites after a crash, an OOM kill or a power loss — i.e. exactly when you are
   most likely to be restoring.

3. Put the backup in place.
       rsync -a --delete "$OUT_DIR"/ "$DATA_DIR"/

   (--delete is what removes the stale -wal/-shm if you skipped step 2, and
   drops anything else the backup does not contain. RESTORE.txt and
   BACKUP_METADATA.txt will land in the data directory; the server ignores
   them.)

4. Choose what happens to email about everything that ended before now.
   Events that were still running when this backup was taken look newly ended
   to the restored database. Left alone, everyone who took part in them is
   issued a new certificate with a new code and emailed again (the code they
   were sent after the backup no longer works), and their event teams get the
   wrap-up, lead files and 48-hour reminder again. Choose one (it needs sqlite3):

     Treat it as already sent (nobody is emailed again, start reminders already
     past due included; the old codes stay dead, and participants can collect a
     new certificate from the event's Challenges page):
       DATA_DIR="$DATA_DIR" "$SCRIPT_DIR"/restore-mail.sh mark-sent
     Send it again:
       DATA_DIR="$DATA_DIR" "$SCRIPT_DIR"/restore-mail.sh resend

   Events still running now are mailed as usual when they end.

5. Give the data directory back to the account the server runs as:
       chown -R ${DATA_OWNER:-<uid>:<gid>} "$DATA_DIR"
   $_OWNER_NOTE
   rsync -a run as root copies the BACKUP's ownership onto the data directory,
   and a backup taken by root is root's — so without this step the server's own
   user cannot write its database and the platform does not start.

6. Put the platform in maintenance mode, then start the server and watch the
   boot log. Certificate, event-team and start-reminder email waits while
   maintenance is on, so nothing is mailed from the restored database until you
   have checked it, and once you lift it, it goes out as you chose in step 4:
       printf '%s' '<a bypass token>' > "$DATA_DIR"/.maintenance
       docker compose up -d

   Boot runs PRAGMA integrity_check. Anything other than "ok" means investigate
   before letting users back in. While it fails, or the boot finds the schema
   incomplete (/readyz answers db_integrity or db_schema), that email keeps
   waiting even after you lift maintenance, until the database is fixed and the
   server restarted. A NEW superadmin password is generated on this start —
   read it from the log or from $DATA_DIR/.superadmin-password.

Not in this backup, deliberately:
  - uploads/ (UPLOADS_DIR)   transient — files are read and deleted after each
                             submission, and it is a separate docker volume
  - .superadmin-password     regenerated on every boot
  - .maintenance             a restored maintenance gate would 503 your users
RESTORE

# v8.3.20 — THE COMPLETION MARKER, written LAST and only on success. Everything
# above runs under `set -e`, so an interrupted run (a failed copy, a full disk,
# an operator's Ctrl-C) or a refused one (the attachment check above) never
# reaches this line and the directory is visibly unfinished. Do not restore a
# directory without it: its database and its files may be from different runs.
{
  echo "completed_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "timestamp: $TIMESTAMP"
  echo "attachments_verified: $_VERIFIED"
  echo "attachments_lost_on_live_volume: $_LOST_COUNT"
} > "$OUT_DIR/BACKUP_COMPLETE"

# Summarise. Operator can `du -sh $OUT_DIR` for size.
echo "Backup complete. Read RESTORE.txt before restoring — step 2 (removing a"
echo "stale hackathon.db-wal) is what makes the restore actually take effect."
ls -la "$OUT_DIR"
