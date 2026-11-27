// v8.12.7 — the Checkmarx One realm-account ledger (lib/cxone-ledger.js).
//
// Unit arms over an in-memory better-sqlite3 database. The module requires
// nothing at module scope and every function takes `db`, so the whole matrix
// runs here with no server, no data directory and no realm. The DDL executed
// below is the SAME string db.js executes at boot.
//
// Every "the row survived" / "nothing was written" assertion is paired with
// the positive case beside it, or it is equally satisfied by a function that
// does nothing (CLAUDE.md, Recurring rules).
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const L = require("../lib/cxone-ledger");

const ID_A = "0f8c2a1e-4b3d-4c5e-9a7f-1b2c3d4e5f60";
const ID_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const ID_C = "9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5";
const T0 = "2026-09-01T10:00:00.000Z";
const T1 = "2026-09-01T11:00:00.000Z";
const T2 = "2026-09-02T09:00:00.000Z";

function freshDb() {
  const db = new Database(":memory:");
  // Only the columns the ledger's readers touch — the two history readers, and
  // (v8.13.1) `livingBinder`, which also reads the event bindings.
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
           CREATE TABLE user_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_type TEXT NOT NULL,
             changed_by TEXT NOT NULL, changed_at TEXT NOT NULL, details TEXT);
           CREATE TABLE competition_users (competition_id TEXT NOT NULL, user_id TEXT NOT NULL, cxone_user_id TEXT,
             PRIMARY KEY (competition_id, user_id));`);
  db.exec(L.CXONE_REALM_ACCOUNTS_DDL);
  return db;
}
// The candidate rows the LIKE pre-filter hands to the JSON check, per call —
// so the escaping is observable on its own and not only through the final
// answer (which the exact-equality re-check would get right regardless).
function likeCandidates(db) {
  const seen = [];
  const prep = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = prep(sql);
    if (!/details\s+LIKE\s+\?/.test(sql)) return st;
    return { all: (...a) => { const r = st.all(...a); seen.push(r.length); return r; } };
  };
  return seen;
}
let _ev = 0;
function event(db, userId, changedAt, details, type = "cxone_provisioned") {
  db.prepare("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)")
    .run(`ev-${++_ev}`, userId, type, "system", changedAt, typeof details === "string" ? details : JSON.stringify(details));
}
const row = (db, id) => db.prepare("SELECT * FROM cxone_realm_accounts WHERE cxone_user_id=?").get(id);
const created = (db, over = {}) => L.recordCreated(db, {
  cxoneUserId: ID_A, iamOrigin: "https://iam.example", tenant: "acme", userId: "u1", competitionId: "c1",
  username: "Alice_Nick", provenanceAt: T0, instanceOrigin: "https://arena.example", claim: "claim-1", nowIso: T0,
  ...over,
});

test.describe("v8.12.7 — cxone-ledger schema", () => {
  test("the DDL creates the table and both PLAIN indexes, keyed on cxone_user_id, with no foreign key", () => {
    const db = freshDb();
    db.exec(L.CXONE_REALM_ACCOUNTS_DDL); // idempotent: a second boot must not throw
    const cols = db.prepare("PRAGMA table_info(cxone_realm_accounts)").all();
    const pk = cols.filter(c => c.pk).map(c => c.name);
    expect(pk).toEqual(["cxone_user_id"]);
    expect(db.prepare("PRAGMA foreign_key_list(cxone_realm_accounts)").all()).toEqual([]);
    const idx = db.prepare("PRAGMA index_list(cxone_realm_accounts)").all();
    const named = idx.filter(i => i.origin === "c").map(i => i.name).sort();
    expect(named).toEqual(["idx_cxone_realm_accounts_pending", "idx_cxone_realm_accounts_user"]);
    expect(idx.filter(i => i.origin === "c").every(i => i.unique === 0)).toBe(true);
    const pendingSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_cxone_realm_accounts_pending'").get().sql;
    expect(pendingSql).toMatch(/WHERE\s+pending_since\s+IS\s+NOT\s+NULL/i);
    // The CHECK admits exactly the two provenances.
    expect(() => db.prepare(`INSERT INTO cxone_realm_accounts (cxone_user_id,user_id,created_username,provenance,provenance_at,recorded_at)
      VALUES ('x','u','n','guessed',?,?)`).run(T0, T0)).toThrow(/CHECK/);
  });

  test("the module requires nothing at module scope, and db.js runs its DDL in a FATAL block", () => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const src = strip(fs.readFileSync(path.join(__dirname, "..", "lib", "cxone-ledger.js"), "utf8"));
    expect(src).not.toMatch(/\brequire\s*\(/);
    const dbSrc = strip(fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8"));
    const lines = dbSrc.split("\n").filter(l => l.includes("CXONE_REALM_ACCOUNTS_DDL"));
    expect(lines.length, "db.js must execute the ledger DDL exactly once").toBe(1);
    // Not swallowed: the statement is a bare db.exec, never inside a try on its line.
    expect(lines[0]).toMatch(/^db\.exec\(require\("\.\/lib\/cxone-ledger"\)\.CXONE_REALM_ACCOUNTS_DDL\);\s*$/);
    // …and so is the one ALTER beside it (pre-release review): every 201 names
    // the column, so a swallowed failure would lose every later record.
    // So are the columns added since (each a write names): every one a bare
    // statement, guarded by the table's own columns, never a swallowed error.
    for (const col of ["created_email_sha", "created_baseline", "held_signal"]) {
      const alter = dbSrc.split("\n").filter(l => l.includes(`ADD COLUMN ${col} `));
      expect(alter.length, `db.js adds ${col} exactly once`).toBe(1);
      expect(alter[0]).toMatch(new RegExp(String.raw`^\s*db\.prepare\("ALTER TABLE cxone_realm_accounts ADD COLUMN ${col} TEXT"\)\.run\(\);\s*$`));
      const guard = new RegExp(String.raw`^if \(!db\.prepare\("PRAGMA table_info\(cxone_realm_accounts\)"\)\.all\(\)\.some\(c => c\.name === "${col}"\)\) \{$`, "m");
      expect(guard.test(dbSrc), `${col}'s ALTER is guarded by the table's own columns`).toBe(true);
    }
  });

  // (pre-release review) — an instance that ran an earlier build of this release
  // already has the table WITHOUT the column, and CREATE TABLE IF NOT EXISTS never
  // adds one. Booted through the real db.js, twice (the second boot must not
  // re-ALTER), with a row already in it that must survive.
  test("db.js adds created_email_sha, created_baseline and held_signal to a ledger table an earlier build created without them, keeping its rows", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxone-ledger-alter-"));
    try {
      const pre = L.CXONE_REALM_ACCOUNTS_DDL.replace(/,\s*created_email_sha\s+TEXT/, "")
        .replace(/,\s*created_baseline\s+TEXT/, "").replace(/,\s*held_signal\s+TEXT/, "");
      expect(pre, "precondition: the earlier build's DDL lacks the columns").not.toMatch(/created_email_sha|created_baseline|held_signal/);
      const seed = new Database(path.join(tmp, "hackathon.db"));
      seed.exec(pre);
      seed.prepare(`INSERT INTO cxone_realm_accounts (cxone_user_id,user_id,created_username,provenance,provenance_at,recorded_at)
        VALUES (?,?,?,?,?,?)`).run(ID_A, "u1", "n", "created", T0, T0);
      seed.close();
      for (const n of [1, 2]) {
        const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
          cwd: path.join(__dirname, ".."), encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: tmp, UPLOADS_DIR: path.join(tmp, "uploads"), NODE_OPTIONS: "" },
        });
        expect(r.status, `boot ${n} of db.js must succeed: ${r.stderr}`).toBe(0);
      }
      const db = new Database(path.join(tmp, "hackathon.db"), { readonly: true });
      try {
        expect(db.prepare("PRAGMA table_info(cxone_realm_accounts)").all().map(c => c.name))
          .toEqual(expect.arrayContaining(["created_email_sha", "created_baseline", "held_signal"]));
        expect(row(db, ID_A)).toMatchObject({ user_id: "u1", created_email_sha: null, created_baseline: null, held_signal: null });
      } finally { db.close(); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

test.describe("v8.12.7 — cxone-ledger writers", () => {
  test("recordCreated: INSERT OR IGNORE answers OWNERSHIP, born claimed, and refuses a non-UUID id", () => {
    const db = freshDb();
    expect(created(db)).toBe(true);
    const r = row(db, ID_A);
    expect(r).toMatchObject({
      provenance: "created", realm_confirmed: 1, created_username: "alice_nick", user_id: "u1",
      competition_id: "c1", iam_origin: "https://iam.example", tenant: "acme", instance_origin: "https://arena.example",
      claim_token: "claim-1", claimed_at: T0, recorded_at: T0, provenance_at: T0, pending_since: null, attempts: 0,
    });
    // A second write for the same account — another job, another user — does not own it and changes nothing.
    expect(created(db, { userId: "u2", claim: "claim-2", nowIso: T1 })).toBe(false);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u1", claim_token: "claim-1" });
    // Not a UUID, or not a string: never enters the ledger.
    expect(created(db, { cxoneUserId: "kc-created" })).toBe(false);
    expect(created(db, { cxoneUserId: [ID_B] })).toBe(false);
    expect(row(db, ID_B)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM cxone_realm_accounts").get().n).toBe(1);
  });

  test("recordCreated keeps a well-formed address FINGERPRINT, and nothing that is not one", () => {
    const db = freshDb();
    const SHA = "a".repeat(64);
    expect(created(db, { createdEmailSha: SHA })).toBe(true);
    expect(row(db, ID_A).created_email_sha).toBe(SHA);
    // An address, a truncated or upper-case hash, or a non-string is stored as
    // NULL — the runner then skips that one check rather than compare garbage.
    for (const [id, bad] of [[ID_B, "erin@acme.test"], [ID_C, "A".repeat(64)]]) {
      expect(created(db, { cxoneUserId: id, claim: `c-${id}`, createdEmailSha: bad })).toBe(true);
      expect(row(db, id).created_email_sha).toBeNull();
    }
  });

  // v8.13.1 — the deletes below name the row's owner ("u1"), which every
  // caller now must; the SUBJECT of this arm is unchanged: the claim decides,
  // with the owner held fixed and right. The owner half has its own arm below.
  // The creation baseline: written by the job that created the account, under
  // its own claim and for its own participant, once. Every refusal is paired
  // with the write that lands, or a writer that does nothing passes.
  test("recordCreationBaseline is claim-bound, owner-bound and write-once, and stores only a version-1 object", () => {
    const B = JSON.stringify({ v: 1, realm: ["r1"], client: [], attrs: [], default_role: "r1" });
    const db = freshDb();
    created(db);
    expect(L.recordCreationBaseline(db, ID_A, "claim-other", { userId: "u1", baseline: B }), "another claim").toBe(0);
    expect(L.recordCreationBaseline(db, ID_A, "claim-1", { userId: "u-other", baseline: B }), "another owner").toBe(0);
    for (const bad of [null, 5, "{", "[]", JSON.stringify({ v: 2 }), JSON.stringify({ realm: [] }), JSON.stringify({ v: 1, x: "y".repeat(40000) })]) {
      expect(L.recordCreationBaseline(db, ID_A, "claim-1", { userId: "u1", baseline: bad }), String(bad).slice(0, 30)).toBe(0);
    }
    expect(row(db, ID_A).created_baseline, "nothing written yet").toBeNull();
    expect(() => L.recordCreationBaseline(db, ID_A, "claim-1", { baseline: B }), "the owner is required").toThrow(/owner/);
    expect(L.recordCreationBaseline(db, ID_A, "claim-1", { userId: "u1", baseline: B })).toBe(1);
    expect(row(db, ID_A).created_baseline).toBe(B);
    const B2 = JSON.stringify({ v: 1, realm: ["r2"], client: [], attrs: [], default_role: "r2" });
    expect(L.recordCreationBaseline(db, ID_A, "claim-1", { userId: "u1", baseline: B2 }), "written once").toBe(0);
    expect(row(db, ID_A).created_baseline).toBe(B);
    // A row a living participant took over (the claim ended) is never written.
    const db2 = freshDb();
    db2.prepare("INSERT INTO users (id) VALUES ('u-living')").run();
    created(db2);
    expect(L.transferTo(db2, ID_A, "u-living", T1)).toBe(1);
    expect(L.recordCreationBaseline(db2, ID_A, "claim-1", { userId: "u1", baseline: B })).toBe(0);
    expect(L.recordCreationBaseline(db2, ID_A, "claim-1", { userId: "u-living", baseline: B }), "nor under the new owner's id").toBe(0);
    expect(row(db2, ID_A).created_baseline).toBeNull();
  });

  test("releaseClaim and deleteOwned are compare-and-swaps on the claim", () => {
    const db = freshDb();
    created(db);
    expect(L.releaseClaim(db, ID_A, "someone-else")).toBe(0);
    expect(L.deleteOwned(db, ID_A, "someone-else", "u1")).toBe(0);
    expect(row(db, ID_A).claim_token).toBe("claim-1");
    expect(L.releaseClaim(db, ID_A, "claim-1")).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ claim_token: null, claimed_at: null });
    // Released: the old holder cannot delete it any more.
    expect(L.deleteOwned(db, ID_A, "claim-1", "u1")).toBe(0);
    expect(row(db, ID_A)).toBeTruthy();
    created(db, { cxoneUserId: ID_B, claim: "claim-b" });
    expect(L.deleteOwned(db, ID_B, "claim-b", "u1")).toBe(1);
    expect(row(db, ID_B)).toBeUndefined();
  });

  test("markInFlightRefusal stamps once, counts every attempt, and never rewrites a cascade stamp", () => {
    const db = freshDb();
    created(db);
    const as = (o) => ({ ...o, userId: "u1" });   // the row's own owner — v8.13.1, required
    expect(L.markInFlightRefusal(db, ID_A, "wrong", as({ nowIso: T0, nextIso: T1, lastError: "403/delete_refused" }))).toBe(0);
    expect(row(db, ID_A).pending_since).toBeNull();
    expect(L.markInFlightRefusal(db, ID_A, "claim-1", as({ nowIso: T0, nextIso: T1, lastError: "403/delete_refused" }))).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ pending_since: T0, deletion_source: "in_flight", attempts: 1,
      first_failed_at: T0, next_attempt_at: T1, last_error: "403/delete_refused" });
    L.markInFlightRefusal(db, ID_A, "claim-1", as({ nowIso: T1, nextIso: T2, lastError: "500/delete_refused" }));
    expect(row(db, ID_A)).toMatchObject({ pending_since: T0, deletion_source: "in_flight", attempts: 2,
      first_failed_at: T0, next_attempt_at: T2, last_error: "500/delete_refused" });
    // A cascade that stamped first stays the recorded source.
    created(db, { cxoneUserId: ID_B, claim: "claim-b" });
    L.stampDeletionForUser(db, "u1", T0, "cascade");
    L.markInFlightRefusal(db, ID_B, "claim-b", as({ nowIso: T1, nextIso: T2, lastError: "403/delete_refused" }));
    expect(row(db, ID_B)).toMatchObject({ pending_since: T0, deletion_source: "cascade", attempts: 1 });
  });

  // v8.13.1 (external audit) — A CLAIM SAYS WHICH RUN MAY ACT, NEVER ON WHOSE
  // BEHALF. The auditor's reproduction: a provisioning job created an account,
  // its participant was erased, a replacement's own job matched the account
  // (`transferTo`) — and the first job, still holding its claim, deleted the row
  // the living replacement now owned. So both writes are bound to the owner the
  // caller is acting for, beside the claim. Each refusal below is made with the
  // RIGHT claim, so only the owner can be what refuses it; the control beside it
  // is the same call with the right owner, or "refused" is satisfied by a write
  // that refuses everything.
  test("deleteOwned and markInFlightRefusal refuse a row whose OWNER is not the caller's, even under the right claim", () => {
    const db = freshDb();
    created(db);
    // A stranger's owner id, with the row's own claim.
    expect(L.deleteOwned(db, ID_A, "claim-1", "u-replacement")).toBe(0);
    expect(row(db, ID_A), "the row survives a delete made for somebody else").toMatchObject({ user_id: "u1", claim_token: "claim-1" });
    expect(L.markInFlightRefusal(db, ID_A, "claim-1",
      { nowIso: T0, nextIso: T1, lastError: "403/delete_refused", userId: "u-replacement" })).toBe(0);
    expect(row(db, ID_A), "nor is it stamped pending for somebody else").toMatchObject({
      pending_since: null, deletion_source: null, attempts: 0, last_error: null });
    // CONTROL: the right owner, the same claim — both act.
    expect(L.markInFlightRefusal(db, ID_A, "claim-1",
      { nowIso: T0, nextIso: T1, lastError: "403/delete_refused", userId: "u1" })).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ pending_since: T0, attempts: 1 });
    expect(L.deleteOwned(db, ID_A, "claim-1", "u1")).toBe(1);
    expect(row(db, ID_A)).toBeUndefined();
  });

  // The owner is REQUIRED: a caller that does not say whose row it means gets an
  // error, never a match — an omitted argument binding as `user_id = NULL` would
  // quietly match nothing today, and a future "optional" reading would quietly
  // match everything.
  test("deleteOwned and markInFlightRefusal THROW without an owner, and write nothing", () => {
    const db = freshDb();
    created(db);
    for (const bad of [undefined, null, "", 42, ["u1"]]) {
      expect(() => L.deleteOwned(db, ID_A, "claim-1", bad), `deleteOwned with owner ${JSON.stringify(bad)}`).toThrow(TypeError);
      expect(() => L.markInFlightRefusal(db, ID_A, "claim-1",
        { nowIso: T0, nextIso: T1, lastError: "403/delete_refused", userId: bad }), `markInFlightRefusal with owner ${JSON.stringify(bad)}`)
        .toThrow(TypeError);
    }
    // The pre-v8.13.1 call shapes — no owner at all.
    expect(() => L.deleteOwned(db, ID_A, "claim-1")).toThrow(/owner's user id is required/);
    expect(() => L.markInFlightRefusal(db, ID_A, "claim-1", { nowIso: T0, nextIso: T1, lastError: "x" }))
      .toThrow(/owner's user id is required/);
    expect(row(db, ID_A), "nothing was written by a refused call").toMatchObject({
      user_id: "u1", claim_token: "claim-1", pending_since: null, attempts: 0 });
  });

  test("stampDeletionForUser stamps every row of THAT user, COALESCE-ing the first answer", () => {
    const db = freshDb();
    created(db);
    created(db, { cxoneUserId: ID_B, claim: "b" });
    created(db, { cxoneUserId: ID_C, userId: "u2", claim: "c" });
    expect(L.stampDeletionForUser(db, "u1", T0, "cascade")).toBe(2);
    expect(row(db, ID_A)).toMatchObject({ pending_since: T0, deletion_source: "cascade" });
    expect(row(db, ID_B)).toMatchObject({ pending_since: T0, deletion_source: "cascade" });
    expect(row(db, ID_C)).toMatchObject({ pending_since: null, deletion_source: null });
    L.stampDeletionForUser(db, "u1", T2, "superadmin");
    expect(row(db, ID_A)).toMatchObject({ pending_since: T0, deletion_source: "cascade" });
    expect(L.stampDeletionForUser(db, "nobody", T0, "cascade")).toBe(0);
  });

  test("transferTo re-keys the row to the living holder and forgets the whole withdrawal, claim or no claim", () => {
    const db = freshDb();
    db.prepare("INSERT INTO users (id) VALUES ('u-living')").run();
    created(db);
    L.markInFlightRefusal(db, ID_A, "claim-1", { nowIso: T0, nextIso: T1, lastError: "403/delete_refused", userId: "u1" });
    db.prepare(`UPDATE cxone_realm_accounts SET held_reason='adopted_by_tenant', held_signal='role_mapping', attention=1, given_up_at=?,
      override_reason='x', override_by='sa', override_at=? WHERE cxone_user_id=?`).run(T1, T1, ID_A);
    // The transfer is applied UNDER somebody else's claim — a claim never stops it.
    expect(row(db, ID_A).claim_token, "precondition: a run holds the row").toBe("claim-1");
    expect(L.transferTo(db, ID_A, "u-living", T2)).toBe(1);
    expect(row(db, ID_A)).toMatchObject({
      user_id: "u-living", pending_since: null, deletion_source: null, attempts: 0, first_failed_at: null,
      next_attempt_at: null, last_error: null, held_reason: null, held_signal: null, given_up_at: null, attention: 0,
      override_reason: null, override_by: null, override_at: null, transferred_at: T2,
      // Provenance is untouched. The claim is NOT — v8.13.1 RE-POINTED this line,
      // which used to assert the claim survived "because the runner re-checks
      // user_id". The runner does; the provisioning job that created the account
      // has no re-check after its last await, and it deleted the transferred row
      // under the claim it still held (the external audit's reproduction). A
      // claim is a licence to act for the participant who was deleted, and the
      // account is no longer theirs — its own arm is below.
      provenance: "created", created_username: "alice_nick", claim_token: null, claimed_at: null,
    });
    // The deleted user no longer owns anything the cascade could stamp.
    expect(L.stampDeletionForUser(db, "u1", T2, "cascade")).toBe(0);
    expect(L.transferTo(db, "not-in-ledger", "u-living", T2)).toBe(0);
  });

  // v8.13.1 (external audit) — THE TRANSFER ENDS EVERY CLAIM, so the run that
  // held one before it cannot act on the row afterwards — under the OLD owner's
  // id (the job resuming for the participant it was started for) or the NEW one.
  // Asserted with the owner-binding of `deleteOwned` deliberately unable to save
  // it: the delete made for the NEW owner passes that binding, so only the ended
  // claim is what refuses it. Either half alone closes the auditor's reproduction
  // (see deleteOwned's comment); this arm and the one above lock each half.
  test("transferTo ENDS the claim a run held — the old claim then releases, deletes and stamps nothing", () => {
    const db = freshDb();
    db.prepare("INSERT INTO users (id) VALUES ('u-living')").run();
    created(db);
    expect(row(db, ID_A)).toMatchObject({ claim_token: "claim-1", claimed_at: T0 });
    expect(L.transferTo(db, ID_A, "u-living", T2)).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u-living", claim_token: null, claimed_at: null });
    expect(L.deleteOwned(db, ID_A, "claim-1", "u1"), "the old run, for the erased owner").toBe(0);
    expect(L.deleteOwned(db, ID_A, "claim-1", "u-living"), "the old claim, even naming the NEW owner").toBe(0);
    expect(L.markInFlightRefusal(db, ID_A, "claim-1",
      { nowIso: T2, nextIso: T2, lastError: "403/delete_refused", userId: "u-living" })).toBe(0);
    expect(L.releaseClaim(db, ID_A, "claim-1"), "nothing left to release").toBe(0);
    expect(row(db, ID_A), "the living owner's row is intact").toMatchObject({
      user_id: "u-living", pending_since: null, attempts: 0, transferred_at: T2 });
    // CONTROL: a run that claims the row AFTER the transfer, for its new owner,
    // can act on it — the claim mechanism itself still works.
    db.prepare("UPDATE cxone_realm_accounts SET claim_token='claim-2', claimed_at=? WHERE cxone_user_id=?").run(T2, ID_A);
    expect(L.deleteOwned(db, ID_A, "claim-2", "u-living")).toBe(1);
    expect(row(db, ID_A)).toBeUndefined();
  });

  test("transferTo to the row's OWN user is a no-op — no transferred_at for a hand-over that never happened", () => {
    const db = freshDb();
    for (const u of ["u1", "u-living"]) db.prepare("INSERT INTO users (id) VALUES (?)").run(u);
    created(db);
    // The provisioning path calls transferTo on every accepted match, including a
    // participant's own account met again on a second event.
    expect(L.transferTo(db, ID_A, "u1", T2)).toBe(0);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u1", transferred_at: null });
    // Control: the same call for a DIFFERENT living user does transfer.
    expect(L.transferTo(db, ID_A, "u-living", T2)).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u-living", transferred_at: T2 });
  });

  test("transferTo to a user who no longer EXISTS changes nothing — the pending stamp survives (pre-release review)", () => {
    const db = freshDb();
    created(db);
    L.stampDeletionForUser(db, "u1", T0, "cascade");
    // "u-erased" was erased during the caller's await: no users row.
    expect(L.transferTo(db, ID_A, "u-erased", T2)).toBe(0);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u1", pending_since: T0, deletion_source: "cascade", transferred_at: null });
    // Control: the moment that user exists, the same call transfers.
    db.prepare("INSERT INTO users (id) VALUES ('u-erased')").run();
    expect(L.transferTo(db, ID_A, "u-erased", T2)).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u-erased", pending_since: null, transferred_at: T2 });
  });
});

test.describe("v8.14 — a row whose account the realm says is gone", () => {
  // `forgetGoneAccount` serves lib/cxone.js `accountGoneFromRealm`: the realm
  // answered that the account is gone after its row had passed to a living
  // participant. Bound to the owner the caller read, like the deletes beside it.
  test("forgetGoneAccount deletes ONLY the row of the owner it names, and throws without one", () => {
    const db = freshDb();
    created(db);
    created(db, { cxoneUserId: ID_B, userId: "u2", claim: null });
    for (const bad of [undefined, null, "", 42]) {
      expect(() => L.forgetGoneAccount(db, ID_A, bad), `owner ${JSON.stringify(bad)}`).toThrow(TypeError);
    }
    expect(row(db, ID_A), "a refused call wrote nothing").toBeTruthy();
    expect(L.forgetGoneAccount(db, ID_A, "u2"), "a row owned by somebody else is left alone").toBe(0);
    expect(row(db, ID_A)).toBeTruthy();
    expect(L.forgetGoneAccount(db, ID_A, "u1")).toBe(1);
    expect(row(db, ID_A)).toBeUndefined();
    expect(row(db, ID_B), "CONTROL — another account's row is untouched").toBeTruthy();
  });

  test("accountsOutsideLedger does not count an account a LATER cxone_binding_cleared says the platform removed", () => {
    const db = freshDb();
    const ok = (id, extra = {}) => ({ success: true, already_existed: true, matched_by: "email", cxone_user_id: id, username: `n-${id}`, ...extra });
    const cleared = (id) => ({ competition_id: "c1", cleared_cxone_user_id: id, reason: "realm_account_removed", reprovision: true });
    event(db, "u1", T0, ok("kc-removed"));
    event(db, "u1", T1, cleared("kc-removed"), "cxone_binding_cleared");
    event(db, "u1", T0, ok("kc-kept"));
    // A clearing that comes BEFORE the row binding the id does not hide it (a
    // later binding is a new fact) — the control that the order is read.
    event(db, "u2", T0, cleared("kc-later"), "cxone_binding_cleared");
    event(db, "u2", T1, ok("kc-later"));
    // A deferral names the account it did NOT link, and never counts.
    event(db, "u3", T0, { competition_id: "c1", success: false, deferred: "removal_in_flight", matched_account_id: "kc-d" });
    expect(L.accountsOutsideLedger(db, "u1"), "only the account still in the tenant").toEqual({ leftInPlace: 1, unrecorded: 0, unreadable: 0 });
    expect(L.accountsOutsideLedger(db, "u2")).toEqual({ leftInPlace: 1, unrecorded: 0, unreadable: 0 });
    expect(L.accountsOutsideLedger(db, "u3")).toEqual({ leftInPlace: 0, unrecorded: 0, unreadable: 0 });
  });
});

test.describe("v8.12.7 — cxone-ledger history readers", () => {
  test("accountsOutsideLedger splits what a deletion leaves: MATCHED accounts (left in place) apart from ones we CREATED and never recorded", () => {
    const db = freshDb();
    created(db); // ID_A is in the ledger
    const ID_D = "4d3c2b1a-0f9e-4d8c-b7a6-958473625140", ID_E = "5e4d3c2b-1a0f-4e9d-a8c7-b6a594837261";
    // Scheduled, not left: a created account the ledger holds — twice.
    event(db, "u1", T0, { success: true, already_existed: false, cxone_user_id: ID_A, username: "n" });
    event(db, "u1", T1, { success: true, already_existed: true, cxone_user_id: ID_A, username: "n", matched_by: "email" });
    // LEFT IN PLACE: a 409-matched account (twice — once), and one from before
    // matched_by existed (already_existed alone decides).
    event(db, "u1", T0, { success: true, already_existed: true, cxone_user_id: ID_B, username: "n", matched_by: "email" });
    event(db, "u1", T1, { success: true, already_existed: true, cxone_user_id: ID_B, username: "n", matched_by: "email" });
    event(db, "u1", T1, { success: true, already_existed: true, username: "Legacy" });
    event(db, "u1", T2, { success: true, already_existed: true, username: "LEGACY" });
    // UNRECORDED: created by our own POST, and the ledger does not hold it —
    // with an id (a pre-v8.12.7 job), without one (before v8.8.15), and a 201
    // with no Location found again by search (matched_by, yet created by us).
    event(db, "u1", T0, { success: true, already_existed: false, cxone_user_id: ID_C, username: "c" });
    event(db, "u1", T0, { success: true, already_existed: false, username: "Old" });
    event(db, "u1", T0, { success: true, already_existed: false, cxone_user_id: ID_D, username: "d", matched_by: "username" });
    // ONE account, two rows: created before any id was recorded, met again by id
    // (a 409) on a later event — counted once, as CREATED.
    event(db, "u1", T0, { success: true, already_existed: false, username: "Both" });
    event(db, "u1", T2, { success: true, already_existed: true, cxone_user_id: ID_E, username: "both", matched_by: "email" });
    // Not bindings at all.
    event(db, "u1", T2, { success: false, error: "boom" });
    event(db, "u1", T2, { success: true, cxone_user_id: ID_C }, "email_sent");
    // A set-up record that cannot be read: counted apart, as a record.
    event(db, "u1", T2, "{not json");
    event(db, "u2", T2, { success: true, already_existed: true, cxone_user_id: ID_C, username: "x" });
    event(db, "u3", T2, { success: true, already_existed: false, cxone_user_id: ID_C, username: "x" });
    expect(L.accountsOutsideLedger(db, "u1")).toEqual({ leftInPlace: 2, unrecorded: 4, unreadable: 1 });
    expect(L.accountsOutsideLedger(db, "u2")).toEqual({ leftInPlace: 1, unrecorded: 0, unreadable: 0 });
    expect(L.accountsOutsideLedger(db, "u3")).toEqual({ leftInPlace: 0, unrecorded: 1, unreadable: 0 });
    expect(L.accountsOutsideLedger(db, "nobody")).toEqual({ leftInPlace: 0, unrecorded: 0, unreadable: 0 });
  });

  test("accountsOutsideLedger counts a set-up record it cannot read, per record, and never lets a damaged clearing hide an account", () => {
    const db = freshDb();
    // u1: seven unreadable `cxone_provisioned` shapes …
    event(db, "u1", T0, `{"success":true,"already_existed":false,"cxone_user_id":"${ID_A}"`); // torn object
    event(db, "u1", T0, [1, 2]);
    event(db, "u1", T0, '"str"'); // JSON, but a string
    event(db, "u1", T0, "null"); // the TEXT "null": JSON null
    event(db, "u1", T0, "");
    db.prepare("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,NULL)")
      .run("ev-sql-null", "u1", "cxone_provisioned", "system", T0);
    expect(db.prepare("SELECT details IS NULL AS n FROM user_events WHERE id='ev-sql-null'").get().n,
      "PRECONDITION — the SQL NULL row is stored as NULL, not as text").toBe(1);
    event(db, "u1", T0, { success: "true", already_existed: false, cxone_user_id: ID_B, username: "s" }); // success not a boolean
    // … and the readable controls: one created and not in the ledger, one
    // matched, one failed set-up and one deferral (neither counted at all).
    event(db, "u1", T1, { success: true, already_existed: false, cxone_user_id: ID_C, username: "c" });
    event(db, "u1", T1, { success: true, already_existed: true, cxone_user_id: "kc-m", username: "m", matched_by: "email" });
    event(db, "u1", T1, { success: false, error: "boom" });
    event(db, "u1", T1, { competition_id: "c1", success: false, deferred: "removal_in_flight", matched_account_id: "kc-d" });
    // Unreadable rows of other types: a clearing is ignored, an email is not read.
    event(db, "u1", T2, "{torn clearing", "cxone_binding_cleared");
    event(db, "u1", T2, "{torn mail", "email_sent");
    expect(L.accountsOutsideLedger(db, "u1")).toEqual({ leftInPlace: 1, unrecorded: 1, unreadable: 7 });
    // u2: a damaged clearing after a readable created record subtracts nothing.
    event(db, "u2", T0, { success: true, already_existed: false, cxone_user_id: ID_A, username: "x" });
    event(db, "u2", T1, `{"cleared_cxone_user_id":"${ID_A}"`, "cxone_binding_cleared");
    expect(L.accountsOutsideLedger(db, "u2"), "a damaged clearing neither subtracts nor counts").toEqual({ leftInPlace: 0, unrecorded: 1, unreadable: 0 });
    // u3: readable rows only.
    event(db, "u3", T0, { success: true, already_existed: true, cxone_user_id: "kc-3", username: "y", matched_by: "email" });
    expect(L.accountsOutsideLedger(db, "u3")).toEqual({ leftInPlace: 1, unrecorded: 0, unreadable: 0 });
    expect(L.accountsOutsideLedger(db, "nobody")).toEqual({ leftInPlace: 0, unrecorded: 0, unreadable: 0 });
  });

  test("backfillFromHistory accepts only an id that came off our own 201, for a living user, idempotently", () => {
    const db = freshDb();
    for (const u of ["u1", "u2", "u3"]) db.prepare("INSERT INTO users (id) VALUES (?)").run(u);
    const ok = { success: true, already_existed: false, competition_id: "c1", username: "Bob_N" };
    event(db, "u1", T1, { ...ok, cxone_user_id: ID_A });
    event(db, "u1", T2, { ...ok, cxone_user_id: ID_A, competition_id: "c2" }); // later duplicate: earliest wins
    // Each exclusion, one per row — every one would otherwise qualify.
    const excluded = [
      { ...ok, cxone_user_id: "11111111-1111-4111-8111-111111111111", matched_by: "email" },
      { ...ok, cxone_user_id: "22222222-2222-4222-8222-222222222222", matched_by: null }, // key presence, not value
      { ...ok, cxone_user_id: "33333333-3333-4333-8333-333333333333", already_existed: true },
      { success: true, competition_id: "c1", username: "x", cxone_user_id: "44444444-4444-4444-8444-444444444444" },
      { ...ok, cxone_user_id: "55555555-5555-4555-8555-555555555555", success: false },
      { ...ok }, // no id (a pre-v8.8.15 row)
      { ...ok, cxone_user_id: "kc-created" },
      { ...ok, cxone_user_id: ["66666666-6666-4666-8666-666666666666"] },
    ];
    for (const d of excluded) event(db, "u2", T1, d);
    event(db, "u2", T1, "{not json");
    event(db, "u2", T1, { ...ok, cxone_user_id: "77777777-7777-4777-8777-777777777777" }, "email_sent");
    // A deleted user's surviving event is not a deletion record, so it is not backfilled.
    event(db, "gone", T1, { ...ok, cxone_user_id: "88888888-8888-4888-8888-888888888888" });
    // An account already recorded as 'created' is never downgraded.
    created(db, { cxoneUserId: ID_B, userId: "u3" });
    event(db, "u3", T1, { ...ok, cxone_user_id: ID_B });

    const first = L.backfillFromHistory(db, { nowIso: T2 });
    expect(first.inserted).toBe(1);
    expect(first.scanned).toBe(2 + excluded.length + 1 + 1); // living users' cxone_provisioned rows only
    expect(db.prepare("SELECT cxone_user_id FROM cxone_realm_accounts ORDER BY cxone_user_id").all().map(r => r.cxone_user_id))
      .toEqual([ID_A, ID_B].sort());
    expect(row(db, ID_A)).toMatchObject({
      provenance: "history", realm_confirmed: 0, iam_origin: null, tenant: null, instance_origin: null,
      user_id: "u1", competition_id: "c1", created_username: "bob_n", provenance_at: T1, recorded_at: T2,
      pending_since: null, claim_token: null,
    });
    expect(row(db, ID_B)).toMatchObject({ provenance: "created", realm_confirmed: 1, user_id: "u3" });

    const second = L.backfillFromHistory(db, { nowIso: "2026-09-03T00:00:00.000Z" });
    expect(second).toEqual({ scanned: first.scanned, inserted: 0 });
    expect(row(db, ID_A).recorded_at).toBe(T2);
  });
});

// v8.13.1 (external audit) — `livingBinder` moved here from the withdrawal
// runner so the provisioning job's own in-flight withdrawal asks the SAME
// question before it removes anything: is a LIVING participant bound to this
// realm account locally? Two sources, both read: an event binding
// (`competition_users.cxone_user_id`), and that participant's own
// `cxone_provisioned` history naming the id. Each "found" is paired with the
// control that the same evidence for somebody who no longer exists finds
// nothing, or a reader that answers for anyone passes it.
test.describe("v8.13.1 — cxone-ledger livingBinder", () => {
  const bind = (db, userId, cxoneUserId, comp = "c1") =>
    db.prepare("INSERT INTO competition_users (competition_id,user_id,cxone_user_id) VALUES (?,?,?)").run(comp, userId, cxoneUserId);
  const person = (db, id) => db.prepare("INSERT INTO users (id) VALUES (?)").run(id);

  test("a LIVING participant's event binding names them — answered without the history scan", () => {
    const db = freshDb();
    person(db, "u-living");
    bind(db, "u-living", ID_A);
    const scans = likeCandidates(db);
    expect(L.livingBinder(db, ID_A)).toBe("u-living");
    expect(scans, "a binding is enough; the user_events walk is not run").toEqual([]);
    // CONTROLS: another account's id, and nothing at all.
    expect(L.livingBinder(db, ID_B)).toBeNull();
    expect(L.livingBinder(freshDb(), ID_A)).toBeNull();
  });

  test("a LIVING participant's own provisioning history naming the id names them, with no binding", () => {
    const db = freshDb();
    person(db, "u-hist");
    event(db, "u-hist", T0, { success: true, already_existed: true, cxone_user_id: ID_A, username: "h", matched_by: "email" });
    expect(L.livingBinder(db, ID_A)).toBe("u-hist");
    // Only a `cxone_provisioned` row is a binding: the same id in any other
    // event type says nothing about who holds the account.
    const other = freshDb();
    person(other, "u-mail");
    event(other, "u-mail", T0, { cxone_user_id: ID_A }, "email_sent");
    expect(L.livingBinder(other, ID_A)).toBeNull();
  });

  test("a DELETED participant's binding or history binds nobody — and the same evidence for a living one does", () => {
    const db = freshDb();
    // No users row for "u-gone": an event binding and a history row survive
    // only by a hand edit or a partial restore, and neither is a living claim.
    bind(db, "u-gone", ID_A);
    event(db, "u-gone", T0, { success: true, already_existed: false, cxone_user_id: ID_A, username: "g" });
    expect(L.livingBinder(db, ID_A)).toBeNull();
    // CONTROL: the person exists again — both kinds of evidence now count.
    person(db, "u-gone");
    expect(L.livingBinder(db, ID_A)).toBe("u-gone");
    db.prepare("DELETE FROM competition_users").run();
    expect(L.livingBinder(db, ID_A), "…through the history alone, too").toBe("u-gone");
  });

  test("a NEAR-MISS id is not a binding — LIKE wildcards are escaped, and only an exact top-level id counts", () => {
    // A realm id is a UUID when the ledger records it, but the provisioning
    // job asks about the id off its own 201's Location, which is any path
    // segment — so `_` and `%` can reach this reader, and both are LIKE
    // wildcards.
    const db = freshDb();
    for (const u of ["u-x", "u-y", "u-z"]) person(db, u);
    const NEAR = "kc_1%";
    // "kcX1abc" matches the UNESCAPED pattern `kc_1%` — a different account.
    event(db, "u-x", T0, { success: true, already_existed: true, cxone_user_id: "kcX1abc", username: "x" });
    // The exact id, but not as the binding's own id: nested under another key.
    event(db, "u-y", T0, { success: true, previous: { cxone_user_id: NEAR }, cxone_user_id: ID_B, username: "y" });
    const scans = likeCandidates(db);
    expect(L.livingBinder(db, NEAR)).toBeNull();
    // The unescaped wildcard would have handed u-x's row to the JSON check; the
    // escaped pattern hands it only the row that really contains the literal id.
    expect(scans, "the LIKE pre-filter saw only the literal id").toEqual([1]);
    // CONTROL: the exact id as a binding's own id is found.
    event(db, "u-z", T1, { success: true, already_existed: false, cxone_user_id: NEAR, username: "z" });
    expect(L.livingBinder(db, NEAR)).toBe("u-z");
    // Not a string, or empty: never a scan, never an answer.
    for (const bad of [undefined, null, "", 42]) expect(L.livingBinder(db, bad)).toBeNull();
  });
});

// A living participant's provisioning record that NAMES the account (its text
// matches the LIKE pre-filter) but cannot be read — not JSON, or JSON that is
// not an object — used to be counted in a variable nothing read and treated as
// naming nobody, so the runner went on to remove an account that record may tie
// to a living participant. It is now its own answer, BINDING_UNREADABLE: the
// runner holds the account (`binding_unreadable`) and the job's in-flight
// withdrawal skips (behaviour: tests/cxone-binding-unreadable.spec.js). Each
// "unreadable" is paired with the control that a readable record, or the same
// text for somebody gone, answers as before.
test.describe("cxone-ledger livingBinder — a record that cannot be read is not 'nobody'", () => {
  const person = (db, id) => db.prepare("INSERT INTO users (id) VALUES (?)").run(id);
  // A record cut off mid-value: its text still names the account the way a
  // provisioning row does, so the LIKE pre-filter hands it to the JSON read.
  const truncated = (id) => `{"success":true,"already_existed":false,"cxone_user_id":"${id}","username":"tr`;

  test("a living participant's record that names the account but is not JSON → BINDING_UNREADABLE; the same text for somebody gone, or naming another account, → null", () => {
    const db = freshDb();
    person(db, "u-live");
    event(db, "u-live", T0, truncated(ID_A));
    expect(() => JSON.parse(truncated(ID_A)), "precondition: the planted record really is unreadable").toThrow(SyntaxError);
    expect(L.livingBinder(db, ID_A)).toBe(L.BINDING_UNREADABLE);
    // It is never an id: a Symbol, which no caller can hand an account to.
    expect(typeof L.BINDING_UNREADABLE).toBe("symbol");
    // CONTROLS: the same record for a participant who no longer exists binds
    // nobody (only a LIVING participant's record can), and a damaged record
    // naming ANOTHER account says nothing about this one.
    const gone = freshDb();
    event(gone, "u-gone", T0, truncated(ID_A));
    expect(L.livingBinder(gone, ID_A)).toBeNull();
    const other = freshDb();
    person(other, "u-live");
    event(other, "u-live", T0, truncated(ID_B));
    expect(L.livingBinder(other, ID_A)).toBeNull();
    expect(L.livingBinder(other, ID_B), "…and it is unreadable for the account it does name").toBe(L.BINDING_UNREADABLE);
  });

  test("JSON that is not an object — the record wrapped in an array — is unreadable too; a readable object naming the id only NESTED still binds nobody", () => {
    const db = freshDb();
    person(db, "u-arr");
    event(db, "u-arr", T0, JSON.stringify([{ success: true, cxone_user_id: ID_A }]));
    expect(L.livingBinder(db, ID_A)).toBe(L.BINDING_UNREADABLE);
    // CONTROL: a readable record whose own top-level id is another account, with
    // this one only nested under another key, is read — and binds nobody here.
    const nested = freshDb();
    person(nested, "u-n");
    event(nested, "u-n", T0, { success: true, previous: { cxone_user_id: ID_A }, cxone_user_id: ID_B, username: "n" });
    expect(L.livingBinder(nested, ID_A)).toBeNull();
    expect(L.livingBinder(nested, ID_B)).toBe("u-n");
  });

  test("a READABLE record naming the account wins over an unreadable one, in either order — and an event binding answers without reading history at all", () => {
    for (const order of ["unreadable first", "readable first"]) {
      const db = freshDb();
      person(db, "u-bad"); person(db, "u-good");
      const plantBad = () => event(db, "u-bad", T0, truncated(ID_A));
      const plantGood = () => event(db, "u-good", T1, { success: true, already_existed: true, cxone_user_id: ID_A, username: "g", matched_by: "email" });
      if (order === "unreadable first") { plantBad(); plantGood(); } else { plantGood(); plantBad(); }
      expect(L.livingBinder(db, ID_A), order).toBe("u-good");
    }
    const db = freshDb();
    person(db, "u-bad"); person(db, "u-bound");
    event(db, "u-bad", T0, truncated(ID_A));
    db.prepare("INSERT INTO competition_users (competition_id,user_id,cxone_user_id) VALUES (?,?,?)").run("c1", "u-bound", ID_A);
    const scans = likeCandidates(db);
    expect(L.livingBinder(db, ID_A), "a living event binding is the answer").toBe("u-bound");
    expect(scans, "the binding answers; the user_events walk is not run, though an unreadable record names the account").toEqual([]);
    // CONTROL: the walk is observed on this database: with the binding gone it
    // runs, hands the JSON read the one record naming the account, and that
    // record is the unreadable one the binding was answered ahead of.
    db.prepare("DELETE FROM competition_users").run();
    expect(L.livingBinder(db, ID_A), "without the binding, the unreadable record decides").toBe(L.BINDING_UNREADABLE);
    expect(scans, "…read by the walk, once").toEqual([1]);
  });

  test("the answer cannot be mistaken for an id: handing the account to it throws, and it cannot be spelled into a string", () => {
    const db = freshDb();
    person(db, "u-1");
    created(db, { userId: "u-1" });
    // A caller that took the answer for a binder and handed the account over
    // fails loudly, and the row is untouched.
    expect(() => L.transferTo(db, ID_A, L.BINDING_UNREADABLE, T1)).toThrow(TypeError);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u-1", transferred_at: null });
    expect(() => `${L.BINDING_UNREADABLE}`).toThrow(TypeError);
    // CONTROL: a real living id is handed the row.
    person(db, "u-2");
    expect(L.transferTo(db, ID_A, "u-2", T1)).toBe(1);
    expect(row(db, ID_A)).toMatchObject({ user_id: "u-2", transferred_at: T1 });
  });
});
