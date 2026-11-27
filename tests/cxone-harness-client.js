// v8.12.7 — the parent half of tests/cxone-provision-harness.cjs, shared by the
// CxOne provisioning and withdrawal specs (find them with `grep -l
// cxone-harness-client tests/`; a list here goes stale).
//
// NOT A SPEC. It requires only fs / os / path / child_process — nothing from
// lib/ and not db.js, which opens the database at require time (v7.20.2): the
// scenario runs in a spawned child against its own throwaway data directory,
// and this module only spawns it and reads back what it printed and logged.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HARNESS = path.join(__dirname, "cxone-provision-harness.cjs");

/** Run ONE provisioning scenario in a fresh child, against a fresh data dir.
 *  `opts.env` adds variables to the child's env (e.g. EVENT_RETENTION_DAYS); it
 *  can never override the hermetic pins below, which are written after it. */
function provision(S, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxone-f2-"));
  try {
    // A LITERAL env, deliberately not a spread of process.env: TRUST_PROXY and
    // friends stay out (hermetic), DATA_DIR / UPLOADS_DIR are decided at the site
    // (v8.8.26), NODE_OPTIONS is scrubbed (v7.15.30), TMPDIR is pinned so the
    // child's own under-tmpdir refusal agrees with the path we hand it.
    const r = spawnSync(process.execPath, [HARNESS, JSON.stringify(S)], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000,
      env: {
        ...(opts.env || {}),
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(),
        NODE_OPTIONS: "", NODE_ENV: "test", BASE_URL: "http://localhost", LOG_CONSOLE_MIRROR: "0",
        DATA_DIR: path.join(tmp, "data"), UPLOADS_DIR: path.join(tmp, "uploads"),
      },
    });
    if (r.status !== 0) {
      throw new Error(`harness exited ${r.status} (${r.signal || "no signal"}) for ${JSON.stringify(S)}\n`
        + `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    }
    const o = JSON.parse(r.stdout.trim().split("\n").pop());
    o.appLog = fs.existsSync(o.logDir)
      ? fs.readdirSync(o.logDir).filter(f => f.startsWith("app-"))
        .flatMap(f => fs.readFileSync(path.join(o.logDir, f), "utf8").split("\n").filter(Boolean))
      : [];
    o.abandoned = o.appLog.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(j => j && j.event_type === "cxone_provision_abandoned").map(j => j.details);
    const at = Object.values(o.fired).find(v => v !== null);
    o.after = at === undefined ? [] : o.calls.slice(at);
    o.puts = o.calls.filter(c => c.startsWith("PUT "));
    o.dels = o.calls.filter(c => c.startsWith("DELETE "));
    o.provisioned = o.events.filter(e => e.type === "cxone_provisioned");
    // v8.12.7 — every audit line, and the calls each post-provisioning step made.
    o.log = o.appLog.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    o.logOf = (type) => o.log.filter(j => j.event_type === type).map(j => j.details);
    o.stepCalls = (i) => o.calls.slice(o.stepLog[i].from, o.stepLog[i].to);
    o.stepCallsFull = (i) => o.callsFull.slice(o.stepLog[i].from, o.stepLog[i].to);
    o.withdrawCalls = o.calls.slice(o.provisionCalls);
    // v8.14 — another participant's cxone_* History, in order, and their bindings.
    o.eventsOf = (uid) => ((o.people || {})[uid] || { events: [] }).events.map(e => ({ type: e.type, ...e.details }));
    o.bindingsOf = (uid) => ((o.people || {})[uid] || { bindings: [] }).bindings;
    // …and every cxone_* row the DATABASE holds for an id, whether or not that
    // user still exists (`eventsOf` sees only people still there).
    o.dbEventsOf = (uid) => (o.dbEvents || []).filter(e => e.userId === uid).map(({ userId, ...e }) => e);
    o.dump = () => JSON.stringify({ calls: o.calls, fired: o.fired, alive: o.alive, member: o.member,
      events: o.events, abandoned: o.abandoned, stepLog: o.stepLog, ledger: o.ledger, unc: o.unc,
      people: o.people, holdLog: o.holdLog, removals: o.removals, retries: o.retries, concurrentErrors: o.concurrentErrors });
    return o;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { provision };
