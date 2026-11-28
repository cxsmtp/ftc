// @ts-check
//
// v7.20.0 — this used to boot-and-seed one server per worker. It no longer
// does: `tests/isolated-test.js` replaces the worker's server (same port, wiped
// data directory, fresh seed) before EVERY spec file, because the isolation
// boundary the tests need is the FILE, not the worker.
//
// What remains is the one job that genuinely belongs before the run: making
// sure nothing is already squatting on the ports the workers are about to use.
// A leaked server from an interrupted run holds its port, the next run's spawn
// dies with "Port N is already in use", and — because the surviving server has
// a different SESSION_SECRET — the symptom presents as `csrf_invalid` on login,
// which points nowhere near the cause. (Diagnosed the hard way while measuring
// this design.)
const net = require("net");
const { PORT_BASE, portFor, blockedPortsIn } = require("./server-env");
const { execFileSync } = require("child_process");
const { startDiskProbe } = require("./ci-disk-probe");

// NO CORE DUMPS FROM ANYTHING THIS RUN STARTS (KEEP_CORE_DUMPS=1 keeps them).
// The CI runner pipes a crash's core dump to its host's handler, which wrote one
// (12 GB in 90 s, a large address space mostly reserved) onto the runner's own
// disk until the disk was full, then dropped it; whichever test ran at that
// moment failed (16 Nov 2026). 1 is the core limit at which the kernel itself
// refuses to dump, to a file or to a pipe; 0 is only passed on to a pipe's
// handler, and the systemd handler is told to ignore it. Playwright starts its
// workers after this, so every worker, browser and server inherits it.
function noCoreDumps() {
  if (process.env.KEEP_CORE_DUMPS === "1" || process.platform !== "linux") return;
  try {
    execFileSync("prlimit", [`--pid=${process.pid}`, "--core=1:1"], { stdio: "ignore", timeout: 5000 });
  } catch (e) {
    process.stderr.write(`[disk] could not turn core dumps off: ${String(e.message).split("\n")[0]}\n`);
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => { probe.close(); resolve(true); });
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, "127.0.0.1");
  });
}

// v8.3.26 — SPAWNER OFFSETS ARE PART OF THE PRE-FLIGHT.
//
// The guard below used to sweep the worker-SLOT ports only, so a spawned server
// leaked by an interrupted run — `isolated-test.js` registers exit handlers for
// the worker's own child and for NO spawner child, so Ctrl-C during any of the
// fourteen spawner tests leaks one — held a registry port invisibly. The next
// run's spawn then died with EADDRINUSE inside a spec, which is where a
// half-second `waitForPort` reports success against the SURVIVING server and the
// spec quietly tests a foreign process (v7.21.10).
//
// Kept deliberately as a flat list rather than derived from the specs: this file
// runs before Playwright has loaded anything, and the source scanner in
// `functional-core-b.api.spec.js` is what keeps it in step with the code.
const SPAWNER_OFFSETS = [100, 101, 102, 103, 104, 106, 110, 111, 113, 114, 115, 117, 120, 130, 131, 140, 141, 142, 150, 151, 160, 161, 170, 171, 174, 175, 176, 180, 181, 186, 191, 192, 195, 196, 197, 198, 199];

module.exports = async function globalSetup(config) {
  const N = config.workers;
  const busy = [];
  // CHECK EVERY PORT BEFORE TOUCHING ANYTHING ON DISK.
  //
  // v8.3.26 — this loop used to `rmSync(dataDirFor(i))` on its way past each
  // port, so a SECOND concurrent run (a stray `npx playwright test`, another
  // terminal, an editor task) deleted the databases of the run already in flight
  // and only THEN reported "Ports already in use". The live run did not fail
  // where the collision was: it failed dozens of tests later with
  // `Cannot open database because the directory does not exist` and
  // `the fixture needs more than one challenge`, neither of which names a second
  // run. Measured — that is exactly how two failures were manufactured while
  // diagnosing this suite.
  //
  // The wipe is not moved, it is DELETED: `isolated-test.js` already
  // `rmSync`s the data directory before EVERY spec file (that is what makes a
  // file's seed identical to every other file's), so this one has been dead
  // weight since v7.20.0 — and dead weight that destroys a running suite.
  // A port fetch() refuses (tests/server-env.js FETCH_BLOCKED_PORTS) is as
  // unusable as a busy one and quieter: its server boots, every request to it
  // fails "bad port", and the spec reports a server that never answered.
  const blocked = blockedPortsIn([...Array.from({ length: N }, (_, i) => portFor(i)), ...SPAWNER_OFFSETS.map(portFor)]);
  if (blocked.length) {
    throw new Error(
      `TEST_PORT_BASE ${PORT_BASE} puts ${blocked.join(", ")} on the ports fetch() and the browser refuse ` +
      "(\"bad port\"): a test server there boots and is never reached. Choose another TEST_PORT_BASE."
    );
  }
  for (let i = 0; i < N; i++) {
    if (await portInUse(portFor(i))) busy.push(portFor(i));
  }
  // `portFor(n)` IS `PORT_BASE + n`, so it addresses a spawner offset directly —
  // the offsets are deliberately >= 100, far clear of the worker-slot range.
  for (const off of SPAWNER_OFFSETS) {
    if (await portInUse(portFor(off))) busy.push(portFor(off));
  }
  if (busy.length) {
    throw new Error(
      `Ports already in use: ${busy.join(", ")}.\n` +
      "A server from an interrupted run is still listening, or a SECOND test run " +
      "is in progress on this TEST_PORT_BASE. Kill it, or set TEST_PORT_BASE to a " +
      "free range. Leaving it up makes every spawn fail with 'already in use' and " +
      "surfaces as csrf_invalid, which looks like an auth bug rather than a port " +
      "collision — and a concurrent run destroys the other run's databases."
    );
  }
  noCoreDumps();
  // The runner's disk, logged through the run (`[disk]` lines): CI only, or
  // DISK_PROBE=1 here; DISK_PROBE=0 silences it.
  if (process.env.DISK_PROBE === "1" || (process.env.CI === "true" && process.env.DISK_PROBE !== "0")) startDiskProbe();
};
