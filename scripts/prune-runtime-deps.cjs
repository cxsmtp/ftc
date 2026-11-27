#!/usr/bin/env node
"use strict";
/* v8.13.4 — STRIP THE NATIVE ADDONS' BUILD RESIDUE FROM A PRODUCTION node_modules.
 *
 * Run by the Dockerfile's BUILD stage, right after `npm ci --omit=dev`, against
 * /app/node_modules — the tree the runtime stage copies. Operator decision: the
 * build stage keeps its toolchain (node-gyp needs python3 + make whenever a
 * prebuild is missing), and the runtime image carries none of what that
 * toolchain reads or writes: the SQLite amalgamation and the addons' C++
 * sources, their gyp/Makefile files, the node-addon-api headers, gyp's output
 * directory, and the prebuilt binaries for every platform this one is not.
 *
 *   node scripts/prune-runtime-deps.cjs <node_modules>            # --check: report only
 *   node scripts/prune-runtime-deps.cjs <node_modules> --apply    # delete
 *
 * READ-ONLY UNLESS TOLD OTHERWISE. Deleting needs the positive `--apply` flag,
 * which only the Dockerfile passes (and the spec, against a temporary copy). As
 * defence in depth `--apply` also refuses a node_modules that is a symlink, is
 * not named node_modules, or sits beside a `.git` (a checkout or a worktree):
 * pruning a developer's tree, or the CI image's /ci-deps tree, deletes the very
 * binaries the test suite loads. A negative guard alone fails open on a tarball
 * or an rsync copy, which is why the flag is the gate and the guard is not.
 *
 * WHAT STAYS IS DECIDED BY THE LOADERS, NOT BY A LIST. A fresh child process
 * (env scrubbed, so it picks what the runtime will) requires and EXERCISES the
 * four native-backed dependencies — a better-sqlite3 query, a bcrypt hash and
 * compare, a resvg render, an esbuild transform and bundle — and reports every
 * .node file it loaded and every executable esbuild ran. A bare require is not
 * enough: better-sqlite3 loads its addon in the Database constructor, and
 * esbuild resolves its binary at the first call, so `require()` alone proves
 * nothing about either. And two of the four would fail QUIETLY at runtime:
 * esbuild's per-file catch in server.js serves the SPA unbundled, and a missing
 * resvg binary disables badges behind one boot warning.
 *
 * WHAT GOES IS A DECISION PER PACKAGE (TABLE below), never a blanket sweep of
 * every *.c / *.h / Makefile in the tree: re-probing exercises only the four
 * known dependencies, so a future package reading such a file as DATA would
 * break with nothing to notice. Instead the script FAILS CLOSED — exit 2,
 * nothing deleted — on:
 *   - a native binary (*.node, or ELF / PE / Mach-O magic) that did not load and
 *     that no table rule covers;
 *   - a build input that no table rule covers, in any package: C, C++ and
 *     assembly sources and headers in gcc's suffix families, gyp / cmake / make
 *     files, gyp's Python helpers, object files and static archives (BUILD_INPUT
 *     below — the Dockerfile's image self-check searches the same list), and a
 *     static archive by its `!<arch>` / `!<thin>` magic under any name;
 *   - a package the table deletes WHOLE that other code still names in a
 *     require(), require.resolve(), import() or import / from;
 *   - a table rule that would delete a file the probe loaded;
 *   - a symlink that would be left pointing at a deleted path;
 *   - a probe that fails, or loads anything from outside the target tree.
 * Every decision is taken before the first file is deleted. After deleting, the
 * probe runs again and must load the SAME set, and the tree is re-scanned.
 *
 * THE TRADE, STATED: a dependency bump that adds a native package, moves a
 * binary or ships a new build input FAILS THE IMAGE BUILD until this table
 * learns it. That is intended — the alternative is an image that boots with a
 * binary missing — and the refusal names the package and the remedy. Build and
 * boot the image before a deploy whenever package-lock.json, the Dockerfile or
 * this file changes (CI has no docker). README's redeploy builds before it
 * replaces the running container, so this refusal leaves the old version serving.
 *
 * Runs where it is built: the build stage must be the SAME image as the runtime
 * stage (a Docs-hygiene lock holds that), because this keeps what loads HERE.
 * Invoke it with plain `node`, never `npm run` — npm exports npm_config_*
 * variables that node-gyp-build reads.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const USAGE = "usage: node scripts/prune-runtime-deps.cjs <node_modules> [--check | --apply]";
const EXIT_OK = 0;          // clean (--check) / pruned and re-verified (--apply)
const EXIT_RESIDUE = 1;     // --check only: there is residue --apply would remove
const EXIT_REFUSED = 2;     // nothing was deleted (a usage error, a guard, or a fail-closed decision)

// The shapes a native toolchain reads or writes. Matched on the BASENAME, and
// the Dockerfile's image self-check searches the same list (a source arm in
// tests/prune-runtime-deps.spec.js derives its expectation from this line, so
// keep its `^(?:names)$|\.(?:exts)$` shape). Widened by the pre-release review:
// cmake files, assembly, C++ inline/template sources, gyp's Python helpers and
// object files / static archives were neither removed nor refused. A static
// archive is also recognised by its magic under any name (nativeKind, "ar").
// Widened again by the fix-delta review to gcc's full suffix families (.CPP,
// .H, .hp, .HPP, .h++, .sx) and automake's Makefile.in, and the ar check to
// GNU's thin archive (`!<thin>`) — the first widening took part of each family.
const BUILD_INPUT = /^(?:Makefile|GNUmakefile|makefile|Makefile\.in|CMakeLists\.txt)$|\.(?:c|cc|cpp|CPP|cxx|c\+\+|cp|C|h|H|hh|hp|hpp|HPP|hxx|h\+\+|ipp|inl|tcc|S|s|sx|asm|gyp|gypi|mk|cmake|py|o|obj|a|lib)$/;

/* THE DECISION TABLE. One entry per package that is allowed to lose files, each
 * verified against the real installed tree (v8.13.4) and the package's own
 * loader. Keys are the package NAME, so a nested copy at another version obeys
 * the same rule.
 *   remove:     paths (file or directory) that are compile inputs only.
 *   outputs:    gyp's output directory: everything in it goes EXCEPT a .node
 *               the probe loaded (the from-source fallback both loaders try).
 *   prebuilds:  every native binary in here that the probe did NOT load goes;
 *               anything else in here stays.
 *   whole:      the whole package goes (refused if the probe loaded from it, or
 *               if any other package's code names it in a require/import).
 *   keepNative: native binaries that stay although nothing loaded them.
 */
const TABLE = {
  // better-sqlite3 13 (lib/binding.js): prebuilds/<linuxmusl|platform>-<arch>.node
  // FIRST, then build/Debug and build/Release/better_sqlite3.node. deps/ is the
  // SQLite amalgamation (sqlite3.c, ~9.5 MB) and its gyp files; src/ the C++
  // binding. npm synthesises `install: node-gyp rebuild` for its binding.gyp, and
  // that run compiles nothing when a prebuild matches but leaves gyp's Makefiles,
  // config.gypi and stamp files in build/ — residue too. (The lib/<platform>.js
  // subpath exports require their own prebuild by name; nothing here uses them.)
  "better-sqlite3": {
    remove: ["binding.gyp", "deps", "src"],
    outputs: ["build"],
    prebuilds: ["prebuilds"],
  },
  // bcrypt 6, through node-gyp-build: build/Release, build/Debug, then
  // prebuilds/<platform>-<arch>/ filtered by libc (LIBC, else /etc/alpine-release).
  "bcrypt": {
    remove: ["binding.gyp", "Makefile", "Dockerfile", "Dockerfile-alpine", "build-all.sh", "src"],
    outputs: ["build"],
    prebuilds: ["prebuilds"],
  },
  // Headers and gyp include files only: its two consumers are the binding.gyp
  // files above (`require('node-addon-api').include_dir`), both removed.
  "node-addon-api": { whole: true },
  // esbuild's installer links bin/esbuild (the CLI entry in its package.json) to
  // the platform binary — a hardlink of what the probe runs, or a copy of it.
  "esbuild": { keepNative: ["bin/esbuild"] },
};

// The dependencies the probe exercises, by the name the app requires them under.
const PROBED = ["better-sqlite3", "bcrypt", "@resvg/resvg-js", "esbuild"];

function fail(msg) {
  process.stderr.write(`prune-runtime-deps: REFUSED — ${msg}\nNothing was deleted.\n`);
  process.exit(EXIT_REFUSED);
}

function parseArgs(argv) {
  let nm = null, mode = "check";
  for (const a of argv) {
    if (a === "--check") mode = "check";
    else if (a === "--apply") mode = "apply";
    else if (a.startsWith("-")) fail(`unknown option ${a}\n${USAGE}`);
    else if (nm === null) nm = a;
    else fail(`one node_modules path only\n${USAGE}`);
  }
  if (nm === null) fail(USAGE);
  return { nm: path.resolve(nm), mode };
}

function guardForApply(nm) {
  let st;
  try { st = fs.lstatSync(nm); } catch (_) { fail(`${nm} does not exist`); }
  if (st.isSymbolicLink()) fail(`${nm} is a symlink (a checkout's or the CI image's shared tree); --apply prunes only a real, private install`);
  if (!st.isDirectory()) fail(`${nm} is not a directory`);
  if (path.basename(nm) !== "node_modules") fail(`${nm} is not a node_modules directory`);
  if (fs.existsSync(path.join(path.dirname(nm), ".git"))) {
    fail(`${nm} sits beside a .git — that is a checkout, whose binaries the tests load; --apply is for the image's build stage`);
  }
}

// ── The tree ─────────────────────────────────────────────────────────────
// Every regular file and symlink, each tagged with the package that owns it
// (nearest `node_modules/<name>` or `node_modules/@scope/<name>` above it).
function walk(nm) {
  const files = [], links = [], pkgs = [];
  const visit = (dir, owner, parentIsNm, scope) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) { links.push({ abs, owner }); continue; }
      if (ent.isDirectory()) {
        if (parentIsNm && ent.name.startsWith("@")) { visit(abs, owner, false, ent.name); continue; }
        let o = owner;
        if ((parentIsNm && !ent.name.startsWith(".")) || scope) {
          o = { name: scope ? `${scope}/${ent.name}` : ent.name, root: abs };
          pkgs.push(o);
        }
        visit(abs, o, ent.name === "node_modules", null);
        continue;
      }
      if (ent.isFile()) files.push({ abs, owner, rel: owner ? path.relative(owner.root, abs).split(path.sep).join("/") : null });
    }
  };
  visit(nm, null, true, null);
  return { files, links, pkgs };
}

// ELF, PE (MZ + a "PE\0\0" header where e_lfanew points) or Mach-O (thin or
// fat) — or "ar", a static archive, which is a build INPUT rather than a binary
// anything loads, and is judged as one whatever it is called.
function nativeKind(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, "r");
    const head = Buffer.alloc(64);
    const n = fs.readSync(fd, head, 0, 64, 0);
    if (n >= 4 && head.readUInt32BE(0) === 0x7f454c46) return "ELF";
    if (n >= 8 && (head.toString("latin1", 0, 8) === "!<arch>\n" || head.toString("latin1", 0, 8) === "!<thin>\n")) return "ar";
    if (n >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(head.readUInt32BE(0))) return "Mach-O";
    if (n >= 8 && head.readUInt32BE(0) === 0xcafebabe && !abs.endsWith(".class")) return "Mach-O";
    if (n >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
      const pe = Buffer.alloc(4);
      if (fs.readSync(fd, pe, 0, 4, head.readUInt32LE(60)) === 4 && pe.readUInt32BE(0) === 0x50450000) return "PE";
    }
  } catch (_e) {
    // unreadable → judged by name alone, exactly as the fall-through below
    return abs.endsWith(".node") ? "node" : null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return abs.endsWith(".node") ? "node" : null;
}

const idOf = (abs) => { const s = fs.statSync(abs); return `${s.dev}:${s.ino}`; };

// ── The probe ────────────────────────────────────────────────────────────
// Runs in a FRESH child: this process has loaded nothing from the target tree,
// and must not — a module cached here would answer for a file already deleted.
const PROBE = `
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const nm = fs.realpathSync(process.argv[1]);
const inside = (p) => { const r = fs.realpathSync(p); return r === nm || r.startsWith(nm + path.sep); };
const cp = require("child_process");
const ran = [];
for (const k of ["execFileSync", "execFile", "spawnSync", "spawn"]) {
  const orig = cp[k];
  cp[k] = function (cmd, ...rest) { ran.push(String(cmd)); return orig.call(this, cmd, ...rest); };
}
const req = require("module").createRequire(path.join(path.dirname(nm), "__prune_probe__.js"));
const out = { versions: {} };
for (const name of ${JSON.stringify(PROBED)}) {
  const r = req.resolve(name);
  if (!inside(r)) throw new Error(name + " resolved outside the target tree: " + r);
}
const Database = req("better-sqlite3");
const db = new Database(":memory:");
out.versions.sqlite = db.prepare("select sqlite_version() AS v").get().v;
db.close();
const bcrypt = req("bcrypt");
const hash = bcrypt.hashSync("prune-probe", 4);
if (!bcrypt.compareSync("prune-probe", hash) || bcrypt.compareSync("prune-probf", hash)) throw new Error("bcrypt compare is wrong");
const { Resvg } = req("@resvg/resvg-js");
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#7c3aed"/></svg>').render().asPng();
if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("resvg did not render a PNG");
const esbuild = req("esbuild");
if (!/42/.test(esbuild.transformSync("export const a = 40 + 2;", { minify: true, format: "esm" }).code)) throw new Error("esbuild transform is wrong");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prune-probe-"));
try {
  fs.writeFileSync(path.join(tmp, "dep.js"), "export const word = 'bundled-' + 'ok';\\n");
  fs.writeFileSync(path.join(tmp, "main.js"), "import { word } from './dep.js';\\nconsole.log(word);\\n");
  const b = esbuild.buildSync({ entryPoints: [path.join(tmp, "main.js")], bundle: true, minify: true, format: "esm", write: false });
  if (!/bundled-/.test(b.outputFiles[0].text) || /import/.test(b.outputFiles[0].text)) throw new Error("esbuild did not bundle");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
out.loaded = Object.keys(require.cache).filter((k) => k.endsWith(".node")).map((k) => fs.realpathSync(k));
out.ran = [...new Set(ran)].filter((c) => path.isAbsolute(c) && fs.existsSync(c)).map((c) => fs.realpathSync(c));
const strays = Object.keys(require.cache).filter((k) => !inside(k));
if (strays.length) throw new Error("loaded from outside the target tree: " + strays.join(", "));
if (!out.ran.length) throw new Error("esbuild ran no executable the probe could see");
process.stdout.write(JSON.stringify(out));
`;

function probe(nm) {
  // What the RUNTIME will see: none of the variables a builder or npm sets that
  // change which binary a loader picks (node-gyp-build reads npm_config_arch /
  // npm_config_platform, LIBC, ARM_VERSION, PREBUILDS_ONLY and <NAME>_PREBUILD;
  // esbuild reads ESBUILD_BINARY_PATH), no NODE_PATH, no ambient NODE_OPTIONS,
  // and none of the app's directories (the probe opens no database).
  const env = { ...process.env };
  delete env.DATA_DIR;
  delete env.UPLOADS_DIR;
  delete env.NODE_PATH;
  for (const k of Object.keys(env)) {
    if (/^npm_config_/i.test(k) || /_PREBUILD$/.test(k)
      || ["LIBC", "ARM_VERSION", "PREBUILDS_ONLY", "ESBUILD_BINARY_PATH"].includes(k)) delete env[k];
  }
  env.NODE_OPTIONS = "";
  env.ESBUILD_WORKER_THREADS = "0";   // sync API on THIS thread, so the probe sees what esbuild runs
  const r = spawnSync(process.execPath, ["-e", PROBE, nm], {
    env, cwd: os.tmpdir(), encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    // The thrown error's own line, not the require stack Node prints after it.
    const lines = String(r.stderr || "").split("\n");
    const at = lines.findIndex((l) => /^\w*Error\b/.test(l));
    const why = at >= 0 ? lines.slice(at, at + 3).join("\n") : lines.filter(Boolean).slice(-6).join("\n");
    return { error: (r.error && r.error.message) || why || `exit ${r.status}` };
  }
  try { return JSON.parse(r.stdout); } catch (_) { return { error: `unreadable probe output: ${String(r.stdout).slice(0, 200)}` }; }
}

const under = (rel, p) => rel === p || rel.startsWith(p + "/");

// ── The plan ─────────────────────────────────────────────────────────────
function plan(nm, loadedIds) {
  const { files, links } = walk(nm);
  const problems = [];
  const remove = [];               // { abs, pkg, bytes }
  const natives = [];              // every native binary left after the plan
  const requirers = new Map();     // whole-package name → [files naming it]
  const wholes = Object.entries(TABLE).filter(([, e]) => e.whole).map(([n]) => n);

  for (const f of files) {
    const pkg = f.owner ? f.owner.name : null;
    const entry = (pkg && TABLE[pkg]) || {};
    const k0 = nativeKind(f.abs);
    const archive = k0 === "ar";
    const kind = archive ? null : k0;
    const loaded = kind ? loadedIds.has(idOf(f.abs)) : false;
    const where = path.relative(path.dirname(nm), f.abs);
    let go = false;
    if (entry.whole) go = true;
    else if (entry.remove && entry.remove.some((p) => under(f.rel, p))) go = true;
    else if (entry.outputs && entry.outputs.some((p) => under(f.rel, p))) go = !(kind && loaded);
    else if (entry.prebuilds && kind && entry.prebuilds.some((p) => under(f.rel, p))) go = !loaded;
    if (go && loaded) {
      problems.push(`${where} is a binary the probe LOADED, and the table would delete it (${pkg}) — the table is wrong for this version of ${pkg}`);
      continue;
    }
    if (go) { remove.push({ abs: f.abs, pkg, bytes: fs.lstatSync(f.abs).size }); continue; }
    if (archive || BUILD_INPUT.test(path.basename(f.abs))) {
      problems.push(`${where} is a build input no table rule covers (package ${pkg || "<none>"}) — decide whether ${pkg || "it"} reads it at runtime, then add a rule to TABLE in scripts/prune-runtime-deps.cjs`);
    }
    if (kind) {
      if (loaded || (entry.keepNative && entry.keepNative.includes(f.rel))) natives.push(f.abs);
      else if (kind === "PE" || kind === "Mach-O") {
        problems.push(`${where} is a ${kind === "PE" ? "Windows PE" : "macOS Mach-O"} binary, which cannot load on Linux, and no table rule covers it (package ${pkg || "<none>"}) — add the directory holding it to ${pkg || "its package"}'s TABLE entry in scripts/prune-runtime-deps.cjs`);
      } else {
        problems.push(`${where} is a native binary the probe did not load and no table rule covers (package ${pkg || "<none>"}) — decide whether ${pkg || "it"} loads it at runtime: if so, make the probe exercise it; either way, teach TABLE in scripts/prune-runtime-deps.cjs`);
      }
    }
    if (!entry.whole && /\.(?:c|m)?js$/.test(f.abs) && pkg && !wholes.includes(pkg)) {
      const src = fs.readFileSync(f.abs, "utf8");
      for (const w of wholes) {
        // require(), require.resolve(), import(), `from`, with any of the three
        // quote characters (the pre-release review: a resolve() or a template
        // literal slipped past the first draft's single and double quotes).
        if (src.includes(w) && new RegExp(`(?:\\brequire(?:\\.resolve)?\\s*\\(|\\bfrom\\s*|\\bimport\\s*\\(|\\bimport\\s+)\\s*["'\`]${w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`/]`).test(src)) {
          if (!requirers.has(w)) requirers.set(w, []);
          requirers.get(w).push(where);
        }
      }
    }
  }
  for (const [w, who] of requirers) {
    problems.push(`${who.join(", ")} name${who.length === 1 ? "s" : ""} ${w} in a require/import, and the table deletes ${w} whole — decide whether that runs, then fix TABLE in scripts/prune-runtime-deps.cjs`);
  }
  // A link dangles after the prune when its target is a deleted FILE, or a
  // DIRECTORY a rule empties and removeEmptyDirs then removes — the first draft
  // checked only files, so a link to node-addon-api/ or better-sqlite3/deps/
  // survived the prune pointing at nothing (the pre-release review).
  const doomed = new Set(remove.map((r) => r.abs));
  const roots = links.length ? pruneRoots(nm) : [];
  const survivesUnder = (dir) => files.some((f) => !doomed.has(f.abs) && f.abs.startsWith(dir + path.sep))
    || links.some((x) => x.abs.startsWith(dir + path.sep));
  for (const l of links) {
    let target;
    try { target = path.resolve(path.dirname(l.abs), fs.readlinkSync(l.abs)); } catch (_) { continue; }
    let dies = doomed.has(target) || [...doomed].some((d) => target.startsWith(d + path.sep));
    if (!dies && roots.some((r) => target === r || target.startsWith(r + path.sep))) {
      let isDir = false;
      try { isDir = fs.statSync(target).isDirectory(); } catch (_e) { /* already dangling: not ours */ isDir = false; }
      dies = isDir && !survivesUnder(target);
    }
    if (dies) problems.push(`${path.relative(path.dirname(nm), l.abs)} links to ${path.relative(path.dirname(nm), target)}, which the table deletes`);
  }
  return { problems, remove, natives };
}

// Directories a rule empties: a package removed whole, or a removed / outputs /
// prebuilds directory. Emptied ones are removed after the files go; a directory
// some rule did not touch is left as it was, empty or not.
function pruneRoots(nm) {
  const roots = [];
  for (const pkg of walk(nm).pkgs) {
    const entry = TABLE[pkg.name];
    if (!entry) continue;
    if (entry.whole) { roots.push(pkg.root); continue; }
    for (const p of [...(entry.remove || []), ...(entry.outputs || []), ...(entry.prebuilds || [])]) roots.push(path.join(pkg.root, p));
  }
  return roots.filter((r) => { try { return fs.lstatSync(r).isDirectory(); } catch (_) { return false; } });
}

function removeEmptyDirs(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory() && !ent.isSymbolicLink()) removeEmptyDirs(path.join(dir, ent.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function summarise(remove) {
  const per = new Map();
  for (const r of remove) {
    const s = per.get(r.pkg) || { files: 0, bytes: 0 };
    s.files++; s.bytes += r.bytes;
    per.set(r.pkg, s);
  }
  const kib = (b) => `${(b / 1024).toFixed(1)} KiB`;
  const lines = [...per].sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([pkg, s]) => `  ${pkg}: ${s.files} file${s.files === 1 ? "" : "s"}, ${kib(s.bytes)}`);
  const total = remove.reduce((n, r) => n + r.bytes, 0);
  return { lines, total, text: `${remove.length} file${remove.length === 1 ? "" : "s"}, ${kib(total)} (${(total / 1048576).toFixed(1)} MiB)` };
}

function main() {
  const { nm, mode } = parseArgs(process.argv.slice(2));
  if (mode === "apply") guardForApply(nm);
  else if (!fs.existsSync(nm) || !fs.statSync(nm).isDirectory()) fail(`${nm} is not a directory`);

  const before = probe(nm);
  if (before.error) {
    fail(`the probe could not load and exercise ${PROBED.join(", ")} from ${nm}:\n${before.error}`);
  }
  const loadedPaths = [...before.loaded, ...before.ran].sort();
  const loadedIds = new Set(loadedPaths.map(idOf));
  const p = plan(nm, loadedIds);
  if (p.problems.length) fail(`${p.problems.length} decision${p.problems.length === 1 ? "" : "s"} this script cannot take:\n  - ${p.problems.join("\n  - ")}`);

  const sum = summarise(p.remove);
  process.stdout.write(`prune-runtime-deps: the probe loaded ${loadedPaths.length} native file${loadedPaths.length === 1 ? "" : "s"} (SQLite ${before.versions.sqlite}):\n`
    + loadedPaths.map((l) => `  ${path.relative(path.dirname(nm), l)}\n`).join(""));
  if (mode === "check") {
    if (!p.remove.length) { process.stdout.write("prune-runtime-deps: no residue.\n"); process.exit(EXIT_OK); }
    process.stdout.write(`prune-runtime-deps: --apply would remove ${sum.text}:\n${sum.lines.join("\n")}\n`);
    process.exit(EXIT_RESIDUE);
  }

  const roots = pruneRoots(nm);
  for (const r of p.remove) fs.rmSync(r.abs, { force: true });
  for (const r of roots) { if (fs.existsSync(r)) removeEmptyDirs(r); }

  // Re-verify on the pruned tree: the same binaries load, and nothing is left
  // that the plan would act on or refuse.
  const after = probe(nm);
  if (after.error) {
    process.stderr.write(`prune-runtime-deps: FAILED — after pruning, the probe no longer loads:\n${after.error}\n`);
    process.exit(EXIT_REFUSED);
  }
  const afterPaths = [...after.loaded, ...after.ran].sort();
  if (JSON.stringify(afterPaths) !== JSON.stringify(loadedPaths)) {
    process.stderr.write(`prune-runtime-deps: FAILED — the pruned tree loads a different set of binaries:\n  before: ${loadedPaths.join(", ")}\n  after:  ${afterPaths.join(", ")}\n`);
    process.exit(EXIT_REFUSED);
  }
  const again = plan(nm, new Set(afterPaths.map(idOf)));
  if (again.problems.length || again.remove.length) {
    process.stderr.write(`prune-runtime-deps: FAILED — the pruned tree still carries residue:\n  - ${[...again.problems, ...again.remove.map((r) => path.relative(path.dirname(nm), r.abs))].join("\n  - ")}\n`);
    process.exit(EXIT_REFUSED);
  }
  process.stdout.write((p.remove.length ? `prune-runtime-deps: removed ${sum.text}:\n${sum.lines.join("\n")}\n` : "prune-runtime-deps: nothing to remove.\n")
    + `prune-runtime-deps: re-verified — the same ${afterPaths.length} native file${afterPaths.length === 1 ? "" : "s"} load, and no build input or foreign binary is left.\n`);
  process.exit(EXIT_OK);
}

main();
