// v8.4.0 — a Booth Event CONFIGURES its own sign-up form, and the completion
// gate re-reads that configuration LIVE.
//
// v8.1.0 (PR 31) made a Booth Event's shortened form a property of the KIND and
// stamped the deal onto the account (`users.profile_policy`) so it could not be
// taken away. Six fields are now configurable PER EVENT — `personal_title`,
// `password`, `phone`, `city`, `linkedin_url`, `job_function` — each in one of
// three states (`required` / `optional` / `hidden`, `lib/registration-fields.js`),
// and the operator asked for something a stamped snapshot structurally cannot
// express: a field made mandatory today must be demanded of people who ALREADY
// registered.
//
// So the answer is a POINTER (`users.registration_competition_id`) re-read on
// every gate check, with `profile_policy` retained as the fallback. What this
// file locks is everything around that:
//
//   * a Booth Event's DEFAULTS drop four fields (salutation, phone, LinkedIn URL,
//     city) and REQUIRE Professional Role — a real change in both directions from
//     v8.3.1, and the retroactivity the operator asked for arrives through it;
//   * the pointer names ONE event, so entering a DIFFERENT event still changes
//     nothing about what an account owes — PR 31's protection, intact;
//   * DELETING that event does not re-impose the fields: the pointer dangles and
//     `profile_policy`'s KIND defaults answer instead (safe, under-demanding);
//   * an unrecognised stored policy relaxes NOTHING, so a rollback fails safe;
//   * `corporate_email` is NEVER configurable — it is the only barrier on a
//     leaked join link;
//   * and the server never trusts the client's word for any of it.
//
// THE PROFILE-COMPLETION GATE IS NOT ESCAPABLE, and that is deliberate and
// locked elsewhere (`ui-participant-c.spec.js`). This does not weaken it — it
// changes what the gate ASKS FOR, which is the only safe way to make a shorter
// form, because a gate that can be dismissed is not a gate.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `bg${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A live event of `kind` with its join link on, plus the token. */
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

/** Reconfigure a Booth Event's sign-up form. A PARTIAL map is normal and legal. */
async function setFields(api, csrf, compId, registration_fields) {
  const r = await api.put(`/api/admin/competitions/${compId}`, { headers: H(csrf), data: { registration_fields } });
  expect(r.ok(), `configure the sign-up form: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

/**
 * Register through a join token, BLANKING whatever `drop` names.
 *
 * `""`, never `delete` — `POST /api/register` applies `??` defaults for
 * `jobFunction`/`city` when they are `undefined` under NODE_ENV=test, so a test
 * that omits them measures the test-mode bypass and never reaches the rule
 * (CLAUDE.md says so explicitly, and the first draft here did exactly that: the
 * Competition control "passed" with a 200).
 *
 * v8.4.0 — `personalTitle` / `phone` / `linkedinUrl` are sent EXPLICITLY EMPTY
 * for the same reason. They were optional for every kind before this release and
 * a Booth Event may now demand them, so a test that simply omitted them could
 * not tell "not demanded" from "not sent".
 */
async function register(token, { drop = [], email, extra = {} } = {}) {
  const { api, csrf } = await freshCtx();
  const label = uniq();
  const data = {
    firstName: "Walk", lastName: "Up", nickname: label,
    email: email || `${label}@company.example`,
    company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "Testville",
    personalTitle: "", phone: "", linkedinUrl: "",
    password: PARTICIPANT_PASS, joinToken: token,
    ...extra,
  };
  for (const f of drop) data[f] = "";
  const r = await registerPost(api, "/api/register", { headers: H(csrf), data });
  const out = { status: r.status(), body: await r.json().catch(() => ({})), email: data.email, api };
  return out;
}

async function userRow(api, email) {
  const list = await (await api.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json();
  return (list.participants || []).find(p => p.email === email);
}

/** The stored row, for the two columns no payload carries. */
function storedRow(email) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email); }
  finally { db.close(); }
}

/** Sign in and read the gate's own answer. */
async function missingFields(api, csrf, email) {
  const { api: p, csrf: c0 } = await freshCtx();
  const li = await codeLogin(p, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const me = await (await p.get("/api/me")).json();
  await p.dispose();
  return { missing: me.missing_fields || [], complete: me.profile_complete };
}

/** Verify + approve, so the account can sign in and be asked by the gate. */
async function usable(api, csrf, email) {
  const u = await userRow(api, email);
  expect(u, `the account (${email}) exists`).toBeTruthy();
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify: ${await v.text()}`).toBeTruthy();
  const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(a.ok(), `approve: ${await a.text()}`).toBeTruthy();
  return u;
}

test.describe("v8.4.0 — Booth Event registration", () => {
  test("the short form: no kind demands City or Job function by default, and a Booth Event can require one", async () => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const comp = await joinableEvent(api, csrf, "tournament");

    // Every kind's default (29 Oct 2026): City and Job function optional, the
    // other three off — so both kinds accept all five blank.
    for (const ev of [booth, comp]) {
      const ok = await register(ev.token, { drop: ["city", "jobFunction"] });
      expect(ok.status, `short form, ${ev.comp.event_kind}: ${JSON.stringify(ok.body)}`).toBe(200);
      await ok.api.dispose();
    }

    // THE CONTROL: the requirement is still enforceable — a Booth Event that
    // makes Job function required refuses a walk-up who leaves it blank.
    await setFields(api, csrf, booth.comp.id, { job_function: "required" });
    const noRole = await register(booth.token, { drop: ["jobFunction"] });
    expect(noRole.status, `a required job function is demanded: ${JSON.stringify(noRole.body)}`).toBe(400);
    expect(noRole.body.error).toMatch(/job function/i);
    await noRole.api.dispose();
    await api.dispose();
  });

  test("the deal is the EVENT'S and is re-read LIVE, so a field made mandatory now is demanded of an account that already registered", async () => {
    // THE HEADLINE v8.4.0 PROPERTY, and the one a stamped snapshot structurally
    // cannot express. v8.1.0 (PR 31) recorded the deal as it WAS; this records
    // WHICH EVENT decides it, so an admin's answer today is the answer.
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");

    const r = await register(booth.token, { drop: ["city"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await r.api.dispose();
    await usable(api, csrf, r.email);

    // The precondition, asserted rather than assumed: the account really has no
    // city, so "the gate asks for nothing" below is about the CONFIGURATION and
    // not about a field that happens to be filled.
    expect(storedRow(r.email).city, "the walk-up gave no city").toBeFalsy();
    // ...and the pointer names the event they registered through, which is what
    // the gate re-reads. Mutation: drop `registration_competition_id` from the
    // register INSERT and every live-read assertion below stops discriminating.
    expect(storedRow(r.email).registration_competition_id, "the account records WHICH event created it").toBe(booth.comp.id);

    const before = await missingFields(api, csrf, r.email);
    expect(before.missing, "the gate asks for nothing it never collected").toEqual([]);
    expect(before.complete, "so the profile reads complete").toBe(true);

    // NOW MAKE IT MANDATORY. Nothing about the account changes; the event does.
    await setFields(api, csrf, booth.comp.id, { city: "required" });
    const after = await missingFields(api, csrf, r.email);
    expect(after.missing, "and the gate demands it of somebody who registered before the change").toEqual(["city"]);
    expect(after.complete).toBe(false);

    // ...and back again, so this is a live READ rather than a one-way stamp.
    await setFields(api, csrf, booth.comp.id, { city: "hidden" });
    const relaxed = await missingFields(api, csrf, r.email);
    expect(relaxed.missing, "relaxing it stops the demand just as immediately").toEqual([]);
    await api.dispose();
  });

  test("entering a DIFFERENT event does not change what the account owes", async () => {
    // PR 31's protection, which the pointer keeps by naming ONE event: the
    // completion gate is non-dismissible, so if the requirement were read from
    // the competition a participant is CURRENTLY in, a Booth Event walk-up would
    // be cornered the moment they entered anything else — demanding fields
    // nobody ever asked them for, with no way past it.
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const r = await register(booth.token, { drop: ["city"] });
    expect(r.status).toBe(200);
    await r.api.dispose();
    const u = await usable(api, csrf, r.email);

    const before = await missingFields(api, csrf, r.email);
    expect(before.missing, "nothing owed at the event they registered through").toEqual([]);

    // NOW PUT THEM SOMEWHERE ELSE ENTIRELY — an ordinary Competition, where the
    // full field set applies to everyone who registered THERE.
    const other = await joinableEvent(api, csrf, "tournament");
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { competitionIds: [other.comp.id], userIds: [u.id] },
    });
    expect((await asg.json()).assigned, "assigned into a Competition").toBe(1);

    const after = await missingFields(api, csrf, r.email);
    expect(after.missing, "the deal survives entering a different kind of event").toEqual([]);
    expect(after.complete).toBe(true);
    await api.dispose();
  });

  test("DELETING the Booth Event does not re-impose the dropped fields", async () => {
    // THE PAIR IS THE DESIGN. The pointer carries no foreign key, so deleting
    // the event leaves it DANGLING — and a dangling pointer read as "no
    // relaxation" is PR 31's trap arriving by another route, because
    // competition_users.competition_id is ON DELETE CASCADE: the relaxation would
    // evaporate exactly when nobody is left to notice, and every walk-up would
    // hit an inescapable gate on their next sign-in. `profile_policy` is the
    // denormalised fallback that stops it.
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const r = await register(booth.token, { drop: ["city"] });
    expect(r.status).toBe(200);
    await r.api.dispose();
    await usable(api, csrf, r.email);
    expect(storedRow(r.email).city, "the walk-up gave no city").toBeFalsy();
    expect(storedRow(r.email).profile_policy, "…and the row carries the fallback").toBe("booth");

    // A LIVE event refuses deletion, so end it first — the fixture checklist's
    // create-live-then-end shape, in reverse.
    const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === booth.comp.id);
    const end = await api.post(`/api/admin/competitions/${booth.comp.id}/end-now`, {
      headers: H(csrf), data: { expectedUpdatedAt: row.updated_at },
    });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const del = await api.delete(`/api/admin/competitions/${booth.comp.id}`, { headers: H(csrf) });
    expect(del.ok(), `delete the event: ${await del.text()}`).toBeTruthy();
    // The pointer is left dangling rather than nulled, which is exactly the state
    // the fallback exists for.
    expect(storedRow(r.email).registration_competition_id, "the pointer dangles").toBe(booth.comp.id);

    const after = await missingFields(api, csrf, r.email);
    expect(after.missing, "the stored policy cannot cascade away").toEqual([]);
    await api.dispose();
  });

  test("corporate_email is NEVER relaxed, on any configuration", async () => {
    // Computed outside the configurable six on purpose: write the matrix as field
    // names, omit two correctly, and the corporate-mailbox requirement disappears
    // with them — taking the only barrier on a leaked join link, with nothing
    // erroring and no other test failing (v7.29.0). It is also why
    // `secondary_email` is not configurable: it is the escape hatch that makes
    // this requirement satisfiable.
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const label = uniq();
    // Email first: a free-mail address with no account is never sent an address
    // proof, so its sign-up form can never be submitted.
    const free = await register(booth.token, { drop: ["city"], email: `${label}@gmail.com` });
    expect(free.status, `a free-mail-only booth signup must be refused: ${JSON.stringify(free.body)}`).toBe(403);
    expect(free.body.code).toBe("email_proof_required");
    expect(storedRow(`${label}@gmail.com`), "and no account exists").toBeFalsy();
    await free.api.dispose();

    // The positive control: the SAME registration with a work address succeeds,
    // so the refusal above is about the mailbox and not about the short form.
    const ok = await register(booth.token, { drop: ["city"] });
    expect(ok.status, `a work address on the same short form: ${JSON.stringify(ok.body)}`).toBe(200);
    await ok.api.dispose();
    await api.dispose();
  });

  test("the gate's own predicate: the live read wins, an unknown policy relaxes NOTHING, and an under-selected row THROWS", () => {
    // Driven in-process because no API path can write a policy value the enum
    // rejects, and because the throws are contracts about the CALLER rather than
    // about a response.
    const { _profileMissingFields } = require("../lib/util");
    // The gate columns as a correctly-selected row supplies them. `profile_policy`
    // and `registration_competition_id` are stated EXPLICITLY and empty — the
    // normal state of every account that did not register through a join link —
    // because an absent KEY is a different thing and throws, deliberately.
    // `password_set_at` is set: the password clause has its own arm below, and
    // leaving it out here would put "password" in every expected array and bury
    // what these assertions are about.
    const bare = {
      company: "", title: "", country: "", timezone: "", job_function: "", city: "",
      personal_title: "", phone: "", linkedin_url: "",
      email: "a@acme.com", password_set_at: "2026-01-01T00:00:00.000Z",
      profile_policy: null, registration_competition_id: null,
    };
    const BASE = ["company", "title", "country", "timezone"];

    // ── The FALLBACK path: no pointer, so `profile_policy`'s KIND defaults ──
    expect(_profileMissingFields({ ...bare }), "no policy → the LEGACY set")
      .toEqual([...BASE]);
    // Since the short form (29 Oct 2026) every kind's default demands only the base set.
    expect(_profileMissingFields({ ...bare, profile_policy: "booth" }), "booth → city dropped, role still owed")
      .toEqual([...BASE]);
    // An unrecognised value relaxes NOTHING — a rollback, or a kind retired
    // later, must ask for a field rather than silently drop one.
    expect(_profileMissingFields({ ...bare, profile_policy: "nonsense-from-a-newer-image" }), "unknown → the LEGACY set")
      .toEqual([...BASE]);
    for (const k of ["tournament", "program"]) {
      expect(_profileMissingFields({ ...bare, profile_policy: k }), `${k} relaxes nothing`)
        .toEqual([...BASE]);
    }

    // ── The LIVE path: the joined event's CURRENT configuration WINS ──
    // Same stamped `profile_policy: "booth"` as the row two assertions up, and
    // the opposite answer, which is what makes this a live read rather than a
    // snapshot. Mutation: prefer `profile_policy` over the join and this fails
    // while every fallback assertion above still passes.
    const live = {
      ...bare, profile_policy: "booth", registration_competition_id: "c-live",
      _reg_event_kind: "booth",
      _reg_field_policy: JSON.stringify({ city: "required", job_function: "optional" }),
    };
    expect(_profileMissingFields(live), "the admin's current answer decides")
      .toEqual([...BASE, "city"]);
    // A DELETED event: the pointer is present, the join found nothing (NULL, not
    // absent), so the stamped fallback answers — and the two cases have to be
    // distinguishable, which is why the absent key throws instead.
    expect(_profileMissingFields({ ...live, _reg_event_kind: null, _reg_field_policy: null }),
      "a deleted event falls back to the stamped kind's defaults").toEqual([...BASE]);
    // Every kind configures its form (operator ruling, 30 Oct 2026), so a
    // Competition's stored matrix is honoured exactly as a Booth Event's is...
    expect(_profileMissingFields({ ...live, _reg_event_kind: "tournament" }),
      "a Competition honours its stored matrix").toEqual([...BASE, "city"]);
    // ...and a Competition with NO stored matrix asks only the base set.
    expect(_profileMissingFields({ ...live, _reg_event_kind: "tournament", _reg_field_policy: null }),
      "an unconfigured Competition asks nothing new").toEqual([...BASE]);

    // ── The four throws, each a contract about an under-selecting caller ──
    // Silently un-relaxing a booth account puts them behind the non-dismissible
    // gate; silently falling back to the stamped defaults stops demanding a field
    // an admin has just made mandatory. Neither is visible in any response, which
    // is why both fail loudly.
    const { profile_policy: _pp, ...noPolicy } = bare;
    expect(() => _profileMissingFields(noPolicy),
      "an absent profile_policy KEY throws rather than silently un-relaxing").toThrow(/under-selected/);
    const { registration_competition_id: _rc, ...noPointer } = bare;
    expect(() => _profileMissingFields(noPointer),
      "an absent registration_competition_id KEY throws").toThrow(/under-selected/);
    const { _reg_event_kind: _rk, ...noJoin } = live;
    expect(() => _profileMissingFields(noJoin),
      "a pointer with no LEFT JOIN throws").toThrow(/LEFT JOIN|_reg_event_kind/);
    // The MATRIX half of the join on its own: a SELECT that brings the kind but not
    // the stored matrix would read every configured event as its kind's defaults.
    const { _reg_field_policy: _rf, ...noMatrix } = live;
    expect(() => _profileMissingFields(noMatrix),
      "a pointer joined without _reg_field_policy throws too").toThrow(/LEFT JOIN|_reg_field_policy/);
  });



  test("the preview carries registration_fields, and the SERVER does not trust the client's word for it", async () => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const comp = await joinableEvent(api, csrf, "tournament");

    const bp = await (await api.get(`/api/competitions/self-enroll/${booth.token}`)).json();
    // v8.4.0 — ONE key replaces `relaxed_profile` / `optional_profile` /
    // `allow_simplified_registration`: the states themselves, one value per
    // field, because the password has THREE of them and three fields that were
    // optional for every kind can now be REQUIRED. The exact key set and the
    // legality of each value are pinned by `event-policy-wire.spec.js`; what
    // matters here is that the preview — the ONE attach point reachable before an
    // account exists — carries THIS event's answer.
    expect(bp.policy.registration_fields, "the booth preview carries the matrix").toEqual({
      personal_title: "hidden", phone: "hidden",
      city: "optional", linkedin_url: "hidden", job_function: "optional",
    });
    // v8.4.1 — the door starts SHUT on a Booth Event, so an unconfigured one
    // publishes `false` here. This is the value the register page branches on, so
    // it is the one place the flipped default is visible to a visitor.
    expect(bp.policy.linkedin_signup, "the retired LinkedIn door is gone from the wire").toBeUndefined();
    const cp = await (await api.get(`/api/competitions/self-enroll/${comp.token}`)).json();
    // THE CONTROL, in the same breath: the change was booth-only, so a
    // Competition's preview must still publish `true`. Without this the
    // assertion above is equally satisfied by a build that shut LinkedIn sign-up
    // off for every event on the platform.
    expect(cp.policy.linkedin_signup).toBeUndefined();
    expect(cp.policy.registration_fields, "a Competition carries the LEGACY shape and configures nothing").toEqual({
      personal_title: "hidden", phone: "hidden",
      city: "optional", linkedin_url: "hidden", job_function: "optional",
    });

    // A CONFIGURED booth event's preview reports the ADMIN's answer, not the
    // kind's default — the discriminating half, since both assertions above are
    // equally satisfied by a projection that returns a constant per kind.
    await setFields(api, csrf, booth.comp.id, { phone: "required", job_function: "optional" });
    const bp2 = await (await api.get(`/api/competitions/self-enroll/${booth.token}`)).json();
    expect(bp2.policy.registration_fields.phone, "the configured state reaches the preview").toBe("required");
    expect(bp2.policy.registration_fields.job_function).toBe("optional");
    // ...and the SERVER enforces it: a walk-up who leaves the now-required phone
    // blank is refused, which is what stops the matrix being decoration.
    const noPhone = await register(booth.token, { drop: ["city"] });
    expect(noPhone.status, `a configured requirement is enforced: ${JSON.stringify(noPhone.body)}`).toBe(400);
    expect(noPhone.body.error).toMatch(/phone/i);
    await noPhone.api.dispose();

    // The client cannot grant itself a relaxation: the route re-derives the
    // states from the TOKEN'S OWN competition, so claiming one changes nothing.
    const { api: anon, csrf: ac } = await freshCtx();
    const label = uniq();
    const r = await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: {
        firstName: "Forged", lastName: "Claim", nickname: label, email: `${label}@company.example`,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        jobFunction: "", city: "",   // blank, not absent — see the register() note
        personalTitle: "", phone: "", linkedinUrl: "",
        password: PARTICIPANT_PASS, joinToken: booth.token,   // the booth now REQUIRES phone
        policy: { registration_fields: { phone: "hidden" } },   // ignored
        registration_fields: { phone: "hidden" },               // ignored
      },
    });
    expect(r.status(), "a fabricated relaxation is not honoured").toBe(400);
    expect((await r.json()).error).toMatch(/phone/i);
    await anon.dispose();
    await api.dispose();
  });

  test("every kind accepts the matrix; an unknown key or state is still refused", async () => {
    // Operator ruling (30 Oct 2026): the sign-up form is configurable for every
    // kind. Both directions matter -- the create AND the edit.
    const { api, csrf } = await sa();
    const created = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `${uniq()} tournament`, event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() + 3600e3).toISOString(), duration_minutes: 600,
        registration_fields: { city: "hidden" },
      },
    });
    expect(created.ok(), `create with a matrix on a Competition: ${await created.text()}`).toBeTruthy();
    expect((await created.json()).competition.policy.registration_fields.city).toBe("hidden");

    const comp = await joinableEvent(api, csrf, "tournament");
    const put = await api.put(`/api/admin/competitions/${comp.comp.id}`, {
      headers: H(csrf), data: { registration_fields: { city: "required" } },
    });
    expect(put.ok(), `edit with a matrix on a Competition: ${await put.text()}`).toBeTruthy();
    expect((await put.json()).competition.policy.registration_fields.city).toBe("required");

    // THE POSITIVE CONTROL: the identical body on a Booth Event is accepted, so
    // the refusals above are about the KIND and not about the field being broken.
    const booth = await joinableEvent(api, csrf, "booth");
    const okPut = await api.put(`/api/admin/competitions/${booth.comp.id}`, {
      headers: H(csrf), data: { registration_fields: { city: "optional" } },
    });
    expect(okPut.ok(), `the same body on a Booth Event: ${await okPut.text()}`).toBeTruthy();
    expect((await okPut.json()).competition.policy.registration_fields.city).toBe("optional");

    // ...and an unknown key or an unknown state is a named 400 rather than a
    // silent drop, on the kind that DOES configure it.
    for (const body of [{ registration_fields: { nonsense_field: "hidden" } },
                        { registration_fields: { city: "sort-of-required" } }]) {
      const r = await api.put(`/api/admin/competitions/${booth.comp.id}`, { headers: H(csrf), data: body });
      expect(r.status(), `strict validation: ${JSON.stringify(body)} → ${await r.text()}`).toBe(400);
    }
    await api.dispose();
  });

  test("an ordinary registration is completely unchanged and records no event", async () => {
    // The regression control for everyone who is not at a booth: no join token,
    // full form, and NEITHER column stamped on the row — so the configuration
    // cannot leak into the default path.
    const { api, csrf } = await sa();
    const { api: anon, csrf: ac } = await freshCtx();
    const label = uniq();
    const email = `${label}@company.example`;
    const r = await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: {
        firstName: "Plain", lastName: "Signup", nickname: label, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Testville", password: PARTICIPANT_PASS,
      },
    });
    expect(r.status(), `plain registration: ${await r.text()}`).toBe(200);
    await anon.dispose();

    const row = storedRow(email);
    expect(row, "the account exists").toBeTruthy();
    expect(row.profile_policy, "an ordinary sign-up stores no policy").toBe(null);
    // v8.4.0 — and no pointer either, so the gate takes the fallback path and
    // answers exactly as it did before this release.
    expect(row.registration_competition_id, "…and names no registration event").toBe(null);

    // And both fields are still required for it — driven through the predicate on
    // a copy with them blanked, since the real row has them filled. The two
    // columns are stated EXPLICITLY: `_profileMissingFields` THROWS on an absent
    // key rather than silently un-relaxing, which is how this line found out.
    const { _profileMissingFields } = require("../lib/util");
    expect(_profileMissingFields({
      ...row, profile_policy: null, registration_competition_id: null,
      job_function: "", city: "",
    }), "since the short form, a plain account owes neither field").toEqual([]);
    await api.dispose();
  });
});
