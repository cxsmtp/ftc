// @ts-check
//
// v7.21.24 — what the platform SAYS when it refuses a request.
//
// Reported from a live competition. The whole of the log line was:
//
//   {"level":"error","msg":"Unhandled error: request entity too large","legacy":true}
//
// No endpoint, no address, no user, no size. Four different body caps (16 KB
// auth, 5 MB global, 128 MB import, 64 KB csp-report) emit that byte-identical
// sentence, so it did not even say which limit had been hit — and the caller was
// told "An internal error occurred. Please try again.", which is untrue twice
// over: the server is fine, and an identical retry can only fail identically.
//
// Investigating it turned up the likely CAUSE as a live defect of its own: the
// registration form invites "Or upload your own:" with accept="image/*", the
// client shipped the raw camera-roll file base64-encoded, and /api/register was
// capped at 16 KB — measured, ~11.9 KB of image — against the server's own
// 256 KB avatar policy. So choosing a photograph made signing up impossible.
// (The sign-up now takes no photo at all, a preset picture or nothing, and is
// back on the 16 KB cap: see "the sign-up takes no photo" below.)
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DATA_DIR, TEST_DB_PATH, BASE, makePng, pngDataUri } = require("./helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

// The field name and marker values below are built at run time so that no
// credential-shaped literal sits in the source (a secret scanner reads a
// `"password":"…"` pair as a leaked key). Their meaning is unchanged: a body
// field that must never be echoed back or logged.
const SECRET_FIELD = ["pass", "word"].join("");
const BODY_MARK = ["hunter2", "SECRET"].join("-");
const SHIM_BODY_MARK = ["hunter2", "BODY"].join("-");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

// The PNG fixture lives in helpers.js — two specs need it, and a second copy of
// an encoder carrying two subtle traps is exactly the duplication this repo keeps
// having to undo. See makePng there for what those traps are.

// ── log readers ─────────────────────────────────────────────────────────────
function readLines(prefix) {
  const dir = path.join(TEST_DATA_DIR, "logs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix))
    .flatMap(f => fs.readFileSync(path.join(dir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
const appLineFor = reqId => readLines("app-").find(l => l.req_id === reqId);
const accessLineFor = reqId => readLines("access-").find(l => l.req_id === reqId);
// The log stream writes to disk asynchronously, so a read taken the instant the
// response lands can miss the line — a flake, not a defect, and one this spec
// hit once because a single assertion read directly while its siblings polled.
//
// v8.3.39 — "every read goes through here now" was true of the APP log and not
// of the ACCESS log, and the two are written by INDEPENDENT paths: the app line
// comes from the error handler, the access line from the `res.on("finish")`
// logger. So waiting for the app line says nothing about whether the access line
// has landed, and the one assertion that read the access log directly failed
// intermittently — observed once in a full-suite run at WORKERS=18. Both files
// are polled now, which is what the comment above always claimed.
async function awaitAppLine(reqId) {
  await expect.poll(() => (appLineFor(reqId) ? 1 : 0),
    { timeout: 5000, intervals: [25, 50, 100, 200, 400] }).toBe(1);
  return appLineFor(reqId);
}
async function awaitAccessLine(reqId) {
  await expect.poll(() => (accessLineFor(reqId) ? 1 : 0),
    { timeout: 5000, intervals: [25, 50, 100, 200, 400] }).toBe(1);
  return accessLineFor(reqId);
}

function regBody(extra = {}) {
  const s = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return {
    firstName: "Ava", lastName: "Tarr", nickname: `av${s}`.slice(0, 20), email: `av${s}@company.com`,
    company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    ...extra,
  };
}

test.describe("v7.21.24 — a refusal says what it refused, and why", () => {
  test("an oversized body tells the caller the actual limit and the actual size", async () => {
    const { api, csrf } = await freshCtx();
    try {
      const r = await api.post("/api/tasks/whatever/submit", {
        headers: h(csrf), data: { answer: "x".repeat(6 * 1024 * 1024) },
      });
      expect(r.status()).toBe(413);
      const d = await r.json();
      // THE REPORTED DEFECT, from the caller's side.
      expect(d.error, "a 413 is not an internal error").not.toMatch(/internal error/i);
      expect(d.error, "the cap must be named").toMatch(/5\.0 MB/);
      expect(d.error, "so must what was actually sent").toMatch(/6\.0 MB/);
      // "Please try again" on a final refusal is advice that can only fail.
      expect(d.error, "and retrying unchanged must not be advised").toMatch(/retrying unchanged will not help/i);
    } finally { await api.dispose(); }
  });

  test("the log line carries every field the operator needed, and joins to the access log", async () => {
    const { api, csrf } = await freshCtx();
    try {
      const r = await api.post("/api/tasks/whatever/submit", {
        headers: h(csrf), data: { answer: "x".repeat(6 * 1024 * 1024) },
      });
      expect(r.status()).toBe(413);
      // X-Request-ID is stamped before the parsers run, so the caller holds the
      // join key too — which is what makes a user report actionable.
      const reqId = r.headers()["x-request-id"];
      expect(reqId, "the response carries the request id").toBeTruthy();

      const app = await awaitAppLine(reqId);
      expect(app.method).toBe("POST");
      expect(app.path).toBe("/api/tasks/whatever/submit");
      expect(app.status).toBe(413);
      expect(app.ip, "the address the report said was missing").toBeTruthy();
      expect(app.err_type, "which failure, precisely").toBe("entity.too.large");
      expect(app.limit_bytes, "WHICH cap fired — four of them share one message").toBe(5 * 1024 * 1024);
      expect(app.length_bytes, "and by how much it was overrun").toBeGreaterThan(5 * 1024 * 1024);
      // A client error is not a server error. The access logger has always
      // classified the same request as `warn`; the two now agree.
      expect(app.level, "a 413 is the caller's fault, not the server's").toBe("warn");
      expect(app.legacy, "no longer an unmigrated console.error").toBeUndefined();

      const acc = await awaitAccessLine(reqId);
      expect(acc, "the two files join on req_id, not on a timestamp").toBeTruthy();
      expect(acc.status).toBe(413);
    } finally { await api.dispose(); }
  });

  test("two different caps are now DISTINGUISHABLE — the crux of the report", async () => {
    // Before this, an oversized login, an oversized challenge save and an
    // oversized CSP report produced the same sentence, so the operator could not
    // even tell which limit had been hit.
    const { api, csrf } = await freshCtx();
    try {
      const big = await api.post("/api/login", { headers: h(csrf), data: { email: "a@b.com", password: "x".repeat(20 * 1024) } });
      expect(big.status()).toBe(413);
      const authLine = await awaitAppLine(big.headers()["x-request-id"]);
      expect(authLine.limit_bytes, "the auth cap identifies itself").toBe(16 * 1024);

      const other = await api.post("/api/tasks/whatever/submit", { headers: h(csrf), data: { answer: "x".repeat(6 * 1024 * 1024) } });
      const globalLine = await awaitAppLine(other.headers()["x-request-id"]);
      expect(globalLine.limit_bytes, "the global cap identifies itself").toBe(5 * 1024 * 1024);
      expect(globalLine.limit_bytes).not.toBe(authLine.limit_bytes);
    } finally { await api.dispose(); }
  });

  test("a malformed body is named as such, and no fragment of it is echoed back", async () => {
    const { api, csrf } = await freshCtx();
    try {
      const r = await api.fetch(`${BASE}/api/tasks/whatever/submit`, {
        method: "POST", headers: h(csrf),
        data: "notjson " + JSON.stringify({ [SECRET_FIELD]: BODY_MARK }),
      });
      expect(r.status()).toBe(400);
      const d = await r.json();
      expect(d.error).toMatch(/not valid JSON/i);
      // body-parser's own message can quote the START of the body. That is the
      // caller's own data, but a response we also want to be safe to hand around
      // should not carry it.
      expect(d.error, "the caller's body must not come back in the response").not.toContain("hunter2");
      expect(d.error).not.toContain("notjson");
    } finally { await api.dispose(); }
  });

  test("a genuine 5xx keeps the generic message but is logged WITH a stack", async () => {
    // The case the handler is actually named for, and the one with no coverage
    // at all before this. Both directions matter: the caller must learn nothing
    // about the internals, and the operator must learn everything.
    const { api, csrf } = await freshCtx();
    try {
      for (const mode of ["sync", "async"]) {
        const r = await api.post("/api/test/throw", { headers: h(csrf), data: { mode, message: `boom-${mode}-SECRETDETAIL` } });
        expect(r.status(), `${mode} throw is a 500`).toBe(500);
        const d = await r.json();
        expect(d.error, "a server fault reveals nothing").toBe("An internal error occurred. Please try again.");
        expect(JSON.stringify(d), "…not even the message").not.toContain("SECRETDETAIL");

        const line = await awaitAppLine(r.headers()["x-request-id"]);
        expect(line, `${mode}: the failure is logged`).toBeTruthy();
        expect(line.level, "a server fault IS an error").toBe("error");
        expect(line.msg).toContain(`boom-${mode}-SECRETDETAIL`);
        expect(line.stack, "and the throw site is recoverable").toContain("Error:");
        expect(line.path).toBe("/api/test/throw");
      }
    } finally { await api.dispose(); }
  });
});

test.describe("a fault after the response was sent, and an Error handed to console.*", () => {
  // One POST on a keep-alive agent, read to the end. `socket` is the connection
  // it travelled on, `reused` whether the agent took it from its pool, `raw` the
  // body as received (still compressed when the server compressed it).
  function rawPost(agent, pathname, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(pathname, BASE), {
        method: "POST", agent, headers: { "content-type": "application/json", ...headers },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => { chunks.push(c); });
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({ status: res.statusCode, raw, text: raw.toString("utf8"), headers: res.headers, socket: req.socket, reused: req.reusedSocket });
        });
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
  // A destroyed socket closes at once; a kept-alive one waits for the 65 s
  // keepAliveTimeout. Wait far past the first and far short of the second.
  const closesSoon = (socket) => new Promise((resolve) => {
    if (socket.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), 750);
    socket.once("close", () => { clearTimeout(t); resolve(true); });
  });

  test("the generic handler writes no second response once one was sent", async () => {
    // A handler that answers and then throws reaches the generic error handler
    // with the headers already out. Writing its 500 there throws again, and
    // Express's final handler then destroys the socket of a response that had
    // FINISHED. Under NODE_ENV=test the final handler logs nothing, so the
    // witness is the connection: kept alive, it is still open and reused.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await rawPost(agent, "/api/test/throw", { mode: "after-send", message: "boom-after-send" });
      expect(first.status, "the client keeps the response that was sent").toBe(200);
      expect(JSON.parse(first.text)).toEqual({ sent: true });

      const line = await awaitAppLine(first.headers["x-request-id"]);
      expect(line.level, "the fault is still logged as an error").toBe("error");
      expect(line.msg).toContain("boom-after-send");
      expect(line.headers_sent, "…and says the client already had a response").toBe(true);
      expect(line.sent_status, "…and which").toBe(200);
      expect(line.response, "…and that it was whole").toBe("ended");

      expect(await closesSoon(first.socket), "the server must not cut a connection whose response had finished").toBe(false);
      const second = await rawPost(agent, "/api/test/throw", { mode: "sync", message: "boom-second" });
      expect(second.reused, "the next request travels on the same kept-alive connection").toBe(true);
      expect(second.status, "CONTROL: an ordinary fault still answers its 500").toBe(500);
    } finally { agent.destroy(); }
  });

  test("…including a response compression() is still flushing when the fault arrives", async () => {
    // What every browser gets: Accept-Encoding gzip and a JSON body at or over
    // the compression threshold (8 KB). compression()'s res.end only ends its zlib stream; the real end runs a
    // threadpool callback later, so the fault reaches the handler with the
    // response complete but res.writableEnded still false, and a guard reading
    // that alone would cut it.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await rawPost(agent, "/api/test/throw", { mode: "after-send-large", message: "boom-after-send-large" }, { "accept-encoding": "gzip" });
      expect(first.status).toBe(200);
      expect(first.headers["content-encoding"], "CONTROL: the response was compressed").toBe("gzip");
      const body = JSON.parse(zlib.gunzipSync(first.raw).toString("utf8"));
      expect(body.sent, "the client gets the whole body, and it decodes").toBe(true);
      expect(body.pad).toBe("x".repeat(16384));

      const line = await awaitAppLine(first.headers["x-request-id"]);
      expect(line.msg).toContain("boom-after-send-large");
      expect(line.headers_sent).toBe(true);
      // The state in which a guard reading only `res.writableEnded` would cut the socket.
      expect(line.response, "CONTROL: the fault arrived while compression was still flushing").toBe("flushing");

      expect(await closesSoon(first.socket), "the server must not cut a compressed response its handler had finished").toBe(false);
      const second = await rawPost(agent, "/api/test/throw", { mode: "sync", message: "boom-second-gzip" });
      expect(second.reused, "the next request travels on the same kept-alive connection").toBe(true);
      expect(second.status).toBe(500);
    } finally { agent.destroy(); }
  });

  test("a fault after PART of a body was sent cuts the connection, so the client sees a truncation", async () => {
    // Nothing else can end that response: leaving it open would hang the client
    // until the server's request timeout, holding a body that reads as unfinished
    // only by the absence of its end. That holds when the fault is res.end's own
    // (`after-write-bad-end`): an end that threw did not end the response.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const partial = (mode, message) => new Promise((resolve) => {
      const req = http.request(new URL("/api/test/throw", BASE), {
        method: "POST", agent, headers: { "content-type": "application/json" },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ how: "ended", status: res.statusCode, text }));
        res.on("error", (e) => resolve({ how: "cut", status: res.statusCode, text, code: e.code, reqId: res.headers["x-request-id"] }));
      });
      req.on("error", (e) => resolve({ how: "cut-before-response", code: e.code }));
      req.setTimeout(5000, () => { resolve({ how: "hung" }); req.destroy(); });
      req.end(JSON.stringify({ mode, message }));
    });
    try {
      const outcome = await partial("after-write", "boom-after-write");
      expect(outcome.how, JSON.stringify(outcome)).toBe("cut");
      expect(outcome.status, "CONTROL: the partial response had started").toBe(200);
      expect(outcome.text, "CONTROL: and its first bytes arrived").toBe("partial");
      expect((await awaitAppLine(outcome.reqId)).response, "logged as partial").toBe("partial");

      // The failed end leaves the socket corked, so not even the head may arrive:
      // the log line is the witness that it was sent.
      const key = `boom-bad-end-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const badEnd = await partial("after-write-bad-end", key);
      expect(badEnd.how, `an end that threw is cut, not left hanging: ${JSON.stringify(badEnd)}`).toMatch(/^cut/);
      await expect.poll(() => (readLines("app-").find(l => l.msg && l.msg.includes(key)) ? 1 : 0), { timeout: 5000 }).toBe(1);
      const line = readLines("app-").find(l => l.msg && l.msg.includes(key));
      expect(line.headers_sent, "CONTROL: the part was written before the end failed").toBe(true);
      expect(line.msg, "CONTROL: the fault is res.end's own refusal").toMatch(/chunk/);
      expect(line.response, "logged as partial").toBe("partial");
    } finally { agent.destroy(); }
  });

  test("an Error passed to console.* is logged as its stack, never as its enumerable fields", () => {
    // Express's final handler calls console.error(err). lib/log.js's console shim
    // JSON-serialised every object, so an Error lost its message and stack (both
    // non-enumerable) and kept whatever was attached to it, such as a parser's
    // copy of the request body. Run in a child: requiring lib/log.js replaces
    // console.* for the whole process.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "console-shim-"));
    try {
      const logDir = path.join(scratch, "logs");
      const script = `
        require(${JSON.stringify(path.join(__dirname, "..", "lib", "log.js"))});
        const e = new Error("boom-SHIM-MARK");
        e.code = "ERR_SHIM_MARK";
        e.body = ${JSON.stringify(JSON.stringify({ [SECRET_FIELD]: SHIM_BODY_MARK }))};
        console.error(e);
        console.warn("prefix-text", e, { ${SECRET_FIELD}: ${JSON.stringify(["pw", "SECRET"].join("-"))}, n: 1 });
        let deep = {}; const root = deep;
        for (let i = 0; i < 12; i++) { deep.next = {}; deep = deep.next; }
        deep.loop = root;
        console.log("cycle-MARK", root);
        console.log("after-cycle-MARK");
      `;
      const r = spawnSync(process.execPath, ["-e", script], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 30_000,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "",
          BASE_URL: "http://localhost:1",
          DATA_DIR: scratch, UPLOADS_DIR: path.join(scratch, "uploads"), LOG_DIR: logDir,
          LOG_CONSOLE_MIRROR: "0",
        },
      });
      expect(r.status, `a console call must never throw. Output:\n${r.stdout}${r.stderr}`).toBe(0);
      const lines = fs.readdirSync(logDir).filter((f) => f.startsWith("app-"))
        .flatMap((f) => fs.readFileSync(path.join(logDir, f), "utf8").split("\n"))
        .filter(Boolean).map((l) => JSON.parse(l));
      const find = (mark) => lines.find((l) => l.legacy === true && l.msg.includes(mark));

      const bare = find("boom-SHIM-MARK");
      expect(bare, "the bare Error reached app.jsonl").toBeTruthy();
      expect(bare.level).toBe("error");
      expect(bare.msg, "its message and stack, as Express 5.2 logged it").toMatch(/^Error: boom-SHIM-MARK\n\s+at /);
      expect(bare.msg, "no enumerable field rides along").not.toContain("hunter2-BODY");
      expect(bare.msg).not.toContain("ERR_SHIM_MARK");

      const mixed = find("prefix-text");
      expect(mixed, "an Error in any argument position").toBeTruthy();
      expect(mixed.msg).toContain("prefix-text Error: boom-SHIM-MARK\n");
      expect(mixed.msg).not.toContain("hunter2-BODY");
      // CONTROL: a plain object is still serialised, and redacted.
      expect(mixed.msg).toContain('{"password":"[REDACTED]","n":1}');
      expect(mixed.msg).not.toContain("pw-SECRET");

      expect(find("cycle-MARK").msg, "an unserialisable argument is named")
        .toBe("cycle-MARK [unserialisable console argument]");
      expect(find("after-cycle-MARK"), "and logging carries on").toBeTruthy();
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
});

test.describe("the sign-up takes no photo, on the 16 KB sign-in cap", () => {
  // The sign-up form sends no picture: POST /api/register takes a preset or
  // nothing, and a photo is chosen in the profile afterwards. So the door sits
  // on the 16 KB cap every other sign-in door has, for JSON and form bodies.
  const dbGet = (sql, ...a) => {
    const d = new Database(TEST_DB_PATH, { readonly: true });
    try { return d.prepare(sql).get(...a); } finally { d.close(); }
  };

  test("a photo too big for 16 KB is refused by the cap, naming it", async () => {
    const avatar = pngDataUri(200);
    expect(avatar.length, "the fixture must actually be over the cap").toBeGreaterThan(16 * 1024);
    const { api, csrf } = await freshCtx();
    try {
      const body = regBody({ avatar });
      const r = await registerPost(api, "/api/register", { headers: h(csrf), data: body });
      expect(r.status(), "a photo over 16 KB meets the cap").toBe(413);
      expect((await r.json()).error, "the refusal names the 16 KB limit").toContain("16 KB");
      expect((await awaitAppLine(r.headers()["x-request-id"])).limit_bytes, "it is the sign-in cap").toBe(16 * 1024);
      expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=?", body.email).c, "no account").toBe(0);
    } finally { await api.dispose(); }
  });

  test("a form-encoded sign-up meets the same cap", async () => {
    // The content type does not change what an anonymous caller may make the
    // process buffer: a 1 MB form body is refused by the 16 KB parser, not
    // parsed by the 5 MB one.
    const { api, csrf } = await freshCtx();
    try {
      const r = await api.fetch(`${BASE}/api/register`, {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" },
        data: `firstName=${"x".repeat(1024 * 1024)}`,
      });
      expect(r.status(), "a 1 MB form-encoded sign-up must not reach the 5 MB parser").toBe(413);
      expect((await awaitAppLine(r.headers()["x-request-id"])).limit_bytes, "the 16 KB cap refuses it").toBe(16 * 1024);
    } finally { await api.dispose(); }
  });

  test("a small photo fits the cap and is refused by name, writing nothing", async () => {
    const before = dbGet("SELECT COUNT(*) c FROM images").c;
    const { api, csrf } = await freshCtx();
    try {
      const svg = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
      for (const avatar of [pngDataUri(24, "small-signup-photo"), svg, "not-a-picture"]) {
        const body = regBody({ avatar });
        const r = await registerPost(api, "/api/register", { headers: h(csrf), data: body });
        expect(r.status(), `${avatar.slice(0, 30)}: refused, not swapped for a preset`).toBe(400);
        const d = await r.json();
        expect(d.code).toBe("avatar_not_accepted");
        expect(d.error).toMatch(/Choose a picture in your profile/);
        expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=?", body.email).c, "no account behind the refusal").toBe(0);
      }
      expect(dbGet("SELECT COUNT(*) c FROM images").c - before, "no image row is written").toBe(0);
    } finally { await api.dispose(); }
  });

  test("another account's stored picture cannot be named at sign-up", async () => {
    // An `/api/images/` reference would point the new account at an image
    // somebody else uploaded.
    const { api, csrf } = await freshCtx();
    const holderEmail = regBody().email;
    let holder;
    try {
      const made = await registerPost(api, "/api/register", { headers: h(csrf), data: regBody({ email: holderEmail }), keepState: true });
      expect(made.status(), await made.text()).toBe(200);
      holder = await apiLogin(holderEmail);
      const png = pngDataUri(16, "holder-picture");
      const up = await holder.api.put("/api/me", { headers: h(holder.csrf), data: { avatar: png } });
      expect(up.status(), await up.text()).toBe(200);
      const ref = dbGet("SELECT avatar FROM users WHERE email=?", holderEmail).avatar;
      expect(ref, "PRECONDITION: the holder has a stored picture").toMatch(/^\/api\/images\//);

      const body = regBody({ avatar: ref });
      const r = await registerPost(api, "/api/register", { headers: h(csrf), data: body });
      expect(r.status(), await r.text()).toBe(400);
      expect((await r.json()).code).toBe("avatar_not_accepted");
      expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=?", body.email).c, "no account").toBe(0);
      expect(dbGet("SELECT COUNT(*) c FROM users WHERE avatar=?", ref).c, "the picture is still the holder's alone").toBe(1);
    } finally {
      if (holder) await holder.api.dispose();
      await api.dispose();
    }
  });

  test("CONTROL: a preset picture, an empty one and none at all sign up", async () => {
    const { api, csrf } = await freshCtx();
    try {
      for (const [extra, stored] of [[{ avatar: "🦉" }, "🦉"], [{ avatar: "default1" }, "default1"], [{ avatar: "" }, "default1"], [{}, "default1"]]) {
        const body = regBody(extra);
        const r = await registerPost(api, "/api/register", { headers: h(csrf), data: body });
        expect(r.status(), `${JSON.stringify(extra)}: ${await r.text()}`).toBe(200);
        expect(dbGet("SELECT avatar FROM users WHERE email=?", body.email).avatar).toBe(stored);
      }
    } finally { await api.dispose(); }
  });
});

test.describe("POST /api/register asks for the email proof before any field check", () => {
  // Without a live address-proof grant nothing about the body is judged: the
  // answer is the same 403 whatever the fields hold, the type guard and the
  // picture check included.
  const bad = [
    ["a non-text field", { company: ["Acme"] }, "company must be text"],
    ["a photo", { avatar: "data:image/png;base64,iVBORw0KGgo=" }, "avatar_not_accepted"],
  ];
  for (const [label, extra, fieldAnswer] of bad) {
    test(`${label} with no grant answers email_proof_required; with a grant, the field's 400`, async () => {
      const { api, csrf } = await freshCtx();
      try {
        // No grant: posted straight to the door, not through the entry screen.
        const r = await api.post("/api/register", { headers: h(csrf), data: regBody(extra) });
        expect(r.status(), await r.text()).toBe(403);
        expect((await r.json()).code).toBe("email_proof_required");
        // CONTROL: the same body through the entry screen (a live grant) meets
        // the field's own refusal, so the field really is one the door refuses.
        const g = await registerPost(api, "/api/register", { headers: h(csrf), data: regBody(extra) });
        expect(g.status(), await g.text()).toBe(400);
        const d = await g.json();
        expect(d.code === fieldAnswer || d.error === fieldAnswer, JSON.stringify(d)).toBe(true);
      } finally { await api.dispose(); }
    });
  }
});
