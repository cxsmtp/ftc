// @ts-check
// v8.13.4 — THE RUNTIME IMAGE CARRIES NO BUILD RESIDUE, AND WHAT IT KEEPS IS
// DECIDED BY THE LOADERS.
//
// scripts/prune-runtime-deps.cjs runs in the Dockerfile's build stage after
// `npm ci --omit=dev` and deletes what the native addons were built FROM or
// could have been built into — the SQLite amalgamation, the C++ sources, the
// gyp/Makefile files, node-addon-api's headers, gyp's output directory — and the
// prebuilt binaries for every platform but this one. CI has no docker, so the
// image build cannot run here; what CAN run is the script itself, against a
// temporary copy of this checkout's production dependency tree (the lockfile's
// non-dev packages, copied out of node_modules). Two things follow from that,
// and both are deliberate:
//
//   - NOTHING HERE TOUCHES THE REAL node_modules. It is a developer's tree (or,
//     on CI, a symlink into the image's /ci-deps), and the suite loads its
//     binaries — pruning it would delete the musl prebuild a Docs-hygiene
//     witness reads, and the glibc one every test server loads.
//   - NOTHING HERE HARD-CODES A LIBC OR AN ARCH. The developer box and CI are
//     glibc, the image is musl; the script keeps whatever the loaders choose,
//     so every expectation comes from an INDEPENDENT probe (this file's own,
//     not the script's) run against the same tree. A "keep linuxmusl-*" rule
//     would pass in the image and fail here, which is the point.
//
// The fail-closed arms are the half that matters for an operator: a dependency
// bump that brings a new native package or build input must STOP the image
// build with the package named, never quietly ship a tree missing a binary.
// Each refusal is asserted to have deleted NOTHING — the script decides every
// file before it removes the first one.
//
// Children are node processes that DECIDE their DATA_DIR and UPLOADS_DIR
// (deleted: neither the script nor the probe opens the app's database) and pin
// NODE_OPTIONS, because each assertion is on a child's exit code.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "prune-runtime-deps.cjs");
// The script's own list, read from its source — a copy here would agree with the
// script on the day it was written and lag it afterwards (the first draft did).
const BUILD_INPUT_SRC = /const BUILD_INPUT = (\/.+\/);/.exec(fs.readFileSync(SCRIPT, "utf8"))[1];
const BUILD_INPUT = new Function(`return ${BUILD_INPUT_SRC};`)();
const TABLE_PACKAGES = ["better-sqlite3", "bcrypt", "node-addon-api"];

let WORK = "";        // this file's scratch root
let PRISTINE = "";    // <WORK>/pristine/node_modules — the production tree, never pruned

// The production dependency tree: every non-dev, top-level package the lockfile
// names that this install actually has (optional platform packages for other
// platforms are absent, exactly as in the image). Nested node_modules ride along
// inside their parents. `cp -a`, so hardlinks inside one package survive.
test.beforeAll(() => {
  // realpath: the probes report paths relative to the REAL tree.
  WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prune-runtime-deps-")));
  const srcNm = fs.realpathSync(path.join(ROOT, "node_modules"));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const top = Object.entries(lock.packages)
    .filter(([k, v]) => k && !v.dev && /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(k))
    .map(([k]) => k.slice("node_modules/".length))
    .filter((name) => fs.existsSync(path.join(srcNm, name)));
  PRISTINE = path.join(WORK, "pristine", "node_modules");
  const byDest = new Map();
  for (const name of top) {
    const dest = name.includes("/") ? path.join(PRISTINE, name.split("/")[0]) : PRISTINE;
    if (!byDest.has(dest)) byDest.set(dest, []);
    byDest.get(dest).push(path.join(srcNm, name));
  }
  for (const [dest, srcs] of byDest) {
    fs.mkdirSync(dest, { recursive: true });
    execFileSync("cp", ["-a", "-t", dest, ...srcs]);
  }
  for (const must of ["better-sqlite3", "bcrypt", "node-addon-api", "node-gyp-build", "esbuild", "@resvg/resvg-js", "express"]) {
    expect(fs.existsSync(path.join(PRISTINE, must)), `anti-vacuity: the production tree has ${must}`).toBe(true);
  }
  expect(top.length, "anti-vacuity: the lockfile's production closure was read").toBeGreaterThan(80);
});

// Each test's copy goes when the test does (a copy is the whole production
// tree, tens of MB); the pristine tree goes with the file.
test.afterEach(() => {
  if (!WORK) return;
  for (const e of fs.readdirSync(WORK)) {
    if (e !== "pristine") fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
  }
});
test.afterAll(() => {
  if (WORK) fs.rmSync(WORK, { recursive: true, force: true });
});

// A private copy of the pristine tree, inside a directory of its own.
function freshCopy(label) {
  const dir = fs.mkdtempSync(path.join(WORK, `${label}-`));
  execFileSync("cp", ["-a", PRISTINE, path.join(dir, "node_modules")]);
  return path.join(dir, "node_modules");
}

function runPrune(nm, args, extraEnv) {
  const env = { ...process.env, NODE_OPTIONS: "", ...(extraEnv || {}) };
  delete env.DATA_DIR;
  delete env.UPLOADS_DIR;
  return spawnSync(process.execPath, [SCRIPT, nm, ...args], { env, encoding: "utf8", timeout: 180000 });
}

// Every entry under a tree: relative path → "f:<size>", "l:<target>" or "d".
function snapshot(dir) {
  const out = new Map();
  const visit = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rel = path.relative(dir, abs);
      if (ent.isSymbolicLink()) out.set(rel, `l:${fs.readlinkSync(abs)}`);
      else if (ent.isDirectory()) { out.set(rel, "d"); visit(abs); }
      else out.set(rel, `f:${fs.statSync(abs).size}`);
    }
  };
  visit(dir);
  return out;
}

function diff(a, b) {
  const gone = [...a.keys()].filter((k) => !b.has(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  return { gone, added, changed };
}

function magic(abs) {
  const fd = fs.openSync(abs, "r");
  try {
    const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0);
    if (n < 4) return null;
    if (b.toString("hex") === "7f454c46") return "ELF";
    if (["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(b.toString("hex"))) return "Mach-O";
    if (b[0] === 0x4d && b[1] === 0x5a) return "MZ";
    return null;
  } finally { fs.closeSync(fd); }
}

// THIS FILE'S OWN PROBE — written independently of the script's, so a script
// whose probe quietly stopped exercising something cannot vouch for itself.
// Loads the four native-backed dependencies the app needs from the given tree,
// USES each, and reports the .node files that loaded.
const SPEC_PROBE = `
const path = require("path"), fs = require("fs"), os = require("os");
const tree = fs.realpathSync(process.argv[1]);
const r = require("module").createRequire(path.join(path.dirname(tree), "spec-probe.js"));
const D = r("better-sqlite3"); const db = new D(":memory:");
db.exec("create table t (n integer)"); db.prepare("insert into t values (?)").run(7);
if (db.prepare("select sum(n) s from t").get().s !== 7) throw new Error("sqlite");
db.close();
const bc = r("bcrypt"); const h = bc.hashSync("spec", 4);
if (bc.compareSync("spec", h) !== true) throw new Error("bcrypt");
const { Resvg } = r("@resvg/resvg-js");
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><circle cx="1" cy="1" r="1"/></svg>').render().asPng();
if (png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new Error("resvg");
const es = r("esbuild");
const t = fs.mkdtempSync(path.join(os.tmpdir(), "spec-probe-"));
fs.writeFileSync(path.join(t, "x.js"), "export default 'from-x';");
fs.writeFileSync(path.join(t, "e.js"), "import x from './x.js'; console.log(x);");
const out = es.buildSync({ entryPoints: [path.join(t, "e.js")], bundle: true, write: false }).outputFiles[0].text;
fs.rmSync(t, { recursive: true, force: true });
if (!out.includes("from-x")) throw new Error("esbuild");
if (es.transformSync("let q = 1 + 1", { minify: true }).code.indexOf("2") < 0) throw new Error("esbuild transform");
const nodes = Object.keys(require.cache).filter((k) => k.endsWith(".node")).map((k) => path.relative(tree, fs.realpathSync(k)));
process.stdout.write(JSON.stringify(nodes.sort()));
`;

function specProbe(nm) {
  const env = { ...process.env, NODE_OPTIONS: "" };
  delete env.DATA_DIR;
  delete env.UPLOADS_DIR;
  const r = spawnSync(process.execPath, ["-e", SPEC_PROBE, nm], { env, cwd: os.tmpdir(), encoding: "utf8", timeout: 60000 });
  expect(r.status, `the spec's own probe loads and uses every native dependency from ${nm}:\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

// Every file under a tree, by the package that owns it.
// (A package's own root directory belongs to it too: `node-addon-api` itself is
// one of the paths a prune removes.)
function packageOf(rel) {
  const parts = rel.split(path.sep);
  let owner = null;
  for (let i = 0; i < parts.length; i++) {
    if (i === 0 || parts[i - 1] === "node_modules") {
      if (parts[i].startsWith("@")) { if (i + 1 < parts.length) owner = `${parts[i]}/${parts[i + 1]}`; i++; }
      else if (!parts[i].startsWith(".") && parts[i] !== "node_modules") owner = parts[i];
    }
  }
  return owner;
}

test.describe("v8.13.4 — scripts/prune-runtime-deps.cjs", () => {
  test.describe.configure({ timeout: 180_000 });

  test("--check is the default: it reports the residue, exits 1, and deletes nothing", () => {
    const nm = freshCopy("check");
    const before = snapshot(nm);
    for (const args of [[], ["--check"]]) {
      const r = runPrune(nm, args);
      expect(r.status, `${JSON.stringify(args)}: residue present → exit 1\n${r.stdout}${r.stderr}`).toBe(1);
      for (const pkg of TABLE_PACKAGES) expect(r.stdout, `${JSON.stringify(args)} names ${pkg}'s residue`).toMatch(new RegExp(`^  ${pkg}: \\d+ files?`, "m"));
      const d = diff(before, snapshot(nm));
      expect(d, "a check deletes, adds and changes nothing").toEqual({ gone: [], added: [], changed: [] });
    }
    const bad = runPrune(nm, ["--aply"]);
    expect(bad.status, "an unknown option is refused").toBe(2);
    expect(bad.stderr).toMatch(/unknown option --aply/);
    expect(diff(before, snapshot(nm))).toEqual({ gone: [], added: [], changed: [] });
  });

  test("--apply removes exactly the table's residue, keeps every binary the loaders choose, and is idempotent", () => {
    const nm = freshCopy("apply");
    const before = snapshot(nm);
    const loadedBefore = specProbe(nm);
    // Anti-vacuity: the copy really carries each kind of residue.
    const files = [...before].filter(([, v]) => v.startsWith("f:")).map(([k]) => k);
    expect(files.filter((f) => f.endsWith(".node")).length, "the tree carries more .node files than load").toBeGreaterThan(loadedBefore.length);
    expect(files.filter((f) => BUILD_INPUT.test(path.basename(f))).length, "the tree carries build inputs").toBeGreaterThan(20);
    expect(before.has("node-addon-api/package.json")).toBe(true);
    expect(loadedBefore.length, "anti-vacuity: the probe saw three native addons (better-sqlite3, bcrypt, resvg)").toBe(3);

    const r = runPrune(nm, ["--apply"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/re-verified/);
    const after = snapshot(nm);
    const d = diff(before, after);
    expect(d.added, "a prune adds nothing").toEqual([]);
    expect(d.changed, "a prune changes no surviving file").toEqual([]);
    const strays = d.gone.filter((p) => !TABLE_PACKAGES.includes(packageOf(p)));
    expect(strays, "only the three table packages lose anything").toEqual([]);

    // What went, by name — the table's decisions, observed on the real packages.
    for (const p of ["node-addon-api", "better-sqlite3/deps", "better-sqlite3/src", "better-sqlite3/binding.gyp",
      "bcrypt/src", "bcrypt/binding.gyp", "bcrypt/Makefile", "bcrypt/Dockerfile", "bcrypt/Dockerfile-alpine",
      "bcrypt/build-all.sh"]) {
      if (before.has(p)) expect(after.has(p), `${p} is gone`).toBe(false);
    }
    expect(after.has("better-sqlite3/build"), "gyp's output dir holds no loaded binary here, so it goes whole").toBe(false);
    // What stayed: every package.json, and the code every package runs.
    for (const p of ["better-sqlite3/package.json", "better-sqlite3/lib/database.js", "bcrypt/package.json", "bcrypt/bcrypt.js",
      "node-gyp-build/package.json", "esbuild/lib/main.js", "esbuild/package.json", "debug/package.json"]) {
      expect(after.has(p), `${p} stays`).toBe(true);
    }

    // The pruned tree loads and USES everything, and its .node files are
    // exactly the ones that load — on THIS host's libc and arch, whatever they are.
    const loadedAfter = specProbe(nm);
    expect(loadedAfter, "the same addons load after the prune").toEqual(loadedBefore);
    const left = [...after].filter(([, v]) => v.startsWith("f:")).map(([k]) => k);
    expect(left.filter((f) => f.endsWith(".node")).sort(), "the only .node files left are the loaded ones").toEqual(loadedBefore);
    expect(left.filter((f) => BUILD_INPUT.test(path.basename(f))), "no build input is left").toEqual([]);
    const foreign = left.filter((f) => ["Mach-O", "MZ"].includes(String(magic(path.join(nm, f)))));
    expect(foreign, "no Windows or macOS binary is left").toEqual([]);
    const elf = left.filter((f) => magic(path.join(nm, f)) === "ELF").sort();
    const esbuildBins = elf.filter((f) => /^(?:@esbuild\/[^/]+|esbuild)\/bin\/esbuild$/.test(f.split(path.sep).join("/")));
    expect(esbuildBins.length, "esbuild's platform binary (and its bin/esbuild link) stay").toBeGreaterThanOrEqual(1);
    expect(elf.filter((f) => !esbuildBins.includes(f)), "every other ELF left is a loaded addon").toEqual(loadedBefore);

    // Idempotent: a second --apply removes nothing, and --check now says clean.
    const again = runPrune(nm, ["--apply"]);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toMatch(/nothing to remove/);
    expect(diff(after, snapshot(nm))).toEqual({ gone: [], added: [], changed: [] });
    const check = runPrune(nm, ["--check"]);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toMatch(/no residue/);
  });

  // FAIL CLOSED. Each plant is a decision the table has not taken; the run must
  // stop, name what it found, and delete nothing — not the plant, and not the
  // residue it would otherwise have removed.
  const PLANTS = [
    { what: "an unknown package's .node file", rel: "zz-native/index.node", body: "not a real addon", expect: /zz-native\/index\.node is a native binary .*package zz-native/ },
    { what: "a C source in an unknown package", rel: "zz-src/lib/helper.c", body: "int helper(void) { return 1; }\n", expect: /zz-src\/lib\/helper\.c is a build input no table rule covers \(package zz-src\)/ },
    { what: "a binding.gyp in an unknown package", rel: "zz-gyp/binding.gyp", body: "{ 'targets': [] }\n", expect: /zz-gyp\/binding\.gyp is a build input/ },
    { what: "a header in a TABLE package, outside its rules", rel: "bcrypt/examples/extra.h", body: "#define X 1\n", expect: /bcrypt\/examples\/extra\.h is a build input no table rule covers \(package bcrypt\)/ },
    { what: "a Windows PE binary under any name", rel: "zz-pe/bin/tool.data", body: "PE", expect: /zz-pe\/bin\/tool\.data is a Windows PE binary/ },
    { what: "a macOS Mach-O binary under any name", rel: "zz-macho/lib/libthing.so", body: "MACHO", expect: /zz-macho\/lib\/libthing\.so is a macOS Mach-O binary/ },
    { what: "a symlink into a package the table deletes whole", rel: "zz-link", link: "node-addon-api/napi.h", expect: /zz-link links to node_modules\/node-addon-api\/napi\.h, which the table deletes/ },
    { what: "code that requires a package the table deletes whole", rel: "zz-req/index.js", body: "module.exports = require('node-addon-api').include;\n", expect: /zz-req\/index\.js names node-addon-api in a require\/import, and the table deletes node-addon-api whole/ },
    // The pre-release review's shapes, each of which --apply let through and then
    // called "re-verified".
    { what: "a CMakeLists.txt in an unknown package", rel: "zz-cm/CMakeLists.txt", body: "project(x)\n", expect: /zz-cm\/CMakeLists\.txt is a build input no table rule covers/ },
    { what: "a C++ inline source", rel: "zz-ipp/src/impl.ipp", body: "inline int f() { return 1; }\n", expect: /zz-ipp\/src\/impl\.ipp is a build input/ },
    { what: "a static archive under any name", rel: "zz-ar/lib/libfoo.dat", body: "AR", expect: /zz-ar\/lib\/libfoo\.dat is a build input/ },
    { what: "a symlink to a package DIRECTORY the table deletes whole", rel: "zz-dirlink", link: "node-addon-api", expect: /zz-dirlink links to node_modules\/node-addon-api, which the table deletes/ },
    { what: "a symlink to a subdirectory a rule removes", rel: "zz-pkg/sqlite-deps", link: "../better-sqlite3/deps", expect: /zz-pkg\/sqlite-deps links to node_modules\/better-sqlite3\/deps, which the table deletes/ },
    { what: "a require.resolve of a package deleted whole", rel: "zz-res/index.js", body: "module.exports = require.resolve(\"node-addon-api\");\n", expect: /zz-res\/index\.js names node-addon-api in a require\/import/ },
    { what: "a template-literal require of a package deleted whole", rel: "zz-tpl/index.js", body: "module.exports = require(`node-addon-api`);\n", expect: /zz-tpl\/index\.js names node-addon-api in a require\/import/ },
    // The fix-delta review's additions: a bare ESM side-effect import, a require
    // with a space before its paren, GNU's thin archive, gcc's upper-case header
    // suffix and automake's input — each escaped the first widening.
    { what: "a bare side-effect import of a package deleted whole", rel: "zz-imp/index.mjs", body: "import \"node-addon-api\";\n", expect: /zz-imp\/index\.mjs names node-addon-api in a require\/import/ },
    { what: "a spaced require of a package deleted whole", rel: "zz-sp/index.js", body: "module.exports = require (\"node-addon-api\");\n", expect: /zz-sp\/index\.js names node-addon-api in a require\/import/ },
    { what: "a GNU thin archive under any name", rel: "zz-thin/lib/libbar.dat", body: "THIN", expect: /zz-thin\/lib\/libbar\.dat is a build input/ },
    { what: "an upper-case .H header", rel: "zz-uh/include/thing.H", body: "#define Y 2\n", expect: /zz-uh\/include\/thing\.H is a build input/ },
    { what: "an automake Makefile.in", rel: "zz-am/Makefile.in", body: "all:\n", expect: /zz-am\/Makefile\.in is a build input/ },
  ];
  for (const plant of PLANTS) {
    test(`fails closed on ${plant.what}, naming it, and deletes nothing`, () => {
      const nm = freshCopy("plant");
      const abs = path.join(nm, plant.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (plant.link) fs.symlinkSync(plant.link, abs);
      else if (plant.body === "PE") {
        const b = Buffer.alloc(128); b.write("MZ", 0); b.writeUInt32LE(64, 60); b.write("PE\0\0", 64, "latin1");
        fs.writeFileSync(abs, b);
      } else if (plant.body === "AR") {
        fs.writeFileSync(abs, Buffer.concat([Buffer.from("!<arch>\n", "latin1"), Buffer.alloc(60, 0x20)]));
      } else if (plant.body === "THIN") {
        fs.writeFileSync(abs, Buffer.concat([Buffer.from("!<thin>\n", "latin1"), Buffer.alloc(60, 0x20)]));
      } else if (plant.body === "MACHO") {
        fs.writeFileSync(abs, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1, 3, 0, 0, 0]));
      } else fs.writeFileSync(abs, plant.body);
      const before = snapshot(nm);
      const r = runPrune(nm, ["--apply"]);
      expect(r.status, `refused (exit 2)\n${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(plant.expect);
      expect(r.stderr).toMatch(/Nothing was deleted\./);
      expect(diff(before, snapshot(nm)), "nothing was deleted — every decision precedes the first rm").toEqual({ gone: [], added: [], changed: [] });
    });
  }

  // CONTROL for the directory-link plants: a link to a directory the prune leaves
  // standing is NOT a dangling link — or the refusal is satisfied by refusing
  // every directory link there is. Two of these sit INSIDE a rule's directory
  // (prebuilds/, which keeps the binary that loads), which is the case the
  // emptied-directory test has to tell apart; the other two lie outside any rule.
  // A FLOOR written here, deliberately NOT read from the script (the fix-delta
  // review): every other assertion derives its expectation from the BUILD_INPUT
  // line under test, so narrowing that line only shrinks what they expect. This
  // list may grow with the script; it must never be satisfied by a narrower one.
  test("BUILD_INPUT still covers every class the reviews named (a floor, not a derivation)", () => {
    const MUST = ["Makefile", "GNUmakefile", "makefile", "Makefile.in", "CMakeLists.txt",
      "x.c", "x.cc", "x.cpp", "x.CPP", "x.cxx", "x.c++", "x.cp", "x.C",
      "x.h", "x.H", "x.hh", "x.hp", "x.hpp", "x.HPP", "x.hxx", "x.h++",
      "x.ipp", "x.inl", "x.tcc", "x.S", "x.s", "x.sx", "x.asm",
      "x.gyp", "x.gypi", "x.mk", "x.cmake", "x.py", "x.o", "x.obj", "x.a", "x.lib"];
    expect(MUST.filter((n) => !BUILD_INPUT.test(n)), "build inputs BUILD_INPUT no longer recognises").toEqual([]);
    // CONTROL: ordinary package files are not build inputs, or a regex matching
    // everything satisfies the floor (and refuses every install).
    for (const n of ["index.js", "package.json", "README.md", "x.node", "LICENSE", "x.d.ts", "x.cjs", "x.mjs", "x.json", "x.wasm"]) {
      expect(BUILD_INPUT.test(n), n).toBe(false);
    }
  });

  test("a symlink to a directory that SURVIVES the prune is not refused", () => {
    const nm = freshCopy("dirlink-ok");
    // The two directories are the ones the PROBE says this host loads its
    // binaries from — not a hard-coded platform (the fix-delta review: the first
    // draft named linux-x64 against this file's own platform-neutral rule, and its
    // precondition regex accepted any .node at all).
    const loaded = specProbe(nm);
    const dirOf = (pkg) => {
      const f = loaded.find((x) => x.startsWith(pkg + path.sep));
      expect(f, `PRECONDITION: the probe loads ${pkg}'s binary`).toBeTruthy();
      return path.dirname(String(f));
    };
    const bsDir = dirOf("better-sqlite3");
    const bcDir = dirOf("bcrypt");
    fs.mkdirSync(path.join(nm, "zz-okpkg"), { recursive: true });
    fs.symlinkSync(path.join("..", bsDir), path.join(nm, "zz-okpkg", "bs-prebuilds"));
    fs.symlinkSync(path.join("..", bcDir), path.join(nm, "zz-okpkg", "bc-prebuild"));
    fs.symlinkSync("../better-sqlite3/lib", path.join(nm, "zz-okpkg", "bs-lib"));
    fs.symlinkSync("bcrypt", path.join(nm, "zz-okpkg-root"));
    const r = runPrune(nm, ["--check"]);
    expect(r.status, `residue reported, nothing refused (exit 1)\n${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).not.toMatch(/REFUSED/);
  });

  test("a binary that no longer loads fails the run before anything is deleted", () => {
    const nm = freshCopy("noload");
    const sqlite = specProbe(nm).find((f) => f.startsWith("better-sqlite3" + path.sep));
    expect(sqlite, "anti-vacuity: the probe loads better-sqlite3's addon").toBeTruthy();
    fs.rmSync(path.join(nm, String(sqlite)));
    const before = snapshot(nm);
    const r = runPrune(nm, ["--apply"]);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/the probe could not load and exercise/);
    expect(r.stderr).toMatch(/better_sqlite3\.node/);
    expect(diff(before, snapshot(nm))).toEqual({ gone: [], added: [], changed: [] });
  });

  test("a from-source build is kept: gyp's output dir loses everything but the binary that loads", () => {
    // better-sqlite3 tries its prebuild FIRST, then build/Debug and
    // build/Release/better_sqlite3.node — the shape a platform with no prebuild
    // leaves. A prune that deleted build/ wholesale would delete the database.
    const nm = freshCopy("fromsource");
    const pkg = path.join(nm, "better-sqlite3");
    const prebuild = specProbe(nm).find((f) => f.startsWith("better-sqlite3" + path.sep));
    fs.mkdirSync(path.join(pkg, "build", "Release", "obj.target"), { recursive: true });
    fs.renameSync(path.join(nm, String(prebuild)), path.join(pkg, "build", "Release", "better_sqlite3.node"));
    for (const f of ["build/Makefile", "build/config.gypi", "build/better_sqlite3.target.mk", "build/Release/obj.target/better_sqlite3.stamp"]) {
      fs.writeFileSync(path.join(pkg, f), "# gyp output\n");
    }
    expect(specProbe(nm), "precondition: the fallback is what loads now")
      .toContain(path.join("better-sqlite3", "build", "Release", "better_sqlite3.node"));
    const r = runPrune(nm, ["--apply"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(pkg, "build", "Release", "better_sqlite3.node")), "the loaded binary stays").toBe(true);
    for (const f of ["build/Makefile", "build/config.gypi", "build/better_sqlite3.target.mk", "build/Release/obj.target"]) {
      expect(fs.existsSync(path.join(pkg, f)), `${f} is gone`).toBe(false);
    }
    expect(fs.existsSync(path.join(pkg, "prebuilds")), "no prebuild loads, so none stays").toBe(false);
    expect(specProbe(nm)).toContain(path.join("better-sqlite3", "build", "Release", "better_sqlite3.node"));
  });

  test("PREBUILDS_ONLY in the builder's environment cannot hide a from-source bcrypt", () => {
    // node-gyp-build tries build/Release before prebuilds/ — unless PREBUILDS_ONLY
    // is set, when it skips build/ and, with no prebuild for this host, throws.
    // An unscrubbed probe would then refuse a tree the runtime loads perfectly.
    const nm = freshCopy("prebuildsonly");
    const pkg = path.join(nm, "bcrypt");
    const prebuild = specProbe(nm).find((f) => f.startsWith("bcrypt" + path.sep));
    expect(prebuild, "anti-vacuity: bcrypt loads a prebuild here").toBeTruthy();
    fs.mkdirSync(path.join(pkg, "build", "Release"), { recursive: true });
    fs.renameSync(path.join(nm, String(prebuild)), path.join(pkg, "build", "Release", "bcrypt_lib.node"));
    const fromSource = path.join("bcrypt", "build", "Release", "bcrypt_lib.node");
    expect(specProbe(nm), "precondition: the from-source binary is what loads now").toContain(fromSource);
    const r = runPrune(nm, ["--apply"], { PREBUILDS_ONLY: "1" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(nm, fromSource)), "the loaded binary stays").toBe(true);
    expect(specProbe(nm)).toContain(fromSource);
  });

  test("a package that resolves OUTSIDE the tree fails closed, whether the probe asked for it or a dependency did", () => {
    // Node's resolver walks UP the directory tree, so a package missing from the
    // target loads quietly from an ancestor's node_modules — and a probe that let
    // it would vouch for a tree that cannot start on its own. Two ways in, two
    // checks: a probed package resolving outside, and anything else loading from
    // outside (bcrypt's own loader, node-gyp-build, here).
    const cases = [
      ["bcrypt", /bcrypt resolved outside the target tree/],
      ["node-gyp-build", /loaded from outside the target tree: \S*node-gyp-build/],
    ];
    for (const [moved, why] of cases) {
      const nm = freshCopy("outside");
      const ancestor = path.join(WORK, "node_modules");   // between the copy and /
      fs.mkdirSync(ancestor, { recursive: true });
      fs.renameSync(path.join(nm, moved), path.join(ancestor, moved));
      const before = snapshot(nm);
      const r = runPrune(nm, ["--apply"]);
      expect(r.status, `${moved}: refused\n${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(why);
      expect(r.stderr).toMatch(/Nothing was deleted\./);
      expect(diff(before, snapshot(nm))).toEqual({ gone: [], added: [], changed: [] });
      fs.rmSync(ancestor, { recursive: true, force: true });
      fs.rmSync(path.dirname(nm), { recursive: true, force: true });
    }
  });

  test("the probe ignores what a builder's environment says, and keeps what THIS host's runtime will load", () => {
    // node-gyp-build picks bcrypt's binary from npm_config_arch / _platform,
    // LIBC and BCRYPT_PREBUILD; esbuild runs ESBUILD_BINARY_PATH; NODE_OPTIONS
    // reaches every child. Each of those six, on its own, makes an unscrubbed
    // probe load the wrong binary (or none), so dropping any one of their scrubs
    // fails this (measured, one at a time). PREBUILDS_ONLY, ARM_VERSION and
    // NODE_PATH ride along to show they are harmless here: on an x64 host whose
    // prebuild loads they change nothing, so THIS test does not lock their
    // scrubs. PREBUILDS_ONLY has its own test below; ARM_VERSION matters only on
    // ARM; a package NODE_PATH supplies is refused by the outside-the-tree check.
    const nm = freshCopy("env");
    const expected = specProbe(nm);
    const glibc = Boolean(process.report && process.report.getReport().header.glibcVersionRuntime);
    const poison = path.join(path.dirname(nm), "poison.cjs");
    fs.writeFileSync(poison, "if (process.execArgv[0] === '-e') throw new Error('NODE_OPTIONS reached the probe');\n");
    const r = runPrune(nm, ["--apply"], {
      LIBC: glibc ? "musl" : "glibc",
      npm_config_arch: os.arch() === "x64" ? "arm64" : "x64",
      npm_config_platform: "win32",
      BCRYPT_PREBUILD: path.join(path.dirname(nm), "no-such-prebuild"),
      ESBUILD_BINARY_PATH: process.execPath,
      NODE_OPTIONS: `--require ${poison}`,
      PREBUILDS_ONLY: "1",
      ARM_VERSION: "6",
      NODE_PATH: path.dirname(nm),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const left = [...snapshot(nm)].filter(([k, v]) => v.startsWith("f:") && k.endsWith(".node")).map(([k]) => k).sort();
    expect(left, "the binaries kept are the ones a clean runtime loads").toEqual(expected);
  });

  test("--apply refuses a symlinked node_modules, a checkout (.git dir or worktree file) and a non-node_modules path", () => {
    // Defence in depth: the positive --apply flag is the gate, and only the
    // Dockerfile passes it. These guards are what stop a mistyped command line
    // from pruning a developer's tree or the CI image's shared /ci-deps.
    const nm = freshCopy("guard");
    const before = snapshot(nm);
    const parent = path.dirname(nm);
    const link = path.join(fs.mkdtempSync(path.join(WORK, "link-")), "node_modules");
    fs.symlinkSync(nm, link);
    let r = runPrune(link, ["--apply"]);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/is a symlink/);
    for (const make of [() => fs.mkdirSync(path.join(parent, ".git")), () => fs.writeFileSync(path.join(parent, ".git"), "gitdir: /elsewhere\n")]) {
      make();
      r = runPrune(nm, ["--apply"]);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toMatch(/sits beside a \.git/);
      fs.rmSync(path.join(parent, ".git"), { recursive: true, force: true });
    }
    const renamed = path.join(parent, "deps");
    fs.renameSync(nm, renamed);
    r = runPrune(renamed, ["--apply"]);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/is not a node_modules directory/);
    fs.renameSync(renamed, nm);
    expect(diff(before, snapshot(nm)), "every refusal deleted nothing").toEqual({ gone: [], added: [], changed: [] });
    // CONTROL: the same tree with the guards satisfied is pruned, so each refusal
    // above was the guard's doing.
    r = runPrune(nm, ["--apply"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(diff(before, snapshot(nm)).gone.length).toBeGreaterThan(50);
  });

  test("the Dockerfile prunes after npm ci, ships neither the script nor any build tool, and checks its own image", () => {
    // Comment lines dropped and `\`-continuations joined first: the paragraphs
    // explaining this name every path and tool the instructions use.
    const lines = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8")
      .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\\\n/g, " ")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const froms = lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(froms.length, "a two-stage build").toBe(2);
    const image = (l) => l.replace(/^FROM\s+/i, "").replace(/\s+AS\s+\S+\s*$/i, "").trim();
    expect(lines.filter((l) => /^FROM\s/i.test(l) && /--platform/i.test(l)), "no stage pins a --platform: the prune keeps what loads where it RUNS").toEqual([]);
    expect(image(lines[froms[0]]), "the build stage is the runtime's own image").toBe(image(lines[froms[1]]));
    const build = lines.slice(froms[0], froms[1]);
    const final = lines.slice(froms[1]);
    const problems = [];

    // (1) Build stage: npm ci → COPY the script → RUN it with --apply on
    // /app/node_modules, by plain node, nothing chained.
    const ciAt = build.findIndex((l) => /^RUN\s+npm\s+ci\s+--omit=dev\s*$/.test(l));
    const copyAt = build.findIndex((l) => /^COPY\s+scripts\/prune-runtime-deps\.cjs\s+\S+$/.test(l));
    const dest = copyAt >= 0 ? build[copyAt].split(/\s+/)[2] : "";
    const scriptAt = dest.endsWith("/") ? dest + "prune-runtime-deps.cjs" : dest;
    const pruneAt = build.findIndex((l) => l === `RUN node ${scriptAt} /app/node_modules --apply`);
    expect(ciAt, "anti-vacuity: the build stage installs with npm ci --omit=dev").toBeGreaterThan(0);
    expect(copyAt, "the build stage copies the prune script in").toBeGreaterThan(ciAt);
    expect(pruneAt, `the build stage runs exactly \`RUN node ${scriptAt} /app/node_modules --apply\` after npm ci`).toBeGreaterThan(copyAt);
    // (2) …and deletes the copy of scripts/ that `COPY . /src` brings in, after
    // the mode normalisation, so /app never carries it.
    const srcCopyAt = build.findIndex((l) => /^COPY\s+\.\/?\s+\/src\/?$/.test(l));
    const chmodAt = build.findIndex((l) => /^RUN\s+chmod\s+-R\s+\S+\s+\/src\/?$/.test(l));
    const rmScriptsAt = build.findIndex((l) => /^RUN\s+rm\s+-rf\s+\/src\/scripts\/?$/.test(l));
    expect(srcCopyAt, "anti-vacuity: the context is mirrored into /src").toBeGreaterThan(0);
    expect(rmScriptsAt, "the build stage removes /src/scripts").toBeGreaterThan(Math.max(srcCopyAt, chmodAt));

    // (3) Runtime stage: node_modules arrives from the PRUNED tree, and only from there.
    const nmCopies = final.filter((l) => /^(?:COPY|ADD)\s/i.test(l) && /node_modules/.test(l));
    expect(nmCopies, "the runtime's one node_modules source is the build stage's pruned /app/node_modules")
      .toEqual(["COPY --from=build /app/node_modules ./node_modules"]);
    // (4) No package manager, compiler or interpreter runs in the runtime stage —
    // judged by COMMAND POSITION, so the self-check's list of names is data.
    const TOOLS = new Set(["apk-add", "gcc", "g++", "cc", "c++", "make", "python", "python3", "pip", "pip3", "npm", "npx", "node-gyp", "yarn", "corepack"]);
    for (const l of final.filter((x) => /^RUN\s/i.test(x))) {
      for (const seg of l.replace(/^RUN\s+/i, "").split(/;|&&|\|\||\||\bdo\b|\bthen\b|\belse\b/)) {
        const words = seg.trim().replace(/^(?:(?:if|while|until|!|exec|command|env)\s+)+/, "").split(/\s+/);
        // `apk` with any flags before `add`, and a tool named by absolute path
        // (/usr/bin/make), are the same act (the pre-release review: both passed).
        const base = (words[0] || "").replace(/^.*\//, "");
        // `add` anywhere after apk: a flag can take a VALUE (`apk -X <url> add`,
        // `apk --repository <url> add`), so "the first non-flag word" is the URL
        // there (the fix-delta review).
        const first = base === "apk" && words.slice(1).includes("add") ? "apk-add" : base;
        if (first && TOOLS.has(first)) problems.push(`the runtime stage runs ${first}: ${l}`);
      }
    }
    // (5) The base image's node headers and gyp include files go with npm.
    const rm = final.find((l) => /^RUN\s+rm\s+-rf\s/.test(l) && /(?:^|\s)\/usr\/local\/bin\/npm(?:\s|$)/.test(l));
    expect(rm, "anti-vacuity: the runtime stage's npm deletion line").toBeTruthy();
    expect(` ${rm} `, "it also deletes /usr/local/include/node (node, V8 and libuv headers, common.gypi)").toMatch(/\s\/usr\/local\/include\/node\s/);

    // (6) THE SELF-CHECK: the one assertion that runs against the shipped
    // filesystem, on every build. Before `USER node`, after both COPYs.
    const userAt = final.indexOf("USER node");
    const lastCopy = Math.max(...final.map((l, i) => (/^COPY\s/i.test(l) ? i : -1)));
    const checks = final.filter((l, i) => i > lastCopy && i < userAt && /^RUN\s/i.test(l) && /command -v/.test(l));
    expect(checks.length, "exactly one self-check RUN between the last COPY and USER node").toBe(1);
    const sc = checks[0];
    const loop = (/\bfor\s+\w+\s+in\s+([^;]+);/.exec(sc) || [])[1] || "";
    const named = loop.trim().split(/\s+/);
    for (const t of ["gcc", "g++", "cc", "c++", "make", "python3", "python", "node-gyp", "npm", "npx"]) {
      if (!named.includes(t)) problems.push(`the self-check does not look for ${t} on PATH`);
    }
    if (named.some((t) => /[*?[]/.test(t))) problems.push(`the self-check names a tool by pattern — node-gyp* would match the runtime loader node-gyp-build: ${loop}`);
    if (!/\bcommand\s+-v\s+"\$\w+"/.test(sc)) problems.push("the self-check does not test each name with `command -v`");
    if (!/\bfind\s+\/app\/node_modules\b/.test(sc)) problems.push("the self-check does not search /app/node_modules");
    // The -name alternatives must be GROUPED: without `\( … \)` the -print binds
    // to the last alternative alone, and the check reports only files named
    // `makefile` (the pre-release review, measured). And nothing may narrow the walk.
    if (!/\bfind\s+\/app\/node_modules\s+\\\(\s[^]*?\s\\\)\s+-print\b/.test(sc)) problems.push("the self-check's -name alternatives are not grouped in \\( … \\) ahead of -print");
    if (/\s-(?:maxdepth|mindepth|prune)\b/.test(sc)) problems.push("the self-check narrows its find with -maxdepth/-mindepth/-prune");
    // …and the alternatives are OR'd — every pair joined by `-o` (the fix-delta
    // review: one `-o` turned into `-a`, or dropped, makes find stop reporting two
    // classes while every pattern is still present).
    const grp = (/\bfind\s+\/app\/node_modules\s+\\\(([\s\S]*?)\s\\\)\s+-print\b/.exec(sc) || [])[1] || "";
    const toks = grp.split(/\s+/).filter((t) => t && t !== "\\");
    let ored = toks.length >= 2 && toks.length % 3 === 2;
    for (let i = 0; ored && i < toks.length; i += 3) {
      if (toks[i] !== "-name" || !toks[i + 1]) ored = false;
      if (i + 2 < toks.length && toks[i + 2] !== "-o") ored = false;
    }
    if (!ored) problems.push(`the self-check's group is not a plain "-name X -o -name Y …" alternation: ${toks.join(" ")}`);
    // The patterns are DERIVED from the prune script's own BUILD_INPUT, so the
    // image's self-check and the prune cannot disagree about what a build input
    // is (the pre-release review: a hand-written nine of the fourteen let five
    // drop out of the Dockerfile with this arm green).
    const bi = /const BUILD_INPUT = \/\^\(\?:([^)]+)\)\$\|\\\.\(\?:([^)]+)\)\$\//.exec(
      fs.readFileSync(path.join(ROOT, "scripts", "prune-runtime-deps.cjs"), "utf8"));
    expect(bi, "BUILD_INPUT keeps its `^(?:names)$|\\.(?:exts)$` shape, which this arm reads").toBeTruthy();
    const unesc = (x) => x.replace(/\\(.)/g, "$1");
    const buildInputs = [...bi[1].split("|").map(unesc), ...bi[2].split("|").map((e) => `*.${unesc(e)}`)];
    expect(buildInputs.length, "anti-vacuity: BUILD_INPUT names at least a dozen patterns").toBeGreaterThanOrEqual(12);
    for (const g of buildInputs) {
      if (!new RegExp(`-name\\s+['"]?${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?(?:\\s|$)`).test(sc)) problems.push(`the self-check does not search for ${g}`);
    }
    for (const p of ["/app/scripts", "/usr/local/include/node"]) {
      if (!new RegExp(`(?:^|\\s)${p.replace(/\//g, "\\/")}(?:\\s|;|$)`).test(sc)) problems.push(`the self-check does not refuse ${p}`);
    }
    // Every branch that finds something must FAIL the build: one that only
    // echoes reports the problem into a build log nobody reads and ships it.
    const branches = [...sc.matchAll(/\bthen\b([\s\S]*?)\bfi\b/g)].map((m) => m[1]);
    if (branches.length < 3) problems.push(`anti-vacuity: the self-check has ${branches.length} if-branches, expected one per check (tools, build inputs, paths)`);
    for (const b of branches) {
      if (!/\bexit\s+1\b/.test(b)) problems.push(`a self-check branch reports without failing the build: ${b.trim()}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
