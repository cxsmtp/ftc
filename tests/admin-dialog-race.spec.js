// @ts-check
//
// v8.12.6 — THE JOIN-LINK AND HISTORY DIALOGS SHOW THE EVENT YOU OPENED.
//
// The same out-of-order class as the participant's challenge view
// (challenge-view-race.spec.js), on two admin dialogs whose openers await the
// network and only then build the dialog. Measured on the unfixed tree:
//   * JOIN LINK, opened for event A (reveal slow) and then B: TWO
//     #self-enroll-overlay stacked; the dialog TITLED B showed A's QR, and ticking
//     "Enable self-enrollment" in it sent a PUT to B AND to A — the server then
//     reported a live join link on an event nobody had touched. Every control was
//     bound with document.getElementById, which returns the FIRST dialog.
//   * JOIN LINK, Regenerate on A (slow), Close, open B: A's new link and QR were
//     written into B's dialog when the regenerate answered.
//   * HISTORY, opened for A (slow) and then B: two #hist-overlay, the state A's,
//     and A's rows painted into the first dialog.
//   * HISTORY "Load older" for A in flight, Close, open B: A's older page was
//     appended into B's dialog.
//
// v8.12.6 (sweep) — the same class on the three CHALLENGE dialogs (the event's
// challenge picker, "Assign to Events", "Grant Attempts"), whose openers removed
// the old dialog BEFORE the await (or appended after it with no removal at all)
// and bound their controls by id; on a restore that closed WHATEVER History
// dialog was up when it answered; and on the help drawer, where a slow first
// document replaced the one asked for after it.
//
// The positives here are their own controls: each arm asserts the dialog shows
// the event it was opened for (link, QR, rows), so "nothing leaked" cannot be
// satisfied by a build that renders no dialog at all. Holds are page.route
// promises released by hand, each with an anti-vacuity "it really was held".
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, BASE } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const crypto = require("crypto");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

/** Two upcoming events with self-enrollment OFF, and their join links. */
async function twoEvents() {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const mk = async (name) => {
      const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 } });
      expect(r.status(), await r.text()).toBe(200);
      const c = (await r.json()).competition;
      expect(!!c.self_enroll_enabled, `${name} must start with its join link OFF`).toBe(false);
      return c.id;
    };
    const A = { name: `Alpha Event ${t}` }, B = { name: `Bravo Event ${t}` };
    A.id = await mk(A.name); B.id = await mk(B.name);
    for (const e of [A, B]) {
      const r = await sa.get(`/api/admin/competitions/${e.id}/self-enroll`);
      expect(r.ok(), await r.text()).toBeTruthy();
      const rv = await r.json();
      e.url = rv.url;
      e.display = rv.join_code_display;
      expect(e.url, "a reveal returns the join link").toBeTruthy();
      expect(e.display, "a reveal returns the short join code").toBeTruthy();
    }
    expect(A.url).not.toBe(B.url);
    return { A, B };
  } finally { await sa.dispose(); }
}

/** Sign the superadmin in (after the API set-up — one session per user) and wait for both events. */
async function enterAdmin(page, ev) {
  await adminLogin(page);
  await expect.poll(() => page.evaluate(([a, b]) => {
    const d = window.adminCompetitionsData || [];
    return d.some(c => c.id === a) && d.some(c => c.id === b);
  }, [ev.A.id, ev.B.id]), { timeout: 15000 }).toBe(true);
}

async function gate(page, method, match) {
  const st = { held: 0 };
  let open; const opened = new Promise(r => { open = r; });
  await page.route((u) => match(u), async (route) => {
    if (route.request().method() !== method) return route.continue();
    st.held++;
    await opened;
    return route.continue();
  });
  return { held: () => st.held, release: () => open() };
}
async function waitHeld(g) {
  await expect.poll(() => g.held(), { timeout: 10000, message: "the request was never held — the arm would be vacuous" }).toBeGreaterThan(0);
}
async function fire(page, flag, name, ...args) {
  await page.evaluate(([flag, name, args]) => {
    window[flag] = false;
    window[name](...args).then(() => { window[flag] = true; }, (e) => { window[flag] = "rejected: " + (e && e.message); });
  }, [flag, name, args]);
}
async function settled(page, flag) {
  await expect.poll(() => page.evaluate((f) => window[f], flag), { timeout: 15000 }).toBe(true);
}

/** Every Join Link dialog on the page, as the admin sees it. */
const joinDialogs = (page, refs) => page.evaluate((refs) => [...document.querySelectorAll("#self-enroll-overlay")].map(o => {
  const q = o.querySelector("#self-enroll-qr")?.innerHTML || "";
  return { title: o.querySelector("#self-enroll-title")?.textContent || "",
    link: o.querySelector("#self-enroll-input")?.value || "",
    code: o.querySelector("#self-enroll-code")?.textContent || "",
    qr: q === refs.A ? "A" : q === refs.B ? "B" : (q ? "other" : "empty") };
}), refs);

/** The QR markup a correct render of each event's link produces. */
async function qrRefs(page, ev) {
  // The dialog draws the centred-code QR (self-enroll.js `_renderJoinQrInto`,
  // the event code in its middle), so the reference is drawn the same way.
  return page.evaluate(async ([ua, ca, ub, cb]) => {
    const a = document.createElement("div"), b = document.createElement("div");
    const okA = await window._renderJoinQrInto(a, ua, ca), okB = await window._renderJoinQrInto(b, ub, cb);
    if (!okA || !okB) throw new Error("the centred-code QR did not render");
    return { A: a.innerHTML, B: b.innerHTML };
  }, [ev.A.url, ev.A.display, ev.B.url, ev.B.display]);
}

test.describe("v8.12.6 — the Join Link dialog shows the event it was opened for", () => {
  test("opened for A (slow) then B: ONE dialog, B's link and QR, and its toggle writes B only", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    const refs = await qrRefs(page, ev);
    const g = await gate(page, "GET", (u) => u.pathname === `/api/admin/competitions/${ev.A.id}/self-enroll`);
    await fire(page, "__jA", "openSelfEnrollOverlay", ev.A.id, ev.A.name);
    await waitHeld(g);
    await fire(page, "__jB", "openSelfEnrollOverlay", ev.B.id, ev.B.name);
    await settled(page, "__jB");
    await expect.poll(async () => (await joinDialogs(page, refs)).map(d => d.qr).join(",")).toBe("B");
    g.release();
    await settled(page, "__jA");
    const dialogs = await joinDialogs(page, refs);
    expect(dialogs, "the superseded open for A must not add a dialog, or replace B's").toHaveLength(1);
    expect(dialogs[0].title).toContain(ev.B.name);
    expect(dialogs[0].link).toBe(ev.B.url);
    expect(dialogs[0].qr, "the QR is B's link").toBe("B");

    const puts = [];
    page.on("request", (rq) => { if (rq.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+$/.test(new URL(rq.url()).pathname)) puts.push(new URL(rq.url()).pathname.split("/").pop()); });
    await page.locator("#self-enroll-overlay #self-enroll-enabled").check();
    await expect(page.locator("#toast-stack .toast", { hasText: "Self-enrollment enabled" })).toBeVisible();
    expect(puts, "the toggle in B's dialog writes B, and only B").toEqual([ev.B.id]);
    const list = await (await page.request.get("/api/admin/competitions")).json();
    const arr = Array.isArray(list) ? list : (list.competitions || []);
    const enabled = (id) => !!(arr.find(c => c.id === id) || {}).self_enroll_enabled;
    expect(enabled(ev.B.id), "B's join link is live").toBe(true);
    expect(enabled(ev.A.id), "A was never touched").toBe(false);
  });

  test("Regenerate on A answered after A was closed and B opened: B's dialog keeps B's link and QR", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    const refs = await qrRefs(page, ev);
    await fire(page, "__jA", "openSelfEnrollOverlay", ev.A.id, ev.A.name);
    await settled(page, "__jA");
    await expect.poll(async () => (await joinDialogs(page, refs)).map(d => d.qr).join(",")).toBe("A");
    await page.locator("#self-enroll-overlay [data-action='self-enroll-regenerate']").click();
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Regenerate link");
    const g = await gate(page, "POST", (u) => u.pathname === `/api/admin/competitions/${ev.A.id}/self-enroll/regenerate`);
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await waitHeld(g);
    await page.locator("#self-enroll-overlay [data-action='self-enroll-close']").click();
    await expect(page.locator("#self-enroll-overlay")).toHaveCount(0);
    await fire(page, "__jB", "openSelfEnrollOverlay", ev.B.id, ev.B.name);
    await settled(page, "__jB");
    await expect.poll(async () => (await joinDialogs(page, refs)).map(d => d.qr).join(",")).toBe("B");
    g.release();
    // The regenerate really answered (A has a new link) before anything is judged.
    await expect(page.locator("#toast-stack .toast", { hasText: "Link regenerated" })).toBeVisible();
    const dialogs = await joinDialogs(page, refs);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].title).toContain(ev.B.name);
    expect(dialogs[0].link, "A's new link must not be written into B's dialog").toBe(ev.B.url);
    expect(dialogs[0].qr, "nor A's new QR").toBe("B");
    // v8.13.3 — a regenerate rotates the short code too, and it must land in A's
    // (closed) dialog, never in B's.
    expect(dialogs[0].code, "nor A's new short code").toBe(ev.B.display);
  });
});

// History responses are MOCKED here: the subject is purely client ordering, and
// "Load older" needs more events than one page holds (500), which the real
// endpoint would only give us after writing hundreds of rows.
function evs(n, marker, off = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: `${marker}-${off + i}`, event_type: "edited",
    changed_by: `${marker}@history.example`, changed_at: new Date(Date.UTC(2026, 0, 1) - (off + i) * 60_000).toISOString(),
    details: { marker } }));
}
const histState = (page) => page.evaluate(() => ({
  overlays: document.querySelectorAll("#hist-overlay").length,
  title: document.getElementById("hist-title")?.textContent || "",
  stateTitle: window._histState?.title || null,
  n: window._histState?.items?.length ?? null,
  markers: [...new Set((window._histState?.items || []).map(i => i.raw?.details?.marker))],
  body: (document.getElementById("hist-body")?.textContent || ""),
}));

test.describe("v8.12.6 — a History dialog shows what it was opened for", () => {
  test("opened for A (slow) then B: ONE dialog, B's rows", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    let releaseA; const aGate = new Promise(r => { releaseA = r; }); let heldA = 0;
    await page.route((u) => /^\/api\/admin\/competitions\/[^/]+\/events$/.test(u.pathname), async (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[4];
      if (id === ev.A.id) { heldA++; await aGate; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(4, "A"), total: 4 }) }); }
      if (id === ev.B.id) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(3, "B"), total: 3 }) });
      return route.fallback();
    });
    await fire(page, "__hA", "showCompetitionHistory", ev.A.id);
    await expect.poll(() => heldA).toBeGreaterThan(0);
    await fire(page, "__hB", "showCompetitionHistory", ev.B.id);
    await settled(page, "__hB");
    expect((await histState(page)).markers).toEqual(["B"]);
    releaseA();
    await settled(page, "__hA");
    const s = await histState(page);
    expect(s.overlays, "the superseded open for A must not stack a second dialog").toBe(1);
    expect(s.title).toContain(ev.B.name);
    expect(s.stateTitle).toContain(ev.B.name);
    expect(s.markers, "B's rows only").toEqual(["B"]);
    expect(s.n).toBe(3);
    expect(s.body).toContain("B@history.example");
    expect(s.body).not.toContain("A@history.example");
  });

  test("'Load older' for A answered after A was closed and B opened: nothing is appended to B", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    let releaseOlder; const olderGate = new Promise(r => { releaseOlder = r; }); let heldOlder = 0;
    await page.route((u) => /^\/api\/admin\/competitions\/[^/]+\/events$/.test(u.pathname), async (route) => {
      const u = new URL(route.request().url());
      const id = u.pathname.split("/")[4];
      const off = parseInt(u.searchParams.get("offset") || "0", 10);
      if (id === ev.A.id && off === 0) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(500, "A"), total: 600 }) });
      if (id === ev.A.id) { heldOlder++; await olderGate; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(100, "Aolder", 500), total: 600 }) }); }
      // B holds exactly as many rows as A had loaded (500), so only the "is this
      // still the dialog I was asked for?" half of the guard can refuse the page —
      // a row count that merely differs would refuse it for the wrong reason.
      if (id === ev.B.id) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(500, "B"), total: 500 }) });
      return route.fallback();
    });
    await fire(page, "__hA", "showCompetitionHistory", ev.A.id);
    await settled(page, "__hA");
    await expect(page.locator("#hist-overlay [data-action='history-load-more']")).toBeVisible();
    await fire(page, "__more", "loadMoreHistory");
    await expect.poll(() => heldOlder).toBeGreaterThan(0);
    await page.locator("#hist-overlay [data-action='history-close']").click();
    await expect(page.locator("#hist-overlay")).toHaveCount(0);
    await fire(page, "__hB", "showCompetitionHistory", ev.B.id);
    await settled(page, "__hB");
    expect((await histState(page)).n).toBe(500);
    releaseOlder();
    await settled(page, "__more");
    const s = await histState(page);
    expect(s.title).toContain(ev.B.name);
    expect(s.markers, "A's older page must not land in B's dialog").toEqual(["B"]);
    expect(s.n).toBe(500);
  });

  test("'Load older' for A that FAILS after A was closed and B opened says nothing over B's dialog", async ({ page }) => {
    // An error for a request the admin has moved on from is its own wrong answer
    // (the v7.21.15 rule): it would read as B's history failing to load.
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    let releaseOlder; const olderGate = new Promise(r => { releaseOlder = r; }); let heldOlder = 0;
    await page.route((u) => /^\/api\/admin\/competitions\/[^/]+\/events$/.test(u.pathname), async (route) => {
      const u = new URL(route.request().url());
      const id = u.pathname.split("/")[4];
      const off = parseInt(u.searchParams.get("offset") || "0", 10);
      if (id === ev.A.id && off === 0) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(500, "A"), total: 600 }) });
      if (id === ev.A.id) { heldOlder++; await olderGate; return route.fulfill({ status: 500, contentType: "application/json", body: "{}" }); }
      if (id === ev.B.id) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(3, "B"), total: 3 }) });
      return route.fallback();
    });
    await fire(page, "__hA", "showCompetitionHistory", ev.A.id);
    await settled(page, "__hA");
    await fire(page, "__more", "loadMoreHistory");
    await expect.poll(() => heldOlder).toBeGreaterThan(0);
    await page.locator("#hist-overlay [data-action='history-close']").click();
    await fire(page, "__hB", "showCompetitionHistory", ev.B.id);
    await settled(page, "__hB");
    releaseOlder();
    await settled(page, "__more");
    const toasts = await page.evaluate(() => [...document.querySelectorAll("#toast-stack .toast")].map(t => t.textContent));
    expect(toasts.join(" | ")).not.toContain("Could not load older history");
    expect((await histState(page)).markers).toEqual(["B"]);
  });

  test("CONTROL: 'Load older' answered while its own dialog is open is appended — once, even when clicked twice", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    let releaseOlder; const olderGate = new Promise(r => { releaseOlder = r; }); let heldOlder = 0;
    await page.route((u) => u.pathname === `/api/admin/competitions/${ev.A.id}/events`, async (route) => {
      const off = parseInt(new URL(route.request().url()).searchParams.get("offset") || "0", 10);
      if (off === 0) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(500, "A"), total: 600 }) });
      heldOlder++; await olderGate;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(100, "Aolder", 500), total: 600 }) });
    });
    await fire(page, "__hA", "showCompetitionHistory", ev.A.id);
    await settled(page, "__hA");
    // A double-click: both requests ask for the same offset, so the second to
    // answer would append the same hundred rows again.
    await fire(page, "__more", "loadMoreHistory");
    await fire(page, "__more2", "loadMoreHistory");
    await expect.poll(() => heldOlder).toBe(2);
    releaseOlder();
    await settled(page, "__more");
    await settled(page, "__more2");
    const s = await histState(page);
    expect(s.n, "the older page is appended exactly once").toBe(600);
    expect(s.markers.sort()).toEqual(["A", "Aolder"]);
    await expect(page.locator("#hist-overlay [data-action='history-load-more']")).toHaveCount(0);
  });
});

// v8.12.6 — A ROW MENU CLOSED BEFORE ITS CLICK-OUTSIDE LISTENER WAS ARMED BROKE
// EVERY LATER ROW MENU UNTIL A RELOAD. Found as a full-suite flake
// (sealed-reveal-ui "(a)" failed on its THIRD kebab open, 1 in 4 under
// --repeat-each=4), not by review. toggleKebab arms its click-outside listener
// in a setTimeout(0) so the click that opened the menu cannot close it — and
// closeKebab() removes only a listener that is ALREADY armed. A close landing in
// that window (an Escape the browser ran ahead of the timer, which it does:
// input outranks timers; or a second kebab clicked in the same moment) left the
// timer to arm a listener nothing would ever remove. That orphan closes the
// portal on EVERY later click that is not on its own long-gone trigger —
// including the click that just opened the next menu, so each open closed
// itself on the spot, and each close armed another orphan.
//
// The race is driven in ONE task, which is the only way to land a close ahead
// of a setTimeout(0) on purpose; every assertion about the RESULT is a real
// click. Each arm carries its CONTROL — an ordinary open of the same kebab —
// or "the menu is open" would be satisfied by a table with no menus at all.
test.describe("v8.12.6 — a row menu closed before its click-outside listener is armed", () => {
  const portal = (page) => page.locator("#kebab-portal");
  const kebabs = (page) => page.locator("#admin-comp-body .kebab-btn");

  async function eventsPane(page) {
    await adminLogin(page);
    await expect.poll(() => kebabs(page).count(), { timeout: 15000,
      message: "the Events table must hold two row menus, or there is nothing to race" }).toBeGreaterThan(1);
    // CONTROL: an ordinary open and Escape on the kebab the arms click last.
    await kebabs(page).nth(1).click();
    await expect(portal(page), "CONTROL: an ordinary row menu opens").toBeVisible();
    await page.keyboard.press("Escape");
    await expect(portal(page)).toBeHidden();
  }
  /** Let the deferred arming (setTimeout 0) run, so an orphan — if any — is in place. */
  const tick = (page) => page.evaluate(() => new Promise(r => setTimeout(r, 50)));

  async function nextMenuStaysOpen(page) {
    await kebabs(page).nth(1).click();
    await expect(portal(page), "the next row menu opens — an orphaned listener closes it on the same click").toBeVisible({ timeout: 2000 });
    await tick(page);
    await expect(portal(page), "…and stays open").toBeVisible();
    await expect(portal(page).locator("[data-action]").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(portal(page)).toBeHidden();
  }

  test("a menu opened and closed (Escape) before its listener armed: the NEXT menu still opens and stays open", async ({ page }) => {
    await eventsPane(page);
    await page.evaluate(() => {
      const b = document.querySelectorAll("#admin-comp-body .kebab-btn")[0];
      b.click();
      const p = document.getElementById("kebab-portal");
      if (!p.classList.contains("open")) throw new Error("the synchronous open did not happen — the race would be vacuous");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (p.classList.contains("open")) throw new Error("the synchronous Escape did not close the menu");
    });
    await tick(page);
    await nextMenuStaysOpen(page);
  });

  test("two menus opened in one moment: the first one's listener is not orphaned, and a later menu still opens", async ({ page }) => {
    await eventsPane(page);
    await page.evaluate(() => {
      const [a, b] = document.querySelectorAll("#admin-comp-body .kebab-btn");
      a.click(); b.click();
      if (document.getElementById("kebab-portal")._srcBtn !== b) throw new Error("the second open did not take the portal");
    });
    await tick(page);
    await page.keyboard.press("Escape");
    await expect(portal(page)).toBeHidden();
    await nextMenuStaysOpen(page);
  });
});

// ---------------------------------------------------------------------------
// v8.12.6 (sweep) — THE THREE CHALLENGE DIALOGS SHOW WHAT YOU OPENED.
//
// The Join Link / History class above, on the three challenge openers that
// await the network and only then build their dialog: the competition-side
// challenge picker, "Assign to Events" and "Grant Attempts". Each had neither a
// sequence token nor a post-await replacement, so two opens in flight appended
// TWO dialogs with the same id — the one that landed LAST on top, whatever the
// admin asked for last — and every control was found by document.getElementById,
// i.e. in the other dialog. Plus the THREE SAVES that close their dialog after
// an await (the picker's Save, Assign to Events, Grant Attempts): they closed by
// id, so a dialog the admin had opened meanwhile for another challenge — or, for
// the picker, another event — was the one that vanished. (The picker's save was
// missed by the sweep and fixed by the review, which also found it wiping the
// new dialog's ticks: its state lives on `S`, and it reset that unconditionally.)
//
// Each arm asserts the surviving dialog is the one asked for LAST (title, and
// what its Save writes), so "one dialog" cannot be satisfied by a build that
// renders none. The admin Events poll is STOPPED in these arms: it re-reads
// `/api/admin/competitions` every 15 s — the very URL two of these openers load —
// and a poll landing in the hold would take the gate instead of the opener.
// ---------------------------------------------------------------------------

/** Two published challenges with an attempt limit, both in one upcoming event, and a participant enrolled in it. */
async function challengeWorld() {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t = uniq();
    const cr = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Echo Event ${t}`, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 } });
    expect(cr.status(), await cr.text()).toBe(200);
    const E = { id: (await cr.json()).competition.id, name: `Echo Event ${t}` };
    const cr2 = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Foxtrot Event ${t}`, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 } });
    expect(cr2.status(), await cr2.text()).toBe(200);
    const F = { id: (await cr2.json()).competition.id, name: `Foxtrot Event ${t}` };
    const mkTask = async (title) => {
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "k",
        status: "published", attempt_cap: 3 } });
      expect(r.status(), await r.text()).toBe(200);
      const id = (await r.json()).id;
      const a = await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [E.id] } });
      expect(a.status(), await a.text()).toBe(200);
      return { id, title };
    };
    const X = await mkTask(`Xray ${t}`), Y = await mkTask(`Yankee ${t}`);
    const email = `dlg${t}@company.example`;
    const { api: anon, csrf: ac } = await freshCtx();
    try {
      const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
        firstName: "Dialog", lastName: "Race", nickname: `dlg${t}`, email, company: "Acme Ltd", title: "Eng",
        country: "US", timezone: "America/New_York", password: "chosen-at-signup-1",
        jobFunction: "Software Developer / Engineer", city: "NYC" } });
      expect(reg.status(), await reg.text()).toBeLessThan(400);
    } finally { await anon.dispose(); }
    const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const P = list.participants.find(p => p.email === email);
    expect(P, "the participant exists").toBeTruthy();
    for (const a of ["verify", "approve"]) {
      const r = await sa.post(`/api/admin/participants/${P.id}/${a}`, { headers: H(csrf) });
      expect(r.ok(), `${a}: ${await r.text()}`).toBeTruthy();
    }
    const asg = await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [P.id], competitionIds: [E.id] } });
    expect((await asg.json()).assigned, "the participant enrols in the capped event").toBe(1);
    return { E, F, X, Y, P: { id: P.id, nickname: `dlg${t}` } };
  } finally { await sa.dispose(); }
}

/** Sign in, load both challenges into the admin model, and stop the Events poll (see above). */
async function enterChallenges(page, w) {
  await adminLogin(page);
  await page.evaluate(() => { window.loadAdminTasks(); });
  await expect.poll(() => page.evaluate(([x, y]) => {
    const d = window.adminTasksData || [];
    return d.some(t => t.id === x) && d.some(t => t.id === y);
  }, [w.X.id, w.Y.id]), { timeout: 15000 }).toBe(true);
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
}

/** Hold the FIRST GET of `pathname` after arming; let every later one through. */
async function holdFirst(page, pathname) {
  const st = { seen: 0, held: 0 };
  let open; const opened = new Promise(r => { open = r; });
  await page.route((u) => u.pathname === pathname, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (++st.seen > 1) return route.continue();
    st.held++;
    await opened;
    return route.continue();
  });
  return { held: () => st.held, release: () => open() };
}

const dialogs = (page, sel, titleSel) => page.evaluate(([sel, titleSel]) =>
  [...document.querySelectorAll(sel)].map(o => o.querySelector(titleSel)?.textContent || ""), [sel, titleSel]);

test.describe("v8.12.6 (sweep) — the challenge dialogs show what they were opened for", () => {
  test("challenge picker opened for event A (slow) then B: ONE dialog, B's, and its Save writes B", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    const g = await holdFirst(page, "/api/admin/tasks");
    await fire(page, "__pA", "openTaskPickerForCompetition", ev.A.id);
    await waitHeld(g);
    await fire(page, "__pB", "openTaskPickerForCompetition", ev.B.id);
    await settled(page, "__pB");
    g.release();
    await settled(page, "__pA");
    const d = await dialogs(page, "#task-picker-overlay", "#task-picker-title");
    expect(d, "the superseded open for A must not add a dialog over B's").toHaveLength(1);
    expect(d[0]).toContain(ev.B.name);
    // …and it is B's dialog that acts: tick one challenge, save, and the write names B.
    const posts = [];
    page.on("request", (rq) => { if (rq.method() === "POST" && /^\/api\/admin\/tasks\/[^/]+\/competitions$/.test(new URL(rq.url()).pathname)) posts.push(rq.postDataJSON()); });
    const box = page.locator("#task-picker-overlay #task-picker-list input[type=checkbox]:not(:checked):not([disabled])").first();
    await box.check();
    await expect(page.locator("#task-picker-overlay #task-picker-count")).toContainText("1 to add");
    await page.locator("#task-picker-overlay #task-picker-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect.poll(() => posts.length, { timeout: 10000 }).toBe(1);
    expect(posts[0].competitionIds, "the save writes B, the event the surviving dialog is for").toEqual([ev.B.id]);
  });

  // v8.12.6 (review) — the picker's SAVE, answered after the admin closed its
  // dialog and opened the picker for another event. Measured on the tree before
  // the fix: the save removed the new dialog by id and nulled its state, so the
  // admin's unsaved ticks were lost and the toast spoke over an empty screen.
  test("challenge picker Save answered after its dialog was closed and B's opened: B's dialog stays open, its ticks survive, and its own Save still writes B", async ({ page }) => {
    const w = await challengeWorld();
    await enterChallenges(page, w);
    await expect.poll(() => page.evaluate(([e, f]) => {
      const d = window.adminCompetitionsData || [];
      return d.some(c => c.id === e) && d.some(c => c.id === f);
    }, [w.E.id, w.F.id]), { timeout: 15000 }).toBe(true);
    // A = the picker for F (X is not in F yet); tick X and save, with the POST held.
    await fire(page, "__pA", "openTaskPickerForCompetition", w.F.id);
    await settled(page, "__pA");
    await page.locator(`#task-picker-overlay input[type=checkbox][value="${w.X.id}"]`).check();
    let release; const gate0 = new Promise(r => { release = r; }); let held = 0;
    await page.route((u) => u.pathname === `/api/admin/tasks/${w.X.id}/competitions`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      held++; await gate0; return route.continue();
    });
    await page.locator("#task-picker-overlay #task-picker-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect.poll(() => held, { message: "the save was held — the arm is vacuous otherwise" }).toBe(1);
    // The admin cancels A (the dialog stays usable while its save runs) and opens B.
    await page.locator("#task-picker-overlay [data-action='overlay-close']").click();
    await expect(page.locator("#task-picker-overlay")).toHaveCount(0);
    await fire(page, "__pB", "openTaskPickerForCompetition", w.E.id);
    await settled(page, "__pB");
    await page.locator(`#task-picker-overlay input[type=checkbox][value="${w.Y.id}"]`).uncheck();
    await expect(page.locator("#task-picker-overlay #task-picker-count")).toContainText("1 to remove");
    release();
    // The held save really answered before anything is judged.
    await expect(page.locator("#toast-stack .toast", { hasText: "1 added." })).toBeVisible();
    const d = await dialogs(page, "#task-picker-overlay", "#task-picker-title");
    expect(d, "A's save must not close the dialog the admin opened for B meanwhile").toHaveLength(1);
    expect(d[0]).toContain(w.E.name);
    const st = await page.evaluate(([x, y]) => {
      const c = window.S._pickerCheckedIds, b = window.S._pickerBaseline;
      return { alive: !!c && !!b, x: !!c && c.has(x), y: !!c && c.has(y), base: b ? b.size : -1 };
    }, [w.X.id, w.Y.id]);
    expect(st.alive, "…nor wipe B's state").toBe(true);
    expect(st.y, "B's unsaved untick survives").toBe(false);
    expect(st.x, "…and B's other tick").toBe(true);
    await expect(page.locator("#task-picker-overlay #task-picker-count")).toContainText("1 to remove");
    await expect(page.locator(`#task-picker-overlay input[type=checkbox][value="${w.Y.id}"]`)).not.toBeChecked();
    // …and B's own Save still works on B's state: it removes Y from B, nothing else.
    const dels = [];
    page.on("request", (rq) => { if (rq.method() === "DELETE" && /^\/api\/admin\/tasks\/[^/]+\/competitions\/[^/]+$/.test(new URL(rq.url()).pathname)) dels.push(new URL(rq.url()).pathname); });
    await page.locator("#task-picker-overlay #task-picker-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "1 removed." })).toBeVisible();
    expect(dels, "B's save removes Y from B").toEqual([`/api/admin/tasks/${w.Y.id}/competitions/${encodeURIComponent(w.E.id)}`]);
    await expect(page.locator("#task-picker-overlay"), "…and closes its own dialog").toHaveCount(0);
  });

  test("CONTROL: a challenge picker Save answered while its own dialog is still open closes that dialog and clears its state", async ({ page }) => {
    const w = await challengeWorld();
    await enterChallenges(page, w);
    await fire(page, "__pA", "openTaskPickerForCompetition", w.F.id);
    await settled(page, "__pA");
    await page.locator(`#task-picker-overlay input[type=checkbox][value="${w.Y.id}"]`).check();
    let release; const gate0 = new Promise(r => { release = r; }); let held = 0;
    await page.route((u) => u.pathname === `/api/admin/tasks/${w.Y.id}/competitions`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      held++; await gate0; return route.continue();
    });
    await page.locator("#task-picker-overlay #task-picker-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect.poll(() => held, { message: "the save was held" }).toBe(1);
    await expect(page.locator("#task-picker-overlay"), "PRECONDITION: the dialog is still open while its save runs").toHaveCount(1);
    release();
    await expect(page.locator("#toast-stack .toast", { hasText: "1 added." })).toBeVisible();
    await expect(page.locator("#task-picker-overlay"), "the save closes its own dialog").toHaveCount(0);
    const st = await page.evaluate(() => ({ c: window.S._pickerCheckedIds, b: window.S._pickerBaseline,
      l: window.S._pickerLocked, n: window.S._pickerNoUnassign, u: window.S._pickerUnsealed, m: window.S._pickerNames }));
    expect(st, "…and clears every field of its state").toEqual({ c: null, b: null, l: null, n: null, u: null, m: null });
  });

  test("'Assign to Events' opened for challenge X (slow) then Y: ONE dialog, Y's, and its Save writes Y only", async ({ page }) => {
    const w = await challengeWorld();
    await enterChallenges(page, w);
    const g = await holdFirst(page, "/api/admin/competitions");
    await fire(page, "__aX", "openAssignTaskToComps", w.X.id);
    await waitHeld(g);
    await fire(page, "__aY", "openAssignTaskToComps", w.Y.id);
    await settled(page, "__aY");
    g.release();
    await settled(page, "__aX");
    const d = await dialogs(page, "#assign-task-overlay", "h3");
    expect(d, "the superseded open for X must not add a dialog over Y's").toHaveLength(1);
    expect(d[0]).toContain(w.Y.title);
    const puts = [];
    page.on("request", (rq) => { if (rq.method() === "PUT" && /^\/api\/admin\/tasks\/[^/]+\/competitions$/.test(new URL(rq.url()).pathname)) puts.push({ task: new URL(rq.url()).pathname.split("/")[4], body: rq.postDataJSON() }); });
    await page.locator(`#assign-task-overlay input[type=checkbox][value="${w.F.id}"]`).check();
    await page.locator("#assign-task-overlay #assign-task-save-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "Question assignments updated" })).toBeVisible();
    expect(puts, "one write, to Y").toHaveLength(1);
    expect(puts[0].task).toBe(w.Y.id);
    expect(puts[0].body.competitionIds.sort(), "Y's own ticks: E (already on it) and the F just ticked").toEqual([w.E.id, w.F.id].sort());
  });

  test("'Assign to Events' Save answered after its dialog was closed and Y's opened: Y's dialog stays open", async ({ page }) => {
    const w = await challengeWorld();
    await enterChallenges(page, w);
    await fire(page, "__aX", "openAssignTaskToComps", w.X.id);
    await settled(page, "__aX");
    await page.locator(`#assign-task-overlay input[type=checkbox][value="${w.F.id}"]`).check();
    let release; const gate0 = new Promise(r => { release = r; }); let held = 0;
    await page.route((u) => u.pathname === `/api/admin/tasks/${w.X.id}/competitions`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      held++; await gate0; return route.continue();
    });
    await page.locator("#assign-task-overlay #assign-task-save-btn").click();
    await expect.poll(() => held, { message: "the save was held — the arm is vacuous otherwise" }).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#assign-task-overlay")).toHaveCount(0);
    await fire(page, "__aY", "openAssignTaskToComps", w.Y.id);
    await settled(page, "__aY");
    release();
    // The save really answered before anything is judged.
    await expect(page.locator("#toast-stack .toast", { hasText: "Question assignments updated" })).toBeVisible();
    const d = await dialogs(page, "#assign-task-overlay", "h3");
    expect(d, "X's save must not close the dialog the admin opened for Y meanwhile").toHaveLength(1);
    expect(d[0]).toContain(w.Y.title);
  });

  test("'Grant Attempts' opened for challenge X (slow) then Y: ONE dialog, Y's", async ({ page }) => {
    const w = await challengeWorld();
    await enterChallenges(page, w);
    const g = await holdFirst(page, "/api/admin/competitions");
    await fire(page, "__gX", "openAttemptGrant", w.X.id);
    await waitHeld(g);
    await fire(page, "__gY", "openAttemptGrant", w.Y.id);
    await settled(page, "__gY");
    g.release();
    await settled(page, "__gX");
    const d = await dialogs(page, "#attempt-grant-overlay", "#ag-title");
    expect(d, "the superseded open for X must not add a dialog over Y's").toHaveLength(1);
    expect(d[0]).toContain(w.Y.title);
    // A superseded open is SILENT: it read nothing wrong, so it must not blame the
    // network ("Could not load…") over a dialog that loaded fine.
    const toasts = await page.evaluate(() => [...document.querySelectorAll("#toast-stack .toast")].map(t => t.textContent));
    expect(toasts.join(" | "), "no failure toast from the superseded open").not.toMatch(/could not load/i);
    // …and its roster is live: the enrolled participant is offered.
    await expect(page.locator(`#attempt-grant-overlay #ag-people input[name=ag-participant][value="${w.P.id}"]`)).toHaveCount(1);
  });

  test("'Grant Attempts' answered after its dialog was closed and Y's opened: Y's dialog stays open", async ({ page }) => {
    const w = await challengeWorld();
    await enterChallenges(page, w);
    await fire(page, "__gX", "openAttemptGrant", w.X.id);
    await settled(page, "__gX");
    await page.locator(`#attempt-grant-overlay #ag-people input[name=ag-participant][value="${w.P.id}"]`).check();
    let release; const gate0 = new Promise(r => { release = r; }); let held = 0;
    await page.route((u) => u.pathname === `/api/admin/tasks/${w.X.id}/attempt-grant`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      held++; await gate0; return route.continue();
    });
    await page.locator("#attempt-grant-overlay #ag-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect.poll(() => held, { message: "the grant was held — the arm is vacuous otherwise" }).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#attempt-grant-overlay")).toHaveCount(0);
    await fire(page, "__gY", "openAttemptGrant", w.Y.id);
    await settled(page, "__gY");
    release();
    await expect(page.locator("#toast-stack .toast", { hasText: "Granted 1 extra attempt" })).toBeVisible();
    const d = await dialogs(page, "#attempt-grant-overlay", "#ag-title");
    expect(d, "X's grant must not close the dialog the admin opened for Y meanwhile").toHaveLength(1);
    expect(d[0]).toContain(w.Y.title);
  });
});

// ---------------------------------------------------------------------------
// v8.12.6 (sweep) — A RESTORE CLOSES THE HISTORY DIALOG IT CAME FROM, AND NO OTHER.
// It closes after two awaits (the CSRF refresh and the POST), and closed
// whatever History dialog was on screen by then. Versions and the restore are
// MOCKED: the subject is purely which dialog closes.
// ---------------------------------------------------------------------------
test.describe("v8.12.6 (sweep) — a restore closes only its own History dialog", () => {
  /** A real challenge with two versions (created, then retitled), and the id of version #1. */
  async function versionedTask() {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const t = uniq();
      const r = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `Restore ${t}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "k", status: "draft" } });
      expect(r.status(), await r.text()).toBe(200);
      const id = (await r.json()).id;
      const e = await sa.put(`/api/admin/tasks/${id}`, { headers: H(csrf), data: { title: `Restore ${t} (edited)` } });
      expect(e.ok(), `edit: ${await e.text()}`).toBeTruthy();
      const v = await (await sa.get(`/api/admin/tasks/${id}/versions`)).json();
      const v1 = (Array.isArray(v) ? v : []).find(x => x.version_num === 1);
      expect(v1, "the challenge has a version #1 to restore").toBeTruthy();
      return { id, v1: v1.id };
    } finally { await sa.dispose(); }
  }

  async function startRestore(page, task) {
    await fire(page, "__h", "showTaskHistory", task.id);
    await settled(page, "__h");
    await expect(page.locator("#hist-overlay")).toHaveCount(1);
    await fire(page, "__r", "restoreTaskVersion", task.id, task.v1, 1);
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Restore Version");
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
  }

  test("restore answered after its dialog was closed and another History opened: the other one stays open", async ({ page }) => {
    const ev = await twoEvents();
    const task = await versionedTask();
    await enterAdmin(page, ev);
    let release; const g = new Promise(r => { release = r; }); let held = 0;
    await page.route((u) => u.pathname === `/api/admin/tasks/${task.id}/restore`, async (route) => {
      held++; await g; return route.continue();
    });
    await page.route((u) => u.pathname === `/api/admin/competitions/${ev.B.id}/events`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: evs(3, "B"), total: 3 }) }));
    await startRestore(page, task);
    await expect.poll(() => held, { message: "the restore was held — the arm is vacuous otherwise" }).toBe(1);
    await page.locator("#hist-overlay [data-action='history-close']").click();
    await expect(page.locator("#hist-overlay")).toHaveCount(0);
    await fire(page, "__hB", "showCompetitionHistory", ev.B.id);
    await settled(page, "__hB");
    release();
    await settled(page, "__r");
    await expect(page.locator("#toast-stack .toast", { hasText: "Question restored" })).toBeVisible();
    const s = await histState(page);
    expect(s.overlays, "the restore must not close the History the admin opened for B meanwhile").toBe(1);
    expect(s.title).toContain(ev.B.name);
    expect(s.markers).toEqual(["B"]);
  });

  test("CONTROL: a restore answered while its own dialog is open closes it", async ({ page }) => {
    const ev = await twoEvents();
    const task = await versionedTask();
    await enterAdmin(page, ev);
    await startRestore(page, task);
    await settled(page, "__r");
    await expect(page.locator("#toast-stack .toast", { hasText: "Question restored" })).toBeVisible();
    await expect(page.locator("#hist-overlay"), "the restore closes the dialog it came from").toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// v8.12.6 (sweep) — THE HELP DRAWER SHOWS THE LAST DOCUMENT ASKED FOR. Two loads
// in flight (an in-drawer link clicked twice in quick succession) painted
// whichever answered LAST. Documents are MOCKED — the subject is the ordering.
// ---------------------------------------------------------------------------
test.describe("v8.12.6 (sweep) — the help drawer shows the last document asked for", () => {
  test("a slow first document answered after a second one was opened does not replace it", async ({ page }) => {
    const ev = await twoEvents();
    await enterAdmin(page, ev);
    await fire(page, "__open", "openHelpDrawer");
    await settled(page, "__open");
    let release; const g = new Promise(r => { release = r; }); let held = 0;
    const FIRST = "/docs/user-guide/participant.md", SECOND = "/docs/user-guide/event-admin.md";
    await page.route((u) => u.pathname === FIRST, async (route) => {
      held++; await g;
      return route.fulfill({ contentType: "text/markdown", body: "# FIRST-DOC-MARKER\n\nold." });
    });
    await page.route((u) => u.pathname === SECOND, (route) =>
      route.fulfill({ contentType: "text/markdown", body: "# SECOND-DOC-MARKER\n\nnew." }));
    await fire(page, "__d1", "_helpLoadDoc", FIRST);
    await expect.poll(() => held, { message: "the first document was held — the arm is vacuous otherwise" }).toBe(1);
    await fire(page, "__d2", "_helpLoadDoc", SECOND);
    await settled(page, "__d2");
    // CONTROL, before the race is judged: an unsuperseded load paints.
    await expect(page.locator("#help-drawer-body")).toContainText("SECOND-DOC-MARKER");
    release();
    await settled(page, "__d1");
    await expect(page.locator("#help-drawer-body")).toContainText("SECOND-DOC-MARKER");
    await expect(page.locator("#help-drawer-body")).not.toContainText("FIRST-DOC-MARKER");
    expect(await page.evaluate(() => window.S._helpLastDoc), "the drawer's doc memory follows the document on screen").toBe(SECOND);
    expect(await page.locator("#help-open-ext").getAttribute("href")).toContain(encodeURIComponent(SECOND));
  });
});
