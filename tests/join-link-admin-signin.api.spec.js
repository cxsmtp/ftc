"use strict";

// AN ADMIN-TIER SIGN-IN THROUGH A JOIN LINK ENROLS NOBODY (operator ruling,
// 17 Nov 2026). A sign-in code requested through an event's join link (or QR, or
// event code) is bound to that event, and redeeming it enrolled whoever signed
// in: an event admin opening the link to check it became a participant, and,
// where a Checkmarx One key is set, got an account there. The sign-in ladder
// (lib/self-enroll.js `_enrolAtSignIn`) now refuses every admin-class role; a
// participant's sign-in through the same link still enrols them (CONTROL).

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin, codeLogin } = require("./helpers");
const { makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};

test("an event admin's sign-in through a join link enrols nobody; a participant's does", async ({ playwright }) => {
  const s = await apiLogin("superadmin");
  const A = await makeCompetition(s.api, s.csrf, "joinA", { self_enroll_enabled: true });
  const B = await makeCompetition(s.api, s.csrf, "joinB");
  const ea = await makeParticipant(s.api, s.csrf, "joinea");
  await grantEventAdmin(s.api, s.csrf, B.id, ea.id);
  const p = await makeParticipant(s.api, s.csrf, "joinp");
  const role = (id) => sql(db => db.prepare("SELECT role FROM users WHERE id=?").get(id).role);
  expect(role(ea.id), "PRECONDITION: an event admin").toBe("event_admin");
  const token = sql(db => db.prepare("SELECT self_enroll_token AS t, self_enroll_enabled AS on_ FROM competitions WHERE id=?").get(A.id));
  expect(token.on_, "PRECONDITION: the join link is open").toBe(1);
  const rowIn = (uid) => !!sql(db => db.prepare("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?").get(A.id, uid));
  for (const who of [p, ea]) {
    const ctx = await playwright.request.newContext({ baseURL: BASE });
    try {
      const r = await codeLogin(ctx, who.email, null, { joinToken: token.t });
      expect(r.ok(), `sign-in ${who.email}: ${r.status()} ${await r.text()}`).toBeTruthy();
    } finally { await ctx.dispose(); }
  }
  expect(rowIn(p.id), "CONTROL: a participant signing in through the link is enrolled").toBe(true);
  expect(rowIn(ea.id), "an event admin signing in through the link is not").toBe(false);
});
