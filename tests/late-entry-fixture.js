// @ts-check
//
// v8.12.6 — THE LATE-ENTRY FIXTURES, shared by every spec that needs an event which
// has ENDED with its late-entry window open. Moved VERBATIM out of
// tests/late-entries.spec.js (v8.6.0), which imports them from here; its pass count
// is unchanged by the move, which is the proof the move changed nothing.
//
// This module must NOT require ./isolated-test: that module registers the per-file
// server recycle at import time, and a helper that imported it would register a
// second one for whichever spec loaded it (the ui-admin-helpers.js rule). It needs
// only `expect` and ./helpers. No database-backed `lib/` module is required at
// module scope either (the v7.20.2 rule) — every direct write below opens the
// SERVER's database lazily, per call.
//
// ── THE FIXTURE TRAP, READ BEFORE USING `expireEvent` ────────────────────────
//
// There is no clock control, so an event that has ended is built BACKWARDS: create
// it LIVE, enrol and act, then MOVE ITS START into the past. That re-times the
// whole event. Everything a fixture did "while live" — `competition_users.
// assigned_at`, `submissions.submitted_at`, `hint_reveals.revealed_at`,
// `competition_users.login_time`, and a group's `competition_groups.assigned_at`
// (its bind time) — is then stamped AFTER the new end, i.e. it
// reads as having happened in the late-entry window. A test whose subject is "they
// joined / played / entered BEFORE the end" must back-date those facts itself
// (`rawSetAssignedAt`, `rawBackdateSubmissions`, `rawBackdate`) or pass `endAt`
// a moment it knows to be after them. Getting this wrong does not fail loudly: it
// turns an "in the event before it ended" participant into a late entrant, and the
// assertion then measures the wrong person.
//
// ── TWO CACHES MUST BE WAITED OUT, AND THEY ARE DIFFERENT LENGTHS ────────────
//
//   * the competition ROW, 1 s (lib/competitions.js) — `outliveCompCache()` after
//     any direct write to `competitions`;
//   * the admin participants PAGE, 5 s (lib/participants-cache.js) — a direct write
//     to `competition_users` / `submissions` is invisible to GET
//     /api/admin/participants until it expires, because a direct write busts
//     nothing. `outliveParticipantsCache()` exists for exactly that.
const { expect } = require("@playwright/test");
const { freshCtx, getSuperadminPass, gradingHashFor, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin, registerPost } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `le${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// lib/competitions.js caches a competition row for 1 s. Every direct write below
// must be VISIBLE to the handler under test, and there is no invalidation hook a
// spec can reach, so the wait IS the mechanism (the v8.3.11 rule, same file).
const CACHE_TTL_MS = 1_000;
const outliveCompCache = () => new Promise(r => setTimeout(r, CACHE_TTL_MS + 250));

const MIN = 60_000;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${await r.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}

/** Own every participant (fixture checklist item 3). */
async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Late", lastName: "Probe", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get("/api/admin/participants?limit=5000")).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} findable`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

/**
 * Direct SQLite write against the SERVER's own database.
 *
 * The `better-sqlite3` require is LAZY (v7.20.2): a module-scope binding is taken
 * BEFORE the per-file recycle deletes and recreates the file, leaving a handle on
 * an unlinked inode that answers with the previous file's data and no error.
 */
function rawUpdateComp(id, sql, params = []) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare(`UPDATE competitions SET ${sql} WHERE id=?`).run(...params, id);
    expect(r.changes, "the direct write must land, or every assertion after it is about nothing").toBe(1);
  } finally { db.close(); }
}

function rawGetComp(id) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare("SELECT * FROM competitions WHERE id=?").get(id); } finally { db.close(); }
}

/** Back-date `assigned_at` so a participant counts as having joined at a moment. */
function rawSetAssignedAt(compId, userId, iso) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare("UPDATE competition_users SET assigned_at=? WHERE competition_id=? AND user_id=?").run(iso, compId, userId);
    expect(r.changes, "the assigned_at write must land").toBe(1);
  } finally { db.close(); }
}

/**
 * A LIVE, sessionless Booth Event with N published text challenges.
 *
 * TEXT answers, because a Booth Event REFUSES `answer_type:'file'` and any
 * `needs:`-tagged challenge (lib/challenge-fit.js) — the assign would 400 and the
 * failure would read as a late-entry bug.
 */
async function liveBooth(api, csrf, opts = {}) {
  const create = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `LE ${uniq()}`,
      event_kind: opts.kind || "booth",
      add_qualifying: false,   // this fixture's challenges are its own scored ones
      start_time: new Date(Date.now() - 5 * MIN).toISOString(),
      duration_minutes: opts.duration || 180,
      // Left ON: the join link is the door this feature is about. It also
      // suppresses the all-solved auto-end (v7.7.18), which is what keeps a
      // fully-solved fixture LIVE until this file ends it deliberately.
      self_enroll_enabled: true,
      ...(opts.create || {}),
    },
  });
  expect(create.ok(), `create: ${await create.text()}`).toBeTruthy();
  const comp = (await create.json()).competition;
  expect(comp.status, "the fixture must really be LIVE").toBe("live");

  const taskIds = [];
  for (let i = 0; i < (opts.tasks || 1); i++) {
    const t = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: {
        title: `LE task ${uniq()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "win", status: "published",
      },
    });
    expect(t.ok(), `create task: ${await t.text()}`).toBeTruthy();
    const id = (await t.json()).id;
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign task: ${await asg.text()}`).toBeTruthy();
    taskIds.push(id);
  }
  return { comp, taskIds };
}

async function enrol(api, csrf, compId, userId) {
  const r = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [userId], competitionIds: [compId] } });
  // The assign endpoint SILENTLY SKIPS staff / benchmark / blocked / unapproved
  // users, so the count is asserted — a skip would surface much later as an
  // inexplicable "they are not on the board".
  expect((await r.json()).assigned, "the participant must really be enrolled").toBe(1);
}

/**
 * END the event by moving its start into the past, and open the late window.
 *
 * A time-expired end (`ended_at` NULL) rather than End Now, because that is the
 * ordinary way a booth finishes: the clock runs out. Returns the effective end.
 *
 * `endAt` places the end at a CHOSEN past instant rather than a round number of
 * minutes ago, and it is not a convenience. Moving the start backwards re-times
 * the whole event, so anything a fixture did "while live" is now stamped AFTER the
 * new end — which silently breaks any test whose subject is "they finished BEFORE
 * the end". Such a test passes `endAt` a moment it knows to be after its own
 * submissions.
 */
async function expireEvent(compId, { agoMinutes = 30, duration = 60, endAt = null } = {}) {
  const end = endAt ? new Date(endAt) : new Date(Date.now() - agoMinutes * MIN);
  const start = new Date(end.getTime() - duration * MIN).toISOString();
  rawUpdateComp(compId, "start_time=?, duration_minutes=?", [start, duration]);
  await outliveCompCache();
  return end;
}

/**
 * Back-date a participant's submissions, so "they solved everything BEFORE the
 * end" is true of a fixture whose end has been moved into the past.
 *
 * The same technique as `rawSetAssignedAt` beside it, and honest for the same
 * reason: the rows were created by the real submit path and graded by the real
 * grader — only the timestamp moves, which is the one fact a spec with no clock
 * control cannot otherwise set. Reading the real submitted_at and choosing an end
 * just after it was tried first and is RACY: the solve lands milliseconds before
 * the assertion, so an end placed after it is still in the FUTURE and the event
 * reads live rather than ended.
 */
function rawBackdateSubmissions(compId, userId, iso) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare("UPDATE submissions SET submitted_at=? WHERE competition_id=? AND user_id=?").run(iso, compId, userId);
    expect(r.changes, "the fixture's solve must be on record to be back-dated").toBeGreaterThan(0);
  } finally { db.close(); }
}

/** A participant session, already selected into the competition. */
async function participantCtx(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const login = await codeLogin(api, email, H(c0));
  expect(login.ok(), `participant login: ${await login.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  if (compId) {
    const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
  }
  return { api, csrf };
}

async function submit(api, csrf, taskId, answer = "win") {
  return api.post(`/api/tasks/${taskId}/submit`, {
    headers: H(csrf), data: { answer, gradingHash: await gradingHashFor(api, taskId) },
  });
}

// ─── v8.12.6 additions (not moved) ───────────────────────────────────────────

// lib/participants-cache.js keeps an admin participants page for 5 s, and a direct
// database write invalidates nothing.
const PARTICIPANTS_CACHE_TTL_MS = 5_000;
const outliveParticipantsCache = () => new Promise(r => setTimeout(r, PARTICIPANTS_CACHE_TTL_MS + 300));

/**
 * Back-date any per-(user, competition) timestamp column, for the fixture trap in
 * this module's header. `table` and `column` are chosen by the TEST from a fixed
 * list, never by input; the value is bound.
 */
const _BACKDATABLE = {
  competition_users: ["assigned_at", "login_time"],
  submissions: ["submitted_at"],
  hint_reveals: ["revealed_at"],
  competition_user_absences: ["login_time", "assigned_at", "removed_at"],
};
function rawBackdate(table, column, compId, userId, iso) {
  if (!(_BACKDATABLE[table] || []).includes(column)) throw new Error(`rawBackdate: ${table}.${column} is not back-datable`);
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare(`UPDATE ${table} SET ${column}=? WHERE competition_id=? AND user_id=?`).run(iso, compId, userId);
    expect(r.changes, `the ${table}.${column} back-date must land`).toBeGreaterThan(0);
  } finally { db.close(); }
}

/** Read-only SQL against the SERVER's database (lazy handle, the v7.20.2 rule). */
function rawAll(sql, params = []) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
function rawGet(sql, params = []) { return rawAll(sql, params)[0]; }

/** A direct write the fixture cannot express otherwise; asserts it landed. */
function rawRun(sql, params = []) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare(sql).run(...params);
    expect(r.changes, `the direct write must land: ${sql}`).toBeGreaterThan(0);
    return r;
  } finally { db.close(); }
}

module.exports = {
  H, uniq, MIN, CACHE_TTL_MS, outliveCompCache, outliveParticipantsCache,
  sa, makeParticipant, rawUpdateComp, rawGetComp, rawSetAssignedAt, liveBooth, enrol,
  expireEvent, rawBackdateSubmissions, participantCtx, submit,
  rawBackdate, rawAll, rawGet, rawRun,
};
