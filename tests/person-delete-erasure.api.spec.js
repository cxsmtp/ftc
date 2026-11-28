// @ts-check
//
// ERASURE REACHES THE NEWER TABLES (sweep gap #345).
//
// Deleting a person (DELETE /api/admin/participants/:id, and the unverified-
// account reaper, both through lib/account-reaper.js `deleteUserCascade`) must
// take with it every row ABOUT them, in the tables added since the older locks
// (functional-security-c's task_feedback / challenge_events / absences arm):
//
//   * certificate_emails and certificate_share_links — the congratulations
//     mail's ledger and its one-time LinkedIn link, both keyed on the
//     certificate (they go with achievement_badges by foreign-key cascade);
//   * event_leads — the lead marks organisers set (a foreign-key cascade);
//   * orphan_events rows scoped to the user — the Audit page's stored copies of
//     orphaned events about them (an explicit DELETE in the cascade, found by
//     index: it runs inside the write transaction for every deletion).
//
// And it must KEEP what the operator ruled kept (15 Nov 2026): the record of the
// deletion itself (`deleted`, and the reaper's `account_reaped`) carries the
// person's address and nickname, written after the cascade so it survives it.
// Rows naming the person only as the ACTOR of something survive too (the
// cascade's own comment; README's erasure procedure, step 3).
//
// Every row is asserted by value, and every kind has a CONTROL: a second person
// holding the same kinds of rows, read back unchanged after the deletion. The
// certificate rows and the lead marks come from the real writers (the automatic
// issue and its mail through the dispatcher's test tick; the organiser's
// "contacted" mark). A user-scoped orphan row about a LIVING person has no
// everyday writer (they come from Checkmarx One account removals, which need a
// realm), so those are planted in the exact shape lib/audit.js writes.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor, freshCtx, registerPost } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");

function read(fn) {
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}
function write(fn) {
  const db = new Database(TEST_DB_PATH, { fileMustExist: true });
  try { db.pragma("busy_timeout = 5000"); return fn(db); } finally { db.close(); }
}

/** An orphaned audit row in the shape lib/audit.js recordOrphanedAuditEvent stores. */
function plantOrphan({ scope, scopeId, eventType, changedBy, details }) {
  const id = crypto.randomUUID();
  write((db) => db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, scope, scopeId, eventType, changedBy, new Date().toISOString(), null, null, JSON.stringify(details)));
  return id;
}

/** Everything the deletion must decide about, for one person, by value. */
function rowsAbout(userId) {
  return read((db) => {
    const badges = db.prepare("SELECT token, public_code FROM achievement_badges WHERE user_id=? ORDER BY token").all(userId);
    const tokens = JSON.stringify(badges.map((b) => b.token));
    return {
      badges,
      certificateEmails: db.prepare("SELECT badge_token, user_id, competition_id, status FROM certificate_emails WHERE user_id=? OR badge_token IN (SELECT value FROM json_each(?)) ORDER BY badge_token").all(userId, tokens),
      shareLinks: db.prepare("SELECT id_hash, badge_token FROM certificate_share_links WHERE badge_token IN (SELECT value FROM json_each(?)) ORDER BY id_hash").all(tokens),
      leads: db.prepare("SELECT competition_id, user_id, contacted_at, contacted_by FROM event_leads WHERE user_id=? ORDER BY competition_id").all(userId),
      orphanCopies: db.prepare("SELECT id, event_type, details FROM orphan_events WHERE scope='user' AND scope_id=? ORDER BY changed_at, id").all(userId),
      userEvents: db.prepare("SELECT COUNT(*) AS n FROM user_events WHERE user_id=?").get(userId).n,
    };
  });
}

let F;
test.beforeAll(async () => {
  const s = await apiLogin("superadmin");
  const sa = s.api, saCsrf = s.csrf;
  // Two challenges, each person solving one: nobody finishes everything, so the
  // all-solved auto-end cannot fire (fixture checklist item 1); End Now ends it.
  const comp = await makeCompetition(sa, saCsrf, "erase");
  const solved = await makeTask(sa, saCsrf, "erase-solved", { correct_answer: "right" });
  const left = await makeTask(sa, saCsrf, "erase-left", { correct_answer: "other" });
  await assignTask(sa, saCsrf, solved.id, [comp.id]);
  await assignTask(sa, saCsrf, left.id, [comp.id]);
  const victim = await makeParticipant(sa, saCsrf, "erase-victim");
  const control = await makeParticipant(sa, saCsrf, "erase-control");
  await enrol(sa, saCsrf, comp.id, [victim.id, control.id]);

  for (const who of [victim, control]) {
    const l = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      const sel = await l.api.post("/api/select-competition", { headers: H(l.csrf), data: { competitionId: comp.id } });
      expect(sel.status(), await sel.text()).toBe(200);
      const r = await l.api.post(`/api/tasks/${solved.id}/submit`, {
        headers: { ...H(l.csrf), "x-competition-id": comp.id },
        data: { answer: "right", gradingHash: await gradingHashFor(l.api, solved.id) },
      });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).correct, `${who.email} solves`).toBe(true);
    } finally { await l.api.dispose(); }
  }
  // The organiser's lead mark, through its own route, for each.
  for (const who of [victim, control]) {
    const m = await sa.post(`/api/admin/competitions/${comp.id}/leads/${who.id}/contacted`, { headers: H(saCsrf), data: { contacted: true } });
    expect(m.status(), await m.text()).toBe(200);
  }
  // End it; the dispatcher issues each certificate and mails it. The shared
  // server's relay refuses every send, which still writes the ledger row and the
  // one-time share link (minted for any mail that is not opted out).
  const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.status(), await end.text()).toBe(200);
  const tick = await sa.post("/api/test/certificate-dispatch-tick", { headers: H(saCsrf), data: { force: true, competitionId: comp.id } });
  expect(tick.status(), await tick.text()).toBe(200);
  // Every send attempt mints its own link, and the forced pass also runs the
  // retry of the refused first send, so a person may hold more than one.
  for (const who of [victim, control]) {
    await expect.poll(() => {
      const r = rowsAbout(who.id);
      return [r.badges.length, r.certificateEmails.length, r.shareLinks.length > 0];
    }, { message: `${who.email}: a certificate, its mail ledger row and its share links`, timeout: 15_000 }).toEqual([1, 1, true]);
  }
  // A stored copy of an orphaned event ABOUT each person (scope user), and one
  // naming the victim only as its ACTOR (another subject).
  const marker = uniq("orph").replace(/[^a-zA-Z0-9]/g, "");
  const victimCopy = plantOrphan({ scope: "user", scopeId: victim.id, eventType: "cxone_realm_withdrawal_retried", changedBy: "superadmin",
    details: { marker: `victim-${marker}`, email: victim.email } });
  const controlCopy = plantOrphan({ scope: "user", scopeId: control.id, eventType: "cxone_realm_withdrawal_retried", changedBy: "superadmin",
    details: { marker: `control-${marker}`, email: control.email } });
  const actorRow = plantOrphan({ scope: "task", scopeId: crypto.randomUUID(), eventType: "deleted", changedBy: victim.email,
    details: { marker: `actor-${marker}` } });
  // STAFF TEAMS (owner decision, 28 Nov 2026): the victim's primary address in
  // two teams (one added through the route, one planted in capitals to prove
  // the match ignores case), the control's address beside it in the first.
  const teamIds = [];
  for (const name of [`Erase SEs ${marker}`, `Erase Sales ${marker}`]) {
    const t = await sa.post("/api/admin/staff-teams", { headers: H(saCsrf), data: { name } });
    expect(t.status(), await t.text()).toBe(201);
    teamIds.push((await t.json()).team.id);
  }
  for (const who of [victim, control]) {
    const m = await sa.post(`/api/admin/staff-teams/${teamIds[0]}/members`, { headers: H(saCsrf), data: { name: `Member ${who.nickname}`, email: who.email } });
    expect(m.status(), await m.text()).toBe(201);
  }
  const plantedMember = crypto.randomUUID();
  write((db) => db.prepare("INSERT INTO staff_team_members (id, team_id, name, email, added_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(plantedMember, teamIds[1], "Victim Again", victim.email.toUpperCase(), new Date().toISOString(), new Date().toISOString()));
  F = { sa, saCsrf, comp, victim, control, victimCopy, controlCopy, actorRow, marker, teamIds, plantedMember };
});
test.afterAll(async () => { try { await F.sa.dispose(); } catch (_) {} });

test.describe("sweep #345 — deleting a person erases their rows in the newer tables", () => {
  test("an admin's deletion removes the person's certificate mail and share link, lead mark and stored audit copies, keeps the deletion record's address and nickname, and leaves another person's rows as they were", async () => {
    const { sa, saCsrf, comp, victim, control, victimCopy, controlCopy, actorRow } = F;
    const before = rowsAbout(victim.id);
    const controlBefore = rowsAbout(control.id);
    // PRECONDITIONS, by value: the victim holds one of each, from the real writers.
    expect(before.badges.length, "the victim's certificate").toBe(1);
    const token = before.badges[0].token, code = before.badges[0].public_code;
    expect(before.certificateEmails.map((r) => [r.badge_token, r.user_id, r.competition_id]), "the mail ledger row").toEqual([[token, victim.id, comp.id]]);
    expect(before.shareLinks.length, "the share links").toBeGreaterThan(0);
    expect([...new Set(before.shareLinks.map((r) => r.badge_token))], "…all of the certificate's").toEqual([token]);
    expect(before.leads.map((r) => [r.competition_id, r.user_id, !!r.contacted_at]), "the lead mark").toEqual([[comp.id, victim.id, true]]);
    expect(before.orphanCopies.map((r) => r.id), "the stored audit copy about them").toEqual([victimCopy]);
    expect(before.userEvents, "their history").toBeGreaterThan(0);
    expect(controlBefore.orphanCopies.map((r) => r.id)).toEqual([controlCopy]);

    const r = await sa.delete(`/api/admin/participants/${victim.id}`, { headers: H(saCsrf) });
    expect(r.status(), await r.text()).toBe(200);

    const after = rowsAbout(victim.id);
    expect(after.badges, "the certificate goes").toEqual([]);
    expect(after.certificateEmails, "its mail ledger row goes").toEqual([]);
    expect(after.shareLinks, "its share link goes").toEqual([]);
    expect(after.leads, "the lead mark goes").toEqual([]);
    expect(after.userEvents, "their history goes").toBe(0);
    // By value across the tables, whatever key a row might be held under.
    const leftover = read((db) => ({
      byToken: db.prepare("SELECT (SELECT COUNT(*) FROM certificate_emails WHERE badge_token=@token) + (SELECT COUNT(*) FROM certificate_share_links WHERE badge_token=@token) + (SELECT COUNT(*) FROM achievement_badges WHERE token=@token OR public_code=@code) AS n").get({ token, code }).n,
      byUser: db.prepare("SELECT (SELECT COUNT(*) FROM certificate_emails WHERE user_id=@id) + (SELECT COUNT(*) FROM event_leads WHERE user_id=@id) AS n").get({ id: victim.id }).n,
      plantedCopy: db.prepare("SELECT COUNT(*) AS n FROM orphan_events WHERE id=?").get(victimCopy).n,
    }));
    expect(leftover, "nothing is left under the certificate's token or code, or the person's id").toEqual({ byToken: 0, byUser: 0, plantedCopy: 0 });

    // KEPT (operator ruling, 15 Nov 2026): the one user-scoped copy left about
    // them is the record of the deletion, with their address and nickname.
    expect(after.orphanCopies.map((x) => x.event_type), "only the deletion record remains about them").toEqual(["deleted"]);
    const rec = JSON.parse(after.orphanCopies[0].details);
    expect(rec.email, "the deletion record keeps the address").toBe(victim.email);
    expect(rec.nickname, "…and the nickname").toBe(victim.nickname);
    // KEPT: a row naming them only as the actor of something else.
    expect(read((db) => db.prepare("SELECT changed_by FROM orphan_events WHERE id=?").get(actorRow)), "a row naming them only as its actor survives")
      .toEqual({ changed_by: victim.email });

    // CONTROL: the other person's rows of every kind are exactly as they were.
    expect(rowsAbout(control.id), "the control person's rows are untouched").toEqual(controlBefore);

    // STAFF TEAMS: the victim's address left both teams (the capitals row too);
    // the control's row in the same team stays, by value.
    const staff = read((db) => db.prepare("SELECT team_id, lower(email) AS email FROM staff_team_members WHERE team_id IN (SELECT value FROM json_each(?)) ORDER BY team_id, email").all(JSON.stringify(F.teamIds)));
    expect(staff, "only the control's staff-team row remains").toEqual([{ team_id: F.teamIds[0], email: control.email.toLowerCase() }]);
    expect(rec.staff_team_memberships_removed, "the deletion record counts the rows").toBe(2);
    const audits = read((db) => db.prepare("SELECT scope_id, details FROM orphan_events WHERE scope='staff_team' AND event_type='staff_team_member_removed' AND scope_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(F.teamIds)))
      .map((a) => ({ team: a.scope_id, ...JSON.parse(a.details) }));
    expect(audits.map((a) => [a.team, a.reason, a.domain]).sort(), "one record per team, its reason and domain")
      .toEqual([[F.teamIds[0], "account_deleted", victim.email.split("@")[1].toLowerCase()], [F.teamIds[1], "account_deleted", victim.email.split("@")[1].toLowerCase()]].sort());
    expect(audits.map((a) => a.member_id), "naming the member row removed").toContain(F.plantedMember);
    expect(JSON.stringify(audits).toLowerCase(), "never the address").not.toContain(victim.email.toLowerCase());
  });

  test("the unverified-account reaper's cascade removes the reaped account's stored audit copies and keeps its account_reaped record with address and nickname; another account's copy survives", async () => {
    const { control, controlCopy, marker } = F;
    // An abandoned, never-verified sign-up in the reaper's gate (registerPost's
    // default state: unverified, never signed in, pending).
    const tag = uniq("reap").replace(/[^a-zA-Z0-9]/g, "").slice(-20);
    const email = `reap-${tag}@corp-erase.example`;
    const nickname = `reap_${tag}`;
    const { api, csrf } = await freshCtx();
    try {
      const reg = await registerPost(api, "/api/register", { headers: H(csrf), data: {
        firstName: "Re", lastName: "Aped", nickname, email, company: "Acme", title: "T",
        country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
      } });
      expect(reg.status(), await reg.text()).toBe(200);
    } finally { await api.dispose(); }
    const row = read((db) => db.prepare("SELECT id, nickname, verified, approved, first_verified_at FROM users WHERE email=?").get(email));
    expect(row, "PRECONDITION: the account exists").toBeTruthy();
    expect([row.verified, row.approved, row.first_verified_at], "PRECONDITION: never verified, not approved").toEqual([0, 0, null]);
    const copy = plantOrphan({ scope: "user", scopeId: row.id, eventType: "cxone_realm_withdrawal_retried", changedBy: "superadmin",
      details: { marker: `reaped-${marker}`, email } });
    // Older than the 48 h the reaper waits; the grandfather floor is lifted so
    // only the age decides.
    write((db) => db.prepare("UPDATE users SET created_at=? WHERE id=?").run(new Date(Date.now() - 49 * 3600_000).toISOString(), row.id));
    const controlBefore = rowsAbout(control.id);
    expect(controlBefore.orphanCopies.map((x) => x.id), "PRECONDITION: the control's copy").toEqual([controlCopy]);

    const { api: t, csrf: tc } = await freshCtx();
    let res;
    try {
      const r = await t.post("/api/test/reap-accounts", { headers: H(tc), data: { floorIso: null } });
      expect(r.status(), await r.text()).toBe(200);
      res = await r.json();
    } finally { await t.dispose(); }
    expect(res.ids, "exactly the abandoned account is reaped").toEqual([row.id]);
    expect(read((db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE id=?").get(row.id).n)).toBe(0);

    const left = rowsAbout(row.id);
    expect(read((db) => db.prepare("SELECT COUNT(*) AS n FROM orphan_events WHERE id=?").get(copy).n), "the stored copy about them goes").toBe(0);
    expect(left.orphanCopies.map((x) => x.event_type), "only the reaper's record remains about them").toEqual(["account_reaped"]);
    const rec = JSON.parse(left.orphanCopies[0].details);
    expect([rec.reason, rec.email, rec.nickname], "the reaper's record keeps the address and nickname").toEqual(["unverified_48h", email, row.nickname]);
    expect(left.userEvents, "their history goes").toBe(0);
    // CONTROL: another account's copy and rows are untouched.
    expect(rowsAbout(control.id)).toEqual(controlBefore);
  });
});

// The cascade runs inside its write transaction for every deletion (up to 500 a
// reaper run), so its delete of the copies about the person is an index search,
// never a scan of every stored copy while the write lock is held. Read off the
// SQL the real cascade prepares, in a child with its own data directory.
test("a deletion finds the stored copies about the person by index", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { spawnSync } = require("child_process");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-cascade-plan-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-cascade-plan-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const at = new Date().toISOString();
    const ins = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, created_at) VALUES (?,?,?,?,?,?)");
    ins.run("u-gone", "Gil", "G", "gil1", "gil@corp.test", at);
    ins.run("u-kept", "Kim", "K", "kim1", "kim@corp.test", at);
    const copy = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at) VALUES (?,?,?,?,?,?)");
    copy.run("o-gone", "user", "u-gone", "probe", "a", at);
    copy.run("o-kept", "user", "u-kept", "probe", "a", at);
    const seen = [];
    const orig = db.prepare;
    db.prepare = function (sql) { seen.push(String(sql)); return orig.call(db, sql); };
    R("lib/account-reaper.js").deleteUserCascade("u-gone");
    db.prepare = orig;
    const out = {};
    out.sql = seen.filter(x => /DELETE FROM orphan_events/.test(x));
    out.plans = out.sql.map(x => db.prepare("EXPLAIN QUERY PLAN " + x).all(...Array((x.match(/[?]/g) || []).length).fill("x")).map(r => r.detail).join(" | "));
    out.control = db.prepare("EXPLAIN QUERY PLAN DELETE FROM orphan_events WHERE event_type=?").all("x").map(r => r.detail).join(" | ");
    out.left = db.prepare("SELECT id FROM orphan_events WHERE event_type='probe' ORDER BY id").all().map(r => r.id);
    out.staffSql = seen.filter(x => /FROM staff_team_members m/.test(x));
    out.staffPlans = out.staffSql.map(x => db.prepare("EXPLAIN QUERY PLAN " + x).all("[]").map(r => r.detail).join(" | "));
    process.stdout.write("\\nCASCADE_PLAN_OUT " + JSON.stringify(out) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("CASCADE_PLAN_OUT "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    const out = JSON.parse(line.slice("CASCADE_PLAN_OUT ".length));
    expect(out.left, "the copy about the deleted person goes; CONTROL: another person's stays").toEqual(["o-kept"]);
    expect(out.sql.length, "anti-vacuity: the cascade's delete was seen").toBe(1);
    expect(out.plans[0], out.sql[0]).toMatch(/SEARCH orphan_events USING (COVERING )?INDEX idx_orphan_events_scope \(scope=\? AND scope_id=\?\)/);
    expect(out.plans[0], out.sql[0]).not.toMatch(/\bSCAN orphan_events\b/);
    expect(out.control, "CONTROL: a delete no index serves reads as a scan").toMatch(/\bSCAN orphan_events\b/);
    // The staff-team lookup by the deleted address is an index search too.
    expect(out.staffSql.length, "anti-vacuity: the cascade's staff-team read was seen").toBe(1);
    expect(out.staffPlans[0], out.staffSql[0]).toMatch(/SEARCH m USING INDEX idx_staff_team_members_email \(email=\?\)/);
    expect(out.staffPlans[0], out.staffSql[0]).not.toMatch(/\bSCAN m\b/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});
