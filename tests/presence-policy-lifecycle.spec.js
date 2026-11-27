// v8.1.0 — the two PRESENCE settings are gated on the PUT, not only on create.
//
// Two defects, one shape.
//
// (a) `POST /api/admin/competitions` has refused `measure_presence` for a Booth
//     Event since PR 34, but the PUT accepted both `measure_presence` and
//     `time_basis` with NO policy check at all — and the edit form renders both
//     controls for every kind and posts them on every save. So an admin reached
//     by EDITING a state the platform refuses at CREATE: the exact reorder hole
//     the same handler's `reveal_answers_on_end` / `group_leaderboard_enabled`
//     refusals already close, one field over. Nothing downstream re-checks the
//     kind — the presence writer keys on the column alone.
//
// (b) `time_basis` had no lifecycle gate, so a superadmin (a regular admin is
//     403'd on an ended event) could flip the tie-break basis on a FULLY ENDED
//     competition. `_usePresenceRanking` is read live on every board build and
//     the individual board has no end snapshot, so every score-tied FINISHER
//     pair silently re-orders on the participant board, the admin Rankings tab
//     and the rankings CSV — while the placement badges already minted keep
//     asserting the old order.
//
// THE POSITIVE CONTROLS ARE THE LOAD-BEARING HALF. "The PUT refuses it" is
// equally satisfied by a build that refuses everything, and "an ended event is
// locked" is equally satisfied by one that has made ended events unsaveable —
// which is the realistic way to get this wrong, because the form round-trips
// both controls on every single save. So every refusal here is paired with the
// echo (the same value posted back) succeeding.
//
// Every test owns its own event (fixture checklist item 2). No participants are
// enrolled and nothing is solved, so no auto-end can move an event underneath an
// assertion.
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, TEST_DB_PATH } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `pp${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/**
 * An event of the given kind. `when` picks the lifecycle:
 *   "upcoming" — starts in an hour
 *   "live"     — started an hour ago, ten hours long
 *   "ended"    — started two hours ago, thirty minutes long (born-ended, which
 *                the create handler deliberately allows)
 * Returns the raw response so a test can assert a REFUSAL at create too.
 */
function eventBody(kind, when, extra) {
  const hour = 3600e3;
  const sched = when === "upcoming"
    ? { start_time: new Date(Date.now() + hour).toISOString(), duration_minutes: 600 }
    : when === "ended"
      ? { start_time: new Date(Date.now() - 2 * hour).toISOString(), duration_minutes: 30 }
      : { start_time: new Date(Date.now() - hour).toISOString(), duration_minutes: 600 };
  return { name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC", ...sched, ...extra };
}

function createEvent(api, csrf, kind, when, extra = {}) {
  return api.post("/api/admin/competitions", { headers: H(csrf), data: eventBody(kind, when, extra) });
}

async function makeEvent(api, csrf, kind, when, extra = {}) {
  const r = await createEvent(api, csrf, kind, when, extra);
  expect(r.ok(), `create ${kind} (${when}): ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

function put(api, csrf, id, data) {
  return api.put(`/api/admin/competitions/${id}`, { headers: H(csrf), data });
}

/**
 * Read the two columns straight out of SQLite. A refusal that still WROTE is a
 * different (and worse) bug than one that refuses, and only the stored row can
 * tell the two apart — the response body cannot.
 */
function storedPresence(id) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT measure_presence, time_basis FROM competitions WHERE id=?").get(id);
  } finally { db.close(); }
}

test.describe("v8.1.0 — the presence settings are gated on the PUT, not only on create", () => {

  // Mutation caught: dropping the `_polPut.measurePresence === "forbidden"`
  // check from the PUT. The create half is the CONTROL — without it, "the PUT
  // refuses" says nothing about whether the rule existed anywhere before.
  test("a Booth Event refuses `measure_presence` on EDIT as well as at CREATE", async () => {
    const { api, csrf } = await sa();

    // Control: the rule this PR is extending, asserted where it already held.
    const atCreate = await createEvent(api, csrf, "booth", "live", { measure_presence: true });
    expect(atCreate.status(), `create must refuse: ${await atCreate.text()}`).toBe(400);
    const cBody = await atCreate.json();
    expect(cBody.code).toBe("measure_presence_forbidden");
    // The refusal must name the kind in WORDS, never the stored value (v8.1.0 PR 13).
    expect(cBody.error).not.toMatch(/\bbooth\b/);

    // And now the door the create-side check never covered.
    const booth = await makeEvent(api, csrf, "booth", "live");
    expect(storedPresence(booth.id).measure_presence, "precondition: created OFF").toBeFalsy();

    const r = await put(api, csrf, booth.id, { measure_presence: true });
    expect(r.status(), `PUT must refuse: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("measure_presence_forbidden");
    expect(body.error).not.toMatch(/\bbooth\b/);
    // Refused, not refused-after-writing.
    expect(storedPresence(booth.id).measure_presence, "the column must not have moved").toBeFalsy();
  });

  // Mutation caught: dropping the time_basis policy check from the PUT (and
  // from create — a presence tie-break on a kind that cannot measure presence
  // would rank every score tie on a column that can only ever hold zeros).
  test("a Booth Event refuses a PRESENCE tie-break on EDIT as well as at CREATE", async () => {
    const { api, csrf } = await sa();

    const atCreate = await createEvent(api, csrf, "booth", "live", { time_basis: "presence" });
    expect(atCreate.status(), `create must refuse: ${await atCreate.text()}`).toBe(400);
    expect((await atCreate.json()).code).toBe("time_basis_forbidden");

    const booth = await makeEvent(api, csrf, "booth", "live");
    expect(storedPresence(booth.id).time_basis, "precondition: created elapsed").toBe("elapsed");

    const r = await put(api, csrf, booth.id, { time_basis: "presence" });
    expect(r.status(), `PUT must refuse: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("time_basis_forbidden");
    expect(body.error).not.toMatch(/\bbooth\b/);
    expect(storedPresence(booth.id).time_basis, "the column must not have moved").toBe("elapsed");
  });

  // THE POSITIVE CONTROL for every refusal above and below. Without it a build
  // that 400s the two fields unconditionally passes this whole file.
  test("a Competition still accepts BOTH fields while it is upcoming, and measure_presence while it is LIVE", async () => {
    const { api, csrf } = await sa();

    const upcoming = await makeEvent(api, csrf, "tournament", "upcoming");
    const a = await put(api, csrf, upcoming.id, { measure_presence: true, time_basis: "presence" });
    expect(a.status(), `upcoming must accept both: ${await a.text()}`).toBe(200);
    expect(storedPresence(upcoming.id)).toMatchObject({ measure_presence: 1, time_basis: "presence" });

    // measure_presence is deliberately editable while LIVE: it governs only
    // whether counting happens from here on, so an organiser deciding mid-event
    // to start measuring is making an honest choice about the future.
    const live = await makeEvent(api, csrf, "tournament", "live");
    const b = await put(api, csrf, live.id, { measure_presence: true });
    expect(b.status(), `live must accept measure_presence: ${await b.text()}`).toBe(200);
    expect(storedPresence(live.id).measure_presence).toBe(1);
  });

  // Mutation caught: dropping the `competitionAnySlotStarted` lock on
  // time_basis. The upcoming half is the local control — it is the same request
  // against the same kind, differing only in lifecycle.
  test("the tie-break basis LOCKS once the event has started", async () => {
    const { api, csrf } = await sa();

    const upcoming = await makeEvent(api, csrf, "tournament", "upcoming");
    const allowed = await put(api, csrf, upcoming.id, { time_basis: "presence" });
    expect(allowed.status(), `control — an upcoming event may still change it: ${await allowed.text()}`).toBe(200);
    expect(storedPresence(upcoming.id).time_basis).toBe("presence");

    const live = await makeEvent(api, csrf, "tournament", "live");
    const r = await put(api, csrf, live.id, { time_basis: "presence" });
    expect(r.status(), `a started event must refuse: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("time_basis_locked");
    // The refusal must name WHY, not merely say no — the ranking would change
    // under participants mid-event.
    expect(body.error).toMatch(/started/i);
    expect(storedPresence(live.id).time_basis, "the column must not have moved").toBe("elapsed");
  });

  // Mutation caught: dropping the fully-ended refusal for time_basis (first
  // half), and refusing an UNCHANGED echo (second half — which is what would
  // make every ended event unsaveable from the admin form).
  test("the tie-break basis is refused once the event has ENDED — but the basis it already has is still accepted", async () => {
    const { api, csrf } = await sa();
    const ended = await makeEvent(api, csrf, "tournament", "ended", { time_basis: "presence" });
    expect(storedPresence(ended.id).time_basis, "precondition: born with a presence basis").toBe("presence");

    const r = await put(api, csrf, ended.id, { time_basis: "elapsed" });
    expect(r.status(), `an ended event must refuse a basis CHANGE: ${await r.text()}`).toBe(400);
    const body = await r.json();
    // Ended is asked BEFORE started (ended implies started), so the admin reads
    // the reason that is actually true of their event.
    expect(body.code).toBe("time_basis_locked_ended");
    expect(body.error).toMatch(/ended/i);
    expect(storedPresence(ended.id).time_basis, "the column must not have moved").toBe("presence");

    const echo = await put(api, csrf, ended.id, { time_basis: "presence" });
    expect(echo.status(), `echoing the SAME basis back is not a change: ${await echo.text()}`).toBe(200);
    expect(storedPresence(ended.id).time_basis).toBe("presence");
  });

  // Mutation caught: dropping the fully-ended refusal for measure_presence, and
  // refusing an unchanged echo of it.
  test("measure_presence is refused once the event has ENDED — but the value it already has is still accepted", async () => {
    const { api, csrf } = await sa();
    const ended = await makeEvent(api, csrf, "tournament", "ended", { measure_presence: true });
    expect(storedPresence(ended.id).measure_presence, "precondition: born recording").toBe(1);

    const r = await put(api, csrf, ended.id, { measure_presence: false });
    expect(r.status(), `an ended event must refuse the change: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("measure_presence_locked_ended");
    expect(body.error).toMatch(/ended/i);
    expect(storedPresence(ended.id).measure_presence, "the column must not have moved").toBe(1);

    const echo = await put(api, csrf, ended.id, { measure_presence: true });
    expect(echo.status(), `echoing the SAME value back is not a change: ${await echo.text()}`).toBe(200);
    expect(storedPresence(ended.id).measure_presence).toBe(1);
  });

  // THE ROUND-TRIP RULE, driven the way the admin form actually drives it: both
  // controls are rendered for every kind and posted on EVERY save, populated
  // from the stored row. A gate that refused an unchanged value would make a
  // Booth Event — and every ended event — unsaveable, which is a far worse
  // regression than the hole being closed.
  //
  // Mutation caught: comparing against the SUBMITTED value instead of the
  // stored one (i.e. refusing on presence-of-field rather than on change).
  test("a Booth Event and an ENDED event both stay saveable when the form echoes the presence controls back", async () => {
    const { api, csrf } = await sa();

    const booth = await makeEvent(api, csrf, "booth", "live");
    const b = await put(api, csrf, booth.id, {
      // Exactly what _collectCompFormData posts for an untouched booth form.
      measure_presence: false, time_basis: "elapsed",
      // …alongside a real edit, so the save is not a no-op.
      reveal_answers_on_end: true,
    });
    expect(b.status(), `a Booth Event must stay saveable: ${await b.text()}`).toBe(200);
    expect(storedPresence(booth.id)).toMatchObject({ measure_presence: 0, time_basis: "elapsed" });

    const ended = await makeEvent(api, csrf, "tournament", "ended", { measure_presence: true, time_basis: "presence" });
    const e = await put(api, csrf, ended.id, {
      measure_presence: true, time_basis: "presence",
      reveal_answers_on_end: true,
    });
    expect(e.status(), `an ended event must stay saveable: ${await e.text()}`).toBe(200);
    expect(storedPresence(ended.id)).toMatchObject({ measure_presence: 1, time_basis: "presence" });
  });
});
