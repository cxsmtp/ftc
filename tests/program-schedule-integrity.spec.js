// v8.1.1 — the deadline-kind (Program) schedule path, and the three ways it lied.
//
// PR 16 made `deadline_at` the authority and `duration_minutes` a value derived
// from it. The pair only stays honest if EVERY writer derives from the start it
// is actually writing and re-derives only when something moved. The PUT did
// neither:
//
//   • it derived from the STORED start while writing a NEW one, so moving an
//     upcoming Program's date kept the old span — a Program moved a month later
//     ran a month past the deadline every surface still announced, accepting
//     submissions and issuing completion certificates the whole time;
//   • it re-derived from any PRESENT deadline, and the edit form round-trips the
//     stored deadline on every save — so ANY save of a Close-Now'd Program
//     overwrote the truncated elapsed duration with the full deadline span and
//     the revive block silently reopened a settled event;
//   • and `eventPolicy(comp)` was resolved ABOVE the 404 guard, so an unknown id
//     threw out of eventKind() and answered 500.
//
// Every test owns its Program. The load-bearing pair carries its own control,
// because "the save did not revive it" is equally satisfied by a build where a
// deadline move never revives anything either.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `psi${Date.now().toString(36)}`;
const ROOT = path.join(__dirname, "..");
const MIN = 60_000;
const DAY = 86_400_000;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

const dbGet = (sql, ...a) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};

// Create a Program and ASSERT it, so a fixture that stops producing one fails as
// a precondition rather than as a mysterious schedule assertion three lines down.
async function mkProgram(api, csrf, label, startMs, deadlineMs) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${TAG} ${label}`, event_kind: "program", timezone: "UTC",
      start_time: new Date(startMs).toISOString(), deadline_at: new Date(deadlineMs).toISOString(),
    },
  });
  expect(r.ok(), `create ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  const c = (await r.json()).competition;
  expect(c.duration_minutes, `${label} derives its duration from the deadline at create`)
    .toBe(Math.ceil((deadlineMs - startMs) / MIN));
  return c;
}

// The instant the row says it ends, which is the value every status calculation
// and the revive gate read.
const schedEndOf = (c) => new Date(c.start_time).getTime() + c.duration_minutes * MIN;

test.describe("v8.1.1 — a Program's deadline stays the authority", () => {
  test("moving an UPCOMING Program's start FORWARD re-derives the duration from the deadline", async () => {
    // Catches: resolveSchedule handed `new Date(comp.start_time)` instead of the
    // start this request is writing. With that mutation the duration stays at the
    // original 90-day span and the event runs 30 days past its own deadline.
    const { api, csrf } = await sa();
    try {
      const t0 = Date.now();
      const deadlineMs = t0 + 120 * DAY;
      const comp = await mkProgram(api, csrf, "MoveFwd", t0 + 30 * DAY, deadlineMs);
      expect(comp.status, "the fixture is UPCOMING, so its start is still editable").toBe("upcoming");

      const newStartMs = t0 + 60 * DAY;
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: {
          // Exactly what the shipped edit form sends for a deadline kind: the new
          // start AND the stored deadline round-tripped, and no duration at all.
          start_time: new Date(newStartMs).toISOString(),
          deadline_at: comp.deadline_at,
          expectedUpdatedAt: comp.updated_at,
        },
      });
      expect(put.ok(), `move start: ${put.status()} ${await put.text()}`).toBeTruthy();
      const after = (await put.json()).competition;

      expect(new Date(after.start_time).getTime(), "the new start was written").toBe(newStartMs);
      expect(new Date(after.deadline_at).getTime(), "the deadline did not move").toBe(deadlineMs);
      expect(after.duration_minutes, "the duration is the span from the NEW start")
        .toBe(Math.ceil((deadlineMs - newStartMs) / MIN));
      // The property that matters to a participant: the event stops AT the
      // deadline, not 30 days after it.
      expect(schedEndOf(after), "start + duration lands on the deadline").toBe(deadlineMs);
      expect(new Date(after.effective_end).getTime(), "and the surface an admin reads agrees").toBe(deadlineMs);
    } finally { await api.dispose(); }
  });

  test("moving it BACKWARD re-derives too — the mirror image", async () => {
    // Catches the same mutation from the other side, plus any "only ever grow the
    // duration" clamp: moving the start earlier must LENGTHEN the span, or the
    // Program refuses submissions weeks before the deadline it advertises.
    const { api, csrf } = await sa();
    try {
      const t0 = Date.now();
      const deadlineMs = t0 + 120 * DAY;
      const comp = await mkProgram(api, csrf, "MoveBack", t0 + 30 * DAY, deadlineMs);

      const newStartMs = t0 + 10 * DAY;
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: { start_time: new Date(newStartMs).toISOString(), deadline_at: comp.deadline_at, expectedUpdatedAt: comp.updated_at },
      });
      expect(put.ok(), `move start back: ${put.status()} ${await put.text()}`).toBeTruthy();
      const after = (await put.json()).competition;

      expect(after.duration_minutes, "the span GREW to cover the earlier start")
        .toBe(Math.ceil((deadlineMs - newStartMs) / MIN));
      expect(after.duration_minutes, "which is strictly more than it was").toBeGreaterThan(comp.duration_minutes);
      expect(schedEndOf(after), "and it still lands on the deadline").toBe(deadlineMs);
    } finally { await api.dispose(); }
  });

  test("a start-only edit re-derives from the STORED deadline", async () => {
    // The same desync through a different door. Catches: dropping the
    // `else if (_startMoved)` branch, which leaves the duration alone and moves
    // the effective end by exactly the amount the start moved.
    const { api, csrf } = await sa();
    try {
      const t0 = Date.now();
      const deadlineMs = t0 + 120 * DAY;
      const comp = await mkProgram(api, csrf, "StartOnly", t0 + 30 * DAY, deadlineMs);

      const newStartMs = t0 + 45 * DAY;
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        // NO deadline_at in the body — a scripted caller changing only the date.
        data: { start_time: new Date(newStartMs).toISOString(), expectedUpdatedAt: comp.updated_at },
      });
      expect(put.ok(), `start-only edit: ${put.status()} ${await put.text()}`).toBeTruthy();
      const after = (await put.json()).competition;

      expect(new Date(after.deadline_at).getTime(), "the stored deadline is untouched").toBe(deadlineMs);
      expect(after.duration_minutes, "and the duration was re-derived against it")
        .toBe(Math.ceil((deadlineMs - newStartMs) / MIN));
      expect(schedEndOf(after), "so the pair still agrees").toBe(deadlineMs);
    } finally { await api.dispose(); }
  });

  test("a deadline at or before the NEW start is refused — through both doors", async () => {
    // Catches: validating deadline-after-start against the stale stored start,
    // which accepted a Program whose deadline precedes its own start and left the
    // row holding a negative span.
    const { api, csrf } = await sa();
    try {
      const t0 = Date.now();
      const deadlineMs = t0 + 40 * DAY;
      const comp = await mkProgram(api, csrf, "PastDeadline", t0 + 30 * DAY, deadlineMs);
      const badStart = new Date(t0 + 50 * DAY).toISOString();   // ten days AFTER the deadline

      const echoed = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { start_time: badStart, deadline_at: comp.deadline_at, expectedUpdatedAt: comp.updated_at },
      });
      expect(echoed.status(), "the form's shape (start + echoed deadline)").toBe(400);
      expect((await echoed.json()).code).toBe("deadline_before_start");

      // A refused PUT writes nothing, so the row is still available for the
      // second door — and that is worth asserting rather than assuming.
      const startOnly = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { start_time: badStart, expectedUpdatedAt: comp.updated_at },
      });
      expect(startOnly.status(), "and a start-only edit (no deadline in the body)").toBe(400);
      expect((await startOnly.json()).code).toBe("deadline_before_start");

      const row = dbGet("SELECT start_time, duration_minutes FROM competitions WHERE id=?", comp.id);
      expect(new Date(row.start_time).getTime(), "neither refusal wrote a start").toBe(t0 + 30 * DAY);
      expect(row.duration_minutes, "nor a duration").toBe(comp.duration_minutes);
    } finally { await api.dispose(); }
  });

  test("an UNCHANGED deadline does not reopen a closed Program — with a moved-deadline control", async () => {
    // THE LOAD-BEARING ONE. Catches: re-deriving the duration from any PRESENT
    // deadline. With that mutation the unchanged save overwrites Close Now's
    // truncated duration with the full 90-day span, the revive block sees a
    // future scheduled end, skips the all-solved gate because ended_manually=1,
    // and reopens a settled event.
    //
    // The control is not optional: without it, "A stayed ended" is equally
    // satisfied by a build in which a deadline move never revives either — which
    // would be a worse bug, since moving the deadline IS this kind's "extend the
    // duration" and v7.7.x's rule is that a manual end plus a deliberate extend
    // always revives.
    test.setTimeout(120_000);
    const { api, csrf } = await sa();
    try {
      const t0 = Date.now();
      // BACKDATED so end-now's `Math.ceil(elapsed/60000)` lands only a few seconds
      // past the moment of closure. That rounding is pre-existing and applies to
      // every kind: it can leave the stored scheduled end up to 60 s in the FUTURE,
      // and the revive gate is a plain `newScheduledEnd > now()`, so ANY save
      // inside that window legitimately reopens a just-closed event. It is not
      // what this test is about, so the fixture waits it out below rather than
      // asserting across it.
      const startMs = t0 - (3600_000 - 5_000);
      const deadlineMs = t0 + 90 * DAY;
      const a = await mkProgram(api, csrf, "ClosedUnchanged", startMs, deadlineMs);
      const b = await mkProgram(api, csrf, "ClosedMoved", startMs, deadlineMs);

      const closeNow = async (c) => {
        const r = await api.post(`/api/admin/competitions/${c.id}/end-now`, { headers: H(csrf) });
        expect(r.ok(), `close ${c.name}: ${r.status()} ${await r.text()}`).toBeTruthy();
        const closed = (await r.json()).competition;
        expect(closed.ended_at, "Close Now stamped ended_at").toBeTruthy();
        expect(closed.ended_manually, "…as a manual end").toBeTruthy();
        expect(closed.duration_minutes, "…and truncated the duration to the elapsed time")
          .toBeLessThan(c.duration_minutes / 100);
        return closed;
      };
      const closedA = await closeNow(a);
      const closedB = await closeNow(b);

      // Bounded by 60 s by construction (see the backdate note above); typically
      // ~5 s. One wait covers both, so the pair is measured on the same clock.
      const waitUntil = Math.max(schedEndOf(closedA), schedEndOf(closedB)) + 500;
      if (waitUntil > Date.now()) await new Promise(r => setTimeout(r, waitUntil - Date.now()));

      // A — the unchanged save. `cxone_disabled` is a real unrelated change an
      // admin makes on a finished event; it is deliberately NOT
      // reveal_answers_on_end, which a Program refuses outright (PR 18).
      const putA = await api.put(`/api/admin/competitions/${a.id}`, {
        headers: H(csrf),
        data: { deadline_at: closedA.deadline_at, cxone_disabled: true, expectedUpdatedAt: closedA.updated_at },
      });
      expect(putA.ok(), `unchanged save: ${putA.status()} ${await putA.text()}`).toBeTruthy();
      const afterA = (await putA.json()).competition;

      expect(afterA.duration_minutes, "the Close Now duration SURVIVED the save").toBe(closedA.duration_minutes);
      expect(afterA.status, "so the event is still ended").toBe("ended");
      const rowA = dbGet("SELECT ended_at, ended_manually, cxone_disabled FROM competitions WHERE id=?", a.id);
      expect(rowA.ended_at, "ended_at was not cleared").toBeTruthy();
      expect(rowA.ended_manually, "and it is still recorded as a manual end").toBeTruthy();
      // The save must still DO ITS JOB — a "fix" that refused the whole request,
      // or ignored the rest of the body, would pass every assertion above.
      expect(rowA.cxone_disabled, "and the field the admin actually came to change was applied").toBeTruthy();

      // B — the control. Moving the deadline forward is this kind's extend, so it
      // must revive.
      const movedMs = deadlineMs + DAY;
      const putB = await api.put(`/api/admin/competitions/${b.id}`, {
        headers: H(csrf),
        data: { deadline_at: new Date(movedMs).toISOString(), expectedUpdatedAt: closedB.updated_at },
      });
      expect(putB.ok(), `moved save: ${putB.status()} ${await putB.text()}`).toBeTruthy();
      const afterB = (await putB.json()).competition;

      expect(afterB.duration_minutes, "the duration was re-derived from the NEW deadline")
        .toBe(Math.ceil((movedMs - new Date(afterB.start_time).getTime()) / MIN));
      expect(afterB.status, "and the deliberate extend revived it").toBe("live");
      expect(dbGet("SELECT ended_at FROM competitions WHERE id=?", b.id).ended_at,
        "ended_at was cleared by the revive").toBeNull();
    } finally { await api.dispose(); }
  });

  test("a PUT for an unknown competition id answers 404, not 500", async () => {
    // Catches: resolving eventPolicy(comp) above the `if (!comp)` guard.
    // getCompetition returns null for an unknown id and eventKind THROWS on null,
    // so a mistyped id — or a form saved after a colleague deleted the row — got
    // a generic 500 and an error-level stack instead of the actionable refusal.
    const { api, csrf } = await sa();
    try {
      const r = await api.put(`/api/admin/competitions/${TAG}-no-such-competition`, {
        headers: H(csrf), data: { name: `${TAG} Ghost` },
      });
      expect(r.status(), `unknown id: ${await r.text()}`).toBe(404);
      expect((await r.json()).error).toMatch(/not found/i);
    } finally { await api.dispose(); }
  });

  test("the client's revival warning covers a deadline kind", async () => {
    // A SOURCE pin, and its limits are worth stating: it proves the arm exists and
    // is gated on the deadline having MOVED, not that the copy is right. Driving
    // it needs the admin pane, an ENDED Program found in a paginated table, and a
    // confirm-dialog string — disproportionate for a warning whose behavioural
    // half (the server no longer reviving) is locked above. What it does catch is
    // the realistic regression: someone tidying away a branch that reads as dead
    // because a deadline kind has no duration control.
    const src = fs.readFileSync(path.join(ROOT, "public/js/features/competitions-admin.js"), "utf8");
    expect(src, "the revival warning has a deadline arm")
      .toMatch(/if\s*\(\s*fd\.deadline_at\s*&&\s*computeCompStatus\(comp\)\s*===\s*'ended'\s*\)/);
    // Gated on a MOVE, because the server re-derives only on a move: a
    // confirmation that fires on every save is one an admin learns to click
    // through, which is how the real one gets missed.
    expect(src, "and it only warns when the deadline actually moved")
      .toMatch(/const\s+moved\s*=\s*!comp\.deadline_at\s*\|\|\s*new Date\(comp\.deadline_at\)\.getTime\(\)\s*!==/);
  });
});
