// @ts-check
//
// v8.13.3 — A BODY IS ALWAYS AN OBJECT, AND ONE NO PARSER READ IS REFUSED BY NAME.
//
// Two halves of one defect class (unit body-undefined-500):
//
// (A) body-parser 2 leaves `req.body` UNDEFINED when no parser consumed the
//     request — a body-less POST, or one whose content type no parser handles.
//     Express 4 had always handed handlers `{}`, and ~140 handlers still
//     destructure `req.body` as though that were true, so every one of them
//     answered a body-less request with a TypeError and a generic 500 — including
//     /api/login, before the credential was even looked at. server.js now presets
//     `req.body = {}` for POST/PUT/PATCH/DELETE immediately below the global
//     parsers (and above every mutating route but /api/csp-report, which carries
//     its own parser), so each handler gives its own named 400 for a missing field.
//
// (B) The preset alone would turn a `text/plain` payload — which no parser reads —
//     into a silent no-op: the handler sees `{}` and answers "missing field", or
//     worse, a 200 that did nothing. So `csrfProtection` (lib/middleware.js) now
//     refuses, AFTER the CSRF check, a non-empty payload whose type no parser on
//     that route handles: 415 `unsupported_media_type`. ROUTE-AWARE: multipart is
//     allowed exactly on the routes whose own stack carries multer, which runs
//     after csrfProtection on all three upload routes. And a top-level JSON ARRAY
//     — which the JSON parser does accept — is 400 `body_not_object`, because
//     every handler reads an object and `Object.keys([...])` / `[].email` answer
//     quietly wrong.
//
// Also here: a malformed multipart body (busboy errors carry no status, so they
// were 500s) is a 400; and POST /api/unsubscribe's form body is capped at the
// public-form 16 KB on both parsers (its own 8 KB route parser was dead — the
// global 5 MB parser had always consumed the stream first).
const { test, expect, request } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, TEST_DB_PATH, TEST_DATA_DIR, PARTICIPANT_PASS, apiLogin, zipOf, findLogLine } = require("./helpers");
const { H, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOGS = path.join(TEST_DATA_DIR, "logs");
const { hostname: HOST, port: PORT } = new URL(BASE);
const UNSUPPORTED = "unsupported_media_type";

const rowOf = (sql, ...args) => {
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
};

// A request whose headers and bytes we write ourselves (a body-less POST with no
// Content-Type at all, or a deliberately broken multipart body).
function raw(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* html or empty */ }
        resolve({ status: res.statusCode, id: res.headers["x-request-id"], body: data, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test.describe("v8.13.3 — request body shape", () => {
  /** @type {any} */ let sa, saCsrf, comp, p, pApi, pCsrf, pCookie;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "bodyshape");
    p = await makeParticipant(sa, saCsrf, "bodyshape");
    await enrol(sa, saCsrf, comp.id, [p.id]);
    ({ api: pApi, csrf: pCsrf } = await apiLogin(p.email, PARTICIPANT_PASS));
    const st = await pApi.storageState();
    pCookie = st.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  });

  // ── (A) body-less requests reach the handler as `{}` ───────────────────────

  test("(A) a body-less POST gets the handler's own 400, not a 500 — participant routes", async () => {
    const hdr = { "x-csrf-token": pCsrf, cookie: pCookie };
    const sel = await raw("POST", "/api/select-competition", hdr);
    expect(sel.status, sel.body).toBe(400);
    expect(sel.json.error).toBe("competitionId required");
    const join = await raw("POST", "/api/competitions/join", hdr);
    expect(join.status, join.body).toBe(400);
    expect(join.json.error).toBe("Join token required");
    // CONTROL: the session survived both (neither was a CSRF failure), and the
    // same route with a real body works — or "400" is satisfied by a route that
    // refuses everything.
    const ok = await pApi.post("/api/select-competition", { headers: H(pCsrf), data: { competitionId: comp.id } });
    expect(ok.status(), await ok.text()).toBe(200);
  });

  test("(A) a body-less POST gets the handler's own answer — anonymous and superadmin routes", async () => {
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const csrf = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
      const login = await anon.post("/api/login", { headers: { "x-csrf-token": csrf } });
      expect(login.status(), "login reaches the credential check").toBe(401);
      const reg = await registerPost(anon, "/api/register", { headers: { "x-csrf-token": csrf } });
      // Register's own first answer (email first): no address-proof grant in
      // this session, asked before any field is read — not a parser refusal.
      expect(reg.status(), "register reaches its own grant check").toBe(403);
      expect((await reg.json()).code).toBe("email_proof_required");
      const fp = await anon.post("/api/auth/code/request", { headers: { "x-csrf-token": csrf } });
      expect(fp.status(), "the code request keeps its 200-always contract").toBe(200);
    } finally { await anon.dispose(); }
    const g = await sa.post("/api/admin/groups", { headers: { "x-csrf-token": saCsrf } });
    expect(g.status(), await g.text()).toBe(400);
    expect((await g.json()).error).toMatch(/Group name is required/);
  });

  // ── (B) a payload no parser read is refused by name ────────────────────────

  test("(B) text/plain to a JSON route is 415 unsupported_media_type, and the session survives", async () => {
    const r = await pApi.post("/api/select-competition", {
      headers: { "x-csrf-token": pCsrf, "content-type": "text/plain" }, data: `{"competitionId":"${comp.id}"}`,
    });
    expect(r.status(), await r.text()).toBe(415);
    const d = await r.json();
    expect(d.code).toBe(UNSUPPORTED);
    expect(d.error).toMatch(/application\/json/);
    // A 415 is not a CSRF failure: the authenticated session is NOT destroyed.
    const me = await pApi.get("/api/me");
    expect(me.status(), "the participant is still signed in").toBe(200);
  });

  test("(B) text/plain to PUT /api/me changes nothing", async () => {
    const before = rowOf("SELECT updated_at, company FROM users WHERE id=?", p.id);
    const r = await pApi.put("/api/me", {
      headers: { "x-csrf-token": pCsrf, "content-type": "text/plain" }, data: '{"company":"Changed By Text"}',
    });
    expect(r.status(), await r.text()).toBe(415);
    expect((await r.json()).code).toBe(UNSUPPORTED);
    const after = rowOf("SELECT updated_at, company FROM users WHERE id=?", p.id);
    expect(after).toEqual(before);
  });

  test("(B) a top-level JSON array is 400 body_not_object", async () => {
    const before = rowOf("SELECT updated_at FROM users WHERE id=?", p.id);
    const r = await pApi.put("/api/me", { headers: H(pCsrf), data: [{ company: "Array Body" }] });
    expect(r.status(), await r.text()).toBe(400);
    expect((await r.json()).code).toBe("body_not_object");
    expect(rowOf("SELECT updated_at FROM users WHERE id=?", p.id)).toEqual(before);
  });

  test("(B) the multer route refuses text/plain too, and stores no submission", async () => {
    const sel = await pApi.post("/api/select-competition", { headers: H(pCsrf), data: { competitionId: comp.id } });
    expect(sel.status(), "precondition: the participant is in the event").toBe(200);
    const r = await pApi.post("/api/tasks/no-such-task/submit", {
      headers: { "x-csrf-token": pCsrf, "content-type": "text/plain" }, data: "answer",
    });
    expect(r.status(), await r.text()).toBe(415);
    expect((await r.json()).code).toBe(UNSUPPORTED);
    expect(rowOf("SELECT COUNT(*) AS n FROM submissions WHERE user_id=?", p.id).n).toBe(0);
    // CONTROL: multipart IS accepted on this route (multer is on its stack): the
    // request passes the shape check and reaches the handler, which answers for
    // the unknown challenge.
    const mp = await pApi.post("/api/tasks/no-such-task/submit", {
      headers: { "x-csrf-token": pCsrf }, multipart: { answer: "x" },
    });
    expect(mp.status(), await mp.text()).not.toBe(415);
  });

  test("(B) multipart to a route WITHOUT multer is 415", async () => {
    const r = await pApi.post("/api/toggle-admin-view", {
      headers: { "x-csrf-token": pCsrf }, multipart: { mode: "admin" },
    });
    expect(r.status(), await r.text()).toBe(415);
    expect((await r.json()).code).toBe(UNSUPPORTED);
  });

  test("(B control) multipart to an upload route is accepted", async () => {
    const r = await sa.post("/api/admin/attachment-staging", {
      headers: { "x-csrf-token": saCsrf },
      multipart: { display_name: "shape control", file: { name: "c.zip", mimeType: "application/zip", buffer: zipOf("c.txt", "control") } },
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
    const d = await r.json();
    const id = d.staging_id;
    expect(id, "the staging upload returned its id").toBeTruthy();
    const del = await sa.delete(`/api/admin/attachment-staging/${id}`, { headers: { "x-csrf-token": saCsrf } });
    expect(del.ok(), `clean up the staged file: ${del.status()}`).toBeTruthy();
  });

  test("(B control) the CSRF check still runs FIRST, and an unrouted path still 404s", async () => {
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const r = await anon.post("/api/login", { headers: { "content-type": "text/plain" }, data: "x" });
      expect(r.status(), "no token: the CSRF refusal, not the shape refusal").toBe(403);
      expect((await r.json()).error).toBe("csrf_invalid");
      const u = await anon.post("/xmlrpc.php", { headers: { "content-type": "text/xml" }, data: "<x/>" });
      expect(u.status(), "the shape check lives inside csrfProtection, so an unrouted path is untouched").toBe(404);
    } finally { await anon.dispose(); }
  });

  test("(B pin) the installed multer still names its middleware `multerMiddleware`", () => {
    // csrfProtection recognises a multipart route by this function NAME on the
    // route's stack. A multer release that renamed it would make every upload 415
    // — so the name is pinned here, where an upgrade fails loudly by name.
    const multer = require("multer");
    const mw = multer({ storage: multer.memoryStorage() }).single("file");
    expect(mw.name).toBe("multerMiddleware");
  });

  // ── malformed multipart and the unsubscribe cap ────────────────────────────

  for (const [label, contentType, body] of [
    ["with no boundary", "multipart/form-data", "--x\r\n"],
    ["cut off mid-part", "multipart/form-data; boundary=SHAPE", '--SHAPE\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\nContent-Type: application/zip\r\n\r\nPK'],
  ]) {
    test(`a multipart body ${label} is a 400 logged at warn, not a 500`, async () => {
      const st = await sa.storageState();
      const cookie = st.cookies.map(c => `${c.name}=${c.value}`).join("; ");
      const r = await raw("POST", "/api/admin/attachment-staging",
        { "x-csrf-token": saCsrf, cookie, "content-type": contentType, "content-length": String(Buffer.byteLength(body)) }, body);
      expect(r.status, r.body).toBe(400);
      expect(r.json.error).toBe("The upload was not a valid multipart form.");
      const line = await findLogLine(LOGS, (j) => j.req_id === r.id && /^Request refused/.test(j.msg || ""),
        { what: `the refusal line for the multipart body ${label}` });
      expect(line.level).toBe("warn");
      expect(line.err_type).toBe("multipart.parse.failed");
    });
  }

  test("POST /api/unsubscribe caps its form body at 16 KB", async () => {
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const big = await anon.post("/api/unsubscribe", { form: { token: "x", pad: "y".repeat(200 * 1024) } });
      expect(big.status(), "a 200 KB form body is refused by the parser").toBe(413);
      // CONTROL: a small form body still reaches the handler, which refuses the
      // bogus token by name — so 413 above is the cap, not the route.
      const small = await anon.post("/api/unsubscribe", { form: { token: "not-a-real-token" } });
      expect(small.status()).toBe(400);
      expect(await small.text()).toMatch(/Unsubscribe link/i);
    } finally { await anon.dispose(); }
  });

  // ── SOURCE: the preset's placement ─────────────────────────────────────────
  //
  // The preset must sit BELOW the global parsers (or it would pre-empt them and
  // every JSON body would read as `{}`) and ABOVE every mutating route (or a route
  // registered first still sees `undefined`). Behaviour cannot show the second
  // half for a route nobody has written yet, so it is pinned here: the one route
  // allowed above it is /api/csp-report, which carries its own parser.
  test("the body preset sits below the global parsers and above every mutating route", () => {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) => pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
    const parsers = src.indexOf("return _urlencoded5mb(req, res, next)");
    const preset = src.search(/if\s*\(\s*req\.body\s*===\s*undefined\s*&&\s*_BODY_METHODS\.has\(\s*req\.method\s*\)\s*\)\s*req\.body\s*=\s*\{\s*\}/);
    const session = src.search(/app\.use\(\s*session\(/);
    expect(parsers, "the global urlencoded parser is mounted").toBeGreaterThan(-1);
    expect(preset, "the preset follows the last global parser").toBeGreaterThan(parsers);
    expect(session, "the session middleware is mounted").toBeGreaterThan(-1);
    expect(preset, "the preset is above the session middleware").toBeLessThan(session);
    const early = [...src.slice(0, preset).matchAll(/\bapp\s*\.\s*(?:post|put|patch|delete)\s*\(\s*"([^"]+)"/g)].map(m => m[1]);
    expect(early, "no mutating route but /api/csp-report is registered above the preset").toEqual(["/api/csp-report"]);
    const methods = src.match(/const _BODY_METHODS = new Set\(\[([^\]]*)\]\)/);
    expect(methods && methods[1].replace(/\s/g, "")).toBe('"POST","PUT","PATCH","DELETE"');
  });
});
