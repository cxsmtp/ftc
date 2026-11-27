// @ts-check
// v8.13.1 — WHAT THE DEPENDENCY BUMP DELIVERS, HELD BY BEHAVIOUR RATHER THAN BY A
// VERSION NUMBER.
//
// Three of the four security fixes this bump brings in are invisible to
// `npm audit`: nodemailer's GHSA-4ffr-jq9g-5ffx and sanitize-html's
// GHSA-x3q4-9hxx-gx8m were published by the maintainers but had not reached npm's
// advisory database (`npm audit --omit=dev` was clean on BOTH sides of the bump),
// and the bare-CR normalisation ships in a nodemailer bug-fix line with no advisory
// at all. That is the third release in a row where a clean audit said nothing
// (compression v8.11.13, multer v8.12.7). So each fix is pinned here by what it
// DOES to an input this platform really feeds it — a lockfile that drifts back
// below the fixed versions turns the matching arm red, where a version-string
// assertion would only restate package.json.
//
// Every arm was seen RED against the pre-bump packages (nodemailer 10.0.10,
// sanitize-html 2.17.7, proxy-addr 2.0.7) and carries a control, because "the
// slow parser was not slow" is equally satisfied by a parser that stopped reading
// the reply, and "the address was not believed" by a build that believes nobody.
//
// Nothing here requires lib/email (it opens a second database at require time —
// v7.21.14) or lib/sanitise (it opens the DB through ../db): the transport arms use
// nodemailer with the options lib/email.js builds, the sanitiser arm goes through
// the real API, and the proxy arm evaluates server.js's own configureTrustProxy.
const { test, expect } = require("./isolated-test");
const { apiLogin } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");

// The transport options lib/email.js builds for SMTP_ALLOW_PLAINTEXT=1 — the one
// branch a test can drive without TLS. The production branch (587 + requireTLS)
// reaches the same `_actionEHLO` on the EHLO that follows STARTTLS, i.e. from the
// TLS peer that answers for SMTP_HOST (measured in the v8.13.1 audit with a
// self-signed relay: 11.2 s stall on 10.0.10, 8 ms on 10.0.15); the cleartext
// pre-STARTTLS EHLO returns into the STARTTLS branch before the regexes run.
function transportFor(nodemailer, port, extra) {
  return nodemailer.createTransport({
    host: "127.0.0.1", port, secure: false, requireTLS: false,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    ...(extra || {}),
  });
}

test.describe("v8.13.1 — nodemailer: a hostile EHLO reply cannot stall the event loop (GHSA-4ffr-jq9g-5ffx)", () => {
  // A scripted SMTP peer that answers EHLO with whatever `ehlo` returns and
  // records every command it is sent, so the test can prove the reply was PARSED
  // (the client acted on its AUTH line) rather than merely received.
  async function scriptedPeer(ehlo) {
    const commands = [];
    const server = net.createServer(sock => {
      sock.on("error", () => {});
      sock.write("220 scripted ESMTP\r\n");
      let buf = "";
      sock.on("data", chunk => {
        buf += chunk.toString("latin1");
        let nl;
        while ((nl = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          commands.push(line);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO") sock.write(ehlo());
          else if (verb === "AUTH") sock.write(/^AUTH LOGIN$/i.test(line) ? "334 VXNlcm5hbWU6\r\n" : "235 2.7.0 Accepted\r\n");
          else if (verb === "QUIT") { sock.write("221 2.0.0 Bye\r\n"); sock.end(); }
          else if (/^[A-Za-z0-9+/=]+$/.test(line)) sock.write(commands.filter(c => /^[A-Za-z0-9+/=]+$/.test(c)).length === 1 ? "334 UGFzc3dvcmQ6\r\n" : "235 2.7.0 Accepted\r\n");
          else sock.write("250 2.0.0 Ok\r\n");
        }
      });
    });
    server.on("error", () => {});
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    return { port: server.address().port, commands, close: () => new Promise(r => server.close(() => r())) };
  }

  // The longest gap between 5 ms ticks while `fn` runs is the event-loop stall:
  // the advisory's harm is not a slow send but a process that serves nobody
  // (single-process server — timers, polls and every other request wait).
  async function longestStall(fn) {
    let last = Date.now(), gap = 0;
    const iv = setInterval(() => { const n = Date.now(); gap = Math.max(gap, n - last); last = n; }, 5);
    try { await fn(); } finally { gap = Math.max(gap, Date.now() - last); clearInterval(iv); }
    return gap;
  }

  // lib/email.js passes SMTP credentials, so the client authenticates after EHLO;
  // which AUTH command it sends is the observable that it read the AUTH line.
  const AUTH = { auth: { type: "LOGIN", user: "relay-user", pass: "relay-pass" } };

  test("a 250-AUTH line padded with 2000 spaces is parsed without stalling the loop", async () => {
    // 10.0.10's four `/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)MECH/i` patterns backtrack
    // quadratically over this line: measured 11.1 s with the loop blocked
    // throughout; 10.0.15 tokenises the line instead (4 ms).
    const peer = await scriptedPeer(() => "250-scripted\r\n250-AUTH" + " ".repeat(2000) + "NOMATCH\r\n250 OK\r\n");
    try {
      const nodemailer = require("nodemailer");
      const stall = await longestStall(() => transportFor(nodemailer, peer.port, AUTH).verify());
      // ANTI-VACUITY: the client authenticated, so it read the reply's AUTH line —
      // `allowsAuth` comes from the same response the regexes run over. A build
      // that never parsed the reply would send no AUTH at all.
      expect(peer.commands.some(c => /^AUTH /i.test(c)),
        `the client must have acted on the AUTH line (commands: ${JSON.stringify(peer.commands.map(c => c.slice(0, 20)))})`).toBe(true);
      expect(stall, `event loop blocked ${stall} ms while parsing a hostile EHLO reply — the GHSA-4ffr-jq9g-5ffx regexes are back`).toBeLessThan(1500);
    } finally { await peer.close(); }
  });

  test("CONTROL: a well-formed AUTH line is still read — the mechanism it names is the one used", async () => {
    // Without this, "the hostile line parsed quickly" is equally satisfied by a
    // parser that ignores AUTH lines altogether. A relay advertising only LOGIN
    // must get AUTH LOGIN; a client that detected nothing falls back to PLAIN.
    const peer = await scriptedPeer(() => "250-scripted\r\n250-AUTH LOGIN\r\n250 OK\r\n");
    try {
      await transportFor(require("nodemailer"), peer.port, AUTH).verify();
      const auth = peer.commands.find(c => /^AUTH /i.test(c));
      expect(auth, `AUTH command sent (commands: ${JSON.stringify(peer.commands)})`).toBeTruthy();
      expect(auth).toMatch(/^AUTH LOGIN$/i);
    } finally { await peer.close(); }
  });
});

test.describe("v8.13.1 — nodemailer: a bare CR in participant text never reaches the SMTP stream raw", () => {
  // buildEmail (lib/email.js) writes `Hi ${greeting},` into the text and HTML
  // bodies, and the greeting is the participant's own first name — trimmed at the
  // ends and otherwise unrestricted, so an interior CR survives registration and
  // `PUT /api/me`. Quoted-printable leaves a CR alone, and 10.0.10's data stream
  // only repaired a bare LF, so `Eve\r.\r\n…` reached the relay as a raw
  // <CR>.<CR><LF> — the SMTP-smuggling end-of-data shape a relay that honours a
  // bare CR would act on, letting a participant append a second message to the
  // platform's own authenticated session. 10.0.12 turns every bare CR into CRLF
  // and dot-stuffs the line it opens. Whether a given relay is vulnerable is the
  // relay's business; what this platform puts on the wire is ours.
  test("a first name carrying <CR>.<CR><LF> is normalised to CRLF and dot-stuffed", async () => {
    const sink = await startSmtpCapture();
    try {
      const greeting = "Eve\r.\r\nMAIL FROM:<ceo@victim.test>";
      const subject = `smuggle probe ${Date.now()}`;
      await transportFor(require("nodemailer"), sink.port).sendMail({
        from: { name: "Checkmarx Enablement Platform", address: "no-reply@acme.test" },
        to: "eve@acme.test", subject,
        text: `Hi ${greeting},\n\nYour sign-in code is below.`,
        html: `<p>Hi ${greeting},</p><p>Your sign-in code is below.</p>`,
      });
      const msg = await sink.waitFor(m => m.header("subject") === subject);
      // CONTROL: the name really reached the wire — the assertions below are about
      // its line endings, not about a body that lost the text. It is also the arm
      // that fires when the CR is repaired WITHOUT stuffing the dot: the line then
      // becomes a genuine <CR><LF>.<CR><LF>, the relay ends DATA there and reads
      // the rest of the name as SMTP commands (measured by mutating 10.0.15's data
      // stream: the captured message stops at "Hi Eve").
      expect(msg.raw, "the greeting's second line is missing — the body lost it, or an injected " +
        "<CR><LF>.<CR><LF> ended DATA early and the relay read the rest as commands").toContain("MAIL FROM:<ceo@victim.test>");
      const bareCr = (msg.raw.match(/\r(?!\n)/g) || []).length;
      expect(bareCr, "a bare CR from participant text reached the SMTP DATA stream").toBe(0);
      expect(msg.raw.includes("\r.\r\n"), "<CR>.<CR><LF> (SMTP smuggling end-of-data) is on the wire").toBe(false);
      // The line the CR opened starts with a dot, so it must arrive stuffed.
      expect(msg.raw).toContain("\r\n..\r\nMAIL FROM:<ceo@victim.test>");
    } finally { await sink.close(); }
  });
});

test.describe("v8.13.1 — sanitize-html: an implied close does not end the <noscript> discard early (GHSA-x3q4-9hxx-gx8m)", () => {
  // `noscript` is in _RICH_TEXT_OPTS.nonTextTags, so its content is discarded —
  // but 2.17.7 ended the discard at htmlparser2's IMPLIED close (an ancestor's end
  // tag), and emitted what follows as ordinary markup, while a browser with
  // scripting reads the whole region as raw text. The output is still allowlist-
  // only, and challenge rich text is written by admins and event admins who could
  // type the same anchor directly — so this is not an escalation here. It is
  // pinned because it is the one sanitiser output 2.18.0 changes for this
  // platform's options (measured over the shapes we accept: tables, code, spans,
  // anchors, images, iframes, script/style/textarea, meta, svg, srcset — only this
  // differs).
  async function storedDescription(api, csrf, description) {
    const r = await api.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { title: `DepNoscript ${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`,
        description, correct_answer: "a", answer_type: "text", difficulty: "easy" },
    });
    expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;
    const list = await (await api.get("/api/admin/tasks")).json();
    const row = (list.tasks || list).find(t => t.id === id);
    expect(row, "the created challenge must come back from the admin list").toBeTruthy();
    return row.description;
  }

  test("content after an ancestor's end tag inside <noscript> stays discarded", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stored = await storedDescription(api, csrf,
        '<div><noscript></div><a href="https://evil.test/reset">Reset your password</a></noscript></div><p>after the noscript</p>');
      expect(stored, "the region a browser reads as raw <noscript> text must not come back as a link").not.toContain("evil.test");
      expect(stored).not.toContain("Reset your password");
      // CONTROL (same request shape): the text after the browser's </noscript> is
      // kept, so the discard is the noscript region and not the whole description.
      expect(stored).toContain("after the noscript");
    } finally { await api.dispose(); }
  });

  test("CONTROL: the same anchor outside a <noscript> survives the sanitiser", async () => {
    // Without this, the arm above is satisfied by a sanitiser that drops every
    // https anchor — the absence would then say nothing about <noscript>.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const stored = await storedDescription(api, csrf,
        '<div></div><a href="https://evil.test/reset">Reset your password</a><p>after</p>');
      expect(stored).toContain('href="https://evil.test/reset"');
      expect(stored).toContain("Reset your password");
    } finally { await api.dispose(); }
  });
});

test.describe("v8.13.1 — proxy-addr: a short IPv4-mapped TRUST_PROXY subnet no longer trusts every client (GHSA-jqcg-44mw-7w3h)", () => {
  // server.js hands any TRUST_PROXY value that is not a boolean or a hop count to
  // Express VERBATIM (README documents a comma-separated IP/CIDR list), and the
  // app listens on 0.0.0.0, so every peer is IPv4. Under proxy-addr 2.0.7 a subnet
  // spelled `::ffff:10.0.0.0/8` (meant: 10/8; correct: `::ffff:10.0.0.0/104`) or
  // `::/1` compiled with all-zero leading bits and matched EVERY IPv4 peer, so any
  // direct client set its own req.ip through X-Forwarded-For — and with it the
  // per-IP rate limits, the scanner block, a competition's Trusted network IPs
  // bypass and every audit IP. 2.0.8 matches IPv4 only against a genuinely mapped
  // subnet whose prefix covers ::ffff:.
  //
  // The function is evaluated from server.js's SOURCE (server.js boots the whole
  // app at require time, which a spec may not do — v7.20.2): it is pure config
  // plumbing over `app` and `process.env`, so this drives the real parsing, not a
  // copy of it.
  const SERVER_SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const IIFE = (() => {
    const m = SERVER_SRC.match(/\(function configureTrustProxy\(\) \{[\s\S]*?\n\}\)\(\);/);
    if (!m) throw new Error("configureTrustProxy not found in server.js — this arm reads it from source");
    return m[0];
  })();

  /** req.ip for a request from 127.0.0.1 claiming X-Forwarded-For: 198.51.100.1. */
  async function resolvedIp(trustProxy) {
    const express = require("express");
    const app = express();
    // The IIFE calls lib/util.js parseTrustProxy, the one reader of TRUST_PROXY,
    // so the real parser is handed in by the name the source uses.
    const { parseTrustProxy } = require("../lib/util");
    // eslint-disable-next-line no-new-func
    new Function("app", "process", "parseTrustProxy", IIFE)(app, { env: { TRUST_PROXY: trustProxy } }, parseTrustProxy);
    app.get("/ip", (req, res) => res.json({ ip: req.ip }));
    const server = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      return await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.address().port, path: "/ip",
          headers: { "x-forwarded-for": "198.51.100.1" } }, res => {
          let b = ""; res.on("data", c => { b += c; }); res.on("end", () => { try { resolve(JSON.parse(b).ip); } catch (e) { reject(e); } });
        }).on("error", reject);
      });
    } finally { await new Promise(r => server.close(() => r())); }
  }

  test("::ffff:10.0.0.0/8 and ::/1 do not make a direct client's X-Forwarded-For believable", async () => {
    for (const spelling of ["::ffff:10.0.0.0/8", "::/1"]) {
      expect(await resolvedIp(spelling), `TRUST_PROXY=${spelling}: a direct client from 127.0.0.1 chose its own req.ip`).toBe("127.0.0.1");
    }
  });

  test("CONTROLS: a trusted hop is still believed, and the correctly spelled mapped subnet still trusts", async () => {
    // Without these, the arm above is satisfied by a harness that cannot observe
    // trust at all (req.ip always the socket) — or by a proxy-addr that stopped
    // honouring IPv6 notation entirely, which would break a correct deployment.
    expect(await resolvedIp("loopback"), "the harness must see X-Forwarded-For believed from a trusted hop").toBe("198.51.100.1");
    expect(await resolvedIp("::ffff:127.0.0.0/104"), "a mapped subnet whose prefix covers ::ffff: still trusts its block").toBe("198.51.100.1");
    expect(await resolvedIp("10.0.0.0/8"), "a plain IPv4 subnet that does not contain the peer trusts nothing").toBe("127.0.0.1");
  });
});
