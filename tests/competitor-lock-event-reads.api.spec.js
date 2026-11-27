// AN ORGANISER WHO COMPETES IN AN EVENT, AND AN ORGANISER OF OTHER EVENTS, READ
// NONE OF ITS RIVALS' LIVE FIGURES OR LEAD DATA (sweep gaps #53, #55).
//
// Four doors carry what a competing organiser must not see of the people they
// play against: the workspace Overview's live figures (GET …/overview-pulse,
// routes/event-overview.js: scope, 404, then the competitor lock) and three
// Team & reports doors (routes/event-team.js, each behind `_gate(req, res,
// { write: true })`: 404, the competitor lock, then scope) — the report email
// preview (GET …/team-report/preview), the lead file (GET …/team-report/leads.csv)
// and the "contacted" mark (POST …/leads/:userId/contacted).
//
// On one live event where staff compete, for each door:
//   * an event admin who organises it AND holds a row in it, and a global admin
//     holding a row in it (the lock binds every tier), are refused 403
//     `competitor_cannot_edit` in the one refusal shape, naming the event, and
//     the refusal carries none of the event's people;
//   * an event admin who organises only ANOTHER event is refused 403
//     `event_admin_out_of_scope` (their own event answers them: the control that
//     the session works and the refusal is about scope);
//   * CONTROLS: an event admin who organises it with no row in it, and the
//     built-in superadmin (who never competes), are answered, and the answer
//     carries the lead's details (asserted by value);
//   * the mark is unchanged BY VALUE after every refusal, in both directions;
//   * every answered lead-file download writes its orphaned `data_exported`
//     record (scope `export`, id `team-leads`, the event's id) with the request's
//     context — its `req_id` is the response's X-Request-ID — and a refused one
//     writes none.
// And through an organiser's own panel (an impersonation with the admin view),
// where each door asks the lock of the SEAT and the HAND (`competitorIds(req)`):
//   * THE HAND: an admin who comes to compete in the event mid-session is refused
//     the pulse, the preview and the lead file, while the organiser whose seat
//     they hold reads them (the panel's download is recorded as the acting
//     admin's, made as the organiser);
//   * THE SEAT: in the panel of an organiser who competes, a hand who does not
//     (the built-in superadmin, for whom `competitorIds` is the seat alone, and a
//     global admin with no row, the seat and a hand) is refused the same three
//     reads by each door's own lock, and no download is recorded; in the panel
//     of the organiser who does not compete the same hands read all three.
// The contacted mark through a panel is a WRITE, and the impersonation write
// guard (lib/impersonation.js `impersonationGuard`) answers it before the door
// wherever it asks: a regular admin's view is read-only (`impersonation_readonly`),
// and a hand who competes in an event the organiser runs meets the guard's own
// re-ask (`actingAdminCompetesInTargetEvents`, in its own words). So no test here
// witnesses the door's own HAND lock for the mark. Only a superadmin's hand that
// competes in none of the organiser's events gets past the guard to the door:
// there the door's SEAT lock refuses the built-in superadmin's mark in the
// competing organiser's panel, and the other organiser's panel sets and clears it.
// (The pulse's out-of-scope refusal is also held by
// tests/workspace-overview-live.spec.js; it is repeated here as the scope row of
// one matrix.)
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let sa, saCsrf;     // the built-in superadmin
let E, D;           // E: the event where staff compete; D: the out-of-scope organiser's own event
let lead, dLead;    // E's one lead (a participant); D's
let member;         // E's SDR team member (a recipient, not an account)
const who = {};     // the signed-in organisers: eaCmp, gaCmp, eaOk, eaOut → { p, api, csrf }
const COMPETITORS = ["eaCmp", "gaCmp"];

function withDb(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

/** The competitor refusal, in its one shape (lib/staff-compete.js competitorRefusalBody). */
function expectCompetitorRefusal(status, text, label, ev = E) {
  expect(status, `${label} is refused: ${text}`).toBe(403);
  const b = JSON.parse(text);
  expect(Object.keys(b).sort(), `${label}: the one refusal shape, nothing more`).toEqual(["code", "competitionId", "competitionName", "error"]);
  expect(b.code, label).toBe("competitor_cannot_edit");
  expect(b.competitionId, `${label}: names the event`).toBe(ev.id);
  expect(b.competitionName, label).toBe(ev.name);
  expect(b.error, `${label}: says why`).toContain("You are competing in");
  return b;
}

/** The scope refusal (lib/event-admin.js competitionDenied). */
function expectScopeRefusal(status, text, label) {
  expect(status, `${label} is refused: ${text}`).toBe(403);
  const b = JSON.parse(text);
  expect(Object.keys(b).sort(), `${label}: the refusal shape, nothing more`).toEqual(["code", "error"]);
  expect(b.code, label).toBe("event_admin_out_of_scope");
  return b;
}

// Which mechanism refused, by its own words: a door's lock
// (lib/staff-compete.js competitorEditDenied) or the impersonation write guard's
// re-ask (lib/impersonation.js actingAdminCompetesInTargetEvents). Both answer
// `competitor_cannot_edit` in the same shape.
const DOOR_WORDS = "so you cannot change the event or its challenges";
const GUARD_WORDS = "so you cannot make changes through their admin view";

/** A lead's contacted mark as stored (null: no row). */
const markOf = (compId, userId) => withDb(db => db.prepare("SELECT contacted_at, contacted_by FROM event_leads WHERE competition_id=? AND user_id=?").get(compId, userId)) || null;
/** The event's History of contacted marks, oldest first. */
const contactedHistoryOf = (compId) => withDb(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='lead_contacted' ORDER BY changed_at, rowid").all(compId))
  .map(r => ({ by: r.changed_by, ...JSON.parse(r.details) }));
/** The event's lead-file downloads, oldest first: who, and the request's context. */
const leadExportsOf = (compId) => withDb(db => db.prepare(
  "SELECT changed_by, details FROM orphan_events WHERE scope='export' AND scope_id='team-leads' AND event_type='data_exported' AND competition_id=? ORDER BY changed_at, rowid"
).all(compId)).map(r => ({ by: r.changed_by, ...JSON.parse(r.details) }));

/** Enter `target`'s own panel (the admin view) from `api`; returns the panel's CSRF token. */
async function enterPanel(api, csrf, target, label) {
  const imp = await api.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(csrf), data: { view: "admin" } });
  expect(imp.status(), `${label}: enter the panel: ${await imp.text()}`).toBe(200);
  expect(await imp.json(), `${label}: PRECONDITION: the organiser's own panel`).toMatchObject({ ok: true, view: "admin", target: { id: target.id, role: "event_admin" } });
  return (await (await api.get("/api/csrf-token")).json()).csrfToken;
}

/** Leave the panel; returns the restored session's CSRF token. */
async function leavePanel(api, csrf, label) {
  const out = await api.post("/api/impersonation/exit", { headers: H(csrf) });
  expect(out.ok(), `${label}: leave the panel: ${out.status()} ${await out.text()}`).toBeTruthy();
  return (await (await api.get("/api/csrf-token")).json()).csrfToken;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  E = await makeCompetition(sa, saCsrf, `cmpE${stamp}`, { staff_compete: true });
  D = await makeCompetition(sa, saCsrf, `cmpD${stamp}`);
  lead = await makeParticipant(sa, saCsrf, "lead");
  dLead = await makeParticipant(sa, saCsrf, "dlead");
  const eaCmp = await makeParticipant(sa, saCsrf, "eacmp");
  const gaCmp = await makeParticipant(sa, saCsrf, "gacmp");
  const eaOk = await makeParticipant(sa, saCsrf, "eaok");
  const eaOut = await makeParticipant(sa, saCsrf, "eaout");
  await grantEventAdmin(sa, saCsrf, E.id, eaCmp.id);
  await grantEventAdmin(sa, saCsrf, E.id, eaOk.id);
  await grantEventAdmin(sa, saCsrf, D.id, eaOut.id);
  const pr = await sa.post(`/api/admin/participants/${gaCmp.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(pr.ok(), `promote the global admin: ${pr.status()} ${await pr.text()}`).toBeTruthy();
  // Staff compete in E, so the assign door gives both organisers a row there.
  await enrol(sa, saCsrf, E.id, [lead.id, eaCmp.id, gaCmp.id]);
  await enrol(sa, saCsrf, D.id, [dLead.id]);

  // E's team: one SDR, so the SDR preview renders the lead's card. Adding a
  // recipient needs the allowed-domain list, a global setting: back to its
  // default (empty) at once.
  const dom = await sa.put("/api/admin/team-report-domains", { headers: H(saCsrf), data: { domains: ["corp.example"] } });
  try {
    expect(dom.ok(), `allow the team's domain: ${dom.status()} ${await dom.text()}`).toBeTruthy();
    const r = await sa.post(`/api/admin/competitions/${E.id}/team`, { headers: H(saCsrf), data: { role: "sdr", name: "Sid", email: `sid-${stamp}@corp.example` } });
    expect(r.ok(), `add the SDR: ${r.status()} ${await r.text()}`).toBeTruthy();
    member = (await r.json()).member;
  } finally {
    const back = await sa.put("/api/admin/team-report-domains", { headers: H(saCsrf), data: { domains: [] } });
    expect(back.ok(), `the domain list back to its default: ${back.status()} ${await back.text()}`).toBeTruthy();
  }

  for (const [k, p] of Object.entries({ eaCmp, gaCmp, eaOk, eaOut })) {
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    who[k] = { p, api: s.api, csrf: s.csrf };
  }

  // PRECONDITIONS, asserted rather than assumed: who each actor is to the rule.
  withDb((db) => {
    const flag = (id) => db.prepare("SELECT staff_compete FROM competitions WHERE id=?").get(id).staff_compete;
    expect(flag(E.id), "staff compete in E").toBe(1);
    expect(flag(D.id), "…not in D").toBe(0);
    const rows = (id) => db.prepare("SELECT user_id FROM competition_users WHERE competition_id=?").all(id).map(r => r.user_id).sort();
    expect(rows(E.id), "E holds the lead and both competing organisers, never the organiser who does not compete").toEqual([lead.id, eaCmp.id, gaCmp.id].sort());
    expect(rows(D.id), "D holds its own lead").toEqual([dLead.id]);
    const grants = (id) => db.prepare("SELECT user_id FROM competition_admins WHERE competition_id=?").all(id).map(r => r.user_id).sort();
    expect(grants(E.id), "E's organisers").toEqual([eaCmp.id, eaOk.id].sort());
    expect(grants(D.id), "D's organiser").toEqual([eaOut.id]);
    const role = (id) => db.prepare("SELECT role FROM users WHERE id=?").get(id).role;
    expect([eaCmp, eaOk, eaOut, gaCmp, lead].map(p => role(p.id)), "the roles").toEqual(["event_admin", "event_admin", "event_admin", "admin", "participant"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_team_members WHERE competition_id=? AND role='sdr'").get(E.id).n, "E's SDR").toBe(1);
  });
  for (const k of Object.keys(who)) {
    const me = await who[k].api.get("/api/admin/me");
    expect(me.ok(), `${k} holds an admin session: ${me.status()}`).toBeTruthy();
  }
});

test.afterAll(async () => {
  for (const k of Object.keys(who)) await who[k].api.dispose().catch(() => {});
  if (sa) await sa.dispose().catch(() => {});
});

test("overview-pulse: a competing organiser is refused the event's live figures; the organiser who does not compete, and the superadmin, read them", async () => {
  const url = `/api/admin/competitions/${E.id}/overview-pulse`;
  // CONTROLS: the figures, with every member in them by name (staff compete in
  // E, so the competing organisers are members like the lead).
  for (const [label, api] of [["the organiser who does not compete", who.eaOk.api], ["the superadmin", sa]]) {
    const r = await api.get(url);
    expect(r.status(), `${label}: ${await r.text()}`).toBe(200);
    const d = await r.json();
    expect(d.competition_id, label).toBe(E.id);
    expect(d.totals, `${label} reads the event's figures`).toMatchObject({ joined: 3, enrolled: 3, answers: 0 });
    expect(d.recent.filter(x => x.type === "joined").map(x => x.nickname).sort(), `${label} reads who joined`)
      .toEqual([lead.nickname, who.eaCmp.p.nickname, who.gaCmp.p.nickname].sort());
  }
  // The competitors: refused, and the refusal names nobody who plays.
  for (const k of COMPETITORS) {
    const r = await who[k].api.get(url);
    const text = await r.text();
    expectCompetitorRefusal(r.status(), text, `${k}'s pulse`);
    expect(text, `${k}'s refusal carries no rival`).not.toContain(lead.nickname);
  }
  // An organiser of another event: refused by scope; their own event answers.
  const out = await who.eaOut.api.get(url);
  const outText = await out.text();
  expectScopeRefusal(out.status(), outText, "the out-of-scope organiser's pulse");
  expect(outText).not.toContain(lead.nickname);
  const own = await who.eaOut.api.get(`/api/admin/competitions/${D.id}/overview-pulse`);
  expect(own.status(), "CONTROL: their own event's figures are theirs").toBe(200);
  expect((await own.json()).recent.map(x => x.nickname), "…with their own event's people").toEqual([dLead.nickname]);
});

test("team-report preview: a competing organiser is refused the report email; the organiser who does not compete, and the superadmin, read it with the lead in it", async () => {
  const url = `/api/admin/competitions/${E.id}/team-report/preview?persona=sdr`;
  for (const [label, api] of [["the organiser who does not compete", who.eaOk.api], ["the superadmin", sa]]) {
    const r = await api.get(url);
    expect(r.status(), `${label}: ${await r.text()}`).toBe(200);
    const d = await r.json();
    expect([d.ok, d.persona, d.to_role], `${label} reads the SDR's email`).toEqual([true, "sdr", "SDR"]);
    expect(d.text, `${label}: the email holds the lead's card, address and all`).toContain(`Email: ${lead.email}`);
    expect(d.html, `${label}: …in both parts`).toContain(lead.email);
    expect(d.text, `${label}: addressed to the team's SDR`).toContain(`Hi ${member.name},`);
  }
  for (const k of COMPETITORS) {
    const r = await who[k].api.get(url);
    const text = await r.text();
    expectCompetitorRefusal(r.status(), text, `${k}'s preview`);
    expect(text, `${k}'s refusal carries no lead`).not.toContain(lead.email);
  }
  const out = await who.eaOut.api.get(url);
  const outText = await out.text();
  expectScopeRefusal(out.status(), outText, "the out-of-scope organiser's preview");
  expect(outText).not.toContain(lead.email);
  const own = await who.eaOut.api.get(`/api/admin/competitions/${D.id}/team-report/preview?persona=sdr`);
  expect(own.status(), "CONTROL: their own event's preview answers them").toBe(200);
  expect(await own.json(), "…D has no team yet").toMatchObject({ ok: true, persona: "sdr", empty: true });
});

test("lead file: a competing organiser is refused it and nothing is recorded; each download that is answered writes its data_exported record with the request's context", async () => {
  const url = `/api/admin/competitions/${E.id}/team-report/leads.csv`;
  const exportsOf = (compId) => withDb(db => db.prepare(
    `SELECT changed_by, competition_id, details FROM orphan_events
      WHERE scope='export' AND scope_id='team-leads' AND event_type='data_exported' AND competition_id=?
      ORDER BY changed_at, rowid`
  ).all(compId)).map(r => ({ ...r, details: JSON.parse(r.details) }));
  expect(exportsOf(E.id), "PRECONDITION: nothing exported from E yet").toEqual([]);

  // Refusals first: none of them may be recorded as an export.
  for (const k of COMPETITORS) {
    const r = await who[k].api.get(url);
    const text = await r.text();
    expect(r.headers()["content-type"] || "", `${k}: a refusal, not a file`).toMatch(/^application\/json/);
    expectCompetitorRefusal(r.status(), text, `${k}'s lead file`);
    expect(text, `${k}'s refusal carries no lead`).not.toContain(lead.email);
  }
  const out = await who.eaOut.api.get(url);
  const outText = await out.text();
  expectScopeRefusal(out.status(), outText, "the out-of-scope organiser's lead file");
  expect(outText).not.toContain(lead.email);
  expect(exportsOf(E.id), "no refused download is recorded as an export").toEqual([]);

  // CONTROL 1: the organiser who does not compete downloads it.
  const loopback = /^(::1|(::ffff:)?127\.0\.0\.1)$/;
  const download = async (api, label) => {
    const r = await api.get(url);
    const body = await r.text();
    expect(r.status(), `${label}: ${body.slice(0, 300)}`).toBe(200);
    expect(r.headers()["content-type"], `${label}: a CSV`).toBe("text/csv; charset=utf-8");
    expect(r.headers()["content-disposition"] || "", `${label}: a download`).toMatch(/^attachment; filename="leads-/);
    expect(body, `${label}: the file holds the lead`).toContain(lead.email);
    for (const k of COMPETITORS) expect(body, `${label}: the organisers are not leads`).not.toContain(who[k].p.email);
    const reqId = r.headers()["x-request-id"];
    expect(reqId, `${label}: PRECONDITION: the response names its request`).toMatch(/^[0-9a-f-]{36}$/);
    return reqId;
  };
  const okReq = await download(who.eaOk.api, "the organiser who does not compete");
  let rows;
  await expect.poll(() => (rows = exportsOf(E.id)).length, { timeout: 5000, message: "the download is recorded" }).toBe(1);
  expect(rows[0].changed_by, "the export is the organiser's").toBe(who.eaOk.p.email);
  expect(rows[0].competition_id, "…of this event").toBe(E.id);
  expect(rows[0].details, "…with what it held and the request's context").toMatchObject({ competition_id: E.id, lead_count: 1, req_id: okReq });
  expect(rows[0].details.ip, "…its source address").toMatch(loopback);
  expect(typeof rows[0].details.session_id === "string" && rows[0].details.session_id.length > 0, "…and its session").toBe(true);

  // CONTROL 2: the superadmin, recorded as their own export.
  const saReq = await download(sa, "the superadmin");
  await expect.poll(() => (rows = exportsOf(E.id)).length, { timeout: 5000, message: "the second download is recorded" }).toBe(2);
  expect(rows.map(r => [r.changed_by, r.details.req_id]), "one record per download, each naming its own request").toEqual([[who.eaOk.p.email, okReq], ["superadmin", saReq]]);
  expect(rows[1].details.ip).toMatch(loopback);
  expect(rows[0].details.session_id, "two sessions, two records").not.toBe(rows[1].details.session_id);

  // The out-of-scope organiser's own file is theirs, and recorded against D only.
  const own = await who.eaOut.api.get(`/api/admin/competitions/${D.id}/team-report/leads.csv`);
  expect(own.status(), "CONTROL: their own event's lead file").toBe(200);
  expect(await own.text()).toContain(dLead.email);
  await expect.poll(() => exportsOf(D.id).map(r => r.changed_by), { timeout: 5000 }).toEqual([who.eaOut.p.email]);
  expect(exportsOf(E.id).length, "nothing more against E").toBe(2);
});

test("contacted mark: a competing organiser can neither set nor clear it; the organiser who does not compete sets it and the superadmin clears it", async () => {
  const url = `/api/admin/competitions/${E.id}/leads/${lead.id}/contacted`;
  const mark = () => markOf(E.id, lead.id);
  const history = () => contactedHistoryOf(E.id);
  const post = (k, contacted) => who[k].api.post(url, { headers: H(who[k].csrf), data: { contacted } });
  expect(mark(), "PRECONDITION: the lead is not marked").toBeNull();
  expect(history(), "PRECONDITION: no mark recorded").toEqual([]);

  const refuseAll = async (contacted) => {
    for (const k of COMPETITORS) {
      const r = await post(k, contacted);
      expectCompetitorRefusal(r.status(), await r.text(), `${k} ${contacted ? "setting" : "clearing"} the mark`);
    }
    const out = await post("eaOut", contacted);
    expectScopeRefusal(out.status(), await out.text(), `the out-of-scope organiser ${contacted ? "setting" : "clearing"} the mark`);
  };

  await refuseAll(true);
  expect(mark(), "after every refused set, the lead is still not marked").toBeNull();
  expect(history(), "…and nothing is recorded").toEqual([]);

  // CONTROL: the organiser who does not compete sets it.
  const set = await post("eaOk", true);
  expect(set.status(), await set.text()).toBe(200);
  expect(await set.json(), "set, and the lead is no longer waiting").toEqual({ ok: true, contacted: true, changed: true, contactable: false });
  const marked = mark();
  expect(marked && marked.contacted_by, "the mark is the organiser's").toBe(who.eaOk.p.email);
  expect(Number.isFinite(Date.parse(marked.contacted_at)), "…and dated").toBe(true);
  let h = history();
  expect(h.map(x => [x.by, x.user_id, x.contacted]), "the History records the set").toEqual([[who.eaOk.p.email, lead.id, true]]);
  expect(h[0].req_id, "…with the request's context").toMatch(/^[0-9a-f-]{36}$/);

  // The refusals the other way: the mark stays exactly as the organiser set it.
  await refuseAll(false);
  expect(mark(), "after every refused clear, the mark is unchanged").toEqual(marked);
  expect(history().length, "…and nothing more is recorded").toBe(1);

  // CONTROL: the superadmin clears it.
  const clear = await sa.post(url, { headers: H(saCsrf), data: { contacted: false } });
  expect(clear.status(), await clear.text()).toBe(200);
  expect(await clear.json(), "cleared, and the lead is waiting again").toEqual({ ok: true, contacted: false, changed: true, contactable: true });
  expect(mark(), "the mark is gone").toEqual({ contacted_at: null, contacted_by: null });
  h = history();
  expect(h.map(x => [x.by, x.contacted]), "the History records both").toEqual([[who.eaOk.p.email, true], ["superadmin", false]]);
});

// THE HAND. In an organiser's own panel (an impersonation with the admin view)
// each door asks the lock of the SEAT and the HAND (`competitorIds(req)`). The
// entry refuses an admin who competes in an event the organiser runs, so the
// hand comes to compete only mid-session (a colleague enrols them). The write
// guard re-asks that on WRITES only, so for the three reads the door's own lock
// is the one witness. The contacted mark, a write, never reaches the door here:
// the guard answers it first, read-only while the hand is a regular admin, then
// by its own re-ask once they compete (in its words, not the door's). A second
// event where staff compete, run by the organiser who does not compete, keeps
// E's figures as the tests above read them.
test("the hand, through an organiser's own panel: an admin who comes to compete in the event meanwhile is refused the pulse, the preview and the lead file by the doors and the contacted mark by the write guard, while the organiser whose seat they hold reads them and sets it", async () => {
  const E2 = await makeCompetition(sa, saCsrf, `cmpE2${stamp}`, { staff_compete: true });
  const lead2 = await makeParticipant(sa, saCsrf, "lead2");
  await enrol(sa, saCsrf, E2.id, [lead2.id]);
  await grantEventAdmin(sa, saCsrf, E2.id, who.eaOk.p.id);
  const hand = await makeParticipant(sa, saCsrf, "hand");
  const pr = await sa.post(`/api/admin/participants/${hand.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(pr.ok(), `promote the acting admin: ${pr.status()} ${await pr.text()}`).toBeTruthy();
  const reads = {
    pulse: `/api/admin/competitions/${E2.id}/overview-pulse`,
    preview: `/api/admin/competitions/${E2.id}/team-report/preview?persona=sdr`,
    leads: `/api/admin/competitions/${E2.id}/team-report/leads.csv`,
  };
  const markUrl = `/api/admin/competitions/${E2.id}/leads/${lead2.id}/contacted`;
  const readAll = async (api, label, joinedNames) => {
    const out = {};
    for (const [k, url] of Object.entries(reads)) {
      const r = await api.get(url);
      out[k] = { status: r.status(), text: await r.text() };
      expect(out[k].status, `${label}: ${k}: ${out[k].text.slice(0, 300)}`).toBe(200);
    }
    expect(JSON.parse(out.pulse.text).recent.map(x => `${x.type}:${x.nickname}`).sort(), `${label}: the pulse holds E2's people`).toEqual(joinedNames.map(n => `joined:${n}`).sort());
    expect(JSON.parse(out.preview.text), `${label}: the preview answers (E2 has no team)`).toMatchObject({ ok: true, persona: "sdr", empty: true });
    expect(out.leads.text, `${label}: the lead file holds E2's lead`).toContain(lead2.email);
  };

  const hs = await apiLogin(hand.email, PARTICIPANT_PASS);
  try {
    hs.csrf = await enterPanel(hs.api, hs.csrf, who.eaOk.p, "the acting admin");

    // CONTROL: before the acting admin competes, the seat's reads are theirs,
    // and the download is recorded as the acting admin's, naming the seat.
    await readAll(hs.api, "the panel, before the acting admin competes", [lead2.nickname]);
    let ex = leadExportsOf(E2.id);
    expect(ex.map(r => [r.by, r.impersonated_by, r.acting_as]), "the panel's download: the acting admin's, made as the organiser").toEqual([[hand.email, hand.email, who.eaOk.p.email]]);
    // A regular admin's view never writes: the guard answers the mark first.
    const ro = await hs.api.post(markUrl, { headers: H(hs.csrf), data: { contacted: true } });
    expect(ro.status(), `the panel's mark, before the acting admin competes: ${await ro.text()}`).toBe(403);
    expect((await ro.json()).code, "…the write guard's read-only answer").toBe("impersonation_readonly");

    // A colleague enrols the acting admin in E2 mid-session (staff compete there).
    await enrol(sa, saCsrf, E2.id, [hand.id]);
    expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=? AND user_id=?").get(E2.id, hand.id).n), "PRECONDITION: the acting admin now competes in E2").toBe(1);
    expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=? AND user_id=?").get(E2.id, who.eaOk.p.id).n), "PRECONDITION: the organiser holds no row there").toBe(0);
    for (const [k, url] of Object.entries(reads)) {
      const r = await hs.api.get(url);
      const text = await r.text();
      const b = expectCompetitorRefusal(r.status(), text, `the panel's ${k}, the hand competing`, E2);
      expect(b.error, `the panel's ${k}: the door's own lock refuses it (the guard leaves reads alone)`).toContain(DOOR_WORDS);
      expect(text, `the panel's ${k}: no rival in the refusal`).not.toContain(lead2.email);
      expect(text).not.toContain(lead2.nickname);
    }
    expect(leadExportsOf(E2.id).length, "the refused download is not recorded").toBe(1);
    // The mark: the guard's own re-ask now answers it, before the door (and
    // above its read-only answer), so the door's hand lock is not what this sees.
    const g = await hs.api.post(markUrl, { headers: H(hs.csrf), data: { contacted: true } });
    const gb = expectCompetitorRefusal(g.status(), await g.text(), "the panel's mark, the hand competing", E2);
    expect(gb.error, "…refused by the write guard's re-ask, in its own words").toContain(GUARD_WORDS);
    expect(gb.error, "…not by the door").not.toContain(DOOR_WORDS);
    expect(markOf(E2.id, lead2.id), "the lead was never marked").toBeNull();
    expect(contactedHistoryOf(E2.id), "…and nothing is recorded").toEqual([]);

    // CONTROL: the organiser competes nowhere: their own session still reads
    // all three, and sets the mark the panel could not.
    await readAll(who.eaOk.api, "the organiser's own session", [lead2.nickname, hand.nickname]);
    ex = leadExportsOf(E2.id);
    expect(ex.map(r => r.by), "…and their download is theirs").toEqual([hand.email, who.eaOk.p.email]);
    const set = await who.eaOk.api.post(markUrl, { headers: H(who.eaOk.csrf), data: { contacted: true } });
    expect(set.status(), `the organiser sets the mark: ${await set.text()}`).toBe(200);
    expect(markOf(E2.id, lead2.id)?.contacted_by, "…as theirs").toBe(who.eaOk.p.email);
  } finally {
    try { await leavePanel(hs.api, hs.csrf, "the acting admin"); } finally { await hs.api.dispose(); }
  }
});

// THE SEAT. In the panel of an organiser who COMPETES, `competitorIds(req)` names
// the seat whoever sits in it. The entry asks only about the HAND's own rows
// (`actingAdminCompetesInTargetEvents`), so a hand who competes nowhere gets in,
// and each door's own lock is what refuses. Two hands, because the seat must be
// asked with and without a hand id: the built-in superadmin (no row, so
// `competitorIds` is the seat alone) and a global admin with no row anywhere
// (the seat and a hand). The contacted mark is a write: the guard lets the
// built-in superadmin's through to the door (it competes nowhere, and a
// superadmin's view writes), whose seat lock refuses it, and answers a regular
// admin's itself (`impersonation_readonly`). E's mark ends as found.
test("the seat, through a competing organiser's own panel: a hand who does not compete (the built-in superadmin, a global admin with no row) is refused the pulse, the preview and the lead file, and the superadmin's contacted mark at the door; in the other organiser's panel the same hands read all three and the superadmin sets and clears the mark", async () => {
  const ga = await makeParticipant(sa, saCsrf, "gahand");
  const pr = await sa.post(`/api/admin/participants/${ga.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(pr.ok(), `promote the global admin: ${pr.status()} ${await pr.text()}`).toBeTruthy();
  const reads = {
    pulse: `/api/admin/competitions/${E.id}/overview-pulse`,
    preview: `/api/admin/competitions/${E.id}/team-report/preview?persona=sdr`,
    leads: `/api/admin/competitions/${E.id}/team-report/leads.csv`,
  };
  const markUrl = `/api/admin/competitions/${E.id}/leads/${lead.id}/contacted`;
  const seatCmp = who.eaCmp.p, seatOk = who.eaOk.p;
  const markedAt = () => (markOf(E.id, lead.id) || {}).contacted_at || null;

  // PRECONDITIONS: which seat competes, and neither hand competes anywhere.
  withDb((db) => {
    const has = (table, uid) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE competition_id=? AND user_id=?`).get(E.id, uid).n;
    expect([has("competition_users", seatCmp.id), has("competition_admins", seatCmp.id)], "the seat that competes: a row in E, and E's organiser").toEqual([1, 1]);
    expect([has("competition_users", seatOk.id), has("competition_admins", seatOk.id)], "the seat that does not: no row in E, and E's organiser").toEqual([0, 1]);
    expect(db.prepare("SELECT role FROM users WHERE id=?").get(ga.id).role, "the second hand is a global admin").toBe("admin");
    expect(db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE user_id=?").get(ga.id).n, "…holding no row anywhere").toBe(0);
  });
  expect(markedAt(), "PRECONDITION: the lead is not marked").toBeNull();
  const historyAt = contactedHistoryOf(E.id).length;
  const exportsAt = leadExportsOf(E.id).length;

  // In the competing organiser's panel: each read refused by the door's own
  // lock, naming E, carrying nobody, and no download recorded.
  const refusedOnSeat = async (api, label) => {
    const before = leadExportsOf(E.id).length;
    for (const [k, url] of Object.entries(reads)) {
      const r = await api.get(url);
      const text = await r.text();
      const b = expectCompetitorRefusal(r.status(), text, `${label}: ${k}`);
      expect(b.error, `${label}: ${k}: the door's own lock`).toContain(DOOR_WORDS);
      expect(text, `${label}: ${k}: no rival in the refusal`).not.toContain(lead.email);
      expect(text).not.toContain(lead.nickname);
    }
    expect(leadExportsOf(E.id).length, `${label}: the refused download is not recorded`).toBe(before);
  };
  // In the other organiser's panel: all three answered with E's people, and the
  // download recorded once, as the hand's, made as the organiser.
  const answered = async (api, label, handIdentity) => {
    const before = leadExportsOf(E.id).length;
    const out = {};
    for (const [k, url] of Object.entries(reads)) {
      const r = await api.get(url);
      out[k] = { status: r.status(), text: await r.text() };
      expect(out[k].status, `${label}: ${k}: ${out[k].text.slice(0, 300)}`).toBe(200);
    }
    expect(JSON.parse(out.pulse.text).recent.filter(x => x.type === "joined").map(x => x.nickname).sort(), `${label}: the pulse holds who joined E`)
      .toEqual([lead.nickname, seatCmp.nickname, who.gaCmp.p.nickname].sort());
    const pv = JSON.parse(out.preview.text);
    expect([pv.ok, pv.persona, pv.to_role], `${label}: the SDR's email`).toEqual([true, "sdr", "SDR"]);
    expect(pv.text, `${label}: …with the lead's card in it`).toContain(`Email: ${lead.email}`);
    expect(out.leads.text, `${label}: the lead file holds the lead`).toContain(lead.email);
    const ex = leadExportsOf(E.id);
    expect(ex.length, `${label}: the download is recorded, once`).toBe(before + 1);
    expect([ex[ex.length - 1].by, ex[ex.length - 1].impersonated_by, ex[ex.length - 1].acting_as], `${label}: …as the hand's, made as the organiser`)
      .toEqual([handIdentity, handIdentity, seatOk.email]);
  };

  // HAND 1: the built-in superadmin, who never competes.
  let panel = await enterPanel(sa, saCsrf, seatCmp, "the superadmin, the competing organiser's panel");
  try {
    await refusedOnSeat(sa, "the superadmin on the competing seat");
    // The mark: the guard lets a superadmin's write through, so the door's own
    // seat lock is what refuses it.
    const m = await sa.post(markUrl, { headers: H(panel), data: { contacted: true } });
    const b = expectCompetitorRefusal(m.status(), await m.text(), "the superadmin's mark on the competing seat");
    expect(b.error, "…refused by the door's own lock, not the write guard").toContain(DOOR_WORDS);
    expect(markedAt(), "…and the lead is still not marked").toBeNull();
    expect(contactedHistoryOf(E.id).length, "…nor anything recorded").toBe(historyAt);
  } finally {
    saCsrf = await leavePanel(sa, panel, "the superadmin");
  }
  // CONTROL: the same hand in the panel of the organiser who does not compete.
  panel = await enterPanel(sa, saCsrf, seatOk, "the superadmin, the other organiser's panel");
  try {
    await answered(sa, "the superadmin on the seat that does not compete", "superadmin");
    for (const contacted of [true, false]) {
      const r = await sa.post(markUrl, { headers: H(panel), data: { contacted } });
      expect(r.status(), `the superadmin ${contacted ? "sets" : "clears"} the mark through that panel: ${await r.text()}`).toBe(200);
      expect(await r.json(), "…and it changes").toMatchObject({ ok: true, contacted, changed: true });
      const now = markOf(E.id, lead.id);
      expect(now && now.contacted_by, `the mark ${contacted ? "is the hand's" : "is gone"}`).toBe(contacted ? "superadmin" : null);
      expect(Number.isFinite(Date.parse(now.contacted_at)), "…dated while set").toBe(contacted);
    }
    expect(contactedHistoryOf(E.id).slice(historyAt).map(x => [x.by, x.contacted, x.impersonated_by, x.acting_as]), "the History records both, the hand's, made as the organiser")
      .toEqual([["superadmin", true, "superadmin", seatOk.email], ["superadmin", false, "superadmin", seatOk.email]]);
  } finally {
    saCsrf = await leavePanel(sa, panel, "the superadmin");
  }

  // HAND 2: a global admin with no row (the seat and a hand).
  const gs = await apiLogin(ga.email, PARTICIPANT_PASS);
  try {
    let gp = await enterPanel(gs.api, gs.csrf, seatCmp, "the global admin, the competing organiser's panel");
    try {
      await refusedOnSeat(gs.api, "the global admin on the competing seat");
      // A regular admin's view never writes: the guard answers the mark before the door.
      const m = await gs.api.post(markUrl, { headers: H(gp), data: { contacted: true } });
      expect(m.status(), `the global admin's mark on the competing seat: ${await m.text()}`).toBe(403);
      expect((await m.json()).code, "…the write guard's read-only answer").toBe("impersonation_readonly");
      expect(markedAt(), "…and the lead is not marked").toBeNull();
    } finally {
      gs.csrf = await leavePanel(gs.api, gp, "the global admin");
    }
    // CONTROL: the same hand in the panel of the organiser who does not compete.
    gp = await enterPanel(gs.api, gs.csrf, seatOk, "the global admin, the other organiser's panel");
    try {
      await answered(gs.api, "the global admin on the seat that does not compete", ga.email);
    } finally {
      gs.csrf = await leavePanel(gs.api, gp, "the global admin");
    }
  } finally {
    await gs.api.dispose();
  }
  expect(leadExportsOf(E.id).length, "two downloads in all, both in the other organiser's panel").toBe(exportsAt + 2);
  expect(contactedHistoryOf(E.id).length, "two marks in all, both there").toBe(historyAt + 2);
  expect(markedAt(), "the mark ends as found").toBeNull();
});
