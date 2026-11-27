"use strict";
//
// v8.12.0 — THE SEAL INVARIANT AT EVERY DOOR: assignment, the switch, the unseal.
//
// An event whose "Staff can compete" switch is on admits only SEALED challenges
// (lib/answer-seal.js) — a competing admin can read an unsealed key off the admin
// Challenges pane — and never one whose AUTHOR holds a row on it, because the
// seal admits its author by definition. That rule is a theorem only if it holds
// from every door that writes a `competition_tasks` row, plus the one that could
// take the seal away afterwards. This file drives them all:
//
//   POST   /api/admin/tasks/:id/competitions          all-or-nothing, 400 + refused[]
//   PUT    /api/admin/tasks/:id/competitions          desired state — ADDITIONS only
//   DELETE /api/admin/tasks/:id/competitions/:cid     removal is always allowed
//   POST   /api/admin/tasks/assign-competitions       best-effort — skipped + refused[]
//   PUT    /api/admin/tasks/:id {answer_sealed:false} 409 while ANY compete event
//                                                     holds it, at any status
//   POST   /api/admin/competitions/assign             the author rule from the OTHER
//                                                     side (skippedAuthors)
//   PUT    /api/admin/competitions/:id {staff_compete:true}
//                                                     the SWITCH door: 400 while an
//                                                     UNSEALED challenge is held, then
//                                                     400 while an ENROLLED person
//                                                     wrote a held challenge
//                                                     (`staff_compete_enrolled_authors`)
//
// EVERY REFUSAL CARRIES A CONTROL IN THE SAME TEST — the identical request against
// a switch-OFF event, or with the SEALED twin — because "the compete event refused
// it" is equally satisfied by a build that refuses every assignment everywhere,
// and "nothing was assigned" by a build whose assign routes stopped working.
// Refusals are asserted BY VALUE against the admin list (`GET /api/admin/tasks`
// → `competitions[]`), never inferred from the status code: a 400 is not a
// rollback (the v8.7.0 rule).
//
// THE REFUSED LEDGER IS COMPLETE ON EVERY DOOR. The single-challenge POST and
// PUT collect every (challenge, event) seal refusal over the WHOLE request in a
// pre-pass before their insert loop, so a request naming two compete events
// reports BOTH pairs with an honest `refused_total` — the client modal lists
// them. The in-loop check beneath the pre-pass is belt and braces: it is what
// used to throw at the FIRST refused pair, and a build that lost the pre-pass
// would fall back to it silently (one pair named of two), which is why the
// two-event arms exist beside the one-event ones.
//
// THE RULE BINDS EVERY TIER, AND THAT IS ASSERTED AT EVERY DOOR — the built-in
// superadmin is driven through POST, PUT and bulk, and an EVENT ADMIN organising
// the compete event through all three too. Each of those routes carries the
// locked-task idiom `task.locked && !req.session.isSuperAdmin` a few lines above
// its seal check, the exact carve-out a reader would copy onto the seal
// ("a superadmin can also unlock"); one door proving tier-blindness says nothing
// about the other two.
//
// ── FIXTURE TRAPS MET WHILE WRITING THIS ─────────────────────────────────────
//
//  • THE AUTHOR IS A USER-BACKED ADMIN, NEVER THE BUILT-IN SUPERADMIN. A seal
//    names an author (`tasks.created_by_id`) and the built-in account has no
//    `users` row, so `sealAtCreateDenied` refuses its every attempt to seal —
//    pinned at the bottom of this file as the reason every fixture here is a
//    promoted participant.
//  • A COMPETITOR IS REFUSED AT A DIFFERENT DOOR. Once the author X is enrolled
//    in a compete event, X's OWN POST against that event answers 403
//    `competitor_cannot_edit` BEFORE the seal question is ever asked — so the
//    author-rule arms are driven by a SECOND admin (Z), and the 403 is asserted
//    once so the next reader does not "fix" the file by re-pointing the actor.
//  • AN AUTHOR'S ROW ON A SWITCH-OFF EVENT CANNOT BE BUILT THROUGH THE API. Every
//    admin is staff-tagged on promotion and the assign route SKIPS a staff user
//    into an event whose switch is off (`skippedStaff`), so the row every
//    pre-v8.12.0 admin holds on the events they were enrolled in — a
//    `competition_users` row with the switch at its default 0 — is planted into
//    SQLite. The arm that needs it is the author rule's SWITCH GUARD: their own
//    challenges must stay assignable there, and X's own POST there is not the
//    competitor 403 either (`competitorIn` is keyed on `staff_compete = 1`).
//  • THE EVENT-ADMIN FIXTURE IS GRANTED BEFORE IT SIGNS IN. `POST
//    …/:id/admins` promotes the role and PURGES the target's sessions, so a
//    session taken first is dead by the time the grant lands. An event admin is
//    excluded from scoring by ROLE and is never tagged `staff` — which is what
//    makes them the one author the staff skip cannot reach (see the author-rule
//    enrolment test).
//  • THE PUT IS DESIRED-STATE WITH OPTIMISTIC CONCURRENCY: `expectedAssignments`
//    must equal what the challenge holds RIGHT NOW or the route 409s before any
//    seal check runs. Every test that PUTs mints its own challenge, so no earlier
//    test's assignment can turn a seal assertion into a spurious conflict.
//  • AN UNSEALED CHALLENGE INSIDE A COMPETE EVENT CANNOT BE BUILT THROUGH THE API
//    — assignment refuses it and the switch refuses to turn on over it (both by
//    design) — so the removal arms plant the row straight into SQLite, the shape
//    tests/answer-seal.api.spec.js uses for its v8.10.0-era row. The invariant is
//    that REMOVAL never asks the seal question, whatever put the row there: the
//    refusals name removal as the remedy, and a remedy that is itself refused is
//    the frozen-competition trap (v7.29.0) rebuilt.
//  • A TIME-EXPIRED COMPETE EVENT IS CREATED ALREADY OVER. Born-ended events are
//    allowed at create (v6.16.7), so `start_time` two hours ago with a 30-minute
//    duration gives an event whose status is `ended` while `ended_at` stays
//    NULL — the OTHER kind of ended (v7.6.x), which a filter on `ended_at` cannot
//    see. Assignment refuses an ended event, so its row is planted too.
//  • `end-now` AND THE SAME-MILLISECOND TRAP: the admin list's `status` reads the
//    effective end INCLUSIVELY (`n <= effEnd` is LIVE), so a list request landing
//    in the very ms `ended_at` was stamped still says "live" (v7.21.9). The
//    product asks no status at all now (`sealedTaskCompeteEvents` is assignment
//    alone), so nothing there can land in that window — but the test's own
//    precondition read is a separate request, so it is POLLED rather than read
//    once.
//  • 'any' CAN NEVER BE SEALED (v8.10.1, `answer_seal_needs_a_key`), so an `any`
//    challenge can never enter a compete event — the same 400, and the create
//    refusal is asserted as the PREMISE rather than assumed.
//  • THE SWITCH-DOOR ARM USES AN UPCOMING EVENT. A started event answers
//    `staff_compete_locked` before the unsealed or author question is ever
//    asked, so a live fixture there would pin the lock, not the seal.
//  • AFTER THE AUTHOR-RULE TESTS, X COMPETES IN E2 / E3 / E5 AND HOLDS A ROW ON
//    F. Every later arm mints fresh events; never ask X to edit or unseal a
//    challenge one of those events holds, or the answer is
//    `competitor_cannot_edit` at a different door and reads as a seal
//    regression.
//  • A SESSION-BEARING EVENT WITH EVERY SESSION OVER BY THE CLOCK reads `ended`
//    with `ended_at` NULL, and assignment is frozen once ANY session has ended,
//    so its rows are planted; a two-session event still live/upcoming takes the
//    challenge through the door and is then closed with `end-now`, which stamps
//    `ended_at` + `ended_manually` on the comp row and every slot.
//  • `file` IS THE ANSWER TYPE THAT IS UNFIT AT A BOOTH EVENT whatever its seal,
//    which is what lets one pair be judged by fit AND by the seal at once.
//  • ONE PARTICIPANT SOLVING EVERYTHING WOULD END AN EVENT (fixture checklist,
//    item 1). Nobody submits anything here — every event stays exactly as its
//    fixture made it, which is what lets the ended arms be driven by `end-now`,
//    by the clock alone, and — for the revive half — by an extend.
//
// ── MUTATIONS VERIFIED (each killing its own arm and only its own, unless
//    stated; each was run in a throwaway copy of the tree on its own port) ────
//
//   unsealedAssignmentDenied → null            13 tests — every arm with an
//                                              unsealed refusal, the ENDED-door
//                                              and fit-and-seal arms included;
//                                              the author-rule enrolment arm and
//                                              the UNSEAL arms correctly survive
//   authorCompetesDenied → null                the author-rule assignment arm
//   authorCompetesDenied loses its SWITCH      exactly the "switch-OFF event, the
//     guard (refuses on any event the author   author's own challenge lands"
//     is enrolled in)                          arm — the pre-v8.12.0 admin row
//   authoredAssignedTasks → []                 the author-rule enrolment arm
//   assign: the author check folded inside     exactly the SELF-ASSIGN arm
//     the self-assign bypass
//   assign: the `staffCompeteOn(comp)` gate    exactly the event-admin-author
//     around the author check dropped          into-a-switch-OFF-event arm
//   PUT desired-state seal check bypassed      exactly the PUT built-in-superadmin
//     for a superadmin (both sites)            arm
//   bulk seal check bypassed for a superadmin  exactly the bulk built-in-
//                                              superadmin arm
//   POST/PUT/bulk seal check bypassed for a    exactly the event-admin arm
//     scoped actor
//   POST pre-pass removed (first refusal only) exactly the two-event POST arms
//   PUT pre-pass removed (first refusal only)  exactly the two-event PUT arm
//   sealedTaskCompeteEvents DROPS an event     the first UNSEAL arm (ended
//     on `competitionFullyEnded` (the second   still counts), the time-expired
//     draft, i.e. the unseal-then-revive       arm (both halves) and the
//     hole re-opened)                          session-bearing KEEPS arm
//   sealedTaskCompeteEvents DROPS an event     the first UNSEAL arm and the
//     on `competitionStatus === "ended"`       time-expired arm
//   sealedTaskCompeteEvents DROPS an event     the session-bearing block arm
//     on `competitionAnySlotEnded` (the        AND its KEEPS twin's half-over
//     first draft)                             control
//   sealedTaskCompeteEvents filters on         the time-expired arm (an
//     `!c.ended_at`                            `ended_at`-NULL event dropped)
//   unsealDenied → null                        all four UNSEAL arms
//   unsealDenied ignores `scope`               exactly the event-admin UNSEAL
//     (`events = all`)                         arm ("only the event in ea's
//                                              scope is NAMED")
//   the task row's `withheld_compete` spread   exactly the event-admin
//     dropped (routes/challenges.js, round 4)  `withheld_compete` arm ("the
//                                              withheld event COMPETES, and the
//                                              row says so") — plus the
//                                              admin-ui spec's out-of-scope
//                                              Unseal arm, run separately
//   unsealDenied asked on EVERY save of a      exactly the first UNSEAL arm (its
//     sealed task (`answerSealed(existing)`    echo-save control; M1 — held only
//     for `_sealVal === 0`)                    incidentally by the lock spec
//                                              before)
//   switch: `participants: _authors` →         exactly the SWITCH-door arm (M3 —
//     `authors: []`                            SURVIVED every staff-compete spec
//                                              before that arm existed)
//   enrolledAuthors → []                       exactly the SWITCH-door arm
//   the switch's two checks swapped (authors   exactly the SWITCH-door arm, on
//     asked before unsealed)                   its ordering assertion
//   POST pre-pass no longer skips an ENDED     exactly the ENDED-door arm
//     event; PUT pre-pass likewise             exactly the ENDED-door arm
//   bulk asks the seal BEFORE fit; POST asks   exactly the fit-and-seal arm,
//     fit BEFORE the seal pre-pass             each
//
//   capRefused does not cap                    exactly the cap arm
//   capRefused lies about refused_total        exactly the cap arm
//   PUT asks the seal question of removals     exactly the removal arm
//   bulk misfiles unsealed as authorCompetes   5 tests — the two bulk arms, the
//                                              event-admin arm's bulk door, the
//                                              `any` bulk door and the ENDED-
//                                              door arm's bulk skip count
//   POST competitor gate binds a non-string    exactly the non-string arm (a 500
//     element (the `typeof` guard dropped)     for a user-backed admin)
//   POST pre-pass iterates the raw array       exactly the repeated-id arm
//     again (`new Set` dropped)
//
//   TWO ARMS WERE RED AGAINST THE FIRST DRAFT and carried `test.fixme` naming
//   the defect (each seen red before the fixme was added): the non-string
//   element 500 and the double-listed repeated pair. Both routes were fixed in
//   the same release and the fixmes lifted; the two rows above are their
//   mutations.
//
//   POST addTasks no longer a transaction      SURVIVES, and is recorded rather
//                                              than claimed: since the pre-pass
//                                              a seal refusal is thrown BEFORE
//                                              the insert loop runs, so nothing
//                                              is written for the transaction to
//                                              roll back. Removing the pre-pass
//                                              AND the transaction together is
//                                              what turns the all-or-nothing
//                                              [F, E] arm red — the in-loop check
//                                              then inserts into F before it
//                                              throws on E.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");

// better-sqlite3 is opened INSIDE the callback, never at module scope: per-file
// isolation recreates the database in a `beforeAll`, so a handle taken at require
// time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

const iso = ms => new Date(Date.now() + ms).toISOString();

/** Promote a fresh participant to `admin` (auto-tagged `staff`) and sign in as them. */
async function makeAdmin(sa, saCsrf, label) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  return { ...p, api, csrf };
}

/**
 * An EVENT ADMIN of `compId`: a fresh participant, granted (which promotes the
 * role to `event_admin` and purges their sessions), THEN signed in. The tier is
 * asserted off `/api/admin/me` so a grant that silently did nothing cannot hand
 * the test a plain participant wearing the fixture's name.
 */
async function makeEventAdmin(sa, saCsrf, compId, label) {
  const p = await makeParticipant(sa, saCsrf, label);
  await grantEventAdmin(sa, saCsrf, compId, p.id);
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  const me = await (await api.get("/api/admin/me")).json();
  expect(me.isEventAdmin, `PRECONDITION ${label}: holds the event-admin tier`).toBe(true);
  expect(me.eventAdminCompetitionCount, `PRECONDITION ${label}: organises exactly one event`).toBe(1);
  return { ...p, api, csrf };
}

let sa, saCsrf, X, Z, S, U, Y;

/**
 * An event with the switch set as asked. `kind` and `when` exist for the matrix
 * test; the default is a live tournament, the ordinary shape. `expired` is a
 * single-slot event created ALREADY past its scheduled end — status `ended`
 * with `ended_at` NULL, the time-expired kind. The switch is asserted BACK off
 * the admin list rather than trusted from the create.
 */
async function mkEvent(label, { on, kind = "tournament", when = "live" } = {}) {
  const name = `SC ${uniq(label)}`;
  const start = when === "upcoming" ? iso(2 * 3600_000) : when === "expired" ? iso(-2 * 3600_000) : iso(-60_000);
  const dur = when === "expired" ? 30 : 600;
  const data = kind === "program"
    ? { name, event_kind: "program", start_time: start, deadline_at: iso(10 * 86400_000), timezone: "UTC", staff_compete: !!on }
    : { name, event_kind: kind, start_time: start, duration_minutes: dur, staff_compete: !!on };
  const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data });
  expect(r.ok(), `create ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).competition?.id;
  expect(id, `create ${label} must return a competition id`).toBeTruthy();
  const row = await compRow(sa, id);
  expect(!!row.staff_compete, `PRECONDITION ${label}: the switch is ${on ? "ON" : "OFF"} on the wire`).toBe(!!on);
  expect(row.status, `PRECONDITION ${label}: status`).toBe(when === "expired" ? "ended" : when);
  return { id, name };
}

/** A challenge by `owner`. A sealed one carries a distinctive key so a leak would name itself. */
const sealedTask = (owner, label) => makeTask(owner.api, owner.csrf, `S ${label}`, { answer_sealed: true, correct_answer: `SEALKEY_${uniq("k")}` });
const plainTask  = (owner, label) => makeTask(owner.api, owner.csrf, `U ${label}`);
const anyTask    = (owner, label) => makeTask(owner.api, owner.csrf, `Y ${label}`, { answer_type: "any" });

async function compRow(api, compId) {
  const r = await api.get("/api/admin/competitions");
  expect(r.ok(), `competitions list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(c => c.id === compId);
  expect(row, `event ${compId} must be on the admin list`).toBeTruthy();
  return row;
}
async function taskRow(api, taskId) {
  const r = await api.get("/api/admin/tasks");
  expect(r.ok(), `tasks list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, `challenge ${taskId} must be on the admin list`).toBeTruthy();
  return row;
}
/** The ids of the events holding a challenge, read off the SAME list the admin pane renders from. */
async function heldBy(api, taskId) { return (await taskRow(api, taskId)).competitions.map(c => c.id); }

/** Does `userId` hold a `competition_users` row on `compId`? Read raw — the admin list carries `competing`, not `own`. */
const holdsRow = (compId, userId) =>
  !!withDb(db => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, userId));

/** Plant a `competition_tasks` row the API would refuse to write — see the header. */
const plantTask = (comp, task) => withDb(db => db.prepare(
  "INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at) VALUES (?,?,?,?)"
).run(comp.id, task.id, "test-plant", new Date().toISOString()), { readonly: false });

const postAssign = (actor, task, compIds) =>
  actor.api.post(`/api/admin/tasks/${task.id}/competitions`, { headers: H(actor.csrf), data: { competitionIds: compIds } });
const putDesired = (actor, task, compIds, expected) =>
  actor.api.put(`/api/admin/tasks/${task.id}/competitions`, { headers: H(actor.csrf), data: { competitionIds: compIds, expectedAssignments: expected } });
const bulkAssign = (actor, taskIds, compIds) =>
  actor.api.post("/api/admin/tasks/assign-competitions", { headers: H(actor.csrf), data: { taskIds, competitionIds: compIds } });
const enrolRaw = (actor, userIds, compIds) =>
  actor.api.post("/api/admin/competitions/assign", { headers: H(actor.csrf), data: { userIds, competitionIds: compIds } });

/**
 * The structured 400 every single-challenge door answers with. Asserts the whole
 * shape: the code, EVERY refused pair (`pairs`, or the single `task`/`comp`/
 * `reason` form), that no pair is listed twice, that `refused_total` is the
 * whole set, and that each message NAMES its event and its challenge (it is
 * what the client renders in a modal).
 */
async function expectSealRefusal(res, { code, task, comp, reason, pairs, what }) {
  expect(res.status(), `${what}: refused`).toBe(400);
  const b = await res.json();
  expect(b.code, `${what}: carries the machine code`).toBe(code);
  expect(Array.isArray(b.refused), `${what}: refused[] is a list`).toBe(true);
  const want = pairs || [{ task, comp, reason }];
  expect(b.refused, `${what}: EVERY refused pair is listed, not the first`).toHaveLength(want.length);
  expect(b.refused_total, `${what}: refused_total is the whole set`).toBe(want.length);
  const seen = new Set();
  for (const w of want) {
    const hit = b.refused.find(x => x.task_id === w.task.id && x.competition_id === w.comp.id);
    expect(hit, `${what}: names the pair “${w.task.title}” -> “${w.comp.name}”`).toBeTruthy();
    const key = `${hit.task_id}|${hit.competition_id}`;
    expect(seen.has(key), `${what}: pair ${key} listed once`).toBe(false);
    seen.add(key);
    expect(hit.title).toBe(w.task.title);
    expect(hit.competition_name).toBe(w.comp.name);
    expect(hit.reason).toBe(w.reason);
    expect(typeof hit.message).toBe("string");
    expect(hit.message, `${what}: the message names the event`).toContain(w.comp.name);
    expect(hit.message, `${what}: the message names the challenge`).toContain(w.task.title);
  }
  // The top-level error IS the first refused pair's message — one sentence, two places.
  expect(b.error).toBe(b.refused[0].message);
  return b;
}

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  X = await makeAdmin(sa, saCsrf, "author");
  Z = await makeAdmin(sa, saCsrf, "other");
  S = await sealedTask(X, "shared");
  U = await plainTask(X, "shared");
  Y = await anyTask(X, "shared");
  // PRECONDITIONS on the shared fixtures, read off the wire: the seal took on
  // S alone, and nothing is assigned anywhere yet.
  const rows = await Promise.all([S, U, Y].map(t => taskRow(X.api, t.id)));
  expect(!!rows[0].answer_sealed, "S is sealed").toBe(true);
  expect(!!rows[1].answer_sealed, "U is not").toBe(false);
  expect(!!rows[2].answer_sealed, "Y is not").toBe(false);
  expect(rows[2].answer_type, "Y is the free-response type").toBe("any");
  for (const r of rows) expect(r.competitions, `${r.title} starts unassigned`).toEqual([]);
});

test.afterAll(async () => {
  // Everything here is minted by this file; the contexts hold live sessions and
  // the platform allows one per user, so they are released rather than leaked.
  await X?.api?.dispose();
  await Z?.api?.dispose();
  await sa?.dispose();
});

test.describe("v8.12.0 — a compete event admits only sealed challenges, and never one its author competes in", () => {

  // ── POST /api/admin/tasks/:id/competitions ─────────────────────────────────

  test("POST: an unsealed challenge is refused with a structured 400, NOTHING is assigned, and the same request against a switch-off event lands", async () => {
    const E = await mkEvent("E", { on: true });
    const E2 = await mkEvent("E2", { on: true });
    const F = await mkEvent("F", { on: false });

    const r = await postAssign(X, U, [E.id]);
    await expectSealRefusal(r, { code: "staff_compete_unsealed", task: U, comp: E, reason: "unsealed", what: "U -> E" });
    expect(await heldBy(X.api, U.id), "U was NOT assigned to E").not.toContain(E.id);

    // TWO compete events in one request: BOTH pairs are reported — the pre-pass
    // collects every refusal before the insert loop — and nothing lands on either.
    const r2e = await postAssign(X, U, [E.id, E2.id]);
    await expectSealRefusal(r2e, { code: "staff_compete_unsealed", what: "U -> [E, E2]", pairs: [
      { task: U, comp: E, reason: "unsealed" }, { task: U, comp: E2, reason: "unsealed" },
    ] });
    let held = await heldBy(X.api, U.id);
    expect(held, "U is not in E").not.toContain(E.id);
    expect(held, "U is not in E2").not.toContain(E2.id);

    // TIER-BLIND: the built-in superadmin gets the identical refusal — the rule
    // is about the challenge and the event, not about who is asking.
    const r2 = await postAssign({ api: sa, csrf: saCsrf }, U, [E.id]);
    await expectSealRefusal(r2, { code: "staff_compete_unsealed", task: U, comp: E, reason: "unsealed", what: "U -> E (superadmin)" });
    expect(await heldBy(X.api, U.id), "still not assigned to E").not.toContain(E.id);

    // CONTROL 1 — the switch-OFF event admits the same unsealed challenge.
    await assignTask(X.api, X.csrf, U.id, [F.id]);
    expect(await heldBy(X.api, U.id), "U IS in F").toContain(F.id);
    // CONTROL 2 — the SEALED twin is admitted by BOTH compete events in one request.
    const d = await assignTask(X.api, X.csrf, S.id, [E.id, E2.id]);
    expect(d.assigned).toBe(2);
    held = await heldBy(X.api, S.id);
    expect(held, "S IS in E").toContain(E.id);
    expect(held, "S IS in E2").toContain(E2.id);
  });

  test("POST: the rule is the SWITCH — every kind, upcoming or live, refuses the unsealed and admits the sealed; the switch-off twin of each admits both", async () => {
    // The switch is universal (no policy key, no per-kind seed), so a kind or a
    // status that let an unsealed challenge through would be a hole the ordinary
    // live-tournament fixture cannot see.
    for (const kind of ["tournament", "booth", "program"]) {
      for (const when of ["upcoming", "live"]) {
        const E = await mkEvent(`${kind}-${when}-on`, { on: true, kind, when });
        const r = await postAssign(X, U, [E.id]);
        await expectSealRefusal(r, { code: "staff_compete_unsealed", task: U, comp: E, reason: "unsealed", what: `U -> ${kind}/${when}` });
        expect(await heldBy(X.api, U.id), `U not in ${kind}/${when}`).not.toContain(E.id);
        await assignTask(X.api, X.csrf, S.id, [E.id]);
        expect(await heldBy(X.api, S.id), `S in ${kind}/${when}`).toContain(E.id);

        // CONTROL — the same kind and status with the switch OFF admits the unsealed one.
        const F = await mkEvent(`${kind}-${when}-off`, { on: false, kind, when });
        await assignTask(X.api, X.csrf, U.id, [F.id]);
        expect(await heldBy(X.api, U.id), `U in ${kind}/${when} (off)`).toContain(F.id);
      }
    }
  });

  test("POST: a batch is ALL-OR-NOTHING — one refused pair assigns nothing, not even to the switch-off event named beside it", async () => {
    const E = await mkEvent("E", { on: true });
    const F = await mkEvent("F", { on: false });

    // F FIRST, deliberately. Since the pre-pass a seal refusal is thrown before
    // the insert loop runs at all, so this order proves the pre-pass sees the
    // WHOLE request rather than stopping at the first event; a build that lost
    // the pre-pass still holds this arm only because the in-loop check throws
    // INSIDE the transaction and rolls the insert into F back (see the header).
    const r1 = await postAssign(X, U, [F.id, E.id]);
    await expectSealRefusal(r1, { code: "staff_compete_unsealed", task: U, comp: E, reason: "unsealed", what: "U -> [F, E]" });
    let held = await heldBy(X.api, U.id);
    expect(held, "nothing landed on the compete event").not.toContain(E.id);
    expect(held, "and nothing landed on the switch-off event either — all or nothing").not.toContain(F.id);

    // The other order.
    const r2 = await postAssign(X, U, [E.id, F.id]);
    await expectSealRefusal(r2, { code: "staff_compete_unsealed", task: U, comp: E, reason: "unsealed", what: "U -> [E, F]" });
    held = await heldBy(X.api, U.id);
    expect(held).not.toContain(E.id);
    expect(held).not.toContain(F.id);

    // CONTROL — the sealed twin lands on BOTH in one request.
    const d = await assignTask(X.api, X.csrf, S.id, [F.id, E.id]);
    expect(d.assigned, "both events took the sealed challenge").toBe(2);
    held = await heldBy(X.api, S.id);
    expect(held).toContain(E.id);
    expect(held).toContain(F.id);
    // CONTROL — and the unsealed one alone lands on the switch-off event.
    await assignTask(X.api, X.csrf, U.id, [F.id]);
    expect(await heldBy(X.api, U.id)).toContain(F.id);
  });

  test("POST / PUT / bulk: an ENDED compete event keeps its older bare refusal, is SKIPPED by the seal pre-pass, and is counted apart from the seal at the bulk door", async () => {
    // A DECISION, pinned: both pre-passes `continue` past an ended event so it
    // keeps the refusal it has always had ("a session has already ended").
    // Listing it in `refused[]` would hand the client modal an event nobody can
    // assign to, with a remedy — seal a new copy — that cannot be taken there
    // either. A request naming an ended AND a live compete event therefore
    // reports the LIVE pair alone.
    const Expired = await mkEvent("E-expired", { on: true, when: "expired" });
    const Elive = await mkEvent("E-live", { on: true });
    const U7 = await plainTask(X, "ended-door");

    // Alone: the bare, older 400 — no code, no ledger.
    const r1 = await postAssign(X, U7, [Expired.id]);
    expect(r1.status()).toBe(400);
    const b1 = await r1.json();
    expect(b1.error).toContain("already ended");
    expect(b1.code, "not a seal refusal").toBeUndefined();
    expect(b1.refused, "no ledger").toBeUndefined();
    expect(b1.refused_total).toBeUndefined();
    const p1 = await putDesired(X, U7, [Expired.id], []);
    expect(p1.status()).toBe(400);
    const pb1 = await p1.json();
    expect(pb1.error).toContain("already ended");
    expect(pb1.code, "PUT: not a seal refusal either").toBeUndefined();
    expect(pb1.refused).toBeUndefined();
    expect(await heldBy(X.api, U7.id)).toEqual([]);

    // Beside a live compete event: the ledger names the LIVE pair alone.
    const r2 = await postAssign(X, U7, [Expired.id, Elive.id]);
    await expectSealRefusal(r2, { code: "staff_compete_unsealed", task: U7, comp: Elive, reason: "unsealed", what: "POST U7 -> [Expired, Elive]" });
    const p2 = await putDesired(X, U7, [Expired.id, Elive.id], []);
    await expectSealRefusal(p2, { code: "staff_compete_unsealed", task: U7, comp: Elive, reason: "unsealed", what: "PUT U7 -> [Expired, Elive]" });
    expect(await heldBy(X.api, U7.id), "nothing landed").toEqual([]);

    // The bulk door counts the two apart.
    const rb = await bulkAssign(X, [U7.id], [Expired.id, Elive.id]);
    expect(rb.ok(), `bulk: ${rb.status()} ${await rb.text()}`).toBeTruthy();
    const bb = await rb.json();
    expect(bb.assigned).toBe(0);
    expect(bb.skipped.endedComp, "the ended event is an ended skip").toBe(1);
    expect(bb.skipped.unsealed, "the live one is a seal skip").toBe(1);
    expect(bb.refused_total).toBe(1);
    expect(bb.refused).toHaveLength(1);
    expect(bb.refused[0]).toMatchObject({ task_id: U7.id, competition_id: Elive.id, reason: "unsealed" });
    expect(await heldBy(X.api, U7.id)).toEqual([]);

    // CONTROL — the SEALED twin beside the ended event: the ended refusal is
    // the whole answer at the single doors (all-or-nothing, no code), and the
    // bulk door lands the live pair while counting the ended one — so the
    // ended skip above is the event's doing, not the seal's.
    const S7 = await sealedTask(X, "ended-door");
    const r3 = await postAssign(X, S7, [Expired.id, Elive.id]);
    expect(r3.status()).toBe(400);
    const b3 = await r3.json();
    expect(b3.error).toContain("already ended");
    expect(b3.code).toBeUndefined();
    expect(await heldBy(X.api, S7.id), "all or nothing").toEqual([]);
    const rb2 = await bulkAssign(X, [S7.id], [Expired.id, Elive.id]);
    expect(rb2.ok()).toBeTruthy();
    const bb2 = await rb2.json();
    expect(bb2.assigned).toBe(1);
    expect(bb2.skipped.endedComp).toBe(1);
    expect(bb2.skipped.unsealed).toBe(0);
    expect(bb2.refused, "no ledger — nothing was refused for the seal").toBeUndefined();
    expect(await heldBy(X.api, S7.id)).toEqual([Elive.id]);
  });

  // ── PUT /api/admin/tasks/:id/competitions (desired state) ──────────────────

  test("PUT (desired state): an ADDITION to a compete event is refused with the same shape, every refused pair is listed, and the whole desired state is dropped", async () => {
    // Own challenges: the PUT compares `expectedAssignments` against what the
    // challenge holds NOW, so a shared fixture another test had assigned would
    // 409 here before the seal is ever asked (the third trap in the header).
    const U2 = await plainTask(X, "put");
    const S2 = await sealedTask(X, "put");
    const E = await mkEvent("E", { on: true });
    const E2 = await mkEvent("E2", { on: true });
    const F = await mkEvent("F", { on: false });

    const r1 = await putDesired(X, U2, [E.id], []);
    await expectSealRefusal(r1, { code: "staff_compete_unsealed", task: U2, comp: E, reason: "unsealed", what: "PUT U2 -> [E]" });
    expect(await heldBy(X.api, U2.id), "nothing was written").toEqual([]);

    // TIER-BLIND at THIS door too: the built-in superadmin is refused the same
    // way. The locked-task idiom two lines above the seal check bypasses a
    // superadmin; the seal must not.
    const rSa = await putDesired({ api: sa, csrf: saCsrf }, U2, [E.id], []);
    await expectSealRefusal(rSa, { code: "staff_compete_unsealed", task: U2, comp: E, reason: "unsealed", what: "PUT U2 -> [E] (superadmin)" });
    expect(await heldBy(X.api, U2.id), "nothing was written by the superadmin either").toEqual([]);

    // A mixed desired state is dropped WHOLE — the switch-off event is not added either.
    const r2 = await putDesired(X, U2, [F.id, E.id], []);
    await expectSealRefusal(r2, { code: "staff_compete_unsealed", task: U2, comp: E, reason: "unsealed", what: "PUT U2 -> [F, E]" });
    expect(await heldBy(X.api, U2.id), "all or nothing: F was not added while E was refused").toEqual([]);

    // TWO compete additions: both pairs are reported, nothing is written.
    const r3 = await putDesired(X, U2, [E.id, E2.id], []);
    await expectSealRefusal(r3, { code: "staff_compete_unsealed", what: "PUT U2 -> [E, E2]", pairs: [
      { task: U2, comp: E, reason: "unsealed" }, { task: U2, comp: E2, reason: "unsealed" },
    ] });
    expect(await heldBy(X.api, U2.id), "neither compete event took it").toEqual([]);

    // CONTROL 1 — the sealed twin's desired state is honoured, on both compete events.
    const ok1 = await putDesired(X, S2, [E.id, E2.id], []);
    expect(ok1.ok(), `PUT S2 -> [E, E2]: ${ok1.status()} ${await ok1.text()}`).toBeTruthy();
    expect(await ok1.json()).toMatchObject({ ok: true, added: 2, removed: 0 });
    expect((await heldBy(X.api, S2.id)).sort()).toEqual([E.id, E2.id].sort());
    // CONTROL 2 — the unsealed one's desired state is honoured on a switch-off event.
    const ok2 = await putDesired(X, U2, [F.id], []);
    expect(ok2.ok(), `PUT U2 -> [F]: ${ok2.status()} ${await ok2.text()}`).toBeTruthy();
    expect(await ok2.json()).toMatchObject({ ok: true, added: 1, removed: 0 });
    expect(await heldBy(X.api, U2.id)).toEqual([F.id]);
    // And a desired state that ECHOES the current one is no change at all.
    const echo = await putDesired(X, S2, [E.id, E2.id], [E.id, E2.id]);
    expect(echo.ok(), `echo: ${echo.status()} ${await echo.text()}`).toBeTruthy();
    expect(await echo.json()).toMatchObject({ ok: true, added: 0, removed: 0 });
  });

  test("PUT / DELETE: REMOVING an unsealed challenge from a compete event is always allowed — the remedy the refusals name is never itself refused", async () => {
    const U3 = await plainTask(X, "remove");
    const E = await mkEvent("E", { on: true });
    const F = await mkEvent("F", { on: false });

    // The state cannot be reached through the API (both doors refuse it), so
    // the row is planted — see the header. The invariant under test is about
    // what the routes do with such a row, not about how it got there.
    plantTask(E, U3);
    expect(await heldBy(X.api, U3.id), "PRECONDITION: the planted row is what the admin list reads").toEqual([E.id]);

    // An ECHO of the planted assignment is not an addition, so no seal question is asked.
    const echo = await putDesired(X, U3, [E.id], [E.id]);
    expect(echo.ok(), `echo of a planted row: ${echo.status()} ${await echo.text()}`).toBeTruthy();
    expect(await echo.json()).toMatchObject({ added: 0, removed: 0 });
    expect(await heldBy(X.api, U3.id), "untouched").toEqual([E.id]);

    // Adding a switch-OFF event BESIDE it is an addition to F only; E is not in the diff.
    const addF = await putDesired(X, U3, [E.id, F.id], [E.id]);
    expect(addF.ok(), `add F beside the planted E: ${addF.status()} ${await addF.text()}`).toBeTruthy();
    expect(await addF.json()).toMatchObject({ added: 1, removed: 0 });
    expect((await heldBy(X.api, U3.id)).sort(), "E kept, F added").toEqual([E.id, F.id].sort());

    // THE REMOVAL — the desired state drops E.
    const rm = await putDesired(X, U3, [F.id], [E.id, F.id]);
    expect(rm.ok(), `remove from the compete event: ${rm.status()} ${await rm.text()}`).toBeTruthy();
    expect(await rm.json()).toMatchObject({ ok: true, added: 0, removed: 1 });
    expect(await heldBy(X.api, U3.id), "E is gone, F stays").toEqual([F.id]);

    // And the row-level DELETE, on a freshly planted row.
    plantTask(E, U3);
    expect(await heldBy(X.api, U3.id), "PRECONDITION: re-planted").toContain(E.id);
    const del = await X.api.delete(`/api/admin/tasks/${U3.id}/competitions/${E.id}`, { headers: H(X.csrf) });
    expect(del.ok(), `DELETE U3/competitions/E: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect(await heldBy(X.api, U3.id), "E is gone again").toEqual([F.id]);

    // CONTROL — the same challenge is still REFUSED on the way back in: removal
    // being allowed does not mean the door opened.
    const back = await postAssign(X, U3, [E.id]);
    await expectSealRefusal(back, { code: "staff_compete_unsealed", task: U3, comp: E, reason: "unsealed", what: "U3 -> E after removal" });
    expect(await heldBy(X.api, U3.id)).toEqual([F.id]);
  });

  // ── POST /api/admin/tasks/assign-competitions (bulk, best-effort) ──────────

  test("bulk: the refused pairs are SKIPPED, counted and named, while every admissible pair in the same request lands", async () => {
    const E = await mkEvent("E", { on: true });
    const F = await mkEvent("F", { on: false });

    // Six pairs: S->E ok, S->F ok, U->E refused, U->F ok, Y->E refused, Y->F ok.
    const r = await bulkAssign(X, [S.id, U.id, Y.id], [E.id, F.id]);
    expect(r.ok(), `bulk: ${r.status()} ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.assigned, "the four admissible pairs landed").toBe(4);
    expect(b.skipped.unsealed, "two pairs skipped for the seal").toBe(2);
    expect(b.skipped.authorCompetes, "none for the author rule — X competes nowhere").toBe(0);
    expect(b.skipped.unfit, "and none for fit — text and any are fine on a tournament").toBe(0);
    expect(b.refused_total).toBe(2);
    expect(b.refused).toHaveLength(2);
    const pairs = b.refused.map(x => `${x.task_id}|${x.competition_id}`).sort();
    expect(pairs, "exactly the two unsealed-into-E pairs, named").toEqual([`${U.id}|${E.id}`, `${Y.id}|${E.id}`].sort());
    for (const x of b.refused) {
      expect(x.reason).toBe("unsealed");
      expect(x.competition_name).toBe(E.name);
      expect(x.title).toBe(x.task_id === U.id ? U.title : Y.title);
      expect(x.message).toContain(E.name);
    }
    // BY VALUE on the list the pane renders from.
    let held = await heldBy(X.api, S.id);
    expect(held, "S is in E").toContain(E.id);
    expect(held, "S is in F").toContain(F.id);
    held = await heldBy(X.api, U.id);
    expect(held, "U is NOT in E").not.toContain(E.id);
    expect(held, "U IS in F").toContain(F.id);
    held = await heldBy(X.api, Y.id);
    expect(held, "Y is NOT in E").not.toContain(E.id);
    expect(held, "Y IS in F").toContain(F.id);

    // TIER-BLIND at the bulk door: the built-in superadmin is skipped and named
    // the same way. The locked-task skip a few lines above the seal check
    // exempts a superadmin (`task.locked && !isSuper`); the seal must not.
    const rSa = await bulkAssign({ api: sa, csrf: saCsrf }, [U.id], [E.id]);
    expect(rSa.ok(), `bulk (superadmin): ${rSa.status()} ${await rSa.text()}`).toBeTruthy();
    const bSa = await rSa.json();
    expect(bSa.assigned, "the superadmin assigned nothing").toBe(0);
    expect(bSa.skipped.unsealed).toBe(1);
    expect(bSa.skipped.authorCompetes).toBe(0);
    expect(bSa.refused_total).toBe(1);
    expect(bSa.refused[0]).toMatchObject({ task_id: U.id, competition_id: E.id, reason: "unsealed" });
    expect(await heldBy(X.api, U.id), "U is still NOT in E").not.toContain(E.id);

    // The ledger is PRESENT ONLY WHEN NON-EMPTY, so an unscoped payload is
    // byte-identical to before this release.
    const F2 = await mkEvent("F2", { on: false });
    const r2 = await bulkAssign(X, [S.id], [F2.id]);
    expect(r2.ok()).toBeTruthy();
    const b2 = await r2.json();
    expect(b2.assigned).toBe(1);
    expect(b2.skipped.unsealed).toBe(0);
    expect(b2.skipped.authorCompetes).toBe(0);
    expect(b2.refused, "no ledger when nothing was refused").toBeUndefined();
    expect(b2.refused_total).toBeUndefined();
  });

  test("bulk: the refused ledger is CAPPED, and the total beside it stays honest", async () => {
    // The cap is read off the module rather than re-spelled: a lock that
    // hard-codes 50 goes stale silently when the constant moves. In-test require,
    // the v7.20.2-permitted shape — lib/staff-compete requires nothing at module
    // scope (that is its stated design), so this opens no database.
    const { REFUSED_LIST_CAP } = require("../lib/staff-compete");
    expect(REFUSED_LIST_CAP, "the cap is a positive integer").toBeGreaterThan(0);

    const E1 = await mkEvent("cap1", { on: true });
    const E2 = await mkEvent("cap2", { on: true });
    const n = Math.ceil(REFUSED_LIST_CAP / 2) + 1;   // n tasks x 2 events > the cap by 2
    const tasks = [];
    for (let i = 0; i < n; i++) tasks.push(await plainTask(X, `cap${i}`));
    const total = n * 2;

    const r = await bulkAssign(X, tasks.map(t => t.id), [E1.id, E2.id]);
    expect(r.ok(), `bulk: ${r.status()} ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    expect(b.assigned, "nothing landed — every pair is unsealed into a compete event").toBe(0);
    expect(b.skipped.unsealed, "the COUNT is the whole set").toBe(total);
    expect(b.refused_total, "the total is the whole set").toBe(total);
    expect(b.refused, "the LIST is capped").toHaveLength(REFUSED_LIST_CAP);
    // Every listed entry is a real pair, and no pair is listed twice.
    const ids = new Set(tasks.map(t => t.id));
    const seen = new Set();
    for (const x of b.refused) {
      expect(ids.has(x.task_id), `listed task ${x.task_id} is one of ours`).toBe(true);
      expect([E1.id, E2.id]).toContain(x.competition_id);
      expect(x.reason).toBe("unsealed");
      const key = `${x.task_id}|${x.competition_id}`;
      expect(seen.has(key), `pair ${key} listed once`).toBe(false);
      seen.add(key);
    }
    // And on the wire, none of them is in either event.
    for (const t of tasks.slice(0, 3)) expect(await heldBy(X.api, t.id)).toEqual([]);
  });

  // ── the request-body boundary at the assignment doors ────────────────────

  test("POST / PUT: a NON-STRING competitionIds element answers 4xx, never 500 — for a user-backed admin as for the built-in superadmin", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // the competitor gate at both doors bound a non-string `competitionIds`
    // element into SQL outside any try/catch (`competitorIn`), so a user-backed
    // admin got a 500 where the built-in superadmin (actorId null) got the 400.
    // v8.13.3 — both doors now refuse a non-string element UP FRONT, before the
    // competitor pre-pass, with "competitionIds must be an array of strings"
    // (the v8.12.0 `continue` let a nested id skip the competitor lock).
    // The ext-audit batch 5/7 class ("no mutating endpoint 500s on a non-string
    // field"), re-opened by the competitor gate v8.12.0 put ahead of the body
    // validation on both single doors: `competitorIn` binds the element into
    // SQL outside any try/catch. The bulk twin type-guards the same element.
    const E = await mkEvent("E", { on: true });
    const U4 = await plainTask(X, "malformed");
    for (const bad of [[{}], [["x"]], [123], [null]]) {
      const what = JSON.stringify(bad);
      const r = await postAssign(X, U4, bad);
      expect(r.status(), `POST ${what} as a user-backed admin is a 400`).toBe(400);
      expect((await r.json()).error, `POST ${what}: the up-front shape refusal`).toBe("competitionIds must be an array of strings");
      const p = await putDesired(X, U4, bad, []);
      expect(p.status(), `PUT ${what} as a user-backed admin is a 400`).toBe(400);
      expect((await p.json()).error, `PUT ${what}: the up-front shape refusal`).toBe("competitionIds must be an array of strings");
    }
    expect(await heldBy(X.api, U4.id), "nothing was written").toEqual([]);
    // CONTROL — the built-in superadmin (no `users` row, so the competitor gate
    // never binds) answers 400 for the identical body: the boundary exists,
    // and the difference is the gate.
    const rSa = await postAssign({ api: sa, csrf: saCsrf }, U4, [{}]);
    expect(rSa.status(), "built-in: 400").toBe(400);
    const pSa = await putDesired({ api: sa, csrf: saCsrf }, U4, [{}], []);
    expect(pSa.status(), "built-in PUT: 400").toBe(400);
    // …and a well-formed id that names no event is the ordinary 400 for everybody.
    const r404 = await postAssign(X, U4, ["no-such-event"]);
    expect(r404.status()).toBe(400);
    expect((await r404.json()).error).toContain("not found");
    // The sealed twin still lands on E: the doors work.
    await assignTask(X.api, X.csrf, S.id, [E.id]);
    expect(await heldBy(X.api, S.id)).toContain(E.id);
  });

  test("POST / PUT: a REPEATED event id in one request lists the refused pair ONCE, with an honest refused_total", async () => {
    // v8.12.0 — FIXED in the same release (was `test.fixme`, seen red first):
    // both seal pre-passes iterated `competitionIds` RAW, so [E, E] double-
    // listed one (challenge, event) pair with `refused_total: 2`. The POST
    // pre-pass iterates `new Set(competitionIds)` now and the PUT builds its
    // `_desired` set from the deduped, string-only array.
    // The competitor loop four lines above each pre-pass dedupes
    // (`new Set(competitionIds)`), and the success path tolerates a duplicate by
    // construction (INSERT OR IGNORE) — the ledger must not double-list one
    // real pair, or the client modal names the same event twice and the total
    // beside it is wrong.
    const E = await mkEvent("E", { on: true });
    const U6 = await plainTask(X, "dup");
    const r = await postAssign(X, U6, [E.id, E.id]);
    await expectSealRefusal(r, { code: "staff_compete_unsealed", task: U6, comp: E, reason: "unsealed", what: "POST U6 -> [E, E]" });
    expect(await heldBy(X.api, U6.id)).toEqual([]);
    const p = await putDesired(X, U6, [E.id, E.id], []);
    await expectSealRefusal(p, { code: "staff_compete_unsealed", task: U6, comp: E, reason: "unsealed", what: "PUT U6 -> [E, E]" });
    expect(await heldBy(X.api, U6.id)).toEqual([]);
    // CONTROL — the sealed twin named twice lands ONCE, by value.
    const S6 = await sealedTask(X, "dup");
    const ok = await postAssign(X, S6, [E.id, E.id]);
    expect(ok.ok(), `POST S6 -> [E, E]: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await ok.json()).assigned, "one row, counted once").toBe(1);
    expect(await heldBy(X.api, S6.id)).toEqual([E.id]);
  });

  // ── the EVENT-ADMIN tier ───────────────────────────────────────────────────

  test("event admin: an organiser of the compete event meets the SEAL refusal at all three doors — not a scope refusal — and their sealed twin lands", async () => {
    // The tier most likely to be both organiser and author, and a DISTINCT code
    // path: `taskViewDenied` / `competitionDenied` run before the seal check on
    // every assignment route, so a scoped actor who organises E and authored U
    // is refused by a predicate the global-admin arms never reach.
    const E = await mkEvent("E", { on: true });
    const F = await mkEvent("F", { on: false });          // out of the organiser's scope
    const ea = await makeEventAdmin(sa, saCsrf, E.id, "ea-seal");
    try {
      const Uea = await plainTask(ea, "ea");
      const Sea = await sealedTask(ea, "ea");

      const r1 = await postAssign(ea, Uea, [E.id]);
      await expectSealRefusal(r1, { code: "staff_compete_unsealed", task: Uea, comp: E, reason: "unsealed", what: "ea POST: Uea -> E" });
      expect(await heldBy(ea.api, Uea.id), "not assigned").toEqual([]);

      const r2 = await putDesired(ea, Uea, [E.id], []);
      await expectSealRefusal(r2, { code: "staff_compete_unsealed", task: Uea, comp: E, reason: "unsealed", what: "ea PUT: Uea -> [E]" });
      expect(await heldBy(ea.api, Uea.id), "still not assigned").toEqual([]);

      const r3 = await bulkAssign(ea, [Uea.id], [E.id]);
      expect(r3.ok(), `ea bulk: ${r3.status()} ${await r3.text()}`).toBeTruthy();
      const b3 = await r3.json();
      expect(b3.assigned).toBe(0);
      expect(b3.skipped.unsealed).toBe(1);
      expect(b3.skipped.outOfScope, "E is IN scope — this is the seal, not the scope").toBe(0);
      expect(b3.refused[0]).toMatchObject({ task_id: Uea.id, competition_id: E.id, reason: "unsealed" });
      expect(await heldBy(ea.api, Uea.id)).toEqual([]);

      // CONTROL 1 — the organiser's SEALED twin lands, through their own session.
      await assignTask(ea.api, ea.csrf, Sea.id, [E.id]);
      expect(await heldBy(ea.api, Sea.id), "Sea IS in E").toContain(E.id);
      // CONTROL 2 — an event they do NOT organise still answers the SCOPE code,
      // so the 400s above are the seal's and not a scope refusal in disguise.
      const oos = await postAssign(ea, Uea, [F.id]);
      expect(oos.status(), "out of scope is a 403").toBe(403);
      expect((await oos.json()).code).toBe("event_admin_out_of_scope");
    } finally {
      await ea.api.dispose();
    }
  });

  test("event admin: the UNSEAL refusal names only the compete events in the author's own scope, and COUNTS the rest — a global-admin author is named both (CONTROL)", async () => {
    // Round 3 (S7): `unsealDenied(db, taskId, scope)` narrows the NAMED list to
    // `scopedCompetitionIds(req)` and carries the remainder as
    // `withheld_competition_count` — the v8.8.8 rule one door over: a count is
    // a far smaller disclosure than another organiser's event name, and the
    // refusal is still honest about WHY the save was refused. `null` scope
    // (a global admin) names everything and carries no count.
    const E = await mkEvent("E-scoped", { on: true });     // ea organises this one
    const G = await mkEvent("G-far",    { on: true });     // …and NOT this one
    const ea = await makeEventAdmin(sa, saCsrf, E.id, "ea-unseal");
    try {
      const Sea = await sealedTask(ea, "ea-unseal");
      await assignTask(ea.api, ea.csrf, Sea.id, [E.id]);
      // The built-in puts it into the far event — ea could not (out of scope).
      await assignTask(sa, saCsrf, Sea.id, [G.id]);
      expect((await taskRow(sa, Sea.id)).competitions.map(c => c.id).sort(), "PRECONDITION: both compete events hold it").toEqual([E.id, G.id].sort());

      const r = await ea.api.put(`/api/admin/tasks/${Sea.id}`, { headers: H(ea.csrf), data: { answer_sealed: false } });
      expect(r.status(), `ea unseal: ${await r.text()}`).toBe(409);
      const b = await r.json();
      expect(b.code).toBe("answer_seal_in_compete_event");
      expect(b.competitions.map(c => c.id), "only the event in ea's scope is NAMED").toEqual([E.id]);
      expect(b.withheld_competition_count, "…and the other is a COUNT").toBe(1);
      expect(b.error).toContain(E.name);
      expect(b.error, "the far event's name is not disclosed").not.toContain(G.name);
      expect(b.error, "…but its existence is").toMatch(/1 more outside your events/);
      expect(!!(await taskRow(sa, Sea.id)).answer_sealed, "still sealed").toBe(true);

      // CONTROL — a GLOBAL-admin author on the same two events is named both,
      // with no count: the narrowing is the scope's doing, not the seal's.
      const Sx = await sealedTask(X, "global-unseal");
      await assignTask(X.api, X.csrf, Sx.id, [E.id, G.id]);
      const rx = await X.api.put(`/api/admin/tasks/${Sx.id}`, { headers: H(X.csrf), data: { answer_sealed: false } });
      expect(rx.status(), `X unseal: ${await rx.text()}`).toBe(409);
      const bx = await rx.json();
      expect(bx.competitions.map(c => c.id).sort(), "CONTROL: a global admin is named both").toEqual([E.id, G.id].sort());
      expect(bx.withheld_competition_count, "CONTROL: …and nothing is counted").toBeUndefined();
      expect(bx.error).toContain(G.name);
      expect(bx.error).not.toMatch(/outside your events/);
    } finally {
      await ea.api.dispose();
    }
  });

  test("event admin: the row says a WITHHELD event competes (`withheld_compete`), so the editor can withhold the Unseal tick it cannot otherwise see — absent when the far event does not compete (CONTROL), and for a global admin (CONTROL)", async () => {
    // Round 4: the editor withholds the author's Unseal control on
    // `competitions[].staff_compete`, and for an event admin that array is
    // NARROWED to the events they organise (v8.8.8) — so an author whose sealed
    // challenge sat only in somebody else's compete event was OFFERED the tick
    // and met the scoped 409 above, the v7.14.2 class. The row now carries
    // `withheld_compete: true` beside `withheld_competition_count`; a boolean,
    // never a name, since the count is the whole disclosure that row makes.
    const E = await mkEvent("E-home",  { on: false });    // ea organises this one, switch OFF
    const G = await mkEvent("G-far",   { on: true });     // …not this one, switch ON
    const N = await mkEvent("N-far",   { on: false });    // …nor this one, switch OFF (control)
    const ea = await makeEventAdmin(sa, saCsrf, E.id, "ea-withheld");
    try {
      const Sea = await sealedTask(ea, "ea-withheld");
      await assignTask(ea.api, ea.csrf, Sea.id, [E.id]);
      await assignTask(sa, saCsrf, Sea.id, [G.id]);
      const row = await taskRow(ea.api, Sea.id);
      expect(row.competitions.map(c => c.id), "PRECONDITION: the far event is withheld from ea's row").toEqual([E.id]);
      expect(row.competitions[0].staff_compete, "PRECONDITION: the home event does not compete, so the narrowed array alone has nothing to withhold on").toBe(false);
      expect(row.withheld_competition_count).toBe(1);
      expect(row.withheld_compete, "the withheld event COMPETES, and the row says so").toBe(true);

      // CONTROL — a far event that does NOT compete carries no flag at all.
      const Sn = await sealedTask(ea, "ea-withheld-ctl");
      await assignTask(ea.api, ea.csrf, Sn.id, [E.id]);
      await assignTask(sa, saCsrf, Sn.id, [N.id]);
      const rown = await taskRow(ea.api, Sn.id);
      expect(rown.withheld_competition_count, "CONTROL: still one withheld event").toBe(1);
      expect(rown.withheld_compete, "CONTROL: …that does not compete, so no flag").toBeUndefined();

      // CONTROL — a global admin's row is never narrowed, so the fact rides the
      // array itself and the flag never appears.
      const rowx = await taskRow(sa, Sea.id);
      expect(rowx.competitions.map(c => c.id).sort(), "CONTROL: a global admin sees both").toEqual([E.id, G.id].sort());
      expect(rowx.competitions.find(c => c.id === G.id).staff_compete, "CONTROL: …with the switch on the entry").toBe(true);
      expect(rowx.withheld_compete, "CONTROL: nothing withheld, nothing flagged").toBeUndefined();
    } finally {
      await ea.api.dispose();
    }
  });

  // ── the AUTHOR rule, from the assignment side ──────────────────────────────

  test("author rule: a sealed challenge is refused by a compete event its AUTHOR competes in — at the single, desired-state and bulk doors; on a switch-OFF event the author's row is nothing", async () => {
    const E2 = await mkEvent("E2", { on: true });      // holds nothing
    await enrol(sa, saCsrf, E2.id, [X.id]);            // asserts assigned === 1
    // PRECONDITION on the wire: X really competes there (a row + the switch).
    expect((await compRow(X.api, E2.id)).competing, "X competes in E2").toBe(true);

    // THE TRAP: X's OWN request meets the competitor door FIRST — a different
    // refusal, at a different status. Asserted so nobody re-points the actor.
    const own = await postAssign(X, S, [E2.id]);
    expect(own.status(), "a competitor cannot add anything to the event they compete in").toBe(403);
    expect((await own.json()).code).toBe("competitor_cannot_edit");
    expect(await heldBy(Z.api, S.id)).not.toContain(E2.id);

    // THE SEAL QUESTION, asked by another admin: S is sealed, but its author
    // holds a row on E2, so its key is readable by a competitor.
    const r1 = await postAssign(Z, S, [E2.id]);
    const b1 = await expectSealRefusal(r1, { code: "staff_compete_author_competes", task: S, comp: E2, reason: "author_competes", what: "Z: S -> E2" });
    expect(b1.refused[0].message, "the refusal names the author").toContain(X.nickname);
    expect(await heldBy(Z.api, S.id), "S is NOT in E2").not.toContain(E2.id);

    // Two compete events the author competes in: both author pairs are listed.
    const E3 = await mkEvent("E3", { on: true });
    await enrol(sa, saCsrf, E3.id, [X.id]);
    const r1b = await postAssign(Z, S, [E2.id, E3.id]);
    await expectSealRefusal(r1b, { code: "staff_compete_author_competes", what: "Z: S -> [E2, E3]", pairs: [
      { task: S, comp: E2, reason: "author_competes" }, { task: S, comp: E3, reason: "author_competes" },
    ] });
    const heldS = await heldBy(Z.api, S.id);
    expect(heldS).not.toContain(E2.id);
    expect(heldS).not.toContain(E3.id);

    // The desired-state door: the current set is round-tripped, E2 is the addition.
    const cur = await heldBy(Z.api, S.id);
    const r2 = await putDesired(Z, S, [...cur, E2.id], cur);
    await expectSealRefusal(r2, { code: "staff_compete_author_competes", task: S, comp: E2, reason: "author_competes", what: "Z PUT: S -> +E2" });
    expect(await heldBy(Z.api, S.id), "S is still NOT in E2").not.toContain(E2.id);

    // The bulk door: skipped, counted under its own reason, and named.
    const r3 = await bulkAssign(Z, [S.id], [E2.id]);
    expect(r3.ok()).toBeTruthy();
    const b3 = await r3.json();
    expect(b3.assigned).toBe(0);
    expect(b3.skipped.authorCompetes).toBe(1);
    expect(b3.skipped.unsealed).toBe(0);
    expect(b3.refused_total).toBe(1);
    expect(b3.refused[0]).toMatchObject({ task_id: S.id, competition_id: E2.id, reason: "author_competes" });
    expect(await heldBy(Z.api, S.id)).not.toContain(E2.id);

    // CONTROL — a sealed challenge by Z, who competes nowhere, lands on E2.
    const SZ = await sealedTask(Z, "byZ");
    await assignTask(Z.api, Z.csrf, SZ.id, [E2.id]);
    expect(await heldBy(Z.api, SZ.id)).toEqual([E2.id]);

    // And the UNSEALED challenge by the competing author is refused as UNSEALED:
    // the seal question is asked first, because its remedy (seal a fresh copy)
    // is the one that also has to be taken before the author question could
    // ever pass.
    const r4 = await postAssign(Z, U, [E2.id]);
    await expectSealRefusal(r4, { code: "staff_compete_unsealed", task: U, comp: E2, reason: "unsealed", what: "Z: U -> E2" });

    // THE SWITCH GUARD ON THE AUTHOR RULE. Every admin enrolled in an event
    // before this release holds exactly this row — a `competition_users` row on
    // an event whose switch is at its default 0 — and their own challenges must
    // stay assignable there. The row is planted (see the header: the assign
    // route skips a staff user into a switch-off event), and the precondition is
    // asserted BY VALUE both ways: the row exists, and X is NOT a competitor.
    const F = await mkEvent("F", { on: false });
    withDb(db => db.prepare(
      "INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)"
    ).run(F.id, X.id, "test-plant", new Date().toISOString()), { readonly: false });
    expect(holdsRow(F.id, X.id), "PRECONDITION: X holds a row on F").toBe(true);
    expect((await compRow(X.api, F.id)).competing, "…and is NOT a competitor there — the switch is off").toBe(false);
    const SA1 = await sealedTask(X, "off-single");
    const SB1 = await sealedTask(X, "off-put");
    const SC1 = await sealedTask(X, "off-bulk");
    await assignTask(Z.api, Z.csrf, SA1.id, [F.id]);
    expect(await heldBy(Z.api, SA1.id), "X's sealed challenge lands on F through the single door").toEqual([F.id]);
    const putF = await putDesired(Z, SB1, [F.id], []);
    expect(putF.ok(), `PUT SB1 -> [F]: ${putF.status()} ${await putF.text()}`).toBeTruthy();
    expect(await putF.json()).toMatchObject({ ok: true, added: 1, removed: 0 });
    const bkF = await bulkAssign(Z, [SC1.id], [F.id]);
    expect(bkF.ok()).toBeTruthy();
    const bbF = await bkF.json();
    expect(bbF.assigned, "…and through the bulk door").toBe(1);
    expect(bbF.skipped.authorCompetes).toBe(0);
    expect(bbF.refused, "no ledger").toBeUndefined();
    // And X's OWN POST there is not the competitor 403: `competitorIn` is
    // keyed on the switch, not on the row alone.
    await assignTask(X.api, X.csrf, U.id, [F.id]);
    expect(await heldBy(X.api, U.id), "X, who holds a row on F, still edits F").toContain(F.id);
  });

  test("author rule, the other door: enrolling the AUTHOR of an assigned challenge is skipped and named — by a colleague, by THEMSELVES, and for an untagged author only while the switch is on", async () => {
    const SI = await sealedTask(X, "enrol");
    const E = await mkEvent("E", { on: true });
    await assignTask(X.api, X.csrf, SI.id, [E.id]);

    // X authored SI, which E holds; Z authored nothing E holds. Both are
    // staff-tagged admins, and the actor is the built-in superadmin, so neither
    // the staff nor the privileged-target skip is in play.
    const r = await enrolRaw({ api: sa, csrf: saCsrf }, [X.id, Z.id], [E.id]);
    expect(r.ok(), `assign: ${r.status()} ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    expect(b.assigned, "only Z was enrolled").toBe(1);
    expect(b.skippedStaff, "the switch is on, so nobody is skipped as staff").toBe(0);
    expect(b.skippedPrivileged, "a superadmin may enrol an admin").toBe(0);
    expect(b.skippedAuthors).toEqual([{
      userId: X.id, nickname: X.nickname, competitionId: E.id, competitionName: E.name,
      tasks: [{ id: SI.id, title: SI.title }],
    }]);
    // BY VALUE: Z competes there, X does not.
    expect((await compRow(Z.api, E.id)).competing, "Z holds a row").toBe(true);
    expect((await compRow(X.api, E.id)).competing, "X does not").toBe(false);

    // SELF-ASSIGN IS NOT A BYPASS OF THE AUTHOR RULE. The privileged skip exempts
    // an actor enrolling THEMSELVES — the ordinary way an organiser joins the
    // event they will compete in — and the author rule must not inherit that
    // exemption: an author self-enrolling into the event holding their sealed
    // challenge would seat a competitor who knows an answer.
    const self = await enrolRaw(X, [X.id], [E.id]);
    expect(self.ok(), `self-assign: ${self.status()} ${await self.text()}`).toBeTruthy();
    const sb = await self.json();
    expect(sb.assigned, "X did not enrol themselves").toBe(0);
    expect(sb.skippedPrivileged, "self is exempt from the privileged skip").toBe(0);
    expect(sb.skippedStaff).toBe(0);
    expect(sb.skippedAuthors, "…and is skipped as the author, by name").toEqual([{
      userId: X.id, nickname: X.nickname, competitionId: E.id, competitionName: E.name,
      tasks: [{ id: SI.id, title: SI.title }],
    }]);
    expect((await compRow(X.api, E.id)).competing, "X still does not compete in E").toBe(false);

    // CONTROL — the same author, self-enrolled into a compete event holding
    // nothing of theirs, lands: self-assign is allowed, and the author rule is
    // about THIS event's challenges.
    const E5 = await mkEvent("E5", { on: true });
    const self5 = await enrolRaw(X, [X.id], [E5.id]);
    expect(self5.ok()).toBeTruthy();
    expect(await self5.json()).toMatchObject({ assigned: 1, skippedAuthors: [], skippedPrivileged: 0 });
    expect((await compRow(X.api, E5.id)).competing).toBe(true);

    // THE SWITCH GUARD FROM THIS DOOR, on the one author the STAFF skip cannot
    // reach. An event admin is excluded from scoring by ROLE and never tagged,
    // so on a switch-OFF event the staff skip is silent for them and only the
    // author gate could wrongly fire — a build that dropped the
    // `staffCompeteOn(comp)` gate around it would refuse this enrolment.
    const decoy = await mkEvent("decoy", { on: false });
    const ea = await makeEventAdmin(sa, saCsrf, decoy.id, "ea-author");
    try {
      const Sea = await sealedTask(ea, "ea-author");
      const F = await mkEvent("F", { on: false });
      await assignTask(sa, saCsrf, Sea.id, [F.id, E.id]);       // F off, E on; both hold ea's challenge
      const rF = await enrolRaw({ api: sa, csrf: saCsrf }, [ea.id], [F.id]);
      expect(rF.ok(), `enrol ea into F: ${rF.status()} ${await rF.text()}`).toBeTruthy();
      expect(await rF.json()).toMatchObject({ assigned: 1, skippedAuthors: [], skippedStaff: 0, skippedPrivileged: 0 });
      expect(holdsRow(F.id, ea.id), "the event-admin author holds a row on the switch-off event").toBe(true);
      // CONTROL — the identical author into the switch-ON event holding the
      // identical challenge is skipped and named: the gate is the SWITCH, and
      // the author check does apply to an untagged author once it is on.
      const rE = await enrolRaw({ api: sa, csrf: saCsrf }, [ea.id], [E.id]);
      expect(rE.ok()).toBeTruthy();
      const bE = await rE.json();
      expect(bE.assigned).toBe(0);
      expect(bE.skippedAuthors).toEqual([{
        userId: ea.id, nickname: ea.nickname, competitionId: E.id, competitionName: E.name,
        tasks: [{ id: Sea.id, title: Sea.title }],
      }]);
      expect(holdsRow(E.id, ea.id), "no row on the compete event").toBe(false);
    } finally {
      await ea.api.dispose();
    }
  });

  // ── the AUTHOR rule, from the SWITCH's side ────────────────────────────────

  test("author rule, the SWITCH door: turning the switch ON is refused while an ENROLLED person wrote a challenge the event holds — naming them and their challenges; an unsealed challenge is reported FIRST; removing the author lets it turn on", async () => {
    // The third door into "a competitor who knows a key" — the round-3 refusal
    // `staff_compete_enrolled_authors`. Assigning the challenge and enrolling
    // the author are both refused above, but BOTH gates are keyed on the switch
    // being ON, so a switch-OFF event can hold an author's sealed challenge and
    // that author's row at once, and the switch is the door that would seat
    // them against their own key.
    //
    // UPCOMING, deliberately: a started event answers `staff_compete_locked`
    // before the author question is asked. The author is an UNTAGGED event
    // admin (the enrolment test's shape): the assign route skips a staff-tagged
    // user into a switch-off event, so this is the one author whose row on F
    // the API itself writes — no planting.
    const F = await mkEvent("F", { on: false, when: "upcoming" });
    const decoy = await mkEvent("decoy", { on: false });
    const ea = await makeEventAdmin(sa, saCsrf, decoy.id, "ea-switch");
    const putSwitch = (comp, on) => sa.put(`/api/admin/competitions/${comp.id}`, { headers: H(saCsrf), data: { staff_compete: on } });
    try {
      const Sea = await sealedTask(ea, "ea-switch");
      await assignTask(sa, saCsrf, Sea.id, [F.id]);
      const en = await enrolRaw({ api: sa, csrf: saCsrf }, [ea.id], [F.id]);
      expect(en.ok(), `enrol ea into F: ${en.status()} ${await en.text()}`).toBeTruthy();
      expect((await en.json()).assigned, "PRECONDITION: the author holds a row on the switch-off event").toBe(1);
      expect(holdsRow(F.id, ea.id)).toBe(true);

      const r = await putSwitch(F, true);
      expect(r.status(), "the switch refuses to turn on over an enrolled author").toBe(400);
      const b = await r.json();
      expect(b.code).toBe("staff_compete_enrolled_authors");
      // THE PAYLOAD THE CLIENT MODAL RENDERS, by exact shape: the person and
      // the challenges they wrote that the event holds. Spelled `id` here and
      // `userId` on the assign door's `skippedAuthors` (pinned in the enrolment
      // test above) — two spellings for one idea, pinned as they are so a
      // rename on either side is a decision rather than drift.
      expect(b.participants).toEqual([{ id: ea.id, nickname: ea.nickname, tasks: [{ id: Sea.id, title: Sea.title }] }]);
      expect(b.error, "the sentence names the author").toContain(ea.nickname);
      expect(b.error, "…and the event").toContain(F.name);
      expect(b.challenges, "not the unsealed-challenges shape").toBeUndefined();
      // NOTHING WAS WRITTEN — by value, off the admin list.
      expect(!!(await compRow(sa, F.id)).staff_compete, "the switch is still OFF").toBe(false);
      expect(holdsRow(F.id, ea.id), "the row is untouched").toBe(true);

      // ORDERING: an event holding BOTH an unsealed challenge and an enrolled
      // author answers the UNSEALED refusal, not the author one — sealing a
      // copy is the change that has to land before the author question could
      // ever pass, so it is the one reported first.
      const G = await mkEvent("G", { on: false, when: "upcoming" });
      const Ug = await plainTask(X, "switch-order");
      await assignTask(sa, saCsrf, Sea.id, [G.id]);
      await assignTask(X.api, X.csrf, Ug.id, [G.id]);
      const enG = await enrolRaw({ api: sa, csrf: saCsrf }, [ea.id], [G.id]);
      expect(enG.ok()).toBeTruthy();
      expect((await enG.json()).assigned, "PRECONDITION: the author is enrolled in G too").toBe(1);
      const rG = await putSwitch(G, true);
      expect(rG.status()).toBe(400);
      const bG = await rG.json();
      expect(bG.code, "the unsealed challenge is reported before the enrolled author").toBe("staff_compete_unsealed_challenges");
      expect(bG.challenges.map(t => t.id), "…naming it").toEqual([Ug.id]);
      expect(bG.participants, "the author refusal is not reached").toBeUndefined();
      expect(!!(await compRow(sa, G.id)).staff_compete).toBe(false);

      // CONTROL 1 — remove the author from F (the remedy the refusal names) and
      // the identical PUT lands: the refusal was about the ROW, not the event.
      const rm = await sa.delete(`/api/admin/competitions/${F.id}/users/${ea.id}`, { headers: H(saCsrf) });
      expect(rm.ok(), `remove ea from F: ${rm.status()} ${await rm.text()}`).toBeTruthy();
      expect(holdsRow(F.id, ea.id), "PRECONDITION: the row is gone").toBe(false);
      const on = await putSwitch(F, true);
      expect(on.ok(), `switch on after the removal: ${on.status()} ${await on.text()}`).toBeTruthy();
      expect(!!(await compRow(sa, F.id)).staff_compete, "the switch is ON").toBe(true);

      // CONTROL 2 — a twin holding the SAME sealed challenge with a NON-author
      // enrolled turns on: the rule is about authorship, not about enrolment.
      const F2 = await mkEvent("F2", { on: false, when: "upcoming" });
      const P = await makeParticipant(sa, saCsrf, "non-author");
      await assignTask(sa, saCsrf, Sea.id, [F2.id]);
      await enrol(sa, saCsrf, F2.id, [P.id]);
      const on2 = await putSwitch(F2, true);
      expect(on2.ok(), `switch on with a non-author enrolled: ${on2.status()} ${await on2.text()}`).toBeTruthy();
      expect(!!(await compRow(sa, F2.id)).staff_compete).toBe(true);
    } finally {
      await ea.api.dispose();
    }
  });

  // ── the UNSEAL door ───────────────────────────────────────────────────────

  test("UNSEAL: refused while ANY compete event holds the challenge, at any status, naming them; an ENDED one still counts; a switch-off one never did", async () => {
    // THE RULE IS "IS IT ASSIGNED TO A COMPETE EVENT", FULL STOP. Two earlier
    // drafts of `sealedTaskCompeteEvents` dropped an ended event and both
    // reopened the seal by REORDERING: a manual end plus a deliberate extend
    // always revives (v7.7.x), a time-expired event revives by pure arithmetic
    // with no handler at all, and no revive path re-asks the seal question —
    // so "unseal once it has ended, then extend" put an unsealed key into a
    // live compete event. The cost is stated at the module and asserted here:
    // a challenge held by an ended compete event stays sealed for as long as it
    // stays assigned, because unassigning it is refused by the ended-session
    // freeze. The author loses nothing they hold — they read and edit a sealed
    // challenge — and "leave the answer sealed" is always available.
    const S3 = await sealedTask(X, "unseal");
    const Elive = await mkEvent("E-live", { on: true });
    const Eup   = await mkEvent("E-upcoming", { on: true, when: "upcoming" });
    const F     = await mkEvent("F", { on: false });
    const d = await assignTask(X.api, X.csrf, S3.id, [Elive.id, Eup.id, F.id]);
    expect(d.assigned).toBe(3);

    const unseal = (task) => X.api.put(`/api/admin/tasks/${task.id}`, { headers: H(X.csrf), data: { answer_sealed: false } });
    const sealedNow = async (task) => !!(await taskRow(X.api, task.id)).answer_sealed;

    // AN ORDINARY SAVE BY THE AUTHOR IS NOT AN UNSEAL. The gate is on the FLAG
    // TRANSITION (`_sealVal === 0`), not on "a sealed challenge held by a live
    // compete event": a title edit that round-trips `answer_sealed: true` — the
    // echo a client posting the whole row sends — lands, and the row stays
    // sealed. Without this, "the unseal is refused" below is equally satisfied
    // by a build that refuses EVERY save of such a challenge.
    const renamed = `${S3.title} (renamed)`;
    const save = await X.api.put(`/api/admin/tasks/${S3.id}`, { headers: H(X.csrf), data: { title: renamed, answer_sealed: true } });
    expect(save.ok(), `an echo-sealed title save by the author: ${save.status()} ${await save.text()}`).toBeTruthy();
    const afterSave = await taskRow(X.api, S3.id);
    expect(afterSave.title, "the title moved").toBe(renamed);
    expect(!!afterSave.answer_sealed, "…and the seal did not").toBe(true);
    S3.title = renamed;

    // Two compete events hold it: both are named, the switch-off one is not.
    const r1 = await unseal(S3);
    expect(r1.status(), "unseal is refused while a compete event holds the challenge").toBe(409);
    const b1 = await r1.json();
    expect(b1.code).toBe("answer_seal_in_compete_event");
    expect(b1.competitions.map(c => c.id).sort(), "BOTH compete events, and only those").toEqual([Elive.id, Eup.id].sort());
    for (const c of b1.competitions) expect(c.name, "each is named").toBe(c.id === Elive.id ? Elive.name : Eup.name);
    expect(b1.error).toContain(Elive.name);
    expect(b1.error).toContain(Eup.name);
    expect(b1.error, "the switch-off event is not blamed").not.toContain(F.name);
    expect(await sealedNow(S3), "nothing moved: still sealed").toBe(true);

    // END the live one (the built-in superadmin, which competes nowhere).
    const end = await sa.post(`/api/admin/competitions/${Elive.id}/end-now`, { headers: H(saCsrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    // POLLED, not read once: the list's status reads the effective end
    // inclusively, so a read landing in the ms `ended_at` was stamped still
    // says live (the header's same-millisecond trap).
    await expect.poll(async () => (await compRow(sa, Elive.id)).status, {
      timeout: 5000, message: "PRECONDITION: it really ended on the wire",
    }).toBe("ended");

    // The ended event STILL blocks, beside the upcoming one — BY VALUE: a build
    // that dropped the ended event names one, this one names two.
    const r2 = await unseal(S3);
    expect(r2.status(), "still refused — an ENDED compete event and an UPCOMING one hold it").toBe(409);
    const b2 = await r2.json();
    expect(b2.code).toBe("answer_seal_in_compete_event");
    expect(b2.competitions.map(c => c.id).sort(), "the ended event did NOT drop out of the list").toEqual([Elive.id, Eup.id].sort());
    expect(b2.error, "…and is still named in the sentence").toContain(Elive.name);
    expect(await sealedNow(S3)).toBe(true);

    // Take it out of the upcoming one — removal from a NON-ENDED event is always
    // allowed — and the ended one alone still refuses the unseal.
    const del = await X.api.delete(`/api/admin/tasks/${S3.id}/competitions/${Eup.id}`, { headers: H(X.csrf) });
    expect(del.ok(), `remove from Eup: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect((await heldBy(X.api, S3.id)).sort(), "PRECONDITION: only the ended compete event and the switch-off one hold it").toEqual([Elive.id, F.id].sort());
    const r3 = await unseal(S3);
    expect(r3.status(), "refused with ONLY an ended compete event holding it").toBe(409);
    const b3 = await r3.json();
    expect(b3.code).toBe("answer_seal_in_compete_event");
    expect(b3.competitions.map(c => c.id), "the ended event, alone").toEqual([Elive.id]);
    expect(b3.error, "the switch-off event is still not blamed").not.toContain(F.name);
    expect(await sealedNow(S3), "still sealed").toBe(true);
    // THE STATED COST: the remedy the refusal names is itself refused on an
    // ended event (the ended-session freeze), so the challenge stays sealed for
    // as long as it stays assigned. Asserted rather than implied, or a reader
    // "fixing" the DELETE door reopens the revive hole from the other side.
    const delEnded = await X.api.delete(`/api/admin/tasks/${S3.id}/competitions/${Elive.id}`, { headers: H(X.csrf) });
    expect(delEnded.status(), "unassigning from the ended event is refused by the ended-session freeze").toBe(400);
    expect((await delEnded.json()).error).toContain("already ended");
    expect((await heldBy(X.api, S3.id)).sort(), "nothing moved").toEqual([Elive.id, F.id].sort());
    // …and the author still reads and edits the sealed challenge — what the
    // seal costs them is the unseal, nothing else.
    const edit = await X.api.put(`/api/admin/tasks/${S3.id}`, { headers: H(X.csrf), data: { title: `${S3.title} (still mine)`, answer_sealed: true } });
    expect(edit.ok(), `the author still edits it: ${edit.status()} ${await edit.text()}`).toBeTruthy();
    expect((await taskRow(X.api, S3.id)).correct_answer, "…and still reads its key").toBeTruthy();

    // CONTROL — a sealed challenge held ONLY by a switch-off event unseals at once.
    const S4 = await sealedTask(X, "ctl");
    await assignTask(X.api, X.csrf, S4.id, [F.id]);
    const r4 = await unseal(S4);
    expect(r4.ok(), `CONTROL: ${r4.status()} ${await r4.text()}`).toBeTruthy();
    expect(await sealedNow(S4)).toBe(false);
  });

  test("UNSEAL: an event that is over by the CLOCK alone (ended_at NULL) blocks like any other — the two kinds of ended are one to the seal", async () => {
    // A manual end stamps `ended_at`; a time-expired event never does (v7.6.x),
    // and it REVIVES by pure arithmetic — extend the duration and it is live
    // again with no handler running and nothing to re-ask the seal. That is the
    // case that decided the rule: a build dropping a time-expired event from the
    // blocking set (a filter on status, or on `ended_at`) lets the author unseal
    // during the gap and hands a live compete event an unsealed key on the
    // extend. So the expired event is named BESIDE the live one, by value.
    const S5 = await sealedTask(X, "expired");
    const Expired = await mkEvent("E-expired", { on: true, when: "expired" });
    const row = await compRow(sa, Expired.id);
    expect(row.status, "PRECONDITION: over by the clock").toBe("ended");
    expect(row.ended_at, "PRECONDITION: …with ended_at NULL — the time-expired kind").toBeNull();
    const Elive = await mkEvent("E-live", { on: true });

    // Assignment refuses an ended event, so the expired one's row is planted;
    // the live one takes it through the door.
    plantTask(Expired, S5);
    await assignTask(X.api, X.csrf, S5.id, [Elive.id]);
    expect((await heldBy(X.api, S5.id)).sort(), "PRECONDITION: both hold it").toEqual([Expired.id, Elive.id].sort());

    const unseal = (task) => X.api.put(`/api/admin/tasks/${task.id}`, { headers: H(X.csrf), data: { answer_sealed: false } });
    const sealedNow = async (task) => !!(await taskRow(X.api, task.id)).answer_sealed;

    // BOTH are named, by value: a build that dropped the time-expired event
    // names the live one alone.
    const r1 = await unseal(S5);
    expect(r1.status(), "refused while the live AND the expired compete event hold it").toBe(409);
    const b1 = await r1.json();
    expect(b1.code).toBe("answer_seal_in_compete_event");
    expect(b1.competitions.map(c => c.id).sort(), "the live event AND the expired one").toEqual([Elive.id, Expired.id].sort());
    expect(b1.error, "the expired event is named in the sentence").toContain(Expired.name);
    expect(await sealedNow(S5)).toBe(true);

    // Take it out of the live one; only the time-expired event holds it now —
    // and that alone still refuses the unseal.
    const del = await X.api.delete(`/api/admin/tasks/${S5.id}/competitions/${Elive.id}`, { headers: H(X.csrf) });
    expect(del.ok(), `remove from Elive: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect(await heldBy(X.api, S5.id), "PRECONDITION: the expired event still holds it").toEqual([Expired.id]);
    const r2 = await unseal(S5);
    expect(r2.status(), "refused with only a TIME-EXPIRED compete event holding it").toBe(409);
    expect((await r2.json()).competitions.map(c => c.id), "the expired event, alone").toEqual([Expired.id]);
    expect(await sealedNow(S5), "still sealed").toBe(true);

    // THE HOLE THE RULE CLOSES, driven: extend the expired event's duration so
    // it revives by arithmetic alone, and the challenge it holds is still
    // sealed inside a LIVE compete event. Under the dropped-when-ended rule the
    // unseal above would have landed, and this row would now be an unsealed
    // key on a live board.
    const ext = await sa.put(`/api/admin/competitions/${Expired.id}`, { headers: H(saCsrf), data: { duration_minutes: 24 * 60, expectedUpdatedAt: (await compRow(sa, Expired.id)).updated_at } });
    expect(ext.ok(), `extend the expired event: ${ext.status()} ${await ext.text()}`).toBeTruthy();
    await expect.poll(async () => (await compRow(sa, Expired.id)).status, {
      timeout: 5000, message: "PRECONDITION: it really revived by arithmetic",
    }).toBe("live");
    expect(await sealedNow(S5), "the key is still sealed inside the revived compete event").toBe(true);
    expect(await heldBy(X.api, S5.id), "…which still holds it").toEqual([Expired.id]);
  });

  // THE FIRST DRAFT DROPPED AN EVENT ON `competitionAnySlotEnded` (the
  // lib/challenge-fit.js rule), which let the author unseal after ONE session
  // of a multi-session event while a later session was still live. This arm
  // is the lock against that draft coming back: a reader who "aligns" the seal
  // with the assignment freeze turns it red — that is the point of it.
  test("UNSEAL: a session-bearing compete event whose FIRST session has ended still holds the seal while its second is live", async () => {
    // Two sessions: A already over by the clock, B live for hours. The EVENT is
    // live (`competitionStatus` over slots), so competitors in B are still
    // competing, and the answer key must stay sealed until B is over too.
    const S7 = await sealedTask(X, "slots");
    const T = await mkEvent("E-slots", { on: true });
    const mkSlot = (name, startMs, dur) => sa.post(`/api/admin/competitions/${T.id}/timeslots`, {
      headers: H(saCsrf), data: { name, start_time: iso(startMs), duration_minutes: dur },
    });
    const a = await mkSlot("A", -3 * 3600_000, 30);
    expect(a.ok(), `slot A: ${a.status()} ${await a.text()}`).toBeTruthy();
    const b = await mkSlot("B", -60_000, 600);
    expect(b.ok(), `slot B: ${b.status()} ${await b.text()}`).toBeTruthy();
    const row = await compRow(sa, T.id);
    expect(row.status, "PRECONDITION: the EVENT is live").toBe("live");
    expect(row.timeslots.map(s => s.status).sort(), "PRECONDITION: one session over, one live").toEqual(["ended", "live"]);
    // Assignment is frozen once any session has ended, so the row is planted.
    plantTask(T, S7);
    expect(await heldBy(X.api, S7.id)).toEqual([T.id]);

    const r = await X.api.put(`/api/admin/tasks/${S7.id}`, { headers: H(X.csrf), data: { answer_sealed: false } });
    expect(r.status(), "the live second session keeps the seal on").toBe(409);
    expect((await r.json()).code).toBe("answer_seal_in_compete_event");
    expect(!!(await taskRow(X.api, S7.id)).answer_sealed, "still sealed").toBe(true);
  });

  test("UNSEAL: a session-bearing compete event KEEPS the seal once EVERY session is over — by the clock, and by End Now — because either kind of end revives", async () => {
    // The second draft dropped an event on `competitionFullyEnded`, which for a
    // session-bearing event means "every session has ended" — and every such
    // event revives: a new session, an extended one, or an End Now followed by
    // a deliberate extend (v7.7.x). No revive path re-asks the seal, so a build
    // that dropped the fully-over event let the author unseal in the gap and
    // then handed the revived event an unsealed key. Both kinds of "every
    // session over" are driven, by value, beside a half-over twin — a build
    // that dropped either names one event where this names two.
    const mkSlot = (comp, name, startMs, dur) => sa.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: H(saCsrf), data: { name, start_time: iso(startMs), duration_minutes: dur },
    });
    const unseal = (task) => X.api.put(`/api/admin/tasks/${task.id}`, { headers: H(X.csrf), data: { answer_sealed: false } });
    const sealedNow = async (task) => !!(await taskRow(X.api, task.id)).answer_sealed;

    // (a) BY THE CLOCK: two sessions, both over; nothing stamped `ended_at`.
    const T2 = await mkEvent("E-slots-over", { on: true });
    for (const [n, st] of [["A", -3 * 3600_000], ["B", -2 * 3600_000]]) {
      const s = await mkSlot(T2, n, st, 30);
      expect(s.ok(), `slot ${n}: ${s.status()} ${await s.text()}`).toBeTruthy();
    }
    let row = await compRow(sa, T2.id);
    expect(row.status, "PRECONDITION: the EVENT is over").toBe("ended");
    expect(row.timeslots.map(s => s.status), "PRECONDITION: both sessions over").toEqual(["ended", "ended"]);
    expect(row.ended_at, "PRECONDITION: …by the clock alone, ended_at NULL").toBeNull();
    // A twin with ONE session still live sits beside it, so the assertion is
    // BY VALUE — both named — rather than a bare 409 a build that blocks on the
    // half-over twin alone would also produce.
    const T4 = await mkEvent("E-slots-half", { on: true });
    expect((await mkSlot(T4, "A", -3 * 3600_000, 30)).ok()).toBeTruthy();
    expect((await mkSlot(T4, "B", -60_000, 600)).ok()).toBeTruthy();
    expect((await compRow(sa, T4.id)).timeslots.map(s => s.status).sort(), "PRECONDITION: one over, one live").toEqual(["ended", "live"]);
    // Assignment is frozen once any session has ended, so both rows are planted.
    const S8 = await sealedTask(X, "slots-over");
    plantTask(T2, S8);
    plantTask(T4, S8);
    expect((await heldBy(X.api, S8.id)).sort(), "PRECONDITION: both hold it").toEqual([T2.id, T4.id].sort());
    const r1 = await unseal(S8);
    expect(r1.status(), "both block").toBe(409);
    const b1 = await r1.json();
    expect(b1.code).toBe("answer_seal_in_compete_event");
    expect(b1.competitions.map(c => c.id).sort(), "the fully-over event is IN the list beside the half-over one").toEqual([T2.id, T4.id].sort());
    expect(b1.error, "…and in the sentence").toContain(T2.name);
    expect(await sealedNow(S8)).toBe(true);
    // And a challenge held ONLY by the fully-over event is still refused.
    const S8b = await sealedTask(X, "slots-over-only");
    plantTask(T2, S8b);
    expect(await heldBy(X.api, S8b.id), "PRECONDITION: the planted row is what the list reads").toEqual([T2.id]);
    const r2 = await unseal(S8b);
    expect(r2.status(), "refused with only a fully-over session-bearing event holding it").toBe(409);
    expect((await r2.json()).competitions.map(c => c.id), "the fully-over event, alone").toEqual([T2.id]);
    expect(await sealedNow(S8b), "still sealed").toBe(true);
    expect(await heldBy(X.api, S8b.id), "…and the row is untouched").toEqual([T2.id]);

    // (b) BY END NOW: a live two-session event ended manually. The comp row is
    // stamped `ended_at` + `ended_manually`, on which `competitionFullyEnded`
    // short-circuits — no one-millisecond window. Assignment is OPEN while both
    // sessions are live or upcoming, so this one takes the challenge through
    // the door rather than by planting.
    const S9 = await sealedTask(X, "slots-manual");
    const T3 = await mkEvent("E-slots-manual", { on: true });
    expect((await mkSlot(T3, "A", -60_000, 600)).ok()).toBeTruthy();
    expect((await mkSlot(T3, "B", 3600_000, 60)).ok()).toBeTruthy();
    expect((await compRow(sa, T3.id)).status, "PRECONDITION: live").toBe("live");
    await assignTask(X.api, X.csrf, S9.id, [T3.id]);
    const r3 = await unseal(S9);
    expect(r3.status(), "CONTROL: it blocks while a session is live").toBe(409);
    expect((await r3.json()).competitions.map(c => c.id)).toEqual([T3.id]);
    const end = await sa.post(`/api/admin/competitions/${T3.id}/end-now`, { headers: H(saCsrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    await expect.poll(async () => (await compRow(sa, T3.id)).status, {
      timeout: 5000, message: "PRECONDITION: it really ended on the wire",
    }).toBe("ended");
    row = await compRow(sa, T3.id);
    expect(row.ended_at, "PRECONDITION: the manual kind — ended_at stamped").not.toBeNull();
    expect(row.timeslots.map(s => s.status), "PRECONDITION: every session over").toEqual(["ended", "ended"]);
    const r4 = await unseal(S9);
    expect(r4.status(), "still refused after End Now on a session-bearing event").toBe(409);
    expect((await r4.json()).competitions.map(c => c.id), "the manually-ended event, alone").toEqual([T3.id]);
    expect(await sealedNow(S9), "still sealed").toBe(true);
    expect(await heldBy(X.api, S9.id), "the row stays in the ended event").toEqual([T3.id]);
  });

  // ── the free-response type ────────────────────────────────────────────────

  test("'any' can never be sealed, so it can never enter a compete event — at the single and bulk doors", async () => {
    // THE PREMISE, asserted rather than assumed: the seal needs a key and the
    // free-response type has none (v8.10.1).
    const mk = await X.api.post("/api/admin/tasks", {
      headers: H(X.csrf),
      data: { title: uniq("AnySealed"), description: "<p>d</p>", difficulty: "easy", status: "published", answer_type: "any", answer_sealed: true },
    });
    expect(mk.status(), "sealing an `any` challenge is refused at create").toBe(400);
    expect((await mk.json()).code).toBe("answer_seal_needs_a_key");

    const E = await mkEvent("E", { on: true });
    const F = await mkEvent("F", { on: false });
    const r = await postAssign(X, Y, [E.id]);
    await expectSealRefusal(r, { code: "staff_compete_unsealed", task: Y, comp: E, reason: "unsealed", what: "Y -> E" });
    expect(await heldBy(X.api, Y.id)).not.toContain(E.id);

    const rb = await bulkAssign(X, [Y.id], [E.id]);
    expect(rb.ok()).toBeTruthy();
    const b = await rb.json();
    expect(b.assigned).toBe(0);
    expect(b.skipped.unsealed).toBe(1);
    expect(b.refused[0]).toMatchObject({ task_id: Y.id, competition_id: E.id, reason: "unsealed" });

    // CONTROL — the switch-off event takes the free-response challenge as ever.
    await assignTask(X.api, X.csrf, Y.id, [F.id]);
    expect(await heldBy(X.api, Y.id)).toContain(F.id);
  });

  // ── fit AND seal at one pair ──────────────────────────────────────────────

  test("fit and seal at ONE pair: the single doors answer the SEAL, the bulk door answers FIT — pinned as it is, so a change to either order is a decision", async () => {
    // A RECORDED INCONSISTENCY, reported rather than fixed here. A `file`-answer
    // challenge is UNFIT for a Booth Event whatever its seal (lib/challenge-fit.js).
    // The POST and PUT pre-passes ask the seal BEFORE the in-loop fit check, so
    // an unsealed one answers the structured seal refusal — whose remedy, "seal
    // a copy", would then be refused for fit — while the bulk door asks fit
    // FIRST and files the same pair under `unfit`. Two doors, two remedies for
    // one pair. Both refuse, so nothing leaks; this arm asserts what is TRUE
    // (the v8.8.17 posture) and a build that unifies the order re-points it
    // deliberately rather than passing in silence.
    const B = await mkEvent("booth-on", { on: true, kind: "booth", when: "upcoming" });
    const Boff = await mkEvent("booth-off", { on: false, kind: "booth", when: "upcoming" });
    const Uf = await makeTask(X.api, X.csrf, "U file", { answer_type: "file" });
    const Sf = await makeTask(X.api, X.csrf, "S file", { answer_type: "file", answer_sealed: true, correct_answer: `SEALKEY_${uniq("k")}` });
    expect(!!(await taskRow(X.api, Sf.id)).answer_sealed, "PRECONDITION: the file twin is sealed").toBe(true);

    // The single doors: the SEAL answers first.
    const r1 = await postAssign(X, Uf, [B.id]);
    await expectSealRefusal(r1, { code: "staff_compete_unsealed", task: Uf, comp: B, reason: "unsealed", what: "POST unsealed file -> booth (on)" });
    const p1 = await putDesired(X, Uf, [B.id], []);
    await expectSealRefusal(p1, { code: "staff_compete_unsealed", task: Uf, comp: B, reason: "unsealed", what: "PUT unsealed file -> booth (on)" });
    // The bulk door: FIT answers first, and the seal ledger is silent.
    const rb = await bulkAssign(X, [Uf.id], [B.id]);
    expect(rb.ok()).toBeTruthy();
    const bb = await rb.json();
    expect(bb).toMatchObject({ assigned: 0, skipped: expect.objectContaining({ unfit: 1, unsealed: 0, authorCompetes: 0 }) });
    expect(bb.unfitReasons, "the fit sentence rides the response").toHaveLength(1);
    expect(bb.unfitReasons[0]).toContain(Uf.title);
    expect(bb.refused, "no seal ledger").toBeUndefined();

    // CONTROLS. (a) The SEALED file twin is refused for FIT at every door — the
    // fit check is live behind the seal on the single doors, and is what the
    // bulk door answered above.
    const r2 = await postAssign(X, Sf, [B.id]);
    expect(r2.status()).toBe(400);
    const b2 = await r2.json();
    expect(b2.code, "fit is the bare, older 400").toBeUndefined();
    expect(b2.error).toContain("uploading a file");
    const p2 = await putDesired(X, Sf, [B.id], []);
    expect(p2.status()).toBe(400);
    expect((await p2.json()).code).toBeUndefined();
    const rb2 = await bulkAssign(X, [Sf.id], [B.id]);
    expect(await rb2.json()).toMatchObject({ assigned: 0, skipped: expect.objectContaining({ unfit: 1, unsealed: 0 }) });
    // (b) The unsealed file twin into a switch-OFF booth is fit's bare 400 too:
    // the structured refusal above came from the seal, not from fit.
    const r3 = await postAssign(X, Uf, [Boff.id]);
    expect(r3.status()).toBe(400);
    expect((await r3.json()).code).toBeUndefined();
    // Nothing landed anywhere.
    expect(await heldBy(X.api, Uf.id)).toEqual([]);
    expect(await heldBy(X.api, Sf.id)).toEqual([]);
  });

  // ── why every fixture above is a promoted participant ─────────────────────

  test("the built-in superadmin cannot seal — so it can author nothing a compete event would admit", async () => {
    // The built-in account has no `users` row, hence no `created_by_id`, hence
    // no seal — which is the reason this file promotes participants. The seal
    // refusal ITSELF (`answer_seal_needs_author`) is locked once, in
    // answer-seal.api.spec.js; v8.12.4 removed the verbatim copy that stood here.
    // What this file adds is the consequence: the only challenge that account CAN
    // author is unsealed, and a compete event refuses it exactly like X's.
    const ok = await sa.post("/api/admin/tasks", {
      headers: H(saCsrf),
      data: { title: uniq("SA plain"), description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" },
    });
    expect(ok.ok(), `plain create: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    const saTask = { id: (await ok.json()).id, title: null };
    saTask.title = (await taskRow(sa, saTask.id)).title;
    const E = await mkEvent("E", { on: true });
    const ref = await postAssign({ api: sa, csrf: saCsrf }, saTask, [E.id]);
    await expectSealRefusal(ref, { code: "staff_compete_unsealed", task: saTask, comp: E, reason: "unsealed", what: "SA plain -> E" });
  });
});
