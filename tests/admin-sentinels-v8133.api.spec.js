// @ts-check
//
// v8.13.3 — KEYS A CALLER CAN SPELL, IDENTITIES A KEY FORGOT, AND A CAPABILITY
// WRITTEN WHERE EVERY ORGANISER READS IT.
//
// The defects in this file share one shape: a decision keyed on something that was
// not the whole truth.
//
//   PC-1   the admin participants cache spelled "no event filter" as `_all`, so
//          `?competitionId=_all` shared the pane's own unfiltered entry.
//   UNK-1  an event that does not exist answered an empty 200 on the participants
//          list and picker — "nobody has joined" — and on the admin challenge list
//          and the Submissions stream, instead of the 404 every other named-event
//          admin read gives.
//   PC-2   that cache keyed on the SEAT alone, while `rival_in` is computed from the
//          seat AND the impersonating hand — so an organiser's own pane and an admin
//          looking through it shared one entry.
//   WRITERS the staff_compete switch and a competition DELETE change what the
//          participants page reports and busted nothing.
//   SNAP-1 the competition-history cache spelled "no anchor" as `_`, so
//          `?snapshot_before=_&snapshot_tie=_` cached a body that echoed `_` as the
//          drift anchor every admin's History was then handed.
//   LB-1   the frozen team board spelled the global slot `__global__`, so a crafted
//          `?timeslotId=__global__` on a per_slot event froze an empty board under
//          the official key, and any other junk slot wrote a junk snapshot row.
//   BTB-1  `groupId` was bound unguarded: `[gid]` was accepted (better-sqlite3
//          flattens a one-element array), `{}` / `true` were a generic 500.
//   BD-2   the public badge 404 said the badge "may have been removed by its owner",
//          which no route lets an owner do.
//   LCL-3  `invitation_competition_added` stored the LIVE invitation id — a bearer
//          capability — in a History row every organiser of any one of its events
//          reads, and a re-invite handed a scoped organiser the registration link
//          for an invitation that also names events outside their remit.
//   PORT-1 a spawned test server at `<port base> + <offset> + <worker index>` spans a
//          band of offsets the registry cannot see.
//
// Every positive assertion has a CONTROL beside it, or "the bad value is refused" is
// satisfied by a build that refuses everything. Every fixture is this file's own.

const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const {
  H, uniq, makeParticipant, makeCompetition, enrol, grantEventAdmin, buildWorld,
} = require("./event-admin-helpers");
const participantsCache = require("../lib/participants-cache");

function dbAll(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}
function dbRun(sql, ...args) {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
}
/** The fingerprint lib/audit.js records in place of a capability. */
const fp = (v, prefix) => prefix + crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 12);
/** A random id-shaped string that names nothing. */
const ghostId = () => crypto.randomUUID();

/** A user-backed admin account (regular or superadmin), verified + approved. */
async function makeAdmin(sa, saCsrf, label, role = "admin") {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}

let W; // the standard event-admin world (lib: tests/event-admin-helpers.js)

test.beforeAll(async () => {
  test.setTimeout(180_000);
  W = await buildWorld();
});
test.afterAll(async () => {
  try { await W?.sa.dispose(); } catch (_) {}
  try { await W?.eaApi.dispose(); } catch (_) {}
  try { await W?.zeroApi.dispose(); } catch (_) {}
});

/** The participants list row for `userId`, read by `api` with a distinct `limit` (a distinct cache key). */
async function rowFor(api, userId, limit, extra = "") {
  const r = await api.get(`/api/admin/participants?limit=${limit}${extra}`);
  expect(r.status(), `participants list (limit ${limit}): ${await r.text()}`).toBe(200);
  const b = await r.json();
  return { body: b, row: (b.participants || []).find(p => p.id === userId) || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// PC-1 + UNK-1 — a filter a caller can spell must not spell "no filter"
// ─────────────────────────────────────────────────────────────────────────────
test.describe("PC-1 — the participants cache key cannot spell the unfiltered marker", () => {
  test("unit: `_all`, `all` and an absent filter are three different keys", () => {
    // lib/participants-cache.js requires nothing, so it is safe at module scope (the
    // v7.20.2 scanner flags only modules that reach db.js). This module instance is
    // the TEST's, not the server's — the arm is about the KEY, which is pure.
    const { getCachedParticipantsPage: get, setCachedParticipantsPage: set, invalidateAdminParticipantsCache: clear } = participantsCache;
    clear();
    const actor = `unit-${uniq("a")}`;
    set(undefined, 1, 200, { who: "unfiltered" }, actor);
    expect(get("_all", 1, 200, actor), "a crafted `_all` filter does NOT read the unfiltered entry").toBeUndefined();
    expect(get("all", 1, 200, actor), "…nor does the bare `all`").toBeUndefined();
    expect(get(undefined, 1, 200, actor), "CONTROL: the unfiltered read finds its own entry").toEqual({ who: "unfiltered" });
    expect(get("", 1, 200, actor), "CONTROL: an EMPTY filter is no filter (the route treats it as absent)").toEqual({ who: "unfiltered" });

    set("_all", 2, 200, { who: "crafted" }, actor);
    expect(get(undefined, 2, 200, actor), "the reverse: a crafted `_all` entry is not served to the unfiltered read").toBeUndefined();
    expect(get("_all", 2, 200, actor), "CONTROL: a real (if odd) filter finds its own entry").toEqual({ who: "crafted" });

    set("comp-x", 3, 200, { who: "x" }, actor);
    expect(get("comp-x", 3, 200, `${actor}-other`), "CONTROL: the actor is still part of the key").toBeUndefined();
    clear();
  });

  test("API: `?competitionId=_all` is a 404 and the pane's unfiltered read is untouched", async () => {
    const P = await makeParticipant(W.sa, W.saCsrf, "pc1");
    // No write between the two reads — every writer clears this cache, which would
    // mask a collision rather than prove there is none.
    const crafted = await W.sa.get("/api/admin/participants?competitionId=_all&limit=4318");
    expect(crafted.status(), `crafted _all: ${await crafted.text()}`).toBe(404);
    const { row } = await rowFor(W.sa, P.id, 4318);
    expect(row, "the unfiltered read still lists the participant").toBeTruthy();
  });
});

test.describe("UNK-1 — an event that does not exist is a 404 on every admin read that names one", () => {
  test("unknown id → 404 on the participants list and picker; a real id → 200 (CONTROL); an event admin still hears the scope refusal first", async () => {
    const ghost = ghostId();
    const l = await W.sa.get(`/api/admin/participants?competitionId=${ghost}`);
    expect(l.status(), `list: ${await l.text()}`).toBe(404);
    expect((await l.json()).error).toMatch(/not found/i);
    const p = await W.sa.get(`/api/admin/participants/picker?competitionId=${ghost}`);
    expect(p.status(), `picker: ${await p.text()}`).toBe(404);

    // CONTROL — a real event still answers, with its member in it.
    const lr = await W.sa.get(`/api/admin/participants?competitionId=${W.mine.id}`);
    expect(lr.status(), await lr.text()).toBe(200);
    expect((await lr.json()).participants.some(x => x.id === W.inMine.id), "the real event lists its member").toBe(true);
    const pr = await W.sa.get(`/api/admin/participants/picker?competitionId=${W.mine.id}`);
    expect(pr.status(), await pr.text()).toBe(200);

    // The existence check sits AFTER the scope check: an event admin asking about an
    // id outside their events — real or not — gets the same 403, so the answer says
    // nothing about which ids exist.
    for (const id of [ghost, W.theirs.id]) {
      const r = await W.eaApi.get(`/api/admin/participants?competitionId=${id}`);
      expect(r.status(), `event admin, ${id === ghost ? "unknown" : "out-of-scope"} id: ${await r.text()}`).toBe(403);
    }
  });

  test("the admin challenge list and the Submissions stream: unknown id → 404, real id → 200 (CONTROL), and an event admin hears 403 for both an unknown and a foreign id", async () => {
    const ghost = ghostId();
    for (const path of ["/api/admin/tasks", "/api/admin/submissions"]) {
      const u = await W.sa.get(`${path}?competitionId=${ghost}`);
      expect(u.status(), `${path}, unknown id: ${await u.text()}`).toBe(404);
      expect((await u.json()).error, `${path}: names the missing event`).toBe("Event not found");
      // CONTROL — a real event is answered, so the 404 is about existence, not the route.
      const k = await W.sa.get(`${path}?competitionId=${W.mine.id}`);
      expect(k.status(), `${path}, real id: ${await k.text()}`).toBe(200);
      // After the scope check: the same 403 whether the id names nothing or somebody
      // else's event, so the difference is not an existence oracle.
      for (const id of [ghost, W.theirs.id]) {
        const r = await W.eaApi.get(`${path}?competitionId=${id}`);
        expect(r.status(), `${path}, event admin, ${id === ghost ? "unknown" : "out-of-scope"} id: ${await r.text()}`).toBe(403);
      }
      // And an event admin's OWN event still answers (CONTROL for the 403s above).
      const own = await W.eaApi.get(`${path}?competitionId=${W.mine.id}`);
      expect(own.status(), `${path}, event admin, own event: ${await own.text()}`).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PC-2 — the cache key names the HAND as well as the seat
// ─────────────────────────────────────────────────────────────────────────────
test.describe("PC-2 — an organiser's own pane and an admin looking through it never share a cache entry", () => {
  test("rival_in follows the identities that computed it, in both orders", async () => {
    test.setTimeout(120_000);
    // A USER-BACKED superadmin who competes in a compete event alongside a
    // participant the organiser can see. Through the organiser's seat that
    // participant is a RIVAL (competitorIds = seat + hand); in the organiser's own
    // pane they are not.
    const SUP = await makeAdmin(W.sa, W.saCsrf, "pc2sup", "superadmin");
    const E = await makeCompetition(W.sa, W.saCsrf, "pc2compete", { staff_compete: true });
    await enrol(W.sa, W.saCsrf, E.id, [SUP.id, W.inMine.id]);

    const s = await apiLogin(SUP.email, PARTICIPANT_PASS);
    const imp = await s.api.post(`/api/admin/participants/${W.ea.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
    expect(imp.status(), `enter the organiser's admin view: ${await imp.text()}`).toBe(200);
    try {
      // Order 1: the organiser reads first; the hand's read must not be served it.
      const own1 = await rowFor(W.eaApi, W.inMine.id, 4317);
      expect(own1.row, "the organiser sees their participant").toBeTruthy();
      expect(own1.row.rival_in, "…who is no rival of theirs").toBeNull();
      const seat1 = await rowFor(s.api, W.inMine.id, 4317);
      expect(seat1.row, "the seat sees the same participant").toBeTruthy();
      expect(seat1.row.rival_in && seat1.row.rival_in.id,
        "through the seat the participant IS a rival of the hand — not the organiser's cached body").toBe(E.id);

      // Order 2: the hand reads first; the organiser must not be served it — that body
      // names a compete event outside the organiser's own remit.
      const seat2 = await rowFor(s.api, W.inMine.id, 4316);
      expect(seat2.row.rival_in && seat2.row.rival_in.id, "the seat, first this time").toBe(E.id);
      const own2 = await rowFor(W.eaApi, W.inMine.id, 4316);
      expect(own2.row.rival_in, "the organiser's own pane is not handed the hand's body").toBeNull();
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H((await (await s.api.get("/api/csrf-token")).json()).csrfToken) }).catch(() => {});
      await s.api.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The participants page's missing WRITERS
// ─────────────────────────────────────────────────────────────────────────────
test.describe("cache writers — the staff_compete switch and a competition DELETE bust the participants page", () => {
  test("turning staff_compete OFF is reflected on the very next read", async () => {
    test.setTimeout(120_000);
    // An EVENT ADMIN holds a row on the compete event (the role is not staff-TAGGED,
    // so the OFF refusal — which names enrolled staff — does not apply), beside a
    // participant of an event they organise. While the switch is on, that
    // participant is their rival.
    const F = await makeCompetition(W.sa, W.saCsrf, "busts-f");
    const E = await makeCompetition(W.sa, W.saCsrf, "busts-e", {
      staff_compete: true, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60,
    });
    const T = await makeParticipant(W.sa, W.saCsrf, "busts-t");
    const Q = await makeParticipant(W.sa, W.saCsrf, "busts-q");
    await grantEventAdmin(W.sa, W.saCsrf, F.id, T.id);
    await enrol(W.sa, W.saCsrf, F.id, [Q.id]);
    await enrol(W.sa, W.saCsrf, E.id, [Q.id, T.id]);
    const t = await apiLogin(T.email, PARTICIPANT_PASS);
    try {
      const before = await rowFor(t.api, Q.id, 4315);
      expect(before.row && before.row.rival_in && before.row.rival_in.id, "PRECONDITION: Q is T's rival while the switch is on").toBe(E.id);
      const off = await W.sa.put(`/api/admin/competitions/${E.id}`, { headers: H(W.saCsrf), data: { staff_compete: false } });
      expect(off.status(), `switch OFF: ${await off.text()}`).toBe(200);
      const after = await rowFor(t.api, Q.id, 4315);
      expect(after.row.rival_in, "the next read reflects the switch — not the cached page").toBeNull();
    } finally { await t.api.dispose(); }
  });

  test("a deleted competition leaves every participant's events column at once", async () => {
    const P = await makeParticipant(W.sa, W.saCsrf, "busts-del");
    const D = await makeCompetition(W.sa, W.saCsrf, "busts-del", {
      start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60,
    });
    await enrol(W.sa, W.saCsrf, D.id, [P.id]);
    const before = await rowFor(W.sa, P.id, 4314);
    expect((before.row.competitions || []).some(c => c.id === D.id), "PRECONDITION: the row names the event").toBe(true);
    const del = await W.sa.delete(`/api/admin/competitions/${D.id}`, { headers: H(W.saCsrf) });
    expect(del.status(), `delete: ${await del.text()}`).toBe(200);
    const after = await rowFor(W.sa, P.id, 4314);
    expect((after.row.competitions || []).some(c => c.id === D.id), "the very next read no longer names the deleted event").toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SNAP-1 — a drift anchor that is not a timestamp is no anchor
// ─────────────────────────────────────────────────────────────────────────────
test.describe("SNAP-1 — the History cache cannot be handed `_` as its drift anchor", () => {
  test("a crafted `_`/`_` read echoes a real anchor, and so does the anchorless read after it", async () => {
    const C = await makeCompetition(W.sa, W.saCsrf, "snap1");
    const url = `/api/admin/competitions/${C.id}/events?limit=37&offset=0`;
    const crafted = await (await W.sa.get(`${url}&snapshot_before=_&snapshot_tie=_`)).json();
    expect(Number.isFinite(Date.parse(crafted.snapshot_before)), `the crafted read echoes a TIMESTAMP, not ${JSON.stringify(crafted.snapshot_before)}`).toBe(true);
    // Within the 5 s TTL, on the key the crafted read used to poison. (The key is
    // JSON-encoded since this release, so the two no longer share an entry at all;
    // what this pins is that neither read is ever handed `_` as its anchor.)
    const plain = await (await W.sa.get(url)).json();
    expect(Number.isFinite(Date.parse(plain.snapshot_before)), `the anchorless read's anchor is a timestamp: ${JSON.stringify(plain.snapshot_before)}`).toBe(true);
    expect(String(plain.snapshot_tie), "…and its tie is the integer rowid").toMatch(/^\d+$/);
    expect(plain.events.length, "…and the history is there").toBeGreaterThan(0);

    // An ISO value with junk appended is not an anchor either: Date.parse refuses
    // it, so it is read as absent and the anchor is re-derived.
    const injected = await (await W.sa.get(`/api/admin/competitions/${C.id}/events?limit=36&offset=0&snapshot_before=${encodeURIComponent(plain.snapshot_before + ":t5")}`)).json();
    expect(injected.snapshot_before, "an ISO value with `:t` grafted on is no anchor").toBe(plain.snapshot_before);

    // CONTROL — a genuine echoed anchor still pins the walk exactly as before.
    const page2 = await (await W.sa.get(`/api/admin/competitions/${C.id}/events?limit=35&offset=0&snapshot_before=${encodeURIComponent(plain.snapshot_before)}&snapshot_tie=${plain.snapshot_tie}`)).json();
    expect(page2.snapshot_before, "a real anchor is echoed unchanged").toBe(plain.snapshot_before);
    expect(String(page2.snapshot_tie), "…with its tie").toBe(String(plain.snapshot_tie));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LB-1 — a slot that is not this event's is not a key the official board is frozen under
// ─────────────────────────────────────────────────────────────────────────────
test.describe("LB-1 — a crafted timeslotId cannot freeze the team board", () => {
  test("per_slot, fully ended, flag on: `__global__` / junk / foreign slots 404 and write NO snapshot; a real slot still freezes (CONTROL)", async () => {
    const now = Date.now();
    const C = await makeCompetition(W.sa, W.saCsrf, "lb1", { leaderboard_mode: "per_slot", start_time: new Date(now - 120_000).toISOString(), duration_minutes: 240 });
    const ts = await W.sa.post(`/api/admin/competitions/${C.id}/timeslots`, { headers: H(W.saCsrf), data: {
      name: "Only", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    } });
    expect(ts.ok(), `session: ${ts.status()} ${await ts.text()}`).toBeTruthy();
    const slot = (await ts.json()).timeslot.id;
    // A slot of ANOTHER event — the foreign case.
    const O = await makeCompetition(W.sa, W.saCsrf, "lb1-other", { leaderboard_mode: "per_slot" });
    const ots = await W.sa.post(`/api/admin/competitions/${O.id}/timeslots`, { headers: H(W.saCsrf), data: {
      name: "Theirs", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    } });
    expect(ots.ok(), await ots.text()).toBeTruthy();
    const foreign = (await ots.json()).timeslot.id;

    // End the only session — the event is fully ended — with the team board OFF, so
    // the end-time freeze writes nothing (it does not freeze a null the flag caused).
    const end = await W.sa.post(`/api/admin/competitions/${C.id}/timeslots/${slot}/end-now`, { headers: H(W.saCsrf) });
    expect(end.ok(), `end the session: ${end.status()} ${await end.text()}`).toBeTruthy();
    const list = await (await W.sa.get("/api/admin/competitions")).json();
    const row = (list.competitions || list).find(c => c.id === C.id);
    expect(row && row.status, "PRECONDITION: the event is fully ended").toBe("ended");
    expect(row.leaderboard_mode, "PRECONDITION: per_slot, the only mode that reads the slot").toBe("per_slot");
    // Turned on after the end — the operator's ordinary "show me Team Rankings now".
    dbRun("UPDATE competitions SET group_leaderboard_enabled=1 WHERE id=?", C.id);
    const snaps = () => dbAll("SELECT slot_key FROM group_leaderboard_snapshots WHERE competition_id=?", C.id).map(r => r.slot_key);
    expect(snaps(), "PRECONDITION: nothing frozen yet").toEqual([]);

    for (const [label, tsId] of [["__global__", "__global__"], ["junk", `junk-${uniq("s")}`], ["foreign", foreign]]) {
      const r = await W.sa.get(`/api/admin/leaderboard?competitionId=${C.id}&groups=1&timeslotId=${encodeURIComponent(tsId)}`);
      expect(r.status(), `${label} slot: ${await r.text()}`).toBe(404);
    }
    expect(snaps(), "no crafted slot wrote a snapshot — least of all under the official global key").toEqual([]);

    // CONTROL — the real session still reads, and its lazy freeze still happens.
    const real = await W.sa.get(`/api/admin/leaderboard?competitionId=${C.id}&groups=1&timeslotId=${slot}`);
    expect(real.status(), await real.text()).toBe(200);
    expect(snaps(), "the real slot froze under its own id").toEqual([slot]);

    // CONTROL — a GLOBAL-mode event ignores the slot exactly as before.
    const G = await makeCompetition(W.sa, W.saCsrf, "lb1-global", { leaderboard_mode: "global" });
    const g = await W.sa.get(`/api/admin/leaderboard?competitionId=${G.id}&groups=1&timeslotId=__global__`);
    expect(g.status(), `global mode: ${await g.text()}`).toBe(200);
  });

  test("source: buildGroupLeaderboard refuses a foreign slot BEFORE it reads or writes a snapshot", () => {
    // The route 404s first, so this guard is unreachable through it today — DEFENCE IN
    // DEPTH, pinned at source because no behaviour reaches it. It is what keeps a
    // future caller from freezing the official board under a caller-spelled slot.
    const raw = fs.readFileSync(path.join(__dirname, "..", "lib", "leaderboard.js"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? "" : pre));
    const start = src.indexOf("function buildGroupLeaderboard(");
    expect(start, "buildGroupLeaderboard exists").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\nfunction ", start + 10));
    const guard = body.search(/getTimeslot\(\s*String\(timeslotId\)\s*\)/);
    const refuse = body.search(/competition_id\s*!==\s*competitionId\)\s*return null/);
    const read = body.indexOf("_getGroupSnapshot(");
    const write = body.indexOf("_saveGroupSnapshot(");
    expect(guard, "the slot is resolved").toBeGreaterThan(-1);
    expect(refuse, "…and a slot of another event (or none) is refused").toBeGreaterThan(-1);
    expect(read, "the snapshot read exists").toBeGreaterThan(-1);
    expect(write, "the lazy freeze exists").toBeGreaterThan(-1);
    expect(refuse < read && refuse < write, "the refusal precedes the snapshot read and the lazy freeze").toBe(true);

    // The read-only twin: the 5 s board cache spelled the no-slot bucket `_global`,
    // a string a caller could send as `?timeslotId=_global`. A real slot is now
    // `ts:<id>`, which can never equal the bare sentinel. Also unreachable through
    // the admin route (an unknown slot 404s first), so pinned here.
    const keyFn = src.match(/function _leaderboardTsKey\(tsId\)\s*\{([^\n]*)/);
    expect(keyFn, "the board cache keys its slot through one function").toBeTruthy();
    expect(keyFn[1], "…which PREFIXES a real slot, so no slot id can spell the global bucket").toMatch(/`ts:\$\{tsId\}`/);
    expect((src.match(/_leaderboardTsKey\(tsId\)/g) || []).length, "…and both the cache read and write use it").toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BTB-1 — a body field bound to SQL is type-checked first
// ─────────────────────────────────────────────────────────────────────────────
test.describe("BTB-1 — POST /api/admin/participants/:id/groups refuses a non-text groupId", () => {
  test("array / object / boolean / number groupId → 400 and nothing written; a string → 200 (CONTROL)", async () => {
    const P = await makeParticipant(W.sa, W.saCsrf, "btb1");
    const g = await W.sa.post("/api/admin/groups", { headers: H(W.saCsrf), data: { name: `BTB ${uniq("g")}`.slice(0, 80) } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    const gid = (await g.json()).group.id;
    const members = () => dbAll("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?", gid, P.id).length;
    const audits = () => dbAll("SELECT 1 FROM user_events WHERE user_id=? AND event_type='group_added'", P.id).length;

    // `[gid]` is the sharp one: better-sqlite3 FLATTENS a one-element array, so it was
    // ACCEPTED, and the audit row recorded `group_id` as an array.
    for (const bad of [[gid], [], [gid, gid], {}, true, 5, [[gid]]]) {
      const r = await W.sa.post(`/api/admin/participants/${P.id}/groups`, { headers: H(W.saCsrf), data: { groupId: bad } });
      expect(r.status(), `groupId=${JSON.stringify(bad)}: ${await r.text()}`).toBe(400);
      expect((await r.json()).error, "the refusal names the field").toBe("groupId must be text");
    }
    expect(members(), "no bad shape added a membership").toBe(0);
    expect(audits(), "…or wrote an audit row").toBe(0);

    // CONTROL — the ordinary string adds the member, once, with a string in the trail.
    const ok = await W.sa.post(`/api/admin/participants/${P.id}/groups`, { headers: H(W.saCsrf), data: { groupId: gid } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(members(), "the string groupId added the membership").toBe(1);
    const ev = dbGet("SELECT details FROM user_events WHERE user_id=? AND event_type='group_added'", P.id);
    expect(typeof JSON.parse(ev.details).group_id, "the audit trail records the id as text").toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BD-2 — the public badge 404 says only what is true
// ─────────────────────────────────────────────────────────────────────────────
test.describe("BD-2 — the badge 404 makes no claim about an owner removing anything", () => {
  test("the one sentence is honest, and names none of the four causes", async () => {
    const r = await W.sa.get(`/badge/${crypto.randomBytes(16).toString("hex")}`);
    expect(r.status()).toBe(404);
    const html = await r.text();
    expect(html, "the shell rendered (CONTROL: this is the badge 404, not a router 404)").toContain("This badge isn");
    expect(html).toContain("The link may be incorrect, or this badge is not published or is no longer available.");
    expect(html, "no route lets a holder remove a badge").not.toMatch(/removed by (its|the) owner/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LCL-3 — an invitation id is a capability; record its fingerprint, hand out its link only to its owner's remit
// ─────────────────────────────────────────────────────────────────────────────
test.describe("LCL-3 — a scoped organiser re-inviting an address never receives another organiser's live invitation", () => {
  test("History stores and shows the fingerprint; the response withholds the link; an organiser's OWN invitation keeps its link (CONTROL)", async () => {
    test.setTimeout(120_000);
    const victim = `lcl3-${uniq("v")}@acme.com`.toLowerCase();
    // A superadmin's invitation to an event OUTSIDE the organiser's scope. The shared
    // test relay is dead, so its send fails and the row stays `last_send_success=0` —
    // the state in which a re-invite re-sends and, failing again, reports the link.
    const first = await W.sa.post("/api/admin/invitations", { headers: H(W.saCsrf), data: { emails: [victim], competitionIds: [W.theirs.id] } });
    expect(first.ok(), `superadmin invite: ${first.status()} ${await first.text()}`).toBeTruthy();
    const inv = dbGet("SELECT id, last_send_success FROM invitations WHERE LOWER(email)=? AND used_at IS NULL", victim);
    expect(inv && inv.id, "PRECONDITION: the pending invitation exists").toBeTruthy();
    expect(inv.last_send_success, "PRECONDITION: its send failed (dead relay)").toBe(0);

    // The organiser of `mine` ONLY invites the same address to their own event.
    const re = await W.eaApi.post("/api/admin/invitations", { headers: H(W.eaCsrf), data: { emails: [victim], competitionIds: [W.mine.id] } });
    expect(re.ok(), `organiser re-invite: ${re.status()} ${await re.text()}`).toBeTruthy();
    const rb = await re.json();
    expect(JSON.stringify(rb), "the response carries the live invitation id nowhere").not.toContain(inv.id);
    const entry = (rb.undeliveredInvites || []).find(u => u.email.toLowerCase() === victim);
    expect(entry, "PRECONDITION: the re-send failed and was reported").toBeTruthy();
    expect(entry.link, "…WITHOUT the link: the invitation also names an event outside this organiser's remit").toBeNull();
    expect(entry.linkWithheld, "…and says so").toBe(true);

    // The audit row: stored as a fingerprint, and read back as one by the organiser.
    const stored = dbAll("SELECT details FROM competition_events WHERE competition_id=? AND event_type='invitation_competition_added'", W.mine.id)
      .map(r => JSON.parse(r.details)).find(d => d.email && d.email.toLowerCase() === victim);
    expect(stored, "PRECONDITION: the merge recorded an audit row on the organiser's event").toBeTruthy();
    expect(stored.invitation_id, "the STORED row carries no invitation id").toBeUndefined();
    expect(stored.invitation_fp, "…but its fingerprint").toBe(fp(inv.id, "if_"));
    const hist = await W.eaApi.get(`/api/admin/competitions/${W.mine.id}/events?limit=200&offset=0`);
    expect(hist.status(), await hist.text()).toBe(200);
    const hb = await hist.json();
    expect(JSON.stringify(hb), "the organiser's History never shows the live id").not.toContain(inv.id);
    const ev = hb.events.find(e => e.event_type === "invitation_competition_added" && (e.details?.email || "").toLowerCase() === victim);
    expect(ev, "the History row survived (CONTROL: not simply dropped)").toBeTruthy();
    expect(ev.details.competition_name, "…and is still useful").toBe(W.mine.name);
    expect(ev.details.invitation_fp).toBe(fp(inv.id, "if_"));
    const other = await W.eaApi.get(`/api/admin/competitions/${W.theirs.id}/events`);
    expect(other.status(), "CONTROL: the other organiser's History is refused, so the leak path was this event's").toBe(403);

    // CONTROL — the organiser's OWN invitation: a fresh address, then a re-invite of it.
    // Both report the link, so the manual-share remedy for a dead relay survives.
    const mineAddr = `lcl3-own-${uniq("o")}@acme.com`.toLowerCase();
    for (const round of [1, 2]) {
      const r = await W.eaApi.post("/api/admin/invitations", { headers: H(W.eaCsrf), data: { emails: [mineAddr], competitionIds: [W.mine.id] } });
      expect(r.ok(), `own invite round ${round}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const e = ((await r.json()).undeliveredInvites || []).find(u => u.email.toLowerCase() === mineAddr);
      const own = dbGet("SELECT id FROM invitations WHERE LOWER(email)=? AND used_at IS NULL", mineAddr);
      expect(e && e.link, `round ${round}: the organiser's own invitation keeps its link`).toContain(`invitation=${own.id}`);
    }
  });

  test("a row recorded BEFORE this release is masked on the way out", async () => {
    // Historical rows hold the raw id; masking happens at READ time, so nothing in a
    // retention-exempt audit table is rewritten. Planted directly, read through the
    // route under a cache key nothing else uses.
    const C = await makeCompetition(W.sa, W.saCsrf, "lcl3-legacy");
    const legacyId = crypto.randomUUID();
    dbRun("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(), C.id, "invitation_competition_added", "superadmin", new Date().toISOString(),
      JSON.stringify({ invitation_id: legacyId, email: "legacy@acme.com", competition_name: C.name }));
    const b = await (await W.sa.get(`/api/admin/competitions/${C.id}/events?limit=93&offset=0`)).json();
    expect(JSON.stringify(b), "the legacy row's id is not handed out").not.toContain(legacyId);
    const ev = b.events.find(e => e.event_type === "invitation_competition_added");
    expect(ev && ev.details.invitation_fp, "…it is shown as its fingerprint").toBe(fp(legacyId, "if_"));
    expect(ev.details.email, "CONTROL: the rest of the row is untouched").toBe("legacy@acme.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PORT-1 — a spawner offset is a fixed literal, never a band
// ─────────────────────────────────────────────────────────────────────────────
test.describe("PORT-1 — no spawned server binds `<port base> + <offset> + <variable>`", () => {
  test("every spawner-range offset is a bare literal (source)", () => {
    // The v8.3.26 registry scanner reads the digits after `<port base> +` and nothing
    // more, and global-setup pre-flights only those literal ports — so `+ 160 + idx`
    // occupied a BAND (+160..+183 at 24 workers) that collided with +170/+171 and
    // +180/+181 and was visible to neither. A spawner range offset (>= 100) combined
    // with any non-literal term is refused here; the worker's own slot
    // (`<port base> + workerIndex()`) is a different thing and stays legal.
    // The identifier is ASSEMBLED, never written — not even its second word, which
    // is itself a helpers.js export — so the v7.16.2 missing-import scanner does not
    // read this file as using either.
    const PB = ["PORT", "B" + "ASE"].join("_");
    const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length)));
    const bad = [];
    let literalSpawners = 0;
    for (const f of fs.readdirSync(__dirname).filter(x => x.endsWith(".js"))) {
      const src = strip(fs.readFileSync(path.join(__dirname, f), "utf8"));
      for (const m of src.matchAll(new RegExp(`\\b${PB}\\s*\\+\\s*([^;\\n,\`}]*)`, "g"))) {
        const expr = m[1].trim();
        const nums = (expr.match(/\b\d+\b/g) || []).map(Number);
        const spawnerRange = nums.some(n => n >= 100);
        const variable = /[A-Za-z_$]/.test(expr);
        if (spawnerRange && variable) bad.push(`${f}:${src.slice(0, m.index).split("\n").length}  ${PB} + ${expr}`);
        else if (spawnerRange) literalSpawners++;
      }
    }
    expect(bad, "a spawned server's port must be a FIXED offset registered in tests/global-setup.js " +
      "SPAWNER_OFFSETS (guard the spec with guardFixedPortSpec for --repeat-each):\n  " + bad.join("\n  ")).toEqual([]);
    // Anti-vacuity: a rename of the identifier would empty the match and pass.
    expect(literalSpawners, "the scan sees the suite's spawners").toBeGreaterThanOrEqual(12);
  });

  test("every spec that binds a spawner port calls the fixed-port guard (source)", () => {
    // A fixed port survives --repeat-each only at one worker; with several, two copies
    // of the spec race for it, and the loser fails as ENOENT or ECONNRESET, naming
    // nothing (tests/isolated-test.js). The guard turns that into an error that names
    // the cause, but only in a spec that calls it, and one spawner shipped without it.
    // "Binds a spawner port" is the arm above's extraction, so the two agree on the set.
    // Both identifiers are ASSEMBLED, for the reason the arm above gives.
    const PB = ["PORT", "B" + "ASE"].join("_");
    const G = ["guard", "FixedPortSpec"].join("");
    const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length)));
    const unguarded = [];
    let guarded = 0;
    for (const f of fs.readdirSync(__dirname).filter(x => x.endsWith(".spec.js"))) {
      const src = strip(fs.readFileSync(path.join(__dirname, f), "utf8"));
      const binds = [...src.matchAll(new RegExp(`\\b${PB}\\s*\\+\\s*([^;\\n,\`}]*)`, "g"))]
        .some(m => (m[1].match(/\b\d+\b/g) || []).map(Number).some(n => n >= 100));
      if (!binds) continue;
      if (new RegExp(`\\b${G}\\s*\\(\\s*\\)`).test(src)) guarded++;
      else unguarded.push(f);
    }
    expect(unguarded, `a spec that binds a fixed SPAWNER_OFFSETS port must call ${G}() — test.beforeEach(() => ${G}()):\n  ` +
      unguarded.join("\n  ")).toEqual([]);
    // Anti-vacuity: a rename of either identifier would empty the scan and pass.
    expect(guarded, "the scan sees the suite's guarded spawner specs").toBeGreaterThanOrEqual(12);
  });
});
