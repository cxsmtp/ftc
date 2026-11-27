// v9.2.5 — a press on an admin table row is never lost to a render around it.
//
// THE PRODUCT. The Events list renders on a 15-second poll whether or not
// anything changed, and a render used to replace every row. A press that goes
// down on a row and comes up on that row's replacement gets no click from
// Chromium (pointer and mouse events arrive, click does not), so an organiser's
// Open, session chip or ⋮ that straddled a tick did nothing, and keyboard focus
// on a row control was dropped every 15 s. renderAdminCompetitions now keeps
// every row a render leaves unchanged (public/js/ui/list-controls.js
// patchTableRows), and the pager likewise (setHtmlIfChanged).
//
// THE SPECS. narrowEventsTable, narrowChallengesTable and narrowPeopleTable
// (tests/ui-admin-helpers.js), the one way specs type into those search boxes
// (scanner: functional-core-b Docs hygiene), return only once the render the
// typing causes has run, after the tab's own load, so a row pressed after them
// is never replaced mid-press. The Groups helper's arm is in phase3-ui.
const { test, expect } = require("./isolated-test");
const { registerPost, BASE } = require("./helpers");
const { adminLogin, clickTab, narrowEventsTable, narrowChallengesTable, narrowPeopleTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const csrfOf = async (page) => (await (await page.request.get("/api/csrf-token")).json()).csrfToken;

// Every setInterval callback the app registers, by id, so a test can run the
// Events poll's own body (the callback behind S.adminCompPollInterval) at the
// moment it chooses instead of waiting up to 15 s for it.
async function recordIntervals(page) {
  await page.addInitScript(() => {
    const orig = window.setInterval, fns = new Map();
    Object.defineProperty(window, "__intervalFns", { value: fns });
    window.setInterval = function (fn, ms, ...rest) {
      const id = orig.call(window, fn, ms, ...rest);
      if (typeof fn === "function") fns.set(id, fn);
      return id;
    };
  });
}

// One tick of the Events list's poll, awaited to its end (the load and its
// render). Returns how many times the table rendered during it.
const pollTick = (page) => page.evaluate(async () => {
  const fn = window.__intervalFns.get(window.S.adminCompPollInterval);
  if (!fn) throw new Error("the Events poll is not running");
  const before = window.S._compRenders;
  await fn();
  return window.S._compRenders - before;
});

async function ownEvents(page, csrf, prefix, names) {
  const ids = {};
  for (const n of names) {
    const r = await page.request.post("/api/admin/competitions", { headers: H(csrf),
      data: { name: `${prefix} ${n}`, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 } });
    expect(r.ok(), `create ${n}: ${r.status()} ${await r.text()}`).toBeTruthy();
    ids[n] = (await r.json()).competition.id;
  }
  return ids;
}

const addTag = async (page, csrf, id, tag) => {
  const r = await page.request.post(`/api/admin/competitions/${id}/tags`, { headers: H(csrf), data: { tag } });
  expect(r.ok(), `tag ${id}: ${r.status()} ${await r.text()}`).toBeTruthy();
};

test.describe("v9.2.5 — the Events list's refresh keeps the rows it does not change", () => {
  test("a refresh that changes nothing keeps every row, the pager and keyboard focus; a changed event's row alone is replaced (control)", async ({ page }) => {
    await recordIntervals(page);
    await adminLogin(page);
    const csrf = await csrfOf(page);
    const prefix = `RowsKept ${Date.now()}`;
    const ids = await ownEvents(page, csrf, prefix, ["A", "B", "C"]);
    await clickTab(page, "Events");
    await narrowEventsTable(page, prefix);
    await expect(page.locator("#admin-comp-body tr.ev-row"), "PRECONDITION: the three own events are listed").toHaveCount(3);

    const pre = await page.evaluate(() => {
      const tb = document.getElementById("admin-comp-body");
      for (const tr of tb.rows) tr.__kept = true;
      const pager = document.getElementById("comp-pagination");
      for (const el of pager.children) el.__kept = true;
      const b = tb.querySelector('button[data-action="comp-open"]');
      b.focus();
      b.__focused = true;
      return { pager: pager.children.length, focused: document.activeElement === b };
    });
    const pagerNodes = pre.pager;
    expect(pre.focused, "PRECONDITION: an Open button holds focus").toBe(true);
    expect(pre.pager, "PRECONDITION: the pager has content to keep").toBeGreaterThan(0);

    expect(await pollTick(page), "the refresh rendered the table").toBeGreaterThan(0);
    const after = await page.evaluate(() => {
      const tb = document.getElementById("admin-comp-body");
      return {
        rows: tb.rows.length,
        kept: [...tb.rows].filter((tr) => tr.__kept).length,
        pager: document.getElementById("comp-pagination").children.length,
        pagerKept: [...document.getElementById("comp-pagination").children].every((el) => el.__kept),
        focusKept: !!(document.activeElement && document.activeElement.__focused),
      };
    });
    expect(after, "a refresh that changed nothing replaced nothing and kept focus").toEqual({ rows: 3, kept: 3, pager: pagerNodes, pagerKept: true, focusKept: true });

    // CONTROL: keeping is not freezing. A change to one event replaces its row,
    // which shows the change, and only that row.
    await addTag(page, csrf, ids.B, "rows-kept-b");
    expect(await pollTick(page), "the refresh rendered the table").toBeGreaterThan(0);
    const rows = await page.evaluate((idB) => [...document.getElementById("admin-comp-body").rows].map((tr) => ({
      isB: !!tr.querySelector(`[data-comp-id="${idB}"]`),
      kept: !!tr.__kept,
      tagged: (tr.textContent || "").includes("rows-kept-b"),
    })), ids.B);
    expect(rows.filter((r) => r.isB), "B's row was replaced and shows its new tag").toEqual([{ isB: true, kept: false, tagged: true }]);
    expect(rows.filter((r) => !r.isB).map((r) => r.kept), "A's and C's rows were kept").toEqual([true, true]);
  });

  test("a press that straddles a refresh still opens the event; one whose row the refresh replaced does not (control)", async ({ page }) => {
    await recordIntervals(page);
    await adminLogin(page);
    const csrf = await csrfOf(page);
    const prefix = `PressKept ${Date.now()}`;
    const ids = await ownEvents(page, csrf, prefix, ["A", "C"]);
    await clickTab(page, "Events");
    await narrowEventsTable(page, prefix);
    await expect(page.locator("#admin-comp-body tr.ev-row"), "PRECONDITION: the two own events are listed").toHaveCount(2);
    // Every click the page dispatches, by the action of the control it reached.
    await page.evaluate(() => {
      window.__rpClicks = [];
      document.addEventListener("click", (e) => {
        const a = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        window.__rpClicks.push(a ? a.dataset.action : String(e.target && e.target.nodeName));
      }, true);
    });
    // Down on the row's Open button, one refresh, up at the same point.
    const press = async (id, during) => {
      const btn = page.locator(`#admin-comp-body button[data-action="comp-open"][data-comp-id="${id}"]`);
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await during();
      expect(await pollTick(page), "the refresh rendered the table mid-press").toBeGreaterThan(0);
      await page.mouse.up();
      return page.evaluate(() => window.__rpClicks.splice(0));
    };

    // CONTROL first, as it leaves the list on screen: this refresh replaces C's
    // row mid-press (its tags changed), and the press opens nothing.
    const lost = await press(ids.C, () => addTag(page, csrf, ids.C, "press-control"));
    expect(lost, "CONTROL: a press whose row the refresh replaced gets no click").toEqual([]);
    await expect(page.locator("#admin-scope-banner"), "CONTROL: no workspace opened").toBeHidden();

    // A's row is unchanged by the refresh, so its node stays and the press lands.
    const landed = await press(ids.A, async () => {});
    expect(landed, "the press survived the refresh").toEqual(["comp-open"]);
    await expect(page.locator("#admin-scope-banner"), "the event's workspace opened").toBeVisible();
    await expect(page.locator("#ws-title")).toContainText(`${prefix} A`);
  });
});

test.describe("v9.2.5 — the narrowing helpers leave no render pending", () => {
  // Did the table render within one debounce of now? A page timer started now
  // with a timeout of at least the box's 160 ms runs after every timer the page
  // started earlier with an equal or shorter timeout (HTML timer ordering), so
  // a render the typing left pending lands inside the window: no race.
  const rendersWithinOneDebounce = (page, tbodyId, boxId, typeFirst) => page.evaluate(([tbodyId, boxId, typeFirst]) => new Promise((resolve) => {
    const tb = document.getElementById(tbodyId);
    let n = 0;
    const mo = new MutationObserver((ms) => { n += ms.length; });
    mo.observe(tb, { childList: true });
    if (typeFirst) {
      const box = document.getElementById(boxId);
      box.value = typeFirst;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setTimeout(() => { mo.disconnect(); resolve(n); }, 250);
  }), [tbodyId, boxId, typeFirst]);

  // The tab's next read is held back 1.5 s, so a helper that types at once
  // lands before that load renders (a load landing after the typing renders
  // the rows again): it must wait for the load as well as for its own render.
  const holdNextRead = async (page, re) => {
    const st = { held: false, released: false };
    await page.route(re, async (route) => {
      if (!st.held && route.request().method() === "GET") {
        st.held = true;
        await new Promise((r) => setTimeout(r, 1500));
        st.released = true;
      }
      await route.continue();
    });
    return st;
  };

  const expectSettled = async (page, st, tbodyId, boxId, other) => {
    expect(st.held, "PRECONDITION: the tab's load was held back").toBe(true);
    expect(st.released, "the helper waited for the tab's load, not only for the typing's render").toBe(true);
    expect(await rendersWithinOneDebounce(page, tbodyId, boxId, null), "no render is left pending once the helper returns").toBe(0);
    // CONTROL: the same window does see a render that typing leaves pending.
    return () => rendersWithinOneDebounce(page, tbodyId, boxId, other);
  };

  test("narrowEventsTable", async ({ page }) => {
    await adminLogin(page);
    const csrf = await csrfOf(page);
    const prefix = `NarrowEv ${Date.now()}`;
    await ownEvents(page, csrf, prefix, ["one", "two"]);
    const st = await holdNextRead(page, /\/api\/admin\/competitions$/);
    await clickTab(page, "Events");
    // A render landing between the helper's first look and its typing (as the
    // poll's can) draws the OLD text and raises the count: it must not pass for
    // the typing's own render. Typing focuses the box first, so render then.
    await page.evaluate(() => document.getElementById("comp-search").addEventListener("focus", () => window.renderAdminCompetitions(), { once: true }));
    await narrowEventsTable(page, `${prefix} one`);
    const control = await expectSettled(page, st, "admin-comp-body", "comp-search", prefix);
    await expect(page.locator("#admin-comp-body tr.ev-row")).toHaveCount(1);
    await expect(page.locator("#admin-comp-body tr.ev-row")).toContainText(`${prefix} one`);
    expect(await control(), "CONTROL: a render typing leaves pending is seen").toBeGreaterThan(0);
  });

  test("narrowEventsTable types into an empty Events list (an organiser with no events) and returns", async ({ page }) => {
    const { apiLogin, PARTICIPANT_PASS } = require("./helpers");
    const { makeAdmin } = require("./admin-inflight-helpers");
    const { loginViaApi } = require("./ui-admin-helpers");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const ea = await makeAdmin(sa, saCsrf, "rpnoevents", "event_admin");
      await loginViaApi(page, ea.email, PARTICIPANT_PASS);
      await page.goto("/");
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 30000 });
      await expect(page.locator("#admin-comp-body tr"), "PRECONDITION: the organiser's Events list is empty").toHaveText(/No events/);
      await narrowEventsTable(page, "nothing here");
      await expect(page.locator("#admin-comp-body tr")).toHaveText("No events match the current search.");
    } finally { await sa.dispose(); }
  });

  test("narrowChallengesTable", async ({ page }) => {
    await adminLogin(page);
    const csrf = await csrfOf(page);
    const prefix = `NarrowCh ${Date.now()}`;
    for (const n of ["one", "two"]) {
      const r = await page.request.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `${prefix} ${n}`, description: "<p>Name the word.</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "word", status: "published" } });
      expect(r.ok(), `seed ${n}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const st = await holdNextRead(page, /\/api\/admin\/tasks(\?[^/]*)?$/);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, `${prefix} one`);
    const control = await expectSettled(page, st, "admin-task-body", "task-search", prefix);
    await expect(page.locator("#admin-task-body tr", { hasText: prefix })).toHaveCount(1);
    expect(await control(), "CONTROL: a render typing leaves pending is seen").toBeGreaterThan(0);
  });

  test("narrowPeopleTable", async ({ page }) => {
    await adminLogin(page);
    const csrf = await csrfOf(page);
    const stamp = Date.now();
    const nicks = [`narrowpp${stamp}a`, `narrowpp${stamp}b`];
    for (const nickname of nicks) {
      const r = await registerPost(page.request, "/api/register", { headers: H(csrf), keepState: true, data: {
        firstName: "Narrow", lastName: "People", nickname, email: `${nickname}@acme.com`,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC" } });
      expect(r.status(), `register ${nickname}: ${r.status()} ${await r.text()}`).toBeLessThan(400);
    }
    const st = await holdNextRead(page, /\/api\/admin\/participants\?/);
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, nicks[0]);
    const control = await expectSettled(page, st, "admin-participants-body", "participants-search", `narrowpp${stamp}`);
    await expect(page.locator("#admin-participants-body tr", { hasText: `narrowpp${stamp}` })).toHaveCount(1);
    expect(await control(), "CONTROL: a render typing leaves pending is seen").toBeGreaterThan(0);
  });
});
