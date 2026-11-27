# Hack Arena Performance Testing

Load tests simulating a live competition with realistic participant behavior.

## Load Generator Machine Requirements

The load generator runs on a **separate machine** from the system under test and connects via the internet (HTTPS).

### Hardware Sizing

| Test scale | Protocol VUs | Browser probes | Recommended spec |
|-----------|-------------|---------------|-----------------|
| Quick (20 VUs) | 20 | 2 | 2 cores, 4 GB RAM |
| Medium (50 VUs) | 50 | 3 | 4 cores, 8 GB RAM |
| Full (200 VUs) | 200 | 5 | 8 cores, 16 GB RAM |

**Why:** Protocol-level VUs are lightweight (~1 MB RAM each, negligible CPU). Browser probe VUs are heavy — each Chromium instance needs ~1 CPU core + ~1 GB RAM. The bulk of the resource requirement comes from the browser probes.

Rule of thumb: `cores >= browser_probes + 2`, `RAM >= browser_probes * 1.5 GB + 2 GB`.

### Software

- **OS:** Linux (Ubuntu 22.04+ recommended), macOS, or Windows
- **Node.js 18+** — runs `seed.js`
- **k6 v0.52+** — runs the load scenarios
- **Chromium / Chrome** — driven over CDP by `k6 browser` for the render-timing probes
- **Network:** stable internet connection to the system under test with <100ms latency preferred
  - Higher latency is fine but will add a constant offset to all response time measurements — account for it when interpreting results

### Installing the required tools on the load generator

All commands below assume Ubuntu 22.04+. brew / winget equivalents noted inline.

#### Node.js 20 LTS — required by `seed.js`

```bash
# Ubuntu / Debian — nodesource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# macOS
brew install node@20

# Windows
winget install OpenJS.NodeJS.LTS

# Verify
node --version    # v20.x
npm  --version    # 10.x
```

#### k6 v0.52+ — runs the load scenarios

```bash
# Ubuntu / Debian — official k6 apt repo
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install -y k6

# macOS
brew install k6

# Windows
winget install k6.k6

# Verify
k6 version        # k6 v0.52.0 or newer
```

Upstream install docs (fallback for other distros): https://grafana.com/docs/k6/latest/set-up/install-k6/

#### Chromium — required by the `k6 browser` probes

`k6 browser` drives an existing Chromium/Chrome install over CDP; it does **not** bundle a browser of its own. One of `chromium`, `chromium-browser`, or `google-chrome-stable` must be on `$PATH`.

```bash
# Ubuntu 22.04+ — snap (recommended; newer Chromium, sandbox-friendly)
sudo snap install chromium

# Ubuntu / Debian — apt (alternative on hosts without snapd)
sudo apt-get install -y chromium-browser

# macOS
brew install --cask google-chrome       # or: brew install --cask chromium

# Windows
winget install Google.Chrome

# Verify (one of these should print a version string)
chromium --version || chromium-browser --version || google-chrome-stable --version
```

If `k6 browser` cannot auto-locate the binary, point it explicitly:

```bash
export K6_BROWSER_EXECUTABLE_PATH=$(which chromium 2>/dev/null \
  || which chromium-browser 2>/dev/null \
  || which google-chrome-stable)
```

On headless Linux boxes, Chromium also needs a minimal set of shared libraries — `libnss3`, `libatk-bridge2.0-0`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxrandr2`, `libgbm1`, `libpango-1.0-0`, `libasound2`. The snap package bundles these; the apt package pulls them in as deps. If you installed Chrome from a tarball, run `sudo apt-get install -y` on the list above.

#### Clone the repo and install seed deps

```bash
git clone https://github.com/cx-bizops/se-hackarena.git
cd se-hackarena/perf
npm install       # no-op today — seed.js uses stdlib only — but run it anyway so
                  # future deps don't silently break the quick-start path
```

### Network Considerations

- The load generator connects to the same HTTPS URL as production (port 3000 behind reverse proxy)
- All traffic goes through TLS — k6 handles this natively
- If the load generator is on a different continent, expect 100-300ms added to every request; run from the same region as your users for realistic numbers
- Ensure firewalls allow outbound HTTPS from the load generator to the server

## How it works

The perf test runs on the **same server and port** as production but against
a **separate data directory**. This keeps production data (challenges,
participants, analytics, logs) completely untouched — the test creates its
own throw-away database, users, and competitions.

During the test, occasional visitors who hit the URL see a
"Scheduled Maintenance" page. The perf test tooling (seed script, k6
scenarios, browser probes) bypasses the maintenance gate via a secret
token passed in the `X-Maintenance-Bypass` header.

```
┌─────────────────────── Server ───────────────────────┐
│                                                       │
│  Production container (stopped)                       │
│    volumes: /opt/hackarena/data  ← preserved, unused  │
│                                                       │
│  Perf container (running on :3000)                    │
│    volumes: /opt/hackarena/data-perf  ← disposable    │
│    .maintenance file inside → 503 for visitors        │
│                                                       │
└───────────────────────────────────────────────────────┘

┌─── Load generator (separate machine) ───┐
│  seed.js   → creates test data          │
│  k6        → runs load scenarios        │
│  Both send X-Maintenance-Bypass header  │
└─────────────────────────────────────────┘
```

## Rate limiting was never measured — and `run-local.sh` (v7.15.33)

Read this before trusting any historical perf result about login behaviour.

`RATE_LIMIT_DISABLED=1` used to be set in `.env.perf`, and because `env_file`
applies for the container's **entire life** the *measurement* never saw rate
limiting either. CTF-0026 — the per-`(IP, email)` login buckets plus the coarse
per-IP backstop, i.e. the exact mechanism that decides whether a roomful of
participants behind one venue NAT can all sign in at once — was therefore
**structurally excluded from every perf run ever done**.

**As of v7.15.34 the flag is simply gone, because the reason for it no longer
exists.** The justification was the 10/min `/api/register` cap; that rationale
died in v6.10.80 when the seeder moved to `POST /api/admin/perf/bulk-seed-users`.
`seed.js` now calls `/api/register` **zero** times. Of its ~380 requests only
six touch a rate-limited route — 1 × `/api/config`, 2 × `/api/csrf-token`,
1 × `/api/login`, 2 × `/api/admin/participants` — each under **2 %** of its
per-minute budget, while the heavy phases (`bulk-seed-users`,
`bulk-seed-history`, and the 350-call task-create loop) carry **no limiter at
all**. Measured on a medium profile: **2 s with the limiter off, 3 s with it
on**, for a clean database and a dirty re-seed alike.

So there is no seed/measure phase dance to perform on the container: leave the
flag out and the whole run — seed included — happens with production's limiters
active. `run-local.sh` still restarts between the phases, but now only to give
the measurement cold caches and empty rate-limit buckets.

The load shape missed it too. `competition-live.js` defaults to `VU_COUNT=20`
over `RAMP_UP=2m`: about one login every six seconds. A real event start is
three hundred people inside a minute.

`perf/run-local.sh` closes both gaps by splitting the phases:

```
SEED     limiter OFF   (bulk population is fast)
restart                (the only way to flip the flag; also clears the
                        in-process caches and rate-limit buckets, so the
                        measurement starts from a cold, honest baseline)
MEASURE  limiter ON    (how production actually runs)
```

```bash
perf/run-local.sh                                  # small profile, login-wave
perf/run-local.sh --profile medium
perf/run-local.sh --scenario login-wave --wave-size 300 --wave-window 60s

# The same two entry points are wired as npm scripts from the repo root:
npm run perf:local
npm run perf:local:medium
```

Full flag list: `--port`, `--profile`, `--scenario`, `--vus`, `--duration`,
`--ramp-up`, `--admin-vus`, `--wave-size`, `--wave-window`, `--allowlist-lg`,
`--seed-limits`, `--keep`, `--fresh` (`-h` prints it).

It runs entirely under `perf/.local/` (its own `DATA_DIR`, database and logs),
refuses to use port 3000, brings up a throw-away SMTP sink, keeps the
maintenance gate on, and samples CPU / RSS / load / free-disk once a second for
the server, k6 and the host — printing a contention report at the end.

**Two local-only deviations, both deliberate:**

- **`NODE_ENV` is not `production`.** Only two things in the codebase key on it:
  `_MINIFY_JS` (which the script sets explicitly, so identical) and
  `SECURE_COOKIE`. The second is fatal over plain HTTP — express-session
  refuses to emit a `Secure` cookie on an insecure connection, so there is no
  session and every request fails CSRF. Rate limiting, the point of the run,
  does **not** depend on `NODE_ENV`. Set it back to `production` if you ever
  point this at a real TLS endpoint.
- **`SMTP_ALLOW_PLAINTEXT=1`**, because the bundled sink speaks no STARTTLS.
  This is the documented development opt-out from v7.15.12. Never set it on a
  real target.

### Which scenarios allowlist the load generator, and why it decides the result

`run-local.sh` allowlists the load generator's IP on the **measure** server for
the capacity scenarios and **not** for `login-wave`. That is not a convenience
switch — it decides what the run measures at all.

| scenario | allowlisted | because |
|---|---|---|
| `login-wave` | **no** | the limiter IS the subject: can a NAT'd venue all sign in? |
| `leaderboard-stress` | yes | endpoint capacity is the subject |
| `submission-burst` | yes | endpoint capacity is the subject |
| `competition-live` | yes | mixed realistic traffic |

`/api/leaderboard`, `/api/csrf-token` and `/api/config` are each capped at
**120/min per IP**. Any capacity scenario drives far more than that from one
address, so without the allowlist it measures the limiter and nothing else —
20 VUs polling every 1.5 s is ~800 req/min against a 120/min cap. Allowlisting
also mirrors production, where a venue egress IP has to be on
`RATE_LIMIT_ALLOWLIST_IPS` anyway (see the cascade above).

**In production there is now a second, in-app route to the same bypass**
(v7.16.0): a competition's **trusted network IPs** field allowlists an address
for the life of that one event — no env var, no restart, reachable by the admin
who is standing in the room when the venue gets throttled. It is deliberately
constrained where the env var is not: single-session competitions only, inert
before the start and expiring 2 h after the end, /16 at widest, 10 entries max,
and every change audited. Saving it also **lifts an existing scanner block on
that address immediately**, which is what the alert copy promises. For a perf
run against a long-lived target, `RATE_LIMIT_ALLOWLIST_IPS` remains the right
lever — the competition field is scoped to a competition's own window.

### `leaderboard-stress` re-authenticated on every iteration (fixed v7.15.35)

Its header claims it "tests the O(N*M) `buildLeaderboardEntries()` query
pattern", but an iteration was login + select-competition + 20 polls, so a VU
signed in roughly every 30 s. Measured against a limits-ON target, **78 % of its
requests were authentication and 15 % were leaderboard** — an auth benchmark
wearing a leaderboard test's name, and the inflated `/api/csrf-token` volume is
what drove the cascade documented above.

One iteration is now one participant session: the VU signs in once and polls
until the test ends (k6 resets a VU's cookie jar between iterations, so keeping
the session means keeping the iteration open). A failed login now backs off
20–40 s instead of retrying every 5 s — the old retry meant 20 VUs re-attempting
at ~4 logins/s the moment the target started refusing them, the harness
amplifying its own saturation.

| | before | after |
|---|---|---|
| leaderboard share of requests | 15 % | **96 %** |
| auth share | 78 % | **3 %** |
| logins performed | 771 | **25** |
| request failure rate | 69 % | **0.00 %** |

**Results are not comparable with pre-v7.15.35 runs in RESULTS.md** — the
request mix changed deliberately.

### `submission-burst` submitted before the competition was live (fixed v7.15.35)

It reported a 41 % failure rate that had nothing to do with the server: the
scenario fires immediately (`per-vu-iterations`, a 0-2 s stagger) while the seed
started the competition at *now + 20 s*, so every early submit hit the
not-started guard — 82 × 403, all of them before the first 200. The local runner
now seeds this scenario's competition with a **negative** start offset so it is
already live when the burst begins. Result at the time (v7.15.35): 0.00 %
failures, p95 7.46 ms, zero `sqlite_busy_errors`. **That figure was measured on a
harness that sent no grading token** — from v7.20.9 the same scenario answered
409 on every submit (see the next section), so it is not a baseline for the
graded path.

### Every submit in the harness had been refused since v7.20.9 (fixed v8.9.1)

`POST /api/tasks/:id/submit` has REQUIRED a `gradingHash` since v7.20.9 — the
token the SPA reads off the challenge detail and echoes back, so an answer graded
against a key an admin changed mid-flight is refused rather than penalised. A
submission without one is treated as stale: **409 `task_changed`, no row, no
penalty**. Neither `participant.js` nor `submission-burst.js` ever sent it, so for
eleven releases every "correct" submit in `competition-live` and
`submission-burst` was that refusal, and `submitCorrect`'s fallback branch
counted each one as a WRONG answer — the scenarios reported a plausible
correct/wrong split over a submit path that graded nothing. Measured on the
small local profile, 10 VUs × 8 challenges:

| | before | after |
|---|---|---|
| `correct_submissions` | **0** | 55 |
| `wrong_submissions` | 80 (every one a 409) | 25 |
| `http_req_failed` | 66.66 % | 0.00 % |
| `submit_answer` p(90) | (a refusal, no grading, no write) | 6.4 ms |

Both scenarios now read the detail before submitting (`participant.js` already
did; `submission-burst` gained one `task-detail` GET per challenge, which is what
a real participant does) and send the hash. A 409 `task_changed` lands in its own
**`stale_submissions`** counter with a **`count<1`** threshold in both scenarios,
so the next regression of this shape fails the run instead of colouring it.

**Results are not comparable with pre-v8.9.1 runs in RESULTS.md**: every
`submit_answer` latency recorded there measured the refusal path (a hash check
and a 409 — no grading, no transaction, no leaderboard invalidation), and every
`correct_submissions` count was zero by construction.

### FINDING: the CSRF cap cascades into a whole-IP ban

Running `leaderboard-stress` against a limits-ON target produced a 69 % request
failure rate. The server's own access log attributes it exactly:

1. **`/api/csrf-token` is capped per-IP at 120/min** (`RATE_LIMIT_CSRF_PER_MIN`)
   with no account keying. Observed peak 259/min → **745 × 429**.
2. Requests then proceed without a valid token and return **403 `csrf_invalid`**
   — 73 on login, 18 on select-competition, 9 on leaderboard, 3 on tasks.
3. The **scanner-reputation tracker** counts every non-429 4xx per IP and blocks
   the whole address for **15 minutes** once it sees **100 in 10 minutes**.
   Countable 4xx reached **103**, and the first `/api/login` 429 fired at
   precisely that request.

So a NAT'd venue does not merely lose some sign-ins — **the entire egress IP is
locked out of everything for 15 minutes**. Note that 429s are deliberately
excluded from the tracker, so the ban is fed by the *403s the CSRF throttling
causes*, not by the throttling itself.

**Mitigation — and it is not optional.** `RATE_LIMIT_ALLOWLIST_IPS` bypasses
both the per-route limiters and the scanner tracker, and its own code comment
names this exact scenario. Allowlist the venue egress IP before a NAT'd event.
Raising `RATE_LIMIT_CSRF_PER_MIN` addresses step 1 only.

**Scope, stated honestly.** `leaderboard-stress` re-authenticates every
iteration, which a real participant does not, so it reaches the 403 volume
faster than production would. Each link is established independently, though:
the CSRF cap binds a NAT'd cohort (`login-wave`, 200 distinct accounts in 60 s —
**0** throttled at login, **80** at CSRF), and 100 countable 4xx bans the IP
(timeline above). `competition-live` recorded **zero** 429s, because its VUs
authenticate once and then poll — which is exactly why the per-iteration-login
scenarios are the ones that trip it.

### The control is what makes the result mean anything

`login-wave.js` asserts `login_wave_429 == 0` — a roomful of *distinct*
accounts from one IP must all get in. That assertion is **vacuous if the
limiter happens to be off**: with `RATE_LIMIT_DISABLED=1` it passes no matter
how badly the keying is broken. So the scenario also drives a deliberate
over-limit burst against a single account and requires it to 429:

| metric | meaning |
|---|---|
| `login_wave_429 == 0` | distinct accounts behind one IP are not throttled |
| `limiter_control_429 > 0` | …and rate limiting was genuinely enabled |

If the control never fires the summary prints **INVALID** rather than PASS.

### CSRF and login are counted separately, on purpose

A login needs a CSRF token first, and `/api/csrf-token` is limited **coarsely
per-IP** (`RATE_LIMIT_CSRF_PER_MIN`, default 120) — it is *not* keyed by
account the way login is. A wave that dies at the CSRF step never reaches the
login limiter at all, so reporting one number would attribute the failure to
the wrong mechanism, or worse show `login_wave_429 == 0` and read as a pass
while nobody actually signed in. `login_wave_csrf_429` is therefore its own
metric and its own threshold.

## Prerequisites

Running perf tests against a live box can destroy production data if
misconfigured. Every item below is **required** before you start.

### On the target server

- [ ] **Production container stopped.** `docker compose ps` shows
  nothing. The production container must not be running while the
  perf container is up — they'd otherwise compete for port 3000.
- [ ] **Backup.** Before any perf work, take a full one (database,
  attachments, secrets) with the backup script:
  ```bash
  sudo DATA_DIR=/opt/hackarena/data /opt/hackarena/scripts/backup.sh \
    /path/to/off-box-storage/pre-perf-$(date -u +%Y%m%dT%H%M%SZ)
  ```
  Check the directory holds `BACKUP_COMPLETE`, and keep it off-box.
  Even though the perf container is supposed
  to mount a separate `data-perf` volume, a misconfigured
  `docker-compose.perf.yml` override could still point back at
  `data/`; the backup is the only way to recover from a missed
  review of the volume path.
- [ ] **`.maintenance` file in place.** The perf data directory
  `/opt/hackarena/data-perf/.maintenance` exists and contains a
  random bypass token (see Step 2 of Quick Start below). The Docker
  healthcheck (v6.16.3) reads this file and passes its contents as
  the `X-Maintenance-Bypass` header so the container reports healthy
  during the perf run; pre-v6.16.3 the healthcheck was unconditionally
  unhealthy in this mode.
- [ ] **Perf container uses a DIFFERENT volume.** Verify
  `docker-compose.perf.yml` mounts `data-perf` (not `data`). Run:
  ```bash
  grep -nE "data-perf|uploads-perf" perf/docker-compose.perf.yml
  # Expect: exactly two matches pointing at data-perf + uploads-perf.
  ```

### In `perf/.env.perf`

- [ ] **`SMTP_HOST` points at a capture server.** mailpit, smtp4dev,
  maildev. Never a real MTA — the perf registration storm would
  otherwise flood thousands of messages to real inboxes. The server
  fatals at startup without `SMTP_HOST` (v6.x) so this slot must
  be filled.
- [ ] **`RATE_LIMIT_DISABLED` is NOT set** (v7.15.34). It used to be
  required for the seed; it no longer is — the seeder stopped using
  `/api/register` in v6.10.80 and now creates users through
  `bulk-seed-users`, which carries no limiter. Measured difference:
  2 s vs 3 s. Leaving it out is what lets the measurement exercise
  the login limiter at all.

### On the load-generator machine

- [ ] **`seed.js` guards acknowledged.** The seed refuses to run
  without `--confirm-live` AND `--maintenance-bypass <TOKEN>` AND
  a runtime-verified maintenance gate on the target (`/api/config`
  without the bypass must return 503). The three checks prevent the
  script from ever touching a server that isn't in maintenance mode.
- [ ] **Load generator is on a separate machine** from the target
  (see "Load Generator Machine Requirements" below).
- [ ] **Bypass token matches** the content of
  `/opt/hackarena/data-perf/.maintenance` on the target.

### Safety guards built into `seed.js` (v6.10.18)

The seed script aborts before any mutating call if any of these
fail:

1. `--confirm-live` not present on the CLI → exit 1.
2. `MAINTENANCE_BYPASS` empty → exit 1.
3. `GET /api/config` to the target without the bypass header does
   NOT return 503 → exit 1.

These guards cover the footguns: `node -e "require('./seed.js')"`
as a misplaced syntax check, an operator who forgot to flip the
maintenance gate, or a wrong `BASE_URL` pointing at a live box.

### After the test

- [ ] Perf container stopped: `docker compose -f perf/docker-compose.perf.yml down`.
- [ ] Perf data cleaned: `sudo rm -rf /opt/hackarena/data-perf /opt/hackarena/uploads-perf`.
- [ ] Production restored: `docker compose up -d`.
- [ ] Backup retained for at least 7 days (or your ops policy).
- [ ] `curl -s https://your-url.com/api/config | jq .` — verify production is back and NOT 503.

---

## 1000-user sign-in storm

**Question:** can one Hack Arena process take a room of 1000 people pressing
"Send code" at the start of an event, deliver 1000 sign-in mails, sign them all
in, and then keep 1000 SPA sessions polling at once? Results, pass/fail and the
fixes the runs forced are in `RESULTS.md` § "1000-user sign-in storm".

### Sign-in is an emailed code — so the harness reads mail

Every seeded account signs in with an emailed code: the seeder stores no
password, and an account whose sign-in method is a password (by default an
admin, such as the admin pool's) can still ask for a code. A sign-in is
`GET /api/csrf-token` → `POST /api/auth/code/request {email}` → the code arrives
by mail → `POST /api/auth/code/redeem {email, code}`. The code is minted **per
request**, so it cannot be fetched in k6 `setup()`: every VU waits for its own
mail, read back from a [Mailpit](https://mailpit.axllent.org/) relay's HTTP API
(`perf/k6/lib/mailbox.js`, search by recipient, backoff 250 ms → 1 s). The wait
is part of the measured time-to-signed-in, and mail latency is also reported
separately from Mailpit's own receive timestamp. The other scenarios
(`competition-live`, `leaderboard-stress`, `submission-burst`, `login-wave`) sign
in the same way through `perf/k6/lib/auth.js` and need `MAILPIT_URL` too;
`run-local.sh`'s built-in SMTP sink has no inbox API, so run a Mailpit on its
SMTP port (1026) and pass `MAILPIT_URL` when using them.

### What one VU does (`perf/k6/scenarios/login-storm.js`)

One VU is one participant with their own account, cookie jar and connection.
VU *i* of *N* arrives at `(i-1)/N × WINDOW_S` (a constant arrival rate), then:

| step | requests (as the SPA sent them when the 3000-user runs were measured) |
|---|---|
| page load | `GET /` + versioned stylesheet, fonts.css and JS bundle (`STATIC=1`), `GET /api/config`, `GET /api/me` (the boot identity probe, 401), `GET /api/csrf-token` |
| request | `POST /api/auth/code/request` |
| inbox | Mailpit search until the code arrives (`MAIL_TIMEOUT_S`, 120 s) |
| redeem | `POST /api/auth/code/redeem` |
| land | `GET /api/csrf-token` (new session), `GET /api/me`, `POST /api/select-competition`, `GET /api/my-competitions`, `GET /api/status`, `GET /api/tasks`, `GET /api/leaderboard` |
| stay (`--poll-mode pulse`, the default: the SPA since 8.17.0) | until the **common** hold end (scenario start + `WINDOW_S` + `HOLD_S`): every 15 s ±20 % `GET /api/participant/pulse`; `GET /api/leaderboard` when the pulse's `lb_version` moved or at least every 60 s (the board page assumed open, the pessimistic case); every 5 min `POST /api/session/keepalive`. An active participant: the SPA's idle slowdown to 30 s is not modelled |
| stay (`--poll-mode legacy`: the SPA up to 8.16.0) | every 15 s `GET /api/status` + `GET /api/me` + `GET /api/leaderboard`; every 30 s `GET /api/session/status` |

The SPA has changed since: a signed-out load now asks `GET /api/session/status` instead of `GET /api/me`, and the entry screen sends `POST /api/auth/sign-in-method` before the code request. The harness does not model either, so the published figures predate both.

Every request carries `Accept-Encoding: gzip, deflate, br`, as a browser does
(the server compresses for it). CSRF handling follows the SPA's
(`public/js/core/api.js`): when `/api/csrf-token` answers 429 a VU keeps no token
and never posts without one — it asks again, up to seven asks, waiting between
them (the server's `Retry-After`, at most 15 s, else 1, 2, 4, 8, then 15 s, each ±25 %), and
then gives up without sending; a 403 `csrf_invalid` drops the token, waits for a
new one the same way and re-posts once. `posts_with_empty_csrf` is the witness
that no post goes out without a token (one would earn a 403 `csrf_invalid`, a
countable 4xx for scanner reputation). A person who sees an error tries again
after `RETRY_S` (5 s) until `PATIENCE_S` (300 s). Because every VU polls to the same instant,
all signed-in sessions are active together; `sessions_alive_at_end` counts the
VUs whose final poll still answered 200.

Each VU prints one `STORMREC {…}` line (arrival, signed-in and ready times, mail
wait, attempts, and a refusal tally keyed `<endpoint> <status> <cause>`, where
cause is `rate_limit`, `scanner_block`, `csrf_invalid`, `unauthenticated` or
`transport`), which is how the report attributes every refusal.

### Pass criteria (stated before the runs)

| criterion | target |
|---|---|
| users signed in | ≥ 99.5 % of N, with the app container at `--cpus 4`; measured at N = 1000 (2026-10-29) and N = 3000 (2026-11-01, the operator's requirement) |
| time to signed in (arrival → redeem ok, mail included), p95 | < 10 s |
| server errors | no 5xx (k6 and the server's access log) |
| process | no restart, no OOM (uptime monotonic in /metrics, `podman inspect` restart count 0) |
| steady polling, p95 of every request in the stay phase | < 500 ms |

### Two network realities

- **A — the venue configured as documented:** the load generator's address is
  on `RATE_LIMIT_ALLOWLIST_IPS` (equivalently, the event's trusted network IPs).
  Every `rateLimit()` limiter and the scanner tracker skip it; the account
  lockout and the sign-in-code send caps still apply.
- **B — one NAT address, no allowlist:** all N people share one IP and every
  per-IP limiter (`/api/csrf-token` and `/api/config` 120/min, `/api/tasks`,
  `/api/leaderboard` 120/min, …) and the scanner tracker (100 countable 4xx in
  10 min → the whole address blocked for 15 min) apply to the room as one client.
  The per-IP address-proof budget (`RATE_LIMIT_PROOF_IP_PER_15MIN`, 150 per
  15 min) counts only addresses no account holds, so it does not bear on these
  runs, whose accounts are seeded.

### Reproduce (podman; nothing else installed)

```bash
podman build -t hackarena:perf .                      # the app image, from THIS checkout
perf/storm-podman.sh --label A-60s --mode A --users 1000 --window 60 --hold 240
perf/storm-podman.sh --label A-10s --mode A --users 1000 --window 10 --hold 240
perf/storm-podman.sh --label B-60s --mode B --users 1000 --window 60 --hold 240
# useful variants: --seed-users N (enrol more than sign in), --cpus/--memory,
# --app-env "NODE_OPTIONS=--cpu-prof --cpu-prof-dir=/app/data/prof" with --keep
# (then `podman stop hackarena-perf` writes the profile), --keep, --no-static,
# --poll-mode legacy (the pre-pulse SPA, for a before/after on one host),
# --prefix P --subnet-octet K (name everything P-... on 10.K.0.0/24, to run beside
# another stack on the same host), --app-env SMTP_POOL_MAX_CONNECTIONS=64
```

**The 3000-user runs (2026-11-01; RESULTS.md § "3000-user sign-in storm — FINAL").**
Same criteria with N = 3000, same quiet-host rule:

```bash
podman build -t hackarena:perf .
perf/storm-podman.sh --label final3k-A-60s --mode A --users 3000 --window 60 --hold 300
perf/storm-podman.sh --label final3k-A-10s --mode A --users 3000 --window 10 --hold 300
perf/storm-podman.sh --label final3k-A-10s-pool64 --mode A --users 3000 --window 10 --hold 300 \
  --app-env SMTP_POOL_MAX_CONNECTIONS=64
perf/storm-podman.sh --label final3k-B-60s --mode B --users 3000 --window 60 --hold 300
```

**The final 1000-user runs (quiet machine; the target since 2026-10-29 — the earlier 3000-user runs are history in RESULTS.md).** Check the host is idle first
(`podman machine ssh "cat /proc/loadavg; nproc"`: the 1-minute load well under the
CPU count, nothing else running), then, from a clean checkout of the commit under
test:

```bash
podman build -t hackarena:perf .
perf/storm-podman.sh --label final-A-60s  --mode A --users 1000 --window 60 --hold 300
perf/storm-podman.sh --label final-A-10s  --mode A --users 1000 --window 10 --hold 300
perf/storm-podman.sh --label final-B-60s  --mode B --users 1000 --window 60 --hold 300
# the steady-state cost per request, for RESULTS.md (from the same artefacts):
#   hold-window requests/s from app-logs/access-*.jsonl and the app container's
#   average CPU from podman-stats.csv; CPU-ms/request = CPU% × 10 / requests/s
```

Record `env.txt` (VM size, load before/during/after) and each `report.md` verdict in
RESULTS.md. A pass needs every criterion above in each mode-A run; mode B is
reported, not judged (it measures a venue that ignored the allowlist instruction).

`storm-podman.sh` creates its own network (`perf-net`, 10.231.0.0/24) and
containers (`perf-mailpit` with `--max 20000`, `hackarena-perf`, `perf-monitor`,
`perf-k6`, volumes `perf-data`/`perf-uploads`) and removes them at exit; it never
touches any other container. The app runs production-like over plain HTTP:
`NODE_ENV=development` + `MINIFY_JS=1` (`production` would force Secure cookies,
which an http client never sends back), `HSTS=0`, `LOG_CONSOLE_MIRROR=0` (as in
production), `SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_ALLOW_PLAINTEXT=1`, with
`--cpus 4 --memory 4g` by default. The sequence:

1. fresh volumes, Mailpit, the app; wait for `/readyz`;
2. write a random token to `DATA_DIR/.maintenance` and seed through it with
   `perf/seed.js` (its three guards apply: `--confirm-live`, a bypass token, and
   a verified 503 without it) — N participants plus the 16-account buffer, one
   live Tournament event they are all enrolled in, 10 challenges;
3. remove `.maintenance` (the run itself uses no bypass);
4. start the monitor: it signs in as the built-in superadmin (password from the
   data volume's `.superadmin-password`), runs the **limiter control** (130 ×
   `GET /api/csrf-token` from its own, never-allowlisted address must meet a 429,
   or the run proves nothing about limits) and scrapes `/metrics` every 5 s;
5. start the samplers: `podman stats` every 2 s (app, Mailpit, k6), VM load,
   WAL and session-table size (`perf/tools/storm-sessions.js`, read-only);
6. run k6 (`grafana/k6:1.3.0`) from the fixed address 10.231.0.20;
7. copy the app's access/app logs and run `perf/tools/storm-report.js`.

Everything lands in `perf/results/storm/<label>/` (gitignored): `report.md`,
`timeline.svg`, `k6-summary-<label>.json`, `vu-records.jsonl`, `podman-stats.csv`,
`monitor.jsonl`, `db.jsonl`, `vm-load.csv`, `env.txt`, `commit.txt`, `app-logs/`.

**Measure on a quiet host.** The VM is shared; `env.txt` and the report record the
1-minute load before, during and after. Under oversubscription the app's one
thread is descheduled and every number (event-loop "blocked" time included)
inflates; a run made while the VM's load exceeded its CPU count is recorded as
such in RESULTS.md and not used for a verdict.

---

## Automatic certificates at event scale

`node perf/certificate-dispatch-scale.cjs [participants=3000] [port=7999]` spawns
its own test server (scratch `DATA_DIR`, an in-process capturing SMTP relay), seeds
one ended event of N participants by SQL (each one earns a certificate) and drives
the test-only certificate-dispatch tick until the job drains. Never point it at a
real deployment: it needs the test-only tick.

Measured on the integrated 8.16.0 build in the pinned CI image (22-CPU VM, quiet):

| Participants | Passes | First pass | Total | Per certificate | Board builds |
|---|---|---|---|---|---|
| 3000 | 30 (about 100 each) | 6.7 s | 199 s | 66 ms (render + SMTP) | 2 |

Each board is built once per job (one main, one late), so the time grows with the
number of certificates, not with its square. An earlier run at N=300 on a heavily
shared VM measured about 495 ms per certificate: the figure is CPU-bound and moves
with the machine.

## Single-process invariant

**Do not run the perf container behind a round-robin load balancer or
under `pm2 -i N` cluster mode.** Hack Arena keeps leaderboard caches,
rate-limit buckets, session-per-user tracking, and the competition
cache in process memory — splitting traffic across replicas would
produce inconsistent state. The perf harness assumes one Node process
per `/opt/hackarena/data-perf` volume, matching production. See the
"Run as a single process" section of the root README for the full
list.

## Session lifetime

Sessions expire after 60 minutes (rolling: false). The SPA pings
`/api/session/keepalive` on every real user interaction — the perf
harness mirrors this via a 10-minute cadence inside the participant
loop (see `perf/k6/lib/participant.js > maybeKeepalive`). For tests
longer than ~55 minutes (full-scale 3.5 h scenario) this is required
— without it, a VU silently 401s mid-loop and its remaining iterations
are noise.

## Quick Start (10-minute test)

### Step 1 — Prepare the server

SSH to the server and stop the production container. Production data is
on a host-mounted volume and is not affected.

```bash
ssh your-server
cd /path/to/hackarena

# Stop production (data on /opt/hackarena/data is untouched)
docker compose down
```

### Step 2 — Create perf data directory with maintenance gate

Create the perf data directory and drop a `.maintenance` file in it.
The file content is the bypass token — anyone who doesn't present it
sees a "Scheduled Maintenance" page.

```bash
sudo mkdir -p /opt/hackarena/data-perf /opt/hackarena/uploads-perf
TOKEN=$(openssl rand -hex 16)
echo "$TOKEN" | sudo tee /opt/hackarena/data-perf/.maintenance
echo "Bypass token: $TOKEN"     # copy this — you'll need it on the load generator
```

### Step 3 — Prepare the perf env file

```bash
# First time only — copy from production and adjust
cp .env perf/.env.perf
```

Edit `perf/.env.perf` — it should match your production `.env` except:
- `EMAIL_FROM` can be set to something like `no-reply@hackathon.local`. Since v7.26.0 only
  the address half is used — the sender display name comes from Settings -> Platform Name.
- **SMTP_HOST is required** (the server exits FATAL at startup without it).
  Point it at a capture server like [mailpit](https://github.com/axllent/mailpit),
  [smtp4dev](https://github.com/rnwood/smtp4dev), or
  [maildev](https://github.com/maildev/maildev). The mail content is
  irrelevant to the benchmark — any SMTP responder that accepts
  connections works.
- **`RATE_LIMIT_DISABLED` is no longer needed** (v7.15.34). This bullet
  used to say it was required, citing the 10/min `/api/register` cap —
  a code path deleted in v6.10.80. The seeder creates users through
  `POST /api/admin/perf/bulk-seed-users` (no limiter), and the whole
  seed measures 2 s with limits off versus 3 s with them on. Keeping
  the flag out is what allows the run to measure the login limiter,
  which is the one thing a live event reliably stresses.

See `perf/env.perf.example` for a reference including the SMTP + rate-
limit overrides.

### Step 4 — Start the perf container

```bash
docker compose -f perf/docker-compose.perf.yml up -d --build
```

Verify:

```bash
# Should return the maintenance HTML page
curl -s https://your-url.com/

# Should return config JSON (bypass works)
curl -s -H "x-maintenance-bypass: $TOKEN" https://your-url.com/api/config | jq .
```

### Step 5 — Seed test data (from the load generator machine)

On the load generator, clone the repo (or copy the `perf/` directory) and
install dependencies:

```bash
cd perf/
npm install
```

Run the seed script. This creates background data (5000 users + 300
challenges to simulate a production-sized DB), then **historical
competitions with a full submission history** (Phase 0b — see below),
then a test competition with your chosen participant and task count.

**The seed aborts without `--confirm-live` AND `--maintenance-bypass`
AND a runtime-verified maintenance gate on the target.** See
§ Prerequisites above.

```bash
node seed.js \
  --confirm-live \
  --base-url https://your-url.com \
  --maintenance-bypass <TOKEN> \
  --participant-count 20 \
  --browser-probes 2 \
  --task-count 10 \
  --history-comps 100 \
  --history-participants 200 \
  --competition-start-offset 120 \
  --competition-duration 10
```

**Admin pool is auto-sized (v6.10.85 → v6.10.93).** seed.js creates
a SEPARATE pool of admin users with role=admin under a disjoint
email prefix (`perf-admin-NN@acme.com`), so the k6 admin + log_admin
scenarios can each log in as a distinct admin via
`getAdminParticipant(__VU)`. Without this the scenarios would share
the built-in superadmin login and the server's single-session-per-user
invariant would kill 4 of 5 admin VUs on every login — the v6.10.84
WAN run recorded 633 × 403 in 12 min from exactly that failure mode.

The pool sizes automatically to match `PARTICIPANT_POOL_SIZE`
(i.e. `--participant-count` + the 16-user collision buffer), because
k6's `__VU` is globally allocated across every scenario — an admin
VU can receive any `__VU` up to `VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + ORGANISERS +
BROWSER_PROBES`, and the lookup `((__VU - 1) % adminPoolSize) + 1`
would collide if the pool were smaller. This replaces the v6.10.85
fixed-default of 20 which produced the collision observed in v6.10.92
(`vu=23` and `vu=43` both hashed to `perf-admin-03`).

You don't need to pass any admin-pool flag — `--participant-count 300`
alone produces the right admin pool. `--admin-count N` is available
as an explicit override for unusual configurations, and `--admin-count 0`
when ADMIN_VUS=0 + LOG_ADMIN_VUS=0 + ORGANISERS=0 on the k6 command suppresses the
pool entirely. The k6 scenario throws at init-time if the seed's
admin pool is smaller than the scenario's total preallocated VUs.

`--browser-probes N` (v6.10.60) creates a SEPARATE pool of N users
with a different email prefix (`perf-browser-NN@acme.com`) so the
k6 browser-probe scenario and the protocol-VU scenario are logically
disjoint — there is no arithmetic that can resolve a `__VU` value to
the same user across the two scenarios. Without it, browser probes
fall back to a modulo into the protocol pool and the server's
single-session-per-user invariant kills random protocol VU sessions
(surfaces as `[session-401]` warn-log bursts during the run). Set
this to the same value you'll pass as `BROWSER_PROBES=N` on the
`k6 run` command. If you're running `BROWSER_PROBES=0` you can omit
the flag.

`--participant-count N` (v6.10.61): seed.js auto-adds a fixed
16-user buffer on top of N to absorb k6's GLOBAL `__VU` allocation
(admin + log_admin + browser_probes scenarios consume `__VU` slots
from the same pool as participants, so participant VUs can end up
with `__VU` values higher than VU_COUNT). Pass `--participant-count
300` and seed creates 316 protocol users; `participantCount` in
seed-data.json reads 316. The k6 scenario validates this at init
time against `VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + ORGANISERS + BROWSER_PROBES`
and throws (refusing to start) if the seed file is too small,
saving the operator from sinking minutes into a run that's
guaranteed to dead-loop on protocol↔protocol session-401 collisions.

History: v6.10.57 tried "shrink the protocol pool by N to make room
for browser IDs" but introduced a protocol↔protocol modulo collision.
v6.10.58 tried "reserve top-N IDs in one shared pool" but k6's
`__VU` is globally unique across scenarios, so late-ramp protocol
VUs ended up with `__VU` values inside the reserved range and the
collision came back through a different door. v6.10.60 abandons the
shared-pool model entirely for browser probes — two disjoint email
prefixes is the only shape that survives k6's VU-allocation
behaviour. v6.10.61 closes the parallel protocol↔protocol case by
auto-buffering the seed pool above the operator's stated
`--participant-count`.

This outputs `results/seed-data.json`. The competition starts 2 minutes
after seeding completes.

Use `--skip-bg` on subsequent runs to skip the background population
phase (~10-15 minutes) if the perf DB already has it from a prior run.

**Phase 0b — historical competitions + submission history.** After the
background users land, the seed creates `--history-comps` (default 100)
**ended** competitions, each with `--history-participants` (default 200)
participants sampled from the `bg-user-` pool who solved every assigned
task, plus some wrong attempts and hint reveals. Each comp draws a random
`--history-tasks-per` (default 10) tasks from a published pool of
`--history-task-pool` (default 40) challenges created up-front. The heavy
inserts (~hundreds of thousands of `submissions` / `hint_reveals` /
`challenge_events` / `competition_events` / `competition_users` rows) run
server-side via `POST /api/admin/perf/bulk-seed-history` — a few seconds,
vs. the hours that driving `/api/tasks/:id/submit` that many times would
take. This makes the admin polling reads (Submissions, Analytics, per-comp
Events, the competitions list, leaderboard) benchmark against a
realistically-populated DB instead of near-empty history tables. The
history task pool and participants are disjoint from the live test
competition's tasks and protocol-VU pool, so nothing leaks into the run.

The history seed is **supplementary and never blocks the perf-test setup**:

- It is sent in **batches of `--history-batch` (default 10) competitions
  per request** so no single request is large enough to trip a reverse-proxy
  read timeout (502/504). A direct connection can raise it; a tight proxy
  can lower it. Each request is also capped at `--history-req-timeout-ms`
  (default 180000) and aborts rather than hanging the seed.
- It is **non-fatal**: if any batch fails (proxy timeout, no candidate
  `bg-user-` pool, etc.) the seed logs a warning, stops the history phase,
  and **still creates the test competition + protocol pool + writes
  `seed-data.json`**. A history hiccup can never leave k6 logging into
  non-existent protocol users.

Pass `--skip-history` to omit it entirely (e.g. when the perf DB already
has it from a prior run).

> **Pool sizing — `--participant-count` must be ≥ `VU_COUNT`.** The k6
> scenario refuses to start if `seed-data.json`'s `participantCount` is below
> `VU_COUNT + ADMIN_VUS + LOG_ADMIN_VUS + ORGANISERS + BROWSER_PROBES`. `seed.js`
> auto-adds a 16-user buffer, so for a `VU_COUNT=300` run pass
> `--participant-count 300` (which seeds 316). Passing a smaller count (e.g.
> `--participant-count 200` against `VU_COUNT=300`) makes the scenario throw
> `[config] participant pool too small` at init.

`results/seed-data.json` is **gitignored** — it's per-run, environment-
specific (carries the live tenant's `baseUrl`, the seeded `competitionId`,
and the per-task answers). If you've upgraded the platform and an
older `seed-data.json` is still on disk, regenerate it before the next
k6 run; the scenario init checks at competition-live.js:434/467 will
throw immediately if the seed shape doesn't match the scenario's VU
allocation. The convenience `seed:quick` / `seed:quick:skip-bg` /
`seed:full` npm scripts pass `--browser-probes 2` so a fresh seed
always satisfies the default scenario `BROWSER_PROBES=2` (v6.16.53 —
prior to this the npm scripts seeded 0 browser users and the default
scenario init would throw on a freshly-seeded environment).

### Step 6 — Run k6 (within 2 minutes of seeding)

```bash
k6 run \
  --env BASE_URL=https://your-url.com \
  --env MAINTENANCE_BYPASS=<TOKEN> \
  --env TEST_DURATION=10m \
  --env VU_COUNT=20 \
  --env RAMP_UP=2m \
  k6/scenarios/competition-live.js
```

### Step 7 — Teardown

Back on the server:

```bash
ssh your-server
cd /path/to/hackarena

# Stop the perf container
docker compose -f perf/docker-compose.perf.yml down

# Delete all perf data (DB, uploads, sessions, logs — all disposable)
sudo rm -rf /opt/hackarena/data-perf /opt/hackarena/uploads-perf

# Restore production
docker compose up -d

# Verify production is healthy
curl -s https://your-url.com/api/config | jq .
```

Production data was never mounted by the perf container and is exactly
as you left it.

---

## Full-Scale Test (3.5 hours, 200 users, 30 challenges)

Follow the same steps above, substituting the seed and k6 commands:

### Seed

```bash
# First run (includes ~10-15 min background population)
node seed.js \
  --confirm-live \
  --base-url https://your-url.com \
  --maintenance-bypass <TOKEN> \
  --participant-count 200 \
  --browser-probes 5 \
  --task-count 30 \
  --competition-start-offset 900 \
  --competition-duration 210

# Subsequent runs (skip background, just create a new competition)
node seed.js --confirm-live --skip-bg \
  --base-url https://your-url.com \
  --maintenance-bypass <TOKEN> \
  --participant-count 200 \
  --browser-probes 5 \
  --task-count 30 \
  --competition-start-offset 900 \
  --competition-duration 210
```

### Run

```bash
k6 run \
  --env BASE_URL=https://your-url.com \
  --env MAINTENANCE_BYPASS=<TOKEN> \
  --env TEST_DURATION=210m \
  --env VU_COUNT=200 \
  --env RAMP_UP=15m \
  --env ADMIN_VUS=2 \
  --env LOG_ADMIN_VUS=1 \
  --env BROWSER_PROBES=5 \
  k6/scenarios/competition-live.js
```

---

## Admin VU roles inside `competition-live.js`

Two admin profiles run alongside the participant load, both
superadmin-logged-in but with distinct behaviour:

- **Dashboard admin** (`ADMIN_VUS`, default 1) — rotates through the
  usual admin surfaces: Participants, Leaderboard, Submissions,
  Analytics, History dialogs, Logs. 15–30s cadence. The default
  profile since v6.4.x.
- **Log-watching admin** (`LOG_ADMIN_VUS`, default 1, v6.10.21) —
  pinned to the Logs pane. Starts in the app/event stream at the
  UI-default `limit=50`, switches to the access stream at
  `limit=500` after a randomised 3–5 min phase, switches back after
  another 3–5 min, and alternates until the scenario ends. 10–15s
  cadence (tighter than the dashboard admin — operators actively
  watching logs refresh more often). The access-stream fetch is
  ~10× the bytes of the event-stream fetch and hits a different
  on-disk log file, so this VU exercises a log path the dashboard
  admin doesn't touch.

- **Organiser** (`ORGANISERS`, default 3) — an organiser tab with the
  event's workspace Overview open, reading its uncached live figures
  (`overview-pulse`) every 15 s, as the SPA does while the Overview is
  on screen. Signs in from the admin pool like the two above, so the
  pool must cover these VUs too.

Set `LOG_ADMIN_VUS=0` to omit the log-watching profile if you only
care about dashboard load. Set `ADMIN_VUS=0` to omit the dashboard
admin (but keep log-watching). Both default to 1 — the quick-start
10-minute run therefore exercises both admin profiles out of the
box.

## WAN emulation

The load generator usually sits next to the target (sub-millisecond RTT), so a
normal run measures **server processing time** with negligible network cost.
To predict behaviour over a real WAN without provisioning a remote load box,
inject latency / jitter / loss / a bandwidth cap on the LG's egress with
`perf/wan-emulate.sh` (a thin wrapper over Linux `tc`/`netem`), then re-run the
**exact same** k6 command and compare against the LAN baseline.

```bash
cd perf
# Apply a cross-country profile to the target ONLY (your SSH session is untouched):
sudo ./wan-emulate.sh on continental hackarena.pogrebisky.net
./wan-emulate.sh status                 # confirm the qdisc + filter are in place
#   ... run the usual `k6 run …` command ...
sudo ./wan-emulate.sh off               # always remove when done (also clears on reboot)
```

**Presets** (the `delay` is set to the RTT you want to emulate):

| Preset | Added RTT | Loss | Notes |
|---|---|---|---|
| `regional` | 30 ms ±5 | 0.02% | same-country |
| `continental` | 80 ms ±15 | 0.10% | cross-country |
| `intercontinental` | 160 ms ±30 | 0.20% | trans-ocean |
| `mobile` | 120 ms ±40 | 1.00% | + 8 mbit cap + 5% reorder (poor 4G) |

**Scoped & safe.** Shaping is applied via an `htb` root qdisc whose default
class is unshaped (≈line rate) plus a single `tc filter` that steers **only**
packets to the resolved target IP into the `netem` class. SSH to the LG, DNS,
and traffic to every other host are unaffected — so provided `<target>` is a
different host than the one you SSH in from, you cannot lag yourself out of the
box (the script also refuses a target equal to your SSH peer when it can see
`SSH_CONNECTION`; note `sudo` strips that var unless you use `sudo -E`). If the
host resolves to multiple A records it shapes only the first and warns. Run
`off` before changing presets (the script refuses to stack).

**What to expect** (consistent with the server's measured headroom):

- **API per-request latency rises by ≈ the added RTT** (e.g. p90 ~3 ms → ~83 ms
  on `continental`), still far under the 1–3 s thresholds. `analytics_global`
  becomes `RTT + ~1.5 s`.
- **Throughput, server-side req/s, concurrency, and error rate barely move** —
  this scenario is think-time-dominated (long pauses + the 3-min keepalive
  cycle), so per-request RTT is a sliver of each iteration. The server load
  profile over WAN ≈ the LAN run.
- **Browser page-load feels RTT multiplicatively** (a few critical-path
  round-trips): `page_load` p90 ~1.1 s → ~1.3–1.7 s at 50–150 ms RTT.
- The `mobile` preset's `loss`/`reorder`/`rate` is where you'll see TCP
  retransmits inflate the **tail** (max/p99) and a bandwidth-bound ceiling —
  the WAN effects a LAN run can't surface.

**Caveats.** `netem` shapes the egress (outbound) leg only, so the
client-observed RTT increase ≈ the `delay` value (a symmetric link would also
delay the return leg via an `ifb` redirect — overkill for this purpose). The
filter matches a single resolved **IPv4** address; if the target is behind a
CDN / multiple A records / IPv6, only the resolved IPv4 is shaped (point at the
real origin IP, or extend the script with an `ip6` filter). Requires `root`
(via `sudo`) and `iproute2`.

## Focused Scenarios

### Leaderboard stress test

Tests the O(N*M) leaderboard query under concurrent load:

```bash
k6 run \
  --env BASE_URL=https://your-url.com \
  --env MAINTENANCE_BYPASS=<TOKEN> \
  --env VU_COUNT=50 \
  k6/scenarios/leaderboard-stress.js
```

### Submission burst test

Tests concurrent write contention and the auto-end check — provided every submit
carries the challenge's `gradingHash` (see § "Every submit in the harness had
been refused"); without it the server refuses each submit before writing anything
and the run measures nothing but a 409:

```bash
k6 run \
  --env BASE_URL=https://your-url.com \
  --env MAINTENANCE_BYPASS=<TOKEN> \
  --env VU_COUNT=50 \
  k6/scenarios/submission-burst.js
```

---

## Server-Side Monitoring

During the test, SSH to the server and run:

```bash
# CPU/memory of the Node.js process
top -b -p $(pgrep -f "node server.js") -d 5

# Database file growth (WAL size indicates write pressure)
watch -n 10 'ls -lh /opt/hackarena/data-perf/hackathon.db*'

# Live error logs
docker logs -f hackarena-perf 2>&1 | grep -i error
```

---

## Metrics Reported

### API-level (avg, p90 from protocol VUs)

| Metric | Description |
|--------|-------------|
| `page_load` | Initial page HTML + assets |
| `login_flow` | Full login (CSRF + POST + CSRF re-fetch) |
| `select_competition` | Competition join |
| `task_list` | Challenge list fetch |
| `task_detail` | Single challenge detail |
| `submit_answer` | Answer submission (graded — carries the challenge's grading hash since v8.9.1) |
| `stale_submissions` | Submits the server REFUSED TO GRADE (409 `task_changed`). A harness defect, never load: both scenarios gate on `count<1` (v8.9.1) |
| `reveal_hint` | Hint reveal |
| `leaderboard` | Leaderboard fetch |
| `pulse_poll` | The participant's pulse (`GET /api/participant/pulse`), their one regular poll |
| `admin_participants` | Admin participant list |
| `admin_leaderboard` | Admin rankings |
| `admin_submissions` | Admin event log (paginated, limit=100) |
| `admin_analytics_competition` | Admin Analytics tab — competition-scoped aggregates |
| `admin_analytics_global` | Admin Analytics tab — global (cross-competition) aggregates; the heaviest admin read |
| `admin_logs` | Admin Logs pane — event (app) stream, limit=50 per request (UI default). Emitted by both the dashboard-admin polling loop AND the log-admin scenario's events phase. |
| `admin_logs_access` | Admin Logs pane — **access** stream, limit=500 per request. Emitted only by the log-admin scenario (`LOG_ADMIN_VUS>0`). ~10× the bytes of `admin_logs` and reads a different on-disk file. |
| `overview_pulse` | The event workspace Overview's live read (`GET /api/admin/competitions/:id/overview-pulse`), uncached, every 15 s per organiser VU (`ORGANISERS>0`) |

### Counters

| Counter | Description |
|--------|-------------|
| `correct_submissions` | Submits the server GRADED correct |
| `wrong_submissions` | Submits the server graded wrong. A 409 `task_changed` refusal is NOT one of these (see below) |
| `stale_submissions` | Submits the server REFUSED TO GRADE — 409 `task_changed`, i.e. a stale or missing `gradingHash`. A harness defect, never load; both scenarios gate on `count<1` |
| `hints_revealed` | Hint reveals |

**How a participant VU behaves.** Each protocol VU works through the seeded
challenges with a fixed behaviour mix — 60 % answer correctly, 15 % answer wrong
then correctly, 10 % reveal the hint then answer, 10 % skip the challenge, 5 %
answer wrong two or three times and move on; `submission-burst` answers 70 %
correctly and 30 % wrong. Correct answers come from `seed-data.json`; the
**grading token** (`grading_hash` on `GET /api/tasks/:id`, an HMAC keyed by the
server's `.grading-secret`, so nothing the seeder can precompute) is read from
the challenge detail at run time and echoed on every submit. The server refuses
to grade a submit without it, so a scenario that omitted it would measure a
refusal, not the submit path — which is exactly what happened from v7.20.9 to
v8.9.0.

### Browser rendering (avg, p90 from probe VUs)

| Metric | Description |
|--------|-------------|
| `browser_page_load` | Full page load with JS |
| `browser_login_render` | Sign In → dashboard visible |
| `browser_comp_select_render` | Select competition → nav visible |
| `browser_task_list_render` | Navigate to Challenges → rendered |
| `browser_task_detail_render` | Click challenge → detail rendered |
| `browser_submit_render` | Submit → result visible |
| `browser_leaderboard_render` | Leaderboard → table rendered |

---

## Safety Checklist

Deferred to § Prerequisites at the top of this document. The short
form: seed.js refuses to run without `--confirm-live`,
`--maintenance-bypass <TOKEN>`, and a runtime pre-flight that confirms
the target returns 503 on `/api/config` without the bypass header.
Every operator-visible check is listed there; re-read it before every
run.
