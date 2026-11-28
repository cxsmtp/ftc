// v7.29.0 — the frozen-competition remedy must be one a caller can actually take.
//
// Five server error strings, a client dialog note, both user guides and a swagger
// description all ended "unassign it from that competition first" — and
// DELETE /api/admin/tasks/:id/competitions/:cid refuses exactly that once a
// session has ended. It is not usually wrong, it is ALWAYS wrong: the advice
// predicate implies the unassign predicate, so the step can never succeed.
//
// It shipped for four releases with a fully green suite, because every existing
// lock stops at the status code and the first clause. Not one asserted the advice.
// That is the whole reason this file exists.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { freshCtx, apiLogin } = require("./helpers");

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test.describe("v7.29.0 — the frozen-competition remedy", () => {
  test("a refusal names a remedy the caller can take, and never the one that is refused", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();

    // A competition that has ALREADY ended (time-expired single slot), with a
    // published challenge assigned — the exact state the freeze exists for.
    const cr = await api.post("/api/admin/competitions", {
      headers: h(csrf),
      data: {
        // LIVE while we assign — the assign path is frozen too, so a competition
        // that has already ended cannot be built into this state from outside.
        name: `Frozen ${stamp}`,
        start_time: new Date(Date.now() - 3600_000).toISOString(),
        duration_minutes: 600, timezone: "UTC",
      },
    });
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const compId = (await cr.json()).competition.id;

    const tr = await api.post("/api/admin/tasks", {
      headers: h(csrf),
      data: { title: `Frozen task ${stamp}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
    });
    expect(tr.ok(), `create task: ${tr.status()} ${await tr.text()}`).toBeTruthy();
    const bankId = (await tr.json()).id || (await (await api.get("/api/admin/tasks")).json()).find(t => t.title === `Frozen task ${stamp}` && !t.owner_competition_id)?.id;
    expect(bankId, "the challenge exists").toBeTruthy();

    const asg = await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: h(csrf), data: { competitionIds: [compId] } });
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    const taskId = (await asg.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): the one the end freezes

    // NOW end it, which is what arms the freeze.
    const end = await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(csrf), data: {} });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();

    // The refusal an admin actually meets.
    const vis = await api.patch(`/api/admin/tasks/${taskId}/visibility`, { headers: h(csrf), data: { active: 0 } });
    expect(vis.status(), "the freeze still refuses").toBe(409);
    const msg = (await vis.json()).error;

    // THE ASSERTION THAT WAS MISSING FOR FOUR RELEASES.
    expect(msg, "the refusal must not send the caller to a step the platform refuses").not.toMatch(/unassign/i);
    expect(msg, "it must say WHO can act — reopening is superadmin-only").toMatch(/superadmin/i);
    expect(msg, "and that one reopened session is not enough").toMatch(/every finished session/i);

    // And the named remedy really is refused, which is what makes the old advice
    // a wrong answer rather than merely a vague one.
    const un = await api.delete(`/api/admin/tasks/${taskId}/competitions/${compId}`, { headers: h(csrf) });
    expect([400, 409]).toContain(un.status());
    await api.dispose();
  });

  // The behavioural test above reaches ONE of the five sites. This covers the
  // other four plus the client note, both guides and swagger — eleven places the
  // same sentence shipped, of which the plan had found five.
  test("no shipped copy anywhere tells an operator to unassign from a frozen competition", () => {
    const root = path.join(__dirname, "..");
    const files = [
      "routes/challenges.js",
      "public/js/features/challenges-admin.js",
      "docs/user-guide/admin.md",
      "docs/user-guide/superadmin.md",
      "swagger.yaml",
    ];
    // Strip JS comments so the note explaining this fix cannot satisfy — or
    // trip — its own scanner (the v7.15.15 lesson; this patch's own comment
    // quotes the retired sentence verbatim).
    const stripJs = src => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "));
    const offenders = [];
    for (const f of files) {
      let src = fs.readFileSync(path.join(root, f), "utf8");
      if (f.endsWith(".js")) src = stripJs(src);
      src.split("\n").forEach((line, i) => {
        // "unassign" within a sentence about a frozen / ended event.
        // A line that says unassigning IS REFUSED is the correct copy — it is the
        // advice to DO it that can never succeed. Without this clause the scanner
        // is red against the very sentences this patch introduced, and a scanner
        // that is wrong about working code gets silenced by whoever hits it next.
        if (/unassign/i.test(line) && /frozen|ended session|finished competition|finished event|standings/i.test(line) && !/refus/i.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders,
      "unassigning is REFUSED once a session has ended, so advice to do it can never succeed. " +
      "Say who can reopen the competition instead."
    ).toEqual([]);
  });
});
