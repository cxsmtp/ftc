// @ts-check
/**
 * Mutation (write) tests — exercises all create/update/delete flows.
 * Uses isolated data-test/ directory, never touches workspace data.
 */
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor} = require("./helpers");

const S = { ready: false };

async function ensureState() {
  if (S.ready) return;
  const { api } = await apiLogin("superadmin");
  const comps = await (await api.get("/api/admin/competitions")).json();
  S.liveComp = comps.find(c => c.name === "Test Live");
  S.upcomingComp = comps.find(c => c.name === "Test Upcoming");
  S.endedComp = comps.find(c => c.name === "Test Ended");
  const tasks = await (await api.get("/api/admin/tasks")).json();
  // The seeded challenges the Live event HOLDS: its own copies (lib/event-copies.js),
  // what its participants answer, rate and download; draft1 is in no event (the library row).
  const inLive = (title) => tasks.find(t => t.title === title && t.owner_competition_id === S.liveComp.id);
  S.tasks = tasks;
  S.easy1 = inLive("Challenge easy1");
  S.med1 = inLive("Challenge med1");
  S.hard1 = inLive("Challenge hard1");
  S.draft1 = tasks.find(t => t.title === "Challenge draft1" && !t.owner_competition_id);
  const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
  S.alice = parts.find(p => p.email === "alice@acme.com");
  S.bob = parts.find(p => p.email === "bob@acme.com");
  S.carol = parts.find(p => p.email === "carol@acme.com");
  await api.dispose();
  S.ready = true;
}

async function aliceInLive() {
  await ensureState();
  const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  await api.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: S.liveComp.id },
  });
  return { api, csrf };
}

async function bobInLive() {
  await ensureState();
  const { api, csrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
  await api.post("/api/select-competition", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: { competitionId: S.liveComp.id },
  });
  return { api, csrf };
}

function h(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }

// audit v7.7.31 (M29) — create a throwaway participant for a single test.
// The five participant tests below used to fish for "dave@acme.com", who is
// only seeded in mutations-core.api.spec.js — a different file that (under
// fullyParallel:false, alphabetical, file-per-worker scheduling) never runs
// first, so dave never existed and every assertion sat behind `if (dave)` /
// `if (!dave) return`, passing without executing. Each test now mints its own
// user so the assertions actually run. `sa`/`saCsrf` = a logged-in superadmin.
async function mkParticipant(sa, saCsrf, { verify = false, approve = false } = {}) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const email = `mutadmin_${stamp}@acme.com`;
  const { api: anon, csrf: anonCsrf } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: h(anonCsrf), data: {
    firstName: "Mut", lastName: "Admin", nickname: `mutadmin_${stamp}`, email,
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.ok(), `register failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  await anon.dispose();
  const me = (await (await sa.get("/api/admin/participants?limit=3000")).json()).participants.find(p => p.email === email);
  expect(me, `participant ${email} created`).toBeTruthy();
  if (verify) expect((await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h(saCsrf) })).ok()).toBeTruthy();
  if (approve) expect((await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h(saCsrf) })).ok()).toBeTruthy();
  return { id: me.id, email };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — participant management", () => {
  test("verify participant", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const u = await mkParticipant(api, csrf); // fresh, unverified
    let parts = (await (await api.get("/api/admin/participants?limit=3000")).json()).participants;
    expect(parts.find(p => p.id === u.id).verified).toBeFalsy();
    const r = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: h(csrf) });
    expect(r.ok(), await r.text()).toBeTruthy();
    parts = (await (await api.get("/api/admin/participants?limit=3000")).json()).participants;
    expect(parts.find(p => p.id === u.id).verified).toBeTruthy();
    await api.dispose();
  });

  test("approve participant", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const u = await mkParticipant(api, csrf, { verify: true }); // approval requires verified
    let parts = (await (await api.get("/api/admin/participants?limit=3000")).json()).participants;
    expect(parts.find(p => p.id === u.id).approved).toBeFalsy();
    const r = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: h(csrf) });
    expect(r.ok(), await r.text()).toBeTruthy();
    parts = (await (await api.get("/api/admin/participants?limit=3000")).json()).participants;
    expect(parts.find(p => p.id === u.id).approved).toBeTruthy();
    await api.dispose();
  });

  test("add and remove tags", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // Add tag
      let r = await api.post(`/api/admin/participants/${S.alice.id}/tags`, { headers: h(csrf), data: { tag: "vip" } });
      expect(r.ok()).toBeTruthy();
      // Verify tag exists
      const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
      const alice = parts.find(p => p.id === S.alice.id);
      expect(alice.tags).toContain("vip");
      // Remove tag
      r = await api.delete(`/api/admin/participants/${S.alice.id}/tags/vip`, { headers: { "x-csrf-token": csrf } });
      expect(r.ok()).toBeTruthy();
    } finally {
      // The remove above is this test's own subject and stays asserted inline;
      // it is repeated here because a failure on the toContain assertion between
      // the two leaves alice carrying `vip` for every later test in the file.
      await api.delete(`/api/admin/participants/${S.alice.id}/tags/vip`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });

  test("participant tag over 50 chars returns 400", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const longTag = "a".repeat(51);
    const r = await api.post(`/api/admin/participants/${S.alice.id}/tags`, { headers: h(csrf), data: { tag: longTag } });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("cannot delete participant in live competition", async () => {
    await ensureState();
    // v7.14.1 — establish the precondition IN THIS TEST rather than inheriting
    // it from an earlier one. This assertion's failure mode is destructive: if
    // alice happens not to be in a live competition (another spec sharing this
    // worker's DB removed her, or Test Live ended), the guard doesn't fire, the
    // DELETE SUCCEEDS, and the seeded alice is gone — poisoning every later
    // test in this file and any other file that lands on the same worker. Make
    // the enrolment explicit so the test can only ever fail loudly.
    const sa = await apiLogin("superadmin");
    await sa.api.post("/api/admin/competitions/assign", {
      headers: h(sa.csrf), data: { userIds: [S.alice.id], competitionIds: [S.liveComp.id] },
    });
    await sa.api.dispose();
    const enrolled = await aliceInLive();          // logs in + selects the live comp
    await enrolled.api.dispose();

    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.delete(`/api/admin/participants/${S.alice.id}`, { headers: { "x-csrf-token": csrf } });
    expect(r.status(), "alice is in a live competition, so the delete must be refused").toBe(400);
    expect((await r.json()).error).toMatch(/compet/i);
    await api.dispose();
  });

  test("block and unblock participant", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // Block
      let r = await api.post(`/api/admin/participants/${S.carol.id}/block`, { headers: h(csrf), data: { blocked: true } });
      expect(r.ok()).toBeTruthy();
      // Unblock
      r = await api.post(`/api/admin/participants/${S.carol.id}/block`, { headers: h(csrf), data: { blocked: false } });
      expect(r.ok()).toBeTruthy();
    } finally {
      // Restore carol to the hard-coded seed state, blocked=0 — left blocked she
      // 401s every later apiLogin in this file rather than failing where the
      // mistake was made. POST .../block is a TOGGLE (it ignores the body), so
      // the restore has to ASK first: an unconditional second call re-blocks her,
      // which is the failure this test hit when it was written that way.
      try {
        const row = (await (await api.get("/api/admin/participants?limit=3000")).json())
          .participants.find(p => p.id === S.carol.id);
        if (row && row.blocked) {
          await api.post(`/api/admin/participants/${S.carol.id}/block`, { headers: h(csrf), data: { blocked: false } });
        }
      } catch (_) { /* the afterAll fixture guard names the leak better than a masked failure would */ }
      await api.dispose();
    }
  });

  test("admin edit participant profile", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/participants/${S.bob.id}`, { headers: h(csrf), data: {
      company: "Admin Edited Co",
    }});
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("assign participants to competition", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const u = await mkParticipant(api, csrf, { verify: true, approve: true }); // assignable
    const r = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
      userIds: [u.id], competitionIds: [S.liveComp.id],
    }});
    expect(r.ok(), await r.text()).toBeTruthy();
    const d = await r.json();
    expect(d.assigned).toBeGreaterThanOrEqual(1);
    await api.dispose();
  });

  test("bulk approve participants", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
    const unapproved = parts.filter(p => !p.approved).map(p => p.id);
    if (unapproved.length > 0) {
      const r = await api.post("/api/admin/participants/bulk-approve", { headers: h(csrf), data: {
        userIds: unapproved,
      }});
      expect(r.ok()).toBeTruthy();
    }
    await api.dispose();
  });

  // v7.15.32 — "superadmin can change user role" was DELETED here as a strict
  // subset. It promoted carol to admin and demoted her back, asserting only
  // r.ok() on each. Two stronger copies remain and between them assert
  // everything it did plus the side effect it ignored:
  //   • functional-core.api.spec.js > "superadmin can change user roles"
  //     — same promote/demote, and asserts the auto-applied `staff` tag.
  //   • timeslots-lifecycle.api.spec.js > "promoting to admin auto-adds staff
  //     tag" — the strongest: it alone asserts the DEMOTE removes the tag.

  test("regular admin cannot change roles", async () => {
    await ensureState();
    // Promote Carol to admin, then login as Carol to test restrictions
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    await sa.dispose();
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    try {
      const r = await api.post(`/api/admin/participants/${S.bob.id}/role`, { headers: h(csrf), data: { role: "admin" } });
      expect(r.status()).toBe(403);
    } finally {
      // Restore Carol to participant — the hard-coded seed value, never a re-read.
      // A 403 that does not arrive would otherwise leave her an admin, and with it
      // the auto-applied `staff` tag that drops her from every leaderboard and makes
      // the assign endpoint silently skip her for the rest of the run.
      try {
        const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
        await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf2), data: { role: "participant" } });
        await sa2.dispose();
      } catch (_) { /* the afterAll fixture guard names the leak better than a masked failure would */ }
      await api.dispose();
    }
  });

  // The role allowlist in POST /api/admin/participants/:id/role is the ONLY thing
  // between a scripted client and an arbitrary string in `users.role` — the column
  // carries no CHECK constraint, so a value that slips past the guard is persisted
  // silently and the account then falls off every role branch at once (requireAdmin /
  // requireSuperAdmin refuse it, the txn strips the staff tag, and the impersonation
  // eligibility check no longer recognises it). Nothing tested it: every one of the
  // ~20 call sites in the suite sends "participant" / "admin" / "superadmin", and the
  // only /role\b/ error-message assertions belong to a bulk-seed test on a different
  // endpoint. A fresh throwaway participant is used rather than S.carol so that a
  // regressed route cannot poison a shared fixture for the tests that follow.
  test("an out-of-allowlist role is rejected and never persisted", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const u = await mkParticipant(api, csrf);
    const roleOf = async () => {
      // kind=all: the positive control promotes this account to admin, and People
      // lists admin accounts only on request (RBAC). A superset, so the final
      // re-read still sees the row whatever role a regressed guard stored.
      const list = (await (await api.get("/api/admin/participants?limit=3000&kind=all")).json()).participants;
      const row = list.find(p => p.id === u.id);
      expect(row, `participant ${u.email} still listed`).toBeTruthy();
      return row.role;
    };

    // POSITIVE CONTROL — the endpoint really does write this column, so a later
    // "still participant" assertion means the guard refused, not that nothing works.
    expect(await roleOf()).toBe("participant");
    let ok = await api.post(`/api/admin/participants/${u.id}/role`, { headers: h(csrf), data: { role: "admin" } });
    expect(ok.ok(), await ok.text()).toBeTruthy();
    expect(await roleOf()).toBe("admin");
    ok = await api.post(`/api/admin/participants/${u.id}/role`, { headers: h(csrf), data: { role: "participant" } });
    expect(ok.ok(), await ok.text()).toBeTruthy();
    expect(await roleOf()).toBe("participant");

    // 1. An unknown role string is refused outright.
    const bogus = await api.post(`/api/admin/participants/${u.id}/role`, { headers: h(csrf), data: { role: "moderator" } });
    expect(bogus.status()).toBe(400);
    expect((await bogus.json()).error).toMatch(/invalid role/i);

    // 2. A number is refused too — and must not be bound into the UPDATE.
    const numeric = await api.post(`/api/admin/participants/${u.id}/role`, { headers: h(csrf), data: { role: 5 } });
    expect(numeric.status()).toBe(400);

    // 3. A non-bindable value must not reach SQLite (that is a 500, not a refusal).
    const obj = await api.post(`/api/admin/participants/${u.id}/role`, { headers: h(csrf), data: { role: { a: 1 } } });
    expect(obj.status(), await obj.text()).toBeLessThan(500);

    // The stored value is what actually matters: with no CHECK on users.role, a
    // regressed guard returns a clean 200 and only this re-read exposes the damage.
    const finalRole = await roleOf();
    expect(finalRole).toBe("participant");
    expect(["participant", "admin", "superadmin"]).toContain(finalRole);
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — settings", () => {
  test("update platform name", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    let r = await api.patch("/api/admin/settings", { headers: h(csrf), data: { platform_name: "Test Arena" } });
    expect(r.ok()).toBeTruthy();
    // Verify
    const config = await (await api.get("/api/config")).json();
    expect(config.platform_name).toBe("Test Arena");
    // Restore
    // v8.1.0 — restore the CURRENT default. This line restored "Tournament",
    // which stopped being the default in v7.29.0, so the file was still leaving a
    // custom global name behind — silently altering the login card, the <title>
    // and every email subject for whatever ran next.
    await api.patch("/api/admin/settings", { headers: h(csrf), data: { platform_name: "Checkmarx Enablement Platform" } });
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — EVENT HISTORY (audit attribution)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin — event history", () => {
  test("user events recorded on approve, role change, and tag add", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // Trigger a role change (produces "role_changed" event)
      await api.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(csrf), data: { role: "admin" } });
      await api.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(csrf), data: { role: "participant" } });
      // Trigger a tag add
      await api.post(`/api/admin/participants/${S.carol.id}/tags`, { headers: h(csrf), data: { tag: "event-test" } });
      await api.delete(`/api/admin/participants/${S.carol.id}/tags/event-test`, { headers: { "x-csrf-token": csrf } });
      // Read events back
      const events = await (await api.get(`/api/admin/participants/${S.carol.id}/events`)).json();
      const types = events.map(e => e.event_type);
      expect(types).toContain("role_changed");
      expect(types).toContain("tag_added");
      expect(types).toContain("tag_removed");
      // The admin-initiated events from this test are attributed to superadmin
      const adminEvents = events.filter(e => ["role_changed", "tag_added", "tag_removed"].includes(e.event_type));
      expect(adminEvents.every(e => e.changed_by === "superadmin")).toBe(true);
      // role_changed event has proper details
      const roleEvent = events.find(e => e.event_type === "role_changed");
      expect(roleEvent.details).toHaveProperty("from");
      expect(roleEvent.details).toHaveProperty("to");
    } finally {
      // The demote and the untag above ARE the events this test asserts, so they
      // stay inline; both are repeated here to the hard-coded seed values because a
      // throw anywhere after the promote leaves carol an admin with the auto-applied
      // `staff` tag — which drops her from every leaderboard for the rest of the file.
      await api.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(csrf), data: { role: "participant" } }).catch(() => {});
      await api.delete(`/api/admin/participants/${S.carol.id}/tags/event-test`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });

  test("competition events recorded on create and edit", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Create a fresh competition
    const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Event Test ${Date.now()}`,
      start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 60,
    }});
    const d = await r.json();
    const compId = d.competition.id;
    // Edit it
    await api.put(`/api/admin/competitions/${compId}`, { headers: h(csrf), data: { duration_minutes: 90 } });
    // Read events
    const events = await (await api.get(`/api/admin/competitions/${compId}/events`)).json();
    const types = events.map(e => e.event_type);
    expect(types).toContain("created");
    expect(types).toContain("edited");
    expect(events.every(e => e.changed_by === "superadmin")).toBe(true);
    // Cleanup
    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("v7.7.17: event-retention purge deletes *_events past the 2y window, keeps recent, caps + exposes status", async () => {
    // Locks the retention policy: lib/event-retention.js purges audit events older
    // than EVENT_RETENTION_DAYS (default 730). Verify via competition_events: an
    // event aged past the window is deleted; a recent sibling survives; the run is
    // capped; GET /api/admin/retention reports the window; the superadmin manual
    // purge works.
    const Database = require("better-sqlite3");
    const { api, csrf } = await apiLogin("superadmin");
    const getEvents = async (url) => { const r = await (await api.get(url)).json(); return Array.isArray(r) ? r : (r.events || []); };
    let compId, comp2Id;
    try {
      // status endpoint exposes the configured window + table list.
      const status = await (await api.get("/api/admin/retention")).json();
      expect(status.retention_days, "default retention window is 2 years").toBe(730);
      expect(status.tables, "purge covers the 5 *_events tables").toEqual(
        expect.arrayContaining(["competition_events", "timeslot_events", "user_events", "settings_events", "challenge_events"])
      );

      // Comp A: create + edit → two competition_events (created, edited).
      compId = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: { name: `Ret ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
      await api.put(`/api/admin/competitions/${compId}`, { headers: h(csrf), data: { duration_minutes: 90 } });
      // Age ONLY the "created" event ~3 years back; leave "edited" recent.
      const threeYrsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
      const wdb = new Database(TEST_DB_PATH);
      wdb.prepare("UPDATE competition_events SET changed_at=? WHERE competition_id=? AND event_type='created'").run(threeYrsAgo, compId);
      wdb.close();

      // Purge at the default 2y window.
      const purge = await (await api.post("/api/test/purge-events", { headers: { "content-type": "application/json" }, data: {} })).json();
      expect(purge.ok).toBe(true);
      expect(purge.counts.competition_events, "the 3y-old created event is purged").toBeGreaterThanOrEqual(1);

      // created GONE, edited KEPT.
      const ev = await getEvents(`/api/admin/competitions/${compId}/events`);
      const types = ev.map(e => e.event_type);
      expect(types.includes("created"), "aged 'created' event must be purged").toBe(false);
      expect(types.includes("edited"), "recent 'edited' event must survive").toBe(true);

      // last_purge now reflected on the status endpoint (in-process).
      const status2 = await (await api.get("/api/admin/retention")).json();
      expect(status2.last_purge, "status reports the last purge").toBeTruthy();
      expect(status2.last_purge.total).toBeGreaterThanOrEqual(1);

      // Cap: age TWO comp events past the window, purge with limit=1 → only 1 deleted, table flagged capped.
      comp2Id = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: { name: `Ret2 ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
      await api.put(`/api/admin/competitions/${comp2Id}`, { headers: h(csrf), data: { duration_minutes: 90 } });
      const wdb2 = new Database(TEST_DB_PATH);
      wdb2.prepare("UPDATE competition_events SET changed_at=? WHERE competition_id=?").run(threeYrsAgo, comp2Id);
      wdb2.close();
      const capped = await (await api.post("/api/test/purge-events", { headers: { "content-type": "application/json" }, data: { limit: 1 } })).json();
      expect(capped.counts.competition_events, "limit=1 deletes at most 1 per table").toBe(1);
      expect(capped.cappedTables, "table flagged as capped when more remain").toContain("competition_events");

      // Superadmin manual purge endpoint works (drains the remainder).
      const manual = await (await api.post("/api/admin/retention/purge", { headers: h(csrf), data: {} })).json();
      expect(manual.ok).toBe(true);
      expect(manual).toHaveProperty("total");
    } finally {
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      if (comp2Id) await api.delete(`/api/admin/competitions/${comp2Id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });

  test("ext-audit: the event-retention purge plan uses a timestamp-leading covering index (no full scan + temp B-tree)", async () => {
    // Locks the index fix. lib/event-retention.js purges each *_events table by
    // `WHERE <ts> < ? ORDER BY <ts> ASC LIMIT ?`. The entity-first composites
    // (competition_id, changed_at DESC) etc. can't serve a global timestamp range,
    // so without the timestamp-leading indexes added in db.js SQLite full-SCANs the
    // table + builds a temp B-tree to order. With them the rowid subquery is a
    // COVERING index range SEARCH — no scan, no temp B-tree.
    const Database = require("better-sqlite3");
    const rdb = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const tables = [
        { table: "competition_events", ts: "changed_at" },
        { table: "timeslot_events",    ts: "changed_at" },
        { table: "user_events",        ts: "changed_at" },
        { table: "settings_events",    ts: "changed_at" },
        { table: "challenge_events",   ts: "occurred_at" },
        { table: "orphan_events",      ts: "changed_at" },
      ];
      for (const { table, ts } of tables) {
        const plan = rdb.prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE ${ts} < ? ORDER BY ${ts} ASC LIMIT ?`
        ).all("2020-01-01T00:00:00.000Z", 100).map((r) => r.detail).join(" | ");
        expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX idx_\\w*${ts}`)); // the ts-leading index
        expect(plan).not.toMatch(/TEMP B-TREE/i);                                  // not an in-memory sort
        expect(plan).not.toMatch(new RegExp(`SCAN ${table}\\b`));                  // a SEARCH, not a full scan
      }
    } finally { rdb.close(); }
  });

  test("v7.7.16: admin entity-lifecycle events carry reqContext (ip/user_agent/req_id/session_id)", async () => {
    // The v7.7.16 rollout attaches request forensic context to every admin
    // entity-lifecycle audit emit (competition/timeslot/task/participant CRUD).
    // Verify it lands in the structured *_events details for a representative
    // competition create + edit (the events endpoint JSON-parses details).
    const { api, csrf } = await apiLogin("superadmin");
    const getEvents = async (url) => { const r = await (await api.get(url)).json(); return Array.isArray(r) ? r : (r.events || []); };
    let compId;
    try {
      compId = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: { name: `Ctx ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
      await api.put(`/api/admin/competitions/${compId}`, { headers: h(csrf), data: { duration_minutes: 90 } });
      const ev = await getEvents(`/api/admin/competitions/${compId}/events`);
      const created = ev.find(e => e.event_type === "created");
      const edited = ev.find(e => e.event_type === "edited");
      expect(created, "created event present").toBeTruthy();
      expect(edited, "edited event present").toBeTruthy();
      for (const e of [created, edited]) {
        expect(e.details, `${e.event_type} has details object`).toBeTruthy();
        // All four reqContext keys must be present (values may be null in test, e.g. ip).
        for (const k of ["ip", "user_agent", "req_id", "session_id"]) {
          expect(Object.prototype.hasOwnProperty.call(e.details, k), `${e.event_type}.details has ${k}`).toBe(true);
        }
        // session_id is always set for an authenticated request.
        expect(e.details.session_id, `${e.event_type} session_id present`).toBeTruthy();
      }
    } finally {
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });

  test("v7.7.15 (event-logging audit): participant import + group bind emit attributed events", async () => {
    // Locks the audit-driven fixes: an import-driven competition enrollment and
    // group membership, and a group→competition bind, must each emit a structured,
    // correctly-attributed event (they were silently state-changing before).
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
    const getEvents = async (url) => { const r = await (await api.get(url)).json(); return Array.isArray(r) ? r : (r.events || []); };
    const compName = `EvtImp ${stamp}`;
    const email = `evtimp-${stamp}@acme.com`;
    let compId, bindCompId, uid;
    try {
      compId = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: { name: compName, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
      bindCompId = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: { name: `EvtBind ${stamp}`, start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
      const groupName = `evtgrp_${stamp}`;
      const row = {
        nickname: `evtimp_${stamp}`, email, first_name: "Evt", last_name: "Imp",
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        job_function: "Software Developer / Engineer", city: "NYC", verified: 1, approved: 1, tags: [],
        competitions: [{ competition_name: compName }], groups: [groupName],
      };
      const imp = await api.post("/api/admin/import/participants", { headers: h(csrf), data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} } });
      expect(imp.ok(), `import: ${imp.status()} ${await imp.text().catch(() => "")}`).toBeTruthy();
      uid = (await (await api.get("/api/admin/participants?limit=500")).json()).participants.find(p => p.email === email)?.id;
      expect(uid, "imported user found").toBeTruthy();

      // (MEDIUM) import enrollment -> user_added on the comp + added_to_competition on the user, attributed, via:import.
      const compEvents = await getEvents(`/api/admin/competitions/${compId}/events`);
      const userAdded = compEvents.find(e => e.event_type === "user_added" && e.details?.user_id === uid);
      expect(userAdded, "import enroll must emit competition user_added").toBeTruthy();
      expect(userAdded.changed_by).toBe("superadmin");
      expect(userAdded.details?.via).toBe("import");
      const userEvents = await getEvents(`/api/admin/participants/${uid}/events`);
      const addedToComp = userEvents.find(e => e.event_type === "added_to_competition" && e.details?.competition_id === compId);
      expect(addedToComp, "import enroll must emit user added_to_competition").toBeTruthy();
      expect(addedToComp.details?.via).toBe("import");
      // (LOW) import group membership -> group_added on the user, attributed, via:import.
      const groupAdded = userEvents.find(e => e.event_type === "group_added" && e.details?.via === "import");
      expect(groupAdded, "import group membership must emit group_added").toBeTruthy();
      expect(groupAdded.changed_by).toBe("superadmin");

      // (LOW) binding a group to a competition -> group_bound on the comp, attributed (mirror of group_unbound).
      const gid = groupAdded.details?.group_id;
      expect(gid, "group id present on group_added").toBeTruthy();
      const assign = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: { groupIds: [gid], competitionIds: [bindCompId] } });
      expect(assign.ok(), `assign-bind: ${assign.status()}`).toBeTruthy();
      const bindEvents = await getEvents(`/api/admin/competitions/${bindCompId}/events`);
      const bound = bindEvents.find(e => e.event_type === "group_bound" && e.details?.group_id === gid);
      expect(bound, "group bind must emit group_bound").toBeTruthy();
      expect(bound.changed_by).toBe("superadmin");
    } finally {
      if (uid) await api.delete(`/api/admin/participants/${uid}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      if (bindCompId) await api.delete(`/api/admin/competitions/${bindCompId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });

  test("seeded approve/assign actions produced user_events rows", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    // Alice was approved during seed via the live /api/admin/participants/:id/approve
    // path, which emits recordUserEvent — so at minimum one event must exist on
    // her timeline.
    const events = await (await api.get(`/api/admin/participants/${S.alice.id}/events`)).json();
    expect(events.length).toBeGreaterThan(0);
    await api.dispose();
  });

  test("removed_from_competition event recorded on user removal", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // audit v7.7.31 (M29) — mint a fresh assignable participant instead of
    // fishing for the never-present "dave"; assign to liveComp, then remove.
    const u = await mkParticipant(api, csrf, { verify: true, approve: true });
    await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: { userIds: [u.id], competitionIds: [S.liveComp.id] } });
    const r = await api.delete(`/api/admin/competitions/${S.liveComp.id}/users/${u.id}`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok(), await r.text()).toBeTruthy();
    // Verify the removal event was recorded on the user timeline
    const events = await (await api.get(`/api/admin/participants/${u.id}/events`)).json();
    const removal = events.find(e => e.event_type === "removed_from_competition");
    expect(removal).toBeTruthy();
    expect(removal.changed_by).toBe("superadmin");
    expect(removal.details).toHaveProperty("competition_id", S.liveComp.id);
    // Verify the mirror event was recorded on the competition timeline
    const compEvents = await (await api.get(`/api/admin/competitions/${S.liveComp.id}/events`)).json();
    expect(compEvents.some(e => e.event_type === "user_removed" && e.details?.user_id === u.id)).toBe(true);
    await api.dispose();
  });

  test("timeslot events recorded on create, edit, end-now", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Fresh competition with a timeslot so we can manipulate it without touching live state
    const compR = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `TS Events ${Date.now()}`,
      start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 60,
    }});
    const comp = (await compR.json()).competition;
    // Create a timeslot
    const tsR = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: h(csrf), data: {
      name: "TS A",
      start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 30,
    }});
    const ts = (await tsR.json()).timeslot;
    // Edit
    await api.put(`/api/admin/competitions/${comp.id}/timeslots/${ts.id}`, { headers: h(csrf), data: { duration_minutes: 45 } });
    // Read timeslot events
    const tsEvents = await (await api.get(`/api/admin/competitions/${comp.id}/timeslots/${ts.id}/events`)).json();
    const types = tsEvents.map(e => e.event_type);
    expect(types).toContain("created");
    expect(types).toContain("edited");
    expect(tsEvents.every(e => e.changed_by === "superadmin")).toBe(true);
    // Competition events should record timeslot_added
    const compEvents = await (await api.get(`/api/admin/competitions/${comp.id}/events`)).json();
    expect(compEvents.some(e => e.event_type === "timeslot_added" && e.details?.timeslot_id === ts.id)).toBe(true);
    // Cleanup
    await api.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("login_success event recorded with IP and user_agent", async () => {
    await ensureState();
    // Alice logs in (she's set up in seed data)
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // Switch to superadmin to read her events
    await api.dispose();
    const { api: sa } = await apiLogin("superadmin");
    const events = await (await sa.get(`/api/admin/participants/${S.alice.id}/events`)).json();
    const loginEvents = events.filter(e => e.event_type === "login_success");
    expect(loginEvents.length).toBeGreaterThan(0);
    const latest = loginEvents[0];
    expect(latest).toHaveProperty("details");
    expect(latest.details).toHaveProperty("method", "login_code");
    // IP may be a valid v4/v6/localhost; just assert present
    expect(latest.details.ip).toBeTruthy();
    await sa.dispose();
  });

  test("paginated events endpoint returns {events,total,offset,limit}", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const r = await api.get(`/api/admin/participants/${S.alice.id}/events?offset=0&limit=5`);
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d).toHaveProperty("events");
    expect(d).toHaveProperty("total");
    expect(d).toHaveProperty("offset", 0);
    expect(d).toHaveProperty("limit", 5);
    expect(Array.isArray(d.events)).toBeTruthy();
    expect(d.events.length).toBeLessThanOrEqual(5);
    // Legacy unpaginated call still returns an array
    const legacy = await (await api.get(`/api/admin/participants/${S.alice.id}/events`)).json();
    expect(Array.isArray(legacy)).toBeTruthy();
    await api.dispose();
  });

  test("bulk operations share the same batch_id", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Create two fresh users to bulk-assign
    const email1 = `batch-${Date.now()}-a@acme.com`;
    const email2 = `batch-${Date.now()}-b@acme.com`;
    // Create via invite with a live comp to trigger the bulk add path
    // Simpler: bulk-assign two existing unassigned users to liveComp
    const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
    // Pick only ASSIGNABLE candidates — the assign route silently skips staff,
    // blocked, and unapproved users (routes/participants.js), so they emit no
    // added_to_competition event. Under the full suite the shared pool contains
    // such users (other tests create admins / blocked / pending accounts), so an
    // unfiltered "first 2 not in liveComp" could pick a skipped one → no event →
    // a flaky batch_id failure. Mirror the route's skip predicates exactly.
    const candidates = parts.filter(p =>
      !(p.competitions || []).some(c => c.id === S.liveComp.id)
      && p.approved && !p.blocked
      && (p.role || "participant") === "participant"
      && !(p.tags || []).includes("staff")
    ).slice(0, 2);
    if (candidates.length < 2) { await api.dispose(); return; }
    const assignR = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
      userIds: candidates.map(p => p.id), competitionIds: [S.liveComp.id],
    }});
    expect(assignR.ok(), `assign: ${assignR.status()} ${await assignR.text()}`).toBeTruthy();
    // Read events for both users and check batch_id is consistent
    const ev1 = await (await api.get(`/api/admin/participants/${candidates[0].id}/events`)).json();
    const ev2 = await (await api.get(`/api/admin/participants/${candidates[1].id}/events`)).json();
    const add1 = ev1.find(e => e.event_type === "added_to_competition" && e.details?.competition_id === S.liveComp.id);
    const add2 = ev2.find(e => e.event_type === "added_to_competition" && e.details?.competition_id === S.liveComp.id);
    expect(add1?.details?.batch_id).toBeTruthy();
    expect(add2?.details?.batch_id).toBeTruthy();
    expect(add1.details.batch_id).toBe(add2.details.batch_id);
    await api.dispose();
  });

  // Participant scoring events — hint reveal, submission, feedback.
  // Carol is used because she has no prior scoring activity in the seed.

  test("hint_revealed events recorded on user, competition, and timeslot timelines", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    const r = await api.post(`/api/tasks/${S.hard1.id}/hint`, { headers: h(csrf) });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.pointsDeducted).toBeGreaterThan(0);
    await api.dispose();
    const { api: admin } = await apiLogin("superadmin");
    const userEvents = await (await admin.get(`/api/admin/participants/${S.carol.id}/events`)).json();
    const hintUe = userEvents.find(e => e.event_type === "hint_revealed" && e.details?.task_id === S.hard1.id);
    expect(hintUe).toBeTruthy();
    expect(hintUe.changed_by).toBe("carol@acme.com");
    expect(hintUe.details.points_deducted).toBeGreaterThan(0);
    expect(hintUe.details.competition_id).toBe(S.liveComp.id);
    const compEvents = await (await admin.get(`/api/admin/competitions/${S.liveComp.id}/events`)).json();
    const hintCe = compEvents.find(e => e.event_type === "hint_revealed" && e.details?.task_id === S.hard1.id && e.details?.user_id === S.carol.id);
    expect(hintCe).toBeTruthy();
    expect(hintCe.details.nickname).toBeTruthy();
    await admin.dispose();
  });

  test("submission_correct event recorded on user and competition timelines", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    // Use med1 — Carol is already marked as "solved easy1" from an earlier functional test (staff submits),
    // and only unsolved tasks accept fresh submissions.
    const taskId = S.med1.id;
    const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "answer-med1" , gradingHash: await gradingHashFor(api, taskId)} });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.correct).toBe(true);
    expect(d.pointsDelta).toBeGreaterThan(0);
    await api.dispose();
    const { api: admin } = await apiLogin("superadmin");
    const userEvents = await (await admin.get(`/api/admin/participants/${S.carol.id}/events`)).json();
    const ue = userEvents.find(e => e.event_type === "submission_correct" && e.details?.task_id === taskId);
    expect(ue).toBeTruthy();
    expect(ue.changed_by).toBe("carol@acme.com");
    expect(ue.details.correct).toBe(true);
    expect(ue.details.points_delta).toBeGreaterThan(0);
    const compEvents = await (await admin.get(`/api/admin/competitions/${S.liveComp.id}/events`)).json();
    const ce = compEvents.find(e => e.event_type === "submission_correct" && e.details?.task_id === taskId && e.details?.user_id === S.carol.id);
    expect(ce).toBeTruthy();
    await admin.dispose();
  });

  test("submission_wrong event recorded on user and competition timelines", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    // Use hard1 — Carol has only revealed the hint on it (from the hint_revealed test), never submitted.
    const taskId = S.hard1.id;
    const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "totally-wrong" , gradingHash: await gradingHashFor(api, taskId)} });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.correct).toBe(false);
    await api.dispose();
    const { api: admin } = await apiLogin("superadmin");
    const userEvents = await (await admin.get(`/api/admin/participants/${S.carol.id}/events`)).json();
    const ue = userEvents.find(e => e.event_type === "submission_wrong" && e.details?.task_id === taskId);
    expect(ue).toBeTruthy();
    expect(ue.details.correct).toBe(false);
    expect(ue.details.points_delta).toBeLessThan(0);
    const compEvents = await (await admin.get(`/api/admin/competitions/${S.liveComp.id}/events`)).json();
    const ce = compEvents.find(e => e.event_type === "submission_wrong" && e.details?.task_id === taskId && e.details?.user_id === S.carol.id);
    expect(ce).toBeTruthy();
    await admin.dispose();
  });

  test("feedback_submitted events recorded with is_update flag on re-rating", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    // First rating — is_update:false
    let r = await api.put(`/api/tasks/${S.easy1.id}/feedback`, { headers: h(csrf), data: { rating: 3 } });
    expect(r.ok()).toBeTruthy();
    // Second rating — is_update:true, previous_rating:3
    r = await api.put(`/api/tasks/${S.easy1.id}/feedback`, { headers: h(csrf), data: { rating: 5 } });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
    const { api: admin } = await apiLogin("superadmin");
    const userEvents = await (await admin.get(`/api/admin/participants/${S.carol.id}/events`)).json();
    const fbUe = userEvents.filter(e => e.event_type === "feedback_submitted" && e.details?.task_id === S.easy1.id);
    expect(fbUe.length).toBeGreaterThanOrEqual(2);
    // Most recent first (the events endpoint orders by changed_at DESC)
    expect(fbUe[0].details.rating).toBe(5);
    expect(fbUe[0].details.is_update).toBe(true);
    expect(fbUe[0].details.previous_rating).toBe(3);
    expect(fbUe[1].details.rating).toBe(3);
    expect(fbUe[1].details.is_update).toBe(false);
    expect(fbUe[1].details.previous_rating).toBeNull();
    const compEvents = await (await admin.get(`/api/admin/competitions/${S.liveComp.id}/events`)).json();
    const fbCe = compEvents.find(e => e.event_type === "feedback_submitted" && e.details?.task_id === S.easy1.id && e.details?.user_id === S.carol.id && e.details?.rating === 5);
    expect(fbCe).toBeTruthy();
    await admin.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPETITION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Competition lifecycle", () => {
  test("end-now sets ended_manually and blocks further assignment", async () => {
    // v8.3.16 — this reads S.alice.id and never resolved it: it worked only
    // because a sibling above had called ensureState(). Alone: "Cannot read
    // properties of undefined (reading 'id')". Same class as the v7.21.39 sweep.
    await ensureState();
    // Create a fresh live competition to end
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: "End-Now Test", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const comp = (await r.json()).competition;
    // End it
    r = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: h(csrf) });
    expect(r.ok()).toBeTruthy();
    // Try to assign participants — should fail (ended manually)
    r = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
      userIds: [S.alice.id], competitionIds: [comp.id],
    }});
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("ended");
    // Clean up
    await api.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("naturally-ended MULTI-slot competition rejects assignment + group-bind (audit correctness #5)", async () => {
    // Regression for the audit-verify gap: the ended-assign guard originally
    // only covered single-slot natural end. A MULTI-slot comp whose only slot's
    // scheduled end is in the past is competitionStatus="ended" with
    // ended_manually=0 — neither the manual-end guard nor the single-slot guard
    // fired, so the membership was stranded (and a groupIds bind dangled).
    // v8.3.16 — S.alice.id below needs ensureState(); it was inherited from a
    // sibling, so this failed alone.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `MultiSlot Natural-End ${now}`, start_time: new Date(now - 3 * 3600_000).toISOString(), duration_minutes: 60,
    }});
    const comp = (await r.json()).competition;
    // One timeslot whose scheduled end (start + duration) is already in the past
    // → makes the comp multi-slot AND naturally "ended" (not end-now).
    r = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: h(csrf), data: {
      name: "Past Slot", start_time: new Date(now - 2 * 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok(), "timeslot create").toBeTruthy();
    // Plain assign → 400 "scheduled time has passed" (NOT the manual-end message).
    r = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
      userIds: [S.alice.id], competitionIds: [comp.id],
    }});
    expect(r.status(), "assign to naturally-ended multi-slot comp must 400").toBe(400);
    expect((await r.json()).error).toContain("scheduled time has passed");
    // group-bind variant → also 400, and NO competition↔group binding written
    // (the guard fires in the competitionIds validation loop, before the bind).
    const gr = await api.post("/api/admin/groups", { headers: h(csrf), data: { name: `VerifyGap-${now}`, userIds: [S.alice.id] } });
    const gid = (await gr.json()).group.id;
    r = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
      competitionIds: [comp.id], groupIds: [gid],
    }});
    expect(r.status(), "group-bind assign to naturally-ended multi-slot comp must 400").toBe(400);
    const bindResp = await (await api.get(`/api/admin/groups/${gid}/competitions`)).json();
    const bound = (bindResp.competitions || bindResp || []).find(c => c.id === comp.id);
    expect(bound?.bound, "no group↔comp binding for the rejected comp").toBeFalsy();
    // Clean up
    await api.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } });
    await api.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v7.15.16 — event retention must purge ALL FIVE tables
// ═══════════════════════════════════════════════════════════════════════════════
// The existing coverage ages and deletes rows from competition_events only. The
// other four were never exercised — including challenge_events, which is the one
// table keyed on `occurred_at` rather than `changed_at`, and whose wrong-column
// failure is SWALLOWED by lib/event-retention.js. A typo there would silently
// retain analytics PII for ever and every test would stay green.
test.describe("Event retention purges every table (v7.15.16)", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  // Mirrors EVENT_TABLES in lib/event-retention.js. Add a table there → add it
  // here, or this test fails and tells you to.
  const TABLES = [
    { table: "competition_events", ts: "changed_at" },
    { table: "timeslot_events",    ts: "changed_at" },
    { table: "user_events",        ts: "changed_at" },
    { table: "settings_events",    ts: "changed_at" },
    { table: "challenge_events",   ts: "occurred_at" },
    { table: "orphan_events",      ts: "changed_at" },
  ];

  test("the retention table list here matches lib/event-retention.js", () => {
    const { EVENT_TABLES } = require("../lib/event-retention");
    expect(EVENT_TABLES.map(t => `${t.table}:${t.ts}`).sort(),
      "a table added to EVENT_TABLES must be added to this spec's TABLES too — " +
      "otherwise its purge goes untested exactly like the four that were"
    ).toEqual(TABLES.map(t => `${t.table}:${t.ts}`).sort());
  });

  test("an aged row in EVERY event table is purged", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const ancient = new Date(Date.now() - 5 * 365 * 24 * 3600_000).toISOString();
    const planted = [];
    try {
      const db = new Database(TEST_DB_PATH);
      try {
        for (const { table, ts } of TABLES) {
          // Discover the table's own shape rather than hard-coding columns —
          // these five differ, and a hard-coded INSERT would rot.
          const cols = db.prepare(`PRAGMA table_info(${table})`).all();
          const names = [], vals = [];
          for (const c of cols) {
            if (c.name === "id" && /INTEGER/i.test(c.type) && c.pk) continue;   // autoincrement
            names.push(c.name);
            if (c.name === ts) vals.push(ancient);
            else if (/INT/i.test(c.type)) vals.push(0);
            else vals.push(`ret-probe-${stamp}`);
          }
          db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...vals);
          const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${ts}=?`).get(ancient).c;
          expect(n, `precondition: a row was planted in ${table}`).toBeGreaterThan(0);
          planted.push({ table, ts });
        }
      } finally { db.close(); }

      const res = await api.post("/api/test/purge-events", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { ttlMs: 24 * 3600_000 },      // anything older than a day
      });
      expect(res.ok(), `purge: ${res.status()} ${await res.text()}`).toBeTruthy();

      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const survivors = [];
      try {
        for (const { table, ts } of planted) {
          if (dbR.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${ts}=?`).get(ancient).c > 0) survivors.push(table);
        }
      } finally { dbR.close(); }
      expect(survivors,
        `these tables kept a five-year-old row through a purge: ${survivors.join(", ")}. ` +
        `lib/event-retention.js swallows a per-table error, so a wrong timestamp column ` +
        `retains that table's rows for ever without failing anything.`
      ).toEqual([]);
    } finally {
      const dbC = new Database(TEST_DB_PATH);
      try { for (const { table, ts } of planted) dbC.prepare(`DELETE FROM ${table} WHERE ${ts}=?`).run(ancient); }
      finally { dbC.close(); }
      await api.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ext-audit v7.21.1 (A2) — a TRUNCATED grading secret must never become a
// KNOWN HMAC key.
//
// The v7.20.9 shape wrote the replacement with flag:"wx" so a genuine create
// RACE was safe. But a short/corrupt file also falls through to regeneration,
// and `wx` then fails EEXIST *because the file exists* — which is the very
// condition being repaired, not a race. The EEXIST branch re-read that same
// short file and returned it WITHOUT re-validating the length. So a 0-byte file
// keyed every taskGradingHash with the EMPTY STRING — an offline-recoverable
// oracle for `correct_answer`, i.e. exactly the finding v7.20.9 existed to
// close — and it PERSISTED, because the 32 fresh bytes were never written.
//
// The assertion that matters is therefore NOT "a token came back" but "the
// token is not reproducible from the bytes that were on disk". The POSITIVE
// CONTROL (a valid 32-byte key survives byte-for-byte) is what stops a naive
// "always overwrite" from satisfying every case here.
test.describe("A truncated grading secret is not adopted as a known key (v7.21.1)", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const crypto = require("crypto");
  const { execFileSync } = require("child_process");

  const SCORING = path.resolve(__dirname, "..", "lib", "scoring.js");
  const ANSWER_TYPE = "text";
  const SECRET_ANSWER = "the-answer-an-attacker-wants";

  // What the token WOULD be if `key` were the HMAC key. Mirrors taskGradingHash.
  const tokenWithKey = (key) =>
    crypto.createHmac("sha256", key)
      .update(ANSWER_TYPE).update(":").update(SECRET_ANSWER).update(":").update("")
      .digest("hex").slice(0, 16);

  // lib/scoring.js caches the key in a module-level variable and resolves
  // DATA_DIR at require time, so each case needs a pristine process. A child
  // also keeps this worker's require cache — and, critically, the worker's own
  // data-test-<i>/ directory — completely untouched.
  function probe(dataDir) {
    const script =
      `const s = require(${JSON.stringify(SCORING)});` +
      `const fs = require("fs"), path = require("path");` +
      `const token = s.taskGradingHash(${JSON.stringify(ANSWER_TYPE)}, ${JSON.stringify(SECRET_ANSWER)}, "");` +
      `const p = s._GRADING_SECRET_PATH;` +
      `const buf = fs.existsSync(p) ? fs.readFileSync(p) : null;` +
      `process.stdout.write(JSON.stringify({` +
      `  token, key: buf ? buf.toString("hex") : null,` +
      `  files: fs.readdirSync(path.dirname(p)),` +
      `}));`;
    const out = execFileSync(process.execPath, ["-e", script], {
      // NODE_OPTIONS is inherited by every child (v7.15.30): a --require probe
      // could write to this child's stdout and make the JSON unparseable.
      env: { ...process.env, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`, BASE_URL: "http://localhost:1", NODE_OPTIONS: "" },
      encoding: "utf8",
    });
    return JSON.parse(out);
  }

  let dir;
  test.beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "grading-secret-")); });
  test.afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  const SECRET_FILE = ".grading-secret";
  const write = (bytes) => fs.writeFileSync(path.join(dir, SECRET_FILE), bytes, { mode: 0o600 });
  const onDisk = () => fs.readFileSync(path.join(dir, SECRET_FILE));

  for (const { label, bytes } of [
    { label: "a ZERO-BYTE", bytes: Buffer.alloc(0) },
    { label: "a 5-byte",    bytes: Buffer.from("short") },
    { label: "a 15-byte",   bytes: Buffer.alloc(15, 0x41) },   // one byte under the floor
  ]) {
    test(`${label} secret file is REPLACED, and its bytes never key the token`, () => {
      write(bytes);
      const r = probe(dir);

      // THE FINDING. A key derived from the truncated file is public knowledge
      // (the empty string, or whatever a partial write left behind), so the
      // token becomes an offline oracle for correct_answer again.
      expect(r.token,
        `the grading token was computed with the ${bytes.length}-byte file's own bytes as the HMAC key — ` +
        `that key is guessable, so the token is an offline oracle for correct_answer again (v7.21.1 / A2)`
      ).not.toBe(tokenWithKey(bytes));

      // And it must be REPAIRED on disk, not merely worked around in memory —
      // the pre-fix bug persisted precisely because the fresh bytes were never
      // written, so every restart re-entered the same state.
      const after = onDisk();
      expect(after.length,
        `the unusable ${bytes.length}-byte secret file was left on disk, so the next boot repeats the failure`
      ).toBeGreaterThanOrEqual(16);
      expect(r.token, "the token must be keyed by the key that was persisted").toBe(tokenWithKey(after));

      // The replacement is a temp-file + rename, so a crashed swap must not
      // leave a stray key lying around in DATA_DIR.
      expect(r.files.filter(f => f.includes(".tmp")), "temp-file residue left in DATA_DIR").toEqual([]);

      // A restart must now agree with the repaired file (the persistence half).
      expect(probe(dir).token, "a second process must adopt the repaired key, not churn it").toBe(r.token);
    });
  }

  // POSITIVE CONTROL. Without this, "unconditionally overwrite the file on
  // every boot" passes every assertion above while silently invalidating every
  // in-flight grading token on every restart.
  test("a VALID 32-byte key is preserved byte-for-byte, not churned", () => {
    const good = crypto.randomBytes(32);
    write(good);
    const r = probe(dir);

    expect(onDisk().toString("hex"), "a valid key must survive untouched").toBe(good.toString("hex"));
    expect(r.token, "a valid key must be the key that is used").toBe(tokenWithKey(good));
    expect(r.files.filter(f => f.includes(".tmp"))).toEqual([]);
  });

  // The ENOENT branch still creates one (the `wx` path the fix deliberately keeps).
  test("a MISSING secret file is created with at least 16 bytes", () => {
    expect(fs.existsSync(path.join(dir, SECRET_FILE))).toBeFalsy();
    const r = probe(dir);
    const after = onDisk();
    expect(after.length).toBeGreaterThanOrEqual(16);
    expect(r.token).toBe(tokenWithKey(after));
    expect(r.files.filter(f => f.includes(".tmp"))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ext-audit v7.21.1 (A10) — a malformed import row is a 400, never a 500.
//
// `_importRowShapeError` (server.js) refuses the whole batch when any element
// of data.tasks / data.participants is not a plain object. Measured against the
// pre-fix code, the failure is TWO-FACED — which is why this locks the whole
// shape set rather than the one row that was reported:
//   • a `null` row reached `t.title` / `p.email` and threw → HTTP 500;
//   • a string / number / nested-array row has no `.title` / `.email`, so it hit
//     the "missing required field" `continue` and was SILENTLY DROPPED → 200.
//
// The DRY-RUN ordering is load-bearing, and the silent drop is exactly why: a
// dry run has no `skipped` channel, so a dropped row shifts every later index
// while the resolution UI posts those conflict INDICES straight back as
// `resolutions` — resolving the wrong rows on the real import.
test.describe("Malformed import rows are refused, not crashed (v7.21.1)", () => {
  const BAD_ROWS = [
    { label: "null",            row: null },
    { label: "a string",        row: "definitely-not-a-record" },
    { label: "a number",        row: 42 },
    { label: "a nested array",  row: [{ title: "nested" }] },
  ];

  const goodTask = (stamp) => ({
    title: `ImportShape ${stamp}`, description: "shape probe", difficulty: "easy",
    answer_type: "text", correct_answer: "yes", status: "published",
  });
  const goodParticipant = (stamp) => ({
    nickname: `impshape_${stamp}`, email: `impshape-${stamp}@acme.com`,
    first_name: "Imp", last_name: "Shape", company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York",
    job_function: "Software Developer / Engineer", city: "NYC",
    verified: 1, approved: 1, tags: [],
  });

  const SURFACES = [
    {
      name: "challenges", url: "/api/admin/import/tasks", noun: "Challenge",
      body: (rows) => ({ type: "hackarena-tasks", tasks: rows }),
      good: goodTask,
    },
    {
      name: "participants", url: "/api/admin/import/participants", noun: "Participant",
      body: (rows) => ({ type: "hackarena-participants", version: 2, participants: rows }),
      good: goodParticipant,
    },
  ];

  for (const s of SURFACES) {
    for (const mode of [
      { label: "DRY RUN (no resolutions)", extra: {} },
      { label: "committing (resolutions sent)", extra: { resolutions: {} } },
    ]) {
      test(`${s.name} import — a malformed row 400s on the ${mode.label}`, async () => {
        const { api, csrf } = await apiLogin("superadmin");
        try {
          // Every shape is probed and reported TOGETHER. Bailing on the first
          // hides the rest, and they fail differently: `null` throws out of the
          // handler (500), while a string/number row has no `.title`/`.email`
          // and is SILENTLY DROPPED (200) — which on a dry run desyncs the
          // conflict indices the resolution UI posts straight back.
          const got = [];
          for (const bad of BAD_ROWS) {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            // Row 1 is well-formed, so a refusal can only be about row 2 —
            // and the message has to say so, or the admin cannot find it.
            const res = await api.post(s.url, {
              headers: h(csrf),
              data: { data: s.body([s.good(stamp), bad.row]), ...mode.extra },
            });
            const text = await res.text();
            const err = (() => { try { return JSON.parse(text).error; } catch (_) { return text; } })();
            got.push(`${bad.label}: ${res.status()} ${String(err).includes(`${s.noun} #2`) ? `names ${s.noun} #2` : `MESSAGE=${String(err).slice(0, 120)}`}`);
          }
          expect(got,
            `${s.url}: every malformed row must be a considered 400 that NAMES the offending row — ` +
            `never a 5xx crash and never a silent drop (v7.21.1 / A10)`
          ).toEqual(BAD_ROWS.map(b => `${b.label}: 400 names ${s.noun} #2`));
        } finally { await api.dispose(); }
      });
    }

    // POSITIVE CONTROLS. Without these, an endpoint that 400s on EVERYTHING
    // (or a dry run that never runs at all) satisfies every assertion above.
    test(`${s.name} import — a well-formed batch still dry-runs and imports`, async () => {
      const { api, csrf } = await apiLogin("superadmin");
      try {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const row = s.good(stamp);

        const dry = await api.post(s.url, { headers: h(csrf), data: { data: s.body([row]) } });
        expect(dry.ok(), `dry run: ${dry.status()} ${await dry.text()}`).toBeTruthy();
        const dryBody = await dry.json();
        expect(dryBody.dryRun, "a body with no resolutions must be a dry run").toBeTruthy();
        expect(dryBody.total).toBe(1);

        const run = await api.post(s.url, { headers: h(csrf), data: { data: s.body([row]), resolutions: {} } });
        expect(run.ok(), `import: ${run.status()} ${await run.text()}`).toBeTruthy();

        if (s.name === "challenges") {
          const tasks = await (await api.get("/api/admin/tasks")).json();
          expect((Array.isArray(tasks) ? tasks : tasks.tasks).some(t => t.title === row.title),
            "the imported challenge must exist").toBeTruthy();
        } else {
          const parts = (await (await api.get("/api/admin/participants?limit=500")).json()).participants;
          expect(parts.some(p => p.email === row.email), "the imported participant must exist").toBeTruthy();
        }
      } finally { await api.dispose(); }
    });
  }
});

