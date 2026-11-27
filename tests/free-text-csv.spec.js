// @ts-check
//
// v8.9.0 — THE FREE-TEXT RESPONSES, POPULATED: the endpoint with real `any`
// answers in it, and the FOCUSED participants CSV that renders them.
//
// tests/free-text-responses-api.spec.js pins the SHAPE and the refusal ladder
// on an EMPTY event (no `any` challenge existed at that step of the release).
// This file is the other half — every arm below needs a participant to have
// actually typed something, and each one is killed by a realistic wrong build:
//
//   API
//   1. shape + ordering — only the `any` challenges, in task-NUMBER order (the
//      fixture creates the MEDIUM one first so creation order and title order
//      both disagree with number order), three verbatim answers keyed by
//      (user, task), the `text` challenge absent;
//   2. LATEST-correct — a wrong `text` guess, a switch to `any`, a real answer,
//      a recalculate that flips the old guess correct too: the export carries
//      the LATER row (a first-row Map keeps "foo");
//   3. `is_correct` — the same switch with NO recalculate and NO further
//      submit: the old wrong row must NOT surface (dropping the predicate
//      exports a rejected guess as a response);
//   4. scope — an event admin reads their own event and is refused another's
//      with the named code (removing `competitionDenied` opens it);
//   5. audit — the `data_exported` line, found by the request's OWN id.
//
//   BROWSER (the focused participants CSV, driven through the real export)
//   6. one `Response: <number> <title>` column per `any` challenge, after
//      `Events`, in number order; the cells verbatim — leading and trailing
//      spaces survive inside the quotes — and an empty cell where a
//      participant never answered;
//   7. unfocused: no `Response:` column at all;
//   8. focused on an event with NO `any` challenge: the header is
//      byte-identical to the unfocused one;
//   9. a failed read ABORTS the export — no blob, a toast — rather than
//      shipping a file that looks complete and is not.
//
// Fixture rules (CLAUDE.md, *Competition-fixture checklist*): every test owns
// its competition, its challenges and its participants; every fixture leaves
// at least one enrolled participant with something unsolved, so the all-solved
// auto-end can never fire under a test; every setup call is asserted. The
// three helpers are the attempt-caps trio verbatim (`makeParticipant`,
// `makeFixture`, `enter`, `submit`), taking `taskSpecs` the way
// text-alternatives does.
//
// SUPERADMIN SESSIONS ARE PER TEST, NEVER SHARED ACROSS THE FILE: the platform
// enforces one session per user, so the browser arms' `adminLogin(page)` would
// kill any superadmin API context a `beforeAll` had kept open, and the first
// API call after that would 401 pointing nowhere near the cause.
//
// Responses in the fixtures deliberately never begin with `=`, `+`, `-` or
// `@`: formula neutralisation apostrophe-prefixes those, and that rule is
// locked elsewhere (v7.24.0); here the subject is verbatim carriage.
const path = require("path");
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DATA_DIR, findLogLine, BASE, codeLogin } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");

// The `page` fixture needs a baseURL for adminLogin's goto("/") — the config
// deliberately sets none (it is TEST_PARALLEL_INDEX-scoped in helpers.BASE).
test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `ft${Date.now().toString(36)}`;
let seq = 0;
// Zero-padded so a title's sort order cannot flip once `seq` passes 36 (base36
// "10" sorts before "2"); the ordering arm relies on titles, not on luck.
const uniq = () => `${TAG}${(seq++).toString(36).padStart(3, "0")}`;
const URL_FOR = (id) => `/api/admin/competitions/${encodeURIComponent(id)}/free-text-responses`;

// The base header the participants CSV has carried since v8.1.0 (PR 24). Not
// asserted against the client source — asserted against the FILE, where the
// unfocused export must still end on `Events` and the focused one continues
// from there.
const BASE_LAST_HEADER = "Events";

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Free", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `?search=` is a NO-OP on this endpoint (v8.2.3); the 5000 cap is what
  // makes a just-created account findable.
  const list = await (await api.get(`/api/admin/participants?limit=5000`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify ${label}: ${await v.text()}`).toBeTruthy();
  const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(a.ok(), `approve ${label}: ${await a.text()}`).toBeTruthy();
  return { id: u.id, email };
}

/** A LIVE competition with no challenges and nobody enrolled. */
async function makeComp(api, csrf) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(),
      duration_minutes: 600, timezone: "UTC",
    },
  });
  expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
  return (await cr.json()).competition;
}

/**
 * A live competition, one challenge per entry of `taskSpecs`, and `people`
 * participants enrolled. `taskSpecs[i]` supplies `answer_type` (+
 * `correct_answer` for a keyed type, `difficulty` to override `easy`).
 */
async function makeFixture(api, csrf, { taskSpecs = [], people = 2 } = {}) {
  const comp = await makeComp(api, csrf);
  const tasks = [];
  for (let i = 0; i < taskSpecs.length; i++) {
    const title = `${uniq()} T${i}`;
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title, description: "d", difficulty: "easy", status: "published", ...taskSpecs[i] },
    });
    expect(tr.ok(), `create task ${i}: ${await tr.text()}`).toBeTruthy();
    // Take the id the create RETURNS (the attempt-caps lesson: resolving by
    // title suffix matches a task an EARLIER test in this file created).
    const { id: tid } = await tr.json();
    expect(tid, "the create returns the new challenge's id").toBeTruthy();
    const t = { id: tid, title };
    tasks.push(t);
    const asg = await api.post(`/api/admin/tasks/${t.id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign task ${i}: ${await asg.text()}`).toBeTruthy();
  }
  const users = [];
  for (let i = 0; i < people; i++) users.push(await makeParticipant(api, csrf, uniq()));
  if (users.length) {
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [comp.id] },
    });
    expect(asg.ok(), `assign users: ${await asg.text()}`).toBeTruthy();
    expect((await asg.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(users.length);
  }
  return { comp, tasks, users };
}

/** Sign a participant in and put them into the competition. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

/** One submission through the real path, carrying the grading token. */
async function submit(api, csrf, taskId, answer) {
  const view = await (await api.get(`/api/tasks/${taskId}`)).json();
  const r = await api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer, gradingHash: view.grading_hash || "" },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** A participant enters and submits one answer; asserts the grading verdict. */
async function answer(email, compId, taskId, text, { correct }) {
  const { api, csrf } = await enter(email, compId);
  try {
    const s = await submit(api, csrf, taskId, text);
    expect(s.status, `submit ${JSON.stringify(text)}: ${JSON.stringify(s.body)}`).toBe(200);
    expect(s.body.correct, `submit ${JSON.stringify(text)} graded ${correct ? "correct" : "wrong"}: ${JSON.stringify(s.body)}`).toBe(correct);
  } finally { await api.dispose(); }
}

/** Switch a `text` challenge to `any` through the real PUT, with the concurrency token. */
async function switchToAny(api, csrf, taskId) {
  const list = await (await api.get("/api/admin/tasks")).json();
  const row = (Array.isArray(list) ? list : list.tasks || []).find(t => t.id === taskId);
  expect(row, "the challenge is on the admin list").toBeTruthy();
  const r = await api.put(`/api/admin/tasks/${taskId}`, {
    headers: H(csrf), data: { answer_type: "any", expectedUpdatedAt: row.updated_at },
  });
  expect(r.ok(), `switch to any: ${r.status()} ${await r.text()}`).toBeTruthy();
}

async function recalc(api, csrf, taskId) {
  // The fixture's event is LIVE, so the route asks for the confirmation the
  // client's second dialog sends (v8.1.5).
  const r = await api.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: H(csrf), data: { confirm_live: true } });
  expect(r.ok(), `recalculate: ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

/** "1.02" → [1, 2], so ascending can be asserted numerically rather than lexically. */
const numTuple = (n) => String(n).split(".").map(x => parseInt(x, 10));
const ascending = (a, b) => numTuple(a)[0] < numTuple(b)[0]
  || (numTuple(a)[0] === numTuple(b)[0] && numTuple(a)[1] < numTuple(b)[1]);

/**
 * A minimal RFC 4180 reader for the file the client writes: every cell is
 * quoted, inner quotes doubled, LF terminated, BOM first. Splitting on LF is
 * safe here because no fixture value carries a newline.
 */
function parseCsv(text) {
  const body = text.replace(/^\uFEFF/, "");
  return body.split("\n").filter(l => l.length).map(line => {
    const cells = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

/**
 * Drive the REAL export in the page (the ui-admin-competitions stub shape):
 * focus (or unfocus) the event, reload the participant model, capture the blob
 * the download helper hands to `URL.createObjectURL`, and return its text.
 * `created` counts the createObjectURL calls, so "no blob" can be told from
 * "a blob whose text was empty".
 */
async function exportInBrowser(page, compId) {
  return page.evaluate(async (cid) => {
    window.S.adminSelectedCompetitionId = cid;
    await window.loadAdminParticipants();
    let blob = null, created = 0;
    const rc = URL.createObjectURL, rk = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { blob = b; created++; return "blob:probe"; };
    HTMLAnchorElement.prototype.click = function () {};
    try { await window.exportParticipantsCSV(); }
    finally { URL.createObjectURL = rc; HTMLAnchorElement.prototype.click = rk; }
    return { text: blob ? await blob.text() : null, created };
  }, compId);
}

// ── the arm-1 fixture, shared by arms 1, 5, 6 and 9 ────────────────────────
//
// Built once in beforeAll (a `-g` run of any single test still gets it), read
// by every consumer, mutated by none of them. Its shape is the whole of arm 1:
//   T0  `any`, MEDIUM  — created FIRST, so creation order puts it first and its
//                        title sorts first; its NUMBER (2.01) sorts LAST.
//   T1  `any`, easy    — number 1.0x, the FIRST column.
//   T2  `text`, easy   — the type-filter control; nobody answers it, which is
//                        also what keeps the all-solved auto-end from firing.
//   P1 answers T0 " first " and T1 "second"; P2 answers T1 only.
let fx1 = null;
const P1_T0 = " first ";      // leading AND trailing space — verbatim carriage
const P1_T1 = "second";
const P2_T1 = "p2 second";

test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    fx1 = await makeFixture(sa, csrf, {
      people: 2,
      taskSpecs: [
        { answer_type: "any", difficulty: "medium" },
        { answer_type: "any" },
        { answer_type: "text", correct_answer: "never answered" },
      ],
    });
  } finally { await sa.dispose(); }
  const [T0, T1] = fx1.tasks;
  const [P1, P2] = fx1.users;
  await answer(P1.email, fx1.comp.id, T0.id, P1_T0, { correct: true });
  await answer(P1.email, fx1.comp.id, T1.id, P1_T1, { correct: true });
  await answer(P2.email, fx1.comp.id, T1.id, P2_T1, { correct: true });
});

test.describe("free-text responses — populated (v8.9.0)", () => {

  test("1. only the `any` challenges, in task-number order, with every answer verbatim", async () => {
    const { api: sa } = await apiLogin("superadmin");
    try {
      const [T0, T1, T2] = fx1.tasks;
      const [P1, P2] = fx1.users;
      const r = await sa.get(URL_FOR(fx1.comp.id));
      expect(r.status(), await r.text()).toBe(200);
      const d = await r.json();

      // The text challenge is ABSENT — by id, not by count, so a build that
      // returned every assignment cannot pass on a lucky count.
      const ids = d.challenges.map(c => c.id);
      expect(ids, "the text challenge is not a free-text column").not.toContain(T2.id);
      // Easy (1.0x) before medium (2.01): creation order AND title order both
      // put T0 first, so this is the assertion that says "by NUMBER".
      expect(ids).toEqual([T1.id, T0.id]);
      for (const c of d.challenges) {
        expect(c.task_number, `${c.title} is numbered (the event is live)`).toMatch(/^\d+\.\d{2}$/);
        expect(c.title, "the title rides the wire — the CSV header is built from it").toBeTruthy();
      }
      expect(ascending(d.challenges[0].task_number, d.challenges[1].task_number),
        `numbers ascend: ${d.challenges.map(c => c.task_number).join(" < ")}`).toBe(true);
      expect(d.challenges.find(c => c.id === T1.id).title).toBe(T1.title);

      // Three responses, keyed by (user, task), each byte-for-byte what was typed.
      const at = (u, t) => d.responses.filter(x => x.user_id === u.id && x.task_id === t.id);
      expect(d.responses.length, JSON.stringify(d.responses)).toBe(3);
      expect(at(P1, T0).map(x => x.answer)).toEqual([P1_T0]);
      expect(at(P1, T1).map(x => x.answer)).toEqual([P1_T1]);
      expect(at(P2, T1).map(x => x.answer)).toEqual([P2_T1]);
      expect(at(P2, T0), "P2 never answered T0 — no row is manufactured").toEqual([]);
    } finally { await sa.dispose(); }
  });

  test("2. the LATEST correct row wins: a switched challenge exports the free-text answer, not the recalculated old guess", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      // people:2 — P2 never submits, so P1 finishing the only challenge cannot
      // auto-end the event (checklist item 1).
      const { comp, tasks: [T], users: [P1] } = await makeFixture(sa, csrf, {
        people: 2, taskSpecs: [{ answer_type: "text", correct_answer: "k" }],
      });
      await answer(P1.email, comp.id, T.id, "foo", { correct: false });
      await switchToAny(sa, csrf, T.id);
      await answer(P1.email, comp.id, T.id, " bar ", { correct: true });
      // The recalculate flips the OLD "foo" row correct too (any non-empty
      // answer is), so the pair now holds TWO correct rows — the state the
      // latest-wins reduction exists for. Asserted, or the test is satisfied by
      // a build where "foo" was simply never correct.
      const rc = await recalc(sa, csrf, T.id);
      expect(rc.flipped, `the old wrong row was re-graded: ${JSON.stringify(rc)}`).toBeGreaterThanOrEqual(1);

      const d = await (await sa.get(URL_FOR(comp.id))).json();
      const mine = d.responses.filter(x => x.user_id === P1.id && x.task_id === T.id);
      expect(mine.length, "exactly one response per (user, task)").toBe(1);
      expect(mine[0].answer, "the LATER row; a first-row Map would return \"foo\"").toBe(" bar ");
    } finally { await sa.dispose(); }
  });

  test("3. a rejected guess left under the old grading is NOT a response (is_correct = 1)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const { comp, tasks: [T], users: [P1, P2] } = await makeFixture(sa, csrf, {
        people: 2, taskSpecs: [{ answer_type: "text", correct_answer: "k2" }],
      });
      await answer(P2.email, comp.id, T.id, "foo", { correct: false });
      await switchToAny(sa, csrf, T.id);
      // NO recalculate, NO further submit for P2. P1 answers the free-text
      // version — the positive control, or "P2 has no response" is equally
      // satisfied by an endpoint that returns nobody's.
      await answer(P1.email, comp.id, T.id, "real", { correct: true });

      const d = await (await sa.get(URL_FOR(comp.id))).json();
      expect(d.challenges.map(c => c.id), "the switched challenge IS a free-text column now").toEqual([T.id]);
      expect(d.responses.filter(x => x.user_id === P1.id).map(x => x.answer)).toEqual(["real"]);
      expect(d.responses.filter(x => x.user_id === P2.id),
        "P2's wrong \"foo\" survives the switch as is_correct=0 and must not surface").toEqual([]);
    } finally { await sa.dispose(); }
  });

  test("4. an event admin reads their own event and is refused another's with the named code", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let ea = null;
    try {
      const A = await makeComp(sa, csrf);
      const B = await makeComp(sa, csrf);
      const who = await makeParticipant(sa, csrf, uniq());
      const g = await sa.post(`/api/admin/competitions/${A.id}/admins`, { headers: H(csrf), data: { userId: who.id } });
      expect(g.ok(), `grant: ${g.status()} ${await g.text()}`).toBeTruthy();
      expect((await g.json()).role_changed, "the grant promoted the account to the tier").toBe(true);

      ea = (await apiLogin(who.email, PARTICIPANT_PASS)).api;
      const inScope = await ea.get(URL_FOR(A.id));
      expect(inScope.status(), `in-scope control: ${await inScope.text()}`).toBe(200);
      expect(await inScope.json()).toEqual({ challenges: [], responses: [] });

      const out = await ea.get(URL_FOR(B.id));
      expect(out.status(), await out.text()).toBe(403);
      expect((await out.json()).code).toBe("event_admin_out_of_scope");

      // Global-admin control: B is refused for SCOPE, not because it is broken.
      const sb = await sa.get(URL_FOR(B.id));
      expect(sb.status(), `superadmin reads B: ${await sb.text()}`).toBe(200);
    } finally { await sa.dispose(); if (ea) await ea.dispose(); }
  });

  test("5. one export emits ONE data_exported line, joined to the request by its own id", async () => {
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get(URL_FOR(fx1.comp.id));
      expect(r.status(), await r.text()).toBe(200);
      // The line is joined on the request id the server returned, so this
      // cannot be satisfied by arm 1's earlier export of the same event.
      const reqId = r.headers()["x-request-id"];
      expect(reqId, "the response carries X-Request-ID").toBeTruthy();
      const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
        (j) => j.source === "audit" && j.scope === "export" && j.scope_id === "free-text-responses"
          && j.event_type === "data_exported" && j.details && j.details.req_id === reqId,
        { what: `an export:free-text-responses:data_exported line for request ${reqId}` });
      expect(line.details.competition_id).toBe(fx1.comp.id);
      expect(line.details.challenge_count).toBe(2);
      expect(line.details.response_count).toBe(3);
      expect(line.details.ip, "the requester's address rides the line (v7.21.32)").toBeTruthy();
      expect(line.actor || line.changed_by, "attributed to the acting admin").toBeTruthy();
    } finally { await sa.dispose(); }
  });
});

test.describe("the focused participants CSV carries the responses (v8.9.0)", () => {

  test("6. one Response column per any-challenge, after Events, in number order, cells verbatim", async ({ page }) => {
    await adminLogin(page);
    const [T0, T1] = fx1.tasks;
    const [P1, P2] = fx1.users;
    // The endpoint's own view of the columns — what the client builds from.
    const d = await (await page.request.get(URL_FOR(fx1.comp.id))).json();
    expect(d.challenges.map(c => c.id)).toEqual([T1.id, T0.id]);
    const expectedHeaders = d.challenges.map(c => `Response: ${c.task_number} ${c.title}`);

    const { text, created } = await exportInBrowser(page, fx1.comp.id);
    expect(created, "the focused export produced a file").toBe(1);
    const rows = parseCsv(text);
    const header = rows[0];

    // Placement: the two columns are the LAST two, immediately after Events.
    const evIdx = header.indexOf(BASE_LAST_HEADER);
    expect(evIdx, "the base header still ends on Events").toBeGreaterThan(0);
    expect(header.slice(evIdx + 1), "exactly one column per any-challenge, in task-number order").toEqual(expectedHeaders);
    expect(header.filter(h => h.startsWith("Response:")).length).toBe(2);

    // The focused export holds the event's MEMBERS and nobody else.
    const emailIdx = header.indexOf("Email");
    const body = rows.slice(1);
    expect(body.map(r => r[emailIdx]).sort(), "only the two enrolled participants").toEqual([P1.email, P2.email].sort());
    const rowOf = (u) => body.find(r => r[emailIdx] === u.email);
    const colT0 = header.indexOf(`Response: ${d.challenges[1].task_number} ${T0.title}`);
    const colT1 = header.indexOf(`Response: ${d.challenges[0].task_number} ${T1.title}`);
    expect(colT0).toBeGreaterThan(evIdx); expect(colT1).toBeGreaterThan(evIdx);
    expect(rowOf(P1)[colT0], "leading and trailing spaces survive").toBe(P1_T0);
    expect(rowOf(P1)[colT1]).toBe(P1_T1);
    expect(rowOf(P2)[colT1]).toBe(P2_T1);
    expect(rowOf(P2)[colT0], "an unanswered challenge is an EMPTY cell").toBe("");
    // And at the byte level: the spaces sit INSIDE the quotes, untrimmed and
    // un-neutralised (`f` is not a formula trigger). T0 is the LAST column, so
    // the cell is followed by the line end rather than a comma.
    expect(text).toMatch(new RegExp(`,"${P1_T0}"(\\n|$)`));
  });

  test("7. unfocused: no Response column at all", async ({ page }) => {
    await adminLogin(page);
    const { text, created } = await exportInBrowser(page, null);
    expect(created).toBe(1);
    const header = parseCsv(text)[0];
    expect(header[header.length - 1], "the unfocused file still ends on Events").toBe(BASE_LAST_HEADER);
    expect(header.filter(h => h.startsWith("Response:"))).toEqual([]);
  });

  test("8. focused on an event with no any-challenge: the header is byte-identical to the unfocused one", async ({ page }) => {
    // Own fixture: one `text` challenge, one enrolled participant who never
    // submits (so the row exists and nothing can auto-end).
    const { api: sa, csrf } = await apiLogin("superadmin");
    let fx;
    try {
      fx = await makeFixture(sa, csrf, { people: 1, taskSpecs: [{ answer_type: "text", correct_answer: "key" }] });
    } finally { await sa.dispose(); }
    // adminLogin AFTER the API context is disposed — one session per user.
    await adminLogin(page);
    const unfocused = await exportInBrowser(page, null);
    const focused = await exportInBrowser(page, fx.comp.id);
    expect(unfocused.created).toBe(1); expect(focused.created).toBe(1);
    const uh = parseCsv(unfocused.text)[0], fh = parseCsv(focused.text)[0];
    expect(fh).toEqual(uh);
    expect(focused.text.split("\n")[0]).toBe(unfocused.text.split("\n")[0]);
    // The focus TOOK — the file is the event's roster, not an empty table.
    const rows = parseCsv(focused.text);
    expect(rows.slice(1).map(r => r[uh.indexOf("Email")])).toEqual([fx.users[0].email]);
  });

  test("9. a failed read aborts the export: no blob, a toast", async ({ page }) => {
    await adminLogin(page);
    let hits = 0;
    await page.route("**/free-text-responses", (route) => {
      hits++;
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });
    const { text, created } = await exportInBrowser(page, fx1.comp.id);
    expect(hits, "the export really asked the endpoint").toBe(1);
    expect(created, "URL.createObjectURL was never called — nothing was offered for download").toBe(0);
    expect(text).toBeNull();
    const toast = page.locator("#toast-stack .toast.toast-error");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("export cancelled");
  });
});
