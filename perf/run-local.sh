#!/usr/bin/env bash
#
# v7.15.33 — one-command local perf run.
#
# WHAT THIS AUTOMATES, AND WHY IT IS NOT JUST A WRAPPER
# ────────────────────────────────────────────────────
# The perf container has always run with RATE_LIMIT_DISABLED=1 for its ENTIRE
# life. That flag exists for one honest reason — seeding thousands of users
# past the 10/min register cap would otherwise take ~500 minutes — but because
# it was never turned back off, the MEASUREMENT never saw rate limiting either.
# So CTF-0026 (per-(IP,email) login buckets + a per-IP backstop), the mechanism
# that decides whether a roomful of participants can all sign in at once, was
# structurally excluded from every perf run ever done.
#
# This script splits the two phases:
#
#   SEED phase     — limiter OFF, so bulk population is fast
#   [restart]      — the only way to flip the flag; also clears the in-process
#                    caches, rate-limit buckets and leaderboard cache, which
#                    gives the measurement a clean baseline rather than one
#                    warmed by the seed
#   MEASURE phase  — limiter ON, which is how production actually runs
#
# It samples CPU / RSS / load / disk for the server, k6 and the host throughout
# and prints a contention report at the end.
#
# SAFETY
#   • Refuses to touch port 3000 (a developer's `npm run dev` lives there).
#   • Runs entirely under perf/.local/ — its own DATA_DIR, its own database.
#   • Puts the target in maintenance mode, as the perf protocol requires, and
#     passes the bypass token to both the seeder and k6.
#   • Kills only the processes it started.
#
# Usage:
#   perf/run-local.sh                      # small profile (default)
#   perf/run-local.sh --profile medium
#   perf/run-local.sh --scenario login-wave --wave-size 300
#   perf/run-local.sh --keep                # leave the server up afterwards
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# ── Defaults ────────────────────────────────────────────────────────────────
PORT=3100
SMTP_PORT=1026
PROFILE=small
SCENARIO=login-wave
WAVE_SIZE=""
WAVE_WINDOW="60s"
VUS=""; DURATION=""; RAMP_UP=""; ADMIN_VUS=""
# Whether the load generator's IP is allowlisted on the MEASURE server.
#
# This is not a convenience switch, it decides what the run measures:
#   • login-wave asks "can a NAT'd venue all sign in?" — the limiter IS the
#     subject, so the generator must NOT be allowlisted.
#   • the capacity scenarios ask "how fast is this endpoint?" — but every one
#     of them drives far more than 120 req/min from a single address, and
#     /api/leaderboard, /api/csrf-token and /api/config are each capped at
#     120/min PER IP. Un-allowlisted, they measure the limiter and nothing
#     else. Allowlisting also mirrors production, where a venue egress IP must
#     be on RATE_LIMIT_ALLOWLIST_IPS anyway (see the cascade finding in the
#     README).
ALLOWLIST_LG=auto
KEEP=0
# v7.15.34 — the seed now runs WITH the limiter on by default. Measured: 2s off
# vs 3s on, clean DB and dirty re-seed alike, because the seeder stopped using
# /api/register in v6.10.80. `--seed-limits off` remains as an escape hatch if a
# future seeder change ever reintroduces a throttled call path.
SEED_LIMITS=on
RUN_ID="$(date +%Y%m%d-%H%M%S)"
LOCAL_DIR="$REPO/perf/.local"
DATA_DIR="$LOCAL_DIR/data"
UPLOADS_DIR="$LOCAL_DIR/uploads"
OUT_DIR="$LOCAL_DIR/runs/$RUN_ID"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)        PORT="$2"; shift 2 ;;
    --profile)     PROFILE="$2"; shift 2 ;;
    --scenario)    SCENARIO="$2"; shift 2 ;;
    --wave-size)   WAVE_SIZE="$2"; shift 2 ;;
    --wave-window) WAVE_WINDOW="$2"; shift 2 ;;
    --vus)         VUS="$2"; shift 2 ;;
    --duration)    DURATION="$2"; shift 2 ;;
    --ramp-up)     RAMP_UP="$2"; shift 2 ;;
    --admin-vus)   ADMIN_VUS="$2"; shift 2 ;;
    --allowlist-lg) ALLOWLIST_LG="$2"; shift 2 ;;
    --keep)        KEEP=1; shift ;;
    --seed-limits) SEED_LIMITS="$2"; shift 2 ;;
    --fresh)       rm -rf "$DATA_DIR" "$UPLOADS_DIR"; shift ;;
    -h|--help)     sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Profiles. `small` is the default deliberately: this is meant to be run on a
# workstation that is also doing other things, and the point of a local run is
# to validate the pipeline and take a resource reading, not to reproduce
# production scale. Scale up once the shape is known to work.
case "$PROFILE" in
  small)  BG_USERS=300;  BG_TASKS=40;  PARTICIPANTS=60;  TASKS=8;  HIST_COMPS=5;  HIST_PARTS=20; HIST_TASKS=5 ;;
  medium) BG_USERS=1500; BG_TASKS=120; PARTICIPANTS=200; TASKS=10; HIST_COMPS=25; HIST_PARTS=60; HIST_TASKS=8 ;;
  full)   BG_USERS=5000; BG_TASKS=300; PARTICIPANTS=300; TASKS=10; HIST_COMPS=100; HIST_PARTS=200; HIST_TASKS=10 ;;
  *) echo "unknown profile: $PROFILE (small|medium|full)" >&2; exit 2 ;;
esac
[ -n "$WAVE_SIZE" ] || WAVE_SIZE="$PARTICIPANTS"
# The seed starts the competition at now + COMP_OFFSET seconds. competition-live
# and submission-burst act on a LIVE competition, so on a short local run the
# shipped 60s offset would have the VUs selecting a competition that has not
# begun; 20s lands it live just after the restart completes.
COMP_OFFSET=60
if [ "$ALLOWLIST_LG" = "auto" ]; then
  case "$SCENARIO" in
    login-wave) ALLOWLIST_LG=off ;;   # the limiter is the subject
    *)          ALLOWLIST_LG=on  ;;   # endpoint capacity is the subject
  esac
fi
case "$SCENARIO" in
  competition-live)    : "${VUS:=10}" ; : "${DURATION:=90s}" ; : "${RAMP_UP:=20s}" ; : "${ADMIN_VUS:=2}" ; COMP_OFFSET=20 ;;
  leaderboard-stress)  : "${VUS:=20}" ;;
  # NEGATIVE: the competition must ALREADY be live when the burst starts.
  # submission-burst fires immediately (per-vu-iterations, a 0-2s stagger), so
  # a future start meant every early submit hit the not-started guard — 82 x 403
  # before the first 200, a 41% "failure rate" that was pure harness timing.
  submission-burst)    : "${VUS:=15}" ; COMP_OFFSET=-60 ;;
esac

BASE_URL="http://localhost:$PORT"
SERVER_PID=""; SINK_PID=""; MON_PID=""

log()  { printf '\033[1;36m[run]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

# Validate the scenario BEFORE any work. An unknown name used to seed the whole
# database, restart the server, fail k6 with exit 255 ("couldn't be found on
# local disk"), and then print the full resource report under a "done" phase —
# which reads as a successful run to anyone skimming, and threw away the seed.
#
# It has to live BELOW the helper definitions: the first version sat with the
# other argument handling ~20 lines above `die()`, so it printed
# "die: command not found" and CARRIED ON — the exact failure it was added to
# prevent, reproduced by the fix for it.
if [ ! -f "$REPO/perf/k6/scenarios/$SCENARIO.js" ]; then
  die "unknown scenario '$SCENARIO' — available: $(cd "$REPO/perf/k6/scenarios" && ls *.js | sed 's/\.js$//' | sort | paste -sd,)"
fi

cleanup() {
  local rc=$?
  [ -n "$MON_PID" ] && kill "$MON_PID" 2>/dev/null
  if [ "$KEEP" = "1" ] && [ -n "$SERVER_PID" ]; then
    log "--keep: leaving the server on $BASE_URL (pid $SERVER_PID); kill it yourself when done"
  else
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
    [ -n "$SINK_PID" ]   && kill "$SINK_PID" 2>/dev/null
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

# ── Pre-flight ──────────────────────────────────────────────────────────────
[ "$PORT" = "3000" ] && die "refusing to use port 3000 — that is where a developer's dev server lives"
command -v k6 >/dev/null || die "k6 is not installed"
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]$PORT[[:space:]]"; then
  _holder=$( (ss -ltnp 2>/dev/null || true) | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  die "port $PORT is already in use${_holder:+ by pid $_holder}. A previous --keep run leaves its server up on purpose; kill it (\`kill ${_holder:-<pid>}\`) or pass --port <n>."
fi
FREE_MB=$(df -Pm "$REPO" | awk 'NR==2{print $4}')
[ "$FREE_MB" -lt 2000 ] && warn "only ${FREE_MB} MB free on this filesystem — the seed writes a SQLite DB plus logs"

mkdir -p "$DATA_DIR" "$UPLOADS_DIR" "$OUT_DIR" "$REPO/perf/results"
BYPASS="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s' "$BYPASS" > "$DATA_DIR/.maintenance"   # perf protocol: gate all traffic

# ── Resource sampler ────────────────────────────────────────────────────────
# Samples once a second: the server's own CPU/RSS, k6's, and the host's load,
# available memory and free disk. Written as CSV so the summary is arithmetic
# rather than an impression.
SAMPLES="$OUT_DIR/resources.csv"
# The sampler is forked before the server exists, and a forked child never sees
# a variable the parent assigns later — so the PID travels through a FILE, the
# same way the phase label does. (First version read $SERVER_PID and silently
# recorded zeros for the entire run.)
PIDFILE="$OUT_DIR/.server.pid"; : > "$PIDFILE"
echo "t,phase,srv_cpu,srv_rss_mb,k6_cpu,k6_rss_mb,load1,mem_avail_mb,disk_free_mb" > "$SAMPLES"
PHASE_FILE="$OUT_DIR/.phase"; echo "startup" > "$PHASE_FILE"
monitor() {
  local t0 now
  t0=$(date +%s)
  while :; do
    now=$(( $(date +%s) - t0 ))
    local scpu=0 srss=0 kcpu=0 krss=0 spid
    spid=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$spid" ] && kill -0 "$spid" 2>/dev/null; then
      read -r scpu srss < <(ps -p "$spid" -o %cpu=,rss= 2>/dev/null | awk '{print $1, int($2/1024)}')
    fi
    # k6 forks; sum every k6 process so a multi-process run is not under-counted.
    read -r kcpu krss < <(ps -C k6 -o %cpu=,rss= 2>/dev/null | awk '{c+=$1; r+=$2} END{printf "%.1f %d", c+0, int(r/1024)}')
    local load1 memav diskf
    load1=$(awk '{print $1}' /proc/loadavg)
    memav=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
    diskf=$(df -Pm "$REPO" | awk 'NR==2{print $4}')
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
      "$now" "$(cat "$PHASE_FILE" 2>/dev/null)" "${scpu:-0}" "${srss:-0}" "${kcpu:-0}" "${krss:-0}" \
      "$load1" "$memav" "$diskf" >> "$SAMPLES"
    sleep 1
  done
}
monitor & MON_PID=$!
phase() { echo "$1" > "$PHASE_FILE"; log "── phase: $1"; }

# ── SMTP sink ───────────────────────────────────────────────────────────────
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]$SMTP_PORT[[:space:]]"; then
  warn "something is already listening on $SMTP_PORT — reusing it as the mail capture"
else
  SINK_PORT="$SMTP_PORT" node "$REPO/perf/tools/smtp-sink.js" > "$OUT_DIR/smtp-sink.log" 2>&1 &
  SINK_PID=$!
  sleep 0.4
fi

# ── Server control ──────────────────────────────────────────────────────────
start_server() {   # $1 = "limits-off" | "limits-on"
  local mode="$1" extra=()
  [ "$mode" = "limits-off" ] && extra+=("RATE_LIMIT_DISABLED=1")
  # Allowlisting bypasses the per-route limiters AND the scanner-reputation
  # tracker, exactly as a production venue egress IP would be configured.
  if [ "$mode" = "limits-on" ] && [ "$ALLOWLIST_LG" = "on" ]; then
    extra+=("RATE_LIMIT_ALLOWLIST_IPS=127.0.0.1,::1")
  fi
  # NODE_ENV is deliberately NOT "production" here, and that is not a shortcut.
  # Only TWO things in the codebase key on it: _MINIFY_JS (set explicitly below,
  # so identical) and SECURE_COOKIE. The second is fatal for a local run:
  # production forces `cookie.secure`, and express-session REFUSES to emit a
  # Secure cookie over plain HTTP — no Set-Cookie, so no session, so every
  # request fails CSRF. The first version of this script set it and the seed
  # died on `403 csrf_invalid`, which points nowhere near the real cause.
  # Rate limiting — the whole point of this run — does NOT depend on NODE_ENV;
  # it is gated solely by RATE_LIMIT_DISABLED. So the local target is
  # production-equivalent in every respect that matters to this measurement.
  # If you ever run this over real TLS, set NODE_ENV=production again.
  env -i PATH="$PATH" HOME="$HOME" \
      PORT="$PORT" \
      BASE_URL="$BASE_URL" \
      DATA_DIR="$DATA_DIR" \
      UPLOADS_DIR="$UPLOADS_DIR" \
      SMTP_HOST=127.0.0.1 SMTP_PORT="$SMTP_PORT" \
      SMTP_ALLOW_PLAINTEXT=1 \
      EMAIL_FROM="no-reply@hackathon.local" \
      SUPERADMIN_PASSWORD_QUIET=1 \
      HSTS=0 \
      MINIFY_JS=1 \
      LOG_CONSOLE_MIRROR=0 \
      "${extra[@]}" \
      node "$REPO/server.js" >> "$OUT_DIR/server-$mode.log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PIDFILE"
  local i
  for i in $(seq 1 90); do
    if curl -fsS -H "x-maintenance-bypass: $BYPASS" "$BASE_URL/api/config" >/dev/null 2>&1; then
      # A session cookie must actually be issued, or everything downstream dies
      # with an unhelpful `csrf_invalid`. Check it once, here, where the cause
      # is still obvious.
      if ! curl -sS -D- -o /dev/null -H "x-maintenance-bypass: $BYPASS" "$BASE_URL/api/csrf-token" 2>/dev/null | grep -qi "^set-cookie"; then
        die "the server issued NO session cookie on /api/csrf-token. Over plain HTTP this means the cookie is marked Secure — check that NODE_ENV is not 'production' and TRUST_PROXY is unset for a local http:// run."
      fi
      log "server up (pid $SERVER_PID, $mode; session cookie verified)"; return 0
    fi
    kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$OUT_DIR/server-$mode.log"; die "server exited during startup ($mode)"; }
    sleep 1
  done
  tail -20 "$OUT_DIR/server-$mode.log"; die "server never became ready ($mode)"
}
stop_server() {
  [ -z "$SERVER_PID" ] && return 0
  kill "$SERVER_PID" 2>/dev/null
  local i; for i in $(seq 1 25); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""; : > "$PIDFILE"
}

# The limiter is NOT probed from the shell. Tripping it would need >120
# requests against /api/csrf-token, spending the same coarse per-IP budget the
# wave is about to measure — the probe would manufacture the failure it was
# meant to rule out. login-wave.js carries its own control instead, against the
# LOGIN limiter, which is the mechanism under test; its summary declares the
# run INVALID if that control never fires.

# ── SEED ────────────────────────────────────────────────────────────────────
# The received wisdom is that seeding REQUIRES the limiter off, because
# /api/register is capped at 10/min. But the seed creates users through
# POST /api/admin/perf/bulk-seed-users, not a register loop, so that rationale
# may be stale. `--seed-limits on` runs the seed against an enabled limiter so
# the question is settled by measurement rather than by repeating the claim.
phase "seed (limiter ${SEED_LIMITS^^})"
if [ "$SEED_LIMITS" = "on" ]; then start_server limits-on; else start_server limits-off; fi
SEED_T0=$(date +%s)
DATA_DIR="$DATA_DIR" node "$REPO/perf/seed.js" \
  --base-url "$BASE_URL" \
  --maintenance-bypass "$BYPASS" \
  --confirm-live \
  --participant-count "$PARTICIPANTS" \
  --task-count "$TASKS" \
  --bg-users "$BG_USERS" \
  --bg-tasks "$BG_TASKS" \
  --history-comps "$HIST_COMPS" \
  --history-participants "$HIST_PARTS" \
  --history-tasks-per "$HIST_TASKS" \
  --competition-start-offset "$COMP_OFFSET" \
  --competition-duration 30 \
  > "$OUT_DIR/seed.log" 2>&1
SEED_RC=$?
SEED_SECS=$(( $(date +%s) - SEED_T0 ))
if [ $SEED_RC -ne 0 ]; then tail -30 "$OUT_DIR/seed.log"; die "seed failed (rc=$SEED_RC) — see $OUT_DIR/seed.log"; fi
log "seed finished in ${SEED_SECS}s (limiter was ${SEED_LIMITS^^})"
# `grep -c` prints its count and then exits 1 when that count is ZERO, so the
# familiar `|| echo 0` fallback APPENDS a second line: the variable holds
# "0\n0" and the numeric test below dies with "integer expression expected".
# `|| true` keeps grep's own printed count and only swallows the exit status;
# the :-0 covers the file being absent, where grep prints nothing at all.
SEED_429=$(grep -c "429" "$OUT_DIR/seed.log" 2>/dev/null || true)
SEED_429=${SEED_429:-0}
[ "${SEED_429:-0}" -gt 0 ] && warn "the seed log mentions 429 ${SEED_429}x — inspect $OUT_DIR/seed.log"

# ── RESTART (limiter ON) ────────────────────────────────────────────────────
phase "restart (limiter ON)"
if [ "$SEED_LIMITS" = "on" ]; then
  log "seed already ran with the limiter ON — restarting anyway to clear its rate-limit buckets and caches, which the measurement needs cold"
fi
stop_server
start_server limits-on
log "load-generator allowlisting: $ALLOWLIST_LG (login-wave=off so the limiter is measured; capacity scenarios=on so the ENDPOINT is)"
log "limiter should now be ACTIVE — login-wave.js's control verifies it in-run"

# ── MEASURE ─────────────────────────────────────────────────────────────────
phase "measure: $SCENARIO"
K6_T0=$(date +%s)
MAINTENANCE_BYPASS="$BYPASS" BASE_URL="$BASE_URL" \
  k6 run \
    --env BASE_URL="$BASE_URL" \
    --env MAINTENANCE_BYPASS="$BYPASS" \
    --env WAVE_SIZE="$WAVE_SIZE" \
    --env WAVE_WINDOW="$WAVE_WINDOW" \
    ${VUS:+--env VU_COUNT="$VUS"} \
    ${DURATION:+--env TEST_DURATION="$DURATION"} \
    ${RAMP_UP:+--env RAMP_UP="$RAMP_UP"} \
    ${ADMIN_VUS:+--env ADMIN_VUS="$ADMIN_VUS"} \
    --env BROWSER_PROBES=0 \
    --summary-export "$OUT_DIR/k6-summary.json" \
    "$REPO/perf/k6/scenarios/$SCENARIO.js" 2>&1 | tee "$OUT_DIR/k6.log"
K6_RC=${PIPESTATUS[0]}
K6_SECS=$(( $(date +%s) - K6_T0 ))
phase "done"
sleep 2

# ── Resource report ─────────────────────────────────────────────────────────
NPROC=$(nproc)
python3 - "$SAMPLES" "$NPROC" "$SEED_SECS" "$K6_SECS" "$K6_RC" <<'PY'
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1])))
ncpu, seed_s, k6_s, k6_rc = int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
def f(r, k):
    try: return float(r[k] or 0)
    except ValueError: return 0.0
print("\n" + "="*72)
print("  RESOURCE REPORT   (%d cores; %%cpu is of ONE core, so %d%% = saturated)" % (ncpu, ncpu*100))
print("="*72)
print("  %-22s %8s %8s %8s %8s" % ("phase", "srv cpu%", "srv MB", "k6 cpu%", "load1"))
phases = []
for r in rows:
    p = r["phase"]
    if p not in [x[0] for x in phases]: phases.append((p, []))
    dict(phases)[p].append(r)
for p, rs in phases:
    if not rs: continue
    print("  %-22s %8.0f %8.0f %8.0f %8.2f" % (
        p[:22], max(f(r,"srv_cpu") for r in rs), max(f(r,"srv_rss_mb") for r in rs),
        max(f(r,"k6_cpu") for r in rs), max(f(r,"load1") for r in rs)))
allr = rows
peak_load = max(f(r,"load1") for r in allr) if allr else 0
min_mem   = min(f(r,"mem_avail_mb") for r in allr) if allr else 0
min_disk  = min(f(r,"disk_free_mb") for r in allr) if allr else 0
peak_srv  = max(f(r,"srv_cpu") for r in allr) if allr else 0
peak_k6   = max(f(r,"k6_cpu") for r in allr) if allr else 0
print("-"*72)
print("  peak server CPU   : %.0f%%  (%.1f of %d cores)" % (peak_srv, peak_srv/100, ncpu))
print("  peak k6 CPU       : %.0f%%  (%.1f of %d cores)" % (peak_k6, peak_k6/100, ncpu))
print("  peak 1-min load   : %.2f   (%s)" % (peak_load,
      "CONTENTION — load exceeds core count" if peak_load > ncpu else "headroom"))
print("  min available RAM : %.0f MB %s" % (min_mem, "  ← LOW" if min_mem < 1024 else ""))
print("  min free disk     : %.0f MB %s" % (min_disk, "  ← LOW" if min_disk < 1024 else ""))
print("  seed %ss   measure %ss   k6 exit %s" % (seed_s, k6_s, k6_rc))
print("="*72)
# The load generator sharing a host with the target is the classic way to
# measure your own laptop instead of the server. Say so when it is happening.
if peak_srv + peak_k6 > ncpu * 100 * 0.8:
    print("  NOTE: server + k6 together approached this host's total CPU. The load")
    print("        generator is competing with the target, so latency numbers are")
    print("        pessimistic. Move k6 to another machine before trusting them.")
    print("="*72)
PY

echo
log "artifacts: $OUT_DIR"
exit $K6_RC
