#!/bin/bash
# scripts/watch-metrics.sh
#
# Polls GET /metrics (admin-only, Prometheus text exposition) every N
# seconds and appends a CSV row to perf/results/metrics-<timestamp>.csv.
# Primary use: sustained-run health monitoring. An N-hour k6 run paired
# with this script produces a graphable RSS / heap / cache-size / latency
# curve so leaks and slow drift are visible post-run without streaming
# the entire metrics feed.
#
# Usage:
#   BASE_URL=http://127.0.0.1:4100 DATA_DIR=/path/to/that/server/data \
#     ./scripts/watch-metrics.sh                  # 30s interval, default
#   BASE_URL=… SUPERADMIN_PASSWORD=… ./scripts/watch-metrics.sh 10   # 10s interval
#   BASE_URL=… DATA_DIR=… \
#     MAINTENANCE_BYPASS="$(cat "$DATA_DIR/.maintenance")" \
#     ./scripts/watch-metrics.sh
#
# Required env:
#   BASE_URL              REQUIRED, no default — the server to poll.
#   SUPERADMIN_PASSWORD   the built-in superadmin's password; or, instead,
#   DATA_DIR              the data directory OF THAT SERVER, whose
#                         .superadmin-password (the boot-time auto-generated
#                         password file) is read.
#   MAINTENANCE_BYPASS    optional: the token in $DATA_DIR/.maintenance, if that
#                         server is in maintenance mode.
#
# v8.13.3 — NOTHING IS GUESSED. This used to default BASE_URL to
# http://localhost:3000 and read data/.superadmin-password relative to the
# current directory — the "guessed path reads the live credential" class v8.8.27
# removed from perf/config.js. Run from a developer's checkout, both guesses named
# the operator's own dev instance (and ./data has been a symlink to a live
# deployment), so a script meant for a throw-away perf target signed in to the
# wrong server with that server's password. Both are refused now, before any
# request is sent.
#
# Output CSV columns:
#   timestamp_utc, uptime_s, rss_bytes, heap_used_bytes,
#   cache_leaderboard, cache_competition, cache_me, cache_rate_limit,
#   cache_analytics, requests_total, rate_limited_429,
#   latency_p50_ms, latency_p95_ms, latency_p99_ms
#
# Ctrl+C to stop; the CSV is written row-by-row so partial data is
# preserved even on interrupt.

set -euo pipefail

BASE_URL="${BASE_URL:-}"
INTERVAL="${1:-30}"
BYPASS="${MAINTENANCE_BYPASS:-}"
PASS="${SUPERADMIN_PASSWORD:-}"

if [ -z "$BASE_URL" ]; then
  echo "ERROR: BASE_URL is required — the server to poll (e.g. http://127.0.0.1:4100)." >&2
  echo "       There is no default: a guessed localhost:3000 is somebody's dev instance." >&2
  exit 1
fi
# If the password is not given explicitly, read the boot-time file — but only
# from a DATA_DIR the caller named, never from a path relative to the cwd.
if [ -z "$PASS" ] && [ -n "${DATA_DIR:-}" ]; then
  if [ -f "$DATA_DIR/.superadmin-password" ]; then
    PASS="$(cat "$DATA_DIR/.superadmin-password")"
  else
    echo "ERROR: no .superadmin-password in DATA_DIR ($DATA_DIR)." >&2
    exit 1
  fi
fi
if [ -z "$PASS" ]; then
  echo "ERROR: superadmin password not provided." >&2
  echo "       Set SUPERADMIN_PASSWORD, or DATA_DIR to the data directory of the server at $BASE_URL." >&2
  exit 1
fi

OUT_DIR="perf/results"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/metrics-$STAMP.csv"
# v6.12.13 — long-form sibling CSV capturing per-route latency buckets
# exposed by /metrics. One row per (ts, route) per poll interval; all
# routes with ≥1 sample in their reservoir are emitted. Analysis: sort
# the p95 column after the run to rank routes by tail latency, or
# pivot into a time-series to watch individual routes drift. Kept
# separate from the narrow main CSV so the two shapes don't collide.
ROUTES_OUT="$OUT_DIR/metrics-$STAMP-routes.csv"
mkdir -p "$OUT_DIR"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Build curl header args array. Only include bypass header when set —
# local dev without .maintenance won't need it.
HDR_ARGS=()
if [ -n "$BYPASS" ]; then HDR_ARGS+=(-H "x-maintenance-bypass: $BYPASS"); fi

# Login flow — extracted so the main loop can re-auth when the
# 60-minute session cookie expires (server has no `rolling:true`,
# so the cookie's maxAge is absolute from login time, not reset
# per request).
do_login() {
  # Reset the jar on re-login so stale cookies don't leak into the
  # new POST.
  : > "$COOKIE_JAR"
  local csrf
  csrf="$(curl -sS -c "$COOKIE_JAR" "${HDR_ARGS[@]}" "$BASE_URL/api/csrf-token" \
    | grep -oE '"csrfToken":"[^"]+"' | cut -d'"' -f4 || true)"
  if [ -z "$csrf" ]; then
    echo "[watch-metrics] ERROR: couldn't fetch CSRF token from $BASE_URL/api/csrf-token" >&2
    return 1
  fi
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -b "$COOKIE_JAR" -c "$COOKIE_JAR" "${HDR_ARGS[@]}" \
    -H "x-csrf-token: $csrf" -H "content-type: application/json" \
    -X POST "$BASE_URL/api/login" \
    -d "{\"email\":\"superadmin\",\"password\":\"$PASS\"}")"
  if [ "$status" != "200" ]; then
    echo "[watch-metrics] ERROR: superadmin login failed (HTTP $status)" >&2
    return 1
  fi
  return 0
}

if ! do_login; then
  echo "ERROR: initial login failed. Is the server running at $BASE_URL?" >&2
  echo "       Check SUPERADMIN_PASSWORD, or that DATA_DIR is that server's data directory." >&2
  exit 1
fi

echo "timestamp_utc,uptime_s,rss_bytes,heap_used_bytes,cache_leaderboard,cache_competition,cache_me,cache_rate_limit,cache_analytics,requests_total,rate_limited_429,latency_p50_ms,latency_p95_ms,latency_p99_ms" > "$OUT"
echo "timestamp_utc,route,count,p50_ms,p95_ms,p99_ms" > "$ROUTES_OUT"

echo "[watch-metrics] writing to $OUT + $ROUTES_OUT every ${INTERVAL}s (Ctrl+C to stop)"

# Helper: extract the numeric value of a Prometheus metric line.
# Handles both `name value` and `name{labels} value` shapes. Guards
# `grep` against no-match exit with `|| true` so `set -o pipefail`
# can't kill the script when a metric is momentarily missing.
field() {
  local pat="$1"
  { echo "$METRICS" | grep -E "$pat" || true; } | head -n1 | awk '{print $NF}'
}

while true; do
  # Capture status + body in one curl call so we can detect 401 and
  # trigger re-login. The server's session cookie has maxAge=60min
  # with no rolling, so ~every hour we need to re-auth.
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  HTTP_CODE_FILE="$(mktemp)"
  METRICS="$(curl -sS --max-time 10 -b "$COOKIE_JAR" "${HDR_ARGS[@]}" \
    -w '%{http_code}' -o /dev/stdout "$BASE_URL/metrics" 2>/dev/null || true)"
  # Strip the trailing 3-digit HTTP status code that -w appended.
  STATUS="${METRICS: -3}"
  METRICS="${METRICS:0:${#METRICS}-3}"
  rm -f "$HTTP_CODE_FILE"

  if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
    echo "[watch-metrics] $TS — session expired (HTTP $STATUS), re-logging in"
    if do_login; then
      continue   # retry immediately with fresh cookie
    fi
    # Re-login failed; log and back off.
    sleep "$INTERVAL"
    continue
  fi
  if [ "$STATUS" != "200" ] || [ -z "$METRICS" ]; then
    echo "[watch-metrics] $TS — /metrics fetch failed (HTTP ${STATUS:-?}), retrying in ${INTERVAL}s"
    sleep "$INTERVAL"
    continue
  fi

  UPTIME=$(field '^hack_arena_process_uptime_seconds ')
  RSS=$(field '^hack_arena_process_memory_rss_bytes ')
  HEAP=$(field '^hack_arena_process_memory_heap_used_bytes ')
  CACHE_LB=$(field '^hack_arena_cache_sizes\{cache="leaderboard"\}')
  CACHE_COMP=$(field '^hack_arena_cache_sizes\{cache="competition"\}')
  CACHE_ME=$(field '^hack_arena_cache_sizes\{cache="me"\}')
  CACHE_RL=$(field '^hack_arena_cache_sizes\{cache="rate_limit"\}')
  CACHE_AN=$(field '^hack_arena_cache_sizes\{cache="analytics"\}')
  REQS=$(field '^hack_arena_requests_total ')
  RL429=$(field '^hack_arena_rate_limited_429 ')
  P50=$(field '^hack_arena_latency_ms\{quantile="0.5"\}')
  P95=$(field '^hack_arena_latency_ms\{quantile="0.95"\}')
  P99=$(field '^hack_arena_latency_ms\{quantile="0.99"\}')

  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$TS" "${UPTIME:-0}" "${RSS:-0}" "${HEAP:-0}" \
    "${CACHE_LB:-0}" "${CACHE_COMP:-0}" "${CACHE_ME:-0}" "${CACHE_RL:-0}" "${CACHE_AN:-0}" \
    "${REQS:-0}" "${RL429:-0}" \
    "${P50:-0}" "${P95:-0}" "${P99:-0}" \
    >> "$OUT"

  # v6.12.13 — per-route long-form rows. Parse the
  # `hack_arena_latency_by_route_ms{route="...",quantile="..."}` and
  # `hack_arena_requests_by_route_total{route="..."}` lines into a
  # route→{p50,p95,p99,count} map, then emit one CSV row per route.
  # Node does the parsing because bash/awk handling of quoted-with-
  # spaces labels is fragile. Failures here never kill the loop — the
  # main CSV is authoritative; the sibling is a diagnostic add-on.
  TS="$TS" METRICS="$METRICS" node -e '
    const m = process.env.METRICS || "";
    const routes = Object.create(null);
    for (const line of m.split("\n")) {
      let r;
      if (r = line.match(/^hack_arena_latency_by_route_ms\{route="([^"]+)",quantile="([^"]+)"\}\s+([\d.]+)/)) {
        (routes[r[1]] = routes[r[1]] || {})[r[2]] = r[3];
        continue;
      }
      if (r = line.match(/^hack_arena_requests_by_route_total\{route="([^"]+)"\}\s+(\d+)/)) {
        (routes[r[1]] = routes[r[1]] || {}).count = r[2];
      }
    }
    const ts = process.env.TS;
    const csvEsc = (s) => (s.includes(",") || s.includes("\"") || s.includes("\n"))
      ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
    for (const [name, d] of Object.entries(routes)) {
      process.stdout.write(
        ts + "," + csvEsc(name) + "," + (d.count || 0) + "," +
        (d["0.5"] || 0) + "," + (d["0.95"] || 0) + "," + (d["0.99"] || 0) + "\n"
      );
    }
  ' >> "$ROUTES_OUT" 2>/dev/null || true

  # Terse stdout line so the operator can eyeball progress without
  # tail-f'ing the CSV. Format chosen so a memory leak is visible at
  # a glance: rss + heap in MB, leaderboard cache count, p95 in ms.
  RSS_MB=$(( ${RSS:-0} / 1048576 ))
  HEAP_MB=$(( ${HEAP:-0} / 1048576 ))
  echo "[watch-metrics] $TS  rss=${RSS_MB}MB  heap=${HEAP_MB}MB  lb_cache=${CACHE_LB:-0}  reqs=${REQS:-0}  p95=${P95:-0}ms"

  sleep "$INTERVAL"
done
