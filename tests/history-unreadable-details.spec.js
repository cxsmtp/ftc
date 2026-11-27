"use strict";

// ONE ROW WHOSE STORED DETAILS ARE NOT JSON MUST NOT BREAK THE LIST HOLDING IT.
//
// Every audit row keeps its `details` as JSON text. A row written otherwise (a
// hand edit, a write cut short; Checkmarx One accounts whose provisioning record
// cannot be read exist in practice) made every list holding it answer 500:
//   * lib/audit.js `_parseEventRows` parsed unguarded, so a participant's
//     History and the event, session and settings histories failed for EVERY
//     reader (`_eventListResponse`);
//   * the History's SQL (lib/event-admin.js `userEventDetailsSql`, its rewrite of
//     an older revocation's token, and, for a reader scoped to their events,
//     `userEventCompetitionScopeSql` and the email subject rewrite) handed the
//     text to JSON functions, which throw on it, failing the History, the person
//     export and the Audit page's people rows before any JS ran;
//   * the delivery panel's failed-send count and the event team report's arrival
//     lookup did the same.
// Now ONE parser (lib/audit.js `parseStoredDetails`) reads such text as
// `{ details_unreadable: true }`: the row keeps its type, time and actor, is
// counted and paged like any other, and its stored text never reaches a reader.
// A reader scoped to their events never gets it (it cannot be judged: whatever
// event it names is unknown). History (a challenge's reveal record included) and
// the Audit page's details dialog say in words that its details could not be
// read. A row with NO details (NULL, or the empty text) is not unreadable: it
// reads as null and, naming no event, reaches a scoped reader too.
//
// Fixtures, each owned here: a participant enrolled in an event A (organised by
// an event admin) and a decoy event B, a session on A, and PLANTED rows (the
// read is the subject, not the writer), each malformed text carrying a unique
// RAW marker so its absence from every answer is asserted by value, plus two
// rows with no details at all.

const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, TEST_DB_PATH, apiLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const MARK = { details_unreadable: true };
const SENTENCE = "The details recorded for this entry could not be read";
const T = uniq("f2").replace(/[^a-zA-Z0-9]/g, "");
const RAW = `RAW-${T}`;
const W = {};

function openDb(readonly) {
  const Database = require("better-sqlite3");
  return new Database(TEST_DB_PATH, readonly ? { readonly: true } : {});
}

/** The rows of `table` for one entity at a list's anchor, newest first. */
function rowsAtAnchor(table, column, value, anchor, tie) {
  const db = openDb(true);
  try {
    return db.prepare(
      `SELECT rowid AS rid, id, event_type, changed_by, changed_at, details FROM ${table}
        WHERE ${column} = ? AND (changed_at < ? OR (changed_at = ? AND rowid <= ?))
        ORDER BY changed_at DESC, rowid DESC`
    ).all(value, anchor, anchor, Number(tie));
  } finally { db.close(); }
}

/** The details a reader is shown for a stored row: the parsed JSON, or the mark. */
function expectedDetails(r, planted) {
  if (planted.has(r.id)) return MARK;
  return r.details ? JSON.parse(r.details) : null;
}

/** Every page of a list at `full`'s anchor (the whole list, read first), `limit` rows a page. */
async function walk(api, url, full, limit) {
  const ids = [], totals = [];
  for (let offset = 0; offset < 1000; offset += limit) {
    const q = [`offset=${offset}`, `limit=${limit}`,
      `snapshot_before=${encodeURIComponent(full.snapshot_before)}`, `snapshot_tie=${encodeURIComponent(full.snapshot_tie)}`];
    const r = await api.get(`${url}?${q.join("&")}`);
    expect(r.status(), `page at ${offset}: ${await r.text()}`).toBe(200);
    const b = await r.json();
    totals.push(b.total);
    ids.push(...b.events.map(e => e.id));
    if (!b.events.length || offset + limit >= b.total) break;
  }
  return { ids, totals };
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const s = await apiLogin("superadmin");
  W.sa = s.api; W.saCsrf = s.csrf;
  W.A = await makeCompetition(W.sa, W.saCsrf, "unreadA");
  W.B = await makeCompetition(W.sa, W.saCsrf, "unreadB");
  W.ea = await makeParticipant(W.sa, W.saCsrf, "unreadea");
  W.p = await makeParticipant(W.sa, W.saCsrf, "unreadp");
  await enrol(W.sa, W.saCsrf, W.A.id, [W.p.id]);
  await enrol(W.sa, W.saCsrf, W.B.id, [W.p.id]);
  await grantEventAdmin(W.sa, W.saCsrf, W.A.id, W.ea.id);
  const l = await apiLogin(W.ea.email, PARTICIPANT_PASS);
  W.eaApi = l.api;
  const me = await (await W.eaApi.get("/api/admin/me")).json();
  expect(me.isEventAdmin, "PRECONDITION: the reader holds the event admin tier").toBe(true);
  expect(me.eventAdminCompetitionCount, "…scoped to exactly event A").toBe(1);
  const ts = await W.sa.post(`/api/admin/competitions/${W.A.id}/timeslots`, { headers: H(W.saCsrf), data: {
    name: `Unreadable ${T}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
  } });
  expect(ts.ok(), `session: ${ts.status()} ${await ts.text()}`).toBeTruthy();
  W.S = (await ts.json()).timeslot.id;

  // The planted rows: malformed texts (cut short, never closed), each with its RAW
  // marker, a minute in the past so the fixture's own rows stay newer; and one
  // well-formed control row read back on the Audit page.
  W.actor = `unread-actor-${T}@acme.com`;
  W.okActor = `ok-actor-${T}@acme.com`;
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const db = openDb(false);
  try {
    const ue = db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
    const put = (key, ...a) => { W[key] = { id: a[0], type: a[2], at: a[4], rid: Number(ue.run(...a).lastInsertRowid) }; };
    put("uLogin", `u1-${T}`, W.p.id, "login_success", "system", at(1), `{"ip":"10.9.8.7","probe":"${RAW}-login"`);
    // A revocation: every reader's projection strips an older row's token.
    put("uRevoked", `u2-${T}`, W.p.id, "badge_revoked", "superadmin", at(2), `{"token":"${RAW}-token","competition_id":"${W.A.id}"`);
    // A mail: a scoped reader's projection rewrites an older mail's subject.
    put("uEmail", `u3-${T}`, W.p.id, "email_sent", W.actor, at(3), `{"to":"x@acme.com","subject":"${RAW}-subject"`);
    // An enrolment: the event team report looks up how a lead arrived.
    put("uArrival", `u4-${T}`, W.p.id, "added_to_competition", "superadmin", at(4), `{"competition_id":"${W.A.id}","via":"${RAW}-arrival"`);
    put("uOk", `u5-${T}`, W.p.id, "tag_added", W.okActor, at(5), JSON.stringify({ tag: `ok-${T}` }));
    // No details at all, as an older or hand-made row may hold (no writer stores
    // either): NULL, and the empty text. Each reads as no details (null), not as
    // unreadable, and names no event, so unlike the rows above a reader scoped to
    // their events is given it. Types no server logic reads back.
    W.noneActor = `none-actor-${T}@acme.com`;
    W.emptyActor = `empty-actor-${T}@acme.com`;
    put("uNull", `u6-${T}`, W.p.id, "tag_removed", W.noneActor, at(10), null);
    put("uEmpty", `u7-${T}`, W.p.id, "unblocked", W.emptyActor, at(11), "");
    const ce = db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
    W.cMinted = { id: `c1-${T}`, rid: Number(ce.run(`c1-${T}`, W.A.id, "badge_minted", "system", at(6), `{"nickname":"${RAW}-minted"`).lastInsertRowid) };
    W.sSession = { rid: Number(db.prepare("INSERT INTO timeslot_events (id, timeslot_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
      .run(`s1-${T}`, W.S, "edited", "superadmin", at(7), `{"changes":{"name":${RAW}-ts`).lastInsertRowid) };
    W.gSetting = { rid: Number(db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
      .run(`g1-${T}`, `f2_probe_${T}`, "updated", "superadmin", at(8), `{"from":${RAW}-setting`).lastInsertRowid) };
    const oe = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
    const orphan = (id, scope, type, sec, details) => ({ rid: Number(oe.run(id, scope, "f2", type, "superadmin", at(sec), W.A.id, null, details).lastInsertRowid) });
    W.oExport = orphan(`o1-${T}`, "export", "data_exported", 9, `{"user_id":${RAW}-orphan`);
    // The Audit page's outcome: a type whose name says it failed stays a failure
    // whatever its details (unreadable here); a readable `ok: false` is a failure
    // (CONTROL); details of only whitespace are unreadable (JSON.parse throws),
    // never "no details".
    W.oRefused = orphan(`o2-${T}`, "email", "email_proof_refused", 12, `{"domain":${RAW}-refused`);
    W.oFailOk = orphan(`o3-${T}`, "email", "test_email_sent", 13, JSON.stringify({ ok: false }));
    W.oBlank = orphan(`o4-${T}`, "export", "data_exported", 14, "   ");
  } finally { db.close(); }
  W.plantedUser = new Set([W.uLogin.id, W.uRevoked.id, W.uEmail.id, W.uArrival.id]);
  // The real enrolment rows, by the event each names (read past every projection).
  const rdb = openDb(true);
  try {
    const adds = rdb.prepare("SELECT id, details FROM user_events WHERE user_id=? AND event_type='added_to_competition'").all(W.p.id)
      .filter(r => !W.plantedUser.has(r.id)).map(r => ({ id: r.id, cid: JSON.parse(r.details).competition_id }));
    W.addA = adds.find(a => a.cid === W.A.id);
    W.addB = adds.find(a => a.cid === W.B.id);
  } finally { rdb.close(); }
  expect(W.addA && W.addB, "PRECONDITION: the two real enrolments were recorded").toBeTruthy();
});

test.afterAll(async () => {
  if (W.sa) await W.sa.dispose();
  if (W.eaApi) await W.eaApi.dispose();
});

test.describe("a participant's History with rows whose details cannot be read", () => {
  test("a global reader gets 200, every other row intact by value, the unreadable ones marked, total = rows", async () => {
    const r = await W.sa.get(`/api/admin/participants/${W.p.id}/events?offset=0&limit=500`);
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    const stored = rowsAtAnchor("user_events", "user_id", W.p.id, body.snapshot_before, body.snapshot_tie);
    expect(stored.length, "PRECONDITION: the planted rows and the fixture's own are stored").toBeGreaterThan(W.plantedUser.size + 3);
    expect(body.events.map(e => e.id), "every stored row is listed, in order").toEqual(stored.map(s => s.id));
    expect(body.total, "total counts what is listed").toBe(stored.length);
    for (const s of stored) {
      const ev = body.events.find(e => e.id === s.id);
      expect([ev.event_type, ev.changed_by, ev.changed_at], `row ${s.id}: type, actor and time`).toEqual([s.event_type, s.changed_by, s.changed_at]);
      expect(ev.details, `row ${s.id} (${s.event_type}): its details`).toEqual(expectedDetails(s, W.plantedUser));
    }
    expect(JSON.stringify(body), "no stored text of an unreadable row reaches the reader").not.toContain(RAW);
    // CONTROL: the well-formed planted row reads as written.
    expect(body.events.find(e => e.id === W.uOk.id).details).toEqual({ tag: `ok-${T}` });

    // The legacy (unpaginated) array answers the same rows.
    const bare = await W.sa.get(`/api/admin/participants/${W.p.id}/events`);
    expect(bare.status(), await bare.text()).toBe(200);
    const arr = await bare.json();
    expect(Array.isArray(arr)).toBe(true);
    for (const id of W.plantedUser) expect(arr.find(e => e.id === id).details, `bare array: ${id}`).toEqual(MARK);
  });

  test("paging stays consistent: two rows a page reaches every row once, under one total", async () => {
    const all = await (await W.sa.get(`/api/admin/participants/${W.p.id}/events?offset=0&limit=500`)).json();
    const { ids, totals } = await walk(W.sa, `/api/admin/participants/${W.p.id}/events`, all, 2);
    expect(new Set(totals).size, `one total across pages: ${totals}`).toBe(1);
    expect(totals[0]).toBe(all.total);
    expect(ids, "the pages, joined, are the list").toEqual(all.events.map(e => e.id));
    for (const id of W.plantedUser) expect(ids, `the walk reaches ${id}`).toContain(id);
  });

  test("a reader scoped to their events gets 200 without the unreadable rows (they cannot be judged), total = rows", async () => {
    const r = await W.eaApi.get(`/api/admin/participants/${W.p.id}/events?offset=0&limit=500`);
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    const ids = body.events.map(e => e.id);
    for (const id of W.plantedUser) expect(ids, `the unreadable row ${id} is withheld`).not.toContain(id);
    expect(ids, "CONTROL: the enrolment in their own event is listed").toContain(W.addA.id);
    expect(ids, "CONTROL: a row naming no event is listed").toContain(W.uOk.id);
    expect(ids, "CONTROL: the decoy event's enrolment is still withheld").not.toContain(W.addB.id);
    expect(body.total).toBe(body.events.length);
    expect(JSON.stringify(body)).not.toContain(RAW);
    const sa = await (await W.sa.get(`/api/admin/participants/${W.p.id}/events?offset=0&limit=500`)).json();
    const saIds = sa.events.map(e => e.id);
    for (const id of ids) expect(saIds, `${id} is one of the global reader's rows`).toContain(id);
    for (const id of W.plantedUser) expect(saIds, `CONTROL: ${id} exists`).toContain(id);
    // Paging under the scope, too.
    const walked = await walk(W.eaApi, `/api/admin/participants/${W.p.id}/events`, body, 2);
    expect(new Set(walked.totals).size).toBe(1);
    expect(walked.ids).toEqual(ids);
  });

  test("the event, session and settings histories (the same list builder) answer 200 with the row marked", async () => {
    const lists = [
      ["the event's History", W.sa, `/api/admin/competitions/${W.A.id}/events`, "competition_events", "competition_id", W.A.id, `c1-${T}`],
      ["…read by its organiser", W.eaApi, `/api/admin/competitions/${W.A.id}/events`, "competition_events", "competition_id", W.A.id, `c1-${T}`],
      ["the session's History", W.sa, `/api/admin/competitions/${W.A.id}/timeslots/${W.S}/events`, "timeslot_events", "timeslot_id", W.S, `s1-${T}`],
      ["the settings History", W.sa, "/api/admin/settings/events", "settings_events", "1", 1, `g1-${T}`],
    ];
    for (const [what, api, url, table, col, val, planted] of lists) {
      const r = await api.get(`${url}?offset=0&limit=5000`);
      expect(r.status(), `${what}: ${await r.text()}`).toBe(200);
      const body = await r.json();
      const stored = rowsAtAnchor(table, col, val, body.snapshot_before, body.snapshot_tie);
      expect(body.events.map(e => e.id), `${what}: every stored row, in order`).toEqual(stored.map(s => s.id));
      expect(body.total, `${what}: total`).toBe(stored.length);
      for (const s of stored) {
        expect(body.events.find(e => e.id === s.id).details, `${what}: ${s.id}`).toEqual(expectedDetails(s, new Set([planted])));
      }
      expect(JSON.stringify(body), `${what}: no stored text`).not.toContain(RAW);
      const bare = await api.get(url);
      expect(bare.status(), `${what} (bare array)`).toBe(200);
      expect((await bare.json()).find(e => e.id === planted).details).toEqual(MARK);
    }
  });

  test("a challenge's version history reads a record's details through the same parser", async () => {
    const { makeTask } = require("./event-admin-helpers");
    const task = await makeTask(W.sa, W.saCsrf, "unreadtask");
    const db = openDb(false);
    let planted;
    try {
      const n = db.prepare("SELECT COALESCE(MAX(version_num), 0) + 1 AS n FROM task_versions WHERE task_id=?").get(task.id).n;
      planted = `v-${T}`;
      db.prepare("INSERT INTO task_versions (id, task_id, version_num, changed_by, changed_at, snapshot, change_type, details) VALUES (?,?,?,?,?,?,?,?)")
        .run(planted, task.id, n, "superadmin", new Date().toISOString(), "{}", "sealed_reveal", `{"via":"participant_view","acting_as_id":${RAW}-version`);
    } finally { db.close(); }
    const r = await W.sa.get(`/api/admin/tasks/${task.id}/versions`);
    expect(r.status(), await r.text()).toBe(200);
    const versions = await r.json();
    expect(versions.find(v => v.id === planted)?.details, "the record, marked").toEqual(MARK);
    const ordinary = versions.filter(v => v.id !== planted);
    expect(ordinary.length, "CONTROL: the challenge's own versions are listed beside it").toBeGreaterThan(0);
    for (const v of ordinary) expect(v.details, `version ${v.version_num}: no details recorded`).toBeNull();
    expect(JSON.stringify(versions)).not.toContain(RAW);
  });

  test("the Audit page: people rows marked for a global reader and withheld from a scoped one; event and logged rows marked for both", async () => {
    const get = async (api, qs) => {
      const r = await api.get(`/api/admin/audit?${qs}&limit=500`);
      expect(r.status(), `${qs}: ${await r.text()}`).toBe(200);
      const b = await r.json();
      expect(JSON.stringify(b), `${qs}: no stored text`).not.toContain(RAW);
      return b;
    };
    const person = await get(W.sa, `types=person&subjectId=${W.p.id}`);
    for (const k of ["uLogin", "uRevoked", "uEmail", "uArrival"]) {
      const row = person.rows.find(x => x.id === `person:${W[k].rid}`);
      expect(row, `the global reader's ${k}`).toBeTruthy();
      expect(row.details, `${k}: marked`).toEqual(MARK);
    }
    expect(person.rows.find(x => x.id === `person:${W.uOk.rid}`).details, "CONTROL").toEqual({ tag: `ok-${T}` });
    expect(person.total).toBe(person.rows.length);
    const scoped = await get(W.eaApi, `types=person&subjectId=${W.p.id}&n=2`);
    for (const k of ["uLogin", "uRevoked", "uEmail", "uArrival"]) {
      expect(scoped.rows.map(x => x.id), `the scoped reader is not given ${k}`).not.toContain(`person:${W[k].rid}`);
    }
    expect(scoped.rows.map(x => x.id), "CONTROL: a row naming no event reaches them").toContain(`person:${W.uOk.rid}`);
    expect(scoped.total).toBe(scoped.rows.length);
    for (const [who, api] of [["global", W.sa], ["scoped", W.eaApi]]) {
      const ev = await get(api, `types=event&competitionId=${W.A.id}&n=${who}`);
      expect(ev.rows.find(x => x.id === `event:${W.cMinted.rid}`)?.details, `${who}: the event row`).toEqual(MARK);
      const lg = await get(api, `types=log_event&competitionId=${W.A.id}&n=${who}`);
      expect(lg.rows.find(x => x.id === `log_event:${W.oExport.rid}`)?.details, `${who}: the logged row`).toEqual(MARK);
    }
  });

  test("the Audit page: a row whose details cannot be read has outcome unknown, never success; the Outcome filter lists each kind apart", async () => {
    const get = async (api, qs, status = 200) => {
      const r = await api.get(`/api/admin/audit?${qs}&limit=500`);
      expect(r.status(), `${qs}: ${await r.text()}`).toBe(status);
      const b = await r.json();
      expect(JSON.stringify(b), `${qs}: no stored text`).not.toContain(RAW);
      return b;
    };
    const outcomeOf = (b, id) => b.rows.find(x => x.id === id)?.outcome;
    const UNREADABLE = ["uLogin", "uRevoked", "uEmail", "uArrival"];
    // Every source that reads its details for the outcome, by value.
    const person = await get(W.sa, `types=person&subjectId=${W.p.id}&n=outcome`);
    for (const k of UNREADABLE) expect(outcomeOf(person, `person:${W[k].rid}`), `person ${k}`).toBe("unknown");
    // CONTROLS on the same page: readable details, and none at all.
    for (const k of ["uOk", "uNull", "uEmpty"]) expect(outcomeOf(person, `person:${W[k].rid}`), `CONTROL person ${k}`).toBe("success");
    const ev = await get(W.sa, `types=event&competitionId=${W.A.id}&n=outcome`);
    expect(outcomeOf(ev, `event:${W.cMinted.rid}`), "the event row").toBe("unknown");
    const ses = await get(W.sa, `types=session&timeslotId=${W.S}&n=outcome`);
    expect(outcomeOf(ses, `session:${W.sSession.rid}`), "the session row").toBe("unknown");
    const set = await get(W.sa, `types=setting&subjectId=f2_probe_${T}&n=outcome`);
    expect(outcomeOf(set, `setting:${W.gSetting.rid}`), "the settings row").toBe("unknown");
    const lg = await get(W.sa, `types=log_event&competitionId=${W.A.id}&n=outcome`);
    expect(outcomeOf(lg, `log_event:${W.oExport.rid}`), "the logged row").toBe("unknown");
    expect(outcomeOf(lg, `log_event:${W.oBlank.rid}`), "details of only whitespace are unreadable").toBe("unknown");
    expect(lg.rows.find(x => x.id === `log_event:${W.oBlank.rid}`).details, "…and marked so").toEqual(MARK);
    expect(outcomeOf(lg, `log_event:${W.oRefused.rid}`), "a type that says it failed stays a failure").toBe("failure");
    expect(outcomeOf(lg, `log_event:${W.oFailOk.rid}`), "CONTROL: readable ok:false is a failure").toBe("failure");

    // The filter, each way; `total` follows it.
    const unk = await get(W.sa, `types=person&subjectId=${W.p.id}&outcome=unknown`);
    expect(unk.rows.map(x => x.id).sort(), "exactly the unreadable person rows").toEqual(UNREADABLE.map(k => `person:${W[k].rid}`).sort());
    expect(unk.total).toBe(4);
    const suc = (await get(W.sa, `types=person&subjectId=${W.p.id}&outcome=success`)).rows.map(x => x.id);
    for (const k of ["uOk", "uNull", "uEmpty"]) expect(suc, `success lists ${k}`).toContain(`person:${W[k].rid}`);
    for (const k of UNREADABLE) expect(suc, `success never lists ${k}`).not.toContain(`person:${W[k].rid}`);
    const both = (await get(W.sa, `types=person&subjectId=${W.p.id}&outcome=success,unknown`)).rows.map(x => x.id);
    expect(both).toContain(`person:${W.uOk.rid}`);
    expect(both).toContain(`person:${W.uEmail.rid}`);
    const fail = (await get(W.sa, `types=log_event&competitionId=${W.A.id}&outcome=failure`)).rows.map(x => x.id);
    expect(fail).toContain(`log_event:${W.oRefused.rid}`);
    expect(fail).toContain(`log_event:${W.oFailOk.rid}`);
    expect(fail).not.toContain(`log_event:${W.oExport.rid}`);
    expect(fail).not.toContain(`log_event:${W.oBlank.rid}`);
    const lgUnk = (await get(W.sa, `types=log_event&competitionId=${W.A.id}&outcome=unknown`)).rows.map(x => x.id);
    expect(lgUnk).toContain(`log_event:${W.oExport.rid}`);
    expect(lgUnk).toContain(`log_event:${W.oBlank.rid}`);
    expect(lgUnk).not.toContain(`log_event:${W.oRefused.rid}`);
    expect(lgUnk).not.toContain(`log_event:${W.oFailOk.rid}`);
    const bad = await W.sa.get(`/api/admin/audit?outcome=meh`);
    expect(bad.status()).toBe(400);
    const badBody = await bad.json();
    expect(badBody.code).toBe("audit_outcome_unknown");
    expect(badBody.error).toContain("success, failure, unknown, correct, wrong");

    // A reader scoped to their events: the event row's outcome is computed for
    // them too; their unreadable person rows stay withheld.
    const sEv = (await get(W.eaApi, `types=event&competitionId=${W.A.id}&outcome=unknown&n=scoped`)).rows.map(x => x.id);
    expect(sEv, "scoped: the event row is unknown").toContain(`event:${W.cMinted.rid}`);
    const sPer = await get(W.eaApi, `types=person&subjectId=${W.p.id}&outcome=unknown&n=scoped`);
    expect(sPer.rows, "scoped: unreadable person rows stay withheld").toEqual([]);
  });

  test("the person export: the rows marked for a global reader, withheld from a scoped one, never their text", async () => {
    const find = (events, k) => events.find(e => e.changed_at === W[k].at && e.event_type === W[k].type);
    const saRows = rowsAtAnchor("user_events", "user_id", W.p.id, "9999", Number.MAX_SAFE_INTEGER);
    for (const k of ["uLogin", "uRevoked", "uEmail", "uArrival"]) {
      const s = saRows.find(x => x.id === W[k].id);
      W[k].at = s.changed_at; W[k].type = s.event_type;
    }
    const sa = await W.sa.get(`/api/admin/participants/${W.p.id}/export/full`);
    expect(sa.status(), await sa.text()).toBe(200);
    const saBody = await sa.json();
    for (const k of ["uLogin", "uRevoked", "uEmail", "uArrival"]) expect(find(saBody.events, k)?.details, `global: ${k}`).toEqual(MARK);
    expect(JSON.stringify(saBody)).not.toContain(RAW);
    const ea = await W.eaApi.get(`/api/admin/participants/${W.p.id}/export/full`);
    expect(ea.status(), await ea.text()).toBe(200);
    const eaBody = await ea.json();
    for (const k of ["uLogin", "uRevoked", "uEmail", "uArrival"]) expect(find(eaBody.events, k), `scoped: ${k} withheld`).toBeUndefined();
    expect(eaBody.events.some(e => e.event_type === "tag_added" && e.details && e.details.tag === `ok-${T}`), "CONTROL: the readable row").toBe(true);
    expect(JSON.stringify(eaBody)).not.toContain(RAW);
    // The ZIP's history.csv carries the mark, never the text.
    const z = await W.sa.get(`/api/admin/participants/${W.p.id}/export/full?format=zip-csv`);
    expect(z.status()).toBe(200);
    const files = await unzip(await z.body());
    expect(files["history.csv"].split('{""details_unreadable"":true}').length - 1, "four marked rows in history.csv").toBe(4);
    expect(Object.values(files).join("\n")).not.toContain(RAW);
  });

  test("a row with no details at all (NULL or the empty text) reads as null and names no event: a global and a scoped reader both get it", async () => {
    const EMPTY = ["uNull", "uEmpty"];
    const UNREADABLE = ["uLogin", "uRevoked", "uEmail", "uArrival"];
    const db = openDb(true);
    let stored;
    try {
      stored = Object.fromEntries(db.prepare("SELECT id, typeof(details) AS t, length(details) AS n FROM user_events WHERE id IN (?,?)")
        .all(W.uNull.id, W.uEmpty.id).map(r => [r.id, `${r.t}:${r.n}`]));
    } finally { db.close(); }
    expect(stored, "PRECONDITION: one row stores NULL, the other the empty text").toEqual({ [W.uNull.id]: "null:null", [W.uEmpty.id]: "text:0" });
    const read = async (api, url, what) => {
      const r = await api.get(url);
      expect(r.status(), `${what}: ${await r.text()}`).toBe(200);
      return r.json();
    };
    for (const [who, api] of [["global", W.sa], ["scoped", W.eaApi]]) {
      // History.
      const hist = (await read(api, `/api/admin/participants/${W.p.id}/events?offset=0&limit=500`, `${who} History`)).events;
      for (const k of EMPTY) {
        const ev = hist.find(e => e.id === W[k].id);
        expect(ev, `${who} History lists ${k}`).toBeTruthy();
        expect(ev.details, `${who} History: ${k} has no details, not unreadable ones`).toBeNull();
      }
      // The Audit page's people rows.
      const audit = (await read(api, `/api/admin/audit?types=person&subjectId=${W.p.id}&limit=500&n=empty-${who}`, `${who} Audit page`)).rows;
      for (const k of EMPTY) {
        const row = audit.find(x => x.id === `person:${W[k].rid}`);
        expect(row, `${who} Audit page lists ${k}`).toBeTruthy();
        expect(row.details, `${who} Audit page: ${k} has no details`).toBeNull();
      }
      // The person export (its rows carry no id: found by type and time).
      const exp = (await read(api, `/api/admin/participants/${W.p.id}/export/full`, `${who} person export`)).events;
      const inExport = (k) => exp.find(e => e.event_type === W[k].type && e.changed_at === W[k].at);
      for (const k of EMPTY) {
        expect(inExport(k), `${who} person export carries ${k}`).toBeTruthy();
        expect(inExport(k).details, `${who} person export: ${k} has no details`).toBeNull();
      }
      // CONTROLS from the same reads: the rows whose text is not JSON are marked
      // for the global reader and withheld from the scoped one, so null above is
      // the reading of no details, not of every row.
      for (const k of UNREADABLE) {
        const h = hist.find(e => e.id === W[k].id), a = audit.find(x => x.id === `person:${W[k].rid}`), x = inExport(k);
        if (who === "global") {
          expect([h?.details, a?.details, x?.details], `global: ${k} marked in History, the Audit page and the export`).toEqual([MARK, MARK, MARK]);
        } else {
          expect([h, a, x], `scoped: ${k} withheld from History, the Audit page and the export`).toEqual([undefined, undefined, undefined]);
        }
      }
    }
    // The scoped reader IS scoped: the decoy event's enrolment never reaches them.
    const scopedIds = (await read(W.eaApi, `/api/admin/participants/${W.p.id}/events?offset=0&limit=500`, "scoped History")).events.map(e => e.id);
    expect(scopedIds, "CONTROL: the scoped reader's History withholds the decoy event's enrolment").not.toContain(W.addB.id);
  });

  test("the delivery panel and the event team report answer 200 beside such a row", async () => {
    // The panel counts members with a failed send; the unreadable mail is no
    // failure it can name. Polled against the stored rows (the fixture's own
    // enrolment mails land after their sends fail).
    const failedFromRows = () => {
      const db = openDb(true);
      try {
        const rows = db.prepare(`SELECT ue.user_id, ue.details FROM user_events ue JOIN competition_users cu ON cu.user_id = ue.user_id
          WHERE cu.competition_id = ? AND ue.event_type = 'email_sent'`).all(W.A.id);
        const who = new Set();
        for (const r of rows) { try { if (JSON.parse(r.details).success === false) who.add(r.user_id); } catch (_) { /* not JSON: no named failure */ } }
        return who.size;
      } finally { db.close(); }
    };
    await expect.poll(async () => {
      const r = await W.sa.get(`/api/admin/competitions/${W.A.id}/delivery`);
      if (r.status() !== 200) return `status ${r.status()}: ${await r.text()}`;
      const b = await r.json();
      return b.email_failed === failedFromRows() ? "match" : `email_failed ${b.email_failed} vs ${failedFromRows()} in the rows`;
    }, { timeout: 15000 }).toBe("match");
    const rep = await W.sa.get(`/api/admin/competitions/${W.A.id}/team-report`);
    expect(rep.status(), await rep.text()).toBe(200);
    const lead = (await rep.json()).leads?.find(x => x.user_id === W.p.id) || null;
    expect(lead, "the participant is one of the event's leads").toBeTruthy();
    expect(lead.source, "how they arrived, from the readable enrolment").toBe("Added by superadmin");
  });
});

test.describe("History and the Audit page say so in words", () => {
  test("the renderer: a marked row says its details could not be read; without the mark the type's sentence stands", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.formatEventChange === "function", null, { timeout: 20000 });
    const r = await page.evaluate((m) => {
      const f = (event_type, details) => window.formatEventChange({ event_type, details });
      return {
        email: f("email_sent", m), cxone: f("cxone_provisioned", m), login: f("login_success", m), unknown: f("zz_new_type", m),
        emailOk: f("email_sent", { success: true, reason: "approval" }), cxoneOk: f("cxone_provisioned", { success: true }),
      };
    }, MARK);
    const text = (h) => h.replace(/<[^>]+>/g, "").trim();
    for (const k of ["email", "cxone", "login", "unknown"]) expect(text(r[k]), k).toBe(SENTENCE);
    expect(text(r.emailOk), "CONTROL: a readable mail").toContain("sent");
    expect(text(r.emailOk)).not.toContain(SENTENCE);
    expect(text(r.cxoneOk), "CONTROL: a readable set-up").toContain("provisioned");
  });

  test("a challenge's reveal record whose details cannot be read says so, never which answer was revealed or to whom", async ({ page }) => {
    // The version history gets such a record marked (the version-history test
    // above); its renderer is _fmtRevealRow, not formatEventChange.
    await page.goto("/");
    await page.waitForFunction(() => typeof window._fmtRevealRow === "function", null, { timeout: 20000 });
    const r = await page.evaluate((m) => {
      const f = (details) => window._fmtRevealRow({ change_type: "sealed_reveal", details });
      return { marked: f(m), readable: f({ fields: ["correct_answer"], via: "participant_view" }), none: f(null) };
    }, MARK);
    const text = (h) => h.replace(/<[^>]+>/g, "").trim();
    expect(text(r.marked), "a marked record says only that its details could not be read").toBe(SENTENCE);
    expect(text(r.marked)).not.toContain("revealed to a superadmin");
    // CONTROL: a readable record keeps its sentence, its fields and its view.
    expect(text(r.readable)).toContain("Sealed answer revealed to a superadmin");
    expect(text(r.readable)).toContain("in the participant view");
    expect(text(r.readable)).not.toContain(SENTENCE);
    // CONTROL: a record with no details keeps the type's own sentence (only the mark is unreadable).
    expect(text(r.none)).toContain("revealed to a superadmin");
    expect(text(r.none)).not.toContain(SENTENCE);
  });

  test("the participant's History dialog lists each unreadable row with its type, its other rows as they read", async ({ page }) => {
    test.setTimeout(120_000);
    const { adminLogin } = require("./ui-admin-helpers");
    await adminLogin(page);
    await page.waitForFunction(() => typeof window.showUserHistory === "function");
    await page.evaluate((id) => { window.showUserHistory(id); }, W.p.id);
    const ov = page.locator("#hist-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    const marked = ov.locator("#hist-body tr", { has: page.locator(".history-change-cell", { hasText: SENTENCE }) });
    await expect(marked).toHaveCount(4, { timeout: 15000 });
    expect((await marked.locator(".history-type-badge").allTextContents()).map(t => t.trim()).sort(), "each keeps its type")
      .toEqual(["added_to_competition", "badge_revoked", "email_sent", "login_success"]);
    // CONTROL: the readable rows read as before, beside them, and a row with no
    // details (the empty text) reads as its type, never as unreadable.
    await expect(ov.locator("#hist-body tr", { hasText: `+ tag: ok-${T}` })).toHaveCount(1);
    await expect(ov.locator("#hist-body tr", { hasText: "User unblocked" })).toHaveCount(1);
    await expect(ov.locator("#hist-body .history-change-cell", { hasText: W.A.name }).first()).toBeVisible();
    expect(await ov.textContent()).not.toContain(RAW);
  });

  test("the Audit page's details dialog says the details could not be read, never that none were recorded; its Outcome reads Unknown", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const { adminLogin } = require("./ui-admin-helpers");
    await adminLogin(page);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    await page.evaluate(() => window.adminTab(document.querySelector('.admin-nav-item[data-tab-id="admin-audit-tab"]'), "admin-audit-tab"));
    await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 15000 });
    const dlg = page.locator("#audit-detail-overlay [role=dialog]");
    const outcomeDd = dlg.locator("dt", { hasText: /^Outcome$/ }).locator("xpath=following-sibling::dd[1]");
    for (const [actor, want, outcome] of [[W.actor, `${SENTENCE}.`, "Unknown"], [W.okActor, `"tag": "ok-${T}"`, "Success"], [W.emptyActor, "No further details were recorded.", "Success"]]) {
      await page.locator("#audit-actor").fill(actor);
      await page.locator("#audit-actor").dispatchEvent("change");
      const row = page.locator("#admin-audit-body tr", { hasText: actor });
      await expect(row).toHaveCount(1, { timeout: 15000 });
      // The Outcome cell: Unknown for the unreadable row, in ordinary text (it is
      // not a failure); CONTROLS: readable details and no details read Success.
      await expect(row.locator(".audit-outcome"), `${actor}: outcome`).toHaveText(outcome);
      await expect(row.locator(".audit-outcome"), `${actor}: not drawn as a failure`).not.toHaveClass(/audit-outcome-bad/);
      await row.locator('[data-action="audit-row-details"]').click();
      await expect(outcomeDd, `${actor}: the dialog's Outcome`).toHaveText(outcome);
      if (actor === W.actor) {
        await expect(dlg.locator("pre.audit-detail-json")).toHaveText(want);
        await expect(dlg.locator("dt", { hasText: /^Activity key$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("email_sent");
      } else if (actor === W.emptyActor) {
        // CONTROL: a row stored with the empty text has no details, and says so.
        await expect(dlg.locator("pre.audit-detail-json"), "CONTROL: no details are not unreadable ones").toHaveText(want);
        await expect(dlg.locator("dt", { hasText: /^Activity key$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("unblocked");
      } else {
        await expect(dlg.locator("pre.audit-detail-json"), "CONTROL: readable details are shown as recorded").toContainText(want);
      }
      expect(await dlg.textContent()).not.toContain(RAW);
      await page.keyboard.press("Escape");
      await expect(page.locator("#audit-detail-overlay")).toHaveCount(0);
    }

    // The Outcome filter offers Unknown, after Failure.
    const sel = page.locator("#audit-outcome");
    expect(await sel.locator("option").evaluateAll(os => os.map(o => [o.value, o.textContent.trim()])))
      .toEqual([["", "Any"], ["success", "Success"], ["failure", "Failure"], ["unknown", "Unknown"], ["correct", "Correct"], ["wrong", "Wrong"]]);
    // Every transition changes what is drawn, and each count is read once the
    // read asking for that outcome has answered.
    const pick = async (value) => {
      const resp = page.waitForResponse(r => r.url().includes("/api/admin/audit?") && (new URL(r.url()).searchParams.get("outcome") || "") === value);
      await sel.selectOption(value);
      expect((await resp).status()).toBe(200);
    };
    const setActor = async (actor) => {
      const resp = page.waitForResponse(r => r.url().includes("/api/admin/audit?") && new URL(r.url()).searchParams.get("actor") === actor);
      await page.locator("#audit-actor").fill(actor);
      await page.locator("#audit-actor").dispatchEvent("change");
      expect((await resp).status()).toBe(200);
    };
    const unreadRow = page.locator("#admin-audit-body tr", { hasText: W.actor });
    await setActor(W.actor);
    await expect(unreadRow).toHaveCount(1);
    await pick("success");
    await expect(unreadRow, "Success leaves the unreadable row out").toHaveCount(0);
    await pick("unknown");
    await expect(unreadRow, "Unknown lists it").toHaveCount(1);
    await expect(unreadRow.locator(".audit-outcome")).toHaveText("Unknown");
    // CONTROL: the readable row, the other way round.
    const okRow = page.locator("#admin-audit-body tr", { hasText: W.okActor });
    await pick("");
    await setActor(W.okActor);
    await expect(okRow).toHaveCount(1);
    await pick("unknown");
    await expect(okRow, "Unknown leaves the readable row out").toHaveCount(0);
    await pick("success");
    await expect(okRow, "Success lists it").toHaveCount(1);

    // The CSV's Outcome column says Unknown too.
    await pick("");
    await setActor(W.actor);
    await expect(unreadRow).toHaveCount(1);
    const dl = page.waitForEvent("download");
    await page.locator("#audit-export").click();
    const csv = require("fs").readFileSync(await (await dl).path(), "utf8");
    const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replace(/""/g, '"'));
    const head = cells(csv.split("\n")[0]);
    const line = csv.split("\n").find(l => l.includes(`"${W.actor}"`));
    expect(line, "the unreadable row is in the CSV").toBeTruthy();
    expect(cells(line)[head.indexOf("Outcome")], "its Outcome column").toBe("Unknown");
    expect(csv).not.toContain(RAW);
  });
});

/** Every entry of a ZIP buffer as { name: text }. */
function unzip(buf) {
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on("entry", (e) => {
        zip.openReadStream(e, (e2, s) => {
          if (e2) return reject(e2);
          const parts = [];
          s.on("data", (d) => parts.push(d));
          s.on("end", () => { out[e.fileName] = Buffer.concat(parts).toString("utf8"); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
