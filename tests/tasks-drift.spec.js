// v7.29.0 — PR 9: the `tasks` drift guard.
//
// PR 7's own history is the argument for building this now: `task_versions`
// snapshots the whole row, but the version-RESTORE UPDATE hand-maintains its
// column list, and `choices` was missing from it for a whole release (v7.20.9
// F4). Restoring an old version of a multiple-choice challenge therefore wrote
// the old correct_answer (old ids) while leaving today's options in place —
// correct ids naming no option, every submission grading wrong, the challenge
// literally unsolvable, silently, with both columns still well-formed.
//
// Same demand as the competitions guard: every column is a DECISION. Coverage is
// the wrong ask — `id` and `updated_at` must NOT round-trip — so a scanner
// requiring every column to reach the file would be wrong about working code.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");

const EXPORTED = new Set([
  "title", "description", "difficulty", "answer_type", "correct_answer",
  "choices", "explanation", "hint", "attachment_url",
  "author_name", "author_linkedin", "active", "status",
  // v8.1.0 — the challenge-level attempt ceiling. EXPORTED rather than exempted
  // because both import branches honour it, which is this guard's actual bar: a
  // column reaches the file only when the target can act on what it finds there.
  "attempt_cap",
  // v8.10.0 — the sealed-answer flag. EXPORTED rather than exempted because the
  // importer ACTS on what it finds: a row carrying `answer_sealed: 1` is REFUSED
  // and counted (`sealed_skipped`), which is this guard's bar — "a column reaches
  // the file only when the target can act on what it finds there".
  //
  // Refusing rather than importing is the decision, and the reason is
  // `created_by_id`, two entries below: a user id means nothing on another server,
  // so the import deliberately writes none. Importing a sealed row would therefore
  // produce a sealed challenge with NO author — unreadable and uneditable by every
  // human alive — and importing it UNSEALED would silently break the promise the
  // source platform made. The flag also EXPLAINS the `correct_answer: null` a
  // non-author's export carries, which would otherwise read as a broken file.
  "answer_sealed",
  // `tags` is a join table surfaced under the same key; `locked` is below.
]);
const EXCLUDED = new Map([
  ["id", "Surrogate key. Import resolves by TITLE, so a foreign id is meaningless and would collide across servers."],
  ["updated_at", "Optimistic-concurrency bookkeeping scoped to THIS database — a foreign value seeds an If-Match token for an edit that never happened here."],
  ["tags", "A DENORMALISED cache column on the row; the authoritative store is the task_tags join table, which the export surfaces under `tags`. Exporting both would give the importer two sources for one fact."],
  ["locked", "A per-deployment moderation state, not a property of the challenge. Importing it would let one server's lock silently freeze a challenge on another, where the superadmin who set it has no standing."],
  ["created_by_id", "v8.7.0 — a user id on THIS platform, and the AUTHORIZATION key an event admin's edit rights hang on. Imported elsewhere it either dangles or hands ownership to whichever row happens to hold that uuid. Same reasoning as users.linkedin_sub. The import leaves it NULL, which means 'no event admin owns this' — accurate for a challenge that arrived from another server."],
  ["owner_competition_id", "The event owning the question (lib/event-copies.js): an event id on THIS platform, and there is no competitions import, so on another server it names no event. The library export holds bank questions only; an imported question lands in the bank (NULL)."],
  ["copied_from_task_id", "The bank question an event's copy came from: a task id on THIS platform, meaningless elsewhere (import resolves by title). An imported question is a bank question with no origin."],
]);

test.describe("v7.29.0 — tasks export/schema drift", () => {
  test("every tasks column is exported or explicitly exempted", () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let cols;
    try { cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name); }
    finally { db.close(); }
    expect(cols.length, "the table was found").toBeGreaterThan(10);
    const unclassified = cols.filter(c => !EXPORTED.has(c) && !EXCLUDED.has(c));
    expect(unclassified,
      "a new tasks column must be added to EXPORTED (and reach the export) or to EXCLUDED with its reason"
    ).toEqual([]);
    // The other direction, as the L9 audit guard does it: a decision about a column that no longer exists reads as coverage and is not; drop the entry with the column.
    const stale = [...EXPORTED, ...EXCLUDED.keys()].filter(c => !cols.includes(c));
    expect(stale, "EXPORTED or EXCLUDED names a tasks column that no longer exists").toEqual([]);
  });

  test("every EXPORTED tasks column reaches the file", async () => {
    const { api } = await apiLogin("superadmin");
    const body = await (await api.get("/api/admin/export/tasks")).json();
    await api.dispose();
    expect(Array.isArray(body.tasks) && body.tasks.length, "the seed provides challenges").toBeTruthy();
    // Union across rows: a nullable column may be absent from one row's literal.
    const keys = new Set();
    for (const t of body.tasks) for (const k of Object.keys(t)) keys.add(k);
    const missing = [...EXPORTED].filter(c => !keys.has(c));
    expect(missing, "classified EXPORTED but absent from the export payload").toEqual([]);
    const leaked = [...EXCLUDED.keys()].filter(c => c !== "tags" && keys.has(c));
    expect(leaked, "classified EXCLUDED but present in the export payload").toEqual([]);
  });

  // THE v7.20.9 F4 DEFECT, locked. The restore UPDATE's hand-maintained column
  // list is the one place a snapshot can silently fail to restore a field, and
  // `choices` proved it can happen for a whole release without a failing test.
  test("the version-restore column list covers every scoring-relevant column", () => {
    const fs = require("fs"), pathMod = require("path");
    const src = fs.readFileSync(pathMod.join(__dirname, "..", "routes", "challenges.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "));
    // Anchored on the RESTORE's distinctive shape — positional `?` for both title
    // and description. The publish, visibility and lock handlers also issue
    // `UPDATE tasks SET`, and the edit PUT uses COALESCE, so a bare match on the
    // first one silently measured the wrong statement (it did, on the first draft
    // of this lock).
    const m = src.match(/UPDATE tasks SET title=\?, description=\?([\s\S]{0,600}?)WHERE id=\?/);
    expect(m, "the restore UPDATE was found — if it was reshaped, re-anchor this deliberately").toBeTruthy();
    const restored = m[1];
    // Anything that changes what a submission GRADES AGAINST, or whether the
    // challenge counts toward the all-solved denominator, must be restored — or
    // a restore leaves the row internally inconsistent.
    for (const col of ["correct_answer", "answer_type", "difficulty", "choices", "active", "status"]) {
      expect(restored, `version restore must write ${col}, or a snapshot silently does not restore it`).toContain(col);
    }
    // v8.10.0 — THE OTHER DIRECTION, and it is not symmetry for its own sake.
    // Two columns must NEVER be restored, because a snapshot predating them
    // carries the pre-decision value and restoring it reverses an operator
    // decision as a side effect of undoing a typo: `created_by_id` would transfer
    // ownership, and `answer_sealed: 0` from a pre-seal snapshot would UNSEAL an
    // answer — irreversibly, since the platform refuses to seal one twice.
    // An event's question keeps its owner and origin whatever an old snapshot
    // says (lib/event-copies.js): restoring them would move it between events.
    for (const col of ["created_by_id", "answer_sealed", "owner_competition_id", "copied_from_task_id"]) {
      expect(restored, `version restore must NOT write ${col} — a snapshot predating it would reverse the decision`).not.toContain(col);
    }
  });
});
