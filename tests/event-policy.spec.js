// v7.29.0 — PR 11: the event-kind columns and the policy module.
//
// This is the irreversible half of the redesign: the stored values land in rows,
// export files and audit blobs, so they are a one-way door. Everything derived
// from a kind lives in lib/event-policy so a consumer never switches on the value
// itself — the alternative is the failure this codebase keeps paying for, a rule
// re-derived at each site, correct at all of them the day it is written.
//
// No user-visible label ships in this PR; the labels reach the client later.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");


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

test.describe("v7.29.0 — event kinds", () => {
  test("every existing competition is a tournament, with no backfill statement", () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name);
      for (const c of ["event_kind", "registration_field_policy", "linkedin_signup_enabled",
        "deadline_at", "time_basis",
        "measure_presence", "auto_end_on_all_solved", "attempt_cap", "join_code"]) {
        expect(cols, `${c} was added`).toContain(c);
      }
      // v8.2.2 — the self-enrolment ceiling is REMOVED, and the guarded DROP in
      // db.js is what makes that true of an upgraded database rather than only
      // of a fresh one. Asserted as an ABSENCE here so the removal is pinned:
      // re-adding the column without re-adding the feature would otherwise be
      // invisible, and the drop silently not running would be too.
      expect(cols, "max_self_enrolled is dropped, not merely unused").not.toContain("max_self_enrolled");
      // v8.4.0 — `registration_mode` goes the same way, and for the same reason
      // stated as an ABSENCE: it was added in v7.29.0 to carry "which credential
      // does a registration through this event collect", nothing ever read it,
      // and `registration_field_policy.password` now stores exactly that
      // decision. A column named for a setting that governs nothing is the
      // control-that-appears-to-work failure aimed at the next maintainer, so the
      // drop is pinned rather than left to chance.
      expect(cols, "registration_mode is dropped — registration_field_policy.password replaced it").not.toContain("registration_mode");
      // The DEFAULT populates every row inside the ALTER, so there is no window in
      // which a row is typeless — the v7.15.x `updated_at` lesson, where the ALTER
      // and its separate UPDATE were two autocommit statements and a crash between
      // them left the column present-but-NULL for ever.
      const bad = db.prepare(
        "SELECT COUNT(*) n FROM competitions WHERE event_kind IS NULL OR event_kind NOT IN ('booth','tournament','program')"
      ).get().n;
      expect(bad, "no row carries an invalid kind").toBe(0);
    } finally { db.close(); }
  });

  test("the policy module is TOLERANT of an unknown value and STRICT about a missing column", () => {
    const p = require("../lib/event-policy");
    // Rollback safety: a value written by a NEWER image must not take the process
    // down, so it normalises to the default and keeps serving.
    expect(p.eventKind({ event_kind: "some-future-kind" })).toBe("tournament");
    // A missing key means the CALLER under-selected its columns — a programming
    // error, and the mechanical guard that matters: several partial competition
    // SELECTs feed policy checks, and a missed one would silently give Competition
    // semantics to a Booth Event.
    expect(() => p.eventKind({})).toThrow(/no event_kind/);
    expect(() => p.eventKind({ id: "x", name: "y" })).toThrow(/SELECT/);
  });

  test("the derived table says what each kind is, and nothing switches on the value", () => {
    const p = require("../lib/event-policy");
    expect(p.eventPolicy({ event_kind: "booth" }).sessions).toBe("forbidden");
    expect(p.eventPolicy({ event_kind: "program" }).sessions).toBe("forbidden");
    expect(p.eventPolicy({ event_kind: "tournament" }).sessions).toBe("many");
    expect(p.eventPolicy({ event_kind: "program" }).ranked).toBe(false);
    expect(p.eventPolicy({ event_kind: "program" }).schedule).toBe("deadline");
    expect(p.eventPolicy({ event_kind: "program" }).certificate).toBe("completion");
    // A Program IS single-session by the implemented rule, so it would satisfy
    // today's trusted-network eligibility check — and a decade-long rate-limit
    // bypass is exactly what time-bounding exists to prevent.
    expect(p.eventPolicy({ event_kind: "program" }).trustedNetworks).toBe("never");
    // ── v8.4.0 — THE REGISTRATION KEYS LEFT THIS TABLE ────────────────────────
    //
    // `relaxedProfile` / `optionalProfile` / `allowSimplifiedRegistration` are
    // GONE, asserted as an ABSENCE so the removal is pinned rather than assumed.
    // They answered "which fields does this KIND ask for", which stopped being
    // the whole question the moment a Booth Event could configure its own form:
    // a key returning a plausible, authoritative-looking value that is not what
    // the event does is worse than no key at all. Re-adding one would put the
    // second, silently-divergent copy straight back.
    for (const k of ["booth", "tournament", "program"]) {
      const pol = p.eventPolicy({ event_kind: k });
      for (const dead of ["relaxedProfile", "optionalProfile", "allowSimplifiedRegistration"]) {
        expect(pol[dead], `${k}: ${dead} must not come back — ask registrationFieldStates(comp)`).toBeUndefined();
      }
    }
  });

  test("v8.4.0 — the registration matrix is owned once, and its states are legal", () => {
    const rf = require("../lib/registration-fields");
    const p = require("../lib/event-policy");
    // A SECOND LIST OF KINDS IS A MIRROR, so it is diffed rather than trusted:
    // lib/registration-fields.js keys its default table on the same opaque kind
    // values EVENT_KINDS declares, and a kind added to one and not the other
    // would silently fall back to LEGACY.
    expect(Object.keys(rf.KIND_DEFAULT_STATES).sort())
      .toEqual(p.EVENT_KINDS.map(k => k.value).sort());
    // Every default is a LEGAL state for every kind. A typo here is not a syntax
    // error anywhere — it would simply make the field fall back at every reader.
    for (const kind of Object.keys(rf.KIND_DEFAULT_STATES)) {
      const st = rf.KIND_DEFAULT_STATES[kind];
      expect(Object.keys(st).sort(), `${kind}: exactly the five configurable fields`)
        .toEqual([...rf.REGISTRATION_FIELD_KEYS].sort());
      for (const f of rf.REGISTRATION_FIELD_KEYS) {
        expect(rf.FIELD_STATES, `${kind}.${f} is a legal state`).toContain(st[f]);
      }
    }
    // THE OPERATOR'S DEFAULTS, pinned literally: the short form (operator order,
    // 29 Oct 2026; confirmed by operator ruling, 14 Nov 2026) — City and Job
    // function shown but optional; Salutation, Phone and LinkedIn off.
    expect(rf.BOOTH_DEFAULT_STATES).toEqual({
      personal_title: "hidden", phone: "hidden",
      city: "optional", linkedin_url: "hidden", job_function: "optional",
    });
    // …and every other kind starts from the same short form, field for field
    // (LEGACY_STATES, pinned literally below), so no kind's form asks more by
    // default than a Booth Event's.
    for (const k of ["tournament", "program"]) {
      expect(rf.KIND_DEFAULT_STATES[k], `${k} is unchanged from LEGACY`).toEqual(rf.LEGACY_STATES);
    }
    expect(rf.LEGACY_STATES).toEqual({
      personal_title: "hidden", phone: "hidden",
      city: "optional", linkedin_url: "hidden", job_function: "optional",
    });
    // EVERY kind is configurable (operator ruling, 30 Oct 2026), so a stored
    // matrix is honoured on each, and a NULL column still resolves to the kind's
    // defaults (the short form): the gate may only shrink.
    expect([...rf.CONFIGURABLE_KINDS].sort()).toEqual(Object.keys(rf.KIND_DEFAULT_STATES).sort());
    const forced = JSON.stringify({ city: "hidden", job_function: "required" });
    for (const k of ["booth", "tournament", "program"]) {
      expect(rf.registrationFieldStates({ event_kind: k, registration_field_policy: forced }),
        `${k} honours a stored matrix`).toEqual({ ...rf.LEGACY_STATES, city: "hidden", job_function: "required" });
      expect(rf.registrationFieldStates({ event_kind: k, registration_field_policy: null }),
        `${k}: NULL is the short form`).toEqual(rf.LEGACY_STATES);
      expect(() => rf.registrationFieldStates({ event_kind: k }), `${k}: a row without the column throws`).toThrow(/registration_field_policy/);
    }
    // The LinkedIn sign-up door was retired with LinkedIn sign-in.
    expect(rf.linkedinSignupAllowed).toBeUndefined();
    expect(rf.LINKEDIN_SIGNUP_DEFAULTS).toBeUndefined();
    // corporate_email is computed OUTSIDE the matrix precisely so it cannot drop
    // out silently alongside the fields that ARE configurable — and
    // secondary_email is excluded because it is the escape hatch that makes the
    // corporate-mailbox rule satisfiable at all.
    expect(rf.REGISTRATION_FIELD_KEYS).not.toContain("corporate_email");
    expect(rf.REGISTRATION_FIELD_KEYS).not.toContain("secondary_email");
    // The derived sets stay DISJOINT, and the password never appears among them:
    // it is a credential, not a profile column, and `profileColumn: null` is what
    // every consumer branches on.
    for (const kind of Object.keys(rf.KIND_DEFAULT_STATES)) {
      const sets = rf.deriveProfileSets(rf.KIND_DEFAULT_STATES[kind]);
      expect(sets.relaxed.filter(f => sets.optional.includes(f)), `${kind}: relaxed ∩ optional`).toEqual([]);
      for (const bucket of ["relaxed", "optional", "required"]) {
        expect(sets[bucket], `${kind}: the password is not a profile field`).not.toContain("password");
      }
    }
  });

  test("v8.4.0 — a stored matrix is TOLERANT on the value and STRICT on the column", () => {
    const rf = require("../lib/registration-fields");
    const booth = (pol) => rf.registrationFieldStates({ event_kind: "booth", registration_field_policy: pol });
    // TOLERANT: garbage means the row was written by a newer image or hand-edited,
    // so the kind's default is used and the platform keeps serving. It fails SAFE
    // — the fallback RELAXES, so a blob this build cannot read can never put an
    // existing account behind the non-dismissible completion gate.
    for (const junk of ["not json", "[]", "null", '{"phone":"maybe"}', '{"nope":"required"}', "", "   "]) {
      expect(booth(junk), `junk (${JSON.stringify(junk)}) falls back to the booth default`)
        .toEqual(rf.BOOTH_DEFAULT_STATES);
    }
    // A PARTIAL map fills the rest from the default rather than blanking them.
    expect(booth(JSON.stringify({ phone: "required" }))).toEqual({
      ...rf.BOOTH_DEFAULT_STATES, phone: "required",
    });
    // STRICT on the COLUMN. A hand-written competition SELECT that omits
    // `registration_field_policy` must fail loudly, because the alternative is
    // serving the kind's defaults for an event an admin has configured — which
    // stops demanding a field they made mandatory, invisibly.
    expect(() => rf.registrationFieldStates({ event_kind: "booth" }))
      .toThrow(/registration_field_policy/);
    // …and for every other kind too, now that every kind is configurable.
    expect(() => rf.registrationFieldStates({ event_kind: "tournament" })).toThrow(/registration_field_policy/);
    expect(() => rf.registrationFieldStates({ event_kind: "program" })).toThrow(/registration_field_policy/);
    // The canonical stored form is NULL when it equals the default, so "not
    // configured" stays ABSENT rather than pinned to today's values — which is
    // what leaves the defaults free to move in a later release.
    expect(rf.serialiseRegistrationFieldPolicy(rf.BOOTH_DEFAULT_STATES, rf.BOOTH_DEFAULT_STATES)).toBeNull();
    const ser = rf.serialiseRegistrationFieldPolicy({ ...rf.BOOTH_DEFAULT_STATES, phone: "required" }, rf.BOOTH_DEFAULT_STATES);
    expect(typeof ser).toBe("string");
    // Key ORDER is canonical, so an identical configuration re-saved is not
    // recorded as a change by the audit ladder's string comparison.
    expect(ser).toBe(rf.serialiseRegistrationFieldPolicy(
      { job_function: "optional", phone: "required", city: "optional", linkedin_url: "hidden", password: "hidden", personal_title: "hidden" },
      // (a stored `password` key — the retired sixth field — is ignored)
      rf.BOOTH_DEFAULT_STATES));
  });

  // THE ONE-WAY DOOR. A stored value derivable from its label means a future
  // rename becomes a fatal boot migration over every row, export file and audit
  // blob. Keeping them disjoint is what makes a rename a copy change.
  test("stored values are not derivable from labels", () => {
    const p = require("../lib/event-policy");
    const collisions = p.EVENT_KINDS.filter(k => k.label.toLowerCase().replace(/\s+/g, "") === k.value);
    // `program` is the unavoidable one — its label IS its value — and that is
    // accepted rather than contrived around. The others must not follow.
    expect(collisions.map(k => k.value)).toEqual(["program"]);
    // And no kind label may equal the COLLECTIVE noun, or a chip inside a pane
    // headed "Events" reads as uncategorised.
    for (const k of p.EVENT_KINDS) {
      expect(k.label).not.toBe(p.EVENT_COLLECTIVE.singular);
      expect(k.plural).not.toBe(p.EVENT_COLLECTIVE.plural);
    }
  });

  test("creating a competition still works and lands as a tournament", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        name: `Kind ${stamp}`,
        start_time: new Date(Date.now() + 3600_000).toISOString(),
        duration_minutes: 60, timezone: "UTC",
      },
    });
    expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).competition.id;
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT event_kind, registration_field_policy, linkedin_signup_enabled, time_basis FROM competitions WHERE id=?").get(id);
      expect(row.event_kind, "a competition created today is a tournament").toBe("tournament");
      expect(row.time_basis).toBe("elapsed");
      // v8.4.0 — a create that says nothing about the sign-up form stores
      // NOTHING, so the kind's defaults apply and can still move later.
      expect(row.registration_field_policy, "no configuration stored when none was asked for").toBeNull();
      // v8.4.1 — the seed is PER KIND now, so this assertion had to say WHICH
      // kind's it is: the fixture above sends no `event_kind` and therefore lands
      // a tournament, whose door stays open. It is the non-booth half of
      // `LINKEDIN_SIGNUP_DEFAULTS` driven through the real create path — the half
      // that would go red if the operator's booth-only change had been applied to
      // every kind. (Only the wording moved; `1` is the same answer as before.)
      expect(row.linkedin_signup_enabled, "the retired LinkedIn column is stored 0 and read by nothing").toBe(0);
    } finally { db.close(); }
    await api.dispose();
  });


});

// ── v7.29.0 — sessions forbidden, enforced from BOTH ends ────────────────────
test.describe("v7.29.0 — a sessionless kind has no sessions, as a theorem", () => {
  const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

  async function makeComp(api, csrf, kind, stamp) {
    const r = await api.post("/api/admin/competitions", {
      headers: h(csrf),
      // v8.1.0 (PR 16) — a deadline-shaped kind takes a DEADLINE and refuses a
      // duration; a window-shaped one is unchanged. One helper, per-kind body.
      data: kindBody(`Kind${kind} ${stamp}`, kind, Date.now() + 3600_000),
    });
    return r;
  }

  test("event_kind is bound EXPLICITLY at create, not left to the column default", async () => {
    // The sharpest edge in the redesign: the column defaults to 'tournament', so
    // an INSERT that omitted the bind would answer 201 while the row silently
    // became a Competition — sessions available, ranked, auto-end live — with
    // nothing erroring. And the kind is immutable, so that state would be
    // uncorrectable without deleting the row.
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    for (const kind of ["booth", "program", "tournament"]) {
      const r = await makeComp(api, csrf, kind, `${stamp}-${kind}`);
      expect(r.ok(), `create ${kind}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const id = (await r.json()).competition.id;
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT event_kind FROM competitions WHERE id=?").get(id).event_kind,
          `a ${kind} really is stored as one`).toBe(kind);
      } finally { db.close(); }
    }
    // And an unknown kind is a 400 from the boundary, never a silent default.
    const bad = await makeComp(api, csrf, "martian", `${stamp}-bad`);
    expect(bad.status(), "an unknown kind is refused at the boundary").toBe(400);
    await api.dispose();
  });

  test("a session cannot be added to a kind that forbids them", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    for (const kind of ["booth", "program"]) {
      const cr = await makeComp(api, csrf, kind, `${stamp}-ts-${kind}`);
      expect(cr.ok(), `create ${kind}`).toBeTruthy();
      const id = (await cr.json()).competition.id;
      const ts = await api.post(`/api/admin/competitions/${id}/timeslots`, {
        headers: h(csrf),
        data: { name: "S1", start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 30, timezone: "UTC" },
      });
      expect(ts.status(), `${kind} refuses a session`).toBe(400);
      expect((await ts.json()).code).toBe("sessions_forbidden");
    }
    // The positive control: a Competition still takes sessions, or "forbidden"
    // would be equally satisfied by a build that refuses them for everyone.
    const cr = await makeComp(api, csrf, "tournament", `${stamp}-ts-ok`);
    const id = (await cr.json()).competition.id;
    const ok = await api.post(`/api/admin/competitions/${id}/timeslots`, {
      headers: h(csrf),
      data: { name: "S1", start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 30, timezone: "UTC" },
    });
    expect(ok.ok(), `a Competition still takes sessions: ${ok.status()} ${await ok.text()}`).toBeTruthy();
    await api.dispose();
  });

  test("the kind is CHANGEABLE while upcoming, and echoing the same kind back is not a change", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const cr = await makeComp(api, csrf, "booth", `${stamp}-imm`);
    expect(cr.ok()).toBeTruthy();
    const comp = (await cr.json()).competition;

    // v8.3.0 — this asserted a 400 `event_kind_immutable`. The kind is now
    // changeable while the event is UPCOMING and has no sessions, which this
    // fixture is (makeComp starts it an hour out), so the same request succeeds.
    // The theorem that made immutability worth having is unchanged and is
    // asserted in tests/event-kind-change.spec.js: both ends still move together
    // — a slot cannot be added to a sessionless kind, and the kind cannot change
    // while slots exist.
    const ok = await api.put(`/api/admin/competitions/${comp.id}`, {
      headers: h(csrf), data: { event_kind: "tournament", expectedUpdatedAt: comp.updated_at },
    });
    expect(ok.status(), `an upcoming, session-free event may be re-typed: ${await ok.text()}`).toBe(200);
    expect((await ok.json()).competition.event_kind).toBe("tournament");
    const back = await api.put(`/api/admin/competitions/${comp.id}`, {
      headers: h(csrf), data: { event_kind: "booth", expectedUpdatedAt: (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id).updated_at },
    });
    expect(back.ok(), `and back again: ${await back.text()}`).toBeTruthy();

    // A client that round-trips the whole row must not be broken by this.
    const fresh = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
    const same = await api.put(`/api/admin/competitions/${comp.id}`, {
      headers: h(csrf), data: { event_kind: "booth", name: `Renamed ${stamp}`, expectedUpdatedAt: fresh.updated_at },
    });
    expect(same.ok(), `echoing the same kind is not a change: ${same.status()} ${await same.text()}`).toBeTruthy();
    await api.dispose();
  });
});
