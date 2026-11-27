// @ts-check
//
// NOBODY JOINS AN EVENT WHILE VIEWING AS SOMEONE (operator ruling, 21 Nov 2026:
// a superadmin's join made while viewing as a participant must not count as that
// participant having joined).
//
// The join door (`POST /api/competitions/join`: the join link, QR and event code)
// enrols the person being viewed, and every "joined" figure counts enrolments. It
// is refused for EVERY tier while impersonating (lib/impersonation.js
// `_IMPERSONATION_JOIN_PATHS`, asked ahead of the superadmin bypass), with its own
// code and sentence, under every spelling the path normaliser folds; nothing is
// written. Controls: the participant's own join enrols them; the superadmin keeps
// its other writes while impersonating and a regular admin keeps the read-only
// tier's own refusal (so the join's refusal is not a tier change). The events
// page withholds its event-code box with the same sentence, and a join started
// there sends nothing.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, getSuperadminPass, TEST_DB_PATH } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const SENTENCE = "Joining an event is not available while you view as someone: it would enrol them. To add them to an event, use Add to event in that event's Participants section.";
let comp, token, target, other, regular, browsed;

/** What the join would have written: the membership row and the person's join record. */
function written(userId, compId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return {
      member: db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, compId).n,
      joined: db.prepare("SELECT COUNT(*) AS n FROM user_events WHERE user_id=? AND event_type='self_enrolled'").get(userId).n,
    };
  } finally { db.close(); }
}

async function csrfOf(api) { return (await (await api.get("/api/csrf-token")).json()).csrfToken; }

test.beforeAll(async () => {
  const sa = await apiLogin("superadmin");
  try {
    comp = await makeCompetition(sa.api, sa.csrf, "imp-join", { self_enroll_enabled: true });
    const rv = await sa.api.get(`/api/admin/competitions/${comp.id}/self-enroll`);
    expect(rv.ok(), `reveal the join link: ${rv.status()} ${await rv.text()}`).toBeTruthy();
    token = (await rv.json()).token;
    expect(token, "PRECONDITION: the event has a live join token").toBeTruthy();
    target = await makeParticipant(sa.api, sa.csrf, "impjoin-t");
    other = await makeParticipant(sa.api, sa.csrf, "impjoin-o");
    browsed = await makeParticipant(sa.api, sa.csrf, "impjoin-b");
    regular = await makeParticipant(sa.api, sa.csrf, "impjoin-ro");
    const role = await sa.api.post(`/api/admin/participants/${regular.id}/role`, { headers: H(sa.csrf), data: { role: "admin" } });
    expect(role.ok(), `make a regular admin: ${role.status()} ${await role.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }
});

test("a superadmin viewing as a participant cannot join an event for them, under any spelling, and nothing is written", async () => {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const imp = await api.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(csrf) });
    expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    const c2 = await csrfOf(api);   // the entry regenerated the session
    for (const p of ["/api/competitions/join", "/API/competitions/join", "/api/competitions/join/", "/api/Competitions/JOIN", "/api//competitions/join"]) {
      const r = await api.post(p, { headers: H(c2), data: { token } });
      const body = await r.text();
      expect(r.status(), `${p}: ${body}`).toBe(403);
      const d = JSON.parse(body);
      expect(d.code, p).toBe("impersonation_join_refused");
      expect(d.error, p).toBe(SENTENCE);
    }
    expect(written(target.id, comp.id), "no membership and no join record").toEqual({ member: 0, joined: 0 });
    // CONTROL: the superadmin still writes while viewing as them, so the refusal
    // above is the join's own, not a read-only session.
    const put = await api.put("/api/me", { headers: H(c2), data: { city: "Joinville" } });
    expect(put.status(), `the superadmin's other writes go through: ${await put.text()}`).toBe(200);
    const exit = await api.post("/api/impersonation/exit", { headers: H(c2) });
    expect(exit.ok(), `exit: ${exit.status()}`).toBeTruthy();
  } finally { await api.dispose(); }
  // CONTROL: the same join, made by the participant themselves, enrols them.
  const own = await apiLogin(target.email, PARTICIPANT_PASS);
  try {
    const r = await own.api.post("/api/competitions/join", { headers: H(own.csrf), data: { token } });
    expect(r.status(), `their own join: ${await r.text()}`).toBe(200);
  } finally { await own.api.dispose(); }
  expect(written(target.id, comp.id), "their own join is written").toEqual({ member: 1, joined: 1 });
});

test("a regular admin viewing as a participant gets the same named refusal, not the read-only tier's", async () => {
  const { api, csrf } = await apiLogin(regular.email, PARTICIPANT_PASS);
  try {
    const imp = await api.post(`/api/admin/participants/${other.id}/impersonate`, { headers: H(csrf) });
    expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    const c2 = await csrfOf(api);
    const r = await api.post("/api/competitions/join", { headers: H(c2), data: { token } });
    expect(r.status(), await r.text()).toBe(403);
    expect((await r.json()).code).toBe("impersonation_join_refused");
    // CONTROL: any other write is still the read-only tier's own refusal.
    const put = await api.put("/api/me", { headers: H(c2), data: { city: "Readonlyville" } });
    expect(put.status()).toBe(403);
    expect((await put.json()).code).toBe("impersonation_readonly");
    await api.post("/api/impersonation/exit", { headers: H(c2) });
  } finally { await api.dispose(); }
  expect(written(other.id, comp.id), "nothing was written").toEqual({ member: 0, joined: 0 });
});

test("CONTROL — a person's own events page offers the event-code box", async ({ page }) => {
  test.setTimeout(60_000);
  await loginViaApi(page, browsed.email, PARTICIPANT_PASS);
  await page.goto("/");
  await expect(page.locator("#competitions-page"), "the events page (no event of their own yet)").toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#comp-join-code")).toBeVisible();
  await expect(page.locator("#comp-join-code-imp")).toBeHidden();
});

test("viewing as someone, the events page says why there is no event-code box, and a join started there sends nothing", async ({ page }) => {
  test.setTimeout(60_000);
  await loginViaApi(page, "superadmin", getSuperadminPass());
  await page.goto("/");
  await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
  const c1 = await csrfOf(page.request);
  const imp = await page.request.post(`/api/admin/participants/${browsed.id}/impersonate`, { headers: H(c1) });
  expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
  await page.goto("/");
  await page.waitForSelector(".impersonation-banner", { state: "visible", timeout: 20_000 });
  await expect(page.locator("#competitions-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#comp-join-code-imp"), "the box says why").toBeVisible();
  await expect(page.locator("#comp-join-code-imp")).toHaveText(SENTENCE);
  await expect(page.locator("#comp-join-code"), "and offers no input").toBeHidden();
  await expect(page.locator("[data-action='join-with-code']")).toBeHidden();
  // A join started anyway (the action, as an Enter on the box would run it)
  // asks the server nothing and says why.
  const sent = [];
  page.on("request", r => { if (/\/api\/competitions\/join/.test(r.url())) sent.push(r.url()); });
  await page.evaluate(() => { window.joinWithCode(); });
  await expect(page.locator("#toast-stack")).toContainText(SENTENCE);
  await page.waitForTimeout(300);
  expect(sent, "no join request was sent").toEqual([]);
  expect(written(browsed.id, comp.id).member).toBe(0);
});
