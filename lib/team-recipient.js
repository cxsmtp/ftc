"use strict";

// AN EVENT TEAM MEMBER'S ADDRESS, AS THE RECORDS NAME IT — defined once.
//
// Team members are recipients, not accounts (lib/event-team.js), and their
// address is shown back only in the team list itself: an audit row names its
// DOMAIN, the mail's own `email_sent` record its `tm_` FINGERPRINT
// (lib/email.js), and once the address holds no role on an event's team, that
// event's send ledger (`team_report_sends`, read back as the Team section's
// recent reports) names it by both: `removedRecipient` (sweep #149; operator
// ruling, 24 Nov 2026; lib/team-reports.js).
//
// REQUIRES ONLY crypto, and that is load-bearing (the lib/session-index.js
// shape): db.js takes the removed form from here for its one-shot rewrite of the
// rows a member removed by an older release left under the address (marker
// `team_report_removed_recipients_at`), and the live paths (the member DELETE
// and POST, and the settle of a send in flight, in lib/team-reports.js) take it
// from here too, so the two cannot disagree: the address added back finds a
// rewritten row by the same string. lib/audit.js and lib/event-team.js require
// db.js, so requiring either here would be a cycle at db.js's require time.

const crypto = require("crypto");

// The address a team member may have (lib/event-team.js `validateMember`): no
// ':' in it, so no address is ever mistaken for the removed form below.
const EMAIL_RE = /^[^\s@"<>(),;:\\]{1,64}@([a-z0-9.-]{1,253})$/i;

/** The address's domain, lower-cased, or null when it is not an address. */
function domainOf(email) {
  const m = String(email || "").trim().match(EMAIL_RE);
  return m ? m[1].toLowerCase() : null;
}

// `tm_` is an event team member's address: the prefix and 12 hex of its sha256
// (lib/audit.js `capabilityFingerprint`'s shape). A team report's `email_sent`
// row (lib/email.js) records it, and so does the report ledger once the member
// is removed from the team (`removedRecipient`, below), so the two name an
// address the same way and can be matched to each other. Trimmed and
// lower-cased first: one address, one fingerprint.
function teamMemberFingerprint(address) {
  return "tm_" + crypto.createHash("sha256").update(String(address == null ? "" : address).trim().toLowerCase()).digest("hex").slice(0, 12);
}

// The ledger's name for an address that has left the event's team. A function
// of the address alone, so the member DELETE, the settle of a send in flight,
// the restore and db.js's one-shot rewrite all name the same rows.
const REMOVED_RECIPIENT_PREFIX = "removed:";
function removedRecipient(email) {
  return `${REMOVED_RECIPIENT_PREFIX}${teamMemberFingerprint(email)}:${domainOf(email) || ""}`;
}
/** Is this ledger recipient a removed member's form (rather than an address)? */
function isRemovedRecipient(recipient) {
  return String(recipient || "").startsWith(REMOVED_RECIPIENT_PREFIX);
}
/** A ledger recipient as the Team read shows it: the address, or "removed member (<domain>)". */
function recipientLabel(recipient) {
  const s = String(recipient || "");
  if (!isRemovedRecipient(s)) return s;
  const domain = s.slice(s.lastIndexOf(":") + 1);
  return domain ? `removed member (${domain})` : "removed member";
}

module.exports = {
  domainOf, teamMemberFingerprint,
  REMOVED_RECIPIENT_PREFIX, removedRecipient, isRemovedRecipient, recipientLabel,
};
