// PROGRAM GRADES (owner decision, 27 Nov 2026).
//
// A Program is not a competition: every learner gets a certificate by their
// performance on the challenges, 90% Excellent, 80% Very good, 70% Good, 60%
// Satisfactory, and under 60% no certificate: they are told to try again, and
// may. lib/program-grade.js is the rule; routes/badge.js `_mintEligibility` the
// one eligibility predicate; `program_attempts` holds a closed attempt.
//
// Locked here, by value:
//   * the bands at their boundaries (59.9, 60, 70, 80, 90), the floor and cap;
//   * wrong-answer penalties and hints lower the grade; a qualifying (Quick)
//     question is in neither the points nor the maximum;
//   * at 60% the certificate is issued with the band frozen on it; under 60% it
//     is refused, Try again closes the attempt (its rows kept in
//     `program_attempts`, the Quick answer left live), the new attempt is scored
//     alone and a passing retake earns the certificate;
//   * Try again is refused to a passed learner, an unfinished one, a ranked kind
//     and under impersonation;
//   * the artwork changes by band and a certificate without a grade renders as
//     it always did (rendered, never scanned);
//   * the organisers' grades list and the full export's grades.csv.
const { test, expect } = require("./isolated-test");
const { apiLogin, registerPost, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `pg${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

function unzip(buf) {
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on("entry", (e) => {
        zip.openReadStream(e, (e2, st) => {
          if (e2) return reject(e2);
          const parts = [];
          st.on("data", (d) => parts.push(d));
          st.on("end", () => { out[e.fileName] = Buffer.concat(parts).toString("utf8"); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

const sql = (fn, opts = { readonly: true }) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
};

let sa, saCsrf;
const sessions = [];
test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
test.afterAll(async () => {
  for (const a of [sa, ...sessions]) { try { await a.dispose(); } catch (e) { console.warn("dispose failed:", e && e.message); } }
});

async function makeLearner() {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api, csrf } = await freshCtx();
  sessions.push(api);
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: { firstName: "Grace", lastName: `Grade${label}`, nickname: label, email, company: "Acme", title: "Engineer",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville" },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  const list = await (await sa.get(`/api/admin/participants?limit=500`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, "learner findable").toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
  return { id: u.id, email };
}

/** A live event of `kind` with `diffs` scoring challenges (text answers right<i>), learners enrolled. */
async function makeEvent(kind, diffs, learners, { addQualifying = false, caps = [] } = {}) {
  const data = { name: `${uniq()} ${kind}`, event_kind: kind, start_time: new Date(Date.now() - 3600e3).toISOString(), timezone: "UTC" };
  if (kind === "program") { data.deadline_at = new Date(Date.now() + 90 * 86400e3).toISOString(); data.add_qualifying = addQualifying; }
  else data.duration_minutes = 600;
  const cr = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data });
  expect(cr.ok(), `create: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;
  const tasks = [];
  for (let i = 0; i < diffs.length; i++) {
    const tr = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      title: `${uniq()} T${i}`, description: "d", difficulty: diffs[i], answer_type: "text",
      correct_answer: `right${i}`, hint: "<p>a hint</p>", status: "published", ...(caps[i] ? { attempt_cap: caps[i] } : {}) } });
    expect(tr.ok(), await tr.text()).toBeTruthy();
    const id = (await tr.json()).id;
    const asg = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(saCsrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
    tasks.push({ id: (await asg.json()).copies[0].task_id, answer: `right${i}` });
  }
  const asg = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: learners.map(l => l.id), competitionIds: [comp.id] } });
  expect(asg.ok(), await asg.text()).toBeTruthy();
  expect((await asg.json()).assigned, "every learner assigned").toBe(learners.length);
  return { comp, tasks };
}

async function enter(p, compId) {
  if (!p.s) { p.s = await apiLogin(p.email, PARTICIPANT_PASS); sessions.push(p.s.api); }
  const r = await p.s.api.post("/api/select-competition", { headers: H(p.s.csrf), data: { competitionId: compId } });
  expect(r.ok(), `select: ${await r.text()}`).toBeTruthy();
  return p.s;
}
async function answer(p, compId, taskId, value) {
  const s = await enter(p, compId);
  const v = await s.api.get(`/api/tasks/${taskId}`, { headers: { "x-competition-id": compId } });
  expect(v.ok(), `view: ${await v.text()}`).toBeTruthy();
  const r = await s.api.post(`/api/tasks/${taskId}/submit`, {
    headers: { ...H(s.csrf), "x-competition-id": compId }, data: { answer: value, gradingHash: (await v.json()).grading_hash || "" } });
  expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}
async function hint(p, compId, taskId) {
  const s = await enter(p, compId);
  const r = await s.api.post(`/api/tasks/${taskId}/hint`, { headers: { ...H(s.csrf), "x-competition-id": compId } });
  expect(r.ok(), `hint: ${r.status()} ${await r.text()}`).toBeTruthy();
}
// Distinct wrong answers (a repeat inside 3 s is folded and charges nothing).
async function wrongs(p, compId, taskId, n) { for (let i = 0; i < n; i++) await answer(p, compId, taskId, `wrong-${i}-${uniq()}`); }
async function mint(p, compId) {
  const s = await enter(p, compId);
  const r = await s.api.post(`/api/competitions/${compId}/badge`, { headers: H(s.csrf) });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}
async function standing(p, compId) {
  const s = await enter(p, compId);
  const r = await s.api.get("/api/me/certificates");
  expect(r.ok()).toBeTruthy();
  return ((await r.json()).programs || []).find(x => x.competitionId === compId) || null;
}
async function retake(p, compId) {
  const s = await enter(p, compId);
  const r = await s.api.post(`/api/competitions/${compId}/program/retake`, { headers: H(s.csrf), data: {} });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}
const scoringRows = (compId, userId) => sql(db => db.prepare(
  `SELECT COUNT(*) AS c FROM submissions s WHERE s.competition_id=? AND s.user_id=?
     AND NOT EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id=s.task_id AND tt.tag LIKE 'qualifying:%')`).get(compId, userId).c);

test.describe("Program grades — the rule", () => {
  test("bands are inclusive at their lower edge and decided on the exact fraction; the share is rounded down", () => {
    const PG = require("../lib/program-grade");
    const at = (p, m) => { const g = PG.gradeFromPoints(p, m); return [g.band, g.permille, g.passed]; };
    expect(at(599, 1000), "59.9%: try again").toEqual(["try_again", 599, false]);
    expect(at(600, 1000), "60%: satisfactory").toEqual(["satisfactory", 600, true]);
    expect(at(699, 1000)).toEqual(["satisfactory", 699, true]);
    expect(at(700, 1000), "70%: good").toEqual(["good", 700, true]);
    expect(at(799, 1000)).toEqual(["good", 799, true]);
    expect(at(800, 1000), "80%: very good").toEqual(["very_good", 800, true]);
    expect(at(899, 1000)).toEqual(["very_good", 899, true]);
    expect(at(900, 1000), "90%: excellent").toEqual(["excellent", 900, true]);
    expect(at(1000, 1000)).toEqual(["excellent", 1000, true]);
    // Exactness: 2/3 of a point short of 60% is not 60%, and a share shown as
    // 59.9% never reads as a pass.
    expect(at(1799, 3000), "59.966…%").toEqual(["try_again", 599, false]);
    expect(at(1800, 3000)).toEqual(["satisfactory", 600, true]);
    expect(PG.gradeFromPoints(-40, 100), "a negative score is floored at 0").toMatchObject({ points: 0, permille: 0, band: "try_again" });
    expect(PG.gradeFromPoints(130, 100), "capped at the maximum").toMatchObject({ points: 100, permille: 1000, band: "excellent" });
    expect(PG.gradeFromPoints(10, 0), "nothing to grade against").toBeNull();
    expect([PG.formatGradePercent(599), PG.formatGradePercent(600), PG.formatGradePercent(1000)]).toEqual(["59.9%", "60%", "100%"]);
    expect(PG.GRADE_BAND_KEYS, "the design's band labels are the bands")
      .toEqual(require("../lib/certificate-config").GRADE_LABEL_KEYS);
  });

  test("the artwork changes by band and prints the percentage; a completion certificate without a grade is unchanged (rendered)", async () => {
    const B = require("../lib/badge");
    const base = { platformName: "Hack Arena", rank: 4, basis: "completion", competitionName: "Secure Coding 101",
      displayName: "Grace Hopper", dateLabel: "1 Dec 2026", publicCode: "ABCDEFGHJKMN", verifyUrl: "x.example/credential" };
    const svg = (grade) => B.buildCertificateSvg({ ...base, grade });
    const none = svg(null);
    expect(none, "ungraded: the completion wording, as before").toContain(">Completed<");
    expect(none).not.toContain("GRADE");
    expect(svg(undefined), "absent is the same as none").toBe(none);
    const ex = svg({ band: "excellent", label: "Excellent", percent: "94%" });
    const vg = svg({ band: "very_good", label: "Very good", percent: "85%" });
    expect(ex).toContain(">Excellent<");
    expect(ex).toContain(">94%<");
    expect(ex).toContain(">GRADE<");
    expect(ex).not.toContain(">Completed<");
    expect(vg).toContain(">Very good<");
    // A grade on any other basis is ignored: only a completion certificate is graded.
    const part = { ...base, basis: "participation" };
    expect(B.buildCertificateSvg({ ...part, grade: { band: "excellent", label: "Excellent", percent: "94%" } }))
      .toBe(B.buildCertificateSvg(part));
    // Rendered: each is drawn the same twice, and the three differ.
    try {
      const [a1, a2, b, c] = await Promise.all([B.renderBadgePng(none), B.renderBadgePng(none), B.renderBadgePng(ex), B.renderBadgePng(vg)]);
      expect(Buffer.compare(a1, a2), "byte-identical twice (control)").toBe(0);
      expect(Buffer.compare(a1, b), "ungraded and Excellent differ").not.toBe(0);
      expect(Buffer.compare(b, c), "Excellent and Very good differ").not.toBe(0);
    } catch (e) {
      if (e instanceof B.BadgeRenderUnavailable) test.skip(true, "badge renderer unavailable here");
      throw e;
    }
    // The share card names the band too.
    const card = B.buildBadgeSvg({ ...base, grade: { band: "good", label: "Good", percent: "72%" } });
    expect(card).toContain(">Good<");
    expect(card).toContain(">72%<");
    expect(B.buildBadgeSvg(base), "an ungraded card is unchanged").toContain(">Completed<");
  });
});

test.describe("Program grades — certificate and Try again", () => {
  test("penalties and hints lower the grade, a Quick question is outside it; 60% is issued with its band frozen", async () => {
    const L = await makeLearner();
    const { comp, tasks } = await makeEvent("program", ["medium"], [L], { addQualifying: true });
    const quick = sql(db => db.prepare(
      `SELECT t.id, t.choices FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
         JOIN task_tags tt ON tt.task_id=t.id AND tt.tag LIKE 'qualifying:%' WHERE ct.competition_id=?`).all(comp.id));
    expect(quick.length, "PRECONDITION: the Program asks quick questions").toBeGreaterThan(0);
    // One quick answer: scores 0, and its maximum is not counted.
    await answer(L, comp.id, quick[0].id, JSON.stringify([JSON.parse(quick[0].choices)[0].id]));
    let st = await standing(L, comp.id);
    expect(st.grade, "nothing earned yet: 0 of the one scoring challenge's 100").toMatchObject({ points: 0, max: 100, permille: 0 });
    expect(st.finished).toBe(false);
    expect((await mint(L, comp.id)).body.code, "unfinished: no certificate").toBe("not_completed");
    await hint(L, comp.id, tasks[0].id);                 // −30
    await wrongs(L, comp.id, tasks[0].id, 2);           // −10
    await answer(L, comp.id, tasks[0].id, tasks[0].answer); // +100
    st = await standing(L, comp.id);
    expect(st.grade, "100 − 30 − 10 = 60 of 100").toMatchObject({ points: 60, max: 100, permille: 600, band: "satisfactory", passed: true, percent: "60%" });
    expect(st.finished).toBe(true);
    expect(st.canRetake, "a pass is not taken again").toBe(false);
    const m = await mint(L, comp.id);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.grade, "the mint answer names the grade").toMatchObject({ band: "satisfactory", label: "Satisfactory", percent: "60%" });
    const row = sql(db => db.prepare("SELECT basis, grade_band, grade_permille FROM achievement_badges WHERE user_id=? AND competition_id=?").get(L.id, comp.id));
    expect(row, "frozen on the certificate").toEqual({ basis: "completion", grade_band: "satisfactory", grade_permille: 600 });
    const r = await retake(L, comp.id);
    expect(r.status, "a passed learner may not retake").toBe(409);
    expect(r.body.code).toBe("program_passed");
    // The holder's list and the organisers' list carry it.
    const held = (await (await L.s.api.get("/api/me/certificates")).json()).certificates.find(c => c.competitionId === comp.id);
    expect(held.grade).toMatchObject({ band: "satisfactory", percent: "60%" });
    const adm = await (await sa.get(`/api/admin/competitions/${comp.id}/certificates`)).json();
    expect(adm.certificates.find(c => c.userId === L.id).grade).toMatchObject({ band: "satisfactory", permille: 600 });
    // The organisers' grades list.
    const g = await sa.get(`/api/admin/competitions/${comp.id}/grades`);
    expect(g.ok(), await g.text()).toBeTruthy();
    const gd = await g.json();
    expect(gd.maxPoints).toBe(100);
    expect(gd.rows.find(x => x.userId === L.id)).toMatchObject({ finished: true, grade: { permille: 600, band: "satisfactory" }, certificate: { grade: { band: "satisfactory" } } });
  });

  test("under 60% no certificate; Try again keeps the old rows, scores the new attempt alone and a passing retake is issued", async () => {
    const L = await makeLearner();
    const { comp, tasks } = await makeEvent("program", ["medium"], [L], { addQualifying: true });
    const quick = sql(db => db.prepare(
      `SELECT t.id, t.choices FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
         JOIN task_tags tt ON tt.task_id=t.id AND tt.tag LIKE 'qualifying:%' WHERE ct.competition_id=?`).all(comp.id));
    await answer(L, comp.id, quick[0].id, JSON.stringify([JSON.parse(quick[0].choices)[0].id]));
    expect((await retake(L, comp.id)).body.code, "unfinished: nothing to retake").toBe("program_not_finished");
    await hint(L, comp.id, tasks[0].id);                 // −30
    await wrongs(L, comp.id, tasks[0].id, 3);           // −15
    await answer(L, comp.id, tasks[0].id, tasks[0].answer); // +100 → 55
    let st = await standing(L, comp.id);
    expect(st.grade, "55%: try again").toMatchObject({ points: 55, permille: 550, band: "try_again", passed: false });
    expect(st.finished).toBe(true);
    expect(st.canRetake).toBe(true);
    const m = await mint(L, comp.id);
    expect(m.status).toBe(403);
    expect(m.body.code).toBe("grade_below_pass");
    expect(m.body.error).toContain("55%");
    // The automatic issue refuses it too.
    const tick = await sa.post("/api/test/certificate-dispatch-tick", { headers: H(saCsrf), data: { force: true, competitionId: comp.id } });
    expect(tick.ok(), await tick.text()).toBeTruthy();
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM achievement_badges WHERE competition_id=?").get(comp.id).c), "nothing issued under 60%").toBe(0);

    expect(scoringRows(comp.id, L.id), "PRECONDITION: four scoring answers live").toBe(4);
    const r = await retake(L, comp.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, attempt: 2, closed: { attempt: 1, points: 55, permille: 550, band: "try_again" } });
    // Nothing is deleted: the attempt's rows moved to program_attempts, whole.
    const closed = sql(db => db.prepare("SELECT * FROM program_attempts WHERE competition_id=? AND user_id=?").all(comp.id, L.id));
    expect(closed.length).toBe(1);
    expect(closed[0]).toMatchObject({ attempt_no: 1, points: 55, max_points: 100, grade_permille: 550, grade_band: "try_again" });
    const subs = JSON.parse(closed[0].submissions_json), hints = JSON.parse(closed[0].hints_json);
    expect(subs.map(x => x.is_correct), "the four scoring answers, as stored").toEqual([0, 0, 0, 1]);
    expect(subs.every(x => x.task_id === tasks[0].id && x.user_id === L.id && typeof x.submitted_at === "string")).toBe(true);
    expect(hints.map(h => [h.task_id, h.points_deducted])).toEqual([[tasks[0].id, 30]]);
    expect(scoringRows(comp.id, L.id), "the live tables hold the new attempt alone").toBe(0);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM hint_reveals WHERE competition_id=? AND user_id=?").get(comp.id, L.id).c)).toBe(0);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE competition_id=? AND user_id=? AND task_id=?").get(comp.id, L.id, quick[0].id).c),
      "the Quick answer stays live").toBe(1);
    // Audited on the learner's History with the request's context.
    const ev = sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='program_retake_started'").all(L.id));
    expect(ev.length).toBe(1);
    expect(JSON.parse(ev[0].details)).toMatchObject({ competition_id: comp.id, attempt: 2, closed_attempt: 1, grade_band: "try_again", answers_kept: 4, hints_kept: 1 });
    expect(JSON.parse(ev[0].details).ip, "reqContext rides the record").toBeTruthy();
    // The analytics stream is untouched.
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM challenge_events WHERE competition_id=? AND user_id=? AND task_id=?").get(comp.id, L.id, tasks[0].id).c),
      "every analytics row kept").toBeGreaterThanOrEqual(4);

    st = await standing(L, comp.id);
    expect(st, "a fresh attempt: nothing earned, not finished").toMatchObject({ attempt: 2, finished: false, grade: { points: 0 } });
    expect(st.previousAttempts).toEqual([expect.objectContaining({ attempt: 1, permille: 550, band: "try_again", percent: "55%" })]);
    // The hint can be bought again (its old row moved), and the new attempt is scored alone.
    const v = await L.s.api.get(`/api/tasks/${tasks[0].id}`, { headers: { "x-competition-id": comp.id } });
    expect((await v.json()).solved, "the challenge is open again").toBeFalsy();
    await answer(L, comp.id, tasks[0].id, tasks[0].answer);
    st = await standing(L, comp.id);
    expect(st.grade, "first time right: 100%").toMatchObject({ points: 100, permille: 1000, band: "excellent", passed: true });
    const m2 = await mint(L, comp.id);
    expect(m2.status, JSON.stringify(m2.body)).toBe(200);
    expect(sql(db => db.prepare("SELECT grade_band, grade_permille FROM achievement_badges WHERE user_id=? AND competition_id=?").get(L.id, comp.id)))
      .toEqual({ grade_band: "excellent", grade_permille: 1000 });
    // The organisers see the attempt count, and the export lists both attempts.
    const gd = await (await sa.get(`/api/admin/competitions/${comp.id}/grades`)).json();
    expect(gd.rows.find(x => x.userId === L.id)).toMatchObject({ attempt: 2, previousAttempts: 1, grade: { band: "excellent" } });
  });

  test("the automatic issue gives a passing learner their graded certificate; a ranked kind is refused Try again and has no grades", async () => {
    const L = await makeLearner(), T = await makeLearner();
    const { comp, tasks } = await makeEvent("program", ["easy", "hard"], [L]);
    await answer(L, comp.id, tasks[0].id, tasks[0].answer);
    await wrongs(L, comp.id, tasks[1].id, 4);            // −20
    await answer(L, comp.id, tasks[1].id, tasks[1].answer); // 50 + 150 − 20 = 180 of 200 = 90%
    const tick = await sa.post("/api/test/certificate-dispatch-tick", { headers: H(saCsrf), data: { force: true, competitionId: comp.id } });
    expect(tick.ok(), await tick.text()).toBeTruthy();
    expect(sql(db => db.prepare("SELECT basis, grade_band, grade_permille FROM achievement_badges WHERE user_id=? AND competition_id=?").get(L.id, comp.id)),
      "90% exactly: Excellent").toEqual({ basis: "completion", grade_band: "excellent", grade_permille: 900 });
    // A ranked kind is not graded.
    const { comp: tour } = await makeEvent("tournament", ["easy"], [T]);
    const r = await retake(T, tour.id);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("not_a_program");
    const g = await sa.get(`/api/admin/competitions/${tour.id}/grades`);
    expect(g.status(), "the grades list is a Program's only").toBe(400);
    // The full export carries grades.csv for the Program only.
    const files = await unzip(await (await sa.get(`/api/admin/competitions/${comp.id}/export/full`)).body());
    expect(Object.keys(files)).toContain("grades.csv");
    const line = files["grades.csv"].split(/\r?\n/).find(x => x.includes(L.id));
    expect(line, "the learner's current attempt").toBeTruthy();
    expect(line).toContain("Excellent");
    expect(line).toContain("90.0");
    const tourFiles = await unzip(await (await sa.get(`/api/admin/competitions/${tour.id}/export/full`)).body());
    expect(Object.keys(tourFiles), "a ranked kind has no grades file").not.toContain("grades.csv");
    expect(Object.keys(tourFiles), "anti-vacuity: the export was read").toContain("participants.csv");
  });

  test("running out of attempts finishes a learner: they are graded on what they hold (owner decision: performance, not solved-all)", async () => {
    const L = await makeLearner();
    const { comp, tasks } = await makeEvent("program", ["hard", "easy"], [L], { caps: [0, 1] });
    await answer(L, comp.id, tasks[0].id, tasks[0].answer);          // +150
    let st = await standing(L, comp.id);
    expect(st.finished, "PRECONDITION: the easy one is still open").toBe(false);
    const w = await answer(L, comp.id, tasks[1].id, `wrong-${uniq()}`); // −5, its one attempt spent
    expect(w.attempts_left, "PRECONDITION: no attempt left on the easy one").toBe(0);
    st = await standing(L, comp.id);
    expect(st.finished, "solved or out of attempts on every challenge: finished").toBe(true);
    expect(st.grade).toMatchObject({ points: 145, max: 200, permille: 725, band: "good", passed: true });
    const m = await mint(L, comp.id);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.grade).toMatchObject({ band: "good", percent: "72.5%" });
  });

  test("the organisers' grades list is scoped: an event admin reads their own Program's, never another's (control: the superadmin reads both)", async () => {
    const A = await makeLearner(), B = await makeLearner(), EA = await makeLearner();
    const { comp: mine } = await makeEvent("program", ["easy"], [A]);
    const { comp: theirs } = await makeEvent("program", ["easy"], [B]);
    const g = await sa.post(`/api/admin/competitions/${mine.id}/admins`, { headers: H(saCsrf), data: { userId: EA.id } });
    expect(g.ok(), await g.text()).toBeTruthy();
    const ea = await apiLogin(EA.email, PARTICIPANT_PASS);
    sessions.push(ea.api);
    const own = await ea.api.get(`/api/admin/competitions/${mine.id}/grades`);
    expect(own.status(), await own.text()).toBe(200);
    expect((await own.json()).rows.map(r => r.userId), "their own learner").toEqual([A.id]);
    const other = await ea.api.get(`/api/admin/competitions/${theirs.id}/grades`);
    expect(other.status(), "another organiser's Program is refused").toBe(403);
    expect(await other.text(), "and names nobody in it").not.toContain(B.id);
    const ctl = await sa.get(`/api/admin/competitions/${theirs.id}/grades`);
    expect((await ctl.json()).rows.map(r => r.userId), "CONTROL: the superadmin reads it").toEqual([B.id]);
  });

  test("Try again is refused under impersonation and once the Program is not live; a learner under 60% is told so with Try again offered", async () => {
    const L = await makeLearner();
    const { comp, tasks } = await makeEvent("program", ["easy"], [L]);
    await hint(L, comp.id, tasks[0].id);                 // −15
    await wrongs(L, comp.id, tasks[0].id, 3);           // −15
    await answer(L, comp.id, tasks[0].id, tasks[0].answer); // 50 − 30 = 20 of 50 = 40%
    const st = await standing(L, comp.id);
    expect(st).toMatchObject({ finished: true, canRetake: true, grade: { permille: 400, band: "try_again" } });
    // Viewed as the learner by a superadmin (who passes the impersonation write
    // guard): the route refuses, and nothing moves.
    const { api: imp, csrf: c0 } = await apiLogin("superadmin");
    sessions.push(imp);
    const ir = await imp.post(`/api/admin/participants/${L.id}/impersonate`, { headers: H(c0), data: {} });
    expect(ir.ok(), await ir.text()).toBeTruthy();
    const c1 = (await (await imp.get("/api/csrf-token")).json()).csrfToken;
    await imp.post("/api/select-competition", { headers: H(c1), data: { competitionId: comp.id } });
    const refused = await imp.post(`/api/competitions/${comp.id}/program/retake`, { headers: H(c1), data: {} });
    expect(refused.status(), await refused.text()).toBe(403);
    expect((await refused.json()).code).toBe("impersonation_retake_refused");
    expect(scoringRows(comp.id, L.id), "nothing moved: three wrong answers and the right one").toBe(4);
    // The built-in superadmin holds one session: sign the suite's own back in.
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    sessions.push(sa);
    // Ended: no retake.
    const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf), data: {} });
    expect(end.ok(), await end.text()).toBeTruthy();
    const r = await retake(L, comp.id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("program_not_live");
    expect((await standing(L, comp.id)).canRetake, "the offer follows the route").toBe(false);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM program_attempts WHERE user_id=?").get(L.id).c)).toBe(0);
  });
});
