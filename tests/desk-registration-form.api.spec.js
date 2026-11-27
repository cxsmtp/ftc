// @ts-check
// v8.12.8 — A DESK ACCOUNT READS ITS EVENT'S LIVE SIGN-UP FORM, AND IS NEVER ASKED
// FOR A PASSWORD.
//
// Operator ruling (28 Sep 2026): an account created with the at-desk invite
// shortcut (`POST /api/admin/participants/desk-invite`) is linked to its event's
// sign-up form through `users.registration_competition_id`, exactly like the
// walk-up who scanned the QR two metres away — so a field the organiser LATER makes
// mandatory is demanded of it too. The one exception: a desk account signs in with
// a code by design, and is never asked for a password.
//
// Before this release the desk stamped only the event's KIND (`profile_policy`), so
// its accounts answered with the kind's DEFAULT form whatever the organiser had
// configured — the two doors at one stand drifted apart the moment the form moved.
//
// WHAT EACH HEADLINE ASSERTION HAS A WRONG BUILD FOR, and the control that stops it:
//   * "the desk account is now asked for Phone" is equally true of a build that asks
//     everybody for everything — so the missing set is asserted EXACTLY, and an
//     UNRELATED event's change is made first and must move nothing.
//   * "the desk account is not asked for a password" is equally true of a build that
//     stopped demanding passwords from anybody — so a QR walk-up on the SAME event,
//     equally passwordless, must BE asked; and on a Competition (whose form always
//     requires one) the same row read as a non-desk account must be asked too.
//     It is ALSO true of a build that never wrote the desk account's pointer (only
//     a resolvable event demands a password) — so that pointer is a precondition,
//     and the event's form moves a non-password field the kind fallback would hide.
//   * "a deleted event is visible at once" is equally true of a build whose DELETE
//     busts nothing, because End Now already cleared every member's cache — so the
//     cache is warmed again after End Now and the window is timed.
//   * "a desk account with no event is unchanged" is the control that the pointer is
//     written only when an event was named.
//   * the backfill is driven against the real db.js in a throwaway DATA_DIR across
//     several boots, because the shared test server is always a FIRST boot.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `dkrf${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A live event of `kind` with its join link on. `extra` seeds the create body. */
async function liveEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(),
      ...(kind === "program" ? { deadline_at: new Date(Date.now() + 86400e3).toISOString() } : { duration_minutes: 600 }),
      self_enroll_enabled: true,
      ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
  expect(token, "a join token").toBeTruthy();
  return { comp, token };
}

/** Change one event's sign-up matrix, honouring optimistic concurrency. */
async function setFields(api, csrf, compId, registration_fields) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const cur = (list.competitions || list).find(c => c.id === compId);
  expect(cur, "the competition is in the admin list").toBeTruthy();
  const r = await api.put(`/api/admin/competitions/${compId}`, {
    headers: H(csrf), data: { expectedUpdatedAt: cur.updated_at, registration_fields },
  });
  expect(r.status(), `PUT registration_fields on ${compId}: ${await r.text()}`).toBe(200);
}

/** A walk-up created at the desk. `competitionId` null = no event named. */
async function deskInvite(api, csrf, competitionId) {
  const email = `${uniq()}@company.example`;
  const r = await api.post("/api/admin/participants/desk-invite", {
    headers: H(csrf), data: { email, ...(competitionId ? { competitionId } : {}) },
  });
  expect(r.status(), `desk-invite ${email}: ${await r.text()}`).toBe(200);
  const body = await r.json();
  expect(body.code, "the desk hands over a sign-in code").toBeTruthy();
  return { id: body.id, email, code: body.code };
}

/** A QR sign-up through the join token, leaving `blank` fields as "" (NODE_ENV=test's `??` defaults cannot fill ""). */
async function qrSignUp(token, blank = []) {
  const { api, csrf } = await freshCtx();
  const label = uniq();
  const data = {
    firstName: "Walk", lastName: "Up", nickname: label, email: `${label}@company.example`,
    company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "Testville",
    password: PARTICIPANT_PASS, joinToken: token,
  };
  for (const f of blank) data[f] = "";
  const r = await registerPost(api, "/api/register", { headers: H(csrf), data });
  expect(r.status(), `QR sign-up: ${await r.text()}`).toBe(200);
  await api.dispose();
  return data.email;
}

/** Sign in with the code the desk handed over, keeping the session. */
async function signInWithCode(email, code) {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
  expect(r.status(), "redeem answers 200 whatever the outcome").toBe(200);
  const d = await r.json();
  expect(d.ok, `the desk's code signs the walk-up in: ${JSON.stringify(d)}`).toBe(true);
  return api;
}

/** The gate's own answer, as the participant sees it (GET /api/me — cached 2 s per user). */
async function meMissing(api) {
  const r = await api.get("/api/me");
  expect(r.ok(), `GET /api/me: ${r.status()}`).toBeTruthy();
  return (await r.json()).missing_fields;
}

function dbRow(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

/** The gate computed from the database row, UNCACHED, through the production fragment. */
function gateRow(email) {
  const { PROFILE_GATE_COLUMNS, PROFILE_GATE_JOIN } = require("../lib/util");
  return dbRow(`SELECT ${PROFILE_GATE_COLUMNS} FROM users u ${PROFILE_GATE_JOIN} WHERE LOWER(u.email)=LOWER(?)`, email);
}
function gate(email) {
  const { _profileMissingFields } = require("../lib/util");
  const row = gateRow(email);
  expect(row, `the account ${email} exists`).toBeTruthy();
  return _profileMissingFields(row);
}

// A desk account collects email and name only, so these four base fields are
// always owed at first sign-in. What the tests below move is everything AFTER them.
const BASE_OWED = ["company", "title", "country", "timezone"];

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.8 — a desk account reads its event's LIVE sign-up form", () => {
  test("GET /api/me carries no `_`-prefixed key — the gate's joined columns are inputs, not profile fields", async () => {
    // The payload spreads the gate's row, and since v8.4.0 that row carries the
    // joined `_reg_event_kind` / `_reg_field_policy` whenever the account has a
    // resolving pointer — which every desk account made for an event now has. The
    // handler's own comment claimed they never reached the wire.
    const { api, csrf } = await sa();
    const ev = await liveEvent(api, csrf, "booth");
    const walk = await deskInvite(api, csrf, ev.comp.id);
    const me = await signInWithCode(walk.email, walk.code);
    const r = await me.get("/api/me");
    expect(r.ok(), `GET /api/me: ${r.status()}`).toBeTruthy();
    const body = await r.json();
    // PRECONDITION: the join really resolved for this account, or the absence
    // below is equally true of a row the join never touched.
    expect(dbRow(`SELECT _regc.event_kind AS k FROM users u LEFT JOIN competitions _regc ON _regc.id = u.registration_competition_id WHERE u.id=?`, walk.id).k,
      "the account's pointer resolves to its event").toBe("booth");
    expect(Object.keys(body).filter(k => k.startsWith("_")), "no internal key reaches the participant").toEqual([]);
    // CONTROL: the strip is by prefix only — the profile fingerprint the edit
    // dialogs compare (v8.8.25) and the missing-fields answer still ride.
    expect(typeof body.updated_at, "updated_at still on the wire").toBe("string");
    expect(Array.isArray(body.missing_fields), "missing_fields still on the wire").toBe(true);
  });

  test("the desk stores the pointer, and a field the organiser LATER makes mandatory is demanded at once — an unrelated event's change moves nothing", async () => {
    const { api, csrf } = await sa();
    const own = await liveEvent(api, csrf, "booth");
    const other = await liveEvent(api, csrf, "booth");
    const walk = await deskInvite(api, csrf, own.comp.id);

    const row = dbRow("SELECT registered_via, profile_policy, registration_competition_id FROM users WHERE id=?", walk.id);
    expect(row, "the desk account exists").toBeTruthy();
    expect(row.registered_via, "the discriminator the password exemption keys on").toBe("desk");
    expect(row.profile_policy, "the kind is still stamped — it is the fallback for a deleted event").toBe("booth");
    expect(row.registration_competition_id, "…and the account now records WHICH event created it").toBe(own.comp.id);

    const me = await signInWithCode(walk.email, walk.code);
    // Baseline — an unconfigured Booth Event is the short form (operator order,
    // 29 Oct 2026): City and Job function optional, the rest off, so nothing
    // beyond the base set is owed.
    const before = [...BASE_OWED];
    expect(await meMissing(me), "the booth's default form").toEqual(before);   // warms the 2 s /api/me cache

    // CONTROL — the SAME change on a DIFFERENT event must not reach this account.
    // Read uncached from the database, so a cache hit cannot make "unchanged" true
    // for the wrong reason.
    await setFields(api, csrf, other.comp.id, { phone: "required" });
    expect(gate(walk.email), "an unrelated event's mandatory Phone is not this account's").toEqual(before);

    // The event it was created FOR makes Phone mandatory — demanded immediately.
    // Read through /api/me straight after the save: the cache warmed above can
    // only be bypassed by the competition PUT's bust, which is keyed on the pointer.
    await setFields(api, csrf, own.comp.id, { phone: "required" });
    const after = [...BASE_OWED, "phone"];
    expect(await meMissing(me), "the organiser's live answer reaches the desk account, at once").toEqual(after);
    expect(gate(walk.email), "…and the uncached computation agrees").toEqual(after);

    // A RELAXATION reaches it too — the pointer is a live read, not a one-way
    // ratchet. Job function is made mandatory in the same save, so the event's
    // form differs from the kind's defaults and the deletion arm below can tell
    // the stamped fallback from the live read.
    await setFields(api, csrf, own.comp.id, { phone: "hidden", job_function: "required" });
    const relaxed = [...BASE_OWED, "job_function"];
    expect(await meMissing(me), "a field the organiser relaxes stops being owed").toEqual(relaxed);

    // THE EVENT IS DELETED — the pointer dangles and the stamped kind takes over,
    // exactly as for a QR account, and the DELETE's bust, keyed on the pointer,
    // makes that visible at once.
    //
    // The event has to be ended first (a live event with a participant refuses
    // the DELETE), and End Now busts every MEMBER's /api/me entry by itself — so
    // a read straight after the DELETE would be fresh whether or not the DELETE
    // busts anything. The cache is therefore warmed AGAIN after End Now, while
    // the ended event still resolves, and the warm read, the DELETE and the
    // re-read are timed: inside the 2 s TTL the entry is still live, so only the
    // DELETE's own bust can make the re-read fresh. A box too slow to fit the
    // window fails the PRECONDITION by name rather than passing on an expired
    // entry.
    const end = await api.post(`/api/admin/competitions/${own.comp.id}/end-now`, { headers: H(csrf), data: {} });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const t0 = Date.now();
    expect(await meMissing(me), "the ENDED event still resolves — its own form (and the cache is warm again)").toEqual(relaxed);
    const del = await api.delete(`/api/admin/competitions/${own.comp.id}`, { headers: H(csrf) });
    expect(del.ok(), `delete: ${await del.text()}`).toBeTruthy();
    const afterDelete = await meMissing(me);
    expect(Date.now() - t0, "PRECONDITION: the warm read, the DELETE and the re-read fit inside the 2 s /api/me TTL")
      .toBeLessThan(1800);
    expect(afterDelete, "a deleted event falls back to the booth kind's defaults, at once").toEqual(before);

    await me.dispose();
    await api.dispose();
  });






});

// ─────────────────────────────────────────────────────────────────────────────
// THE BACKFILL, DRIVEN AGAINST THE REAL db.js IN A THROWAWAY DATA DIRECTORY.
//
// The shared test server is always a FIRST boot (tests/isolated-test.js wipes the
// data directory per spec file), and the subject here is what a later boot does to
// rows an earlier release left behind — so a scratch directory and explicit boots
// are the only shape that can see it. db.js needs no BASE_URL, which is what makes
// it drivable in a child at all (the linkedin-signup-switch migration arm's shape).
test.describe("v8.12.8 — existing desk accounts are linked once, and only when the event is beyond doubt", () => {
  function bootDbIn(dir) {
    const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
      cwd: path.join(__dirname, ".."),
      // NODE_OPTIONS scrubbed: an inherited --require has changed a child's exit
      // code before (v7.15.30), and this asserts on it.
      env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
      encoding: "utf8",
    });
    expect(r.status, `db.js boot must succeed: ${r.stderr}`).toBe(0);
    return `${r.stdout}${r.stderr}`;   // BOTH streams: success is console.log, failure console.error
  }
  const open = (dir) => new Database(path.join(dir, "hackathon.db"));
  const MARKER = "desk_registration_link_backfill_at";
  const marker = (db) => db.prepare(`SELECT value FROM settings WHERE key='${MARKER}'`).get();
  const pointer = (db, id) => db.prepare("SELECT registration_competition_id r FROM users WHERE id=?").get(id).r;

  const T0 = "2026-03-01T09:00:00.000Z";
  function mkComp(db, id, kind = "booth") {
    db.prepare("INSERT INTO competitions (id,name,event_kind,start_time,duration_minutes,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, `Event ${id}`, kind, T0, 120, T0);
  }
  let n = 0;
  /** A user row as a pre-v8.12.8 release left it. */
  function mkUser(db, { via = "desk", policy = "booth", pointerTo = null, createdAt } = {}) {
    const id = `u-${++n}`;
    const at = createdAt || new Date(Date.parse(T0) + n * 1000).toISOString();
    db.prepare(`INSERT INTO users (id,first_name,last_name,nickname,email,password_hash,verified,approved,role,registered_via,profile_policy,registration_competition_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?,1,1,'participant',?,?,?,?,?)`)
      .run(id, "Desk", "Walkup", `nick${n}`, `walk${n}@company.example`, "x", via, policy, pointerTo, at, at);
    return { id, at };
  }
  /** The desk's own audit row: `added_to_competition`, via desk_invite, naming the event. */
  function mkAudit(db, userId, compId, { raw } = {}) {
    db.prepare("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)")
      .run(`ev-${++n}`, userId, "added_to_competition", "admin@company.example", T0,
           raw !== undefined ? raw : JSON.stringify({ competition_id: compId, competition_name: `Event ${compId}`, via: "desk_invite" }));
  }
  /** Any other user event, shaped as its writer leaves it. */
  function mkEvent(db, userId, type, details) {
    db.prepare("INSERT INTO user_events (id,user_id,event_type,changed_by,changed_at,details) VALUES (?,?,?,?,?,?)")
      .run(`ev-${++n}`, userId, type, "superadmin", T0, JSON.stringify(details));
  }
  /** The desk's membership row — `assigned_at` equal to the account's `created_at`. */
  function mkMember(db, compId, u, assignedAt) {
    db.prepare("INSERT INTO competition_users (competition_id,user_id,assigned_by,assigned_at,direct_assigned) VALUES (?,?,?,?,1)")
      .run(compId, u.id, "admin@company.example", assignedAt || u.at);
  }

  test("each case is decided exactly once: both witnesses, either alone, ambiguous, deleted, no event, and a row that is not the desk's", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desk-link-"));
    try {
      // ── A fresh install: the marker is ARMED on the first boot, so the pass
      // never runs against rows created after it. ──
      expect(fs.existsSync(path.join(tmp, "hackathon.db")), "PRECONDITION: a first boot").toBe(false);
      bootDbIn(tmp);
      const ids = {};
      {
        const db = open(tmp);
        try {
          expect(marker(db), "the one-shot marker is armed on a fresh install").toBeTruthy();
          // ── Manufacture a pre-v8.12.8 database: the marker has never been
          // written, and the desk accounts carry no pointer. ──
          db.prepare(`DELETE FROM settings WHERE key='${MARKER}'`).run();
          for (const c of ["A", "B", "C"]) mkComp(db, c);
          // 1. Both witnesses agree → linked.
          ids.both = mkUser(db); mkAudit(db, ids.both.id, "A"); mkMember(db, "A", ids.both);
          // 2. Removed from the event since (no membership) — the audit alone → linked.
          ids.auditOnly = mkUser(db); mkAudit(db, ids.auditOnly.id, "B");
          // 3. History purged by retention — the membership alone → linked.
          ids.memberOnly = mkUser(db); mkMember(db, "C", ids.memberOnly);
          // 4. The witnesses DISAGREE → left alone.
          ids.ambiguous = mkUser(db); mkAudit(db, ids.ambiguous.id, "A"); mkMember(db, "B", ids.ambiguous);
          // 5. The event was deleted → left alone (the pointer would dangle from birth).
          ids.deleted = mkUser(db); mkAudit(db, ids.deleted.id, "GONE");
          // 6. No surviving record at all → left alone.
          ids.none = mkUser(db);
          // 7. A desk account created with NO event (profile_policy NULL) is never
          //    touched — even beside a membership that happens to share its
          //    created_at (added later in the same millisecond).
          ids.noEvent = mkUser(db, { policy: null }); mkMember(db, "A", ids.noEvent);
          // 8. Not a desk account — a QR/manual row with the same shape of evidence.
          ids.manual = mkUser(db, { via: "manual" }); mkAudit(db, ids.manual.id, "A"); mkMember(db, "A", ids.manual);
          // 9. Already linked → untouched, whatever the witnesses say.
          ids.linked = mkUser(db, { pointerTo: "C" }); mkAudit(db, ids.linked.id, "A");
          // 10. A membership added LATER (a different assigned_at) is not a witness.
          ids.later = mkUser(db); mkMember(db, "A", ids.later, "2026-04-01T00:00:00.000Z");
          // 11. A malformed audit blob must not abort the pass; the membership still links it.
          ids.badJson = mkUser(db); mkAudit(db, ids.badJson.id, null, { raw: "{not json desk_invite" }); mkMember(db, "B", ids.badJson);
          // 12. IMPORTED, not made here: a desk account exported from another
          //     instance and brought in by the participant import BEFORE the
          //     upgrade. The import writes `registered_via`, `profile_policy`,
          //     `created_at` and each membership's `assigned_at` VERBATIM, resolving
          //     the event by NAME — so the membership witness alone would name THIS
          //     instance's same-named event: a pointer a migration invented. Shaped
          //     exactly as the import's CREATE branch leaves it.
          ids.imported = mkUser(db); mkMember(db, "A", ids.imported);
          mkEvent(db, ids.imported.id, "created", { via: "import", email: "walk-imported@company.example" });
          mkEvent(db, ids.imported.id, "approved", { via: "import" });
          mkEvent(db, ids.imported.id, "added_to_competition", { competition_id: "A", competition_name: "Event A", via: "import" });
          // 13. The same import whose best-effort membership audit row is missing
          //     (that write is caught and dropped): the account's own `created`
          //     row still says a migration made it.
          ids.importedBare = mkUser(db); mkMember(db, "B", ids.importedBare);
          mkEvent(db, ids.importedBare.id, "created", { via: "import", email: "walk-bare@company.example" });
          // 14. An import OVERWRITE that turned a local account desk-shaped: the
          //     file's `registered_via`, `created_at` and membership all landed
          //     verbatim. No `created` row — but the membership is the import's.
          ids.overwritten = mkUser(db); mkMember(db, "C", ids.overwritten);
          mkEvent(db, ids.overwritten.id, "edited", { via: "import_overwrite" });
          mkEvent(db, ids.overwritten.id, "added_to_competition", { competition_id: "C", competition_name: "Event C", via: "import" });
          // 15. CONTROL — a GENUINE desk account (its history purged, as in case 3)
          //     later corrected by an import overwrite of its own export. Its
          //     membership predates the file (the import's INSERT OR IGNORE left it
          //     alone and wrote no audit row), so it is still the desk's witness and
          //     the account IS linked. Without this, "an import is never linked" is
          //     satisfied by a build that skips any account an import ever touched.
          ids.roundTrip = mkUser(db); mkMember(db, "B", ids.roundTrip);
          mkEvent(db, ids.roundTrip.id, "edited", { via: "import_overwrite" });
          expect(marker(db), "PRECONDITION: a pre-v8.12.8 database carries no marker").toBeFalsy();
        } finally { db.close(); }
      }

      // ── Boot 2: the backfill runs. ──
      const out2 = bootDbIn(tmp);
      {
        const db = open(tmp);
        try {
          expect(pointer(db, ids.both.id), "both witnesses → linked").toBe("A");
          expect(pointer(db, ids.auditOnly.id), "the audit alone (removed since) → linked").toBe("B");
          expect(pointer(db, ids.memberOnly.id), "the membership alone (history purged) → linked").toBe("C");
          expect(pointer(db, ids.badJson.id), "a malformed blob is skipped, not fatal").toBe("B");
          expect(pointer(db, ids.ambiguous.id), "disagreeing witnesses → left alone").toBeNull();
          expect(pointer(db, ids.deleted.id), "a deleted event → left alone").toBeNull();
          expect(pointer(db, ids.none.id), "no surviving record → left alone").toBeNull();
          expect(pointer(db, ids.noEvent.id), "a desk account with no event named → never touched").toBeNull();
          expect(pointer(db, ids.manual.id), "a non-desk account → never touched").toBeNull();
          expect(pointer(db, ids.linked.id), "an existing pointer → never overwritten").toBe("C");
          expect(pointer(db, ids.later.id), "a later membership is not the desk's witness").toBeNull();
          expect(pointer(db, ids.imported.id), "an account the participant import made → never linked").toBeNull();
          expect(pointer(db, ids.importedBare.id), "…even when its membership audit row is missing").toBeNull();
          expect(pointer(db, ids.overwritten.id), "a membership the import wrote is not the desk's witness").toBeNull();
          expect(pointer(db, ids.roundTrip.id), "a genuine desk account an import later corrected → still linked").toBe("B");
          expect(marker(db), "the marker is armed").toBeTruthy();
          // The profile fingerprint is NOT moved: no profile field changed.
          expect(db.prepare("SELECT updated_at u FROM users WHERE id=?").get(ids.both.id).u,
            "updated_at is untouched, so no open edit dialog 409s after a restart").toBe(ids.both.at);
        } finally { db.close(); }
      }
      expect(out2, "the boot says what it did, and what it left alone")
        .toContain("desk accounts linked to their event's sign-up form: 5 (left alone: 1 ambiguous, 1 whose event was deleted, 2 with no surviving record, 3 brought in by a participant import)");

      // ── Boot 3: ONE-SHOT. A row that would qualify, added after the pass (the
      // shape a later participant IMPORT produces), is not linked by a migration. ──
      {
        const db = open(tmp);
        try {
          ids.afterwards = mkUser(db); mkAudit(db, ids.afterwards.id, "A"); mkMember(db, "A", ids.afterwards);
        } finally { db.close(); }
      }
      const out3 = bootDbIn(tmp);
      {
        const db = open(tmp);
        try {
          expect(pointer(db, ids.afterwards.id), "the pass does not run a second time").toBeNull();
          expect(pointer(db, ids.both.id), "and nothing it linked moved").toBe("A");
        } finally { db.close(); }
      }
      expect(out3, "no second report").not.toContain("desk accounts linked");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a failure mid-pass commits NOTHING — neither a link nor the marker — and the next boot retries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desk-link-fail-"));
    try {
      bootDbIn(tmp);
      let u;
      {
        const db = open(tmp);
        try {
          db.prepare(`DELETE FROM settings WHERE key='${MARKER}'`).run();
          mkComp(db, "A"); mkComp(db, "B");
          const first = mkUser(db); mkAudit(db, first.id, "A");
          u = mkUser(db); mkAudit(db, u.id, "B");
          // A trigger that refuses the SECOND link, so the first has already been
          // written inside the transaction when the pass fails.
          db.exec(`CREATE TRIGGER desk_link_boom BEFORE UPDATE OF registration_competition_id ON users
                   WHEN NEW.id = '${u.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
          u.first = first;
        } finally { db.close(); }
      }
      const out = bootDbIn(tmp);
      expect(out, "the failure is reported, not swallowed").toContain("could not link existing desk accounts");
      {
        const db = open(tmp);
        try {
          expect(pointer(db, u.first.id), "the link written before the failure was rolled back").toBeNull();
          expect(marker(db), "…and the marker was not armed, so the next boot retries").toBeFalsy();
          db.exec("DROP TRIGGER desk_link_boom");
        } finally { db.close(); }
      }
      bootDbIn(tmp);
      {
        const db = open(tmp);
        try {
          expect(pointer(db, u.first.id), "retried on the next boot").toBe("A");
          expect(pointer(db, u.id)).toBe("B");
          expect(marker(db)).toBeTruthy();
        } finally { db.close(); }
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
