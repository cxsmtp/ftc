// @ts-check
//
// THE CERTIFICATE DESIGN ROUTES' COMPETITOR LOCK, AND THE DESIGNER EACH ACTOR
// SEES (sweep gap #52).
//
// routes/certificate-config.js `_eventWriteDenied` asks the competitor lock on
// PUT and DELETE /api/admin/competitions/:id/certificate-config, after the 404
// and ABOVE the scope and the ended-event rule. An actor holding a row on an
// event whose "Staff can compete" switch is on may LOOK at its certificate (the
// read and the preview stay open to them) but never change it, whatever their
// tier: else a competing organiser restyles the certificate of the event they
// compete in. In the browser the event workspace's designer is read-only for
// them, with the reason; an event admin gets it read-only too, previewing and
// downloading (operator ruling, 29 Oct 2026; the route refusals for that tier
// are held by tests/certificate-config.spec.js).
//
// Every refusal has a CONTROL of the same tier: an admin enrolled nowhere,
// driven through the same door to a real success. Every refusal re-reads what
// it protects from the database (the stored layer and its History rows), since
// a 403 that had already written looks the same from the status alone.
//
// SINGLE SESSION PER USER: a browser sign-in ends that account's API session,
// so each test signs its actors in afresh and reads back through the database.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const LOCK = "competitor_cannot_edit";
const STAMP = Date.now().toString(36).toUpperCase();
const COMPETING_NOTE = "You are competing in this event — you can look at its certificate, not change it.";
const EA_NOTE = "Only an administrator can change certificate designs. You can preview and download.";

function withDb(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
/** The stored per-event layer, as text (NULL: the event inherits). */
const storedLayer = (id) => withDb(db => db.prepare("SELECT certificate_config FROM competitions WHERE id=?").get(id).certificate_config);
/** The design's History rows on the event. */
const designHistory = (id) => withDb(db => db.prepare("SELECT COUNT(*) AS n FROM competition_events WHERE competition_id=? AND event_type='certificate_config_changed'").get(id).n);

/** A fresh participant promoted to `role`; enrolled in `competeIn` AFTER the promotion (a switch-on event admits a staff row). */
async function makeTier(sa, csrf, label, role, competeIn = []) {
  const p = await makeParticipant(sa, csrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(csrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  for (const cid of competeIn) await enrol(sa, csrf, cid, [p.id]);
  return { ...p, role, label };
}

/** The ONE refusal shape every competitor door answers with. */
async function expectLocked(res, what, comp, { ended = false } = {}) {
  expect(res.status(), `${what}: expected the competitor lock (403), got ${res.status()} ${await res.text().catch(() => "")}`).toBe(403);
  const b = await res.json();
  expect(b.code, `${what}: the machine code`).toBe(LOCK);
  expect(b.competitionId, `${what}: names the event by id`).toBe(comp.id);
  expect(b.competitionName, `${what}: names the event by name`).toBe(comp.name);
  if (ended) expect(b.error, `${what}: on an ended event the remedy promises no self-removal`).not.toMatch(/remove yourself/i);
  else expect(b.error, `${what}: on a live event the remedy offers self-removal`).toMatch(/remove yourself from the event first/i);
}

/** Store `title` as the event's own design, as the built-in superadmin (who never competes). */
async function setOwnDesign(compId, title) {
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.put(`/api/admin/competitions/${compId}/certificate-config`, { headers: H(sa.csrf), data: { config: { text: { title } } } });
    expect(r.status(), `the event's own design: ${await r.text()}`).toBe(200);
  } finally { await sa.api.dispose(); }
  expect(storedLayer(compId), "PRECONDITION: the event holds its own design").toContain(title);
}

let E, G, A, SAc, A2, EA;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  const s = await apiLogin("superadmin");
  try {
    // E: live, "Staff can compete" ON. A (admin) and SAc (a user-backed
    // superadmin) hold rows in it: competitors. A2 (admin) is enrolled nowhere.
    E = await makeCompetition(s.api, s.csrf, "certlock", { staff_compete: true });
    A = await makeTier(s.api, s.csrf, "certlockadmin", "admin", [E.id]);
    SAc = await makeTier(s.api, s.csrf, "certlocksuper", "superadmin", [E.id]);
    A2 = await makeTier(s.api, s.csrf, "certlockctrl", "admin");
    // G: a plain live event an event admin organises.
    G = await makeCompetition(s.api, s.csrf, "certlockea");
    const ea = await makeParticipant(s.api, s.csrf, "certlockorg");
    await grantEventAdmin(s.api, s.csrf, G.id, ea.id);
    EA = { ...ea, role: "event_admin" };
    // PRECONDITIONS, from the server: who competes in E.
    const rows = await (await s.api.get("/api/admin/competitions")).json();
    expect(rows.find(c => c.id === E.id).staff_compete, "PRECONDITION: E lets staff compete").toBeTruthy();
    const held = withDb(db => db.prepare("SELECT user_id FROM competition_users WHERE competition_id=?").all(E.id).map(r => r.user_id));
    expect(held.sort(), "PRECONDITION: A and SAc hold rows in E, A2 none").toEqual([A.id, SAc.id].sort());
  } finally { await s.api.dispose(); }
});

test("PUT and DELETE of a competed-in event's design refuse a competing admin and a competing superadmin, and store nothing; they may still read and preview it; an admin enrolled nowhere saves and resets (CONTROL)", async () => {
  const BASE_TITLE = `LOCK BASE ${STAMP}`;
  await setOwnDesign(E.id, BASE_TITLE);
  const before = storedLayer(E.id);
  const hist = designHistory(E.id);

  for (const actor of [A, SAc]) {
    const s = await apiLogin(actor.email, PARTICIPANT_PASS);
    try {
      const me = await (await s.api.get("/api/admin/me")).json();
      expect(me.role, `PRECONDITION: ${actor.label} holds the ${actor.role} tier`).toBe(actor.role);
      // They may LOOK: the read and the preview stay open.
      const g = await s.api.get(`/api/admin/competitions/${E.id}/certificate-config`);
      expect(g.status(), `${actor.label} reads the design: ${await g.text()}`).toBe(200);
      expect((await g.json()).effective.text.title, "the event's own design").toBe(BASE_TITLE);
      const pv = await s.api.post("/api/admin/certificate-config/preview", { headers: H(s.csrf), data: { competition_id: E.id } });
      expect(pv.status(), `${actor.label} previews it`).toBe(200);
      expect(pv.headers()["content-type"]).toContain("image/png");
      // …and never change it.
      await expectLocked(await s.api.put(`/api/admin/competitions/${E.id}/certificate-config`, { headers: H(s.csrf),
        data: { config: { text: { title: `COMPETITOR ${STAMP}` } } } }), `${actor.label} PUT`, E);
      await expectLocked(await s.api.put(`/api/admin/competitions/${E.id}/certificate-config`, { headers: H(s.csrf),
        data: { config: {} } }), `${actor.label} PUT of an empty layer (a reset spelled as a save)`, E);
      await expectLocked(await s.api.delete(`/api/admin/competitions/${E.id}/certificate-config`, { headers: H(s.csrf) }), `${actor.label} DELETE`, E);
      expect(storedLayer(E.id), `${actor.label}'s refusals changed nothing stored`).toBe(before);
      expect(designHistory(E.id), `${actor.label}'s refusals wrote no History`).toBe(hist);
    } finally { await s.api.dispose(); }
  }

  // CONTROL: the same tier, enrolled nowhere, through the same doors.
  const c = await apiLogin(A2.email, PARTICIPANT_PASS);
  try {
    const put = await c.api.put(`/api/admin/competitions/${E.id}/certificate-config`, { headers: H(c.csrf),
      data: { config: { text: { title: `CONTROL ${STAMP}` } } } });
    expect(put.status(), `CONTROL: an admin enrolled nowhere saves: ${await put.text()}`).toBe(200);
    expect(storedLayer(E.id)).toContain(`CONTROL ${STAMP}`);
    expect(designHistory(E.id)).toBe(hist + 1);
    const del = await c.api.delete(`/api/admin/competitions/${E.id}/certificate-config`, { headers: H(c.csrf) });
    expect(del.status(), `CONTROL: …and resets: ${await del.text()}`).toBe(200);
    expect(storedLayer(E.id), "the reset took the event's own design away").toBeNull();
    expect(designHistory(E.id)).toBe(hist + 2);
  } finally { await c.api.dispose(); }
});

test("on an ended event the lock answers ahead of the ended-event rule: the competitor hears the lock, an admin enrolled nowhere the ended rule, and the built-in superadmin saves (CONTROLS)", async () => {
  const s = await apiLogin("superadmin");
  let X;
  try {
    X = await makeCompetition(s.api, s.csrf, "certlockend", { staff_compete: true });
    // Enrolled while live (an ended event refuses the assign), then ended.
    await enrol(s.api, s.csrf, X.id, [A.id]);
    const end = await s.api.post(`/api/admin/competitions/${X.id}/end-now`, { headers: H(s.csrf), data: {} });
    expect(end.ok(), `end the event: ${await end.text()}`).toBeTruthy();
  } finally { await s.api.dispose(); }
  const BASE_TITLE = `LOCK ENDED ${STAMP}`;
  await setOwnDesign(X.id, BASE_TITLE);
  const before = storedLayer(X.id);
  const hist = designHistory(X.id);

  const a = await apiLogin(A.email, PARTICIPANT_PASS);
  try {
    await expectLocked(await a.api.put(`/api/admin/competitions/${X.id}/certificate-config`, { headers: H(a.csrf),
      data: { config: { text: { title: `COMPETITOR ${STAMP}` } } } }), "the competitor's PUT on the ended event", X, { ended: true });
    await expectLocked(await a.api.delete(`/api/admin/competitions/${X.id}/certificate-config`, { headers: H(a.csrf) }), "the competitor's DELETE on the ended event", X, { ended: true });
  } finally { await a.api.dispose(); }
  const c = await apiLogin(A2.email, PARTICIPANT_PASS);
  try {
    for (const [m, data] of [["put", { config: { text: { title: `CONTROL ${STAMP}` } } }], ["delete", null]]) {
      const r = await c.api[m](`/api/admin/competitions/${X.id}/certificate-config`, { headers: H(c.csrf), ...(data ? { data } : {}) });
      expect(r.status(), `CONTROL: an admin enrolled nowhere ${m} on the ended event`).toBe(403);
      expect((await r.json()).code, "…hears the ended-event rule, not the lock").toBe("certificate_config_ended_locked");
    }
  } finally { await c.api.dispose(); }
  expect(storedLayer(X.id), "no refusal stored anything").toBe(before);
  expect(designHistory(X.id), "no refusal wrote History").toBe(hist);
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.put(`/api/admin/competitions/${X.id}/certificate-config`, { headers: H(sa.csrf),
      data: { config: { text: { title: `SUPER ${STAMP}` } } } });
    expect(r.status(), `CONTROL: the superadmin changes an ended event's design: ${await r.text()}`).toBe(200);
    expect(storedLayer(X.id)).toContain(`SUPER ${STAMP}`);
  } finally { await sa.api.dispose(); }
});

/** Sign `who` into a page of its own and open the event's Certificates section. */
async function openCertsAs(browser, who, comp) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await loginViaApi(page, who.email, PARTICIPANT_PASS);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 25000 });
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), comp.id),
    { timeout: 15000, message: `${who.label}'s events model holds the event` }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-event-certs-tab" }), { id: comp.id, n: comp.name });
  const design = page.locator("#ws-certs-design");
  await expect(design.locator(".cw")).toBeVisible({ timeout: 15000 });
  // PRECONDITION: the designer shows THIS event's own design, so an editor
  // would be offered the way back ("Use the platform design").
  await expect(design.locator("#cw-scope")).toHaveText("This event has its own certificate design.");
  return { ctx, page, design };
}

/** The design as `who` is offered it: read-only with `note`, or editable. */
async function expectDesigner(design, who, { readOnlyNote }) {
  const fields = design.locator(".cw-edit input, .cw-edit textarea");
  expect(await fields.count(), "PRECONDITION: the designer's fields are drawn").toBeGreaterThan(5);
  await expect(design.locator('[data-cw="download"]'), `${who}: Download preview is offered`).toBeVisible();
  if (readOnlyNote) {
    await expect(design.locator(".cw-ro-note"), `${who}: the reason, in words`).toHaveText(readOnlyNote);
    await expect(design.locator('[data-cw="save"]'), `${who}: no Save`).toHaveCount(0);
    await expect(design.locator('[data-cw="reset"]'), `${who}: no way back to the platform design`).toHaveCount(0);
    expect(await fields.evaluateAll((els) => els.every((e) => e.disabled)), `${who}: every field is read-only`).toBe(true);
  } else {
    await expect(design.locator(".cw-ro-note"), `${who}: no read-only note`).toHaveCount(0);
    await expect(design.locator('[data-cw="save"]'), `${who}: Save is offered`).toBeVisible();
    await expect(design.locator('[data-cw="reset"]'), `${who}: …and the way back`).toHaveText("Use the platform design");
    expect(await fields.evaluateAll((els) => els.every((e) => !e.disabled)), `${who}: every field is editable`).toBe(true);
  }
}

test("a competing admin sees the event's designer read-only, with the reason, and its preview; an admin enrolled nowhere is offered Save and the way back (CONTROL)", async ({ browser }) => {
  test.setTimeout(90_000);
  await setOwnDesign(E.id, `LOCK UI ${STAMP}`);
  const comp = await openCertsAs(browser, A, E);
  try {
    await expect(comp.page.locator("#ws-rec-chips .ws-chip-competing"), "PRECONDITION: the client knows A competes").toBeVisible();
    await expectDesigner(comp.design, "the competing admin", { readOnlyNote: COMPETING_NOTE });
    // They may look: the preview is drawn.
    const img = comp.design.locator("#cw-img");
    await expect(img).toBeVisible({ timeout: 20000 });
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  } finally { await comp.ctx.close(); }

  const ctl = await openCertsAs(browser, A2, E);
  try {
    await expect(ctl.page.locator("#ws-rec-chips .ws-chip-competing"), "CONTROL: A2 does not compete").toHaveCount(0);
    await expectDesigner(ctl.design, "the admin enrolled nowhere", { readOnlyNote: null });
  } finally { await ctl.ctx.close(); }
});

test("an event admin previews and downloads their event's certificate, read-only with the reason; an administrator is offered Save (CONTROL)", async ({ browser }) => {
  test.setTimeout(90_000);
  await setOwnDesign(G.id, `LOCK EA ${STAMP}`);
  const org = await openCertsAs(browser, EA, G);
  try {
    expect((await (await org.page.request.get("/api/admin/me")).json()).isEventAdmin, "PRECONDITION: the event-admin tier").toBe(true);
    await expectDesigner(org.design, "the event admin", { readOnlyNote: EA_NOTE });
    const img = org.design.locator("#cw-img");
    await expect(img, "the preview is drawn").toBeVisible({ timeout: 20000 });
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    const [dl] = await Promise.all([org.page.waitForEvent("download"), org.design.locator('[data-cw="download"]').click()]);
    const slug = G.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    expect(dl.suggestedFilename(), "the preview's file, named after the event and the certificate shown").toBe(`${slug}-gold-preview.png`);
    const bytes = require("fs").readFileSync(await dl.path());
    expect(bytes.subarray(0, 8).toString("hex"), "a PNG").toBe("89504e470d0a1a0a");
  } finally { await org.ctx.close(); }

  const ctl = await openCertsAs(browser, A2, G);
  try { await expectDesigner(ctl.design, "an administrator", { readOnlyNote: null }); }
  finally { await ctl.ctx.close(); }
});
