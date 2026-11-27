// v8.12.6 — the child-process harness behind the CxOne provisioning and
// withdrawal specs (find them with `grep -l cxone-harness-client tests/`; a list
// here goes stale).
//
// NOT A SPEC, and it must never be loaded by one. It runs ONE provisioning
// scenario per process: the scenario as JSON in argv[2], the result as one JSON
// line on stdout. It is the first thing in the suite that reaches
// `cxOneProvisionUser` at all — nothing behavioural can THROUGH THE SERVER,
// because `CXONE_HOSTNAME_ALLOWED` refuses a localhost IDP. What makes it
// reachable here is replacing the transport, which is forbidden in a Playwright
// WORKER (it would leak into every other spec the worker runs, and db.js opens
// the database at require time) and harmless in a throwaway child.
//
// Order of operations, each load-bearing:
//   1. Refuse to run unless DATA_DIR / UPLOADS_DIR / BASE_URL are set and
//      DATA_DIR sits under os.tmpdir() — db.js opens the database at REQUIRE
//      time, so a guessed path attaches to a live deployment (v8.8.26).
//   2. Poison `globalThis.fetch`, so a transport that ever stops going through
//      lib/http fails LOUDLY (the control arms go red) instead of reaching the
//      network or passing vacuously.
//   3. Replace `fetchWithTimeout` on lib/http's EXPORTS object BEFORE requiring
//      lib/cxone, which destructures it at require time.
//   4. Plant the user, the event (a key whose decoded `iss` passes the
//      allowlist) and the membership through db.js directly.
//   5. Run the scenario. Every mid-flight change is made INSIDE the stubbed
//      upstream call it is named for — the real `deleteUserCascade` for an
//      erasure, and what the admin routes do to the two rows provisioning reads
//      for everything else — so the change lands exactly where a race would
//      put it.
//   6. Wait for any withdrawal run, print the result and EXIT NATURALLY. lib/log writes through an async
//      WriteStream and the audit mirror is setImmediate-deferred, so the caller
//      reads app-*.jsonl AFTER this process has exited — the only point at which
//      both are guaranteed flushed. Do not db.close() or process.exit() on
//      success.
//
// Scenario keys (all optional):
//   create: 201 | 409          search: "match" | "conflict" | "empty"
//   noLocation: bool           groups: 200 | 500      assign: <PUT status>
//   delStatus: <DELETE status> group: <event group, "" for none>
//   globalGroup: <settings.default_cxone_group_name>
//   globalOnly: bool — provision with NO competition (the global-default path)
//   globalKey: bool — also configure the GLOBAL default key (implied by globalOnly)
//   secondEvent: bool — also enrol the participant in a second event "c-2"
//   deleteUserAt / deleteCompAt / removeMembershipAt / disableCxoneAt: a call
//     key — "TOKEN", "POST /users", "GET /users", "GET /groups", "PUT grant" —
//     optionally "#<n>" (the n-th such call, 1-based) and/or ":json" (fire
//     inside that response's body read rather than the fetch).
//   ledgerAt: a call key as above — snapshot the ledger AT that call, i.e. what a
//     process that died there would leave committed (output `ledgerAtFire`).
//   removeFrom / disableOn: the event those two act on (default "c-1").
//   deleteBefore / deleteCompBefore / removeMembershipBefore / disableBefore:
//     act before the job starts.
//
// v8.12.7 — the realm-account ledger and the withdrawal runner (F2):
//   createdId: the id on the 201's Location (default "kc-created", which is NOT
//     a UUID and so records no ledger row — the v8.12.6 arms rely on that)
//   createStatus: the POST's status when it is not a 409 (default 201)
//   matchId: the id the search returns on a 409 (default "kc-pre-existing")
//   rep: {createdTimestamp: "now"|"old"|null|<ms>, username, email, firstName,
//     lastName, federationLink} — the realm's record the runner reads
//   getUser: <status> | {<realm>: <status>}   fed: [...]   fedStatus
//   delStatuses: [<status>, ...] — DELETE answers in order, then delStatus
//   delBody: "rep" — a refused DELETE (>= 400) answers with the realm's record in
//     its body, so an arm can prove nothing from a response body is kept
//   tokenStatus: the token endpoint's status once provisioning has finished
//   eventKeyRealm / globalKeyRealm: "tenant1" | "tenant2" | "eu"
//   extraEvents: [{id, keyRealm}] — events the participant is not in
//   plantUsers: [{id, email, secondary_email, pending_email, first_name,
//     last_name, verified, enrolIn, cxoneUserId}]
//   plantBinding: a realm id on the participant's own event binding
//   plantLedger: [{id, ...columns}]   plantHistory: [{userId, type, details, at}]
//   bindAt: a call key (as above) at which `bindUser` (default "u-2", planted)
//     becomes bound to the created account
//   autorun: set the runner's opt-in in THIS process    healthy: false
//   noProvision: skip provisioning    steps: see "5. The scenario"
//
// v8.12.7 (pre-release review):
//   userGroups: [{id, name}] — the account's memberships the runner reads
//     (default none)     userGroupsStatus / userGroupsStatuses: [<status>, ...]
//     (answered in order, then userGroupsStatus, then 200)
//   defaultGroups: [{id, name}] — the realm's default groups (default none)
//     defaultGroupsStatus: its status (default 200)
//   deleteWho: the user the `deleteUserAt` erasure deletes (default u-1)
//
// v8.13.1 (external audit):
//   replaceAt: a call key at which u-1 is erased, a replacement ("u-2", or
//     `replaceUser`) registers with u-1's address, is assigned to the event
//     (`replaceIn`, default c-1) and is PROVISIONED to completion — inside the
//     original job's suspended call; its create 409s and its search finds the
//     account the original job created, so it is matched to that account
//   extraEvents[].group: that event's own group ("" = none, so it grants the
//     global default)   extraEvents[].keyRealm: null = no key of its own
//   ownershipReadFails: true — the provisioning job's own ownership read throws
//   extraEvents[].key: a RAW key string stored as-is (wins over keyRealm) — e.g.
//     one that does not decode, which provisions under the global default key
//   steps {retry, override, expectedHold, expectedSignal}: the hold (and the
//     sign) the superadmin read; omitted = the row's at that moment, null = send none
//
// A removal in progress, and a match that waits for it (lib/cxone.js registry):
//   realm: true — answer from a MODEL of the realm instead of the fixed answers:
//     a create 409s when a live account holds its username or address, else 201s
//     with the next id of `realmIds` (default createdId, RECREATED, THIRD); a
//     search finds live accounts by exact username / address; a read or a grant
//     of a removed or unknown id is 404; a DELETE answered 2xx/404 removes it.
//     `realmAddAt` (a call key) adds `realmAdd` ({id, username, email, …}) then.
//   throwAt: a call key, or [key | {call, landed}] — that call gets NO answer
//     (rejects) once its actions have fired; `landed: true` applies a DELETE's
//     effect first. `#*` matches every occurrence.
//   holds: [{call, until, fireRetries}] — `call` (a call key, `:json` = inside
//     its body read) waits after its own actions fire and before its answer is
//     computed, until `until` has been answered (a call key) or the registry
//     holds the created account in a state ({removal: "in_flight"|"removed"|
//     "unknown", id}); `fireRetries` fires pending set-up retries while waiting.
//     A hold not released in 5 s fails the call (`holdLog`).
//   replaceConcurrentAt: a call key — as `replaceAt`, but the replacement's job
//     is STARTED, not awaited: the call goes on, and the main flow awaits it
//     before the steps (realm: true only)
//   transferAt: a call key — the ledger row of the created account is re-keyed
//     to `transferTo` (default "u-2", planted) directly, past the registry
//   bindUsername: the `cxone_username` the `bindAt` binding is written with
// Steps: "retries" fire every pending set-up retry now, then wait for the queue;
//   "stopRetries" the shutdown's stop; "queue" wait for the queue; "resume" the
//   boot's re-queue of deferred set-ups; {ageRemovals: <ms>} age the registry;
//   "rereads" fire every armed re-read of an unanswered removal, at its own
//   clock; {reassign: <userId>, comp, after} the re-assign remedy (`after`:
//   "retries" | "resume" | "reassign" queues a job for them first, unawaited);
//   {wait: <ms>} real time, then the queue; "pending" the pending retries;
//   {erase: <userId>} the real cascade of that person; {resumeWhenHealthy: bool},
//   {resumeHealth: bool}, "resumeCheck" the boot's resume on a live health gate;
//   "evictionProbe" the registry's cap.
// Output adds: people (every user but u-1: bindings, cxone_* events in order),
//   replacement (people[replaceUser || "u-2"]), posts (POST /users bodies),
//   removals, retries, retriesPending, deferredCounts, binderOfCreated, holdLog,
//   dbEvents (every cxone_* History row, whoever it names).
//
// Has the tenant taken the account into use? (the runner's step 8 reads beyond
// the groups; lib/cxone-identity.js has the rules). Answers depend on WHO asks:
// a provisioning job (`creating`: the harness's own cxOneProvisionUser calls —
// the initial run, a {provision} step, a replacement — or any job the queue is
// running) gets the at-create answers, the runner the others. Never the global
// `phase`, which turns to "withdraw" before the steps run.
//   at create (the creation-baseline reads, created accounts only):
//     getUserAtCreate: <status> (default 200)   createAttributes: {key: [...]}
//     rolesAtCreate: <role-mappings body>   rolesAtCreateStatus: <status>
//   the runner — each a QUEUE answered in order, then the single value, then the
//   default (a PRISTINE account, so every arm that sets nothing is removed):
//     rolesStatuses / rolesStatus, rolesBodies / roles   (default: the realm's
//       default role only, `default-roles-<realm>`, id `rr-default-<realm>`)
//     credsStatuses / credsStatus, credsBodies / creds    (default [] ; a
//       `createdDate` of "beforeDeletion" / "withinMargin" / "afterDeletion" is
//       dated halfway between the row's provenance_at and the runner's clock
//       margin before pending_since / inside that margin / between
//       pending_since and the read; output `credsDated` has the instants)
//   waitBeforeSteps: <ms> — real time between provisioning and the first step
//     (so the creation and the deletion are apart)
//   backdateCreationMs: <ms> — the account was made that long before it really
//     was: the row's provenance_at and the realm's own createdTimestamp move
//     back together, so provenance still matches (what "beforeDeletion" needs:
//     a creation earlier than the clock margin before the deletion)
//   plantAt: a call key at which `plantAtUser` (the plantUsers shape) arrives
//     profileStatuses / profileStatus, profileBodies / profile  (default: the
//       four root attributes, user-editable, no unmanaged policy)
//     clientsStatuses / clientsStatus, clientsBodies / clients  (default: the
//       realm-management client with access.view true)
//   rep.attributes / enabled / requiredActions / emailVerified / totp — passed
//     through on the runner's record of the account
//   GET /users/profile is keyed "GET /users/profile" — matched BEFORE the
//   `/users/<id>` normalisation, which would otherwise answer it as an account.
//
// A provisioning record that cannot be read (lib/cxone-ledger.js
// BINDING_UNREADABLE):
//   plantHistory[].detailsRaw: the row's `details` TEXT exactly as given (not
//     JSON-encoded) — e.g. a truncated record that still names the account
//   plantHistoryAt: a call key at which `plantHistoryLate` (the plantHistory
//     shape, detailsRaw included) is written
//   the output's `binderOfCreated` is "binding_unreadable" when `livingBinder`
//     answers that (a Symbol, which JSON would otherwise drop)
//
// Retention (no ledger row is dropped for its age):
//   listReadFails: <n> — the superadmin list's own SELECT (listCxOneWithdrawals,
//     and only it) throws the first n times it is prepared, so an arm can show
//     that the runner's past-retention note never stops a removal (output
//     `listReadFailures`: how many times it did throw)
//   the output's `retentionDays` is the EVENT_RETENTION_DAYS this child read
"use strict";
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const S = JSON.parse(process.argv[2] || "{}");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");   // lib/log takes over console.*
const refuse = (msg) => { process.stderr.write(`cxone-provision-harness: ${msg}\n`); process.exit(2); };

// 1. Never attach to anything but a throwaway directory.
for (const V of ["DATA_DIR", "UPLOADS_DIR", "BASE_URL"]) if (!process.env[V]) refuse(`${V} is unset`);
if (!path.resolve(process.env.DATA_DIR).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
  refuse(`DATA_DIR (${process.env.DATA_DIR}) is not under ${os.tmpdir()}`);
}

// 2 + 3. The transport.
globalThis.fetch = async (u) => { throw new Error(`HERMETICITY: a real network call was attempted: ${u}`); };
const http = require(path.join(ROOT, "lib", "http.js"));
for (const mod of ["cxone.js", "cxone-withdraw.js"]) {
  if (Object.keys(require.cache).some(k => k.endsWith(`${path.sep}lib${path.sep}${mod}`))) {
    refuse(`lib/${mod} was loaded before the transport stub — it would hold the real fetchWithTimeout`);
  }
}
// v8.12.7 — the withdrawal runner reads its opt-in on every call, so setting it
// HERE, in this throwaway process, drives the automatic path without it ever
// reaching the shared test server (tests/server-env.js pins it off there).
if (S.autorun) process.env.CXONE_WITHDRAWAL_AUTORUN_IN_TEST = "1";
const calls = [];
// v8.12.7 — the same calls with the host and the realm segment kept, so an arm
// can say WHICH realm a call went to; `calls` stays exactly as it was.
const callsFull = [];
const seen = {};
const fired = { deleteUser: null, deleteComp: null, removeMembership: null, disableCxone: null, bindLiving: null, snapshotLedger: null, replaceUser: null,
  replaceConcurrent: null, transferLiving: null, realmAdd: null, plantLate: null, plantHistoryLate: null };
// `ledgerAt`: the ledger as COMMITTED at that call — what a process that died
// there would leave on disk (every ledger write is autocommit).
let ledgerAtFire = null;
let handler = null;
const posts = [];
http.fetchWithTimeout = async (url, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  const u = new URL(url);
  const rm = /^\/auth\/(?:admin\/)?realms\/([^/]+)/.exec(u.pathname);
  const realm = rm ? decodeURIComponent(rm[1]) : "-";
  const rec = { method, host: u.host, realm, path: u.pathname.replace(/^\/auth\/admin\/realms\/[^/]+/, "") + (u.search || "") };
  try { rec.body = typeof opts.body === "string" ? JSON.parse(opts.body) : null; } catch (_) { rec.body = null; }
  calls.push(`${rec.method} ${rec.path}`);
  callsFull.push(`${rec.method} ${rec.host}/${rec.realm} ${rec.path}`);
  const { key, n } = keyOf(rec);
  if (key === "POST /users" && rec.body) posts.push({ username: rec.body.username, email: rec.body.email });
  // v8.13.1 — an ACTION may be async (`replaceAt` runs a whole second
  // provisioning job); the suspended call does not return until the actions IT
  // fired have finished, which is exactly where a race would put it. Each call
  // waits on its OWN actions only, so a nested job's calls never wait on the
  // action that is running them. Then any hold, then the answer — computed only
  // now, so a realm effect lands after the actions and the hold it raced.
  await Promise.all(fire(key, n, "fetch"));
  await hold(key, n, "fetch");
  if (key === "GET /users/<id>/credentials") await credsReadable(idOf(rec));
  const t = throwFor(key, n);
  if (t) {
    if (t.landed && REALM && key === "DELETE /users/<id>") REALM.gone.add(idOf(rec));
    answered.add(`${key}#${n}`);
    throw new Error("harness: the call got no answer");
  }
  const res = handler(rec, key, n);
  answered.add(`${key}#${n}`);
  return res;
};

const db = require(path.join(ROOT, "db.js"));
const C = require(path.join(ROOT, "lib", "cxone.js"));
const { cxOneProvisionUser, cxOneCreateUnconfirmedCounts } = C;
const { deleteUserCascade } = require(path.join(ROOT, "lib", "account-reaper.js"));
const { _invalidateCompetitionCache } = require(path.join(ROOT, "lib", "competitions.js"));
const { backfillFromHistory, transferTo, livingBinder, BINDING_UNREADABLE } = require(path.join(ROOT, "lib", "cxone-ledger.js"));
const W = require(path.join(ROOT, "lib", "cxone-withdraw.js"));
// v8.12.7 (review) — count the runner's living-binder scans (the LIKE walk over
// `user_events`), so an arm can lock WHERE that scan runs, not only what a run
// decides. The statement is prepared per call, so wrapping `prepare` on the one
// shared handle sees every one.
let binderScans = 0;
let listReadFailures = 0;
{
  const _prep = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/event_type\s*=\s*'cxone_provisioned'/.test(sql) && /details\s+LIKE\s+\?/.test(sql)) binderScans++;
    if (listReadFailures < (S.listReadFails || 0)
      && /FROM cxone_realm_accounts r\s+LEFT JOIN competitions c[\s\S]*ORDER BY COALESCE\(r\.pending_since, r\.recorded_at\) DESC/.test(sql)) {
      listReadFailures++;
      throw new Error("harness: the withdrawal list read fails");
    }
    // v8.13.1 — `ownershipReadFails`: the provisioning job's own "whose account is
    // it now?" read (lib/cxone.js `_withdrawalOwnershipLost`, and only it) throws,
    // so its fail-closed branch can be reached.
    if (S.ownershipReadFails && /^SELECT user_id, claim_token FROM cxone_realm_accounts WHERE cxone_user_id=\?$/.test(sql)) {
      throw new Error("harness: the ownership read fails");
    }
    return _prep(sql);
  };
}
// The default health answer fails CLOSED (no probe configured = unhealthy), so
// the harness states it: healthy unless the scenario says otherwise.
W.configureCxOneWithdrawals({ isHealthy: () => S.healthy !== false });
// lib/email opens a second database and exits without SMTP_HOST at require time
// (v7.21.14); nothing on this path may reach it.
if (Object.keys(require.cache).some(k => k.endsWith(`${path.sep}lib${path.sep}email.js`))) refuse("lib/email was loaded");

// 4. The fixture.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// One key per realm. Each decodes (its `iss` passes CXONE_HOSTNAME_ALLOWED) to
// a distinct (origin, tenant), and each string is distinct, so the runner's
// candidate list and the harness's realm-keyed answers can tell them apart.
const KEYS = {
  tenant1: `${b64({ alg: "none" })}.${b64({ iss: "https://iam.checkmarx.net/auth/realms/tenant1" })}.sig`,
  tenant2: `${b64({ alg: "none" })}.${b64({ iss: "https://iam.checkmarx.net/auth/realms/tenant2" })}.sig2`,
  eu: `${b64({ alg: "none" })}.${b64({ iss: "https://eu.iam.checkmarx.net/auth/realms/tenant1" })}.sig3`,
};
const KEY = KEYS[S.eventKeyRealm || "tenant1"];
const t = new Date().toISOString();
const UID = "u-1", CID = "c-1", CID2 = "c-2";
const EMAIL = "erin.erased@acme.test";
const group = S.group === undefined ? "hackers" : S.group;
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
if (S.globalGroup) setSetting("default_cxone_group_name", S.globalGroup);
if (S.globalKeyRealm) setSetting("default_cxone_api_key", KEYS[S.globalKeyRealm]);
else if (S.globalOnly || S.globalKey) setSetting("default_cxone_api_key", KEY);
db.prepare("INSERT INTO users (id,first_name,last_name,nickname,email,verified,approved,created_at) VALUES (?,?,?,?,?,1,1,?)")
  .run(UID, "Erin", "Erased", "erin", EMAIL, t);
const plantEvent = (id, name, key = KEY, enrol = true, grp = group) => {
  db.prepare("INSERT INTO competitions (id,name,start_time,duration_minutes,cxone_api_key,cxone_group_name,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, name, t, 60, key, grp, t);
  if (enrol) db.prepare("INSERT INTO competition_users (competition_id,user_id) VALUES (?,?)").run(id, UID);
};
if (!S.globalOnly) plantEvent(CID, "F2 event");
if (S.secondEvent) plantEvent(CID2, "F2 other event");
// Events the participant is NOT in, carrying another realm's key.
// v8.13.1 — `group` names that event's own group ("" for none, i.e. it grants
// the global default); `keyRealm: null` gives it no key of its own.
for (const e of S.extraEvents || []) {
  plantEvent(e.id, e.name || e.id, e.key !== undefined ? e.key : (e.keyRealm === null ? null : KEYS[e.keyRealm]), false,
    e.group === undefined ? group : e.group);
}
// Other people. `enrolIn` / `cxoneUserId` bind them to an event locally — a
// living binder of that realm account.
// Also a STEP (`{plantUser}`): a person who arrives AFTER the erasure — e.g.
// registering with the address the deleted participant had, which the unique
// index refuses while that participant still exists.
function plantUser(p) {
  db.prepare(`INSERT INTO users (id,first_name,last_name,nickname,email,secondary_email,pending_email,verified,approved,created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?)`).run(p.id, p.first_name ?? "Holly", p.last_name ?? "Holder", p.nickname || p.id,
    p.email || `${p.id}@acme.test`, p.secondary_email || null, p.pending_email || null, p.verified === 0 ? 0 : 1, t);
  if (p.enrolIn || p.cxoneUserId) {
    db.prepare("INSERT INTO competition_users (competition_id,user_id,cxone_user_id) VALUES (?,?,?)")
      .run(p.enrolIn || CID, p.id, p.cxoneUserId || null);
  }
}
for (const p of S.plantUsers || []) plantUser(p);
// The participant's own local binding, with nothing in the ledger behind it.
if (S.plantBinding) db.prepare("UPDATE competition_users SET cxone_user_id=? WHERE user_id=? AND competition_id=?").run(S.plantBinding, UID, CID);
// Ledger rows written directly — every column the scenario names, over
// defaults that describe a confirmed account this instance created a moment ago.
for (const L of S.plantLedger || []) {
  const row = {
    cxone_user_id: L.id, iam_origin: "https://iam.checkmarx.net", tenant: "tenant1", realm_confirmed: 1,
    user_id: UID, competition_id: CID, created_username: "erin", provenance: "created", provenance_at: t,
    instance_origin: "http://localhost", recorded_at: t, ...L,
  };
  delete row.id;
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO cxone_realm_accounts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map(c => row[c]));
}
// Provisioning history rows for the boot backfill (and `livingBinder`) to read.
// `detailsRaw` is written as it is — the only way to plant a row that is not JSON.
function plantHistoryRow(H) {
  const text = typeof H.detailsRaw === "string" ? H.detailsRaw : JSON.stringify(H.details || {});
  db.prepare("INSERT INTO user_events (id,user_id,event_type,changed_by,details,changed_at) VALUES (?,?,?,?,?,?)")
    .run(require("crypto").randomUUID(), H.userId || UID, H.type || "cxone_provisioned", "system", text, H.at || t);
}
for (const H of S.plantHistory || []) plantHistoryRow(H);
const user = db.prepare("SELECT * FROM users WHERE id=?").get(UID);
// The participant being provisioned: u-1, unless a `provision` step names
// another. The search answers with THEIR name and address.
let current = user;

// The mid-flight changes. Each is what the real admin action does to the rows
// provisioning reads: the erasure is the real cascade; the event deletion,
// the removal and the opt-out mirror DELETE /api/admin/competitions/:id,
// DELETE …/users/:uid and the PUT (competition_users + the competition cache),
// because the helpers behind those routes require lib/email.
const ACTIONS = {
  deleteUser: () => deleteUserCascade(S.deleteWho || UID),
  deleteComp: () => {
    db.prepare("DELETE FROM competition_users WHERE competition_id=?").run(CID);
    _invalidateCompetitionCache(CID);
    db.prepare("DELETE FROM competitions WHERE id=?").run(CID);
  },
  removeMembership: () => {
    db.prepare("DELETE FROM competition_users WHERE competition_id=? AND user_id=?").run(S.removeFrom || CID, UID);
  },
  disableCxone: () => {
    db.prepare("UPDATE competitions SET cxone_disabled=1 WHERE id=?").run(S.disableOn || CID);
    _invalidateCompetitionCache(S.disableOn || CID);
  },
  // v8.12.7 — a LIVING participant (`bindUser`, planted) becomes bound to the
  // created account locally, the way an assignment's provisioning binds them.
  snapshotLedger: () => { ledgerAtFire = db.prepare("SELECT * FROM cxone_realm_accounts ORDER BY cxone_user_id").all(); },
  // v8.13.1 (external audit) — THE REPLACEMENT. The participant is erased (the
  // real cascade), a NEW person registers with the address they had — the unique
  // index refused it while they existed — and is assigned to the event, and that
  // person's OWN provisioning job runs to completion, all inside the original
  // job's suspended call. Their create answers 409 (the account the original job
  // just made holds the address) and the search finds THAT account, so the
  // replacement is matched to it: `transferTo` re-keys the ledger row and their
  // event binding names the id. `replaceUser` (default "u-2") is the person.
  replaceUser: async () => {
    // Deferred one tick: an action fires INSIDE the handler, before it has
    // answered the original call — and `replacing` changes what `POST /users`
    // answers, so a synchronous start would turn the ORIGINAL job's own create
    // into the replacement's 409 (`replaceAt: "POST /users"` could not be
    // expressed at all). The suspended call still waits for it (`fire` returns it).
    await null;
    deleteUserCascade(UID);
    const rid = S.replaceUser || "u-2";
    plantUser({ id: rid, email: EMAIL, first_name: "Erin", last_name: "Erased", nickname: `${rid}-nick`, enrolIn: S.replaceIn || CID });
    const was = current;
    replacing = true;
    try { await provisionJob(db.prepare("SELECT * FROM users WHERE id=?").get(rid), S.replaceIn || CID); }
    finally { replacing = false; current = was; }
  },
  bindLiving: () => {
    db.prepare(`INSERT INTO competition_users (competition_id,user_id,cxone_user_id,cxone_username) VALUES (?,?,?,?)
      ON CONFLICT(competition_id,user_id) DO UPDATE SET cxone_user_id=excluded.cxone_user_id,
        cxone_username=COALESCE(excluded.cxone_username, competition_users.cxone_username)`)
      .run(S.bindIn || CID, S.bindUser || "u-2", CREATED, S.bindUsername || null);
  },
  // The replacement, as `replaceUser` — but its job is STARTED and left running:
  // the call that fired it goes on, so the two jobs interleave (`holds` order
  // them). Realm model only: the fixed answers cannot serve two jobs at once.
  replaceConcurrent: () => {
    deleteUserCascade(UID);
    const rid = S.replaceUser || "u-2";
    plantUser({ id: rid, email: EMAIL, first_name: "Erin", last_name: "Erased", nickname: `${rid}-nick`, enrolIn: S.replaceIn || CID });
    _concurrent.push(provisionJob(db.prepare("SELECT * FROM users WHERE id=?").get(rid), S.replaceIn || CID)
      .catch((e) => { concurrentErrors.push(String(e && e.stack || e)); }));
  },
  // A re-key that does not ask the registry — a writer the prevention layer
  // cannot see, for the repair layer to answer.
  transferLiving: () => transferTo(db, CREATED, S.transferTo || "u-2", new Date().toISOString()),
  realmAdd: () => { REALM.accounts.set(S.realmAdd.id, { ...S.realmAdd, createdTimestamp: Date.now() }); },
  // A person who arrives (registers) during that call — the plantUsers shape.
  plantLate: () => plantUser(S.plantAtUser),
  // Provisioning record(s) written during that call — the plantHistory shape.
  plantHistoryLate: () => { for (const H of [].concat(S.plantHistoryLate || [])) plantHistoryRow(H); },
};
const _concurrent = [], concurrentErrors = [];
if (S.replaceConcurrentAt && !S.realm) refuse("replaceConcurrentAt needs realm: true");
if (S.realmAddAt && !S.realm) refuse("realmAddAt needs realm: true");
const PLAN = [["deleteUser", S.deleteUserAt], ["deleteComp", S.deleteCompAt],
  ["removeMembership", S.removeMembershipAt], ["disableCxone", S.disableCxoneAt],
  ["bindLiving", S.bindAt], ["snapshotLedger", S.ledgerAt], ["replaceUser", S.replaceAt],
  ["replaceConcurrent", S.replaceConcurrentAt], ["transferLiving", S.transferAt], ["realmAdd", S.realmAddAt],
  ["plantLate", S.plantAt], ["plantHistoryLate", S.plantHistoryAt]].filter(([, at]) => at);
// A call key: "<METHOD> <path>", "TOKEN" or "PUT grant", then "#<n>" (the n-th
// such call, 1-based; "#*" any) and ":json" (inside its body read).
function parseKey(spec) {
  const any = /#\*(?=:json$|$)/.test(spec);
  const m = /^(.*?)(?:#(\d+))?(:json)?$/.exec(spec.replace(/#\*(?=:json$|$)/, ""));
  return { key: m[1], n: any ? "*" : Number(m[2] || 1), phase: m[3] ? "json" : "fetch" };
}
const _matches = (p, key, n, phase) => p.key === key && (p.n === "*" || p.n === n) && p.phase === phase;
// Fire every planned action whose spec names THIS call (and phase); returns the
// promises of the async ones, for this call alone to wait on.
function fire(key, occurrence, phase) {
  const out = [];
  for (const [action, spec] of PLAN) {
    if (fired[action] !== null) continue;
    if (!_matches(parseKey(spec), key, occurrence, phase)) continue;
    fired[action] = calls.length;        // every call at index >= this came AFTER the change
    const p = ACTIONS[action]();
    if (p && typeof p.then === "function") out.push(p);
  }
  return out;
}
// Calls answered so far ("<key>#<n>", "<key>#<n>:json"), for `holds`.
const answered = new Set();
const holdLog = [];
const HOLDS = (S.holds || []).map((h) => ({ ...h, spec: parseKey(h.call) }));
const THROWS = [].concat(S.throwAt || []).map((t) => (typeof t === "string" ? { call: t } : t)).map((t) => ({ ...t, spec: parseKey(t.call) }));
const throwFor = (key, n) => THROWS.find((t) => _matches(t.spec, key, n, "fetch")) || null;
function _removalState(id) {
  const e = C._realmRemovalsSnapshotForTest().find((x) => x.id === id);
  return e ? e.state : null;
}
async function hold(key, n, phase) {
  for (const h of HOLDS) {
    if (!_matches(h.spec, key, n, phase)) continue;
    const u = h.until;
    const ok = () => (typeof u === "string"
      ? answered.has((() => { const p = parseKey(u); return `${p.key}#${p.n}${p.phase === "json" ? ":json" : ""}`; })())
      : !!(u && u.removal && _removalState(u.id || CREATED) === u.removal));
    const deadline = Date.now() + 5000;
    while (!ok()) {
      if (h.fireRetries) { try { C._fireCxOneProvisionRetriesNowForTest(); } catch (_) {} }
      if (Date.now() > deadline) {
        holdLog.push({ call: h.call, until: u, released: false });
        throw new Error(`harness: the hold on ${h.call} was never released`);
      }
      await new Promise((r) => setImmediate(r));
    }
    holdLog.push({ call: h.call, until: u, released: true, atCall: calls.length });
  }
}

const resp = (key, occurrence, status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
  json: async () => {
    await Promise.all(fire(key, occurrence, "json"));
    await hold(key, occurrence, "json");
    answered.add(`${key}#${occurrence}:json`);
    return body;
  },
  text: async () => JSON.stringify(body),
});

const CREATED = S.createdId || "kc-created", PRE = S.matchId || "kc-pre-existing";
// v8.13.1 — true while the `replaceAt` replacement's own job runs: its create
// answers 409 and its search finds the account the original job created.
let replacing = false;
// DELETE answers, consumed in order across every DELETE (the in-flight
// withdrawal first, then the runner's); `delStatus` answers once they run out.
const delQueue = [...(S.delStatuses || [])];
const groupsQueue = [...(S.userGroupsStatuses || [])];
// The runner's step-8 reads past the groups, each a queue (see the header).
const rolesStatusQ = [...(S.rolesStatuses || [])], rolesBodyQ = [...(S.rolesBodies || [])];
const credsStatusQ = [...(S.credsStatuses || [])], credsBodyQ = [...(S.credsBodies || [])];
const profileStatusQ = [...(S.profileStatuses || [])], profileBodyQ = [...(S.profileBodies || [])];
const clientsStatusQ = [...(S.clientsStatuses || [])], clientsBodyQ = [...(S.clientsBodies || [])];
// A pristine account's direct roles: the realm's default role, and nothing else.
const pristineRoles = (realm) => ({ realmMappings: [{ id: `rr-default-${realm}`, name: `default-roles-${String(realm).toLowerCase()}`,
  composite: true, clientRole: false, containerId: realm }] });
const DEFAULT_PROFILE = { attributes: ["username", "email", "firstName", "lastName"].map((name) => ({ name,
  permissions: { view: ["admin", "user"], edit: ["admin", "user"] } })) };
const REALM_MANAGEMENT_VISIBLE = [{ id: "cl-rm", clientId: "realm-management", access: { view: true, configure: false, manage: false } }];
// "beforeDeletion" / "withinMargin" / "afterDeletion" as a credential's
// createdDate, dated INSIDE the windows a wrong anchor gets wrong: "before"
// halfway between the account's creation (`provenance_at`) and the runner's
// clock margin before its deletion (`pending_since` − CREDENTIAL_CLOCK_MARGIN_MS)
// — so an anchor on the creation would count it — "within" halfway through that
// margin — so an anchor on the bare deletion would NOT count it — and "after"
// halfway between the deletion and this read — so an anchor on "now" would not.
// The read waits until it is at least CRED_GAP_MS past the deletion
// (`credsReadable`), so the last window is never empty; the first is the arm's
// to make wide (`backdateCreationMs`) and to assert, from `credsDated` (every
// dated answer's instants).
const CRED_GAP_MS = 4;
const credsDated = [];
function _credTimes(id) {
  const row = db.prepare("SELECT pending_since, provenance_at FROM cxone_realm_accounts WHERE cxone_user_id=?").get(id);
  return { pend: row && row.pending_since ? Date.parse(row.pending_since) : null,
    prov: row && row.provenance_at ? Date.parse(row.provenance_at) : null };
}
async function credsReadable(id) {
  const { pend } = _credTimes(id);
  while (pend !== null && Date.now() < pend + CRED_GAP_MS) await new Promise((r) => setTimeout(r, 1));
}
function datedCreds(body, id) {
  if (!Array.isArray(body)) return body;
  const TOKENS = ["beforeDeletion", "withinMargin", "afterDeletion"];
  const dated = (c) => c && typeof c === "object" && TOKENS.includes(c.createdDate);
  if (!body.some(dated)) return body;
  const { pend, prov } = _credTimes(id);
  const readMs = Date.now();
  const at = pend === null ? readMs : pend;
  const marginMs = W.CREDENTIAL_CLOCK_MARGIN_MS, edge = at - marginMs;
  const before = Math.floor(((prov === null ? edge - 2000 : prov) + edge) / 2);
  const within = Math.floor((edge + at) / 2), after = Math.floor((at + readMs) / 2);
  credsDated.push({ provenanceMs: prov, pendingMs: pend, readMs, marginMs, before, within, after });
  const when = { beforeDeletion: before, withinMargin: within, afterDeletion: after };
  return body.map((c) => (dated(c) ? { ...c, createdDate: when[c.createdDate] } : c));
}
let phase = "provision";
// Who is asking (see the header): a provisioning job, or the runner.
let creating = 0;
const isCreating = () => creating > 0 || C.cxOneInflight() > 0;
async function provisionJob(u, comp) {
  creating++;
  try { return await cxOneProvisionUser(u, comp); } finally { creating--; }
}
// An id in a `/users/<id>` path is keyed as `<id>`, so a scenario can name the
// runner's calls ("GET /users/<id>") whatever the account's id is — except the
// realm's user profile, which is not an account.
function keyOf(rec) {
  const bare = rec.path.split("?")[0];
  const p0 = bare === "/users/profile" ? bare : bare.replace(/^\/users\/[^/]+(?=\/|$)/, "/users/<id>");
  const key = rec.path.endsWith("/protocol/openid-connect/token") ? "TOKEN"
    : (rec.method === "PUT" && /\/users\/[^/]+\/groups\//.test(rec.path)) ? "PUT grant"
    : `${rec.method} ${p0}`;
  return { key, n: (seen[key] = (seen[key] || 0) + 1) };
}
const idOf = (rec) => decodeURIComponent((/^\/users\/([^/?]+)/.exec(rec.path) || [])[1] || "");

// The realm model (`realm: true`).
const RECREATED = "7c9e6679-7425-40de-944b-e07fc1f90ae7", THIRD = "9b2d6f1e-3c4a-4d5e-8f60-718293a4b5c6";
const REALM = S.realm ? { accounts: new Map(), gone: new Set(), ids: null, extra: 0 } : null;
const _eqi = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const realmLive = (id) => !!(REALM && REALM.accounts.has(id) && !REALM.gone.has(id));
const realmFind = (pred) => [...REALM.accounts.values()].filter((a) => !REALM.gone.has(a.id) && pred(a));
function realmAnswer(rec, key, r) {
  if (key === "POST /users") {
    const b = rec.body || {};
    if (realmFind((a) => _eqi(a.username, b.username) || _eqi(a.email, b.email)).length) return r(409, {});
    if (!REALM.ids) REALM.ids = [...(S.realmIds || [CREATED, RECREATED, THIRD])];
    const id = REALM.ids.length ? REALM.ids.shift() : `kc-extra-${++REALM.extra}`;
    REALM.accounts.set(id, { id, username: b.username, email: b.email, firstName: b.firstName, lastName: b.lastName, createdTimestamp: Date.now() });
    return r(201, {}, { Location: `https://iam.checkmarx.net/auth/admin/realms/tenant1/users/${id}` });
  }
  if (key === "GET /users") {
    const q = new URLSearchParams(rec.path.split("?")[1] || "");
    const found = q.has("username") ? realmFind((a) => _eqi(a.username, q.get("username"))) : realmFind((a) => _eqi(a.email, q.get("email")));
    return r(200, found.map((a) => ({ id: a.id, username: a.username, email: a.email })));
  }
  if (key === "GET /users/<id>" && S.getUser === undefined) {
    const a = realmLive(idOf(rec)) ? REALM.accounts.get(idOf(rec)) : null;
    if (!a) return r(404, {});
    return r(200, { id: a.id, username: a.username, email: a.email, firstName: a.firstName, lastName: a.lastName,
      createdTimestamp: a.createdTimestamp, ...(REP.federationLink ? { federationLink: REP.federationLink } : {}),
      ...(isCreating() ? (S.createAttributes ? { attributes: S.createAttributes } : {}) : (REP.attributes !== undefined ? { attributes: REP.attributes } : {})) });
  }
  if (key === "PUT grant") return realmLive(idOf(rec)) ? r(S.assign || 204, {}) : r(404, {});
  if (key === "DELETE /users/<id>") {
    const ds = delQueue.length ? delQueue.shift() : (S.delStatus || 204);
    if ((ds >= 200 && ds < 300) || ds === 404) REALM.gone.add(idOf(rec));
    return r(ds, {});
  }
  return null;
}

handler = (rec, key, n) => {
  const r = (status, body, headers) => resp(key, n, status, body, headers);
  if (REALM) { const a = realmAnswer(rec, key, r); if (a) return a; }
  if (key === "TOKEN") return phase === "withdraw" && S.tokenStatus ? r(S.tokenStatus, {}) : r(200, { access_token: "tok" });
  if (key === "POST /users") {
    if (replacing || (S.create || 201) === 409) return r(409, {});
    return r(S.createStatus || 201, {}, S.noLocation ? {} : { Location: `https://iam.checkmarx.net/auth/admin/realms/tenant1/users/${CREATED}` });
  }
  if (key === "GET /users") {
    const s = S.search || "match";
    // After a 201 with no Location the search finds the account we just made.
    const matchId = (S.noLocation || replacing) ? CREATED : PRE;
    if (replacing) return r(200, [{ id: CREATED, username: "erin", email: EMAIL }]);
    if (s === "match") return r(200, [{ id: matchId, username: current.nickname, email: current.email }]);
    if (s === "conflict") return rec.path.includes("username=")
      ? r(200, [{ id: "kc-someone-else", username: current.nickname, email: "someone.else@other.test" }]) : r(200, []);
    return r(200, []);
  }
  if (key === "GET /groups") return S.groups === 500 ? r(500, {}) : r(200, [
    { id: "g-1", name: "hackers" }, { id: "g-global", name: "GLOBAL-DEFAULT-GROUP" }]);
  if (key === "PUT grant") return r(S.assign || 204, {});
  // v8.12.7 — the withdrawal runner's reads. `getUser` is one status for every
  // realm, or a map keyed by the realm segment (an unlisted realm answers 404).
  if (key === "GET /users/<id>" && isCreating()) {
    // The creation-baseline read: the account as the create just made it.
    const g = S.getUserAtCreate ?? 200;
    return g >= 200 && g < 300 ? r(g, { id: idOf(rec), username: "erin", email: EMAIL, firstName: "Erin", lastName: "Erased",
      createdTimestamp: Date.now(), ...(S.createAttributes ? { attributes: S.createAttributes } : {}) }) : r(g, {});
  }
  if (key === "GET /users/<id>") {
    const g = S.getUser === undefined ? 200
      : (typeof S.getUser === "object" ? (S.getUser[rec.realm] ?? 404) : S.getUser);
    return g >= 200 && g < 300 ? r(g, repBody()) : r(g, {});
  }
  if (key === "GET /users/<id>/role-mappings") {
    if (isCreating()) {
      const st = S.rolesAtCreateStatus ?? 200;
      return r(st, st >= 200 && st < 300 ? (S.rolesAtCreate ?? pristineRoles(rec.realm)) : {});
    }
    const st = rolesStatusQ.length ? rolesStatusQ.shift() : (S.rolesStatus ?? 200);
    const body = rolesBodyQ.length ? rolesBodyQ.shift() : (S.roles ?? pristineRoles(rec.realm));
    return r(st, st >= 200 && st < 300 ? body : {});
  }
  if (key === "GET /users/<id>/credentials") {
    const st = credsStatusQ.length ? credsStatusQ.shift() : (S.credsStatus ?? 200);
    const body = credsBodyQ.length ? credsBodyQ.shift() : (S.creds ?? []);
    return r(st, st >= 200 && st < 300 ? datedCreds(body, idOf(rec)) : {});
  }
  if (key === "GET /users/profile") {
    const st = profileStatusQ.length ? profileStatusQ.shift() : (S.profileStatus ?? 200);
    const body = profileBodyQ.length ? profileBodyQ.shift() : (S.profile ?? DEFAULT_PROFILE);
    return r(st, st >= 200 && st < 300 ? body : {});
  }
  if (key === "GET /clients") {
    const st = clientsStatusQ.length ? clientsStatusQ.shift() : (S.clientsStatus ?? 200);
    const body = clientsBodyQ.length ? clientsBodyQ.shift() : (S.clients ?? REALM_MANAGEMENT_VISIBLE);
    return r(st, st >= 200 && st < 300 ? body : {});
  }
  if (key === "GET /users/<id>/federated-identity") return r(S.fedStatus || 200, S.fed || []);
  // v8.12.7 (review) — the account's group memberships, and the realm's default
  // groups the runner asks for only when a membership looks foreign.
  if (key === "GET /users/<id>/groups") {
    const gs = groupsQueue.length ? groupsQueue.shift() : (S.userGroupsStatus || 200);
    return r(gs, gs >= 200 && gs < 300 ? (S.userGroups || []) : {});
  }
  if (key === "GET /default-groups") {
    const ds = S.defaultGroupsStatus || 200;
    return r(ds, ds >= 200 && ds < 300 ? (S.defaultGroups || []) : {});
  }
  if (key === "DELETE /users/<id>") {
    const ds = delQueue.length ? delQueue.shift() : (S.delStatus || 204);
    return r(ds, S.delBody === "rep" && ds >= 400 ? repBody() : {});
  }
  return r(500, {});
};

// The realm's own record of the account, as the runner's GET reads it.
// `createdTimestamp`: "now" (the real clock at the read, i.e. matching the
// row's provenance), "old" (a day earlier), null (absent), or a number.
const REP = { createdTimestamp: "now", username: "erin", email: EMAIL, firstName: "Erin", lastName: "Erased",
  federationLink: null, ...(S.rep || {}) };
function repBody() {
  const o = { id: CREATED, username: REP.username, email: REP.email, firstName: REP.firstName, lastName: REP.lastName };
  const ct = REP.createdTimestamp;
  if (ct === "now") o.createdTimestamp = Date.now();
  else if (ct === "old") o.createdTimestamp = Date.now() - 24 * 60 * 60 * 1000;
  else if (ct !== null) o.createdTimestamp = ct;
  if (REP.federationLink) o.federationLink = REP.federationLink;
  for (const k of ["attributes", "enabled", "requiredActions", "emailVerified", "totp"]) if (REP[k] !== undefined) o[k] = REP[k];
  for (const k of ["username", "email", "firstName", "lastName"]) if (o[k] === null) delete o[k];
  return o;
}

// 5. The scenario.
// v8.12.7 — after provisioning, `steps` run in order, each logged with the
// range of `calls` it made ({step, from, to, result}):
//   "cascade"        the real deleteUserCascade(u-1), then wait for the runner
//   "sqlDeleteUser"  DELETE FROM users by hand — an absence, not a deletion
//   "backfill"       backfillFromHistory, as the sweeper runs it at boot
//   "kick"           scheduleRealmWithdrawal()
//   {run: <hours>}   one runWithdrawals pass with the clock shifted that far
//   {retry: <id>, override: bool} / {dismiss: <id>}   the superadmin's actions
//   "list" / "counts"                                 the superadmin's views
//   {list: <hours>} / {counts: <hours>}               the same, read that far ahead
//   "snapshot"       the ledger and the participant's binding at that moment
//   {provision: <userId>, comp}   provision ANOTHER (planted, enrolled)
//                    participant — the search answers with their name and
//                    address; returns their binding
//   {setGlobalKey: <realm>}       configure the global default key now
//   {plantUser: {...}}            plant a person now (the plantUsers shape)
// Every step, and the final print, waits for an in-flight run to finish.
const shifted = (h) => () => new Date(Date.now() + h * 60 * 60 * 1000);
const STEPS = {
  // `callsDuringCascade`: the remote calls made INSIDE the cascade call itself,
  // i.e. synchronously within the request that deleted the participant.
  cascade: () => {
    const before = calls.length, scans = binderScans;
    const r = deleteUserCascade(UID);
    return { ...r, callsDuringCascade: calls.length - before, scansDuringCascade: binderScans - scans };
  },
  sqlDeleteUser: () => db.prepare("DELETE FROM users WHERE id=?").run(UID).changes,
  backfill: () => backfillFromHistory(db, { nowIso: new Date().toISOString() }),
  kick: () => !!W.scheduleRealmWithdrawal(),
  run: (st) => W.runWithdrawals({ now: shifted(st.run) }),
  // v8.13.1 — an override names the hold the superadmin read. `expectedHold`
  // states it; omitted, it is the hold the row carries at this moment (the
  // superadmin read the list just now), so every pre-v8.13.1 arm keeps meaning
  // what it meant. `expectedHold: null` sends none, to drive the refusal.
  retry: (st) => {
    const id = st.retry === true ? CREATED : st.retry;
    const now = db.prepare("SELECT held_reason, held_signal FROM cxone_realm_accounts WHERE cxone_user_id=?").get(id);
    const expectedHold = "expectedHold" in st ? (st.expectedHold === null ? undefined : st.expectedHold)
      : (st.override ? (now ? now.held_reason : undefined) : undefined);
    const expectedSignal = "expectedSignal" in st ? (st.expectedSignal === null ? undefined : st.expectedSignal)
      : (st.override && now && now.held_signal ? now.held_signal : undefined);
    return W.retryCxOneWithdrawal(id, { override: !!st.override, expectedHold, expectedSignal, actorId: "sa-harness" });
  },
  dismiss: (st) => W.dismissCxOneWithdrawal(st.dismiss === true ? CREATED : st.dismiss),
  snapshot: () => ({
    ledger: db.prepare("SELECT * FROM cxone_realm_accounts ORDER BY cxone_user_id").all(),
    binding: db.prepare("SELECT cxone_username, cxone_user_id FROM competition_users WHERE user_id=? AND competition_id=?").get(UID, CID) || null,
    // Everyone else's event bindings at this moment (a replacement's, a binder's).
    others: db.prepare("SELECT user_id, competition_id, cxone_username, cxone_user_id FROM competition_users WHERE user_id <> ? ORDER BY user_id, competition_id").all(UID),
  }),
  provision: async (st) => {
    current = db.prepare("SELECT * FROM users WHERE id=?").get(st.provision);
    await provisionJob(current, st.comp || CID);
    return db.prepare("SELECT cxone_username, cxone_user_id FROM competition_users WHERE user_id=? AND competition_id=?")
      .get(st.provision, st.comp || CID) || null;
  },
  setGlobalKey: (st) => { setSetting("default_cxone_api_key", KEYS[st.setGlobalKey]); return true; },
  plantUser: (st) => { plantUser(st.plantUser); return true; },
  // A removal in progress, and the deferred set-ups waiting on it.
  retries: async () => { const n = C._fireCxOneProvisionRetriesNowForTest(); await C.cxOneQueueIdle(); return n; },
  stopRetries: async () => { const n = C.stopCxOneProvisionRetries(); await C.cxOneQueueIdle(); return n; },
  queue: async () => { await C.cxOneQueueIdle(); return true; },
  resume: async () => { const n = C.resumeDeferredCxOneProvisioning(); await C.cxOneQueueIdle(); return n; },
  ageRemovals: (st) => C._ageRealmRemovalsForTest(st.ageRemovals),
  rereads: async () => { const armed = W._armedRereadsForTest(); const fired = W._fireArmedRereadsForTest(); await W.cxOneWithdrawalsIdle(); return { armed, fired }; },
  reassign: async (st) => {
    const u = db.prepare("SELECT id, nickname, first_name, last_name, email FROM users WHERE id=?").get(st.reassign);
    // `after`: something that queues a job for them, done first WITHOUT waiting
    // for it — so the re-assign lands while that job is queued or running.
    let first = null;
    if (st.after === "retries") first = C._fireCxOneProvisionRetriesNowForTest();
    else if (st.after === "resume") first = C.resumeDeferredCxOneProvisioning();
    else if (st.after === "reassign") first = C.requeueDeferredCxOneProvision(u, st.comp || CID, "assign_after_deferral");
    const r = C.requeueDeferredCxOneProvision(u, st.comp || CID, "assign_after_deferral");
    await C.cxOneQueueIdle();
    return st.after ? { first, r } : r;
  },
  // The real cascade of ANOTHER person (the replacement, say) now.
  erase: (st) => deleteUserCascade(st.erase),
  // The boot's resume on a health gate this harness controls: start it with the
  // gate at `resumeWhenHealthy`, flip it with `resumeHealth`, run the waiting
  // check with "resumeCheck" (null while unhealthy; undefined when none waits).
  resumeWhenHealthy: async (st) => { resumeHealthy = !!st.resumeWhenHealthy; const n = C.startCxOneProvisionResume({ isHealthy: () => resumeHealthy }); await C.cxOneQueueIdle(); return n; },
  resumeHealth: (st) => { resumeHealthy = !!st.resumeHealth; return resumeHealthy; },
  resumeCheck: async () => { const n = C._checkCxOneProvisionResumeNowForTest(); await C.cxOneQueueIdle(); return n === undefined ? "none_waiting" : n; },
  // The registry's eviction: one announced and one unanswered removal, then more
  // settled tombstones than its cap — what is still remembered.
  evictionProbe: () => {
    C.beginRealmRemoval("probe-in-flight", null);
    C.beginRealmRemoval("probe-unknown", null); C.settleRealmRemoval("probe-unknown", "unknown");
    const N = C.REALM_REMOVALS_MAX + 5;
    for (let i = 0; i < N; i++) { C.beginRealmRemoval(`probe-t-${i}`, null); C.settleRealmRemoval(`probe-t-${i}`, "removed"); }
    return { max: C.REALM_REMOVALS_MAX, size: C._realmRemovalsSnapshotForTest().length,
      inFlight: C.realmRemovalBlock("probe-in-flight"), unknown: C.realmRemovalBlock("probe-unknown"),
      oldest: C.realmRemovalBlock("probe-t-0"), sixth: C.realmRemovalBlock("probe-t-6"), newest: C.realmRemovalBlock(`probe-t-${N - 1}`) };
  },
  wait: async (st) => { await new Promise((r) => setTimeout(r, st.wait)); await C.cxOneQueueIdle(); return true; },
  pending: () => C._provisionRetriesSnapshotForTest(),
  list: (st) => W.listCxOneWithdrawals(st && typeof st === "object" ? { nowIso: shifted(st.list)().toISOString() } : {}),
  counts: (st) => W.cxOneWithdrawalCounts(st && typeof st === "object" ? { nowIso: shifted(st.counts)().toISOString() } : {}),
};
const stepLog = [];
let resumeHealthy = false;
(async () => {
  if (S.deleteBefore) deleteUserCascade(UID);
  if (S.deleteCompBefore) ACTIONS.deleteComp();
  if (S.removeMembershipBefore) ACTIONS.removeMembership();
  if (S.disableBefore) ACTIONS.disableCxone();
  if (!S.noProvision) await provisionJob(user, S.globalOnly ? null : CID);
  await Promise.all(_concurrent);
  await W.cxOneWithdrawalsIdle();
  phase = "withdraw";
  if (S.waitBeforeSteps) await new Promise((r) => setTimeout(r, S.waitBeforeSteps));
  if (S.backdateCreationMs) {
    const row = db.prepare("SELECT provenance_at FROM cxone_realm_accounts WHERE cxone_user_id=?").get(CREATED);
    if (!row) refuse("backdateCreationMs: no ledger row for the created account");
    const at = Date.parse(row.provenance_at) - S.backdateCreationMs;
    db.prepare("UPDATE cxone_realm_accounts SET provenance_at=? WHERE cxone_user_id=?").run(new Date(at).toISOString(), CREATED);
    if (REALM && REALM.accounts.has(CREATED)) REALM.accounts.get(CREATED).createdTimestamp = at;
    else REP.createdTimestamp = at;
  }
  const provisionCalls = calls.length;
  for (const st of S.steps || []) {
    const name = typeof st === "string" ? st : Object.keys(STEPS).find(k => k in st);
    if (!STEPS[name]) throw new Error(`unknown step ${JSON.stringify(st)}`);
    await W.cxOneWithdrawalsIdle();
    const from = calls.length, scans0 = binderScans;
    const result = await STEPS[name](st);
    await W.cxOneWithdrawalsIdle(); await C.cxOneQueueIdle(); await W.cxOneWithdrawalsIdle();
    stepLog.push({ step: name, from, to: calls.length, scans: binderScans - scans0, result: result === undefined ? null : result });
  }
  await Promise.all(_concurrent);
  await W.cxOneWithdrawalsIdle(); await C.cxOneQueueIdle(); await W.cxOneWithdrawalsIdle();
  const alive = !!db.prepare("SELECT 1 FROM users WHERE id=?").get(UID);
  const member = !!db.prepare("SELECT 1 FROM competition_users WHERE user_id=? AND competition_id=?").get(UID, CID);
  const binding = db.prepare("SELECT cxone_username, cxone_user_id FROM competition_users WHERE user_id=? AND competition_id=?").get(UID, CID) || null;
  // A row planted unreadable (`detailsRaw`) is reported as its text, never parsed.
  const parsed = (t, empty) => { try { return JSON.parse(t || empty); } catch (_) { return { unreadable_details: t }; } };
  const events = db.prepare("SELECT event_type, details FROM user_events WHERE user_id=? ORDER BY rowid").all(UID)
    .map(e => ({ type: e.event_type, details: parsed(e.details, "null") }));
  const people = {};
  for (const { id } of db.prepare("SELECT id FROM users WHERE id <> ? ORDER BY id").all(UID)) {
    people[id] = {
      bindings: db.prepare("SELECT competition_id, cxone_username, cxone_user_id FROM competition_users WHERE user_id=? ORDER BY competition_id").all(id),
      events: db.prepare("SELECT event_type, details FROM user_events WHERE user_id=? AND event_type LIKE 'cxone%' ORDER BY rowid").all(id)
        .map(e => ({ type: e.event_type, details: parsed(e.details, "null") })),
    };
  }
  const ledger = db.prepare("SELECT * FROM cxone_realm_accounts ORDER BY cxone_user_id").all();
  out({ calls, callsFull, provisionCalls, stepLog, fired, alive, member, binding, events, ledger, ledgerAtFire,
    unc: cxOneCreateUnconfirmedCounts(), totals: W.cxOneWithdrawalTotals(), list: W.listCxOneWithdrawals(),
    email: EMAIL, logDir: path.join(process.env.DATA_DIR, "logs"), listReadFailures, credsDated,
    retentionDays: require(path.join(ROOT, "lib", "event-retention.js")).EVENT_RETENTION_DAYS,
    people, replacement: people[S.replaceUser || "u-2"] || null, posts, holdLog, concurrentErrors,
    removals: C._realmRemovalsSnapshotForTest(), retries: C._provisionRetriesSnapshotForTest(),
    retriesPending: C.cxOneProvisionRetriesPending(), deferredCounts: C.cxOneProvisionDeferredCounts(),
    binderOfCreated: ((b) => (b === BINDING_UNREADABLE ? "binding_unreadable" : b))(livingBinder(db, CREATED)),
    // Every cxone_* History row in the database, whoever it names — including a
    // user no longer there (a row for an erased person is a resurrection).
    dbEvents: db.prepare("SELECT user_id, event_type, details FROM user_events WHERE event_type LIKE 'cxone%' ORDER BY rowid").all()
      .map(e => ({ userId: e.user_id, type: e.event_type, ...parsed(e.details, "{}") })) });
  // 6. NATURAL exit — see the header.
})().catch(e => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
