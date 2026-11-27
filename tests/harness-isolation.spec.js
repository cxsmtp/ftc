// @ts-check
//
// v8.3.29 — THE PER-FILE ISOLATION HARNESS DOES WHAT IT CLAIMS.
//
// Two defects in `tests/isolated-test.js`, both measured, neither visible to any
// test in the suite because they are properties of the harness rather than of
// the platform:
//
//   1. `base.test.beforeAll(...)` is registered at IMPORT time, and Node caches
//      the module by path — so a worker running several spec files registered a
//      recycle only for the FIRST of them. Measured: 8 spec files across 2
//      workers gave 3 module evaluations and TWO recycles. Isolation was per
//      WORKER, i.e. the pre-v7.20.0 model that release set out to replace, and
//      the v8.3.28 seeded-fixture `afterAll` guard was equally inert for every
//      file but the first.
//
//   2. `_killCurrent` opened with `if (!_child) return;`, which skipped the
//      PORT-FREE WAIT as well as the kill. A worker does not always own the
//      server it is replacing — Playwright starts a fresh worker process for a
//      spec file, and its handle is legitimately null while the previous file's
//      server is still alive — so the recycle went on to wipe the data directory
//      and bind the port underneath a live server.
//
// These tests are about the HARNESS, so they drive its primitives directly
// rather than through a spec's behaviour: a behavioural version would have to
// assert across two spec files, which is the very thing the harness controls.
const path = require("path");
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const { test, expect, _killCurrent, _killServerOnPort, _waitPortFree, guardFixedPortSpec, _serverDeathError } = require("./isolated-test");
const { serverEnv } = require("./server-env");

const PORT_BASE = parseInt(process.env.TEST_PORT_BASE || "4567", 10);
const DECOY_PORT = PORT_BASE + 170;      // a stand-in for the previous file's server
const STRANGER_PORT = PORT_BASE + 171;   // a listener that is NOT ours

/** True when something already holds `port`. */
function portHeld(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => { probe.close(); resolve(true); });
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, "127.0.0.1");
  });
}

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.3.29 — the isolation harness", () => {
  test("a recycle with NO handle still kills the previous file's server and waits for its port", async () => {
    const dataDir = path.resolve(__dirname, "..", `data-harness-${DECOY_PORT}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        ...serverEnv(0),
        PORT: String(DECOY_PORT), DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        BASE_URL: `http://127.0.0.1:${DECOY_PORT}`,
        // v7.15.30 — an ambient --require/--inspect on the runner must not reach
        // a spawned server whose exit code this test asserts on.
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (b) => { log = (log + b).slice(-2000); });
    child.stderr.on("data", (b) => { log = (log + b).slice(-2000); });
    try {
      // PRECONDITION, asserted: without a decoy that is genuinely listening this
      // test would pass against any build, including one that kills nothing.
      await expect.poll(() => portHeld(DECOY_PORT),
        { timeout: 40000, intervals: [100, 200, 400, 800] }).toBe(true);

      // THE SUBJECT. `null` is the handle every FRESH WORKER PROCESS holds for
      // the server it is about to replace — it did not spawn it.
      await _killCurrent(DECOY_PORT, null);

      expect(await portHeld(DECOY_PORT),
        `the port must be free once the recycle returns, or _spawnAndSeed binds under a live server:\n${log}`
      ).toBe(false);
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null,
        { timeout: 5000 }).toBe(true);
    } finally {
      try { child.kill("SIGKILL"); } catch (_) {}
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("...but it never kills a process that is not this repo's server", async () => {
    // THE CONTROL, and the reason the kill is addressed by port rather than by
    // `pkill -f "node server.js"` — which has taken out an operator's dev server
    // in this tree before. A stranger on the port must SURVIVE, and the recycle
    // must then fail loudly on the port wait rather than quietly killing it.
    const stranger = net.createServer();
    await new Promise((r) => stranger.listen(STRANGER_PORT, "127.0.0.1", r));
    try {
      _killServerOnPort(STRANGER_PORT);
      await new Promise((r) => setTimeout(r, 300));
      expect(stranger.listening, "a foreign listener must be left alone").toBe(true);
      await expect(_waitPortFree(STRANGER_PORT, 800)).rejects.toThrow(/never freed/);
    } finally {
      await new Promise((r) => stranger.close(r));
    }
  });

  test("the recycle resolves the port's owner from /proc, never by shelling out", () => {
    // CI-ONLY FAILURE MADE LOCAL. The pinned CI image ships NEITHER `lsof` NOR
    // `ss` (verified against the image the workflow pins), so the first version
    // of the kill-by-port was a silent no-op there: it caught the missing binary,
    // returned "nothing to kill", and the recycle then failed 15 s later with a
    // bare "port 4737 never freed" — a message that names nothing about the
    // cause. It shipped red on main exactly once.
    //
    // Comments are stripped first, because the paragraph above NAMES the tools
    // it forbids (the v7.21.13 class), and both comment forms are handled in ONE
    // left-to-right alternation so a `/*` inside a `//` line cannot swallow code.
    const src = fs.readFileSync(path.join(__dirname, "isolated-test.js"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const tool of ["lsof", "\"ss\"", "execFileSync", "spawnSync"]) {
      expect(src.includes(tool),
        `isolated-test.js must not depend on ${tool} — the CI image has no lsof and no ss, so a port lookup that shells out silently kills nothing there`
      ).toBe(false);
    }
    // ...and the thing it must use instead is actually referenced.
    expect(src).toContain("/proc/net/tcp");
  });

  test("v8.12.4: a dead worker server is reported by NAME, with its exit status and last output", () => {
    // The per-test death check in isolated-test.js. Driven against stand-in
    // child objects rather than by killing the real server, because a genuine
    // death fails the test it happens in — which is the point of the check, and
    // exactly what a lock over it cannot afford. The process-global handle is
    // swapped and ALWAYS restored, or this file's own afterEach would see the fake.
    const G = globalThis.__hackarenaIsolatedTest;
    const real = G.child, realLog = G.log;
    try {
      G.child = { exitCode: null, signalCode: null };
      expect(_serverDeathError("x"), "a LIVE server must not be reported").toBeNull();
      G.child = null;
      expect(_serverDeathError("x"), "no server at all (mid-recycle) must not be reported").toBeNull();
      G.child = { exitCode: 1, signalCode: null };
      G.log = "Error: boom at handler (server.js:1)\n";
      const e = _serverDeathError("while this test was running");
      expect(e && e.message).toContain("exited with code 1");
      expect(e.message, "the server's own last words must be quoted").toContain("boom at handler");
      G.child = { exitCode: null, signalCode: "SIGKILL" };
      expect(_serverDeathError("x").message, "a signal death has exitCode null — it must still be caught").toContain("SIGKILL");
    } finally { G.child = real; G.log = realLog; }
  });

  test("the harness is re-evaluated per spec file, so its hooks are registered per FILE", () => {
    // The mechanism, asserted directly: `isolated-test` removes itself from
    // require.cache so the NEXT spec file re-runs it and registers its own
    // recycle and its own afterAll guards. Left in the cache, a worker's second
    // and later files silently get neither.
    expect(require.cache[require.resolve("./isolated-test")],
      "isolated-test must not remain in require.cache, or per-file isolation is per-WORKER"
    ).toBeUndefined();
  });
});
