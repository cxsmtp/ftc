// @ts-check
//
// v7.21.22 — a slow PARTICIPANT is not a slow endpoint.
//
// Reported from a live competition:
//
//   [perf-span] slow POST /api/tasks/:id/submit
//   total_ms 1002.5, prelude_ms 1000.9, body_ms 1.61, preflight_ms 0.40,
//   txn_ms 0.52, autoend_ms 0.00, postcommit_ms 0.69, outcome new_correct
//
// Every server stage is sub-2 ms and the whole second sits in `prelude_ms`,
// which is measured from `req._perfT0` — stamped when the request HEADERS
// arrive. So it included the time the server spent waiting for the participant
// to finish sending their answer. The warning said the endpoint was slow; the
// endpoint had done 1.6 ms of work.
//
// That matters beyond tidiness: during a real event on venue Wi-Fi this fires
// constantly, and a WARN that cries wolf every time someone's connection dips is
// how an operator learns to ignore the one signal that would have told them the
// server was genuinely in trouble.
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, PARTICIPANT_PASS, BASE, TEST_DATA_DIR } = require("./helpers");
const http = require("http");
const fs = require("fs");
const path = require("path");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** Every perf-span line for the submit route currently on disk. */
function submitSpans() {
  const dir = path.join(TEST_DATA_DIR, "logs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith("app-"))
    .flatMap(f => fs.readFileSync(path.join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(j => j && typeof j.msg === "string" && j.msg.includes("perf-span") && j.msg.includes("submit")
                 && j.endpoint === "POST /api/tasks/:id/submit");
}

/** The seeded live competition. */
async function liveCompId() {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const live = comps.find(c => c.name === "Test Live");
    expect(live, "the seeded live competition").toBeTruthy();
    return live.id;
  } finally { await sa.dispose(); }
}

/** A published FILE-answer challenge on the live competition. */
async function createFileTask(compId) {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const r = await api.post("/api/admin/tasks", {
      headers: h(csrf),
      data: {
        title: `PerfSpan File ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "file", correct_answer: "the-right-bytes", status: "published",
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const id = (await r.json()).id;
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: h(csrf), data: { competitionIds: [compId] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
    return id;
  } finally { await api.dispose(); }
}

/**
 * A participant signed into the live competition.
 *
 * `taskId` picks a specific challenge (the file-answer one for the server-slow
 * control); otherwise any unsolved challenge will do.
 */
async function participantOnATask(taskId) {
  const comp = await liveCompId();
  const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: comp } });
  let task;
  if (taskId) { task = { id: taskId }; }
  else {
    const payload = await (await api.get("/api/tasks")).json();
    const tasks = payload.tasks || payload;
    task = tasks.find(t => !t.solved) || tasks[0];
    expect(task, "a task to submit against").toBeTruthy();
  }
  const gradingHash = await gradingHashFor(api, task.id);
  const state = await api.storageState();
  const cookie = (state.cookies || []).map(c => `${c.name}=${c.value}`).join("; ");
  return { api, csrf, task, gradingHash, cookie, comp };
}

/**
 * POST a submit whose HEADERS arrive now and whose BODY arrives `delayMs` later.
 *
 * `flushHeaders()` is the whole experiment: without it the client buffers and
 * sends headers and body together, the server never waits, and the test measures
 * nothing (that was the first draft, and it produced no span at all).
 */
function slowBodySubmit({ taskId, body, csrf, cookie, delayMs }) {
  const url = new URL(BASE);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, method: "POST",
      path: `/api/tasks/${taskId}/submit`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "x-csrf-token": csrf, cookie,
      },
    }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => req.end(payload), delayMs);
  });
}


/**
 * Drive one slow-body submit and return the span it produced — RE-SAMPLING while
 * the box was too busy for the sample to mean anything.
 *
 * v8.3.31 — measured over a 60-run sweep, this was the suite's dominant flake
 * (3 of the 4 red runs). The platform is RIGHT and the test's premise was the
 * weak half: `serverMs = total - max(0, clientBodyMs - loopBlockedMs)`, and on a
 * saturated box the server PROCESS is descheduled, which the 20 Hz drift counter
 * reads as a blocked loop — indistinguishable, by construction, from the server
 * blocking its own loop. The excusal then shrinks and the client's second is
 * correctly re-attributed to the server. Captured from a real failing span:
 *
 *   total_ms 1021.3  client_body_ms 1016.0  loop_blocked_ms 880.7  server_ms 885.9
 *
 * So a sample taken while the loop could not run says nothing about ATTRIBUTION,
 * which is what these two tests are about. It is re-sampled, not tolerated: the
 * assertions that follow are unchanged and still fail on a build that stopped
 * attributing (a quiet box yields loop_blocked_ms ~0, so the retry never fires
 * and the sample is always taken).
 */
async function sampleSlowClientSpan(p, answer) {
  const CONTAMINATED_MS = 150;
  let span = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const before = submitSpans().length;
    const status = await slowBodySubmit({
      taskId: p.task.id, csrf: p.csrf, cookie: p.cookie, delayMs: 1000,
      body: { answer: `${answer}-${attempt}`, gradingHash: p.gradingHash },
    });
    expect(status, "the submission itself must still succeed").toBe(200);
    await expect.poll(() => submitSpans().length, { timeout: 8000, intervals: [100, 200, 400, 800] })
      .toBeGreaterThan(before);
    span = submitSpans().slice(-1)[0];
    if (Number(span.loop_blocked_ms || 0) <= CONTAMINATED_MS) return span;
    // Give the box a moment to drain before re-sampling.
    await new Promise(r => setTimeout(r, 500));
  }
  // Never a silent pass: if the loop was blocked on every attempt this machine
  // could not schedule the server, and that is the finding to report.
  throw new Error(
    `could not take an uncontended sample in 4 attempts — the server's event loop was ` +
    `blocked for ${span && span.loop_blocked_ms}ms of a 1000ms client wait, so this box ` +
    `cannot measure client-vs-server attribution right now (span: ${JSON.stringify(span)})`);
}

test.describe("v7.21.22 — perf-span attributes client time to the client", () => {
  test("a slow participant body is reported as a CLIENT upload, not a slow endpoint", async () => {
    const p = await participantOnATask();
    try {
      const span = await sampleSlowClientSpan(p, "deliberately-wrong-answer");

      // THE FINDING. Before the fix this was a WARN saying the endpoint was slow,
      // with the whole second inside prelude_ms.
      expect(span.msg, "a slow CLIENT must not be reported as a slow endpoint")
        .not.toMatch(/slow POST \/api\/tasks/);
      expect(span.msg, "…it is reported as what it is").toMatch(/slow CLIENT upload/i);
      expect(span.level, "…and at info, not warn — the server did nothing wrong").toBe("info");

      // The wait is attributed, and the server's own share is honest.
      expect(Number(span.client_body_ms), "the client's second is measured and named")
        .toBeGreaterThan(500);
      expect(Number(span.server_ms), "the server share excludes it")
        .toBeLessThan(300);
      expect(Number(span.prelude_ms), "prelude no longer carries the client's transmission time")
        .toBeLessThan(300);
      // The total is still the honest wall clock — nothing is hidden, only split.
      expect(Number(span.total_ms), "the wall clock is still reported")
        .toBeGreaterThan(Number(span.server_ms));
    } finally { await p.api.dispose(); }
  });

  test("the span says WHO and from WHERE — not just which route", async () => {
    // Reported after v7.21.22: "quite a lot of" slow-CLIENT lines, none of them
    // attributed. On a shared venue address "somebody's upload was slow" is not
    // actionable — the operator needs whose, and from which address, before they
    // can do anything about it. The access log has carried this since v6.16.19;
    // the perf spans carried none of it.
    const p = await participantOnATask();
    try {
      const span = await sampleSlowClientSpan(p, "attributed-wrong-answer");
      expect(span.msg, "this is the slow-CLIENT line").toMatch(/slow CLIENT upload/i);
      expect(span.ip, "the address the report said was missing").toBeTruthy();
      expect(span.user_id, "…and the participant").toBeTruthy();
      expect(span.email, "…by email, as the access log does").toBe("alice@acme.com");
      // req_id is the join key into access-*.jsonl, and it must still be there.
      expect(span.req_id).toBeTruthy();
    } finally { await p.api.dispose(); }
  });

  test("an ordinary fast submit logs no perf-span at all", async () => {
    // POSITIVE CONTROL for the threshold: without it, "no WARN" is equally
    // satisfied by instrumentation that stopped logging.
    const before = submitSpans().length;
    const p = await participantOnATask();
    try {
      const r = await p.api.post(`/api/tasks/${p.task.id}/submit`, {
        headers: h(p.csrf), data: { answer: "another-wrong-answer", gradingHash: p.gradingHash },
      });
      expect(r.status(), await r.text()).toBe(200);
      await new Promise(res => setTimeout(res, 400));
      expect(submitSpans().length, "a fast submit is not worth a line").toBe(before);
    } finally { await p.api.dispose(); }
  });

  test("a BLOCKED EVENT LOOP is not excused as a slow client", async () => {
    // The one way the v7.21.22 split could hide a real problem, and the reason
    // v7.21.23 exists.
    //
    // The server cannot read a socket while its loop is blocked, so a
    // synchronous stall — a long better-sqlite3 statement, a resvg rasterise —
    // delays the body's 'end' event in exactly the same way a weak network does.
    // Excusing that would mean the single worst failure mode of a single-process
    // server became the one thing this instrumentation stopped reporting.
    //
    // So: a real stall, landed inside a real slow-body upload. The body arrives
    // no later than it would have anyway; the ONLY difference from the first
    // test is that the wait is the server's fault. It must WARN.
    const before = submitSpans().length;
    const p = await participantOnATask();
    try {
      const blk = await p.api.post("/api/test/block-loop", { headers: h(p.csrf), data: { afterMs: 120, blockMs: 900 } });
      expect(blk.ok(), "the test-only block hook is available").toBeTruthy();

      const status = await slowBodySubmit({
        taskId: p.task.id, csrf: p.csrf, cookie: p.cookie, delayMs: 200,
        body: { answer: "wrong-under-a-stall", gradingHash: p.gradingHash },
      });
      expect(status, await Promise.resolve("the submission still succeeds")).toBe(200);

      await expect.poll(() => submitSpans().length, { timeout: 10000, intervals: [100, 200, 400, 800] })
        .toBeGreaterThan(before);
      const span = submitSpans().slice(-1)[0];

      expect(Number(span.loop_blocked_ms), "the stall is measured, not inferred").toBeGreaterThan(300);
      expect(Number(span.client_body_ms), "…inside the body window, which does look slow")
        .toBeGreaterThan(500);
      // THE POINT. Wall clock identical in shape to the excused case; verdict opposite.
      expect(span.level, "a stall the SERVER caused is a WARNING, not an excused client").toBe("warn");
      expect(span.msg).toMatch(/slow POST \/api\/tasks/);
      expect(Number(span.server_ms), "…and the stalled time counts against the server")
        .toBeGreaterThan(300);
    } finally { await p.api.dispose(); }
  });

  test("a genuinely slow SERVER still warns", async () => {
    // The signal the WARN exists for must survive the fix. The test-only
    // submit-read hook parks the handler INSIDE the file branch, which is real
    // server time — so this is the other side of the split, not a simulation of
    // it, and it proves the threshold still fires on the thing that matters.
    const fileTask = await createFileTask(await liveCompId());
    const before = submitSpans().length;
    const p = await participantOnATask(fileTask);
    try {
      const set = await p.api.post("/api/test/submit-read-delay", { headers: h(p.csrf), data: { delayMs: 700 } });
      expect(set.ok(), "the test-only delay hook is available").toBeTruthy();

      const r = await p.api.post(`/api/tasks/${p.task.id}/submit`, {
        headers: { "x-csrf-token": p.csrf },
        multipart: {
          gradingHash: p.gradingHash,
          file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("still-wrong") },
        },
      });
      expect(r.status(), await r.text()).toBe(200);

      await expect.poll(() => submitSpans().length, { timeout: 8000, intervals: [100, 200, 400, 800] })
        .toBeGreaterThan(before);
      const span = submitSpans().slice(-1)[0];
      expect(span.level, "real server slowness is still a WARNING").toBe("warn");
      expect(span.msg).toMatch(/slow POST \/api\/tasks/);
      expect(Number(span.server_ms), "…and the server share is what tripped it").toBeGreaterThan(300);
      expect(span.file_upload, "the file branch is what was exercised").toBe(true);
    } finally {
      await p.api.post("/api/test/submit-read-delay", { headers: h(p.csrf), data: { delayMs: 0 } }).catch(() => {});
      await p.api.dispose();
    }
  });
});
