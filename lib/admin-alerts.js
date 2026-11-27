"use strict";
//
// v7.16.0 — operator alerts for an IP ban that hits during a live competition.
//
// The scanner-reputation tracker blocks an address for 15 minutes after 100
// non-429 4xx in 10 minutes. That is correct behaviour against a scanner and
// catastrophic against a venue: everyone shares the NAT egress address, so the
// whole room is locked out of everything, and the failure is silent — the
// admin sees a room of people saying "it's broken" and nothing in the UI that
// explains it. This module makes it say so, and say what to do about it.
//
// Delivery: every superadmin is ALWAYS emailed (v7.20.9 F6 — a live session
// row proves the row is unexpired, not that anyone can see the panel, and in
// the case that matters the organiser is ON the blocked address). The live
// session table decides only which surface is PRIMARY: with an admin signed in
// the SPA's alerts poll also raises a blocking modal. The choice is made ONCE,
// at alert time.
//
// State is in-process, deliberately: the ban it describes is in-process too
// (the scanner map), so persisting the alert past a restart would leave the UI
// nagging about a block that no longer exists. Single-process is a hard
// invariant of this app, so a Map is sufficient.
const crypto = require("crypto");
// lib/log.js exports { log, ... } — a bare `require("./log")` gives the MODULE,
// whose .warn/.error are undefined, so both failure branches of deliverAlert
// threw a TypeError that server.js then swallowed in its .catch(). The
// delivery failure was therefore completely silent, which is the worst
// possible behaviour for the path that exists to tell someone about a problem.
const { log } = require("./log");
// v8.3.20 — the SHARED timezone-aware formatter every other outbound mail uses
// (lockout, assignment, group sync, and the competition reminder dispatcher).
// lib/time.js is a zero-dependency leaf — no db, no fs, no log — so requiring
// it keeps this module's dependency-light
// contract, and its own header gives exactly this reason for living there
// rather than in lib/email: "so non-email callers don't have to require
// lib/email just for a date format."
const { formatEmailDate } = require("./time");

const MAX_ALERTS = 50;
// An unacknowledged alert stops being shown after this long. The block itself
// lasts 15 minutes; nagging about it an hour later helps nobody.
const ALERT_TTL_MS = 60 * 60 * 1000;

const _alerts = new Map();        // id -> alert
// v7.16.0 — IPs a SUPERADMIN has judged to be a genuine scanner rather than a
// venue. Suppressed so the same address cannot keep re-raising the modal after
// someone senior has already ruled on it. Bounded by the same TTL as an alert.
const _suppressedIps = new Map();  // ip -> { until, by }

function _prune(now) {
  for (const [id, a] of _alerts) {
    if (now - a.at > ALERT_TTL_MS) _alerts.delete(id);
  }
  for (const [ip, s] of _suppressedIps) {
    if (now > s.until) _suppressedIps.delete(ip);
  }
  while (_alerts.size > MAX_ALERTS) _alerts.delete(_alerts.keys().next().value);
}

/**
 * Record an IP-ban alert. `opts.competition` is the live competition (if any)
 * and drives the copy: during an event this is almost certainly the venue.
 * Returns the stored alert, or null when one for this IP is already open (a
 * ban re-firing must not produce a queue of identical modals).
 */
function recordIpBanAlert({ ip, blockedUntil, count4xx, competition, alreadyTrusted, verdict, routed4xx }) {
  const now = Date.now();
  _prune(now);
  // A superadmin has already ruled this address a real scanner — stay quiet.
  if (_suppressedIps.has(ip)) return null;
  for (const a of _alerts.values()) {
    if (a.ip === ip && !a.dismissedGlobally && !a.expired) return null; // already open
  }
  const alert = {
    id: crypto.randomUUID(),
    kind: "ip_banned",
    ip,
    at: now,
    blocked_until: new Date(blockedUntil).toISOString(),
    count_4xx: count4xx,
    competition_id: competition ? competition.id : null,
    competition_name: competition ? competition.name : null,
    // v7.21.14 — whether the per-competition Trusted network IPs control is
    // even available for THIS competition. It is single-session-only, so for a
    // multi-session competition the advice below has to be different advice,
    // not the same advice the platform will refuse with a 400.
    accepts_trusted_ips: competition ? competition.accepts_trusted_ips !== false : false,
    // v7.25.0 — what the classifier made of the traffic. Only a non-silent
    // verdict ever reaches here (an unmistakable scanner is blocked without an
    // alert at all), so this is "cohort" or "mixed" in production; the
    // test-only raise endpoint leaves it undefined.
    verdict: verdict || null,
    // v8.3.20 — how much of that traffic reached a REAL endpoint of this
    // platform. The "mixed" copy asserted that some of it had, and `verdict` is
    // derived from the RATIO alone, so a pure-probe walk that simply matched no
    // known-bad signature landed in "mixed" with routed_4xx = 0 and was told a
    // flat falsehood — the v7.21.14 class ("an instruction that is not true is
    // worse than no instruction") in the subsystem that rule came from. The copy
    // branches on the counter now, not on the label.
    routed_4xx: Number.isFinite(routed4xx) ? routed4xx : null,
    // True when the address ALREADY matched a trusted-network entry — which
    // would mean the bypass is not working and the advice below is wrong, so
    // the UI must not tell the admin to add an entry that is already there.
    already_trusted: !!alreadyTrusted,
    // Two-tier acknowledgement (v7.16.0). A regular admin clearing the modal
    // only clears it for THEMSELVES — a colleague in the same room still needs
    // to see it. Judging the address to be a real scanner and silencing it for
    // everyone is a superadmin decision, because getting it wrong the other way
    // hides a venue-wide outage from the people who could fix it.
    dismissedGlobally: false,
    dismissedBy: null,
    ackedBy: new Set(),
  };
  _alerts.set(alert.id, alert);
  return alert;
}

/**
 * Alerts this particular admin should still be shown.
 *
 * An alert is open only while the block it describes is STILL IN FORCE. That is
 * what makes it self-clearing: if the traffic stops, the block lapses and the
 * notice disappears on the next poll without anyone touching it; if the traffic
 * continues, the address is re-blocked and a fresh alert is raised. So a
 * regular admin never has to chase a superadmin merely to clear a stale banner
 * — only to silence one that keeps coming back.
 */
function listOpenAlerts(adminKey, now = Date.now()) {
  _prune(now);
  return [..._alerts.values()]
    .filter(a => now < new Date(a.blocked_until).getTime())
    .filter(a => !a.dismissedGlobally && !a.ackedBy.has(adminKey || ""))
    .sort((a, b) => a.at - b.at)
    .map(a => {
      const { ackedBy, ...wire } = a;   // never ship the acknowledger set
      return wire;
    });
}

/**
 * Acknowledge an alert.
 *   scope "self"   — any admin; hides it for that admin only.
 *   scope "global" — SUPERADMIN ONLY; hides it for everyone and suppresses
 *                    further alerts for the same IP, i.e. "this is a genuine
 *                    scanner, stop telling us".
 * The caller enforces the tier; this returns false for an unknown id.
 */
function ackAlert(id, adminKey, scope = "self") {
  const a = _alerts.get(id);
  if (!a) return false;
  if (scope === "global") {
    a.dismissedGlobally = true;
    a.dismissedBy = adminKey || null;
    _suppressedIps.set(a.ip, { until: Date.now() + ALERT_TTL_MS, by: adminKey || null });
  } else {
    a.ackedBy.add(adminKey || "");
  }
  return true;
}

function isIpSuppressed(ip) { return _suppressedIps.has(ip); }

function _clearAllAlertsForTests() { _alerts.clear(); _suppressedIps.clear(); }

/**
 * The human-facing explanation. Kept here, next to the alert shape, so the
 * in-app modal and the superadmin email cannot drift apart — they are the same
 * words delivered two ways.
 */
function alertCopy(alert, baseUrl, tz) {
  // v8.3.20 (operator report) — RENDER THE DEADLINE IN THE RECIPIENT'S OWN
  // TIMEZONE, and name it.
  //
  // This whole sentence exists to give an organiser a deadline they must act
  // against — "wait it out, or go and add a trusted network now" — and it was
  // the ONE outbound mail on the platform still forcing UTC arithmetic on the
  // reader at that moment. Every other lifecycle mail has used
  // formatEmailDate(d, user.timezone) for releases; this one hand-rolled a
  // `dd/mm/yyyy, HH:MM:SS UTC` shape that matches nothing else we send.
  //
  // The IANA name in parentheses is deliberate over an abbreviation: "IST" is
  // India, Ireland AND Israel and "CST" is US Central and China, so an
  // abbreviation on an operational deadline is worse than none — and every
  // other mail already prints "(Europe/London)", so the shape is recognisable.
  //
  // `tz` may be null, empty or garbage (users.timezone is nullable, the import
  // blanks an unusable zone by design, and bulk-seed writes one unvalidated).
  // formatEmailDate falls back to a UTC string that still names its zone, so a
  // recipient is never skipped and an Intl RangeError can never escape into the
  // alert path. One const feeds all three sentences below.
  const until = formatEmailDate(new Date(alert.blocked_until), tz);
  const where = alert.competition_name
    ? `during the live event "${alert.competition_name}"`
    : "while no Booth Event or Competition was live";
  const lines = [];
  lines.push(`The address ${alert.ip} has been temporarily blocked ${where}.`);
  lines.push("");
  lines.push(`It sent ${alert.count_4xx} rejected requests within 10 minutes. The block lifts automatically at ${until}.`);
  lines.push("");
  // v7.25.0 — say what the traffic LOOKED LIKE, rather than asserting it "is
  // the pattern of a scanner". That flat claim was wrong for exactly the case
  // this notice exists to serve, and contradicted its own next paragraph ("IF
  // THIS IS YOUR VENUE'S WI-FI, this is expected"). An unmistakable scanner no
  // longer produces a notice at all, so anything reaching here is genuinely
  // ambiguous and the copy has to say so.
  if (alert.verdict === "cohort") {
    lines.push("Those requests were answered by real pages of the platform, rather than being probes for files that do not exist. That is what a busy shared network looks like, so this may well be your venue.");
  } else if (alert.verdict === "mixed" && alert.routed_4xx === 0) {
    // v8.3.20 — the pure-probe-but-unrecognised case. Every request was for
    // something this platform does not have, so the old sentence's "some of it
    // reached real pages" was false, and the classifier's own counter said so.
    lines.push("All of that traffic was asking for things this platform does not have, but not enough of it matched a known attack pattern, or came from enough different paths, to call it a scanner outright — so it could be a scanner this notice does not recognise, or a client on your network repeatedly requesting something that no longer exists.");
  } else if (alert.verdict === "mixed") {
    lines.push("Some of that traffic was probing for files that do not exist, and some of it reached real pages of the platform — so it could be a scanner, a busy shared network, or both.");
  }
  if (alert.verdict) lines.push("");
  if (alert.already_trusted) {
    // The bypass should have prevented this. Do not send the admin round a
    // loop adding an entry that is already present.
    lines.push("IMPORTANT: this address is ALREADY listed as a trusted network for that event, so it should not have been blocked.");
    lines.push("That points at a configuration problem rather than a busy venue — check that the event is live (trusted networks are inert before it starts and expire 2 hours after it ends) and that the address matches exactly.");
  } else if (alert.competition_name && alert.accepts_trusted_ips && alert.can_set_trusted_ips === false) {
    // The READER cannot change that event (their role, their scope, or they
    // compete in it; `can_set_trusted_ips` is set per reader by the alerts
    // route, never on the stored alert the superadmin mail renders). The advice
    // is somebody else's to take, so say whose: telling them to save would send
    // them to a refusal while the venue is locked out.
    lines.push("IF THIS IS YOUR VENUE'S WI-FI, this is expected: everyone in the room shares one public address, so their combined traffic looks like a single very busy client.");
    lines.push("");
    lines.push(`You cannot change the event "${alert.competition_name}" yourself, so ask an administrator who can to put ${alert.ip} in its "Trusted network IPs" and save — the block is lifted immediately on save. Otherwise it lifts by itself at ${until}.`);
    lines.push("");
    lines.push("If you do NOT recognise this address, leave it blocked — the block is doing its job.");
  } else if (alert.competition_name && alert.accepts_trusted_ips) {
    lines.push("IF THIS IS YOUR VENUE'S WI-FI, this is expected: everyone in the room shares one public address, so their combined traffic looks like a single very busy client.");
    lines.push("");
    lines.push("To unblock them now:");
    lines.push(`  1. Open the event "${alert.competition_name}" in the admin panel.`);
    lines.push(`  2. Put ${alert.ip} in "Trusted network IPs" and save.`);
    lines.push("  3. The block is lifted immediately on save — participants can retry straight away.");
    lines.push("");
    lines.push("The entry only applies while that event is running, and stops working 2 hours after it ends, so there is nothing to remember to undo.");
    lines.push("");
    lines.push("If you do NOT recognise this address, leave it blocked — the block is doing its job.");
  } else if (alert.competition_name) {
    // v7.21.14 — the competition has SESSIONS, so "Trusted network IPs" is not
    // available for it: the competition PUT refuses that field with a 400 when
    // any session exists (v7.16.0 — the venue's address is not a property of a
    // competition that spans days and cohorts). Naming it here anyway sent the
    // admin to a control that would reject them, in the one situation where
    // they are standing in the room with the venue locked out. An instruction
    // that is not true is worse than no instruction, so say what IS true.
    lines.push("IF THIS IS YOUR VENUE'S WI-FI, this is expected: everyone in the room shares one public address, so their combined traffic looks like a single very busy client.");
    lines.push("");
    lines.push(`NOTE: "${alert.competition_name}" runs as multiple sessions, and the per-event "Trusted network IPs" setting is only available on a single-session event — so it cannot be used to unblock this address. What you can do:`);
    lines.push("");
    lines.push(`  • Wait it out — the block lifts by itself at ${until}, and participants can retry then.`);
    lines.push(`  • For a lasting fix, add ${alert.ip} to the RATE_LIMIT_ALLOWLIST_IPS environment variable and restart the platform. That needs server access, and it applies to the whole platform rather than to one event.`);
    lines.push("  • If you have decided this really is a scanner and not your venue, a superadmin can dismiss this notice for everyone.");
    lines.push("");
    lines.push("If you do NOT recognise this address, leave it blocked — the block is doing its job.");
  } else {
    // v8.1.0 (PR 20) — the inference is GONE, and the reason is that this branch
    // is now reachable in a case where it was false. anyCompetitionLive excludes
    // Programs (they have no sessions, so they would have advertised a control the
    // route refuses), so a venue working through one lands HERE — and telling that
    // admin "this is unlikely to be a venue" is the v7.21.14 defect with the sides
    // swapped. It states the remedies that exist instead of guessing at the cause.
    lines.push("No Booth Event or Competition is currently live. If you do not recognise the address, no action is needed — the block is doing its job. If a room IS working through a self-paced Program right now, that does not appear here and cannot use per-event trusted networks: wait out the block, or add the address to RATE_LIMIT_ALLOWLIST_IPS and restart.");
  }
  lines.push("");
  lines.push(`This notice clears itself when the block lapses at ${until}. If the traffic has stopped by then it will not return; if it continues, the address is blocked again and you will be told again.`);
  lines.push("To silence it for everyone straight away — because you have decided this really is a scanner and not your venue — a superadmin can dismiss it permanently.");
  if (baseUrl) { lines.push(""); lines.push(`Admin panel: ${baseUrl}`); }
  return lines.join("\n");
}

/**
 * Deliver the alert. Returns { channel: "in_app" | "email" | "none", emailed }.
 *
 * `deps` is injected rather than required at module load so this file stays
 * dependency-light and testable: countLiveAdminSessions() and sendEmail() both
 * belong to heavier subsystems.
 *
 * ext-audit v7.20.9 (F6) — the email is now sent in EVERY case. A live admin
 * session picks the PRIMARY channel; it no longer SUPPRESSES the mail.
 *
 * The old shape assumed "an admin session exists" meant "an admin will see the
 * modal". Neither half holds when it matters most:
 *
 *   • The scanner block is IP-wide, and at a hackathon the organiser is in the
 *     room, on the room's Wi-Fi — the blocked address. Their own poll for this
 *     alert is 429'd, so the notice explaining why 120 participants just lost
 *     the platform is unreachable from the one position the feature exists to
 *     serve. And it was their own session that suppressed the email.
 *   • countLiveAdminSessions() proves a session ROW is unexpired, not that
 *     anyone is looking. An admin who closed their laptop 10 minutes ago still
 *     counts for the rest of the 60-minute idle window.
 *
 * A block during a live competition is rare and high-impact, and the alert is
 * only actionable while it lasts, so a duplicate notification is far cheaper
 * than a lost one. `channel` keeps its old meaning (which surface is primary)
 * and `emailed` reports what actually went out.
 */
async function deliverAlert(alert, deps) {
  const { countLiveAdminSessions, listSuperadminEmails, sendMail, baseUrl } = deps;
  let admins = 0;
  try { admins = countLiveAdminSessions(); } catch (_) { admins = 0; }
  // The SPA's admin poll picks it up from listOpenAlerts() when someone is
  // signed in; that stays the primary channel when a session exists.
  const channel = admins > 0 ? "in_app" : "email";

  let recipients = [];
  try { recipients = listSuperadminEmails() || []; } catch (_) { recipients = []; }
  if (!recipients.length) {
    // Only a hard failure when there is no in-app path either.
    if (admins > 0) return { channel, admins, emailed: 0 };
    log.warn({ ip: alert.ip }, "IP ban alert: no admin signed in and no superadmin email address to notify");
    return { channel: "none", admins: 0, emailed: 0 };
  }
  const subject = alert.competition_name
    ? `Action may be needed: ${alert.ip} blocked during "${alert.competition_name}"`
    : `An address was temporarily blocked: ${alert.ip}`;

  // v8.3.20 — THE FAN-OUT MOVES UP HERE, and it does three things the adapter's
  // own loop could not.
  //
  // 1. The BODY IS RENDERED PER RECIPIENT, so the deadline lands in that
  //    superadmin's own timezone. `alertCopy` stays the single source of the
  //    words — the reason it lives beside the alert shape — it is simply asked
  //    the question once per reader.
  // 2. `emailed` COUNTS REAL SUCCESSES. `sendEmailLogged` catches its own SMTP
  //    error and RETURNS FALSE rather than throwing, so `emailed:
  //    recipients.length` reported N deliveries whenever the relay was down —
  //    and that number is what the `ip_ban_alert_raised` audit event records.
  //    The catch below was effectively dead in production.
  // 3. ONE BAD ADDRESS NO LONGER LOSES THE REST. An exception mid-loop used to
  //    abandon every remaining superadmin, on the one mail that must arrive.
  //
  // A recipient may arrive as a bare string (an un-migrated caller) or as
  // { email, timezone }. The string form falls back to UTC — today's behaviour —
  // so the tolerance fails safe in the direction that still delivers, and a row
  // with a NULL, empty or invalid timezone is still mailed, never skipped.
  let emailed = 0;
  let lastErr = null;
  for (const r of recipients) {
    const to = typeof r === "string" ? r : (r && r.email);
    const tz = typeof r === "string" ? null : (r && r.timezone);
    if (!to) continue;
    try {
      const sent = await sendMail(to, subject, alertCopy(alert, baseUrl, tz));
      // An adapter that returns nothing is treated as success: the boolean is
      // an improvement, not a contract every caller has adopted.
      if (sent !== false) emailed++;
    } catch (e) {
      lastErr = e;
      log.error({ ip: alert.ip, to, err: e && e.message }, "IP ban alert: superadmin email failed");
    }
  }
  if (emailed > 0) return { channel, admins, emailed, recipients: recipients.length };
  // Nothing got out. A mail failure must not downgrade a working in-app path.
  return { channel: admins > 0 ? channel : "none", admins, emailed: 0, recipients: recipients.length,
    ...(lastErr ? { error: lastErr && lastErr.message } : {}) };
}

module.exports = {
  ALERT_TTL_MS,
  recordIpBanAlert, listOpenAlerts, ackAlert, isIpSuppressed, alertCopy, deliverAlert,
  _clearAllAlertsForTests,
};
