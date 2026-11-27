// @ts-check
//
// v8.11.1 — EIGHT EXTERNAL-AUDIT FINDINGS, ONE LOCK EACH.
//
// Every one was reproduced against the real code before it was fixed, and every
// verdict was then handed to an independent reviewer told to refute it; all eight
// survived. What they have in common is the reason none of them was already
// covered: each is a rule the codebase states somewhere and applies one site
// short of everywhere.
//
//   F1  logout destroys the session row without writing the revocation tombstone,
//       so an in-flight request re-creates it — the ONE guarantee CLAUDE.md
//       describes as closed by construction.
//   F2  `sanitiseAvatar` PERSISTS, and registration called it as a predicate.
//   F3  the submit transaction re-reads the task and never the actor.
//   F4  the group-create seed is a fourth way into membership that the
//       three-way scope check never learned about.
//   F5  deleting a shared group reconciles events its owner cannot see.
//   F6  a queued CxOne job builds its request from a captured row nobody re-reads.
//   F7  the share client still branches on the kind, a rule v8.6.2 retired.
//   F8  the backup certifies a directory with no database in it.
//
// EVERY ARM CARRIES A CONTROL, because each of these fixes is a REFUSAL, and
// "the request was refused" is equally satisfied by a build that refuses
// everything. The controls are the half that would catch that.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const { request } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { apiLogin, freshCtx, gradingHashFor, pngDataUri, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, grantEventAdmin, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// F1 — LOGOUT MUST REVOKE, NOT MERELY DELETE
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F1 — a logout cannot be undone by a request already in flight", () => {

  test("the original cookie is dead after logout, even though a slow request saved the session afterwards", async () => {
    const { api, csrf } = await freshCtx();
    try {
      // A participant of our own — never a seeded fixture, which other tests
      // block, re-password and tag.
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      let p;
      try { p = await makeParticipant(sa, saCsrf, "f1"); } finally { await sa.dispose(); }

      const li = await codeLogin(api, p.email, H(csrf));
      expect(li.ok(), `login: ${li.status()} ${await li.text()}`).toBeTruthy();
      const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      expect((await api.get("/api/me")).status(), "PRECONDITION: the session works").toBe(200);

      // Hold a request open that has already loaded this session and will save
      // it at res.end — the shape a slow upload or an SMTP fan-out produces.
      const slow = api.post("/api/test/slow-session-write", { headers: H(c2), data: { delayMs: 2500 } });
      await new Promise(r => setTimeout(r, 400));

      // Log out from a SECOND context carrying the same cookie, so the original
      // context's in-flight request is genuinely concurrent with the destroy.
      const lo = await api.post("/api/logout", { headers: H(c2) });
      expect(lo.ok(), "the logout itself succeeded").toBeTruthy();
      await slow;

      // PRE-FIX: the in-flight save re-created the row and this answered 200.
      expect((await api.get("/api/me")).status(),
        "the logged-out cookie must not authenticate, whatever saved after it").toBe(401);
      expect((await api.get("/api/admin/me")).status()).toBe(401);
    } finally { await api.dispose(); }
  });

  test("CONTROL: an ordinary logout with nothing in flight is unchanged, and a fresh login still works", async () => {
    // Without this, "the cookie is dead" is satisfied by a build where logout
    // broke sign-in altogether.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, saCsrf, "f1c"); } finally { await sa.dispose(); }

    const { api, csrf } = await freshCtx();
    try {
      expect((await codeLogin(api, p.email, H(csrf))).ok()).toBeTruthy();
      const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      expect((await api.post("/api/logout", { headers: H(c2) })).ok()).toBeTruthy();
      expect((await api.get("/api/me")).status()).toBe(401);
    } finally { await api.dispose(); }

    // …and the account can sign in again on a new session.
    const { api: again, csrf: ac } = await freshCtx();
    try {
      expect((await codeLogin(again, p.email, H(ac))).ok(),
        "logout must revoke the session, not the account").toBeTruthy();
      expect((await again.get("/api/me")).status()).toBe(200);
    } finally { await again.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F2 — A VALIDATION CHECK MUST NOT WRITE
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F2 — a sign-up stores no image: a photo is refused before anything is written", () => {
  // The sign-up takes a preset picture or nothing; a photo is chosen in the
  // profile afterwards. A refused sign-up must leave neither an image row (there
  // is no sweeper for `images`) nor an account behind.
  const imageCount = () => dbGet("SELECT COUNT(*) c FROM images").c;
  const body = (over) => ({
    firstName: "Av", lastName: "Atar", company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer",
    city: "NYC", password: PARTICIPANT_PASS, ...over,
  });

  test("a sign-up carrying a photo is refused and leaves no image row and no account", async () => {
    const { api, csrf } = await freshCtx();
    try {
      const before = imageCount();
      const email = `f2photo-${uniq("")}@acme.com`;
      const r = await registerPost(api, "/api/register", { headers: H(csrf), data: body({
        nickname: uniq("f2photo"), email, avatar: pngDataUri(24, "f2-avatar"),
      }) });
      expect(r.status(), `a photo at sign-up is refused: ${await r.text()}`).toBe(400);
      expect((await r.json()).code).toBe("avatar_not_accepted");
      expect(imageCount() - before, "no image row is written").toBe(0);
      expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=?", email).c, "and no account").toBe(0);
    } finally { await api.dispose(); }
  });

  test("CONTROL: the same sign-up with a preset picture succeeds and stores no image", async () => {
    const { api, csrf } = await freshCtx();
    try {
      const before = imageCount();
      const email = `f2ok-${uniq("")}@acme.com`;
      const r = await registerPost(api, "/api/register", { headers: H(csrf), data: body({ nickname: uniq("f2ok"), email, avatar: "🦉" }) });
      expect(r.status(), `registration should succeed: ${await r.text()}`).toBe(200);
      expect(imageCount() - before, "a preset is not an image").toBe(0);
      expect(dbGet("SELECT avatar FROM users WHERE email=?", email).avatar, "the preset is kept").toBe("🦉");
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F3 — AUTHORISATION IS RE-ASKED AT COMMIT TIME
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F3 — blocking or unenrolling stops a submission that is already in flight", () => {
  let sa, saCsrf, compId, taskId;

  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    compId = (await makeCompetition(sa, saCsrf, "f3", { start_time: iso(-3600_000), duration_minutes: 240 })).id;
    const tr = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      // A FILE answer, deliberately: `POST /api/test/submit-read-delay` parks the
      // handler inside the file branch (server.js, right after the upload is read),
      // which is the ONLY place a submit is suspended long enough for an admin to
      // act — and it is the window the finding is about. A text submit never
      // reaches the hook (v7.21.22 records the same trap).
      title: `F3 ${uniq("t")}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "file", correct_answer: "win", status: "published" } });
    expect(tr.ok(), `task: ${tr.status()} ${await tr.text()}`).toBeTruthy();
    const bankId = (await tr.json()).id;
    const asn = await sa.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H(saCsrf), data: { competitionIds: [compId] } });
    expect(asn.ok()).toBeTruthy();
    taskId = (await asn.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js): the row an answer names
  });
  test.afterAll(async () => { await sa?.dispose(); });

  /** A participant of our own, enrolled, entered, with a live submit in hand. */
  async function armed(label) {
    const p = await makeParticipant(sa, saCsrf, label);
    await enrol(sa, saCsrf, compId, [p.id]);
    const { api, csrf } = await freshCtx();
    expect((await codeLogin(api, p.email, H(csrf))).ok()).toBeTruthy();
    const c = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    expect((await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } })).ok()).toBeTruthy();
    return { p, api, csrf: c, hash: await gradingHashFor(api, taskId) };
  }
  /** The real upload path — a file part, which is what reaches the parked branch. */
  const fileSubmit = (a) => a.api.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": a.csrf },
    multipart: { gradingHash: a.hash, file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("win") } },
  });
  const rows = (uid) => dbGet("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=?", uid, taskId).c;

  test("a participant BLOCKED while their submission is in flight is refused, and scores nothing", async () => {
    const a = await armed("f3b");
    try {
      // Park the handler inside the window the real defect lives in — between
      // the guards (which ran at request entry) and the write transaction.
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 2500 } });
      const submit = fileSubmit(a);
      await new Promise(r => setTimeout(r, 500));
      const blk = await sa.post(`/api/admin/participants/${a.p.id}/block`, { headers: H(saCsrf) });
      expect(blk.ok(), `block: ${blk.status()} ${await blk.text()}`).toBeTruthy();

      const r = await submit;
      expect(r.status(), "a blocked participant's suspended submission must be refused").toBe(403);
      expect((await r.json()).error).toMatch(/blocked/i);
      expect(rows(a.p.id), "and nothing was written").toBe(0);
    } finally {
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => {});
      await a.api.dispose();
    }
  });

  test("a participant UNENROLLED while their submission is in flight is refused, and scores nothing", async () => {
    const a = await armed("f3u");
    try {
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 2500 } });
      const submit = fileSubmit(a);
      await new Promise(r => setTimeout(r, 500));
      const rm = await sa.delete(`/api/admin/competitions/${compId}/users/${a.p.id}`, { headers: { "x-csrf-token": saCsrf } });
      expect(rm.ok(), `remove: ${rm.status()} ${await rm.text()}`).toBeTruthy();
      expect((await rm.json()).removed, "PRECONDITION: the removal really happened").toBe(true);

      const r = await submit;
      expect(r.status(), "an unenrolled participant's suspended submission must be refused").toBe(403);
      expect((await r.json()).error).toMatch(/not assigned/i);
      expect(rows(a.p.id), "and nothing was written").toBe(0);
    } finally {
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => {});
      await a.api.dispose();
    }
  });

  test("CONTROL: the same delayed submission from an untouched participant still commits and scores", async () => {
    // Without this, both arms above pass on a build where the delay hook simply
    // broke submitting.
    const a = await armed("f3ok");
    try {
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 2500 } });
      const r = await fileSubmit(a);
      expect(r.status(), await r.text()).toBe(200);
      const d = await r.json();
      expect(d.correct, "an entitled participant is unaffected").toBe(true);
      expect(d.pointsDelta).toBeGreaterThan(0);
      expect(rows(a.p.id)).toBe(1);
    } finally {
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => {});
      await a.api.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F4 + F5 — THE EVENT-ADMIN GROUP BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F4/F5 — group creation and deletion respect the event-admin scope", () => {
  let sa, saCsrf, mine, theirs, ea, eaApi, eaCsrf, inMine, inTheirs;

  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    mine   = (await makeCompetition(sa, saCsrf, "f45mine",   { start_time: iso(-3600_000), duration_minutes: 240 })).id;
    theirs = (await makeCompetition(sa, saCsrf, "f45theirs", { start_time: iso(-3600_000), duration_minutes: 240 })).id;
    ea      = await makeParticipant(sa, saCsrf, "f45ea");
    inMine  = await makeParticipant(sa, saCsrf, "f45in");
    inTheirs = await makeParticipant(sa, saCsrf, "f45out");
    await enrol(sa, saCsrf, mine,   [ea.id, inMine.id]);
    await enrol(sa, saCsrf, theirs, [inTheirs.id]);
    const rr = await sa.post(`/api/admin/participants/${ea.id}/role`, { headers: H(saCsrf), data: { role: "event_admin" } });
    expect(rr.ok(), `role: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    await grantEventAdmin(sa, saCsrf, mine, ea.id);

    ({ api: eaApi, csrf: eaCsrf } = await freshCtx());
    expect((await codeLogin(eaApi, ea.email, H(eaCsrf))).ok()).toBeTruthy();
    eaCsrf = (await (await eaApi.get("/api/csrf-token")).json()).csrfToken;
  });
  test.afterAll(async () => { await eaApi?.dispose(); await sa?.dispose(); });

  test("F4: creating a group SEEDED with an out-of-scope participant is refused, exactly as adding one is", async () => {
    // The CONTROL first, and it is the whole comparison: the members route
    // already refuses this target, so the create accepting it was the drift.
    const g = await eaApi.post("/api/admin/groups", { headers: H(eaCsrf), data: { name: `F4 base ${uniq("")}` } });
    expect(g.ok(), `a seedless create must still work: ${await g.text()}`).toBeTruthy();
    const gid = (await g.json()).group.id;
    const add = await eaApi.post(`/api/admin/groups/${gid}/members`, { headers: H(eaCsrf), data: { userIds: [inTheirs.id] } });
    expect(add.status(), "CONTROL: the members route refuses the out-of-scope target").toBe(403);

    const seeded = await eaApi.post("/api/admin/groups", {
      headers: H(eaCsrf), data: { name: `F4 seeded ${uniq("")}`, userIds: [inTheirs.id] } });
    expect(seeded.status(), "the create seed is the same act and must get the same answer").toBe(403);

    // …and no group was made, so the read-back that leaked the email does not exist.
    const list = await (await eaApi.get("/api/admin/groups")).json();
    expect(list.some(x => /F4 seeded/.test(x.name)), "the refused create wrote nothing").toBe(false);
  });

  test("F4 CONTROL: a seed the actor CAN see is still accepted", async () => {
    const r = await eaApi.post("/api/admin/groups", {
      headers: H(eaCsrf), data: { name: `F4 ok ${uniq("")}`, userIds: [inMine.id] } });
    expect(r.ok(), `an in-scope seed must still work: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).group.member_count, "and really adds them").toBe(1);
  });

  test("F5: deleting a group SHARED with another organiser's event is refused, as renaming it already was", async () => {
    const g = await eaApi.post("/api/admin/groups", { headers: H(eaCsrf), data: { name: `F5 shared ${uniq("")}` } });
    const gid = (await g.json()).group.id;
    // A superadmin binds the actor's own group to an event they do not manage —
    // the ordinary way a group becomes shared.
    const bindA = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [gid], competitionIds: [mine] } });
    expect(bindA.ok(), `bind mine: ${await bindA.text()}`).toBeTruthy();
    const bindB = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [gid], competitionIds: [theirs] } });
    expect(bindB.ok(), `bind theirs: ${await bindB.text()}`).toBeTruthy();

    // PRECONDITION — the rename is refused today, and that asymmetry is the finding.
    const ren = await eaApi.put(`/api/admin/groups/${gid}`, { headers: H(eaCsrf), data: { name: `F5 renamed ${uniq("")}` } });
    expect(ren.status(), "PRECONDITION: a rename is already refused").toBe(403);

    const del = await eaApi.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": eaCsrf } });
    expect(del.status(), "the delete is the louder act and must be refused too").toBe(403);
    expect((await del.json()).code).toBe("event_admin_group_shared");
    expect(dbGet("SELECT 1 x FROM groups WHERE id=?", gid), "the group survives the refusal").toBeTruthy();
    // The client's own answer moves with it, so no button is offered for it.
    const listed = (await (await eaApi.get("/api/admin/groups")).json()).find(x => x.id === gid);
    expect(listed.can_delete, "the row stops offering a delete the server would refuse").toBe(false);
  });

  test("F5 CONTROL: a group bound only to the actor's OWN event still deletes", async () => {
    // Without this, "the delete is refused" is satisfied by a build where an
    // event admin can never delete anything.
    const g = await eaApi.post("/api/admin/groups", { headers: H(eaCsrf), data: { name: `F5 own ${uniq("")}` } });
    const gid = (await g.json()).group.id;
    const bind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [gid], competitionIds: [mine] } });
    expect(bind.ok()).toBeTruthy();
    const del = await eaApi.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": eaCsrf } });
    expect(del.ok(), `an in-scope group must still be deletable: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect(dbGet("SELECT 1 x FROM groups WHERE id=?", gid)).toBeFalsy();
  });

  test("F5 CONTROL: a NON-owner still gets the ownership refusal, not the sharing one", async () => {
    // Ownership is asked FIRST, so the message a non-owner meets is unchanged.
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `F5 notmine ${uniq("")}` } });
    const gid = (await g.json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [gid], competitionIds: [mine] } });
    const del = await eaApi.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": eaCsrf } });
    expect(del.status()).toBe(403);
    expect((await del.json()).code).toBe("event_admin_not_owner");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F6 — SOURCE-PINNED, AND ANCHORED ASK BY ASK (re-pointed at v8.12.6)
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F6 — a queued CxOne job re-reads the user it was queued for", () => {
  test("the provisioning chokepoint re-asks after EVERY await, each ask anchored to the await it guards", () => {
    // v8.12.6 (external audit F2) RE-POINTED THIS, same subject, new truth. F6
    // shipped with three asks and this lock counted three; the group lookup, its
    // body read, the grant and the 409 searches are awaits too, and a deletion
    // landing in any of them still reached the grant (measured).
    //
    // WHY A SOURCE LOCK STILL EXISTS BESIDE THE BEHAVIOURAL ONE. This header used
    // to say the path was behaviourally unreachable because "require-cache
    // transport stubbing … the harness rules forbid in a spec". That is true of a
    // Playwright WORKER and false of a spawned child, which is what
    // tests/cxone-grant-after-delete.spec.js now does — it is the lock on the
    // BEHAVIOUR. This one pins the PLACEMENT, which the behavioural arms can only
    // see for the awaits a stub can land a deletion inside.
    //
    // ANCHORED, NOT COUNTED, and that is the whole design. A bare "some ask
    // between A and B" is vacuous twice over: the `_erasedMidFlight` DEFINITION
    // contains `_userStillExists(` and sits before the token await (so a count or
    // an unanchored window is satisfied by the definition), and the per-search ask
    // sits between the create and the group lookup (so the lookup's own ask can be
    // deleted with that window still green — measured on the design review). So
    // ASK matches CALL SITES only — the F6 statement shape, or `_erasedMidFlight()`
    // with its empty parens, which the definition `= () =>` never contains — and
    // each window runs from one await to the next.
    //
    // COMMENTS STRIPPED FIRST, line-preserving: the fix narrates every ask in
    // prose that names `_userStillExists` and `_createdHereId`, and a scanner that
    // reads its own explanation reports a clean tree against a broken one (v7.21.13).
    const raw = fs.readFileSync(path.join(ROOT, "lib/cxone.js"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) =>
      pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
    const fnAt = src.indexOf("async function cxOneProvisionUser");
    expect(fnAt, "cxOneProvisionUser is gone — this lock needs re-anchoring").toBeGreaterThan(-1);
    const fn = src.slice(fnAt, src.indexOf("function sanitiseCxOneError", fnAt));

    const at = (needle, from = 0) => {
      const i = fn.indexOf(needle, from);
      if (i < 0) throw new Error(`anchor missing from cxOneProvisionUser: ${needle} — re-anchor this lock rather than weakening it`);
      return i;
    };
    const ERASED = /if\s*\(\s*user\?\.id\s*&&\s*!_userStillExists\(user\.id\)\s*\)\s*return\s*;|_erasedMidFlight\(\)/;
    // The scope re-check must be ACTED ON, not merely called: either the silent
    // top-of-function return, or its answer tested and abandoned on at once — a
    // call whose result is dropped would satisfy a bare name match.
    const SCOPE = new RegExp(
      String.raw`if\s*\(\s*_provisioningScopeRevoked\(\s*user\?\.id\s*,\s*competitionId\s*\)\s*\)\s*return\s*;`
      + String.raw`|const\s+(\w+)\s*=\s*_provisioningScopeRevoked\(\s*user\?\.id\s*,\s*competitionId\s*\)\s*;`
      + String.raw`\s*if\s*\(\s*\1\s*\)\s*\{\s*await\s+_abandon\([^;]*\1\s*\)\s*;\s*return\s*;`);
    const has = (a, b, re) => a < b && re.test(fn.slice(a, b));

    const tokenAt = at("await cxOneGetBearerToken"), createAt = at("`${adminBase}/users`", tokenAt);
    const loopAt = at("for (const query of", createAt), searchAt = at("`${adminBase}/users?${query}`", loopAt);
    const nameAt = at("default_cxone_group_name", searchAt), lookupAt = at("`${adminBase}/groups?search=", nameAt);
    const bodyAt = at("await groupsResp.json()", lookupAt), grantAt = at("/groups/${target.id}`", bodyAt);
    const writeAt = at("UPDATE competition_users SET cxone_username", grantAt);
    // The creation-baseline reads (an account THIS job created, read back after
    // the grant). Anchored AFTER the grant: the same URL literal is `_abandon`'s
    // DELETE, earlier in the function.
    const base1At = at("/users/${encodeURIComponent(_createdHereId)}`", grantAt), base2At = at("/role-mappings`", base1At);
    const catchAt = at("} catch (err) {", writeAt), logAt = at("console.error(\"CxOne provisioning error:\"", catchAt);
    const failAt = at("success: false", catchAt);
    const compBlockAt = at("if (competitionId) {", searchAt);

    const windows = {
      "erasure asked BEFORE the token fetch, so no PII leaves at all": has(0, tokenAt, ERASED),
      "…and again after it — the deadline is 10 s, the delete lands inside it": has(tokenAt, createAt, ERASED),
      "membership / event / opt-out asked BEFORE the token fetch (the queue wait)": has(0, tokenAt, SCOPE),
      "…and again after it, before POST /users sends the name and email": has(tokenAt, createAt, SCOPE),
      "erasure asked at the top of EVERY search iteration, before its fetch": has(loopAt, searchAt, ERASED),
      "erasure asked after the create/searches, before the group lookup": has(nameAt, lookupAt, ERASED),
      "erasure asked AFTER the lookup's body read, before the grant (the finding)": has(bodyAt, grantAt, ERASED),
      "membership / event / opt-out asked after the lookup's body read, before the grant": has(bodyAt, grantAt, SCOPE),
      "erasure asked after the grant, before the write-back and the audit row": has(grantAt, writeAt, ERASED),
      // Anti-vacuity first: windows over anchors out of order check nothing.
      "the creation-baseline reads sit after the grant and before the write-back, in order":
        grantAt < base1At && base1At < base2At && base2At < writeAt,
      "erasure asked after the grant, before the first creation-baseline read": has(grantAt, base1At, ERASED),
      "…after the account's read-back, before its role-mappings read": has(base1At, base2At, ERASED),
      "…and after the role-mappings read, before the write-back and the audit row": has(base2At, writeAt, ERASED),
      "erasure asked in the catch BEFORE the console line (it names the email)": has(catchAt, logAt, ERASED),
      // …and ACTED on there: the answer must reach the on_error abandon before the
      // console line, not merely be computed (a dropped `if (_gone)` keeps the call).
      "…and the catch abandons BEFORE the console line": has(catchAt, logAt, /_abandon\(\s*"on_error"/),
      "…and so before the failure row too": logAt < failAt,
      "an event deleted mid-flight THROWS rather than falling back to the global group":
        /if\s*\(\s*!comp\s*\)\s*throw\b/.test(fn.slice(compBlockAt, nameAt)),
      "…and ONLY a missing event does — an existing event with no group still falls back":
        !/if\s*\(\s*!comp\s*\|\|/.test(fn.slice(compBlockAt, nameAt)),
      // The ONLY realm account ever withdrawn is one whose id came back on OUR OWN
      // 201: `_createdHereId` is initialised once and assigned once more, inside
      // the Location branch — never on a search match.
      "the withdrawable id is assigned exactly twice (init + the Location branch)":
        (fn.match(/_createdHereId\s*=(?!=)/g) || []).length === 2
        && /locMatch\)\s*\{[^}]*_createdHereId\s*=\s*cxUserId/.test(fn),
      "…and only an ERASURE withdraws — never a removal, an event deletion or an opt-out":
        /reason\s*===\s*"user_deleted"\s*&&\s*_createdHereId/.test(fn),
    };
    const failing = Object.entries(windows).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "lib/cxone.js lost a mid-flight re-check (or moved one off the await it guards):\n  " + failing.join("\n  ")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.12.7 (external audit F2) — THE REALM ACCOUNT A JOB CREATES IS WRITTEN DOWN
// ═══════════════════════════════════════════════════════════════════════════
// Beside F6 on purpose: the same subject (what a provisioning job may do to the
// customer's realm) and the same shape of lock (a PLACEMENT, anchored, which the
// behavioural arms in tests/cxone-erasure-withdrawal.spec.js can only see for
// the paths a stub reaches). Both arms strip comments first, keeping lines —
// the fix narrates `_createdHereId`, `_stillMine` and `_livingBinder` in prose,
// and a scanner that reads its own explanation passes a broken tree (v7.21.13).
test.describe("v8.12.7 F2 — the realm accounts the platform creates are recorded, handed over and withdrawn only when still ours", () => {
  const strip = (raw) => raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) =>
    pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
  // A block by INDENTATION, not by brace counting: log strings and template
  // literals inside these bodies carry braces, and the codebase closes every
  // block at the indent it opened at. The header must be the start of its line.
  const block = (src, headerAt, what) => {
    if (headerAt < 0) throw new Error(`anchor missing: ${what} — re-anchor this lock rather than weakening it`);
    const lineStart = src.lastIndexOf("\n", headerAt) + 1;
    const indent = src.slice(lineStart, headerAt).match(/^[ \t]*/)[0];
    const close = src.indexOf(`\n${indent}}`, headerAt);
    if (close < 0) throw new Error(`no closing brace at the header's indent: ${what}`);
    return src.slice(headerAt, close + indent.length + 2);
  };
  const read = (rel) => strip(fs.readFileSync(path.join(ROOT, rel), "utf8"));

  test("lib/cxone.js records ONLY our own 201's Location id, the moment it is known, and re-keys an account it MATCHED", () => {
    // Without the record a later erasure has nothing to withdraw — the harm F2
    // is about. Without the gate a 409-matched or search-found account (which
    // cannot be proven ours) would be recorded and later DELETED from the
    // customer's realm: the one thing worse than leaving an account behind.
    const src = read("lib/cxone.js");
    const fnAt = src.indexOf("async function cxOneProvisionUser");
    expect(fnAt, "cxOneProvisionUser is gone — this lock needs re-anchoring").toBeGreaterThan(-1);
    const fn = src.slice(fnAt, src.indexOf("function sanitiseCxOneError", fnAt));

    const ensure = block(fn, fn.search(/const\s+_ensureLedger\s*=\s*\(\)\s*=>\s*\{/), "const _ensureLedger");
    const guard = ensure.search(
      /if\s*\(\s*_createStatus\s*!==\s*201\s*\|\|\s*!UUID_RE\.test\(\s*_createdHereId\s*\)\s*\)\s*\{[^}]*return\s*;/);
    const rec = ensure.search(/recordCreated\(\s*db\s*,\s*\{[^}]*cxoneUserId\s*:\s*_createdHereId\s*,/);
    const ifAccepted = block(fn, fn.search(/if\s*\(\s*accepted\s*\)\s*\{/), "if (accepted) {");

    // Every recorder call site, across the server: exactly one, in cxone.js.
    const recorders = [];
    for (const dir of ["lib", "routes"]) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith(".js"))) {
        const s = read(`${dir}/${f}`);
        const n = (s.match(/(?<!function\s)\brecordCreated\s*\(/g) || []).length;
        for (let i = 0; i < n; i++) recorders.push(`${dir}/${f}`);
      }
    }
    for (const rel of ["server.js", "db.js"]) {
      if ((read(rel).match(/\brecordCreated\s*\(/g) || []).length) recorders.push(rel);
    }

    const checks = {
      "the create's own status is what the gate reads (`_createStatus = createResp.status`)":
        /_createStatus\s*=\s*createResp\.status\s*;/.test(fn),
      "_ensureLedger refuses anything but a 201 carrying a UUID Location id, BEFORE it records":
        guard > -1 && rec > -1 && guard < rec,
      "…and what it records is `_createdHereId` — never cxUserId, never a match":
        rec > -1,
      "_ensureLedger is called INSIDE the Location branch, right after `_createdHereId = cxUserId`":
        /if\s*\(\s*locMatch\s*\)\s*\{[^}]*_createdHereId\s*=\s*cxUserId\s*;[^}]*_ensureLedger\(\s*\)/.test(fn),
      "the only recordCreated call site on the server is the one in lib/cxone.js":
        recorders.length === 1 && recorders[0] === "lib/cxone.js",
      "a MATCHED account is re-keyed to its living holder inside `if (accepted) {`":
        /transferTo\(\s*db\s*,\s*accepted\.id\s*,\s*user\.id\s*,/.test(ifAccepted),
      "…and transferTo is called nowhere else in the job (a pre-acceptance transfer would steal a stranger's row)":
        (fn.match(/\btransferTo\s*\(/g) || []).length === 1,
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, "lib/cxone.js lost the ledger's placement:\n  " + failing.join("\n  ")).toEqual([]);
    // `_createdHereId` still assigned exactly twice is F6's assertion above —
    // not repeated here, so one regression reports once.
  });

  test("the runner re-asks ownership AND the living binder after its last await, with no await between them and the DELETE", () => {
    // The runner awaits a token, the realm's user record and its federated
    // identities before it deletes. A deletion undone, a dismissal, a transfer
    // or a participant bound to the account in any of those windows must stop
    // the DELETE — and only a check with no await after it can see all of them.
    // A check moved one await earlier passes every behavioural arm whose stub
    // does not land inside the LAST window (the F6 lesson, v8.12.6).
    const src = read("lib/cxone-withdraw.js");
    const body = block(src, src.search(/async\s+function\s+_withdrawOne\s*\(/), "async function _withdrawOne(");
    const OWNED = /if\s*\(\s*!_stillMine\(\s*row\s*,\s*claim\s*\)\s*\|\|\s*_userExists\(\s*row\.user_id\s*\)\s*\)\s*return\s*;/;
    const BINDER = /const\s+(\w+)\s*=\s*_livingBinder\(\s*id\s*\)\s*;\s*if\s*\(\s*\1\s*\)\s*\{[^}]*\breturn\s*;\s*\}/;

    const deletes = [...body.matchAll(/method\s*:\s*"DELETE"/g)].map(m => m.index);
    // Anti-vacuity: a rename would leave no DELETE to judge and pass in silence.
    expect(deletes.length, "_withdrawOne sends a realm DELETE").toBeGreaterThanOrEqual(1);
    const awaits = [...body.matchAll(/\bawait\b/g)].map(m => m.index);
    for (const del of deletes) {
      const own = awaits.filter(a => a < del).pop();
      // The await found must be the DELETE statement's OWN, not an earlier one.
      expect(own, "the DELETE is awaited").toBeDefined();
      expect(body.slice(own, del), "the await found is the DELETE fetch's own").not.toContain(";");
      const prev = awaits.filter(a => a < own).pop();
      expect(prev, "there is an await before the DELETE for the gate to follow").toBeDefined();
      const win = body.slice(prev, own);
      expect(OWNED.test(win), "ownership (claim still held, participant still gone) is re-asked after the last await before the DELETE").toBe(true);
      expect(BINDER.test(win), "a living binder is re-asked there too, and ACTED on (handed over, then return)").toBe(true);
    }
  });

  test("v8.13.1: the provisioning job's own withdrawal asks whether the account passed to somebody living, ACTS on it, and awaits nothing before its DELETE", () => {
    // The external audit's reproduction (tests/cxone-replacement-takeover.spec.js):
    // a replacement participant's provisioning matched the account while THIS
    // job was suspended on an upstream call, and `_abandon` deleted it anyway.
    // `_withdrawalOwnershipLost` is the runner's pre-DELETE gate applied to the
    // one other place that removes a realm account, and like the runner's it is
    // only worth anything with NO await between its answer and the DELETE — the
    // behavioural arms land the take-over inside the job's suspended call, which
    // a check moved behind a new await would pass while the window reopened.
    // And it must be ACTED on: a call whose answer is dropped (or tested and
    // then fallen through) keeps the name and loses the protection.
    const src = read("lib/cxone.js");
    const fnAt = src.indexOf("async function cxOneProvisionUser");
    expect(fnAt, "cxOneProvisionUser is gone — this lock needs re-anchoring").toBeGreaterThan(-1);
    const fn = src.slice(fnAt, src.indexOf("function sanitiseCxOneError", fnAt));
    const abandon = block(fn, fn.search(/const\s+_abandon\s*=\s*async\s*\(/), "const _abandon = async (");

    const deletes = [...abandon.matchAll(/method\s*:\s*"DELETE"/g)].map(m => m.index);
    // Anti-vacuity: a rename would leave no DELETE to judge and pass in silence.
    expect(deletes.length, "_abandon sends the job's in-flight withdrawal DELETE").toBeGreaterThanOrEqual(1);
    // …and a DELETE the job sends from anywhere else would escape this lock.
    expect((fn.match(/method\s*:\s*"DELETE"/g) || []).length, "every DELETE the provisioning job sends is _abandon's").toBe(deletes.length);
    const awaits = [...abandon.matchAll(/\bawait\b/g)].map(m => m.index);
    const ASK = /(\w+)\s*=\s*_withdrawalOwnershipLost\(\s*_createdHereId\s*,\s*user\.id\b/g;
    for (const del of deletes) {
      const own = awaits.filter(a => a < del).pop();
      expect(own, "the DELETE is awaited").toBeDefined();
      expect(abandon.slice(own, del), "the await found is the DELETE fetch's own").not.toContain(";");
      const ask = [...abandon.matchAll(ASK)].filter(m => m.index < own).pop();
      expect(ask, "the job asks _withdrawalOwnershipLost(_createdHereId, user.id, …) before its DELETE, and keeps the answer").toBeDefined();
      expect(awaits.filter(a => a > ask.index && a < own), "NO await between the ownership answer and the DELETE fetch").toEqual([]);
      // ACTED ON — three accepted shapes, so a correct refactor is not flagged:
      // the DELETE sits in the `else` of `if (<answer>) {…}`; `if (<answer>)`
      // returns before it; or the DELETE's block is guarded by `!<answer>` as
      // one of its conjuncts. Anything else reaches the DELETE whatever the
      // answer said.
      const v = ask[1];
      const between = abandon.slice(ask.index, own);
      let acted = false;
      const ifAt = between.search(new RegExp(String.raw`\bif\s*\(\s*${v}\s*\)`));
      if (ifAt > -1) {
        const ifAbs = ask.index + ifAt;
        const head = abandon.slice(ifAbs).match(new RegExp(String.raw`^if\s*\(\s*${v}\s*\)\s*(return\b|\{)`));
        if (head && head[1] === "return") acted = true;
        else if (head) {
          const ifBlock = block(abandon, ifAbs, `if (${v}) {`);
          const after = ifAbs + ifBlock.length;
          if (/^\s*else\b/.test(abandon.slice(after))) {
            const elseAt = after + abandon.slice(after).indexOf("else");
            const elseBlock = block(abandon, elseAt, "else");
            acted = del > elseAt && del < elseAt + elseBlock.length;
          } else {
            acted = /\breturn\s*;\s*\}$/.test(ifBlock);
          }
        }
      }
      if (!acted) {
        const NOT = new RegExp(String.raw`(?:^|&&)\s*!\s*${v}\s*(?:&&|$)`);
        for (const m of between.matchAll(/\bif\s*\(([^{};]*)\)\s*\{/g)) {
          if (!NOT.test(m[1].trim())) continue;
          const at = ask.index + m.index;
          if (del > at && del < at + block(abandon, at, "if (!…) {").length) { acted = true; break; }
        }
      }
      expect(acted, `the DELETE is reached only when \`${v}\` is falsy (inside its else, after a return, or under \`!${v}\`)`).toBe(true);
    }
  });
  test("v8.14: both removers ANNOUNCE before their DELETE with no await between, and the job asks before it links, writes back or fails", () => {
    // The behavioural arms (tests/cxone-replacement-takeover.spec.js) land a
    // replacement INSIDE the remover's DELETE and inside the job's suspended
    // calls; a check moved one await earlier passes every arm whose stub does not
    // land in the LAST window (the F6 lesson). So the placement is pinned too:
    //   • each DELETE (runner, `_abandon`) is preceded, after its previous await,
    //     by `beginRealmRemoval` — acted on — and its answer is settled at once;
    //   • `realmRemovalBlock(accepted.id)` comes before `transferTo` with NO await
    //     between, and the deferral it records is acted on after the loop;
    //   • the write-back asks after the last await before the binding UPDATE;
    //   • the catch asks before the failure is logged or recorded;
    //   • the runner's hand-over (`_transfer`) asks before it re-keys.
    const W = read("lib/cxone-withdraw.js"), C = read("lib/cxone.js");
    const fnAt = C.indexOf("async function cxOneProvisionUser");
    expect(fnAt, "cxOneProvisionUser is gone — this lock needs re-anchoring").toBeGreaterThan(-1);
    const fn = C.slice(fnAt, C.indexOf("function sanitiseCxOneError", fnAt));
    const awaitsIn = (s) => [...s.matchAll(/\bawait\b/g)].map(m => m.index);
    const failing = [];
    const check = (ok, what) => { if (!ok) failing.push(what); };

    // Anti-vacuity: exactly the two removers announce, nowhere else.
    const begins = [...(W + "\n" + C).matchAll(/(?<!function\s)\bbeginRealmRemoval\s*\(/g)].length;
    check(begins === 2, `beginRealmRemoval is called by exactly the two removers (found ${begins})`);

    // ── The runner ──
    const body = block(W, W.search(/async\s+function\s+_withdrawOne\s*\(/), "async function _withdrawOne(");
    const dels = [...body.matchAll(/method\s*:\s*"DELETE"/g)].map(m => m.index);
    check(dels.length === 1, "_withdrawOne sends one DELETE");
    for (const del of dels) {
      const aw = awaitsIn(body);
      const own = aw.filter(a => a < del).pop(), prev = aw.filter(a => a < own).pop();
      const win = body.slice(prev, own);
      const b = win.search(/if\s*\(\s*!beginRealmRemoval\(\s*id\s*,\s*chosen\s*\)\s*\)\s*return\s*;/);
      const binderAt = win.search(/const\s+\w+\s*=\s*_livingBinder\(\s*id\s*\)\s*;/);
      check(b > -1, "the runner announces its removal after its last await before the DELETE, and returns when it may not");
      check(b > binderAt && binderAt > -1, "…AFTER its last ownership checks (the living binder), in the same synchronous block");
      const after = body.slice(own);
      check(/catch\s*\(\s*_\s*\)\s*\{\s*settleRealmRemoval\(\s*id\s*,\s*"unknown"\s*\)/.test(after),
        "a DELETE with no answer is settled `unknown` first thing in its catch");
      check(/const\s+ds\s*=\s*dResp\.status\s*;\s*const\s+outcome\s*=\s*settleRealmRemoval\(\s*id\s*,\s*classifyRealmRemoval\(\s*ds\s*\)\s*\)/.test(after),
        "an answered DELETE is settled through the one classifier before anything else");
      check(/finally\s*\{\s*if\s*\(\s*begun\s*\)\s*\{\s*try\s*\{\s*settleRealmRemoval\(\s*id\s*,\s*"unknown"\s*\)/.test(body),
        "a run that leaves a removal announced settles it `unknown` in its finally");
    }
    const xfer = block(W, W.search(/^function\s+_transfer\s*\(/m), "function _transfer(");
    const xBlk = xfer.search(/realmRemovalBlock\(\s*row\.cxone_user_id\s*\)/), xTo = xfer.search(/\btransferTo\s*\(/);
    check(xBlk > -1 && xTo > xBlk && !/\bawait\b/.test(xfer), "the runner's hand-over asks the registry before it re-keys");

    // ── The job's own withdrawal ──
    const abandon = block(fn, fn.search(/const\s+_abandon\s*=\s*async\s*\(/), "const _abandon = async (");
    const aDel = abandon.search(/method\s*:\s*"DELETE"/);
    const aOwn = awaitsIn(abandon).filter(a => a < aDel).pop();
    const askAt = abandon.search(/skipped\s*=\s*_withdrawalOwnershipLost\(/);
    const aBegin = abandon.search(/if\s*\(\s*!\s*skipped\s*&&\s*!beginRealmRemoval\(\s*_createdHereId\s*,\s*cfg\s*\)\s*\)\s*skipped\s*=\s*"removal_in_flight"\s*;/);
    check(aBegin > askAt && askAt > -1 && aBegin < aOwn, "_abandon announces right after its ownership ask, and a refused announcement SKIPS the DELETE");
    check(awaitsIn(abandon).filter(a => a > askAt && a < aOwn).length === 0, "…with no await between the ask, the announcement and the DELETE");
    check(/finally\s*\{\s*outcome\s*=\s*settleRealmRemoval\(\s*_createdHereId\s*,\s*classifyRealmRemoval\(\s*status\s*\)\s*\)/.test(abandon.slice(aOwn)),
      "_abandon settles its DELETE through the one classifier, answered or not");

    // ── The job's match, write-back and catch ──
    const ifAccepted = block(fn, fn.search(/if\s*\(\s*accepted\s*\)\s*\{/), "if (accepted) {");
    const acc = /const\s+(\w+)\s*=\s*realmRemovalBlock\(\s*accepted\.id\s*\)\s*;\s*if\s*\(\s*\1\s*\)\s*\{[^\n]*\bbreak\s*;\s*\}/.exec(ifAccepted);
    const accTo = ifAccepted.search(/\btransferTo\s*\(/);
    check(!!acc && accTo > acc.index, "the match asks realmRemovalBlock(accepted.id) and leaves the loop BEFORE transferTo");
    check(!!acc && !/\bawait\b/.test(ifAccepted.slice(acc.index, accTo)), "…with no await between the ask and transferTo");
    check(((fn.match(/realmRemovalBlock\(\s*accepted\.id\s*\)/g) || []).length) === 1, "the match asks exactly once");
    const loopEnd = fn.indexOf("if (!cxUserId) {", fn.indexOf("for (const query of"));
    check(/if\s*\(\s*_deferral\s*\)\s*\{\s*await\s+_defer\(\s*_deferral\s*\)\s*;\s*return\s*;\s*\}/.test(fn.slice(fn.indexOf("for (const query of"), loopEnd)),
      "…and the deferral it recorded is acted on after the loop, before the not-found branch");
    const recordAsk = fn.indexOf('_abandon("before_record"');
    const writeAt = fn.indexOf("UPDATE competition_users SET cxone_username");
    const wb = /const\s+(\w+)\s*=\s*realmRemovalBlock\(\s*cxUserId\s*\)\s*;\s*if\s*\(\s*\1\s*\)\s*\{\s*await\s+_defer\([^;]*\)\s*;\s*return\s*;\s*\}/.exec(fn.slice(recordAsk));
    check(recordAsk > -1 && !!wb && recordAsk + wb.index < writeAt, "the write-back asks after the after-grant erasure ask, before the binding UPDATE");
    check(!!wb && !/\bawait\b/.test(fn.slice(recordAsk + wb.index + wb[0].length, writeAt)), "…and nothing is awaited between that ask and the write");
    const catchAt = fn.indexOf("} catch (err) {"), logAt = fn.indexOf('console.error("CxOne provisioning error:"', catchAt);
    const cb = /if\s*\(\s*(\w+)\s*\)\s*\{\s*await\s+_defer\(\s*\{\s*reason\s*:\s*\1\b[^;]*\)\s*;\s*return\s*;\s*\}/.exec(fn.slice(catchAt, logAt));
    check(catchAt > -1 && !!cb && /realmRemovalBlock\(\s*cxUserId\s*\)/.test(fn.slice(catchAt, logAt)), "the catch asks — and defers — before the failure is logged or recorded");

    expect(failing, "a removal in progress lost its placement:\n  " + failing.join("\n  ")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F7 — THE SHARE WAITS FOR THE PAGE IT IS ABOUT TO ADVERTISE
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F7 — a placement certificate's page is published before LinkedIn is opened", () => {
  let sa, saCsrf, token, pApi, COMP_ID;

  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    const compId = COMP_ID = (await makeCompetition(sa, saCsrf, "f7", { start_time: iso(-600_000), duration_minutes: 180 })).id;
    const tr = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      title: `F7 ${uniq("t")}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "win", status: "published" } });
    const taskId = (await tr.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(saCsrf), data: { competitionIds: [compId] } });
    const p = await makeParticipant(sa, saCsrf, "f7p");
    await enrol(sa, saCsrf, compId, [p.id]);

    const { api, csrf } = await freshCtx();
    pApi = api;
    expect((await codeLogin(api, p.email, H(csrf))).ok()).toBeTruthy();
    let c = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    expect((await api.post("/api/select-competition", { headers: H(c), data: { competitionId: compId } })).ok()).toBeTruthy();
    // The sole enrollee solving the sole challenge auto-ends the event, which is
    // what makes them rank 1 on a finished board — a placement badge.
    const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(c), data: { answer: "win", gradingHash: await gradingHashFor(api, taskId) } });
    expect((await sub.json()).correct, "the fixture must actually solve it").toBe(true);
    c = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const mint = await api.post(`/api/competitions/${compId}/badge`, { headers: H(c) });
    expect(mint.ok(), `mint: ${mint.status()} ${await mint.text()}`).toBeTruthy();
    const badge = await mint.json();
    expect(badge.basis, "PRECONDITION: this is the placement path, not the completion one").toBe("placement");
    token = badge.token;
    // THE FINDING'S PRECONDITION: the payload now says whether the page is live.
    expect(badge.published, "an unshared page is not published, and the payload says so").toBe(false);
  });
  test.afterAll(async () => { await pApi?.dispose(); await sa?.dispose(); });

  test("the page really is dark until the share lands, and the mint payload says which", async () => {
    // Pre-fix the client could not know this — the payload carried no field at
    // all, so it guessed from `basis` and guessed the pre-v8.6.2 answer.
    expect((await sa.get(`/badge/${token}`)).status(),
      "an unshared placement page 404s since v8.6.2 — the fact the client was missing").toBe(404);
    expect(dbGet("SELECT shared_at FROM achievement_badges WHERE token=?", token).shared_at).toBeFalsy();

    // CONTROL — the owner's share publishes it, so "404" is not satisfied by a
    // build where the page never works.
    const c = (await (await pApi.get("/api/csrf-token")).json()).csrfToken;
    const sh = await pApi.post(`/badge/${token}/shared`, { headers: H(c) });
    expect(sh.ok()).toBeTruthy();
    expect((await sh.json()).published).toBe(true);
    expect((await sa.get(`/badge/${token}`)).status()).toBe(200);

    // …and the MINT payload — the one the share dialog is driven by — now
    // reports it, which is what keeps the fire-and-forget path for a page that
    // is genuinely live. The mint is idempotent, so re-asking is how the held
    // certificate is retrieved.
    const c2 = (await (await pApi.get("/api/csrf-token")).json()).csrfToken;
    const again = await pApi.post(`/api/competitions/${COMP_ID}/badge`, { headers: H(c2) });
    expect(again.ok(), await again.text()).toBeTruthy();
    expect((await again.json()).published, "a published badge reports published").toBe(true);
  });

  test("the client waits on the PAGE, not on the kind — and says so when a copied link is not live", () => {
    // SOURCE-pinned, and the limit is stated rather than implied: the arm above
    // drives the server half end to end, but the defect the finding is NAMED for
    // is client ordering — the composer opening before the publish lands — and
    // reaching it in a browser needs the share dialog open on a minted placement
    // badge with the POST failed on purpose. What must not silently come back is
    // the DISCRIMINATOR, which is what v8.6.2 left stale, so that is what is
    // pinned.
    const c = fs.readFileSync(path.join(ROOT, "public/js/features/badge-share.js"), "utf8");
    const stripped = c.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, "$1");

    expect(stripped, "the fire-and-forget path is gated on the page being live")
      .toMatch(/if\(!sharedPath\|\|badge\.published===true\)/);
    expect(stripped, "and no longer on the event kind — the rule v8.6.2 retired")
      .not.toMatch(/badge\.basis!==['"]completion['"]/);
    // `=== true` strictly: a stale client or an older payload with no field must
    // fall to the SAFE await path, not to the fire-and-forget one.
    expect(stripped).not.toMatch(/if\(!sharedPath\|\|badge\.published\)/);
    // The copy affordance stops reporting success for a URL that answers nothing.
    expect(stripped, "copyBadgeLink consults the same flag")
      .toMatch(/copyBadgeLink[\s\S]{0,600}?published===true/);
    // ANTI-VACUITY: a rename would empty every match above and pass in silence.
    expect((c.match(/\.published===true/g) || []).length,
      "both consumers read the flag — the share gate and the copy affordance")
      .toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F8 — BACKUP_COMPLETE MEANS THE DATABASE IS IN HERE
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.11.1 F8 — the backup refuses to certify a directory with no database", () => {
  // `scripts/backup.sh` needs the `sqlite3` CLI (for the online-backup snapshot)
  // and `rsync`, and THE CI IMAGE CARRIES NEITHER — measured against the pinned
  // digest, not assumed. That is why v8.3.20's backup lock is source-only, and
  // ignoring the precedent is what turned this file red on main while it was
  // green on every developer's machine.
  //
  // The behavioural arm below is worth keeping — it is what verified all three
  // states end to end — so it is GUARDED rather than deleted, and the source arm
  // beneath it runs everywhere so CI is not left asserting nothing. A skip here
  // is a statement about the runner's toolchain, and it says so.
  const haveTools = ["sqlite3", "rsync"].every((bin) => {
    try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "pipe" }); return true; }
    catch (_) { return false; }
  });

  const run = (dataDir, outDir) => {
    try {
      execFileSync("bash", [path.join(ROOT, "scripts/backup.sh"), outDir],
        { env: { ...process.env, DATA_DIR: dataDir }, stdio: "pipe" });
      return 0;
    } catch (e) { return e.status ?? 1; }
  };

  test("an absent or empty database fails loudly and writes no marker; a real one still succeeds", () => {
    test.skip(!haveTools, "this runner has no sqlite3/rsync, so backup.sh cannot run at all — the source arm below covers it");
    const base = fs.mkdtempSync(path.join(require("os").tmpdir(), "f8-"));
    try {
      const mk = (n) => { const d = path.join(base, n); fs.mkdirSync(d, { recursive: true }); return d; };
      const absent = mk("absent");
      const zero = mk("zero"); fs.writeFileSync(path.join(zero, "hackathon.db"), "");
      const good = mk("good");
      // A real snapshot, through the same driver the app uses.
      const gdb = new Database(path.join(good, "hackathon.db"));
      gdb.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('x');");
      gdb.close();

      for (const [name, src] of [["absent", absent], ["zero", zero]]) {
        const out = path.join(base, `out-${name}`);
        expect(run(src, out), `${name}: a database-less backup must fail`).not.toBe(0);
        expect(fs.existsSync(path.join(out, "BACKUP_COMPLETE")),
          `${name}: …and must never certify itself`).toBe(false);
        // It refuses BEFORE creating anything, so a daily cron does not accrete
        // an empty timestamped directory per failed run.
        expect(fs.existsSync(out), `${name}: and leaves no directory behind`).toBe(false);
      }

      // CONTROL — without it, "it fails" is satisfied by a script that always fails.
      const outOk = path.join(base, "out-good");
      expect(run(good, outOk), "a real database still backs up").toBe(0);
      expect(fs.existsSync(path.join(outOk, "BACKUP_COMPLETE")), "…and is certified").toBe(true);
      expect(fs.existsSync(path.join(outOk, "hackathon.db")), "…with the database in it").toBe(true);
      const copy = new Database(path.join(outOk, "hackathon.db"), { readonly: true });
      try {
        expect(copy.prepare("SELECT COUNT(*) c FROM users").get().c, "and the data really landed").toBe(1);
      } finally { copy.close(); }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  test("the refusal is above the mkdir, the copy is fatal, and the snapshot is read back", () => {
    // Runs everywhere, including a runner with no sqlite3. It pins the three
    // properties that made `BACKUP_COMPLETE` a lie, each of which was a WARN that
    // carried on: a missing database, a failed `.backup`, and a snapshot too
    // corrupt to read.
    const sh = fs.readFileSync(path.join(ROOT, "scripts/backup.sh"), "utf8");
    const stripped = sh.replace(/(^|\s)#[^\n]*/g, "$1");

    const iGuard = stripped.indexOf('! -s "$DATA_DIR/hackathon.db"');
    const iMkdir = stripped.indexOf('mkdir -p "$OUT_DIR"');
    expect(iGuard, "the missing/empty-database guard exists").toBeGreaterThan(-1);
    expect(iMkdir, "and so does the mkdir it must precede").toBeGreaterThan(-1);
    // ABOVE the mkdir, so a run against an unmounted volume writes NOTHING —
    // not an empty timestamped directory per failed cron tick.
    expect(iGuard, "the refusal must come before anything is created").toBeLessThan(iMkdir);

    // `-s`, not `-f`: a zero-byte file is the shape a half-provisioned host
    // leaves behind, and it passes `-f`.
    expect(stripped, "an empty file is refused too, not just an absent one").not.toMatch(/!\s*-f\s*"\$DATA_DIR\/hackathon\.db"/);

    // The per-database copy is FATAL rather than advisory. This is the branch the
    // finding is named for: it was `echo WARN … ; continue`, so a run that copied
    // no database at all still reached `BACKUP_COMPLETE`. Pinned on that line
    // specifically — slicing forward from `.backup` lands on the SNAPSHOT
    // verification's own ERROR instead, which the next assertion already covers,
    // and would pass with this branch reverted (measured).
    const notFound = stripped.split("\n").findIndex(l => /not found \(or empty\) at \$SRC/.test(l));
    expect(notFound, "the missing-source branch exists").toBeGreaterThan(-1);
    const branch = stripped.split("\n").slice(notFound, notFound + 4);
    expect(branch.join("\n"), "a database it cannot copy is an ERROR, not a WARN").toMatch(/ERROR/);
    // CONTROL FLOW, not the word: the refusal's own message reads "refusing to
    // continue", so matching on `/continue/` fails against the correct branch —
    // the comment-quotes-the-forbidden-pattern trap, one layer in.
    expect(branch.some(l => /^exit\s+[1-9]/.test(l.trim())),
      "…and it stops rather than carrying on to certify the run").toBe(true);
    expect(branch.some(l => l.trim() === "continue"),
      "…it must not skip the database and carry on").toBe(false);

    // And the snapshot is READ BACK, so a file too corrupt to open cannot be
    // certified. Anchored on the `_TABLES=` assignment and its refusal: the
    // attachment check's own table probes also query sqlite_master, and an
    // unanchored match stayed green with this block deleted (measured).
    expect(stripped, "the snapshot is verified with a real read")
      .toMatch(/^\s*_TABLES="\$\(sqlite3 [^\n]*"\$DST" "SELECT COUNT\(\*\) FROM sqlite_master"/m);
    const tablesAt = stripped.split("\n").findIndex(l => /^\s*_TABLES="\$\(sqlite3 /.test(l));
    const tablesBranch = stripped.split("\n").slice(tablesAt + 1, tablesAt + 5).join("\n");
    expect(tablesBranch, "…a non-numeric or zero count refuses").toMatch(/\[\[ ! "\$_TABLES" =~ \^\[0-9\]\+\$ \]\] \|\| \[\[ "\$_TABLES" -lt 1 \]\]/);
    expect(tablesBranch, "…and the refusal exits non-zero").toMatch(/^\s*exit\s+[1-9]/m);

    // ANTI-VACUITY — a rewrite that renamed the variable would empty every match
    // above and pass in silence.
    expect((sh.match(/\$DATA_DIR/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(sh, "and it still writes the marker it is all about").toMatch(/BACKUP_COMPLETE/);
  });
});
