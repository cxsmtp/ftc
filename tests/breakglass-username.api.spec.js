// ONE break-glass account with a changeable USERNAME (settings key
// `breakglass_username`, default `superadmin`). Locked here:
//   * only the built-in session itself can read or change it — a user-backed
//     superadmin gets 403, and so does every other tier;
//   * after a rename the OLD name is refused with the one generic answer, the new
//     one signs in, and the current session stays signed in;
//   * a wrong password for the RIGHT name answers exactly like a wrong name;
//   * the name is never in an anonymous response (the SPA shell, the bundle,
//     /api/config) — the SPA asks for it in its break-glass dialog;
//   * a user-backed superadmin cannot use the password door at all;
//   * a name an account holds as an address is refused at the rename, and shuts
//     the door for that name if an account comes to hold it later;
//   * the rename's audit row never carries either name;
//   * wrong passwords count toward the rotation under the CURRENT name only.
// Every test restores the default in a `finally` (the hard-coded value).
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, codeLogin, registerPost, TEST_DB_PATH } = require("./helpers");
const { makeParticipant } = require("./event-admin-helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const DEFAULT = "superadmin";

async function builtinSession(name) {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(csrf), data: { username: name || DEFAULT, password: getSuperadminPass() } });
  expect(r.ok(), `break-glass sign-in as ${name || DEFAULT}: ${r.status()}`).toBeTruthy();
  const t = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { api, csrf: t };
}
/** A fresh lower-case name no account holds. */
const freshName = (tag) => `${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
/** Plant `name` (no '@') as an account's secondary address: only SQL can store one. */
function setSecondary(userId, name) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { db.prepare("UPDATE users SET secondary_email=? WHERE id=?").run(name, userId); } finally { db.close(); }
}
/** The settings_events rows for `key` written since `mark` (a rowid from `settingsMark()`), newest first. */
function settingsRows(key, mark) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT event_type, details FROM settings_events WHERE setting_key=? AND rowid>? ORDER BY rowid DESC")
      .all(key, mark);
  } finally { db.close(); }
}
function settingsMark() {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM settings_events").get().m; } finally { db.close(); }
}
function resetName() {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { db.prepare("DELETE FROM settings WHERE key='breakglass_username'").run(); } finally { db.close(); }
}

test.describe("the break-glass username", () => {
  test("only the built-in session reads and renames it; old name refused generically; session kept", async () => {
    const name = `ops-${Date.now().toString(36)}`;
    const bg = await builtinSession();
    try {
      const g = await bg.api.get("/api/admin/breakglass-username");
      expect(g.status()).toBe(200);
      expect((await g.json()).username).toBe(DEFAULT);
      const p = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: name } });
      expect(p.status(), await p.text()).toBe(200);
      // The current session stays signed in.
      expect((await bg.api.get("/api/admin/me")).status()).toBe(200);
      // The old name is refused exactly like any address; the new one works.
      const { api, csrf } = await freshCtx();
      const old = await api.post("/api/login", { headers: H(csrf), data: { username: DEFAULT, password: getSuperadminPass() } });
      const anyAddr = await api.post("/api/login", { headers: H(csrf), data: { username: "someone@example.com", password: "x" } });
      expect(old.status()).toBe(401);
      expect(await old.text(), "the old name answers byte-identically to an arbitrary address").toBe(await anyAddr.text());
      expect((await old.json()).code).toBe("use_sign_in_code");
      const wrongPw = await api.post("/api/login", { headers: H(csrf), data: { username: name, password: "wrong-password" } });
      expect(await wrongPw.text(), "a wrong password for the right name is no oracle").toBe(await anyAddr.text());
      const ok = await api.post("/api/login", { headers: H(csrf), data: { username: name, password: getSuperadminPass() } });
      expect(ok.status(), "control: the new name signs in").toBe(200);
      // Never in an anonymous response.
      const { api: anon } = await freshCtx();
      for (const path of ["/", "/api/config", "/js/core/main.js", "/js/features/auth.js"]) {
        const body = await (await anon.get(path)).text();
        expect(body.includes(name), `${path} must not carry the break-glass username`).toBe(false);
      }
      await api.dispose(); await anon.dispose();
    } finally {
      resetName();
      await bg.api.dispose();
    }
  });

  test("a user-backed superadmin can neither read nor change it, nor use the password door", async () => {
    const bg = await builtinSession();
    const email = `ubsa-${Date.now()}@breakglass.example`;
    try {
      const reg = await registerPost(bg.api, "/api/register", { headers: H(bg.csrf), data: {
        firstName: "User", lastName: "Backed", company: "Acme", title: "Ops", country: "US", timezone: "UTC", email,
      } });
      expect(reg.status(), await reg.text()).toBe(200);
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const id = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id;
      db.close();
      const role = await bg.api.post(`/api/admin/participants/${id}/role`, { headers: H(bg.csrf), data: { role: "superadmin" } });
      expect(role.ok(), await role.text()).toBeTruthy();
      const { api, csrf } = await freshCtx();
      const pw = await api.post("/api/login", { headers: H(csrf), data: { email, password: getSuperadminPass() } });
      expect(pw.status(), "the password door is the break-glass name's only").toBe(401);
      const li = await codeLogin(api, email, H(csrf));
      expect(li.ok(), "control: the user-backed superadmin signs in with a code").toBeTruthy();
      const t = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      expect((await api.get("/api/admin/breakglass-username")).status()).toBe(403);
      const p = await api.patch("/api/admin/breakglass-username", { headers: H(t), data: { username: "takeover" } });
      expect(p.status()).toBe(403);
      expect((await p.json()).code).toBe("breakglass_session_required");
      await api.dispose();
    } finally {
      resetName();
      await bg.api.dispose();
    }
  });

  test("the settings export never carries it, whoever exports", async () => {
    const name = `ops-${Date.now().toString(36)}x`;
    const bg = await builtinSession();
    const email = `ubexp-${Date.now()}@breakglass.example`;
    try {
      const p = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: name } });
      expect(p.status(), await p.text()).toBe(200);
      const reg = await registerPost(bg.api, "/api/register", { headers: H(bg.csrf), data: {
        firstName: "User", lastName: "Exporter", company: "Acme", title: "Ops", country: "US", timezone: "UTC", email,
      } });
      expect(reg.status(), await reg.text()).toBe(200);
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const id = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id;
      expect(db.prepare("SELECT value FROM settings WHERE key='breakglass_username'").get().value, "PRECONDITION: the name is stored").toBe(name);
      db.close();
      const role = await bg.api.post(`/api/admin/participants/${id}/role`, { headers: H(bg.csrf), data: { role: "superadmin" } });
      expect(role.ok(), await role.text()).toBeTruthy();
      const { api, csrf } = await freshCtx();
      expect((await codeLogin(api, email, H(csrf))).ok(), "the user-backed superadmin signs in").toBeTruthy();
      for (const [who, a] of [["a user-backed superadmin", api], ["the break-glass session", bg.api]]) {
        const r = await a.get("/api/admin/export/settings");
        expect(r.status(), `${who} exports`).toBe(200);
        const text = await r.text();
        expect(text.includes(name), `${who}'s settings export must not carry the name`).toBe(false);
        expect(JSON.parse(text).settings.breakglass_username).toBe("[REDACTED]");
      }
      await api.dispose();
    } finally {
      resetName();
      await bg.api.dispose();
    }
  });

  test("a username is validated: length, characters, no @, never an account's address", async () => {
    const bg = await builtinSession();
    let held = null;
    try {
      for (const [u, code] of [["ab", "username_length"], ["has space", "username_charset"], ["a@b.example", "username_at_sign"]]) {
        const r = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: u } });
        expect(r.status(), u).toBe(400);
        expect((await r.json()).code, u).toBe(code);
      }
      // An address with no '@' is stored only by SQL, which is the one way an
      // account can hold a name the break-glass account could take.
      held = await makeParticipant(bg.api, bg.csrf, "bgheld");
      const taken = freshName("held");
      setSecondary(held.id, taken);
      const r = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: taken.toUpperCase() } });
      expect(r.status(), "a name an account holds is refused").toBe(400);
      expect((await r.json()).code).toBe("username_taken");
      const ok = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: freshName("free") } });
      expect(ok.status(), `CONTROL: a name nobody holds is taken: ${await ok.text()}`).toBe(200);
    } finally {
      if (held) setSecondary(held.id, null);
      resetName();
      await bg.api.dispose();
    }
  });

  test("an account coming to hold the name shuts the break-glass door for it", async () => {
    const bg = await builtinSession();
    const name = freshName("door");
    let held = null;
    try {
      const p = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: name } });
      expect(p.status(), await p.text()).toBe(200);
      held = await makeParticipant(bg.api, bg.csrf, "bgdoor");
      const { api, csrf } = await freshCtx();
      try {
        const signIn = () => api.post("/api/login", { headers: H(csrf), data: { username: name, password: getSuperadminPass() } });
        const first = await signIn();
        expect(first.status(), "CONTROL: the name signs in while nobody holds it").toBe(200);
        // That sign-in replaced the session this context held: fetch a token for the next.
        const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        setSecondary(held.id, name);
        const shut = await api.post("/api/login", { headers: H(c2), data: { username: name, password: getSuperadminPass() } });
        const anyName = await api.post("/api/login", { headers: H(c2), data: { username: freshName("nobody"), password: "x" } });
        expect(shut.status(), "an account holding the name shuts the door").toBe(401);
        expect(await shut.text(), "…with the one generic answer").toBe(await anyName.text());
        setSecondary(held.id, null);
        const reopened = await api.post("/api/login", { headers: H(c2), data: { username: name, password: getSuperadminPass() } });
        expect(reopened.status(), "CONTROL: cleared, the name signs in again").toBe(200);
      } finally { await api.dispose(); }
    } finally {
      if (held) setSecondary(held.id, null);
      resetName();
      await bg.api.dispose();
    }
  });

  test("the rename's audit row never carries either name", async () => {
    const bg = await builtinSession();
    const name = freshName("audit");
    const since = settingsMark();
    try {
      const p = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: name } });
      expect(p.status(), await p.text()).toBe(200);
      const rows = settingsRows("breakglass_username", since);
      expect(rows.length, "the rename is audited").toBe(1);
      expect(rows[0].details.includes(name), "the new name is not in the row").toBe(false);
      expect(rows[0].details.includes(DEFAULT), "nor the old one").toBe(false);
      expect(JSON.parse(rows[0].details).reset_to_default).toBe(false);
      const back = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: DEFAULT } });
      expect(back.status(), await back.text()).toBe(200);
      const after = settingsRows("breakglass_username", since);
      expect(after.length, "CONTROL: the reset is audited too").toBe(2);
      expect(JSON.parse(after[0].details).reset_to_default, "…and says it went back to the default").toBe(true);
    } finally {
      resetName();
      await bg.api.dispose();
    }
  });

  // An address with no `@` reaches this branch only through an older or
  // hand-edited row (every door refuses one), so the account is planted by SQL.
  test("a username an account holds as its stored address is refused, whatever its case", async () => {
    const stamp = Date.now().toString(36);
    const email = `bgtaken-${stamp}@breakglass.example`;
    const held = `legacyname${stamp}`;
    const { api: reg, csrf: rc } = await freshCtx();
    let id;
    try {
      const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
        firstName: "Legacy", lastName: "Name", company: "Acme", title: "Ops", country: "US", timezone: "UTC", email,
      } });
      expect(r.status(), await r.text()).toBe(200);
    } finally { await reg.dispose(); }
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      id = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id;
      db.prepare("UPDATE users SET email=? WHERE id=?").run(held, id);
    } finally { db.close(); }
    const bg = await builtinSession();
    try {
      const r = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: held.toUpperCase() } });
      expect(r.status(), await r.text()).toBe(400);
      expect((await r.json()).code).toBe("username_taken");
      // CONTROL: a name no account holds is accepted on the same session.
      const ok = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: `${held}2` } });
      expect(ok.status(), await ok.text()).toBe(200);
    } finally {
      resetName();
      const db2 = new Database(TEST_DB_PATH);
      try { db2.prepare("UPDATE users SET email=? WHERE id=?").run(email, id); } finally { db2.close(); }
      await bg.api.dispose();
    }
  });

  // LAST in the file: a rotation replaces the worker server's password file.
  test("wrong passwords count against the renamed name, never the old one", async () => {
    const bg = await builtinSession();
    const name = freshName("rot");
    const since = settingsMark();
    try {
      const p = await bg.api.patch("/api/admin/breakglass-username", { headers: H(bg.csrf), data: { username: name } });
      expect(p.status(), await p.text()).toBe(200);
      const { api, csrf } = await freshCtx();
      try {
        const wrong = (u) => api.post("/api/login", { headers: H(csrf), data: { username: u, password: "not-the-password" } });
        for (let i = 0; i < 10; i++) expect((await wrong(DEFAULT)).status()).toBe(401);
        expect(settingsRows("superadmin_password", since).length,
          "ten wrong passwords under the OLD name count for nothing").toBe(0);
        const before = getSuperadminPass();
        let rows = [];
        for (let i = 0; i < 10 && !rows.length; i++) {
          expect((await wrong(name)).status()).toBe(401);
          rows = settingsRows("superadmin_password", since).filter(r => r.event_type === "rotated" || r.event_type === "rotation_suppressed");
        }
        expect(rows.length, "wrong passwords under the current name reach the rotation").toBeGreaterThan(0);
        // Nothing earlier in this file's server rotated, so no cooldown holds it back.
        expect(rows[0].event_type, "the file's first rotation is not on cooldown").toBe("rotated");
        await expect.poll(() => getSuperadminPass(), { message: "the rotated password is written" }).not.toBe(before);
        const c = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        const stale = await api.post("/api/login", { headers: H(c), data: { username: name, password: before } });
        expect(stale.status(), "the previous password no longer signs in").toBe(401);
        const fresh = await api.post("/api/login", { headers: H(c), data: { username: name, password: getSuperadminPass() } });
        expect(fresh.status(), "the rotated one does, under the current name").toBe(200);
      } finally { await api.dispose(); }
    } finally {
      resetName();
      await bg.api.dispose();
    }
  });
});
