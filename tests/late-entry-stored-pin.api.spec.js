// @ts-check
//
// A STORED LATE-ENTRY PIN IS JUDGED WHEN A SAVE MOVES WHAT IT IS MEASURED AGAINST.
//
// A PUT that moved the schedule without sending `late_entry_deadline_at` skipped
// the deadline check altogether, so the pin the row already held could end up
// before the new end (a window that can never open) or past the 30-day cap. The
// same hole had a sibling: switching late entries back on without sending the
// deadline woke a pin an earlier save had moved the end past. Both are refused
// `late_entry_deadline_stale`, never clamped or cleared, naming the stored pin
// and the ways out in the app and through the API. A re-tick is judged against the
// 30-day cap too, with or without the form's echo of the pin: the end that moved
// under the dormant pin was the admin's own earlier save, not End Now.
//
// Every refusal arm reads the row back (pin, schedule and `updated_at`), and every
// one has a control that differs from it only in what decides the rule.
const { test, expect } = require("./isolated-test");
const { H, uniq, MIN, sa, rawGetComp, liveBooth } = require("./late-entry-fixture");

const DAY = 24 * 60 * MIN;
const schedEndMs = row => new Date(row.start_time).getTime() + row.duration_minutes * MIN;
const putComp = (api, csrf, id, data) => api.put(`/api/admin/competitions/${id}`, { headers: H(csrf), data });

/** An UPCOMING booth, `duration` minutes long, its deadline pinned `pinAfterEndMs` after its end. */
async function pinnedBooth(api, csrf, { duration = 120, pinAfterEndMs = 60 * MIN } = {}) {
  const start = new Date(Math.floor(Date.now() / MIN) * MIN + 60 * MIN);
  const pin = new Date(start.getTime() + duration * MIN + pinAfterEndMs);
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `LEpin ${uniq()}`, event_kind: "booth", start_time: start.toISOString(), duration_minutes: duration,
      late_entry_deadline_at: pin.toISOString(), self_enroll_enabled: true },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const row = rawGetComp(comp.id);
  expect(comp.status, "PRECONDITION: upcoming").toBe("upcoming");
  expect(row.late_entry_enabled, "PRECONDITION: late entries on").toBe(1);
  expect(new Date(row.late_entry_deadline_at).getTime(), "PRECONDITION: pinned where asked").toBe(pin.getTime());
  return { comp, row };
}

/** The row is exactly as it was: pin, schedule, switch and version. */
function expectUnchanged(id, before, label) {
  const after = rawGetComp(id);
  expect(after.late_entry_deadline_at, `${label}: the pin is untouched`).toBe(before.late_entry_deadline_at);
  expect(after.duration_minutes, `${label}: the schedule is untouched`).toBe(before.duration_minutes);
  expect(after.start_time, `${label}: the start is untouched`).toBe(before.start_time);
  expect(after.late_entry_enabled, `${label}: the switch is untouched`).toBe(before.late_entry_enabled);
  expect(after.updated_at, `${label}: the row was not written`).toBe(before.updated_at);
}

test.describe("a stored late-entry pin and a save that does not send one", () => {
  test("moving the end past the pin is REFUSED by name; a new pin, Automatic, or no move pass", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, row } = await pinnedBooth(api, csrf);
      const longer = row.duration_minutes + 180;
      expect(new Date(row.start_time).getTime() + longer * MIN, "PRECONDITION: the new end lies past the pin")
        .toBeGreaterThan(new Date(row.late_entry_deadline_at).getTime());

      // The dry run meets it, so the form's pre-flight reports it.
      const dry = await putComp(api, csrf, comp.id, { duration_minutes: longer, validate_only: true, expectedUpdatedAt: row.updated_at });
      expect(dry.status(), `validate_only: ${await dry.text()}`).toBe(400);
      expect((await dry.json()).code).toBe("late_entry_deadline_stale");
      expectUnchanged(comp.id, row, "after the dry run");

      const bad = await putComp(api, csrf, comp.id, { duration_minutes: longer, expectedUpdatedAt: row.updated_at });
      expect(bad.status(), `extend past the pin: ${await bad.text()}`).toBe(400);
      const body = await bad.json();
      expect(body.code).toBe("late_entry_deadline_stale");
      expect(body.error, "it names the stored deadline").toContain("pinned to");
      expect(body.error, "and says it must be after the end").toMatch(/must be after the event ends/);
      expect(body.error, "the way out through the API").toMatch(/send a new late-entry deadline with this change, or an empty one/);
      expect(body.error, "and the way out in the app, where the form sends no deadline on its own")
        .toMatch(/In the event's settings \(Edit settings\), set a later late-entry deadline or tick Automatic/);
      expectUnchanged(comp.id, row, "after the refusal");

      // CONTROL: a move that leaves the pin after the end passes and keeps it.
      const shortMove = await putComp(api, csrf, comp.id, { duration_minutes: row.duration_minutes + 30, expectedUpdatedAt: row.updated_at });
      expect(shortMove.status(), `a move the pin survives: ${await shortMove.text()}`).toBe(200);
      const r1 = rawGetComp(comp.id);
      expect(r1.late_entry_deadline_at, "CONTROL: the pin is kept").toBe(row.late_entry_deadline_at);

      // CONTROL: a save that moves nothing leaves the stored pin alone.
      const noMove = await putComp(api, csrf, comp.id, { attempt_cap: 4, expectedUpdatedAt: r1.updated_at });
      expect(noMove.status(), `an unrelated save: ${await noMove.text()}`).toBe(200);
      const r2 = rawGetComp(comp.id);
      expect(r2.attempt_cap).toBe(4);

      // CONTROL: the same refused move WITH a new valid pin passes.
      const newPin = new Date(new Date(r2.start_time).getTime() + (longer + 60) * MIN).toISOString();
      const withPin = await putComp(api, csrf, comp.id, { duration_minutes: longer, late_entry_deadline_at: newPin, expectedUpdatedAt: r2.updated_at });
      expect(withPin.status(), `move with a new pin: ${await withPin.text()}`).toBe(200);
      const r3 = rawGetComp(comp.id);
      expect(r3.duration_minutes).toBe(longer);
      expect(new Date(r3.late_entry_deadline_at).getTime()).toBe(new Date(newPin).getTime());
    } finally { await api.dispose(); }
  });

  test("the same move with an empty deadline (Automatic) passes and clears the pin", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, row } = await pinnedBooth(api, csrf);
      const longer = row.duration_minutes + 180;
      const r = await putComp(api, csrf, comp.id, { duration_minutes: longer, late_entry_deadline_at: "", expectedUpdatedAt: row.updated_at });
      expect(r.status(), `move with Automatic: ${await r.text()}`).toBe(200);
      const after = rawGetComp(comp.id);
      expect(after.duration_minutes).toBe(longer);
      expect(after.late_entry_deadline_at, "back to following the end").toBeNull();
    } finally { await api.dispose(); }
  });

  test("a move that puts the pin past the 30-day cap is refused; a move that keeps it inside the cap passes", async () => {
    const { api, csrf } = await sa();
    try {
      // Pinned one minute inside the cap; shortening the event by an hour pushes it out.
      const { comp, row } = await pinnedBooth(api, csrf, { pinAfterEndMs: 30 * DAY - MIN });
      const bad = await putComp(api, csrf, comp.id, { duration_minutes: row.duration_minutes - 60, expectedUpdatedAt: row.updated_at });
      expect(bad.status(), `shorten: ${await bad.text()}`).toBe(400);
      const body = await bad.json();
      expect(body.code).toBe("late_entry_deadline_stale");
      expect(body.error, "the cap is the reason").toMatch(/at most 30 days after the event ends/);
      expectUnchanged(comp.id, row, "after the cap refusal");

      // CONTROL: a move (so the stored pin is judged) that keeps it inside the cap.
      const ok = await putComp(api, csrf, comp.id, { duration_minutes: row.duration_minutes + 60, expectedUpdatedAt: row.updated_at });
      expect(ok.status(), `CONTROL, lengthen: ${await ok.text()}`).toBe(200);
      expect(rawGetComp(comp.id).late_entry_deadline_at, "CONTROL: the pin is kept").toBe(row.late_entry_deadline_at);
    } finally { await api.dispose(); }
  });

  // An earlier save unticks late entries and shortens the event, leaving the
  // dormant pin 31 days after the end (allowed: the pin sleeps while they are
  // off). Switching them back on wakes a window longer than the cap allows.
  test("switching late entries back ON judges the pin against the 30-day cap too, sent or not", async () => {
    const { api, csrf } = await sa();
    try {
      const dormantOverCap = async () => {
        const { comp, row } = await pinnedBooth(api, csrf, { duration: 3 * 24 * 60, pinAfterEndMs: 29 * DAY });
        const off = await putComp(api, csrf, comp.id, { late_entry_enabled: false, duration_minutes: row.duration_minutes - 2 * 24 * 60, expectedUpdatedAt: row.updated_at });
        expect(off.status(), `untick + shorten: ${await off.text()}`).toBe(200);
        const r1 = rawGetComp(comp.id);
        expect(r1.late_entry_enabled, "PRECONDITION: late entries off").toBe(0);
        expect(r1.late_entry_deadline_at, "PRECONDITION: the pin is kept while dormant").toBe(row.late_entry_deadline_at);
        expect(new Date(r1.late_entry_deadline_at).getTime() - schedEndMs(r1), "PRECONDITION: the pin lies 31 days after the end")
          .toBe(31 * DAY);
        return { comp, r1 };
      };

      const a = await dormantOverCap();
      // No deadline sent (an API client): the stored pin is judged.
      const bare = await putComp(api, csrf, a.comp.id, { late_entry_enabled: true, expectedUpdatedAt: a.r1.updated_at });
      expect(bare.status(), `re-tick without a deadline: ${await bare.text()}`).toBe(400);
      const bareBody = await bare.json();
      expect(bareBody.code).toBe("late_entry_deadline_stale");
      expect(bareBody.error, "the cap is the reason").toMatch(/at most 30 days after the event ends/);
      expectUnchanged(a.comp.id, a.r1, "after the bare re-tick refusal");

      // The form's way: it echoes the stored pin. A re-tick is no echo.
      const echo = await putComp(api, csrf, a.comp.id, { late_entry_enabled: true, late_entry_deadline_at: a.r1.late_entry_deadline_at, expectedUpdatedAt: a.r1.updated_at });
      expect(echo.status(), `re-tick echoing the pin: ${await echo.text()}`).toBe(400);
      const echoBody = await echo.json();
      expect(echoBody.code).toBe("late_entry_deadline_invalid");
      expect(echoBody.error, "the cap is the reason").toMatch(/at most 30 days after the event ends/);
      expectUnchanged(a.comp.id, a.r1, "after the echoed re-tick refusal");

      // CONTROL: the same re-tick with Automatic passes and clears the pin.
      const auto = await putComp(api, csrf, a.comp.id, { late_entry_enabled: true, late_entry_deadline_at: "", expectedUpdatedAt: a.r1.updated_at });
      expect(auto.status(), `re-tick with Automatic: ${await auto.text()}`).toBe(200);
      const a2 = rawGetComp(a.comp.id);
      expect(a2.late_entry_enabled).toBe(1);
      expect(a2.late_entry_deadline_at, "CONTROL: back to following the end").toBeNull();

      // CONTROL: a dormant pin still inside the cap wakes, sent or not.
      const inside = async () => {
        const { comp, row } = await pinnedBooth(api, csrf, { duration: 3 * 24 * 60, pinAfterEndMs: 29 * DAY });
        const off = await putComp(api, csrf, comp.id, { late_entry_enabled: false, duration_minutes: row.duration_minutes - (24 * 60 - 1), expectedUpdatedAt: row.updated_at });
        expect(off.status(), `untick + shorten a little: ${await off.text()}`).toBe(200);
        const r1 = rawGetComp(comp.id);
        expect(new Date(r1.late_entry_deadline_at).getTime() - schedEndMs(r1), "PRECONDITION: one minute inside the cap")
          .toBe(30 * DAY - MIN);
        return { comp, r1 };
      };
      const b = await inside();
      const bOn = await putComp(api, csrf, b.comp.id, { late_entry_enabled: true, expectedUpdatedAt: b.r1.updated_at });
      expect(bOn.status(), `CONTROL re-tick inside the cap: ${await bOn.text()}`).toBe(200);
      expect(rawGetComp(b.comp.id).late_entry_deadline_at, "CONTROL: the pin is kept").toBe(b.r1.late_entry_deadline_at);
      const c = await inside();
      const cOn = await putComp(api, csrf, c.comp.id, { late_entry_enabled: true, late_entry_deadline_at: c.r1.late_entry_deadline_at, expectedUpdatedAt: c.r1.updated_at });
      expect(cOn.status(), `CONTROL echoed re-tick inside the cap: ${await cOn.text()}`).toBe(200);
      expect(rawGetComp(c.comp.id).late_entry_deadline_at, "CONTROL: the pin is kept").toBe(c.r1.late_entry_deadline_at);
    } finally { await api.dispose(); }
  });

  test("switching late entries back ON without a deadline wakes a pin the end has passed: refused", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, row } = await pinnedBooth(api, csrf);
      // Save 1: late entries off while the end moves past the pin. Dormant, so allowed.
      const off = await putComp(api, csrf, comp.id, { late_entry_enabled: false, duration_minutes: row.duration_minutes + 300, expectedUpdatedAt: row.updated_at });
      expect(off.status(), `untick + extend: ${await off.text()}`).toBe(200);
      const r1 = rawGetComp(comp.id);
      expect(r1.late_entry_enabled, "PRECONDITION: late entries off").toBe(0);
      expect(schedEndMs(r1), "PRECONDITION: the end lies past the pin").toBeGreaterThan(new Date(r1.late_entry_deadline_at).getTime());

      const on = await putComp(api, csrf, comp.id, { late_entry_enabled: true, expectedUpdatedAt: r1.updated_at });
      expect(on.status(), `re-tick without a deadline: ${await on.text()}`).toBe(400);
      expect((await on.json()).code).toBe("late_entry_deadline_stale");
      expectUnchanged(comp.id, r1, "after the re-tick refusal");

      // CONTROL: the same re-tick with Automatic passes.
      const auto = await putComp(api, csrf, comp.id, { late_entry_enabled: true, late_entry_deadline_at: "", expectedUpdatedAt: r1.updated_at });
      expect(auto.status(), `re-tick with Automatic: ${await auto.text()}`).toBe(200);
      expect(rawGetComp(comp.id).late_entry_enabled).toBe(1);

      // CONTROL: a re-tick whose pin is still after the end passes.
      const c = await pinnedBooth(api, csrf);
      const c1put = await putComp(api, csrf, c.comp.id, { late_entry_enabled: false, duration_minutes: c.row.duration_minutes + 30, expectedUpdatedAt: c.row.updated_at });
      expect(c1put.status()).toBe(200);
      const c1 = rawGetComp(c.comp.id);
      const cOn = await putComp(api, csrf, c.comp.id, { late_entry_enabled: true, expectedUpdatedAt: c1.updated_at });
      expect(cOn.status(), `CONTROL re-tick: ${await cOn.text()}`).toBe(200);
      expect(rawGetComp(c.comp.id).late_entry_deadline_at, "CONTROL: the pin is kept").toBe(c1.late_entry_deadline_at);
    } finally { await api.dispose(); }
  });

  test("reviving an ended event past the pin Close late entries now left is refused without a deadline", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf, {
        create: { start_time: new Date(Date.now() - 61_000).toISOString(), duration_minutes: 600 },
      });
      const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
      expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
      const close = await api.post(`/api/admin/competitions/${comp.id}/late-entry/close`, { headers: H(csrf) });
      expect(close.ok(), `close: ${await close.text()}`).toBeTruthy();
      const r1 = rawGetComp(comp.id);
      expect(r1.late_entry_deadline_at, "PRECONDITION: Close pinned the deadline").toBeTruthy();
      const longer = r1.duration_minutes + 120;
      expect(new Date(r1.start_time).getTime() + longer * MIN, "PRECONDITION: the extension revives the event")
        .toBeGreaterThan(Date.now() + 60 * MIN);

      const bad = await putComp(api, csrf, comp.id, { duration_minutes: longer, expectedUpdatedAt: r1.updated_at });
      expect(bad.status(), `revive without a deadline: ${await bad.text()}`).toBe(400);
      expect((await bad.json()).code).toBe("late_entry_deadline_stale");
      const r2 = rawGetComp(comp.id);
      expect(r2.ended_at, "still ended").toBe(r1.ended_at);
      expectUnchanged(comp.id, r1, "after the revive refusal");

      // CONTROL: the same revive with Automatic passes and reopens the event.
      const ok = await putComp(api, csrf, comp.id, { duration_minutes: longer, late_entry_deadline_at: "", expectedUpdatedAt: r1.updated_at });
      expect(ok.status(), `revive with Automatic: ${await ok.text()}`).toBe(200);
      expect(rawGetComp(comp.id).ended_at, "revived").toBeNull();
    } finally { await api.dispose(); }
  });
});
