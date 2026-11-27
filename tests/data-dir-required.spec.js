// v8.8.26 — DATA_DIR IS REQUIRED, AND THERE IS DELIBERATELY NO DEFAULT.
//
// It used to default to `<repo>/data`, written twice (db.js and lib/config.js).
// That default WAS the production mechanism — nothing in the Dockerfile,
// docker-compose or `npm start` ever set the variable — and it was simultaneously
// a loaded gun, because `db.js` OPENS THE DATABASE AT REQUIRE TIME. So any
// process that merely `require`d it without the variable attached to whichever
// data directory happened to sit beside the code, which on a developer's machine
// is a symlink to the live deployment's volume. Silently: no error, no warning,
// nothing on any screen. v8.8.24 is the same class one layer over, and it really
// happened — a test worker with no DATA_DIR wrote its own console output into a
// running deployment's application log for as long as two specs had existed.
//
// The fix deletes the fallback rather than guarding it: a guard keyed on
// NODE_ENV, or on "does this look like a test", is a guess about the CALLER, and
// the caller that matters is the one nobody predicted.
//
// WHY THESE ARMS ARE THE ONES THAT MATTER, arm by arm:
//   1+2  the refusal itself, at both entry points — and it must NAME the
//        variable, or an operator meets a bare non-zero exit.
//   3    the CONTROL. "It exits" is equally satisfied by a build that is simply
//        broken, so a throwaway directory must still work AND land the database
//        there rather than somewhere else.
//   4    THE PROPERTY THAT MUST NOT REGRESS. `db.js` must not reach lib/config,
//        which exits without BASE_URL — that would break every harness booting
//        the schema alone. This is the arm that fails when somebody later
//        "tidies" lib/data-dir.js into lib/config.js. It carries its own control
//        (lib/config really does refuse), or "db.js booted" is satisfied by a
//        build where nothing requires BASE_URL at all.
//   5    the resolution is ABSOLUTE, so a relative value cannot mean two
//        different directories to two processes started from different working
//        directories.
//
// v8.13.4 (operator decision) — THE TWO OPERATOR SCRIPTS GET THE SAME RULE.
// scripts/backup.sh and scripts/purge.sh each fell back to `<repo>/data`, the
// last two guesses of the data directory left in the tree after v8.8.26. They
// are bash, not node, so they get arms of their own:
//   6    the refusal, for BOTH scripts and FOUR values — unset, empty, a regular
//        file, a path that does not exist — asserting the message names the
//        variable AND that nothing in the tree changed. The scripts run from a
//        COPY inside a mkdtemp tree whose `data/` is a DECOY at the old fallback
//        location, and purge.sh is driven with `--apply` against a year-2000 log
//        there: a build that still guessed would delete it, and a backup build
//        that still guessed would create its output directory — so "nothing
//        changed" is the observable that separates a refusal from a guess.
//        `sqlite3` and `rsync` are recording STUBS first on PATH, so no version
//        of either script can reach a real database, and the arms run the same
//        on a runner with or without either tool.
//   7    purge.sh --help still works with no DATA_DIR, and documents it — the
//        refusal sits AFTER argument parsing, and the header IS the help text.
//   8    the CONTROLS: a named directory gets PAST the refusal (or "it refuses"
//        is satisfied by a script that refuses everything), resolved ABSOLUTELY
//        and CDPATH-safely — a relative name under an exported CDPATH must not
//        land in a same-named directory elsewhere. backup.sh's control is read
//        off the arguments its stub `sqlite3` received; the full run with the
//        real tools (RESTORE.txt carrying absolute, quoted paths) is GUARDED on
//        the runner having them, because the CI image does not.
//   8b-d (the v8.13.4 pre-release review) — purge.sh --apply deletes exactly
//        the log it listed when the absolute path holds a SPACE (it used to
//        re-split the list through xargs and rm the fragment before the space);
//        --max-mb over the cap with only today's files explains itself and exits
//        0 (grep's empty selection used to abort it under set -e); and backup.sh
//        invoked by a RELATIVE path, as README documents, under an exported
//        CDPATH holding a decoy scripts/, still writes its default output into
//        its own checkout.
//   9    a SOURCE arm that runs everywhere, comments stripped first: no shell
//        script under scripts/ or perf/ gives DATA_DIR a non-empty default, and
//        in the two operator scripts the refusal is the FIRST code that reads
//        DATA_DIR and precedes every write or delete.
//   10   (v8.14.0 review) purge.sh's sqlite3 reads cannot be reshaped by an
//        operator's ~/.sqliterc: `.headers on` and `.echo on` aborted it under
//        set -u, `.mode box` made --apply delete nothing and print "Purge
//        complete." with exit 0. A PATH shim runs the real sqlite3 with
//        `-init <rc>` (sqlite3 reads the passwd home's rc, so HOME cannot plant
//        one); each rc must still purge exactly the old rows, and a count that
//        is not a number, or a failed count, must stop the run with an ERROR.
//        These arms need the real sqlite3, which the CI image lacks, so they
//        skip there; the SOURCE arm beside them runs everywhere.
//   11   purge.sh purges the directory the server writes its logs to: LOG_DIR
//        when set (refused when empty or not a directory), else DATA_DIR/logs,
//        in the age and --max-mb modes, with an old log planted in BOTH places.
//
// EVERY child here gets NODE_OPTIONS: "" (v7.15.30 — a spawned child inherits the
// runner's node flags, and these arms assert on exit codes and stderr) and a
// mkdtemp directory under os.tmpdir(). Nothing under the repo is written to. The
// bash children get an environment built from scratch rather than `process.env`
// spread: the worker's DATA_DIR is pinned (playwright.config.js), and a shell
// that exports one would hand it to the script, so a spread could never reach
// the refusal it claims to test.
const { test, expect } = require("./isolated-test");
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB   = path.join(ROOT, "db.js");
const SRV  = path.join(ROOT, "server.js");
const CFG  = path.join(ROOT, "lib", "config.js");
const DD   = path.join(ROOT, "lib", "data-dir.js");

const scratches = [];
function scratch(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `data-dir-${tag}-`));
  scratches.push(d);
  return d;
}
test.afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

/**
 * Run one node child with a DELIBERATE environment.
 *
 * `{ ...process.env }` alone is not enough in either direction: the Playwright
 * worker's own DATA_DIR is pinned (playwright.config.js, v8.8.24), so the
 * refusal arms have to REMOVE it rather than simply not adding it — which is
 * also what makes the intent legible at the site, to a reader and to the
 * v8.8.26 scanner in functional-core-b.
 *
 * BOTH streams are captured. The FATAL goes to stderr, so a stdout-only read
 * would see nothing at all and every assertion below would be about an empty
 * string.
 */
function runNode(script, { dataDir = null, baseUrl = "http://localhost:1", cwd = ROOT, uploadsDir = undefined } = {}) {
  const env = {
    ...process.env,
    NODE_OPTIONS: "",              // v7.15.30 — never inherit the runner's flags
    SMTP_HOST: "localhost",
    SUPERADMIN_PASSWORD_QUIET: "1",
  };
  if (dataDir === null) delete env.DATA_DIR; else env.DATA_DIR = dataDir;
  if (baseUrl === null) delete env.BASE_URL; else env.BASE_URL = baseUrl;
  // v8.8.27 — UPLOADS_DIR is required too and is now a SUBJECT, so it is
  // controllable: `null` removes it (to drive the refusal), a string sets it,
  // and the default keeps every pre-existing arm working by pointing at a
  // throwaway path rather than the repo's own volume — which server.js sweeps.
  if (uploadsDir === null) delete env.UPLOADS_DIR;
  else env.UPLOADS_DIR = uploadsDir || path.join(dataDir || os.tmpdir(), "uploads-scratch");

  const r = spawnSync(process.execPath, ["-e", script], {
    cwd, env, encoding: "utf8", timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

const req = (abs) => `require(${JSON.stringify(abs)})`;

test.describe("v8.8.26 — DATA_DIR is required, with no default", () => {

  test("requiring db.js with NO DATA_DIR refuses, non-zero, and NAMES the variable", () => {
    const r = runNode(req(DB), { dataDir: null });
    // Non-zero, not merely "not 0 exactly" — a crash would also be non-zero, so
    // the message assertion below is what says this was a DECISION.
    expect(r.status, `db.js must refuse to guess a data directory. Output:\n${r.out}`).toBe(1);
    expect(r.out, "the refusal must name the variable — a bare non-zero exit tells an operator nothing")
      .toMatch(/\bDATA_DIR\b/);
    expect(r.out, "…and say it is required, not merely mention it").toMatch(/FATAL/);
  });

  test("booting server.js with NO DATA_DIR refuses the same way", () => {
    // The second entry point. It matters separately: server.js reaches the
    // refusal through its own require graph, so a change that left db.js guarded
    // and server.js not would still hand a live deployment's volume to whatever
    // `npm start` was run without the variable.
    const r = runNode(req(SRV), { dataDir: null });
    expect(r.status, `server.js must refuse to boot without DATA_DIR. Output:\n${r.out}`).not.toBe(0);
    expect(r.out, "and name the variable").toMatch(/\bDATA_DIR\b/);
  });

  test("CONTROL: with a throwaway DATA_DIR db.js boots, and the database lands THERE", () => {
    // Without this, "it exits non-zero" is equally satisfied by a build that is
    // simply broken — and the second assertion is what stops a build that boots
    // while ignoring the variable it was given from passing.
    const dir = scratch("control");
    const r = runNode(`${req(DB)}; console.log("BOOTED")`, { dataDir: dir });
    expect(r.status, `db.js must boot against a real directory. Output:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/BOOTED/);
    expect(fs.existsSync(path.join(dir, "hackathon.db")),
      `the database must be created inside the DATA_DIR it was given (${dir} held: ${fs.readdirSync(dir).join(", ")})`
    ).toBe(true);
  });

  test("a fresh DATA_DIR is created 0700 and its database 0600; an existing directory's and file's modes are the operator's (CONTROL)", () => {
    // The directory holds every account and the HMAC secrets: owner-only from
    // birth, never world-readable under the default umask.
    const fresh = path.join(scratch("modes"), "fresh-data");
    expect(fs.existsSync(fresh), "PRECONDITION: the directory does not exist yet").toBe(false);
    const r = runNode(`${req(DB)}; console.log("BOOTED")`, { dataDir: fresh });
    expect(r.status, `db.js must boot. Output:\n${r.out}`).toBe(0);
    expect(fs.statSync(fresh).mode & 0o777, "an owner-only directory").toBe(0o700);
    expect(fs.statSync(path.join(fresh, "hackathon.db")).mode & 0o777, "an owner-only database file").toBe(0o600);

    // CONTROL: modes an operator chose are left alone.
    const mine = scratch("modes-existing");
    fs.chmodSync(mine, 0o755);
    const dbFile = path.join(mine, "hackathon.db");
    fs.writeFileSync(dbFile, "");
    fs.chmodSync(dbFile, 0o644);
    const r2 = runNode(`${req(DB)}; console.log("BOOTED")`, { dataDir: mine });
    expect(r2.status, `db.js must boot on an existing directory. Output:\n${r2.out}`).toBe(0);
    expect(fs.statSync(mine).mode & 0o777, "the existing directory keeps its mode").toBe(0o755);
    expect(fs.statSync(dbFile).mode & 0o777, "the existing file keeps its mode").toBe(0o644);
  });

  test("a case collision on an identity column stops the boot and names the row ids, never the colliding address", () => {
    // The FATAL lines land in the container log, which outlives the fix, so
    // they carry the ids to merge and not the address.
    const dir = path.join(scratch("nocase"), "data");
    const first = runNode(`${req(DB)}; console.log("BOOTED")`, { dataDir: dir });
    expect(first.status, `a fresh database boots. Output:\n${first.out}`).toBe(0);
    const local = `Collide${Date.now()}`;
    const addr = `${local}@Example.com`;
    const Database = require("better-sqlite3");
    const d = new Database(path.join(dir, "hackathon.db"));
    try {
      // The state an installation from before the NOCASE indexes could hold.
      d.exec("DROP INDEX IF EXISTS uq_users_email_nocase");
      const ins = d.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, password_hash, created_at) VALUES (?,?,?,?,?,?,?)");
      ins.run("nocase-a", "A", "One", "nocase_a", addr, "x", new Date().toISOString());
      ins.run("nocase-b", "B", "Two", "nocase_b", addr.toLowerCase(), "x", new Date().toISOString());
    } finally { d.close(); }
    const second = runNode(`${req(DB)}; console.log("BOOTED")`, { dataDir: dir });
    expect(second.status, `the collision stops the boot. Output:\n${second.out}`).toBe(1);
    expect(second.out).not.toMatch(/BOOTED/);
    expect(second.out).toMatch(/cannot create unique index uq_users_email_nocase/);
    expect(second.out, "the ids to merge are named").toMatch(/2 rows share one value across ids: (nocase-a,nocase-b|nocase-b,nocase-a)/);
    expect(second.out.toLowerCase(), "the colliding address is not printed").not.toContain(local.toLowerCase());
  });

  test("db.js still boots with NO BASE_URL — it must not reach lib/config", () => {
    // lib/data-dir.js is deliberately NOT part of lib/config.js. lib/config exits
    // without BASE_URL, so folding the two together would give `require("./db")`
    // a BASE_URL dependency and break every harness that boots the schema alone
    // — including three arms of this very file.
    const dir = scratch("nobaseurl");
    const r = runNode(`${req(DB)}; console.log("BOOTED")`, { dataDir: dir, baseUrl: null });
    expect(r.status, `db.js must not depend on BASE_URL. Output:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/BOOTED/);

    // THE CONTROL, and it is what gives the arm above its meaning: lib/config
    // really does refuse without BASE_URL. Drop this and "db.js booted" is
    // equally satisfied by a build in which nothing requires BASE_URL at all,
    // so the coupling under test could not be observed.
    const cfg = runNode(req(CFG), { dataDir: dir, baseUrl: null });
    expect(cfg.status, `lib/config must still refuse without BASE_URL. Output:\n${cfg.out}`).toBe(1);
    expect(cfg.out).toMatch(/BASE_URL/);
  });

  test("a relative DATA_DIR resolves against the PROCESS's cwd, absolutely", () => {
    // A relative value must not mean two different directories to two processes
    // started from different working directories — and in particular must not be
    // resolved against the module's own location, which would put a child's data
    // inside the repository.
    const home = scratch("relcwd");
    const rel  = `dd-rel-${Math.random().toString(36).slice(2, 10)}`;

    const shown = runNode(
      // v8.8.26 — a FUNCTION, not a cached export: a cached value would make this
    // module a third link in the require-cache purge chain that
    // `trusted-networks-kind.spec.js` performs, so `db.js` would re-require and
    // get a stale directory. That spec caught it on its first run.
    `console.log("RESOLVED=" + ${req(DD)}.requireDataDir())`,
      { dataDir: `./${rel}`, cwd: home },
    );
    expect(shown.status, `resolving a relative DATA_DIR must succeed. Output:\n${shown.out}`).toBe(0);
    const resolved = (/RESOLVED=(.*)/.exec(shown.out) || [])[1] || "";
    expect(path.isAbsolute(resolved), `DATA_DIR must be resolved to an absolute path, got: ${resolved}`).toBe(true);
    expect(resolved, "…relative to the process's cwd").toBe(path.join(home, rel));

    // And the database really follows it, rather than the resolution being a
    // value nothing acts on.
    const boot = runNode(req(DB), { dataDir: `./${rel}`, cwd: home });
    expect(boot.status, `db.js must boot against a relative DATA_DIR. Output:\n${boot.out}`).toBe(0);
    expect(fs.existsSync(path.join(home, rel, "hackathon.db")),
      "the database must land under the cwd the child was started from").toBe(true);
    // The half that says it did not land in the repository instead. `<repo>/data`
    // is a symlink to the live volume on a developer's machine, which is the
    // whole reason this release exists.
    expect(fs.existsSync(path.join(ROOT, rel)),
      "a relative DATA_DIR must never be resolved against the repo root").toBe(false);
  });

  test("v8.8.27 — UPLOADS_DIR is required too, and it is a SEPARATE decision", () => {
    // The same rule, and a sharper reason: server.js SWEEPS this directory at
    // every boot, so a guessed path is one it DELETES from — v8.8.15 records
    // exactly that happening to the test suite, found by watching the
    // directory's mtime rather than by any failure.
    //
    // It is asserted SEPARATELY from DATA_DIR because they are separate
    // filesystems by design (the upload capacity check measures free space on
    // both, v7.15.12). A child that decides one has decided nothing about the
    // other, and the refusal must say which is missing.
    const d = scratch("uploads-req");

    // DATA_DIR set, UPLOADS_DIR absent -> refuses, naming the RIGHT variable.
    const noUp = runNode(req(CFG), { dataDir: d, uploadsDir: null });
    expect(noUp.status, `lib/config must refuse without UPLOADS_DIR. Output:\n${noUp.out}`).not.toBe(0);
    expect(noUp.out, "…and must name UPLOADS_DIR, not DATA_DIR").toMatch(/UPLOADS_DIR/);

    // CONTROL — with both, it loads. Without this, "it refuses" is equally
    // satisfied by a build where lib/config never loads at all.
    const both = runNode(
      `console.log("UP=" + ${req(CFG)}.UPLOADS_DIR)`,
      { dataDir: d, uploadsDir: `${d}/up` },
    );
    expect(both.status, `lib/config must load with both set. Output:\n${both.out}`).toBe(0);
    expect((/UP=(.*)/.exec(both.out) || [])[1], "…resolved absolutely").toBe(path.join(d, "up"));

    // …and db.js is UNAFFECTED: it needs DATA_DIR and must NOT acquire an
    // UPLOADS_DIR dependency, for the same reason it must not acquire BASE_URL.
    const db = runNode(req(DB), { dataDir: d, uploadsDir: null });
    expect(db.status, `db.js must not require UPLOADS_DIR. Output:\n${db.out}`).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.13.4 — THE OPERATOR SCRIPTS (arms 6-9 in the header)
// ═══════════════════════════════════════════════════════════════════════════
const SCRIPTS = { backup: path.join(ROOT, "scripts", "backup.sh"), purge: path.join(ROOT, "scripts", "purge.sh") };
const OLD_LOG = "app-2000-01-01.jsonl";
const Y2K = new Date("2000-01-01T00:00:00Z");

/** A data directory with a non-empty hackathon.db and one year-2000 log file. */
function plantDataDir(dir, tag) {
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "hackathon.db"), `not a database — ${tag}\n`);
  const log = path.join(dir, "logs", OLD_LOG);
  fs.writeFileSync(log, `{"msg":"${tag}"}\n`);
  fs.utimesSync(log, Y2K, Y2K);
  return log;
}

/**
 * A throw-away tree that the scripts are COPIED into, so ROOT_DIR is the tree
 * and the old `<repo>/data` fallback is T/data — a DECOY this test owns. A
 * reverted script therefore acts on the decoy, never on a real volume, and the
 * test can see it. `bin/` holds recording stubs for the two external tools.
 */
function scriptTree(tag) {
  const T = scratch(`scripts-${tag}`);
  fs.mkdirSync(path.join(T, "scripts"));
  for (const f of Object.values(SCRIPTS)) {
    fs.copyFileSync(f, path.join(T, "scripts", path.basename(f)));
    fs.chmodSync(path.join(T, "scripts", path.basename(f)), 0o755);
  }
  fs.copyFileSync(path.join(ROOT, "version.json"), path.join(T, "version.json"));
  const decoyLog = plantDataDir(path.join(T, "data"), "DECOY at the retired <repo>/data fallback");
  const bin = path.join(T, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(T, "tool-calls.log");
  for (const tool of ["sqlite3", "rsync"]) {
    fs.writeFileSync(path.join(bin, tool),
      `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> '${calls}'\nexit 97\n`, { mode: 0o755 });
  }
  const toolCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
  return { T, bin, decoyLog, toolCalls, script: (k) => path.join(T, "scripts", path.basename(SCRIPTS[k])) };
}

/** Run one script under bash with an environment built from scratch. */
function runScript(tree, which, args, { dataDir, cwd = tree.T, extraEnv = {}, stubs = true } = {}) {
  const env = {
    PATH: stubs ? `${tree.bin}:${process.env.PATH}` : process.env.PATH,
    HOME: process.env.HOME || tree.T,
    NODE_OPTIONS: "",            // v7.15.30 — consistency with every child here
    ...extraEnv,
  };
  if (dataDir !== undefined) env.DATA_DIR = dataDir;   // undefined = UNSET, "" = empty
  const r = spawnSync("bash", [tree.script(which), ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Every path under `dir` with its size and mtime — "nothing changed" made checkable. */
function treeState(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)}|${e.isDirectory() ? "dir" : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

// stripShellComments is shared from tests/doc-registry.js (one home for the
// strippers), so the backup scanners elsewhere cannot drift from this one.
const { stripShellComments } = require("./doc-registry");

test.describe("v8.13.4 — scripts/backup.sh and scripts/purge.sh refuse without DATA_DIR", () => {

  // Arm 6. Four values, two scripts, one rule: refuse, name the variable, touch nothing.
  for (const which of ["backup", "purge"]) {
    test(`${which}.sh refuses an unset, empty or non-directory DATA_DIR and changes NOTHING`, () => {
      const tree = scriptTree(`refuse-${which}`);
      const notDir = path.join(tree.T, "a-regular-file");
      fs.writeFileSync(notDir, "not a directory\n");
      // purge: --apply against a log a guessing build WOULD delete (the decoy's
      // year-2000 file is a day-1 candidate). backup: an explicit output path,
      // which a guessing build would create before its stub sqlite3 aborts it.
      const args = which === "purge" ? ["--apply", "--days", "1", "logs"] : [path.join(tree.T, "out")];
      const CASES = [
        ["unset", undefined, /\bDATA_DIR is required\b/],
        ["empty", "", /\bDATA_DIR is required\b/],
        ["a regular file", notDir, /\bDATA_DIR is not a directory\b/],
        ["a path that does not exist", path.join(tree.T, "no-such-dir"), /\bDATA_DIR is not a directory\b/],
      ];
      for (const [label, value, msg] of CASES) {
        const before = treeState(tree.T);
        const r = runScript(tree, which, args, { dataDir: value });
        // The MESSAGE, not only the code: on a runner with no sqlite3 a guessing
        // build also exits 1, at "sqlite3 CLI not found", so the status alone
        // would pass vacuously there.
        expect(r.status, `${which}.sh, DATA_DIR ${label}: must refuse.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(1);
        expect(r.stderr, `${which}.sh, DATA_DIR ${label}: the refusal must say why, naming the variable`).toMatch(msg);
        expect(r.stderr, "…as an ERROR, the scripts' own refusal form").toMatch(/^ERROR: /m);
        expect(tree.toolCalls(), `${which}.sh, DATA_DIR ${label}: neither sqlite3 nor rsync may run`).toEqual([]);
        expect(treeState(tree.T), `${which}.sh, DATA_DIR ${label}: NOTHING may be created, changed or deleted`).toEqual(before);
      }
      // The unset message carries a SUDO-SAFE example — the form an operator on
      // a root crontab needs, since sudo strips an exported DATA_DIR.
      const r = runScript(tree, which, args, { dataDir: undefined });
      expect(r.stderr, "the refusal shows the sudo-safe invocation").toMatch(/sudo DATA_DIR=\/opt\/hackarena\/data scripts\//);
      expect(r.stderr, "…and says a cron line must carry DATA_DIR itself").toMatch(/crontab line itself/);
      // Anti-vacuity: the decoy really sits where the old fallback looked, so a
      // guessing build had something to act on.
      expect(fs.existsSync(tree.decoyLog)).toBe(true);
      expect(fs.statSync(tree.decoyLog).mtimeMs, "the decoy log is still dated 2000").toBe(Y2K.getTime());
    });
  }

  // Arm 7.
  test("purge.sh --help works with NO DATA_DIR, and documents that it is required", () => {
    const tree = scriptTree("help");
    const r = runScript(tree, "purge", ["--help"], { dataDir: undefined });
    expect(r.status, `--help must not need DATA_DIR. stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout, "the usage line names DATA_DIR").toMatch(/^\s*DATA_DIR=<data-dir> scripts\/purge\.sh\b/m);
    expect(r.stdout, "…and says it is required").toMatch(/^\s*DATA_DIR\s+REQUIRED, no default/m);
    expect(r.stdout, "…with the sudo-safe form").toMatch(/sudo DATA_DIR=\/opt\/hackarena\/data scripts\/purge\.sh/);
    expect(r.stdout, "the help text no longer points at the retired data/logs/ path").not.toMatch(/(^|\s)data\/logs\//m);
  });

  // Arm 8 — purge.sh controls (stubs on PATH; a `logs`-only dry run calls no sqlite3).
  test("CONTROL: purge.sh with a named DATA_DIR proceeds — absolute, CDPATH-safe, dry run deletes nothing", () => {
    const tree = scriptTree("purge-ok");
    const fixture = path.join(tree.T, "fixture");
    const realLog = plantDataDir(fixture, "the directory the caller named");
    // A same-named directory reachable through CDPATH, with its own old log. A
    // bare `cd "$DATA_DIR"` would resolve `fixture` THERE and print it, making
    // the captured value two lines (measured); the script must not.
    const cdpath = path.join(tree.T, "cdpath-decoy");
    const cdpathLog = plantDataDir(path.join(cdpath, "fixture"), "CDPATH decoy");

    for (const [label, value, extraEnv] of [
      ["absolute", fixture, {}],
      ["relative, bare name", "fixture", {}],
      ["relative, ./name", "./fixture", {}],
      ["relative, under an exported CDPATH", "fixture", { CDPATH: cdpath }],
    ]) {
      const r = runScript(tree, "purge", ["--days", "1", "logs"], { dataDir: value, extraEnv });
      const ctx = `${label}:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
      expect(r.status, `purge.sh must get past the refusal — ${ctx}`).toBe(0);
      expect(r.stderr, ctx).not.toMatch(/DATA_DIR is (required|not a directory)/);
      expect(r.stdout, `the DATA_DIR line states the ABSOLUTE directory purged — ${ctx}`)
        .toMatch(new RegExp(`^\\s*DATA_DIR : ${fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      expect(r.stdout, `…the named directory's old log is the candidate — ${ctx}`).toContain(`candidate: ${realLog}`);
      expect(r.stdout, `…and nothing under the CDPATH decoy — ${ctx}`).not.toContain(cdpath);
      expect(r.stdout, "a dry run says so").toMatch(/DRY-RUN ONLY/);
    }
    expect(fs.existsSync(realLog), "a dry run deletes nothing").toBe(true);
    expect(fs.existsSync(cdpathLog)).toBe(true);
    expect(fs.existsSync(tree.decoyLog), "and the retired-fallback decoy is never touched").toBe(true);
    expect(tree.toolCalls(), "a logs-only dry run runs no sqlite3").toEqual([]);
  });

  // Arm 8 — backup.sh control, readable on any runner: the stub sqlite3 records
  // the `.backup` it was asked for, then fails, so the run stops right there.
  test("CONTROL: backup.sh with a named DATA_DIR proceeds to the snapshot, with ABSOLUTE source and destination", () => {
    const tree = scriptTree("backup-ok");
    const fixture = path.join(tree.T, "fixture");
    plantDataDir(fixture, "the directory the caller named");
    const cdpath = path.join(tree.T, "cdpath-decoy");
    plantDataDir(path.join(cdpath, "fixture"), "CDPATH decoy");

    const r = runScript(tree, "backup", ["out rel"], { dataDir: "fixture", extraEnv: { CDPATH: cdpath } });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}\ncalls:\n${tree.toolCalls().join("\n")}`;
    expect(r.stderr, `backup.sh must get past the refusal — ${ctx}`).not.toMatch(/DATA_DIR is (required|not a directory)/);
    expect(r.status, `…to the first sqlite3 call, which the stub fails (97) — ${ctx}`).toBe(97);
    const snap = tree.toolCalls().find((c) => /^sqlite3 .*\.backup/.test(c)) || "";
    expect(snap, `the online snapshot was attempted — ${ctx}`).not.toBe("");
    // The SOURCE is the named directory, absolutely — never the CDPATH decoy and
    // never the retired <repo>/data — and the DESTINATION is absolute too, so
    // RESTORE.txt (which bakes both in) names them for a restorer anywhere.
    expect(snap, ctx).toContain(` ${path.join(fixture, "hackathon.db")} `);
    expect(snap, ctx).toContain(`.backup '${path.join(tree.T, "out rel", "hackathon.db")}'`);
    expect(snap, ctx).not.toContain(cdpath);
    expect(r.stdout, ctx).toMatch(new RegExp(`^\\s*DATA_DIR : ${fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });

  // Arm 8e (v8.13.4 fix-delta review) — a SYMLINKED DATA_DIR resolves to the
  // directory it points at. Resolved logically, the recorded owner was the
  // LINK's and RESTORE.txt's `chown -R` changed only the link, leaving a restored
  // database its server cannot write. The stub records the snapshot source,
  // which carries the resolved path on any runner.
  test("backup.sh resolves a SYMLINKED DATA_DIR to the directory it points at", () => {
    const tree = scriptTree("backup-symlink");
    const real = path.join(tree.T, "volume");
    plantDataDir(real, "the volume behind the link");
    const link = path.join(tree.T, "data-link");
    fs.symlinkSync(real, link);
    const r = runScript(tree, "backup", ["out"], { dataDir: link });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}\ncalls:\n${tree.toolCalls().join("\n")}`;
    expect(r.status, `…to the first sqlite3 call, which the stub fails (97) — ${ctx}`).toBe(97);
    const snap = tree.toolCalls().find((c) => /^sqlite3 .*\.backup/.test(c)) || "";
    expect(snap, ctx).toContain(` ${path.join(fs.realpathSync(real), "hackathon.db")} `);
    expect(snap, `the link's own name is not what is recorded — ${ctx}`).not.toContain(link);
  });

  // Arm 8 — the full run, where the runner has the real tools. The CI image has
  // neither sqlite3 nor rsync (v8.11.2), so a skip there is a statement about the
  // toolchain; the stub control above already covers the resolution itself.
  test("CONTROL (real sqlite3 + rsync): a relative DATA_DIR backs up, and RESTORE.txt names ABSOLUTE, quoted paths", () => {
    const have = ["sqlite3", "rsync"].every((bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0);
    test.skip(!have, "this runner has no sqlite3/rsync, so backup.sh cannot complete — the stub control covers resolution");
    const tree = scriptTree("backup-real");
    const fixture = path.join(tree.T, "fixture");
    fs.mkdirSync(fixture);
    const mk = spawnSync("sqlite3", [path.join(fixture, "hackathon.db"), "CREATE TABLE users (id TEXT); INSERT INTO users VALUES ('x');"], { encoding: "utf8" });
    expect(mk.status, mk.stderr).toBe(0);

    const r = runScript(tree, "backup", ["out dir"], { dataDir: "./fixture", stubs: false });
    expect(r.status, `a real backup must complete.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    const out = path.join(tree.T, "out dir");
    expect(fs.existsSync(path.join(out, "BACKUP_COMPLETE")), "…and certify itself").toBe(true);
    const restore = fs.readFileSync(path.join(out, "RESTORE.txt"), "utf8");
    expect(restore).toContain(`Taken from : ${fixture}\n`);
    expect(restore, "the stale-WAL step names the absolute data directory")
      .toContain(`rm -f "${fixture}"/hackathon.db-wal "${fixture}"/hackathon.db-shm`);
    // QUOTED: an unquoted source containing a space word-splits into an extra
    // rsync SOURCE under --delete.
    expect(restore, "the rsync step names both directories absolutely, the backup quoted")
      .toContain(`rsync -a --delete "${out}"/ "${fixture}"/`);
    expect(restore, "the password file is named by its real path, not a variable the restorer's shell may lack")
      .toContain(`${fixture}/.superadmin-password`);
    const meta = fs.readFileSync(path.join(out, "BACKUP_METADATA.txt"), "utf8");
    expect(meta).toContain(`data_dir: ${fixture}\n`);
    // v8.13.4 review — the owner is recorded, and the restore gives the data
    // directory back to it: a root `rsync -a` restore otherwise leaves it root's.
    const st = fs.statSync(fixture);
    expect(meta).toContain(`data_dir_owner: ${st.uid}:${st.gid}\n`);
    expect(restore, "the restore hands the directory back to its recorded owner")
      .toContain(`chown -R ${st.uid}:${st.gid} "${fixture}"`);
    // The email choice (operator ruling, 17 Nov 2026): both verbs, the data
    // directory absolute and quoted, the script by its absolute path, between the
    // rsync and the chown (anything sqlite3 leaves is handed back with the rest).
    const choice = [...restore.matchAll(/^\s*DATA_DIR="([^"]+)" "([^"]+)"\/restore-mail\.sh (mark-sent|resend)\s*$/gm)];
    expect(choice.map(m => m[3]), "RESTORE.txt offers both choices").toEqual(["mark-sent", "resend"]);
    for (const m of choice) {
      expect(m[1], "the choice names the absolute data directory").toBe(fixture);
      expect(path.isAbsolute(m[2]), `the script is named by an absolute path: ${m[2]}`).toBe(true);
    }
    const at = (needle) => restore.indexOf(needle);
    expect(at(`rsync -a --delete "${out}"/`)).toBeLessThan(choice[0].index);
    expect(choice[1].index, "the chown comes after the choice").toBeLessThan(at(`chown -R ${st.uid}:${st.gid}`));
  });

  // Arm 8b (v8.13.4 pre-release review) — purge.sh --apply deletes the file it
  // printed and nothing else, when the absolute path holds a SPACE. It used to
  // re-split the printed list through `xargs rm -f`, which left the old log in
  // place, reported "-> deleted", and handed rm the fragment before the space.
  test("purge.sh --apply deletes the listed log, and only it, when the path holds a space", () => {
    const tree = scriptTree("purge-space");
    const parent = path.join(tree.T, "xa");
    const spaced = path.join(parent, "sp ace");
    const decoy = path.join(parent, "sp");               // what `xargs` would have handed rm
    fs.mkdirSync(spaced, { recursive: true });
    fs.writeFileSync(decoy, "innocent — the fragment before the space\n");
    const oldLog = plantDataDir(path.join(spaced, "d"), "a data directory under a spaced path");
    const freshLog = path.join(spaced, "d", "logs", "app-2099-01-01.jsonl");
    fs.writeFileSync(freshLog, "{}\n");
    // RELATIVE DATA_DIR from a cwd holding the space: the script resolves it
    // absolute, so every path find prints carries the space.
    const r = runScript(tree, "purge", ["--apply", "--days", "1", "logs"], { dataDir: "d", cwd: spaced });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
    expect(r.status, ctx).toBe(0);
    expect(r.stdout, `the old log was the candidate — ${ctx}`).toContain(`candidate: ${oldLog}`);
    expect(fs.existsSync(oldLog), `the listed log is really deleted — ${ctx}`).toBe(false);
    expect(fs.readFileSync(decoy, "utf8"), "the file at the fragment before the space is untouched").toMatch(/^innocent/);
    expect(fs.existsSync(freshLog), "a log newer than the cutoff survives").toBe(true);
    expect(fs.existsSync(tree.decoyLog), "the retired-fallback decoy is never touched").toBe(true);
  });

  // Arm 8c — --max-mb with ONLY today's live files over the cap explains itself
  // and exits 0. grep's "selected nothing" exit used to abort the script under
  // `set -e`, silently, skipping every later category.
  test("purge.sh --max-mb over the cap with only today's files says so and exits 0", () => {
    const tree = scriptTree("purge-maxmb-today");
    const fixture = path.join(tree.T, "fixture");
    fs.mkdirSync(path.join(fixture, "logs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "hackathon.db"), "not a database\n");
    const today = new Date().toISOString().slice(0, 10);
    const live = path.join(fixture, "logs", `app-${today}.jsonl`);
    fs.writeFileSync(live, Buffer.alloc(2 * 1024 * 1024, 0x20));
    const r = runScript(tree, "purge", ["--apply", "--max-mb", "1", "logs"], { dataDir: fixture });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
    expect(r.status, `must not abort — ${ctx}`).toBe(0);
    expect(r.stdout, ctx).toMatch(/only today's active log files present/);
    expect(r.stdout, "…and runs to the end").toMatch(/Purge complete\./);
    expect(fs.existsSync(live), "today's live file is never deleted").toBe(true);
  });

  // Arm 8c2 (v8.13.4 fix-delta review) — today's date is matched on the file
  // NAME. It was matched on the whole listing line, which carries the full path,
  // so a DATA_DIR whose path held today's date protected EVERY file and the cap
  // was never enforced, under the false "only today's active log files" message.
  test("purge.sh --max-mb matches today's date on the file name, not on the path", () => {
    const tree = scriptTree("purge-maxmb-datepath");
    const today = new Date().toISOString().slice(0, 10);
    const fixture = path.join(tree.T, `volume-${today}`);
    const old = plantDataDir(fixture, "a dated volume path");
    fs.writeFileSync(old, Buffer.alloc(2 * 1024 * 1024, 0x20));
    fs.utimesSync(old, Y2K, Y2K);
    const live = path.join(fixture, "logs", `app-${today}.jsonl`);
    fs.writeFileSync(live, "{}\n");
    const r = runScript(tree, "purge", ["--apply", "--max-mb", "1", "logs"], { dataDir: fixture });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
    expect(r.status, ctx).toBe(0);
    expect(r.stdout, ctx).not.toMatch(/only today's active log files present/);
    expect(fs.existsSync(old), `the rotated file over the cap is deleted — ${ctx}`).toBe(false);
    expect(fs.existsSync(live), "today's live file is kept").toBe(true);
  });

  // Arm 8d — backup.sh invoked the way README documents it, by a RELATIVE path
  // (`scripts/backup.sh` from the checkout root), with an exported CDPATH that
  // holds a decoy `scripts/`. BASH_SOURCE is then relative, and the pre-v8.13.4
  // `$(cd "$(dirname …)" && pwd)` resolved through CDPATH — and `cd` PRINTS a
  // directory it found that way, so SCRIPT_DIR held two lines and the next cd
  // aborted the script under `set -e` (the fix-delta review measured it; this
  // comment first said the output landed in the decoy). The output must land
  // under the checkout's own backups/.
  test("backup.sh invoked by a relative path under an exported CDPATH puts its default output in its own checkout", () => {
    const tree = scriptTree("backup-relative");
    const fixture = path.join(tree.T, "fixture");
    plantDataDir(fixture, "the directory the caller named");
    const cdpath = path.join(tree.T, "cdpath-decoy");
    fs.mkdirSync(path.join(cdpath, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "version.json"), path.join(cdpath, "version.json"));
    const env = { PATH: `${tree.bin}:${process.env.PATH}`, HOME: process.env.HOME || tree.T, NODE_OPTIONS: "",
      DATA_DIR: fixture, CDPATH: cdpath };
    const r = spawnSync("bash", ["scripts/backup.sh"], { cwd: tree.T, env, encoding: "utf8", timeout: 30_000 });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}\ncalls:\n${tree.toolCalls().join("\n")}`;
    expect(r.status, `…to the first sqlite3 call, which the stub fails (97) — ${ctx}`).toBe(97);
    const snap = tree.toolCalls().find((c) => /^sqlite3 .*\.backup/.test(c)) || "";
    expect(snap, `the snapshot destination is under the checkout's own backups/ — ${ctx}`)
      .toContain(`.backup '${path.join(tree.T, "backups")}${path.sep}`);
    expect(fs.existsSync(path.join(cdpath, "backups")), "nothing was written into the CDPATH decoy").toBe(false);
    expect(fs.readdirSync(path.join(tree.T, "backups")).length, "exactly one timestamped output directory").toBe(1);
  });

  // Arm 9. Source-level, runs everywhere.
  test("SOURCE: no shell script defaults DATA_DIR; in the operator scripts the refusal is the first read and precedes every write", () => {
    const shells = [];
    for (const d of ["scripts", "perf"]) {
      for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith(".sh")) shells.push(path.join(d, f));
    }
    // Anti-vacuity: a moved directory or a renamed extension empties the scan.
    expect(shells.length, `shell scripts scanned: ${shells.join(", ")}`).toBeGreaterThanOrEqual(6);
    expect(shells).toEqual(expect.arrayContaining(["scripts/backup.sh", "scripts/purge.sh", "scripts/restore-mail.sh"]));

    // A parameter-expansion DEFAULT for DATA_DIR is a guess, in any shell script:
    // `${DATA_DIR:-x}`, `${DATA_DIR-x}`, `${DATA_DIR:=x}`, `${DATA_DIR=x}` with a
    // non-empty x. The EMPTY default `${DATA_DIR:-}` is how a refusal is written
    // under `set -u` (watch-metrics.sh too), and `${DATA_DIR:?msg}` IS a
    // refusal, so neither is flagged. perf/run-local.sh assigns its OWN scratch
    // directory outright, which is not an expansion and is not flagged either.
    let expansions = 0;
    const guesses = [];
    for (const rel of shells) {
      const code = stripShellComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      for (const m of code.matchAll(/\$\{DATA_DIR(:?[-=])([^}]*)\}/g)) {
        expansions++;
        if (m[2] !== "") guesses.push(`${rel}: ${m[0]}`);
      }
    }
    expect(expansions, "anti-vacuity: the scan sees the scripts' own `${DATA_DIR:-}` refusals").toBeGreaterThanOrEqual(3);
    expect(guesses, "a shell script guesses the data directory again").toEqual([]);

    const WRITES = /(^|[\s;&|(])(mkdir|rm|rsync|cp|mv|xargs|ln|touch|tee)\s|(^|[\s;&|(])sqlite3\s+-|>\s*"\$/;
    for (const rel of ["scripts/backup.sh", "scripts/purge.sh", "scripts/restore-mail.sh"]) {
      const lines = stripShellComments(fs.readFileSync(path.join(ROOT, rel), "utf8")).split("\n");
      // The refusal: `-z "${DATA_DIR:-}"` whose branch exits non-zero and names
      // the variable — or a `${DATA_DIR:?…}` expansion, an equally valid form.
      const zAt = lines.findIndex((l) => /-z\s+"\$\{DATA_DIR:-\}"/.test(l));
      const qAt = lines.findIndex((l) => /\$\{DATA_DIR:\?/.test(l));
      const refusal = zAt >= 0 ? zAt : qAt;
      expect(refusal, `${rel}: the DATA_DIR refusal exists`).toBeGreaterThanOrEqual(0);
      if (refusal === zAt) {
        const fiAt = lines.findIndex((l, i) => i > zAt && /^\s*fi\b/.test(l));
        const branch = lines.slice(zAt + 1, fiAt).join("\n");
        expect(fiAt, `${rel}: the refusal branch closes`).toBeGreaterThan(zAt);
        expect(branch, `${rel}: the refusal names DATA_DIR`).toMatch(/echo[^\n]*\bDATA_DIR\b[^\n]*required/);
        expect(branch, `${rel}: …and exits non-zero`).toMatch(/^\s*exit\s+[1-9]/m);
      }
      // FIRST READ: no code line before the refusal mentions DATA_DIR at all —
      // the shape of the retired fallback, and of a DB=/LOGS_DIR= derivation
      // left above it (which under `set -u` aborts with bash's bare "unbound
      // variable" instead of the refusal).
      const firstMention = lines.findIndex((l) => /\bDATA_DIR\b/.test(l));
      expect(firstMention, `${rel}: the refusal is the first code that reads DATA_DIR (line ${firstMention + 1}: ${lines[firstMention]})`).toBe(refusal);
      // Every later ASSIGNMENT derives from the caller's value — never a path
      // built from where the script sits.
      lines.forEach((l, i) => {
        const a = /^\s*DATA_DIR=(.*)$/.exec(l);
        if (a) expect(a[1], `${rel}:${i + 1} reassigns DATA_DIR from something other than the caller's value`).toMatch(/DATA_DIR/);
      });
      // Every write or delete comes after the refusal.
      const firstWrite = lines.findIndex((l) => WRITES.test(l));
      expect(firstWrite, `${rel}: anti-vacuity — a write/delete command was found`).toBeGreaterThan(-1);
      expect(firstWrite, `${rel}: the first write/delete (line ${firstWrite + 1}: ${lines[firstWrite]}) must come AFTER the refusal`).toBeGreaterThan(refusal);
      // CDPATH-safe resolution: every `$(cd …)` uses `CDPATH= cd --`.
      const cds = lines.filter((l) => /\$\(\s*(CDPATH=\s+)?cd\b/.test(l));
      expect(cds.length, `${rel}: the absolute resolution exists`).toBeGreaterThanOrEqual(1);
      for (const l of cds) expect(l, `${rel}: a cd in a command substitution without CDPATH= / --`).toMatch(/\$\(\s*CDPATH=\s+cd\s+(?:-P\s+)?--\s/);
    }
    // RESTORE.txt quotes the backup directory where it is an rsync SOURCE.
    const backup = fs.readFileSync(SCRIPTS.backup, "utf8");
    expect(backup).toMatch(/^\s*rsync -a --delete "\$OUT_DIR"\/ "\$DATA_DIR"\/\s*$/m);
    // …followed by the ownership step (the real-tools arm checks its expansion).
    expect(backup).toMatch(/^\s*chown -R \$\{DATA_OWNER:-<uid>:<gid>\} "\$DATA_DIR"\s*$/m);
    // purge.sh never re-splits a printed list of paths for deletion.
    const purgeCode = stripShellComments(fs.readFileSync(SCRIPTS.purge, "utf8"));
    expect(purgeCode, "purge.sh deletes through xargs, which splits on whitespace").not.toMatch(/\bxargs\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.14.0 review — PURGE.SH'S SQLITE3 READS (arm 10 in the header)
// ═══════════════════════════════════════════════════════════════════════════
const REAL_SQLITE3 = (spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf8" }).stdout || "").trim();
const NO_SQLITE3 = "this runner has no sqlite3, so purge.sh cannot count rows; the SOURCE arm covers it";
const OLD_TS = "2000-01-01T00:00:00Z";
const FUTURE_TS = "2099-01-01T00:00:00Z";
const sessionData = (key, ts) => JSON.stringify({ cookie: { [key]: ts } });

/** A data directory whose hackathon.db holds old and current rows of each category. */
function purgeFixture(dir) {
  const Database = require("better-sqlite3");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "hackathon.db"));
  try {
    db.exec(`CREATE TABLE invitations (id TEXT PRIMARY KEY, used_at TEXT);
      CREATE TABLE email_reminders (id TEXT PRIMARY KEY, sent INTEGER, send_at TEXT);
      CREATE TABLE express_session (sid TEXT PRIMARY KEY, data TEXT);`);
    const inv = db.prepare("INSERT INTO invitations VALUES (?, ?)");
    for (const [id, at] of [["inv-old-1", OLD_TS], ["inv-old-2", OLD_TS], ["inv-fresh", new Date().toISOString()], ["inv-unused", null]]) inv.run(id, at);
    const rem = db.prepare("INSERT INTO email_reminders VALUES (?, ?, ?)");
    for (const [id, sent, at] of [["rem-sent-old", 1, OLD_TS], ["rem-unsent-old", 0, OLD_TS], ["rem-sent-future", 1, FUTURE_TS]]) rem.run(id, sent, at);
    const ses = db.prepare("INSERT INTO express_session VALUES (?, ?)");
    for (const [sid, data] of [["ses-old", sessionData("expires", OLD_TS)], ["ses-old-underscore", sessionData("_expires", OLD_TS)],
      ["ses-live", sessionData("expires", FUTURE_TS)]]) ses.run(sid, data);
  } finally { db.close(); }
  return dir;
}

/** What is left in each table, by id. */
function purgeLeft(dir) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dir, "hackathon.db"), { readonly: true, fileMustExist: true });
  try {
    return {
      invitations: db.prepare("SELECT id FROM invitations ORDER BY id").all().map((r) => r.id),
      email_reminders: db.prepare("SELECT id FROM email_reminders ORDER BY id").all().map((r) => r.id),
      express_session: db.prepare("SELECT sid FROM express_session ORDER BY sid").all().map((r) => r.sid),
    };
  } finally { db.close(); }
}

const ALL_ROWS = {
  invitations: ["inv-fresh", "inv-old-1", "inv-old-2", "inv-unused"],
  email_reminders: ["rem-sent-future", "rem-sent-old", "rem-unsent-old"],
  express_session: ["ses-live", "ses-old", "ses-old-underscore"],
};
const AFTER_PURGE = {
  invitations: ["inv-fresh", "inv-unused"],
  email_reminders: ["rem-sent-future", "rem-unsent-old"],
  express_session: ["ses-live"],
};

/**
 * A PATH shim around the real sqlite3: records every call, optionally prepends
 * `-init <rc>` (how ~/.sqliterc reaches it), answers every COUNT with text
 * that is not a number, or fails the count that `failCount` names.
 */
function sqliteShim(T, { rc = null, badCount = false, failCount = null } = {}) {
  const bin = path.join(T, "shim-bin");
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(T, "shim-calls.log");
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(bin, "sqlite3"), [
    "#!/bin/sh",
    rc ? `set -- -init ${q(rc)} "$@"` : "",
    `printf '%s\\n' "$*" >> ${q(calls)}`,
    badCount ? `case "$*" in *"SELECT COUNT(*)"*) echo "2 rows"; exit 0 ;; esac` : "",
    failCount ? `case "$*" in *"SELECT COUNT(*) FROM ${failCount} "*) echo "Error: database is locked" >&2; exit 5 ;; esac` : "",
    `exec ${q(REAL_SQLITE3)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}`, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "") };
}

const PURGE_ARGS = ["--apply", "--days", "1", "invitations", "email_reminders", "sessions"];

test.describe("v8.14.0 — purge.sh reads every count through a pinned sqlite3", () => {
  test("an operator's ~/.sqliterc cannot reshape purge.sh's counts: each rc still purges exactly the old rows", () => {
    test.skip(!REAL_SQLITE3, NO_SQLITE3);
    for (const rcText of [null, ".headers on", ".echo on", ".mode box"]) {
      const tree = scriptTree(`purge-rc-${rcText ? rcText.replace(/\W+/g, "-") : "none"}`);
      const fixture = purgeFixture(path.join(tree.T, "fixture"));
      let rc = null;
      if (rcText) {
        rc = path.join(tree.T, "sqliterc");
        fs.writeFileSync(rc, `${rcText}\n`);
        // ANTI-VACUITY: this rc really reshapes the read as purge.sh used to
        // make it (no -init /dev/null), so an unpinned script misreads here.
        const bare = spawnSync(REAL_SQLITE3, ["-init", rc, "-cmd", ".timeout 30000", path.join(fixture, "hackathon.db"),
          "SELECT COUNT(*) FROM invitations WHERE used_at IS NOT NULL"], { encoding: "utf8" });
        expect(bare.stdout.trim(), `${rcText}: the rc reshapes an unpinned read`).not.toBe("3");
      }
      const shim = sqliteShim(tree.T, { rc });
      const r = runScript(tree, "purge", PURGE_ARGS, { dataDir: fixture, extraEnv: { PATH: shim.PATH } });
      const ctx = `rc=${rcText}:\nstatus: ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}\ncalls:\n${shim.calls()}`;
      expect(shim.calls(), `the shim ran — ${ctx}`).toMatch(/DELETE FROM express_session/);
      if (rc) expect(shim.calls(), `…with the rc in front of every call — ${ctx}`).not.toMatch(/^(?!-init \S*sqliterc ).+$/m);
      expect(r.status, ctx).toBe(0);
      expect(r.stderr, ctx).toBe("");
      expect(r.stdout, ctx).toMatch(/^\s+used invitations: 2 rows$/m);
      expect(r.stdout, ctx).toMatch(/^\s+sent reminders: 1 rows$/m);
      expect(r.stdout, ctx).toMatch(/^\s+expired sessions: 2 rows$/m);
      expect(r.stdout, ctx).toMatch(/^Purge complete\.$/m);
      expect(purgeLeft(fixture), `exactly the old rows are deleted — ${ctx}`).toEqual(AFTER_PURGE);
    }
  });

  test("a count that is not a number stops purge.sh with an ERROR, before it deletes anything", () => {
    test.skip(!REAL_SQLITE3, NO_SQLITE3);
    const tree = scriptTree("purge-bad-count");
    const fixture = purgeFixture(path.join(tree.T, "fixture"));
    const shim = sqliteShim(tree.T, { badCount: true });
    const r = runScript(tree, "purge", PURGE_ARGS, { dataDir: fixture, extraEnv: { PATH: shim.PATH } });
    const ctx = `status: ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}\ncalls:\n${shim.calls()}`;
    expect(shim.calls(), `anti-vacuity: the count was asked — ${ctx}`).toMatch(/SELECT COUNT\(\*\) FROM invitations/);
    expect(r.status, `must refuse — ${ctx}`).not.toBe(0);
    expect(r.stderr, ctx).toMatch(/^ERROR: counting invitations rows in .*hackathon\.db did not answer a number/m);
    expect(r.stdout, `…and never claim it finished — ${ctx}`).not.toMatch(/Purge complete/);
    expect(shim.calls(), `no DELETE ran — ${ctx}`).not.toMatch(/DELETE/);
    expect(purgeLeft(fixture), ctx).toEqual(ALL_ROWS);
  });

  test("a failed count stops purge.sh with an ERROR; it is never read as zero rows", () => {
    test.skip(!REAL_SQLITE3, NO_SQLITE3);
    const tree = scriptTree("purge-failed-count");
    const fixture = purgeFixture(path.join(tree.T, "fixture"));
    const shim = sqliteShim(tree.T, { failCount: "express_session" });
    const r = runScript(tree, "purge", PURGE_ARGS, { dataDir: fixture, extraEnv: { PATH: shim.PATH } });
    const ctx = `status: ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}\ncalls:\n${shim.calls()}`;
    expect(r.status, `must refuse — ${ctx}`).not.toBe(0);
    expect(r.stderr, ctx).toMatch(/^ERROR: sqlite3 could not count expired sessions in .*hackathon\.db/m);
    expect(r.stdout, ctx).not.toMatch(/expired sessions: 0 rows/);
    expect(r.stdout, ctx).not.toMatch(/Purge complete/);
    // CONTROL: the categories before it ran normally, so the refusal is the count's.
    expect(purgeLeft(fixture), ctx).toEqual({ ...AFTER_PURGE, express_session: ALL_ROWS.express_session });
  });

  test("SOURCE: every sqlite3 call in purge.sh pins its format, and every count is checked before it is used", () => {
    const code = stripShellComments(fs.readFileSync(SCRIPTS.purge, "utf8"));
    const lines = code.split("\n");
    const calls = lines.filter((l) => /(^|[\s$(;&|])sqlite3\s/.test(l) && !/command -v sqlite3/.test(l) && !/^\s*echo\b/.test(l));
    expect(calls.length, `anti-vacuity: sqlite3 calls found:\n${calls.join("\n")}`).toBeGreaterThanOrEqual(3);
    for (const l of calls) expect(l, "a sqlite3 call without a pinned format").toMatch(/sqlite3 -init \/dev\/null -batch -noheader -list /);
    expect(code, "a failed read must never become a number").not.toMatch(/sqlite3[^\n]*\|\|\s*echo/);
    // Every COUNT goes through the checking helper, and the helper refuses both ways.
    const counts = lines.filter((l) => /SELECT COUNT\(\*\)/.test(l));
    expect(counts.length, "anti-vacuity: the category counts were found").toBeGreaterThanOrEqual(2);
    for (const l of counts) expect(l, "a count read outside _count_rows").toMatch(/^\s*_count_rows /);
    const helper = (/^_count_rows\(\) \{([\s\S]*?)^\}/m.exec(code) || [])[1] || "";
    expect(helper, "the helper reads with sqlite3 and handles its failure").toMatch(/_COUNT="\$\(sqlite3 [^\n]*"\)" \|\| \{[^}]*^\s*exit [1-9]\s*$[^}]*\}/m);
    expect(helper, "…and refuses anything but a bare number").toMatch(/if \[\[ ! "\$_COUNT" =~ \^\[0-9\]\+\$ \]\]; then\s*\n[^\n]*ERROR[^\n]*\n\s*exit [1-9]\s*\n\s*fi/);
    // The numeric tests read only what the helper vouched for.
    const assigns = lines.filter((l) => /^\s*count=/.test(l));
    expect(assigns.length, "anti-vacuity: the count assignments were found").toBeGreaterThanOrEqual(2);
    for (const l of assigns) expect(l.trim()).toBe('count="$_COUNT"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PURGE.SH PURGES THE DIRECTORY THE SERVER WRITES ITS LOGS TO (arm 11)
// ═══════════════════════════════════════════════════════════════════════════
// lib/log.js writes to LOG_DIR when it is set, else DATA_DIR/logs; purge.sh read
// only DATA_DIR/logs, so with LOG_DIR set it purged a directory nothing wrote to
// and left the real logs growing. Every behavioural arm plants an old log in BOTH
// places, so "deleted the right one" and "left the other alone" are each seen.
// Only `find`, `awk` and `sort` run (the logs category asks sqlite3 nothing), so
// these arms run on every runner; the stubs stay first on PATH.
test.describe("purge.sh purges LOG_DIR when the server writes there", () => {
  /** A LOG_DIR outside DATA_DIR holding an old app- and access- log and today's app log. */
  function plantLogDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const oldApp = path.join(dir, OLD_LOG);
    const oldAccess = path.join(dir, "access-2000-01-01.jsonl");
    const live = path.join(dir, `app-${today}.jsonl`);
    for (const f of [oldApp, oldAccess]) { fs.writeFileSync(f, "{}\n"); fs.utimesSync(f, Y2K, Y2K); }
    fs.writeFileSync(live, "{}\n");
    return { oldApp, oldAccess, live, today };
  }

  test("age mode: LOG_DIR's old logs are deleted, today's kept, DATA_DIR/logs untouched; without LOG_DIR, DATA_DIR/logs", () => {
    const tree = scriptTree("purge-logdir-age");
    const fixture = path.join(tree.T, "fixture");
    const dataLog = plantDataDir(fixture, "DATA_DIR/logs while LOG_DIR is set");
    const logDir = path.join(tree.T, "elsewhere", "logs");
    const L = plantLogDir(logDir);
    const r = runScript(tree, "purge", ["--apply", "--days", "1", "logs"], { dataDir: fixture, extraEnv: { LOG_DIR: logDir } });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
    expect(r.status, ctx).toBe(0);
    expect(r.stdout, `the run names the directory it purges — ${ctx}`).toMatch(new RegExp(`^\\s*LOGS_DIR : ${logDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    expect(fs.existsSync(L.oldApp), `LOG_DIR's old app log is deleted — ${ctx}`).toBe(false);
    expect(fs.existsSync(L.oldAccess), "and its old access log").toBe(false);
    expect(fs.existsSync(L.live), "today's log is kept").toBe(true);
    expect(fs.existsSync(dataLog), "DATA_DIR/logs is not the directory purged while LOG_DIR is set").toBe(true);

    // CONTROL: the same run without LOG_DIR purges DATA_DIR/logs and nothing in LOG_DIR.
    const tree2 = scriptTree("purge-logdir-unset");
    const fixture2 = path.join(tree2.T, "fixture");
    const dataLog2 = plantDataDir(fixture2, "DATA_DIR/logs with no LOG_DIR");
    const L2 = plantLogDir(path.join(tree2.T, "elsewhere", "logs"));
    const r2 = runScript(tree2, "purge", ["--apply", "--days", "1", "logs"], { dataDir: fixture2 });
    const ctx2 = `stdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`;
    expect(r2.status, ctx2).toBe(0);
    expect(fs.existsSync(dataLog2), `without LOG_DIR the DATA_DIR log is deleted — ${ctx2}`).toBe(false);
    expect(fs.existsSync(L2.oldApp), "and nothing elsewhere is touched").toBe(true);
  });

  test("--max-mb mode: LOG_DIR is measured and trimmed, today's live file kept by name, DATA_DIR/logs untouched", () => {
    const tree = scriptTree("purge-logdir-maxmb");
    const fixture = path.join(tree.T, "fixture");
    const dataLog = plantDataDir(fixture, "a big old log under DATA_DIR/logs");
    fs.writeFileSync(dataLog, Buffer.alloc(3 * 1024 * 1024, 0x20));
    fs.utimesSync(dataLog, Y2K, Y2K);
    const logDir = path.join(tree.T, "elsewhere", "logs");
    const L = plantLogDir(logDir);
    fs.writeFileSync(L.oldApp, Buffer.alloc(2 * 1024 * 1024, 0x20));
    fs.utimesSync(L.oldApp, Y2K, Y2K);
    fs.writeFileSync(L.live, Buffer.alloc(2 * 1024 * 1024, 0x20));
    const r = runScript(tree, "purge", ["--apply", "--max-mb", "1", "logs"], { dataDir: fixture, extraEnv: { LOG_DIR: logDir } });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
    expect(r.status, ctx).toBe(0);
    expect(r.stdout, `the total is LOG_DIR's (4 MB), not DATA_DIR/logs' (3 MB) — ${ctx}`).toMatch(/current total: 4MB/);
    expect(fs.existsSync(L.oldApp), `the oldest rotated file in LOG_DIR is deleted — ${ctx}`).toBe(false);
    expect(fs.existsSync(L.live), "today's live file is kept").toBe(true);
    expect(fs.existsSync(dataLog), "DATA_DIR/logs is untouched").toBe(true);
  });

  test("LOG_DIR set but empty, or not a directory, is refused before anything is deleted; a relative one is resolved absolute", () => {
    for (const [label, value] of [["empty", ""], ["missing", "no-such-dir"], ["a file", "a-file"]]) {
      const tree = scriptTree(`purge-logdir-bad-${label.replace(/\W+/g, "-")}`);
      const fixture = path.join(tree.T, "fixture");
      const dataLog = plantDataDir(fixture, "must survive a refused LOG_DIR");
      fs.writeFileSync(path.join(tree.T, "a-file"), "not a directory\n");
      const before = treeState(tree.T);
      const r = runScript(tree, "purge", ["--apply", "--days", "1", "logs"], { dataDir: fixture, extraEnv: { LOG_DIR: value } });
      const ctx = `${label}:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
      expect(r.status, ctx).toBe(1);
      expect(r.stderr, ctx).toMatch(label === "empty" ? /LOG_DIR is set but empty/ : /LOG_DIR is not a directory/);
      expect(fs.existsSync(dataLog), `nothing is deleted — ${ctx}`).toBe(true);
      expect(treeState(tree.T), `nothing in the tree changed — ${ctx}`).toEqual(before);
    }
    // CONTROL: a relative LOG_DIR is resolved from the directory the script runs in.
    const tree = scriptTree("purge-logdir-relative");
    const fixture = path.join(tree.T, "fixture");
    plantDataDir(fixture, "kept");
    const L = plantLogDir(path.join(tree.T, "rel-logs"));
    const r = runScript(tree, "purge", ["--days", "1", "logs"], { dataDir: fixture, extraEnv: { LOG_DIR: "rel-logs" } });
    const ctx = `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
    expect(r.status, ctx).toBe(0);
    expect(r.stdout, `absolute in the header — ${ctx}`).toContain(`LOGS_DIR : ${path.join(tree.T, "rel-logs")}`);
    expect(r.stdout, `and the old log is the candidate — ${ctx}`).toContain(`candidate: ${L.oldApp}`);
  });

  test("SOURCE: the logs directory comes from LOG_DIR when set, refused when empty, and is the only one the log purge reads", () => {
    const code = stripShellComments(fs.readFileSync(SCRIPTS.purge, "utf8"));
    // The set-but-empty refusal exits, and sits inside the set branch.
    const block = (/^if \[\[ -n "\$\{LOG_DIR\+set\}" \]\]; then\n([\s\S]*?)^else\n\s*LOGS_DIR="\$DATA_DIR\/logs"\n^fi$/m.exec(code) || [])[1];
    expect(block, "the LOG_DIR / DATA_DIR/logs choice exists in this shape").toBeTruthy();
    expect(block).toMatch(/if \[\[ -z "\$LOG_DIR" \]\]; then\n[^\n]*ERROR[^\n]*\n\s*exit 1\n\s*fi/);
    expect(block).toMatch(/if \[\[ ! -d "\$LOG_DIR" \]\]; then\n[^\n]*ERROR[^\n]*\n\s*exit 1\n\s*fi/);
    expect(block).toMatch(/LOGS_DIR="\$_ABS_LOG_DIR"/);
    // The choice is made before any deletion.
    expect(code.indexOf("${LOG_DIR+set}"), "anti-vacuity").toBeGreaterThan(0);
    expect(code.indexOf("${LOG_DIR+set}")).toBeLessThan(code.indexOf("rm -f"));
    // Every find in the log purge reads $LOGS_DIR, never a path built from DATA_DIR.
    const finds = code.split("\n").filter((l) => /\bfind "/.test(l));
    expect(finds.length, `anti-vacuity: the log finds were found:\n${finds.join("\n")}`).toBeGreaterThanOrEqual(3);
    for (const l of finds) expect(l, "a log find not reading $LOGS_DIR").toMatch(/\bfind "\$LOGS_DIR"/);
    const named = code.split("\n").filter((l) => /\$DATA_DIR\/logs/.test(l) && !/^\s*echo\b/.test(l));
    expect(named, "outside messages, DATA_DIR/logs is named once, as the fallback").toEqual(['  LOGS_DIR="$DATA_DIR/logs"']);
  });
});
