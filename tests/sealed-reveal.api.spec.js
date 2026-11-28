// @ts-check
//
// v8.12.2 — THE SEALED HINT, AND THE SUPERADMIN'S RECORDED REVEAL, on the wire.
//
// Three operator rulings this file pins (the fourth — impersonation — lives in
// tests/impersonation-event-admin-view.api.spec.js beside the v8.12.1 arms it
// re-points):
//
//  (1) A sealed challenge's HINT is withheld exactly as its answer is: the admin
//      list, the version history, the tasks export and the end-of-event free
//      reveal to participants. A participant who PAID for the hint keeps it.
//  (2) A SUPERADMIN may read a sealed answer and hint, and edit or unseal the
//      challenge like the author — but only after an explicit reveal
//      (`POST /api/admin/tasks/:id/sealed-reveal`), which lasts for the session
//      shape it was made in. A regular admin never can.
//  (3) Every reveal is RECORDED: a `sealed_reveal` row in the challenge's History
//      naming the superadmin, and a `sealed_answer_revealed` event in the log.
//
// Every positive carries the controls the v8.10.0 file established: an UNSEALED
// twin created by the same author (so "the hint is missing" cannot be satisfied
// by a build that dropped the column), the AUTHOR on the same request shape, and
// a REGULAR ADMIN beside every superadmin (so "the superadmin can read it" cannot
// be satisfied by a build that opened the seal to everybody). Secrets are
// distinctive strings asserted BY VALUE over the whole serialised response.
const { test, expect } = require("./isolated-test");
const path = require("path");
const { apiLogin, freshCtx, findLogLine, PARTICIPANT_PASS, gradingHashFor, TEST_DB_PATH, TEST_DATA_DIR, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, assignTask, enrol, grantEventAdmin, withLegacySharedAssign } = require("./event-admin-helpers");

function withDb(fn, opts = { readonly: true }) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, opts);
  try { return fn(db); } finally { db.close(); }
}
const dbGet = (sql, ...a) => withDb(db => db.prepare(sql).get(...a));
const dbRun = (sql, ...a) => withDb(db => db.prepare(sql).run(...a), { readonly: false });
const iso = ms => new Date(Date.now() + ms).toISOString();

/** A fresh participant promoted to `role`, signed in on its own context. */
async function makeTier(sa, saCsrf, label, role) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { ...p, ...(await signIn(p.email)) };
}
async function signIn(email) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${li.status()} ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf };
}
/** A sealed / plain pair by one author, both WITH a hint (no seal fixture had one before v8.12.2). */
async function makePair(owner, tag) {
  const mk = async (sealed) => {
    const r = await owner.api.post("/api/admin/tasks", {
      headers: H(owner.csrf),
      data: {
        title: uniq(sealed ? `Revealable ${tag}` : `Open ${tag}`),
        description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: sealed ? `SEALKEY_${tag}` : `PLAINKEY_${tag}`,
        explanation: sealed ? `<p>SEALWHY_${tag}</p>` : `<p>PLAINWHY_${tag}</p>`,
        hint: sealed ? `<p>SEALHINT_${tag}</p>` : `<p>PLAINHINT_${tag}</p>`,
        status: "published",
        ...(sealed ? { answer_sealed: true } : {}),
      },
    });
    expect(r.ok(), `create ${sealed ? "sealed" : "plain"}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).id;
  };
  return { sealedId: await mk(true), plainId: await mk(false) };
}
// The event's OWN copy of a bank question (lib/event-copies.js): what an assign
// puts into the event, and so what its participants answer, buy hints on and are
// revealed — a row of its own, sealed like its bank question.
const ownCopy = async (owner, id, compId) => (await assignTask(owner.api, owner.csrf, id, [compId])).copies[0].task_id;
const row = async (ctx, id) => (await (await ctx.api.get("/api/admin/tasks")).json()).find(x => x.id === id);
const revealRows = id => dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", id).c;
const lastReveal = id => dbGet("SELECT changed_by, details, snapshot FROM task_versions WHERE task_id=? AND change_type='sealed_reveal' ORDER BY version_num DESC LIMIT 1", id);
const reveal = (ctx, id) => ctx.api.post(`/api/admin/tasks/${id}/sealed-reveal`, { headers: H(ctx.csrf) });

let sa, saCsrf, author, other, boss, TAG, sealedId, plainId;

test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  TAG = uniq("r").replace(/[^a-zA-Z0-9]/g, "");
  author = await makeTier(sa, saCsrf, "rvauthor", "admin");
  other  = await makeTier(sa, saCsrf, "rvother", "admin");
  boss   = await makeTier(sa, saCsrf, "rvboss", "superadmin");
  ({ sealedId, plainId } = await makePair(author, TAG));
});

test.afterAll(async () => {
  for (const c of [author, other, boss]) { try { await c?.api?.dispose(); } catch (_) {} }
  try { await sa?.dispose(); } catch (_) {}
});

test.describe("v8.12.2 (1) — the hint is sealed with the answer", () => {

  test("the admin list withholds a sealed challenge's hint from a non-author, marks it withheld, and keeps the plain twin's and the author's", async () => {
    const list = await (await other.api.get("/api/admin/tasks")).text();
    expect(list, "the sealed hint reaches no non-author, by value").not.toContain(`SEALHINT_${TAG}`);
    expect(list, "CONTROL: the plain twin's hint is on the same wire").toContain(`PLAINHINT_${TAG}`);
    const t = JSON.parse(list).find(x => x.id === sealedId);
    expect("hint" in t, "the key is DELETED, not blanked").toBe(false);
    expect(t.hint_withheld, "and the row says so (the same marker the competitor branch emits)").toBe(true);
    expect(t.can_see_answer).toBe(false);
    expect(t.can_reveal_answer, "a regular admin is offered no reveal").toBeUndefined();
    expect(t.competing_in, "…and the reason is the seal, not a competitor lock").toEqual([]);
    const p = JSON.parse(list).find(x => x.id === plainId);
    expect(p.hint_withheld).toBeFalsy();
    const mine = await row(author, sealedId);
    expect(mine.hint, "the author reads their own hint").toBe(`<p>SEALHINT_${TAG}</p>`);
    expect(mine.hint_withheld).toBeFalsy();
  });

  test("the version history and the tasks export withhold the sealed hint from a non-author — every snapshot, `hint: null` + `hint_withheld: 1` in the file — and not the plain twin's", async () => {
    // A second version, so the history has more than the create row to redact.
    const r0 = await row(author, sealedId);
    const bump = await author.api.put(`/api/admin/tasks/${sealedId}`, { headers: H(author.csrf), data: { title: `${r0.title} v2`, expectedUpdatedAt: r0.updated_at } });
    expect(bump.ok(), await bump.text()).toBeTruthy();
    const hist = await (await other.api.get(`/api/admin/tasks/${sealedId}/versions`)).text();
    const versions = JSON.parse(hist);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(hist, "no snapshot carries the sealed hint").not.toContain(`SEALHINT_${TAG}`);
    for (const v of versions) expect("hint" in JSON.parse(v.snapshot), "deleted from the snapshot, not blanked").toBe(false);
    const plainHist = await (await other.api.get(`/api/admin/tasks/${plainId}/versions`)).text();
    expect(plainHist, "CONTROL: the plain twin's history carries its hint").toContain(`PLAINHINT_${TAG}`);
    const ownHist = await (await author.api.get(`/api/admin/tasks/${sealedId}/versions`)).text();
    expect(ownHist, "CONTROL: the author's own history carries the hint").toContain(`SEALHINT_${TAG}`);

    const ex = await (await other.api.get("/api/admin/export/tasks")).text();
    expect(ex, "the export carries no sealed hint").not.toContain(`SEALHINT_${TAG}`);
    expect(ex, "CONTROL: the plain twin's hint is exported").toContain(`PLAINHINT_${TAG}`);
    const exRow = JSON.parse(ex).tasks.find(x => x.title === `${r0.title} v2`);
    expect(exRow.hint, "null in the file, never an empty string").toBeNull();
    expect(exRow.hint_withheld, "and marked, so the importer keeps a stored hint on overwrite").toBe(1);
    expect(exRow.answer_sealed).toBe(1);
    const ownEx = JSON.parse(await (await author.api.get("/api/admin/export/tasks")).text()).tasks.find(x => x.title === `${r0.title} v2`);
    expect(ownEx.hint, "CONTROL: the author's export carries it").toContain(`SEALHINT_${TAG}`);
    expect(ownEx.hint_withheld).toBeUndefined();
  });

  test("the end-of-event reveal withholds a sealed hint from a participant who did not pay, ships the plain twin's, and a participant who PAID keeps the sealed one", async () => {
    const PT = uniq("ph").replace(/[^a-zA-Z0-9]/g, "");
    const { sealedId: sT, plainId: pT } = await makePair(author, PT);
    const comp = await makeCompetition(sa, saCsrf, "hintreveal", { reveal_answers_on_end: true, duration_minutes: 60 });
    await assignTask(author.api, author.csrf, sT, [comp.id]);
    await assignTask(author.api, author.csrf, pT, [comp.id]);
    const payer = await makeParticipant(sa, saCsrf, "hintpayer");
    const other2 = await makeParticipant(sa, saCsrf, "hintnopay");
    const stander = await makeParticipant(sa, saCsrf, "hintstander"); // never acts: no all-solved auto-end
    await enrol(sa, saCsrf, comp.id, [payer.id, other2.id, stander.id]);
    const sessions = {};
    for (const p of [payer, other2]) {
      const s = await signIn(p.email);
      const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      sessions[p.id] = s;
    }
    try {
      // The payer buys the sealed hint while the event runs — the hint's whole purpose.
      const buy = await sessions[payer.id].api.post(`/api/tasks/${sT}/hint`, { headers: H(sessions[payer.id].csrf) });
      expect(buy.ok(), await buy.text()).toBeTruthy();
      expect((await buy.json()).hint, "the paid reveal ships the sealed hint mid-event").toContain(`SEALHINT_${PT}`);
      // Before the end nobody who has not paid sees any hint text.
      const mid = await (await sessions[other2.id].api.get(`/api/tasks/${sT}`)).text();
      expect(mid).not.toContain(`SEALHINT_${PT}`);
      // END the event: the free reveal fires.
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), await end.text()).toBeTruthy();
      const unpaidS = await (await sessions[other2.id].api.get(`/api/tasks/${sT}`)).text();
      expect(unpaidS, "the sealed hint does NOT ride the free reveal").not.toContain(`SEALHINT_${PT}`);
      expect(unpaidS, "…nor the sealed key").not.toContain(`SEALKEY_${PT}`);
      const uj = JSON.parse(unpaidS);
      expect(uj.answer_sealed_withheld, "and the participant is told why").toBe(true);
      expect(uj.answer_withheld_reason, "an ordinary participant is not given the competitor reason").toBeUndefined();
      expect(uj.hint_available, "the wire says there WAS a hint — what the client's sealed-hint clause keys on").toBe(true);
      expect(uj.hint_withheld, "…with no withheld panel of its own").toBeUndefined();
      const unpaidP = await (await sessions[other2.id].api.get(`/api/tasks/${pT}`)).text();
      expect(unpaidP, "CONTROL: the plain twin's hint DOES ride the free reveal").toContain(`PLAINHINT_${PT}`);
      expect(unpaidP, "…with its key").toContain(`PLAINKEY_${PT}`);
      const paidS = await (await sessions[payer.id].api.get(`/api/tasks/${sT}`)).text();
      expect(paidS, "the participant who PAID keeps the sealed hint after the end").toContain(`SEALHINT_${PT}`);
      expect(paidS, "…and is still not shown the sealed key").not.toContain(`SEALKEY_${PT}`);
      expect(revealRows(sT), "an ordinary participant's paid hint records no superadmin disclosure").toBe(0);
    } finally {
      for (const s of Object.values(sessions)) { try { await s.api.dispose(); } catch (_) {} }
    }
  });
});

test.describe("v8.12.2 (2)+(3) — the superadmin's reveal, and its record", () => {

  test("a regular admin cannot reveal; an unsealed challenge cannot be revealed; the author's own reveal is a no-op that records nothing", async () => {
    const r1 = await reveal(other, sealedId);
    expect(r1.status(), await r1.text()).toBe(403);
    expect((await r1.json()).code).toBe("answer_seal_reveal_superadmin_only");
    expect(revealRows(sealedId), "a refusal records nothing").toBe(0);
    const r2 = await reveal(boss, plainId);
    expect(r2.status(), "nothing to reveal on an unsealed challenge").toBe(403);
    expect((await r2.json()).code).toBe("answer_seal_reveal_superadmin_only");
    const r3 = await reveal(author, sealedId);
    expect(r3.status(), await r3.text()).toBe(200);
    expect(await r3.json()).toMatchObject({ ok: true, revealed: false, author: true });
    expect(revealRows(sealedId), "the author's own reveal is not a disclosure").toBe(0);
    const t = await row(other, sealedId);
    expect(t.correct_answer, "the regular admin still reads nothing after all that").toBeUndefined();
    expect(t.hint).toBeUndefined();
  });

  test("a superadmin is OFFERED the reveal, reveals, and then reads and edits the challenge as its author would — list, history, export, submissions and the search, the PUT — with the reveal on the record", async () => {
    const before = await row(boss, sealedId);
    expect(before.can_see_answer, "before the reveal a superadmin is sealed out like anybody else").toBe(false);
    expect(before.correct_answer).toBeUndefined();
    expect(before.hint).toBeUndefined();
    expect(before.hint_withheld).toBe(true);
    expect(before.can_edit, "…and may not edit").toBe(false);
    expect(before.can_reveal_answer, "but is OFFERED the reveal — the server's answer, not the client's").toBe(true);
    expect(before.answer_revealed).toBeUndefined();
    const put0 = await boss.api.put(`/api/admin/tasks/${sealedId}`, { headers: H(boss.csrf), data: { title: `${before.title} nope`, expectedUpdatedAt: before.updated_at } });
    expect(put0.status(), "the PUT is refused before a reveal").toBe(403);
    expect((await put0.json()).code).toBe("answer_sealed_not_author");

    // A participant has submitted the key, so the Submissions stream has a row to redact.
    const comp = await makeCompetition(sa, saCsrf, "revealsub", { duration_minutes: 60 });
    // The event holds its OWN copy of the challenge, so the solver's answer is
    // the copy's, and the Submissions stream redacts it by the copy's seal.
    const sealedCopy = await ownCopy(author, sealedId, comp.id);
    const solver = await makeParticipant(sa, saCsrf, "rvsolver");
    const stander = await makeParticipant(sa, saCsrf, "rvstander");
    await enrol(sa, saCsrf, comp.id, [solver.id, stander.id]);
    const ss = await signIn(solver.email);
    try {
      const sel = await ss.api.post("/api/select-competition", { headers: H(ss.csrf), data: { competitionId: comp.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      const sub = await ss.api.post(`/api/tasks/${sealedId}/submit`, { headers: H(ss.csrf), data: { answer: `SEALKEY_${TAG}`, gradingHash: await gradingHashFor(ss.api, sealedId) } });
      expect(sub.ok(), await sub.text()).toBeTruthy();
      expect((await sub.json()).correct).toBe(true);
    } finally { await ss.api.dispose(); }
    const subsBefore = await (await boss.api.get(`/api/admin/submissions?competitionId=${comp.id}`)).text();
    expect(subsBefore, "the submitted key is redacted from the superadmin before the reveal").not.toContain(`SEALKEY_${TAG}`);
    const qBefore = await (await boss.api.get(`/api/admin/submissions?competitionId=${comp.id}&q=${encodeURIComponent(`SEALKEY_${TAG}`)}`)).json();
    expect(qBefore.total, "…and the search cannot confirm it").toBe(0);

    // THE REVEAL.
    const rv = await reveal(boss, sealedId);
    expect(rv.status(), await rv.text()).toBe(200);
    const rvBody = await rv.json();
    expect(rvBody).toMatchObject({ ok: true, revealed: true });
    expect(rvBody.fields).toEqual(["correct_answer", "explanation", "hint"]);

    // (3) THE RECORD — History row naming the superadmin, and the event log.
    expect(revealRows(sealedId)).toBe(1);
    const rec = lastReveal(sealedId);
    expect(rec.changed_by, "the History names the superadmin").toBe(boss.email);
    const d = JSON.parse(rec.details);
    expect(d).toMatchObject({ via: "admin_panel", fields: ["correct_answer", "explanation", "hint"] });
    expect(d.impersonated_by, "no seat: no impersonation context").toBeUndefined();
    expect(rec.details, "field NAMES only — the record never carries the values").not.toContain(`SEALKEY_${TAG}`);
    expect(rec.details).not.toContain(`SEALHINT_${TAG}`);
    const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      j => j.source === "audit" && j.scope === "task" && j.scope_id === sealedId && j.event_type === "sealed_answer_revealed",
      { what: "the sealed_answer_revealed event in app.jsonl" });
    expect(line.changed_by, "the event log names the superadmin too").toBe(boss.email);
    expect(line.details.via).toBe("admin_panel");
    expect(line.details.ip, "…with the request context (the v7.21.32 rule)").toBeTruthy();
    expect(line.details.req_id).toBeTruthy();
    expect(JSON.stringify(line), "and no secret reaches the log").not.toContain(`SEALKEY_${TAG}`);
    expect(JSON.stringify(line)).not.toContain(`SEALHINT_${TAG}`);
    // The History endpoint returns the record with its details PARSED, and the
    // author's read of it is the same row.
    const histOwn = await (await author.api.get(`/api/admin/tasks/${sealedId}/versions`)).json();
    const recRow = histOwn.find(v => v.change_type === "sealed_reveal");
    expect(recRow, "the author can see who revealed their key").toBeTruthy();
    expect(recRow.changed_by).toBe(boss.email);
    expect(recRow.details).toMatchObject({ via: "admin_panel" });

    // (2) AS THE AUTHOR WOULD, for the rest of the session.
    const after = await row(boss, sealedId);
    expect(after.can_see_answer).toBe(true);
    expect(after.answer_revealed, "the row says the key is theirs by the reveal, not by authorship").toBe(true);
    expect(after.can_reveal_answer).toBeUndefined();
    expect(after.correct_answer).toBe(`SEALKEY_${TAG}`);
    expect(after.explanation).toContain(`SEALWHY_${TAG}`);
    expect(after.hint).toContain(`SEALHINT_${TAG}`);
    expect(after.hint_withheld).toBeFalsy();
    expect(after.can_edit).toBe(true);
    expect(after.changed_by, "the reveal is not the row's last change on the Challenges pane").toBe(author.email);
    const hist = await (await boss.api.get(`/api/admin/tasks/${sealedId}/versions`)).text();
    expect(hist, "the history is unredacted for a revealed superadmin").toContain(`SEALKEY_${TAG}`);
    expect(hist).toContain(`SEALHINT_${TAG}`);
    const ex = await (await boss.api.get("/api/admin/export/tasks")).text();
    expect(ex, "the export carries the key and hint for a revealed superadmin").toContain(`SEALKEY_${TAG}`);
    expect(ex).toContain(`SEALHINT_${TAG}`);
    // The bank question's reveal is that row's: the event's copy is revealed on
    // its own record (a second reveal, of the row the submission is under).
    const rvCopy = await reveal(boss, sealedCopy);
    expect(rvCopy.status(), await rvCopy.text()).toBe(200);
    expect(revealRows(sealedCopy), "the copy's reveal is on its own record").toBe(1);
    const subsAfter = await (await boss.api.get(`/api/admin/submissions?competitionId=${comp.id}`)).text();
    expect(subsAfter, "the submissions stream shows the submitted key").toContain(`SEALKEY_${TAG}`);
    const qAfter = await (await boss.api.get(`/api/admin/submissions?competitionId=${comp.id}&q=${encodeURIComponent(`SEALKEY_${TAG}`)}`)).json();
    expect(qAfter.total, "…and the search finds it").toBe(1);
    const put1 = await boss.api.put(`/api/admin/tasks/${sealedId}`, { headers: H(boss.csrf), data: { title: `${after.title} by boss`, expectedUpdatedAt: after.updated_at } });
    expect(put1.status(), await put1.text()).toBe(200);
    expect(dbGet("SELECT title FROM tasks WHERE id=?", sealedId).title).toBe(`${after.title} by boss`);

    // CONTROLS: the reveal is the superadmin's alone. A regular admin on the same
    // request shapes still reads nothing, and the participant stream still hides it.
    const otherRow = await row(other, sealedId);
    expect(otherRow.correct_answer).toBeUndefined();
    expect(otherRow.hint).toBeUndefined();
    const otherSubs = await (await other.api.get(`/api/admin/submissions?competitionId=${comp.id}`)).text();
    expect(otherSubs).not.toContain(`SEALKEY_${TAG}`);
    const otherEx = await (await other.api.get("/api/admin/export/tasks")).text();
    expect(otherEx).not.toContain(`SEALHINT_${TAG}`);
  });

  test("a second reveal in the same session records nothing new; the record is a Record, not a version — restore refuses it, while a real version stays restorable", async () => {
    // OWNS its fixture (final review): it used to lean on the test above having
    // revealed the file's shared challenge in `boss`'s session and on two earlier
    // edits having made a second version, so it failed run alone and every
    // mutation of the reveal route killed it as collateral.
    const T = tag("idem");
    const { sealedId: sT } = await makePair(author, T);
    const r0 = await row(author, sT);
    const ed = await author.api.put(`/api/admin/tasks/${sT}`, { headers: H(author.csrf), data: { title: `${r0.title} v2`, expectedUpdatedAt: r0.updated_at } });
    expect(ed.ok(), `PRECONDITION: a second real version: ${await ed.text()}`).toBeTruthy();
    const sup = await makeTier(sa, saCsrf, "idemsup", "superadmin");
    try {
      const first = await reveal(sup, sT);
      expect(first.status(), await first.text()).toBe(200);
      expect((await first.json()).already, "the first reveal is a real one").toBeUndefined();
      expect(revealRows(sT)).toBe(1);
      const again = await reveal(sup, sT);
      expect(again.status()).toBe(200);
      expect(await again.json()).toMatchObject({ ok: true, revealed: true, already: true });
      expect(revealRows(sT), "idempotent per session").toBe(1);
      const recId = dbGet("SELECT id FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", sT).id;
      const rs = await sup.api.post(`/api/admin/tasks/${sT}/restore`, { headers: H(sup.csrf), data: { versionId: recId } });
      expect(rs.status(), "restoring a Record row is refused").toBe(400);
      expect((await rs.json()).error).toMatch(/not a version/i);
      // A real version is still restorable by the revealed superadmin (the author's power).
      const versions = await (await sup.api.get(`/api/admin/tasks/${sT}/versions`)).json();
      const real = versions.filter(v => v.change_type !== "sealed_reveal");
      expect(real.length).toBeGreaterThanOrEqual(2);
      const rs2 = await sup.api.post(`/api/admin/tasks/${sT}/restore`, { headers: H(sup.csrf), data: { versionId: real[real.length - 1].id } });
      expect(rs2.status(), await rs2.text()).toBe(200);
    } finally { try { await sup.api.dispose(); } catch (_) {} }
  });

  test("the reveal lasts the session shape: a fresh sign-in withholds again (and refuses the unseal), and a superadmin demoted mid-session keeps no grant from a stale marker", async () => {
    // Fresh sign-in as the same superadmin: the marker died with the old session.
    const fresh = await signIn(boss.email);
    try {
      const t = await row({ api: fresh.api }, sealedId);
      expect(t.correct_answer, "a new session starts sealed out").toBeUndefined();
      expect(t.hint).toBeUndefined();
      expect(t.can_reveal_answer, "…and offered the reveal again").toBe(true);
      const un = await fresh.api.put(`/api/admin/tasks/${sealedId}`, { headers: H(fresh.csrf), data: { answer_sealed: 0, expectedUpdatedAt: t.updated_at } });
      expect(un.status(), "the unseal is refused without a reveal").toBe(403);
      expect(dbGet("SELECT answer_sealed FROM tasks WHERE id=?", sealedId).answer_sealed).toBe(1);
      // Reveal in THIS session, then demote by SQL (no session purge, so the
      // marker survives) — the live role read must refuse the stale marker.
      const rv = await reveal(fresh, sealedId);
      expect(rv.status(), await rv.text()).toBe(200);
      expect((await row({ api: fresh.api }, sealedId)).correct_answer, "revealed").toBe(`SEALKEY_${TAG}`);
      dbRun("UPDATE users SET role='admin' WHERE id=?", boss.id);
      try {
        const demoted = await row({ api: fresh.api }, sealedId);
        expect(demoted.correct_answer, "a demoted account's marker grants nothing — the tier is re-read live").toBeUndefined();
        expect(demoted.hint).toBeUndefined();
        expect(demoted.can_reveal_answer, "…and it is no longer offered").toBeUndefined();
        const rv2 = await reveal(fresh, sealedId);
        expect(rv2.status(), "nor can it reveal again").toBe(403);
      } finally {
        dbRun("UPDATE users SET role='superadmin' WHERE id=?", boss.id);
      }
    } finally { await fresh.api.dispose(); }
    // The file's `boss` context is the old session, purged by the fresh login
    // (one session per user); re-establish it for the tests below.
    Object.assign(boss, await signIn(boss.email));
  });

  test("a revealed superadmin may UNSEAL (the author's power), and the v8.12.0 compete-event refusal still binds them", async () => {
    const UT = uniq("un").replace(/[^a-zA-Z0-9]/g, "");
    const { sealedId: u1, sealedId: _u, plainId: _p } = await makePair(author, UT);
    const { sealedId: u2bank } = await makePair(author, `${UT}b`);
    // u2 — the event's own copy — sits in an event where staff compete: the
    // unseal is refused there at any status, for a revealed superadmin exactly as
    // for the author.
    const compete = await makeCompetition(sa, saCsrf, "unsealcompete", { staff_compete: true, duration_minutes: 60 });
    const u2 = await ownCopy(author, u2bank, compete.id);
    for (const id of [u1, u2]) {
      const rv = await reveal(boss, id);
      expect(rv.status(), await rv.text()).toBe(200);
    }
    const r1 = await row(boss, u1);
    const un1 = await boss.api.put(`/api/admin/tasks/${u1}`, { headers: H(boss.csrf), data: { answer_sealed: 0, expectedUpdatedAt: r1.updated_at } });
    expect(un1.status(), await un1.text()).toBe(200);
    expect(dbGet("SELECT answer_sealed FROM tasks WHERE id=?", u1).answer_sealed, "unsealed by the revealed superadmin").toBe(0);
    expect((await row(other, u1)).correct_answer, "…and every admin reads it now").toBe(`SEALKEY_${UT}`);
    const r2 = await row(boss, u2);
    const un2 = await boss.api.put(`/api/admin/tasks/${u2}`, { headers: H(boss.csrf), data: { answer_sealed: 0, expectedUpdatedAt: r2.updated_at } });
    expect(un2.status(), "the compete-event seal invariant binds a revealed superadmin").toBe(409);
    expect((await un2.json()).code).toBe("answer_seal_in_compete_event");
    expect(dbGet("SELECT answer_sealed FROM tasks WHERE id=?", u2).answer_sealed).toBe(1);
  });

  test("a superadmin who COMPETES in an event holding the challenge is refused the reveal, and is not offered it", async () => {
    const CT = uniq("cp").replace(/[^a-zA-Z0-9]/g, "");
    const { sealedId: c1 } = await makePair(author, CT);
    const compete = await makeCompetition(sa, saCsrf, "revealcompete", { staff_compete: true, duration_minutes: 60 });
    await assignTask(author.api, author.csrf, c1, [compete.id]);
    const rival = await makeTier(sa, saCsrf, "rvrival", "superadmin");
    try {
      await enrol(sa, saCsrf, compete.id, [rival.id]);
      const t = await row(rival, c1);
      expect(t.competing_in.map(c => c.id), "the fixture really makes them a competitor").toContain(compete.id);
      expect(t.can_reveal_answer, "no offer to a competitor").toBeUndefined();
      const rv = await reveal(rival, c1);
      expect(rv.status(), await rv.text()).toBe(403);
      expect((await rv.json()).code, "the competitor lock, asked first").toBe("competitor_cannot_edit");
      expect(revealRows(c1)).toBe(0);
      // CONTROL: the unenrolled superadmin is offered it and gets it.
      expect((await row(boss, c1)).can_reveal_answer).toBe(true);
    } finally { await rival.api.dispose(); }
  });

  test("the built-in superadmin reveals too, recorded as 'superadmin'", async () => {
    const BT = uniq("bi").replace(/[^a-zA-Z0-9]/g, "");
    const { sealedId: b1 } = await makePair(author, BT);
    expect((await row({ api: sa }, b1)).can_reveal_answer, "the built-in account has no user row and can never be an author — the reveal is its only door").toBe(true);
    const rv = await sa.post(`/api/admin/tasks/${b1}/sealed-reveal`, { headers: H(saCsrf) });
    expect(rv.status(), await rv.text()).toBe(200);
    const t = await row({ api: sa }, b1);
    expect(t.correct_answer).toBe(`SEALKEY_${BT}`);
    expect(t.hint).toContain(`SEALHINT_${BT}`);
    expect(lastReveal(b1).changed_by).toBe("superadmin");
  });
});

// ── v8.12.2 PRE-RELEASE REVIEW — the arms that lock what the review found ────
//
// The first draft of this release shipped every arm above green and still had
// seventeen confirmed defects, each in code written for the release. These
// arms pin the server-side ones, each with the control that stops it being
// satisfied by a build that shows nobody anything.

/** Put an ADMIN-TIER context into its own participant view, inside `compId`. */
async function asParticipantView(ctx, compId) {
  const t = await ctx.api.post("/api/toggle-admin-view", { headers: H(ctx.csrf), data: { mode: "participant" } });
  expect(t.ok(), `toggle to participant view: ${t.status()} ${await t.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  return ctx;
}
const hintRows = (userId, taskId) => dbGet("SELECT COUNT(*) c FROM hint_reveals WHERE user_id=? AND task_id=?", userId, taskId).c;
const tag = l => uniq(l).replace(/[^a-zA-Z0-9]/g, "");

test.describe("v8.12.2 pre-release review — the sealed hint in an admin's own participant view", () => {

  test("a regular admin and an enrolled event admin, neither competing, are WITHHELD the sealed hint — GET says so, the paid POST is refused before any hint_reveals row — while the plain twin's hint stays buyable (CONTROL)", async () => {
    const T = tag("pvh");
    const { sealedId: sT, plainId: pT } = await makePair(author, T);
    const comp = await makeCompetition(sa, saCsrf, "pvhint", { duration_minutes: 120 });
    await assignTask(author.api, author.csrf, sT, [comp.id]);
    await assignTask(author.api, author.csrf, pT, [comp.id]);
    const stander = await makeParticipant(sa, saCsrf, "pvhstander");
    await enrol(sa, saCsrf, comp.id, [stander.id]);
    const adm = await makeTier(sa, saCsrf, "pvhadm", "admin");
    const eaP = await makeParticipant(sa, saCsrf, "pvhea");
    await grantEventAdmin(sa, saCsrf, comp.id, eaP.id);
    await enrol(sa, saCsrf, comp.id, [eaP.id]);
    expect(dbGet("SELECT 1 x FROM competition_users WHERE competition_id=? AND user_id=?", comp.id, eaP.id), "the event admin really holds a row").toBeTruthy();
    const ea = { ...eaP, ...(await signIn(eaP.email)) };
    try {
      for (const [who, ctx] of [["regular admin", adm], ["event admin", ea]]) {
        await asParticipantView(ctx, comp.id);
        const g = await (await ctx.api.get(`/api/tasks/${sT}`)).text();
        expect(g, `${who}: no sealed hint by value`).not.toContain(`SEALHINT_${T}`);
        const gj = JSON.parse(g);
        expect(gj.hint_withheld, `${who}: the response says WHY there is no hint`).toBe(true);
        expect(gj.hint_available, `${who}: nothing to buy`).toBe(false);
        expect("hint" in gj).toBe(false);
        const buy = await ctx.api.post(`/api/tasks/${sT}/hint`, { headers: H(ctx.csrf) });
        expect(buy.status(), `${who}: the paid read of a sealed hint is refused`).toBe(403);
        expect((await buy.json()).code).toBe("answer_sealed_not_author");
        expect(hintRows(ctx.id, sT), `${who}: refused BEFORE any hint_reveals row`).toBe(0);
        expect(revealRows(sT), `${who}: a refusal is no disclosure`).toBe(0);
        // CONTROL — the plain twin: offered, and bought.
        const pj = await (await ctx.api.get(`/api/tasks/${pT}`)).json();
        expect(pj.hint_available).toBe(true);
        expect(pj.hint_withheld).toBeUndefined();
        const pb = await ctx.api.post(`/api/tasks/${pT}/hint`, { headers: H(ctx.csrf) });
        expect(pb.ok(), `${who}: the plain hint is buyable: ${await pb.text()}`).toBeTruthy();
        expect((await pb.json()).hint).toContain(`PLAINHINT_${T}`);
      }
    } finally { for (const c of [adm, ea]) { try { await c.api.dispose(); } catch (_) {} } }
  });

  test("CONTROLS — the author in their own participant view, a COMPETING regular admin, and a non-competing superadmin (recorded) are each given the sealed hint", async () => {
    const T = tag("pvc");
    const { sealedId: sBank } = await makePair(author, T);
    const comp = await makeCompetition(sa, saCsrf, "pvhctl", { duration_minutes: 120 });
    const sT = await ownCopy(author, sBank, comp.id);
    const { sealedId: cBank } = await makePair(author, `${T}c`);
    const compete = await makeCompetition(sa, saCsrf, "pvhcompete", { duration_minutes: 120, staff_compete: true });
    const cT = await ownCopy(author, cBank, compete.id);
    const stander = await makeParticipant(sa, saCsrf, "pvcstander");
    await enrol(sa, saCsrf, comp.id, [stander.id]);
    await enrol(sa, saCsrf, compete.id, [stander.id]);
    const rival = await makeTier(sa, saCsrf, "pvcrival", "admin");
    await enrol(sa, saCsrf, compete.id, [rival.id]);
    expect(dbGet("SELECT 1 x FROM competition_users WHERE competition_id=? AND user_id=?", compete.id, rival.id), "the competing admin really holds a row").toBeTruthy();
    const auth2 = { ...author, ...(await signIn(author.email)) };
    const sup = await makeTier(sa, saCsrf, "pvcsup", "superadmin");
    try {
      await asParticipantView(auth2, comp.id);
      const a = await auth2.api.post(`/api/tasks/${sT}/hint`, { headers: H(auth2.csrf) });
      expect(a.ok(), `the author reads their own hint: ${await a.text()}`).toBeTruthy();
      expect((await a.json()).hint).toContain(`SEALHINT_${T}`);
      expect(revealRows(sT), "the author's own read is no disclosure").toBe(0);

      await asParticipantView(rival, compete.id);
      const rj = await (await rival.api.get(`/api/tasks/${cT}`)).json();
      expect(rj.hint_withheld, "a COMPETING admin is a participant on that board").toBeUndefined();
      expect(rj.hint_available).toBe(true);
      const rb = await rival.api.post(`/api/tasks/${cT}/hint`, { headers: H(rival.csrf) });
      expect(rb.ok(), `the competing admin may BUY it — the deduction lands on their board: ${await rb.text()}`).toBeTruthy();
      expect((await rb.json()).hint).toContain(`SEALHINT_${T}c`);
      expect(hintRows(rival.id, cT), "and it is a real paid row").toBe(1);
      expect(revealRows(cT), "a hint bought as a competitor is not a superadmin disclosure").toBe(0);

      await asParticipantView(sup, comp.id);
      const sb = await sup.api.post(`/api/tasks/${sT}/hint`, { headers: H(sup.csrf) });
      expect(sb.ok(), await sb.text()).toBeTruthy();
      expect((await sb.json()).hint).toContain(`SEALHINT_${T}`);
      const rec = lastReveal(sT);
      expect(rec, "the superadmin's read is recorded").toBeTruthy();
      expect(rec.changed_by).toBe(sup.email);
      expect(JSON.parse(rec.details)).toMatchObject({ via: "participant_hint", fields: ["hint"] });
    } finally { for (const c of [auth2, rival, sup]) { try { await c.api.dispose(); } catch (_) {} } }
    // The file's `author` context was purged by the fresh sign-in (one session per user).
    Object.assign(author, await signIn(author.email));
  });
});

test.describe("v8.12.2 pre-release review — the competitor, the blocked superadmin, and the export", () => {

  test("a superadmin who COMPETES in an event holding the challenge is shown nothing sealed after the end-of-event reveal, and nothing is recorded — while a non-competing superadmin on the same screen is shown it on the record (CONTROL)", async () => {
    const T = tag("cmp");
    const { sealedId: sBank } = await makePair(author, T);
    const ev = await makeCompetition(sa, saCsrf, "cmpend", { duration_minutes: 120, staff_compete: true, reveal_answers_on_end: true });
    const sT = await ownCopy(author, sBank, ev.id);
    const stander = await makeParticipant(sa, saCsrf, "cmpstander");
    const comp = await makeTier(sa, saCsrf, "cmpsup", "superadmin");
    const free = await makeTier(sa, saCsrf, "cmpfree", "superadmin");
    await enrol(sa, saCsrf, ev.id, [stander.id, comp.id]);
    expect(dbGet("SELECT 1 x FROM competition_users WHERE competition_id=? AND user_id=?", ev.id, comp.id), "the competing superadmin holds a row").toBeTruthy();
    try {
      const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), await end.text()).toBeTruthy();
      await asParticipantView(comp, ev.id);
      const g = await (await comp.api.get(`/api/tasks/${sT}`)).text();
      expect(g, "no key").not.toContain(`SEALKEY_${T}`);
      expect(g, "no explanation").not.toContain(`SEALWHY_${T}`);
      expect(g, "no hint").not.toContain(`SEALHINT_${T}`);
      const gj = JSON.parse(g);
      expect(gj.answer_sealed_withheld, "the box says the answer was withheld").toBe(true);
      expect(gj.answer_withheld_reason, "…and why: the one superadmin it is withheld from competes (final review)").toBe("competing_elsewhere");
      expect(revealRows(sT), "and nothing recorded — nothing was shown").toBe(0);
      await asParticipantView(free, ev.id);
      const f = await (await free.api.get(`/api/tasks/${sT}`)).text();
      expect(f, "CONTROL: a non-competing superadmin IS shown the key after the reveal").toContain(`SEALKEY_${T}`);
      expect(revealRows(sT), "…on the record").toBe(1);
    } finally { for (const c of [comp, free]) { try { await c.api.dispose(); } catch (_) {} } }
  });

  test("a superadmin BLOCKED out of band while impersonating a participant is shown nothing sealed and records nothing — the live lifecycle read, not the role alone", async () => {
    const T = tag("blk");
    const { sealedId: sBank } = await makePair(author, T);
    const ev = await makeCompetition(sa, saCsrf, "blkend", { duration_minutes: 120, reveal_answers_on_end: true });
    const sT = await ownCopy(author, sBank, ev.id);
    const target = await makeParticipant(sa, saCsrf, "blktarget");
    await enrol(sa, saCsrf, ev.id, [target.id]);
    const sup = await makeTier(sa, saCsrf, "blksup", "superadmin");
    try {
      const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), await end.text()).toBeTruthy();
      const imp = await sup.api.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(sup.csrf) });
      expect(imp.ok(), await imp.text()).toBeTruthy();
      sup.csrf = (await (await sup.api.get("/api/csrf-token")).json()).csrfToken;
      const sel = await sup.api.post("/api/select-competition", { headers: H(sup.csrf), data: { competitionId: ev.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      const live = await (await sup.api.get(`/api/tasks/${sT}`)).text();
      expect(live, "CONTROL: the live superadmin is shown the key through the target").toContain(`SEALKEY_${T}`);
      const n = revealRows(sT);
      expect(n, "…on the record").toBe(1);
      dbRun("UPDATE users SET blocked=1 WHERE id=?", sup.id);
      try {
        const blocked = await (await sup.api.get(`/api/tasks/${sT}`)).text();
        expect(blocked, "a blocked superadmin is shown nothing sealed").not.toContain(`SEALKEY_${T}`);
        expect(blocked).not.toContain(`SEALWHY_${T}`);
        expect(blocked).not.toContain(`SEALHINT_${T}`);
        expect(revealRows(sT), "and nothing is recorded in the name of a revoked account").toBe(n);
      } finally { dbRun("UPDATE users SET blocked=0 WHERE id=?", sup.id); }
    } finally { try { await sup.api.dispose(); } catch (_) {} }
  });

  test("a reveal made BEFORE enrolling in a compete event never widens the competitor's export — neither key, explanation nor hint — while the same session's export carried them before the enrolment (CONTROL)", async () => {
    const T = tag("exp");
    const { sealedId: sBank } = await makePair(author, T);
    const ev = await makeCompetition(sa, saCsrf, "expcompete", { duration_minutes: 120, staff_compete: true });
    // The event's own copy: what the rival answers, and (with `?competitionId=`)
    // what the event's export carries.
    const sT = await ownCopy(author, sBank, ev.id);
    // A rival on that board submits the key, so the Submissions stream and its
    // search have something a competitor must not read (final review: the
    // export was the only surface this rule was locked on).
    const rivalP = await makeParticipant(sa, saCsrf, "exprival");
    const standP = await makeParticipant(sa, saCsrf, "expstander");
    await enrol(sa, saCsrf, ev.id, [rivalP.id, standP.id]);
    {
      const rs = await signIn(rivalP.email);
      try {
        const sel = await rs.api.post("/api/select-competition", { headers: H(rs.csrf), data: { competitionId: ev.id } });
        expect(sel.ok(), await sel.text()).toBeTruthy();
        const sub = await rs.api.post(`/api/tasks/${sT}/submit`, { headers: H(rs.csrf), data: { answer: `SEALKEY_${T}`, gradingHash: await gradingHashFor(rs.api, sT) } });
        expect(sub.ok(), await sub.text()).toBeTruthy();
        expect((await sub.json()).correct, "PRECONDITION: the rival submitted the key").toBe(true);
      } finally { await rs.api.dispose(); }
    }
    const sup = await makeTier(sa, saCsrf, "expsup", "superadmin");
    const subs = async () => (await sup.api.get(`/api/admin/submissions?competitionId=${ev.id}`)).text();
    const qTotal = async () => (await (await sup.api.get(`/api/admin/submissions?competitionId=${ev.id}&q=${encodeURIComponent(`SEALKEY_${T}`)}`)).json()).total;
    const hist = async () => (await sup.api.get(`/api/admin/tasks/${sT}/versions`)).text();
    try {
      const rv = await reveal(sup, sT);
      expect(rv.status(), await rv.text()).toBe(200);
      const before = await (await sup.api.get(`/api/admin/export/tasks?competitionId=${ev.id}`)).text();
      expect(before, "CONTROL: revealed and not competing — the export carries the key").toContain(`SEALKEY_${T}`);
      expect(before).toContain(`SEALWHY_${T}`);
      expect(await subs(), "CONTROL: …the Submissions stream shows the rival's key").toContain(`SEALKEY_${T}`);
      expect(await qTotal(), "CONTROL: …the search finds it").toBe(1);
      expect(await hist(), "CONTROL: …and the history carries it").toContain(`SEALKEY_${T}`);
      const as = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [sup.id], competitionIds: [ev.id] } });
      expect(as.ok(), await as.text()).toBeTruthy();
      expect(dbGet("SELECT 1 x FROM competition_users WHERE competition_id=? AND user_id=?", ev.id, sup.id), "the superadmin now competes").toBeTruthy();
      const r = await row(sup, sT);
      expect(r.competing_in.map(c => c.id), "the list agrees: a competitor").toContain(ev.id);
      const after = await (await sup.api.get(`/api/admin/export/tasks?competitionId=${ev.id}`)).text();
      expect(after, "no key to a competitor, whatever the marker says").not.toContain(`SEALKEY_${T}`);
      expect(after, "no explanation").not.toContain(`SEALWHY_${T}`);
      expect(after, "no hint").not.toContain(`SEALHINT_${T}`);
      const er = JSON.parse(after).tasks.find(x => x.title === r.title);
      expect(er.correct_answer).toBeNull();
      expect(er.hint_withheld).toBe(1);
      // The same rule on the two other surfaces that honour a reveal.
      expect(await subs(), "the Submissions stream withholds a rival's key from a competitor").not.toContain(`SEALKEY_${T}`);
      expect(await qTotal(), "…and its search cannot confirm it").toBe(0);
      const h = await hist();
      expect(h, "the history withholds the key").not.toContain(`SEALKEY_${T}`);
      expect(h, "…the explanation").not.toContain(`SEALWHY_${T}`);
      expect(h, "…and the hint").not.toContain(`SEALHINT_${T}`);
    } finally { try { await sup.api.dispose(); } catch (_) {} }
  });
});

test.describe("v8.12.2 pre-release review — the record itself", () => {

  test("a sealed challenge with NO explanation: the reveal names only the fields it has — answer and hint — in the response and the History row", async () => {
    const T = tag("nox");
    const r = await author.api.post("/api/admin/tasks", {
      headers: H(author.csrf),
      data: { title: uniq(`NoWhy ${T}`), description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: `NOXKEY_${T}`, hint: `<p>NOXHINT_${T}</p>`, status: "published", answer_sealed: true },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const id = (await r.json()).id;
    const rv = await reveal(boss, id);
    expect(rv.status(), await rv.text()).toBe(200);
    expect((await rv.json()).fields, "no explanation to reveal, so none is claimed").toEqual(["correct_answer", "hint"]);
    expect(JSON.parse(lastReveal(id).details).fields).toEqual(["correct_answer", "hint"]);
  });

  test("the record is written BEFORE the marker: a failing History write leaves the session sealed out, and the retry is a real reveal that records", async () => {
    const T = tag("rbm");
    const { sealedId: sT } = await makePair(author, T);
    const sup = await makeTier(sa, saCsrf, "rbmsup", "superadmin");
    const trig = `zz_abort_reveal_${T}`;
    try {
      dbRun(`CREATE TRIGGER ${trig} BEFORE INSERT ON task_versions WHEN NEW.change_type='sealed_reveal' AND NEW.task_id='${sT}' BEGIN SELECT RAISE(ABORT,'injected'); END;`);
      try {
        const rv = await reveal(sup, sT);
        expect(rv.status(), "the failed record fails the request").toBe(500);
        expect(revealRows(sT)).toBe(0);
        const r = await row(sup, sT);
        expect(r.correct_answer, "the session was NOT granted an unrecorded reveal").toBeUndefined();
        expect(r.hint).toBeUndefined();
        expect(r.answer_revealed).toBeUndefined();
        expect(r.can_reveal_answer, "…and is offered it again").toBe(true);
      } finally { dbRun(`DROP TRIGGER IF EXISTS ${trig}`); }
      const again = await reveal(sup, sT);
      expect(again.status(), await again.text()).toBe(200);
      expect((await again.json()).already, "the retry is a REAL reveal, not the idempotent no-op").toBeUndefined();
      expect(revealRows(sT), "…and it records").toBe(1);
      expect((await row(sup, sT)).correct_answer).toBe(`SEALKEY_${T}`);
    } finally { try { await sup.api.dispose(); } catch (_) {} }
  });

  test("the SEAT is stored as an id and named per reader: an organiser who shares no event with the impersonated participant reads `acting_as_withheld`; one who does, and a superadmin, read the email; a deleted account reads `acting_as_deleted` and no email survives in the table", async () => {
    const T = tag("seat");
    const { sealedId: sT } = await makePair(author, T);
    const mine = await makeCompetition(sa, saCsrf, "seatmine", { duration_minutes: 120 });
    const theirs = await makeCompetition(sa, saCsrf, "seattheirs", { duration_minutes: 120, reveal_answers_on_end: true });
    // ONE row held by both events (the previous model, through the test hook):
    // the rule is about a reader of a challenge's History whose own event shares
    // the challenge but not the participant — with event-owned copies each event's
    // History is its own, so the shared row is built the way an older database holds it.
    await withLegacySharedAssign(sa, saCsrf, () => assignTask(author.api, author.csrf, sT, [mine.id, theirs.id]));
    const eaP = await makeParticipant(sa, saCsrf, "seatea");
    await grantEventAdmin(sa, saCsrf, mine.id, eaP.id);
    const ea = { ...eaP, ...(await signIn(eaP.email)) };
    const outside = await makeParticipant(sa, saCsrf, "seatout");   // only in THEIRS
    const shared = await makeParticipant(sa, saCsrf, "seatboth");   // in THEIRS and MINE
    await enrol(sa, saCsrf, theirs.id, [outside.id, shared.id]);
    await enrol(sa, saCsrf, mine.id, [shared.id]);
    const sup = await makeTier(sa, saCsrf, "seatsup", "superadmin");
    try {
      const end = await sa.post(`/api/admin/competitions/${theirs.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), await end.text()).toBeTruthy();
      for (const target of [outside, shared]) {
        const imp = await sup.api.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(sup.csrf) });
        expect(imp.ok(), await imp.text()).toBeTruthy();
        sup.csrf = (await (await sup.api.get("/api/csrf-token")).json()).csrfToken;
        const sel = await sup.api.post("/api/select-competition", { headers: H(sup.csrf), data: { competitionId: theirs.id } });
        expect(sel.ok(), await sel.text()).toBeTruthy();
        expect(await (await sup.api.get(`/api/tasks/${sT}`)).text(), "shown through the target").toContain(`SEALKEY_${T}`);
        const ex = await sup.api.post("/api/impersonation/exit", { headers: H(sup.csrf) });
        expect(ex.ok(), await ex.text()).toBeTruthy();
        sup.csrf = (await (await sup.api.get("/api/csrf-token")).json()).csrfToken;
      }
      const raw = withDb(db => db.prepare("SELECT details FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'").all(sT)).map(x => x.details).join("\n");
      expect(raw, "the permanent table holds ids").toContain(outside.id);
      expect(raw, "…never an email").not.toContain(outside.email);
      expect(raw).not.toContain(shared.email);
      const seatOf = (list, id) => list.filter(v => v.change_type === "sealed_reveal").map(v => v.details);
      const eaHist = await (await ea.api.get(`/api/admin/tasks/${sT}/versions`)).text();
      expect(eaHist, "the organiser never reads the outside participant's email").not.toContain(outside.email);
      expect(eaHist, "…nor their id").not.toContain(outside.id);
      const eaSeats = seatOf(JSON.parse(eaHist));
      expect(eaSeats).toContainEqual(expect.objectContaining({ impersonated_by: sup.email, acting_as_withheld: true }));
      expect(eaSeats, "CONTROL: the participant they share an event with IS named").toContainEqual(expect.objectContaining({ acting_as: shared.email }));
      for (const d of eaSeats) expect("acting_as_id" in d, "the stored id never reaches the wire").toBe(false);
      const saSeats = seatOf(await (await sa.get(`/api/admin/tasks/${sT}/versions`)).json());
      expect(saSeats.map(d => d.acting_as).sort(), "an unscoped reader reads both").toEqual([outside.email, shared.email].sort());
      // Erasure: the account goes, and its address with it.
      const del = await sa.delete(`/api/admin/participants/${outside.id}`, { headers: H(saCsrf) });
      expect(del.ok(), await del.text()).toBeTruthy();
      const afterDel = seatOf(await (await sa.get(`/api/admin/tasks/${sT}/versions`)).json());
      expect(afterDel).toContainEqual(expect.objectContaining({ acting_as_deleted: true }));
      expect(JSON.stringify(afterDel)).not.toContain(outside.email);
    } finally { for (const c of [ea, sup]) { try { await c.api.dispose(); } catch (_) {} } }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.12.2 SECOND REVIEW — the fixes to the fixes. Each arm pins one confirmed
// finding of the adversarial review of the first review's fix delta.
// ─────────────────────────────────────────────────────────────────────────────

/** A participant in `compId`, signed in and inside the event. */
async function inEvent(label, compId) {
  const p = await makeParticipant(sa, saCsrf, label);
  await enrol(sa, saCsrf, compId, [p.id]);
  const ctx = { ...p, ...(await signIn(p.email)) };
  const sel = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition ${label}: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  return ctx;
}
/** Impersonate `targetId` (participant view unless `view` says otherwise) and, optionally, enter `compId`. */
async function impersonate(ctx, targetId, compId, view) {
  const imp = await ctx.api.post(`/api/admin/participants/${targetId}/impersonate`, { headers: H(ctx.csrf), data: view ? { view } : {} });
  expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
  if (compId) {
    const sel = await ctx.api.post("/api/select-competition", { headers: H(ctx.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select-competition as the target: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  }
}
async function exitImp(ctx) {
  const ex = await ctx.api.post("/api/impersonation/exit", { headers: H(ctx.csrf) });
  expect(ex.ok(), `exit: ${ex.status()} ${await ex.text()}`).toBeTruthy();
  ctx.csrf = (await (await ctx.api.get("/api/csrf-token")).json()).csrfToken;
}

test.describe("v8.12.2 second review — the participant surface asks about the HAND, and says why", () => {

  test("a NON-competing superadmin impersonating a participant of a compete event IS shown the hint that participant paid for, and may reveal one for an unpaid one — both recorded; a superadmin who competes in ANOTHER event holding the challenge is withheld it with the reason `competing_elsewhere` (CONTROL)", async () => {
    // Findings 0/7: the first fix asked `competitorIds(req)` — seat AND hand —
    // and under participant-view impersonation the seat is the TARGET, so every
    // participant of a compete event counted as a "competitor" and a superadmin
    // looking through one was shown nothing sealed, with a false 403.
    const T = tag("hand");
    const { sealedId: sBank } = await makePair(author, T);
    const E = await makeCompetition(sa, saCsrf, "handE", { duration_minutes: 120, staff_compete: true });
    const F = await makeCompetition(sa, saCsrf, "handF", { duration_minutes: 120 });
    // Each event holds its OWN copy (sT in E, sF in F); the competitor lock
    // follows the lineage, so competing in E withholds F's copy too.
    const _cp = Object.fromEntries((await assignTask(author.api, author.csrf, sBank, [E.id, F.id])).copies.map(c => [c.competition_id, c.task_id]));
    const sT = _cp[E.id], sF = _cp[F.id];
    const payer = await inEvent("handpayer", E.id);
    const unpaid = await inEvent("handunpaid", E.id);
    const pF = await inEvent("handpf", F.id);
    const buy = await payer.api.post(`/api/tasks/${sT}/hint`, { headers: H(payer.csrf) });
    expect(buy.ok(), `the E participant buys the sealed hint (they compete): ${await buy.text()}`).toBeTruthy();
    expect(hintRows(payer.id, sT), "PRECONDITION: a real paid row").toBe(1);
    const sup = await makeTier(sa, saCsrf, "handsup", "superadmin");
    const supC = await makeTier(sa, saCsrf, "handsupc", "superadmin");
    await enrol(sa, saCsrf, E.id, [supC.id]);
    expect(dbGet("SELECT 1 x FROM competition_users WHERE competition_id=? AND user_id=?", E.id, supC.id), "PRECONDITION: supC competes in E").toBeTruthy();
    try {
      const n0 = revealRows(sT);
      await impersonate(sup, payer.id, E.id);
      const g = await (await sup.api.get(`/api/tasks/${sT}`)).json();
      expect(g.hint, "the hint the TARGET paid for is shown to a non-competing superadmin").toContain(`SEALHINT_${T}`);
      expect(g.hint_withheld).toBeUndefined();
      expect(revealRows(sT), "…on the record").toBe(n0 + 1);
      await exitImp(sup);
      await impersonate(sup, unpaid.id, E.id);
      const b = await sup.api.post(`/api/tasks/${sT}/hint`, { headers: H(sup.csrf) });
      expect(b.ok(), `…and may reveal it for an unpaid participant of the compete event: ${await b.text()}`).toBeTruthy();
      expect((await b.json()).hint).toContain(`SEALHINT_${T}`);
      expect(revealRows(sT), "…recorded").toBe(n0 + 2);
      await exitImp(sup);
      // CONTROL — the HAND competes: supC, in E, looks at F (which holds the same
      // challenge) through pF's account: withheld, and the reason is the lock.
      await impersonate(supC, pF.id, F.id);
      const c = await (await supC.api.get(`/api/tasks/${sF}`)).json();
      expect(c.hint, "CONTROL: a competing superadmin is shown no sealed hint anywhere").toBeUndefined();
      expect(c.hint_withheld).toBe(true);
      expect(c.hint_withheld_reason, "…and told the true reason").toBe("competing_elsewhere");
      const cb = await supC.api.post(`/api/tasks/${sF}/hint`, { headers: H(supC.csrf) });
      expect(cb.status()).toBe(403);
      const cbj = await cb.json();
      expect(cbj.code).toBe("answer_sealed_not_author");
      expect(cbj.reason).toBe("competing_elsewhere");
      expect(cbj.error, "the refusal names the competitor lock, not 'here as staff'").toMatch(/competing in an event that holds this challenge/);
      expect(revealRows(sT), "nothing recorded for the competitor").toBe(n0 + 2);
      expect(revealRows(sF), "…on F's copy either").toBe(0);
      await exitImp(supC);
    } finally { for (const c of [payer, unpaid, pF, sup, supC]) { try { await c.api.dispose(); } catch (_) {} } }
  });

  test("`hint_withheld_reason` is `impersonating` for a regular admin looking through a payer's account and `not_competing` for an admin in their own participant view — and the paid route's 403 carries the same reason", async () => {
    const T = tag("why");
    const { sealedId: sT } = await makePair(author, T);
    const comp = await makeCompetition(sa, saCsrf, "whyev", { duration_minutes: 120 });
    await assignTask(author.api, author.csrf, sT, [comp.id]);
    const payer = await inEvent("whypayer", comp.id);
    expect((await payer.api.post(`/api/tasks/${sT}/hint`, { headers: H(payer.csrf) })).ok(), "PRECONDITION: the participant pays").toBeTruthy();
    const adm = await makeTier(sa, saCsrf, "whyadm", "admin");
    const adm2 = await makeTier(sa, saCsrf, "whyadm2", "admin");
    try {
      await impersonate(adm, payer.id, comp.id);
      const g = await (await adm.api.get(`/api/tasks/${sT}`)).json();
      expect(g.hint_withheld).toBe(true);
      expect(g.hint_withheld_reason).toBe("impersonating");
      await exitImp(adm);
      await asParticipantView(adm2, comp.id);
      const g2 = await (await adm2.api.get(`/api/tasks/${sT}`)).json();
      expect(g2.hint_withheld_reason).toBe("not_competing");
      const b2 = await adm2.api.post(`/api/tasks/${sT}/hint`, { headers: H(adm2.csrf) });
      expect(b2.status()).toBe(403);
      expect((await b2.json()).reason).toBe("not_competing");
    } finally { for (const c of [payer, adm, adm2]) { try { await c.api.dispose(); } catch (_) {} } }
  });

  test("the sealed-hint refusal comes AFTER 'no hint' and 'locked': a sealed challenge with no hint answers 400, a locked one 423 — never a claim that a non-existent hint is sealed", async () => {
    // Findings 1/8.
    const T = tag("ord");
    const mk = await author.api.post("/api/admin/tasks", {
      headers: H(author.csrf),
      data: { title: uniq(`NoHint ${T}`), description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: `ORDKEY_${T}`, status: "published", answer_sealed: true },
    });
    expect(mk.ok(), await mk.text()).toBeTruthy();
    const noHintBank = (await mk.json()).id;
    const { sealedId: lockedBank } = await makePair(author, `${T}l`);
    const comp = await makeCompetition(sa, saCsrf, "ordev", { duration_minutes: 120 });
    // The event's own copies: the lock below is the event's question's.
    const noHint = await ownCopy(author, noHintBank, comp.id);
    const locked = await ownCopy(author, lockedBank, comp.id);
    const adm = await makeTier(sa, saCsrf, "ordadm", "admin");
    const lk = await sa.post(`/api/admin/tasks/${locked}/lock`, { headers: H(saCsrf) });
    expect(lk.ok(), await lk.text()).toBeTruthy();
    expect(dbGet("SELECT locked FROM tasks WHERE id=?", locked).locked, "PRECONDITION: locked").toBe(1);
    try {
      await asParticipantView(adm, comp.id);
      const g = await (await adm.api.get(`/api/tasks/${noHint}`)).json();
      expect(g.hint_available).toBe(false);
      expect(g.hint_withheld, "GET: nothing is withheld where there is nothing").toBeUndefined();
      const b = await adm.api.post(`/api/tasks/${noHint}/hint`, { headers: H(adm.csrf) });
      expect(b.status(), "POST agrees with GET: there is no hint").toBe(400);
      expect((await b.json()).error).toMatch(/no hint/i);
      const l = await adm.api.post(`/api/tasks/${locked}/hint`, { headers: H(adm.csrf) });
      expect(l.status(), "a locked challenge answers 'locked' first").toBe(423);
      // CONTROL — the same reader on an unlocked sealed challenge WITH a hint is refused by the seal.
      const { sealedId: plainSealed } = await makePair(author, `${T}c`);
      await assignTask(author.api, author.csrf, plainSealed, [comp.id]);
      const c = await adm.api.post(`/api/tasks/${plainSealed}/hint`, { headers: H(adm.csrf) });
      expect(c.status(), "CONTROL: the seal still refuses where there is a hint").toBe(403);
    } finally {
      await sa.post(`/api/admin/tasks/${locked}/lock`, { headers: H(saCsrf) }).catch(() => {});
      try { await adm.api.dispose(); } catch (_) {}
    }
  });
});

test.describe("v8.12.2 second review — the seat in History, per reader", () => {

  test("a CO-ORGANISER reads the seat's name through the organisers arm, an organiser of another event reads it withheld WITH NO `via`, a zero-grant organiser reads their OWN seat through the seat arm, and a superadmin reads everything", async () => {
    // Finding 4: each visibility arm had a test only where another arm also
    // admitted the reader, so neither was locked. Finding 6: a withheld seat
    // still carried `via: impersonated_admin_view`, naming the KIND of account.
    const T = tag("arms");
    const { sealedId: sT } = await makePair(author, T);
    const mine = await makeCompetition(sa, saCsrf, "armsmine", { duration_minutes: 120 });
    const yours = await makeCompetition(sa, saCsrf, "armsyours", { duration_minutes: 120 });
    await assignTask(author.api, author.csrf, sT, [mine.id, yours.id]);
    const ea1 = await makeParticipant(sa, saCsrf, "armsea1");
    const ea2 = await makeParticipant(sa, saCsrf, "armsea2");
    const ea3 = await makeParticipant(sa, saCsrf, "armsea3");
    await grantEventAdmin(sa, saCsrf, mine.id, ea1.id);
    await grantEventAdmin(sa, saCsrf, mine.id, ea2.id);
    await grantEventAdmin(sa, saCsrf, yours.id, ea3.id);
    for (const p of [ea1, ea2, ea3]) expect(dbGet("SELECT 1 x FROM competition_users WHERE user_id=?", p.id), `PRECONDITION: ${p.email} holds no enrolment row — the organisers arm is the only way in`).toBeUndefined();
    // The zero-grant organiser and a public-domain sealed challenge they can see.
    const z = await makeParticipant(sa, saCsrf, "armszero");
    const zr = await sa.post(`/api/admin/participants/${z.id}/role`, { headers: H(saCsrf), data: { role: "event_admin" } });
    expect(zr.ok(), await zr.text()).toBeTruthy();
    expect(dbGet("SELECT COUNT(*) c FROM competition_admins WHERE user_id=?", z.id).c, "PRECONDITION: no grants").toBe(0);
    const { sealedId: zT } = await makePair(author, `${T}z`);
    const tg = await author.api.post(`/api/admin/tasks/${zT}/tags`, { headers: H(author.csrf), data: { tag: "public-domain" } });
    expect(tg.ok(), await tg.text()).toBeTruthy();
    const sup = await makeTier(sa, saCsrf, "armssup", "superadmin");
    const [r2, r3, rz] = [await signIn(ea2.email), await signIn(ea3.email), await signIn(z.email)];
    try {
      await impersonate(sup, ea1.id, null, "admin");
      expect((await reveal(sup, sT)).status(), "reveal through ea1's panel").toBe(200);
      await exitImp(sup);
      await impersonate(sup, z.id, null, "admin");
      expect((await reveal(sup, zT)).status(), "reveal through the zero-grant organiser's panel").toBe(200);
      await exitImp(sup);
      const seats = async (ctx, id) => (await (await ctx.get(`/api/admin/tasks/${id}/versions`)).json()).filter(v => v.change_type === "sealed_reveal").map(v => v.details);
      const co = await seats(r2.api, sT);
      expect(co, "the CO-ORGANISER is named the seat (competition_admins arm)").toContainEqual(expect.objectContaining({ acting_as: ea1.email, via: "impersonated_admin_view" }));
      const other = await seats(r3.api, sT);
      expect(other).toContainEqual(expect.objectContaining({ acting_as_withheld: true }));
      for (const d of other) {
        expect("via" in d, "a withheld seat carries no `via` — it would say the hidden account is an organiser").toBe(false);
        expect(JSON.stringify(d)).not.toContain(ea1.email);
      }
      const self = await seats(rz.api, zT);
      expect(self, "the zero-grant organiser reads their OWN seat (the seat arm alone)").toContainEqual(expect.objectContaining({ acting_as: z.email }));
      const su = await seats(sa, sT);
      expect(su).toContainEqual(expect.objectContaining({ acting_as: ea1.email, via: "impersonated_admin_view" }));
    } finally { for (const c of [sup, r2, r3, rz]) { try { await c.api.dispose(); } catch (_) {} } }
  });

  test("once the seat's account is DELETED every reader — scoped ones included — reads `acting_as_deleted`, never 'outside your events'", async () => {
    // Finding 2: visibility for a scoped reader is read from the enrolment rows
    // the deletion removes, so asking visibility first told an organiser whose
    // own participant it had been that the seat was "outside your events".
    const T = tag("gone");
    const { sealedId: sBank } = await makePair(author, T);
    const mine = await makeCompetition(sa, saCsrf, "gonemine", { duration_minutes: 120, reveal_answers_on_end: true });
    const sT = await ownCopy(author, sBank, mine.id);   // the event's own copy: its History carries the seat
    const eaP = await makeParticipant(sa, saCsrf, "goneea");
    await grantEventAdmin(sa, saCsrf, mine.id, eaP.id);
    const seat = await makeParticipant(sa, saCsrf, "goneseat");
    await enrol(sa, saCsrf, mine.id, [seat.id]);
    const sup = await makeTier(sa, saCsrf, "gonesup", "superadmin");
    const ea = await signIn(eaP.email);
    try {
      const end = await sa.post(`/api/admin/competitions/${mine.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), await end.text()).toBeTruthy();
      await impersonate(sup, seat.id, mine.id);
      expect(await (await sup.api.get(`/api/tasks/${sT}`)).text(), "shown through the seat").toContain(`SEALKEY_${T}`);
      await exitImp(sup);
      const seats = async () => (await (await ea.api.get(`/api/admin/tasks/${sT}/versions`)).json()).filter(v => v.change_type === "sealed_reveal").map(v => v.details);
      expect(await seats(), "PRECONDITION: the organiser names their own participant").toContainEqual(expect.objectContaining({ acting_as: seat.email }));
      const del = await sa.delete(`/api/admin/participants/${seat.id}`, { headers: H(saCsrf) });
      expect(del.ok(), await del.text()).toBeTruthy();
      const after = await seats();
      expect(after, "the organiser is told the account is gone").toContainEqual(expect.objectContaining({ acting_as_deleted: true }));
      for (const d of after) expect(d.acting_as_withheld, "…never that it is outside their events").toBeUndefined();
      expect(JSON.stringify(after)).not.toContain(seat.email);
    } finally { for (const c of [sup, ea]) { try { await c.api.dispose(); } catch (_) {} } }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.12.2 FINAL REVIEW — the grant's other doors, and the forced exit.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.2 final review — the reveal's grant at every door, and where it ends", () => {

  test("a revealed superadmin publishes, hides, recalculates, tags, untags and import-overwrites a sealed challenge as its author would — and the same superadmin before the reveal is refused at every one of those doors (CONTROL)", async () => {
    // Finding 10: the grant was exercised on the list, versions, export,
    // submissions, PUT, unseal and restore only; replacing `sealRevealedFor(…)`
    // with `false` at these six doors left every test green.
    const T = tag("doors");
    const mk = await author.api.post("/api/admin/tasks", {
      headers: H(author.csrf),
      data: { title: uniq(`Doors ${T}`), description: "<p>d</p>", difficulty: "easy", answer_type: "text",
        correct_answer: `DOORKEY_${T}`, hint: `<p>DOORHINT_${T}</p>`, status: "draft", answer_sealed: true },
    });
    expect(mk.ok(), await mk.text()).toBeTruthy();
    const id = (await mk.json()).id;
    const title = (await row(author, id)).title;
    const tg = await author.api.post(`/api/admin/tasks/${id}/tags`, { headers: H(author.csrf), data: { tag: `pre${T}`.toLowerCase().slice(0, 40) } });
    expect(tg.ok(), `PRECONDITION: a tag to remove: ${await tg.text()}`).toBeTruthy();
    const preTag = `pre${T}`.toLowerCase().slice(0, 40);
    const sup = await makeTier(sa, saCsrf, "doorssup", "superadmin");
    const file = { type: "hackarena-tasks", version: 1, tasks: [{ title, description: `<p>OVERWRITTEN_${T}</p>`, difficulty: "easy", answer_type: "text", correct_answer: `DOORKEY_${T}`, status: "draft", active: 1, tags: [] }] };
    const importOverwrite = async () => {
      const dry = await sup.api.post("/api/admin/import/tasks", { headers: H(sup.csrf), data: { data: file } });
      expect(dry.ok(), `dry run: ${await dry.text()}`).toBeTruthy();
      const conflicts = (await dry.json()).conflicts;
      expect(conflicts.map(c => c.index), "PRECONDITION: the row conflicts by title").toEqual([0]);
      const run = await sup.api.post("/api/admin/import/tasks", { headers: H(sup.csrf), data: { data: file, resolutions: { "0": "overwrite" } } });
      expect(run.ok(), `import: ${await run.text()}`).toBeTruthy();
      return run.json();
    };
    const doors = {
      publish: () => sup.api.post(`/api/admin/tasks/${id}/publish`, { headers: H(sup.csrf) }),
      visibility: () => sup.api.patch(`/api/admin/tasks/${id}/visibility`, { headers: H(sup.csrf) }),
      recalculate: () => sup.api.post(`/api/admin/tasks/${id}/recalculate`, { headers: H(sup.csrf), data: {} }),
      tagAdd: () => sup.api.post(`/api/admin/tasks/${id}/tags`, { headers: H(sup.csrf), data: { tag: `sup${T}`.toLowerCase().slice(0, 40) } }),
      tagRemove: () => sup.api.delete(`/api/admin/tasks/${id}/tags/${encodeURIComponent(preTag)}`, { headers: H(sup.csrf) }),
    };
    try {
      for (const [name, go] of Object.entries(doors)) {
        const r = await go();
        expect(r.status(), `CONTROL — before the reveal, ${name} is refused`).toBe(403);
        expect((await r.json()).code, `${name}: the seal's code`).toBe("answer_sealed_not_author");
      }
      const pre = await importOverwrite();
      expect(pre.sealed_skipped, "CONTROL — before the reveal, the overwrite is the seal's skip").toBe(1);
      expect(pre.overwritten).toBe(0);
      expect((await reveal(sup, id)).status()).toBe(200);
      for (const [name, go] of Object.entries(doors)) {
        const r = await go();
        expect(r.status(), `after the reveal, ${name} goes through as the author's would: ${await r.text()}`).toBe(200);
      }
      expect(dbGet("SELECT status FROM tasks WHERE id=?", id).status, "published").toBe("published");
      const tags = withDb(db => db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(id)).map(x => x.tag);
      expect(tags, "the superadmin's tag landed").toContain(`sup${T}`.toLowerCase().slice(0, 40));
      expect(tags, "…and the author's was removed").not.toContain(preTag);
      // Sweep #87 — the overwrite keeps the seal (its UPDATE never writes
      // `answer_sealed`), so it may not make the challenge an Any answer, a seal
      // over no key (tagged qualifying, one no report may read): skipped and
      // counted apart. The text row below is the CONTROL.
      const anyFile = { type: "hackarena-tasks", version: 1, tasks: [{ title, description: "<p>any</p>", difficulty: "easy", answer_type: "any",
        choices: [{ id: "a1b2c3d4", text: "Yes" }, { id: "e5f6a7b8", text: "No" }], status: "published", active: 1, tags: ["qualifying:sweep87"] }] };
      const anyRun = await sup.api.post("/api/admin/import/tasks", { headers: H(sup.csrf), data: { data: anyFile, resolutions: { "0": "overwrite" } } });
      expect(anyRun.ok(), `import: ${await anyRun.text()}`).toBeTruthy();
      const anyOut = await anyRun.json();
      expect([anyOut.sealed_type_skipped, anyOut.overwritten, anyOut.skipped], "a sealed challenge is never made an Any answer: counted apart").toEqual([1, 0, 0]);
      expect(dbGet("SELECT answer_type, answer_sealed FROM tasks WHERE id=?", id), "…and the row is as it was").toEqual({ answer_type: "text", answer_sealed: 1 });
      const post = await importOverwrite();
      expect(post.overwritten, "and the import overwrites it as the author's would").toBe(1);
      expect(post.sealed_type_skipped, "CONTROL: a type a seal can hold is not that skip").toBe(0);
      expect(dbGet("SELECT description FROM tasks WHERE id=?", id).description).toContain(`OVERWRITTEN_${T}`);
    } finally { try { await sup.api.dispose(); } catch (_) {} }
  });

  test("a reveal made through an organiser's seat ends with the FORCED exit too: when the organiser is demoted mid-session, the superadmin's own restored session is sealed out again", async () => {
    // Finding 9: `restoreImpersonatorSession` deletes `sealedReveals` so a reveal
    // made in an organiser's seat does not follow the superadmin home on the
    // in-place forced exit; nothing tested it.
    const T = tag("fx");
    const { sealedId: sT } = await makePair(author, T);
    const mine = await makeCompetition(sa, saCsrf, "fxmine", { duration_minutes: 120 });
    await assignTask(author.api, author.csrf, sT, [mine.id]);
    const eaP = await makeParticipant(sa, saCsrf, "fxea");
    await grantEventAdmin(sa, saCsrf, mine.id, eaP.id);
    const sup = await makeTier(sa, saCsrf, "fxsup", "superadmin");
    try {
      await impersonate(sup, eaP.id, null, "admin");
      expect((await reveal(sup, sT)).status(), "revealed through the seat").toBe(200);
      const through = await row(sup, sT);
      expect(through.correct_answer, "PRECONDITION: the key is shown through the seat").toBe(`SEALKEY_${T}`);
      dbRun("UPDATE users SET role='participant' WHERE id=?", eaP.id);
      dbRun("DELETE FROM competition_admins WHERE user_id=?", eaP.id);
      const forced = await sup.api.get("/api/admin/tasks");
      expect(forced.status(), "the admin surface forces the exit").toBe(403);
      expect(await forced.json()).toMatchObject({ error: "impersonation_ended" });
      const me = await (await sup.api.get("/api/admin/me")).json();
      expect(me.impersonation?.active, "PRECONDITION: the superadmin is back in their own session").toBeFalsy();
      const home = await row(sup, sT);
      expect(home, "the challenge is on the superadmin's own list").toBeTruthy();
      expect(home.correct_answer, "the seat's reveal did NOT follow them home").toBeUndefined();
      expect(home.answer_revealed).toBeUndefined();
      expect(home.can_reveal_answer, "…and they are offered the reveal again").toBe(true);
    } finally { try { await sup.api.dispose(); } catch (_) {} }
  });
});
