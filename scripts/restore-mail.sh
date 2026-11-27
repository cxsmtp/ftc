#!/usr/bin/env bash
# Hack Arena — the restore's email choice (step 4 of a backup's RESTORE.txt).
#
# Why this script exists:
#   A restored database sees every event that ended after its backup was taken as
#   newly ended. Left alone, the platform then issues everyone who took part a new
#   certificate (a new code) and emails it, and sends those events' teams their
#   wrap-ups, lead files and 48-hour reminders again. Whoever restores chooses
#   (operator ruling, 17 Nov 2026):
#
#     mark-sent  Treat it as already sent. Nothing about an event that ended
#                before now is emailed: no certificate is issued or mailed for it
#                automatically (late entrants who join it later included), no team
#                report goes out about it (its 48-hour reminder and late leads
#                included), a Program completion queued before now is not mailed,
#                a certificate send still failing at backup time is not retried,
#                a start reminder already past due counts as sent, and this week's
#                Monday digest counts as sent. Certificate codes emailed after the
#                backup was taken stay dead; their holders can collect a new
#                certificate from the event's Challenges page, and an organiser
#                can send a team report with Send now.
#     resend     Send it again: everyone in those events is issued a new
#                certificate (a new code, replacing the dead ones) and emailed,
#                and their teams get the wrap-ups and reminders again. Start
#                reminders already due go out once maintenance is lifted, except
#                for events or sessions that have started by then (those are
#                not sent at all).
#
#   Either way, events still running now are mailed as usual when they end, and
#   an admin's Resend, Issue again and Send now work as always.
#
# Usage:
#   sudo DATA_DIR=<data-dir> scripts/restore-mail.sh mark-sent
#   sudo DATA_DIR=<data-dir> scripts/restore-mail.sh resend
#
#   DATA_DIR   REQUIRED, no default: the restored data directory. Put it AFTER
#              `sudo` (sudo resets the environment). (--help needs no DATA_DIR.)
#
# Run it with the server STOPPED, after the restore's rsync and before its
# chown: it refuses a database with a write-ahead log beside it (a running
# server, or a skipped step 2) and changes nothing then. It needs sqlite3.
#
# What it writes (one transaction):
#   mark-sent  `settings.restore_mail_floor_at` = now, only ever moved forward
#              (a later floor already there is kept), every unsent start reminder
#              due before now marked sent, and one settings_events row
#              (`updated`, by `system`, `{"choice":"mark_sent",...}`).
#   resend     Only the settings_events row (`{"choice":"resend",...}`). It never
#              lowers a floor; to undo a mark-sent before the first start, run
#              the restore's rsync step again.
#   It never writes `certificate_dispatch_floor_at`: the server derives two
#   upgrade decisions from that key's absence on a database from 8.14.
#
# Exit status: 0 done (or --help), 1 refused (nothing changed).
set -euo pipefail

VERB="${1:-}"
case "$VERB" in
  --help|-h|help)
    sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//;/^set -euo/d'
    exit 0
    ;;
esac

# DATA_DIR IS REQUIRED. NOTHING IS GUESSED. After the --help branch, before every
# read of the database, so a refusal reads and writes nothing.
if [[ -z "${DATA_DIR:-}" ]]; then
  echo "ERROR: DATA_DIR is required — the restored data directory." >&2
  echo "       e.g.  sudo DATA_DIR=/opt/hackarena/data scripts/restore-mail.sh mark-sent" >&2
  echo "       Put DATA_DIR AFTER sudo: sudo resets the environment, so an exported DATA_DIR, or" >&2
  echo "       'DATA_DIR=... sudo scripts/restore-mail.sh', never reaches this script." >&2
  exit 1
fi
if [[ ! -d "$DATA_DIR" ]]; then
  echo "ERROR: DATA_DIR is not a directory: $DATA_DIR" >&2
  exit 1
fi
# Absolute and CDPATH-safe (see scripts/purge.sh).
_ABS_DATA_DIR="$(CDPATH= cd -- "$DATA_DIR" && pwd)" || {
  echo "ERROR: cannot enter DATA_DIR: $DATA_DIR" >&2
  exit 1
}
DATA_DIR="$_ABS_DATA_DIR"
DB="$DATA_DIR/hackathon.db"

case "$VERB" in
  mark-sent|resend) ;;
  *)
    echo "ERROR: say what happens to email about everything that ended before now:" >&2
    echo "       scripts/restore-mail.sh mark-sent   (treat it as already sent)" >&2
    echo "       scripts/restore-mail.sh resend      (send it again)" >&2
    echo "       scripts/restore-mail.sh --help      (what each one does)" >&2
    exit 1
    ;;
esac

if [[ ! -s "$DB" ]]; then
  echo "ERROR: no database at $DB (or it is empty): run this after the restore's rsync step." >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is not installed on this host; install it (the backup needs it too)." >&2
  exit 1
fi
if [[ -e "$DB-wal" || -e "$DB-shm" ]]; then
  echo "ERROR: $DB has a write-ahead log beside it: the server looks to be running, or the" >&2
  echo "       restore's step 2 was skipped. Stop the server and remove the stale" >&2
  echo "       hackathon.db-wal / hackathon.db-shm first. Nothing was changed." >&2
  exit 1
fi
has="$(sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$DB" \
  "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('settings','settings_events','email_reminders')")" || has=""
if [[ "$has" != "3" ]]; then
  echo "ERROR: $DB is not a Hack Arena database (no settings tables). Nothing was changed." >&2
  exit 1
fi

# One instant, read once (`_rm`, a TEMP table: nothing in the database file), so
# the floor and its audit row agree to the millisecond. The audit row's id is
# UUID-shaped and its details are built from ISO times only (no json_object: an
# older sqlite3 may lack JSON1). The upsert moves the floor forward only: a later
# value already stored is kept (an INSERT ... SELECT with an upsert needs its
# WHERE, even `WHERE true`, or SQLite reads ON as a join).
ID_SQL="lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(2))||'-'||hex(randomblob(6)))"
FLOOR_SQL="(SELECT value FROM settings WHERE key='restore_mail_floor_at')"
if [[ "$VERB" == "mark-sent" ]]; then
  SQL="BEGIN IMMEDIATE;
CREATE TEMP TABLE _rm AS SELECT $FLOOR_SQL AS old, strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now;
UPDATE email_reminders SET sent=1 WHERE sent=0 AND send_at < (SELECT now FROM _rm);
CREATE TEMP TABLE _rmr AS SELECT changes() AS n;
INSERT INTO settings (key, value) SELECT 'restore_mail_floor_at', now FROM _rm WHERE true
  ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE excluded.value > settings.value;
INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details)
  SELECT $ID_SQL, 'restore_mail_floor_at', 'updated', 'system', now,
    '{\"choice\":\"mark_sent\",\"via\":\"scripts/restore-mail.sh\",\"from\":'||COALESCE('\"'||old||'\"','null')||',\"to\":\"'||$FLOOR_SQL||'\",\"reminders_marked\":'||(SELECT n FROM _rmr)||'}'
  FROM _rm;
COMMIT;
SELECT $FLOOR_SQL||'|'||(SELECT n FROM _rmr);"
else
  SQL="BEGIN IMMEDIATE;
INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details)
  SELECT $ID_SQL, 'restore_mail_floor_at', 'updated', 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    '{\"choice\":\"resend\",\"via\":\"scripts/restore-mail.sh\",\"to\":'||COALESCE('\"'||$FLOOR_SQL||'\"','null')||'}';
COMMIT;
SELECT COALESCE($FLOOR_SQL, '');"
fi
FLOOR="$(sqlite3 -init /dev/null -batch -noheader -list -cmd ".timeout 30000" "$DB" "$SQL")" || {
  echo "ERROR: the database refused the change; nothing was written (the transaction rolled back)." >&2
  exit 1
}
if [[ -e "$DB-wal" || -e "$DB-shm" ]]; then
  echo "WARNING: sqlite3 left a write-ahead log beside $DB; the next start replays it." >&2
fi

if [[ "$VERB" == "mark-sent" ]]; then
  REMINDERS="${FLOOR##*|}"; FLOOR="${FLOOR%|*}"
  echo "Marked as sent: certificates and event team reports for anything that ended before $FLOOR,"
  echo "and $REMINDERS start reminder(s) already past due."
  echo "Nobody is emailed about it again. Certificates emailed after the backup was taken keep"
  echo "codes that no longer work; their holders can collect a new certificate from the event's"
  echo "Challenges page. Events still running now are not affected."
else
  echo "Nothing marked: once maintenance mode is lifted, everyone in an event that ended after the"
  echo "backup was taken is issued a new certificate (a new code) and emailed, and those events'"
  echo "teams get their wrap-ups, lead files and 48-hour reminders again."
  echo "Start reminders already due go out once maintenance is lifted, except for events or sessions"
  echo "that have started by then."
  if [[ -n "$FLOOR" ]]; then
    echo "An earlier mark-sent floor is still in place: anything that ended before $FLOOR stays marked."
  fi
fi
exit 0
