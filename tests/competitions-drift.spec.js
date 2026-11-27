// v7.29.0 — PR 8: the competitions export was missing six existing non-secret
// columns and had no drift guard at all. Built and seen RED before the columns
// were added — a guard born green has never demonstrated it can see anything.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");

// ── v7.29.0 — competitions schema-drift guard ────────────────────────────────
test.describe("v7.29.0 — competitions export/schema drift", () => {
  // Every `competitions` column must be a DECISION: it either reaches the export
  // file or is explicitly exempted with a reason. Coverage is the wrong demand —
  // `cxone_api_key` and `self_enroll_token` must NEVER be exported, so a scanner
  // requiring every column to reach the file would be wrong about working code.
  //
  // Modelled on the users guard (functional-security-a), which is the ONLY
  // classification guard in the suite. The competition_users and hint_reveals
  // "guards" assert a single named column exists and would not notice a new one.
  const EXPORTED = new Set([
    "name", "start_time", "duration_minutes", "ended_at", "ended_manually",
    "leaderboard_mode", "reveal_answers_on_end", "cxone_group_name", "created_at",
    // v7.29.0 — the four that were silently missing. The strongest case is
    // cxone_disabled: it is an opt-OUT, so losing it means the target STARTS
    // creating external CxOne identities for an event whose operator had turned
    // that off. The failure direction is active, not merely lossy.
    "self_enroll_enabled",
    "group_leaderboard_enabled", "cxone_disabled",
    // v8.12.0 — "Staff can compete". Same reasoning as cxone_disabled: it is a
    // decision about WHO is on the board, and an event re-created without it
    // would keep the staff it was built for off the board with nothing erroring.
    "staff_compete",
  ]);
  const EXCLUDED = new Map([
    // v7.29.0 — the event-kind columns. EXPORTED once the kinds are reachable and
    // an import can honour them; until then, exporting a field nothing reads on
    // the target would be a promise the importer cannot keep.
    ["event_kind", "Phase 3: not exported until the import can honour a kind."],
    // v8.4.0 — `registration_mode` is GONE from the schema (db.js drops it), so the
    // entry goes with it: the guard fails a stale exemption naming a column db.js
    // no longer has, and rightly — that is how the v8.2.2 ceiling exemption was
    // caught. Its successor is `registration_field_policy` below.
    ["registration_field_policy", "The per-event sign-up matrix. EXCLUDED for the same reason as the whole event-kind block: there is no competitions IMPORT endpoint, so an exported value is a promise nothing on the target can keep — and this one would be worse than inert, because the states it carries decide what a NON-DISMISSIBLE completion gate demands of accounts on the target."],
    ["linkedin_signup_enabled", "As registration_field_policy: no importer can honour it, and a door left closed on a target where the event does not exist is a setting nobody can find to reopen."],
    ["deadline_at", "Phase 3: as event_kind."],
    ["time_basis", "Phase 3: as event_kind."],
    ["measure_presence", "Phase 3: as event_kind."],
    ["auto_end_on_all_solved", "Phase 3: as event_kind."],
    // v8.1.0 — the EVENT-level ceiling. Still EXCLUDED, and the reason changed
    // rather than disappearing: the challenge-level cap is exported because the
    // tasks importer honours it, but there is NO competitions importer at all, so
    // a value in that file is a promise nothing on the target can keep. The whole
    // nine-column block is excluded on this basis and this column is not special.
    ["attempt_cap", "There is no competitions IMPORT endpoint, so an exported value is a promise nothing on the target can keep. The challenge-level cap IS exported, because the tasks importer honours it."],
    ["join_code", "A join CAPABILITY, like self_enroll_token — never exported."],
    ["self_enroll_allow_instant", "RETIRED (operator ruling, 14 Nov 2026): the \"Allow instant join\" switch changed nothing, nothing reads or writes the column, and a create or edit naming it is refused by name."],
    // v8.15.0 — the per-event certificate DESIGN override. Excluded on the same basis
    // as the event-kind block (there is no competitions IMPORT endpoint, so an exported
    // value is a promise nothing on the target can keep), not because it is secret. The
    // GLOBAL design is a settings row and leaves with GET /api/admin/export/settings.
    ["event_look", "The per-event look. There is no competitions IMPORT endpoint, so an exported value is a promise nothing on the target can keep — the certificate_config basis."],
    ["event_look_locked", "As event_look: it means nothing without the look it locks."],
    ["certificate_config", "There is no competitions IMPORT endpoint, so an exported value is a promise nothing on the target can keep. The global certificate design rides the settings export."],
    // v8.6.0 — late entries, EXCLUDED on the same basis as the nine-column block
    // above and NOT because they are unimportant: there is no competitions IMPORT
    // endpoint, so an exported value is a promise nothing on the target can keep.
    // The deadline is the sharper case of the two, and worth stating so nobody
    // "helpfully" exports it later: it is an ABSOLUTE INSTANT derived from THIS
    // event's end, so carried into a target where the same event runs on different
    // dates it would name a window that closed before the event started — a
    // setting that is not merely inert but actively wrong.
    ["late_entry_enabled", "There is no competitions IMPORT endpoint, so an exported value is a promise nothing on the target can keep — the same basis as the whole event-kind block."],
    ["late_entry_deadline_at", "As late_entry_enabled, and worse: an absolute instant derived from THIS event's end would, on a target running the same event on different dates, name a window that closed before the event began."],
    ["id", "Surrogate key. The import envelope resolves by NAME, so an id from another server identity is misleading."],
    ["cxone_api_key", "A per-competition credential. On _REDACT_KEYS and stripped by _compWire — exporting it puts a live credential in a file operators pass around."],
    ["self_enroll_token", "A 256-bit join capability. Revealed only by the dedicated admin endpoint and scrubbed from access logs."],
    ["updated_at", "Optimistic-concurrency bookkeeping scoped to THIS database. A foreign value seeds an If-Match token for edits that never happened here."],
    ["trusted_network_ips", "lib/competitions._compWire already strips this from API responses because 'it names a venue's public address'. An export file is strictly more portable than an admin response, and 'time-bounded therefore inert' is a property of the ROW, not the file: the export carries start_time and duration, so an import re-arms the address — and shifting start_time on import, the normal reason to import a template, makes the bypass live again."],
  ]);

  test("every competitions column is exported or explicitly exempted", () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let cols;
    try { cols = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name); }
    finally { db.close(); }
    expect(cols.length, "the table was found").toBeGreaterThan(10);
    const unclassified = cols.filter(c => !EXPORTED.has(c) && !EXCLUDED.has(c));
    expect(unclassified,
      "a new competitions column must be added to EXPORTED (and reach the export) or to EXCLUDED with its reason"
    ).toEqual([]);
    // The other direction, as the L9 audit guard does it: a decision about a column that no longer exists reads as coverage and is not; drop the entry with the column.
    const stale = [...EXPORTED, ...EXCLUDED.keys()].filter(c => !cols.includes(c));
    expect(stale, "EXPORTED or EXCLUDED names a competitions column that no longer exists").toEqual([]);
  });

  test("every EXPORTED competitions column actually reaches the file", async () => {
    // The users guard's own history is the argument for this second half: columns
    // sat in EXPORTED while the CSV silently dropped them (v7.15.8), because
    // classification and delivery were never checked against each other.
    const { api } = await apiLogin("superadmin");
    const body = await (await api.get("/api/admin/export/competitions")).json();
    await api.dispose();
    expect(Array.isArray(body.competitions), "the export has competitions").toBe(true);
    expect(body.competitions.length, "the seed provides at least one").toBeGreaterThan(0);
    const keys = new Set(Object.keys(body.competitions[0]));
    const missing = [...EXPORTED].filter(c => !keys.has(c));
    expect(missing, "classified EXPORTED but absent from the export payload").toEqual([]);
    const leaked = [...EXCLUDED.keys()].filter(c => keys.has(c));
    expect(leaked, "classified EXCLUDED but present in the export payload").toEqual([]);
  });
});

// The gap the drift guard exposed: the `created` audit event recorded neither
// self-enroll flag while BOTH are recorded on `edited`. So a competition BORN
// with a live join link — and with the 48h verification bypass — left no trace of
// where that came from, and only a later CHANGE was auditable.
//
// The emit is wrapped in a try/catch like every audit emit here, so a mistake in
// it is SILENT by construction (v7.21.32). Only a test that asserts the row's
// contents can see it — `node --check` cannot: the first version of this fix
// referenced a variable that does not exist and passed a syntax check.
test("v7.29.0: creating a competition records its self-enroll flag (and no retired switch)", async () => {
  const { apiLogin } = require("./helpers");
  const { api, csrf } = await apiLogin("superadmin");
  const stamp = Date.now();
  const r = await api.post("/api/admin/competitions", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: {
      name: `AuditFlags ${stamp}`,
      start_time: new Date(Date.now() + 3600_000).toISOString(),
      duration_minutes: 60, timezone: "UTC",
      self_enroll_enabled: true,
    },
  });
  expect(r.ok(), `create: ${r.status()} ${await r.text()}`).toBeTruthy();
  const compId = (await r.json()).competition.id;

  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  let ev;
  try {
    ev = db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'").get(compId);
  } finally { db.close(); }
  expect(ev, "the created event exists").toBeTruthy();
  const d = JSON.parse(ev.details);
  expect(d.self_enroll_enabled, "a competition born with a live join link says so").toBe(true);
  expect(d, "the retired instant-join switch is not recorded").not.toHaveProperty("self_enroll_allow_instant");
  await api.dispose();
});

// v7.29.0 — PR 10a: ONE ladder for the platform name.
//
// There were two: lib/settings.getPlatformName() and a second boot-time COALESCE
// over the same three sources in server.js, used only by the startup banner. A
// shared value with two fallback ladders is not shared (v7.21.31) — and this one
// mattered because the default itself was changing, so the banner would have kept
// announcing the retired name on a deployment that set nothing.
//
// A source lock rather than a behavioural one, deliberately: reaching the default
// requires a server with no settings row AND no COMPETITION_NAME, and the shared
// test server pins the latter, so a behavioural test would have to spawn a server
// to assert one string.
test("v7.29.0: the platform-name default has exactly one owner", () => {
  const fs = require("fs"), pathMod = require("path");
  const root = pathMod.join(__dirname, "..");
  const strip = src => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "));

  const settings = fs.readFileSync(pathMod.join(root, "lib", "settings.js"), "utf8");
  expect(strip(settings), "lib/settings owns the fallback")
    .toMatch(/process\.env\.COMPETITION_NAME \|\| "Checkmarx Enablement Platform"/);

  // Nobody else may re-derive it.
  const walk = (dir) => fs.readdirSync(pathMod.join(root, dir))
    .filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);
  const offenders = [];
  for (const f of ["server.js", "db.js", ...walk("routes"), ...walk("lib")]) {
    if (f === "lib/settings.js") continue;
    if (/process\.env\.COMPETITION_NAME/.test(strip(fs.readFileSync(pathMod.join(root, f), "utf8")))) {
      offenders.push(f);
    }
  }
  expect(offenders, "call getPlatformName() instead of re-reading COMPETITION_NAME").toEqual([]);

  // And the shipped HTML must not hard-code a name at all — it carries the
  // substitution marker the shell already resolves at send time, so the
  // first-paint value and the resolved value cannot disagree.
  for (const f of ["public/index.html"]) {
    const html = fs.readFileSync(pathMod.join(root, f), "utf8");
    expect(html, `${f} must not hard-code a platform name`).not.toMatch(/>Tournament</);
    expect(html, `${f} carries the substitution marker`).toContain("{{platformName}}");
  }
});

// v7.29.0 — the CSV header and the on-screen header must NAME THE SAME THING.
//
// They did not: the file said "Total Events" while the screen said "Total". The
// header is the contract with the human reading the file (v7.15.8), and the
// v7.27.0 note claims the two are "column-for-column identical" — which was true
// of the column SET and not of this label. Renaming both to "Total Activity"
// closes it and removes the collision with "Event" as the collective noun.
test("v7.29.0: the analytics Total column is named identically on screen and in the file", () => {
  const fs = require("fs"), pathMod = require("path");
  const root = pathMod.join(__dirname, "..");
  const html = fs.readFileSync(pathMod.join(root, "public", "index.html"), "utf8");
  const js = fs.readFileSync(pathMod.join(root, "public", "js", "features", "analytics-admin.js"), "utf8");
  expect(html, "the on-screen header").toContain('data-sort="total" style="cursor:pointer;text-align:right">Total Activity</th>');
  expect(js, "the CSV header").toContain("'Total Activity',");
  // And the retired spellings are gone from both, so a half-applied rename fails.
  expect(html).not.toContain('text-align:right">Total</th>');
  expect(js).not.toContain("'Total Events'");
});
