// v8.1.0 — PR 12: the resolved policy reaches every surface that carries an event.
//
// PR 11 landed the columns and lib/event-policy; nothing outside routes/sessions.js
// read them, and no client could see a kind at all. This PR puts `event_kind` (raw)
// and `policy` (derived) on the wire at every attach point, so the suppression layer
// the later phases build has something to read on EVERY payload rather than on the
// one the page happened to load from.
//
// The failure this locks against is not "policy is missing" in the abstract — it is
// that a competition arriving through one surface behaves differently from the same
// competition arriving through another, which presents as a control appearing and
// disappearing as the poll lands (the v7.21.19 F8 defect, where /api/my-competitions
// returned no tags and the dry-run badge blinked out a few seconds after paint).
//
// BLAST RADIUS, MEASURED — recorded because the symptom does not name the cause.
// Dropping `event_kind` from `_PARTICIPANT_COMP_COLUMNS` makes eventPolicyForWire
// throw inside listParticipantCompetitions, so EVERY participant login 500s, which
// fails seedTestData, which fails this whole file at beforeAll with
// "seed failed: Login failed for alice@acme.com: 500" and no mention of a column.
// If you are reading that message: check the participant column list first.
// The harshness is deliberate and unreachable in production — the column is
// NOT NULL DEFAULT and PR 11's migration is fatal if it is missing — so the only
// person who can reach the throw is the one editing the SELECT, which is exactly
// who should see it rather than shipping Competition semantics on a Program.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, codeLogin } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `pw${Date.now().toString(36)}`;

// Every wire policy must carry exactly these keys. A STRUCTURAL allow-list, not a
// spot-check: v7.28.0's leak lock was vacuous for precisely the opposite reason —
// it listed the public names while the leak arrived under `_`-prefixed ones.
// v8.1.0 (PR 31) — `relaxed_profile` joins the set. PR 12 withheld it on the
// grounds that it describes REGISTRATION and no form read it yet; PR 31 is that
// form. Adding a key is the additive direction that note reserved, and this
// exact-set assertion is what makes the addition a decision rather than a drift.
// v8.2.0 — the same reasoning, four more times. The competition form now renders
// only the controls the chosen kind can use, and these are the rules it asks. PR
// 12 named `trustedNetworks` specifically as a key that "reaches the client with
// the control it governs, not before"; the control is the create wizard's second
// step, so it arrives with it.
// v8.3.1 — `optional_profile` joins the set: fields the registration form SHOWS
// but does not require (Professional Role at a Booth Event). It reaches the
// client with the control it governs, which is the same bar `relaxed_profile`
// had to clear. This exact-set assertion is why the addition is a DECISION.
// v8.3.2 — `allow_simplified_registration` joins the set, and it is the LAST of
// the three registration keys PR 12 withheld: the sign-up form behind a join link
// reads it to render the password pair as optional, so it too arrives with the
// control it governs. It is the reader that `allowSimplifiedRegistration` had
// never had — the key existed in the policy table from v7.29.0 and nothing
// consulted it, which is dead config that reads as a control.
// v8.4.0 — THE THREE REGISTRATION KEYS ARE REPLACED BY ONE, and this exact-set
// assertion is what makes that a decision rather than a drift in either
// direction. `relaxed_profile` / `optional_profile` / `allow_simplified_registration`
// encoded a two-state answer for two fields plus a boolean for the password, and
// that shape cannot carry what a Booth Event may now configure: the password has
// THREE states (a boolean cannot say "do not offer it at all"), and three fields
// that were optional for every kind can now be REQUIRED — under the old encoding
// "required" was INFERRED from membership of neither set, so those three would
// have to be listed as optional on every kind merely to stay as they were, and a
// client that had not been taught that would start demanding a salutation from
// everybody. `registration_fields` carries the states themselves, one value per
// field, so there is exactly ONE representation of this on the wire.
//
// v8.6.0 — `late_entry` joins them, arriving with the control it governs (the
// competition form's Late entries section), which is the rule PR 12 set rather
// than an exception to it. The POLICY vocabulary ("allowed" / "never"), never a
// boolean: the per-EVENT toggle is a different question with its own answer on the
// competition row, and a boolean here would be indistinguishable from it.
//
// v8.13.0 — `choice_layout` joins them, arriving with the view it governs (the
// booth tap-to-answer card, features/choice-tap.js). "tap" | "standard", a
// presentation choice the client tests POSITIVELY (=== "tap"), so an unknown
// value keeps the standard card.
//
// `clock_start` ("allowed" | "never", owner decision, 27 Nov 2026) joins them with
// the control it governs: the event form's "Start each participant's clock".
const POLICY_KEYS = ["sessions", "schedule", "ranking_enabled", "certificate",
  "registration_fields", "registration_fields_configurable",
  "reveal_answers", "group_leaderboard", "measure_presence", "trusted_networks",
  "late_entry", "choice_layout", "clock_start"].sort();
// The six configurable fields and the three legal states, imported rather than
// retyped: a hand-written copy here would agree on the day it was written.
const { REGISTRATION_FIELD_KEYS, FIELD_STATES } = require("../lib/registration-fields");

function expectPolicy(obj, where, kind) {
  expect(obj, `${where}: the payload exists`).toBeTruthy();
  expect(obj.event_kind, `${where}: event_kind is on the wire RAW`).toBe(kind);
  expect(obj.policy, `${where}: policy is attached`).toBeTruthy();
  expect(Object.keys(obj.policy).sort(), `${where}: exactly the wire policy keys`).toEqual(POLICY_KEYS);
  // v8.4.0 — the nested map is checked STRUCTURALLY too. An attach point that
  // shipped `registration_fields: {}` — a partial SELECT, a projection that
  // stripped it — would satisfy the key-set assertion above and leave every
  // client falling back to `policyOrDefault`'s LEGACY shape, which for a Booth
  // Event is the wrong answer rather than a degraded one.
  expect(Object.keys(obj.policy.registration_fields || {}).sort(),
    `${where}: exactly the six configurable fields`).toEqual([...REGISTRATION_FIELD_KEYS].sort());
  for (const f of REGISTRATION_FIELD_KEYS) {
    expect(FIELD_STATES, `${where}: ${f} carries a legal state`).toContain(obj.policy.registration_fields[f]);
  }
  // WHETHER the form is configurable is a different question from what it asks
  // for, and it has to ride the wire because `public/js` cannot import the module
  // that owns the answer. Every kind may be configured (operator ruling,
  // 30 Oct 2026); the assertion is an exact boolean, so an absent key or a
  // truthy non-boolean fails rather than reading as configured.
  expect(obj.policy.registration_fields_configurable, `${where}: every kind is configurable`).toBe(true);
  // The discriminating assertion. Every "policy is present" check above is equally
  // satisfied by a constant object, so each attach point must also prove it resolved
  // THIS event's kind rather than a default.
  if (kind === "program") {
    expect(obj.policy.ranking_enabled, `${where}: a Program is not ranked`).toBe(false);
    expect(obj.policy.schedule, `${where}: a Program runs to a deadline`).toBe("deadline");
    expect(obj.policy.sessions, `${where}: a Program has no sessions`).toBe("forbidden");
    expect(obj.policy.certificate, `${where}: a Program certifies completion`).toBe("completion");
  } else {
    expect(obj.policy.ranking_enabled, `${where}: a Competition is ranked`).toBe(true);
    expect(obj.policy.schedule, `${where}: a Competition runs in a window`).toBe("window");
    expect(obj.policy.sessions, `${where}: a Competition may have sessions`).toBe("many");
    expect(obj.policy.certificate, `${where}: a Competition certifies an attempt`).toBe("attempt");
  }
}

async function saCtx() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()} ${await r.text()}`).toBeTruthy();
  // The login regenerates the session, so the pre-login token is dead.
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeComp(api, csrf, kind, label, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      // LIVE, so /api/status is reachable and the competition is bindable and
      // self-enrollable. An UPCOMING fixture cannot reach the status poll at all.
      // v8.1.0 (PR 16) — a deadline-shaped kind takes a deadline, not a duration.
      ...kindBody(`${TAG} ${label}`, kind, Date.now() - 60 * 60 * 1000, 600),
      timezone: "UTC", ...extra,
    },
  });
  expect(r.ok(), `create ${kind} ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

// Own the participant (standing rule): the shared seeded fixtures are re-passworded,
// blocked and tagged by lifecycle tests elsewhere in the run.
async function makeParticipant(api, csrf, n) {
  const email = `${TAG}-${n}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Policy", lastName: `Wire${n}`, nickname: `${TAG}_${n}`, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${n}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find((p) => p.email === email);
  expect(u, `participant ${n} must be findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { email, id: u.id };
}


// v8.1.0 (PR 16) — build a create body that matches the KIND's schedule shape.
// A deadline-shaped kind (program) takes `deadline_at` and refuses
// `duration_minutes`; every other kind is unchanged.
function kindBody(name, kind, startMs, durationMinutes = 60) {
  const start_time = new Date(startMs).toISOString();
  if (kind === "program") {
    return { name, event_kind: kind, start_time, deadline_at: new Date(startMs + durationMinutes * 60_000).toISOString() };
  }
  return { name, event_kind: kind, start_time, duration_minutes: durationMinutes };
}

test.describe("v8.1.0 — the policy object reaches every attach point", () => {
  test("the four competition responses and the admin list carry event_kind + policy", async () => {
    const { api, csrf } = await saCtx();
    try {
      // The CREATE response — attached inside _compWire, which is why the four
      // handlers that spread it cannot forget it individually.
      const comp = await makeComp(api, csrf, "tournament", "create");
      expectPolicy(comp, "POST /api/admin/competitions", "tournament");
      const prog = await makeComp(api, csrf, "program", "create-prog");
      expectPolicy(prog, "POST /api/admin/competitions (program)", "program");

      // The PUT response.
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { name: `${TAG} create renamed`, expectedUpdatedAt: comp.updated_at },
      });
      expect(put.ok(), `put: ${put.status()} ${await put.text()}`).toBeTruthy();
      expectPolicy((await put.json()).competition, "PUT /api/admin/competitions/:id", "tournament");

      // The ADMIN LIST does not pass through _compWire — it is its own curated
      // SELECT, so it is the one that silently omits a column nobody named.
      const list = await (await api.get("/api/admin/competitions")).json();
      const lc = list.find((c) => c.id === comp.id);
      const lp = list.find((c) => c.id === prog.id);
      expectPolicy(lc, "GET /api/admin/competitions (tournament)", "tournament");
      expectPolicy(lp, "GET /api/admin/competitions (program)", "program");

      // end-now is the fourth _compWire handler.
      const end = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
      expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
      expectPolicy((await end.json()).competition, "POST .../end-now", "tournament");
    } finally { await api.dispose(); }
  });

  test("the participant payloads carry it — /api/me, /api/my-competitions AND the login response", async () => {
    // The F8 clause. These three share ONE column list, so the failure mode is not
    // "one surface is missing it" but "the chip paints on login and vanishes when
    // the 15 s poll lands", which reads as a broken feature rather than a gap.
    const { api, csrf } = await saCtx();
    let papi;
    try {
      const comp = await makeComp(api, csrf, "tournament", "participant");
      const prog = await makeComp(api, csrf, "program", "participant-prog");
      const u = await makeParticipant(api, csrf, "p1");
      const assign = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { userIds: [String(u.id)], competitionIds: [String(comp.id), String(prog.id)] },
      });
      expect(assign.ok(), `assign: ${assign.status()} ${await assign.text()}`).toBeTruthy();
      // The assign endpoint SILENTLY SKIPS ineligible users, so a skip must fail
      // here as a precondition rather than downstream as an empty payload.
      expect((await assign.json()).assigned, "the participant was really enrolled").toBeGreaterThan(0);

      const pc = await freshCtx();
      papi = pc.api;
      const login = await codeLogin(papi, u.email, H(pc.csrf));
      expect(login.ok(), `participant login: ${login.status()} ${await login.text()}`).toBeTruthy();
      const loginBody = await login.json();

      const pick = (arr, id) => (arr || []).find((c) => c.id === id);
      expectPolicy(pick(loginBody.competitions, comp.id), "POST /api/login", "tournament");
      expectPolicy(pick(loginBody.competitions, prog.id), "POST /api/login (program)", "program");

      const me = await (await papi.get("/api/me")).json();
      expectPolicy(pick(me.competitions, comp.id), "GET /api/me", "tournament");
      expectPolicy(pick(me.competitions, prog.id), "GET /api/me (program)", "program");

      const mine = await (await papi.get("/api/my-competitions")).json();
      expectPolicy(pick(mine, comp.id), "GET /api/my-competitions", "tournament");
      expectPolicy(pick(mine, prog.id), "GET /api/my-competitions (program)", "program");

      // select-competition — the payload the SPA routes off when a competition is
      // picked from the picker WITHOUT going through /api/me.
      const csrf2 = (await (await papi.get("/api/csrf-token")).json()).csrfToken;
      const sel = await papi.post("/api/select-competition", { headers: H(csrf2), data: { competitionId: prog.id } });
      expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      expectPolicy((await sel.json()).competition, "POST /api/select-competition", "program");

      // /api/status — the poll every participant issues every 15 seconds.
      const st = await (await papi.get("/api/status")).json();
      expectPolicy(st, "GET /api/status", "program");
      // `end` stays NON-nullable: it is derived from competitionEffectiveEnd, which
      // never returns null for a real competition.
      expect(st.end, "/api/status still carries a non-null end").toBeTruthy();
    } finally {
      await api.dispose();
      if (papi) await papi.dispose();
    }
  });

  test("the public self-enroll preview carries it — the one attach point reachable before an account exists", async () => {
    const { api, csrf } = await saCtx();
    let anon;
    try {
      const prog = await makeComp(api, csrf, "program", "selfenroll", { self_enroll_enabled: true });
      const rev = await api.get(`/api/admin/competitions/${prog.id}/self-enroll`);
      expect(rev.ok(), `reveal: ${rev.status()} ${await rev.text()}`).toBeTruthy();
      const token = (await rev.json()).token;
      expect(token, "a self-enroll token was revealed").toBeTruthy();

      // Anonymous — no session at all, which is the point of this attach point.
      const ac = await freshCtx();
      anon = ac.api;
      const prev = await anon.get(`/api/competitions/self-enroll/${token}`);
      expect(prev.ok(), `preview: ${prev.status()} ${await prev.text()}`).toBeTruthy();
      expectPolicy(await prev.json(), "GET /api/competitions/self-enroll/:token", "program");
    } finally {
      await api.dispose();
      if (anon) await anon.dispose();
    }
  });

  test("the group-bind picker carries it — the ninth attach point, a server projection", async () => {
    // The bind dialog builds its cards from THIS payload and nothing else (that is
    // the v6.20.6 point of the endpoint — it replaced an N+1 fan-out), so without
    // the kind here it is the one admin surface that cannot say what it is binding
    // a group to.
    const { api, csrf } = await saCtx();
    try {
      const comp = await makeComp(api, csrf, "tournament", "groupbind");
      const prog = await makeComp(api, csrf, "program", "groupbind-prog");
      const g = await api.post("/api/admin/groups", { headers: H(csrf), data: { name: `${TAG} Group` } });
      expect(g.ok(), `group create: ${g.status()} ${await g.text()}`).toBeTruthy();
      const gid = (await g.json()).group.id;

      const picker = await api.get(`/api/admin/groups/${gid}/competitions`);
      expect(picker.ok(), `picker: ${picker.status()} ${await picker.text()}`).toBeTruthy();
      const rows = (await picker.json()).competitions;
      expectPolicy(rows.find((c) => c.id === comp.id), "GET /api/admin/groups/:id/competitions", "tournament");
      expectPolicy(rows.find((c) => c.id === prog.id), "GET /api/admin/groups/:id/competitions (program)", "program");
    } finally { await api.dispose(); }
  });
});

test.describe("v8.1.0 — the wire projection's two structural rules", () => {
  test("the wire key is ranking_enabled, and the participant leak scanner's OWN pattern proves why", () => {
    // Extract the live regex rather than restating it: a lock that restates the
    // pattern passes while the real scanner diverges, which is the mirror-divergence
    // class this codebase keeps paying for.
    const src = fs.readFileSync(path.join(__dirname, "functional-security-c.api.spec.js"), "utf8");
    const m = src.match(/leakyNamePattern\s*=\s*\/([^/]+)\/([a-z]*)/);
    expect(m, "the participant-count leak scanner still declares leakyNamePattern").toBeTruthy();
    const leaky = new RegExp(m[1], m[2]);
    // Anti-vacuity: the extracted pattern must still be the one that would catch
    // `ranked`, or "no key matches" is satisfied by a regex that matches nothing.
    expect(leaky.test("ranked"), "the extracted pattern really does reject `ranked`").toBe(true);

    const { eventPolicyForWire } = require("../lib/event-policy");
    for (const kind of ["booth", "tournament", "program"]) {
      // v8.4.0 — the two registration columns are named EXPLICITLY as "not
      // configured". `eventPolicyForWire` is strict about them (a missing column
      // throws), so a caller that genuinely means "the kind's defaults" has to say
      // so — which is exactly what `eventKindsForWire` does for the create wizard.
      const wire = eventPolicyForWire({ event_kind: kind, registration_field_policy: null });
      expect(Object.keys(wire).sort(), `${kind}: exactly the wire policy keys`).toEqual(POLICY_KEYS);
      expect(Object.keys(wire.registration_fields || {}).sort(),
        `${kind}: exactly the six configurable fields`).toEqual([...REGISTRATION_FIELD_KEYS].sort());
      for (const k of Object.keys(wire)) {
        expect(leaky.test(k), `${kind}: wire policy key "${k}" must not trip the participant-count leak scanner`).toBe(false);
      }
    }
  });

  test("v8.4.0 — the wire projection is STRICT about the two registration columns", () => {
    // The guard that makes "immediately reflected" trustworthy. A hand-written
    // competition SELECT that omits `registration_field_policy` would otherwise
    // ship the KIND's defaults for an event an admin has configured — so a field
    // they made mandatory silently stops being demanded, and one they relaxed
    // starts being demanded of walk-ups who were told it was optional. Neither is
    // visible from any screen, which is why it throws rather than guesses.
    const { eventPolicyForWire } = require("../lib/event-policy");
    expect(() => eventPolicyForWire({ event_kind: "booth" }))
      .toThrow(/registration_field_policy/);
    expect(() => eventPolicyForWire({ event_kind: "booth", registration_field_policy: null }))
      .not.toThrow();
  });

  test("v8.4.1 — the KIND entries carry the create-time seeds, and the seed is not the policy", () => {
    // `eventKindsForWire()` rides the SPA shell and is the only thing the create
    // form can seed from: there is no row yet, so `comp.linkedin_signup_enabled`
    // does not exist and `policyOrDefault` has nothing to merge. Nothing in this
    // suite read this projection before v8.4.1, which is why the new key is
    // pinned here rather than left to the one client that consumes it.
    const { eventKindsForWire } = require("../lib/event-policy");
    const kinds = eventKindsForWire();
    expect(kinds.length, "all three kinds ship").toBe(3);

    for (const k of kinds) {
      // An exact key set, for the reason every other structural lock in this file
      // gives: a seed that reaches the client becomes a contract, so ADDING one
      // must be a decision rather than a drift.
      // v8.6.0 — `late_entry_enabled` joins the seeds for the reason the other two
      // are here: the create form seeds a checkbox from it, so without it the form
      // would carry a client-side literal and the server's `=== undefined` branch
      // would be dead code — the defect `cxone_disabled` shipped with before v8.2.0
      // and `linkedin_signup_enabled` before v8.4.1, both on this very form.
      // Event team reports — `add_qualifying` seeds the create form's "Add the
      // qualifying questions" tick (ON for booth only), for the same reason.
      // The join-link seed is the template editor's: it shows a setting a
      // template leaves out as the kind's seed and keeps it out of the save.
      // (There is no instant-join seed: that switch was retired, operator ruling,
      // 14 Nov 2026.)
      expect(Object.keys(k.defaults || {}).sort(), `${k.value}: exactly the create-time seeds`)
        .toEqual(["add_qualifying", "clock_start", "cxone_disabled", "late_entry_enabled", "self_enroll_enabled"]);
      expect(k.defaults.add_qualifying, `${k.value}: the qualifying seed`).toBe(k.value === "booth");
      // The clock-start seed: the first open for the two ranked kinds, entry for a
      // Program (unranked), and never a value the kind's policy refuses.
      expect(k.defaults.clock_start, `${k.value}: the clock-start seed`).toBe(k.value === "program" ? "entry" : "first_open");
      expect(k.policy.clock_start, `${k.value}: the clock-start offer`).toBe(k.value === "program" ? "never" : "allowed");
      // The join-link seed is the server's own (`selfEnrollDefault`), so a
      // Booth Event's walk-up door is ON and the other kinds' OFF.
      const { eventPolicy } = require("../lib/event-policy");
      expect(k.defaults.self_enroll_enabled, `${k.value}: the join-link seed`).toBe(!!eventPolicy(k.value).selfEnrollDefault);
      expect(k.defaults.self_enroll_enabled, `${k.value}: CONTROL — booth is the one kind seeded on`).toBe(k.value === "booth");
      expect(typeof k.defaults.late_entry_enabled, `${k.value}: the late-entry seed is a boolean`).toBe("boolean");
      // The seed is DERIVED from the prohibition, so the two cannot disagree: the
      // one kind that may run a late window is seeded on, and the others off.
      expect(k.defaults.late_entry_enabled, `${k.value}: the seed follows the policy`)
        .toBe(k.policy.late_entry === "allowed");
    }

    // The retired LinkedIn sign-up seed and policy key are gone from the wire.
    for (const k of kinds) {
      expect(k.policy.linkedin_signup, `${k.value}: no LinkedIn sign-up key`).toBeUndefined();
      expect(k.defaults.linkedin_signup_enabled).toBeUndefined();
    }
  });

  test("_compWire strips `_`-prefixed keys, so the underscore prefix is load-bearing", () => {
    // The three named strips are a DENY-LIST over a `...rest` spread: correct for the
    // three that exist and silently shipping the fourth. Nothing is `_`-prefixed on a
    // competition row today — the rule exists BEFORE the field that needs it, which
    // is the only order in which it can be free.
    const { _compWire } = require("../lib/competitions");
    const out = _compWire({
      id: "c1", name: "N", event_kind: "tournament", registration_field_policy: null,
      self_enroll_token: "SECRET", cxone_api_key: "KEY", trusted_network_ips: "203.0.113.7",
      _derivedInternal: "must not ship",
    });
    expect(out.self_enroll_token, "the join capability is stripped").toBeUndefined();
    expect(out.cxone_api_key, "the credential is stripped").toBeUndefined();
    expect(out.trusted_network_ips, "the venue address is stripped").toBeUndefined();
    expect(out._derivedInternal, "an `_`-prefixed internal is stripped structurally").toBeUndefined();
    // Positive control: the strip must not be eating ordinary fields.
    expect(out.name, "an ordinary field survives").toBe("N");
    expect(out.event_kind, "the kind survives — it ships RAW").toBe("tournament");
    expect(out.policy.ranking_enabled, "and the policy is attached here, once, for all four handlers").toBe(true);
  });

  test("a row that under-selected event_kind throws rather than silently defaulting", () => {
    // The asymmetry that makes the guard mechanical: an unrecognised VALUE is a
    // rollback and normalises; a missing KEY is a caller bug and must announce
    // itself, or a partial SELECT gives Competition semantics to a Booth Event.
    const { eventPolicyForWire } = require("../lib/event-policy");
    expect(() => eventPolicyForWire({ id: "x", name: "y" })).toThrow(/event_kind/);
    expect(eventPolicyForWire({ event_kind: "some-future-kind", registration_field_policy: null }).ranking_enabled,
      "an unknown value normalises to the default rather than taking the process down").toBe(true);
  });
});
