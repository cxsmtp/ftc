// @ts-check
//
// v8.9.0 — THE `tasks.answer_type` CHECK ADMITS 'any' ON AN *EXISTING* DATABASE.
//
// A fresh database gets the widened CHECK from the CREATE TABLE in db.js for
// free. A migrated one cannot: a CHECK lives inside the table definition, SQLite
// cannot ALTER it, and the table has to be rebuilt — which is the one thing no
// test server in this repo ever does, because tests/isolated-test.js wipes the
// data directory before every spec file and every test server is therefore a
// FIRST boot (the v8.3.11 join-code-index lesson). So the rebuild block is
// unreachable from the shared server, and this spec builds the pre-change shape
// by hand: boot a fresh schema, NARROW the stored CHECK back to the previous
// list through `writable_schema`, populate it, and boot again.
//
// WHY THE FIXTURE CARRIES `attempt_cap` AND `created_by_id`. The v7.19.0
// rebuild hard-codes its `tasks_v2` DDL, and both of those columns were added
// by ALTERs that run BELOW the rebuild blocks — so a pasted copy of that DDL is
// missing them, `INSERT INTO tasks_v2 (<live columns>)` fails "no column named
// attempt_cap", the non-fatal catch swallows it, and the narrow CHECK survives
// with nothing on any screen. The new block derives its DDL from the live
// `sqlite_master.sql` instead; the two late columns on the fixture row are what
// make a pasted-DDL regression go red here rather than in production.
//
// TWO SHAPES OF STORED NAME, and the second is the production one. A fresh
// database stores `CREATE TABLE tasks (`; a database that went through the
// v7.19.0 RENAME stores `CREATE TABLE "tasks" (` — DOUBLE-QUOTED, which is what
// SQLite writes on `ALTER TABLE … RENAME TO`. Narrowing a fresh schema only
// exercises the bare form, so the second arm quotes the name too; without it
// the header regex's optional quotes are held by nothing.
//
// `db.unsafeMode(true)` is required for the narrowing, not tidiness:
// better-sqlite3 opens every connection in SQLITE_DBCONFIG_DEFENSIVE mode,
// under which `PRAGMA writable_schema=ON` is accepted and silently ignored and
// the UPDATE fails "table sqlite_master may not be modified" — measured, on
// the first draft of this file.
//
// STDERR IS CONCATENATED with stdout (the join-code-index recipe): the failure
// line this spec must NOT see is the block's own non-fatal catch, which db.js
// emits with `console.error`.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const WIDENED = "CHECK(answer_type IN ('text','file','json','choice','any'))";
const NARROW = "CHECK(answer_type IN ('text','file','json','choice'))";
const MIGRATION_LINE = "[migration] tasks.answer_type CHECK widened to include 'any'";
const FAILURE_LINE = "tasks answer_type CHECK ('any') migration failed";

// db.js is self-contained (better-sqlite3 / path / fs / crypto / uuid, plus the
// pure lib/event-policy and lib/data-dir) — no lib/config, hence no BASE_URL —
// which is what lets the migration chain be driven in a throwaway DATA_DIR
// instead of against a spawned server.
function bootDbIn(dir) {
  const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, NODE_OPTIONS: "" },   // v7.15.30 — never inherit node flags into a spawned child
    encoding: "utf8",
  });
  expect(r.status, `db.js boot must succeed: ${r.stderr}`).toBe(0);
  return `${r.stdout}${r.stderr}`;
}

const tasksSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
const tasksIndexes = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'"
).all().map(r => r.name);

const T = "2026-01-01T10:00:00.000Z";

/**
 * Put a freshly-booted database into the PRE-v8.9.0 shape: the stored CHECK
 * narrowed back to the previous list (and, for the production shape, the table
 * name double-quoted as the v7.19.0 RENAME left it), plus one task row carrying
 * both late-added columns and one `submissions` child pointing at it.
 * Returns the narrowed DDL so the caller can assert on the precondition.
 */
function narrowAndPopulate(dbPath, { quotedName }) {
  const Database = require("better-sqlite3");
  let db = new Database(dbPath);
  try {
    const fresh = tasksSql(db);
    expect(fresh, "the premise: a fresh boot must already carry the widened CHECK").toContain(WIDENED);
    expect(fresh, "a fresh database stores the BARE table name").toMatch(/^CREATE TABLE tasks\s*\(/);
    let narrowed = fresh.replace("'choice','any'", "'choice'");
    if (quotedName) narrowed = narrowed.replace(/^CREATE TABLE tasks\s*\(/, 'CREATE TABLE "tasks" (');
    db.unsafeMode(true);
    db.pragma("writable_schema = ON");
    db.prepare("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='tasks'").run(narrowed);
    db.pragma("writable_schema = OFF");
    const v = db.pragma("schema_version", { simple: true });
    db.pragma(`schema_version = ${v + 1}`);   // other connections re-read the schema
    db.unsafeMode(false);
  } finally {
    db.close();
  }

  // A FRESH connection, so the fixture rows are written against the narrowed
  // schema rather than the one the previous connection had cached.
  db = new Database(dbPath);
  try {
    const stored = tasksSql(db);
    expect(stored, "the narrowing must have taken").toContain(NARROW);
    expect(stored, "the narrowing must have taken").not.toContain("'any'");
    if (quotedName) expect(stored, "the production shape stores a double-quoted name").toMatch(/^CREATE TABLE "tasks"\s*\(/);

    // better-sqlite3 turns foreign keys ON per connection. `submissions`
    // references users(id) as well as tasks(id), and a faithful users row would
    // add a dozen NOT NULL columns the rebuild never reads. Off for fixture
    // construction only; the migration runs in its own process.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO tasks (id,title,difficulty,answer_type,correct_answer,attempt_cap,created_by_id) VALUES (?,?,?,?,?,?,?)"
    ).run("t-any-mig", "Any migration fixture", "easy", "text", "42", 3, "admin-any-mig");
    db.prepare(
      "INSERT INTO submissions (id,user_id,task_id,competition_id,timeslot_id,answer,is_correct,points_delta,submitted_at,updated_at) VALUES (?,?,?,?,NULL,'42',1,50,?,?)"
    ).run("s-any-mig", "u-any-mig", "t-any-mig", "c-any-mig", T, T);

    // PRECONDITION, not decoration: the narrowed table must genuinely REFUSE
    // 'any', or "boot 2 admits it" is satisfied by a fixture that never
    // narrowed anything.
    let refused = null;
    try {
      db.prepare("INSERT INTO tasks (id,title,difficulty,answer_type,correct_answer) VALUES ('t-pre','pre','easy','any','x')").run();
    } catch (e) { refused = e; }
    expect(refused && refused.code, "the narrowed CHECK must refuse 'any' BEFORE the migration boot").toBe("SQLITE_CONSTRAINT_CHECK");
    return stored;
  } finally {
    db.close();
  }
}

test.describe("v8.9.0 — tasks.answer_type CHECK widened to 'any' on an existing database", () => {
  for (const quotedName of [false, true]) {
    const shape = quotedName
      ? "a database the v7.19.0 RENAME left with a double-quoted name (the production shape)"
      : "a narrowed fresh schema (bare table name)";

    test(`the rebuild widens the CHECK, keeps every row and both late columns, and runs ONCE — ${shape}`, () => {
      const Database = require("better-sqlite3");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "any-answer-mig-"));
      try {
        const dbPath = path.join(tmp, "hackathon.db");
        expect(fs.existsSync(dbPath), "the premise: boot 1 must be a first boot").toBe(false);

        // ── boot 1: a fresh schema, then narrow it back to the previous list ──
        const out1 = bootDbIn(tmp);
        expect(out1, "a fresh database needs no rebuild").not.toContain(MIGRATION_LINE);
        narrowAndPopulate(dbPath, { quotedName });

        // ── boot 2: the migration runs ──
        const out2 = bootDbIn(tmp);
        expect(out2, "the rebuild must announce itself").toContain(MIGRATION_LINE);
        expect(out2, "the rebuild must not have fallen into its non-fatal catch").not.toContain(FAILURE_LINE);

        const db = new Database(dbPath);
        try {
          const sql = tasksSql(db);
          expect(sql, "the stored CHECK must carry 'any' after the rebuild").toContain(WIDENED);
          expect(sql, "the derived DDL must keep the CHECK on difficulty too").toContain("CHECK(difficulty IN ('easy','medium','hard'))");

          // The row, with BOTH columns the v7.19.0 DDL does not know.
          const row = db.prepare("SELECT title, attempt_cap, created_by_id FROM tasks WHERE id='t-any-mig'").get();
          expect(row, "the fixture row must survive the rebuild").toBeTruthy();
          expect(row.title).toBe("Any migration fixture");
          expect(row.attempt_cap, "attempt_cap (v8.1.0) must survive — a pasted v7.19.0 DDL has no such column").toBe(3);
          expect(row.created_by_id, "created_by_id (v8.7.0) must survive — a pasted v7.19.0 DDL has no such column").toBe("admin-any-mig");
          expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, "exactly the one row, no duplicate from a half-applied swap").toBe(1);

          // The child row, and the FK clause that legacy_alter_table protects:
          // it must still name `tasks`, not the temporary table.
          expect(db.prepare("SELECT task_id FROM submissions WHERE id='s-any-mig'").get()?.task_id).toBe("t-any-mig");
          const subsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='submissions'").get().sql;
          expect(subsSql).toMatch(/REFERENCES\s+tasks\s*\(id\)/);
          expect(subsSql).not.toContain("tasks_v2");
          const orphansOnTasks = db.prepare("PRAGMA foreign_key_check(submissions)").all().filter(r => r.parent === "tasks");
          expect(orphansOnTasks, "no submissions row may have lost its parent task").toEqual([]);

          // DROP TABLE takes the index with it; the CREATE INDEX below the block
          // is what puts it back, which is why the block must stay above it.
          expect(tasksIndexes(db), "idx_tasks_title must be recreated after the rebuild").toContain("idx_tasks_title");

          // The widened CHECK really ADMITS 'any' and still REFUSES junk.
          db.pragma("foreign_keys = OFF");
          expect(() => db.prepare(
            "INSERT INTO tasks (id,title,difficulty,answer_type,correct_answer) VALUES ('t-any-ok','ok','easy','any','')"
          ).run()).not.toThrow();
          let refused = null;
          try {
            db.prepare("INSERT INTO tasks (id,title,difficulty,answer_type,correct_answer) VALUES ('t-bogus','no','easy','bogus','x')").run();
          } catch (e) { refused = e; }
          expect(refused && refused.code, "an unknown answer_type must still be refused by the CHECK").toBe("SQLITE_CONSTRAINT_CHECK");
          db.prepare("DELETE FROM tasks WHERE id='t-any-ok'").run();
        } finally {
          db.close();
        }

        // ── boot 3: idempotent ──
        const out3 = bootDbIn(tmp);
        expect(out3, "a widened database must not be rebuilt again").not.toContain(MIGRATION_LINE);
        expect(out3).not.toContain(FAILURE_LINE);
        const again = new Database(dbPath, { readonly: true });
        try {
          expect(tasksSql(again)).toContain(WIDENED);
          expect(again.prepare("SELECT COUNT(*) AS n FROM tasks").get().n).toBe(1);
          expect(tasksIndexes(again)).toContain("idx_tasks_title");
        } finally {
          again.close();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  // CONTROL. A fresh database gets the value from the CREATE TABLE and no
  // rebuild runs — so "the migration line appears" above cannot be satisfied by
  // a block that fires on every boot, and "'any' is accepted" cannot be satisfied
  // by the rebuild alone with the CREATE TABLE left narrow.
  test("CONTROL: a fresh database already carries 'any' and prints no migration line", () => {
    const Database = require("better-sqlite3");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "any-answer-fresh-"));
    try {
      const dbPath = path.join(tmp, "hackathon.db");
      expect(fs.existsSync(dbPath), "the premise: this must be a first boot").toBe(false);
      const out = bootDbIn(tmp);
      expect(out, "a fresh CREATE TABLE needs no rebuild").not.toContain(MIGRATION_LINE);
      expect(out).not.toContain(FAILURE_LINE);
      const db = new Database(dbPath);
      try {
        expect(tasksSql(db)).toContain(WIDENED);
        expect(tasksIndexes(db)).toContain("idx_tasks_title");
        db.pragma("foreign_keys = OFF");
        expect(() => db.prepare(
          "INSERT INTO tasks (id,title,difficulty,answer_type,correct_answer) VALUES ('t-any-fresh','ok','easy','any','')"
        ).run()).not.toThrow();
        let refused = null;
        try {
          db.prepare("INSERT INTO tasks (id,title,difficulty,answer_type,correct_answer) VALUES ('t-bogus','no','easy','bogus','x')").run();
        } catch (e) { refused = e; }
        expect(refused && refused.code).toBe("SQLITE_CONSTRAINT_CHECK");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
