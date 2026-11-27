# Perf baselines — LAN + WAN

> **Caveat (v8.9.1).** Every run recorded here was made with a harness that sent
> no `gradingHash`, so every `submit_answer` sample below measured the server's
> 409 refusal — a hash check and nothing else — rather than a graded submission
> (parse, grade, write, leaderboard invalidation, post-commit events), and every
> `correct_submissions` count was zero by construction. Treat the `submit_answer`
> rows as an upper bound on the refusal path, not a baseline for grading; the
> other endpoints are unaffected. See README § "Every submit in the harness had
> been refused since v7.20.9".

Reference results for the `competition-live.js` k6 scenario against a
**production-sized DB** (history-seeded: ~100 ended competitions × ~200
participants + 5,000 background users — see `README.md` § "Phase 0b"). Two
baselines are recorded:

1. **LAN** — load generator next to the target (sub-millisecond RTT). Measures
   pure server processing.
2. **WAN (emulated)** — the same run with `wan-emulate.sh` injecting a
   `continental` profile (≈80 ms RTT ±15 ms jitter, 0.1% loss) on the LG's
   egress. Measures real-world latency behaviour without a remote load box.

Both runs: **300 protocol VUs, 4 h, `BROWSER_PROBES=2`, `ADMIN_VUS=1`,
`LOG_ADMIN_VUS=1`**, on a `v7.2.x` server. Diff future runs against these to spot
regressions; the per-metric thresholds live in `k6/scenarios/competition-live.js`.

> **These baselines predate two changes to the scenario.** Participants now poll
> `GET /api/participant/pulse` (metric `pulse_poll`, which replaced the
> `/api/status` `status_poll` in the tables below), and three organiser VUs
> (`ORGANISERS`, default 3) poll the workspace Overview's `overview-pulse`.
> `--env ORGANISERS=0` removes the organiser load but does not bring back the
> `/api/status` poll, so a comparable run needs a new baseline.

> Secrets are shown as placeholders. `<MAINTENANCE_TOKEN>` is the content of
> `DATA_DIR/.maintenance` on the target; `<SUPERADMIN_PASSWORD>` is the content of
> `DATA_DIR/.superadmin-password`. `<TARGET>` is the public host (example:
> `hackarena.pogrebisky.net`). `<IFACE>` is the LG's egress interface (find it
> with `ip -o route get 1.1.1.1`; example: `ens160`).

---

## Reproduction commands

### Common — on the target server (once)
Put the target in maintenance mode so the seeder's bulk endpoints are reachable
and public traffic is gated (see `README.md` § Prerequisites):

```bash
# on the target (DATA_DIR is the server's data volume)
head -c 16 /dev/urandom | xxd -p > "$DATA_DIR/.maintenance"   # the bypass token
cat "$DATA_DIR/.maintenance"        # → use as <MAINTENANCE_TOKEN>
cat "$DATA_DIR/.superadmin-password" # → use as <SUPERADMIN_PASSWORD>
```

### Seed (both LAN and WAN use the same seed)
From the load generator (`cd perf/`). `--participant-count` MUST be ≥ `VU_COUNT`
(the scenario refuses to start otherwise); 300 → seeds 316 with the buffer.
History seeding is batched + non-fatal (CTF-0024), so it can't strand the run.

```bash
node seed.js \
  --confirm-live \
  --base-url https://<TARGET> \
  --maintenance-bypass <MAINTENANCE_TOKEN> \
  --superadmin-password <SUPERADMIN_PASSWORD> \
  --participant-count 300 \
  --browser-probes 2 \
  --task-count 30 \
  --history-comps 100 \
  --history-participants 200 \
  --competition-start-offset -180 \
  --competition-duration 250
```

Wait for `Seed data written to …` before launching k6 (that line is the proof
the protocol pool was created). `--competition-start-offset -180` makes the
competition already-live at seed time; `--competition-duration 250` keeps it
live for the full 240-minute run.

### LAN run — k6
```bash
k6 run \
  --env BASE_URL=https://<TARGET> \
  --env MAINTENANCE_BYPASS=<MAINTENANCE_TOKEN> \
  --env TEST_DURATION=240m \
  --env VU_COUNT=300 \
  --env RAMP_UP=2m \
  --env BROWSER_PROBES=2 \
  --env ADMIN_VUS=1 \
  --env LOG_ADMIN_VUS=1 \
  k6/scenarios/competition-live.js
```

### WAN run — emulate, sanity-check, run, tear down
```bash
cd perf
# 1) apply the WAN profile to the TARGET ONLY (SSH to the LG is untouched)
sudo ./wan-emulate.sh on continental <TARGET>
./wan-emulate.sh status            # confirm the htb qdisc + dst-IP filter

# 2) sanity-check the added latency BEFORE the 4 h run
curl -s -o /dev/null -w 'connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s\n' \
  https://<TARGET>/api/status
#   expect connect≈0.08s, total≈0.25–0.35s (vs ~0.001s on LAN)

# 3) the SAME k6 command as the LAN run
k6 run --env BASE_URL=https://<TARGET> --env MAINTENANCE_BYPASS=<MAINTENANCE_TOKEN> \
  --env TEST_DURATION=240m --env VU_COUNT=300 --env RAMP_UP=2m \
  --env BROWSER_PROBES=2 --env ADMIN_VUS=1 --env LOG_ADMIN_VUS=1 \
  k6/scenarios/competition-live.js

# 4) ALWAYS remove the shaping afterwards
sudo ./wan-emulate.sh off <IFACE>
```

Other presets: `regional` (30 ms), `intercontinental` (160 ms), `mobile`
(120 ms + 1% loss + 8 mbit cap). See `README.md` § "WAN emulation".

---

## Results

Run shape (both): ~4 h, 300 VUs, ramp 2 m. LAN ≈ 21,749 iterations /
838,907 requests / 57.5 req/s; WAN ≈ 21,080 / 816,856 / 56.0 req/s.

### Health — flat across LAN→WAN (the headline: WAN doesn't dent the server)
| Metric | LAN | WAN (80 ms / 0.1%) | Budget |
|---|---|---|---|
| `http_req_failed` | **0.08%** (654/838.9k) | **0.08%** (655/816.9k) | <15% |
| `session_errors` | 316 | 315 | <425 |
| `csrf_failures` | 164 | 186 | <245 |
| `sqlite_busy_errors` | 0 | 0 | <1 |
| 5xx / 429 / 413 | 0 / 0 / 0 | 0 / 0 / 0 | <5 each |
| throughput | 57.5 req/s | 56.0 req/s | — |
| iterations | 21,749 | 21,080 | — |

The 401/CSRF blips are expected re-auth churn (60-min session TTL +
single-session enforcement), not faults. `session_errors` and error rate are
**identical** under WAN → the workload is think-time-dominated, so RTT barely
touches throughput, concurrency, or correctness.

### Participant API — p90 (small payloads → rises by ≈ one RTT under WAN)
| Endpoint | LAN p90 | WAN p90 |
|---|---|---|
| `http_req_duration` (overall) | 2.82 ms | 114.6 ms |
| status-poll | 3.22 ms | 107.2 ms |
| submit-answer | 7.05 ms | 113.5 ms |
| task-list | 4.11 ms | 103.5 ms |
| task-detail | 1.65 ms | 103.8 ms |
| leaderboard | 56.1 ms | 135.6 ms |
| select-competition | 2.39 ms | 144.4 ms |
| reveal-hint | 6.65 ms | 112.9 ms |
| login_flow (csrf+login+csrf) | 88 ms | 372 ms |
| csrf_fetch | 2.94 ms | 91.3 ms |

`login_flow` is 3 round-trips, so it pays ~3× the RTT.

### Admin reads — p90 (large payloads → pay MULTIPLE RTTs under WAN)
| Endpoint | LAN p90 | WAN p90 | ≈ RTTs added |
|---|---|---|---|
| **analytics_global** | **1.55 s** | **1.76 s** | ~1× |
| analytics_competition | 40.0 ms | 171.1 ms | ~2× |
| leaderboard (admin) | 49.3 ms | 216.0 ms | ~2× |
| submissions | 20.3 ms | 146.2 ms | ~2× |
| logs | 12.2 ms | 260.0 ms | ~3× |
| history_user | 4.6 ms | 133.0 ms | ~2× |
| history_competition | 10.1 ms | 303.6 ms | ~4× |
| **participants** | 16.1 ms | **611.7 ms** | ~7× |
| **logs_access** | 19.4 ms | **762.7 ms** | ~9× |

This is the **key WAN finding**: large JSON responses don't fit the initial TCP
congestion window, so they need several 80 ms round-trips to drain (bandwidth-
delay product). **Payload size amplifies WAN latency** — the participants/logs
endpoints degrade far more than the small participant calls. All still well under
their 1–6 s thresholds, but if admins drive the dashboard over a WAN link,
response compression / tighter pagination on those endpoints is where it pays.

### Browser probes — real page-level UX (the WAN cost users feel)
| Metric | LAN | WAN | Budget |
|---|---|---|---|
| `browser_page_load` p90 | 1.07 s | 1.42 s | <10 s |
| web-vital LCP p90 | 0.92 s | 1.19 s | — |
| web-vital TTFB p90 | 61 ms | 436 ms | — |
| `browser_http_req_failed` | 6.1% | 10.7% | — |
| `browser_phase_timeouts` | 0 | 60 (52 task_list, 8 task_detail) | <190 |
| `browser_request_failures{api}` | 1,114 | 2,288 | <2,895 |

Page-load feels RTT *multiplicatively* (a few critical-path round-trips).
`browser_request_failures{api}` reaches **~79% of budget** under `continental` —
a harsher preset will likely breach it (see "What to watch").

### WAN latency sanity check (pre-run, `continental`)
```
connect=0.093 s  tls=0.237 s  total=0.323 s
```
≈ three outbound legs of the +80 ms egress delay (TCP connect → TLS → request),
confirming the shaping hit the k6 path. LAN baseline for the same curl is ~1 ms.

---

## What to watch / interpretation

- **Server capacity is not the bottleneck.** 1.3 ms median processing at 57 req/s
  is enormous headroom; WAN latency changes client-observed latency, not the
  server's throughput or error rate.
- **`analytics_global` (~1.5 s) is the endpoint to track as history grows** — it
  aggregates `challenge_events` across all competitions. On an empty DB it read
  ~0 ms and told you nothing; the history seed is what surfaced its real cost.
- **Large admin payloads amplify WAN latency** (BDP, multiple RTTs). If
  WAN-admin is a real use case, prioritise compression/pagination on
  `participants` and `logs`/`logs_access`.
- **Harsher WAN presets need budget tuning.** `intercontinental` (160 ms) or
  `mobile` (loss + bandwidth cap) will likely push `browser_request_failures{api}`
  and `browser_phase_timeouts` past budget — raise them via the env knobs from
  CTF-0021/0022 (`BROWSER_REQ_FAIL_MAX` / `BROWSER_REQ_FAIL_PER_MIN`,
  `BROWSER_TIMEOUT_MAX` / `BROWSER_TIMEOUT_PER_MIN`) for a worst-case run.
- **Predicting WAN from LAN:** API per-request latency ≈ `RTT + (LAN p90)`;
  large admin reads ≈ `(several × RTT) + (LAN p90)`; throughput / error rate /
  session churn ≈ unchanged. Bandwidth saturation, packet loss/jitter tails, and
  intermediary idle-timeouts are the parts a LAN run *can't* predict — that's
  what the emulated-WAN run is for.

---

## 3000-user sign-in storm — FINAL (2026-11-01)

> **Provenance.** Commit `5b6f5bd` (and `b744f4c`, `f268f9d` below) is a development commit that is not in main's history: its work reached main squashed into v9.1.1 (`7cd19c8c`). The raw artefacts were kept outside the repository and are not available. The sign-in path has changed since (the entry screen's `POST /api/auth/sign-in-method` lookup, and a signed-out load asking `GET /api/session/status` instead of `GET /api/me`), and the 3000-user figures have not been re-measured on it.

**Verdict: PASS for 3000 people arriving within 60 s** (the judged run, mode A, the
criteria below), twice in a row on the measured commit. **The 10 s spike does NOT meet
the 10 s target at 3000** (p95 70.4 s with the default SMTP pool; 27.9 s with
`SMTP_POOL_MAX_CONNECTIONS=64`): one Node thread cannot do 3000 sign-ins' work in 10 s,
which these runs measure (below). Mode B (one unlisted NAT address) is reported, not
judged.

**Setup.** Commit `5b6f5bd` (8.17.0 plus the sign-in lookup fixes below), image built
from it. Podman machine VM 22 vCPU / 49 GB, otherwise idle: 1-minute load 0.2–3.3
during every final run, nothing else running (the shared VM was checked before each
run). App container **`--cpus 4 --memory 4g`**, as in the 1000-user runs; one Node
process (CLAUDE.md *Architecture*: no replicas, no cluster). Mailpit v1.21 (`--cpus 4
--memory 2g`), k6 `grafana/k6:1.3.0`, on their own network (`perf/storm-podman.sh
--prefix p3k`). Seed: 3016 participants enrolled in one live Tournament, 10 challenges.
Rate limiting ON (limiter control: 12 × 429 from a non-allowlisted address in every
run); mode A lists the load generator's address as the venue's trusted network
(`RATE_LIMIT_ALLOWLIST_IPS`), which never lifts the account lockout or the sign-in-code
send caps. Every sign-in is the real door: CSRF token, code request, the code read back
from the relay's inbox, redeem (one-time code), landing.

**Criteria** (perf/README.md § "1000-user sign-in storm", unchanged, N = 3000):
≥ 99.5 % signed in; p95 arrival → signed in (mail included) < 10 s; no 5xx; no
restart or OOM; steady-poll p95 < 500 ms.

| run (commit) | signed in | p95 / p99 arrival → signed in | 5xx (clients / access log) | no answer in 60 s | restart / OOM | poll p95 | app CPU avg / max (100 % = one core) | RSS max | event loop blocked (avg; worst 5 s) | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **final3k-A-60s** (`5b6f5bd`) | **3000/3000** | **0.42 s / 0.61 s** | 0 / 0 | 0 | none / no | 2.1 ms | 28 % / 88 % | 393 MiB | 10 ms/s; 63 ms/s | **PASS** |
| **final3k-A-60s-r2** (`5b6f5bd`) | **3000/3000** | **0.35 s / 0.40 s** | 0 / 0 | 0 | none / no | 2.0 ms | 28 % / 87 % | 392 MiB | 10 ms/s; 42 ms/s | **PASS** |
| final3k-A-10s (`5b6f5bd`) | 3000/3000 | 70.4 s / 71.5 s | 0 / 0 | 0 | none / no | 2.5 ms | 28 % / 114 % | 426 MiB | 19 ms/s; 214 ms/s | FAIL (p95) |
| final3k-A-10s-pool64 (`5b6f5bd`, `SMTP_POOL_MAX_CONNECTIONS=64`) | 3000/3000 | 27.9 s / 28.6 s | 0 / 0 | 0 | none / no | 3.2 ms | 28 % / 120 % | 393 MiB | 21 ms/s; 203 ms/s | FAIL (p95) |
| final3k-B-60s (`5b6f5bd`, one NAT address, no allowlist) | 569/3000 in the window | 275 s | 0 / 0 | 0 | none / no | 2.1 ms | 18 % / 56 % | 371 MiB | 6 ms/s; 27 ms/s | reported, not judged |

Before the fixes (same machine, same day, commit `f268f9d`): A-60s passed twice (3000/3000,
p95 0.61 s and 0.69 s) but held one core saturated for 24 s; A-10s signed in 3000/3000
with p95 65.4 s and **250 requests that never got an answer** (connections reset or
timed out at the 60 s client deadline); B-60s 565/3000.

**Steady state at 3000** (last 180 s of the hold, every session polling as the SPA does):
256 requests/s at **≈ 21–22 % of one core (≈ 0.85 ms CPU per request)**, RSS ≈ 393 MiB,
poll p95 2 ms; 3000 authenticated session rows, WAL ≤ 4 MiB. Every one of the 3000
sessions was still signed in at the common hold end in every mode-A run, and every user
signed in at the first attempt. Mail (code requested → relay received) p95 28 ms and
24 ms in the 60 s runs.

**What changed** (commit `5b6f5bd`; locks in `tests/storm-hotpaths.api.spec.js`, each
seen failing under its mutation). A CPU profile of the 3000-user 10 s run named three
lookups that scanned a whole table on every sign-in — O(N) each, O(N²) across a rush —
and a kernel queue that dropped connections:

| profile self time (10 s spike, before) | what | fix |
|---|---|---|
| 7.4 % | the single-session purge at every sign-in found the user's sessions with `data LIKE` over every session row | two expression indexes (`userId`, `impersonator.userId`), same ownership rule |
| 3.6 % + 2.1 % + 1.9 % | the account by address (code request, redeem, audit actor) as `LOWER(email)=LOWER(?) OR …`, a full users scan | two indexed point lookups (primary, then secondary) |
| — | the invitation claim at redeem scanned invitations | the partial live-invitation index |
| 33 000 `ListenOverflows` | Node's default listen backlog (511) overflowed: handshakes dropped, page loads waited out SYN retransmits or were reset | listen backlog 4096 (the kernel's `somaxconn`) |

Effect: in the 60 s run the core is saturated (> 85 %) for 3.6 s instead of 24 s, and
sign-in p95 is 0.35–0.42 s instead of 0.61–0.69 s; in the 10 s spike no connection is
dropped any more (0 unanswered, was 250), the saturated stretch fell from 28 s to 22 s
and the app container's CPU over the burst's first two minutes from 63 to 55 CPU-seconds;
the scans are gone from the profile.

**Why the 10 s spike still fails — the measured limit.** 3000 people arriving in 10 s
is 300 sign-ins per second, each about 17 requests plus one mail. The app container's
main thread was saturated (> 85 % of a core) for **22 s** (default pool) and **30 s**
(pool of 64, whose faster mail lets redeems arrive sooner) — the work of the burst
takes one thread about three times the window, so arrivals queue (first page load p95
12–16 s) whatever the relay does. What remains in the profile is spread thin: socket
writes ≈ 15 %, SQLite commits for audit rows and session saves ≈ 15 %, the rest under
2.5 % each. The second limit is mail throughput: with the default pool of 16 connections
the relay received the codes over ≈ 57 s (p95 56.7 s; Mailpit was also answering the
harness's ≈ 3000 inbox searches), and with 64 connections in ≈ 9 s (p95 8.1 s). The
single-process rule (CLAUDE.md) forbids the replica that would remove the first limit.
**So: 3000 people arriving over a minute are served in well under a second each;
3000 pressing "Send code" in the same 10 seconds wait up to about half a minute (with
a relay that accepts 64 connections) or about a minute (16).**

**Mode B — one unlisted venue address (reported).** All 3000 share one IP, so the
per-IP `/api/csrf-token` limit admits about 60 sign-ins a minute: 569 were in by the end
of the 5-minute hold (the rest still trying: each attempt waits for a token, about 45 s
in the app, which shows "Busy — retrying…" meanwhile, then asks them to try again; the
scenario as this run used it also waited after its seventh ask, about a minute per
attempt, and these figures were measured with that wait — it now stops at its seventh
ask, as the app does), every one stayed signed
in, no POST went out with an empty token, and the address was **never blocked** (0
scanner blocks). The remedy is unchanged: list the venue on the event's trusted networks.

Reproduce: perf/README.md § "1000-user sign-in storm" → "The 3000-user runs".
Artefacts: `perf/results/storm/final3k-*` and `p3k-*` (gitignored; not kept).

---

## 1000-user sign-in storm — FINAL (2026-10-29, v8.17.0)

**Verdict: PASS.** Both judged runs (mode A, load generator allowlisted as a venue's
trusted network would be) met every criterion on a quiet machine. Image built from
`b744f4c` (the redesign: every lane merged, full suite green); app container
`--cpus 4 --memory 4g`; VM 22 vCPU / 49 GB with nothing else running (1-minute load
0.2–1.4 during every run). Artefacts: `perf/results/storm/<label>/` (gitignored).

| run | signed in | p95 arrival → signed in (mail incl.) | p95 code → in inbox | 5xx | restart | poll p95 | verdict |
|---|---|---|---|---|---|---|---|
| final-A-60s (1000 arrive over 60 s, hold 300 s) | **1000/1000** | **0.29 s** | 0.26 s | 0 | none | 2.4 ms | **PASS** |
| final-A-10s (1000 arrive over 10 s, hold 300 s) | **1000/1000** | **1.51 s** | 0.82 s | 0 | none | 2.4 ms | **PASS** |
| final-B-60s-v3 (one NAT address, NO allowlist) | 412/1000 in the window | 276 s | 0.26 s | 0 | none | 2.4 ms | reported, not judged |

Every one of the 1000 sessions in each mode-A run was still signed in at the common
hold end (the witness that 1000 sessions coexisted), and every user signed in at the
first attempt.

**Steady-state cost** (last 180 s of the hold, 1000 signed-in sessions polling): about
84–88 requests/s at **≈ 10 % of one core** (≈ 1.2 ms of CPU per request) and **< 200 MB**
resident. The 10 s spike is the heaviest moment: 1000 sign-ins (two token fetches,
code request, mail, redeem, landing) inside 11.6 s, no request slower than 106 ms.

**Server requirements, from these runs:** recommended **2 vCPU / 2 GB RAM** for a
1000-person event (an inference, not a run: these were measured under a 4 vCPU / 4 GB
cap, using ~10 % of one core and < 200 MB at steady state, and the app is one
thread); size the SMTP relay for bursts of 1000 messages in
about 10 s (the pool opens at most 16 connections). One process per data volume —
never replicas (see CLAUDE.md *Architecture*).

**Mode B — what one unlisted venue address does now.** All 1000 people share one IP
and every per-IP limiter applies to the room as one client. The per-IP
`/api/csrf-token` limit (120/min) admits about 60 sign-ins a minute, so people wait
their turn rather than being refused (each attempt waits for a token, about 45 s in
the app, which shows "Busy — retrying…" meanwhile, then asks them to try again; the
scenario as this run used it also waited after its seventh ask, about a minute per
attempt, and these figures were measured with that wait — it now stops at its seventh
ask, as the app does): 412 were in by the end of the 5-minute
hold and every one stayed signed in. **The venue address was never
blocked**: no countable 4xx at all (the only non-429 4xx were the 1000 anonymous
`/api/me` identity probes the scanner exempts). Two client defects this run found are
fixed in v8.17.0: the sign-in no longer posts with an EMPTY token when the token fetch
is throttled (56 280 such posts in the first run), and it no longer keeps the dead
pre-sign-in token after the session is replaced (36 × 403 `csrf_invalid` that ended
fresh sessions, whose 401 polls then tripped the scanner block at exactly 100 —
lock: `tests/csrf-busy-backoff.spec.js`). The remedy for a venue stays the same: put
its address on the event's trusted networks (or `RATE_LIMIT_ALLOWLIST_IPS`).

## 1000-user sign-in storm (2026-10-29) — PRE-FINAL (history)

> **Target (operator, 2026-10-29):** at least **1000** simultaneous signed-in users on
> one process, app container `--cpus 4 --memory 4g`. Criteria as stated in
> perf/README.md § "1000-user sign-in storm": ≥ 99.5 % of 1000 signed in; p95
> arrival→signed-in (mail included) < 10 s; no 5xx; no restart; steady-poll p95 <
> 500 ms. Earlier 3000-user runs are kept below as history.
>
> **Status: pre-final.** Every row below is marked with the VM state it ran in.
> The verdict runs (mode A 60 s, mode A 10 s spike, mode B one NAT address) on the
> final image are in the table "Final-image runs"; a run made while the VM's
> 1-minute load exceeded its CPU count is reported but not used for a verdict.

### Profile first: where one thread went (1000 users, legacy SPA polling)

`node --cpu-prof` in the app container during a 1000-user mode-A run (commit
6511cd2 + harness, VM 24 vCPU / 27 GB, quiet: load 1–3). Main-thread self time
over the 150 s steady hold window (sign-in finished), 49.4 % busy at 238 req/s:

| self time (of busy) | where | fix |
|---|---|---|
| 7.7 % | socket `writev` | fewer requests (the pulse) |
| 9.4 % | zlib `_close` + `processChunk`: a gzip/brotli stream per JSON response | `compression({ threshold: 8 KB })`: the 1–3 KB poll bodies go out uncompressed |
| 4.1 % | `stat` from `express.static`, run for every `/api/*` request before falling through | `_publicStaticUnlessApi`: an `/api/` path never asks the disk |
| 4.0 % + 1.6 % | `stripInternal` + map in `buildLeaderboard`: the whole field filtered, sorted and copied per board request | `_rankedBoardMemo`: built once per cached entry set |
| 2.6 % / 2.2 % / 1.8 % | session store `get` / prepared-statement memo / cookie HMAC | per-request floor (unchanged) |

Polling shape per signed-in tab (the SPA before this change): `/api/status` and
`/api/me` every 15 s, `/api/session/status` every 30 s (plus a keepalive POST every
30 s in a live event, which the harness did not even model), and the whole board
every 15 s while its page is open: **14.3 requests per session per minute**.

### What changed

- **One poll, the pulse** (`GET /api/participant/pulse`): status + score + the
  board's version + the session monitor's state; 15 s with ±20 % jitter, 30 s once
  idle and unchanged, never while the tab is hidden. The board is fetched only when
  its version moves (or once a minute); the session monitor reads the pulse; the
  keepalive slides only when < 55 of the 60 minutes remain (was every 30 s).
- The three server hot paths above; a pooled SMTP transport (16 connections) in
  place of a connection per message.

### Before / after at 1000 users (mode A, 60 s window, 180 s hold)

| run | VM | SPA polling | signed in | p95 signed-in | 5xx | poll p95 | steady req/s | req / session / min | app container CPU | main-thread busy (profile) |
|---|---|---|---|---|---|---|---|---|---|---|
| pre-1000-base (profiler on) | 24 vCPU, quiet (load 1–3) | legacy | 1000/1000 | 0.52 s | 0 | 17.8 ms | 237.6 | 14.3 | 101 % | 49.4 % |
| pre-1000-legacy | 22 vCPU / 49 GB, quiet (load ≈ 1) | legacy | 1000/1000 | 0.37 s | 0 | 11.4 ms | 237.7 | 14.3 | 76.5 % (3.2 ms CPU / request) | — |
| pre-1000-pulse (profiler on) | 22 vCPU, quiet (load ≈ 1) | **pulse** | 1000/1000 | 1.50 s | 0 | 22.1 ms | **85.4** | **5.1** | 50.3 % | **16.5 %** |
| pre-1000-pulse-noprof | 22 vCPU, **busy: load 55–64** | pulse | 1000/1000 | 106 s (FAIL) | 0 | 233 ms | 95 | 5.7 | 67 % | — |

Read: the pulse cuts requests per session **2.8×** (14.3 → 5.1 per minute, with
the board page assumed open the whole time — the pessimistic case) and main-thread
time per session **3.0×** (49.4 % → 16.5 % of one thread for 1000 sessions, both
with the profiler on). A pulse costs a little more than one of the requests it
replaced (≈ 1.9 ms vs 2.1 ms main thread per request, profiler on) but there is one
instead of three-and-a-half. Container CPU includes the profiler, GC and threadpool
threads and the sampler's own `podman exec node` processes, so main-thread busy is
the number that bounds a single process. The busy-VM run is not a verdict: the
relay (Mailpit, 50 % CPU) and the app were descheduled, mail took up to 80 s, and
sign-in time is mail time.

### Final-image runs (BUSY VM — not a verdict)

Image built from 8e83c84 (this branch merged with the integration branch), 1000
users, hold 180 s, app `--cpus 4 --memory 4g`, VM 22 vCPU / 49 GB **shared with
other agents' full test suites: 1-minute load 42–60 during the mode-A runs**, so the
app was descheduled (event loop "blocked" 335–400 ms per second while the
container averaged only 56–60 % CPU — it was waiting for a CPU, not using one).

| run | signed in | p95 signed-in | mail p95 (relay received) | 5xx | no answer in 60 s | restart | poll p95 | criteria |
|---|---|---|---|---|---|---|---|---|
| final1000-A-60s | 1000/1000 | 67.2 s | 2.4 s | 0 | 61 (`GET /` page loads) | none | 289 ms | FAIL on p95 signed-in (busy VM) |
| final1000-A-10s (spike) | 1000/1000 | 126.8 s | 3.6 s | 0 | 569 (page loads, `/api/config`; listen-backlog dial timeouts) | none | 768 ms | FAIL (busy VM) |
| final1000-B-60s (one NAT IP, no allowlist) | **76/1000** | 2.4 s (of those 76) | 1.0 s | 0 | 0 | none | 6.9 ms | FAIL — scanner block |

Mode B is a configuration failure, not a capacity one, and it reproduces the
3000-user finding at 1000: with the whole room on one unlisted address the per-IP
`/api/csrf-token` limit (120/min) answers 429, the SPA's sign-in then posts with
an empty CSRF token (55 380 such posts across the retries), each 403
`csrf_invalid` is a countable 4xx, and after 100 of them the scanner tracker blocks
the address for 15 minutes — every later request from the room is a 429
`scanner_block`. A venue must put its address on the event's trusted networks (or
`RATE_LIMIT_ALLOWLIST_IPS`), as perf/README.md requires. The empty-token post is
the sign-in client's (owned by the sign-in work, not changed here).

**Not yet measured on a quiet machine:** the final A-60s / A-10s / B-60s verdict.
Commands: perf/README.md § "1000-user sign-in storm" → "The final 1000-user runs".
On the quiet VM the same pulse build already met every criterion at 1000 users with
a 60 s arrival window (pre-1000-pulse above: 1000/1000, p95 1.5 s with the profiler
on, poll p95 22 ms, no 5xx, no restart), and the legacy build did too
(pre-1000-legacy). The remaining risk at 1000 is the 10 s spike, which was only
ever run on the busy VM.

## 3000-user sign-in storm — PARTIAL (2026-10-29, work interrupted; history)

> **Superseded** by "3000-user sign-in storm — FINAL (2026-11-01)" above (current
> code, quiet machine: 3000/3000 in the 60 s run). Kept as history.
>
> **Status: PARTIAL, criteria NOT met.** Two full 3000-user runs (mode A, 60 s
> window) are recorded. Mode B (one NAT address), the 10 s spike and a capacity
> sweep were NOT run: the shared VM's load stayed at 50–75 (24 vCPUs) from other
> agents' test suites, and the work was stopped before a quiet window. How to
> reproduce: perf/README.md § "3000-user sign-in storm".

**Environment.** Windows host, podman machine VM 24 vCPU / 27 GB (shared). App
container `--cpus 4 --memory 4g` (image built from this branch), Mailpit
v1.21 `--cpus 4 --memory 2g`, k6 `grafana/k6:1.3.0` (`--memory 12g`), all on
`perf-net`. App: `NODE_ENV=development MINIFY_JS=1 HSTS=0 LOG_CONSOLE_MIRROR=0`,
plain http. Seed: 3016 participants enrolled in one live Tournament, 10 challenges.
Limiter control (130 × csrf-token from a non-allowlisted address) fired 429 in both
runs: limiting was ON.

**Criteria (stated before running):** ≥ 99.5 % signed in; p95 arrival→signed-in
(mail included) < 10 s; no 5xx; no restart; steady-poll p95 < 500 ms.

| run | commit | VM load (1 min) | signed in | p95 signed-in | 5xx (server) | restart | poll p95 | verdict |
|---|---|---|---|---|---|---|---|---|
| run1 A-60s baseline (no Accept-Encoding) | 45f7c39 + harness | 2.5 before → 41 after | **496 / 3000 (16.5 %)** | 99.0 s | 0 | none | 6 767 ms | FAIL |
| run2 A-60s with fixes (gzip/br like a browser) | c1e095f | 16.5 – 27.5 | **854 / 3000 (28.5 %)** | 295 s | 0 | none | 4 631 ms | FAIL |

run2 detail: mail latency (request → relay received) p50 1.1 s / p95 4.1 s; code
read from inbox p50 2.8 s / p95 9.0 s; no mail lost; RSS max 348 MiB; WAL max
5.5 MiB; 2125 session rows (854 authenticated) at peak; 20 150 requests got no
answer within the 60 s client deadline (k6 1211 dial timeout: the listen backlog
overflowed, and 1050 request timeout); app container CPU avg 96 % (one Node
thread saturated), event loop blocked 66 % of the run. Server access log: 47 905
answers in ~430 s (~111 req/s), 34 000 of them polls of the 854 signed-in.

### Findings
1. **One Node thread is the ceiling.** At ~3 ms main-thread time per request
   (measured at low VM load too: 500 users/10 s saturated it), the SPA's polling
   alone for 3000 sessions (status + me every 15 s, session status every 30 s,
   leaderboard if open ≈ 500–700 req/s) needs 1.5–2 cores of JS. The
   single-process invariant (CLAUDE.md) forbids replicas, so 3000 concurrent
   active sessions are beyond this design at today's per-request cost.
2. **O(N²) at event start (fixed, 915dbbf):** every first entry busted the
   leaderboard cache, so every board read rebuilt the 3000-row board (~300–600 ms).
   Now coalesced (≤ 1 rebuild/s/board); the rebuild's IN lists use `json_each`.
3. **Per-request waste (fixed, 915dbbf):** `db.prepare` recompiled SQL every call
   (largest self-time); shell/CSS/JS bundle re-encoded, re-hashed and re-compressed
   per request; `statSync` per log line; a throwing read per request for the
   maintenance sentinel.
4. **Congestion collapse:** unanswered requests are still processed later while
   clients retry (code-request 13 k attempts for 3 k people) and the SPA posts
   with an empty CSRF token after a failed token fetch (11.5 k such posts).
5. Mail is not the bottleneck (no loss, seconds of latency) but costs ~5 ms of
   main-thread time per send (nodemailer, unpooled transport).

### Proposed next steps (not implemented)
- lib/email.js (owned by another agent): `pool: true` SMTP transport.
- SPA (public/, owned by another agent): never POST with an empty CSRF token
  (wait and retry the token); longer / jittered polls for large events; merge the
  status and me polls.
- Server: cheaper per-request chain (session HMAC/hash, compression of small
  JSON — brotli stream per response), per-user caches for /api/me and /api/status.
- Mode B guidance (from code, not yet measured): per-IP caps on csrf-token/config
  (120/min) and the 403s from empty-token posts feed the scanner block (100 in
  10 min → whole address blocked 15 min): allowlist the venue / trusted network,
  as perf/README.md already requires.

### Left to do
Mode B 60 s run; A 10 s spike; capacity sweep (largest N passing); re-run on a
quiet VM; graphs (`timeline.svg` is produced per run under perf/results/storm/).
