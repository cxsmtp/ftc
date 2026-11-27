// EVERY SIGN-IN DOOR REFUSES PAST ITS LIMIT — held by behaviour, door by door.
//
// The sign-in doors answer 200 for every outcome (a non-429 4xx would feed the
// scanner block that shuts a whole venue NAT out), so their limiters are the
// only thing bounding how fast one source can guess codes and passwords or make
// the platform write records: the per-account lockout refuses no guess (it is an
// alarm; a correct code or password still signs in while locked). Each limiter is
// keyed by (source IP, normalised address), so a room behind one NAT does not
// share a bucket. Four of them (the code request, the code redeem, the method
// lookup, the password door) also carry a coarse per-source backstop, so the
// address key cannot spread guesses or code requests without limit; the untie,
// which guesses nothing, has none.
//
// For each door this spec drives the real requests and holds:
//   * the exact budget: every request up to it is answered by the door itself,
//     and the next one by the limiter (429, the limiter's own sentence — not the
//     scanner block's `address_blocked`);
//   * the window: a few seconds before it ends the door still refuses, and a few
//     seconds after it the same address is served again;
//   * the key: the same address in other letter case shares the count, while a
//     different address from the same source is still served;
//   * where there is one, the backstop: past it, an address never seen before is
//     refused.
// The code redeem's arm also shows what the limit protects: past it even the
// RIGHT code is refused and nothing is spent, until the minute is over.
//
// The test server runs with RATE_LIMIT_DISABLED; POST /api/test/rate-limit-toggle
// turns every limiter on for this server process and clears every bucket, before
// each test, and off again after it. A window is crossed with
// POST /api/test/rate-limit-age, which moves every bucket's start back. The
// sign-in rate and backstop are the ones this test server was given
// (tests/server-env.js), read rather than retyped.
const { test, expect } = require("./isolated-test");
const { freshCtx, TEST_DB_PATH } = require("./helpers");
const { serverEnv } = require("./server-env");

const ENV = serverEnv(0);
const LOGIN_PER_MIN = Number(ENV.RATE_LIMIT_LOGIN_PER_MIN);
const LOGIN_BACKSTOP_PER_MIN = Number(ENV.RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN);
// routes/auth.js: the code request and "Not your event?" allow five per address
// in fifteen minutes, the redeem ten a minute; the code request's backstop is the
// sign-in backstop's rate over its own fifteen-minute window.
const REQUEST_PER_15MIN = 5;
const DROP_PER_15MIN = 5;
const REDEEM_PER_MIN = 10;
const REQUEST_BACKSTOP_PER_15MIN = LOGIN_BACKSTOP_PER_MIN * 15;
const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_MINUTE = 60_000;
// How close to a window's end the "still refused" check stands, and how far past
// it the "served again" check: wide enough for one request's latency on a loaded
// runner, narrow enough that a window cut or stretched by more is seen.
const EDGE_MS = 5_000;

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const stamp = () => `${Date.now()}-${++seq}`;
const wrongFor = (code) => (String(code).replace(/-/g, "") === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ");

async function toggleLimits(enable) {
  const { api, csrf } = await freshCtx();
  try {
    const r = await api.post("/api/test/rate-limit-toggle", { headers: H(csrf), data: { enable } });
    expect(r.ok(), `rate-limit-toggle ${enable}: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).enabled).toBe(enable);
  } finally { await api.dispose(); }
}
async function expectLimited(r, what) {
  expect(r.status(), `${what}: refused by the limiter`).toBe(429);
  const body = await r.json();
  expect(body.error, `${what}: in the limiter's own words`).toMatch(/too many requests/i);
  expect(body.code, `${what}: the limiter, not the scanner block`).toBeUndefined();
}
/**
 * A door's bucket opens with its first request, so call this just before that
 * request. The returned `at(ms)` moves the server's buckets on until that bucket
 * stands `ms` into its window, counting the time the test has already taken and
 * the moves already made (every bucket moves together).
 */
function bucketClock(api, csrf) {
  const opened = Date.now();
  let moved = 0;
  return async (ms) => {
    const by = ms - (Date.now() - opened) - moved;
    expect(by, `PRECONDITION: the bucket is not yet ${ms} ms into its window`).toBeGreaterThan(0);
    const r = await api.post("/api/test/rate-limit-age", { headers: H(csrf), data: { ms: by } });
    expect(r.ok(), await r.text()).toBeTruthy();
    moved += by;
  };
}
/** Just before the window ends the door still refuses; just after, it serves again. Returns that answer. */
async function expectWindow(at, windowMs, send, what) {
  await at(windowMs - EDGE_MS);
  await expectLimited(await send(), `${what}, ${EDGE_MS / 1000} s before its window ends`);
  await at(windowMs + EDGE_MS);
  const r = await send();
  expect(r.status(), `${what}, once its window is over, is served again`).toBe(200);
  return r;
}
/** Send `n` requests built by `make(i)` (i from 0), `width` at a time; the statuses in order. */
async function sendAll(n, make, width) {
  const statuses = [];
  for (let i = 0; i < n; i += width) {
    const batch = [];
    for (let j = i; j < Math.min(n, i + width); j++) batch.push(make(j));
    for (const r of await Promise.all(batch)) statuses.push(r.status());
  }
  return statuses;
}

test.describe("every sign-in door refuses past its limit", () => {
  test.beforeEach(async () => { await toggleLimits(true); });
  test.afterEach(async () => { await toggleLimits(false); });

  test("the code request: five per address in fifteen minutes, then 429, whatever the letter case; another address is served", async () => {
    expect(Number.isInteger(LOGIN_BACKSTOP_PER_MIN) && LOGIN_BACKSTOP_PER_MIN > 0, "PRECONDITION: the test server's backstop is read").toBe(true);
    const { api, csrf } = await freshCtx();
    const s = stamp();
    // Personal addresses: the door refuses them in the handler, on the record, and
    // mails nothing — so the record counts the requests the handler answered.
    const a = `door-request-${s}@gmail.com`;
    const b = `door-request-other-${s}@gmail.com`;
    const ask = (email) => api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    const handled = () => sql(db => db.prepare(
      "SELECT COUNT(*) n FROM orphan_events WHERE event_type='email_proof_refused' AND json_extract(details,'$.reason')='free_email'").get().n);
    const before = handled();
    const at = bucketClock(api, csrf);
    for (let i = 1; i <= REQUEST_PER_15MIN; i++) {
      const r = await ask(a);
      expect(r.status(), `request ${i}`).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    expect(handled() - before, "PRECONDITION: every one of them reached the door").toBe(REQUEST_PER_15MIN);
    await expectLimited(await ask(a), "the sixth request for the address");
    await expectLimited(await ask(a.toUpperCase()), "the same address in capitals");
    expect(handled() - before, "neither reached the door").toBe(REQUEST_PER_15MIN);
    const other = await ask(b);
    expect(other.status(), "another address from the same source is served").toBe(200);
    expect(handled() - before).toBe(REQUEST_PER_15MIN + 1);
    const again = await expectWindow(at, FIFTEEN_MINUTES, () => ask(a), "the address");
    expect(await again.json()).toEqual({ ok: true });
    expect(handled() - before, "only the request after the window reached the door").toBe(REQUEST_PER_15MIN + 2);
    await api.dispose();
  });

  test("the code request's backstop: past fifteen minutes of the sign-in backstop from one source, a new address is refused", async () => {
    test.setTimeout(120_000);
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const statuses = await sendAll(REQUEST_BACKSTOP_PER_15MIN,
      (i) => api.post("/api/auth/code/request", { headers: H(csrf), data: { email: `door-backstop-${s}-${i}@gmail.com` } }), 40);
    expect(statuses.filter(x => x !== 200), `every one of the ${REQUEST_BACKSTOP_PER_15MIN} distinct addresses is served`).toEqual([]);
    await expectLimited(await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: `door-backstop-${s}-new@gmail.com` } }),
      "an address never seen, past the backstop");
    await api.dispose();
  });

  test("the code redeem: ten tries per address a minute, then 429 even for the right code; nothing is spent, and a minute on it works", async () => {
    expect(Number.isInteger(LOGIN_BACKSTOP_PER_MIN) && REDEEM_PER_MIN + 4 <= LOGIN_BACKSTOP_PER_MIN,
      `PRECONDITION: the ${REDEEM_PER_MIN + 4} redeems sent before the window is crossed sit under the backstop (${LOGIN_BACKSTOP_PER_MIN})`).toBe(true);
    const { api, csrf } = await freshCtx();
    const s = stamp();
    // An address no account holds is mailed an ADDRESS PROOF: a live code to guess at.
    const email = `door-redeem-${s}@door-limits.example`;
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    const rq = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(await rq.json()).toEqual({ ok: true });
    const c = await (await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email))).json();
    expect(c.via, "PRECONDITION: a proof was mailed").toBe("proof");
    const proof = () => sql(db => db.prepare("SELECT code_hash, attempts FROM email_proofs WHERE email_norm=?").get(email));
    const redeem = (em, code) => api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email: em, code } });

    // Ten tries: nine wrong guesses and one typo (a typo spends none of the
    // proof's own ten-guess budget, so the code is not burned on the way).
    const at = bucketClock(api, csrf);
    for (let i = 1; i < REDEEM_PER_MIN; i++) {
      const r = await redeem(email, wrongFor(c.code));
      expect(r.status(), `guess ${i}`).toBe(200);
      expect(await r.json()).toEqual({ ok: false });
    }
    const typo = await redeem(email, "x");
    expect(typo.status(), "the tenth try").toBe(200);
    expect(await typo.json()).toEqual({ ok: false });
    const held = proof();
    expect(held.attempts, "PRECONDITION: nine guesses were charged").toBe(REDEEM_PER_MIN - 1);
    expect(held.code_hash, "PRECONDITION: the code is still live").not.toBe("");

    await expectLimited(await redeem(email, c.code), "the eleventh try, with the RIGHT code");
    await expectLimited(await redeem(email.toUpperCase(), c.code), "the same address in capitals");
    expect(proof(), "the refused tries spent nothing: the proof is unconsumed and uncharged").toEqual(held);
    const other = await redeem(`door-redeem-other-${s}@door-limits.example`, "ZZZZZZZZ");
    expect(other.status(), "another address from the same source is served").toBe(200);
    expect(await other.json()).toEqual({ ok: false });

    // Until the minute is over even the right code is refused; then it redeems.
    await at(ONE_MINUTE - EDGE_MS);
    await expectLimited(await redeem(email, c.code), `the right code, ${EDGE_MS / 1000} s before the minute is out`);
    expect(proof(), "…and still nothing is spent").toEqual(held);
    await at(ONE_MINUTE + EDGE_MS);
    const after = await redeem(email, c.code);
    expect(after.status()).toBe(200);
    expect(await after.json(), "once the window is over the code works").toMatchObject({ ok: true, needsProfile: true, email });
    await api.dispose();
  });

  test("the code redeem's backstop: past the sign-in backstop a minute from one source, a new address is refused even with its right code, until the minute is over", async () => {
    test.setTimeout(120_000);
    const { api, csrf } = await freshCtx();
    const s = stamp();
    // A live code to hold back, at an address no redeem has named yet: an address
    // no account holds is mailed an ADDRESS PROOF.
    const target = `door-redeem-bk-target-${s}@door-limits.example`;
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    expect(await (await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: target } })).json()).toEqual({ ok: true });
    const c = await (await api.get("/api/test/last-login-code?email=" + encodeURIComponent(target))).json();
    expect(c.via, "PRECONDITION: a proof was mailed").toBe("proof");
    const proof = () => sql(db => db.prepare("SELECT code_hash, attempts FROM email_proofs WHERE email_norm=?").get(target));
    const held = proof();
    const redeem = (email, code) => api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });

    const at = bucketClock(api, csrf);
    const statuses = await sendAll(LOGIN_BACKSTOP_PER_MIN,
      (i) => redeem(`door-redeem-bk-${s}-${i}@door-limits.example`, "ZZZZZZZZ"), 10);
    expect(statuses.filter(x => x !== 200), `every one of the ${LOGIN_BACKSTOP_PER_MIN} distinct addresses is answered by the door`).toEqual([]);
    await expectLimited(await redeem(`door-redeem-bk-${s}-new@door-limits.example`, "ZZZZZZZZ"), "an address never seen, past the backstop");
    await expectLimited(await redeem(target, c.code), "the RIGHT code for an address not yet tried, past the backstop");
    expect(proof(), "the refused redeem spent nothing: the proof is unconsumed and uncharged").toEqual(held);
    const after = await expectWindow(at, ONE_MINUTE, () => redeem(target, c.code), "the right code");
    expect(await after.json(), "once the minute is over the code works").toMatchObject({ ok: true, needsProfile: true, email: target });
    await api.dispose();
  });

  test("'Not your event? Continue without it': five per address in fifteen minutes, then 429; another address is served", async () => {
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const a = `door-drop-${s}@door-limits.example`;
    const drop = (email) => api.post("/api/auth/code/drop-event", { headers: H(csrf), data: { email } });
    const at = bucketClock(api, csrf);
    for (let i = 1; i <= DROP_PER_15MIN; i++) {
      const r = await drop(a);
      expect(r.status(), `drop ${i}`).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    await expectLimited(await drop(a), "the sixth for the address");
    await expectLimited(await drop(a.toUpperCase()), "the same address in capitals");
    const other = await drop(`door-drop-other-${s}@door-limits.example`);
    expect(other.status(), "another address from the same source is served").toBe(200);
    expect(await other.json()).toEqual({ ok: true });
    const again = await expectWindow(at, FIFTEEN_MINUTES, () => drop(a), "the address");
    expect(await again.json()).toEqual({ ok: true });
    await api.dispose();
  });

  // The per-address arms below send four requests on top of the rate before the
  // window is crossed, all counted by the per-source backstop: they must stay under it.
  const underBackstop = () => expect(Number.isInteger(LOGIN_PER_MIN) && LOGIN_PER_MIN > 0 && LOGIN_PER_MIN + 4 <= LOGIN_BACKSTOP_PER_MIN,
    `PRECONDITION: the per-address rate (${LOGIN_PER_MIN}) plus four sits under the backstop (${LOGIN_BACKSTOP_PER_MIN})`).toBe(true);

  test("the sign-in-method lookup: the sign-in rate per address a minute, then 429; another address is served", async () => {
    underBackstop();
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const a = `door-method-${s}@door-limits.example`;
    const look = (email) => api.post("/api/auth/sign-in-method", { headers: H(csrf), data: { email } });
    const at = bucketClock(api, csrf);
    const statuses = await sendAll(LOGIN_PER_MIN, () => look(a), 10);
    expect(statuses.filter(x => x !== 200), `all ${LOGIN_PER_MIN} lookups are answered by the door`).toEqual([]);
    await expectLimited(await look(a), "the next lookup for the address");
    await expectLimited(await look(a.toUpperCase()), "the same address in capitals");
    const other = await look(`door-method-other-${s}@door-limits.example`);
    expect(other.status(), "another address from the same source is served").toBe(200);
    expect(await other.json()).toEqual({ ok: true, method: "code" });
    const again = await expectWindow(at, ONE_MINUTE, () => look(a), "the address");
    expect(await again.json()).toEqual({ ok: true, method: "code" });
    await api.dispose();
  });

  test("the sign-in-method lookup's backstop: past the sign-in backstop a minute from one source, a new address is refused", async () => {
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const statuses = await sendAll(LOGIN_BACKSTOP_PER_MIN,
      (i) => api.post("/api/auth/sign-in-method", { headers: H(csrf), data: { email: `door-method-bk-${s}-${i}@door-limits.example` } }), 10);
    expect(statuses.filter(x => x !== 200), `every one of the ${LOGIN_BACKSTOP_PER_MIN} distinct addresses is served`).toEqual([]);
    await expectLimited(await api.post("/api/auth/sign-in-method", { headers: H(csrf), data: { email: `door-method-bk-${s}-new@door-limits.example` } }),
      "an address never seen, past the backstop");
    await api.dispose();
  });

  test("the password door: the sign-in rate per address a minute, then 429; another address is served", async () => {
    underBackstop();
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const a = `door-password-${s}@door-limits.example`;
    const tryPassword = (email) => api.post("/api/auth/password", { headers: H(csrf), data: { email, password: "not-the-password-1" } });
    const at = bucketClock(api, csrf);
    const statuses = await sendAll(LOGIN_PER_MIN, () => tryPassword(a), 10);
    expect(statuses.filter(x => x !== 200), `all ${LOGIN_PER_MIN} attempts are answered by the door`).toEqual([]);
    await expectLimited(await tryPassword(a), "the next attempt for the address");
    await expectLimited(await tryPassword(a.toUpperCase()), "the same address in capitals");
    const other = await tryPassword(`door-password-other-${s}@door-limits.example`);
    expect(other.status(), "another address from the same source is served").toBe(200);
    expect(await other.json()).toEqual({ ok: false });
    const again = await expectWindow(at, ONE_MINUTE, () => tryPassword(a), "the address");
    expect(await again.json()).toEqual({ ok: false });
    await api.dispose();
  });

  test("the password door's backstop: past the sign-in backstop a minute from one source, a new address is refused", async () => {
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const statuses = await sendAll(LOGIN_BACKSTOP_PER_MIN,
      (i) => api.post("/api/auth/password", { headers: H(csrf), data: { email: `door-password-bk-${s}-${i}@door-limits.example`, password: "not-the-password-1" } }), 10);
    expect(statuses.filter(x => x !== 200), `every one of the ${LOGIN_BACKSTOP_PER_MIN} distinct addresses is served`).toEqual([]);
    await expectLimited(await api.post("/api/auth/password", { headers: H(csrf), data: { email: `door-password-bk-${s}-new@door-limits.example`, password: "not-the-password-1" } }),
      "an address never seen, past the backstop");
    await api.dispose();
  });

  // Sweep #193: with the limiters on, a non-text address reaches the bucket key
  // before the door. The code request's key once handed the raw value to a
  // template literal, so an object whose toString is not callable answered 500.
  // Its key now reads the address as text only, like every other door's, and a
  // non-text address shares the source's one keyless bucket.
  test("a non-text address or code with the limiters on: each door answers it, and non-text addresses share one bucket per source (sweep #193)", async () => {
    const { api, csrf } = await freshCtx();
    const s = stamp();
    const BAD = { toString: 1 };
    const ask = (email) => api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    for (let i = 1; i <= REQUEST_PER_15MIN; i++) {
      const r = await ask(i % 2 ? BAD : ["x@door-limits.example"]);
      expect(r.status(), `non-text address ${i} is answered by the door`).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    await expectLimited(await ask(BAD), "the sixth non-text address from the source");
    const real = await ask(`door-malformed-${s}@gmail.com`);
    expect(real.status(), "a real address from the same source keeps its own bucket").toBe(200);
    expect(await real.json()).toEqual({ ok: true });
    const answered = async (p, data, what) => {
      const r = await api.post(p, { headers: H(csrf), data });
      expect(r.status(), what).toBe(200);
      return r.json();
    };
    expect(await answered("/api/auth/code/redeem", { email: BAD, code: "ZZZZZZZZ" }, "redeem, non-text address")).toEqual({ ok: false });
    expect(await answered("/api/auth/code/redeem", { email: `door-malformed-${s}@door-limits.example`, code: BAD }, "redeem, non-text code")).toEqual({ ok: false });
    expect(await answered("/api/auth/code/drop-event", { email: BAD }, "not your event, non-text address")).toEqual({ ok: true });
    await answered("/api/auth/sign-in-method", { email: BAD }, "sign-in method, non-text address");
    expect(await answered("/api/auth/password", { email: BAD, password: BAD }, "password door, non-text fields")).toEqual({ ok: false });
    await api.dispose();
  });
});
