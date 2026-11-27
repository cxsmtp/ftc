// v8.4.0 — A BOOTH EVENT CONFIGURES ITS OWN SIGN-UP FORM, AND THE ANSWER IS READ
// LIVE.
//
// Six fields (Salutation, Password, Phone, City, LinkedIn URL, Professional
// Role), three states each: required / optional / hidden. The states are stored
// per EVENT, and — this is the part that reverses a previous design decision —
// the profile-completion gate re-reads them rather than honouring a snapshot
// stamped at registration. So an admin who makes a field mandatory has it
// demanded of people who ALREADY registered, immediately, even once the event
// has ended.
//
// WHAT EVERY TEST HERE HAS TO GUARD AGAINST, because each headline assertion has
// a build that satisfies it for the wrong reason:
//
//   * "the booth accepted a blank Phone" is equally true of a build that dropped
//     the requirement for EVERY registration. Every relaxation arm therefore runs
//     beside a Competition arm and/or a no-token arm.
//   * "the gate now asks for Phone" is equally true of a build that asks everyone
//     for everything. Each retroactivity arm asserts the missing set EXACTLY, and
//     a participant registered through a DIFFERENT event is checked in the same
//     test and must be unaffected.
//   * "the field is not demanded" is equally true of a gate that demands nothing.
//     The required arms are what stop that, and they run over the same fixture.
//   * "changing the matrix worked" is equally true of a build that ignores the
//     stored value and always answers with the kind's defaults. The
//     configured-vs-default arms are distinct throughout.
//
// TWO TRAPS THIS SPEC IS BUILT AROUND.
//
//   1. Under `NODE_ENV=test`, `POST /api/register` applies `??` defaults for
//      `jobFunction`, `city` and `password` so that specs predating those fields
//      keep passing. An OMITTED field is therefore not absent by the time the
//      handler validates it. Every "leave it blank" here sends `""`, which is
//      what the browser form actually sends and what the `??` default cannot
//      catch.
//   2. `_profileMissingFields` reads the registration event's CURRENT row, so an
//      in-process call needs the JOIN. `PROFILE_GATE_COLUMNS` / `PROFILE_GATE_JOIN`
//      exist for exactly that; the function throws rather than guessing, which is
//      what stops a forgotten join silently answering with the stamped defaults.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const { REGISTRATION_FIELD_KEYS, BOOTH_DEFAULT_STATES, LEGACY_STATES } = require("../lib/registration-fields");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `rf${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A live, joinable event of `kind`, plus its token. `fields` seeds the matrix. */
async function joinableEvent(api, csrf, kind, extra = {}) {
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

/** Change one event's matrix, honouring optimistic concurrency. */
async function setFields(api, csrf, compId, registration_fields, more = {}) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const cur = (list.competitions || list).find(c => c.id === compId);
  expect(cur, "the competition is in the admin list").toBeTruthy();
  const r = await api.put(`/api/admin/competitions/${compId}`, {
    headers: H(csrf),
    data: { expectedUpdatedAt: cur.updated_at, ...(registration_fields ? { registration_fields } : {}), ...more },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** The RESOLVED states an event currently publishes, read off the admin list. */
async function wireStates(api, compId) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const c = (list.competitions || list).find(x => x.id === compId);
  return c && c.policy ? c.policy.registration_fields : null;
}

/**
 * Register through a join token with `blank` naming the fields to leave EMPTY.
 * Everything is sent as `""` rather than omitted — see trap 1 in the header.
 */
async function register(token, { blank = [], email, overrides = {} } = {}) {
  const { api, csrf } = await freshCtx();
  const label = uniq();
  const data = {
    firstName: "Walk", lastName: "Up", nickname: label,
    email: email || `${label}@company.example`,
    company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "Testville",
    personalTitle: "Dr.", phone: "+1 555 0100", linkedinUrl: "https://www.linkedin.com/in/walkup",
    password: PARTICIPANT_PASS,
    ...(token ? { joinToken: token } : {}),
    ...overrides,
  };
  for (const f of blank) data[f] = "";
  const r = await registerPost(api, "/api/register", { headers: H(csrf), data });
  return { status: r.status(), body: await r.json().catch(() => ({})), email: data.email, nickname: label, api, csrf };
}

/** Sign in and read the gate's own answer. */
async function gateFor(email, password = PARTICIPANT_PASS) {
  const { api, csrf } = await freshCtx();
  const li = await codeLogin(api, email, H(csrf), { password: password });
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const loginBody = await li.json();
  const me = await (await api.get("/api/me")).json();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken, me, loginMissing: loginBody.missing_fields || [] };
}

/**
 * A competition's audit events.
 *
 * The endpoint answers a BARE ARRAY unless `paginated` is asked for, and
 * `_parseEventRows` has already JSON.parse'd `details` — reading `ev.events`
 * off the unpaginated shape silently yields `undefined`, which then reads as
 * "nothing was recorded" rather than as a wrong call.
 */
async function compEvents(api, compId) {
  const r = await api.get(`/api/admin/competitions/${compId}/events`);
  expect(r.ok(), `events for ${compId}: ${r.status()}`).toBeTruthy();
  const body = await r.json();
  return Array.isArray(body) ? body : (body.events || []);
}

function dbRow(sql, ...args) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}
function dbRun(sql, ...args) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
}
/** Plant a stored matrix as an older version wrote it, then outwait the 1 s event cache. */
async function plantPolicy(compId, json) {
  dbRun("UPDATE competitions SET registration_field_policy=? WHERE id=?", json, compId);
  await new Promise(r => setTimeout(r, 1100));
}
// What a stored matrix looked like while the sign-up form still had a password row.
const LEGACY_BLOB = (o = {}) => JSON.stringify({ personal_title: "hidden", password: "optional", phone: "required", city: "optional", linkedin_url: "hidden", job_function: "optional", ...o });

// The REQUEST-BODY key each configurable field arrives under, and the `users`
// column it lands in. One table, so a loop can drive all six without a per-field
// branch — and so a field added later is one row here rather than six edits.
const FIELD_META = {
  personal_title: { body: "personalTitle", column: "personal_title", value: "Prof.", label: /salutation/i },
  phone:          { body: "phone",         column: "phone",          value: "+1 555 0199", label: /phone/i },
  city:           { body: "city",          column: "city",           value: "Springfield", label: /city/i },
  linkedin_url:   { body: "linkedinUrl",   column: "linkedin_url",   value: "https://www.linkedin.com/in/someone", label: /linkedin/i },
  job_function:   { body: "jobFunction",   column: "job_function",   value: "Solutions / Cloud Architect", label: /job function/i },
};
const PROFILE_FIELDS = Object.keys(FIELD_META);

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.4.0 — the admin surface stores and publishes the matrix", () => {
  test("a create with no configuration stores NOTHING and publishes the kind's defaults", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth");
    // NULL, not a blob that happens to match: "the admin has not configured this"
    // must stay ABSENT, or every event created today is pinned to today's
    // defaults and they can never move again.
    expect(dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", comp.id).p).toBeNull();
    expect(await wireStates(api, comp.id)).toEqual(BOOTH_DEFAULT_STATES);
    await api.dispose();
  });

  test("a create CAN seed the matrix, and a PUT changes it — partially, without touching the rest", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth", {
      registration_fields: { phone: "required", city: "optional" },
    });
    expect(await wireStates(api, comp.id)).toEqual({ ...BOOTH_DEFAULT_STATES, phone: "required", city: "optional" });
    // A PARTIAL map means "change these", never "reset everything I did not
    // mention" — the admin form renders only the controls its kind can use, and a
    // save that silently reset the rest would be the accept-and-ignore failure
    // with the sides swapped.
    const r = await setFields(api, csrf, comp.id, { linkedin_url: "required" });
    expect(r.status, `PUT: ${JSON.stringify(r.body)}`).toBe(200);
    expect(await wireStates(api, comp.id)).toEqual({
      ...BOOTH_DEFAULT_STATES, phone: "required", city: "optional", linkedin_url: "required",
    });
    await api.dispose();
  });

  test("the boundary REFUSES an unknown field, an unknown state and a non-object", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth");
    // STRICT ON A REQUEST, deliberately unlike the tolerant parse of a STORED
    // blob. A stored value may have been written by a newer image, so reading one
    // has to degrade; a request is a caller telling us something now, and
    // silently dropping part of it is how a control comes to appear to work.
    for (const bad of [
      { secondary_email: "required" },   // a field deliberately NOT configurable
      { phone: "mandatory" },            // the admin LABEL, not the stored value
      { phone: true },
    ]) {
      const r = await setFields(api, csrf, comp.id, bad);
      expect(r.status, `${JSON.stringify(bad)} must be refused`).toBe(400);
    }
    const list = await (await api.get("/api/admin/competitions")).json();
    const cur = (list.competitions || list).find(c => c.id === comp.id);
    const r2 = await api.put(`/api/admin/competitions/${comp.id}`, {
      headers: H(csrf), data: { expectedUpdatedAt: cur.updated_at, registration_fields: ["phone"] },
    });
    expect(r2.status(), "an array is not a map").toBe(400);
    // And nothing landed: a refused save must leave the event exactly as it was.
    expect(await wireStates(api, comp.id)).toEqual(BOOTH_DEFAULT_STATES);
    await api.dispose();
  });

  test("EVERY kind configures the form, at create AND at edit; NULL still means the short form", async () => {
    const { api, csrf } = await sa();
    // Operator ruling (30 Oct 2026): the creator of any event chooses its
    // sign-up fields. A Competition and a Program accept the matrix on create
    // and on edit, and what they store is what the wire then publishes.
    for (const kind of ["tournament", "program"]) {
      // NULL first: an event created with no configuration stores nothing and
      // resolves to the short form, so no existing event asks anything new.
      const { comp: plain } = await joinableEvent(api, csrf, kind);
      expect(dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", plain.id).p, `${kind}: nothing stored`).toBeNull();
      expect(await wireStates(api, plain.id), `${kind}: NULL resolves to the short form`).toEqual(LEGACY_STATES);
      // Create WITH a matrix.
      const { comp } = await joinableEvent(api, csrf, kind, { registration_fields: { phone: "required" } });
      expect((await wireStates(api, comp.id)).phone, `${kind}: create stored the matrix`).toBe("required");
      // Edit it.
      const e = await setFields(api, csrf, comp.id, { city: "required" });
      expect(e.status, `${kind} edit: ${JSON.stringify(e.body)}`).toBe(200);
      const st = await wireStates(api, comp.id);
      expect(st.city, `${kind}: edit changed city`).toBe("required");
      expect(st.phone, `${kind}: edit left phone alone`).toBe("required");
      // The retired LinkedIn sign-up switch is refused by name on every kind.
      const l = await setFields(api, csrf, comp.id, null, { linkedin_signup_enabled: false });
      expect(l.status).toBe(400);
      expect(l.body.code).toBe("linkedin_signup_removed");
    }
    // An unknown state is still refused on a Competition: the boundary did not
    // open with the kinds.
    const { comp: t } = await joinableEvent(api, csrf, "tournament");
    expect((await setFields(api, csrf, t.id, { phone: "mandatory" })).status).toBe(400);
    await api.dispose();
  });

  test("a Competition whose creator REQUIRES city refuses a blank one; its default does not", async () => {
    const { api, csrf } = await sa();
    const { token: req } = await joinableEvent(api, csrf, "tournament", { registration_fields: { city: "required" } });
    const bad = await register(req, { blank: ["city"] });
    expect(bad.status, `blank city on a requiring Competition: ${JSON.stringify(bad.body)}`).toBe(400);
    expect(bad.body.error).toMatch(/city/i);
    await bad.api.dispose();
    const ok = await register(req, { overrides: { city: "Leeds" } });
    expect(ok.status, `supplied city: ${JSON.stringify(ok.body)}`).toBe(200);
    await ok.api.dispose();
    // NEGATIVE CONTROL: the same request on a default Competition is accepted.
    const { token: def } = await joinableEvent(api, csrf, "tournament");
    const fine = await register(def, { blank: ["city"] });
    expect(fine.status, "a default Competition does not demand city").toBe(200);
    await fine.api.dispose();
    await api.dispose();
  });



  test("the audit records the matrix PER FIELD, resolved on both sides", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth");
    expect((await setFields(api, csrf, comp.id, { phone: "required", city: "hidden" })).status).toBe(200);
    const edited = (await compEvents(api, comp.id)).find(e => e.event_type === "edited");
    expect(edited, "an edited event was recorded").toBeTruthy();
    const d = edited.details;
    // Quoting JSON at an operator satisfies the drift guard's letter and fails its
    // point: what a reader of History needs is the field that moved, because that
    // is what will put a participant behind the gate.
    expect(d.changes.registration_field_policy.fields).toEqual({
      phone: { from: "hidden", to: "required" },
      city: { from: "optional", to: "hidden" },
    });
    // An unchanged save records nothing — `from`/`to` are resolved, so re-sending
    // the same states is not a change.
    expect((await setFields(api, csrf, comp.id, { phone: "required", city: "hidden" })).status).toBe(200);
    const withMatrix = (await compEvents(api, comp.id))
      .filter(e => e.event_type === "edited" && e.details && e.details.changes && e.details.changes.registration_field_policy);
    expect(withMatrix.length, "an identical re-save is not recorded as a change").toBe(1);
    await api.dispose();
  });

  // Sweep #331: a stored matrix still naming the retired `password` row is read
  // without it and REWRITTEN without it at the next save; that rewrite moves no
  // field, so History must not say the sign-up form was edited.
  const SAME = () => ({ ...BOOTH_DEFAULT_STATES, phone: "required" });
  const editedRows = async (api, compId) => (await compEvents(api, compId)).filter(e => e.event_type === "edited");

  test("sweep #331: a stored `password` key is dropped at the next save, and History records no sign-up change", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth", { registration_fields: { phone: "required" } });
    const canonical = dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", comp.id).p;
    await plantPolicy(comp.id, LEGACY_BLOB());
    expect(dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", comp.id).p, "PRECONDITION: the older shape is stored").not.toBe(canonical);
    expect(await wireStates(api, comp.id), "PRECONDITION: the retired key changes nothing it asks").toEqual(SAME());
    const before = (await editedRows(api, comp.id)).length;
    const newName = `${uniq()} renamed`;
    // The form's save: every state, unchanged, plus a rename.
    expect((await setFields(api, csrf, comp.id, SAME(), { name: newName })).status).toBe(200);
    expect(dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", comp.id).p, "the key is dropped: the canonical shape is stored").toBe(canonical);
    const rows = await editedRows(api, comp.id);
    expect(rows.length - before, "one edited entry, for the rename").toBe(1);
    const changes = rows.find(e => e.details && e.details.changes && e.details.changes.name).details.changes;
    expect(changes.name, "CONTROL: the rename is recorded").toBeTruthy();
    expect(changes.registration_field_policy, "nothing about the sign-up form").toBeUndefined();
    await api.dispose();
  });

  test("sweep #331: an older matrix equal to the defaults is stored as none, with no History entry at all", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth");
    await plantPolicy(comp.id, LEGACY_BLOB({ password: "required", phone: "hidden" }));
    const before = (await editedRows(api, comp.id)).length;
    expect((await setFields(api, csrf, comp.id, { ...BOOTH_DEFAULT_STATES })).status).toBe(200);
    expect(dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", comp.id).p, "CONTROL: the save rewrote it (the defaults are stored as none)").toBe(null);
    expect((await editedRows(api, comp.id)).length, "no edited entry: nothing changed").toBe(before);
    await api.dispose();
  });

  test("sweep #331: a real change on an older matrix records exactly the field that moved", async () => {
    const { api, csrf } = await sa();
    const { comp } = await joinableEvent(api, csrf, "booth", { registration_fields: { phone: "required" } });
    await plantPolicy(comp.id, LEGACY_BLOB());
    expect((await setFields(api, csrf, comp.id, { ...SAME(), phone: "optional" })).status).toBe(200);
    const last = (await editedRows(api, comp.id)).find(e => e.details && e.details.changes && e.details.changes.registration_field_policy);
    expect(last, "the change is recorded").toBeTruthy();
    expect(last.details.changes.registration_field_policy.fields, "the phone row alone, nothing about the retired key").toEqual({ phone: { from: "required", to: "optional" } });
    expect(JSON.parse(dbRow("SELECT registration_field_policy p FROM competitions WHERE id=?", comp.id).p), "stored without the retired key").not.toHaveProperty("password");
    await api.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.4.0 — every field, every state, at the sign-up door", () => {
  // THE MATRIX, driven per field rather than as a 3^6 cross product. The states
  // are resolved INDEPENDENTLY per field — one enum each, no interaction — so a
  // full cross product would run 729 registrations to re-prove the same rule 729
  // times. What the code can actually get wrong is a field wired to the wrong
  // state, which is what this covers exhaustively.
  for (const field of PROFILE_FIELDS) {
    const meta = FIELD_META[field];

    test(`${field}: REQUIRED refuses a blank one, and names it`, async () => {
      const { api, csrf } = await sa();
      const { token } = await joinableEvent(api, csrf, "booth", { registration_fields: { [field]: "required" } });
      const bad = await register(token, { blank: [meta.body] });
      expect(bad.status, `blank ${field}: ${JSON.stringify(bad.body)}`).toBe(400);
      expect(bad.body.error, "the refusal names the field").toMatch(meta.label);
      await bad.api.dispose();
      // …and the SAME event accepts it when supplied, so "everything is refused"
      // cannot pass this test.
      const ok = await register(token, { overrides: { [meta.body]: meta.value } });
      expect(ok.status, `supplied ${field}: ${JSON.stringify(ok.body)}`).toBe(200);
      expect(dbRow(`SELECT ${meta.column} v FROM users WHERE email=?`, ok.email).v).toBe(meta.value);
      await ok.api.dispose();
      await api.dispose();
    });

    for (const state of ["optional", "hidden"]) {
      test(`${field}: ${state.toUpperCase()} accepts a blank one, and still stores a supplied value`, async () => {
        const { api, csrf } = await sa();
        const { token } = await joinableEvent(api, csrf, "booth", { registration_fields: { [field]: state } });
        const ok = await register(token, { blank: [meta.body] });
        expect(ok.status, `blank ${field} @ ${state}: ${JSON.stringify(ok.body)}`).toBe(200);
        expect(dbRow(`SELECT ${meta.column} v FROM users WHERE email=?`, ok.email).v).toBeFalsy();
        await ok.api.dispose();
        // A relaxed field is still ACCEPTED and STORED when the visitor fills it
        // in — only the refusal is dropped. Without this arm, "optional" and
        // "silently discarded" are indistinguishable.
        const filled = await register(token, { overrides: { [meta.body]: meta.value } });
        expect(filled.status).toBe(200);
        expect(dbRow(`SELECT ${meta.column} v FROM users WHERE email=?`, filled.email).v).toBe(meta.value);
        await filled.api.dispose();
        await api.dispose();
      });
    }
  }

  test("the CONTROLS: a Competition with no form set keeps the default short form, and a no-token sign-up is untouched", async () => {
    const { api, csrf } = await sa();
    // The short form (operator order, 29 Oct 2026): a Competition created without
    // a matrix takes its kind's default, LEGACY_STATES — City and Job function
    // optional, the other three off — so none of the five is demanded. What it still demands is the base set (a
    // company), which the per-field REQUIRED arms above cannot see: without this,
    // a build that stopped checking required fields at all would pass them only
    // for fields an event configures.
    expect(LEGACY_STATES, "PRECONDITION: the default form demands none of the five")
      .toEqual({ personal_title: "hidden", phone: "hidden", city: "optional", linkedin_url: "hidden", job_function: "optional" });
    const { token: tourn } = await joinableEvent(api, csrf, "tournament");
    const okT = await register(tourn, { blank: ["city", "jobFunction", "personalTitle", "phone", "linkedinUrl"] });
    expect(okT.status, `Competition demands none of the five: ${JSON.stringify(okT.body)}`).toBe(200);
    await okT.api.dispose();
    const noCo = await register(tourn, { blank: ["company"] });
    expect(noCo.status, "a Competition still demands the base set (company)").toBe(400);
    await noCo.api.dispose();
    // A Booth Event that REQUIRES city refuses it, on the same request shape, so
    // the Competition's 200 is the kind's default form and not a dropped check.
    const { token: boothReq } = await joinableEvent(api, csrf, "booth", { registration_fields: { city: "required" } });
    const boothBad = await register(boothReq, { blank: ["city"] });
    expect(boothBad.status, "CONTROL: a Booth Event requiring city refuses a blank one").toBe(400);
    await boothBad.api.dispose();
    // No join token at all: the ordinary sign-up is the same short form.
    const noCoPlain = await register(null, { blank: ["company"] });
    expect(noCoPlain.status, "an ordinary sign-up still demands the base set (company)").toBe(400);
    await noCoPlain.api.dispose();
    const plain = await register(null, { blank: ["city", "jobFunction", "personalTitle", "phone", "linkedinUrl"] });
    expect(plain.status).toBe(200);
    // No join link means no pointer, so the gate falls back to the stamped policy
    // exactly as it always did.
    expect(dbRow("SELECT registration_competition_id r FROM users WHERE email=?", plain.email).r).toBeNull();
    await plain.api.dispose();
    await api.dispose();
  });



  test("the SERVER does not take the client's word for the matrix", async () => {
    const { api, csrf } = await sa();
    // The client is TOLD the answer so it can render the form; the server
    // re-derives it from the join token's own competition. A fabricated
    // relaxation in the request body must buy nothing.
    const { comp, token } = await joinableEvent(api, csrf, "booth", { registration_fields: { phone: "required" } });
    const preview = await (await api.get(`/api/competitions/self-enroll/${token}`)).json();
    expect(preview.policy.registration_fields.phone, "the preview publishes the real answer").toBe("required");
    const r = await register(token, {
      blank: ["phone"],
      overrides: { registration_fields: { phone: "hidden" }, relaxed_profile: ["phone"], policy: { registration_fields: { phone: "hidden" } } },
    });
    expect(r.status, "a fabricated relaxation is still refused").toBe(400);
    expect(r.body.error).toMatch(/phone/i);
    await r.api.dispose();
    // And the pointer really is stored, or every retroactivity test below is
    // asserting against a fallback rather than against the live event.
    const ok = await register(token, {});
    expect(ok.status).toBe(200);
    expect(dbRow("SELECT registration_competition_id r FROM users WHERE email=?", ok.email).r).toBe(comp.id);
    await ok.api.dispose();
    await api.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.4.0 — a field made mandatory LATER is demanded of people already registered", () => {
  for (const field of PROFILE_FIELDS) {
    const meta = FIELD_META[field];

    test(`${field}: registered while relaxed, then made mandatory → the gate asks for exactly it`, async () => {
      const { api, csrf } = await sa();
      const { comp, token } = await joinableEvent(api, csrf, "booth", { registration_fields: { [field]: "hidden" } });
      const who = await register(token, { blank: [meta.body] });
      expect(who.status, `register: ${JSON.stringify(who.body)}`).toBe(200);
      await who.api.dispose();

      // BEFORE: nothing is owed. This is the half that stops the test passing
      // because the gate demands everything of everyone.
      const before = await gateFor(who.email);
      expect(before.me.missing_fields, `${field}: nothing owed before the change`).toEqual([]);
      expect(before.me.profile_complete).toBe(true);
      await before.api.dispose();

      // A CONTROL PARTICIPANT on a DIFFERENT booth event, registered with the same
      // field blank. The change below must not reach them — the requirement
      // belongs to ONE event, which is what keeps a walk-up from being cornered
      // the moment they enter anything else.
      const { token: otherTok } = await joinableEvent(api, csrf, "booth", { registration_fields: { [field]: "hidden" } });
      const other = await register(otherTok, { blank: [meta.body] });
      expect(other.status).toBe(200);
      await other.api.dispose();

      expect((await setFields(api, csrf, comp.id, { [field]: "required" })).status).toBe(200);

      // AFTER: exactly this field, and IMMEDIATELY — /api/me is cached for two
      // seconds per user, so without the me-cache bust on the PUT this read would
      // still be answering "nothing owed".
      const after = await gateFor(who.email);
      expect(after.me.missing_fields, `${field}: demanded now`).toEqual([field]);
      expect(after.me.profile_complete).toBe(false);
      // The login response carries it too, so the gate opens without waiting for
      // the first /api/me.
      expect(after.loginMissing).toEqual([field]);
      // Every participant ACTION is refused server-side, or a scripted client
      // simply ignores the overlay.
      const act = await after.api.get("/api/my-competitions");
      expect(act.status(), "an action endpoint refuses an incomplete profile").toBe(400);
      expect((await act.json()).error).toBe("profile_incomplete");

      // The gate is satisfiable, and satisfying it clears it.
      const fix = await after.api.put("/api/me", { headers: H(after.csrf), data: { [meta.body]: meta.value } });
      expect(fix.ok(), `fix ${field}: ${await fix.text()}`).toBeTruthy();
      const fixed = await (await after.api.get("/api/me")).json();
      expect(fixed.missing_fields, `${field}: cleared`).toEqual([]);
      await after.api.dispose();

      // THE CONTROL, re-read at the end: the other participant is untouched.
      const ctrl = await gateFor(other.email);
      expect(ctrl.me.missing_fields, `${field}: a participant of ANOTHER event is unaffected`).toEqual([]);
      await ctrl.api.dispose();
      await api.dispose();
    });
  }

  test("making a field OPTIONAL does not gate anybody — the negative control", async () => {
    const { api, csrf } = await sa();
    const { comp, token } = await joinableEvent(api, csrf, "booth", { registration_fields: { phone: "hidden" } });
    const who = await register(token, { blank: ["phone"] });
    expect(who.status).toBe(200);
    await who.api.dispose();
    // hidden → optional is a real change to the FORM and no change at all to what
    // is owed. Without this arm, "the gate asks for phone" is equally satisfied by
    // a build that gates on any change whatsoever.
    expect((await setFields(api, csrf, comp.id, { phone: "optional" })).status).toBe(200);
    const g = await gateFor(who.email);
    expect(g.me.missing_fields).toEqual([]);
    await g.api.dispose();
    await api.dispose();
  });

  test("the demand survives the event ENDING, and is dropped if the event is DELETED", async () => {
    const { api, csrf } = await sa();
    const { comp, token } = await joinableEvent(api, csrf, "booth", { registration_fields: { phone: "hidden" } });
    const who = await register(token, { blank: ["phone"] });
    expect(who.status).toBe(200);
    await who.api.dispose();
    expect((await setFields(api, csrf, comp.id, { phone: "required" })).status).toBe(200);

    // ENDED — the operator's explicit case. A finished event still describes what
    // it collected, so the record it was gathering is still incomplete.
    const end = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf), data: {} });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const ended = await gateFor(who.email);
    expect(ended.me.missing_fields, "still demanded after the event ended").toEqual(["phone"]);
    await ended.api.dispose();

    // DELETED — the pointer dangles, so the stamped `profile_policy` takes over.
    // It relaxes rather than demands, which is the safe direction: the failure
    // mode of a lost configuration must never be an account stranded behind a
    // non-dismissible dialog for a field nobody can now explain.
    const del = await api.delete(`/api/admin/competitions/${comp.id}`, { headers: H(csrf) });
    expect(del.ok(), `delete: ${await del.text()}`).toBeTruthy();
    const gone = await gateFor(who.email);
    expect(gone.me.missing_fields, "a deleted event falls back to the kind defaults").toEqual([]);
    await gone.api.dispose();
    await api.dispose();
  });







  test("the gate throws rather than guessing when a caller under-selects", async () => {
    // The guard that makes every assertion above trustworthy. A hand-written
    // SELECT that drops the pointer or the join would otherwise fall back to the
    // stamped kind defaults — which stops demanding a field an admin has just made
    // mandatory, invisibly, on the one surface that could tell anybody.
    const { _profileMissingFields } = require("../lib/util");
    const base = {
      email: "x@company.example", secondary_email: null, company: "A", title: "B",
      country: "US", timezone: "UTC", job_function: "Dev", city: "Y",
      personal_title: null, phone: null, linkedin_url: null,
      registered_via: "manual", password_set_at: "2026-01-01T00:00:00.000Z",
    };
    expect(() => _profileMissingFields({ ...base, registration_competition_id: null }))
      .toThrow(/profile_policy/);
    expect(() => _profileMissingFields({ ...base, profile_policy: null }))
      .toThrow(/registration_competition_id/);
    expect(() => _profileMissingFields({ ...base, profile_policy: "booth", registration_competition_id: "some-id" }))
      .toThrow(/LEFT JOIN|_reg_event_kind/);
    // A NULL pointer is the NORMAL case and must not throw.
    expect(() => _profileMissingFields({ ...base, profile_policy: null, registration_competition_id: null }))
      .not.toThrow();
  });
});


