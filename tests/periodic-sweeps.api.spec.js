// @ts-check
/**
 * v8.8.15 — TWO FILE SWEEPS THAT ONLY EVER RAN AT BOOT.
 *
 * The platform is a long-uptime single process, so "swept at boot" means
 * "reclaimed at the next deployment". Two directories were on that footing:
 *
 *   * UPLOADS_DIR, whose stranded submission temps matter beyond disk — it is a
 *     SEPARATE VOLUME from DATA_DIR and the upload capacity check measures free
 *     space on it (v7.15.12), so accumulation eventually REFUSES legitimate
 *     uploads; and
 *   * attachments-staging/, whose ROW sweep has run every 10 minutes since
 *     v6.16.x while the FILE sweep beside it did not — so a ZIP of up to 64 MB
 *     stranded by a crash between the rename and the INSERT sat on the
 *     BACKED-UP DATA_DIR volume, invisible to the staging byte ceiling, which
 *     counts the table rather than the disk.
 *
 * THE GUARD IS THE POINT OF THIS FILE, not the timer. Adding a timer to the
 * staging file sweep AS IT WAS reproduces the v6.16.9 data-loss bug exactly:
 * `POST /api/admin/attachment-staging` renames the file into the directory
 * BEFORE its INSERT, so a tick landing in that window deletes a file no row
 * references yet and the INSERT then commits a row pointing at nothing —
 * silent, and surfacing much later as a download 404. Every positive assertion
 * here has its in-flight control beside it for that reason.
 *
 * Both sweeps are `setInterval` bodies disabled under NODE_ENV=test, so
 * `POST /api/test/sweep-attachments` is the only way to drive them.
 */
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DATA_DIR } = require("./helpers");
const fs = require("fs");
const path = require("path");

const STAGING = path.join(TEST_DATA_DIR, "attachments-staging");
// The test server sets UPLOADS_DIR under the per-file data dir (tests/server-env.js)
// rather than the repo-root default, so derive it from TEST_DATA_DIR — never
// hand-roll it, which is the path-hygiene defect v8.3.16 had to fix twice.
const UPLOADS = path.join(TEST_DATA_DIR, "uploads");

/** Write a file and age it past `ageMs` on BOTH timestamps the sweep reads. */
function plant(dir, name, ageMs) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

test.describe("v8.8.15 — the staging and uploads sweeps run on a timer", () => {
  /** @type {any} */ let sa;
  test.beforeAll(async () => { sa = await apiLogin("superadmin"); });

  /**
   * Drive one pass of all three file sweeps.
   *
   * `stagingRecencyMs` exists because `ctime` cannot be moved from userspace —
   * which is precisely why the sweep reads it (v6.16.14: `mtime` IS settable, so
   * a future writer that backdates it would otherwise race the sweep). A file
   * this process just wrote therefore always reads as fresh, and without a knob
   * the reaping half would be untestable, leaving "the sweep reaps nothing"
   * unkilled. Omit it and the shipped 5 minutes applies — which is what the
   * guard test below asserts.
   */
  const sweep = async (data = {}) => {
    const r = await sa.api.post("/api/test/sweep-attachments", {
      headers: { "x-csrf-token": sa.csrf, "content-type": "application/json" }, data,
    });
    expect(r.ok(), `sweep: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  };

  test("THE GUARD: a FRESH orphaned staging file is NOT reaped", async () => {
    // This is the whole reason the sweep could not simply be put on a timer. The
    // file is younger than the 5-minute window, so it is presumed in-flight —
    // which, on the real path, it is: the bytes are on disk and the row is
    // milliseconds away.
    const p = plant(STAGING, `inflight-${Date.now()}.zip`, 0);
    await sweep();
    expect(fs.existsSync(p), "an in-flight upload survives the sweep").toBe(true);
    fs.unlinkSync(p);
  });

  test("…and an orphan past the window IS reaped", async () => {
    // The control for the assertion above. Without it, "the fresh file
    // survived" is equally satisfied by a sweep that reaps nothing at all —
    // which is the boot-only state this release is fixing, so it is the one
    // mutation that must not pass.
    const p = plant(STAGING, `orphan-${Date.now()}.zip`, 0);
    const out = await sweep({ stagingRecencyMs: 0 });
    expect(out.staging, "the orphan was reaped").toBeGreaterThan(0);
    expect(fs.existsSync(p), "…and is gone from disk").toBe(false);
  });

  test("a staging file WITH a row is never reaped, however old", async () => {
    // The reference check is the primary rule and the recency guard is the
    // safety net; this pins the primary one, or "the sweep is conservative"
    // would be satisfied by a build that reaps only what the timer permits.
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const id = `sweeprow${Date.now().toString(36)}`;
    const rel = path.posix.join("attachments-staging", `${id}.zip`);
    const p = plant(STAGING, `${id}.zip`, 20 * 60_000);
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare(
        "INSERT INTO task_attachments_staging (id, admin_id, display_name, original_name, size_bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(id, "superadmin", "d.zip", "d.zip", 1, "x".repeat(64), rel, new Date().toISOString());
    } finally { db.close(); }

    // Window at zero, so ONLY the reference check can be protecting it.
    await sweep({ stagingRecencyMs: 0 });
    expect(fs.existsSync(p), "a referenced file is left alone").toBe(true);

    const db2 = new Database(TEST_DB_PATH);
    try { db2.prepare("DELETE FROM task_attachments_staging WHERE id=?").run(id); } finally { db2.close(); }
    try { fs.unlinkSync(p); } catch (_) {}
  });

  test("BOTH sweeps are actually on a timer — the half NODE_ENV=test cannot run", async () => {
    // The intervals are disabled under test, so every behavioural assertion in
    // this file is equally satisfied by the boot-only build this release is
    // fixing: they all drive the functions through the test hook. This is the
    // arm that fails if the timer is never registered.
    //
    // Comments are stripped first — the code above these registrations explains
    // at length why they were boot-only and why that was wrong, quoting the very
    // shapes matched here (the v7.21.13 class).
    const fs = require("fs"), path = require("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? "" : pre));

    // Anti-vacuity: a rename would empty every match below and pass in silence.
    expect(src, "the uploads sweep exists under this name").toContain("_sweepUploadsTemp");
    expect(src, "the staging file sweep exists under this name").toContain("_sweepStagingFiles");

    // Each must appear inside a setInterval body. The window is generous because
    // the staging one shares its tick with the row sweep beside it.
    for (const [fn, label] of [["_sweepUploadsTemp", "uploads temps"], ["_sweepStagingFiles", "staging orphans"]]) {
      const ticked = new RegExp(`setInterval\\(\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]{0,900}?${fn}\\(`).test(src);
      expect(ticked, `${label} are swept on a timer, not only at boot`).toBe(true);
    }
  });

  test("v8.12.7 (F2): the realm-account withdrawal sweeper is on a timer, off under test, and started only once the server listens", async () => {
    // The same half-that-NODE_ENV=test-cannot-run as the two sweeps above. The
    // sweeper is what retries a withdrawal the realm refused, picks up a stamp
    // whose kick was lost, and ages rows towards "given up"; every behavioural
    // arm drives the runner through the harness instead, so without this arm a
    // build that never registers the timer passes everything.
    //
    // It must RETURN under test before it arms anything (the shared test server
    // may never call a realm), carry no module-scope timer (a require would
    // start one — in every spec that loads the module, and in the harness child,
    // which exits only once nothing holds its loop), and start from the listen
    // callback, after the boot checks it reads its health gate from.
    // Comments stripped first — the module narrates all four rules.
    const fs = require("fs"), path = require("path");
    const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) =>
      pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
    const w = strip(fs.readFileSync(path.join(__dirname, "..", "lib/cxone-withdraw.js"), "utf8"));
    const srv = strip(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));

    const hdr = w.search(/^function\s+startCxOneWithdrawalSweeper\s*\(/m);
    expect(hdr, "startCxOneWithdrawalSweeper exists under this name (anti-vacuity)").toBeGreaterThan(-1);
    const close = w.indexOf("\n}", hdr);
    const sweeper = w.slice(hdr, close + 2);
    const timers = [...w.matchAll(/\bsetInterval\s*\(/g)].map(m => m.index);
    const guardAt = sweeper.search(/if\s*\(\s*process\.env\.NODE_ENV\s*===\s*"test"\s*\)\s*return\s*;/);
    const armAt = sweeper.search(/\bsetInterval\s*\(/);

    const listenAt = srv.search(/_httpServer\s*=\s*app\.listen\s*\(\s*PORT\s*,/);
    const starts = [...srv.matchAll(/\bstartCxOneWithdrawalSweeper\s*\(/g)].map(m => m.index);
    const checks = {
      "the sweeper's interval body kicks the runner":
        /setInterval\(\s*\(\)\s*=>\s*\{\s*_kick\(\s*\)\s*;?\s*\}\s*,\s*SWEEP_INTERVAL_MS\s*\)/.test(sweeper),
      "it returns under NODE_ENV=test BEFORE it arms the interval": guardAt > -1 && armAt > guardAt,
      "…and the guard is the function's first statement (nothing runs before it)":
        /^function\s+startCxOneWithdrawalSweeper\s*\([^)]*\)\s*\{\s*if\s*\(\s*process\.env\.NODE_ENV\s*===\s*"test"\s*\)\s*return\s*;/.test(sweeper),
      "the module has exactly one setInterval, and it is inside the sweeper (no module-scope timer)":
        timers.length === 1 && timers[0] > hdr && timers[0] < close,
      "no timer call sits at column 0": !/^(?:setInterval|setTimeout)\s*\(/m.test(w),
      "server.js starts the sweeper exactly once": starts.length === 1,
      "…from the listen callback, handing it the readiness health gate":
        listenAt > -1 && starts.length === 1 && starts[0] > listenAt
        && /startCxOneWithdrawalSweeper\(\s*\{\s*isHealthy\s*:/.test(srv),
      "…and stops it at shutdown": /\bstopCxOneWithdrawalSweeper\s*\(\s*\)/.test(srv),
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "the withdrawal sweeper's lifecycle drifted:\n  " + failing.join("\n  ")).toEqual([]);
  });

  test("v8.14: a pending Checkmarx One set-up retry is stopped — not flushed — at shutdown, and resumed on a LIVE health gate outside test", async () => {
    // A retry flushed into the 5 s drain would send creates the exit can cut
    // mid-flight: accounts nothing records. So shutdown must STOP them (no remote
    // work, a truthful History row each) before the drain, and the next boot must
    // resume what the rows promised — once the instance is in service, on the
    // withdrawal runner's own gate read live, so a boot in maintenance resumes
    // them when it is lifted rather than never. Behaviourally the stop and the
    // resume are driven through the harness (tests/cxone-replacement-takeover.spec.js);
    // this pins the WIRING, which no harness arm can see. Comments stripped first.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const srv = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const cx = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib/cxone.js"), "utf8"));
    const fnOf = (src, name) => {
      const at = src.search(new RegExp(`^function\\s+${name}\\s*\\(`, "m"));
      return at < 0 ? "" : src.slice(at, src.indexOf("\n}", at) + 2);
    };
    const gs = fnOf(srv, "gracefulShutdown");
    expect(gs, "gracefulShutdown exists under this name (anti-vacuity)").not.toBe("");
    const stopAt = gs.search(/=\s*stopCxOneProvisionRetries\(\s*\)/);
    const drainAt = gs.search(/const\s+drainAndClose\s*=/);
    const listenAt = srv.search(/_httpServer\s*=\s*app\.listen\s*\(\s*PORT\s*,/);
    const starts = [...srv.matchAll(/\bstartCxOneProvisionResume\s*\(/g)].map(m => m.index);
    const gate = "_dbIntegrityOk\\s*&&\\s*_dbSchemaOk\\s*&&\\s*!_maintenanceState\\(\\)\\.active";
    const stopFn = fnOf(cx, "stopCxOneProvisionRetries");
    const startFn = fnOf(cx, "startCxOneProvisionResume");
    const checks = {
      "gracefulShutdown stops the set-up retries": stopAt > -1,
      "…before the drain starts": stopAt > -1 && drainAt > stopAt,
      "…and server.js calls the stop exactly once": (srv.match(/\bstopCxOneProvisionRetries\s*\(/g) || []).length === 1,
      "the stop marks stopping FIRST, so a set-up that defers during the drain cannot reschedule":
        /^function\s+stopCxOneProvisionRetries\s*\(\s*\)\s*\{\s*_retriesStopping\s*=\s*true\s*;/.test(stopFn),
      "…cancels a boot resume still waiting for its gate": /\b_endResumeWait\(\s*\)/.test(stopFn),
      "…clears each timer and starts nothing remote (no enqueue, no fetch, no retry fired, no resume)":
        /clearTimeout\(\s*e\.timer\s*\)/.test(stopFn) && !/\b(enqueueCxOneProvision|fetchWithTimeout|_fireProvisionRetry|resumeDeferredCxOneProvisioning)\s*\(/.test(stopFn),
      "…and records each stop on the participant's History": /recordUserEvent\([^;]*stopped\s*:\s*"shutdown"/.test(stopFn),
      "server.js starts the boot resume exactly once": starts.length === 1,
      "…from the listen callback, only outside test": listenAt > -1 && starts[0] > listenAt
        && /if\s*\(\s*process\.env\.NODE_ENV\s*!==\s*"test"\s*\)\s*startCxOneProvisionResume\(\s*\{\s*isHealthy\s*:\s*_instanceInService\s*\}\s*\)/.test(srv),
      "…on the withdrawal runner's own predicate, the instance-health gate": new RegExp(`function\\s+_instanceInService\\s*\\(\\s*\\)\\s*\\{\\s*return\\s+${gate}\\s*;\\s*\\}`).test(srv)
        && /startCxOneWithdrawalSweeper\(\s*\{\s*isHealthy\s*:\s*_instanceInService\s*\}\s*\)/.test(srv),
      "…written once: no copy of the gate stands in for it": (srv.match(new RegExp(gate, "g")) || []).length === 1
        && (srv.match(/\bfunction\s+_instanceInService\s*\(/g) || []).length === 1,
      "server.js never resumes past the gate": !/\bresumeDeferredCxOneProvisioning\s*\(/.test(srv),
      "the gate is read LIVE: an unref'd interval re-checks it until it passes": /setInterval\(\s*check\s*,\s*RESUME_CHECK_MS\s*\)/.test(startFn)
        && /\.unref\(\s*\)/.test(startFn),
      "…once per process": /if\s*\(\s*_resumeStarted\s*\|\|\s*_retriesStopping\s*\)\s*return\s+null\s*;\s*_resumeStarted\s*=\s*true\s*;/.test(startFn),
      "no timer call sits at column 0 in lib/cxone.js (no module-scope timer)": !/^(?:setInterval|setTimeout)\s*\(/m.test(cx),
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "the set-up retries' lifecycle drifted:\n  " + failing.join("\n  ")).toEqual([]);
  });

  test("both mail workers start only from the listen callback, each after its hold (the instance-health gate) is set", () => {
    // The port binds only once a previous instance has released it, so each
    // worker's boot recovery (a `sending` row marked `unknown`) can never mark a
    // send a LIVE instance still has in flight; and no pass may run before the
    // hold can stop it (outside test the dispatcher's first pass runs at once).
    // Each hold is the one instance-health gate the Checkmarx One runners read,
    // never a predicate of its own: a hold of their own is how the mail workers
    // came to ask about maintenance alone and mail from a corrupt or half-migrated
    // database. Behaviour cannot show the order (under test the workers' timers
    // never run); what the gate holds is driven in
    // tests/mail-hold-instance-health.spec.js and
    // tests/mail-hold-maintenance.api.spec.js. Comments stripped first.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const srv = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const listenAt = srv.search(/_httpServer\s*=\s*app\.listen\s*\(\s*PORT\s*,/);
    const certStarts = [...srv.matchAll(/\bstartCertificateDispatcher\s*\(\s*\)/g)].map(m => m.index);
    const teamStarts = [...srv.matchAll(/\.startTeamReports\s*\(\s*\)/g)].map(m => m.index);
    const certHolds = [...srv.matchAll(/\bsetCertificateMailHold\s*\(/g)].map(m => m.index);
    const teamHolds = [...srv.matchAll(/\.setTeamReportMailHold\s*\(/g)].map(m => m.index);
    const certHold = certHolds[0], teamHold = teamHolds[0];
    const checks = {
      "listen found (anti-vacuity)": listenAt > -1,
      "server.js starts each mail worker exactly once": certStarts.length === 1 && teamStarts.length === 1,
      "…from the listen callback": certStarts[0] > listenAt && teamStarts[0] > listenAt,
      "…and sets each hold exactly once": certHolds.length === 1 && teamHolds.length === 1,
      "…the certificate dispatcher after its mail hold is set": certHold > listenAt && certHold < certStarts[0],
      "…the team reports after theirs": teamHold > listenAt && teamHold < teamStarts[0],
      "…each hold is the instance-health gate (`_instanceInService`), negated, never maintenance alone":
        /\bsetCertificateMailHold\(\s*\(\s*\)\s*=>\s*!\s*_instanceInService\(\s*\)\s*\)/.test(srv)
        && /\.setTeamReportMailHold\(\s*\(\s*\)\s*=>\s*!\s*_instanceInService\(\s*\)\s*\)/.test(srv),
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "the mail workers' start drifted:\n  " + failing.join("\n  ")).toEqual([]);
  });

  test("the start-reminder dispatcher and the lockout-expiry pass hold on the instance-health gate itself, before the pass (and the dispatcher before each claim), never a copy", () => {
    // Operator ruling, 25 Nov 2026: no start reminder and no "your account is
    // unlocked" mail goes out from a copied, restored, corrupt or half-migrated
    // database. Both passes live in server.js beside the gate, so each asks
    // `_instanceInService()` directly. Behaviour: tests/mail-hold-maintenance.api.spec.js
    // (maintenance, mid-batch) and tests/mail-hold-instance-health.spec.js (a failed
    // boot check); this pins what behaviour cannot see: the hold sits before the
    // pass starts (a held tick touches no row, the stale-claim sweep included),
    // every caller goes through it, and it is the one gate, never a copy.
    // Comments stripped first.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const srv = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const fnOf = (re) => {
      const at = srv.search(re);
      return at < 0 ? "" : srv.slice(at, srv.indexOf("\n}", at) + 2);
    };
    const rem = fnOf(/^async\s+function\s+runReminderTick\s*\(/m);
    const lock = fnOf(/^function\s+runLockoutExpiryPass\s*\(/m);
    const loopAt = rem.search(/for\s*\(\s*const\s+r\s+of\s+due\s*\)\s*\{/);
    const perRow = /for\s*\(\s*const\s+r\s+of\s+due\s*\)\s*\{\s*if\s*\(\s*!\s*_instanceInService\(\s*\)\s*\)\s*\{[^}]*\bbreak\s*;/.exec(rem);
    const claimAt = rem.search(/\bclaimStmt\.run\s*\(/);
    const sweepAt = rem.search(/UPDATE\s+email_reminders\s+SET\s+claimed_at\s*=\s*NULL/);
    // Every place that reads the gate, by what reads it: the list CLAUDE.md
    // (Maintenance mode) states. A new reader is a decision recorded there.
    const readers = [...srv.matchAll(/\b_instanceInService\b/g)].map(m => {
      const before = srv.slice(0, m.index);
      const fn = [...before.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)].pop();
      const line = srv.slice(before.lastIndexOf("\n") + 1, srv.indexOf("\n", m.index));
      if (/^function\s+_instanceInService\s*\(/.test(line)) return "definition";
      if (/setCertificateMailHold\(/.test(line)) return "certificate hold";
      if (/setTeamReportMailHold\(/.test(line)) return "team-report hold";
      if (/startCxOneWithdrawalSweeper\(/.test(line)) return "CxOne withdrawals";
      if (/startCxOneProvisionResume\(/.test(line)) return "CxOne resume";
      if (/startEventRetentionReaper\(/.test(line)) return "image sweep (daily retention pass)";
      if (/opts\.isHealthy\s*=\s*_instanceInService\s*;/.test(line)) return "image sweep (purge-events test hook)";
      if (/require\("\.\/routes\/admin-misc"\)\(/.test(line)) return "image sweep (manual retention purge)";
      return fn ? fn[1] : line.trim();
    });
    const checks = {
      "runReminderTick found, with its loop (anti-vacuity)": rem !== "" && loopAt > -1,
      "runLockoutExpiryPass found (anti-vacuity)": lock !== "",
      "every caller goes through runReminderTick (definition, interval, test hook)": (srv.match(/\brunReminderTick\s*\(/g) || []).length === 3,
      "every caller goes through runLockoutExpiryPass (definition, interval, test hook)": (srv.match(/\brunLockoutExpiryPass\s*\(/g) || []).length === 3,
      "the reminder hold is asked BEFORE the pass starts, answering held:true":
        /if\s*\(\s*!\s*_instanceInService\(\s*\)\s*\)\s*return\s*\{[^}]*\bheld\s*:\s*true[^}]*\}\s*;\s*_reminderTickRunning\s*=\s*true\s*;/.test(rem),
      "…so before the stale-claim sweep": sweepAt > -1 && rem.search(/_instanceInService\(/) < sweepAt,
      "…and again first in the loop, before each claim": !!perRow && claimAt > -1 && loopAt + perRow[0].length <= claimAt,
      "the lockout pass is held first, answering held:true":
        /^function\s+runLockoutExpiryPass\s*\(\s*\)\s*\{\s*if\s*\(\s*!\s*_instanceInService\(\s*\)\s*\)\s*return\s*\{[^}]*\bheld\s*:\s*true[^}]*\}\s*;/.test(lock),
      "…before it reads or clears any lock": lock.search(/_instanceInService\(/) < lock.search(/\bexpiredLockouts\s*\(/)
        && lock.search(/\bexpiredLockouts\s*\(/) < lock.search(/\bclearLockout\s*\(/),
      "neither pass copies the gate": ![rem, lock].some(f => /_maintenanceState\(|_dbIntegrityOk|_dbSchemaOk/.test(f)),
      "the 30 s timers call the passes, nothing else": /setInterval\(\s*\(\)\s*=>\s*\{\s*runReminderTick\(\s*\)\s*;\s*\}\s*,\s*30_000\s*\)/.test(srv)
        && /setInterval\(\s*\(\)\s*=>\s*\{\s*runLockoutExpiryPass\(\s*\)\s*;\s*\}\s*,\s*30_000\s*\)/.test(srv),
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "the reminder / lockout-expiry hold drifted:\n  " + failing.join("\n  ")).toEqual([]);
    expect(readers.sort(), "every reader of the instance-health gate, as CLAUDE.md (Maintenance mode) lists them").toEqual([
      "CxOne resume", "CxOne withdrawals", "certificate hold", "definition", "runLockoutExpiryPass",
      "runReminderTick", "runReminderTick", "team-report hold",
      "image sweep (daily retention pass)", "image sweep (purge-events test hook)", "image sweep (manual retention purge)",
    ].sort());
  });

  test("the orphaned-image sweep runs only under the instance-health gate: every door hands it in, and a pass without it holds", () => {
    // The sweep deletes pictures on the strength of a complete read of every
    // holder, so it must not run on a database that failed its boot integrity or
    // schema check, nor in maintenance (a copied or restored database). Its gate
    // is the one `_instanceInService`, handed into the retention pass by each of
    // its three doors (the daily reaper, the superadmin's manual purge, the test
    // hook); a pass handed none holds the sweep (fail closed). Behaviour (a held
    // pass keeps an unnamed image, the event purge still runs, both doors say
    // so): tests/image-sweep.spec.js. Comments stripped first.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const read = (f) => stripJsComments(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
    const srv = read("server.js"), ret = read("lib/event-retention.js"), misc = read("routes/admin-misc.js");
    const fnOf = (src, re) => { const at = src.search(re); return at < 0 ? "" : src.slice(at, src.indexOf("\n}", at) + 2); };
    const sweep = fnOf(ret, /^function\s+sweepExpiredEvents\s*\(/m);
    const reaper = fnOf(ret, /^function\s+startEventRetentionReaper\s*\(/m);
    // A route's text from its registration to its answer (res.json).
    const routeAt = (src, head) => { const at = src.indexOf(head); const end = at < 0 ? -1 : src.indexOf("res.json(", at); return end < 0 ? "" : src.slice(at, end); };
    const hook = routeAt(srv, 'app.post("/api/test/purge-events"');
    const manual = routeAt(misc, 'app.post("/api/admin/retention/purge"');
    const sweepCalls = [...ret.matchAll(/\bsweepOrphanedImages\s*\(/g)];
    const gateAt = sweep.search(/typeof\s+opts\.isHealthy\s*===\s*"function"\s*&&\s*opts\.isHealthy\(\s*\)\s*===\s*true/);
    const checks = {
      "sweepExpiredEvents, the reaper, the hook and the manual route found (anti-vacuity)": !!(sweep && reaper && hook && manual),
      "the retention pass calls the image sweep exactly once": sweepCalls.length === 1,
      "…only once opts.isHealthy (a function) answered true": gateAt > -1
        && /if\s*\(\s*!healthy\s*\)\s*imagesHeld\s*=\s*true\s*;\s*else\s*\{/.test(sweep)
        && sweep.search(/\bsweepOrphanedImages\s*\(/) > sweep.search(/if\s*\(\s*!healthy\s*\)/),
      "…and reports a held pass": /images_held\s*:\s*imagesHeld/.test(sweep),
      "the daily reaper hands each pass its isHealthy": (reaper.match(/sweepExpiredEvents\(\s*\{\s*isHealthy\s*\}\s*\)/g) || []).length === 2,
      "server.js starts the reaper with the gate": /startEventRetentionReaper\(\s*\{\s*isHealthy\s*:\s*_instanceInService\s*\}\s*\)/.test(srv)
        && (srv.match(/\bstartEventRetentionReaper\s*\(/g) || []).length === 1,
      "the test hook asks the same gate": /opts\.isHealthy\s*=\s*_instanceInService\s*;[\s\S]*sweepExpiredEvents\(\s*opts\s*\)/.test(hook),
      "the manual purge is handed the gate and passes it": /require\("\.\/routes\/admin-misc"\)\(\s*app\s*,\s*\{\s*isHealthy\s*:\s*_instanceInService\s*\}\s*\)/.test(srv)
        && /sweepExpiredEvents\(\s*\{[^}]*\bisHealthy\b[^}]*\}\s*\)/.test(manual),
      "every caller of the retention pass is one of those (server.js: the hook; admin-misc: the manual route)":
        (srv.match(/\bsweepExpiredEvents\s*\(/g) || []).length === 1 && (misc.match(/\bsweepExpiredEvents\s*\(/g) || []).length === 1,
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "the image sweep's hold drifted:\n  " + failing.join("\n  ")).toEqual([]);
  });

  test("the uploads temp sweep is reachable and honours its 1-hour TTL", async () => {
    // Here `fs.utimesSync` IS enough: this sweep reads mtime alone, because its
    // TTL is an hour — a file that old cannot be an in-flight upload, so it
    // needs no recency clause of its own.
    const fresh = plant(UPLOADS, `fresh-${Date.now()}.tmp`, 0);
    const old = plant(UPLOADS, `stale-${Date.now()}.tmp`, 2 * 60 * 60_000);

    const out = await sweep();
    expect(typeof out.uploads, "the uploads sweep is reachable").toBe("number");
    expect(fs.existsSync(old), "a two-hour-old temp is reclaimed").toBe(false);
    expect(fs.existsSync(fresh), "…and a temp written seconds ago is not").toBe(true);
    fs.unlinkSync(fresh);
  });
});
