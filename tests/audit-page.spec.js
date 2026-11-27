"use strict";

// THE AUDIT PAGE — GET /api/admin/audit (routes/audit.js) and its pane.
//
// What is pinned here, each beside a control that proves the row exists:
//   - every record type filters to itself, and a two-type filter returns both;
//   - the keyset walk returns every row once, in order, across tied timestamps
//     and two sources, while newer rows are inserted mid-walk;
//   - a ZERO-GRANT event admin sees nothing that names an event or a person;
//   - an event admin sees their own event's rows and none of the decoy's —
//     asserted BY VALUE (ids, names, addresses and answers absent from the whole
//     payload) beside a superadmin who sees both;
//   - a sealed answer is withheld from the stream AND from `q` (the search is an
//     oracle), while its author reads it and an ordinary answer stays searchable;
//   - details pass through the log redaction; challenge versions carry metadata
//     only; settings rows never reach an event admin;
//   - the real orphaned-event path writes the DB copy the page lists.
// Rows are PLANTED where the subject is the read (the event-admin-row-scope
// precedent): the writers are tested elsewhere, the scoping is tested here.
//
// The response is cached for 5 s per actor + URL, so every read below that must
// see a fresh write uses a URL it has not used before.

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, getSuperadminPass, codeLogin } = require("./helpers");
const { H, buildWorld, makeTask, assignTask, makeParticipant, enrol, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const T = uniq("aud").replace(/[^a-zA-Z0-9]/g, "");
const PROBE = `probe_${T}`;
const DUAL = `dual_${T}`;
const PAGE = `page_${T}`;
const SEALKEY = `SEALKEY_${T}`;
const PLAINANS = `PLAINANS_${T}`;
const DECOYANS = `DECOYANS_${T}`;
const LEAK_MAIL = `leak-${T}@private.example`;
const LEAK_JOIN = `JOINLEAK${T}`;
const LEAK_CODE = `CODELEAK${T}`;

function openDb() {
  const Database = require("better-sqlite3");
  return new Database(TEST_DB_PATH);
}
const iso = (ms) => new Date(ms).toISOString();
const rid = () => require("crypto").randomUUID();

/** @type {any} */ let w;
let sealedTask, plainTask, decoyTask, mineTs, theirsTs, dual;

async function audit(api, qs) {
  const r = await api.get(`/api/admin/audit?${qs}`);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  return { status: r.status(), body, text };
}

test.describe("GET /api/admin/audit", () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();

    // Challenges: one SEALED, authored by the event admin (the seal needs a
    // user-backed author); one ordinary, assigned to the actor's event; one on
    // the decoy only.
    sealedTask = await makeTask(w.eaApi, w.eaCsrf, "sealed", { answer_sealed: true, correct_answer: SEALKEY });
    plainTask = await makeTask(w.sa, w.saCsrf, "plain");
    decoyTask = await makeTask(w.sa, w.saCsrf, "decoy");
    await assignTask(w.sa, w.saCsrf, plainTask.id, [w.mine.id]);
    await assignTask(w.sa, w.saCsrf, decoyTask.id, [w.theirs.id]);
    // A participant enrolled in BOTH events: the only fixture on which the
    // History clause (a row naming the decoy) differs from the shares-an-event one.
    dual = await makeParticipant(w.sa, w.saCsrf, "dual");
    await enrol(w.sa, w.saCsrf, w.mine.id, [dual.id]);
    await enrol(w.sa, w.saCsrf, w.theirs.id, [dual.id]);

    const now = Date.now();
    const db = openDb();
    try {
      // Sessions, so the session source has a parent event to scope on.
      mineTs = rid(); theirsTs = rid();
      const insTs = db.prepare("INSERT INTO competition_timeslots (id, competition_id, name, start_time, duration_minutes, created_at) VALUES (?,?,?,?,?,?)");
      insTs.run(mineTs, w.mine.id, `Mine slot ${T}`, iso(now + 86400_000), 60, iso(now));
      insTs.run(theirsTs, w.theirs.id, `Theirs slot ${T}`, iso(now + 86400_000), 60, iso(now));

      const at = iso(now - 1000);
      db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
        .run(rid(), w.mine.id, PROBE, "superadmin", at, JSON.stringify({ note: "mine" }));
      db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
        .run(rid(), w.theirs.id, PROBE, "superadmin", at, JSON.stringify({ note: "theirs" }));
      const insTe = db.prepare("INSERT INTO timeslot_events (id, timeslot_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      insTe.run(rid(), mineTs, PROBE, "superadmin", at, null);
      insTe.run(rid(), theirsTs, PROBE, "superadmin", at, null);
      const insUe = db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      insUe.run(rid(), w.inMine.id, PROBE, "system", at, JSON.stringify({
        competition_id: w.mine.id, secondary_email: LEAK_MAIL, join_code: LEAK_JOIN,
        link: `https://example.test/verify?code=${LEAK_CODE}&x=1`,
      }));
      insUe.run(rid(), w.inTheirs.id, PROBE, "system", at, JSON.stringify({ competition_id: w.theirs.id }));
      insUe.run(rid(), dual.id, DUAL, "system", at, JSON.stringify({ competition_id: w.mine.id, side: "mine" }));
      insUe.run(rid(), dual.id, DUAL, "system", at, JSON.stringify({ competition_id: w.theirs.id, side: "theirs" }));
      db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
        .run(rid(), `key_${T}`, PROBE, "superadmin", at, JSON.stringify({ to: "x" }));
      const insOe = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      insOe.run(rid(), "competition", w.mine.id, PROBE, "superadmin", at, w.mine.id, null, null);
      insOe.run(rid(), "competition", w.theirs.id, PROBE, "superadmin", at, w.theirs.id, null, null);
      insOe.run(rid(), "export", "tasks", PROBE, "superadmin", at, null, null, null);

      const insSub = db.prepare("INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, answer, is_correct, points_delta, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
      insSub.run(rid(), w.inMine.id, sealedTask.id, w.mine.id, null, SEALKEY, 1, 50, at, at);
      insSub.run(rid(), w.inMine.id, plainTask.id, w.mine.id, null, PLAINANS, 0, -5, at, at);
      insSub.run(rid(), w.inTheirs.id, decoyTask.id, w.theirs.id, null, DECOYANS, 0, -5, at, at);
      const insHint = db.prepare("INSERT INTO hint_reveals (competition_id, user_id, task_id, timeslot_id, points_deducted, revealed_at, updated_at) VALUES (?,?,?,?,?,?,?)");
      insHint.run(w.mine.id, w.inMine.id, plainTask.id, null, 15, at, at);
      insHint.run(w.theirs.id, w.inTheirs.id, decoyTask.id, null, 15, at, at);
    } finally { db.close(); }
  });

  // ── per-type filters ───────────────────────────────────────────────────────

  test("each record type filters to itself, with the planted count", async () => {
    const expected = { event: 2, session: 2, person: 2, setting: 1, log_event: 3 };
    for (const [type, n] of Object.entries(expected)) {
      const { status, body, text } = await audit(w.sa, `types=${type}&event_type=${PROBE}`);
      expect(status, `${type}: ${text}`).toBe(200);
      expect(body.rows.length, `${type}: the planted rows come back`).toBe(n);
      expect(body.rows.every(r => r.type === type), `${type}: only that type`).toBe(true);
      expect(body.total_exact, "a narrowing filter counts").toBe(true);
      expect(body.total).toBe(n);
    }
    // Two types together: exactly their union.
    const two = await audit(w.sa, `types=event,person&event_type=${PROBE}`);
    expect(two.body.rows.map(r => r.type).sort()).toEqual(["event", "event", "person", "person"]);

    const subs = await audit(w.sa, `types=submission&competitionId=${w.mine.id}`);
    expect(subs.body.rows.length).toBe(2);
    expect(subs.body.rows.every(r => r.type === "submission" && r.competition_id === w.mine.id)).toBe(true);
    const hints = await audit(w.sa, `types=hint&subjectId=${plainTask.id}`);
    expect(hints.body.rows.length).toBe(1);
    expect(hints.body.rows[0].details).toMatchObject({ task_id: plainTask.id, points_deducted: 15 });

    const ver = await audit(w.sa, `types=challenge_version&subjectId=${sealedTask.id}`);
    expect(ver.body.rows.length, "creating a challenge writes a version").toBeGreaterThan(0);
    for (const r of ver.body.rows) {
      expect(r.type).toBe("challenge_version");
      expect(Object.keys(r.details).sort(), "metadata only, never the snapshot").toEqual(["change_type", "version_num"]);
    }
    expect(ver.text, "the sealed key never rides a version row").not.toContain(SEALKEY);
  });

  test("an unknown type, outcome, date, cursor, anchor or offset is refused with a named 400", async () => {
    const pos = encodeURIComponent((await audit(w.sa, "limit=1")).body.next_cursor);
    for (const [qs, code] of [["types=bogus", "audit_type_unknown"], ["outcome=meh", "audit_outcome_unknown"],
      ["from=not-a-date", "audit_date_invalid"], ["cursor=%%%", "audit_cursor_invalid"],
      ["anchor=%%%", "audit_anchor_invalid"], [`cursor=${pos}&anchor=${pos}`, "audit_position_conflict"],
      ["offset=-1", "audit_offset_invalid"], ["offset=1.5", "audit_offset_invalid"], ["offset=10001", "audit_offset_invalid"]]) {
      const { status, body } = await audit(w.sa, qs);
      expect(status, qs).toBe(400);
      expect(body.code, qs).toBe(code);
    }
  });

  test("the first page is counted with or without a filter; a later page is not", async () => {
    const { body } = await audit(w.sa, "limit=1");
    expect(body.rows.length).toBe(1);
    expect(typeof body.total, "no filter: the first page is counted too (the pager needs a count)").toBe("number");
    expect(body.total).toBeGreaterThan(1);
    expect(typeof body.total_exact).toBe("boolean");
    expect(body.has_more).toBe(true);
    expect(typeof body.next_cursor).toBe("string");
    expect(typeof body.anchor, "the first page names its newest row").toBe("string");
    expect(body.offset_max).toBe(10000);
    const next = await audit(w.sa, `limit=1&cursor=${encodeURIComponent(body.next_cursor)}`);
    expect(next.body.total, "a page below a cursor reads no count").toBeNull();
    expect(next.body.total_exact).toBe(false);
    expect(next.body.anchor, "and names no anchor").toBeNull();
    const deep = await audit(w.sa, `limit=1&anchor=${encodeURIComponent(body.anchor)}&offset=1`);
    expect(deep.status, deep.text).toBe(200);
    expect(deep.body.total, "nor does an anchored page").toBeNull();
    expect(deep.body.anchor, "which echoes its anchor").toBe(body.anchor);
    expect(deep.body.offset).toBe(1);
    expect(deep.body.rows.map(r => r.id), "the anchor keeps its own row: offset 1 is the row below it").toEqual(next.body.rows.map(r => r.id));
  });

  test("anchored pages tile the list in its order across ties and sources, and newer rows never shift them", async () => {
    const TILE = `tile_${Date.now().toString(36)}`;
    const base = Date.now() - 120_000;
    const tie = iso(base);
    const planted = [];
    const db = openDb();
    try {
      const ins = db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      const insO = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      for (let i = 0; i < 4; i++) { const id = rid(); ins.run(id, w.mine.id, TILE, "superadmin", tie, null); planted.push(id); }
      for (let i = 0; i < 2; i++) { const id = rid(); insO.run(id, "competition", w.mine.id, TILE, "superadmin", tie, w.mine.id, null, null); planted.push(id); }
      for (let i = 1; i <= 3; i++) { const id = rid(); ins.run(id, w.mine.id, TILE, "superadmin", iso(base - i * 1000), null); planted.push(id); }
    } finally { db.close(); }
    const qs = `types=event,log_event&event_type=${TILE}`;
    const whole = await audit(w.sa, `${qs}&limit=50`);
    expect(whole.body.rows.length, "CONTROL: one read holds every planted row").toBe(planted.length);
    expect(whole.body.total).toBe(planted.length);
    expect(whole.body.total_exact).toBe(true);
    const first = await audit(w.sa, `${qs}&limit=2`);
    expect(typeof first.body.anchor).toBe("string");
    // Newer rows land after the first page: an anchored page must not shift.
    const db2 = openDb();
    try {
      for (let i = 0; i < 3; i++) {
        db2.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
          .run(rid(), w.mine.id, TILE, "superadmin", iso(Date.now() + 1000), null);
      }
    } finally { db2.close(); }
    const seen = [...first.body.rows];
    for (let off = 2; off < planted.length + 4; off += 2) {
      const { status, body, text } = await audit(w.sa, `${qs}&limit=2&anchor=${encodeURIComponent(first.body.anchor)}&offset=${off}`);
      expect(status, text).toBe(200);
      seen.push(...body.rows);
      if (!body.has_more) break;
    }
    expect(seen.map(r => r.id), "the anchored pages are the one read's rows, in its order").toEqual(whole.body.rows.map(r => r.id));
    const top = await audit(w.sa, `${qs}&limit=49`);
    expect(top.body.rows.length, "the newer rows are above the anchor, on a fresh first page").toBe(planted.length + 3);
  });

  // ── keyset paging ──────────────────────────────────────────────────────────

  test("the keyset walk is stable across ties, sources and mid-walk inserts", async () => {
    const base = Date.now() - 60_000;
    const tie = iso(base);
    const planted = [];
    const db = openDb();
    try {
      const ins = db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      const insO = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      // Four rows at ONE millisecond in competition_events, two more at that
      // same millisecond in orphan_events, three at distinct times.
      for (let i = 0; i < 4; i++) { const id = rid(); ins.run(id, w.mine.id, PAGE, "superadmin", tie, null); planted.push(id); }
      for (let i = 0; i < 2; i++) { const id = rid(); insO.run(id, "competition", w.mine.id, PAGE, "superadmin", tie, w.mine.id, null, null); planted.push(id); }
      for (let i = 1; i <= 3; i++) { const id = rid(); ins.run(id, w.mine.id, PAGE, "superadmin", iso(base - i * 1000), null); planted.push(id); }
    } finally { db.close(); }

    const seen = [];
    let cursor = null;
    let pages = 0;
    let insertedNewer = false;
    for (;;) {
      const qs = `types=event,log_event&event_type=${PAGE}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { status, body, text } = await audit(w.sa, qs);
      expect(status, text).toBe(200);
      seen.push(...body.rows);
      pages++;
      if (!insertedNewer) {
        // Newer rows land after the first page: a keyset walk must not shift.
        const db2 = openDb();
        try {
          for (let i = 0; i < 3; i++) {
            db2.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
              .run(rid(), w.mine.id, PAGE, "superadmin", iso(Date.now() + 1000), null);
          }
        } finally { db2.close(); }
        insertedNewer = true;
      }
      if (!body.has_more) { expect(body.next_cursor).toBeNull(); break; }
      cursor = body.next_cursor;
      expect(pages, "the walk must end").toBeLessThan(20);
    }
    expect(seen.length, "every planted row once, none of the newer ones").toBe(planted.length);
    expect(new Set(seen.map(r => r.id)).size, "no duplicates across pages").toBe(planted.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1].at >= seen[i].at, "newest first").toBe(true);
    expect(seen.filter(r => r.at === tie).map(r => r.type).sort()).toEqual(["event", "event", "event", "event", "log_event", "log_event"]);
  });

  // ── event-admin scope ──────────────────────────────────────────────────────

  test("a ZERO-GRANT event admin sees nothing that names an event or a person", async () => {
    const probe = await audit(w.zeroApi, `event_type=${PROBE}`);
    expect(probe.status, probe.text).toBe(200);
    expect(probe.body.rows, "no planted row reaches an actor with no events").toEqual([]);
    expect(probe.body.total).toBe(0);
    const all = await audit(w.zeroApi, "limit=200");
    expect(all.status).toBe(200);
    expect(all.body.types, "settings are not among their types").not.toContain("setting");
    const bad = all.body.rows.filter(r => r.type !== "challenge_version" || r.competition_id);
    expect(bad, "only challenge versions they may view can remain, and none names an event").toEqual([]);
    const set = await audit(w.zeroApi, "types=setting");
    expect(set.status, "naming the settings type is refused, not ignored").toBe(403);
    expect(set.body.code).toBe("audit_type_forbidden");
  });

  test("an event admin sees their own event's rows and none of the decoy's (by value)", async () => {
    const ea = await audit(w.eaApi, `event_type=${PROBE}&limit=200`);
    expect(ea.status, ea.text).toBe(200);
    const types = ea.body.rows.map(r => r.type).sort();
    expect(types, "their event, session, participant and orphaned event — nothing else")
      .toEqual(["event", "log_event", "person", "session"]);
    expect(ea.body.rows.every(r => r.competition_id === w.mine.id)).toBe(true);
    expect(ea.text, "the decoy event's id appears nowhere").not.toContain(w.theirs.id);
    expect(ea.text, "…nor its name").not.toContain(w.theirs.name);
    expect(ea.text, "…nor its participant, by id").not.toContain(w.inTheirs.id);
    expect(ea.text, "…or by nickname").not.toContain(w.inTheirs.nickname);
    expect(ea.text, "…nor its session").not.toContain(theirsTs);
    expect(ea.body.total, "the count is over the narrowed set").toBe(ea.body.rows.length);

    // CONTROL — the superadmin sees all of it, so the fixture is real.
    const sa = await audit(w.sa, `event_type=${PROBE}&limit=200`);
    expect(sa.body.rows.length).toBe(10);
    expect(sa.text).toContain(w.theirs.id);
    expect(sa.text).toContain(w.inTheirs.id);
    expect(sa.text).toContain(w.inTheirs.nickname);
    expect(sa.body.rows.some(r => r.type === "setting")).toBe(true);
    expect(sa.body.rows.some(r => r.type === "log_event" && r.competition_id === null)).toBe(true);
  });

  test("a participant in both events: only the history rows naming the actor's event", async () => {
    const ea = await audit(w.eaApi, `types=person&event_type=${DUAL}`);
    expect(ea.status, ea.text).toBe(200);
    expect(ea.body.rows.map(r => r.details.side), "the row naming their event, not the decoy's").toEqual(["mine"]);
    expect(ea.text).not.toContain(w.theirs.id);
    const sa = await audit(w.sa, `types=person&event_type=${DUAL}`);
    expect(sa.body.rows.map(r => r.details.side).sort(), "CONTROL — both rows exist").toEqual(["mine", "theirs"]);
  });

  test("submissions, hints and challenge versions are scoped too", async () => {
    const subs = await audit(w.eaApi, "types=submission,hint&limit=200");
    expect(subs.status, subs.text).toBe(200);
    expect(subs.text, "their event's answer").toContain(PLAINANS);
    expect(subs.text, "the decoy's answer appears nowhere").not.toContain(DECOYANS);
    expect(subs.text).not.toContain(decoyTask.id);
    expect(subs.body.rows.filter(r => r.type === "hint").length).toBe(1);
    const saSubs = await audit(w.sa, "types=submission,hint&limit=200");
    expect(saSubs.text, "CONTROL — the decoy's answer exists").toContain(DECOYANS);

    const vers = await audit(w.eaApi, "types=challenge_version&limit=200");
    const ids = vers.body.rows.map(r => r.subject.id);
    expect(ids, "their own challenge").toContain(sealedTask.id);
    expect(ids, "a challenge assigned to their event").toContain(plainTask.id);
    expect(ids, "not the decoy's").not.toContain(decoyTask.id);
    const saVers = await audit(w.sa, "types=challenge_version&limit=200");
    expect(saVers.body.rows.map(r => r.subject.id), "CONTROL").toContain(decoyTask.id);
  });

  test("scope before existence: a named event or session outside scope is 403", async () => {
    for (const qs of [`competitionId=${w.theirs.id}`, "competitionId=no-such-event", `timeslotId=${theirsTs}`, "timeslotId=no-such-session"]) {
      const r = await audit(w.eaApi, qs);
      expect(r.status, `${qs}: ${r.text}`).toBe(403);
    }
    expect((await audit(w.sa, "competitionId=no-such-event")).status, "an unscoped admin is told it does not exist").toBe(404);
    expect((await audit(w.sa, "timeslotId=no-such-session")).status).toBe(404);
    const own = await audit(w.eaApi, `timeslotId=${mineTs}`);
    expect(own.status).toBe(200);
    expect(own.body.rows.length).toBe(1);
    expect(own.body.rows[0].type).toBe("session");
  });

  // ── the sealed answer ──────────────────────────────────────────────────────

  test("a sealed answer is withheld from the stream AND from q", async () => {
    // The built-in superadmin authors nothing and has revealed nothing.
    const sa = await audit(w.sa, `types=submission&subjectId=${sealedTask.id}`);
    expect(sa.body.rows.length).toBe(1);
    expect(sa.body.rows[0].details).toMatchObject({ answer: null, answer_sealed: true, answer_visible: false });
    expect(sa.text, "the key appears nowhere in the payload").not.toContain(SEALKEY);
    const q = await audit(w.sa, `q=${encodeURIComponent(SEALKEY.toLowerCase())}`);
    expect(q.body.rows, "the search cannot confirm a guessed key").toEqual([]);
    expect(q.body.total).toBe(0);
    // CONTROL — an ordinary answer is searchable by the same actor.
    const plain = await audit(w.sa, `q=${encodeURIComponent(PLAINANS)}`);
    expect(plain.body.rows.length).toBe(1);
    expect(plain.body.rows[0].details.answer).toBe(PLAINANS);
    // CONTROL — the author reads and finds their own key.
    const author = await audit(w.eaApi, `q=${encodeURIComponent(SEALKEY)}`);
    expect(author.body.rows.length).toBe(1);
    expect(author.body.rows[0].details).toMatchObject({ answer: SEALKEY, answer_visible: true });
  });

  // ── redaction ──────────────────────────────────────────────────────────────

  test("details pass through the log redaction", async () => {
    const r = await audit(w.sa, `types=person&subjectId=${w.inMine.id}&event_type=${PROBE}`);
    expect(r.body.rows.length).toBe(1);
    const d = r.body.rows[0].details;
    expect(d.secondary_email).toBe("[REDACTED]");
    expect(d.join_code).toBe("[REDACTED]");
    expect(d.link).toContain("code=[REDACTED]");
    expect(d.competition_id, "CONTROL — an ordinary key passes").toBe(w.mine.id);
    for (const leak of [LEAK_MAIL, LEAK_JOIN, LEAK_CODE]) expect(r.text).not.toContain(leak);
    // The search does not reach raw details, so it cannot confirm a redacted value.
    const q = await audit(w.sa, `q=${encodeURIComponent(LEAK_JOIN.toLowerCase())}`);
    expect(q.body.rows).toEqual([]);
  });

  test("a real orphaned event is written to orphan_events and listed", async () => {
    const before = Date.now();
    const ex = await w.sa.get("/api/admin/export/tasks");
    expect(ex.ok(), `export: ${ex.status()}`).toBeTruthy();
    const db = openDb();
    try {
      const row = db.prepare("SELECT * FROM orphan_events WHERE event_type='data_exported' AND changed_at >= ? ORDER BY changed_at DESC LIMIT 1").get(iso(before - 1000));
      expect(row, "the DB copy exists").toBeTruthy();
      expect(row.scope).toBe("export");
      expect(row.changed_by).toBe("superadmin");
    } finally { db.close(); }
    const r = await audit(w.sa, `types=log_event&event_type=data_exported&from=${encodeURIComponent(iso(before - 1000))}`);
    expect(r.body.rows.length).toBeGreaterThan(0);
    expect(r.body.rows[0].actor).toBe("superadmin");
    // An event admin never sees an orphaned event that names no event.
    const ea = await audit(w.eaApi, `types=log_event&event_type=data_exported&from=${encodeURIComponent(iso(before - 1000))}`);
    expect(ea.body.rows).toEqual([]);
  });
});

// ── the pane ─────────────────────────────────────────────────────────────────

test.describe("the Audit pane", () => {
  async function loginSuper(page) {
    const t = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const r = await codeLogin(page.request, "superadmin", H(t), { password: getSuperadminPass() });
    expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
  }
  async function openPane(page) {
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    await page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]').evaluate(el => el.click());
    await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#admin-audit-body tr").first()).toBeVisible({ timeout: 20000 });
  }

  test("opens, filters by type, and fits a phone without sideways scroll", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginSuper(page);
    await openPane(page);
    await expect(page.locator("#admin-audit-body tr td .audit-type-badge").first(), "rows render").toBeVisible();

    const req = page.waitForRequest(r => r.url().includes("/api/admin/audit?") && r.url().includes("types=event"));
    await page.locator('#audit-type-filters [data-type="event"]').click();
    await req;
    await expect.poll(async () => page.locator("#admin-audit-body .audit-type-badge").evaluateAll(
      els => els.length > 0 && els.every(e => e.getAttribute("data-type") === "event")), { timeout: 15000 }).toBe(true);
    await expect(page.locator('#audit-type-filters [data-type="event"]')).toHaveAttribute("aria-pressed", "true");
    // CONTROL — the unfiltered list held other types, so the filter did something.
    await page.locator('#audit-type-filters [data-type="event"]').click();
    await expect.poll(async () => page.locator("#admin-audit-body .audit-type-badge").evaluateAll(
      els => new Set(els.map(e => e.getAttribute("data-type"))).size), { timeout: 15000 }).toBeGreaterThan(1);

    // The details dialog opens and closes.
    await page.locator('#admin-audit-body [data-action="audit-row-details"]').first().click();
    await expect(page.locator("#audit-detail-overlay [role=dialog]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#audit-detail-overlay")).toHaveCount(0);

    // The command palette's "Go to" lists the Audit page (it reads the sidebar).
    await page.evaluate(() => { window.openCommandPalette(); });
    await page.locator("#cp-input").fill("Audit");
    await expect(page.locator("#cp-list .cp-opt .cp-label", { hasText: /^Audit$/ })).toHaveCount(1);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await openPane(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no sideways scroll at phone width").toBeLessThanOrEqual(0);
    // The table became cards: the first row's cells carry their column label.
    await expect(page.locator("#admin-audit-body tr td[data-label]").first()).toBeVisible();
  });
});
