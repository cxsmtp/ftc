"use strict";

// v8.7.6 — A REFUSED SIGN-IN-CODE REQUEST LEAVES A TRACE, AND THE BACK-FILL THAT
// SHUT THE DOOR IS REPAIRED.
//
// Reported: "emailing a code for passwordless login doesn't work at all
// system-wide (emails don't arrive), and the log doesn't show an event of
// sending — or of refusing to send — that email."
//
// Both halves reproduced against a real server before anything changed:
//
//   1. `POST /api/auth/code/request` for an account holding a password minted
//      nothing, sent nothing and RECORDED NOTHING. The only signal was a
//      process-wide `/metrics` counter that names no account, so an operator
//      could not tell an ineligible account from a throttle from a typo — and
//      the commonest reason then was `already_has_password`, a refusal since
//      retired: every account row may ask for a code (lib/login-code.js
//      `isCodeEligible`), a password never closes that door.
//
//   2. WHY the population was ineligible: the v6.20.x back-fill stamped
//      `password_set_at = created_at` on EVERY pre-existing row, including the
//      accounts that never had a password. Measured against a populated
//      pre-migration database: a passwordless account goes NULL -> created_at
//      and is refused a code for ever. v7.29.0 later gave that column a second
//      job (the code door's discriminator), so a stamp written for a reason
//      about email copy silently closed a credential door.
//
// EVERY assertion here is paired with a control, because each has a build that
// satisfies it trivially:
//   • "a refusal is recorded"     <- an ELIGIBLE request must still be recorded
//     as a SEND, or a build that logs `login_code_refused` for everything passes.
//   • "the response is unchanged" <- the refusal and the success must be
//     byte-identical, or the trace has become an enumeration oracle.
//   • "the repair clears the stamp" <- a LinkedIn account that set a real
//     password LATER must keep it, or a build that clears the column for every
//     LinkedIn row passes — and that one would take a real password away.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, TEST_DB_PATH, BASE, PORT_BASE } = require("./helpers");
const { makeParticipant } = require("./event-admin-helpers");
const { adminLogin } = require("./ui-admin-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

test.use({ baseURL: BASE });

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

/** The audit rows this account has, newest first. */
function eventsFor(email, type) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    const u = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email);
    if (!u) return [];
    return db.prepare(
      "SELECT event_type, details FROM user_events WHERE user_id=? AND event_type=? ORDER BY changed_at DESC"
    ).all(u.id, type).map(r => ({ ...r, details: JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}

/** A verified, approved participant. `pw` false leaves it PASSWORDLESS. */
async function makeUser(api, csrf, tag, { pw = true } = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const email = `${tag}-${stamp}@company.co`;
  const reg = await registerPost(api, "/api/register", {
    headers: h(csrf),
    data: {
      firstName: "Code", lastName: "Trace", nickname: `${tag}_${stamp}`.slice(0, 20),
      company: "C", title: "T", country: "US", timezone: "America/New_York",
      email, password: "chosen-at-signup-1",
    },
  });
  expect(reg.ok(), `register ${tag}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    db.prepare(
      `UPDATE users SET approved=1, verified=1, password_set_at=${pw ? "created_at" : "NULL"},
         login_code_hash=NULL, login_code_at=NULL, login_code_sends=0 WHERE email=?`
    ).run(email);
  } finally { db.close(); }
  return email;
}

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.7.6 — a refused sign-in-code request is auditable", () => {


  test("CONTROL: an ELIGIBLE account is not refused — it is sent one", async () => {
    // Without this, "a refusal is recorded" is satisfied by a build that records
    // `login_code_refused` for every request, including the ones it honours.
    const { api, csrf } = await freshCtx();
    const email = await makeUser(api, csrf, "trace-nopw", { pw: false });
    // The registration itself mailed a code (a request of its own); count from here.
    const requestedBefore = eventsFor(email, "login_code_requested").length;
    await api.post("/api/test/reset-recent-code-sends", { headers: h(csrf) });

    const r = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
    expect(r.status()).toBe(200);
    expect(await r.json(), "byte-identical to the refusal above — no oracle").toEqual({ ok: true });

    expect(eventsFor(email, "login_code_refused").length, "an eligible account is NOT refused").toBe(0);
    expect(eventsFor(email, "login_code_requested").length, "it is recorded as a request").toBe(requestedBefore + 1);

    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const row = db.prepare("SELECT login_code_hash FROM users WHERE email=?").get(email);
      expect(row.login_code_hash, "and a code really was minted").toBeTruthy();
    } finally { db.close(); }
  });

  test("spending the send cap is recorded as its OWN reason, not as ineligible", async () => {
    // The other silent branch: the account IS eligible and the code it already
    // holds is still good, but the copy says "one is on its way" and nothing new
    // arrives. An operator must be able to tell the two apart.
    const { api, csrf } = await freshCtx();
    const email = await makeUser(api, csrf, "trace-cap", { pw: false });

    // Five asks against a three-send cap: two refusals past it, so the
    // assertion below covers more than the newest one.
    for (let i = 0; i < 5; i++) {
      // v8.8.25 — RE-POINTED, not weakened. This test's subject is the ACCOUNT
      // cap and the reason it records, and that has not moved. What moved is the
      // premise: within the account's three sends, one ORIGIN may now spend at
      // most two, and every request here comes from the same one — so without
      // this the loop reaches `origin_cap_reached` after two and the account cap
      // is never touched, which would make the assertion below about a different
      // budget while still passing for the wrong reason. Clearing the
      // process-resident sub-budget between asks puts the ACCOUNT cap back in
      // front, which is what this test has always been about.
      await api.post("/api/test/reset-origin-code-budget", { headers: h(csrf) });
      // Likewise the two-minute re-send suppression (a code under two minutes
      // old is never replaced), or every ask after the first is `recently_sent`.
      await api.post("/api/test/reset-recent-code-sends", { headers: h(csrf) });
      const r = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
      expect(r.status(), `request ${i}`).toBe(200);
    }

    const refusals = eventsFor(email, "login_code_refused");
    expect(refusals.length, "the 4th and 5th requests are past the 3-send cap").toBe(2);
    expect(refusals[0].details.reason).toBe("send_cap_reached");
    expect(refusals[0].details.sends, "and says how many had been spent").toBeGreaterThanOrEqual(3);
    // Every one is reported as the cap, never as another reason: that would send
    // an operator hunting for a problem that does not exist. (The requests under
    // the cap are recorded as sends: the CONTROL test above.)
    expect(refusals.map(x => x.details.reason), "every refusal past the cap names the cap")
      .toEqual(refusals.map(() => "send_cap_reached"));
  });

  // (An unknown WORK address gets an address proof, and a personal or reserved
  // one an `email_proof_refused` record, capped per source:
  // tests/proof-refusal-record-cap.api.spec.js. What is held here is narrower.)
  test("an unknown address records no sign-in refusal, and its address goes into no account's history", async () => {
    const { api, csrf } = await freshCtx();
    const email = `nobody-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
    const Database = require("better-sqlite3");
    const read = (fn) => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return fn(db); } finally { db.close(); }
    };
    const since = read(db => db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') AS t").get().t);
    const r = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email } });
    expect(r.status()).toBe(200);
    expect(await r.json(), "same body again").toEqual({ ok: true });

    read(db => {
      const n = db.prepare(
        "SELECT COUNT(*) AS n FROM user_events WHERE event_type='login_code_refused' AND details LIKE ?"
      ).get(`%${email}%`).n;
      expect(n, "there is no account to diagnose, so no account's history carries a refusal").toBe(0);
      const any = db.prepare("SELECT COUNT(*) AS n FROM user_events WHERE details LIKE ?").get(`%${email}%`).n;
      expect(any, "nor any other row naming the address, of any type").toBe(0);
    });

    // THE ADDRESS IS RECORDED ONLY AS ITS DOMAIN AND A FINGERPRINT. An anonymous
    // caller chooses it, so the proof's own audit row and its mail-log row must
    // not write it into the 730-day audit store. Both rows are waited for first
    // (the mail is a detached send), and the requested row's domain is this
    // request's: the rows are really there, so the absence below is not vacuous.
    // THIS request's rows, by its own fingerprint (lib/audit.js
    // capabilityFingerprint of the address, the `ep_` prefix): another test's
    // proof for a company.co address inside the one-second slack cannot answer.
    const fp = "ep_" + require("crypto").createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
    await expect.poll(() => read(db => db.prepare(
      "SELECT details FROM orphan_events WHERE event_type='email_proof_requested' AND scope_id=? AND changed_at >= ?"
    ).all(fp, since)).filter(x => JSON.parse(x.details || "{}").domain === "company.co").length, {
      message: "the proof request is recorded, by its domain and fingerprint", timeout: 15000,
    }).toBe(1);
    await expect.poll(() => read(db => db.prepare(
      "SELECT details FROM orphan_events WHERE event_type='email_sent' AND scope_id='email_proof' AND changed_at >= ?"
    ).all(since).map(x => JSON.parse(x.details || "{}"))
      .filter(d => d.to_domain === "company.co" && d.to_fp === fp).length), {
      message: "the proof mail's send is recorded, under the same fingerprint", timeout: 15000,
    }).toBeGreaterThan(0);

    read(db => {
      const leaks = db.prepare(
        "SELECT event_type, scope_id FROM orphan_events WHERE changed_at >= ? AND (details LIKE ? OR scope_id LIKE ?)"
      ).all(since, `%${email}%`, `%${email}%`);
      expect(leaks, "no audit or mail-log row names the address itself").toEqual([]);
    });
  });
});

// THE HISTORY DIALOG IS WHERE AN OPERATOR READS A REFUSAL, so its reason reaches
// them in words. `recently_sent` (a live code mailed under two minutes ago, or a
// desk code still in use, left for its holder to type) is what a second press of
// Continue records; without its own words the row showed the raw key.
test.describe("the History dialog says why a sign-in code was not sent", () => {
  test("a recently-sent refusal reads in words, never as its raw reason key", async ({ page }) => {
    test.setTimeout(90_000);
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    let p;
    try { p = await makeParticipant(sa, saCsrf, "histrs"); } finally { await sa.dispose(); }
    const { api, csrf } = await freshCtx();
    try {
      await api.post("/api/test/reset-recent-code-sends", { headers: h(csrf) });
      // The first request mails a code; the second, inside two minutes, is
      // refused so the code being typed is not killed.
      for (let i = 0; i < 2; i++) {
        const r = await api.post("/api/auth/code/request", { headers: h(csrf), data: { email: p.email } });
        expect(r.status(), `request ${i}`).toBe(200);
      }
    } finally { await api.dispose(); }
    expect(eventsFor(p.email, "login_code_refused").map(e => e.details.reason),
      "PRECONDITION: the second request was refused as recently sent").toEqual(["recently_sent"]);
    const honoured = eventsFor(p.email, "login_code_requested").length;
    expect(honoured, "PRECONDITION: the first request was honoured").toBeGreaterThanOrEqual(1);

    await adminLogin(page);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await page.evaluate((id) => window.showUserHistory(id), p.id);
    const dlg = page.locator("#hist-overlay");
    await expect(dlg).toBeVisible({ timeout: 15000 });
    const rowsOf = (type) => dlg.locator("#hist-body tr").filter({ has: page.locator(".history-type-badge", { hasText: new RegExp(`^${type}$`) }) });
    await expect(rowsOf("login_code_refused")).toHaveCount(1);
    const words = (await rowsOf("login_code_refused").locator(".history-change-cell").innerText()).trim();
    expect(words, "the reason, in words").toBe("Sign-in code NOT sent — a code sent under two minutes ago, or a desk code still in use, was left for the holder to type");
    expect(words, "never the raw key").not.toContain("recently_sent");
    // CONTROL: the honoured request is in the same dialog, so this is the
    // account's own code history and not an empty or foreign one.
    await expect(rowsOf("login_code_requested"), "CONTROL: the honoured request is listed beside it").toHaveCount(honoured);
  });
});

test.describe("v8.7.6 — the v6.20.x back-fill repair", () => {
  // Driven against the REAL db.js in a throwaway DATA_DIR, because the subject
  // is a boot-time migration: the shared test server has already booted, and its
  // guard row is already written.
  // Spelled as LITERALS at every use. `PORT_BASE + OFFSET` reads better and
  // hides the number from the v8.3.26 registry scanner, which greps for exactly
  // this shape — and a port nobody can see registered is the collision that
  // scanner exists to prevent.
  let dataDir, uploadsDir;
  const worlds = [];

  const bootOnce = async (port) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
        PORT: String(port), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir,
        BASE_URL: `http://127.0.0.1:${port}`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_ALLOW_PLAINTEXT: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1",
        // v7.15.30 — a spawned child inherits NODE_OPTIONS, which can change the
        // very exit it is being observed for.
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    // Readiness needs a POSITIVE IDENTITY (v7.21.10), and the obvious signal is
    // the wrong one HERE: `.superadmin-password` is written on the FIRST boot and
    // then persists, so a later boot's wait is satisfied instantly — before the
    // migration under test has run. `server_started_at` newer than the spawn is
    // an answer only THIS process can give.
    const spawnedAt = Date.now();
    const deadline = Date.now() + 30000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/config`);
        if (r.ok) {
          const cfg = await r.json();
          if (cfg.server_started_at && new Date(cfg.server_started_at).getTime() >= spawnedAt - 2000) { up = true; break; }
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!up) { child.kill("SIGKILL"); throw new Error(`server on ${port} never became ready. Log:\n${out.slice(-1500)}`); }
    child.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 500));
    return out;
  };

  const state = () => {
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "hackathon.db"), { readonly: true });
    try {
      const rows = db.prepare(
        "SELECT nickname, registered_via, created_at, password_set_at FROM users WHERE role='participant'"
      ).all();
      const guard = db.prepare("SELECT value FROM settings WHERE key='password_set_at_backfill_repaired_at'").get();
      const by = {};
      for (const r of rows) {
        by[r.nickname] = r.password_set_at === null
          ? "NULL" : (r.password_set_at === r.created_at ? "STAMPED_BY_BACKFILL" : "SET_LATER");
      }
      return { by, guard: !!guard };
    } finally { db.close(); }
  };

  /** A fresh DATA_DIR holding exactly the shape the old back-fill leaves behind. */
  async function makeWorld(port) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcrepair-"));
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcrepair-up-"));
    worlds.push([dataDir, uploadsDir]);
    await bootOnce(port);

    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "hackathon.db"));
    try {
      const mk = (nick, via, setAt) => db.prepare(
        "INSERT INTO users (id,first_name,last_name,nickname,email,password_hash,role,verified,approved,created_at,registered_via,password_set_at) " +
        "VALUES (?,?,?,?,?,?,'participant',1,1,?,?,?)"
      ).run(`id-${nick}`, "T", "T", nick, `${nick}@acme.com`, "x", "2020-01-01T00:00:00.000Z", via, setAt);
      mk("li-corrupted", "linkedin", "2020-01-01T00:00:00.000Z");
      mk("li-real-pw",   "linkedin", "2021-06-06T00:00:00.000Z");
      mk("li-clean",     "linkedin", null);
      mk("manual-pw",    "manual",   "2020-01-01T00:00:00.000Z");
      db.prepare("DELETE FROM settings WHERE key='password_set_at_backfill_repaired_at'").run();
    } finally { db.close(); }
  }

  test.afterAll(() => {
    for (const [d, u] of worlds) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(u, { recursive: true, force: true }); } catch (_) {}
    }
  });



  test("it clears ONLY the rows the back-fill stamped, and the guard stops it re-running", async () => {
    await makeWorld(PORT_BASE + 191);
    const before = state();
    expect(before.guard, "precondition: this database has not been repaired").toBe(false);
    expect(before.by["li-corrupted"], "precondition: the corrupted shape is present").toBe("STAMPED_BY_BACKFILL");

    await bootOnce(PORT_BASE + 191);
    const after = state();

    expect(after.by["li-corrupted"],
      "the door re-opens for a LinkedIn account that never had a password").toBe("NULL");
    // CONTROLS — each names a build that would pass the assertion above and be wrong.
    expect(after.by["li-real-pw"],
      "a LinkedIn account that LATER set a real password keeps it — the repair must not take one away").toBe("SET_LATER");
    expect(after.by["manual-pw"],
      "a password holder is untouched: the repair clears only the back-fill stamp on accounts that never set a password").toBe("STAMPED_BY_BACKFILL");
    expect(after.by["li-clean"], "an already-correct row is left alone").toBe("NULL");
    expect(after.guard, "and the guard is stamped").toBe(true);

    // THE GUARD IS THE WHOLE OF ITS SAFETY: un-guarded this would re-run every
    // boot and undo somebody who legitimately set a password since.
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "hackathon.db"));
    try {
      db.prepare("UPDATE users SET password_set_at='2026-01-01T00:00:00.000Z' WHERE nickname='li-corrupted'").run();
    } finally { db.close(); }

    await bootOnce(PORT_BASE + 191);
    expect(state().by["li-corrupted"],
      "a setting that will not stay where it is put is worse than a wrong default").toBe("SET_LATER");
  });
});
