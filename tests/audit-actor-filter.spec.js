"use strict";

// THE AUDIT PAGE'S ACTOR BOX ON ANSWERS AND HINTS (routes/audit.js `_branchWhere`).
//
// For answers and hints the actor is the person's PRIMARY address (`u.email`),
// asked as `u.email = ? COLLATE NOCASE`: a search of uq_users_email_nocase, then
// that person's own rows. `LOWER(u.email) = ?` could use no index, so the read
// walked every answer newest first until the page filled, and the walk budget
// (AUDIT_SCAN_BUDGET) cut it: an actor whose rows sat behind more than the
// budget of other people's never found them on the first page.
//
// Two arms. The plan: the REAL handler, run in a child with a stub `app`, asks
// lib/query-plan.js `walksByTime` about the statement it composed, and the
// answer is recorded (false with the actor filter; true for a text search, the
// control). The behaviour: through the server, the actor's rows planted older
// than BUDGET + 10 rows of someone else's are found on the first page with
// nothing cut, while a text search for the same person is cut (the control that
// shows the rows are past the window). Its own file: a table this full would cut
// the other audit specs' walks.

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin } = require("./helpers");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

test.use({ baseURL: BASE, timezoneId: "UTC", locale: "en-GB" });

const BUDGET = 20000;   // routes/audit.js AUDIT_SCAN_BUDGET (the walk-budget spec pins it)
const T = `af${Date.now().toString(36)}${process.pid % 1000}`;
const BASE_MS = Date.now() + 3600e3;          // newer than anything recorded during the run
const iso = (ms) => new Date(ms).toISOString();
const rid = () => crypto.randomUUID();

test("plan: the real handler's actor filter on answers and hints is an index search, a text search walks by time", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-audit-actor-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-audit-actor-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    // Record every walk decision the route makes: patched before routes/audit.js
    // destructures it.
    const qp = R("lib/query-plan.js");
    const realWalks = qp.walksByTime;
    const decisions = [];
    qp.walksByTime = (plan, alias, col) => { const v = realWalks(plan, alias, col); decisions.push({ alias, walks: v }); return v; };
    const routes = {};
    const app = new Proxy({}, { get: (_, verb) => (p, ...fns) => { routes[String(verb).toUpperCase() + " " + p] = fns[fns.length - 1]; } });
    R("routes/audit.js")(app);
    const handler = routes["GET /api/admin/audit"];
    const at = new Date().toISOString();
    db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, created_at) VALUES (?,?,?,?,?,?)").run("u-a", "Ann", "A", "ann1", "Ann.Mixed@Corp.Test", at);
    db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, created_at) VALUES (?,?,?,?,?,?)").run("u-b", "Bob", "B", "bob1", "bob@corp.test", at);
    db.prepare("INSERT INTO tasks (id, title, difficulty, answer_type, correct_answer, status) VALUES (?,?,?,?,?,?)").run("t-1", "Plan task", "easy", "text", "x", "published");
    const sub = db.prepare("INSERT INTO submissions (id, user_id, task_id, answer, is_correct, submitted_at) VALUES (?,?,?,?,?,?)");
    sub.run("s-a", "u-a", "t-1", "x", 1, at);
    sub.run("s-b", "u-b", "t-1", "y", 0, at);
    const hint = db.prepare("INSERT INTO hint_reveals (competition_id, user_id, task_id, revealed_at) VALUES (?,?,?,?)");
    hint.run("", "u-a", "t-1", at);
    hint.run("", "u-b", "t-1", at);
    const seen = [];
    const orig = db.prepare;
    db.prepare = function (sql) { seen.push(String(sql)); return orig.call(db, sql); };
    const read = (query) => {
      decisions.length = 0; seen.length = 0;
      let out = null;
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; return this; } };
      handler({ query, url: "/api/admin/audit?" + new URLSearchParams(query), session: { isAdmin: true, isSuperAdmin: true, builtinId: "superadmin" }, headers: {}, ip: "127.0.0.1", id: "req-a", sessionID: "sess-a" }, res);
      return { status: out.status, rows: (out.body.rows || []).map(r => r.event_type + ":" + (r.subject && r.subject.id)).sort(),
        decisions: decisions.slice(), sql: seen.filter(s => /^SELECT /.test(s) && / FROM (submissions sb|hint_reveals h) /.test(s)) };
    };
    const out = {
      actor: read({ types: "submission,hint", actor: "ann.mixed@corp.TEST" }),
      text: read({ types: "submission,hint", q: "ann1" }),
    };
    db.prepare = orig;
    process.stdout.write("\\nAUDIT_ACTOR_OUT " + JSON.stringify(out) + "\\n", () => process.exit(0));
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("AUDIT_ACTOR_OUT "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    const out = JSON.parse(line.slice("AUDIT_ACTOR_OUT ".length));
    // The actor filter: the person's own answer and hint, in another case; Bob's are not.
    expect(out.actor.status).toBe(200);
    expect(out.actor.rows).toEqual(["hint_revealed:u-a", "submission_correct:u-a"]);
    const byAlias = (d) => Object.fromEntries(d.map(x => [x.alias, x.walks]));
    expect(byAlias(out.actor.decisions), "each source's walk decision: searches alone reach the rows").toEqual({ sb: false, h: false });
    expect(out.actor.sql.length, "anti-vacuity: the composed statements were seen").toBeGreaterThanOrEqual(2);
    for (const s of out.actor.sql) {
      expect(s).toMatch(/AND u\.email = \? COLLATE NOCASE/);
      expect(s).not.toMatch(/LOWER\(u\.email\) =/);
    }
    // CONTROL: a filter no index serves is read as a walk through time, so the
    // recording would see a regression of the actor filter.
    expect(out.text.rows).toEqual(["hint_revealed:u-a", "submission_correct:u-a"]);
    expect(byAlias(out.text.decisions)).toEqual({ sb: true, h: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test.describe("GET /api/admin/audit — the actor box on answers and hints is never cut by the walk budget", () => {
  const ids = {};
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      ids.actor = rid(); ids.other = rid(); ids.task = rid();
      ids.actorEmail = `Actor.${T}@Corp.Test`;
      ids.nick = `${T}_actor`;
      const insU = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, created_at) VALUES (?,?,?,?,?,?)");
      db.transaction(() => {
        insU.run(ids.actor, "Actor", "Filter", ids.nick, ids.actorEmail, iso(BASE_MS));
        insU.run(ids.other, "Other", "Filler", `${T}_other`, `other.${T}@corp.test`, iso(BASE_MS));
        db.prepare("INSERT INTO tasks (id, title, difficulty, answer_type, correct_answer, status) VALUES (?,?,?,?,?,?)").run(ids.task, `Actor filter ${T}`, "easy", "text", "x", "published");
        const sub = db.prepare("INSERT INTO submissions (id, user_id, task_id, answer, is_correct, points_delta, submitted_at) VALUES (?,?,?,?,?,?,?)");
        const hint = db.prepare("INSERT INTO hint_reveals (competition_id, user_id, task_id, revealed_at) VALUES (?,?,?,?)");
        // BUDGET + 10 newer rows by someone else (a hint is one per person and
        // challenge, so its filler names a fresh person each time: no user row
        // is needed, hint_reveals has no foreign key).
        for (let i = 0; i < BUDGET + 10; i++) {
          sub.run(rid(), ids.other, ids.task, "wrong", 0, -5, iso(BASE_MS - i));
          hint.run("", rid(), ids.task, iso(BASE_MS - i));
        }
        // The actor's own, older than all of them.
        ids.sub = sub.run(rid(), ids.actor, ids.task, "x", 1, 50, iso(BASE_MS - 60_000)).lastInsertRowid;
        ids.hint = hint.run("", ids.actor, ids.task, iso(BASE_MS - 60_000)).lastInsertRowid;
      })();
    } finally { db.close(); }
  });

  async function audit(api, qs) {
    const r = await api.get(`/api/admin/audit?${qs}`);
    const text = await r.text();
    expect(r.status(), text).toBe(200);
    return JSON.parse(text);
  }

  test("the actor's answers and hints, behind more than the budget of other rows, are found on the first page with nothing cut", async () => {
    const { api } = await apiLogin("superadmin");
    try {
      for (const [type, rowId] of [["submission", ids.sub], ["hint", ids.hint]]) {
        // CONTROL: a text search for the same person walks by time, so the
        // budget stops it before their row.
        const cut = await audit(api, `types=${type}&q=${encodeURIComponent(ids.nick)}`);
        expect(cut.rows, `CONTROL ${type}: the walk is cut before the actor's row`).toEqual([]);
        expect(cut.has_more, `CONTROL ${type}`).toBe(true);
        expect(typeof cut.searched_to, `CONTROL ${type}: it says how far back it searched`).toBe("string");

        // The actor box, typed in another case: an index search, never cut.
        const b = await audit(api, `types=${type}&actor=${encodeURIComponent(ids.actorEmail.toLowerCase())}`);
        expect(b.rows.map(r => r.id), `${type}: the actor's row on the first page`).toEqual([`${type}:${rowId}`]);
        expect(b.rows[0].subject.id).toBe(ids.actor);
        expect(b.has_more, `${type}: nothing left to search`).toBe(false);
        expect(b.searched_to, `${type}: the walk was not cut`).toBeNull();
        expect(b.total).toBe(1);
        expect(b.total_exact).toBe(true);
      }
    } finally { await api.dispose(); }
  });
});
