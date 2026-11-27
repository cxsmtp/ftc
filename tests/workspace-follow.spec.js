"use strict";

// THE EVENT WORKSPACE FOLLOWS ITS EVENT (public/js/features/event-workspace.js).
//
// The section on screen is built from the event's state, and that state moves
// without the organiser leaving the section: the clock starts and ends an event,
// an act from the ⋯ menu or a session row reloads the events model, a deletion or
// a Regenerate retires what the header showed. Each arm asserts the section's own
// content after the move (never only the header, which always followed), beside
// a control that the content was the old state's before it.
//
//   • the Overview's face (`_syncOpenSection`, on the strip's 1 s tick): upcoming
//     to live by the clock; live to ended after End now; a session row's Start now;
//   • the Settings facts and the section tabs' counts after a model reload;
//   • the Settings Look card keeps a choice not yet saved through every
//     repaint and follows the store while it holds none; a save answering
//     after the workspace moved on lands on its own event; leaving drops the
//     choice; a card that can no longer be saved turns read-only;
//   • Delete from the ⋯ menu leaves for the Events list, never a headless section;
//   • a People row's session chip opens the workspace on that event's section;
//   • Regenerate retires the join pill's revealed code, QR and copy link;
//   • the Settings card's join rule says what the join pill says;
//   • a report email's link opens a whole workspace (strip, ← Events, the pane).

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { adminLogin, loginViaApi, showAllParticipantColumns, openOverviewDetail, narrowPeopleTable, narrowEventsTable, showAllTableColumns, EVENT_ALL_COLUMNS } = require("./ui-admin-helpers");
const { H, makeParticipant, enrol, makeTask } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const STAMP = Date.now().toString(36);

async function createEvent(data) {
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: { name: `WsF ${STAMP} ${Math.random().toString(36).slice(2, 7)}`, ...data } });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()).competition;
  } finally { await sa.api.dispose(); }
}

async function openWs(page, ev, tab) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n, t }) => window.openEventWorkspace(id, n, t ? { tab: t } : {}), { id: ev.id, n: ev.name, t: tab || null });
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#admin-scope-banner")).toBeVisible({ timeout: 10000 });
}

// The page's own session, for a change made after it signed in: a second
// superadmin sign-in would end the page's (one session per principal).
async function pageApi(page) {
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  return { api: page.request, csrf };
}

// The events model is reloaded the way an act reloads it (an API change, then
// the client's own loader), with no explicit re-render of the workspace.
async function reloadModel(page) {
  await page.evaluate(() => window.loadAdminCompetitions({ keepPage: true }));
}

test("the Overview of an upcoming event becomes the live one when the clock starts it", async ({ page }) => {
  test.setTimeout(90_000);
  const startsAt = Date.now() + 14_000;
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(startsAt).toISOString(), duration_minutes: 60 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, ev);
  const ov = page.locator("#ws-overview");
  await expect(ov).toHaveAttribute("data-ov-state", "upcoming", { timeout: 10000 });
  await expect(page.locator("#ws-ov-ready"), "CONTROL: before the start the face is the checklist").toBeVisible();
  expect(Date.now(), "PRECONDITION: the Overview was open before the start").toBeLessThan(startsAt);
  // Nobody touches anything: the clock moves the event, the section follows.
  await expect(ov).toHaveAttribute("data-ov-state", "live", { timeout: 30000 });
  await expect(page.locator("#ws-ov-ready"), "the checklist has gone").toHaveCount(0);
  await expect(page.locator("#ws-ov-progress"), "the live face's Progress card is there").toBeVisible();
});

test("after End now the Overview is the ended one: no Live tag, the certificates card", async ({ page }) => {
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 120 });
  await adminLogin(page);
  await openWs(page, ev);
  const ov = page.locator("#ws-overview");
  await expect(ov).toHaveAttribute("data-ov-state", "live", { timeout: 10000 });
  await expect(page.locator("#ws-ov-certs"), "CONTROL: a live event has no certificates card").toHaveCount(0);
  // End now, then the reload the act makes; nothing re-renders the section itself.
  const sa = await pageApi(page);
  const e = await sa.api.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(sa.csrf), data: {} });
  expect(e.ok(), await e.text()).toBeTruthy();
  await reloadModel(page);
  await expect(ov).toHaveAttribute("data-ov-state", "ended", { timeout: 10000 });
  await expect(page.locator("#ws-ov-certs"), "the ended face says whether certificates went out").toBeVisible();
  await expect(page.locator("#ws-overview .ws-live-tag"), "no Live tag on an ended event").toHaveCount(0);
});

test("a rebuild of the Overview keeps the organiser search: what was typed, the caret, its results", async ({ page }) => {
  test.setTimeout(90_000);
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 120 });
  const sa0 = await apiLogin("superadmin");
  let cand;
  try { cand = await makeParticipant(sa0.api, sa0.csrf, "wsfsearch"); } finally { await sa0.api.dispose(); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, ev);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "live", { timeout: 10000 });
  await openOverviewDetail(page);
  const search = page.locator("#ws-org-search");
  await expect(search).toBeVisible({ timeout: 15000 });
  const typed = cand.email.split("@")[0];
  await search.pressSequentially(typed.slice(0, -2), { delay: 20 });
  const pick = page.locator(`#ws-org-results [data-action="ws-org-add"][data-user-id="${cand.id}"]`);
  await expect(pick, "PRECONDITION: the search found them").toBeVisible({ timeout: 15000 });
  // Another admin adds a challenge; the reload moves the face's signature.
  await page.evaluate(() => { document.getElementById("ws-ov-attn").dataset.wsfMark = "before"; });
  const sa = await pageApi(page);
  const t = await sa.api.post("/api/admin/tasks", { headers: H(sa.csrf), data: { title: `WsF task ${STAMP}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" } });
  expect(t.ok(), await t.text()).toBeTruthy();
  const tid = (await t.json()).id;
  const a = await sa.api.post(`/api/admin/tasks/${tid}/competitions`, { headers: H(sa.csrf), data: { competitionIds: [ev.id] } });
  expect(a.ok(), await a.text()).toBeTruthy();
  await reloadModel(page);
  await expect.poll(() => page.evaluate(() => document.getElementById("ws-ov-attn")?.dataset.wsfMark || "rebuilt"),
    { timeout: 15000, message: "PRECONDITION: the Overview was rebuilt" }).toBe("rebuilt");
  await expect(search, "what was typed is still there").toHaveValue(typed.slice(0, -2));
  await expect(search, "and the box still has focus").toBeFocused();
  await expect(pick, "and its results").toBeVisible();
  // Typing carries on where it was.
  await page.keyboard.type(typed.slice(-2), { delay: 20 });
  await expect(search).toHaveValue(typed);
  await expect(pick).toBeVisible({ timeout: 15000 });
});

test("a session's Start now: the row offers End now, not a second Start now", async ({ page }) => {
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 });
  const sa = await apiLogin("superadmin");
  let tsId;
  try {
    const t = await sa.api.post(`/api/admin/competitions/${ev.id}/timeslots`, { headers: H(sa.csrf), data: {
      name: "Morning", start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 60 } });
    expect(t.ok(), await t.text()).toBeTruthy();
    tsId = (await t.json()).timeslot.id;
  } finally { await sa.api.dispose(); }
  await adminLogin(page);
  await openWs(page, ev);
  const start = page.locator(`#ws-overview [data-action="ts-start-now"][data-ts-id="${tsId}"]`);
  await expect(start, "PRECONDITION: the upcoming session offers Start now").toBeVisible({ timeout: 15000 });
  await start.click();
  await expect(page.locator("#modal-overlay.open")).toBeVisible();
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator(".toast").filter({ hasText: "Morning" })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(`#ws-overview [data-action="ts-end-now"][data-ts-id="${tsId}"]`), "the started session offers End now").toBeVisible({ timeout: 10000 });
  await expect(page.locator(`#ws-overview [data-action="ts-start-now"][data-ts-id="${tsId}"]`), "and never Start now again").toHaveCount(0);
  await expect(page.locator(`#ws-overview [data-action="ws-ts-edit"][data-ts-id="${tsId}"]`), "nor edit for a started session").toHaveCount(0);
});

test("Settings and the section tabs' counts follow a reload of the events model", async ({ page }) => {
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 120 });
  await adminLogin(page);
  await openWs(page, ev, "admin-event-settings-tab");
  const facts = page.locator("#ws-settings .ws-kvs");
  await expect(facts, "CONTROL: no cap yet").toContainText("Unlimited", { timeout: 10000 });
  const count = page.locator("#ws-count-participants");
  await expect(count, "CONTROL: nobody has joined").toHaveText("0");
  // Somebody caps the attempts and enrols someone.
  const sa = await pageApi(page);
  const row = (await (await sa.api.get("/api/admin/competitions")).json()).find(c => c.id === ev.id);
  const put = await sa.api.put(`/api/admin/competitions/${ev.id}`, { headers: H(sa.csrf), data: { attempt_cap: 3, expectedUpdatedAt: row.updated_at } });
  expect(put.ok(), await put.text()).toBeTruthy();
  const p = await makeParticipant(sa.api, sa.csrf, "wsfcount");
  await enrol(sa.api, sa.csrf, ev.id, [p.id]);
  await reloadModel(page);
  await expect(page.locator("#ws-settings .ws-kv").filter({ hasText: "Attempts per challenge" }), "the Settings facts follow").toContainText("3", { timeout: 10000 });
  await expect(count, "the Participants tab's count follows").toHaveText("1", { timeout: 10000 });
});

// ── THE SETTINGS LOOK CARD KEEPS A CHOICE NOT YET SAVED ─────────────────────
// The Settings section is repainted whenever what it shows changes (the strip's
// 1 s tick, a reload of the events model). Its Look card holds a form: a
// repaint that put the stored look back under the person's Save would have
// Save store the old look and say "saved" (main CI, 24 Nov 2026: the second
// Save look of tests/admin-doors-pressed.spec.js stored the first one's look).
// The card follows the store, in place, only while it holds no such choice.
const LIVE = () => ({ event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 120 });

function lookCard(page, sa, ev) {
  const look = page.locator("#ev-look"), lock = page.locator("#ev-look-lock"), save = page.locator('[data-action="event-look-save"]');
  const stored = async (id = ev.id) => { const c = (await (await sa.api.get("/api/admin/competitions")).json()).find((x) => x.id === id); return { look: c.event_look || "", locked: !!c.event_look_locked }; };
  const putLook = async (data, id = ev.id) => { const r = await sa.api.put(`/api/admin/competitions/${id}/look`, { headers: H(sa.csrf), data }); expect(r.ok(), await r.text()).toBeTruthy(); };
  const toast = (text) => page.locator("#toast-stack .toast").filter({ hasText: text });
  const clearToasts = () => page.evaluate(() => document.querySelectorAll("#toast-stack .toast").forEach((t) => t.remove()));
  const modelLook = (id = ev.id) => page.evaluate((cid) => (window.adminCompetitionsData || []).find((c) => c.id === cid)?.event_look || "", id);
  const flush = () => page.evaluate(() => window.wsFlushHeldRecord());
  // The 15 s events poll stopped: every read of the model is then the test's own.
  const stopPoll = () => page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  // Save look, then its answer.
  const saveAnd = async (text) => {
    await clearToasts();
    await save.click();
    await expect(toast(text), `PRECONDITION: the save answered "${text}"`).toHaveCount(1, { timeout: 10000 });
  };
  // Another organiser's save, then the events model reloaded as the poll would.
  const otherSaves = async (data, id = ev.id) => {
    await putLook(data, id);
    await reloadModel(page);
    await expect.poll(() => modelLook(id), { message: "PRECONDITION: the model holds the other organiser's save" }).toBe(data.look);
    await flush();
  };
  // Hold an event's look PUTs once the server has answered each; `gates[i]()`
  // lets the i-th answer through.
  const holdSaves = async (id = ev.id) => {
    const gates = [];
    const url = `**/api/admin/competitions/${id}/look`;
    const handler = async (route) => {
      const resp = await route.fetch();
      let go;
      const gate = new Promise((r) => { go = r; });
      gates.push(go);
      await gate;
      await route.fulfill({ response: resp });
    };
    await page.route(url, handler);
    return { gates, sent: (n) => expect.poll(() => gates.length, { message: `PRECONDITION: save ${n} reached the server` }).toBe(n), done: () => page.unroute(url, handler) };
  };
  return { look, lock, save, stored, putLook, toast, clearToasts, modelLook, flush, stopPoll, saveAnd, otherSaves, holdSaves };
}

test("Settings keeps a look choice not yet saved through every repaint, and follows the store while it holds none", async ({ page }) => {
  test.setTimeout(90_000);
  const ev = await createEvent(LIVE());
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, ev, "admin-event-settings-tab");
  const sa = await pageApi(page);
  const L = lookCard(page, sa, ev);
  await L.stopPoll();
  await expect(L.look, "CONTROL: the event starts on the platform look").toHaveValue("", { timeout: 10000 });

  // 1. Saved; then a choice not yet saved while the facts change under it.
  await L.look.selectOption("signature");
  await L.lock.check();
  await L.saveAnd("Event look saved.");
  expect(await L.stored(), "PRECONDITION: stored, locked").toEqual({ look: "signature", locked: true });
  await L.look.selectOption("");
  const row = (await (await sa.api.get("/api/admin/competitions")).json()).find((c) => c.id === ev.id);
  const put = await sa.api.put(`/api/admin/competitions/${ev.id}`, { headers: H(sa.csrf), data: { attempt_cap: 4, expectedUpdatedAt: row.updated_at } });
  expect(put.ok(), await put.text()).toBeTruthy();
  await reloadModel(page);
  await expect(page.locator("#ws-settings .ws-kv").filter({ hasText: "Attempts per challenge" }), "PRECONDITION: the facts were repainted").toContainText("4", { timeout: 10000 });
  await expect(L.look, "the choice not yet saved is still on screen").toHaveValue("");
  await L.saveAnd("Event look removed");
  expect(await L.stored(), "Save look stored what the person chose").toEqual({ look: "", locked: false });
  await expect(L.lock, "the form shows what is stored: no lock without a look").not.toBeChecked();

  // 2. CONTROL: once saved, the form holds no choice. Its controls stay in
  // place and follow another organiser's save, back to the look the card was
  // first drawn with too.
  await L.look.selectOption("ambient");
  await page.evaluate(() => { window.__savedLookSelect = document.getElementById("ev-look"); });
  await L.saveAnd("Event look saved.");
  expect(await page.evaluate(() => { window.wsFlushHeldRecord(); return document.getElementById("ev-look") === window.__savedLookSelect; }), "the saved form is not redrawn (an open list would close)").toBe(true);
  await L.otherSaves({ look: "", locked: false });
  await expect(L.look, "another organiser's save shows").toHaveValue("");
  expect(await page.evaluate(() => document.getElementById("ev-look") === window.__savedLookSelect), "in the same controls").toBe(true);

  // 3. A choice another organiser then saves is no longer a choice: going back
  // to the look before it is one.
  await L.look.selectOption("signature");
  await L.otherSaves({ look: "signature", locked: false });
  await L.look.selectOption("");
  await L.flush();
  await expect(L.look, "the switch back stays on screen").toHaveValue("");
  await L.saveAnd("Event look removed");
  expect(await L.stored(), "and Save stores it").toEqual({ look: "", locked: false });

  // 4. A choice not yet saved outlives another organiser's save; Save stores it.
  await L.look.selectOption("ambient");
  await L.otherSaves({ look: "signature", locked: false });
  await expect(L.look, "a repaint never puts the stored look back over the choice").toHaveValue("ambient");
  await L.saveAnd("Event look saved.");
  expect(await L.stored(), "the choice is stored").toEqual({ look: "ambient", locked: false });
  // A tick of the lock alone is a choice too.
  await L.lock.check();
  await L.otherSaves({ look: "", locked: false });
  await expect(L.look, "the look on screen stays").toHaveValue("ambient");
  await expect(L.lock, "and so does the lock just ticked").toBeChecked();
  await L.saveAnd("Event look saved.");
  expect(await L.stored(), "both are stored").toEqual({ look: "ambient", locked: true });

  // 5. While a save is on its way the form is left as the person has it: a read
  // of the model meanwhile (which already holds the save) does not move a
  // switch back to the look stored before, and once the save answers that
  // switch is a choice not yet saved.
  const h = await L.holdSaves();
  await L.clearToasts();
  await L.look.selectOption("signature");
  await L.save.click();
  await h.sent(1);
  await L.look.selectOption("ambient");
  await reloadModel(page);
  await expect.poll(L.modelLook, { message: "PRECONDITION: the model already holds the save" }).toBe("signature");
  await L.flush();
  await expect(L.look, "the switch back is left on screen while the save is on its way").toHaveValue("ambient");
  h.gates[0]();
  await expect(L.toast("Event look saved."), "PRECONDITION: the held save answered").toHaveCount(1, { timeout: 10000 });
  await h.done();
  expect(await L.stored(), "PRECONDITION: the save stored what it sent").toEqual({ look: "signature", locked: true });
  await L.flush();
  await expect(L.look, "and stays, a choice not yet saved, once the save answered").toHaveValue("ambient");
  await L.saveAnd("Event look saved.");
  expect(await L.stored(), "Save stores it").toEqual({ look: "ambient", locked: true });

  // 6. A read of the events model sent before a save answers after it: its
  // answer never puts the old look back.
  const isList = (url) => url.pathname === "/api/admin/competitions";
  let readSeen, readGo;
  const readSent = new Promise((r) => { readSeen = r; }), readGate = new Promise((r) => { readGo = r; });
  const readHandler = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resp = await route.fetch();
    readSeen();
    await readGate;
    await route.fulfill({ response: resp });
  };
  await page.route(isList, readHandler);
  await page.evaluate(() => { window.__heldEventsRead = window.loadAdminCompetitions({ keepPage: true }); });
  await readSent;
  await L.look.selectOption("signature");
  await L.saveAnd("Event look saved.");
  readGo();
  await page.evaluate(() => window.__heldEventsRead);
  await page.unroute(isList, readHandler);
  expect(await L.modelLook(), "the model keeps the look just saved").toBe("signature");
  await L.flush();
  await expect(L.look, "and so does the card").toHaveValue("signature");

  // 7. A save that fails says so, keeps the choice on screen, and leaves the
  // form following the store again.
  await page.route(`**/api/admin/competitions/${ev.id}/look`, (route) => route.abort(), { times: 1 });
  await L.look.selectOption("ambient");
  await L.saveAnd("Could not save the event look.");
  await expect(L.look, "the choice stays on screen").toHaveValue("ambient");
  expect(await L.stored(), "nothing was stored").toEqual({ look: "signature", locked: true });
  await L.look.selectOption("signature");
  await L.otherSaves({ look: "", locked: false });
  await expect(L.look, "holding no choice again, the form follows the store").toHaveValue("");
});

test("a look save's answer lands only where it applies: not on another event's form, on a form drawn afresh, not after a newer save's, nor hidden by a newer save that failed; leaving drops a choice not yet saved", async ({ page }) => {
  test.setTimeout(90_000);
  const a = await createEvent(LIVE()), b = await createEvent(LIVE());
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, a, "admin-event-settings-tab");
  const sa = await pageApi(page);
  const L = lookCard(page, sa, a);
  await L.stopPoll();
  await expect(L.look, "CONTROL: A starts on the platform look").toHaveValue("", { timeout: 10000 });

  // 1. A's save answers while B's Settings is on screen: B's form is untouched.
  let h = await L.holdSaves(a.id);
  await L.clearToasts();
  await L.look.selectOption("signature");
  await L.save.click();
  await h.sent(1);
  await openWs(page, b, "admin-event-settings-tab");
  await expect(L.save, "PRECONDITION: B's Look card is on screen").toHaveAttribute("data-comp-id", b.id, { timeout: 10000 });
  // Every write to B's form, from now on: the next tick would hide a wrong one.
  await page.evaluate(() => {
    window.__bLookWrites = [];
    const mo = new MutationObserver((recs) => recs.forEach((r) => window.__bLookWrites.push(`${r.target.id} ${r.attributeName}`)));
    mo.observe(document.getElementById("ev-look"), { attributes: true });
    mo.observe(document.getElementById("ev-look-lock"), { attributes: true });
    window.__bLookObserver = mo;
  });
  h.gates[0]();
  await expect(L.toast("Event look saved."), "PRECONDITION: A's save answered").toHaveCount(1, { timeout: 10000 });
  await h.done();
  expect(await L.stored(a.id), "PRECONDITION: A's look is stored").toEqual({ look: "signature", locked: false });
  await L.flush();
  expect(await page.evaluate(() => { window.__bLookObserver.disconnect(); return window.__bLookWrites; }), "nothing was written to B's form").toEqual([]);
  await expect(L.look, "B's form still shows B's look").toHaveValue("");

  // 2. A's save answers after the person went to B and back: the A card drawn
  // afresh meanwhile shows what the save stored, and holds no phantom choice.
  await openWs(page, a, "admin-event-settings-tab");
  await expect(L.look, "PRECONDITION: A's card shows its stored look").toHaveValue("signature", { timeout: 10000 });
  h = await L.holdSaves(a.id);
  await L.clearToasts();
  await L.look.selectOption("ambient");
  await L.save.click();
  await h.sent(1);
  await openWs(page, b, "admin-event-settings-tab");
  await expect(L.save, "PRECONDITION: B's Look card is on screen").toHaveAttribute("data-comp-id", b.id, { timeout: 10000 });
  await openWs(page, a, "admin-event-settings-tab");
  await expect(L.save, "PRECONDITION: A's card is drawn afresh").toHaveAttribute("data-comp-id", a.id, { timeout: 10000 });
  await expect(L.look, "PRECONDITION: from the model, before the save answered").toHaveValue("signature");
  h.gates[0]();
  await expect(L.toast("Event look saved."), "PRECONDITION: the save answered").toHaveCount(1, { timeout: 10000 });
  await h.done();
  await expect(L.look, "the fresh card shows what the save stored").toHaveValue("ambient");
  await L.otherSaves({ look: "signature", locked: false }, a.id);
  await expect(L.look, "and, holding no choice, follows the store").toHaveValue("signature");

  // 3. Two saves on their way at once, the older answering last: its answer is
  // not applied over the newer one's.
  h = await L.holdSaves(a.id);
  await L.clearToasts();
  await L.look.selectOption("ambient");
  await L.save.click();
  await h.sent(1);
  await L.look.selectOption("");
  await L.save.click();
  await h.sent(2);
  expect(await L.stored(a.id), "PRECONDITION: the server stored them in turn").toEqual({ look: "", locked: false });
  h.gates[1]();
  await expect(L.toast("Event look removed"), "PRECONDITION: the newer save answered").toHaveCount(1, { timeout: 10000 });
  h.gates[0]();
  await expect(L.toast("Event look saved."), "PRECONDITION: the older save answered").toHaveCount(1, { timeout: 10000 });
  await h.done();
  expect(await L.modelLook(a.id), "the model keeps the newer save's look").toBe("");
  await L.flush();
  await expect(L.look, "and so does the card").toHaveValue("");
  await L.otherSaves({ look: "signature", locked: false }, a.id);
  await expect(L.look, "which holds no phantom choice: it follows the next save").toHaveValue("signature");

  // 4. Two saves on their way, the newer one failing: the older one's answer,
  // the last the server confirmed, is applied, so going back to the look stored
  // before both is a choice the next read leaves alone.
  {
    const gates = [];
    let n = 0;
    const url = `**/api/admin/competitions/${a.id}/look`;
    const handler = async (route) => {
      if (++n === 2) return route.abort();
      const resp = await route.fetch();
      let go;
      const gate = new Promise((r) => { go = r; });
      gates.push(go);
      await gate;
      await route.fulfill({ response: resp });
    };
    await page.route(url, handler);
    await L.clearToasts();
    await L.look.selectOption("ambient");
    await L.save.click();
    await expect.poll(() => gates.length, { message: "PRECONDITION: the older save reached the server" }).toBe(1);
    await L.look.selectOption("");
    await L.save.click();
    await expect(L.toast("Could not save the event look."), "PRECONDITION: the newer save failed").toHaveCount(1, { timeout: 10000 });
    gates[0]();
    await expect(L.toast("Event look saved."), "PRECONDITION: the older save answered").toHaveCount(1, { timeout: 10000 });
    await page.unroute(url, handler);
  }
  expect(await L.stored(a.id), "PRECONDITION: the older save is what the server stored").toEqual({ look: "ambient", locked: false });
  expect(await L.modelLook(a.id), "the model holds the older save's look").toBe("ambient");
  await L.flush();
  await expect(L.look, "the choice made since stays on screen").toHaveValue("");
  await L.look.selectOption("signature");
  await reloadModel(page);
  await L.flush();
  await expect(L.look, "and going back to the look stored before both saves is a choice too").toHaveValue("signature");
  await L.saveAnd("Event look saved.");
  expect(await L.stored(a.id), "which Save stores").toEqual({ look: "signature", locked: false });

  // 5. Leaving the workspace drops a choice not yet saved: the next visit draws
  // the card from the store, here unchanged since the card was last drawn.
  await L.look.selectOption("");
  await page.evaluate(() => window.closeEventWorkspace());
  await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId), { message: "PRECONDITION: the workspace is closed" }).toBeFalsy();
  await openWs(page, a, "admin-event-settings-tab");
  await expect(L.look, "the next visit shows the stored look").toHaveValue("signature", { timeout: 10000 });

  // 6. A stored look this browser does not list (left by a rollback; no route
  // stores one) shows as the platform look with no lock, and the card still
  // follows the store.
  const db = new Database(TEST_DB_PATH);
  try { db.prepare("UPDATE competitions SET event_look='hyperscreen', event_look_locked=1 WHERE id=?").run(a.id); } finally { db.close(); }
  await reloadModel(page);
  await expect.poll(() => L.modelLook(a.id), { message: "PRECONDITION: the model holds the unlisted look" }).toBe("hyperscreen");
  await L.flush();
  await expect(L.look, "it shows as the platform look").toHaveValue("");
  await expect(L.lock, "with no lock").not.toBeChecked();
  // (Another look than the one stored before the direct write: the server's
  // 1 s event cache may still hold that row, and the route stores no non-change.)
  await L.otherSaves({ look: "ambient", locked: false }, a.id);
  await expect(L.look, "and follows the next save").toHaveValue("ambient");
});

test("a look choice not yet saved gives way when the event ends for a regular admin: the card turns read-only", async ({ page }) => {
  test.setTimeout(90_000);
  const sa0 = await apiLogin("superadmin");
  let adm;
  try {
    adm = await makeParticipant(sa0.api, sa0.csrf, "wsflookadm");
    const pr = await sa0.api.post(`/api/admin/participants/${adm.id}/role`, { headers: H(sa0.csrf), data: { role: "admin" } });
    expect(pr.ok(), await pr.text()).toBeTruthy();
  } finally { await sa0.api.dispose(); }
  const ev = await createEvent(LIVE());
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginViaApi(page, adm.email, PARTICIPANT_PASS);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  await openWs(page, ev, "admin-event-settings-tab");
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  const look = page.locator("#ev-look");
  await expect(look, "PRECONDITION: a live event's look is theirs to change").toHaveCount(1, { timeout: 10000 });
  await look.selectOption("signature");
  // Another organiser ends the event.
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(sa.csrf), data: {} });
    expect(r.ok(), await r.text()).toBeTruthy();
  } finally { await sa.api.dispose(); }
  await reloadModel(page);
  await expect(page.locator("#admin-event-settings-tab"), "the card says why").toContainText("Only a superadmin can change an event that has ended.", { timeout: 10000 });
  await expect(look, "the form that can no longer be saved is gone, choice and all").toHaveCount(0);
  await expect(page.locator('[data-action="event-look-save"]')).toHaveCount(0);
});

test("Delete from the ⋯ menu leaves for the Events list, never a section with no header", async ({ page }) => {
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
  await adminLogin(page);
  await openWs(page, ev);
  await expect(page.locator("#admin-event-overview-tab"), "PRECONDITION: the Overview is on screen").toBeVisible();
  await page.locator("#ws-quick .ws-more-btn").click();
  await page.locator('[data-action="comp-delete"]').filter({ visible: true }).click();
  await expect(page.locator("#modal-overlay.open")).toBeVisible();
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator(".toast").filter({ hasText: "Event deleted." })).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#admin-competitions-tab"), "the Events list is shown").toBeVisible({ timeout: 10000 });
  await expect(page.locator("#admin-event-overview-tab"), "the deleted event's Overview is gone").toBeHidden();
  await expect(page.locator("#admin-workspace"), "and its header with it").toBeHidden();
  await expect(page.locator('.admin-nav-item[data-tab-id="admin-competitions-tab"]'), "the sidebar says Events").toHaveAttribute("aria-current", "page");
});

test("a People row's session chip opens that event's workspace on its Participants section", async ({ page }) => {
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 });
  const sa = await apiLogin("superadmin");
  let p, tsId;
  try {
    const t = await sa.api.post(`/api/admin/competitions/${ev.id}/timeslots`, { headers: H(sa.csrf), data: {
      name: "Slot A", start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 60 } });
    expect(t.ok(), await t.text()).toBeTruthy();
    tsId = (await t.json()).timeslot.id;
    p = await makeParticipant(sa.api, sa.csrf, "wsfchip");
    await enrol(sa.api, sa.csrf, ev.id, [p.id]);
  } finally { await sa.api.dispose(); }
  // The participant picks the session, so their People row names it.
  const me = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    expect((await me.api.post("/api/select-competition", { headers: H(me.csrf), data: { competitionId: ev.id } })).ok()).toBeTruthy();
    const pick = await me.api.post("/api/select-timeslot", { headers: H(me.csrf), data: { timeslotId: tsId } });
    expect(pick.ok(), await pick.text()).toBeTruthy();
  } finally { await me.api.dispose(); }
  await showAllParticipantColumns(page);   // the session chip sits in the Events column
  await adminLogin(page);
  await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
  await narrowPeopleTable(page, p.nickname);
  const chip = page.locator(`#admin-participants-tab [data-action="comp-focus-ts"][data-ts-id="${tsId}"]`);
  await expect(chip, "PRECONDITION: the row names the session").toBeVisible({ timeout: 15000 });
  await chip.click();
  await expect(page.locator("#admin-workspace"), "the workspace opens").toBeVisible({ timeout: 10000 });
  await expect(page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]'), "on its Participants section").toHaveAttribute("aria-current", "page");
  await expect(page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]'), "the sidebar no longer claims the cross-event page").not.toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => [window.adminSelectedCompetitionId, window.adminSelectedTimeslotId]), "narrowed to that session").toEqual([ev.id, tsId]);
});

// Sweep #248 — a session chip that opens ANOTHER event opens it the way opening
// the event itself does: the workspace's Participants list holds its own people
// (an earlier "Search everyone on the platform" tick does not carry over) and the
// Challenges list starts from page 1. Narrowing to a session of the event already
// open keeps the tick, as a session narrows neither list (the boundary test).
async function arrange248(label) {
  const when = { event_kind: "tournament", start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 };
  const A = await createEvent(when), B = await createEvent(when);
  const sa = await apiLogin("superadmin");
  let p, q, tsId;
  try {
    const t = await sa.api.post(`/api/admin/competitions/${B.id}/timeslots`, { headers: H(sa.csrf), data: {
      name: "Slot A", start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 60 } });
    expect(t.ok(), await t.text()).toBeTruthy();
    tsId = (await t.json()).timeslot.id;
    p = await makeParticipant(sa.api, sa.csrf, `${label}p`);
    q = await makeParticipant(sa.api, sa.csrf, `${label}q`);   // in no event
    // Enough challenges that page 3 exists at two a page (staleState), so the
    // list's own clamp cannot reset the page for the build under test.
    for (let i = 0; i < 6; i++) await makeTask(sa.api, sa.csrf, `${label}t${i}`);
    await enrol(sa.api, sa.csrf, B.id, [p.id]);
  } finally { await sa.api.dispose(); }
  const me = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    expect((await me.api.post("/api/select-competition", { headers: H(me.csrf), data: { competitionId: B.id } })).ok()).toBeTruthy();
    const pick = await me.api.post("/api/select-timeslot", { headers: H(me.csrf), data: { timeslotId: tsId } });
    expect(pick.ok(), await pick.text()).toBeTruthy();
  } finally { await me.api.dispose(); }
  return { A, B, p, q, tsId };
}
// Event A's Participants with "Search everyone" ticked, then left; the
// Challenges list paged on an earlier visit. Both outlive leaving the workspace.
async function staleState(page, A) {
  await openWs(page, A, "admin-participants-tab");
  const tick = page.locator("#p-ws-scope:not([hidden]) #p-ws-everyone");
  await tick.check();
  await expect(tick, "PRECONDITION: the tick took").toBeChecked();
  await page.locator('#admin-scope-banner [data-action="scope-clear"]').click();
  await expect(page.locator("#admin-workspace")).toBeHidden({ timeout: 10000 });
  await page.evaluate(() => { window.tPageSize = 2; window.tPage = 3; });
  expect(await page.evaluate(() => [window.pWsShowEveryone, window.tPage]), "PRECONDITION: the tick and the page outlive leaving").toEqual([true, 3]);
}
const rowOf = (page, who) => page.locator("#admin-participants-body tr", { hasText: who.email });

test("sweep #248: a People row's session chip opens ANOTHER event with its own people only and Challenges from page 1", async ({ page }) => {
  const { A, B, p, q, tsId } = await arrange248("wsf248");
  await showAllParticipantColumns(page);   // the session chip sits in the Events column
  await adminLogin(page);
  await staleState(page, A);
  await page.locator('.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
  await narrowPeopleTable(page, p.nickname);
  const chip = page.locator(`#admin-participants-tab [data-action="comp-focus-ts"][data-ts-id="${tsId}"]`);
  await expect(chip, "PRECONDITION: the row names the session").toBeVisible({ timeout: 15000 });
  await chip.click();
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]')).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => [window.adminSelectedCompetitionId, window.adminSelectedTimeslotId])).toEqual([B.id, tsId]);
  // Once the Challenges list has loaded and rendered (its clamp ran), at two a page.
  await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 10000 }).toBeGreaterThanOrEqual(6);
  expect(await page.evaluate(() => Math.ceil((window.adminTasksData || []).length / window.tPageSize)), "PRECONDITION: page 3 exists").toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => [window.pWsShowEveryone, window.tPage]), "opened as the event itself opens").toEqual([false, 1]);
  await expect(page.locator("#p-ws-everyone")).not.toBeChecked();
  await narrowPeopleTable(page, q.nickname);
  await expect(rowOf(page, q), "someone in no event is not listed").toHaveCount(0);
  await narrowPeopleTable(page, p.nickname);
  await expect(rowOf(page, p), "CONTROL: the event's own member is").toHaveCount(1);
});

test("sweep #248: an Events row's session chip opens ANOTHER event the same way", async ({ page }) => {
  const { A, B, q, tsId } = await arrange248("wsf248e");
  await showAllTableColumns(page, "events", EVENT_ALL_COLUMNS);   // the session chips sit in the Sessions column
  await adminLogin(page);
  await staleState(page, A);
  await expect(page.locator('.admin-nav-item[data-tab-id="admin-competitions-tab"]'), "PRECONDITION: back on the Events list").toHaveAttribute("aria-current", "page");
  await narrowEventsTable(page, B.name);
  const chip = page.locator(`#admin-comp-body [data-action="comp-open-ts"][data-ts-id="${tsId}"]`).first();
  await expect(chip, "PRECONDITION: the row names the session").toBeVisible({ timeout: 15000 });
  await chip.click();
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => [window.adminSelectedCompetitionId, window.adminSelectedTimeslotId])).toEqual([B.id, tsId]);
  // Once the Challenges list has loaded and rendered (its clamp ran), at two a page.
  await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), { timeout: 10000 }).toBeGreaterThanOrEqual(6);
  expect(await page.evaluate(() => Math.ceil((window.adminTasksData || []).length / window.tPageSize)), "PRECONDITION: page 3 exists").toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => [window.pWsShowEveryone, window.tPage]), "opened as the event itself opens").toEqual([false, 1]);
  await page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]').click();
  await expect(page.locator("#p-ws-everyone")).not.toBeChecked();
  await narrowPeopleTable(page, q.nickname);
  await expect(rowOf(page, q), "someone in no event is not listed").toHaveCount(0);
});

test("sweep #248: opening ANOTHER event's workspace opens it with its own people only", async ({ page }) => {
  // The ordinary door (openEventWorkspace → setAdminCompetitionScope), not a
  // session chip: the chip's own reset would hide a lost one here.
  const { A, B, p, q } = await arrange248("wsf248o");
  await adminLogin(page);
  await staleState(page, A);
  await openWs(page, B, "admin-participants-tab");
  expect(await page.evaluate(() => [window.adminSelectedCompetitionId, window.adminSelectedTimeslotId])).toEqual([B.id, null]);
  expect(await page.evaluate(() => window.pWsShowEveryone), "the tick does not carry over").toBe(false);
  await expect(page.locator("#p-ws-everyone")).not.toBeChecked();
  await narrowPeopleTable(page, q.nickname);
  await expect(rowOf(page, q), "someone in no event is not listed").toHaveCount(0);
  await narrowPeopleTable(page, p.nickname);
  await expect(rowOf(page, p), "CONTROL: the event's own member is").toHaveCount(1);
});

test("sweep #248 CONTROL: narrowing to a session of the event already open keeps Search everyone", async ({ page }) => {
  const { B, q, tsId } = await arrange248("wsf248c");
  await adminLogin(page);
  await openWs(page, B, "admin-participants-tab");
  const tick = page.locator("#p-ws-scope:not([hidden]) #p-ws-everyone");
  await tick.check();
  await narrowPeopleTable(page, q.nickname);
  await expect(rowOf(page, q), "PRECONDITION: the tick widened the list").toHaveCount(1);
  await page.locator(`#admin-scope-banner [data-action="comp-focus-ts"][data-ts-id="${tsId}"]`).click();
  await expect.poll(() => page.evaluate(() => window.adminSelectedTimeslotId)).toBe(tsId);
  await expect(page.locator('#ws-tabs .ws-tab[data-section="admin-participants-tab"]'), "still on Participants").toHaveAttribute("aria-current", "page");
  await expect(page.locator("#p-ws-everyone"), "the tick stays").toBeChecked();
  await narrowPeopleTable(page, q.nickname);
  await expect(rowOf(page, q), "and the list stays wide").toHaveCount(1);
});

test("Regenerate retires the revealed code: the pill, its popover and the full-screen QR take the new one", async ({ page }) => {
  const ev = await createEvent({ event_kind: "booth", self_enroll_enabled: true, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openWs(page, ev);
  await page.locator('#ws-join [data-action="ws-join-reveal"]').click();
  const pill = page.locator('#ws-join [data-action="ws-join-toggle"]');
  await expect(pill).toBeVisible({ timeout: 10000 });
  const oldCode = (await page.locator("#ws-join-pop .ws-jcode").textContent()).trim();
  expect(oldCode.length, "PRECONDITION: a code was revealed").toBeGreaterThan(3);
  // Join-link settings → Regenerate → Close.
  await page.locator('#ws-join-pop [data-action="comp-self-enroll"]').click();
  await expect(page.locator("#self-enroll-overlay")).toBeVisible({ timeout: 10000 });
  await page.locator('#self-enroll-overlay [data-action="self-enroll-regenerate"]').click();
  await expect(page.locator("#modal-overlay.open")).toBeVisible();
  await page.locator("#modal-confirm-btn").click();
  const codeEl = page.locator("#self-enroll-overlay #self-enroll-code");
  await expect(codeEl, "the dialog shows a new code").not.toHaveText(oldCode, { timeout: 10000 });
  const newCode = (await codeEl.textContent()).trim();
  const newUrl = await page.locator("#self-enroll-overlay #self-enroll-input").inputValue();
  await page.locator('#self-enroll-overlay [data-action="self-enroll-close"]').click();
  await expect(page.locator("#self-enroll-overlay")).toHaveCount(0);
  // The workspace's copies are the new ones.
  await expect(pill, "the pill shows the new code").toContainText(newCode, { timeout: 10000 });
  await expect(pill, "and never the old one").not.toContainText(oldCode);
  if (!(await page.locator("#ws-join-pop").isVisible())) await pill.click();
  await expect(page.locator("#ws-join-pop .ws-jcode")).toHaveText(newCode);
  await page.locator('#ws-join-pop [data-action="ws-join-full"]').click();
  await expect(page.locator("#ws-qr-full .ws-qr-full-jcode"), "the full-screen QR names the new code").toHaveText(newCode, { timeout: 10000 });
  await page.locator('#ws-qr-full [data-action="ws-join-full-close"]').click();
  await expect(page.locator("#ws-qr-full")).toHaveCount(0);
  // Copy link copies the new link: the clipboard is recorded, the real control pressed.
  await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; });
  if (!(await page.locator("#ws-join-pop").isVisible())) await pill.click();
  await page.locator('#ws-join-pop [data-action="ws-join-copy"]').click();
  await expect.poll(() => page.evaluate(() => window.__copied)).toEqual([newUrl]);
});

test("Settings says what a walk-up meets in the join pill's words, never 'held for approval'", async ({ page }) => {
  // One sentence for every event: "Allow instant join" was retired (operator
  // ruling, 14 Nov 2026) — every walk-up confirms their email with a code.
  const on = await createEvent({ event_kind: "booth", self_enroll_enabled: true, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
  const off = await createEvent({ event_kind: "booth", self_enroll_enabled: false, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 });
  await adminLogin(page);
  expect(await page.evaluate(() => window.requireAccountApproval), "PRECONDITION: account approval is off").not.toBe(true);
  await openWs(page, on, "admin-event-settings-tab");
  const join = page.locator("#ws-settings .ws-kv").filter({ hasText: "Join link" });
  await expect(join).toContainText("Walk-ups confirm their email with a code, then join at once.", { timeout: 10000 });
  await expect(join).not.toContainText("held for approval");
  await expect(join, "no instant-join wording survives").not.toContainText(/play at once|confirm their email first/);
  await openWs(page, off, "admin-event-settings-tab");
  await expect(join, "CONTROL: the row is the off event's").toContainText(/Off$/, { timeout: 10000 });
  expect(await join.innerText(), "CONTROL: with the link off there is no walk-up to describe").not.toContain("Walk-ups");
});

test("a report email's link opens a whole workspace: the status strip, ← Events and the linked pane", async ({ page }) => {
  const ev = await createEvent({ event_kind: "tournament", start_time: new Date(Date.now() - 3 * 86_400_000).toISOString(), duration_minutes: 60 });
  await adminLogin(page);
  // The certificates link of the wrap-up mail, followed into a fresh page load:
  // the admin nav is built before the events list has loaded.
  await page.goto(`${BASE}/?event=${ev.id}&section=certificates`);
  await expect(page.locator("#admin-scope-banner"), "the status strip").toBeVisible({ timeout: 20000 });
  await expect(page.locator('#admin-scope-banner [data-action="scope-clear"]'), "with ← Events").toBeVisible();
  await expect(page.locator("#ws-title"), "the header names the event").toHaveText(ev.name);
  await expect(page.locator('#ws-tabs .ws-tab[data-section="admin-event-certs-tab"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#ws-certs-issued .ic-title"), "the Certificates pane is painted").toBeVisible({ timeout: 15000 });
  // The Overview link.
  await page.goto(`${BASE}/?event=${ev.id}&section=overview`);
  await expect(page.locator("#admin-scope-banner")).toBeVisible({ timeout: 20000 });
  await expect(page.locator("#ws-overview"), "the Overview is painted").toHaveAttribute("data-ov-state", "ended", { timeout: 15000 });
  expect(new URL(page.url()).search, "no event id left in the address bar").toBe("");
});
