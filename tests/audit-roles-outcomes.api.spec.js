"use strict";

// GET /api/admin/audit (routes/audit.js) — the branches tests/audit-page.spec.js
// does not drive, each by value beside a control:
//   - a `granted` CUSTOM role is scoped exactly as an event admin; a custom role
//     without `audit.view` is refused at the gate;
//   - a person row about a PRIVILEGED account is withheld from an event admin
//     even when that account shares their event (the `u.role = 'participant'`
//     arm), while a participant's row is shown;
//   - the 5 s response cache keys on the HAND as well as the seat: an organiser's
//     readable sealed answer is never served to a superadmin looking through
//     their seat, nor the reverse; and on the reveal set: a superadmin's reveal
//     shows the answer on the very next read, and is withheld again (same URL)
//     once that superadmin competes in an event holding the challenge;
//   - the outcome: every way a writer records a failure reads as `failure`;
//   - the cost: the count is a first-page fact, stops at its ceiling as a floor,
//     and the route has its own limiter.
// Rows are planted where the read is the subject (the audit-page.spec.js rule).

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { H, buildWorld, makeTask, assignTask, makeParticipant, makeCompetition, enrol, grantEventAdmin, uniq } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const T = uniq("aro").replace(/[^a-zA-Z0-9]/g, "");
const PROBE = `probe_${T}`;
const PRIV = `priv_${T}`;
const SEALKEY = `SEALKEY_${T}`;
const ACT = `actor-${T}@outcomes.example`;
const BULK = `bulk_${T}`;
const SMALL = `small_${T}`;
const COUNT_MAX = 10000;   // routes/audit.js AUDIT_COUNT_MAX

function openDb() {
  const Database = require("better-sqlite3");
  return new Database(TEST_DB_PATH);
}
const iso = (ms) => new Date(ms).toISOString();
const rid = () => require("crypto").randomUUID();

async function audit(api, qs) {
  const r = await api.get(`/api/admin/audit?${qs}`);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = null; }
  return { status: r.status(), body, text };
}

async function makeRole(w, label, scope_mode, permissions) {
  const r = await w.sa.post("/api/admin/roles", { headers: H(w.saCsrf), data: { label: `${label} ${T}`, scope_mode, permissions } });
  expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).role;
}
async function userWithRole(w, label, roleId) {
  const p = await makeParticipant(w.sa, w.saCsrf, label);
  const r = await w.sa.patch(`/api/admin/users/${p.id}/role`, { headers: H(w.saCsrf), data: { role: roleId } });
  expect(r.ok(), `assign ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}
async function makeAdmin(w, label, role) {
  const p = await makeParticipant(w.sa, w.saCsrf, label);
  const r = await w.sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(w.saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}

/** @type {any} */ let w;
let viewer, viewerApi, noAuditApi, sealedTask, priv;

test.describe("GET /api/admin/audit — roles, the cache key, outcomes and cost", () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();

    // A custom role scoped by grants, holding the audit page; granted `mine`. It
    // holds the permissions that guard event and person rows elsewhere, which
    // each kind of audit row also needs (operator ruling, 14 Nov 2026).
    const scoped = await makeRole(w, "Audit reader", "granted", ["audit.view", "events.view", "participants.view"]);
    viewer = await userWithRole(w, "auditviewer", scoped.id);
    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, viewer.id);
    viewerApi = (await apiLogin(viewer.email, PARTICIPANT_PASS)).api;
    // A custom role WITHOUT the audit page.
    const blind = await makeRole(w, "No audit", "granted", ["events.view"]);
    const noAudit = await userWithRole(w, "noaudit", blind.id);
    await grantEventAdmin(w.sa, w.saCsrf, w.mine.id, noAudit.id);
    noAuditApi = (await apiLogin(noAudit.email, PARTICIPANT_PASS)).api;

    // A privileged account enrolled in `mine` (made an admin after joining).
    priv = await makeParticipant(w.sa, w.saCsrf, "privileged");
    await enrol(w.sa, w.saCsrf, w.mine.id, [priv.id]);
    const pr = await w.sa.post(`/api/admin/participants/${priv.id}/role`, { headers: H(w.saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `promote: ${pr.status()} ${await pr.text()}`).toBeTruthy();

    // A sealed challenge authored by the organiser, in their event, answered.
    sealedTask = await makeTask(w.eaApi, w.eaCsrf, "sealed", { answer_sealed: true, correct_answer: SEALKEY });
    await assignTask(w.sa, w.saCsrf, sealedTask.id, [w.mine.id]);

    const now = Date.now();
    const at = iso(now - 1000);
    const db = openDb();
    try {
      // PRECONDITION: the privileged account really shares the event and really
      // is not a participant, or the arm under test is not the one deciding.
      expect(db.prepare("SELECT 1 FROM competition_users WHERE user_id=? AND competition_id=?").get(priv.id, w.mine.id), "the admin is still enrolled in mine").toBeTruthy();
      expect(db.prepare("SELECT role FROM users WHERE id=?").get(priv.id).role).toBe("admin");

      const insCe = db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      insCe.run(rid(), w.mine.id, PROBE, "superadmin", at, JSON.stringify({ note: "mine" }));
      insCe.run(rid(), w.theirs.id, PROBE, "superadmin", at, JSON.stringify({ note: "theirs" }));
      const insUe = db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      insUe.run(rid(), w.inMine.id, PROBE, "system", at, JSON.stringify({ competition_id: w.mine.id }));
      insUe.run(rid(), w.inTheirs.id, PROBE, "system", at, JSON.stringify({ competition_id: w.theirs.id }));
      insUe.run(rid(), priv.id, PRIV, "system", at, JSON.stringify({ competition_id: w.mine.id, who: "privileged" }));
      insUe.run(rid(), w.inMine.id, PRIV, "system", at, JSON.stringify({ competition_id: w.mine.id, who: "participant" }));
      db.prepare("INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, answer, is_correct, points_delta, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(rid(), w.inMine.id, sealedTask.id, w.mine.id, null, SEALKEY, 1, 50, at, at);

      // Outcomes: each failure shape beside its successful twin, one actor.
      const insO = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      insUe.run(rid(), w.inMine.id, "certificate_emailed", ACT, at, JSON.stringify({ competition_id: w.mine.id, status: "failed", error: "smtp_down", label: "cert-failed" }));
      insUe.run(rid(), w.inMine.id, "certificate_emailed", ACT, at, JSON.stringify({ competition_id: w.mine.id, status: "sent", label: "cert-sent" }));
      insO.run(rid(), "email", "x@y.example", "test_email_sent", ACT, at, null, null, JSON.stringify({ ok: false, error: "relay refused", label: "test-failed" }));
      insO.run(rid(), "email", "x@y.example", "test_email_sent", ACT, at, null, null, JSON.stringify({ ok: true, label: "test-ok" }));
      insUe.run(rid(), w.inMine.id, "email_change_conflict", ACT, at, JSON.stringify({ label: "change-refused" }));
      insUe.run(rid(), w.inMine.id, "email_change_confirmed", ACT, at, JSON.stringify({ label: "change-confirmed" }));
      insO.run(rid(), "cxone", "acct", "cxone_realm_withdrawal_given_up", ACT, at, null, null, JSON.stringify({ label: "removal-given-up" }));
      insUe.run(rid(), w.inMine.id, "email_sent", ACT, at, JSON.stringify({ success: false, label: "mail-failed" }));
      insUe.run(rid(), w.inMine.id, "email_sent", ACT, at, JSON.stringify({ success: true, label: "mail-sent" }));
      // A team report records its messages as counts (lib/team-reports.js):
      // nothing sent, one refused by the allowed-domain list, and all sent.
      insCe.run(rid(), w.mine.id, "team_report_sent", ACT, at, JSON.stringify({ kind: "wrapup", sent: 0, failed: 2, refused: 0, label: "report-failed" }));
      insCe.run(rid(), w.mine.id, "team_report_sent", ACT, at, JSON.stringify({ kind: "wrapup", sent: 3, failed: 0, refused: 1, label: "report-refused" }));
      insCe.run(rid(), w.mine.id, "team_report_sent", ACT, at, JSON.stringify({ kind: "wrapup", sent: 3, failed: 0, refused: 0, label: "report-sent" }));

      // The count ceiling: one row more than it, and a small control set.
      const bulk = db.transaction(() => {
        for (let i = 0; i <= COUNT_MAX; i++) insO.run(rid(), "export", "bulk", BULK, "superadmin", iso(now - 5000 - i), null, null, null);
        for (let i = 0; i < 3; i++) insO.run(rid(), "export", "small", SMALL, "superadmin", iso(now - 4000 - i), null, null, null);
      });
      bulk();
    } finally { db.close(); }
  });

  test("a granted custom role is scoped like an event admin; without audit.view it is refused at the gate", async () => {
    const r = await audit(viewerApi, `event_type=${PROBE}&limit=200`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.rows.map(x => x.type).sort(), "their event's row and their participant's").toEqual(["event", "person"]);
    expect(r.body.rows.every(x => x.competition_id === w.mine.id)).toBe(true);
    expect(r.text, "the decoy event's id appears nowhere").not.toContain(w.theirs.id);
    expect(r.text, "…nor its participant").not.toContain(w.inTheirs.id);
    expect(r.body.types, "settings are not among their types").not.toContain("setting");
    const set = await audit(viewerApi, "types=setting");
    expect(set.status, "naming settings is refused").toBe(403);
    expect(set.body.code).toBe("audit_type_forbidden");
    // CONTROL — the superadmin sees the decoy's rows.
    const sa = await audit(w.sa, `event_type=${PROBE}&limit=200`);
    expect(sa.body.rows.length).toBe(4);
    expect(sa.text).toContain(w.theirs.id);

    const blind = await audit(noAuditApi, "limit=5");
    expect(blind.status, "a role without the audit page").toBe(403);
    expect(blind.body.code).toBe("permission_denied");
    expect(blind.body.permission).toBe("audit.view");
    // CONTROL — the same session reads what it does hold.
    expect((await noAuditApi.get("/api/admin/competitions")).status()).toBe(200);
  });

  test("a person row about a privileged account is withheld from an organiser even when it shares their event", async () => {
    const ea = await audit(w.eaApi, `types=person&event_type=${PRIV}`);
    expect(ea.status, ea.text).toBe(200);
    expect(ea.body.rows.map(x => x.details.who), "the participant's row only").toEqual(["participant"]);
    expect(ea.text, "the admin's id appears nowhere").not.toContain(priv.id);
    // CONTROL — both rows exist.
    const sa = await audit(w.sa, `types=person&event_type=${PRIV}`);
    expect(sa.body.rows.map(x => x.details.who).sort()).toEqual(["participant", "privileged"]);
  });

  test("the cache holds the hand: an organiser's readable sealed answer is never served to a superadmin through their seat, nor the reverse", async () => {
    test.setTimeout(120_000);
    const SUP = await makeAdmin(w, "audsup", "superadmin");
    const s = await apiLogin(SUP.email, PARTICIPANT_PASS);
    const imp = await s.api.post(`/api/admin/participants/${w.ea.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
    expect(imp.status(), `enter the organiser's admin view: ${await imp.text()}`).toBe(200);
    try {
      const q1 = `types=submission&subjectId=${sealedTask.id}&limit=7`;
      const t1 = Date.now();
      const own1 = await audit(w.eaApi, q1);
      expect(own1.body.rows.length).toBe(1);
      expect(own1.body.rows[0].details.answer, "the author reads their key").toBe(SEALKEY);
      const seat1 = await audit(s.api, q1);
      expect(Date.now() - t1, "both reads inside the 5 s cache window, or this proves nothing").toBeLessThan(4500);
      expect(seat1.status, seat1.text).toBe(200);
      expect(seat1.body.rows.length, "the seat sees the same submission").toBe(1);
      expect(seat1.body.rows[0].details.answer, "…but the hand is not the author: no seal by proxy").toBeNull();
      expect(seat1.text, "the key appears nowhere in the seat's body").not.toContain(SEALKEY);

      // The reverse order, on a URL neither has read.
      const q2 = `types=submission&subjectId=${sealedTask.id}&limit=8`;
      const t2 = Date.now();
      const seat2 = await audit(s.api, q2);
      expect(seat2.body.rows[0].details.answer, "the seat first: withheld").toBeNull();
      const own2 = await audit(w.eaApi, q2);
      expect(Date.now() - t2).toBeLessThan(4500);
      expect(own2.body.rows[0].details.answer, "the author is not handed the seat's body").toBe(SEALKEY);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H((await (await s.api.get("/api/csrf-token")).json()).csrfToken) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("a superadmin's reveal shows the answer on the very next read: the reveal set is in the cache key", async () => {
    test.setTimeout(120_000);
    const SUP2 = await makeAdmin(w, "audsup2", "superadmin");
    const s = await apiLogin(SUP2.email, PARTICIPANT_PASS);
    try {
      const q = `types=submission&subjectId=${sealedTask.id}&limit=9`;
      const t0 = Date.now();
      const before = await audit(s.api, q);
      expect(before.body.rows[0].details.answer, "not revealed yet: withheld").toBeNull();
      const rv = await s.api.post(`/api/admin/tasks/${sealedTask.id}/sealed-reveal`, { headers: H(s.csrf) });
      expect(rv.ok(), `reveal: ${rv.status()} ${await rv.text()}`).toBeTruthy();
      const after = await audit(s.api, q);
      expect(Date.now() - t0, "inside the 5 s cache window, or this proves nothing").toBeLessThan(4500);
      expect(after.body.rows[0].details.answer, "the reveal shows at once, not after the cache lapses").toBe(SEALKEY);
    } finally { await s.api.dispose(); }
  });

  test("a reveal never widens a competitor: once the revealing superadmin competes in an event holding the challenge, the answer is withheld again", async () => {
    test.setTimeout(120_000);
    const SUP3 = await makeAdmin(w, "audsup3", "superadmin");
    const s = await apiLogin(SUP3.email, PARTICIPANT_PASS);
    try {
      const q = `types=submission&subjectId=${sealedTask.id}&limit=13`;
      const rv = await s.api.post(`/api/admin/tasks/${sealedTask.id}/sealed-reveal`, { headers: H(s.csrf) });
      expect(rv.ok(), `reveal (not competing yet): ${rv.status()} ${await rv.text()}`).toBeTruthy();
      const before = await audit(s.api, q);
      expect(before.body.rows[0].details.answer, "CONTROL — revealed, so shown").toBe(SEALKEY);
      // The same superadmin now competes in an event that holds the challenge.
      const E = await makeCompetition(w.sa, w.saCsrf, "audcompete", { staff_compete: true });
      await assignTask(w.sa, w.saCsrf, sealedTask.id, [E.id]);
      await enrol(w.sa, w.saCsrf, E.id, [SUP3.id]);
      const after = await audit(s.api, q);
      expect(after.status, after.text).toBe(200);
      expect(after.body.rows.length, "the same submission").toBe(1);
      expect(after.body.rows[0].details.answer, "a competitor is never handed a key by an earlier reveal").toBeNull();
      expect(after.text, "the key appears nowhere in the body").not.toContain(SEALKEY);
    } finally { await s.api.dispose(); }
  });

  test("every way a writer records a failure reads as a failure; the successful twins do not", async () => {
    const label = (r) => r.details && r.details.label;
    const fail = await audit(w.sa, `actor=${encodeURIComponent(ACT)}&outcome=failure&limit=50`);
    expect(fail.status, fail.text).toBe(200);
    expect(fail.body.rows.map(label).sort()).toEqual(["cert-failed", "change-refused", "mail-failed", "removal-given-up", "report-failed", "report-refused", "test-failed"]);
    expect(fail.body.rows.every(r => r.outcome === "failure")).toBe(true);
    const ok = await audit(w.sa, `actor=${encodeURIComponent(ACT)}&outcome=success&limit=50`);
    expect(ok.body.rows.map(label).sort(), "CONTROL — the twins are successes").toEqual(["cert-sent", "change-confirmed", "mail-sent", "report-sent", "test-ok"]);
  });

  test("the count is counted on the first page only, stops at its ceiling as a floor, and the route is rate limited", async () => {
    test.setTimeout(120_000);
    const small = await audit(w.sa, `event_type=${SMALL}&limit=2`);
    expect(small.body.total, "CONTROL — a small set is counted exactly").toBe(3);
    expect(small.body.total_exact).toBe(true);
    const next = await audit(w.sa, `event_type=${SMALL}&limit=2&cursor=${encodeURIComponent(small.body.next_cursor)}`);
    expect(next.body.rows.length, "the next page is real").toBe(1);
    expect(next.body.total, "…and carries no recount").toBeNull();
    expect(next.body.total_exact).toBe(false);

    const bulk = await audit(w.sa, `event_type=${BULK}&limit=1`);
    expect(bulk.status, bulk.text).toBe(200);
    expect(bulk.body.total, "past the ceiling the total is the ceiling").toBe(COUNT_MAX);
    expect(bulk.body.total_exact, "…and says it is a floor").toBe(false);
    expect(bulk.body.has_more).toBe(true);

    await w.sa.post("/api/test/rate-limit-toggle", { headers: H(w.saCsrf), data: { enable: true } });
    try {
      const statuses = [];
      for (let i = 0; i < 61; i++) statuses.push((await w.sa.get(`/api/admin/audit?limit=1&types=event&rl=${i}`)).status());
      expect(statuses[0], "CONTROL — the first read is served").toBe(200);
      expect(statuses.filter(s => s === 429).length, "past 60 reads a minute the route answers 429").toBeGreaterThan(0);
    } finally {
      await w.sa.post("/api/test/rate-limit-toggle", { headers: H(w.saCsrf), data: { enable: false } });
    }
  });

  // The response cannot show WHERE the count stopped (a count that walked every
  // match and then reported the floor reads the same), so the walk's own bound
  // is pinned at the source: each source's count is a LIMITed subquery bound to
  // the matches still wanted, inside the list walk's own floor, and the loop
  // stops asking once the floor is passed.
  test("source: the count walks no further than its ceiling", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "audit.js"), "utf8"));
    const max = src.match(/const AUDIT_COUNT_MAX = (\d+);/);
    expect(max, "AUDIT_COUNT_MAX exists").toBeTruthy();
    expect(Number(max[1]), "…and is the ceiling this spec plants past").toBe(COUNT_MAX);
    const fn = src.match(/function _branchCount\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
    expect(fn, "_branchCount exists").toBeTruthy();
    expect(fn[1].split(",").map(x => x.trim()).slice(-2), "it takes the matches still wanted, and the list walk's floor").toEqual(["cap", "floor"]);
    expect(fn[2], "…bounded as the list's walk was").toMatch(/const win = _windowed\(def, w, floor\);/);
    expect(fn[2], "one LIMITed subquery per source").toMatch(/SELECT COUNT\(\*\) AS n FROM \(SELECT 1 FROM \$\{def\.from\} \$\{win\.where\} LIMIT \?\)/);
    expect(fn[2], "…bound to `cap`, after the filter's own parameters").toMatch(/\.get\(\.\.\.win\.params, cap\)/);
    const loop = src.match(/let totalN = 0, cut = false;\s*for \(const \[src, b\] of branches\) \{([\s\S]*?)\n\s*\}/);
    expect(loop, "the counting loop exists").toBeTruthy();
    expect(loop[1], "each source is asked for no more than the floor still allows").toMatch(/const left = AUDIT_COUNT_MAX \+ 1 - totalN;\s*if \(left <= 0\) break;/);
    expect(loop[1], "…within its walk's floor").toMatch(/_branchCount\(src, SOURCES\[src\], f, req, proj, left, b\.floor\)/);
  });
});
