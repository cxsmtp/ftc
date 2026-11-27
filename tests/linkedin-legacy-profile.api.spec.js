// @ts-check
//
// A LEGACY LINKEDIN-REGISTERED ACCOUNT IS ASKED AND EDITED LIKE ANY OTHER
// (operator ruling, 14 Nov 2026: the old name lock's removal is accepted).
//
// LinkedIn sign-in no longer exists. Such an account (`registered_via =
// 'linkedin'`) changes its own first name, last name and LinkedIn URL like
// anyone else, and so the completion gate asks it for a LinkedIn URL when its
// registration event requires one — the old "never ask" exemption, whose reason
// (a field it could not fill) the removal made false, is gone.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition } = require("./event-admin-helpers");

const dbRun = (sql, ...a) => { const db = new Database(TEST_DB_PATH); try { return db.prepare(sql).run(...a); } finally { db.close(); } };
const dbGet = (sql, ...a) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare(sql).get(...a); } finally { db.close(); } };

test("a LinkedIn-registered account is asked for the LinkedIn URL its event requires, edits its names and URL, and is then complete", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let s;
  try {
    // An event whose sign-up form requires the LinkedIn URL.
    const comp = await makeCompetition(sa, csrf, "lilegacy", { registration_fields: { linkedin_url: "required" } });
    const u = await makeParticipant(sa, csrf, "lilegacy");
    // The legacy shape: registered through the removed LinkedIn sign-up, no URL
    // stored, and that event as its registration event.
    dbRun("UPDATE users SET registered_via='linkedin', linkedin_url=NULL, registration_competition_id=? WHERE id=?", comp.id, u.id);
    expect(dbGet("SELECT registered_via FROM users WHERE id=?", u.id).registered_via, "PRECONDITION: a LinkedIn-registered account").toBe("linkedin");

    s = await apiLogin(u.email);
    const me = await (await s.api.get("/api/me")).json();
    expect(me.missing_fields, "the URL its event requires is asked of it, as of anyone").toContain("linkedin_url");
    expect(me.profile_complete).toBe(false);

    // It edits its own names and URL: nothing is locked.
    const put = await s.api.put("/api/me", { headers: H(s.csrf), data: { firstName: "Renamed", lastName: "Legacy", linkedinUrl: "https://www.linkedin.com/in/renamed-legacy" } });
    expect(put.status(), `self-edit: ${await put.text()}`).toBe(200);
    const row = dbGet("SELECT first_name, last_name, linkedin_url FROM users WHERE id=?", u.id);
    expect(row).toEqual({ first_name: "Renamed", last_name: "Legacy", linkedin_url: "https://www.linkedin.com/in/renamed-legacy" });

    // CONTROL: with the URL filled the gate is satisfied.
    const after = await (await s.api.get("/api/me")).json();
    expect(after.missing_fields, "a filled URL is no longer asked for").not.toContain("linkedin_url");
  } finally {
    if (s) await s.api.dispose();
    await sa.dispose();
  }
});
