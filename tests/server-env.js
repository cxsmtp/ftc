// @ts-check
//
// v7.20.0 — ONE definition of the test server's launch parameters.
//
// It used to live inline in playwright.config.js's workerServer(). Per-file
// isolation needs to spawn the same server from the test process too, and a
// second copy of a 40-key env is exactly the kind of duplicate that drifts
// silently — the suite would still run, just against a subtly different server
// than CI's, which is the failure mode this whole file is designed to prevent.
const path = require("path");

const DEFAULT_PORT_BASE = 4567;
const PORT_BASE = parseInt(process.env.TEST_PORT_BASE || String(DEFAULT_PORT_BASE), 10);

// v7.21.35 — THE DATA DIRECTORY NOW FOLLOWS THE PORT BASE, which closes the
// v7.20.9 footgun and is what makes concurrent runs possible at all.
//
// Before this, the port came from TEST_PORT_BASE and the directory came from
// TEST_PARALLEL_INDEX alone — so a second run started with a different port
// base still claimed `data-test-0`, and global-setup `rm -rf`s it. Two runs
// therefore destroyed each other's database while talking happily to different
// ports, and the symptom pointed nowhere near the cause: `Login failed for
// superadmin: 401`, because `.superadmin-password` was recreated underneath the
// run already using it. That trap cost an hour once and was documented as
// "TEST_PORT_BASE is a collision escape hatch, NOT an isolation mechanism".
// It is one now: one knob moves both, so they cannot disagree.
//
// The DEFAULT base keeps the bare `data-test-<i>` name, so an ordinary `npm
// test` is byte-for-byte unchanged and `.gitignore`'s `/data-test-*/` still
// covers the namespaced variants.
function dataDirFor(i) {
  const ns = PORT_BASE === DEFAULT_PORT_BASE ? `${i}` : `${PORT_BASE}-${i}`;
  return path.resolve(__dirname, "..", `data-test-${ns}`);
}
function portFor(i) { return PORT_BASE + i; }

/**
 * The HERMETIC environment for a test server.
 *
 * v7.15.27 — 25 of the 40 env vars this app reads were inherited from whatever
 * shell ran the suite. That is the same defect class as the BASE_URL crash
 * (v7.15.26): local and CI silently take different code paths, and the
 * difference only surfaces as an unexplained CI failure.
 *
 * Each value below is the code's OWN default, so behaviour is unchanged — what
 * changes is that a developer's shell can no longer alter it. The deliberately
 * overridable knobs (MINIFY_JS for the documented prod-parity run, WORKERS,
 * TEST_PORT_BASE) are intentionally NOT pinned.
 *
 * The SMTP block is the one with teeth. SMTP_PORT defaults to 587 in code but
 * one operator's shell exported 25 — and plenty of Linux boxes run a local MTA
 * on 25, so on such a machine the suite would have genuinely DELIVERED the mail
 * it thinks it is only attempting.
 */
function serverEnv(i) {
  const port = portFor(i);
  const dataDir = dataDirFor(i);
  return {
    // Inherited on purpose: node needs these to run at all.
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // NODE_OPTIONS is scrubbed (v7.15.30): it is inherited by every child, so an
    // ambient --require changes the exit path of a server a test asserts on.
    NODE_OPTIONS: "",
    // Overridable knobs — deliberately passed through when set.
    ...(process.env.MINIFY_JS ? { MINIFY_JS: process.env.MINIFY_JS } : {}),
    ...(process.env.CI ? { CI: process.env.CI } : {}),

    NODE_ENV: "test",
    PORT: String(port),
    BASE_URL: `http://localhost:${port}`,
    DATA_DIR: dataDir,
    UPLOADS_DIR: `${dataDir}/uploads`,
    SMTP_HOST: "localhost",
    RATE_LIMIT_DISABLED: "1",
    // v8.1.0 (PR 33) — the LOGIN_CODES_ENABLED pin is gone with the flag. The
    // sign-in-code path is now simply what the platform does, so every anonymous
    // request in the suite exercises the shipped branch by default rather than a
    // configuration production does not have.
    LOGIN_CODE_TTL_MS: "600000",
    LOGIN_CODE_MAX_SENDS: "3",
    // v8.12.7 — the Checkmarx One withdrawal runner never runs on its own under
    // NODE_ENV=test unless this is "1". Pinned OFF, so a developer's shell cannot
    // point the shared test server at a realm; the spawned provisioning harness
    // opts in for its own process only.
    CXONE_WITHDRAWAL_AUTORUN_IN_TEST: "",

    SMTP_PORT: "587",
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_ALLOW_PLAINTEXT: "",
    SMTP_POOL_MAX_CONNECTIONS: "16",
    SMTP_POOL_MAX_MESSAGES: "100",
    EMAIL_FROM: "Hack Arena Test <no-reply@test.invalid>",
    // Settings → About & health: no backups folder mounted and no release build,
    // whatever the developer's shell holds (tests/about-health.spec.js spawns
    // its own server with them set).
    BACKUP_DIR: "",
    BUILD_COMMIT: "",
    BUILD_TIME: "",
    RELEASE_CHANNEL: "",
    HSTS: "1",
    LOG_LEVEL: "info",
    LOG_SKIP_IPS: "",
    LOG_MIN_FREE_MB: "500",
    LOG_MIN_FREE_PCT: "5",
    // v7.25.0 — pinned at the shipped defaults so the suite exercises the
    // production walk. tests/logs-global-sort.api.spec.js overrides
    // LOG_SCAN_BUDGET in a server it spawns ITSELF, which is the only way to
    // reach the "the ranking covers only what was scanned" branch without
    // planting a 200 000-line fixture in every worker.
    LOG_SCAN_BUDGET: "200000",
    LOG_SORT_MAX_WINDOW: "25000",
    EVENT_RETENTION_DAYS: "730",
    EXTERNAL_FETCH_TIMEOUT_MS: "10000",
    PERF_SPAN_SLOW_MS: "300",
    RATE_LIMIT_ALLOWLIST_IPS: "",
    RATE_LIMIT_CSRF_PER_MIN: "120",
    RATE_LIMIT_CONFIG_PER_MIN: "120",
    RATE_LIMIT_LOGIN_PER_MIN: "60",
    COMPETITION_NAME: "Checkmarx Enablement Platform",
    HACKATHON_START: new Date(Date.now() - 60 * 60_000).toISOString(),
    HACKATHON_DURATION_MINUTES: "180",
    // Force trust-proxy OFF regardless of shell state — the TRUST_PROXY test
    // asserts the safe default.
    TRUST_PROXY: "",
    // CTF-0026 — a small per-IP login backstop so the backstop test trips in
    // ~80 distinct-email requests instead of the 600 production default.
    RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN: "80",
    // v9.0.0 — and a small per-IP address-proof budget (production 150 per 15
    // minutes), so its test trips after ~40 new addresses.
    RATE_LIMIT_PROOF_IP_PER_15MIN: "40",
    TEST_PARALLEL_INDEX: String(i),
  };
}

// PORTS fetch() REFUSES. Node's fetch and Chromium enforce the Fetch standard's
// port blocking: a request to one of these fails before it leaves ("bad port",
// the browser's ERR_UNSAFE_PORT), so a test server bound to one boots and then
// looks dead to every spec that reaches it (a TEST_PORT_BASE of 6500 put
// late-entry-mail's +197 on 6697). Measured from Node's own fetch over ports
// 1-11000 (tests/functional-core-b.api.spec.js re-measures every entry);
// global-setup refuses a base that lands on one, and the runners avoid them.
const FETCH_BLOCKED_PORTS = Object.freeze([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const blockedPortsIn = (ports) => ports.filter(p => FETCH_BLOCKED_PORTS.includes(p));
// The `count` bases from `start` upwards in steps of `stride` whose whole window
// [base, base + stride) holds no port fetch() refuses: a run per base (an
// independence shard) then never meets one, whatever offset its specs bind.
function cleanPortBases(start, stride, count) {
  const out = [];
  for (let b = start; out.length < count && b + stride <= 65536; b += stride) {
    if (!blockedPortsIn(Array.from({ length: stride }, (_, i) => b + i)).length) out.push(b);
  }
  return out;
}

module.exports = { PORT_BASE, portFor, dataDirFor, serverEnv, FETCH_BLOCKED_PORTS, blockedPortsIn, cleanPortBases };
