// @ts-check
//
// THE SEED SURVIVES ITS OWN RETRY.
//
// `_spawnAndSeed` (tests/isolated-test.js) retries `seedTestData()` up to five
// times against the SAME server, so a retry meets whatever the failed attempt
// left behind. Competition names are unique, so the second attempt's creates
// answered 409 and every retry failed the same way, reporting that 409 instead
// of the first attempt's real failure. The seed now adopts a row it finds under
// its own name (after checking it has the seed's shape) instead of creating a
// second one.
//
// This file's server was seeded once by the harness; the test seeds it again,
// the worst case a retry can meet (every step already done), and requires the
// same competition and challenge ids back. The control is the shape check: a
// same-named competition of another shape is refused by name, never adopted.
const { test, expect } = require("./isolated-test");
const { apiLogin, seedTestData, TEST_DB_PATH } = require("./helpers");

const SEED_COMPS = { upcoming: "Test Upcoming", live: "Test Live", ended: "Test Ended" };
const SEED_TASKS = ["easy1", "med1", "hard1", "easy2", "draft1"];

async function seededIds() {
  const { api } = await apiLogin("superadmin");
  try {
    const comps = await (await api.get("/api/admin/competitions")).json();
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
    const c = {}, t = {};
    for (const [k, name] of Object.entries(SEED_COMPS)) {
      const rows = comps.filter((r) => r.name === name);
      expect(rows, `exactly one '${name}'`).toHaveLength(1);
      c[k] = rows[0].id;
    }
    for (const k of SEED_TASKS) {
      const rows = taskList.filter((r) => r.title === `Challenge ${k}` && !r.owner_competition_id);   // the library row (lib/event-copies.js)
      expect(rows, `exactly one 'Challenge ${k}'`).toHaveLength(1);
      t[k] = rows[0].id;
    }
    return { comps: c, tasks: t };
  } finally { await api.dispose(); }
}

test("a second seeding of one server adopts what the first made and returns the same ids", async () => {
  const before = await seededIds();
  const Database = require("better-sqlite3");
  // What the seed's later steps leave: alice's answers and every membership.
  const sideEffects = () => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return {
        answers: db.prepare("SELECT s.task_id, s.is_correct FROM submissions s JOIN users u ON u.id=s.user_id WHERE u.email='alice@acme.com' ORDER BY s.task_id, s.is_correct").all(),
        members: db.prepare("SELECT c.name, u.email FROM competition_users cu JOIN users u ON u.id=cu.user_id JOIN competitions c ON c.id=cu.competition_id WHERE c.name LIKE 'Test %' ORDER BY 1, 2").all(),
        users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      };
    } finally { db.close(); }
  };
  const effects = sideEffects();
  expect(effects.answers, "PRECONDITION: the first seeding left alice one right and one wrong answer").toHaveLength(2);
  // Past the submit's 3 s fold, which would otherwise swallow a repeated wrong
  // answer and hide a seed that sends it twice.
  const lastAt = (() => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return Date.parse(db.prepare("SELECT MAX(submitted_at) AS t FROM submissions").get().t); } finally { db.close(); } })();
  const wait = lastAt + 3500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const again = await seedTestData();
  expect(again.comps, "the retry returns the competitions the first attempt made").toEqual(before.comps);
  expect(again.tasks, "and the challenges").toEqual(before.tasks);
  // Nothing was made twice.
  expect(await seededIds(), "no second row of any seeded name").toEqual(before);
  expect(sideEffects(), "no answer sent twice, nobody registered or enrolled twice").toEqual(effects);
});

test("CONTROL: a same-named competition that is not the seed's shape is refused by name, never adopted", async () => {
  const Database = require("better-sqlite3");
  const raw = (sql, args) => { const db = new Database(TEST_DB_PATH); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
  const ended = (() => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT id, duration_minutes FROM competitions WHERE name='Test Ended'").get(); } finally { db.close(); } })();
  expect(ended && ended.duration_minutes, "PRECONDITION: the seeded ended competition, 60 minutes").toBe(60);
  // Stretch it so it is LIVE again: same name, not the seed's shape.
  raw("UPDATE competitions SET duration_minutes=? WHERE id=?", [24 * 60, ended.id]);
  try {
    await expect(seedTestData(), "the changed row is not adopted").rejects.toThrow(/'Test Ended' exists but is not the seed's/);
  } finally {
    raw("UPDATE competitions SET duration_minutes=? WHERE id=?", [60, ended.id]);
  }
});
