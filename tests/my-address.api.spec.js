"use strict";

// USE MY CURRENT ADDRESS — the server half (GET /api/admin/my-address).
//
// An organiser standing in the venue, on its network, reaches the platform from
// the venue's egress address: the one an event's Trusted network IPs wants. The
// route answers the address this request arrived from (`req.ip`, canonical) and
// the RANGE it belongs to; the event form adds only a `public` one.
//
//   1. lib/util.js `ipAddressRange` names each range, on both sides of every
//      boundary, judging an address in its canonical form (an IPv4-mapped
//      address as the IPv4 one it is); the event form's words for the ranges
//      (`_MY_ADDRESS_RANGE_WORDS`) are keyed by exactly the names it exports
//      (`IP_RANGE_NAMES`), both ways;
//   2. an admin's GET answers its own address with its range, never cached: on
//      this shared server every client is 127.0.0.1 (it listens on IPv4), so
//      the loopback answer is what a misconfigured proxy looks like;
//   3. who may ask: the gate asks `events.edit` (the event PUT's permission). A
//      built-in event admin may, whatever events it organises (the route names
//      none), as may the built-in admin and a custom role holding it; a custom
//      role without it is refused `permission_denied` by name, a participant and
//      an anonymous caller are refused;
//   4. an organiser's impersonated panel keeps it (the guard is requireAdmin, not
//      requirePermission, which refuses every request through a seat while the
//      event form still saves there), and a participant view does not.
//
// The canonical forms a proxy writes (an IPv4-mapped address, an uncompressed
// IPv6 one) need TRUST_PROXY, so they are driven against a server of their own
// in tests/trusted-networks-e2e.api.spec.js.

const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { apiLogin, freshCtx, PARTICIPANT_PASS } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");
const { stripJsComments } = require("./doc-registry");

const ROUTE = "/api/admin/my-address";
async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }

test.describe("Use my current address — the range of an address", () => {
  // The matrix both arms read. lib/util.js is pure and reaches no database, so
  // it is asked in process.
  const CASES = [
    // loopback
    ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"], ["128.0.0.1", "public"],
    // private (RFC 1918, IPv6 unique-local), each edge
    ["10.0.0.0", "private"], ["10.255.255.255", "private"], ["11.0.0.1", "public"], ["9.255.255.255", "public"],
    ["172.15.255.255", "public"], ["172.16.0.0", "private"], ["172.31.255.255", "private"], ["172.32.0.0", "public"],
    ["192.167.255.255", "public"], ["192.168.0.1", "private"], ["192.168.255.255", "private"], ["192.169.0.0", "public"],
    ["fc00::1", "private"], ["fd12:3456::1", "private"], ["fbff::1", "public"], ["fe00::1", "public"],
    ["::ffff:10.1.2.3", "private"], ["::FFFF:192.168.4.5", "private"],
    // link-local
    ["169.254.0.1", "link_local"], ["169.253.255.255", "public"], ["169.255.0.1", "public"],
    ["fe80::1", "link_local"], ["fe80::1%eth0", "link_local"], ["febf::1", "link_local"], ["fec0::1", "public"],
    // shared (RFC 6598)
    ["100.63.255.255", "public"], ["100.64.0.0", "shared"], ["100.127.255.255", "shared"], ["100.128.0.0", "public"],
    // unspecified
    ["0.0.0.0", "unspecified"], ["0.1.2.3", "unspecified"], ["::", "unspecified"], ["1.0.0.0", "public"],
    // public, documentation ranges included (what the examples and fixtures use)
    ["203.0.113.7", "public"], ["198.51.100.9", "public"], ["192.0.2.1", "public"], ["8.8.8.8", "public"],
    ["2001:db8::1", "public"], ["2001:0DB8:0000:0000:0000:0000:0000:0001", "public"], ["::ffff:8.8.8.8", "public"],
    // not an address
    ["", "unknown"], [null, "unknown"], [undefined, "unknown"], ["garbage", "unknown"], ["1.2.3", "unknown"],
    ["256.1.1.1", "unknown"], ["::::", "unknown"],
  ];

  test("ipAddressRange names each range on both sides of its boundaries, in canonical form", () => {
    const { ipAddressRange } = require("../lib/util");
    const wrong = CASES.filter(([ip, want]) => ipAddressRange(ip) !== want)
      .map(([ip, want]) => `${JSON.stringify(ip)}: ${ipAddressRange(ip)}, wanted ${want}`);
    expect(wrong, "every address lands in its range").toEqual([]);
    // Anti-vacuity: every range is reached, so a classifier answering one word
    // for everything cannot pass.
    expect(new Set(CASES.map(([, w]) => w))).toEqual(new Set(["loopback", "private", "link_local", "shared", "unspecified", "public", "unknown"]));
  });

  // The event form words each range itself (public/js cannot import lib/), so its
  // table is a mirror (CLAUDE.md, Client/server mirror registry): a range the
  // server names and the form lacks reads "an address it cannot place", and a
  // word for a name the server never answers is dead. `public` is the one range
  // the form adds rather than words, and `unknown` is not a range.
  test("the event form words exactly the ranges the server names, both ways", () => {
    const { ipAddressRange, IP_RANGE_NAMES } = require("../lib/util");
    expect(Array.isArray(IP_RANGE_NAMES) && Object.isFrozen(IP_RANGE_NAMES), "PRECONDITION: lib/util.js exports the frozen list").toBe(true);
    expect(IP_RANGE_NAMES.length, "anti-vacuity: the server names ranges").toBeGreaterThanOrEqual(3);

    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "competitions-admin.js"), "utf8"));
    const table = src.match(/\bconst\s+_MY_ADDRESS_RANGE_WORDS\s*=\s*\{([^}]*)\}/);
    expect(table, "anti-vacuity: the form's table is found").toBeTruthy();
    const pairs = [...table[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^'\\]*)'/g)];
    expect(table[1].replace(/([A-Za-z_$][\w$]*)\s*:\s*'([^'\\]*)'/g, "").replace(/[\s,]/g, ""),
      "every entry of the table is a name and its plain words, so none is missed").toBe("");
    const keys = pairs.map((p) => p[1]);
    expect(keys.length, "anti-vacuity: the table's entries are read").toBeGreaterThanOrEqual(3);
    expect(new Set(keys).size, "no range is worded twice").toBe(keys.length);
    expect({
      unworded: IP_RANGE_NAMES.filter((n) => !keys.includes(n)),
      unknownToServer: keys.filter((k) => !IP_RANGE_NAMES.includes(k)),
    }, "the form's words are keyed by exactly the server's range names").toEqual({ unworded: [], unknownToServer: [] });
    for (const [, k, words] of pairs) expect(words.trim(), `the words for ${k}`).not.toBe("");

    // …and the exported list is the classifier's own: every non-public answer it
    // gives across the matrix, and nothing else.
    const answered = new Set(CASES.map(([ip]) => ipAddressRange(ip)).filter((r) => r !== "public" && r !== "unknown"));
    expect([...IP_RANGE_NAMES].sort(), "IP_RANGE_NAMES is every range ipAddressRange answers besides public").toEqual([...answered].sort());
  });
});

test.describe("Use my current address — GET /api/admin/my-address", () => {
  let sa, saCsrf, ea, zeroEa, regAdmin, part, editRole, viewRole, creatorRole, editHolder, viewHolder, creatorHolder, comp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "myaddr");
    // A built-in event admin organising one event, and one organising none.
    ea = await makeParticipant(sa, saCsrf, "myaddrea");
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
    zeroEa = await makeParticipant(sa, saCsrf, "myaddrzero");
    const zr = await sa.post(`/api/admin/participants/${zeroEa.id}/role`, { headers: H(saCsrf), data: { role: "event_admin" } });
    expect(zr.ok(), `zero-grant event admin: ${zr.status()} ${await zr.text()}`).toBeTruthy();
    regAdmin = await makeParticipant(sa, saCsrf, "myaddradmin");
    const ar = await sa.post(`/api/admin/participants/${regAdmin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(ar.ok(), `promote admin: ${ar.status()} ${await ar.text()}`).toBeTruthy();
    part = await makeParticipant(sa, saCsrf, "myaddrpart");
    const stamp = Date.now();
    const mkRole = async (label, scope_mode, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${stamp}`, scope_mode, permissions } });
      expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).role;
    };
    // Scoped to its events and holding NONE: the route names no event.
    editRole = await mkRole("Address editor", "granted", ["events.view", "events.edit"]);
    viewRole = await mkRole("Address viewer", "all", ["events.view"]);
    // May create events (whose form carries the field) but not edit them.
    creatorRole = await mkRole("Address creator", "all", ["events.view", "events.create"]);
    const give = async (label, role) => {
      const u = await makeParticipant(sa, saCsrf, label);
      const r = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: role.id } });
      expect(r.ok(), `assign ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return u;
    };
    editHolder = await give("myaddredit", editRole);
    viewHolder = await give("myaddrview", viewRole);
    creatorHolder = await give("myaddrcreate", creatorRole);
  });
  test.afterAll(async () => { if (sa) await sa.dispose(); });

  test("an admin reads its own address, canonical, with its range, never cached", async () => {
    const r = await sa.get(ROUTE);
    expect(r.status(), await r.text()).toBe(200);
    // This server listens on IPv4 and every client is this machine: the loopback
    // answer, exactly what a proxy on the server's own host looks like.
    expect(await r.json()).toEqual({ ip: "127.0.0.1", range: "loopback" });
    expect(r.headers()["cache-control"], "the answer describes this request, so nothing may keep it").toBe("no-store");
  });

  test("events.edit decides: event admins (with or without events), admins and a role holding it read it; a role without it is refused by name", async () => {
    const asks = async (who) => {
      const l = await apiLogin(who.email, PARTICIPANT_PASS);
      try {
        const r = await l.api.get(ROUTE);
        return { status: r.status(), body: await json(r) };
      } finally { await l.api.dispose(); }
    };
    const admitted = { ea, zeroEa, regAdmin, editHolder };
    for (const [label, who] of Object.entries(admitted)) {
      const got = await asks(who);
      expect(got, `${label} holds events.edit and reads its own address`).toEqual({ status: 200, body: { ip: "127.0.0.1", range: "loopback" } });
    }
    for (const [label, who] of Object.entries({ viewHolder, creatorHolder })) {
      const got = await asks(who);
      expect(got.status, `${label} lacks events.edit: ${JSON.stringify(got.body)}`).toBe(403);
      expect(got.body.code, `${label}: refused at the gate, naming the permission`).toBe("permission_denied");
      expect(got.body.permission).toBe("events.edit");
      expect(JSON.stringify(got.body), `${label}: no address in a refusal`).not.toContain("127.0.0.1");
    }
    // A participant is no admin at all; an anonymous caller has no session.
    const p = await asks(part);
    expect(p.status, `a participant: ${JSON.stringify(p.body)}`).toBe(403);
    expect(p.body).toEqual({ error: "Forbidden" });
    const { api: anon } = await freshCtx();
    try {
      const r = await anon.get(ROUTE);
      expect(r.status()).toBe(401);
      expect(await r.json()).toEqual({ error: "Not authenticated" });
    } finally { await anon.dispose(); }
  });

  test("an organiser's impersonated panel keeps it; a participant view does not", async () => {
    // The acting superadmin's own session, apart from the fixture's.
    const s = await apiLogin("superadmin");
    try {
      const imp = await s.api.post(`/api/admin/participants/${ea.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
      expect(imp.status(), `enter the organiser's panel: ${await imp.text()}`).toBe(200);
      expect(await imp.json(), "PRECONDITION: the organiser's own panel").toMatchObject({ ok: true, view: "admin", target: { id: ea.id, role: "event_admin" } });
      const inPanel = await s.api.get(ROUTE);
      expect(inPanel.status(), `in the panel, where the event form still saves: ${await inPanel.text()}`).toBe(200);
      expect(await inPanel.json()).toEqual({ ip: "127.0.0.1", range: "loopback" });
      let csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
      const out = await s.api.post("/api/impersonation/exit", { headers: H(csrf) });
      expect(out.ok(), `leave the panel: ${out.status()}`).toBeTruthy();

      // CONTROL: the same acting admin viewing as a participant is refused.
      csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
      const imp2 = await s.api.post(`/api/admin/participants/${part.id}/impersonate`, { headers: H(csrf), data: {} });
      expect(imp2.status(), `view as the participant: ${await imp2.text()}`).toBe(200);
      const asPart = await s.api.get(ROUTE);
      expect(asPart.status(), "a participant view has no admin form to fill").toBe(403);
      csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
      const out2 = await s.api.post("/api/impersonation/exit", { headers: H(csrf) });
      expect(out2.ok(), `leave the participant view: ${out2.status()}`).toBeTruthy();
    } finally { await s.api.dispose(); }
  });
});
