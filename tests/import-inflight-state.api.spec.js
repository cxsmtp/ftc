// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// v8.14.4 (external audit R3) — AN IMPORT ACTS ON THE ROW AS IT IS AT THE WRITE,
// NOT AS IT WAS AT THE DRY RUN.
//
// Both imports find their conflicts first and write last, with awaits between
// (the challenge import validates every attachment ZIP). The challenge import carried the
// LOCK it read before those awaits into the write, so a superadmin who locked
// a challenge in that window was overruled — its answer, description and
// attachments were rewritten anyway. And both carried the row's EXISTENCE: a
// challenge or account deleted in the window sank the write on a foreign key.
//
// Each arm parks the import at the commit-time hook (`parked`, shared with the
// in-flight authorisation specs), acts on the parked request through the real
// route, then lets it go — beside a CONTROL that the same import overwrites
// when nothing happens in the window, so a build that skips every overwrite
// cannot pass.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const { apiLogin, freshCtx, zipOf, BASE, TEST_DB_PATH, pngDataUri, getSuperadminPass } = require("./helpers");
const { H, uniq, makeParticipant } = require("./event-admin-helpers");
const { parked } = require("./admin-inflight-helpers");

test.use({ baseURL: BASE });

function dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }

const ZIP = zipOf("README.txt", "import in flight ".repeat(200));

/** A challenge the import will collide with by title. */
async function makeTask(sa, saCsrf) {
  const title = `R3 ${uniq("t")}`;
  const r = await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
    title, description: "<p>before</p>", difficulty: "easy", answer_type: "text", correct_answer: "before", status: "draft" } });
  expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { id: (await r.json()).id, title };
}
const row = (id) => dbGet("SELECT description, correct_answer, locked FROM tasks WHERE id=?", id);
const liveAttachments = (id) => dbGet("SELECT COUNT(*) c FROM task_attachments WHERE task_id=? AND detached_at IS NULL", id).c;
const importVersions = (id) => dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='import'", id).c;

/** The challenge import, overwriting row 0 (the title collides with `t`). */
function importOver(sa, saCsrf, t) {
  return sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: { resolutions: { "0": "overwrite" }, data: { type: "hackarena-tasks", tasks: [{
    title: t.title, difficulty: "easy", answer_type: "text", correct_answer: "after", status: "draft", description: "<p>after</p>",
    attachments: [{ display_name: "kit", original_name: "kit.zip", content_b64: ZIP.toString("base64") }] }] } } });
}

test.describe("v8.14.4 (R3) — an import re-reads the row it overwrites at the write", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  test("a challenge LOCKED while the import is in flight is not overwritten; CONTROL: an unlocked one is", async () => {
    const ctl = await makeTask(sa, saCsrf);
    const ok = await parked(sa, () => importOver(sa, saCsrf, ctl), null);
    const okBody = await ok.json();
    expect(ok.status(), JSON.stringify(okBody)).toBe(200);
    expect(okBody.overwritten, "CONTROL: nothing happened in the window, so the overwrite lands").toBe(1);
    expect(row(ctl.id).correct_answer, "CONTROL: …with the file's answer").toBe("after");
    expect(liveAttachments(ctl.id), "CONTROL: …and its attachment").toBe(1);

    const t = await makeTask(sa, saCsrf);
    expect(row(t.id).locked, "PRECONDITION: the challenge is unlocked when the import reads its conflicts").toBe(0);
    const r = await parked(sa, () => importOver(sa, saCsrf, t), async () => {
      const l = await sa.post(`/api/admin/tasks/${t.id}/lock`, { headers: H(saCsrf), data: {} });
      expect(l.ok(), `lock: ${l.status()} ${await l.text()}`).toBeTruthy();
      expect((await l.json()).locked, "PRECONDITION: the lock landed inside the window").toBe(1);
    });
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(200);
    expect(body.overwritten, "the lock taken in the window is honoured").toBe(0);
    expect(body.skipped, "…and the row is reported as skipped").toBe(1);
    expect(row(t.id), "nothing the lock protects was rewritten").toEqual({ description: "<p>before</p>", correct_answer: "before", locked: 1 });
    expect(liveAttachments(t.id), "no attachment was linked").toBe(0);
    expect(importVersions(t.id), "no import version was recorded against it").toBe(0);
  });

  test("a challenge UNLOCKED while the import is in flight is overwritten WITH the file's attachment — the pre-flight that promotes files reads the lock fresh too", async () => {
    // The transaction re-read the lock; the pre-flight deciding which ZIPs to
    // promote still read the dry run's, so an unlock in the window overwrote the
    // challenge, detached its live attachments and linked none of the file's.
    const t = await makeTask(sa, saCsrf);
    const l = await sa.post(`/api/admin/tasks/${t.id}/lock`, { headers: H(saCsrf), data: {} });
    expect((await l.json()).locked, "PRECONDITION: locked when the import reads its conflicts").toBe(1);
    const r = await parked(sa, () => importOver(sa, saCsrf, t), async () => {
      const u = await sa.post(`/api/admin/tasks/${t.id}/lock`, { headers: H(saCsrf), data: {} });
      expect((await u.json()).locked, "PRECONDITION: unlocked inside the window").toBe(0);
    });
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(200);
    expect(body.overwritten, "unlocked at the write, so the overwrite lands").toBe(1);
    expect(row(t.id).correct_answer).toBe("after");
    expect(liveAttachments(t.id), "…with the file's attachment linked").toBe(1);
  });

  test("a challenge DELETED while the import is in flight is skipped, not a failed import", async () => {
    // Before the re-read, the overwrite's UPDATE matched nothing and the tag,
    // version and attachment rows that follow it failed their foreign keys,
    // rolling the whole file back as a 500.
    const t = await makeTask(sa, saCsrf);
    const other = `R3 other ${uniq("t")}`;
    const r = await parked(sa, () => sa.post("/api/admin/import/tasks", { headers: H(saCsrf), data: { resolutions: { "0": "overwrite" }, data: { type: "hackarena-tasks", tasks: [
      { title: t.title, difficulty: "easy", answer_type: "text", correct_answer: "after", status: "draft", description: "<p>after</p>", tags: ["r3"],
        attachments: [{ display_name: "kit", original_name: "kit.zip", content_b64: ZIP.toString("base64") }] },
      { title: other, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "draft", description: "<p>x</p>" },
    ] } } }), async () => {
      const d = await sa.delete(`/api/admin/tasks/${t.id}`, { headers: H(saCsrf) });
      expect(d.ok(), `delete: ${d.status()} ${await d.text()}`).toBeTruthy();
    });
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(200);
    expect(body.skipped, "the deleted challenge's row is skipped").toBe(1);
    expect(body.overwritten).toBe(0);
    expect(body.imported, "CONTROL: the rest of the file still lands").toBe(1);
    expect(dbGet("SELECT COUNT(*) c FROM tasks WHERE id=?", t.id).c, "the deleted challenge stays deleted").toBe(0);
    expect(dbGet("SELECT COUNT(*) c FROM tasks WHERE title=?", other).c).toBe(1);
  });

  test("a participant DELETED while the import is in flight is skipped, not a failed chunk; CONTROL: an untouched one is overwritten", async () => {
    const gone = await makeParticipant(sa, saCsrf, "r3gone");
    const kept = await makeParticipant(sa, saCsrf, "r3kept");
    const rowOf = (p) => {
      const u = dbGet("SELECT nickname, email, first_name, last_name FROM users WHERE id=?", p.id);
      return { ...u, company: "Moved", title: "Engineer", country: "GB", timezone: "Europe/London", tags: ["r3"] };
    };
    // The deleted account's row carries an avatar: a skipped row must store none
    // (`images` has no sweeper).
    const file = [{ ...rowOf(gone), avatar: pngDataUri(40, "gone-avatar") }, rowOf(kept)];
    const imagesBefore = dbGet("SELECT COUNT(*) c FROM images").c;
    const r = await parked(sa, () => sa.post("/api/admin/import/participants", { headers: H(saCsrf), data: {
      resolutions: { "0": "overwrite", "1": "overwrite" }, data: { type: "hackarena-participants", version: 2, participants: file } } }),
    async () => {
      const d = await sa.delete(`/api/admin/participants/${gone.id}`, { headers: H(saCsrf) });
      expect(d.ok(), `delete: ${d.status()} ${await d.text()}`).toBeTruthy();
    });
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(200);
    expect(body.partial, "no chunk failed").toBeUndefined();
    expect(body.skipped, "the deleted account's row is skipped").toBe(1);
    expect(body.overwritten, "CONTROL: the untouched account is overwritten").toBe(1);
    expect(dbGet("SELECT company FROM users WHERE id=?", kept.id).company).toBe("Moved");
    expect(dbGet("SELECT COUNT(*) c FROM users WHERE id=?", gone.id).c, "the deleted account stays deleted").toBe(0);
    expect(dbGet("SELECT COUNT(*) c FROM images").c, "the skipped row's avatar was never stored").toBe(imagesBefore);
  });

  test("a NICKNAME registered while the import is in flight refuses its row by name, not with a 500", async () => {
    // The dry run decided the nickname was free; a registration in the window
    // before the commit took it, and the INSERT then failed on the unique index as a raw
    // error after earlier chunks had committed.
    const nick = `r3nick${Date.now() % 1e8}`;
    const r = await parked(sa, () => sa.post("/api/admin/import/participants", { headers: H(saCsrf), data: {
      resolutions: {}, data: { type: "hackarena-participants", version: 2, participants: [{
        nickname: nick, email: `r3-${nick}@acme.com`, first_name: "Im", last_name: "Port", company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London" }] } } }),
    async () => {
      const { api: anon, csrf } = await freshCtx();
      try {
        const reg = await registerPost(anon, "/api/register", { headers: H(csrf), data: {
          email: `r3-taken-${nick}@acme.com`, password: "Passw0rd!long", nickname: nick, firstName: "Took", lastName: "It", company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London" } });
        expect(reg.ok(), `PRECONDITION: the nickname is taken inside the window: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      } finally { await anon.dispose(); }
    }, 4000);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(400);
    expect(body.error, "the refusal names the row and the nickname").toContain(`Row 1: nickname "${nick}"`);
    expect(body.partial, "and says how far it got").toBeTruthy();
    expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=?", `r3-${nick}@acme.com`).c).toBe(0);
  });

  test("a PRIMARY address taken while the import is in flight (as another account's secondary) refuses its row by name; no address ends up on two accounts", async () => {
    // The UNIQUE indexes cover primary↔primary and secondary↔secondary only, so
    // the CROSS-slot case reaches the write unless the transaction asks again.
    const holder = await makeParticipant(sa, saCsrf, "r3mail");
    const tag = `${Date.now() % 1e8}`;
    const addr = `r3-mail-${tag}@acme.com`;
    const r = await parked(sa, () => sa.post("/api/admin/import/participants", { headers: H(saCsrf), data: {
      resolutions: {}, data: { type: "hackarena-participants", version: 2, participants: [{
        nickname: `r3mail${tag}`, email: addr, first_name: "Im", last_name: "Port", company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London" }] } } }),
    async () => {
      const u = await sa.put(`/api/admin/participants/${holder.id}`, { headers: H(saCsrf), data: { secondaryEmail: addr } });
      expect(u.ok(), `PRECONDITION: the address is taken inside the window: ${u.status()} ${await u.text()}`).toBeTruthy();
    }, 4000);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(400);
    expect(body.error, "the refusal names the row and the address").toContain(`Row 1: primary email "${addr}"`);
    expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=? COLLATE NOCASE", addr).c, "no account was created on the taken address").toBe(0);
    expect(dbGet("SELECT secondary_email FROM users WHERE id=?", holder.id).secondary_email, "the holder keeps it").toBe(addr);
  });
});

test.describe("v8.14.4 — a participant import that stops part-way reports the drops in the chunks it kept", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  test("a group association dropped in a COMMITTED chunk is on `partial:`; one in the rolled-back chunk is not", async () => {
    test.setTimeout(120_000);
    // Two groups bound to one event with a team board: a row naming both keeps
    // one and drops the other (one group per participant per event).
    const c = await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `R3 partial ${uniq("e")}`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600, group_leaderboard_enabled: true } });
    expect(c.ok(), await c.text()).toBeTruthy();
    const E = (await c.json()).competition;
    const group = async (label) => {
      const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: uniq(label), userIds: [] } });
      expect(g.ok(), await g.text()).toBeTruthy();
      const row = (await g.json()).group;
      const b = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [row.id], competitionIds: [E.id] } });
      expect(b.ok(), await b.text()).toBeTruthy();
      return row;
    };
    const gA = await group("R3 gA"), gB = await group("R3 gB");
    const tag = `${Date.now() % 1e8}`;
    const person = (i, extra = {}) => ({ nickname: `r3p${tag}x${i}`, email: `r3p-${tag}-${i}@acme.com`, first_name: "Im", last_name: `P${i}`, company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London", ...extra });
    // Row 1 (chunk 1, kept) and row 101 (chunk 2, rolled back) each drop one
    // association; row 102's nickname is taken in the window, which stops chunk
    // 2 AFTER its drop was counted, so only the restore keeps it off `partial:`.
    const rows = [person(0, { groups: [gA.name, gB.name] })];
    for (let i = 1; i < 100; i++) rows.push(person(i));
    rows.push(person(100, { groups: [gA.name, gB.name] }));
    rows.push(person(101));
    const taken = rows[101].nickname;
    const r = await parked(sa, () => sa.post("/api/admin/import/participants", { headers: H(saCsrf), data: {
      resolutions: {}, data: { type: "hackarena-participants", version: 2, participants: rows } } }),
    async () => {
      const { api: anon, csrf } = await freshCtx();
      try {
        const reg = await registerPost(anon, "/api/register", { headers: H(csrf), data: {
          email: `r3-took-${tag}@acme.com`, password: "Passw0rd!long", nickname: taken, firstName: "Took", lastName: "It", company: "Acme", title: "Eng", country: "GB", timezone: "Europe/London" } });
        expect(reg.ok(), `PRECONDITION: the nickname is taken inside the window: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      } finally { await anon.dispose(); }
    }, 4000);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body).slice(0, 300)).toBe(400);
    expect(body.partial && body.partial.imported, "PRECONDITION: the first chunk was kept").toBe(100);
    expect(body.partial.group_clashes_dropped, "the kept chunk's drop is reported; the rolled-back chunk's is not").toBe(1);
  });
});

test.describe("v8.14.4 — the import summary names the rows it would not overwrite", () => {
  test("the drop note counts rival and privileged skips, and a partial stop shows the same notes", async ({ page }) => {
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    const li = await page.request.post(`${BASE}/api/login`, { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(li.ok()).toBeTruthy();
    await page.goto(`${BASE}/`);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    expect(await page.evaluate(() => window._importDropNote({ rival_skipped: 1 }))).toContain("1 participant was not overwritten because you compete alongside them in an event");
    expect(await page.evaluate(() => window._importDropNote({ rival_skipped: 3 }))).toContain("3 participants were not overwritten");
    // …and the rows an importer who is not a superadmin may not apply.
    expect(await page.evaluate(() => window._importDropNote({ privileged_skipped: 1 }))).toContain("1 row was not imported because only a superadmin may apply it");
    expect(await page.evaluate(() => window._importDropNote({ privileged_skipped: 2 }))).toContain("2 rows were not imported because only a superadmin may apply them");
    expect(await page.evaluate(() => window._importDropNote({})), "CONTROL: nothing to say, nothing said").toBe("");
    // A partial stop used to show only imported / overwritten / skipped.
    await page.evaluate(() => window._reportImportFailure({ error: "Row 120: something", partial: { imported: 2, overwritten: 1, skipped: 0, rival_skipped: 4 } }, "participants"));
    await expect(page.locator("#toast-stack")).toContainText("4 participants were not overwritten");
  });
});
