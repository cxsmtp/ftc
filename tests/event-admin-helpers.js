// @ts-check
//
// Shared fixtures for the event-admin spec files (v8.7.0).
//
// ONE fixture builder, in one place, for the same reason `ui-admin-helpers.js`
// exists: six spec files each hand-rolling "make an event admin, give them one
// event, make a decoy event they cannot see" would be six subtly different
// fixtures, and the first divergence is invisible — a decoy that is accidentally
// in scope makes every negative assertion in that file pass vacuously.
//
// Imports `expect` from @playwright/test, NEVER `./isolated-test`: that module
// registers the per-file recycle hook AT IMPORT TIME, so a helper requiring it
// would risk the one mechanism that gives every spec file a fresh database
// (v7.21.35).
const { expect, request } = require("@playwright/test");
const { BASE, PARTICIPANT_PASS, apiLogin, registerPost } = require("./helpers");

const H = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** A monotonic-ish suffix. `Date.now()` alone collides inside one tick. */
let _n = 0;
function uniq(label) { return `${label}-${Date.now()}-${process.pid % 10000}-${++_n}`; }

/**
 * A fresh participant: registered, verified and approved.
 *
 * Every event-admin spec MUST mint its own participants rather than promoting a
 * seeded one — `tests/isolated-test.js` asserts in an `afterAll` that alice, bob
 * and carol still hold `role: 'participant'`, and a promotion left behind would
 * fail the whole FILE and name it.
 */
async function makeParticipant(sa, saCsrf, label) {
  const tag = uniq(label);
  const email = `ea-${tag}@acme.com`;
  const anon = await request.newContext({ baseURL: BASE });
  try {
    const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", {
      headers: H(csrf),
      data: {
        email, password: PARTICIPANT_PASS,
        nickname: `ea_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
        firstName: "Event", lastName: String(label), company: "Acme", title: "Engineer",
        country: "GB", timezone: "Europe/London",
      },
    });
    expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  } finally { await anon.dispose(); }

  const list = await sa.get("/api/admin/participants?limit=5000");
  const row = (await list.json()).participants.find(p => p.email === email);
  expect(row, `registered ${label} must be findable in the admin list`).toBeTruthy();
  const v = await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(saCsrf) });
  expect(v.ok(), `verify ${label}: ${v.status()}`).toBeTruthy();
  const a = await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: H(saCsrf) });
  expect(a.ok(), `approve ${label}: ${a.status()}`).toBeTruthy();
  return { id: row.id, email, nickname: row.nickname };
}

/**
 * v8.7.3 — an account created through an ADMIN INVITATION at a FREE-EMAIL
 * address, i.e. one whose profile is INCOMPLETE and can never complete itself.
 *
 * Not a contrivance: this is the documented production route to an incomplete
 * admin. The corporate-email rule has three recorded exceptions and
 * `invitationId` is the deliberate one — it blesses a specific admin-validated
 * address — while `_profileMissingFields` still demands `corporate_email` of
 * every account. The completion gate is admin-exempt at both of its proactive
 * sites, so nothing ever asks them to fix it.
 *
 * Returned verified + approved, so the only thing wrong is the profile.
 */
async function makeInvitedFreeEmailUser(sa, saCsrf, label) {
  const tag = uniq(label);
  const email = `ea-inv-${tag}@gmail.com`;
  const inv = await sa.post("/api/admin/invitations", {
    headers: H(saCsrf), data: { emails: [email], competitionIds: [] },
  });
  expect(inv.ok(), `invite ${label}: ${inv.status()} ${await inv.text()}`).toBeTruthy();

  // No admin endpoint exposes invitation ids (the normal UX is the emailed
  // link), so read it out of THIS worker's database, read-only.
  const Database = require("better-sqlite3");
  const db = new Database(require("./helpers").TEST_DB_PATH, { readonly: true });
  const row = db.prepare("SELECT id FROM invitations WHERE email=?").get(email);
  db.close();
  expect(row && row.id, `invitation row for ${email} must exist`).toBeTruthy();

  const anon = await request.newContext({ baseURL: BASE });
  try {
    const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", {
      headers: H(csrf),
      data: {
        email, password: PARTICIPANT_PASS, invitationId: row.id,
        nickname: `eainv_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
        firstName: "Invited", lastName: String(label), company: "Acme", title: "Engineer",
        country: "GB", timezone: "Europe/London",
      },
    });
    expect(reg.ok(), `register invited ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  } finally { await anon.dispose(); }

  const list = await sa.get("/api/admin/participants?limit=5000");
  const p = (await list.json()).participants.find(x => x.email === email);
  expect(p, `invited ${label} must be findable in the admin list`).toBeTruthy();
  const v = await sa.post(`/api/admin/participants/${p.id}/verify`, { headers: H(saCsrf) });
  expect(v.ok(), `verify invited ${label}: ${v.status()}`).toBeTruthy();
  const a = await sa.post(`/api/admin/participants/${p.id}/approve`, { headers: H(saCsrf) });
  expect(a.ok(), `approve invited ${label}: ${a.status()}`).toBeTruthy();
  return { id: p.id, email };
}

/** A live tournament, 10 hours long, started a minute ago. */
async function makeCompetition(sa, saCsrf, label, extra = {}) {
  const name = `EA ${uniq(label)}`;
  const r = await sa.post("/api/admin/competitions", {
    headers: H(saCsrf),
    data: {
      name,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      duration_minutes: 600,
      event_kind: "tournament",
      ...extra,
    },
  });
  expect(r.ok(), `create competition ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  const id = d.competition?.id || d.id;
  expect(id, "create must return a competition id").toBeTruthy();
  return { id, name };
}

/** A published challenge. `createdBy` is whichever client makes it. */
async function makeTask(api, csrf, label, extra = {}) {
  const title = `EA Task ${uniq(label)}`;
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: {
      title, description: "d", difficulty: "easy", answer_type: "text",
      correct_answer: "a", status: "published", ...extra,
    },
  });
  expect(r.ok(), `create task ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  const id = d.id || d.task?.id;
  expect(id, "create task must return an id").toBeTruthy();
  return { id, title };
}

/**
 * Assign a challenge to competitions, asserting the assignment REALLY HAPPENED.
 *
 * `r.ok()` is not that assertion. The route counts only the rows its
 * `INSERT OR IGNORE` actually inserted, so an already-assigned pair answers
 * `{ok:true, assigned:0}` — measured. A fixture built on a 200 that assigned
 * nothing then reports the wrong thing about the product: the challenge is
 * simply absent from the event, and the test that depends on it fails somewhere
 * else, or worse passes for the wrong reason (`taskUnassignDenied` answers
 * `event_admin_not_assigner` for a MISSING row as well as for somebody else's).
 */
async function assignTask(api, csrf, taskId, competitionIds) {
  const r = await api.post(`/api/admin/tasks/${taskId}/competitions`, {
    headers: H(csrf), data: { competitionIds },
  });
  expect(r.ok(), `assign task: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.assigned, `assign attached ${d.assigned} of ${competitionIds.length} competitions`)
    .toBe(competitionIds.length);
  return d;
}

/** Enrol participants, asserting the COUNT — the assign endpoint SKIPS silently. */
async function enrol(sa, saCsrf, competitionId, userIds) {
  const r = await sa.post("/api/admin/competitions/assign", {
    headers: H(saCsrf), data: { userIds, competitionIds: [competitionId] },
  });
  expect(r.ok(), `enrol: ${r.status()} ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.assigned, `enrol attached ${d.assigned} of ${userIds.length}`).toBe(userIds.length);
}

/** Make `userId` an organiser of `competitionId`. */
async function grantEventAdmin(sa, saCsrf, competitionId, userId) {
  const r = await sa.post(`/api/admin/competitions/${competitionId}/admins`, {
    headers: H(saCsrf), data: { userId },
  });
  expect(r.ok(), `grant event admin: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

/**
 * THE STANDARD WORLD every event-admin spec builds on.
 *
 *   mine    — a competition the event admin organises
 *   theirs  — a DECOY they do not, holding its own participant and challenge
 *   ea      — the event admin (organises `mine` only)
 *   zero    — an event admin with NO grants: the empty-scope fail-open catcher
 *   inMine  — a participant enrolled in `mine`
 *   inTheirs— a participant enrolled ONLY in `theirs`
 *
 * The decoy is not decoration. With one competition, a build that dropped the
 * scope filter entirely returns exactly the same rows as a correct one, so every
 * negative assertion would pass against a broken build.
 */
async function buildWorld() {
  const s = await apiLogin("superadmin");
  const sa = s.api, saCsrf = s.csrf;

  const mine = await makeCompetition(sa, saCsrf, "mine");
  const theirs = await makeCompetition(sa, saCsrf, "theirs");

  const ea = await makeParticipant(sa, saCsrf, "ea");
  const zero = await makeParticipant(sa, saCsrf, "zero");
  const inMine = await makeParticipant(sa, saCsrf, "inmine");
  const inTheirs = await makeParticipant(sa, saCsrf, "intheirs");

  await enrol(sa, saCsrf, mine.id, [inMine.id]);
  await enrol(sa, saCsrf, theirs.id, [inTheirs.id]);

  await grantEventAdmin(sa, saCsrf, mine.id, ea.id);
  const roleRes = await sa.post(`/api/admin/participants/${zero.id}/role`, {
    headers: H(saCsrf), data: { role: "event_admin" },
  });
  expect(roleRes.ok(), `zero-grant role: ${roleRes.status()} ${await roleRes.text()}`).toBeTruthy();

  const l1 = await apiLogin(ea.email, PARTICIPANT_PASS);
  const l2 = await apiLogin(zero.email, PARTICIPANT_PASS);

  // Preconditions asserted, not assumed: a test whose setup silently failed
  // reports the wrong thing (the fixture checklist's own rule).
  const meEa = await (await l1.api.get("/api/admin/me")).json();
  expect(meEa.isEventAdmin, "the event admin really holds the tier").toBe(true);
  expect(meEa.eventAdminCompetitionCount, "…and exactly one event").toBe(1);
  const meZero = await (await l2.api.get("/api/admin/me")).json();
  expect(meZero.isEventAdmin, "the zero-grant actor really holds the tier").toBe(true);
  expect(meZero.eventAdminCompetitionCount, "…and no events").toBe(0);

  return {
    sa, saCsrf,
    mine, theirs,
    ea, zero, inMine, inTheirs,
    eaApi: l1.api, eaCsrf: l1.csrf,
    zeroApi: l2.api, zeroCsrf: l2.csrf,
  };
}

/** Assert a response is the event-admin refusal, with a reason worth reading. */
async function expectRefused(res, what, code = null) {
  expect(res.status(), `${what} must be refused`).toBe(403);
  const b = await res.json().catch(() => ({}));
  if (code) expect(b.code, `${what} carries the machine code`).toBe(code);
  expect(String(b.error || "").length, `${what} states a reason`).toBeGreaterThan(20);
  return b;
}

// A question added to an event lives in that event (lib/event-copies.js): the
// event holds its OWN copy of a bank question. Read from the server's database.
function _ro(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(require("./helpers").TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
/** Event `compId`'s own copy of bank question `bankId` (the one it holds), or null. */
function eventCopyOf(bankId, compId) {
  return _ro(db => {
    const r = db.prepare("SELECT t.id FROM tasks t JOIN competition_tasks ct ON ct.task_id=t.id AND ct.competition_id=t.owner_competition_id WHERE t.owner_competition_id=? AND t.copied_from_task_id=?").get(compId, bankId);
    return r ? r.id : null;
  });
}
/**
 * Run `fn` with the assign doors in the PREVIOUS release's mode (test hook
 * `POST /api/test/legacy-shared-assign`): the bank question itself goes into the
 * event, shared by every event it is added to. For a lock about the shape a
 * database from before event-owned questions holds (and a qualifying question
 * still has); always switched back off.
 */
async function withLegacySharedAssign(sa, saCsrf, fn) {
  const set = async (on) => {
    const r = await sa.post("/api/test/legacy-shared-assign", { headers: H(saCsrf), data: { on } });
    expect((await r.json()).on, "the legacy switch took").toBe(on);
  };
  await set(true);
  try { return await fn(); } finally { await set(false); }
}
/** The bank question `taskId` was copied from, or itself (a bank question, or one created in its event). */
function originOf(taskId) {
  return _ro(db => { const r = db.prepare("SELECT COALESCE(copied_from_task_id, id) AS o FROM tasks WHERE id=?").get(taskId); return r ? r.o : taskId; });
}
/** The bank questions event `compId`'s questions were copied from, sorted (its own id where none). */
function originsHeldBy(compId) {
  return _ro(db => db.prepare("SELECT COALESCE(t.copied_from_task_id, t.id) AS o FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=?").all(compId).map(r => r.o).sort());
}

module.exports = {
  H, uniq,
  makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin,
  eventCopyOf, originsHeldBy, originOf, withLegacySharedAssign,
  makeInvitedFreeEmailUser,
  buildWorld, expectRefused,
};
