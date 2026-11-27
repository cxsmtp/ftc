// @ts-check
//
// ONE SOURCE CANNOT MAKE THE PLATFORM WRITE AN UNBOUNDED STREAM OF REFUSALS
// (sweep finding #18).
//
// The anonymous code request answers `{ok:true}` for every address, so a caller
// chooses what it writes. A personal (free-mail) or reserved address gets no
// proof, only an `email_proof_refused` audit row (kept two years) and a log
// line: one per request, from one IP, with nothing to stop it. Two bounds now:
//   • the record of a refusal is capped per source at the proof budget's own
//     rate (routes/auth.js `_sendEmailProof`); past it the refusal is counted by
//     reason (`hack_arena_email_proof_refusals_unrecorded_total`), not written,
//     and the answer is the same;
//   • the request door itself has the per-IP backstop the other anonymous
//     sign-in doors have (source arm: a behavioural one would need 1 200
//     requests at the test servers' backstop).
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, TEST_DB_PATH, BASE } = require("./helpers");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** The per-IP proof budget the test servers run with (tests/server-env.js), never a guess. */
function proofBudget() {
  const src = fs.readFileSync(path.join(__dirname, "server-env.js"), "utf8");
  const m = /RATE_LIMIT_PROOF_IP_PER_15MIN:\s*"(\d+)"/.exec(src);
  expect(m, "the test servers pin the proof budget").toBeTruthy();
  return Number(m[1]);
}
function recordedSince(iso) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT details FROM orphan_events WHERE event_type='email_proof_refused' AND changed_at >= ?").all(iso)
      .map(r => JSON.parse(r.details || "{}")).filter(d => d.reason === "free_email").length;
  } finally { db.close(); }
}
async function unrecorded(sa) {
  await new Promise(r => setTimeout(r, 1100));   // /metrics is memoised for 1 s
  const body = await (await sa.get("/metrics")).text();
  const m = /hack_arena_email_proof_refusals_unrecorded_total\{reason="free_email"\} (\d+)/.exec(body);
  return m ? Number(m[1]) : 0;
}

test("past the source's budget a refusal is counted, not recorded, and every answer stays the same", async () => {
  test.setTimeout(90_000);
  const budget = proofBudget();
  const n = budget + 6;
  const sa = await apiLogin("superadmin");
  const { api, csrf } = await freshCtx();
  // A clean window for this source's buckets.
  const resetBuckets = async () => {
    await api.post("/api/test/rate-limit-age", { headers: H(csrf), data: { ms: 16 * 60_000 } });
    await api.post("/api/test/rate-limit-sweep", { headers: H(csrf) });
  };
  try {
    await resetBuckets();
    const before = await unrecorded(sa.api);
    const since = new Date().toISOString();
    expect((await api.post("/api/test/rate-limit-toggle", { headers: H(csrf), data: { enable: true } })).ok()).toBeTruthy();
    const stamp = Date.now().toString(36);
    for (let i = 0; i < n; i++) {
      const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: `walkup-${stamp}-${i}@gmail.com` } });
      expect(r.status(), `request ${i}`).toBe(200);
      expect(await r.json(), `request ${i}: the same answer`).toEqual({ ok: true });
    }
    const recorded = recordedSince(since);
    expect(recorded, "the source's refusals are recorded up to its budget").toBe(budget);
    expect((await unrecorded(sa.api)) - before, "and the rest are counted, by reason").toBe(n - budget);
  } finally {
    await api.post("/api/test/rate-limit-toggle", { headers: H(csrf), data: { enable: false } });
    await resetBuckets();
    await api.dispose(); await sa.api.dispose();
  }
  // CONTROL: with the limiters off (as every other spec runs), every refusal is
  // recorded: the cap above is the budget's, not a lost write.
  const { api: api2, csrf: c2 } = await freshCtx();
  try {
    const since2 = new Date().toISOString();
    const stamp2 = Date.now().toString(36);
    for (let i = 0; i < 3; i++) {
      expect((await api2.post("/api/auth/code/request", { headers: H(c2), data: { email: `walkup2-${stamp2}-${i}@gmail.com` } })).status()).toBe(200);
    }
    expect(recordedSince(since2)).toBe(3);
  } finally { await api2.dispose(); }
});

test("the code request door has a per-IP backstop, as the other anonymous sign-in doors do", () => {
  const { stripJsComments } = require("./doc-registry");
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "auth.js"), "utf8"));
  const reg = (route) => {
    const at = src.indexOf(`app.post("${route}"`);
    expect(at, `anti-vacuity: ${route} is registered`).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("\n", at));
  };
  // The backstop is the other doors' per-minute rate over this door's 15-minute window.
  expect(reg("/api/auth/code/request")).toMatch(/rateLimit\(15 \* 60_000, 5, "login-code-req", \{[^}]*ipBackstopMax: _LOGIN_IP_BACKSTOP_PER_MIN \* 15 \}/);
  // CONTROL: the doors it is held to.
  for (const r of ["/api/auth/password", "/api/auth/sign-in-method", "/api/auth/code/redeem"]) expect(reg(r), r).toMatch(/ipBackstopMax:/);
});
