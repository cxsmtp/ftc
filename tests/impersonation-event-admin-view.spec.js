"use strict";

// v8.12.1 — IMPERSONATING AN EVENT ADMIN IN THEIR ADMIN VIEW, IN A REAL BROWSER.
//
// `impersonation-event-admin-view.api.spec.js` locks what the SERVER does with
// an admin-shaped impersonation session. This file locks what the CLIENT shows
// and offers — the half nothing else can see, and the half a support engineer
// actually meets: the entry dialog's view picker, the banner naming the view,
// the organiser's panel rendered THROUGH the seat (narrowed, with the tier's
// items withheld), the in-session view switch that keeps the banner, the
// read-only tier's refusal on a real control, and the superadmin's confirm
// copy naming whose panel the write lands on.
//
// Every positive has a control. "Logs is hidden" is equally satisfied by an
// admin panel that never rendered its nav; "the decoy is absent" by a decoy
// that was never created; "the banner says read-only" by a banner that always
// does — so each is paired with the sidebar having rendered, the superadmin's
// own two-row table, and the superadmin's full-access banner respectively.
//
// Fixtures are `buildWorld()`'s own plus this file's — never the seeded
// participants. `adminLogin(page)` signs the BROWSER in as the built-in
// superadmin, which purges `world.sa` (single session), so every fixture write
// lives in `beforeAll` and the tests only read afterwards.
const { test, expect } = require("./isolated-test");
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { const H = require("./ui-admin-helpers"); await H.showAllParticipantColumns(page); await H.showAllTableColumns(page, "events", H.EVENT_ALL_COLUMNS); });
const { BASE, PARTICIPANT_PASS, freshCtx, codeLogin } = require("./helpers");
const {
  clickTab, openKebab, adminLogin, loginViaApi, filterComps, findSeededTaskRow,
  AxeBuilder, AXE_GATED_IMPACTS, narrowPeopleTable } = require("./ui-admin-helpers");
const {
  H, uniq, buildWorld, makeParticipant, makeCompetition, makeTask, assignTask, grantEventAdmin,
} = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const { TEST_DB_PATH } = require("./helpers");

test.use({ baseURL: BASE });

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

const navItem = (page, tabId) =>
  page.locator(`li:has(> [data-action='admin-tab'][data-tab-id='${tabId}'])`);

let world;
let regular;     // a REGULAR admin — the read-only tier
let sup;         // a USER-BACKED superadmin (v8.12.2 — the reveal arm needs a `users` row, so the History can name an email through a seat)
let upcoming;    // an UPCOMING event ea organises: a tag add there raises no "live" confirm
let sealed;      // v8.12.2 — a SEALED challenge WITH a hint, authored by ea and held by `mine`
let coSealed;    // v8.12.2 review — a SEALED challenge authored by a CO-ORGANISER of `mine`, so the seat (ea) does not own it
const SEALED_KEY = `SEATKEY_${uniq("k").replace(/[^a-zA-Z0-9]/g, "")}`;
const SEALED_HINT = `SEATHINT_${uniq("h").replace(/[^a-zA-Z0-9]/g, "")}`;

test.beforeAll(async () => {
  world = await buildWorld();
  regular = await makeParticipant(world.sa, world.saCsrf, "regadm");
  const r = await world.sa.post(`/api/admin/participants/${regular.id}/role`, { headers: H(world.saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote regular admin: ${r.status()} ${await r.text()}`).toBeTruthy();
  sup = await makeParticipant(world.sa, world.saCsrf, "supadm");
  const rs = await world.sa.post(`/api/admin/participants/${sup.id}/role`, { headers: H(world.saCsrf), data: { role: "superadmin" } });
  expect(rs.ok(), `promote user-backed superadmin: ${rs.status()} ${await rs.text()}`).toBeTruthy();
  upcoming = await makeCompetition(world.sa, world.saCsrf, "upcoming", {
    start_time: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
  await grantEventAdmin(world.sa, world.saCsrf, upcoming.id, world.ea.id);
  // The organiser's OWN sealed challenge (created as ea, so ea is the author),
  // in the event they organise — the one shape where a superadmin in their
  // seat is sealed out AND may reveal.
  sealed = await makeTask(world.eaApi, world.eaCsrf, "easealedui", {
    answer_sealed: 1, correct_answer: SEALED_KEY, hint: `<p>${SEALED_HINT}</p>`, explanation: "<p>SEATWHY</p>",
  });
  await assignTask(world.eaApi, world.eaCsrf, sealed.id, [world.mine.id]);
  const own = (await (await world.eaApi.get("/api/admin/tasks")).json()).find(t => t.id === sealed.id);
  expect(own && own.answer_sealed, "the fixture really is sealed").toBeTruthy();
  expect(own.hint, "…and carries its hint for the author").toContain(SEALED_HINT);
  // v8.12.2 review — a CO-ORGANISER's sealed challenge in the same event: the
  // seat (ea) may view it but not change it (owner-only), so a reveal through
  // ea's panel lifts the SEAL and leaves the OWNERSHIP rule standing.
  const co = await makeParticipant(world.sa, world.saCsrf, "coorg");
  await grantEventAdmin(world.sa, world.saCsrf, world.mine.id, co.id);
  const { api: coApi, csrf: coC0 } = await freshCtx();
  try {
    const li = await codeLogin(coApi, co.email, H(coC0));
    expect(li.ok(), `co-organiser login: ${li.status()} ${await li.text()}`).toBeTruthy();
    const coCsrf = (await (await coApi.get("/api/csrf-token")).json()).csrfToken;
    coSealed = await makeTask(coApi, coCsrf, "cosealed", {
      answer_sealed: 1, correct_answer: `CO${SEALED_KEY}`, hint: `<p>CO${SEALED_HINT}</p>`, explanation: "<p>COWHY</p>",
    });
    await assignTask(coApi, coCsrf, coSealed.id, [world.mine.id]);
  } finally { await coApi.dispose(); }
  const seen = (await (await world.eaApi.get("/api/admin/tasks")).json()).find(t => t.id === coSealed.id);
  expect(seen, "the seat can SEE the co-organiser's challenge (it is in the seat's event)").toBeTruthy();
  expect(seen.can_edit, "…and may not change it — the ownership rule the reveal must NOT be blamed for").toBe(false);
});

test.afterAll(async () => {
  try { await world?.sa.dispose(); } catch (_) {}
  try { await world?.eaApi.dispose(); } catch (_) {}
  try { await world?.zeroApi.dispose(); } catch (_) {}
});

/** Sign a user-backed admin's BROWSER in and land on a settled admin panel. */
async function adminPanelLogin(page, email, password) {
  await loginViaApi(page, email, password);
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `${email} had no live admin session: ${meR.status()} ${await meR.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().waitFor({ state: "visible", timeout: 30000 });
}

/** Open the Participants tab, narrow to one row, open its kebab. */
async function openParticipantKebab(page, email) {
  await clickTab(page, "Participants");
  await narrowPeopleTable(page, email);
  const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
  await expect.poll(async () => page.locator("#admin-participants-body tr").count(),
    { timeout: 10000, intervals: [100, 200, 400, 800] }).toBeLessThan(5);
  await row.waitFor({ state: "visible", timeout: 10000 });
  await openKebab(page, row);
  return row;
}

/**
 * Enter the organiser's ADMIN view through the real dialog. Asserts the dialog's
 * shape on the way (two radios, admin checked) because that is the affordance
 * under test, then waits for the admin shell to boot with the banner up.
 */
async function enterAdminViewViaDialog(page, email, { pickParticipant = false } = {}) {
  await openParticipantKebab(page, email);
  const item = page.locator("#kebab-portal button:has-text('Impersonate')");
  await expect(item, "the organiser's row offers Impersonate").toHaveCount(1);
  await item.click();
  const overlay = page.locator("#modal-overlay.open");
  await overlay.waitFor({ state: "visible", timeout: 5000 });
  await expect(overlay).toContainText(/Impersonate event admin/i);
  const radios = page.locator('#modal-body input[name="imp-view"]');
  await expect(radios, "an event admin target is offered BOTH views").toHaveCount(2);
  await expect(page.locator('#modal-body input[name="imp-view"][value="admin"]'), "the panel is the default").toBeChecked();
  if (pickParticipant) await page.locator('#modal-body input[name="imp-view"][value="participant"]').check();
  await page.locator("#modal-confirm-btn").click();
  const banner = page.locator("#impersonation-banner");
  await banner.waitFor({ state: "visible", timeout: 20000 });
  return banner;
}

test.describe("Entering an event admin's ADMIN view (v8.12.1)", () => {
  test("the dialog offers two views, defaults to the panel, and lands INSIDE the organiser's narrowed panel with the banner", async ({ page }) => {
    await adminLogin(page);
    // CONTROL FIRST, in the superadmin's OWN panel: the decoy is real, and both
    // events render for an unscoped actor.
    await clickTab(page, "Events");
    const own = await page.evaluate(() => (window.S?.adminCompetitionsData || []).map(c => c.id));
    expect(own, "the superadmin's own panel lists the granted event").toContain(world.mine.id);
    expect(own, "…and the decoy, which therefore exists").toContain(world.theirs.id);
    await expect(navItem(page, "admin-users-tab"), "the superadmin's own panel has Logs").toBeVisible();

    const banner = await enterAdminViewViaDialog(page, world.ea.email);
    await expect(banner).toContainText(world.ea.nickname);
    await expect(banner).toContainText(/Event Admin Panel/i);
    await expect(banner).toContainText(/full access/i);
    await expect(page.locator("#impersonation-banner [data-action='impersonation-exit']")).toBeVisible();

    // It IS the admin shell — the organiser's, not the superadmin's.
    await expect(page.locator("#admin-page")).toBeVisible();
    await expect(page.locator("#admin-panel-title")).toHaveText(/Event Admin Panel/);
    await expect(navItem(page, "admin-competitions-tab"), "the sidebar really rendered").toBeVisible();
    await expect(navItem(page, "admin-users-tab"), "Logs is withheld — the request log is not the tier's").toBeHidden();
    await expect(navItem(page, "admin-settings-tab"), "Settings is withheld — it is superadmin-only, and this seat is not").toBeHidden();
    await clickTab(page, "Events");
    await expect(page.locator("#new-competition-btn"), "+ New Event is withheld for the seat").toBeHidden();
    await expect(page.locator("#admin-comp-body")).toContainText(world.mine.name);
    await expect(page.locator("#admin-comp-body"), "the decoy is NOT listed through the seat").not.toContainText(world.theirs.name);
    const ids = await page.evaluate(() => (window.S?.adminCompetitionsData || []).map(c => c.id));
    expect(ids, "…and it never reached the client model at all").not.toContain(world.theirs.id);
    expect(ids).toContain(world.mine.id);
    const flags = await page.evaluate(() => ({ isAdmin: window.S?.isAdmin, isSuperAdmin: window.S?.isSuperAdmin, isEventAdmin: window.S?.isEventAdmin, view: window.S?.impersonation?.view }));
    expect(flags).toEqual({ isAdmin: true, isSuperAdmin: false, isEventAdmin: true, view: "admin" });

    // Impersonation cannot be nested: the row menu withholds the item WITH its reason.
    await openParticipantKebab(page, world.inMine.email);
    await expect(page.locator("#kebab-portal button:has-text('Impersonate')"), "no nested Impersonate").toHaveCount(0);
    await expect(page.locator("#kebab-portal .kebab-note"), "…and the menu says why").toContainText(/cannot be nested/i);
    await page.keyboard.press("Escape");

    // Exit restores the superadmin's own panel.
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#impersonation-banner")).toHaveCount(0);
    await expect(page.locator("body.impersonating")).toHaveCount(0);
    await expect(page.locator("#admin-panel-title")).toHaveText(/Superadmin Panel/);
    await expect(navItem(page, "admin-users-tab"), "Logs is back in the superadmin's own panel").toBeVisible();
  });

  test("a superadmin's write from the panel is confirmed with copy naming the organiser's panel, and lands attributed to the superadmin", async ({ page }) => {
    await adminLogin(page);
    await enterAdminViewViaDialog(page, world.ea.email);
    await clickTab(page, "Events");
    await filterComps(page, upcoming.name);
    const row = page.locator(`#admin-comp-body tr:has-text('${upcoming.name}')`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await row.locator("[data-action='comp-tag-add']").click();
    const tag = `seat-${uniq("t").toLowerCase().replace(/[^a-z0-9-]/g, "")}`.slice(0, 40);
    await page.locator("#comp-tag-input").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#comp-tag-input").fill(tag);
    await page.locator("#comp-tag-save-btn").click();
    // The interceptor's confirm fronts the write, and its copy says WHOSE panel.
    await expect(page.locator("#modal-overlay"), "the superadmin confirm names the organiser's panel")
      .toContainText(/Event Admin Panel.*are you sure/i, { timeout: 5000 });
    await expect(page.locator("#modal-overlay")).toContainText(/recorded against your name/i);
    await page.locator("#modal-confirm-btn").click();
    await expect(row.locator(".tag", { hasText: tag })).toBeVisible({ timeout: 10000 });
    await expect.poll(() => {
      const r = dbGet("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='tag_added' ORDER BY changed_at DESC, rowid DESC LIMIT 1", upcoming.id);
      return r ? { by: r.changed_by, ...JSON.parse(r.details || "{}") } : null;
    }, { timeout: 8000, intervals: [100, 200, 400, 800] }).toMatchObject({ by: "superadmin", tag, impersonated_by: "superadmin", acting_as: world.ea.email });
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  });

  test("the New Challenge form inside an organiser's panel withholds the seal tick WITH its reason — and the superadmin's own panel offers it (CONTROL)", async ({ page }) => {
    // v8.12.1 review — the server refuses a seal set by proxy
    // (`answer_seal_not_by_proxy`), and the first draft still offered the tick,
    // so the reason reached the operator only after the failed save (v7.14.2).
    await adminLogin(page);
    // CONTROL FIRST, on the superadmin's OWN panel: the tick is enabled and the
    // note is the ordinary explanation.
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#tf-answer-seal")).toBeEnabled();
    await expect(page.locator("#tf-seal-note")).not.toContainText(/another organiser's panel/);
    await page.locator("[data-action='close-task-form']").first().click().catch(() => {});
    await enterAdminViewViaDialog(page, world.ea.email);
    await clickTab(page, "Challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    await page.locator("#tf-answer-seal").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#tf-answer-seal"), "the tick is withheld inside a seat").toBeDisabled();
    await expect(page.locator("#tf-seal-note"), "…with the server's own reason beside it")
      .toContainText(/through another organiser's panel/);
    await expect(page.locator("#tf-seal-note")).toContainText(/leave the answer unsealed/);
    // Changing the answer type must not re-enable it (the type sync re-decides `disabled`).
    await page.locator("#tf-atype").selectOption("json");
    await expect(page.locator("#tf-answer-seal")).toBeDisabled();
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  });

  test("a REGULAR admin's seat says read-only, and a write from a real control meets the 'not allowed' modal and changes nothing", async ({ page }) => {
    await adminPanelLogin(page, regular.email, PARTICIPANT_PASS);
    const banner = await enterAdminViewViaDialog(page, world.ea.email);
    await expect(banner).toContainText(/read-only/i);
    await expect(banner).toContainText(/Event Admin Panel/i);
    await expect(page.locator("#admin-panel-title")).toHaveText(/Event Admin Panel/);
    await clickTab(page, "Events");
    await filterComps(page, upcoming.name);
    const row = page.locator(`#admin-comp-body tr:has-text('${upcoming.name}')`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    const before = (dbGet("SELECT COUNT(*) c FROM competition_tags WHERE competition_id=?", upcoming.id) || {}).c;
    await row.locator("[data-action='comp-tag-add']").click();
    await page.locator("#comp-tag-input").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#comp-tag-input").fill("ro-attempt");
    await page.locator("#comp-tag-save-btn").click();
    await expect(page.locator("#modal-overlay"), "the read-only tier meets the required modal")
      .toContainText(/not allowed in impersonation mode/i, { timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    expect(dbGet("SELECT COUNT(*) c FROM competition_tags WHERE competition_id=?", upcoming.id).c, "nothing was written").toBe(before);
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#admin-panel-title")).toHaveText(/^Admin Panel$/);
  });
});

test.describe("The sealed answer through the seat (v8.12.2)", () => {
  test("a user-backed superadmin in an organiser's ADMIN view is OFFERED the reveal on the organiser's sealed challenge, reveals it through BOTH confirms, and the History names them 'while impersonating' the organiser", async ({ page }) => {
    // The acting human's LIVE tier decides the offer — `S.isSuperAdmin` is false
    // inside a seat by construction, so an item keyed on it would never render
    // here. The API spec locks the server half; this is the affordance, the two
    // confirms a real click meets, and the record as the History dialog shows it.
    await adminPanelLogin(page, sup.email, PARTICIPANT_PASS);
    await enterAdminViewViaDialog(page, world.ea.email);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length),
      { message: "the seat's challenge model loaded", timeout: 20000 }).toBeGreaterThan(0);
    // BEFORE: sealed out through the seat — nothing of the key or hint in the page.
    expect(await page.content(), "the key is withheld through the seat before the reveal").not.toContain(SEALED_KEY);
    expect(await page.content(), "…and the hint").not.toContain(SEALED_HINT);
    const row = (await findSeededTaskRow(page, sealed.title)).first();
    await expect(row, "the organiser's sealed challenge is listed through the seat").toBeVisible({ timeout: 15000 });
    await openKebab(page, row);
    const item = page.locator("#kebab-portal button[data-action='task-reveal-sealed']");
    await expect(item, "the reveal is offered to the acting superadmin inside the seat").toHaveCount(1);
    await expect(page.locator("#kebab-portal button[data-action='task-edit']"), "…and Edit is withheld until then").toHaveCount(0);
    await item.click();

    // CONFIRM ONE — ours, from `revealSealedAnswer`, naming the seat.
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#modal-title")).toHaveText("Reveal sealed answer");
    await expect(page.locator("#modal-body"), "the copy names the view the reveal is made through").toContainText(/through .*'s view/);
    // …and names it BY VALUE: the organiser whose seat this is, never the
    // acting superadmin (`S.impersonation.admin_label` is the ACTING admin's own
    // label — the first draft named the wrong human, and a pattern-only lock
    // passed with it; pre-release review).
    await expect(page.locator("#modal-body")).toContainText(`through ${world.ea.nickname}'s view`);
    await expect(page.locator("#modal-body"), "the acting superadmin is not the seat").not.toContainText(`through ${sup.email}`);
    await expect(page.locator("#modal-confirm-btn")).toHaveText("Reveal and record");
    // The toast is recorded by an observer installed BEFORE the clicks (it
    // removes itself after four seconds, so a late assertion would race it).
    await page.evaluate(() => {
      window.__revealToasts = [];
      const st = document.getElementById("toast-stack") || (() => { const d = document.createElement("div"); d.id = "toast-stack"; document.body.appendChild(d); return d; })();
      new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) window.__revealToasts.push(n.textContent || ""); })))
        .observe(st, { childList: true });
    });
    const posted = page.waitForResponse(r => r.url().includes(`/api/admin/tasks/${sealed.id}/sealed-reveal`) && r.request().method() === "POST", { timeout: 15000 });
    await page.locator("#modal-confirm-btn").click();
    // CONFIRM TWO — the fetch interceptor's, because the reveal is a durable
    // write from a superadmin impersonation session and is deliberately NOT on
    // the write allowlist. Its copy names the organiser's panel (v8.12.1).
    await expect(page.locator("#modal-title"), "the interceptor's confirm fronts the POST").toHaveText("Impersonation mode", { timeout: 10000 });
    await expect(page.locator("#modal-overlay")).toContainText(/Event Admin Panel.*are you sure/i);
    await page.locator("#modal-confirm-btn").click();
    const res = await posted;
    expect(res.status(), `the reveal POST answered ${res.status()}`).toBe(200);
    await expect.poll(() => page.evaluate(() => (window.__revealToasts || []).join(" | ")),
      { message: "the toast reports the reveal and that it was recorded", timeout: 10000 })
      .toContain("Sealed answer and hint revealed — recorded in the challenge's history.");
    await expect.poll(() => page.evaluate(id => {
      const t = (window.adminTasksData || []).find(x => x.id === id);
      return t ? `${t.answer_revealed === true}/${t.can_edit !== false}/${typeof t.correct_answer}` : "absent";
    }, sealed.id), { message: "the reloaded row says revealed + editable + key present", timeout: 20000 }).toBe("true/true/string");

    // THE RECORD, as the History dialog renders it through the seat.
    const row2 = (await findSeededTaskRow(page, sealed.title)).first();
    await openKebab(page, row2);
    await expect(page.locator("#kebab-portal button[data-action='task-edit']"), "Edit is offered once revealed").toHaveCount(1);
    await page.locator("#kebab-portal button[data-action='task-history']").click();
    const dlg = page.locator("#hist-overlay");
    await expect(dlg).toBeVisible({ timeout: 10000 });
    const revealRow = dlg.locator("#hist-body tr").filter({ has: page.locator(".history-type-badge", { hasText: /^sealed_reveal$/ }) });
    await expect(revealRow, "one reveal record — this seat's").toHaveCount(1);
    await expect(revealRow.locator("td").nth(2), "By = the acting superadmin's own email, never the seat's").toContainText(sup.email);
    await expect(revealRow.locator("td").nth(2), "…with the seat beside it").toContainText(`through ${world.ea.email}'s view`);
    await expect(revealRow.locator("td").nth(3)).toContainText("revealed to a superadmin");
    await expect(revealRow.locator("td").nth(3), "the sentence names the impersonation").toContainText(`while impersonating ${world.ea.email}`);
    await expect(revealRow.locator("td").nth(3)).toContainText("in an impersonated organiser's panel");
    await expect(revealRow.locator("td").nth(4)).toHaveText(/^\s*Record\s*$/);
    await expect(revealRow.locator(".history-restore-btn")).toHaveCount(0);
    expect(await revealRow.innerHTML(), "field NAMES only — the record never carries the key").not.toContain(SEALED_KEY);
    // CONTROL: the ordinary version is still a version — it, not the record,
    // carries "current" — so the Record cell above is a decision, not a dialog
    // that stopped rendering actions.
    const current = dlg.locator("#hist-body tr").filter({ has: page.locator(".history-current-badge") });
    await expect(current).toHaveCount(1);
    await expect(current.locator(".history-type-badge")).not.toHaveText("sealed_reveal");
    // And the durable half agrees with the screen: recorded AS the superadmin,
    // through the seat — the same two facts the API spec pins, read off the row.
    const rec = dbGet("SELECT changed_by, details FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", sealed.id);
    expect(rec.changed_by).toBe(sup.email);
    expect(JSON.parse(rec.details || "{}")).toMatchObject({ via: "impersonated_admin_view", impersonated_by: sup.email, acting_as_id: world.ea.id });
    await dlg.locator("[data-action='history-close']").click();
    await expect(dlg).toBeHidden();
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  });
});

test.describe("The kebab's reason after a reveal through a seat that does not own the challenge (v8.12.2 review)", () => {
  test("before the reveal the note blames the SEAL and promises only the answer and hint (the seat's ownership rule still binds); after it, the note names OWNERSHIP, Edit stays withheld, and the key is on screen", async ({ page }) => {
    await adminPanelLogin(page, sup.email, PARTICIPANT_PASS);
    await enterAdminViewViaDialog(page, world.ea.email);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length),
      { message: "the seat's challenge model loaded", timeout: 20000 }).toBeGreaterThan(0);
    const row = (await findSeededTaskRow(page, coSealed.title)).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await openKebab(page, row);
    const note = page.locator("#kebab-portal .kebab-note").first();
    await expect(note, "BEFORE: the seal is the reason").toContainText("Its answer is sealed — reveal it below to see the answer and hint");
    await expect(note, "…and inside a seat it does not promise the edit the seat's ownership rule refuses").not.toContainText("and to change this challenge");
    await page.locator("#kebab-portal button[data-action='task-reveal-sealed']").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator("#modal-title")).toHaveText("Reveal sealed answer");
    // v8.12.2 second review — the confirm must not promise the edit the kebab
    // note beside it has just said the seat cannot make, and it says whose
    // rules decide instead.
    await expect(page.locator("#modal-body"), "the confirm does not promise an edit the seat's rule refuses").not.toContainText("be able to edit it");
    await expect(page.locator("#modal-body"), "…and says whose rules decide").toContainText("this organiser's own rules");
    const posted = page.waitForResponse(r => r.url().includes(`/api/admin/tasks/${coSealed.id}/sealed-reveal`) && r.request().method() === "POST", { timeout: 15000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-title")).toHaveText("Impersonation mode", { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    expect((await posted).status()).toBe(200);
    await expect.poll(() => page.evaluate(id => {
      const t = (window.adminTasksData || []).find(x => x.id === id);
      return t ? `${t.answer_revealed === true}/${t.can_edit === true}/${typeof t.correct_answer}` : "absent";
    }, coSealed.id), { message: "the reloaded row: revealed, still NOT editable (the seat's rule), key present", timeout: 20000 })
      .toBe("true/false/string");
    const row2 = (await findSeededTaskRow(page, coSealed.title)).first();
    await openKebab(page, row2);
    await expect(page.locator("#kebab-portal button[data-action='task-edit']"), "the seat still may not edit a co-organiser's challenge").toHaveCount(0);
    const note2 = page.locator("#kebab-portal .kebab-note").first();
    await expect(note2, "AFTER: the rule that binds — ownership").toContainText("Created by someone else — you can use it, not change it");
    await expect(note2, "…not the seal, which no longer binds this reader").not.toContainText("sealed");
    expect(await page.evaluate(id => (window.adminTasksData || []).find(x => x.id === id)?.correct_answer, coSealed.id),
      "and the key is now in the reader's model — the reveal did take").toBe(`CO${SEALED_KEY}`);
    await page.keyboard.press("Escape");
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  });
});

test.describe("Switching views inside the session", () => {
  test("Participant View / Admin View switch the seat's two views WITHOUT leaving impersonation, and the banner follows", async ({ page }) => {
    await adminLogin(page);
    await enterAdminViewViaDialog(page, world.ea.email);
    // Down: the admin shell's Participant View button.
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#admin-page.active"), "the admin shell is gone").toHaveCount(0);
    const banner = page.locator("#impersonation-banner");
    await expect(banner, "still impersonating").toBeVisible();
    await expect(banner).toContainText(world.ea.nickname);
    await expect(banner, "…and the banner names the view now in force").toContainText(/participant view/i);
    await expect(banner).not.toContainText(/Event Admin Panel/i);
    await expect(page.locator("#modal-overlay.open"), "no profile note is raised for the seat's own profile").toHaveCount(0);
    // The participant nav offers the way back UP (the tier flag survived the switch).
    const up = (await require("./chrome-helpers").openAccountMenu(page)).locator("[data-action='toggle-admin-view'][data-on='true']");
    await expect(up, "Admin View is offered — isEventAdmin is a tier, not a view").toBeVisible();
    const me = await (await page.request.get("/api/me")).json();
    expect(me.impersonation).toMatchObject({ active: true, view: "participant", target_role: "event_admin" });
    expect(me.isAdminView).toBe(false);
    // And back.
    await up.click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await expect(banner).toContainText(/Event Admin Panel/i);
    await expect(page.locator("#admin-panel-title")).toHaveText(/Event Admin Panel/);
    await expect(navItem(page, "admin-users-tab"), "the seat's panel is still the organiser's on the way back up").toBeHidden();
    const me2 = await (await page.request.get("/api/me")).json();
    expect(me2.impersonation).toMatchObject({ active: true, view: "admin" });
    expect(me2.isSuperAdmin, "never superadmin-shaped").toBeFalsy();
    // Exit from the participant view, the other half of the escape hatch.
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#impersonation-banner")).toHaveCount(0);
    await expect(page.locator("#admin-panel-title")).toHaveText(/Superadmin Panel/);
  });

  test("picking the participant view at entry lands in the participant shell, banner naming that view, with Admin View one click away", async ({ page }) => {
    await adminLogin(page);
    const banner = await enterAdminViewViaDialog(page, world.ea.email, { pickParticipant: true });
    await expect(banner).toContainText(/participant view/i);
    await expect(page.locator("#admin-page.active")).toHaveCount(0);
    await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 20000 });
    await expect((await require("./chrome-helpers").openAccountMenu(page)).locator("[data-action='toggle-admin-view'][data-on='true']")).toBeVisible();
    await page.keyboard.press("Escape");
    // CONTROL: a PARTICIPANT target's banner never names a view, and its dialog
    // offers no picker — the v7.14.0 shape is byte-identical for them.
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
    await openParticipantKebab(page, world.inMine.email);
    await page.locator("#kebab-portal button:has-text('Impersonate')").click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await expect(page.locator("#modal-overlay")).toContainText(/Impersonate participant/i);
    await expect(page.locator('#modal-body input[name="imp-view"]'), "no view picker for a participant").toHaveCount(0);
    await page.locator("#modal-confirm-btn").click();
    const pb = page.locator("#impersonation-banner");
    await pb.waitFor({ state: "visible", timeout: 20000 });
    await expect(pb).toContainText(world.inMine.nickname);
    await expect(pb).not.toContainText(/participant view|Event Admin Panel/i);
    await page.locator("#main-nav .nav-btn").first().waitFor({ state: "visible", timeout: 20000 });
    await expect((await require("./chrome-helpers").openAccountMenu(page)).locator("[data-action='toggle-admin-view']"), "a participant target has no view to switch to").toHaveCount(0);
  });
});

test.describe("The banner and the shell", () => {
  test("no moderate+ axe violations on the organiser's panel under the banner, and the phone drawer starts below the bar", async ({ page }) => {
    await adminLogin(page);
    await enterAdminViewViaDialog(page, world.ea.email);
    await clickTab(page, "Events");
    await page.locator("#admin-comp-body tr").first().waitFor({ state: "visible", timeout: 10000 });
    const results = await new AxeBuilder({ page }).include("#impersonation-banner").include("#admin-page").analyze();
    // `AXE_GATED_IMPACTS` is a Set — `.includes` would throw the moment a
    // violation existed, i.e. exactly when this filter has a job (v8.12.2 fix).
    const gated = results.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact));
    expect(gated, JSON.stringify(gated.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), null, 2)).toEqual([]);
    // The header sits below the bar (the v7.14.0 offset), and on a phone the
    // fixed sidebar drawer does too — the bar (z-index 9100) would otherwise
    // cover the drawer's first item. Since v8.12.6 the drawer hangs from
    // --header-bottom, which already includes the bar, rather than from a
    // `body.impersonating` rule of its own; this assertion holds either way.
    const barBottomDesktop = await page.locator("#impersonation-banner").evaluate(el => el.getBoundingClientRect().bottom);
    const headerTop = await page.locator("header").first().evaluate(el => el.getBoundingClientRect().top);
    expect(headerTop, "the sticky header is pushed fully below the bar (measured against the bar's real bottom edge, not a literal)").toBeGreaterThanOrEqual(Math.floor(barBottomDesktop));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#admin-mobile-menu-btn").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#admin-mobile-menu-btn").click();
    await expect(page.locator("#admin-sidebar")).toHaveClass(/mobile-open/, { timeout: 5000 });
    const drawerTop = await page.locator("#admin-sidebar").evaluate(el => el.getBoundingClientRect().top);
    const barBottom = await page.locator("#impersonation-banner").evaluate(el => el.getBoundingClientRect().bottom);
    expect(barBottom, "the bar is on screen and has height").toBeGreaterThan(40);
    expect(drawerTop, "the phone drawer starts below the impersonation bar").toBeGreaterThanOrEqual(Math.floor(barBottom));
  });
});
