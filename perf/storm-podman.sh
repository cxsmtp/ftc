#!/usr/bin/env bash
# perf/storm-podman.sh — the 1000-user sign-in storm, end to end, in containers.
#
# Brings up an isolated network with a Mailpit relay, the app image built from
# THIS checkout (resource-limited like a modest production host), seeds N
# participants enrolled in one live event behind the maintenance gate, opens the
# gate, then runs perf/k6/scenarios/login-storm.js from a k6 container with a
# fixed address while sampling container CPU/memory, VM load, the WAL size, the
# session table and the app's own /metrics. Every artefact lands in
# perf/results/storm/<label>/ and perf/tools/storm-report.js turns them into
# report.md + timeline.svg. See perf/README.md § "1000-user sign-in storm".
#
#   perf/storm-podman.sh --label A-60s  --mode A --users 1000 --window 60
#   perf/storm-podman.sh --label A-10s  --mode A --users 1000 --window 10
#   perf/storm-podman.sh --label B-60s  --mode B --users 1000 --window 60
#
# --mode A  the load generator's address is on RATE_LIMIT_ALLOWLIST_IPS (the
#           venue configured as documented)
# --poll-mode pulse|legacy  how a signed-in VU polls: `pulse` (default) is the
#           SPA since v8.17.0, `legacy` the three separate polls before it
# --mode B  one NAT address, no allowlist: every limiter and the scanner tracker
#           apply to all N people at once
#
# --prefix P  name every container, volume and the network P-… (default: the
#           names below) and --subnet-octet K use 10.K.0.0/24 (default 231), so
#           a run can sit beside another stack on the same host
#
# Needs only podman (and the image: podman build -t hackarena:perf .). Uses its
# own names (perf-net, hackarena-perf, perf-mailpit, perf-k6, perf-monitor,
# perf-data, perf-uploads) and never touches any other container.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

LABEL="storm"; MODE="A"; USERS=1000; SEED_USERS=""; WINDOW=60; HOLD=240; CPUS=4; MEM=4g
K6_IMAGE="docker.io/grafana/k6:1.3.0"; MAILPIT_IMAGE="docker.io/axllent/mailpit:v1.21"
APP_IMAGE="localhost/hackarena:perf"; KEEP=0; STATIC=1; EXTRA_ENV=(); POLL_MODE="pulse"
PREFIX=""; OCTET=231
usage() { sed -n '2,24p' "$0"; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --users) USERS="$2"; shift 2;;
    --seed-users) SEED_USERS="$2"; shift 2;;
    --window) WINDOW="$2"; shift 2;;
    --hold) HOLD="$2"; shift 2;;
    --cpus) CPUS="$2"; shift 2;;
    --memory) MEM="$2"; shift 2;;
    --image) APP_IMAGE="$2"; shift 2;;
    --no-static) STATIC=0; shift;;
    --poll-mode) POLL_MODE="$2"; shift 2;;
    --app-env) EXTRA_ENV+=(-e "$2"); shift 2;;
    --keep) KEEP=1; shift;;
    --prefix) PREFIX="$2"; shift 2;;
    --subnet-octet) OCTET="$2"; shift 2;;
    -h|--help) usage 0;;
    *) echo "unknown flag $1" >&2; usage 1;;
  esac
done
case "$MODE" in A|B) ;; *) echo "--mode must be A or B" >&2; exit 1;; esac

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ROOT_MOUNT="$(pwd -W 2>/dev/null || pwd)"          # Windows hosts: C:/… for podman -v
OUT_REL="perf/results/storm/${LABEL}"
OUT="${ROOT}/${OUT_REL}"
mkdir -p "$OUT"
rm -f "$OUT"/*.jsonl "$OUT"/*.csv "$OUT"/*.log "$OUT"/k6-summary-*.json "$OUT"/report.md "$OUT"/timeline.svg

case "$OCTET" in ''|*[!0-9]*) echo "--subnet-octet must be a number" >&2; exit 1;; esac
NET=perf-net; SUBNET=10.${OCTET}.0.0/24
APP_IP=10.${OCTET}.0.10; MAIL_IP=10.${OCTET}.0.11; K6_IP=10.${OCTET}.0.20; MON_IP=10.${OCTET}.0.30; SEED_IP=10.${OCTET}.0.40
APP=hackarena-perf; MAIL=perf-mailpit; K6=perf-k6; MON=perf-monitor; SEED=perf-seed
VOL_DATA=perf-data; VOL_UP=perf-uploads
if [ -n "$PREFIX" ]; then
  NET="${PREFIX}-net"; APP="${PREFIX}-app"; MAIL="${PREFIX}-mailpit"; K6="${PREFIX}-k6"; MON="${PREFIX}-monitor"
  SEED="${PREFIX}-seed"; VOL_DATA="${PREFIX}-data"; VOL_UP="${PREFIX}-uploads"
fi
BYPASS="perf-$(date +%s)-$RANDOM$RANDOM"
log() { printf '[storm %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
vmload() { podman machine ssh "cat /proc/loadavg" 2>/dev/null || cat /proc/loadavg; }

cleanup_containers() {
  podman rm -f "$K6" "$MON" "$APP" "$MAIL" >/dev/null 2>&1 || true
  podman volume rm -f "$VOL_DATA" "$VOL_UP" >/dev/null 2>&1 || true
}
finish() {
  rm -f "$OUT/.sampling"
  if [ "$KEEP" != 1 ]; then cleanup_containers; podman network rm -f "$NET" >/dev/null 2>&1 || true; fi
}
trap finish EXIT

log "label=$LABEL mode=$MODE users=$USERS window=${WINDOW}s hold=${HOLD}s app=--cpus $CPUS --memory $MEM"
log "VM load before: $(vmload)"
{ git rev-parse HEAD; git status --porcelain | sed "s/^/dirty: /"; } > "$OUT/commit.txt" 2>/dev/null || echo unknown > "$OUT/commit.txt"
{
  echo "label=$LABEL"; echo "mode=$MODE"; echo "users=$USERS"; echo "seeded_users=${SEED_USERS:-$USERS}"; echo "window_s=$WINDOW"; echo "hold_s=$HOLD"
  echo "app_cpus=$CPUS"; echo "app_memory=$MEM"; echo "app_image=$APP_IMAGE"; echo "k6_image=$K6_IMAGE"; echo "mailpit_image=$MAILPIT_IMAGE"
  echo "vm_load_before=$(vmload)"; echo "vm_nproc=$(podman machine ssh nproc 2>/dev/null || nproc)"
  echo "vm_mem=$(podman machine ssh "free -m | awk '/Mem:/{print \$2\" MB total, \"\$7\" MB available\"}'" 2>/dev/null)"
  echo "started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "extra_app_env=${EXTRA_ENV[*]:-}"
} > "$OUT/env.txt"

cleanup_containers
podman network exists "$NET" || podman network create --subnet "$SUBNET" "$NET" >/dev/null
podman volume create "$VOL_DATA" >/dev/null; podman volume create "$VOL_UP" >/dev/null

log "mailpit"
podman run -d --name "$MAIL" --network "$NET" --ip "$MAIL_IP" --network-alias mailpit \
  --cpus 4 --memory 2g "$MAILPIT_IMAGE" --max 20000 >/dev/null

ALLOW_ENV=()
[ "$MODE" = A ] && ALLOW_ENV=(-e "RATE_LIMIT_ALLOWLIST_IPS=${K6_IP}")
log "app (${ALLOW_ENV[*]:-no allowlist})"
podman run -d --name "$APP" --network "$NET" --ip "$APP_IP" --network-alias "$APP" \
  --cpus "$CPUS" --memory "$MEM" --memory-swap "$MEM" \
  -v "$VOL_DATA":/app/data -v "$VOL_UP":/app/uploads \
  -e NODE_ENV=development -e MINIFY_JS=1 -e HSTS=0 -e LOG_CONSOLE_MIRROR=0 \
  -e BASE_URL="http://${APP}:3000" -e SMTP_HOST=mailpit -e SMTP_PORT=1025 -e SMTP_ALLOW_PLAINTEXT=1 \
  -e EMAIL_FROM=no-reply@perf.test \
  "${ALLOW_ENV[@]}" "${EXTRA_ENV[@]}" "$APP_IMAGE" >/dev/null

for i in $(seq 1 60); do
  if podman exec "$APP" node -e "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 1
  [ "$i" = 60 ] && { podman logs "$APP" | tail -40; echo "app never became ready" >&2; exit 1; }
done
SA_PW="$(podman exec "$APP" cat /app/data/.superadmin-password)"
log "app ready; engaging the maintenance gate for the seed"
podman exec "$APP" sh -c "printf '%s' '$BYPASS' > /app/data/.maintenance"

log "seed ($USERS participants, one live event)"
podman run --rm --name "$SEED" --network "$NET" --ip "$SEED_IP" --user root \
  -v "${ROOT_MOUNT}:/w" -e DATA_DIR=/tmp/unused -e UPLOADS_DIR=/tmp/unused-up "$APP_IMAGE" \
  node /w/perf/seed.js --base-url "http://${APP}:3000" --confirm-live --maintenance-bypass "$BYPASS" \
  --superadmin-password "$SA_PW" --participant-count "${SEED_USERS:-$USERS}" --task-count 10 --skip-bg --skip-history \
  --admin-count 0 --competition-start-offset -300 --competition-duration 240 > "$OUT/seed.log" 2>&1 \
  || { cat "$OUT/seed.log"; exit 1; }
tail -4 "$OUT/seed.log"
cp perf/results/seed-data.json "$OUT/seed-data.json"
log "opening the gate (production-like: no bypass token in play)"
podman exec "$APP" rm -f /app/data/.maintenance

log "monitor (superadmin /metrics scrape + limiter control)"
MON_DURATION=$(( WINDOW + HOLD + 600 ))
podman run -d --name "$MON" --network "$NET" --ip "$MON_IP" --user root \
  -v "$VOL_DATA":/data:ro -v "${ROOT_MOUNT}:/w" "$APP_IMAGE" \
  sh -c "STORM_MONITOR_ALLOW_HTTP=1 BASE_URL=http://${APP}:3000 SUPERADMIN_PASSWORD_FILE=/data/.superadmin-password OUT=/w/${OUT_REL}/monitor.jsonl DURATION_S=${MON_DURATION} node /w/perf/tools/storm-monitor.js" >/dev/null
sleep 8
podman logs "$MON" 2>&1 | tail -2

log "sampler"
touch "$OUT/.sampling"
# podman stats in streaming mode (one call, a line per container every 2 s,
# CPU% computed over the interval); each line is stamped with epoch ms.
stamp() { while IFS= read -r l; do printf '%s;%s\n' "$(date +%s%3N)" "$l"; done; }
stats_stream() {
  podman stats --interval 2 --format '{{.Name}};{{.CPUPerc}};{{.MemUsage}};{{.NetIO}};{{.PIDs}}' "$@" 2>/dev/null | stamp >> "$OUT/podman-stats.csv"
}
stats_stream "$APP" "$MAIL" >/dev/null 2>&1 &
STATS1=$!
( until podman container inspect -f '{{.State.Running}}' "$K6" 2>/dev/null | grep -q true; do [ -f "$OUT/.sampling" ] || exit 0; sleep 1; done
  stats_stream "$K6" ) >/dev/null 2>&1 &
STATS2=$!
(
  while [ -f "$OUT/.sampling" ]; do
    echo "$(date +%s%3N);$(vmload)" >> "$OUT/vm-load.csv"
    podman exec -i "$APP" node - < perf/tools/storm-sessions.js >> "$OUT/db.jsonl" 2>/dev/null || true
    sleep 8
  done
) >/dev/null 2>&1 &
SAMPLER=$!

UPTIME_BEFORE="$(podman inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}}' "$APP")"
log "k6: $USERS VUs, arrivals spread over ${WINDOW}s, hold ${HOLD}s, poll mode $POLL_MODE"
set +e
podman run --name "$K6" --network "$NET" --ip "$K6_IP" --memory 12g --user root \
  -v "${ROOT_MOUNT}:/w" -w /w "$K6_IMAGE" run --quiet --no-color --log-format raw \
  -e BASE_URL="http://${APP}:3000" -e MAILPIT_URL="http://mailpit:8025" \
  -e USERS="$USERS" -e WINDOW_S="$WINDOW" -e HOLD_S="$HOLD" -e STATIC="$STATIC" -e POLL_MODE="$POLL_MODE" \
  -e RUN_LABEL="$LABEL" -e OUT_DIR="/w/${OUT_REL}" \
  /w/perf/k6/scenarios/login-storm.js > "$OUT/k6.log" 2>&1
K6_RC=$?
set -e
rm -f "$OUT/.sampling"; wait "$SAMPLER" 2>/dev/null || true
podman rm -f "$K6" >/dev/null 2>&1 || true; kill "$STATS1" "$STATS2" 2>/dev/null || true
UPTIME_AFTER="$(podman inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}} running={{.State.Running}} oom={{.State.OOMKilled}}' "$APP")"
{ echo "k6_exit=$K6_RC"; echo "app_before=$UPTIME_BEFORE"; echo "app_after=$UPTIME_AFTER"; echo "vm_load_after=$(vmload)"; echo "finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } >> "$OUT/env.txt"
log "k6 exit $K6_RC; app $UPTIME_AFTER"
grep -v '^STORMREC ' "$OUT/k6.log" | tail -40 || true
grep '^STORMREC ' "$OUT/k6.log" | sed 's/^STORMREC //' > "$OUT/vu-records.jsonl" || true

podman rm -f "$MON" >/dev/null 2>&1 || true
podman logs "$APP" > "$OUT/app-stdout.log" 2>&1 || true
podman cp "$APP:/app/data/logs" "${ROOT_MOUNT}/${OUT_REL}/app-logs" >/dev/null 2>&1 || true
curl_mail() { podman exec "$APP" node -e "fetch('http://mailpit:8025/api/v1/messages?limit=1').then(r=>r.json()).then(d=>console.log(JSON.stringify({total:d.total}))).catch(e=>console.log(JSON.stringify({error:String(e)})))"; }
echo "mailpit=$(curl_mail)" >> "$OUT/env.txt"

podman run --rm --user root -v "${ROOT_MOUNT}:/w" "$APP_IMAGE" node /w/perf/tools/storm-report.js "/w/${OUT_REL}" \
  || log "report generation failed"
log "artefacts in ${OUT_REL}/"
exit "$K6_RC"
