// @ts-check
//
// The seeded-fixture lookup shared by the functional-* spec files (v7.21.37).
//
// It was BYTE-IDENTICAL in functional-core.api.spec.js and
// functional-security.api.spec.js — two copies of the same 36 lines, which is
// the drift class this repo keeps paying for. Splitting those files would have
// made it five copies.
//
// IT IS A FACTORY, NOT A SHARED OBJECT, AND THAT IS LOAD-BEARING.
// `S` caches ids read from the seeded database behind `S.ready`. Per-file
// isolation wipes that database and re-seeds before EVERY spec file, so a
// single `S` shared across files in one worker would serve ids from the
// PREVIOUS file's database — stale rows that no longer exist, presenting as
// inexplicable 404s rather than as a caching bug. Each file calls makeState()
// and gets its own cache, so that cannot happen however Playwright chooses to
// cache modules.
//
// Call it once per spec file, destructured to the SAME names the bodies already
// use, so no call site changes:
//
//     const { S, ensureState, aliceInLive } = makeState();
const { apiLogin, PARTICIPANT_PASS } = require("./helpers");

function makeState() {
  // Shared state — populated by first test, used by all
  const S = { ready: false };

  async function ensureState() {
    if (S.ready) return;
    const { api } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    S.liveComp = comps.find(c => c.name === "Test Live");
    S.upcomingComp = comps.find(c => c.name === "Test Upcoming");
    S.endedComp = comps.find(c => c.name === "Test Ended");
    const tasks = await (await api.get("/api/admin/tasks")).json();
    S.tasks = tasks;
    // The library rows: each seeded event holds its own same-titled copy (lib/event-copies.js).
    S.easy1 = tasks.find(t => t.title === "Challenge easy1" && !t.owner_competition_id);
    S.draft1 = tasks.find(t => t.title === "Challenge draft1" && !t.owner_competition_id);
    // The question a seeded EVENT holds under a seeded title: that event's own copy.
    // What its participants answer, buy hints on and are numbered by.
    S.copyIn = (comp, title) => tasks.find(t => t.title === title && t.owner_competition_id === comp.id);
    S.liveTask = (title) => S.copyIn(S.liveComp, title);
    const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
    S.alice = parts.find(p => p.email === "alice@acme.com");
    S.bob = parts.find(p => p.email === "bob@acme.com");
    S.carol = parts.find(p => p.email === "carol@acme.com");
    await api.dispose();
    S.ready = true;
  }

  /** Login as Alice with live competition selected */
  async function aliceInLive() {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // v7.23.5 — ASSERT the select rather than firing it and hoping. A refusal
    // (a 429 under contention, an ended competition, an incomplete profile)
    // left alice with NO competition context, and every competition-scoped
    // request in the calling test then answered 403 — reported as whatever
    // assertion happened to come next, never as the missing precondition. This
    // is the shared factory for the functional-* files, so the gap paid out
    // across many of them; the sibling bobInLive() in mutations-core had it too.
    const sel = await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    if (!sel.ok()) {
      throw new Error(`aliceInLive: select-competition answered ${sel.status()} ${await sel.text()}`);
    }
    return { api, csrf };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PARTICIPANT FLOWS
  // ═══════════════════════════════════════════════════════════════════════════════

  return { S, ensureState, aliceInLive };
}

module.exports = { makeState };
