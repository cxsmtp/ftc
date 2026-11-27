// @ts-check
//
// v8.12.6 — ADMITTING PEOPLE TO A BOOTH EVENT WHILE ITS LATE-ENTRY WINDOW IS OPEN.
//
// v8.6.0 opened the JOIN LINK through the window and left every admin door shut:
// an organiser at the stand could not assign, invite, desk-invite or group-bind a
// walk-up the QR code would have admitted, and could not take out somebody added by
// mistake. This file drives every door through ONE predicate
// (`competitionAdmission`, lib/competitions.js) and the two rules that keep the
// event's FINAL results final:
//
//   * nobody who took part in the event before it ended may be given a NEW row
//     through the window (`late_entry_took_part`) — measured before this release: a
//     finisher removed while live and re-admitted landed back on the main board at
//     rank 1, a second holder of one placing; and
//   * through the window only a LATE ENTRANT may be removed (`not_late_entrant` /
//     `event_ended` / `late_entrant_has_certificate`).
//
// ── EVERY POSITIVE HERE HAS A CONTROL, and the controls are the point ─────────
//
// "The assign succeeded" is equally satisfied by a build that stopped refusing
// ended events altogether — far worse than the feature not working. So every door
// is also driven at an event whose window is CLOSED, one with late entries OFF and
// a Competition (which may never run a window), and each must still refuse with the
// message it always had. Every refusal has the mirror-image control: somebody the
// same door must still admit or remove.
//
// ── THE FIXTURE TRAP (tests/late-entry-fixture.js states it in full) ─────────
//
// Events are built LIVE and then ended by moving their start into the past, which
// re-times everything a fixture did while live to AFTER the new end. A test whose
// subject is "they were in the event before it ended" back-dates those facts
// explicitly; one that forgets turns its ordinary member into a late entrant and
// the assertion measures the wrong person.
const { test, expect } = require("./isolated-test");
const { freshCtx } = require("./helpers");
const {
  H, uniq, MIN, outliveCompCache, outliveParticipantsCache,
  sa, makeParticipant, rawUpdateComp, rawGetComp, rawSetAssignedAt, liveBooth, enrol,
  expireEvent, participantCtx, submit, rawBackdate, rawGet, rawAll, rawRun,
} = require("./late-entry-fixture");

// ─── local helpers ───────────────────────────────────────────────────────────

async function assign(api, csrf, data) {
  const r = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data });
  let body = {};
  try { body = await r.json(); } catch (_) { /* a non-JSON body is asserted on status */ }
  return { status: r.status(), body };
}

function cuRow(compId, userId) {
  return rawGet("SELECT * FROM competition_users WHERE competition_id=? AND user_id=?", [compId, userId]);
}

function absenceRows(compId, userId) {
  return rawAll("SELECT * FROM competition_user_absences WHERE competition_id=? AND user_id=? ORDER BY removed_at", [compId, userId]);
}

function eventDetails(table, keyCol, keyVal, type) {
  return rawAll(`SELECT details FROM ${table} WHERE ${keyCol}=? AND event_type=? ORDER BY rowid`, [keyVal, type])
    .map(r => { try { return JSON.parse(r.details || "{}"); } catch (_) { return {}; } });
}

/** An ended Booth Event whose late window is OPEN (ended 30 minutes ago). */
async function openBooth(api, csrf, opts = {}) {
  const b = await liveBooth(api, csrf, opts);
  const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
  return { ...b, effEnd };
}

/** An ended Booth Event whose late window has CLOSED (ended 49 hours ago). */
async function closedBooth(api, csrf, opts = {}) {
  const b = await liveBooth(api, csrf, opts);
  const effEnd = await expireEvent(b.comp.id, { agoMinutes: 49 * 60 });
  return { ...b, effEnd };
}

/** A Booth Event with late entries OFF, ended 30 minutes ago. */
async function offBooth(api, csrf) {
  const b = await liveBooth(api, csrf, { create: { late_entry_enabled: false } });
  await expireEvent(b.comp.id, { agoMinutes: 30 });
  return b;
}

/**
 * A Competition whose `late_entry_enabled` column is forced ON by a raw write — the
 * policy PROHIBITS a window for the kind, so the column must change nothing.
 */
async function forcedTournament(api, csrf) {
  const b = await liveBooth(api, csrf, { kind: "tournament" });
  rawUpdateComp(b.comp.id, "late_entry_enabled=1");
  await expireEvent(b.comp.id, { agoMinutes: 30 });
  return b;
}

async function lateStatus(email, compId) {
  const c = await participantCtx(email, compId);
  try { return (await (await c.api.get("/api/status")).json()).late_entry; }
  finally { await c.api.dispose(); }
}

async function adminBoard(api, compId) {
  const r = await api.get(`/api/admin/leaderboard?competitionId=${compId}`);
  expect(r.ok(), `admin board: ${r.status()}`).toBeTruthy();
  return r.json();
}

/** The MAIN section of the admin board, in a form that compares byte for byte. */
function mainSection(board) {
  return JSON.stringify(board.filter(r => !r.isLateEntrant).map(r => [r.nickname, r.score, r.rank, !!r.allSolved]));
}

async function selfEnrollToken(api, compId) {
  const r = await api.get(`/api/admin/competitions/${compId}/self-enroll`);
  expect(r.ok(), `self-enroll reveal: ${r.status()}`).toBeTruthy();
  return (await r.json()).token;
}

async function joinAs(email, token) {
  const c = await participantCtx(email, null);
  try {
    const r = await c.api.post("/api/competitions/join", { headers: H(c.csrf), data: { token } });
    let body = {};
    try { body = await r.json(); } catch (_) { /* status is asserted */ }
    return { status: r.status(), body };
  } finally { await c.api.dispose(); }
}

async function makeGroup(api, csrf, userIds = []) {
  const r = await api.post("/api/admin/groups", { headers: H(csrf), data: { name: `LEG ${uniq()}`, userIds } });
  expect(r.ok(), `create group: ${await r.text()}`).toBeTruthy();
  return (await r.json()).group.id;
}

async function removeFromEvent(api, csrf, compId, userId) {
  const r = await api.delete(`/api/admin/competitions/${compId}/users/${userId}`, { headers: H(csrf) });
  let body = {};
  try { body = await r.json(); } catch (_) { /* status is asserted */ }
  return { status: r.status(), body };
}

const SCHEDULE_PASSED = (name) => `Cannot assign participants to ended event "${name}". Its scheduled time has passed.`;

// ═══════════════════════════════════════════════════════════════════════════
// The assign door
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — the assign door admits through an open late-entry window", () => {
  test("A1 — an OPEN window admits a late entrant, and the event itself does not move; CLOSED / OFF / Competition still refuse", async () => {
    const { api, csrf } = await sa();
    try {
      const open = await openBooth(api, csrf, { tasks: 1 });
      const ordinary = await makeParticipant(api, csrf, uniq());
      // `ordinary` was enrolled while LIVE — the enrol happened before the expire,
      // so its row is re-timed (the fixture trap) and is back-dated to an hour
      // before the end so it is really an ordinary member of the event.
      // (Built on a second live booth so its enrolment can precede the expiry.)
      const openB = await liveBooth(api, csrf, { tasks: 1 });
      await enrol(api, csrf, openB.comp.id, ordinary.id);
      const effEndB = await expireEvent(openB.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(openB.comp.id, ordinary.id, new Date(effEndB.getTime() - 60 * MIN).toISOString());

      const before = rawGetComp(open.comp.id);
      const n = await makeParticipant(api, csrf, uniq());
      const a = await assign(api, csrf, { userIds: [n.id], competitionIds: [open.comp.id] });
      expect(a.status, `assign through the window: ${JSON.stringify(a.body)}`).toBe(200);
      expect(a.body.assigned, "one new membership").toBe(1);
      expect(a.body.lateEntryCompetitionIds, "and the response names the event as admitted late").toEqual([open.comp.id]);
      expect(a.body.revived, "the window extends PLAY, never the event").toEqual([]);

      // The event row is exactly as it was: not revived, not re-stamped.
      await outliveCompCache();
      const after = rawGetComp(open.comp.id);
      expect(after.ended_at, "ended_at untouched").toBe(before.ended_at);
      expect(after.ended_manually, "ended_manually untouched").toBe(before.ended_manually);
      expect(after.updated_at, "updated_at untouched").toBe(before.updated_at);
      const wire = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === open.comp.id);
      expect(wire.status, "and it still reads ended").toBe("ended");

      // The new member is a late entrant and PLAYS.
      const st = await lateStatus(n.email, open.comp.id);
      expect(st.window_open && st.is_late_entrant, `the new member is a late entrant: ${JSON.stringify(st)}`).toBeTruthy();
      const c = await participantCtx(n.email, open.comp.id);
      try {
        const sub = await submit(c.api, c.csrf, open.taskIds[0]);
        expect(sub.status(), `a late entrant may submit: ${await sub.text()}`).toBe(200);
      } finally { await c.api.dispose(); }
      const board = await adminBoard(api, open.comp.id);
      const nRow = board.find(r => r.nickname === n.nickname);
      expect(nRow && nRow.isLateEntrant, "and they are ranked in the late section").toBeTruthy();

      // CONTROL — an ordinary member of an ended event still cannot play.
      const oc = await participantCtx(ordinary.email, openB.comp.id);
      try {
        const sub = await submit(oc.api, oc.csrf, openB.taskIds[0]);
        expect(sub.status(), "an ordinary member of an ended event still cannot submit").toBe(403);
      } finally { await oc.api.dispose(); }

      // CONTROLS — the three shapes that take nobody, each with today's message.
      const closed = await closedBooth(api, csrf);
      const off = await offBooth(api, csrf);
      const tourn = await forcedTournament(api, csrf);
      for (const [label, ev] of [["CLOSED", closed], ["OFF", off], ["Competition", tourn]]) {
        const m = await makeParticipant(api, csrf, uniq());
        const r = await assign(api, csrf, { userIds: [m.id], competitionIds: [ev.comp.id] });
        expect(r.status, `${label}: still refused`).toBe(400);
        expect(r.body.error, `${label}: with the message it always had`).toBe(SCHEDULE_PASSED(ev.comp.name));
        expect(cuRow(ev.comp.id, m.id), `${label}: no row written`).toBeFalsy();
      }
    } finally { await api.dispose(); }
  });

  test("A2 — End Now opens the window too, and the manual end stays recorded; a Competition ended by hand still refuses", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const en = await api.post(`/api/admin/competitions/${b.comp.id}/end-now`, { headers: H(csrf), data: {} });
      expect(en.ok(), `end now: ${await en.text()}`).toBeTruthy();
      await outliveCompCache();
      const n = await makeParticipant(api, csrf, uniq());
      const a = await assign(api, csrf, { userIds: [n.id], competitionIds: [b.comp.id] });
      expect(a.status, `assign after End Now: ${JSON.stringify(a.body)}`).toBe(200);
      expect(a.body.assigned).toBe(1);
      expect(rawGetComp(b.comp.id).ended_manually, "still ended by hand").toBe(1);

      // CONTROL — a Competition runs no window, so a manual end still refuses.
      const t = await liveBooth(api, csrf, { kind: "tournament" });
      const tn = await api.post(`/api/admin/competitions/${t.comp.id}/end-now`, { headers: H(csrf), data: {} });
      expect(tn.ok(), await tn.text()).toBeTruthy();
      await outliveCompCache();
      const m = await makeParticipant(api, csrf, uniq());
      const r = await assign(api, csrf, { userIds: [m.id], competitionIds: [t.comp.id] });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(`Cannot assign participants to ended event "${t.comp.name}". It was ended manually by an admin.`);
    } finally { await api.dispose(); }
  });

  test("A3 — a multi-event request: [live, OPEN] admits both; [OPEN, CLOSED] refuses and writes neither", async () => {
    const { api, csrf } = await sa();
    try {
      const live = await liveBooth(api, csrf);
      const open = await openBooth(api, csrf);
      const closed = await closedBooth(api, csrf);
      const n = await makeParticipant(api, csrf, uniq());
      const ok = await assign(api, csrf, { userIds: [n.id], competitionIds: [live.comp.id, open.comp.id] });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.assigned, "one row per event").toBe(2);
      expect(ok.body.lateEntryCompetitionIds, "only the ended one is named as late").toEqual([open.comp.id]);

      const m = await makeParticipant(api, csrf, uniq());
      const bad = await assign(api, csrf, { userIds: [m.id], competitionIds: [open.comp.id, closed.comp.id] });
      expect(bad.status, "the closed event refuses the whole request").toBe(400);
      expect(cuRow(open.comp.id, m.id), "and nothing was written to the open one either").toBeFalsy();
      expect(cuRow(closed.comp.id, m.id)).toBeFalsy();
    } finally { await api.dispose(); }
  });

  test("A4 — a HELD row is a true no-op through the window: not promoted to direct, join time untouched", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const o = await makeParticipant(api, csrf, uniq());
      // `o` is a GROUP-origin member (direct_assigned=0) — the shape a promotion
      // would change. Bound while live.
      const g = await makeGroup(api, csrf, [o.id]);
      const bind = await assign(api, csrf, { groupIds: [g], competitionIds: [b.comp.id] });
      expect(bind.status, JSON.stringify(bind.body)).toBe(200);
      expect(cuRow(b.comp.id, o.id)?.direct_assigned, "PRECONDITION: a group-origin row").toBe(0);
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(b.comp.id, o.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      const heldBefore = cuRow(b.comp.id, o.id);

      const a = await assign(api, csrf, { userIds: [o.id], competitionIds: [b.comp.id] });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.assigned, "nothing new").toBe(0);
      const heldAfter = cuRow(b.comp.id, o.id);
      expect(heldAfter.direct_assigned, "NOT promoted to a direct assignment").toBe(0);
      expect(heldAfter.assigned_at, "join time untouched").toBe(heldBefore.assigned_at);
      expect((await lateStatus(o.email, b.comp.id)).is_late_entrant, "still an ordinary member").toBeFalsy();
    } finally { await api.dispose(); }
  });

  // v8.12.6 (review) — A4's no-op protects the ORIGINAL members (the team-board
  // reason). It must not swallow an explicit direct assignment of somebody who is
  // themselves a LATE ENTRANT: they are off the team board by construction, and
  // without the promotion leaving the group took them out of the event. Both doors
  // that promote — the assign route and the join link — and A4's original member
  // as the in-test CONTROL, since "the late entrant was promoted" is equally
  // satisfied by a build that promotes everybody.
  test("A4b — a group-added LATE entrant IS promoted by a direct assign (or their own join) and stays when they leave the group; an original member is not", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const o = await makeParticipant(api, csrf, uniq());
      const g = await makeGroup(api, csrf, [o.id]);
      expect((await assign(api, csrf, { groupIds: [g], competitionIds: [b.comp.id] })).status).toBe(200);
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(b.comp.id, o.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());

      // Two walk-ups added to the bound group in the window: group-origin late entrants.
      const w = await makeParticipant(api, csrf, uniq());
      const q = await makeParticipant(api, csrf, uniq());
      for (const u of [w, q]) {
        const add = await api.post(`/api/admin/groups/${g}/members`, { headers: H(csrf), data: { userIds: [u.id] } });
        expect(add.ok(), await add.text()).toBeTruthy();
        expect(cuRow(b.comp.id, u.id)?.direct_assigned, "PRECONDITION: a group-origin row").toBe(0);
        expect((await lateStatus(u.email, b.comp.id)).is_late_entrant, "PRECONDITION: a late entrant").toBeTruthy();
      }

      // The admin assigns W directly.
      const a = await assign(api, csrf, { userIds: [w.id, o.id], competitionIds: [b.comp.id] });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.assigned, "nothing new — both already hold rows").toBe(0);
      expect(cuRow(b.comp.id, w.id).direct_assigned, "the late entrant is promoted to a direct assignment").toBe(1);
      const promo = eventDetails("competition_events", "competition_id", b.comp.id, "membership_promoted").filter(d => d.user_id === w.id);
      expect(promo.length, "…and the promotion is on the event's History").toBe(1);
      expect(promo[0].late_entry, "…marked as made through the window").toBe(true);
      // CONTROL — the original member's re-assign is still the true no-op.
      expect(cuRow(b.comp.id, o.id).direct_assigned, "the ORIGINAL member is NOT promoted").toBe(0);
      expect(eventDetails("competition_events", "competition_id", b.comp.id, "membership_promoted").filter(d => d.user_id === o.id), "…and nothing is recorded for them").toEqual([]);

      // Q joins through the link themselves: the same promotion.
      const token = await selfEnrollToken(api, b.comp.id);
      const j = await joinAs(q.email, token);
      expect(j.status, JSON.stringify(j.body)).toBe(200);
      expect(j.body.alreadyMember, "a member already").toBe(true);
      expect(cuRow(b.comp.id, q.id).direct_assigned, "their own join promotes them too").toBe(1);

      // Leaving the group no longer takes either of them out of the event.
      for (const u of [w, q]) {
        const r = await api.delete(`/api/admin/groups/${g}/members/${u.id}`, { headers: H(csrf) });
        expect(r.ok(), await r.text()).toBeTruthy();
        expect(cuRow(b.comp.id, u.id), "a directly-assigned late entrant stays when they leave the group").toBeTruthy();
      }
    } finally { await api.dispose(); }
  });

  test("a LEGACY auto-ended Booth Event whose schedule is still running keeps its REVIVE path ahead of the late window", async () => {
    // The v8.0.0 shape v8.3.11 keeps revivable: `ended_at` stamped by the old
    // all-solved auto-end (not by hand), the scheduled end still ahead. It is
    // ALSO inside a late-entry window (the window follows the effective end, which
    // is `ended_at`) — so the order the assign door asks the two questions in
    // decides what happens, and the answer is: revive, exactly as before.
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      rawUpdateComp(b.comp.id, "ended_at=?, ended_manually=0", [new Date(Date.now() - 2 * MIN).toISOString()]);
      await outliveCompCache();
      const n = await makeParticipant(api, csrf, uniq());
      const a = await assign(api, csrf, { userIds: [n.id], competitionIds: [b.comp.id] });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.revived, "revived, as a legacy booth always was").toContain(b.comp.name);
      expect(a.body.lateEntryCompetitionIds, "and NOT admitted as a late entry").toBeUndefined();
      expect(rawGetComp(b.comp.id).ended_at, "the auto-end is cleared").toBeNull();
    } finally { await api.dispose(); }
  });

  test("A6 — the staff rule still applies through the window", async () => {
    const { api, csrf } = await sa();
    try {
      const open = await openBooth(api, csrf);
      const s = await makeParticipant(api, csrf, uniq());
      const tag = await api.post(`/api/admin/participants/${s.id}/tags`, { headers: H(csrf), data: { tag: "staff" } });
      expect(tag.ok(), await tag.text()).toBeTruthy();
      const a = await assign(api, csrf, { userIds: [s.id], competitionIds: [open.comp.id] });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.skippedStaff, "a staff member is a spectator here, as on any non-compete event").toBe(1);
      expect(cuRow(open.comp.id, s.id)).toBeFalsy();
    } finally { await api.dispose(); }
  });

  test("A16 — an event admin who organises the event may assign through its window; one who does not is refused on scope", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const other = await liveBooth(api, csrf);
      const ea = await makeParticipant(api, csrf, uniq());
      const ea2 = await makeParticipant(api, csrf, uniq());
      const g1 = await api.post(`/api/admin/competitions/${b.comp.id}/admins`, { headers: H(csrf), data: { userId: ea.id } });
      expect(g1.ok(), await g1.text()).toBeTruthy();
      const g2 = await api.post(`/api/admin/competitions/${other.comp.id}/admins`, { headers: H(csrf), data: { userId: ea2.id } });
      expect(g2.ok(), await g2.text()).toBeTruthy();
      await expireEvent(b.comp.id, { agoMinutes: 30 });
      const n = await makeParticipant(api, csrf, uniq());

      const own = await participantCtx(ea.email, null);
      try {
        const r = await own.api.post("/api/admin/competitions/assign", { headers: H(own.csrf), data: { userIds: [n.id], competitionIds: [b.comp.id] } });
        expect(r.status(), `the organiser assigns through the window: ${await r.text()}`).toBe(200);
      } finally { await own.api.dispose(); }
      expect(cuRow(b.comp.id, n.id), "the row landed").toBeTruthy();

      const m = await makeParticipant(api, csrf, uniq());
      const foreign = await participantCtx(ea2.email, null);
      try {
        const r = await foreign.api.post("/api/admin/competitions/assign", { headers: H(foreign.csrf), data: { userIds: [m.id], competitionIds: [b.comp.id] } });
        expect(r.status(), "another organiser is refused").toBe(403);
        expect((await r.json()).code).toBe("event_admin_out_of_scope");
      } finally { await foreign.api.dispose(); }
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Took part before the end → no new row through the window
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — somebody who played the event cannot rejoin it as a late entrant", () => {
  test("A5 — a finisher removed while live: skipped at the assign door, refused at the join link, not enrolled by a group; a fresh walk-up gets in", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const token = await selfEnrollToken(api, b.comp.id);
      const f = await makeParticipant(api, csrf, uniq());
      const main = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, b.comp.id, f.id);
      await enrol(api, csrf, b.comp.id, main.id);
      for (const p of [f, main]) {
        const c = await participantCtx(p.email, b.comp.id);
        try { expect((await (await submit(c.api, c.csrf, b.taskIds[0])).json()).correct).toBeTruthy(); }
        finally { await c.api.dispose(); }
      }
      const rm = await removeFromEvent(api, csrf, b.comp.id, f.id);
      expect(rm.status, `remove the finisher while live: ${JSON.stringify(rm.body)}`).toBe(200);
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      // The finisher's solve is on record BEFORE the end.
      rawBackdate("submissions", "submitted_at", b.comp.id, f.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
      rawBackdate("submissions", "submitted_at", b.comp.id, main.id, new Date(effEnd.getTime() - 21 * MIN).toISOString());
      rawSetAssignedAt(b.comp.id, main.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      const boardBefore = mainSection(await adminBoard(api, b.comp.id));

      const n = await makeParticipant(api, csrf, uniq());
      const a = await assign(api, csrf, { userIds: [f.id, n.id], competitionIds: [b.comp.id] });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.assigned, "the fresh walk-up is admitted").toBe(1);
      expect(a.body.skippedTookPart, "the finisher is skipped and counted").toBe(1);
      expect(cuRow(b.comp.id, f.id), "no row for the finisher").toBeFalsy();
      expect(mainSection(await adminBoard(api, b.comp.id)), "the FINAL board is exactly as it was").toBe(boardBefore);

      // The invitation door (an existing account) skips them the same way.
      const inv = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [f.email], competitionIds: [b.comp.id] } });
      expect(inv.ok(), await inv.text()).toBeTruthy();
      const invBody = await inv.json();
      expect(invBody.skippedTookPart, "the invitation door counts the skip").toBe(1);
      expect(invBody.alreadyAssigned || [], "and does not also call them already assigned").not.toContain(f.email);
      expect(cuRow(b.comp.id, f.id), "no row from the invitation either").toBeFalsy();

      // The join link, in the person's own words.
      const j = await joinAs(f.email, token);
      expect(j.status, `the join link refuses them too: ${JSON.stringify(j.body)}`).toBe(409);
      expect(j.body.code).toBe("late_entry_took_part");
      expect(j.body.error, "worded to the person themselves").toMatch(/^You took part in/);

      // A group live-sync skips them silently.
      const g = await makeGroup(api, csrf, [f.id]);
      const bind = await assign(api, csrf, { groupIds: [g], competitionIds: [b.comp.id] });
      expect(bind.status, JSON.stringify(bind.body)).toBe(200);
      expect(cuRow(b.comp.id, f.id), "a bound group does not enrol them either").toBeFalsy();

      // CONTROL — a fresh walk-up through the same link gets in.
      const w = await makeParticipant(api, csrf, uniq());
      const jw = await joinAs(w.email, token);
      expect(jw.status, JSON.stringify(jw.body)).toBe(200);
      expect(jw.body.alreadyMember).toBe(false);
    } finally { await api.dispose(); }
  });

  test("A5b — somebody who answered WRONG and then LEFT while live is refused too", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const token = await selfEnrollToken(api, b.comp.id);
      const w = await makeParticipant(api, csrf, uniq());
      expect((await joinAs(w.email, token)).status).toBe(200);
      const c = await participantCtx(w.email, b.comp.id);
      try {
        const sub = await submit(c.api, c.csrf, b.taskIds[0], "wrong");
        expect((await sub.json()).correct, "a wrong answer").toBeFalsy();
        const leave = await c.api.post(`/api/competitions/${b.comp.id}/leave`, { headers: H(c.csrf) });
        expect(leave.ok(), `leave while live: ${await leave.text()}`).toBeTruthy();
      } finally { await c.api.dispose(); }
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawBackdate("submissions", "submitted_at", b.comp.id, w.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
      const j = await joinAs(w.email, token);
      expect(j.status, JSON.stringify(j.body)).toBe(409);
      expect(j.body.code).toBe("late_entry_took_part");
    } finally { await api.dispose(); }
  });

  test("the ABSENCE clause: entered and was removed before the end with nothing on record → refused; a late entrant removed in the window → re-admitted", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const token = await selfEnrollToken(api, b.comp.id);
      const x = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, b.comp.id, x.id);
      // x ENTERS (login_time) and does nothing else, then is removed while live.
      const c = await participantCtx(x.email, b.comp.id);
      await c.api.dispose();
      expect(cuRow(b.comp.id, x.id).login_time, "PRECONDITION: x entered the event").toBeTruthy();
      const rm = await removeFromEvent(api, csrf, b.comp.id, x.id);
      expect(rm.status, JSON.stringify(rm.body)).toBe(200);
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      // The fixture trap: the recorded anchor is re-timed too; put it before the end.
      rawBackdate("competition_user_absences", "login_time", b.comp.id, x.id, new Date(effEnd.getTime() - 40 * MIN).toISOString());
      expect(rawGet("SELECT COUNT(*) AS n FROM submissions WHERE competition_id=? AND user_id=?", [b.comp.id, x.id]).n,
        "PRECONDITION: nothing on record but the entry").toBe(0);

      const j = await joinAs(x.email, token);
      expect(j.status, `entered before the end → refused: ${JSON.stringify(j.body)}`).toBe(409);
      expect(j.body.code).toBe("late_entry_took_part");

      // CONTROL — a late entrant (joined and entered in the window) removed and then
      // rejoining is admitted: their anchor is after the end, so nothing of theirs is
      // at or before it.
      const y = await makeParticipant(api, csrf, uniq());
      expect((await joinAs(y.email, token)).status).toBe(200);
      const yc = await participantCtx(y.email, b.comp.id);
      await yc.api.dispose();
      const rmy = await removeFromEvent(api, csrf, b.comp.id, y.id);
      expect(rmy.status, `a late entrant may be removed in the window: ${JSON.stringify(rmy.body)}`).toBe(200);
      const jy = await joinAs(y.email, token);
      expect(jy.status, `and may rejoin: ${JSON.stringify(jy.body)}`).toBe(200);
    } finally { await api.dispose(); }
  });

  test("assigned_at survives a remove-and-re-add, so a re-add never turns an ordinary member whose join time was recorded into a late entrant", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 2 });
      const plannedEnd = new Date(Date.now() - 30 * MIN);
      const j = await makeParticipant(api, csrf, uniq());
      const k = await makeParticipant(api, csrf, uniq());
      for (const p of [j, k]) {
        await enrol(api, csrf, b.comp.id, p.id);
        const c = await participantCtx(p.email, b.comp.id);
        try { expect((await (await submit(c.api, c.csrf, b.taskIds[0])).json()).correct).toBeTruthy(); }
        finally { await c.api.dispose(); }
        const rm = await removeFromEvent(api, csrf, b.comp.id, p.id);
        expect(rm.status, JSON.stringify(rm.body)).toBe(200);
      }
      // j joined an hour before the (planned) end; the absence row carries that.
      rawBackdate("competition_user_absences", "assigned_at", b.comp.id, j.id, new Date(plannedEnd.getTime() - 60 * MIN).toISOString());
      // k's absence row is a LEGACY one (no join time recorded) — restores nothing.
      rawRun("UPDATE competition_user_absences SET assigned_at=NULL WHERE competition_id=? AND user_id=?", [b.comp.id, k.id]);
      // Both re-added while the event is still LIVE.
      for (const p of [j, k]) {
        const a = await assign(api, csrf, { userIds: [p.id], competitionIds: [b.comp.id] });
        expect(a.body.assigned, `re-add ${p.nickname}: ${JSON.stringify(a.body)}`).toBe(1);
      }
      expect(cuRow(b.comp.id, j.id).assigned_at, "the ORIGINAL join time is restored")
        .toBe(new Date(plannedEnd.getTime() - 60 * MIN).toISOString());
      await expireEvent(b.comp.id, { endAt: plannedEnd.toISOString() });

      const sj = await lateStatus(j.email, b.comp.id);
      expect(sj.is_late_entrant, `j keeps being an ordinary member: ${JSON.stringify(sj)}`).toBeFalsy();
      const jc = await participantCtx(j.email, b.comp.id);
      try { expect((await submit(jc.api, jc.csrf, b.taskIds[1])).status(), "so j cannot play on").toBe(403); }
      finally { await jc.api.dispose(); }
      // CONTROL — with no join time recorded the re-add is a fresh join, so k (whose
      // re-add now post-dates the end) classifies late: the restore is what differs.
      const sk = await lateStatus(k.email, b.comp.id);
      expect(sk.is_late_entrant, `a legacy absence restores nothing: ${JSON.stringify(sk)}`).toBeTruthy();
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Groups
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — group binds and live sync through the window", () => {
  test("A7 — a bind enrols late entrants; a group bound while live admits a member added in the window; CLOSED binds nothing", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const pre = await makeParticipant(api, csrf, uniq());
      const g2 = await makeGroup(api, csrf, [pre.id]);
      const bindLive = await assign(api, csrf, { groupIds: [g2], competitionIds: [b.comp.id] });
      expect(bindLive.status, JSON.stringify(bindLive.body)).toBe(200);
      await expireEvent(b.comp.id, { agoMinutes: 30 });

      const m1 = await makeParticipant(api, csrf, uniq());
      const g = await makeGroup(api, csrf, [m1.id]);
      const bind = await assign(api, csrf, { groupIds: [g], competitionIds: [b.comp.id] });
      expect(bind.status, JSON.stringify(bind.body)).toBe(200);
      expect(bind.body.groupsBound, "the bind landed").toBe(1);
      expect(cuRow(b.comp.id, m1.id), "its member is enrolled").toBeTruthy();
      expect((await lateStatus(m1.email, b.comp.id)).is_late_entrant, "as a late entrant").toBeTruthy();

      const m2 = await makeParticipant(api, csrf, uniq());
      const add = await api.post(`/api/admin/groups/${g2}/members`, { headers: H(csrf), data: { userIds: [m2.id] } });
      expect(add.ok(), await add.text()).toBeTruthy();
      expect(cuRow(b.comp.id, m2.id), "live sync admits a member added in the window").toBeTruthy();

      // CONTROLS
      const closed = await closedBooth(api, csrf);
      const m3 = await makeParticipant(api, csrf, uniq());
      const g3 = await makeGroup(api, csrf, [m3.id]);
      const cb = await assign(api, csrf, { groupIds: [g3], competitionIds: [closed.comp.id] });
      expect(cb.status, "a closed window refuses the bind").toBe(400);
      expect(rawGet("SELECT COUNT(*) AS n FROM competition_groups WHERE competition_id=?", [closed.comp.id]).n, "and binds nothing").toBe(0);

      // A group bound while live to an event whose window then CLOSED admits nobody.
      const c2 = await liveBooth(api, csrf);
      const g4 = await makeGroup(api, csrf, []);
      const seed = await makeParticipant(api, csrf, uniq());
      await api.post(`/api/admin/groups/${g4}/members`, { headers: H(csrf), data: { userIds: [seed.id] } });
      expect((await assign(api, csrf, { groupIds: [g4], competitionIds: [c2.comp.id] })).status).toBe(200);
      await expireEvent(c2.comp.id, { agoMinutes: 49 * 60 });
      const m4 = await makeParticipant(api, csrf, uniq());
      await api.post(`/api/admin/groups/${g4}/members`, { headers: H(csrf), data: { userIds: [m4.id] } });
      expect(cuRow(c2.comp.id, m4.id), "a closed window admits nobody through live sync").toBeFalsy();
    } finally { await api.dispose(); }
  });

  test("A8 — the group → Events list offers an open-window event, labelled, and omits a closed one", async () => {
    const { api, csrf } = await sa();
    try {
      const open = await openBooth(api, csrf);
      const closed = await closedBooth(api, csrf);
      const g = await makeGroup(api, csrf, []);
      const r = await api.get(`/api/admin/groups/${g}/competitions`);
      expect(r.ok()).toBeTruthy();
      const list = (await r.json()).competitions;
      const o = list.find(c => c.id === open.comp.id);
      expect(o, "the open-window event is listed").toBeTruthy();
      expect(o.late_entry_window_open, "and marked").toBe(true);
      expect(o.status).toBe("ended");
      expect(typeof o.late_entry_deadline_effective, "with its deadline").toBe("string");
      expect(list.find(c => c.id === closed.comp.id), "a closed one is not").toBeFalsy();
      // CONTROL — a live event is still listed and not marked.
      const live = await liveBooth(api, csrf);
      const l = (await (await api.get(`/api/admin/groups/${g}/competitions`)).json()).competitions.find(c => c.id === live.comp.id);
      expect(l && l.late_entry_window_open, "a live event is listed, unmarked").toBe(false);
    } finally { await api.dispose(); }
  });

  test("A9 — leaving the group in the window takes out a group-only LATE ENTRANT and KEEPS an ordinary member; the same split on unbind", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const o = await makeParticipant(api, csrf, uniq());
      const o2 = await makeParticipant(api, csrf, uniq());
      const g = await makeGroup(api, csrf, [o.id]);
      const g2 = await makeGroup(api, csrf, [o2.id]);
      expect((await assign(api, csrf, { groupIds: [g, g2], competitionIds: [b.comp.id] })).status).toBe(200);
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(b.comp.id, o.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      rawSetAssignedAt(b.comp.id, o2.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());

      const la = await makeParticipant(api, csrf, uniq());
      const la2 = await makeParticipant(api, csrf, uniq());
      expect((await api.post(`/api/admin/groups/${g}/members`, { headers: H(csrf), data: { userIds: [la.id] } })).ok()).toBeTruthy();
      expect((await api.post(`/api/admin/groups/${g2}/members`, { headers: H(csrf), data: { userIds: [la2.id] } })).ok()).toBeTruthy();
      expect(cuRow(b.comp.id, la.id) && cuRow(b.comp.id, la2.id), "PRECONDITION: both late entrants enrolled").toBeTruthy();

      for (const uid of [la.id, o.id]) {
        const r = await api.delete(`/api/admin/groups/${g}/members/${uid}`, { headers: H(csrf) });
        expect(r.ok(), await r.text()).toBeTruthy();
      }
      expect(cuRow(b.comp.id, la.id), "the group-only late entrant is taken out").toBeFalsy();
      expect(cuRow(b.comp.id, o.id), "the ordinary member is KEPT").toBeTruthy();

      const ub = await api.delete(`/api/admin/competitions/${b.comp.id}/groups/${g2}`, { headers: H(csrf) });
      expect(ub.ok(), await ub.text()).toBeTruthy();
      expect(cuRow(b.comp.id, la2.id), "unbind: the late entrant leaves").toBeFalsy();
      expect(cuRow(b.comp.id, o2.id), "unbind: the ordinary member stays").toBeTruthy();
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invitations and the desk
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — invitations and the desk through the window", () => {
  test("A10 — an invitation carries an open-window event; an existing account is added late; CLOSED is dropped; an event admin is admitted on their open event and refused on a closed one", async () => {
    const { api, csrf } = await sa();
    try {
      const open = await openBooth(api, csrf);
      const closed = await closedBooth(api, csrf);
      const newAddr = `${uniq()}@company.example`;
      const inv = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [newAddr], competitionIds: [open.comp.id] } });
      expect(inv.ok(), await inv.text()).toBeTruthy();
      const invBody = await inv.json();
      expect(invBody.lateEntryCompetitionIds).toEqual([open.comp.id]);
      const row = rawGet("SELECT competition_ids FROM invitations WHERE LOWER(email)=LOWER(?) ORDER BY rowid DESC LIMIT 1", [newAddr]);
      expect(JSON.parse(row.competition_ids), "the stored invitation names the open event").toEqual([open.comp.id]);

      const ex = await makeParticipant(api, csrf, uniq());
      const inv2 = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [ex.email], competitionIds: [open.comp.id] } });
      expect(inv2.ok(), await inv2.text()).toBeTruthy();
      expect((await inv2.json()).assigned, "the existing account is enrolled").toBe(1);
      expect((await lateStatus(ex.email, open.comp.id)).is_late_entrant, "as a late entrant").toBeTruthy();

      // CONTROL — a closed window is dropped, exactly as an ended event always was.
      const newAddr2 = `${uniq()}@company.example`;
      const inv3 = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [newAddr2], competitionIds: [closed.comp.id] } });
      expect(inv3.ok(), await inv3.text()).toBeTruthy();
      const row3 = rawGet("SELECT competition_ids FROM invitations WHERE LOWER(email)=LOWER(?) ORDER BY rowid DESC LIMIT 1", [newAddr2]);
      expect(JSON.parse(row3.competition_ids), "a closed event is not stored").toEqual([]);

      // The event-admin door. Granted while live, then the events end.
      const lb = await liveBooth(api, csrf);
      const lc = await liveBooth(api, csrf);
      const ea = await makeParticipant(api, csrf, uniq());
      for (const ev of [lb, lc]) {
        const g = await api.post(`/api/admin/competitions/${ev.comp.id}/admins`, { headers: H(csrf), data: { userId: ea.id } });
        expect(g.ok(), await g.text()).toBeTruthy();
      }
      await expireEvent(lb.comp.id, { agoMinutes: 30 });
      await expireEvent(lc.comp.id, { agoMinutes: 49 * 60 });
      const eac = await participantCtx(ea.email, null);
      try {
        const ok = await eac.api.post("/api/admin/invitations", { headers: H(eac.csrf), data: { emails: [`${uniq()}@company.example`], competitionIds: [lb.comp.id] } });
        expect(ok.status(), `their open-window event: ${await ok.text()}`).toBe(200);
        const no = await eac.api.post("/api/admin/invitations", { headers: H(eac.csrf), data: { emails: [`${uniq()}@company.example`], competitionIds: [lc.comp.id] } });
        expect(no.status(), "their closed event").toBe(400);
        expect((await no.json()).code).toBe("event_admin_competition_required");
      } finally { await eac.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("A11 — a late entrant removed in the window and re-invited gets their anchor and join time back", async () => {
    const { api, csrf } = await sa();
    try {
      const open = await openBooth(api, csrf, { tasks: 1 });
      const l = await makeParticipant(api, csrf, uniq());
      expect((await assign(api, csrf, { userIds: [l.id], competitionIds: [open.comp.id] })).body.assigned).toBe(1);
      const c = await participantCtx(l.email, open.comp.id);
      try { expect((await (await submit(c.api, c.csrf, open.taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await c.api.dispose(); }
      const orig = cuRow(open.comp.id, l.id);
      expect(orig.login_time, "PRECONDITION: an anchor to preserve").toBeTruthy();

      const rm = await removeFromEvent(api, csrf, open.comp.id, l.id);
      expect(rm.status, JSON.stringify(rm.body)).toBe(200);
      const abs = absenceRows(open.comp.id, l.id);
      expect(abs.length).toBe(1);
      expect(abs[0].assigned_at, "the join time is recorded on the absence").toBe(orig.assigned_at);

      const inv = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [l.email], competitionIds: [open.comp.id] } });
      expect(inv.ok(), await inv.text()).toBeTruthy();
      expect((await inv.json()).assigned, "re-invited").toBe(1);
      const back = cuRow(open.comp.id, l.id);
      expect(back.login_time, "the solve-clock anchor is restored").toBe(orig.login_time);
      expect(back.assigned_at, "and the original join time").toBe(orig.assigned_at);
      expect(absenceRows(open.comp.id, l.id)[0].returned_at, "the absence is closed").toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("A12 — the desk creates a late entrant for an open window; a closed one refuses and creates no account", async () => {
    const { api, csrf } = await sa();
    try {
      const open = await openBooth(api, csrf);
      const email = `${uniq()}@company.example`;
      const r = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email, competitionId: open.comp.id } });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      expect(body.lateEntry, "the response says they joined late").toBe(true);
      const cu = cuRow(open.comp.id, body.id);
      expect(cu, "the membership landed").toBeTruthy();
      expect(new Date(cu.assigned_at).getTime(), "joined after the end → a late entrant").toBeGreaterThan(open.effEnd.getTime());

      const closed = await closedBooth(api, csrf);
      const before = rawGet("SELECT COUNT(*) AS n FROM users").n;
      const no = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email: `${uniq()}@company.example`, competitionId: closed.comp.id } });
      expect(no.status()).toBe(409);
      expect((await no.json()).error).toBe("That event has finished and is not taking late entries.");
      expect(rawGet("SELECT COUNT(*) AS n FROM users").n, "no account was created").toBe(before);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Removal through the window
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — only a late entrant can be removed through the window", () => {
  test("A13/A14/A15 — a late entrant is removable and marked; an ordinary member and a blitz finisher are not; a closed window removes nobody", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const o = await makeParticipant(api, csrf, uniq());    // ordinary, never entered
      const bl = await makeParticipant(api, csrf, uniq());   // blitz finisher
      for (const p of [o, bl]) await enrol(api, csrf, b.comp.id, p.id);
      const bc = await participantCtx(bl.email, b.comp.id);
      try { expect((await (await submit(bc.api, bc.csrf, b.taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await bc.api.dispose(); }
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(b.comp.id, o.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      rawSetAssignedAt(b.comp.id, bl.id, new Date(effEnd.getTime() - 5 * MIN).toISOString());
      rawBackdate("submissions", "submitted_at", b.comp.id, bl.id, new Date(effEnd.getTime() - 2 * MIN).toISOString());
      rawBackdate("competition_users", "login_time", b.comp.id, bl.id, new Date(effEnd.getTime() - 4 * MIN).toISOString());

      // L — admitted in the window, plays and collects a participation certificate.
      const l = await makeParticipant(api, csrf, uniq());
      const a = await assign(api, csrf, { userIds: [l.id], competitionIds: [b.comp.id] });
      expect(a.body.assigned).toBe(1);
      const lc = await participantCtx(l.email, b.comp.id);
      let badgeToken;
      try {
        expect((await (await submit(lc.api, lc.csrf, b.taskIds[0])).json()).correct).toBeTruthy();
        const mint = await lc.api.post(`/api/competitions/${b.comp.id}/badge`, { headers: H(lc.csrf) });
        expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
        const badge = await mint.json();
        expect(badge.basis, "participation while the window is open").toBe("participation");
        badgeToken = badge.token;
      } finally { await lc.api.dispose(); }

      // A14 — the add emit says so; a live-event assign does not.
      const addEv = eventDetails("user_events", "user_id", l.id, "added_to_competition").find(d => d.competition_id === b.comp.id);
      expect(addEv && addEv.late_entry, "added_to_competition carries late_entry").toBe(true);
      const live = await liveBooth(api, csrf);
      const lv = await makeParticipant(api, csrf, uniq());
      expect((await assign(api, csrf, { userIds: [lv.id], competitionIds: [live.comp.id] })).body.assigned).toBe(1);
      const liveEv = eventDetails("user_events", "user_id", lv.id, "added_to_competition").find(d => d.competition_id === live.comp.id);
      expect(liveEv, "PRECONDITION: the live add is recorded").toBeTruthy();
      expect(liveEv.late_entry, "a live add carries no late_entry").toBeUndefined();

      // A15 — the participants list marks exactly the removable one.
      await outliveParticipantsCache();
      const plist = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
      const entryOf = (uid) => (plist.find(p => p.id === uid)?.competitions || []).find(c => c.id === b.comp.id);
      expect(entryOf(l.id)?.late_entrant, "the late entrant's entry is marked").toBe(true);
      expect(entryOf(o.id), "PRECONDITION: the ordinary member's entry exists").toBeTruthy();
      expect("late_entrant" in entryOf(o.id), "the ordinary member's is not (the key is absent)").toBe(false);
      expect("late_entrant" in entryOf(bl.id), "nor the blitz finisher's").toBe(false);

      const boardBefore = mainSection(await adminBoard(api, b.comp.id));

      // A13 — the refusals.
      const ro = await removeFromEvent(api, csrf, b.comp.id, o.id);
      expect(ro.status, JSON.stringify(ro.body)).toBe(400);
      expect(ro.body.code).toBe("not_late_entrant");
      expect(cuRow(b.comp.id, o.id), "the ordinary member stays").toBeTruthy();
      expect(absenceRows(b.comp.id, o.id).length, "and no absence is written").toBe(0);
      const rb = await removeFromEvent(api, csrf, b.comp.id, bl.id);
      expect(rb.status, JSON.stringify(rb.body)).toBe(400);
      expect(rb.body.code, "the blitz finisher is on the final board, so stays").toBe("not_late_entrant");

      // The removal.
      const rl = await removeFromEvent(api, csrf, b.comp.id, l.id);
      expect(rl.status, JSON.stringify(rl.body)).toBe(200);
      expect(rl.body.removed).toBe(true);
      const abs = absenceRows(b.comp.id, l.id);
      expect(abs.length, "an absence row is written").toBe(1);
      expect(abs[0].assigned_at && abs[0].login_time, "carrying the join time and the anchor").toBeTruthy();
      expect(rawGet("SELECT revoked_at FROM achievement_badges WHERE token=?", [badgeToken]).revoked_at, "the participation certificate is not revoked").toBeNull();
      expect(mainSection(await adminBoard(api, b.comp.id)), "the FINAL board is byte-identical").toBe(boardBefore);
      const rmEv = eventDetails("competition_events", "competition_id", b.comp.id, "user_removed").find(d => d.user_id === l.id);
      expect(rmEv && rmEv.late_entrant, "user_removed carries late_entrant").toBe(true);

      // CONTROL — a late entrant of an event whose window has CLOSED stays.
      const c = await liveBooth(api, csrf);
      const lx = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, c.comp.id, lx.id);
      const cEnd = await expireEvent(c.comp.id, { agoMinutes: 49 * 60 });
      rawSetAssignedAt(c.comp.id, lx.id, new Date(cEnd.getTime() + 10 * MIN).toISOString());
      const rc = await removeFromEvent(api, csrf, c.comp.id, lx.id);
      expect(rc.status).toBe(400);
      expect(rc.body.code).toBe("event_ended");
      await outliveParticipantsCache();
      const plist2 = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
      const cEntry = (plist2.find(p => p.id === lx.id)?.competitions || []).find(e => e.id === c.comp.id);
      expect(cEntry, "PRECONDITION").toBeTruthy();
      expect("late_entrant" in cEntry, "a closed window marks nobody").toBe(false);
    } finally { await api.dispose(); }
  });

  // v8.12.6 (review) — TWO ANSWERS, NOT ONE. `late_entrant` marks the removable
  // members; being a late entrant is wider. The commonest shape — a walk-up who
  // joined in the event's last ten minutes and opened it before it ended — is a
  // late entrant (ranked in the Late entrants section, playing on) whom the removal
  // keeps, and every surface that read `late_entrant` as "is a late entrant" called
  // them an ordinary member. `late_entry_playing` is the play gate's own answer,
  // published beside it. Three people, and each flag has a person it must NOT mark.
  test("A17 — `late_entry_playing` marks every late entrant playing through the window, `late_entrant` only the removable ones", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const w = await makeParticipant(api, csrf, uniq());   // walk-up: joined late, opened it before the end
      const o = await makeParticipant(api, csrf, uniq());   // ordinary member
      for (const p of [w, o]) await enrol(api, csrf, b.comp.id, p.id);
      // W OPENS the event while it runs (this stamps the anchor and the active event).
      { const c = await participantCtx(w.email, b.comp.id); await c.api.dispose(); }
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(b.comp.id, w.id, new Date(effEnd.getTime() - 5 * MIN).toISOString());
      rawBackdate("competition_users", "login_time", b.comp.id, w.id, new Date(effEnd.getTime() - 4 * MIN).toISOString());
      rawSetAssignedAt(b.comp.id, o.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      // P — joins after the end, through the window, and opens it.
      const p = await makeParticipant(api, csrf, uniq());
      expect((await assign(api, csrf, { userIds: [p.id], competitionIds: [b.comp.id] })).body.assigned).toBe(1);
      { const c = await participantCtx(p.email, b.comp.id); await c.api.dispose(); }

      // PRECONDITIONS, from the server's own classification.
      const ws = await lateStatus(w.email, b.comp.id);
      // Operator ruling, 29 Oct 2026: no pre-window. W joined the LIVE event five
      // minutes before the close, so W is an ordinary member now.
      expect(ws.window_open, `the window is open: ${JSON.stringify(ws)}`).toBeTruthy();
      expect(ws.is_late_entrant, `W (joined before the end) is NOT a late entrant: ${JSON.stringify(ws)}`).toBeFalsy();
      expect((await lateStatus(o.email, b.comp.id)).is_late_entrant, "O is not").toBeFalsy();

      await outliveParticipantsCache();
      const plist = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
      const entryOf = (uid) => (plist.find(x => x.id === uid)?.competitions || []).find(c => c.id === b.comp.id);
      for (const u of [w, o, p]) expect(entryOf(u.id), "PRECONDITION: the entry exists").toBeTruthy();
      expect("late_entry_playing" in entryOf(w.id), "the live-event joiner is not playing as a late entrant").toBe(false);
      expect("late_entrant" in entryOf(w.id), "…and is NOT removable (the key is absent)").toBe(false);
      expect(entryOf(p.id).late_entry_playing, "the post-end joiner is playing").toBe(true);
      expect(entryOf(p.id).late_entrant, "…and removable").toBe(true);
      expect("late_entry_playing" in entryOf(o.id), "the ordinary member carries neither").toBe(false);
      expect("late_entrant" in entryOf(o.id)).toBe(false);

      // The removal refuses W and says the true rule.
      const rw = await removeFromEvent(api, csrf, b.comp.id, w.id);
      expect(rw.status, JSON.stringify(rw.body)).toBe(400);
      expect(rw.body.code).toBe("not_late_entrant");
      expect(rw.body.error, "the refusal names the rule that applies, not 'only people who joined late'").toMatch(/had not started playing before the end/);

      // The account-delete speed bump fires for the playing late entrant P and
      // offers the removal; W is in a finished event and is not playing at all.
      const dp = await api.delete(`/api/admin/participants/${p.id}`, { headers: H(csrf) });
      expect(dp.status()).toBe(400);
      const dpb = await dp.json();
      expect(dpb.lateEntrant).toBe(true);
      expect("removable" in dpb, "a removable late entrant is offered the removal").toBe(false);
      expect(dpb.error).toMatch(/Remove them from the event first/);
    } finally { await api.dispose(); }
  });

  test("a late entrant holding a PLACING certificate is refused with the remedy; one without is removed", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      const l = await makeParticipant(api, csrf, uniq());
      const l2 = await makeParticipant(api, csrf, uniq());
      expect((await assign(api, csrf, { userIds: [l.id, l2.id], competitionIds: [b.comp.id] })).body.assigned).toBe(2);
      const lc = await participantCtx(l.email, b.comp.id);
      try { expect((await (await submit(lc.api, lc.csrf, b.taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await lc.api.dispose(); }
      // CLOSE the window (pinned deadline in the past) so the late board is final…
      rawUpdateComp(b.comp.id, "late_entry_deadline_at=?", [new Date(effEnd.getTime() + 5 * MIN).toISOString()]);
      await outliveCompCache();
      const mc = await participantCtx(l.email, null);
      try {
        const mint = await mc.api.post(`/api/competitions/${b.comp.id}/badge`, { headers: H(mc.csrf) });
        expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
        expect((await mint.json()).basis, "PRECONDITION: a placing certificate on the final late board").toBe("placement");
      } finally { await mc.api.dispose(); }
      // …then a superadmin re-pins the deadline and the window reopens.
      const wire = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === b.comp.id);
      const repin = await api.put(`/api/admin/competitions/${b.comp.id}`, {
        headers: H(csrf), data: { late_entry_deadline_at: new Date(Date.now() + 2 * 3600_000).toISOString(), expectedUpdatedAt: wire.updated_at },
      });
      expect(repin.ok(), `re-pin: ${await repin.text()}`).toBeTruthy();
      await outliveCompCache();

      const r = await removeFromEvent(api, csrf, b.comp.id, l.id);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.code).toBe("late_entrant_has_certificate");
      expect(r.body.error, "the remedy is named").toMatch(/Revoke the certificate first/);
      expect(cuRow(b.comp.id, l.id), "they stay").toBeTruthy();
      // The account-delete speed bump gives THIS refusal's own reason: the
      // certificate, never the other rule's "had started playing before it ended".
      expect(rawGet("SELECT active_competition_id AS a FROM users WHERE id=?", [l.id]).a, "PRECONDITION: they are playing it").toBe(b.comp.id);
      const del = await api.delete(`/api/admin/participants/${l.id}`, { headers: H(csrf) });
      expect(del.status(), "a late entrant playing the window is not deleted without confirmation").toBe(400);
      const dl = await del.json();
      expect(dl).toMatchObject({ code: "participant_in_live_competition", lateEntrant: true, removable: false, removalRefused: "late_entrant_has_certificate" });
      expect(dl.error, "the reason is the certificate").toMatch(/hold a placing certificate for it, so they can be removed from it only once that certificate is revoked/);
      expect(dl.error, "never the other rule's reason").not.toMatch(/started playing/);
      // CONTROL — the same shape with no certificate is removed.
      const r2 = await removeFromEvent(api, csrf, b.comp.id, l2.id);
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    } finally { await api.dispose(); }
  });

  // The OTHER refusal, with its own reason: a late entrant (joined after the end)
  // who had started playing before it, so the window's removal keeps them for
  // good. CONTROL: a late entrant the removal would take is offered it, with
  // neither field.
  test("the account-delete refusal for a late entrant who had started before the end says so, and nothing about a certificate", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf, { tasks: 1 });
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      const k = await makeParticipant(api, csrf, uniq());   // joined after the end, had started before it
      const p = await makeParticipant(api, csrf, uniq());   // joined after the end, started after it
      expect((await assign(api, csrf, { userIds: [k.id, p.id], competitionIds: [b.comp.id] })).body.assigned).toBe(2);
      for (const u of [k, p]) { const c = await participantCtx(u.email, b.comp.id); await c.api.dispose(); }
      rawBackdate("competition_users", "login_time", b.comp.id, k.id, new Date(effEnd.getTime() - 4 * MIN).toISOString());
      // PRECONDITIONS, from the server's own answers: both play the window, the
      // removal keeps K for having started before the end and would take P.
      for (const u of [k, p]) expect((await lateStatus(u.email, b.comp.id)).is_late_entrant, "joined after the end: a late entrant").toBeTruthy();
      const rk = await removeFromEvent(api, csrf, b.comp.id, k.id);
      expect(rk.status, JSON.stringify(rk.body)).toBe(400);
      expect(rk.body.code, "PRECONDITION: the removal refuses K for having started before the end").toBe("not_late_entrant");

      const del = await api.delete(`/api/admin/participants/${k.id}`, { headers: H(csrf) });
      expect(del.status()).toBe(400);
      const dk = await del.json();
      expect(dk).toMatchObject({ code: "participant_in_live_competition", lateEntrant: true, removable: false, removalRefused: "not_late_entrant" });
      expect(dk.error, "the reason is having started before the end").toMatch(/had started playing before it ended, so they cannot be removed from it instead/);
      expect(dk.error, "never the certificate's").not.toMatch(/certificate/);
      // CONTROL — removable: neither field, and the removal is offered.
      const dp = await (await api.delete(`/api/admin/participants/${p.id}`, { headers: H(csrf) })).json();
      expect(dp.lateEntrant, "PRECONDITION: P is playing as a late entrant").toBe(true);
      expect("removable" in dp || "removalRefused" in dp, "a removable late entrant carries neither").toBe(false);
      expect(dp.error).toMatch(/Remove them from the event first/);
    } finally { await api.dispose(); }
  });

  test("the account-delete speed bump covers a late entrant playing in the window; an ordinary member of the same event gets none", async () => {
    const { api, csrf } = await sa();
    try {
      const b = await liveBooth(api, csrf);
      const o = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, b.comp.id, o.id);
      const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
      rawSetAssignedAt(b.comp.id, o.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      const l = await makeParticipant(api, csrf, uniq());
      expect((await assign(api, csrf, { userIds: [l.id], competitionIds: [b.comp.id] })).body.assigned).toBe(1);
      // Both select the event, so both carry it as their active event.
      for (const p of [l, o]) { const c = await participantCtx(p.email, b.comp.id); await c.api.dispose(); }
      expect(rawGet("SELECT active_competition_id AS a FROM users WHERE id=?", [l.id]).a, "PRECONDITION").toBe(b.comp.id);
      expect(rawGet("SELECT active_competition_id AS a FROM users WHERE id=?", [o.id]).a, "PRECONDITION").toBe(b.comp.id);

      const d = await api.delete(`/api/admin/participants/${l.id}`, { headers: H(csrf) });
      expect(d.status(), "a late entrant playing the window is not deleted without confirmation").toBe(400);
      const db = await d.json();
      expect(db.code).toBe("participant_in_live_competition");
      expect(db.lateEntrant).toBe(true);
      // CONTROL
      const d2 = await api.delete(`/api/admin/participants/${o.id}`, { headers: H(csrf) });
      expect(d2.status(), `an ordinary member of the ended event: ${await d2.text()}`).toBe(200);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The late-entry switch locks once the event has ended
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — the late-entry switch cannot move after the end", () => {
  test("an ended event refuses the switch in BOTH directions (dry run included); an echo is accepted; a live event is free", async () => {
    const { api, csrf } = await sa();
    try {
      const on = await openBooth(api, csrf);
      const off = await offBooth(api, csrf);
      const live = await liveBooth(api, csrf);
      const wireOf = async (id) => (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);
      expect((await wireOf(on.comp.id)).late_entry_locked, "the list says why").toBe("ended");
      expect((await wireOf(live.comp.id)).late_entry_locked, "and a live event is not locked").toBeNull();

      // v8.12.8 — a third fixture: a booth whose window has LAPSED. The switch is
      // locked there too, and it is the control for the remedy clause below.
      const lapsed = await closedBooth(api, csrf);
      for (const [ev, to, windowOpen] of [[on, false, true], [off, true, false], [lapsed, false, false]]) {
        const w = await wireOf(ev.comp.id);
        const r = await api.put(`/api/admin/competitions/${ev.comp.id}`, { headers: H(csrf), data: { late_entry_enabled: to, expectedUpdatedAt: w.updated_at } });
        expect(r.status(), `turn ${to ? "ON" : "OFF"} after the end`).toBe(400);
        const body = await r.json();
        expect(body.code).toBe("late_entry_locked_ended");
        // v8.12.8 — THE REMEDY IS NAMED ONLY WHERE IT EXISTS. "Close late entries
        // now" is offered on a window-open event and nowhere else, so a refusal on
        // an event with no window (late entries off) or a lapsed one names no
        // remedy at all — an instruction pointing at a button the reader cannot
        // find is the FROZEN_REMEDY class. The old wording (set the deadline to
        // now) is gone from every case: it was a superadmin-only edit in practice.
        if (windowOpen) expect(body.error, "the remedy is named while the window is open").toMatch(/Close late entries now/);
        else expect(body.error, "no remedy named once there is no window to close").not.toMatch(/Close late entries now/);
        expect(body.error, "the old superadmin-only remedy is gone").not.toMatch(/deadline to now/);
        const dry = await api.put(`/api/admin/competitions/${ev.comp.id}`, { headers: H(csrf), data: { late_entry_enabled: to, validate_only: true, expectedUpdatedAt: w.updated_at } });
        expect(dry.status(), "the dry run meets it too").toBe(400);
        expect((await dry.json()).code).toBe("late_entry_locked_ended");
        expect(!!rawGetComp(ev.comp.id).late_entry_enabled, "nothing changed").toBe(!to);
      }
      // An ECHO of the stored value is not a change.
      const w = await wireOf(on.comp.id);
      const echo = await api.put(`/api/admin/competitions/${on.comp.id}`, { headers: H(csrf), data: { late_entry_enabled: true, expectedUpdatedAt: w.updated_at } });
      expect(echo.status(), `an echo is accepted: ${await echo.text()}`).toBe(200);
      expect((await echo.json()).competition?.late_entry_locked, "and the saved row carries the lock reason too (_compWire)").toBe("ended");
      // CONTROL — a live event toggles freely.
      const lw = await wireOf(live.comp.id);
      const tog = await api.put(`/api/admin/competitions/${live.comp.id}`, { headers: H(csrf), data: { late_entry_enabled: false, expectedUpdatedAt: lw.updated_at } });
      expect(tog.status(), `a live event toggles: ${await tog.text()}`).toBe(200);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The team board is the teams bound when the event ended
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.12.6 — a group bound after the end is not on the team board", () => {
  /** Two identical events; only WHEN group B is bound differs. */
  async function build(api, csrf, backdateBind) {
    const b = await liveBooth(api, csrf, { tasks: 1, create: { group_leaderboard_enabled: true } });
    const p1 = await makeParticipant(api, csrf, uniq());
    const p2 = await makeParticipant(api, csrf, uniq());
    const gA = await makeGroup(api, csrf, [p1.id]);
    expect((await assign(api, csrf, { groupIds: [gA], competitionIds: [b.comp.id] })).status).toBe(200);
    await enrol(api, csrf, b.comp.id, p2.id);
    for (const p of [p1, p2]) {
      const c = await participantCtx(p.email, b.comp.id);
      try { expect((await (await submit(c.api, c.csrf, b.taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await c.api.dispose(); }
    }
    const effEnd = await expireEvent(b.comp.id, { agoMinutes: 30 });
    for (const p of [p1, p2]) {
      rawSetAssignedAt(b.comp.id, p.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      rawBackdate("submissions", "submitted_at", b.comp.id, p.id, new Date(effEnd.getTime() - 20 * MIN).toISOString());
    }
    // The fixture trap, for the BIND this time: group A was bound while live, but
    // the expiry re-timed the event, so its bind now reads as AFTER the end. Put it
    // back an hour before the end, where it really happened.
    rawRun("UPDATE competition_groups SET assigned_at=? WHERE competition_id=? AND group_id=?",
      [new Date(effEnd.getTime() - 60 * MIN).toISOString(), b.comp.id, gA]);
    // Group B holds p2 (a member from before the end) and is bound IN THE WINDOW.
    const gB = await makeGroup(api, csrf, [p2.id]);
    expect((await assign(api, csrf, { groupIds: [gB], competitionIds: [b.comp.id] })).status).toBe(200);
    if (backdateBind) {
      rawRun("UPDATE competition_groups SET assigned_at=? WHERE competition_id=? AND group_id=?",
        [new Date(effEnd.getTime() - 40 * MIN).toISOString(), b.comp.id, gB]);
    }
    return { b, gA, gB };
  }

  test("bound in the window → not ranked; the identical event with the bind before the end → ranked", async () => {
    const { api, csrf } = await sa();
    try {
      const post = await build(api, csrf, false);
      const pre = await build(api, csrf, true);
      const read = async (id) => {
        const r = await api.get(`/api/admin/leaderboard?competitionId=${id}&groups=1`);
        expect(r.ok()).toBeTruthy();
        return r.json();
      };
      const postBoard = await read(post.b.comp.id);
      expect(Array.isArray(postBoard) && postBoard.length, `a team bound after the end is not on the final team board: ${JSON.stringify(postBoard)}`).toBe(0);
      const preBoard = await read(pre.b.comp.id);
      expect(Array.isArray(preBoard) && preBoard.length > 0, `CONTROL — the same team bound before the end is: ${JSON.stringify(preBoard)}`).toBe(true);
    } finally { await api.dispose(); }
  });
});



