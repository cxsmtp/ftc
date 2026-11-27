#!/usr/bin/env bash
# Hack Arena — operator-driven data-retention purge.
#
# Why this script exists:
#   The platform expires some data on its own — among it audit/event rows
#   older than EVENT_RETENTION_DAYS (lib/event-retention.js, default 730),
#   abandoned never-verified sign-ups after 48 h (lib/account-reaper.js),
#   expired session rows, temporary and orphaned upload/attachment files,
#   and, ONLY when free disk falls below its floor, the oldest JSONL log
#   files (lib/log.js). It keeps denied users, sent email_reminders, used
#   invitations and, with disk to spare, every log file — the right default
#   for forensics + compliance, but for long-running tenants it grows the
#   data dir. This
#   script deletes operator-configurable categories of stale data,
#   one category at a time, with a dry-run-by-default safety net.
#
# Usage:
#   DATA_DIR=<data-dir> scripts/purge.sh [--apply] [--days N | --max-mb N] [category ...]
#
#   e.g. on the bundled docker-compose host, as root:
#     sudo DATA_DIR=/opt/hackarena/data scripts/purge.sh --days 365
#
#   DATA_DIR      REQUIRED, no default (v8.13.4, operator decision): the
#                 data directory whose database and logs/ to purge. Unset
#                 or empty, the script stops with an ERROR before it reads
#                 or deletes anything; a value that is not a directory is
#                 refused too. It used to fall back to <repo>/data — a
#                 guess about where the live volume is, which the server
#                 itself has refused since v8.8.26 (lib/data-dir.js). Put
#                 it AFTER `sudo`: sudo resets the environment, so an
#                 exported DATA_DIR, or one written in front of `sudo`,
#                 never reaches the script. (--help needs no DATA_DIR.)
#   LOG_DIR       Optional: the directory the server writes its logs to,
#                 when it was started with LOG_DIR set (lib/log.js). The
#                 `logs` category purges it instead of $DATA_DIR/logs.
#                 Give the server's value: a relative one is resolved
#                 from the directory the script runs in. Set but empty,
#                 or not a directory, the script stops with an ERROR
#                 before it reads or deletes anything. Like DATA_DIR,
#                 put it AFTER `sudo`.
#   --apply       Actually delete. Without it, the script PRINTS what
#                 it would delete but does nothing.
#   --days N      Retention threshold in days (default 365). Files /
#                 rows older than this become candidates for deletion.
#   --max-mb N    Disk-size cap (logs only). When the total size of
#                 the logs directory exceeds N MB, delete the OLDEST files
#                 first until under the cap. Useful as a cron-driven
#                 disk-quota guard on long-lived tenants where time-
#                 based retention isn't strict enough. Mutually
#                 exclusive with --days for the `logs` category;
#                 ignored for other categories.
#   category ...  One or more of:
#                   logs                — rotated JSONL log files
#                                         (app-YYYY-MM-DD.jsonl,
#                                          access-YYYY-MM-DD.jsonl)
#                   invitations         — used invitations (used_at
#                                         IS NOT NULL)
#                   email_reminders     — sent reminders (sent=1)
#                   sessions            — sessions whose cookie has
#                                         expired
#                   all                 — every category above
#                 Default = `all`.
#
# What this script DOES NOT touch:
#   - users, competitions, tasks, submissions, hint_reveals,
#     competition_users, competition_user_absences,
#     competition_tasks, task_versions
#   - *_events tables (user_events, competition_events,
#     timeslot_events, settings_events, challenge_events)
#   - attachments/ (already periodically swept by server.js)
#
# These are the audit trail + the platform state. Manual purge of
# user records uses the existing admin DELETE participant endpoint
# (DELETE /api/admin/participants/:id) so the cascade + audit row
# happen via the server's transaction. Don't DELETE FROM users
# directly — it bypasses the v6.16.4 orphan-cascade fix.

set -euo pipefail

APPLY=false
DAYS=365
MAX_MB=""
CATEGORIES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)    APPLY=true; shift ;;
    --days)     DAYS="$2"; shift 2 ;;
    --days=*)   DAYS="${1#--days=}"; shift ;;
    --max-mb)   MAX_MB="$2"; shift 2 ;;
    --max-mb=*) MAX_MB="${1#--max-mb=}"; shift ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//;/^set -euo/d'
      exit 0
      ;;
    *)          CATEGORIES+=("$1"); shift ;;
  esac
done
[[ ${#CATEGORIES[@]} -eq 0 ]] && CATEGORIES=("all")

# v8.13.4 (operator decision) — DATA_DIR IS REQUIRED. NOTHING IS GUESSED.
# AFTER the argument loop, so --help still prints the usage without it; BEFORE
# the DB / LOGS_DIR derivations and every sqlite3 / rm below, so a refusal
# reads and deletes nothing. `${DATA_DIR:-}` rather than a bare `$DATA_DIR`:
# under `set -u` the bare form aborts on an UNSET value with bash's own
# "unbound variable", which names nothing an operator can act on. (An EMPTY
# value is refused by either form — `-z ""` is true.)
if [[ -z "${DATA_DIR:-}" ]]; then
  echo "ERROR: DATA_DIR is required — the data directory whose database and logs/ to purge." >&2
  echo "       There is deliberately no default: a path guessed from where this script sits is, on a" >&2
  echo "       host whose checkout holds or links the live data directory, the live volume — and the" >&2
  echo "       server refuses the same guess (lib/data-dir.js, v8.8.26)." >&2
  echo "       e.g.  sudo DATA_DIR=/opt/hackarena/data scripts/purge.sh --days 365" >&2
  echo "       Put DATA_DIR AFTER sudo: sudo resets the environment, so an exported DATA_DIR, or" >&2
  echo "       'DATA_DIR=... sudo scripts/purge.sh', never reaches this script." >&2
  echo "       Cron reads no shell profile either: write DATA_DIR into the crontab line itself." >&2
  exit 1
fi
if [[ ! -d "$DATA_DIR" ]]; then
  echo "ERROR: DATA_DIR is not a directory: $DATA_DIR" >&2
  exit 1
fi
# Absolute, so the DATA_DIR line below states the directory actually purged.
# `CDPATH=` and `--`: with CDPATH exported, a bare relative name is looked up
# through it first and may resolve to a DIFFERENT directory (measured). Into a
# temporary first, so a failed substitution cannot blank the value it names.
_ABS_DATA_DIR="$(CDPATH= cd -- "$DATA_DIR" && pwd)" || {
  echo "ERROR: cannot enter DATA_DIR: $DATA_DIR" >&2
  exit 1
}
DATA_DIR="$_ABS_DATA_DIR"
DB="$DATA_DIR/hackathon.db"
# The logs directory is the one the server writes to: LOG_DIR when it is set
# (lib/log.js), else $DATA_DIR/logs. `${LOG_DIR+set}` tells set from unset, so a
# set-but-EMPTY value is refused rather than silently read as "not set": the
# operator meant a directory and named none. Resolved absolute the DATA_DIR way.
if [[ -n "${LOG_DIR+set}" ]]; then
  if [[ -z "$LOG_DIR" ]]; then
    echo "ERROR: LOG_DIR is set but empty. Unset it to purge \$DATA_DIR/logs, or give the directory the server writes its logs to." >&2
    exit 1
  fi
  if [[ ! -d "$LOG_DIR" ]]; then
    echo "ERROR: LOG_DIR is not a directory: $LOG_DIR" >&2
    exit 1
  fi
  _ABS_LOG_DIR="$(CDPATH= cd -- "$LOG_DIR" && pwd)" || {
    echo "ERROR: cannot enter LOG_DIR: $LOG_DIR" >&2
    exit 1
  }
  LOGS_DIR="$_ABS_LOG_DIR"
else
  LOGS_DIR="$DATA_DIR/logs"
fi

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [[ "$DAYS" -lt 1 ]]; then
  echo "ERROR: --days must be a positive integer (got '$DAYS')" >&2
  exit 1
fi
if [[ -n "$MAX_MB" ]] && (! [[ "$MAX_MB" =~ ^[0-9]+$ ]] || [[ "$MAX_MB" -lt 1 ]]); then
  echo "ERROR: --max-mb must be a positive integer (got '$MAX_MB')" >&2
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "ERROR: hackathon.db not found at $DB" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 CLI not found on PATH. Install via your OS package manager (apt/brew/yum)." >&2
  exit 1
fi

echo "Hack Arena — data retention purge"
echo "  DATA_DIR : $DATA_DIR"
echo "  LOGS_DIR : $LOGS_DIR"
echo "  RETENTION: $DAYS days"
echo "  MODE     : $($APPLY && echo APPLY || echo DRY-RUN)"
echo "  TARGETS  : ${CATEGORIES[*]}"
echo

# Compute the cutoff timestamp once. SQLite's date arithmetic uses
# `datetime('now', '-N days')` so we feed it the parameter directly.
CUTOFF_ISO="$(date -u -d "$DAYS days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
              || date -u -v-${DAYS}d +%Y-%m-%dT%H:%M:%SZ)"
echo "  CUTOFF   : $CUTOFF_ISO"
echo

# Every sqlite3 call runs with `-init /dev/null -batch -noheader -list`, as in
# backup.sh: sqlite3 reads ~/.sqliterc (the passwd home's, /root's under sudo)
# even when handed SQL, and a `.headers on`, `.echo on` or `.mode box` there
# turns a count into text that would abort the run under set -u, or skip every
# DELETE while still printing "Purge complete." with exit 0. The 30 s busy
# timeout, as in backup.sh, lets a purge against a LIVE server wait out a
# writer instead of dying with "database is locked".
#
# Sets _COUNT to what `$2` (a SELECT COUNT(*)) counts in database `$1`, or
# stops the run with an ERROR: a sqlite3 failure or an answer that is not a
# bare number never reads as "nothing to purge".
_count_rows() {
  local db_file="$1" sql="$2" what="$3"
  _COUNT="$(sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$db_file" "$sql")" || {
    echo "ERROR: sqlite3 could not count $what in $db_file — stopping; nothing more is deleted." >&2
    exit 1
  }
  if [[ ! "$_COUNT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: counting $what in $db_file did not answer a number — stopping; nothing more is deleted." >&2
    exit 1
  fi
}

# Helper: count + (optionally) delete rows matching a WHERE clause.
sqlite_purge() {
  local db_file="$1"; shift
  local table="$1"; shift
  local where="$1"; shift
  local description="$1"; shift
  local count
  _count_rows "$db_file" "SELECT COUNT(*) FROM $table WHERE $where" "$table rows"
  count="$_COUNT"
  echo "  $description: $count rows"
  if $APPLY && [[ "$count" -gt 0 ]]; then
    sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$db_file" "DELETE FROM $table WHERE $where"
    echo "    -> deleted"
  fi
}

run_logs() {
  if [[ ! -d "$LOGS_DIR" ]]; then
    echo "[logs] no logs directory at $LOGS_DIR — skipping"
    return
  fi
  if [[ -n "$MAX_MB" ]]; then
    run_logs_by_size
  else
    run_logs_by_age
  fi
}

run_logs_by_age() {
  echo "[logs] rotated JSONL log files older than $DAYS days"
  local matches
  # Match both app-* and access-* JSONL files.
  matches=$(find "$LOGS_DIR" -maxdepth 1 -type f \
              \( -name 'app-*.jsonl' -o -name 'access-*.jsonl' \) \
              -mtime "+$DAYS" 2>/dev/null || true)
  if [[ -z "$matches" ]]; then
    echo "  no log files older than $DAYS days"
    return
  fi
  echo "$matches" | sed 's/^/  candidate: /'
  if $APPLY; then
    # v8.13.4 review — delete by the SAME find, NUL-safe, never by re-splitting
    # the printed list. That list used to go through `xargs rm -f`, which splits
    # on whitespace: a path holding a space (DATA_DIR is resolved ABSOLUTE above,
    # so any space in the directory above it counts) left the old log in place,
    # reported "-> deleted", and handed `rm` the fragment before the space —
    # deleting whatever file sat there, possibly outside DATA_DIR (measured).
    find "$LOGS_DIR" -maxdepth 1 -type f \
      \( -name 'app-*.jsonl' -o -name 'access-*.jsonl' \) \
      -mtime "+$DAYS" -exec rm -f -- {} +
    echo "  -> deleted"
  fi
}

# v6.16.34 — disk-quota mode for cron-driven log rotation. Walks
# $LOGS_DIR oldest-first; if the directory's total size exceeds
# MAX_MB megabytes, deletes the oldest file, recomputes, repeats
# until under the cap. Never touches a file carrying today's UTC
# date (both live writers, app- and access-<today>.jsonl — RM6 below),
# so a live writer can't have its in-flight buffer truncated; on a
# day with no file for today, the most recent file IS deletable.
# Output lines explain the choice for each candidate.
run_logs_by_size() {
  local cap_bytes=$((MAX_MB * 1024 * 1024))
  echo "[logs] disk-quota mode: cap=${MAX_MB}MB ($cap_bytes bytes)"
  # Collect candidate files, one per line: "<mtime>\t<size>\t<path>", sorted
  # oldest FIRST (the deletion candidate order). Today's live files are taken out
  # below, by NAME (RM6).
  local listing
  listing=$(find "$LOGS_DIR" -maxdepth 1 -type f \
              \( -name 'app-*.jsonl' -o -name 'access-*.jsonl' \) \
              -printf '%T@\t%s\t%p\n' 2>/dev/null \
            | sort -n)
  if [[ -z "$listing" ]]; then
    echo "  no log files in $LOGS_DIR"
    return
  fi
  # Total current bytes
  local total
  total=$(awk -F'\t' '{s+=$2} END {print s+0}' <<< "$listing")
  echo "  current total: $((total / 1024 / 1024))MB ($total bytes)"
  if [[ "$total" -le "$cap_bytes" ]]; then
    echo "  under cap — nothing to do"
    return
  fi
  # Walk oldest-first, deleting until we cross under cap. find's `-printf %T@`
  # gives float epoch seconds; the numeric sort above keeps that order.
  # audit v7.7.32 (RM6): deletion candidates = every rotated file EXCEPT those
  # carrying today's UTC date key. The server writes TWO live files per day —
  # app-<today>.jsonl AND access-<today>.jsonl (lib/log.js _RotatingStream keeps
  # both streams open) — so unlinking either loses the rest of the day's lines to
  # a dangling inode and frees no space until the UTC day rolls. The old "skip the
  # single newest entry" only ever protected whichever family had the newer mtime,
  # leaving the other's live file deletable. Mirror lib/log.js runLogRetentionCleanup,
  # which excludes ANY file whose name contains today's key.
  local today_key candidates deletable_lines
  today_key=$(date -u +%F)   # YYYY-MM-DD — matches app-YYYY-MM-DD.jsonl / access-YYYY-MM-DD.jsonl
  # On the file NAME, never the whole line: the line carries the full path, so a
  # DATA_DIR whose path holds today's date excluded every file and reported "only
  # today's active log files" (v8.13.4 fix-delta review). awk, not grep: grep
  # exits 1 when it selects nothing (every file is today's), and under `set -e`
  # that aborted the whole script — silently, with every later category skipped.
  candidates=$(awk -F'\t' -v k="$today_key" '{ n = $3; sub(/.*\//, "", n); if (index(n, k) == 0) print }' <<< "$listing")
  if [[ -z "$candidates" ]]; then
    echo "  only today's active log files present — refusing to delete live writers"
    return
  fi
  deletable_lines=$(echo "$candidates" | wc -l)
  echo "  $deletable_lines rotated file(s) eligible for deletion (today's live files protected)"
  local remaining=$total
  local deleted=0
  while IFS=$'\t' read -r _mtime size pathv; do
    if [[ "$remaining" -le "$cap_bytes" ]]; then break; fi
    echo "  candidate: $pathv ($((size / 1024))KB, mtime $(date -d @${_mtime%.*} 2>/dev/null || date -r ${_mtime%.*} 2>/dev/null || echo $_mtime))"
    if $APPLY; then
      rm -f -- "$pathv"
      echo "    -> deleted"
    fi
    remaining=$((remaining - size))
    deleted=$((deleted + 1))
  done <<< "$candidates"
  echo "  deleted $deleted file(s); projected remaining: $((remaining / 1024 / 1024))MB"
}

run_invitations() {
  echo "[invitations] used (claimed) invitations older than $DAYS days"
  sqlite_purge "$DB" "invitations" \
    "used_at IS NOT NULL AND used_at < '$CUTOFF_ISO'" \
    "  used invitations"
}

run_email_reminders() {
  echo "[email_reminders] sent reminders older than $DAYS days"
  # Schema: email_reminders has `sent INTEGER` and `send_at TEXT`. A
  # reminder is "stale" once the send_at is well past + sent=1.
  sqlite_purge "$DB" "email_reminders" \
    "sent=1 AND send_at < '$CUTOFF_ISO'" \
    "  sent reminders"
}

run_sessions() {
  echo "[sessions] expired session rows in hackathon.db (express_session table)"
  # infra audit (#2): sessions live in the express_session table INSIDE
  # hackathon.db — the store (express-session-better-sqlite3) is constructed
  # against the main DB connection in server.js. There is NO separate
  # sessions.db file, and the old sessions(sid,sess,expire) schema this function
  # targeted belongs to a DIFFERENT library, so the category was a permanent
  # no-op. express-session embeds expiry in the JSON `data` blob as
  # cookie.expires / cookie._expires (both shapes), which we match with
  # json_extract — mirroring the in-process GC sweep in server.js.
  # NOTE: that in-process sweep already purges expired rows every 5 minutes, and
  # a restart invalidates ALL sessions (random SESSION_SECRET per boot), so this
  # manual category is rarely needed.
  local DB="$DATA_DIR/hackathon.db"
  if [[ ! -f "$DB" ]]; then
    echo "  no hackathon.db at $DB — skipping"
    return
  fi
  local where="datetime(COALESCE(json_extract(data,'\$.cookie.expires'), json_extract(data,'\$.cookie._expires'))) < datetime('now')"
  local count
  # A failed count stops the run: read as 0 rows, a locked or unreadable table
  # would look like nothing to purge.
  _count_rows "$DB" "SELECT COUNT(*) FROM express_session WHERE $where" "expired sessions"
  count="$_COUNT"
  echo "  expired sessions: $count rows"
  if $APPLY && [[ "$count" -gt 0 ]]; then
    sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$DB" "DELETE FROM express_session WHERE $where"
    echo "    -> deleted"
  fi
}

# Dispatch.
for cat in "${CATEGORIES[@]}"; do
  case "$cat" in
    all)
      run_logs
      run_invitations
      run_email_reminders
      run_sessions
      ;;
    logs)              run_logs ;;
    invitations)       run_invitations ;;
    email_reminders)   run_email_reminders ;;
    sessions)          run_sessions ;;
    *)
      echo "ERROR: unknown category '$cat'" >&2
      exit 1
      ;;
  esac
done

echo
if $APPLY; then
  echo "Purge complete."
else
  echo "DRY-RUN ONLY. Re-run with --apply to delete."
fi
