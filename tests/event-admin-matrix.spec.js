"use strict";

// v8.7.0 — THE EXHAUSTIVE ACTION MATRIX.
//
// This is the file somebody opens to answer "what can each role actually do?".
// ROLES_AND_PERMISSIONS.md is the prose answer; this is the executable one, and
// where the two disagree this file is what goes red.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIVE ROWS ARE FIVE (ACTOR, TARGET) PAIRS, NOT FIVE ACTORS
//
//   sa    superadmin              → acts on `theirs`
//   ga    admin (global)          → acts on `theirs`
//   ein   event_admin IN SCOPE    → acts on `mine`      (the event they organise)
//   eout  event_admin OUT OF SCOPE→ acts on `theirs`    (SAME PERSON as `ein`)
//   ezero event_admin ZERO GRANTS → acts on `mine`      (out of an EMPTY scope)
//
// `ein` and `eout` share one login on purpose: the event-admin tier is one
// account, and what separates the two rows is the ENTITY, not the identity. So
// the matrix reads down a column as "this person, on an event they run / on one
// they do not", which is the question an operator actually asks.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE CONTROLS ARE — and every refusal in this file has one
//
// A refusal cell is worthless on its own: "the event admin was refused" is
// equally satisfied by a build that broke the route for everybody. Both controls
// are CELLS OF THE SAME TABLE, on the SAME entity, which is stronger than a
// separate assertion:
//
//   eout is refused on `theirs`  ← controlled by sa and ga SUCCEEDING on `theirs`
//   ezero is refused on `mine`   ← controlled by ein SUCCEEDING on `mine`
//
// That is why `sa`/`ga` are pointed at the decoy rather than at their own
// throwaway events: a control that runs against a different row proves the route
// works *somewhere*, which is not the claim being made.
//
// The one exception is a DESTRUCTIVE action (delete, end-now, revoke), where a
// shared entity cannot survive five rows. Those get a per-row throwaway target
// and the control degrades to "structurally identical entity, different actor" —
// stated at each site rather than hidden.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ZERO-GRANT ROW IS THE FAIL-OPEN CATCHER
//
// `scopedCompetitionIds` answers `[]` for that actor, so the naive
// `ids.length ? clause : ""` leaves every narrowed query UNFILTERED for exactly
// the actor who must see nothing. It is therefore in every list cell, and its
// list assertions are COUNTS (`length === 0`), which is the only shape that can
// catch a dropped filter.
//
// The empty branch emits ` AND 1=0`, and both plausible alternatives are wrong —
// MEASURED, not assumed: `IN ()` is not standard SQL, and `IN (?)` with nothing
// bound throws `RangeError: Too few parameter values were provided`, i.e. a 500
// on the competitions list for the zero-grant actor. That is what this cell's
// "MUST SUCCEED" arm catches, and it is why the arm is not decoration.
//
// ─────────────────────────────────────────────────────────────────────────────
// A POSITIVE CELL NEEDS A DECOY, not just a 200. Every list assertion names an
// entity that must be ABSENT (`world.theirs`, `outsider`), because "the list
// contains my event" is equally satisfied by an unfiltered list.
//
// AND A NAMED DECOY IS NOT A TOTAL. "Contains mine, not theirs, not outsider" is
// equally satisfied by a list that ALSO leaked a fourth entity nobody thought to
// name, so the two list cells that can be totalled are:
//
//   list events        length === the scope the SERVER reports for this actor
//                      (`/api/admin/me`), never a literal — the scope
//                      legitimately widens to two events below
//   list participants  the set === the union of that actor's events' rosters,
//                      read back per event through the superadmin
//
// `list challenges` cannot be totalled (this file creates challenges as it runs),
// so it gets a THIRD decoy instead — `usedByTheirs`, the only fixture that is
// ASSIGNED, and assigned to the decoy event.
//
// A 2xx IS NOT A WRITE, either. Where the whole claim is that something changed,
// the change is read back through the SUPERADMIN — grant and revoke both check
// the organiser list, in BOTH directions, which is what the per-row victims are
// for; and impersonation asserts from `/api/me` INSIDE the window that the
// session really became the target, which the echoed response cannot show.
//
// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS VERIFIED, each killing its own cells and no others — because a matrix
// that has never been seen red is a picture, not a lock. 1-12 are the original
// set; 13-15 came with the assertions above and were ALSO run against the
// pre-hardening file, to show what it could not catch:
//
//   1  `scopeFilterSql`'s ` AND 1=0` → ""             → list events
//   2  the same fail-open in `_userInScopeSql`        → list participants
//   3  `competitionDenied` always allows              → 14 event-scoped tests
//   4  `taskEditDenied` always allows                 → edit other's challenge
//   5  `_taskVisibilitySql` drops its clause at []    → list challenges
//   6  `taskUnassignDenied` drops the assigner check  → unassign somebody else's
//   7  `participantDenied` always allows              → 5 participant tests
//   8  `groupDeleteDenied` always allows              → delete somebody else's group
//   9  `GET /api/admin/logs` leaves EVENT_ADMIN_FORBIDDEN → logs
//  10  the platform-wide analytics gate removed       → analytics (PLATFORM-WIDE)
//  11  `GET /api/admin/settings` 403s for EVERY tier, WITH the same
//      `event_admin_forbidden` code the event-admin rows expect
//                                                     → settings, on the SUPERADMIN
//      cell. This is the one that proves the control column is not decoration: a
//      build broken for everybody, wearing exactly the refusal this file is
//      looking for, is still caught.
//  12  `requireSuperAdmin` admits every admin tier    → all 7 superadmin-only cells
//
//  13  `_taskVisibilitySql`'s event arm loses its `AND _vct.competition_id IN
//      (…)` — "assigned to ANY event makes it visible"  → list challenges.
//      The pre-hardening file PASSES this: both its decoys are assigned to no
//      event at all, so nothing there could separate the two builds. Only
//      `usedByTheirs` can.
//  14  `POST …/impersonate` answers 200 and never assigns `req.session.userId`
//                                                        → both impersonate cells.
//      The pre-hardening file PASSES this too — the scope rule would have been
//      guarding an action that never happened.
//  15  the assign route's `INSERT OR IGNORE` reports `changes: 0` — a 200 that
//      assigned nothing → caught in `beforeAll` by `assignTask`, BY NAME. The
//      pre-hardening file also fails, but as "(b) a challenge used by an event
//      they run" and "unassign OWN assignment MUST SUCCEED": a visibility and a
//      provenance regression reported for a broken FIXTURE.

const { test, expect, request } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const {
  H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol,
  grantEventAdmin, buildWorld,
} = require("./event-admin-helpers");

const HOUR = 3_600_000;
const future = () => new Date(Date.now() + HOUR).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// The expectation mini-DSL. Declarative, so the table below reads as a table.
//
//   "ok"                → any 2xx/3xx
//   "403:<code>"        → 403 AND `body.code === <code>` (the machine answer the
//                         client branches on, not merely the status)
//   "403:superadmin"    → 403 from `requireSuperAdmin`, which carries NO `code` —
//                         so the wording is asserted instead. Passing these
//                         through to the route's own guard is deliberate
//                         (ROLES §3): the caller gets that guard's accurate
//                         message rather than a generic one from the gate.
//   "400:<code>"        → 400 AND `body.code`
// ─────────────────────────────────────────────────────────────────────────────
function parseExpect(spec) {
  if (spec === "ok") return { ok: true };
  const i = String(spec).indexOf(":");
  return i < 0
    ? { ok: false, status: Number(spec), code: null }
    : { ok: false, status: Number(spec.slice(0, i)), code: spec.slice(i + 1) };
}

/** Assert ONE cell, and return a short string for the printed summary. */
async function assertCell(actionName, row, res, spec) {
  const where = `${actionName} · ${row.label}`;
  const e = parseExpect(spec);
  const body = await res.text();
  if (e.ok) {
    expect(res.status(), `${where} MUST SUCCEED — got ${res.status()} ${body}`).toBeLessThan(400);
    return `ok(${res.status()})`;
  }
  expect(res.status(), `${where} must be ${e.status} — got ${res.status()} ${body}`).toBe(e.status);
  let b = {};
  try { b = JSON.parse(body); } catch (_) { /* a non-JSON refusal fails below */ }
  if (e.code === "superadmin") {
    // requireSuperAdmin emits no machine code, so the tier is asserted from the
    // wording — which is exactly what the passthrough exists to preserve.
    expect(String(b.error || ""), `${where} names the superadmin tier`).toMatch(/superadmin/i);
    return `${e.status}(superadmin)`;
  }
  if (e.code) expect(b.code, `${where} carries the machine code (error: ${b.error})`).toBe(e.code);
  // Every refusal an organiser meets has to say WHAT is withheld and WHO can do
  // it instead — an instruction that is not true is worse than none.
  expect(String(b.error || "").length, `${where} states a reason`).toBeGreaterThan(20);
  return `${e.status}(${b.code || "-"})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────
let W;            // buildWorld()
let FX;           // everything this file adds on top
let ACTORS;       // the four LOGINS — see refreshCsrf for why they are separate
let ROWS;         // the five (actor, target) pairs
const SUMMARY = [];   // printed at the end, one line per action

/**
 * A CSRF token follows the SESSION, and impersonation regenerates it twice
 * (entering, then exiting). So the token belongs to the ACTOR, never to the row:
 * `ein` and `eout` are one login, and holding a copy each meant one row's
 * impersonation silently invalidated the other's token — which surfaced as
 * `csrf_invalid` on a cell that was asserting a scope refusal, i.e. the right
 * status for entirely the wrong reason.
 *
 * `W.saCsrf` is the same hazard through a second door: the shared fixture
 * helpers are called as `makeTask(W.sa, W.saCsrf, …)` all over this file, so the
 * superadmin's rotated token has to be written back there too or every later
 * prep fails on a stale token.
 */
async function refreshCsrf(actor) {
  actor.csrf = (await (await actor.api.get("/api/csrf-token")).json()).csrfToken;
  if (actor.key === "sa") W.saCsrf = actor.csrf;
}

/**
 * Register WITHOUT verifying or approving — `makeParticipant` does both, and the
 * verify cell needs a target that has not been verified yet.
 */
async function registerRaw(sa, label) {
  const tag = uniq(label);
  const email = `eam-${tag}@acme.com`;
  const anon = await request.newContext({ baseURL: BASE });
  try {
    const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
    const reg = await registerPost(anon, "/api/register", {
      headers: H(csrf),
      data: {
        email, password: PARTICIPANT_PASS,
        nickname: `eam_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
        firstName: "Matrix", lastName: String(label), company: "Acme", title: "Engineer",
        country: "GB", timezone: "Europe/London",
      },
    });
    expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  } finally { await anon.dispose(); }
  const list = await sa.get("/api/admin/participants?limit=5000");
  const row = (await list.json()).participants.find(p => p.email === email);
  expect(row, `raw registration ${label} must be findable`).toBeTruthy();
  return { id: row.id, email };
}

/** Enter impersonation, then hand the actor their own session back. */
async function impersonateAndRestore(row, targetId) {
  const res = await row.api.post(`/api/admin/participants/${targetId}/impersonate`, { headers: H(row.csrf) });
  if (res.status() < 400) {
    // A 200 IS NOT THE CLAIM. "This actor is now acting AS that person" is, and a
    // build that answered 200 while leaving the session alone satisfies every
    // status assertion in both impersonation cells — so the scope rule would be
    // guarding an action that never happened. The response cannot tell the two
    // apart: the route composes `target` out of the id it was handed. The SESSION
    // can, so `/api/me` is read INSIDE the window.
    const started = await res.json().catch(() => ({}));
    expect(started.target && started.target.id, `${row.label}: the response names the intended target`)
      .toBe(targetId);
    // The session now belongs to the TARGET, so the token minted for the admin
    // session is gone with it. Refresh, exit, refresh — or every later cell for
    // this ACTOR runs as somebody else, or fails CSRF.
    await refreshCsrf(row.actor);
    const inside = await (await row.api.get("/api/me")).json();
    expect(inside.id || inside.userId, `${row.label}: the SESSION really became the target`)
      .toBe(targetId);
    const ex = await row.api.post("/api/impersonation/exit", { headers: H(row.csrf) });
    expect(ex.ok(), `${row.label} must get their own session back: ${ex.status()} ${await ex.text()}`).toBeTruthy();
    await refreshCsrf(row.actor);
    const me = await (await row.api.get("/api/admin/me")).json();
    expect(me.role, `${row.label} is themselves again after exiting impersonation`).toBe(row.expectedRole);
  }
  return res;
}

test.describe("v8.7.0 — the exhaustive role x action matrix", () => {

  test.beforeEach(() => { test.setTimeout(120_000); });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    // NOTE: no seedTestData(). tests/isolated-test.js re-seeds before every spec
    // FILE and the seed is not idempotent (its fixed competition names 409).
    W = await buildWorld();

    // ── the GLOBAL ADMIN row. buildWorld() does not provide one, and without it
    // every "the event admin was refused" cell is satisfied by a build that broke
    // the route for everybody. It is the control column.
    const gaUser = await makeParticipant(W.sa, W.saCsrf, "globaladmin");
    const roleRes = await W.sa.post(`/api/admin/participants/${gaUser.id}/role`, {
      headers: H(W.saCsrf), data: { role: "admin" },
    });
    expect(roleRes.ok(), `promote to admin: ${roleRes.status()} ${await roleRes.text()}`).toBeTruthy();
    const gaLogin = await apiLogin(gaUser.email, PARTICIPANT_PASS);

    // ── a THIRD event nobody in the table organises. `theirs` is the decoy for
    // the event admin; `outsider` is the decoy for everyone, which is what lets
    // "act on an event you do not run" be one shared entity across all five rows.
    const outsider = await makeCompetition(W.sa, W.saCsrf, "outsider");
    const inOutsider = await makeParticipant(W.sa, W.saCsrf, "inoutsider");
    await enrol(W.sa, W.saCsrf, outsider.id, [inOutsider.id]);

    // ── challenges owned by NOBODY in the table. Two of them, because the ga row
    // would otherwise be asked to edit a challenge it created itself.
    // `foreignBySa` carries created_by_id = NULL (the built-in superadmin has no
    // users row) — which ROLES §9.4 defines as "no event admin owns this", the
    // fail-closed default for every pre-feature row.
    const foreignByGa = await makeTask(gaLogin.api, gaLogin.csrf, "foreign-ga");
    const foreignBySa = await makeTask(W.sa, W.saCsrf, "foreign-sa");

    // ── the third visibility arm (ROLES §9.5). `public-domain` is an ordinary
    // task tag with a reserved meaning: it makes a challenge visible to EVERY
    // event admin, including one with no grants at all. Without a fixture for it
    // the challenge-list cell below would only ever exercise two of the rule's
    // three arms, and the arm that fails OPEN is the one nobody would notice.
    const publicTask = await makeTask(W.sa, W.saCsrf, "public-domain");
    const tagRes = await W.sa.post(`/api/admin/tasks/${publicTask.id}/tags`, {
      headers: H(W.saCsrf), data: { tag: "public-domain" },
    });
    expect(tagRes.ok(), `tag public-domain: ${tagRes.status()} ${await tagRes.text()}`).toBeTruthy();
    // One challenge each, owned by the two event-admin accounts, so the positive
    // half of the list assertion names a specific row rather than "something".
    const eaOwnTask = await makeTask(W.eaApi, W.eaCsrf, "ea-owns");
    const zeroOwnTask = await makeTask(W.zeroApi, W.zeroCsrf, "zero-owns");
    // A challenge the EA did not create, used by the event they DO run — arm (b).
    const usedByMine = await makeTask(W.sa, W.saCsrf, "used-by-mine");
    await assignTask(W.sa, W.saCsrf, usedByMine.id, [W.mine.id]);
    // ARM (b)'s NEGATIVE DIRECTION, and without it that arm is only ever asserted
    // in the direction that succeeds. `foreignBySa` / `foreignByGa` are assigned
    // to NO competition at all, so a build whose event arm forgot its
    // `AND _vct.competition_id IN (…)` — i.e. "assigned to ANY event makes it
    // visible" — returns exactly the same list as a correct one and every
    // not-contains below still passes. This challenge is assigned, and to the
    // DECOY, which is the only fixture that separates the two builds.
    const usedByTheirs = await makeTask(W.sa, W.saCsrf, "used-by-theirs");
    await assignTask(W.sa, W.saCsrf, usedByTheirs.id, [W.theirs.id]);

    // ── destructive-action targets, one per row (see the header: a shared entity
    // cannot survive five rows when the action removes it).
    const delComp = {};   // DELETE /competitions/:id — upcoming, so the live-event
    for (const k of ["sa", "rest"]) {                     // footprint rule is not in play
      delComp[k] = await makeCompetition(W.sa, W.saCsrf, `del-${k}`, { start_time: future() });
    }
    const endComp = {};   // POST /competitions/:id/end-now — must be LIVE
    for (const k of ["sa", "ga", "ein", "rest"]) {
      endComp[k] = await makeCompetition(W.sa, W.saCsrf, `end-${k}`);
    }
    // The event admin has to actually organise the one their in-scope cell ends.
    // This widens their scope to two events, which is why no list assertion below
    // hard-codes a length for that row — they compare against the scope the
    // server itself reports instead.
    await grantEventAdmin(W.sa, W.saCsrf, endComp.ein.id, W.ea.id);
    // v8.12.8 — POST /competitions/:id/late-entry/close — DESTRUCTIVE (it pins the
    // deadline and cannot be undone below the superadmin tier), so one Booth Event
    // per row, each ENDED by the superadmin's real End Now so its late-entry window
    // is OPEN. The in-scope row organises its own, which widens that event
    // admin's scope to THREE events — the count below is re-pointed for it.
    const closeComp = {};
    for (const k of ["sa", "ga", "ein", "rest"]) {
      closeComp[k] = await makeCompetition(W.sa, W.saCsrf, `close-${k}`, { event_kind: "booth" });
      const en = await W.sa.post(`/api/admin/competitions/${closeComp[k].id}/end-now`, { headers: H(W.saCsrf), data: {} });
      expect(en.ok(), `end ${k}: ${en.status()} ${await en.text()}`).toBeTruthy();
    }
    await grantEventAdmin(W.sa, W.saCsrf, closeComp.ein.id, W.ea.id);
    // ASSERTED, not assumed. `grantEventAdmin` only checks the 200; a grant that
    // answered 200 and inserted nothing would leave the `end event now` cell
    // failing for a reason that names the wrong thing, and would silently make
    // every "scope is two events" assertion below a one-event assertion.
    {
      const me = await (await W.eaApi.get("/api/admin/me")).json();
      expect(me.eventAdminCompetitionCount, "the second and third grants really widened the scope").toBe(3);
    }

    // ── grant / revoke victims. Both writers are global-admin-only, so only the
    // sa and ga cells reach a handler; the event-admin rows are refused by the
    // route gate before any user is looked up.
    //
    // THE TWO CELLS VERIFY BY READING THE ORGANISER LIST BACK, so a shared victim
    // makes the refused rows lie. `eout` acts on `theirs` — the same event the sa
    // and ga cells have just granted on — so with one victim its "a refused grant
    // wrote nothing" assertion finds the victim the PREVIOUS ROW put there and
    // fails against correct code. Each row that reaches a handler gets its own;
    // the three refused rows share one that is never granted anywhere, which is
    // what makes their absence assertion mean something.
    const grantVictim = {};
    for (const k of ["sa", "ga", "rest"]) {
      grantVictim[k] = await makeParticipant(W.sa, W.saCsrf, `grantvictim-${k}`);
    }
    // ONE PER ROW, for the reason the grant victims are one per row: both cells
    // read the organiser list back, and `ga` really does remove its victim — so a
    // shared victim makes every later row's "the grant survived the refusal"
    // assertion pass for the wrong reason (it is absent because a PREVIOUS ROW
    // took it out). With its own victim each refused row asserts the one thing it
    // is about: the organiser it was refused permission to remove is still there.
    const revokeVictim = {};
    for (const k of ["sa", "ga", "ein", "eout", "ezero"]) {
      revokeVictim[k] = await makeParticipant(W.sa, W.saCsrf, `revokevictim-${k}`);
      // On BOTH events, because the rows do not all act on the same one: `ein`
      // and `ezero` aim at `mine` while the rest aim at `theirs`, and the
      // assertion is scoped to `row.comp`. Granting only on `theirs` would make
      // "the grant survived the refusal" fail on correct code for exactly the two
      // rows the refusal is about.
      await grantEventAdmin(W.sa, W.saCsrf, W.theirs.id, revokeVictim[k].id);
      await grantEventAdmin(W.sa, W.saCsrf, W.mine.id, revokeVictim[k].id);
    }

    // ── participant-lifecycle targets.
    //
    // APPROVE reuses the already-enrolled participants, and that is forced rather
    // than lazy: "approve first, then assign" (v6.13.21) makes the bulk-assign
    // path SKIP an unapproved account, so an enrolled-but-unapproved participant
    // — the fixture a genuine approval transition would need — cannot be built
    // through the API at all. `participantDenied` runs above the already-approved
    // branch, so every refusal cell is real and the success cells still pass
    // through the guard; only the WRITE is the idempotent one. The approval
    // transition itself belongs to the participant-lifecycle specs.

    // A role change and a verify are refused by requireSuperAdmin — middleware,
    // above the handler — so every non-superadmin row is refused without the
    // target being read at all, and one shared target is honest.
    const roleTarget = await makeParticipant(W.sa, W.saCsrf, "roletarget");
    const verifyTarget = await registerRaw(W.sa, "verifytarget");
    // Delete is irreversible, so the row that SUCCEEDS gets its own.
    const deleteTarget = { sa: await makeParticipant(W.sa, W.saCsrf, "deltarget-sa"),
                           rest: await makeParticipant(W.sa, W.saCsrf, "deltarget-rest") };

    FX = {
      gaUser,
      outsider, inOutsider,
      foreignByGa, foreignBySa, publicTask, eaOwnTask, zeroOwnTask, usedByMine, usedByTheirs,
      delComp, endComp, closeComp, grantVictim, revokeVictim,
      roleTarget, verifyTarget, deleteTarget,
    };

    // FOUR logins for FIVE rows: `ein` and `eout` are the same account. Each row
    // reads its api/csrf THROUGH the actor, so a token rotated by one row is the
    // token the other row sends.
    ACTORS = {
      sa:   { key: "sa",   api: W.sa,        csrf: W.saCsrf,     role: "superadmin" },
      ga:   { key: "ga",   api: gaLogin.api, csrf: gaLogin.csrf, role: "admin" },
      ea:   { key: "ea",   api: W.eaApi,     csrf: W.eaCsrf,     role: "event_admin" },
      zero: { key: "zero", api: W.zeroApi,   csrf: W.zeroCsrf,   role: "event_admin" },
    };
    const mkRow = (key, label, actor, t) => ({
      key, label, actor,
      get api() { return this.actor.api; },
      get csrf() { return this.actor.csrf; },
      get expectedRole() { return this.actor.role; },
      ...t,
    });
    ROWS = [
      mkRow("sa", "superadmin", ACTORS.sa, {
        comp: W.theirs, participant: W.inTheirs, endComp: endComp.sa, closeComp: closeComp.sa, delComp: delComp.sa,
        revokeVictim: revokeVictim.sa, grantVictim: grantVictim.sa,
        deleteTarget: deleteTarget.sa, foreignTask: foreignByGa }),
      mkRow("ga", "admin (global)", ACTORS.ga, {
        comp: W.theirs, participant: W.inTheirs, endComp: endComp.ga, closeComp: closeComp.ga, delComp: delComp.rest,
        revokeVictim: revokeVictim.ga, grantVictim: grantVictim.ga,
        deleteTarget: deleteTarget.rest, foreignTask: foreignBySa }),
      mkRow("ein", "event_admin IN SCOPE", ACTORS.ea, {
        comp: W.mine, participant: W.inMine, endComp: endComp.ein, closeComp: closeComp.ein, delComp: delComp.rest,
        revokeVictim: revokeVictim.ein, grantVictim: grantVictim.rest,
        deleteTarget: deleteTarget.rest, foreignTask: foreignByGa }),
      mkRow("eout", "event_admin OUT OF SCOPE", ACTORS.ea, {
        comp: W.theirs, participant: W.inTheirs, endComp: endComp.rest, closeComp: closeComp.rest, delComp: delComp.rest,
        revokeVictim: revokeVictim.eout, grantVictim: grantVictim.rest,
        deleteTarget: deleteTarget.rest, foreignTask: foreignByGa }),
      mkRow("ezero", "event_admin ZERO GRANTS", ACTORS.zero, {
        comp: W.mine, participant: W.inMine, endComp: endComp.rest, closeComp: closeComp.rest, delComp: delComp.rest,
        revokeVictim: revokeVictim.ezero, grantVictim: grantVictim.rest,
        deleteTarget: deleteTarget.rest, foreignTask: foreignByGa }),
    ];

    // PRECONDITIONS, asserted rather than assumed — a fixture whose setup
    // silently failed reports the wrong thing about the product.
    const gaMe = await (await gaLogin.api.get("/api/admin/me")).json();
    expect(gaMe.role, "the control column really is a GLOBAL admin").toBe("admin");
    expect(gaMe.isEventAdmin, "…and is NOT an event admin").toBe(false);
    expect(ROWS[2].actor, "ein and eout are ONE login — the rows differ by target, not identity")
      .toBe(ROWS[3].actor);
  });

  test.afterAll(async () => {
    if (!SUMMARY.length) return;
    const cols = ["sa", "ga", "ein", "eout", "ezero"];
    const head = { sa: "superadmin", ga: "admin", ein: "ea IN SCOPE", eout: "ea OUT OF SCOPE", ezero: "ea ZERO GRANTS" };
    const pad = (v, n) => String(v).padEnd(n);
    const nameW = Math.max(...SUMMARY.map(x => x.name.length), 8) + 2;
    // Column widths from the CONTENT, so a long machine code cannot run into the
    // next column and make the whole table unreadable in a CI log.
    const cw = {};
    for (const c of cols) cw[c] = Math.max(head[c].length, ...SUMMARY.map(x => String(x.cells[c] ?? "-").length)) + 2;
    const rule = "-".repeat(nameW + cols.reduce((a, c) => a + cw[c], 0));
    const out = ["", "  EVENT-ADMIN ACTION MATRIX (v8.7.0) — the OBSERVED outcome of every cell",
                 "  " + pad("action", nameW) + cols.map(c => pad(head[c], cw[c])).join(""), "  " + rule];
    let group = null;
    for (const x of SUMMARY) {
      if (x.group !== group) { group = x.group; out.push("  " + group.toUpperCase()); }
      out.push("  " + pad(x.name, nameW) + cols.map(c => pad(x.cells[c] ?? "-", cw[c])).join(""));
    }
    out.push("  " + rule, "");
    console.log(out.join("\n"));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE TABLE. One entry per action; one test per entry; one assertion per CELL.
  //
  //   prep(row)  — build this row's own target where the action is destructive
  //   run(row,p) — make the call, return the APIResponse
  //   check      — an extra per-row assertion where a status code is not the
  //                whole answer (a LIST is filtered, never refused, so its status
  //                says nothing at all about scoping)
  // ───────────────────────────────────────────────────────────────────────────
  const OUT = "403:event_admin_out_of_scope";
  const FORBID = "403:event_admin_forbidden";
  const SUPER = "403:superadmin";

  const ACTIONS = [
    // ── EVENTS ──────────────────────────────────────────────────────────────
    {
      group: "events", name: "create event",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      // Refused by ROUTE, not by scope — so all three event-admin rows are
      // identical here, and the refusal must name the doors this tier DOES have
      // for making an event (a template, a clone of their own: operator ruling,
      // 14 Nov 2026), and refuse a blank event only.
      run: (row) => row.api.post("/api/admin/competitions", {
        headers: H(row.csrf),
        data: { name: `EA Matrix ${uniq(row.key)}`, start_time: future(), duration_minutes: 60, event_kind: "tournament" },
      }),
      each: async (row, res, spec) => {
        if (parseExpect(spec).code === "event_admin_forbidden") {
          const error = (await res.json()).error;
          expect(error, "the refusal names a template as this tier's way to start an event").toMatch(/template/i);
          expect(error, "…and a clone of one of their own events").toMatch(/clone/i);
          expect(error, "…and refuses a BLANK event, never every event").toMatch(/blank event/i);
        }
      },
    },
    {
      group: "events", name: "edit own event",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // An EMPTY body: every field is optional on the PUT, so this exercises the
      // whole write path — guard, concurrency check, audit — and changes nothing,
      // which is what lets sa, ga and eout all aim at the SAME decoy event and be
      // a same-entity control for one another.
      run: (row) => row.api.put(`/api/admin/competitions/${row.comp.id}`, { headers: H(row.csrf), data: {} }),
    },
    {
      group: "events", name: "edit other event",
      expect: { sa: "ok", ga: "ok", ein: OUT, eout: OUT, ezero: OUT },
      // ONE entity for all five rows — the strongest control shape in the file.
      run: (row) => row.api.put(`/api/admin/competitions/${FX.outsider.id}`, { headers: H(row.csrf), data: {} }),
    },
    {
      group: "events", name: "delete event",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      // Superadmin-only, and the gate PASSES IT THROUGH so requireSuperAdmin
      // answers with its own accurate wording. A regular admin cannot do this
      // either — which is the point: an event admin's per-event powers equal a
      // normal admin's, and hard delete is above both.
      run: (row) => row.api.delete(`/api/admin/competitions/${row.delComp.id}`, { headers: H(row.csrf) }),
    },
    {
      group: "events", name: "end event now",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // DESTRUCTIVE — per-row throwaway events, so the control is "the same call
      // on a structurally identical event succeeds for a global admin" rather
      // than the same-entity form used above.
      run: (row) => row.api.post(`/api/admin/competitions/${row.endComp.id}/end-now`, { headers: H(row.csrf) }),
    },
    {
      group: "events", name: "close late entries",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // v8.12.8 — DESTRUCTIVE, so per-row throwaway Booth Events (all ended, window
      // open). The ruling widens this ONE act to every admin tier and to an
      // organiser on their own event; the control for the two refusals is the
      // structurally identical event a global admin closes.
      run: (row) => row.api.post(`/api/admin/competitions/${row.closeComp.id}/late-entry/close`, { headers: H(row.csrf) }),
      each: async (row, res, spec) => {
        const b = await res.json().catch(() => ({}));
        if (parseExpect(spec).ok) expect(b.closed, `${row.label}: it really closed`).toBe(true);
      },
    },
    {
      group: "events", name: "list events",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      // A LIST IS FILTERED, NEVER REFUSED: an event admin simply has a shorter
      // table. So the status is not the assertion — the CONTENT is.
      run: (row) => row.api.get("/api/admin/competitions"),
      each: async (row, res) => {
        const names = (await res.json()).map(c => c.name);   // a bare array
        if (row.key === "ezero") {
          // THE FAIL-OPEN CATCHER. If `scopeFilterSql` degraded its empty branch
          // to "" this is every competition on the platform.
          expect(names.length, `zero grants must see NO events, saw ${JSON.stringify(names)}`).toBe(0);
          return;
        }
        if (row.key === "sa" || row.key === "ga") {
          expect(names, "a global actor sees both events").toContain(W.mine.name);
          expect(names, "…and the decoy").toContain(W.theirs.name);
          // The THIRD event too. The control's job is to show the list is
          // NARROWED for an organiser rather than broken for everyone, so it has
          // to see every event the organiser is denied, not merely one of them.
          expect(names, "…and the third event, which no row organises").toContain(FX.outsider.name);
          return;
        }
        // ein / eout are one person: they see `mine`, and neither decoy.
        expect(names, "the organiser sees their own event").toContain(W.mine.name);
        expect(names, "…and NOT the decoy — the DECOY is what makes this non-vacuous")
          .not.toContain(W.theirs.name);
        expect(names, "…nor the third event nobody in the table runs").not.toContain(FX.outsider.name);
        // AND THE LIST IS EXACTLY THE SCOPE, which a pair of named decoys is not:
        // a filter that leaked a fourth event nobody thought to name passes every
        // assertion above. The length is compared against the count the SERVER
        // reports for this actor rather than a literal, so the scope may widen
        // (it does — `endComp.ein`) without this becoming fixture arithmetic.
        const me = await (await row.api.get("/api/admin/me")).json();
        expect(names.length, `the event list IS the scope, saw ${JSON.stringify(names)}`)
          .toBe(me.eventAdminCompetitionCount);
      },
    },
    {
      group: "events", name: "read event history",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/competitions/${row.comp.id}/events`),
    },
    {
      group: "events", name: "reveal join link",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // The token is a capability: whoever holds it can enrol themselves and hand
      // it on. The read also MINTS lazily, so a refusal has to precede the write.
      run: (row) => row.api.get(`/api/admin/competitions/${row.comp.id}/self-enroll`),
    },
    {
      group: "events", name: "list event organisers",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/competitions/${row.comp.id}/admins`),
    },
    {
      group: "events", name: "grant event admin",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      // TWO INDEPENDENT GATES REFUSE THIS, AND NEITHER IS UNIQUELY PINNED —
      // measured, not assumed. The route is in `EVENT_ADMIN_FORBIDDEN`, so
      // `eventAdminGuard` answers before any handler middleware runs; and it also
      // carries `requireGlobalAdmin`. Removing EITHER alone leaves this cell green
      // (both mutations verified), because the survivor still refuses; it goes red
      // only when both go. So this locks the PROPERTY — an event admin cannot make
      // another event admin, which is what stops the role self-propagating — and
      // not either mechanism. Do not read a green run as covering the gate you are
      // about to delete.
      run: (row) => row.api.post(`/api/admin/competitions/${row.comp.id}/admins`, {
        headers: H(row.csrf), data: { userId: row.grantVictim.id },
      }),
      // A 2xx is not "the grant happened". Read the organiser list back through
      // the SUPERADMIN, so the verification does not depend on the very scope the
      // row is being tested for — and on a REFUSED row require the victim to be
      // absent, or "refused" is satisfied by a build that refuses and writes.
      each: async (row, res, spec) => {
        const list = await W.sa.get(`/api/admin/competitions/${row.comp.id}/admins`);
        expect(list.ok(), `read organisers back: ${list.status()}`).toBeTruthy();
        const admins = (await list.json()).admins.map(a => a.id);
        if (parseExpect(spec).ok) {
          expect(admins, `${row.label}: the grant is really on the event`).toContain(row.grantVictim.id);
        } else {
          expect(admins, `${row.label}: a refused grant wrote nothing`).not.toContain(row.grantVictim.id);
        }
      },
    },
    {
      group: "events", name: "revoke event admin",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      // A revoke of a grant that does not exist is a 404, so the two rows that
      // reach the handler get their own victim; the event-admin rows are stopped
      // by the gate before any lookup and share one.
      run: (row) => row.api.delete(`/api/admin/competitions/${row.comp.id}/admins/${row.revokeVictim.id}`, { headers: H(row.csrf) }),
      // Verified through the superadmin for the same reason as the grant above.
      // The REFUSED rows share one victim whose grant the `ga` row has already
      // removed, so only the success direction is checkable there — stated rather
      // than asserted, since "absent" would then be true for the wrong reason.
      each: async (row, res, spec) => {
        const list = await W.sa.get(`/api/admin/competitions/${row.comp.id}/admins`);
        expect(list.ok(), `read organisers back: ${list.status()}`).toBeTruthy();
        const admins = (await list.json()).admins.map(a => a.id);
        if (parseExpect(spec).ok) {
          expect(admins, `${row.label}: the revoke really removed the organiser`)
            .not.toContain(row.revokeVictim.id);
        } else {
          // A refusal that still removed the row — the v7.21.19 F1 shape, an
          // operation reported as a no-op that destroyed something. STATED AS
          // DEFENCE IN DEPTH rather than claimed as covered: these three rows are
          // stopped by the global gate BEFORE the handler, so no mutation that
          // leaves the gate in place can reach a delete, and one that removes the
          // gate is killed by the code assertion first. It is here for the day
          // the refusal moves INTO the handler, which is exactly how that class
          // arrives.
          expect(admins, `${row.label}: a refused revoke removed NOTHING`)
            .toContain(row.revokeVictim.id);
        }
      },
    },

    // ── CHALLENGES ──────────────────────────────────────────────────────────
    {
      group: "challenges", name: "create challenge",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      // Creating is free for every admin tier INCLUDING a zero-grant event admin:
      // there is no entity to scope, and ownership is what they get in return.
      run: (row) => row.api.post("/api/admin/tasks", {
        headers: H(row.csrf),
        data: { title: `EA Matrix task ${uniq(row.key)}`, description: "d", difficulty: "easy",
                answer_type: "text", correct_answer: "a", status: "published" },
      }),
    },
    {
      group: "challenges", name: "list challenges",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      // THE THREE-WAY VISIBILITY RULE, at the surface where it is expressed as
      // SQL rather than as the predicate — a deliberate mirror, so it is the one
      // that can drift. All three arms are asserted, and the ZERO-GRANT row keeps
      // its own: `[]` is not `null`, so that actor loses only the event arm and
      // must still see what they created and what is public-domain. A build that
      // dropped the whole clause for them would show every challenge on the
      // platform, which is what the two not-contains catch.
      run: (row) => row.api.get("/api/admin/tasks"),
      each: async (row, res) => {
        const ids = (await res.json()).map(t => t.id);   // a bare array
        if (row.key === "sa" || row.key === "ga") {
          expect(ids, "a global actor sees the whole challenge bank").toContain(FX.foreignBySa.id);
          expect(ids, "…including one created by another admin").toContain(FX.foreignByGa.id);
          return;
        }
        expect(ids, "(c) public-domain is visible to EVERY event admin").toContain(FX.publicTask.id);
        expect(ids, "(a) …as is what they created themselves")
          .toContain(row.key === "ezero" ? FX.zeroOwnTask.id : FX.eaOwnTask.id);
        if (row.key === "ezero") {
          // No grants, so arm (b) contributes nothing — and the challenge used by
          // `mine` is therefore invisible to them even though an organiser of
          // `mine` sees it two lines down.
          expect(ids, "a zero-grant actor gets NO event arm").not.toContain(FX.usedByMine.id);
        } else {
          expect(ids, "(b) a challenge used by an event they run").toContain(FX.usedByMine.id);
        }
        // THE DECOY on both sides: neither foreign challenge is theirs, is used
        // by an event they run, or is public-domain.
        expect(ids, "not a challenge created by somebody else").not.toContain(FX.foreignBySa.id);
        expect(ids, "…nor another admin's").not.toContain(FX.foreignByGa.id);
        // ARM (b)'s OTHER DIRECTION. The two decoys above are assigned to NO
        // event, so they cannot tell "used by an event I run" from "used by any
        // event at all". This one IS assigned — to the decoy event — so it is the
        // only row here that fails when the event arm loses its competition
        // filter, and it applies to the zero-grant actor too (who has no event
        // arm at all and must therefore never reach it by any route).
        expect(ids, "a challenge used ONLY by an event they do not run stays hidden")
          .not.toContain(FX.usedByTheirs.id);
      },
    },
    {
      group: "challenges", name: "edit own challenge",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      // OWNER-ONLY is a rule about ownership, not about scope — so the zero-grant
      // row succeeds here, and that cell is the one worth reading.
      prep: (row) => makeTask(row.api, row.csrf, `own-edit-${row.key}`),
      run: (row, t) => row.api.put(`/api/admin/tasks/${t.id}`, {
        headers: H(row.csrf), data: { title: `${t.title} edited` },
      }),
    },
    {
      group: "challenges", name: "edit other's challenge",
      expect: { sa: "ok", ga: "ok", ein: "403:event_admin_not_owner",
                eout: "403:event_admin_not_owner", ezero: "403:event_admin_not_owner" },
      // A COSMETIC edit, so this is `taskEditDenied` (owner-only) rather than the
      // stricter scoring gate. Each row gets a challenge it did not create.
      run: (row) => row.api.put(`/api/admin/tasks/${row.foreignTask.id}`, {
        headers: H(row.csrf), data: { title: `${row.foreignTask.title} ${uniq(row.key)}` },
      }),
    },
    {
      group: "challenges", name: "publish own challenge",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      // Publishing flips `status`, a SCORING field, so it takes the strict gate —
      // which degrades to the owner rule here because a draft is assigned to
      // nothing. That degradation is the ordinary case and it is what makes this
      // cell "ok" for every row.
      prep: (row) => makeTask(row.api, row.csrf, `pub-${row.key}`, { status: "draft" }),
      run: (row, t) => row.api.post(`/api/admin/tasks/${t.id}/publish`, { headers: H(row.csrf) }),
    },
    {
      group: "challenges", name: "delete challenge",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      // Superadmin-only for EVERY tier. An event admin unpublishes or hides
      // instead; granting hard delete would make them more powerful than a
      // regular admin in that one respect.
      prep: (row) => makeTask(W.sa, W.saCsrf, `del-${row.key}`),
      run: (row, t) => row.api.delete(`/api/admin/tasks/${t.id}`, { headers: H(row.csrf) }),
    },
    {
      group: "challenges", name: "assign own challenge to own event",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      prep: (row) => makeTask(row.api, row.csrf, `asg-own-${row.key}`),
      run: (row, t) => row.api.post(`/api/admin/tasks/${t.id}/competitions`, {
        headers: H(row.csrf), data: { competitionIds: [row.comp.id] },
      }),
    },
    {
      group: "challenges", name: "assign own challenge to OTHER event",
      expect: { sa: "ok", ga: "ok", ein: OUT, eout: OUT, ezero: OUT },
      // One shared destination for all five rows: same-entity control again.
      prep: (row) => makeTask(row.api, row.csrf, `asg-out-${row.key}`),
      run: (row, t) => row.api.post(`/api/admin/tasks/${t.id}/competitions`, {
        headers: H(row.csrf), data: { competitionIds: [FX.outsider.id] },
      }),
    },
    {
      group: "challenges", name: "unassign OWN assignment",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // For the rows that can assign, the row makes the assignment itself, so
      // `competition_tasks.assigned_by_id` really is theirs. For the two rows that
      // cannot assign anywhere, the superadmin makes it — they are refused on
      // SCOPE, before the assigner is even read, which is why the code differs
      // from the row below.
      prep: async (row) => {
        const t = await makeTask(row.api, row.csrf, `unasg-own-${row.key}`);
        const canAssign = ["sa", "ga", "ein"].includes(row.key);
        if (canAssign) await assignTask(row.api, row.csrf, t.id, [row.comp.id]);
        else await assignTask(W.sa, W.saCsrf, t.id, [row.comp.id]);
        return t;
      },
      run: (row, t) => row.api.delete(`/api/admin/tasks/${t.id}/competitions/${row.comp.id}`, { headers: H(row.csrf) }),
    },
    {
      group: "challenges", name: "unassign SOMEBODY ELSE'S assignment",
      expect: { sa: "ok", ga: "ok", ein: "403:event_admin_not_assigner", eout: OUT, ezero: OUT },
      // ROLES §9.3, and the sharpest cell in this group: `ein` MANAGES the event
      // and can SEE the challenge, and is still refused, because the assignment
      // was made by somebody else and removing it shrinks a leaderboard input
      // they did not add. `eout`/`ezero` fail earlier, on scope — two different
      // refusals for what looks like one action.
      prep: async (row) => {
        // The assigner is the GLOBAL ADMIN, not the built-in superadmin, for every
        // row that can have one. The built-in account has no `users` row, so it
        // writes `assigned_by_id = NULL` — and NULL is refused by a check that
        // merely tests for a value, which is a weaker claim than the one ROLES
        // §9.3 makes ("somebody ELSE's assignment"). With a real id on the row the
        // refusal can only come from comparing it to this actor. The NULL case is
        // covered in `event-admin-challenges.api.spec.js`.
        const asg = row.key === "ga" ? ACTORS.sa : ACTORS.ga;
        const t = await makeTask(asg.api, asg.csrf, `unasg-other-${row.key}`);
        await assignTask(asg.api, asg.csrf, t.id, [row.comp.id]);
        return t;
      },
      run: (row, t) => row.api.delete(`/api/admin/tasks/${t.id}/competitions/${row.comp.id}`, { headers: H(row.csrf) }),
    },

    // ── PARTICIPANTS ────────────────────────────────────────────────────────
    {
      group: "participants", name: "list participants",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      run: (row) => row.api.get("/api/admin/participants?limit=5000"),
      each: async (row, res) => {
        const ids = (await res.json()).participants.map(p => p.id);
        if (row.key === "ezero") {
          // The empty-scope catcher again, on the directory that would otherwise
          // hand a zero-grant actor every account on the platform.
          expect(ids.length, `zero grants must see NO participants, saw ${ids.length}`).toBe(0);
          return;
        }
        if (row.key === "sa" || row.key === "ga") {
          expect(ids, "a global actor sees the whole directory").toContain(W.inMine.id);
          expect(ids, "…including the decoy's participant").toContain(W.inTheirs.id);
          expect(ids, "…and the third event's, which the organiser is denied")
            .toContain(FX.inOutsider.id);
          return;
        }
        expect(ids, "the organiser sees people in their own event").toContain(W.inMine.id);
        expect(ids, "…and NOT somebody enrolled only in the decoy").not.toContain(W.inTheirs.id);
        expect(ids, "…nor in the third event").not.toContain(FX.inOutsider.id);
        // AND NOBODY ELSE AT ALL. Three named decoys cannot see a leak of an
        // account nobody thought to name — a global admin, the zero-grant event
        // admin, this actor themselves — and "enrolled in one of my events" is a
        // rule about a SET, so the set is what gets asserted. The expected set is
        // read from the SERVER, per scoped event, by the superadmin, so it stays
        // true as the fixture grows instead of hard-coding today's roster.
        const scope = await (await row.api.get("/api/admin/competitions")).json();
        const expected = new Set();
        for (const c of scope) {
          const roster = await W.sa.get(`/api/admin/participants?competitionId=${c.id}&limit=5000`);
          expect(roster.ok(), `roster for ${c.name}: ${roster.status()}`).toBeTruthy();
          for (const p of (await roster.json()).participants) expected.add(p.id);
        }
        expect([...ids].sort(), "the directory IS the union of their events' rosters")
          .toEqual([...expected].sort());
      },
    },
    {
      group: "participants", name: "approve participant IN the row's event",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // The scope check runs BEFORE the already-approved branch, so the target
      // being enrolled-and-approved costs the refusal cells nothing and the
      // success cells still go through the guard (see the fixture note above for
      // why an enrolled-but-unapproved participant cannot be built).
      run: (row) => row.api.post(`/api/admin/participants/${row.participant.id}/approve`, { headers: H(row.csrf) }),
    },
    {
      group: "participants", name: "approve participant in an event the row does NOT run",
      expect: { sa: "ok", ga: "ok", ein: OUT, eout: OUT, ezero: OUT },
      run: (row) => row.api.post(`/api/admin/participants/${FX.inOutsider.id}/approve`, { headers: H(row.csrf) }),
    },
    {
      group: "participants", name: "read participant history",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/participants/${row.participant.id}/events`),
    },
    {
      group: "participants", name: "change a role",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      // Posting the role a user already has is still a real write (it re-applies
      // the staff tag), so this exercises the route rather than a no-op branch —
      // and a REGULAR admin is refused too, which is the control that says this
      // is a tier rule and not an event-admin one.
      run: (row) => row.api.post(`/api/admin/participants/${FX.roleTarget.id}/role`, {
        headers: H(row.csrf), data: { role: "participant" },
      }),
    },
    {
      group: "participants", name: "verify an account",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      run: (row) => row.api.post(`/api/admin/participants/${FX.verifyTarget.id}/verify`, { headers: H(row.csrf) }),
    },
    {
      group: "participants", name: "delete an account",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      run: (row) => row.api.delete(`/api/admin/participants/${row.deleteTarget.id}`, { headers: H(row.csrf) }),
    },
    {
      group: "participants", name: "impersonate IN scope",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // Impersonation assumes the person's identity EVERYWHERE, including events
      // this actor does not manage — which is what would make it a way around
      // every other predicate in the file if it were not scoped.
      run: (row) => impersonateAndRestore(row, row.participant.id),
    },
    {
      group: "participants", name: "impersonate OUT of scope",
      expect: { sa: "ok", ga: "ok", ein: OUT, eout: OUT, ezero: OUT },
      run: (row) => impersonateAndRestore(row, FX.inOutsider.id),
    },

    // ── GROUPS ──────────────────────────────────────────────────────────────
    {
      group: "groups", name: "create group",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      run: (row) => row.api.post("/api/admin/groups", {
        headers: H(row.csrf), data: { name: `EA Grp ${uniq(row.key)}` },
      }),
    },
    {
      group: "groups", name: "delete OWN group",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: "ok", ezero: "ok" },
      // CREATOR-ONLY, so — like editing your own challenge — a zero-grant event
      // admin succeeds. Ownership is not scope.
      prep: async (row) => {
        const r = await row.api.post("/api/admin/groups", {
          headers: H(row.csrf), data: { name: `EA Grp own ${uniq(row.key)}` },
        });
        expect(r.ok(), `create own group (${row.label}): ${r.status()} ${await r.text()}`).toBeTruthy();
        return (await r.json()).group.id;
      },
      run: (row, gid) => row.api.delete(`/api/admin/groups/${gid}`, { headers: H(row.csrf) }),
    },
    {
      group: "groups", name: "delete SOMEBODY ELSE'S group",
      expect: { sa: "ok", ga: "ok", ein: "403:event_admin_not_owner",
                eout: "403:event_admin_not_owner", ezero: "403:event_admin_not_owner" },
      // Destructive, so one throwaway group per row, each created by an actor
      // that is not this row.
      prep: async (row) => {
        const owner = row.key === "sa" ? ACTORS.ga : ACTORS.sa;
        const r = await owner.api.post("/api/admin/groups", {
          headers: H(owner.csrf), data: { name: `EA Grp foreign ${uniq(row.key)}` },
        });
        expect(r.ok(), `create foreign group: ${r.status()} ${await r.text()}`).toBeTruthy();
        return (await r.json()).group.id;
      },
      run: (row, gid) => row.api.delete(`/api/admin/groups/${gid}`, { headers: H(row.csrf) }),
    },

    // ── REPORTING ───────────────────────────────────────────────────────────
    {
      group: "reporting", name: "submissions (row's event)",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      // A NAMED event is REFUSED, never narrowed to nothing: an empty result is
      // indistinguishable from a genuinely quiet event, and the 403 says which.
      run: (row) => row.api.get(`/api/admin/submissions?competitionId=${row.comp.id}`),
    },
    {
      group: "reporting", name: "rankings (row's event)",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/leaderboard?competitionId=${row.comp.id}`),
    },
    {
      group: "reporting", name: "analytics (row's event)",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${row.comp.id}`),
    },
    {
      group: "reporting", name: "analytics (PLATFORM-WIDE)",
      expect: { sa: "ok", ga: "ok", ein: "400:event_admin_global_scope",
                eout: "400:event_admin_global_scope", ezero: "400:event_admin_global_scope" },
      // 400, not 403, and the distinction is deliberate: the request is malformed
      // FOR THIS ACTOR — the remedy is a different scope, not a different person.
      run: (row) => row.api.get("/api/admin/analytics/challenges?scope=global"),
    },
    {
      group: "reporting", name: "logs",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      run: (row) => row.api.get("/api/admin/logs"),
    },
    {
      group: "reporting", name: "settings",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      run: (row) => row.api.get("/api/admin/settings"),
    },
    {
      group: "reporting", name: "metrics",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      run: (row) => row.api.get("/metrics"),
    },
    {
      group: "reporting", name: "export competitions (whole platform)",
      expect: { sa: "ok", ga: "ok", ein: FORBID, eout: FORBID, ezero: FORBID },
      // The refusal has to name the scoped equivalent, or it is a dead end.
      run: (row) => row.api.get("/api/admin/export/competitions"),
      each: async (row, res, spec) => {
        if (parseExpect(spec).code === "event_admin_forbidden") {
          expect((await res.json()).error, "the refusal names Export Activity as the scoped remedy")
            .toMatch(/export activity/i);
        }
      },
    },
    {
      group: "reporting", name: "export activity (row's event)",
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/export/competition-activity?competitionId=${row.comp.id}`),
    },
    {
      group: "reporting", name: "free-text responses (row's event)",
      // v8.9.0 — the JSON the focused participants CSV reads. Same scope shape as
      // the activity export beside it; unlike that one it has NO status gate, so
      // the in-scope cell is "ok" whatever state the row's event is in.
      expect: { sa: "ok", ga: "ok", ein: "ok", eout: OUT, ezero: OUT },
      run: (row) => row.api.get(`/api/admin/competitions/${row.comp.id}/free-text-responses`),
    },
    {
      group: "reporting", name: "import challenges",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      // An EMPTY envelope: the shape is valid, so the tier guard is what decides,
      // and nothing is written whichever way it goes.
      run: (row) => row.api.post("/api/admin/import/tasks", {
        headers: H(row.csrf), data: { data: { type: "hackarena-tasks", tasks: [] } },
      }),
    },
    {
      group: "reporting", name: "import participants",
      expect: { sa: "ok", ga: SUPER, ein: SUPER, eout: SUPER, ezero: SUPER },
      run: (row) => row.api.post("/api/admin/import/participants", {
        headers: H(row.csrf), data: { data: { type: "hackarena-participants", participants: [] } },
      }),
    },
  ];

  for (const action of ACTIONS) {
    test(`${action.group}: ${action.name}`, async () => {
      const cells = {};
      for (const row of ROWS) {
        const prepped = action.prep ? await action.prep(row) : undefined;
        const res = await action.run(row, prepped);
        const spec = action.expect[row.key];
        expect(spec, `every row needs a declared expectation (${action.name} · ${row.key})`).toBeTruthy();
        cells[row.key] = await assertCell(action.name, row, res, spec);
        if (action.each) await action.each(row, res, spec);
      }
      SUMMARY.push({ group: action.group, name: action.name, cells });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The tier that is NOT in the loop.
  //
  // A participant does not reach /api/admin at all — there is no scope to test,
  // only the gate — so it gets one test rather than a column. The CONTROL is the
  // same account succeeding on a participant endpoint in the same session: "the
  // admin routes refused them" is otherwise equally satisfied by a dead session.
  // ───────────────────────────────────────────────────────────────────────────
  test("participant: the admin surface does not exist for them at all", async () => {
    const p = await makeParticipant(W.sa, W.saCsrf, "plainparticipant");
    const { api } = await apiLogin(p.email, PARTICIPANT_PASS);

    // `/api/admin/me` answers 401, not 403, and the difference is deliberate: it is
    // an IDENTITY PROBE (`_IDENTITY_PROBE_PATHS`), so "you are not an admin" is
    // reported as not-authenticated — which is also what keeps an anonymous boot's
    // two 401s off the scanner-reputation counter (v8.3.13). Everything else is
    // `requireAdmin`'s 403. Both are asserted by VALUE so a change to either has
    // to be a decision.
    const gates = [
      ["/api/admin/me", 401],
      ["/api/admin/competitions", 403],
      ["/api/admin/participants", 403],
      ["/api/admin/tasks", 403],
      ["/api/admin/groups", 403],
      ["/metrics", 403],
    ];
    for (const [path, status] of gates) {
      const r = await api.get(path);
      expect(r.status(), `${path} must be refused for a participant`).toBe(status);
      // NOT the event-admin gate — the TIER gate answers first, so a participant
      // never sees a role-specific code. If this ever became
      // `event_admin_unclassified` the guard would be running for the wrong tier
      // entirely, on an actor that holds no admin session at all.
      // `.catch(() => ({}))` would make the next line pass on a body that never
      // parsed — an absent `code` is exactly what an empty object yields — so the
      // refusal is required to be a real JSON envelope with a reason FIRST. Both
      // gates emit one (measured), so this cannot be relaxed by accident.
      const b = await r.json().catch(() => null);
      expect(b, `${path} answers a JSON refusal`).toBeTruthy();
      expect(typeof b.error, `${path} states a reason`).toBe("string");
      expect(b.error.length, `${path} states a reason`).toBeGreaterThan(0);
      expect(b.code, `${path} is refused by the TIER gate, not the event-admin one`).toBeUndefined();
    }

    // THE CONTROL: the session is alive and the account works.
    const me = await api.get("/api/me");
    expect(me.ok(), `the participant's own endpoint still serves them: ${me.status()}`).toBeTruthy();
    expect((await me.json()).isEventAdmin, "a participant is not an event admin").toBe(false);
    await api.dispose();
  });
});
