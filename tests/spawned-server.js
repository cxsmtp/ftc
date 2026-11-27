// @ts-check
//
// A SPAWNED SERVER IS READY WHEN *IT* ANSWERS (CLAUDE.md, Spawned servers).
//
// A spec that spawns its own server.js binds a port another server may still
// hold: the test before it, killed a moment ago (SIGKILL returns before the
// socket is released), or a run of its own that died. A status code answers for
// whoever holds the port, and a TCP connect for anything listening, so readiness
// is a positive identity: /api/config with a `server_started_at` no earlier than
// the spawn, then the child's own `.superadmin-password`, which only a server
// started on that data directory writes, once it has passed its own port check.
// Every spec that spawns server.js to talk to it waits through here or asks
// `server_started_at` itself (scanner and behaviour:
// tests/spawned-server-readiness.spec.js).
const fs = require("fs");
const path = require("path");

/**
 * Resolves with the child's superadmin password once `child` answers at `base`.
 * `spawnedAt` is Date.now() read BEFORE spawn(), so no server started earlier can
 * pass for the child. Throws, with the child's output, if the child exits first
 * or the deadline passes.
 */
async function readySpawnedServer({ base, child, dataDir, spawnedAt, output = () => "", timeoutMs = 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer yet";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited early (${child.signalCode || `code ${child.exitCode}`}):\n${output().slice(-1500)}`);
    }
    try {
      const r = await fetch(`${base}/api/config`);
      if (r.status !== 200) last = `status ${r.status}`;
      else {
        const startedAt = Date.parse((await r.json()).server_started_at || "");
        if (Number.isFinite(startedAt) && startedAt >= spawnedAt) {
          return fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
        }
        last = Number.isFinite(startedAt) ? `a server started ${spawnedAt - startedAt} ms before the spawn answers` : "an answer with no start time";
      }
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became ready (${last}):\n${output().slice(-1500)}`);
}

module.exports = { readySpawnedServer };
