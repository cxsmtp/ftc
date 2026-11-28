// @ts-check
//
// THE FULL EVENT EXPORT, BY VALUE: WHO IS IN IT, WHICH BOARD THEY ARE ON, AND NO
// CAPABILITY ANYWHERE (sweep gap #232; lib/full-export.js, GET
// /api/admin/competitions/:id/export/full).
//
// tests/event-full-export.api.spec.js holds the decoy event, sealed answers and
// formulas with two plain participants. This file builds every kind of person the
// builder treats differently, so a mistake in any rule lands in a cell:
//
//   TOURNAMENT `T`, two live sessions, per-session boards, Team Rankings on, staff
//   do NOT compete:
//     a1       enrolled directly, session A, solves the medium challenge (100)
//     g1, g2   only through bound groups G1 = {g1}, G2 = {g2}, session A; g1
//              solves the easy one (50), g2 answers it wrong (-5)
//     bench    enrolled, session A, solves (50), then tagged `benchmark`: kept,
//              labelled, on the board's benchmark section without a rank
//     b1       enrolled, session B, solves (50)
//     staffp   enrolled, session B, solves the medium one (100), then tagged
//              `staff`: in the export taken BEFORE the tag (the control); after
//              it, absent from participants, submissions, hints, feedback,
//              navigation, time and the main board
//     removed  enrolled, session B, answers wrong, then removed from the event:
//              kept (their submission stays), shown as not enrolled, on no board
//     hintonly enrolled, session B, takes a hint and answers nothing, then
//              removed: kept by the hint alone (removal keeps it), shown as not
//              enrolled, their hint in hints.csv, on no board
//     invited  registered through an invitation naming T, never plays: kept, and
//              their invitation's id appears nowhere
//   BOOTH EVENT `B`, ended with End Now, its late-entry window open:
//     o1       played while it was live (50): the main board, a gold certificate;
//              then, after the export the Booth test reads, tagged `staff`: a
//              second export drops them from participants, submissions, time and
//              the main board, and still lists their certificate, cell for cell
//              (an issued certificate is a fact)
//     late1    joined after the end and played: the late board, a participation
//              certificate
//   TOURNAMENT `S`, staff DO compete (its challenges sealed, as a compete event's
//   must be, by a promoted admin who is enrolled nowhere):
//     staffc   tagged `staff`, then enrolled (the assign door admits staff where
//              they compete) and plays: an answer, a hint, a rating, a bounce.
//              In participants, submissions, hints, feedback, navigation and
//              time; T's staffp, under the same rule with the switch off, is the
//              control
//
// Nobody solves every challenge in T or S (each has a hard one nobody answers),
// so the all-solved auto-end cannot fire; a Booth Event never auto-ends on
// all-solved. Every export is taken once, in beforeAll; each test reads its own
// files.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor } = require("./helpers");
// An event holds its OWN copy of each question (lib/event-copies.js); the files
// name the copies, compared here by the bank question each came from.
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, originOf } = require("./event-admin-helpers");
const yauzl = require("yauzl");
const Database = require("better-sqlite3");

/** Every entry of a ZIP buffer as { name: text }. */
function unzip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on("entry", (e) => {
        zip.openReadStream(e, (e2, s) => {
          if (e2) return reject(e2);
          const parts = [];
          s.on("data", (d) => parts.push(d));
          s.on("end", () => { out[e.fileName] = Buffer.concat(parts).toString("utf8"); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** A fully quoted CSV (lib/csv.js always quotes) → rows of cells. */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '"') { if (body[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const objects = (text) => { const r = parseCsv(text); return r.slice(1).map((x) => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))); };
const byId = (rows) => Object.fromEntries(rows.map((r) => [r["User ID"], r]));
const sortedIds = (rows) => rows.map((r) => r["User ID"]).sort();

function read(fn) {
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}

async function exportOf(sa, compId) {
  const r = await sa.get(`/api/admin/competitions/${compId}/export/full`);
  expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
  return unzip(await r.body());
}

let F;
test.beforeAll(async () => {
  const s = await apiLogin("superadmin");
  const sa = s.api, saCsrf = s.csrf;
  const tag = uniq("x").replace(/[^a-zA-Z0-9]/g, "");
  const tagUser = async (uid, t) => {
    const r = await sa.post(`/api/admin/participants/${uid}/tags`, { headers: H(saCsrf), data: { tag: t } });
    expect(r.ok(), `tag ${t}: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).tags, `the ${t} tag really landed`).toContain(t);
  };
  const removeFrom = async (compId, uid) => {
    const rm = await sa.delete(`/api/admin/competitions/${compId}/users/${uid}`, { headers: H(saCsrf) });
    expect(rm.status(), await rm.text()).toBe(200);
    expect((await rm.json()).removed, "PRECONDITION: really removed").toBe(true);
  };

  // ── TOURNAMENT T ──────────────────────────────────────────────────────────
  const T = await makeCompetition(sa, saCsrf, "fx-sets", { leaderboard_mode: "per_slot", group_leaderboard_enabled: true });
  const easy = await makeTask(sa, saCsrf, "fx-sets-easy", { difficulty: "easy", correct_answer: "easyright" });
  const med = await makeTask(sa, saCsrf, "fx-sets-med", { difficulty: "medium", correct_answer: "medright" });
  const hard = await makeTask(sa, saCsrf, "fx-sets-hard", { difficulty: "hard", correct_answer: "nobody", hint: "<p>a hint</p>" });
  for (const t of [easy, med, hard]) await assignTask(sa, saCsrf, t.id, [T.id]);
  const session = async (name, agoMs) => {
    const r = await sa.post(`/api/admin/competitions/${T.id}/timeslots`, { headers: H(saCsrf),
      data: { name, start_time: new Date(Date.now() - agoMs).toISOString(), duration_minutes: 300 } });
    expect(r.ok(), `add session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return { id: (await r.json()).timeslot.id, name };
  };
  const A = await session(`Morning ${tag}`, 120_000);
  const B = await session(`Evening ${tag}`, 60_000);

  const P = {};
  for (const k of ["a1", "g1", "g2", "bench", "b1", "staffp", "removed", "hintonly"]) P[k] = await makeParticipant(sa, saCsrf, `fxs-${k}`);
  // Group-only members: bound through two groups, never enrolled directly.
  const group = async (name, uid) => {
    const r = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name, userIds: [uid] } });
    expect(r.ok(), `create group ${name}: ${await r.text()}`).toBeTruthy();
    return { id: (await r.json()).group.id, name };
  };
  const G1 = await group(`Team One ${tag}`, P.g1.id);
  const G2 = await group(`Team Two ${tag}`, P.g2.id);
  const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [G1.id, G2.id], competitionIds: [T.id] } });
  expect(bind.ok(), `bind the groups: ${await bind.text()}`).toBeTruthy();
  await enrol(sa, saCsrf, T.id, [P.a1.id, P.bench.id, P.b1.id, P.staffp.id, P.removed.id, P.hintonly.id]);
  expect(read((db) => db.prepare("SELECT user_id, direct_assigned FROM competition_users WHERE competition_id=? AND user_id IN (?,?)").all(T.id, P.g1.id, P.g2.id)
    .map((r) => r.direct_assigned)), "PRECONDITION: g1 and g2 are members through their groups only").toEqual([0, 0]);

  // An account registered through an invitation naming T (never plays).
  const invEmail = `fxs-inv-${tag}@acme.com`.toLowerCase();
  const inv = await sa.post("/api/admin/invitations", { headers: H(saCsrf), data: { emails: [invEmail], competitionIds: [T.id] } });
  expect(inv.ok(), `invite: ${inv.status()} ${await inv.text()}`).toBeTruthy();
  const invitationId = read((db) => db.prepare("SELECT id FROM invitations WHERE email=?").get(invEmail)).id;
  expect(invitationId, "PRECONDITION: the invitation row").toBeTruthy();
  {
    const { api: anon, csrf } = await freshCtx();
    try {
      const reg = await registerPost(anon, "/api/register", { headers: H(csrf), data: {
        email: invEmail, invitationId, nickname: `fxsinv_${tag}`.slice(0, 40),
        firstName: "Invited", lastName: "Person", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London",
      } });
      expect(reg.ok(), `register the invited account: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    } finally { await anon.dispose(); }
  }
  const invitedRow = read((db) => db.prepare("SELECT id, invitation_id FROM users WHERE email=?").get(invEmail));
  expect(invitedRow && invitedRow.invitation_id, "PRECONDITION: the account carries its invitation's id").toBe(invitationId);
  P.invited = { id: invitedRow.id, email: invEmail };
  expect(read((db) => db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=? AND user_id=?").get(T.id, P.invited.id).n),
    "PRECONDITION: the invitation enrolled them in T").toBe(1);

  // Each step: an answer ({task, answer, correct}), a hint ({hint}), a rating
  // ({rate, rating}) or leaving a challenge unanswered ({away}).
  const play = async (who, compId, slot, steps) => {
    const l = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      const sel = await l.api.post("/api/select-competition", { headers: H(l.csrf), data: { competitionId: compId } });
      expect(sel.status(), await sel.text()).toBe(200);
      if (slot) {
        const ts = await l.api.post("/api/select-timeslot", { headers: H(l.csrf), data: { timeslotId: slot.id, confirmLive: true } });
        expect(ts.status(), await ts.text()).toBe(200);
        expect((await ts.json()).ok, `PRECONDITION: ${who.email} entered ${slot.name}`).toBe(true);
      }
      const hh = { ...H(l.csrf), "x-competition-id": compId };
      for (const a of steps) {
        if (a.hint) {
          const r = await l.api.post(`/api/tasks/${a.hint.id}/hint`, { headers: hh });
          expect(r.status(), `${who.email} takes a hint: ${await r.text()}`).toBe(200);
        } else if (a.rate) {
          const r = await l.api.put(`/api/tasks/${a.rate.id}/feedback`, { headers: hh, data: { rating: a.rating } });
          expect(r.status(), `${who.email} rates: ${await r.text()}`).toBe(200);
        } else if (a.away) {
          const r = await l.api.post(`/api/tasks/${a.away.id}/navigated-away`, { headers: hh, data: {} });
          expect(r.status(), await r.text()).toBe(200);
          expect(await r.json(), `${who.email} leaves a challenge unanswered (recorded, not skipped)`).toEqual({ ok: true });
        } else {
          const r = await l.api.post(`/api/tasks/${a.task.id}/submit`, {
            headers: hh, data: { answer: a.answer, gradingHash: await gradingHashFor(l.api, a.task.id) },
          });
          expect(r.status(), await r.text()).toBe(200);
          expect((await r.json()).correct, `${who.email}: ${a.answer}`).toBe(a.correct);
        }
      }
    } finally { await l.api.dispose(); }
  };
  await play(P.a1, T.id, A, [{ task: med, answer: "medright", correct: true }]);
  await play(P.g1, T.id, A, [{ task: easy, answer: "easyright", correct: true }]);
  await play(P.g2, T.id, A, [{ task: easy, answer: `nope-${tag}`, correct: false }, { away: hard }]);
  await play(P.bench, T.id, A, [{ task: easy, answer: "easyright", correct: true }]);
  await play(P.b1, T.id, B, [{ task: easy, answer: "easyright", correct: true }]);
  // Before the tag, the staff member leaves a trace in each file the tag must
  // clear: an answer, a hint (100 − 45 = 55, still ahead of b1), a rating, a
  // bounce (and so a row in participants, time and session B's board).
  await play(P.staffp, T.id, B, [{ task: med, answer: "medright", correct: true }, { hint: hard }, { rate: med, rating: 5 }, { away: hard }]);
  await play(P.removed, T.id, B, [{ task: easy, answer: `removed-${tag}`, correct: false }]);
  // hintonly's only act in T is a hint: once they are removed, it alone ties them to T.
  await play(P.hintonly, T.id, B, [{ hint: hard }]);

  await tagUser(P.bench.id, "benchmark");
  await removeFrom(T.id, P.removed.id);
  await removeFrom(T.id, P.hintonly.id);
  expect(read((db) => ["competition_users", "submissions", "hint_reveals"].map((tbl) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE competition_id=? AND user_id=?`).get(T.id, P.hintonly.id).n)),
  "PRECONDITION: hintonly is no longer enrolled and never answered, and the removal kept their one hint").toEqual([0, 0, 1]);

  // CONTROL export, then the staff tag, then the export under test.
  const before = await exportOf(sa, T.id);
  await tagUser(P.staffp.id, "staff");
  expect(read((db) => db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=? AND user_id=?").get(T.id, P.staffp.id).n),
    "PRECONDITION: the tag leaves their membership row in place, so only the export's rule can drop them").toBe(1);
  const tFiles = await exportOf(sa, T.id);

  // ── BOOTH EVENT B ─────────────────────────────────────────────────────────
  const Bk = await makeCompetition(sa, saCsrf, "fx-sets-booth", { event_kind: "booth", add_qualifying: false });
  const bt = await makeTask(sa, saCsrf, "fx-sets-booth-task", { difficulty: "easy", correct_answer: "boothright" });
  const bt2 = await makeTask(sa, saCsrf, "fx-sets-booth-task2", { difficulty: "easy", correct_answer: "boothother" });
  for (const t of [bt, bt2]) await assignTask(sa, saCsrf, t.id, [Bk.id]);
  P.o1 = await makeParticipant(sa, saCsrf, "fxs-o1");
  P.late1 = await makeParticipant(sa, saCsrf, "fxs-late1");
  await enrol(sa, saCsrf, Bk.id, [P.o1.id]);
  await play(P.o1, Bk.id, null, [{ task: bt, answer: "boothright", correct: true }]);
  const end = await sa.post(`/api/admin/competitions/${Bk.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.status(), await end.text()).toBe(200);
  await enrol(sa, saCsrf, Bk.id, [P.late1.id]);
  const lateRow = read((db) => db.prepare("SELECT cu.assigned_at, c.ended_at FROM competition_users cu JOIN competitions c ON c.id=cu.competition_id WHERE cu.competition_id=? AND cu.user_id=?").get(Bk.id, P.late1.id));
  expect(Date.parse(lateRow.assigned_at) > Date.parse(lateRow.ended_at), "PRECONDITION: late1 joined after the end").toBe(true);
  await play(P.late1, Bk.id, null, [{ task: bt, answer: "boothright", correct: true }]);
  for (const who of [P.o1, P.late1]) {
    const l = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      const m = await l.api.post(`/api/competitions/${Bk.id}/badge`, { headers: H(l.csrf), data: {} });
      expect(m.status(), `${who.email} collects a certificate: ${await m.text()}`).toBe(200);
    } finally { await l.api.dispose(); }
  }
  const badges = read((db) => db.prepare("SELECT user_id, token, public_code, basis FROM achievement_badges WHERE competition_id=?").all(Bk.id));
  expect(badges.map((b) => [b.user_id, b.basis]).sort(), "PRECONDITION: a gold for o1, participation for the late entrant")
    .toEqual([[P.o1.id, "placement"], [P.late1.id, "participation"]].sort());
  for (const b of badges) expect([b.token.length > 20, /^[0-9A-Z]{12}$/.test(b.public_code)], "PRECONDITION: a real token and code").toEqual([true, true]);
  const bFiles = await exportOf(sa, Bk.id);
  // Now o1, holding their gold, is tagged `staff` (B does not let staff
  // compete): they leave the participant set, and their certificate stays.
  await tagUser(P.o1.id, "staff");
  expect(read((db) => [
    db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=? AND user_id=?").get(Bk.id, P.o1.id).n,
    db.prepare("SELECT COUNT(*) AS n FROM achievement_badges WHERE competition_id=? AND user_id=? AND revoked_at IS NULL").get(Bk.id, P.o1.id).n,
  ]), "PRECONDITION: the tag leaves their membership and their certificate in place, so only the export's rule can drop them").toEqual([1, 1]);
  const bStaffFiles = await exportOf(sa, Bk.id);

  // ── TOURNAMENT S: staff DO compete ────────────────────────────────────────
  // A compete event holds sealed challenges only, and sealing needs a
  // user-backed author (the built-in superadmin has no users row): a promoted
  // admin, enrolled nowhere, writes and assigns them.
  const authorP = await makeParticipant(sa, saCsrf, "fxs-author");
  const promo = await sa.post(`/api/admin/participants/${authorP.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(promo.ok(), `promote the author: ${promo.status()} ${await promo.text()}`).toBeTruthy();
  const S = await makeCompetition(sa, saCsrf, "fx-sets-compete", { staff_compete: true });
  let s1, s2;
  {
    const author = await apiLogin(authorP.email, PARTICIPANT_PASS);
    try {
      s1 = await makeTask(author.api, author.csrf, "fx-sets-sc-easy", { difficulty: "easy", correct_answer: "scright", answer_sealed: true });
      s2 = await makeTask(author.api, author.csrf, "fx-sets-sc-hard", { difficulty: "hard", correct_answer: "scnobody", hint: "<p>a sealed hint</p>", answer_sealed: true });
      for (const t of [s1, s2]) await assignTask(author.api, author.csrf, t.id, [S.id]);
    } finally { await author.api.dispose(); }
  }
  P.staffc = await makeParticipant(sa, saCsrf, "fxs-staffc");
  await tagUser(P.staffc.id, "staff");
  await enrol(sa, saCsrf, S.id, [P.staffc.id]);
  expect(read((db) => [
    db.prepare("SELECT staff_compete FROM competitions WHERE id=?").get(S.id).staff_compete,
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id IN (?,?) AND answer_sealed=1").get(s1.id, s2.id).n,
    db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=?").get(S.id).n,
  ]), "PRECONDITION: S lets staff compete, holds two sealed challenges and one member").toEqual([1, 2, 1]);
  await play(P.staffc, S.id, null, [{ task: s1, answer: "scright", correct: true }, { hint: s2 }, { rate: s1, rating: 4 }, { away: s2 }]);
  const sFiles = await exportOf(sa, S.id);

  const caps = read((db) => db.prepare("SELECT id, self_enroll_token, join_code FROM competitions WHERE id IN (?,?,?)").all(T.id, Bk.id, S.id));
  expect(caps.length, "PRECONDITION: all three events").toBe(3);
  for (const c of caps) expect([!!c.self_enroll_token, !!c.join_code], `PRECONDITION: ${c.id} has a join token and code`).toEqual([true, true]);
  F = { sa, T, Bk, S, A, B, G1, G2, P, easy, med, hard, s1, s2, before, tFiles, bFiles, bStaffFiles, sFiles, badges, caps, invitationId, tag };
});
test.afterAll(async () => { try { await F.sa.dispose(); } catch (_) {} });

test.describe("sweep #232 — the full event export, by value", () => {
  test("participants: the enrolled, the removed who answered or only took a hint, and the invited are in; staff where they do not compete are out of participants, submissions, hints, feedback, navigation, time and the main board, and were in each before the tag (CONTROL); benchmark is kept and labelled", () => {
    const { P, tFiles, before, A, B } = F;
    const people = objects(tFiles["participants.csv"]);
    const want = [P.a1, P.g1, P.g2, P.bench, P.b1, P.removed, P.hintonly, P.invited].map((p) => p.id).sort();
    expect(sortedIds(people), "exactly these people").toEqual(want);
    const row = byId(people);
    expect([row[P.a1.id].Enrolled, row[P.a1.id]["Added Directly"], row[P.a1.id].Session]).toEqual(["Yes", "Yes", A.name]);
    expect([row[P.g1.id].Enrolled, row[P.g1.id]["Added Directly"], row[P.g1.id].Session], "a group-only member").toEqual(["Yes", "No", A.name]);
    expect([row[P.b1.id].Session, row[P.bench.id].Session]).toEqual([B.name, A.name]);
    expect([row[P.removed.id].Enrolled, row[P.removed.id]["Assigned At"], row[P.removed.id].Session, row[P.removed.id]["Added Directly"]],
      "the removed participant is kept, shown as no longer enrolled").toEqual(["No", "", "", ""]);
    expect([row[P.hintonly.id].Enrolled, row[P.hintonly.id]["Assigned At"], row[P.hintonly.id].Session, row[P.hintonly.id]["Added Directly"]],
      "the removed participant whose only act was a hint is kept by it, shown as no longer enrolled").toEqual(["No", "", "", ""]);
    expect([row[P.invited.id].Enrolled, row[P.invited.id]["Solve Clock Start"]], "the invited, never-entered member").toEqual(["Yes", ""]);
    expect(row[P.bench.id].Tags.split("; "), "benchmark is labelled").toContain("benchmark");
    expect(row[P.a1.id].Tags, "CONTROL: an ordinary participant carries no such label").not.toContain("benchmark");
    for (const p of people) expect(p["Late Entrant"], `${p["User ID"]}: a tournament has no late entrants`).toBe("");

    // Staff (T does not let them compete), by value, in each file the tag must
    // clear (the participant set decides six of them, the board builder the
    // main board); and, as the CONTROL, present in each of them in the export
    // taken before the tag. certificates.csv is not among them: an issued
    // certificate stays listed (its own test, below).
    for (const f of ["participants.csv", "submissions.csv", "hints.csv", "feedback.csv", "navigation.csv", "time.csv", "rankings-main.csv"]) {
      expect(objects(before[f]).some((r) => r["User ID"] === P.staffp.id), `CONTROL: ${f} had the staff member before the tag`).toBe(true);
      expect(tFiles[f], `${f}: the staff member is absent`).not.toContain(P.staffp.id);
      expect(tFiles[f], `${f}: by address too`).not.toContain(P.staffp.email);
    }
    expect(sortedIds(objects(before["participants.csv"]))).toEqual([...want, P.staffp.id].sort());
    const hintRows = (files) => objects(files["hints.csv"]).map((h) => [h["User ID"], originOf(h["Challenge Ref"]), h["Points Deducted"], h.Session]);
    expect(hintRows(before).sort(), "CONTROL: the staff member's hint, and the removed hint-taker's")
      .toEqual([[P.staffp.id, F.hard.id, "45", B.name], [P.hintonly.id, F.hard.id, "45", B.name]].sort());
    expect(hintRows(tFiles), "after the tag: the removed hint-taker's hint alone").toEqual([[P.hintonly.id, F.hard.id, "45", B.name]]);
    expect(objects(before["feedback.csv"]).map((x) => [x["User ID"], originOf(x["Challenge Ref"]), x.Rating]), "CONTROL: their rating").toEqual([[P.staffp.id, F.med.id, "5"]]);
    expect(objects(tFiles["feedback.csv"]), "after the tag nobody else rated").toEqual([]);
    // navigation.csv: the bounce of a participant is kept, the staff member's is not.
    expect(objects(tFiles["navigation.csv"]).map((x) => [x["User ID"], originOf(x["Challenge Ref"]), x["Navigated Away"]]), "navigation: g2's bounce")
      .toEqual([[P.g2.id, F.hard.id, "1"]]);
    expect(objects(before["navigation.csv"]).map((x) => x["User ID"]).sort(), "CONTROL: both bounces before the tag").toEqual([P.g2.id, P.staffp.id].sort());

    // Submissions and time follow the same set: the removed participant's answer stays.
    const subs = objects(tFiles["submissions.csv"]);
    expect([...new Set(subs.map((s) => s["User ID"]))].sort(), "submissions: everyone who answered, staff excepted")
      .toEqual([P.a1, P.g1, P.g2, P.bench, P.b1, P.removed].map((p) => p.id).sort());
    const rs = subs.filter((s) => s["User ID"] === P.removed.id);
    expect(rs.map((s) => [s.Answer, s.Correct, s.Session]), "the removed participant's answer, with its session").toEqual([[`removed-${F.tag}`, "No", B.name]]);
    expect(sortedIds(objects(tFiles["time.csv"])), "time.csv: the same set as participants.csv").toEqual(want);
  });

  test("rankings: one board per session, the benchmark row in its own unranked section, the removed and staff on none; Team Rankings rows for the session whose groups have members; no late section for a tournament", () => {
    const { P, tFiles, before, A, B, G1, G2 } = F;
    const main = objects(tFiles["rankings-main.csv"]).map((r) => [r.Session, r.Section, r.Rank, r["User ID"], r.Score]);
    expect(main.sort(), "the main boards, by value").toEqual([
      [A.name, "main", "1", P.a1.id, "100"],
      [A.name, "main", "2", P.g1.id, "50"],
      [A.name, "main", "3", P.g2.id, "'-5"],
      [A.name, "benchmark", "", P.bench.id, "50"],
      [B.name, "main", "1", P.b1.id, "50"],
    ].sort());
    // CONTROL: before the tag the staff member led session B.
    const bBefore = objects(before["rankings-main.csv"]).filter((r) => r.Session === B.name).map((r) => [r.Rank, r["User ID"]]);
    expect(bBefore.sort(), "CONTROL: session B before the staff tag").toEqual([["1", P.staffp.id], ["2", P.b1.id]].sort());

    const groups = objects(tFiles["rankings-groups.csv"]).map((r) => [r.Session, r.Rank, r["Row Type"], r["Group or Nickname"], r.Members, r["Avg Score"]]);
    expect(groups, "Team Rankings: session A's two teams and its one direct participant; session B has no team with a member").toEqual([
      [A.name, "1", "individual", P.a1.nickname, "1", "100"],
      [A.name, "2", "group", G1.name, "1", "50"],
      [A.name, "3", "group", G2.name, "1", "'-5"],
    ]);
    expect(objects(tFiles["rankings-late.csv"]), "no late entrants in a tournament").toEqual([]);

    const ev = Object.fromEntries(parseCsv(tFiles["event.csv"]).slice(1));
    expect([ev.Sessions, ev["Leaderboard Mode"], ev["Staff Compete"]]).toEqual(["2", "per_slot", "No"]);
  });

  test("a Booth Event ended with its late window open: the late entrant on the late board and marked late, the participant who played while live on the main board; certificates by value", () => {
    const { P, bFiles } = F;
    const people = objects(bFiles["participants.csv"]);
    expect(sortedIds(people)).toEqual([P.o1.id, P.late1.id].sort());
    const row = byId(people);
    expect([row[P.o1.id]["Late Entrant"], row[P.late1.id]["Late Entrant"]], "only the one who joined after the end is late").toEqual(["No", "Yes"]);
    expect(objects(bFiles["rankings-main.csv"]).map((r) => [r.Session, r.Section, r.Rank, r["User ID"]]), "the main board").toEqual([["All", "main", "1", P.o1.id]]);
    expect(objects(bFiles["rankings-late.csv"]).map((r) => [r.Session, r.Rank, r["User ID"], r.Score]), "the late board").toEqual([["All", "1", P.late1.id, "50"]]);
    const certs = objects(bFiles["certificates.csv"]).map((r) => [r["User ID"], r.Basis, r.Rank, r["Late Entrant"]]);
    expect(certs.sort(), "one row per certificate").toEqual([[P.o1.id, "placement", "1", "No"], [P.late1.id, "participation", "1", "Yes"]].sort());
  });

  test("an issued certificate stays listed: tagged staff after collecting a gold, its holder leaves participants, submissions, time and the main board (each held them before the tag: CONTROL), while certificates.csv keeps their certificate's row cell for cell", () => {
    const { P, bFiles, bStaffFiles } = F;
    for (const f of ["participants.csv", "submissions.csv", "time.csv", "rankings-main.csv"]) {
      expect(objects(bFiles[f]).some((r) => r["User ID"] === P.o1.id), `CONTROL: ${f} had o1 before the tag`).toBe(true);
      expect(bStaffFiles[f], `${f}: o1 is absent after the tag`).not.toContain(P.o1.id);
      expect(bStaffFiles[f], `${f}: by address too`).not.toContain(P.o1.email);
    }
    expect(sortedIds(objects(bStaffFiles["participants.csv"])), "CONTROL: the untagged late entrant is still listed").toEqual([P.late1.id]);
    // The certificate's row, by its token-free values (the file has no token or
    // code column): the same row as before the tag, the nickname included,
    // which now comes from the one frozen at issue.
    const certOf = (files, id) => objects(files["certificates.csv"]).filter((r) => r["User ID"] === id);
    const was = certOf(bFiles, P.o1.id);
    expect(was.map((r) => [r.Nickname, r.Basis, r.Rank, r.Score, r["Late Entrant"], r["Revoked At"]]), "PRECONDITION: o1's gold, under their nickname")
      .toEqual([[P.o1.nickname, "placement", "1", "50", "No", ""]]);
    expect(certOf(bStaffFiles, P.o1.id), "o1's certificate, unchanged after the tag").toEqual(was);
    expect(certOf(bStaffFiles, P.late1.id), "CONTROL: the late entrant's certificate, unchanged too").toEqual(certOf(bFiles, P.late1.id));
    expect(objects(bStaffFiles["certificates.csv"]).length, "no other row").toBe(2);
  });

  test("staff where the event lets them compete are kept: a staff-tagged competitor is in participants, submissions, hints, feedback, navigation and time, by value; CONTROL: on T, where staff do not compete, its tagged member is in none of them", () => {
    const { P, sFiles, tFiles, s1, s2 } = F;
    const ev = Object.fromEntries(parseCsv(sFiles["event.csv"]).slice(1));
    expect(ev["Staff Compete"], "PRECONDITION: S lets staff compete").toBe("Yes");
    const people = objects(sFiles["participants.csv"]);
    expect(people.map((p) => [p["User ID"], p.Enrolled, p["Added Directly"]]), "the staff competitor, enrolled").toEqual([[P.staffc.id, "Yes", "Yes"]]);
    expect(people[0].Tags.split("; "), "…and labelled staff").toContain("staff");
    expect(objects(sFiles["submissions.csv"]).map((x) => [x["User ID"], originOf(x["Challenge Ref"]), x.Correct, x["Points Delta"]]), "their answer")
      .toEqual([[P.staffc.id, s1.id, "Yes", "50"]]);
    expect(objects(sFiles["hints.csv"]).map((x) => [x["User ID"], originOf(x["Challenge Ref"]), x["Points Deducted"]]), "their hint")
      .toEqual([[P.staffc.id, s2.id, "45"]]);
    expect(objects(sFiles["feedback.csv"]).map((x) => [x["User ID"], originOf(x["Challenge Ref"]), x.Rating]), "their rating")
      .toEqual([[P.staffc.id, s1.id, "4"]]);
    expect(objects(sFiles["navigation.csv"]).map((x) => [x["User ID"], originOf(x["Challenge Ref"]), x["Navigated Away"]]), "their bounce")
      .toEqual([[P.staffc.id, s2.id, "1"]]);
    expect(sortedIds(objects(sFiles["time.csv"])), "time.csv: the same set as participants.csv").toEqual([P.staffc.id]);
    // CONTROL: the switch off, the same rule keeps T's staff-tagged member out.
    expect(Object.fromEntries(parseCsv(tFiles["event.csv"]).slice(1))["Staff Compete"], "CONTROL: T does not let staff compete").toBe("No");
    for (const f of ["participants.csv", "submissions.csv", "hints.csv", "feedback.csv", "navigation.csv", "time.csv"]) {
      expect(objects(tFiles[f]).some((r) => r["User ID"] === P.staffp.id), `CONTROL: T's ${f} leaves its staff member out`).toBe(false);
    }
  });

  test("no file carries a capability: no certificate token or credential code, no join token or code, no invitation id", () => {
    const { tFiles, bFiles, bStaffFiles, sFiles, before, badges, caps, invitationId } = F;
    const blobs = {
      "T": Object.values(tFiles).join("\n"), "T (before the tag)": Object.values(before).join("\n"), "B": Object.values(bFiles).join("\n"),
      "B (after o1's staff tag)": Object.values(bStaffFiles).join("\n"), "S": Object.values(sFiles).join("\n"),
    };
    // Long random values by substring. A short code by itself as a token (it is
    // uppercase letters and digits, and a 6-character join code made only of
    // digits could otherwise sit inside a longer number by chance).
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const asToken = (v) => new RegExp(`(^|[^0-9A-Za-z])${escRe(v)}([^0-9A-Za-z]|$)`);
    const secrets = [
      ...badges.flatMap((b) => [[`certificate token of ${b.user_id}`, b.token, false], [`credential code of ${b.user_id}`, b.public_code, true],
        [`printed credential code of ${b.user_id}`, `${b.public_code.slice(0, 4)}-${b.public_code.slice(4, 8)}-${b.public_code.slice(8)}`, true]]),
      ...caps.flatMap((c) => [[`join token of ${c.id}`, c.self_enroll_token, false], [`join code of ${c.id}`, c.join_code, true]]),
      ["invitation id", invitationId, false],
    ];
    for (const [where, text] of Object.entries(blobs)) {
      for (const [what, v, short] of secrets) expect(short ? asToken(v).test(text) : text.includes(v), `${where}: ${what}`).toBe(false);
    }
    // The token form still finds a code where it would sit as a cell.
    expect(asToken(caps[0].join_code).test(`"x","${caps[0].join_code}","y"`), "anti-vacuity: the match finds a code in a cell").toBe(true);
    // CONTROL: the archives do name the certificate holders and the events.
    expect(blobs.B).toContain(badges[0].user_id);
    expect(blobs.T).toContain(F.T.id);
  });
});
