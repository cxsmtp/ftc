// BACKUP_COMPLETE VOUCHES FOR THE ATTACHMENT FILES THE SNAPSHOT NAMES.
//
// scripts/backup.sh snapshots the database at one instant and copies the
// attachment files over a stretch of time while the server keeps working. A
// challenge delete commits its row deletion and only then unlinks its files, so
// a delete landing between the snapshot and a single copy left the snapshot
// naming a ZIP the backup did not hold — and the run certified it (exit 0,
// BACKUP_COMPLETE, integrity ok; reproduced against the real DELETE route).
//
// The script now copies before AND after the snapshot (passes A and B) and then
// reconciles the snapshot's own task_attachments rows against what landed, by
// path and size; a named file neither copy holds forces a new snapshot, bounded
// by BACKUP_MAX_ATTEMPTS, unless the LIVE volume itself has lost it, which is
// counted, never refused. The arms, each with the mutation it exists to kill:
//   A  delete after the snapshot -> pass A holds the file, one snapshot.
//   B  upload before + delete after the snapshot -> a second snapshot, which no
//      longer names it (kills "treat retry as ok" and "classify a race as lost").
//   C  racing every attempt -> exit 1, no marker, exactly BACKUP_MAX_ATTEMPTS
//      snapshots (kills an unbounded or certifying exhausted branch).
//   D  a file lost or truncated on the live volume -> certified, counted, listed,
//      WARNING on stderr and a syslog line (kills dropping the size check, or
//      classifying a loss as a race).
//   E  a staging row without its file -> reported, never retried or refused.
//   F  an upload landing between pass A and the snapshot -> still one snapshot
//      (the behavioural witness for pass B, for attachments and staging).
//   R  a file the copies missed that is still on the live volume -> a retry,
//      never a loss (kills certifying it as lost on the live volume).
//   U  --reuse: a file the live volume lost since an earlier run into the same
//      directory is reported like D but stays verified, and one deleted with
//      its row after the snapshot is not (kills skipping the live check for a
//      held file, lowering attachments_verified, and dropping the row check).
//   G  rsync exit 24 is tolerated; 23 (the control) still aborts with 23.
//   H  a storage_path outside attachments/ refuses, even with a right-size file
//      planted where `$OUT_DIR/../x` points; H2 a value holding a line break
//      (inside, or leading) or a field separator cannot pass for well-formed
//      rows; a host whose stat reports no size refuses.
//   rc an operator's ~/.sqliterc cannot reshape the script's reads.
//   P  a sqlite3 error on either table probe aborts; it is never "no table".
//   S  SOURCE, runs everywhere: the order inside the attempt loop, the exit-24
//      branch, the retry bound, the live stat ahead of the backup's copy and
//      the held-loss count (U's fix), `-init /dev/null` on every sqlite3 call,
//      the probes as plain assignments, and the storage-path SINKS in the
//      server (every generator and INSERT site) tied to the script's path regex.
//
// Deterministic windows come from a PATH shim around the real sqlite3: on a
// `.backup` call it meets the test at pre-N (between pass A and snapshot N) and
// post-N (between snapshot N and pass B), only where the test armed that point,
// and gives up with exit 98 (no marker) if never released. The script reads no
// test variable. The CI image has neither sqlite3 nor rsync, so the behavioural
// arms skip there with that reason and the SOURCE arm is what runs.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const Database = require("better-sqlite3");
const { apiLogin, zipOf, TEST_DATA_DIR, TEST_DB_PATH } = require("./helpers");
const { stripJsComments, stripShellComments } = require("./doc-registry");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "backup.sh");
const which = (bin) => (spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout || "").trim();
const HAVE_TOOLS = Boolean(which("sqlite3") && which("rsync"));
const NO_TOOLS = "this runner has no sqlite3/rsync, so backup.sh cannot run; the SOURCE arm covers it";
const MAX_ATTEMPTS = Number((/^BACKUP_MAX_ATTEMPTS=(\d+)\s*$/m.exec(fs.readFileSync(SCRIPT, "utf8")) || [])[1]);

const scratches = [];
function scratch(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `backup-reconcile-${tag}-`));
  scratches.push(d);
  return d;
}
test.afterAll(() => {
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256Of = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fileIs = (file, size) => {
  try { const st = fs.lstatSync(file); return st.isFile() && st.size === size; } catch (_) { return false; }
};
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A shim directory and a hook directory. sqlite3: records every call, counts
 * `.backup` calls and meets the test at armed points around each; optionally
 * prepends an rc file (`-init <rc>`, how ~/.sqliterc reaches it) or fails the
 * table probe for the table `failProbe` names. rsync: optionally the real copy
 * followed by a fake status for the attachments/ copy, or the real copy minus
 * the file `rsyncSkip` names on the first attempt's two attachments/ copies.
 * logger: always a recorder, so no arm ever writes to this host's syslog.
 */
function harness(tag, { rc = null, failProbe = null, rsyncExit = null, rsyncSkip = null, brokenStat = false } = {}) {
  const T = scratch(tag);
  const bin = path.join(T, "bin");
  const hook = path.join(T, "hook");
  fs.mkdirSync(bin);
  fs.mkdirSync(hook);
  const sqlite = [
    "#!/bin/sh",
    `HOOK=${shq(hook)}`,
    `REAL=${shq(which("sqlite3"))}`,
    `printf '%s\\n' "$*" >> "$HOOK/sqlite3.log"`,
    "meet() {",
    "  [ -e \"$HOOK/$1.wait\" ] || return 0",
    "  : > \"$HOOK/$1.reached\"",
    "  i=0",
    "  while [ ! -e \"$HOOK/$1.go\" ]; do",
    "    i=$((i + 1)); if [ \"$i\" -gt 600 ]; then echo \"shim: $1 was never released\" >&2; exit 98; fi",
    "    sleep 0.05",
    "  done",
    "}",
    failProbe ? `case "$*" in *"name='${failProbe}'"*) echo "Error: simulated failure of the table probe" >&2; exit 1 ;; esac` : "",
    rc ? `set -- -init ${shq(rc)} "$@"` : "",
    "case \"$*\" in",
    "  *\".backup \"*)",
    "    n=$(( $(cat \"$HOOK/count\" 2>/dev/null || echo 0) + 1 )); echo \"$n\" > \"$HOOK/count\"",
    "    meet \"pre-$n\"",
    "    \"$REAL\" \"$@\" || exit $?",
    "    meet \"post-$n\"",
    "    exit 0 ;;",
    "esac",
    "exec \"$REAL\" \"$@\"",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(bin, "sqlite3"), sqlite, { mode: 0o755 });
  if (rsyncExit !== null) {
    fs.writeFileSync(path.join(bin, "rsync"), [
      "#!/bin/sh",
      `${shq(which("rsync"))} "$@" || exit $?`,
      `case "$*" in *"/attachments/ "*) exit ${Number(rsyncExit)} ;; esac`,
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
  } else if (rsyncSkip !== null) {
    fs.writeFileSync(path.join(bin, "rsync"), [
      "#!/bin/sh",
      `HOOK=${shq(hook)}`,
      `REAL=${shq(which("rsync"))}`,
      `case "$*" in *"/attachments/ "*)`,
      `  n=$(( $(cat "$HOOK/rsync-att" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$HOOK/rsync-att"`,
      `  if [ "$n" -le 2 ]; then exec "$REAL" --exclude=${shq(rsyncSkip)} "$@"; fi ;;`,
      "esac",
      `exec "$REAL" "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
  }
  if (brokenStat) fs.writeFileSync(path.join(bin, "stat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "logger"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(path.join(hook, "logger.log"))}\nexit 0\n`, { mode: 0o755 });
  const read = (f) => { try { return fs.readFileSync(path.join(hook, f), "utf8"); } catch (_) { return ""; } };
  return {
    T, bin, hook,
    out: path.join(T, "out"),
    backups: () => Number(read("count").trim() || 0),
    logger: () => read("logger.log"),
    calls: () => read("sqlite3.log"),
    arm: (pt) => fs.writeFileSync(path.join(hook, `${pt}.wait`), ""),
    release: (pt) => fs.writeFileSync(path.join(hook, `${pt}.go`), ""),
    reached: (pt) => fs.existsSync(path.join(hook, `${pt}.reached`)),
    releaseAll() {
      for (const f of fs.readdirSync(hook)) if (f.endsWith(".wait")) fs.writeFileSync(path.join(hook, f.replace(/\.wait$/, ".go")), "");
    },
  };
}

/** Start backup.sh under bash, with an environment built from scratch. */
function startBackup(h, dataDir, extraArgs = []) {
  const env = { PATH: `${h.bin}:${process.env.PATH}`, HOME: h.T, NODE_OPTIONS: "", DATA_DIR: dataDir };
  const child = spawn("bash", [SCRIPT, h.out, ...extraArgs], { env, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, stdout: "", stderr: "", status: undefined };
  child.stdout.on("data", (d) => { run.stdout += d; });
  child.stderr.on("data", (d) => { run.stderr += d; });
  run.done = new Promise((resolve) => child.on("close", (code, signal) => {
    run.status = code === null ? `signal ${signal}` : code;
    resolve(run);
  }));
  return run;
}

const ctx = (h, run) => `\nstatus: ${run.status}\n.backup calls: ${h.backups()}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\nsqlite3 calls:\n${h.calls()}`;

/** Wait until the shim parks at `pt`; fail by name if the script died first. */
async function reach(h, run, pt) {
  const t0 = Date.now();
  while (!h.reached(pt)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`backup.sh exited before reaching ${pt}${ctx(h, run)}`);
    if (Date.now() - t0 > 25_000) throw new Error(`backup.sh never reached ${pt}${ctx(h, run)}`);
    await sleep(25);
  }
}

/** Release every armed point and make sure the child is gone. */
async function settle(h, run) {
  h.releaseAll();
  const exited = await Promise.race([run.done.then(() => true), sleep(15_000).then(() => false)]);
  if (!exited) { run.child.kill("SIGKILL"); await run.done; }
}

/** "key: value" lines of a marker or metadata file (first occurrence of each key). */
function kv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function snapshotRows(out) {
  const db = new Database(path.join(out, "hackathon.db"), { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT id, task_id, storage_path, size_bytes, sha256 FROM task_attachments").all(); }
  finally { db.close(); }
}

// ── the worker's own server (arms A–E) ──────────────────────────────────────

function liveRows(table = "task_attachments") {
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try { return db.prepare(`SELECT id, storage_path, size_bytes FROM ${table}`).all(); }
  finally { db.close(); }
}

/** Every live row's file is in place at its size: the state each arm starts from. */
function assertLiveIntact(label) {
  for (const table of ["task_attachments", "task_attachments_staging"]) {
    const broken = liveRows(table).filter((r) => !fileIs(path.join(TEST_DATA_DIR, r.storage_path), r.size_bytes));
    expect(broken, `${label}: precondition — every live ${table} row has its file`).toEqual([]);
  }
}

async function admin() {
  const { api, csrf } = await apiLogin("superadmin");
  return { api, csrf };
}

/** A fresh challenge with one uploaded ZIP; returns its row as stored. */
async function challengeWithZip(a, tag) {
  const r = await a.api.post("/api/admin/tasks", {
    headers: { "x-csrf-token": a.csrf, "content-type": "application/json" },
    data: { title: `Backup ${tag} ${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft" },
  });
  expect(r.ok(), `create challenge (${tag}): ${await r.text()}`).toBe(true);
  const taskId = (await r.json()).id;
  const up = await a.api.post(`/api/admin/tasks/${taskId}/attachments`, {
    headers: { "x-csrf-token": a.csrf },
    multipart: { file: { name: `${tag}.zip`, mimeType: "application/zip", buffer: zipOf("README.txt", `${tag} ${crypto.randomUUID()}`) } },
  });
  expect(up.ok(), `upload (${tag}): ${await up.text()}`).toBe(true);
  const attId = (await up.json()).id;
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  let row;
  try { row = db.prepare("SELECT id, task_id, storage_path, size_bytes, sha256 FROM task_attachments WHERE id=?").get(attId); }
  finally { db.close(); }
  expect(row, `the upload's row (${tag})`).toBeTruthy();
  expect(fileIs(path.join(TEST_DATA_DIR, row.storage_path), row.size_bytes), `the upload's file is in place (${tag})`).toBe(true);
  return { taskId, ...row };
}

/** The real hard delete: commit, then the post-commit unlink — polled to completion. */
async function deleteChallenge(a, att) {
  const r = await a.api.delete(`/api/admin/tasks/${att.taskId}`, { headers: { "x-csrf-token": a.csrf } });
  expect(r.ok(), `delete challenge ${att.taskId}: ${await r.text()}`).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(TEST_DATA_DIR, att.storage_path)),
    { message: `the deleted challenge's file ${att.storage_path} is unlinked`, timeout: 10_000 }).toBe(false);
}

test.describe("backup.sh certifies every attachment file its snapshot names", () => {
  test("A: a challenge deleted after the snapshot is still in the backup, from the copy before it", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const a = await admin();
    const h = harness("a");
    let run = null;
    try {
      assertLiveIntact("A");
      const keeper = await challengeWithZip(a, "keeper");
      const victim = await challengeWithZip(a, "victim");
      h.arm("post-1");
      run = startBackup(h, TEST_DATA_DIR);
      await reach(h, run, "post-1");
      await deleteChallenge(a, victim);
      h.release("post-1");
      await run.done;
      expect(run.status, `a backup raced by a delete still completes${ctx(h, run)}`).toBe(0);
      expect(h.backups(), `…with one snapshot: pass A already holds the file${ctx(h, run)}`).toBe(1);
      const done = kv(path.join(h.out, "BACKUP_COMPLETE"));
      expect(done.attachments_lost_on_live_volume, `nothing is lost on the live volume${ctx(h, run)}`).toBe("0");
      const rows = snapshotRows(h.out);
      expect(rows.map((r) => r.id), "the snapshot names the victim and the keeper").toEqual(expect.arrayContaining([victim.id, keeper.id]));
      expect(done.attachments_verified, `every row is verified${ctx(h, run)}`).toBe(String(rows.length));
      for (const r of rows) {
        const f = path.join(h.out, r.storage_path);
        expect(fs.existsSync(f), `${r.storage_path} (named by the snapshot) is in the backup${ctx(h, run)}`).toBe(true);
        expect(sha256Of(f), `${r.storage_path} is the file the row describes`).toBe(r.sha256);
      }
      expect(kv(path.join(h.out, "BACKUP_METADATA.txt")).snapshot_attempts).toBe("1");
      expect(h.logger(), "no loss, so nothing is written to syslog").toBe("");
      await deleteChallenge(a, keeper);
    } finally {
      if (run) await settle(h, run);
      await a.api.dispose();
    }
  });

  test("B: an upload before the snapshot deleted after it forces a new snapshot that no longer names it", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const a = await admin();
    const h = harness("b");
    let run = null;
    try {
      assertLiveIntact("B");
      h.arm("pre-1");
      h.arm("post-1");
      run = startBackup(h, TEST_DATA_DIR);
      await reach(h, run, "pre-1");
      const late = await challengeWithZip(a, "late");          // after pass A, before snapshot 1
      h.release("pre-1");
      await reach(h, run, "post-1");
      await deleteChallenge(a, late);                           // after snapshot 1, before pass B
      h.release("post-1");
      await run.done;
      expect(run.status, `the race is retried, then certified${ctx(h, run)}`).toBe(0);
      expect(h.backups(), `exactly one retry${ctx(h, run)}`).toBe(2);
      expect(run.stdout, "the retry names the raced file").toContain(`${late.storage_path} (deleted after the snapshot)`);
      expect(run.stdout).toContain(`attempt 2 of ${MAX_ATTEMPTS}`);
      const rows = snapshotRows(h.out);
      expect(rows.map((r) => r.id), "the final snapshot no longer names the deleted challenge's file").not.toContain(late.id);
      for (const r of rows) {
        const f = path.join(h.out, r.storage_path);
        expect(fs.existsSync(f) && sha256Of(f) === r.sha256, `${r.storage_path} is in the backup${ctx(h, run)}`).toBe(true);
      }
      expect(kv(path.join(h.out, "BACKUP_METADATA.txt")).snapshot_attempts).toBe("2");
      expect(kv(path.join(h.out, "BACKUP_COMPLETE")).attachments_lost_on_live_volume, "a race is not a loss").toBe("0");
    } finally {
      if (run) await settle(h, run);
      await a.api.dispose();
    }
  });

  test("C: raced on every attempt, it refuses: exit 1, no marker, BACKUP_MAX_ATTEMPTS snapshots", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    expect(MAX_ATTEMPTS, "anti-vacuity: BACKUP_MAX_ATTEMPTS was read from the script").toBeGreaterThanOrEqual(2);
    const a = await admin();
    const h = harness("c");
    let run = null;
    try {
      assertLiveIntact("C");
      for (let n = 1; n <= MAX_ATTEMPTS; n++) { h.arm(`pre-${n}`); h.arm(`post-${n}`); }
      run = startBackup(h, TEST_DATA_DIR);
      let last = null;
      for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        await reach(h, run, `pre-${n}`);
        last = await challengeWithZip(a, `race${n}`);
        h.release(`pre-${n}`);
        await reach(h, run, `post-${n}`);
        await deleteChallenge(a, last);
        h.release(`post-${n}`);
      }
      await run.done;
      expect(run.status, `exhausted retries refuse${ctx(h, run)}`).toBe(1);
      expect(h.backups(), `no snapshot beyond the bound${ctx(h, run)}`).toBe(MAX_ATTEMPTS);
      expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE")), "…and nothing is certified").toBe(false);
      expect(run.stderr).toMatch(new RegExp(`after ${MAX_ATTEMPTS} snapshots`));
      expect(run.stderr, "the refusal names the file of the last attempt").toContain(last.storage_path);
      expect(run.stderr, "…and says what to do with the directory").toMatch(/incomplete \(no BACKUP_COMPLETE\) and safe to delete/);
    } finally {
      if (run) await settle(h, run);
      await a.api.dispose();
    }
  });

  test("D: files lost or damaged on the live volume are certified as exactly that — counted, listed, logged", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const a = await admin();
    const h = harness("d");
    let run = null;
    const made = [];
    try {
      assertLiveIntact("D");
      const gone = await challengeWithZip(a, "gone"); made.push(gone);
      const short = await challengeWithZip(a, "short"); made.push(short);
      fs.unlinkSync(path.join(TEST_DATA_DIR, gone.storage_path));
      fs.truncateSync(path.join(TEST_DATA_DIR, short.storage_path), 3);
      run = startBackup(h, TEST_DATA_DIR);
      await run.done;
      expect(run.status, `a loss on the live volume is certified, not refused${ctx(h, run)}`).toBe(0);
      expect(h.backups(), `no retry is wasted on it${ctx(h, run)}`).toBe(1);
      const rows = snapshotRows(h.out);
      const done = kv(path.join(h.out, "BACKUP_COMPLETE"));
      expect(done.attachments_lost_on_live_volume, ctx(h, run)).toBe("2");
      expect(done.attachments_verified, "the two damaged files are not verified").toBe(String(rows.length - 2));
      const meta = fs.readFileSync(path.join(h.out, "BACKUP_METADATA.txt"), "utf8");
      for (const r of [gone, short]) {
        expect(meta, `BACKUP_METADATA.txt lists ${r.storage_path}`)
          .toContain(`lost_on_live_volume: ${r.storage_path} size=${r.size_bytes} attachment=${r.id} challenge=${r.taskId} (attached)`);
      }
      expect(run.stderr, ctx(h, run)).toMatch(/^WARNING: 2 attachment file/m);
      expect(run.stderr, "…and says where the files can still be found").toMatch(/An earlier backup may still hold them/);
      expect(h.logger(), "the loss reaches syslog, the one place a cron run shows it")
        .toMatch(/^-t hackarena-backup .*\b2 attachment file\(s\).*copy them back from an earlier backup/m);
    } finally {
      if (run) await settle(h, run);
      for (const m of made) { await a.api.delete(`/api/admin/tasks/${m.taskId}`, { headers: { "x-csrf-token": a.csrf } }); }
      await a.api.dispose();
    }
  });

  test("E: a staging row without its file is reported, never retried or refused", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const a = await admin();
    const h = harness("e");
    let run = null;
    const ids = [];
    try {
      assertLiveIntact("E");
      for (const tag of ["stage-gone", "stage-kept"]) {
        const r = await a.api.post("/api/admin/attachment-staging", {
          headers: { "x-csrf-token": a.csrf },
          multipart: { file: { name: `${tag}.zip`, mimeType: "application/zip", buffer: zipOf("README.txt", `${tag} ${crypto.randomUUID()}`) } },
        });
        expect(r.ok(), `staging upload ${tag}: ${await r.text()}`).toBe(true);
        ids.push((await r.json()).staging_id);
      }
      const byId = Object.fromEntries(liveRows("task_attachments_staging").map((r) => [r.id, r]));
      expect(byId[ids[0]] && byId[ids[1]], "both staging rows exist").toBeTruthy();
      fs.unlinkSync(path.join(TEST_DATA_DIR, byId[ids[0]].storage_path));
      run = startBackup(h, TEST_DATA_DIR);
      await run.done;
      expect(run.status, ctx(h, run)).toBe(0);
      expect(h.backups(), `staging never forces a retry${ctx(h, run)}`).toBe(1);
      expect(kv(path.join(h.out, "BACKUP_METADATA.txt")).staging_rows_without_file, ctx(h, run)).toBe("1");
      expect(fs.existsSync(path.join(h.out, byId[ids[1]].storage_path)), "the other staging upload is in the backup").toBe(true);
      expect(run.stdout).toMatch(/NOTE: 1 unfinished upload\(s\) under attachments-staging\//);
      expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE"))).toBe(true);
    } finally {
      if (run) await settle(h, run);
      for (const id of ids) { await a.api.delete(`/api/admin/attachment-staging/${id}`, { headers: { "x-csrf-token": a.csrf } }); }
      await a.api.dispose();
    }
  });
});

// ── scratch volumes, no server (arms F, G, H, rc, P) ────────────────────────

/** A data directory holding a minimal schema the reconcile reads, plus helpers to add rows with files. */
function scratchVolume(T) {
  const dataDir = path.join(T, "data");
  for (const d of ["attachments", "attachments-staging", "logs"]) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "logs", "app-2026-01-01.jsonl"), "{}\n");
  const dbFile = path.join(dataDir, "hackathon.db");
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY);
    CREATE TABLE task_attachments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, storage_path TEXT NOT NULL, detached_at TEXT);
    CREATE TABLE task_attachments_staging (id TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, storage_path TEXT NOT NULL);`);
  db.close();
  const write = (sql, args) => { const c = new Database(dbFile); try { c.prepare(sql).run(...args); } finally { c.close(); } };
  return {
    dataDir,
    attach(id, rel, { body = `body of ${id}`, file = true, size = null, taskId = `task-${id}` } = {}) {
      if (file) fs.writeFileSync(path.join(dataDir, rel), body);
      write("INSERT INTO task_attachments (id, task_id, size_bytes, sha256, storage_path) VALUES (?,?,?,?,?)",
        [id, taskId, size === null ? Buffer.byteLength(body) : size, "x", rel]);
    },
    stage(id, rel, body = `staged ${id}`) {
      fs.writeFileSync(path.join(dataDir, rel), body);
      write("INSERT INTO task_attachments_staging (id, size_bytes, storage_path) VALUES (?,?,?)", [id, Buffer.byteLength(body), rel]);
    },
  };
}

test.describe("backup.sh's reconcile on a scratch volume", () => {
  test("F: an upload landing between the first copy and the snapshot costs no retry — the copy after it holds it", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const h = harness("f");
    const v = scratchVolume(h.T);
    v.attach("a1", "attachments/a1.zip");
    let run = null;
    try {
      h.arm("pre-1");
      run = startBackup(h, v.dataDir);
      await reach(h, run, "pre-1");
      v.attach("a2", "attachments/new-upload.zip", { body: "uploaded after pass A" });
      v.stage("s1", "attachments-staging/new-stage.zip");
      h.release("pre-1");
      await run.done;
      expect(run.status, ctx(h, run)).toBe(0);
      expect(h.backups(), `pass B copied the upload, so the first snapshot is certified${ctx(h, run)}`).toBe(1);
      const meta = kv(path.join(h.out, "BACKUP_METADATA.txt"));
      expect(meta.snapshot_attempts).toBe("1");
      expect(meta.staging_rows_without_file, `pass B copied the staging upload too${ctx(h, run)}`).toBe("0");
      expect(fs.readFileSync(path.join(h.out, "attachments", "new-upload.zip"), "utf8")).toBe("uploaded after pass A");
      expect(fs.existsSync(path.join(h.out, "attachments-staging", "new-stage.zip"))).toBe(true);
      expect(kv(path.join(h.out, "BACKUP_COMPLETE")).attachments_verified).toBe("2");
    } finally {
      if (run) await settle(h, run);
    }
  });

  test("G: rsync exit 24 (a file vanished mid-copy) is tolerated; any other failure still aborts with its status", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    for (const [code, ok] of [[24, true], [23, false]]) {
      const h = harness(`g${code}`, { rsyncExit: code });
      const v = scratchVolume(h.T);
      v.attach("a1", "attachments/a1.zip");
      const run = startBackup(h, v.dataDir);
      await run.done;
      if (ok) {
        expect(run.status, `exit 24 does not abort the backup${ctx(h, run)}`).toBe(0);
        expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE")), "…which the reconcile then certifies").toBe(true);
        expect(run.stdout).toMatch(/files under attachments\/ were deleted on the live volume during the copy; checked below/);
      } else {
        expect(run.status, `CONTROL: rsync's other failures abort with their own status${ctx(h, run)}`).toBe(23);
        expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE")), "…and certify nothing").toBe(false);
      }
    }
  });

  test("R: a named file the copies missed that is still on the live volume is a retry, never a loss", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const h = harness("r", { rsyncSkip: "held.zip" });
    const v = scratchVolume(h.T);
    v.attach("a1", "attachments/a1.zip");
    v.attach("a2", "attachments/held.zip", { body: "on the live volume all along" });
    const run = startBackup(h, v.dataDir);
    await run.done;
    expect(run.status, ctx(h, run)).toBe(0);
    expect(fs.readFileSync(path.join(h.hook, "rsync-att"), "utf8").trim(), "anti-vacuity: the shim saw every attachments/ copy").toBe("4");
    expect(h.backups(), `the first attempt's copies skipped held.zip, so a second snapshot was taken${ctx(h, run)}`).toBe(2);
    expect(run.stdout, "the retry says why").toContain("attachments/held.zip (on the live volume, not yet copied)");
    const done = kv(path.join(h.out, "BACKUP_COMPLETE"));
    expect(done.attachments_lost_on_live_volume, `the live volume has the file, so nothing is lost${ctx(h, run)}`).toBe("0");
    expect(done.attachments_verified).toBe("2");
    expect(fs.readFileSync(path.join(h.out, "attachments", "held.zip"), "utf8")).toBe("on the live volume all along");
    expect(h.logger(), "no loss, so nothing reaches syslog").toBe("");
  });

  test("U: under --reuse, a file the live volume has lost since an earlier run is reported, and still held", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const h = harness("u");
    const v = scratchVolume(h.T);
    v.attach("a1", "attachments/a1.zip");
    v.attach("a2", "attachments/lost.zip", { body: "held since the first run" });
    v.attach("a3", "attachments/raced.zip", { body: "deleted with its row" });
    const done = () => kv(path.join(h.out, "BACKUP_COMPLETE"));
    const first = startBackup(h, v.dataDir);
    await first.done;
    expect(first.status, `run 1, a fresh directory${ctx(h, first)}`).toBe(0);
    // CONTROL: the same directory again with --reuse and every live file intact.
    const ctl = startBackup(h, v.dataDir, ["--reuse"]);
    await ctl.done;
    expect(ctl.status, `run 2, --reuse, nothing lost${ctx(h, ctl)}`).toBe(0);
    expect([done().attachments_verified, done().attachments_lost_on_live_volume], ctx(h, ctl)).toEqual(["3", "0"]);
    expect(ctl.stderr, ctx(h, ctl)).not.toMatch(/WARNING/);
    expect(h.logger(), "no loss, so nothing reaches syslog").toBe("");

    // The live volume loses lost.zip, its row kept; raced.zip is deleted the
    // way the server deletes, row first, after the third snapshot.
    fs.unlinkSync(path.join(v.dataDir, "attachments", "lost.zip"));
    const n = h.backups() + 1;
    h.arm(`post-${n}`);
    const run = startBackup(h, v.dataDir, ["--reuse"]);
    try {
      await reach(h, run, `post-${n}`);
      const db = new Database(path.join(v.dataDir, "hackathon.db"));
      try { db.prepare("DELETE FROM task_attachments WHERE id='a3'").run(); } finally { db.close(); }
      fs.unlinkSync(path.join(v.dataDir, "attachments", "raced.zip"));
      h.release(`post-${n}`);
      await run.done;
    } finally {
      await settle(h, run);
    }
    expect(run.status, `a loss under --reuse is certified, not refused${ctx(h, run)}`).toBe(0);
    expect(h.backups(), `no retry: both files are held here${ctx(h, run)}`).toBe(n);
    expect(snapshotRows(h.out).map((r) => r.id).sort(), "anti-vacuity: the snapshot names the raced file").toEqual(["a1", "a2", "a3"]);
    expect([done().attachments_verified, done().attachments_lost_on_live_volume],
      `the loss is counted; the held copy keeps every row verified${ctx(h, run)}`).toEqual(["3", "1"]);
    const meta = fs.readFileSync(path.join(h.out, "BACKUP_METADATA.txt"), "utf8");
    expect(meta).toContain("lost_on_live_volume: attachments/lost.zip size=24 attachment=a2 challenge=task-a2 (attached; this backup holds a copy)\n");
    expect(meta, "a file deleted with its row is the race, never a loss").not.toContain("raced.zip");
    expect(run.stderr, ctx(h, run)).toMatch(/^WARNING: 1 attachment file/m);
    expect(run.stderr, "…saying this backup still holds it").toMatch(/This backup still holds a copy of 1 of them/);
    expect(run.stderr, "…and not that it is missing here too").not.toMatch(/not in this backup either/);
    expect(h.logger(), "the loss reaches syslog").toMatch(/^-t hackarena-backup .*\b1 attachment file\(s\).*this backup holds a copy of each/m);
    expect(fs.readFileSync(path.join(h.out, "attachments", "lost.zip"), "utf8"), "the backup still holds the file").toBe("held since the first run");
  });

  test("H: a storage path outside attachments/ refuses, even with a right-size file where it points", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const h = harness("h");
    const v = scratchVolume(h.T);
    v.attach("a1", "attachments/a1.zip");
    v.attach("esc", "../escape.zip", { file: false, size: 5 });
    fs.writeFileSync(path.join(path.dirname(h.out), "escape.zip"), "12345");   // $OUT_DIR/../escape.zip
    const run = startBackup(h, v.dataDir);
    await run.done;
    expect(run.status, ctx(h, run)).toBe(1);
    expect(run.stderr).toMatch(/does not recognise/);
    expect(run.stderr, "the row is named by its id, never by its raw path").toContain("attachment=esc challenge=task-esc");
    expect(run.stderr).toMatch(/incomplete \(no BACKUP_COMPLETE\) and safe to delete/);
    expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE"))).toBe(false);
  });

  test("H2: a stored value holding a line break or a field separator cannot pass for well-formed rows", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const h = harness("h2");
    const v = scratchVolume(h.T);
    // ONE row whose storage_path spells a whole row, a line break and a second
    // path. Read line by line, it is two rows naming two files that both exist.
    fs.writeFileSync(path.join(v.dataDir, "attachments", "a.zip"), "12345");
    fs.writeFileSync(path.join(v.dataDir, "attachments", "b.zip"), "1234567");
    v.attach("i", "attachments/a.zip\u001f5\u001fi\u001ft\u001fattached\nattachments/b.zip", { file: false, size: 7 });
    const run = startBackup(h, v.dataDir);
    await run.done;
    expect(run.status, `the snapshot's row count is checked against the rows read${ctx(h, run)}`).toBe(1);
    expect(run.stderr).toMatch(/holds 1 task_attachments rows but 2 were read back/);
    expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE"))).toBe(false);

    // …nor a field separator inside a value pass for a shifted row: this one
    // reads as `attachments/x.zip`, size 5, with a plausible state, and only its
    // surplus field gives it away.
    const h3 = harness("h3");
    const v3 = scratchVolume(h3.T);
    fs.writeFileSync(path.join(v3.dataDir, "attachments", "x.zip"), "12345");
    v3.attach("i", "attachments/x.zip\u001f5", { file: false, size: 999, taskId: "attached" });
    const run3 = startBackup(h3, v3.dataDir);
    await run3.done;
    expect(run3.status, `a row with a surplus field is refused${ctx(h3, run3)}`).toBe(1);
    expect(run3.stderr).toMatch(/does not recognise/);
    expect(fs.existsSync(path.join(h3.out, "BACKUP_COMPLETE"))).toBe(false);

    // …nor a value that BEGINS with a line break: read line by line it is an
    // empty line and then one well-formed row naming a file that exists, so
    // the row count agrees. The empty line is a row too, and is refused.
    const h4 = harness("h4");
    const v4 = scratchVolume(h4.T);
    fs.writeFileSync(path.join(v4.dataDir, "attachments", "b.zip"), "1234567");
    v4.attach("i", "\nattachments/b.zip", { file: false, size: 7 });
    const run4 = startBackup(h4, v4.dataDir);
    await run4.done;
    expect(run4.status, `a leading line break is refused${ctx(h4, run4)}`).toBe(1);
    expect(run4.stderr).toMatch(/does not recognise/);
    expect(fs.existsSync(path.join(h4.out, "BACKUP_COMPLETE"))).toBe(false);
  });

  test("stat: a host whose stat cannot report a size refuses rather than counting every file lost", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const h = harness("stat", { brokenStat: true });
    const v = scratchVolume(h.T);
    v.attach("a1", "attachments/a1.zip");
    const run = startBackup(h, v.dataDir);
    await run.done;
    expect(run.status, ctx(h, run)).toBe(1);
    expect(run.stderr).toMatch(/stat cannot report file sizes/);
    expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE"))).toBe(false);
  });

  test("rc: an operator's ~/.sqliterc cannot reshape the script's reads", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const results = [];
    for (const withRc of [false, true]) {
      const T = scratch(`rc-${withRc}`);
      const rc = path.join(T, "sqliterc");
      fs.writeFileSync(rc, ".echo on\n.headers on\n.mode box\n");
      const h = harness(`rc-${withRc}-run`, withRc ? { rc } : {});
      const v = scratchVolume(h.T);
      v.attach("a1", "attachments/a1.zip");
      v.attach("a2", "attachments/lost.zip", { file: false, size: 7 });
      if (withRc) {
        // ANTI-VACUITY: this rc really reshapes a bare read, even under the
        // script's other flags, so a script without `-init /dev/null` would
        // read something other than "1" here.
        const bare = spawnSync(which("sqlite3"), ["-init", rc, "-batch", "-noheader", "-list", path.join(v.dataDir, "hackathon.db"),
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_attachments'"], { encoding: "utf8" });
        expect(bare.stdout.trim(), "the rc reshapes a read that lacks -init /dev/null").not.toBe("1");
      }
      const run = startBackup(h, v.dataDir);
      await run.done;
      const done = kv(path.join(h.out, "BACKUP_COMPLETE"));
      results.push({ withRc, status: run.status, verified: done.attachments_verified, lost: done.attachments_lost_on_live_volume, ctx: ctx(h, run) });
    }
    for (const r of results) {
      expect(r.status, `rc=${r.withRc}${r.ctx}`).toBe(0);
      expect([r.verified, r.lost], `rc=${r.withRc}: one verified, one lost${r.ctx}`).toEqual(["1", "1"]);
    }
  });

  test("P: a sqlite3 error on either table probe aborts the run; it is never read as \"no table\"", async () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    for (const failProbe of [null, "task_attachments", "task_attachments_staging"]) {
      const h = harness(`p-${failProbe}`, { failProbe });
      const v = scratchVolume(h.T);
      v.attach("a1", "attachments/a1.zip");
      v.attach("a2", "attachments/lost.zip", { file: false, size: 7 });
      const run = startBackup(h, v.dataDir);
      await run.done;
      if (!failProbe) {
        // CONTROL: the same volume, read normally, is certified with its loss counted.
        expect(run.status, ctx(h, run)).toBe(0);
        expect(kv(path.join(h.out, "BACKUP_COMPLETE")).attachments_lost_on_live_volume).toBe("1");
      } else {
        expect(h.calls(), `the ${failProbe} probe really ran (and failed)`).toContain(`name='${failProbe}'`);
        expect(run.status, `a failed probe must not certify${ctx(h, run)}`).not.toBe(0);
        expect(fs.existsSync(path.join(h.out, "BACKUP_COMPLETE")), ctx(h, run)).toBe(false);
      }
    }
  });
});

// ── SOURCE (runs everywhere, CI included) ───────────────────────────────────

test("S: the attempt loop, its bounds, its sqlite3 reads and the server's storage-path sinks", () => {
  const code = stripShellComments(fs.readFileSync(SCRIPT, "utf8"));
  const lines = code.split("\n");
  const lineOf = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };
  const fnBody = (name) => (new RegExp(`^${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m").exec(code) || [])[1] || "";

  // The attempt loop, in order: copy A, snapshot, copy B, reconcile, verdict.
  const loopAt = lineOf(/^while :; do\s*$/);
  const loopEnd = lineOf(/^done\s*$/, loopAt);
  expect(loopAt, "the attempt loop exists").toBeGreaterThan(-1);
  expect(loopEnd, "…and closes").toBeGreaterThan(loopAt);
  const order = [
    /^\s*_copy_tree attachments "before the snapshot"\s*$/,
    /^\s*_copy_tree attachments-staging "before the snapshot"\s*$/,
    /^\s*_snapshot_db\s*$/,
    /^\s*_copy_tree attachments "after the snapshot"\s*$/,
    /^\s*_copy_tree attachments-staging "after the snapshot"\s*$/,
    /^\s*_reconcile_attachments\s*$/,
    /^\s*case "\$_VERDICT" in\s*$/,
  ];
  let prev = loopAt;
  for (const re of order) {
    const at = lineOf(re, prev + 1);
    expect(at, `inside the loop, after line ${prev + 1}: ${re}`).toBeGreaterThan(prev);
    expect(at, `${re} is inside the loop`).toBeLessThan(loopEnd);
    prev = at;
  }
  const loop = lines.slice(loopAt, loopEnd + 1).join("\n");
  expect(fnBody("_snapshot_db"), "the snapshot function holds the online backup").toMatch(/^\s*sqlite3 [^\n]*"\$SRC" "\.backup '\$DST'"/m);
  // logs are copied once, after the loop: never before the snapshot.
  expect(lineOf(/^\s*_copy_tree logs\s/), "the logs copy comes after the attempt loop").toBeGreaterThan(loopEnd);

  // The verdicts: retry is bounded, every refusal exits non-zero.
  expect(code).toMatch(/^BACKUP_MAX_ATTEMPTS=[2-5]\s*$/m);
  const branch = (label) => (new RegExp(`^\\s*${label}\\)([\\s\\S]*?);;`, "m").exec(loop) || [])[1] || "";
  expect(branch("ok"), "ok breaks out").toMatch(/^\s*break\s*$/);
  const retry = branch("retry");
  expect(retry, "a retry only while attempts remain").toMatch(/if \[\[ "\$_ATTEMPT" -lt "\$BACKUP_MAX_ATTEMPTS" \]\]; then[\s\S]*?^\s*continue\s*$[\s\S]*?^\s*fi\s*$/m);
  expect(retry, "the exhausted branch refuses").toMatch(/^\s*exit\s+[1-9]\s*$/m);
  expect(branch("refuse"), "a refusal exits non-zero").toMatch(/^\s*exit\s+[1-9]\s*$/m);
  expect(branch("\\*"), "no verdict exits non-zero").toMatch(/^\s*exit\s+[1-9]\s*$/m);

  // The copy helper: rsync's status captured, exactly 24 tolerated, the rest returned.
  const copy = fnBody("_copy_tree");
  expect(copy).toMatch(/^\s*rsync -a "\$DATA_DIR\/\$name\/" "\$OUT_DIR\/\$name\/" \|\| rc=\$\?\s*$/m);
  expect(copy).toMatch(/if \[\[ "\$rc" -eq 24 \]\]; then[\s\S]*?return 0\n\s*fi\n\s*return "\$rc"\s*$/);
  // Outside RESTORE.txt (whose restore recipe is `rsync -a --delete`), the
  // helper's is the ONLY rsync: none bypasses its exit-24 rule, swallows a
  // failure, or deletes.
  const heredoc = /<<RESTORE\n[\s\S]*?\nRESTORE\n/.exec(code);
  expect(heredoc, "the RESTORE.txt heredoc was found").toBeTruthy();
  const rsyncs = code.replace(heredoc[0], "").split("\n").filter((l) => /(^|[\s;&|(])rsync\s/.test(l));
  expect(rsyncs.map((l) => l.trim()), "the only rsync is the copy helper's")
    .toEqual(['rsync -a "$DATA_DIR/$name/" "$OUT_DIR/$name/" || rc=$?']);

  // The reconcile reads the SNAPSHOT's rows, and stats the live file before it
  // asks the live database about the row.
  const rec = fnBody("_reconcile_attachments");
  expect(rec, "rows come from the snapshot").toMatch(/-separator "\$_US" "\$DST" \\\n\s*"SELECT storage_path, size_bytes, id, task_id, CASE/);
  expect(rec, "…read with one field more than they hold, so an extra field is seen").toMatch(/IFS="\$_US" read -r rel size aid tid state extra/);
  expect(code).toMatch(/^_US=\$'\\x1f'\s*$/m);
  // A --reuse directory keeps earlier runs' copies, so a copy the backup holds
  // says nothing about the live volume: every row's live file is stat'ed before
  // the copy can accept the row, and an accepted row whose live file is gone is
  // held for the live-row read (gone with its row, it is the delete race).
  const statAt = rec.search(/^\s*live=gone; _file_is "\$DATA_DIR\/\$rel" "\$size" && live=present\s*$/m);
  const outAt = rec.indexOf('_file_is "$OUT_DIR/$rel"');
  const liveAt = rec.search(/^\s*live_rows="\$\(sqlite3 [^\n]*"\$SRC" "SELECT storage_path FROM task_attachments"\)"\s*$/m);
  expect(statAt, "every row's live file is stat'ed").toBeGreaterThan(-1);
  expect(outAt, "the backup's copy is checked after the live stat").toBeGreaterThan(statAt);
  expect(rec, "no row is accepted on the backup's copy alone").not.toMatch(/_file_is "\$OUT_DIR\/\$rel"[^\n]*&&\s*continue/);
  expect(rec, "an accepted row whose live file is gone is held")
    .toMatch(/^\s*if _file_is "\$OUT_DIR\/\$rel" "\$size"; then\s*\n\s*\[\[ "\$live" == present \]\] \|\| held\+="\$rel\$_US[^\n]*\n\s*continue\s*\n\s*fi\s*$/m);
  expect(liveAt, "the live rows are read after the copy check").toBeGreaterThan(outAt);
  const heldLoop = /^\s*while IFS="\$_US" read -r rel size aid tid state; do\n([\s\S]*?)\n\s*done <<< "\$held"\s*$/m.exec(rec);
  expect(heldLoop, "the held rows are walked").toBeTruthy();
  expect(rec.indexOf(heldLoop[0]), "…after the live rows are read").toBeGreaterThan(liveAt);
  expect(heldLoop[1], "…counted only while the live row remains")
    .toMatch(/^\s*\[\[ -n "\$rel" \]\] && grep -Fxq -- "\$rel" <<< "\$live_rows" \|\| continue\s*$/m);
  expect(heldLoop[1], "…as a loss this backup holds a copy of")
    .toMatch(/^\s*_LOST_COUNT=\$\(\(_LOST_COUNT \+ 1\)\); _LOST_HELD_COUNT=\$\(\(_LOST_HELD_COUNT \+ 1\)\)\s*$/m);
  // A held loss stays verified, yet reaches the WARNING, syslog and both files.
  expect(code).toMatch(/^_LOST_GONE=\$\(\(_LOST_COUNT - _LOST_HELD_COUNT\)\)\s*$/m);
  expect(code).toMatch(/^_VERIFIED=\$\(\(_REF_COUNT - _LOST_GONE\)\)\s*$/m);
  const warnAt = lineOf(/^if \[\[ "\$_LOST_COUNT" -gt 0 \]\]; then\s*$/);
  expect(warnAt, "the WARNING is gated on every loss, held ones included").toBeGreaterThan(-1);
  const warn = lines.slice(warnAt, lineOf(/^fi\s*$/, warnAt) + 1).join("\n");
  expect(warn).toMatch(/^\s*echo "WARNING: \$_LOST_COUNT attachment file/m);
  expect(warn).toMatch(/^\s*logger -t hackarena-backup "WARNING: \$_LOST_COUNT attachment file/m);
  const block = (file) => {
    const end = lineOf(new RegExp(`^\\} > "\\$OUT_DIR/${file}"\\s*$`));
    let start = end; while (start > 0 && !/^\{\s*$/.test(lines[start])) start--;
    expect(end, `the ${file} block was found`).toBeGreaterThan(0);
    return lines.slice(start, end).join("\n");
  };
  expect(block("BACKUP_COMPLETE")).toMatch(/^\s*echo "attachments_verified: \$_VERIFIED"\s*$/m);
  for (const file of ["BACKUP_COMPLETE", "BACKUP_METADATA\\.txt"]) {
    expect(block(file), `${file} counts every loss`).toMatch(/^\s*echo "attachments_lost_on_live_volume: \$_LOST_COUNT"\s*$/m);
  }

  // Every sqlite3 call pins its output format, and every probe is a plain
  // assignment, so an error aborts under set -e rather than reading as "absent".
  const sqliteCalls = lines.filter((l) => /(^|[\s$(;&|])sqlite3\s/.test(l) && !/command -v sqlite3/.test(l) && !/^\s*echo\b/.test(l));
  expect(sqliteCalls.length, `anti-vacuity: sqlite3 calls found:\n${sqliteCalls.join("\n")}`).toBeGreaterThanOrEqual(7);
  for (const l of sqliteCalls) expect(l, "a sqlite3 call without a pinned format").toMatch(/sqlite3 -init \/dev\/null -batch -noheader -list /);
  const probes = lines.filter((l) => /name='task_attachments(?:_staging)?'/.test(l));
  expect(probes.length, "both table probes exist").toBe(2);
  // The whole line is the assignment: nothing after the query (an `|| echo 0`
  // inside the substitution reads a failure as "no table").
  for (const l of probes) expect(l, "a probe must be a plain assignment").toMatch(/^\s*has="\$\(sqlite3 [^|&;]*"\)"\s*$/);
  for (const fn of ["_reconcile_attachments", "_count_staging_without_file"]) {
    expect(fnBody(fn), `${fn} accepts exactly 0 or 1 from its probe`).toMatch(/case "\$has" in\s*\n\s*1\) ;;\s*\n[\s\S]*?^\s*0\)[\s\S]*?^\s*\*\)/m);
  }

  // THE SINKS. The script's path regexes must accept exactly the storage paths
  // the server writes, so every site that writes one is found by what it does —
  // an INSERT into either table, a path join rooted at either directory — and
  // each must be the one accepted shape. A new generator in a new shape fails
  // here at commit time, not as a refused backup at 02:00.
  const sources = ["server.js", "db.js",
    ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`),
    ...fs.readdirSync(path.join(ROOT, "routes")).filter((f) => f.endsWith(".js")).map((f) => `routes/${f}`)];
  const DIRS = ["attachments", "attachments-staging"];
  const count = { attachments: { gen: 0, ins: 0 }, "attachments-staging": { gen: 0, ins: 0 } };
  const bad = [];
  for (const rel of sources) {
    const src = stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    count.attachments.ins += (src.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+task_attachments\s*\(/g) || []).length;
    count["attachments-staging"].ins += (src.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+task_attachments_staging\s*\(/g) || []).length;
    for (const m of src.matchAll(/path(?:\.posix)?\.(?:join|resolve)\(\s*["'`](attachments(?:-staging)?)["'`]\s*,([^)]*)\)/g)) {
      const ok = /^path\.posix\.join\(\s*"(attachments(?:-staging)?)",\s*`\$\{([\w.]+)\}\.zip`\s*\)$/.exec(m[0]);
      const id = ok && ok[2].split(".").pop();
      if (!ok || !new RegExp(`\\b${id}\\s*=\\s*uuid\\(\\)`).test(src)) { bad.push(`${rel}: ${m[0]}`); continue; }
      count[m[1]].gen++;
    }
    for (const m of src.matchAll(/`(?:attachments|attachments-staging)\/|["'](?:attachments|attachments-staging)\/["']\s*\+/g)) bad.push(`${rel}: a storage path built by hand: ${m[0]}`);
    for (const m of src.matchAll(/UPDATE\s+task_attachments(?:_staging)?\s+SET\s+[^"'`]*\bstorage_path\b/g)) bad.push(`${rel}: a storage path rewritten: ${m[0]}`);
  }
  expect(bad, "a storage path the backup's regexes were not decided against").toEqual([]);
  expect(count.attachments.gen, "anti-vacuity: the permanent generators were found").toBeGreaterThanOrEqual(4);
  expect(count["attachments-staging"].gen, "anti-vacuity: the staging generator was found").toBeGreaterThanOrEqual(1);
  for (const d of DIRS) {
    expect(count[d].gen, `${d}: one generator per INSERT site — a row written with a path from elsewhere is unchecked`).toBe(count[d].ins);
  }

  // …and the script's regexes accept exactly that shape.
  const reOf = (name) => {
    const m = new RegExp(`^${name}='([^']+)'\\s*$`, "m").exec(code);
    expect(m, `${name} is defined`).toBeTruthy();
    return new RegExp(m[1]);
  };
  for (const [name, dir, other] of [["_ATT_RE", "attachments", "attachments-staging"], ["_STG_RE", "attachments-staging", "attachments"]]) {
    const re = reOf(name);
    expect(re.test(`${dir}/${crypto.randomUUID()}.zip`), `${name} accepts what the server writes`).toBe(true);
    for (const badPath of ["../x.zip", `${dir}/../x.zip`, `${dir}/sub/x.zip`, `${dir}/..`, `${dir}/.x.zip`, `${dir}/`,
      `${dir}/x.zip|5`, `${dir}/x.zip\u001f5`, `${dir}/x.zip\n`, `/${dir}/x.zip`, `${other}/x.zip`]) {
      expect(re.test(badPath), `${name} must reject ${JSON.stringify(badPath)}`).toBe(false);
    }
  }
});
