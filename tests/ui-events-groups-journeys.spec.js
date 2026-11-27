// @ts-check
//
// v8.12.4 — events- and groups-pane controls no test had ever DRIVEN.
//
// A coverage run showed deleteCompetition, startNow, the event tag add/remove,
// the kind filter and all three group-management dialogs never executing in a
// browser: every one was exercised through the API only. Each test presses the
// real control and reads the stored result.
const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { const H = require("./ui-admin-helpers"); await H.openFilterPanels(page); await H.showAllTableColumns(page, "events", H.EVENT_ALL_COLUMNS); });
const { apiLogin, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, clickTab, openKebab, viewComp, narrowGroupsTable, rerenderedAfter, narrowEventsTable } = require("./ui-admin-helpers");
const { H, uniq } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const dbAll = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};

async function mkEvent(sa, csrf, name, extra = {}) {
  const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name, start_time: new Date(Date.now() + 2 * 3_600_000).toISOString(), duration_minutes: 120, event_kind: "tournament", ...extra } });
  expect(r.ok(), `create ${name}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition.id;
}
async function narrowEvents(page, query) {
  await narrowEventsTable(page, query);
  const tbody = page.locator("#admin-comp-body");
  await expect(async () => {
    const a = await tbody.locator("tr").count();
    await page.waitForTimeout(250);
    expect(await tbody.locator("tr").count()).toBe(a);
  }).toPass({ timeout: 8000 });
}
async function eventKebab(page, name, action) {
  await narrowEvents(page, name);
  const row = page.locator(`#admin-comp-body tr:has-text("${name}")`).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await openKebab(page, row);
  await page.locator(`#kebab-portal [data-action="${action}"]`).first().click();
}
async function confirmModal(page, expectText) {
  const ov = page.locator("#modal-overlay.open");
  await ov.waitFor({ state: "visible", timeout: 8000 });
  if (expectText) await expect(ov).toContainText(expectText);
  await page.locator("#modal-confirm-btn").click();
}
async function answerPrompt(page, value) {
  const input = page.locator("#prompt-input");
  await input.waitFor({ state: "visible", timeout: 8000 });
  await input.fill(value);
  await page.locator("#prompt-ok").click();
}

// A Start now dialog HELD OPEN for ten minutes, without a real wait: the page's
// Date.now runs ten minutes behind while the dialog opens (what the dialog reads
// then is "the moment it opened") and catches up before the press, landing the
// press a quarter of a minute past a whole minute before the kept end, where a
// length rounded to the NEAREST minute would end it 15 s early (rounded up, as
// End Now rounds, 45 s late). Returns the moment of the press on the page's clock.
const HELD_MS = 10 * 60_000;
const endOf = (r) => Date.parse(r.start_time) + r.duration_minutes * 60_000;
async function pageClockBehind(page, ms) {
  await page.evaluate((ms) => {
    if (!window.__tRealDateNow) window.__tRealDateNow = Date.now.bind(Date);
    const real = window.__tRealDateNow;
    Date.now = () => real() - ms;
  }, ms);
}
async function startHeldOpen(page, control, titleRe, keptEndMs) {
  await pageClockBehind(page, HELD_MS);
  await control.click();
  const ov = page.locator("#modal-overlay.open");
  await ov.waitFor({ state: "visible", timeout: 8000 });
  await expect(ov.locator("#modal-title, #modal-body")).toContainText([titleRe, /End time \(preserved\)[\s\S]*Duration adjusted/]);
  // PRECONDITION: the dialog opened on the held-back clock. The length it shows
  // reaches the kept end from ten minutes ago, so it exceeds the time really
  // left by more than five minutes (on the real clock it would not).
  const shown = (await ov.locator("#modal-body strong").last().textContent() || "").match(/^(?:(\d+)d )?(\d+):(\d+):(\d+)$/);
  expect(shown, "PRECONDITION: the dialog shows the adjusted length").toBeTruthy();
  const shownMs = (((+(shown[1] || 0) * 24 + +shown[2]) * 60 + +shown[3]) * 60 + +shown[4]) * 1000;
  expect(shownMs, "PRECONDITION: the dialog opened ten minutes ago on the page's clock").toBeGreaterThan(keptEndMs - Date.now() + HELD_MS / 2);
  const pressAt = await page.evaluate((end) => {
    const real = window.__tRealDateNow;
    const off = ((15_000 - ((end - real()) % 60_000)) % 60_000 + 60_000) % 60_000;
    Date.now = () => real() - off;
    return Date.now();
  }, keptEndMs);
  expect((keptEndMs - pressAt) % 60_000, "PRECONDITION: the press lands a quarter of a minute past a whole minute before the end").toBeGreaterThan(10_000);
  await page.locator("#modal-confirm-btn").click();
  return pressAt;
}
// The end is kept: never earlier than scheduled, and under a minute later
// (minutes are whole and rounded up, as End Now rounds); the start is the press.
function expectEndKept(before, after, pressAt) {
  const moved = endOf(after) - endOf(before);
  expect(moved, `the scheduled end is kept, never moved earlier: ${JSON.stringify({ before, after })}`).toBeGreaterThanOrEqual(0);
  expect(moved, `nor later by the time the dialog stayed open: ${JSON.stringify({ before, after })}`).toBeLessThan(60_000);
  expect(Date.parse(after.start_time), "the start is the moment of the press, not when the dialog opened").toBeGreaterThanOrEqual(pressAt - 5000);
}

test.describe("v8.12.4 — events pane, driven through its own controls", () => {
  test("Delete from the row menu, confirmed, removes the event", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const name = uniq("DeleteMe");
    const id = await mkEvent(sa, csrf, name);
    await sa.dispose();
    await adminLogin(page);
    await eventKebab(page, name, "comp-delete");
    await confirmModal(page, /Delete Event/);
    await expect.poll(() => dbGet("SELECT id FROM competitions WHERE id=?", id), { timeout: 10000 }).toBeUndefined();
  });

  // Operator ruling, 14 Nov 2026: a window kind (Booth Event, Competition)
  // started early keeps its SCHEDULED END, as a session's own Start now keeps
  // its end: the duration stretches to reach it. The dialog is held open for ten
  // minutes of the page's clock first: the start and the duration come from ONE
  // instant at the press, so the end is kept however long the dialog was open.
  test("Start Now on an upcoming event starts it at the press and KEEPS its scheduled end, however long the dialog stayed open", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const name = uniq("StartMe");
    const id = await mkEvent(sa, csrf, name);
    await sa.dispose();
    const before = dbGet("SELECT start_time, duration_minutes FROM competitions WHERE id=?", id);
    await adminLogin(page);
    await narrowEvents(page, name);
    const row = page.locator(`#admin-comp-body tr:has-text("${name}")`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    await openKebab(page, row);
    const pressAt = await startHeldOpen(page, page.locator('#kebab-portal [data-action="comp-start-now"]').first(), /Start Event Now\?/, endOf(before));
    await expect.poll(() => Date.parse(dbGet("SELECT start_time FROM competitions WHERE id=?", id).start_time), { timeout: 10000 })
      .toBeLessThanOrEqual(Date.now() + 5000);
    const after = dbGet("SELECT start_time, duration_minutes FROM competitions WHERE id=?", id);
    expect(Date.parse(after.start_time), "CONTROL: it really started earlier than planned").toBeLessThan(Date.parse(before.start_time));
    expectEndKept(before, after, pressAt);
    expect(after.duration_minutes, "the duration stretched to reach it (it was set to start two hours from now)").toBeGreaterThan(before.duration_minutes + 100);
  });

  // A session's own Start now keeps the session's end the same way.
  test("a session's Start Now starts it at the press and KEEPS the session's scheduled end, however long the dialog stayed open", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const name = uniq("StartSession");
    const id = await mkEvent(sa, csrf, name, { start_time: new Date(Date.now() + 86_400_000).toISOString() });
    let tsId;
    try {
      const t = await sa.post(`/api/admin/competitions/${id}/timeslots`, { headers: H(csrf), data: {
        name: "Morning", start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(), duration_minutes: 60 } });
      expect(t.ok(), await t.text()).toBeTruthy();
      tsId = (await t.json()).timeslot.id;
    } finally { await sa.dispose(); }
    const before = dbGet("SELECT start_time, duration_minutes FROM competition_timeslots WHERE id=?", tsId);
    await adminLogin(page);
    await viewComp(page, name);
    const start = page.locator(`#ws-overview [data-action="ts-start-now"][data-ts-id="${tsId}"]`);
    await expect(start, "PRECONDITION: the upcoming session offers Start now").toBeVisible({ timeout: 15000 });
    const pressAt = await startHeldOpen(page, start, /Start Session Now\?/, endOf(before));
    await expect.poll(() => Date.parse(dbGet("SELECT start_time FROM competition_timeslots WHERE id=?", tsId).start_time), { timeout: 10000 })
      .toBeLessThanOrEqual(Date.now() + 5000);
    const after = dbGet("SELECT start_time, duration_minutes FROM competition_timeslots WHERE id=?", tsId);
    expect(Date.parse(after.start_time), "CONTROL: it really started earlier than planned").toBeLessThan(Date.parse(before.start_time));
    expectEndKept(before, after, pressAt);
  });

  // A DEADLINE kind keeps its deadline: the PUT carries the start alone and the
  // server derives the duration from the stored deadline at the start it writes.
  // A duration the client computed before the confirm was refused whenever its
  // rounding disagreed with that derivation, and always past the request's
  // 365-day cap, which every Program due more than a year out exceeds.
  test("Start Now on a Program keeps its deadline: the start alone is sent, even for a deadline more than a year out", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const name = uniq("StartProgram");
    const deadline = new Date(Date.now() + 400 * 864e5);
    deadline.setUTCSeconds(0, 0);
    const id = await mkEvent(sa, csrf, name, { event_kind: "program", duration_minutes: undefined, deadline_at: deadline.toISOString() });
    await sa.dispose();
    const before = dbGet("SELECT start_time, deadline_at FROM competitions WHERE id=?", id);
    expect(Date.parse(before.deadline_at), "PRECONDITION: the deadline is stored").toBe(deadline.getTime());
    await adminLogin(page);
    let putBody = null;
    page.on("request", (r) => { if (r.method() === "PUT" && new URL(r.url()).pathname === `/api/admin/competitions/${id}`) putBody = r.postDataJSON(); });
    await eventKebab(page, name, "comp-start-now");
    await confirmModal(page, /Deadline \(preserved\)/);
    await expect.poll(() => Date.parse(dbGet("SELECT start_time FROM competitions WHERE id=?", id).start_time), { timeout: 10000, message: "the event started" })
      .toBeLessThanOrEqual(Date.now() + 5000);
    expect(putBody, "the PUT was sent").toBeTruthy();
    expect(Object.keys(putBody), "the start alone, never a duration of the client's own").not.toContain("duration_minutes");
    expect(putBody.start_time, "CONTROL: the start is in it").toBeTruthy();
    const after = dbGet("SELECT start_time, deadline_at, duration_minutes FROM competitions WHERE id=?", id);
    expect(Date.parse(after.deadline_at), "the deadline is kept").toBe(deadline.getTime());
    expect(after.duration_minutes, "the duration is derived from it at the new start")
      .toBe(Math.ceil((Date.parse(after.deadline_at) - Date.parse(after.start_time)) / 60_000));
    expect(after.duration_minutes, "PRECONDITION: longer than any duration a request may carry").toBeGreaterThan(525600);
  });

  // Start now keeps the end in WHOLE minutes, rounded up, so the end it writes can
  // land up to a minute late. A Booth Event whose late-entry deadline was pinned
  // through the API inside that minute would be left with a deadline before its
  // end: the server refuses the start (`late_entry_deadline_stale`), and the
  // toast must name a way out the app offers, as Start now sends no deadline.
  // The press is placed so the time left is three quarters of a minute past a
  // whole minute, so the end moves 15 s plus the moment the click took: a pin 5 s
  // after the end is passed, one 50 s after it (the control) is not, which leaves
  // the click 35 s on a slow runner before the control would meet the refusal.
  test("Start Now on a Booth Event whose pinned late-entry deadline it would pass is refused, naming the fix in Edit settings", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const prefix = uniq("StartPinned");
    const start = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 2 * 3_600_000 + 30_000);  // off the minute, as only the API sets it
    const end = start.getTime() + 120 * 60_000;
    const ids = {};
    try {
      for (const [k, pinAfter] of [["Near", 5_000], ["Clear", 50_000]]) {
        ids[k] = await mkEvent(sa, csrf, `${prefix} ${k}`, { event_kind: "booth", start_time: start.toISOString(), duration_minutes: 120,
          late_entry_deadline_at: new Date(end + pinAfter).toISOString() });
      }
    } finally { await sa.dispose(); }
    const rowOf = (id) => dbGet("SELECT start_time, duration_minutes, late_entry_enabled, late_entry_deadline_at FROM competitions WHERE id=?", id);
    const near = rowOf(ids.Near);
    expect(near.late_entry_enabled, "PRECONDITION: late entries on").toBe(1);
    expect(Date.parse(near.late_entry_deadline_at) - endOf(near), "PRECONDITION: pinned 5 s after the end").toBe(5_000);
    await adminLogin(page);
    const pressAligned = async (k) => {
      await eventKebab(page, `${prefix} ${k}`, "comp-start-now");
      const ov = page.locator("#modal-overlay.open");
      await ov.waitFor({ state: "visible", timeout: 8000 });
      await expect(ov).toContainText(/End time \(preserved\)/);
      await page.evaluate((end) => {
        if (!window.__tRealDateNow) window.__tRealDateNow = Date.now.bind(Date);
        const real = window.__tRealDateNow;
        const off = ((45_000 - ((end - real()) % 60_000)) % 60_000 + 60_000) % 60_000;
        Date.now = () => real() - off;
      }, end);
      let answer = null;
      const answered = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/admin/competitions/${ids[k]}`)
        .then(async (r) => { answer = { status: r.status(), body: await r.json().catch(() => ({})) }; });
      await page.locator("#modal-confirm-btn").click();
      await answered;
      return answer;
    };

    const refused = await pressAligned("Near");
    expect(refused.status, `Start now passing the pin: ${JSON.stringify(refused.body)}`).toBe(400);
    expect(refused.body.code).toBe("late_entry_deadline_stale");
    const toast = page.locator("#toast-stack .toast", { hasText: "pinned to" });
    await expect(toast, "the refusal reaches the organiser").toBeVisible({ timeout: 8000 });
    await expect(toast, "naming the way out the app offers").toContainText(/In the event's settings \(Edit settings\), set a later late-entry deadline or tick Automatic/);
    const after = rowOf(ids.Near);
    expect(after, "nothing was written").toEqual(near);

    // CONTROL: the same press with the pin 50 s after the end starts the event and keeps the pin.
    const clearBefore = rowOf(ids.Clear);
    const started = await pressAligned("Clear");
    expect(started.status, `CONTROL Start now: ${JSON.stringify(started.body)}`).toBe(200);
    const clearAfter = rowOf(ids.Clear);
    expect(Date.parse(clearAfter.start_time), "CONTROL: it started").toBeLessThan(Date.parse(clearBefore.start_time));
    const moved = endOf(clearAfter) - endOf(clearBefore);
    expect(moved, "CONTROL: the end moved the 15 s the rounding adds (plus the moment the click took)").toBeGreaterThanOrEqual(15_000);
    expect(moved, "CONTROL: and stopped short of the pin").toBeLessThan(50_000);
    expect(clearAfter.late_entry_deadline_at, "CONTROL: the pin is kept").toBe(clearBefore.late_entry_deadline_at);
  });

  // ONE GOLD ACTION PER SCREEN (styles.css `.btn.gold`): a row action repeated
  // on every ended event is secondary.
  test("the Top 3 certificates button on an ended row is secondary, never a gold action", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const prefix = uniq("GoldRows");
    const past = new Date(Date.now() - 5 * 3_600_000).toISOString();
    for (const k of ["A", "B"]) await mkEvent(sa, csrf, `${prefix} ${k}`, { start_time: past, duration_minutes: 60 });
    await sa.dispose();
    await adminLogin(page);
    await page.locator('#comp-status-filters [data-action="toggle-comp-filter"][data-status="ended"]').click();
    await narrowEvents(page, prefix);
    const top3 = page.locator('#admin-comp-body [data-action="comp-top3"]');
    await expect(top3, "PRECONDITION: both ended, ranked rows offer Top 3").toHaveCount(2, { timeout: 10000 });
    await expect(top3.first()).toHaveClass(/\bsecondary\b/);
    await expect(page.locator("#admin-comp-body .btn.gold"), "no row action is gold").toHaveCount(0);
    expect(await page.locator("#admin-competitions-tab .btn.gold:visible").count(), "the screen holds at most one gold action").toBeLessThanOrEqual(1);
  });

  test("+ tag adds a typed tag to the event, and its × removes it", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const name = uniq("TagEvent");
    const id = await mkEvent(sa, csrf, name);
    await sa.dispose();
    const tags = () => dbAll("SELECT tag FROM competition_tags WHERE competition_id=? ORDER BY tag", id).map(r => r.tag);
    await adminLogin(page);
    await narrowEvents(page, name);
    const row = page.locator(`#admin-comp-body tr:has-text("${name}")`).first();
    await row.locator('[data-action="comp-tag-add"]').click();
    await page.locator("#comp-tag-input").fill("apac-cohort");
    await page.locator("#comp-tag-save-btn").click();
    await expect.poll(tags, { timeout: 10000 }).toEqual(["apac-cohort"]);
    await narrowEvents(page, name);
    await page.locator(`#admin-comp-body tr:has-text("${name}") [data-action="comp-tag-remove"][data-tag="apac-cohort"]`).click();
    await expect.poll(tags, { timeout: 10000 }).toEqual([]);
  });

  // A tag change writes the events model in place. A read of the model sent
  // before the change landed, answering after it, must not put the old tags
  // back: each tag writer claims the model's fetch sequence. (The 15 s poll is
  // stopped, so the one read held is the test's own.)
  test("an events read sent before a tag change answers after it without putting the old tags back", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const name = uniq("TagRace");
    const id = await mkEvent(sa, csrf, name);
    await sa.dispose();
    await adminLogin(page);
    await narrowEvents(page, name);
    await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
    const modelTags = () => page.evaluate((cid) => ((window.adminCompetitionsData || []).find((c) => c.id === cid) || {}).tags || [], id);
    const holdRead = async () => {
      let seen, go;
      const sent = new Promise((r) => { seen = r; }), gate = new Promise((r) => { go = r; });
      const isList = (url) => url.pathname === "/api/admin/competitions";
      const handler = async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const resp = await route.fetch();
        seen();
        await gate;
        await route.fulfill({ response: resp });
      };
      await page.route(isList, handler);
      await page.evaluate(() => { window.__heldEventsRead = window.loadAdminCompetitions({ keepPage: true }); });
      await sent;
      return async () => { go(); await page.evaluate(() => window.__heldEventsRead); await page.unroute(isList, handler); };
    };
    const row = () => page.locator(`#admin-comp-body tr:has-text("${name}")`).first();

    let release = await holdRead();
    await row().locator('[data-action="comp-tag-add"]').click();
    await page.locator("#comp-tag-input").fill("race-add");
    await page.locator("#comp-tag-save-btn").click();
    await expect.poll(modelTags, { message: "PRECONDITION: the added tag is in the model" }).toEqual(["race-add"]);
    await release();
    expect(await modelTags(), "the earlier read did not take the added tag away").toEqual(["race-add"]);
    await expect(row().locator('[data-action="comp-tag-remove"][data-tag="race-add"]'), "and the row shows it").toHaveCount(1);

    release = await holdRead();
    await row().locator('[data-action="comp-tag-remove"][data-tag="race-add"]').click();
    await expect.poll(modelTags, { message: "PRECONDITION: the removal is in the model" }).toEqual([]);
    await release();
    expect(await modelTags(), "the earlier read did not bring the removed tag back").toEqual([]);
    await expect(row().locator('[data-action="comp-tag-remove"][data-tag="race-add"]'), "and the row does not show it").toHaveCount(0);
  });

  test("a kind chip narrows the table to that kind", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const prefix = uniq("KindChip");
    await mkEvent(sa, csrf, `${prefix} T`, { event_kind: "tournament" });
    await mkEvent(sa, csrf, `${prefix} B`, { event_kind: "booth" });
    await sa.dispose();
    await adminLogin(page);
    await narrowEvents(page, prefix);
    const kinds = () => page.locator("#admin-comp-body tr").evaluateAll(
      (rs, p) => rs.map(r => (r.textContent || "").match(new RegExp(p + " ([TB])"))).filter(Boolean).map(m => m[1]).sort(), prefix);
    await expect.poll(kinds, { timeout: 8000 }).toEqual(["B", "T"]);
    const chip = page.locator('#comp-kind-filters [data-action="toggle-comp-kind-filter"][data-kind="booth"]');
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect.poll(kinds, { timeout: 8000 }).toEqual(["B"]);
    await chip.click();
    await expect.poll(kinds, { timeout: 8000 }).toEqual(["B", "T"]);
  });
});

test.describe("v8.12.4 — groups pane, driven through its own controls", () => {
  test("New Group, Rename and Delete each go through their dialog and land", async ({ page }) => {
    const name = uniq("Cohort"), renamed = `${name} Renamed`;
    const group = (n) => dbGet("SELECT id, name FROM groups WHERE name=?", n);
    await adminLogin(page);
    await clickTab(page, "Groups");
    // v9.2.4 — every act here that reloads the table (the tab, the create, the
    // rename) is waited for until it has re-rendered, so no render is pending
    // when the search is typed into and a row's button pressed: a press
    // straddling a render opens nothing (rerenderedAfter).
    await expect(page.locator("#groups-tbody tr").first(), "the tab's first load has rendered").toBeAttached({ timeout: 15000 });
    await page.locator('[data-action="group-create"]').click();
    await rerenderedAfter(page, "#groups-tbody", () => answerPrompt(page, name));
    await expect.poll(() => group(name), { timeout: 10000 }).toBeTruthy();
    const id = group(name).id;

    await narrowGroupsTable(page, name);
    const rename = page.locator(`#groups-tbody [data-action="group-rename"][data-group-id="${id}"]`);
    await rename.waitFor({ state: "visible", timeout: 10000 });
    await rename.click();
    await expect(page.locator("#prompt-input"), "the dialog opens on the current name").toHaveValue(name);
    await rerenderedAfter(page, "#groups-tbody", () => answerPrompt(page, renamed));
    await expect.poll(() => dbGet("SELECT name FROM groups WHERE id=?", id)?.name, { timeout: 10000 }).toBe(renamed);

    await narrowGroupsTable(page, renamed);
    const del = page.locator(`#groups-tbody [data-action="group-delete"][data-group-id="${id}"]`);
    await del.waitFor({ state: "visible", timeout: 10000 });
    await del.click();
    await confirmModal(page, /Delete the group/);
    await expect.poll(() => dbGet("SELECT id FROM groups WHERE id=?", id), { timeout: 10000 }).toBeUndefined();
  });
});
