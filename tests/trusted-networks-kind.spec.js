// v8.1.0 — PR 20 / L10: one trusted-network rule, and the alert stops naming a
// control the platform refuses.
//
// This is v7.21.14 resurfacing through a new door. That release fixed the alert
// telling a superadmin to "put <ip> in Trusted network IPs and save" for a
// MULTI-SESSION competition, which the route refuses. A Program has NO sessions,
// so it would have satisfied the old single-session eligibility test and taken the
// same branch — advertising the same refused control.
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, TEST_DB_PATH, TEST_DATA_DIR } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `tn${Date.now().toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// The window predicate reads the live DB, so ask the real module rather than
// re-typing its SQL here (a copy would test the copy).
//
// IT MUST BE RE-REQUIRED WITH A PURGED CACHE, and this cost a confusing hour.
// v7.20.2: db.js opens the SQLite file at REQUIRE time, and the per-file recycle
// DELETES and recreates that file — so a handle bound earlier in this worker
// reads an UNLINKED INODE and answers about the PREVIOUS file's database, with no
// error. The symptom was perfect: rows visibly present via a fresh connection,
// and anyCompetitionLive() returning null for all of them. recycleServer purges
// exactly these modules for exactly this reason; do the same here.
function liveNow() {
  // AND POINT db.js AT THE RIGHT FILE. The Playwright worker does not inherit the
  // server's DATA_DIR, so a bare require opens ./data/hackathon.db — a DIFFERENT,
  // real database. That is why every row was visibly present through
  // TEST_DB_PATH while the module answered null about all of them: it was reading
  // somewhere else entirely, with no error.
  process.env.DATA_DIR = TEST_DATA_DIR;
  // Purge EXACTLY the two, by resolved path. A broad sweep over lib/*.js purges
  // modules mid-cycle and leaves comp-allowlist holding an undefined `db`.
  delete require.cache[require.resolve("../db")];
  delete require.cache[require.resolve("../lib/comp-allowlist")];
  return require("../lib/comp-allowlist").anyCompetitionLive();
}

test.describe("v8.1.0 — trusted networks follow the kind", () => {
  test("a Program REFUSES trusted IPs, at create and at edit; a Competition still accepts them", async () => {
    const { api, csrf } = await sa();
    const h = H(csrf);
    try {
      const start = new Date(Date.now() - 3600e3).toISOString();
      // A Program is single-session by the implemented rule, so it would SATISFY
      // the old eligibility test — and a decade-long rate-limit bypass is exactly
      // what the time-bounding exists to prevent.
      const bad = await api.post("/api/admin/competitions", {
        headers: h,
        data: {
          name: `${TAG} ProgIP`, event_kind: "program", start_time: start,
          deadline_at: new Date(Date.now() + 200 * 86400e3).toISOString(),
          timezone: "UTC", trusted_network_ips: "203.0.113.7",
        },
      });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).code).toBe("trusted_networks_forbidden");

      // …and on EDIT, or the state is reachable by creating it clean and adding
      // the address afterwards.
      const ok = await api.post("/api/admin/competitions", {
        headers: h,
        data: {
          name: `${TAG} ProgClean`, event_kind: "program", start_time: start,
          deadline_at: new Date(Date.now() + 200 * 86400e3).toISOString(), timezone: "UTC",
        },
      });
      expect(ok.ok(), await ok.text()).toBeTruthy();
      const prog = (await ok.json()).competition;
      const put = await api.put(`/api/admin/competitions/${prog.id}`, {
        headers: h, data: { trusted_network_ips: "203.0.113.7", expectedUpdatedAt: prog.updated_at },
      });
      expect(put.status()).toBe(400);
      expect((await put.json()).code).toBe("trusted_networks_forbidden");

      // The positive control: a single-session Competition still accepts them, or
      // "the Program was refused" is satisfied by a build that refuses everyone.
      const good = await api.post("/api/admin/competitions", {
        headers: h,
        data: {
          name: `${TAG} CompIP`, start_time: start, duration_minutes: 600,
          timezone: "UTC", trusted_network_ips: "203.0.113.8",
        },
      });
      expect(good.ok(), `a Competition still accepts trusted IPs: ${await good.text()}`).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("L10: the venue-attribution query EXCLUDES Programs and is totally ordered", async () => {
    const { api, csrf } = await sa();
    const h = H(csrf);
    const Database = require("better-sqlite3");
    try {
      // Clear the field first: anyCompetitionLive answers about the WHOLE platform,
      // and the seeded fixtures include live competitions.
      const db0 = new Database(TEST_DB_PATH);
      try { db0.prepare("UPDATE competitions SET ended_at = COALESCE(ended_at, ?)").run(new Date(Date.now() - 60_000).toISOString()); }
      finally { db0.close(); }
      require("../lib/comp-allowlist").invalidateCompAllowlist();
      expect(liveNow(), "nothing live to begin with").toBeNull();

      const start = new Date(Date.now() - 3600e3).toISOString();
      const progR = await api.post("/api/admin/competitions", {
        headers: h,
        data: {
          name: `${TAG} L10 Prog`, event_kind: "program", start_time: start,
          deadline_at: new Date(Date.now() + 200 * 86400e3).toISOString(), timezone: "UTC",
        },
      });
      expect(progR.ok(), await progR.text()).toBeTruthy();

      // A live PROGRAM must not be reported. Left in, it would compute
      // accepts_trusted_ips = true (no sessions) and the alert would tell a
      // superadmin to use a control the route now refuses.
      expect(liveNow(), "a live Program is not a venue attribution").toBeNull();

      // A Booth Event and a Competition, both live: the answer must be stable
      // rather than whatever SQLite returned first.
      const boothR = await api.post("/api/admin/competitions", {
        headers: h,
        data: { name: `${TAG} L10 Booth`, event_kind: "booth", start_time: start, duration_minutes: 600, timezone: "UTC" },
      });
      expect(boothR.ok(), await boothR.text()).toBeTruthy();
      const compR = await api.post("/api/admin/competitions", {
        headers: h,
        data: { name: `${TAG} L10 Comp`, start_time: new Date(Date.now() - 7200e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
      });
      expect(compR.ok(), await compR.text()).toBeTruthy();

      const seen = new Set();
      for (let i = 0; i < 5; i++) seen.add(liveNow() && liveNow().name);
      expect(seen.size, "the same event every time — LIMIT 1 without an ORDER BY is not a choice").toBe(1);
      const row = liveNow();
      expect(row, "a live window-shaped event IS reported").toBeTruthy();
      expect(row.name, "most recently started wins").toContain("L10 Booth");
      expect(row.accepts_trusted_ips, "and it really can take the control the alert will name").toBe(true);
    } finally { await api.dispose(); }
  });

  test("the ORDER BY is present in source, and Programs are excluded there", () => {
    // The behavioural test above can be satisfied by luck on a small table; these
    // two clauses are what make it deterministic, so pin them directly.
    const fs = require("fs"), path = require("path");
    // STRIP COMMENTS FIRST. The first draft anchored on the raw file and matched
    // the explanatory comment THIS PATCH added — which quotes the very SQL it is
    // looking for. Same trap the v7.21.13 scanner documents; single-pass stripper
    // so whichever comment opens first wins.
    const raw = fs.readFileSync(path.join(__dirname, "..", "lib", "comp-allowlist.js"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ""));
    const at = src.indexOf("accepts_trusted_ips");
    expect(at, "the venue-attribution query is findable in stripped source").toBeGreaterThan(-1);
    const q = src.slice(at, at + 900);
    expect(q, "Programs are excluded from venue attribution").toMatch(/event_kind\s*<>\s*'program'/);
    expect(q, "and the single row it returns is chosen, not arbitrary").toMatch(/ORDER BY/);
  });

  test("the no-event alert branch no longer claims a venue is unlikely, in BOTH copies", () => {
    // anyCompetitionLive now excludes Programs, so a room working through one
    // lands in this branch — and "this is unlikely to be a venue" would be the
    // v7.21.14 defect with the sides swapped.
    const fs = require("fs"), path = require("path");
    const server = fs.readFileSync(path.join(__dirname, "..", "lib", "admin-alerts.js"), "utf8");
    const client = fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "admin-alerts.js"), "utf8");
    for (const [name, src] of [["lib/admin-alerts.js", server], ["public/js/features/admin-alerts.js", client]]) {
      expect(src.includes("so this is unlikely to be a venue"),
        `${name} still asserts a venue is unlikely`).toBe(false);
      expect(src, `${name} names the Program case instead`).toMatch(/self-paced Program/);
      expect(src, `${name} still offers the remedy that exists`).toMatch(/RATE_LIMIT_ALLOWLIST_IPS/);
    }
  });
});
