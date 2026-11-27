// @ts-check
//
// v8.12.8 — "CLOSE LATE ENTRIES NOW".
//
// `POST /api/admin/competitions/:id/late-entry/close` closes a Booth Event's OPEN
// late-entry window at a SERVER-resolved instant, to the millisecond, for any admin
// or superadmin and for an event admin on the events they organise. Until this
// route the only way was a superadmin typing a deadline into the editor, which the
// form rounds to the minute (the v8.12.7 F3 residual).
//
// ── WHAT THIS FILE PINS, AND WHY EACH ARM EXISTS ─────────────────────────────
//
//   A1-A5   the write: the exact stored instant (one ms before the press, after
//           the end), that nothing else moves, the echo trap, the `updated_at`
//           bump, idempotence.
//   A6-A9   the refusal ladder and every tier, each refusal with a control that
//           the SAME call succeeds for somebody else — "refused" alone is equally
//           satisfied by a build that broke the route for everybody.
//   A10     the audit row, in both stores.
//   A11-A14 each of the four cache busts, one arm per cache, each built to fail
//           when its own bust is dropped (warm the cache, close, read at once).
//   A15     every admission door shuts, each with a before-the-close control
//           that it ADMITS through the open window.
//   A16     the pure instant, over the inclusive-deadline boundary.
//   A17     `.immediate()` under a REAL external write lock.
//   A18     reopening a closed event is a superadmin's editor save, and extending
//           one needs the deadline set back to Automatic in the same save.
//   A19     the three companion busts (the PUT, a revive, End Now).
//
// ── FIXTURES ──────────────────────────────────────────────────────────────────
//
// Every test owns its events and people (fixture checklist items 2-3). A booth is
// ended with the REAL `POST …/end-now` as the superadmin, which opens the window at
// once without a raw write; `expireEvent` is used only where the time-expired base
// (`ended_at` NULL) is the subject. `liveBooth` leaves self-enrolment ON, which also
// suppresses the all-solved auto-end, so a fixture stays live until it is ended on
// purpose.
//
// THE BUILT-IN SUPERADMIN IS ONE SESSION PLATFORM-WIDE: `sa()` purges the previous
// one. Each test signs it in once; where a second superadmin is needed it is a
// USER-BACKED one (`makeAdmin(…, "superadmin")`).
const { test, expect } = require("./isolated-test");
const path = require("path");
const http = require("http");
const { freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, BASE, findLogLine, pollAdminLogs } = require("./helpers");
const {
  H, uniq, MIN, outliveCompCache,
  sa, makeParticipant, rawGetComp, liveBooth, enrol, expireEvent, participantCtx, submit,
  rawGet, rawAll,
} = require("./late-entry-fixture");
const { signIn, makeAdmin } = require("./admin-inflight-helpers");
const { grantEventAdmin, makeParticipant: makeEaParticipant } = require("./event-admin-helpers");

// ─── local helpers ───────────────────────────────────────────────────────────

const closeUrl = (id) => `/api/admin/competitions/${encodeURIComponent(id)}/late-entry/close`;

async function close(api, csrf, id) {
  const r = await api.post(closeUrl(id), { headers: H(csrf) });
  let body = {};
  try { body = await r.json(); } catch (_) { /* asserted on status */ }
  return { status: r.status(), body };
}

async function endNow(api, csrf, id) {
  const r = await api.post(`/api/admin/competitions/${id}/end-now`, { headers: H(csrf), data: {} });
  expect(r.ok(), `end now: ${r.status()} ${await r.text()}`).toBeTruthy();
  const c = rawGetComp(id);
  expect(c.ended_at, "PRECONDITION: End Now really stamped the end").toBeTruthy();
  return c;
}

/** A Booth Event ENDED by End Now, its late-entry window open. */
async function openBooth(api, csrf, opts = {}) {
  const b = await liveBooth(api, csrf, opts);
  const ended = await endNow(api, csrf, b.comp.id);
  return { ...b, ended };
}

async function listRow(api, id) {
  const r = await api.get("/api/admin/competitions");
  expect(r.ok(), `list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(c => c.id === id);
  expect(row, `the event is in this actor's list`).toBeTruthy();
  return row;
}

const closedRows = (id) => rawAll("SELECT * FROM competition_events WHERE competition_id=? AND event_type='late_entry_closed' ORDER BY rowid", [id]);
const cuRow = (compId, userId) => rawGet("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?", [compId, userId]);

/** A late entrant: enrolled through the OPEN window, signed in and selected. */
async function lateEntrant(api, csrf, compId) {
  const p = await makeParticipant(api, csrf, uniq());
  await enrol(api, csrf, compId, p.id);
  const c = await participantCtx(p.email, compId);
  return { ...p, ...c };
}

/** A fresh event admin who organises `compIds` (granted BEFORE they sign in). */
async function eventAdmin(api, csrf, compIds) {
  const p = await makeEaParticipant(api, csrf, "closeea");
  for (const id of compIds) await grantEventAdmin(api, csrf, id, p.id);
  return { ...p, ...(await signIn(p.email, PARTICIPANT_PASS)) };
}

/** A fresh user-backed admin (or superadmin), signed in. */
async function admin(api, csrf, label, role = "admin") {
  const p = await makeAdmin(api, csrf, label, role);
  return { ...p, ...(await signIn(p.email, PARTICIPANT_PASS)) };
}

const meComp = async (api, id) => {
  const me = await (await api.get("/api/me")).json();
  return (me.competitions || []).find(c => c.id === id);
};

// ═══════════════════════════════════════════════════════════════════════════
// The write
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.8 — closing late entries: the write", () => {
  test("A1 — a global admin closes an End-Now'd booth; the pin is one ms before the press and after the end; nothing else moves", async () => {
    const { api, csrf } = await sa();
    const ga = await admin(api, csrf, "closega");
    try {
      const b = await openBooth(api, csrf);
      const before = rawGetComp(b.comp.id);
      expect(before.late_entry_deadline_at, "PRECONDITION: the deadline is Automatic").toBeNull();
      expect((await listRow(ga.api, b.comp.id)).can_close_late_entries, "PRECONDITION: the control is offered").toBe(true);

      const sent = Date.now();
      const r = await close(ga.api, ga.csrf, b.comp.id);
      const received = Date.now();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ok: true, closed: true, alreadyClosed: false });

      const after = rawGetComp(b.comp.id);
      expect(after.late_entry_deadline_at, "the stored pin IS the response's").toBe(r.body.late_entry_deadline_at);
      // THE CONTRACT: the pin is exactly one millisecond before the press. The
      // window's end is INCLUSIVE, so storing the press instant itself would leave
      // it open for the rest of that millisecond; and a minute-rounded pin (the
      // form's) fails this by up to 59 999.
      expect(Date.parse(r.body.closed_at) - Date.parse(r.body.late_entry_deadline_at), "pin = press − 1 ms").toBe(1);
      expect(Date.parse(after.late_entry_deadline_at), "…and strictly after the end, or every later save would 400").toBeGreaterThan(Date.parse(before.ended_at));
      expect(Date.parse(r.body.closed_at)).toBeGreaterThanOrEqual(sent);
      expect(Date.parse(r.body.closed_at)).toBeLessThanOrEqual(received);
      expect(r.body.previous_deadline, "the resolved Automatic deadline it replaced").toBe(new Date(Date.parse(before.ended_at) + 48 * 60 * MIN).toISOString());
      expect(r.body.previous_deadline_pinned).toBe(false);

      expect(r.body.competition.late_entry_window_open, "the response's row reads the NEW state").toBe(false);
      expect(r.body.competition.can_close_late_entries).toBe(false);
      expect(r.body.competition.late_entry_deadline_effective).toBe(r.body.late_entry_deadline_at);
      expect(r.body.competition.status).toBe("ended");
      expect(r.body.competition.self_enroll_token, "the projection strips its secrets").toBeUndefined();

      // CONTROL — the close touches the deadline and `updated_at` and NOTHING else.
      for (const k of ["ended_at", "ended_manually", "duration_minutes", "start_time", "late_entry_enabled", "self_enroll_enabled"]) {
        expect(after[k], `${k} is untouched`).toEqual(before[k]);
      }
      expect(after.updated_at, "updated_at is the press instant").toBe(r.body.closed_at);
      expect((await listRow(ga.api, b.comp.id)).can_close_late_entries, "the list no longer offers it").toBe(false);
    } finally { await ga.api.dispose(); await api.dispose(); }
  });

  test("A2 — a PINNED deadline on a time-expired booth (ended_at NULL), closed by its organiser", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      await expireEvent(b.comp.id, { agoMinutes: 30 });
      expect(rawGetComp(b.comp.id).ended_at, "PRECONDITION: a time-expired end").toBeNull();
      const pinIso = new Date(Date.now() + 3 * 60 * MIN).toISOString();
      const row = await listRow(api, b.comp.id);
      const put = await api.put(`/api/admin/competitions/${b.comp.id}`, {
        headers: H(csrf), data: { late_entry_deadline_at: pinIso, expectedUpdatedAt: row.updated_at } });
      expect(put.status(), `pin: ${await put.text()}`).toBe(200);
      const ea = await eventAdmin(api, csrf, [b.comp.id]);
      try {
        const r = await close(ea.api, ea.csrf, b.comp.id);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.previous_deadline).toBe(pinIso);
        expect(r.body.previous_deadline_pinned).toBe(true);
        const rows = closedRows(b.comp.id);
        expect(rows.length).toBe(1);
        const d = JSON.parse(rows[0].details);
        expect(d.from, "the audit records the pin it replaced").toBe(pinIso);
        expect(d.from_pinned, "…and that it WAS a pin").toBe(pinIso);
        expect(rows[0].changed_by, "attributed to the organiser").toBe(ea.email);
      } finally { await ea.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("A3 — the echo trap: a superadmin save echoing the stored pin is accepted and leaves it alone", async () => {
    // Kills "store the effective end": `_validateLateDeadline` refuses a deadline
    // AT the end on every save that sends it, and the editor echoes the stored pin.
    const { api, csrf } = await sa();
    try {
      const b = await openBooth(api, csrf);
      const r = await close(api, csrf, b.comp.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const row = await listRow(api, b.comp.id);
      const put = await api.put(`/api/admin/competitions/${b.comp.id}`, {
        headers: H(csrf),
        data: { attempt_cap: 4, late_entry_deadline_at: rawGetComp(b.comp.id).late_entry_deadline_at, expectedUpdatedAt: row.updated_at } });
      expect(put.status(), `an unrelated save echoing the pin: ${await put.text()}`).toBe(200);
      const after = rawGetComp(b.comp.id);
      expect(after.late_entry_deadline_at, "pin unchanged").toBe(r.body.late_entry_deadline_at);
      expect(after.attempt_cap, "CONTROL: the unrelated field really saved").toBe(4);
    } finally { await api.dispose(); }
  });

  test("A4 — updated_at is bumped: an editor opened before the close 409s rather than re-opening the window", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await openBooth(api, csrf);
      const stale = (await listRow(api, b.comp.id)).updated_at;
      expect((await close(api, csrf, b.comp.id)).status).toBe(200);
      const put = await api.put(`/api/admin/competitions/${b.comp.id}`, { headers: H(csrf), data: { attempt_cap: 3, expectedUpdatedAt: stale } });
      expect(put.status(), `a save carrying the pre-close token: ${await put.text()}`).toBe(409);
      // CONTROL — the post-close token is accepted, so the 409 was about staleness.
      const fresh = (await listRow(api, b.comp.id)).updated_at;
      expect(fresh).not.toBe(stale);
      const ok = await api.put(`/api/admin/competitions/${b.comp.id}`, { headers: H(csrf), data: { attempt_cap: 3, expectedUpdatedAt: fresh } });
      expect(ok.status(), await ok.text()).toBe(200);
    } finally { await api.dispose(); }
  });

  test("A5 — idempotent: a second close writes nothing; a naturally lapsed window answers the same", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await openBooth(api, csrf);
      const first = await close(api, csrf, b.comp.id);
      expect(first.status).toBe(200);
      const snap = rawGetComp(b.comp.id);
      const again = await close(api, csrf, b.comp.id);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body).toMatchObject({ ok: true, closed: false, alreadyClosed: true });
      expect(again.body.late_entry_deadline_effective).toBe(first.body.late_entry_deadline_at);
      expect(again.body.competition.can_close_late_entries).toBe(false);
      expect(closedRows(b.comp.id).length, "exactly ONE audit row").toBe(1);
      const after = rawGetComp(b.comp.id);
      expect(after.updated_at, "updated_at untouched by the no-op").toBe(snap.updated_at);
      expect(after.late_entry_deadline_at).toBe(snap.late_entry_deadline_at);

      const lapsed = await liveBooth(api, csrf);
      await expireEvent(lapsed.comp.id, { agoMinutes: 49 * 60 });
      const l = await close(api, csrf, lapsed.comp.id);
      expect(l.status, JSON.stringify(l.body)).toBe(200);
      expect(l.body.alreadyClosed).toBe(true);
      expect(closedRows(lapsed.comp.id).length, "no audit row for a window that closed by itself").toBe(0);
      expect(rawGetComp(lapsed.comp.id).late_entry_deadline_at, "and no pin written").toBeNull();
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The refusal ladder and the tiers
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.8 — closing late entries: who may, and when", () => {
  test("A6 — refusals: not ended, late entries off, a Competition, an unknown id — each with its control", async () => {
    const { api, csrf } = await sa();
    try {
      const live = await liveBooth(api, csrf);
      const r1 = await close(api, csrf, live.comp.id);
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe("late_entry_not_ended");
      expect(r1.body.error).toMatch(/has not ended yet/);
      expect(r1.body.error).toContain(live.comp.name);
      expect(rawGetComp(live.comp.id).late_entry_deadline_at, "nothing written").toBeNull();
      expect(closedRows(live.comp.id).length).toBe(0);
      // CONTROL — the same event, ended, closes. It is the twin for the three
      // refusals below as well: each is the same `liveBooth` + End Now, differing
      // only by the flag, the kind or the id, and each is identified by its own
      // code (the unknown id by its 404).
      await endNow(api, csrf, live.comp.id);
      expect((await close(api, csrf, live.comp.id)).status).toBe(200);

      const off = await liveBooth(api, csrf, { create: { late_entry_enabled: false } });
      await endNow(api, csrf, off.comp.id);
      const r2 = await close(api, csrf, off.comp.id);
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe("late_entry_not_enabled");
      expect(r2.body.error).toMatch(/does not take late entries/);
      expect((await listRow(api, off.comp.id)).can_close_late_entries, "never offered").toBe(false);

      const comp = await liveBooth(api, csrf, { kind: "tournament" });
      await endNow(api, csrf, comp.comp.id);
      const r3 = await close(api, csrf, comp.comp.id);
      expect(r3.status).toBe(400);
      expect(r3.body.code).toBe("late_entry_forbidden");
      expect(r3.body.error, "the ONE sentence, naming the kind with its article").toBe(
        "Late entries are not available for a Competition — only a Booth Event stays open for a walk-up who arrives as it closes.");

      const r4 = await close(api, csrf, "no-such-event-" + uniq());
      expect(r4.status).toBe(404);
      expect(r4.body.error).toBe("Event not found");
    } finally { await api.dispose(); }
  });

  test("A7 — tiers: superadmin, global admin, organiser in scope close; out-of-scope and zero-grant organisers, a participant and nobody are refused", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const bSa = await openBooth(api, csrf);
      expect((await close(api, csrf, bSa.comp.id)).status, "superadmin").toBe(200);

      const ga = await admin(api, csrf, "tierga"); people.push(ga);
      const bGa = await openBooth(api, csrf);
      expect((await close(ga.api, ga.csrf, bGa.comp.id)).status, "global admin").toBe(200);

      const mine = await openBooth(api, csrf);
      const theirs = await openBooth(api, csrf);
      const ea = await eventAdmin(api, csrf, [mine.comp.id]); people.push(ea);
      expect((await close(ea.api, ea.csrf, mine.comp.id)).status, "organiser, own event").toBe(200);
      const out = await close(ea.api, ea.csrf, theirs.comp.id);
      expect(out.status, "organiser, somebody else's event").toBe(403);
      expect(out.body.code).toBe("event_admin_out_of_scope");
      expect(rawGetComp(theirs.comp.id).late_entry_deadline_at, "nothing written").toBeNull();
      // CONTROL — the SAME event closes for a global admin, so the refusal was scope.
      expect((await close(ga.api, ga.csrf, theirs.comp.id)).status).toBe(200);

      const z = await makeEaParticipant(api, csrf, "closezero");
      const role = await api.post(`/api/admin/participants/${z.id}/role`, { headers: H(csrf), data: { role: "event_admin" } });
      expect(role.ok(), await role.text()).toBeTruthy();
      const zs = { ...z, ...(await signIn(z.email, PARTICIPANT_PASS)) }; people.push(zs);
      const zb = await openBooth(api, csrf);
      const zr = await close(zs.api, zs.csrf, zb.comp.id);
      expect(zr.status, "a zero-grant organiser").toBe(403);
      expect(zr.body.code).toBe("event_admin_out_of_scope");

      const p = await makeParticipant(api, csrf, uniq());
      const pc = await participantCtx(p.email); people.push(pc);
      expect((await close(pc.api, pc.csrf, zb.comp.id)).status, "a participant").toBe(403);
      const anon = await freshCtx(); people.push(anon);
      expect((await anon.api.post(closeUrl(zb.comp.id), { headers: H(anon.csrf) })).status(), "nobody").toBe(401);
      expect(rawGetComp(zb.comp.id).late_entry_deadline_at, "nothing written by any refusal").toBeNull();
    } finally {
      for (const x of people) await x.api.dispose();
      await api.dispose();
    }
  });

  test("A8 — a COMPETITOR is refused and never offered it; a non-competing admin is offered it and closes", async () => {
    const { api, csrf } = await sa();
    const comp = await admin(api, csrf, "competitor");
    const other = await admin(api, csrf, "noncompetitor");
    try {
      // A compete event holds SEALED challenges only, and `liveBooth` always
      // assigns an unsealed one (`tasks: 0` reads as its default of 1), so the
      // booth is created here with no challenge at all.
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `LE ${uniq()}`, event_kind: "booth", start_time: new Date(Date.now() - 5 * MIN).toISOString(),
        duration_minutes: 180, self_enroll_enabled: true, staff_compete: true } });
      expect(cr.ok(), `create: ${await cr.text()}`).toBeTruthy();
      const b = { comp: (await cr.json()).competition };
      expect(rawGetComp(b.comp.id).staff_compete, "PRECONDITION: staff compete here").toBe(1);
      await enrol(api, csrf, b.comp.id, comp.id);
      await endNow(api, csrf, b.comp.id);

      const row = await listRow(comp.api, b.comp.id);
      expect(row.competing, "PRECONDITION: they really compete").toBe(true);
      expect(row.late_entry_window_open, "PRECONDITION: the window is open").toBe(true);
      expect(row.can_close_late_entries, "never offered to a competitor").toBe(false);
      const r = await close(comp.api, comp.csrf, b.comp.id);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe("competitor_cannot_edit");
      expect(rawGetComp(b.comp.id).late_entry_deadline_at, "nothing written").toBeNull();

      // THE ORDER — the competitor lock is asked ABOVE the event-admin scope (the
      // competition-door rule: every tier hears the same refusal for the same act).
      // Only an organiser who competes in an event they do NOT run can tell the two
      // orders apart; they must hear the competitor reason, not the scope one.
      const eaComp = await makeEaParticipant(api, csrf, "eacompetitor");
      const elsewhere = await openBooth(api, csrf);
      await grantEventAdmin(api, csrf, elsewhere.comp.id, eaComp.id);
      await enrol(api, csrf, b.comp.id, eaComp.id);
      const eaS = await signIn(eaComp.email, PARTICIPANT_PASS);
      try {
        const er = await close(eaS.api, eaS.csrf, b.comp.id);
        expect(er.status, JSON.stringify(er.body)).toBe(403);
        expect(er.body.code, "the competitor reason, not the scope one").toBe("competitor_cannot_edit");
      } finally { await eaS.api.dispose(); }

      // CONTROL — the same event, a non-competing admin.
      const orow = await listRow(other.api, b.comp.id);
      expect(orow.competing).toBe(false);
      expect(orow.can_close_late_entries, "offered to a non-competitor").toBe(true);
      expect((await close(other.api, other.csrf, b.comp.id)).status).toBe(200);
    } finally { await comp.api.dispose(); await other.api.dispose(); await api.dispose(); }
  });

  test("A9 — impersonation: a regular admin in an organiser's panel is read-only; a superadmin closes as the seat, audited as themselves, inside the seat's scope", async () => {
    const { api, csrf } = await sa();
    const reg = await admin(api, csrf, "impreg");
    const sup = await admin(api, csrf, "impsup", "superadmin");
    try {
      const mine = await openBooth(api, csrf);
      const theirs = await openBooth(api, csrf);
      const ea = await makeEaParticipant(api, csrf, "impseat");
      await grantEventAdmin(api, csrf, mine.comp.id, ea.id);

      const enter = async (who) => {
        const e = await who.api.post(`/api/admin/participants/${ea.id}/impersonate`, { headers: H(who.csrf), data: { view: "admin" } });
        expect(e.ok(), `enter the organiser's panel: ${await e.text()}`).toBeTruthy();
        who.csrf = (await (await who.api.get("/api/csrf-token")).json()).csrfToken;
      };
      const leave = async (who) => {
        await who.api.post("/api/impersonation/exit", { headers: H(who.csrf) }).catch(() => {});
      };

      await enter(reg);
      try {
        const r = await close(reg.api, reg.csrf, mine.comp.id);
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(r.body.code).toBe("impersonation_readonly");
        expect(rawGetComp(mine.comp.id).late_entry_deadline_at).toBeNull();
      } finally { await leave(reg); }

      await enter(sup);
      try {
        const out = await close(sup.api, sup.csrf, theirs.comp.id);
        expect(out.status, "the SEAT's scope binds").toBe(403);
        expect(out.body.code).toBe("event_admin_out_of_scope");
        const r = await close(sup.api, sup.csrf, mine.comp.id);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const rows = closedRows(mine.comp.id);
        expect(rows.length).toBe(1);
        expect(rows[0].changed_by, "the HUMAN, not the seat").toBe(sup.email);
        const d = JSON.parse(rows[0].details);
        expect(d.impersonated_by).toBe(sup.email);
        expect(d.acting_as).toBe(ea.email);
      } finally { await leave(sup); }
    } finally { await reg.api.dispose(); await sup.api.dispose(); await api.dispose(); }
  });

  test("A10 — the audit: one row, attributed, carrying the press, the pin, what it replaced and the source; mirrored to app.jsonl", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await openBooth(api, csrf);
      const r = await close(api, csrf, b.comp.id);
      expect(r.status).toBe(200);
      const rows = closedRows(b.comp.id);
      expect(rows.length).toBe(1);
      expect(rows[0].changed_by).toBe("superadmin");
      const d = JSON.parse(rows[0].details);
      expect(d.closed_at).toBe(r.body.closed_at);
      expect(d.to).toBe(r.body.late_entry_deadline_at);
      expect(d.from).toBe(r.body.previous_deadline);
      expect(d.from_pinned, "an Automatic deadline records no pin").toBeNull();
      expect(d.ip, "the source address (v7.21.32)").toBeTruthy();
      expect(d.req_id).toBeTruthy();
      const entries = await pollAdminLogs(api, `stream=app&q=late_entry_closed&limit=200`,
        (es) => es.some(e => JSON.stringify(e).includes(b.comp.id)),
        { what: "the late_entry_closed mirror line" });
      expect(JSON.stringify(entries.find(e => JSON.stringify(e).includes(b.comp.id)))).toContain(r.body.closed_at);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The four caches — one arm each, built to fail when its own bust is dropped
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.8 — closing late entries: what everybody sees at once", () => {
  test("A11 — the late entrant is stopped at once (the competition-row bust); a twin booth's late entrant still plays", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const b = await openBooth(api, csrf, { tasks: 2 });
      const le = await lateEntrant(api, csrf, b.comp.id); people.push(le);
      const wrong = await submit(le.api, le.csrf, b.taskIds[0], "nope");
      expect(wrong.status(), `PRECONDITION: a late entrant plays — ${await wrong.text()}`).toBe(200);
      expect((await wrong.json()).correct).toBe(false);

      expect((await close(api, csrf, b.comp.id)).status).toBe(200);
      // AT ONCE — inside the 1 s competition-row cache the wrong answer just warmed.
      const right = await submit(le.api, le.csrf, b.taskIds[0]);
      expect(right.status(), await right.text()).toBe(403);
      expect((await right.json()).error).toMatch(/has ended/);
      expect(rawGet("SELECT COUNT(*) AS n FROM submissions WHERE competition_id=? AND user_id=? AND is_correct=1", [b.comp.id, le.id]).n,
        "no correct submission was recorded").toBe(0);
      const st = await (await le.api.get("/api/status")).json();
      expect(st.status).toBe("ended");
      expect(st.late_entry && st.late_entry.window_open, "the countdown stops").toBeFalsy();
      const hint = await le.api.post(`/api/tasks/${b.taskIds[1]}/hint`, { headers: H(le.csrf) });
      expect(hint.status(), "no hint either").toBe(403);

      // CONTROL — a late entrant on an unclosed twin booth still submits.
      const twin = await openBooth(api, csrf);
      const t = await lateEntrant(api, csrf, twin.comp.id); people.push(t);
      const ok = await submit(t.api, t.csrf, twin.taskIds[0]);
      expect(ok.status(), await ok.text()).toBe(200);
      expect((await ok.json()).correct).toBe(true);
    } finally { for (const x of people) await x.api.dispose(); await api.dispose(); }
  });

  test("A12 — /api/me stops reporting the window at once (the me-cache bust)", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const b = await openBooth(api, csrf);
      const le = await lateEntrant(api, csrf, b.comp.id); people.push(le);
      const warm = await meComp(le.api, b.comp.id);
      expect(warm && warm.late_entry_window_open, "PRECONDITION: warmed with the window open").toBe(true);
      expect((await close(api, csrf, b.comp.id)).status).toBe(200);
      const now = await meComp(le.api, b.comp.id);
      expect(now.late_entry_window_open, "read at once, inside the 2 s me-cache").toBe(false);
    } finally { for (const x of people) await x.api.dispose(); await api.dispose(); }
  });

  test("A13 — the admin participants page stops marking late entrants at once (the participants-cache bust)", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const b = await openBooth(api, csrf);
      const le = await lateEntrant(api, csrf, b.comp.id); people.push(le);
      const entry = async () => {
        const list = await (await api.get("/api/admin/participants?limit=5000")).json();
        const p = (list.participants || []).find(x => x.id === le.id);
        return (p && p.competitions || []).find(c => c.id === b.comp.id);
      };
      const warm = await entry();
      expect(warm, "PRECONDITION: the late entrant is on the page").toBeTruthy();
      expect(warm.late_entrant).toBe(true);
      expect(warm.late_entry_playing).toBe(true);
      expect(warm.late_entry_window_open).toBe(true);
      expect((await close(api, csrf, b.comp.id)).status).toBe(200);
      const now = await entry();
      expect(now.late_entry_window_open, "read at once, inside the 5 s participants cache").toBe(false);
      expect(now.late_entrant, "no longer removable").toBeUndefined();
      expect(now.late_entry_playing, "no longer playing").toBeUndefined();
    } finally { for (const x of people) await x.api.dispose(); await api.dispose(); }
  });

  test("A14 — the late board becomes final at once (the leaderboard bust), and the late winner takes a PLACING certificate", async () => {
    const { api, csrf } = await sa();
    const people = [];
    try {
      const b = await openBooth(api, csrf, { tasks: 2 });
      const le = await lateEntrant(api, csrf, b.comp.id); people.push(le);
      const s = await submit(le.api, le.csrf, b.taskIds[0]);
      expect((await s.json()).correct, "PRECONDITION: one correct answer, not finished").toBe(true);
      const certs = await (await le.api.get("/api/me/certificates")).json();
      const offer = (certs.claimable || []).find(c => c.competitionId === b.comp.id);
      expect(offer, "PRECONDITION: a certificate is offered").toBeTruthy();
      expect(offer.latePlacementPending, "PRECONDITION: while the window is open a placing is PENDING").toBe(true);

      const lateRow = async () => {
        const board = await (await api.get(`/api/admin/leaderboard?competitionId=${b.comp.id}`)).json();
        return board.find(e => e.userId === le.id);
      };
      const warm = await lateRow();
      expect(warm && warm.isLateEntrant, "PRECONDITION: ranked in the late section").toBe(true);
      expect(warm.rank).toBe(1);
      await new Promise(r => setTimeout(r, 150));
      const c = await close(api, csrf, b.comp.id);
      expect(c.status).toBe(200);
      const now = await lateRow();
      const login = cuRow(b.comp.id, le.id).login_time;
      expect(login, "PRECONDITION: their solve clock is anchored").toBeTruthy();
      // The late section measures an unfinished entrant against THEIR end, which is
      // now the stored pin. A stale cached row reads the warm-time value, strictly
      // smaller (the close came 150 ms later).
      expect(now.solveTimeMs, "read at once, inside the 5 s leaderboard cache").toBe(Date.parse(c.body.late_entry_deadline_at) - Date.parse(login));
      expect(now.solveTimeMs).toBeGreaterThan(warm.solveTimeMs);

      const mint = await le.api.post(`/api/competitions/${b.comp.id}/badge`, { headers: H(le.csrf) });
      expect(mint.status(), await mint.text()).toBe(200);
      const badge = rawGet("SELECT basis, late_entrant, rank FROM achievement_badges WHERE user_id=? AND competition_id=?", [le.id, b.comp.id]);
      expect(badge.basis, "the board is final, so the late winner places").toBe("placement");
      expect(badge.late_entrant).toBe(1);
      expect(badge.rank).toBe(1);
    } finally { for (const x of people) await x.api.dispose(); await api.dispose(); }
  });

  test("A15 — every door shuts: the join code, the join link, the assign door and the desk (each open before the close)", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await openBooth(api, csrf);
      const rv = await (await api.get(`/api/admin/competitions/${b.comp.id}/self-enroll`)).json();
      expect(rv.token && rv.join_code, "PRECONDITION: the event has a link and a code").toBeTruthy();
      // CONTROLS — before the close, EVERY door admits, the two admin doors
      // included. Without them "refused after the close" is equally satisfied by a
      // door that refuses a window-open booth outright (the v8.12.6 regression
      // class) — measured: the arm passed with the assign door or the desk broken
      // that way while it controlled only the code and the link.
      expect((await (await api.get(`/api/competitions/join-code/${rv.join_code}`)).json()).ok, "the code resolves while open").toBe(true);
      expect((await api.get(`/api/competitions/self-enroll/${rv.token}`)).status(), "the link previews while open").toBe(200);
      const early = await makeParticipant(api, csrf, uniq());
      const earlyAssign = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [early.id], competitionIds: [b.comp.id] } });
      expect(earlyAssign.status(), `the assign door admits while open: ${await earlyAssign.text()}`).toBe(200);
      const eab = await earlyAssign.json();
      expect(eab.assigned, "…the participant really enrolled (the door SKIPS rather than refuses)").toBe(1);
      expect(eab.lateEntryCompetitionIds, "…through the late-entry window").toEqual([b.comp.id]);
      expect(cuRow(b.comp.id, early.id), "…and the row landed").toBeTruthy();
      const earlyDesk = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email: `${uniq()}@company.example`, competitionId: b.comp.id } });
      expect(earlyDesk.status(), `the desk admits while open: ${await earlyDesk.text()}`).toBe(200);
      const edb = await earlyDesk.json();
      expect(edb.code, "…and hands over a sign-in code").toBeTruthy();
      expect(edb.lateEntry, "…as a late entrant").toBe(true);
      expect(cuRow(b.comp.id, edb.id), "…enrolled in the event").toBeTruthy();

      expect((await close(api, csrf, b.comp.id)).status).toBe(200);

      const code = await api.get(`/api/competitions/join-code/${rv.join_code}`);
      expect(code.status(), "200-always").toBe(200);
      expect((await code.json()).ok).toBe(false);
      expect((await api.get(`/api/competitions/self-enroll/${rv.token}`)).status(), "the link is dead").toBe(404);
      const n = await makeParticipant(api, csrf, uniq());
      const a = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [n.id], competitionIds: [b.comp.id] } });
      expect(a.status(), await a.text()).toBe(400);
      expect((await a.json()).error, "the ordinary ended-event refusal, naming the event").toContain(`ended event "${b.comp.name}"`);
      expect(cuRow(b.comp.id, n.id), "no row").toBeFalsy();
      // The desk answers 409 for TWO reasons — a closed event and `email_taken` —
      // so the status alone does not say which fired. The closed-event sentence,
      // with no code, does; and a refusal must leave no account behind.
      const lateEmail = `${uniq()}@company.example`;
      const desk = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email: lateEmail, competitionId: b.comp.id } });
      expect(desk.status(), await desk.text()).toBe(409);
      const deskBody = await desk.json();
      expect(deskBody.error, "the closed-event refusal, not a duplicate").toBe("That event has finished and is not taking late entries.");
      expect(deskBody.code, "…which carries no code (email_taken does)").toBeUndefined();
      expect(rawGet("SELECT COUNT(*) AS n FROM users WHERE email=? COLLATE NOCASE", [lateEmail]).n, "no account was created").toBe(0);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The pure instant
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.8 — the close instant (pure)", () => {
  test("A16 — one ms before the press, never at or before the end, and the inclusive window is shut from the press on", () => {
    // lib/late-entry.js requires only lib/event-policy — no database — so a
    // column-0 require is safe (the v7.20.2 rule is about modules that open one).
    const { lateEntryCloseInstantMs, lateEntryWindowOpen } = require("../lib/late-entry");
    const end = Date.parse("2026-09-28T16:00:00.000Z");
    expect(lateEntryCloseInstantMs(new Date(end), end + 5000)).toBe(end + 4999);
    expect(lateEntryCloseInstantMs(end, end + 1), "floored just after the end").toBe(end + 1);
    for (const [press, pin] of [[end + 5000, end + 4999], [end + 1, end + 1]]) {
      const row = { event_kind: "booth", late_entry_enabled: 1, late_entry_deadline_at: new Date(pin).toISOString() };
      expect(lateEntryWindowOpen(row, new Date(end), press), `shut AT the press (${press - end} ms after the end)`).toBe(pin === press);
      for (const n of [pin + 1, pin + 2, pin + 60_000]) {
        expect(lateEntryWindowOpen(row, new Date(end), n), `shut ${n - pin} ms after the pin`).toBe(false);
      }
    }
    // CONTROL — the boundary is real: the pin itself is still inside (inclusive).
    const row = { event_kind: "booth", late_entry_enabled: 1, late_entry_deadline_at: new Date(end + 4999).toISOString() };
    expect(lateEntryWindowOpen(row, new Date(end), end + 4999)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// .immediate() under a real external write lock
// ═══════════════════════════════════════════════════════════════════════════
//
// THE sealed-reveal-unrecorded.api.spec.js TECHNIQUE, for the reason it gives: a
// read-then-write transaction opened DEFERRED fails SQLITE_BUSY at the upgrade AT
// ONCE under a writer in another process (busy_timeout is never consulted for it),
// so an organiser's button would 500 while an operator's sqlite3 shell held the
// lock. The lock is released only once the server is SEEN parked on it (a /healthz
// probe outstanding PARK_MS — better-sqlite3's busy wait blocks the event loop),
// and the request's own access-log line proves it entered before the release.
const PARK_MS = 400;
const PARK_BOUND_MS = 10_000;
const _sleep = ms => new Promise(rs => setTimeout(rs, ms));
function healthProbe() {
  const { port } = new URL(BASE);
  const pr = { sentAt: Date.now(), settledAt: null, error: null };
  pr.done = new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", agent: false }, res => {
      res.resume();
      res.on("end", () => { pr.settledAt = Date.now(); resolve(); });
    });
    req.on("error", e => { pr.error = e; pr.settledAt = Date.now(); resolve(); });
    req.setTimeout(PARK_BOUND_MS + 15_000, () => req.destroy(new Error("healthz probe timed out")));
  });
  return pr;
}
async function withTransientLock(fn) {
  const drain = healthProbe(); await drain.done;
  if (drain.error) throw new Error(`precondition: /healthz is unreachable at ${BASE} (${drain.error.message})`);
  const Database = require("better-sqlite3");
  const lock = new Database(TEST_DB_PATH);
  let released = false;
  try {
    lock.exec("BEGIN IMMEDIATE");
    const t0 = Date.now();
    let settledAt = null;
    const p = fn().then(r => { settledAt = Date.now(); return r; }, e => { settledAt = Date.now(); throw e; });
    p.catch(() => {});
    let outcome = null, parkedProbe = null, probe = null;
    while (!outcome) {
      if (settledAt !== null) { outcome = "settled_under_lock"; break; }
      if (!probe) probe = healthProbe();
      if (probe.error) throw new Error(`precondition: a /healthz probe failed while the lock was held (${probe.error.message})`);
      if (probe.settledAt !== null) probe = null;
      else if (Date.now() - probe.sentAt >= PARK_MS) { outcome = "parked"; parkedProbe = probe; break; }
      if (Date.now() - t0 >= PARK_BOUND_MS) { outcome = "never_parked"; break; }
      await _sleep(10);
    }
    lock.exec("ROLLBACK"); released = true;
    const releasedAt = Date.now();
    if (outcome === "never_parked") throw new Error("precondition: the request neither parked on the write lock nor settled — contention was never exercised");
    const r = await p;
    if (parkedProbe) await parkedProbe.done;
    return { r, outcome, releasedAt };
  } finally {
    if (!released) { try { lock.exec("ROLLBACK"); } catch (_) {} }
    lock.close();
  }
}

test.describe("v8.12.8 — closing late entries under an external write lock", () => {
  test("A17 — the close WAITS for an external writer and then writes (.immediate()), rather than 500ing at the upgrade", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await openBooth(api, csrf);
      // Warm the competition-row cache so the pre-flight needs no read of its own.
      expect((await listRow(api, b.comp.id)).can_close_late_entries).toBe(true);
      const h = await withTransientLock(() => api.post(closeUrl(b.comp.id), { headers: H(csrf) }));
      const body = await h.r.text();
      expect(h.r.status(), `the close under a transient external lock: ${body}`).toBe(200);
      expect(JSON.parse(body).closed).toBe(true);
      expect(rawGetComp(b.comp.id).late_entry_deadline_at, "and the pin was written").toBe(JSON.parse(body).late_entry_deadline_at);
      // PRECONDITION, asserted after the arm so a fast failure reports what it got.
      expect(h.outcome, "the request waited for the lock").toBe("parked");
      const rid = h.r.headers()["x-request-id"];
      expect(rid, "the response carries its request id").toBeTruthy();
      const al = await findLogLine(path.join(TEST_DATA_DIR, "logs"), j => j.req_id === rid && typeof j.ms === "number",
        { prefix: "access-", what: `the access line for ${rid}` });
      expect(Date.parse(al.ts) - al.ms, "the request was inside the server before the release").toBeLessThan(h.releasedAt);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// After a close — reopening and extending stay a superadmin's editor save
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.8 — after a close", () => {
  test("A18 — the admin who closed it cannot reopen it; a superadmin echoing the pin is refused, naming Automatic; with the deadline set back to Automatic it revives", async () => {
    const { api, csrf } = await sa();
    const ga = await admin(api, csrf, "reopenga");
    try {
      const b = await openBooth(api, csrf);
      const c = await close(ga.api, ga.csrf, b.comp.id);
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      const row = await listRow(api, b.comp.id);
      // A regular admin may close; reopening is not theirs — it is an edit of an
      // ended event whose end has passed. The payload is the one the superadmin
      // saves successfully below, which is what makes this refusal about the TIER.
      const theirs = await ga.api.put(`/api/admin/competitions/${b.comp.id}`, {
        headers: H(ga.csrf), data: { duration_minutes: 600, late_entry_deadline_at: "", expectedUpdatedAt: row.updated_at } });
      expect(theirs.status(), await theirs.text()).toBe(403);
      expect((await theirs.json()).error).toBe("Only superadmin can edit ended events whose end time has passed");
      expect(rawGetComp(b.comp.id).late_entry_deadline_at, "the pin stands").toBe(c.body.late_entry_deadline_at);
      expect(rawGetComp(b.comp.id).ended_at, "still ended").toBeTruthy();

      const bad = await api.put(`/api/admin/competitions/${b.comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 600, late_entry_deadline_at: c.body.late_entry_deadline_at, expectedUpdatedAt: row.updated_at } });
      expect(bad.status(), await bad.text()).toBe(400);
      const bb = await bad.json();
      expect(bb.code).toBe("late_entry_deadline_invalid");
      expect(bb.error).toMatch(/automatic/i);
      expect(rawGetComp(b.comp.id).ended_at, "still ended").toBeTruthy();

      const ok = await api.put(`/api/admin/competitions/${b.comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 600, late_entry_deadline_at: "", expectedUpdatedAt: row.updated_at } });
      expect(ok.status(), await ok.text()).toBe(200);
      const ob = await ok.json();
      expect(ob.newStatus, "the event is live again").toBe("live");
      expect(rawGetComp(b.comp.id).late_entry_deadline_at, "and follows its end again").toBeNull();
    } finally { await ga.api.dispose(); await api.dispose(); }
  });

  test("A19 — the companion busts: a superadmin re-pin, a revive and End Now each reach /api/me at once", async () => {
    const { api, csrf } = await sa();
    const people = [];
    const TTL = () => _sleep(2_300);
    try {
      // (a) the PUT: a pin moved into the past closes the window.
      const a = await openBooth(api, csrf);
      const la = await lateEntrant(api, csrf, a.comp.id); people.push(la);
      const t0a = Date.now();
      expect((await meComp(la.api, a.comp.id)).late_entry_window_open, "PRECONDITION (a): warm, open").toBe(true);
      // One ms after the end: strictly after it, which the validator requires,
      // and already behind us, End Now and the late entrant's sign-in having come
      // first. No sleep, deliberately — this arm is the ONLY witness of the gate's
      // `changes.late_entry_deadline_at` clause, and the me-cache TTL runs from the
      // warm read above. A 1.2 s sleep here once left ~0.8 s for the list GET and
      // the PUT, and 850 ms of latency let a build that dropped the clause pass the
      // whole test (measured).
      const pastPin = new Date(Date.parse(a.ended.ended_at) + 1).toISOString();
      expect(Date.parse(pastPin), "PRECONDITION (a): the pin is already behind us").toBeLessThan(Date.now());
      const ra = await listRow(api, a.comp.id);
      const pa = await api.put(`/api/admin/competitions/${a.comp.id}`, { headers: H(csrf), data: { late_entry_deadline_at: pastPin, expectedUpdatedAt: ra.updated_at } });
      expect(pa.status(), await pa.text()).toBe(200);
      expect((await meComp(la.api, a.comp.id)).late_entry_window_open, "(a) at once").toBe(false);
      // A slow box must fail by NAME rather than certify a missing bust: past the
      // 2 s /api/me TTL the entry would have expired on its own, and "(a) at once"
      // would be equally true of a build that dropped the clause (the desk spec's
      // and the v8.12.7 cache arms' idiom).
      expect(Date.now() - t0a, "PRECONDITION (a): the warm read, the PUT and the re-read fit inside the 2 s /api/me TTL").toBeLessThan(1800);
      await TTL();
      expect((await meComp(la.api, a.comp.id)).late_entry_window_open, "(a) CONTROL: and after the TTL").toBe(false);

      // (b) a revive: extending an End-Now'd event reopens it for its members.
      const b = await liveBooth(api, csrf);
      const mb = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, b.comp.id, mb.id);
      const pb = await participantCtx(mb.email, b.comp.id); people.push(pb);
      await endNow(api, csrf, b.comp.id);
      expect((await meComp(pb.api, b.comp.id)).status, "PRECONDITION (b): warm, ended").toBe("ended");
      const rb = await listRow(api, b.comp.id);
      const xb = await api.put(`/api/admin/competitions/${b.comp.id}`, { headers: H(csrf), data: { duration_minutes: 600, expectedUpdatedAt: rb.updated_at } });
      expect(xb.status(), await xb.text()).toBe(200);
      expect((await xb.json()).newStatus, "PRECONDITION (b): it revived").toBe("live");
      expect((await meComp(pb.api, b.comp.id)).status, "(b) at once").toBe("live");
      await TTL();
      expect((await meComp(pb.api, b.comp.id)).status, "(b) CONTROL: and after the TTL").toBe("live");

      // (c) End Now OPENS the window and changes the status.
      const c = await liveBooth(api, csrf);
      const mc = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, c.comp.id, mc.id);
      const pc = await participantCtx(mc.email, c.comp.id); people.push(pc);
      const warm = await meComp(pc.api, c.comp.id);
      expect(warm.status, "PRECONDITION (c): warm, live").toBe("live");
      expect(warm.late_entry_window_open).toBe(false);
      await endNow(api, csrf, c.comp.id);
      const now = await meComp(pc.api, c.comp.id);
      expect(now.status, "(c) at once").toBe("ended");
      expect(now.late_entry_window_open, "(c) the window it opened").toBe(true);
      await TTL();
      const later = await meComp(pc.api, c.comp.id);
      expect([later.status, later.late_entry_window_open], "(c) CONTROL: and after the TTL").toEqual(["ended", true]);
    } finally { for (const x of people) await x.api.dispose(); await api.dispose(); }
  });
});
