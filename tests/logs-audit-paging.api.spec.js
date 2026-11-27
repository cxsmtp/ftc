"use strict";

// RAW LOGS' AUDIT LOG PAGES LIKE THE AUDIT TRAIL (operator ruling, 17 Nov 2026,
// "Page like the trail"). GET /api/admin/logs on the `app` stream:
//   • only the first read is counted, up to the trail's cap (10 000, `count_cap`
//     past it); a later read (an anchor, a cursor or an offset) answers no count;
//   • Next is a cursor, a byte position below the page's last row, which tiles
//     the log across rotated files and never takes in lines appended meanwhile;
//   • a cursor the server did not issue is refused by name, and never reaches a
//     file outside the stream;
//   • a walk LOG_SCAN_BUDGET cuts says how far back it searched (`searched_to`),
//     and its cursor searches on (a server of its own, with a small budget).
// The Request log (`access`) keeps a count on every read and answers no cursor.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { apiLogin, TEST_DATA_DIR } = require("./helpers");
const { readySpawnedServer } = require("./spawned-server");

test.beforeEach(() => guardFixedPortSpec());

const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
const DAY_NEW = "2001-06-12", DAY_OLD = "2001-06-11";
const at = (day, i) => new Date(Date.parse(`${day}T00:00:00.000Z`) + i * 1000).toISOString();
const row = (day, i, msg) => JSON.stringify({ ts: at(day, i), level: "info", msg });
/** `n` rows, oldest first in the file (the walk reads newest first). */
function plant(file, n, fp, day, { from = 0 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  for (let i = from; i < from + n; i++) lines.push(row(day, i, `${fp}-${String(i).padStart(5, "0")}`));
  fs.appendFileSync(file, lines.join("\n") + "\n");
}
/** A cursor as the server writes it: `[file, position, inode]` (the inode of the named file when it exists). */
const cursorOf = (f, p, ino) => {
  let i = ino;
  if (i === undefined) { try { i = fs.statSync(path.join(LOG_DIR, f)).ino; } catch (_) { i = 1; } }
  return Buffer.from(JSON.stringify([f, p, i]), "utf8").toString("base64url");
};
let seq = 0;
const fpOf = (tag) => `${tag}${Date.now().toString(36)}${++seq}`;

test.describe("the Audit log pages like the audit trail", () => {
  test("its first read is counted; a later read is not; the Request log still counts every read", async () => {
    const fp = fpOf("ap");
    const app = path.join(LOG_DIR, `app-${DAY_NEW}.jsonl`), acc = path.join(LOG_DIR, `access-${DAY_NEW}.jsonl`);
    plant(app, 120, fp, DAY_NEW);
    plant(acc, 120, fp, DAY_NEW);
    const { api } = await apiLogin("superadmin");
    try {
      const get = async (q) => (await api.get(`/api/admin/logs?${q}`)).json();
      const p1 = await get(`stream=app&q=${fp}&limit=50`);
      expect(p1).toMatchObject({ total: 120, total_exact: true, total_pages: 3, has_more: true });
      expect(typeof p1.next_cursor).toBe("string");
      expect(p1.anchor_ts).toBe(at(DAY_NEW, 119));
      expect(p1.entries.map(e => e.msg)[0]).toBe(`${fp}-00119`);
      const anchored = await get(`stream=app&q=${fp}&limit=50&offset=50&anchor=${encodeURIComponent(p1.anchor_ts)}`);
      expect(anchored.total, "a later read answers no count").toBeNull();
      expect(anchored.total_pages).toBeNull();
      expect(anchored.entries.map(e => e.msg)).toEqual(Array.from({ length: 50 }, (_, k) => `${fp}-${String(69 - k).padStart(5, "0")}`));
      const byCursor = await get(`stream=app&q=${fp}&limit=50&cursor=${encodeURIComponent(p1.next_cursor)}`);
      expect(byCursor.total).toBeNull();
      expect(byCursor.entries.map(e => e.msg), "Next by cursor reads the same rows").toEqual(anchored.entries.map(e => e.msg));
      // CONTROL: the Request log keeps its count on every read, and no cursor.
      const req = await get(`stream=access&q=${fp}&limit=50&offset=50&anchor=${encodeURIComponent(p1.anchor_ts)}`);
      expect(req.total, "the Request log still counts").toBe(120);
      expect(req.next_cursor).toBeNull();
    } finally { await api.dispose(); for (const f of [app, acc]) fs.rmSync(f, { force: true }); }
  });

  test("the first read stops counting at the trail's cap and says so", async () => {
    const fpA = fpOf("capA"), fpB = fpOf("capB");
    const fNew = path.join(LOG_DIR, `app-${DAY_NEW}.jsonl`), fOld = path.join(LOG_DIR, `app-${DAY_OLD}.jsonl`);
    plant(fNew, 10050, fpA, DAY_NEW);
    plant(fOld, 30, fpB, DAY_OLD);
    const { api } = await apiLogin("superadmin");
    try {
      const get = async (q) => (await api.get(`/api/admin/logs?${q}`)).json();
      const a = await get(`stream=app&q=${fpA}&limit=50`);
      expect(a).toMatchObject({ total: 10000, total_exact: false, truncated_reason: "count_cap", has_more: true, total_pages: 200 });
      const all = await get(`stream=app&limit=50`);
      expect(all.truncated_reason, "the unfiltered first read is counted to the cap too").toBe("count_cap");
      expect(all.total).toBe(10000);
      // CONTROL: below the cap the count stays exact.
      const b = await get(`stream=app&q=${fpB}&limit=50`);
      expect(b).toMatchObject({ total: 30, total_exact: true, truncated_reason: null, has_more: false, next_cursor: null });
    } finally { await api.dispose(); for (const f of [fNew, fOld]) fs.rmSync(f, { force: true }); }
  });

  test("Next by cursor tiles the log across rotated files, and lines appended meanwhile never enter it", async () => {
    const fp = fpOf("tile");
    const fNew = path.join(LOG_DIR, `app-${DAY_NEW}.jsonl`), fOld = path.join(LOG_DIR, `app-${DAY_OLD}.jsonl`);
    plant(fNew, 70, fp, DAY_NEW);
    plant(fOld, 40, fp, DAY_OLD);
    const { api } = await apiLogin("superadmin");
    try {
      const get = async (q) => (await api.get(`/api/admin/logs?${q}`)).json();
      const got = [];
      let r = await get(`stream=app&q=${fp}&limit=50`);
      for (let guard = 0; guard < 10; guard++) {
        got.push(...r.entries.map(e => e.msg));
        // New lines arrive in the newest file while the reader pages on.
        plant(fNew, 5, fp, DAY_NEW, { from: 1000 + guard * 5 });
        if (!r.has_more) break;
        expect(typeof r.next_cursor, JSON.stringify({ has_more: r.has_more })).toBe("string");
        r = await get(`stream=app&q=${fp}&limit=50&cursor=${encodeURIComponent(r.next_cursor)}`);
      }
      const want = [
        ...Array.from({ length: 70 }, (_, k) => `${fp}-${String(69 - k).padStart(5, "0")}`),
        ...Array.from({ length: 40 }, (_, k) => `${fp}-${String(39 - k).padStart(5, "0")}`),
      ];
      expect(got, "every original row once, newest first, nothing appended").toEqual(want);
      // CONTROL: a fresh first read shows what arrived.
      const fresh = await get(`stream=app&q=${fp}&limit=5`);
      expect(fresh.entries[0].msg >= `${fp}-01000`, fresh.entries[0].msg).toBe(true);
    } finally { await api.dispose(); for (const f of [fNew, fOld]) fs.rmSync(f, { force: true }); }
  });

  test("a cursor the server did not issue is refused by name, and reaches no file outside the stream", async () => {
    const fp = fpOf("bad");
    const app = path.join(LOG_DIR, `app-${DAY_NEW}.jsonl`), acc = path.join(LOG_DIR, `access-${DAY_NEW}.jsonl`);
    plant(app, 60, fp, DAY_NEW);
    plant(acc, 5, fp, DAY_NEW);
    const { api } = await apiLogin("superadmin");
    try {
      const get = async (q) => { const r = await api.get(`/api/admin/logs?${q}`); return { status: r.status(), body: await r.json() }; };
      const size = fs.statSync(app).size;
      const appIno = fs.statSync(app).ino;
      const bad = [
        cursorOf("../x.jsonl", 0), cursorOf(`access-${DAY_NEW}.jsonl`, 0), cursorOf("app-1999-01-01.jsonl", 0),
        cursorOf(`app-${DAY_NEW}.jsonl`, size + 1), cursorOf(`app-${DAY_NEW}.jsonl`, -1), cursorOf(`app-${DAY_NEW}.jsonl`, 10, appIno + 7),
        Buffer.from(JSON.stringify([`app-${DAY_NEW}.jsonl`, 10]), "utf8").toString("base64url"),   // no inode
        "%%not-base64%%", "x".repeat(500),
      ];
      for (const c of bad) {
        const r = await get(`stream=app&q=${fp}&cursor=${encodeURIComponent(c)}`);
        expect([r.status, r.body.code], c).toEqual([400, "logs_cursor_invalid"]);
      }
      const p1 = (await get(`stream=app&q=${fp}&limit=50`)).body;
      const both = await get(`stream=app&q=${fp}&cursor=${encodeURIComponent(p1.next_cursor)}&anchor=${encodeURIComponent(p1.anchor_ts)}`);
      expect([both.status, both.body.code]).toEqual([400, "logs_position_conflict"]);
      // A sort with a cursor is answered by page: the rows below the cursor, in the
      // log's order, reordered within the page (never a global ranking).
      const sorted = await get(`stream=app&q=${fp}&limit=50&sort=msg&dir=asc&cursor=${encodeURIComponent(p1.next_cursor)}`);
      expect(sorted.status, JSON.stringify(sorted.body)).toBe(200);
      expect([sorted.body.sort_scope, sorted.body.sort_unavailable]).toEqual(["page", "cursor"]);
      expect(sorted.body.entries.map(e => e.msg).sort()).toEqual(Array.from({ length: 10 }, (_, k) => `${fp}-${String(k).padStart(5, "0")}`));
      // Unfiltered, a heading sort reorders the page in hand, and Next goes on by cursor.
      const top = (await get(`stream=app&limit=5`)).body;
      const below = await get(`stream=app&limit=5&sort=level&dir=asc&cursor=${encodeURIComponent(top.next_cursor)}`);
      expect(below.status, JSON.stringify(below.body)).toBe(200);
      expect(typeof below.body.next_cursor, "a page sorted in place still answers the next position").toBe("string");
      const onAccess = await get(`stream=access&q=${fp}&cursor=${encodeURIComponent(cursorOf(`access-${DAY_NEW}.jsonl`, 0))}`);
      expect([onAccess.status, onAccess.body.code], "the Request log takes no cursor").toEqual([400, "logs_cursor_invalid"]);
      // CONTROL: the cursor the server issued is honoured.
      const ok = await get(`stream=app&q=${fp}&limit=50&cursor=${encodeURIComponent(p1.next_cursor)}`);
      expect(ok.status).toBe(200);
      expect(ok.body.entries.map(e => e.msg)).toEqual(Array.from({ length: 10 }, (_, k) => `${fp}-${String(9 - k).padStart(5, "0")}`));
    } finally { await api.dispose(); for (const f of [app, acc]) fs.rmSync(f, { force: true }); }
  });

  test("Next by cursor tiles a log larger than a read chunk, row for row", async () => {
    // The reader goes back 64 KB at a time; a cursor's position must be the line's
    // own byte offset in the file whichever chunk it was read in.
    const fp = fpOf("big");
    const file = path.join(LOG_DIR, `app-${DAY_NEW}.jsonl`);
    const pad = "x".repeat(150);
    const lines = [];
    for (let i = 0; i < 3000; i++) lines.push(JSON.stringify({ ts: at(DAY_NEW, i), level: "info", msg: `${fp}-${String(i).padStart(5, "0")}`, pad }));
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(fs.statSync(file).size, "PRECONDITION: several read chunks").toBeGreaterThan(6 * 64 * 1024);
    const { api } = await apiLogin("superadmin");
    try {
      const get = async (q) => (await api.get(`/api/admin/logs?${q}`)).json();
      const got = [];
      let r = await get(`stream=app&q=${fp}&limit=500`);
      for (let n = 0; n < 10; n++) {
        got.push(...r.entries.map(e => e.msg));
        if (!r.has_more) break;
        r = await get(`stream=app&q=${fp}&limit=500&cursor=${encodeURIComponent(r.next_cursor)}`);
      }
      expect(got.length).toBe(3000);
      expect(got).toEqual(Array.from({ length: 3000 }, (_, k) => `${fp}-${String(2999 - k).padStart(5, "0")}`));
    } finally { await api.dispose(); fs.rmSync(file, { force: true }); }
  });

  test("a cursor follows its file through a size rotation's rename; a file that is gone refuses it", async () => {
    const fp = fpOf("rot");
    const live = path.join(LOG_DIR, `app-${DAY_NEW}.jsonl`), rotated = path.join(LOG_DIR, `app-${DAY_NEW}-23-59-59.jsonl`);
    plant(live, 60, fp, DAY_NEW);
    const { api } = await apiLogin("superadmin");
    try {
      const get = async (q) => { const r = await api.get(`/api/admin/logs?${q}`); return { status: r.status(), body: await r.json() }; };
      const p1 = (await get(`stream=app&q=${fp}&limit=20`)).body;
      // The log rotates: the file is renamed, and a new one under the old name
      // grows past the cursor's position.
      fs.renameSync(live, rotated);
      plant(live, 200, fp, DAY_NEW, { from: 5000 });
      const on = await get(`stream=app&q=${fp}&limit=20&cursor=${encodeURIComponent(p1.next_cursor)}`);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body.entries.map(e => e.msg), "the rows below page 1 in the file it was read in").toEqual(Array.from({ length: 20 }, (_, k) => `${fp}-${String(39 - k).padStart(5, "0")}`));
      // CONTROL: the file is gone (pruned): the cursor is refused, never read elsewhere.
      fs.rmSync(rotated, { force: true });
      const gone = await get(`stream=app&q=${fp}&limit=20&cursor=${encodeURIComponent(p1.next_cursor)}`);
      expect([gone.status, gone.body.code]).toEqual([400, "logs_cursor_invalid"]);
    } finally { await api.dispose(); for (const f of [live, rotated]) fs.rmSync(f, { force: true }); }
  });

  test("a walk the scan budget cuts says how far back it searched, and its cursor searches on", async () => {
    // LOG_SCAN_BUDGET is read at module scope, so this drives a server of its own.
    const { spawn } = require("child_process");
    const { PORT_BASE } = require("./helpers");
    const port = PORT_BASE + 114;
    const BASE = `http://localhost:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "logcut-"));
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    const fp = fpOf("cut");
    const file = path.join(dataDir, "logs", `app-${DAY_NEW}.jsonl`);
    // needle 0 (oldest), 1 500 filler rows, needle 1 (newest): more than the budget between them.
    const lines = [row(DAY_NEW, 0, `${fp}-needle-0`)];
    for (let i = 1; i <= 1500; i++) lines.push(row(DAY_NEW, i, `${fp}-fill-${i}`));
    lines.push(row(DAY_NEW, 1501, `${fp}-needle-1`));
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        LOG_DISABLE_ACCESS: "1",
        LOG_SCAN_BUDGET: "1000",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", b => { out += b.toString(); });
    child.stderr.on("data", b => { out += b.toString(); });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
      const q = encodeURIComponent(`${fp}-needle`);
      const first = (await go(`/api/admin/logs?stream=app&q=${q}&limit=50`)).json;
      expect(first.entries.map(e => e.msg)).toEqual([`${fp}-needle-1`]);
      expect(first).toMatchObject({ total: 1, total_exact: false, truncated_reason: "scan_budget", has_more: true });
      expect(typeof first.next_cursor).toBe("string");
      expect(first.searched_to > at(DAY_NEW, 0) && first.searched_to < at(DAY_NEW, 1501), `searched back to ${first.searched_to}`).toBe(true);
      const on = (await go(`/api/admin/logs?stream=app&q=${q}&limit=50&cursor=${encodeURIComponent(first.next_cursor)}`)).json;
      expect(on.entries.map(e => e.msg), "Next searches on past the cut").toEqual([`${fp}-needle-0`]);
      expect(on).toMatchObject({ has_more: false, searched_to: null, next_cursor: null });
      // CONTROL: a `since` bound inside the budget is a clean stop, not a cut.
      const since = encodeURIComponent(at(DAY_NEW, 1000));
      const bounded = (await go(`/api/admin/logs?stream=app&q=${q}&limit=50&since=${since}`)).json;
      expect(bounded).toMatchObject({ total: 1, total_exact: true, truncated_reason: "since_bound", searched_to: null });
    } finally {
      child.kill("SIGKILL");
      for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/healthz`); await sleep(100); } catch (_) { break; } }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
