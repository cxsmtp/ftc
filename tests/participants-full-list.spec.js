"use strict";

// v8.8.11 — THE BROWSER HALF, AND THE ONLY LAYER THAT CAN GO RED.
//
// The server is unchanged by this release: the fix removed a CONSUMER, so every
// API lock on both endpoints stays green whether or not the defect is present.
// The API spec beside this one pins the picker's surviving contract and the
// event-admin scope; what only a browser can show is WHICH endpoint the focused
// pane asks, and therefore whether an operator can see everybody.

const { test, expect, request } = require("./isolated-test");
const { apiLogin, BASE, TEST_DATA_DIR, PARTICIPANT_PASS, registerPost } = require("./helpers");
const { adminLogin, clickTab, loginViaApi, filterComps, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, buildWorld, makeCompetition, makeParticipant, enrol, grantEventAdmin } = require("./event-admin-helpers");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

const SEED_N = 520;

/** Open an event's workspace from the Events tab, the way an operator does. */
async function focusEvent(page, name) {
  await clickTab(page, "Events");
  await filterComps(page, name);
  const row = page.locator(`#admin-comp-body tr:has-text('${name}')`).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.locator('[data-action="comp-open"]').first().click();
  await expect(page.locator("#admin-scope-banner")).toContainText(name, { timeout: 15000 });
}

/** Narrow the People table to `text`, returning once it has re-rendered for it (narrowPeopleTable). */
async function searchPeople(page, text) {
  await narrowPeopleTable(page, text);
}

/** The People row for an address, on screen. */
const peopleRow = (page, email) => page.locator("#admin-participants-body tr", { hasText: email });

/** The number of people the count says the list is drawn from ("… of N participants …"). */
async function countTotal(page) {
  const t = (await page.locator("#participants-search-count").textContent()) || "";
  const m = t.match(/of (\d+)/) || t.match(/^(\d+)/);
  return m ? Number(m[1]) : NaN;
}

test.describe("v8.8.11 — the workspace's Participants section loads everyone and shows the event's people", () => {
  test.slow();
  /** @type {any} */ let sa, csrf;
  let comp, emptyComp, newest, member, pendingU, blockedU;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;

    comp = await makeCompetition(sa, csrf, "uifull");
    emptyComp = await makeCompetition(sa, csrf, "uiempty");
    member = await makeParticipant(sa, csrf, "uimember");
    await enrol(sa, csrf, comp.id, [member.id]);

    // A non-member still WAITING for approval (registered, verified, not
    // approved), and an approved non-member who is BLOCKED: the assign route
    // skips both (counted, never enrolled).
    {
      const email = `uipending-${Date.now()}@acme.com`;
      const anon = await request.newContext({ baseURL: BASE });
      try {
        const c = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
        const reg = await registerPost(anon, "/api/register", { headers: H(c), data: {
          email, password: PARTICIPANT_PASS, nickname: `uipending_${Date.now()}`.slice(0, 40),
          firstName: "Waiting", lastName: "Person", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" } });
        expect(reg.ok(), `register pending: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      } finally { await anon.dispose(); }
      const row = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
      expect(row, "PRECONDITION: the waiting account is listed").toBeTruthy();
      const v = await sa.post(`/api/admin/participants/${row.id}/verify`, { headers: H(csrf) });
      expect(v.ok(), `verify: ${v.status()}`).toBeTruthy();
      pendingU = { id: row.id, email };
    }
    blockedU = await makeParticipant(sa, csrf, "uiblocked");
    const b = await sa.post(`/api/admin/participants/${blockedU.id}/block`, { headers: H(csrf), data: { blocked: true } });
    expect(b.ok(), `block: ${b.status()} ${await b.text()}`).toBeTruthy();
    const states = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants;
    const ps = states.find(p => p.id === pendingU.id), bs = states.find(p => p.id === blockedU.id);
    expect(ps && ps.verified && !ps.approved && !ps.blocked, "PRECONDITION: verified and waiting").toBeTruthy();
    expect(bs && bs.approved && bs.blocked, "PRECONDITION: approved and blocked").toBeTruthy();

    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = `uifull-${stamp}`;
    try {
      fs.writeFileSync(maintFile, byp);
      const users = Array.from({ length: SEED_N }, (_, i) => ({
        firstName: "Bulk", lastName: `U${i}`,
        nickname: `uf${stamp}${i}`, email: `uf_${stamp}_${i}@acme.com`,
      }));
      const r = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...H(csrf), "x-maintenance-bypass": byp },
        data: { users, sharedPassword: "testpass123" },
      });
      expect(r.status(), `bulk-seed: ${r.status()} ${await r.text()}`).toBe(200);
    } finally { try { fs.unlinkSync(maintFile); } catch (_) {} }

    newest = await makeParticipant(sa, csrf, "uinewest");
  });

  test("the reported flow — a participant registered after the 500th is there", async ({ page }) => {
    await adminLogin(page);

    // CONTROL, in this same test and AFTER the sign-in (page.request shares the
    // page's cookie jar, so it needs the session): the fixture must genuinely
    // exceed the cap, or "everyone is present" is satisfied by a small database
    // where nothing was ever truncated.
    const pk = await page.request.get(`/api/admin/participants/picker?competitionId=${comp.id}`);
    expect(pk.ok(), `picker probe: ${pk.status()}`).toBeTruthy();
    const pkBody = await pk.json();
    expect(pkBody.truncated, "precondition: the picker still truncates this fixture").toBe(true);
    expect((pkBody.users || []).some(u => u.id === newest.id),
      "…and the newest account is exactly what it hides").toBe(false);

    await focusEvent(page, comp.name);

    // WATCH THE WIRE. The endpoint is unchanged, so "the row is present" alone
    // could be satisfied by a picker call that happened to include it; what this
    // release actually did is stop asking the picker.
    const asked = [];
    page.on("request", r => {
      const u = r.url();
      if (u.includes("/api/admin/participants")) asked.push(u.includes("/picker") ? "picker" : "list");
    });

    await clickTab(page, "Participants");
    await expect.poll(async () => (await page.evaluate(() =>
      (window.S?.adminParticipantsData || []).length)), { timeout: 30000 }).toBeGreaterThan(500);

    const seen = await page.evaluate((id) =>
      (window.S.adminParticipantsData || []).some(p => p.id === id), newest.id);
    expect(seen, "the account past the cap is in the model").toBe(true);

    expect(asked.includes("list"), "the pane asked the main list").toBe(true);
    expect(asked.includes("picker"), "…and did not ask the picker").toBe(false);

    // ON SCREEN, not only in the model: Search everyone on the platform lists
    // the account past the cap, and offers to add it.
    await page.locator("#p-ws-scope:not([hidden]) #p-ws-everyone").check();
    await searchPeople(page, newest.email);
    const row = peopleRow(page, newest.email);
    await expect(row, "the account past the cap is a row on screen").toHaveCount(1, { timeout: 15000 });
    await expect(row.locator('.action-cell [data-action="participant-invite"]'), "…with Add to event as its one action").toHaveCount(1);
  });

  test("by default the section lists only the event's people; Search everyone brings the rest back", async ({ page }) => {
    // THE NEGATIVE CONTROL for the member filter: the model holds every account
    // (the test above), so only what is ON SCREEN can show the narrowing.
    await adminLogin(page);
    await focusEvent(page, comp.name);
    await clickTab(page, "Participants");
    await expect.poll(async () => (await page.evaluate(() =>
      (window.S?.adminParticipantsData || []).length)), { timeout: 30000 }).toBeGreaterThan(500);
    await expect(page.locator("#p-ws-everyone"), "PRECONDITION: Search everyone starts unticked").not.toBeChecked();
    await expect(peopleRow(page, member.email), "the event's own member is listed").toHaveCount(1, { timeout: 15000 });
    expect(await page.locator("#admin-participants-body tr").count(), "and only the event's people are rows").toBe(1);
    expect(await countTotal(page), "the count is drawn from the event's people, not the platform's").toBe(1);

    // A non-member is absent even when searched for by name…
    await searchPeople(page, newest.email);
    await expect(peopleRow(page, newest.email), "a non-member is not listed by default").toHaveCount(0);
    await expect(page.locator("#admin-participants-body"), "the empty list says a filter did it").toContainText("No participants match the current filters.");

    // …and ticking Search everyone brings the same search back on screen.
    await page.locator("#p-ws-scope:not([hidden]) #p-ws-everyone").check();
    await expect(peopleRow(page, newest.email), "Search everyone lists the non-member").toHaveCount(1, { timeout: 15000 });
    await searchPeople(page, "");
    await expect.poll(() => countTotal(page), { message: "the count now covers every account", timeout: 15000 }).toBeGreaterThan(500);
    // Members first, among everyone (the operator's 'Manage participants' order).
    await expect(page.locator("#admin-participants-body tr").first(), "a member of the event sorts to the top")
      .toContainText(member.email, { timeout: 15000 });
  });

  test("Search everyone: a waiting or blocked non-member keeps Approve or Unblock; an approved one gets Add to event", async ({ page }) => {
    // The assign route skips a blocked, denied or unapproved account (counted,
    // never enrolled), so Add to event is never offered on one, nor does it
    // replace the row's real next step.
    await adminLogin(page);
    await focusEvent(page, comp.name);
    await clickTab(page, "Participants");
    await page.locator("#p-ws-scope:not([hidden]) #p-ws-everyone").check();

    await searchPeople(page, pendingU.email);
    const waiting = peopleRow(page, pendingU.email);
    await expect(waiting, "PRECONDITION: the waiting account is listed").toHaveCount(1, { timeout: 15000 });
    await expect(waiting.locator('.action-cell [data-action="participant-approve"]'), "its own next step stays").toHaveCount(1);
    await expect(waiting.locator('[data-action="participant-invite"]'), "no Add to event on an unapproved account, as button or menu item").toHaveCount(0);

    await searchPeople(page, blockedU.email);
    const blocked = peopleRow(page, blockedU.email);
    await expect(blocked, "PRECONDITION: the blocked account is listed").toHaveCount(1, { timeout: 15000 });
    await expect(blocked.locator('.action-cell [data-action="participant-block"][data-blocked="true"]'), "Unblock stays its next step").toHaveCount(1);
    await expect(blocked.locator('[data-action="participant-invite"]'), "no Add to event on a blocked account, as button or menu item").toHaveCount(0);

    // CONTROL: an approved, unblocked non-member gets Add to event, and it works.
    await searchPeople(page, newest.email);
    const ok = peopleRow(page, newest.email);
    await expect(ok.locator('.action-cell [data-action="participant-invite"]'), "CONTROL: an approved non-member gets Add to event").toHaveCount(1, { timeout: 15000 });
    await expect(ok.locator('.kebab-menu [data-action="participant-invite"]'), "CONTROL: and the menu's Invite item").toHaveCount(1);
  });

  test("a heading filter that empties the list says so, never 'nobody is in this event yet'", async ({ page }) => {
    await adminLogin(page);
    // CONTROL: an event nobody has joined says so (no filter of any kind).
    await focusEvent(page, emptyComp.name);
    await clickTab(page, "Participants");
    await expect(page.locator("#admin-participants-body"), "CONTROL: the truly empty event").toContainText("Nobody is in this event yet.", { timeout: 15000 });

    await focusEvent(page, comp.name);
    await clickTab(page, "Participants");
    await expect(peopleRow(page, member.email), "PRECONDITION: the member is listed").toHaveCount(1, { timeout: 15000 });
    await page.locator("#p-table thead th[data-col='name'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("zzqqnobody", { delay: 15 });
    const body = page.locator("#admin-participants-body");
    await expect(body).toContainText("No participant matches the column filters.", { timeout: 5000 });
    await expect(body, "never a false fact about the event").not.toContainText("Nobody is in this event yet");
    await page.keyboard.press("Escape");
    await body.locator('[data-tcol-clear="participants"]').click();
    await expect(peopleRow(page, member.email), "Clear column filters brings the member back").toHaveCount(1, { timeout: 5000 });

    // Outside an event (the sidebar's People closes the workspace) the same
    // filter must not claim the platform has nobody.
    await page.evaluate(() => window.adminTab(null, "admin-participants-tab"));
    await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId), { message: "PRECONDITION: no event is open" }).toBeFalsy();
    await expect(page.locator('#admin-participants-body td.cell-stack[data-pcol="participant"]').first(), "PRECONDITION: the platform's people are listed").toBeVisible({ timeout: 15000 });
    await page.locator("#p-table thead th[data-col='name'] .tcol-hbtn").click();
    await page.locator(".tcol-pop input[data-tcol-input]").pressSequentially("zzqqnobody", { delay: 15 });
    await expect(body).toContainText("No participant matches the column filters.", { timeout: 5000 });
    await expect(body).not.toContainText("No participants yet.");
  });
});

test.describe("v8.8.11 — an event admin's focused pane is still narrowed", () => {
  /** @type {any} */ let w;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    w = await buildWorld();
  });

  test("they see their own event's people and nobody else's", async ({ page }) => {
    // The half that must NOT widen. Driven through the real pane, because the
    // scope is applied by the endpoint the pane now asks — a different endpoint
    // from the one it asked before, which is exactly what needs proving.
    await loginViaApi(page, w.ea.email, "testpass123");
    const me = await page.request.get("/api/admin/me");
    expect((await me.json()).isEventAdmin, "the fixture holds the tier").toBe(true);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await focusEvent(page, w.mine.name);
    await clickTab(page, "Participants");
    await expect.poll(async () => (await page.evaluate(() =>
      (window.S?.adminParticipantsData || []).length)), { timeout: 30000 }).toBeGreaterThan(0);

    const ids = await page.evaluate(() => (window.S.adminParticipantsData || []).map(p => p.id));
    expect(ids, "somebody in the event they run").toContain(w.inMine.id);
    expect(ids, "NOT somebody only in another organiser's event").not.toContain(w.inTheirs.id);
    expect(ids, "…nor an unrelated account").not.toContain(w.zero.id);
  });

  test("CONTROL — a superadmin on the same event sees the other organiser's participant", async ({ page }) => {
    // Without it, "the organiser saw only their people" is equally satisfied by
    // a pane that shows nobody anything.
    await adminLogin(page);
    await focusEvent(page, w.mine.name);
    await clickTab(page, "Participants");
    await expect.poll(async () => (await page.evaluate(() =>
      (window.S?.adminParticipantsData || []).length)), { timeout: 30000 }).toBeGreaterThan(0);
    const ids = await page.evaluate(() => (window.S.adminParticipantsData || []).map(p => p.id));
    expect(ids, "the decoy's participant is visible to an unscoped tier").toContain(w.inTheirs.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.8.11 — THE DERIVATION, WHICH SURVIVED ITS FIRST MUTATION AND SO NEEDS THIS.
//
// The pane used to read `chosen_timeslot_id`, a column only the picker emitted;
// it now derives the same value from `p.competitions`. Both readers spell the
// test `slot === focused || !slot` — "matches, or has not chosen yet" — so a
// derivation returning `undefined` answers YES FOR EVERYONE and every
// positive-only assertion passes against a completely broken helper. Measured:
// replacing the helper body with `return undefined` left all eleven other arms
// in these two files green.
//
// The NEGATIVE arm is therefore the whole point, and the positive one beside it
// is what stops "everything is dimmed" passing.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.8.11 — the focused session still dims the other one", () => {
  test.slow();
  /** @type {any} */ let sa, csrf;
  let comp, slotA, slotB, inA, inB;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const l = await apiLogin("superadmin");
    sa = l.api; csrf = l.csrf;

    // A multi-session event: two slots, one participant in each. A single slot
    // cannot separate a correct derivation from a broken one, because everybody
    // then matches the focused slot anyway.
    comp = await makeCompetition(sa, csrf, "slots");
    const mk = async (label, offsetMin) => {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(csrf),
        data: { name: `Slot ${label}`, start_time: new Date(Date.now() - offsetMin * 60_000).toISOString(), duration_minutes: 600 },
      });
      expect(r.ok(), `create slot ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const b = await r.json();
      return b.timeslot?.id || b.id;
    };
    slotA = await mk("A", 30);
    slotB = await mk("B", 20);

    inA = await makeParticipant(sa, csrf, "slota");
    inB = await makeParticipant(sa, csrf, "slotb");
    await enrol(sa, csrf, comp.id, [inA.id, inB.id]);

    // Each chooses their own session, through the real participant path.
    for (const [p, slot] of [[inA, slotA], [inB, slotB]]) {
      const s = await apiLogin(p.email, "testpass123");
      try {
        const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } });
        expect(sel.ok(), `select comp: ${await sel.text()}`).toBeTruthy();
        const c2 = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
        // `confirmLive`, not `confirm` — and the route answers 200 {ok:false,
        // requireConfirmation:true} for a LIVE session, so `r.ok()` is true while
        // nothing is written. Assert the PAYLOAD: a seed step that silently does
        // not happen is worse than one that fails.
        const ts = await s.api.post("/api/select-timeslot", { headers: H(c2), data: { timeslotId: slot, confirmLive: true } });
        expect(ts.ok(), `select slot: ${ts.status()} ${await ts.text()}`).toBeTruthy();
        expect((await ts.json()).ok, `the slot choice must STICK: ${slot}`).toBe(true);
      } finally { await s.api.dispose(); }
    }
  });

  test("a member of the OTHER session is dimmed; one of the focused session is not", async ({ page }) => {
    // The Sessions column (the chip this test presses) is under Columns by default.
    const UAH = require("./ui-admin-helpers");
    await UAH.showAllTableColumns(page, "events", UAH.EVENT_ALL_COLUMNS);
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, comp.name);
    const row = page.locator(`#admin-comp-body tr:has-text('${comp.name}')`).first();
    await row.waitFor({ state: "visible", timeout: 15000 });
    // Open the SESSION, not merely the event — the dim rule only applies then.
    // The Events list's session chip opens the workspace on that one session.
    await row.locator('[data-action="comp-open-ts"]').first().click();
    await expect(page.locator("#admin-scope-banner")).toContainText("Slot A", { timeout: 15000 });

    await clickTab(page, "Participants");
    await expect.poll(async () => (await page.evaluate(() =>
      (window.S?.adminParticipantsData || []).length)), { timeout: 30000 }).toBeGreaterThan(0);

    // Instrument before asserting: "not dimmed" is equally true of a broken
    // focus, a participant who never chose a session, and a broken derivation.
    const diag = await page.evaluate(({ a, b }) => {
      const f = (e) => (window.S.adminParticipantsData || []).find(p => p.email === e);
      const pick = (p) => p ? { email: p.email, comps: (p.competitions || []).map(c => ({ id: c.id, ts: c.timeslot_id })) } : null;
      return { tsId: window.S.adminSelectedTimeslotId, compId: window.S.adminSelectedCompetitionId, a: pick(f(a)), b: pick(f(b)) };
    }, { a: inA.email, b: inB.email });
    expect(diag.tsId, `a session must be focused — got ${JSON.stringify(diag)}`).toBeTruthy();
    expect(diag.b, `the other session's member must be in the model — ${JSON.stringify(diag)}`).toBeTruthy();

    const rowA = page.locator(`#admin-participants-body tr:has-text('${inA.email}')`).first();
    const rowB = page.locator(`#admin-participants-body tr:has-text('${inB.email}')`).first();
    await expect(rowA, "the focused session's member is listed").toBeVisible({ timeout: 15000 });

    // POSITIVE: the focused session's own member is NOT dimmed.
    await expect(rowA.locator(".row-deemphasised").first(),
      "a member of the focused session is not dimmed").toHaveCount(0);
    // NEGATIVE, and this is the arm the mutation needed: the other session's
    // member IS dimmed. A derivation answering `undefined` dims neither.
    await expect(rowB.locator(".row-deemphasised").first(),
      "a member of the OTHER session is dimmed").not.toHaveCount(0);
  });
});
