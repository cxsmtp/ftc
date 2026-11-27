// @ts-check
// THE MULTIPART LIMITS — what a multipart request may keep in memory, and the
// sentence every refusal answers with.
//
// busboy (under multer) bounds one field's VALUE at 1 MiB and nothing else: the
// field, file and part counts default to Infinity, and multer checks a field
// NAME only when told to. So one authenticated request could hold any number of
// 1 MiB values in req.body beside a tiny file, and a bracketed name
// (`gradingHash[99999999]`) built a sparse array whose toString() stalled the
// event loop for seconds. Every multer instance is now built by lib/multipart.js
// `boundedMulter`, which refuses at construction limits that do not bound that
// text; this file holds:
//   * the wrapper's rules and the scanner that keeps every instance going through
//     it (no fixture — they must not fail because a fixture did);
//   * each limit at the HTTP layer on both instances, refused case beside the
//     control it must still admit, with no temp file left behind (the file part
//     is sent FIRST, so it is stored before the limit fires);
//   * the submit route's declared-length gate and its unread refusal of an
//     answer file too large to fit the answer cap;
//   * the drain behind every pre-body refusal (lib/http.js refuseBeforeBody),
//     whose browser half is in tests/cross-browser.spec.js;
//   * the non-string body values those routes used to throw on.
//
// FIXTURE TRAPS (checklist items 1, 3, 7): every graded control sends unique
// content, because the 3 s same-answer fold would answer `deduped` with no
// penalty, and asserts `pointsDelta === -5`; no test sends a correct answer, so
// the all-solved auto-end cannot end the event; graded submissions stay well
// under SUBMIT_VELOCITY_MAX_PER_MIN (30 per user per challenge per minute).
// Refused requests never reach the handler and store nothing.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DATA_DIR, TEST_DB_PATH, BASE, zipOf, findLogLine, codeLogin, awaitUploadRoom } = require("./helpers");
const { stripJsComments } = require("./doc-registry");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");

const ROOT = path.resolve(__dirname, "..");
const H = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `ml${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
// tests/server-env.js starts every worker server with UPLOADS_DIR =
// `${DATA_DIR}/uploads`, and the server mkdirs it at boot. The beforeAll below
// asserts it EXISTS: if server-env ever moved it, uploadsCount() would read 0 on
// both sides of every assertion here and the file would pass as `0 === 0`.
const UPLOADS = path.join(TEST_DATA_DIR, "uploads");
const STAGING = path.join(TEST_DATA_DIR, "attachments-staging");

const HINT = "Reduce the size and try again — retrying unchanged will not help.";
const SHAPE = "Retrying it unchanged will not help.";
const TOO_LARGE = `That file is too large. ${HINT}`;
const FIELD_VALUE = `A text field in that upload is too long. ${HINT}`;
const FIELD_KEY = `A field name in that upload is too long. ${SHAPE}`;
const FIELD_COUNT = `That upload has more form fields than this endpoint accepts. ${SHAPE}`;
const FILE_COUNT = `That upload carries more files than this endpoint accepts. ${SHAPE}`;
const PART_COUNT = `That upload has more parts than this endpoint accepts. ${SHAPE}`;
const NESTING = "Upload rejected: Field name nesting too deep.";
const ANSWER_TOO_LONG = "Answer too long. Please shorten your submission.";
const FILE_ANSWER_TOO_LARGE = "Uploaded file is too large. Maximum answer size is 1 MB.";
const MIB = 1024 * 1024;

function dirCount(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}
const uploadsCount = () => dirCount(UPLOADS);
function appLinesFor(reqId) {
  const dir = path.join(TEST_DATA_DIR, "logs");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(n => n.startsWith("app-"))) {
    for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!l) continue;
      try { const j = JSON.parse(l); if (j.req_id === reqId) out.push(j); } catch (_) {}
    }
  }
  return out;
}
/**
 * The error handler's "Request refused" line for a request, once it lands. Every
 * other line for the same request is asserted NOT to be an error: a refusal is the
 * caller's business, and a limit that aborts after a file was stored once wrote an
 * error-level "[upload-cleanup] unlink failed" line beside it (multer had already
 * removed the file).
 */
async function refusedLineFor(reqId) {
  expect(reqId, "the response names its request").toBeTruthy();
  const refusedLine = () => appLinesFor(reqId).find(j => /^Request refused/.test(j.msg || ""));
  await expect.poll(() => (refusedLine() ? 1 : 0), { timeout: 5000, message: `a "Request refused" app.jsonl line for ${reqId}` }).toBe(1);
  const errors = appLinesFor(reqId).filter(j => j.level === "error");
  expect(errors.map(j => j.msg), "no error-level line for a refused upload").toEqual([]);
  return refusedLine();
}
const logLineFor = (r) => refusedLineFor(r.headers()["x-request-id"]);

// ── hand-built multipart bodies ─────────────────────────────────────────────
// Playwright's `multipart` option cannot send a skipped part, a bracketed or
// over-long name, an empty-filename part or two parts of one name, so the
// refusal cases build the body themselves.
const field = (name, value) => ({ head: `Content-Disposition: form-data; name="${name}"`, body: value });
const filePart = (name, filename, type, body) =>
  ({ head: `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}`, body });
// No Content-Disposition: busboy skips the part, and only `parts` counts it.
const skippedPart = () => ({ head: "X-Not-A-Form-Part: 1", body: "skipped" });
// busboy classifies an octet-stream part as a FILE even with an empty filename
// (multer then drains it silently); as text/plain the same part would be a field.
const emptyFilePart = () => filePart("file", "", "application/octet-stream", "");
const junk = (n, bytes) => Array.from({ length: n }, (_, i) => field(`junk${i}`, Buffer.alloc(bytes, 0x6a)));
function form(parts) {
  const boundary = `----ml${uniq()}`;
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${p.head}\r\n\r\n`), Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}
async function postForm(api, csrf, url, parts) {
  const f = form(parts);
  return api.post(url, { headers: { "x-csrf-token": csrf, "content-type": f.contentType }, data: f.body });
}

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe("boundedMulter — the wrapper and the scanner (no fixture)", () => {
  test("SCANNER: no app code but lib/multipart.js requires multer, and both instances go through boundedMulter", () => {
    // Built from parts so this file's own text names the module nowhere; the
    // scan covers app code only, never tests/.
    const NAME = "mul" + "ter";
    const RE = new RegExp(`(?:\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|\\bfrom\\s+|\\bimport\\s+)(["'\`])${NAME}(?:/[^"'\`]*)?\\1`, "g");
    // Planted controls: a subpath require, a dynamic import and an ESM import all match.
    for (const planted of [`require("${NAME}/lib/make-middleware")`, `await import('${NAME}')`, `import m from "${NAME}";`]) {
      expect(planted.match(RE), `the matcher must catch: ${planted}`).toHaveLength(1);
    }
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:js|cjs|mjs)$/.test(e.name)) files.push(p);
      }
    };
    for (const d of ["lib", "routes", "scripts"]) walk(path.join(ROOT, d));
    for (const f of ["server.js", "db.js"]) files.push(path.join(ROOT, f));
    expect(files.length, "the walk read the app tree").toBeGreaterThan(60);
    const hits = {};
    for (const f of files) {
      const n = (stripJsComments(fs.readFileSync(f, "utf8")).match(RE) || []).length;
      if (n) hits[path.relative(ROOT, f)] = n;
    }
    // Anti-vacuity: the wrapper's own require is seen.
    expect(hits["lib/multipart.js"], "the wrapper's own require must be matched").toBe(1);
    delete hits["lib/multipart.js"];
    expect(hits, "build every multer instance with lib/multipart.js boundedMulter, which refuses unbounded limits").toEqual({});
    for (const f of ["server.js", "routes/challenges.js"]) {
      const src = stripJsComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
      expect(src, `${f} builds its instance through boundedMulter`).toMatch(/\bboundedMulter\(\{/);
    }
  });

  test("UNIT: boundedMulter refuses, by its own message, every limits object that does not bound a request's text", () => {
    const { boundedMulter, MULTIPART_TEXT_MAX_BYTES } = require("../lib/multipart");
    const ok = () => ({ fileSize: 10 * MIB, files: 1, fields: 2, fieldSize: 1024, fieldNameSize: 100, parts: 3, fieldNestingDepth: 0 });
    // Every assertion is anchored to the wrapper's own prefix: multer's
    // validator also throws "Expected limits.<key> …" for a non-integer, so an
    // unanchored /limits\.fieldSize/ would pass with the wrapper's check deleted.
    const refused = (label, limits, key) => {
      expect(() => boundedMulter({ limits }), label).toThrow(new RegExp(`^boundedMulter: limits\\.${key} `));
    };
    // CONTROL: the full object builds a real multer instance, and is frozen.
    const good = ok();
    const inst = boundedMulter({ limits: good });
    expect(inst.single("file").name, "a real multer middleware (csrfProtection keys on this name)").toBe("multerMiddleware");
    expect(Object.isFrozen(good), "a checked limits object cannot be widened afterwards").toBe(true);
    for (const key of ["fileSize", "files", "fields", "fieldSize", "fieldNameSize", "parts", "fieldNestingDepth"]) {
      const missing = ok(); delete missing[key];
      refused(`a missing ${key}`, missing, key);
      refused(`${key}: Infinity (multer accepts it)`, { ...ok(), [key]: Infinity }, key);
      refused(`${key}: 1.5`, { ...ok(), [key]: 1.5 }, key);
      refused(`${key}: -1`, { ...ok(), [key]: -1 }, key);
    }
    refused("an unknown (misspelt) key", { ...ok(), fieldsize: 10 }, "fieldsize");
    // The two remaining multer keys are refused WITH their reason, not merely as unknown.
    expect(() => boundedMulter({ limits: { ...ok(), headerPairs: 100 } }), "headerPairs")
      .toThrow(/^boundedMulter: limits\.headerPairs is ignored by busboy's multipart parser/);
    expect(() => boundedMulter({ limits: { ...ok(), fieldArrayIndexLimit: 0 } }), "fieldArrayIndexLimit")
      .toThrow(/^boundedMulter: limits\.fieldArrayIndexLimit can never fire/);
    refused("bracketed names (depth 1)", { ...ok(), fieldNestingDepth: 1 }, "fieldNestingDepth");
    refused("two files", { ...ok(), files: 2, parts: 4 }, "files");
    refused("parts beyond fields + files", { ...ok(), parts: 4 }, "parts");
    refused("Number.MAX_SAFE_INTEGER fields", { ...ok(), fields: Number.MAX_SAFE_INTEGER, parts: 3 }, "fields");
    // The aggregate budget, at its boundary: exactly the budget is admitted.
    const at = { ...ok(), fields: 1, parts: 2, fieldNameSize: 100, fieldSize: MULTIPART_TEXT_MAX_BYTES - 100 };
    expect(() => boundedMulter({ limits: at }), "fields * (fieldSize + fieldNameSize) equal to the budget").not.toThrow();
    refused("one byte over the text budget", { ...ok(), fields: 1, parts: 2, fieldNameSize: 100, fieldSize: MULTIPART_TEXT_MAX_BYTES - 99 }, "fields");
    for (const [label, opts] of [["a per-request limits function", { limits: () => ok() }], ["no limits", {}], ["an array", { limits: [] }]]) {
      expect(() => boundedMulter(opts), label).toThrow(/^boundedMulter: limits must be a plain object/);
    }
  });

  test("SOURCE: the submit form's text cap derives from the handler's answer cap", () => {
    // The fieldSize below which every answer reaches the handler's own sentence
    // is a function of the handler's cap; a second literal could drift from it.
    const src = stripJsComments(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"));
    expect(src.match(/\bconst SUBMIT_ANSWER_MAX_CHARS\s*=/g), "the cap is declared once").toHaveLength(1);
    expect(src, "the cap is 65536 characters").toMatch(/\bconst SUBMIT_ANSWER_MAX_CHARS\s*=\s*65536;/);
    expect(src.match(/\b65536\b|\b65_536\b/g), "no other 65536 literal in server.js: use the constant").toHaveLength(1);
    expect(src, "fieldSize derives from the cap").toMatch(/fieldSize:\s*3\s*\*\s*SUBMIT_ANSWER_MAX_CHARS\s*,/);
    expect(src, "the handler measures against the cap").toMatch(/_answerText\.length\s*>\s*SUBMIT_ANSWER_MAX_CHARS\b/);
    expect(src, "the unread file refusal derives from the file-answer cap").toMatch(/req\.file\.size\s*<=\s*3\s*\*\s*SUBMIT_FILE_ANSWER_MAX_CHARS\b/);
    expect(src, "and the read one measures against it").toMatch(/answer\.length\s*>\s*SUBMIT_FILE_ANSWER_MAX_CHARS\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("refuseBeforeBody, in process (no fixture)", () => {
  test("UNIT: a client that asked to close is answered even when its body was already read", async () => {
    // Such a client is answered at the body's "end", which a body some caller
    // already read never emits again. CONTROL: the same refusal, body unread.
    const express = require("express");
    const { refuseBeforeBody } = require("../lib/http");
    const app = express();
    app.post("/unread", (req, res) => refuseBeforeBody(req, res, 413, { error: "refused" }));
    app.post("/read-first", (req, res) => { req.once("end", () => refuseBeforeBody(req, res, 413, { error: "refused" })); req.resume(); });
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const post = (p) => new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path: p, method: "POST",
        headers: { connection: "close", "content-type": "text/plain" } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", (e) => resolve({ error: e.code }));
      req.setTimeout(3000, () => { resolve({ hung: true }); req.destroy(); });
      req.end("x".repeat(1024));
    });
    try {
      const refused = { status: 413, text: JSON.stringify({ error: "refused" }) };
      expect(await post("/unread"), "CONTROL: answered after its body drains").toEqual(refused);
      expect(await post("/read-first"), "answered, not left waiting for an end that came before").toEqual(refused);
    } finally { server.closeAllConnections(); server.close(); }
  });
});

test.describe("the multipart routes, end to end", () => {
  // { comp, fileTaskId, textTaskId, api, csrf, admin: {api, csrf} } — one
  // participant inside one live competition holding a file and a text challenge.
  let fx = null;

  async function makeParticipant(admin, label) {
    const anon = await freshCtx();
    const email = `${label}@company.example`;
    try {
      const reg = await registerPost(anon.api, "/api/register", {
        headers: H(anon.csrf),
        data: {
          firstName: "Mul", lastName: label, nickname: label, email, company: "Acme", title: "Engineer",
          country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
          jobFunction: "Software Developer / Engineer", city: "Testville",
        },
      });
      expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
    } finally { await anon.api.dispose(); }
    const list = await (await admin.api.get("/api/admin/participants?limit=5000")).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, "the participant is findable").toBeTruthy();
    expect((await admin.api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(admin.csrf) })).ok()).toBeTruthy();
    expect((await admin.api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(admin.csrf) })).ok()).toBeTruthy();
    return { id: u.id, email };
  }

  test.beforeAll(async () => {
    expect(fs.existsSync(UPLOADS), `the worker server's UPLOADS_DIR must be ${UPLOADS} — see tests/server-env.js`).toBe(true);
    const admin = await sa();
    const { api, csrf } = admin;
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `${uniq()} Comp`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
    });
    expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
    const comp = (await cr.json()).competition;
    const mkTask = async (data) => {
      const tr = await api.post("/api/admin/tasks", { headers: H(csrf), data });
      expect(tr.ok(), `create task: ${await tr.text()}`).toBeTruthy();
      const { id } = await tr.json();
      const at = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      expect(at.ok(), `assign task: ${await at.text()}`).toBeTruthy();
      return id;
    };
    // Correct answers no test sends: nobody solves, so nothing auto-ends.
    const fileTaskId = await mkTask({ title: `${uniq()} File`, description: "d", difficulty: "easy", status: "published", answer_type: "file", correct_answer: "the-right-content" });
    const textTaskId = await mkTask({ title: `${uniq()} Text`, description: "d", difficulty: "easy", status: "published", answer_type: "text", correct_answer: "the-right-text-answer" });

    const p = await makeParticipant(admin, uniq());
    const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [p.id], competitionIds: [comp.id] } });
    expect((await asg.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(1);

    const pc = await freshCtx();
    const li = await codeLogin(pc.api, p.email, H(pc.csrf));
    expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
    const pcsrf = (await (await pc.api.get("/api/csrf-token")).json()).csrfToken;
    const sel = await pc.api.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: comp.id } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    fx = { comp, fileTaskId, textTaskId, api: pc.api, csrf: pcsrf, admin, makeParticipant };
  });

  async function gradingHash(taskId) {
    const view = await (await fx.api.get(`/api/tasks/${taskId}`)).json();
    expect(view.grading_hash, "the challenge detail carries a grading token").toBeTruthy();
    return view.grading_hash;
  }
  const submitUrl = (taskId) => `/api/tasks/${taskId}/submit`;
  /**
   * A raw request as the fixture participant. `body` null sends the headers alone
   * (and never a body); otherwise it is written CHUNKED unless a content-length
   * header is given. Resolves with the response, or fails after 8 s.
   */
  async function rawPost(urlPath, headers, body) {
    const st = await fx.api.storageState();
    const cookie = st.cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const u = new URL(urlPath, BASE);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { cookie, "x-csrf-token": fx.csrf, ...headers } }, (resp) => {
        let text = "";
        let done = false;
        const finish = () => { if (!done) { done = true; resolve({ status: resp.statusCode, headers: resp.headers, body: text }); req.destroy(); } };
        resp.setEncoding("utf8");
        resp.on("data", c => { text += c; });
        resp.on("end", finish);
        resp.on("close", finish);
      });
      req.on("error", (e) => reject(e));
      req.setTimeout(8000, () => req.destroy(new Error("no answer within 8 s")));
      if (body === null) req.flushHeaders();
      // write-then-end: `end(body)` alone makes Node compute a Content-Length.
      else { req.write(body); req.end(); }
    });
  }
  /**
   * One TCP connection spoken to by hand, as `as` (default the fixture
   * participant). The drain tests must see the SERVER keep or cut the connection,
   * which an HTTP client hides: it closes on `Connection: close` itself, and an
   * agent decides reuse. `head()` writes a request head and nothing else, in
   * HTTP/1.1 unless `version` says otherwise.
   */
  async function openConnection(as = fx) {
    const st = await as.api.storageState();
    const cookie = st.cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const u = new URL(BASE);
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
    const conn = { sock, raw: Buffer.alloc(0), closed: false, error: null };
    sock.on("data", (d) => { conn.raw = Buffer.concat([conn.raw, d]); });
    // A cut connection is an outcome these tests assert, not a failure.
    sock.on("error", (e) => { conn.error = e.code || e.message; });
    sock.on("close", () => { conn.closed = true; });
    conn.head = (method, urlPath, headers = {}, version = "1.1") => {
      const lines = [`${method} ${urlPath} HTTP/${version}`, `Host: ${u.host}`, `Cookie: ${cookie}`, `X-CSRF-Token: ${as.csrf}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      sock.write(lines.join("\r\n") + "\r\n\r\n");
    };
    /** Every COMPLETE response received so far, in order: {status, headers, body}. */
    conn.responses = () => {
      const out = [];
      let rest = conn.raw;
      while (rest.subarray(0, 9).toString("latin1") === "HTTP/1.1 ") {
        const end = rest.indexOf("\r\n\r\n");
        if (end < 0) break;
        const [statusLine, ...lines] = rest.subarray(0, end).toString("latin1").split("\r\n");
        const headers = Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
        const len = parseInt(headers["content-length"] || "0", 10);
        if (rest.length < end + 4 + len) break;
        out.push({ status: parseInt(statusLine.split(" ")[1], 10), headers, body: rest.subarray(end + 4, end + 4 + len).toString("utf8") });
        rest = rest.subarray(end + 4 + len);
      }
      return out;
    };
    conn.awaitResponses = async (n, what) => {
      await expect.poll(() => conn.responses().length, { timeout: 10000, message: `${what}: ${n} response(s) — got ${JSON.stringify(conn.raw.subarray(0, 300).toString("utf8"))}` }).toBe(n);
      return conn.responses();
    };
    /** True when the server closed the connection within `ms`. */
    conn.closesWithin = (ms) => new Promise((resolve) => {
      if (conn.closed) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      sock.once("close", () => { clearTimeout(t); resolve(true); });
    });
    return conn;
  }
  const answerFile = () => filePart("file", "answer.txt", "text/plain", `a wrong answer ${uniq()}`);
  /** A graded WRONG answer: not refused, not folded into an earlier one. */
  async function expectGradedWrong(r, what) {
    const text = await r.text();
    expect(r.status(), `${what}: ${text}`).toBe(200);
    const d = JSON.parse(text);
    expect(d.correct, `${what}: graded, and wrong`).toBe(false);
    expect(d.deduped, `${what}: not folded into an earlier submission`).toBeUndefined();
    expect(d.pointsDelta, `${what}: the -5 a graded wrong answer costs`).toBe(-5);
  }
  async function expectRefused(r, status, sentence, beforeUploads) {
    expect(r.status(), await r.text()).toBe(status);
    expect((await r.json()).error).toBe(sentence);
    if (beforeUploads !== undefined) {
      await expect.poll(uploadsCount, { timeout: 5000, message: "a refused upload must not leave a file in UPLOADS_DIR" }).toBe(beforeUploads);
    }
  }

  test.describe("the participant submit", () => {
    test("an over-limit answer file is refused with the named sentence, leaves no temp file, and logs no client filename", async () => {
      const before = uploadsCount();
      const filename = `${uniq()}-DISTINCTIVE-NAME.txt`;
      const r = await fx.api.post(submitUrl(fx.fileTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: {
          gradingHash: await gradingHash(fx.fileTaskId),
          file: { name: filename, mimeType: "text/plain", buffer: Buffer.alloc(10 * MIB + 1, 0x61) },
        },
      });
      await expectRefused(r, 413, TOO_LARGE, before);
      const line = await logLineFor(r);
      expect(line.level, "a client error is logged as a warning, not an error").toBe("warn");
      expect(line.err_type, "multer refused it, not the declared-length gate (the body fits under its ceiling)").toBe("LIMIT_FILE_SIZE");
      // multer 2.4.0 attaches the caller's own filename to this error. It is
      // untrusted input and has no business in the operator's log.
      expect(JSON.stringify(line)).not.toContain("DISTINCTIVE-NAME");
    });

    test("CONTROL: the two exact client shapes are graded and leave no temp file", async () => {
      // Without these, every refusal below is satisfied by a route that refuses everything.
      const before = uploadsCount();
      const rf = await fx.api.post(submitUrl(fx.fileTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: { gradingHash: await gradingHash(fx.fileTaskId), file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from(`a wrong answer ${uniq()}`) } },
      });
      await expectGradedWrong(rf, "file + gradingHash");
      await expect.poll(uploadsCount, { timeout: 5000 }).toBe(before);
      const rt = await fx.api.post(submitUrl(fx.textTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: { answer: `wrong ${uniq()}`, gradingHash: await gradingHash(fx.textTaskId) },
      });
      await expectGradedWrong(rt, "answer + gradingHash");
    });

    test("THE REPORTED CASE: 16 MiB of junk text fields beside a tiny file is refused 413, stores nothing and logs no field name", async () => {
      // Sent CHUNKED: a declared Content-Length this size never reaches multer
      // (the declared-length test below), so this is the body multer's own limits
      // must stop. The gate writes no log line, so the err_type below is the
      // witness that multer answered.
      const before = uploadsCount();
      const f = form([answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)),
        ...Array.from({ length: 16 }, (_, i) => field(`DISTINCTJUNK${i}`, Buffer.alloc(MIB - 1, 0x6a)))]);
      const r = await rawPost(submitUrl(fx.fileTaskId), { "content-type": f.contentType }, f.body);
      expect(r.status, r.body).toBe(413);
      expect(JSON.parse(r.body).error).toBe(FIELD_VALUE);
      await expect.poll(uploadsCount, { timeout: 5000, message: "a refused upload must not leave a file in UPLOADS_DIR" }).toBe(before);
      const line = await refusedLineFor(r.headers["x-request-id"]);
      expect(line.level).toBe("warn");
      expect(line.err_type).toBe("LIMIT_FIELD_VALUE");
      expect(JSON.stringify(line), "the request's own field names stay out of the log").not.toContain("DISTINCTJUNK");
      expect(JSON.stringify(line)).not.toContain("answer.txt");
    });

    test("fields: a third text field is refused 413 (no file sent, so `parts` cannot answer first)", async () => {
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.textTaskId),
        [field("answer", `wrong ${uniq()}`), field("gradingHash", await gradingHash(fx.textTaskId)), field("junk", "j")]);
      await expectRefused(r, 413, FIELD_COUNT);
      expect((await logLineFor(r)).err_type).toBe("LIMIT_FIELD_COUNT");
    });

    test("fieldSize: a field of 196,609 bytes is refused; a 65,536-character answer of 196,608 bytes is graded", async () => {
      const before = uploadsCount();
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)), field("junk", Buffer.alloc(3 * 65536 + 1, 0x6a))]);
      await expectRefused(r, 413, FIELD_VALUE, before);
      // The handler's own cap, at its most bytes: 65,536 three-byte characters.
      const answer = "€".repeat(65536);
      expect(Buffer.byteLength(answer)).toBe(196608);
      const ok = await fx.api.post(submitUrl(fx.textTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: { answer, gradingHash: await gradingHash(fx.textTaskId) },
      });
      await expectGradedWrong(ok, "a 65,536-character answer at 3 bytes a character");
    });

    test("ONE SENTENCE PER ACTION: an over-long answer meets the handler's sentence whichever layer measures it", async () => {
      // 65,537 three-byte characters is over busboy's field cap, so multer refuses
      // it; the same length in ASCII reaches the handler's own check. A participant
      // pasting a long answer must not see an upload-form sentence for one script
      // and the answer sentence for another.
      const viaMulter = await fx.api.post(submitUrl(fx.textTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: { answer: "€".repeat(65537), gradingHash: await gradingHash(fx.textTaskId) },
      });
      await expectRefused(viaMulter, 413, ANSWER_TOO_LONG);
      expect((await logLineFor(viaMulter)).err_type, "this one was multer's refusal").toBe("LIMIT_FIELD_VALUE");
      const viaHandler = await fx.api.post(submitUrl(fx.textTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: { answer: "a".repeat(65537), gradingHash: await gradingHash(fx.textTaskId) },
      });
      await expectRefused(viaHandler, 413, ANSWER_TOO_LONG);
      // CONTROL: the same multer code on another field keeps the form sentence.
      const other = await postForm(fx.api, fx.csrf, submitUrl(fx.textTaskId),
        [field("answer", "x"), field("gradingHash", Buffer.alloc(3 * 65536 + 1, 0x6a))]);
      await expectRefused(other, 413, FIELD_VALUE);
    });

    test("fieldNameSize: a 101-byte field name is refused; a 100-byte one is admitted", async () => {
      const before = uploadsCount();
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)), field("n".repeat(101), "x")]);
      await expectRefused(r, 413, FIELD_KEY, before);
      expect((await logLineFor(r)).err_type).toBe("LIMIT_FIELD_KEY");
      const ok = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)), field("n".repeat(100), "x")]);
      await expectGradedWrong(ok, "a 100-byte field name");
      await expect.poll(uploadsCount, { timeout: 5000 }).toBe(before);
    });

    test("files: an empty-filename file part beside the answer file is refused 413, and the stored file is removed", async () => {
      const before = uploadsCount();
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)), emptyFilePart()]);
      await expectRefused(r, 413, FILE_COUNT, before);
      expect((await logLineFor(r)).err_type).toBe("LIMIT_FILE_COUNT");
    });

    test("a second file part is refused outright, before it is stored (a rejected first part does not use up the one file)", async () => {
      // multer 2.4 no longer counts a part the fileFilter skips against maxCount,
      // so [bad MIME, good] used to STORE the second file for the handler to
      // delete. `files: 1` now refuses the second part before it is written.
      const before = uploadsCount();
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId), [
        field("gradingHash", await gradingHash(fx.fileTaskId)),
        filePart("file", "first.exe", "application/x-msdownload", "MZ-not-an-answer"),
        filePart("file", "second.txt", "text/plain", "a plain answer"),
      ]);
      await expectRefused(r, 413, FILE_COUNT, before);
      await logLineFor(r);
    });

    test("a single answer file of an unsupported type is still named as such", async () => {
      // Keeps the handler's `_uploadRejected` branch locked now that the two-file
      // body above no longer reaches it.
      const before = uploadsCount();
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [field("gradingHash", await gradingHash(fx.fileTaskId)), filePart("file", "only.exe", "application/x-msdownload", "MZ")]);
      expect(r.status(), await r.text()).toBe(400);
      expect((await r.json()).error).toMatch(/^Unsupported file type/);
      await expect.poll(uploadsCount, { timeout: 5000 }).toBe(before);
    });

    test("parts: two parts busboy skips push the count past three and are refused; one is admitted", async () => {
      const before = uploadsCount();
      const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)), skippedPart(), skippedPart()]);
      await expectRefused(r, 413, PART_COUNT, before);
      expect((await logLineFor(r)).err_type).toBe("LIMIT_PART_COUNT");
      const ok = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
        [answerFile(), field("gradingHash", await gradingHash(fx.fileTaskId)), skippedPart()]);
      await expectGradedWrong(ok, "one skipped part");
      await expect.poll(uploadsCount, { timeout: 5000 }).toBe(before);
    });

    test("fieldNestingDepth: a bracketed name is refused 400, including the index that stalled the event loop", async () => {
      // `String(["<hash>"])` IS the hash, so at depth 1 the first arm was graded;
      // the second built a 100M-slot sparse array that toString() spent seconds on.
      const before = uploadsCount();
      for (const name of ["gradingHash[0]", "gradingHash[99999999]"]) {
        const r = await postForm(fx.api, fx.csrf, submitUrl(fx.fileTaskId),
          [answerFile(), field(name, await gradingHash(fx.fileTaskId))]);
        await expectRefused(r, 400, NESTING, before);
        expect((await logLineFor(r)).err_type).toBe("LIMIT_FIELD_NESTING");
      }
    });

    test("DECLARED LENGTH: a body declaring more than the form can hold is refused before a byte of it is sent", async () => {
      // The headers alone, never a body. A refusal that waited for the body (multer)
      // could not answer at all; only a gate that reads nothing can.
      const before = uploadsCount();
      const res = await rawPost(submitUrl(fx.fileTaskId),
        { "content-type": "multipart/form-data; boundary=DECLARED", "content-length": String(11 * MIB) }, null);
      expect(res.status, res.body).toBe(413);
      expect(JSON.parse(res.body).error, "an honest client gets here only by choosing too large a file").toBe(TOO_LARGE);
      // Kept alive, not closed: the body is drained, so a browser still uploading
      // it reads this answer (the drain tests below, and tests/cross-browser.spec.js).
      expect(res.headers.connection, "the connection is kept to drain the body").toBe("keep-alive");
      await expect.poll(uploadsCount, { timeout: 5000 }).toBe(before);
    });

    test("DRAIN: the refused body is read and discarded, and its connection carries the next request", async () => {
      // Firefox and WebKit report a connection reset while they are still
      // uploading as a network error, dropping the answer before it. So the gate
      // answers, then reads the rest of the body to nothing, and the connection
      // stays usable: the next request on it is parsed and answered.
      const before = uploadsCount();
      const body = Buffer.alloc(12 * MIB, 0x61);
      const conn = await openConnection();
      try {
        conn.head("POST", submitUrl(fx.fileTaskId), { "Content-Type": "multipart/form-data; boundary=DRAIN", "Content-Length": String(body.length) });
        const [refused] = await conn.awaitResponses(1, "the refusal, before any of the body is sent");
        expect(refused.status, refused.body).toBe(413);
        expect(JSON.parse(refused.body).error).toBe(TOO_LARGE);
        expect(refused.headers.connection).toBe("keep-alive");
        conn.sock.write(body);
        conn.head("GET", "/healthz");
        const both = await conn.awaitResponses(2, "the refusal, then the next request on the same connection");
        expect(both[1].status, "the whole body was drained: the next request on the connection is answered").toBe(200);
        expect(conn.closed, "the connection is kept").toBe(false);
      } finally { conn.sock.destroy(); }
      await expect.poll(uploadsCount, { timeout: 5000, message: "a drained body is never stored" }).toBe(before);
    });

    test("DRAIN, CLOSE REQUESTED: a client that asks to close writes its whole body, then reads the refusal", async () => {
      // Node closes a connection whose client asked for that (`Connection: close`,
      // or HTTP/1.0, which nginx speaks upstream by default) once the answer is
      // finished, and that close resets a body still arriving. So such a client
      // is answered after its body has drained. Each client here writes its whole
      // body at once, never waiting for an answer.
      const before = uploadsCount();
      const body = Buffer.alloc(12 * MIB, 0x61);
      const outcome = async (headers, version) => {
        const conn = await openConnection();
        try {
          conn.head("POST", submitUrl(fx.fileTaskId), { "Content-Type": "multipart/form-data; boundary=CLOSE", "Content-Length": String(body.length), ...headers }, version);
          const written = await new Promise((resolve) => conn.sock.write(body, (e) => resolve(e ? (e.code || e.message) : "all")));
          const closed = await conn.closesWithin(10000);
          const rs = conn.responses();
          return { written, closed, reset: conn.error, answers: rs.map(r => ({ status: r.status, error: JSON.parse(r.body).error, connection: r.headers.connection })) };
        } finally { conn.sock.destroy(); }
      };
      const answered = { written: "all", closed: true, reset: null, answers: [{ status: 413, error: TOO_LARGE, connection: "close" }] };
      // Run both before asserting either, so a failure shows both.
      const got = { "Connection: close": await outcome({ Connection: "close" }, "1.1"), "HTTP/1.0": await outcome({}, "1.0") };
      expect(got, "the whole body is written, the one answer is read, then the server closes without a reset")
        .toEqual({ "Connection: close": answered, "HTTP/1.0": answered });
      await expect.poll(uploadsCount, { timeout: 5000, message: "a drained body is never stored" }).toBe(before);
    });

    test("DRAIN CAP: a body declaring more than REFUSE_DRAIN_MAX_BYTES is answered and then cut; one at it is kept", async () => {
      const { REFUSE_DRAIN_MAX_BYTES } = require("../lib/http");
      // The cap is meant to sit above every body an upload route accepts, so that
      // every refusal an honest upload meets is drained. The largest is a ZIP.
      const attachSrc = stripJsComments(fs.readFileSync(path.join(ROOT, "lib", "attachments.js"), "utf8"));
      const m = attachSrc.match(/\bconst ATTACHMENT_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024;/);
      expect(m, "ATTACHMENT_MAX_BYTES is declared as N * 1024 * 1024").toBeTruthy();
      expect(REFUSE_DRAIN_MAX_BYTES, "twice the largest upload").toBe(2 * Number(m[1]) * MIB);
      const outcome = async (declared) => {
        const conn = await openConnection();
        try {
          conn.head("POST", submitUrl(fx.fileTaskId), { "Content-Type": "multipart/form-data; boundary=CAP", "Content-Length": String(declared) });
          const [r] = await conn.awaitResponses(1, `declared ${declared}`);
          expect(r.status, r.body).toBe(413);
          expect(JSON.parse(r.body).error).toBe(TOO_LARGE);
          // Nothing of the body is sent, so only the server can close it.
          return { connection: r.headers.connection, cut: await conn.closesWithin(750) };
        } finally { conn.sock.destroy(); }
      };
      expect(await outcome(REFUSE_DRAIN_MAX_BYTES + 1), "over the cap: answered, then cut").toEqual({ connection: "close", cut: true });
      expect(await outcome(REFUSE_DRAIN_MAX_BYTES), "CONTROL, at the cap: answered and kept to drain").toEqual({ connection: "keep-alive", cut: false });
    });

    test("FILE ANSWER SIZE: a file too large to fit the answer cap is refused UNREAD; one at the limit is read and graded", async () => {
      // The submit-read-delay hook counts each file the handler reads. Both
      // refusals answer the same sentence, so the counter is what tells "refused
      // unread" from "read 10 MB into memory, then refused".
      const setDelay = async (ms) => {
        const r = await fx.api.post("/api/test/submit-read-delay", { headers: H(fx.csrf), data: { delayMs: ms } });
        expect(r.ok(), `submit-read-delay: ${await r.text()}`).toBeTruthy();
      };
      const parked = async () => (await (await fx.api.get("/api/test/submit-read-delay")).json()).parked;
      const send = async (buffer) => fx.api.post(submitUrl(fx.fileTaskId), {
        headers: { "x-csrf-token": fx.csrf },
        multipart: { gradingHash: await gradingHash(fx.fileTaskId), file: { name: "answer.txt", mimeType: "text/plain", buffer } },
      });
      const before = uploadsCount();
      await setDelay(1);
      try {
        // The largest file multer accepts: through the declared-length gate and
        // multer, and refused by the handler without reading it.
        const big = await send(Buffer.alloc(10 * MIB, 0x61));
        await expectRefused(big, 413, FILE_ANSWER_TOO_LARGE, before);
        expect(await parked(), "a 10 MiB answer file was refused unread").toBe(0);
        // One byte past 3 bytes per character of the cap.
        const over = await send(Buffer.concat([Buffer.from("€".repeat(1_048_576)), Buffer.from("x")]));
        await expectRefused(over, 413, FILE_ANSWER_TOO_LARGE, before);
        expect(await parked(), "3,145,729 bytes cannot fit 1,048,576 characters, so it is not read").toBe(0);
        // CONTROL, at the boundary: 1,048,576 three-byte characters (exactly
        // 3,145,728 bytes) ARE a valid answer, so this file must be read and
        // graded. Sent once in this file, so the 3 s fold cannot catch it.
        const atCapBody = Buffer.from("€".repeat(1_048_576));
        expect(atCapBody.length).toBe(3 * 1_048_576);
        const atCap = await send(atCapBody);
        await expectGradedWrong(atCap, "a 1,048,576-character file of exactly 3,145,728 bytes");
        expect(await parked(), "the file at the limit was read").toBe(1);
        // CONTROL, the read-and-trimmed refusal still stands for a smaller file.
        const read = await send(Buffer.alloc(1_048_577, 0x61));
        await expectRefused(read, 413, FILE_ANSWER_TOO_LARGE, before);
        expect(await parked(), "a 1 MiB + 1 file is read before it is refused").toBe(2);
      } finally {
        await setDelay(0);
      }
      await expect.poll(uploadsCount, { timeout: 5000 }).toBe(before);
    });

    test("a non-string gradingHash in a JSON or form-encoded body is a missing one (409), not a 500", async () => {
      // The multipart parser cannot build these (flat names), but the same route
      // takes JSON and form-encoded bodies too, and `.toString()` threw on both.
      const cases = [
        ["JSON object with its own toString", { headers: H(fx.csrf), data: JSON.stringify({ answer: `wrong ${uniq()}`, gradingHash: { toString: 1 } }) }],
        ["JSON array nested 100,000 deep", { headers: H(fx.csrf), data: `{"answer":"w","gradingHash":${"[".repeat(100000)}${"]".repeat(100000)}}` }],
        ["form-encoded gradingHash[toString]", { headers: { "x-csrf-token": fx.csrf, "content-type": "application/x-www-form-urlencoded" }, data: `answer=wrong-${uniq()}&gradingHash[toString]=x` }],
      ];
      for (const [label, opts] of cases) {
        const r = await fx.api.post(submitUrl(fx.textTaskId), opts);
        expect(r.status(), `${label}: ${await r.text()}`).toBe(409);
        expect((await r.json()).task_changed, label).toBe(true);
      }
    });

    test("a non-string `via` on navigated-away is recorded as the default, not a 500", async () => {
      const r = await fx.api.post(`/api/tasks/${fx.textTaskId}/navigated-away`, { headers: H(fx.csrf), data: JSON.stringify({ via: { toString: 1 } }) });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).ok).toBe(true);
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = db.prepare("SELECT details FROM challenge_events WHERE task_id=? AND event_type='navigated_away' ORDER BY occurred_at DESC LIMIT 1").get(fx.textTaskId);
        expect(row, "the event was recorded").toBeTruthy();
        expect(JSON.parse(row.details).via).toBe("spa_nav");
      } finally { db.close(); }
    });

    test("UI WITNESS: the real file-answer client fits the form exactly", async ({ page }) => {
      // The only client of #ans-file. Its own participant, so the API session above
      // is not signed out by single-session; also a second non-solver enrolled.
      const p = await fx.makeParticipant(fx.admin, uniq());
      const asg = await fx.admin.api.post("/api/admin/competitions/assign", { headers: H(fx.admin.csrf), data: { userIds: [p.id], competitionIds: [fx.comp.id] } });
      expect((await asg.json()).assigned).toBe(1);
      const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
      const li = await codeLogin(page.request, p.email, H(csrfToken), { base: `${BASE}` });
      expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
      const csrf = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
      const sel = await page.request.post(`${BASE}/api/select-competition`, { headers: H(csrf), data: { competitionId: fx.comp.id } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      await page.goto(`${BASE}/`);
      await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
      const card = page.locator(`#task-grid [data-task-id="${fx.fileTaskId}"]`);
      await card.waitFor({ state: "visible", timeout: 20000 });
      await card.click();
      await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
      await expect(page.locator("#ans-file"), "the file input is rendered").toBeVisible({ timeout: 15000 });
      // Record the FormData keys the client builds, from inside the page.
      await page.evaluate(() => {
        const orig = window.fetch;
        window.__submitKeys = [];
        window.fetch = function (input, init) {
          try {
            if (init && init.body instanceof FormData && /\/submit$/.test(String(input))) window.__submitKeys.push([...init.body.keys()]);
          } catch (_) { /* recording only */ }
          return orig.apply(this, arguments);
        };
      });
      await page.locator("#ans-file").setInputFiles({ name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from(`ui wrong ${uniq()}`) });
      const respP = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(submitUrl(fx.fileTaskId)), { timeout: 20000 });
      await page.locator('[data-action="task-submit-answer"][data-mode="file"]').click();
      const modal = page.locator("#modal-overlay.open");
      await expect(modal, "the penalty warning").toBeVisible({ timeout: 10000 });
      await modal.locator("button:has-text('Submit')").first().click();
      const resp = await respP;
      await expectGradedWrong(resp, "the real client's file answer");
      const keys = await page.evaluate(() => window.__submitKeys);
      expect(keys, "exactly one submit was recorded").toHaveLength(1);
      expect([...keys[0]].sort(), "the client sends exactly `file` and `gradingHash`").toEqual(["file", "gradingHash"]);
    });
  });

  test.describe("the admin attachment uploads", () => {
    const STAGE = "/api/admin/attachment-staging";
    const zipPart = () => filePart("file", `${uniq()}.zip`, "application/zip", zipOf("a.txt", `hi ${uniq()}`));
    const discard = async (r) => {
      if (r.status() !== 200) return;
      const id = (await r.json()).staging_id;
      if (id) await fx.admin.api.delete(`${STAGE}/${id}`, { headers: H(fx.admin.csrf) });
    };
    const stage = (parts) => postForm(fx.admin.api, fx.admin.csrf, STAGE, parts);
    const counts = () => ({ uploads: uploadsCount(), staging: dirCount(STAGING) });
    async function refusedStaging(parts, status, sentence) {
      const before = counts();
      const r = await stage(parts);
      try {
        expect(r.status(), await r.text()).toBe(status);
        expect((await r.json()).error).toBe(sentence);
        await expect.poll(counts, { timeout: 5000, message: "nothing left in UPLOADS_DIR or attachments-staging" }).toEqual(before);
        await logLineFor(r);
      } finally { await discard(r); }
      return r;
    }

    test("CONTROL: a zip plus display_name stages, on both upload routes, with the exact client shape", async () => {
      const r = await stage([zipPart(), field("display_name", "a".repeat(4095))]);
      try {
        expect(r.status(), await r.text()).toBe(200);
        expect((await r.json()).display_name, "kept to 200 characters").toHaveLength(200);
      } finally { await discard(r); }
      const direct = await postForm(fx.admin.api, fx.admin.csrf, `/api/admin/tasks/${fx.fileTaskId}/attachments`, [zipPart(), field("display_name", `att ${uniq()}`)]);
      expect(direct.status(), await direct.text()).toBe(200);
    });

    test("THE REPORTED CASE: 16 MiB of junk beside a zip is refused 413, with nothing staged", async () => {
      await refusedStaging([zipPart(), ...junk(16, MIB - 1)], 413, FIELD_VALUE);
    });

    test("each limit on the attachment form refuses its case", async () => {
      // fields — no file, so `parts` cannot answer first.
      const fc = await refusedStaging([field("display_name", "x"), field("junk", "j")], 413, FIELD_COUNT);
      expect((await logLineFor(fc)).err_type).toBe("LIMIT_FIELD_COUNT");
      await refusedStaging([zipPart(), field("display_name", "a".repeat(4096))], 413, FIELD_VALUE);
      await refusedStaging([zipPart(), field("n".repeat(101), "x")], 413, FIELD_KEY);
      await refusedStaging([zipPart(), emptyFilePart()], 413, FILE_COUNT);
      await refusedStaging([zipPart(), field("display_name", "x"), skippedPart()], 413, PART_COUNT);
      await refusedStaging([zipPart(), field("display_name[0]", "x")], 400, NESTING);
      // CONTROL for `parts`: the zip and one skipped part (two parts) are admitted.
      const ok = await stage([zipPart(), skippedPart()]);
      try { expect(ok.status(), await ok.text()).toBe(200); } finally { await discard(ok); }
    });

    test("CHUNKED DRAIN: a refused chunked body is drained up to REFUSE_DRAIN_MAX_BYTES, then cut", async () => {
      // A chunked body declares nothing, so the cap is counted as it arrives. The
      // preflight refuses one before multer when the budget is gone: a planted
      // staging row of another admin fills the server-wide ceiling.
      const { REFUSE_DRAIN_MAX_BYTES } = require("../lib/http");
      const Database = require("better-sqlite3");
      const GLOBAL_CAP = 4 * 1024 * 1024 * 1024;
      const planted = require("crypto").randomUUID();
      const QUOTA = /^Server-wide upload quota exceeded/;
      const chunk = Buffer.concat([Buffer.from(`${MIB.toString(16)}\r\n`), Buffer.alloc(MIB, 0x7a), Buffer.from("\r\n")]);
      const db = new Database(TEST_DB_PATH);
      try {
        db.prepare("INSERT INTO task_attachments_staging (id, admin_id, display_name, original_name, size_bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(planted, `drain-other-${uniq()}`, "bulk", "bulk.zip", GLOBAL_CAP, "0".repeat(64), `attachments-staging/${planted}.zip`, new Date().toISOString());
      } finally { db.close(); }
      const head = { "Content-Type": "multipart/form-data; boundary=CHUNKED", "Transfer-Encoding": "chunked" };
      try {
        // The disk floor is asked before the quota (awaitUploadRoom); a chunked
        // body is reserved at multer's 64 MiB maximum.
        await awaitUploadRoom(64 * MIB);
        // CONTROL: under the cap the chunked body drains to its end and the
        // connection carries the next request.
        const kept = await openConnection(fx.admin);
        try {
          kept.head("POST", STAGE, head);
          const [r] = await kept.awaitResponses(1, "the preflight refusal");
          expect(r.status, r.body).toBe(507);
          expect(JSON.parse(r.body).error).toMatch(QUOTA);
          for (let i = 0; i < 2; i++) kept.sock.write(chunk);
          kept.sock.write("0\r\n\r\n");
          kept.head("GET", "/healthz");
          const both = await kept.awaitResponses(2, "the refusal, then the next request");
          expect(both[1].status, "a 2 MiB chunked body was drained").toBe(200);
          expect(kept.closed).toBe(false);
        } finally { kept.sock.destroy(); }

        // Past the cap the connection is cut, after the answer: a kept-alive client
        // has had it from the start, one that asked to close gets it as the cap
        // passes. Each streams without waiting until the server cuts it.
        //
        // WHAT THE SERVER SENT is read from its access log, written on the
        // response's "finish" — the same event the cut waits for, so a line with
        // the 507 proves it was answered before the cut. The CLIENT may not get to
        // read an answer sent as the cap passes: it is still sending, so the cut
        // makes its TCP stack answer with a reset, which can discard the response
        // before it is read (RFC 7230 §6.6). That is the cut CLAUDE.md records as an
        // open gap, and asserting the client read it flaked on exactly that race.
        const streamUntilCut = async (extra) => {
          const conn = await openConnection(fx.admin);
          const probe = uniq();
          let sent = 0;
          try {
            conn.head("POST", `${STAGE}?drain=${probe}`, { ...head, ...extra });
            const stopAt = REFUSE_DRAIN_MAX_BYTES + 32 * MIB;
            while (!conn.closed && !conn.error && sent < stopAt) {
              if (!conn.sock.write(chunk)) {
                await new Promise((resolve) => {
                  const done = () => { conn.sock.off("drain", done); conn.sock.off("close", done); resolve(); };
                  conn.sock.on("drain", done); conn.sock.on("close", done);
                });
              }
              sent += MIB;
            }
            const cut = await conn.closesWithin(5000);
            const answers = conn.responses().map(r => ({ status: r.status, connection: r.headers.connection, quota: QUOTA.test(JSON.parse(r.body).error) }));
            const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"), (j) => typeof j.path === "string" && j.path.includes(`drain=${probe}`),
              { prefix: "access-", what: `the access line for the drain probe ${probe}` });
            return { cut, answers, sent, served: line.status, read: sent > REFUSE_DRAIN_MAX_BYTES && sent < stopAt ? "past the cap, then cut" : `${sent} bytes, error ${conn.error}` };
          } finally { conn.sock.destroy(); }
        };
        const got = { keptAlive: await streamUntilCut({}), askedToClose: await streamUntilCut({ Connection: "close" }) };
        for (const g of Object.values(got)) delete g.sent;
        // The client that asked to close read the answer, or lost it to the reset;
        // never a different one, and the server sent it either way (`served`).
        const closeAnswer = [{ status: 507, connection: "close", quota: true }];
        expect(got.askedToClose.answers.length === 0 ? [] : closeAnswer, JSON.stringify(got.askedToClose)).toEqual(got.askedToClose.answers);
        got.askedToClose.answers = got.askedToClose.answers.length ? "read" : "lost to the reset";
        expect(got, "each is answered, and cut only once REFUSE_DRAIN_MAX_BYTES has been read").toEqual({
          keptAlive: { cut: true, served: 507, answers: [{ status: 507, connection: "keep-alive", quota: true }], read: "past the cap, then cut" },
          askedToClose: { cut: true, served: 507, answers: expect.stringMatching(/^(read|lost to the reset)$/), read: "past the cap, then cut" },
        });
      } finally {
        const dbC = new Database(TEST_DB_PATH);
        try { dbC.prepare("DELETE FROM task_attachments_staging WHERE id=?").run(planted); } finally { dbC.close(); }
      }
    });

    test("a non-string display_name on either rename is refused 400, not a 500", async () => {
      const staged = await stage([zipPart(), field("display_name", `st ${uniq()}`)]);
      expect(staged.status(), await staged.text()).toBe(200);
      const stagingId = (await staged.json()).staging_id;
      try {
        const bad = await fx.admin.api.patch(`${STAGE}/${stagingId}`, { headers: H(fx.admin.csrf), data: JSON.stringify({ display_name: { toString: 1 } }) });
        expect(bad.status(), await bad.text()).toBe(400);
        expect((await bad.json()).error).toBe("Display name must be text.");
        const good = await fx.admin.api.patch(`${STAGE}/${stagingId}`, { headers: H(fx.admin.csrf), data: { display_name: `renamed ${uniq()}` } });
        expect(good.status(), await good.text()).toBe(200);
      } finally {
        await fx.admin.api.delete(`${STAGE}/${stagingId}`, { headers: H(fx.admin.csrf) });
      }
      const att = await postForm(fx.admin.api, fx.admin.csrf, `/api/admin/tasks/${fx.fileTaskId}/attachments`, [zipPart(), field("display_name", `att ${uniq()}`)]);
      expect(att.status(), await att.text()).toBe(200);
      const aid = (await att.json()).id;
      const url = `/api/admin/tasks/${fx.fileTaskId}/attachments/${aid}`;
      const bad = await fx.admin.api.patch(url, { headers: H(fx.admin.csrf), data: JSON.stringify({ display_name: { toString: 1 } }) });
      expect(bad.status(), await bad.text()).toBe(400);
      expect((await bad.json()).error).toBe("Display name must be text.");
      const good = await fx.admin.api.patch(url, { headers: H(fx.admin.csrf), data: { display_name: `renamed ${uniq()}` } });
      expect(good.status(), await good.text()).toBe(200);
    });

    test("a non-string staged display_name on a challenge create or save is refused 400, not a 500", async () => {
      const ids = [];
      try {
        for (let i = 0; i < 2; i++) {
          const s = await stage([zipPart(), field("display_name", `sv ${uniq()}`)]);
          expect(s.status(), await s.text()).toBe(200);
          ids.push((await s.json()).staging_id);
        }
        const staged = (id, display_name) => ({ staging_attachments: [{ staging_id: id, display_name }] });
        const newTask = () => ({ title: `${uniq()} Staged`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "x" });
        const create = (body) => fx.admin.api.post("/api/admin/tasks", { headers: H(fx.admin.csrf), data: JSON.stringify(body) });
        const save = (body) => fx.admin.api.put(`/api/admin/tasks/${fx.fileTaskId}`, { headers: H(fx.admin.csrf), data: JSON.stringify(body) });
        for (const [label, r] of [["create", await create({ ...newTask(), ...staged(ids[0], { toString: 1 }) })], ["save", await save(staged(ids[1], { toString: 1 }))]]) {
          expect(r.status(), `${label}: ${await r.text()}`).toBe(400);
          expect((await r.json()).error, label).toBe("Invalid staging_attachments entry.");
        }
        // CONTROLS: the same staged rows under a text name are promoted, by name.
        const createdName = `created ${uniq()}`;
        const c = await create({ ...newTask(), ...staged(ids[0], createdName) });
        expect(c.status(), await c.text()).toBe(200);
        const createdList = await (await fx.admin.api.get(`/api/admin/tasks/${(await c.json()).id}/attachments`)).json();
        expect(createdList.map(a => a.display_name)).toEqual([createdName]);
        const savedName = `saved ${uniq()}`;
        const s = await save(staged(ids[1], savedName));
        expect(s.status(), await s.text()).toBe(200);
        const savedList = await (await fx.admin.api.get(`/api/admin/tasks/${fx.fileTaskId}/attachments`)).json();
        expect(savedList.map(a => a.display_name)).toContain(savedName);
        ids.length = 0;
      } finally {
        for (const id of ids) await fx.admin.api.delete(`${STAGE}/${id}`, { headers: H(fx.admin.csrf) });
      }
    });
  });

  test("a non-number rating is refused 400, not a 500; a number or numeric string is saved", async () => {
    const url = `/api/tasks/${fx.textTaskId}/feedback`;
    const cases = [
      ["JSON object with its own toString", { headers: H(fx.csrf), data: JSON.stringify({ rating: { toString: 1 } }) }],
      ["form-encoded rating[toString]", { headers: { "x-csrf-token": fx.csrf, "content-type": "application/x-www-form-urlencoded" }, data: "rating[toString]=x" }],
    ];
    for (const [label, opts] of cases) {
      const r = await fx.api.put(url, opts);
      expect(r.status(), `${label}: ${await r.text()}`).toBe(400);
      expect((await r.json()).error, label).toBe("Rating must be 1-5");
    }
    for (const [sent, saved] of [[4, 4], ["3", 3]]) {
      const r = await fx.api.put(url, { headers: H(fx.csrf), data: { rating: sent } });
      expect(r.status(), `rating ${JSON.stringify(sent)}: ${await r.text()}`).toBe(200);
      expect((await r.json()).rating).toBe(saved);
    }
  });

  test("a non-string unsubscribe token is an invalid one (400), not a 500", async () => {
    // Anonymous. The form parser builds an object from `token[toString]=x`.
    const anon = await freshCtx();
    try {
      const form = await anon.api.post("/api/unsubscribe", { headers: { "content-type": "application/x-www-form-urlencoded" }, data: "token[toString]=x" });
      expect(form.status(), await form.text()).toBe(400);
      expect(await form.text()).toContain("This link is no longer valid");
      const json = await anon.api.post("/api/unsubscribe", { headers: { "content-type": "application/json" }, data: JSON.stringify({ token: { toString: 1 } }) });
      expect(json.status(), await json.text()).toBe(400);
      expect((await json.json()).error).toBe("Invalid or expired unsubscribe token.");
    } finally { await anon.api.dispose(); }
  });
});
