// @ts-check
//
// v8.13.3 (BTB-6) — the maintenance seeder refuses a wrong-typed field by name.
//
// POST /api/admin/perf/bulk-seed-users bound `competitionId` and every per-row
// profile field straight into SQL. better-sqlite3 SPREADS an array into
// positional binds and refuses an object outright, so `competitionId: ["c"]` or a
// row's `firstName: {}` threw inside the seed transaction: a generic 500 and an
// error-level stack line for a malformed file, where every sibling refusal in
// that loop already answered a named 400 ("users[3]: invalid email …"). It now
// type-checks both before anything is written.
//
// The route only answers while DATA_DIR/.maintenance exists (it seeds thousands
// of rows), so each arm runs inside a maintenance window it opens and closes
// itself, sending the bypass token like the perf harness does.
const { test, expect } = require("./isolated-test");
const { TEST_DATA_DIR, TEST_DB_PATH, apiLogin } = require("./helpers");
const { makeCompetition } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const MAINT = path.join(TEST_DATA_DIR, ".maintenance");
const TOKEN = `bulk-seed-shapes-${Date.now().toString(36)}`;

const count = (sql, ...args) => {
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).get(...args).n; } finally { db.close(); }
};

test.describe("v8.13.3 (BTB-6) — bulk-seed-users field shapes", () => {
  /** @type {any} */ let sa, saCsrf, comp;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "bulkseed");
  });

  const seed = async (body) => {
    fs.writeFileSync(MAINT, TOKEN);
    try {
      return await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json", "x-maintenance-bypass": TOKEN },
        data: { sharedPassword: "testpass123", ...body },
      });
    } finally {
      try { fs.unlinkSync(MAINT); } catch (_) { /* already gone */ }
    }
  };
  let n = 0;
  const row = (extra = {}) => {
    const tag = `${Date.now().toString(36)}${++n}`;
    return { firstName: "Seed", lastName: `Shape${tag}`, nickname: `seedshape${tag}`, email: `seedshape-${tag}@example.com`, ...extra };
  };

  for (const [label, bad] of [["an array", ["c"]], ["an object", { id: "c" }]]) {
    test(`competitionId as ${label} is a named 400 and seeds nobody`, async () => {
      const u = row();
      const r = await seed({ competitionId: bad, users: [u] });
      expect(r.status(), await r.text()).toBe(400);
      expect((await r.json()).error).toBe("competitionId must be text");
      expect(count("SELECT COUNT(*) AS n FROM users WHERE email=?", u.email)).toBe(0);
    });
  }

  for (const [field, bad] of [["firstName", {}], ["company", ["x", "y"]], ["timezone", 5], ["avatar", { src: "x" }]]) {
    test(`a row's ${field} that is not text is a named 400 and seeds nobody`, async () => {
      const good = row(), badRow = row({ [field]: bad });
      const r = await seed({ users: [good, badRow] });
      expect(r.status(), await r.text()).toBe(400);
      expect((await r.json()).error).toBe(`users[1]: ${field} must be text`);
      // The refusal precedes every write: not even the well-formed row landed.
      for (const u of [good, badRow]) {
        expect(count("SELECT COUNT(*) AS n FROM users WHERE email=?", u.email), `${u.email} was not seeded`).toBe(0);
      }
    });
  }

  test("CONTROL: a well-formed row with a real competitionId is seeded and enrolled", async () => {
    const u = row({ company: "Acme", city: "Leeds" });
    const r = await seed({ competitionId: comp.id, users: [u] });
    expect(r.status(), await r.text()).toBe(200);
    expect((await r.json()).inserted).toBe(1);
    expect(count(
      "SELECT COUNT(*) AS n FROM competition_users cu JOIN users u ON u.id = cu.user_id WHERE u.email=? AND cu.competition_id=?",
      u.email, comp.id)).toBe(1);
  });
});
