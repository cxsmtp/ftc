// @ts-check
//
// v8.13.3 — A PAGING INDEX IS BOUNDED ABOVE AS WELL AS BELOW, AT EVERY READ.
//
// Six admin list routes read `?offset=` or `?page=` from the query string, and
// each one parsed it by hand: `Math.max(0, parseInt(x) || 0)`, or a
// `Number.isFinite` guard. Both are lenient BELOW (good: 0, -5 and 'abc' all read
// as the first page) and unbounded ABOVE. better-sqlite3 binds an integral number
// as INTEGER only within int64, so `?offset=100000000000000000000` (1e20) — or a
// page whose PRODUCT with the limit passes 9.2e18 — raised SQLITE_MISMATCH and the
// admin got a generic 500. And a ~309-digit value parses to Infinity, which the
// `Number.isFinite` form silently read as page ONE: a request for "past the end"
// answered with the first page, which is the wrong answer rather than an error.
//
// `clampPagingIndex(raw, floor)` (lib/util.js) is the one parse now, capped at
// PAGING_INDEX_MAX (1e9) so every DERIVED bind stays an exact integer. This file
// holds the class three ways:
//
//   (a) a unit arm over the helper itself (lib/util is pure — no db, no config —
//       so it is required at column 0, which the v7.20.2 scanner allows);
//   (b) a SOURCE scanner: no `req.query.offset` / `req.query.page` read anywhere
//       in server.js, routes/** or lib/** that is not the helper's argument (or a
//       bare presence test), because the failure mode is the route added NEXT;
//   (c) behavioural arms for the routes this release converted in routes/ and
//       lib/ — an absurd value answers 200 with the empty past-the-end page, and a
//       CONTROL that ordinary paging and the lenient-below reading are unchanged.
//       Without the controls "200 and empty" is satisfied by a route that returns
//       nothing at all.
//
// Every fixture is this file's own.

const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { apiLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition } = require("./event-admin-helpers");
const { clampPagingIndex, PAGING_INDEX_MAX } = require("../lib/util");

// 1e20 written out — the value better-sqlite3 cannot bind. A string, so the test
// sends exactly what a caller types rather than whatever Number#toString makes of it.
const HUGE = "100000000000000000000";
// Parses to Infinity — the case the old `Number.isFinite` guard read as page ONE.
const INF_DIGITS = "9".repeat(400);

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE HELPER
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.13.3 — clampPagingIndex (unit)", () => {
  test("lenient below, capped above, radix 10, and the floor is honoured", () => {
    const rows = [
      // [raw, floor, expected, why]
      [undefined, 0, 0, "absent → floor"],
      ["", 0, 0, "empty → floor"],
      ["abc", 0, 0, "garbage → floor (lenient below, as before)"],
      ["-5", 0, 0, "negative → floor"],
      ["0", 0, 0, "zero"],
      ["7", 0, 7, "ordinary value unchanged"],
      ["10abc", 0, 10, "parseInt leniency is preserved"],
      ["0x10", 0, 0, "radix 10: hex is not 16"],
      ["1e20", 0, 1, "parseInt stops at the exponent — a small page, not an error"],
      [HUGE, 0, PAGING_INDEX_MAX, "1e20 written out → the cap"],
      [INF_DIGITS, 0, PAGING_INDEX_MAX, "Infinity → the cap, NOT page one"],
      ["Infinity", 0, 0, "the word is garbage, not a number"],
      [1e20, 0, PAGING_INDEX_MAX, "a numeric argument is clamped too"],
      [undefined, 1, 1, "page floor"],
      ["0", 1, 1, "page 0 reads as page 1"],
      ["-3", 1, 1, "negative page reads as page 1"],
      ["5", 1, 5, "ordinary page unchanged"],
      [HUGE, 1, PAGING_INDEX_MAX, "a huge page → the cap"],
    ];
    for (const [raw, floor, expected, why] of rows) {
      expect(clampPagingIndex(raw, floor), `${JSON.stringify(raw)} (floor ${floor}): ${why}`).toBe(expected);
    }
    expect(clampPagingIndex(undefined), "the default floor is 0").toBe(0);
  });

  test("the cap keeps every DERIVED bind an exact integer inside int64", () => {
    // The participants list binds (page-1)*limit with limit <= 5000. That is the
    // largest product any route derives from the index, and it must be both a safe
    // integer (so the arithmetic is exact) and inside SQLite's int64 (so it binds).
    const product = (PAGING_INDEX_MAX - 1) * 5000;
    expect(Number.isSafeInteger(product), `(cap-1)*5000 = ${product} must be a safe integer`).toBe(true);
    expect(BigInt(product) <= 9223372036854775807n, "…and inside int64").toBe(true);
    // Anti-vacuity: a cap so small it could truncate real paging would pass the
    // above trivially. No table here approaches 1e9 rows.
    expect(PAGING_INDEX_MAX, "the cap is far beyond any real row count").toBeGreaterThanOrEqual(1e8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE CLASS LOCK
// ─────────────────────────────────────────────────────────────────────────────

/** Strip both comment forms in ONE alternation, keeping every line where it was. */
function stripKeepLines(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (m, pre) =>
    pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
}

function serverSources() {
  const root = path.join(__dirname, "..");
  const out = [path.join(root, "server.js")];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(root, "routes"));
  walk(path.join(root, "lib"));
  return out.map(f => ({ rel: path.relative(root, f), src: stripKeepLines(fs.readFileSync(f, "utf8")) }));
}

test.describe("v8.13.3 — every paging index is read through clampPagingIndex (source)", () => {
  test("no req.query offset/page read escapes the helper", () => {
    // WHAT COUNTS AS SAFE: the read is the helper's FIRST argument, or a bare
    // presence test (`!== undefined`), which reads no number — lib/audit.js's
    // `paginated` flag is exactly that and must stay one. Anything else — a
    // parseInt, a Number(), a destructure — is the shape this release removed six
    // times, and the next route to grow a pager would add a seventh.
    //
    // Comments are stripped FIRST, keeping line numbers: the comments explaining
    // the fix name the very reads they replaced. Stated limits: an alias
    // (`const q = req.query; q.offset`) is invisible, as is a string that holds
    // `//` before a real read on the same line.
    const READ = /\breq\.query(?:\?\.|\.)(offset|page)\b|\breq\.query\[\s*["'](offset|page)["']\s*\]/g;
    const DESTRUCTURE = /\{[^{}]*\b(?:offset|page)\b[^{}]*\}\s*=\s*req\.query\b/g;
    const bad = [];
    const wrappedPerFile = new Map();
    let wrapped = 0, presence = 0;
    for (const { rel, src } of serverSources()) {
      const lineOf = (i) => src.slice(0, i).split("\n").length;
      const lineText = (i) => src.split("\n")[lineOf(i) - 1].trim();
      for (const m of src.matchAll(READ)) {
        const before = src.slice(Math.max(0, m.index - 80), m.index);
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
        if (/clampPagingIndex\(\s*$/.test(before)) {
          wrapped++;
          wrappedPerFile.set(rel, (wrappedPerFile.get(rel) || 0) + 1);
        } else if (/^\s*[!=]==?\s*undefined\b/.test(after)) {
          presence++;
        } else {
          bad.push(`${rel}:${lineOf(m.index)}  ${lineText(m.index)}`);
        }
      }
      for (const m of src.matchAll(DESTRUCTURE)) {
        bad.push(`${rel}:${lineOf(m.index)}  destructures a paging index from req.query: ${lineText(m.index)}`);
      }
    }
    expect(bad,
      "a paging index is read without lib/util's clampPagingIndex. Unbounded ABOVE, a value " +
      "past int64 (1e20, or a page whose product with the limit is) raises SQLITE_MISMATCH at " +
      "the LIMIT/OFFSET bind — a generic 500 — and a ~309-digit value reads as Infinity. Read it " +
      "as clampPagingIndex(req.query.offset) (or (req.query.page, 1)):\n  " + bad.join("\n  ")
    ).toEqual([]);

    // ANTI-VACUITY. A rename of the helper, or of `req.query`, would empty both
    // counts and pass in silence; and each site this release converted is NAMED, so
    // one dropping out of the match (an alias, a refactor) fails rather than shrinks.
    expect(wrapped, "at least five wrapped reads exist (the floor)").toBeGreaterThanOrEqual(5);
    for (const [file, min] of [["server.js", 2], ["routes/groups.js", 1], ["routes/participants.js", 1], ["lib/audit.js", 1]]) {
      expect(wrappedPerFile.get(file) || 0, `${file} reads its paging index through the helper`).toBeGreaterThanOrEqual(min);
    }
    expect(presence, "lib/audit.js keeps its `?offset=` presence test (the paginated envelope)").toBeGreaterThanOrEqual(1);
  });

  test("the helper is defined once, and every file that calls it imports it", () => {
    // A second definition is how two routes come to disagree about the cap; a call
    // with no import is a ReferenceError at request time that `node --check`
    // cannot see (the v7.17.1 class).
    const defs = [], missing = [];
    for (const { rel, src } of serverSources()) {
      for (const m of src.matchAll(/\bfunction\s+clampPagingIndex\b|\b(?:const|let|var)\s+clampPagingIndex\s*=/g)) defs.push(rel);
      const calls = (src.match(/\bclampPagingIndex\(/g) || []).length;
      if (!calls || /\bfunction\s+clampPagingIndex\b/.test(src)) continue;
      if (!/\{[^}]*\bclampPagingIndex\b[^}]*\}\s*=\s*require\(/.test(src)) missing.push(rel);
    }
    expect(defs, "clampPagingIndex is defined exactly once, in lib/util.js").toEqual(["lib/util.js"]);
    expect(missing, "these files call clampPagingIndex without importing it").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE ROUTES THIS RELEASE CONVERTED IN routes/ AND lib/
//     (server.js's two — submissions and logs — are held by (b) above.)
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.13.3 — an absurd paging index is the empty past-the-end page, not a 500", () => {
  /** @type {any} */ let sa, saCsrf;
  let P, comp, group;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const l = await apiLogin("superadmin");
    sa = l.api; saCsrf = l.csrf;
    P = await makeParticipant(sa, saCsrf, "paging");
    comp = await makeCompetition(sa, saCsrf, "paging");
    // A group P is NOT in, so P is a candidate on its picker.
    const g = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `Paging ${uniq("g")}`.slice(0, 80) } });
    expect(g.ok(), `create group: ${g.status()} ${await g.text()}`).toBeTruthy();
    group = (await g.json()).group;
    expect(group && group.id, "the group exists").toBeTruthy();
  });

  test.afterAll(async () => { try { await sa?.dispose(); } catch (_) {} });

  test("GET /api/admin/participants — ?page past int64 (with the 5000 limit) and an Infinity page", async () => {
    // CONTROL first: ordinary paging finds the participant, and the lenient-below
    // reading (0, -5, garbage → page 1) is unchanged.
    const base = await sa.get("/api/admin/participants?page=1&limit=5000");
    expect(base.status(), await base.text()).toBe(200);
    const b0 = await base.json();
    expect(b0.participants.some(p => p.id === P.id), "page 1 lists the participant").toBe(true);
    for (const lenient of ["0", "-5", "abc"]) {
      const r = await sa.get(`/api/admin/participants?page=${lenient}&limit=4999`);
      expect(r.status(), `page=${lenient}: ${await r.text()}`).toBe(200);
      const b = await r.json();
      expect(b.page, `page=${lenient} still reads as page 1`).toBe(1);
      expect(b.participants.some(p => p.id === P.id), `page=${lenient} still lists the first page`).toBe(true);
    }

    // 2e15 × 5000 = 1e19 > int64 — the PRODUCT is what overflowed. And a HUGE and
    // an Infinity page. Each is a 200 with no rows, the cap echoed, and the same
    // total: the route answered the question, it just has nothing that far out.
    for (const page of ["2000000000000000", HUGE, INF_DIGITS]) {
      const r = await sa.get(`/api/admin/participants?page=${page}&limit=5000`);
      expect(r.status(), `page=${page.slice(0, 24)}…: ${await r.text()}`).toBe(200);
      const b = await r.json();
      expect(b.page, "the cap is echoed").toBe(PAGING_INDEX_MAX);
      expect(b.participants, "past the end there is nothing").toEqual([]);
      expect(b.total, "…and the total is the real one").toBe(b0.total);
    }
  });

  test("GET /api/admin/groups/:id/picker — an offset of 1e20 WRITTEN OUT and an Infinity offset are past the end, not page one", async () => {
    const base = await sa.get(`/api/admin/groups/${group.id}/picker?limit=500&offset=0&search=${encodeURIComponent(P.email)}`);
    expect(base.status(), await base.text()).toBe(200);
    const b0 = await base.json();
    expect(b0.candidates.some(c => c.id === P.id), "CONTROL: offset 0 lists the candidate").toBe(true);
    const neg = await (await sa.get(`/api/admin/groups/${group.id}/picker?limit=500&offset=-5&search=${encodeURIComponent(P.email)}`)).json();
    expect(neg.candidatesOffset, "CONTROL: a negative offset still reads as 0").toBe(0);
    expect(neg.candidates.some(c => c.id === P.id), "…and lists the first page").toBe(true);

    for (const off of [HUGE, INF_DIGITS]) {
      const r = await sa.get(`/api/admin/groups/${group.id}/picker?limit=500&offset=${off}&search=${encodeURIComponent(P.email)}`);
      expect(r.status(), `offset=${off.slice(0, 24)}…: ${await r.text()}`).toBe(200);
      const b = await r.json();
      expect(b.candidatesOffset, "the cap is echoed").toBe(PAGING_INDEX_MAX);
      // INF_DIGITS is the half the old guard got WRONG rather than 500ing on: it read
      // Infinity as offset 0 and handed back the first page.
      expect(b.candidates, "past the end — never the first page").toEqual([]);
      expect(b.candidatesTotal, "…with the real total").toBe(b0.candidatesTotal);
    }
  });

  test("the four history routes (lib/audit.js _paginationParams) — an offset of 1e20 written out, and Infinity", async () => {
    const routes = [
      `/api/admin/competitions/${comp.id}/events`,
      `/api/admin/participants/${P.id}/events`,
      // An unknown session keeps its documented empty-200 (v6.9.21) — and the old
      // offset bind 500'd even for that, because the list query always runs.
      `/api/admin/competitions/${comp.id}/timeslots/no-such-session/events`,
      "/api/admin/settings/events",
    ];
    for (const r0 of routes) {
      const base = await sa.get(`${r0}?limit=50&offset=0`);
      expect(base.status(), `${r0} offset=0: ${await base.text()}`).toBe(200);
      const b0 = await base.json();
      expect(Array.isArray(b0.events), `${r0}: the paginated envelope`).toBe(true);
      for (const off of [HUGE, INF_DIGITS]) {
        const r = await sa.get(`${r0}?limit=50&offset=${off}`);
        expect(r.status(), `${r0} offset=${off.slice(0, 24)}…: ${await r.text()}`).toBe(200);
        const b = await r.json();
        expect(b.offset, `${r0}: the cap is echoed`).toBe(PAGING_INDEX_MAX);
        expect(b.events, `${r0}: past the end`).toEqual([]);
        expect(b.total, `${r0}: the real total`).toBe(b0.total);
      }
    }
    // CONTROL: the competition really has history, so "past the end is empty" above
    // is not satisfied by a list that is always empty.
    const own = await (await sa.get(`/api/admin/competitions/${comp.id}/events?limit=50&offset=0`)).json();
    expect(own.events.length, "the competition's own history is non-empty at offset 0").toBeGreaterThan(0);
  });

  test("`?offset=` (present but empty) still opts into the paginated envelope; no offset and no limit is the bare array", async () => {
    // The presence semantics the clamp must not disturb: `paginated` asks whether the
    // caller SENT an offset, not what it parsed to.
    const env = await (await sa.get(`/api/admin/competitions/${comp.id}/events?offset=`)).json();
    expect(Array.isArray(env), "an empty ?offset= is still the envelope").toBe(false);
    expect(Array.isArray(env.events), "…carrying events").toBe(true);
    expect(env.offset, "…at offset 0").toBe(0);
    const bare = await (await sa.get(`/api/admin/competitions/${comp.id}/events`)).json();
    expect(Array.isArray(bare), "CONTROL: no offset and no limit is the legacy bare array").toBe(true);
  });
});
