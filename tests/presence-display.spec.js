// @ts-check
//
// v8.1.7 — TWO PLACES A PRESENCE NUMBER MEANT SOMETHING OTHER THAN IT LOOKED.
//
// #29 — THE RANKINGS CSV REPORTED 0:00:00 FOR EVENTS THAT DO NOT MEASURE.
// `measure_presence` is off by default and off on every event that predates
// v8.1.0, yet `_adminPenalties` published `presenceMs: u._presenceMs || 0` and the
// export wrote `0s` / `0` regardless. So "we did not measure" and "we measured,
// and it was zero" were byte-identical: an organiser read
// `Time on Platform 0s` beside `Time to Solve 3h 45m 00s` for people who
// visibly worked for hours, and anything averaging the ms column across events
// folded in zeros that were never measurements. The wire now says `null` and the
// cells go blank — the file's own idiom for "not known", the one a benchmark
// row's rank already uses. The COLUMNS stay unconditional: the header is the
// contract with the human reading the file (v7.15.8), and a header whose shape
// varies by event breaks every positional reader and makes two exports
// incomparable.
//
// #30 — THE TWO BOARDS ON ONE SCREEN COULD ORDER THE SAME PAIR OPPOSITELY.
// The INDIVIDUAL board breaks score ties between finishers on presence when the
// event asks for it; `_computeGroupLeaderboard`'s SOLO rows — the same
// direct-assigned participants, rendered directly beneath it from the SAME
// payload — were sorted by an inline comparator that never consulted presence and
// on rows that did not even carry it. A post-end snapshot then froze the
// divergence. Both now go through `compareLeaderboardEntries`, restricted to
// solo-vs-solo finisher pairs: a GROUP row is an aggregate with no single
// presence value, so a mixed pair keeps the composite key that always orders a
// group ahead of a tied individual — a CONSTANT relation, which is what keeps the
// sort transitive.
//
// FIXTURE CHECKLIST (CLAUDE.md): every test owns its competition, its challenges
// and its participants, and at least one enrolled participant solves nothing so
// the all-solved auto-end cannot end the event underneath the assertions.
//
// WHY THE #30 FIXTURE IS SHAPED THE WAY IT IS — the discriminating part. Two
// finishers on the SAME score whose presence order is the OPPOSITE of their
// elapsed order: A logs in second and finishes first on the HIGHER presence; B
// logs in first and finishes last on the LOWER one. So elapsed ranks A first and
// presence ranks B first, and a group board that ignored presence lands on the
// opposite order from the individual board sitting above it. Without that
// opposition the pre-fix build passes.
//
// ═════════════════════════════════════════════════════════════════════════════
// v8.3.11 — TWO MORE FINDINGS IN THE SAME SUBSYSTEM, AND ONE FIXTURE RE-POINTED
// ═════════════════════════════════════════════════════════════════════════════
//
// F5 — PRESENCE COUNTED ONLY WHAT THE CLIENT ADMITTED TO.
// `_recordPresenceIfActive` opened with an unconditional
// `if (req.get("X-Client-Active") !== "1") return;`, so the header was the ONLY
// evidence a human was present. The design specified a second route in — an
// ACTION endpoint counts without the header, because the request itself is the
// evidence — and that half was never built. The consequence is not
// a soft under-count: the presence tie-break ranks LOWER first among score-tied
// finishers, so a client that simply omitted one header banked a perfect ZERO and
// WON the tie. Zero is unreachable honestly — anyone who did anything at all
// floors at one bucket. The likelier victim is an honest participant behind a
// proxy that strips unknown request headers, silently rewarded for it.
//
// F7 — NEITHER RANKING COMPARATOR WAS A STRICT WEAK ORDERING.
// Under a score tie, a finisher PAIR was ordered on presence while every pair
// touching a non-finisher was ordered on elapsed — two different quantities — so
// three rows closed a cycle with every value distinct, and `Array#sort` resolved
// it differently depending on the order SQLite happened to return the rows in.
// The group board carried its OWN cycle needing no non-finisher at all (a group
// row can be `allSolved` too, and is compared on elapsed against solos compared
// on presence), which is why fixing the individual comparator does not save it.
// Both are now partitioned into blocks, and both are asserted here by
// PERMUTATION-INVARIANCE rather than by a specific order — a specific order is
// equally satisfied by a build that ignores presence entirely, which is why the
// three anti-vacuity controls beneath the permutation tests are not optional.
//
// AND THE #30 FIXTURE MOVED, BECAUSE F5 INVALIDATED THE WAY IT MANUFACTURED ITS
// OPPOSITION. It gave B zero presence by having B "declare no activity" — i.e.
// solve two challenges while sending no header — and then asserted
// `rowB.presenceMs === 0`. That is the exploit, locked in as expected behaviour.
// Post-F5 a submit is its own evidence, so B legitimately banks a bucket. The
// SUBJECT of that test is untouched (the two boards cannot order one pair
// oppositely); only the opposition is now built with `POST /api/test/presence-seed`,
// which is the sole way to manufacture a presence DIFFERENCE at all — presence is
// quantised to five minutes and the suite has no clock control, so within one test
// every real request of every participant lands in the SAME bucket.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, gradingHashFor, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const crypto = require("crypto");
const fs = require("fs");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `pd${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}${crypto.randomBytes(2).toString("hex")}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A LIVE event. Presence only ever accrues on a live one — the lobby is excluded. */
async function makeEvent(api, csrf, extra = {}) {
  const name = `${uniq()} Ev`;
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, ...extra,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  return { ...(await r.json()).competition, name };
}

async function makeTask(api, csrf, compId, answer = "right", extra = {}) {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: answer, status: "published", ...extra },
  });
  expect(r.ok(), `task create: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).id;
  const a = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(a.ok(), `assign challenge: ${await a.text()}`).toBeTruthy();
  return id;
}

async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Pres", lastName: "Display", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  expect(u, `participant ${label} must exist`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

/** Sign in and select the competition — which is what stamps the solve clock. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/**
 * The assign endpoint SILENTLY SKIPS staff / benchmark / blocked / unapproved
 * users, so the count is asserted: a precondition that quietly did nothing
 * otherwise surfaces much later as an empty board.
 */
async function assign(api, csrf, compId, users) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { competitionIds: [compId], userIds: users.map(u => u.id) },
  });
  expect(r.ok(), `assign: ${await r.text()}`).toBeTruthy();
  expect((await r.json()).assigned, `${users.length} participants must actually enrol`).toBe(users.length);
}

/** A named group seeded with its members, for the two-non-empty-groups gate. */
async function makeGroup(api, csrf, userIds) {
  const r = await api.post("/api/admin/groups", { headers: H(csrf), data: { name: `${uniq()} G`, userIds } });
  expect(r.ok(), `group create: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).group?.id;
  expect(id, "the create response must carry the new group id").toBeTruthy();
  return id;
}

/** Bind groups to the competition. Binding alone is what the team board gates on. */
async function bindGroups(api, csrf, compId, groupIds) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { competitionIds: [compId], groupIds },
  });
  expect(r.ok(), `bind groups: ${await r.text()}`).toBeTruthy();
}

/** Solve one challenge. The grading token is REQUIRED on submit (v7.20.9 F1). */
async function solve(p, taskId, answer = "right") {
  const gradingHash = await gradingHashFor(p.api, taskId);
  expect(gradingHash, "the grading token must be obtainable").toBeTruthy();
  const r = await p.api.post(`/api/tasks/${taskId}/submit`, { headers: H(p.csrf), data: { answer, gradingHash } });
  expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.correct, `the answer must grade CORRECT, else nobody finishes: ${JSON.stringify(d)}`).toBe(true);
}

/** One five-minute presence bucket, the only unit the counter stores. */
const BUCKET = 5 * 60 * 1000;

/**
 * v8.3.11 — bank N DISTINCT presence buckets for one (event, participant).
 *
 * Presence is quantised to five minutes and the suite has no clock control, so
 * every real request a test makes falls in the SAME bucket: two participants who
 * both act end up on exactly one bucket each and no test can manufacture a
 * presence DIFFERENCE. That difference is the only thing that makes a presence
 * tie-break assertion discriminating, hence the endpoint.
 *
 * SEED BEFORE THE REAL ACTIVITY, never after. The seed walks buckets oldest-first
 * and lands its newest on NOW, and the production write only increments while
 * `last_bucket < excluded.last_bucket` — so a seed issued after a genuine request
 * has already claimed the current bucket adds nothing at all, silently.
 */
async function presenceSeed(api, csrf, compId, userId, buckets) {
  const r = await api.post("/api/test/presence-seed", {
    headers: H(csrf), data: { competitionId: compId, userId, buckets },
  });
  expect(r.ok(), `presence-seed: ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  // Asserted rather than assumed: the endpoint goes through the real
  // `recordPresence`, whose SELECT enforces membership — so a participant who was
  // never enrolled banks NOTHING here and every assertion built on the seeded
  // number would be vacuous rather than failing as the fixture it is.
  expect(d.banked, `seeding must actually bank ${buckets} bucket(s) for ${userId}`).toBe(buckets);
  expect(d.ms, "and the stored total must reflect them").toBe(buckets * BUCKET);
  return d.ms;
}

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
 * Column indices are DERIVED from the header, never hard-coded — the v7.24.0
 * lesson: a positional read means a column insert silently changes what an
 * assertion is looking at.
 */
function csvObjects(text) {
  const parsed = parseCsv(text);
  const header = parsed[0] || [];
  return { header, rows: parsed.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

/** Focus a competition and open Rankings, then export the focused board. */
async function exportFocusedBoard(page, compId, compName) {
  await adminLogin(page);
  await clickTab(page, "Events");
  await expect.poll(
    () => page.evaluate((id) => (window.S.adminCompetitionsData || []).some(c => c.id === id), compId),
    { timeout: 20000, intervals: [100, 200, 400, 800] },
  ).toBe(true);
  await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), { id: compId, name: compName });
  await clickTab(page, "Rankings");
  await expect(page.locator("#admin-rankings-body tr").first()).toBeVisible({ timeout: 20000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }),
    page.locator('.rk-export-btn[data-board-key="main"]').first().click(),
  ]);
  const text = fs.readFileSync(await download.path(), "utf8");
  return csvObjects(text);
}

// ═════════════════════════════════════════════════════════════════════════════
// #29 — an unmeasured event must not render a measured-looking zero
// ═════════════════════════════════════════════════════════════════════════════

test.describe("v8.1.7 — Time on Platform: unmeasured is not zero", () => {
  test("a NON-measuring event publishes presenceMs as null, not 0", async () => {
    // The wire half. `measure_presence` is OFF here by DEFAULT — asserted rather
    // than assumed, because the whole finding is about the default case.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf);
    await makeTask(api, csrf, comp.id);
    const a = await makeParticipant(api, csrf);
    const b = await makeParticipant(api, csrf);   // solves nothing → no auto-end
    await assign(api, csrf, comp.id, [a, b]);
    await enter(a.email, comp.id);                // stamps login_time → on the board

    const list = await (await api.get("/api/admin/competitions")).json();
    const row = list.find(c => c.id === comp.id);
    expect(row, "the event must be in the admin list").toBeTruthy();
    expect(row.measure_presence, "precondition: recording is OFF by default").toBeFalsy();

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    expect(board.length, "somebody must be on the board").toBeGreaterThan(0);
    for (const r of board) {
      // The KEY stays (the row shape must not vary by event, and the CSV column
      // is unconditional) — it is the VALUE that says "not measured".
      expect(r, "the key is stable across events").toHaveProperty("presenceMs");
      expect(r.presenceMs, `unmeasured must be null, never 0 (${r.nickname})`).toBeNull();
      // Elapsed is always real and needs no such gate — the control that says the
      // null above is a decision about presence, not a board with nothing in it.
      expect(typeof r.elapsedMs, "elapsed is still a real number").toBe("number");
    }
  });

  test("a MEASURING event publishes a real number — the positive control", async () => {
    // Without this, "no measured-looking zero" is equally satisfied by a build
    // that never populates the column at all.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    await makeTask(api, csrf, comp.id);
    const a = await makeParticipant(api, csrf);
    const b = await makeParticipant(api, csrf);   // solves nothing → no auto-end
    await assign(api, csrf, comp.id, [a, b]);

    const pa = await enter(a.email, comp.id);
    // The header is the whole gate: an ordinary poll carries none and counts
    // nothing, so the bucket only lands because a human is declared present.
    await pa.api.get("/api/status", { headers: { "X-Client-Active": "1" } });

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const mine = board.find(r => r.nickname === a.nickname);
    expect(mine, "the active participant must be on the board").toBeTruthy();
    expect(mine.presenceMs, "an active request buys one five-minute bucket").toBe(5 * 60 * 1000);

    // And a MEASURED participant who did nothing is a genuine zero — which is
    // exactly the value the unmeasured case must no longer be confused with.
    const idle = board.find(r => r.nickname === b.nickname);
    if (idle) expect(idle.presenceMs, "measured-but-idle is a real 0, not null").toBe(0);
  });

  // Mutation caught: reverting `_adminPenalties` to `presenceMs: u._presenceMs || 0`
  // (both cells render 0:00:00 / 0), and reverting the export's `== null` guards to
  // `u.presenceMs || 0` (same). The measuring test below is what stops either being
  // "fixed" by dropping the column.
  test("the exported CSV leaves both Time on Platform cells BLANK for a non-measuring event", async ({ page }) => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf);
    await makeTask(api, csrf, comp.id);
    const a = await makeParticipant(api, csrf);
    const b = await makeParticipant(api, csrf);   // solves nothing → no auto-end
    await assign(api, csrf, comp.id, [a, b]);
    await enter(a.email, comp.id);

    const { header, rows } = await exportFocusedBoard(page, comp.id, comp.name);
    // THE COLUMNS ARE STILL THERE. Omitting them for a non-measuring event would
    // make the header's SHAPE vary by event, which breaks a positional reader and
    // makes two exports incomparable — so the fix is the cell, not the column.
    expect(header, "the header keeps both columns").toContain("Time on Platform");
    expect(header).toContain("Time on Platform (ms)");

    const mine = rows.find(r => r.Nickname === a.nickname);
    expect(mine, "the participant must be in the file").toBeTruthy();
    // Blank — not `0s` (the pre-fix rendering), and not the `-` that
    // fmtSolveTime returns for null if the formatted column loses its guard.
    expect(mine["Time on Platform"], "blank, not a duration").toBe("");
    expect(mine["Time on Platform (ms)"], "blank, not 0").toBe("");
    // The row is otherwise fully populated — so "blank" is a statement about
    // presence and not an empty file or a mis-parsed one.
    expect(mine["Time to Solve (ms)"], "elapsed is still written").not.toBe("");
    expect(mine["Score"]).not.toBe("");
  });

  test("the exported CSV DOES carry a value when the event measures — the positive control", async ({ page }) => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    await makeTask(api, csrf, comp.id);
    const a = await makeParticipant(api, csrf);
    const b = await makeParticipant(api, csrf);   // solves nothing → no auto-end
    await assign(api, csrf, comp.id, [a, b]);
    const pa = await enter(a.email, comp.id);
    await pa.api.get("/api/status", { headers: { "X-Client-Active": "1" } });

    const { rows } = await exportFocusedBoard(page, comp.id, comp.name);
    const mine = rows.find(r => r.Nickname === a.nickname);
    expect(mine, "the participant must be in the file").toBeTruthy();
    // Non-blank AND non-zero: a build that wrote the column but always blanked it
    // would pass a bare "not empty" check on a zero.
    expect(mine["Time on Platform (ms)"], "a real measurement reaches the file").toBe(String(5 * 60 * 1000));
    expect(mine["Time on Platform"], "and it is FORMATTED, not blanked and not the "
      + "`-` fmtSolveTime returns for null").toBe("5m 00s");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// #30 — the individual board and the group board's solo rows agree
// ═════════════════════════════════════════════════════════════════════════════

test.describe("v8.1.7 — the two boards cannot disagree about one pair", () => {
  test("solo rows on the GROUP board follow the same ranking basis as the individual board", async () => {
    // END TO END rather than at the comparator, because it CAN be driven here:
    // the discrimination comes from making presence order the OPPOSITE of elapsed
    // order, which needs no clock control — only the ordering of two sessions.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, {
      measure_presence: true, time_basis: "presence", group_leaderboard_enabled: true,
    });
    // Both finish everything, so both are FINISHERS on the same score — the only
    // pair shape the presence tie-break is allowed to touch.
    const t1 = await makeTask(api, csrf, comp.id, "one");
    const t2 = await makeTask(api, csrf, comp.id, "two");

    const A = await makeParticipant(api, csrf);
    const B = await makeParticipant(api, csrf);
    // Fixture checklist item 1: a third enrolled participant who solves NOTHING,
    // so the all-solved auto-end cannot end the event under the assertions and
    // freeze a snapshot mid-test.
    const C = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [A, B, C]);

    // Two non-empty bound groups — the group board's own gate. A and B are each
    // in exactly one, so no member-clash refusal, and both keep direct_assigned=1
    // from the assign above, which is what gives them SOLO rows.
    await bindGroups(api, csrf, comp.id, [
      await makeGroup(api, csrf, [A.id]),
      await makeGroup(api, csrf, [B.id]),
    ]);

    // ── THE OPPOSITION ───────────────────────────────────────────────────────
    // B logs in FIRST (early login_time) and finishes LAST → the LONG elapsed
    // window. A logs in second and finishes first → the SHORT one. Presence is
    // then seeded the other way round: A high, B low. So:
    //   elapsed basis  → A first
    //   presence basis → B first
    // A group board ignoring presence therefore lands on the opposite order.
    //
    // v8.3.11 — THE OPPOSITION USED TO BE BUILT BY HAVING B SEND NO
    // `X-Client-Active` HEADER, which banked B a zero. That was the F5 exploit
    // being locked in as expected behaviour, and post-F5 B's two submits are
    // themselves evidence of activity, so B banks a bucket like everyone else.
    // Seeding is now the only way to produce a presence DIFFERENCE at all (see
    // `presenceSeed`), and it must happen BEFORE the solves or the solves claim
    // the current bucket first and the seed is a silent no-op.
    const pb = await enter(B.email, comp.id);
    const pa = await enter(A.email, comp.id);
    await presenceSeed(api, csrf, comp.id, A.id, 4);   // 20 minutes
    await presenceSeed(api, csrf, comp.id, B.id, 1);   //  5 minutes
    await solve(pa, t1, "one");
    await solve(pa, t2, "two");
    await solve(pb, t1, "one");
    await solve(pb, t2, "two");

    const ind = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const rowA = ind.find(r => r.nickname === A.nickname);
    const rowB = ind.find(r => r.nickname === B.nickname);
    expect(rowA && rowB, "both finishers must be on the individual board").toBeTruthy();

    // Preconditions, asserted so a fixture that stopped producing the opposition
    // fails AS a fixture rather than passing as a test.
    expect(rowA.score, "same score, or the tie-break never runs").toBe(rowB.score);
    expect(rowA.allSolved && rowB.allSolved, "both must be FINISHERS").toBe(true);
    // The seeded floors. Asserted as `>=` rather than `===` because a test that
    // straddles a five-minute boundary legitimately banks each of them one extra
    // bucket from their own submits — which shifts both numbers and neither
    // ordering, so pinning the exact value would buy a flake and nothing else.
    expect(rowA.presenceMs, "A's seeded presence must have landed").toBeGreaterThanOrEqual(4 * BUCKET);
    expect(rowB.presenceMs, "B's must too — and it is NON-ZERO now, because "
      + "post-F5 B's own submits are evidence of activity (the old `=== 0` here was "
      + "asserting the exploit)").toBeGreaterThanOrEqual(BUCKET);
    expect(rowA.presenceMs, "A must be the HIGHER-presence finisher, or the presence "
      + "basis has nothing to say about this pair").toBeGreaterThan(rowB.presenceMs);
    expect(rowB.elapsedMs, "B's elapsed window must be the LONGER one, or the "
      + "presence order and the elapsed order would not disagree").toBeGreaterThan(rowA.elapsedMs);

    // The individual board ranks on presence: B (the lower) ahead of A.
    const indOrder = ind.filter(r => r.nickname === A.nickname || r.nickname === B.nickname).map(r => r.nickname);
    expect(indOrder, "presence basis: the lower presence wins among finishers")
      .toEqual([B.nickname, A.nickname]);

    // ...and the GROUP board's solo rows must say the same thing.
    const grp = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}&groups=1`)).json();
    expect(Array.isArray(grp) && grp.length, "the team board must actually render — "
      + "check the opt-in flag and the two-non-empty-groups gate").toBeTruthy();
    expect(grp.some(r => r.type === "group"), "including at least one GROUP row").toBe(true);
    const soloOrder = grp.filter(r => r.type === "individual"
      && (r.nickname === A.nickname || r.nickname === B.nickname)).map(r => r.nickname);
    expect(soloOrder.length, "both solo rows must be present").toBe(2);
    expect(soloOrder, "the solo rows must order the pair exactly as the individual "
      + "board did — they are the same people, one section apart, in the same payload")
      .toEqual(indOrder);
  });

  test("the group board's solo rows never leak the internal presence field", async () => {
    // The solo rows carry `_presenceMs` only for the sort; `stripInternal` drops
    // it before the rows reach the wire OR `group_leaderboard_snapshots`. This is
    // structural, not a name list — a key added under any new internal name is
    // caught too (the v7.28.0 rule).
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, {
      measure_presence: true, time_basis: "presence", group_leaderboard_enabled: true,
    });
    await makeTask(api, csrf, comp.id);
    const A = await makeParticipant(api, csrf);
    const B = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [A, B]);
    await bindGroups(api, csrf, comp.id, [
      await makeGroup(api, csrf, [A.id]),
      await makeGroup(api, csrf, [B.id]),
    ]);
    await enter(A.email, comp.id);
    await enter(B.email, comp.id);

    const grp = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}&groups=1`)).json();
    // POSITIVE CONTROL — the board really rendered, so "no internal key" is not
    // merely "no rows", which is how a leak lock goes vacuous on this surface.
    expect(grp.length, "the team board must be populated").toBeGreaterThan(0);
    expect(grp.some(r => r.type === "individual"), "including at least one SOLO row").toBe(true);
    const offenders = [];
    for (const [i, r] of grp.entries()) {
      for (const k of Object.keys(r || {})) if (k[0] === "_") offenders.push(`board[${i}].${k}`);
    }
    expect(offenders, `internal key(s) on a group-board row: ${JSON.stringify(offenders)}`).toEqual([]);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// v8.3.11 / F7 — BOTH RANKING COMPARATORS ARE STRICT WEAK ORDERINGS
// ═════════════════════════════════════════════════════════════════════════════
//
// Asserted at the comparator, on the v8.1.0 / v8.1.7 precedent and for the same
// reason those give: the pair shapes that close the cycle cannot be manufactured
// through the API without clock control the suite does not have, and the
// comparator IS the rule.
//
// PERMUTATION-INVARIANCE, NEVER A SPECIFIC ORDER. Asserting "the order is
// B > A > C" is equally satisfied by a build that ignores presence altogether —
// which is a far worse change and would sail past. What a cycle actually does is
// make the ANSWER DEPEND ON THE INPUT ORDER, so the input order is what the test
// varies: `buildLeaderboardEntries`' users query carries no `ORDER BY`, so the
// order really is SQLite's to choose, and the resolved order of a cycle is
// arbitrary and then PERSISTED — into `achievement_badges.rank`, which decides
// who is issued a "3rd Place" certificate, and into
// `group_leaderboard_snapshots`, which freezes the team board at end-of-event.
//
// Note that "one order across six permutations" is NOT satisfied by a comparator
// that returns 0 for everything: `Array#sort` is stable, so each permutation
// would come back as itself and the set would hold six. What it IS satisfied by
// is any total order that ignores presence — hence the three controls below,
// which are what stop these two tests being satisfied by a build where nothing
// ever happens. They overlap the scope test above on purpose: the permutation
// assertions are worthless without controls in the SAME block, so they must not
// depend on a neighbouring test keeping its shape.
test.describe("v8.3.11 — the ranking comparators are strict weak orderings", () => {
  /** Every ordering of `xs`. Six for three rows, which is the whole search space. */
  function permutations(xs) {
    if (xs.length <= 1) return [xs];
    const out = [];
    xs.forEach((x, i) => {
      for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
    });
    return out;
  }
  const label = (r) => (r.type === "group" ? r.groupId : r.userId);
  /** Distinct results of sorting every permutation, as `a>b>c` strings. */
  function ordersOf(rows, sortFn) {
    const seen = new Set();
    for (const p of permutations(rows)) seen.add(sortFn([...p]).map(label).join(">"));
    return [...seen];
  }

  // Score 150 throughout, so the tie-break is the ONLY thing deciding anything.
  //
  //   A — finished, elapsed 5m30s, presence 10m
  //   B — finished, elapsed 19m,   presence  5m
  //   C — UNFINISHED, elapsed 10m  (elapsed sits strictly BETWEEN A's and B's)
  //
  // Pre-fix: A beats B on presence, B beats C on elapsed, C beats A on elapsed.
  // Every value is distinct — no millisecond collision is required, which is what
  // the caveat this release deleted got wrong. The inversion the cycle needs is
  // ordinary: presence accrues only while a human acts, so someone who anchors
  // early with the tab backgrounded elapses 19 minutes on one bucket while a late,
  // attentive finisher elapses 6 minutes on two.
  const A = { type: "individual", userId: "a", score: 150, allSolved: true,  solveTimeMs: 330_000,  _presenceMs: 600_000 };
  const B = { type: "individual", userId: "b", score: 150, allSolved: true,  solveTimeMs: 1_140_000, _presenceMs: 300_000 };
  const C = { type: "individual", userId: "c", score: 150, allSolved: false, solveTimeMs: 600_000,  _presenceMs: 0 };

  test("the INDIVIDUAL comparator resolves a finisher/non-finisher trio the same way whatever order it arrives in", () => {
    const { sortLeaderboard } = require("../lib/leaderboard");
    const orders = ordersOf([A, B, C], (rows) => sortLeaderboard(rows, true));
    // MEASURED pre-fix: three distinct orders — `b>a>c`, `a>c>b`, `c>b>a`.
    // Mutation caught: dropping the finisher partition
    // (`if (usePresence && !!a.allSolved !== !!b.allSolved) …`) from
    // `compareLeaderboardEntries`.
    expect(orders, `a score-tied trio must resolve to ONE order however SQLite `
      + `happens to return the rows; got ${orders.length}: ${JSON.stringify(orders)}`)
      .toHaveLength(1);
  });

  test("the GROUP comparator resolves a group/solo trio the same way whatever order it arrives in", () => {
    const { compareGroupBoardRows } = require("../lib/leaderboard");
    // THE GROUP CYCLE NEEDS NO NON-FINISHER AT ALL, which is exactly why fixing
    // the individual comparator does not reach it: a group row can be `allSolved`
    // too, so it lands in the same block as the solo finishers and is still
    // compared on ELAPSED while they are compared on PRESENCE. G's elapsed sits
    // between A's and B's and closes the loop.
    const G = { type: "group", groupId: "g-1", score: 150, allSolved: true, solveTimeMs: 600_000 };
    const orders = ordersOf([A, B, G], (rows) => rows.sort((x, y) => compareGroupBoardRows(x, y, true)));
    // MEASURED pre-fix: three distinct orders — `b>a>g-1`, `a>g-1>b`, `g-1>b>a`.
    // Mutation caught: dropping the TYPE partition from `compareGroupBoardRows`.
    // That mutation leaves the individual test above GREEN, and the individual
    // mutation leaves this one green — the two fixes are independent and each
    // needs its own witness.
    expect(orders, `the team board must resolve to ONE order however the rows `
      + `arrive; got ${orders.length}: ${JSON.stringify(orders)}`)
      .toHaveLength(1);
  });

  // ── THE THREE CONTROLS ─────────────────────────────────────────────────────
  // Permutation-invariance alone is satisfied by any total order that never
  // consults presence — a comparator that sorted purely on userId would pass both
  // tests above while deleting the feature. These say the mechanism is still
  // there, still opt-in, and still scoped to finishers.

  test("control (i): with the basis ON, two tied finishers are ordered LOWER PRESENCE FIRST", () => {
    const { sortLeaderboard } = require("../lib/leaderboard");
    // Identical in every respect except presence, so nothing else can decide it.
    const hi = { type: "individual", userId: "a", score: 100, allSolved: true, solveTimeMs: 5_000, _presenceMs: 90_000 };
    const lo = { type: "individual", userId: "z", score: 100, allSolved: true, solveTimeMs: 5_000, _presenceMs: 10_000 };
    // `z` sorts ahead of `a` — which the id tie-break alone would never do, so this
    // cannot pass by falling through.
    // Mutation caught: deleting the presence block from `compareLeaderboardEntries`
    // entirely (both permutation tests stay green under it, because a comparator
    // that only ever looks at elapsed is perfectly transitive).
    expect(sortLeaderboard([hi, lo], true).map(r => r.userId),
      "the more efficient finisher — less platform time for the same score — wins the tie")
      .toEqual(["z", "a"]);
  });

  test("control (ii): with the basis OFF, the same pair falls through to elapsed then id", () => {
    const { sortLeaderboard } = require("../lib/leaderboard");
    const hi = { type: "individual", userId: "a", score: 100, allSolved: true, solveTimeMs: 5_000, _presenceMs: 90_000 };
    const lo = { type: "individual", userId: "z", score: 100, allSolved: true, solveTimeMs: 5_000, _presenceMs: 10_000 };
    // The feature is OPT-IN per event, so an event that did not ask for it must be
    // byte-identical to the pre-v8.1.0 behaviour. Elapsed ties here, so the id
    // tie-break decides and the order INVERTS relative to control (i) — which is
    // what says the basis flag is genuinely read rather than ignored.
    // Mutation caught: hard-wiring `usePresence` true inside either comparator.
    expect(sortLeaderboard([lo, hi], false).map(r => r.userId),
      "no opt-in, no presence — deterministic id order").toEqual(["a", "z"]);
  });

  test("control (iii): a NON-FINISHER pair is never ordered on presence", () => {
    const { sortLeaderboard } = require("../lib/leaderboard");
    // The one-way door v8.1.0 recorded. For a non-finisher `solveTimeMs` runs to
    // the event end for everybody, so presence would be the ONLY separator and
    // LOWER would win — ranking the participant who barely turned up above the one
    // who worked for hours and still did not finish. The new finisher partition
    // must not have widened the presence block to reach them.
    // Mutation caught: relaxing the block to `if (usePresence)`, i.e. comparing
    // presence for every pair once the event opts in.
    const hi = { type: "individual", userId: "a", score: 100, allSolved: false, solveTimeMs: 5_000, _presenceMs: 90_000 };
    const lo = { type: "individual", userId: "z", score: 100, allSolved: false, solveTimeMs: 5_000, _presenceMs: 10_000 };
    expect(sortLeaderboard([lo, hi], true).map(r => r.userId),
      "presence must not separate two people who did not finish").toEqual(["a", "z"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// v8.3.11 / F5 — AN ACTION REQUEST IS ITS OWN EVIDENCE
// ═════════════════════════════════════════════════════════════════════════════
//
// The design specified two ways a request qualifies for presence: an ACTION
// endpoint counts WITHOUT `X-Client-Active`, a POLLED one counts only WITH it. Only the second half was built, so the header was the sole
// evidence — and omitting it banked a perfect ZERO, which the finishers-only
// tie-break then REWARDS. Driven end to end rather than at the middleware,
// because the whole finding is that the client's assertion was load-bearing and
// only a real request can be made without it.
test.describe("v8.3.11 — presence counts an ACTION without the client's header", () => {
  test("a participant who opens a challenge and submits, sending NO header, banks presence", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const t1 = await makeTask(api, csrf, comp.id, "one");
    const act = await makeParticipant(api, csrf);
    // Fixture checklist item 1: an enrolled participant who solves NOTHING, so the
    // all-solved auto-end cannot end the event underneath the assertions — a dead
    // event stops accruing presence and the assertion would be about the clock.
    const idle = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [act, idle]);

    // Precondition: the event really measures. Without it "presence is non-zero"
    // could not be true and the test would be about a fixture, not a fix.
    const listed = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
    expect(listed && listed.measure_presence, "precondition: recording is ON").toBeTruthy();

    const pa = await enter(act.email, comp.id);
    // NO `X-Client-Active` ANYWHERE ON THIS PARTICIPANT. `enter` sends none,
    // `gradingHashFor`'s `GET /api/tasks/:id` sends none and `solve`'s submit sends
    // none — which pre-F5 meant this participant banked a perfect zero however hard
    // they worked, and then WON every score tie against an honest finisher.
    await solve(pa, t1, "one");

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const mine = board.find(r => r.nickname === act.nickname);
    expect(mine, "the participant must be on the board").toBeTruthy();
    // `>=` one bucket rather than `===`: opening the challenge and submitting are
    // two action requests, so a run that straddles a five-minute boundary banks two.
    // Mutation caught: restoring the unconditional
    // `if (req.get("X-Client-Active") !== "1") return;` gate.
    expect(mine.presenceMs, "an action request is evidence enough on its own — a "
      + "measured participant who submitted an answer cannot read 0")
      .toBeGreaterThanOrEqual(BUCKET);
  });

  test("a POLLED endpoint with no header still banks NOTHING — an allow-list, not a poll deny-list", async () => {
    // THE CONTROL THAT MAKES THE FIX A FIX RATHER THAN A REGRESSION. v7.14.5's
    // warning about the session slide applies verbatim: a parked tab issues
    // background polls forever, so counting presence on everything would mean an
    // abandoned browser accrues platform time for the length of the event — which
    // is precisely the measurement being defended. Presence is scoped to an
    // ALLOW-LIST of five action routes, and `/api/status` (the 15-second poll) is
    // deliberately not one of them.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    await makeTask(api, csrf, comp.id);
    const bare = await makeParticipant(api, csrf);      // polls, sends no header
    const declared = await makeParticipant(api, csrf);  // polls, DECLARES activity
    await assign(api, csrf, comp.id, [bare, declared]);
    // Nobody solves anything in this fixture, so there is no auto-end to guard.

    const pBare = await enter(bare.email, comp.id);
    const pDecl = await enter(declared.email, comp.id);
    for (let i = 0; i < 3; i++) {
      const r = await pBare.api.get("/api/status");
      expect(r.ok(), `the poll itself must succeed, or this measures nothing: ${await r.text()}`).toBeTruthy();
    }
    const rd = await pDecl.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    expect(rd.ok(), `the declared poll must succeed too: ${await rd.text()}`).toBeTruthy();

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const rowBare = board.find(r => r.nickname === bare.nickname);
    const rowDecl = board.find(r => r.nickname === declared.nickname);
    expect(rowBare && rowDecl, "both pollers must be on the board").toBeTruthy();

    // THE POSITIVE CONTROL COMES FIRST, because without it "the bare poller banked
    // nothing" is equally satisfied by a build where `/api/status` never reaches
    // the presence middleware at all, or where this participant was never eligible.
    // Same endpoint, same event, same second — only the header differs.
    //
    // Mutation caught HERE: inverting the gate to
    // `req.get(...) === "1" && !_isPresenceActionRequest(req)` — the realistic wrong
    // implementation, which reads naturally and stops counting the honest client
    // that declares itself. Measured: this assertion goes red (rowDecl 0), and the
    // action tests either side of it stay green, so this line is the only witness.
    expect(rowDecl.presenceMs, "positive control: /api/status DOES bank when the "
      + "client declares a human is present").toBeGreaterThanOrEqual(BUCKET);
    // Mutation caught HERE: making `_isPresenceActionRequest` return true
    // unconditionally (or widening the allow-list to cover polls).
    expect(rowBare.presenceMs, "a poll is not evidence of anything — three of them "
      + "with no header must bank nothing, or a parked tab accrues forever").toBe(0);
  });

  test("the participant PULSE is a poll too: bare it banks nothing, declared it banks a bucket", async () => {
    // GET /api/participant/pulse is the one timer-driven read the SPA sends inside
    // an event (the poll above's successor), so it is where "a parked tab accrues
    // for ever" would come back: it must stay OFF the action allow-list and count
    // only with the client's header. Same shape as the /api/status control above.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    await makeTask(api, csrf, comp.id);
    const bare = await makeParticipant(api, csrf);      // pulses, sends no header
    const declared = await makeParticipant(api, csrf);  // pulses, DECLARES activity
    await assign(api, csrf, comp.id, [bare, declared]);
    // Nobody solves anything in this fixture, so there is no auto-end to guard.

    const pBare = await enter(bare.email, comp.id);
    const pDecl = await enter(declared.email, comp.id);
    for (let i = 0; i < 3; i++) {
      const r = await pBare.api.get("/api/participant/pulse");
      expect(r.status(), `the pulse itself must answer, or this measures nothing: ${await r.text()}`).toBe(200);
    }
    const rd = await pDecl.api.get("/api/participant/pulse", { headers: { "X-Client-Active": "1" } });
    expect(rd.status(), `the declared pulse must answer too: ${await rd.text()}`).toBe(200);

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const rowBare = board.find(r => r.nickname === bare.nickname);
    const rowDecl = board.find(r => r.nickname === declared.nickname);
    expect(rowBare && rowDecl, "both pulsing participants must be on the board").toBeTruthy();
    // POSITIVE CONTROL first: the pulse reaches the presence middleware, and a
    // declared one counts — so the zero below is a decision, not a dead path.
    expect(rowDecl.presenceMs, "positive control: a pulse DOES bank when the client "
      + "declares a person is present").toBeGreaterThanOrEqual(BUCKET);
    expect(rowBare.presenceMs, "three bare pulses are no evidence of anyone: they bank nothing").toBe(0);
  });

  test("an ACTION request WITH the header still counts — the last cell of the matrix", async () => {
    // BREADTH, NOT DISCRIMINATION, and said plainly rather than dressed up as a
    // mutation this test catches. The gate has two inputs, so there are four cells:
    // (no header, action) is the test above; (no header, poll) and (header, poll)
    // are the two halves of the control test; this is the fourth, and nothing else
    // in the block covers it. On its own it is satisfied by any build where
    // presence works at all.
    //
    // It is NOT the witness for the inverted gate — that was the natural claim to
    // make and it is false. Measured: under
    // `req.get(...) === "1" && !_isPresenceActionRequest(req)` this test still
    // PASSES, because an action request short-circuits the second clause whichever
    // way the first is written. The poll test's positive control is what catches it.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const t1 = await makeTask(api, csrf, comp.id, "one");
    const act = await makeParticipant(api, csrf);
    const idle = await makeParticipant(api, csrf);   // solves nothing → no auto-end
    await assign(api, csrf, comp.id, [act, idle]);

    const pa = await enter(act.email, comp.id);
    // The header goes on EVERY request this participant makes, including the
    // grading-hash read — otherwise the bare `GET /api/tasks/:id` would bank the
    // bucket on its own and the test would be about the previous case again.
    const hdr = { ...H(pa.csrf), "X-Client-Active": "1" };
    const gh = await pa.api.get(`/api/tasks/${t1}`, { headers: { "X-Client-Active": "1" } });
    expect(gh.ok(), `open challenge: ${await gh.text()}`).toBeTruthy();
    const gradingHash = (await gh.json()).grading_hash;
    expect(gradingHash, "the grading token must be obtainable").toBeTruthy();
    const sub = await pa.api.post(`/api/tasks/${t1}/submit`, { headers: hdr, data: { answer: "one", gradingHash } });
    expect(sub.ok(), `submit: ${await sub.text()}`).toBeTruthy();
    expect((await sub.json()).correct, "the answer must grade CORRECT").toBe(true);

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    const mine = board.find(r => r.nickname === act.nickname);
    expect(mine, "the participant must be on the board").toBeTruthy();
    expect(mine.presenceMs, "declaring activity AND acting must still count")
      .toBeGreaterThanOrEqual(BUCKET);
  });

  test("EVERY entry on the allow-list counts, one participant per entry", async () => {
    // THE LIST IS AN ENUMERATION, AND PROSE IS NOT ONE (v7.15.8). The gate is a
    // single line, so the two tests above prove the MECHANISM — but they exercise
    // only two of the five routes `_isPresenceActionRequest` names, and the other
    // three are five independent regexes. A typo in one of them silently un-covers
    // a genuine action endpoint: nothing errors, that route simply goes back to
    // requiring the header, and every other test here stays green. So each entry
    // gets its OWN participant who performs exactly ONE action and nothing else,
    // which is what makes the reading attributable — a shared participant would
    // bank a bucket on the first action and say nothing about the rest.
    //
    // ANTI-VACUITY: this is an all-positive test, so on its own it is satisfied by
    // a build that counts everything. Its control is the poll test above — an
    // identically-built participant on an identically-configured event who issues
    // `GET /api/status` with no header and must read 0.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, { measure_presence: true });
    const t1 = await makeTask(api, csrf, comp.id, "one", { hint: "look closer" });

    // Nobody in this fixture solves anything, so there is no auto-end to guard —
    // and a hint or a rating is not a solve.
    const pList = await makeParticipant(api, csrf);
    const pHint = await makeParticipant(api, csrf);
    const pRate = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [pList, pHint, pRate]);

    const listed = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
    expect(listed && listed.measure_presence, "precondition: recording is ON").toBeTruthy();

    // GET /api/tasks — opening the challenge list.
    const s1 = await enter(pList.email, comp.id);
    const r1 = await s1.api.get("/api/tasks");
    expect(r1.ok(), `GET /api/tasks: ${await r1.text()}`).toBeTruthy();

    // POST /api/tasks/:id/hint — buying a hint. Costs 30% of the challenge's
    // points, which is exactly why it is unambiguous evidence of a human.
    const s2 = await enter(pHint.email, comp.id);
    const r2 = await s2.api.post(`/api/tasks/${t1}/hint`, { headers: H(s2.csrf) });
    expect(r2.ok(), `POST hint: ${await r2.text()}`).toBeTruthy();

    // PUT /api/tasks/:id/feedback — rating a challenge.
    const s3 = await enter(pRate.email, comp.id);
    const r3 = await s3.api.put(`/api/tasks/${t1}/feedback`, { headers: H(s3.csrf), data: { rating: 4 } });
    expect(r3.ok(), `PUT feedback: ${await r3.text()}`).toBeTruthy();

    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
    for (const [who, what] of [[pList, "GET /api/tasks"], [pHint, "POST /api/tasks/:id/hint"], [pRate, "PUT /api/tasks/:id/feedback"]]) {
      const row = board.find(r => r.nickname === who.nickname);
      expect(row, `${who.nickname} must be on the board`).toBeTruthy();
      // Mutation caught: breaking any ONE of the five allow-list patterns — only
      // that entry's participant reads 0, and the message names the route.
      expect(row.presenceMs, `${what} is on the allow-list and must bank a bucket `
        + `with no header — this participant did nothing else at all`)
        .toBeGreaterThanOrEqual(BUCKET);
    }
  });
});
