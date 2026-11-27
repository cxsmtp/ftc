// @ts-check
//
// v8.3.11 — A BOOTH EVENT NEVER AUTO-ENDS BECAUSE EVERYONE FINISHED.
//
// A Booth Event is a stand. The people currently at it finishing every challenge
// says nothing about the next walk-up, so "all participants solved everything"
// must never close it. Until this release that guarantee rested on a CONVENTION
// — three cooperating writers all agreeing to store `auto_end_on_all_solved=0`
// on a booth row — and a convention is one writer away from being false. It HAS
// been false: at v8.0.0 the competition create INSERT named `event_kind` but not
// `auto_end_on_all_solved`, so a Booth Event created in that one-day window took
// the schema DEFAULT of 1 and auto-ends to this day.
//
// The fix reads the PROHIBITION at the gate (`autoEndOnAllSolvedApplies`,
// lib/event-policy.js), which turns the convention into a theorem: whatever the
// column holds, a booth does not auto-end.
//
// ── WHAT EACH TEST HERE IS ACTUALLY WORTH, stated up front because two of them
//    are much weaker than they look ───────────────────────────────────────────
//
//   * "a default booth stays live" locks the SHIPPED end-to-end behaviour and
//     nothing more. It passes against the pre-v8.3.11 build too, because a
//     default booth's column is already 0 — the column clause alone answers it.
//     It earns its place as the realistic path plus its tournament control, not
//     as evidence about the prohibition.
//   * "a FORCED column does not defeat the prohibition" is the theorem test, and
//     it is the only one in this file that distinguishes the policy clause from
//     the column clause. Mutate booth's policy to "allowed", or delete the policy
//     clause from the predicate, and THIS is the test that goes red.
//
// ── THE SELF-ENROLLMENT TRAP, and why every fixture here turns it off ─────────
//
// v7.7.18 already suppresses the all-solved auto-end for any competition whose
// /join link is open, and `selfEnrollDefault` is 1 for booth — so a booth built
// with the create route's defaults stays live for a reason that has nothing to
// do with its kind. Every fixture below passes `self_enroll_enabled: false`, or
// the whole file would prove the v7.7.18 rule over again and nothing about
// v8.3.11.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, gradingHashFor, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `bae${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// The competition-row cache in lib/competitions.js has a 1 s TTL, and every
// direct DB write below has to be VISIBLE to the handler under test — a stale
// cached row carrying `auto_end_on_all_solved=0` would make the forced-column
// tests pass on a build with no prohibition at all, i.e. exactly vacuous. There
// is no invalidation hook reachable from a spec, so the wait is the mechanism.
const CACHE_TTL_MS = 1_000;
const outliveCompCache = () => new Promise(r => setTimeout(r, CACHE_TTL_MS + 250));

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${await r.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}

/** Own every participant (CLAUDE.md fixture checklist item 3). */
async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Booth", lastName: "Probe", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `search` is a NO-OP on this endpoint (page 1, created_at ASC), so the
  // documented 5000 cap is what actually finds a just-created account.
  const list = await (await api.get("/api/admin/participants?limit=5000")).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} findable among ${(list.participants || []).length} participants`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email };
}

/**
 * A LIVE, sessionless event of the given kind, one published text challenge, one
 * enrolled participant — the smallest fixture in which "everybody has finished
 * everything" is true.
 *
 * TEXT answers, because a Booth Event REFUSES `answer_type:'file'` and a
 * `needs:`-tagged challenge (lib/challenge-fit.js) — the assign would 400 and the
 * failure would read as an auto-end bug.
 *
 * Deliberately ONE participant, which is the opposite of the usual fixture advice:
 * checklist item 1 says to enrol a non-solver so the auto-end cannot fire, and
 * here the auto-end firing (for the tournament control) or not firing (for the
 * booth) IS the subject.
 */
async function liveEvent(api, csrf, kind, opts = {}) {
  const name = `AE ${kind} ${uniq()}`;
  const create = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name,
      event_kind: kind,
      start_time: new Date(Date.now() - 5 * 60_000).toISOString(),
      duration_minutes: opts.duration || 180,
      // See the self-enrollment trap at the top of the file. Booth defaults this
      // ON, and an open /join link suppresses the auto-end all by itself.
      self_enroll_enabled: false,
    },
  });
  expect(create.ok(), `create ${kind}: ${await create.text()}`).toBeTruthy();
  const comp = (await create.json()).competition;
  expect(comp.status, `${kind} fixture must actually be LIVE`).toBe("live");

  const task = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: {
      title: `AE task ${uniq()}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "win", status: "published",
    },
  });
  expect(task.ok(), `create task: ${await task.text()}`).toBeTruthy();
  const taskId = (await task.json()).id;
  const assignTask = await api.post(`/api/admin/tasks/${taskId}/competitions`, {
    headers: H(csrf), data: { competitionIds: [comp.id] },
  });
  expect(assignTask.ok(), `assign task: ${await assignTask.text()}`).toBeTruthy();

  const p = await makeParticipant(api, csrf, uniq());
  const assign = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: [p.id], competitionIds: [comp.id] },
  });
  // The assign endpoint SILENTLY SKIPS staff / benchmark / blocked / unapproved
  // users, so assert the count — a skip would otherwise surface as an
  // inexplicable "the event did not end" much further down.
  expect((await assign.json()).assigned, "the participant must really be enrolled").toBe(1);

  return { comp, taskId, participant: p };
}

/** The participant solves the only challenge, which makes the cohort finished. */
async function solveEverything(participant, compId, taskId) {
  const { api, csrf: c0 } = await freshCtx();
  try {
    const login = await codeLogin(api, participant.email, H(c0));
    expect(login.ok(), `participant login: ${await login.text()}`).toBeTruthy();
    const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
    const sub = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: H(csrf),
      data: { answer: "win", gradingHash: await gradingHashFor(api, taskId) },
    });
    const body = await sub.json();
    expect(body.correct, `the solve must be graded correct: ${JSON.stringify(body)}`).toBeTruthy();
    return body;
  } finally { await api.dispose(); }
}

const listComp = async (api, id) =>
  (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);

/**
 * Direct SQLite write against the SERVER's own database.
 *
 * v7.20.2 — the `better-sqlite3` require is LAZY, inside the call, because a
 * module-scope binding is taken BEFORE the per-file recycle deletes and
 * recreates the file, leaving the handle on an unlinked inode that answers with
 * the previous file's data and no error.
 *
 * The state being written is not manufactured: `auto_end_on_all_solved=1` on a
 * booth is exactly what a v8.0.0-era row holds today, and it is unreachable
 * through the API because the column is deliberately absent from
 * COMPETITION_FIELD_SCHEMA (no form sends it).
 */
function rawUpdateComp(id, sql, params = []) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const r = db.prepare(`UPDATE competitions SET ${sql} WHERE id=?`).run(...params, id);
    expect(r.changes, "the direct write must land, or every assertion after it is about nothing").toBe(1);
  } finally { db.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// The submit-path auto-end scan
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.11 — the all-solved auto-end and the Booth prohibition", () => {
  test("a Booth Event stays LIVE when its whole cohort finishes — and a Competition does not", async () => {
    const { api, csrf } = await sa();
    try {
      // ── THE CONTROL, AND IT CARRIES MOST OF THE WEIGHT OF THIS TEST ──
      // "The booth stayed live" is equally satisfied by a build in which the
      // all-solved auto-end is globally broken — a far worse regression, and one
      // no other assertion here would notice. An identical Competition built by
      // the same helper, solved by the same code path, must end.
      const ctl = await liveEvent(api, csrf, "tournament");
      await solveEverything(ctl.participant, ctl.comp.id, ctl.taskId);
      const ctlRow = await listComp(api, ctl.comp.id);
      expect(ctlRow.status, "control: a Competition auto-ends when everyone has finished").toBe("ended");
      expect(ctlRow.ended_at, "control: and stamps ended_at").toBeTruthy();

      // ── THE SUBJECT ──
      const booth = await liveEvent(api, csrf, "booth");
      // Precondition, not decoration: if the kind did not survive the create the
      // subject is a Competition and the assertion below is about the wrong row.
      expect(booth.comp.event_kind, "the fixture must really be a Booth Event").toBe("booth");
      expect(booth.comp.self_enroll_enabled, "self-enrollment must be OFF, or v7.7.18 answers this test").toBeFalsy();
      await solveEverything(booth.participant, booth.comp.id, booth.taskId);
      const boothRow = await listComp(api, booth.comp.id);
      expect(boothRow.status, "a stand stays open for the next walk-up whatever the people at it have done").not.toBe("ended");
      expect(boothRow.ended_at, "and stamps no ended_at").toBeFalsy();
    } finally { await api.dispose(); }
  });

  test("a FORCED auto_end_on_all_solved=1 does not defeat the prohibition", async () => {
    // THE THEOREM TEST. Everything above is satisfied by the pre-v8.3.11 build,
    // because a booth's column already defaults to 0 and the column clause alone
    // answers the question. This is the case that separates the two clauses: the
    // column says "end me", the kind says "never", and the kind wins.
    //
    // The row shape is the real one. A Booth Event created in the v8.0.0 window
    // took the schema DEFAULT 1 for this column while `self_enroll_enabled` was
    // bound from a plain `self_enroll_enabled ? 1 : 0` with no per-kind default —
    // so a legacy booth carries auto_end=1 AND self-enrollment OFF by
    // construction. Nothing here is invented to make the test reachable.
    //
    // Mutations this catches: booth's policy changed to
    // `autoEndOnAllSolved: "allowed"`, and the policy clause deleted from
    // `autoEndOnAllSolvedApplies`.
    const { api, csrf } = await sa();
    try {
      const booth = await liveEvent(api, csrf, "booth");
      rawUpdateComp(booth.comp.id, "auto_end_on_all_solved=1");
      // Read it back through the admin list, which SELECTs the column directly
      // rather than through the cached row — proves the write landed before the
      // wait below is asked to make it visible.
      expect((await listComp(api, booth.comp.id)).auto_end_on_all_solved,
        "the legacy shape must really be in place").toBeTruthy();
      await outliveCompCache();

      await solveEverything(booth.participant, booth.comp.id, booth.taskId);

      const row = await listComp(api, booth.comp.id);
      expect(row.status,
        "the kind's prohibition outranks the stored column — that is what makes this a theorem "
        + "rather than a convention three writers happen to keep").not.toBe("ended");
      expect(row.ended_at, "and no ended_at is stamped").toBeFalsy();
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The revive gate — the consumer that had never asked the question at all
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.11 — reviving an event whose kind never auto-ends", () => {
  /**
   * Put a finished cohort's event into the state a v8.0.0-era booth is really in
   * today: ended_at set, ended_manually 0 (so it reads as an AUTO end), and
   * everyone finished.
   *
   * Written directly because the fix makes it unreachable through the API — a
   * booth cannot auto-end any more, and `end-now` would set `ended_manually=1`,
   * which the gate skips for an entirely different documented reason (v7.7.x).
   * Using end-now here would produce a green test that proves nothing.
   */
  function forceAutoEnded(compId) {
    rawUpdateComp(compId, "ended_at=?, ended_manually=0", [new Date(Date.now() - 60_000).toISOString()]);
  }

  test("extending a legacy auto-ended Booth Event REVIVES it — while a Competition is still refused", async () => {
    const { api, csrf } = await sa();
    try {
      // ── THE CONTROL ──
      // "The booth revived" is equally satisfied by a build where the all-solved
      // gate was deleted outright, which would silently reopen settled
      // Competitions — the exact zombie-live state the gate exists to prevent. So
      // an identical Competition, in the identical state, must still be REFUSED.
      const ctl = await liveEvent(api, csrf, "tournament");
      await solveEverything(ctl.participant, ctl.comp.id, ctl.taskId);
      const ctlEnded = await listComp(api, ctl.comp.id);
      expect(ctlEnded.status, "control precondition: the Competition auto-ended").toBe("ended");
      expect(ctlEnded.ended_manually, "control precondition: an AUTO end, not a manual one").toBeFalsy();

      const ctlPut = await api.put(`/api/admin/competitions/${ctl.comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 600 },
      });
      expect(ctlPut.ok(), `control extend: ${ctlPut.status()} ${await ctlPut.text()}`).toBeTruthy();
      expect((await ctlPut.json()).allSolved,
        "control: the gate must still refuse a Competition whose cohort has finished").toBe(true);
      expect((await listComp(api, ctl.comp.id)).status, "control: and it stays ended").toBe("ended");

      // ── THE SUBJECT ──
      // A booth in the same state. Before v8.3.11 the gate did not consult the
      // kind at all, so this row was permanently unreopenable: it could never
      // auto-end again, and the predicate that would have ended it kept refusing
      // to let it back.
      const booth = await liveEvent(api, csrf, "booth");
      rawUpdateComp(booth.comp.id, "auto_end_on_all_solved=1");
      await solveEverything(booth.participant, booth.comp.id, booth.taskId);
      forceAutoEnded(booth.comp.id);
      // The handler reads the competition through the 1 s cache, so both the
      // ended_at and the forced column have to be older than the TTL or the PUT
      // decides against a row that no longer exists.
      await outliveCompCache();
      const boothEnded = await listComp(api, booth.comp.id);
      expect(boothEnded.status, "subject precondition: the booth is in the legacy ENDED state").toBe("ended");
      expect(boothEnded.ended_manually, "subject precondition: recorded as an AUTO end").toBeFalsy();

      const put = await api.put(`/api/admin/competitions/${booth.comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 600 },
      });
      expect(put.ok(), `booth extend: ${put.status()} ${await put.text()}`).toBeTruthy();
      const pj = await put.json();
      expect(pj.allSolved,
        "a gate that refuses to reopen an AUTO-ended event has nothing to protect where the "
        + "auto-end could never have fired — it must not even ask the question").toBeFalsy();
      const after = await listComp(api, booth.comp.id);
      expect(after.status, "the booth is live again").not.toBe("ended");
      expect(after.ended_at, "and its ended_at is cleared").toBeFalsy();
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The source lock — a kind added later must MAKE the decision
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.11 — every kind states its auto-end disposition", () => {
  test("autoEndOnAllSolved is an explicit, allowed value for every kind", () => {
    // The predicate's first clause is `=== "never"`, so an ABSENT key reads as
    // "allowed" — silently, and in the permissive direction. A kind invented next
    // year would therefore inherit auto-end by omission rather than by anyone
    // deciding it should. This forces the decision to be typed out.
    //
    // lib/event-policy.js is pure (it requires nothing at all), so an in-test
    // require opens no database and is the v7.20.2-safe form.
    const { EVENT_KINDS, eventPolicy } = require("../lib/event-policy");
    const ALLOWED = new Set(["never", "allowed"]);
    expect(EVENT_KINDS.length, "anti-vacuity: the kind table must not be empty").toBeGreaterThan(0);
    for (const k of EVENT_KINDS) {
      const v = eventPolicy({ event_kind: k.value }).autoEndOnAllSolved;
      expect(ALLOWED.has(v),
        `kind "${k.value}" must state autoEndOnAllSolved explicitly as one of ${[...ALLOWED].join("/")}, `
        + `got ${JSON.stringify(v)} — an absent key reads as "allowed" at the gate`).toBe(true);
    }
    // The shipped dispositions, pinned so a silent flip is a failing test rather
    // than a behaviour change nobody reviewed.
    expect(eventPolicy({ event_kind: "booth" }).autoEndOnAllSolved, "a stand never closes itself").toBe("never");
    expect(eventPolicy({ event_kind: "tournament" }).autoEndOnAllSolved).toBe("allowed");
    expect(eventPolicy({ event_kind: "program" }).autoEndOnAllSolved).toBe("allowed");
  });

  test("all three consumers read the SHARED predicate", () => {
    // ONE RULE, THREE CONSUMERS — the submit-path scan and the two revive gates.
    // Before v8.3.11 the two gates asked a weaker question of their own, which is
    // how an event that could never auto-end was still refused a revive by the
    // predicate that would have ended it. This pins that they read the shared
    // definition rather than re-deriving it, which is the only thing stopping the
    // three drifting apart again.
    //
    // THE TIMESLOT GATE IS PINNED HERE AND NOWHERE ELSE, and the reason is worth
    // stating rather than leaving as a gap: its new clause is currently INERT.
    // A slot inherits the decision from its parent competition, the only
    // session-bearing kind is `tournament`, and every API path stores 1 in that
    // kind's column (create binds the kind's default of 1, and a kind change
    // resets to the target kind's default) — so `autoEndOnAllSolvedApplies` is
    // always true for a competition that HAS slots. The clause exists for
    // uniformity with its single-slot twin and for a row reached by direct SQL, a
    // restored backup or a future session-bearing kind. A behavioural test would
    // have to manufacture a state the platform cannot produce, and would then be
    // asserting about the fixture rather than about the product.
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
    const src = (p) => stripComments(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
    // Comments are stripped first because the fix's own prose in all three files
    // names the call this scanner looks for — a scanner that reads its own
    // documentation is the v7.21.13 trap.
    for (const f of ["server.js", "routes/competitions.js", "routes/sessions.js"]) {
      expect(src(f), `${f} must ask the shared predicate`).toContain("autoEndOnAllSolvedApplies(");
    }
    // The two revive gates in their exact shape: manual end and open
    // self-enrollment already skip the all-solved check (v7.7.x / v7.7.18), and
    // the kind's prohibition is the third reason to skip it.
    const gate = /if \(!\w+\.ended_manually && !\w+\.self_enroll_enabled && autoEndOnAllSolvedApplies\(\w+\)\)/;
    expect(src("routes/competitions.js"), "the single-slot revive gate").toMatch(gate);
    expect(src("routes/sessions.js"), "the timeslot revive gate — its only lock").toMatch(gate);

    // The submit scan must keep the two refusals DISTINGUISHABLE. "This kind never
    // auto-ends" and "an admin turned it off for this event" are different
    // operational answers, and collapsing them into one span tag would make a
    // Booth Event indistinguishable from a misconfigured Competition in the only
    // record that says why the scan declined. Source-pinned because the tag is
    // emitted only on a slow-request span and is not observable over the API.
    const s = src("server.js");
    expect(s, "the kind-prohibition span tag").toContain("auto_end_forbidden_for_kind");
    expect(s, "the per-event opt-out span tag").toContain("auto_end_disabled");
  });

  test("the predicate needs BOTH clauses", () => {
    // Unit-level, because the two clauses are only separable in combinations the
    // API cannot produce: the column is absent from COMPETITION_FIELD_SCHEMA, so
    // no request can set it, and the create route derives it from the kind.
    const { autoEndOnAllSolvedApplies } = require("../lib/event-policy");
    expect(autoEndOnAllSolvedApplies({ event_kind: "booth", auto_end_on_all_solved: 1 }),
      "the POLICY clause: a booth refuses whatever the column says").toBe(false);
    expect(autoEndOnAllSolvedApplies({ event_kind: "tournament", auto_end_on_all_solved: 0 }),
      "the COLUMN clause: an admin-disabled Competition refuses too").toBe(false);
    expect(autoEndOnAllSolvedApplies({ event_kind: "tournament", auto_end_on_all_solved: 1 }),
      "anti-vacuity: the predicate must say YES to something, or both clauses above are free").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The boot normalisation, driven against the REAL db.js
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.11 — boot normalises auto_end_on_all_solved for a kind that forbids it", () => {
  test("a legacy booth row is reset to 0 and a Competition is left alone", () => {
    const Database = require("better-sqlite3");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "booth-autoend-"));
    // db.js is self-contained (better-sqlite3 / path / fs / crypto / uuid, plus
    // lib/event-policy, which is pure) — no lib/config, hence no BASE_URL — which
    // is what lets the migration run in a throwaway DATA_DIR rather than against
    // a spawned server.
    const bootDb = () => execFileSync(process.execPath, ["-e", "require('./db.js')"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATA_DIR: tmp, UPLOADS_DIR: `${tmp}/uploads`, NODE_OPTIONS: "" },   // v7.15.30 — never inherit node flags into a spawned child
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();

    try {
      bootDb();                                   // create the schema
      const dbPath = path.join(tmp, "hackathon.db");
      const db = new Database(dbPath);
      const ins = db.prepare(
        "INSERT INTO competitions (id,name,event_kind,start_time,duration_minutes,auto_end_on_all_solved,created_at)"
        + " VALUES (?,?,?,?,?,?,?)"
      );
      const T = "2026-01-01T10:00:00.000Z";
      ins.run("c-booth", "Legacy booth", "booth", T, 120, 1, T);        // the v8.0.0-window shape
      ins.run("c-booth0", "Already normal booth", "booth", T, 120, 0, T); // idempotence: nothing to do
      ins.run("c-tourn", "Competition", "tournament", T, 120, 1, T);    // THE CONTROL — must survive
      ins.run("c-prog", "Program", "program", T, 120, 1, T);            // program is "allowed" too
      db.close();

      const out = bootDb();
      const after = new Database(dbPath, { readonly: true });
      const val = (id) => after.prepare("SELECT auto_end_on_all_solved v FROM competitions WHERE id=?").get(id).v;
      const booth = val("c-booth"), booth0 = val("c-booth0"), tourn = val("c-tourn"), prog = val("c-prog");
      after.close();

      expect(booth, "the legacy booth row is normalised — the column rides the admin list payload, "
        + "so leaving it at 1 would have every admin client told a Booth Event auto-ends while it never does").toBe(0);
      expect(booth0, "an already-correct booth is untouched").toBe(0);
      // THE CONTROL. Without it "the booth was reset" is equally satisfied by a
      // migration that zeroes the column for EVERY event — which would silently
      // stop every Competition on the platform auto-ending.
      expect(tourn, "a Competition's opt-in must survive — its kind permits the rule").toBe(1);
      expect(prog, "a Program's is left alone too; only a kind that FORBIDS it is normalised").toBe(1);
      expect(out, "a non-zero normalisation says so on stdout").toContain("normalised auto_end_on_all_solved");

      // Idempotent: the second boot has nothing left to change and must say nothing.
      const out2 = bootDb();
      const again = new Database(dbPath, { readonly: true });
      const booth2 = again.prepare("SELECT auto_end_on_all_solved v FROM competitions WHERE id='c-booth'").get().v;
      const tourn2 = again.prepare("SELECT auto_end_on_all_solved v FROM competitions WHERE id='c-tourn'").get().v;
      again.close();
      expect(booth2).toBe(0);
      expect(tourn2).toBe(1);
      expect(out2, "a second boot updates nothing").not.toContain("normalised auto_end_on_all_solved");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
