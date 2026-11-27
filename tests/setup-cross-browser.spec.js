// @ts-check
//
// v8.13.4 — scripts/setup-cross-browser.sh, driven for real against stubs.
//
// The script side-loads Firefox's newer libnss3 and WebKit's image codecs into a
// shim, and the release that bumped Playwright to 1.64 taught it to refresh the
// NSS pin and to honour PLAYWRIGHT_BROWSERS_PATH. The pre-release review found
// that both halves did less than README promised:
//   • it DELETED the superseded deb before fetching the new one and then wiped
//     the shim whatever the fetch did, so an offline re-run destroyed a working
//     shim (or died on a raw `dpkg-deb … '*.deb'` error);
//   • it read PLAYWRIGHT_BROWSERS_PATH after `cd`-ing into the shim, so a
//     relative value — and Playwright's own `0` — fell through to "WebKit not
//     installed yet", and the NSS self-check skipped in silence.
// The fix-delta review then found the first repair still short of Playwright's
// own rule (the npm_config_ spelling, XDG_CACHE_HOME, INIT_CWD) and the shim
// rebuild still destructive: it deleted $SHIM/usr BEFORE unpacking, so a corrupt
// deb left an empty shim. The last describe holds both.
//
// HERMETIC: the script is copied into a temp tree with its one SHIM line pointed
// there (so the real /tmp/pw-libs a cross-browser run uses is never touched),
// and apt-get / wget / dpkg-deb / ldd are recording stubs first on PATH, so
// nothing reaches the network or the host's package tools.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "setup-cross-browser.sh");
const SHIM_LINE = 'SHIM="/tmp/pw-libs"';
const NEW_NSS = "libnss3_3.127-1_amd64.deb";
const OLD_NSS = "libnss3_3.114-1_amd64.deb";

/** A fresh tree: <T>/scripts/setup-cross-browser.sh (SHIM → <T>/shim) and <T>/bin stubs. */
function makeTree() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "setupxb-"));
  const src = fs.readFileSync(SCRIPT, "utf8");
  expect(src.split("\n").filter(l => l === SHIM_LINE).length,
    "PRECONDITION: the script carries exactly one SHIM line to point at the temp tree").toBe(1);
  fs.mkdirSync(path.join(T, "scripts"));
  fs.writeFileSync(path.join(T, "scripts", "setup-cross-browser.sh"),
    src.replace(SHIM_LINE, `SHIM="${path.join(T, "shim")}"`), { mode: 0o755 });
  const bin = path.join(T, "bin");
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  // apt-get download never succeeds: the codec debs are not what is under test.
  stub("apt-get", 'echo "apt-get $*" >> "$STUB_LOG"; exit 100');
  // wget: WGET_MODE=ok writes a deb to the -O target; anything else fails.
  stub("wget", [
    'echo "wget $*" >> "$STUB_LOG"',
    'out=""; while [ $# -gt 0 ]; do if [ "$1" = "-O" ]; then out="$2"; shift; fi; shift; done',
    'if [ "${WGET_MODE:-}" = ok ]; then printf "deb" > "$out"; exit 0; fi',
    ': > "$out"; exit 4',
  ].join("\n"));
  // dpkg-deb -x <deb> <dir>: one .so named after the deb, so the shim's contents
  // say which debs were extracted.
  stub("dpkg-deb", [
    'echo "dpkg-deb $*" >> "$STUB_LOG"',
    '[ -f "$2" ] || { echo "dpkg-deb: error: failed to read archive \'$2\'" >&2; exit 2; }',
    // A deb whose content is "corrupt" fails part-way, AFTER writing one stray
    // file — the shape of a truncated download dpkg-deb gives up on.
    'if grep -q corrupt "$2"; then mkdir -p "$3/usr/lib/x86_64-linux-gnu"; : > "$3/usr/lib/x86_64-linux-gnu/partial.so.0"; echo "dpkg-deb: error: unexpected end of file" >&2; exit 2; fi',
    'mkdir -p "$3/usr/lib/x86_64-linux-gnu"; : > "$3/usr/lib/x86_64-linux-gnu/$(basename "$2" .deb).so.1"',
  ].join("\n"));
  stub("ldd", 'echo "ldd $*" >> "$STUB_LOG"; echo "	libnss3.so => /x (0x0)"');
  return { T, bin, debs: path.join(T, "shim", "debs"), libdir: path.join(T, "shim", "usr", "lib", "x86_64-linux-gnu"), log: path.join(T, "stub.log") };
}

function run(tree, { env = {}, cwd } = {}) {
  const r = spawnSync("bash", [path.join(tree.T, "scripts", "setup-cross-browser.sh")], {
    cwd: cwd || tree.T,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${tree.bin}:/usr/bin:/bin`,
      HOME: path.join(tree.T, "home"),
      STUB_LOG: tree.log,
      ...env,
    },
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/** A browsers directory holding one WebKit and one Firefox revision. */
function plantBrowsers(dir) {
  fs.mkdirSync(path.join(dir, "webkit-9999", "minibrowser-wpe", "sys", "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "firefox-9999", "firefox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "firefox-9999", "firefox", "libxul.so"), "");
}

test.describe("v8.13.4 — setup-cross-browser.sh refreshes the shim without destroying it", () => {
  test("an OFFLINE re-run keeps the cached NSS deb and does not die on a raw dpkg-deb error", () => {
    const tree = makeTree();
    try {
      fs.mkdirSync(tree.debs, { recursive: true });
      fs.writeFileSync(path.join(tree.debs, OLD_NSS), "deb");
      const r = run(tree);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("kept what was cached");
      expect(fs.existsSync(path.join(tree.debs, OLD_NSS)),
        "the superseded deb is kept until the new one has ARRIVED").toBe(true);
      expect(fs.readdirSync(tree.debs).filter(f => f.endsWith(".part")), "no partial download is left behind").toEqual([]);
      expect(fs.existsSync(path.join(tree.libdir, "libnss3_3.114-1_amd64.so.1")),
        "the shim is rebuilt from what WAS cached").toBe(true);
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("with NO deb at all, the existing shim is left as it was", () => {
    const tree = makeTree();
    try {
      fs.mkdirSync(tree.libdir, { recursive: true });
      fs.writeFileSync(path.join(tree.libdir, "libnss3.so"), "working");
      const r = run(tree);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toMatch(/dpkg-deb: error/);
      expect(r.out).toContain("existing shim");
      expect(fs.readFileSync(path.join(tree.libdir, "libnss3.so"), "utf8"), "the working shim survives").toBe("working");
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("ONLINE, the new deb replaces the superseded one and the shim holds only the new release", () => {
    const tree = makeTree();
    try {
      fs.mkdirSync(tree.debs, { recursive: true });
      fs.writeFileSync(path.join(tree.debs, OLD_NSS), "deb");
      const r = run(tree, { env: { WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(fs.readdirSync(tree.debs).sort()).toEqual([NEW_NSS]);
      const libs = fs.readdirSync(tree.libdir);
      expect(libs).toContain("libnss3_3.127-1_amd64.so.1");
      expect(libs, "the superseded release does not survive into the shim").not.toContain("libnss3_3.114-1_amd64.so.1");
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("a RELATIVE PLAYWRIGHT_BROWSERS_PATH means the caller's directory", () => {
    const tree = makeTree();
    try {
      const caller = path.join(tree.T, "caller");
      plantBrowsers(path.join(caller, "pwb"));
      const r = run(tree, { cwd: caller, env: { PLAYWRIGHT_BROWSERS_PATH: "pwb", WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`Copying codec libs into WebKit WPE sys/lib (${path.join(caller, "pwb")}/webkit-9999`);
      expect(r.out, "the NSS check runs against that Firefox").toContain("firefox-9999: NSS resolves against the shim");
      expect(r.out).not.toMatch(/no WebKit found|no Firefox found/);
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("PLAYWRIGHT_BROWSERS_PATH=0 means the browsers inside node_modules", () => {
    const tree = makeTree();
    try {
      const local = path.join(tree.T, "node_modules", "playwright-core", ".local-browsers");
      plantBrowsers(local);
      const r = run(tree, { env: { PLAYWRIGHT_BROWSERS_PATH: "0", WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`(${local}/webkit-9999`);
      expect(r.out).toContain("firefox-9999: NSS resolves against the shim");
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("CONTROL: with nothing installed it SAYS so — for WebKit and for the NSS check", () => {
    const tree = makeTree();
    try {
      const r = run(tree, { env: { WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("no WebKit found under");
      expect(r.out, "a skipped NSS check is announced, never silent").toContain("no Firefox found under");
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });
});

test.describe("v8.13.4 fix-delta — Playwright's own path rule, and a rebuild that cannot empty the shim", () => {
  test("a relative path resolves against INIT_CWD (where `npm run` started), not the script's cwd", () => {
    const tree = makeTree();
    try {
      const caller = path.join(tree.T, "sub", "dir");
      plantBrowsers(path.join(caller, "pwb"));
      // `npm run` changes into the package root; INIT_CWD keeps where the user was.
      const r = run(tree, { cwd: tree.T, env: { PLAYWRIGHT_BROWSERS_PATH: "pwb", INIT_CWD: caller, WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`(${path.join(caller, "pwb")}/webkit-9999`);
      expect(r.out).toContain("firefox-9999: NSS resolves against the shim");
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("with no PLAYWRIGHT_BROWSERS_PATH the default honours XDG_CACHE_HOME", () => {
    const tree = makeTree();
    try {
      const xdg = path.join(tree.T, "xdg");
      plantBrowsers(path.join(xdg, "ms-playwright"));
      // A decoy at $HOME/.cache, which is where the first draft looked.
      plantBrowsers(path.join(tree.T, "home", ".cache", "ms-playwright-decoy"));
      const r = run(tree, { env: { XDG_CACHE_HOME: xdg, WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`(${path.join(xdg, "ms-playwright")}/webkit-9999`);
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("npm_config_playwright_browsers_path is read when PLAYWRIGHT_BROWSERS_PATH is not set — and a SET-but-empty one is not overridden by it", () => {
    const tree = makeTree();
    try {
      const viaNpm = path.join(tree.T, "via-npm");
      plantBrowsers(viaNpm);
      const r = run(tree, { env: { npm_config_playwright_browsers_path: viaNpm, WGET_MODE: "ok" } });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`(${viaNpm}/webkit-9999`);
      // Playwright stops at the first variable that is SET, and "" then means the default.
      const r2 = run(tree, { env: { PLAYWRIGHT_BROWSERS_PATH: "", npm_config_playwright_browsers_path: viaNpm, WGET_MODE: "ok" } });
      expect(r2.status, r2.out).toBe(0);
      expect(r2.out).toContain(`no WebKit found under ${path.join(tree.T, "home", ".cache", "ms-playwright")}`);
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("a deb that will not unpack leaves the WORKING shim untouched and the run fails, saying so", () => {
    const tree = makeTree();
    try {
      fs.mkdirSync(tree.libdir, { recursive: true });
      fs.writeFileSync(path.join(tree.libdir, "libnss3.so"), "working");
      fs.mkdirSync(tree.debs, { recursive: true });
      // Sorted AFTER a good deb, so one deb has already been unpacked when it fails.
      fs.writeFileSync(path.join(tree.debs, "a-good_1_amd64.deb"), "deb");
      fs.writeFileSync(path.join(tree.debs, NEW_NSS), "corrupt");
      const r = run(tree);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("could not unpack");
      expect(r.out).toContain("the shim was NOT rebuilt");
      expect(fs.readdirSync(tree.libdir).sort(), "nothing from the half-finished rebuild reaches the shim").toEqual(["libnss3.so"]);
      expect(fs.readFileSync(path.join(tree.libdir, "libnss3.so"), "utf8")).toBe("working");
      expect(fs.existsSync(path.join(tree.T, "shim", ".staging")), "the staging tree is cleaned up").toBe(false);
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });

  test("CONTROL: a successful rebuild REPLACES the old shim rather than merging into it", () => {
    const tree = makeTree();
    try {
      fs.mkdirSync(tree.libdir, { recursive: true });
      fs.writeFileSync(path.join(tree.libdir, "stale-from-an-old-pin.so.9"), "old");
      fs.mkdirSync(tree.debs, { recursive: true });
      fs.writeFileSync(path.join(tree.debs, NEW_NSS), "deb");
      const r = run(tree);
      expect(r.status, r.out).toBe(0);
      expect(fs.readdirSync(tree.libdir).sort()).toEqual(["libnss3_3.127-1_amd64.so.1"]);
      expect(fs.existsSync(path.join(tree.T, "shim", "usr.old"))).toBe(false);
      expect(fs.existsSync(path.join(tree.T, "shim", ".staging"))).toBe(false);
    } finally { fs.rmSync(tree.T, { recursive: true, force: true }); }
  });
});
