# Development

Everything you need to run, test, and change Hack Arena locally. Ops-side documentation lives in `README.md`; agent-focused guidance lives in `CLAUDE.md`.

## Prerequisites

- **Node.js 26.x** (the Dockerfile pins `node:26-alpine`, and `package.json` `engines` accepts `>=20`; on the host, any Node ≥ 20 will install cleanly, but run the same major as the container to catch N-API mismatches early). CI runs production's major too — see `ci/README.md`.
- **npm 10+** (bundled with Node 26).
- **A local SMTP sink** for email flows. Any of `mailpit`, `smtp4dev`, `maildev` works. The server refuses to start if `SMTP_HOST` is unset — it never falls back to localhost unconfigured.
- **Playwright browsers** for tests: `npx playwright install chromium` — and again after every Playwright version change (a lockfile that moves `@playwright/test`): each release pins its own browser builds and does not reuse the old ones, so a stale cache fails every test with *"Executable doesn't exist"*. For the cross-browser matrix add `firefox webkit`, and on a no-root host re-run `npm run test:cross:setup` after the bump too (README, *Cross-browser testing*).

## First run

```bash
cp .env.example .env          # if the file exists; otherwise set the vars below inline
npm ci
BASE_URL=http://localhost:3000 SMTP_HOST=localhost npm run dev
```

First boot prints a banner with the platform version, data dir, and an auto-generated superadmin password. Sign in at `http://localhost:3000` by typing the break-glass username (`superadmin` unless it was changed in Settings) into the sign-in card's email box, pressing **Continue**, and entering that password in the box that appears.

Accounts sign in with their password or with an emailed one-time code (admins default to a password, which they set after their first sign-in by code; everyone else to codes; anyone can choose in **Profile → How you sign in**), so point `SMTP_HOST` at a local mail sink (mailpit, smtp4dev) to read the codes; under `NODE_ENV=test` specs read the last code through `GET /api/test/last-login-code?email=`. Restart regenerates the superadmin password. That's deliberate — see `README.md § Rotating the Superadmin Password`.

## The dev loop

| Command | What it does |
|---|---|
| `npm run dev` | Runs under `nodemon`. `nodemon.json` watches every root the running process holds — `server.js`, `db.js`, `version.json`, **`lib/`, `routes/`, `public/`, `docs/`** — so a bump, a backend edit, a stylesheet change or a guide edit all restart it (v8.7.2; before that only the three files were watched, so ~71% of the backend needed a manual restart). `public/js/**` is served raw in dev and is never stale server-side, but it is watched anyway so the boot-frozen `?v=<hash>` on `/js/core/main.js` is recomputed — that URL is served `immutable` for a year, so the browser would otherwise keep its cached copy. Ignored: `data/`, `uploads/`, `docs/screenshots/`. **Every restart regenerates `SESSION_SECRET` and `.superadmin-password`** — you are signed out and the password changes. |
| `npm start` | Production server (no nodemon). Use this to sanity-check what the Docker image will run. |
| `npm test` | Full Playwright regression, ~5,600 tests on Chromium. Default `WORKERS=24` (one server per worker on `PORT + index`, and a data directory that follows `TEST_PORT_BASE` too — `data-test-<index>/` at the default base, `data-test-<base>-<index>/` otherwise — replaced before **every spec file**). |
| `npm test -- tests/ui-admin-tasks.spec.js` | A single file. |
| `WORKERS=1 RETRIES=0 npm test -- tests/foo.spec.js -g "specific"` | Strict mode — serial, no retries — good for debugging a flake. |
| `npm run test:changed` | Only the spec files this branch touched, run twice with retries on. Seconds, and aimed at exactly the code most likely to carry a fresh isolation bug. |
| `MINIFY_JS=1 npm test` | Production-parity pass — the SPA served as the esbuild entry-bundle rather than raw modules. |
| `npm run smoke` | Boots a real server in **both** serving modes and drives the SPA end to end (login → every sidebar section, Raw logs from Audit → create an event → its Join-Link QR image and its workspace's Activity). Fast, and catches what `node --check` cannot. |
| `npm run test:cross` | Cross-browser and cross-device matrix: `tests/cross-browser.spec.js` (the reachability smoke) and `tests/cross-device.spec.js` (real participant journeys with each device's own input) across 22 engine/OS/device projects, plus branded `google-chrome` where it is installed. Opt-in; needs `npx playwright install firefox webkit` first. |
| `npm run test:balance` | Runs the suite and reports how evenly the workers finished and which files are too long to schedule well. `-- --write` also regenerates `tests/file-timings.json`, which the scheduler reads. A diagnostic, not a release gate. |
| `npm run test:coverage` | Runs the suite with server and client JS coverage and writes `.coverage/report.md`: the functions and lines no test executes. Its output is a list of leads, not a verdict (see *Test architecture*). |
| `npm run docs:shots` | Regenerate `docs/screenshots/**/*.png` for light + dark themes. Slow. Run after UI changes. |
| `npm run docs:shots:participant` / `:admin` / `:superadmin` | Only the role you touched. |

## Test architecture

**The isolation boundary is the FILE, not the worker (v7.20.0).** This is the one
thing to internalise before writing a spec:

- Each worker owns a port (`PORT_BASE + worker_index`, default `4567 + i`) and a
  data directory (`data-test-<i>/`). `tests/isolated-test.js` **replaces** that
  worker's server — SIGKILL, wipe the data dir, fresh process, fresh seed — in a
  `beforeAll`, which Playwright runs **once per spec file**. That hook is
  registered at module-import time, so the harness deletes its own
  `require.cache` entry to force a re-evaluation for every spec — without it the
  hook attaches only to the FIRST file each worker loads and isolation silently
  degrades to per-WORKER, which is what it had been doing since v7.20.0
  (v8.3.29). If you add a helper, do **not** `require("./isolated-test")` from
  it, and if a spec needs `request` inside a test body, take it from
  `@playwright/test`. A fresh process means
  every in-process cache (leaderboard, me-cache, `_competitionCache`, scanner
  map, rate-limit buckets, admin alerts, sessions) is gone *by construction*
  rather than by a reset list somebody has to remember to extend.
- **So every spec must `require("./isolated-test")`, never `@playwright/test`.**
  A spec that imports the runner directly opts out of isolation silently, and the
  file it damages is some later, unrelated one. A Docs-hygiene lock enforces this.
- The harness also runs **runtime `afterAll` guards** that fail the FILE when it
  leaves shared state changed: `settings.platform_name`, and the three seeded
  participants' role / lifecycle flags / secondary email / tags /
  membership of `Test Live`. They exist because those leaks surface in a LATER
  test for reasons that name none of it — a promoted fixture is auto-tagged
  `staff`, and the assign endpoint skips a staff user who holds no row yet on
  any event whose **Staff can compete** switch is off (the seeded default),
  reporting it only as a `skippedStaff` count, so the next test builds an empty
  cohort and fails on an empty leaderboard. **If you must mutate a seeded
  fixture, restore it in a `finally`, to the hard-coded seed value.** Better:
  register your own participant — a fixture you own cannot be contaminated by a
  sibling.
- **A user-backed admin enrolled in an event whose switch is on is a COMPETITOR**
  and is refused `403 competitor_cannot_edit` on every write to that event, its
  sessions, its challenges and the groups bound to it, whatever their tier. A
  fixture that enrols the ACTING account to test scoring must make its edits
  through a second admin; such an event admits sealed challenges only, so an
  `any`-type challenge can never be assigned there. The built-in `superadmin`
  login has no `users` row and can never be a competitor, which is why most
  specs never meet this.
- Readiness is a **positive identity check**, not a status code: the harness
  requires `/api/config`'s `server_started_at` to be newer than the moment it
  spawned. `/healthz` is answered identically by the *previous* file's server, so
  polling it can hand a whole file the wrong database.
- `tests/global-setup.js` no longer seeds, **and since v8.3.26 it no longer wipes
  anything either**. It only refuses to start if a port is already listening —
  every worker slot *and* every spawned-server offset. A leaked server from an
  interrupted run presents as `csrf_invalid` on login, which points nowhere near
  the cause. The wipe was removed rather than reordered: `isolated-test.js`
  already clears the data directory before every spec file, so global-setup's
  copy was redundant — and it ran *before* the port check, so a second concurrent
  run destroyed the databases of the run already in flight and only then reported
  the collision.
- Fixtures are in `tests/helpers.js`: `apiLogin`, `freshCtx`, `getSuperadminPass`,
  `BASE`. `tests/server-env.js` is the single definition of the server's hermetic
  environment, shared by the harness and the config.
- Within a file, tests stay serial and may share state via the `S.*` pattern (see
  the top of `tests/functional-core-a.api.spec.js`). Across files, assume nothing.
- **Register your own participants and events.** Anything that
  authenticates as a seeded fixture, or solves "every challenge in the seeded
  event", is hostage to what other files did. See the fixture checklist in
  `CLAUDE.md` — in particular that a single participant solving everything trips
  the all-solved auto-end and ends the event under you.
- Accessibility scans are inline in the UI specs and run axe-core against every
  major page + the task-detail modal + every admin tab at a moderate+ impact gate.
- **Files are scheduled LONGEST FIRST (v8.12.4).** Playwright queues spec files
  alphabetically and a file never spans workers, so alphabetical order put the
  long `ui-*` and `staff-compete-*` files last and the run waited on them. The
  config splits the chromium suite into up to four projects, all named
  `chromium`, by the per-file time recorded in `tests/file-timings.json`, so the
  longest files start first. A file the manifest does not know goes in the
  FIRST bucket. After adding or splitting files, run
  `npm run test:balance -- --write` to refresh the manifest; the report says
  when a file is missing from it or stale in it. Keep any one file under the
  per-file budget the report prints (about 160 s at 24 workers): a spec file
  that runs longer than that sets the length of the whole run on its own.
- **A server that dies mid-file fails ONE test, by name.** The harness checks the
  worker's server before and after every test. If it has exited, the test fails
  with the exit status and the server's last output, instead of every later test
  failing with a connection refusal that names nothing. Playwright then restarts
  the worker and the per-file recycle gives it a fresh server.
- **Coverage mode (`npm run test:coverage`)** is off unless `HACKARENA_COVERAGE`
  names a directory, so ordinary runs are unchanged. Two limits to know before
  trusting a "never executed" line: a page a test opens itself with
  `browser.newContext()` is not recorded, and work done in the last 200 ms before
  a full page reload can be lost. Do not "fix" the second with a `page.route` on
  navigations: a CDP command issued while a navigation is paused waits for the
  navigation to commit, so the route handler deadlocks the page load.
- **Nothing reaches `cxOneProvisionUser` through the server**, because the
  outbound-host allowlist refuses a localhost IDP. Since v8.12.6 a spawned child
  does: `tests/cxone-provision-harness.cjs` runs one provisioning scenario per
  process, with `lib/http`'s transport replaced before `lib/cxone` destructures it
  and `globalThis.fetch` poisoned, so a mid-flight deletion or removal can be fired
  inside the exact upstream call it is named for. Replacing a transport is
  forbidden in a Playwright WORKER (it leaks into every later spec on that worker,
  and `db.js` opens its database at require time); in a throwaway child it is
  harmless. The harness refuses to run unless its `DATA_DIR` sits under the OS temp
  directory, and its caller reads `app-*.jsonl` only after the child exits
  naturally — the log stream and the audit mirror are asynchronous.
- **The Checkmarx One withdrawal runner (`lib/cxone-withdraw.js`, v8.12.7) runs
  only in that same child.** On the shared test server it never runs at all: the
  hourly sweeper returns before it starts under `NODE_ENV=test`, no health
  predicate is configured (so the runner fails closed), and a deletion's kick is
  refused unless `CXONE_WITHDRAWAL_AUTORUN_IN_TEST=1` — which `tests/server-env.js`
  pins to `""`, so no request on the shared server can reach a realm. There is no
  test-only endpoint for it. Drive it through `provision(scenario)` in
  `tests/cxone-harness-client.js` (the parent half; it requires nothing from
  `lib/`, and the specs that use it are found with `grep -l cxone-harness-client
  tests/`): the scenario's `autorun` sets the opt-in in the child only,
  `healthy: false` makes the health predicate answer false, and ordered `steps` (`cascade`,
  `kick`, `{run}`, `{retry}`, `{dismiss}`, `list`, …) drive the runner and the
  superadmin actions after provisioning. The scenario keys are documented at the
  top of `tests/cxone-provision-harness.cjs`, which is the authority — read them
  there rather than from a copy here. The harness refuses to run if `lib/cxone.js`
  or `lib/cxone-withdraw.js` was loaded before its transport stub, because either
  would hold the real `fetchWithTimeout`.
- **A browser login and an API login as the same user cannot both be live.** The
  platform keeps one session per user, so a test that signs the superadmin in
  through the page ends the API session it opened a moment earlier. Do the API
  set-up first, or take a fresh `apiLogin` afterwards.
- **Check a new test can fail by breaking the code it guards, in a COPY of the
  tree.** `rsync` the repo to a scratch directory and run the mutated copy on its
  own `TEST_PORT_BASE`. Never mutate in place: `npm run dev` watches `lib/`,
  `routes/` and `public/`, so an in-place edit restarts your dev server, signs you
  out and changes its superadmin password.

## Versioning

Single source of truth is `version.json`. `package.json`, `docker-compose.yml` (the `image:` tag) and `swagger.yaml` (`info.version`) must all match.

```bash
npm run bump patch           # 6.8.4 → 6.8.5
npm run bump minor           # 6.8.4 → 6.9.0
npm run bump major           # 6.8.4 → 7.0.0
npm run bump 7.1.2           # explicit value
npm run check-version        # verifies all 4 files agree — run this in CI / pre-commit
```

Never hand-edit the version in any of the four files. `npm run bump` updates them together.

## Look tokens

The two looks' palettes (Signature and Ambient, each day and night, and Ambient's six ambient light colours) live in `scripts/theme/looks.js`. `npm run theme:tokens` regenerates the token block at the top of `public/styles.css` from it and fails when any text pair drops below WCAG AA; `node scripts/build-theme-tokens.js --check` only reports a stale block. Never hand-edit the block: `tests/theme-tokens.spec.js` compares it with the data. See `.claude/DESIGN_SYSTEM.md`.

## Content-hashed assets

On boot, `server.js` walks `public/` and `docs/`, computes a 12-char SHA-256 prefix for each non-HTML / non-MD file, and rewrites every self-hosted reference in HTML + Markdown to `foo.png?v=<hash>`. Hashed responses get `Cache-Control: public, max-age=1y, immutable`; un-hashed fall back to `max-age=300`.

This means:
- You don't need a build step. Change `styles.css`, the server re-hashes on restart, the URL changes, browsers re-fetch.
- The client has `window.__assetUrlWithVersion(url)` available (served as `/asset-versions.js`) for dynamic hashing — used by the help drawer to construct light/dark screenshot URLs.
- `nodemon.json`'s watch list includes `version.json`, so a `bump` restarts dev and recomputes the hash map. (It is an allow-list of source ROOTS — `server.js`, `db.js`, `version.json`, `lib/`, `routes/`, `public/`, `docs/` — see the dev-loop table above.)

## Directory structure

```
server.js              # Backend bootstrap + middleware order + boot checks + shutdown
                       #   + the deliberately-inline routes (submit/import/submissions/
                       #   logs/metrics test pins, the superadmin login, analytics)
lib/*.js               # 78 shared backend modules — regenerate this list from
                       # `ls lib/` rather than appending by memory:
                       #   account-lookup, account-reaper, admin-alerts, answer-seal, attachments, attempts,
                       #   audit, badge, best-effort, categories, certificate-config, certificate-dispatch, certificate-share, challenge-fit, choices, comp-allowlist,
                       #   competitions, config, csv, cxone, cxone-identity, cxone-ledger,
                       #   cxone-withdraw, data-dir, email, email-identity, email-proof, event-admin,
                       #   event-copies, event-policy, event-retention, event-team, event-template-builtins, full-export, group-sync, http, human-code,
                       #   image-refs, image-sweep,
                       #   impersonation, invitation-claim, late-entry, leaderboard, lockout, log, log-sort,
                       #   login-code, login-method, me-cache, middleware, multipart, participants-cache, platform-look, presence, qr,
                       #   qualifying, qualifying-rescore, query-plan, rbac, registration-fields, sanitise, scanner-classify, schema-required,
                       #   scheduler, scoring, self-enroll, session-index, sessions, settings, smtp-settings, staff-compete,
                       #   task-fields, team-recipient, team-report-mail, team-reports, time, user-tags, util, validate, zip-writer —
                       #   required directly; one process-global singleton each
routes/<entity>.js     # One module per entity: module.exports = register(app[,deps])
db.js                  # SQLite schema + migrations
public/
  index.html           # SPA shell — no inline JS / CSS; loads /js/core/main.js (module)
  js/                  # SPA as ES modules (v7.0.0):
    core/state.js      #   the single mutable S object (was the top-level globals)
    core/trusted-types.js  # TT policies + setSafeHtml/raw/html
    core/dispatcher.js #   registerAction/Change/Input registry
    core/api.js        #   csrf/fetch + session-expiry interceptor
    core/main.js       #   entry: imports every module + boot() (all wiring, run once)
    ui/*.js            #   icons, format, modal, loading, toast, richtext, nav,
                       #     theme, list-controls, profile-form
    data/country-tz.js #   country + timezone data
    features/<entity>.js  # one per domain (auth, competition-picker, challenges-admin, …)
  styles.css           # All SPA CSS
  help.js              # Full-page /help.html viewer (standalone classic script)
  help-renderer.js     # Shared markdown renderer (theme-aware img swap)
  theme-boot.js        # Synchronous theme resolution before paint; reloads once
                       # if the app's module graph fails to load; if it fails
                       # again, shows a notice with a Reload button
  verify-pages.css     # the standalone server-rendered pages: every result page
                       # (verification, email-change confirm, their failure branches:
                       # _emailResultPage in routes/auth.js; no static verify*.html
                       # files), /credential, the LinkedIn share page, and the public
                       # certificate page /badge/:token and its not-found page
                       # (routes/badge.js)
docs/                  # Each file is either admin-gated (server.js _docsPathNeedsAdmin)
                       # or on the reasoned public list a Docs-hygiene test holds
                       # (tests/functional-core-b.api.spec.js): /docs serves every
                       # other file to anyone, so a new file that is neither fails.
                       # (no docs/README.md — the role-picker landing page was
                       #  removed; a test asserts it still 404s)
  user-guide/
    participant.md     # Public; rendered in the Help drawer for participants
    admin.md           # Admin-gated via _gateAdminDocs
    event-admin.md     # Admin-gated (every admin role, event admins included)
    superadmin.md      # Admin-gated (roles acting on every event; never event admins)
  release-notes.md     # Admin-gated; the What's new drawer
  screenshots/         # Light + dark PNGs, regenerated by `npm run docs:shots`
    participant/       #   public (the participant guide's pictures)
    admin/ event-admin/ superadmin/  # admin-gated
    MANIFEST.json      #   public capture bookkeeping (release, per-role counts)
tests/
  helpers.js           # BASE, apiLogin, getSuperadminPass, freshCtx
  isolated-test.js     # THE harness — every spec requires this, not @playwright/test
  server-env.js        # The one definition of the server's hermetic test env
  global-setup.js      # Refuses to start on a squatted worker or spawner port
  *.api.spec.js        # API-only tests
  ui-*.spec.js         # Playwright UI tests
  _*.spec.js           # Opt-in helper specs (screenshots / polish / probes) —
                       #   ignored by `npm test` unless CAPTURE_SCREENSHOTS=1
perf/
  README.md            # k6 + browser-probe perf workflow
  run-local.sh         # Local throw-away target + seed + measure
  seed.js / config.js  # Seeder + its config (drives bulk-seed-users / bulk-seed-history)
  k6/scenarios/*.js    # k6 scenario scripts (competition-live, leaderboard-stress, submission-burst, login-wave, login-storm)
  k6/lib/*.js          # Shared k6 helpers (auth, csrf, http, data, participant, admin, mailbox, metrics, browser-probe, text-summary)
scripts/
  bump-version.js      # Version sync across the 4 files
  check-version.js     # CI guard
  smoke.cjs            # Real-server SPA smoke, both serving modes
  test-changed.cjs     # Re-run only this branch's specs, twice, with retries
  test-balance.cjs     # Per-worker finish spread + per-file budget; --write refreshes tests/file-timings.json
  test-independence.cjs  # Each test alone in a pristine database (manual diagnostic)
  coverage-report.cjs  # Turns a test:coverage run into .coverage/report.md
  backup.sh / purge.sh / restore-mail.sh / migrate.sh # Operator tooling (online backup, retention purge, a restore's email choice, moving to a new server) — DATA_DIR required, no default
  prune-runtime-deps.cjs # Image build stage only: strips the native addons' build residue (--check by default)
  setup-cross-browser.sh   # No-root side-load of Firefox/WebKit system libs
```

## Where does my change go?

| Change | Lives in |
|---|---|
| A backend route for an existing entity | `routes/<entity>.js` (absolute method-specific paths; `register(app[,deps])`) |
| A new backend entity | new `routes/<entity>.js` + a `require("./routes/<entity>")(app)` in `server.js` (registration order) |
| A shared backend helper / process-global cache | `lib/*.js` (one module owns each singleton; never duplicate across routes) |
| A frontend feature behaviour | `public/js/features/<entity>.js` (add functions; register `data-action` wiring in `core/main.js` boot) |
| A shared frontend UI helper | `public/js/ui/*.js`; cross-cutting state → the `S` object in `core/state.js` |
| New frontend module-load wiring (listener, init) | `core/main.js` `boot()` — **never** a top-level side-effect in a feature/ui module (bodies stay side-effect-free so ESM eval order can't bite) |

**Verify both serving modes** before a frontend change ships: `npm test` (dev, raw modules) **and** `MINIFY_JS=1 npm test` (prod, esbuild entry-bundle). For a fast end-to-end runtime check, `npm run smoke` boots a real server in **both** modes, drives the SPA in headless Chromium (login → every sidebar section, Raw logs from Audit → create an event → its Join-Link QR image and its workspace's Activity), and asserts the JS-request shape (many `/js/**` modules in dev vs one bundled `/js/core/main.js` in prod).

## Running a single test

```bash
npx playwright test tests/ui-admin-tasks.spec.js -g "delete available in task kebab"
```

Debug UI:

```bash
npm run test:ui
```

With retries-off strict mode:

```bash
WORKERS=1 RETRIES=0 npx playwright test tests/ui-admin-tasks.spec.js
```

## Environment variables

See `README.md § Environment Variables` for the canonical table. A handful relevant to dev:

- `BASE_URL` (required) — set to `http://localhost:3000` locally.
- `DATA_DIR` (**required**, v8.8.26) — the data volume. `npm start` and `npm run dev` default it to `./data` (`${DATA_DIR:-./data}`, so exporting your own still wins) and the image sets `/app/data`, so an ordinary run is unchanged. **A script, a one-off `node -e "require('./db')"` or a spawned test child now REFUSES rather than guessing** — `db.js` opens the database at require time, so a guessed path attaches to whatever data directory sits beside the code, which on a developer's box is the live one. The operator scripts follow the same rule: `scripts/backup.sh`, `scripts/purge.sh`, `scripts/restore-mail.sh` and `scripts/migrate.sh` (`pack`, `unpack`) exit non-zero, naming the variable, before they read or write anything, so name the directory explicitly. `playwright.config.js` pins it for the worker **unconditionally** (`data-test-worker-<base>`) — since v8.12.6 it no longer reads `process.env.DATA_DIR || …`, because the shell that runs `npm run dev` usually exports `DATA_DIR` pointing at the dev instance, and under the old `||` every Playwright worker started from that shell inherited it: measured, test log lines written into the dev instance's `app-*.jsonl`, and a spec requiring a db-reaching `lib/` module in-process would have opened the dev database and run the migrations of the tree under test against it. A spec that needs a different directory sets `process.env.DATA_DIR` itself after the config has run (the trusted-networks and completion-credential specs point it at the per-file server's directory). A spawned child must pass its own, and a Docs-hygiene scanner enforces that for every `spawn`/`execFileSync` in `tests/`; a second one ("the test worker's DATA_DIR and UPLOADS_DIR are pinned, never inherited from the shell") holds the unconditional pin.
- `UPLOADS_DIR` (**required**, v8.8.27) — the uploads volume, a SEPARATE filesystem from `DATA_DIR`. Same shape and a sharper reason: the server sweeps this directory at every boot, so a guessed path is one it deletes from — which is how v8.8.15 found the test suite deleting from the live volume. `npm start` / `npm run dev` default it to `./uploads`; `playwright.config.js` pins `uploads-test-worker-<base>` for the worker — unconditionally too, for the `DATA_DIR` reason above — and the same scanners that cover `DATA_DIR` cover this. So an exported `DATA_DIR` / `UPLOADS_DIR` no longer reaches a Playwright worker. It still reaches anything else you run from that shell, which is what you want for `npm run dev` and exactly what you do not want for a one-off `node` script that requires `db.js` — unset them there (`env -u DATA_DIR -u UPLOADS_DIR …`). The same holds for the operator scripts: their refusal fires only when `DATA_DIR` is ABSENT, so in a shell that exports the dev instance's `DATA_DIR` they act on the dev instance — name the directory you mean on the command line, and never run `purge.sh --apply` from that shell by accident.
- `SMTP_HOST` (required) — point at a local sink (mailpit / smtp4dev / maildev).
- `NODE_ENV=test` — activates test-only routes (the last-sign-in-code read, rate-limit toggle, deterministic delay hooks, etc.). Playwright sets this automatically per worker.
- `RATE_LIMIT_DISABLED=1` — bypass the in-memory rate limiter. Tests set this; dev sets it when you're smashing the login endpoint for debugging.
- `SUPERADMIN_PASSWORD_QUIET=1` — suppress the superadmin password banner. For clean logs.
- `MINIFY_JS=1` — serve the SPA as the production esbuild bundle instead of raw modules, for a parity check.
- `LOG_SCAN_BUDGET=N` (default 200000, floor 1000) — how many log lines `GET /api/admin/logs` will walk per request. Lower it to reach the "the ranking covers only what was scanned" branch without planting a huge fixture; `tests/logs-global-sort.api.spec.js` spawns its own server to do exactly that. `tests/logs-audit-paging.api.spec.js` spawns a server with a low budget too, for the Audit log's `searched_to` and the cursor that searches on.
- `LOG_SORT_MAX_WINDOW=N` (default 25000, floor 100) — deepest `offset + limit` for which a filtered Logs read is ranked across every match.
- `CXONE_WITHDRAWAL_AUTORUN_IN_TEST=1` — harness-only. Read only when `NODE_ENV=test`, where it lets a deletion start the Checkmarx One withdrawal runner; `tests/server-env.js` pins it to `""` for every test server, and only the spawned `tests/cxone-provision-harness.cjs` child sets it. Irrelevant in production, where the opt-in is never consulted.
- `TEST_PORT_BASE=N` — moves the worker ports **and the data directories together** (`dataDirFor`, v7.21.35): at a non-default base the directory is `data-test-<base>-<i>`, so two runs on *different* bases no longer collide and you do **not** need to copy the tree. (This entry used to say the opposite — that the directory keyed on `TEST_PARALLEL_INDEX` alone — which had been false since v7.21.35.) Two runs on the **same** base still collide, and that is now a loud refusal rather than silent destruction: global-setup checks every worker and spawner port before touching anything, and no longer wipes data directories at all (v8.3.26). The old symptom, `Login failed for superadmin: 401` from a recreated `.superadmin-password`, is what that change removes.

## What Claude Code sees

There's a `CLAUDE.md` at the repo root that is the LLM-facing brief: architecture, design constraints, test hooks, gotchas. If you're making a change and you think an agent would need to know about it, update `CLAUDE.md` in the same commit as the code change.

## Submitting a PR

Open a draft pull request against `main`; the CI jobs and the release image workflow are described in CLAUDE.md, *Deployment and CI image*.

<!-- DOC-REGISTRY
# v8.3.24 — see AUTH_PATHS.md's registry for the design. The repository map
# below enumerates lib/, which CLAUDE.md records drifting by sixteen modules
# before anyone noticed; a module added later errors nowhere, it just stops
# being true.
DOC-MODULE: lib/*.js
DOC-SYMBOL: dataDirFor
DOC-SYMBOL: recycleServer
DOC-SYMBOL: TEST_PORT_BASE
DOC-SYMBOL: TEST_PARALLEL_INDEX
DOC-EXEMPT: tests/foo.spec.js -- a deliberate placeholder in a copy-paste command example, not a real spec.
-->
