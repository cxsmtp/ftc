"use strict";

// v8.7.0 — WHAT AN EVENT ADMIN MAY *READ*: submissions, rankings, analytics and
// the four exports.
//
// These are the surfaces where the scope is a FILTER rather than a gate, which
// makes them the ones that fail quietly. A refusal that goes missing is loud —
// somebody gets a 200 they should not have and the next assertion catches it. A
// FILTER that goes missing looks exactly like a correct answer: more rows, no
// error, nothing on any screen saying the actor is reading somebody else's
// event. So every positive assertion here carries a DECOY (`world.theirs`, plus
// the seeded platform fixtures, which are a third decoy for free) and every
// negative one carries a CONTROL — a superadmin making the identical call —
// because "the event admin was refused" is equally satisfied by a build that
// broke the route for everybody.
//
// THE ZERO-GRANT ACTOR IS TESTED WHEREVER A LIST IS NARROWED. `scopedCompetitionIds`
// answers `[]` for them and `IN ()` is a SQLite syntax error, so the naive
// `ids.length ? clause : ""` leaves the query UNFILTERED for exactly the actor
// who must see nothing — and on the platform-wide reads below, "unfiltered"
// means every submission, every challenge and every participant on the platform.
//
// THE ANALYTICS CACHE IS THE SHARPEST TEST IN THE FILE. Its lookup runs BEFORE
// every scope refusal in that handler, so a key built from `req.url` alone hands
// the previous caller's body straight back — which is a cross-TIER leak, not
// merely a stale one.
//
// Fixture note (the checklist): TWO challenges per event and only ONE of them
// solved, so the all-solved auto-end cannot fire and end an event under the
// tests. Every fixture is this file's own — the seeded alice/bob/carol are
// deliberately untouched, and appear only as decoys.

const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, PARTICIPANT_PASS } = require("./helpers");
const {
  H, uniq, buildWorld, makeParticipant, makeTask, assignTask, enrol, grantEventAdmin, expectRefused,
} = require("./event-admin-helpers");

const AN = "/api/admin/analytics/challenges";
const PUBLIC_DOMAIN = "public-domain";
const ACTIVITY = id => `/api/admin/export/competition-activity?competitionId=${encodeURIComponent(id)}`;

/**
 * Enter a competition as `who` and submit ONE correct answer.
 *
 * Every step asserts: a select that silently 400'd on the profile gate, or a
 * submit refused 409 for a missing grading token, leaves the participant with no
 * submission row at all — and then every "their event's submissions are present"
 * assertion below passes for the wrong reason, or fails naming the wrong thing.
 */
/**
 * Re-assert WHO the grantless actor is, immediately before asserting what they
 * may read.
 *
 * `buildWorld` checks this once at fixture time, which is a long way from here.
 * Every zero-grant assertion below is of the form "this actor sees nothing", and
 * a failure of that shape has two completely different causes — the scope filter
 * is missing, or the request was not made as that actor at all (a purged session,
 * a role that did not take). This makes the second one fail as a PRECONDITION,
 * naming itself, instead of arriving as a confusing row count.
 */
async function expectGrantless(api, label) {
  const me = await api.get("/api/admin/me");
  expect(me.ok(), `${label}: /api/admin/me ${me.status()}`).toBeTruthy();
  const b = await me.json();
  expect(b.isEventAdmin, `${label} must still hold the event-admin tier`).toBe(true);
  expect(b.eventAdminCompetitionCount, `${label} must still have NO grants`).toBe(0);
}

async function submitAs(who, competitionId, taskId, answer) {
  const { api, csrf } = await apiLogin(who.email, PARTICIPANT_PASS);
  try {
    const sel = await api.post("/api/select-competition", {
      headers: H(csrf), data: { competitionId },
    });
    expect(sel.ok(), `select-competition for ${who.email}: ${sel.status()} ${await sel.text()}`).toBeTruthy();

    // The grading token is REQUIRED since v7.20.9 — a submit without one is
    // 409 `task_changed` and stores nothing, which would look like a quiet event.
    const gradingHash = await gradingHashFor(api, taskId);
    expect(gradingHash, "GET /api/tasks/:id must issue a grading token").toBeTruthy();

    const r = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: H(csrf), data: { answer, gradingHash },
    });
    expect(r.ok(), `submit for ${who.email}: ${r.status()} ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    expect(b.correct, "the fixture's answer must actually grade CORRECT, or the row is not the one being asserted").toBe(true);
  } finally { await api.dispose(); }
}

test.describe("v8.7.0 — event-admin reporting: submissions, rankings, analytics, exports", () => {
  let w;
  let mineTask, mineUnsolved, theirsTask, theirsSecret, eaOwnTask, saPublicTask;
  let dual;
  let decoyAnswer;

  test.beforeAll(async () => {
    // No seedTestData() — tests/isolated-test.js re-seeds before every spec FILE
    // and the seed is not idempotent (its fixed competition names 409).
    w = await buildWorld();

    mineTask     = await makeTask(w.sa, w.saCsrf, "mine-solved");
    mineUnsolved = await makeTask(w.sa, w.saCsrf, "mine-unsolved");
    theirsTask   = await makeTask(w.sa, w.saCsrf, "theirs-solved");

    // The decoy's UNSOLVED challenge carries a distinctive correct answer, so the
    // tasks-export test can probe the serialised body BY VALUE as well as by
    // title — a leak that arrives under a different key still fails. Its own
    // positive control is the superadmin's copy of the same export.
    decoyAnswer = `decoy-secret-${uniq("ans")}`;
    theirsSecret = await makeTask(w.sa, w.saCsrf, "theirs-unsolved", { correct_answer: decoyAnswer });

    await assignTask(w.sa, w.saCsrf, mineTask.id,     [w.mine.id]);
    await assignTask(w.sa, w.saCsrf, mineUnsolved.id, [w.mine.id]);
    await assignTask(w.sa, w.saCsrf, theirsTask.id,   [w.theirs.id]);
    await assignTask(w.sa, w.saCsrf, theirsSecret.id, [w.theirs.id]);

    // A challenge the event admin OWNS and that is assigned NOWHERE — the
    // `created_by_id` arm of the visibility rule, which the assigned-to-my-event
    // arm would otherwise cover for and hide.
    eaOwnTask = await makeTask(w.eaApi, w.eaCsrf, "ea-own");

    // (c) THE THIRD VISIBILITY ARM, and the one nothing in this repo was
    // locking. The export does NOT call `taskViewDenied`: `_taskVisibilityScope`
    // (routes/export-import.js) is a SECOND, hand-written copy of the same
    // three-way rule, expressed as SQL because the export's attachment scan is
    // driven by the rows the query returns. Two copies of one rule is the drift
    // this repo keeps paying for, and only two of this copy's three arms had a
    // test — dropping its public-domain arm left the whole suite green while
    // every event admin's export silently lost the shared pool.
    //
    // Created by the SUPERADMIN and assigned to NO event, so neither the
    // created-by arm nor the used-by-my-event arm can cover for it.
    saPublicTask = await makeTask(w.sa, w.saCsrf, "public-domain");
    const tagRes = await w.sa.post(`/api/admin/tasks/${saPublicTask.id}/tags`, {
      headers: H(w.saCsrf), data: { tag: PUBLIC_DOMAIN },
    });
    expect(tagRes.ok(), `tag public-domain: ${tagRes.status()} ${await tagRes.text()}`).toBeTruthy();

    // A participant enrolled in BOTH events — the ONLY fixture that can
    // discriminate the participants export's MEMBERSHIP narrowing (`_mScope`).
    // Each exported participant carries a `competitions[]` resolved by NAME, so
    // left unscoped that file is a directory of every event on the platform. But
    // `world.inMine` belongs to exactly one event, so their list is
    // byte-identical whether or not the clause is applied: with only that
    // fixture the narrowing could be deleted outright and nothing would go red.
    dual = await makeParticipant(w.sa, w.saCsrf, "dual");
    await enrol(w.sa, w.saCsrf, w.mine.id, [dual.id]);
    await enrol(w.sa, w.saCsrf, w.theirs.id, [dual.id]);

    // Real activity in BOTH events. Without the decoy's own submission every
    // "the decoy is absent" assertion below is satisfied by a decoy that simply
    // has nothing to show.
    await submitAs(w.inMine,   w.mine.id,   mineTask.id,   "a");
    await submitAs(w.inTheirs, w.theirs.id, theirsTask.id, "a");

    // Preconditions, asserted rather than assumed: both events must still be
    // readable AS EVENTS by their own organiser / the superadmin, and the two
    // submissions must actually exist platform-wide.
    const all = await w.sa.get("/api/admin/submissions?limit=500");
    expect(all.ok(), `precondition read: ${all.status()}`).toBeTruthy();
    const names = (await all.json()).events.map(e => e.competition_name);
    expect(names, "the fixture must have put a submission in BOTH events").toEqual(
      expect.arrayContaining([w.mine.name, w.theirs.name]));
  });

  // ── Submissions ───────────────────────────────────────────────────────────

  test("submissions with NO competitionId are narrowed to the actor's events — decoy absent, superadmin CONTROL", async () => {
    // The no-competitionId branch is the PLATFORM-WIDE read: it is the branch an
    // event admin left unfiltered would see every submission on the platform
    // through, so it is the one worth an exact-set assertion rather than a
    // presence check.
    const r = await w.eaApi.get("/api/admin/submissions?limit=500");
    expect(r.ok(), `event-admin submissions: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const comps = [...new Set(body.events.map(e => e.competition_name))];

    expect(comps, `only the actor's own event may appear, saw ${JSON.stringify(comps)}`).toEqual([w.mine.name]);
    expect(body.events.some(e => e.nickname === w.inMine.nickname),
      "…and the row really is their participant's").toBeTruthy();

    // The COUNT is a second, independent query in this handler. A build that
    // filtered the rows and not the total renders "1 of 47" in the pager, which
    // is a disclosure about how much exists elsewhere.
    expect(body.total, "the reported total is narrowed too").toBe(body.events.length);

    // THE CONTROL.
    const c = await w.sa.get("/api/admin/submissions?limit=500");
    expect(c.ok(), `superadmin submissions: ${c.status()}`).toBeTruthy();
    const saComps = new Set((await c.json()).events.map(e => e.competition_name));
    expect(saComps.has(w.mine.name), "the superadmin sees the scoped event").toBe(true);
    expect(saComps.has(w.theirs.name), "…AND the decoy — so the endpoint is not simply broken").toBe(true);
  });

  test("a NAMED out-of-scope event is REFUSED on submissions, never silently narrowed", async () => {
    // Narrowing an out-of-scope competitionId to nothing renders as "this event
    // has no submissions", which an organiser cannot tell apart from a genuinely
    // quiet event. The 403 says which it is.
    const bad = await w.eaApi.get(`/api/admin/submissions?competitionId=${w.theirs.id}`);
    await expectRefused(bad, "submissions for a foreign event", "event_admin_out_of_scope");

    const good = await w.eaApi.get(`/api/admin/submissions?competitionId=${w.mine.id}`);
    expect(good.ok(), "the CONTROL PAIR: their own event IS readable by id").toBeTruthy();
    expect((await good.json()).events.length,
      "…and really carries rows, so the refusal above is about scope and not about emptiness").toBeGreaterThan(0);

    const c = await w.sa.get(`/api/admin/submissions?competitionId=${w.theirs.id}`);
    expect(c.ok(), "THE CONTROL: the superadmin still reads the decoy by id").toBeTruthy();
    expect((await c.json()).events.length,
      "…and the decoy really HAS rows, so the 403 above is about scope and not about an event nobody has touched")
      .toBeGreaterThan(0);
  });

  test("ZERO GRANTS SEES NO SUBMISSIONS — the empty-scope fail-open catcher", async () => {
    await expectGrantless(w.zeroApi, "the zero-grant actor");
    const r = await w.zeroApi.get("/api/admin/submissions?limit=500");
    expect(r.ok(), `zero-grant submissions: ${r.status()} ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    expect(b.events.length,
      `an event admin with NO grants must see nothing, saw ${JSON.stringify(b.events.map(e => e.competition_name))}`).toBe(0);
    expect(b.total, "the count is narrowed by the same clause").toBe(0);

    // THE CONTROL: without it, "zero rows" is equally satisfied by an endpoint
    // that returns nothing to anybody.
    const c = await w.sa.get("/api/admin/submissions?limit=500");
    expect((await c.json()).events.length, "the same read is NOT empty for a superadmin").toBeGreaterThan(0);
  });

  // ── Rankings ──────────────────────────────────────────────────────────────

  test("the admin ranking board refuses a foreign event and serves their own", async () => {
    // This route takes a single REQUIRED competitionId and has no platform-wide
    // mode to filter, so an out-of-scope id has no honest empty answer: `[]`
    // would read as "nobody has scored yet".
    const bad = await w.eaApi.get(`/api/admin/leaderboard?competitionId=${w.theirs.id}`);
    await expectRefused(bad, "rankings for a foreign event", "event_admin_out_of_scope");

    const good = await w.eaApi.get(`/api/admin/leaderboard?competitionId=${w.mine.id}`);
    expect(good.ok(), `own board: ${good.status()} ${await good.text()}`).toBeTruthy();
    const board = await good.json();
    expect(Array.isArray(board), "the admin board is a bare array").toBeTruthy();
    expect(board.some(e => e.nickname === w.inMine.nickname),
      `the participant who scored must be on it, saw ${JSON.stringify(board.map(e => e.nickname))}`).toBeTruthy();
    expect(board.some(e => e.nickname === w.inTheirs.nickname),
      "…and the decoy's participant must not be").toBeFalsy();

    // THE CONTROL: both boards still serve a superadmin — asserted BY NICKNAME,
    // not merely by length. "the decoy's participant is not on my board" is
    // otherwise satisfied by a nickname that appears on no board anywhere (a
    // fixture whose submit was refused, say); this says the name really is
    // findable on the board it belongs to.
    for (const [comp, who] of [[w.mine, w.inMine], [w.theirs, w.inTheirs]]) {
      const c = await w.sa.get(`/api/admin/leaderboard?competitionId=${comp.id}`);
      expect(c.ok(), `superadmin reads ${comp.name}: ${c.status()}`).toBeTruthy();
      expect((await c.json()).map(e => e.nickname),
        `${comp.name} really carries ${who.nickname}`).toContain(who.nickname);
    }
  });

  test("ZERO GRANTS reaches no ranking board at all", async () => {
    const r = await w.zeroApi.get(`/api/admin/leaderboard?competitionId=${w.mine.id}`);
    await expectRefused(r, "rankings for an actor with no grants", "event_admin_out_of_scope");
    const c = await w.sa.get(`/api/admin/leaderboard?competitionId=${w.mine.id}`);
    expect(c.ok(), "THE CONTROL: the same board still serves a superadmin").toBeTruthy();
  });

  // ── Analytics ─────────────────────────────────────────────────────────────

  test("platform-wide analytics are REFUSED for an event admin — and the superadmin still gets a body", async () => {
    const r = await w.eaApi.get(`${AN}?scope=global`);
    // 400 rather than 403: the request is malformed FOR THIS ACTOR — the remedy
    // is a different scope, not a different person — so `expectRefused` (which
    // asserts 403) is deliberately not used here.
    expect(r.status(), "scope=global is refused for an event admin").toBe(400);
    const b = await r.json();
    expect(b.code).toBe("event_admin_global_scope");
    expect(String(b.error || "").length, "the refusal names the remedy").toBeGreaterThan(20);
    expect(b.error).toMatch(/your own events/i);

    // THE CONTROL. Without it, "global is refused" is satisfied by a build in
    // which platform-wide analytics are refused to everybody.
    const c = await w.sa.get(`${AN}?scope=global`);
    expect(c.ok(), `superadmin global analytics: ${c.status()} ${await c.text()}`).toBeTruthy();
    expect((await c.json()).scope.type).toBe("global");
  });

  test("a competition scope outside their events is refused; their own succeeds", async () => {
    const bad = await w.eaApi.get(`${AN}?scope=competition&competitionId=${w.theirs.id}`);
    await expectRefused(bad, "analytics for a foreign event", "event_admin_out_of_scope");

    const good = await w.eaApi.get(`${AN}?scope=competition&competitionId=${w.mine.id}`);
    expect(good.ok(), `own analytics: ${good.status()} ${await good.text()}`).toBeTruthy();
    const b = await good.json();
    expect(b.scope.competition_id, "the body really is about the event that was asked for").toBe(w.mine.id);
    expect(b.summary, "a real body, not an empty shell").toBeTruthy();
    expect(Array.isArray(b.per_challenge)).toBeTruthy();
    // Deliberately NO assertion on the counts: `challenge_events` are written
    // POST-COMMIT via setImmediate on the submit path, so asserting a solve
    // count here would be racing the drain rather than testing the scope.

    // THE CONTROL.
    const c = await w.sa.get(`${AN}?scope=competition&competitionId=${w.theirs.id}`);
    expect(c.ok(), "the superadmin reads the decoy's analytics").toBeTruthy();
    expect((await c.json()).scope.competition_id).toBe(w.theirs.id);
  });

  test("ZERO GRANTS is refused platform-wide analytics too — [] is not null", async () => {
    // `scopedCompetitionIds(req) !== null` is the gate, so this catches a build
    // that only checked `ids.length` and let the grantless actor through to the
    // platform-wide aggregate.
    //
    // The query string is deliberately UNIQUE to this test. Share it with the
    // superadmin's platform-wide read above and a url-only analytics cache key
    // kills this test too — for the cache's reasons, under a message about the
    // grantless actor. The cache has its own test; this one owns the `[]` rule.
    const r = await w.zeroApi.get(`${AN}?scope=global&periodPreset=year`);
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("event_admin_global_scope");

    // THE CONTROL, on the byte-identical URL and AFTER the refusal above, so the
    // ordering still owns the `[]` rule rather than the cache's. Without it a
    // bare 400 is equally satisfied by a build that refuses this query string to
    // EVERYBODY — a rejected `periodPreset`, say — and the test would report a
    // scope rule that is not being enforced at all. It runs second because a
    // refusal is never cached, so it cannot warm an entry this test then reads.
    const c = await w.sa.get(`${AN}?scope=global&periodPreset=year`);
    expect(c.ok(), `superadmin on the identical URL: ${c.status()} ${await c.text()}`).toBeTruthy();
    expect((await c.json()).scope.type, "…and it really is the platform-wide body").toBe("global");
  });

  test("THE ANALYTICS CACHE DOES NOT CROSS TIERS", async () => {
    // The cache lookup runs BEFORE every scope refusal in this handler, so on a
    // key built from `req.url` alone the previous caller's body is handed
    // straight back. Three orderings, because they fail in three different
    // directions and only the first two are leaks.

    // (a) The superadmin warms a PLATFORM-WIDE body. The event admin's
    //     byte-identical URL must still be REFUSED rather than served it.
    //     This is the arm that actually catches a url-only key.
    const globalUrl = `${AN}?scope=global&periodPreset=all`;
    const warm = await w.sa.get(globalUrl);
    expect(warm.ok(), `warm superadmin global: ${warm.status()} ${await warm.text()}`).toBeTruthy();
    expect((await warm.json()).scope.type, "the entry really is a platform-wide one").toBe("global");

    const after = await w.eaApi.get(globalUrl);
    expect(after.status(),
      "a warmed platform-wide entry must not satisfy an event admin's identical query").toBe(400);
    expect((await after.json()).code).toBe("event_admin_global_scope");

    // (b) …and the sharper leak: a FOREIGN EVENT's body, i.e. real numbers about
    //     one specific event this actor has no remit over.
    const theirsUrl = `${AN}?scope=competition&competitionId=${w.theirs.id}&periodPreset=all`;
    const warm2 = await w.sa.get(theirsUrl);
    expect(warm2.ok(), `warm superadmin decoy analytics: ${warm2.status()}`).toBeTruthy();
    expect((await warm2.json()).scope.competition_id, "the entry is about the DECOY").toBe(w.theirs.id);

    const after2 = await w.eaApi.get(theirsUrl);
    await expectRefused(after2, "a warmed foreign-event analytics entry", "event_admin_out_of_scope");

    // (c) The reverse direction, which is not a leak but reads as data having
    //     vanished: an event admin's refusal must not be cached under the URL and
    //     then served to the superadmin.
    const monthUrl = `${AN}?scope=global&periodPreset=month`;
    const refused = await w.eaApi.get(monthUrl);
    expect(refused.status(), "precondition: the event admin really is refused this URL").toBe(400);
    const saAfter = await w.sa.get(monthUrl);
    expect(saAfter.ok(),
      "the superadmin's own platform-wide read survives an event admin's refusal on the same URL").toBeTruthy();
    expect((await saAfter.json()).scope.type).toBe("global");
  });

  test("THE ANALYTICS CACHE KEY CARRIES THE SCOPE, NOT ONLY THE ACTOR — a revoked grant stops reading immediately", async () => {
    // The actor half of the key is not enough. `invalidateEventAdminScope` clears
    // the scope cache and knows nothing about the analytics one, so on a key of
    // (actor + url) a revoked organiser keeps being served an entry computed
    // under their OLD scope for the rest of the 15 s TTL — still reading an event
    // they no longer organise. Putting the scope in the key makes that entry
    // unreachable rather than needing a second invalidator wired across two more
    // route files.
    //
    // It revokes from a PURPOSE-BUILT second organiser, never from `world.ea`:
    // every other test in this file depends on that grant, and a fixture broken
    // half way through a file is the contaminator pattern this repo keeps paying
    // for.
    const ea2 = await makeParticipant(w.sa, w.saCsrf, "revoked");
    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, ea2.id);
    const l = await apiLogin(ea2.email, PARTICIPANT_PASS);
    try {
      const url = `${AN}?scope=competition&competitionId=${w.mine.id}&periodPreset=6months`;

      const before = await l.api.get(url);
      expect(before.ok(), `the second organiser reads their event first: ${before.status()}`).toBeTruthy();
      expect((await before.json()).scope.competition_id).toBe(w.mine.id);

      const rev = await w.sa.delete(`/api/admin/competitions/${w.mine.id}/admins/${ea2.id}`, {
        headers: H(w.saCsrf),
      });
      expect(rev.ok(), `revoke: ${rev.status()} ${await rev.text()}`).toBeTruthy();
      expect((await rev.json()).remaining_events, "…leaving them with no events at all").toBe(0);

      // Immediately, and well inside the 15 s TTL — which is the whole point.
      const after = await l.api.get(url);
      await expectRefused(after, "the revoked organiser's identical query", "event_admin_out_of_scope");
    } finally { await l.api.dispose(); }

    // THE CONTROL: `world.ea`'s own grant is untouched by the revoke above, so
    // the rest of the file is still standing.
    const c = await w.eaApi.get(`${AN}?scope=competition&competitionId=${w.mine.id}`);
    expect(c.ok(), "the file's own event admin still reads their event").toBeTruthy();
  });

  // ── Exports ───────────────────────────────────────────────────────────────

  test("the tasks export carries only challenges this actor may see", async () => {
    const r = await w.eaApi.get("/api/admin/export/tasks");
    expect(r.ok(), `event-admin tasks export: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const titles = body.tasks.map(t => t.title);

    expect(titles, "(b) a challenge used by one of their events").toContain(mineTask.title);
    expect(titles).toContain(mineUnsolved.title);
    expect(titles, "(a) a challenge they created, assigned nowhere").toContain(eaOwnTask.title);
    expect(titles, "(c) a public-domain challenge — somebody else's, assigned to no event of theirs")
      .toContain(saPublicTask.title);
    expect(titles, "the DECOY event's challenge must be absent").not.toContain(theirsTask.title);
    expect(titles).not.toContain(theirsSecret.title);
    expect(titles.filter(t => t.startsWith("Challenge ")),
      "…and so must the seeded platform challenges").toEqual([]);

    // BY VALUE, not only by title: this file carries `correct_answer`, so a leak
    // arriving under a different key still fails here.
    expect(JSON.stringify(body).includes(decoyAnswer),
      "the decoy's correct answer must not appear anywhere in the file").toBeFalsy();

    // THE CONTROL — and it is also what proves the by-value probe can find that
    // string at all, without which "not found" is a vacuous assertion.
    const c = await w.sa.get("/api/admin/export/tasks");
    expect(c.ok(), `superadmin tasks export: ${c.status()}`).toBeTruthy();
    const saBody = await c.json();
    const saTitles = saBody.tasks.map(t => t.title);
    expect(saTitles, "the superadmin's export holds the decoy").toContain(theirsTask.title);
    expect(JSON.stringify(saBody).includes(decoyAnswer),
      "…and the probe string really is findable when it is present").toBeTruthy();
    // The seeded-challenge negative above needs its own findability control: if
    // the seed ever stopped titling its challenges "Challenge <key>", that
    // `.toEqual([])` would pass for ever while saying nothing.
    expect(saTitles.filter(t => t.startsWith("Challenge ")).length,
      "…and the seeded titles really exist to be excluded, or that assertion is vacuous").toBeGreaterThan(0);
  });

  test("a NAMED out-of-scope event is refused on the tasks export", async () => {
    const bad = await w.eaApi.get(`/api/admin/export/tasks?competitionId=${w.theirs.id}`);
    await expectRefused(bad, "the tasks export for a foreign event", "event_admin_out_of_scope");

    const good = await w.eaApi.get(`/api/admin/export/tasks?competitionId=${w.mine.id}`);
    expect(good.ok(), "the CONTROL PAIR: their own event exports").toBeTruthy();
    expect((await good.json()).tasks.map(t => t.title)).toContain(mineTask.title);

    const c = await w.sa.get(`/api/admin/export/tasks?competitionId=${w.theirs.id}`);
    expect(c.ok(), "THE CONTROL: the superadmin exports the decoy's challenges").toBeTruthy();
  });

  test("the participants export carries only people in this actor's events", async () => {
    // This file holds the platform's densest PII — every address, phone,
    // employer and lifecycle timestamp — so an unscoped export is the single
    // largest disclosure reachable from this tier.
    const r = await w.eaApi.get("/api/admin/export/participants");
    expect(r.ok(), `event-admin participants export: ${r.status()} ${await r.text()}`).toBeTruthy();
    const body = await r.json();
    const emails = body.participants.map(p => p.email);

    expect(emails.slice().sort(), `only their own events' participants may appear, saw ${JSON.stringify(emails)}`)
      .toEqual([w.inMine.email, dual.email].sort());
    expect(JSON.stringify(body).includes(w.inTheirs.email),
      "the decoy's address must not appear anywhere in the file").toBeFalsy();
    expect(JSON.stringify(body).includes("alice@acme.com"),
      "…nor the seeded platform participants'").toBeFalsy();

    // THE MEMBERSHIP ROWS ARE NARROWED TOO, and this is the only assertion in
    // the file that can see it. `_mScope` (routes/export-import.js) is a SECOND
    // clause, independent of the one that chooses WHICH PEOPLE appear: each
    // exported participant carries a `competitions[]` resolved by NAME, so left
    // unscoped this file is a directory of every event on the platform for
    // anyone who can reach the endpoint. `world.inMine` is in one event, so
    // their list is byte-identical either way — only the dual-enrolled fixture
    // can tell a narrowed file from an unnarrowed one.
    const dualRow = body.participants.find(p => p.email === dual.email);
    expect(dualRow, "the dual-enrolled participant must be in the file at all").toBeTruthy();
    const dualComps = (dualRow.competitions || []).map(x => x.competition_name);
    expect(dualComps, `their memberships are narrowed to the actor's own events, saw ${JSON.stringify(dualComps)}`)
      .toEqual([w.mine.name]);
    expect(JSON.stringify(body).includes(w.theirs.name),
      "…so the DECOY EVENT'S NAME appears nowhere in the file either").toBeFalsy();

    // THE CONTROL, which also proves every by-value probe above is not vacuous.
    const c = await w.sa.get("/api/admin/export/participants");
    expect(c.ok(), `superadmin participants export: ${c.status()}`).toBeTruthy();
    const saBody = await c.json();
    const saEmails = saBody.participants.map(p => p.email);
    expect(saEmails, "the superadmin's export holds the decoy").toContain(w.inTheirs.email);
    expect(saEmails, "…and the seeded participants, so excluding them above is a real statement")
      .toContain("alice@acme.com");
    expect(JSON.stringify(saBody).includes(w.inTheirs.email)).toBeTruthy();
    // The unnarrowed file DOES name the decoy event, on the dual-enrolled row —
    // which is what makes the two assertions above findings rather than
    // statements about a string that occurs nowhere.
    const saDual = saBody.participants.find(p => p.email === dual.email);
    expect(saDual, "the superadmin's export holds the dual-enrolled participant").toBeTruthy();
    expect((saDual.competitions || []).map(x => x.competition_name).slice().sort(),
      "…carrying BOTH memberships, unnarrowed").toEqual([w.mine.name, w.theirs.name].sort());
  });

  test("ZERO GRANTS EXPORTS NOTHING — both narrowed exports, the fail-open catcher", async () => {
    await expectGrantless(w.zeroApi, "the zero-grant actor");
    // `_participantVisibilityScope` must emit ` AND 1=0` here; the naive
    // "only filter when there are ids" yields the UNFILTERED export — every
    // participant's PII on the platform — for precisely this actor.
    const p = await w.zeroApi.get("/api/admin/export/participants");
    expect(p.ok(), `zero-grant participants export: ${p.status()} ${await p.text()}`).toBeTruthy();
    const pBody = await p.json();
    expect(pBody.participants.length,
      `must export nobody, exported ${JSON.stringify(pBody.participants.map(x => x.email))}`).toBe(0);

    // The tasks scope keeps its `created_by_id` / public-domain arms for a
    // grantless actor, and that is correct rather than incidental: they own
    // nothing, so the file must hold EXACTLY the public-domain pool and nothing
    // else. Asserted as that exact set, not as `length === 0` — which was a
    // statement about this file having no public-domain challenge rather than
    // about the rule, and would have passed against a build that dropped the
    // public-domain arm entirely.
    const t = await w.zeroApi.get("/api/admin/export/tasks");
    expect(t.ok(), `zero-grant tasks export: ${t.status()}`).toBeTruthy();
    const tBody = await t.json();
    expect(tBody.tasks.map(x => x.title),
      `a grantless actor exports the public-domain pool and NOTHING else, exported ${JSON.stringify(tBody.tasks.map(x => x.title))}`)
      .toEqual([saPublicTask.title]);

    // THE CONTROL: both exports are non-empty for a superadmin, so "zero rows"
    // cannot be satisfied by an endpoint that returns nothing to anybody.
    expect((await (await w.sa.get("/api/admin/export/participants")).json()).participants.length).toBeGreaterThan(0);
    expect((await (await w.sa.get("/api/admin/export/tasks")).json()).tasks.length).toBeGreaterThan(0);
  });

  test("the activity export is refused for a foreign event and served for their own", async () => {
    const bad = await w.eaApi.get(ACTIVITY(w.theirs.id));
    await expectRefused(bad, "the activity export for a foreign event", "event_admin_out_of_scope");

    const good = await w.eaApi.get(ACTIVITY(w.mine.id));
    expect(good.ok(), `own activity export: ${good.status()} ${await good.text()}`).toBeTruthy();
    const csv = await good.text();
    expect(csv, "the file names their own participant").toContain(w.inMine.nickname);
    expect(csv, "…and their own challenge").toContain(mineTask.title);
    expect(csv, "the decoy's participant must not be in it").not.toContain(w.inTheirs.nickname);
    expect(csv).not.toContain(theirsTask.title);

    const c = await w.sa.get(ACTIVITY(w.theirs.id));
    expect(c.ok(), "THE CONTROL: the superadmin exports the decoy's activity").toBeTruthy();
    expect(await c.text(), "…and it is a real file").toContain(w.inTheirs.nickname);
  });

  test("the whole-platform competitions export is FORBIDDEN outright", async () => {
    // Not narrowed, refused: a whole-table export with no scope has no scoped
    // equivalent, and the refusal names the one that exists.
    const r = await w.eaApi.get("/api/admin/export/competitions");
    const b = await expectRefused(r, "the competitions export", "event_admin_forbidden");
    expect(b.error, "the refusal names Export Activity as the scoped equivalent").toMatch(/Export Activity/i);

    // THE CONTROL.
    const c = await w.sa.get("/api/admin/export/competitions");
    expect(c.ok(), `superadmin competitions export: ${c.status()} ${await c.text()}`).toBeTruthy();
    const names = (await c.json()).competitions.map(x => x.name);
    expect(names, "and it really covers every event — which is why it is refused above").toEqual(
      expect.arrayContaining([w.mine.name, w.theirs.name]));
  });
});
