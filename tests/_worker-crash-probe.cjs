// v7.15.25 — make a Playwright worker crash SELF-DOCUMENTING.
//
// A dead worker reports only "worker process exited unexpectedly (code=1,
// signal=null)" with no stack. Playwright does not surface worker stderr, so
// the real cause is invisible; diagnosing one has already cost several CI round
// trips and three wrong hypotheses.
//
// v7.15.24 hooked uncaughtException + unhandledRejection and captured NOTHING,
// which is itself the finding: the worker is not dying from a JS error. It is
// exiting deliberately. So this version hooks the EXIT PATH — the only thing
// left that can produce code=1 with no exception — plus signals, and records a
// marker at load so "no output" can be distinguished from "probe never ran".
//
// Loaded into every node process (workers AND the per-worker servers) via
// NODE_OPTIONS=--require. It changes no behaviour: handlers observe and then
// let the original outcome stand.
const fs = require("fs");
const path = require("path");

const DIR = path.join(process.env.PW_CRASH_DIR || process.cwd(), "test-results");
const TAG = `${path.basename(process.argv[1] || "node")}-${process.pid}`;

function write(name, body) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, name), body);
  } catch (_) { /* diagnostics must never throw */ }
}
function record(kind, detail) {
  write(`worker-crash-${TAG}.log`,
    `\n=== ${kind}  pid=${process.pid}  argv=${JSON.stringify(process.argv.slice(1, 3))}  ${new Date().toISOString()}\n` +
    `${detail}\n`);
}

// Proof-of-life: if this file is absent from the artifact, the probe never
// loaded and any conclusion drawn from its silence would be wrong.
write("worker-crash-PROBE-LOADED.log", `${TAG} loaded ${new Date().toISOString()} node=${process.version}\n`);

process.on("uncaughtException", (e) => { record("uncaughtException", (e && e.stack) || e); process.exit(1); });
process.on("unhandledRejection", (e) => { record("unhandledRejection", (e && e.stack) || e); process.exit(1); });
// v7.15.30 — a probe MUST NOT change the outcome it observes. The first
// version exited 1 from the signal handler, and because NODE_OPTIONS is
// inherited by every child, it turned the graceful-shutdown test's spawned
// server into a code-1 exit and failed a test about clean SIGTERM handling.
// Merely registering a signal handler already suppresses Node's default
// terminate-on-signal, so transparency needs both branches below.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGABRT"]) {
  try {
    process.on(sig, () => {
      record(`signal ${sig}`, new Error("signal received").stack);
      if (process.listenerCount(sig) > 1) return; // the app handles it — stand aside
      process.removeAllListeners(sig);            // nobody else: restore the default
      try { process.kill(process.pid, sig); } catch (_) { process.exit(1); }
    });
  } catch (_) {}
}
// The load-bearing hook: a non-zero exit with no exception above means someone
// called process.exit() deliberately. The stack captured here names the caller.
process.on("exit", (code) => {
  if (code === 0) return;
  record(`exit code=${code}`, new Error("exit trace — the frames below are the exit path").stack);
});
