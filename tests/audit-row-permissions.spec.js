// @ts-check
//
// THE AUDIT PAGE: EACH KIND OF ROW FOLLOWS THE PERMISSION THAT GUARDS IT
// ELSEWHERE (operator ruling, 14 Nov 2026).
//
// `audit.view` opens the page. Events and sessions need `events.view` (their
// History), people `participants.view`, settings `settings.view`, challenge
// versions `challenges.view`; submissions and hints are the page's own
// (`audit.view`, the Submissions view). A logged event naming an event follows
// `events.view`; one naming none follows the Raw logs permission, which reads
// the same lines. Asserted BY VALUE with custom roles that act on every event
// (the reader the ruling is about), each kind seen by the role holding its
// permission and withheld from one lacking it, beside a superadmin control.
// The page's record-type chips follow the answer's `readable_types`.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, waitForAdminPage, freshCtx } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const ALL = ["event", "session", "person", "setting", "challenge_version", "submission", "hint", "log_event"];
let sa, saCsrf;
const R = {};   // roles by key
const U = {};   // holders by key
const W = {};   // the world's rows: ids to look for
const S = {};   // holders' API sessions

async function audit(api, query) {
  const r = await api.get(`/api/admin/audit?limit=200&${query}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), body };
}

test.describe("Audit: each kind of row follows its own permission (operator ruling, 14 Nov 2026)", () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    const stamp = Date.now();
    const mkRole = async (key, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `Audit ${key} ${stamp}`, scope_mode: "all", permissions } });
      expect(r.ok(), `create role ${key}: ${r.status()} ${await r.text()}`).toBeTruthy();
      R[key] = (await r.json()).role;
    };
    await mkRole("only", ["audit.view"]);
    await mkRole("settings", ["audit.view", "settings.view"]);
    await mkRole("people", ["audit.view", "participants.view"]);
    await mkRole("events", ["audit.view", "events.view"]);
    await mkRole("challenges", ["audit.view", "challenges.view"]);
    await mkRole("raw", ["audit.view", "audit.raw_logs"]);
    for (const key of Object.keys(R)) {
      const u = await makeParticipant(sa, saCsrf, `aud${key}`);
      const r = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: R[key].id } });
      expect(r.ok(), `assign ${key}: ${r.status()} ${await r.text()}`).toBeTruthy();
      U[key] = u;
    }
    // The world, one row of each kind the ruling is about.
    W.settingKey = `role:${R.only.id}`;                              // a settings row (the role's creation)
    W.person = U.people.id;                                           // a person row (the role change)
    W.comp = await makeCompetition(sa, saCsrf, "audcomp");          // an event row (its creation)
    W.task = await makeTask(sa, saCsrf, "audtask");                 // a challenge version
    // A logged event naming an event: the event's full export.
    const ex = await sa.get(`/api/admin/competitions/${W.comp.id}/export/full`);
    expect(ex.status(), `full export: ${ex.status()}`).toBe(200);
    // A logged event naming none: an address proof refused for a personal address.
    const anon = await freshCtx();
    try {
      const rq = await anon.api.post("/api/auth/code/request", { headers: H(anon.csrf), data: { email: `aud-${stamp}@gmail.com` } });
      expect(rq.status()).toBe(200);
    } finally { await anon.api.dispose(); }
    for (const key of Object.keys(U)) S[key] = await apiLogin(U[key].email, PARTICIPANT_PASS);
  });

  test.afterAll(async () => {
    for (const s of Object.values(S)) { try { await s.api.dispose(); } catch (_) { /* gone */ } }
    try { await sa.dispose(); } catch (_) { /* gone */ }
  });

  test("CONTROL — the superadmin reads every kind, and each planted row is there", async () => {
    const all = await audit(sa, "");
    expect(all.status).toBe(200);
    expect(all.body.readable_types, "every kind").toEqual(ALL);
    expect((await audit(sa, `subjectId=${encodeURIComponent(W.settingKey)}`)).body.rows.some((r) => r.type === "setting"), "the settings row").toBe(true);
    expect((await audit(sa, `subjectId=${W.person}`)).body.rows.some((r) => r.type === "person"), "the person row").toBe(true);
    expect((await audit(sa, `subjectId=${W.comp.id}`)).body.rows.some((r) => r.type === "event"), "the event row").toBe(true);
    expect((await audit(sa, `subjectId=${W.task.id}`)).body.rows.some((r) => r.type === "challenge_version"), "the challenge version").toBe(true);
    const logs = (await audit(sa, "types=log_event&event_type=data_exported,email_proof_refused")).body.rows;
    expect(logs.some((r) => r.event_type === "data_exported" && r.competition_id === W.comp.id), "the logged event naming an event").toBe(true);
    expect(logs.some((r) => r.event_type === "email_proof_refused" && r.competition_id === null), "the logged event naming none").toBe(true);
  });

  test("audit.view alone: submissions and hints only — every other kind is withheld, and naming one is refused by its permission", async () => {
    const api = S.only.api;
    const all = await audit(api, "");
    expect(all.status, JSON.stringify(all.body).slice(0, 300)).toBe(200);
    expect(all.body.readable_types).toEqual(["submission", "hint"]);
    expect(all.body.rows.every((r) => r.type === "submission" || r.type === "hint"), "no row of another kind").toBe(true);
    for (const [type, perm] of [["setting", "settings.view"], ["person", "participants.view"], ["event", "events.view"], ["session", "events.view"], ["challenge_version", "challenges.view"], ["log_event", "events.view"]]) {
      const r = await audit(api, `types=${type}`);
      expect(r.status, `${type} is refused`).toBe(403);
      expect(r.body).toMatchObject({ code: "audit_type_forbidden", type, permission: perm });
    }
    // The rows themselves, by value: the planted ones are nowhere.
    expect((await audit(api, `subjectId=${encodeURIComponent(W.settingKey)}`)).body.rows, "no settings row").toEqual([]);
    expect((await audit(api, `subjectId=${W.person}`)).body.rows, "no person row").toEqual([]);
    expect((await audit(api, `subjectId=${W.comp.id}`)).body.rows, "no event row").toEqual([]);
    expect((await audit(api, `subjectId=${W.task.id}`)).body.rows, "no challenge version").toEqual([]);
    // CONTROL: the page's own kinds are not refused.
    expect((await audit(api, "types=submission,hint")).status).toBe(200);
  });

  test("settings.view adds the settings rows; participants.view the people's; events.view the events' — each only its own", async () => {
    const st = await audit(S.settings.api, `subjectId=${encodeURIComponent(W.settingKey)}`);
    expect(st.body.readable_types).toEqual(["setting", "submission", "hint"]);
    expect(st.body.rows.some((r) => r.type === "setting"), "settings.view: the settings row").toBe(true);
    expect((await audit(S.settings.api, `subjectId=${W.person}`)).body.rows, "…but no person row").toEqual([]);

    const pp = await audit(S.people.api, `subjectId=${W.person}`);
    expect(pp.body.readable_types).toEqual(["person", "submission", "hint"]);
    expect(pp.body.rows.some((r) => r.type === "person"), "participants.view: the person row").toBe(true);
    expect((await audit(S.people.api, "types=setting")).status, "…but settings are refused").toBe(403);

    const ev = await audit(S.events.api, `subjectId=${W.comp.id}`);
    expect(ev.body.readable_types).toEqual(["event", "session", "submission", "hint", "log_event"]);
    expect(ev.body.rows.some((r) => r.type === "event"), "events.view: the event row").toBe(true);
    expect((await audit(S.events.api, `subjectId=${W.person}`)).body.rows, "…but no person row").toEqual([]);
  });

  test("challenges.view adds the challenge versions, by value — and only those", async () => {
    // The permission the source asks is challenges.view itself (the History of
    // a challenge's versions), not the superadmin's everything: a role holding
    // just it beside audit.view reads the planted version and no other kind.
    const api = S.challenges.api;
    const cv = await audit(api, `subjectId=${W.task.id}`);
    expect(cv.status, JSON.stringify(cv.body).slice(0, 300)).toBe(200);
    expect(cv.body.readable_types).toEqual(["challenge_version", "submission", "hint"]);
    const mine = cv.body.rows.filter((r) => r.type === "challenge_version");
    expect(mine.length, "challenges.view: the planted challenge's version is there").toBeGreaterThan(0);
    expect(mine.every((r) => r.subject && r.subject.id === W.task.id), "…and it is that challenge's").toBe(true);
    expect((await audit(api, "types=challenge_version")).status, "naming the kind is not refused").toBe(200);
    // Every other kind stays withheld, by value and by name.
    expect((await audit(api, `subjectId=${encodeURIComponent(W.settingKey)}`)).body.rows, "no settings row").toEqual([]);
    expect((await audit(api, `subjectId=${W.person}`)).body.rows, "no person row").toEqual([]);
    expect((await audit(api, `subjectId=${W.comp.id}`)).body.rows, "no event row").toEqual([]);
    for (const [type, perm] of [["setting", "settings.view"], ["person", "participants.view"], ["event", "events.view"], ["log_event", "events.view"]]) {
      const r = await audit(api, `types=${type}`);
      expect(r.status, `${type} is refused`).toBe(403);
      expect(r.body).toMatchObject({ code: "audit_type_forbidden", type, permission: perm });
    }
  });

  test("a logged event naming an event follows events.view; one naming none follows the Raw logs permission", async () => {
    const q = "types=log_event&event_type=data_exported,email_proof_refused";
    const ev = (await audit(S.events.api, q)).body.rows;
    expect(ev.some((r) => r.event_type === "data_exported" && r.competition_id === W.comp.id), "events.view: the event's own logged event").toBe(true);
    expect(ev.every((r) => r.competition_id !== null), "events.view: no logged event that names no event").toBe(true);

    const rw = await audit(S.raw.api, q);
    expect(rw.status).toBe(200);
    expect(rw.body.readable_types).toEqual(["submission", "hint", "log_event"]);
    expect(rw.body.rows.some((r) => r.event_type === "email_proof_refused" && r.competition_id === null), "raw logs: the logged event naming no event").toBe(true);
    expect(rw.body.rows.every((r) => r.competition_id === null), "raw logs without events.view: no event's logged events").toBe(true);
  });
});

test.describe("the Audit page's record-type chips follow what the reader may see", () => {
  async function openAudit(page) {
    await page.locator("button.admin-nav-item[data-tab-id='admin-audit-tab']").click();
    await expect(page.locator("#admin-audit-tab")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#admin-audit-body tr").first()).toBeVisible({ timeout: 15000 });
  }
  // Whether each chip is offered (its `hidden`), whether or not the Filters
  // panel holding them is open.
  const chipsShown = (page) => page.evaluate(() => [...document.querySelectorAll("#audit-type-filters [data-type]")]
    .filter((b) => !b.hidden).map((b) => b.dataset.type));

  test("audit.view alone: only the Submissions and Hints chips; a superadmin sees all eight (CONTROL)", async ({ page, browser }) => {
    const { api, csrf } = await apiLogin("superadmin");
    let holder;
    try {
      const r = await api.post("/api/admin/roles", { headers: H(csrf), data: { label: `Audit chips ${Date.now()}`, scope_mode: "all", permissions: ["audit.view"] } });
      expect(r.ok(), await r.text()).toBeTruthy();
      holder = await makeParticipant(api, csrf, "audchips");
      const a = await api.patch(`/api/admin/users/${holder.id}/role`, { headers: H(csrf), data: { role: (await r.json()).role.id } });
      expect(a.ok(), await a.text()).toBeTruthy();
    } finally { await api.dispose(); }

    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      const { adminLogin } = require("./ui-admin-helpers");
      await adminLogin(sp);
      await openAudit(sp);
      await expect.poll(async () => (await chipsShown(sp)).sort(), { message: "CONTROL: the superadmin's chips" }).toEqual([...ALL].sort());
    } finally { await ctx.close(); }

    await loginViaApi(page, holder.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page);
    await openAudit(page);
    await expect.poll(async () => (await chipsShown(page)).sort(), { timeout: 10000 }).toEqual(["hint", "submission"]);
  });
});

// WHAT A READER WITHOUT THE RAW LOGS SEES OF A LOGGED EVENT (sweep #104). A
// logged event naming an event reaches whoever may view that event, organisers
// included, but some writers record people who are not its members: a public
// visitor checking a certificate, a newcomer asking for a code through the join
// link, a deleted participant's Checkmarx One account, an erased recipient's
// address, a blocked address. For a reader without the raw logs (which hold the
// same lines) the request context and those fields are withheld, named in
// `withheld_fields`, and an address-block alert is not listed; the raw logs'
// readers see every value (the CONTROLS). Planted rows, read by value.
test.describe("Audit: a logged event's visitors and erased people are for the raw logs' readers (sweep #104)", () => {
  const T = String(Date.now());
  const V = { ip: "203.0.113.77", ua: `probe-agent-${T}`, sid: `probe-session-${T}`, rid: `probe-req-${T}`, cx: `probe-cxone-${T}`, to: `erased-${T}@acme.com`, ban: "198.51.100.23" };
  let sa2, comp;
  const who = {};   // reader key -> { api }
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    sa2 = s;
    comp = await makeCompetition(s.api, s.csrf, "audvisit");
    const { grantEventAdmin } = require("./event-admin-helpers");
    const org = await makeParticipant(s.api, s.csrf, "audvisitorg");
    await grantEventAdmin(s.api, s.csrf, comp.id, org.id);
    const mk = async (key, permissions) => {
      const r = await s.api.post("/api/admin/roles", { headers: H(s.csrf), data: { label: `Audit visit ${key} ${T}`, scope_mode: "all", permissions } });
      expect(r.ok(), await r.text()).toBeTruthy();
      const u = await makeParticipant(s.api, s.csrf, `audvisit${key}`);
      const g = await s.api.patch(`/api/admin/users/${u.id}/role`, { headers: H(s.csrf), data: { role: (await r.json()).role.id } });
      expect(g.ok(), await g.text()).toBeTruthy();
      return u;
    };
    const events = await mk("events", ["audit.view", "events.view"]);
    const raw = await mk("raw", ["audit.view", "events.view", "audit.raw_logs"]);
    const { TEST_DB_PATH } = require("./helpers");
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      const ins = db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)");
      const at = new Date().toISOString();
      const ctx = { ip: V.ip, user_agent: V.ua, session_id: V.sid, req_id: V.rid };
      ins.run(`v1-${T}`, "credential", `cf_${T}`, "credential_verified", "anonymous", at, comp.id, null, JSON.stringify({ ...ctx, user_id: `holder-${T}`, competition_id: comp.id, revoked: false }));
      ins.run(`v2-${T}`, "user", `gone-${T}`, "cxone_provision_abandoned", "system", at, comp.id, null, JSON.stringify({ competition_id: comp.id, stage: "after_create", reason: "user_deleted", cxone_user_id: V.cx }));
      ins.run(`v3-${T}`, "email", "certificate_awarded", "email_sent", "system", at, comp.id, null, JSON.stringify({ to: V.to, subject: `Your certificate ${T}`, reason: "certificate_awarded", success: true, competition_id: comp.id, user_id: `gone-${T}`, recipient_deleted: true }));
      ins.run(`v4-${T}`, "security", V.ban, "ip_ban_alert_raised", "system", at, comp.id, null, JSON.stringify({ ip: V.ban, channel: "email", competition_id: comp.id }));
    } finally { db.close(); }
    who.org = await apiLogin(org.email, PARTICIPANT_PASS);
    who.events = await apiLogin(events.email, PARTICIPANT_PASS);
    who.raw = await apiLogin(raw.email, PARTICIPANT_PASS);
    who.sa = s;
  });
  test.afterAll(async () => {
    for (const k of ["org", "events", "raw"]) { try { await who[k].api.dispose(); } catch (_) { /* gone */ } }
    try { await sa2.api.dispose(); } catch (_) { /* gone */ }
  });

  const rowsOf = async (key, extra = "") => {
    const r = await audit(who[key].api, `types=log_event&competitionId=${comp.id}${extra}`);
    expect(r.status, `${key}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
    return r.body.rows || [];
  };
  const SECRET = () => [V.ip, V.ua, V.sid, V.rid, V.cx, V.to, V.ban];

  for (const key of ["org", "events"]) {
    test(`${key === "org" ? "an event admin of the event" : "a role viewing every event without the raw logs"} reads the rows without the visitors' details, and no address-block alert`, async () => {
      const rows = await rowsOf(key);
      const text = JSON.stringify(rows);
      for (const v of SECRET()) expect(text, `${key}: ${v} is withheld`).not.toContain(v);
      const by = (t) => rows.find(r => r.event_type === t);
      const cv = by("credential_verified");
      expect(cv, `${key}: the certificate check is listed`).toBeTruthy();
      expect(cv.details.user_id, "…with what it recorded about the certificate").toBe(`holder-${T}`);
      expect([...cv.details.withheld_fields].sort(), "…and the row says what was withheld").toEqual(["ip", "req_id", "session_id", "user_agent"]);
      expect(by("cxone_provision_abandoned").details.withheld_fields).toEqual(["cxone_user_id"]);
      expect(by("cxone_provision_abandoned").details.stage, "the rest of it is there").toBe("after_create");
      expect(by("email_sent").details.withheld_fields).toEqual(["to"]);
      expect(by("email_sent").details.recipient_deleted).toBe(true);
      expect(by("ip_ban_alert_raised"), `${key}: an address-block alert is not listed`).toBeUndefined();
      expect(await rowsOf(key, `&subjectId=${encodeURIComponent(V.ban)}`), "…not even asked for by its address").toEqual([]);
    });
  }

  for (const key of ["sa", "raw"]) {
    test(`CONTROL — ${key === "sa" ? "the superadmin" : "a role holding the raw logs"} reads every value`, async () => {
      const rows = await rowsOf(key);
      const text = JSON.stringify(rows);
      for (const v of SECRET()) expect(text, `${key}: ${v} is shown`).toContain(v);
      expect(rows.some(r => r.event_type === "ip_ban_alert_raised"), "the address-block alert is listed").toBe(true);
      expect(text).not.toContain("withheld_fields");
    });
  }
});
