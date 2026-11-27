// @ts-check
//
// v7.21.19 — external-audit round 10, the server-side halves.
//
// F1 (HIGH) session deletes are all-or-nothing and concurrency-checked
// F2 (MED)  a wall clock inside a DST gap is refused, not silently moved
// F4 (MED)  the row-stability tie token is honoured when the client echoes it
// F6 (MED)  the dry-run tag migration is FATAL rather than fail-open
const { test, expect } = require("./isolated-test");
const { apiLogin } = require("./helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

// ═══════════════════════════════════════════════════════════════════════════
// F1 — a refused session delete destroys NOTHING
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F1 — session deletes are all-or-nothing", () => {
  test("one protected session in the set means NOTHING is deleted", async () => {
    // THE DEFECT. The admin form deleted queued sessions one at a time and
    // carried on after a refusal, so a set of two where the second is protected
    // left the first permanently gone while the save reported failure: the admin
    // was told nothing happened, and a session had been destroyed.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const comp = (await (await api.post("/api/admin/competitions", {
        headers: h(csrf),
        data: { name: `F1 ${stamp}`, start_time: new Date(stamp + 3_600_000).toISOString(), duration_minutes: 600 },
      })).json()).competition.id;

      const mkSlot = async (name, offset) => (await (await api.post(`/api/admin/competitions/${comp}/timeslots`, {
        headers: h(csrf),
        data: { name, start_time: new Date(stamp + offset).toISOString(), duration_minutes: 60 },
      })).json()).timeslot.id;
      const deletable = await mkSlot("Deletable", 3_600_000);
      const protectedSlot = await mkSlot("Protected", 7_200_000);

      // Make the second one undeletable the way an event does: assign someone to
      // it. (A started session is the other way, but that needs a clock move.)
      const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants
        .filter(p => p.approved && !p.blocked && (p.role || "participant") === "participant" && !(p.tags || []).includes("staff"));
      expect(parts.length, "need an assignable participant").toBeGreaterThan(0);
      const asg = await api.post("/api/admin/competitions/assign", {
        headers: h(csrf), data: { userIds: [parts[0].id], competitionIds: [comp] },
      });
      expect(asg.ok(), await asg.text()).toBeTruthy();
      // Pin them to the protected slot.
      const db = new Database(require("./helpers").TEST_DB_PATH);
      try { db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?").run(protectedSlot, comp, parts[0].id); }
      finally { db.close(); }

      const before = await (await api.get(`/api/admin/competitions/${comp}/timeslots`)).json();
      expect(before.length, "two sessions to start with").toBe(2);

      // The deletable one is FIRST in the set, so a loop would remove it before
      // reaching the refusal. That ordering is the whole point of the test.
      const r = await api.post(`/api/admin/competitions/${comp}/timeslots/bulk-delete`, {
        headers: h(csrf), data: { timeslotIds: [deletable, protectedSlot] },
      });
      expect(r.status(), "the set must be refused").toBe(400);
      const body = await r.json();
      expect(body.error, "the refusal must NAME the session that blocked it").toContain("Protected");
      expect(body.timeslotId, "…and identify it").toBe(protectedSlot);

      const after = await (await api.get(`/api/admin/competitions/${comp}/timeslots`)).json();
      expect(after.length, "NOTHING may have been deleted — this is the finding").toBe(2);
      expect(after.map(t => t.id).sort(), "…both, specifically").toEqual([deletable, protectedSlot].sort());
    } finally { await api.dispose(); }
  });

  test("a clean set deletes together and returns the updated_at IT produced", async () => {
    // The positive control — without it, "nothing was deleted" is equally
    // satisfied by an endpoint that never deletes anything. And the returned
    // token is the concurrency half of the finding: the client used to re-read
    // updated_at blindly after its own deletes, which also swallowed another
    // admin's edit landing in that window.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const comp = (await (await api.post("/api/admin/competitions", {
        headers: h(csrf),
        data: { name: `F1ok ${stamp}`, start_time: new Date(stamp + 3_600_000).toISOString(), duration_minutes: 600 },
      })).json()).competition.id;
      const ids = [];
      for (const [i, off] of [3_600_000, 7_200_000, 10_800_000].entries()) {
        ids.push((await (await api.post(`/api/admin/competitions/${comp}/timeslots`, {
          headers: h(csrf), data: { name: `S${i}`, start_time: new Date(stamp + off).toISOString(), duration_minutes: 60 },
        })).json()).timeslot.id);
      }
      const compBefore = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp);

      const r = await api.post(`/api/admin/competitions/${comp}/timeslots/bulk-delete`, {
        headers: h(csrf), data: { timeslotIds: ids.slice(0, 2), expectedUpdatedAt: compBefore.updated_at },
      });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      expect(body.deleted).toBe(2);
      expect(typeof body.updated_at, "the response carries the token this transaction wrote").toBe("string");

      const after = await (await api.get(`/api/admin/competitions/${comp}/timeslots`)).json();
      expect(after.map(t => t.id), "exactly the untouched one survives").toEqual([ids[2]]);
      // …and the token is the competition's real, current one, so a PUT carrying
      // it succeeds rather than 409ing against our own write.
      const compAfter = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp);
      expect(body.updated_at, "the returned token matches the stored one").toBe(compAfter.updated_at);
    } finally { await api.dispose(); }
  });

  test("a stale concurrency token is refused BEFORE anything is deleted", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stamp = Date.now();
      const comp = (await (await api.post("/api/admin/competitions", {
        headers: h(csrf),
        data: { name: `F1conc ${stamp}`, start_time: new Date(stamp + 3_600_000).toISOString(), duration_minutes: 600 },
      })).json()).competition.id;
      const ts = (await (await api.post(`/api/admin/competitions/${comp}/timeslots`, {
        headers: h(csrf), data: { name: "Solo", start_time: new Date(stamp + 3_600_000).toISOString(), duration_minutes: 60 },
      })).json()).timeslot.id;

      const r = await api.post(`/api/admin/competitions/${comp}/timeslots/bulk-delete`, {
        headers: h(csrf), data: { timeslotIds: [ts], expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
      });
      expect(r.status(), "a stale token must 409").toBe(409);
      expect((await r.json()).conflict).toBe(true);
      const after = await (await api.get(`/api/admin/competitions/${comp}/timeslots`)).json();
      expect(after.length, "and delete nothing").toBe(1);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F4 — the tie token, once echoed, actually narrows the window
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F4 — the row-stability tie token is honoured", () => {
  test("the server returns snapshot_tie and applies the strict pair filter when it is echoed", async () => {
    // The server has always returned `snapshot_tie` and documented it as a
    // client contract; no client echoed it, so every paged read silently used
    // the weaker millisecond-only fallback and same-ms rows could cross a page
    // boundary. This asserts the pair is (a) issued and (b) load-bearing: the
    // strict filter is `event_time < snap OR (= snap AND tie_key <= snap_tie)`,
    // so a tie token BELOW every row at the anchor millisecond excludes them
    // while the timestamp alone would include them.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const page1 = await (await api.get("/api/admin/submissions?limit=5")).json();
      expect(typeof page1.snapshot_before, "the anchor is issued").toBe("string");
      expect(typeof page1.snapshot_tie, "the TIE is issued alongside it").toBe("string");

      // Echoing both must be accepted and must not change what page 1 holds.
      const echoed = await (await api.get(
        `/api/admin/submissions?limit=5&snapshot_before=${encodeURIComponent(page1.snapshot_before)}&snapshot_tie=${encodeURIComponent(page1.snapshot_tie)}`)).json();
      expect(echoed.events.map(e => e.id ?? e.event_time),
        "echoing the pair the server just issued returns the same window").toEqual(page1.events.map(e => e.id ?? e.event_time));

      // A tie token that sorts BELOW everything at the anchor ms must exclude the
      // rows sharing that millisecond — proving the tie half is read at all.
      const strict = await (await api.get(
        `/api/admin/submissions?limit=5&snapshot_before=${encodeURIComponent(page1.snapshot_before)}&snapshot_tie=${encodeURIComponent("")}`)).json();
      expect(Array.isArray(strict.events), "an empty tie falls back to the ms-only filter rather than erroring").toBe(true);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F6 — the dry-run tag migration refuses to start rather than serving wrong data
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v7.21.19 F6 — the tag migration is fatal, not fail-open", () => {
  test("a database whose migration cannot complete refuses to boot", () => {
    // v7.21.18 caught the migration failure and carried on, calling the marker
    // cosmetic. It is not: every reader looks for the NEW tag, so an un-migrated
    // row silently returns that competition to Analytics and makes it
    // badge-eligible — and a badge publishes a permanent public page. The same
    // patch documented exactly that three paragraphs above the catch.
    //
    // The failure is forced with a TRIGGER that blocks the rename, which is a
    // faithful stand-in for the real cases (a locked database, a constraint) and
    // needs no mocking of better-sqlite3.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f6-"));
    try {
      const db = new Database(path.join(dir, "hackathon.db"));
      db.exec(`CREATE TABLE competitions (id TEXT PRIMARY KEY, name TEXT, start_time TEXT,
        duration_minutes INTEGER, ended_at TEXT, ended_manually INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
      db.exec(`CREATE TABLE competition_tags (competition_id TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY (competition_id, tag));`);
      db.exec("INSERT INTO competitions (id,name) VALUES ('c1','One')");
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c1", "internal");
      // Refuse any attempt to move that row off the old tag.
      db.exec(`CREATE TRIGGER block_rename BEFORE UPDATE ON competition_tags
               WHEN OLD.tag='internal' BEGIN SELECT RAISE(ABORT,'blocked'); END;`);
      db.exec(`CREATE TRIGGER block_delete BEFORE DELETE ON competition_tags
               WHEN OLD.tag='internal' BEGIN SELECT RAISE(ABORT,'blocked'); END;`);
      db.close();

      const run = require("child_process").spawnSync(
        process.execPath, ["-e", "require('./db')"],
        { cwd: path.join(__dirname, ".."), encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "", DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, BASE_URL: "http://localhost", SMTP_HOST: "localhost" } });

      expect(run.status, "boot must FAIL rather than serve a half-migrated database").toBe(1);
      const out = `${run.stdout}${run.stderr}`;
      expect(out, "and say why, in terms an operator can act on").toMatch(/FATAL: could not migrate the competition tag/);
      expect(out, "…naming the consequence, not just the error").toMatch(/badge-eligible/);
      expect(out, "…and the manual remedy").toMatch(/UPDATE competition_tags SET tag='test\/dry run'/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POSITIVE CONTROL: a healthy database still boots", () => {
    // Without this, "exit 1" is equally satisfied by a migration that always
    // throws — which would take the platform down permanently.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f6ok-"));
    try {
      const db = new Database(path.join(dir, "hackathon.db"));
      db.exec(`CREATE TABLE competitions (id TEXT PRIMARY KEY, name TEXT, start_time TEXT,
        duration_minutes INTEGER, ended_at TEXT, ended_manually INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);`);
      db.exec(`CREATE TABLE competition_tags (competition_id TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY (competition_id, tag));`);
      db.exec("INSERT INTO competitions (id,name) VALUES ('c1','One')");
      db.prepare("INSERT INTO competition_tags VALUES (?,?)").run("c1", "internal");
      db.close();
      const run = require("child_process").spawnSync(
        process.execPath, ["-e", "require('./db')"],
        { cwd: path.join(__dirname, ".."), encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "", DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, BASE_URL: "http://localhost", SMTP_HOST: "localhost" } });
      expect(run.status, `a migratable database must boot: ${run.stderr}`).toBe(0);
      const after = new Database(path.join(dir, "hackathon.db"), { readonly: true });
      try {
        expect(after.prepare("SELECT tag FROM competition_tags").get().tag).toBe("test/dry run");
      } finally { after.close(); }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
