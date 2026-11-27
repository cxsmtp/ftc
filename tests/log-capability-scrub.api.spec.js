// @ts-check
//
// v8.13.3 — A CAPABILITY THAT ARRIVES IN A REQUEST NEVER REACHES app.jsonl.
//
// `_scrubLogPath` (server.js) redacts every capability a URL can carry, and the
// access logger and the error handler have used it for years. v8.13.3 found four
// sinks BESIDE them that did not, each writing a live bearer value into the app
// log — which every REGULAR admin reads through Logs, and `scripts/backup.sh`
// copies off the box:
//
//   (A) the SPA-shell perf span logged `"GET " + req.path`, so a slow load of
//       /join/<token> wrote the self-enrol token (LCL-1);
//   (B) the CSP report handler logged the browser's `document-uri`,
//       `blocked-uri` and `source-file` raw — and a CSP report carries the page's
//       QUERY STRING, so /reset-password.html?code=<reset code> and
//       /register?invitation=<id> arrive that way (LCL-2);
//   (C) the error handler logged `Request refused: ${err.message}`, and Express
//       5's router rewrites a bad percent-escape in a route parameter to
//       `Failed to decode param '<the raw value>'` — on /badge/:token,
//       /api/invitations/:id and /api/admin/credential/:code that raw value IS
//       the capability, written right beside a `path` field the scrubber had
//       correctly redacted;
//   (D) the same line for a malformed JSON body: V8's JSON.parse message quotes a
//       slice of the body, so an unquoted password in a hand-built login request
//       went into the log.
//
// Every arm drives the real request through the worker's own server and then
// reads EVERY log file for the sentinel, because a scrub on one field proves
// nothing about a sibling field or a second line. Each arm first PROVES the line
// it is about was written (by req_id or a unique marker) — "the sentinel is
// absent" is equally true of a build that stopped logging the event at all.
//
// The source half — every sink, every request path, one level of alias — is the
// scanner in request-log-context.spec.js (arm e).
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DATA_DIR, findLogLine } = require("./helpers");
const { serverEnv } = require("./server-env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOGS = path.join(TEST_DATA_DIR, "logs");
const { hostname: HOST, port: PORT } = new URL(BASE);
// A capability-shaped sentinel: base64url, long enough that it cannot occur in a
// log by accident, and unique per call so two arms cannot satisfy each other.
const sentinel = (tag) => `${tag}${crypto.randomBytes(18).toString("base64url")}`;

// Every app- and access- log file, concatenated. The scrub must hold across all
// of them, not only on the one line an arm happens to look up.
function allLogText() {
  let out = "";
  for (const f of fs.readdirSync(LOGS)) {
    if (f.endsWith(".jsonl")) out += fs.readFileSync(path.join(LOGS, f), "utf8");
  }
  return out;
}

// A GET whose body the global JSON parser waits for. Express runs that parser for
// a GET carrying a JSON body, so holding the body open for `holdMs` puts the
// whole wait into the SPA shell's `prelude_ms` and fires its perf span — the only
// way to reach that sink on purpose without slowing the server itself.
//
// The hold starts once the connection is up and the headers are on the wire,
// never at the call: the server's clock (`_perfT0`) starts when it reads the
// headers, so a slow connect (the `localhost` lookup, a busy runner) came out of
// the hold, and a loaded CI runner measured 390 ms of a 450 ms one.
function slowGet(pathname, holdMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, method: "GET", path: pathname,
      headers: { "content-type": "application/json", "content-length": "2" },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, id: res.headers["x-request-id"] }));
    });
    req.on("error", reject);
    req.on("socket", (sock) => {
      const hold = () => { req.flushHeaders(); setTimeout(() => req.end("{}"), holdMs); };
      if (sock.connecting) sock.once("connect", hold); else hold();
    });
  });
}

// The span's threshold in the worker's server (tests/server-env.js pins it). A
// prelude over it means the held body alone made the request slow; the hold is
// twice it, so the server may run that long behind the socket before the claim
// fails (its loop can lag the headers on a loaded runner; that lag comes out of
// the measured prelude, not the hold).
const SLOW_MS = Number(serverEnv(0).PERF_SPAN_SLOW_MS);
const HOLD_MS = 2 * SLOW_MS;

// A request with a body we write byte for byte (a deliberately malformed one).
function rawRequest(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, id: res.headers["x-request-id"], body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test.describe("v8.13.3 — capabilities in a request never reach the app log", () => {

  test("(A) a slow /join/<token> load logs its perf span with the token REDACTED", async () => {
    const token = sentinel("joinTok");
    const r = await slowGet(`/join/${token}`, HOLD_MS);
    expect(r.status, "the SPA shell answered the join link").toBe(200);
    expect(r.id, "the response carries X-Request-ID").toBeTruthy();

    // PRECONDITION: the span really fired for THIS request. Without it the
    // absence below is satisfied by a build whose span never fires.
    const span = await findLogLine(LOGS, (j) => j.msg === "[perf-span] slow SPA shell" && j.req_id === r.id,
      { what: "the SPA-shell perf span for the slow /join/ request" });
    expect(SLOW_MS, "PRECONDITION: the span's threshold is pinned").toBeGreaterThan(0);
    expect(Number(span.prelude_ms), "the held body was counted (the span fired for the reason we think)")
      .toBeGreaterThan(SLOW_MS);
    expect(span.endpoint).toBe("GET /join/[REDACTED]");

    // The access line is written by an independent path; wait for it too, so the
    // scan below sees every line this request will ever produce.
    await findLogLine(LOGS, (j) => j.req_id === r.id, { prefix: "access-", what: "the access line for the slow /join/ request" });
    expect(allLogText().includes(token), "the join token appears in NO log file").toBe(false);
  });

  test("(A control) a slow /register load is logged with its real path", async () => {
    // The scrub is a set of rules, not a blanket: a path carrying no capability
    // must come through untouched, or the span stops saying which page was slow.
    const r = await slowGet("/register", HOLD_MS);
    expect(r.status).toBe(200);
    const span = await findLogLine(LOGS, (j) => j.msg === "[perf-span] slow SPA shell" && j.req_id === r.id,
      { what: "the SPA-shell perf span for the slow /register request" });
    expect(span.endpoint).toBe("GET /register");
  });

  test("(B) a CSP report's three browser-reported URLs are scrubbed before they are logged", async () => {
    const inv = sentinel("invId"), code = sentinel("resetCode"), join = sentinel("joinTok");
    const marker = 900000 + crypto.randomInt(99999);
    const report = {
      "csp-report": {
        "document-uri": `${BASE}/register?invitation=${inv}`,
        "blocked-uri": `${BASE}/reset-password.html?code=${code}`,
        "source-file": `${BASE}/join/${join}`,
        "violated-directive": "script-src-elem",
        "line-number": marker,
      },
    };
    const r = await rawRequest("POST", "/api/csp-report",
      { "content-type": "application/csp-report" }, JSON.stringify(report));
    expect(r.status).toBe(204);

    const line = await findLogLine(LOGS, (j) => j.msg === "CSP violation" && j.line_number === marker,
      { what: "the CSP violation line for the capability-bearing report" });
    expect(line.document_uri).toBe(`${BASE}/register?invitation=[REDACTED]`);
    expect(line.blocked_uri).toBe(`${BASE}/reset-password.html?code=[REDACTED]`);
    expect(line.source_file).toBe(`${BASE}/join/[REDACTED]`);
    const text = allLogText();
    for (const [name, v] of [["invitation id", inv], ["reset code", code], ["join token", join]]) {
      expect(text.includes(v), `the ${name} appears in NO log file`).toBe(false);
    }
  });

  test("(B control) a CSP report carrying no capability is logged verbatim", async () => {
    const marker = 900000 + crypto.randomInt(99999);
    const doc = `${BASE}/`, src = `${BASE}/js/core/main.js`;
    const r = await rawRequest("POST", "/api/csp-report", { "content-type": "application/csp-report" },
      JSON.stringify({ "csp-report": { "document-uri": doc, "blocked-uri": "inline", "source-file": src,
        "violated-directive": "style-src-elem", "line-number": marker } }));
    expect(r.status).toBe(204);
    const line = await findLogLine(LOGS, (j) => j.msg === "CSP violation" && j.line_number === marker,
      { what: "the CSP violation line for the benign report" });
    expect(line.document_uri).toBe(doc);
    expect(line.blocked_uri).toBe("inline");
    expect(line.source_file).toBe(src);
  });

  // (C) Three routes whose parameter IS a capability. Decoding precedes every
  // guard, so even the anonymous request to the superadmin-only resolver used to
  // write its code into the log.
  for (const [label, prefix] of [
    ["an invitation id", "/api/invitations/"],
    ["a badge token", "/badge/"],
    ["a credential code (superadmin-only route, anonymous caller)", "/api/admin/credential/"],
  ]) {
    test(`(C) a malformed percent-escape in ${label} is refused without echoing the parameter`, async () => {
      const cap = sentinel("cap");
      const r = await rawRequest("GET", `${prefix}${cap}%ZZ`, {}, undefined);
      expect(r.status, "a malformed escape is the caller's error, not a 500").toBe(400);
      expect(JSON.parse(r.body).error).toBe("The request path contained malformed percent-encoding.");
      expect(r.body.includes(cap), "the response does not echo the parameter").toBe(false);

      // PRECONDITION: the refusal line exists for this request.
      const line = await findLogLine(LOGS, (j) => j.req_id === r.id && /^Request refused/.test(j.msg || ""),
        { what: `the refusal line for the malformed ${label}` });
      expect(line.msg).toBe("Request refused: malformed percent-encoding in a route parameter");
      expect(line.err_type).toBe("path.param.malformed");
      expect(line.path).toBe(`${prefix}[REDACTED]`);
      await findLogLine(LOGS, (j) => j.req_id === r.id, { prefix: "access-", what: "the access line" });
      expect(allLogText().includes(cap), `${label}: the value appears in NO log file`).toBe(false);
    });
  }

  test("(E) the address in DELETE /api/admin/unsubscribed/:email never reaches the access log", async () => {
    // Anonymous on purpose: requireAdmin refuses before any handler, and the
    // access line is still written for the refusal, which is the reachable read.
    const addr = `${sentinel("unsub").toLowerCase()}@example.com`;
    const r = await rawRequest("DELETE", `/api/admin/unsubscribed/${encodeURIComponent(addr)}`, {}, undefined);
    expect(r.status, "an anonymous caller is refused").toBe(401);
    expect(r.id, "the response carries X-Request-ID").toBeTruthy();
    // PRECONDITION: the access line for THIS request exists, with the path scrubbed.
    const line = await findLogLine(LOGS, (j) => j.req_id === r.id, { prefix: "access-", what: "the access line for the unsubscribed DELETE" });
    expect(line.path).toBe("/api/admin/unsubscribed/[REDACTED]");
    expect(allLogText().includes(addr.split("@")[0]), "the address appears in NO log file").toBe(false);
  });

  test("(F) the badge token in a holder's LinkedIn-post read never reaches the access log", async () => {
    // Anonymous on purpose: requireParticipant refuses before the handler, and
    // the access line for the refusal is written all the same.
    const tok = sentinel("badge");
    const r = await rawRequest("GET", `/api/me/certificates/${tok}/linkedin-post`, {}, undefined);
    expect(r.status, "an anonymous caller is refused").toBe(401);
    const line = await findLogLine(LOGS, (j) => j.req_id === r.id, { prefix: "access-", what: "the access line for the LinkedIn-post read" });
    expect(line.path).toBe("/api/me/certificates/[REDACTED]/linkedin-post");
    expect(allLogText().includes(tok), "the token appears in NO log file").toBe(false);
  });

  test("(G) a typed identity in ?actor= or ?search= never reaches the access log; other parameters stay (CONTROL)", async () => {
    const who = `${sentinel("actor").toLowerCase()}@example.com`;
    const typed = sentinel("typed");
    const a = await rawRequest("GET", `/api/admin/audit?actor=${encodeURIComponent(who)}&limit=5`, {}, undefined);
    const s = await rawRequest("GET", `/api/admin/participants/picker?competitionId=c1&search=${encodeURIComponent(typed)}&limit=25`, {}, undefined);
    expect([a.status, s.status], "anonymous callers are refused").toEqual([401, 401]);
    const la = await findLogLine(LOGS, (j) => j.req_id === a.id, { prefix: "access-", what: "the access line for the audit filter" });
    const ls = await findLogLine(LOGS, (j) => j.req_id === s.id, { prefix: "access-", what: "the access line for the picker search" });
    expect(la.path).toBe("/api/admin/audit?actor=[REDACTED]&limit=5");
    expect(ls.path, "the event id and the limit are not identities, so they stay").toBe("/api/admin/participants/picker?competitionId=c1&search=[REDACTED]&limit=25");
    const all = allLogText();
    expect(all.includes(who.split("@")[0]), "the address appears in NO log file").toBe(false);
    expect(all.includes(typed), "the search term appears in NO log file").toBe(false);
  });

  test("(E control) a sibling admin path with no identity is logged verbatim", async () => {
    const r = await rawRequest("GET", "/api/admin/unsubscribed", {}, undefined);
    expect(r.status).toBe(401);
    const line = await findLogLine(LOGS, (j) => j.req_id === r.id, { prefix: "access-", what: "the access line for the unsubscribed list" });
    expect(line.path).toBe("/api/admin/unsubscribed");
  });

  test("(D) a malformed JSON login body is refused without its password reaching the log", async () => {
    // Unquoted on purpose: V8 then quotes a window of the body around the error
    // ('Unexpected token \'Q\', …"password":Qx7…"… is not valid JSON'), which is
    // exactly what used to land in the log. The first 8 characters are inside that
    // window, so they are what the scan looks for.
    const secret = `Q${crypto.randomBytes(12).toString("hex")}`;
    const r = await rawRequest("POST", "/api/login", { "content-type": "application/json" },
      `{"email":"nobody@example.com","password":${secret}}`);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toBe("The request body was not valid JSON.");

    const line = await findLogLine(LOGS, (j) => j.req_id === r.id && /^Request refused/.test(j.msg || ""),
      { what: "the refusal line for the malformed login body" });
    expect(line.msg).toBe("Request refused: the request body was not valid JSON");
    expect(line.err_type).toBe("entity.parse.failed");
    expect(allLogText().includes(secret.slice(0, 8)), "no fragment of the password reaches any log file").toBe(false);
  });

  test("(D control) a refusal whose own message is safe still logs that message", async () => {
    // The log-side override is for the two refusals that quote something; every
    // other one must keep saying what went wrong, or the operator loses the one
    // fact they needed (v7.21.24). An oversized login body is the cheapest.
    const r = await rawRequest("POST", "/api/login", { "content-type": "application/json" },
      JSON.stringify({ email: "nobody@example.com", password: "x".repeat(20 * 1024) }));
    expect(r.status).toBe(413);
    const line = await findLogLine(LOGS, (j) => j.req_id === r.id && /^Request refused/.test(j.msg || ""),
      { what: "the refusal line for the oversized login body" });
    expect(line.msg).toBe("Request refused: request entity too large");
  });
});
