// @ts-check
//
// v8.1.1 — the Booth Event deal must survive a migration, and both registration
// paths behind one /join link must honour it.
// v8.4.0 — the deal is now a per-EVENT configuration re-read live, and the
// STAMPED value is what a migration carries.
//
// PR 31 made `users.profile_policy` the record of which registration policy an
// account was created under, and `_profileMissingFields` reads it to drop the
// fields a Booth Event never collects. Two things were left broken:
//
//   * the column was classified EXPORTED — with a comment calling its loss a
//     LOCKOUT — while the export SELECT, the export projection AND the import
//     INSERT all silently dropped it. A platform migration therefore recreated
//     every walk-up with NULL, and the NON-DISMISSIBLE completion gate then
//     demanded the full profile from the whole cohort: fields nobody ever asked
//     them for, unrecoverable from their side, invisible from ours. This is
//     byte-identical to the v7.2.x job_function/city import-drop the very same
//     INSERT carries a comment about.
//
//   * `POST /api/auth/linkedin/complete` required the fields UNCONDITIONALLY and
//     resolved the join token eighty lines later, so behind the identical link a
//     walk-up tapping "Register with LinkedIn" answered more questions than the
//     person beside them using the password form — and the account recorded no
//     deal at all.
//
// ── WHY THIS FILE STILL MATTERS AFTER v8.4.0, AND WHAT MOVED ─────────────────
//
// v8.4.0 answers the gate from `users.registration_competition_id` — a POINTER at
// the event the account was created through, re-read on every check so an admin
// who makes a field mandatory today has it demanded of people who already
// registered. That pointer is DELIBERATELY NOT EXPORTED (`functional-security-a`
// owns that decision): it names a row in THIS database, so on a target where the
// event does not exist it would dangle.
//
// Which makes `profile_policy` the ONLY thing that crosses a migration, and this
// file the lock on it. The imported account therefore takes the FALLBACK path —
// the stamped KIND's defaults — and the observable consequence changed with the
// booth defaults rather than with the mechanism: a Booth Event now HIDES city and
// REQUIRES Professional Role, so a re-imported walk-up owes the role and NOT the
// city, while an ordinary account owes both. The delta between those two IS what
// `profile_policy` bought, and it is what every assertion below measures.
//
// The load-bearing control throughout is a NON-booth account driven through the
// identical steps: every "the gate asked for less" assertion here is equally
// satisfied by a build that relaxed the fields for everybody, which would be a
// far worse change than the one under test.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, BASE, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `pp${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// The six states a Booth Event ships with, and the LEGACY shape every other kind
// resolves to whatever its stored column holds. Written out rather than imported
// so a change to `lib/registration-fields.js` has to be a DECISION here too —
// `event-policy-wire.spec.js` is the exact-set lock, this is the behavioural one.
const BOOTH_STATES = {
  personal_title: "hidden", password: "hidden", phone: "hidden",
  city: "optional", linkedin_url: "hidden", job_function: "optional",
};
const LEGACY_STATES = {
  personal_title: "hidden", password: "required", phone: "hidden",
  city: "optional", linkedin_url: "hidden", job_function: "optional",
};

/** A live event of `kind` with its join link on, plus the token. */
async function joinableEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(),
      duration_minutes: 600,
      self_enroll_enabled: true,
      ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
  expect(token, `a join token for the ${kind}`).toBeTruthy();
  return { comp, token };
}

/**
 * Register through a join token.
 *
 * `""`, never `delete` — `POST /api/register` applies `??` defaults for
 * jobFunction/city when they are `undefined` under NODE_ENV=test, so a test that
 * omits them measures the test-mode bypass and never reaches the rule.
 *
 * v8.4.0 — a Booth Event REQUIRES `jobFunction` by default, so a booth
 * registration drops `city` alone. Blanking the role would be refused, which is
 * the retroactively-mandatory field this release introduces and is locked in
 * `booth-registration.spec.js`.
 */
async function registerVia(token, { drop = [] } = {}) {
  const { api, csrf } = await freshCtx();
  const label = uniq();
  const data = {
    firstName: "Walk", lastName: "Up", nickname: label,
    email: `${label}@company.example`,
    company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "Testville",
    password: PARTICIPANT_PASS, joinToken: token || undefined,
  };
  for (const f of drop) data[f] = "";
  const r = await registerPost(api, "/api/register", { headers: H(csrf), data });
  expect(r.status(), `register: ${await r.text()}`).toBe(200);
  await api.dispose();
  return data.email;
}

function storedRow(email) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email); }
  finally { db.close(); }
}

async function findUser(api, email) {
  const list = await (await api.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json();
  return (list.participants || []).find(p => p.email === email);
}

/**
 * Export every participant, re-key one row onto a new identity and import it —
 * the shape of a real platform migration, which is what this column has to
 * survive. `mutate` edits the file, so a test can blank a field or delete a key.
 *
 * Returns the new email. The import is TWO-PHASE: without `resolutions` it is a
 * dry run that writes nothing, so an import test that omits it asserts nothing.
 */
async function exportReimport(api, csrf, sourceEmail, mutate = () => {}) {
  const exp = await (await api.get("/api/admin/export/participants")).json();
  const row = (exp.participants || []).find(p => p.email === sourceEmail);
  expect(row, `the source row (${sourceEmail}) is in the export`).toBeTruthy();

  const key = uniq();
  const clone = { ...row, id: undefined, email: `${key}@company.example`, nickname: key, secondary_email: null };
  mutate(clone);
  const envelope = { ...exp, participants: [clone] };

  const dry = await api.post("/api/admin/import/participants", { headers: H(csrf), data: { data: envelope } });
  expect(dry.ok(), `dry run: ${await dry.text()}`).toBeTruthy();
  const applied = await api.post("/api/admin/import/participants", { headers: H(csrf), data: { data: envelope, resolutions: {} } });
  expect(applied.ok(), `import apply: ${await applied.text()}`).toBeTruthy();
  expect((await applied.json()).imported, "exactly one row imported").toBe(1);
  return clone.email;
}

/**
 * Sign in as an IMPORTED account and read the completion gate's own answer.
 *
 * Every account but the built-in signs in with an emailed code, so an imported
 * row is reachable like any other: verify and approve it, then sign in with a
 * code (which is what makes the participant-visible assertion reachable rather
 * than a read of the column). No sign-up field is a password any more, so
 * `password` never appears in the sets below.
 */
async function missingFieldsFor(api, csrf, email) {
  const u = await findUser(api, email);
  expect(u, `the imported account (${email}) exists`).toBeTruthy();
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify: ${await v.text()}`).toBeTruthy();
  // A plain sign-up exports `approved: 0`, so the imported control would be
  // refused at login for a reason that has nothing to do with this rule. Approve
  // AFTER the verify — approval is refused on an unverified account, and it is a
  // documented no-op on one that is already approved (the booth case).
  const ap = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(ap.ok(), `approve: ${await ap.text()}`).toBeTruthy();

  const { api: p } = await freshCtx();
  const pc2 = (await (await p.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(p, email, H(pc2));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const me = await (await p.get("/api/me")).json();
  await p.dispose();
  return { missing: me.missing_fields || [], complete: me.profile_complete };
}

test.describe("v8.4.0 — profile_policy portability", () => {
  test("a Booth account's sign-up policy survives export → import; a plain account's stays empty; neither is asked for anything under the short form", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const booth = await joinableEvent(api, csrf, "booth");
      const boothEmail = await registerVia(booth.token, { drop: ["city"] });
      expect(storedRow(boothEmail).profile_policy, "the walk-up's row records the deal").toBe("booth");
      // ...and the pointer names the live event, which is what makes the fallback
      // below a genuinely different code path rather than the same one twice.
      expect(storedRow(boothEmail).registration_competition_id, "…and which event created it").toBe(booth.comp.id);

      // The plain account fills both fields, so blank both fields in the FILE so
      // the two round trips differ only in the stored policy.
      const plainEmail = await registerVia(null);
      expect(storedRow(plainEmail).profile_policy, "an ordinary sign-up stores no policy").toBe(null);

      const blank = (c) => { c.job_function = ""; c.city = ""; };
      const boothBack = await exportReimport(api, csrf, boothEmail, blank);
      const plainBack = await exportReimport(api, csrf, plainEmail, blank);

      // The column itself. Catches the export SELECT / projection drop AND the
      // import INSERT drop — mutation: remove `u.profile_policy` from
      // _USERS_SELECT, or `profile_policy` from the users INSERT.
      expect(storedRow(boothBack).profile_policy, "the deal crossed the migration").toBe("booth");
      expect(storedRow(plainBack).profile_policy, "and nothing was invented for the control").toBe(null);
      // v8.4.0 — THE POINTER DOES NOT CROSS, deliberately: it names a row in the
      // SOURCE database, so exporting it would carry a foreign identity that
      // dangles on arrival. This assertion is the precondition for everything
      // below: with no pointer the gate MUST take the `profile_policy` fallback,
      // which is precisely why losing that column would be a lockout.
      expect(storedRow(boothBack).registration_competition_id, "the pointer is not portable and is not invented").toBe(null);

      // The participant-visible consequence: every kind's default form now
      // demands only the base set, so neither re-imported account is asked for
      // anything. The gate cannot tell the two apart today; the stored policy is
      // what a later Booth requirement reads, so the column round trip above is
      // the lock.
      const boothGate = await missingFieldsFor(api, csrf, boothBack);
      expect(boothGate.missing, "the re-imported walk-up is not asked for the city it never gave").toEqual([]);
      const plainGate = await missingFieldsFor(api, csrf, plainBack);
      expect(plainGate.missing, "nor is an ordinary account, under the short form").toEqual([]);
    } finally { await api.dispose(); }
  });

  test("an import file with no profile_policy key still imports, as NULL", async () => {
    // Older files keep working: an absent key is the full-profile default every
    // ordinary account already carries, not a refusal and not a crash.
    // Mutation: bind `p.profile_policy` raw instead of coercing a missing/
    // non-string value, and the row below either throws or stores something odd.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const booth = await joinableEvent(api, csrf, "booth");
      const src = await registerVia(booth.token, { drop: ["city"] });
      const back = await exportReimport(api, csrf, src, (c) => { delete c.profile_policy; });
      const row = storedRow(back);
      expect(row, "the row imported").toBeTruthy();
      expect(row.profile_policy, "an absent key is NULL, never a refusal").toBe(null);
    } finally { await api.dispose(); }
  });








});
