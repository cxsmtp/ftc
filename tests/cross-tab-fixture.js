// @ts-check
//
// Two tabs of ONE browser: pages of one context share the cookie jar and
// localStorage, as tabs do. Shared by tests/csrf-cross-tab.spec.js and
// tests/signout-messages.spec.js.
const { expect } = require("@playwright/test");
const Database = require("better-sqlite3");
const { BASE, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H } = require("./event-admin-helpers");

const OUT_OF_DATE = "This tab is out of date";

function dbAll(sql, ...a) {
  const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
}
/** Sessions the server ended because a CSRF token was refused, for `userId`. */
const csrfEnds = (userId) => dbAll(
  "SELECT details FROM user_events WHERE user_id=? AND event_type='sessions_invalidated'", userId)
  .map(r => JSON.parse(r.details || "{}")).filter(d => d.reason === "csrf_invalid");

/** The SPA booted on `page`, holding a token and its fingerprint. */
async function booted(page) {
  await page.goto(BASE + "/");
  await expect.poll(() => page.evaluate(() => !!window.csrfToken && !!window._csrfFp), { timeout: 20_000 }).toBe(true);
}
/** Signed in through the page's own context, then booted. */
async function signedInTab(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await booted(page);
  await expect.poll(() => page.evaluate(() => !!(window.currentUser && window.currentUser.id)), { timeout: 20_000 }).toBe(true);
}
/** Non-GET requests `page` sends from now on, by path, with the token each carried. */
function watchWrites(page) {
  const seen = [];
  const on = (q) => { if (q.method() !== "GET" && q.method() !== "HEAD") seen.push({ path: new URL(q.url()).pathname, token: q.headers()["x-csrf-token"] || null }); };
  page.on("request", on);
  return { seen, stop: () => page.off("request", on) };
}
/** Replace the session out of band, as another tab would, for the same account:
 *  signing in again (an emailed code, redeemed through the shared cookie jar)
 *  regenerates it. Returns the new session's token. (The name predates the
 *  removal of passwords: a password change was the old way to do this.) */
async function replaceByPasswordChange(page, _unused) {
  const other = page.context().request;
  // `booted` waits for the token only; the account arrives with /api/me after
  // it. Under load a read before then named nobody, and the "other tab" then
  // signed in as no one (no code minted for undefined).
  await expect.poll(() => page.evaluate(() => !!(window.currentUser && window.currentUser.email)),
    { message: "PRECONDITION: the tab knows whose session it holds", timeout: 20_000 }).toBe(true);
  const csrf = await page.evaluate(() => window.csrfToken);
  const email = await page.evaluate(() => window.currentUser && window.currentUser.email);
  const li = await codeLogin(other, email, H(csrf));
  expect(li.ok(), `the other tab's sign-in: ${li.status()} ${await li.text()}`).toBeTruthy();
  const { csrfToken } = await (await other.get("/api/csrf-token")).json();
  expect(csrfToken, "PRECONDITION: the replaced session has a new token").not.toBe(csrf);
  return csrfToken;
}
/** Publish `token`'s fingerprint from `page` itself (no storage event there). */
const publishFrom = (page, token) => page.evaluate((t) => localStorage.setItem("ha:csrf-fp", window.csrfTokenFp(t)), token);
const keepalive = (page) => page.evaluate(() => fetch("/api/session/keepalive", { method: "POST", headers: window.csrfHeaders() }).then(r => r.status));

module.exports = { OUT_OF_DATE, dbAll, csrfEnds, booted, signedInTab, watchWrites, replaceByPasswordChange, publishFrom, keepalive };
