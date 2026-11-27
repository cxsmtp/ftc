// @ts-check
// v7.16.0 — operator alerts for an IP ban that lands during a live competition.
//
// The subsystem exists because the scanner-reputation block is SILENT: a venue's
// whole room shares one NAT egress address, so one burst of 4xx locks everyone
// out and the admin sees nothing explaining it. These tests pin the three things
// that make the alert trustworthy — that it reaches somebody, that clearing it
// has the right blast radius, and that it goes away on its own.
//
// Most of the coverage is at the unit level, deliberately. lib/admin-alerts.js
// keeps its state in process (see its header for why), so the module required
// HERE is a separate instance from the running server's — which is what lets a
// test drive the clock, the session count and the mail transport directly
// instead of trying to reproduce a 100-request scanner burst. It also means the
// unit tests cannot perturb the server, or each other's HTTP assertions.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, PORT_BASE } = require("./helpers");
const { spawn } = require("child_process");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const os = require("os");
const path = require("path");
const alerts = require("../lib/admin-alerts");
// v8.3.20 — the shared mail formatter the alert copy now uses. lib/time.js is a
// zero-dependency leaf (no db, no fs, no log), so requiring it at module scope
// is safe under the v7.20.2 / v7.21.14 spec rules.
const { formatEmailDate } = require("../lib/time");

test.use({ baseURL: BASE });

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

const MIN = 60_000;
// A block that is comfortably in force, so listOpenAlerts' "still blocked" filter
// is not what a test is accidentally measuring.
const openBlock = () => Date.now() + 15 * MIN;

function mkAlert(over = {}) {
  const a = alerts.recordIpBanAlert({
    ip: "203.0.113.7",
    blockedUntil: openBlock(),
    count4xx: 137,
    competition: { id: "comp-1", name: "Venue Cup" },
    alreadyTrusted: false,
    ...over,
  });
  if (!a) throw new Error("recordIpBanAlert returned null — state leaked between tests?");
  return a;
}

const ipsFor = (who, now) => alerts.listOpenAlerts(who, now).map(a => a.ip);

// ── unit: the alert store ────────────────────────────────────────────────────
// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("IP-ban alert store (v7.16.0)", () => {
  test.beforeEach(() => alerts._clearAllAlertsForTests());
  test.afterEach(() => alerts._clearAllAlertsForTests());

  test("a recorded alert carries the full wire shape and never leaks the acknowledger set", () => {
    const a = mkAlert();
    const [wire] = alerts.listOpenAlerts("admin-a");
    expect(wire).toBeTruthy();
    expect(wire.id).toBe(a.id);
    expect(wire.kind).toBe("ip_banned");
    expect(wire.ip).toBe("203.0.113.7");
    expect(typeof wire.at).toBe("number");
    expect(new Date(wire.blocked_until).getTime()).toBeGreaterThan(Date.now());
    expect(wire.count_4xx).toBe(137);
    expect(wire.competition_id).toBe("comp-1");
    expect(wire.competition_name).toBe("Venue Cup");
    expect(wire.already_trusted).toBe(false);
    expect(wire.dismissedGlobally).toBe(false);
    expect(wire.dismissedBy).toBeNull();
    // ackedBy is who-has-seen-it bookkeeping; shipping it would tell every admin
    // which of their colleagues had already dismissed the notice.
    expect(wire).not.toHaveProperty("ackedBy");
  });

  test("a self-ack hides the alert for THAT admin only — a colleague still sees it", () => {
    const a = mkAlert();
    expect(ipsFor("alice@acme.com")).toEqual(["203.0.113.7"]);
    expect(ipsFor("bob@acme.com")).toEqual(["203.0.113.7"]);

    expect(alerts.ackAlert(a.id, "alice@acme.com", "self")).toBe(true);

    // This is the whole point of the two tiers: a room-wide outage must not be
    // hidden from the second admin because the first waved it away.
    expect(ipsFor("alice@acme.com")).toEqual([]);
    expect(ipsFor("bob@acme.com")).toEqual(["203.0.113.7"]);
    // …and a self-ack is not a verdict on the address, so a ban elsewhere can
    // still raise its own alert.
    expect(alerts.isIpSuppressed("203.0.113.7")).toBe(false);
  });

  test("a global dismiss hides the alert for everyone AND suppresses a re-fire for that IP", () => {
    const a = mkAlert();
    expect(ipsFor("bob@acme.com")).toEqual(["203.0.113.7"]);

    expect(alerts.ackAlert(a.id, "superadmin", "global")).toBe(true);

    for (const who of ["alice@acme.com", "bob@acme.com", "superadmin", ""]) {
      expect(ipsFor(who), `hidden for ${who || "(anonymous key)"}`).toEqual([]);
    }
    // The superadmin has ruled this a genuine scanner, so the next block on the
    // same address must stay quiet rather than re-raise the modal they just shut.
    expect(alerts.isIpSuppressed("203.0.113.7")).toBe(true);
    expect(alerts.recordIpBanAlert({
      ip: "203.0.113.7", blockedUntil: openBlock(), count4xx: 400, competition: null,
    })).toBeNull();
    // The verdict is per-address, not a global mute.
    expect(alerts.isIpSuppressed("198.51.100.4")).toBe(false);
    const other = mkAlert({ ip: "198.51.100.4" });
    expect(ipsFor("bob@acme.com")).toEqual([other.ip]);
  });

  test("a global dismiss records who made the call", () => {
    const a = mkAlert();
    alerts.ackAlert(a.id, "boss@acme.com", "global");
    // Not visible through listOpenAlerts any more (it is dismissed), so read the
    // stored alert the only other way a caller can: acking it again is a no-op
    // that still resolves, and the field itself is asserted on the object.
    expect(a.dismissedGlobally).toBe(true);
    expect(a.dismissedBy).toBe("boss@acme.com");
  });

  test("acking an unknown id returns false rather than inventing one", () => {
    expect(alerts.ackAlert("no-such-alert", "alice@acme.com", "self")).toBe(false);
    expect(alerts.ackAlert("no-such-alert", "superadmin", "global")).toBe(false);
  });

  test("an alert stops being listed once its block lapses — it clears itself", () => {
    const blockedUntil = Date.now() + 2 * MIN;
    const a = mkAlert({ blockedUntil });
    // While the block is in force it is shown…
    expect(ipsFor("alice@acme.com", Date.now())).toEqual([a.ip]);
    // …and the instant it lapses it is not, with nobody having touched it. This
    // is the "if the requests cease it goes away by itself" promise the copy
    // makes, so it must hold without an ack of either tier.
    expect(ipsFor("alice@acme.com", blockedUntil + 1)).toEqual([]);
    expect(a.dismissedGlobally).toBe(false);
    expect(alerts.isIpSuppressed(a.ip)).toBe(false);
  });

  test("a second ban for the same IP while one is open does not queue a duplicate", () => {
    const first = mkAlert();
    const second = alerts.recordIpBanAlert({
      ip: "203.0.113.7", blockedUntil: openBlock(), count4xx: 900,
      competition: { id: "comp-1", name: "Venue Cup" },
    });
    expect(second, "a re-fire while one is open must not stack another modal").toBeNull();
    expect(alerts.listOpenAlerts("alice@acme.com")).toHaveLength(1);
    expect(alerts.listOpenAlerts("alice@acme.com")[0].id).toBe(first.id);

    // De-dup is keyed on the address, not "one alert at a time" — a second venue
    // (or a real scanner) blocked at the same moment still gets reported.
    const other = alerts.recordIpBanAlert({
      ip: "198.51.100.4", blockedUntil: openBlock(), count4xx: 120, competition: null,
    });
    expect(other).toBeTruthy();
    expect(ipsFor("alice@acme.com").sort()).toEqual(["198.51.100.4", "203.0.113.7"]);
  });
});

// ── unit: the copy ───────────────────────────────────────────────────────────
// The same words go to the in-app modal and the superadmin email, so this is the
// only place either is checked. What matters is that an admin who reads it knows
// the address, which event it hit, what to do, and that doing nothing is also a
// valid answer.
test.describe("IP-ban alert copy (v7.16.0)", () => {
  test.beforeEach(() => alerts._clearAllAlertsForTests());
  test.afterEach(() => alerts._clearAllAlertsForTests());

  // v8.3.20 — RE-POINTED, not weakened. The deadline is now rendered by the same
  // `formatEmailDate(d, tz)` every other outbound mail uses, so it lands in the
  // RECIPIENT'S timezone and names it; this helper follows that shape. The
  // subject is unchanged: the copy must state the moment the block lifts.
  const untilLabel = (a, tz) => formatEmailDate(new Date(a.blocked_until), tz);

  test("names the address, the competition, and how to unblock it", () => {
    const a = mkAlert();
    const copy = alerts.alertCopy(a, "https://hack.example.com");

    expect(copy).toContain("203.0.113.7");
    expect(copy).toContain('"Venue Cup"');
    expect(copy).toContain("137 rejected requests");
    // The actionable instruction: the exact field label the admin has to find in
    // the competition form. If the field is ever renamed, this must be renamed too.
    expect(copy).toContain('"Trusted network IPs"');
    expect(copy).toContain(`Put 203.0.113.7 in "Trusted network IPs" and save`);
    // Both halves of "you may not need to do anything".
    expect(copy).toContain("clears itself");
    expect(copy).toContain(untilLabel(a));
    expect(copy).toContain("a superadmin can dismiss it permanently");
    // The time bound is the reason nobody has to remember to undo the entry.
    expect(copy).toContain("2 hours after it ends");
    expect(copy).toContain("Admin panel: https://hack.example.com");
  });

  test("an ALREADY-trusted address is told so, and is NOT sent round the loop again", () => {
    const a = mkAlert({ alreadyTrusted: true });
    const copy = alerts.alertCopy(a);

    expect(copy).toContain("ALREADY listed as a trusted network");
    expect(copy).toContain("should not have been blocked");
    // The bypass did not work, so the standard remedy is wrong here. Telling the
    // admin to add an entry that is already present sends them round a loop and
    // hides the real fault (window not open yet / expired / address mismatch).
    expect(copy).not.toContain("To unblock them now");
    expect(copy).not.toContain('Put 203.0.113.7 in "Trusted network IPs"');
    expect(copy).toContain("inert before it starts");
    // …but the two universal sentences still apply.
    expect(copy).toContain("clears itself");
    expect(copy).toContain("a superadmin can dismiss it permanently");
    // No baseUrl passed → no dangling "Admin panel:" line.
    expect(copy).not.toContain("Admin panel:");
  });

  test("v7.21.14: a MULTI-SESSION competition is not sent to a control that refuses it", () => {
    // `trusted_network_ips` is single-session-only by an explicit v7.16.0
    // decision, and the competition PUT enforces it with a 400: "Trusted network
    // IPs can only be set on a single-session competition." So for a competition
    // with sessions, the standard advice — open the competition, put the address
    // in Trusted network IPs, save — is a dead end, and the admin reading it is
    // standing in the room with the venue locked out. v7.16.0's own note says an
    // instruction that is not true is worse than no instruction; this is that
    // rule applied to the case it did not cover.
    const a = mkAlert({ competition: { id: "comp-2", name: "Two Cohorts", accepts_trusted_ips: false } });
    const copy = alerts.alertCopy(a, "https://hack.example.com");

    // It must NOT name the unavailable control as the remedy.
    expect(copy).not.toContain("To unblock them now");
    expect(copy).not.toContain('Put 203.0.113.7 in "Trusted network IPs" and save');
    // It must say WHY, naming the competition, so the admin does not go hunting
    // for a setting that is simply absent for this shape of competition.
    expect(copy).toContain("Two Cohorts");
    expect(copy).toContain("only available on a single-session event");
    // …and it must offer the remedies that DO exist.
    expect(copy).toContain("Wait it out");
    expect(copy).toContain("RATE_LIMIT_ALLOWLIST_IPS");
    expect(copy).toContain(untilLabel(a));
    // The venue framing is still right — this IS the busy-room case.
    expect(copy).toContain("everyone in the room shares one public address");
    expect(copy).toContain("clears itself");
  });

  test("v7.21.14 CONTROL: a single-session competition still gets the direct remedy", () => {
    // Without this the test above is satisfied by copy that NEVER offers the
    // trusted-networks steps — which would break the feature for the common case
    // rather than fix it for the uncommon one.
    const a = mkAlert({ competition: { id: "comp-3", name: "One Room", accepts_trusted_ips: true } });
    const copy = alerts.alertCopy(a);
    expect(copy).toContain("To unblock them now");
    expect(copy).toContain(`Put 203.0.113.7 in "Trusted network IPs" and save`);
    expect(copy).not.toContain("only available on a single-session event");
  });

  test("v7.21.14: an alert raised without the flag keeps the direct remedy", () => {
    // Back-compat, and it matters: recordIpBanAlert defaults the flag to true
    // for any competition object that does not carry it. Defaulting the other
    // way would have silently downgraded EVERY alert to the fallback copy the
    // moment this field was added, which is the quieter and worse failure.
    const a = mkAlert({ competition: { id: "comp-4", name: "Legacy Shape" } });
    expect(a.accepts_trusted_ips, "an unflagged competition is assumed single-session").toBe(true);
    expect(alerts.alertCopy(a)).toContain("To unblock them now");
  });

  test("with no competition live it says so and asks for nothing", () => {
    const a = mkAlert({ competition: null });
    const copy = alerts.alertCopy(a);

    expect(copy).toContain("while no Booth Event or Competition was live");
    expect(copy).toContain("No Booth Event or Competition is currently live");
    expect(copy).not.toContain('"Trusted network IPs"');
    expect(copy).toContain("clears itself");
    expect(copy).toContain("a superadmin can dismiss it permanently");
  });
});

// ── unit: delivery routing ───────────────────────────────────────────────────
// deliverAlert takes its heavy collaborators through `deps` precisely so this can
// be driven without a session table or an SMTP hop.
test.describe("IP-ban alert delivery (v7.16.0)", () => {
  test.beforeEach(() => alerts._clearAllAlertsForTests());
  test.afterEach(() => alerts._clearAllAlertsForTests());

  function fakeDeps(over = {}) {
    const sent = [];
    return {
      sent,
      deps: {
        countLiveAdminSessions: () => 0,
        listSuperadminEmails: () => [],
        // v8.3.20 — ONE address per call. deliverAlert owns the fan-out now,
        // because the body is rendered per recipient (the block deadline lands
        // in that superadmin's own timezone). Returning true mirrors the real
        // adapter's `sendEmailLogged` boolean, which is what makes `emailed`
        // a count of real deliveries rather than of attempts.
        sendMail: async (to, subject, body) => { sent.push({ to, subject, body }); return true; },
        baseUrl: "https://hack.example.com",
        ...over,
      },
    };
  }

  // ext-audit v7.20.9 (F6). Until this release an admin session SUPPRESSED the
  // email: deliverAlert returned early with `{channel:"in_app"}` before it ever
  // looked at a recipient list. Two independent things are wrong with that, and
  // both bite hardest in the situation the alert exists for:
  //
  //   • the block is IP-WIDE, and at a hackathon the organiser is in the room on
  //     the room's NAT — i.e. on the blocked address — so their own poll for the
  //     alert is 429'd. The one notice explaining why the platform just died is
  //     unreachable from the only position that matters, and it was their own
  //     session that cancelled the email;
  //   • countLiveAdminSessions() proves a session ROW is unexpired, not that a
  //     human is looking. Somebody who shut their laptop ten minutes ago still
  //     counts for the rest of the 60-minute idle window.
  //
  // So the mail now always goes out, and `channel` degrades to a statement about
  // which surface is PRIMARY rather than a decision to withhold the other one.
  test("an admin session picks the PRIMARY channel — it no longer SUPPRESSES the email", async () => {
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      countLiveAdminSessions: () => 2,
      // Non-empty on purpose: with no recipients the no-mail branch is reached
      // for a completely different reason, and this assertion would hold however
      // the suppression behaved.
      listSuperadminEmails: () => ["boss@acme.com", "second.boss@acme.com"],
    });
    const r = await alerts.deliverAlert(a, deps);

    // The SPA poll stays the primary surface while someone is signed in…
    expect(r.channel).toBe("in_app");
    expect(r.admins).toBe(2);
    // …and the email goes out ANYWAY. A duplicate notification is far cheaper
    // than a lost one for a rare, high-impact, time-boxed outage.
    expect(sent, "the mail must be sent even with an admin signed in").toHaveLength(2);
    expect(sent.map(m => m.to)).toEqual(["boss@acme.com", "second.boss@acme.com"]);
    // `emailed` is what the audit event records, so it has to report what
    // actually went out rather than merely which channel was chosen.
    expect(r.emailed).toBe(2);
    expect(sent[0].body).toBe(alerts.alertCopy(a, "https://hack.example.com", undefined));
  });

  test("v8.3.20: each recipient's body is rendered in THEIR timezone, and a missing one falls back to UTC", async () => {
    // THE HEADLINE FIX, and nothing exercised it: every injected recipient in
    // this file was a bare string, so the `{email, timezone}` branch the real
    // adapter uses never ran and both halves could be reverted with the suite
    // green.
    //
    // The negative arm carries the weight. Asserting the "(Zone)" suffix alone
    // would pass on a build that names the zone while still computing the UTC
    // instant; requiring the Melbourne body to contain NO "UTC" at all pins the
    // rendered instant too, because "UTC" appears in this copy only in the two
    // deadline sentences. Asserting the suffix rather than a literal timestamp
    // keeps it free of DST brittleness.
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      countLiveAdminSessions: () => 0,
      listSuperadminEmails: () => [
        { email: "melb@acme.com", timezone: "Australia/Melbourne" },
        { email: "nozone@acme.com", timezone: null },
        { email: "garbage@acme.com", timezone: "Nowhere/Bad" },
      ],
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.emailed).toBe(3);
    expect(sent).toHaveLength(3);

    expect(sent[0].body, "a recipient with a timezone gets it NAMED").toContain("(Australia/Melbourne)");
    expect(sent[0].body, "…and the instant is rendered in it, not merely labelled").not.toContain("UTC");

    expect(sent[1].body, "a NULL timezone falls back to a UTC string that still names its zone").toContain("UTC");
    // …and is still SENT. A recipient must never be skipped over a formatting
    // input — this mail is the only channel some of them have.
    expect(sent[1].to).toBe("nozone@acme.com");

    expect(sent[2].body, "an UNRECOGNISED timezone falls back the same way, never throwing").toContain("UTC");
    expect(sent[2].to).toBe("garbage@acme.com");
  });

  test("v8.3.20: a bare-string recipient still works — the back-compat control", async () => {
    // deliverAlert accepts a string as well as a row, so an un-migrated caller
    // degrades to UTC (today's behaviour) rather than losing the mail. Without
    // this, the row-shape change is a silent breaking contract change.
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      countLiveAdminSessions: () => 0,
      listSuperadminEmails: () => ["legacy@acme.com"],
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.emailed).toBe(1);
    expect(sent[0].to).toBe("legacy@acme.com");
    expect(sent[0].body).toContain("UTC");
  });

  test("v8.3.20: `emailed` counts DELIVERIES, not attempts", async () => {
    // `sendEmailLogged` catches its own SMTP error and RETURNS FALSE — it never
    // throws — so `emailed: recipients.length` recorded N deliveries into the
    // `ip_ban_alert_raised` audit event whenever the relay was down, and the
    // catch branch was effectively dead in production. Neither of this file's
    // throwing fakes could see it: they never reach the counter at all.
    const a = mkAlert();
    const { deps } = fakeDeps({
      countLiveAdminSessions: () => 0,
      listSuperadminEmails: () => ["a@acme.com", "b@acme.com"],
      sendMail: async () => false,          // the REAL adapter's failure shape
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.emailed, "nothing got out, so nothing may be reported as sent").toBe(0);
    expect(r.channel, "…and with no in-app path either, nobody was told").toBe("none");
    expect(r.recipients).toBe(2);
  });

  test("v8.3.20: one bad address does not lose the rest", async () => {
    // The fan-out was a single call whose loop lived in the adapter, so an
    // exception part-way through abandoned every remaining superadmin — on the
    // one mail that must arrive. Per-recipient try/catch, and the count reports
    // who actually got it.
    const a = mkAlert();
    const sent = [];
    const { deps } = fakeDeps({
      countLiveAdminSessions: () => 0,
      listSuperadminEmails: () => ["first@acme.com", "poison@acme.com", "last@acme.com"],
      // Records the ATTEMPT before deciding, so the assertion below distinguishes
      // "was tried and failed" from "was never reached" — which is the whole
      // subject: the old shape abandoned every remaining recipient.
      sendMail: async (to, subject, body) => {
        sent.push({ to, subject, body });
        if (to === "poison@acme.com") throw new Error("bad address");
        return true;
      },
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.emailed, "the two good addresses were mailed").toBe(2);
    expect(sent.map(m => m.to), "and every recipient was ATTEMPTED, including the one after the failure")
      .toEqual(["first@acme.com", "poison@acme.com", "last@acme.com"]);
    expect(r.channel).toBe("email");
  });

  test("with an admin signed in but NO superadmin address, the in-app path still stands", async () => {
    // The no-recipients branch must not be mistaken for a delivery failure while
    // there is a working surface: "none" is reserved for nobody-gets-told.
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      countLiveAdminSessions: () => 3,
      listSuperadminEmails: () => [],
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("in_app");
    expect(r.admins).toBe(3);
    expect(r.emailed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("a failed send does NOT downgrade a working in-app path", async () => {
    // Mail is now attempted on every alert, so an unreachable relay became a way
    // to report "nobody was told" about an alert that IS reaching the panel.
    const a = mkAlert();
    const { deps } = fakeDeps({
      countLiveAdminSessions: () => 1,
      listSuperadminEmails: () => ["boss@acme.com"],
      sendMail: async () => { throw new Error("SMTP refused"); },
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("in_app");
    expect(r.admins).toBe(1);
    expect(r.emailed).toBe(0);
    expect(r.error).toContain("SMTP refused");
  });

  test("with nobody signed in it emails EVERY superadmin, with the same words as the modal", async () => {
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      countLiveAdminSessions: () => 0,
      listSuperadminEmails: () => ["boss@acme.com", "second.boss@acme.com"],
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("email");
    expect(r.recipients).toBe(2);
    expect(r.emailed).toBe(2);
    // v8.3.20 — one message PER recipient, because the body differs per reader.
    expect(sent).toHaveLength(2);
    expect(sent.map(m => m.to)).toEqual(["boss@acme.com", "second.boss@acme.com"]);
    expect(sent[0].subject).toContain("203.0.113.7");
    expect(sent[0].subject).toContain("Venue Cup");
    // The email body IS the modal copy — that is why alertCopy lives next to the
    // alert shape, so the two channels cannot drift.
    expect(sent[0].body).toBe(alerts.alertCopy(a, "https://hack.example.com", undefined));
  });

  test("an unreadable session table degrades to email rather than to silence", async () => {
    // The caller is the request that happened to be the hundredth 4xx, so a
    // collaborator failing must never take it (or the tracker) down. "Cannot
    // tell if anyone is watching" has to read as "nobody is", because that is
    // the branch that still reaches a human.
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      countLiveAdminSessions: () => { throw new Error("session table unreadable"); },
      listSuperadminEmails: () => ["boss@acme.com"],
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("email");
    expect(sent).toHaveLength(1);
  });

  // These three cover deliverAlert's FAILURE branches — the paths that run when
  // the alert cannot be delivered. They matter more than the happy path: the
  // no-recipients case is the DEFAULT for a deployment running only the
  // built-in superadmin (it is not a `users` row, so _listSuperadminEmails()
  // returns []), i.e. exactly "nobody is watching the panel and nobody gets an
  // email" — the one situation the alert exists for.
  //
  // They were written against a real defect (v7.16.0 pre-release):
  // lib/admin-alerts.js imported the log MODULE rather than `{ log }`, so both
  // branches threw `TypeError: log.warn is not a function` at the very line
  // meant to report the failure — and server.js's `.catch(() => {})` swallowed
  // it, making the delivery failure completely silent. Fixed by destructuring
  // the import; these are the regression lock.
  test("with no superadmin address it reports 'none' and does not throw", async () => {
    const a = mkAlert();
    const { sent, deps } = fakeDeps({ listSuperadminEmails: () => [] });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("none");
    expect(r.admins).toBe(0);
    expect(r.emailed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("a failed send with nobody signed in is reported as 'none' with the reason, not raised at the caller", async () => {
    const a = mkAlert();
    const { deps } = fakeDeps({
      listSuperadminEmails: () => ["boss@acme.com"],
      sendMail: async () => { throw new Error("SMTP refused"); },
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("none");
    expect(r.emailed).toBe(0);
    expect(r.error).toContain("SMTP refused");
  });

  test("a lister that throws is treated as no recipients", async () => {
    const a = mkAlert();
    const { sent, deps } = fakeDeps({
      listSuperadminEmails: () => { throw new Error("db gone"); },
    });
    const r = await alerts.deliverAlert(a, deps);
    expect(r.channel).toBe("none");
    expect(sent).toHaveLength(0);
  });
});

// ── HTTP: the admin surface ──────────────────────────────────────────────────
// NOTE on what is reachable here. The test server runs with RATE_LIMIT_DISABLED=1
// and the scanner-reputation middleware short-circuits on that env var BEFORE it
// counts anything, so no alert can exist in the server's process and there is no
// test-only hook to plant one. That leaves the authorisation contract, which is
// what these tests pin — and the ack tier is still fully discriminated, because
// the tier gate runs BEFORE the id lookup: a refused caller gets 403 with the
// tier message, an allowed one falls through to the 404 for the unknown id.
// Remove the gate and the regular admin's 403 becomes 404; apply it to everyone
// and the superadmin's 404 becomes 403. Either way this fails.
test.describe("Alert endpoints — authorisation (v7.16.0)", () => {
  const ADMIN_EMAIL = "alertsadmin@acme.com";
  let sa, saH, adm, admH;

  // IDEMPOTENT ON PURPOSE. Playwright tears the worker down after a failed test
  // and starts a fresh one for the remainder, so beforeAll runs again against a
  // database that already has this account — and the repo default is RETRIES=1,
  // so a retry hits the same path. A plain register() then answers 409 "nickname
  // already taken", and every later test in the describe fails citing THAT
  // instead of the real fault. Each step below is therefore conditional.
  async function findAdmin() {
    const list = await (await sa.get(
      `/api/admin/participants?limit=1000&search=${encodeURIComponent(ADMIN_EMAIL)}`
    )).json();
    return (list.participants || []).find(p => p.email === ADMIN_EMAIL) || null;
  }

  test.beforeAll(async () => {
    const s = await apiLogin("superadmin");
    sa = s.api; saH = h(s.csrf);

    // A dedicated account promoted to regular admin — the seeded fixtures are
    // shared across every spec on this worker, so mutating one of them leaks.
    if (!await findAdmin()) {
      const reg = await freshCtx();
      const r = await registerPost(reg.api, "/api/register", { headers: h(reg.csrf), data: {
        firstName: "Alerts", lastName: "Admin", nickname: "alerts_adm", email: ADMIN_EMAIL,
        company: "Acme", title: "Engineer", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
        password: PARTICIPANT_PASS,
      }});
      if (r.status() >= 400) throw new Error(`register failed: ${r.status()} ${await r.text()}`);
      await reg.api.dispose();
    }

    const u = await findAdmin();
    if (!u) throw new Error("could not find the alerts admin after register");
    if (!u.verified) await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    if (!u.approved) await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    if (u.role !== "admin") {
      const promote = await sa.post(`/api/admin/participants/${u.id}/role`, {
        headers: saH, data: { role: "admin" },
      });
      if (promote.status() !== 200) throw new Error(`promote failed: ${promote.status()} ${await promote.text()}`);
    }

    const a = await apiLogin(ADMIN_EMAIL, PARTICIPANT_PASS);
    adm = a.api; admH = h(a.csrf);
  });

  test.afterAll(async () => {
    await sa?.dispose();
    await adm?.dispose();
  });

  test("GET /api/admin/alerts is admin-only", async () => {
    const { api: anon } = await freshCtx();
    expect((await anon.get("/api/admin/alerts")).status()).toBe(401);
    await anon.dispose();

    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    expect((await alice.get("/api/admin/alerts")).status()).toBe(403);
    await alice.dispose();
  });

  test("GET /api/admin/alerts reports the caller's tier alongside the list", async () => {
    // isSuperAdmin drives whether the SPA offers "dismiss for everyone", so the
    // client must never have to infer it.
    const asAdmin = await adm.get("/api/admin/alerts");
    expect(asAdmin.status()).toBe(200);
    const adminBody = await asAdmin.json();
    expect(Array.isArray(adminBody.alerts)).toBe(true);
    expect(adminBody.isSuperAdmin).toBe(false);

    const asSuper = await sa.get("/api/admin/alerts");
    expect(asSuper.status()).toBe(200);
    const superBody = await asSuper.json();
    expect(Array.isArray(superBody.alerts)).toBe(true);
    expect(superBody.isSuperAdmin).toBe(true);
  });

  test('ack scope:"global" is refused for a regular admin and allowed for a superadmin', async () => {
    const id = "00000000-0000-4000-8000-000000000000";

    const refused = await adm.post(`/api/admin/alerts/${id}/ack`, {
      headers: admH, data: { scope: "global" },
    });
    expect(refused.status()).toBe(403);
    // Assert the MESSAGE, not just the status: requireAdmin and a CSRF failure
    // also answer 403, and either would make this pass for the wrong reason.
    expect((await refused.json()).error).toBe("Only a superadmin can dismiss this alert for everyone.");

    // The superadmin is not refused by tier — it gets past the gate and only
    // then finds there is no such alert.
    const allowed = await sa.post(`/api/admin/alerts/${id}/ack`, {
      headers: saH, data: { scope: "global" },
    });
    expect(allowed.status()).toBe(404);
    expect((await allowed.json()).error).toBe("Alert not found");
  });

  test('ack scope:"self" is open to any admin — only the global tier is restricted', async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    for (const [label, api, hdr] of [["regular admin", adm, admH], ["superadmin", sa, saH]]) {
      // 404 (unknown id), NOT 403 — proves the tier gate did not fire on "self".
      const r = await api.post(`/api/admin/alerts/${id}/ack`, { headers: hdr, data: { scope: "self" } });
      expect(r.status(), `${label} may self-ack`).toBe(404);
      // An omitted scope must default to "self" rather than to the privileged tier.
      const bare = await api.post(`/api/admin/alerts/${id}/ack`, { headers: hdr, data: {} });
      expect(bare.status(), `${label} default scope is self`).toBe(404);
    }
  });

  test("ack requires CSRF", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    const r = await sa.post(`/api/admin/alerts/${id}/ack`, {
      headers: { "content-type": "application/json" }, data: { scope: "self" },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).not.toBe("Alert not found");
  });
});

// ── HTTP: the block itself, against a spawned server ─────────────────────────
//
// ext-audit v7.20.9 (F6) — the scanner-reputation tracker is now COUNT-early /
// BLOCK-after-session, and the block exempts a signed-in admin.
//
// The defect: the block is IP-WIDE and ran before the session middleware, so it
// refused the admin panel to an admin who merely SHARED the blocked address —
// which at a hackathon is the normal case rather than an edge one, because the
// organiser is in the room on the room's NAT. The alert raised by that very
// block tells them to add the venue to the competition's trusted networks, and
// the route that does it was behind the block. The instruction was unfollowable
// from the only place it mattered.
//
// WHY THIS SPAWNS ITS OWN SERVER (the same reasoning as
// trusted-networks-e2e.api.spec.js, which solved this first). Two things are
// impossible in the shared test server: it runs with RATE_LIMIT_DISABLED=1, and
// the scanner middleware short-circuits on that env var before it counts
// anything — so no block can ever exist; and every client there is 127.0.0.1,
// while the whole question here is "the SAME address, with and without an admin
// session". TRUST_PROXY + X-Forwarded-For gives one address several identities,
// and is also the production shape. Turning either knob on in the shared server
// would change rate-limit keying for every other spec on the worker.
test.describe("Scanner block — a signed-in admin is exempt (v7.20.9 F6)", () => {
  const VENUE_IP = "203.0.113.140";  // the room: everyone's traffic, one address
  const ADMIN_IP = "198.51.100.140"; // where accounts are created and signed in

  test("a blocked address still serves an ADMIN session, and still blocks everyone else", async () => {
    test.setTimeout(180_000);
    // Far outside the worker-slot range, and clear of the +110 that
    // trusted-networks-e2e uses, so no parallel worker can collide with it.
    const port = PORT_BASE + 120;
    const SRV = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipban-exempt-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: SRV, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        TRUST_PROXY: "1",
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        // v7.15.30 — a spawned server runs OUR node flags, never the runner's.
        NODE_OPTIONS: "",
        // RATE_LIMIT_DISABLED is deliberately ABSENT: the scanner tracker is the
        // subject, and it short-circuits on that variable before counting.
        // NODE_ENV=test, never production: production forces a Secure cookie and
        // express-session then refuses to emit one over plain HTTP, so there
        // would be no session at all — and a session is the whole experiment.
        // Test mode is what lets the user-backed account sign in: every account
        // but the built-in signs in with an emailed code, read back here through
        // the test-only capture (the relay on 1026 is dead).
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });

    class Client {
      constructor(ip, label) { this.ip = ip; this.label = label; this.cookie = ""; this.csrf = ""; }
      async go(p, opts = {}) {
        const headers = { "x-forwarded-for": this.ip, "x-forwarded-proto": "https" };
        if (opts.body) headers["content-type"] = "application/json";
        if (this.csrf) headers["x-csrf-token"] = this.csrf;
        if (this.cookie) headers["cookie"] = this.cookie;
        const r = await fetch(`${SRV}${p}`, {
          method: opts.method || "GET", headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
        let json = null; try { json = await r.json(); } catch (_) {}
        return { status: r.status, json };
      }
      async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
      /** Move this identity onto another address, keeping its cookie. */
      at(ip) { const c = new Client(ip, this.label); c.cookie = this.cookie; c.csrf = this.csrf; return c; }
    }

    try {
      const pass = await readySpawnedServer({ base: SRV, child, dataDir, spawnedAt, output: () => childOut });

      // ── identities, all established from an UNBLOCKED address ──────────────
      // A signed-in admin already on the venue's address could not sign in
      // there once it is blocked (login carries no session yet, so the block
      // catches it), and that is not the case being tested: the organiser is
      // signed in and working when the room's traffic trips the tracker.
      const sa = new Client(ADMIN_IP, "superadmin");
      await sa.refreshCsrf();
      expect((await sa.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } })).status,
        "the superadmin signs in").toBe(200);
      await sa.refreshCsrf();

      // A user-backed REGULAR admin. The built-in superadmin sets isAdmin AND
      // isSuperAdmin, so on its own it cannot tell which half of the exemption
      // is load-bearing — this account carries isAdmin with isSuperAdmin false.
      const EMAIL = `venue.admin.${Date.now()}@acme.com`;
      const reg = new Client(ADMIN_IP, "person");
      await reg.refreshCsrf();
      // Email first: an account is created only by a session holding a live
      // address proof, so the person proves the address before the form.
      const pq = await reg.go("/api/auth/code/request", { method: "POST", body: { email: EMAIL } });
      expect(pq.status, `proof request for ${EMAIL}`).toBe(200);
      const proof = (await reg.go(`/api/test/last-login-code?email=${encodeURIComponent(EMAIL)}`)).json;
      expect(proof?.via, `an address proof was minted for ${EMAIL}: ${JSON.stringify(proof)}`).toBe("proof");
      const pr = await reg.go("/api/auth/code/redeem", { method: "POST", body: { email: EMAIL, code: proof.code } });
      expect(pr.json?.needsProfile, `proof redeemed: ${JSON.stringify(pr.json)}`).toBe(true);
      await reg.refreshCsrf();
      const created = await reg.go("/api/register", { method: "POST", body: {
        firstName: "Venue", lastName: "Admin", nickname: `venue_adm_${Date.now() % 100000}`,
        email: EMAIL, company: "Acme", title: "Engineer", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      }});
      expect(created.status, `register: ${JSON.stringify(created.json)}`).toBeLessThan(400);

      const people = await sa.go(`/api/admin/participants?limit=1000&search=${encodeURIComponent(EMAIL)}`);
      const person = (people.json?.participants || []).find(p => p.email === EMAIL);
      expect(person, "the new account is visible to the superadmin").toBeTruthy();
      await sa.go(`/api/admin/participants/${person.id}/verify`, { method: "POST" });
      await sa.go(`/api/admin/participants/${person.id}/approve`, { method: "POST" });

      const asParticipant = async () => {
        const c = new Client(ADMIN_IP, "participant");
        await c.refreshCsrf();
        // A fresh emailed code per sign-in (the two-minute re-send suppression
        // forgotten first), read through the test-only capture, then redeemed.
        await c.go("/api/test/reset-recent-code-sends", { method: "POST", body: {} });
        const rq = await c.go("/api/auth/code/request", { method: "POST", body: { email: EMAIL } });
        expect(rq.status, `code request for ${EMAIL}`).toBe(200);
        const code = (await c.go(`/api/test/last-login-code?email=${encodeURIComponent(EMAIL)}`)).json?.code;
        expect(code, `a code was minted for ${EMAIL}`).toBeTruthy();
        const li = await c.go("/api/auth/code/redeem", { method: "POST", body: { email: EMAIL, code } });
        expect(li.status, `sign in as ${EMAIL}: ${JSON.stringify(li.json)}`).toBe(200);
        expect(li.json?.ok, `sign in as ${EMAIL}: ${JSON.stringify(li.json)}`).toBe(true);
        return c;
      };
      const participant = await asParticipant();

      // ── the room trips the tracker ─────────────────────────────────────────
      // Unauthenticated admin requests answer 401 — a non-429 4xx, therefore
      // countable — and this is the realistic shape: a roomful of browsers whose
      // sessions have expired, all polling. requireAdmin runs BEFORE that
      // route's own rateLimit, so every one of these is a genuine 401 and the
      // per-route limiter never fires.
      const venue = new Client(VENUE_IP, "anonymous");
      let blockedAt = 0;
      for (let i = 1; i <= 140 && !blockedAt; i++) {
        if ((await venue.go("/api/admin/participants")).status === 429) blockedAt = i;
      }
      expect(blockedAt, "the venue address is blocked by the scanner tracker").toBeGreaterThan(0);

      // Every assertion below reads ONE endpoint, so the only variable is the
      // session on the request. /api/admin/alerts carries no limiter of its own
      // and is on a different route from the loop above, which is what makes a
      // 429 here attributable to the address-wide block and nothing else.
      const ALERTS = "/api/admin/alerts";
      const anonHere = new Client(VENUE_IP, "anonymous");
      expect((await anonHere.go(ALERTS)).status,
        "an anonymous request from the blocked address is refused address-wide (not merely 401)").toBe(429);

      // NEGATIVE CONTROL, and the reason the exemption is not simply "has a
      // session": a signed-in PARTICIPANT on the venue's address is still
      // blocked. Without this, every assertion below is equally satisfied by an
      // exemption that waved through anybody holding a cookie.
      expect((await participant.at(VENUE_IP).go(ALERTS)).status,
        "a signed-in PARTICIPANT on the blocked address is still blocked").toBe(429);

      // The fix: the organiser, signed in, on the room's address, can reach the
      // panel that holds the remedy the alert told them to apply.
      const saAtVenue = sa.at(VENUE_IP);
      const saRes = await saAtVenue.go(ALERTS);
      expect(saRes.status, "a signed-in SUPERADMIN on the blocked address is served").toBe(200);
      expect(Array.isArray(saRes.json?.alerts), "and gets the real payload, not an error body").toBe(true);

      // …and a REGULAR admin too — isAdmin alone is the exemption, not the
      // superadmin tier. Promotion invalidates the account's other sessions, so
      // it signs in again first.
      const promote = await sa.go(`/api/admin/participants/${person.id}/role`, {
        method: "POST", body: { role: "admin" },
      });
      expect(promote.status, `promote to admin: ${JSON.stringify(promote.json)}`).toBe(200);
      const admin = await asParticipant();
      const admRes = await admin.at(VENUE_IP).go(ALERTS);
      expect(admRes.status, "a signed-in REGULAR admin on the blocked address is served").toBe(200);
      expect(admRes.json?.isSuperAdmin,
        "…and it really is the regular tier, so isAdmin is what carried it").toBe(false);

      // …and an admin who is standing in PARTICIPANT VIEW is exempt too.
      //
      // `POST /api/toggle-admin-view` clears `isAdmin` on the session to render
      // the participant chrome, so an exemption keyed on the session flags alone
      // refuses an organiser who happened to be checking the participant view
      // when the room got blocked — including on the very request that would
      // toggle them back, which is the one state with no way out at all. The
      // exemption therefore falls back to the account's ROLE for a user-backed
      // session. Driven through the real endpoint rather than by editing the
      // session, so it fails if toggle-admin-view ever stops clearing the flag
      // (which would make this test pass for the wrong reason).
      await admin.refreshCsrf();
      const toParticipant = await admin.go("/api/toggle-admin-view", { method: "POST", body: { mode: "participant" } });
      expect(toParticipant.status, `toggle to participant view: ${JSON.stringify(toParticipant.json)}`).toBe(200);
      expect(toParticipant.json?.isAdmin,
        "the session flag really is cleared — otherwise this asserts nothing new").toBe(false);
      await admin.refreshCsrf();   // toggle-admin-view regenerates the session
      // The way OUT is the assertion that matters. /api/admin/alerts would 403
      // here on `requireAdmin` regardless, which proves nothing about the block;
      // toggling back is the request that was unreachable, and it is the only
      // one that distinguishes "exempt" from "blocked" for this session.
      const backToAdmin = await admin.at(VENUE_IP).go("/api/toggle-admin-view", { method: "POST", body: { mode: "admin" } });
      expect(backToAdmin.status,
        "an admin in PARTICIPANT VIEW can still toggle back FROM the blocked address — " +
        "keying the exemption on the session flags alone left them with no way out at all").toBe(200);
      expect(backToAdmin.json?.isAdmin, "and they really are back in admin view").toBe(true);

      // Closing control: the block was in force throughout. Without this, an
      // admin 200 is equally explained by the 15-minute block having lapsed
      // between the loop above and the reads here.
      expect((await new Client(VENUE_IP, "anonymous").go(ALERTS)).status,
        "the address is STILL blocked — the admin reads above were an exemption, not an expiry").toBe(429);

      // The block still covers NON-API paths. Scoping the relocated middleware
      // to /api would be the natural way to write it and would silently let a
      // scanner keep walking /wp-admin, /.env and /phpmyadmin from an address
      // that has already been judged abusive. (Stated precisely so this is not
      // read as more than it is: it pins the BLOCK's coverage. It says nothing
      // about where the COUNT half is mounted — a path with no file on disk
      // falls through express.static either way.)
      const r404 = await fetch(`${SRV}/wp-admin/setup-config.php`, {
        headers: { "x-forwarded-for": VENUE_IP, "x-forwarded-proto": "https" },
      });
      expect(r404.status,
        "a non-API path from a blocked address is refused too — the block is address-wide").toBe(429);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
