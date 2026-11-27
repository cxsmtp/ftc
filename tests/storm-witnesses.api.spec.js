// @ts-check
//
// THE SIGN-IN STORM FIXES, SEEN BEING REVERTED (sweep gap #275).
//
// tests/storm-hotpaths.api.spec.js and tests/smtp-pool-drain.spec.js lock the
// CONTRACT each storm fix keeps: the same bytes, the same board, the mail
// delivered. A reverted fix keeps that contract too (a rebuild per arrival, a
// compression per request and a relay connection per mail answer exactly as
// before, only slower), so those locks stay green while a 3000-person event start
// collapses again. These witnesses count the WORK:
//
//   1. Compress once (server.js `_assetEntry`): a frozen asset (the shell, the
//      help page, the stylesheet, and in the MINIFY_JS=1 prod-parity run the JS
//      bundle, which exists only there) is gzipped and brotli-compressed once,
//      when its entry is made, and never again however many requests follow,
//      whatever they accept. CONTROL: a static file frozen in neither mode (a raw
//      ES module other than the entry) is stream-compressed by compression() on
//      every request, so the counter sees per-request work.
//   2. The coalesced first entry (lib/leaderboard.js
//      `invalidateLeaderboardCacheForEntrant`, called by select-competition): K
//      people entering, each followed by a board read, rebuild the board at most
//      once per LEADERBOARD_ENTRY_COALESCE_MS window, not K times. CONTROLS: every
//      entrant still reaches the board EVENTUALLY, and a score change still
//      rebuilds on the very next read. The first control does not hold the
//      window: its poll outlasts the board cache's own 5 s lifetime, so even an
//      entry that never busted the board would pass it. That an entrant shows
//      WITHIN the window is held by tests/storm-hotpaths.api.spec.js ("entrant
//      coalescing": seen inside the window plus request slack, under that lifetime).
//   3. The ranked-board memo (lib/leaderboard.js `_rankedBoardMemo`): two reads of
//      one cached board rank it once (they return the SAME frozen array; a re-rank
//      builds a new one). CONTROLS: a fresh build, a bust and a change of the
//      presence basis each rank anew.
//
// The pooled relay, the fourth fix, needs a server of its own:
// tests/smtp-pool-bound.spec.js. The counts come from two test-only hooks,
// GET /api/test/leaderboard-builds (lib/leaderboard.js leaderboardComputeCount)
// and POST|GET /api/test/compression-count (zlib's entry points, wrapped once a
// spec arms them).
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
// The window, read from source rather than by requiring lib/ (which opens a DB).
const COALESCE_MS = Number((/const LEADERBOARD_ENTRY_COALESCE_MS = (\d+);/.exec(
  fs.readFileSync(path.join(__dirname, "..", "lib", "leaderboard.js"), "utf8")) || [])[1]);

async function mkParticipant(sa, saCsrf, nick) {
  const email = `sw_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Sw", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), `register ${nick}: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const listed = await (await sa.get(`/api/admin/participants?limit=5000`)).json();
  const u = (listed.participants || []).find(p => p.email === email);
  expect(u, `participant ${nick} exists`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
  return { id: u.id, email, nick };
}

test("compress once: a frozen asset is compressed when its entry is made, never per request; a static file is, every time", async () => {
  const { api } = await freshCtx();
  try {
    const armed = await api.post("/api/test/compression-count");
    expect(armed.ok(), `arm: ${await armed.text()}`).toBeTruthy();
    const counts = async () => {
      const r = await api.get("/api/test/compression-count");
      expect(r.ok()).toBeTruthy();
      const { ok: _ok, armed: _armed, ...c } = await r.json();
      return c;
    };
    expect(await counts(), "armed and zeroed").toEqual({ gzipSync: 0, brotliCompressSync: 0, createGzip: 0, createBrotliCompress: 0, createDeflate: 0 });
    // The shell names the versioned stylesheet and entry module; take them from
    // an identity read (which also makes the shell's entry).
    const shell = await api.get("/", { headers: { "accept-encoding": "identity" } });
    expect(shell.status()).toBe(200);
    const html = await shell.text();
    const css = (/href="(\/styles\.css\?v=[^"]+)"/.exec(html) || [])[1];
    expect(css, "the shell links the versioned stylesheet").toBeTruthy();
    const js = (/src="(\/js\/core\/main\.js\?v=[^"]+)"/.exec(html) || [])[1];
    expect(js, "the shell loads the versioned entry module").toBeTruthy();
    // The JS BUNDLE is a frozen body only where the server bundles
    // (MINIFY_JS=1, the documented prod-parity run, as in production); in the
    // raw-module mode /js/core/main.js is a plain static file, so it joins the
    // frozen storm only in the mode that freezes it (as
    // tests/storm-hotpaths.api.spec.js branches for its contract).
    const bundled = process.env.MINIFY_JS === "1";
    const frozen = ["/help.html", css, ...(bundled ? [js] : [])];
    // Each frozen body is made into an entry by its FIRST request (the shell's
    // identity read above already made the shell's).
    await api.get("/help.html", { headers: { "accept-encoding": "br" } });
    await api.get(css, { headers: { "accept-encoding": "gzip" } });
    if (bundled) await api.get(js, { headers: { "accept-encoding": "gzip" } });
    const entries = 1 + frozen.length;
    const made = await counts();
    expect(made, `each new entry (${entries}: the shell, ${frozen.join(", ")}): one gzip and one brotli, at once, and no stream`)
      .toEqual({ gzipSync: entries, brotliCompressSync: entries, createGzip: 0, createBrotliCompress: 0, createDeflate: 0 });
    // Then a storm of requests for every frozen body, in every encoding a
    // browser asks for (each sends "gzip, deflate, br" or a subset holding gzip or br).
    const storm = ["/", "/register", "/join/not-a-real-token", ...frozen];
    let served = 0;
    for (let i = 0; i < 10; i++) {
      for (const p of storm) {
        for (const enc of ["gzip", "br", "gzip, deflate, br", "identity"]) {
          const r = await api.get(p, { headers: { "accept-encoding": enc } });
          expect(r.status(), `${p} (${enc})`).toBe(200);
          expect(r.headers()["content-encoding"], `${p} (${enc})`).toBe(enc === "identity" ? undefined : (enc === "gzip" ? "gzip" : "br"));
          served++;
        }
      }
    }
    const head = await api.fetch("/help.html", { method: "HEAD", headers: { "accept-encoding": "gzip, br" } });
    expect(head.status()).toBe(200);
    expect(served, "anti-vacuity: the storm was served").toBe(storm.length * 40);
    expect(await counts(), `${served} requests for frozen bodies compressed nothing more`).toEqual(made);
    // CONTROL: a static file frozen in NEITHER mode is stream-compressed on
    // EVERY request: the largest ES module under /js/ other than the entry
    // (with MINIFY_JS=1 only /js/core/main.js is bundled into a frozen entry;
    // its sub-modules stay raw files, served as they are), so far over
    // compression()'s threshold that it is gzipped on the fly.
    const jsRoot = path.join(__dirname, "..", "public", "js");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const raw = walk(jsRoot)
      .map(f => ({ url: "/js/" + path.relative(jsRoot, f).split(path.sep).join("/"), size: fs.statSync(f).size }))
      .filter(f => f.url.endsWith(".js") && f.url !== "/js/core/main.js")
      .sort((a, b) => b.size - a.size)[0];
    expect(raw, "PRECONDITION: a raw module other than the entry").toBeTruthy();
    for (let i = 0; i < 3; i++) {
      const r = await api.get(raw.url, { headers: { "accept-encoding": "gzip" } });
      expect(r.status(), raw.url).toBe(200);
      expect(r.headers()["content-encoding"], `${raw.url} (${raw.size} bytes) is gzipped on the fly`).toBe("gzip");
    }
    const after = await counts();
    expect(after.createGzip - made.createGzip, `CONTROL: three requests for ${raw.url}, three gzip streams`).toBe(3);
    expect(after.gzipSync, "…and still no frozen-body compression").toBe(made.gzipSync);
  } finally { await api.dispose(); }
});

test("coalesced first entries: K people entering inside the window rebuild the board at most once per window, not K times", async () => {
  test.setTimeout(120_000);
  expect(COALESCE_MS, "PRECONDITION: the window constant is found").toBeGreaterThan(0);
  // Eight entrants: a rebuild per entry (8) stays apart from one per window even
  // if a slow runner stretches the eight entries over seven seconds.
  const K = 8;
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const created = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `SW ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
  }});
  expect(created.ok(), `create: ${await created.text()}`).toBeTruthy();
  const compId = (await created.json()).competition.id;
  // Two challenges, so one solve cannot finish the event (fixture checklist 1).
  const mkTask = async (n) => {
    const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
      title: `SW-${n} ${t}`, description: "<p>x</p>", difficulty: "hard", answer_type: "text", correct_answer: "a", status: "published",
    }});
    expect(r.ok(), `task ${n}: ${await r.text()}`).toBeTruthy();
    return (await r.json()).id;
  };
  const task1 = await mkTask(1), task2 = await mkTask(2);
  for (const id of [task1, task2]) {
    const r = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
    expect(r.ok(), `assign task: ${await r.text()}`).toBeTruthy();
  }
  const people = [];
  for (let i = 0; i <= K; i++) people.push(await mkParticipant(sa, csrf, `p${i}${t}`));
  const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: people.map(p => p.id), competitionIds: [compId] } })).json();
  expect(asg.assigned, `all ${K + 1} assigned: ${JSON.stringify(asg)}`).toBe(K + 1);
  const sessions = [];
  for (const p of people) sessions.push(await apiLogin(p.email));
  const [W, ...entrants] = sessions;
  const Database = require("better-sqlite3");
  const ro = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const stamped = () => ro.prepare("SELECT COUNT(*) n FROM competition_users WHERE competition_id=? AND login_time IS NOT NULL").get(compId).n;
    const builds = async () => {
      const r = await sa.get(`/api/test/leaderboard-builds?competitionId=${encodeURIComponent(compId)}`);
      expect(r.ok(), `builds: ${await r.text()}`).toBeTruthy();
      return (await r.json()).builds;
    };
    const select = async (who) => {
      const r = await who.api.post("/api/select-competition", { headers: H(who.csrf), data: { competitionId: compId } });
      expect(r.ok(), `select: ${await r.text()}`).toBeTruthy();
    };
    const board = async () => {
      const r = await W.api.get("/api/leaderboard");
      expect(r.ok(), `leaderboard: ${r.status()}`).toBeTruthy();
      return (await r.json()).board || [];
    };
    await select(W);
    expect(stamped(), "PRECONDITION: only the watcher has entered, so every select below is a FIRST entry").toBe(1);
    const b0 = await builds();
    await board();
    const warmAt = Date.now();
    const b1 = await builds();
    expect(b1 - b0, "the warm read built the board once").toBe(1);
    // The storm: each entrant's first entry, each followed by a board read.
    for (const E of entrants) { await select(E); await board(); }
    const span = Date.now() - warmAt;
    const rebuilds = (await builds()) - b1;
    expect(stamped(), "every entrant's select stamped their first entry").toBe(K + 1);
    const windows = Math.ceil(span / COALESCE_MS);
    expect(windows, `PRECONDITION: ${K} entries ran inside fewer than ${K} windows (${span} ms), so coalescing and a rebuild per entry differ`).toBeLessThan(K);
    expect(rebuilds, `${K} first entries over ${span} ms: at most one rebuild per ${COALESCE_MS} ms window, never one per entry`).toBeLessThanOrEqual(windows);
    // CONTROL: every entrant reaches the board EVENTUALLY. Only that: this poll
    // outlasts the board cache's own 5 s lifetime, so it passes even if an entry
    // never busted the board at all. Showing within the coalesce window is
    // tests/storm-hotpaths.api.spec.js's "entrant coalescing" lock.
    const nicks = new Set(people.slice(1).map(p => p.nick));
    await expect.poll(async () => (await board()).filter(r => nicks.has(r.nickname)).length,
      { timeout: COALESCE_MS + 5000, message: "every entrant reaches the board (eventually)" }).toBe(K);
    // CONTROL: a score change still rebuilds on the very next read.
    const before = await builds();
    const E = entrants[0];
    const sub = await E.api.post(`/api/tasks/${task1}/submit`, { headers: H(E.csrf), data: { answer: "a", gradingHash: await gradingHashFor(E.api, task1) } });
    expect(sub.ok(), `submit: ${await sub.text()}`).toBeTruthy();
    expect((await sub.json()).correct, "PRECONDITION: a correct answer").toBe(true);
    const row = (await board()).find(r => r.nickname === people[1].nick);
    expect(row && row.score, "the solve is on the next read").toBeGreaterThan(0);
    expect((await builds()) - before, "a score change rebuilt the board at once, exactly once").toBe(1);
  } finally {
    ro.close();
    for (const s of sessions) await s.api.dispose();
    await sa.dispose();
  }
});

test("the ranked-board memo: two reads of one cached board rank it once; a fresh build, a bust and a new presence basis rank anew", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-rankmemo-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-rankmemo-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const at = new Date(Date.now() - 60000).toISOString();
    db.prepare("INSERT INTO competitions (id, name, start_time, duration_minutes, leaderboard_mode, created_at) VALUES (?,?,?,?,?,?)")
      .run("c-memo", "Memo", at, 240, "global", at);
    const u = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, approved, verified, created_at) VALUES (?,?,?,?,?,1,1,?)");
    const cu = db.prepare("INSERT INTO competition_users (competition_id, user_id, login_time, assigned_at) VALUES (?,?,?,?)");
    for (let i = 0; i < 5; i++) { u.run("u-" + i, "U", String(i), "memo" + i, "memo" + i + "@corp.test", at); cu.run("c-memo", "u-" + i, at, at); }
    const L = R("lib/leaderboard.js");
    const { _invalidateCompetitionCache } = R("lib/competitions.js");
    const out = {};
    const c0 = L.leaderboardComputeCount("c-memo");
    const a = L.buildLeaderboard("c-memo", null);
    const b = L.buildLeaderboard("c-memo", null);
    out.rows = a.length;
    out.sameRanking = a === b;
    out.frozen = Object.isFrozen(a) && Object.isFrozen(a[0]);
    out.entriesComputedOnce = L.leaderboardComputeCount("c-memo") - c0;
    const f = L.buildLeaderboard("c-memo", null, { fresh: true });
    out.freshRanksAnew = f !== a && f.length === a.length;
    out.cachedStillMemoised = L.buildLeaderboard("c-memo", null) !== f;
    L.invalidateLeaderboardCache("c-memo");
    const c = L.buildLeaderboard("c-memo", null);
    out.bustRanksAnew = c !== a && c !== f;
    out.thenMemoised = L.buildLeaderboard("c-memo", null) === c;
    // The presence basis is read live, so it is part of the memo's key.
    db.prepare("UPDATE competitions SET measure_presence=1, time_basis='presence' WHERE id=?").run("c-memo");
    _invalidateCompetitionCache("c-memo");
    const p = L.buildLeaderboard("c-memo", null);
    out.presenceRanksAnew = p !== c;
    out.presenceThenMemoised = L.buildLeaderboard("c-memo", null) === p;
    process.stdout.write("\\nRANK_MEMO_OUT " + JSON.stringify(out) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("RANK_MEMO_OUT "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    const out = JSON.parse(line.slice("RANK_MEMO_OUT ".length));
    expect(out.rows, "anti-vacuity: a board of five").toBe(5);
    expect(out.entriesComputedOnce, "both reads share one cached entry set").toBe(1);
    expect(out).toEqual({
      rows: 5, sameRanking: true, frozen: true, entriesComputedOnce: 1,
      freshRanksAnew: true, cachedStillMemoised: true, bustRanksAnew: true, thenMemoised: true,
      presenceRanksAnew: true, presenceThenMemoised: true,
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});
