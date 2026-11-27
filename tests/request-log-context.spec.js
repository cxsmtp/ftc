// @ts-check
//
// Request-scoped log context (item #14, following v7.21.24).
//
// v7.21.24 built `_describeRequestError` so an unhandled error carries `req_id`,
// method, scrubbed path, status, ip, user and `err_type` — and `req_id` is the
// whole point of it: it is stamped before the body parsers run and returned as
// `X-Request-ID`, so `app.jsonl`, `access-*.jsonl` and a user's bug report join
// on a KEY instead of on a timestamp. That release then recorded what it had NOT
// done: "43 other request-scoped `console.*` sites still discard context".
//
// A bare `console.error("[attachments] upload failed:", e.message)` bypasses all
// of it. `lib/log.js` overrides `console.*` so the line still reaches app.jsonl,
// but with `{legacy: true}` and NOTHING else: no request, no user, no address.
//
// This spec covers the sweep of that class across routes/ + the two lib/ modules
// that take a request-derived context. It has two arms, and the second is the
// durable half.
//
// ── THE HAZARD THIS EXISTS FOR ───────────────────────────────────────────────
// `log.<level>(context, message)` is CONTEXT FIRST:
//
//     const log = (lvl) => (ctxOrMsg, msg) => {
//       if (typeof ctxOrMsg === "string") _writeLog(stream, lvl, null, ctxOrMsg);
//       else                              _writeLog(stream, lvl, ctxOrMsg, msg);
//     };
//
// Reversing the arguments — `log.error(msg, ctx)` — hits the string branch and
// writes the message with a NULL CONTEXT: every field silently dropped, no error,
// no warning, and a green suite. The old CLAUDE.md's v8.3.13 entry (git show
// e5f01929:CLAUDE.md) records that exact mistake costing a release: two
// diagnostics were written `(message, context)` and the
// only reason it was caught was an assertion on the FIELDS rather than on the
// sentence. Arm (b) is the mechanical guard against it.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DATA_DIR, TEST_DB_PATH, findLogLine } = require("./helpers");
const Database = require("better-sqlite3");
const { v4: uuid } = require("uuid");
const fs = require("fs");
const path = require("path");

const H = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ROOT = path.join(__dirname, "..");

// ── (a) BEHAVIOURAL ─────────────────────────────────────────────────────────
//
// Drive a migrated site for real and read the bytes it wrote.
//
// WHICH SITE, and why this one: of the 35 migrated call sites, most fire only
// when an audit write, a cache bust or a rename throws — states a test cannot
// provoke without stubbing the module under test, which would then be asserting
// on the stub. `[attachments] export read failed` is the one reachable from
// outside with nothing but ordinary API calls plus a row: the export base64-reads
// each attachment's file, and a row whose file is not on disk takes the catch. It
// is also honestly isolated — the read is scoped to `?competitionId=`, so this
// asserts on its OWN fixture's attachment and cannot be perturbed by, or perturb,
// any other spec's files.
test.describe("Request-scoped log context (item #14)", () => {

  test("a migrated request-scoped log line carries req_id and ip", async () => {
    const { api, csrf } = await apiLogin("superadmin");

    // Own fixture end to end (the standing rule): never a seeded participant, and
    // never the seeded competitions, which other specs assign challenges into.
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: `${uniq()} LogCtx`, event_kind: "tournament",
        start_time: new Date(Date.now() - 3600e3).toISOString(),
        duration_minutes: 600, timezone: "UTC",
      },
    });
    expect(cr.ok(), `create competition: ${await cr.text()}`).toBeTruthy();
    const comp = (await cr.json()).competition;

    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: {
        title: `${uniq()} LogCtxT`, description: "d", difficulty: "easy",
        answer_type: "text", correct_answer: "right", status: "published",
      },
    });
    expect(tr.ok(), `create task: ${await tr.text()}`).toBeTruthy();
    // Take the id the create RETURNS — resolving by title matches a challenge an
    // earlier test in the same file made (the v8.1.0 fixture trap).
    const { id: bankId } = await tr.json();
    expect(bankId, "the create returns the new challenge's id").toBeTruthy();

    const ar = await api.post(`/api/admin/tasks/${bankId}/competitions`, {
      headers: H(csrf), data: { competitionIds: [comp.id] },
    });
    expect(ar.ok(), `assign challenge: ${await ar.text()}`).toBeTruthy();
    // The event's own copy (lib/event-copies.js): what the event's export carries.
    const taskId = (await ar.json()).copies[0].task_id;

    // Plant an attachment row whose file is not on disk. `size_bytes` is 1 so the
    // export's 96 MB total cap cannot fire and turn this into a 413 instead.
    const attId = uuid();
    const missingRel = path.posix.join("attachments", `${attId}-absent.zip`);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, missingRel)),
      "precondition: the planted attachment's file really is absent").toBe(false);
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare(
        "INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(attId, taskId, "absent.zip", "absent.zip", 1, "0".repeat(64), missingRel, new Date().toISOString(), "logctx-spec", 0);
    } finally { dbW.close(); }

    const r = await api.get(`/api/admin/export/tasks?competitionId=${comp.id}&include_attachment_content=1`);
    expect(r.ok(), `export: ${await r.text()}`).toBeTruthy();

    // X-Request-ID is stamped before the parsers run, so the caller holds the
    // key the log line must carry. This is the join this whole item is about.
    const reqId = r.headers()["x-request-id"];
    expect(reqId, "the response carries X-Request-ID").toBeTruthy();

    // PRECONDITION, not decoration: without it, "no log line was found" is
    // equally satisfied by an export that never entered the failing branch, and
    // the test would report a logging regression against working code.
    const body = await r.json();
    const mine = (body.tasks || []).find(t => (t.attachments || []).some(a => a.display_name === "absent.zip"));
    expect(mine, "the export includes the challenge carrying the planted attachment").toBeTruthy();
    const att = mine.attachments.find(a => a.display_name === "absent.zip");
    expect(att.read_error, "the attachment read really did fail (the branch ran)").toBe(true);
    expect(att.content_b64, "a failed read yields no content").toBe(null);

    // findLogLine is the ONE polled reader (helpers.js). The app log is written
    // asynchronously, so a read taken the instant the response lands can miss the
    // line — poll with a cap, never sleep.
    const line = await findLogLine(
      path.join(TEST_DATA_DIR, "logs"),
      l => l.req_id === reqId && l.msg === "[attachments] export read failed",
      { what: "the migrated [attachments] export-read line for this request", timeoutMs: 10000 }
    );

    // The fields, not the sentence. Asserting the sentence is what let the
    // reversed-argument bug ship: `log.error(msg, ctx)` writes the identical
    // message with every field dropped.
    expect(line.req_id, "the line carries the request id").toBe(reqId);
    expect(line.ip, "the line carries the caller's address").toBeTruthy();
    expect(line.tag, "the [attachments] tag is a FIELD as well as message text").toBe("attachments");
    expect(line.task_id, "the line names the challenge whose file was missing").toBe(taskId);
    expect(typeof line.err, "the error message is a field, not interpolated").toBe("string");

    // `legacy: true` is the marker `lib/log.js` stamps on its console.* override.
    // Its ABSENCE is what says this went through `log.error` rather than the shim —
    // the migration marker whose removal is the intended direction of this work.
    expect(line.legacy, "this line did NOT come from the console.* shim").toBeUndefined();
  });

  // ── (b) SOURCE SCANNER — the durable half ─────────────────────────────────
  //
  // WHAT IT CLAIMS: no `log.*` call anywhere in `routes/**` or `lib/**` passes a
  // STRING LITERAL as its first argument.
  //
  // That is the exact shape of the silent-drop hazard and nothing else. It is
  // deliberately NOT "the first argument must be an object literal": `lib/audit.js`
  // passes a context VARIABLE (`log.info(top, ...)`), which is correct, and a
  // future site spreading a captured context const is correct too — a scanner
  // wrong about working code is one the next person deletes (CLAUDE.md, Recurring
  // rules). Banning the string literal flags the mistake and nothing else.
  //
  // STATED LIMIT: it reads the first token after the paren, so it cannot see a
  // first argument that is a string-valued VARIABLE (`log.error(msg, ctx)` where
  // `msg` is a const). That form is not what the reversed-argument mistake looks
  // like in practice — it is written inline — and covering it would need a type
  // checker rather than a scanner.
  test("no log.* call passes a string as its first argument (the silent-drop shape)", () => {
    // Comments FIRST, and both forms in ONE left-to-right alternation — reused
    // verbatim from functional-core-b's Docs hygiene (a `/*` inside a `//` line
    // otherwise deletes everything to the next `*/`, eating real code).
    //
    // MEASURED, so the claim is not overstated: this stripper is currently
    // DEFENCE IN DEPTH, not load-bearing. Removing it does not turn this test red
    // today, because the regex requires an opening paren and no comment in
    // routes/ or lib/ writes `log.error(`. It stays because the pattern is one a
    // comment explaining a fix naturally quotes — the shape that has defeated
    // three scanners in this codebase — and because it costs nothing.
    const _stripJsComments = (raw) =>
      raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? "" : pre));

    const files = [];
    for (const d of ["routes", "lib"]) {
      for (const f of fs.readdirSync(path.join(ROOT, d))) {
        if (f.endsWith(".js")) files.push(path.join(d, f));
      }
    }
    expect(files.length, "the scanner found source files to scan").toBeGreaterThan(10);

    let total = 0;
    const offenders = [];
    for (const rel of files) {
      const src = _stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      const re = /\blog\.(error|warn|info|debug)\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        total++;
        const first = src.slice(m.index + m[0].length).replace(/^\s+/, "")[0];
        if (first === '"' || first === "'" || first === "`") {
          offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length} — log.${m[1]}( "…"`);
        }
      }
    }

    // ANTI-VACUITY FLOOR. A rename of `log` (or of the levels) would leave the
    // regex matching nothing and this test passing in silence — which is exactly
    // the failure it exists to catch. Measured at 50 when this shipped.
    expect(total, "the scanner found log.* call sites (a rename would empty it)").toBeGreaterThanOrEqual(25);

    // CONFIRM BEFORE REPORTING. This scanner reads source files that a concurrent
    // writer (a parallel agent, an editor save, a `cp`) can be part-way through
    // rewriting, and a PARTIAL read can re-align the comment stripper and
    // manufacture a phantom offender — observed once, in a tree being written by
    // several agents at once. A genuine offender is stable on disk, so a second
    // read reproduces it and a transient one does not: this removes the
    // spurious-failure class without weakening the claim by a single site.
    // (A scanner that is wrong about working code is one the next person deletes.)
    const confirmed = offenders.filter(o => {
      const rel = o.slice(0, o.indexOf(":"));
      const src = _stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      const re2 = /\blog\.(error|warn|info|debug)\s*\(/g;
      let m2;
      while ((m2 = re2.exec(src))) {
        const first = src.slice(m2.index + m2[0].length).replace(/^\s+/, "")[0];
        if (first === '"' || first === "'" || first === "`") return true;
      }
      return false;
    });

    expect(confirmed, [
      "A log.* call passes a STRING first. lib/log.js's signature is",
      "log.<level>(context, message) — CONTEXT FIRST — and the string branch",
      "writes the message with a NULL context, dropping every field silently.",
      "Fix the SITE: log.error({ ...reqContext(req), err: e.message }, \"message\").",
    ].join(" ")).toEqual([]);
  });

  // ── (d) The migrated surfaces stay migrated ───────────────────────────────
  //
  // Arm (b) catches the reversed-argument mistake; it does NOT catch a plain
  // revert to `console.error`, which reaches app.jsonl through the console.*
  // override in lib/log.js carrying `{legacy: true}` and NOTHING else — no
  // request, no user, no address. Measured: reverting one migrated site to
  // console.error leaves arms (a)-(c) green unless that exact site happens to be
  // the one the behavioural arm drives. This is the arm that makes the sweep
  // stick, and it is what a NEW route file inherits for free.
  //
  // SCOPE, stated honestly. `routes/**` is claimed WHOLESALE — every one of its
  // files is console-free as of this change, so the blanket form is both true and
  // the strongest available, and it covers files added later. `lib/**` is NOT: 9
  // lib modules still hold request-less or deliberately-exempt console.* calls
  // (lib/config.js is a require-cycle blocker, lib/cxone.js is source-pinned by
  // cxone-binding.spec.js), so only the two modules this change migrated are
  // named — a decision per file, never blanket coverage.
  test("routes/ and the migrated lib modules hold no console.* call", () => {
    // Comments FIRST — and, as in arm (b), MEASURED as defence in depth rather
    // than load-bearing. routes/invitations.js does carry a comment naming
    // `console.error` (it explains that this very line used to be one), but the
    // regex requires an opening paren and that comment has none, so removing the
    // stripper does not turn this red today. It stays because the very next
    // comment to write `console.error(...)` with its parens — the natural way to
    // document what a line used to be — would otherwise be reported as a
    // violation, and a scanner wrong about working code is one the next person
    // deletes.
    const _stripJsComments = (raw) =>
      raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? "" : pre));

    const scanned = [];
    for (const f of fs.readdirSync(path.join(ROOT, "routes"))) {
      if (f.endsWith(".js")) scanned.push(path.join("routes", f));
    }
    // The two lib modules this change migrated. Named explicitly: the rest of
    // lib/ is out of scope and must not be swept up by a widening.
    scanned.push("lib/http.js", "lib/group-sync.js");

    // ANTI-VACUITY: a moved directory or a renamed module would leave this
    // scanning nothing and passing in silence. Measured at 17 when this shipped.
    expect(scanned.length, "the scanner found files to scan").toBeGreaterThanOrEqual(12);

    const offenders = [];
    let logCalls = 0;
    for (const rel of scanned) {
      const src = _stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      logCalls += (src.match(/\blog\.(error|warn|info|debug)\s*\(/g) || []).length;
      const re = /\bconsole\.(log|warn|error|debug|info)\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length} — console.${m[1]}(`);
      }
    }

    // Second floor: these files must still be DOING structured logging. Without
    // it, deleting every log call would satisfy "no console.*" trivially.
    expect(logCalls, "the scanned files still make structured log.* calls").toBeGreaterThanOrEqual(25);

    expect(offenders, [
      "A console.* call is back in routes/ or in one of the two migrated lib",
      "modules. lib/log.js's console override sends it to app.jsonl with",
      "{legacy: true} and NO request context — no req_id, so it cannot be joined",
      "to access-*.jsonl or to a user's bug report (the whole point of v7.21.24).",
      "Use log.<level>({ ...reqContext(req), err: e.message }, \"message\") instead.",
      "If the site genuinely has no request in scope, it still belongs in log.*.",
    ].join(" ")).toEqual([]);
  });

  // ── (c) The two DEFERRED sites must use a CAPTURED context ────────────────
  //
  // `req.ip` is a lazy getter onto the socket, so reading it after the response
  // has gone yields undefined — the v8.8.9 finding, recorded in CLAUDE.md's Audit
  // trail section (*Attribution and reqContext*). Two of the 35 migrated sites
  // run after the response:
  //
  //   routes/participant.js — the `_deferAudit` drain (setImmediate, post-commit)
  //   routes/auth.js        — the DETACHED sendLoginCodeEmail(...).catch(...)
  //
  // Both must spread a context captured at QUEUE time. This is a source lock
  // because the failure is a spread of `undefined` — a line that still has a
  // `msg`, still has a `req_id: null`, and looks fine unless you know to check.
  // Nothing else in the suite pins it.
  test("the two deferred/detached sites capture their context at queue time", () => {
    const cases = [
      { file: "routes/participant.js", msg: "deferred select-timeslot event persist failed", captured: "_selReqCtx" },
      { file: "routes/auth.js",        msg: "sendLoginCodeEmail(request) rejected",          captured: "_codeReqCtx" },
    ];
    for (const c of cases) {
      const src = fs.readFileSync(path.join(ROOT, c.file), "utf8");
      const at = src.indexOf(c.msg);
      expect(at, `${c.file}: the migrated site "${c.msg}" still exists`).toBeGreaterThan(-1);
      // The whole log call sits on one line at both sites; take a generous window
      // either side rather than assuming a formatter has not reflowed it.
      const lineStart = src.lastIndexOf("\n", at) + 1;
      const lineEnd = src.indexOf("\n", at);
      const call = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);

      expect(call, `${c.file}: the deferred site spreads the context captured at queue time`)
        .toContain(c.captured);
      expect(call.includes("reqContext(req)"),
        `${c.file}: the deferred site must NOT call reqContext(req) inline — it runs `
        + "after the response, when req.ip (a lazy getter onto the socket) reads undefined (v8.8.9)")
        .toBe(false);

      // And the capture itself must exist, at handler scope.
      expect(src.includes(`const ${c.captured} = reqContext(req);`),
        `${c.file}: ${c.captured} is captured from the live request at handler scope`).toBe(true);
    }
  });
});

// ── (e) v8.13.3 — A LOG SINK NEVER CARRIES AN UNSCRUBBED REQUEST PATH ─────────
//
// `_scrubLogPath` (server.js) redacts every capability a URL can carry — the
// self-enrol `/join/<token>`, `?join=` / `?joinToken=`, `/badge/<token>`, a
// reset or verify `?code=`, an unsubscribe `?token=`, an invitation id. It is
// only as good as its call sites, and v8.13.3 found three sinks that skipped it:
// the SPA-shell perf span logged `"GET " + req.path` (a slow `/join/<token>`
// load wrote the live join token into app.jsonl, which every REGULAR admin reads
// through Logs), the CSP report handler logged the browser's `document-uri` /
// `blocked-uri` / `source-file` raw (a reset link's `?code=` arrives that way),
// and two proxy diagnostics logged `req.path` unwrapped. Each was correct the day
// the scrubber was written and wrong the day somebody added a sink beside it —
// the failure mode is always the sink added LATER, which is why this is a source
// scanner and not a sentence (CLAUDE.md, Recurring rules).
//
// WHAT IT CLAIMS. Every occurrence of a request-path SOURCE inside a log or audit
// SINK has `_scrubLogPath(` among its enclosing calls.
//   SINKS   log.<level>( / logAccess.<level>( / logAccess[lvl]( (the access
//           logger's computed-member form), console.<level>(, record*Event( and
//           queueEvent( (the submit path's by-reference form).
//   SOURCES req.path / req.originalUrl / req.url / req.baseUrl (and `res.req.…`),
//           the browser-reported URLs on a CSP report, and ONE level of alias —
//           a `const X = <source expression>` in the same function, which is what
//           a handler writes before it logs.
//   ONE LEVEL of by-name indirection on the SINK side too: a bare identifier or
//   a `...spread` argument is resolved to the nearest preceding `const X = {…}`
//   in scope. That is what reaches the access logger's `ctx`, the error
//   handler's `ctx` and the CSP handler's `fields` — the three sinks that matter
//   most build their object first and log it second.
// And a second rule (LCL-3): no sink argument carries an `invitation_id` /
// `invitationId` KEY. An invitation id is a bearer capability until claimed;
// log its fingerprint (lib/audit capabilityFingerprint, `if_`) instead.
//
// STRINGS ARE BLANKED, not only comments. A message like "GET /join/…" or a
// comment quoting `req.path` must never count as a source — the
// quoting-the-forbidden-pattern trap that has defeated three scanners here. A
// template literal's `${…}` is kept, because that IS code.
//
// STATED LIMITS, so nobody infers coverage from the green:
//   - ONE level of indirection each side. A path copied through two variables,
//     or into an object built in another function, is invisible.
//   - `err.message` is not a source. A library error that QUOTES a path (the
//     router's "Failed to decode param '<raw>'") reaches a sink through the
//     error handler; v8.13.3 closes that one by describing it instead of echoing
//     it (log-capability-scrub.api.spec.js holds it behaviourally).
//   - `req.params.*` is not a source: a route that logs its own `:token` param
//     by name is a different shape, and none does today.
//   - The tokeniser's regex-literal detection is a heuristic; a `/` after a
//     closing paren is read as division.
test.describe("Log sinks hold no unscrubbed capability (v8.13.3, LCL)", () => {
  // One deliberate exemption, keyed file#alias, with its reason. A stale entry
  // (one that no longer matches a flagged occurrence) FAILS, or the list would
  // silently keep excusing a site that has since moved.
  const EXEMPT = {
    "lib/rbac.js#raw":
      "eventAdminGuardMw (lib/rbac.js permissionGuard, moved from lib/event-admin.js) logs the normalised admin route an event admin hit when it is "
      + "UNCLASSIFIED for that tier. Every capability-bearing admin route is classified "
      + "(credential/:code and badges/:token/revoke), so only a wrong-method or extra-segment "
      + "variant the organiser typed themselves reaches it; and _scrubLogPath lives in "
      + "server.js, which three source locks slice out, so it cannot be imported here.",
  };

  function tokenise(raw) {
    const n = raw.length;
    const code = raw.split(""), kept = raw.split("");
    const blank = (arr, i) => { if (arr[i] !== "\n") arr[i] = " "; };
    const stack = [{ k: "code", depth: 0 }];
    let lastSig = "", lastWord = "", i = 0;
    const regexAfter = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
    while (i < n) {
      const top = stack[stack.length - 1];
      const c = raw[i], d = raw[i + 1];
      if (top.k === "tpl") {
        if (c === "\\") { blank(code, i); blank(code, i + 1); i += 2; continue; }
        if (c === "`") { stack.pop(); lastSig = "`"; i++; continue; }
        if (c === "$" && d === "{") { stack.push({ k: "code", depth: 0, inTpl: true }); i += 2; lastSig = "{"; continue; }
        blank(code, i); i++; continue;
      }
      if (c === "/" && d === "/") { while (i < n && raw[i] !== "\n") { blank(code, i); blank(kept, i); i++; } continue; }
      if (c === "/" && d === "*") {
        let j = raw.indexOf("*/", i + 2); if (j < 0) j = n - 2;
        for (let k = i; k < j + 2; k++) { blank(code, k); blank(kept, k); }
        i = j + 2; continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && raw[j] !== c && raw[j] !== "\n") { if (raw[j] === "\\") j++; j++; }
        for (let k = i + 1; k < j && k < n; k++) blank(code, k);
        i = j + 1; lastSig = c; lastWord = ""; continue;
      }
      if (c === "`") { stack.push({ k: "tpl" }); i++; continue; }
      if (c === "/" && (regexAfter.has(lastSig) || /^(return|typeof|case|in|of|delete|void|throw|new)$/.test(lastWord))) {
        let j = i + 1, inClass = false;
        while (j < n && raw[j] !== "\n") {
          if (raw[j] === "\\") { j += 2; continue; }
          if (raw[j] === "[") inClass = true; else if (raw[j] === "]") inClass = false;
          else if (raw[j] === "/" && !inClass) break;
          j++;
        }
        for (let k = i + 1; k < j && k < n; k++) blank(code, k);
        i = j + 1; while (i < n && /[a-z]/.test(raw[i])) i++;
        lastSig = "/"; lastWord = ""; continue;
      }
      if (c === "{") top.depth++;
      if (c === "}") {
        if (top.inTpl && top.depth === 0) { stack.pop(); i++; continue; }
        top.depth--;
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_$]/.test(raw[j])) j++;
        lastWord = raw.slice(i, j); lastSig = "w"; i = j; continue;
      }
      if (!/\s/.test(c)) { lastSig = c; lastWord = ""; }
      i++;
    }
    return { code: code.join(""), kept: kept.join("") };
  }
  function balanced(text, open) {
    const o = text[open], cl = { "(": ")", "{": "}", "[": "]" }[o];
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === o) depth++;
      else if (text[i] === cl) { depth--; if (depth === 0) return i; }
    }
    return -1;
  }
  function splitTop(e, sepRe) {
    const parts = []; let depth = 0, last = 0;
    for (let i = 0; i < e.length; i++) {
      const ch = e[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (depth === 0) {
        const m = e.slice(i).match(sepRe);
        if (m && m.index === 0) { parts.push(e.slice(last, i)); i += m[0].length - 1; last = i + 1; }
      }
    }
    parts.push(e.slice(last));
    return parts;
  }
  const SINK_RE = /\b(?:log|logAccess)\s*(?:\.\s*(?:info|warn|error|debug)|\[[^\]\n]+\])\s*\(|\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(|\brecord(?:User|Competition|Timeslot|Settings|Orphaned)(?:Audit)?Event\s*\(|\bqueueEvent\s*\(/g;
  const SRC_REQ = /\b(?:req|res\s*\.\s*req)\s*(?:\?\.|\.)\s*(?:path|originalUrl|url|baseUrl)\b/g;
  const SRC_REPORT = /\breport\s*(?:\[\s*"(?:document-uri|blocked-uri|source-file|referrer)"\s*\]|\??\.\s*(?:documentURL|blockedURL|sourceFile|referrer)\b)/g;
  const BOUNDARY = /^\s{0,2}(?:app\.(?:use|get|post|put|patch|delete)\(|(?:async\s+)?function\s+[\w$]+|module\.exports)/;
  const exact = (re, k) => { const r = new RegExp(re.source, "g"); const m = r.exec(k); return !!m && m.index === 0 && m[0].length === k.length; };
  const stripParens = (e) => { e = e.trim(); while (e.startsWith("(") && balanced(e, 0) === e.length - 1) e = e.slice(1, -1).trim(); return e; };
  // Is this expression a request path (a "source")? Pass-throughs that do not
  // change WHAT the value is — normaliseRoutePath(), String(), .toLowerCase(),
  // an `|| ""` fallback, `req && …` — keep it a source.
  function isSource(expr, keptExpr) {
    const e = stripParens(expr), k = stripParens(keptExpr);
    if (!e) return false;
    if (exact(SRC_REQ, k) || exact(SRC_REPORT, k)) return true;
    let m;
    if ((m = e.match(/^(?:require\s*\(\s*"[^"]*"\s*\)\s*\.\s*)?(normaliseRoutePath|String)\s*\(/))) {
      const open = e.indexOf("(", m[0].length - 1), close = balanced(e, open);
      if (close === e.length - 1) return isSource(splitTop(e.slice(open + 1, close), /^,/)[0], splitTop(k.slice(open + 1, close), /^,/)[0]);
    }
    if ((m = e.match(/^([\s\S]*)\.\s*toLowerCase\s*\(\s*\)$/))) return isSource(m[1], k.slice(0, m[1].length));
    const ors = splitTop(e, /^(?:\|\||\?\?)/);
    if (ors.length > 1) {
      let off = 0; let any = false; let ok = true;
      for (const p of ors) {
        const kp = k.slice(off, off + p.length); off += p.length + 2;
        if (isSource(p, kp)) any = true;
        else if (!/^\s*(?:(["'`])\s*\1|null|undefined)\s*$/.test(p)) ok = false;
      }
      return any && ok;
    }
    const ands = splitTop(e, /^&&/);
    if (ands.length === 2 && /^\s*req\s*$/.test(ands[0])) return isSource(ands[1], k.slice(ands[0].length + 2));
    return false;
  }
  const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
  // Nearest preceding `const|let|var NAME =` above `pos`, within the enclosing
  // registration or function (bounded by BOUNDARY, at most 150 lines up).
  function findDecl(code, kept, pos, name) {
    const lines = code.slice(0, pos).split("\n");
    let start = pos;
    for (let li = lines.length - 1, n = 0; li >= 0 && n < 150; li--, n++) {
      start -= lines[li].length + (li === lines.length - 1 ? 0 : 1);
      if (li < lines.length - 1 && BOUNDARY.test(lines[li])) break;
    }
    start = Math.max(0, start);
    const win = code.slice(start, pos);
    const re = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=(?!=)`, "g");
    let m, last = null;
    while ((m = re.exec(win))) last = m;
    if (!last) return null;
    const vStart = start + last.index + last[0].length;
    let depth = 0, i = vStart;
    for (; i < code.length && i - vStart < 2000; i++) {
      const ch = code[i];
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
      else if (depth === 0 && ch === ";") break;
      else if (depth === 0 && ch === "\n") {
        const rest = code.slice(i + 1).match(/^\s*(\S\S?)/);
        if (!rest || !/^(\|\||\?\?|\.|\?|:|\+|&&)/.test(rest[1])) break;
      }
    }
    return { at: vStart, value: code.slice(vStart, i), keptValue: kept.slice(vStart, i), declAt: start + last.index };
  }
  function scanFile(rel) {
    const { code, kept } = tokenise(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const out = [];
    const re = new RegExp(SINK_RE.source, "g"); let m;
    while ((m = re.exec(code))) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue; // a definition
      const open = m.index + m[0].length - 1, close = balanced(code, open);
      if (close < 0) continue;
      const segs = [{ text: code.slice(open + 1, close), kept: kept.slice(open + 1, close), via: null }];
      const names = new Set();
      for (const a of splitTop(segs[0].text, /^,/)) { const mm = a.trim().match(/^(?:\.\.\.\s*)?([A-Za-z_$][\w$]*)$/); if (mm) names.add(mm[1]); }
      for (const sm of segs[0].text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[(.[])/g)) names.add(sm[1]);
      for (const nm of names) {
        const d = findDecl(code, kept, m.index, nm);
        if (d && d.value.trim().startsWith("{")) {
          const o = d.at + d.value.indexOf("{"), c2 = balanced(code, o);
          if (c2 > 0) segs.push({ text: code.slice(o, c2 + 1), kept: kept.slice(o, c2 + 1), via: nm, declPos: d.declAt });
        }
      }
      const occ = [], invKeys = [];
      for (const seg of segs) {
        const callAt = [], stack = [];
        for (let i = 0; i < seg.text.length; i++) {
          const ch = seg.text[i];
          if (ch === "(") { const w = seg.text.slice(0, i).match(/([\w$]+)\s*$/); stack.push(w ? w[1] : ""); }
          else if (ch === ")") stack.pop();
          callAt[i] = stack.slice();
        }
        const wrapped = (i) => (callAt[i] || []).includes("_scrubLogPath");
        for (const src of [SRC_REQ, SRC_REPORT]) {
          const r = new RegExp(src.source, "g"); const hay = src === SRC_REPORT ? seg.kept : seg.text; let s;
          while ((s = r.exec(hay))) {
            if (src === SRC_REPORT && seg.text.slice(s.index, s.index + 6) !== "report") continue; // inside a string
            occ.push({ what: seg.kept.slice(s.index, s.index + s[0].length), alias: null, wrapped: wrapped(s.index) });
          }
        }
        const idRe = /(?<![\w$.])(?<!\?\.)([A-Za-z_$][\w$]*)\b/g; let im;
        while ((im = idRe.exec(seg.text))) {
          const name = im[1];
          if (/^(req|res|err|e|true|false|null|undefined|new|typeof|this|return|const|let|var|function|await|async|in|of)$/.test(name)) continue;
          const after = seg.text.slice(im.index + name.length), before = seg.text.slice(0, im.index);
          if (/^\s*:(?!:)/.test(after) && /[{,]\s*$/.test(before)) continue; // an object KEY
          if (/^\s*\(/.test(after)) continue;                                // a call
          const d = findDecl(code, kept, seg.via ? seg.declPos : m.index, name);
          if (d && isSource(d.value, d.keptValue)) occ.push({ what: name, alias: name, wrapped: wrapped(im.index), decl: lineOf(code, d.at) });
        }
        const kr = /["']?\b(invitation_id|invitationId)\b["']?\s*:(?!:)|[{,]\s*(invitation_id|invitationId)\s*(?=[,}])/g; let q;
        while ((q = kr.exec(seg.kept))) invKeys.push(q[1] || q[2]);
      }
      out.push({ rel, line: lineOf(code, m.index), sink: m[0], occ, invKeys, kept: segs.map(s => s.kept).join(" ") });
    }
    return out;
  }
  function scanTree() {
    const files = ["server.js"];
    for (const d of ["routes", "lib"]) for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith(".js")) files.push(path.join(d, f));
    const sinks = [];
    for (const rel of files) sinks.push(...scanFile(rel));
    return sinks;
  }

  test("every request path or browser-reported URL in a log sink goes through _scrubLogPath", () => {
    const sinks = scanTree();
    const flag = (sk) => sk.occ.filter(o => !o.wrapped).map(o => ({ key: `${sk.rel}#${o.alias || o.what}`, where: `${sk.rel}:${sk.line} ${o.alias ? `alias ${o.alias} (declared line ${o.decl})` : o.what}` }));
    let flagged = sinks.flatMap(flag);

    // CONFIRM BEFORE REPORTING — the arm (b) rule: a concurrent writer can be
    // part-way through a file, and a partial read re-aligns the tokeniser. A real
    // offender is stable on disk; re-scan its file and keep only what reproduces.
    flagged = flagged.filter(f => {
      const rel = f.key.split("#")[0];
      return scanFile(rel).flatMap(flag).some(g => g.where === f.where);
    });

    const used = new Set();
    const offenders = flagged.filter(f => { if (EXEMPT[f.key]) { used.add(f.key); return false; } return true; });
    expect(offenders.map(f => f.where), [
      "A log or audit sink carries a request path (req.path / originalUrl / url, a",
      "browser-reported CSP URL, or a const aliasing one) that is NOT inside",
      "_scrubLogPath(...). That is how a live /join/<token>, ?code= or invitation id",
      "reaches app.jsonl, which every regular admin reads through Logs. Fix the SITE:",
      "wrap it — `path: _scrubLogPath(req.path)`. Do not widen EXEMPT without a reason.",
    ].join(" ")).toEqual([]);

    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `EXEMPT ${key} carries a stated reason`).toBeGreaterThan(40);
      expect(used.has(key), `EXEMPT ${key} is STALE — it no longer excuses any flagged site; delete it`).toBe(true);
    }

    // ANTI-VACUITY. A rename of `log`, of the sinks or of the scrubber empties
    // the match set and passes in silence — the failure this exists to catch.
    // Measured at v8.13.3: 484 sinks, 17 wrapped source occurrences.
    expect(sinks.length, "the scanner found log/audit sinks (a rename would empty it)").toBeGreaterThanOrEqual(300);
    const wrappedCount = sinks.reduce((n, sk) => n + sk.occ.filter(o => o.wrapped).length, 0);
    expect(wrappedCount, "the scanner saw wrapped source occurrences (a scrubber rename would empty it)").toBeGreaterThanOrEqual(6);

    // NAMED SITES, found AND wrapped. These are the four that build their object
    // first and log it second, so they depend on the ONE-LEVEL resolution: a
    // rename of `ctx` / `fields` that broke it would otherwise drop them from the
    // scan silently while every other number above still held.
    const named = {
      "the access logger": sk => sk.rel === "server.js" && /logAccess/.test(sk.sink),
      "the error handler": sk => sk.rel === "server.js" && sk.kept.includes("Request refused"),
      "the SPA-shell perf span": sk => sk.rel === "server.js" && sk.kept.includes("slow SPA shell"),
      "the CSP report handler": sk => sk.rel === "server.js" && sk.kept.includes('"CSP violation"'),
    };
    const min = { "the CSP report handler": 3 };
    for (const [label, pick] of Object.entries(named)) {
      const hits = sinks.filter(pick);
      expect(hits.length, `${label}: its log call was found`).toBeGreaterThan(0);
      const best = Math.max(...hits.map(sk => sk.occ.filter(o => o.wrapped).length));
      expect(best, `${label}: its request path(s) are seen AND wrapped in _scrubLogPath`).toBeGreaterThanOrEqual(min[label] || 1);
    }
  });

  test("no log or audit sink records a live invitation id (log its fingerprint)", () => {
    const sinks = scanTree();
    let offenders = sinks.filter(sk => sk.invKeys.length).map(sk => `${sk.rel}:${sk.line} ${sk.invKeys.join(",")}`);
    offenders = offenders.filter(o => {
      const rel = o.slice(0, o.indexOf(":"));
      return scanFile(rel).some(sk => sk.invKeys.length && `${sk.rel}:${sk.line} ${sk.invKeys.join(",")}` === o);
    });
    expect(offenders, [
      "A log or audit sink records an `invitation_id` / `invitationId` key. An invitation",
      "id is a bearer capability until it is claimed (GET /api/invitations/:id answers for",
      "it, and redeeming it creates a verified account at the invitee's address), and",
      "app.jsonl is read by every regular admin. Record",
      "`invitation_fp: capabilityFingerprint(invitation.id, \"if_\")` (lib/audit) instead.",
    ].join(" ")).toEqual([]);
    expect(sinks.length, "the scanner found sinks").toBeGreaterThanOrEqual(300);
  });
});
