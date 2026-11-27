// @ts-check
//
// v7.25.0 — a FILTERED read of /api/admin/logs is sorted GLOBALLY.
//
// The report: filter the request log to one address, get far more matches than
// one page holds, click "Date & Time" ascending to reach the OLDEST request —
// and only the fifty rows already on screen are reordered. The oldest row is on
// the last page by construction, so the control could never do the job it was
// clicked for.
//
// WHAT MAKES THESE TESTS NON-VACUOUS. The fixture puts the extreme value (the
// largest `ms`, and the `error` level) on the row with the OLDEST timestamp, so
// under the default `ts DESC` ordering it sits on the LAST page. A page-local
// sort of page 1 can never surface it; a global sort must put it first. If the
// extreme happened to be on page 1 already, both implementations would agree
// and every assertion below would hold against the unfixed code.
//
// The fixture is a synthetic JSONL file planted in the server's own LOG_DIR —
// the established house pattern (functional-core-a "logs stream spans multiple
// rotated files"). It touches `fs` and `path` only: no app module, no DB
// handle, so neither the v7.20.2 module-scope lock nor the v7.21.14 lib/email
// lock is engaged. Every row carries a per-run fingerprint and the query is
// `q=<fingerprint>`, so the matched set is EXACTLY the fixture and `total` is
// known — the server's own access log is being written throughout by the test's
// own traffic, and anything less selective would move under the assertions.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { apiLogin, TEST_DATA_DIR } = require("./helpers");
const { readySpawnedServer } = require("./spawned-server");
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
// 2001 so the file can never collide with a real test-run day, and it sorts
// LAST in the newest-first file walk, which is where an old day belongs.
const FIXTURE_DAY = "2001-06-12";
const FIXTURE_FILE = path.join(LOG_DIR, `app-${FIXTURE_DAY}.jsonl`);
const BASE_MS = Date.parse(`${FIXTURE_DAY}T00:00:00.000Z`);

/**
 * Plant `n` rows, newest LAST in file order (the reader walks a file backwards,
 * so the last line is the newest — matching how the logger appends).
 *
 * Row i carries ts = BASE + i seconds, so row 0 is the OLDEST. The extreme
 * values live on row 0.
 */
function plant(file, n, fp) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      ts: new Date(BASE_MS + i * 1000).toISOString(),
      // Row 0 is the only `error`; the rest cycle through the lesser levels, so
      // a severity sort has exactly one right answer at the top.
      level: i === 0 ? "error" : ["info", "debug", "info", "warn"][i % 4],
      msg: `${fp} row-${String(i).padStart(4, "0")}`,
      method: "GET",
      path: `/fixture/${i}`,
      status: 400 + (i % 5),
      // Row 0 carries the largest duration; row 1 carries NONE at all, so the
      // blanks-last rule has something to be wrong about.
      ...(i === 1 ? {} : { ms: i === 0 ? 999999 : i }),
      ip: "203.0.113.9",
    }));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

const q = (fp, extra = "") => `/api/admin/logs?stream=app&q=${fp}&${extra}`;

// ── the comparator itself ────────────────────────────────────────────────────
//
// These are pure unit tests over lib/log-sort.js, and they exist because ONE of
// the properties below cannot be reached behaviourally at all.
//
// `Array.prototype.sort` has been required to be stable since ES2019, and the
// selection builds its candidate array in walk order — so among rows tying on
// the sort key, stability alone preserves a deterministic order and the paging
// test above passes with the `walkSeq` tiebreak DELETED (measured). A
// behavioural test therefore cannot distinguish "has a total order" from
// "happens to rely on V8's sort being stable", and claiming it as
// mutation-verified would be exactly the vacuous lock this suite keeps
// rebuilding. So the total order is asserted directly, at the comparator.
const logSort = require("../lib/log-sort");

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("Log comparator (v7.25.0)", () => {
  const wrap = (row, seq) => ({ row, seq });

  test("two rows sharing BOTH the sort key and the timestamp still have an order", () => {
    const cmp = logSort.makeLogComparator("status", "asc");
    const same = { ts: "2001-06-12T00:00:00.000Z", status: 404 };
    expect(cmp(wrap({ ...same }, 1), wrap({ ...same }, 2))).toBeLessThan(0);
    expect(cmp(wrap({ ...same }, 2), wrap({ ...same }, 1))).toBeGreaterThan(0);
    // …and the direction flip must NOT reverse the tiebreak: it is what makes
    // the order total, not part of the ordering the admin asked for.
    const desc = logSort.makeLogComparator("status", "desc");
    expect(desc(wrap({ ...same }, 1), wrap({ ...same }, 2))).toBeLessThan(0);
  });

  test("the comparator never returns NaN, even for a row with no usable timestamp", () => {
    const cmp = logSort.makeLogComparator("msg", "asc");
    for (const bad of [undefined, null, "", "not-a-date"]) {
      const r = cmp(wrap({ ts: bad, msg: "a" }, 1), wrap({ ts: bad, msg: "a" }, 2));
      expect(Number.isNaN(r), `ts=${String(bad)} produced NaN`).toBe(false);
    }
  });

  test("a numeric blank sorts LAST in BOTH directions", () => {
    // The one branch where the missing-value rule must survive the direction
    // flip. Ascending it is obvious; descending is where a naive
    // `(a-b)*dir` puts every blank first.
    const rows = [
      wrap({ ts: "2001-06-12T00:00:03.000Z", ms: 5 }, 0),
      wrap({ ts: "2001-06-12T00:00:02.000Z" }, 1),            // no ms at all
      wrap({ ts: "2001-06-12T00:00:01.000Z", ms: 100 }, 2),
    ];
    const asc = rows.slice().sort(logSort.makeLogComparator("ms", "asc")).map(r => r.row.ms);
    const desc = rows.slice().sort(logSort.makeLogComparator("ms", "desc")).map(r => r.row.ms);
    expect(asc).toEqual([5, 100, undefined]);
    expect(desc).toEqual([100, 5, undefined]);
  });

  test("level sorts by SEVERITY, never alphabetically", () => {
    // Alphabetically this is debug, error, info, warn — which buries errors in
    // the middle of the one column an operator sorts to triage.
    const rows = ["info", "error", "debug", "warn"].map((level, i) =>
      wrap({ ts: `2001-06-12T00:00:0${i}.000Z`, level }, i));
    const desc = rows.slice().sort(logSort.makeLogComparator("level", "desc")).map(r => r.row.level);
    expect(desc).toEqual(["error", "warn", "info", "debug"]);
  });

  test("the globally-sortable set is row-native only", () => {
    // An enrichment column would need a whole-directory lookup per request; the
    // pane still lets you click it, and the response says it sorted locally.
    for (const c of ["ts", "level", "msg", "method", "path", "status", "ms", "ip"]) {
      expect(logSort.LOG_SORT_COLUMNS.has(c), `${c} should be globally sortable`).toBe(true);
    }
    for (const c of ["user_email", "user_first_name", "user_last_name", "user_groups", "changed_by"]) {
      expect(logSort.LOG_SORT_COLUMNS.has(c), `${c} must NOT be globally sortable`).toBe(false);
    }
  });
});

test.describe("Filtered logs sort globally (v7.25.0)", () => {
  test("a filtered non-default sort ranks the WHOLE match set, not the page", async () => {
    const fp = `gsort${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 25, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        // Control first: under the DEFAULT ordering the extreme row is not on
        // page 1. Without this the test cannot claim the sort did anything.
        const dflt = await (await api.get(q(fp, "limit=10"))).json();
        expect(dflt.total, "the fingerprint isolates exactly the fixture").toBe(25);
        expect(dflt.entries.map(e => e.ms).includes(999999),
          "precondition: the extreme ms is NOT on page 1 under ts DESC").toBe(false);
        expect(dflt.sorted_globally, "the default ordering keeps the fast path").toBe(false);
        expect(dflt.sort_scope).toBe("default");

        // Now rank the whole set.
        const byMs = await (await api.get(q(fp, "limit=10&sort=ms&dir=desc"))).json();
        expect(byMs.sorted_globally).toBe(true);
        expect(byMs.sort_scope).toBe("global");
        expect(byMs.entries[0].ms, "the global maximum leads page 1").toBe(999999);
        expect(byMs.total, "ranking does not change how many matched").toBe(25);

        // Severity, which has its own comparator branch.
        const byLevel = await (await api.get(q(fp, "limit=10&sort=level&dir=desc"))).json();
        expect(byLevel.sorted_globally).toBe(true);
        expect(byLevel.entries[0].level, "error outranks warn/info/debug").toBe("error");
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("ascending time reaches the OLDEST rows on page 1 — the reported case", async () => {
    const fp = `gasc${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 25, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        const asc = await (await api.get(q(fp, "limit=5&sort=ts&dir=asc"))).json();
        expect(asc.sorted_globally).toBe(true);
        expect(asc.entries.map(e => e.msg.split(" ").pop()))
          .toEqual(["row-0000", "row-0001", "row-0002", "row-0003", "row-0004"]);

        // The anchor is still the NEWEST matching row, taken from walk order.
        // Seeding it from the sorted page would pin an ancient ceiling and the
        // admin would page forward into an empty table. The fixture makes the
        // two different, or this assertion would be vacuous.
        expect(asc.anchor_ts).toBe(new Date(BASE_MS + 24 * 1000).toISOString());
        expect(asc.entries[0].ts).not.toBe(asc.anchor_ts);

        // Page 2 under that anchor continues the ascending order with no
        // duplicates and no drops.
        const p2 = await (await api.get(q(fp, `limit=5&offset=5&sort=ts&dir=asc&anchor=${encodeURIComponent(asc.anchor_ts)}`))).json();
        expect(p2.entries.map(e => e.msg.split(" ").pop()))
          .toEqual(["row-0005", "row-0006", "row-0007", "row-0008", "row-0009"]);
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("paging the whole globally-sorted set yields every row exactly once", async () => {
    // The total-order guarantee (v6.10.54). `status` takes only 5 distinct
    // values across 25 rows, so every page boundary lands inside a tie — which
    // is the only arrangement where a missing tiebreak drops or duplicates a
    // row. HIGH_WATER is 2×(offset+limit), so at limit=4 the trim runs several
    // times rather than being hidden by one final sort.
    const fp = `gtie${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 25, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        const seen = [];
        let anchor = null;
        for (let page = 0; page < 7; page++) {
          const url = q(fp, `limit=4&offset=${page * 4}&sort=status&dir=asc`) + (anchor ? `&anchor=${encodeURIComponent(anchor)}` : "");
          const r = await (await api.get(url)).json();
          if (page === 0) anchor = r.anchor_ts;
          expect(r.sorted_globally).toBe(true);
          seen.push(...r.entries.map(e => e.msg));
        }
        expect(seen.length).toBe(25);
        expect(new Set(seen).size, "no row appears on two pages").toBe(25);

        // Re-fetching a middle page is byte-identical, not merely the same size.
        const a = await (await api.get(q(fp, `limit=4&offset=8&sort=status&dir=asc&anchor=${encodeURIComponent(anchor)}`))).json();
        const b = await (await api.get(q(fp, `limit=4&offset=8&sort=status&dir=asc&anchor=${encodeURIComponent(anchor)}`))).json();
        expect(a.entries.map(e => e.msg)).toEqual(b.entries.map(e => e.msg));
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("an UNFILTERED sort is refused and says why — the control that keeps the walk bounded", async () => {
    // Without this, "always sort globally" satisfies every test above while
    // re-introducing an unbounded walk on the pane's default view and on its
    // 15-second poll.
    const { api } = await apiLogin("superadmin");
    try {
      const r = await (await api.get("/api/admin/logs?stream=app&limit=10&sort=ms&dir=desc")).json();
      expect(r.sortable_globally).toBe(false);
      expect(r.sorted_globally).toBe(false);
      expect(r.sort_scope).toBe("page");
      expect(r.sort_unavailable).toBe("unfiltered");
    } finally { await api.dispose(); }
  });

  test("an explicit ts DESC is recognised AS the default and keeps the fast path", async () => {
    // A client echoing its own sort state back must not downgrade every poll
    // onto the exhaustive walk.
    const fp = `gdef${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 12, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        const r = await (await api.get(q(fp, "limit=5&sort=ts&dir=desc"))).json();
        expect(r.sort_scope).toBe("default");
        expect(r.sorted_globally).toBe(false);
        expect(r.sort_unavailable).toBeNull();
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("an unrecognised sort column is IGNORED, not rejected", async () => {
    // The value comes from a header click, so a stale client asking for a
    // retired column must still get rows (the v7.21.16 posture).
    const fp = `gunk${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 6, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        const res = await api.get(q(fp, "limit=5&sort=banana&dir=asc"));
        expect(res.status()).toBe(200);
        const r = await res.json();
        expect(r.sort).toBeNull();
        expect(r.entries.length).toBe(5);
        expect(r.sorted_globally).toBe(false);
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("a column that only exists after enrichment sorts LOCALLY and admits it", async () => {
    // user_email / user_first_name / user_last_name / user_groups are attached
    // at read time to the already-sliced page, so they cannot be ranked without
    // building a whole-directory lookup per request. A header click still
    // works; the response must not claim it ranked everything.
    const fp = `genr${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 12, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        const r = await (await api.get(q(fp, "limit=5&sort=user_email&dir=asc"))).json();
        expect(r.sorted_globally).toBe(false);
        expect(r.entries.length).toBe(5);
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("too deep a page falls back to page-local ordering and names the reason", async () => {
    const fp = `gdeep${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 6, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        const r = await (await api.get(q(fp, "limit=500&offset=900000&sort=ms&dir=desc"))).json();
        expect(r.sortable_globally).toBe(false);
        expect(r.sorted_globally).toBe(false);
        expect(r.sort_unavailable).toBe("window_too_deep");
        expect(r.sort_max_window).toBeGreaterThan(0);
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("a ranking cut short by the scan budget does NOT claim to be global", async () => {
    // The honesty claim of the whole feature. With the budget below the fixture
    // size the selection ranks only the newest N matching rows — real, useful
    // work, but not a ranking of every match, and presenting it as one is the
    // wrong answer this endpoint is being changed to stop giving.
    //
    // The budget is env-read at module scope, so this drives a server of its
    // own rather than trying to change the shared one underneath other specs.
    const { spawn } = require("child_process");
    const os = require("os");
    const { PORT_BASE } = require("./helpers");
    const port = PORT_BASE + 113;
    const BASE = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbudget-"));
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    const fp = `gbud${Date.now().toString(36)}`;
    // Bigger than the budget below, so the walk provably stops before the
    // oldest rows. LOG_SCAN_BUDGET has a 1000-line floor (a nonsense value
    // would make every read useless), so the fixture has to clear it.
    plant(path.join(dataDir, "logs", `app-${FIXTURE_DAY}.jsonl`), 1500, fp);
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        LOG_DISABLE_ACCESS: "1",          // keep the budget spent on the fixture
        LOG_SCAN_BUDGET: "1000",
        NODE_OPTIONS: "",                 // v7.15.30 — never inherit the runner's flags
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", b => { out += b.toString(); });
    child.stderr.on("data", b => { out += b.toString(); });
    try {
      const pass = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => out });
      let cookie = "";
      const go = async (p, opts = {}) => {
        const headers = {};
        if (cookie) headers.cookie = cookie;
        if (opts.body) headers["content-type"] = "application/json";
        if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
        const r = await fetch(`${BASE}${p}`, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
        return { status: r.status, json: await r.json().catch(() => null) };
      };
      const tok = (await go("/api/csrf-token")).json.csrfToken;
      expect((await go("/api/login", { method: "POST", csrf: tok, body: { email: "superadmin", password: pass } })).status).toBe(200);
      const r = (await go(`/api/admin/logs?stream=app&q=${fp}&limit=5&sort=ms&dir=desc`)).json;
      expect(r.sorted_globally, "a prefix ranking must not be reported as global").toBe(false);
      expect(r.sort_scope).toBe("scanned_prefix");
      expect(r.sort_unavailable).toBe("scan_budget");
      expect(r.total_exact).toBe(false);
      expect(r.truncated_reason).toBe("scan_budget");
      // …and the rows returned are still the ranking OF WHAT WAS SCANNED, which
      // is real work worth keeping rather than discarding.
      expect(r.entries.length).toBeGreaterThan(0);
      // The global extreme lives on the oldest row, which is beyond the budget.
      expect(r.entries.some(e => e.ms === 999999)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a `since` bound reports an EXACT total — it is a clean stop, not a truncation", async () => {
    // `sinceBoundHit` sets `truncated`, which made the pager render "N+" and
    // disable Last over a count that was exact: the walk is newest-first, so
    // the first row older than `since` proves every remaining row is out of
    // scope. `total_exact` is the field the pager reads for that reason.
    const fp = `gsince${Date.now().toString(36)}`;
    plant(FIXTURE_FILE, 25, fp);
    try {
      const { api } = await apiLogin("superadmin");
      try {
        // Rows 10..24 are at or after BASE+10s.
        const since = new Date(BASE_MS + 10 * 1000).toISOString();
        const r = await (await api.get(q(fp, `limit=5&since=${encodeURIComponent(since)}`))).json();
        expect(r.total).toBe(15);
        expect(r.total_exact, "a since-bounded walk counted everything in scope").toBe(true);
        expect(r.truncated_reason).toBe("since_bound");
        expect(r.total_pages).toBe(3);
      } finally { await api.dispose(); }
    } finally { try { fs.unlinkSync(FIXTURE_FILE); } catch (_) {} }
  });

  test("the unfiltered default view still reports its total as a FLOOR", async () => {
    // The other direction, and the one that would be a wrong answer on the
    // screen an admin opens: the early stop is a deliberate floor, so
    // `total_exact` must be false there or the pager would offer to jump to a
    // last page computed from 51 rows of a log holding millions.
    const { api } = await apiLogin("superadmin");
    try {
      const r = await (await api.get("/api/admin/logs?stream=access&limit=10")).json();
      expect(r.total_exact).toBe(false);
      expect(r.truncated_reason).toBe("early_stop");
    } finally { await api.dispose(); }
  });
});
