// @ts-check
//
// v8.8.11 — THE FOCUSED PARTICIPANTS TAB SHOWED THE OLDEST 500 AND LOOKED
// COMPLETE.
//
// Reported: "selecting an event and then switching to the participants pane, the
// number of participants shown is truncated to the ones assigned to the event +
// 500… I have an impression these are the first 500 on the platform, so any
// newer participants become invisible."
//
// Exactly so. Focusing an event swapped the pane onto
// `GET /api/admin/participants/picker`, whose contract is members-in-full plus
// non-members `ORDER BY u.created_at, u.id LIMIT 500` — built for the ASSIGN
// DIALOG, where "type to narrow the candidates" is the right shape, and the
// wrong shape twice over on a TAB that has its own pager, its own count and its
// own search over the fetched array. The pane looked complete, and the rows it
// kept were the OLDEST accounts on the platform.
//
// THE ENDPOINT IS UNCHANGED. The fix removed a CONSUMER: the tab now walks
// `/api/admin/participants` on both paths. So this file's first job is to pin
// the picker's contract as it stands — which is also the CONTROL that proves the
// fixture really exceeds the cap. Without that arm, "the walk returned everyone"
// passes on a forty-user fixture where nothing was ever truncated.

const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DATA_DIR } = require("./helpers");
const { H, buildWorld, makeCompetition, makeParticipant, enrol, grantEventAdmin } = require("./event-admin-helpers");
const fs = require("fs");
const path = require("path");

const SEED_N = 520;   // comfortably over _PICKER_LIMIT_DEFAULT (500)

/** Walk the main list the way the client does, and return every row. */
async function walkAll(api) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await api.get(`/api/admin/participants?limit=5000&page=${page}`);
    expect(r.ok(), `participants page ${page}: ${r.status()}`).toBeTruthy();
    const body = await r.json();
    out.push(...(body.participants || []));
    if (out.length >= body.total || !(body.participants || []).length) break;
  }
  return out;
}

test.describe("v8.8.11 — the focused pane is not truncated", () => {
  test.slow();
  /** @type {any} */ let sa, csrf;
  let comp, newest, memberId;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;

    comp = await makeCompetition(sa, csrf, "fulllist");
    const m = await makeParticipant(sa, csrf, "member");
    memberId = m.id;
    await enrol(sa, csrf, comp.id, [m.id]);

    // Seed past the cap through the maintenance-gated bulk endpoint — the only
    // way to reach 500+ accounts in a spec. The sentinel MUST be removed in a
    // finally: a leaked one 503s every later request in the file.
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = `fulllist-${stamp}`;
    try {
      fs.writeFileSync(maintFile, byp);
      const users = Array.from({ length: SEED_N }, (_, i) => ({
        firstName: "Bulk", lastName: `N${i}`,
        nickname: `fl${stamp}${i}`, email: `fl_${stamp}_${i}@acme.com`,
      }));
      const r = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...H(csrf), "x-maintenance-bypass": byp },
        data: { users, sharedPassword: "testpass123" },
      });
      expect(r.status(), `bulk-seed: ${r.status()} ${await r.text()}`).toBe(200);
    } finally { try { fs.unlinkSync(maintFile); } catch (_) {} }

    // Registered LAST, so it sits past the cap in `created_at` order — the
    // account the operator could not see.
    newest = await makeParticipant(sa, csrf, "newest");
  });

  test("CONTROL — the picker really does truncate, and hides the NEWEST", async () => {
    // The fixture precondition AND the endpoint's surviving contract. If this
    // ever stops being true the arms below prove nothing, because a fixture
    // under the cap makes "everyone came back" vacuous.
    const r = await sa.get(`/api/admin/participants/picker?competitionId=${comp.id}`);
    expect(r.ok(), `picker: ${r.status()}`).toBeTruthy();
    const b = await r.json();
    expect(b.truncated, "the picker says it truncated").toBe(true);
    const ids = new Set((b.users || []).map(u => u.id));
    expect(ids.has(newest.id), "…and the newest account is NOT in it").toBe(false);
    expect(ids.has(memberId), "…while the event's own member always is").toBe(true);
  });

  test("the main list returns everyone, including the account past the cap", async () => {
    const all = await walkAll(sa);
    const ids = new Set(all.map(u => u.id));
    expect(ids.has(newest.id), "the newest account is reachable").toBe(true);
    expect(ids.has(memberId), "…and so is the event's member").toBe(true);
    expect(all.length, "…and the walk really exceeded the cap").toBeGreaterThan(500);
  });

  test("it carries what the focused pane needs — membership and the chosen session", async () => {
    // The fix derives `chosen_timeslot_id` from `competitions[]` rather than
    // from the picker's own column, so the array must carry the slot. Asserted
    // on the wire, because a client test cannot tell a missing field from a
    // mis-rendered row.
    const all = await walkAll(sa);
    const row = all.find(u => u.id === memberId);
    expect(row, "the member is in the walk").toBeTruthy();
    const entry = (row.competitions || []).find(c => c.id === comp.id);
    expect(entry, "…and their row names the focused event").toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(entry, "timeslot_id"),
      "…including the slot the pane dims on").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE EVENT-ADMIN HALF, which is the part that must NOT widen. The operator's
// requirement is two-sided: every participant reachable for a global admin, and
// only their own for an organiser.
//
// The equality below is the load-bearing assertion. `_userInScopeSql` on the
// main list admits "enrolled in at least one of MY events"; the picker returned
// that tier its members bucket plus an `_nmVis`-narrowed non-member bucket,
// which is the same set. So swapping the endpoint moved NOTHING for an event
// admin — and that is asserted rather than argued.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.8.11 — an event admin still sees only their own people", () => {
  /** @type {any} */ let w;
  let second, inSecond;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    w = await buildWorld();
    // A SECOND granted event, because with only one the non-member pool is empty
    // by construction and the two endpoints agree trivially.
    second = await makeCompetition(w.sa, w.saCsrf, "eafl2");
    await grantEventAdmin(w.sa, w.saCsrf, second.id, w.ea.id);
    inSecond = await makeParticipant(w.sa, w.saCsrf, "insecond");
    await enrol(w.sa, w.saCsrf, second.id, [inSecond.id]);
  });

  test("the walk is narrowed to their events, in both directions", async () => {
    const ids = new Set((await walkAll(w.eaApi)).map(u => u.id));
    expect(ids.has(w.inMine.id), "somebody in an event they run").toBe(true);
    expect(ids.has(inSecond.id), "…and in their second event").toBe(true);
    expect(ids.has(w.inTheirs.id), "NOT somebody only in another organiser's event").toBe(false);
    expect(ids.has(w.zero.id), "…nor an unrelated account").toBe(false);
  });

  test("CONTROL — a superadmin on the same fixture sees both", async () => {
    // Without this, "the organiser saw only their people" is equally satisfied
    // by a build that returns nothing to anybody.
    const ids = new Set((await walkAll(w.sa)).map(u => u.id));
    expect(ids.has(w.inTheirs.id), "the decoy's participant exists and is reachable").toBe(true);
    expect(ids.has(w.zero.id), "…and so is the unrelated account").toBe(true);
  });

  test("the swap moved NOTHING for this tier: the two endpoints agree exactly", async () => {
    const walked = new Set((await walkAll(w.eaApi)).map(u => u.id));
    const r = await w.eaApi.get(`/api/admin/participants/picker?competitionId=${w.mine.id}&limit=5000`);
    expect(r.ok(), `picker as event admin: ${r.status()}`).toBeTruthy();
    const picked = new Set(((await r.json()).users || []).map(u => u.id));
    expect([...picked].sort(), "the picker's set and the main list's are identical")
      .toEqual([...walked].sort());
    expect(picked.size, "…and it is not the empty set agreeing with itself").toBeGreaterThan(0);
  });

});
