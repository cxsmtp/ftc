// @ts-check
//
// THE TWO POLLS LOG A SLOW READ.
//
// A participant's one regular poll is the pulse (GET /api/participant/pulse) and
// an organiser's Overview reads GET /api/admin/competitions/:id/overview-pulse
// every 15 s; both time themselves like /api/status and log a `[perf-span]` line
// with their breakdown when a request takes longer than PERF_SPAN_SLOW_MS, so a
// slow poll under load names where its time went.
//
// A request is made slow WITHOUT slowing the server: a GET carrying a JSON body
// the global parser waits for, held open for twice the threshold, puts the wait
// into the request's prelude (the technique of
// tests/log-capability-scrub.api.spec.js). CONTROL: the same request sent at once
// logs nothing, read once the slow one's line has landed (one writer, in order).

const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, BASE, TEST_DATA_DIR, findLogLine } = require("./helpers");
const { serverEnv } = require("./server-env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOGS = path.join(TEST_DATA_DIR, "logs");
const { hostname: HOST, port: PORT } = new URL(BASE);
const SLOW_MS = Number(serverEnv(0).PERF_SPAN_SLOW_MS);
const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

/** A GET with the session's cookies, its JSON body held for `holdMs` (0: at once). */
function rawGet(pathname, cookie, holdMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, method: "GET", path: pathname,
      headers: { cookie, "content-type": "application/json", "content-length": "2" },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, id: res.headers["x-request-id"], body: data }));
    });
    req.on("error", reject);
    req.on("socket", (sock) => {
      const hold = () => { req.flushHeaders(); setTimeout(() => req.end("{}"), holdMs); };
      if (sock.connecting) sock.once("connect", hold); else hold();
    });
  });
}

const cookieOf = async (api) => (await api.storageState()).cookies.map(c => `${c.name}=${c.value}`).join("; ");
const spanLines = () => fs.readdirSync(LOGS).filter(f => f.startsWith("app-") && f.endsWith(".jsonl"))
  .flatMap(f => fs.readFileSync(path.join(LOGS, f), "utf8").split("\n").filter(Boolean))
  .map(l => { try { return JSON.parse(l); } catch (_) { return {}; } })
  .filter(j => /^\[perf-span\]/.test(j.msg || ""));

let fx;
test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `PS ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
  }})).json()).competition.id;
  const email = `ps_${t}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Ps", lastName: "P", nickname: `ps${t}`, email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const u = ((await (await sa.get(`/api/admin/participants?limit=5000`)).json()).participants || []).find(p => p.email === email);
  expect(u, "the participant exists").toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [compId] } })).json();
  expect(asg.assigned, `assigned: ${JSON.stringify(asg)}`).toBe(1);
  fx = { sa, compId, email };
});
test.afterAll(async () => { if (fx) await fx.sa.dispose(); });

test("a slow participant pulse logs its breakdown; a fast one logs nothing", async () => {
  expect(SLOW_MS, "PRECONDITION: the threshold is pinned").toBeGreaterThan(0);
  const L = await apiLogin(fx.email);
  try {
    const sel = await L.api.post("/api/select-competition", { headers: H(L.csrf), data: { competitionId: fx.compId } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    const cookie = await cookieOf(L.api);
    const fast = await rawGet("/api/participant/pulse", cookie, 0);
    expect(fast.status, `the fast pulse answered: ${fast.body}`).toBe(200);
    const slow = await rawGet("/api/participant/pulse", cookie, 2 * SLOW_MS);
    expect(slow.status, `the slow pulse answered: ${slow.body}`).toBe(200);
    const span = await findLogLine(LOGS, (j) => j.msg === "[perf-span] slow /api/participant/pulse" && j.req_id === slow.id,
      { what: "the pulse's perf span for the held request" });
    expect(span.endpoint).toBe("/api/participant/pulse");
    expect(Number(span.prelude_ms), "the held body is what made it slow").toBeGreaterThan(SLOW_MS);
    for (const k of ["total_ms", "status_ms", "score_ms", "lb_version_ms", "respond_ms"]) {
      expect(Number.isFinite(Number(span[k])), `${k} is a measured figure: ${JSON.stringify(span)}`).toBe(true);
    }
    expect(spanLines().some(j => j.req_id === fast.id), "CONTROL: the fast pulse logged no span").toBe(false);
  } finally { await L.api.dispose(); }
});

test("a slow overview pulse logs its breakdown; a fast one logs nothing", async () => {
  const cookie = await cookieOf(fx.sa);
  const p = `/api/admin/competitions/${fx.compId}/overview-pulse`;
  const fast = await rawGet(p, cookie, 0);
  expect(fast.status, `the fast read answered: ${fast.body}`).toBe(200);
  const slow = await rawGet(p, cookie, 2 * SLOW_MS);
  expect(slow.status, `the slow read answered: ${slow.body}`).toBe(200);
  const span = await findLogLine(LOGS, (j) => j.msg === "[perf-span] slow /api/admin/competitions/:id/overview-pulse" && j.req_id === slow.id,
    { what: "the overview pulse's perf span for the held request" });
  expect(span.endpoint).toBe("/api/admin/competitions/:id/overview-pulse");
  expect(span.competition_id).toBe(fx.compId);
  expect(Number(span.prelude_ms), "the held body is what made it slow").toBeGreaterThan(SLOW_MS);
  for (const k of ["total_ms", "db_ms", "respond_ms"]) {
    expect(Number.isFinite(Number(span[k])), `${k} is a measured figure: ${JSON.stringify(span)}`).toBe(true);
  }
  expect(spanLines().some(j => j.req_id === fast.id), "CONTROL: the fast read logged no span").toBe(false);
});
