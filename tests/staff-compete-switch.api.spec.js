// @ts-check
//
// v8.12.0 — THE STAFF-COMPETE SWITCH, on the wire.
//
// `competitions.staff_compete` is a per-event switch (all three kinds, default
// OFF). This file locks the SWITCH ITSELF — everything that reads it, writes it or
// refuses to write it — and deliberately nothing downstream of it (the edit lock,
// the seal invariant at assignment, the row-writers and scoring each have their
// own file). Concretely:
//
//   • CREATE binds it explicitly for every kind — true, false and ABSENT (which
//     must land as 0, not as NULL), and the `created` audit carries it;
//   • the WIRE — `staff_compete`, `staff_compete_locked` (null | 'started' |
//     'ended', the last two from the SLOTS on a multi-session event: `every`
//     session ended is 'ended', one ended beside an upcoming one is 'started',
//     and end-now with a session still to come is 'ended') and `competing` (for
//     every tier: regular admin, user-backed superadmin, event admin on the
//     scoped list — and TRUE on `_compWire` through the one door that reaches
//     it) — on the admin list AND on the `_compWire` responses (create / PUT /
//     end-now), from ONE helper so they cannot disagree;
//   • the PUT — 0→1 and 1→0 on an UPCOMING event succeed and the `edited` ladder
//     records `changes.staff_compete {from,to}`; an ECHO of the stored value on a
//     started event is not a change and is not refused, and neither is one on
//     an ENDED event beside the reveal-answers toggle (the one post-end edit a
//     human makes, with the switch riding every save); a flip on a LIVE event
//     is `staff_compete_locked`; on an ENDED one `staff_compete_locked_ended`
//     (ended is asked FIRST, or the started reason would answer with the wrong
//     words); a KIND change neither resets the switch nor records it;
//   • the THREE content refusals — 0→1 with an UNSEALED challenge assigned
//     names it (`staff_compete_unsealed_challenges`, `challenges:[{id,title}]`);
//     0→1 with an ENROLLED AUTHOR of an assigned challenge names them and their
//     challenges (`staff_compete_enrolled_authors`,
//     `participants:[{id,nickname,tasks:[{id,title}]}]`, one entry per author,
//     tasks by title), asked AFTER the unsealed question and with both of its
//     remedies driven; 1→0 with a staff-TAGGED user enrolled names them
//     (`staff_compete_enrolled_staff`, `participants:[{id,nickname}]`) — and the
//     TAG rule: an enrolled EVENT ADMIN (role, untagged) does NOT block turning
//     it off;
//   • every refusal — unsealed, enrolled-author, enrolled-staff, started AND
//     ended — sits ABOVE `validate_only`, so a dry run meets it and writes
//     nothing; and the COMPETITOR gate sits above it too, so a competitor's dry
//     run is 403 rather than `validated:true`;
//   • the post-commit cache busts — `/api/me`'s `competing` (2 s me-cache) and the
//     admin board (5 s leaderboard cache) both move within their TTL;
//   • the export and the public self-enroll preview carry the flag;
//   • and the pure module at column 0: `switchLock`, `capRefused`,
//     `staffCompeteOn` THROWING on a row that never selected the column,
//     `enrolledAuthors` (a NULL author and a non-enrolled author never match; one
//     author's challenges are one entry) — plus a SOURCE arm that no route spells
//     a staff-compete code as a literal.
//
// ── NOT A DEFECT, RECORDED SO NOBODY RE-FILES IT ──────────────────────────────
//
// `staffEnrolled` exempts an enrolled EVENT ADMIN from the 1→0 refusal (the
// arm "an ENROLLED EVENT ADMIN … does NOT block turning it off" pins it), while
// the module's own definition of "staff" for SCORING is the tag OR that role.
// The exemption is coherent BECAUSE OF the started lock: the switch can only
// flip while the event is UPCOMING, no solve-clock anchor exists before an
// event is live, so through the API nobody is on the board when the flip lands
// — and after it an event admin's row on a switch-OFF event is an ORDINARY
// state (the assign door admits it), where a staff-TAGGED row on one is an
// anomaly (the assign door refuses it), which is what the refusal exists to
// stop producing. The two cache-bust arms below RELY on the exemption for
// their retry loops. A future relaxation of the started lock re-opens the
// question; a change to decision 6 (staff = tag + role at this door) means
// `staffEnrolled` gains the role, that arm is re-pointed, and both bust arms
// remove their event admin before flipping back.
//
// ── EVERY POSITIVE ASSERTION CARRIES A CONTROL ────────────────────────────────
//
// "The flip was refused" is equally satisfied by a build that refuses every PUT;
// "the flag is false" by a build that never stores it. So every refusal test has
// a twin that must SUCCEED in the same shape (a sealed challenge beside the
// unsealed one; ordinary participants beside the staff-tagged one; an upcoming
// event beside the live one), every `competing:true` has a `competing:false`
// row-holder beside it, and the echo test proves the lock is real before proving
// the echo escapes it.
//
// ── FIXTURE TRAPS MET WRITING THIS ────────────────────────────────────────────
//
//  • A staff-TAGGED user cannot be ENROLLED on a switch-OFF event through the
//    assign route (`skippedStaff`). The state "staff-tagged row-holder on a
//    switch-off event" is still reachable — enrol a participant FIRST and then
//    promote them (promotion tags `staff` and leaves the row) — and it is the
//    only shape that gives `competing:false` a row-holding control.
//  • The switch is LOCKED once the event has started, and a board has nobody on
//    it until somebody's solve clock is anchored, which happens only while the
//    event is LIVE. So "a populated board whose switch can still flip" cannot be
//    built through the API at all; the leaderboard-bust arm writes the anchor
//    (`competition_users.login_time`) straight into this worker's database, the
//    shape `answer-seal.api.spec.js` uses for its restore fixture.
//  • `competing:true` on a `_compWire` response is reachable through EXACTLY ONE
//    door, and the first draft of this file called it unreachable: a row-holder
//    on a switch-OFF event is not a competitor (`competitorIn` asks row AND
//    switch), so the PUT that flips that event ON is admitted — and its response
//    is rendered AFTER the write, so `competitorIn` now finds row + switch and
//    reports `competing:true`. Every write of theirs after that is
//    `competitor_cannot_edit`, which is the honesty control beside it. Pinned in
//    the `competing` test, because without it the mutation `actorId: undefined`
//    on the PUT response leaves the file green (both `_compWire` assertions were
//    `toBe(false)`, and the built-in can never hold a row).
//  • The competitor rule binds EVERY tier, so `competing` is driven for three:
//    a promoted regular admin, a promoted USER-BACKED superadmin, and an event
//    admin reading the SCOPED list. Each holds a row on a switch-ON event and on
//    a switch-OFF twin (enrol-then-promote for the tagged tiers), with a no-row
//    switch-ON control, so a tier-specific projection that dropped `actorId`
//    would go red on that tier alone.
//  • `staff_compete_locked:'started'` is derived from the SLOTS on a
//    multi-session event, never from the parent row's `start_time` — a
//    tournament whose parent starts in two hours and whose first session started
//    a minute ago reads 'started' on the list and on `_compWire`, and its flip is
//    refused. Every other fixture here is single-slot, so this is the only arm a
//    parent-row-only regression would fail.
//  • The built-in superadmin has no `users` row, so it can never hold a
//    `competition_users` row and `competing` is false for it everywhere — which
//    is why every "competes" actor here is a promoted participant signed in as
//    themselves, and why ONE built-in session is shared by the whole file (a
//    second `apiLogin("superadmin")` would kick the first).
//  • The me-cache and the leaderboard cache have TTLs of 2 s and 5 s. A bust
//    assertion that lands after the TTL is satisfied by a build with NO bust, so
//    each arm measures its own window and RE-TAKES the sample when the box was
//    too slow (flip back OFF — an untagged event admin's row does not block it —
//    wait for the surface to read OFF again, try again), throwing a named error
//    only when every attempt was slow. Neither arm hard-fails on a slow box,
//    which under WORKERS=18 is the flake the v8.3.31 rule exists to prevent.
//  • "An enrolled row-holder wrote a challenge this event holds" is reachable
//    ONLY through a switch-OFF event: `authorCompetesDenied` is asked at
//    assignment and at enrolment only while the switch is ON, so on an OFF
//    event the author assigns their own challenge freely — which is exactly
//    why the switch is a door for the author rule. `makeEnrolledAuthor` enrols
//    FIRST (a staff-tagged row cannot be written on a switch-OFF event) and
//    promotes second. The challenges are SEALED, or the unsealed refusal
//    answers first and the author arm is about the wrong question.
//  • The unsealed and author refusals can BOTH hold on one event, and the
//    ordering arm drives them as a SEQUENCE (unsealed first; unassign it; the
//    author refusal answers) — a fixture where only one holds cannot tell an
//    ordering from a mask.
//  • The multi-session 'ended' reason is `every`, and the only fixture that
//    separates it from `some` is a MIXED event (one ended session, one
//    upcoming): all-ended and end-now read 'ended' under either predicate. A
//    session may be created already ended (start three hours ago, one hour
//    long) — the create route does not refuse a past start.
//  • The ENDED echo arm sends the switch beside `reveal_answers_on_end`, the
//    one edit a finished event accepts: a rename is refused there by an
//    unrelated rule, so the LIVE echo arm's shape cannot be reused.
//  • The in-transaction re-check of the lock cannot be scheduled from a test
//    (the status is time-derived and the window between the pre-flight and the
//    write is microseconds of synchronous code), so it is pinned at SOURCE — and
//    the arm pins the three things that make it a re-check rather than
//    decoration: the switch's change flag is IN the transaction's guard, a FRESH
//    row is read between the guard and the throw, and the started predicate is
//    asked of that fresh row rather than the pre-await `comp`. Two realistic
//    mutations (the flag dropped from the guard; `comp` in place of `_freshComp`)
//    each left the first draft green, which is why all three are asserted.
//
// ── VERIFIED MUTATIONS (each killing its own arm, in a throwaway copy) ────────
//
//  1. routes/competitions.js PUT response `_compWire(final, { actorId: undefined })`
//     → the flip arm of the `competing` test ("the flip that makes the actor a
//     competitor reports it on the response") goes red; nothing else moves.
//  2. routes/competitions.js editTxn guard without `_staffCompeteChanged`
//     → the source arm's "the switch's change flag is IN the transaction guard".
//  3. routes/competitions.js editTxn `competitionAnySlotStarted(comp)` in place of
//     `competitionAnySlotStarted(_freshComp)` → the source arm's fresh-row assertion.
//  4. routes/competitions.js admin list `staffCompeteFlags(c, { slots, actorId: null })`
//     → the `competing` test AND the tier test (its superadmin assertion fires
//     first; the event-admin one sits behind it in the same body). 2 red, 27 green.
//  5. lib/competitions.js `staffCompeteFlags` reading `anySlotStarted` from
//     `_singleSlotStatus(row)` instead of the slot walk → the multi-session arm
//     (the list assertion fires first; `_compWire` reads the same helper). The
//     PUT half of that arm would stay green on its own — the PUT asks the
//     predicate itself, and the in-txn re-check would catch it regardless.
//  6. routes/competitions.js post-commit `invalidateLeaderboardCache` removed →
//     the board arm alone (measured 14 ms after the flip — the retry loop cannot
//     mask it: a missing bust is a cached OFF board on a FAST sample, which is
//     the failing case, not a slow one); `_invalidateMeCacheForComps` removed →
//     the /api/me arm alone (8 ms).
//  7. routes/competitions.js ended-lock moved BELOW `validate_only` (pre-flight
//     skips a fully-ended event, a LOCKED_ENDED return added after the dry-run
//     return) → the dry-run "ended" arm alone; the real ended test stays green.
//  8. (test-side) `tagStaff` silently no-ops for the direction-control fixture →
//     "precondition: the tag landed", i.e. the arm fails AS a precondition rather
//     than passing because nobody was enrolled to ignore.
//  9. routes/competitions.js admin list `staffCompeteFlags(c, { slots: [], … })`
//     → the multi-session arm's list assertion (the other shape of mutation 5).
// 10. routes/competitions.js the whole `_authors` block deleted (the ON
//     direction asks only the unsealed question) → the enrolled-author arm
//     (200 where 400 was expected), the second half of the ordering arm, the
//     dry-run's enrolled-author row — AND the source arm's anti-vacuity floor,
//     because the deleted block was one of the four table references.
// 11. routes/competitions.js `_unsealed` and `_authors` blocks SWAPPED → the
//     ordering arm alone (`staff_compete_enrolled_authors` answers first).
// 12. lib/staff-compete.js `enrolledAuthors`' reduce replaced by a `.map` (one
//     entry per task) → the enrolled-author arm, the column-0 `enrolledAuthors`
//     arm, and the ordering arm's precondition (which asks the predicate
//     directly). Nothing else moves.
// 13. routes/competitions.js `_authors` block moved BELOW the `validate_only`
//     return → the dry-run's enrolled-author row alone; the real refusal stays
//     green.
// 14. routes/competitions.js `_staffCompeteChanged = staff_compete !== undefined`
//     (an echo is a change) → the LIVE echo arm AND the ENDED echo arm; the
//     ended one is the arm that pins the post-end path a human takes (the
//     reveal toggle), which the live arm's rename cannot reach.
// 15. lib/competitions.js `staffCompeteFlags` feeding `switchLock`
//     `fullyEnded: competitionAnySlotEnded(row)` (`some`) → the multi-session
//     ENDED arm alone (the mixed event reads 'ended' where 'started' is right).
// 16. routes/competitions.js `_competitorRefused` moved BELOW the `validate_only`
//     return → the competitor dry-run assertion in the `competing` test
//     (200 `validated:true` where 403 was expected); the REAL rename is still
//     refused, which is why the dry-run assertion is not redundant with the
//     honesty control beside it.
// 17. routes/competitions.js `UPDATE competitions SET staff_compete=0` added
//     inside `if (_kindChanging)` → the kind-change arm alone.
// 18. routes/competitions.js `code: STAFF_COMPETE_CODES.STAFF_ENROLLED` re-spelled
//     as the literal `"staff_compete_enrolled_staf"` (a typo) → the four
//     behavioural STAFF_ENROLLED arms AND the source arm.
// 19. …the same re-spelled as the CORRECT literal `"staff_compete_enrolled_staff"`
//     → the source arm ALONE, every behavioural arm green — which is the class
//     the old "code table" test could not see and this arm exists for.
// 20. lib/staff-compete.js `enrolledAuthors` ORDER BY dropped → the column-0
//     arm's SOURCE assertion alone, deterministically. The two wire arms that
//     assert "tasks by title" are PROBABILISTIC against this mutation (the join
//     then follows the competition_tasks PK, a UUID — measured 6 of 12 green),
//     which is why the source pin exists rather than a larger fixture.
const { test, expect, request } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin, eventCopyOf } = require("./event-admin-helpers");
// PURE at module scope (requires nothing; the one helper that reaches the
// database requires it lazily inside its body), so column 0 is the documented
// safe form and the v7.20.2 scanner is right not to flag it.
const staffCompete = require("../lib/staff-compete");

const iso = ms => new Date(Date.now() + ms).toISOString();
const MIN = 60_000, HOUR = 3600_000;

// better-sqlite3 is opened INSIDE the callback, never at module scope: per-file
// isolation recreates the database in a `beforeAll`, so a handle taken at
// require time reads the previous file's unlinked inode (v7.20.2).
function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}

let sa, saCsrf;
/** Every context this file opens, disposed in afterAll. */
const _ctxs = [];

/** Promote a fresh participant to `role` (admin | superadmin) and sign in as them. */
async function makeTier(label, role) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  _ctxs.push(api);
  return { ...p, api, csrf, role };
}

/** Sign a made participant in as themselves. */
async function loginAs(p) {
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  _ctxs.push(api);
  return { api, csrf };
}

/**
 * An ENROLLED AUTHOR: a participant enrolled on every `compIds` FIRST (a
 * staff-tagged row cannot be written on a switch-OFF event through the assign
 * door), then promoted to admin (which tags them staff and leaves the rows),
 * then signed in as themselves so the challenges they create carry their
 * `created_by_id`. The one shape that reaches "an enrolled row-holder wrote a
 * challenge this event holds" — the state the switch's third refusal names.
 */
async function makeEnrolledAuthor(label, compIds) {
  const p = await makeParticipant(sa, saCsrf, label);
  for (const cid of compIds) await enrol(sa, saCsrf, cid, [p.id]);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label} to admin: ${r.status()} ${await r.text()}`).toBeTruthy();
  const rows = withDb(db => db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(p.id)).map(x => x.competition_id).sort();
  expect(rows, `${label}: the promotion left every row in place`).toEqual([...compIds].sort());
  const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
  _ctxs.push(api);
  return { ...p, api, csrf };
}

/** Add a session to a competition; returns the created timeslot row. */
async function addSession(compId, label, startMs, durationMin = 60) {
  const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
    headers: H(saCsrf), data: { name: `${label} ${uniq("s")}`, start_time: iso(startMs), duration_minutes: durationMin },
  });
  expect(r.ok(), `add session ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).timeslot;
}

/** Give a participant the `staff` TAG without any role change. */
async function tagStaff(p) {
  const r = await sa.post(`/api/admin/participants/${p.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
  expect(r.ok(), `tag ${p.email} staff: ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** The competition's row on the admin list, as seen by `api` (default: the built-in). */
async function listRow(compId, api = sa) {
  const r = await api.get("/api/admin/competitions");
  expect(r.ok(), `admin list: ${r.status()}`).toBeTruthy();
  const rows = await r.json();
  const row = rows.find(c => c.id === compId);
  expect(row, `competition ${compId} must be on the admin list`).toBeTruthy();
  return row;
}

/** The parsed details of every event of one type on a competition's history. */
async function eventsOf(compId, type) {
  const r = await sa.get(`/api/admin/competitions/${compId}/events`);
  expect(r.ok(), `events: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  const list = body.events || body;
  return list.filter(e => e.event_type === type)
    .map(e => (typeof e.details === "string" ? JSON.parse(e.details) : e.details) || {});
}

/** PUT the switch (plus anything else) on a competition, as `api` (default: the built-in). */
async function putSwitch(compId, data, api = sa, csrf = saCsrf) {
  return api.put(`/api/admin/competitions/${compId}`, { headers: H(csrf), data });
}

/** Assert a PUT was refused with exactly this code and a readable reason. */
async function expectSwitchRefused(res, code, what) {
  expect(res.status(), `${what}: expected 400, got ${res.status()} ${await res.text().catch(() => "")}`).toBe(400);
  const b = await res.json();
  expect(b.code, `${what}: machine code`).toBe(code);
  expect(String(b.error || "").length, `${what}: states a reason`).toBeGreaterThan(20);
  return b;
}

/**
 * The STORED flag as it rides the admin `_compWire` / list payloads and the
 * participant list: the raw INTEGER column (0/1), exactly as every sibling flag
 * (`reveal_answers_on_end`, `cxone_disabled`, `late_entry_enabled`) has always
 * ridden them, and what the client reads truthily. The two surfaces that
 * COERCE (`!!`) — the export and the public preview — are asserted strictly
 * boolean instead. Anything outside {0, 1, true, false} — a string, `null` from
 * a row that never bound it, `undefined` from a projection that dropped it — is
 * a defect, and is named rather than folded into "falsy".
 */
function asFlag(v, what) {
  expect([0, 1, true, false].includes(v), `${what}: expected the stored flag as 0/1 (or a boolean), got ${JSON.stringify(v)}`).toBe(true);
  return !!v;
}

/** A live 10-hour tournament by default; `extra` overrides (kind, times, flags). */
const mkComp = (label, extra = {}) => makeCompetition(sa, saCsrf, label, extra);
/** The three schedule shapes the lock is asked about. */
const UPCOMING = () => ({ start_time: iso(+2 * HOUR), duration_minutes: 120 });
const LIVE     = () => ({ start_time: iso(-1 * MIN),  duration_minutes: 600 });
const EXPIRED  = () => ({ start_time: iso(-3 * HOUR), duration_minutes: 60 });

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
});

test.afterAll(async () => {
  for (const c of _ctxs) await c.dispose().catch(() => {});
  await sa?.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — CREATE binds the switch explicitly, for every kind", () => {

  /** The per-kind body that makes a valid UPCOMING event. */
  const kindBody = kind => {
    if (kind === "program") return { event_kind: "program", timezone: "UTC", start_time: iso(+1 * HOUR), deadline_at: iso(+30 * 24 * HOUR) };
    return { event_kind: kind, timezone: "UTC", ...UPCOMING() };
  };

  for (const kind of ["booth", "tournament", "program"]) {
    test(`${kind}: true / false / ABSENT store 1 / 0 / 0, and the created audit says which`, async () => {
      const cases = [
        { label: "on",     body: { staff_compete: true },  want: true },
        { label: "off",    body: { staff_compete: false }, want: false },
        // ABSENT is the case that matters: the column is NOT NULL DEFAULT 0, so a
        // create that forgot to bind it would still insert — a build that bound
        // `undefined` would 500, and one that bound `null` would refuse — but the
        // wire and the audit must read 0, not a missing key.
        { label: "absent", body: {},                       want: false },
      ];
      for (const c of cases) {
        const name = `SC create ${kind} ${c.label} ${uniq("k")}`;
        const r = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name, ...kindBody(kind), ...c.body } });
        expect(r.ok(), `create ${kind}/${c.label}: ${r.status()} ${await r.text()}`).toBeTruthy();
        const created = (await r.json()).competition;
        expect(created.id, "create returns the row").toBeTruthy();
        // (a) the create response is a `_compWire` attach point
        expect(asFlag(created.staff_compete, `${kind}/${c.label}: create response`), `${kind}/${c.label}: create response carries the switch`).toBe(c.want);
        expect(created.staff_compete_locked, `${kind}/${c.label}: an upcoming event's switch is changeable`).toBeNull();
        expect(created.competing, `${kind}/${c.label}: the built-in superadmin competes nowhere`).toBe(false);
        // (b) the admin list — the surface the edit form renders from, which does
        //     NOT pass through `_compWire`
        const row = await listRow(created.id);
        expect(row.staff_compete, `${kind}/${c.label}: admin list carries the switch`).toBe(c.want ? 1 : 0);
        expect(row.staff_compete_locked, `${kind}/${c.label}: admin list lock`).toBeNull();
        expect(row.competing, `${kind}/${c.label}: admin list competing`).toBe(false);
        // (c) the stored column, read raw — the two surfaces above could agree on
        //     a value neither stored
        const stored = withDb(db => db.prepare("SELECT staff_compete FROM competitions WHERE id=?").get(created.id));
        expect(stored.staff_compete, `${kind}/${c.label}: the STORED column`).toBe(c.want ? 1 : 0);
        // (d) the `created` audit records the decision, as a boolean
        const [cd] = await eventsOf(created.id, "created");
        expect(cd, "the create event exists").toBeTruthy();
        expect("staff_compete" in cd, `${kind}/${c.label}: created audit CARRIES the key`).toBe(true);
        expect(cd.staff_compete, `${kind}/${c.label}: created audit value`).toBe(c.want);
        expect(cd.event_kind, "the kind under test really is the kind stored").toBe(kind);
      }
    });
  }

  test("the switch is a REAL boolean at the boundary: the string 'false' stores 0, not 1", async () => {
    // F2 (batch 7): a `? 1 : 0` over a raw body would turn the STRING "false"
    // into 1 and switch the feature ON for an operator who said no. The bool
    // rule coerces both spellings; an ambiguous value is refused.
    const off = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `SC strfalse ${uniq("k")}`, ...UPCOMING(), staff_compete: "false" } });
    expect(off.ok(), `create with "false": ${off.status()} ${await off.text()}`).toBeTruthy();
    expect(asFlag((await off.json()).competition.staff_compete, '"false"'), 'the string "false" is OFF').toBe(false);
    const on = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `SC strtrue ${uniq("k")}`, ...UPCOMING(), staff_compete: "true" } });
    expect(on.ok(), `create with "true": ${on.status()} ${await on.text()}`).toBeTruthy();
    expect(asFlag((await on.json()).competition.staff_compete, '"true"'), 'the string "true" is ON').toBe(true);
    const junk = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: { name: `SC strjunk ${uniq("k")}`, ...UPCOMING(), staff_compete: "maybe" } });
    expect(junk.status(), "an ambiguous value is refused rather than guessed at").toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — the wire: staff_compete_locked and competing", () => {

  test("staff_compete_locked is null upcoming, 'started' live, 'ended' after end-now AND on a time-expired event — on the list and on _compWire", async () => {
    const up   = await mkComp("lock-up",   UPCOMING());
    const live = await mkComp("lock-live", LIVE());
    const exp  = await mkComp("lock-exp",  EXPIRED());
    const toEnd = await mkComp("lock-endnow", LIVE());

    // The LIST — the surface the edit form withholds the control from.
    expect((await listRow(up.id)).staff_compete_locked, "upcoming: changeable").toBeNull();
    expect((await listRow(live.id)).staff_compete_locked, "live: started").toBe("started");
    expect((await listRow(exp.id)).staff_compete_locked, "time-expired (ended_at NULL): ended").toBe("ended");

    // `_compWire` on a PUT response — a NAME edit, which touches nothing the
    // lock reads, so the flag on the response is a pure read of the state.
    const putUp = await putSwitch(up.id, { name: `${up.name} r` });
    expect(putUp.ok(), `rename upcoming: ${await putUp.text()}`).toBeTruthy();
    expect((await putUp.json()).competition.staff_compete_locked, "_compWire, upcoming").toBeNull();
    const putLive = await putSwitch(live.id, { name: `${live.name} r` });
    expect(putLive.ok(), `rename live: ${await putLive.text()}`).toBeTruthy();
    expect((await putLive.json()).competition.staff_compete_locked, "_compWire, live").toBe("started");

    // END NOW — the manual end stamps `ended_at`, and `competitionFullyEnded`
    // answers on that stamp BEFORE the inclusive-end arithmetic that can read
    // the same millisecond as "live" (the v7.21.9 trap), so the end-now
    // response itself must already say 'ended'.
    const en = await sa.post(`/api/admin/competitions/${toEnd.id}/end-now`, { headers: H(saCsrf) });
    expect(en.ok(), `end-now: ${en.status()} ${await en.text()}`).toBeTruthy();
    expect((await en.json()).competition.staff_compete_locked, "_compWire on the end-now response").toBe("ended");
    expect((await listRow(toEnd.id)).staff_compete_locked, "the list after end-now").toBe("ended");

    // CONTROL for 'ended' being the ENDED reason and not merely "started": the
    // two are different strings, asserted above; the three values are exhaustive.
    const seen = new Set([
      (await listRow(up.id)).staff_compete_locked,
      (await listRow(live.id)).staff_compete_locked,
      (await listRow(exp.id)).staff_compete_locked,
    ]);
    expect([...seen].sort(), "all three lock states are reachable and distinct").toEqual([null, "ended", "started"].sort());
  });

  test("competing: true for a user-backed admin holding a row on a switch-ON event; false with a row on a switch-OFF event; false with no row; false for the built-in", async () => {
    // A ROW-HOLDER ON A SWITCH-OFF EVENT is the control that matters, and the
    // assign route refuses to create it for a staff-tagged user — so the row is
    // written while they are still a participant and the promotion follows.
    const offComp = await mkComp("competing-off", { ...UPCOMING(), staff_compete: false });
    const onComp  = await mkComp("competing-on",  { ...UPCOMING(), staff_compete: true });
    const noRow   = await mkComp("competing-norow", { ...UPCOMING(), staff_compete: true });
    const p = await makeParticipant(sa, saCsrf, "competing-admin");
    await enrol(sa, saCsrf, offComp.id, [p.id]);
    const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(r.ok(), `promote: ${r.status()} ${await r.text()}`).toBeTruthy();
    // Now staff-tagged: the row on the switch-ON event is written by the
    // built-in superadmin, which the assign route admits for a privileged target.
    await enrol(sa, saCsrf, onComp.id, [p.id]);
    // Preconditions asserted, not assumed: a lost row makes every assertion below vacuous.
    const rows = withDb(db => db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(p.id)).map(x => x.competition_id).sort();
    expect(rows, "the admin holds exactly the two rows").toEqual([offComp.id, onComp.id].sort());
    const tags = withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(p.id)).map(x => x.tag);
    expect(tags, "promotion tagged them staff").toContain("staff");

    // ONE login: a second `apiLogin` for the same user would kick the first
    // (single session per user), and the PUT below needs this session's CSRF.
    const { api, csrf } = await loginAs(p);
    // The admin LIST, as the row-holder
    expect((await listRow(onComp.id, api)).competing,  "row + switch ON → competing").toBe(true);
    expect((await listRow(offComp.id, api)).competing, "row + switch OFF → NOT competing (the control)").toBe(false);
    expect((await listRow(noRow.id, api)).competing,   "switch ON + no row → NOT competing (the other control)").toBe(false);
    expect((await listRow(onComp.id, api)).staff_compete, "the switch itself is still reported").toBe(1);
    // …and as the built-in superadmin, on the identical rows
    expect((await listRow(onComp.id)).competing, "the built-in superadmin holds no users row and competes nowhere").toBe(false);
    expect((await listRow(offComp.id)).competing).toBe(false);

    // `_compWire`, the FALSE branch: a rename by the row-holder on the switch-OFF
    // event touches nothing the flag reads, and lands (they are not a competitor
    // there — the row alone does not make one).
    const put = await putSwitch(offComp.id, { name: `${offComp.name} r` }, api, csrf);
    expect(put.ok(), `row-holder renames the switch-off event: ${put.status()} ${await put.text()}`).toBeTruthy();
    expect((await put.json()).competition.competing, "_compWire: a row on a switch-OFF event is not competing").toBe(false);

    // `_compWire`, the TRUE branch — the ONE door that reaches it. The same
    // row-holder flips the switch-OFF event ON: the competitor door asks
    // `competitorIn` (row AND switch) while the switch is still off, so the PUT
    // is admitted; 0→1 asks the seal question (nothing assigned) and not the
    // staff question; the write lands; and the response is rendered from the
    // row AFTER the write, so `competitorIn` now finds row + switch. A build
    // whose PUT response forgot `actorId` answers `false` here and nowhere else
    // this file can see.
    const flip = await putSwitch(offComp.id, { staff_compete: true }, api, csrf);
    expect(flip.ok(), `the row-holder flips their switch-off event ON: ${flip.status()} ${await flip.text()}`).toBeTruthy();
    const flipBody = await flip.json();
    expect(asFlag(flipBody.competition.staff_compete, "flip response"), "the flip landed").toBe(true);
    expect(flipBody.competition.competing, "_compWire: the flip that makes the actor a competitor reports it on the response").toBe(true);
    expect((await listRow(offComp.id, api)).competing, "…and the list agrees the next moment").toBe(true);
    // HONESTY CONTROL: they are a competitor NOW, so their next write to that
    // event — the identical rename that landed above — is refused by code. Without
    // this, `competing:true` is equally satisfied by a build that reports it and
    // enforces nothing.
    const locked = await putSwitch(offComp.id, { name: `${offComp.name} rr` }, api, csrf);
    expect(locked.status(), `a competitor's rename is refused: ${locked.status()} ${await locked.text().catch(() => "")}`).toBe(403);
    expect((await locked.json()).code, "…with the competitor code").toBe(staffCompete.CODES.COMPETITOR_EDIT);
    // …and the ORDER holds for a DRY RUN too: the competitor gate is the FIRST
    // statement of the PUT, hundreds of lines above the `validate_only` return,
    // so a competitor's pre-flight (the client's v8.8.25 dry run) hears the
    // same code rather than `validated:true` about a save it cannot make. The
    // built-in's dry run on the SAME event validates (control), so the refusal
    // is about the actor, not about dry runs having stopped working.
    const dryLocked = await putSwitch(offComp.id, { name: `${offComp.name} dry`, validate_only: true }, api, csrf);
    expect(dryLocked.status(), `a competitor's DRY RUN is refused: ${dryLocked.status()} ${await dryLocked.text().catch(() => "")}`).toBe(403);
    const dryLockedBody = await dryLocked.json();
    expect(dryLockedBody.code, "…with the competitor code, ABOVE validate_only").toBe(staffCompete.CODES.COMPETITOR_EDIT);
    expect("validated" in dryLockedBody, "a refused dry run does not also claim to have validated").toBe(false);
    const dryOk = await putSwitch(offComp.id, { name: `${offComp.name} dry`, validate_only: true });
    expect(dryOk.ok(), `the built-in's dry run on the same event: ${dryOk.status()} ${await dryOk.text()}`).toBeTruthy();
    expect((await dryOk.json()).validated, "…validates (control)").toBe(true);
    expect((await listRow(offComp.id)).name, "neither dry run renamed anything").toBe(`${offComp.name} r`);
    // …and the built-in superadmin, who holds no row, still edits it and reads
    // `competing:false` on the SAME row — so the refusal above is about the
    // actor, not about the event having become read-only.
    const saPut = await putSwitch(offComp.id, { name: `${offComp.name} sa` });
    expect(saPut.ok(), `the built-in renames the same event: ${saPut.status()} ${await saPut.text()}`).toBeTruthy();
    expect((await saPut.json()).competition.competing, "_compWire for the built-in on the now-ON event: no row, not competing").toBe(false);
  });

  test("competing binds EVERY tier: a user-backed SUPERADMIN and an EVENT ADMIN (on the scoped list) each read true with a row on a switch-ON event, false on the switch-OFF twin, false with no row", async () => {
    // The event-admin tier reads the list through `_listScope` — a scoped
    // SELECT — and an organiser who holds a row on the event they organise is
    // the tier most likely to meet `competing:true` in practice. `actorId(req)`
    // is tier-blind today; this arm is what notices a tier-specific projection
    // (the scoped branch spreading the flags without an actor) the moment one
    // is written.
    //
    // ── superadmin, enrol-then-promote like the admin above ──
    const onSa  = await mkComp("tier-sa-on",    { ...UPCOMING(), staff_compete: true });
    const offSa = await mkComp("tier-sa-off",   { ...UPCOMING(), staff_compete: false });
    const noRowSa = await mkComp("tier-sa-norow", { ...UPCOMING(), staff_compete: true });
    const s = await makeParticipant(sa, saCsrf, "tier-sa");
    await enrol(sa, saCsrf, offSa.id, [s.id]);
    const promote = await sa.post(`/api/admin/participants/${s.id}/role`, { headers: H(saCsrf), data: { role: "superadmin" } });
    expect(promote.ok(), `promote to superadmin: ${promote.status()} ${await promote.text()}`).toBeTruthy();
    expect(withDb(db => db.prepare("SELECT role FROM users WHERE id=?").get(s.id)).role, "precondition: the role landed").toBe("superadmin");
    // A privileged target on a compete event is admitted by a SUPERADMIN actor
    // (the built-in is one); the assign door's `skippedPrivileged` is for a
    // regular-admin actor, so `enrol`'s count assertion is the precondition.
    await enrol(sa, saCsrf, onSa.id, [s.id]);
    const saRows = withDb(db => db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(s.id)).map(x => x.competition_id).sort();
    expect(saRows, "the superadmin holds exactly the two rows").toEqual([onSa.id, offSa.id].sort());
    const saUser = await loginAs(s);
    const meSa = await (await saUser.api.get("/api/admin/me")).json();
    expect(meSa.isSuperAdmin, "precondition: signed in as a user-backed superadmin").toBe(true);
    expect((await listRow(onSa.id, saUser.api)).competing,    "superadmin: row + switch ON → competing").toBe(true);
    expect((await listRow(offSa.id, saUser.api)).competing,   "superadmin: row + switch OFF → not competing (control)").toBe(false);
    expect((await listRow(noRowSa.id, saUser.api)).competing, "superadmin: switch ON + no row → not competing (control)").toBe(false);
    expect((await listRow(onSa.id)).competing, "the built-in on the same row: no users row, not competing").toBe(false);

    // ── event admin: granted on all three (so the SCOPED list carries them), enrolled on two ──
    const onEa  = await mkComp("tier-ea-on",    { ...UPCOMING(), staff_compete: true });
    const offEa = await mkComp("tier-ea-off",   { ...UPCOMING(), staff_compete: false });
    const noRowEa = await mkComp("tier-ea-norow", { ...UPCOMING(), staff_compete: true });
    const ea = await makeParticipant(sa, saCsrf, "tier-ea");
    for (const c of [onEa, offEa, noRowEa]) await grantEventAdmin(sa, saCsrf, c.id, ea.id);
    expect(withDb(db => db.prepare("SELECT role FROM users WHERE id=?").get(ea.id)).role, "precondition: the grant made them an event admin").toBe("event_admin");
    // An event admin is untagged, so the assign door admits them on BOTH
    // switches — no enrol-then-promote dance needed, but the grant must precede
    // the login (a grant purges sessions).
    await enrol(sa, saCsrf, onEa.id, [ea.id]);
    await enrol(sa, saCsrf, offEa.id, [ea.id]);
    const eaUser = await loginAs(ea);
    const meEa = await (await eaUser.api.get("/api/admin/me")).json();
    expect(meEa.isEventAdmin, "precondition: signed in as an event admin").toBe(true);
    expect(meEa.eventAdminCompetitionCount, "…organising exactly the three").toBe(3);
    const eaList = await (await eaUser.api.get("/api/admin/competitions")).json();
    expect(eaList.map(c => c.id).sort(), "the SCOPED list carries exactly their three events").toEqual([onEa.id, offEa.id, noRowEa.id].sort());
    expect((await listRow(onEa.id, eaUser.api)).competing,    "event admin: row + switch ON → competing").toBe(true);
    expect((await listRow(offEa.id, eaUser.api)).competing,   "event admin: row + switch OFF → not competing (control)").toBe(false);
    expect((await listRow(noRowEa.id, eaUser.api)).competing, "event admin: switch ON + no row → not competing (control)").toBe(false);
    expect(asFlag((await listRow(onEa.id, eaUser.api)).staff_compete, "scoped list row"), "the scoped list still carries the switch").toBe(true);
  });

  test("staff_compete_locked reads 'started' from the SLOTS of a multi-session event whose PARENT has not started — list, _compWire and the PUT agree; an all-upcoming multi-session twin stays changeable (control)", async () => {
    // `competitionAnySlotStarted(row, slots)` is `slots.some(started)` whenever
    // slots exist, whatever the parent's `start_time` says. A regression that
    // read the parent row alone (or the list passing the wrong batched `slots`)
    // would report a tournament with a future start and one STARTED session as
    // null — and the switch would flip mid-session.
    const parentFuture = { start_time: iso(+2 * HOUR), duration_minutes: 120, event_kind: "tournament" };
    const started = await mkComp("multi-started", parentFuture);
    const allUp   = await mkComp("multi-upcoming", parentFuture);
    const s1 = await addSession(started.id, "S1", -1 * MIN);
    const s2 = await addSession(allUp.id,   "S1", +1 * HOUR);
    expect(s1.status, "precondition: the session on the started twin is LIVE").toBe("live");
    expect(s2.status, "precondition: the session on the control twin is UPCOMING").toBe("upcoming");
    // The parent rows are byte-identical in schedule; only the sessions differ.
    const parents = withDb(db => [started.id, allUp.id].map(id => db.prepare("SELECT start_time FROM competitions WHERE id=?").get(id).start_time));
    expect(parents[0], "precondition: both parents share the future start_time").toBe(parents[1]);
    expect(new Date(parents[0]).getTime(), "…which is in the future").toBeGreaterThan(Date.now());

    // The LIST (batched slots)
    const rowStarted = await listRow(started.id);
    expect(rowStarted.timeslots.length, "precondition: the list sees the session").toBe(1);
    expect(rowStarted.staff_compete_locked, "list: a started SESSION locks the switch though the parent has not started").toBe("started");
    expect((await listRow(allUp.id)).staff_compete_locked, "list: an all-upcoming multi-session event is changeable (control)").toBeNull();
    // `_compWire` on a rename (fetches the slots itself)
    const put = await putSwitch(started.id, { name: `${started.name} r` });
    expect(put.ok(), `rename the multi-session event: ${put.status()} ${await put.text()}`).toBeTruthy();
    expect((await put.json()).competition.staff_compete_locked, "_compWire: started").toBe("started");
    // The PUT refuses with the STARTED code — not ended, not null.
    const b = await expectSwitchRefused(await putSwitch(started.id, { staff_compete: true }), staffCompete.CODES.LOCKED, "multi-session, session started");
    expect(b.code).not.toBe(staffCompete.CODES.LOCKED_ENDED);
    expect((await listRow(started.id)).staff_compete, "nothing written").toBe(0);
    // CONTROL: the twin whose only session is upcoming flips.
    const ok = await putSwitch(allUp.id, { staff_compete: true });
    expect(ok.ok(), `all-upcoming multi-session event flips: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await listRow(allUp.id)).staff_compete).toBe(1);
  });

  test("the multi-session ENDED reason is `every`, not `some`: one ended session beside an upcoming one is 'started'; every session ended is 'ended'; end-now with an upcoming session left is 'ended' — list, _compWire and the PUT code agree", async () => {
    // `staffCompeteFlags` feeds `switchLock` `competitionFullyEnded(row, slots)`,
    // which is `slots.every(ended)`. A regression that handed it the `some`
    // predicate (`competitionAnySlotEnded`) would call an event whose SECOND
    // session has not started "ended" — and refuse the flip with the ended
    // words, which say the standings are final while a cohort is still to
    // come. The MIXED event is the control that separates the two predicates:
    // every other multi-session shape here reads the same under either.
    const parentFuture = { start_time: iso(+2 * HOUR), duration_minutes: 120, event_kind: "tournament" };
    const mixed  = await mkComp("multi-mixed",    parentFuture);
    const allEnd = await mkComp("multi-allended", parentFuture);
    const toEnd  = await mkComp("multi-endnow",   parentFuture);
    // mixed: one session ENDED (started three hours ago, ran an hour), one UPCOMING.
    const mA = await addSession(mixed.id,  "ended",    -3 * HOUR);
    const mB = await addSession(mixed.id,  "upcoming", +1 * HOUR);
    // all-ended: two sessions, both over, `ended_at` NULL on every row (time-derived).
    const eA = await addSession(allEnd.id, "ended-1",  -3 * HOUR);
    const eB = await addSession(allEnd.id, "ended-2",  -2 * HOUR);
    // end-now: one LIVE session and one UPCOMING, then the manual end.
    const nA = await addSession(toEnd.id,  "live",     -1 * MIN);
    const nB = await addSession(toEnd.id,  "upcoming", +1 * HOUR);
    expect([mA.status, mB.status], "precondition: mixed = ended + upcoming").toEqual(["ended", "upcoming"]);
    expect([eA.status, eB.status], "precondition: all-ended = ended + ended").toEqual(["ended", "ended"]);
    expect([nA.status, nB.status], "precondition: end-now fixture = live + upcoming").toEqual(["live", "upcoming"]);
    expect(withDb(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(allEnd.id)).ended_at, "precondition: the all-ended parent carries no ended_at stamp").toBeNull();

    // ── mixed → 'started' (every ≠ some) ──
    const mixedRow = await listRow(mixed.id);
    expect(mixedRow.timeslots.length, "precondition: the list sees both sessions").toBe(2);
    expect(mixedRow.staff_compete_locked, "list: one ended session beside an upcoming one is STARTED, not ended").toBe("started");
    // A rename is admitted on a live multi-session event, so `_compWire` is readable here.
    const putMixed = await putSwitch(mixed.id, { name: `${mixed.name} r` });
    expect(putMixed.ok(), `rename the mixed event: ${putMixed.status()} ${await putMixed.text()}`).toBeTruthy();
    expect((await putMixed.json()).competition.staff_compete_locked, "_compWire: started").toBe("started");
    const bMixed = await expectSwitchRefused(await putSwitch(mixed.id, { staff_compete: true }), staffCompete.CODES.LOCKED, "mixed multi-session flip");
    expect(bMixed.code, "the STARTED code — a second cohort is still to come").not.toBe(staffCompete.CODES.LOCKED_ENDED);

    // ── all ended → 'ended' (a rename is refused on an ended event, so the list and the PUT code carry this one) ──
    expect((await listRow(allEnd.id)).staff_compete_locked, "list: every session over → ENDED").toBe("ended");
    const bAll = await expectSwitchRefused(await putSwitch(allEnd.id, { staff_compete: true }), staffCompete.CODES.LOCKED_ENDED, "all-ended multi-session flip");
    expect(bAll.code).not.toBe(staffCompete.CODES.LOCKED);

    // ── end-now with an upcoming session left → 'ended' on the end-now response itself ──
    expect((await listRow(toEnd.id)).staff_compete_locked, "precondition: before end-now the live session reads started").toBe("started");
    const en = await sa.post(`/api/admin/competitions/${toEnd.id}/end-now`, { headers: H(saCsrf) });
    expect(en.ok(), `end-now on the multi-session event: ${en.status()} ${await en.text()}`).toBeTruthy();
    expect((await en.json()).competition.staff_compete_locked, "_compWire on the end-now response: the manual end wins over the upcoming session").toBe("ended");
    expect((await listRow(toEnd.id)).staff_compete_locked, "the list after end-now").toBe("ended");
    const bEnd = await expectSwitchRefused(await putSwitch(toEnd.id, { staff_compete: true }), staffCompete.CODES.LOCKED_ENDED, "end-now multi-session flip");
    expect(bEnd.code).not.toBe(staffCompete.CODES.LOCKED);
    for (const c of [mixed, allEnd, toEnd]) expect((await listRow(c.id)).staff_compete, `${c.name}: nothing written`).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — the PUT: flips, echoes and the lock", () => {

  test("0→1 then 1→0 on an UPCOMING event succeed, and the edited ladder records changes.staff_compete {from,to} both ways", async () => {
    const comp = await mkComp("flip", UPCOMING());
    expect((await listRow(comp.id)).staff_compete, "starts OFF").toBe(0);

    const on = await putSwitch(comp.id, { staff_compete: true });
    expect(on.ok(), `0→1: ${on.status()} ${await on.text()}`).toBeTruthy();
    const onBody = await on.json();
    expect(asFlag(onBody.competition.staff_compete, "0→1 PUT response"), "the PUT response carries the new value").toBe(true);
    expect((await listRow(comp.id)).staff_compete, "the list agrees").toBe(1);
    expect(withDb(db => db.prepare("SELECT staff_compete FROM competitions WHERE id=?").get(comp.id)).staff_compete, "the column agrees").toBe(1);

    let edits = await eventsOf(comp.id, "edited");
    expect(edits.length, "one edited event so far").toBe(1);
    expect(edits[0].changes && edits[0].changes.staff_compete, "the ladder records the flip as {from,to}").toEqual({ from: false, to: true });

    const off = await putSwitch(comp.id, { staff_compete: false });
    expect(off.ok(), `1→0: ${off.status()} ${await off.text()}`).toBeTruthy();
    expect(asFlag((await off.json()).competition.staff_compete, "1→0 PUT response"), "the PUT response carries the new value").toBe(false);
    expect((await listRow(comp.id)).staff_compete, "back OFF").toBe(0);

    edits = await eventsOf(comp.id, "edited");
    expect(edits.length, "two edited events now").toBe(2);
    // Newest first on the wire; assert by content rather than by position.
    const flips = edits.map(e => e.changes && e.changes.staff_compete).filter(Boolean);
    expect(flips, "both directions are recorded, as booleans").toEqual(expect.arrayContaining([{ from: false, to: true }, { from: true, to: false }]));
    expect(flips.length).toBe(2);
  });

  test("a flip carrying expectedUpdatedAt honours optimistic concurrency like any other edit", async () => {
    // Not a staff-compete rule — a check that the switch is an ordinary column of
    // the row, so a stale form is refused rather than silently flipping it.
    const comp = await mkComp("flip-cas", UPCOMING());
    const row = await listRow(comp.id);
    const ok = await putSwitch(comp.id, { staff_compete: true, expectedUpdatedAt: row.updated_at });
    expect(ok.ok(), `fresh token: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    const stale = await putSwitch(comp.id, { staff_compete: false, expectedUpdatedAt: row.updated_at });
    expect(stale.status(), "the SAME token again is stale — the first flip bumped updated_at").toBe(409);
    expect((await listRow(comp.id)).staff_compete, "the stale write changed nothing").toBe(1);
  });

  test("ECHOING the stored value on a STARTED event is not a change and is not refused — and the lock is real (control)", async () => {
    const liveOn  = await mkComp("echo-on",  { ...LIVE(), staff_compete: true });
    const liveOff = await mkComp("echo-off", { ...LIVE(), staff_compete: false });
    expect((await listRow(liveOn.id)).staff_compete_locked, "precondition: the event has started").toBe("started");

    // CONTROL FIRST: a genuine change on the same rows IS refused — without this,
    // "the echo passed" is equally true of a build with no lock at all.
    await expectSwitchRefused(await putSwitch(liveOn.id,  { staff_compete: false }), staffCompete.CODES.LOCKED, "live ON → OFF");
    await expectSwitchRefused(await putSwitch(liveOff.id, { staff_compete: true }),  staffCompete.CODES.LOCKED, "live OFF → ON");

    // The echoes — the shape a client round-tripping the whole row sends.
    const e1 = await putSwitch(liveOn.id, { staff_compete: true, name: `${liveOn.name} r` });
    expect(e1.ok(), `echo true on a live ON event: ${e1.status()} ${await e1.text()}`).toBeTruthy();
    expect(asFlag((await e1.json()).competition.staff_compete, "echo ON response"), "still ON").toBe(true);
    const e2 = await putSwitch(liveOff.id, { staff_compete: false, name: `${liveOff.name} r` });
    expect(e2.ok(), `echo false on a live OFF event: ${e2.status()} ${await e2.text()}`).toBeTruthy();
    expect(asFlag((await e2.json()).competition.staff_compete, "echo OFF response"), "still OFF").toBe(false);
    // An echo is NOT a change, so the ladder must not record one — the rename is
    // there, so the edit event exists; the switch key must be absent from it.
    for (const c of [liveOn, liveOff]) {
      const edits = await eventsOf(c.id, "edited");
      expect(edits.length, `${c.name}: the rename was recorded`).toBeGreaterThan(0);
      for (const e of edits) {
        expect(e.changes && "name" in e.changes, "the rename is the recorded change").toBe(true);
        expect(e.changes && ("staff_compete" in e.changes), `${c.name}: an echo must not appear in the ladder`).toBe(false);
      }
    }
    expect((await listRow(liveOn.id)).staff_compete, "still ON").toBe(1);
    expect((await listRow(liveOff.id)).staff_compete, "still OFF").toBe(0);
  });

  test("ECHOING the stored value on an ENDED event is not a change either — the one edit a finished event accepts (reveal answers) lands with the switch echoed beside it; a genuine flip on the same row is refused (control)", async () => {
    // The live echo above sends a RENAME, and a rename is refused on an ended
    // event by an unrelated rule — so it cannot pin the post-end path. This
    // one can: the form sends `staff_compete` on EVERY save (a disabled locked
    // box still reports its stored value), and the one edit the platform
    // accepts after an event ends is the reveal-answers toggle. A build that
    // computed the change flag as "the key is present" would refuse every
    // post-end reveal with the ended words, and nothing else here would notice.
    const endedOn  = await mkComp("echo-ended-on",  { ...EXPIRED(), staff_compete: true });
    const endedOff = await mkComp("echo-ended-off", { ...EXPIRED(), staff_compete: false });
    for (const c of [endedOn, endedOff]) {
      expect((await listRow(c.id)).staff_compete_locked, `${c.name}: precondition — ended`).toBe("ended");
      expect((await listRow(c.id)).reveal_answers_on_end, `${c.name}: precondition — reveal is OFF`).toBe(0);
    }
    // CONTROL FIRST: a genuine flip beside the same reveal toggle is refused,
    // and the refusal moves NOTHING — the reveal included.
    await expectSwitchRefused(await putSwitch(endedOn.id, { staff_compete: false, reveal_answers_on_end: true }), staffCompete.CODES.LOCKED_ENDED, "ended ON → OFF beside a reveal toggle");
    expect((await listRow(endedOn.id)).reveal_answers_on_end, "the refused save did not apply the reveal either").toBe(0);
    expect(await eventsOf(endedOn.id, "edited"), "…and recorded nothing").toEqual([]);

    // The echoes: the stored value sent back beside the one legitimate post-end edit.
    for (const [c, stored] of [[endedOn, true], [endedOff, false]]) {
      const r = await putSwitch(c.id, { staff_compete: stored, reveal_answers_on_end: true });
      expect(r.ok(), `${c.name}: echo ${stored} beside the reveal toggle on an ENDED event: ${r.status()} ${await r.text()}`).toBeTruthy();
      expect(asFlag((await r.json()).competition.staff_compete, `${c.name}: echo response`), `${c.name}: the switch is untouched`).toBe(stored);
      const row = await listRow(c.id);
      expect(row.reveal_answers_on_end, `${c.name}: the reveal toggle LANDED`).toBe(1);
      expect(row.staff_compete, `${c.name}: the switch is still what it was`).toBe(stored ? 1 : 0);
      expect(row.staff_compete_locked, `${c.name}: still ended`).toBe("ended");
      const edits = await eventsOf(c.id, "edited");
      expect(edits.length, `${c.name}: exactly one edit recorded`).toBe(1);
      expect(edits[0].changes && edits[0].changes.reveal_answers_on_end, `${c.name}: the ladder carries the reveal`).toEqual({ from: false, to: true });
      expect(edits[0].changes && ("staff_compete" in edits[0].changes), `${c.name}: an echo must not appear in the ladder`).toBe(false);
    }
  });

  test("a KIND change neither resets the switch nor records a spurious change — it is universal across the three kinds; a flip sent alongside the kind change is recorded (control)", async () => {
    // The switch has no policy key and no per-kind seed, so the kind-change
    // reset block ("reset what the new kind forbids") has nothing to say about
    // it — and that block is exactly where a future reader adds a line. Pinned
    // on the list, the `_compWire` response, the column and the ladder.
    const keep = await mkComp("kind-keep", { ...UPCOMING(), staff_compete: true });
    const flip = await mkComp("kind-flip", { ...UPCOMING(), staff_compete: true });
    expect((await listRow(keep.id)).event_kind, "precondition: created as a Competition").toBe("tournament");
    expect((await listRow(keep.id)).staff_compete_locked, "precondition: upcoming, so the kind may change").toBeNull();

    const r = await putSwitch(keep.id, { event_kind: "booth" });
    expect(r.ok(), `kind change: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = (await r.json()).competition;
    expect(body.event_kind, "the kind changed").toBe("booth");
    expect(asFlag(body.staff_compete, "_compWire after the kind change"), "_compWire: the switch survived").toBe(true);
    expect((await listRow(keep.id)).staff_compete, "list: the switch survived").toBe(1);
    expect(withDb(db => db.prepare("SELECT staff_compete, event_kind FROM competitions WHERE id=?").get(keep.id)), "the row: kind moved, switch did not").toEqual({ staff_compete: 1, event_kind: "booth" });
    const edits = await eventsOf(keep.id, "edited");
    expect(edits.length, "one edit recorded").toBe(1);
    expect(edits[0].changes && edits[0].changes.event_kind, "the ladder carries the kind change").toEqual({ from: "tournament", to: "booth" });
    expect(edits[0].changes && ("staff_compete" in edits[0].changes), "…and no spurious switch change").toBe(false);

    // CONTROL: a flip SENT with the kind change is a real change and is recorded.
    const r2 = await putSwitch(flip.id, { event_kind: "booth", staff_compete: false });
    expect(r2.ok(), `kind change + flip: ${r2.status()} ${await r2.text()}`).toBeTruthy();
    expect((await listRow(flip.id)).staff_compete, "the flip landed").toBe(0);
    const edits2 = await eventsOf(flip.id, "edited");
    expect(edits2.length).toBe(1);
    expect(edits2[0].changes && edits2[0].changes.staff_compete, "the deliberate flip is in the ladder").toEqual({ from: true, to: false });
    expect(edits2[0].changes && edits2[0].changes.event_kind, "…beside the kind change").toEqual({ from: "tournament", to: "booth" });
  });

  test("flipping on a LIVE event → 400 staff_compete_locked, both directions, nothing written; an UPCOMING twin succeeds (control)", async () => {
    const liveOff = await mkComp("live-off", { ...LIVE(), staff_compete: false });
    const liveOn  = await mkComp("live-on",  { ...LIVE(), staff_compete: true });
    const upOff   = await mkComp("up-off",   { ...UPCOMING(), staff_compete: false });

    const b1 = await expectSwitchRefused(await putSwitch(liveOff.id, { staff_compete: true }),  staffCompete.CODES.LOCKED, "live OFF → ON");
    expect(b1.code, "the STARTED code, not the ended one").not.toBe(staffCompete.CODES.LOCKED_ENDED);
    await expectSwitchRefused(await putSwitch(liveOn.id, { staff_compete: false }), staffCompete.CODES.LOCKED, "live ON → OFF");
    expect((await listRow(liveOff.id)).staff_compete, "refusal wrote nothing").toBe(0);
    expect((await listRow(liveOn.id)).staff_compete,  "refusal wrote nothing").toBe(1);
    expect(await eventsOf(liveOff.id, "edited"), "no edit was recorded").toEqual([]);

    // CONTROL: the identical PUT on an upcoming event lands.
    const ok = await putSwitch(upOff.id, { staff_compete: true });
    expect(ok.ok(), `upcoming OFF → ON: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await listRow(upOff.id)).staff_compete).toBe(1);
  });

  test("flipping on an ENDED event → 400 staff_compete_locked_ended — after end-now AND on a time-expired event — never the started code", async () => {
    const endNowOff = await mkComp("ended-endnow-off", { ...LIVE(), staff_compete: false });
    const endNowOn  = await mkComp("ended-endnow-on",  { ...LIVE(), staff_compete: true });
    for (const c of [endNowOff, endNowOn]) {
      const en = await sa.post(`/api/admin/competitions/${c.id}/end-now`, { headers: H(saCsrf) });
      expect(en.ok(), `end-now ${c.name}: ${en.status()} ${await en.text()}`).toBeTruthy();
    }
    const expOff = await mkComp("ended-exp-off", { ...EXPIRED(), staff_compete: false });
    const expOn  = await mkComp("ended-exp-on",  { ...EXPIRED(), staff_compete: true });
    // Precondition: the time-expired pair genuinely reads ended with NO ended_at
    // stamp — the arm that exercises the time-derived half of `fullyEnded`.
    const raw = withDb(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(expOff.id));
    expect(raw.ended_at, "time-expired: ended_at is NULL (the scheduler does not run under test)").toBeNull();
    expect((await listRow(expOff.id)).staff_compete_locked, "…and the list still calls it ended").toBe("ended");

    for (const [c, to] of [[endNowOff, true], [endNowOn, false], [expOff, true], [expOn, false]]) {
      const b = await expectSwitchRefused(await putSwitch(c.id, { staff_compete: to }), staffCompete.CODES.LOCKED_ENDED, `${c.name} → ${to}`);
      expect(b.code, `${c.name}: ended is asked BEFORE started`).not.toBe(staffCompete.CODES.LOCKED);
      expect((await listRow(c.id)).staff_compete, `${c.name}: nothing written`).toBe(to ? 0 : 1);
    }
  });

  test("the in-transaction re-check answers with the SAME started code (source arm)", () => {
    // The status is time-derived and can cross the start boundary between the
    // pre-flight check and the write. That race cannot be scheduled from a test
    // (no clock control), so the re-check is pinned at SOURCE: the transaction
    // must throw on the switch changing under a started event, and the catch
    // must answer with the LOCKED code from the same predicate.
    //
    // A flag and a catch arm are not a re-check. The first draft of this arm
    // pinned only those and stayed green under two realistic mutations — the
    // switch's change flag dropped from the transaction's guard (the throw
    // becomes unreachable for a switch-only flip), and the started predicate
    // asked of the pre-await `comp` rather than of a fresh row (nothing is
    // re-read). So the transaction BODY is sliced and all three properties that
    // make it a re-check are asserted, in ORDER: guard → fresh read → predicate
    // on the fresh row → flag.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "competitions.js"), "utf8"));
    const txnStart = src.indexOf("const editTxn = db.transaction(");
    const flagSet = src.indexOf("_staffCompeteLockRace = true");
    expect(txnStart, "the edit transaction exists").toBeGreaterThan(0);
    expect(flagSet, "the txn sets the race flag").toBeGreaterThan(txnStart);
    const body = src.slice(txnStart, flagSet);
    // (1) the switch's change flag PARTICIPATES in the guard that opens the re-check
    const guard = body.match(/if \([^)]*_staffCompeteChanged[^)]*\)/);
    expect(guard, "the switch's change flag is IN the transaction guard (a guard that never asks about the switch never re-checks it)").toBeTruthy();
    // (2) a FRESH row — carrying the columns the started predicate reads — is
    //     SELECTed between the guard and the throw
    const fresh = body.match(/const _freshComp = db\.prepare\("SELECT [^"]*ended_at[^"]* FROM competitions WHERE id=\?"\)\.get\(/);
    expect(fresh, "a fresh competition row is read INSIDE the transaction").toBeTruthy();
    expect(fresh.index, "…after the guard").toBeGreaterThan(guard.index);
    // (3) the started predicate is asked of THAT row, never of the pre-await `comp`
    const asked = body.match(/competitionAnySlotStarted\(_freshComp\)/);
    expect(asked, "the started predicate is asked of the FRESH row").toBeTruthy();
    expect(asked.index, "…after the fresh read").toBeGreaterThan(fresh.index);
    expect(body.slice(fresh.index), "the stale pre-await row is not what decides").not.toMatch(/competitionAnySlotStarted\(comp[,)]/);
    // (4) the catch answers with the LOCKED code from the SAME predicate
    const catchArm = src.slice(src.indexOf("if (_staffCompeteLockRace)"));
    expect(catchArm.slice(0, 400)).toMatch(/staffCompeteSwitchLock\(\{\s*fullyEnded:\s*false,\s*anySlotStarted:\s*true\s*\}\)/);
    expect(catchArm.slice(0, 400)).toMatch(/res\.status\(400\)/);
    // (5) and the guarded UPDATE is the one that writes the column — a re-check
    //     on a path that does not write would be decoration.
    const coalesce = src.indexOf("staff_compete=COALESCE(?,staff_compete)");
    expect(coalesce, "the COALESCE write exists").toBeGreaterThan(flagSet);
    expect(coalesce - flagSet, "…and it sits just below the guard, in the same transaction").toBeLessThan(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — the three content refusals", () => {

  test("0→1 with an UNSEALED challenge assigned → 400 staff_compete_unsealed_challenges naming exactly it; with only a SEALED one it succeeds (control)", async () => {
    // Sealing needs a USER-BACKED author: the built-in superadmin has no users
    // row, so `sealAtCreateDenied` refuses it. The author must NOT hold a row on
    // either event (author-competes would refuse the assignment instead).
    const author = await makeTier("seal-author", "admin");
    const sealed = await makeTask(author.api, author.csrf, "sealed", { answer_sealed: true });
    const plain  = await makeTask(author.api, author.csrf, "plain");
    const decoyPlain = await makeTask(author.api, author.csrf, "decoy-plain"); // assigned NOWHERE
    const sealedRow = withDb(db => db.prepare("SELECT answer_sealed FROM tasks WHERE id=?").get(sealed.id));
    expect(sealedRow.answer_sealed, "precondition: the sealed task really is sealed").toBe(1);

    const mixed = await mkComp("unsealed-mixed", { ...UPCOMING(), staff_compete: false });
    const clean = await mkComp("unsealed-clean", { ...UPCOMING(), staff_compete: false });
    await assignTask(author.api, author.csrf, sealed.id, [mixed.id, clean.id]);
    await assignTask(author.api, author.csrf, plain.id,  [mixed.id]);

    const b = await expectSwitchRefused(await putSwitch(mixed.id, { staff_compete: true }), staffCompete.CODES.UNSEALED_ASSIGNED, "ON with an unsealed challenge");
    expect(Array.isArray(b.challenges), "the refusal NAMES the challenges").toBe(true);
    expect(b.challenges, "exactly the unsealed one — not the sealed one beside it, not the unassigned decoy")
      .toEqual([{ id: eventCopyOf(plain.id, mixed.id), title: plain.title }]);
    expect(b.error, "the sentence names the count").toMatch(/not sealed/);
    expect((await listRow(mixed.id)).staff_compete, "nothing written").toBe(0);
    expect(await eventsOf(mixed.id, "edited"), "no edit recorded").toEqual([]);

    // CONTROL: the same PUT on the event holding only the sealed challenge lands.
    const ok = await putSwitch(clean.id, { staff_compete: true });
    expect(ok.ok(), `ON with only a sealed challenge: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await listRow(clean.id)).staff_compete).toBe(1);

    // And the REMEDY the refusal names works: take the unsealed one out, flip again.
    const un = await author.api.delete(`/api/admin/tasks/${plain.id}/competitions/${mixed.id}`, { headers: H(author.csrf) });
    expect(un.ok(), `unassign the unsealed challenge: ${un.status()} ${await un.text()}`).toBeTruthy();
    const ok2 = await putSwitch(mixed.id, { staff_compete: true });
    expect(ok2.ok(), `ON after the remedy: ${ok2.status()} ${await ok2.text()}`).toBeTruthy();
    expect((await listRow(mixed.id)).staff_compete).toBe(1);
  });

  test("0→1 with an ENROLLED AUTHOR of an assigned SEALED challenge → 400 staff_compete_enrolled_authors naming exactly them and their challenges (one entry, tasks by title); an event holding only an OUTSIDER's sealed challenge flips (control); both remedies work", async () => {
    // The author door is asked at ASSIGNMENT and at ENROLMENT only while the
    // switch is ON — so on a switch-OFF event an enrolled row-holder can assign
    // their own challenge to it freely, and the switch is then the one door
    // left into "a competitor who can read a key". SEALED challenges, so the
    // unsealed refusal cannot answer first and this arm is about the author
    // question alone. The OUTSIDER (an admin holding no row anywhere) has a
    // sealed challenge on the SAME event, which is the in-payload control that
    // the refusal names enrolled authors only.
    const eventA = await mkComp("author-enrolled", { ...UPCOMING(), staff_compete: false }); // both remedies: unassign
    const eventB = await mkComp("author-clean",    { ...UPCOMING(), staff_compete: false }); // only the outsider's challenge
    const eventC = await mkComp("author-remove",   { ...UPCOMING(), staff_compete: false }); // the other remedy: remove the author
    const author = await makeEnrolledAuthor("enrolled-author", [eventA.id, eventC.id]);
    const outsider = await makeTier("outsider-author", "admin");
    // Labels chosen so the TITLES sort "mine-a" before "mine-b" while they are
    // CREATED the other way round. That is a HINT, not a lock: with the ORDER BY
    // dropped the join falls back to `competition_tasks` PK order — a UUID —
    // so two titles land right about half the time (measured, 6 of 12 runs).
    // The ORDER BY is pinned at SOURCE by the column-0 arm below; this
    // assertion is the wire's shape, and that arm is what holds the order.
    const mineB = await makeTask(author.api, author.csrf, "mine-b", { answer_sealed: true });
    const mineA = await makeTask(author.api, author.csrf, "mine-a", { answer_sealed: true });
    const theirs = await makeTask(outsider.api, outsider.csrf, "outsider-sealed", { answer_sealed: true });
    for (const t of [mineA, mineB, theirs]) {
      expect(withDb(db => db.prepare("SELECT answer_sealed FROM tasks WHERE id=?").get(t.id)).answer_sealed, `precondition: ${t.title} is sealed`).toBe(1);
    }
    expect(withDb(db => db.prepare("SELECT created_by_id FROM tasks WHERE id=?").get(mineA.id)).created_by_id, "precondition: the author owns their challenge").toBe(author.id);
    await assignTask(author.api, author.csrf, mineB.id, [eventA.id, eventC.id]);
    await assignTask(author.api, author.csrf, mineA.id, [eventA.id]);
    await assignTask(outsider.api, outsider.csrf, theirs.id, [eventA.id, eventB.id]);

    const b = await expectSwitchRefused(await putSwitch(eventA.id, { staff_compete: true }), staffCompete.CODES.AUTHOR_ENROLLED, "ON with an enrolled author");
    expect(Array.isArray(b.participants), "the refusal NAMES the participants").toBe(true);
    expect(b.participants, "ONE entry for the author, carrying BOTH challenges ordered by title")
      .toEqual([{ id: author.id, nickname: author.nickname, tasks: [{ id: eventCopyOf(mineA.id, eventA.id), title: mineA.title }, { id: eventCopyOf(mineB.id, eventA.id), title: mineB.title }] }]);
    expect(b.challenges, "the author refusal has no `challenges` key — that is the unsealed refusal's shape").toBeUndefined();
    const serialised = JSON.stringify(b);
    expect(serialised, "the outsider is not named (by value)").not.toContain(outsider.nickname);
    expect(serialised, "…nor is their challenge").not.toContain(theirs.title);
    expect(b.error, "the sentence names the person").toContain(author.nickname);
    expect(b.error, "…and names the remedy").toMatch(/Remove that person from the event or take their questions out first/);
    expect((await listRow(eventA.id)).staff_compete, "nothing written").toBe(0);
    expect(await eventsOf(eventA.id, "edited"), "no edit recorded").toEqual([]);

    // CONTROL: the event holding only the outsider's sealed challenge flips.
    const ok = await putSwitch(eventB.id, { staff_compete: true });
    expect(ok.ok(), `ON with only a non-enrolled author's challenge: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await listRow(eventB.id)).staff_compete).toBe(1);

    // REMEDY 1 — take the author's challenges out of the event; the switch flips.
    for (const t of [mineA, mineB]) {
      const un = await author.api.delete(`/api/admin/tasks/${t.id}/competitions/${eventA.id}`, { headers: H(author.csrf) });
      expect(un.ok(), `unassign ${t.title}: ${un.status()} ${await un.text()}`).toBeTruthy();
    }
    const ok2 = await putSwitch(eventA.id, { staff_compete: true });
    expect(ok2.ok(), `ON after unassigning the author's challenges: ${ok2.status()} ${await ok2.text()}`).toBeTruthy();
    expect((await listRow(eventA.id)).staff_compete).toBe(1);

    // REMEDY 2 — remove the author from the event instead; the switch flips.
    const b3 = await expectSwitchRefused(await putSwitch(eventC.id, { staff_compete: true }), staffCompete.CODES.AUTHOR_ENROLLED, "ON with the same author enrolled elsewhere");
    expect(b3.participants.map(p => p.id), "the same person, on the other event").toEqual([author.id]);
    expect(b3.participants[0].tasks, "the singular shape: one challenge held there").toEqual([{ id: eventCopyOf(mineB.id, eventC.id), title: mineB.title }]);
    expect(b3.error, "the singular remedy sentence").toMatch(/Remove that person from the event or take the question out first/);
    const rm = await sa.delete(`/api/admin/competitions/${eventC.id}/users/${author.id}`, { headers: H(saCsrf) });
    expect(rm.ok(), `remove the author: ${rm.status()} ${await rm.text()}`).toBeTruthy();
    expect((await rm.json()).removed, "the removal really happened").toBe(true);
    const ok3 = await putSwitch(eventC.id, { staff_compete: true });
    expect(ok3.ok(), `ON after removing the author: ${ok3.status()} ${await ok3.text()}`).toBeTruthy();
    expect((await listRow(eventC.id)).staff_compete).toBe(1);
  });

  test("the ON direction asks UNSEALED before AUTHORS: an unsealed challenge by the same enrolled author answers with the unsealed code, and only once it is out does the author refusal answer", async () => {
    // Two refusals can hold on one event at once. The operator's remedy list is
    // therefore ORDERED — seal or unassign first, then remove the author — and a
    // build that asked the author question first would send them to remove a
    // colleague when unassigning one challenge would have done. The second
    // half proves the ordering is a real sequence and not one refusal masking
    // the other: the same PUT, after the first remedy, meets the second code.
    const ev = await mkComp("order-unsealed-first", { ...UPCOMING(), staff_compete: false });
    const author = await makeEnrolledAuthor("order-author", [ev.id]);
    const sealedMine = await makeTask(author.api, author.csrf, "order-sealed", { answer_sealed: true });
    const plainMine  = await makeTask(author.api, author.csrf, "order-plain");
    await assignTask(author.api, author.csrf, sealedMine.id, [ev.id]);
    await assignTask(author.api, author.csrf, plainMine.id,  [ev.id]);
    // Preconditions: BOTH questions would refuse — the module's own predicates say so.
    expect(withDb(db => staffCompete.unsealedAssigned(db, ev.id)).map(t => t.id), "precondition: the unsealed one is assigned").toEqual([eventCopyOf(plainMine.id, ev.id)]);
    expect(withDb(db => staffCompete.enrolledAuthors(db, ev.id)).map(a => a.id), "precondition: the author is enrolled").toEqual([author.id]);

    const b1 = await expectSwitchRefused(await putSwitch(ev.id, { staff_compete: true }), staffCompete.CODES.UNSEALED_ASSIGNED, "both hold: unsealed answers first");
    expect(b1.challenges, "…naming the unsealed one").toEqual([{ id: eventCopyOf(plainMine.id, ev.id), title: plainMine.title }]);
    expect(b1.participants, "…and not the author shape").toBeUndefined();

    const un = await author.api.delete(`/api/admin/tasks/${plainMine.id}/competitions/${ev.id}`, { headers: H(author.csrf) });
    expect(un.ok(), `unassign the unsealed one: ${un.status()} ${await un.text()}`).toBeTruthy();
    const b2 = await expectSwitchRefused(await putSwitch(ev.id, { staff_compete: true }), staffCompete.CODES.AUTHOR_ENROLLED, "the unsealed one gone: the author refusal answers");
    expect(b2.participants, "…naming the author with the sealed challenge they still have there").toEqual([{ id: author.id, nickname: author.nickname, tasks: [{ id: eventCopyOf(sealedMine.id, ev.id), title: sealedMine.title }] }]);
    expect((await listRow(ev.id)).staff_compete, "nothing written by either refusal").toBe(0);
  });

  test("0→1 is not asked the staff question: a staff-TAGGED row-holder does not stop the switch being turned ON", async () => {
    // Each question binds ONE direction. The staff question belongs to 1→0; a
    // build that also asked it on 0→1 would refuse to switch ON an event whose
    // member was tagged staff after enrolment — a state reachable with no
    // planting at all (enrol, then tag).
    //
    // v8.12.4 — the other half of this test is gone: it planted an ON event
    // holding an UNSEALED challenge straight into the row, to show 1→0 is not
    // asked the seal question. Every door refuses that state (assign, switch-on,
    // unseal at any status, import), and the column arrived defaulting OFF, so
    // no database holds it — asking the seal question on 1→0 could change no
    // outcome anybody can reach, and the assertion pinned nothing.
    const offWithStaff = await mkComp("dir-off", { ...UPCOMING(), staff_compete: false });
    const p = await makeParticipant(sa, saCsrf, "dir-staff");
    await enrol(sa, saCsrf, offWithStaff.id, [p.id]);
    await tagStaff(p);
    // Preconditions read back, not assumed: "0→1 ignores enrolled staff" passes
    // for the wrong reason if the tag silently did not land or the row is gone —
    // there would be no staff enrolled to ignore.
    expect(withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(p.id)).map(t => t.tag), "precondition: the tag landed").toContain("staff");
    expect(withDb(db => db.prepare("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?").get(offWithStaff.id, p.id)), "precondition: the row is still held after tagging").toBeTruthy();
    // …and the module's OWN predicate — the one the 1→0 refusal reads — names
    // them, so the state really is the one the other direction would refuse.
    expect(withDb(db => staffCompete.staffEnrolled(db, offWithStaff.id)).map(x => x.id), "precondition: staffEnrolled sees them").toEqual([p.id]);
    const on = await putSwitch(offWithStaff.id, { staff_compete: true });
    expect(on.ok(), `0→1 ignores enrolled staff: ${on.status()} ${await on.text()}`).toBeTruthy();
    expect((await listRow(offWithStaff.id)).staff_compete).toBe(1);
  });

  test("1→0 with a staff-TAGGED user enrolled → 400 staff_compete_enrolled_staff naming exactly them; with only ordinary participants it succeeds (control)", async () => {
    const withStaff = await mkComp("staff-enrolled", { ...UPCOMING(), staff_compete: true });
    const ordinaryOnly = await mkComp("staff-none", { ...UPCOMING(), staff_compete: true });
    const staffer = await makeParticipant(sa, saCsrf, "staffer");
    const ordinary = await makeParticipant(sa, saCsrf, "ordinary");
    const ordinary2 = await makeParticipant(sa, saCsrf, "ordinary2");
    await tagStaff(staffer);
    // A staff-tagged user is admitted on a compete event; the ordinary one
    // beside them is the in-payload control that the refusal names STAFF only.
    await enrol(sa, saCsrf, withStaff.id, [staffer.id, ordinary.id]);
    await enrol(sa, saCsrf, ordinaryOnly.id, [ordinary2.id]);

    const b = await expectSwitchRefused(await putSwitch(withStaff.id, { staff_compete: false }), staffCompete.CODES.STAFF_ENROLLED, "OFF with staff enrolled");
    expect(Array.isArray(b.participants), "the refusal NAMES the participants").toBe(true);
    expect(b.participants, "exactly the staff-tagged one, by id and nickname").toEqual([{ id: staffer.id, nickname: staffer.nickname }]);
    expect(JSON.stringify(b), "the ordinary participant is not named").not.toContain(ordinary.nickname);
    // The sentence names the REMEDY the block below then performs (FROZEN_REMEDY:
    // a refusal that names no working remedy is a dead end), in the singular the
    // count calls for.
    expect(b.error, "the refusal names the remedy").toMatch(/Remove that person from the event first/);
    expect((await listRow(withStaff.id)).staff_compete, "nothing written").toBe(1);
    expect(await eventsOf(withStaff.id, "edited"), "no edit recorded").toEqual([]);

    // CONTROL: only ordinary participants → the flip lands.
    const ok = await putSwitch(ordinaryOnly.id, { staff_compete: false });
    expect(ok.ok(), `OFF with ordinary participants only: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await listRow(ordinaryOnly.id)).staff_compete).toBe(0);

    // And the REMEDY works: remove the staff member, flip again.
    const rm = await sa.delete(`/api/admin/competitions/${withStaff.id}/users/${staffer.id}`, { headers: H(saCsrf) });
    expect(rm.ok(), `remove the staff member: ${rm.status()} ${await rm.text()}`).toBeTruthy();
    expect((await rm.json()).removed, "the removal really happened (the route answers ok on a no-op)").toBe(true);
    const ok2 = await putSwitch(withStaff.id, { staff_compete: false });
    expect(ok2.ok(), `OFF after the remedy: ${ok2.status()} ${await ok2.text()}`).toBeTruthy();
    expect((await listRow(withStaff.id)).staff_compete).toBe(0);
  });

  test("a promoted admin (tagged staff by promotion) enrolled on a switch-ON event blocks 1→0 exactly like a hand-tagged one", async () => {
    // The tag arrives by two routes; the refusal must not depend on which.
    const comp = await mkComp("staff-promoted", { ...UPCOMING(), staff_compete: true });
    const admin = await makeTier("promoted-staff", "admin");
    await enrol(sa, saCsrf, comp.id, [admin.id]);
    const b = await expectSwitchRefused(await putSwitch(comp.id, { staff_compete: false }), staffCompete.CODES.STAFF_ENROLLED, "OFF with a promoted admin enrolled");
    expect(b.participants).toEqual([{ id: admin.id, nickname: admin.nickname }]);
  });

  test("an ENROLLED EVENT ADMIN (role, untagged) does NOT block turning it off — the rule is the TAG", async () => {
    // An event admin is excluded from scoring by ROLE and the assign route has
    // always admitted them on a non-compete event, so their row is not evidence
    // the switch was ever on. Refusing on it would leave every event with an
    // organiser enrolled unable to turn the switch off.
    const comp = await mkComp("ea-enrolled", { ...UPCOMING(), staff_compete: true });
    const decoy = await mkComp("ea-decoy", UPCOMING());
    const ea = await makeParticipant(sa, saCsrf, "ea");
    await grantEventAdmin(sa, saCsrf, decoy.id, ea.id);
    const role = withDb(db => db.prepare("SELECT role FROM users WHERE id=?").get(ea.id)).role;
    expect(role, "precondition: the grant made them an event admin").toBe("event_admin");
    const tags = withDb(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(ea.id)).map(t => t.tag);
    expect(tags, "precondition: an event admin is NOT tagged staff").not.toContain("staff");
    await enrol(sa, saCsrf, comp.id, [ea.id]);

    const ok = await putSwitch(comp.id, { staff_compete: false });
    expect(ok.ok(), `OFF with an event admin enrolled: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    expect((await listRow(comp.id)).staff_compete).toBe(0);
    // CONTROL in the same shape: tag that same person `staff` and the flip back
    // ON, then OFF again, is refused — so "it succeeded" is about the tag, not
    // about a build that never asks.
    await tagStaff(ea);
    const on = await putSwitch(comp.id, { staff_compete: true });
    expect(on.ok(), `back ON: ${on.status()} ${await on.text()}`).toBeTruthy();
    const b = await expectSwitchRefused(await putSwitch(comp.id, { staff_compete: false }), staffCompete.CODES.STAFF_ENROLLED, "OFF once the same organiser is tagged");
    expect(b.participants.map(p => p.id)).toEqual([ea.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — every refusal sits ABOVE validate_only (five of them)", () => {

  test("a dry run meets the unsealed-challenge, enrolled-author, enrolled-staff, started AND ended refusals, and writes nothing; a clean dry run validates and writes nothing (control)", async () => {
    const author = await makeTier("dry-author", "admin");
    const plain = await makeTask(author.api, author.csrf, "dry-plain");
    const unsealedComp = await mkComp("dry-unsealed", { ...UPCOMING(), staff_compete: false });
    await assignTask(author.api, author.csrf, plain.id, [unsealedComp.id]);

    // The third content refusal: an enrolled row-holder wrote a SEALED
    // challenge the event holds (sealed, so the unsealed refusal cannot
    // answer in its place).
    const authorComp = await mkComp("dry-author-enrolled", { ...UPCOMING(), staff_compete: false });
    const enrolledAuthor = await makeEnrolledAuthor("dry-enrolled-author", [authorComp.id]);
    const sealedMine = await makeTask(enrolledAuthor.api, enrolledAuthor.csrf, "dry-sealed-mine", { answer_sealed: true });
    await assignTask(enrolledAuthor.api, enrolledAuthor.csrf, sealedMine.id, [authorComp.id]);

    const staffComp = await mkComp("dry-staff", { ...UPCOMING(), staff_compete: true });
    const staffer = await makeParticipant(sa, saCsrf, "dry-staffer");
    await tagStaff(staffer);
    await enrol(sa, saCsrf, staffComp.id, [staffer.id]);

    const liveComp = await mkComp("dry-live", { ...LIVE(), staff_compete: false });
    // Both lock codes come from ONE `switchLock` call today, so they cannot be
    // separated — but the scope is EVERY refusal, and a reader who later splits
    // the ended branch (an ended-specific early return placed below the dry-run
    // return) needs an arm to go red on. Time-expired: `ended_at` stays NULL.
    const endedComp = await mkComp("dry-ended", { ...EXPIRED(), staff_compete: false });
    expect((await listRow(endedComp.id)).staff_compete_locked, "precondition: the list calls it ended").toBe("ended");
    const cleanComp = await mkComp("dry-clean", { ...UPCOMING(), staff_compete: false });

    const b1 = await expectSwitchRefused(await putSwitch(unsealedComp.id, { staff_compete: true, validate_only: true }), staffCompete.CODES.UNSEALED_ASSIGNED, "dry run, unsealed");
    expect(b1.challenges).toEqual([{ id: eventCopyOf(plain.id, unsealedComp.id), title: plain.title }]);
    const b2 = await expectSwitchRefused(await putSwitch(staffComp.id, { staff_compete: false, validate_only: true }), staffCompete.CODES.STAFF_ENROLLED, "dry run, staff enrolled");
    expect(b2.participants).toEqual([{ id: staffer.id, nickname: staffer.nickname }]);
    await expectSwitchRefused(await putSwitch(liveComp.id, { staff_compete: true, validate_only: true }), staffCompete.CODES.LOCKED, "dry run, started");
    const b4 = await expectSwitchRefused(await putSwitch(endedComp.id, { staff_compete: true, validate_only: true }), staffCompete.CODES.LOCKED_ENDED, "dry run, ended");
    expect(b4.code, "the ENDED code, not the started one, on the dry run too").not.toBe(staffCompete.CODES.LOCKED);
    const b5 = await expectSwitchRefused(await putSwitch(authorComp.id, { staff_compete: true, validate_only: true }), staffCompete.CODES.AUTHOR_ENROLLED, "dry run, enrolled author");
    expect(b5.participants, "the dry run carries the same participants[] shape as the real refusal")
      .toEqual([{ id: enrolledAuthor.id, nickname: enrolledAuthor.nickname, tasks: [{ id: eventCopyOf(sealedMine.id, authorComp.id), title: sealedMine.title }] }]);

    // CONTROL: a clean dry run VALIDATES — and still writes nothing, which is
    // what separates "validate_only is honoured" from "nothing ever writes".
    const dry = await putSwitch(cleanComp.id, { staff_compete: true, validate_only: true });
    expect(dry.ok(), `clean dry run: ${dry.status()} ${await dry.text()}`).toBeTruthy();
    const dryBody = await dry.json();
    expect(dryBody.validated, "the dry run says it validated").toBe(true);

    for (const [c, want] of [[unsealedComp, 0], [authorComp, 0], [staffComp, 1], [liveComp, 0], [endedComp, 0], [cleanComp, 0]]) {
      expect((await listRow(c.id)).staff_compete, `${c.name}: a dry run wrote nothing`).toBe(want);
      expect(await eventsOf(c.id, "edited"), `${c.name}: a dry run recorded nothing`).toEqual([]);
    }
    // And the REAL save behind the clean dry run lands, so the control is not
    // satisfied by an event that cannot be flipped at all.
    const real = await putSwitch(cleanComp.id, { staff_compete: true });
    expect(real.ok(), `the real save: ${real.status()} ${await real.text()}`).toBeTruthy();
    expect((await listRow(cleanComp.id)).staff_compete).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — the post-commit cache busts", () => {

  test("flipping ON moves /api/me's `competing` for an enrolled event admin INSIDE the 2 s me-cache TTL", async () => {
    // An event admin (role, untagged) is the one staff actor the assign route
    // admits on a switch-OFF event, so they can hold a row BEFORE the flip —
    // which is what makes the bust observable: /api/me is cached 2 s per user,
    // and without `_invalidateMeCacheForComps` the second read serves the row
    // that says `competing:false`.
    const comp = await mkComp("bust-me", { ...UPCOMING(), staff_compete: false });
    const decoy = await mkComp("bust-me-decoy", UPCOMING());
    const ea = await makeParticipant(sa, saCsrf, "bust-ea");
    await grantEventAdmin(sa, saCsrf, decoy.id, ea.id);
    await enrol(sa, saCsrf, comp.id, [ea.id]);
    const { api } = await loginAs(ea);
    const readMe = async () => {
      const r = await api.get("/api/me");
      expect(r.ok(), `/api/me: ${r.status()} ${await r.text()}`).toBeTruthy();
      const row = ((await r.json()).competitions || []).find(c => c.id === comp.id);
      expect(row, "the enrolled event is on the actor's own list").toBeTruthy();
      return row;
    };
    const ME_TTL_MS = 2000;
    // The sample is valid only if the whole warm→flip→read sequence fits inside
    // the TTL; on a saturated box it can not, and a late read is satisfied by a
    // build with no bust. So the window is measured and the sample RE-TAKEN
    // (flipping back is allowed — an event admin's row does not block it) rather
    // than passed in silence. A named error only if every attempt was slow.
    let landed = null;
    for (let attempt = 0; attempt < 4 && !landed; attempt++) {
      const before = await readMe();
      expect(before.own, "precondition: they hold a row").toBe(true);
      expect(before.competing, "precondition: switch OFF → not competing").toBe(false);
      expect(asFlag(before.staff_compete, "/api/me row, before"), "precondition: the row reports the switch OFF").toBe(false);
      const t0 = Date.now();
      const on = await putSwitch(comp.id, { staff_compete: true });
      expect(on.ok(), `flip ON: ${on.status()} ${await on.text()}`).toBeTruthy();
      const after = await readMe();
      const elapsed = Date.now() - t0;
      if (elapsed < ME_TTL_MS - 300) { landed = { after, elapsed }; break; }
      // Too slow to discriminate: put it back and try again.
      const off = await putSwitch(comp.id, { staff_compete: false });
      expect(off.ok(), `flip back OFF for a retry: ${off.status()} ${await off.text()}`).toBeTruthy();
      await expect.poll(async () => (await readMe()).competing, { timeout: 5000 }).toBe(false);
    }
    if (!landed) throw new Error("the box could not complete warm→flip→read inside the 2 s me-cache TTL in four attempts — the sample cannot discriminate a bust from a timeout; re-run on a quieter machine");
    expect(landed.after.competing, `competing flipped within ${landed.elapsed} ms of the PUT (TTL ${ME_TTL_MS} ms) — the me-cache was busted`).toBe(true);
    expect(asFlag(landed.after.staff_compete, "/api/me row, after"), "the row reports the new switch").toBe(true);
    expect(landed.after.own, "still a row-holder").toBe(true);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — the other surfaces that carry the switch", () => {

  test("GET /api/admin/export/competitions carries staff_compete true/false per row", async () => {
    const on  = await mkComp("export-on",  { ...UPCOMING(), staff_compete: true });
    const off = await mkComp("export-off", { ...UPCOMING(), staff_compete: false });
    const r = await sa.get("/api/admin/export/competitions");
    expect(r.ok(), `export: ${r.status()}`).toBeTruthy();
    const body = await r.json();
    // The export carries no ids (portability), so rows are matched by name.
    const rowOn  = body.competitions.find(c => c.name === on.name);
    const rowOff = body.competitions.find(c => c.name === off.name);
    expect(rowOn,  "the ON event is exported").toBeTruthy();
    expect(rowOff, "the OFF event is exported").toBeTruthy();
    expect(rowOn.staff_compete,  "exported as a BOOLEAN true").toBe(true);
    expect(rowOff.staff_compete, "exported as a BOOLEAN false").toBe(false);
    // Every row decides — a row missing the key would be one the importer
    // cannot honour.
    for (const c of body.competitions) expect(typeof c.staff_compete, `${c.name}: staff_compete is a boolean on every exported row`).toBe("boolean");
  });

  test("the public self-enroll preview carries staff_compete, so a staff member is told before joining", async () => {
    const on  = await mkComp("preview-on",  { ...UPCOMING(), staff_compete: true,  self_enroll_enabled: true });
    const off = await mkComp("preview-off", { ...UPCOMING(), staff_compete: false, self_enroll_enabled: true });
    const tokenOf = async id => {
      const r = await sa.get(`/api/admin/competitions/${id}/self-enroll`);
      expect(r.ok(), `reveal token: ${r.status()} ${await r.text()}`).toBeTruthy();
      const t = (await r.json()).token;
      expect(t, "the reveal returns the token").toBeTruthy();
      return t;
    };
    const anon = await request.newContext({ baseURL: BASE });
    try {
      for (const [c, want] of [[on, true], [off, false]]) {
        const r = await anon.get(`/api/competitions/self-enroll/${await tokenOf(c.id)}`);
        expect(r.ok(), `preview ${c.name}: ${r.status()} ${await r.text()}`).toBeTruthy();
        const p = await r.json();
        expect(p.id, "the preview names the event").toBe(c.id);
        expect(p.staff_compete, `${c.name}: the preview carries the switch as a boolean`).toBe(want);
      }
    } finally { await anon.dispose(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.0 — lib/staff-compete.js, driven at column 0", () => {

  test("switchLock: ended before started, null otherwise, and each carries its own code + reason + sentence", () => {
    const { switchLock, CODES } = staffCompete;
    expect(switchLock({ fullyEnded: false, anySlotStarted: false }), "an upcoming event is changeable").toBeNull();
    const started = switchLock({ fullyEnded: false, anySlotStarted: true });
    expect(started.code).toBe(CODES.LOCKED);
    expect(started.reason).toBe("started");
    expect(started.message.length).toBeGreaterThan(40);
    const ended = switchLock({ fullyEnded: true, anySlotStarted: true });
    expect(ended.code, "ended implies started, and ended must WIN").toBe(CODES.LOCKED_ENDED);
    expect(ended.reason).toBe("ended");
    expect(ended.message.length).toBeGreaterThan(40);
    expect(ended.message, "the two sentences differ — a reader must not be told 'started' about a finished event").not.toBe(started.message);
    // A manually-ended event that the inclusive-end arithmetic still calls "not
    // started" for one millisecond: fullyEnded alone must be enough.
    expect(switchLock({ fullyEnded: true, anySlotStarted: false }).code).toBe(CODES.LOCKED_ENDED);
    // The two codes and the two reasons are distinct strings — the client keys on both.
    expect(CODES.LOCKED).not.toBe(CODES.LOCKED_ENDED);
  });

  test("capRefused caps the ledger at REFUSED_LIST_CAP and keeps the TOTAL honest", () => {
    const { capRefused, REFUSED_LIST_CAP } = staffCompete;
    expect(REFUSED_LIST_CAP, "the cap is the documented 50").toBe(50);
    const short = capRefused([{ task_id: "a" }, { task_id: "b" }]);
    expect(short.refused.length).toBe(2);
    expect(short.refused_total).toBe(2);
    const long = Array.from({ length: REFUSED_LIST_CAP + 7 }, (_, i) => ({ task_id: `t${i}` }));
    const capped = capRefused(long);
    expect(capped.refused.length, "trimmed to the cap").toBe(REFUSED_LIST_CAP);
    expect(capped.refused_total, "…but the total is the real count").toBe(REFUSED_LIST_CAP + 7);
    expect(capped.refused[0].task_id, "the FIRST entries are kept, in order").toBe("t0");
    expect(capped.refused[REFUSED_LIST_CAP - 1].task_id).toBe(`t${REFUSED_LIST_CAP - 1}`);
    expect(capRefused([]), "an empty ledger is an empty ledger").toEqual({ refused: [], refused_total: 0 });
    expect(long.length, "the input is not mutated").toBe(REFUSED_LIST_CAP + 7);
  });

  test("staffCompeteOn THROWS on a row that never selected the column — and reads 0/1 as a boolean", () => {
    const { staffCompeteOn } = staffCompete;
    // The under-selected row must fail LOUD (the v8.4.0 posture): a quiet `false`
    // here would exclude staff from a board they were meant to be on, with every
    // test green.
    expect(() => staffCompeteOn({}), "an empty row").toThrow(/staff_compete/);
    expect(() => staffCompeteOn({ id: "x", name: "y" }), "a row with other columns and no switch").toThrow(/staff_compete/);
    expect(() => staffCompeteOn({ staff_compete: undefined }), "an explicit undefined is still missing").toThrow(/staff_compete/);
    expect(() => staffCompeteOn(null), "no row at all").toThrow();
    expect(staffCompeteOn({ staff_compete: 1 })).toBe(true);
    expect(staffCompeteOn({ staff_compete: 0 })).toBe(false);
    // NULL is a VALUE (a row written before the column had a default), and it means off.
    expect(staffCompeteOn({ staff_compete: null })).toBe(false);
    expect(staffCompeteOn({ staff_compete: true })).toBe(true);
  });

  test("unsealedAssignmentDenied: only a compete event asks, and it throws on a task that never selected answer_sealed", () => {
    const { unsealedAssignmentDenied, CODES } = staffCompete;
    const off = { id: "c1", name: "Off", staff_compete: 0 };
    const on  = { id: "c2", name: "On",  staff_compete: 1 };
    // A switch-OFF event admits anything — it does not even READ the task's seal.
    expect(unsealedAssignmentDenied({ id: "t", title: "T" }, off), "off: not asked, so a missing seal column is fine").toBeNull();
    expect(unsealedAssignmentDenied({ id: "t", title: "T", answer_sealed: 0 }, off)).toBeNull();
    // A switch-ON event admits a sealed challenge and refuses an unsealed one, by name.
    expect(unsealedAssignmentDenied({ id: "t", title: "T", answer_sealed: 1 }, on)).toBeNull();
    const d = unsealedAssignmentDenied({ id: "t", title: "Plain One", answer_sealed: 0 }, on);
    expect(d.code).toBe(CODES.UNSEALED);
    expect(d.reason).toBe("unsealed");
    expect(d.message).toContain("Plain One");
    expect(d.message).toContain("On");
    // …and it will not GUESS about a task row that never selected the column.
    expect(() => unsealedAssignmentDenied({ id: "t", title: "T" }, on)).toThrow(/answer_sealed/);
    expect(() => unsealedAssignmentDenied({ id: "t", title: "T" }, {}), "nor about a comp row missing the switch").toThrow(/staff_compete/);
  });

  test("enrolledAuthors: a challenge with NO author never matches, a non-enrolled author never matches, and one author's several challenges are ONE entry ordered by title", async () => {
    // Driven against this worker's database through the module's own export —
    // the route arm above proves the wire, this proves the PREDICATE's edges
    // the wire arm cannot reach in one fixture: `created_by_id` NULL (every
    // challenge the built-in superadmin creates, every imported one, every
    // pre-v8.7.0 one) joins nobody, and an author with no row is not enrolled.
    const comp  = await mkComp("col0-authors", { ...UPCOMING(), staff_compete: false });
    const empty = await mkComp("col0-nobody",  { ...UPCOMING(), staff_compete: false });
    const author = await makeEnrolledAuthor("col0-author", [comp.id]);
    const outsider = await makeTier("col0-outsider", "admin");
    const nobodys = await makeTask(sa, saCsrf, "col0-null-author");
    expect(withDb(db => db.prepare("SELECT created_by_id FROM tasks WHERE id=?").get(nobodys.id)).created_by_id, "precondition: the built-in's challenge has NO author").toBeNull();
    const mineB = await makeTask(author.api, author.csrf, "col0-b");
    const mineA = await makeTask(author.api, author.csrf, "col0-a");
    const theirs = await makeTask(outsider.api, outsider.csrf, "col0-outsider");
    // Unsealed is fine: the predicate reads no seal, and on a switch-OFF event
    // neither assignment door asks.
    for (const t of [nobodys, mineB, mineA, theirs]) await assignTask(sa, saCsrf, t.id, [comp.id, empty.id]);

    expect(withDb(db => staffCompete.enrolledAuthors(db, comp.id)), "exactly the enrolled author, one entry, tasks by title")
      .toEqual([{ id: author.id, nickname: author.nickname, tasks: [{ id: eventCopyOf(mineA.id, comp.id), title: mineA.title }, { id: eventCopyOf(mineB.id, comp.id), title: mineB.title }] }]);
    expect(withDb(db => staffCompete.enrolledAuthors(db, empty.id)), "the same four challenges on an event with nobody enrolled: nobody").toEqual([]);
    expect(withDb(db => staffCompete.enrolledAuthors(db, "no-such-event")), "an unknown event: an empty list, not a throw").toEqual([]);
    // THE ORDER IS PINNED AT SOURCE. Two same-author titles can land in title
    // order by chance with the ORDER BY dropped (the join then follows the
    // `competition_tasks` PK, a UUID — measured 6 of 12 runs green on the wire
    // arm), so "tasks by title" above is probabilistic on its own. The SQL is
    // what the modal's stable ordering rests on, and it is asserted directly:
    // `enrolledAuthors` orders by nickname, then title.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "staff-compete.js"), "utf8"));
    const fnStart = src.indexOf("function enrolledAuthors(");
    expect(fnStart, "enrolledAuthors is defined in lib/staff-compete.js").toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf("\nfunction ", fnStart + 1));
    expect(fnBody, "enrolledAuthors orders by nickname, then title — the ORDER BY the modal's stable listing rests on").toMatch(/ORDER BY u\.nickname, t\.title/);
  });

  test("the module's code table is frozen and spelled thus — and every route reaches the wire through it, never through a literal (source arm)", () => {
    // The strings are the client's contract; a rename on one side is a modal
    // that never opens. Pinned as literals so the module cannot drift alone —
    // and that alone is NOT "the table the routes answer with": a route
    // answering `code: "staff_compete_enrolled_staf"` would pass the table
    // pin and fail the behavioural arms above, which is where the codes are
    // driven by value (LOCKED, LOCKED_ENDED, UNSEALED_ASSIGNED, STAFF_ENROLLED,
    // AUTHOR_ENROLLED, COMPETITOR_EDIT here; UNSEALED, AUTHOR_COMPETES and
    // UNSEAL_IN_EVENT in the seal and writers files). The source scan below is
    // what holds the RE-SPELLING class for every code at once.
    expect(staffCompete.CODES).toEqual({
      LOCKED:            "staff_compete_locked",
      LOCKED_ENDED:      "staff_compete_locked_ended",
      UNSEALED_ASSIGNED: "staff_compete_unsealed_challenges",
      STAFF_ENROLLED:    "staff_compete_enrolled_staff",
      AUTHOR_ENROLLED:   "staff_compete_enrolled_authors",
      UNSEALED:          "staff_compete_unsealed",
      AUTHOR_COMPETES:   "staff_compete_author_competes",
      COMPETITOR_EDIT:   "competitor_cannot_edit",
      UNSEAL_IN_EVENT:   "answer_seal_in_compete_event",
    });
    expect(Object.isFrozen(staffCompete.CODES), "frozen — a route cannot re-point a code at runtime").toBe(true);

    // SOURCE: no `code:` literal anywhere outside the module spells one of
    // these codes; every emit goes through the table. Comments stripped first
    // (the module's own header and this file's quote the forbidden shape), and
    // the anti-vacuity floors are the real emit counts — a rename of the table
    // import would empty the positive match and pass in silence otherwise.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const root = path.join(__dirname, "..");
    const files = ["server.js", ...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`),
      ...fs.readdirSync(path.join(root, "lib")).filter(f => f.endsWith(".js") && f !== "staff-compete.js").map(f => `lib/${f}`)];
    const literal = /code:\s*["'`](staff_compete_|competitor_cannot_edit|answer_seal_in_compete_event)/;
    let tableRefs = 0;
    for (const f of files) {
      const src = stripJsComments(fs.readFileSync(path.join(root, f), "utf8"));
      const hit = src.match(literal);
      expect(hit, `${f}: a staff-compete code is spelled as a literal (${hit && hit[0]}) — use the module's CODES table`).toBeNull();
      tableRefs += (src.match(/STAFF_COMPETE_CODES\.[A-Z_]+/g) || []).length;
    }
    // Four today: the three switch refusals in routes/competitions.js and the
    // self-enroll author door; routes/challenges.js carries its codes through
    // the predicates' own `.code`, which is the table by another route.
    expect(tableRefs, "anti-vacuity: the routes reference the table by name (the three switch refusals plus the self-enroll author door)").toBeGreaterThanOrEqual(4);
    // …and the module's own responder emits from its table too.
    const mod = stripJsComments(fs.readFileSync(path.join(root, "lib", "staff-compete.js"), "utf8"));
    expect(mod, "refuseCompetitor answers with the table's code").toMatch(/code:\s*denial\.code/);
    expect(mod).not.toMatch(/code:\s*["'`]competitor_cannot_edit/);
  });
});
