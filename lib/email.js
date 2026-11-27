"use strict";

// Email subsystem: the SMTP transporter, its health probe, the bulk-send
// unsubscribe machinery (RFC 2369 / RFC 8058 List-Unsubscribe + HMAC opt-out
// tokens), the logged/background send wrappers, and the shared buildEmail /
// getUserEmails builders. (Domain: cross-cutting — Auth/Account, Invitation,
// Competition all send mail.) The per-template senders (verification, lockout,
// unlock, reminders, group-sync) live with their callers in server.js and call
// in here via sendEmailLogged / sendEmailBackground / buildEmail.
// (v7.0.0 refactor: extracted from server.js.)

const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { swallowed } = require("./best-effort");
const db = require("../db");
const { log } = require("./log");
const { now, formatEmailDate } = require("./time");
const { BASE_URL, DATA_DIR } = require("./config");
const { getPlatformName } = require("./settings");
const { escapeHtml } = require("./sanitise");
const { normaliseEmail, _b64url, _b64urlDecode, trackDetachedSend } = require("./util");
// v8.3.6 — display formatting for the sign-in code. `lib/login-code` requires
// `../db` LAZILY (inside `db_()`), so this import opens nothing at load time and
// creates no cycle: that module does not require this one — the lockout mail is
// deliberately kept at its call site precisely to avoid a lockout -> email edge.
const { formatCode } = require("./login-code");
const { recordUserEvent, recordOrphanedAuditEvent, capabilityFingerprint } = require("./audit");
const { teamMemberFingerprint } = require("./team-recipient");

const _smtpStore = require("./smtp-settings");
// v6.8.5: explicit timeouts bound a stalled SMTP server so it cannot hold the
// email pipeline open on every verification / sign-in-code / reminder mail.
//
// v8.8.13 — CORRECTED, having been measured against the shipped library rather
// than assumed. This used to say nodemailer "inherits the Node default socket
// timeout (0 = no timeout)". It does not: smtp-connection carries its OWN
// defaults (connection 120 s, greeting 30 s, socket 600 s), so dropping these
// fields would DEGRADE the ceiling by an order of magnitude rather than remove
// it. The values here are still the right ones — a ten-minute socket ceiling is
// useless to a request that must answer now — but the failure mode a future
// reader should expect is a slow send, not an unbounded hang.
// ext-audit v7.15.12 — REQUIRE TLS on the submission port. Port 587 uses
// opportunistic STARTTLS: without `requireTLS`, nodemailer happily continues in
// PLAINTEXT when the server simply omits STARTTLS from its EHLO response. A fake
// relay doing exactly that received the AUTH credentials in the clear (and every
// verification link and sign-in code with them). Opportunistic encryption is not a
// security control against an active network attacker, so we now fail the send
// instead of silently downgrading.
//
// Port 465 is implicit TLS (`secure`), so requireTLS is irrelevant there. Local
// development against mailpit / smtp4dev / maildev has no TLS at all, hence the
// explicit, documented opt-out — which is deliberately opt-IN by env var rather
// than inferred from NODE_ENV, so a production box can never quietly land in the
// insecure branch because an env var was unset.
// The ENVIRONMENT's relay port, and its security: port 465 is implicit TLS.
const _SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const _SMTP_SECURE = _SMTP_PORT === 465;
const _SMTP_ALLOW_PLAINTEXT = process.env.SMTP_ALLOW_PLAINTEXT === "1";
if (_SMTP_ALLOW_PLAINTEXT) {
  console.warn("[smtp] SMTP_ALLOW_PLAINTEXT=1 — STARTTLS is NOT required. Credentials and links may cross the network in the clear. Development only.");
}
// ONE POOL OF RELAY CONNECTIONS, not a connection per message. An
// unpooled transport opened (DNS, TCP, greeting, STARTTLS, AUTH) and closed a
// connection for every mail, so 3000 people pressing "Send code" at once meant
// 3000 connections to the relay and ~5 ms of main-thread time each. The pool
// keeps at most SMTP_POOL_MAX_CONNECTIONS open (default 16: twice the bulk
// fan-outs' lane count, `_runBoundedWithDeadline(…, 8, …)`, so a fan-out never
// waits on another lane and sign-in mail sent beside it still has connections;
// below 8 a fan-out would queue on itself) and reuses each for up to
// SMTP_POOL_MAX_MESSAGES messages. A send beyond them waits for a free connection
// in sendEmailLogged (`_acquireSlot`), in arrival order, BEFORE its erasure and
// opt-out checks, so the checks run as the mail goes out and a backlog cannot
// outlive a deletion or an opt-out (nodemailer's own queue would hold a message
// already checked). Graceful shutdown drains the tracked sends within its budget
// (a send still waiting then is never sent), then closeTransport() closes the
// idle connections.
const _poolInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const SMTP_POOL_MAX_CONNECTIONS = _poolInt(process.env.SMTP_POOL_MAX_CONNECTIONS, 16, 1, 64);
const SMTP_POOL_MAX_MESSAGES = _poolInt(process.env.SMTP_POOL_MAX_MESSAGES, 100, 1, 10000);

// The transport options for one relay configuration (`cfg`: host, port,
// security "starttls"|"tls", username, password). `security: "tls"` is implicit
// TLS (the environment's port 465); "starttls" REQUIRES the upgrade unless the
// environment opts out with SMTP_ALLOW_PLAINTEXT=1, which stays env-only: the
// app can never put the platform's mail in the clear.
function _transportOptions(cfg, pooled) {
  // This relay's own security (it shadows the environment's on purpose: a saved
  // relay names its own).
  const _SMTP_SECURE = cfg.security === "tls";
  return {
    ...(pooled ? { pool: true, maxConnections: SMTP_POOL_MAX_CONNECTIONS, maxMessages: SMTP_POOL_MAX_MESSAGES } : {}),
    host: cfg.host,
    port: cfg.port,
    secure: _SMTP_SECURE,                       // implicit TLS
    requireTLS: !_SMTP_SECURE && !_SMTP_ALLOW_PLAINTEXT,
    // connectionTimeout bounds the WHOLE setup together: DNS, connect (plus TLS on
    // 465), the greeting and the STARTTLS upgrade. greetingTimeout only caps the
    // greeting and the upgrade within what is left of it, so at 10 s it adds no
    // allowance of its own: a relay slow at both steps fails at 10 s, not 10 + 10.
    connectionTimeout: 10_000,
    greetingTimeout:    10_000,
    socketTimeout:      30_000, // 30 s of socket INACTIVITY, not a per-message ceiling
    ...(cfg.username ? { auth: { type: "LOGIN", user: cfg.username, pass: cfg.password || "" } } : {}),
  };
}

// ── The sender identity: address from the OPERATOR, name from the PLATFORM ───
//
// The From header has two halves and they deliberately come from two different
// places:
//
//   ADDRESS — the relay's sender address: `EMAIL_FROM` (resolved once at boot),
//     or the one a SUPERADMIN saved with the relay in Settings → Email (SMTP).
//     This is the identity SPF is evaluated against and the return path bounces
//     come back to, so it has to be a value the OPERATOR controls on a domain
//     they own: a bare address, validated on save, never the free-text platform
//     name below, and never writable by any other role.
//   DISPLAY NAME — Settings → Platform Name, read per send. A rebrand should
//     reach the recipient's inbox without a redeploy, which is the whole point
//     of the setting; every other surface (header, subjects, badge page) has
//     followed it for releases and the sender did not.
//
// v7.26.0 — the display name previously came from `EMAIL_FROM` too, so it was
// frozen at deploy time and renaming the platform moved every surface EXCEPT
// the one recipients see first. The platform name now always wins for the name
// half; a display name written into `EMAIL_FROM` is ignored (see README).
//
// **THIS MUST STAY THE {name, address} OBJECT FORM. NEVER COMPOSE IT BY
// CONCATENATION.** That is not style — nodemailer routes `From` into its
// structured-address branch, so it RE-PARSES whatever string it is handed, and
// an embedded angle-addr wins the parse. Measured against this repo's
// nodemailer 9.0.4 with the old `${getPlatformName()} <no-reply@…>` shape:
//
//   platform name = 'Evil <attacker@evil.test>'
//     From:     "Evil no-reply@hackathon.local" <attacker@evil.test>
//     envelope: { from: "attacker@evil.test" }
//
// i.e. an admin-settable free-text field took over BOTH the visible sender and
// the SMTP MAIL FROM — the bounce path, and the identity SPF authenticates — on
// verification, sign-in-code and lockout mail, the messages whose sender IS
// the security signal. It hijacked the List-Unsubscribe domain by the same
// route. That was live whenever `EMAIL_FROM` was unset, which the README
// documents as a supported configuration.
//
// The object form is immune by construction: `address` is a separate field that
// is never parsed out of the name, and the name is emitted as an RFC 5322
// quoted-string (or an RFC 2047 encoded-word when non-ASCII) by nodemailer's
// `_encodeAddressName`. Do not hand-roll that quoting — a second implementation
// is the thing that drifts.
const _DEFAULT_SENDER_ADDRESS = "no-reply@hackathon.local";

// Pull the addr-spec out of an `EMAIL_FROM` in either documented shape:
// `Name <user@host>` or a bare `user@host`. The angle form is anchored at the
// END because a mailbox is `display-name <addr>` — the address is the last
// thing on the line, and reading it that way is also the safer answer for a
// name that itself contains angle brackets.
//
// This deliberately does NOT reuse `isValidEmailFormat` (lib/util.js): v7.15.7
// hardened that to REJECT mailbox syntax, so `Name <a@b.com>` fails it by
// design. Two different questions, two different predicates.
function _extractSenderAddress(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/<([^<>\s,]+@[^<>\s,]+)>\s*$/) || s.match(/^([^<>\s,]+@[^<>\s,]+)$/);
  return m ? m[1] : null;
}

// The ENVIRONMENT's sender, resolved once: `EMAIL_FROM` cannot change under a
// running process. Used when no relay is saved in the app (and named "default"
// when EMAIL_FROM gives no usable address).
const _ENV_SENDER = (function _resolveSenderAddress() {
  const raw = process.env.EMAIL_FROM;
  const addr = _extractSenderAddress(raw);
  if (addr) return { address: addr, source: "environment" };
  // Non-fatal, matching EMAIL_FROM's documented "optional" status — but loud,
  // because the fallback is a domain the operator almost certainly does not own,
  // so their mail will fail SPF and bounce nowhere useful.
  if (raw && String(raw).trim()) {
    console.warn(`[email] EMAIL_FROM contains no usable address (${JSON.stringify(String(raw).slice(0, 120))}) —` +
      ` falling back to ${_DEFAULT_SENDER_ADDRESS}. Set it to a bare address ("no-reply@yourdomain")` +
      ` or a mailbox ("Anything <no-reply@yourdomain>"); the display-name half is ignored, the platform name is used instead.`);
  }
  return { address: _DEFAULT_SENDER_ADDRESS, source: "default" };
})();

// ── WHICH RELAY IS IN FORCE: saved in the app, else the environment ──────────
//
// A relay a superadmin saved in Settings → Email (SMTP) (lib/smtp-settings.js)
// REPLACES the environment's SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS /
// EMAIL_FROM as a whole, never field by field: half of one relay and half of
// another (one host, another's password) is never what anyone meant. Removing
// the saved relay returns to the environment. One exception keeps mail going:
// while the saved password cannot be read (the key file is not in backups, so a
// restore or a move to another server loses it) and the environment names a
// relay, the environment's relay is used, and the Settings card says so until a
// superadmin enters the password again. With no relay at all the server does not
// start (below).
function _envSmtpConfig() {
  const host = String(process.env.SMTP_HOST || "").trim();
  if (!host) return null;
  const username = process.env.SMTP_USER || "";
  return {
    host, port: _SMTP_PORT, security: _SMTP_SECURE ? "tls" : "starttls", username,
    password: username ? (process.env.SMTP_PASS || "") : "",
    sender: _ENV_SENDER.address, sender_source: _ENV_SENDER.source,
  };
}
/**
 * The relay in force, or null when there is none. Holds the PASSWORD: server
 * side only, never sent to a client or written to a log.
 * `source` is "app" or "environment"; `saved` is the stored row (password still
 * encrypted) or null; `password_unreadable` is true while a saved password
 * cannot be decrypted; `environment_relay` says whether the environment names one.
 */
function effectiveSmtpConfig() {
  const env = _envSmtpConfig();
  const saved = _smtpStore.readStoredSmtp(db);
  if (saved) {
    const pw = saved.password_enc ? _smtpStore.decryptPassword(saved.password_enc) : "";
    const unreadable = !!saved.password_enc && pw === null;
    if (unreadable && env) return { ...env, source: "environment", saved, password_unreadable: true, environment_relay: true };
    return {
      host: saved.host, port: saved.port, security: saved.security, username: saved.username,
      password: unreadable ? "" : pw, sender: saved.sender, sender_source: "app",
      source: "app", saved, password_unreadable: unreadable, environment_relay: !!env,
    };
  }
  return env ? { ...env, source: "environment", saved: null, password_unreadable: false, environment_relay: true } : null;
}

let _active = effectiveSmtpConfig();
if (!_active) {
  console.error("FATAL: no mail relay is configured. Set SMTP_HOST (with SMTP_PORT, SMTP_USER and SMTP_PASS as your relay needs) for the first start; a superadmin can then save the relay in Settings → Email (SMTP).");
  process.exit(1);
}
if (_active.password_unreadable) {
  console.warn(`[smtp] The mail relay password saved in Settings cannot be read on this server (${_active.source === "environment" ? "sending through the environment's relay meanwhile" : "the environment names no relay, so sending without it"}). A superadmin must enter it again in Settings → Email (SMTP).`);
}
let _senderAddress = _active.sender;

// THE TRANSPORT IS SWAPPED LIVE when a superadmin saves or removes a relay
// (reloadSmtpTransport). `transporter` is a stable facade over the current pool,
// so every caller keeps one reference. A send counts against the pool it started
// on; a replaced pool is RETIRED, and closed only once its last send has been
// answered (nodemailer's close() would fail a message still in its queue), so no
// mail in flight is lost to a save. The slot gate (`_acquireSlot`) spans pools,
// so old and new together never hold more than SMTP_POOL_MAX_CONNECTIONS.
const _retiring = new Set();
let _cur = { t: nodemailer.createTransport(_transportOptions(_active, true)), inflight: 0, retired: false };
function _settle(e) {
  if (!e.retired || e.inflight > 0) return;
  _retiring.delete(e);
  try { e.t.close(); } catch (err) { swallowed("email:close-retired-transport", err); }
}
const transporter = {
  async sendMail(opts) {
    const e = _cur;
    e.inflight++;
    try { return await e.t.sendMail(opts); }
    finally { e.inflight--; _settle(e); }
  },
  verify() { return _cur.t.verify(); },
};

// The platform name is admin-authored free text. Control characters are stripped
// for CORRECTNESS, not as injection defence — nodemailer cannot be made to emit a
// raw CR/LF from this field (every branch of `_encodeAddressName` either excludes
// them by character class or Q-encodes them), so the risk here is a recipient
// seeing a literal `=0D=0A` in their From line, not an injected header.
// `PATCH /api/admin/settings` refuses these outright; this is defence in depth for
// a legacy stored row and for the uncapped `COMPETITION_NAME` env fallback.
//
// No length cap on purpose. The value is already bounded at 120 chars by the
// settings route, and a third number in a third file is exactly the mirror
// divergence this codebase keeps paying for.
function _safeDisplayName(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The ONE definition of who platform mail comes from — the whole ladder, not
 * just the literal. Both senders call this (`sendEmailLogged` and the
 * `/api/admin/test-email` diagnostic); a resolver with two fallback ladders is
 * not shared, and the diagnostic that reports a different sender from real mail
 * is worse than no diagnostic.
 *
 * An empty name after sanitising yields a bare-address From, which is legal —
 * there is no better value to invent, and the platform-name COALESCE chain ends
 * in a literal, so it is only reachable via a control-character-only name.
 */
function resolveSender(address) {
  return { name: _safeDisplayName(getPlatformName()), address: address || _senderAddress };
}

// SMTP health probe (v6.2.6): the transporter is created once at startup but
// the underlying server can become unreachable later (DNS change, credential
// rotation, network partition). Without an explicit probe, every email failure
// is logged at the per-send call site and an operator only learns SMTP is
// broken when a participant complains they didn't get a verification email.
//
// Strategy: verify() at startup and on a 5-minute interval. Each probe runs
// on a non-blocking promise so it never delays the request loop. Result is
// log.warn'd on failure / log.info on first-after-failure recovery so the
// admin log viewer surfaces the gap directly. The previous state is held in
// _smtpHealthy so we don't spam log lines for steady-state OK pings.
// Sends not yet answered (on a relay connection plus waiting for one): the
// /metrics gauge hack_arena_smtp_sends_pending.
let _smtpSendsPending = 0;
function smtpSendsPending() { return _smtpSendsPending; }
// One slot per pool connection, handed out in arrival order.
let _slotsBusy = 0;
const _slotWaiters = [];
function _acquireSlot() {
  if (_slotsBusy < SMTP_POOL_MAX_CONNECTIONS) { _slotsBusy++; return Promise.resolve(); }
  return new Promise(resolve => _slotWaiters.push(resolve));
}
function _releaseSlot() {
  const next = _slotWaiters.shift();
  if (next) next();          // the slot passes on, still counted busy
  else _slotsBusy--;
}
/**
 * Close the pools' connections (graceful shutdown, after the mail drain): the
 * current pool and any retired one still finishing a send.
 */
function closeTransport() {
  for (const e of [_cur, ..._retiring]) {
    try { e.t.close(); } catch (err) { /* best effort at exit */ swallowed("email:close-transport", err); }
  }
  _retiring.clear();
}
let _smtpHealthy = null; // null=unknown, true=last-probe-OK, false=last-probe-FAILED
let _smtpLastCheck = null; // { at, ok } of the last probe of the relay in force
let _probeGen = 0;         // a probe of a replaced relay reports nothing
function smtpHealthy() { return _smtpHealthy; }
function smtpLastCheck() { return _smtpLastCheck ? { ..._smtpLastCheck } : null; }
function _probeSmtp(reason) {
  const gen = _probeGen;
  const relay = { host: _active.host, port: _active.port };
  transporter.verify().then(() => {
    if (gen !== _probeGen) return;
    if (_smtpHealthy === false) {
      log.info({ smtp_host: relay.host, reason }, "SMTP health probe: recovered");
    }
    _smtpHealthy = true;
    _smtpLastCheck = { at: now().toISOString(), ok: true };
  }).catch((err) => {
    if (gen !== _probeGen) return;
    if (_smtpHealthy !== false) {
      log.warn({
        smtp_host: relay.host,
        smtp_port: relay.port,
        reason,
        error: (err && err.message ? String(err.message).slice(0, 300) : "unknown"),
        // ext-audit v7.15.12 — TLS is now REQUIRED (see the transport above). If
        // that is what failed, say so and name the escape hatch, rather than
        // leaving an operator to guess why mail stopped after an upgrade.
        ...(/STARTTLS|TLS/i.test(String(err && err.message || "")) ? {
          hint: "This server requires STARTTLS since v7.15.12. Point the relay at a TLS-capable one (or use implicit TLS on port 465), or — for local development only — set SMTP_ALLOW_PLAINTEXT=1 to restore the previous opportunistic behaviour.",
        } : {}),
      }, "SMTP health probe: FAILED — outgoing email is broken");
    }
    _smtpHealthy = false;
    _smtpLastCheck = { at: now().toISOString(), ok: false };
  });
}
// Initial probe runs after a short delay so the server's own listen() and
// log file rotation are up first. NODE_ENV=test skips the probe entirely
// because the test suite hits a non-existent SMTP and would otherwise warn
// every 5 minutes during a long test run.
if (process.env.NODE_ENV !== "test") {
  setTimeout(() => _probeSmtp("startup"), 3_000);
  setInterval(() => _probeSmtp("interval"), 5 * 60_000).unref();
}

/**
 * Re-read which relay is in force and swap the pool to it, live (after a
 * superadmin saves or removes the relay in Settings). The old pool is retired
 * and closed once its sends are answered; the sender address follows at once;
 * the health state starts over ("not checked yet") and, outside tests, a probe
 * of the new relay runs now. Returns false (changing nothing) when no relay is
 * left, which the routes refuse before writing.
 */
function reloadSmtpTransport(reason) {
  const next = effectiveSmtpConfig();
  if (!next) return false;
  const old = _cur;
  _cur = { t: nodemailer.createTransport(_transportOptions(next, true)), inflight: 0, retired: false };
  _active = next;
  _senderAddress = next.sender;
  old.retired = true;
  _retiring.add(old);
  _settle(old);
  _probeGen++;
  _smtpHealthy = null;
  _smtpLastCheck = null;
  if (process.env.NODE_ENV !== "test") _probeSmtp(reason);
  return true;
}

// A relay's error text with the password (and its base64, which AUTH LOGIN
// sends) cut out, in case a relay ever echoed it, capped like every relay error.
function _relayErrorText(e, password) {
  let t = String((e && e.message) || e || "send failed").replace(/[\r\n]+/g, " ");
  if (password) {
    for (const v of [password, Buffer.from(password, "utf8").toString("base64")]) t = t.split(v).join("[REDACTED]");
  }
  return t.slice(0, 300);
}

/**
 * Send one test message through a relay that is NOT saved (Settings → Email
 * (SMTP), "Test with these values"): its own short-lived, unpooled connection,
 * so the relay in force is untouched. The From is the shared resolver's with
 * the candidate's sender address. Resolves `{ok}` or `{ok:false, error}`.
 */
async function sendSmtpTest(cfg, { to, subject, text }) {
  const t = nodemailer.createTransport(_transportOptions(cfg, false));
  try {
    await t.sendMail({ to, from: resolveSender(cfg.sender), subject, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: _relayErrorText(e, cfg.password) };
  } finally {
    try { t.close(); } catch (err) { swallowed("email:close-test-transport", err); }
  }
}

function getUserEmails(user) {
  // Defence-in-depth dedup: input validators reject primary==secondary
  // (sameSlotEmails below), but if a row ever slips through we must not
  // mail the same address twice. Case-insensitive comparison matches the
  // identity model used everywhere else.
  const emails = [user.email];
  if (user.secondary_email && String(user.secondary_email).toLowerCase() !== String(user.email || "").toLowerCase()) {
    emails.push(user.secondary_email);
  }
  return emails.join(", ");
}

// An HTML fragment as the plain-text part shows it: block ends become line
// breaks, tags go, and entities are decoded with `&amp;` LAST (decoded first, an
// escaped "&lt;" typed by someone would come out as "<").
function _htmlToText(html) {
  return String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/li>/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&#8212;/g, "\u2014").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * One mail in both parts. `body` is the only HTML argument (callers escape what
 * they put in it); `greeting`, `linkText` and `fallbackNote` are PLAIN TEXT, the
 * raw value: this escapes them for the HTML part and writes them as they are in
 * the plain-text part, so a name holding & or an apostrophe reads as typed in
 * both (sweep #405; lock: the fallbackNote source arm of
 * tests/certificate-dispatch.spec.js).
 */
function buildEmail(platformName, { greeting, body, linkUrl, linkText, fallbackNote }) {
  const esc = escapeHtml;
  const footer = `<p style="font-size:0.85em;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px">&#8212; The ${esc(platformName)} Team</p>`;
  let html = `<h2>${esc(platformName)}</h2>`;
  if (greeting) html += `<p>Hi ${esc(greeting)},</p>`;
  html += body;
  if (linkUrl && linkText) {
    html += `<p><a href="${esc(linkUrl)}">${esc(linkText)}</a></p>`;
    html += `<p style="font-size:0.85em;color:#666">If the link does not work, copy and paste this URL into your browser:<br/>${esc(linkUrl)}</p>`;
  }
  if (fallbackNote) html += `<p style="font-size:0.85em;color:#666">${esc(fallbackNote)}</p>`;
  html += footer;

  let text = `${platformName}\n\n`;
  if (greeting) text += `Hi ${greeting},\n\n`;
  text += _htmlToText(body).replace(/\n{3,}/g, "\n\n").trim();
  if (linkUrl) text += `\n\n${linkUrl}`;
  if (fallbackNote) text += `\n\n${fallbackNote}`;
  text += `\n\n-- The ${platformName} Team`;

  return { html, text };
}

// v6.16.28 — bulk-style email reasons get RFC 2369 / RFC 8058
// `List-Unsubscribe` headers so Gmail / Outlook / Apple Mail
// classify the sender as a legitimate bulk transactional sender
// rather than spam. Auth-related reasons (verification, reset-
// password, lockout, etc.) intentionally skip the headers because
// (a) they're non-bulk-sender per RFC and (b) recipients can't
// usefully unsubscribe from a one-off security email.
//
// v6.16.31 — added one-click HTTPS unsubscribe per RFC 8058. The
// platform now emits BOTH a `<mailto:>` opt-out alias AND an
// `<https://.../api/unsubscribe?token=...>` token-signed URL, plus
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click` so Gmail's
// click-the-X UX hits the HTTPS endpoint without opening a browser.
//
// v8.3.7 — `account_approved_bulk` LEFT THIS SET, and the asymmetry it created is
// why. It and `account_approved` are byte-identical mail — same subject, same
// body — and differed only in whether an opted-out recipient received them:
// approving ONE participant reached them, approving the SAME participant inside a
// batch did not. To an operator that is one button, so the behaviour was
// unpredictable in the way an operator can never diagnose.
//
// Equalised TOWARDS delivery, deliberately. An approval is transactional — it is
// the notice that an account the person asked for is now usable — and it belongs
// with verification, sign-in codes and lockouts, none of which are suppressible.
// Equalising the other way would mean someone who once unsubscribed from event
// reminders never learns their account was approved, and has no way to find out.
//
// The reason STRING is kept distinct so `user_events.email_sent` still tells an
// investigator whether an approval was individual or part of a batch; only the
// opt-out behaviour is unified.
const _BULK_EMAIL_REASONS = new Set([
  "invitation",
  "competition_assignment",
  "reminder",
  "removed_from_competition",
  // v8.15.1 — the congratulations email carrying a certificate
  // (lib/certificate-dispatch.js). Opt-out-able on purpose: it announces
  // something the holder can always collect from the event's Challenges page, so no account
  // depends on it, and a person who unsubscribed from event mail asked not to get
  // exactly this. The certificate itself is still issued.
  "certificate_awarded",
]);

// HMAC-signed unsubscribe token: base64url(payload).base64url(sig).
// Payload = JSON {e: <normalised email>, x: <expiry epoch ms>}.
// v6.16.41 — secret is now persisted to DATA_DIR/.unsubscribe-secret
// (mode 0o600, 32 random bytes) on first boot and re-read on every
// subsequent boot. Pre-fix the secret derived from the per-startup
// SESSION_SECRET, so any restart / deploy invalidated already-sent
// 365-day unsubscribe URLs — contradicting the README's "Tokens
// expire after 365 days" promise and breaking RFC-8058 / Gmail
// bulk-sender expectations that an issued unsubscribe URL keeps
// working. If the file can't be created (read-only filesystem), we
// log loudly and fall back to an in-memory random secret with the
// same single-process lifetime as before.
const _UNSUBSCRIBE_SECRET_PATH = path.join(DATA_DIR, ".unsubscribe-secret");
const _UNSUBSCRIBE_SECRET = (function _loadOrCreateUnsubscribeSecret() {
  try {
    const buf = fs.readFileSync(_UNSUBSCRIBE_SECRET_PATH);
    if (buf.length >= 16) return buf;
    // Truncated / corrupt — regenerate.
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[unsubscribe] failed to read persistent secret:", e.message);
    }
  }
  const fresh = crypto.randomBytes(32);
  try {
    fs.writeFileSync(_UNSUBSCRIBE_SECRET_PATH, fresh, { mode: 0o600 });
    try { fs.chmodSync(_UNSUBSCRIBE_SECRET_PATH, 0o600); } catch (e) { swallowed("email:unsubscribe-secret-chmod", e); }
  } catch (e) {
    console.error("[unsubscribe] could not persist secret to", _UNSUBSCRIBE_SECRET_PATH, "—", e.message,
      "— tokens will invalidate on every restart until this is fixed");
  }
  return fresh;
})();
const _UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
function generateUnsubscribeToken(email) {
  const norm = normaliseEmail(email);
  if (!norm) return null;
  const payload = JSON.stringify({ e: norm, x: Date.now() + _UNSUBSCRIBE_TTL_MS });
  const sig = crypto.createHmac("sha256", _UNSUBSCRIBE_SECRET).update(payload).digest();
  return `${_b64url(payload)}.${_b64url(sig)}`;
}
function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payloadBuf, sigBuf;
  try { payloadBuf = _b64urlDecode(parts[0]); sigBuf = _b64urlDecode(parts[1]); } catch { return null; }
  const expected = crypto.createHmac("sha256", _UNSUBSCRIBE_SECRET).update(payloadBuf).digest();
  if (sigBuf.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expected)) return null;
  let payload;
  try { payload = JSON.parse(payloadBuf.toString("utf8")); } catch { return null; }
  if (!payload || typeof payload.e !== "string" || typeof payload.x !== "number") return null;
  if (Date.now() > payload.x) return null;
  return payload.e; // normalised email
}

// `senderAddress` is the RESOLVED addr-spec (`SENDER_ADDRESS`), never a composed
// From header.
//
// v7.26.0 — this used to re-parse the From string with its own regex
// (`/<([^>]+)>|([^<>\s]+@[^<>\s]+)/`), which is two parsers for one value: it and
// nodemailer's addressparser demonstrably disagreed. A platform name containing
// `<...>` matched FIRST, so the mailto alias advertised the injected domain, and
// a bare `x@evil.com` name hit the second alternation and did the same with no
// angle brackets at all. A helper that reads the From differently from the thing
// that sends it is not reading the From — so it is handed the address instead,
// and the regex is deleted rather than repaired.
function _bulkEmailHeaders(senderAddress, recipientToField) {
  const domain = String(senderAddress || "").split("@")[1] || "hackathon.local";
  // List-Unsubscribe MUST be a comma-separated list of <URI>s. Modern
  // mail clients (Gmail, Outlook 365) prefer the HTTPS variant for
  // one-click; legacy clients fall back to mailto:. Both surfaces
  // are advertised so neither group is left without an opt-out.
  // For multi-recipient sends (primary + secondary email), the token
  // is generated for the FIRST address — typically the primary email
  // — so a click unsubscribes the canonical address. The pipeline's
  // _isUnsubscribed() check then short-circuits any future bulk send
  // that includes EITHER address.
  const headers = {};
  const addrs = _splitRecipients(recipientToField);
  const primary = addrs[0];
  if (primary) {
    const token = generateUnsubscribeToken(primary);
    if (token) {
      headers["List-Unsubscribe"] = `<${BASE_URL}/api/unsubscribe?token=${token}>, <mailto:unsubscribe@${domain}?subject=unsubscribe>`;
      // RFC 8058: this header signals to the mail client that the
      // HTTPS URL accepts a POST with no body and will unsubscribe
      // on receipt — no browser context, no captcha, no auth.
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      return headers;
    }
  }
  // Fallback when we can't compute a token (no recipient): mailto-only.
  headers["List-Unsubscribe"] = `<mailto:unsubscribe@${domain}?subject=unsubscribe>`;
  return headers;
}

// v6.16.31 — recipient unsubscribe check. The bulk email pipeline
// looks up each recipient address in `unsubscribed_emails`; ANY hit
// short-circuits the send, records a user_event for forensics, and
// returns success=false from the wrapper. Auth-flow emails skip
// this check entirely — those are non-bulk and the recipient can't
// have unsubscribed from a one-off security email.
//
// Multi-recipient handling: getUserEmails() builds "primary, secondary"
// for competition_assignment / removed_from_competition. If EITHER
// is unsubscribed, the whole send is skipped. The conservative call:
// we'd rather not mail at all than mail an opt-out address, even if
// the other recipient is still subscribed.
function _splitRecipients(to) {
  if (!to) return [];
  return String(to).split(",").map(s => normaliseEmail(s.trim())).filter(Boolean);
}
function _isUnsubscribed(toField) {
  const addrs = _splitRecipients(toField);
  if (!addrs.length) return false;
  const ph = "SELECT value FROM json_each(?)";
  const row = db.prepare(`SELECT 1 FROM unsubscribed_emails WHERE email IN (${ph}) LIMIT 1`).get(JSON.stringify(addrs));
  return !!row;
}

// v8.12.6 (sweep) — A MAIL FOR AN ACCOUNT IS A MAIL FOR AN ACCOUNT THAT STILL
// EXISTS. Every call site that names a recipient by user id composes the message
// from a row it read EARLIER — the bounded fan-outs (the assign mail, bulk
// approve) queue one thunk per participant and run eight at a time, the group
// sync sends in the background, the reminder dispatcher walks its batch through
// one SMTP await per row — and none of them re-read the row before sending. So a
// participant DELETED between the enqueue and the send (a superadmin's erasure,
// or the unverified-account reaper) was still mailed at the address the deletion
// had just erased: measured with a slow relay, an assignment mail delivered 4.2 s
// after the deletion. Asked HERE, at the one chokepoint every one of those thunks
// reaches, rather than in N copies at the call sites — a copy per site is how a
// fifth fan-out arrives without it. One indexed point lookup, against a send that
// is already an SMTP round trip.
//
// A deliberate mail to an account being deleted would have to pass `null` — the
// shape an invitation already uses for a recipient with no row.
function _recipientErased(userId) {
  return !!userId && !db.prepare("SELECT 1 FROM users WHERE id=?").get(userId);
}

// Wrapped sendMail that logs success/failure to user_events. `userId` can be
// null when sending to a non-user recipient (an invitation invitee has no user
// row yet), in which case the per-send `email_sent` row is skipped — there is no
// row to attach it to.
//
// v8.3.7 — A SUPPRESSION IS RECORDED EVEN THEN. See the skip branch below: the
// no-userId case used to leave NO trace anywhere, and the one call site that
// passes null is the one where it mattered.
// `about` NAMES THE EVENT(S) A SEND CONCERNS (operator ruling, 17 Nov 2026):
// `{competitionId}` (null for a mail about no event) or `{competitionIds}` for a
// mail listing several. It is written onto the `email_sent` row as
// `competition_id` / `competition_ids`, so a History reader outside those events
// never sees the row (lib/event-admin.js `userEventCompetitionScopeSql`). A send
// that passes nothing is recorded without the key, and a scoped reader sees such
// a row without its subject (`userEventDetailsSql`), since a subject can name an
// event: a user-facing send passes `about`.
function _aboutKeys(about) {
  if (!about || typeof about !== "object") return {};
  const out = { competition_id: typeof about.competitionId === "string" ? about.competitionId : null };
  const many = Array.isArray(about.competitionIds) ? about.competitionIds.filter(x => typeof x === "string") : [];
  if (many.length) out.competition_ids = many;
  return out;
}
// Run `fn` holding one relay-connection slot, counted as pending until it ends.
// Every send takes one: the mail pipeline below, and the SMTP diagnostic
// (POST /api/admin/test-email), so no send queues inside nodemailer's pool.
async function withSmtpSlot(fn) {
  _smtpSendsPending++;
  await _acquireSlot();
  try {
    return await fn();
  } finally {
    _releaseSlot();
    _smtpSendsPending--;
  }
}
async function sendEmailLogged(userId, mailOpts, reason, about) {
  // A relay connection first, THEN the checks: a mail waiting behind a backlog
  // is asked whether its recipient still exists and still wants it when it
  // leaves, not when it was queued (EMAIL_RULES.md).
  return withSmtpSlot(() => _sendHoldingSlot(userId, mailOpts, reason, about));
}
async function _sendHoldingSlot(userId, mailOpts, reason, about) {
  // v7.26.0 — the sender is NOT caller-overridable. It used to be
  // (`mailOpts.from || …`), a tier no call site ever exercised, and leaving it
  // would let a future caller hand in a composed STRING and quietly reintroduce
  // the address hijack documented at resolveSender. The spread below puts
  // `from` last for the same reason.
  const from = resolveSender();
  // v8.12.6 (sweep) — the recipient's account is gone, so nothing is sent (see
  // `_recipientErased` above). RECORDED, the v8.3.7 rule — a suppression leaves a
  // trace even with no row to hang it on — and recorded WITHOUT the address: no
  // mail went anywhere, so the erased address has no business being written again.
  // The user id is what ties the line to the deletion's own `deleted` event.
  if (_recipientErased(userId)) {
    try {
      recordOrphanedAuditEvent("email", "suppressed", "email_suppressed", "system", {
        user_id: userId, subject: mailOpts.subject, reason, success: false, skipped: "recipient_deleted",
      });
    } catch (e) { /* never let event logging break the send path */ swallowed("email:suppressed-erased-emit", e); }
    return false;
  }
  // v6.16.31 — short-circuit for unsubscribed recipients on bulk
  // reasons. Returns success=false so callers see the same shape
  // they would on any other delivery failure; the user_event row
  // carries `skipped: "unsubscribed"` so the audit log explains why.
  //
  // ── v8.3.7 — AND IT IS RECORDED WHEN THERE IS NO USER ROW ──────────────────
  //
  // The `if (userId)` guard was right about WHERE to write and wrong about
  // WHETHER to: with no user row there is nowhere to hang a `user_events` row, so
  // the suppression was skipped entirely. Exactly one call site passes null —
  // `POST /api/admin/invitations`, for an invitee who does not exist yet — and it
  // is the site where the silence costs most: an invitation to an opted-out
  // address vanished with NO record anywhere, while the admin was shown it as an
  // undelivered invite to work around by hand.
  //
  // An orphaned audit event is the established shape for "a thing happened and
  // there is no entity to attach it to". It carries the ADDRESS because that is
  // the only identifier the event has — and it is the recipient's own address on
  // an admin-only forensic surface, not a disclosure to anyone new.
  if (_BULK_EMAIL_REASONS.has(reason) && mailOpts.to && _isUnsubscribed(mailOpts.to)) {
    const details = {
      to: mailOpts.to, subject: mailOpts.subject, reason, success: false,
      skipped: "unsubscribed", ..._aboutKeys(about),
    };
    try {
      if (userId) recordUserEvent(userId, "email_sent", "system", details);
      else recordOrphanedAuditEvent("email", "suppressed", "email_suppressed", "system", details);
    } catch (e) { /* never let event logging break the send path */ swallowed("email:suppressed-emit", e); }
    return false;
  }
  let success = false, errMsg = null;
  try {
    const finalOpts = { ...mailOpts, from };
    if (_BULK_EMAIL_REASONS.has(reason)) {
      finalOpts.headers = { ...(finalOpts.headers || {}), ..._bulkEmailHeaders(from.address, mailOpts.to) };
    }
    await transporter.sendMail(finalOpts);
    success = true;
  } catch (e) {
    errMsg = (e.message || String(e)).replace(/[\r\n]/g, "");
    // An address proof's (or a team report's) SMTP text can quote the address: its code only.
    console.error(`Email error (${reason}):`, (reason === "email_proof" || reason === "event_team_report") ? ((e && e.code) || "send_failed") : errMsg);
  }
  // v8.7.6 — RECORDED WHETHER OR NOT THERE IS A USER ROW, which is the same
  // correction v8.3.7 made to the SUPPRESSION branch above — and it made it only
  // there. Its own words: "the `if (userId)` guard was right about WHERE to write
  // and wrong about WHETHER to." The delivery branch kept the guard, so the two
  // call sites that pass null — `POST /api/admin/invitations` and the IP-ban
  // alert — sent real mail and recorded NOTHING ANYWHERE: no user_events row and
  // no mirror line, so an operator asking "did the invitation go out?" had only
  // the relay's own logs, which are not ours to read.
  //
  // That is the class this release was opened for. An orphaned audit event is the
  // established shape (v8.3.7): it carries the ADDRESS, the only identifier such
  // a send has, on an admin-only forensic surface.
  // AN ADDRESS PROOF is mailed to someone with no account, at an ANONYMOUS
  // caller's request, so its record names the address's domain and a
  // fingerprint (the `ep_` one the proof's own audit events use), never the
  // address, and never SMTP text (which can quote it): otherwise anyone could
  // write strangers' addresses into the 730-day audit store at will.
  // An EVENT TEAM REPORT goes to a team member, a recipient with no account
  // whose address is never written to an audit row (routes/event-team.js): the
  // same domain and fingerprint (`tm_`, lib/team-recipient.js `teamMemberFingerprint`,
  // the form the ledger keeps once the member is removed), and the ledger
  // (`team_report_sends`) says who received what.
  const _anonProof = reason === "email_proof" && !userId;
  const _teamReport = reason === "event_team_report" && !userId;
  const _addr = typeof mailOpts.to === "string" ? mailOpts.to : "";
  const details = (_anonProof || _teamReport)
    ? { to_domain: _addr.split("@")[1] || null, to_fp: _teamReport ? teamMemberFingerprint(_addr) : capabilityFingerprint(_addr.toLowerCase(), "ep_"), subject: mailOpts.subject, reason, success,
        ...(errMsg ? { error: "send_failed" } : {}) }
    : { to: mailOpts.to, subject: mailOpts.subject, reason, success, ..._aboutKeys(about),
        ...(errMsg ? { error: errMsg } : {}) };
  // v8.12.6 (sweep) — AND RE-ASKED AFTER THE SEND, which is an await. The account
  // can be deleted DURING the SMTP round trip, and `user_events` carries no
  // foreign key, so the row written here would re-insert an `email_sent` — naming
  // the erased address — into the history the deletion had just emptied, where it
  // outlives the account for the full retention window. A mail already on the wire
  // cannot be recalled, so the delivery is still RECORDED, as the orphaned event
  // the null-recipient branch already uses: the app log is where a thing that
  // happened with no entity to attach it to goes, and "we mailed this address
  // after its account was deleted" is exactly the fact an operator must be able
  // to find.
  const _gone = _recipientErased(userId);
  try {
    if (userId && !_gone) recordUserEvent(userId, "email_sent", "system", details);
    else recordOrphanedAuditEvent("email", reason, "email_sent", "system",
      _gone ? { ...details, user_id: userId, recipient_deleted: true } : details);
  } catch (e) { /* never let event logging break the app */ swallowed("email:sent-emit", e); }
  return success;
}
function sendEmailBackground(userId, mailOpts, reason, about) {
  // v6.8.5: previously `.catch(()=>{})` silently dropped any residual
  // rejection after sendEmailLogged's internal try/catch. Now we log the
  // stack so a background-email bug can be diagnosed from the process log
  // instead of appearing as a silent "email never arrived" complaint.
  // ext-audit v7.20.9 (F8) — tracked, so graceful shutdown waits for it. This
  // is the ordinary fire-and-forget sender (verification, lockout, unlock,
  // group add/remove, reconciliation); until now only the BULK fan-out was
  // counted, so a rolling deployment closed the database under these sends and
  // lost them silently. The `.catch` stays INSIDE the wrapper so the tracked
  // promise can never reject.
  trackDetachedSend(sendEmailLogged(userId, mailOpts, reason, about).catch(err => {
    console.error(`sendEmailBackground(${reason}) rejected:`, err && err.stack ? err.stack : err);
  }));
}

// ── Composed senders over the primitives above ───────────────────────────────
// (verification / lockout / unlock). sendUnlockEmail is cross-entity
// (auth + admin participants) and also fired by the lockout-expiry poller, so
// the three live together here rather than in routes/auth.

async function sendLockoutEmail(user, lockedUntil, req) {
  const platformName = getPlatformName();
  const baseUrl = BASE_URL;
  const expiryStr = formatEmailDate(new Date(lockedUntil), user.timezone);
  // No reset link. The lock is an ALARM, not a bar (lib/lockout.js): it stops no
  // guess (each sign-in door's rate limits bound guessing), and the correct
  // password, or a correct code from a fresh email, still signs the holder in and
  // clears it, so the advice is to sign in, not to wait. This mail never says the
  // lock keeps guesses out.
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Someone entered several wrong sign-in codes or passwords for your account, so it has been marked as locked until <strong>${escapeHtml(expiryStr)}</strong>, and we are letting you know.</p>
      <p>You can still sign in: type your address on the sign-in screen and press <strong>Continue</strong>. Your correct password (if you sign in with one), or a code from your inbox (choose <strong>Email me a code instead</strong> if the password box appears), signs you in and lifts the lock.</p>
      <p>If you did not try to sign in, nothing else is needed: a guess without your password or your inbox gets nowhere. If you sign in with a password and think someone knows it, change it under Profile, How you sign in.</p>`,
    linkUrl: baseUrl, linkText: "Sign In",
    fallbackNote: "If this keeps happening, contact an administrator.",
  });
  sendEmailBackground(user.id, { to: getUserEmails(user), subject: `${platformName} — Account Temporarily Locked`, html, text }, "lockout", { competitionId: null });
}

async function sendUnlockEmail(user, req) {
  const platformName = getPlatformName();
  const baseUrl = BASE_URL;
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Your account has been unlocked. You can now log in to ${escapeHtml(platformName)}.</p>`,
    linkUrl: baseUrl, linkText: "Log In",
    fallbackNote: "If you did not request this action, please contact an administrator.",
  });
  // Returns the boolean so admin-triggered callers can tell the operator
  // whether SMTP actually accepted the message. The lockout-expiry poller
  // and other system callers can keep ignoring the result.
  return !!(await sendEmailLogged(user.id, { to: getUserEmails(user), subject: `${platformName} — Account Unlocked`, html, text }, "unlock", { competitionId: null }));
}

/**
 * The emailed sign-in code (v7.29.0), hoisted here in v8.3.6.
 *
 * It was composed INLINE in `POST /api/auth/code/request` — the only mail on the
 * platform not owned by this module — and it now has a SECOND sender: a Booth
 * Event walk-up who registers without a password is emailed a code instead of a
 * verification link. Two hand-written copies of a credential email would be one
 * wording change away from telling two people different things about the same
 * code, and the expiry sentence is the half that matters (see below).
 *
 * **`expiresInMinutes` COMES FROM THE MINT, never from the TTL constant.**
 * `login_code_at` anchors to the FIRST mint of the window and a re-issue
 * deliberately does not move it, so a second or third code dies when the ORIGINAL
 * window ends. A flat "expires in 10 minutes" is wrong on every send after the
 * first, and wrong in the direction that leaves someone typing a code that died
 * two minutes ago.
 *
 * **IT RETURNS THE `sendEmailLogged` PROMISE — the delivery boolean — and lets the
 * CALLER decide whether to await it.** The two senders need opposite things and
 * the difference is not stylistic:
 *
 *   * `POST /api/auth/code/request` must NOT await. Its answer is an unconditional
 *     `{ok:true}` for every outcome, so waiting for SMTP would make response time
 *     the existence oracle that design exists to prevent (v7.15.14). It wraps the
 *     promise in `trackDetachedSend` so a rolling deploy still drains it.
 *   * The admin's Email sign-in code (`POST /api/admin/participants/:id/login-code/email`)
 *     MUST await, under `EMAIL_FANOUT_DEADLINE_MS`. It tells the admin whether the
 *     code went (`sent`, `send_failed`, `deferred`) and lifts the re-send
 *     suppression when the send fails. There is no oracle to protect: the admin
 *     already sees the account.
 *
 * Returning `sendEmailBackground(...)` instead would hand back `undefined` (that
 * helper tracks and swallows internally), so the admin route would answer `send_failed` for a
 * message that was delivered perfectly — which is exactly what the first draft
 * did, and what the disposition spec caught.
 *
 * `login_code` is NOT in `_BULK_EMAIL_REASONS`, so it is never suppressed for an
 * opted-out recipient — correct, and required: it is a credential the account
 * asked for, not a broadcast. Unsubscribing must not remove somebody's only door.
 */
// `opts.to` — the address the code goes to. The request door passes the TYPED
// address, which is always the account's PRIMARY (a secondary never signs in):
// requesting proves nothing, so only that inbox receives it. Omitted, it goes to the account's
// addresses (getUserEmails). `opts.eventName` — the event the code is bound to
// (lib/login-code `login_code_comp_id`), passed only when redeeming it would
// enrol the account (lib/self-enroll.js `codeBoundJoinWillEnrol`); the mail
// names it, so whoever redeems it knows that signing in also joins that event,
// in the browser that asked for it: anyone holding the join link can ask for a
// code for any address, so elsewhere the code only signs in (routes/auth.js
// `_sessionNamedEvent`, sweep #198). And only while the event's join link stays
// open: switching it off or replacing it unties the code (sweep #391), which the
// line says.
// `opts.eventId` is the event the mail concerns either way (its `email_sent`).
function sendLoginCodeEmail(user, issued, opts) {
  const platformName = getPlatformName();
  const mins = issued.expiresInMinutes;
  const to = (opts && opts.to) || getUserEmails(user);
  const eventLine = opts && opts.eventName
    ? `<p>Signing in with it in the browser where you asked for it also joins you to <strong>${escapeHtml(opts.eventName)}</strong>, as long as its join link is still open.</p>`
    : "";
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: `<p>Your sign-in code is:</p>
      <p style="font-size:28px;letter-spacing:3px;font-weight:700;margin:16px 0">${formatCode(issued.code)}</p>
      ${eventLine}
      <p>It expires in ${mins} minute${mins === 1 ? "" : "s"} and can be used once. If you didn't ask for it, you can ignore this email — nothing has changed on your account.</p>`,
    fallbackNote: "Never share this code. Nobody from this platform will ask you for it.",
  });
  return sendEmailLogged(user.id, { to, subject: `${platformName} — Your sign-in code`, html, text }, "login_code", { competitionId: (opts && opts.eventId) || null });
}

// "Your password was set" / "changed" — to the PRIMARY address, the one that
// signs in. Transactional (not in _BULK_EMAIL_REASONS): it is a security notice.
// It carries no link to act on: the owner's remedy is an emailed sign-in code,
// which always works, and then a new password in their profile.
function sendPasswordChangedEmail(user, opts) {
  const platformName = getPlatformName();
  const first = !!(opts && opts.first);
  const { html, text } = buildEmail(platformName, {
    greeting: user.first_name || user.nickname,
    body: (first
      ? `<p>A password was just set for your account, and you now sign in with it.</p>`
      : `<p>The password for your account was just changed. Any other browser that was signed in to your account has been signed out.</p>`)
      + `<p>If this wasn't you, sign in with an emailed code straight away: type your address on the sign-in screen and choose <strong>Email me a code instead</strong>. Then set a new password under <strong>Profile → How you sign in</strong>, and tell an administrator.</p>`,
    linkUrl: BASE_URL, linkText: "Sign In",
    fallbackNote: "Nobody from this platform will ever ask you for your password.",
  });
  return sendEmailLogged(user.id, { to: user.email, subject: `${platformName} — Your password was ${first ? "set" : "changed"}`, html, text }, "password_changed_notification", { competitionId: null });
}

// The ADDRESS PROOF (lib/email-proof.js): the code mailed to an address that has
// no account yet. There is no recipient row (userId null), so the attempt is
// recorded as an orphaned email event like an invitation. Transactional — not in
// _BULK_EMAIL_REASONS: it answers the recipient's own request at the sign-in
// screen. The subject is the sign-in code's, so the mail never reads as
// "you have no account" to someone glancing at a notification.
function sendEmailProofEmail(to, issued, opts) {
  const platformName = getPlatformName();
  const mins = issued.expiresInMinutes;
  const eventLine = opts && opts.eventName
    ? `<p>If you create your account in the browser where you asked for this code, it will join <strong>${escapeHtml(opts.eventName)}</strong>, as long as its join link is still open.</p>`
    : "";
  const { html, text } = buildEmail(platformName, {
    greeting: null,
    body: `<p>Your sign-in code is:</p>
      <p style="font-size:28px;letter-spacing:3px;font-weight:700;margin:16px 0">${formatCode(issued.code)}</p>
      <p>This address has no account yet. Entering the code confirms the address, and you will then be asked a few details to create your account.</p>
      ${eventLine}
      <p>It expires in ${mins} minute${mins === 1 ? "" : "s"} and can be used once. If you didn't ask for it, you can ignore this email — no account is created unless the code is used.</p>`,
    fallbackNote: "Never share this code. Nobody from this platform will ask you for it.",
  });
  return sendEmailLogged(null, { to, subject: `${platformName} — Your sign-in code`, html, text }, "email_proof");
}

async function sendVerificationEmail(to, code, baseUrl, name, userId) {
  const platformName = getPlatformName();
  const link = `${baseUrl}/verify?code=${encodeURIComponent(code)}`;
  const { html, text } = buildEmail(platformName, {
    greeting: name || null,
    body: `<p>To confirm your email address, please open the link below. This link will expire in 48 hours. (Signing in with an emailed code confirms it too.)</p>`,
    linkUrl: link, linkText: "Confirm Your Account",
    fallbackNote: `If you did not register for ${platformName}, you can safely ignore this message.`,
  });
  return await sendEmailLogged(userId || null, { to, subject: `${platformName} — Complete Your Registration`, html, text }, "verification", { competitionId: null });
}

module.exports = {
  transporter, smtpHealthy, smtpLastCheck, smtpSendsPending, withSmtpSlot, closeTransport, SMTP_POOL_MAX_CONNECTIONS, SMTP_POOL_MAX_MESSAGES,
  // Settings → Email (SMTP): which relay is in force, the live swap, the test
  // of unsaved values, and whether the environment allows a plain-text relay.
  effectiveSmtpConfig, reloadSmtpTransport, sendSmtpTest, smtpPlaintextAllowed: () => _SMTP_ALLOW_PLAINTEXT,
  // v8.3.7 — exported so a caller can tell a SUPPRESSION from an SMTP FAILURE.
  // `sendEmailLogged` returns `false` for both, deliberately (one shape for every
  // non-delivery), which is right for the send path and wrong for the one caller
  // that reports non-delivery to a human: telling an admin to hand-deliver a link
  // to someone who opted out is asking them to override the opt-out.
  isUnsubscribedAddress: (addr) => _isUnsubscribed(addr),
  sendLoginCodeEmail, sendEmailProofEmail, sendPasswordChangedEmail,
  resolveSender,
  // The sender address in force (it follows a relay saved in the app).
  get SENDER_ADDRESS() { return _senderAddress; },
  getUserEmails, buildEmail,
  verifyUnsubscribeToken, generateUnsubscribeToken,
  sendEmailLogged, sendEmailBackground,
  sendLockoutEmail, sendUnlockEmail, sendVerificationEmail,
};
