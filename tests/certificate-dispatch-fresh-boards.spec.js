// @ts-check
//
// THE AUTOMATIC CERTIFICATE PASS RANKS ON WHO COUNTS NOW (sweep #368; operator
// ruling, 24 Nov 2026).
//
// lib/certificate-dispatch.js keeps one board memo per job so a run over N
// people builds each board once. The boards are fresh when built, not final:
// scores no longer move after the end, but who counts on a board still can (a
// `staff` or `benchmark` tag, an off-board role). Two locks:
//   * a TIMED retry (here an issue failure's five-minute re-arm) builds fresh
//     boards, so a person tagged `benchmark` meanwhile is not issued and the
//     next person moves up into the place. A render failure's re-arm drops the
//     memo with a line of its own, which no test hook can reach (nothing makes
//     the renderer unavailable under test): a SOURCE arm holds that line;
//   * the automatic issue's write re-asks whether its person still counts on the
//     board, so a tag landing after the memo was built is honoured at the
//     persist, and the memo is rebuilt for the rest of the run, so the person
//     ranked below moves up there too.
// Controls: untagged people are issued as ranked, in the same runs.
//
// Runs on the shared test server (its relay is dead, so each send fails; only
// what is ISSUED is read here). Each pass is `POST /api/test/certificate-dispatch-tick`
// narrowed to the test's own event; the worker never runs by itself under test.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

const dbAll = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};
const dbExec = (sql) => {
  const db = new Database(TEST_DB_PATH);
  try { db.exec(sql); } finally { db.close(); }
};
const badgesOf = (compId) => Object.fromEntries(
  dbAll("SELECT user_id, rank, basis FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL", compId)
    .map(b => [b.user_id, { rank: b.rank, basis: b.basis }]));
const jobsOf = (compId) => dbAll("SELECT user_id, last_error, reason, due_at FROM certificate_dispatch_jobs WHERE competition_id=?", compId);

/** A live Competition with `n` easy challenges (answer "a"), and its admin client. */
async function event(label, n) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const comp = await makeCompetition(sa, csrf, label);
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const t = await makeTask(sa, csrf, `${label}${i}`);
    await assignTask(sa, csrf, t.id, [comp.id]);
    tasks.push(t.id);
  }
  return { sa, csrf, comp, tasks };
}

/** `who` answers `right` challenges correctly, then `wrong` of the rest wrongly. */
async function play(email, compId, tasks, right, wrong) {
  const { api, csrf } = await apiLogin(email);
  try {
    const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    const send = async (taskId, answer) => {
      const r = await api.post(`/api/tasks/${taskId}/submit`, {
        headers: { ...H(csrf), "x-competition-id": compId },
        data: { answer, gradingHash: await gradingHashFor(api, taskId) },
      });
      expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).correct;
    };
    for (let i = 0; i < right; i++) expect(await send(tasks[i], "a"), "PRECONDITION: a right answer").toBe(true);
    for (let i = right; i < right + wrong; i++) expect(await send(tasks[i], "nope"), "PRECONDITION: a wrong answer").toBe(false);
  } finally { await api.dispose(); }
}

async function tick(sa, csrf, competitionId, extra = {}) {
  const r = await sa.post("/api/test/certificate-dispatch-tick", { headers: H(csrf), data: { force: true, competitionId, ...extra } });
  expect(r.ok(), `tick: ${await r.text()}`).toBeTruthy();
  return r.json();
}

async function tagBenchmark(sa, csrf, userId) {
  const r = await sa.post(`/api/admin/participants/${userId}/tags`, { headers: H(csrf), data: { tag: "benchmark" } });
  expect(r.ok(), `tag: ${r.status()} ${await r.text()}`).toBeTruthy();
}

test("a timed retry ranks on fresh boards: someone tagged benchmark meanwhile is not issued, and the next person moves up", async () => {
  const { sa, csrf, comp, tasks } = await event("frbretry", 2);
  try {
    const first = await makeParticipant(sa, csrf, "frbfirst");
    const second = await makeParticipant(sa, csrf, "frbsecond");
    await enrol(sa, csrf, comp.id, [first.id, second.id]);
    await play(first.email, comp.id, tasks, 2, 0);   // 100: 1st
    await play(second.email, comp.id, tasks, 1, 1);  // 45: 2nd, one left unsolved
    const ids = [first.id, second.id].map(id => `'${id}'`).join(",");
    // Both writes fail, as a write lock another process holds past busy_timeout
    // makes them fail: the job re-arms for a retry five minutes on.
    dbExec(`CREATE TRIGGER t_frb_issue_fails BEFORE INSERT ON achievement_badges
      WHEN NEW.user_id IN (${ids}) BEGIN SELECT RAISE(ABORT, 'test: transient write failure'); END;`);
    try {
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
      expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
      await tick(sa, csrf, comp.id);
      expect(badgesOf(comp.id), "PRECONDITION: the first pass issued nobody").toEqual({});
      expect(jobsOf(comp.id).map(j => j.last_error), "PRECONDITION: the job waits for a timed retry").toEqual(["issue_failed:1"]);
    } finally {
      dbExec("DROP TRIGGER IF EXISTS t_frb_issue_fails");
    }
    // Before the retry, the first-placed person stops counting on the board.
    await tagBenchmark(sa, csrf, first.id);
    await tick(sa, csrf, comp.id);
    const issued = badgesOf(comp.id);
    expect(issued[first.id], "the benchmark-tagged person is not issued").toBeUndefined();
    expect(issued[second.id], "the next person is issued the place the board now gives them").toEqual({ rank: 1, basis: "placement" });
    expect(jobsOf(comp.id), "the job is done").toEqual([]);
  } finally { await sa.dispose(); }
});

test("the issue's write re-asks who counts: a tag landing after the boards were built is honoured, and the rest of the run ranks without them", async () => {
  // Nine people. A pass capped at one send issues exactly the first four by id
  // (its four lanes are past the cap check together) and leaves the job due with
  // its board memo. The person who will be tagged is fifth by id (third place);
  // the next pass (uncapped) ranks the other five on that memo. To make the
  // order of that pass certain, every send parks (`/api/test/certificate-send-delay`,
  // after the issue's write): the tagged person, refused, sends nothing, so
  // theirs is the only lane that frees while the sixth to eighth are parked, and
  // the person ranked just below them, ninth by id, starts only in it, reading
  // the boards after the tagged person's write. A fourth parked send is theirs.
  const { sa, csrf, comp, tasks } = await event("frbpersist", 3);
  try {
    const people = [];
    for (let i = 0; i < 9; i++) people.push(await makeParticipant(sa, csrf, `frbp${i}`));
    people.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await enrol(sa, csrf, comp.id, people.map(p => p.id));
    const [gold, silver, w3, w4, tagged, w6, w7, w8, below] = people;
    await play(gold.email, comp.id, tasks, 3, 0);     // 150
    await play(silver.email, comp.id, tasks, 2, 0);   // 100
    await play(tagged.email, comp.id, tasks, 1, 0);   // 50: 3rd
    await play(below.email, comp.id, tasks, 1, 1);    // 45: 4th
    for (const p of [w3, w4, w6, w7, w8]) await play(p.email, comp.id, tasks, 0, 1); // -5 each
    const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();

    await tick(sa, csrf, comp.id, { maxSends: 1 });
    expect(Object.keys(badgesOf(comp.id)).sort(), "PRECONDITION: the capped pass issued the first four by id")
      .toEqual([gold.id, silver.id, w3.id, w4.id].sort());
    expect(jobsOf(comp.id).length, "PRECONDITION: the job is left due, with its memo").toBe(1);

    // After the boards were built, the third-placed person stops counting.
    await tagBenchmark(sa, csrf, tagged.id);
    const park = async (data) => {
      const r = await sa.post("/api/test/certificate-send-delay", { headers: H(csrf), data });
      expect(r.ok(), `send park: ${await r.text()}`).toBeTruthy();
    };
    await park({ delayMs: 5000 });
    try {
      const pass = tick(sa, csrf, comp.id);
      await expect.poll(async () => (await (await sa.get("/api/test/certificate-send-delay")).json()).parked, {
        message: "the sixth to eighth and the person ranked below park their sends", timeout: 20000,
      }).toBeGreaterThanOrEqual(4);
      await park({ delayMs: 0 });
      await park({ release: true });
      await pass;
    } finally {
      await park({ delayMs: 0 });
      await park({ release: true });
    }
    for (let i = 0; i < 3 && jobsOf(comp.id).length; i++) await tick(sa, csrf, comp.id);
    expect(jobsOf(comp.id), "the job is done").toEqual([]);

    const issued = badgesOf(comp.id);
    expect(issued[tagged.id], "the write refused the person tagged after the boards were built").toBeUndefined();
    expect(issued[below.id], "the person ranked below moves up to third").toEqual({ rank: 3, basis: "placement" });
    // CONTROLS: the untagged are issued as ranked.
    expect(issued[gold.id]).toEqual({ rank: 1, basis: "placement" });
    expect(issued[silver.id]).toEqual({ rank: 2, basis: "placement" });
    for (const p of [w3, w4, w6, w7, w8]) expect(issued[p.id] && issued[p.id].basis, "a participant below the podium").toBe("participation");
  } finally { await sa.dispose(); }
});

// SOURCE: the render failure's re-arm. Nothing makes the renderer unavailable
// under test, so this one memo drop is held by its source; the issue failure's
// re-arm, a separate line, is held by behaviour above.
test("SOURCE: a render failure's timed re-arm drops the job's board memo too", () => {
  const fs = require("fs"), path = require("path");
  const { stripJsComments } = require("./doc-registry");
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "certificate-dispatch.js"), "utf8"));
  const at = src.indexOf("if (renderFailed) {");
  expect(at, "the render-failure branch is where it was").toBeGreaterThan(0);
  const end = src.indexOf("return;", src.indexOf("RENDER_RETRY_MS", at));
  expect(end, "the branch re-arms with RENDER_RETRY_MS and returns").toBeGreaterThan(at);
  expect(src.slice(at, end), "the re-arm drops the memo, so the retry builds fresh boards").toContain("_jobBoards.delete(_boardsKey(job))");
});
