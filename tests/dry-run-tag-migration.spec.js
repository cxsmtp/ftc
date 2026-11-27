// @ts-check
//
// v7.21.18 — the `internal` → `test/dry run` competition-tag rename, and the
// boot migration that carries existing databases across it.
//
// WHY THE MIGRATION IS LOAD-BEARING, not cosmetic. The marker is an ordinary row
// in `competition_tags`, and every consumer keys on the string: the default
// analytics exclusion, the permanent-tag allowlist, the badge refusal, the
// ribbon on the picker card. An un-migrated database would keep its dry-run
// competitions tagged `internal` while every reader looked for the new value —
// so those competitions would silently rejoin analytics and become
// badge-eligible. Nothing would error; the flag would just stop working.
//
// The migration runs against the REAL db.js in a throwaway data directory
// seeded with pre-rename rows, because that is the only way to exercise the
// thing an operator actually experiences: an existing database meeting new code.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const DRY_RUN_TAG = "test/dry run";

test.describe("v7.21.18 — the dry-run tag rename", () => {
  test("an existing database is migrated at boot, including the both-tags collision", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dryrun-mig-"));
    try {
      // A PRE-RENAME database: the schema db.js expects, with `internal` rows.
      const db = new Database(path.join(dir, "hackathon.db"));
      db.exec(`CREATE TABLE competitions (
        id TEXT PRIMARY KEY, name TEXT, start_time TEXT, duration_minutes INTEGER,
        ended_at TEXT, ended_manually INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
      db.exec(`CREATE TABLE competition_tags (
        competition_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (competition_id, tag));`);
      db.exec("INSERT INTO competitions (id,name) VALUES ('c1','One'),('c2','Two'),('c3','Three'),('c4','Four')");
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c1", "internal");
      // c2 carries an unrelated tag alongside it — that one must survive untouched.
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c2", "internal");
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c2", "pilot");
      // c3 somehow carries BOTH. A bare UPDATE would violate the
      // (competition_id, tag) primary key here; this is the case the
      // UPDATE OR IGNORE + DELETE pair exists for.
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c3", "internal");
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c3", DRY_RUN_TAG);
      // c4 has no dry-run marker at all and must be left alone.
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c4", "showcase");
      db.close();

      // Load the REAL db.js against that directory, in a child process so its
      // module-scope connection does not collide with this worker's.
      const run = () => require("child_process").spawnSync(
        process.execPath, ["-e", "require('./db')"],
        { cwd: path.join(__dirname, ".."), env: { ...process.env, NODE_OPTIONS: "", DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, BASE_URL: "http://localhost", SMTP_HOST: "localhost" }, encoding: "utf8" });
      const first = run();
      expect(first.status, `db.js exited ${first.status}: ${first.stderr}`).toBe(0);
      expect(first.stdout, "the migration must announce what it changed").toMatch(/internal.*->.*test\/dry run/);

      const check = () => {
        const d = new Database(path.join(dir, "hackathon.db"), { readonly: true });
        try { return d.prepare("SELECT competition_id, tag FROM competition_tags ORDER BY competition_id, tag").all(); }
        finally { d.close(); }
      };
      const after = check();
      expect(after, "every row is migrated, the collision is collapsed, unrelated tags survive").toEqual([
        { competition_id: "c1", tag: DRY_RUN_TAG },
        { competition_id: "c2", tag: "pilot" },
        { competition_id: "c2", tag: DRY_RUN_TAG },
        { competition_id: "c3", tag: DRY_RUN_TAG },   // both-tags case collapsed to one
        { competition_id: "c4", tag: "showcase" },
      ]);
      expect(after.some(r => r.tag === "internal"), "no old tag may survive").toBe(false);

      // IDEMPOTENT: a second boot changes nothing and says nothing.
      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout, "a second boot must be a silent no-op").not.toMatch(/internal.*->/);
      expect(check(), "…and must not move a single row").toEqual(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the renamed tag survives the whole round trip — including a DELETE, where it is a PATH SEGMENT", async () => {
    // The value contains a SLASH, so the tag reaches
    // `DELETE /api/admin/competitions/:id/tags/:tag` as an encoded path segment.
    // Getting that wrong would not fail loudly — the route would simply not
    // match, and the tag would be unremovable — so it is asserted explicitly.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const created = await api.post("/api/admin/competitions", {
        headers: h(csrf),
        data: { name: `DryRunRT ${stamp}`, start_time: new Date(stamp + 3_600_000).toISOString(), duration_minutes: 60, tags: [DRY_RUN_TAG] },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const compId = (await created.json()).competition.id;

      const listed = () => api.get("/api/admin/competitions").then(r => r.json()).then(l => l.find(c => c.id === compId));
      expect((await listed()).tags, "create applies the tag").toContain(DRY_RUN_TAG);

      // It is a PERMANENT tag, so it appears in the vocabulary even before use.
      expect(await (await api.get("/api/admin/competition-tags")).json(),
        "the renamed tag is the permanent one now").toContain(DRY_RUN_TAG);

      // Re-adding is idempotent (the tag route INSERT-OR-IGNOREs).
      const again = await api.post(`/api/admin/competitions/${compId}/tags`, { headers: h(csrf), data: { tag: DRY_RUN_TAG } });
      expect(again.ok()).toBeTruthy();
      expect((await again.json()).tags.filter(t => t === DRY_RUN_TAG).length, "no duplicate row").toBe(1);

      // The slash-bearing DELETE.
      const del = await api.delete(`/api/admin/competitions/${compId}/tags/${encodeURIComponent(DRY_RUN_TAG)}`, { headers: { "x-csrf-token": csrf } });
      expect(del.status(), `DELETE with an encoded slash must match the route: ${await del.text()}`).toBe(200);
      expect((await listed()).tags, "the tag is gone").not.toContain(DRY_RUN_TAG);
    } finally { await api.dispose(); }
  });

  test("behaviour is unchanged: a dry-run competition is still excluded from analytics by default", async () => {
    // The rename must be a rename and nothing more. This drives the one
    // behaviour an operator would notice immediately if the string had drifted:
    // the default analytics exclusion.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const mk = async tags => (await (await api.post("/api/admin/competitions", {
        headers: h(csrf),
        data: { name: `DryRunAn ${stamp}-${tags.length}`, start_time: new Date(stamp - 60_000).toISOString(), duration_minutes: 240, tags },
      })).json()).competition.id;
      const dry = await mk([DRY_RUN_TAG]);
      const plain = await mk([]);

      // scope=competition ignores the tag filter, so use the GLOBAL scope where
      // the default exclusion actually applies, and read which competitions the
      // admin list reports as tagged.
      const comps = await (await api.get("/api/admin/competitions")).json();
      expect(comps.find(c => c.id === dry).tags, "the dry-run competition is tagged").toContain(DRY_RUN_TAG);
      expect(comps.find(c => c.id === plain).tags || [], "the control is not").not.toContain(DRY_RUN_TAG);

      // The default exclusion is the tag itself — asserted through the endpoint
      // rather than by reading the constant, so a drift between the default and
      // the stored value would show up here.
      //
      // v8.12.4 — with ACTIVITY in the dry-run event, so the two reads can
      // differ. The first draft asserted only that both answered, which a build
      // ignoring the exclusion entirely also satisfies.
      const task = await makeTask(api, csrf, "dryrun-an");
      await assignTask(api, csrf, task.id, [dry]);
      const p = await makeParticipant(api, csrf, "dryrun-an");
      await enrol(api, csrf, dry, [p.id]);
      const pa = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        const H2 = { "x-csrf-token": pa.csrf, "content-type": "application/json" };
        expect((await pa.api.post("/api/select-competition", { headers: H2, data: { competitionId: dry } })).ok()).toBeTruthy();
        for (let i = 0; i < 2; i++) {
          const sub = await pa.api.post(`/api/tasks/${task.id}/submit`, { headers: H2,
            data: { answer: `wrong-${i}`, gradingHash: await gradingHashFor(pa.api, task.id) } });
          expect(sub.ok(), `wrong answer ${i}: ${await sub.text()}`).toBeTruthy();
        }
      } finally { await pa.api.dispose(); }
      // The analytics response is cached per URL for 15 s, and the submit path
      // writes challenge_events after its response — so each poll uses a fresh URL.
      let n = 0;
      const read = async (q) => (await (await api.get(`/api/admin/analytics/challenges?scope=global${q}&_=${stamp}-${++n}`)).json()).summary;
      let included, excluded;
      await expect.poll(async () => { included = await read("&excludeCompTags="); return included.incorrect; }, { timeout: 10000 })
        .toBeGreaterThanOrEqual(2);
      excluded = await read("");
      expect(excluded.incorrect, "the default read leaves the dry-run event's two wrong answers out")
        .toBe(included.incorrect - 2);
    } finally { await api.dispose(); }
  });
});
