// v8.1.0 — PR 30: a Booth Event only ever holds challenges someone at it can answer.
//
// A Booth Event is a walk-up at a conference stand: a phone, two minutes, no
// account, no laptop. Three kinds of challenge cannot be answered there —
// `answer_type='file'`, `needs:cxone`, `needs:desktop` — and until this release
// an admin could assign all three, with the failure landing on a visitor rather
// than on the person who could have fixed it.
//
// THE INVARIANT IS A THEOREM, NOT A CONVENTION, and that is what these tests are
// really pinning. Six write paths can create the bad state, and guarding only the
// obvious three (the assign routes) leaves REORDERING wide open: assign an
// ordinary text challenge, then edit it to `file`, or tag it `needs:desktop`, or
// overwrite it through the importer. Because all six move together, the
// PARTICIPANT surface needs no filter at all — which is the property the last
// test in this file asserts directly.
//
// Every fixture owns its own event, challenges and participants (fixture
// checklist item 2/3), and no test here lets one participant solve everything, so
// the all-solved auto-end cannot end an event underneath an assertion.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `br${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A live event of the given kind, owned by this test. */
async function makeEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`,
      event_kind: kind,
      start_time: new Date(Date.now() - 3600e3).toISOString(),
      timezone: "UTC",
      ...(kind === "program"
        ? { deadline_at: new Date(Date.now() + 86400e3).toISOString() }
        : { duration_minutes: 600 }),
      ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

/** A published challenge, optionally with tags. */
async function makeTask(api, csrf, { answer_type = "text", tags = [] } = {}) {
  const title = `${uniq()} T`;
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title, description: "d", difficulty: "easy", answer_type, correct_answer: "right", status: "published" },
  });
  expect(r.ok(), `create task: ${await r.text()}`).toBeTruthy();
  // Take the id the create RETURNS — resolving by title matches a challenge an
  // earlier test in this same file made (the v8.1.0 fixture trap).
  const { id } = await r.json();
  expect(id, "the create returns the new challenge's id").toBeTruthy();
  for (const t of tags) {
    const tr = await api.post(`/api/admin/tasks/${id}/tags`, { headers: H(csrf), data: { tag: t } });
    expect(tr.ok(), `tag ${t}: ${await tr.text()}`).toBeTruthy();
  }
  return { id, title };
}

/** `copy`: the question the event now holds — its OWN copy of a bank question (lib/event-copies.js). */
async function assign(api, csrf, taskId, compId) {
  const r = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), body, copy: body.copies && body.copies[0] ? body.copies[0].task_id : null };
}

async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Booth", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} is findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email };
}

/** A signed-in participant context. */
async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function joinToken(api, csrf, compId) {
  const r = await api.get(`/api/admin/competitions/${compId}/self-enroll`);
  expect(r.ok(), `reveal token: ${await r.text()}`).toBeTruthy();
  const t = (await r.json()).token;
  expect(t, "a join token").toBeTruthy();
  return t;
}

async function join(api, csrf, token) {
  const r = await api.post("/api/competitions/join", { headers: H(csrf), data: { token } });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/**
 * One challenge as the admin list returns it.
 *
 * There is no `GET /api/admin/tasks/:id` — the admin UI renders from the LIST,
 * so reading it the same way is also the honest test of what an admin sees. The
 * first draft guessed a per-id endpoint and got the SPA shell back, which
 * surfaces as "Unexpected token '<'" and names nothing about the cause.
 */
async function taskRow(api, id) {
  const r = await (await api.get(`/api/admin/tasks?limit=500&search=${encodeURIComponent(id)}`)).json();
  const rows = r.tasks || r;
  let row = rows.find(t => t.id === id);
  if (!row) {
    const all = await (await api.get("/api/admin/tasks?limit=1000")).json();
    row = (all.tasks || all).find(t => t.id === id);
  }
  expect(row, `challenge ${id} is in the admin list`).toBeTruthy();
  return row;
}

async function compRow(api, id) {
  const list = await (await api.get("/api/admin/competitions")).json();
  return list.find(c => c.id === id);
}

test.describe("v8.1.0 — a Booth Event only holds answerable challenges", () => {
  // ── the three refusals, each with the CONTROL that makes it discriminating ──
  //
  // Without the Competition control every one of these is equally satisfied by a
  // build that refuses the challenge EVERYWHERE — a worse bug than the one being
  // fixed, and invisible to a booth-only assertion.
  for (const [what, taskOpts, expectWord] of [
    ["a FILE answer", { answer_type: "file" }, /upload/i],
    ["a needs:cxone tag", { tags: ["needs:cxone"] }, /CxOne account/i],
    ["a needs:desktop tag", { tags: ["needs:desktop"] }, /desktop/i],
  ]) {
    test(`${what} is refused at a Booth Event and ACCEPTED at a Competition`, async () => {
      const { api, csrf } = await sa();
      const task = await makeTask(api, csrf, taskOpts);

      const booth = await makeEvent(api, csrf, "booth");
      const refused = await assign(api, csrf, task.id, booth.id);
      expect(refused.status, `booth must refuse: ${JSON.stringify(refused.body)}`).toBeGreaterThanOrEqual(400);
      expect(refused.body.error).toMatch(expectWord);
      // The refusal names the KIND IN WORDS, never the stored value — the v8.1.0
      // refusal-copy rule, which is what makes it readable at a stand.
      expect(refused.body.error).toMatch(/Booth Event/);
      expect(refused.body.error, "the stored value must never surface").not.toMatch(/\bbooth\b/);

      // AND NOTHING WAS WRITTEN. A refusal that still assigned would be the
      // v7.21.19 F1 defect, and the message alone cannot tell the two apart.
      const asgd = await taskRow(api, task.id);
      const ids = (asgd.competitions || []).map(c => c.id || c.competition_id);
      expect(ids, "the refused challenge must not be assigned").not.toContain(booth.id);

      // THE CONTROL.
      const comp = await makeEvent(api, csrf, "tournament");
      const ok = await assign(api, csrf, task.id, comp.id);
      expect(ok.status, `a Competition must still accept it: ${JSON.stringify(ok.body)}`).toBe(200);
    });
  }

  test("an UNRECOGNISED need is refused too — the namespace is negative, so it fails safe", async () => {
    // The one-way door, asserted rather than described. An allow-list of known
    // needs would fail OPEN here and hand the visitor exactly the unanswerable
    // challenge this feature exists to prevent.
    const { api, csrf } = await sa();
    const booth = await makeEvent(api, csrf, "booth");

    const vpn = await makeTask(api, csrf, { tags: ["needs:vpn"] });
    const r = await assign(api, csrf, vpn.id, booth.id);
    expect(r.status, `an unknown need must still refuse: ${JSON.stringify(r.body)}`).toBeGreaterThanOrEqual(400);
    expect(r.body.error).toMatch(/vpn/i);

    // ...and an ordinary tag that merely CONTAINS the word is not a need. Without
    // this a prefix-free substring match would pass every test above while
    // refusing unrelated challenges.
    const innocent = await makeTask(api, csrf, { tags: ["cxone", "desktop-review", "needsomething"] });
    const ok = await assign(api, csrf, innocent.id, booth.id);
    expect(ok.status, `only the needs: PREFIX restricts: ${JSON.stringify(ok.body)}`).toBe(200);
  });

  test("bulk assign SKIPS the unfit one, assigns the rest, and says which", async () => {
    // This route's documented posture is best-effort, so one file challenge must
    // not sink the batch — but the count must reach the operator, or it is the
    // v7.21.2 silent-skip defect.
    const { api, csrf } = await sa();
    const good = await makeTask(api, csrf);
    const bad = await makeTask(api, csrf, { answer_type: "file" });
    const booth = await makeEvent(api, csrf, "booth");

    const r = await api.post("/api/admin/tasks/assign-competitions", {
      headers: H(csrf), data: { taskIds: [good.id, bad.id], competitionIds: [booth.id] },
    });
    expect(r.ok(), `bulk: ${await r.text()}`).toBeTruthy();
    const b = await r.json();
    expect(b.assigned, "the answerable one still lands").toBe(1);
    expect(b.skipped.unfit, "the unanswerable one is counted").toBe(1);
    expect((b.unfitReasons || []).join(" "), "and NAMED, or the admin cannot act on it").toMatch(/upload/i);
  });

  // ── the reordering guards: the half that makes it a theorem ──

  test("REORDERING is closed: a challenge already at a live Booth Event cannot be edited into an unanswerable one", async () => {
    const { api, csrf } = await sa();
    const booth = await makeEvent(api, csrf, "booth");
    const bank = await makeTask(api, csrf);
    const asg = await assign(api, csrf, bank.id, booth.id);
    expect(asg.status, "precondition: it assigns while answerable").toBe(200);
    const task = { ...bank, id: asg.copy };   // the Booth Event's own copy: the challenge "already at" it

    // (a) change the answer type
    const cur = await taskRow(api, task.id);
    const toFile = await api.put(`/api/admin/tasks/${task.id}`, {
      headers: H(csrf), data: { answer_type: "file", expectedUpdatedAt: cur.updated_at },
    });
    const toFileBody = await toFile.json().catch(() => ({}));
    expect(toFile.status(), `editing to file must be refused: ${JSON.stringify(toFileBody)}`).toBe(409);
    expect(toFileBody.error).toMatch(/upload/i);
    // The remedy it names must be one the platform ALLOWS — the v7.29.0
    // frozen-remedy trap. Unassigning from a LIVE event really does work.
    expect(toFileBody.error).toMatch(/unassign/i);

    // (b) add a needs: tag
    const tagged = await api.post(`/api/admin/tasks/${task.id}/tags`, { headers: H(csrf), data: { tag: "needs:desktop" } });
    const taggedBody = await tagged.json().catch(() => ({}));
    expect(tagged.status(), `tagging must be refused: ${JSON.stringify(taggedBody)}`).toBe(409);
    expect(taggedBody.error).toMatch(/desktop/i);
    // Nothing was written — a refusal that still tagged would leave the exact
    // state the refusal exists to prevent.
    const after = await taskRow(api, task.id);
    expect((after.tags || []).join(","), "the tag must not have landed").not.toMatch(/needs:desktop/);

    // (c) THE CONTROL, and it is what stops this being a blanket freeze: an
    // ordinary edit to the same challenge in the same event still works.
    const rename = await api.put(`/api/admin/tasks/${task.id}`, {
      headers: H(csrf), data: { title: `${task.title} renamed`, expectedUpdatedAt: after.updated_at },
    });
    expect(rename.status(), `an unrelated edit must still succeed: ${await rename.text()}`).toBe(200);
    const innocuous = await api.post(`/api/admin/tasks/${task.id}/tags`, { headers: H(csrf), data: { tag: "reviewed" } });
    expect(innocuous.status(), "an ordinary tag must still be addable").toBe(200);
  });

  test("a Competition is NOT frozen by the same edits — the guard is per-kind, not global", async () => {
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, "tournament");
    const task = await makeTask(api, csrf);
    expect((await assign(api, csrf, task.id, comp.id)).status).toBe(200);

    const cur = await taskRow(api, task.id);
    const toFile = await api.put(`/api/admin/tasks/${task.id}`, {
      headers: H(csrf), data: { answer_type: "file", expectedUpdatedAt: cur.updated_at },
    });
    expect(toFile.status(), `a Competition may hold a file challenge: ${await toFile.text()}`).toBe(200);
    const tag = await api.post(`/api/admin/tasks/${task.id}/tags`, { headers: H(csrf), data: { tag: "needs:cxone" } });
    expect(tag.status(), "and a needs: tag").toBe(200);
  });

  test("an ENDED Booth Event does not freeze the challenge — the remedy it would name is one the platform refuses", async () => {
    // THE CARVE-OUT, and it is the difference between a guard and the v7.29.0
    // frozen-competition trap. Once an event has ended, `DELETE
    // /api/admin/tasks/:id/competitions/:cid` refuses — so a refusal here would
    // tell the admin to unassign, and unassigning is exactly what they cannot do.
    // Nobody can attempt a challenge at a finished event either, so there is no
    // participant left to protect.
    //
    // Driven through the TAG path on purpose: the answer_type path is refused
    // anyway by the pre-existing ended-session scoring freeze, so it cannot tell
    // the two guards apart. Tags are not a scoring column, so only this one
    // reaches the carve-out.
    const { api, csrf } = await sa();
    // Create LIVE, assign, THEN end — an already-ended event refuses the assign
    // (fixture checklist).
    const booth = await makeEvent(api, csrf, "booth");
    const task = await makeTask(api, csrf);
    expect((await assign(api, csrf, task.id, booth.id)).status, "precondition: assigned while live").toBe(200);

    const row = await compRow(api, booth.id);
    const end = await api.post(`/api/admin/competitions/${booth.id}/end-now`, {
      headers: H(csrf), data: { expectedUpdatedAt: row.updated_at },
    });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();

    // The unassign really is refused — this is the precondition that makes the
    // carve-out necessary rather than merely convenient. Asserted, not assumed.
    const unassign = await api.delete(`/api/admin/tasks/${task.id}/competitions/${booth.id}`, { headers: H(csrf) });
    expect(unassign.status(), "unassigning from an ended event is refused, which is why we must not advise it")
      .toBeGreaterThanOrEqual(400);

    const tagged = await api.post(`/api/admin/tasks/${task.id}/tags`, { headers: H(csrf), data: { tag: "needs:desktop" } });
    expect(tagged.status(), `tagging a challenge in an ENDED booth must be allowed: ${await tagged.text()}`).toBe(200);
  });

  test("per-kind create defaults: a Booth Event arrives with its join link on and CxOne off", async () => {
    const { api, csrf } = await sa();
    const booth = await makeEvent(api, csrf, "booth");
    const comp = await makeEvent(api, csrf, "tournament");

    // A Booth Event that defaulted the way a Competition does would have no join
    // link — so the QR code the whole kind is built around would do nothing.
    const b = await compRow(api, booth.id);
    expect(b.self_enroll_enabled, "booth: join link ON").toBeTruthy();
    expect(b.cxone_disabled, "booth: no external identity per visitor").toBeTruthy();
    // THE CONTROL: the defaults are the KIND's, not new globals.
    const c = await compRow(api, comp.id);
    expect(c.self_enroll_enabled, "competition: join link OFF, unchanged").toBeFalsy();
    expect(c.cxone_disabled, "competition: CxOne ON, unchanged").toBeFalsy();
  });

  test("an EXPLICIT value always beats the kind default, in both directions", async () => {
    // `? 1 : 0` cannot express this — it collapses "absent" and "false" — so this
    // is what separates a real default from a hard-coded override.
    // EXCEPT Checkmarx One accounts on a Booth Event, which the kind FORBIDS
    // (owner's decision, 27 Nov 2026): explicitly asking for them is refused by
    // name, never stored (tests/booth-cxone-forbidden.api.spec.js holds the rest).
    const { api, csrf } = await sa();
    const boothOff = await makeEvent(api, csrf, "booth", { self_enroll_enabled: false });
    const compOn = await makeEvent(api, csrf, "tournament", { self_enroll_enabled: true, cxone_disabled: true });
    const bo = await compRow(api, boothOff.id);
    const co = await compRow(api, compOn.id);
    expect(bo.self_enroll_enabled, "explicit false on a booth").toBeFalsy();
    expect(bo.cxone_disabled, "a booth's accounts stay off").toBeTruthy();
    expect(co.self_enroll_enabled, "explicit true on a competition").toBeTruthy();
    expect(co.cxone_disabled, "explicit true on a competition").toBeTruthy();
    const refused = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `${uniq()} booth cx`, event_kind: "booth", start_time: new Date(Date.now() - 3600e3).toISOString(),
      timezone: "UTC", duration_minutes: 600, cxone_disabled: false } });
    expect(refused.status(), "accounts on, on a booth: refused").toBe(400);
    expect((await refused.json()).code).toBe("cxone_provisioning_forbidden");
  });

  // ── the property all six sites exist to make true ──

  test("the participant surface is NOT filtered, because it does not have to be", async () => {
    // The pay-off, asserted rather than assumed: every challenge a Booth Event
    // holds reaches the participant untouched. If a future change starts hiding
    // challenges at read time instead of refusing the write, the refusal tests
    // above fail first — which is the ordering that keeps the invariant where it
    // belongs.
    const { api, csrf } = await sa();
    const booth = await makeEvent(api, csrf, "booth", { self_enroll_enabled: true });
    const b1 = await makeTask(api, csrf);
    const b2 = await makeTask(api, csrf, { tags: ["category:web"] });
    const a1 = await assign(api, csrf, b1.id, booth.id), a2 = await assign(api, csrf, b2.id, booth.id);
    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    // The event's own copies are what its participants are served.
    const t1 = { ...b1, id: a1.copy }, t2 = { ...b2, id: a2.copy };

    const p = await makeParticipant(api, csrf);
    const ctx = await signIn(p.email);
    const token = await joinToken(api, csrf, booth.id);
    expect((await join(ctx.api, ctx.csrf, token)).status).toBe(200);
    const sel = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: booth.id } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();

    const tasks = await (await ctx.api.get("/api/tasks")).json();
    const ids = (tasks.tasks || tasks).map(t => t.id);
    expect(ids, "both assigned challenges reach the participant").toEqual(expect.arrayContaining([t1.id, t2.id]));
    // And `needs:` is still not participant-visible — only `category:` is
    // (v7.21.0), and that rule is one-directional.
    expect(JSON.stringify(tasks)).not.toMatch(/needs:/);
  });
});
