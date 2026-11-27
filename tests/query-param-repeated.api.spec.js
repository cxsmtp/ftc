// @ts-check
//
// v8.13.3 (QAB-1, QAB-6) — A REPEATED QUERY PARAMETER IS REFUSED AT THE BOUNDARY.
//
// Express 5's default "simple" query parser turns a REPEATED key into an array:
// `?competitionId=a&competitionId=b` reads back as ["a","b"]. Every admin handler
// was written for a string, and better-sqlite3 SPREADS an array into positional
// binds — RangeError, a generic 500 and an error-level stack line per request —
// while `includes()` / `String()` on one silently change the answer (an event
// admin was refused "not an organiser" for an array of their OWN event id; the
// logs `?groupId=a&groupId=b` filter quietly showed zero rows). v7.7.38 fixed two
// such sites by hand and missed five; the fix here is the class, at one point:
//
//   server.js mounts `refuseRepeatedQuery` (lib/validate.js) for every request
//   whose NORMALISED path starts /api/admin/ on an ADMIN-SHAPED session, AFTER
//   eventAdminGuard. Three placement rules, each pinned below:
//     - after eventAdminGuard, so a route an event admin may not use still says
//       so (403 event_admin_forbidden) rather than complaining about the query;
//     - admin sessions only, so an anonymous caller still gets 401 and an
//       unrouted path still 404s — the boundary tells nobody which admin paths
//       exist;
//     - on normaliseRoutePath, because Express routes /API/admin/… to the same
//       handler (a raw `req.path` test let that variant through to the 500).
//
// The non-admin surface has no boundary, by design (an anonymous route's only
// control is its limiter), so the source arm at the bottom holds every non-admin
// `req.query` read to a typed shape instead.
const { test, expect, request } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const { buildWorld } = require("./event-admin-helpers");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

test.describe("v8.13.3 — repeated query parameters on the admin surface", () => {
  /** @type {any} */ let w;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    w = await buildWorld();
  });

  const expectRefused = async (r, param) => {
    expect(r.status(), `${r.url()}: ${await r.text()}`).toBe(400);
    const d = await r.json();
    expect(d.code).toBe("query_param_repeated");
    expect(d.param).toBe(param);
  };

  test("a repeated competitionId on the submissions list is a named 400, not a 500", async () => {
    await expectRefused(await w.sa.get(`/api/admin/submissions?competitionId=${w.mine.id}&competitionId=${w.theirs.id}`), "competitionId");
    // A trailing empty duplicate is still an array.
    await expectRefused(await w.sa.get(`/api/admin/submissions?competitionId=${w.mine.id}&competitionId=`), "competitionId");
    // CONTROL: the same request with the parameter once answers normally, or
    // "400" is satisfied by a build that refuses the route outright.
    const ok = await w.sa.get(`/api/admin/submissions?competitionId=${w.mine.id}`);
    expect(ok.status(), await ok.text()).toBe(200);
  });

  test("the boundary matches the path the way Express routes it (an upper-case /API/ variant)", async () => {
    await expectRefused(await w.sa.get(`/API/admin/submissions?competitionId=${w.mine.id}&competitionId=${w.theirs.id}`), "competitionId");
  });

  test("a route nobody has audited is covered too (the boundary, not the handler)", async () => {
    // GET /api/admin/competitions reads no `x`; it is refused anyway, because the
    // point is the routes written next year.
    await expectRefused(await w.sa.get("/api/admin/competitions?x=1&x=2"), "x");
    const ok = await w.sa.get("/api/admin/competitions?x=1");
    expect(ok.status(), await ok.text()).toBe(200);
    // A repeated EMPTY key: the helper names it as "", so a truthiness test at the
    // boundary would wave it through. CONTROL: the empty key once is answered, so
    // the 400 is the repetition's and not the empty key's.
    await expectRefused(await w.sa.get("/api/admin/competitions?=a&=b"), "");
    const once = await w.sa.get("/api/admin/competitions?=a");
    expect(once.status(), await once.text()).toBe(200);
    // An export refused at the boundary hands back no file.
    const ex = await w.sa.get("/api/admin/export/tasks?x=1&x=2");
    await expectRefused(ex, "x");
    expect(ex.headers()["content-disposition"], "a refused export carries no attachment").toBeUndefined();
  });

  test("an event admin: refused on a scoped route, but a FORBIDDEN route still says forbidden", async () => {
    await expectRefused(await w.eaApi.get(`/api/admin/submissions?competitionId=${w.mine.id}&competitionId=${w.mine.id}`), "competitionId");
    // Ordering: eventAdminGuard runs first. A boundary mounted above it would
    // answer 400 here and tell an event admin nothing about the route's tier.
    const f = await w.eaApi.get("/api/admin/logs?q=a&q=b");
    expect(f.status(), await f.text()).toBe(403);
    expect((await f.json()).code).toBe("event_admin_forbidden");
  });

  test("a non-admin caller is answered by the auth gate, not the boundary", async () => {
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const r = await anon.get(`/api/admin/submissions?competitionId=a&competitionId=b`);
      expect(r.status(), "anonymous still gets the auth refusal").toBe(401);
      const u = await anon.get("/api/admin/no-such-route?x=1&x=2");
      expect(u.status(), "an unrouted admin path still 404s for a non-admin").toBe(404);
    } finally { await anon.dispose(); }

    const p = await apiLogin(w.inMine.email, PARTICIPANT_PASS);
    try {
      const r = await p.api.get(`/api/admin/submissions?competitionId=a&competitionId=b`);
      expect(r.status(), "a participant gets requireAdmin's refusal").toBe(403);
      const body = await r.json().catch(() => ({}));
      expect(body.code).not.toBe("query_param_repeated");
    } finally { await p.api.dispose(); }
  });

  test("the boundary is scoped to /api/admin/: a public route with a repeated key is not refused by it", async () => {
    const anon = await request.newContext({ baseURL: BASE });
    try {
      const r = await anon.get("/api/check-nickname?nickname=abc&nickname=def");
      expect(r.status(), "check-nickname answers for itself (its own typeof guard, v7.7.38 H1)").toBe(200);
      expect(await r.json()).toHaveProperty("available");
    } finally { await anon.dispose(); }
  });
});



// ── SOURCE ───────────────────────────────────────────────────────────────────
//
// (1) PLACEMENT. The boundary is a mount, and a mount only covers what is
// registered BELOW it. Every /api/admin/ registration in server.js and every route
// module must come after it, and it must come after eventAdminGuard.
//
// (2) THE NON-ADMIN SURFACE. Outside /api/admin/ there is no boundary, so a
// future participant or public route doing `db.prepare(…).get(req.query.x)`
// regresses silently — the v7.7.38 scanner catches only string-method calls. Every
// `req.query` read outside an /api/admin/ registration must therefore sit in a
// typed shape:
//   typeof req.query.X …            String( / parseInt( / Number( / clampPagingIndex(
//   req.query.X === "lit" / !== undefined     !req.query.X / if (req.query.X)
//   (req.query.X || "").toString()  firstNonScalarQueryParam(req.query)
// or follow, in the same registration, a `typeof req.query.X` test on the same key
// or an `if (firstNonScalarQueryParam(req.query) !== null) return` refusal (never a
// truthiness test: a repeated EMPTY key is "").
// STATED LIMITS: a typeof test earlier in the handler is trusted to have returned
// (the scanner does not prove control flow); `req.query` copied into a variable is
// invisible; only server.js, routes/ and lib/ are read.
test.describe("v8.13.3 — query-boundary source locks", () => {
  // Comments AND string contents blanked, newlines and offsets kept, so a comment
  // quoting `req.query.x` or a message naming a path cannot be read as code.
  function tokenise(raw) {
    const out = raw.split("");
    const blank = (i) => { if (out[i] !== "\n") out[i] = " "; };
    const keep = raw.split("");
    const stack = [{ k: "code", depth: 0 }];
    let i = 0, lastSig = "";
    while (i < raw.length) {
      const top = stack[stack.length - 1], c = raw[i], d = raw[i + 1];
      if (top.k === "tpl") {
        if (c === "\\") { blank(i); blank(i + 1); i += 2; continue; }
        if (c === "`") { stack.pop(); i++; continue; }
        if (c === "$" && d === "{") { stack.push({ k: "code", depth: 0, inTpl: true }); i += 2; continue; }
        blank(i); i++; continue;
      }
      if (c === "/" && d === "/") { while (i < raw.length && raw[i] !== "\n") { blank(i); keep[i] = out[i]; i++; } continue; }
      if (c === "/" && d === "*") { const j = raw.indexOf("*/", i + 2); const e = j < 0 ? raw.length : j + 2; for (let k = i; k < e; k++) { blank(k); keep[k] = out[k]; } i = e; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < raw.length && raw[j] !== c && raw[j] !== "\n") { if (raw[j] === "\\") j++; j++; }
        for (let k = i + 1; k < j; k++) blank(k);
        i = j + 1; lastSig = c; continue;
      }
      if (c === "`") { stack.push({ k: "tpl" }); i++; continue; }
      if (c === "/" && "(,=:[!&|?{};".includes(lastSig || ";")) {
        let j = i + 1, cls = false;
        while (j < raw.length && raw[j] !== "\n") { if (raw[j] === "\\") { j += 2; continue; } if (raw[j] === "[") cls = true; else if (raw[j] === "]") cls = false; else if (raw[j] === "/" && !cls) break; j++; }
        for (let k = i + 1; k < j; k++) blank(k);
        i = j + 1; lastSig = "/"; continue;
      }
      if (c === "{") top.depth++;
      if (c === "}") { if (top.inTpl && top.depth === 0) { stack.pop(); i++; continue; } top.depth--; }
      if (!/\s/.test(c)) lastSig = /[\w$]/.test(c) ? "w" : c;
      i++;
    }
    return { code: out.join(""), kept: keep.join("") };
  }
  function balanced(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }
  const sources = () => {
    const files = ["server.js"];
    for (const d of ["routes", "lib"]) for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith(".js")) files.push(path.join(d, f));
    return files;
  };
  // Registration spans: [start, end, path] for every app.<verb>("…", …).
  function registrations(code, kept) {
    const out = [];
    const re = /\bapp\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(\s*"/g; let m;
    while ((m = re.exec(code))) {
      const open = code.indexOf("(", m.index), close = balanced(code, open);
      const q = m.index + m[0].length;
      const p = kept.slice(q, kept.indexOf('"', q));
      out.push({ start: open, end: close < 0 ? code.length : close, path: p });
    }
    return out;
  }

  test("the boundary sits after eventAdminGuard and above every admin registration", () => {
    const raw = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const { code, kept } = tokenise(raw);
    const guard = code.indexOf("app.use(eventAdminGuard())");
    const mount = code.indexOf("refuseRepeatedQuery(req, res, next)");
    expect(guard, "eventAdminGuard is mounted").toBeGreaterThan(-1);
    expect(mount, "the repeated-query boundary is mounted").toBeGreaterThan(guard);
    // The mount is gated on the normalised path and an admin session.
    const body = code.slice(code.lastIndexOf("app.use(", mount), mount);
    expect(body, "the mount tests the NORMALISED path").toMatch(/normaliseRoutePath\(\s*req\.path\s*\)\s*\.startsWith\(/);
    expect(body, "the mount applies to admin-shaped sessions only").toMatch(/req\.session\.isAdmin/);
    const adminRegs = registrations(code, kept).filter(r => r.path.startsWith("/api/admin/"));
    // Measured at 8 when this shipped (imports, perf seeds, submissions, analytics,
    // logs ×2); a floor, so a tokeniser that stopped seeing them fails here.
    expect(adminRegs.length, "server.js registers admin routes").toBeGreaterThanOrEqual(6);
    const early = adminRegs.filter(r => r.start < mount).map(r => r.path);
    expect(early, "an /api/admin/ route registered above the boundary is not covered by it").toEqual([]);
    const firstRouteModule = kept.search(/require\(\s*"\.\/routes\//);
    expect(firstRouteModule, "every route module is registered below the boundary").toBeGreaterThan(mount);
  });

  test("every req.query read outside /api/admin/ sits in a typed shape", () => {
    const offenders = [];
    let checked = 0, skippedAdmin = 0;
    const WRAP_CALLS = new Set(["String", "parseInt", "Number", "clampPagingIndex", "firstNonScalarQueryParam"]);
    for (const rel of sources()) {
      const { code, kept } = tokenise(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      const regs = registrations(code, kept);
      const re = /\breq\s*(?:\?\.|\.)\s*query\b(?:\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*))?/g; let m;
      while ((m = re.exec(code))) {
        const at = m.index, end = at + m[0].length, prop = m[1] || null;
        const reg = regs.filter(r => r.start < at && at < r.end).pop();
        if (reg && reg.path.startsWith("/api/admin/")) { skippedAdmin++; continue; }
        checked++;
        const before = code.slice(Math.max(0, at - 40), at);
        const after = code.slice(end, end + 40);
        // innermost enclosing paren group and the identifier that calls it
        let depth = 0, groupOpen = -1;
        for (let i = at - 1; i >= 0 && i > at - 400; i--) {
          if (code[i] === ")") depth++;
          else if (code[i] === "(") { if (depth === 0) { groupOpen = i; break; } depth--; }
        }
        const caller = groupOpen >= 0 ? (code.slice(0, groupOpen).match(/([\w$]+)\s*$/) || [])[1] : null;
        const groupClose = groupOpen >= 0 ? balanced(code, groupOpen) : -1;
        const scope = reg ? code.slice(reg.start, at) : code.slice(Math.max(0, at - 3000), at);
        const ok =
          /\btypeof\s+$/.test(before)
          || (caller && WRAP_CALLS.has(caller))
          || /^\s*[!=]==\s*(?:undefined\b|"[^"\n]*")/.test(after)
          || /!\s*$/.test(before)
          || (/\bif\s*\(\s*$/.test(before) && /^\s*\)/.test(after))
          || (groupClose > 0 && !caller && /^\s*\.\s*toString\s*\(\s*\)/.test(code.slice(groupClose + 1, groupClose + 30)))
          || (prop && new RegExp(`\\btypeof\\s+req\\s*(?:\\?\\.|\\.)\\s*query\\s*(?:\\?\\.|\\.)\\s*${prop}\\b`).test(scope))
          // The refusal must compare against null: the helper returns the offending
          // KEY, and a repeated EMPTY key is "" — so a truthiness test is the
          // bypass, and is NOT accepted here as a guard (the pre-release review).
          || /\bif\s*\(\s*firstNonScalarQueryParam\s*\(\s*req\s*\.\s*query\s*\)\s*!==\s*null\s*\)\s*return\b/.test(scope);
        if (!ok) offenders.push(`${rel}:${code.slice(0, at).split("\n").length} ${kept.slice(at, end)}${reg ? ` (in ${reg.path})` : ""}`);
      }
    }
    expect(offenders, [
      "A req.query read outside /api/admin/ is used raw. Express 5 turns a REPEATED key",
      "into an array, which better-sqlite3 spreads into its binds (a 500) and String()",
      "silently joins. Type it: `typeof req.query.x === \"string\" ? req.query.x : \"\"`, or",
      "refuse the request with `if (firstNonScalarQueryParam(req.query) !== null) return …`.",
    ].join(" ")).toEqual([]);
    // ANTI-VACUITY: both halves of the classification found something. If every
    // read were classed admin, `checked` collapses; if none were, the admin count does.
    expect(checked, "non-admin req.query reads were checked").toBeGreaterThanOrEqual(15);
    expect(skippedAdmin, "admin req.query reads were recognised (and left to the boundary)").toBeGreaterThanOrEqual(40);
  });
});
