// @ts-check
//
// v7.21.9 — A PERMANENT SNAPSHOT MUST NOT BE TAKEN THROUGH A 5-SECOND CACHE.
//
// `buildLeaderboardEntries` serves from `_leaderboardCache` for up to 5 s. That
// is a correct freshness/perf trade for a POLL and a wrong one for a PERSIST,
// and three places persist:
//
//   • freezeGroupLeaderboardSnapshots  → group_leaderboard_snapshots, written
//     INSERT-OR-IGNORE and cleared only by a revive, so the FIRST write is the
//     official Team Rankings for ever;
//   • the lazy freeze inside buildGroupLeaderboard, which persists identically;
//   • the badge mint → achievement_badges.rank / score_snapshot, rendered for
//     ever by a PUBLIC OpenGraph page and the certificate PDF.
//
// The old shape asked every CALLER to invalidate the cache first. Three of the
// eleven freeze sites did. On the submit-path auto-end the miss is not even a
// race: every earlier submit invalidates the cache on its way out, so any entry
// alive at freeze time necessarily predates the very submission that ENDED the
// competition — the deciding solve is guaranteed to be missing from the frozen
// board. Scores do not move; RANKS do, on standings that are supposed to be
// final, and the individual board (recomputed live) then visibly disagrees with
// the team board on the same screen.
//
// The fix is an `opts.fresh` bypass INSIDE buildLeaderboardEntries, used by the
// persisting paths — so it cannot be forgotten by the next call site, and it
// does not clear a cache other in-flight readers are legitimately using.
//
// Two more defects in the same subsystem are covered here:
//   • deleting the last upcoming session ENDS a multi-slot competition and froze
//     nothing, with no scheduler backstop;
//   • a competition that ended with the team board OFF froze a literal `null`,
//     which buildGroupLeaderboard serves for ever — so enabling the flag
//     afterwards could never surface Team Rankings.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

function withDb(fn, ro = true) {
  const db = new Database(TEST_DB_PATH, ro ? { readonly: true } : undefined);
  try { return fn(db); } finally { db.close(); }
}
const snapRows = (compId) => withDb(d =>
  d.prepare("SELECT slot_key, board FROM group_leaderboard_snapshots WHERE competition_id=?").all(compId));
const frozenBoard = (compId) => {
  const r = snapRows(compId).find(x => x.slot_key === "__global__");
  return r ? JSON.parse(r.board) : undefined;
};

/** A verified+approved participant with a known password. */
async function mkP(sa, saCsrf, nick) {
  const email = `ff_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  // v8.1.0 — ASSERT THE REGISTRATION. It was fire-and-forget, so a refusal
  // surfaced 3 lines later as "participant <nick> must exist" — which points at
  // the LOOKUP and says nothing about the cause. Seen once on a full-suite run
  // and not reproduced; no mechanism is claimed, but a precondition that is not
  // asserted reports the wrong thing when it breaks (the standing rule), and the
  // next occurrence now names itself.
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Ff", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
    jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), `register ${nick} (${email}): ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const listed = await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json();
  const u = (listed.participants || []).find(p => p.email === email);
  // On failure, say what the admin list DID return — "not found" is equally true
  // of an empty list, a truncated one and a search that matched something else.
  expect(u, `participant ${nick} must exist. search returned ${(listed.participants || []).length} row(s): ${JSON.stringify((listed.participants || []).map(p => p.email).slice(0, 5))}`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
  return { id: u.id, email, nick };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE LOAD-BEARING ONE — the deciding solve must be in the frozen board.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.9: the all-solved auto-end freezes a board that CONTAINS the winning submission", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `FF Auto ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(),
    duration_minutes: 240, group_leaderboard_enabled: true,
  }})).json()).competition.id;
  const taskId = (await (await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title: `FF-T ${t}`, description: "<p>x</p>", difficulty: "hard", answer_type: "text",
    correct_answer: "a", status: "published",
  }})).json()).id;
  await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });

  const p1 = await mkP(sa, csrf, `a${t}`), p2 = await mkP(sa, csrf, `b${t}`);
  const p3 = await mkP(sa, csrf, `c${t}`), p4 = await mkP(sa, csrf, `d${t}`);
  const gA = (await (await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `FFA ${t}`, userIds: [p1.id, p2.id] } })).json()).group.id;
  const gB = (await (await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `FFB ${t}`, userIds: [p3.id, p4.id] } })).json()).group.id;
  expect((await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { groupIds: [gA, gB], competitionIds: [compId] } })).ok()).toBeTruthy();

  const solve = async (email) => {
    const { api, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
    expect((await api.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } })).ok()).toBeTruthy();
    const r = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: H(pc), data: { answer: "a", gradingHash: await gradingHashFor(api, taskId) },
    });
    expect(r.ok(), `${email} submits`).toBeTruthy();
    await api.dispose();
  };
  // Everyone but the last solves. No auto-end yet.
  for (const p of [p1, p2, p3]) await solve(p.email);
  expect(withDb(d => d.prepare("SELECT ended_at FROM competitions WHERE id=?").get(compId).ended_at),
    "not ended until the last participant solves").toBeFalsy();

  // The deciding solve, with the cache warmed at the ONE moment that matters.
  //
  // This ordering is the entire test and the first draft got it wrong: warming
  // BEFORE p4 selects the competition proves nothing, because select-competition
  // stamps login_time and calls invalidateLeaderboardCache — so the freeze then
  // read a cold cache, computed fresh anyway, and the test passed with the fix
  // reverted. The warm read has to land AFTER the last invalidation and BEFORE
  // the submit, which is exactly what a concurrent /api/leaderboard poll does in
  // production.
  const p4c = await apiLogin(p4.email, PARTICIPANT_PASS);
  expect((await p4c.api.post("/api/select-competition", { headers: H(p4c.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
  const gh = await gradingHashFor(p4c.api, taskId);
  const warm = await sa.get(`/api/admin/leaderboard?competitionId=${compId}`);
  expect(warm.ok(), "a concurrent read repopulates the cache with the PRE-solve board").toBeTruthy();
  const warmBoard = await warm.json();
  expect((Array.isArray(warmBoard) ? warmBoard : []).find(u => u.userId === p4.id)?.score ?? 0,
    "the warmed board must NOT yet contain p4's solve — otherwise there is nothing stale to catch"
  ).toBe(0);
  expect((await p4c.api.post(`/api/tasks/${taskId}/submit`, { headers: H(p4c.csrf), data: { answer: "a", gradingHash: gh } })).ok(),
    "the deciding solve").toBeTruthy();
  await p4c.api.dispose();
  await expect.poll(() => withDb(d => d.prepare("SELECT ended_at FROM competitions WHERE id=?").get(compId).ended_at),
    { timeout: 8000, intervals: [50, 100, 200, 400] }).toBeTruthy();
  await expect.poll(() => snapRows(compId).length, { timeout: 8000, intervals: [50, 100, 200, 400] }).toBeGreaterThan(0);

  const board = frozenBoard(compId);
  expect(board, "a team board was frozen").toBeTruthy();
  // p4 is in group B. A hard challenge is 150 points, so if the freeze read the
  // pre-solve cache group B's average is 75 instead of 150 — and it loses to
  // group A, whose members all solved before the cache was warmed.
  const flat = JSON.stringify(board);
  expect(flat).toContain(`FFB ${t}`);
  const gbRow = board.find(r => (r.name || "") === `FFB ${t}`);
  expect(gbRow, "group B is on the frozen board").toBeTruthy();
  expect(gbRow.score,
    "the frozen team board must include the submission that ENDED the competition. Reading " +
    "through the 5 s cache captures the board as it stood BEFORE that solve, and the snapshot " +
    "is INSERT-OR-IGNORE so the wrong figures are the official result for ever."
  ).toBe(150);
  expect(gbRow.allSolved,
    "…and the team that in fact solved everything must not be frozen as allSolved:false"
  ).toBe(true);

  await sa.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every path that PERSISTS a computed board must bypass the cache.
//
// A source lock, and labelled as one. The badge mint is the third persisting
// site (achievement_badges.rank / score_snapshot → a PUBLIC OpenGraph page and
// the certificate PDF, for ever), and its fix is the same one word. But its
// exposure cannot be locked BEHAVIOURALLY without contriving a rank tie inside a
// 5-second window: every writer that changes a SCORE already invalidates the
// cache, so the only thing that can be stale at mint time is the end transition
// itself (isEnded → solveTimeMs), which moves rank only through the tie-break.
// A test built on that would be fragile and, worse, could pass for the wrong
// reason. So this pins the INVARIANT at the source instead of pretending to
// prove the behaviour — and it is mutation-detectable, which the alternative
// (a behavioural test that cannot fail) is not.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.9: every path that persists a computed board reads it FRESH", () => {
  const fs = require("fs"), pathMod = require("path");
  const root = pathMod.join(__dirname, "..");
  const read = f => fs.readFileSync(pathMod.join(root, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

  // The bypass must exist at all, or every assertion below is about nothing.
  const lb = read("lib/leaderboard.js");
  expect(/function buildLeaderboardEntries\([^)]*opts\s*=\s*\{\}\)/.test(lb),
    "buildLeaderboardEntries must accept an opts bag carrying `fresh`").toBe(true);
  expect(/if\s*\(!opts\.fresh\)\s*\{[\s\S]{0,200}_leaderboardCacheGet/.test(lb),
    "the cache read must be guarded by !opts.fresh — otherwise `fresh` is decorative").toBe(true);

  const PERSISTING = [
    { file: "lib/leaderboard.js", re: /_computeGroupLeaderboard\(competitionId,\s*tsId,\s*\{\s*fresh:\s*true\s*\}\)/,
      why: "freezeGroupLeaderboardSnapshots writes group_leaderboard_snapshots INSERT-OR-IGNORE — the first write is the official Team Rankings for ever" },
    { file: "lib/leaderboard.js", re: /_computeGroupLeaderboard\(competitionId,\s*timeslotId,\s*\{\s*fresh:\s*true\s*\}\)/,
      why: "the LAZY freeze inside buildGroupLeaderboard persists identically" },
    // v8.1.5 — the call MOVED (the registry's own instruction for that case), and
    // the guarantee now has two halves because one helper serves two callers with
    // opposite needs: `_mintEligibility` is shared by the MINT, which persists
    // rank + score_snapshot into a public immutable artefact, and by the OFFER
    // that decides whether a button is drawn and persists nothing. So assert both
    // that the shared read honours the `fresh` it was handed — a helper that
    // dropped it would silently make every caller cached — and that the mint call
    // site is the one passing `true`. Either half alone can pass while the mint
    // reads a five-second-old board.
    { file: "routes/badge.js", re: /buildLeaderboard\(comp\.id,\s*tsId,\s*\{\s*fresh\s*\}\)/,
      why: "the shared eligibility read must pass the caller's `fresh` through, not swallow it" },
    { file: "routes/badge.js", re: /_mintEligibility\(userId,\s*comp,\s*tsId,\s*\{\s*fresh:\s*true\s*\}\)/,
      why: "the badge mint persists rank + score_snapshot into a PUBLIC, immutable artefact" },
  ];
  for (const p of PERSISTING) {
    expect(p.re.test(read(p.file)),
      `${p.file}: a board that gets PERSISTED is being read through the 5-second cache. ${p.why}. ` +
      `Pass { fresh: true }. If the call moved, update this registry — do not delete the row.`
    ).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Deleting the last upcoming session ends the competition — and must freeze.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.9: deleting the last upcoming session ends the competition and freezes the team board", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const start = Date.now() - 120 * 60_000;
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `FF Del ${t}`, start_time: new Date(start).toISOString(), duration_minutes: 60,
    group_leaderboard_enabled: true,
  }})).json()).competition.id;
  // Session 1 is already over; session 2 is upcoming and empty.
  const ts1 = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H(csrf), data: {
    name: `S1 ${t}`, start_time: new Date(start).toISOString(), duration_minutes: 60,
  }})).json()).timeslot;
  const ts2 = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H(csrf), data: {
    name: `S2 ${t}`, start_time: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), duration_minutes: 60,
  }})).json()).timeslot;
  expect(ts1?.id && ts2?.id, "two sessions created").toBeTruthy();

  const p1 = await mkP(sa, csrf, `e${t}`), p2 = await mkP(sa, csrf, `f${t}`);
  const p3 = await mkP(sa, csrf, `g${t}`), p4 = await mkP(sa, csrf, `h${t}`);
  const gA = (await (await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `FFDA ${t}`, userIds: [p1.id, p2.id] } })).json()).group.id;
  const gB = (await (await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `FFDB ${t}`, userIds: [p3.id, p4.id] } })).json()).group.id;
  await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { groupIds: [gA, gB], competitionIds: [compId] } });
  // Pin everyone into the FINISHED session, so deleting the empty upcoming one
  // is permitted (it refuses a session with assigned participants).
  withDb(d => d.prepare("UPDATE competition_users SET timeslot_id=?, login_time=? WHERE competition_id=?")
    .run(ts1.id, new Date(start).toISOString(), compId), false);

  expect(snapRows(compId).length, "nothing frozen while a session is still upcoming").toBe(0);

  const del = await sa.delete(`/api/admin/competitions/${compId}/timeslots/${ts2.id}`, { headers: { "x-csrf-token": csrf } });
  expect(del.status(), `delete the last upcoming session: ${await del.text()}`).toBe(200);

  // THE ASSERTION: removing the only non-ended slot IS an end transition
  // (competitionStatus is every(s => ended)), and nothing else would catch it —
  // the scheduler skips multi-slot comps and the deleted slot has no observation
  // row. Without an eager freeze the board stays mutable until somebody first
  // opens Rankings, which is exactly the window v7.15.6 closed.
  expect(snapRows(compId).length,
    "deleting the last upcoming session makes the competition fully ended, so its team board " +
    "must be frozen THERE — the scheduler cannot reach it and the lazy path leaves the standings " +
    "rewritable by an ordinary group-membership edit until the first post-end read"
  ).toBeGreaterThan(0);
  await sa.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A board frozen as `null` because the FEATURE was off must not be permanent.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.21.9: enabling the team board AFTER the end still surfaces it — a flag-off null is not frozen", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  // group_leaderboard_enabled deliberately OFF (the default).
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `FF Null ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
  }})).json()).competition.id;
  const p1 = await mkP(sa, csrf, `i${t}`), p2 = await mkP(sa, csrf, `j${t}`);
  const p3 = await mkP(sa, csrf, `k${t}`), p4 = await mkP(sa, csrf, `l${t}`);
  const gA = (await (await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `FFNA ${t}`, userIds: [p1.id, p2.id] } })).json()).group.id;
  const gB = (await (await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `FFNB ${t}`, userIds: [p3.id, p4.id] } })).json()).group.id;
  await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { groupIds: [gA, gB], competitionIds: [compId] } });
  // Everyone has entered, so the groups are non-empty on the board.
  for (const p of [p1, p2, p3, p4]) {
    const c = await apiLogin(p.email, PARTICIPANT_PASS);
    await c.api.post("/api/select-competition", { headers: H(c.csrf), data: { competitionId: compId } });
    await c.api.get("/api/status");
    await c.api.dispose();
  }

  const en = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) });
  expect(en.status(), await en.text()).toBe(200);

  // With the flag OFF the freeze must store NOTHING. A stored `null` is served
  // for ever by buildGroupLeaderboard (`snap !== undefined`), which would make
  // the board permanently empty with no route back except a revive.
  expect(snapRows(compId).length,
    "a null board that exists only because the feature was OFF must not be frozen"
  ).toBe(0);

  // Now the admin turns it on, post-end — the reported scenario.
  const upd = await sa.put(`/api/admin/competitions/${compId}`, {
    headers: H(csrf), data: {
      group_leaderboard_enabled: true,
      expectedUpdatedAt: (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId).updated_at,
    },
  });
  expect(upd.status(), `enable post-end: ${await upd.text()}`).toBe(200);

  const board = await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`)).json();
  expect(Array.isArray(board) ? board.length : 0,
    "with the flag now on and two non-empty bound groups, Team Rankings must appear — a frozen " +
    "flag-off null made it permanently empty with no error and no way back"
  ).toBeGreaterThan(0);
  await sa.dispose();
});
