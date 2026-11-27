// @ts-check
//
// v8.12.6 — A SEALED DISCLOSURE THAT CANNOT BE RECORDED IS NOT MADE.
//
// v8.12.2 made a superadmin's read of a sealed challenge a RECORDED act: the
// explicit reveal route writes the History row before it sets the marker, and
// refuses on failure. The PARTICIPANT surface is the other door — there the
// open IS the reveal — and both of its record sites wrapped the History write
// in `try { … } catch (_) {}` and shipped the sealed values anyway:
//
//   • GET /api/tasks/:id — the end-of-event reveal (answer + explanation +
//     hint), the choice-solver concession (the correct ids) and a paid hint
//     re-read, all delivered with no `sealed_reveal` row behind them;
//   • POST /api/tasks/:id/hint — the record ran AFTER the `hint_reveals`
//     INSERT, so a SELECTIVE failure (the version write refused, the hint row
//     accepted) left the hint shown and the deduction taken — under
//     impersonation, from the TARGET — with no row in the challenge's History.
//     (The deduction itself was always in user_events / competition_events;
//     what was missing was the History record of the disclosure.)
//
// TWO WAYS TO FAIL THE RECORD, and they see different defects:
//
//   • An ABORT trigger on `task_versions` (the way the record-before-marker lock
//     in sealed-reveal.api.spec.js injects it) is SELECTIVE and PERSISTENT — it
//     is what proves the fail-closed paths.
//   • A TRANSIENT external write lock (`BEGIN IMMEDIATE` on the test database
//     from this worker, released once the server is seen WAITING on it) is what
//     a short `scripts/purge.sh --apply` or an operator's sqlite3 session
//     produces. The record's transaction used to be DEFERRED — it reads before
//     it writes — and under WAL a read→write upgrade gets SQLITE_BUSY at once
//     from an external writer, busy_timeout never consulted. So a brief lock
//     failed it in milliseconds: before this release the GET leaked, and with
//     the record moved in front of the hint INSERT the fresh reveal would have
//     503'd a superadmin for nothing. `.immediate` (lib/audit.js) takes the lock
//     first, so busy_timeout applies — and these arms are its only lock, which
//     is why each one PROVES its request contended (withTransientLock).
//
// Every withheld arm is paired with the SAME request once the store works — the
// values ship and exactly one record lands — or "nothing was shown" is satisfied
// by a build that stopped showing superadmins anything. Secrets are distinctive
// strings asserted BY VALUE over the whole response.
const { test, expect } = require("./isolated-test");
const path = require("path");
const fs = require("fs");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, findLogLine, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, assignTask, enrol } = require("./event-admin-helpers");

function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}
const dbGet = (sql, ...a) => withDb(db => db.prepare(sql).get(...a));
const dbExec = sql => withDb(db => db.exec(sql), { readonly: false });
const revealRows = id => dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", id).c;
const hintRows = (uid, tid) => dbGet("SELECT COUNT(*) c FROM hint_reveals WHERE user_id=? AND task_id=?", uid, tid).c;
const hintEvents = (uid, tid) => dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='hint_revealed' AND details LIKE ?", uid, `%${tid}%`).c;
const tag = l => uniq(l).replace(/[^a-zA-Z0-9]/g, "");

// The ONLY operator-facing signal that the History store is failing is a
// request-scoped error line — so it is asserted, not assumed (a build that
// withholds silently would leave an operator nothing to act on).
const unrecordedLine = (taskId, re) => findLogLine(path.join(TEST_DATA_DIR, "logs"),
  j => j.level === "error" && j.task_id === taskId && re.test(j.msg || ""),
  { what: `the unrecorded-reveal error line for ${taskId}` });

/** Run `fn` with the History write for `taskId` failing; the trigger is ALWAYS dropped. */
async function withRecordFailing(taskId, fn) {
  const trig = `zz_f3_${taskId.replace(/[^a-zA-Z0-9]/g, "")}`;
  dbExec(`CREATE TRIGGER ${trig} BEFORE INSERT ON task_versions WHEN NEW.change_type='sealed_reveal' AND NEW.task_id='${taskId}' BEGIN SELECT RAISE(ABORT,'injected'); END;`);
  try {
    expect(dbGet("SELECT 1 x FROM sqlite_master WHERE type='trigger' AND name=?", trig), "precondition: the failure is really armed").toBeTruthy();
    return await fn();
  } finally { dbExec(`DROP TRIGGER IF EXISTS ${trig}`); }
}

// The transient external write lock (withTransientLock, expectContended) and
// why it is released only once the server is seen parked: tests/transient-lock.js.
const { withTransientLock, expectContended } = require("./transient-lock");

async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${li.status()} ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}
async function makeTier(sa, saCsrf, label, role) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { ...p, ...(await signIn(p.email)) };
}
/** A sealed challenge (with explanation AND hint) by `owner`, plus an unsealed twin. */
async function makePair(owner, T, type = "text") {
  const mk = async (sealed) => {
    const base = {
      title: uniq(sealed ? `F3 sealed ${T}` : `F3 open ${T}`), description: "<p>d</p>", difficulty: "easy",
      explanation: `<p>${sealed ? "SEALWHY" : "OPENWHY"}_${T}</p>`, hint: `<p>${sealed ? "SEALHINT" : "OPENHINT"}_${T}</p>`,
      status: "published", ...(sealed ? { answer_sealed: true } : {}),
    };
    const data = type === "choice"
      ? { ...base, answer_type: "choice", choices: [{ text: `RIGHT_${T}`, correct: true }, { text: `WRONG_${T}`, correct: false }] }
      : { ...base, answer_type: "text", correct_answer: `${sealed ? "SEALKEY" : "OPENKEY"}_${T}` };
    const r = await owner.api.post("/api/admin/tasks", { headers: H(owner.csrf), data });
    expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).id;
  };
  return { sealedId: await mk(true), openId: await mk(false) };
}
async function asParticipantView(ctx, compId) {
  const t = await ctx.api.post("/api/toggle-admin-view", { headers: H(ctx.csrf), data: { mode: "participant" } });
  expect(t.ok(), `toggle: ${t.status()} ${await t.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  const s = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
  expect(s.ok(), `select: ${s.status()} ${await s.text()}`).toBeTruthy();
}
async function impersonate(ctx, targetId, compId) {
  const i = await ctx.api.post(`/api/admin/participants/${targetId}/impersonate`, { headers: H(ctx.csrf) });
  expect(i.ok(), `impersonate: ${i.status()} ${await i.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  const s = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
  expect(s.ok(), `select: ${s.status()} ${await s.text()}`).toBeTruthy();
}
const expectNoSealed = (txt, T, who) => {
  expect(txt, `${who}: no sealed key`).not.toContain(`SEALKEY_${T}`);
  expect(txt, `${who}: no sealed explanation`).not.toContain(`SEALWHY_${T}`);
  expect(txt, `${who}: no sealed hint`).not.toContain(`SEALHINT_${T}`);
};

let sa, saCsrf, author, stander, target;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  author = await makeTier(sa, saCsrf, "f3author", "admin");
  stander = await makeParticipant(sa, saCsrf, "f3stander");
  target = await makeParticipant(sa, saCsrf, "f3target");
});
test.afterAll(async () => {
  try { await author?.api?.dispose(); } catch (_) {}
  try { await sa?.dispose(); } catch (_) {}
});

/** An ENDED event with answer reveal on, holding a fresh sealed pair by `owner`. */
async function endedWorld(label, owner = author) {
  const T = tag(label);
  const { sealedId: sealedBank, openId: openBank } = await makePair(owner, T);
  const comp = await makeCompetition(sa, saCsrf, label, { reveal_answers_on_end: true });
  // The event's OWN copies (lib/event-copies.js): what its participants read and
  // buy hints on, and so where every reveal is recorded.
  const sealedId = (await assignTask(owner.api, owner.csrf, sealedBank, [comp.id])).copies[0].task_id;
  const openId = (await assignTask(owner.api, owner.csrf, openBank, [comp.id])).copies[0].task_id;
  await enrol(sa, saCsrf, comp.id, [stander.id, target.id]);
  const e = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf) });
  expect(e.ok(), `end-now: ${await e.text()}`).toBeTruthy();
  return { T, sealedId, openId, comp };
}
/** A LIVE event (two enrollees who never solve keep the all-solved auto-end from firing). */
async function liveWorld(label, type) {
  const T = tag(label);
  const { sealedId: sealedBank, openId: openBank } = await makePair(author, T, type);
  const comp = await makeCompetition(sa, saCsrf, label);
  // The event's OWN copies (lib/event-copies.js): what its participants read and
  // buy hints on, and so where every reveal is recorded.
  const sealedId = (await assignTask(author.api, author.csrf, sealedBank, [comp.id])).copies[0].task_id;
  const openId = (await assignTask(author.api, author.csrf, openBank, [comp.id])).copies[0].task_id;
  await enrol(sa, saCsrf, comp.id, [stander.id, target.id]);
  return { T, sealedId, openId, comp };
}

test.describe("v8.12.6 — the end-of-event reveal to a superadmin is withheld when it cannot be recorded", () => {

  test("own participant view: answer, explanation and hint are all withheld WITH the reason, nothing is recorded, the operator is told — and the same read ships all three, on the record, once the History write works (CONTROL)", async () => {
    const W = await endedWorld("f3gv");
    const boss = await makeTier(sa, saCsrf, "f3gvboss", "superadmin");
    try {
      await asParticipantView(boss, W.comp.id);
      await withRecordFailing(W.sealedId, async () => {
        const r = await boss.api.get(`/api/tasks/${W.sealedId}`);
        expect(r.status(), "an audit failure never turns a read into a 5xx").toBe(200);
        const txt = await r.text();
        expectNoSealed(txt, W.T, "unrecordable read");
        const j = JSON.parse(txt);
        for (const k of ["correct_answer", "explanation", "hint"]) expect(k in j, `${k} is DELETED, not blanked`).toBe(false);
        expect(j.answer_sealed_withheld, "the Solution box says why").toBe(true);
        expect(j.answer_withheld_reason).toBe("unrecorded");
        expect(j.hint_withheld).toBe(true);
        expect(j.hint_withheld_reason).toBe("unrecorded");
        expect(j.hint_available, "nothing to buy while it cannot be recorded").toBe(false);
        expect(revealRows(W.sealedId), "no record, and no disclosure").toBe(0);
        const ln = await unrecordedLine(W.sealedId, /sealed reveal could not be recorded/);
        expect(ln.req_id, "the line joins the access log on req_id").toBeTruthy();
        expect(ln.ip, "…names where the request came from").toBeTruthy();
        expect(ln.by, "…and WHO was refused — reqContext alone names nobody outside impersonation").toBe(boss.email);
        expect(ln.fields, "…and which fields were withheld").toEqual(expect.arrayContaining(["correct_answer", "explanation", "hint"]));
        // CONTROL, and ITS ORDER MATTERS: the trigger is scoped to the SEALED id,
        // so this read can only be affected by a process-wide "the store is
        // down" flag the sealed read above might have set. Reordering it before
        // the sealed read would make it vacuous.
        const o = await (await boss.api.get(`/api/tasks/${W.openId}`)).text();
        expect(o, "the unsealed twin is untouched by a failing SEALED record").toContain(`OPENKEY_${W.T}`);
        expect(o).toContain(`OPENHINT_${W.T}`);
      });
      // CONTROL — the identical read once the record store works.
      const ok = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).text();
      expect(ok, "shown on the record").toContain(`SEALKEY_${W.T}`);
      expect(ok).toContain(`SEALWHY_${W.T}`);
      expect(ok).toContain(`SEALHINT_${W.T}`);
      expect(JSON.parse(ok).answer_withheld_reason).toBeUndefined();
      expect(JSON.parse(ok).hint_withheld).toBeUndefined();
      expect(revealRows(W.sealedId), "…and recorded").toBe(1);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });

  test("impersonating a participant: the same read is withheld under a failing record, and shown with `impersonated_by` once it works (CONTROL)", async () => {
    const W = await endedWorld("f3gi");
    const boss = await makeTier(sa, saCsrf, "f3giboss", "superadmin");
    try {
      await impersonate(boss, target.id, W.comp.id);
      await withRecordFailing(W.sealedId, async () => {
        const r = await boss.api.get(`/api/tasks/${W.sealedId}`);
        expect(r.status()).toBe(200);
        const txt = await r.text();
        expectNoSealed(txt, W.T, "impersonated unrecordable read");
        const j = JSON.parse(txt);
        expect(j.answer_withheld_reason).toBe("unrecorded");
        expect(j.hint_withheld_reason).toBe("unrecorded");
        expect(revealRows(W.sealedId)).toBe(0);
      });
      const ok = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).text();
      expect(ok).toContain(`SEALKEY_${W.T}`);
      const rec = dbGet("SELECT details FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", W.sealedId);
      expect(JSON.parse(rec.details)).toMatchObject({ via: "participant_view", impersonated_by: boss.email });
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });

  test("CONTROL — the AUTHOR's own participant view is no disclosure and is unaffected by a failing record store", async () => {
    // Its OWN author, so nothing here disturbs the shared author's session.
    const own = await makeTier(sa, saCsrf, "f3ownauthor", "admin");
    try {
      const W = await endedWorld("f3ga", own);
      await asParticipantView(own, W.comp.id);
      await withRecordFailing(W.sealedId, async () => {
        const txt = await (await own.api.get(`/api/tasks/${W.sealedId}`)).text();
        expect(txt, "the author reads their own key").toContain(`SEALKEY_${W.T}`);
        expect(txt).toContain(`SEALWHY_${W.T}`);
        expect(txt).toContain(`SEALHINT_${W.T}`);
        const j = JSON.parse(txt);
        expect(j.answer_withheld_reason).toBeUndefined();
        expect(j.hint_withheld).toBeUndefined();
      });
      expect(revealRows(W.sealedId), "the author's read is not a disclosure — nothing to record").toBe(0);
    } finally { try { await own.api.dispose(); } catch (_) {} }
  });

  test("the choice solver's marked options: a superadmin who solved a sealed choice challenge is not sent the correct ids while the record fails, and is sent them on the record once it works (CONTROL)", async () => {
    const W = await liveWorld("f3mc", "choice");
    const boss = await makeTier(sa, saCsrf, "f3mcboss", "superadmin");
    try {
      await asParticipantView(boss, W.comp.id);
      const d = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).json();
      const right = d.choices.find(c => c.text === `RIGHT_${W.T}`);
      const sub = await boss.api.post(`/api/tasks/${W.sealedId}/submit`, { headers: H(boss.csrf), data: { answer: JSON.stringify([right.id]), gradingHash: d.grading_hash } });
      expect((await sub.json()).correct, "precondition: solved").toBe(true);
      await withRecordFailing(W.sealedId, async () => {
        const j = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).json();
        expect("correct_answer" in j).toBe(false);
        expect(j.answer_sealed_withheld).toBe(true);
        expect(j.answer_withheld_reason).toBe("unrecorded");
        expect(revealRows(W.sealedId)).toBe(0);
      });
      const j = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).json();
      expect(j.correct_answer, "CONTROL: marked, on the record").toContain(right.id);
      expect(j.answer_withheld_reason).toBeUndefined();
      expect(revealRows(W.sealedId)).toBe(1);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });
});

test.describe("v8.12.6 — the hint POST records BEFORE it shows or charges anything", () => {

  test("own participant view: a failing record answers 503 `answer_seal_reveal_unrecorded`, says why, writes no hint_reveals row, charges nothing and is logged — and the retry is a real reveal (CONTROL)", async () => {
    const W = await liveWorld("f3hp");
    const boss = await makeTier(sa, saCsrf, "f3hpboss", "superadmin");
    try {
      await asParticipantView(boss, W.comp.id);
      await withRecordFailing(W.sealedId, async () => {
        const r = await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) });
        const txt = await r.text();
        expect(r.status(), txt).toBe(503);
        expect(txt).not.toContain(`SEALHINT_${W.T}`);
        const j = JSON.parse(txt);
        expect(j.code).toBe("answer_seal_reveal_unrecorded");
        expect(j.reason).toBe("unrecorded");
        expect(j.error, "the refusal says what happened — the client toasts it verbatim").toMatch(/recorded/);
        expect(j.error, "…and that nothing was charged").toMatch(/no points were deducted/);
        const ln = await unrecordedLine(W.sealedId, /hint reveal could not be recorded/);
        expect(ln.req_id).toBeTruthy();
        expect(ln.ip).toBeTruthy();
        expect(ln.by).toBe(boss.email);
        expect(hintRows(boss.id, W.sealedId), "refused BEFORE the hint_reveals write").toBe(0);
        expect(hintEvents(boss.id, W.sealedId), "…so no deduction was recorded either").toBe(0);
        expect(revealRows(W.sealedId)).toBe(0);
      });
      const ok = await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      expect((await ok.json()).hint).toContain(`SEALHINT_${W.T}`);
      expect(hintRows(boss.id, W.sealedId)).toBe(1);
      expect(revealRows(W.sealedId), "the retry records").toBe(1);

      // …and a PAID row changes nothing about the rule: the GET re-read and the
      // POST re-fetch both carry the hint, so both are withheld while the record fails.
      await withRecordFailing(W.sealedId, async () => {
        const g = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).text();
        expect(g).not.toContain(`SEALHINT_${W.T}`);
        const gj = JSON.parse(g);
        expect(gj.hint_revealed, "precondition: the row really is paid").toBe(true);
        expect(gj.hint_withheld).toBe(true);
        expect(gj.hint_withheld_reason).toBe("unrecorded");
        const p = await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) });
        expect(p.status()).toBe(503);
        expect(await p.text()).not.toContain(`SEALHINT_${W.T}`);
        expect(hintRows(boss.id, W.sealedId), "no second row").toBe(1);
        expect(revealRows(W.sealedId)).toBe(1);
      });
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });

  test("impersonating a participant: a failing record charges the TARGET nothing (CONTROL: the working record charges them, and that deduction names the impersonator)", async () => {
    const W = await liveWorld("f3hi");
    const boss = await makeTier(sa, saCsrf, "f3hiboss", "superadmin");
    try {
      await impersonate(boss, target.id, W.comp.id);
      await withRecordFailing(W.sealedId, async () => {
        const r = await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) });
        expect(r.status(), await r.text()).toBe(503);
        expect(hintRows(target.id, W.sealedId), "the target is not charged for an unrecorded disclosure").toBe(0);
        expect(hintEvents(target.id, W.sealedId)).toBe(0);
        expect(revealRows(W.sealedId)).toBe(0);
      });
      const ok = await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      expect(hintRows(target.id, W.sealedId), "CONTROL: a recorded reveal is a real paid row").toBe(1);
      expect(revealRows(W.sealedId)).toBe(1);
      // The deduction was ALWAYS recorded on the target's own history — what the
      // defect lost was the challenge-History row. Pinned so neither claim drifts.
      const ev = dbGet("SELECT details FROM user_events WHERE user_id=? AND event_type='hint_revealed' AND details LIKE ?", target.id, `%${W.sealedId}%`);
      expect(ev, "the target's deduction is on their history").toBeTruthy();
      expect(JSON.parse(ev.details).impersonated_by, "…naming who made it").toBe(boss.email);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });

  test("the SOLVER's free hint is refused too while the record fails, and returned free once it works (CONTROL)", async () => {
    const W = await liveWorld("f3hs");
    const boss = await makeTier(sa, saCsrf, "f3hsboss", "superadmin");
    try {
      await asParticipantView(boss, W.comp.id);
      const d = await (await boss.api.get(`/api/tasks/${W.sealedId}`)).json();
      const sub = await boss.api.post(`/api/tasks/${W.sealedId}/submit`, { headers: H(boss.csrf), data: { answer: `SEALKEY_${W.T}`, gradingHash: d.grading_hash } });
      expect((await sub.json()).correct, "precondition: solved").toBe(true);
      await withRecordFailing(W.sealedId, async () => {
        const r = await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) });
        expect(r.status()).toBe(503);
        const txt = await r.text();
        expect(txt).not.toContain(`SEALHINT_${W.T}`);
        expect(JSON.parse(txt).code).toBe("answer_seal_reveal_unrecorded");
        expect(revealRows(W.sealedId)).toBe(0);
      });
      const ok = await (await boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf) })).json();
      expect(ok.alreadySolved).toBe(true);
      expect(ok.hint).toContain(`SEALHINT_${W.T}`);
      expect(hintRows(boss.id, W.sealedId), "the solver's hint is free — no row either way").toBe(0);
      expect(revealRows(W.sealedId)).toBe(1);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });
});

test.describe("v8.12.6 — a BRIEF external write lock is waited out, not turned into a refusal", () => {

  test("the end-of-event GET, parked on a brief external lock, discloses all three fields and records exactly once", async () => {
    const W = await endedWorld("f3lg");
    const boss = await makeTier(sa, saCsrf, "f3lgboss", "superadmin");
    try {
      await asParticipantView(boss, W.comp.id);
      const h = await withTransientLock(() => boss.api.get(`/api/tasks/${W.sealedId}`, { timeout: 30_000 }));
      expect(h.r.status()).toBe(200);
      const txt = await h.r.text();
      expect(txt, "waited out, then disclosed").toContain(`SEALKEY_${W.T}`);
      expect(txt).toContain(`SEALWHY_${W.T}`);
      expect(txt).toContain(`SEALHINT_${W.T}`);
      expect(JSON.parse(txt).answer_withheld_reason, "not refused for brief contention").toBeUndefined();
      expect(revealRows(W.sealedId), "…and recorded, once").toBe(1);
      await expectContended(h);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });

  test("the fresh hint POST, parked on a brief external lock, reveals, charges once and records once — the record-first order does not refuse a legitimate reveal", async () => {
    const W = await liveWorld("f3lp");
    const boss = await makeTier(sa, saCsrf, "f3lpboss", "superadmin");
    try {
      await asParticipantView(boss, W.comp.id);
      const h = await withTransientLock(() => boss.api.post(`/api/tasks/${W.sealedId}/hint`, { headers: H(boss.csrf), timeout: 30_000 }));
      const txt = await h.r.text();
      expect(h.r.status(), txt).toBe(200);
      expect(JSON.parse(txt).hint).toContain(`SEALHINT_${W.T}`);
      expect(hintRows(boss.id, W.sealedId), "one paid row").toBe(1);
      expect(revealRows(W.sealedId), "one record").toBe(1);
      await expectContended(h);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });

  test("the explicit reveal route, parked on a brief external lock, reveals and records once — the same shared helper, no longer a spurious 500", async () => {
    const W = await liveWorld("f3lx");
    const boss = await makeTier(sa, saCsrf, "f3lxboss", "superadmin");
    try {
      const h = await withTransientLock(() => boss.api.post(`/api/admin/tasks/${W.sealedId}/sealed-reveal`, { headers: H(boss.csrf), timeout: 30_000 }));
      const txt = await h.r.text();
      expect(h.r.status(), txt).toBe(200);
      expect(JSON.parse(txt)).toMatchObject({ ok: true, revealed: true });
      expect(revealRows(W.sealedId)).toBe(1);
      await expectContended(h);
    } finally { try { await boss.api.dispose(); } catch (_) {} }
  });
});

test.describe("v8.12.6 — the reason is declared once and every copy of it agrees", () => {

  test("lib/answer-seal.js declares the code and reason apart from the seal's own reasons; the route never spells the reason; the client has copy for every reason the GET can send", () => {
    // Pure module (requires nothing) — safe to load in-test.
    const seal = require("../lib/answer-seal");
    const { stripJsComments } = require("./doc-registry");
    const root = path.resolve(__dirname, "..");
    // The wire contract, spelled as literals so the module cannot drift alone.
    expect(seal.SEAL_UNRECORDED_CODE).toBe("answer_seal_reveal_unrecorded");
    expect(seal.SEAL_UNRECORDED_REASON).toBe("unrecorded");
    const u = seal.sealRevealUnrecorded();
    expect(u).toMatchObject({ code: "answer_seal_reveal_unrecorded", reason: "unrecorded" });
    expect(u.message).toMatch(/recorded/);
    // NOT a seal-binds-you reason: folding it into that list would let the
    // author-only 403 carry a store-failure message.
    expect(seal.SEALED_HINT_WITHHELD_REASONS).toEqual(["competing_elsewhere", "impersonating", "not_competing"]);
    const d = seal.sealedHintDenied({ answer_sealed: 1, created_by_id: "x" }, "y", false, false, "unrecorded");
    expect(d.code).toBe("answer_sealed_not_author");
    expect(d.reason, "an unknown reason falls to the default, never the store-failure sentence").toBe("not_competing");

    // THE ROUTE reads the constant — a literal would let the two drift.
    const route = stripJsComments(fs.readFileSync(path.join(root, "routes/participant.js"), "utf8"));
    expect(route, "routes/participant.js spells the reason literally").not.toMatch(/["']unrecorded["']/);
    expect((route.match(/SEAL_UNRECORDED_REASON/g) || []).length, "the GET emits the constant for both the answer and the hint").toBeGreaterThanOrEqual(3);
    expect(route).toContain("sealRevealUnrecorded()");

    // THE CLIENT: a sentence for every reason the GET's hint panel can carry…
    const client = stripJsComments(fs.readFileSync(path.join(root, "public/js/features/participant-tasks.js"), "utf8"));
    const block = /const _HINT_WITHHELD_COPY\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/.exec(client);
    expect(block, "the client copy table must exist").toBeTruthy();
    const keys = [...block[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map(m => m[1]).sort();
    expect(keys.length, "anti-vacuity floor: the copy table was found and parsed").toBeGreaterThanOrEqual(4);
    const serverHintReasons = [...seal.SEALED_HINT_WITHHELD_REASONS, seal.SEAL_UNRECORDED_REASON].sort();
    expect(keys, "every hint_withheld_reason the GET sends has a client sentence, and no stale key survives").toEqual(serverHintReasons);
    // …and a branch for every answer_withheld_reason.
    for (const r of ["competing_elsewhere", seal.SEAL_UNRECORDED_REASON]) {
      expect(client, `the Answer-not-shown box handles answer_withheld_reason '${r}'`).toContain(`answer_withheld_reason==='${r}'`);
    }
  });

  // swagger.yaml's copies of the same reasons, read with the strict YAML parser
  // playwright-core bundles (the one swagger-conformance's strict arm uses):
  // the task GET's `hint_withheld_reason` enum is the seal's reasons plus
  // `unrecorded` (deliberately outside SEALED_HINT_WITHHELD_REASONS: see its
  // comment), compared as SETS both ways, so a reason added on either side alone
  // fails; `answer_withheld_reason` and the hint POST's 503 `reason` are fixed
  // subsets pinned here by literal (nothing ties them to the route's own
  // literal); the POST's 403 names each seal reason.
  test("swagger's reason enums equal what lib/answer-seal.js declares, both ways", () => {
    const seal = require("../lib/answer-seal");
    const { yaml } = require("playwright-core/lib/utilsBundle");
    const spec = yaml.parse(fs.readFileSync(path.resolve(__dirname, "..", "swagger.yaml"), "utf8"));
    const sorted = (a) => [...a].sort();
    const taskGet = spec.paths["/api/tasks/{id}"].get.responses["200"].content["application/json"].schema.properties;
    const hintPost = spec.paths["/api/tasks/{id}/hint"].post.responses;
    const hintEnum = taskGet.hint_withheld_reason && taskGet.hint_withheld_reason.enum;
    const answerEnum = taskGet.answer_withheld_reason && taskGet.answer_withheld_reason.enum;
    const unrecEnum = hintPost["503"].content["application/json"].schema.properties.reason.enum;
    // Anti-vacuity: each enum was found, and the module's list is the one this file pins above.
    expect(seal.SEALED_HINT_WITHHELD_REASONS.length, "anti-vacuity: the seal's reasons").toBeGreaterThanOrEqual(3);
    for (const [name, e] of [["hint_withheld_reason", hintEnum], ["answer_withheld_reason", answerEnum], ["503 reason", unrecEnum]]) {
      expect(Array.isArray(e) && e.length > 0, `anti-vacuity: swagger's ${name} enum was found`).toBe(true);
    }
    const wantHint = sorted([...seal.SEALED_HINT_WITHHELD_REASONS, seal.SEAL_UNRECORDED_REASON]);
    expect(sorted(hintEnum), "hint_withheld_reason: no reason missing from swagger, none it invents").toEqual(wantHint);
    expect(sorted(answerEnum), "answer_withheld_reason: competing_elsewhere and unrecorded")
      .toEqual(sorted(["competing_elsewhere", seal.SEAL_UNRECORDED_REASON]));
    for (const r of answerEnum) expect(wantHint, `answer_withheld_reason '${r}' is a hint reason too`).toContain(r);
    expect(unrecEnum, "the 503's reason is the store-failure reason alone").toEqual([seal.SEAL_UNRECORDED_REASON]);
    const forbidden = String(hintPost["403"].description || "");
    for (const r of seal.SEALED_HINT_WITHHELD_REASONS) {
      expect(forbidden, `the hint POST's 403 names the seal reason '${r}'`).toContain(`\`${r}\``);
    }
  });
});
