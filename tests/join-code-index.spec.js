// @ts-check
//
// v8.3.11 — THE JOIN-CODE UNIQUE INDEX EXISTS ON A *FRESH* DATABASE.
//
// `uq_competitions_join_code` used to be created ~400 lines ABOVE the ALTER that
// adds `competitions.join_code`. On an existing database that is harmless — the
// column is already there from a previous boot — but on a FRESH one the CREATE
// runs against a table with no such column, fails with `no such column`, is
// swallowed by a deliberately non-fatal catch, and is never retried until the
// next process start. So the index appeared only on the SECOND boot.
//
// WHY THE WHOLE SUITE WAS BLIND TO IT, and why this spec has to build its own
// database rather than assert against the shared test server:
// tests/isolated-test.js wipes the data directory before EVERY spec file, so
// every test server in this repo is a first boot — which means every test server
// has run without this index since v8.1.0, and a test asserting against the
// shared server would have been asserting the defect.
//
// THE SCRATCH DIRECTORY IS THE ENTIRE EXPERIMENT. On a second boot the index
// exists whichever order the statements are in, so a test that reused a
// directory — or booted twice before asserting — would pass against the broken
// build and prove nothing at all. `mkdtempSync` hands back a directory that is
// empty by construction, and exactly ONE `bootDb()` runs before the assertions.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// db.js is self-contained (better-sqlite3 / path / fs / crypto / uuid, plus the
// pure lib/event-policy) — no lib/config, hence no BASE_URL — which is what lets
// the migration chain be driven in a throwaway DATA_DIR instead of against a
// spawned server.
//
// STDERR IS CONCATENATED, and that is not tidiness. The signal this spec's
// second witness reads is the swallowed `[db] could not create …` line, which
// db.js emits with `console.error`. The established helper in this repo
// (tests/navaway-accuracy.spec.js) uses `execFileSync(...).toString()`, which
// returns STDOUT ONLY — so the same assertion written that way can never fire,
// and it did not: the first draft of this file "passed" its stderr check against
// a deliberately broken db.js. Caught by running the mutation, not by review.
function bootDbIn(dir) {
  const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, NODE_OPTIONS: "" },   // v7.15.30 — never inherit node flags into a spawned child
    encoding: "utf8",
  });
  expect(r.status, `db.js boot must succeed: ${r.stderr}`).toBe(0);
  return `${r.stdout}${r.stderr}`;
}

const T = "2026-01-01T10:00:00.000Z";
const insertComp = (db, id, joinCode) => db.prepare(
  "INSERT INTO competitions (id,name,start_time,duration_minutes,join_code,created_at) VALUES (?,?,?,?,?,?)"
).run(id, `JC ${id}`, T, 120, joinCode, T);

test.describe("v8.3.11 — uq_competitions_join_code on a first boot", () => {
  test("the index is created, enforces uniqueness, and stays PARTIAL on non-NULL codes", () => {
    const Database = require("better-sqlite3");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "join-code-index-"));
    try {
      const dbPath = path.join(tmp, "hackathon.db");
      expect(fs.existsSync(dbPath), "the premise: this must be a first boot, not a repair boot").toBe(false);

      const out = bootDbIn(tmp);
      // The old ordering failed non-fatally and printed its reason. Assert the
      // absence of that line too — it is the most direct statement of the defect,
      // and it names the mutation (restore the CREATE above the ALTER).
      expect(out, "the CREATE must not have failed on a missing column")
        .not.toContain("could not create uq_competitions_join_code");

      const db = new Database(dbPath);
      try {
        // ── 1. THE INDEX EXISTS AFTER ONE BOOT ──
        const idx = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_competitions_join_code'"
        ).get();
        expect(idx, "uq_competitions_join_code must exist after the FIRST boot, not the second").toBeTruthy();

        // ── 2. IT REALLY REFUSES A DUPLICATE CODE ──
        // Asserted behaviourally rather than by reading the DDL for the word
        // UNIQUE: this is the property the six-character code rests on — a code
        // is resolved on its own, with no competition id alongside it, so two
        // rows sharing one would resolve ambiguously.
        insertComp(db, "c-a", "ABC123");
        let err = null;
        try { insertComp(db, "c-b", "ABC123"); } catch (e) { err = e; }
        expect(err, "a duplicate join_code must be refused").toBeTruthy();
        expect(String(err && err.code),
          `expected a UNIQUE constraint violation, got ${err && err.message}`).toBe("SQLITE_CONSTRAINT_UNIQUE");

        // ── 3. THE CONTROL: THE PARTIAL CLAUSE SURVIVED ──
        // Every competition created before v8.1.0 carries a NULL join_code, and
        // SQLite treats NULLs as distinct in a plain UNIQUE index anyway — but the
        // `WHERE join_code IS NOT NULL` clause says so explicitly and keeps the
        // index off the rows carrying nothing. Without this assertion, "the index
        // exists and refuses duplicates" is equally satisfied by a NON-partial
        // index, and the two are indistinguishable on modern SQLite for the
        // duplicate case alone. It also anchors the DDL check below to a
        // behaviour rather than to a string.
        insertComp(db, "c-n1", null);
        insertComp(db, "c-n2", null);
        expect(db.prepare("SELECT COUNT(*) c FROM competitions WHERE join_code IS NULL").get().c,
          "two competitions with no code at all must both be accepted").toBe(2);
        expect(String(idx.sql).toUpperCase(),
          "and the index says so explicitly rather than relying on SQLite's NULL semantics")
          .toContain("WHERE JOIN_CODE IS NOT NULL");
      } finally { db.close(); }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
