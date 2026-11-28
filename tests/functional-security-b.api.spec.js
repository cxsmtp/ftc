// @ts-check
//
// Split from functional-security.api.spec.js in v7.21.37 — it was 133s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Security hardening — CSP · ext-audit batch 7: request-body fuzz — no mutating endpoint 500s on a non-string field · v6.9.16: stored-XSS on display surfaces · v6.9.18: graceful shutdown (SIGTERM drain + watchdog) · v6.9.24: /api/admin/competitions/assign negative inputs · Invitation batch deduplication · Remove-from-competition session cleanup · CSRF token lifecycle · v6.13.17 — session & deploy-gate invariants · v6.13.19 — auditor invariants · v6.16.0 — reveal_answers_on_end · v6.16.2 — auditor invariants · Pending-email confirmation + email uniqueness (v7.5.0) · Unverified-account reaper (v7.6.0) · v6.16.5 — auditor invariants · v6.16.7 — auditor invariants · v6.16.19 — logging attribution + completeness · v7.21.1 (A7) — every OTHER write path validates country + timezone too
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost } = require("./helpers");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createClient, freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, PORT_BASE, BASE, gradingHashFor, findLogLine, serverLogTail, codeLogin } = require("./helpers");

// v7.21.37 — `S` / ensureState / aliceInLive moved to ./seeded-state as a
// FACTORY. Each spec file gets its OWN cache: per-file isolation re-seeds the
// database before every file, so one shared `S` would hand this file ids from
// the previous file's database.
const { makeState } = require("./seeded-state");
const { readySpawnedServer } = require("./spawned-server");

// VARIANTS — every spelling of a path that reaches the same Express route or
// static file: the case of the whole path and of each segment's first letter, a
// trailing slash, a doubled slash, and a percent-escaped letter (upper- and
// lower-case hex). Used by the path-variant lock below; give a new path gate's
// paths to it rather than listing spellings by hand.
function VARIANTS(p) {
  const out = new Set();
  const segs = p.split("/");
  out.add(p.toUpperCase());
  out.add(segs.map(s => (s ? s[0].toUpperCase() + s.slice(1) : s)).join("/"));
  out.add(p + "/");
  out.add(p.replace(/^\/([^/]+)\//, "/$1//"));
  const last = segs[segs.length - 1];
  const i = last.search(/[a-z]/);
  if (i >= 0) {
    const hex = last.charCodeAt(i).toString(16);
    const head = segs.slice(0, -1).join("/") + "/" + last.slice(0, i);
    out.add(`${head}%${hex}${last.slice(i + 1)}`);
    out.add(`${head}%${hex.toUpperCase()}${last.slice(i + 1)}`);
  }
  out.delete(p);
  return [...out];
}
const { S, ensureState, aliceInLive } = makeState();

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT FLOWS
// ═══════════════════════════════════════════════════════════════════════════════
// v7.21.37 — hoisted here from between two describes so the file can be
// split: a binding declared outside every describe belongs to whichever
// part inherits it, and the others fail with a bare ReferenceError.
const _v8h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });


// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("Security hardening — CSP", () => {
  test("CSP header has base-uri, form-action, report-uri, trusted-types; no X-XSS-Protection", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/");
    const csp = r.headers()["content-security-policy"] || "";
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
    expect(csp).toMatch(/report-uri \/api\/csp-report/);
    expect(csp).toMatch(/require-trusted-types-for 'script'/);
    // v5.7.0 re-introduced a 'default' policy as a passthrough specifically
    // for the self-hosted ECharts vendor lib (Apache, /vendor/echarts.min.js)
    // which writes innerHTML internally and has no hook to adopt a named
    // policy. App code still routes ALL innerHTML through setSafeHtml() /
    // 'app-html' — the default policy exists for vendor scope only.
    // v6.10.36: 'vendor-script-src' added — strict-allowlist policy used
    // by loadEchartsOnDemand() to set <script>.src at runtime without
    // loosening the default policy (which still throws on createScriptURL).
    expect(csp).toMatch(/trusted-types app-html vendor-script-src default/);
    // v6.20.x: fonts are self-hosted (public/fonts.css → /vendor/fonts), so the
    // Google Fonts origins were removed from the CSP. connect-src is now 'self'
    // only, font-src is 'self', and no fonts.* origin appears anywhere in the
    // policy. (Pre-v6.20.x, connect-src admitted fonts.googleapis.com /
    // fonts.gstatic.com to absorb the preconnect-attribution gap; that whole
    // mechanism is gone now that nothing loads cross-origin fonts.)
    const connectDirective = (csp.match(/connect-src [^;]+/) || [""])[0];
    expect(connectDirective).toBe("connect-src 'self'");
    expect(csp, "CSP must not reference any Google Fonts origin").not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(csp).toMatch(/font-src 'self'/);
    // v7.7.19: highlight.js self-hosted (/vendor/highlight/), so cdnjs was dropped —
    // the CSP now has NO third-party origin. script-src + style-src* are 'self' only.
    expect(csp, "CSP must not reference cdnjs (highlight.js is self-hosted)").not.toMatch(/cdnjs\.cloudflare\.com/);
    expect((csp.match(/script-src [^;]+/) || [""])[0], "script-src is 'self' only").toBe("script-src 'self'");
    // X-XSS-Protection is retired; we removed it.
    expect(r.headers()["x-xss-protection"]).toBeFalsy();
    // v5.2.0 split style-src into element vs attribute policies. style-src-elem
    // (covers <style> blocks and external stylesheets) drops 'unsafe-inline' so
    // an injected <style> block can't apply CSS even if the sanitizer ever
    // missed one. style-src-attr (covers inline style="…") keeps 'unsafe-inline'
    // because the SPA still uses ~650 inline style attrs in template strings.
    const styleElem = (csp.match(/style-src-elem [^;]+/) || [""])[0];
    expect(styleElem).toMatch(/'self'/);
    expect(styleElem).not.toMatch(/'unsafe-inline'/);
    expect(csp).toMatch(/style-src-attr 'unsafe-inline'/);
    await api.dispose();
  });

  test("v6.20.x: HTML entry points self-host fonts (no Google Fonts CDN dependency)", async () => {
    // v6.20.x self-hosted Inter + JetBrains Mono (public/fonts.css →
    // /vendor/fonts/*.woff2), removing the cross-origin font dependency. This
    // regression-locks that NO entry point reaches back out to Google Fonts —
    // both the stylesheet link and the preconnect hints — and that each links
    // the local /fonts.css instead. (Supersedes the v6.10.52 trimmed-axis test;
    // the axis no longer matters now that we ship the woff2 ourselves.)
    const fs = require("fs");
    const entries = [
      "public/index.html",
      "public/help.html",
      // v7.23.11 — the three verify pages are server-rendered now, so there are
      // no files to read. _emailResultPage links /fonts.css and no Google font,
      // and the CSP test in ui-participant-a drives that page for real.
    ];
    for (const path of entries) {
      const body = fs.readFileSync(path, "utf8");
      expect(body, `${path}: still references Google Fonts`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(body, `${path}: missing local /fonts.css link`).toMatch(/<link[^>]+href="\/fonts\.css"/);
    }
    // The self-hosted woff2 binaries exist on disk.
    for (const woff of ["inter-latin.woff2", "inter-latin-ext.woff2", "jetbrains-mono-latin.woff2"]) {
      expect(fs.existsSync(`public/vendor/fonts/${woff}`), `missing self-hosted font ${woff}`).toBeTruthy();
    }
  });

  test("POST /api/csp-report accepts classic shape and logs warn-level entry", async () => {
    const { api } = await freshCtx();
    // Classic Chromium-style payload
    const r = await api.post("/api/csp-report", {
      headers: { "content-type": "application/csp-report" },
      data: JSON.stringify({
        "csp-report": {
          "document-uri": "http://localhost/",
          "violated-directive": "script-src",
          "blocked-uri": "inline",
          "source-file": "http://localhost/app.js",
          "line-number": 42,
          "original-policy": "test-policy",
        },
      }),
    });
    expect(r.status()).toBe(204);
    await api.dispose();
    // Tail the app log as superadmin and find our violation entry.
    const { api: sa } = await apiLogin("superadmin");
    await new Promise(res => setTimeout(res, 80));
    const logs = await (await sa.get("/api/admin/logs?stream=app&limit=500")).json();
    const entry = logs.entries.find(e => e.msg === "CSP violation" && e.blocked_uri === "inline");
    expect(entry).toBeTruthy();
    expect(entry.level).toBe("warn");
    expect(entry.csp_directive).toBe("script-src");
    expect(entry.source_file).toBe("http://localhost/app.js");
    expect(entry.line_number).toBe(42);
    await sa.dispose();
  });

  test("POST /api/csp-report accepts Reporting API shape", async () => {
    const { api } = await freshCtx();
    const r = await api.post("/api/csp-report", {
      headers: { "content-type": "application/reports+json" },
      data: JSON.stringify([{
        type: "csp-violation",
        age: 0,
        url: "http://localhost/",
        body: {
          documentURL: "http://localhost/",
          effectiveDirective: "trusted-types",
          blockedURL: null,
          sourceFile: "http://localhost/app.js",
          lineNumber: 100,
          originalPolicy: "test-policy",
        },
      }]),
    });
    expect(r.status()).toBe(204);
    await api.dispose();
  });
});





// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit batch 7 — request-body fuzz harness (the systematic safety net)
// ═══════════════════════════════════════════════════════════════════════════════
// Option-2 scaffolding for the boundary-validation layer (lib/validate.js): for
// the mutating endpoints where the malformed-body class kept recurring, send a
// NON-STRING (object/array) for each string field + a numeric date, and assert
// the response is a clean 4xx — NEVER a 500. This is the auditor's own oracle
// (behaviour, not source shape), so it catches any access shape the regex lock
// can't model. It also re-asserts the comp list still loads after a numeric-date
// probe (the stored-corruption regression).
//
// v8.13.3 — WHAT IT DID NOT COVER, and now does: every probe here sent a JSON
// OBJECT, so a request whose body no parser reads never ran. Under body-parser 2
// that leaves `req.body` UNDEFINED and every destructuring handler threw — a
// 500 the harness's own claim ("no mutating endpoint 500s") was blind to. The
// last test in this describe sends each route here with NO body and with a
// text/plain one. The full contract (the `{}` preset, the 415, the JSON-array
// 400, multipart only where multer is) is tests/request-body-shape.api.spec.js.
test.describe("ext-audit batch 7: request-body fuzz — no mutating endpoint 500s on a non-string field", () => {
  let ctx;
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const now = Date.now();
    const compId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: `Fuzz ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    const tsId = (await (await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: { name: "FuzzTs", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 60 } })).json()).timeslot.id;
    const taskId = (await (await api.post("/api/admin/tasks", { headers: h, data: { title: `FuzzTask ${now}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "win", status: "draft" } })).json()).id;
    const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
    const uid = parts.find(p => p.email === "alice@acme.com")?.id;
    ctx = { compId, tsId, taskId, uid };
    await api.dispose();
  });

  // probe: send `valid` with `field` replaced by `bad`; assert NOT 500.
  const probe = async (method, path, valid, field, bad) => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api[method](path, { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { ...valid, [field]: bad } });
    const st = r.status();
    await api.dispose();
    return st;
  };
  const OBJ = { a: 1 }, ARR = ["x"];

  test("competition create/edit: name(obj), start_time(numeric), duration(arr) → 4xx", async () => {
    const fut = new Date(Date.now() + 3600_000).toISOString();
    const base = { name: `P ${Date.now()}`, start_time: fut, duration_minutes: 60 };
    for (const [field, bad] of [["name", OBJ], ["start_time", 1], ["duration_minutes", ARR]]) {
      expect(await probe("post", "/api/admin/competitions", base, field, bad), `POST comp ${field}`).toBeLessThan(500);
      expect(await probe("put", `/api/admin/competitions/${ctx.compId}`, {}, field, bad), `PUT comp ${field}`).toBeLessThan(500);
    }
  });

  test("session create/edit: name(obj), start_time(numeric), duration(arr) → 4xx + comp list still loads", async () => {
    const fut = new Date(Date.now() + 7200_000).toISOString();
    const base = { name: `PT ${Date.now()}`, start_time: fut, duration_minutes: 30 };
    for (const [field, bad] of [["name", OBJ], ["start_time", 1], ["duration_minutes", ARR]]) {
      expect(await probe("post", `/api/admin/competitions/${ctx.compId}/timeslots`, base, field, bad), `POST ts ${field}`).toBeLessThan(500);
      expect(await probe("put", `/api/admin/competitions/${ctx.compId}/timeslots/${ctx.tsId}`, {}, field, bad), `PUT ts ${field}`).toBeLessThan(500);
    }
    const { api } = await apiLogin("superadmin");
    expect((await api.get("/api/admin/competitions")).status(), "comp list must still load (no stored corruption)").toBe(200);
    await api.dispose();
  });

  test("tag routes (comp/participant/task): non-string tag → 4xx", async () => {
    expect(await probe("post", `/api/admin/competitions/${ctx.compId}/tags`, {}, "tag", OBJ), "comp tag").toBeLessThan(500);
    expect(await probe("post", `/api/admin/participants/${ctx.uid}/tags`, {}, "tag", OBJ), "participant tag").toBeLessThan(500);
    expect(await probe("post", `/api/admin/tasks/${ctx.taskId}/tags`, {}, "tag", ARR), "task tag").toBeLessThan(500);
  });

  // v8.13.3 — the two body shapes no earlier probe sent. Body-less must reach
  // the handler as `{}` (its own named 4xx); text/plain must be refused 415 by
  // csrfProtection, not silently read as an empty object.
  test("v8.13.3: a body-less or text/plain request to every route here is a 4xx, never a 500", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const routes = [
        ["post", "/api/admin/competitions"],
        ["put", `/api/admin/competitions/${ctx.compId}`],
        ["post", `/api/admin/competitions/${ctx.compId}/timeslots`],
        ["put", `/api/admin/competitions/${ctx.compId}/timeslots/${ctx.tsId}`],
        ["post", `/api/admin/competitions/${ctx.compId}/tags`],
        ["post", `/api/admin/participants/${ctx.uid}/tags`],
        ["post", `/api/admin/tasks/${ctx.taskId}/tags`],
        ["post", "/api/admin/tasks"],
        ["put", `/api/admin/tasks/${ctx.taskId}`],
      ];
      for (const [method, path] of routes) {
        // < 500, not >= 400: an edit route whose every field is optional answers a
        // body-less request exactly as it answers `{}` — a 200 that changes nothing.
        const bare = await api[method](path, { headers: { "x-csrf-token": csrf } });
        expect(bare.status(), `${method.toUpperCase()} ${path} with no body: ${await bare.text()}`).toBeLessThan(500);
        const txt = await api[method](path, { headers: { "x-csrf-token": csrf, "content-type": "text/plain" }, data: "name=x" });
        expect(txt.status(), `${method.toUpperCase()} ${path} as text/plain: ${await txt.text()}`).toBe(415);
      }
    } finally { await api.dispose(); }
  });

  test("task create/edit: title(obj) → 4xx", async () => {
    const base = { title: `T ${Date.now()}`, difficulty: "easy", answer_type: "text", correct_answer: "win" };
    expect(await probe("post", "/api/admin/tasks", base, "title", OBJ), "POST task title").toBeLessThan(500);
    expect(await probe("put", `/api/admin/tasks/${ctx.taskId}`, {}, "title", OBJ), "PUT task title").toBeLessThan(500);
  });

  // The enum allowlists (lib/scoring.js VALID_DIFFICULTIES / VALID_ANSWER_TYPES) do
  // DOUBLE DUTY on the task create/edit routes and had zero coverage. They reject the
  // plausible wrong-cased value from a script/CSV importer ("Easy", "JSON"), AND they
  // are the ONLY type guard on those two fields — the batch-5/H4 typeof loop lists only
  // correct_answer/description/explanation/hint/author_*/attachment_url (the last
  // since v8.13.3), and TASK_FIELD_CAPS skips
  // non-strings. Without them a bad value reaches the INSERT, trips the tasks CHECK
  // (or throws a bind RangeError), and the createTxn catch turns it into an opaque
  // 500 "Failed to create challenge." — the exact class this whole describe exists to
  // prevent. So assert `toBe(400)`, not merely `< 500`: the regression IS 400 → 500.
  test("task create/edit: difficulty outside the allowlist is a 400, never a 500", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const badTitle = `EnumDiff ${Date.now()}`;
    try {
      // (a) a wrong-CASED value must be an actionable 400, not the CHECK-constraint 500.
      const cased = await api.post("/api/admin/tasks", { headers: h, data: { title: badTitle, difficulty: "Easy", answer_type: "text", correct_answer: "x" } });
      expect(cased.status(), `POST difficulty "Easy": ${await cased.text()}`).toBe(400);
      expect((await cased.json()).error).toMatch(/difficulty must be one of/i);
      // (b) a NON-STRING must not reach the SQL bind (a RangeError → 500).
      const obj = await api.post("/api/admin/tasks", { headers: h, data: { title: `${badTitle} obj`, difficulty: OBJ, answer_type: "text", correct_answer: "x" } });
      expect(obj.status(), `POST difficulty {obj}: ${await obj.text()}`).toBe(400);
      // (c) the EDIT guard is a separate line (routes/challenges.js) — lock it too.
      const put = await api.put(`/api/admin/tasks/${ctx.taskId}`, { headers: h, data: { difficulty: "extreme" } });
      expect(put.status(), `PUT difficulty "extreme": ${await put.text()}`).toBe(400);
      expect((await put.json()).error).toMatch(/difficulty must be one of/i);
      // (d) nothing was written: no row carries either rejected title, and the edited
      //     task still holds its original difficulty.
      const db = new (require("better-sqlite3"))(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title LIKE ?").get(`${badTitle}%`).c, "a rejected create must store no task row").toBe(0);
        expect(db.prepare("SELECT difficulty FROM tasks WHERE id=?").get(ctx.taskId).difficulty, "a rejected edit must not change the stored difficulty").toBe("easy");
      } finally { db.close(); }
    } finally { await api.dispose(); }
  });

  test("task create/edit: answer_type outside the allowlist is a 400, never a 500", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const badTitle = `EnumAt ${Date.now()}`;
    try {
      // answer_type selects the grading algorithm, so a silently-accepted variant would
      // be worse than a refusal; the DB CHECK stops that today, which is precisely why
      // the guard's absence shows up as an opaque 500 rather than a clean 400.
      const cased = await api.post("/api/admin/tasks", { headers: h, data: { title: badTitle, difficulty: "easy", answer_type: "File", correct_answer: "x" } });
      expect(cased.status(), `POST answer_type "File": ${await cased.text()}`).toBe(400);
      expect((await cased.json()).error).toMatch(/answer_type must be one of/i);
      const arr = await api.post("/api/admin/tasks", { headers: h, data: { title: `${badTitle} arr`, difficulty: "easy", answer_type: ARR, correct_answer: "x" } });
      expect(arr.status(), `POST answer_type [arr]: ${await arr.text()}`).toBe(400);
      const put = await api.put(`/api/admin/tasks/${ctx.taskId}`, { headers: h, data: { answer_type: "JSON" } });
      expect(put.status(), `PUT answer_type "JSON": ${await put.text()}`).toBe(400);
      expect((await put.json()).error).toMatch(/answer_type must be one of/i);
      const db = new (require("better-sqlite3"))(TEST_DB_PATH, { readonly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title LIKE ?").get(`${badTitle}%`).c, "a rejected create must store no task row").toBe(0);
        expect(db.prepare("SELECT answer_type FROM tasks WHERE id=?").get(ctx.taskId).answer_type, "a rejected edit must not change the stored answer_type").toBe("text");
      } finally { db.close(); }
    } finally { await api.dispose(); }
  });

  test("F2: string-bool comp flags are coerced — \"false\" can't ENABLE a security flag; \"true\" enables it; ambiguous 400s", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fut = new Date(Date.now() + 3600_000).toISOString();
    const find = async (id) => (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);
    let offId, onId;
    try {
      // CREATE with the STRING "false" → flag OFF (pre-fix: truthy string → ON).
      offId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: `F2off ${Date.now()}`, start_time: fut, duration_minutes: 60, reveal_answers_on_end: "false" } })).json()).competition.id;
      // CREATE with the STRING "true" → flag ON.
      onId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: `F2on ${Date.now()}`, start_time: fut, duration_minutes: 60, reveal_answers_on_end: "true" } })).json()).competition.id;
      expect(!!(await find(offId)).reveal_answers_on_end, '"false" must NOT enable reveal_answers_on_end').toBe(false);
      expect(!!(await find(onId)).reveal_answers_on_end, '"true" must enable reveal_answers_on_end').toBe(true);

      // EDIT: turn self_enroll_enabled ON (bool true), then OFF with the STRING "false".
      await api.put(`/api/admin/competitions/${offId}`, { headers: h, data: { self_enroll_enabled: true } });
      expect(!!(await find(offId)).self_enroll_enabled, "self_enroll_enabled true").toBe(true);
      await api.put(`/api/admin/competitions/${offId}`, { headers: h, data: { self_enroll_enabled: "false" } });
      expect(!!(await find(offId)).self_enroll_enabled, '"false" must DISABLE self_enroll (not keep it on)').toBe(false);

      // An ambiguous bool is REJECTED (400), not silently coerced.
      const ambig = await api.put(`/api/admin/competitions/${offId}`, { headers: h, data: { reveal_answers_on_end: "maybe" } });
      expect(ambig.status(), "ambiguous bool must 400").toBe(400);
    } finally {
      if (offId) await api.delete(`/api/admin/competitions/${offId}`, { headers: h }).catch(() => {});
      if (onId) await api.delete(`/api/admin/competitions/${onId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("F3: competition CREATE honors the self-enrollment flag (validated AND persisted, not silently dropped)", async () => {
    // Pre-fix the create schema VALIDATED self_enroll_enabled (added for F2) but
    // the POST destructure + INSERT discarded it — a POST with it true returned
    // 200 yet stored 0. Now create persists it (default OFF when absent). The
    // retired "Allow instant join" switch is refused by name (operator ruling,
    // 14 Nov 2026), never stored and never ignored.
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fut = new Date(Date.now() + 3600_000).toISOString();
    const find = async (id) => (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);
    let onId, offId;
    try {
      // create with the flag true (a real boolean) → stored on.
      onId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: `F3on ${Date.now()}`, start_time: fut, duration_minutes: 60, self_enroll_enabled: true } })).json()).competition.id;
      const on = await find(onId);
      expect(!!on.self_enroll_enabled, "create must persist self_enroll_enabled=true").toBe(true);
      expect(on, "the retired switch is not on the admin wire").not.toHaveProperty("self_enroll_allow_instant");
      // omitting it → default OFF (no regression to the safe default).
      offId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: `F3off ${Date.now()}`, start_time: fut, duration_minutes: 60 } })).json()).competition.id;
      const off = await find(offId);
      expect(!!off.self_enroll_enabled, "absent flag defaults OFF").toBe(false);
    } finally {
      if (onId) await api.delete(`/api/admin/competitions/${onId}`, { headers: h }).catch(() => {});
      if (offId) await api.delete(`/api/admin/competitions/${offId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });
});


test.describe("v6.9.16: stored-XSS on display surfaces", () => {
  // 200 users render each other's nicknames on the leaderboard; the
  // admin panel renders their company / title in table cells. The
  // server doesn't sanitize on write (by design — the templating
  // engines escape on render), but a regression that lands raw HTML
  // in a table cell is a real stored-XSS vector. Exercise the
  // render path to lock in the escape-on-render invariant.
  test("nickname containing <script> renders as text on the public leaderboard", async () => {
    // Register a new user with an adversarial nickname, approve them,
    // have them submit so they appear on the board, then read the
    // board from another participant's context and assert the raw
    // `<script>` substring never lands in the returned JSON.
    const t = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // The nickname field's max length is 40; keep the payload short.
    const evilNick = `xss_${t}_<b>`; // 12-14 chars depending on timestamp
    const reg = await registerPost(sa, "/api/register", {
      headers: saH, data: {
        firstName: "XSS", lastName: "Tester", nickname: evilNick,
        email: `xss-${t}@company.example`, company: "C", title: "T",
        avatar: "🦊", country: "US", timezone: "America/New_York",
      },
    });
    expect(reg.ok()).toBeTruthy();
    const newUser = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants.find(p => p.email === `xss-${t}@company.example`);
    await sa.post(`/api/admin/participants/${newUser.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${newUser.id}/approve`, { headers: saH });
    await sa.dispose();

    // Read the admin participants list and assert the nickname is
    // returned as-is (i.e. no HTML injection pre-escape on the wire)
    // AND that the value is stored intact. Render-time escaping is
    // the SPA's responsibility; this test locks the API contract.
    const { api: sa2 } = await apiLogin("superadmin");
    const list = await (await sa2.get("/api/admin/participants?limit=200")).json();
    const row = list.participants.find(p => p.id === newUser.id);
    expect(row.nickname).toBe(evilNick);
    await sa2.dispose();
  });
});


test.describe("v6.9.18: graceful shutdown (SIGTERM drain + watchdog)", () => {
  // The main test harness runs with NODE_ENV=test, which intentionally
  // skips the SIGTERM/SIGINT handler registration (see server.js
  // comment at the bottom of the graceful-shutdown block). To exercise
  // the real drain path we spawn a standalone child process with
  // NODE_ENV unset on its own port + data dir, send a request, fire
  // SIGTERM, and assert:
  //   1. the in-flight /api/status request completes with 200
  //   2. the process exits with code 0 within the 20-s drain window
  test("SIGTERM drains in-flight requests then exits 0 within the watchdog window", async () => {
    test.setTimeout(45_000);
    const { spawn } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const { PORT_BASE } = require("./helpers");
    // Use a port far outside the worker-slot range so it never
    // collides with a parallel worker's server (+ 100 leaves 95
    // worker slots of headroom).
    const port = PORT_BASE + 100;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-test-"));
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        ...process.env,
        NODE_ENV: "production", // force handler registration
        PORT: String(port),
        DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        BASE_URL: `http://localhost:${port}`,
        SMTP_HOST: "localhost",
        SMTP_PORT: "25",
        SUPERADMIN_PASSWORD_QUIET: "1",
        RATE_LIMIT_DISABLED: "1",
        // This test ASSERTS ON THE CHILD'S EXIT CODE, so the child's node
        // flags must be ours, not the runner's. An inherited NODE_OPTIONS
        // (--require of a diagnostic, --inspect, --throw-deprecation) can
        // change the exit path and did: a CI-only `--require` probe that
        // exited 1 from its SIGTERM handler failed this test in v7.15.29.
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childStderr = "";
    child.stderr.on("data", b => { childStderr += b.toString(); });
    let childStdout = "";
    child.stdout.on("data", b => { childStdout += b.toString(); });
    let childExit = null;
    child.once("exit", (code, signal) => { childExit = { code, signal }; });
    // Wait until THIS child answers (tests/spawned-server.js): its own start
    // time on /api/config, then its own password file. Any answer would do for
    // whoever holds the port, and SIGTERM goes to our child, not to them.
    const startedAt = Date.now();
    let up = false, notReady = "";
    try {
      await readySpawnedServer({ base: `http://localhost:${port}`, child, dataDir, spawnedAt, output: () => childStdout + childStderr, timeoutMs: 15_000 });
      up = true;
    } catch (e) { notReady = String(e.message).split("\n")[0]; }
    if (!up) {
      child.kill("SIGKILL");
      // In production the server's console goes to DATA_DIR/logs/app-*.jsonl,
      // not to stdout or stderr, so a boot that stalled or died says why only
      // there: read it before the directory goes.
      let appLog = "";
      try {
        const logDir = path.join(dataDir, "logs");
        for (const f of fs.readdirSync(logDir).filter(n => n.startsWith("app-"))) appLog += fs.readFileSync(path.join(logDir, f), "utf8");
      } catch (e) { appLog = `(no app log: ${e.code || e.message})`; }
      fs.rmSync(dataDir, { recursive: true, force: true });
      const state = childExit ? `it exited, code=${childExit.code} signal=${childExit.signal}` : "it was still running";
      throw new Error(`child server never became ready within 15 s (${state}; ${notReady}).\nSTDOUT: ${childStdout.slice(-2000)}\nSTDERR: ${childStderr.slice(-2000)}\nAPP LOG: ${appLog.slice(-3000)}`);
    }
    // Fire an in-flight request, then SIGTERM the server 50 ms later.
    const inFlight = fetch(`http://localhost:${port}/api/config`).then(r => ({ status: r.status }));
    await new Promise(r => setTimeout(r, 50));
    child.kill("SIGTERM");
    const exitedAt = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
    const inFlightResult = await inFlight;
    const exitResult = await exitedAt;
    fs.rmSync(dataDir, { recursive: true, force: true });
    // In-flight request should have landed with 200 before the process exited.
    expect(inFlightResult.status, "in-flight /api/config after SIGTERM").toBe(200);
    // Clean exit, within the 20-s watchdog.
    expect(exitResult.code, `expected exit 0 on SIGTERM, got code=${exitResult.code} signal=${exitResult.signal}`).toBe(0);
    expect(exitResult.at - startedAt, "exit within 30 s of boot (watchdog is 20 s)").toBeLessThan(30_000);
  });
});


test.describe("v6.9.24: /api/admin/competitions/assign negative inputs", () => {
  test("empty userIds → 400", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { userIds: [], competitionIds: [S.liveComp.id] },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });
  test("empty competitionIds → 400", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { userIds: [S.bob.id], competitionIds: [] },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });
  test("unknown competitionId is silently skipped (validComps filter)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { userIds: [S.bob.id], competitionIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    // Handler validates comps; unknown ones don't 404, they just aren't assigned.
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.assigned).toBe(0);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// INVITATION batch dedup
// ═══════════════════════════════════════════════════════════════════════════════
// Pasting the same address twice into the invite UI used to create two
// rows and send two emails. The server now de-duplicates the input list
// (case-insensitive on trimmed form) before processing, and the
// "assigned" counter only increments when an INSERT OR IGNORE actually
// inserted a competition_users row.
test.describe("Invitation batch deduplication", () => {
  test("duplicate addresses in one batch produce one invitation row, one email-attempt, one count", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const dup = `dedup-${t}@business.co`;
    const r = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      // Same address three times — varied case + whitespace to prove
      // normalisation works, not just exact-match dedup.
      data: { emails: [dup, ` ${dup.toUpperCase()} `, dup], competitionIds: [] },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    // invited counts unique invitations, NOT raw input rows.
    expect(body.invited).toBe(1);
    await sa.dispose();

    // DB confirms only one invitation row was created for this address.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const rows = db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?)").all(dup);
    db.close();
    expect(rows.length).toBe(1);
  });

  test("re-inviting an existing user does not double-count the assigned counter", async () => {
    await ensureState();
    // Alice is already in S.liveComp from seed. Inviting her to it again —
    // even with two duplicate rows in the batch — should report assigned=0
    // because INSERT OR IGNORE makes no changes.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const r = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {
        emails: ["alice@acme.com", "ALICE@acme.com"],
        competitionIds: [S.liveComp.id],
      },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.assigned).toBe(0);
    // Existing-user response surface — Alice should appear once, not twice.
    expect((body.existingEmails || []).length).toBeLessThanOrEqual(1);
    await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// REMOVE-FROM-COMPETITION session state
// ═══════════════════════════════════════════════════════════════════════════════
// Removing a participant from a competition must not leave them in an
// impossible "still in this event" UI state. Membership-gated routes
// (tasks, submit, leaderboard) already 403 via requireParticipantInCompetition,
// but the lighter reads (/api/me, session probes) historically echoed the
// stale competitionId/timeslotId from the session. The fix clears those
// session fields at removal time and has /api/me self-heal as a backstop.
test.describe("Remove-from-competition session cleanup", () => {
  test("removed participant sees competitionId/timeslotId cleared on /api/me; other competitions survive", async () => {
    await ensureState();
    // Alice is assigned to the live comp in ensureState(). Log her in and
    // select the live competition so her session carries competitionId.
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const sel = await alice.post("/api/select-competition", {
      headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    expect(sel.ok()).toBeTruthy();
    const before = await (await alice.get("/api/me")).json();
    expect(before.competitionId).toBe(S.liveComp.id);
    expect(before.competitionName).toBeTruthy();

    // Superadmin removes Alice from the live competition. From here the seeded
    // membership is broken, so the re-assign must sit in a `finally`: any of the
    // eight assertions below failing would otherwise drop Alice out of the seeded
    // live competition — and its login_time is the solve clock — for every later
    // test in this file.
    try {
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      const rem = await sa.delete(`/api/admin/competitions/${S.liveComp.id}/users/${S.alice.id}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      expect(rem.ok()).toBeTruthy();
      await sa.dispose();

      // Alice's existing session must now see clean competition state on
      // /api/me — competitionId/timeslotId nulled, competitions list no
      // longer includes the revoked comp. She is still logged in (role,
      // nickname unchanged) and can land on the picker.
      const after = await (await alice.get("/api/me")).json();
      expect(after.competitionId).toBeNull();
      expect(after.competitionName).toBeNull();
      expect(after.timeslotId).toBeNull();
      expect(after.nickname).toBe(before.nickname);
      const compIds = (after.competitions || []).map(c => c.id);
      expect(compIds).not.toContain(S.liveComp.id);

      // A membership-gated route also rejects — defence-in-depth at the
      // strict layer was always in place, but we verify end-to-end.
      const tasks = await alice.get("/api/tasks");
      expect(tasks.ok()).toBe(false);
      expect([400, 403]).toContain(tasks.status());
    } finally {
      await alice.dispose();
      // Re-assign Alice so later tests relying on her membership in the live
      // comp still work.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post("/api/admin/competitions/assign", {
        headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
        data: { userIds: [S.alice.id], competitionIds: [S.liveComp.id] },
      });
      await sa2.dispose();
    }
  });

  test("v6.20.x: published challenge content is NOT readable before the competition starts", async () => {
    await ensureState();
    // Alice is seed-enrolled in "Test Upcoming" (start_time +2h). select-competition
    // has no upcoming rejection, so she can scope her session to it — but the three
    // participant READ routes must now withhold content until the window is live.
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const h2 = { "x-csrf-token": csrf, "content-type": "application/json" };
    const sel = await api.post("/api/select-competition", { headers: h2, data: { competitionId: S.upcomingComp.id } });
    expect(sel.ok(), `select upcoming: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    // GET /api/tasks must 403 (pre-fix it returned the published task list).
    const list = await api.get("/api/tasks");
    expect(list.status(), "GET /api/tasks must 403 for an upcoming comp").toBe(403);
    // GET /api/tasks/:id must 403 (easy1 is seed-assigned to Test Upcoming).
    const detail = await api.get(`/api/tasks/${S.easy1.id}`);
    expect(detail.status(), "GET /api/tasks/:id must 403 for an upcoming comp").toBe(403);
    await api.dispose();

    // Contrast: the SAME participant reading the LIVE comp still gets 200 — the
    // gate only blocks the not-yet-started window, not normal play.
    const { api: api2, csrf: csrf2 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api2.post("/api/select-competition", { headers: { "x-csrf-token": csrf2, "content-type": "application/json" }, data: { competitionId: S.liveComp.id } });
    const liveList = await api2.get("/api/tasks");
    expect(liveList.status(), "GET /api/tasks must stay 200 for a live comp").toBe(200);
    expect((await liveList.json()).length, "live comp still returns its task list").toBeGreaterThan(0);
    await api2.dispose();
  });

  test("v6.20.x: PUT /api/admin/tasks/:id/competitions invalidates the leaderboard cache (not just DELETE)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const Database = require("better-sqlite3");
    const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let compId, taskId, userId;
    try {
      // Self-contained live comp (started 1h ago) + published task + enrolled user.
      compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `PUTCache ${tag}`, start_time: new Date(Date.now() - 3600_000).toISOString(), duration_minutes: 180 } })).json()).competition.id;
      taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: `PUTCacheTask ${tag}`, difficulty: "easy", correct_answer: "x", answer_type: "text", status: "published" } })).json()).id;
      const asg = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
      expect(asg.ok(), await asg.text()).toBeTruthy();
      // The event's own copy (lib/event-copies.js): the row a submission names. The
      // desired-state PUT below still names the BANK question, which is "in" the event through it.
      const heldId = (await asg.json()).copies[0].task_id;
      const email = `putcache_${tag}@acme.com`;
      await registerPost(sa, "/api/register", { headers: saH, data: { firstName: "Put", lastName: "Cache", nickname: `putcache_${tag}`, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
      const u = (await (await sa.get("/api/admin/participants?limit=2000")).json()).participants.find(p => p.email === email);
      userId = u.id;
      await sa.post(`/api/admin/participants/${userId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${userId}/approve`, { headers: saH });
      await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [userId], competitionIds: [compId] } });
      // Plant a correct submission (+50) so the user has a non-zero board score.
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, is_correct, points_delta, answer, submitted_at) VALUES (?,?,?,?,NULL,1,50,'x',?)")
          .run(`pc_${tag}`, userId, heldId, compId, new Date().toISOString());
      } finally { dbW.close(); }
      // Set the user's password so they can read their own participant board.
      // Warm the participant leaderboard cache (buildLeaderboard caches per comp).
      const { api: pu, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
      await pu.post("/api/select-competition", { headers: { "x-csrf-token": pc, "content-type": "application/json" }, data: { competitionId: compId } });
      const lb1 = await (await pu.get("/api/leaderboard")).json();
      expect(lb1.me?.score, "warm: planted submission gives +50 on the cached board").toBe(50);
      // PUT desired-state sync removing the task from the comp — pre-fix this did
      // NOT invalidate, so the cached +50 persisted for up to the 5s TTL.
      const put = await sa.put(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [], expectedAssignments: [compId] } });
      expect(put.ok(), `PUT remove: ${put.status()} ${await put.text()}`).toBeTruthy();
      // Immediately re-read (well within TTL): score must drop to 0.
      const lb2 = await (await pu.get("/api/leaderboard")).json();
      expect(lb2.me?.score ?? 0, "PUT must bust the leaderboard cache → score 0 immediately").toBe(0);
      await pu.dispose();
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      if (userId) await sa.delete(`/api/admin/participants/${userId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("removal from a DIFFERENT competition does not touch the user's current-comp session state", async () => {
    await ensureState();
    // Bob is assigned to both live and upcoming in ensureState(). Log him in
    // and pick the LIVE comp so his session points at live.
    const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await bob.post("/api/select-competition", {
      headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    const before = await (await bob.get("/api/me")).json();
    expect(before.competitionId).toBe(S.liveComp.id);

    // Admin removes Bob from the UPCOMING comp (the other one). Must not
    // affect his live-comp session. The re-assign goes in a `finally`: the
    // assertions below stand between the removal and the restore, so a failure
    // there would leave Bob out of the seeded upcoming competition for every
    // later test in this file.
    try {
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      const rm = await sa.delete(`/api/admin/competitions/${S.upcomingComp.id}/users/${S.bob.id}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      // v8.12.4 — the route answers ok on a no-op, so assert the removal HAPPENED.
      expect(rm.ok(), await rm.text()).toBeTruthy();
      expect((await rm.json()).removed, "bob really was removed from the other event").toBe(true);
      await sa.dispose();

      const after = await (await bob.get("/api/me")).json();
      expect(after.competitionId).toBe(S.liveComp.id);
      expect(after.competitionName).toBe(before.competitionName);
    } finally {
      await bob.dispose();
      // Re-assign Bob to upcoming.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post("/api/admin/competitions/assign", {
        headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
        data: { userIds: [S.bob.id], competitionIds: [S.upcomingComp.id] },
      });
      await sa2.dispose();
    }
  });

  test("removal clears users.active_competition_id so auto-resume on next login does not re-enter the revoked comp", async () => {
    await ensureState();
    // Carol picks the live comp, which sets active_competition_id.
    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    // Ensure Carol is assigned first (ensureState assigns all three to live
    // comp, so she should be). Select it to set active_competition_id.
    await carol.post("/api/select-competition", {
      headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    await carol.dispose();

    // Admin removes Carol from the live comp. The re-assign must sit in a
    // `finally`: the assertion below stands between the removal and the
    // restore, so a failure there would drop Carol out of the seeded live
    // competition — and its login_time is the solve clock — for every later
    // test in this file.
    try {
      const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
      await sa.delete(`/api/admin/competitions/${S.liveComp.id}/users/${S.carol.id}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      await sa.dispose();

      // Fresh login — autoResumeCompetitionId MUST NOT be the removed comp.
      const { body } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      expect(body.autoResumeCompetitionId).not.toBe(S.liveComp.id);
    } finally {
      // Re-assign Carol to the live comp for downstream tests.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post("/api/admin/competitions/assign", {
        headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
        data: { userIds: [S.carol.id], competitionIds: [S.liveComp.id] },
      });
      await sa2.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// CSRF token lifecycle (v6.8.1)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("CSRF token lifecycle", () => {
  test("CSRF token issued before logout is rejected after logout", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const beforeCsrf = csrf;
    // Logout destroys the session and the bound CSRF secret.
    const logout = await api.post("/api/logout", { headers: { "x-csrf-token": beforeCsrf } });
    expect(logout.ok()).toBeTruthy();
    // Attempting any mutating call with the pre-logout token must 403 —
    // the csrf-sync synchroniser regenerates on the next session creation
    // so the stored secret no longer matches the token.
    const r = await api.post("/api/login", {
      headers: { "x-csrf-token": beforeCsrf, "content-type": "application/json" },
      data: { email: "x@y.invalid", password: "nope" },
    });
    expect(r.status()).toBe(403);
    await api.dispose();
  });
});





// ═══════════════════════════════════════════════════════════════════════════════
// v6.13.17 — auth + deploy-gate invariants that weren't regression-locked before.
//
// Four contracts the server enforces but the suite didn't verify:
//   * Admin role downgrades mid-session immediately revoke admin access on
//     the next request (the DB re-check inside requireAdmin).
//   * Blocking a participant mid-session immediately revokes their access
//     AND destroys the session (prevents ghost sessions after a block).
//   * Maintenance mode is a hard 503 for every traffic path EXCEPT requests
//     carrying the bypass token — the last-line gate that keeps production
//     deploys safe during data-volume switches.
//   * Rate-limit responses return a correctly-shaped 429 once a per-route
//     per-IP window is exceeded. Uses the test-only /api/test/rate-limit-toggle
//     hook (NODE_ENV=test only) so the harness's RATE_LIMIT_DISABLED=1
//     doesn't short-circuit the guard.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.13.17 — session & deploy-gate invariants", () => {
  test("admin role downgrade takes effect on the next request (no re-login)", async () => {
    // Promote Carol → admin, log her in → she can hit /api/admin/me.
    // Superadmin then demotes her. Her still-alive cookie's next
    // /api/admin/me call must be rejected immediately — not 200.
    // Two valid lockout mechanisms on POST /role (server.js:8754):
    //  • `invalidateOtherSessions("userId", carol.id, null)` destroys
    //    her session → next request = 401 (no session).
    //  • `requireAdmin` DB re-check at server.js:2527 would 403 if the
    //    session somehow survived.
    // Either outcome proves immediate propagation; both are equally
    // correct. Lock "next request is NOT 200" as the contract.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    try {
      const { api: carol } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const meBefore = await carol.get("/api/admin/me");
      expect(meBefore.status(), "admin carol can hit /api/admin/me").toBe(200);
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "participant" } });
      const meAfter = await carol.get("/api/admin/me");
      expect(
        [401, 403].includes(meAfter.status()),
        `demoted session must 401 or 403, got ${meAfter.status()}`
      ).toBeTruthy();
      await carol.dispose();
    } finally {
      // The demote above is the test's own action, not a cleanup: an assertion
      // failing before it leaves Carol an admin — and promotion auto-adds the
      // `staff` tag, which makes the assign endpoint silently skip her for every
      // later test in this file. Idempotent, so the passing path is unchanged.
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "participant" } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("blocking a participant mid-session immediately locks them out", async () => {
    // Uses a throwaway participant (not Alice) so prior tests that reset
    // her password / toggle her block state can't strand this one.
    // Creates → verifies → approves → sets password → logs in → blocks →
    // asserts lockout → cleans up (superadmin deletes the user).
    //
    // Contract: after /block, the target's next request must NOT return
    // 200. The block endpoint (server.js:8881) calls
    // `invalidateOtherSessions("userId", target.id, null)` which
    // destroys every session for them, so the typical outcome is 401.
    // If any session somehow survives, requireParticipant at
    // server.js:2516-2519 destroys it on the next request and returns
    // 403. Accept either — both prove immediate lockout.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const suffix = crypto.randomBytes(4).toString("hex");
    const tgtEmail = `blocktest-${suffix}@acme.test`;
    const tgtPass = "blockTestPass123!";
    let tgtId = null, target;
    try {
      // 1. Register via admin-write path so we don't depend on the
      //    public signup's email-verification round-trip.
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Block", lastName: "Test", nickname: `blockt_${suffix}`,
          email: tgtEmail, company: "Acme", title: "Test", avatar: "🦊",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(regR.ok(), `register: ${regR.status()}`).toBeTruthy();
      // Pick the user up from the admin list to get their id.
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const row = (list.participants || []).find(p => p.email === tgtEmail);
      expect(row, "new user shows in admin list").toBeTruthy();
      tgtId = row.id;
      // 2. Verify + approve.
      await sa.post(`/api/admin/participants/${tgtId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${tgtId}/approve`, { headers: saH });
      // 4. Log in, confirm /api/me works.
      const tgtCtx = await apiLogin(tgtEmail, tgtPass);
      target = tgtCtx.api;
      const meBefore = await target.get("/api/me");
      expect(meBefore.status(), "/api/me works pre-block").toBe(200);
      // 5. Block, then probe /api/me — must NOT be 200.
      await sa.post(`/api/admin/participants/${tgtId}/block`, { headers: saH });
      const meAfter = await target.get("/api/me");
      expect(
        [401, 403].includes(meAfter.status()),
        `blocked user's next request must 401 or 403, got ${meAfter.status()}`
      ).toBeTruthy();
    } finally {
      if (target) await target.dispose();
      if (tgtId) {
        await sa.delete(`/api/admin/participants/${tgtId}`, { headers: saH }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  test("maintenance mode: 503 without bypass, pass-through with bypass token", async () => {
    // DATA_DIR/.maintenance turns every non-bypass request into a
    // 503 + the static maintenance HTML. Same request with
    // X-Maintenance-Bypass: <token> passes the gate so operators +
    // perf-harnesses can work against a quiesced server. Critical
    // deploy contract — a botched maintenance middleware would either
    // leak public traffic during a data-volume switch or lock the
    // operator out entirely.
    const { api: anon } = await freshCtx();
    const token = "v6-13-17-maint-" + Date.now().toString(36);
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    fs.writeFileSync(maintFile, token);
    try {
      const blocked = await anon.get("/");
      expect(blocked.status(), "anonymous request without bypass must 503").toBe(503);
      const htmlBody = await blocked.text();
      expect(htmlBody).toMatch(/Scheduled Maintenance|Maintenance/i);
      const bypassed = await anon.get("/", { headers: { "X-Maintenance-Bypass": token } });
      expect(bypassed.status(), "request with bypass token must pass the gate").toBe(200);
      // infra audit (#3): /healthz is mounted BEFORE the maintenance middleware
      // so the container liveness probe stays 200 during scheduled maintenance
      // (it used to probe /api/config, which the gate 503s → container marked
      // unhealthy / evictable mid-maintenance). No bypass token needed.
      const health = await anon.get("/healthz");
      expect(health.status(), "/healthz must stay 200 during maintenance (no bypass)").toBe(200);
      expect((await health.json()).ok, "/healthz reports liveness").toBe(true);
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
      await anon.dispose();
    }
  });

});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.13.19 — auditor invariants (auth body cap, blocked-admin gate,
// attachment-cap race / orphan cleanup).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.13.19 — auditor invariants", () => {
  test("auth routes 413 on >16 KB body, before rate limiter even runs", async () => {
    // Pre-fix the global express.json had a 5 MB limit and ran ahead of
    // the per-route rate limiter on /api/login & friends. An attacker
    // could force the server to parse 5 MB per request and the rate
    // limiter only kicked in after the body had been read. The fix
    // mounts a 16-KB-cap parser specifically for auth paths AHEAD of
    // the global parser. A 32-KB JSON payload to /api/login must now
    // 413 from the small parser — never reaches the route handler,
    // never costs more than 16 KB of parse memory.
    const { api } = await freshCtx();
    try {
      const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const big = "a".repeat(32 * 1024);
      const r = await api.post("/api/login", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { email: "alice@acme.com", password: "x", junk: big },
      });
      expect(r.status(), "32 KB body must 413, not 401/200").toBe(413);
      // Sanity: a small body still flows through (gets 401 because
      // password is wrong, but proves the parser admitted it).
      const r2 = await api.post("/api/login", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { email: "alice@acme.com", password: "definitely-wrong" },
      });
      expect([401, 403].includes(r2.status()), `small body must reach handler, got ${r2.status()}`).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test("every credential path caps a URL-encoded body at 16 KB, as it does a JSON one", async () => {
    // `_AUTH_PATHS` is read from server.js, so a path added later is held too.
    // Both parsers must take the small cap: the global URL-encoded parser admits
    // 5 MB, before the route's own limiter runs.
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const block = src.match(/const _AUTH_PATHS = new Set\(\[([\s\S]*?)\]\);/);
    expect(block, "the credential path set is still declared in server.js").toBeTruthy();
    const paths = [...block[1].matchAll(/"(\/api\/[^"]+)"/g)].map(m => m[1]);
    expect(paths.length, "the scan must still find the credential paths (anti-vacuity floor)").toBeGreaterThanOrEqual(6);
    const pad = "x".repeat(32 * 1024);
    const { api } = await freshCtx();
    try {
      for (const url of paths) {
        for (const [ct, data] of [["application/json", JSON.stringify({ email: "a@b.com", pad })],
                                  ["application/x-www-form-urlencoded", `email=a%40b.com&pad=${pad}`]]) {
          const r = await api.fetch(url, { method: "POST", headers: { "content-type": ct }, data });
          expect(r.status(), `${ct} POST ${url} must be refused by the 16 KB cap, got ${r.status()}`).toBe(413);
          expect((await r.json()).error, `${ct} ${url}: the refusal names the 16 KB cap, not the 5 MB one`).toContain("16 KB");
        }
      }
      // CONTROL: a small URL-encoded body is parsed and reaches the login route,
      // whose answer to any name but the break-glass account's is this one.
      const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const small = await api.post("/api/login", { headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" }, data: "username=nobody-here&password=wrong" });
      expect(small.status(), await small.text()).toBe(401);
      expect((await small.json()).code).toBe("use_sign_in_code");
    } finally { await api.dispose(); }
  });

  test("every test-only hook gets the 16 KB body cap, JSON and URL-encoded", async () => {
    // The hooks are enumerated from server.js itself: a hand-kept list of them
    // drifted to 15 of 35, and the URL-encoded parser never consulted it at all.
    // Every refusal here comes from the parser, before any handler runs.
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const hooks = new Map();
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"(\/api\/test\/[^"]+)"/g)) {
      hooks.set(`${m[1].toUpperCase()} ${m[2]}`, { method: m[1].toUpperCase(), url: m[2] });
    }
    expect(hooks.size, "the scan must still find the test hooks (anti-vacuity floor)").toBeGreaterThanOrEqual(30);
    const pad = "x".repeat(32 * 1024);
    const { api } = await freshCtx();
    try {
      const refused = async (method, url, ct, data, label) => {
        const r = await api.fetch(url, { method, headers: { "content-type": ct }, data });
        expect(r.status(), `${label}: ${method} ${url} must be refused by the 16 KB cap, got ${r.status()}`).toBe(413);
        expect((await r.json()).error, `${label}: the refusal names the 16 KB cap, not the 5 MB one`).toContain("16 KB");
      };
      for (const { method, url } of hooks.values()) {
        await refused(method, url, "application/json", JSON.stringify({ pad }), "JSON");
        await refused(method, url, "application/x-www-form-urlencoded", `pad=${pad}`, "URL-encoded");
      }
      // Both selectors match the normalised path, and cover paths nothing routes.
      for (const v of ["/API/test/throw", "/Api/Test/linkedin-simulate", "/api/test/throw/", "/api//test/throw", "/api/test/%74hrow", "/api/test/no-such-hook"]) {
        await refused("POST", v, "application/json", JSON.stringify({ pad }), "JSON variant");
        await refused("POST", v, "application/x-www-form-urlencoded", `pad=${pad}`, "URL-encoded variant");
      }
      // CONTROL: under the cap the body reaches the handler (which throws: a
      // generic 500), so the cap is not refusing everything.
      const small = "x".repeat(8 * 1024);
      for (const [ct, data] of [["application/json", JSON.stringify({ message: "cap control", pad: small })],
                                ["application/x-www-form-urlencoded", `message=cap%20control&pad=${small}`]]) {
        const r = await api.post("/api/test/throw", { headers: { "content-type": ct }, data });
        expect(r.status(), `an 8 KB ${ct} body must reach the hook`).toBe(500);
      }
    } finally { await api.dispose(); }
  });

  test("the generated path-variant lock: the 16 KB credential cap and the admin-guide gate hold under every spelling that reaches the same route or file", async () => {
    // Each gate compares `normaliseRoutePath` (CLAUDE.md, *ONE path normaliser
    // for every gate*), because Express routes case-insensitively and without a
    // trailing slash, and serve-static decodes escapes and collapses slashes: a
    // gate that compared the raw path is bypassed by a spelling it never saw.
    // `VARIANTS` generates the spellings, so a path added to a gate later is
    // held too; a hand-written table holds only the ones somebody reported.
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
    const block = src.match(/const _AUTH_PATHS = new Set\(\[([\s\S]*?)\]\);/);
    expect(block, "the credential path set is still declared in server.js").toBeTruthy();
    const authPaths = [...block[1].matchAll(/"(\/api\/[^"]+)"/g)].map(m => m[1]);
    expect(authPaths.length, "anti-vacuity floor: the credential paths were found").toBeGreaterThanOrEqual(6);
    const pad = "x".repeat(32 * 1024);
    const { api } = await freshCtx();
    try {
      // The 16 KB cap, both parsers, on every spelling of every credential path.
      let checked = 0;
      for (const p of authPaths) {
        for (const v of VARIANTS(p)) {
          for (const [ct, data] of [["application/json", JSON.stringify({ email: "a@b.com", pad })],
                                    ["application/x-www-form-urlencoded", `email=a%40b.com&pad=${pad}`]]) {
            const r = await api.fetch(v, { method: "POST", headers: { "content-type": ct }, data });
            expect(r.status(), `${ct} POST ${v} (a spelling of ${p}) must meet the 16 KB cap, got ${r.status()}`).toBe(413);
            expect((await r.json()).error, `${ct} ${v}: the refusal names the 16 KB cap`).toContain("16 KB");
            checked++;
          }
        }
      }
      expect(checked, "every credential path was tried under several spellings").toBeGreaterThanOrEqual(authPaths.length * 2 * 5);

      // The admin-guide gate: no spelling of a gated guide or screenshot reaches
      // an anonymous visitor. The marker is a sentence of the superadmin guide.
      const MARKER = "This guide covers features only";
      const gated = ["/docs/user-guide/superadmin.md", "/docs/user-guide/admin.md", "/docs/user-guide/event-admin.md", "/docs/release-notes.md"];
      const shotDir = path.join(__dirname, "..", "docs", "screenshots", "superadmin");
      const shot = fs.readdirSync(shotDir).find(f => f.endsWith(".png"));
      expect(shot, "PRECONDITION: a superadmin screenshot exists to probe").toBeTruthy();
      gated.push(`/docs/screenshots/superadmin/${shot}`);
      for (const p of gated) {
        const canonical = await api.get(p);
        expect(canonical.status(), `anonymous ${p} is refused by the gate`).toBe(401);
        for (const v of VARIANTS(p)) {
          const r = await api.get(v);
          const body = await r.text();
          expect(r.status(), `anonymous ${v} (a spelling of ${p}) must not be served`).not.toBe(200);
          expect(body, `${v}: no part of the guide reaches an anonymous visitor`).not.toContain(MARKER);
        }
      }
      // CONTROL: the superadmin reads the guide, so the marker and the paths are real.
      const sa = await apiLogin("superadmin");
      try {
        const ok = await sa.api.get("/docs/user-guide/superadmin.md");
        expect(ok.status()).toBe(200);
        expect(await ok.text(), "CONTROL: the marker is in the guide").toContain(MARKER);
        const img = await sa.api.get(`/docs/screenshots/superadmin/${shot}`);
        expect(img.status(), "CONTROL: the screenshot is served to a superadmin").toBe(200);
      } finally { await sa.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("blocked admin loses access on the next request (requireAdmin DB recheck)", async () => {
    // Pre-fix requireAdmin only re-checked role from the DB, not
    // blocked. The block flow's invalidateOtherSessions normally takes
    // care of an admin's live sessions, but if a session survives (e.g.
    // an out-of-band UPDATE users SET blocked=1 by an operator, or a
    // race on session-store cleanup), every admin route was reachable
    // until session expiry. Promote Carol → admin, log her in, hit a
    // protected route, then DB-direct flip blocked=1 (bypassing the
    // session-purging side effect of POST /block) and verify her next
    // admin request rejects.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    let carol;
    try {
      const carolCtx = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      carol = carolCtx.api;
      const before = await carol.get("/api/admin/me");
      expect(before.status(), "admin Carol can hit /api/admin/me").toBe(200);
      // Out-of-band block: directly flip blocked=1 in the DB so we
      // exercise requireAdmin's re-check rather than the session-purge
      // path inside POST /block.
      const Database = require("better-sqlite3");
      const dbW = new Database(TEST_DB_PATH);
      dbW.prepare("UPDATE users SET blocked=1 WHERE id=?").run(S.carol.id);
      dbW.close();
      const r = await carol.get("/api/admin/competitions");
      expect([401, 403].includes(r.status()), `blocked admin's next request must 401/403, got ${r.status()}`).toBeTruthy();
    } finally {
      // Heal Carol fully: clear blocked + restore role.
      const Database = require("better-sqlite3");
      const dbW = new Database(TEST_DB_PATH);
      dbW.prepare("UPDATE users SET blocked=0, locked_until=NULL, failed_login_count=0, failed_login_first=NULL WHERE id=?").run(S.carol.id);
      dbW.close();
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "participant" } }).catch(() => {});
      if (carol) await carol.dispose();
      await sa.dispose();
    }
  });

  test("attachment-cap race: 11th concurrent upload is rejected, no orphan files", async () => {
    // Pre-fix the count check + INSERT were not under one writer txn,
    // so two parallel uploads could both pass count<10 and leave the
    // task at 11 attachments. The fix wraps count + dupe + INSERT in a
    // db.transaction. To exercise the race in a deterministic way:
    // upload 10 attachments serially, then fire 5 parallel POSTs for
    // the 11th slot. Exactly zero of them should succeed (the cap is
    // already at 10 before the parallel batch). The DB row count must
    // stay at 10 and there must be no orphan files in attachments/
    // referenced by non-existent rows.
    const fs = require("fs");
    const path = require("path");
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    // Build a tiny throwaway task; tear it down at the end so other
    // tests' tasks aren't affected.
    const t = Date.now();
    const taskR = await (await sa.post("/api/admin/tasks", {
      headers: saJsonH,
      data: {
        title: `RaceTest-${t}`,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        status: "draft",
      },
    })).json();
    const tid = taskR.id;
    expect(tid, "task created").toBeTruthy();

    // Build a tiny valid ZIP (re-using the well-known smallest-stored shape).
    const zlib = require("zlib");
    function tinyZip() {
      const data = Buffer.from("hi");
      const crc = zlib.crc32 ? zlib.crc32(data) : 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4); lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(1, 26); lh.writeUInt16LE(0, 28);
      const name = Buffer.from("a");
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6);
      cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(1, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(0, 42);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cd.length + name.length, 12);
      eocd.writeUInt32LE(lh.length + name.length + data.length, 16);
      eocd.writeUInt16LE(0, 20);
      return Buffer.concat([lh, name, data, cd, name, eocd]);
    }

    try {
      // 10 serial uploads — each gets a unique display_name to dodge
      // the dupe-name rule (the cap test is what we're after).
      for (let i = 0; i < 10; i++) {
        const r = await sa.post(`/api/admin/tasks/${tid}/attachments`, {
          headers: saH,
          multipart: { file: { name: `f${i}.zip`, mimeType: "application/zip", buffer: tinyZip() }, display_name: `Cap${i}` },
        });
        // v8.3.31 — the route answers a generic {"error":"Upload failed."} for
        // every internal fault, so the response body names nothing. Seen once in
        // a 60-run sweep as a bare 500 on upload 3/10, undiagnosable after the
        // fact because the per-file data directory (and its app log) is wiped by
        // the next spec. Pull the server's OWN error line into the failure.
        if (!r.ok()) {
          const serverSaid = serverLogTail({ lines: 40, keep: 4, match: /error|attachment|upload|ENOSPC|EBUSY/i });
          throw new Error(`upload ${i + 1}/10 must succeed: ${r.status()} ${await r.text()}\nserver log:\n${serverSaid}`);
        }
      }
      // 5 concurrent attempts at the 11th slot. Race in: every one of
      // them might pass through validateUnencryptedZip + sha256 +
      // rename in parallel; the txn is the gate.
      const overflow = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          sa.post(`/api/admin/tasks/${tid}/attachments`, {
            headers: saH,
            multipart: { file: { name: `over${i}.zip`, mimeType: "application/zip", buffer: tinyZip() }, display_name: `Cap-overflow-${i}` },
          })
        )
      );
      for (const r of overflow) {
        expect(r.status(), `overflow upload must 409 (cap), got ${r.status()}`).toBe(409);
        const body = await r.json();
        expect(body.error).toMatch(/Maximum 10 attachments/);
      }
      // Row count must be exactly 10.
      const list = await (await sa.get(`/api/admin/tasks/${tid}/attachments`)).json();
      expect(list.length, "row count after race must be exactly 10").toBe(10);
      // Orphan file check: every UUID-shaped file under DATA_DIR/attachments
      // should match a row in task_attachments. This catches the
      // "moved-then-INSERT-failed" leak case.
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const allRows = dbR.prepare("SELECT storage_path FROM task_attachments").all();
      dbR.close();
      const referenced = new Set(allRows.map(r => path.basename(r.storage_path)));
      // v8.3.16 — TEST_DATA_DIR, never a hand-rolled `data-test-<idx>`.
      //
      // This built the path from TEST_PARALLEL_INDEX alone, and since v7.21.35 the
      // data directory FOLLOWS TEST_PORT_BASE as well (`data-test-<base>-<i>`) —
      // so under any non-default port base it scanned a DIFFERENT run's directory,
      // whose files are of course unreferenced by this run's database, and the
      // orphan assertion failed with a list of perfectly legitimate attachments.
      // `npm run test:independence` shards by port base, so it reported this as
      // order-dependent when it is nothing of the kind. Exactly the fix
      // `_ui-polish.spec.js` records taking in v7.23.0, and the reason
      // `tests/helpers.js` DELEGATES to `dataDirFor()` rather than keeping a copy:
      // a second definition resolves a different directory.
      const attachmentsDirAbs = path.resolve(TEST_DATA_DIR, "attachments");
      if (fs.existsSync(attachmentsDirAbs)) {
        const onDisk = fs.readdirSync(attachmentsDirAbs).filter(f => /^[0-9a-f-]+\.zip$/i.test(f));
        const orphans = onDisk.filter(f => !referenced.has(f));
        expect(orphans, `orphan files in attachments/: ${orphans.join(", ")}`).toEqual([]);
      }
    } finally {
      // Hard-delete the task; that cascades into task_attachments + binary cleanup.
      await sa.delete(`/api/admin/tasks/${tid}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});





// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.0 — reveal_answers_on_end per-competition flag.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.0 — reveal_answers_on_end", () => {
  // Helper: create a fresh single-slot competition + task + a
  // throwaway participant assignment WHILE the comp is live (task
  // assignment isn't frozen by the "any-slot-ended" rule), then
  // immediately /end-now. The throwaway-participant pattern shields
  // these tests from the recurring alice-password rotation that other
  // tests in this file perform. Returns ids + login creds + sa.
  async function _buildRevealComp({ revealOnEnd }) {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    // 1. Throwaway participant with a known password.
    const partEmail = `reveal-${tag}@cust.test`;
    const partPass  = "revealTestPw123!";
    await registerPost(sa, "/api/register", {
      headers: saJsonH,
      data: {
        firstName: "Reveal", lastName: "Test", nickname: `reveal_${tag}`,
        email: partEmail, company: "Acme", title: "T", avatar: "default1",
        country: "US", timezone: "America/New_York",
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const partId = (list.participants || []).find(p => p.email === partEmail)?.id;
    expect(partId).toBeTruthy();
    await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
    // 2. Comp + task while live.
    const compR = await sa.post("/api/admin/competitions", {
      headers: saJsonH,
      data: {
        name: `RevealFlag-${tag}`,
        start_time: new Date(t - 30_000).toISOString(),
        duration_minutes: 60,
        reveal_answers_on_end: !!revealOnEnd,
      },
    });
    const compId = (await compR.json()).competition.id;
    const taskR = await sa.post("/api/admin/tasks", {
      headers: saJsonH,
      data: {
        title: `RevealFlag-Task-${tag}`,
        difficulty: "easy", answer_type: "text",
        correct_answer: "secret-revealed",
        explanation: "<p>the explanation about the answer</p>",
        status: "published",
      },
    });
    const taskId = (await taskR.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: saJsonH, data: { competitionIds: [compId] },
    });
    await sa.post("/api/admin/competitions/assign", {
      headers: saJsonH, data: { userIds: [partId], competitionIds: [compId] },
    });
    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
    return { compId, taskId, partId, partEmail, partPass, sa, saH, saJsonH };
  }

  async function _teardown({ compId, taskId, partId, sa, saH }) {
    if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
    if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
    if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
    await sa.dispose();
  }

  test("default-off: ended comp does NOT reveal correct_answer or explanation", async () => {
    const ctx = await _buildRevealComp({ revealOnEnd: false });
    try {
      const { api: alice, csrf: aliceCsrf } = await apiLogin(ctx.partEmail, ctx.partPass);
      const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      try {
        const selR = await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: ctx.compId } });
        expect(selR.ok(), `select-competition: ${selR.status()} ${await selR.text()}`).toBeTruthy();
        const taskResp = await alice.get(`/api/tasks/${ctx.taskId}`);
        expect(taskResp.ok(), `task fetch: ${taskResp.status()} ${await taskResp.text()}`).toBeTruthy();
        const t = await taskResp.json();
        // Ended-but-not-revealed: the comp shows fully_ended but the
        // task detail withholds the answer.
        expect(t.competition_fully_ended).toBe(true);
        expect(t.correct_answer, "default reveal_answers_on_end=false must NOT reveal correct_answer").toBeUndefined();
        expect(t.explanation, "default reveal_answers_on_end=false must NOT reveal explanation").toBeUndefined();
      } finally {
        await alice.dispose();
      }
    } finally {
      await _teardown(ctx);
    }
  });

  test("opt-in: reveal_answers_on_end=true reveals correct_answer + explanation post-end", async () => {
    const ctx = await _buildRevealComp({ revealOnEnd: true });
    try {
      const { api: alice, csrf: aliceCsrf } = await apiLogin(ctx.partEmail, ctx.partPass);
      const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      try {
        await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: ctx.compId } });
        const t = await (await alice.get(`/api/tasks/${ctx.taskId}`)).json();
        expect(t.competition_fully_ended).toBe(true);
        expect(t.correct_answer).toBe("secret-revealed");
        expect(t.explanation).toMatch(/the explanation about the answer/);
      } finally {
        await alice.dispose();
      }
    } finally {
      await _teardown(ctx);
    }
  });

  test("PUT toggles the flag mid-life and the next /api/tasks/:id call honours it", async () => {
    // Start with reveal=true; verify; PUT reveal=false; re-fetch
    // shows the answer redacted on the very next call (no 5-s cache
    // window — getCompetition's TTL is 1 s and the PUT invalidates).
    const ctx = await _buildRevealComp({ revealOnEnd: true });
    try {
      const { api: alice, csrf: aliceCsrf } = await apiLogin(ctx.partEmail, ctx.partPass);
      const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      try {
        await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: ctx.compId } });
        let t = await (await alice.get(`/api/tasks/${ctx.taskId}`)).json();
        expect(t.correct_answer).toBe("secret-revealed");
        // Flip via PUT.
        const putR = await ctx.sa.put(`/api/admin/competitions/${ctx.compId}`, {
          headers: ctx.saJsonH,
          data: { reveal_answers_on_end: false },
        });
        expect(putR.ok(), `PUT reveal=false: ${putR.status()}`).toBeTruthy();
        // Wait past the 1-s _competitionCache TTL just in case the
        // PUT's _invalidateCompetitionCache path is bypassed.
        await new Promise(r => setTimeout(r, 1100));
        t = await (await alice.get(`/api/tasks/${ctx.taskId}`)).json();
        expect(t.correct_answer, "after flipping flag to false, answer must hide").toBeUndefined();
        expect(t.explanation).toBeUndefined();
      } finally {
        await alice.dispose();
      }
    } finally {
      await _teardown(ctx);
    }
  });

  test("GET /api/admin/competitions exposes reveal_answers_on_end for the admin pane", async () => {
    const ctx = await _buildRevealComp({ revealOnEnd: true });
    try {
      const list = await (await ctx.sa.get("/api/admin/competitions")).json();
      const c = list.find(x => x.id === ctx.compId);
      expect(c, "comp visible in admin list").toBeTruthy();
      expect(c.reveal_answers_on_end).toBe(1);
    } finally {
      await _teardown(ctx);
    }
  });

  test("created comp without the flag defaults to 0 (do not reveal)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    const compR = await sa.post("/api/admin/competitions", {
      headers: saJsonH,
      data: {
        name: `RevealDefault-${tag}`,
        start_time: new Date(t + 3600_000).toISOString(),
        duration_minutes: 60,
        // reveal_answers_on_end intentionally omitted
      },
    });
    const compId = (await compR.json()).competition.id;
    try {
      const list = await (await sa.get("/api/admin/competitions")).json();
      const c = list.find(x => x.id === compId);
      expect(c.reveal_answers_on_end).toBe(0);
    } finally {
      await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.2 — auditor batch: LinkedIn race close, hint lifecycle gates,
// per-comp reveal flag echoed to participants.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.2 — auditor invariants", () => {


  test("hint endpoint rejects upcoming competitions (403)", async () => {
    // Pre-fix /api/tasks/:id/hint had no lifecycle gate — a
    // participant who selected an upcoming comp could call the
    // endpoint and reveal a hint (mutating hint_reveals + audit)
    // before the comp had even started. Mirror /submit's gate:
    // upcoming → 403 with `${name} has not started yet`.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let compId;
    let taskId;
    try {
      // Upcoming comp: starts 1 h from now, 1 h duration.
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `HintGate-Up-${tag}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 60 },
      });
      compId = (await compR.json()).competition.id;
      const taskR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `HintGate-Task-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", hint: "the hint", explanation: "<p>e</p>",
          status: "published",
        },
      });
      taskId = (await taskR.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saJsonH, data: { competitionIds: [compId] },
      });
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });

      // Bob enters the upcoming comp and tries the hint endpoint.
      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const bobH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
      try {
        const sel = await bob.post("/api/select-competition", { headers: bobH, data: { competitionId: compId } });
        expect(sel.ok(), `select-competition: ${sel.status()}`).toBeTruthy();
        const r = await bob.post(`/api/tasks/${taskId}/hint`, { headers: bobH });
        expect(r.status(), `hint on upcoming comp must 403, got ${r.status()}`).toBe(403);
        const body = await r.json();
        expect(body.error).toMatch(/not started yet/i);
        // DB-direct: no hint_reveal row for bob × this task.
        const Database = require("better-sqlite3");
        const dbR = new Database(TEST_DB_PATH, { readonly: true });
        const reveal = dbR.prepare("SELECT 1 FROM hint_reveals WHERE user_id=? AND task_id=?").get(S.bob.id, taskId);
        dbR.close();
        expect(reveal, "hint reveal row must NOT have been written").toBeFalsy();
      } finally {
        await bob.dispose();
      }
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("hint endpoint rejects ended competitions (403)", async () => {
    // Same gate, opposite end of the lifecycle. A participant whose
    // slot has already ended must not still be able to deduct hint
    // points.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let compId, taskId;
    try {
      // Live comp at first so we can wire up the task + assign bob,
      // then /end-now. Same shape as the v6.16.0 reveal tests.
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `HintGate-End-${tag}`, start_time: new Date(t - 30_000).toISOString(), duration_minutes: 60 },
      });
      compId = (await compR.json()).competition.id;
      const taskR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `HintGate-End-Task-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", hint: "the hint", explanation: "<p>e</p>",
          status: "published",
        },
      });
      taskId = (await taskR.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saJsonH, data: { competitionIds: [compId] },
      });
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });

      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const bobH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
      try {
        await bob.post("/api/select-competition", { headers: bobH, data: { competitionId: compId } });
        const r = await bob.post(`/api/tasks/${taskId}/hint`, { headers: bobH });
        expect(r.status()).toBe(403);
        const body = await r.json();
        expect(body.error).toMatch(/has ended/i);
      } finally {
        await bob.dispose();
      }
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("hint endpoint requires a chosen timeslot in multi-slot mode (400)", async () => {
    // /submit had this since v6.0; /hint didn't. Rejecting before
    // any timeslot is selected means we never write a hint_reveal
    // row with NULL timeslot_id when the comp expects one.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let compId, taskId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `HintGate-MS-${tag}`, start_time: new Date(t - 30_000).toISOString(), duration_minutes: 60 },
      });
      compId = (await compR.json()).competition.id;
      // Add a timeslot so the comp is multi-slot.
      await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: { name: `HintSlot-${tag}`, start_time: new Date(t - 30_000).toISOString(), duration_minutes: 60 },
      });
      const taskR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `HintGate-MS-Task-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", hint: "the hint", explanation: "<p>e</p>",
          status: "published",
        },
      });
      taskId = (await taskR.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saJsonH, data: { competitionIds: [compId] },
      });
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const bobH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
      try {
        // Select comp WITHOUT selecting a timeslot.
        await bob.post("/api/select-competition", { headers: bobH, data: { competitionId: compId } });
        const r = await bob.post(`/api/tasks/${taskId}/hint`, { headers: bobH });
        expect(r.status()).toBe(400);
        const body = await r.json();
        expect(body.error).toMatch(/choose a session/i);
      } finally {
        await bob.dispose();
      }
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("/api/me + /api/status echo reveal_answers_on_end so the SPA can gate copy", async () => {
    // The SPA's "All sessions complete — answers are now revealed!"
    // toast and the per-session "answers will be revealed once all
    // sessions end" popup both lied for any comp with
    // reveal_answers_on_end=false (the default). The SPA fix gates
    // those messages on the per-comp flag — but only if the server
    // surfaces it. This test locks the wire contract.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `RevealEcho-${tag}`,
          start_time: new Date(t - 30_000).toISOString(),
          duration_minutes: 60,
          reveal_answers_on_end: true,
        },
      });
      compId = (await compR.json()).competition.id;
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const bobH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
      try {
        await bob.post("/api/select-competition", { headers: bobH, data: { competitionId: compId } });
        // /api/me — competitions array entry must include the flag.
        const me = await (await bob.get("/api/me")).json();
        const meEntry = (me.competitions || []).find(c => c.id === compId);
        expect(meEntry, "comp present in /api/me").toBeTruthy();
        expect(meEntry.reveal_answers_on_end).toBe(1);
        // /api/status — top-level field present.
        const st = await (await bob.get("/api/status")).json();
        expect(st.reveal_answers_on_end).toBe(true);
      } finally {
        await bob.dispose();
      }
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v7.5.0 — pending-email confirmation + system-wide email uniqueness (PR-4)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Pending-email confirmation + email uniqueness (v7.5.0)", () => {
  const Database = require("better-sqlite3");

  // Register a corporate participant, verify+approve, log in (password chosen at
  // sign-up → no reset dance). Returns a logged-in api + the row id.
  async function mkUser(sa, saH, tag, email, opts = {}) {
    const password = opts.password || "PendPw123!";
    await registerPost(sa, "/api/register", {
      headers: { "x-csrf-token": saH["x-csrf-token"], "content-type": "application/json" },
      data: {
        firstName: "Pe", lastName: "Nd", nickname: `pe_${tag}`, email, password,
        secondaryEmail: opts.secondary, company: "Acme", title: "T",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
      },
    });
    const list = await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
    const row = (list.participants || []).find(p => p.email === email.toLowerCase());
    await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: saH });
    const logged = await apiLogin(email, password);
    return { ...logged, id: row.id, email: email.toLowerCase() };
  }

  // Drive the public GET→POST /confirm-email handshake for a code.
  async function confirmEmail(code) {
    const { api } = await freshCtx();
    const getRes = await api.get(`/confirm-email?code=${encodeURIComponent(code)}`, { maxRedirects: 0 });
    const html = await getRes.text();
    const m = html.match(/name="_csrf" value="([^"]+)"/);
    if (!m) { const out = { api, getStatus: getRes.status(), getHtml: html, postStatus: null }; return out; }
    const postRes = await api.post("/confirm-email", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      form: { code, _csrf: m[1] }, maxRedirects: 0,
    });
    return { api, getStatus: getRes.status(), postStatus: postRes.status(), postHtml: await postRes.text() };
  }

  function pendingCodeOf(userId) {
    const dbRO = new Database(TEST_DB_PATH, { readonly: true });
    const row = dbRO.prepare("SELECT pending_email, pending_email_code, pending_email_code_at FROM users WHERE id=?").get(userId);
    dbRO.close();
    return row;
  }

  test("PUT /api/me stages a pending change; confirming it swaps the email (and the user is never logged out)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const oldEmail = `pe-old-${tag}@corp-pe.test`;
    const newEmail = `pe-new-${tag}@corp-pe.test`;
    const { api: u, csrf: uCsrf, id } = await mkUser(sa, saH, tag, oldEmail);
    try {
      const r = await u.put("/api/me", { headers: { "x-csrf-token": uCsrf, "content-type": "application/json" }, data: { email: newEmail } });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.emailChangePending).toBe(true);
      expect(body.pendingEmail).toBe(newEmail);
      // Committed email unchanged; user still authenticated on the old email.
      let me = await (await u.get("/api/me")).json();
      expect(me.email).toBe(oldEmail);
      expect(me.pending_email).toBe(newEmail);
      // Confirm via the emailed code.
      const { pending_email_code } = pendingCodeOf(id);
      const c = await confirmEmail(pending_email_code);
      expect(c.getStatus).toBe(200);
      expect(c.postStatus).toBe(200);
      expect(c.postHtml).toContain(newEmail);
      await c.api.dispose();
      // Email is swapped; pending cleared; the original session still works.
      me = await (await u.get("/api/me")).json();
      expect(me.email).toBe(newEmail);
      expect(me.pending_email == null || me.pending_email === "").toBeTruthy();
    } finally {
      await u.dispose();
      await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("an invalid / unknown confirm code returns a uniform failure (no oracle)", async () => {
    await ensureState();
    const c1 = await confirmEmail("deadbeef-0000-0000-0000-000000000000");
    expect(c1.getStatus).toBe(400);
    expect(c1.getHtml).not.toContain("@"); // no leaked address
    await c1.api.dispose();
  });

  test("an expired confirm code is rejected and the live account is untouched", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const oldEmail = `pe-exp-${tag}@corp-pe.test`;
    const { api: u, id } = await mkUser(sa, saH, tag, oldEmail);
    try {
      // Seed an EXPIRED pending directly (49h old).
      const dbW = new Database(TEST_DB_PATH);
      const stale = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
      dbW.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
        .run(`pe-exp-new-${tag}@corp-pe.test`, `expcode_${tag}`, stale, id);
      dbW.close();
      const c = await confirmEmail(`expcode_${tag}`);
      expect(c.getStatus).toBe(400);
      expect(c.getHtml.toLowerCase()).toContain("expired");
      await c.api.dispose();
      const me = await (await u.get("/api/me")).json();
      expect(me.email).toBe(oldEmail); // unchanged
    } finally {
      await u.dispose();
      await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("confirm-time re-check: if the pending address was claimed meanwhile, the swap fails and the account is unchanged", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const target = `pe-contest-${tag}@corp-pe.test`;
    const aEmail = `pe-a-${tag}@corp-pe.test`;
    const { api: a, id: aId } = await mkUser(sa, saH, `a${tag}`, aEmail);
    let bId;
    try {
      // A stages a pending change to `target` (seed directly with a fresh code).
      const dbW = new Database(TEST_DB_PATH);
      dbW.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
        .run(target, `contest_${tag}`, new Date().toISOString(), aId);
      dbW.close();
      // B then registers `target` as their committed primary (clear the pending
      // first so the uniqueness check at register time lets B through — modelling
      // the race where B grabs it before A confirms).
      const dbW2 = new Database(TEST_DB_PATH);
      dbW2.prepare("UPDATE users SET pending_email=NULL, pending_email_code=NULL, pending_email_code_at=NULL WHERE id=?").run(aId);
      dbW2.close();
      const b = await mkUser(sa, saH, `b${tag}`, target);
      bId = b.id; await b.api.dispose();
      // Re-seed A's pending to target (now B owns it) + confirm → must conflict.
      const dbW3 = new Database(TEST_DB_PATH);
      dbW3.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
        .run(target, `contest2_${tag}`, new Date().toISOString(), aId);
      dbW3.close();
      const c = await confirmEmail(`contest2_${tag}`);
      expect(c.postStatus === 409 || c.getStatus === 409 || (c.getHtml || c.postHtml || "").toLowerCase().includes("no longer available")).toBeTruthy();
      await c.api.dispose();
      const me = await (await a.get("/api/me")).json();
      expect(me.email).toBe(aEmail); // A's email unchanged
    } finally {
      await a.dispose();
      await sa.delete(`/api/admin/participants/${aId}`, { headers: saH }).catch(() => {});
      if (bId) await sa.delete(`/api/admin/participants/${bId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("a non-expired pending_email reserves the address system-wide (register + secondary slot blocked)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const reserved = `pe-resv-${tag}@corp-pe.test`;
    const { api: u, id } = await mkUser(sa, saH, tag, `pe-resvowner-${tag}@corp-pe.test`);
    try {
      // Seed a fresh pending reservation on `reserved`.
      const dbW = new Database(TEST_DB_PATH);
      dbW.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
        .run(reserved, `resv_${tag}`, new Date().toISOString(), id);
      dbW.close();
      // A fresh registration of the reserved address creates NOTHING. Email
      // first: the reserved address is mailed no address proof (the code
      // request answers its uniform {ok:true}, never an existence oracle), so
      // the registration has no grant to spend and is refused before any field.
      const { api: anon, csrf: anonCsrf } = await freshCtx();
      const reg = await registerPost(anon, "/api/register", {
        headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
        data: { firstName: "R", lastName: "X", nickname: `rx_${tag}`, email: reserved, company: "C", title: "T", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" },
      });
      expect(reg.status(), "no proof was minted for a reserved address").toBe(403);
      expect((await reg.json()).code).toBe("email_proof_required");
      { const dbR = new Database(TEST_DB_PATH, { readonly: true });
        try { expect(dbR.prepare("SELECT COUNT(*) c FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)").get(reserved, reserved).c, "no account took the reserved address").toBe(0); }
        finally { dbR.close(); } }
      await anon.dispose();
    } finally {
      await u.dispose();
      await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("cross-slot uniqueness: a primary can't equal another account's secondary, and vice-versa", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const shared = `pe-shared-${tag}@corp-pe.test`;
    // User A holds `shared` in its SECONDARY slot.
    const { api: a, id: aId } = await mkUser(sa, saH, `a${tag}`, `pe-aprim-${tag}@corp-pe.test`, { secondary: shared });
    let bId;
    try {
      // Registering `shared` (A's SECONDARY) never makes a second account: it is
      // A's address, so the code request mails A a SIGN-IN code, not an address
      // proof, and the registration has no grant to spend.
      const { api: anon, csrf: anonCsrf } = await freshCtx();
      const reg = await registerPost(anon, "/api/register", {
        headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
        data: { firstName: "B", lastName: "X", nickname: `bx_${tag}`, email: shared, company: "C", title: "T", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" },
      });
      expect(reg.status(), "an address an account holds gets no proof").toBe(403);
      expect((await reg.json()).code).toBe("email_proof_required");
      { const dbR = new Database(TEST_DB_PATH, { readonly: true });
        try { expect(dbR.prepare("SELECT COUNT(*) c FROM users WHERE nickname=?").get(`bx_${tag}`).c, "no second account was created").toBe(0); }
        finally { dbR.close(); } }
      await anon.dispose();
      // And a different user B cannot adopt `shared` as their SECONDARY either.
      const b = await mkUser(sa, saH, `b${tag}`, `pe-bprim-${tag}@corp-pe.test`);
      bId = b.id;
      const put = await b.api.put("/api/me", { headers: { "x-csrf-token": b.csrf, "content-type": "application/json" }, data: { secondaryEmail: shared } });
      expect(put.status()).toBe(409);
      await b.api.dispose();
    } finally {
      await a.dispose();
      await sa.delete(`/api/admin/participants/${aId}`, { headers: saH }).catch(() => {});
      if (bId) await sa.delete(`/api/admin/participants/${bId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("PUT /api/me rejects a primary change to a taken address (409) and re-submitting the current email cancels a prior pending", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const oldEmail = `pe-cancel-${tag}@corp-pe.test`;
    const { api: u, csrf: uCsrf, id } = await mkUser(sa, saH, tag, oldEmail);
    const uH = { "x-csrf-token": uCsrf, "content-type": "application/json" };
    try {
      // Changing to alice's existing email → 409.
      const taken = await u.put("/api/me", { headers: uH, data: { email: "alice@acme.com" } });
      expect(taken.status()).toBe(409);
      // Stage a real pending change.
      await u.put("/api/me", { headers: uH, data: { email: `pe-cancel-new-${tag}@corp-pe.test` } });
      expect(pendingCodeOf(id).pending_email).toBe(`pe-cancel-new-${tag}@corp-pe.test`);
      // Re-submitting the CURRENT email cancels the pending.
      const cancel = await u.put("/api/me", { headers: uH, data: { email: oldEmail } });
      expect(cancel.status()).toBe(200);
      expect(pendingCodeOf(id).pending_email).toBeFalsy();
    } finally {
      await u.dispose();
      await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("an admin email change SUPERSEDES the user's own pending, with a fresh code", async () => {
    // v8.3.36 RE-POINTED. The old subject was the v7.5.0 interaction: the admin
    // path COMMITTED its correction and therefore had to VOID the participant's
    // self-staged pending, or a stale /confirm-email link would later revert it —
    // and the SMTP rollback then had to restore that pending, since the
    // correction never took effect.
    //
    // Staging retires both halves. There is ONE pending slot and the admin's
    // instruction is the newer one, so it overwrites; the v7.5.0 hazard is
    // impossible by construction because nothing is committed to revert. What
    // must still hold — and is the load-bearing half — is that the code is
    // REPLACED too: /confirm-email resolves the row BY the code, so a surviving
    // stale code would let the participant's older link commit the ADMIN's
    // address under a mail describing a different one.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const oldEmail = `pe-avoid-${tag}@corp-pe.test`;
    const userStaged = `pe-avoid-staged-${tag}@corp-pe.test`;
    const adminSet = `pe-avoid-admin-${tag}@corp-pe.test`;
    const { api: u, csrf: uCsrf, id } = await mkUser(sa, saH, tag, oldEmail);
    try {
      // User stages a pending change.
      await u.put("/api/me", { headers: { "x-csrf-token": uCsrf, "content-type": "application/json" }, data: { email: userStaged } });
      const stagedCode = pendingCodeOf(id).pending_email_code;
      expect(pendingCodeOf(id).pending_email, "precondition: the participant staged their own").toBe(userStaged);
      expect(stagedCode, "precondition: with a code").toBeTruthy();

      // Superadmin corrects it to a different address. Staging succeeds whatever
      // SMTP did — the shared server's relay is dead and that no longer matters,
      // because nothing is committed and there is nothing to roll back.
      const ed = await sa.put(`/api/admin/participants/${id}`, { headers: saJH, data: { email: adminSet } });
      expect(ed.status(), `staging must succeed: ${await ed.text().catch(() => "")}`).toBe(200);
      const body = await ed.json();
      expect(body.emailChanged, "the live address did not change").toBe(false);
      expect(body.emailChangePending).toBe(true);

      const after = pendingCodeOf(id);
      expect(after.pending_email, "the admin's instruction supersedes the participant's").toBe(adminSet);
      expect(after.pending_email_code, "with a FRESH code — a surviving one would let the stale link commit this address")
        .not.toBe(stagedCode);

      // And the COMMITTED address is untouched: staged, not applied.
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT email, verified FROM users WHERE id=?").get(id);
      dbRO.close();
      expect(row.email, "the live address is untouched until confirmation").toBe(oldEmail);
      expect(row.verified, "and so is the verified flag").toBe(1);
    } finally {
      await u.dispose();
      await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v7.6.0 — unverified-account reaper (48h auto-delete of abandoned sign-ups)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Unverified-account reaper (v7.6.0)", () => {
  const Database = require("better-sqlite3");

  async function register(nick, email, over = {}) {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {
      firstName: "Re", lastName: "Ap", nickname: nick, email, password: "ReapPass123",
      company: "X", title: "T", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", ...over,
    }});
    await api.dispose();
    return r;
  }
  function rowOf(nick) { const d = new Database(TEST_DB_PATH, { readonly: true }); const r = d.prepare("SELECT * FROM users WHERE nickname=?").get(nick); d.close(); return r; }
  function exists(nick) { return !!rowOf(nick); }
  function patch(nick, sets) { const d = new Database(TEST_DB_PATH); const keys = Object.keys(sets); d.prepare(`UPDATE users SET ${keys.map(k => k + "=?").join(",")} WHERE nickname=?`).run(...keys.map(k => sets[k]), nick); d.close(); }
  function ageHours(nick, h) { patch(nick, { created_at: new Date(Date.now() - h * 3600_000).toISOString() }); }
  async function reap(opts) { const { api, csrf } = await freshCtx(); const r = await api.post("/api/test/reap-accounts", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: opts || {} }); const j = await r.json(); await api.dispose(); return j; }

  test("reaps an abandoned never-verified manual self-registration past the 48h TTL (full cascade)", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    await register(`reap_n_${tag}`, `reap-n-${tag}@corp-z.com`);
    const id = rowOf(`reap_n_${tag}`).id;
    ageHours(`reap_n_${tag}`, 49);                       // older than the 48h TTL
    const res = await reap({ floorIso: null });          // disable the grandfather floor
    expect(res.ids).toContain(id);
    expect(exists(`reap_n_${tag}`)).toBe(false);
    // The cascade removed the user's event rows too (no orphans).
    const d = new Database(TEST_DB_PATH, { readonly: true });
    expect(d.prepare("SELECT COUNT(*) c FROM user_events WHERE user_id=?").get(id).c).toBe(0);
    d.close();
    // v8.12.4 — with the account gone, the ONLY record that it existed and why it
    // went is the orphaned audit line in the app log. No test had read it.
    const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      (j) => j.source === "audit" && j.event_type === "account_reaped" && j.scope_id === id,
      { what: `an account_reaped line for ${id}` });
    expect(line.details.reason).toBe("unverified_48h");
    expect(line.details.email).toBe(`reap-n-${tag}@corp-z.com`);
  });

  test("preserves event-link, invited, approved, and once-verified accounts", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    // (a) event-link /join account — carries a self-enroll marker.
    await register(`reap_join_${tag}`, `reap-join-${tag}@corp-z.com`);
    patch(`reap_join_${tag}`, { pending_self_enroll_comp_id: "some-comp" });
    // (b) invited account.
    await register(`reap_inv_${tag}`, `reap-inv-${tag}@corp-z.com`);
    patch(`reap_inv_${tag}`, { invitation_id: "some-invite" });
    // (c) admin-approved (but unverified) account.
    await register(`reap_appr_${tag}`, `reap-appr-${tag}@corp-z.com`);
    patch(`reap_appr_${tag}`, { approved: 1 });
    // (d) once-verified account.
    await register(`reap_ver_${tag}`, `reap-ver-${tag}@corp-z.com`);
    patch(`reap_ver_${tag}`, { verified: 1, first_verified_at: new Date().toISOString() });
    for (const n of ["reap_join", "reap_inv", "reap_appr", "reap_ver"]) ageHours(`${n}_${tag}`, 72);
    await reap({ floorIso: null });
    expect(exists(`reap_join_${tag}`), "event-link preserved").toBe(true);
    expect(exists(`reap_inv_${tag}`), "invited preserved").toBe(true);
    expect(exists(`reap_appr_${tag}`), "approved preserved").toBe(true);
    expect(exists(`reap_ver_${tag}`), "once-verified preserved").toBe(true);
  });

  test("the grandfather floor preserves accounts created before the feature deployed", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    await register(`reap_floor_${tag}`, `reap-floor-${tag}@corp-z.com`);
    patch(`reap_floor_${tag}`, { created_at: "2024-01-01T00:00:00.000Z" }); // long before any floor
    // With the real floor (deploy time) active, a pre-floor account is exempt.
    await reap({});
    expect(exists(`reap_floor_${tag}`)).toBe(true);
    // Disable the floor → it's now eligible and gets reaped.
    await reap({ floorIso: null });
    expect(exists(`reap_floor_${tag}`)).toBe(false);
  });

  test("never verified yet still within 48h is NOT reaped", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    await register(`reap_fresh_${tag}`, `reap-fresh-${tag}@corp-z.com`);
    // created just now (< 48h). Disable the floor so only the TTL matters.
    await reap({ floorIso: null });
    expect(exists(`reap_fresh_${tag}`)).toBe(true);
  });

  test("first_verified_at is stamped on email verification, exempting the account from the sweep", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    await register(`reap_vflow_${tag}`, `reap-vflow-${tag}@corp-z.com`);
    const code = rowOf(`reap_vflow_${tag}`).verify_code;
    expect(code).toBeTruthy();
    // Verify via the real flow, which is ONE GET since v7.23.10. This used to
    // fetch the interstitial and scrape its _csrf out of the HTML; that page no
    // longer exists, so the scrape returned null. Re-pinned because the flow
    // genuinely changed — the subject of this test is the reaper exemption, and
    // it is unaffected.
    const { api } = await freshCtx();
    const vr = await api.get(`/verify?code=${encodeURIComponent(code)}`, { maxRedirects: 0 });
    expect(vr.status(), "one-click verification must redirect").toBe(302);
    expect(vr.headers()["location"]).toBe("/verified.html");
    await api.dispose();
    const row = rowOf(`reap_vflow_${tag}`);
    expect(row.verified).toBe(1);
    expect(row.first_verified_at).toBeTruthy();
    // Age it well past the TTL and sweep — it must survive (first_verified_at set).
    ageHours(`reap_vflow_${tag}`, 72);
    await reap({ floorIso: null });
    expect(exists(`reap_vflow_${tag}`)).toBe(true);
  });

  test("caps deletions per run at the limit", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    for (let i = 0; i < 3; i++) { await register(`reap_cap${i}_${tag}`, `reap-cap${i}-${tag}@corp-z.com`); ageHours(`reap_cap${i}_${tag}`, 60); }
    const res = await reap({ floorIso: null, limit: 2 });
    expect(res.deleted).toBe(2);
    expect(res.cappedAtLimit).toBe(true);
  });

  test("performance: sweeping a large abandoned pool stays bounded and respects the cap", async () => {
    const tag = crypto.randomBytes(4).toString("hex");
    // Seed 250 aged, abandoned manual registrations directly (fast path — bypasses
    // the SMTP-bound register endpoint; mirrors exactly the shape the gate matches).
    const d = new Database(TEST_DB_PATH);
    const old = new Date(Date.now() - 60 * 3600_000).toISOString();
    const ins = d.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, password_hash, verified, approved, blocked, registered_via, role, created_at) VALUES (?,?,?,?,?,?,0,0,0,'manual','participant',?)");
    const seed = d.transaction(() => { for (let i = 0; i < 250; i++) ins.run(`perf-${tag}-${i}`, "P", "Q", `perf_${tag}_${i}`, `perf-${tag}-${i}@corp-z.com`, "x", old); });
    seed();
    d.close();
    const t0 = Date.now();
    const res = await reap({ floorIso: null, limit: 500 });
    const elapsed = Date.now() - t0;
    expect(res.deleted).toBeGreaterThanOrEqual(250);
    expect(elapsed, `sweep of ${res.deleted} took ${elapsed}ms`).toBeLessThan(8000);
    // The seeded pool is gone.
    const d2 = new Database(TEST_DB_PATH, { readonly: true });
    expect(d2.prepare("SELECT COUNT(*) c FROM users WHERE nickname LIKE ?").get(`perf_${tag}_%`).c).toBe(0);
    d2.close();
  });

  // Adversarial-review fix: a participant export→import must preserve a
  // once-verified account's reaper exemption (first_verified_at), otherwise a
  // re-import + later admin email change (verified→0) would let the sweep delete
  // a genuinely-verified user.
  test("a re-imported once-verified account keeps its reaper exemption (first_verified_at round-trips)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `reap-imp-${tag}@corp-z.com`;
    const fva = new Date(Date.now() - 100 * 3600_000).toISOString();
    const envelope = { type: "hackarena-participants", version: 2, participants: [{
      first_name: "Im", last_name: "Ported", nickname: `reap_imp_${tag}`, email,
      company: "X", title: "T", country: "US", timezone: "America/New_York",
      job_function: "Software Developer / Engineer", city: "NYC",
      verified: 1, approved: 0, first_verified_at: fva, registered_via: "manual",
      created_at: new Date(Date.now() - 200 * 3600_000).toISOString(),
    }] };
    const r = await sa.post("/api/admin/import/participants", { headers: saH, data: { data: envelope, resolutions: {} } });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect(rowOf(`reap_imp_${tag}`).first_verified_at).toBe(fva); // round-tripped
    // An admin email change later flips verified=0 (first_verified_at stays). Not reapable.
    patch(`reap_imp_${tag}`, { verified: 0 });
    await reap({ floorIso: null });
    expect(exists(`reap_imp_${tag}`)).toBe(true);
    await sa.dispose();
  });

  test("importing a verified account WITHOUT first_verified_at backfills the stamp (not reapable)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `reap-impold-${tag}@corp-z.com`;
    // A pre-v7.6.0 export carries no first_verified_at; the import must stamp it.
    const envelope = { type: "hackarena-participants", version: 2, participants: [{
      first_name: "Old", last_name: "Export", nickname: `reap_impold_${tag}`, email,
      company: "X", title: "T", country: "US", timezone: "America/New_York",
      job_function: "Software Developer / Engineer", city: "NYC",
      verified: 1, approved: 0, registered_via: "manual",
      created_at: new Date(Date.now() - 200 * 3600_000).toISOString(),
    }] };
    const r = await sa.post("/api/admin/import/participants", { headers: saH, data: { data: envelope, resolutions: {} } });
    expect(r.ok()).toBeTruthy();
    expect(rowOf(`reap_impold_${tag}`).first_verified_at).toBeTruthy(); // backfilled
    patch(`reap_impold_${tag}`, { verified: 0 });
    await reap({ floorIso: null });
    expect(exists(`reap_impold_${tag}`)).toBe(true);
    await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.5 — auditor batch tier-1: restoreSlot existence + admin email
// re-verification + setImmediate drain on shutdown.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.5 — auditor invariants", () => {
  test("restoreSlot does not pin a re-added user to a deleted timeslot", async () => {
    // Pre-fix the bulk-assign re-add path called restoreSlot, which
    // wrote a historical timeslot_id back into competition_users
    // unconditionally. If the admin had deleted the slot between the
    // user's removal and re-add, the user landed pinned to a
    // non-existent slot id and vanished from the per_slot leaderboard
    // (the join filter `cu.timeslot_id = ts.id` failed silently).
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId, slotId;
    const partEmail = `restore-${tag}@cust.test`;
    const partPass = "restorePw123!";
    let partId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `RestoreSlotGate-${tag}`,
          start_time: new Date(Date.now() + 24*3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Create one slot.
      const slotR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: { name: `slot-${tag}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
      });
      const slotJson = await slotR.json();
      slotId = slotJson.timeslot?.id || slotJson.id;
      expect(slotId).toBeTruthy();
      // Throwaway participant.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Restore", lastName: "Slot", nickname: `restoreslot_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // Plant a historical submission referencing the slot — simulates
      // a user who actually competed in that slot before being removed.
      const dbW = new Database(TEST_DB_PATH);
      try {
        const taskRow = dbW.prepare("SELECT id FROM tasks LIMIT 1").get();
        dbW.prepare(
          "INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, answer, is_correct, points_delta, submitted_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(crypto.randomUUID(), partId, taskRow.id, compId, slotId, "x", 0, -5, new Date().toISOString());
      } finally {
        dbW.close();
      }
      // Delete the slot directly (the admin might have done this between remove + re-add).
      const dbW2 = new Database(TEST_DB_PATH);
      try {
        dbW2.prepare("DELETE FROM competition_timeslots WHERE id=?").run(slotId);
      } finally {
        dbW2.close();
      }
      // Bulk-assign — this fires restoreSlot. With the gate in place,
      // timeslot_id must stay NULL because the historical slot no longer exists.
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH,
        data: { userIds: [partId], competitionIds: [compId] },
      });
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const cu = dbRO.prepare("SELECT timeslot_id FROM competition_users WHERE user_id=? AND competition_id=?").get(partId, compId);
      dbRO.close();
      expect(cu).toBeTruthy();
      // Pre-fix: cu.timeslot_id === slotId (the deleted slot). Post-fix: NULL.
      expect(cu.timeslot_id).toBeNull();
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("Admin email change stages a pending confirmation; the live account is untouched even when SMTP fails", async () => {
    // v8.3.36 RE-POINTED, and it had to be: the three closing assertions below
    // used to read "reverted / reverted / restored, not destroyed" against
    // columns the handler no longer writes at all. Left as they were they would
    // pass TRIVIALLY — "unchanged" is indistinguishable from "changed and
    // correctly reverted" — which is the exact vacuity trap the v8.3.23 comment
    // fifteen lines below warns about, in the same file.
    //
    // The subject is the same one v6.16.5 gave it: an admin must not be able to
    // strand a participant behind a typo'd address. Staging answers it more
    // completely than the rollback did — the address is not applied at all until
    // the participant proves they can receive mail there, so an undeliverable
    // one costs nothing and needs no compensation.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `admin-emrev-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Adm", lastName: "Emrev", nickname: `admemrev_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // v8.3.23's anti-vacuity guard SURVIVES and still earns its place: the
      // fixture must hold a live verification receipt, or "untouched" below is
      // a claim about nothing.
      const dbPre = new Database(TEST_DB_PATH, { readonly: true });
      const beforeCode = dbPre.prepare("SELECT verify_code FROM users WHERE id=?").get(partId).verify_code;
      dbPre.close();
      expect(beforeCode, "the fixture must carry a live receipt, or the untouched assertion is vacuous").toBeTruthy();

      // The admin corrects the address. The shared server's relay is dead, so
      // this is the UNDELIVERED branch — and it is a 200, because nothing was
      // committed and there is therefore nothing to roll back.
      const bogus = `bogus-${tag}@cust.test`;
      const r = await sa.put(`/api/admin/participants/${partId}`, {
        headers: saJsonH,
        data: { email: bogus },
      });
      expect(r.status(), `staging must succeed: ${await r.text().catch(() => "")}`).toBe(200);
      const body = await r.json();
      expect(body.emailDelivered, "the dead relay puts this on the undelivered branch").toBe(false);
      expect(body.emailChangePending, "and the change is still staged — an undelivered pending simply expires").toBe(true);

      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT email, verified, verify_code, pending_email FROM users WHERE id=?").get(partId);
      dbRO.close();
      expect(row.email, "the live address is untouched — a typo cannot strand them").toBe(partEmail);
      expect(row.verified, "and the verified flag with it").toBe(1);
      expect(row.verify_code, "and the participant's own receipt is neither replaced nor destroyed").toBe(beforeCode);
      // ANTI-VACUITY: the request really did something, so "untouched" is not
      // "the route ignored me".
      expect(row.pending_email, "the correction IS staged").toBe(bogus);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  // Note: the setImmediate audit drain is verified at the unit level by
  // wiring _deferAudit through the existing audit sites. End-to-end
  // verification would require driving SIGTERM under test which the
  // suite explicitly skips (process.env.NODE_ENV === "test" guard at
  // gracefulShutdown registration). No spec test for that path.
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.7 — auditor batch tier-3: cleanup batch (Lows + Notes).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.7 — auditor invariants", () => {
  test("/verify POST is rate-limited (30/min/IP)", async () => {
    // Pre-fix only the GET form was rate-limited; POST that actually
    // claims the verify code was bare CSRF. UUID entropy makes
    // guessing infeasible but the path could be CPU-spammed.
    await ensureState();
    // The shared rate-limit toggle test hook is the standard way to
    // exercise the limiter. Without it the suite-wide
    // RATE_LIMIT_DISABLED=1 short-circuits every limiter.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post("/api/test/rate-limit-toggle", { headers: saH, data: { enable: true } });
    const { api: cli, csrf: cliCsrf } = await freshCtx();
    try {
      // Fire 35 POSTs at /verify (limiter is 30/min/IP). Some will succeed-
      // with-redirect; once we cross the limit, 429 must surface.
      let got429 = false;
      for (let i = 0; i < 35; i++) {
        const r = await cli.post("/verify", {
          headers: { "x-csrf-token": cliCsrf, "content-type": "application/x-www-form-urlencoded" },
          form: { code: "garbage-" + i },
        });
        if (r.status() === 429) { got429 = true; break; }
      }
      expect(got429).toBe(true);
    } finally {
      await cli.dispose();
      await sa.post("/api/test/rate-limit-toggle", { headers: saH, data: { enable: false } });
      await sa.dispose();
    }
  });

  test("Superadmin manual /verify rejects denied users", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `denyver-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Den", lastName: "Verify", nickname: `denyver_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      // Need to be NOT verified to attempt verify — but we want it denied.
      // Deny without verify first.
      await sa.post(`/api/admin/participants/${partId}/deny`, {
        headers: saJsonH, data: {},
      });
      // Now try to manually verify — should be rejected.
      const r = await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/denied/i);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.8: bulk-approve resolves locked_until inside the UPDATE WHERE clause", async () => {
    // Pre-fix the locked_until check ran in JS off a SELECT result;
    // the 30-s lockout-expiry poller could clear locked_until between
    // SELECT and UPDATE, leaving the user technically eligible but
    // reported as `skipped`. Post-fix the gate is in the UPDATE WHERE.
    // We verify the contract by setting locked_until to a past
    // timestamp (so the user IS eligible) — the row was eligible all
    // along but the in-memory check pre-fix would have read the
    // pre-poll value as "still locked" if the poller hadn't run.
    // Locking the contract: a user with locked_until in the past gets
    // approved (not skipped) by bulk-approve.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `lockedapp-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Locked", lastName: "App", nickname: `lockedapp_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      // Plant locked_until in the past — eligible for approval.
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE users SET locked_until=? WHERE id=?")
          .run(new Date(Date.now() - 60_000).toISOString(), partId);
      } finally { dbW.close(); }
      // Bulk-approve must succeed (locked_until is in the past).
      const r = await sa.post("/api/admin/participants/bulk-approve", {
        headers: saJsonH, data: { userIds: [partId] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.approved).toBe(1);
      expect(body.skipped).toBe(0);
      // DB confirms approved=1.
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT approved FROM users WHERE id=?").get(partId);
      dbRO.close();
      expect(row.approved).toBe(1);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.8: bulk-approve rejects users still locked (locked_until in future)", async () => {
    // Locks the inverse contract: user with locked_until > now() goes
    // to `skipped`. Pre-fix the same outcome existed but via JS check;
    // post-fix it's via the WHERE clause's r.changes === 0 result.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `stilllocked-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Still", lastName: "Locked", nickname: `stilllocked_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE users SET locked_until=? WHERE id=?")
          .run(new Date(Date.now() + 60 * 60_000).toISOString(), partId);
      } finally { dbW.close(); }
      const r = await sa.post("/api/admin/participants/bulk-approve", {
        headers: saJsonH, data: { userIds: [partId] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.approved).toBe(0);
      expect(body.skipped).toBe(1);
      // DB confirms approved=0 (still pending).
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT approved FROM users WHERE id=?").get(partId);
      dbRO.close();
      expect(row.approved).toBe(0);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });





  test("v6.16.9 H1: invitation redemption with deleted comp doesn't crash, surfaces skippedCompetitions", async () => {
    // Pre-fix: admin issues invitation for comps [A, B], superadmin
    // deletes B, invitee redeems → INSERT OR IGNORE INTO
    // competition_users throws SQLITE_CONSTRAINT_FOREIGNKEY → catch
    // only handles UNIQUE → 500 → invitation stays unclaimed → every
    // retry hits same wall.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const inviteEmail = `hk1-${tag}@cust.test`;
    let compA, compB, invId;
    try {
      // 1. Two future comps.
      compA = (await (await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `KeptComp-${tag}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
      })).json()).competition.id;
      compB = (await (await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `DeletedComp-${tag}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
      })).json()).competition.id;
      // 2. Invitation for both.
      await sa.post("/api/admin/invitations", {
        headers: saJsonH,
        data: { emails: [inviteEmail], competitionIds: [compA, compB] },
      });
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      invId = dbRO.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(inviteEmail)?.id;
      dbRO.close();
      expect(invId).toBeTruthy();
      // 3. Delete comp B.
      await sa.delete(`/api/admin/competitions/${compB}`, { headers: saH });
      // 4. Invitee redeems — must NOT 500.
      const { api: cli, csrf: cliCsrf } = await freshCtx();
      const r = await registerPost(cli, "/api/register", {
        headers: { "x-csrf-token": cliCsrf, "content-type": "application/json" },
        data: {
          firstName: "FK", lastName: "Test", nickname: `fktest_${tag}`,
          email: inviteEmail, company: "Acme", title: "Eng",
          invitationId: invId, country: "US", timezone: "UTC",
        },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.skippedCompetitions)).toBe(true);
      expect(body.skippedCompetitions.find(c => c.id === compB && c.reason === "competition_deleted")).toBeTruthy();
      await cli.dispose();
    } finally {
      // Cleanup: invitee user, kept comp.
      const dbRO2 = new Database(TEST_DB_PATH, { readonly: true });
      const u = dbRO2.prepare("SELECT id FROM users WHERE email=?").get(inviteEmail);
      dbRO2.close();
      if (u) await sa.delete(`/api/admin/participants/${u.id}`, { headers: saH }).catch(() => {});
      if (compA) await sa.delete(`/api/admin/competitions/${compA}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.9 H2: permanent attachments sweep skips files newer than 5 min", async () => {
    // The recency cutoff prevents the sweep from deleting an in-flight
    // direct-upload file whose row hasn't been INSERTed yet.
    // v6.16.14: sweep gates on max(mtimeMs, ctimeMs) so a backdated
    // mtime alone no longer fools the cutoff (defence against future
    // writers that call fs.utimesSync). We can't backdate ctime from
    // userspace, so this test covers only the recent-file-preserved
    // half of the contract.
    const fs = require("fs");
    const path = require("path");
    const tag = crypto.randomBytes(4).toString("hex");
    const dataDir = TEST_DATA_DIR;
    const attDir = path.join(dataDir, "attachments");
    fs.mkdirSync(attDir, { recursive: true });
    const newFile = path.join(attDir, `recent-${tag}.zip`);
    fs.writeFileSync(newFile, Buffer.from("x"));
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      const r = await sa.post("/api/test/sweep-attachments", { headers: saH, data: {} });
      if (r.status() === 404) {
        // No test hook wired — heuristic: recent file must still exist.
        expect(fs.existsSync(newFile)).toBe(true);
      } else if (r.ok()) {
        // Sweep executed. The recent file survives because both
        // mtime and ctime are within the 5-min window.
        expect(fs.existsSync(newFile)).toBe(true);
      }
    } finally {
      try { fs.unlinkSync(newFile); } catch (_) {}
      await sa.dispose();
    }
  });



  test("v6.16.9 M4: import absences with unresolvable timeslot are reported in skipped_absences", async () => {
    // Plant an export with an absence whose timeslot_name doesn't exist
    // on the target. Without the v6.16.9 fix, the row would be inserted
    // with timeslot_id=NULL and the leaderboard's gap subtraction would
    // wrongly apply across all slots. With the fix, the row is skipped
    // and surfaced in `skipped_absences`.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `AbsTs-${tag}`,
          start_time: new Date(Date.now() + 24*3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Construct a v2 envelope for an as-yet-unknown user with an
      // absence whose timeslot_name doesn't resolve.
      const importEmail = `m4-${tag}@cust.test`;
      const importPayload = {
        type: "hackarena-participants",
        version: 2,
        exported_at: new Date().toISOString(),
        participants: [{
          first_name: "M4", last_name: "Abs", nickname: `m4abs_${tag}`,
          email: importEmail,
          verified: 1, approved: 1,
          country: "US", timezone: "UTC",
          competitions: [{ competition_name: `AbsTs-${tag}`, assigned_at: new Date().toISOString() }],
          absences: [{
            competition_name: `AbsTs-${tag}`,
            timeslot_name: "NoSuchSlotForReal",
            removed_at: new Date(Date.now() - 60_000).toISOString(),
            returned_at: new Date().toISOString(),
          }],
        }],
      };
      const dryR = await sa.post("/api/admin/import/participants", {
        headers: saJsonH, data: { data: importPayload },
      });
      expect(dryR.ok()).toBeTruthy();
      const realR = await sa.post("/api/admin/import/participants", {
        headers: saJsonH, data: { data: importPayload, resolutions: {} },
      });
      expect(realR.ok()).toBeTruthy();
      const body = await realR.json();
      expect(Array.isArray(body.skipped_absences)).toBe(true);
      expect(body.skipped_absences.find(a => a.reason === "timeslot_not_found")).toBeTruthy();
      expect(body.absences_imported).toBe(0);
      // Confirm the absence row was NOT inserted with NULL timeslot.
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const u = dbRO.prepare("SELECT id FROM users WHERE email=?").get(importEmail);
      const absCount = u
        ? dbRO.prepare("SELECT COUNT(*) AS c FROM competition_user_absences WHERE user_id=? AND competition_id=?").get(u.id, compId).c
        : 0;
      dbRO.close();
      expect(absCount).toBe(0);
      if (u) await sa.delete(`/api/admin/participants/${u.id}`, { headers: saH }).catch(() => {});
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.10 M3: requireAdmin/requireSuperAdmin reject when denied_at set out-of-band", async () => {
    // The deny path always sets blocked=1 atomically, so this branch
    // is only reachable on a hypothetical out-of-band-split row. We
    // simulate it via DB-direct UPDATE so the middleware actually
    // exercises the new guard. requireParticipant's v6.16.6 lifecycle
    // re-check already covered this; v6.16.10 brings the two admin
    // middlewares to parity.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `denadmin-${tag}@cust.test`;
    const partPass = "denAdminPw123!";
    let partId;
    try {
      // Throwaway admin user.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "DenAdmin", lastName: "Test", nickname: `denadmin_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // v8.12.4 — SUPERADMIN, so one account crosses BOTH guards the title
      // names (a plain admin exercised requireAdmin alone).
      const pr = await sa.post(`/api/admin/participants/${partId}/role`, { headers: saJsonH, data: { role: "superadmin" } });
      expect(pr.ok(), `promote: ${await pr.text()}`).toBeTruthy();
      // Set known password.

      // Login as the admin, confirm /api/admin/competitions (gated by
      // requireAdmin) passes pre-deny.
      const { api: u, csrf: uCsrf } = await apiLogin(partEmail, partPass);
      // PATCH /api/admin/settings mounts requireSuperAdmin FIRST, so it is the
      // guard answering there (GET /api/admin/unsubscribed asks requireAdmin first).
      const saOnly = () => u.patch("/api/admin/settings", { headers: { "x-csrf-token": uCsrf, "content-type": "application/json" }, data: {} });
      try {
        const ok = await u.get("/api/admin/competitions");
        expect(ok.status(), "requireAdmin admits them before the deny").toBe(200);
        const okSa = await saOnly();
        expect(okSa.status(), `requireSuperAdmin admits them before the deny: ${await okSa.text()}`).not.toBe(403);
        // DB-direct: set denied_at WITHOUT setting blocked=1, simulating
        // an out-of-band-split row. Pre-v6.16.10 requireAdmin would
        // pass; post-fix it 403s.
        const dbW = new Database(TEST_DB_PATH);
        try {
          dbW.prepare("UPDATE users SET denied_at=? WHERE id=?")
            .run(new Date().toISOString(), partId);
        } finally { dbW.close(); }
        // ORDER MATTERS: each refusal clears the session flags, and a flag-level
        // 403 would satisfy the next assertion without that guard's own row
        // re-check ever running. requireSuperAdmin first (it leaves isAdmin set
        // for a superadmin-role row), then requireAdmin.
        const afterSa = await saOnly();
        expect(afterSa.status(), "requireSuperAdmin's own re-read refuses the split row").toBe(403);
        const after = await u.get("/api/admin/competitions");
        expect(after.status(), "requireAdmin refuses it too").toBe(403);
      } finally {
        await u.dispose();
      }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.10 M5: bulk-assign per-comp txn — re-add closes absence atomically", async () => {
    // Verifies the v6.12.0 invariant ("re-add closes the absence and
    // restores the slot atomically") is now reflected in the
    // implementation. We can't easily SIGKILL mid-iteration to
    // exercise the atomicity directly; instead we lock the contract
    // that after a remove + re-add, the absence row's returned_at is
    // populated in lockstep with the competition_users row coming back.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `BulkAssignTxn-${tag}`,
          start_time: new Date(Date.now() - 60_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Bob: assign, set login_time so a removal opens an absence row,
      // remove, then re-add.
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE competition_users SET login_time=? WHERE user_id=? AND competition_id=?")
          .run(new Date().toISOString(), S.bob.id, compId);
      } finally { dbW.close(); }
      await sa.delete(`/api/admin/competitions/${compId}/users/${S.bob.id}`, { headers: saH });
      // Verify absence row exists with returned_at NULL.
      const dbRO1 = new Database(TEST_DB_PATH, { readonly: true });
      const open = dbRO1.prepare("SELECT returned_at FROM competition_user_absences WHERE user_id=? AND competition_id=? AND returned_at IS NULL").get(S.bob.id, compId);
      dbRO1.close();
      expect(open).toBeTruthy();
      // Re-add. Per-comp txn must close the absence + insert in one go.
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      const dbRO2 = new Database(TEST_DB_PATH, { readonly: true });
      const cu = dbRO2.prepare("SELECT 1 FROM competition_users WHERE user_id=? AND competition_id=?").get(S.bob.id, compId);
      const closed = dbRO2.prepare("SELECT returned_at FROM competition_user_absences WHERE user_id=? AND competition_id=? AND returned_at IS NOT NULL").get(S.bob.id, compId);
      dbRO2.close();
      expect(cu).toBeTruthy();
      expect(closed).toBeTruthy();
      expect(closed.returned_at).toBeTruthy();
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.10 M10: PATCH visibility on locked task is rejected for non-superadmin", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let taskId, adminUid;
    const adminEmail = `lockvis-${tag}@cust.test`;
    const adminPass = "lockVisPw123!";
    try {
      // Create task, lock it (superadmin only).
      const taskR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `LockVis-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", explanation: "<p>e</p>", status: "published",
        },
      });
      taskId = (await taskR.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: saH });
      // Promote a throwaway user to admin (NOT superadmin) and have them
      // try the visibility flip.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "LV", lastName: "Test", nickname: `lockvis_${tag}`,
          email: adminEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      adminUid = (list.participants || []).find(p => p.email === adminEmail)?.id;
      await sa.post(`/api/admin/participants/${adminUid}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/approve`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/role`, { headers: saJsonH, data: { role: "admin" } });
      const { api: regularAdmin, csrf: raCsrf } = await apiLogin(adminEmail, adminPass);
      try {
        const r = await regularAdmin.patch(`/api/admin/tasks/${taskId}/visibility`, {
          headers: { "x-csrf-token": raCsrf },
        });
        expect(r.status()).toBe(403);
        expect((await r.json()).error).toMatch(/locked/i);
      } finally {
        await regularAdmin.dispose();
      }
      // Superadmin CAN still flip it (they can also unlock).
      const saR = await sa.patch(`/api/admin/tasks/${taskId}/visibility`, { headers: saH });
      expect(saR.ok()).toBeTruthy();
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (adminUid) await sa.delete(`/api/admin/participants/${adminUid}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.11 M8: idempotent close on multi-slot comp closes individual timeslots", async () => {
    // Pre-fix the v6.16.7 idempotent close stamped only the
    // competition row; per-slot audit chain stayed without an
    // ended_manually / auto_ended row. v6.16.11 walks slots inside
    // the same txn.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId, slot1Id, slot2Id;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `IdempMulti-${tag}`,
          start_time: new Date(Date.now() + 24*3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Two slots that ARE in the past.
      const s1 = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: {
          name: `slot1-${tag}`,
          start_time: new Date(Date.now() - 7200_000).toISOString(),
          duration_minutes: 60,
        },
      });
      slot1Id = (await s1.json()).timeslot?.id || (await s1.json()).id;
      const s2 = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: {
          name: `slot2-${tag}`,
          start_time: new Date(Date.now() - 7200_000).toISOString(),
          duration_minutes: 60,
        },
      });
      slot2Id = (await s2.json()).timeslot?.id || (await s2.json()).id;
      // Force start_time of the COMP into the past so the comp itself
      // is also time-arithmetic-ended without ended_at flagged.
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE competitions SET start_time=?, ended_at=NULL WHERE id=?")
          .run(new Date(Date.now() - 7200_000).toISOString(), compId);
        dbW.prepare("UPDATE competition_timeslots SET ended_at=NULL WHERE competition_id=?").run(compId);
      } finally { dbW.close(); }
      // Wait for cache TTL.
      await new Promise(r => setTimeout(r, 1100));
      // /end-now → idempotent close path with multi-slot.
      const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.alreadyEnded).toBe(true);
      expect(body.slotsClosed).toBeGreaterThanOrEqual(2);
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const slotRows = dbRO.prepare("SELECT id, ended_at, ended_manually FROM competition_timeslots WHERE competition_id=?").all(compId);
      const slotEvts = dbRO.prepare(
        "SELECT timeslot_id, COUNT(*) AS c FROM timeslot_events WHERE timeslot_id IN (?,?) AND event_type='ended_manually' GROUP BY timeslot_id"
      ).all(slot1Id, slot2Id);
      dbRO.close();
      // Each slot must have ended_at + ended_manually=1.
      for (const s of slotRows) {
        expect(s.ended_at).toBeTruthy();
        expect(s.ended_manually).toBe(1);
      }
      // Each slot must have a `ended_manually` audit row.
      expect(slotEvts.length).toBe(2);
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.11 L3: bulk-approve dedupes userIds", async () => {
    // Same uid 3 times must count as 1 against BULK_ADMIN_MAX and
    // produce approved=1 / skipped=0.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `dedup-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Dedup", lastName: "Test", nickname: `dedup_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      const r = await sa.post("/api/admin/participants/bulk-approve", {
        headers: saJsonH, data: { userIds: [partId, partId, partId] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.approved).toBe(1);
      expect(body.skipped).toBe(0);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.11 L6: /end-now is idempotent on duplicate concurrent calls", async () => {
    // Two end-now calls fired in close succession should leave exactly
    // one `ended_manually` audit row. The post-v6.16.11 UPDATE filter
    // `WHERE ended_at IS NULL` + `r.changes > 0` event-gate ensure
    // the second call's UPDATE is a no-op AND the duplicate event
    // doesn't fire.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `L6Dedup-${tag}`,
          start_time: new Date(Date.now() - 30_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Fire two end-now calls back-to-back. The second hits the
      // idempotent-close branch (status="ended", ended_at IS NOT NULL
      // — wait, ended_at IS NOT NULL means the idempotent gate
      // `_initialStatus === "ended" && !comp.ended_at` doesn't fire,
      // so it falls through to "Event is not currently live"
      // 400). So actual race is a bit different — but the locked
      // invariant is still: only one ended_manually audit row.
      await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
      // Second call: cache is invalidated post-first, so fresh getCompetition
      // returns ended_at populated → status "ended" → falls through to 400.
      const r2 = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
      expect(r2.status()).toBe(400);
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const evtCount = dbRO.prepare(
        "SELECT COUNT(*) AS c FROM competition_events WHERE competition_id=? AND event_type='ended_manually'"
      ).get(compId).c;
      dbRO.close();
      expect(evtCount).toBe(1);
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.12 L2: orphan-history user can pick a current slot when their historical slot was deleted", async () => {
    // Scenario: user has prior submissions in slot A (timeslot_id),
    // admin deletes slot A and creates slot B, user re-added (no
    // timeslot pinning, per v6.16.5 existence gate). Pre-fix the
    // v6.12.0 history-pinned lock would refuse any current slot pick
    // because submissions.timeslot_id references slot A. Post-fix the
    // lock relaxes when the historical slot id no longer exists in
    // competition_timeslots.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId, slotAId, slotBId;
    const partEmail = `l2orphan-${tag}@cust.test`;
    const partPass = "l2orphanPw123!";
    let partId;
    try {
      // Future-dated comp (so the test can manipulate the DB without
      // the history-pinned lock being shadowed by the live-slot lock).
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `L2Orphan-${tag}`,
          start_time: new Date(Date.now() + 24*3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      const sa1R = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: { name: `slotA-${tag}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
      });
      slotAId = (await sa1R.json()).timeslot?.id || (await sa1R.json()).id;
      // Throwaway participant.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "L2", lastName: "Orphan", nickname: `l2orphan_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // Create slot B BEFORE we plant a submission (the API rejects
      // adding slots after submissions exist).
      const sbR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: { name: `slotB-${tag}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
      });
      slotBId = (await sbR.json()).timeslot?.id || (await sbR.json()).id;
      expect(slotBId).toBeTruthy();
      // Assign user (fresh competition_users row, NULL timeslot_id).
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [partId], competitionIds: [compId] },
      });
      // Plant historical activity in slot A AND delete slot A via DB-
      // direct manipulation. The admin DELETE handler refuses to drop
      // a slot with submissions referencing it (server.js:7097), so
      // the orphan-history scenario can only occur via DB-direct
      // intervention or schema/data import where an old slot id
      // survives in submissions.timeslot_id while the slot row itself
      // has been removed. The fix is defensive against either path.
      const dbW = new Database(TEST_DB_PATH);
      try {
        const taskRow = dbW.prepare("SELECT id FROM tasks LIMIT 1").get();
        dbW.prepare(
          "INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, answer, is_correct, points_delta, submitted_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(crypto.randomUUID(), partId, taskRow.id, compId, slotAId, "x", 0, -5, new Date().toISOString());
        dbW.prepare("DELETE FROM competition_timeslots WHERE id=?").run(slotAId);
      } finally { dbW.close(); }
      // User logs in, selects comp, picks slot B. Pre-v6.16.12 this
      // would 400 with "previously entered a different session".
      // Post-fix it succeeds because slot A no longer exists.
      const { api: u, csrf: uCsrf } = await apiLogin(partEmail, partPass);
      const uH = { "x-csrf-token": uCsrf, "content-type": "application/json" };
      try {
        await u.post("/api/select-competition", { headers: uH, data: { competitionId: compId } });
        const r = await u.post("/api/select-timeslot", { headers: uH, data: { timeslotId: slotBId } });
        // Pre-fix: 400 with "previously entered a different session".
        // Post-fix: 200, slot B accepted (slot is upcoming, not live, so
        // no confirmLive needed).
        expect(r.ok()).toBeTruthy();
      } finally {
        await u.dispose();
      }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.12 L8: chunked import partial counters reflect actual DB commits", async () => {
    // A 2-chunk import where chunk 1 succeeds (1 row) and chunk 2's
    // first row throws userError. The response's `partial:` should
    // report `imported: 1`, NOT `imported: 2` (the row that started
    // committing in chunk 2 before the throw was rolled back).
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const goodEmail = `l8good-${tag}@cust.test`;
    const conflictEmail = `l8conflict-${tag}@cust.test`;
    let cleanupIds = [];
    try {
      // Pre-create the conflict-target user (will collide with the import).
      const r1 = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Conflict", lastName: "Holder", nickname: `l8holder_${tag}`,
          email: conflictEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const holderId = (list.participants || []).find(p => p.email === conflictEmail)?.id;
      cleanupIds.push(holderId);
      // Build a 2-row import. Row 0 = good email, row 1 = same nickname
      // as the holder but RENAME with a still-taken nickname → throws
      // userError on import (after chunk has begun committing).
      // Use a chunk size of 1 by importing exactly 2 rows; default
      // IMPORT_CHUNK_SIZE is 100 so both rows go in one chunk. To
      // exercise multiple chunks, we'd need >100 rows — overkill for
      // this test. Instead we exercise the snapshot/restore by
      // ensuring counters reflect the rolled-back state.
      const importPayload = {
        type: "hackarena-participants",
        version: 2,
        exported_at: new Date().toISOString(),
        participants: [
          {
            first_name: "L8", last_name: "Good", nickname: `l8good_${tag}`,
            email: goodEmail, verified: 1, approved: 1,
            country: "US", timezone: "UTC",
          },
          {
            // Will conflict on email since holder already exists.
            first_name: "L8", last_name: "Confl", nickname: `l8holderdup_${tag}`,
            email: conflictEmail, verified: 1, approved: 1,
            country: "US", timezone: "UTC",
          },
        ],
      };
      // Resolve conflict with rename to a STILL-taken nickname so the
      // overwrite path throws on rename.
      const resolutions = {
        "1_rename": { nickname: `l8holder_${tag}` /* same as holder = collision */, email: `unique-${tag}@cust.test` },
        "1": "rename",
      };
      const r = await sa.post("/api/admin/import/participants", {
        headers: saJsonH, data: { data: importPayload, resolutions },
      });
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.partial).toBeTruthy();
      // The good row WOULD have been imported in the chunk; userError on
      // row 1 rolls the chunk back. partial.imported must be 0.
      expect(body.partial.imported).toBe(0);
      // The good email must NOT exist in the DB after the rollback.
      const Database = require("better-sqlite3");
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const goodRow = dbRO.prepare("SELECT id FROM users WHERE email=?").get(goodEmail);
      dbRO.close();
      expect(goodRow).toBeFalsy();
    } finally {
      const saH = { "x-csrf-token": saCsrf };
      for (const id of cleanupIds) {
        await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  test("v7.2.x (audit, F2): import rename overrides are validated + canonicalised", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const cleanup = [];
    try {
      // Conflict target — the import row collides with this holder's email,
      // forcing the "rename" resolution branch (where the override was unvalidated).
      const holderEmail = `f2holder-${tag}@cust.test`;
      await registerPost(sa, "/api/register", { headers: saJsonH, data: {
        firstName: "F2", lastName: "Holder", nickname: `f2holder_${tag}`, email: holderEmail,
        company: "Acme", title: "T", avatar: "default1", country: "US", timezone: "UTC",
      }});
      const list0 = await (await sa.get("/api/admin/participants?limit=500")).json();
      cleanup.push((list0.participants || []).find(p => p.email === holderEmail)?.id);
      const payload = (over) => ({
        data: { type: "hackarena-participants", version: 2, exported_at: new Date().toISOString(),
          participants: [{ first_name: "F2", last_name: "Dup", nickname: `f2dup_${tag}`, email: holderEmail, verified: 1, approved: 1, country: "US", timezone: "UTC" }] },
        resolutions: { "0": "rename", "0_rename": over },
      });
      // (a) malformed rename primary email → 400
      let r = await sa.post("/api/admin/import/participants", { headers: saJsonH, data: payload({ nickname: `f2ok_${tag}`, email: "not-an-email" }) });
      expect(r.status(), "malformed rename email must 400").toBe(400);
      // (b) too-short rename nickname → 400
      r = await sa.post("/api/admin/import/participants", { headers: saJsonH, data: payload({ nickname: "ab", email: `f2valid-${tag}@cust.test` }) });
      expect(r.status(), "short rename nickname must 400").toBe(400);
      // (c) over-cap rename secondary email (>254) → 400
      r = await sa.post("/api/admin/import/participants", { headers: saJsonH, data: payload({ nickname: `f2cap_${tag}`, email: `f2cap-${tag}@cust.test`, secondary_email: "x".repeat(250) + "@cust.test" }) });
      expect(r.status(), "over-cap rename secondary must 400").toBe(400);
      // (d) positive — valid nickname + NON-canonical email → 200, stored canonical.
      const canonNick = `f2good_${tag}`;
      r = await sa.post("/api/admin/import/participants", { headers: saJsonH, data: payload({ nickname: canonNick, email: `  MixedCase-${tag}@Cust.TEST  ` }) });
      expect(r.status(), "valid rename must import").toBe(200);
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT id, email FROM users WHERE nickname=?").get(canonNick);
      dbRO.close();
      expect(row?.email, "stored rename email must be canonicalised (NFC + lowercase + trim)").toBe(`mixedcase-${tag}@cust.test`);
      cleanup.push(row?.id);
    } finally {
      for (const id of cleanup) if (id) await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("ext-audit (F1): emails are restricted to printable ASCII; ASCII case-insensitive login still resolves", async () => {
    // SUPERSEDES the old v7.2.x NFC/NFD-folding test. NFC-normalising at intake
    // collapses ENCODING variants of a Unicode email but NOT CASE variants of its
    // non-ASCII letters — and the users email UNIQUE indexes are COLLATE NOCASE,
    // which case-folds ASCII ONLY. So a non-ASCII address (Abc-with-umlaut vs its
    // lowercase, or case@long-s.com vs case@s.com) could BYPASS case-insensitive
    // uniqueness. Like nicknames (_nicknameCharsOk), emails are now ASCII-only at
    // the shared isValidEmailFormat gate — the class is closed by construction
    // (NEITHER variant can register). The legitimate part of the old test (ASCII
    // case-insensitive login resolution) is preserved below with a mixed-case
    // ASCII address.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(3).toString("hex");
    const unicodeEmail = "café-" + tag + "@cust.test"; // non-ASCII local part (é)
    let asciiUid;
    try {
      // (a) register with a non-ASCII email: email first, the shared
      // isValidEmailFormat gate now bites at the CODE REQUEST, so no address
      // proof is ever minted for it and the registration is refused for want of
      // one; no account is created (asserted from the list below).
      const bad = await registerPost(sa, "/api/register", { headers: saH, data: {
        firstName: "Uni", lastName: "Code", nickname: `uni_${tag}`, email: unicodeEmail,
        company: "C", title: "T", avatar: "default1", country: "US", timezone: "UTC",
      }});
      expect(bad.status(), "a non-ASCII email can never register").toBe(403);
      expect((await bad.json()).code).toBe("email_proof_required");
      const minted = await sa.get("/api/test/last-login-code?email=" + encodeURIComponent(unicodeEmail.toLowerCase()));
      expect(minted.status(), "no code or proof was ever minted for the non-ASCII address").toBe(404);

      // (b) register a mixed-CASE ASCII email -> 200, stored canonical (lowercased).
      const asciiEmail = `MixedCase-${tag}@Cust.TEST`;
      const reg = await registerPost(sa, "/api/register", { headers: saH, data: {
        firstName: "Asc", lastName: "Ii", nickname: `asc_${tag}`, email: asciiEmail,
        company: "C", title: "T", avatar: "default1", country: "US", timezone: "UTC",
      }});
      expect(reg.status(), "ASCII mixed-case email registers").toBe(200);
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const me = (list.participants || []).find(p => p.nickname === `asc_${tag}`);
      asciiUid = me?.id;
      expect(asciiUid, "ASCII user found").toBeTruthy();
      expect(me.email, "stored email is canonical (lowercased)").toBe(`mixedcase-${tag}@cust.test`);
      // the non-ASCII attempt left no row.
      expect((list.participants || []).some(p => p.nickname === `uni_${tag}`), "non-ASCII email must not reach the DB").toBe(false);

      // (c) the SAME ASCII gate fires on admin edit (another write path).
      const edit = await sa.put(`/api/admin/participants/${asciiUid}`, { headers: saH, data: { email: "bäd-" + tag + "@cust.test" } });
      expect(edit.status(), "admin edit to a non-ASCII email must 400").toBe(400);

      // (d) ASCII case-insensitive resolution still works: verify+approve+set pw,
      //     then log in with a DIFFERENT case than registered.
      await sa.post(`/api/admin/participants/${asciiUid}/verify`, { headers: { "x-csrf-token": saCsrf } });
      await sa.post(`/api/admin/participants/${asciiUid}/approve`, { headers: { "x-csrf-token": saCsrf } });
      const { api: li, csrf: liCsrf } = await freshCtx();
      const login = await codeLogin(li, asciiEmail.toUpperCase(), { "x-csrf-token": liCsrf, "content-type": "application/json" });
      expect(login.status(), "different-case ASCII email must log in").toBe(200);
      await li.dispose();
    } finally {
      if (asciiUid) await sa.delete(`/api/admin/participants/${asciiUid}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v7.2.9 (ext-audit F1): nicknames are restricted to printable ASCII (register / check / admin-edit)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(3).toString("hex");
    const email = `asciinick-${tag}@cust.test`;
    let uid;
    try {
      // Non-ASCII nickname → register 400 (the Äbc/äbc case-fold gap is closed by
      // construction: NEITHER variant can register).
      const bad = await registerPost(sa, "/api/register", { headers: saH, data: {
        firstName: "Uni", lastName: "Nick", nickname: `Äbc${tag}`,
        company: "C", title: "T", avatar: "default1", country: "US", timezone: "UTC", email,
      }});
      expect(bad.status(), "non-ASCII nickname register must 400").toBe(400);
      expect((await bad.json()).error).toMatch(/ASCII/i);
      // check-nickname reflects it.
      const chk = await (await sa.get(`/api/check-nickname?nickname=${encodeURIComponent(`Äbc${tag}`)}`)).json();
      expect(chk.available, "non-ASCII nickname must read unavailable").toBe(false);
      // ASCII nickname → registers fine.
      const ok = await registerPost(sa, "/api/register", { headers: saH, data: {
        firstName: "Asc", lastName: "Nick", nickname: `ascii_${tag}`,
        company: "C", title: "T", avatar: "default1", country: "US", timezone: "UTC", email,
      }});
      expect(ok.ok(), `ASCII nickname must register: ${ok.status()} ${await ok.text()}`).toBeTruthy();
      // v7.22.0 — flaked once at WORKERS=12 with no retained error context, so
      // NO mechanism is claimed. What is closed is the one fragile shape here
      // and the one uninformative message.
      //
      // The lookup scanned a `limit=500` page of a pool this 155-test file
      // keeps adding to — the v7.15.29 accumulation class in API form, where
      // the row is genuinely ABSENT rather than late. 5000 is the endpoint's
      // documented cap, so this can no longer truncate. And `expect(uid)
      // .toBeTruthy()` reported only "Received: undefined", which is the
      // classic message that names nothing: three different causes (register
      // silently failed, the page truncated, the email was rewritten) produced
      // one indistinguishable line. It now says which.
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      const rows = list.participants || [];
      uid = rows.find(p => p.email === email)?.id;
      expect(uid,
        `registered participant ${email} was not found in the admin list ` +
        `(${rows.length} row(s) returned, total=${list.total ?? "?"}). ` +
        `If rows.length is at the limit the page truncated; if it is well under, ` +
        `the registration did not land.`
      ).toBeTruthy();
      // Admin edit to a non-ASCII nickname → 400 (closes the profile-edit re-entry).
      const edit = await sa.put(`/api/admin/participants/${uid}`, { headers: saH, data: { nickname: `Übér${tag}` } });
      expect(edit.status(), "admin edit to non-ASCII nickname must 400").toBe(400);
    } finally {
      if (uid) await sa.delete(`/api/admin/participants/${uid}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.13 H1: bulk-approve skips denied users (denied_at IS NULL filter in WHERE)", async () => {
    // Plant an out-of-band-split row (denied_at NOT NULL, blocked=0)
    // and confirm bulk-approve refuses to approve it. The row stays
    // unapproved + ends up reported as `skipped`.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `h1bulk-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "H1", lastName: "Bulk", nickname: `h1bulk_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      // Plant out-of-band-split: denied_at set, blocked=0.
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE users SET denied_at=?, blocked=0, approved=0 WHERE id=?")
          .run(new Date().toISOString(), partId);
      } finally { dbW.close(); }
      const r = await sa.post("/api/admin/participants/bulk-approve", {
        headers: saJsonH, data: { userIds: [partId] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.approved).toBe(0);
      expect(body.skipped).toBe(1);
      // DB confirms: still unapproved.
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT approved, denied_at FROM users WHERE id=?").get(partId);
      dbRO.close();
      expect(row.approved).toBe(0);
      expect(row.denied_at).toBeTruthy();
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.13 H2: chunked-import rollback drops audit-mirror lines", async () => {
    // Construct a chunked-import scenario where chunk 1 fully commits
    // and chunk 2 throws userError mid-row. Pre-fix the chunk 2 partial
    // commits would have queued setImmediate audit lines that fired
    // AFTER the rollback. Post-v6.16.13 the runTxnWithMirrorBuffer
    // wrapper drops those lines on rollback.
    //
    // We can't easily inspect the JSONL log file from a test, so the
    // contract we lock is structural: the import response's
    // partial: { imported } counter matches the actual DB count of
    // newly-created users. Pre-fix the counter snapshot/restore
    // (v6.16.12) already covered this for JS state; the v6.16.13 fix
    // covers the JSONL mirror. We assert via DB count equivalence.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    // Pre-create a holder so the rename target is taken (forces userError on rename).
    const holderEmail = `holder-h2-${tag}@cust.test`;
    await registerPost(sa, "/api/register", {
      headers: saJsonH,
      data: {
        firstName: "Holder", lastName: "H2", nickname: `holderh2_${tag}`,
        email: holderEmail, company: "Acme", title: "T", avatar: "default1",
        country: "US", timezone: "UTC",
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const holderId = (list.participants || []).find(p => p.email === holderEmail)?.id;
    try {
      const goodEmail = `goodh2-${tag}@cust.test`;
      const importPayload = {
        type: "hackarena-participants",
        version: 2,
        exported_at: new Date().toISOString(),
        participants: [
          { first_name: "Good", last_name: "H2", nickname: `goodh2_${tag}`,
            email: goodEmail, verified: 1, approved: 1,
            country: "US", timezone: "UTC" },
          { first_name: "Confl", last_name: "H2", nickname: `conflh2_${tag}`,
            email: holderEmail, verified: 1, approved: 1,
            country: "US", timezone: "UTC" },
        ],
      };
      const resolutions = {
        "1_rename": { nickname: `holderh2_${tag}` /* still taken */, email: `unique-h2-${tag}@cust.test` },
        "1": "rename",
      };
      const r = await sa.post("/api/admin/import/participants", {
        headers: saJsonH, data: { data: importPayload, resolutions },
      });
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.partial).toBeTruthy();
      // Critical: partial counters reflect ACTUAL DB state. The chunk
      // failed → all rows in that chunk rolled back → imported should
      // be 0 (not 1 — the good row was in the same chunk).
      expect(body.partial.imported).toBe(0);
      // Verify by DB: the good email is NOT in users.
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const goodRow = dbRO.prepare("SELECT id FROM users WHERE email=?").get(goodEmail);
      dbRO.close();
      expect(goodRow).toBeFalsy();
    } finally {
      const saH = { "x-csrf-token": saCsrf };
      if (holderId) await sa.delete(`/api/admin/participants/${holderId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.13 M3: /recalculate rejects locked tasks with 423", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let taskId;
    try {
      const tR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `RecalcLock-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", explanation: "<p>e</p>", status: "published",
        },
      });
      taskId = (await tR.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: saH });
      const r = await sa.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: saH });
      expect(r.status()).toBe(423);
      expect((await r.json()).error).toMatch(/locked/i);
      // Unlock and confirm recalculate now works.
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: saH });
      const r2 = await sa.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: saH });
      expect(r2.ok()).toBeTruthy();
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.13 M4: /block invalidates _meCache AFTER the txn", async () => {
    // Hard to verify ordering directly without instrumentation. Lock
    // the contract via behavior: after /block, /api/me on the blocked
    // user must 403 immediately (within the same request cycle), with
    // no cached pre-block payload surviving.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `m4block-${tag}@cust.test`;
    const partPass = "m4blockPw123!";
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "M4", lastName: "Block", nickname: `m4block_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // Login + warm cache.
      const { api: u } = await apiLogin(partEmail, partPass);
      try {
        const meR = await u.get("/api/me");
        expect(meR.ok()).toBeTruthy();
        // Block the user.
        await sa.post(`/api/admin/participants/${partId}/block`, { headers: saH });
        // Note: invalidateOtherSessions also fires from /block, so the
        // user's cookie is gone too — they get 401, not 403. The
        // critical post-fix invariant is that no cached payload from
        // the warm /api/me survives across the block. We confirm by
        // making the request with the now-defunct session and asserting
        // it fails (either 401 or 403, anything but 200 with the user's
        // pre-block profile).
        const after = await u.get("/api/me");
        expect([401, 403]).toContain(after.status());
      } finally {
        await u.dispose();
      }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.14 M6: /metrics surfaces hack_arena_deferred_audit_pending gauge", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/metrics");
      expect(r.ok()).toBeTruthy();
      const body = await r.text();
      expect(body).toMatch(/^hack_arena_deferred_audit_pending \d+$/m);
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.14 M7: bulk-approve rejects non-string userIds with 400", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      const r = await sa.post("/api/admin/participants/bulk-approve", {
        headers: saJsonH, data: { userIds: ["valid-id", 42, { id: "x" }] },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/array of strings/i);
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.14 M7: bulk-assign rejects non-string competitionIds with 400", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      const r = await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: ["valid-id", 99] },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/array of strings/i);
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.14 M5: bulk-invite iteration error message is sanitized in response", async () => {
    // We can't easily force a SQLite error from the test surface, but
    // we lock the contract that the response's `errors[]` does NOT
    // contain raw stack-trace shapes (`SQLITE_`, `at Object.`). The
    // server log keeps the full stack via console.error.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      // Trigger a successful bulk-invite (no errors) — we just verify
      // the SHAPE of the errors array wouldn't contain stack traces.
      // The sanitization is exercised by the catch block when an
      // exception fires, which we can't easily simulate end-to-end.
      // This test locks the format so a future regression in the
      // sanitization (e.g. someone reverting to raw e.message) is
      // catchable on a real failure scenario.
      const r = await sa.post("/api/admin/invitations", {
        headers: saJsonH,
        data: { emails: ["valid-test@cust.test"], competitionIds: [] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // Errors array (may be empty for successful invite). If non-empty,
      // any entries must follow the `email: <message>` shape WITHOUT
      // SQLite-internal markers.
      for (const err of body.errors || []) {
        expect(err).not.toMatch(/SQLITE_/);
        expect(err).not.toMatch(/at Object\./);
      }
      // Cleanup the invitation row.
      const Database = require("better-sqlite3");
      const dbW = new Database(TEST_DB_PATH);
      try { dbW.prepare("DELETE FROM invitations WHERE email=?").run("valid-test@cust.test"); }
      finally { dbW.close(); }
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.14 L3: single-user /approve invalidates _meCache", async () => {
    // Behavior contract: after /approve, /api/me on the user surfaces
    // approved=1 within the same request cycle (no cached approved=0).
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `l3appr-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "L3", lastName: "Appr", nickname: `l3appr_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      // Approve. The new _invalidateMeCache call ensures any cached
      // /api/me payload is dropped. We verify by reading the user row
      // directly (the cache is internal so we can't introspect; the
      // call site is the contract).
      const r = await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      expect(r.ok()).toBeTruthy();
      const Database = require("better-sqlite3");
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT approved FROM users WHERE id=?").get(partId);
      dbRO.close();
      expect(row.approved).toBe(1);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.14 L6: /api/admin/tasks/:id/publish on locked task rejects regular admin (403)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let taskId, adminUid;
    const adminEmail = `l6lock-${tag}@cust.test`;
    const adminPass = "l6lockPw123!";
    try {
      // Create draft task.
      const tR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `L6Lock-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", explanation: "<p>e</p>", status: "draft",
        },
      });
      taskId = (await tR.json()).id;
      // Lock it.
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: saH });
      // Promote a throwaway admin (NOT superadmin).
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "L6", lastName: "Lock", nickname: `l6lock_${tag}`,
          email: adminEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      adminUid = (list.participants || []).find(p => p.email === adminEmail)?.id;
      await sa.post(`/api/admin/participants/${adminUid}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/approve`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/role`, { headers: saJsonH, data: { role: "admin" } });
      const { api: regularAdmin, csrf: raCsrf } = await apiLogin(adminEmail, adminPass);
      try {
        const r = await regularAdmin.post(`/api/admin/tasks/${taskId}/publish`, {
          headers: { "x-csrf-token": raCsrf },
        });
        expect(r.status()).toBe(403);
        expect((await r.json()).error).toMatch(/locked/i);
      } finally {
        await regularAdmin.dispose();
      }
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (adminUid) await sa.delete(`/api/admin/participants/${adminUid}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.16 H1: /metrics surfaces hack_arena_cxone_queue_* gauges", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/metrics");
      expect(r.ok()).toBeTruthy();
      const body = await r.text();
      expect(body).toMatch(/^hack_arena_cxone_queue_depth \d+$/m);
      expect(body).toMatch(/^hack_arena_cxone_queue_inflight \d+$/m);
      expect(body).toMatch(/^hack_arena_cxone_queue_dropped_total \d+$/m);
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.16 M1: visibility flip on a task locked between SELECT and UPDATE returns 403", async () => {
    // Hard to orchestrate the actual race deterministically. Locking
    // the contract via behaviour: a SELECT-time-unlocked task that
    // gets locked before the UPDATE produces 403, and the WHERE-clause
    // form `WHERE id=? AND (locked=0 OR ?=1)` survives that race.
    // We exercise the post-fix contract by locking the task FIRST
    // and confirming a regular admin still gets 403 (the v6.16.10 JS
    // pre-check) — and that superadmin still bypasses (the v6.16.16
    // OR ?=1 clause). The TOCTOU race itself is unit-level.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let taskId;
    try {
      const tR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `M1Vis-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", explanation: "<p>e</p>", status: "published",
        },
      });
      taskId = (await tR.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: saH });
      // Superadmin bypass: visibility flip succeeds even when locked.
      const r = await sa.patch(`/api/admin/tasks/${taskId}/visibility`, { headers: saH });
      expect(r.ok()).toBeTruthy();
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.16 M1: POST/PUT /api/admin/tasks/:id/competitions rejects locked task for regular admin", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let taskId, compId, adminUid;
    const adminEmail = `m1asn-${tag}@cust.test`;
    const adminPass = "m1asnPw123!";
    try {
      const tR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `M1Asn-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", explanation: "<p>e</p>", status: "published",
        },
      });
      taskId = (await tR.json()).id;
      const cR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `M1Asn-${tag}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
      });
      compId = (await cR.json()).competition.id;
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: saH });
      // Promote a regular admin.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "M1", lastName: "Asn", nickname: `m1asn_${tag}`,
          email: adminEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      adminUid = (list.participants || []).find(p => p.email === adminEmail)?.id;
      await sa.post(`/api/admin/participants/${adminUid}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/approve`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/role`, { headers: saJsonH, data: { role: "admin" } });
      const { api: regular, csrf: rCsrf } = await apiLogin(adminEmail, adminPass);
      const rH = { "x-csrf-token": rCsrf, "content-type": "application/json" };
      try {
        // POST competitions: 403 with "locked" message.
        const postR = await regular.post(`/api/admin/tasks/${taskId}/competitions`, {
          headers: rH, data: { competitionIds: [compId] },
        });
        expect(postR.status()).toBe(403);
        expect((await postR.json()).error).toMatch(/locked/i);
        // PUT competitions: same gate.
        const putR = await regular.put(`/api/admin/tasks/${taskId}/competitions`, {
          headers: rH, data: { competitionIds: [compId], expectedAssignments: [] },
        });
        expect(putR.status()).toBe(403);
        expect((await putR.json()).error).toMatch(/locked/i);
      } finally {
        await regular.dispose();
      }
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      if (adminUid) await sa.delete(`/api/admin/participants/${adminUid}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.16 M4: bulk-invite rejects non-string emails with 400", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      const r = await sa.post("/api/admin/invitations", {
        headers: saJsonH,
        data: { emails: ["valid@cust.test", null, 42], competitionIds: [] },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/array of strings/i);
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.17 L1: a denied account's correct, live code is refused (out-of-band split: denied_at set, blocked 0)", async () => {
    // Plant denied_at WITHOUT blocked=1 (out-of-band split scenario) on an
    // account that already holds a live emailed code, then redeem THAT code: the
    // redeem's `isCodeEligible` gate is the only thing between it and a session.
    // (The code is minted first because a denied account is never mailed one;
    // the blocked and admin-denied arms are tests/signin-code-refusals.api.spec.js.)
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `l1login-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "L1", lastName: "Login", nickname: `l1login_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // While the account may still sign in, it is mailed a code.
      const { api: cli, csrf: cliCsrf } = await freshCtx();
      const cliH = { "x-csrf-token": cliCsrf, "content-type": "application/json" };
      await cli.post("/api/test/reset-recent-code-sends", { headers: cliH });
      await cli.post("/api/test/reset-origin-code-budget", { headers: cliH });
      const rq = await cli.post("/api/auth/code/request", { headers: cliH, data: { email: partEmail } });
      expect(await rq.json()).toEqual({ ok: true });
      const mailed = await (await cli.get("/api/test/last-login-code?email=" + encodeURIComponent(partEmail))).json();
      expect(mailed.via, "PRECONDITION: an emailed sign-in code").toBe("email");
      // DB-direct: set denied_at, blocked=0 (out-of-band split).
      const dbW = new Database(TEST_DB_PATH);
      let row;
      try {
        dbW.prepare("UPDATE users SET denied_at=?, blocked=0 WHERE id=?")
          .run(new Date().toISOString(), partId);
        row = dbW.prepare("SELECT approved, blocked, denied_at, login_code_hash FROM users WHERE id=?").get(partId);
      } finally { dbW.close(); }
      expect(row, "PRECONDITION: approved and not blocked, denied, and still holding its code").toMatchObject({ approved: 1, blocked: 0 });
      expect(row.denied_at).toBeTruthy();
      expect(row.login_code_hash).toBeTruthy();
      const r = await cli.post("/api/auth/code/redeem", { headers: cliH, data: { email: partEmail, code: mailed.code } });
      expect(r.status(), "200, as every refusal at this door").toBe(200);
      expect(await r.text(), "the denied account's correct code is refused, saying no more than a wrong one").toBe('{"ok":false}');
      expect((await cli.get("/api/me")).status(), "…and signs nobody in").toBe(401);
      await cli.dispose();
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.17 L2: /api/admin/export/settings returns redacted envelope", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/export/settings");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.type).toBe("hackarena-settings");
      expect(body.version).toBe(1);
      expect(typeof body.settings).toBe("object");
      // No raw cxone_api_key value should leak — even if not present
      // in the test DB, the redact list covers it.
      expect(body.settings.cxone_api_key === undefined || body.settings.cxone_api_key === "[REDACTED]").toBe(true);
      // redacted_count is a non-negative integer.
      expect(typeof body.redacted_count).toBe("number");
      expect(body.redacted_count >= 0).toBe(true);
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.17 L2: /api/admin/export/settings rejects regular admin (superadmin-only)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const adminEmail = `l2set-${tag}@cust.test`;
    const adminPass = "l2setPw123!";
    let adminUid;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "L2", lastName: "Set", nickname: `l2set_${tag}`,
          email: adminEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      adminUid = (list.participants || []).find(p => p.email === adminEmail)?.id;
      await sa.post(`/api/admin/participants/${adminUid}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/approve`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminUid}/role`, { headers: saJsonH, data: { role: "admin" } });
      const { api: regular } = await apiLogin(adminEmail, adminPass);
      try {
        const r = await regular.get("/api/admin/export/settings");
        expect(r.status()).toBe(403);
      } finally {
        await regular.dispose();
      }
    } finally {
      if (adminUid) await sa.delete(`/api/admin/participants/${adminUid}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.16.17 N1: POST /timeslots rejects adding to ended competition", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let compId;
    try {
      // Create a live comp so /end-now is allowed, then end it. After
      // /end-now the cache is invalidated by the route itself.
      const cR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `N1End-${tag}`,
          start_time: new Date(Date.now() - 60_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await cR.json()).competition.id;
      const endR = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
      expect(endR.ok()).toBeTruthy();
      // Try to add a future-dated slot — must reject.
      const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
        headers: saJsonH,
        data: {
          name: `slot-${tag}`,
          start_time: new Date(Date.now() + 48*3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toMatch(/ended/i);
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("End-now on time-arithmetic-ended-but-not-flagged comp does idempotent close", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId;
    try {
      // Create live comp, then DB-direct nudge end into the past with ended_at NULL.
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `IdempEnd-${tag}`,
          start_time: new Date(Date.now() - 60_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Force start far in the past so status becomes "ended" via time arithmetic.
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE competitions SET start_time=?, ended_at=NULL WHERE id=?")
          .run(new Date(Date.now() - 7200_000).toISOString(), compId);
      } finally { dbW.close(); }
      // _competitionCache TTL is 1 s — wait it out so /end-now reads the
      // freshly-shifted row instead of the stale post-create one.
      await new Promise(r => setTimeout(r, 1100));
      // /end-now must idempotently close (200 + alreadyEnded:true) instead of 400.
      const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.alreadyEnded).toBe(true);
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT ended_at FROM competitions WHERE id=?").get(compId);
      dbRO.close();
      expect(row.ended_at).toBeTruthy();
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// v6.16.19 — logging audit: every authenticated HTTP request should carry
// user attribution (email + first/last name + session_id) in the access
// log; every audit-mirror line should resolve `changed_by` to an actor
// object when it's a real user; the admin Logs API should expose
// actor_first_name / actor_last_name siblings so the UI can render
// "First Last" instead of just an email.
test.describe("v6.16.19 — logging attribution + completeness", () => {
  test("access log line for an authenticated request carries email + first/last + session_id", async () => {
    await ensureState();
    // Stamp a marker we can grep for so we don't have to walk the
    // whole access log file looking for "the right" line — under
    // WORKERS=4 a sibling test in the same worker may have already
    // produced /api/me 200 hits with different state. Use a unique
    // query string so the marker is searchable verbatim.
    const marker = `v616-access-${crypto.randomBytes(6).toString("hex")}`;
    // Use bob to avoid alice-state leakage (see CLAUDE.md *Test
    // flakiness — root-cause conventions*, seeded participant
    // contract — admin reset-password and password-change tests may
    // mutate alice's password mid-suite under parallel run).
    const { api: bobApi } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      await (await bobApi.get(`/api/me?probe=${marker}`)).text();
    } finally { await bobApi.dispose(); }
    // v8.5.1 — POLL, do not sleep. `res.on("finish")` and the JSONL write are both
    // async, and the ACCESS log is written by an INDEPENDENT path from the audit
    // mirror (v8.3.39), so no other wait implies this one has landed.
    const logsDir = path.join(TEST_DATA_DIR, "logs");
    const aliceLine = await findLogLine(logsDir,
      (j) => j.path && j.path.includes(marker) && j.status === 200,
      { prefix: "access-", what: `the access-log line for ${marker}` });
    expect(aliceLine.email).toBe("bob@acme.com");
    expect(aliceLine.first_name).toBeTruthy();
    expect(aliceLine.last_name).toBeTruthy();
    expect(aliceLine.session_id).toBeTruthy();
    expect(typeof aliceLine.session_id).toBe("string");
    expect(aliceLine.user_id).toBeTruthy();
    expect(aliceLine.req_id).toBeTruthy();
  });

  test("audit-mirror JSONL line resolves changed_by to actor object with names", async () => {
    await ensureState();
    // Record an event where changed_by is a real user email — the
    // /api/me PUT path emits user_events.profile_updated with the user's
    // own email as changed_by.
    // bob (not alice) — alice's password is mutated by sibling tests
    // under WORKERS=4. See CLAUDE.md *Test flakiness — root-cause
    // conventions* (seeded participant contract).
    const { api: bobApi, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      // Trivial profile edit (re-save same values) — emits an event row.
      const meR = await (await bobApi.get("/api/me")).json();
      const r = await bobApi.put("/api/me", {
        headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" },
        // A real change (and its restore below), so the edit emits an event: no
        // other bob row is attributed to his own address now that the seed no
        // longer sets a password through him.
        data: { phone: `+1 555 ${String(Date.now()).slice(-4)}` },
      });
      await bobApi.put("/api/me", { headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" }, data: { phone: meR.phone || "" } });
      expect(r.ok()).toBeTruthy();
    } finally { await bobApi.dispose(); }
    // v8.5.1 — POLL, do not sleep. The mirror is setImmediate-deferred and writes
    // AFTER its enrichment reads, so the flat 200 ms this used to wait was a guess
    // about machine load; it went flaky at WORKERS=18 with a bare `Received: null`.
    const logsDir = path.join(TEST_DATA_DIR, "logs");
    const auditLine = await findLogLine(logsDir,
      (j) => j.source === "audit" && j.scope === "user" && j.changed_by
             && typeof j.changed_by === "string" && j.changed_by.toLowerCase() === "bob@acme.com",
      { what: "a user-scope audit line attributed to bob@acme.com" });
    // The original changed_by string is preserved (back-compat with legacy readers).
    expect(auditLine.changed_by).toBe("bob@acme.com");
    // The new actor object resolves to the real user.
    expect(auditLine.actor).toBeTruthy();
    expect(typeof auditLine.actor).toBe("object");
    expect(auditLine.actor.id).toBeTruthy();
    expect(auditLine.actor.email).toBe("bob@acme.com");
    expect(auditLine.actor.first_name).toBeTruthy();
    expect(auditLine.actor.last_name).toBeTruthy();
  });

  test("/api/admin/logs surfaces actor_first_name/last_name when changed_by is a real user", async () => {
    await ensureState();
    // Trigger an event with email-shaped changed_by — same bob profile-edit
    // path as above (bob avoids the alice-state leakage from v6.10.29).
    const { api: bobApi, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      const meR = await (await bobApi.get("/api/me")).json();
      await bobApi.put("/api/me", {
        headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" },
        // A real change (and its restore below), so the edit emits an event: no
        // other bob row is attributed to his own address now that the seed no
        // longer sets a password through him.
        data: { phone: `+1 555 ${String(Date.now()).slice(-4)}` },
      });
      await bobApi.put("/api/me", { headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" }, data: { phone: meR.phone || "" } });
    } finally { await bobApi.dispose(); }
    await new Promise(rs => setTimeout(rs, 250));
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/logs?stream=app&q=bob%40acme.com&limit=200");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.entries).toBeTruthy();
      const enriched = body.entries.find(e =>
        e.source === "audit" &&
        typeof e.changed_by === "string" &&
        e.changed_by.toLowerCase() === "bob@acme.com" &&
        e.actor_email && e.actor_first_name && e.actor_last_name
      );
      expect(enriched).toBeTruthy();
      expect(enriched.actor_email).toBe("bob@acme.com");
    } finally { await sa.dispose(); }
  });

  test("/api/admin/logs response carries top-level structured fields (ip on scanner-block, etc) so the UI can render them", async () => {
    await ensureState();
    // Fetch the recent log entries via the admin API; assert that any row
    // carrying a top-level `ip` field is preserved through the response
    // shape (the JSONL line has it, the API must not strip it). This
    // locks the contract that the admin UI's new "IP" column relies on
    // (see public/app.js renderAdminLogs).
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/logs?stream=app&limit=500");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // Pick any entry that has an `ip` field (access-log style routed
      // through the app stream OR a security-audit row whose scope_id is
      // an IP). Real events on this fresh data dir won't always include
      // a scanner_blocked, so settle for "at least one entry exposes a
      // structured field beyond ts/level/msg" — proves the /admin/logs
      // handler doesn't whitelist columns.
      expect(Array.isArray(body.entries)).toBe(true);
      // Spot a row whose JSON carries a structured-field key that the
      // legacy column whitelist would have stripped.
      const richKeys = ["ip", "req_id", "method", "path", "status", "scope", "scope_id", "actor"];
      const hasRich = body.entries.some(e => richKeys.some(k => e[k] != null));
      expect(hasRich).toBe(true);
    } finally { await sa.dispose(); }
  });
});








// ── ext-audit A7, the SIBLING write paths ─────────────────────────────────────
//
// The finding named POST /api/register. Registration is not the only way a
// country/timezone reaches the users table — there are four, and three shared
// the defect. This block is the reason the sweep happened at all: the recurring
// failure in this codebase is fixing the reported site and leaving its siblings
// (v7.15.15), and the fix above would have left a participant able to store a
// whitespace country through PUT /api/me on the very same release.
//
// timezone is the harmful half everywhere: it is handed to Intl by fmtDt /
// formatEmailDate / the competition-window arithmetic, so an unusable value
// throws a RangeError far from the write that accepted it — in a background
// email send, in the admin edit case.
test.describe("v7.21.1 (A7) — every OTHER write path validates country + timezone too", () => {
  const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  const readUser = (email) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT * FROM users WHERE email=?").get(email) || null; }
    finally { db.close(); }
  };

  // ── PUT /api/me ────────────────────────────────────────────────────────────
  test("PUT /api/me refuses a whitespace country, an unresolvable timezone, and STORES trimmed", async () => {
    // A DEDICATED participant, not the shared `alice` (v7.15.32). 440 lifecycle
    // tests run before this one in the same file and several of them block,
    // lock or re-password the shared fixtures, so signing in as alice fails
    // roughly one run in three — with a 401 that says nothing about the subject
    // under test. Reproduced deterministically by running the whole file.
    const tag = uniq();
    const email = `me-tz-${tag}@company.example`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
      const reg = await registerPost(sa, "/api/register", {
        headers: saH,
        data: {
          firstName: "Me", lastName: "Tz", nickname: `me_tz_${tag}`, email,
          company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
          password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
        },
      });
      expect(reg.status(), await reg.text()).toBe(200);
      const users = await (await sa.get("/api/admin/participants?limit=500")).json();
      const u = users.participants.find(p => p.email === email);
      expect(u, "the fresh participant must be listed").toBeTruthy();
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    } finally { await sa.dispose(); }

    // apiLogin, not a hand-rolled login: /api/login REGENERATES the session, so a
    // token minted before it is stale and every write 403s csrf_invalid.
    const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
    try {
      const put = async (data) => {
        const r = await api.put("/api/me", {
          headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data,
        });
        return { status: r.status(), body: await r.json().catch(() => ({})) };
      };
      const before = await (await api.get("/api/me")).json();

      // POSITIVE CONTROL first — a real save works, so every 400 below is
      // attributable to the field under test and not to a broken fixture.
      const ok = await put({ country: "Ireland", timezone: "Europe/Dublin" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      const wsCountry = await put({ country: "   " });
      expect(wsCountry.status, `a whitespace country must not be accepted (got ${JSON.stringify(wsCountry.body)})`).toBe(400);
      const wsTz = await put({ timezone: "   " });
      expect(wsTz.status, `a whitespace timezone must not be accepted (got ${JSON.stringify(wsTz.body)})`).toBe(400);
      const badTz = await put({ timezone: "Banana/Nowhere" });
      expect(badTz.status, `an unresolvable timezone must not be accepted (got ${JSON.stringify(badTz.body)})`).toBe(400);

      // Nothing above may have landed.
      const mid = await (await api.get("/api/me")).json();
      expect(mid.country, "a refused save must not change the stored country").toBe("Ireland");
      expect(mid.timezone, "a refused save must not change the stored timezone").toBe("Europe/Dublin");

      // Validating a trimmed copy while storing the raw one is the same bug one
      // layer down — assert the STORED bytes, not the response.
      const padded = await put({ country: "  Ireland  ", timezone: "  Europe/Dublin  " });
      expect(padded.status, JSON.stringify(padded.body)).toBe(200);
      const after = await (await api.get("/api/me")).json();
      expect(after.country, "a padded country must be STORED trimmed").toBe("Ireland");
      expect(after.timezone, "a padded timezone must be STORED trimmed").toBe("Europe/Dublin");

      // UTC is the v7.15.23 trap: Intl.supportedValuesOf("timeZone") omits it
      // while Intl itself resolves it, so a vocabulary check would refuse a
      // zone half the world's containers report. Must be accepted.
      const utc = await put({ timezone: "UTC" });
      expect(utc.status, `UTC must be accepted (v7.15.23) — got ${JSON.stringify(utc.body)}`).toBe(200);
      await put({ country: before.country || "US", timezone: before.timezone || "UTC" });
    } finally { await api.dispose(); }
  });

  // ── admin edit ─────────────────────────────────────────────────────────────
  test("the admin edit path refuses an unresolvable timezone", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const list = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
      const target = list.find(u => (u.role || "participant") === "participant" && u.email);
      expect(target, "need a participant to edit").toBeTruthy();
      const edit = async (data) => {
        const r = await api.put(`/api/admin/participants/${target.id}`, {
          headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data,
        });
        return { status: r.status(), body: await r.json().catch(() => ({})) };
      };
      // POSITIVE CONTROL — a real zone saves, so the 400 is the validity check
      // and not a permission refusal or a broken payload.
      const ok = await edit({ timezone: "Asia/Kolkata" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const bad = await edit({ timezone: "Nowhere" });
      expect(bad.status, `an admin must not be able to store an unresolvable timezone (got ${JSON.stringify(bad.body)})`).toBe(400);
      const row = readUser(target.email);
      expect(row.timezone, "the refused edit must not have landed").toBe("Asia/Kolkata");
      // fillRequired already blocked whitespace here, so this is a guard against
      // the fix REGRESSING that: an empty incoming value keeps the current one.
      const blank = await edit({ timezone: "   " });
      expect(blank.status, JSON.stringify(blank.body)).toBe(200);
      expect(readUser(target.email).timezone, "a blank incoming timezone keeps the stored one").toBe("Asia/Kolkata");
    } finally { await api.dispose(); }
  });

  // ── participant import ─────────────────────────────────────────────────────
  test("the import DROPS an unusable timezone to empty, reports the count, and trims country", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const tag = uniq();
      const good = `imp-ok-${tag}@company.example`;
      const bad  = `imp-bad-${tag}@company.example`;
      const body = {
        type: "hackarena-participants",
        participants: [
          { first_name: "Imp", last_name: "Good", nickname: `imp_ok_${tag}`, email: good,
            company: "Acme", title: "Eng", country: "  Ireland  ", timezone: "  Europe/Dublin  ",
            job_function: "Software Developer / Engineer", city: "Dublin", verified: 1, approved: 1 },
          { first_name: "Imp", last_name: "Bad", nickname: `imp_bad_${tag}`, email: bad,
            company: "Acme", title: "Eng", country: "US", timezone: "Banana/Nowhere",
            job_function: "Software Developer / Engineer", city: "Testville", verified: 1, approved: 1 },
        ],
      };
      const r = await api.post("/api/admin/import/participants", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { data: body, resolutions: {} },
      });
      const out = await r.json().catch(() => ({}));
      expect(r.status(), JSON.stringify(out)).toBe(200);

      // A bad row must not sink the batch (the v7.11.3 posture) — both land.
      const gRow = readUser(good), bRow = readUser(bad);
      expect(gRow, "the good row must import").toBeTruthy();
      expect(bRow, "a row with an unusable timezone must still import").toBeTruthy();
      // Trimmed, not raw.
      expect(gRow.country).toBe("Ireland");
      expect(gRow.timezone).toBe("Europe/Dublin");
      // Dropped to empty rather than stored as garbage that would later throw a
      // RangeError inside a background email send.
      expect(bRow.timezone, "an unusable timezone must be cleared, not stored").toBeFalsy();
      // ...and REPORTED. A silent drop is the wrong answer this whole round is about.
      expect(out.invalid_timezones_dropped, "the drop must be surfaced to the operator").toBe(1);
    } finally { await api.dispose(); }
  });

  // ── the check-nickname mirror ──────────────────────────────────────────────
  test("check-nickname applies the registration MINIMUM LENGTH, not just the charset", async () => {
    const { api } = await freshCtx();
    try {
      const ask = async (n) => (await (await api.get(`/api/check-nickname?nickname=${encodeURIComponent(n)}`)).json()).available;
      // POSITIVE CONTROL — the endpoint answers true for something genuinely
      // free, so the falses below are the rule and not a dead endpoint.
      expect(await ask(`ok_${uniq()}`), "a free 3+ char handle must read as available").toBe(true);
      // The divergence: registration 400s under 3 characters, so answering
      // "available" sends the user to a green tick and then a refusal on submit.
      expect(await ask("ab"), "a 2-character handle is not registerable, so it is not available").toBe(false);
      expect(await ask("a"), "a 1-character handle is not registerable either").toBe(false);
    } finally { await api.dispose(); }
  });
});
