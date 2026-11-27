"use strict";

// v7.26.0 — an in-process SMTP server that CAPTURES what it is sent.
//
// It exists because the From header is the one thing about an outbound email
// that cannot be asserted from inside this process. `sendEmailLogged` records a
// `email_sent` user_event carrying `to` / `subject` / `reason` / `success` — and
// deliberately not `from` — so every other observation point in the suite can
// only assert what we COMPOSED, never what nodemailer EMITTED. That distinction
// is the entire subject of the sender fix: the old code composed a perfectly
// reasonable-looking string which nodemailer then re-parsed into a different
// sender. A lock that reads our own variable back would have passed throughout.
//
// WHY NOT `perf/tools/smtp-sink.js`: that one deliberately DISCARDS the DATA
// body (it slices past the terminating dot without parsing) because its job is
// to swallow mail cheaply during a load test. Retaining and indexing every
// message is the opposite requirement, and `tests/` taking a dependency on perf
// tooling would couple two things with different lifecycles. The SMTP dialogue
// below is modelled on it on purpose, so the two stay recognisably the same
// protocol; if that dialogue ever needs fixing, fix both.
//
// Deliberately PLAINTEXT (no STARTTLS advertised), so a server talking to it
// must run with SMTP_ALLOW_PLAINTEXT=1 — the documented development opt-out
// (v7.15.12). That is the same shape four existing specs already use when they
// point a spawned server at a dead port.

const net = require("net");

/**
 * Start a capturing SMTP server on an ephemeral port.
 *
 * @param {{auth?: boolean}} [opts] `auth: true` advertises AUTH LOGIN and
 *   records each sign-in's username and password in `logins` (a relay saved
 *   with a password, tests/smtp-settings.spec.js). Off by default: the EHLO
 *   answer every other spec sees is unchanged.
 * @returns {Promise<{port:number, messages:Array, logins:Array, waitFor:Function, clear:Function, close:Function}>}
 *   `messages` accumulates `{ envelopeFrom, rcptTo, raw, headers, header(name) }`.
 */
async function startSmtpCapture(opts = {}) {
  const advertiseAuth = !!opts.auth;
  const logins = [];
  const messages = [];
  const sockets = new Set();
  // v8.12.6 (sweep) — HOLD: while armed, a message that has fully arrived is
  // CAPTURED (it is in `messages`) but its "250 queued" is withheld, so the
  // sender's `sendMail` stays awaiting until `release()`. That is the only way to
  // land something — a deletion, say — inside a send on purpose rather than by
  // timing. Off by default; `release()` answers every held message.
  let holding = false;
  const heldAcks = [];
  // REJECT: while set, a RCPT for an address the predicate matches is refused
  // (550), so the sender's `sendMail` fails — a relay refusing one recipient,
  // the way a failed send is driven on purpose. Off by default.
  let rejectRcpt = null;

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let inData = false;
    let buf = "";
    let cur = { envelopeFrom: null, rcptTo: [], raw: "" };
    let authStep = null; // AUTH LOGIN: "user", then "pass"
    let authUser = "";
    sock.setEncoding("utf8");
    sock.write("220 test-smtp-capture ESMTP\r\n");

    sock.on("data", (chunk) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          cur.raw = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push(_finalise(cur));
          cur = { envelopeFrom: null, rcptTo: [], raw: "" };
          if (holding) heldAcks.push(sock);
          else sock.write("250 2.0.0 Ok: queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (authStep) {
          const v = Buffer.from(line.trim(), "base64").toString("utf8");
          if (authStep === "user") { authUser = v; authStep = "pass"; sock.write("334 UGFzc3dvcmQ6\r\n"); }
          else { logins.push({ user: authUser, pass: v }); authStep = null; sock.write("235 2.7.0 Accepted\r\n"); }
          continue;
        }
        if (verb === "EHLO") {
          sock.write("250-test-smtp-capture\r\n250-8BITMIME\r\n" + (advertiseAuth ? "250-AUTH LOGIN\r\n" : "") + "250 SIZE 52428800\r\n");
        } else if (verb === "HELO") {
          sock.write("250 test-smtp-capture\r\n");
        } else if (verb === "MAIL") {
          // MAIL FROM:<addr> — the SMTP ENVELOPE sender, which is what SPF is
          // evaluated against and where bounces go. Distinct from the From
          // header, and the pair only diverges when something has gone wrong.
          const m = line.match(/<([^>]*)>/);
          cur.envelopeFrom = m ? m[1] : "";
          sock.write("250 2.0.0 Ok\r\n");
        } else if (verb === "RCPT") {
          const m = line.match(/<([^>]*)>/);
          if (m && rejectRcpt && rejectRcpt(m[1])) { sock.write("550 5.1.1 Recipient rejected\r\n"); continue; }
          if (m) cur.rcptTo.push(m[1]);
          sock.write("250 2.0.0 Ok\r\n");
        } else if (verb === "RSET" || verb === "NOOP") {
          sock.write("250 2.0.0 Ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          sock.write("221 2.0.0 Bye\r\n");
          sock.end();
          return;
        } else if (verb === "AUTH" && advertiseAuth && /^AUTH LOGIN\s*$/i.test(line)) {
          authStep = "user";
          sock.write("334 VXNlcm5hbWU6\r\n");
        } else if (verb === "AUTH") {
          sock.write("235 2.7.0 Accepted\r\n");
        } else {
          sock.write("250 2.0.0 Ok\r\n");
        }
      }
    });
    // A client hanging up mid-send is normal here; without this the 'error'
    // event is unhandled and takes the worker down (the v7.15.x in-spec-listener
    // lesson).
    sock.on("error", () => {});
  });

  server.on("error", () => {});

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    messages,
    logins,
    /** Poll until `pred` matches a captured message, or throw after `timeout`. */
    async waitFor(pred, timeout = 15000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `smtp-capture: no message matched within ${timeout}ms. Captured ${messages.length}: ` +
            JSON.stringify(messages.map(m => ({ from: m.header("from"), subject: m.header("subject"), to: m.rcptTo })), null, 1)
          );
        }
        await new Promise(r => setTimeout(r, 100));
      }
    },
    clear() { messages.length = 0; },
    /** Withhold the "queued" reply to every message that arrives from now on. */
    hold() { holding = true; },
    /** Refuse every RCPT whose address `pred(address)` matches; `null` accepts all again. */
    rejectRecipients(pred) { rejectRcpt = typeof pred === "function" ? pred : null; },
    /** How many arrived messages are waiting on their reply. */
    heldCount() { return heldAcks.length; },
    /** Stop holding and answer every held message. */
    release() {
      holding = false;
      for (const sock of heldAcks.splice(0)) {
        try { if (!sock.destroyed) sock.write("250 2.0.0 Ok: queued\r\n"); } catch (_) {}
      }
    },
    async close() {
      // Destroy live sockets BEFORE close(), or close() waits on them forever.
      for (const s of sockets) { try { s.destroy(); } catch (_) {} }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Parse the captured DATA blob into unfolded headers.
 *
 * Unfolding matters: a long or non-ASCII From is legitimately split across
 * continuation lines (RFC 5322 §2.2.3), so a test reading raw lines would see a
 * truncated value and could not tell that from a genuinely truncated header.
 */
function _finalise(cur) {
  const headerBlob = cur.raw.split("\r\n\r\n")[0] || "";
  const unfolded = headerBlob.replace(/\r\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split("\r\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] += ", " + value;
  }
  return {
    envelopeFrom: cur.envelopeFrom,
    rcptTo: cur.rcptTo,
    raw: cur.raw,
    headerLines: headerBlob.split("\r\n"),
    headers,
    header(name) { return headers[String(name).toLowerCase()]; },
  };
}

/**
 * Decode a quoted-printable message to UTF-8 text: soft line breaks (`=` at a
 * line end) and `=XX` escapes. A body is QP-encoded, so a soft break can split
 * any phrase a test matches and `=3D` hides every `=`; decode before matching.
 */
function decodeQuotedPrintable(raw) {
  const s = String(raw || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2;
    } else {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else for (const b of Buffer.from(s[i], "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

module.exports = { startSmtpCapture, decodeQuotedPrintable };
