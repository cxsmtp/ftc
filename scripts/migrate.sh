#!/usr/bin/env bash
# Hack Arena — move an installation to a new server.
#
#   sudo DATA_DIR=/opt/hackarena/data scripts/migrate.sh pack /tmp/arena-move.tar.gz
#     On the OLD server, app stopped. Runs scripts/backup.sh, then packs the
#     finished backup and a checksum beside it. The archive holds the database
#     and both HMAC secrets, so it is written readable by its owner only.
#
#   sudo DATA_DIR=/opt/hackarena/data scripts/migrate.sh unpack /tmp/arena-move.tar.gz
#     On the NEW server, before the app's first boot. Verifies the checksum and
#     the backup's BACKUP_COMPLETE marker, then fills the empty DATA_DIR. Run as
#     root, it hands the data to MIGRATE_OWNER=<uid>:<gid> if set; else to the
#     owner of a DATA_DIR you created before the unpack (not root); else to the
#     owner the backup recorded on the old server; else to 1000:1000, the shipped
#     image's user. It prints which, and why.
#
#   scripts/migrate.sh check http://127.0.0.1:3000
#     After starting the app. Waits for /readyz; the first boot upgrades the
#     database, so give it time on a large one.
#
# unpack REFUSES a DATA_DIR holding anything. It deletes nothing, so a mistyped
# path cannot wipe a live volume; to redo a move, empty the directory yourself.
# The old server's copy stays your way back: an upgraded database only moves
# forward. Never run both; before starting the old one again, give its data
# directory a .maintenance file and run scripts/restore-mail.sh mark-sent on it.
#
# Requires: pack, what backup.sh requires (sqlite3, rsync); unpack, tar and
# sha256sum; check, curl.
set -euo pipefail

umask 077

die() { echo "migrate.sh: $*" >&2; exit 1; }

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

need_data_dir() {
  [[ -n "${DATA_DIR:-}" ]] || die "DATA_DIR is required (put it after sudo: sudo DATA_DIR=/path $0 ...)"
}

# A uid:gid worth handing the data to: numeric, and not root's (a directory made
# by `sudo mkdir`, or a fresh mount point, says nothing about the server).
usable_owner() { [[ "$1" =~ ^[0-9]+:[0-9]+$ && "${1%%:*}" != 0 ]]; }

# Whether a user or group name (a number is taken as an id) exists on this host.
user_exists() { [[ "$1" =~ ^[0-9]+$ ]] || id -u -- "$1" >/dev/null 2>&1; }
group_exists() {
  [[ "$1" =~ ^[0-9]+$ ]] && return 0
  if command -v getent >/dev/null 2>&1; then getent group "$1" >/dev/null 2>&1
  else awk -F: -v g="$1" '$1 == g { found = 1 } END { exit !found }' /etc/group 2>/dev/null; fi
}

pack() {
  need_data_dir
  local archive="${1:-}"
  [[ -n "$archive" ]] || usage
  [[ ! -e "$archive" ]] || die "$archive already exists; name a new file"
  [[ -f "$DATA_DIR/hackathon.db" ]] || die "$DATA_DIR/hackathon.db not found; is DATA_DIR the data volume?"

  local parent work
  parent="$(cd "$(dirname "$archive")" && pwd)" || die "no such directory: $(dirname "$archive")"
  archive="$parent/$(basename "$archive")"
  work="$(mktemp -d "$parent/.arena-move.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now, on purpose
  trap "rm -rf -- '$work'" EXIT

  DATA_DIR="$DATA_DIR" "$(dirname "$0")/backup.sh" "$work/backup"
  [[ -f "$work/backup/BACKUP_COMPLETE" ]] || die "the backup did not finish; nothing was packed"

  tar -czf "$archive" -C "$work/backup" .
  (cd "$parent" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
  echo "Packed $archive"
  echo "Copy it AND $(basename "$archive").sha256 to the new server, then run unpack there."
}

unpack() {
  need_data_dir
  local archive="${1:-}"
  [[ -n "$archive" ]] || usage
  [[ -f "$archive" ]] || die "$archive not found"
  [[ -f "$archive.sha256" ]] || die "$archive.sha256 not found; copy it with the archive"
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256" >/dev/null) \
    || die "the checksum does not match; copy the archive again"

  if [[ -d "$DATA_DIR" ]] && [[ -n "$(ls -A -- "$DATA_DIR" | grep -vx 'lost+found' || true)" ]]; then
    die "$DATA_DIR is not empty; unpack only fills an empty volume, before the app's first boot"
  fi

  # An override that is malformed, or names a user or group this host does not
  # have, is refused before anything is written: the chown would fail after the
  # data had landed, leaving a filled volume owned by root that unpack then
  # refuses to fill again.
  if [[ -n "${MIGRATE_OWNER:-}" ]]; then
    [[ "$MIGRATE_OWNER" =~ ^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$ ]] || die "MIGRATE_OWNER must be <user>:<group> or <uid>:<gid>, got: $MIGRATE_OWNER"
    user_exists "${MIGRATE_OWNER%%:*}" || die "MIGRATE_OWNER names no user on this host: ${MIGRATE_OWNER%%:*}"
    group_exists "${MIGRATE_OWNER#*:}" || die "MIGRATE_OWNER names no group on this host: ${MIGRATE_OWNER#*:}"
  fi
  # Who owned DATA_DIR before the unpack, if the operator prepared it (empty).
  local prepared_owner=""
  if [[ -d "$DATA_DIR" ]]; then
    prepared_owner="$(stat -L -c '%u:%g' "$DATA_DIR" 2>/dev/null || stat -L -f '%u:%g' "$DATA_DIR" 2>/dev/null || true)"
  fi

  local member
  while IFS= read -r member; do
    case "/$member/" in
      //*|*/../*) die "the archive names an unsafe path: $member" ;;
    esac
  done < <(tar -tzf "$archive")

  local parent work
  mkdir -p -- "$DATA_DIR"
  parent="$(cd "$DATA_DIR/.." && pwd)"
  work="$(mktemp -d "$parent/.arena-move.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now, on purpose
  trap "rm -rf -- '$work'" EXIT
  tar -xzf "$archive" --no-same-owner -C "$work"
  [[ -f "$work/BACKUP_COMPLETE" ]] || die "the archive holds no BACKUP_COMPLETE marker; the backup was not finished"
  [[ -s "$work/hackathon.db" ]] || die "the archive holds no database"

  # The owner the backup recorded on the old server, read before its papers go.
  local recorded_owner
  recorded_owner="$( (sed -n 's/^data_dir_owner: //p' "$work/BACKUP_METADATA.txt" 2>/dev/null || true) | head -n 1)"
  # The backup's own papers describe the old server; they are not data.
  rm -f -- "$work/BACKUP_COMPLETE" "$work/BACKUP_METADATA.txt" "$work/RESTORE.txt"
  tar -cf - -C "$work" . | tar -xf - --no-same-owner -C "$DATA_DIR"

  # Root would leave the server a read-only database. The owner: MIGRATE_OWNER;
  # else the owner of a DATA_DIR prepared before the unpack; else the owner the
  # backup recorded on the old server; else the shipped image's user.
  if [[ "$(id -u)" == "0" ]]; then
    local owner why
    if [[ -n "${MIGRATE_OWNER:-}" ]]; then owner="$MIGRATE_OWNER"; why="MIGRATE_OWNER"
    elif usable_owner "$prepared_owner"; then owner="$prepared_owner"; why="the owner of $DATA_DIR before the unpack"
    elif usable_owner "$recorded_owner"; then owner="$recorded_owner"; why="the owner recorded on the old server"
    else owner="1000:1000"; why="the shipped image's user; nothing else named one"; fi
    chown -R "$owner" -- "$DATA_DIR"
    echo "Owner $owner ($why). If the server runs as another user: chown -R <uid>:<gid> $DATA_DIR, or redo the unpack with MIGRATE_OWNER=<uid>:<gid>."
  fi
  echo "Restored into $DATA_DIR. Start the app, then run: $0 check <its address>"
}

check() {
  local base="${1:-}" tries="${2:-60}" body=""
  [[ -n "$base" ]] || usage
  for ((i = 0; i < tries; i++)); do
    body="$(curl -s --max-time 5 "${base%/}/readyz" || true)"
    case "$body" in
      *'"ready":true'*) echo "Ready: $body"; return 0 ;;
    esac
    sleep 5
  done
  die "not ready after $((tries * 5)) seconds; last answer: ${body:-none}. The app's boot log names the cause."
}

case "${1:-}" in
  pack) shift; pack "$@" ;;
  unpack) shift; unpack "$@" ;;
  check) shift; check "$@" ;;
  -h|--help|help) usage 0 ;;
  *) usage ;;
esac
