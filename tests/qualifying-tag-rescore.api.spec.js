// SWEEP #91 — A QUALIFYING TAG CHANGE RE-SCORES THE ANSWERS ALREADY GIVEN.
//
// A qualifying ("Quick") question scores nothing, right or wrong, and its hint
// costs nothing (lib/qualifying.js); a scoring challenge earns its difficulty's
// points. Adding the `qualifying:` tag to a challenge already answered in a live
// event used to leave the stored answers at their old points (the board sums the
// stored points) while new answers got nothing, and no board was refreshed;
// removing it did the reverse. The tag doors and a restore that flips the tag
// now price the stored answers and hint costs as Recalculate would, in every
// event holding the challenge, record it on each event's History and refresh
// each board at once.
//
// Held here, each with its control:
//   * adding the tag: the answers in BOTH holding events score 0 and the hint
//     costs nothing, the answering participant's board says so at once (read
//     inside the board cache's 5 s window, so only a refresh can show it), each
//     event's History records `scores_recalculated`, and Recalculate afterwards
//     finds nothing left to change; a decoy event that does not hold the
//     challenge is untouched;
//   * removing it restores the points, the hint cost and the board, recorded too;
//   * an event with an ended session refuses the tag change and keeps its points;
//   * a restore that flips the tag re-scores the same way, and one that does not
//     flip it re-scores nothing;
//   * a challenge import whose overwrite flips the tag re-scores the same way and
//     renumbers the challenge into its new place; one that does not flip it
//     re-scores nothing;
//   * a LOCKED challenge refuses the flip either way (it would re-price its
//     answers, which a lock forbids, as Recalculate's does), while a tag that
//     changes nothing about it is still accepted; unlocked, the flip goes through.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, withLegacySharedAssign } = require("./event-admin-helpers");

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
const optionIds = (taskId) => JSON.parse(sql(db => db.prepare("SELECT choices FROM tasks WHERE id=?").get(taskId).choices)).map(c => c.id);
const subRow = (taskId, compId, userId) => sql(db => db.prepare(
  "SELECT is_correct, points_delta, updated_at FROM submissions WHERE task_id=? AND competition_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1").get(taskId, compId, userId));
const hintCost = (taskId, compId, userId) => sql(db => (db.prepare(
  "SELECT points_deducted FROM hint_reveals WHERE task_id=? AND competition_id=? AND user_id=?").get(taskId, compId, userId) || {}).points_deducted);
const rescores = (compId) => sql(db => db.prepare(
  "SELECT details FROM competition_events WHERE competition_id=? AND event_type='scores_recalculated' ORDER BY rowid").all(compId)).map(r => JSON.parse(r.details));

/** A pick-one question (the only kind a qualifying tag may go on), easy: 50 points while it scores. */
async function pickOne(sa, csrf, label) {
  return makeTask(sa, csrf, label, { answer_type: "any", correct_answer: "", choices: [{ text: "Few" }, { text: "Many" }] });
}
/** Sign `p` in and answer `taskId` in `compId`. */
async function answer(p, compId, taskId, value) {
  const s = p.session || (p.session = await apiLogin(p.email));
  const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  const v = await s.api.get(`/api/tasks/${taskId}`, { headers: { "x-competition-id": compId } });
  expect(v.ok(), `view: ${await v.text()}`).toBeTruthy();
  const r = await s.api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": s.csrf, "x-competition-id": compId },
    multipart: { answer: value, gradingHash: (await v.json()).grading_hash || "" },
  });
  expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  return r.json();
}
/** The participant's own score on their event's board. */
async function myScore(p, compId) {
  const r = await p.session.api.get("/api/leaderboard", { headers: { "x-competition-id": compId } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const b = await r.json();
  expect(b.me, `PRECONDITION: ${p.email} is on the board`).toBeTruthy();
  return b.me.score;
}
async function tag(sa, csrf, taskId, t) {
  return sa.post(`/api/admin/tasks/${taskId}/tags`, { headers: H(csrf), data: { tag: t } });
}
async function untag(sa, csrf, taskId, t) {
  return sa.delete(`/api/admin/tasks/${taskId}/tags/${encodeURIComponent(t)}`, { headers: H(csrf) });
}

test.describe("sweep #91 — a qualifying tag change re-scores the answers already given", () => {
  test("adding the tag scores them 0 in every holding event at once, and removing it restores them; a decoy event is untouched", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const L1 = await makeCompetition(sa, csrf, "r91a"), L2 = await makeCompetition(sa, csrf, "r91b"), D = await makeCompetition(sa, csrf, "r91d");
    const Q = await pickOne(sa, csrf, "r91q");
    const S = await makeTask(sa, csrf, "r91s");
    // An unsolved challenge in each event keeps the all-solved end away (fixture item 1).
    const X = await makeTask(sa, csrf, "r91x");
    // ONE challenge held by two events: the shape a database from before
    // event-owned questions holds (and a qualifying question still has), built
    // through the previous release's assign doors (lib/event-copies.js).
    await withLegacySharedAssign(sa, csrf, async () => {
      await assignTask(sa, csrf, Q.id, [L1.id, L2.id]);
      await assignTask(sa, csrf, S.id, [D.id]);
      await assignTask(sa, csrf, X.id, [L1.id, L2.id, D.id]);
    });
    const p1 = await makeParticipant(sa, csrf, "r91p1"), p2 = await makeParticipant(sa, csrf, "r91p2"), p3 = await makeParticipant(sa, csrf, "r91p3");
    await enrol(sa, csrf, L1.id, [p1.id]);
    await enrol(sa, csrf, L2.id, [p2.id]);
    await enrol(sa, csrf, D.id, [p3.id]);
    const [few] = optionIds(Q.id);
    await answer(p1, L1.id, Q.id, JSON.stringify([few]));
    await answer(p2, L2.id, Q.id, JSON.stringify([few]));
    expect((await answer(p3, D.id, S.id, "a")).correct).toBe(true);
    // A hint p1 paid for while Q scored (an easy hint costs 15).
    sql(db => db.prepare("INSERT INTO hint_reveals (competition_id, user_id, task_id, points_deducted, revealed_at) VALUES (?,?,?,15,?)")
      .run(L1.id, p1.id, Q.id, new Date().toISOString()));
    expect(subRow(Q.id, L1.id, p1.id), "PRECONDITION: p1's answer scored").toMatchObject({ is_correct: 1, points_delta: 50 });
    expect(subRow(Q.id, L2.id, p2.id)).toMatchObject({ is_correct: 1, points_delta: 50 });
    const decoy = subRow(S.id, D.id, p3.id);
    expect(decoy, "PRECONDITION: the decoy's answer scored").toMatchObject({ points_delta: 50 });
    expect(await myScore(p1, L1.id), "PRECONDITION: the board read is now cached at 50 - 15").toBe(35);

    const key = `qualifying:r91${uniq("k").replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    const added = await tag(sa, csrf, Q.id, key);
    expect(added.status(), await added.text()).toBe(200);
    // Inside the board cache's 5 s window: only a refresh shows the new score.
    expect(await myScore(p1, L1.id), "p1's board at once: the answer and its hint are worth nothing").toBe(0);
    expect(subRow(Q.id, L1.id, p1.id)).toMatchObject({ is_correct: 1, points_delta: 0 });
    expect(subRow(Q.id, L2.id, p2.id), "every holding event, not only the first").toMatchObject({ is_correct: 1, points_delta: 0 });
    expect(hintCost(Q.id, L1.id, p1.id)).toBe(0);
    expect(rescores(L1.id)).toEqual([expect.objectContaining({ task_id: Q.id, reason: "qualifying_tag_added", submissions_rescored: 1, hints_rescaled: 1 })]);
    expect(rescores(L2.id)).toEqual([expect.objectContaining({ task_id: Q.id, reason: "qualifying_tag_added", submissions_rescored: 1, hints_rescaled: 0 })]);
    expect(subRow(S.id, D.id, p3.id), "CONTROL: the decoy event is untouched").toEqual(decoy);
    expect(rescores(D.id)).toEqual([]);
    // Recalculate agrees: nothing left for it to change.
    const rc = await sa.post(`/api/admin/tasks/${Q.id}/recalculate`, { headers: H(csrf), data: { confirm_live: true } });
    expect(rc.status(), await rc.text()).toBe(200);
    expect(await rc.json()).toMatchObject({ flipped: 0, hints_rescaled: 0 });

    const removed = await untag(sa, csrf, Q.id, key);
    expect(removed.status(), await removed.text()).toBe(200);
    expect(await myScore(p1, L1.id), "removed: the points and the hint cost come back at once").toBe(35);
    expect(subRow(Q.id, L1.id, p1.id)).toMatchObject({ is_correct: 1, points_delta: 50 });
    expect(subRow(Q.id, L2.id, p2.id)).toMatchObject({ is_correct: 1, points_delta: 50 });
    expect(hintCost(Q.id, L1.id, p1.id)).toBe(15);
    expect(rescores(L1.id).map(d => d.reason)).toEqual(["qualifying_tag_added", "qualifying_tag_removed"]);
    expect(subRow(S.id, D.id, p3.id), "CONTROL: the decoy is still untouched").toEqual(decoy);
  });

  test("an event with an ended session refuses the tag change and keeps its points", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const E = await makeCompetition(sa, csrf, "r91e");
    const Q = await pickOne(sa, csrf, "r91eq");
    const X = await makeTask(sa, csrf, "r91ex");
    Q.id = (await assignTask(sa, csrf, Q.id, [E.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    X.id = (await assignTask(sa, csrf, X.id, [E.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    const p = await makeParticipant(sa, csrf, "r91ep");
    await enrol(sa, csrf, E.id, [p.id]);
    await answer(p, E.id, Q.id, JSON.stringify([optionIds(Q.id)[0]]));
    const end = await sa.post(`/api/admin/competitions/${E.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), await end.text()).toBeTruthy();
    const before = subRow(Q.id, E.id, p.id);
    expect(before.points_delta).toBe(50);
    const r = await tag(sa, csrf, Q.id, "qualifying:r91frozen");
    expect(r.status()).toBe(409);
    expect((await r.json()).code).toBe("qualifying_tag_frozen");
    expect(subRow(Q.id, E.id, p.id)).toEqual(before);
    expect(rescores(E.id)).toEqual([]);
  });

  test("a restore that flips the tag re-scores as the tag doors do; one that does not flip it re-scores nothing", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const L = await makeCompetition(sa, csrf, "r91r");
    const Q = await pickOne(sa, csrf, "r91rq");
    const X = await makeTask(sa, csrf, "r91rx");
    Q.id = (await assignTask(sa, csrf, Q.id, [L.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    X.id = (await assignTask(sa, csrf, X.id, [L.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    const p = await makeParticipant(sa, csrf, "r91rp");
    await enrol(sa, csrf, L.id, [p.id]);
    await answer(p, L.id, Q.id, JSON.stringify([optionIds(Q.id)[0]]));
    expect(await myScore(p, L.id)).toBe(50);
    const versions = async () => {
      const r = await sa.get(`/api/admin/tasks/${Q.id}/versions`);
      expect(r.ok(), await r.text()).toBeTruthy();
      const b = await r.json();
      return Array.isArray(b) ? b : (b.versions || []);
    };
    const untagged = (await versions())[0];
    expect(untagged, "PRECONDITION: a version before the tag").toBeTruthy();
    expect((await tag(sa, csrf, Q.id, "qualifying:r91restore")).status()).toBe(200);
    expect(subRow(Q.id, L.id, p.id).points_delta).toBe(0);
    // Back to the version without the tag: the answer scores again, at once.
    const back = await sa.post(`/api/admin/tasks/${Q.id}/restore`, { headers: H(csrf), data: { versionId: untagged.id } });
    expect(back.status(), await back.text()).toBe(200);
    expect(subRow(Q.id, L.id, p.id).points_delta).toBe(50);
    expect(await myScore(p, L.id)).toBe(50);
    expect(rescores(L.id).map(d => d.reason)).toEqual(["qualifying_tag_added", "restore"]);
    // CONTROL: a restore that changes nothing about the tag re-scores nothing.
    const stamp = subRow(Q.id, L.id, p.id).updated_at;
    const again = await sa.post(`/api/admin/tasks/${Q.id}/restore`, { headers: H(csrf), data: { versionId: untagged.id } });
    expect(again.status(), await again.text()).toBe(200);
    expect(subRow(Q.id, L.id, p.id).updated_at, "no row rewritten").toBe(stamp);
    expect(rescores(L.id)).toHaveLength(2);
  });

  test("a challenge import overwriting a challenge into, or out of, a qualifying question re-scores as the tag doors do and renumbers it; one that keeps it as it was re-scores nothing", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const L = await makeCompetition(sa, csrf, "r91i");
    const Q = await pickOne(sa, csrf, "r91iq");
    const X = await makeTask(sa, csrf, "r91ix");
    // The import overwrites LIBRARY questions only; an event's own copy is out of
    // its reach (lib/event-copies.js). A library question an event holds is the
    // shape a database from before event-owned questions has, built through the
    // previous release's assign doors.
    await withLegacySharedAssign(sa, csrf, async () => {
      await assignTask(sa, csrf, Q.id, [L.id]);
      await assignTask(sa, csrf, X.id, [L.id]);
    });
    const p = await makeParticipant(sa, csrf, "r91ip");
    await enrol(sa, csrf, L.id, [p.id]);
    await answer(p, L.id, Q.id, JSON.stringify([optionIds(Q.id)[0]]));
    expect(await myScore(p, L.id), "PRECONDITION: the answer scores").toBe(50);
    const numberOf = async () => {
      const r = await p.session.api.get("/api/tasks", { headers: { "x-competition-id": L.id } });
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).find(t => t.id === Q.id).task_number;
    };
    expect(await numberOf(), "PRECONDITION: numbered as a scoring challenge").toMatch(/^1\./);
    const row = sql(db => db.prepare("SELECT title, description, choices FROM tasks WHERE id=?").get(Q.id));
    const key = `qualifying:r91imp${uniq("k").replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    const over = (tags) => sa.post("/api/admin/import/tasks", { headers: H(csrf), data: { resolutions: { "0": "overwrite" }, data: { type: "hackarena-tasks", tasks: [{
      title: row.title, description: row.description, difficulty: "easy", answer_type: "any", correct_answer: "", choices: JSON.parse(row.choices), status: "published", tags,
    }] } } });
    const into = await over([key]);
    expect(into.status(), await into.text()).toBe(200);
    expect((await into.json()).overwritten, "PRECONDITION: the row was overwritten").toBe(1);
    expect(subRow(Q.id, L.id, p.id)).toMatchObject({ is_correct: 1, points_delta: 0 });
    expect(await myScore(p, L.id), "the board at once").toBe(0);
    expect(rescores(L.id)).toEqual([expect.objectContaining({ task_id: Q.id, reason: "import", submissions_rescored: 1 })]);
    expect(await numberOf(), "numbered in the qualifying questions' place").toMatch(/^4\./);
    // CONTROL: the same file again changes nothing about it, and re-scores nothing.
    const stamp = subRow(Q.id, L.id, p.id).updated_at;
    const same = await over([key]);
    expect(same.status(), await same.text()).toBe(200);
    expect(subRow(Q.id, L.id, p.id).updated_at, "no row rewritten").toBe(stamp);
    expect(rescores(L.id)).toHaveLength(1);
    // And out of it again: the points come back.
    const out = await over([]);
    expect(out.status(), await out.text()).toBe(200);
    expect(subRow(Q.id, L.id, p.id)).toMatchObject({ is_correct: 1, points_delta: 50 });
    expect(await myScore(p, L.id)).toBe(50);
    expect(rescores(L.id).map(d => d.reason)).toEqual(["import", "import"]);
    expect(await numberOf(), "numbered as a scoring challenge again").toMatch(/^1\./);
  });

  test("a locked challenge refuses to become, or stop being, a qualifying question, and keeps its points; another tag is still accepted, and unlocked the change goes through (CONTROLS)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const L = await makeCompetition(sa, csrf, "r91l");
    const Q = await pickOne(sa, csrf, "r91lq");
    const X = await makeTask(sa, csrf, "r91lx");
    Q.id = (await assignTask(sa, csrf, Q.id, [L.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    X.id = (await assignTask(sa, csrf, X.id, [L.id])).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    const p = await makeParticipant(sa, csrf, "r91lp");
    await enrol(sa, csrf, L.id, [p.id]);
    await answer(p, L.id, Q.id, JSON.stringify([optionIds(Q.id)[0]]));
    const lockState = () => sql(db => db.prepare("SELECT locked FROM tasks WHERE id=?").get(Q.id).locked);
    const setLock = async (on) => {
      if (!!lockState() === on) return;
      const r = await sa.post(`/api/admin/tasks/${Q.id}/lock`, { headers: H(csrf) });
      expect(r.ok(), await r.text()).toBeTruthy();
      expect(!!lockState(), "PRECONDITION: the lock is as wanted").toBe(on);
    };
    const key = `qualifying:r91lock${uniq("k").replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    await setLock(true);
    const refused = await tag(sa, csrf, Q.id, key);
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("challenge_locked");
    expect(subRow(Q.id, L.id, p.id).points_delta, "its answer keeps its points").toBe(50);
    expect(rescores(L.id)).toEqual([]);
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%'").get(Q.id).n), "no tag stored").toBe(0);
    const other = await tag(sa, csrf, Q.id, "category:r91lock");
    expect(other.status(), `CONTROL: a tag that changes nothing about it is accepted: ${await other.text()}`).toBe(200);
    await setLock(false);
    expect((await tag(sa, csrf, Q.id, key)).status(), "CONTROL: unlocked, it becomes one").toBe(200);
    expect(subRow(Q.id, L.id, p.id).points_delta).toBe(0);
    await setLock(true);
    const refusedOut = await untag(sa, csrf, Q.id, key);
    expect(refusedOut.status()).toBe(403);
    expect((await refusedOut.json()).code).toBe("challenge_locked");
    expect(subRow(Q.id, L.id, p.id).points_delta, "it stays a qualifying question, still worth nothing").toBe(0);
    await setLock(false);
    expect((await untag(sa, csrf, Q.id, key)).status(), "CONTROL: unlocked, it stops being one").toBe(200);
    expect(subRow(Q.id, L.id, p.id).points_delta).toBe(50);
  });

  test("the History says why each recalculation happened", async ({ page }) => {
    const { BASE } = require("./helpers");
    await page.goto(`${BASE}/`);
    await expect(page.locator("html[data-booted='1']")).toBeAttached({ timeout: 20000 });
    expect(await page.evaluate(() => typeof window.formatEventChange), "PRECONDITION: the History renderer is on window").toBe("function");
    const said = (reason) => page.evaluate((r) => window.formatEventChange({ event_type: "scores_recalculated", details: { task_title: "Team size", reason: r } }), reason);
    expect(await said("qualifying_tag_added")).toContain("(now a qualifying question)");
    expect(await said("qualifying_tag_removed")).toContain("(no longer a qualifying question)");
    expect(await said("restore")).toContain("(a restored version)");
    expect(await said("import")).toContain("(an import changed whether it is a qualifying question)");
    expect(await said("import"), "the challenge is named").toContain("Team size");
  });
});

