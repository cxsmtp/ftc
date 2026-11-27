// @ts-check
/**
 * v7.16.0 — per-competition trusted network IPs: the rate-limit allowlist an
 * admin can set from the UI while an event is running, so a venue whose whole
 * room shares one NAT address stops being mistaken for a scanner.
 *
 * The feature is a deliberate hole in the rate limiter, so every test here is
 * about the constraints that keep it small: what an admin may enter, the
 * single-session shape it is only valid for, WHEN it is live, and the audit
 * trail it leaves. A guard rail with no test is a guard rail that gets
 * "simplified" away.
 *
 * The operator-alert surface that tells an admin to set one lives in
 * tests/ip-ban-alerts.api.spec.js — same feature, separate file.
 */

// The window assertions call lib/comp-allowlist IN THIS PROCESS so an explicit
// `now` can be injected — the whole point of the feature is arithmetic that is
// impossible to drive from the wire (it would need a 26-hour test). db.js
// resolves its SQLite path at require time from DATA_DIR, so that has to be
// pointed at THIS worker's volume before the require below: it is the very
// directory this worker's server already uses, so the two see one database.
//
// That makes this process a SECOND connection to a database the app declares
// single-process, which is only acceptable because everything below reads.
// db.js's own boot backfills are all `WHERE … IS NULL` no-ops against a
// migrated volume. Do not add writes here — go through the API, which is what
// the rest of the file does.
process.env.DATA_DIR = require("./helpers").TEST_DATA_DIR;

const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
// v7.20.2 — bound LAZILY, not at module top-level.
//
// lib/comp-allowlist reaches the database through db.js, which opens the SQLite
// file AT REQUIRE TIME. A spec's top-level requires run before any hook, so a
// handle taken there predates the per-file recycle that deletes and recreates
// that file — and then reads the PREVIOUS file's data from an unlinked inode.
// It only works when this spec happens to be the first file on its worker,
// which is the ordering nondeterminism the harness removes everywhere else.
// (That is how CI failed on the very commit that introduced per-file
// isolation: two window tests here returned null.)
//
// isolated-test.js purges the app-module require cache after each recycle, so
// resolving inside the test binds to the fresh database.
const _ca = () => require("../lib/comp-allowlist");
const competitionAllowlistMatch = (...a) => _ca().competitionAllowlistMatch(...a);
const invalidateCompAllowlist = (...a) => _ca().invalidateCompAllowlist(...a);
const validateTrustedIps = (...a) => _ca().validateTrustedIps(...a);
const GRACE_MS = () => _ca().GRACE_MS;
const MAX_ENTRIES = () => _ca().MAX_ENTRIES;
const MIN_CIDR_BITS = () => _ca().MIN_CIDR_BITS;

// The documented contract, written out rather than imported. Deriving the
// expectations from the module's own constants makes every assertion below
// self-fulfilling: widening MAX_ENTRIES to 100 or dropping GRACE_MS to 0 would
// simply move the goalposts and the suite would stay green (measured — both
// mutations passed against the first draft of this file). One assertion each
// pins the module to these numbers; everything else uses the literals.
const CONTRACT_MAX_ENTRIES = 10;
const CONTRACT_MIN_CIDR_BITS = 16;
const CONTRACT_GRACE_MS = 2 * 60 * 60 * 1000;

function h(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }

// Competition names are globally unique and this worker's DB accumulates rows
// from every earlier spec, so every fixture name carries a counter as well as a
// timestamp (two comps created in the same millisecond are ordinary here).
let _seq = 0;
function compName(tag) { return `TrustNet ${tag} ${Date.now()}-${++_seq}`; }

let _windowSeq = Math.floor(Date.now() / 1000) % 100;
const HOUR = 3600_000;

/**
 * Create a competition and assert the outcome, so a fixture failure reads as a
 * fixture failure rather than as the behaviour under test. Returns the parsed
 * body either way — the guard-rail tests deliberately expect a 400.
 */
async function createComp(api, csrf, tag, fields = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: h(csrf),
    data: {
      name: compName(tag),
      start_time: new Date(Date.now() + 24 * HOUR).toISOString(),
      duration_minutes: 60,
      ...fields,
    },
  });
  return { status: r.status(), body: await r.json() };
}

async function mkComp(api, csrf, tag, fields = {}) {
  const { status, body } = await createComp(api, csrf, tag, fields);
  expect(status, `fixture competition "${tag}" created: ${JSON.stringify(body)}`).toBe(200);
  return body.competition.id;
}

// The column is the source of truth: the list endpoint is itself under test
// here, so persistence assertions must not be routed through it.
function storedTrustedIps(compId) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const row = db.prepare("SELECT trusted_network_ips FROM competitions WHERE id=?").get(compId);
    return row ? (row.trusted_network_ips ?? null) : undefined;
  } finally { db.close(); }
}

// Read events straight from the table rather than through
// GET /api/admin/competitions/:id/events, which caches for 5 s — a
// "did a SECOND write add a second event?" assertion served from the cache
// populated by the first read would pass no matter what the write did.
function compEvents(compId, type) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(
      "SELECT event_type, changed_by, details FROM competition_events WHERE competition_id=? AND event_type=? ORDER BY rowid"
    ).all(compId, type).map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  } finally { db.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARD RAILS — what an admin is allowed to type
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Trusted network IPs — entry guard rails (v7.16.0)", () => {
  test("the module's limits are the documented ones", () => {
    expect(MAX_ENTRIES(), "the entry cap is part of the contract, not an implementation detail").toBe(CONTRACT_MAX_ENTRIES);
    expect(MIN_CIDR_BITS(), "the narrowest-prefix rule is what stops a global bypass").toBe(CONTRACT_MIN_CIDR_BITS);
    expect(GRACE_MS(), "the post-competition grace is 2 hours").toBe(CONTRACT_GRACE_MS);
  });

  test("a CIDR broader than /16 is refused, so rate limiting cannot be switched off wholesale", async () => {
    const { api, csrf } = await apiLogin("superadmin");

    for (const broad of ["0.0.0.0/0", "10.0.0.0/8", "172.16.0.0/12", "198.51.0.0/15"]) {
      const { status, body } = await createComp(api, csrf, "broad", { trusted_network_ips: broad });
      expect(status, `${broad} must be refused — it is wider than /${CONTRACT_MIN_CIDR_BITS}`).toBe(400);
      expect(String(body.error), `the refusal names the limit for ${broad}`)
        .toContain(`/${CONTRACT_MIN_CIDR_BITS} is the widest range allowed`);
    }

    // The boundary itself is usable — a rule that refused everything would pass
    // the assertions above while making the feature useless.
    const id = await mkComp(api, csrf, "16", { trusted_network_ips: "198.51.0.0/16" });
    expect(storedTrustedIps(id), "a /16 is accepted and stored verbatim").toBe("198.51.0.0/16");

    await api.dispose();
  });

  test("at most ten entries are accepted", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const ips = n => Array.from({ length: n }, (_, i) => `198.51.100.${i + 1}`).join(",");

    const tooMany = await createComp(api, csrf, "11", { trusted_network_ips: ips(CONTRACT_MAX_ENTRIES + 1) });
    expect(tooMany.status, `${CONTRACT_MAX_ENTRIES + 1} entries must be refused`).toBe(400);
    expect(String(tooMany.body.error)).toContain(`At most ${CONTRACT_MAX_ENTRIES}`);

    const id = await mkComp(api, csrf, "10", { trusted_network_ips: ips(CONTRACT_MAX_ENTRIES) });
    expect(storedTrustedIps(id), "exactly ten entries is fine").toBe(ips(CONTRACT_MAX_ENTRIES));

    await api.dispose();
  });

  test("a value that is not an IP address or CIDR range is refused", async () => {
    const { api, csrf } = await apiLogin("superadmin");

    for (const bad of [
      "not-an-ip",
      "203.0.113.999",              // out-of-range octet
      "203.0.113.1/33",             // prefix length off the end of IPv4
      "198.51.100.1, garbage",      // one good entry does not launder a bad one
      "198.51.100.0/24/24",
    ]) {
      const { status, body } = await createComp(api, csrf, "bad", { trusted_network_ips: bad });
      expect(status, `"${bad}" must be refused`).toBe(400);
      expect(body.error, `"${bad}" is refused with a message the admin can act on`).toBeTruthy();
    }

    // Over the 500-character cap — the field is an operator note, not a feed.
    const long = await createComp(api, csrf, "long", {
      trusted_network_ips: Array.from({ length: 60 }, (_, i) => `198.51.100.${i % 250 + 1}`).join(","),
    });
    expect(long.status, "an over-length value is refused").toBe(400);

    // An IPv6 literal IS accepted (matched exactly — there is no v6 CIDR
    // support), so the check above is rejecting malformed input rather than
    // everything that is not dotted-quad.
    const v6 = await mkComp(api, csrf, "v6", { trusted_network_ips: "2001:db8::1" });
    expect(storedTrustedIps(v6), "an IPv6 literal is stored").toBe("2001:db8::1");

    await api.dispose();
  });

  test("the stored value is canonical — entries are trimmed and de-duplicated", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const id = await mkComp(api, csrf, "canon", {
      trusted_network_ips: " 198.51.100.5 , 198.51.100.5,198.51.100.6 , ",
    });
    expect(storedTrustedIps(id), "whitespace, blanks and the repeat are collapsed")
      .toBe("198.51.100.5,198.51.100.6");
    await api.dispose();
  });

  test("an empty value clears a list that was previously set", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const id = await mkComp(api, csrf, "clear", { trusted_network_ips: "198.51.100.9" });
    expect(storedTrustedIps(id)).toBe("198.51.100.9");

    const r = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "" },
    });
    expect(r.status(), await r.text()).toBe(200);
    expect(storedTrustedIps(id),
      "clearing is a first-class action — COALESCE cannot express it, so the route needs its own write"
    ).toBe(null);

    // And an omitted field leaves the column alone (the COALESCE contract).
    await api.put(`/api/admin/competitions/${id}`, { headers: h(csrf), data: { trusted_network_ips: "198.51.100.9" } });
    await api.put(`/api/admin/competitions/${id}`, { headers: h(csrf), data: { duration_minutes: 75 } });
    expect(storedTrustedIps(id), "a PUT that omits the field must not clear it").toBe("198.51.100.9");

    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IPv6 — REAL validation, and ONE canonical form (ext-audit v7.20.9, F11)
// ═══════════════════════════════════════════════════════════════════════════
//
// Two defects, both silent and both in the same unhelpful direction: the form
// accepted the entry, the admin believed the venue was allowlisted, and the
// bypass never applied.
//
//   1. IPv6 was validated by `/^[0-9a-fA-F:]+$/` plus "contains a colon", which
//      accepts `::::` and `dead:beef:::`. Neither can ever match a real client
//      address, so nothing was let THROUGH — the harm is that the entry occupies
//      a slot and does nothing.
//   2. Entries were stored and compared VERBATIM, so `2001:db8::1` (what the
//      admin typed) and `2001:0DB8:0000:0000:0000:0000:0000:0001` (what a proxy
//      wrote into X-Forwarded-For) were two different entries for one host.
//
// The unit assertions below run against the pure functions because the failure
// is arithmetic on strings; the end-to-end one at the bottom is what proves the
// PRODUCT refuses `::::` and stores the canonical form.
test.describe("Trusted network IPs — IPv6 validation and canonical form (v7.20.9)", () => {
  test("malformed IPv6 is REFUSED, and well-formed IPv6 is still accepted", () => {
    // The rejections alone are satisfied by a validator that refuses
    // EVERYTHING, so the accepted set is the control that keeps them honest.
    for (const bad of ["::::", "dead:beef:::", ":::", "banana", "1.2.3.256", "2001:db8:::1"]) {
      const r = validateTrustedIps(bad);
      expect(r.error,
        `"${bad}" is not an address any client can present. Accepting it is not lenient — ` +
        `it hands the admin an allowlist entry that can never match, with nothing to say so`
      ).toBeTruthy();
      expect(r.value, `"${bad}" must not be stored`).toBeFalsy();
    }

    for (const good of ["2001:db8::1", "::1", "fe80::1"]) {
      const r = validateTrustedIps(good);
      expect(r.error, `"${good}" is a real IPv6 address and must be accepted: ${r.error}`).toBeFalsy();
      expect(r.value, `"${good}" is stored`).toBeTruthy();
    }
  });

  test("a valid IPv6 is stored CANONICALISED, and two renderings of one host de-duplicate", () => {
    // RFC 5952: lowercase hex, maximal `::` compression. The stored value is
    // what the matcher later compares against, so canonicalising at entry is
    // what makes "the address the venue presents" and "the address the admin
    // typed" the same string.
    expect(validateTrustedIps("2001:0DB8:0000:0000:0000:0000:0000:0001").value,
      "the fully-expanded, upper-case rendering is stored in its canonical form"
    ).toBe("2001:db8::1");

    // De-duplication is the observable consequence: three spellings of ONE host
    // used to occupy three of the ten entry slots and produce three allowlist
    // entries, only one of which could ever match.
    expect(validateTrustedIps("2001:db8::1, 2001:0DB8:0000:0000:0000:0000:0000:0001 ,2001:DB8::1").value,
      "one host is one entry however it is written"
    ).toBe("2001:db8::1");

    // An IPv4-mapped address is the same host as its plain IPv4 form — which is
    // what Express reports on a dual-stack socket without TRUST_PROXY.
    expect(validateTrustedIps("::ffff:192.0.2.1").value,
      "an IPv4-mapped address is unwrapped, so it cannot become a second entry for one host"
    ).toBe("192.0.2.1");

    // And the ordinary case is untouched: canonicalising must not rewrite IPv4.
    expect(validateTrustedIps("198.51.100.5,198.51.100.6").value,
      "IPv4 entries are stored exactly as typed"
    ).toBe("198.51.100.5,198.51.100.6");
  });

  test("an IPv6 CIDR names the real constraint, and the /16 floor is unchanged", () => {
    for (const range of ["2001:db8::/32", "2001:db8::/128", "fe80::/10"]) {
      const r = validateTrustedIps(range);
      expect(r.error, `"${range}" is refused`).toBeTruthy();
      expect(r.error,
        "the message must name the real constraint — ranges are IPv4-only here. " +
        `"not a valid IPv4 CIDR range" reads as "you mistyped it" and sends the admin round a loop`
      ).toContain("only IPv4 ranges are supported");
      expect(r.error, `"${range}" is not reported as a typo`).not.toContain("is not a valid IPv4 CIDR range");
    }

    // The IPv4 range rules the IPv6 branch sits in front of are untouched — a
    // reordering that swallowed them would pass every assertion above.
    expect(validateTrustedIps("10.0.0.0/8").error,
      "the widest-prefix guard still refuses a /8"
    ).toContain(`/${CONTRACT_MIN_CIDR_BITS} is the widest range allowed`);
    expect(validateTrustedIps("10.0.0.0/16").value,
      "and a /16 is still accepted, so the feature is not merely refusing everything"
    ).toBe("10.0.0.0/16");
  });

  test("matching is canonical — one host matches however either side is written", () => {
    const { parseIpAllowlist, ipAllowlistMatch } = require("../lib/util");

    // Stored as the admin typed it; presented by the client in three renderings.
    const v6 = parseIpAllowlist("2001:db8::1");
    expect(ipAllowlistMatch(v6, "2001:0db8:0000:0000:0000:0000:0000:0001"),
      "the fully-expanded form is the SAME host — comparing raw strings missed it, " +
      "and the operator's only symptom was 'the allowlist does nothing'"
    ).toBe(true);
    expect(ipAllowlistMatch(v6, "2001:DB8::1"), "case is not part of an IPv6 address").toBe(true);
    expect(ipAllowlistMatch(v6, "2001:db8::1"), "and the identical rendering still matches").toBe(true);
    // The negative control: canonicalising must not collapse DIFFERENT hosts.
    expect(ipAllowlistMatch(v6, "2001:db8::2"),
      "a different address is still a different address"
    ).toBe(false);
    expect(ipAllowlistMatch(v6, "2001:db9::1"), "…and so is a neighbouring prefix").toBe(false);

    // IPv4-mapped: the form Express reports on a dual-stack socket.
    const v4 = parseIpAllowlist("192.0.2.1");
    expect(ipAllowlistMatch(v4, "::ffff:192.0.2.1"),
      "an IPv4-mapped address matches the plain IPv4 entry — it is the same host"
    ).toBe(true);
    expect(ipAllowlistMatch(v4, "::ffff:192.0.2.2"), "but only that host").toBe(false);

    // …and it is tested against IPv4 CIDRs too, not just exact entries.
    const cidr = parseIpAllowlist("192.0.2.0/24");
    expect(ipAllowlistMatch(cidr, "::ffff:192.0.2.77"),
      "an IPv4-mapped address is unwrapped before the range test, or a venue behind a " +
      "dual-stack proxy silently falls outside its own allowlisted range"
    ).toBe(true);
    expect(ipAllowlistMatch(cidr, "::ffff:192.0.3.77"), "an address outside the range is not trusted").toBe(false);
  });

  test("end-to-end: the API refuses `::::` and stores the canonical IPv6", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Trusted IPs are single-session only, so a plain competition (no sessions)
    // is the shape the field is valid on.
    const id = await mkComp(api, csrf, "v6canon", { trusted_network_ips: "2001:db8::5" });
    expect(storedTrustedIps(id), "fixture starts with a valid entry").toBe("2001:db8::5");

    for (const bad of ["::::", "dead:beef:::"]) {
      const r = await api.put(`/api/admin/competitions/${id}`, {
        headers: h(csrf), data: { trusted_network_ips: bad },
      });
      expect(r.status(), `"${bad}" used to be ACCEPTED by the form: ${await r.text()}`).toBe(400);
      expect(String((await r.json()).error), `"${bad}" is refused with a message naming the entry`).toContain(bad);
    }
    expect(storedTrustedIps(id),
      "and the refusal left the live allowlist alone — a rejected save must not clobber it"
    ).toBe("2001:db8::5");

    // A valid but non-canonical rendering is accepted and stored canonically.
    const ok = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "2001:0DB8:0000:0000:0000:0000:0000:0001" },
    });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(storedTrustedIps(id),
      "the column holds the canonical form — it is what the matcher compares a client address against"
    ).toBe("2001:db8::1");

    // What the admin reads back is the canonical form too, so the UI cannot
    // show one string while the matcher uses another.
    const comps = await (await api.get("/api/admin/competitions")).json();
    const row = comps.find(c => c.id === id);
    expect(row, "the fixture competition is listed").toBeTruthy();
    expect(row.trusted_network_ips, "the admin list ships the canonical value").toBe("2001:db8::1");

    // And the audit trail records what is actually in force — a trail carrying
    // the raw entry would not answer "which address was trusted".
    const changes = compEvents(id, "trusted_networks_changed");
    expect(changes.length, "the change is recorded").toBeGreaterThan(0);
    expect((changes[changes.length - 1].details || {}).to,
      "the audit event records the canonical value, not the operator's rendering"
    ).toBe("2001:db8::1");

    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE-SESSION ONLY — enforced from both directions
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Trusted network IPs are single-session only (v7.16.0)", () => {
  test("setting trusted IPs on a competition that HAS sessions is refused", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const id = await mkComp(api, csrf, "multi");

    const ts = await api.post(`/api/admin/competitions/${id}/timeslots`, {
      headers: h(csrf),
      data: { name: "Morning", start_time: new Date(Date.now() + 25 * HOUR).toISOString(), duration_minutes: 60 },
    });
    expect(ts.status(), `fixture session created: ${await ts.text()}`).toBe(200);

    const r = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "198.51.100.50" },
    });
    expect(r.status(), "a multi-session competition has no single venue address").toBe(400);
    expect(String((await r.json()).error)).toContain("single-session");
    expect(storedTrustedIps(id), "and nothing was written").toBe(null);

    // The refusal is scoped to the FIELD, not a blanket block on editing a
    // competition that has sessions.
    const other = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { duration_minutes: 90 },
    });
    expect(other.status(), "an unrelated edit still works").toBe(200);

    await api.dispose();
  });

  test("adding a session to a competition that HAS trusted IPs is refused", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const id = await mkComp(api, csrf, "single", { trusted_network_ips: "198.51.100.51" });

    const r = await api.post(`/api/admin/competitions/${id}/timeslots`, {
      headers: h(csrf),
      data: { name: "Morning", start_time: new Date(Date.now() + 25 * HOUR).toISOString(), duration_minutes: 60 },
    });
    expect(r.status(),
      "silently dropping the setting — or leaving it attached to a shape it was never validated for — is worse than an error"
    ).toBe(400);
    expect(String((await r.json()).error)).toContain("trusted network");

    const slots = await (await api.get(`/api/admin/competitions/${id}/timeslots`)).json();
    expect(slots.length, "and no session was created").toBe(0);

    // Clear the trusted networks and the same request now succeeds — which is
    // exactly the remedy the error message names.
    await api.put(`/api/admin/competitions/${id}`, { headers: h(csrf), data: { trusted_network_ips: "" } });
    const retry = await api.post(`/api/admin/competitions/${id}/timeslots`, {
      headers: h(csrf),
      data: { name: "Morning", start_time: new Date(Date.now() + 25 * HOUR).toISOString(), duration_minutes: 60 },
    });
    expect(retry.status(), `the documented remedy works: ${await retry.text()}`).toBe(200);

    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WIRE EXPOSURE — the list ships it, the write responses do not
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Trusted network IPs on the wire (v7.16.0)", () => {
  test("the admin competition list ships trusted_network_ips", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const id = await mkComp(api, csrf, "wire", { trusted_network_ips: "198.51.100.60,198.51.100.61" });

    const comps = await (await api.get("/api/admin/competitions")).json();
    const row = comps.find(c => c.id === id);
    expect(row, "the fixture competition is listed").toBeTruthy();
    expect(row.trusted_network_ips,
      "the admin UI renders this field, so the list is the endpoint that has to carry it"
    ).toBe("198.51.100.60,198.51.100.61");

    await api.dispose();
  });

  test("the create and edit responses do NOT echo trusted_network_ips", async () => {
    const { api, csrf } = await apiLogin("superadmin");

    const created = await createComp(api, csrf, "nowire", { trusted_network_ips: "198.51.100.70" });
    expect(created.status).toBe(200);
    expect(Object.keys(created.body.competition),
      "_compWire strips it from every spread of a SELECT * competition row — deliberate, like self_enroll_token and the CxOne key"
    ).not.toContain("trusted_network_ips");

    const id = created.body.competition.id;
    const put = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "198.51.100.71" },
    });
    expect(put.status(), await put.text()).toBe(200);
    const putBody = await put.json();
    expect(Object.keys(putBody.competition), "same on the edit response").not.toContain("trusted_network_ips");
    // The write itself landed — this test must not be satisfiable by the PUT
    // simply doing nothing.
    expect(storedTrustedIps(id)).toBe("198.51.100.71");

    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE EFFECTIVE WINDOW — the constraint that makes the bypass self-expiring
// ═══════════════════════════════════════════════════════════════════════════
test.describe("The trusted-network window (v7.16.0)", () => {
  test("the whole lifecycle of a bypass is auditable", async () => {
    // A trusted network is a rate-limit BYPASS, so every point at which one can
    // come into existence, change or be used has to be reconstructable after
    // the fact. Creating a competition with one already set was the gap: the
    // `created` event listed every other field and silently omitted this one,
    // so a competition BORN with a bypass showed no trace of where it came from
    // — only later edits were recorded.
    const { api, csrf } = await apiLogin("superadmin");
    const born = await mkComp(api, csrf, "auditborn", {
      start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 60,
      trusted_network_ips: "203.0.113.30",
    });
    const created = compEvents(born, "created");
    expect(created.length, "the create is recorded").toBeGreaterThan(0);
    expect((created[0].details || {}).trusted_network_ips,
      "the CREATE event must name the bypass the competition was born with"
    ).toBe("203.0.113.30");

    // Change it, then clear it — each is its own recorded event carrying the
    // before and after, so the trail answers "who opened this, and when".
    const upd = async (val) => {
      const cur = await (await api.get("/api/admin/competitions")).json();
      const row = (cur.competitions || cur).find(c => c.id === born);
      const r = await api.put(`/api/admin/competitions/${born}`, {
        headers: h(csrf),
        data: { trusted_network_ips: val, expectedUpdatedAt: row && row.updated_at },
      });
      expect(r.ok(), `set trusted IPs to ${JSON.stringify(val)}: ${r.status()}`).toBeTruthy();
    };
    await upd("203.0.113.31");
    await upd("");

    const changes = compEvents(born, "trusted_networks_changed");
    expect(changes.length, "both the change and the clear are recorded").toBeGreaterThanOrEqual(2);
    const details = changes.map(e => e.details || {});   // compEvents already parses
    expect(details.some(d => d.to === "203.0.113.31"), "the change records what it became").toBe(true);
    expect(details.some(d => d.from === "203.0.113.31" && d.to === null),
      "the CLEAR records what was removed — otherwise the trail loses the value that was live"
    ).toBe(true);
    for (const d of details) {
      expect(d, "each carries the request context, like every other admin lifecycle event").toHaveProperty("ip");
    }
    await api.dispose();
  });

  test("a transient read error does not permanently disable the allowlist", async () => {
    // The cache used to swallow a build failure as `_cache = []`. That leaves
    // _cache non-null, so _build() is never retried and ONE transient read
    // error — an SQLITE_BUSY under load is the obvious candidate — silently
    // disables every trusted network until the next competition write happens
    // to invalidate it. Mid-event that is indistinguishable from "the feature
    // does not work", and nothing appears in the logs.
    //
    // This was not theoretical: it is the most likely cause of a CI-only flake
    // where the window assertions below returned null on the first attempt and
    // passed on the retry.
    const db = require("../db");
    const realPrepare = db.prepare.bind(db);
    let failNext = true, reads = 0;
    db.prepare = (sql) => {
      if (/trusted_network_ips/.test(sql)) {
        reads++;
        if (failNext) throw new Error("SQLITE_BUSY (simulated)");
      }
      return realPrepare(sql);
    };
    try {
      invalidateCompAllowlist();
      expect(competitionAllowlistMatch("203.0.113.7"),
        "a failed read must fail CLOSED for this request — the limiter stays on"
      ).toBe(null);
      const afterFailure = reads;
      failNext = false;
      competitionAllowlistMatch("203.0.113.7");
      expect(reads,
        "the very next lookup must RE-READ. Caching the failure would leave the bypass dead until " +
        "the next competition write, with nothing in the logs to say why."
      ).toBeGreaterThan(afterFailure);
    } finally {
      db.prepare = realPrepare;
      invalidateCompAllowlist();
    }
  });

  test("is inert before the start, live during, and expires 2 h after the end", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const startMs = Date.now() + 24 * HOUR;
    const durationMin = 180;
    const endMs = startMs + durationMin * 60_000;

    // A UNIQUE third octet per run. competitionAllowlistMatch scans EVERY
    // competition carrying trusted IPs and returns the first whose window
    // covers `now`, so a fixed address collides with the competition left
    // behind by an earlier attempt: under CI's RETRIES=1 the retry matched the
    // FIRST attempt's competition and the id assertion failed against a
    // perfectly working matcher. Uniqueness is what makes "which competition
    // granted the bypass" answerable at all.
    const oct = 100 + (_windowSeq++ % 100);
    const EXACT = `203.0.${oct}.7`;         // listed literally
    const IN_CIDR = `203.0.${oct}.200`;     // inside the /25 below
    const OUTSIDE = "192.0.2.55";           // listed by nothing in this file

    const id = await mkComp(api, csrf, "window", {
      start_time: new Date(startMs).toISOString(),
      duration_minutes: durationMin,
      trusted_network_ips: `${EXACT},203.0.${oct}.128/25`,
    });
    // The list is read from an in-process cache on every rate-limited request,
    // so a DB write behind its back has to bust it.
    invalidateCompAllowlist();

    // POSITIVE CONTROL FIRST, with a bounded retry — and both halves of that
    // matter.
    //
    // This test calls the matcher IN THE TEST PROCESS, which opens the same
    // SQLite file the server process is writing to, so `_build()` can hit a
    // transient read error under a loaded WORKERS=8 run. By design that fails
    // CLOSED (returns null, leaves the cache unset so the next call retries) —
    // correct product behaviour, but it makes a single sampled call an
    // unreliable witness, which is what flaked here twice.
    //
    // It also makes every NEGATIVE assertion below vacuous under that error: a
    // failed build returns null, which is exactly what "inert before the start"
    // expects. So establish a working cache and assert the positive case FIRST;
    // only then are the nulls below evidence of the window rather than of a
    // failed read.
    let during = null;
    // 10 attempts with a growing gap: this process is a SECOND SQLite
    // connection reading what the server process just wrote, and the module
    // fails closed on a transient read (by design, v7.16.4). 5 × 150ms was
    // still occasionally short under a loaded WORKERS=8 run.
    for (let i = 0; i < 10 && !during; i++) {
      during = competitionAllowlistMatch(EXACT, startMs + 60_000);
      if (!during) {
        invalidateCompAllowlist();
        // Half-way through, rebind the MODULE as well as busting its cache.
        // Retrying can only fix a transient READ; if this process is holding a
        // handle to an unlinked inode (the v7.20.2 failure — db.js opens the
        // file at require time) every attempt reads the same dead file and a
        // longer loop is just a slower null. Dropping the app modules from the
        // require cache forces db.js to reopen the path.
        if (i === 4) {
          for (const k of Object.keys(require.cache)) {
            if (/\/(db|lib\/comp-allowlist)\.js$/.test(k)) delete require.cache[k];
          }
        }
        // The retries need TIME between them, not just repetition: this process
        // is a second SQLite connection reading what the server process just
        // wrote, and a transient read error leaves the cache unbuilt by design.
        // Five attempts in the same microsecond are one attempt.
        await new Promise((r) => setTimeout(r, 100 + i * 100));
      }
    }
    // A bare toBeTruthy() here reports only "Received: null", which is what this
    // has failed with twice while two different explanations stayed live. Dump
    // what this process can actually SEE, so the next occurrence answers itself:
    // no rows at all means a dead handle, rows with the wrong window means the
    // arithmetic, rows carrying a different address means an octet collision.
    let _diag = "";
    if (!during) {
      try {
        const rows = require("../db").prepare(
          "SELECT id, name, start_time, duration_minutes, trusted_network_ips FROM competitions WHERE trusted_network_ips IS NOT NULL AND trusted_network_ips != ''"
        ).all();
        _diag = ` — this process sees ${rows.length} competition(s) with trusted IPs: ${JSON.stringify(rows)}; looking for ${EXACT} at ${new Date(startMs + 60_000).toISOString()}`;
      } catch (e) { _diag = ` — and reading the competitions table from this process THREW: ${e.message}`; }
    }
    expect(during, `live once the competition starts (after 10 attempts)${_diag}`).toBeTruthy();

    expect(competitionAllowlistMatch(EXACT, startMs - 60_000),
      "inert BEFORE the competition starts — an admin cannot pre-open a bypass"
    ).toBe(null);

    expect(during.id,
      "the match returns WHICH competition granted the bypass, so the audit trail and the alert can say so"
    ).toBe(id);

    expect(competitionAllowlistMatch(IN_CIDR, startMs + 60_000),
      "a CIDR entry covers its whole range"
    ).toBeTruthy();
    expect(competitionAllowlistMatch(OUTSIDE, startMs + 60_000),
      "an address nobody listed is never trusted"
    ).toBe(null);

    expect(competitionAllowlistMatch(EXACT, endMs + CONTRACT_GRACE_MS - 60_000),
      "still live through the 2 h grace — teardown and stragglers must not start tripping the limiter"
    ).toBeTruthy();
    expect(competitionAllowlistMatch(EXACT, endMs + CONTRACT_GRACE_MS + 60_000),
      "and then it closes on its own, so a forgotten entry is not a permanent hole"
    ).toBe(null);

    // With no injected `now` the caller gets real time — and this competition
    // is 24 h out, so it is inert right now.
    expect(competitionAllowlistMatch(EXACT),
      "the default `now` is real time, not 'always on'"
    ).toBe(null);

    await api.dispose();
  });

  test("the grace runs from ended_at when one was recorded, not from the schedule", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Unique per run, for the same reason as the window test above: the matcher
    // scans every competition with trusted IPs, so a fixed address would let a
    // retry's leftover competition answer for this one.
    const IP = `203.0.${100 + (_windowSeq++ % 100)}.20`;
    // A competition whose SCHEDULE expired long ago (4 h back, 30 min long) but
    // which was never closed out — the ordinary "the scheduler hasn't caught up
    // / it was created in the past" row. Its schedule-derived window, grace
    // included, shut 90 minutes ago.
    //
    // The shape matters: `end-now` on a LIVE competition also truncates
    // duration_minutes to the elapsed time, which leaves start+duration equal
    // to ended_at and makes the two branches of _endMs indistinguishable — a
    // first draft of this test did exactly that and passed with the ended_at
    // branch disabled. The idempotent close taken here leaves duration alone,
    // so the two branches give answers 3 hours apart.
    const id = await mkComp(api, csrf, "endnow", {
      start_time: new Date(Date.now() - 240 * 60_000).toISOString(),
      duration_minutes: 30,
      trusted_network_ips: IP,
    });
    invalidateCompAllowlist();
    expect(competitionAllowlistMatch(IP),
      "a long-expired schedule is not trusted — the window really did close"
    ).toBe(null);

    const end = await api.post(`/api/admin/competitions/${id}/end-now`, { headers: h(csrf), data: {} });
    expect(end.status(), `fixture closed out: ${await end.text()}`).toBe(200);
    invalidateCompAllowlist();

    const db = new Database(TEST_DB_PATH, { readonly: true });
    let row;
    try { row = db.prepare("SELECT ended_at, duration_minutes FROM competitions WHERE id=?").get(id); }
    finally { db.close(); }
    expect(row.duration_minutes,
      "the fixture is only discriminating while the schedule stays where it was"
    ).toBe(30);
    const endedAt = new Date(row.ended_at).getTime();

    expect(competitionAllowlistMatch(IP),
      "recording an explicit end restarts the grace from that moment"
    ).toBeTruthy();
    expect(competitionAllowlistMatch(IP, endedAt + CONTRACT_GRACE_MS - 60_000),
      "…and it runs the full 2 hours from ended_at"
    ).toBeTruthy();
    expect(competitionAllowlistMatch(IP, endedAt + CONTRACT_GRACE_MS + 60_000),
      "…then closes, exactly as it does for a schedule-derived end"
    ).toBe(null);

    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════════════════
test.describe("Trusted network changes are audited (v7.16.0)", () => {
  test("setting, changing and clearing each record a trusted_networks_changed event", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const id = await mkComp(api, csrf, "audit");
    expect(compEvents(id, "trusted_networks_changed").length, "nothing recorded before the first change").toBe(0);

    const set = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "198.51.100.77" },
    });
    expect(set.status(), await set.text()).toBe(200);

    let evs = compEvents(id, "trusted_networks_changed");
    expect(evs.length, "setting the list is recorded").toBe(1);
    expect(evs[0].changed_by, "attributed to the acting admin").toBe("superadmin");
    expect(evs[0].details.from, "the previous value is on the record").toBe(null);
    expect(evs[0].details.to).toBe("198.51.100.77");
    expect(evs[0].details.grace_ms,
      "the event states how long the bypass outlives the competition, so the trail is readable without the source"
    ).toBe(GRACE_MS());
    expect(evs[0].details.ip, "reqContext is attached, like every other admin entity edit").toBeTruthy();

    // A no-op save records nothing — an audit trail full of "changed: X → X"
    // rows is an audit trail nobody reads.
    const noop = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "198.51.100.77" },
    });
    expect(noop.status(), await noop.text()).toBe(200);
    expect(compEvents(id, "trusted_networks_changed").length, "an unchanged value records nothing").toBe(1);

    const cleared = await api.put(`/api/admin/competitions/${id}`, {
      headers: h(csrf), data: { trusted_network_ips: "" },
    });
    expect(cleared.status(), await cleared.text()).toBe(200);
    evs = compEvents(id, "trusted_networks_changed");
    expect(evs.length, "clearing is a change too").toBe(2);
    expect(evs[1].details.from).toBe("198.51.100.77");
    expect(evs[1].details.to, "removal is recorded as an explicit null").toBe(null);

    // And it reaches the wire the per-competition History dialog reads.
    const wire = await (await api.get(`/api/admin/competitions/${id}/events`)).json();
    expect(wire.map(e => e.event_type)).toContain("trusted_networks_changed");

    await api.dispose();
  });

  // v7.21.7 — the cache also has a 5 s TTL, as a BACKSTOP for the WINDOW inputs.
  // start_time / duration_minutes / ended_at are written by eight sites across
  // three files that know nothing about lib/comp-allowlist (end-now both
  // branches, the competition DELETE, the all-solved auto-end, the assign-driven
  // revive, and any PUT that moves the schedule without touching the IP field).
  // Enumerating those by hand is the failure mode this repo keeps rediscovering,
  // and a missed one fails in the UNSAFE direction — a deleted competition's
  // addresses keep bypassing the limiter.
  test("v7.21.7: a window change by a writer this module never hears about expires from the cache", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Unique octet per run: competitionAllowlistMatch scans EVERY competition
    // with trusted IPs and returns the first whose window covers `now`, so a
    // fixed address matches a retry's leftover competition (v7.16.1).
    const oct = 100 + (_windowSeq++ % 100);
    const ip = `203.0.${oct}.42`;
    const startMs = Date.now() - 60_000;
    const id = await mkComp(api, csrf, "ttl", {
      start_time: new Date(startMs).toISOString(), duration_minutes: 180, trusted_network_ips: ip,
    });
    try {
      // POSITIVE CONTROL first, with the file's bounded-retry shape: every
      // negative assertion below is vacuous under a transient read error, which
      // is the documented v7.16.4 behaviour (fail closed, return null).
      _ca().invalidateCompAllowlist();
      let live = null;
      for (let i = 0; i < 10 && !live; i++) {
        live = _ca().competitionAllowlistMatch(ip, Date.now());
        if (!live) {
          _ca().invalidateCompAllowlist();
          await new Promise(r => setTimeout(r, 100 + i * 100));
        }
      }
      expect(live && live.id, "control: the address is allowlisted while the competition is live").toBe(id);

      // end-now writes ended_at — a writer with NO invalidation call anywhere.
      const en = await api.post(`/api/admin/competitions/${id}/end-now`, { headers: h(csrf) });
      expect(en.status(), await en.text()).toBe(200);

      // WITHOUT calling invalidateCompAllowlist, the stale window must expire.
      // Probe past the ended instant + the 2 h grace: a cache still holding the
      // ORIGINAL scheduled end would keep matching there.
      const beyond = Date.now() + GRACE_MS() + 5 * 60_000;
      await expect.poll(() => _ca().competitionAllowlistMatch(ip, beyond) === null,
        { timeout: 15000, intervals: [500, 1000, 1500, 2000] }
      ).toBe(true);
    } finally { await api.dispose(); }
  });

  test("v7.21.7: a FAILED build does not stamp the TTL — the next call re-reads immediately", () => {
    // Caching a failure converts a transient error into a permanent one
    // (v7.16.4). The TTL must not accidentally re-introduce that by stamping
    // _cacheAt on the throw path.
    const mod = _ca();
    const db = require("../db");
    mod.invalidateCompAllowlist();
    const realPrepare = db.prepare.bind(db);
    let threw = 0, reread = 0;
    db.prepare = () => { threw++; throw new Error("SQLITE_BUSY (simulated)"); };
    try {
      expect(mod.competitionAllowlistMatch("203.0.113.1", Date.now()),
        "a failed build fails CLOSED for this request").toBe(null);
    } finally {
      // Restore with a COUNTER, not the bare function: the assertion below is
      // whether the NEXT lookup actually reaches the database. Restoring plainly
      // and re-checking `threw` is vacuous — the stub can no longer fire, so the
      // count cannot move whether it re-read or served a stamped-empty cache.
      // (That is exactly how the first draft of this test passed its mutation.)
      db.prepare = (...a) => { reread++; return realPrepare(...a); };
    }
    expect(threw, "the stub was actually reached").toBeGreaterThan(0);
    try {
      mod.competitionAllowlistMatch("203.0.113.1", Date.now());
      expect(reread,
        "no time has passed, so a _cacheAt stamped on the FAILURE path would serve a cached " +
        "(empty) answer — the next lookup must re-read instead"
      ).toBeGreaterThan(0);
    } finally { db.prepare = realPrepare; }
  });
});
