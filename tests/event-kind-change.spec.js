// v8.3.0 — the event type is changeable, but only before the event starts.
//
// v7.29.0 made `event_kind` immutable and was precise about the price: "every
// guard would have to hold in both directions at once — a change away from a
// session-bearing kind must refuse while slots exist, a change toward a ranked
// kind must reckon with a board that was never computed, and a change to
// `program` must invent a deadline."
//
// The operator asked for it BEFORE the event goes live, and that one word
// answers two of the three: an upcoming event has no submissions, no computed
// board, no presence buckets and no minted certificates. The third — the
// deadline — is supplied by the caller and validated by the same
// `resolveSchedule` create uses.
//
// What must NOT change is the theorem: a sessionless kind has zero sessions,
// enforced from BOTH ends. That is asserted here directly, because it is the
// single largest thing the redesign bought and the easiest to lose.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ekc${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// UPCOMING by default — the whole feature's precondition.
async function makeEvent(api, csrf, kind, extra = {}, startOffsetMs = 3600e3) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() + startOffsetMs).toISOString(),
      ...(kind === "program"
        ? { deadline_at: new Date(Date.now() + 30 * 864e5).toISOString() }
        : { duration_minutes: 180 }),
      ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

const rowOf = async (api, id) =>
  (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);

const changeKind = async (api, csrf, comp, kind, extra = {}) =>
  api.put(`/api/admin/competitions/${comp.id}`, {
    headers: H(csrf),
    data: { event_kind: kind, expectedUpdatedAt: comp.updated_at, ...extra },
  });

async function editedChanges(api, id) {
  const ev = await (await api.get(`/api/admin/competitions/${id}/events`)).json();
  const list = ev.events || ev;
  const edited = list.filter(e => e.event_type === "edited").pop();
  return (edited && edited.details && edited.details.changes) || {};
}

test.describe("v8.3.0 — changing an event's type before it starts", () => {
  test("an upcoming, session-free event is re-typed, and the change is audited", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament");
    expect(comp.event_kind_locked, "a fresh upcoming event is changeable").toBeNull();

    const r = await changeKind(api, csrf, comp, "booth");
    expect(r.status(), `re-type: ${await r.text()}`).toBe(200);
    expect((await r.json()).competition.event_kind).toBe("booth");
    expect((await rowOf(api, comp.id)).event_kind, "and it is durable").toBe("booth");

    const ch = await editedChanges(api, comp.id);
    expect(ch.event_kind, "the record says what it became").toEqual({ from: "tournament", to: "booth" });
    await api.dispose();
  });

  test("a STARTED event refuses, and an ENDED one too — with the reason on the wire", async () => {
    // THE CONTROL FOR THE WHOLE FEATURE. Without it "an upcoming event can be
    // re-typed" is equally satisfied by a build that dropped the gate entirely.
    const { api, csrf } = await sa();
    const live = await makeEvent(api, csrf, "tournament", {}, -3600e3);   // started an hour ago
    expect((await rowOf(api, live.id)).event_kind_locked, "the wire says why").toBe("started");

    const r = await changeKind(api, csrf, live, "booth");
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("event_kind_locked_started");
    expect((await rowOf(api, live.id)).event_kind, "and nothing moved").toBe("tournament");

    const end = await api.post(`/api/admin/competitions/${live.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const ended = await rowOf(api, live.id);
    expect(ended.event_kind_locked, "an ended event is locked too").toBe("started");
    const r2 = await changeKind(api, csrf, ended, "booth");
    expect(r2.status()).toBe(400);
    await api.dispose();
  });

  test("THE THEOREM HOLDS: sessions block the change, and a sessionless kind still refuses a session", async () => {
    // v7.29.0 enforced "a sessionless kind has zero sessions" from BOTH ends —
    // the timeslot route, and the kind being immutable. Only the second end's
    // wording changed (never → not while there are sessions). Losing either
    // would let an admin reach the forbidden state by REORDERING, and eleven
    // single-slot code paths lose the invariant they are built on.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament");
    const ts = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: H(csrf),
      data: { name: "S1", start_time: new Date(Date.now() + 7200e3).toISOString(), duration_minutes: 60, timezone: "UTC" },
    });
    expect(ts.ok(), `add session: ${await ts.text()}`).toBeTruthy();

    const withSlots = await rowOf(api, comp.id);
    expect(withSlots.event_kind_locked, "the wire says WHY the control is withheld").toBe("has_sessions");
    const r = await changeKind(api, csrf, withSlots, "booth");
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("event_kind_locked_sessions");
    expect(body.error, "and it names the remedy").toMatch(/delete/i);

    // The other end, unchanged: re-type a session-free event, then try to add one.
    const booth = await makeEvent(api, csrf, "tournament");
    expect((await changeKind(api, csrf, booth, "booth")).ok()).toBeTruthy();
    const ts2 = await api.post(`/api/admin/competitions/${booth.id}/timeslots`, {
      headers: H(csrf),
      data: { name: "S1", start_time: new Date(Date.now() + 7200e3).toISOString(), duration_minutes: 60, timezone: "UTC" },
    });
    expect(ts2.status(), "a session still cannot be added to a sessionless kind").toBe(400);
    expect((await ts2.json()).code).toBe("sessions_forbidden");
    await api.dispose();
  });

  test("settings the new kind FORBIDS are reset and recorded; ones it merely defaults are left alone", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament", {
      reveal_answers_on_end: true, group_leaderboard_enabled: true,
      measure_presence: true, time_basis: "presence",
      trusted_network_ips: "203.0.113.7", cxone_disabled: true,
      self_enroll_enabled: true,
    });
    expect(comp.auto_end_on_all_solved, "a Competition auto-ends on all-solved").toBe(1);

    const r = await changeKind(api, csrf, comp, "program", {
      deadline_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    expect(r.status(), `to program: ${await r.text()}`).toBe(200);

    const row = await rowOf(api, comp.id);
    expect(row.reveal_answers_on_end, "a Program cannot reveal answers").toBe(0);
    expect(row.group_leaderboard_enabled, "…or rank teams").toBe(0);
    expect(row.trusted_network_ips ?? null, "…or hold a rate-limit bypass").toBeNull();
    expect(row.auto_end_on_all_solved, "…and must not close on its first finisher").toBe(0);

    // THE CONTROL. Without it "the resets happened" is equally satisfied by a
    // build that resets every flag on every kind change, which would silently
    // undo choices no policy forbids.
    expect(row.cxone_disabled, "a stored choice no policy forbids is UNTOUCHED").toBe(1);
    expect(row.self_enroll_enabled, "…and so is this one").toBe(1);

    const ch = await editedChanges(api, comp.id);
    for (const k of ["reveal_answers_on_end", "group_leaderboard_enabled", "auto_end_on_all_solved"]) {
      expect(ch[k], `${k} is on the record`).toBeTruthy();
      expect(ch[k].to, `${k} was turned off`).toBe(false);
    }
    expect(ch.cxone_disabled, "and an untouched setting is not").toBeUndefined();
    await api.dispose();
  });

  test("the SCHEDULE is converted, not inherited — in both directions", async () => {
    const { api, csrf } = await sa();

    // window → deadline needs a deadline, and says so by name.
    const a = await makeEvent(api, csrf, "tournament");
    const noDeadline = await changeKind(api, csrf, a, "program");
    expect(noDeadline.status()).toBe(400);
    expect((await noDeadline.json()).code).toBe("deadline_required");
    const withDeadline = await changeKind(api, csrf, a, "program", {
      deadline_at: new Date(Date.now() + 10 * 864e5).toISOString(),
    });
    expect(withDeadline.ok(), `with one: ${await withDeadline.text()}`).toBeTruthy();
    const prog = await rowOf(api, a.id);
    expect(prog.deadline_at, "the deadline is stored").toBeTruthy();
    expect(prog.duration_minutes, "and the duration is DERIVED from it, not the old 180").not.toBe(180);

    // deadline → window needs a duration, and DROPS the deadline. A Program's
    // stored duration is derived from a deadline that is about to stop existing,
    // so inheriting it would hand the admin a window nobody chose.
    const b = await makeEvent(api, csrf, "program");
    const noDur = await changeKind(api, csrf, b, "booth");
    expect(noDur.status()).toBe(400);
    expect((await noDur.json()).code).toBe("duration_required");
    const withDur = await changeKind(api, csrf, b, "booth", { duration_minutes: 90 });
    expect(withDur.ok(), `with one: ${await withDur.text()}`).toBeTruthy();
    const booth = await rowOf(api, b.id);
    expect(booth.duration_minutes).toBe(90);
    expect(booth.deadline_at ?? null, "the deadline is CLEARED, not left behind").toBeNull();
    await api.dispose();
  });

  test("a challenge the new kind cannot serve blocks the change, and names it", async () => {
    // lib/challenge-fit.js guards six challenge-side paths so that "no Booth
    // Event holds a challenge nobody at it can answer" holds BY CONSTRUCTION.
    // A kind change is the seventh door into that state.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament");
    const t = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} Upload`, description: "d", answer_type: "file", correct_answer: "x", difficulty: "easy", status: "published" },
    });
    expect(t.ok(), `create task: ${await t.text()}`).toBeTruthy();
    const taskId = (await t.json()).id;
    const asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();

    const r = await changeKind(api, csrf, comp, "booth");
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("event_kind_challenge_unfit");
    expect(body.error, "the refusal names the challenge").toContain("Upload");
    expect((await rowOf(api, comp.id)).event_kind, "and nothing moved").toBe("tournament");

    // POSITIVE CONTROL — the same event re-types fine once the misfit is gone.
    const un = await api.delete(`/api/admin/tasks/${taskId}/competitions/${comp.id}`, { headers: H(csrf) });
    expect(un.ok(), `unassign: ${await un.text()}`).toBeTruthy();
    const again = await changeKind(api, csrf, await rowOf(api, comp.id), "booth");
    expect(again.ok(), `after unassign: ${await again.text()}`).toBeTruthy();
    await api.dispose();
  });

  test("a kind that forbids start reminders purges the pending ones", async () => {
    // The dispatcher reads no policy at all — its SELECT takes `name` and
    // `start_time` — so a reminder set while the event was a Competition would
    // otherwise still be sent for a Program, whose policy says a "starts in an
    // hour" mail is the wrong model. Maximally reachable: a reminder can only be
    // SET while upcoming, which is exactly when the type may be changed.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament");

    const label = uniq();
    const email = `${label}@company.example`;
    const { api: anon, csrf: ac } = await freshCtx();
    expect((await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: { firstName: "Rem", lastName: "Inder", nickname: label, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York" },
    })).status()).toBe(200);
    await anon.dispose();
    const list = await (await api.get("/api/admin/participants?limit=5000")).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, `participant findable — scanned ${(list.participants || []).length}`).toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
    expect((await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [u.id], competitionIds: [comp.id] },
    })).ok()).toBeTruthy();

    const { api: p, csrf: pc0 } = await freshCtx();
    expect((await codeLogin(p, email, H(pc0))).ok()).toBeTruthy();
    const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;
    const set = await p.post(`/api/competitions/${comp.id}/reminder`, { headers: H(pc), data: {} });
    expect(set.ok(), `set reminder: ${await set.text()}`).toBeTruthy();
    await p.dispose();

    const Database = require("better-sqlite3");
    const count = () => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const c = db.prepare("SELECT COUNT(*) c FROM email_reminders WHERE competition_id=? AND sent=0").get(comp.id).c;
      db.close(); return c;
    };
    expect(count(), "a reminder is pending — the precondition, or this asserts nothing").toBe(1);

    const r = await changeKind(api, csrf, await rowOf(api, comp.id), "program", {
      deadline_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    expect(r.ok(), `to program: ${await r.text()}`).toBeTruthy();
    expect(count(), "and a Program keeps none of them").toBe(0);
    expect((await editedChanges(api, comp.id)).start_reminders_purged, "the purge is on the record").toBeTruthy();
    await api.dispose();
  });

  test("UI: the form offers Change type when it may, states the reason when it may not, and re-scopes live", async ({ page }) => {
    const { api, csrf } = await sa();
    const editable = await makeEvent(api, csrf, "tournament");

    await adminLogin(page);
    await expect.poll(
      () => page.evaluate((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), editable.id),
      { timeout: 20000, message: "the event must be in the admin model before its form is opened" },
    ).toBe(true);
    // Changeable: the control is there, and picking a kind re-scopes step 2.
    await page.evaluate((id) => window.openCompetitionForm(id), editable.id);
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="program"]'),
      "an upcoming event offers the type field, enabled").toBeEnabled();
    // A Competition has a duration and no deadline.
    await expect(page.locator("#comp-dur-box")).toBeVisible();
    await expect(page.locator("#comp-deadline-box")).toHaveCount(0);

    await page.click('#comp-form-overlay label.kind-seg-opt:has(input[value="program"])');
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    // Until confirmed, the field still shows the stored type.
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="tournament"]')).toBeChecked();
    await page.click("#modal-confirm-btn");

    // THE RE-SCOPE: the form comes back as a Program — deadline, no duration.
    await page.locator("#comp-deadline-box").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#comp-dur-box"), "a Program has no duration control").toHaveCount(0);
    expect(await page.inputValue("#comp-kind"), "and the resolver reports the NEW kind").toBe("program");

    // SAVING IS THE HALF THAT MATTERS, and asserting only the re-scope left it
    // uncovered: reverting the client to `if(!id&&fd.event_kind)` — which is
    // what shipped before this release, and which makes the whole server
    // capability unreachable from a browser — passed every assertion above,
    // because the form re-scopes purely client-side. Measured, then closed.
    await page.click('#comp-form-overlay [data-action="comp-save"]');
    // The ordinary edit confirmation ("Update Program — Save changes to …?").
    // Its TITLE is itself evidence the form is now a Program, so it is asserted
    // rather than merely dismissed.
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#modal-title")).toContainText("Program");
    await page.click("#modal-confirm-btn");
    await expect.poll(async () => {
      const row = (await (await page.request.get("/api/admin/competitions")).json()).find(c => c.id === editable.id);
      return row && row.event_kind;
    }, { timeout: 15000, message: "the save carries the new kind to the server" }).toBe("program");

    await api.dispose();
  });

  // A kind change KEEPS the sign-up matrix (every kind is configurable; the PUT
  // merges what is sent over the stored states). The form sends all five
  // fields, so it must seed them from the EVENT's own states, never the target
  // kind's defaults, or the browser door silently resets what the API keeps.
  test("UI: a change of type keeps the event's own sign-up form", async ({ page }) => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament", { registration_fields: { phone: "required", city: "hidden" } });
    const before = await rowOf(api, comp.id);
    expect(before.policy.registration_fields, "PRECONDITION: the event's own matrix").toMatchObject({ phone: "required", city: "hidden" });
    await api.dispose();

    await adminLogin(page);
    await expect.poll(() => page.evaluate((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), comp.id),
      { timeout: 20000, message: "the event must be in the admin model before its form is opened" }).toBe(true);
    await page.evaluate((id) => window.openCompetitionForm(id), comp.id);
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.click('#comp-form-overlay label.kind-seg-opt:has(input[value="program"])');
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Change type to Program?", { timeout: 10000 });
    await page.click("#modal-confirm-btn");
    await page.locator("#comp-deadline-box").waitFor({ state: "visible", timeout: 10000 });

    const state = (k) => page.locator(`#comp-form-overlay input[name="reg-state-${k}"]:checked`).getAttribute("value");
    expect(await state("phone"), "the re-typed form shows the event's Phone, not the new type's default").toBe("required");
    expect(await state("city"), "and its City").toBe("hidden");
    expect(await state("job_function"), "CONTROL: a field the event left alone shows the default").toBe("optional");

    await page.click('#comp-form-overlay [data-action="comp-save"]');
    await expect(page.locator("#modal-overlay.open #modal-title")).toContainText("Program", { timeout: 10000 });
    await page.click("#modal-confirm-btn");
    await expect.poll(async () => {
      const row = (await (await page.request.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      return row && row.event_kind;
    }, { timeout: 15000, message: "the save carries the new kind" }).toBe("program");
    const after = (await (await page.request.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
    expect(after.policy.registration_fields, "the matrix survives the change of type").toMatchObject({ phone: "required", city: "hidden", job_function: "optional" });
  });

  // The confirmation names every setting the new type turns off, late entries
  // (and a pinned late-entry deadline) included: the PUT clears both for a type
  // that takes none.
  test("UI: the change-of-type confirmation names late entries the new type turns off", async ({ page }) => {
    const { api, csrf } = await sa();
    const withLate = await makeEvent(api, csrf, "booth", { duration_minutes: 180 });
    const endMs = Date.now() + 3600e3 + 180 * 60_000;
    const pin = await api.put(`/api/admin/competitions/${withLate.id}`, { headers: H(csrf),
      data: { late_entry_enabled: true, late_entry_deadline_at: new Date(endMs + 24 * 3600e3).toISOString(), expectedUpdatedAt: withLate.updated_at } });
    expect(pin.ok(), `pin the late deadline: ${await pin.text()}`).toBeTruthy();
    const noLate = await makeEvent(api, csrf, "booth", { late_entry_enabled: false });
    const r1 = await rowOf(api, withLate.id), r2 = await rowOf(api, noLate.id);
    expect([!!r1.late_entry_enabled, !!r1.late_entry_deadline_at], "PRECONDITION: on, with a pinned deadline").toEqual([true, true]);
    expect([!!r2.late_entry_enabled, !!r2.late_entry_deadline_at], "PRECONDITION: off").toEqual([false, false]);
    await api.dispose();

    await adminLogin(page);
    const confirmText = async (id) => {
      await expect.poll(() => page.evaluate((x) => (window.S?.adminCompetitionsData || []).some(c => c.id === x), id), { timeout: 20000 }).toBe(true);
      await page.evaluate((x) => window.openCompetitionForm(x), id);
      await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });
      await page.click('#comp-form-overlay label.kind-seg-opt:has(input[value="tournament"])');
      const modal = page.locator("#modal-overlay.open");
      await expect(modal.locator("#modal-title")).toHaveText("Change type to Competition?", { timeout: 10000 });
      const text = await modal.locator("#modal-body").innerText();
      await page.click("#modal-cancel-btn");
      await page.locator('#comp-form-overlay [data-action="overlay-close"]').first().click();
      await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
      return text;
    };
    expect(await confirmText(withLate.id), "late entries and their pinned deadline are named").toContain("Late entries, and their deadline");
    expect(await confirmText(noLate.id), "CONTROL: an event with no late entries is told nothing about them").not.toContain("Late entries");
  });

  test("UI: a started event offers no control, and says why in its place", async ({ page }) => {
    // Its OWN test rather than the tail of the one above. Sharing a page meant
    // opening this form immediately after a save that reloads the competitions
    // model and closes a confirm modal — two settle signals the assertion did
    // not wait on, which is what made it flaky (measured under --repeat-each).
    // The two halves share no state, so the coupling bought nothing.
    const { api, csrf } = await sa();
    const started = await makeEvent(api, csrf, "tournament", {}, -3600e3);

    await adminLogin(page);
    // The form renders from `S.adminCompetitionsData`; opening an id the model
    // has not loaded yet makes openCompetitionForm refuse with a toast and no
    // overlay, which surfaces as "waiting for #comp-form-overlay" and names
    // nothing (the v7.22.x model-not-loaded class).
    await expect.poll(
      () => page.evaluate((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), started.id),
      { timeout: 20000, message: "the event must be in the admin model before its form is opened" },
    ).toBe(true);
    await page.evaluate((id) => window.openCompetitionForm(id), started.id);
    await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 10000 });

    const radios = page.locator('#comp-form-overlay input[name="comp-kind-seg"]');
    await expect(radios).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(radios.nth(i), "a started event's type cannot be changed").toBeDisabled();
    // v7.14.2 — the affordance and its explanation move together. A control that
    // simply goes inert reads as a broken feature; this one says why.
    await expect(page.locator("#comp-kind-note")).toContainText(/before the event starts/i);
    await api.dispose();
  });
});
