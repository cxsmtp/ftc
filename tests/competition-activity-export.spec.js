// @ts-check
//
// v7.23.0 — PER-COMPETITION CHALLENGE-ACTIVITY CSV.
//
// `GET /api/admin/export/competition-activity?competitionId=` emits one row per
// (enrolled participant x assigned challenge) for a LIVE or ENDED competition,
// carrying four signals: Solved, Hint Revealed, Incorrect Submissions,
// Navigated Away. It is reached from the Competitions row kebab.
//
// WHY THE FIXTURE LOOKS LIKE THIS, i.e. why these locks can fail:
//
//   * A 1x1 fixture cannot tell a CROSS PRODUCT from a join, and a fixture
//     where every participant has identical activity cannot tell a correct
//     column mapping from a transposed one. So the matrix below is 3 included
//     participants x 4 challenges = 12 rows, every one of the four signals
//     varies independently across cells, and at least one cell is all-No —
//     which is the row only a cross product can produce, since no table
//     contains it.
//   * v7.24.0 — the four challenges carry FOUR DIFFERENT arrangements of
//     difficulty, which is what makes the three columns added in that release
//     assertable. `task_number` is "<difficulty level>.<NN>", so varying
//     difficulty makes the exported order differ from BOTH title order and
//     assignment order (see mkTask), and makes Difficulty and Points vary
//     row to row — with four `easy` challenges, sorting by assignment order or
//     hard-coding Points to 50 would pass every assertion in this file.
//   * `aa/Alpha` carries TWO navigated-away events, spaced past the route's
//     2-second dedup window. Without a count > 1 anywhere, an implementation
//     that returned a boolean for that column would pass. Both are recorded
//     BEFORE aa solves Alpha — since v7.27.0 a solved challenge records no
//     further navigated_away, so the post-solve ordering this fixture used to
//     have would now store zero and make that assertion vacuous.
//   * `bb` is tagged BENCHMARK and must appear; `ss` is tagged STAFF and must
//     not. That is the whole participant-set decision, so it gets an explicit
//     lock rather than riding on the row count.
//   * `bb`'s company is a spreadsheet formula, so the injection guard is driven
//     end-to-end through the real endpoint — with `aa`'s ordinary company as
//     the positive control, because a helper that apostrophised EVERY cell
//     would satisfy a presence-only assertion.
//
// Fixture checklist (CLAUDE.md): own competition, own challenges, own
// participants, and NOT every enrolled non-staff participant solves every
// published challenge — so the all-solved auto-end cannot fire and flip the
// live/ended gate under the tests.
const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, gradingHashFor, BASE, PARTICIPANT_PASS, TEST_DATA_DIR } = require("./helpers");
const { adminLogin, clickTab, filterComps, openKebab, openRowEventMenu } = require("./ui-admin-helpers");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const EXPORT_URL = (id) => `/api/admin/export/competition-activity?competitionId=${encodeURIComponent(id)}`;

/** A verified + approved participant with a known password. */
async function mkP(sa, saCsrf, nick, company) {
  const email = `cae_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: `F${nick}`, lastName: `L${nick}`, nickname: nick, email, company,
    title: "Eng", country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
    jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), await reg.text()).toBeLessThan(400);
  await anon.dispose();
  const u = (await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  expect(u, `participant ${nick} must exist`).toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) })).ok()).toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) })).ok()).toBeTruthy();
  return { id: u.id, email, nick };
}

/** Parse a CSV whose every field is quoted (which is what this endpoint emits). */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = "", inQ = false, started = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQ) {
      if (ch === '"') { if (body[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') { inQ = true; started = true; }
    else if (ch === ",") { row.push(field); field = ""; started = false; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; started = false; }
    else field += ch;
  }
  if (field.length || started || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// v7.24.0 — column indices are DERIVED from the header row, never hard-coded.
//
// Every read in this file used to be a positional literal (`x[4]`, `.slice(5)`,
// `row[8]`), so inserting three columns meant touching ten sites and silently
// changed what several of them were reading. The header contract itself is
// still asserted positionally and exhaustively in test 1 — that is the one
// place a column's NAME and POSITION belong; everywhere else asks by name, so
// the next column insert is a one-line change to that single assertion.
const COL = {
  nick: "Nickname", first: "First Name", last: "Last Name", company: "Company",
  id: "Challenge ID", challenge: "Challenge", difficulty: "Difficulty", points: "Points",
  solved: "Solved", hint: "Hint Revealed", incorrect: "Incorrect Submissions", nav: "Navigated Away",
};
/** Turn a parsed CSV into {header, rows:[{<column name>: value}]}. */
function csvObjects(text) {
  const parsed = parseCsv(text);
  const header = parsed[0] || [];
  for (const name of Object.values(COL)) {
    expect(header.indexOf(name), `the CSV must carry a "${name}" column — header was ${JSON.stringify(header)}`)
      .toBeGreaterThanOrEqual(0);
  }
  return { header, rows: parsed.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}
/** The four activity signals of one row, in header order, as an array. */
const signals = (o) => [o[COL.solved], o[COL.hint], o[COL.incorrect], o[COL.nav]];

let F = null; // fixture, built once

test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const compName = `Activity Export ${t}`;
    // Started a minute ago, four hours long → LIVE and stays live for the run.
    const comp = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: compName, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }});
    expect(comp.status(), await comp.text()).toBe(200);
    const compId = (await comp.json()).competition.id;

    // v7.24.0 — the file is now ordered by the per-competition challenge NUMBER,
    // and the DIFFICULTIES here are what make that assertable. `task_number` is
    // "<difficulty level>.<NN>" assigned in assignment order within each
    // difficulty bucket, so with these four:
    //
    //   Zeta  easy   → 1.01      Mike  easy   → 1.02
    //   Delta medium → 2.01      Alpha hard   → 3.01
    //
    // the exported order is Zeta, Mike, Delta, Alpha — which is DIFFERENT from
    // title order (Alpha, Delta, Mike, Zeta) AND from assignment order (Zeta,
    // Alpha, Mike, Delta). A build that sorted by either, or that ignored the
    // level prefix, therefore fails rather than passing by coincidence.
    //
    // Varying difficulty is also what stops the two new columns being vacuous:
    // with four `easy` challenges, hard-coding Difficulty to "easy" or Points
    // to 50 would pass every assertion in this file.
    const mkTask = async (title, difficulty) => {
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title, description: "<p>d</p>", difficulty, answer_type: "text",
        correct_answer: "right", explanation: "<p>e</p>", hint: "a hint", status: "published",
      }});
      expect(r.status(), await r.text()).toBe(200);
      const id = (await r.json()).id;
      const a = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
      expect(a.status(), await a.text()).toBe(200);
      return id;
    };
    const zeta  = await mkTask(`Zeta ${t}`,  "easy");   // → 1.01
    const alpha = await mkTask(`Alpha ${t}`, "hard");   // → 3.01
    const mike  = await mkTask(`Mike ${t}`,  "easy");   // → 1.02
    // Assigned, then HIDDEN. It must still get rows: a challenge people could
    // answer earlier in the competition keeps its results, and dropping it
    // would lose them. Numbered 2.01, i.e. THIRD of four in the exported order,
    // so a build that filtered it out shifts Alpha rather than merely
    // shortening the file.
    const delta = await mkTask(`Delta ${t}`, "medium"); // → 2.01
    const vis = await sa.patch(`/api/admin/tasks/${delta}/visibility`, { headers: H(csrf), data: { active: false } });
    expect(vis.status(), await vis.text()).toBe(200);

    // Nicknames sort aa < bb < zz; ss is the staff control.
    const aa = await mkP(sa, csrf, `aa${t}`, "Acme Ltd");
    const bb = await mkP(sa, csrf, `bb${t}`, '=HYPERLINK("http://evil.example","clickme")');
    const zz = await mkP(sa, csrf, `zz${t}`, "Zenith Corp");
    const ss = await mkP(sa, csrf, `ss${t}`, "Staff Co");

    // Assign BEFORE tagging: POST /api/admin/competitions/assign deliberately
    // SKIPS staff and benchmark users, so tagging first would silently enrol
    // nobody and every assertion below would be about an empty file.
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [aa.id, bb.id, zz.id, ss.id], competitionIds: [compId] },
    });
    expect(asg.status(), await asg.text()).toBe(200);
    expect((await asg.json()).assigned, "all four must actually enrol").toBe(4);

    for (const [u, tag] of [[bb, "benchmark"], [ss, "staff"]]) {
      const r = await sa.post(`/api/admin/participants/${u.id}/tags`, { headers: H(csrf), data: { tag } });
      expect(r.status(), await r.text()).toBe(200);
    }

    // ── activity matrix ──────────────────────────────────────────────────────
    const actIn = async (who, comp, fn) => {
      const { api, csrf: c } = await apiLogin(who.email, PARTICIPANT_PASS);
      const sel = await api.post("/api/select-competition", { headers: H(c), data: { competitionId: comp } });
      expect(sel.status(), await sel.text()).toBe(200);
      try { await fn(api, c); } finally { await api.dispose(); }
    };
    const act = (who, fn) => actIn(who, compId, fn);
    const submit = async (api, c, taskId, answer, expectCorrect) => {
      const gradingHash = await gradingHashFor(api, taskId);
      const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(c), data: { answer, gradingHash } });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).correct).toBe(expectCorrect);
    };
    const hint = async (api, c, taskId) => {
      const r = await api.post(`/api/tasks/${taskId}/hint`, { headers: H(c) });
      expect(r.status(), await r.text()).toBe(200);
    };
    const navAway = async (api, c, taskId) => {
      const r = await api.post(`/api/tasks/${taskId}/navigated-away`, { headers: H(c), data: { via: "test" } });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      // The route dedups two events on the same (user, task) inside 2 s, so a
      // caller that needs a COUNT must space them — otherwise the fixture
      // asserts 2 against a stored 1.
      expect(body.deduped, "navigated-away must not have been deduped").toBeFalsy();
      // v7.27.0 — and it must not have been refused as already-solved. Both
      // refusals answer 200, so without this a mis-ordered fixture would store
      // nothing while every call still looked successful.
      expect(body.skipped, "navigated-away must not have been refused").toBeFalsy();
    };

    // v7.27.0 — THE TWO NAVIGATED-AWAY EVENTS MUST PRECEDE THE SOLVE. A solved
    // challenge no longer records one (the `already_solved` gate in
    // routes/participant.js), so leaving them after the correct submit would
    // store ZERO and the count-of-2 assertion this fixture exists for would be
    // asserting nothing. Bouncing off a challenge twice and coming back to solve
    // it is also the sequence the signal is meant to describe, and it leaves the
    // expected matrix byte-identical.
    await act(aa, async (api, c) => {
      await submit(api, c, alpha, "wrong-1", false);
      await submit(api, c, alpha, "wrong-2", false);
      await hint(api, c, alpha);
      await navAway(api, c, alpha);
      await submit(api, c, zeta, "nope", false);
    });
    // Spaced past the 2 s dedup window so aa/Alpha genuinely records TWO.
    await new Promise(r => setTimeout(r, 2200));
    await act(aa, async (api, c) => {
      await navAway(api, c, alpha);
      await submit(api, c, alpha, "right", true);
    });

    await act(bb, async (api, c) => { await hint(api, c, mike); });
    await act(zz, async (api, c) => {
      await submit(api, c, mike, "right", true);
      await navAway(api, c, zeta);
    });
    // ss (staff) deliberately does nothing — it must be absent from the file
    // regardless, and giving it activity would only prove the same thing twice.

    // ── the DECOY competition ────────────────────────────────────────────────
    // Every query in the route binds competition_id. With a single competition
    // in the fixture, removing EVERY ONE of those predicates would produce a
    // byte-identical file — so the whole matrix above could not tell correct
    // scoping from none at all. This is the discriminator: the same participant
    // does all four things to `mike` in a DIFFERENT competition, and `aa`/`mike`
    // is a cell that reads all-No in the main file. Any leak flips it.
    const decoyId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Decoy Activity ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }})).json()).competition.id;
    for (const id of [mike, zeta]) {
      // `zeta` rides along unsolved purely so the decoy cannot all-solved
      // auto-end under the test and change its own status mid-run.
      expect((await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [decoyId] } })).ok()).toBeTruthy();
    }
    const dAsg = await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [aa.id], competitionIds: [decoyId] } });
    expect((await dAsg.json()).assigned, "aa must enrol in the decoy").toBe(1);

    await actIn(aa, decoyId, async (api, c) => {
      await submit(api, c, mike, "wrong-elsewhere", false);
      await hint(api, c, mike);
      // v7.27.0 — before the solve, for the same reason as the main fixture: a
      // solved challenge records no navigated_away, so the decoy would carry
      // three signals instead of four and could no longer prove that a leak in
      // the FOURTH column is caught.
      await navAway(api, c, mike);
      await submit(api, c, mike, "right", true);
    });

    F = { compId, compName, decoyId, t, aa, bb, zz, ss,
          titles: { alpha: `Alpha ${t}`, delta: `Delta ${t}`, mike: `Mike ${t}`, zeta: `Zeta ${t}` },
          // Numbering is per (challenge, competition): `mike` is 1.02 in the
          // main competition and 1.01 in the decoy, which is what proves the ID
          // column is read from competition_tasks scoped to the competition
          // asked for rather than from anything task-global.
          nums:   { alpha: "3.01", delta: "2.01", mike: "1.02", zeta: "1.01" },
          decoyNums: { mike: "1.01", zeta: "1.02" } };
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE LOAD-BEARING ONE — the full cross product, in order, cell by cell.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: the CSV is the full participant x challenge cross product, correct per cell", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const r = await sa.get(EXPORT_URL(F.compId));
    expect(r.status(), await r.text()).toBe(200);
    const text = await r.text();

    // The ONE positional assertion in this file: the header's exact labels in
    // their exact order. Everything below asks for columns BY NAME through
    // csvObjects, so this is the single place a column insert has to be
    // reflected — and it is exhaustive (toEqual), so a mis-spelled or
    // mis-ordered header fails here and nowhere else.
    expect(parseCsv(text)[0]).toEqual([
      "Nickname", "First Name", "Last Name", "Company",
      "Challenge ID", "Challenge", "Difficulty", "Points",
      "Solved", "Hint Revealed", "Incorrect Submissions", "Navigated Away",
    ]);

    const { rows } = csvObjects(text);

    // 3 included participants x 4 assigned challenges. The staff row is absent,
    // so 16 would be a silent over-count and 8 a silent under-count.
    expect(rows.length, "one row per participant per challenge").toBe(12);

    const { alpha, delta, mike, zeta } = F.titles;
    const N = F.nums;
    const A = F.aa.nick, B = F.bb.nick, Z = F.zz.nick;
    // v7.24.0 — sorted by nickname ASC, then by the per-competition challenge
    // NUMBER ASC: Zeta 1.01, Mike 1.02, Delta 2.01, Alpha 3.01. That order is
    // neither title order nor assignment order (see mkTask), so this matrix
    // fails against a build that used either.
    expect(rows.map(x => [
      x[COL.nick], x[COL.id], x[COL.challenge], x[COL.difficulty], x[COL.points], ...signals(x),
    ])).toEqual([
      [A, N.zeta,  zeta,  "easy",   "50",  "No",  "No",  "1", "0"],
      // `aa` did all four of these to `mike` in the DECOY competition. Every
      // cell here must stay No/No/0/0, which is what makes this row the guard
      // against a query losing its competition_id predicate.
      [A, N.mike,  mike,  "easy",   "50",  "No",  "No",  "0", "0"],
      [A, N.delta, delta, "medium", "100", "No",  "No",  "0", "0"], // assigned but HIDDEN — still gets rows
      [A, N.alpha, alpha, "hard",   "150", "Yes", "Yes", "2", "2"], // solved after 2 wrong, hint taken, left twice
      [B, N.zeta,  zeta,  "easy",   "50",  "No",  "No",  "0", "0"],
      [B, N.mike,  mike,  "easy",   "50",  "No",  "Yes", "0", "0"],
      [B, N.delta, delta, "medium", "100", "No",  "No",  "0", "0"],
      [B, N.alpha, alpha, "hard",   "150", "No",  "No",  "0", "0"],
      [Z, N.zeta,  zeta,  "easy",   "50",  "No",  "No",  "0", "1"],
      [Z, N.mike,  mike,  "easy",   "50",  "Yes", "No",  "0", "0"],
      [Z, N.delta, delta, "medium", "100", "No",  "No",  "0", "0"],
      [Z, N.alpha, alpha, "hard",   "150", "No",  "No",  "0", "0"],
    ]);

    // Identity columns come from the users row, not from the nickname.
    const first = rows[0];
    expect(first[COL.first]).toBe(`F${A}`);
    expect(first[COL.last]).toBe(`L${A}`);
    expect(first[COL.company]).toBe("Acme Ltd");
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Competition scoping, stated as its own claim. The matrix above already
//     fails if it breaks, but only implicitly — this names it, and reads the
//     DECOY's own file too, so "nothing leaked" is shown to mean "the activity
//     really happened, just somewhere else" rather than "it never happened".
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: activity in another competition never leaks into this one", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const main = csvObjects(await (await sa.get(EXPORT_URL(F.compId))).text()).rows;
    const cell = main.find(x => x[COL.nick] === F.aa.nick && x[COL.challenge] === F.titles.mike);
    expect(signals(cell), "aa did all four of these to Mike — in the OTHER competition")
      .toEqual(["No", "No", "0", "0"]);

    // POSITIVE control: the decoy activity is real and reachable. Without this
    // the assertion above is equally satisfied by a fixture that silently never
    // performed it.
    const decoy = csvObjects(await (await sa.get(EXPORT_URL(F.decoyId))).text()).rows;
    const there = decoy.find(x => x[COL.nick] === F.aa.nick && x[COL.challenge] === F.titles.mike);
    expect(there, "aa must appear in the decoy competition's own file").toBeTruthy();
    expect(signals(there)).toEqual(["Yes", "Yes", "1", "1"]);
    // …and the decoy carries only its OWN two challenges, so the challenge list
    // is scoped as well as the activity.
    expect([...new Set(decoy.map(x => x[COL.challenge]))].sort())
      .toEqual([F.titles.mike, F.titles.zeta].sort());

    // v7.24.0 — the Challenge ID is scoped to the competition ASKED FOR, not to
    // the challenge. `mike` is 1.02 in the main file and 1.01 here, so a build
    // that read the number from anywhere task-global — or from the first
    // competition it happened to find — fails on exactly one of these two.
    expect(there[COL.id], "the decoy numbers Mike 1.01, the main competition 1.02")
      .toBe(F.decoyNums.mike);
    expect(main.find(x => x[COL.nick] === F.aa.nick && x[COL.challenge] === F.titles.mike)[COL.id])
      .toBe(F.nums.mike);
    // NOT asserted here: the decoy's row ORDER. Its two challenges are Mike
    // (1.01) and Zeta (1.02), so number order, title order and assignment order
    // all coincide — an ordering assertion on this file would read as a lock and
    // be satisfied by any of the three. Ordering is discriminated in test 1,
    // whose fixture is built so the three disagree.
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. A challenge that is assigned but no longer visible still gets rows.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: an assigned-but-hidden challenge is still exported", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    // POSITIVE control: it really is hidden, so this is not asserting that an
    // ordinary challenge appears.
    const t = (await (await sa.get("/api/admin/tasks?limit=500")).json());
    const list = Array.isArray(t) ? t : (t.tasks || []);
    const hidden = list.find(x => x.title === F.titles.delta);
    expect(hidden, "the hidden challenge must exist").toBeTruthy();
    expect(hidden.active === 0 || hidden.active === false, "it must actually be hidden").toBe(true);

    const rows = csvObjects(await (await sa.get(EXPORT_URL(F.compId))).text()).rows;
    const forDelta = rows.filter(x => x[COL.challenge] === F.titles.delta);
    expect(forDelta.length, "one row per participant, even for a hidden challenge").toBe(3);
    // It keeps its number and its worth too — hiding a challenge does not
    // change what it was.
    expect(forDelta.map(x => [x[COL.id], x[COL.difficulty], x[COL.points]]))
      .toEqual([[F.nums.delta, "medium", "100"], [F.nums.delta, "medium", "100"], [F.nums.delta, "medium", "100"]]);
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The participant set — staff out, benchmark in.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: a staff-tagged enrollee is excluded and a benchmark-tagged one is kept", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const rows = csvObjects(await (await sa.get(EXPORT_URL(F.compId))).text()).rows;
    const nicks = new Set(rows.map(x => x[COL.nick]));
    expect(nicks.has(F.ss.nick), "staff must NOT appear — admins carry that tag").toBe(false);
    expect(nicks.has(F.bb.nick), "benchmark IS a participant; reference scores are the point").toBe(true);
    expect(nicks.has(F.aa.nick)).toBe(true);
    expect(nicks.has(F.zz.nick)).toBe(true);
    expect(nicks.size).toBe(3);
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Spreadsheet-formula neutralisation, end to end, with a positive control.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: a participant-authored formula is neutralised, an ordinary value is not", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const text = await (await sa.get(EXPORT_URL(F.compId))).text();
    const rows = csvObjects(text).rows;
    const bench = rows.find(x => x[COL.nick] === F.bb.nick);
    // Quoting alone does NOT stop Excel evaluating a cell — the quotes are the
    // delimiter and are stripped before type inference. The leading apostrophe
    // is what does it, so assert the apostrophe, not merely "the value is there".
    expect(bench[COL.company].startsWith("'=")).toBe(true);
    expect(bench[COL.company]).toBe(`'=HYPERLINK("http://evil.example","clickme")`);
    // POSITIVE CONTROL: a helper that apostrophised every cell would satisfy the
    // assertion above. Ordinary text must be untouched.
    const plain = rows.find(x => x[COL.nick] === F.aa.nick);
    expect(plain[COL.company]).toBe("Acme Ltd");
    expect(plain[COL.company].startsWith("'")).toBe(false);
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. The impersonation asymmetry — the one column that filters it, and the
//     three that deliberately do not.
// ─────────────────────────────────────────────────────────────────────────────
// It owns a whole fixture rather than borrowing the shared one: impersonating
// into the main competition would durably change cells the other tests assert,
// making this file an order-dependent narrative instead of a set of independent
// tests.
test("v7.23.0: an admin's impersonated navigate-away is excluded; an impersonated SOLVE is not", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let compId, taskId, tgt;
  try {
    const t = uniq();
    compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Imp Activity ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }})).json()).competition.id;
    taskId = (await (await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `ImpTask ${t}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
      correct_answer: "right", hint: "a hint", status: "published",
    }})).json()).id;
    expect((await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } })).ok()).toBeTruthy();
    tgt = await mkP(sa, csrf, `im${t}`, "Imp Co");
    const asg = await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [tgt.id], competitionIds: [compId] } });
    expect((await asg.json()).assigned).toBe(1);

    const imp = await sa.post(`/api/admin/participants/${tgt.id}/impersonate`, { headers: H(csrf) });
    expect(imp.status(), await imp.text()).toBe(200);
    // The session was regenerated — refresh CSRF before any write.
    const c2 = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    expect((await sa.post("/api/select-competition", { headers: H(c2), data: { competitionId: compId } })).ok()).toBeTruthy();
    expect((await sa.post(`/api/tasks/${taskId}/navigated-away`, { headers: H(c2), data: { via: "imp" } })).ok()).toBeTruthy();
    // A superadmin-tier impersonation may write, and a solve it makes is a REAL
    // score change for a real participant — so it must show up.
    const gh = await gradingHashFor(sa, taskId);
    const sub = await sa.post(`/api/tasks/${taskId}/submit`, { headers: H(c2), data: { answer: "right", gradingHash: gh } });
    expect(sub.status(), await sub.text()).toBe(200);
    expect((await sub.json()).correct).toBe(true);
    expect((await sa.post("/api/impersonation/exit", { headers: H(c2) })).ok()).toBeTruthy();
  } finally { await sa.dispose(); }

  const { api: sa2 } = await apiLogin("superadmin");
  try {
    const rows = csvObjects(await (await sa2.get(EXPORT_URL(compId))).text()).rows;
    expect(rows.length, "one participant x one challenge").toBe(1);
    const row = rows[0];
    // Navigated away is telemetry about who was LOOKING at the screen, and that
    // was the admin — so it stays 0 (v7.14.0, and it is why analytics pushes
    // `ce.impersonated=0`). Drop that predicate here and this reads 1.
    expect(row[COL.nav], "an admin's navigation is not the participant's").toBe("0");
    // Solved is score-bearing and deliberately NOT filtered — same doctrine,
    // opposite side. The participant themselves never submitted anything.
    expect(row[COL.solved], "an impersonated solve really did score the participant").toBe("Yes");
  } finally { await sa2.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Response shape — the headers a browser and a spreadsheet both depend on.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: the response is a UTF-8 CSV attachment, never text/html", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const r = await sa.get(EXPORT_URL(F.compId));
    expect(r.status()).toBe(200);
    // res.send(<string>) with no type defaults to text/html, and this body
    // carries participant-authored names — that would be stored XSS.
    expect(r.headers()["content-type"]).toMatch(/^text\/csv/);
    expect(r.headers()["content-type"]).toMatch(/charset=utf-8/i);
    const cd = r.headers()["content-disposition"];
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toMatch(/filename="Activity_Export_[^"]*-activity-\d{4}-\d{2}-\d{2}\.csv"/);
    // The UTF-8 BOM, as raw bytes: without it Excel on Windows decodes the file
    // with the system ANSI code page and mojibakes every accented name.
    const buf = await r.body();
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The live-or-ended gate, and the request-validation refusals.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: an UPCOMING competition is refused, an ENDED one is allowed", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const up = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Upcoming CAE ${t}`, start_time: new Date(Date.now() + 3_600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition.id;
    const r = await sa.get(EXPORT_URL(up));
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("competition_not_started");

    // Ending it must open the export — the gate is "not upcoming", not "ended".
    const ended = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Ended CAE ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }})).json()).competition.id;
    expect((await sa.post(`/api/admin/competitions/${ended}/end-now`, { headers: H(csrf) })).ok()).toBeTruthy();
    const r2 = await sa.get(EXPORT_URL(ended));
    expect(r2.status(), await r2.text()).toBe(200);
    // No participants and no challenges → headers only, which is a real answer.
    expect(parseCsv(await r2.text()).length).toBe(1);
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// v7.24.0 — challenge NUMBERS are assigned lazily, and the ordinary
// set-it-up-the-night-before shape reaches this export before anything has
// assigned them.
//
// `ensureTaskNumbers` is a documented no-op for an UPCOMING competition, and
// the only things that call it are the three assign paths and the participant's
// GET /api/tasks. So: assign the challenges while the competition is still
// upcoming (numbers no-op), let it become live purely by the clock (status is
// time-derived — nothing fires on the transition), and export before the first
// participant signs in. Every Challenge ID cell would be blank, and since the
// file is now SORTED by that column the rows would come back in tiebreak order
// with no numbering at all.
//
// The competition is created upcoming and then MOVED into the past, because
// creating it live would let the assign path number it and the test would
// assert nothing. The `?? 0` on the assertion is deliberate: a blank cell and a
// missing column are different failures and both must be visible.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.24.0: an export numbers challenges that were assigned while the competition was upcoming", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const mk = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Lazy Numbering ${t}`,
      start_time: new Date(Date.now() + 3_600_000).toISOString(), duration_minutes: 60,
    }});
    expect(mk.status(), await mk.text()).toBe(200);
    const compId = (await mk.json()).competition.id;

    // Assigned while UPCOMING → competition_tasks.task_number stays NULL.
    const ids = [];
    for (const [title, difficulty] of [[`LN Beta ${t}`, "medium"], [`LN Alpha ${t}`, "easy"]]) {
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title, description: "<p>d</p>", difficulty, answer_type: "text",
        correct_answer: "right", explanation: "<p>e</p>", status: "published",
      }});
      expect(r.status(), await r.text()).toBe(200);
      const id = (await r.json()).id;
      expect((await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } })).ok()).toBeTruthy();
      ids.push(id);
    }

    // POSITIVE CONTROL on the premise: the export is refused right now, i.e. the
    // competition really is upcoming and the assign really did run in that state.
    expect((await sa.get(EXPORT_URL(compId))).status(), "the fixture must still be upcoming here").toBe(400);

    const p = await mkP(sa, csrf, `ln${t}`, "Lazy Ltd");
    expect((await sa.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [p.id], competitionIds: [compId] },
    })).ok()).toBeTruthy();

    // Move it into the past so it is LIVE by the clock alone. `expectedUpdatedAt`
    // is required by the optimistic-concurrency guard on this route.
    const cur = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    const put = await sa.put(`/api/admin/competitions/${compId}`, { headers: H(csrf), data: {
      start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
      expectedUpdatedAt: cur.updated_at,
    }});
    expect(put.status(), await put.text()).toBe(200);

    const { rows } = csvObjects(await (await sa.get(EXPORT_URL(compId))).text());
    expect(rows.length, "one participant x two challenges").toBe(2);
    expect(rows.every(r => (r[COL.id] ?? "") !== ""),
      `every challenge must carry a number — got ${JSON.stringify(rows.map(r => r[COL.id]))}`).toBe(true);
    // …and numbered by difficulty bucket, so the easy one leads: Alpha 1.01,
    // Beta 2.01. That also happens to be the reverse of assignment order, so a
    // build that skipped the numbering and fell back to a tiebreak fails here
    // rather than passing on a coincidence.
    expect(rows.map(r => [r[COL.id], r[COL.challenge], r[COL.points]])).toEqual([
      ["1.01", `LN Alpha ${t}`, "50"],
      ["2.01", `LN Beta ${t}`, "100"],
    ]);
    void ids;
  } finally { await sa.dispose(); }
});

test("v7.23.0: a missing, unknown or repeated competitionId is refused, never a 500", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    expect((await sa.get("/api/admin/export/competition-activity")).status()).toBe(400);
    expect((await sa.get(EXPORT_URL("no-such-competition"))).status()).toBe(404);
    // audit v7.7.38 (H3): Express 5 turns a repeated param into an ARRAY, and
    // better-sqlite3 refuses to bind one — unguarded this is a 500.
    const dup = await sa.get(`/api/admin/export/competition-activity?competitionId=${F.compId}&competitionId=other`);
    expect(dup.status()).toBe(400);
  } finally { await sa.dispose(); }
});

test("v7.23.0: a participant cannot reach the export", async () => {
  const { api, csrf } = await apiLogin(F.aa.email, PARTICIPANT_PASS);
  try {
    void csrf;
    expect((await api.get(EXPORT_URL(F.compId))).status()).toBe(403);
  } finally { await api.dispose(); }
});

// A SOURCE lock, deliberately, and the reason is worth stating: the behavioural
// version would have to force-enable rate limiting and fire 11 unauthenticated
// requests, and a non-429 4xx feeds the scanner-reputation counter — 100 of them
// from one address blocks the whole worker's IP for 15 minutes (v7.15.34), which
// would surface as unrelated specs failing later in the file. So the deliberate
// deviation is pinned where it is written instead.
// ─────────────────────────────────────────────────────────────────────────────
// 6. The forensic record — this file is participant PII.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: the export emits an attributed data_exported audit event", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    expect((await sa.get(EXPORT_URL(F.compId))).ok()).toBeTruthy();
    // The app.jsonl mirror is setImmediate-deferred, so poll rather than read once.
    let line = null;
    await expect.poll(() => {
      const dir = path.join(TEST_DATA_DIR, "logs");
      const files = fs.readdirSync(dir).filter(f => f.startsWith("app-") && f.endsWith(".jsonl")).sort();
      if (!files.length) return false;
      const lines = fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          if (j.source === "audit" && j.scope === "export" && j.scope_id === "competition-activity"
              && j.event_type === "data_exported" && j.details && j.details.competition_id === F.compId) {
            line = j; return true;
          }
        } catch (_) { /* skip */ }
      }
      return false;
    }, { timeout: 8000, intervals: [100, 200, 400, 800] }).toBe(true);

    // ATTRIBUTED means it names the CALLER — "some non-empty actor" would be
    // satisfied by a hard-coded string, which is not a forensic record.
    expect([line.actor, line.changed_by], "the event must name who pulled it")
      .toContain("superadmin");
    // v7.21.32 — a user-driven event carries the requester's IP.
    expect(line.details.ip).toBeTruthy();
    expect(line.details.req_id).toBeTruthy();
    expect(line.details.row_count).toBe(12);
    expect(line.details.participant_count).toBe(3);
    expect(line.details.challenge_count).toBe(4);
  } finally { await sa.dispose(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The event's menu (its workspace ⋯; the Events-row menu keeps only Delete
//    event) — the item is gated, and the download really works under the CSP.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.0: the kebab item downloads the CSV for a live competition", async ({ page }) => {
  await adminLogin(page);
  await clickTab(page, "Events");
  // The table paginates at 30 and this worker's DB accumulates, so narrow first
  // — an unfiltered lookup fails because the row is genuinely ABSENT.
  await filterComps(page, F.compName);
  const row = page.locator("#admin-comp-body tr", { hasText: F.compName }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await openRowEventMenu(page, row);

  const item = page.locator("#kebab-portal [data-action='comp-export-activity']");
  await expect(item).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    item.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-activity-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await download.path(), "utf8");
  // The real bytes, not an intercepted stub — page.route() here would replace
  // the very thing under test.
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const rows = parseCsv(text);
  expect(rows[0][0]).toBe("Nickname");
  expect(rows.length - 1).toBe(12);
});

test("v7.23.0: the kebab item is present for an ENDED competition", async ({ page }) => {
  // The other half of the documented gate, and the likelier real use — an
  // organiser exports after the event, not during it.
  const { api: sa, csrf } = await apiLogin("superadmin");
  const name = `Ended Kebab ${uniq()}`;
  try {
    const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }});
    expect(r.status(), await r.text()).toBe(200);
    const id = (await r.json()).competition.id;
    expect((await sa.post(`/api/admin/competitions/${id}/end-now`, { headers: H(csrf) })).ok()).toBeTruthy();
  } finally { await sa.dispose(); }

  await adminLogin(page);
  await clickTab(page, "Events");
  // The status chips default to live+upcoming, so an ENDED competition is
  // filtered out of the table before the search box ever sees it.
  await page.locator("#comp-status-filters [data-status='all']").click();
  await filterComps(page, name);
  const row = page.locator("#admin-comp-body tr", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await openRowEventMenu(page, row);
  await expect(page.locator("#kebab-portal [data-action='comp-export-activity']")).toBeVisible();
});

test("v7.23.0: the kebab item is absent for an UPCOMING competition", async ({ page }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const name = `Upcoming Kebab ${uniq()}`;
  try {
    const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name, start_time: new Date(Date.now() + 7_200_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.status(), await r.text()).toBe(200);
  } finally { await sa.dispose(); }

  await adminLogin(page);
  await clickTab(page, "Events");
  await filterComps(page, name);
  const row = page.locator("#admin-comp-body tr", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await openRowEventMenu(page, row);
  // POSITIVE CONTROL: the menu really did open and really does carry items, so
  // "the export item is absent" is evidence about the gate rather than about an
  // empty portal.
  await expect(page.locator("#kebab-portal [data-action='comp-history']")).toBeVisible();
  await expect(page.locator("#kebab-portal [data-action='comp-export-activity']")).toHaveCount(0);
});
