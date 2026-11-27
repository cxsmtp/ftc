#!/usr/bin/env bash
# One-time installer for an Ubuntu server. Builds nothing: it pulls the signed
# image the release-image workflow publishes, and from then on podman
# auto-update follows the `stable` tag by itself.
#
#   scp deploy/podman/install.sh deploy/podman/signing.pub you@server:
#   ssh you@server 'sudo bash install.sh'
#
# Re-running is safe: it keeps the existing configuration unless RECONFIGURE=1.
# Every question can be answered in advance through the environment, e.g.
#   sudo BASE_URL=https://x.example SMTP_HOST=smtp.example GHCR_USER=me GHCR_TOKEN=... bash install.sh
#
# What it sets up (all scoped to this one app; MZ/FTR or any other container on
# the host is left alone):
#   - image pulls refused unless signed with signing.pub (containers policy, this repository only)
#   - a Quadlet unit: read-only root, no capabilities, no-new-privileges, pid/memory/cpu limits,
#     port bound to 127.0.0.1 only, SMTP password as a podman secret, health check on /readyz
#   - auto-update from the registry with automatic rollback, and a database backup
#     before every start (so before every update)
set -euo pipefail

APP="${APP:-ftc}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/cxsmtp/ftc}"
IMAGE_TAG="${IMAGE_TAG:-stable}"
BIND="${BIND:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-3000}"
MEMORY="${MEMORY:-4g}"
CPUS="${CPUS:-4}"
ROOT="/srv/$APP"
ETC="/etc/$APP"
KEY_DIR=/etc/containers/keys
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBKEY_SRC="${PUBKEY_SRC:-$HERE/signing.pub}"

die() { echo "install: $*" >&2; exit 1; }
ask() { # ask VAR "Question" [default] [secret]
  local var="$1" q="$2" def="${3:-}" secret="${4:-}" val
  if [ -n "${!var:-}" ]; then return; fi
  if [ -n "$secret" ]; then read -r -s -p "$q: " val </dev/tty; echo
  else read -r -p "$q${def:+ [$def]}: " val </dev/tty; fi
  printf -v "$var" '%s' "${val:-$def}"
}

[ "$(id -u)" = 0 ] || die "run as root (sudo bash install.sh)"
[ -s "$PUBKEY_SRC" ] || die "signing public key not found at $PUBKEY_SRC (copy signing.pub next to this script)"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman skopeo sqlite3 python3 curl >/dev/null
PODMAN_MAJOR="$(podman version --format '{{.Client.Version}}' | cut -d. -f1)"
echo "podman $(podman version --format '{{.Client.Version}}')"

echo "== configuration"
mkdir -p "$ETC" && chmod 700 "$ETC"
if [ ! -s "$ETC/$APP.env" ] || [ "${RECONFIGURE:-0}" = 1 ]; then
  ask BASE_URL   "Public URL (e.g. https://app.example.com)"
  ask SMTP_HOST  "SMTP host"
  ask SMTP_PORT  "SMTP port" 587
  ask SMTP_USER  "SMTP user (empty for none)"
  ask EMAIL_FROM "Sender address" "no-reply@$(printf '%s' "$BASE_URL" | sed -E 's#^[a-z]+://##; s#[:/].*##')"
  ask TRUST_PROXY "Reverse proxies in front of the app (0 if none)" 1
  [ -n "$BASE_URL" ] && [ -n "$SMTP_HOST" ] || die "BASE_URL and SMTP_HOST are required"
  umask 077
  {
    echo "BASE_URL=$BASE_URL"
    echo "SMTP_HOST=$SMTP_HOST"
    echo "SMTP_PORT=$SMTP_PORT"
    if [ -n "$SMTP_USER" ]; then echo "SMTP_USER=$SMTP_USER"; fi
    echo "EMAIL_FROM=$EMAIL_FROM"
    if [ "$TRUST_PROXY" != 0 ]; then echo "TRUST_PROXY=$TRUST_PROXY"; fi
  } > "$ETC/$APP.env"
  umask 022
  if [ -n "$SMTP_USER" ]; then
    ask SMTP_PASS "SMTP password" "" secret
    printf '%s' "$SMTP_PASS" | podman secret create --replace "$APP-smtp-pass" - >/dev/null
  fi
fi
HAS_SMTP_SECRET=0
podman secret exists "$APP-smtp-pass" 2>/dev/null && HAS_SMTP_SECRET=1

echo "== registry login (skip if the package is public)"
if [ ! -s "$ETC/auth.json" ] || [ "${RECONFIGURE:-0}" = 1 ]; then
  ask GHCR_USER "GitHub user for ghcr.io (empty if the image is public)"
  if [ -n "$GHCR_USER" ]; then
    ask GHCR_TOKEN "GitHub token with read:packages only" "" secret
    printf '%s' "$GHCR_TOKEN" | podman login --authfile "$ETC/auth.json" ghcr.io -u "$GHCR_USER" --password-stdin
  else
    echo '{"auths":{}}' > "$ETC/auth.json"
  fi
  chmod 600 "$ETC/auth.json"
fi

echo "== signature policy (this repository only)"
install -d -m 755 "$KEY_DIR"
install -m 644 "$PUBKEY_SRC" "$KEY_DIR/$APP.pub"
POLICY=/etc/containers/policy.json
[ -f "$POLICY" ] || echo '{"default":[{"type":"insecureAcceptAnything"}]}' > "$POLICY"
[ -f "$POLICY.before-$APP" ] || cp -a "$POLICY" "$POLICY.before-$APP"
python3 - "$POLICY" "$IMAGE_REPO" "$KEY_DIR/$APP.pub" <<'PY'
import json, os, sys
path, repo, key = sys.argv[1:]
with open(path) as f: d = json.load(f)
d.setdefault("transports", {}).setdefault("docker", {})[repo] = [{
    "type": "sigstoreSigned", "keyPath": key,
    "signedIdentity": {"type": "matchRepository"}}]
tmp = path + ".tmp"
with open(tmp, "w") as f: json.dump(d, f, indent=2); f.write("\n")
os.replace(tmp, path)
PY
install -d -m 755 /etc/containers/registries.d
printf 'docker:\n  %s:\n    use-sigstore-attachments: true\n' "$IMAGE_REPO" > "/etc/containers/registries.d/$APP.yaml"

echo "== data folders"
install -d -m 700 -o 1000 -g 1000 "$ROOT/data" "$ROOT/uploads"
install -d -m 700 "$ROOT/backups"

echo "== backup script"
cat > "/usr/local/sbin/$APP-backup" <<EOF
#!/bin/sh
# Consistent copy of the database and the files a restore needs. Runs before
# every start of the app (so before every update). Keeps the newest \${KEEP:-14}.
set -eu
D=$ROOT/data; B=$ROOT/backups; KEEP=\${KEEP:-14}
[ -s "\$D/hackathon.db" ] || { echo "no database yet, nothing to back up"; exit 0; }
T="\$B/\$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "\$T"; chmod 700 "\$T"
sqlite3 -init /dev/null -batch "\$D/hackathon.db" ".backup '\$T/hackathon.db'"
[ "\$(sqlite3 -init /dev/null -batch -noheader -list "\$T/hackathon.db" 'PRAGMA integrity_check')" = ok ] \\
  || { echo "backup failed its integrity check" >&2; exit 1; }
for f in attachments .grading-secret .unsubscribe-secret; do
  [ -e "\$D/\$f" ] && cp -a "\$D/\$f" "\$T/"
done
touch "\$T/BACKUP_COMPLETE"
n=0
for d in \$(ls -1d "\$B"/2*Z 2>/dev/null | sort -r); do
  n=\$((n+1)); [ "\$n" -gt "\$KEEP" ] && rm -rf -- "\$d"
done
echo "backup written to \$T"
EOF
chmod 700 "/usr/local/sbin/$APP-backup"

echo "== container unit"
NOTIFY_LINE="# Notify=healthy needs podman 5+: on podman $PODMAN_MAJOR a rollback happens only if the new container fails to start"
[ "$PODMAN_MAJOR" -ge 5 ] && NOTIFY_LINE="Notify=healthy"
SECRET_LINE=""
[ "$HAS_SMTP_SECRET" = 1 ] && SECRET_LINE="Secret=$APP-smtp-pass,type=env,target=SMTP_PASS"
install -d -m 755 /etc/containers/systemd
cat > "/etc/containers/systemd/$APP.container" <<EOF
[Unit]
Description=$APP
Wants=network-online.target
After=network-online.target

[Container]
Image=$IMAGE_REPO:$IMAGE_TAG
ContainerName=$APP
AutoUpdate=registry
Label=io.containers.autoupdate.authfile=$ETC/auth.json
PublishPort=$BIND:$HOST_PORT:3000
Volume=$ROOT/data:/app/data:Z
Volume=$ROOT/uploads:/app/uploads:Z
EnvironmentFile=$ETC/$APP.env
$SECRET_LINE
ReadOnly=true
DropCapability=ALL
NoNewPrivileges=true
PodmanArgs=--pids-limit=1024 --memory=$MEMORY --cpus=$CPUS
HealthCmd=node -e "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
HealthInterval=30s
HealthTimeout=5s
HealthStartPeriod=20s
HealthRetries=3
$NOTIFY_LINE

[Service]
Environment=REGISTRY_AUTH_FILE=$ETC/auth.json
ExecStartPre=-/usr/local/sbin/$APP-backup
Restart=always
TimeoutStartSec=300
TimeoutStopSec=25

[Install]
WantedBy=multi-user.target
EOF
/usr/lib/systemd/system-generators/podman-system-generator --dryrun >/dev/null \
  || die "the generated unit did not validate (see the message above)"

echo "== first pull (refused if the image is not signed with signing.pub)"
REGISTRY_AUTH_FILE="$ETC/auth.json" podman pull "$IMAGE_REPO:$IMAGE_TAG"

echo "== start"
systemctl daemon-reload
systemctl restart "$APP"
systemctl enable --now podman-auto-update.timer >/dev/null

for i in $(seq 1 90); do
  if curl -fsS "http://$BIND:$HOST_PORT/readyz" >/dev/null 2>&1; then break; fi
  [ "$i" = 90 ] && { journalctl -u "$APP" -n 60 --no-pager; die "the app did not become ready"; }
  sleep 2
done

cat <<EOF

Ready on http://$BIND:$HOST_PORT (put your HTTPS reverse proxy in front of it).
  superadmin password : sudo cat $ROOT/data/.superadmin-password   (new on every start)
  status / logs       : systemctl status $APP ; journalctl -u $APP -f
  update now          : sudo podman auto-update
  check for updates   : sudo podman auto-update --dry-run
  backups             : $ROOT/backups   (one before every start/update, newest 14 kept)
Auto-update checks $IMAGE_REPO:$IMAGE_TAG on podman-auto-update.timer (daily) and rolls back if the new version fails.
EOF
