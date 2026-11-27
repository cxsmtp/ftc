// @ts-check
//
// A SPAWNED SERVER IS READY WHEN *IT* ANSWERS (CLAUDE.md, Spawned servers).
//
// A spec that spawns its own server.js binds a port another server may still
// hold: the test before it, killed a moment ago, or a run of its own that died.
// A readiness loop that took any answer below 500 (or a bare TCP connect) as
// "up" then talked to whoever held the port, and a port clash surfaced as a
// confusing failure far from its cause. Readiness is a positive identity: a
// `server_started_at` no earlier than the spawn, then the child's own
// `.superadmin-password` (tests/spawned-server.js `readySpawnedServer`).
//
//   1. the helper, against a decoy playing the stale server: never ready on it,
//      ready on the same port once the decoy's start postdates the spawn, and
//      an exited child is reported, never waited for;
//   2. a source scanner: every spec spawning server.js waits through the helper
//      or asks `server_started_at` itself, site by site, except the children
//      that are never meant to be ready (a boot that must fail, a decoy killed
//      by port), each decided with its reason below and checked both ways.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { stripJsComments } = require("./doc-registry");
const { readySpawnedServer } = require("./spawned-server");

test.describe("A spawned server's readiness is its identity", () => {
  test("a server started before the spawn is never taken for the child; CONTROL: one started after it is, and the child's own password is read", async () => {
    let stamp = new Date(Date.now() - 60_000).toISOString();   // a server from the test before
    let answered = 0;
    const decoy = http.createServer((req, res) => {
      answered++;
      if (req.url !== "/api/config") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ platform_name: "Decoy", server_started_at: stamp }));
    });
    await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
    const address = decoy.address();
    const base = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawned-ready-"));
    try {
      fs.writeFileSync(path.join(dataDir, ".superadmin-password"), "the-childs-own\n");
      const child = { exitCode: null, signalCode: null };
      const spawnedAt = Date.now();
      await expect(readySpawnedServer({ base, child, dataDir, spawnedAt, timeoutMs: 1500 }),
        "a 200 from a server started before the spawn is not the child")
        .rejects.toThrow(/never became ready \(a server started \d+ ms before the spawn answers\)/);
      expect(answered, "PRECONDITION: the decoy was asked, more than once").toBeGreaterThan(1);
      // CONTROL: the same port answering a start after the spawn is the child,
      // and the password read is the one in the child's own data directory.
      stamp = new Date(spawnedAt + 1).toISOString();
      expect(await readySpawnedServer({ base, child, dataDir, spawnedAt, timeoutMs: 5000 })).toBe("the-childs-own");
      // An answer with no start time is nobody's.
      stamp = "";
      await expect(readySpawnedServer({ base, child, dataDir, spawnedAt, timeoutMs: 800 }))
        .rejects.toThrow(/never became ready \(an answer with no start time\)/);
      // A child that has exited is reported as such, never waited for.
      await expect(readySpawnedServer({ base, child: { exitCode: 1, signalCode: null }, dataDir, spawnedAt, output: () => "boot log", timeoutMs: 2000 }))
        .rejects.toThrow(/server exited early \(code 1\):\nboot log/);
    } finally {
      await new Promise((r) => decoy.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ── the scanner ─────────────────────────────────────────────────────────────
// A child of server.js spawned to be TALKED TO. Built from parts, so this file's
// own text is never a site (and trips no other spawn scanner).
const SPAWN_WORD = "sp" + "awn";
const SITE = new RegExp(`\\b${SPAWN_WORD}\\(\\s*process\\.execPath\\s*,[^;]{0,200}?\\bserver\\.js\\b`, "g");
// What a site's readiness may be: the helper, or its own start-time check.
const IDENTITY = /\breadySpawnedServer\(|\bserver_started_at\b/;
// Sites with no readiness at all, per file, each decided with why its child is
// never meant to be ready. A count, so a new site in one of these files is
// still judged; checked both ways.
const NEVER_READY = new Map([
  ["tests/functional-security-a.api.spec.js", { sites: 1, why: "a duplicate start against the live worker server's own port and data directory, which must exit on its port check: only its exit and output are read" }],
  ["tests/functional-security-c.api.spec.js", { sites: 1, why: "a boot with an https BASE_URL and TRUST_PROXY off, which must exit FATAL: only its exit code and stderr are read" }],
  ["tests/harness-isolation.spec.js", { sites: 1, why: "the decoy for the harness's kill by port: it is killed through its port and never spoken to, so whichever repo server holds the port is the subject" }],
]);

/**
 * [{line, identified, stampedFirst}] for each server.js child spawned in `src`
 * (comments stripped). `stampedFirst`: where the helper waits, the `spawnedAt`
 * it is handed is `Date.now()` read before the spawn with no await between, so
 * nothing started earlier than the spawn can pass for the child (a stamp taken
 * long before, across an await, admits whatever started meanwhile).
 */
function readinessSites(src) {
  const at = [...src.matchAll(SITE)].map((m) => m.index || 0);
  return at.map((start, k) => {
    // A site's readiness is read between it and the next site, at most 8000
    // characters on: a spawn helper and its wait sit together.
    const end = Math.min(k + 1 < at.length ? at[k + 1] : src.length, start + 8000);
    const after = src.slice(start, end);
    const call = after.match(/\breadySpawnedServer\(/);
    let stampedFirst = true;
    if (call) {
      const before = src.slice(Math.max(0, start - 600), start);
      const stamps = [...before.matchAll(/\bspawnedAt\s*=\s*Date\.now\(\)/g)];
      const last = stamps.length ? stamps[stamps.length - 1].index || 0 : -1;
      const passed = /[{,]\s*spawnedAt\s*[,}]/.test(after.slice(call.index || 0, (call.index || 0) + 300));
      stampedFirst = last >= 0 && !/\bawait\b/.test(before.slice(last)) && passed;
    }
    return { line: src.slice(0, start).split("\n").length, identified: IDENTITY.test(after), stampedFirst };
  });
}

test.describe("A spawned server's readiness — the scanner", () => {
  test("every spec that spawns server.js to talk to it waits for the child's identity, never a status or a connect", () => {
    // The detector, on planted text first (anti-vacuity).
    const stamp = "const spawnedAt = Date.now();\n";
    const child = `const child = ${SPAWN_WORD}(process.execPath, [path.resolve(__dirname, "..", "server.js")], { env });\n`;
    const statusLoop = 'for (let i = 0; i < 120 && !up; i++) { const r = await fetch(url + "/api/config"); if (r.status < 500) up = true; }\n';
    const helper = "const pass = await readySpawnedServer({ base, child, dataDir, spawnedAt });\n";
    expect(readinessSites(stamp + child + statusLoop), "a status loop is no identity").toEqual([{ line: 2, identified: false, stampedFirst: true }]);
    expect(readinessSites(stamp + child + helper), "the helper is").toEqual([{ line: 2, identified: true, stampedFirst: true }]);
    expect(readinessSites(child + "if (Date.parse(cfg.server_started_at) >= spawnedAt) break;\n"), "a start-time check of its own is")
      .toEqual([{ line: 1, identified: true, stampedFirst: true }]);
    expect(readinessSites(stamp + child + statusLoop + stamp + child + helper).map((s) => s.identified),
      "each site is judged by the text after it, not by its neighbour's").toEqual([false, true]);
    expect(readinessSites(child + stamp + helper)[0].stampedFirst, "the helper's start, read after the spawn, is not first").toBe(false);
    expect(readinessSites(`await sleep(1);\n${stamp}await sleep(1);\n${child}${helper}`)[0].stampedFirst, "…nor one read with an await between it and the spawn").toBe(false);
    expect(readinessSites(stamp + child + helper.replace("spawnedAt }", "spawnedAt: 0 }"))[0].stampedFirst, "…nor a start other than the stamp handed to the helper").toBe(false);
    expect(readinessSites(`${stamp}let out = "";\nchild = ${SPAWN_WORD}(process.execPath, ["server.js"]);\n${helper}`)[0].stampedFirst,
      "CONTROL: synchronous statements between the stamp and the spawn are fine").toBe(true);
    expect(readinessSites(`${SPAWN_WORD}Sync(process.execPath, ["server.js"]);`), "a spawnSync child runs to its end and is never ready").toEqual([]);

    const root = path.join(__dirname, "..");
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.c?js$/.test(e.name) ? [p] : [];
    });
    const bad = [], seen = new Map();
    let sites = 0;
    for (const f of walk(path.join(root, "tests"))) {
      const rel = path.relative(root, f).replace(/\\/g, "/");
      const found = readinessSites(stripJsComments(fs.readFileSync(f, "utf8")));
      if (!found.length) continue;
      sites += found.length;
      const unidentified = found.filter((s) => !s.identified);
      seen.set(rel, unidentified.length);
      for (const s of found.filter((x) => !x.stampedFirst)) {
        bad.push(`${rel} ~line ${s.line}: the spawnedAt handed to readySpawnedServer is not Date.now() read just before the spawn`);
      }
      const decided = NEVER_READY.get(rel);
      if (unidentified.length !== (decided ? decided.sites : 0)) {
        bad.push(`${rel}: ${unidentified.length} server.js child(ren) with no identity check (at ${unidentified.map((s) => `~line ${s.line}`).join(", ")}), ` +
          `${decided ? decided.sites : 0} decided — wait with readySpawnedServer (tests/spawned-server.js), or decide the site in NEVER_READY with its reason`);
      }
    }
    for (const [rel, d] of NEVER_READY) {
      expect(d.why.length, `${rel}: a reason, not a label`).toBeGreaterThanOrEqual(40);
      if (!seen.has(rel)) bad.push(`stale NEVER_READY entry ${rel}: it spawns no server.js any more — delete it`);
    }
    expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
    // Anti-vacuity: the harness's own spawn (an expression, not a literal array)
    // is found and identified, and so are the spawners across the suite.
    expect(seen.get("tests/isolated-test.js"), "the harness's spawn is a site, with its own identity check").toBe(0);
    expect(sites, "anti-vacuity: the suite's server.js spawns are found").toBeGreaterThanOrEqual(30);
    expect(seen.size, "…across the spawner specs").toBeGreaterThanOrEqual(20);
  });
});
