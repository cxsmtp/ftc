// @ts-check
//
// v8.8.25 — THE SESSION-SLIDE RESIDUAL: A NON-GET THAT NO HUMAN PRESSED.
//
// v7.14.5 recorded the hole and prescribed the remedy: "an explicit poll
// denylist plus a mechanical test that every interval-driven fetch URL in
// `public/js` is on it." THE PRESCRIPTION WAS AIMED THE WRONG WAY, and this
// file is the corrected form of it.
//
// A denylist over the GET polls is unnecessary. `_shouldSlideSession`
// (`server.js`) already runs only on POST/PUT/PATCH/DELETE, and every
// timer-driven read in `public/js` is a GET — `/api/participant/pulse` (the
// participant's one poll inside an event), `/api/session/status`,
// `/api/admin/alerts`, `/api/me`, `/api/status`, `/api/leaderboard`,
// `/api/my-competitions`, `/api/tasks`, `/api/admin/competitions`,
// `/api/admin/logs`. None of them slides anything, deliberately: a parked tab
// polls for ever, so sliding on reads would make the inactivity timeout a dead
// control (v7.14.5 argues exactly this and it still holds).
//
// What was actually broken is the invariant the write-slide RESTS on — "you
// cannot idle your way into a POST". Measured against the tree: THREE non-GETs
// are fired by a timer or by the tab going away, and all three slid the session.
// The sharpest is `/api/tasks/:id/navigated-away`, fired from the
// `visibilitychange`→hidden handler and from `pagehide`: the participant who
// backgrounds the Arena tab to work in their IDE — the very scenario v7.14.5
// names — slid their session ON THE WAY OUT.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CLAIM THIS FILE HOLDS, stated precisely so nobody reads more into it:
//
//   Every non-GET fetch reachable from an interval callback, a
//   self-rescheduling timer's callback (a `setTimeout(f, …)` that `f` re-arms,
//   itself or through the function that arms it: the participant pulse) or a
//   visibility/pagehide listener in `public/js/**` targets a path that
//   `_shouldSlideSession` SKIPS — or is declared in `ALLOWED_TO_SLIDE` below
//   with a reason.
//
// A DECISION PER ITEM, never blanket coverage (the `BACKUP_COVERS` shape,
// v7.21.34): a new poll that POSTs is either skipped or is a deliberate,
// argued exception. It cannot be neither.
//
// ─────────────────────────────────────────────────────────────────────────────
// STATED LIMITS — read these before citing this scanner as a guarantee.
//
//  (1) ONE LEVEL of call resolution. It walks a driver body, and the bodies of
//      the functions that body calls BY NAME, and stops. That reaches all three
//      real sites, because `fireNavigatedAway`, `handleCompetitionEnded` and
//      `selectCompetition` are each called DIRECTLY from a driver body. It does
//      NOT reach a fetch three hops down.
//      Depth 2 was built and MEASURED and is deliberately not shipped: it finds
//      one extra path, `POST /api/admin/alerts/:id/ack`, and that is a FALSE
//      POSITIVE — the alerts tick renders the dialog, and the ack fires from the
//      `overlayDismiss` callback when an ADMIN CLICKS Dismiss, which is a human
//      act that must keep sliding. A scanner that is wrong about working code is
//      one the next person deletes (Recurring rules), so it stays at one level
//      and says so rather than buying reach with noise.
//  (2) It resolves names TEXTUALLY, preferring a definition in the same file and
//      falling back to the whole `public/js` graph. It cannot see a call through
//      a variable, a method, or a dynamic dispatch.
//  (3) It reads `_shouldSlideSession`'s skip rules out of `server.js` as TEXT.
//      Requiring `server.js` is forbidden here — it boots the app and opens the
//      database at require time (v7.20.2). The probe paths it builds are already
//      canonical, and `_shouldSlideSession` applies `normaliseRoutePath` first,
//      which can only WIDEN a match — so a path this file calls skipped really is.
//
// It is NOT a claim that no unwanted slide is possible. It is the claim that the
// timer- and visibility-driven surface is decided about. A one-shot
// `setTimeout` (a delay, a debounce) is not a driver and is not walked.

const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const fs = require("fs");
const pathMod = require("path");

const ROOT = pathMod.join(__dirname, "..");
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = (l) => `${l}-${Date.now().toString(36)}-${Math.floor(Math.random() * 9973)}`;

// ── Non-GET paths reachable from a driver that are ALLOWED to slide ──────────
// Each needs a REASON, because each is a hole this scanner is agreeing to leave
// open. Adding an entry is a decision; adding one without a reason fails.
const ALLOWED_TO_SLIDE = {
  "/api/select-competition":
    "It is transition-gated on the picker poll (the poll returns early unless " +
    "the /api/my-competitions payload actually changed), and far more " +
    "importantly it is the endpoint a participant hits when they CLICK an " +
    "event card — unambiguously a person acting, and the common case by far. " +
    "Skipping it would DELETE a legitimate slide from every participant " +
    "entering an event, which is a worse failure than the residual it closes.",
};

// Comments FIRST, both forms in ONE left-to-right alternation.
//
// MEASURED, rather than asserted: `fetch(` appears inside comments in SEVEN of
// these files (11 occurrences — `core/api.js`, `core/main.js`, `features/auth.js`,
// `challenges-admin.js`, `competitions-admin.js`, `export-import.js`,
// `participant-tasks.js`), which this scanner would otherwise `balanced()` from,
// swallowing real code into a prose "argument list". A `method:` literal inside a
// comment would then be a phantom finding — there are ZERO today, so that half is
// prevention, and saying so is the point: the strip is load-bearing for the PARSE
// and not (yet) for the verdict. The `/*`-inside-`//` alternation matters for the
// usual reason: two passes let a `/*` on a `//` line open a block the stripper
// closes dozens of lines later, deleting the real code between.
//
// Byte-identical to `_stripJsComments` in `functional-core-b.api.spec.js`. It is
// a describe-local function there, not exported from any shared module, and this
// change may not edit another file to export it — so this is a deliberate copy,
// recorded as one rather than silently re-derived.
function _stripJsComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) => (pre === undefined ? "" : pre));
}

/** The balanced `(...)` or `{...}` run starting at `open`. */
function balanced(src, open) {
  const close = { "(": ")", "{": "}" }[src[open]];
  const openCh = src[open];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

function readClientSources() {
  /** @type {Map<string,string>} */
  const out = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir)) {
      if (e === "vendor" || e.startsWith(".")) continue;
      const full = pathMod.join(dir, e);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.js$/.test(e)) out.set(pathMod.relative(ROOT, full), _stripJsComments(fs.readFileSync(full, "utf8")));
    }
  })(pathMod.join(ROOT, "public", "js"));
  return out;
}

/** name -> [{rel, body}] for `function f(){}` and `const f = (…) => {…}`. */
function indexFunctions(sources) {
  /** @type {Map<string,{rel:string,body:string}[]>} */
  const fns = new Map();
  const add = (n, rel, body) => { if (!fns.has(n)) fns.set(n, []); fns.get(n).push({ rel, body }); };
  for (const [rel, src] of sources) {
    for (const m of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const bo = src.indexOf("{", m.index + m[0].length - 1);
      if (bo >= 0) add(m[1], rel, balanced(src, bo));
    }
    for (const m of src.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)) {
      const bo = src.indexOf("{", m.index + m[0].length - 1);
      if (bo >= 0) add(m[1], rel, balanced(src, bo));
    }
  }
  return fns;
}

/**
 * Prefer a definition in the SAME file. `tick` is defined five times across the
 * SPA, so a name-only index attributed a countdown timer's findings to every
 * other countdown timer — over-approximation is the safe direction for COVERAGE
 * but it makes the failure message name the wrong site, which is the half an
 * operator acts on.
 */
const resolveFn = (fns, name, rel) => {
  const all = fns.get(name) || [];
  const local = all.filter((e) => e.rel === rel);
  return local.length ? local : all;
};

/** Every interval callback, every self-rescheduling timer callback and every visibility/pagehide listener body. */
function collectDrivers(sources, fns) {
  const drivers = [];
  for (const [rel, src] of sources) {
    for (const m of src.matchAll(/setInterval\s*\(/g)) {
      const args = balanced(src, m.index + m[0].length - 1);
      const line = src.slice(0, m.index).split("\n").length;
      // BOTH callback forms. Five sites pass a bare identifier
      // (`setInterval(_sessionMonTick, …)`); the rest an inline arrow. A scanner
      // that handled only the arrow would silently skip the session monitor.
      const inline = /^\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(args)
        || /^\(\s*(?:async\s+)?function\b/.test(args);
      if (inline) {
        drivers.push({ rel, line, kind: "setInterval(inline)", seed: null, bodies: [{ rel, body: balanced(args, args.indexOf("{")) }] });
      } else {
        const id = (args.match(/^\(\s*([A-Za-z_$][\w$]*)\s*[,)]/) || [])[1];
        drivers.push({ rel, line, kind: `setInterval(${id})`, seed: id, bodies: id ? resolveFn(fns, id, rel) : [] });
      }
    }
    // SELF-RESCHEDULING TIMERS. A poll need not be a `setInterval`: the
    // participant pulse is a `setTimeout(_pulseTick, …)` armed by `_schedulePulse`,
    // and `_pulseTick` calls `_schedulePulse` again when it ends, so it runs all
    // event long like any interval. A `setTimeout(f, …)` is a driver when `f`
    // re-arms it — `f` arms it itself, or calls by name a function that does. A
    // one-shot delay re-arms nothing and stays out (it would only add noise).
    for (const m of src.matchAll(/setTimeout\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
      const id = m[1];
      const line = src.slice(0, m.index).split("\n").length;
      const armers = [];
      for (const [n, list] of fns) for (const e of list) if (e.rel === rel && e.body.includes(m[0])) armers.push(n);
      const bodies = resolveFn(fns, id, rel);
      const reArms = armers.includes(id) || bodies.some((e) => {
        const called = calledNames(e.body);
        return called.has(id) || armers.some((a) => called.has(a));
      });
      if (reArms) drivers.push({ rel, line, kind: `setTimeout(self-rescheduling:${id})`, seed: id, bodies });
    }
    for (const m of src.matchAll(/addEventListener\s*\(\s*['"](visibilitychange|pagehide)['"]\s*,/g)) {
      const call = balanced(src, src.lastIndexOf("(", m.index + m[0].length - 1));
      const line = src.slice(0, m.index).split("\n").length;
      const rest = call.slice(call.indexOf(",") + 1);
      // BOTH handler forms here too, for the same reason as setInterval. A first
      // draft required an inline `{`, which silently dropped
      // `addEventListener('pagehide', release, …)` in `ui/download.js` — harmless
      // today (it revokes an object URL and fetches nothing) and exactly how a
      // future named `pagehide` handler that POSTs would go unseen.
      const named = rest.match(/^\s*([A-Za-z_$][\w$]*)\s*[,)]/);
      if (named) {
        drivers.push({ rel, line, kind: `listener(${m[1]}:${named[1]})`, seed: named[1], bodies: resolveFn(fns, named[1], rel) });
      } else {
        const bo = call.indexOf("{", call.indexOf(","));
        if (bo < 0) continue;
        drivers.push({ rel, line, kind: `listener(${m[1]})`, seed: null, bodies: [{ rel, body: balanced(call, bo) }] });
      }
    }
  }
  return drivers;
}

const FETCH_CALL = /\b(fetch|fetchWithLoading|fetchTransientRetry|fetchJsonList|fetchJsonObject|fetchEventsPaged)\s*\(/g;

/** Non-GET fetches in one body, as {method, url} with `${…}` collapsed to a segment. */
function nonGetFetches(body) {
  const out = [];
  for (const m of body.matchAll(FETCH_CALL)) {
    const args = balanced(body, m.index + m[0].length - 1);
    const meth = args.match(/method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i);
    if (!meth) continue;
    const raw = (args.match(/^\(\s*[`'"]([^`'"]*)/) || [])[1];
    // A template hole becomes one opaque path segment, which is what the route
    // pattern matches. A hole containing a nested `}` would survive here and
    // then fail to match — flagged rather than passed, the safe direction.
    const url = raw ? raw.replace(/\$\{[^}]*\}/g, "_seg_") : `<dynamic:${args.slice(1, 60)}>`;
    out.push({ method: meth[1].toUpperCase(), url });
  }
  return out;
}

const calledNames = (body) => {
  const s = new Set();
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) s.add(m[1]);
  return s;
};

/** `_SESSION_SLIDE_SKIP` + every regex arm inside `_shouldSlideSession`, read as TEXT. */
function readSkipRules() {
  const src = _stripJsComments(fs.readFileSync(pathMod.join(ROOT, "server.js"), "utf8"));
  const setAt = src.indexOf("const _SESSION_SLIDE_SKIP = new Set(");
  expect(setAt, "_SESSION_SLIDE_SKIP must still be declared in server.js — if it was renamed, " +
    "re-point this scanner rather than letting it match nothing and pass in silence").toBeGreaterThan(-1);
  const literals = new Set(
    [...balanced(src, src.indexOf("(", setAt)).matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
  );
  const fnAt = src.indexOf("function _shouldSlideSession(");
  expect(fnAt, "_shouldSlideSession must still exist in server.js").toBeGreaterThan(-1);
  const fnBody = balanced(src, src.indexOf("{", fnAt));
  const patterns = [];
  for (const m of fnBody.matchAll(/\/(\^\\\/api[^\n]*?)\/\.test\(\s*p\s*\)/g)) {
    patterns.push(new RegExp(m[1].replace(/\\\//g, "/")));
  }
  return { literals, patterns, fnBody };
}

const isSkipped = (rules, p) =>
  rules.literals.has(p) || p.startsWith("/api/test/") || rules.patterns.some((r) => r.test(p));

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.8.25 — a poll-driven non-GET must not slide the session", () => {

  test("every timer- or visibility-driven non-GET (the pulse included) is skipped, or declared with a reason", () => {
    const sources = readClientSources();
    const fns = indexFunctions(sources);
    const drivers = collectDrivers(sources, fns);
    const rules = readSkipRules();

    // ── ANTI-VACUITY FLOORS ───────────────────────────────────────────────
    // Rename any of the symbols these regexes match and the scan finds nothing
    // and passes — which is precisely the failure it exists to catch.
    const intervalSites = [...sources.values()].join("\n").match(/setInterval\s*\(/g) || [];
    expect(intervalSites.length,
      "fewer than 15 setInterval sites found in public/js — there are 19 today, so the " +
      "callback matcher has stopped matching and this scanner is inspecting nothing"
    ).toBeGreaterThanOrEqual(15);
    expect(drivers.filter((d) => /^setTimeout\(self-rescheduling:/.test(d.kind)).map((d) => d.seed),
      "the participant pulse (`_pulseTick`, re-armed through `_schedulePulse` in " +
      "features/participant-tasks.js) must be found as a self-rescheduling timer — it is the " +
      "one timer-driven read a participant's tab sends all event long, so a matcher that no " +
      "longer finds it leaves that whole poll undecided"
    ).toContain("_pulseTick");
    expect(drivers.filter((d) => /^listener\(/.test(d.kind)).length,
      "the visibility/pagehide listeners were not found — `navigated-away`, the whole point " +
      "of this scanner, is reached ONLY from those two"
    ).toBeGreaterThanOrEqual(2);
    expect(rules.literals.size,
      "fewer than 2 literal entries extracted from _SESSION_SLIDE_SKIP — the Set was renamed " +
      "or reshaped, so every membership test below is answering about an empty list"
    ).toBeGreaterThanOrEqual(2);
    expect(rules.patterns.length,
      "no regex arm extracted from _shouldSlideSession — `/api/tasks/:id/navigated-away` and " +
      "the impersonate arm are BOTH matched that way, so this scanner would call them unskipped"
    ).toBeGreaterThanOrEqual(1);

    // ── the walk: one level of resolution ─────────────────────────────────
    /** @type {Map<string,{path:string,method:string,where:Set<string>}>} */
    const reachable = new Map();
    for (const d of drivers) {
      const seen = new Set(d.seed ? [d.seed] : []);
      let frontier = d.bodies;
      for (let lvl = 0; lvl <= 1; lvl++) {
        const next = [];
        for (const e of frontier) {
          for (const f of nonGetFetches(e.body)) {
            const key = `${f.method} ${f.url}`;
            if (!reachable.has(key)) reachable.set(key, { path: f.url, method: f.method, where: new Set() });
            reachable.get(key).where.add(`${d.rel}:${d.line} ${d.kind}`);
          }
          if (lvl === 1) continue;                     // depth limit — see STATED LIMITS (1)
          for (const n of calledNames(e.body)) {
            if (seen.has(n)) continue;
            seen.add(n);
            for (const r of resolveFn(fns, n, e.rel)) next.push(r);
          }
        }
        frontier = next;
      }
    }

    expect(reachable.size,
      "the walk found NO non-GET fetch reachable from any poll or visibility handler. There " +
      "are four today, so the fetch matcher or the `method:` matcher has stopped matching"
    ).toBeGreaterThanOrEqual(1);

    // ── the decision, per item ────────────────────────────────────────────
    const undecided = [];
    for (const [key, f] of reachable) {
      if (isSkipped(rules, f.path)) continue;
      const reason = ALLOWED_TO_SLIDE[f.path];
      if (reason && reason.length > 40) continue;
      undecided.push(`${key}\n      reached from: ${[...f.where].join(", ")}` +
        (reason ? "\n      (its ALLOWED_TO_SLIDE reason is too short to be a reason)" : ""));
    }
    expect(undecided,
      "These non-GET requests are fired by a TIMER or by the tab going away, and they SLIDE the " +
      "session — so a tab nobody is looking at keeps its session alive for ever and the idle " +
      "timeout stops being a control (the v7.14.5 residual).\n\n" +
      "Fix it at the SITE: add the path to `_SESSION_SLIDE_SKIP` in server.js (or a regex arm in " +
      "`_shouldSlideSession`, if it carries a path parameter). If the request really is a human " +
      "act that merely happens to be reachable from a poll, add it to ALLOWED_TO_SLIDE here WITH " +
      "A REASON.\n\n" +
      "NOTE THE SCANNER'S REACH: it resolves ONE level of calls from a driver body, so a fetch " +
      "further down the call graph is invisible to it. Absence from this list is not proof.\n\n  " +
      undecided.join("\n  ")
    ).toEqual([]);
  });

  test("the two v8.8.25 entries are what a driver-reachable path resolves against", () => {
    // Pins the FIX, not merely the rule: the reachability walk above would also
    // be satisfied by moving these into ALLOWED_TO_SLIDE, which is the wrong
    // answer for both. Asserted through the extracted rules, so a rename of the
    // Set or the regex arm fails here rather than passing quietly.
    const rules = readSkipRules();
    expect(isSkipped(rules, "/api/dismiss-ended"),
      "/api/dismiss-ended is fired once at the ended transition by the participant pulse and " +
      "the 1 s countdown, via handleCompetitionEnded. No human acted; it must not slide."
    ).toBe(true);
    expect(isSkipped(rules, "/api/tasks/_seg_/navigated-away"),
      "/api/tasks/:id/navigated-away is fired by visibilitychange→hidden and pagehide. " +
      "Backgrounding a tab is the OPPOSITE of acting in the app — it must not slide."
    ).toBe(true);
    // The narrowness control. Without it, "these are skipped" is equally
    // satisfied by an arm broad enough to skip the whole participant surface —
    // which would silently switch the write-slide off for everyone.
    expect(isSkipped(rules, "/api/tasks/_seg_/submit"),
      "submitting an answer is a human act and MUST still slide"
    ).toBe(false);
    expect(isSkipped(rules, "/api/select-competition"),
      "select-competition must stay OFF the skip list — a participant clicking an event card " +
      "is the common case, and skipping it would remove a legitimate slide"
    ).toBe(false);
  });

  // ── the behavioural half ────────────────────────────────────────────────
  // The scanner proves the path is on the list. This proves the list is read.
  test("navigated-away does NOT re-stamp the browser cookie, while an ordinary write DOES", async () => {
    test.setTimeout(120_000);
    const { api: sa, csrf: sc } = await apiLogin("superadmin");

    // The slide's ONLY observable signature is a refreshed Set-Cookie carrying a
    // new Expires (v7.14.4): a cookie-jar client ignores Expires, so the stored
    // row alone cannot show this. Assert the header itself.
    const setCookieExpiry = (resp) => {
      const raw = resp.headers()["set-cookie"] || "";
      const m = /connect\.sid=[^;]*;[^]*?expires=([^;]+)/i.exec(raw);
      return m ? new Date(m[1]).getTime() : null;
    };
    const tick = () => new Promise((r) => setTimeout(r, 1100));   // Expires has 1 s resolution

    let participant = null;
    try {
      // Own participant, own competition, own challenge — never a seeded fixture
      // (Recurring rules): the shared accounts are blocked, re-passworded and
      // tagged by other tests in flight.
      const label = uniq("slide");
      const email = `${label}@company.example`;
      const { api: anon, csrf: ac } = await freshCtx();
      const reg = await registerPost(anon, "/api/register", {
        headers: H(ac),
        data: {
          firstName: "Slide", lastName: "Tester", nickname: label, email,
          company: "Acme", title: "Engineer", country: "US",
          timezone: "America/New_York", password: PARTICIPANT_PASS,
        },
      });
      expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
      await anon.dispose();

      // `?search=` is a NO-OP on this endpoint, so ask for the documented cap
      // rather than letting a short page decide whether the row is findable.
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      const row = (list.participants || list).find((p) => p.email === email);
      expect(row, "the freshly registered participant must be findable").toBeTruthy();
      participant = row.id;
      expect((await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(sc) })).ok()).toBeTruthy();
      expect((await sa.post(`/api/admin/participants/${row.id}/approve`, { headers: H(sc) })).ok()).toBeTruthy();

      const cr = await sa.post("/api/admin/competitions", {
        headers: H(sc),
        data: {
          name: `Slide Probe ${label}`,
          start_time: new Date(Date.now() - 3600e3).toISOString(),
          duration_minutes: 600,
        },
      });
      expect(cr.ok(), `create competition: ${await cr.text()}`).toBeTruthy();
      const comp = (await cr.json()).competition;

      const tr = await sa.post("/api/admin/tasks", {
        headers: H(sc),
        data: {
          title: `Slide Probe Task ${label}`, description: "d", difficulty: "easy",
          answer_type: "text", correct_answer: "right", status: "published",
        },
      });
      expect(tr.ok(), `create task: ${await tr.text()}`).toBeTruthy();
      const taskId = (await tr.json()).id;
      expect(taskId, "the create returns the id — never resolve it by title").toBeTruthy();
      expect((await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: H(sc), data: { competitionIds: [comp.id] },
      })).ok(), "assign task").toBeTruthy();

      const asg = await sa.post("/api/admin/competitions/assign", {
        headers: H(sc), data: { userIds: [row.id], competitionIds: [comp.id] },
      });
      expect(asg.ok(), `assign participant: ${await asg.text()}`).toBeTruthy();
      // The assign endpoint SKIPS an ineligible user and still answers 200.
      expect((await asg.json()).assigned, "assert the assign actually took").toBe(1);

      // Sign the participant in and put them INTO the competition, so the
      // navigated-away POST takes the real production path rather than being
      // refused before the handler.
      const { api, csrf: c0 } = await freshCtx();
      try {
        const li = await codeLogin(api, email, H(c0));
        expect(li.ok(), `login: ${await li.text()}`).toBeTruthy();
        const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: comp.id } });
        expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();

        // THE CONTROL, and it comes first on purpose. Without it "navigated-away
        // did not slide" is equally satisfied by a build where NOTHING slides —
        // which is the v7.14.4 production bug, not a fix.
        await tick();
        const w1 = await api.put("/api/me", { headers: H(csrf), data: { company: "Acme One" } });
        expect(w1.ok(), `PUT /api/me: ${await w1.text()}`).toBeTruthy();
        const first = setCookieExpiry(w1);
        expect(first, "control: an ordinary authenticated write must emit a Set-Cookie carrying " +
          "an Expires, or this test proves nothing about the skip list").toBeTruthy();

        await tick();
        const w2 = await api.put("/api/me", { headers: H(csrf), data: { company: "Acme Two" } });
        expect(w2.ok()).toBeTruthy();
        const second = setCookieExpiry(w2);
        expect(second, "control: a later write re-stamps the cookie too").toBeTruthy();
        expect(second, "control: the browser's deadline must move FORWARD on a genuine human write")
          .toBeGreaterThan(first);

        // THE ASSERTION. `visibilitychange`→hidden fires exactly this.
        await tick();
        const nav = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/navigated-away`, {
          headers: H(csrf), data: { via: "visibilitychange" },
        });
        // It must reach the real handler — a request refused upstream would make
        // the Set-Cookie assertion below true for an unrelated reason.
        expect(nav.status(), `navigated-away must reach its handler: ${await nav.text()}`).toBe(200);
        expect(setCookieExpiry(nav),
          "backgrounding a tab re-stamped the session cookie. `visibilitychange`→hidden and " +
          "`pagehide` fire this POST, so a participant who backgrounds the Arena tab to work in " +
          "their IDE slides their session ON THE WAY OUT — the v7.14.5 residual, exactly."
        ).toBeNull();

        // And the control still holds AFTER it, so the ordering above cannot be
        // what produced the null.
        await tick();
        const w3 = await api.put("/api/me", { headers: H(csrf), data: { company: "Acme Three" } });
        expect(w3.ok()).toBeTruthy();
        expect(setCookieExpiry(w3), "a real write still slides after the skipped one")
          .toBeGreaterThan(second);
      } finally { await api.dispose(); }

      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: H(sc) }).catch(() => {});
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: H(sc) }).catch(() => {});
    } finally {
      if (participant) await sa.delete(`/api/admin/participants/${participant}?force=1`, { headers: H(sc) }).catch(() => {});
      await sa.dispose();
    }
  });
});
