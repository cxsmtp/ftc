// @ts-check
//
// v7.28.0 — EXPORT CSV FROM THE ADMIN RANKINGS BOARDS.
//
// Every board on the Rankings tab gains an Export CSV button — the all-live
// cards, the per-session cards, the focused single-competition table and the
// Group Rankings table — and the file carries everything the board shows PLUS a
// per-participant penalty breakdown that the board does not: how many incorrect
// submissions, how many points those cost, how many hints were revealed, what
// those cost, and the total. Those five are CSV-only by design; no column was
// added to any on-screen table.
//
// WHY THE FIXTURES LOOK LIKE THIS
// ──────────────────────────────
//   * The penalty numbers are only worth having if they RECONCILE with the
//     Score beside them, so the API fixture makes every one of the five differ
//     from every other (2 wrong answers costing 10, 1 hint costing 30) and
//     carries a CLEAN participant as the positive control — with uniform
//     activity, a transposed column mapping passes.
//   * The counts ride the same SQL that computes the score, and the load-bearing
//     part of that is the `JOIN competition_tasks` filter. So one test UNASSIGNS
//     a challenge and requires the penalties to fall WITH the score: an
//     un-joined count would keep reporting the orphaned rows while the score
//     dropped, which is the precise way this feature could go quietly wrong.
//   * The UI tests INTERCEPT the board payload rather than seeding it. The
//     50-row cap is the whole point of "the file is not the page", and seeding
//     51 participants to prove it would take a minute per run; the export is
//     pure client-side serialisation over the payload, so the payload is the
//     honest input. This is the documented pattern for the sibling analytics
//     export (v7.24.0). One test drives the REAL server end to end anyway, so
//     the wire fields are not taken on trust.
//
// Fixture checklist (CLAUDE.md): own competition, own challenges, own
// participants, and one enrolled participant who solves NOTHING — so the
// all-solved auto-end cannot fire and end the competition under the tests.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, gradingHashFor, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const crypto = require("crypto");
const fs = require("fs");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

/** Parse a CSV whose every field is quoted (which is what ui/csv.js emits). */
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

/**
 * Turn a downloaded CSV into {header, rows:[{<column>: value}]}.
 *
 * Column indices are DERIVED from the header, never hard-coded — the v7.24.0
 * lesson: positional reads mean a column insert silently changes what ten
 * assertions are looking at. The header's own names and ORDER are asserted
 * exhaustively in one place below; everything else asks by name.
 */
function csvObjects(text) {
  const parsed = parseCsv(text);
  const header = parsed[0] || [];
  return { header, rows: parsed.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

/** Click a board's Export CSV and return the parsed file. */
async function exportBoard(page, boardKey) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.locator(`.rk-export-btn[data-board-key="${boardKey}"]`).first().click(),
  ]);
  const text = fs.readFileSync(await download.path(), "utf8");
  return { download, text, ...csvObjects(text) };
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — the wire: /api/admin/leaderboard carries the breakdown, and it adds up
// ═════════════════════════════════════════════════════════════════════════════

/** A verified + approved participant with a known password. */
async function mkP(sa, saCsrf, nick, company) {
  const email = `rkx_${nick}@company.example`;
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
  return { id: u.id, email, nick, company };
}

let F = null; // API fixture, built once

test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const compName = `Rankings CSV ${t}`;
    const comp = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: compName, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }});
    expect(comp.status(), await comp.text()).toBe(200);
    const compId = (await comp.json()).competition.id;

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
    // easy=50, medium=100 (hint costs round(100*0.3)=30), hard=150.
    const easy = await mkTask(`Easy ${t}`, "easy");
    const medium = await mkTask(`Medium ${t}`, "medium");
    const hard = await mkTask(`Hard ${t}`, "hard");

    const aa = await mkP(sa, csrf, `aa${t}`, "Acme Ltd");
    const cc = await mkP(sa, csrf, `cc${t}`, "Clean Corp");
    const bb = await mkP(sa, csrf, `bb${t}`, "Bench Co");
    // Enrolled, selects the competition (so they are on the board) and solves
    // nothing — which is what stops the all-solved auto-end firing.
    const dd = await mkP(sa, csrf, `dd${t}`, "Idle Inc");
    const ss = await mkP(sa, csrf, `ss${t}`, "Staff Co");

    // Assign BEFORE tagging: the assign endpoint deliberately SKIPS staff and
    // benchmark users, so tagging first would silently enrol nobody.
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [aa.id, cc.id, bb.id, dd.id, ss.id], competitionIds: [compId] },
    });
    expect(asg.status(), await asg.text()).toBe(200);
    expect((await asg.json()).assigned, "all five must actually enrol").toBe(5);
    for (const [u, tag] of [[bb, "benchmark"], [ss, "staff"]]) {
      const r = await sa.post(`/api/admin/participants/${u.id}/tags`, { headers: H(csrf), data: { tag } });
      expect(r.status(), await r.text()).toBe(200);
    }

    const act = async (who, fn) => {
      const { api, csrf: c } = await apiLogin(who.email, PARTICIPANT_PASS);
      const sel = await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } });
      expect(sel.status(), await sel.text()).toBe(200);
      try { await fn(api, c); } finally { await api.dispose(); }
    };
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

    // aa: solves easy (+50), two wrong on medium (-5 -5), one hint on medium (-30).
    //     score 10 | incorrect 2 / 10 lost | hints 1 / 30 lost | total lost 40.
    // Every one of the five numbers differs from every other, so a transposed
    // mapping cannot pass.
    await act(aa, async (api, c) => {
      await submit(api, c, easy, "right", true);
      await submit(api, c, medium, "nope-1", false);
      await submit(api, c, medium, "nope-2", false);
      await hint(api, c, medium);
    });
    // cc: a clean solve. The POSITIVE CONTROL — without a row whose penalties
    // are all zero, "the columns are populated" is satisfied by a build that
    // reports everyone's totals on every row.
    await act(cc, async (api, c) => { await submit(api, c, hard, "right", true); });
    // bb (benchmark): one wrong answer, so the benchmark section is non-empty
    // AND carries a non-zero penalty.
    await act(bb, async (api, c) => { await submit(api, c, easy, "wrong", false); });
    // dd: enters and does nothing.
    await act(dd, async () => {});

    F = { compId, compName, easy, medium, hard, aa, bb, cc, dd, ss, t };
  } finally {
    await sa.dispose();
  }
});

/** The admin board, keyed by nickname. */
async function adminBoard(compId) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const r = await sa.get(`/api/admin/leaderboard?competitionId=${compId}`);
    expect(r.ok(), `admin leaderboard: ${r.status()}`).toBeTruthy();
    const board = await r.json();
    return { board, by: Object.fromEntries(board.map(e => [e.nickname, e])), sa, csrf };
  } finally {
    await sa.dispose();
  }
}

test.describe("v7.28.0 — the admin board carries the penalty breakdown", () => {
  test("the five columns are populated, distinct, and reconcile with the score", async () => {
    const { by } = await adminBoard(F.compId);

    const a = by[F.aa.nick];
    expect(a, "aa must be on the board").toBeTruthy();
    // Every number differs from every other, so no two columns can be swapped
    // without failing.
    expect(a.incorrectCount).toBe(2);
    expect(a.pointsLostIncorrect, "two wrong answers at -5 each, as a POSITIVE magnitude").toBe(10);
    expect(a.hintCount).toBe(1);
    expect(a.pointsLostHints, "a medium hint costs round(100 * 0.3)").toBe(30);
    expect(a.pointsLostTotal).toBe(40);
    expect(a.score, "50 earned, 10 lost to wrong answers, 30 to the hint").toBe(10);
    // THE IDENTITY. This is the whole reason the counts ride the query that
    // computes the score rather than a second aggregation.
    expect(a.score + a.pointsLostTotal, "score + total lost == points earned from solves").toBe(50);

    // POSITIVE CONTROL: a clean participant is all zeros. Without this, every
    // assertion above is equally satisfied by a build that reports the same
    // totals on every row.
    const c = by[F.cc.nick];
    expect(c.score).toBe(150);
    expect([c.incorrectCount, c.pointsLostIncorrect, c.hintCount, c.pointsLostHints, c.pointsLostTotal]).toEqual([0, 0, 0, 0, 0]);

    // And a participant who did nothing at all is on the board with zeros —
    // not absent, and not undefined cells.
    const d = by[F.dd.nick];
    expect(d, "an enrolled participant who entered but did nothing is still on the board").toBeTruthy();
    expect([d.score, d.incorrectCount, d.pointsLostTotal]).toEqual([0, 0, 0]);

    // The benchmark row carries the breakdown too, and keeps its null rank.
    const b = by[F.bb.nick];
    expect(b.isBenchmark).toBe(true);
    expect(b.rank, "a benchmark row is unranked").toBeNull();
    expect([b.incorrectCount, b.pointsLostIncorrect, b.pointsLostTotal]).toEqual([1, 5, 5]);

    // Staff are absent from the board, so they are absent from the file.
    expect(by[F.ss.nick], "staff must not appear on the board").toBeFalsy();
  });

  test("unassigning a challenge drops its penalties WITH its score", async () => {
    // The load-bearing property of riding the score's own query is the
    // `JOIN competition_tasks` filter (v6.16.26): rows for a challenge no longer
    // assigned stop contributing. A count written without that JOIN would keep
    // reporting the orphaned wrong answers while the score fell — the exact way
    // this feature could go quietly wrong, and nothing else in the suite covers
    // the penalty columns' half of it.
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const before = (await (await sa.get(`/api/admin/leaderboard?competitionId=${F.compId}`)).json())
        .find(e => e.nickname === F.aa.nick);
      expect(before.incorrectCount).toBe(2);
      expect(before.hintCount).toBe(1);

      const del = await sa.delete(`/api/admin/tasks/${F.medium}/competitions/${F.compId}`, { headers: H(csrf) });
      expect(del.status(), await del.text()).toBe(200);
      try {
        // The 5-second leaderboard cache is busted by the unassign, so this is
        // a fresh build.
        const after = (await (await sa.get(`/api/admin/leaderboard?competitionId=${F.compId}`)).json())
          .find(e => e.nickname === F.aa.nick);
        expect(after.score, "only the easy solve is left").toBe(50);
        expect(after.incorrectCount, "the wrong answers were on the unassigned challenge").toBe(0);
        expect(after.pointsLostIncorrect).toBe(0);
        expect(after.hintCount, "so was the hint").toBe(0);
        expect(after.pointsLostHints).toBe(0);
        expect(after.pointsLostTotal).toBe(0);
        expect(after.score + after.pointsLostTotal, "the identity still holds").toBe(50);
      } finally {
        // Restore, so the fixture is unchanged for every other test in the file.
        const re = await sa.post(`/api/admin/tasks/${F.medium}/competitions`, { headers: H(csrf), data: { competitionIds: [F.compId] } });
        expect(re.status(), await re.text()).toBe(200);
      }
    } finally {
      await sa.dispose();
    }
  });

  test("the penalty columns never reach the PARTICIPANT board", async () => {
    // The sibling v7.22.0 lock covers the identity columns; this covers the
    // five added here, on the same principle — how many wrong answers somebody
    // made is not something to hand every other competitor.
    const { api, csrf } = await apiLogin(F.cc.email, PARTICIPANT_PASS);
    try {
      const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: F.compId } });
      expect(sel.status(), await sel.text()).toBe(200);
      const r = await api.get("/api/leaderboard");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // STRUCTURAL, not a list of the five public names.
      //
      // A named-forbidden-list here was VACUOUS and a mutation proved it: the
      // row builder holds the breakdown under INTERNAL `_`-prefixed keys, so
      // reverting `stripInternal` to the old two-name destructure leaks
      // `_incorrectCount` and friends — none of which a list of public names
      // mentions. An allow-list catches a field arriving under any name, which
      // is the only form that survives the next rename.
      const ALLOWED = new Set(["userId", "nickname", "avatar", "score", "finishTime",
        "solveTimeMs", "allSolved", "rank", "isBenchmark"]);
      const offenders = [];
      for (const [where, arr] of [["board", body.board], ["top3", body.top3], ["me", body.me ? [body.me] : []]]) {
        for (const [i, e] of (arr || []).entries()) {
          for (const k of Object.keys(e || {})) if (!ALLOWED.has(k)) offenders.push(`${where}[${i}].${k}`);
        }
      }
      expect(offenders, `unexpected key(s) on a participant board entry: ${JSON.stringify(offenders)}`).toEqual([]);

      // POSITIVE CONTROL: the board really was populated, so "no offenders" is
      // not merely "no rows".
      expect((body.board || []).length, "the participant board must have rows").toBeGreaterThan(0);
      // And the ADMIN board for the same competition DOES carry them, so the
      // absence above is a strip rather than a feature that never shipped.
      const { by } = await adminBoard(F.compId);
      expect(by[F.aa.nick].pointsLostTotal).toBe(40);
    } finally {
      await api.dispose();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 1b — the GROUP board, against real groups
// ═════════════════════════════════════════════════════════════════════════════
//
// The UI group test below intercepts its payload, which is right for the
// client-side serialisation but leaves the SERVER's team summing uncovered. It
// also happens to be the one shape the repo's per-entry PII lock cannot see:
// that lock walks `body.groupBoard.board`, but its fixture binds no groups, so
// `groupBoard` is null and the walk iterates an empty array. A group-row-only
// leak passes it. This drives both halves against real groups.

test.describe("v7.28.0 — the group board's team totals, against real groups", () => {
  test("group rows SUM their members' penalties; participants see none of them", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let compId = null;
    try {
      const t = uniq();
      // The team board is opt-in per competition AND needs >=2 non-empty bound
      // groups, or it is null and every assertion here would be vacuous.
      const comp = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `Rk Groups ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 240, group_leaderboard_enabled: true,
      }});
      expect(comp.status(), await comp.text()).toBe(200);
      compId = (await comp.json()).competition.id;

      const tr = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `GrpEasy ${t}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: "right", explanation: "<p>e</p>", hint: "a hint", status: "published",
      }});
      expect(tr.status(), await tr.text()).toBe(200);
      const taskId = (await tr.json()).id;
      expect((await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } })).ok()).toBeTruthy();

      const g1a = await mkP(sa, csrf, `g1a${t}`, "One Ltd");
      const g1b = await mkP(sa, csrf, `g1b${t}`, "One Ltd");
      const g2a = await mkP(sa, csrf, `g2a${t}`, "Two Ltd");
      const g2b = await mkP(sa, csrf, `g2b${t}`, "Two Ltd");

      // Distinct membership: a participant in two groups bound to ONE
      // competition is refused 409 by the clash guard.
      const mkGroup = async (name, userIds) => {
        const r = await sa.post("/api/admin/groups", { headers: H(csrf), data: { name, userIds } });
        expect(r.status(), await r.text()).toBe(200);
        return (await r.json()).group.id;
      };
      const gid1 = await mkGroup(`Alpha Team ${t}`, [g1a.id, g1b.id]);
      const gid2 = await mkGroup(`Beta Team ${t}`, [g2a.id, g2b.id]);
      // Binding the groups is what enrols their members.
      const asg = await sa.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { groupIds: [gid1, gid2], competitionIds: [compId] },
      });
      expect(asg.status(), await asg.text()).toBe(200);

      const act = async (who, fn) => {
        const { api, csrf: c } = await apiLogin(who.email, PARTICIPANT_PASS);
        const sel = await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } });
        expect(sel.status(), await sel.text()).toBe(200);
        try { await fn(api, c); } finally { await api.dispose(); }
      };
      // Alpha: one wrong answer (-5) and one clean solve (+50) → 1 incorrect / 5 lost, 0 hints.
      // Beta:  one hint on an easy challenge (round(50*0.3)=15) then a solve → 0 incorrect, 1 hint / 15 lost.
      // The two teams therefore differ in WHICH column is non-zero, so a build
      // that summed the wrong column, or summed across all members of every
      // group, cannot pass. g2b solves nothing, which also keeps the all-solved
      // auto-end from firing.
      await act(g1a, async (api, c) => {
        const gh = await gradingHashFor(api, taskId);
        const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(c), data: { answer: "nope", gradingHash: gh } });
        expect((await r.json()).correct).toBe(false);
      });
      await act(g1b, async (api, c) => {
        const gh = await gradingHashFor(api, taskId);
        const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(c), data: { answer: "right", gradingHash: gh } });
        expect((await r.json()).correct).toBe(true);
      });
      await act(g2a, async (api, c) => {
        expect((await api.post(`/api/tasks/${taskId}/hint`, { headers: H(c) })).ok()).toBeTruthy();
        const gh = await gradingHashFor(api, taskId);
        const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(c), data: { answer: "right", gradingHash: gh } });
        expect((await r.json()).correct).toBe(true);
      });
      await act(g2b, async () => {});

      // ── ADMIN: the team totals ────────────────────────────────────────────
      const gr = await sa.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`);
      expect(gr.ok(), `group board: ${gr.status()}`).toBeTruthy();
      const groupBoard = await gr.json();
      const byName = Object.fromEntries(groupBoard.filter(e => e.type === "group").map(e => [e.name, e]));
      const alpha = byName[`Alpha Team ${t}`], beta = byName[`Beta Team ${t}`];
      expect(alpha, "the team board must actually render — check the opt-in flag and the 2-group gate").toBeTruthy();
      expect(beta).toBeTruthy();

      expect(alpha.memberCount).toBe(2);
      expect(alpha.incorrectCount, "SUM over the team, not an average").toBe(1);
      expect(alpha.pointsLostIncorrect).toBe(5);
      expect(alpha.hintCount).toBe(0);
      expect(alpha.pointsLostHints).toBe(0);
      expect(alpha.pointsLostTotal).toBe(5);
      expect(alpha.score, "the SCORE is a mean: (-5 + 50) / 2").toBe(22.5);

      // The other team's non-zero column is a DIFFERENT one.
      expect(beta.incorrectCount).toBe(0);
      expect(beta.pointsLostIncorrect).toBe(0);
      expect(beta.hintCount).toBe(1);
      expect(beta.pointsLostHints, "an easy hint costs round(50 * 0.3)").toBe(15);
      expect(beta.pointsLostTotal).toBe(15);

      // ── PARTICIPANT: none of it ───────────────────────────────────────────
      const { api, csrf: pc } = await apiLogin(g1a.email, PARTICIPANT_PASS);
      try {
        const sel = await api.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
        expect(sel.status(), await sel.text()).toBe(200);
        const r = await api.get("/api/leaderboard");
        expect(r.ok()).toBeTruthy();
        const body = await r.json();
        const rows = (body.groupBoard && body.groupBoard.board) || [];
        // POSITIVE CONTROL: the group board really reached the participant, so
        // "no leak" is not merely "no rows" — which is exactly how the repo's
        // existing per-entry lock is vacuous on this surface.
        expect(rows.length, "the participant group board must be populated").toBeGreaterThan(0);
        expect(rows.some(e => e.type === "group"), "including at least one GROUP row").toBe(true);

        // Structural allow-list, so a key added under ANY name is caught — not
        // just the five this release introduces.
        const ALLOWED = new Set(["type", "groupId", "name", "userId", "nickname", "avatar",
          "score", "solveTimeMs", "allSolved", "rank", "mine", "finishTime", "isBenchmark"]);
        const offenders = [];
        for (const [i, e] of rows.entries()) {
          for (const k of Object.keys(e || {})) if (!ALLOWED.has(k)) offenders.push(`groupBoard.board[${i}].${k}`);
        }
        expect(offenders, `unexpected key(s) on a participant GROUP entry: ${JSON.stringify(offenders)}`).toEqual([]);
      } finally {
        await api.dispose();
      }
    } finally {
      await sa.dispose();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — the file, driven through the real server
// ═════════════════════════════════════════════════════════════════════════════

/** Focus a competition and land on the Rankings tab. */
async function openRankings(page, compId, compName) {
  await adminLogin(page);
  await clickTab(page, "Events");
  await expect.poll(
    () => page.evaluate((id) => (window.S.adminCompetitionsData || []).some(c => c.id === id), compId),
    { timeout: 20000, intervals: [100, 200, 400, 800] },
  ).toBe(true);
  await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), { id: compId, name: compName });
  await clickTab(page, "Rankings");
  await expect(page.locator("#admin-rankings-body tr").first()).toBeVisible({ timeout: 20000 });
}

test.describe("v7.28.0 — the exported file, end to end", () => {
  test("the real board exports with its penalty columns, benchmarks last and unranked", async ({ page }) => {
    await openRankings(page, F.compId, F.compName);
    const { header, rows, download } = await exportBoard(page, "main");

    // The header's names AND order, exhaustively, in the one place that belongs.
    expect(header).toEqual([
      "Rank", "Nickname", "First Name", "Last Name", "Company", "Email",
      // v8.6.0 — "Late Entrant" joins the header, and this exact-list assertion is
      // what makes that a decision. The file flattens three sections into one
      // sheet and `Rank` 1 appears twice in it — once for the winner and once for
      // the first late entrant — so without this column the two are
      // indistinguishable in the surface an organiser reconciles results in.
      "Score", "Time to Solve", "Time to Solve (ms)", "All Solved", "Benchmark", "Late Entrant",
      "Incorrect Submissions", "Points Lost to Incorrect",
      "Hints Revealed", "Points Lost to Hints", "Total Points Lost",
      // v8.1.0 (PR 35) — the elapsed/net PAIR. "Time to Solve" above is ELAPSED
      // and reads ~72 h for everybody on a multi-day event; these say what the
      // participant actually spent. The header is the contract with the human
      // reading the file (v7.15.8), which is why it is pinned exhaustively here.
      "Time on Platform", "Time on Platform (ms)",
    ]);
    expect(download.suggestedFilename()).toMatch(/^rankings-rankings-csv-.+-\d{4}-\d{2}-\d{2}\.csv$/);

    const byNick = Object.fromEntries(rows.map(r => [r.Nickname, r]));
    const a = byNick[F.aa.nick];
    expect(a, "aa must be in the file").toBeTruthy();
    expect(a["Score"]).toBe("10");
    expect(a["Incorrect Submissions"]).toBe("2");
    expect(a["Points Lost to Incorrect"]).toBe("10");
    expect(a["Hints Revealed"]).toBe("1");
    expect(a["Points Lost to Hints"]).toBe("30");
    expect(a["Total Points Lost"]).toBe("40");
    // The identity columns the board already had ride along.
    expect(a["First Name"]).toBe(`F${F.aa.nick}`);
    expect(a["Company"]).toBe("Acme Ltd");
    expect(a["Email"]).toBe(F.aa.email);

    // POSITIVE CONTROL — a clean row is zeros, not a copy of aa's.
    expect(byNick[F.cc.nick]["Total Points Lost"]).toBe("0");

    // Staff never appear.
    expect(byNick[F.ss.nick], "staff must not be in the file").toBeFalsy();

    // The benchmark row: LAST, rank cell EMPTY (never "null", never "0", never
    // "#null"), and flagged — without the flag a blank rank in a re-sorted
    // spreadsheet is indistinguishable from missing data.
    const b = byNick[F.bb.nick];
    expect(b["Benchmark"]).toBe("Yes");
    expect(b["Rank"], "a benchmark row's rank is empty").toBe("");
    expect(rows[rows.length - 1].Nickname, "benchmarks sort last, as on screen").toBe(F.bb.nick);
    // POSITIVE CONTROL for the flag: an ordinary row is not marked, and IS ranked.
    expect(a["Benchmark"]).toBe("");
    expect(Number(a["Rank"])).toBeGreaterThan(0);

    // Time is carried BOTH ways — human-readable to match the board, and raw ms
    // so the column can actually be aggregated in a spreadsheet.
    expect(a["Time to Solve"]).toMatch(/^(\d+h )?(\d+m )?\d+s$/);
    expect(Number(a["Time to Solve (ms)"])).toBeGreaterThanOrEqual(0);
  });

  test("the file carries a UTF-8 BOM", async ({ page }) => {
    await openRankings(page, F.compId, F.compName);
    const { text } = await exportBoard(page, "main");
    expect(text.charCodeAt(0), "Excel falls back to the ANSI code page without it").toBe(0xfeff);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 3 — the client rules, over an intercepted payload
// ═════════════════════════════════════════════════════════════════════════════

const wireRow = (o) => ({
  userId: o.id, nickname: o.nick, avatar: "default1",
  score: o.score ?? 0, finishTime: null, solveTimeMs: o.ms ?? 1000,
  allSolved: !!o.allSolved, rank: o.rank ?? null,
  firstName: o.first ?? "F", lastName: o.last ?? "L",
  company: o.company ?? "Co", email: o.email ?? `${o.nick}@x.test`,
  incorrectCount: o.inc ?? 0, pointsLostIncorrect: o.incPts ?? 0,
  hintCount: o.hints ?? 0, pointsLostHints: o.hintPts ?? 0,
  pointsLostTotal: (o.incPts ?? 0) + (o.hintPts ?? 0),
  ...(o.benchmark ? { isBenchmark: true } : {}),
});

/**
 * Serve a fixed board payload for a competition and open Rankings on it.
 *
 * `groupBoard` is served on the `?groups=1` request, which the scoped loader
 * fires in parallel with the individual one.
 */
async function openMocked(page, { board, groupBoard = [] }) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let compId, compName;
  try {
    compName = `RkMock ${uniq()}`;
    const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: compName, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
    }});
    expect(r.status(), await r.text()).toBe(200);
    compId = (await r.json()).competition.id;
  } finally { await sa.dispose(); }

  await page.route("**/api/admin/leaderboard*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify(route.request().url().includes("groups=1") ? groupBoard : board),
  }));
  await openRankings(page, compId, compName);
  return { compId, compName };
}

test.describe("v7.28.0 — what the file contains", () => {
  test("it exports every FILTERED row, not the 50 on screen, in the board's order", async ({ page }) => {
    // 60 rows against a 50-row cap: the page-vs-full-set distinction is the
    // whole point, and a fixture inside one page could not express it.
    const board = Array.from({ length: 60 }, (_, i) => wireRow({
      id: `u${i}`, nick: `p${String(i).padStart(2, "0")}`, rank: i + 1,
      score: 1000 - i, inc: i, incPts: i * 5,
    }));
    await openMocked(page, { board });

    await expect(page.locator("#admin-rankings-body tr.rankings-more-row"),
      "the SCREEN caps at 50 and offers an expander").toHaveCount(1);
    // 50 ranking rows + the expander row.
    expect(await page.locator("#admin-rankings-body tr").count()).toBe(51);

    const { rows } = await exportBoard(page, "main");
    expect(rows.length, "all 60 rows, not the 50 rendered").toBe(60);
    expect(rows[0].Nickname, "in the board's own order").toBe("p00");
    expect(rows[59].Nickname).toBe("p59");
    // The expander row is markup, not data — it must not become a CSV row.
    expect(rows.some(r => /Show all/.test(r.Nickname || "")), "no chrome in the file").toBe(false);
  });

  test("a column sort re-orders the file, not just the screen", async ({ page }) => {
    const board = [
      wireRow({ id: "a", nick: "alpha", rank: 1, score: 30, company: "Zeta Co" }),
      wireRow({ id: "b", nick: "bravo", rank: 2, score: 20, company: "Alpha Co" }),
      wireRow({ id: "c", nick: "chuck", rank: 3, score: 10, company: "Mid Co" }),
    ];
    await openMocked(page, { board });

    const before = await exportBoard(page, "main");
    expect(before.rows.map(r => r.Nickname)).toEqual(["alpha", "bravo", "chuck"]);

    const th = page.locator('#admin-rankings-tab th[data-col="company"]').first();
    await th.click();
    await expect(th, "the click really sorted the board").toHaveAttribute("aria-sort", "ascending", { timeout: 10000 });

    const after = await exportBoard(page, "main");
    expect(after.rows.map(r => r.Company), "the file follows the admin's sort")
      .toEqual(["Alpha Co", "Mid Co", "Zeta Co"]);
  });

  test("it exports what the SEARCH narrowed to, and nothing else", async ({ page }) => {
    const board = [
      wireRow({ id: "n1", nick: "needle-one", rank: 1, score: 30 }),
      wireRow({ id: "h1", nick: "haystack-a", rank: 2, score: 20 }),
      wireRow({ id: "n2", nick: "needle-two", rank: 3, score: 10 }),
    ];
    await openMocked(page, { board });

    await page.locator("#rankings-search").fill("needle");
    await expect.poll(() => page.locator("#admin-rankings-body tr").count(), { timeout: 10000 }).toBe(2);
    const narrowed = await exportBoard(page, "main");
    expect(narrowed.rows.map(r => r.Nickname)).toEqual(["needle-one", "needle-two"]);

    // POSITIVE CONTROL: without it, "the export respects the search" is equally
    // satisfied by an export that always emitted two rows.
    await page.locator("#rankings-search").fill("");
    await expect.poll(() => page.locator("#admin-rankings-body tr").count(), { timeout: 10000 }).toBe(3);
    const all = await exportBoard(page, "main");
    expect(all.rows.length).toBe(3);
  });

  test("a nickname or company that is a spreadsheet formula is neutralised", async ({ page }) => {
    // Quoting alone does NOT stop Excel evaluating a cell — the quotes are the
    // delimiter and are stripped before type inference. Participants author
    // their own company, and an admin opens this file.
    const board = [
      wireRow({ id: "f1", nick: "formula", rank: 1, score: 10, company: '=HYPERLINK("http://evil.example","x")' }),
      wireRow({ id: "p1", nick: "plain", rank: 2, score: 5, company: "Ordinary Ltd" }),
    ];
    await openMocked(page, { board });
    const { rows } = await exportBoard(page, "main");
    expect(rows[0].Company).toBe(`'=HYPERLINK("http://evil.example","x")`);
    // POSITIVE CONTROL: a writer that apostrophised EVERY cell would satisfy
    // the assertion above.
    expect(rows[1].Company).toBe("Ordinary Ltd");
    expect(rows[1].Company.startsWith("'")).toBe(false);
  });
});

test.describe("v7.28.0 — the group board exports team totals", () => {
  test("group rows carry team totals and an explicit basis; a solo row is a team of one", async ({ page }) => {
    const groupBoard = [
      { type: "group", groupId: "g1", name: "Team Rocket", memberCount: 2, score: 22.5,
        solveTimeMs: 60000, allSolved: false, rank: 1,
        incorrectCount: 5, pointsLostIncorrect: 25, hintCount: 2, pointsLostHints: 60, pointsLostTotal: 85 },
      { type: "individual", userId: "s1", nickname: "solo", avatar: "default1", score: 40,
        solveTimeMs: 30000, allSolved: true, rank: 2,
        incorrectCount: 1, pointsLostIncorrect: 5, hintCount: 0, pointsLostHints: 0, pointsLostTotal: 5 },
    ];
    await openMocked(page, { board: [wireRow({ id: "x", nick: "any", rank: 1, score: 1 })], groupBoard });
    await expect(page.locator("#admin-rankings-group-section table")).toBeVisible({ timeout: 20000 });

    const { header, rows, download } = await exportBoard(page, "group");
    expect(header).toEqual([
      "Rank", "Name", "Type", "Members", "Avg Score", "Avg Time to Solve",
      "Avg Time to Solve (ms)", "All Solved",
      "Incorrect Submissions (team total)", "Points Lost to Incorrect (team total)",
      "Hints Revealed (team total)", "Points Lost to Hints (team total)",
      "Total Points Lost (team total)",
    ]);
    expect(download.suggestedFilename()).toMatch(/^team-rankings-.+\.csv$/);

    // A GROUP row: the score is a MEAN rendered to one decimal exactly as the
    // board renders it, and the penalties are SUMS over its members. The two
    // bases differ, which is why each penalty heading says "(team total)".
    const g = rows[0];
    expect(g.Type).toBe("Group");
    expect(g.Name).toBe("Team Rocket");
    expect(g.Members).toBe("2");
    expect(g["Avg Score"]).toBe("22.5");
    expect(g["Incorrect Submissions (team total)"]).toBe("5");
    expect(g["Total Points Lost (team total)"]).toBe("85");

    // A SOLO row is a one-member team, so its numbers ARE that person's own and
    // the row reconciles: 40 scored + 5 lost = 45 earned.
    const s = rows[1];
    expect(s.Type).toBe("Individual");
    expect(s.Name).toBe("solo");
    expect(s.Members, "a person is a team of one, not a blank cell").toBe("1");
    expect(s["Avg Score"], "an individual's score is a whole number, as on screen").toBe("40");
    expect(s["Total Points Lost (team total)"]).toBe("5");

    // The group file must NOT carry identity columns — a team has no surname.
    for (const gone of ["First Name", "Last Name", "Company", "Email"]) {
      expect(header, `the group board has no ${gone}`).not.toContain(gone);
    }
  });
});

test.describe("v7.28.0 — the export refuses rather than answering wrongly", () => {
  test("a board emptied by the search says so instead of writing a header-only file", async ({ page }) => {
    await openMocked(page, { board: [wireRow({ id: "a", nick: "alpha", rank: 1, score: 10 })] });
    await page.locator("#rankings-search").fill("zzz-matches-nothing");
    await expect(page.locator("#admin-rankings-body")).toContainText("No participants match", { timeout: 10000 });

    // No download at all — a header-only CSV would be read as "nobody scored".
    let downloaded = false;
    page.on("download", () => { downloaded = true; });
    await page.locator('.rk-export-btn[data-board-key="main"]').first().click();
    await expect(page.locator(".toast")).toContainText("no one on this board matches", { timeout: 10000 });
    expect(downloaded, "nothing may be written").toBe(false);
  });

  test("switching scope does NOT export the PREVIOUS competition's participants", async ({ page }) => {
    // The sharpest failure this button can have, and the reason the export reads
    // what the RENDERER computed rather than the shared single-slot cache. The
    // 'upcoming' branch paints a message into the tbody and returns WITHOUT
    // touching that cache, leaving the previous competition's rows in it while
    // the board chrome — Export button included — stays on screen.
    const { api: sa, csrf } = await apiLogin("superadmin");
    let upcomingId, upcomingName;
    try {
      upcomingName = `RkUpcoming ${uniq()}`;
      const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: upcomingName, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60,
      }});
      expect(r.status(), await r.text()).toBe(200);
      upcomingId = (await r.json()).competition.id;
    } finally { await sa.dispose(); }

    // A live board first, with a recognisable participant.
    await openMocked(page, { board: [wireRow({ id: "leak", nick: "should-not-leak", rank: 1, score: 10 })] });
    const first = await exportBoard(page, "main");
    expect(first.rows[0].Nickname, "the live board really did export").toBe("should-not-leak");

    // Now switch scope to a competition that has not started.
    await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), { id: upcomingId, name: upcomingName });
    await expect(page.locator("#admin-rankings-body")).toContainText("has not started yet", { timeout: 20000 });

    let downloaded = false;
    page.on("download", () => { downloaded = true; });
    await page.locator('.rk-export-btn[data-board-key="main"]').first().click();
    await expect(page.locator(".toast")).toContainText("the rankings have not loaded", { timeout: 10000 });
    expect(downloaded, "it must not hand over the previous competition's participants").toBe(false);
  });
});
