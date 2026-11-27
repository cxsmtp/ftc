// @ts-check
// v8.12.7 (F2) — the superadmin surface over Checkmarx One accounts the platform
// created for participants it has since deleted: the withdrawal list, Retry,
// Remove anyway (an override), Mark removed (a dismiss), the participant DELETE's
// two counts, the alerts count and the /metrics families.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT. It drives the ROUTES on the shared test
// server, where no realm is ever called: nothing here stubs a transport. The
// runner's own behaviour — which calls it makes, when it holds, when it gives up
// — is locked in tests/cxone-erasure-withdrawal.spec.js, through a spawned child
// with a stubbed transport. Rows are PLANTED through a better-sqlite3 handle on
// the worker server's database, the way several specs write directly; no app
// module is required at module scope (the v7.20.2 rule — db.js opens its file at
// require time, before the per-file recycle wipes it).
//
// THE SHARED SERVER NEVER ACTS ON A ROW, AND THAT IS TWO GATES, NOT ONE. The
// runner is kicked by a retry and by every cascade, and under NODE_ENV=test it
// is held back by (1) the autorun opt-in, which tests/server-env.js pins off, and
// (2) the health predicate, which fails CLOSED because server.js starts the
// sweeper — the only thing that hands it one — with an early return under test.
// The "no change within one second" arm below pins the combined property: a
// retry on the shared server changes the row once and then nothing touches it.
// It goes red only if BOTH gates are lost — stated rather than claimed as a lock
// on either alone; each gate has its own arm in the harness spec.
//
// Every test owns its fixtures (participants, rows, ids), and the ledger is
// shared by the whole file, so every count assertion is a DELTA from a read taken
// in the same test.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, BASE, findLogLine } = require("./helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `cxw${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const LOGS = path.join(TEST_DATA_DIR, "logs");
const nowIso = () => new Date().toISOString();

function dbGet(sql, ...a) {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
}
function dbRun(sql, ...a) {
  const d = new Database(TEST_DB_PATH, { timeout: 5000 });
  try { return d.prepare(sql).run(...a); } finally { d.close(); }
}
const ledgerRow = (id) => dbGet("SELECT * FROM cxone_realm_accounts WHERE cxone_user_id=?", id);

/** Plant one ledger row. Defaults describe an account THIS installation created
 *  a minute ago for `userId`, in a confirmed realm, not yet marked for removal. */
function plant(userId, over = {}) {
  const row = {
    cxone_user_id: crypto.randomUUID(), iam_origin: "https://iam.checkmarx.net", tenant: "tenant1",
    realm_confirmed: 1, user_id: userId, competition_id: null, created_username: uniq(),
    provenance: "created", provenance_at: nowIso(), instance_origin: new URL(BASE).origin,
    recorded_at: nowIso(), pending_since: null, deletion_source: null, attempts: 0,
    first_failed_at: null, next_attempt_at: null, last_error: null, held_reason: null, attention: 0,
    override_reason: null, override_by: null, override_at: null, transferred_at: null,
    claim_token: null, claimed_at: null, given_up_at: null, ...over,
  };
  const cols = Object.keys(row);
  dbRun(`INSERT INTO cxone_realm_accounts (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`, row);
  return row.cxone_user_id;
}
/** A user id no row in `users` holds — the shape a deleted participant leaves. */
const goneUser = () => `gone-${crypto.randomUUID()}`;
/** A marked row of a deleted participant, in whatever state `over` describes. */
const plantPending = (over = {}) => plant(goneUser(), { pending_since: nowIso(), deletion_source: "cascade",
  next_attempt_at: nowIso(), ...over });

async function mkParticipant(sa, label) {
  const email = `${label}@company.example`;
  const { api, csrf } = await freshCtx();
  try {
    const reg = await registerPost(api, "/api/register", { headers: H(csrf), data: {
      firstName: "Withdraw", lastName: "Case", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "Testville", password: PARTICIPANT_PASS,
    }});
    expect(reg.status(), `register ${email}: ${await reg.text()}`).toBe(200);
  } finally { await api.dispose(); }
  const u = dbGet("SELECT id FROM users WHERE email=?", email);
  expect(u, `${email} must exist after register`).toBeTruthy();
  // Order matters: POST /approve REFUSES an unverified account.
  expect((await sa.api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(sa.csrf) })).ok()).toBeTruthy();
  expect((await sa.api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(sa.csrf) })).ok()).toBeTruthy();
  return { id: u.id, email };
}

async function listRows(sa) {
  const r = await sa.api.get("/api/admin/cxone/withdrawals");
  expect(r.status(), `list: ${await r.text()}`).toBe(200);
  return r.json();
}
const byId = (body, id) => (body.rows || []).find((r) => r.cxone_user_id === id);
const post = (who, action, data) => who.api.post(`/api/admin/cxone/withdrawals/${action}`, { headers: H(who.csrf), data });

/** The mirror line for one route emit about one account. */
const routeLine = (eventType, cxId) => findLogLine(LOGS,
  (j) => j.event_type === eventType && j.details && j.details.cxone_user_id === cxId,
  { what: `a ${eventType} line for ${cxId}` });

/** EVERY mirror line of one type about one account, oldest first, across every
 *  app log file. Read only after `routeLine` has found a LATER line: the mirror
 *  is written post-commit and in emit order, so once that line has landed, a
 *  line an earlier request would have written has landed too — which is what
 *  lets an ABSENCE be asserted without a sleep. */
function allRouteLines(eventType, cxId) {
  const out = [];
  for (const f of fs.readdirSync(LOGS).filter((n) => n.startsWith("app-") && n.endsWith(".jsonl")).sort()) {
    for (const l of fs.readFileSync(path.join(LOGS, f), "utf8").split("\n")) {
      if (!l) continue;
      let j; try { j = JSON.parse(l); } catch (_) { continue; }
      if (j.event_type === eventType && j.details && j.details.cxone_user_id === cxId) out.push(j);
    }
  }
  return out;
}

/** A SECOND superadmin — user-backed, so its session lives beside the built-in
 *  one (one session per USER, and these are two users). Signed in after the
 *  promotion, which purges the account's sessions. */
async function secondSuperadmin(sa) {
  const p = await mkParticipant(sa, uniq());
  const role = await sa.api.post(`/api/admin/participants/${p.id}/role`, { headers: H(sa.csrf), data: { role: "superadmin" } });
  expect(role.ok(), `promote to superadmin: ${await role.text()}`).toBeTruthy();
  const who = await apiLogin(p.email, PARTICIPANT_PASS);
  return { ...who, id: p.id };
}

/** What the runner writes when it stops at a hold (lib/cxone-withdraw.js `_hold`):
 *  the reason, the attention flag, and the next look. Planted directly — the
 *  shared server never runs the runner (see the header) — after a first approval
 *  has sent the row back to it. */
const runnerHolds = (id, reason) => dbRun(
  "UPDATE cxone_realm_accounts SET held_reason=?, attention=1, next_attempt_at=? WHERE cxone_user_id=?",
  reason, new Date(Date.now() + 7 * 24 * 3600e3).toISOString(), id);

test.describe("v8.12.7 — Checkmarx One account withdrawals (superadmin surface)", () => {
  /** @type {any} */ let sa;
  test.beforeAll(async () => { sa = await apiLogin("superadmin"); });
  test.afterAll(async () => { if (sa) await sa.api.dispose(); });

  test("only a superadmin reaches the list, Retry and Mark removed; an event admin is told why", async () => {
    const body = await listRows(sa);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(Object.keys(body.counts).sort()).toEqual(["given_up", "held", "needs_attention", "retrying", "total", "unmarked"]);
    expect(typeof body.cxone_in_use).toBe("boolean");
    // Beside the per-state partition, never inside it: how many are kept past the
    // retention window, and which window that is.
    expect(Number.isInteger(body.past_retention_count)).toBe(true);
    expect(body.retention_days).toBe(730);

    // A regular admin — user-backed, promoted, signed in AFTER the promotion (a
    // role change purges the account's sessions).
    const ra = await mkParticipant(sa, uniq());
    expect((await sa.api.post(`/api/admin/participants/${ra.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } })).ok()).toBeTruthy();
    // An event admin — promoted by the grant on an upcoming event.
    const ea = await mkParticipant(sa, uniq());
    const comp = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
      name: `${TAG} tiers`, start_time: new Date(Date.now() + 3600e3).toISOString(), duration_minutes: 120, timezone: "UTC",
    }});
    expect(comp.ok(), await comp.text()).toBeTruthy();
    const compId = (await comp.json()).competition.id;
    const grant = await sa.api.post(`/api/admin/competitions/${compId}/admins`, { headers: H(sa.csrf), data: { userId: ea.id } });
    expect(grant.ok(), await grant.text()).toBeTruthy();
    expect(dbGet("SELECT role FROM users WHERE id=?", ea.id).role, "precondition: the grant made them an event admin").toBe("event_admin");

    const target = plantPending();
    const admin = await apiLogin(ra.email, PARTICIPANT_PASS);
    const evAdmin = await apiLogin(ea.email, PARTICIPANT_PASS);
    try {
      expect((await admin.api.get("/api/admin/cxone/withdrawals")).status()).toBe(403);
      expect((await post(admin, "retry", { cxone_user_id: target })).status()).toBe(403);
      expect((await post(admin, "dismiss", { cxone_user_id: target })).status()).toBe(403);

      const g = await evAdmin.api.get("/api/admin/cxone/withdrawals");
      expect(g.status()).toBe(403);
      const gb = await g.json();
      expect(gb.code).toBe("event_admin_forbidden");
      expect(gb.error).toMatch(/Only a superadmin can see the Checkmarx One accounts waiting to be removed/);
      for (const action of ["retry", "dismiss"]) {
        const r = await post(evAdmin, action, { cxone_user_id: target });
        expect(r.status(), `event admin ${action}`).toBe(403);
        const b = await r.json();
        expect(b.code).toBe("event_admin_forbidden");
        expect(b.error).toMatch(/Only a superadmin can manage the removal of Checkmarx One accounts/);
      }
      // Neither refusal touched the row.
      const after = ledgerRow(target);
      expect(after.deletion_source).toBe("cascade");
      expect(after.attempts).toBe(0);
    } finally { await admin.api.dispose(); await evAdmin.api.dispose(); }
  });

  test("the list names every state with its reason, remedy and whether it may be overridden", async () => {
    const before = (await listRows(sa)).counts;
    const staleClaim = new Date(Date.now() - 60 * 60e3).toISOString();
    const ids = {
      retrying: plantPending(),
      inProgress: plantPending({ claim_token: crypto.randomUUID(), claimed_at: nowIso() }),
      adopted: plantPending({ held_reason: "adopted_by_tenant" }),
      // …with the sign that held it recorded, and a stale sign on a row no longer held.
      adoptedSignal: plantPending({ held_reason: "adopted_by_tenant", held_signal: "credential_after_deletion" }),
      staleSignal: plantPending({ held_signal: "role_mapping" }),
      rolesUnreadable: plantPending({ held_reason: "roles_unreadable" }),
      bindingUnreadable: plantPending({ held_reason: "binding_unreadable" }),
      detailsRefused: plantPending({ attention: 1, attempts: 1, last_error: "403/account_details_refused" }),
      provenance: plantPending({ held_reason: "provenance_unconfirmed" }),
      tokenRefused: plantPending({ attention: 1, attempts: 1, last_error: "401/token_refused" }),
      stalled: plantPending({ attention: 1, attempts: 3, last_error: "503/delete_failed" }),
      givenUp: plantPending({ attempts: 6, given_up_at: nowIso() }),
      unmarked: plant(goneUser()),
      unmarkedStaleClaim: plant(goneUser(), { claim_token: crypto.randomUUID(), claimed_at: staleClaim }),
    };
    // CONTROLS — never listed: a living participant's unmarked row, and a missing
    // participant's row a job is still working on (its claim is live).
    const living = await mkParticipant(sa, uniq());
    const livingRow = plant(living.id);
    const liveClaim = plant(goneUser(), { claim_token: crypto.randomUUID(), claimed_at: nowIso() });

    const body = await listRows(sa);
    const r = (k) => byId(body, ids[k]);
    for (const k of Object.keys(ids)) expect(r(k), `${k} must be listed`).toBeTruthy();
    expect(byId(body, livingRow), "a living participant's account is not waiting to be removed").toBeUndefined();
    expect(byId(body, liveClaim), "a row a job is still working on is not offered for action").toBeUndefined();

    expect(r("retrying")).toMatchObject({ state: "retrying", reason: null, remedy: null, overridable: false, in_progress: false });
    expect(r("inProgress")).toMatchObject({ state: "retrying", in_progress: true });
    expect(r("adopted")).toMatchObject({ state: "held", reason: "adopted_by_tenant", overridable: true,
      held_signal: null, held_signal_text: null });
    expect(r("adopted").remedy).toMatch(/Remove anyway/);
    expect(r("adopted").remedy).toMatch(/given it a role directly/);
    expect(r("adoptedSignal")).toMatchObject({ state: "held", reason: "adopted_by_tenant", held_signal: "credential_after_deletion" });
    expect(r("adoptedSignal").held_signal_text).toMatch(/after the participant was deleted/);
    expect(r("staleSignal"), "a sign is shown only while the row is held").toMatchObject({ state: "retrying", held_signal: null, held_signal_text: null });
    expect(r("rolesUnreadable")).toMatchObject({ state: "held", reason: "roles_unreadable", overridable: true });
    expect(r("rolesUnreadable").remedy).toMatch(/view-clients/);
    expect(r("rolesUnreadable").remedy, "never asks for the whole realm").not.toMatch(/view-realm/);
    // A living participant's set-up record that names the account but cannot be
    // read: overridable, and its remedy says it neither removes nor hands over.
    expect(r("bindingUnreadable")).toMatchObject({ state: "held", reason: "binding_unreadable", overridable: true,
      held_signal: null, held_signal_text: null });
    expect(r("bindingUnreadable").remedy).toMatch(/the record cannot be read/);
    expect(r("bindingUnreadable").remedy).toMatch(/neither removes the account nor gives it to them/);
    expect(r("detailsRefused")).toMatchObject({ state: "needs_attention", reason: "account_details_refused", overridable: false });
    expect(r("detailsRefused").remedy).toMatch(/refused to show its roles or its sign-in credentials/);
    // The one hold that is NOT overridable: it is the only evidence the account
    // is ours to remove at all.
    expect(r("provenance")).toMatchObject({ state: "held", reason: "provenance_unconfirmed", overridable: false });
    expect(r("provenance").remedy).toMatch(/will not remove it/);
    expect(r("tokenRefused")).toMatchObject({ state: "needs_attention", reason: "token_refused", overridable: false });
    expect(r("tokenRefused").remedy).toMatch(/refused the Checkmarx One key/);
    // A code with no remedy of its own reads as a stalled transient.
    expect(r("stalled")).toMatchObject({ state: "needs_attention", reason: "transient_stalled" });
    expect(r("stalled").remedy).toMatch(/keeps retrying/);
    expect(r("givenUp")).toMatchObject({ state: "given_up", reason: "given_up" });
    expect(r("givenUp").remedy).toMatch(/stopped retrying after 30 days/);
    expect(r("unmarked")).toMatchObject({ state: "unmarked", reason: "unmarked", overridable: false });
    expect(r("unmarked").remedy).toMatch(/nothing recorded their deletion/);
    expect(r("unmarkedStaleClaim"), "a stale claim does not hide a row").toMatchObject({ state: "unmarked", in_progress: false });
    // Nothing a realm answered, and no participant detail, rides a row.
    for (const k of Object.keys(ids)) {
      expect(Object.keys(r(k))).not.toContain("claim_token");
      expect(Object.keys(r(k))).not.toContain("email");
    }

    const after = body.counts;
    expect(after.retrying - before.retrying).toBe(3);
    expect(after.held - before.held).toBe(5);
    expect(after.needs_attention - before.needs_attention).toBe(3);
    expect(after.given_up - before.given_up).toBe(1);
    expect(after.unmarked - before.unmarked).toBe(2);
    expect(after.total - before.total).toBe(14);
    expect(body.cxone_in_use, "a deployment holding ledger rows is using Checkmarx One").toBe(true);
  });

  // ─── RT — no removal is dropped for its age. Past EVENT_RETENTION_DAYS (730
  // on the shared server) a row is kept and flagged `past_retention` — from its
  // DELETION, never the record's age — and counted beside the per-state counts,
  // never as one of them. The runner's side is in cxone-erasure-withdrawal.spec.js.
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600e3).toISOString();
  const unplant = (...ids) => dbRun(`DELETE FROM cxone_realm_accounts WHERE cxone_user_id IN (${ids.map(() => "?").join(",")})`, ...ids);

  test("RT-A1: a removal kept past the retention window is flagged from its deletion, counted apart from the states, and Retry and Mark removed record it", async () => {
    const pre = await listRows(sa);
    const oldDeletion = daysAgo(731);
    const ids = {
      old: plantPending({ held_reason: "adopted_by_tenant", attention: 1, pending_since: oldDeletion,
        recorded_at: daysAgo(800), provenance_at: daysAgo(800) }),
      // CONTROL — a deletion a day short of the window, on a record just as old.
      young: plantPending({ held_reason: "adopted_by_tenant", attention: 1, pending_since: daysAgo(729),
        recorded_at: daysAgo(800), provenance_at: daysAgo(800) }),
      // CONTROL — an old record with no deletion at all.
      oldUnmarked: plant(goneUser(), { recorded_at: daysAgo(800), provenance_at: daysAgo(800) }),
    };
    try {
      const body = await listRows(sa);
      expect(body.retention_days).toBe(730);
      expect(byId(body, ids.old)).toMatchObject({ state: "held", past_retention: true });
      expect(byId(body, ids.young)).toMatchObject({ state: "held", past_retention: false });
      expect(byId(body, ids.oldUnmarked)).toMatchObject({ state: "unmarked", past_retention: false });
      expect(body.past_retention_count - pre.past_retention_count).toBe(1);
      expect(body.past_retention_count, "the count is the listed rows' own flags").toBe(body.rows.filter((r) => r.past_retention === true).length);
      // Not a state: the per-state counts still partition `total`, and `total` is the list.
      expect(Object.keys(body.counts)).not.toContain("past_retention");
      const { total, ...states } = body.counts;
      expect(Object.values(states).reduce((a, b) => a + b, 0)).toBe(total);
      expect(total).toBe(body.rows.length);

      // Retry keeps the deletion's date, so the row stays past the window, and the
      // line says a removal kept past it was acted on.
      const r = await post(sa, "retry", { cxone_user_id: ids.old });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).row).toMatchObject({ cxone_user_id: ids.old, state: "retrying", past_retention: true });
      expect(ledgerRow(ids.old).pending_since).toBe(oldDeletion);
      expect((await routeLine("cxone_realm_withdrawal_retried", ids.old)).details.past_retention).toBe(true);
      // Mark removed records it too — and a young row's line has no such key at all.
      for (const id of [ids.young, ids.old]) {
        const d = await post(sa, "dismiss", { cxone_user_id: id });
        expect(d.status(), await d.text()).toBe(200);
      }
      expect((await routeLine("cxone_realm_withdrawal_dismissed", ids.old)).details.past_retention).toBe(true);
      expect(Object.keys((await routeLine("cxone_realm_withdrawal_dismissed", ids.young)).details)).not.toContain("past_retention");
    } finally { unplant(...Object.values(ids)); }
  });

  // A row crossing the cutoff between two reads would be flagged in one and not
  // the other — a millisecond window no request can be timed into, so the shape
  // is pinned at the source: each site lists ONCE and counts from those rows.
  test("RT-A2: the list route and /metrics take every count from the one list they read (source)", () => {
    const { stripJsComments } = require("./doc-registry");
    const read = (rel) => stripJsComments(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
    const anchored = (src, anchor, what) => {
      const at = src.search(anchor);
      expect(at, `anchor missing: ${what} — re-anchor this lock rather than weakening it`).toBeGreaterThan(-1);
      return at;
    };
    const misc = read("routes/admin-misc.js");
    const r0 = anchored(misc, /app\.get\(\s*"\/api\/admin\/cxone\/withdrawals"/, "the list route");
    const route = misc.slice(r0, misc.indexOf("\n});", r0));
    // The /metrics block is the `try { … } catch` around the withdrawal gauge's HELP line.
    const srv = read("server.js");
    const help = anchored(srv, /# HELP hack_arena_cxone_withdrawals Checkmarx One accounts/, "the withdrawal gauge");
    const metrics = srv.slice(srv.lastIndexOf("try {", help), srv.indexOf("} catch", help));
    expect(metrics.length, "the /metrics block was found").toBeGreaterThan(100);
    for (const [what, body] of [["the list route", route], ["/metrics", metrics]]) {
      expect((body.match(/\blistCxOneWithdrawals\s*\(/g) || []).length, `${what} lists once`).toBe(1);
      expect(body, `${what}: the state counts come from the listed rows`).toMatch(/\bcxOneWithdrawalCounts\(\s*\{\s*rows\b/);
      expect(body, `${what}: the past-retention count comes from the listed rows`).toMatch(/\bcxOneWithdrawalPastRetentionCount\(\s*\{\s*rows\b/);
      expect(body, `${what}: no count reads the ledger again`).not.toMatch(/\b(cxOneWithdrawalCounts|cxOneWithdrawalPastRetentionCount)\(\s*\)/);
    }
  });

  test("RT-A3: /metrics carries the past-retention gauge, read from the database", async () => {
    const id = plantPending({ held_reason: "adopted_by_tenant", attention: 1, pending_since: daysAgo(731) });
    try {
      await new Promise((res) => setTimeout(res, 1100));   // the /metrics body is memoised for 1 s
      const t = await (await sa.api.get("/metrics")).text();
      expect(t).toContain("# TYPE hack_arena_cxone_withdrawals_past_retention gauge");
      const m = /^hack_arena_cxone_withdrawals_past_retention (\d+)$/m.exec(t);
      expect(m, t).toBeTruthy();
      const body = await listRows(sa);
      expect(body.past_retention_count, "precondition: the planted row is past the window").toBeGreaterThanOrEqual(1);
      expect(Number(m[1])).toBe(body.past_retention_count);
    } finally { unplant(id); }
  });

  test("Retry schedules an unmarked row as the superadmin's decision, carries the address, and nothing runs within a second", async () => {
    // Validation first: the id is required, and an unknown one is not found.
    expect((await post(sa, "retry", {})).status()).toBe(400);
    const unknown = await post(sa, "retry", { cxone_user_id: crypto.randomUUID() });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).code).toBe("cxone_withdrawal_not_found");

    const id = plant(goneUser());
    expect(ledgerRow(id).pending_since, "precondition: unmarked").toBeNull();
    const r = await post(sa, "retry", { cxone_user_id: id });
    expect(r.status(), await r.text()).toBe(200);
    const b = await r.json();
    expect(b.row).toMatchObject({ cxone_user_id: id, state: "retrying", deletion_source: "superadmin" });

    const row = ledgerRow(id);
    expect(row.pending_since).toBeTruthy();
    expect(row.deletion_source).toBe("superadmin");
    expect(row.next_attempt_at).toBeTruthy();
    expect(row.attempts).toBe(0);
    expect(row.override_reason, "a plain Retry is not an override").toBeNull();

    const line = await routeLine("cxone_realm_withdrawal_retried", id);
    expect(line.details.ip, "the requester's address rides the line (v7.21.32)").toBeTruthy();
    expect(line.details.realm).toEqual({ iam_origin: "https://iam.checkmarx.net", tenant: "tenant1" });
    expect(line.details.override_reason).toBeUndefined();

    // The shared server never acts on the row (see the header: two gates).
    // A fixed wait is the only way to assert something did NOT happen; one
    // second is far beyond a kick, which is synchronous up to its first await.
    await new Promise((res) => setTimeout(res, 1000));
    expect(ledgerRow(id), "no attempt, no claim, no error — the row is exactly as the retry left it").toEqual(row);
  });

  test("Remove anyway is refused on a hold that cannot be overridden, and remembered on one that can", async () => {
    // v8.13.1 — every override names the hold its human read (`expected_hold`),
    // and here it names the hold the row really is held for, so each refusal
    // below is the OVERRIDABILITY refusal and not the stale-confirmation one
    // (that is the next three tests).
    const provenance = plantPending({ held_reason: "provenance_unconfirmed" });
    const refused = await post(sa, "retry", { cxone_user_id: provenance, override: true, expected_hold: "provenance_unconfirmed" });
    expect(refused.status()).toBe(409);
    const rb = await refused.json();
    expect(rb.code).toBe("cxone_withdrawal_not_overridable");
    expect(rb.error).toMatch(/cannot confirm it created this account/);
    expect(ledgerRow(provenance)).toMatchObject({ held_reason: "provenance_unconfirmed", override_reason: null });

    // An override on a row that is not held at all is refused too. Since v8.13.1
    // it cannot even name the hold it would override (nothing holds the row), so
    // the refusal is the stale-confirmation one — and it still changes nothing.
    // `override: "true"` stays a STRING: the bool coercion is part of this door.
    const plain = plantPending();
    const plainBefore = ledgerRow(plain);
    const notHeld = await post(sa, "retry", { cxone_user_id: plain, override: "true", expected_hold: "adopted_by_tenant" });
    expect(notHeld.status()).toBe(409);
    expect((await notHeld.json()).code).toBe("cxone_withdrawal_hold_changed");
    expect(ledgerRow(plain), "a refused override leaves the row exactly as it was").toEqual(plainBefore);

    // CONTROL — an overridable hold is lifted, and the decision is recorded.
    const adopted = plantPending({ held_reason: "adopted_by_tenant", attempts: 2, attention: 1 });
    const ok = await post(sa, "retry", { cxone_user_id: adopted, override: true, expected_hold: "adopted_by_tenant" });
    expect(ok.status(), await ok.text()).toBe(200);
    const row = ledgerRow(adopted);
    expect(row).toMatchObject({ held_reason: null, attention: 0, attempts: 0, override_reason: "adopted_by_tenant",
      deletion_source: "cascade" });
    expect(row.override_by).toBeTruthy();
    expect(row.override_at).toBeTruthy();
    const line = await routeLine("cxone_realm_withdrawal_retried", adopted);
    expect(line.details.override_reason).toBe("adopted_by_tenant");
    expect(line.details.ip).toBeTruthy();

    // The visibility hold is overridable on its own, and the sign an adoption
    // hold recorded goes with the hold it named.
    const ru = plantPending({ held_reason: "roles_unreadable", attention: 1 });
    const okRu = await post(sa, "retry", { cxone_user_id: ru, override: true, expected_hold: "roles_unreadable" });
    expect(okRu.status(), await okRu.text()).toBe(200);
    expect(ledgerRow(ru)).toMatchObject({ held_reason: null, override_reason: "roles_unreadable" });
    // So is the hold on a set-up record that cannot be read — named as the hold
    // it is; another hold's name is the stale-confirmation refusal, row unchanged.
    const bu = plantPending({ held_reason: "binding_unreadable", attention: 1 });
    const buBefore = ledgerRow(bu);
    const staleBu = await post(sa, "retry", { cxone_user_id: bu, override: true, expected_hold: "roles_unreadable" });
    expect(staleBu.status(), await staleBu.text()).toBe(409);
    expect((await staleBu.json()).code).toBe("cxone_withdrawal_hold_changed");
    expect(ledgerRow(bu), "a refused override leaves the row exactly as it was").toEqual(buBefore);
    const okBu = await post(sa, "retry", { cxone_user_id: bu, override: true, expected_hold: "binding_unreadable" });
    expect(okBu.status(), await okBu.text()).toBe(200);
    expect(ledgerRow(bu)).toMatchObject({ held_reason: null, attention: 0, override_reason: "binding_unreadable" });
    const buLine = await routeLine("cxone_realm_withdrawal_retried", bu);
    expect(buLine.details.override_reason).toBe("binding_unreadable");
    // The sign the confirm quoted rides the override too: another sign, or none
    // where the row shows one, is the stale-confirmation refusal (row unchanged).
    const sig = plantPending({ held_reason: "adopted_by_tenant", held_signal: "role_mapping", attention: 1 });
    const sigBefore = ledgerRow(sig);
    for (const extra of [{ expected_signal: "foreign_group" }, {}, { expected_signal: null }]) {
      const st = await post(sa, "retry", { cxone_user_id: sig, override: true, expected_hold: "adopted_by_tenant", ...extra });
      expect(st.status(), `${JSON.stringify(extra)}: ${await st.text()}`).toBe(409);
      const sb = await st.json();
      expect(sb.code).toBe("cxone_withdrawal_hold_changed");
      expect(sb.error).toMatch(/now holds it for something else it found/);
      expect(sb.row).toMatchObject({ held_reason: "adopted_by_tenant", held_signal: "role_mapping" });
      expect(ledgerRow(sig), "a refused override leaves the row exactly as it was").toEqual(sigBefore);
    }
    const okSig = await post(sa, "retry", { cxone_user_id: sig, override: true, expected_hold: "adopted_by_tenant", expected_signal: "role_mapping" });
    expect(okSig.status(), await okSig.text()).toBe(200);
    expect(ledgerRow(sig)).toMatchObject({ held_reason: null, held_signal: null, override_reason: "adopted_by_tenant" });
  });

  // ─── v8.13.1 (external audit, P2) — a Remove anyway overrides the hold its
  // human READ, never whatever the row is held for when the request lands. Two
  // superadmins open the list together; the first approval sends the row back to
  // the runner, which can stop at a DIFFERENT hold; the second, stale confirmation
  // used to override that new hold too, though its confirm quoted the old reason
  // and nobody had read the new one.

  test("v8.13.1: Remove anyway must name the hold it overrides — an override that does not is refused and changes nothing; a plain Retry needs no name", async () => {
    const id = plantPending({ held_reason: "adopted_by_tenant", attempts: 2, attention: 1 });
    const before = ledgerRow(id);
    expect(before.held_reason, "precondition: held for an overridable reason").toBe("adopted_by_tenant");
    // Absent, and null (validateBody reads null as absent) — both the old client's
    // shape and a hand-made one. Neither guesses at what it was meant to override.
    for (const body of [{ cxone_user_id: id, override: true }, { cxone_user_id: id, override: true, expected_hold: null }]) {
      const r = await post(sa, "retry", body);
      expect(r.status(), `${JSON.stringify(body)}: ${await r.text()}`).toBe(400);
      const b = await r.json();
      expect(b.code).toBe("cxone_withdrawal_expected_hold_required");
      expect(b.error).toMatch(/Reload the page, read the reason the platform is holding this account/);
      expect(b, "the 400 does not hand back a row nobody asked about").not.toHaveProperty("row");
      expect(ledgerRow(id), "a refused override leaves the row exactly as it was").toEqual(before);
    }
    // An empty name is not a name either (the boundary refuses it before the helper).
    const empty = await post(sa, "retry", { cxone_user_id: id, override: true, expected_hold: "" });
    expect(empty.status()).toBe(400);
    expect(ledgerRow(id)).toEqual(before);

    // CONTROL — a plain Retry overrides nothing, so it names nothing and goes
    // through: the hold is cleared for the runner to look again, and no override
    // is recorded.
    const retry = await post(sa, "retry", { cxone_user_id: id });
    expect(retry.status(), await retry.text()).toBe(200);
    expect(ledgerRow(id)).toMatchObject({ held_reason: null, attention: 0, attempts: 0, override_reason: null, override_by: null });
    // …and a name sent WITHOUT an override is ignored (swagger says so), even a
    // stale one: a Retry lifts no hold, so there is nothing for it to be wrong about.
    const id2 = plantPending({ held_reason: "adopted_by_tenant", attention: 1 });
    const retry2 = await post(sa, "retry", { cxone_user_id: id2, expected_hold: "instance_mismatch" });
    expect(retry2.status(), await retry2.text()).toBe(200);
    expect(ledgerRow(id2)).toMatchObject({ held_reason: null, override_reason: null, override_by: null });
  });

  test("v8.13.1: two superadmins read the same hold; after the first approval the runner holds for a DIFFERENT reason, and the second, stale Remove anyway is refused", async () => {
    const sa2 = await secondSuperadmin(sa);
    try {
      const id = plantPending({ held_reason: "adopted_by_tenant", attention: 1 });
      // Both humans read the list: the hold each is about to overrule.
      const readA = byId(await listRows(sa), id);
      const readB = byId(await listRows(sa2), id);
      expect(readA).toMatchObject({ state: "held", held_reason: "adopted_by_tenant", overridable: true });
      expect(readB.held_reason, "precondition: the colleague read the same hold").toBe(readA.held_reason);

      // The first approval lands.
      const first = await post(sa, "retry", { cxone_user_id: id, override: true, expected_hold: readA.held_reason });
      expect(first.status(), await first.text()).toBe(200);
      expect(ledgerRow(id)).toMatchObject({ held_reason: null, override_reason: "adopted_by_tenant", override_by: "superadmin" });
      // The runner passes the adoption check (overridden) and stops at the address
      // check — a hold nobody has read yet, and an overridable one, so a build that
      // does not compare would override it.
      runnerHolds(id, "address_held_by_living_account");
      const held = ledgerRow(id);
      expect(held.held_reason, "precondition: now held for a different reason").toBe("address_held_by_living_account");

      // The colleague's confirmation, still quoting what THEY read.
      const stale = await post(sa2, "retry", { cxone_user_id: id, override: true, expected_hold: readB.held_reason });
      expect(stale.status(), await stale.text()).toBe(409);
      const sb = await stale.json();
      expect(sb.code).toBe("cxone_withdrawal_hold_changed");
      expect(sb.error).toMatch(/now holds it for a different reason/);
      // The row as it stands NOW, so the list can show the reason nobody read.
      expect(sb.row).toMatchObject({ cxone_user_id: id, state: "held", held_reason: "address_held_by_living_account",
        reason: "address_held_by_living_account", overridable: true, override_reason: "adopted_by_tenant" });
      expect(sb.row.remedy).toMatch(/A participant still on this platform holds this account's email address/);
      expect(Object.keys(sb.row), "the refusal carries the list's projection, not the ledger row").not.toContain("claim_token");
      expect(ledgerRow(id), "the stale confirmation changed nothing — the new hold stands, not overridden").toEqual(held);

      // CONTROL — the same colleague, having read the NEW reason, overrides it: the
      // decision is theirs and joins the earlier one rather than replacing it.
      const fresh = await post(sa2, "retry", { cxone_user_id: id, override: true, expected_hold: sb.row.held_reason });
      expect(fresh.status(), await fresh.text()).toBe(200);
      expect(ledgerRow(id)).toMatchObject({ held_reason: null, attention: 0,
        override_reason: "adopted_by_tenant,address_held_by_living_account", override_by: sa2.id });

      // The refusal wrote no audit line: once the control's line has landed, every
      // earlier one has, and there are exactly the two approvals.
      await findLogLine(LOGS, (j) => j.event_type === "cxone_realm_withdrawal_retried" && j.details
        && j.details.cxone_user_id === id && j.details.override_reason === "address_held_by_living_account",
        { what: `the control's retried line for ${id}` });
      expect(allRouteLines("cxone_realm_withdrawal_retried", id).map((j) => j.details.override_reason))
        .toEqual(["adopted_by_tenant", "address_held_by_living_account"]);
    } finally { await sa2.api.dispose(); }
  });

  test("v8.13.1: a stale Remove anyway against a row the platform no longer holds at all is refused, and says it is no longer held", async () => {
    const sa2 = await secondSuperadmin(sa);
    try {
      const id = plantPending({ held_reason: "instance_mismatch", attention: 1 });
      const read = byId(await listRows(sa2), id).held_reason;
      expect(read, "precondition: read while held").toBe("instance_mismatch");
      const first = await post(sa, "retry", { cxone_user_id: id, override: true, expected_hold: "instance_mismatch" });
      expect(first.status(), await first.text()).toBe(200);
      const after = ledgerRow(id);
      expect(after, "precondition: the row is back with the runner, not held").toMatchObject({ held_reason: null, override_reason: "instance_mismatch" });

      const stale = await post(sa2, "retry", { cxone_user_id: id, override: true, expected_hold: read });
      expect(stale.status(), await stale.text()).toBe(409);
      const sb = await stale.json();
      expect(sb.code).toBe("cxone_withdrawal_hold_changed");
      expect(sb.error).toMatch(/no longer holding it for that reason/);
      expect(sb.row).toMatchObject({ cxone_user_id: id, state: "retrying", held_reason: null, overridable: false });
      // Nothing moved: not the override's author, not its time, not the instance.
      expect(ledgerRow(id)).toEqual(after);
    } finally { await sa2.api.dispose(); }
  });

  test("Mark removed stops tracking a deleted participant's account — never a living participant's, never one being worked on", async () => {
    const living = await mkParticipant(sa, uniq());
    const livingRow = plant(living.id);
    const r = await post(sa, "dismiss", { cxone_user_id: livingRow });
    expect(r.status()).toBe(404);
    expect((await r.json()).code).toBe("cxone_withdrawal_not_found");
    expect(ledgerRow(livingRow), "a living participant's account is still recorded").toBeTruthy();

    const busy = plantPending({ claim_token: crypto.randomUUID(), claimed_at: nowIso() });
    const b = await post(sa, "dismiss", { cxone_user_id: busy });
    expect(b.status()).toBe(409);
    expect((await b.json()).code).toBe("cxone_withdrawal_in_progress");
    expect(ledgerRow(busy)).toBeTruthy();

    // CONTROL — an unmarked row of a deleted participant is removed from the ledger.
    const gone = goneUser();
    const id = plant(gone);
    const ok = await post(sa, "dismiss", { cxone_user_id: id });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(ledgerRow(id)).toBeUndefined();
    const line = await routeLine("cxone_realm_withdrawal_dismissed", id);
    expect(line.details.ip).toBeTruthy();
    expect(line.scope_id).toBe(gone);
  });

  test("deleting a participant schedules the accounts the platform made, and counts apart the MATCHED ones it leaves and the CREATED ones it holds no record of", async () => {
    const p = await mkParticipant(sa, uniq());
    const other = await mkParticipant(sa, uniq());
    const owned = plant(p.id);
    const othersRow = plant(other.id);
    // The provisioning history: a MATCHED account (not ours — left in place), and
    // the created one again (in the ledger — not counted twice).
    const matched = crypto.randomUUID();
    const hist = (d) => dbRun("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(), p.id, "cxone_provisioned", "system", nowIso(), JSON.stringify(d));
    hist({ success: true, cxone_user_id: matched, username: p.email, already_existed: true, matched_by: "email" });
    hist({ success: true, cxone_user_id: owned, username: "x", already_existed: false });
    hist({ success: false, cxone_user_id: crypto.randomUUID(), username: "y" });
    // (pre-release review) — accounts the platform CREATED that its ledger does
    // not hold are NOT "already existed in the tenant": one made before any id
    // was recorded, one made by a pre-ledger job, and one a 201 with no Location
    // left to be found again by search (a matched_by key, yet ours).
    const unrecordedIds = [crypto.randomUUID(), crypto.randomUUID()];
    hist({ success: true, username: "made-before-ids", already_existed: false });
    hist({ success: true, cxone_user_id: unrecordedIds[0], username: "made-pre-ledger", already_existed: false });
    hist({ success: true, cxone_user_id: unrecordedIds[1], username: "no-location", already_existed: false, matched_by: "username" });

    const del = await sa.api.delete(`/api/admin/participants/${p.id}`, { headers: H(sa.csrf) });
    expect(del.status(), await del.text()).toBe(200);
    expect(await del.json()).toEqual({ ok: true, cxone_withdrawals_scheduled: 1, cxone_accounts_left_in_place: 1,
      cxone_accounts_unrecorded: 3 });

    expect(ledgerRow(owned)).toMatchObject({ user_id: p.id, deletion_source: "cascade" });
    expect(ledgerRow(owned).pending_since).toBeTruthy();
    expect(ledgerRow(othersRow).pending_since, "another participant's account is untouched").toBeNull();
    expect(byId(await listRows(sa), owned)).toMatchObject({ state: "retrying", deletion_source: "cascade" });

    const line = await findLogLine(LOGS, (j) => j.event_type === "deleted" && j.scope_id === p.id,
      { what: `the deleted line for ${p.id}` });
    expect(line.details.cxone_withdrawals_scheduled).toBe(1);
    expect(line.details.cxone_accounts_left_in_place).toBe(1);
    expect(line.details.cxone_accounts_unrecorded).toBe(3);
    for (const h of [matched, ...unrecordedIds]) {
      expect(JSON.stringify(line.details), "counts only — no realm handle for an erased person").not.toContain(h);
    }

    // CONTROL — no ledger row and no history: neither field appears anywhere.
    const q = await mkParticipant(sa, uniq());
    const del2 = await sa.api.delete(`/api/admin/participants/${q.id}`, { headers: H(sa.csrf) });
    expect(del2.status()).toBe(200);
    expect(await del2.json()).toEqual({ ok: true });
    const line2 = await findLogLine(LOGS, (j) => j.event_type === "deleted" && j.scope_id === q.id,
      { what: `the deleted line for ${q.id}` });
    expect(line2.details).not.toHaveProperty("cxone_withdrawals_scheduled");
    expect(line2.details).not.toHaveProperty("cxone_accounts_left_in_place");
    expect(line2.details).not.toHaveProperty("cxone_accounts_unrecorded");
    expect(line2.details).not.toHaveProperty("cxone_records_unreadable");
  });

  test("deleting a participant counts a Checkmarx One set-up record it cannot read, and never echoes its text", async () => {
    const p = await mkParticipant(sa, uniq());
    const owned = plant(p.id);
    const raw = (uid, type, text) => dbRun("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(), uid, type, "system", nowIso(), text);
    const tail = `tail${uniq()}`;
    raw(p.id, "cxone_provisioned", JSON.stringify({ success: true, cxone_user_id: crypto.randomUUID(), username: "m",
      already_existed: true, matched_by: "email" }));
    raw(p.id, "cxone_provisioned", `{"success":true,"already_existed":false,"username":"${tail}"`); // torn
    raw(p.id, "cxone_binding_cleared", `{"cleared_cxone_user_id":"${owned}"`); // torn, ignored
    const del = await sa.api.delete(`/api/admin/participants/${p.id}`, { headers: H(sa.csrf) });
    expect(del.status(), await del.text()).toBe(200);
    expect(await del.json()).toEqual({ ok: true, cxone_withdrawals_scheduled: 1, cxone_accounts_left_in_place: 1,
      cxone_records_unreadable: 1 });
    const line = await findLogLine(LOGS, (j) => j.event_type === "deleted" && j.scope_id === p.id,
      { what: `the deleted line for ${p.id}` });
    expect(line.details.cxone_records_unreadable).toBe(1);
    expect(line.details).not.toHaveProperty("cxone_accounts_unrecorded");
    expect(JSON.stringify(line.details), "counts only — never the damaged record's text").not.toContain(tail);

    // CONTROL — readable records only: the key appears in neither place.
    const q = await mkParticipant(sa, uniq());
    raw(q.id, "cxone_provisioned", JSON.stringify({ success: true, cxone_user_id: crypto.randomUUID(), username: "n",
      already_existed: true, matched_by: "email" }));
    raw(q.id, "cxone_provisioned", JSON.stringify({ success: false, error: "boom" }));
    const del2 = await sa.api.delete(`/api/admin/participants/${q.id}`, { headers: H(sa.csrf) });
    expect(del2.status()).toBe(200);
    expect(await del2.json()).toEqual({ ok: true, cxone_accounts_left_in_place: 1 });
    const line2 = await findLogLine(LOGS, (j) => j.event_type === "deleted" && j.scope_id === q.id,
      { what: `the deleted line for ${q.id}` });
    expect(line2.details.cxone_accounts_left_in_place).toBe(1);
    expect(line2.details).not.toHaveProperty("cxone_records_unreadable");
  });

  // 9.2.16 (operator, 25 Nov 2026: "unverified account autodeletion should also
  // delete Cx1 accounts") — the unverified-account reaper goes through the same
  // cascade as the admin's DELETE, so the account the platform created and
  // recorded is stamped for removal exactly as a manual deletion stamps it, and
  // its `account_reaped` record carries the same four counts (lib/cxone-ledger.js
  // `cxoneDeletionCounts`), read before the cascade deletes the history.
  test("the unverified-account reaper schedules the reaped person's recorded Checkmarx One account and records the same counts a manual delete does", async () => {
    /** An abandoned, never-verified sign-up in the reaper's gate, aged past 48 h. */
    async function abandoned(label) {
      const email = `${label}@company.example`;
      const { api, csrf } = await freshCtx();
      try {
        const reg = await registerPost(api, "/api/register", { headers: H(csrf), data: {
          firstName: "Reap", lastName: "Case", nickname: label, email, company: "Acme", title: "Engineer",
          country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "Testville",
        }});
        expect(reg.status(), `register ${email}: ${await reg.text()}`).toBe(200);
      } finally { await api.dispose(); }
      const u = dbGet("SELECT id, verified, approved, first_verified_at FROM users WHERE email=?", email);
      expect([u.verified, u.approved, u.first_verified_at], "PRECONDITION: never verified, not approved").toEqual([0, 0, null]);
      dbRun("UPDATE users SET created_at=? WHERE id=?", new Date(Date.now() - 49 * 3600e3).toISOString(), u.id);
      return { id: u.id, email };
    }
    const p = await abandoned(uniq());
    const c = await abandoned(uniq()); // CONTROL — no Checkmarx One history at all
    const q = await abandoned(uniq()); // only an unreadable set-up record: someone must check
    const m = await abandoned(uniq()); // only a matched account: the tenant's, nothing to check
    const owned = plant(p.id);
    const raw = (text) => dbRun("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(), p.id, "cxone_provisioned", "system", nowIso(), text);
    const matched = crypto.randomUUID(), unrecorded = crypto.randomUUID();
    raw(JSON.stringify({ success: true, cxone_user_id: owned, username: "own", already_existed: false }));                        // recorded: scheduled
    raw(JSON.stringify({ success: true, cxone_user_id: matched, username: "m", already_existed: true, matched_by: "email" }));    // left in place
    raw(JSON.stringify({ success: true, cxone_user_id: unrecorded, username: "pre-ledger", already_existed: false }));            // created, unrecorded
    const tail = `tail${uniq()}`;
    raw(`{"success":true,"already_existed":false,"username":"${tail}"`);                                                         // unreadable (torn)
    expect(ledgerRow(owned).pending_since, "PRECONDITION: the recorded account is not yet marked").toBeNull();
    const rawFor = (uid, text) => dbRun("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(), uid, "cxone_provisioned", "system", nowIso(), text);
    rawFor(q.id, `{"success":true,"already_existed":false,"username":"q${uniq()}"`);                                    // torn only
    rawFor(m.id, JSON.stringify({ success: true, cxone_user_id: crypto.randomUUID(), username: "mm", already_existed: true, matched_by: "email" }));

    const { api: t, csrf: tc } = await freshCtx();
    let res;
    try {
      const r = await t.post("/api/test/reap-accounts", { headers: H(tc), data: { floorIso: null } });
      expect(r.status(), await r.text()).toBe(200);
      res = await r.json();
    } finally { await t.dispose(); }
    expect([...res.ids].sort(), "exactly the four abandoned accounts are reaped").toEqual([p.id, c.id, q.id, m.id].sort());
    expect(dbGet("SELECT COUNT(*) AS n FROM users WHERE id IN (?,?,?,?)", p.id, c.id, q.id, m.id).n).toBe(0);

    // The recorded account is stamped for removal by the cascade, as a manual delete stamps it.
    expect(ledgerRow(owned)).toMatchObject({ user_id: p.id, deletion_source: "cascade" });
    expect(ledgerRow(owned).pending_since, "the reaped person's account is marked for removal").toBeTruthy();

    // The Audit page's stored copy of the reaper's record carries the four counts, by value.
    const copy = (id) => {
      const rows = new Database(TEST_DB_PATH, { readonly: true });
      try { return rows.prepare("SELECT details FROM orphan_events WHERE scope='user' AND scope_id=? AND event_type='account_reaped'").all(id); }
      finally { rows.close(); }
    };
    const rec = copy(p.id);
    expect(rec.length, "one account_reaped record").toBe(1);
    const d = JSON.parse(rec[0].details);
    expect({ s: d.cxone_withdrawals_scheduled, l: d.cxone_accounts_left_in_place, u: d.cxone_accounts_unrecorded, r: d.cxone_records_unreadable },
      "the reaper records the same counts a manual delete does").toEqual({ s: 1, l: 1, u: 1, r: 1 });
    expect(d.reason).toBe("unverified_48h");
    for (const h of [owned, matched, unrecorded, tail]) {
      expect(rec[0].details, "counts only — no realm handle or record text for an erased person").not.toContain(h);
    }
    // No human is in the loop, so the accounts that need one reach the log at warn, counts only.
    const warn = await findLogLine(LOGS, (j) => j.level === "warn" && j.user_id === p.id && j.tag === "account-reaper",
      { what: `the reaper's warn line for ${p.id}` });
    expect([warn.cxone_accounts_unrecorded, warn.cxone_records_unreadable]).toEqual([1, 1]);
    expect(JSON.stringify(warn), "never an address").not.toContain(p.email);
    // An unreadable record alone warns too (the condition's second half).
    const qWarn = await findLogLine(LOGS, (j) => j.level === "warn" && j.user_id === q.id && j.tag === "account-reaper",
      { what: `the reaper's warn line for ${q.id}` });
    expect([qWarn.cxone_records_unreadable, qWarn.cxone_accounts_unrecorded], "an unreadable record alone: a warn line").toEqual([1, undefined]);
    expect(JSON.parse(copy(m.id)[0].details).cxone_accounts_left_in_place, "PRECONDITION: the matched account is counted as left in place").toBe(1);
    // NEGATIVE (after the positives above): nobody with nothing to check is warned about,
    // neither the control nor a person whose only account is the tenant's.
    const stray = await findLogLine(LOGS, (j) => j.level === "warn" && j.tag === "account-reaper" && (j.user_id === c.id || j.user_id === m.id),
      { timeoutMs: 2000, what: "a stray reaper warn line" }).catch(() => null);
    expect(stray, "no warn line for a reaped person with nothing to check").toBeNull();

    // CONTROL — a reaped account with no Checkmarx One history carries none of the keys.
    const cRec = copy(c.id);
    expect(cRec.length, "PRECONDITION: the control's record was written").toBe(1);
    const cd = JSON.parse(cRec[0].details);
    expect(cd.reason, "PRECONDITION: the control is the reaper's record").toBe("unverified_48h");
    for (const k of ["cxone_withdrawals_scheduled", "cxone_accounts_left_in_place", "cxone_accounts_unrecorded", "cxone_records_unreadable"]) {
      expect(cd, `the control carries no ${k}`).not.toHaveProperty(k);
    }
  });

  test("the alerts poll carries the number that needs a human — to a superadmin only", async () => {
    const read = async (who) => (await (await who.api.get("/api/admin/alerts")).json());
    const before = (await read(sa)).cxone_withdrawals_attention;
    expect(typeof before).toBe("number");
    plantPending({ held_reason: "address_held_by_living_account" });
    plant(goneUser());                                   // unmarked
    plantPending();                                      // retrying — needs nobody
    expect((await read(sa)).cxone_withdrawals_attention - before).toBe(2);

    const ra = await mkParticipant(sa, uniq());
    expect((await sa.api.post(`/api/admin/participants/${ra.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } })).ok()).toBeTruthy();
    const admin = await apiLogin(ra.email, PARTICIPANT_PASS);
    try {
      const b = await read(admin);
      expect(Array.isArray(b.alerts), "precondition: the regular admin reads the alerts poll").toBe(true);
      expect(b, "absent — never 0 — for anyone who cannot act on it").not.toHaveProperty("cxone_withdrawals_attention");
    } finally { await admin.api.dispose(); }
  });

  test("/metrics exposes the withdrawal families", async () => {
    const r = await sa.api.get("/metrics");
    expect(r.status()).toBe(200);
    const t = await r.text();
    expect(t).toContain("# TYPE hack_arena_cxone_withdrawals gauge");
    for (const st of ["retrying", "held", "needs_attention", "given_up", "unmarked"]) {
      expect(t).toMatch(new RegExp(`^hack_arena_cxone_withdrawals\\{state="${st}"\\} \\d+$`, "m"));
    }
    expect(t).toContain("# TYPE hack_arena_cxone_withdrawals_total counter");
    for (const k of ["withdrawn", "already_gone", "transferred", "held", "failed", "given_up"]) {
      expect(t).toMatch(new RegExp(`^hack_arena_cxone_withdrawals_total\\{result="${k}"\\} \\d+$`, "m"));
    }
    // No removal is dropped for its age, so there is no such outcome to count.
    expect(t).not.toMatch(/^hack_arena_cxone_withdrawals_total\{result="expired"\}/m);
    expect(t).toContain("# TYPE hack_arena_cxone_create_unconfirmed_total counter");
    for (const k of ["no_location", "non_201", "id_not_uuid", "post_unanswered", "ledger_write_failed"]) {
      expect(t).toMatch(new RegExp(`^hack_arena_cxone_create_unconfirmed_total\\{reason="${k}"\\} \\d+$`, "m"));
    }
  });

  // THE REMEDY a History row names once a deferred set-up has run out of retries:
  // assign them to the event again. Behaviourally the re-queue is driven through
  // the harness (tests/cxone-replacement-takeover.spec.js, "RE-ASSIGN"); here the
  // ROUTE: a re-assign of an existing member asks it — and still answers 200 and
  // enrols nobody twice — with the call placed in the already-a-member branch.
  test("re-assigning an existing member asks the deferred-set-up remedy, and the route still answers as before", async () => {
    const comp = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
      name: `${uniq()}-reassign`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240 } });
    expect(comp.ok(), await comp.text()).toBeTruthy();
    const cid = (await comp.json()).competition.id;
    const p = await mkParticipant(sa, uniq()), q = await mkParticipant(sa, uniq());
    const assign = () => sa.api.post("/api/admin/competitions/assign", { headers: H(sa.csrf), data: { userIds: [p.id, q.id], competitionIds: [cid] } });
    const first = await assign();
    expect(first.status(), await first.text()).toBe(200);
    expect((await first.json()).assigned, "precondition: both enrolled").toBe(2);
    // p's latest provisioning row for the event is an exhausted deferral; q has none.
    dbRun("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)",
      crypto.randomUUID(), p.id, "cxone_provisioned", "system", nowIso(),
      JSON.stringify({ competition_id: cid, success: false, deferred: "removal_outcome_unknown", matched_account_id: crypto.randomUUID(), retry_scheduled: false }));
    const again = await assign();
    expect(again.status(), await again.text()).toBe(200);
    expect((await again.json()).assigned, "a re-assign enrols nobody again").toBe(0);

    const src = require("./doc-registry").stripJsComments(
      require("fs").readFileSync(path.join(__dirname, "..", "routes", "participants.js"), "utf8"));
    const calls = [...src.matchAll(/\brequeueDeferredCxOneProvision\s*\(\s*user\s*,\s*comp\.id\b/g)].map(m => m.index);
    const branch = /if\s*\(\s*didInsert\s*\)\s*\{[^{}]*enqueueCxOneProvision\(\s*user\s*,\s*comp\.id\s*,\s*"assign"\s*\)\s*;\s*\}\s*else\s*\{\s*requeueDeferredCxOneProvision\(\s*user\s*,\s*comp\.id\b/;
    expect(calls, "the assign route asks the remedy exactly once").toHaveLength(1);
    expect(branch.test(src), "…in the ELSE of the new-membership enqueue — for an existing member only").toBe(true);
  });

  test("/metrics exposes the deferred set-ups: retries pending, and deferrals by reason — every reason, even at 0", async () => {
    // The shared server never provisions against a realm, so every series reads
    // 0 here; what is pinned is that each is emitted, typed and labelled, so a
    // dashboard keyed on a reason never sees it appear only on its first event.
    const t = await (await sa.api.get("/metrics")).text();
    expect(t).toMatch(/^# HELP hack_arena_cxone_provision_retries_pending \S/m);
    expect(t).toContain("# TYPE hack_arena_cxone_provision_retries_pending gauge");
    expect(t).toMatch(/^hack_arena_cxone_provision_retries_pending 0$/m);
    expect(t).toMatch(/^# HELP hack_arena_cxone_provision_deferred_total \S/m);
    expect(t).toContain("# TYPE hack_arena_cxone_provision_deferred_total counter");
    const reasons = [...t.matchAll(/^hack_arena_cxone_provision_deferred_total\{reason="([a-z_]+)"\} (\d+)$/gm)].map(m => [m[1], Number(m[2])]);
    expect(reasons).toEqual(["removal_in_flight", "removal_outcome_unknown", "recently_removed", "removal_raced_match"].map(k => [k, 0]));
  });
});
