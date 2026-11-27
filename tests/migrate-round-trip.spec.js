// @ts-check
//
// scripts/migrate.sh, driven for real (sweep gap #144). tests/migrate-script.spec.js
// holds the refusals and the root owner ladder on hand-built archives; this file
// holds what only a real pack, a move and an unpack show:
//
//   * PACK writes the archive and its checksum readable by their owner only,
//     whatever umask the caller has (the archive holds the database and both HMAC
//     secrets), packs a backup.sh run that certified itself (BACKUP_COMPLETE, the
//     attachment its database names verified), and leaves no working copy of the
//     data beside the archive;
//   * the checksum names the archive by its BASE name, so the pair still checks
//     out once moved to another directory, which is what a move does;
//   * UNPACK of that archive restores the database byte for byte (the backup's
//     snapshot), the attachment file, the logs and both secrets, and leaves out
//     the backup's own papers and the files backup.sh exempts. The restored
//     files' modes are NOT asserted: they follow tar, which keeps the modes the
//     archive recorded when root runs it (the documented sudo, and the CI image)
//     and applies the script's umask 077 for anyone else. Only the archive's and
//     its checksum's own modes are promised;
//   * as root, the owner the REAL backup recorded is the one the data is handed to
//     (the hand-built arms of the other file write that metadata themselves);
//   * a volume holding only `lost+found` (a fresh filesystem's root) counts as
//     empty; `lost+found` beside anything else, or a name that only resembles it,
//     does not, and nothing in such a volume is touched;
//   * CHECK answers ready only on a body carrying "ready":true, keeps asking while
//     the server answers anything else or nothing, gives up after the tries it was
//     given naming the last answer, and reads the real /readyz of a running server.
//
// Where a test decides what the script asks the system (curl, sleep, `id -u`,
// chown, the owner `stat` reports), the command is stubbed on PATH, so nothing
// waits and no arm needs root. The arms that leave `id` alone run the script as
// whoever runs the suite: as root (the CI image) their unpack also chowns its own
// scratch volume, which they never read as another user. pack needs sqlite3 and
// rsync (backup.sh): the CI image carries both; a runner without them skips
// those arms by name, as it does the real-curl arm without curl.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const SCRIPT = path.join(__dirname, "..", "scripts", "migrate.sh");
const which = (bin) => (spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout || "").trim();
const HAVE_TOOLS = Boolean(which("sqlite3") && which("rsync"));
const NO_TOOLS = "this runner has no sqlite3/rsync, so pack (scripts/backup.sh) cannot run";
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const modeOf = (p) => fs.lstatSync(p).mode & 0o777;

/**
 * Run migrate.sh under a given umask (the caller's, which `umask 077` must
 * override). Every directory the script may read comes from `env`; the worker's
 * own DATA_DIR and UPLOADS_DIR never reach it.
 */
function run(args, env = {}, { umask = "022" } = {}) {
  const r = spawnSync("bash", ["-c", `umask ${umask}; exec bash "$0" "$@"`, SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: "", UPLOADS_DIR: "", NODE_OPTIONS: "", LC_ALL: "C", ...env },
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error) : ""}` };
}

function sh(cmd, cwd) {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "buffer" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr && r.stderr.toString()}`);
  return r.stdout;
}

/** Every path under `dir` (directories included), relative, sorted. */
function walk(dir, rel = "") {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const p = path.join(rel, name);
    out.push(p);
    if (fs.lstatSync(path.join(dir, p)).isDirectory()) out.push(...walk(dir, p));
  }
  return out;
}

/** A bin directory of stubs on PATH; `files` maps a command name to its script. */
function stubs(root, name, files) {
  const bin = path.join(root, name);
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const [cmd, body] of Object.entries(files)) fs.writeFileSync(path.join(bin, cmd), body, { mode: 0o700 });
  return `${bin}:${process.env.PATH}`;
}

/**
 * The old server's data volume, laid out the way the platform leaves it. Some of
 * it is group/world-readable (the volume itself, the database, a secret), as a
 * volume an operator prepared may be (db.js never changes an existing file's
 * mode); no assertion reads those modes. In particular they cannot decide the
 * archive's mode: pack creates the archive and its checksum itself (tar -czf, a
 * shell redirect), so their modes come from the process umask alone, and run()
 * starts the script under a 022 umask that only the script's own `umask 077` can
 * override. The database names one attachment by path and size, as
 * task_attachments rows do, so backup.sh's check has something to verify.
 */
function oldVolume(root) {
  const vol = path.join(root, "old-server", "data");
  fs.mkdirSync(path.join(vol, "attachments"), { recursive: true });
  fs.mkdirSync(path.join(vol, "logs"), { recursive: true });
  const attName = `${crypto.randomUUID()}.zip`;
  const att = crypto.randomBytes(3000);
  fs.writeFileSync(path.join(vol, "attachments", attName), att, { mode: 0o644 });
  const log = Buffer.from(`{"msg":"old server ${crypto.randomUUID()}"}\n`);
  fs.writeFileSync(path.join(vol, "logs", "app-2026-11-20.jsonl"), log, { mode: 0o644 });
  const marker = `moved-${crypto.randomBytes(8).toString("hex")}`;
  const db = new Database(path.join(vol, "hackathon.db"));
  try {
    db.exec("CREATE TABLE marker (v TEXT NOT NULL)");
    db.exec("CREATE TABLE task_attachments (id TEXT PRIMARY KEY, task_id TEXT, storage_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, detached_at TEXT)");
    db.prepare("INSERT INTO marker (v) VALUES (?)").run(marker);
    db.prepare("INSERT INTO task_attachments (id, task_id, storage_path, size_bytes) VALUES (?,?,?,?)")
      .run("att-1", "task-1", `attachments/${attName}`, att.length);
  } finally { db.close(); }
  const unsub = crypto.randomBytes(32), grading = crypto.randomBytes(32);
  fs.writeFileSync(path.join(vol, ".unsubscribe-secret"), unsub, { mode: 0o644 });
  fs.writeFileSync(path.join(vol, ".grading-secret"), grading, { mode: 0o600 });
  // backup.sh's exempt files: a move must not carry them (RESTORE.txt says why).
  fs.writeFileSync(path.join(vol, ".superadmin-password"), "stale-old-server-password", { mode: 0o600 });
  fs.writeFileSync(path.join(vol, ".maintenance"), "old-bypass-token", { mode: 0o600 });
  for (const p of [vol, path.join(vol, "attachments"), path.join(vol, "logs")]) fs.chmodSync(p, 0o755);
  fs.chmodSync(path.join(vol, "hackathon.db"), 0o644);
  return { vol, attName, att, log, marker, unsub, grading };
}

/** pack `vol` into <root>/out/move.tar.gz; returns the archive's path and the run. */
function pack(root, vol, extraEnv = {}) {
  const out = path.join(root, "out");
  fs.mkdirSync(out, { recursive: true, mode: 0o755 });
  const archive = path.join(out, "move.tar.gz");
  const r = run(["pack", archive], { DATA_DIR: vol, ...extraEnv });
  return { archive, out, r };
}

/** A finished backup packed by hand, the way pack leaves one (no tools needed). */
function handArchive(root) {
  const src = path.join(root, "hand-src");
  fs.mkdirSync(src, { recursive: true, mode: 0o700 });
  const db = `database ${crypto.randomUUID()}`;
  fs.writeFileSync(path.join(src, "hackathon.db"), db, { mode: 0o600 });
  fs.writeFileSync(path.join(src, "BACKUP_METADATA.txt"), "data_dir_owner: unknown\n", { mode: 0o600 });
  fs.writeFileSync(path.join(src, "BACKUP_COMPLETE"), "completed_at: now\n", { mode: 0o600 });
  sh("tar -czf hand.tar.gz -C hand-src . && sha256sum hand.tar.gz > hand.tar.gz.sha256", root);
  return { archive: path.join(root, "hand.tar.gz"), db };
}

test.describe("scripts/migrate.sh — a real move", () => {
  let root;
  test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-move-rt-")); });
  test.afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test("pack writes an owner-only archive and checksum of a certified backup, whatever the caller's umask, and leaves no copy of the data behind", () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const old = oldVolume(root);
    const { archive, out, r } = pack(root, old.vol);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Packed ${archive}`);
    // The archive holds the database and both HMAC secrets: its owner's alone,
    // and so is the checksum, though the caller's umask (022) would give 0644.
    expect(modeOf(archive), "the archive is owner-only").toBe(0o600);
    expect(modeOf(`${archive}.sha256`), "the checksum is owner-only").toBe(0o600);
    // No working copy (pack's .arena-move.* holds the whole backup) is left beside it.
    expect(fs.readdirSync(out).sort(), "only the archive and its checksum remain").toEqual(["move.tar.gz", "move.tar.gz.sha256"]);
    // The checksum names the archive by its base name, so the pair checks out
    // wherever it is copied to (unpack runs sha256sum -c from the archive's folder).
    expect(fs.readFileSync(`${archive}.sha256`, "utf8")).toBe(`${sha256(fs.readFileSync(archive))}  move.tar.gz\n`);

    const members = sh(`tar -tzf ${shq(archive)}`).toString("utf8").split("\n").filter(Boolean);
    expect(members.filter((m) => !m.startsWith("./")), "every member is relative to the backup's root").toEqual([]);
    for (const m of ["./hackathon.db", "./BACKUP_COMPLETE", "./BACKUP_METADATA.txt", "./RESTORE.txt",
      `./attachments/${old.attName}`, "./logs/app-2026-11-20.jsonl", "./.unsubscribe-secret", "./.grading-secret"]) {
      expect(members, `the archive carries ${m}`).toContain(m);
    }
    for (const m of ["./.superadmin-password", "./.maintenance"]) expect(members, `the archive leaves out ${m}`).not.toContain(m);
    // It packed a backup that certified itself, the attachment included.
    const complete = sh(`tar -xOzf ${shq(archive)} ./BACKUP_COMPLETE`).toString("utf8");
    expect(complete).toMatch(/^attachments_verified: 1$/m);
    expect(complete).toMatch(/^attachments_lost_on_live_volume: 0$/m);
  });

  test("unpack of a real pack, moved to another directory, restores the data byte for byte without the backup's papers", () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const old = oldVolume(root);
    const { archive, r: packed } = pack(root, old.vol);
    expect(packed.status, packed.out).toBe(0);
    // The move: the archive and its checksum, carried to the new server. Moved,
    // not copied: the old server's path does not exist there, so a checksum
    // that named it would fail the unpack.
    const nu = path.join(root, "new-server");
    fs.mkdirSync(nu, { mode: 0o755 });
    const moved = path.join(nu, "move.tar.gz");
    fs.renameSync(archive, moved);
    fs.renameSync(`${archive}.sha256`, `${moved}.sha256`);
    const target = path.join(nu, "data");
    const r = run(["unpack", moved], { DATA_DIR: target });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Restored into ${target}.`);

    // The database is the backup's snapshot, unchanged, and it is the old one.
    const snapshot = sh(`tar -xOzf ${shq(moved)} ./hackathon.db`);
    expect(sha256(fs.readFileSync(path.join(target, "hackathon.db"))), "the restored database is the snapshot, byte for byte").toBe(sha256(snapshot));
    const db = new Database(path.join(target, "hackathon.db"), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT v FROM marker").all().map((x) => x.v)).toEqual([old.marker]);
      expect(db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    } finally { db.close(); }
    expect(fs.readFileSync(path.join(target, "attachments", old.attName)).equals(old.att), "the attachment file").toBe(true);
    expect(fs.readFileSync(path.join(target, "logs", "app-2026-11-20.jsonl")).equals(old.log), "the logs").toBe(true);
    expect(fs.readFileSync(path.join(target, ".unsubscribe-secret")).equals(old.unsub), "the unsubscribe secret").toBe(true);
    expect(fs.readFileSync(path.join(target, ".grading-secret")).equals(old.grading), "the grading secret").toBe(true);

    // Exactly the data: no paper of the backup's, no exempt file, no journal.
    expect(walk(target).sort()).toEqual([
      ".grading-secret", ".unsubscribe-secret", "attachments", `attachments/${old.attName}`, "hackathon.db", "logs", "logs/app-2026-11-20.jsonl",
    ].sort());
    // Its working copy is gone too.
    expect(fs.readdirSync(nu).sort()).toEqual(["data", "move.tar.gz", "move.tar.gz.sha256"]);
  });

  test("as root, unpack hands a real backup's data to the owner that backup recorded on the old server", () => {
    test.skip(!HAVE_TOOLS, NO_TOOLS);
    const old = oldVolume(root);
    // pack, with the old volume's owner pinned (stat answers it for '%u:%g' only;
    // every size backup.sh asks for still comes from the real stat).
    const realStat = which("stat");
    const packPath = stubs(root, "pack-bin", {
      stat: `#!/bin/sh\ncase "$*" in *%u:%g*) echo 4242:4243; exit 0 ;; esac\nexec ${shq(realStat)} "$@"\n`,
    });
    const { archive, r: packed } = pack(root, old.vol, { PATH: packPath });
    expect(packed.status, packed.out).toBe(0);
    expect(sh(`tar -xOzf ${shq(archive)} ./BACKUP_METADATA.txt`).toString("utf8"), "PRECONDITION: the backup recorded the old owner")
      .toMatch(/^data_dir_owner: 4242:4243$/m);
    // unpack as root: `id -u` answers 0, chown records instead of acting.
    const calls = path.join(root, "chown.calls");
    const unpackPath = stubs(root, "unpack-bin", {
      id: `#!/bin/sh\n[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }\nexec ${shq(which("id"))} "$@"\n`,
      chown: `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(calls)}\nexit 0\n`,
    });
    const target = path.join(root, "new-server", "data");
    const r = run(["unpack", archive], { DATA_DIR: target, PATH: unpackPath });
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(calls, "utf8"), "the data goes to the recorded owner").toBe(`-R 4242:4243 -- ${target}\n`);
    expect(r.out).toContain("Owner 4242:4243 (the owner recorded on the old server)");
    expect(fs.existsSync(path.join(target, "hackathon.db")), "and the data is there").toBe(true);
  });

  test("pack refuses a backup that did not certify itself and packs nothing", () => {
    // A copy of the script beside a backup.sh that exits 0 without writing
    // BACKUP_COMPLETE (an interrupted or refused run that still returned success):
    // pack runs the backup.sh next to itself.
    const scripts = path.join(root, "scripts");
    fs.mkdirSync(scripts, { mode: 0o700 });
    fs.copyFileSync(SCRIPT, path.join(scripts, "migrate.sh"));
    fs.writeFileSync(path.join(scripts, "backup.sh"),
      '#!/usr/bin/env bash\nset -eu\nmkdir -p "$1"\nprintf x > "$1/hackathon.db"\nexit 0\n', { mode: 0o700 });
    const vol = path.join(root, "vol");
    fs.mkdirSync(vol, { mode: 0o700 });
    fs.writeFileSync(path.join(vol, "hackathon.db"), "db", { mode: 0o600 });
    const out = path.join(root, "out");
    fs.mkdirSync(out, { mode: 0o700 });
    const r = spawnSync("bash", [path.join(scripts, "migrate.sh"), "pack", path.join(out, "move.tar.gz")], {
      encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: vol, UPLOADS_DIR: "", NODE_OPTIONS: "", LC_ALL: "C" },
    });
    const text = `${r.stdout}${r.stderr}`;
    expect(r.status, text).toBe(1);
    expect(text).toContain("the backup did not finish; nothing was packed");
    expect(fs.readdirSync(out), "no archive, no checksum, no working copy").toEqual([]);
  });

  test("a volume holding only lost+found is empty; lost+found beside anything, or a name like it, is not, and stays untouched", () => {
    const { archive, db } = handArchive(root);
    // A fresh filesystem's root: only lost+found. It is filled, and lost+found stays.
    const fresh = path.join(root, "fresh-mount");
    fs.mkdirSync(path.join(fresh, "lost+found"), { recursive: true, mode: 0o700 });
    let r = run(["unpack", archive], { DATA_DIR: fresh });
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(path.join(fresh, "hackathon.db"), "utf8")).toBe(db);
    expect(fs.readdirSync(fresh).sort()).toEqual(["hackathon.db", "lost+found"]);

    // lost+found beside a file, and names that only resemble it: refused, untouched.
    for (const [label, entries] of [
      ["lost+found beside a file", ["lost+found/", "notes.txt"]],
      ["a lost+found.old directory alone", ["lost+found.old/"]],
      ["a file named old-lost+found alone", ["old-lost+found"]],
    ]) {
      const t = path.join(root, `t-${label.replace(/[^a-z]/gi, "")}`);
      fs.mkdirSync(t, { mode: 0o700 });
      for (const e of entries) {
        if (e.endsWith("/")) fs.mkdirSync(path.join(t, e), { mode: 0o700 });
        else fs.writeFileSync(path.join(t, e), `keep ${label}`, { mode: 0o600 });
      }
      const before = walk(t);
      r = run(["unpack", archive], { DATA_DIR: t });
      expect(r.status, `${label}: ${r.out}`).toBe(1);
      expect(r.out, label).toContain("is not empty");
      expect(walk(t), `${label}: nothing written`).toEqual(before);
      for (const e of entries.filter((x) => !x.endsWith("/"))) {
        expect(fs.readFileSync(path.join(t, e), "utf8"), `${label}: ${e} untouched`).toBe(`keep ${label}`);
      }
    }
  });
});

test.describe("scripts/migrate.sh check", () => {
  let root;
  test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-move-check-")); });
  test.afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  /**
   * curl answers from `answers` in order (the last one repeats), recording its
   * arguments; sleep records instead of sleeping. Returns the PATH and readers.
   */
  function checkStubs(answers) {
    const log = path.join(root, "curl.log"), n = path.join(root, "curl.n"), slept = path.join(root, "sleep.log");
    const arm = (a) => `printf '%s' ${shq(a.body)}; exit ${a.code}`;
    const cases = answers.map((a, i) => `  ${i + 1}) ${arm(a)} ;;`).join("\n");
    const PATH = stubs(root, "bin", {
      curl: `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(log)}\nc=$(( $(cat ${shq(n)} 2>/dev/null || echo 0) + 1 ))\necho "$c" > ${shq(n)}\ncase "$c" in\n${cases}\n  *) ${arm(answers[answers.length - 1])} ;;\nesac\n`,
      sleep: `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(slept)}\nexit 0\n`,
    });
    const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
    return { PATH, curls: () => lines(log), sleeps: () => lines(slept) };
  }

  test("it waits through no answer and a not-ready answer, then reports the ready body; the address's trailing slash is dropped", () => {
    const s = checkStubs([
      { code: 7, body: "" },                                           // nothing listening yet
      { code: 0, body: '{"ready":false,"reason":"maintenance"}' },    // up, not ready
      { code: 0, body: '{"ready":true}' },
    ]);
    const r = run(["check", "http://127.0.0.1:3000/"], { PATH: s.PATH });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('Ready: {"ready":true}');
    expect(s.curls(), "three asks, each of /readyz with a deadline").toEqual(Array(3).fill("-s --max-time 5 http://127.0.0.1:3000/readyz"));
    expect(s.sleeps(), "five seconds between asks, none after the answer").toEqual(["5", "5"]);
  });

  test("an answer that only resembles ready is not ready; it gives up after the tries it was given, naming the last answer", () => {
    const s = checkStubs([
      { code: 0, body: '{"not_ready":true}' },
      { code: 0, body: '{"ready":false,"reason":"db_schema"}' },
    ]);
    const r = run(["check", "http://127.0.0.1:3000", "3"], { PATH: s.PATH });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('not ready after 15 seconds; last answer: {"ready":false,"reason":"db_schema"}');
    expect(r.out, "a lookalike is never reported ready").not.toContain("Ready:");
    expect(s.curls().length, "exactly the tries it was given").toBe(3);
    expect(s.sleeps()).toEqual(["5", "5", "5"]);
    // No answer at all is named as none.
    const quiet = checkStubs([{ code: 7, body: "" }]);
    fs.rmSync(path.join(root, "curl.n"), { force: true });
    const r2 = run(["check", "http://127.0.0.1:3000", "1"], { PATH: quiet.PATH });
    expect(r2.status, r2.out).toBe(1);
    expect(r2.out).toContain("not ready after 5 seconds; last answer: none.");
  });

  test("it reads a running server's real /readyz as ready (the worker's own server), and no server as not ready", () => {
    test.skip(!which("curl"), "this runner has no curl, which check runs");
    // The real curl and the real body: the script's match must fit what the
    // server actually sends, which no stub can show. sleep is stubbed only so
    // the refused arm does not wait.
    const PATH = stubs(root, "bin", { sleep: "#!/bin/sh\nexit 0\n" });
    const r = run(["check", BASE, "3"], { PATH });
    expect(r.status, r.out).toBe(0);
    expect(r.out.trim()).toBe('Ready: {"ready":true}');
    // CONTROL: nothing listens on port 1, so nothing is ready there.
    const r2 = run(["check", "http://127.0.0.1:1", "2"], { PATH });
    expect(r2.status, r2.out).toBe(1);
    expect(r2.out).toContain("not ready after 10 seconds; last answer: none.");
  });
});
