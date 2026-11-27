// @ts-check
//
// v8.12.4 — the SHARED FIXTURE of the three staff-compete-admin-ui part files.
//
// staff-compete-admin-ui.spec.js was the suite's critical path: 74 browser tests
// behind one large beforeAll, ~95 s alone on one worker (147 s when it ran under
// the start-of-run contention the longest-first scheduling puts it in). A spec
// file never spans workers, so it was split by top-level describe into
// staff-compete-admin-ui-{a,b,c}.spec.js. Everything they share lives here and
// NOTHING about a test body changed: each part declares the same variable names
// and fills them from buildFixture() in its own beforeAll.
//
// Why a module and not three inlined copies of the header (the v7.21.38 trade):
// the fixture is ~260 lines of carefully-asserted state, and three copies of it
// would drift — the defect class v7.21.25 and v8.12.3 each paid for once.
// This module must NOT require ./isolated-test (it registers the per-file
// recycle at import time — v7.21.35), and it opens no database at module scope
// (v7.20.2). Its module-level state is re-assigned by every buildFixture() call,
// i.e. once per spec file, so a later file on the same worker never reads an
// earlier file's handles.
//
// The long design note for these tests is in staff-compete-admin-ui-a.spec.js.
const { expect } = require("@playwright/test");
const { BASE, apiLogin, PARTICIPANT_PASS } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");
const {
  loginViaApi, login: formLogin, adminLogin, clickTab, openKebab, viewComp, filterComps, findSeededTaskRow, openCompCreateForm,
  textContrast, rowMarking,
  showEveryoneInWorkspace, narrowPeopleTable } = require("./ui-admin-helpers");

const iso = ms => new Date(Date.now() + ms).toISOString();

let sa, saCsrf;          // the built-in superadmin — fixture builder ONLY (see header)
let reader;              // { api, csrf } — a user-backed superadmin, never in a browser
let TAG;
let competitor, saComp, author, author2, staffP, staffP2, staffP3, plainP, plainP2, plainP3, mateP,
  pAuth, legacyP, eaP, agP;
let competeLive, plainLive, endedOn, endedOff, endLater, upOn, upOff, privOn, renOn, renOff,
  cUp, cUpSealed, dUp, dUpEmpty, gOn, gOff, hAuthorOn, hUpOn, hUpOff, aUp, agOff;
let sealedHinted, plainHinted, cTask, cSealed, gUnsealed, gSealed, hUnsealed, hSealed, hSealed2,
  aSealed, agTask, endSealed, unsealFree;
let scgrp, scgrpBound;   // { id, name } — a group bound to nothing, and one bound to `competeLive`

/**
 * A one-file STORED zip, for the attachment arms — the shape
 * `mutations-attachments.api.spec.js` builds, reduced to what an upload needs.
 * The server validates the central directory and the CRC, so a bare
 * `PK\x03\x04` prefix is not enough.
 */
const { zipOf: _zipOf } = require("./helpers");  // v8.12.4 — one stored-ZIP builder, in helpers.js

/** Upload one attachment onto a task as `ctx`, asserting it landed. */
async function attach(ctx, taskId, label) {
  const r = await ctx.api.post(`/api/admin/tasks/${taskId}/attachments`, {
    headers: { "x-csrf-token": ctx.csrf },
    multipart: { file: { name: `${label}.zip`, mimeType: "application/zip", buffer: _zipOf("README.txt", `attachment ${label}`) } },
  });
  expect(r.ok(), `attach ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
}

async function makeAdmin(label, role = "admin") {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;   // { id, email, nickname }
}

async function tagStaff(p, label) {
  const r = await sa.post(`/api/admin/participants/${p.id}/tags`, { headers: H(saCsrf), data: { tag: "staff" } });
  expect(r.ok(), `tag ${label} staff: ${r.status()} ${await r.text()}`).toBeTruthy();
}

async function tagComp(comp, tag) {
  const r = await sa.post(`/api/admin/competitions/${comp.id}/tags`, { headers: H(saCsrf), data: { tag } });
  expect(r.ok(), `tag ${comp.name} "${tag}": ${r.status()} ${await r.text()}`).toBeTruthy();
}

/** The admin competitions list, read through `reader` (never the browser's session). */
async function compRow(id) {
  const list = await (await reader.api.get("/api/admin/competitions")).json();
  const row = (Array.isArray(list) ? list : []).find(c => c.id === id);
  expect(row, `competition ${id} is in the admin list`).toBeTruthy();
  return row;
}

async function taskRow(id) {
  const list = await (await reader.api.get("/api/admin/tasks")).json();
  const row = (Array.isArray(list) ? list : []).find(t => t.id === id);
  expect(row, `task ${id} is in the admin list`).toBeTruthy();
  return row;
}

/** A participant's admin-list row, read through `reader`; ASSERTED present, so a lookup failure cannot read as "not enrolled". */
async function participantAdminRow(email) {
  // kind=all: some rows here are admin accounts, which People lists only on request.
  const list = await (await reader.api.get("/api/admin/participants?limit=5000&kind=all")).json();
  const row = (list.participants || []).find(p => p.email === email);
  expect(row, `${email} is in the admin list`).toBeTruthy();
  return row;
}

/** Build every fixture the staff-compete admin UI tests read; returns them by name. */
async function buildFixture() {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  TAG = uniq("sc").replace(/[^a-zA-Z0-9]/g, "");

  // ── people ────────────────────────────────────────────────────────────────
  const readerP = await makeAdmin("screader", "superadmin");
  competitor = await makeAdmin("sccompetitor");
  saComp     = await makeAdmin("scsacomp", "superadmin");
  author     = await makeAdmin("scauthor");
  author2    = await makeAdmin("scauthor2");
  staffP  = await makeParticipant(sa, saCsrf, "scstaffp");  await tagStaff(staffP, "staffP");
  staffP2 = await makeParticipant(sa, saCsrf, "scstaffp2"); await tagStaff(staffP2, "staffP2");
  // A staff-tagged AND BLOCKED row: the assign door asks blocked before staff,
  // so it must be reported as blocked (round-3 (c)). Blocked AFTER the tag, and
  // `block` is a TOGGLE (v8.3.28) — asserted below rather than assumed.
  staffP3 = await makeParticipant(sa, saCsrf, "scstaffp3"); await tagStaff(staffP3, "staffP3");
  {
    const r = await sa.post(`/api/admin/participants/${staffP3.id}/block`, { headers: H(saCsrf) });
    expect(r.ok(), `block staffP3: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).blocked, "the toggle landed on BLOCKED, not unblocked").toBe(1);
  }
  plainP  = await makeParticipant(sa, saCsrf, "scplainp");
  plainP2 = await makeParticipant(sa, saCsrf, "scplainp2");
  plainP3 = await makeParticipant(sa, saCsrf, "scplainp3");
  mateP   = await makeParticipant(sa, saCsrf, "scmate");     // enrolled beside the competitor
  // The ENROLLED AUTHOR of the (a) arm: an EVENT ADMIN of a switch-OFF event.
  // Event admins are excluded from scoring by ROLE, not by the `staff` tag, so
  // the assign door admits them to a switch-off event — the one shape that can
  // hold "somebody enrolled here wrote one of its challenges" BEFORE the switch
  // is turned on, which is what the enrolled-authors refusal exists for.
  pAuth   = await makeParticipant(sa, saCsrf, "scpauth");
  // A LEGACY staff row: enrolled in a switch-off event as a plain participant,
  // THEN promoted (the role route adds the tag and deletes no rows) — the row
  // an organiser must still be able to Remove.
  legacyP = await makeParticipant(sa, saCsrf, "sclegacy");
  // The Grant Attempts roster's NEGATIVE twin: an event-admin ROLE user enrolled
  // in a switch-OFF capped event is not a competitor there and must not be listed.
  eaP     = await makeAdmin("scea", "event_admin");
  agP     = await makeParticipant(sa, saCsrf, "scagp");

  // ── events ────────────────────────────────────────────────────────────────
  // `competeLive` carries an attempt cap so Grant Attempts has an event to offer
  // (and to withhold from a competitor).
  competeLive = await makeCompetition(sa, saCsrf, "competelive", { staff_compete: true, attempt_cap: 3 });
  plainLive   = await makeCompetition(sa, saCsrf, "plainlive");
  endedOn     = await makeCompetition(sa, saCsrf, "endedon",  { staff_compete: true, start_time: iso(-2 * 3600e3), duration_minutes: 60 });
  endedOff    = await makeCompetition(sa, saCsrf, "endedoff", { start_time: iso(-2 * 3600e3), duration_minutes: 60 });
  endLater    = await makeCompetition(sa, saCsrf, "endlater", { staff_compete: true });   // ended by End Now below, AFTER saComp is enrolled
  upOn        = await makeCompetition(sa, saCsrf, "upon",  { staff_compete: true, start_time: iso(2 * 3600e3) });
  upOff       = await makeCompetition(sa, saCsrf, "upoff", { start_time: iso(2 * 3600e3) });
  privOn      = await makeCompetition(sa, saCsrf, "privon", { staff_compete: true, start_time: iso(2 * 3600e3) });
  renOn       = await makeCompetition(sa, saCsrf, "renon",  { staff_compete: true });
  renOff      = await makeCompetition(sa, saCsrf, "renoff");
  cUp         = await makeCompetition(sa, saCsrf, "cup",       { start_time: iso(2 * 3600e3) });
  cUpSealed   = await makeCompetition(sa, saCsrf, "cupsealed", { start_time: iso(2 * 3600e3) });
  dUp         = await makeCompetition(sa, saCsrf, "dup",      { staff_compete: true, start_time: iso(2 * 3600e3) });
  dUpEmpty    = await makeCompetition(sa, saCsrf, "dupempty", { staff_compete: true, start_time: iso(2 * 3600e3) });
  gOn         = await makeCompetition(sa, saCsrf, "gon",  { staff_compete: true });
  gOff        = await makeCompetition(sa, saCsrf, "goff");
  hAuthorOn   = await makeCompetition(sa, saCsrf, "hauthoron", { staff_compete: true, start_time: iso(2 * 3600e3) });
  // The (h) SAVE targets: their own events, so the arms that write an assignment
  // leave `upOn` / `upOff` pure fixtures for everything else that reads them.
  hUpOn       = await makeCompetition(sa, saCsrf, "hupon",  { staff_compete: true, start_time: iso(2 * 3600e3) });
  hUpOff      = await makeCompetition(sa, saCsrf, "hupoff", { start_time: iso(2 * 3600e3) });
  aUp         = await makeCompetition(sa, saCsrf, "aup",    { start_time: iso(2 * 3600e3) });   // the enrolled-author refusal (switch OFF, upcoming)
  agOff       = await makeCompetition(sa, saCsrf, "agoff",  { attempt_cap: 3 });                 // switch OFF + capped: the roster's negative twin
  // A tag on the compete event AND its switch-off twin — the per-tag `×` is
  // withheld from a competitor, and there has to be a × to withhold.
  await tagComp(competeLive, `sc-${TAG}`);
  await tagComp(plainLive, `sc-${TAG}`);

  // ── groups ────────────────────────────────────────────────────────────────
  // `scgrp` is bound to nothing (the Events dialog arm); `scgrpBound` is bound
  // to the compete event by the BUILT-IN account (the group-controls arm). Both
  // are EMPTY, so the bind reconciles nobody into the event.
  const mkGroup = async label => {
    const r = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `SC ${uniq(label)}` } });
    expect(r.ok(), `create group ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    const g = (await r.json()).group;
    expect(g?.id, "group create returns an id").toBeTruthy();
    return { id: g.id, name: g.name };
  };
  scgrp = await mkGroup("scgrp");
  scgrpBound = await mkGroup("scgrpbound");
  {
    const r = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [scgrpBound.id], competitionIds: [competeLive.id] } });
    expect(r.ok(), `bind scgrpBound to competeLive: ${r.status()} ${await r.text()}`).toBeTruthy();
  }

  // ── challenges ────────────────────────────────────────────────────────────
  // SEALED ones are made by their AUTHOR (a user-backed admin); unsealed ones by
  // `reader`, so no author competes anywhere by accident.
  const a1 = await apiLogin(author.email, PARTICIPANT_PASS);
  const a2 = await apiLogin(author2.email, PARTICIPANT_PASS);
  reader = await apiLogin(readerP.email, PARTICIPANT_PASS);
  try {
    sealedHinted = await makeTask(a1.api, a1.csrf, "sealedhinted", { answer_sealed: true, hint: `<p>SECRET_HINT_${TAG}</p>`, correct_answer: `SECRET_KEY_${TAG}` });
    cSealed      = await makeTask(a1.api, a1.csrf, "csealed", { answer_sealed: true });
    gSealed      = await makeTask(a1.api, a1.csrf, "gsealed", { answer_sealed: true });
    hSealed      = await makeTask(a1.api, a1.csrf, "hsealed", { answer_sealed: true });
    hSealed2     = await makeTask(a2.api, a2.csrf, "hsealed2", { answer_sealed: true });
    endSealed    = await makeTask(a1.api, a1.csrf, "endsealed", { answer_sealed: true });   // goes into endLater BEFORE it is ended
    unsealFree   = await makeTask(a1.api, a1.csrf, "unsealfree", { answer_sealed: true }); // in NO event: the Unseal control
    plainHinted  = await makeTask(reader.api, reader.csrf, "plainhinted", { hint: `<p>PLAIN_HINT_${TAG}</p>` });
    cTask        = await makeTask(reader.api, reader.csrf, "ctask");
    gUnsealed    = await makeTask(reader.api, reader.csrf, "gunsealed");
    hUnsealed    = await makeTask(reader.api, reader.csrf, "hunsealed");
    agTask       = await makeTask(reader.api, reader.csrf, "agtask");

    // A sealed challenge in the compete event: the event's OWN copy (lib/event-copies.js), which every door below acts on.
    sealedHinted = { ...sealedHinted, bankId: sealedHinted.id, id: (await assignTask(a1.api, a1.csrf, sealedHinted.id, [competeLive.id])).copies[0].task_id };
    await assignTask(a1.api, a1.csrf, endSealed.id, [endLater.id]);         // …and one in the event that will be ENDED below
    await assignTask(reader.api, reader.csrf, agTask.id, [agOff.id]);       // the capped switch-OFF event holds an unsealed one
    // ONE ATTACHMENT on the sealed challenge and one on its unrelated twin: the
    // competitor's editor must keep Download and lose Rename/Remove, and there
    // has to be a chip for that to be true of (v8.12.0 round 3).
    await attach(a1, sealedHinted.id, "sealed");
    await attach(reader, plainHinted.id, "plain");
    // A SECOND VERSION of the sealed challenge, written by its author. The
    // History dialog renders its Restore cell — and therefore the "Not while
    // competing" copy that replaces it — only on a row that is NOT the current
    // version; a challenge with one version has no such row, and "no Restore
    // button" is then true of every challenge on the platform. Measured: the
    // first draft of that arm asserted against a one-row history and failed.
    // The LIBRARY question: its row is the one the Challenges page lists, and
    // whose History the arms read (the event's copy keeps its own versions).
    const v2 = await a1.api.put(`/api/admin/tasks/${sealedHinted.bankId}`, { headers: H(a1.csrf), data: { description: "<p>d2</p>" } });
    expect(v2.ok(), `author edits the sealed challenge: ${v2.status()} ${await v2.text()}`).toBeTruthy();
    const vers = await (await a1.api.get(`/api/admin/tasks/${sealedHinted.bankId}/versions`)).json();
    expect((Array.isArray(vers) ? vers : vers.versions || []).length, "the sealed challenge holds at least two versions").toBeGreaterThanOrEqual(2);
    Object.assign(cTask, { bankId: cTask.id, id: (await assignTask(reader.api, reader.csrf, cTask.id, [cUp.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
    await assignTask(a1.api, a1.csrf, cSealed.id, [cUpSealed.id]);          // a sealed one on the (c) control
  } finally { await a1.api.dispose(); await a2.api.dispose(); }

  // ── enrolments ────────────────────────────────────────────────────────────
  // The built-in superadmin is the actor, so an admin — and a SUPERADMIN —
  // target is enrolled on a compete event (skippedPrivileged applies to a
  // NON-superadmin actor only).
  await enrol(sa, saCsrf, competeLive.id, [competitor.id, mateP.id, saComp.id]);
  await enrol(sa, saCsrf, upOn.id, [competitor.id]);          // an UPCOMING event the competitor competes in → Start Now is withheld
  await enrol(sa, saCsrf, dUp.id, [staffP2.id]);              // staff-TAGGED → the toggle-off refusal names them
  await enrol(sa, saCsrf, hAuthorOn.id, [author2.id]);         // the author competes → their challenge is refused
  await enrol(sa, saCsrf, agOff.id, [agP.id, eaP.id]);          // a participant AND an event-admin-role user on the capped switch-off event
  // The LEGACY staff row: enrolled first, promoted second. Promotion purges
  // sessions, and legacyP never signs in, so the order costs nothing.
  await enrol(sa, saCsrf, upOff.id, [legacyP.id]);
  {
    const r = await sa.post(`/api/admin/participants/${legacyP.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(r.ok(), `promote legacyP: ${r.status()} ${await r.text()}`).toBeTruthy();
  }
  // The ENROLLED AUTHOR: organiser of `aUp`, enrolled in it, and the author of
  // a SEALED challenge assigned there. Every write below is theirs (the author
  // rule fires only once the switch is on, so the assignment is admitted now).
  await grantEventAdmin(sa, saCsrf, aUp.id, pAuth.id);
  await enrol(sa, saCsrf, aUp.id, [pAuth.id]);
  {
    const pa = await apiLogin(pAuth.email, PARTICIPANT_PASS);
    try {
      aSealed = await makeTask(pa.api, pa.csrf, "asealed", { answer_sealed: true });
      Object.assign(aSealed, { bankId: aSealed.id, id: (await assignTask(pa.api, pa.csrf, aSealed.id, [aUp.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js), which the refusals name
    } finally { await pa.api.dispose(); }
  }
  // ONE FEEDBACK ROW on the sealed challenge, left by the mate — the purge
  // buttons render only over a row, and a competing superadmin must not be
  // offered them. A rating, never a submission: one participant solving the only
  // challenge would auto-end the event (fixture checklist item 1).
  {
    const m = await apiLogin(mateP.email, PARTICIPANT_PASS);
    try {
      const sel = await m.api.post("/api/select-competition", { headers: H(m.csrf), data: { competitionId: competeLive.id } });
      expect(sel.ok(), `mateP enters competeLive: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      const fb = await m.api.put(`/api/tasks/${sealedHinted.id}/feedback`, { headers: H(m.csrf), data: { rating: 4 } });
      expect(fb.ok(), `mateP rates the sealed challenge: ${fb.status()} ${await fb.text()}`).toBeTruthy();
    } finally { await m.api.dispose(); }
  }
  // The superadmin's ENDED permutation: enrolled while live, then ended by End
  // Now (the built-in never competes, so the door is open to it). The lock is
  // keyed on the ROW at any status, so saComp still competes in a finished event.
  await enrol(sa, saCsrf, endLater.id, [saComp.id]);
  {
    const r = await sa.post(`/api/admin/competitions/${endLater.id}/end-now`, { headers: H(saCsrf) });
    expect(r.ok(), `end endLater now: ${r.status()} ${await r.text()}`).toBeTruthy();
  }

  // ── preconditions on the wire, asserted before any browser reads a DOM
  //    rendered from them ───────────────────────────────────────────────────
  const c = await apiLogin(competitor.email, PARTICIPANT_PASS);
  try {
    const comps = await (await c.api.get("/api/admin/competitions")).json();
    const by = id => comps.find(x => x.id === id);
    expect(by(competeLive.id)?.competing, "the competitor really competes in the compete event").toBe(true);
    expect(by(competeLive.id)?.staff_compete, "…whose switch is on").toBeTruthy();
    expect(by(upOn.id)?.competing, "…and in the upcoming compete event").toBe(true);
    expect(by(plainLive.id)?.competing, "…and not in the switch-off control").toBe(false);
    expect(by(privOn.id)?.competing, "…nor in the peer-admin event").toBe(false);
    const tasks = await (await c.api.get("/api/admin/tasks")).json();
    const t = tasks.find(x => x.id === sealedHinted.id);
    expect((t?.competing_in || []).map(x => x.id), "the sealed challenge names the compete event").toContain(competeLive.id);
    expect(t?.can_edit, "…and is not editable by the competitor").toBe(false);
    expect(t?.hint_withheld, "…with the hint WITHHELD").toBe(true);
    expect(Object.prototype.hasOwnProperty.call(t || {}, "hint"), "…and the hint absent from the row").toBe(false);
    const p = tasks.find(x => x.id === plainHinted.id);
    expect(p?.can_edit, "CONTROL: the unrelated challenge IS editable by the same admin").toBe(true);
    expect(p?.hint, "…and its hint reaches them").toContain(`PLAIN_HINT_${TAG}`);
  } finally { await c.api.dispose(); }

  const s2 = await apiLogin(saComp.email, PARTICIPANT_PASS);
  try {
    const comps = await (await s2.api.get("/api/admin/competitions")).json();
    const by = id => comps.find(x => x.id === id);
    expect(by(competeLive.id)?.competing, "the user-backed superadmin really competes in the compete event").toBe(true);
    expect(by(endLater.id)?.competing, "…and still competes in the one that has since ENDED").toBe(true);
    expect(by(endLater.id)?.status, "…which really is ended").toBe("ended");
    expect(by(endedOn.id)?.competing, "…and not in the ended control").toBe(false);
    expect(by(plainLive.id)?.competing, "…nor in the live control").toBe(false);
  } finally { await s2.api.dispose(); }

  const rows = await (await reader.api.get("/api/admin/competitions")).json();
  const rb = id => rows.find(x => x.id === id);
  expect(rb(competeLive.id)?.staff_compete_locked, "the live compete event is locked 'started'").toBe("started");
  expect(rb(plainLive.id)?.staff_compete_locked, "…and so is the live switch-OFF one — the lock is about the event, not the switch").toBe("started");
  expect(rb(endedOn.id)?.staff_compete_locked, "the ended one is locked 'ended'").toBe("ended");
  expect(rb(endedOff.id)?.staff_compete_locked, "…switch off too").toBe("ended");
  expect(rb(upOn.id)?.staff_compete_locked, "the upcoming one is not locked").toBeNull();
  expect(rb(cUp.id)?.staff_compete, "(c) starts OFF").toBeFalsy();
  expect(rb(dUp.id)?.staff_compete, "(d) starts ON").toBeTruthy();
  expect((rb(competeLive.id)?.tags || []), "the compete event carries its tag").toContain(`sc-${TAG}`);
  expect((rb(plainLive.id)?.tags || []), "…and so does the switch-off control").toContain(`sc-${TAG}`);
  // `reader` competes nowhere — it authored nothing that was assigned and holds
  // no row — or every read-back below would be about a competitor.
  expect(rows.some(x => x.competing), "the reader competes in no event").toBe(false);
  expect(rb(aUp.id)?.staff_compete, "(a) starts OFF").toBeFalsy();
  expect(rb(agOff.id)?.staff_compete, "the capped roster twin is switch-OFF").toBeFalsy();
  expect(rb(hUpOn.id)?.staff_compete, "the (h) save target is switch-ON").toBeTruthy();

  // The round-3 fixtures, each asserted rather than assumed.
  // kind=all: legacyP is an admin now, and People lists admin accounts only on request.
  const pl = await (await reader.api.get("/api/admin/participants?limit=5000&kind=all")).json();
  const pby = id => (pl.participants || []).find(p => p.id === id);
  expect((pby(pAuth.id)?.competitions || []).some(c => c.id === aUp.id), "the author is ENROLLED in the switch-off event").toBe(true);
  expect(((await taskRow(aSealed.bankId)).competitions || []).map(c => c.id), "…which holds their sealed challenge").toContain(aUp.id);
  expect(pby(legacyP.id)?.role, "legacyP was promoted").toBe("admin");
  expect(pby(legacyP.id)?.tags || [], "…and carries the staff tag the promotion adds").toContain("staff");
  expect((pby(legacyP.id)?.competitions || []).some(c => c.id === upOff.id), "…while KEEPING the switch-off row written before it").toBe(true);
  expect(pby(staffP3.id)?.blocked, "staffP3 is blocked").toBeTruthy();
  expect(pby(staffP3.id)?.tags || [], "…and staff-tagged").toContain("staff");
  expect(pby(eaP.id)?.role, "eaP holds the event-admin ROLE").toBe("event_admin");
  expect((pby(eaP.id)?.competitions || []).some(c => c.id === agOff.id), "…and a row on the capped switch-off event").toBe(true);
  expect((pby(agP.id)?.competitions || []).some(c => c.id === agOff.id), "…beside a participant").toBe(true);
  {
    const gs = await (await reader.api.get(`/api/admin/groups/${scgrpBound.id}/competitions`)).json();
    expect((gs.competitions || []).find(c => c.id === competeLive.id)?.bound, "scgrpBound really is bound to the compete event").toBe(true);
    const gu = await (await reader.api.get(`/api/admin/groups/${scgrp.id}/competitions`)).json();
    expect((gu.competitions || []).some(c => c.bound), "scgrp is bound to nothing").toBe(false);
    const fb = await (await reader.api.get(`/api/admin/tasks/${sealedHinted.id}/feedback`)).json();
    expect((Array.isArray(fb) ? fb : []).some(f => f.user_id === mateP.id), "the mate's rating is on the sealed challenge").toBe(true);
    const at = await (await reader.api.get(`/api/admin/tasks/${sealedHinted.id}/attachments`)).json();
    expect((Array.isArray(at) ? at : []).length, "the sealed challenge carries exactly one attachment").toBe(1);
    const ap = await (await reader.api.get(`/api/admin/tasks/${plainHinted.id}/attachments`)).json();
    expect((Array.isArray(ap) ? ap : []).length, "…and so does its unrelated twin").toBe(1);
  }
  return { sa, saCsrf, reader, TAG, competitor, saComp, author, author2, staffP, staffP2, staffP3, plainP, plainP2, plainP3, mateP, pAuth, legacyP, eaP, agP, competeLive, plainLive, endedOn, endedOff, endLater, upOn, upOff, privOn, renOn, renOff, cUp, cUpSealed, dUp, dUpEmpty, gOn, gOff, hAuthorOn, hUpOn, hUpOff, aUp, agOff, sealedHinted, plainHinted, cTask, cSealed, gUnsealed, gSealed, hUnsealed, hSealed, hSealed2, aSealed, agTask, endSealed, unsealFree, scgrp, scgrpBound };
}

async function disposeFixture() {
  await reader?.api?.dispose();
  await sa?.dispose();
}

/** Sign a USER-BACKED admin into the browser and land on a settled admin panel. */
async function adminPanel(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `${email} had no live admin session before goto("/"): ${meR.status()} ${await meR.text()}`).toBeTruthy();
  await page.goto("/");
  // `#admin-page` is the readiness signal (v8.3.33): the sidebar buttons are
  // static markup and attached before boot has decided who we are.
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().waitFor({ state: "visible", timeout: 30000 });
}

/** Events tab → narrow to ONE named event → its row locator. */
async function eventRow(page, name) {
  await clickTab(page, "Events");
  await filterComps(page, name);
  const row = page.locator(`#admin-comp-body tr:has-text('${name}')`).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  return row;
}

/** Open the EDIT form of a named event through the row kebab. */
async function openEdit(page, name) {
  const row = await eventRow(page, name);
  await openKebab(page, row);
  const edit = page.locator('#kebab-portal [data-action="comp-edit"]');
  await expect(edit, `Edit is offered on "${name}"`).toHaveCount(1);
  await edit.click();
  await page.locator("#comp-form-overlay").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#comp-name").waitFor({ state: "visible", timeout: 15000 });
}

/** Press Save on the edit form and accept the "Update …" confirmation. */
async function saveEdit(page) {
  await page.locator('[data-action="comp-save"]').first().click();
  await expect(page.locator("#modal-overlay"), "the Update confirmation opened").toHaveClass(/open/, { timeout: 10000 });
  await expect(page.locator("#modal-title")).toHaveText(/^Update/);
  await page.locator("#modal-confirm-btn").click();
}

/** Challenges tab, model loaded, narrowed to ONE row. */
async function challengeRow(page, title, id) {
  await clickTab(page, "Challenges");
  await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), {
    message: "the challenge model loaded", timeout: 20000,
  }).toBeGreaterThan(0);
  // With an id, THAT row: the library question and each event's own copy of it
  // (lib/event-copies.js) share a title.
  const rows = await findSeededTaskRow(page, title);
  const row = (id ? rows.filter({ has: page.locator(`[data-task-id="${id}"]`) }) : rows).first();
  await expect(row, `the table narrowed to "${title}"`).toBeVisible({ timeout: 15000 });
  return row;
}

/**
 * The Participants tab, narrowed by email to ONE row. The caller has already
 * entered the tab: re-entering it re-runs `loadAdminParticipants`, which CLEARS
 * `S.selectedParticipants` — so a helper that clicked the tab per row would
 * silently drop every earlier tick (measured: two rows ticked, one in the
 * selection).
 */
async function participantRow(page, email) {
  // Inside an event workspace the pane lists its members; these rows are often
  // NON-members (the Invite rows), so list everyone, as the old focus did. A
  // no-op outside a workspace and once pressed.
  await showEveryoneInWorkspace(page);
  // RBAC — People lists admin accounts only with "Show admin accounts" ticked
  // (the box exists outside a workspace, for global admins); these fixtures
  // include admin rows.
  const inc = page.locator("#p-include-admins");
  if (await inc.isVisible().catch(() => false) && !(await inc.isChecked())) {
    const reload = page.waitForResponse((r) => r.url().includes("/api/admin/participants?") && r.url().includes("kind=all"));
    await inc.check();
    await reload;
  }
  await narrowPeopleTable(page, email);
  const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
  await expect(row, `the participants table narrowed to ${email}`).toBeVisible({ timeout: 15000 });
  // The search debounce REPLACES the tbody a moment after the fill; let it land
  // before a kebab click can hit a row being swapped out (v7.21.3).
  await expect(async () => {
    const a = await page.locator("#admin-participants-body tr").count();
    await page.waitForTimeout(250);
    expect(await page.locator("#admin-participants-body tr").count()).toBe(a);
  }).toPass({ timeout: 8000 });
  return row;
}

/**
 * Close a participants-row kebab with a NEUTRAL CLICK, never Escape. Escape
 * closes through `_escHandler`, which can leave the click-outside listener
 * attached to fire on the NEXT click — the one that opens the following row's
 * menu — so the menu opens and closes on the same click and reads as "never
 * opened" (participant-actions-matrix.spec.js, v7.21.3). A real outside click
 * runs the listener and tears it down, which is the state the next open needs.
 */
async function closeKebab(page) {
  await page.locator("#admin-participants-tab h2, #admin-participants-tab").first()
    .click({ position: { x: 2, y: 2 }, timeout: 3000 }).catch(() => {});
  await page.locator("#kebab-portal").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
}

/** Focus a named event from the Events tab (the scope banner is the readiness signal). */
async function focus(page, compName) {
  await clickTab(page, "Events");
  await viewComp(page, compName);
}

/**
 * Let every FINITE animation on `locator`'s element, its subtree and its
 * ancestors run out before a colour is read: `.picker-row` transitions its
 * border and background, an overlay may fade in, and a theme flip restarts
 * both — a computed colour read mid-transition is neither theme's. Infinite
 * ones (the live dot in a status badge) never finish, so they are skipped
 * rather than awaited; none of them animates a colour this reads.
 */
async function _settleAnimations(locator) {
  await locator.evaluate(el => {
    const anims = [...el.getAnimations({ subtree: true })];
    for (let n = el.parentElement; n; n = n.parentElement) anims.push(...n.getAnimations());
    return Promise.all(anims
      .filter(a => a.effect && a.effect.getComputedTiming().endTime !== Infinity)
      .map(a => a.finished.catch(() => {})));
  });
}

/**
 * v8.13.7 — an INACTIVE row (an event the actor competes in, a challenge the
 * event will not take) is MARKED, not faded: full strength, muted text, a
 * dashed edge; only its disabled box keeps the 50% fade (CLAUDE.md, *CSS
 * rules*: never dim a text-bearing surface with opacity). Read by value at
 * every picker that renders one (grep `expectInactiveRow(` for the sites), each
 * beside an ENABLED `control` row of the same dialog, so a build that mutes or
 * dashes EVERY row fails here too.
 *
 * `edge`: "all" for a row with a full border (the picker rows, a challenge's
 * Assign to Events dialog), "top" for the group's Events dialog, whose rows are
 * separated by a top rule only. `name`: the selector of the row's name element,
 * inside the row. `theme`: the theme the caller says the page is in — asserted
 * first, so a "dark pass" cannot silently read the light theme.
 *
 * Contrast is `textContrast` (ui-admin-helpers.js), not axe: axe skips the
 * label text of a disabled control, which is exactly where the name and the
 * reason flag sit.
 */
async function expectInactiveRow(row, control, { site, edge = "all", name = "strong", flag = ".picker-row-flag", theme = "light" } = {}) {
  if (!site) throw new Error("expectInactiveRow: name the dialog (`site`) so a failure says where");
  if (edge !== "all" && edge !== "top") throw new Error(`expectInactiveRow: unknown edge "${edge}"`);
  const at = `${site} [${theme}]`;
  await expect(row, `${at}: the inactive row rendered`).toBeVisible({ timeout: 15000 });
  await expect(control, `${at}: the CONTROL row rendered`).toBeVisible({ timeout: 15000 });
  expect(await row.evaluate(() => document.documentElement.dataset.theme), `${at}: PRECONDITION — the page really is in the ${theme} theme`).toBe(theme);
  await _settleAnimations(row);
  await _settleAnimations(control);

  // ── the inactive row ─────────────────────────────────────────────────────
  const m = await rowMarking(row);
  const seen = JSON.stringify(m);
  expect(m.muted, `${at}: the --muted probe resolved to a colour (${seen})`).toMatch(/^rgba?\(/);
  expect(m.opacity, `${at}: the inactive row is at FULL strength — never faded with opacity (${seen})`).toBe("1");
  expect(m.color, `${at}: its text is the --muted token (${seen})`).toBe(m.muted);
  expect(m.borderTopStyle, `${at}: its edge is DASHED (${seen})`).toBe("dashed");
  if (edge === "all") expect(m.borderLeftStyle, `${at}: …on every side, not just the top (${seen})`).toBe("dashed");
  expect(m.boxOpacity, `${at}: only its disabled BOX keeps the fade (${seen})`).toBe("0.5");

  const nameEl = row.locator(name).first();
  await expect(nameEl, `${at}: the row's name element (${name}) rendered`).toBeVisible();
  const nm = await rowMarking(nameEl);   // its own colour beside --muted, in its own cascade
  expect(nm.color, `${at}: the NAME itself renders muted — nothing re-colours it (${JSON.stringify(nm)})`).toBe(nm.muted);
  const flags = row.locator(flag);
  const n = await flags.count();
  expect(n, `${at}: the inactive row carries its reason flag (${flag})`).toBeGreaterThanOrEqual(1);
  const targets = [["name", nameEl]];
  for (let i = 0; i < n; i++) targets.push([`reason flag "${((await flags.nth(i).textContent()) || "").trim()}"`, flags.nth(i)]);
  for (const [what, loc] of targets) {
    const c = await textContrast(loc);
    const why = `ratio ${c.ratio}, fg ${JSON.stringify(c.fg)} on bg ${JSON.stringify(c.bg)}, opacity ${c.opacity}${c.unparsed ? `, UNPARSED ${c.unparsed}` : ""}`;
    expect(typeof c.ratio, `${at}: the ${what}'s colours could be read (${why})`).toBe("number");
    expect(c.opacity, `${at}: nothing above the ${what} fades it (${why})`).toBe(1);
    expect(c.ratio, `${at}: the ${what} reaches 4.5:1 against what is really behind it (${why})`).toBeGreaterThanOrEqual(4.5);
  }

  // ── the CONTROL row, same dialog ─────────────────────────────────────────
  const k = await rowMarking(control);
  const kseen = JSON.stringify(k);
  expect(k.opacity, `${at}: CONTROL — an enabled row is at full strength (${kseen})`).toBe("1");
  expect(k.color, `${at}: CONTROL — an enabled row's text is NOT the muted token (${kseen})`).not.toBe(k.muted);
  expect(k.borderTopStyle, `${at}: CONTROL — an enabled row's edge is not dashed (${kseen})`).not.toBe("dashed");
  if (edge === "all") expect(k.borderLeftStyle, `${at}: CONTROL — …on any side (${kseen})`).not.toBe("dashed");
  expect(k.boxOpacity, `${at}: CONTROL — an enabled box is not faded (${kseen})`).toBe("1");
}

/** Flip a page to the DARK theme through the OS preference (nothing is stored, so the app follows it live) and assert it took. */
async function toDarkTheme(page) {
  // Nothing stored is the house mode, which follows the OS too (HOUSE_MODE "system"); "system" is stored
  // so the page follows the OS live whatever that default becomes.
  const was = await page.evaluate(() => { try { const v = localStorage.getItem("hck-theme"); localStorage.setItem("hck-theme", "system"); return v; } catch (_) { return "unreadable"; } });
  expect([null, "system"], "PRECONDITION: no stored theme pin (nothing, or \"system\")").toContain(was);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme),
    { message: "the page followed the OS into the dark theme", timeout: 5000 }).toBe("dark");
}


module.exports = {
  buildFixture, disposeFixture, iso, attach, makeAdmin, tagStaff, tagComp, compRow, taskRow, participantAdminRow,
  adminPanel, eventRow, openEdit, saveEdit, challengeRow, participantRow, closeKebab, focus,
  expectInactiveRow, toDarkTheme,
  H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin,
  loginViaApi, formLogin, adminLogin, clickTab, openKebab, viewComp, filterComps, findSeededTaskRow, openCompCreateForm,
};
