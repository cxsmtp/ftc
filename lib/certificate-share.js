"use strict";

// ── THE LINKEDIN POST AND ITS ONE-TIME SHARE LINK ─────────────────────────────
//
// Operator ruling, 29 Oct 2026: the congratulations email carries a "Copy my
// LinkedIn post" button that opens a platform SHARE PAGE with no sign-in. The
// page shows the holder's two-line post (editable) and one "Copy post & open
// LinkedIn" button. LinkedIn cannot be handed a post by URL with real @mentions,
// so the page tells the holder to pick Checkmarx and the organisers from
// LinkedIn's own suggestions.
//
// THE LINK IS A CAPABILITY, so it is:
//   • random (32 bytes) and stored only as a sha256 — a database read or a
//     backup cannot hand somebody a working link (the sign-in-code posture);
//   • BOUND to one certificate (`badge_token`, cascading with it, so revoking or
//     erasing the certificate kills the link);
//   • SHORT-LIVED (`SHARE_LINK_TTL_MS`, from minting);
//   • ONE-TIME: the page's POST consumes it with a compare-and-swap on
//     `used_at IS NULL AND expires_at > now`, so two concurrent presses cannot
//     both succeed. Opening the page (a GET) consumes nothing: mail scanners and
//     link prefetchers GET every URL in an email (CLAUDE.md, *Unsubscribe*).
//
// What the consuming POST does is the holder's own publish-on-share: it stamps
// `achievement_badges.shared_at` (write-once) and records `badge_shared`.
//
// AN EXPIRED LINK IS DELETED `SHARE_LINK_PURGE_AFTER_MS` (30 days) AFTER IT EXPIRED
// (sweep #347), by the daily retention pass (lib/event-retention.js), used or not.
// Until then it still says it has expired (or was used); after, it is the uniform
// not-found page, like a link that never existed. Without it every certificate
// mail, its retries and every Resend left a row behind for ever.
//
// The post itself is built here ONCE for both surfaces (the share page and the
// signed-in certificate card), from the FROZEN certificate (basis, rank,
// late_entrant) and the live design's `email.linkedin_*` wording.

const crypto = require("crypto");
const { BASE_URL } = require("./config");
const { resolveCertificateConfig, certificateTier, fillTokens } = require("./certificate-config");

const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60_000;
const SHARE_LINK_PURGE_AFTER_MS = 30 * 24 * 60 * 60_000;
const SHARE_LINK_RE = /^[A-Za-z0-9_-]{43}$/;

const _sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** Mint a fresh link for this certificate. Returns the plaintext token. */
function mintShareLink(db, badgeToken, nowMs = Date.now()) {
  const tok = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO certificate_share_links (id_hash, badge_token, created_at, expires_at) VALUES (?,?,?,?)`
  ).run(_sha(tok), badgeToken, new Date(nowMs).toISOString(), new Date(nowMs + SHARE_LINK_TTL_MS).toISOString());
  return tok;
}

function shareLinkUrl(tok) { return `${String(BASE_URL || "").replace(/\/+$/, "")}/badge/${tok}/post`; }

/**
 * Look a link up without consuming it. Answers `{ok:true, link, badge}` or
 * `{ok:false, reason}` with reason `unknown` | `used` | `expired` | `revoked`.
 * A malformed token is `unknown` before any query.
 */
function resolveShareLink(db, tok, nowMs = Date.now()) {
  if (typeof tok !== "string" || !SHARE_LINK_RE.test(tok)) return { ok: false, reason: "unknown" };
  const link = db.prepare("SELECT * FROM certificate_share_links WHERE id_hash=?").get(_sha(tok));
  if (!link) return { ok: false, reason: "unknown" };
  const badge = db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(link.badge_token);
  if (!badge || badge.revoked_at) return { ok: false, reason: "revoked" };
  if (link.used_at) return { ok: false, reason: "used", link, badge };
  if (Date.parse(link.expires_at) <= nowMs) return { ok: false, reason: "expired", link, badge };
  return { ok: true, link, badge };
}

/**
 * Delete the links that expired more than SHARE_LINK_PURGE_AFTER_MS before
 * `nowMs`, oldest first and at most `limit` of them (a backlog drains over
 * several passes, as the retention pass's tables do). Returns how many went.
 * A rowid subquery, because this build has no DELETE … LIMIT.
 */
function purgeExpiredShareLinks(db, { nowMs = Date.now(), limit } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("purgeExpiredShareLinks: limit must be a positive integer");
  const cutoff = new Date(nowMs - SHARE_LINK_PURGE_AFTER_MS).toISOString();
  return db.prepare(
    `DELETE FROM certificate_share_links WHERE rowid IN
       (SELECT rowid FROM certificate_share_links WHERE expires_at < ? ORDER BY expires_at ASC LIMIT ?)`
  ).run(cutoff, limit).changes;
}

/** Consume the link. True only for the one caller whose swap landed. */
function consumeShareLink(db, tok, nowMs = Date.now()) {
  if (typeof tok !== "string" || !SHARE_LINK_RE.test(tok)) return false;
  const iso = new Date(nowMs).toISOString();
  return db.prepare(
    "UPDATE certificate_share_links SET used_at=? WHERE id_hash=? AND used_at IS NULL AND expires_at > ?"
  ).run(iso, _sha(tok), iso).changes === 1;
}

const _ACHIEVEMENT = {
  gold: "🥇 1st Place", silver: "🥈 2nd Place", bronze: "🥉 3rd Place",
  participation: "a Certificate of Participation", completion: "a Certificate of Completion",
};

/** The organisers' names, from the event's organiser grants ("" when none). */
function organiserNames(db, competitionId) {
  const rows = db.prepare(
    `SELECT u.first_name, u.last_name, u.nickname FROM competition_admins ca JOIN users u ON u.id = ca.user_id
      WHERE ca.competition_id=? ORDER BY ca.granted_at, u.id LIMIT 6`
  ).all(competitionId);
  const names = rows.map(r => [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || r.nickname).filter(Boolean);
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The holder's LinkedIn post for one certificate: `{text, line1, line2,
 * achievement, verifyUrl, tier}`. Two lines: the configured sentence, then the
 * hashtags and the /credential link. The link goes in only where the event's
 * design prints the code or the QR (operator ruling, 24 Nov 2026): a design
 * that hides them keeps the code off the certificate, so a public post must
 * not publish it either. The certificate draws its QR only inside the code's
 * block (lib/badge.js: `show.qr` adds the QR beside a printed code and draws
 * nothing alone), so "the code or the QR is printed" is `show.code`. Without it (or for a legacy certificate with no code,
 * which has nothing to verify) line two is the hashtags alone.
 */
function linkedinPostFor(db, badge, comp, { platformName = "" } = {}) {
  const cfg = resolveCertificateConfig(db, comp.id);
  const tier = certificateTier({ basis: badge.basis, rank: badge.rank });
  let achievement = _ACHIEVEMENT[tier] || _ACHIEVEMENT.participation;
  if (badge.late_entrant && (tier === "gold" || tier === "silver" || tier === "bronze")) achievement += " among the late entrants";
  const organisers = organiserNames(db, comp.id);
  let tpl = String(cfg.email.linkedin_post || "");
  // No organisers on record: drop the "with {organisers}" clause rather than
  // print "with !" — the sentence must read naturally either way.
  if (!organisers) tpl = tpl.replace(/\s*(?:,\s*)?(?:with|and)\s*\{organisers\}/gi, "").replace(/\{organisers\}/g, "");
  const line1 = fillTokens(tpl, { platformName, eventName: String(comp.name || ""), achievement, organisers })
    .replace(/\s+([!.,])/g, "$1").replace(/\s{2,}/g, " ").trim();
  const showsCode = !!(cfg.show && cfg.show.code);
  const verifyUrl = badge.public_code && showsCode
    ? `${String(BASE_URL || "").replace(/\/+$/, "")}/credential?code=${encodeURIComponent(badge.public_code)}`
    : null;
  const tags = fillTokens(String(cfg.email.linkedin_hashtags || ""), { platformName }).trim();
  const line2 = [tags, verifyUrl].filter(Boolean).join(" ");
  return { text: line2 ? `${line1}\n${line2}` : line1, line1, line2, achievement, verifyUrl, tier };
}

/** LinkedIn's feed composer, pre-filled where LinkedIn honours `text`. */
function linkedinComposerUrl(text) {
  return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(String(text || ""))}`;
}

module.exports = {
  mintShareLink, shareLinkUrl, resolveShareLink, consumeShareLink, purgeExpiredShareLinks,
  linkedinPostFor, linkedinComposerUrl,
  SHARE_LINK_TTL_MS, SHARE_LINK_PURGE_AFTER_MS,
};
