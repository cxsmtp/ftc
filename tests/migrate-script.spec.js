// scripts/migrate.sh moves an installation. Its refusals are what stop a mistyped
// path or a bad copy from reaching a volume, so each is driven for real here, as
// is the root owner ladder (sweep #145), on hand-built archives. The real pack →
// copy → unpack round trip (the owner-only archive, the checksum a copied pair
// still passes, the owner a real backup records), the lost+found rule and
// `check` are in tests/migrate-round-trip.spec.js.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "migrate.sh");
const OWNER_ONLY = 0o600;

function put(file, body) {
  const fd = fs.openSync(file, "w", OWNER_ONLY);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
}

function run(args, env = {}) {
  try {
    const r = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: "", UPLOADS_DIR: "", NODE_OPTIONS: "", ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } catch (e) {
    return { status: null, out: String(e) };
  }
}

function sh(cmd, cwd) {
  let r;
  try {
    r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  } catch (e) {
    throw new Error(`${cmd}: ${e}`);
  }
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
}

// A finished backup, packed and checksummed the way pack leaves it.
function makeArchive(root, { complete = true, db = "database bytes", meta = "old server metadata" } = {}) {
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "attachments"), { recursive: true, mode: 0o700 });
  put(path.join(src, "hackathon.db"), db);
  put(path.join(src, ".unsubscribe-secret"), "secret");
  put(path.join(src, "attachments", "a.zip"), "zip");
  put(path.join(src, "RESTORE.txt"), "old server notes");
  put(path.join(src, "BACKUP_METADATA.txt"), meta);
  if (complete) put(path.join(src, "BACKUP_COMPLETE"), "ok");
  sh(`tar -czf move.tar.gz -C src . && sha256sum move.tar.gz > move.tar.gz.sha256`, root);
  return path.join(root, "move.tar.gz");
}

// Sweep #145 — as root, unpack hands the data to an owner it can name. Every
// answer the script asks the system is stubbed on PATH, so an arm means the same
// run as a user or (the CI image) as root: `id -u` answers `uid`, `stat` the
// prepared directory's owner, and `chown` records its arguments instead of
// acting. Nothing is chowned for real.
function rootStubs(root, { uid = 0, statOwner = null } = {}) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const calls = path.join(root, "chown.calls");
  // `id -u` alone is the runner's uid; `id -u -- <name>` still asks the system.
  fs.writeFileSync(path.join(bin, "id"), `#!/bin/sh\n[ "$1" = -u ] && [ $# -eq 1 ] && { echo ${uid}; exit 0; }\nexec /usr/bin/id "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "chown"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`, { mode: 0o700 });
  if (statOwner) fs.writeFileSync(path.join(bin, "stat"), `#!/bin/sh\necho ${statOwner}\n`, { mode: 0o700 });
  return { PATH: `${bin}:${process.env.PATH}`, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : null) };
}

test.describe("scripts/migrate.sh", () => {
  let root;
  test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-move-")); });
  test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test("pack and unpack refuse with no DATA_DIR", () => {
    for (const verb of ["pack", "unpack"]) {
      const r = run([verb, path.join(root, "x.tar.gz")]);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("DATA_DIR is required");
    }
  });

  test("pack refuses a directory that is not the data volume, and an archive that exists", () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty, { mode: 0o700 });
    const r = run(["pack", path.join(root, "x.tar.gz")], { DATA_DIR: empty });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("hackathon.db not found");

    const taken = path.join(root, "taken.tar.gz");
    put(taken, "precious");
    const r2 = run(["pack", taken], { DATA_DIR: empty });
    expect(r2.status, r2.out).toBe(1);
    expect(r2.out).toContain("already exists");
    expect(fs.readFileSync(taken, "utf8")).toBe("precious");
  });

  test("unpack fills an empty volume with the data and not the backup's own papers", () => {
    const target = path.join(root, "data");
    const r = run(["unpack", makeArchive(root)], { DATA_DIR: target });
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(path.join(target, "hackathon.db"), "utf8")).toBe("database bytes");
    expect(fs.readFileSync(path.join(target, ".unsubscribe-secret"), "utf8")).toBe("secret");
    expect(fs.readFileSync(path.join(target, "attachments", "a.zip"), "utf8")).toBe("zip");
    for (const paper of ["BACKUP_COMPLETE", "BACKUP_METADATA.txt", "RESTORE.txt"]) {
      expect(fs.existsSync(path.join(target, paper)), paper).toBe(false);
    }
  });

  test("unpack refuses a volume holding anything, and touches nothing in it", () => {
    const archive = makeArchive(root);
    const target = path.join(root, "live");
    fs.mkdirSync(target, { mode: 0o700 });
    put(path.join(target, "hackathon.db"), "the live database");
    const r = run(["unpack", archive], { DATA_DIR: target });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("is not empty");
    expect(fs.readFileSync(path.join(target, "hackathon.db"), "utf8")).toBe("the live database");
    expect(fs.readdirSync(target)).toEqual(["hackathon.db"]);
  });

  test("unpack refuses a damaged copy and a missing checksum", () => {
    const archive = makeArchive(root);
    const target = path.join(root, "data");
    fs.appendFileSync(archive, "x", { mode: OWNER_ONLY });
    const r = run(["unpack", archive], { DATA_DIR: target });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("checksum does not match");
    expect(fs.existsSync(path.join(target, "hackathon.db"))).toBe(false);

    fs.rmSync(`${archive}.sha256`);
    const r2 = run(["unpack", archive], { DATA_DIR: target });
    expect(r2.status, r2.out).toBe(1);
    expect(r2.out).toContain(".sha256 not found");
  });

  test("unpack refuses an unfinished backup and an archive with no database", () => {
    const target = path.join(root, "data");
    const r = run(["unpack", makeArchive(root, { complete: false })], { DATA_DIR: target });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("BACKUP_COMPLETE");
    expect(fs.existsSync(path.join(target, "hackathon.db"))).toBe(false);

    const root2 = path.join(root, "second");
    fs.mkdirSync(root2, { mode: 0o700 });
    const r2 = run(["unpack", makeArchive(root2, { db: "" })], { DATA_DIR: target });
    expect(r2.status, r2.out).toBe(1);
    expect(r2.out).toContain("no database");
    expect(fs.existsSync(path.join(target, "hackathon.db"))).toBe(false);
  });

  test("unpack refuses an archive naming a path outside the volume", () => {
    const target = path.join(root, "data");
    const src = path.join(root, "src");
    fs.mkdirSync(src, { mode: 0o700 });
    put(path.join(src, "evil"), "x");
    sh(`tar -czf move.tar.gz --transform='s,^src/evil,../evil,' src/evil && sha256sum move.tar.gz > move.tar.gz.sha256`, root);
    const r = run(["unpack", path.join(root, "move.tar.gz")], { DATA_DIR: target });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("unsafe path");
    expect(fs.existsSync(path.join(root, "evil"))).toBe(false);
  });

  test("sweep #145: as root, MIGRATE_OWNER wins over a prepared directory and the recorded owner", () => {
    const target = path.join(root, "data");
    fs.mkdirSync(target, { mode: 0o700 });
    const stub = rootStubs(root, { statOwner: "3131:3132" });   // a usable prepared owner, whoever runs this
    const r = run(["unpack", makeArchive(root, { meta: "data_dir_owner: 4242:4243\n" })], { DATA_DIR: target, PATH: stub.PATH, MIGRATE_OWNER: "5151:5152" });
    expect(r.status, r.out).toBe(0);
    expect(stub.calls()).toBe(`-R 5151:5152 -- ${target}\n`);
    expect(r.out).toContain("Owner 5151:5152 (MIGRATE_OWNER)");
  });

  test("sweep #145: a DATA_DIR prepared before the unpack gives its owner; one the unpack makes takes the recorded owner (CONTROL)", () => {
    const target = path.join(root, "data");
    fs.mkdirSync(target, { mode: 0o700 });
    const stub = rootStubs(root, { statOwner: "3131:3132" });
    const archive = makeArchive(root, { meta: "data_dir_owner: 4242:4243\n" });
    let r = run(["unpack", archive], { DATA_DIR: target, PATH: stub.PATH });
    expect(r.status, r.out).toBe(0);
    expect(stub.calls()).toBe(`-R 3131:3132 -- ${target}\n`);
    expect(r.out, "and says why").toContain(`Owner 3131:3132 (the owner of ${target} before the unpack)`);
    // CONTROL: a target the unpack makes is not taken for a prepared one.
    const fresh = path.join(root, "fresh");
    fs.rmSync(path.join(root, "chown.calls"), { force: true });
    r = run(["unpack", archive], { DATA_DIR: fresh, PATH: stub.PATH });
    expect(r.status, r.out).toBe(0);
    expect(stub.calls()).toBe(`-R 4242:4243 -- ${fresh}\n`);
    expect(r.out).toContain("(the owner recorded on the old server)");
  });

  test("sweep #145: the recorded owner is used when nothing else names one; an unusable record falls back to the image's user", () => {
    const stub = rootStubs(root);
    const target = path.join(root, "rec");
    let r = run(["unpack", makeArchive(root, { meta: "taken: x\ndata_dir_owner: 4242:4243\n" })], { DATA_DIR: target, PATH: stub.PATH });
    expect(r.status, r.out).toBe(0);
    expect(stub.calls()).toBe(`-R 4242:4243 -- ${target}\n`);
    expect(fs.existsSync(path.join(target, "BACKUP_METADATA.txt")), "the backup's papers are still left out").toBe(false);
    let n = 0;
    for (const meta of ["data_dir_owner: unknown\n", "data_dir_owner: 4242:4243; rm -rf /\n", "data_dir_owner: 0:0\n", "nothing about owners\n"]) {
      const sub = path.join(root, `case${n}`);
      fs.mkdirSync(sub, { mode: 0o700 });
      const t = path.join(sub, "data");
      fs.rmSync(path.join(root, "chown.calls"), { force: true });
      fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
      fs.rmSync(path.join(root, "move.tar.gz"), { force: true });
      fs.rmSync(path.join(root, "move.tar.gz.sha256"), { force: true });
      r = run(["unpack", makeArchive(root, { meta })], { DATA_DIR: t, PATH: stub.PATH });
      expect(r.status, `${meta}: ${r.out}`).toBe(0);
      expect(stub.calls(), `${JSON.stringify(meta)}: the image's user`).toBe(`-R 1000:1000 -- ${t}\n`);
      expect(r.out).toContain("(the shipped image's user; nothing else named one)");
      n++;
    }
  });

  test("sweep #145: a root-owned prepared directory says nothing about the server: the recorded owner is used", () => {
    const target = path.join(root, "data");
    fs.mkdirSync(target, { mode: 0o700 });
    const stub = rootStubs(root, { statOwner: "0:0" });
    const r = run(["unpack", makeArchive(root, { meta: "data_dir_owner: 4242:4243\n" })], { DATA_DIR: target, PATH: stub.PATH });
    expect(r.status, r.out).toBe(0);
    expect(stub.calls()).toBe(`-R 4242:4243 -- ${target}\n`);
  });

  test("sweep #145: not root, nothing is chowned and no owner is claimed; a malformed MIGRATE_OWNER is refused before anything is written", () => {
    const stub = rootStubs(root, { uid: 1000 });   // not root
    const bin = path.join(root, "bin");
    const target = path.join(root, "data");
    let r = run(["unpack", makeArchive(root)], { DATA_DIR: target, PATH: stub.PATH });
    expect(r.status, r.out).toBe(0);
    expect(stub.calls(), "nothing chowned").toBe(null);
    expect(r.out).not.toContain("Owner ");
    // A malformed override, as root: refused, the volume never made.
    fs.writeFileSync(path.join(bin, "id"), '#!/bin/sh\n[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n', { mode: 0o700 });   // now root
    const other = path.join(root, "other");
    r = run(["unpack", path.join(root, "move.tar.gz")], { DATA_DIR: other, PATH: stub.PATH, MIGRATE_OWNER: "a b" });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("MIGRATE_OWNER must be <user>:<group> or <uid>:<gid>");
    expect(fs.existsSync(other), "nothing written").toBe(false);
    expect(stub.calls(), "nothing chowned").toBe(null);
  });

  test("sweep #145: --help names MIGRATE_OWNER", () => {
    const r = run(["--help"]);
    expect(r.out).toContain("MIGRATE_OWNER=<uid>:<gid>");
    expect(r.out, "CONTROL: the help still ends with the requirements").toContain("sha256sum; check, curl.");
  });

  test("sweep #145: a MIGRATE_OWNER naming a user or group this host does not have is refused before anything is written; one it has is used (CONTROL)", () => {
    const stub = rootStubs(root);
    const archive = makeArchive(root);
    for (const [owner, says] of [["nosuchuser929x:nosuchgroup929x", "names no user on this host: nosuchuser929x"], ["root:nosuchgroup929x", "names no group on this host: nosuchgroup929x"]]) {
      const t = path.join(root, `t-${owner.replace(/[^a-z0-9]/gi, "")}`);
      const r = run(["unpack", archive], { DATA_DIR: t, PATH: stub.PATH, MIGRATE_OWNER: owner });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(says);
      expect(fs.existsSync(t), `${owner}: nothing written`).toBe(false);
      expect(stub.calls(), `${owner}: nothing chowned`).toBe(null);
    }
    const ok = path.join(root, "ok");
    const r = run(["unpack", archive], { DATA_DIR: ok, PATH: stub.PATH, MIGRATE_OWNER: "root:root" });
    expect(r.status, `CONTROL: a user and group the host has: ${r.out}`).toBe(0);
    expect(stub.calls()).toBe(`-R root:root -- ${ok}\n`);
  });
});

