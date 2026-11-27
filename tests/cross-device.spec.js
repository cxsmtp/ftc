// @ts-check
// v8.12.4 — REAL JOURNEYS ON EVERY DEVICE, WITH THE DEVICE'S OWN INPUT.
//
// tests/cross-browser.spec.js is a smoke: it proves each engine boots the app and
// that the controls a user must press are REACHABLE. What no project did was
// take a participant through the work they come for — open a challenge, answer
// it, read the leaderboard, edit their profile — on a phone, a tablet, a
// touchscreen laptop, a Windows laptop at 125% scaling or a retina Mac. The
// whole ~3,700-test regression suite runs at ONE size (1280x800 Chromium, mouse),
// so every one of those journeys had been exercised on exactly one device.
//
// This file runs on every project in the matrix (playwright.config.js gives the
// non-chromium projects `testMatch: /cross-(browser|device)\.spec\.js$/`) and on
// the chromium suite, and each arm drives the INPUT THE DEVICE ACTUALLY HAS:
//   • touch projects (`hasTouch`)  → `locator.tap()` — real touch events, the
//     browser synthesises the click, exactly as on a phone;
//   • pointer projects             → the mouse, and for the laptop/desktop
//     profiles BOTH wheel styles: fine-grained horizontal deltas (a trackpad's
//     two-finger pan) and coarse vertical deltas (a mouse wheel). CSS cannot
//     tell a trackpad from a mouse (both are `pointer: fine` + `hover: hover`),
//     so the difference that CAN be tested is the scrolling it produces.
//
// FIXTURES: every arm builds its own competition, challenges and participants
// through the admin API (the v7.15.32 rule), so an arm is independent of every
// other arm and of the seed. Two participants are enrolled wherever one of them
// solves anything, or the all-solved auto-end would end the event underneath
// the test (fixture checklist item 1).
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, freshCtx, getSuperadminPass, PARTICIPANT_PASS, settleThroughRenderStall, gotoThroughRenderStall, pressThroughRenderStall, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `xd${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const ANSWER = "mercury";

/** "touch" for a hasTouch project, "pointer" otherwise — read from the PROJECT, never guessed from a width. */
function inputOf(testInfo) { return testInfo.project.use.hasTouch ? "touch" : "pointer"; }
/** Activate a control the way this device's user would, through a WebKit rendering stall (helpers.js). */
async function press(locator, input) {
  await pressThroughRenderStall(locator, String(locator), input === "touch" ? "tap" : "click", test.info().project.use.actionTimeout);
}

/**
 * The area the user can actually see. `innerWidth` includes a CLASSIC
 * scrollbar (the Windows projects draw a real 15px one), `clientWidth` does not;
 * under mobile emulation `innerWidth` is the layout viewport rather than the
 * configured number (v7.23.0). The smaller of each pair is the honest bound.
 */
async function visibleArea(page) {
  return page.evaluate(() => ({
    width: Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth),
    height: Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight),
  }));
}

/** Settle, scroll into view, run full actionability without activating, then require the box inside the visible area. */
async function assertReachable(page, locator, label) {
  await expect(locator, `${label}: not visible`).toBeVisible();
  const ceiling = test.info().project.use.actionTimeout;
  expect(typeof ceiling, "the settle wait is bounded by the project's actionTimeout").toBe("number");
  const settled = await settleThroughRenderStall(locator, label, ceiling);
  expect(settled.ok, `${label}: the page never settled — ${settled.frames} frame(s) painted in ${settled.ms} ms; still animating: ${JSON.stringify(settled.pending)}`).toBe(true);
  await pressThroughRenderStall(locator, label, "trial", 8000);
  const box = await locator.boundingBox();
  expect(box, `${label}: no layout box`).not.toBeNull();
  const vp = await visibleArea(page);
  const s = 2;
  expect(box.x >= -s && box.y >= -s && box.x + box.width <= vp.width + s && box.y + box.height <= vp.height + s,
    `${label}: off-screen box=${JSON.stringify(box)} visible=${vp.width}x${vp.height}`).toBe(true);
}

/** The page itself must never scroll sideways — only named inner scrollers may. */
async function assertNoPageSideScroll(page, label) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > document.documentElement.clientWidth + 2 && getComputedStyle(el).position !== "fixed";
    }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${[...el.classList].join(".")}`),
  }));
  expect(m.sw - m.cw, `${label}: the PAGE scrolls sideways by ${m.sw - m.cw}px; widest offenders: ${m.wide.join(", ") || "(none measurable)"}`)
    .toBeLessThanOrEqual(2);
}

async function adminApi() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeParticipant(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Device", lastName: label, nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  // `?search=` is a no-op on this endpoint; ask for the documented cap instead.
  const list = await (await api.get("/api/admin/participants?limit=5000")).json();
  const u = (list.participants || []).find((p) => p.email === email);
  expect(u, `${label} must be findable after registering`).toBeTruthy();
  for (const step of ["verify", "approve"]) {
    const r = await api.post(`/api/admin/participants/${u.id}/${step}`, { headers: H(csrf) });
    expect(r.ok(), `${step} ${label}: ${await r.text()}`).toBeTruthy();
  }
  return { id: u.id, email, nickname: label };
}

/** A live competition with two text challenges and two enrolled participants; only the first ever acts. */
async function liveFixture() {
  const { api, csrf } = await adminApi();
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name: `${uniq()} Device Event`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
  });
  expect(cr.ok(), `create competition: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;
  const tasks = [];
  for (const n of [0, 1]) {
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} Planet ${n}`, description: "<p>Name the planet closest to the Sun.</p>", difficulty: "easy",
              answer_type: "text", correct_answer: ANSWER, status: "published" },
    });
    expect(tr.ok(), `create challenge: ${await tr.text()}`).toBeTruthy();
    const { id } = await tr.json();
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), `assign challenge: ${await asg.text()}`).toBeTruthy();
    tasks.push({ id });
  }
  const users = [await makeParticipant(api, csrf, uniq()), await makeParticipant(api, csrf, uniq())];
  const en = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: users.map((u) => u.id), competitionIds: [comp.id] } });
  expect(en.ok(), `enrol: ${await en.text()}`).toBeTruthy();
  expect((await en.json()).assigned, "the assign endpoint SKIPS ineligible users, so assert it took").toBe(2);
  await api.dispose();
  return { comp, tasks, users };
}

/** Sign the participant in (session first, then navigate — v7.21.26) and land in the event's challenge list. */
async function enterAsParticipant(page, f) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await codeLogin(page.request, f.users[0].email, H(csrfToken));
  expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: f.comp.id } });
  expect(sel.ok(), `select-competition: ${await sel.text()}`).toBeTruthy();
  await gotoThroughRenderStall(page, "/");
  await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
  // ANY card, not a particular one: while an event is live the list opens on
  // the Unsolved filter, so a challenge the participant has already solved is
  // correctly absent from it.
  await page.locator("#task-grid [data-task-id]").first().waitFor({ state: "visible", timeout: 20000 });
}

async function enterAsSuperadmin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await page.request.post("/api/login", { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(li.ok(), `superadmin login: ${li.status()}`).toBeTruthy();
  await gotoThroughRenderStall(page, "/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

async function openAdminTab(page, tabId, input) {
  const isDrawer = await page.evaluate(() => matchMedia("(max-width:768px)").matches);
  if (isDrawer && !(await page.locator("#admin-sidebar.mobile-open").count())) {
    await press(page.locator("#admin-mobile-menu-btn"), input);
    await page.locator("#admin-sidebar.mobile-open").waitFor({ state: "attached", timeout: 5000 });
  }
  await press(page.locator(`.admin-nav-item[data-tab-id="${tabId}"]`), input);
  await page.locator(`#${tabId}`).waitFor({ state: "visible", timeout: 15000 });
}

test.describe("cross-device journeys (v8.12.4)", () => {
  // Two short journeys, not one long one. On the CI runner's WebKit each
  // reachability check and press costs seconds (three times what the pinned
  // image measures on a developer machine), and the fourteen of them in one
  // test ran out of its 60 s before its last press.
  test("a participant opens a challenge and answers it wrongly — with the device's own input", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const f = await liveFixture();
    await enterAsParticipant(page, f);
    await assertNoPageSideScroll(page, `[${testInfo.project.name}] challenge list`);

    const card = page.locator(`#task-grid [data-task-id="${f.tasks[0].id}"]`);
    await assertReachable(page, card, `[${testInfo.project.name}] challenge card`);
    await press(card, input);
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
    const box = page.locator("#ans-text");
    await expect(box).toBeVisible({ timeout: 15000 });
    // iOS zooms the page when a focused control is under 16px and never zooms
    // back out; WebKitGTK cannot show that (README), so the size is asserted on
    // every device instead of the zoom.
    const fs = await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fs, `[${testInfo.project.name}] the answer box is ${fs}px — under 16px iOS Safari zooms on focus`).toBeGreaterThanOrEqual(16);
    await assertNoPageSideScroll(page, `[${testInfo.project.name}] challenge detail`);

    // The penalty confirmation fits the device; the result is the graded-wrong message, on screen.
    const submit = page.locator(`[data-action="task-submit-answer"][data-task-id="${f.tasks[0].id}"]`).first();
    await box.fill("venus");
    await press(submit, input);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await assertReachable(page, page.locator("#modal-confirm-btn"), `[${testInfo.project.name}] penalty-confirm Submit`);
    await assertReachable(page, page.locator("#modal-cancel-btn"), `[${testInfo.project.name}] penalty-confirm Cancel`);
    await press(page.locator("#modal-confirm-btn"), input);
    const wrong = page.locator("#submit-result .result-msg.wrong");
    await expect(wrong, `[${testInfo.project.name}] a wrong answer must say so`).toContainText("Incorrect", { timeout: 15000 });
    await assertReachable(page, wrong, `[${testInfo.project.name}] the wrong-answer result`);
  });

  test("a participant solves a challenge and dismisses the celebration — with the device's own input", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const f = await liveFixture();
    await enterAsParticipant(page, f);
    // The card and the penalty confirmation are measured by the test above;
    // here they are only used, through the device's own input.
    await press(page.locator(`#task-grid [data-task-id="${f.tasks[0].id}"]`), input);
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
    const box = page.locator("#ans-text");
    await expect(box).toBeVisible({ timeout: 15000 });
    await box.fill(ANSWER);
    const submit = page.locator(`[data-action="task-submit-answer"][data-task-id="${f.tasks[0].id}"]`).first();
    await assertReachable(page, submit, `[${testInfo.project.name}] Submit Answer`);
    await press(submit, input);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await press(page.locator("#modal-confirm-btn"), input);

    // The celebration dialog, fully on screen, dismissable by input.
    const solved = page.locator("h2", { hasText: "Challenge Solved!" });
    await expect(solved, `[${testInfo.project.name}] the solve must be celebrated`).toBeVisible({ timeout: 15000 });
    const cont = page.locator("button", { hasText: "Continue" }).last();
    await assertReachable(page, cont, `[${testInfo.project.name}] Challenge Solved → Continue`);
    await press(cont, input);
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });
  });

  test("the leaderboard, the profile editor and a confirmation dialog all fit the device", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const f = await liveFixture();
    // A score of the participant's own, so their row is on the board.
    {
      const { api, csrf: c0 } = await freshCtx();
      const li = await codeLogin(api, f.users[0].email, H(c0));
      expect(li.ok()).toBeTruthy();
      const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      expect((await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: f.comp.id } })).ok()).toBeTruthy();
      const d = await (await api.get(`/api/tasks/${f.tasks[0].id}`)).json();
      const sub = await api.post(`/api/tasks/${f.tasks[0].id}/submit`, { headers: H(csrf), data: { answer: ANSWER, gradingHash: d.grading_hash } });
      expect(sub.ok(), `seed a solve: ${await sub.text()}`).toBeTruthy();
      expect((await sub.json()).correct, "the seeded solve must be correct").toBe(true);
      await api.dispose();
    }
    await enterAsParticipant(page, f);
    const P = testInfo.project.name;

    // Leaderboard — through the nav, by the device's input.
    const lbBtn = page.locator("#nav-leaderboard:not([aria-disabled=true])");
    await expect(lbBtn, `[${P}] a ranked live event must offer the Leaderboard`).toBeVisible({ timeout: 20000 });
    await assertReachable(page, lbBtn, `[${P}] Leaderboard nav`);
    await press(lbBtn, input);
    await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#lb-body"), `[${P}] the participant's own row must be on the board`).toContainText(f.users[0].nickname, { timeout: 15000 });
    await assertNoPageSideScroll(page, `[${P}] leaderboard`);

    // Profile editor — opens, fits (it scrolls inside itself, never the page), Save reachable, Cancel closes.
    // Profile lives in the account menu: the round account button opens it.
    const acct = page.locator("#profile-menu-btn");
    await assertReachable(page, acct, `[${P}] account menu button`);
    await press(acct, input);
    const avatar = page.locator('#profile-menu-overlay [data-action="open-profile-editor"]');
    await assertReachable(page, avatar, `[${P}] profile opener`);
    await press(avatar, input);
    const card = page.locator("#profile-overlay .profile-card");
    await card.waitFor({ state: "visible", timeout: 10000 });
    const vp = await visibleArea(page);
    const cb = await card.boundingBox();
    expect(cb && cb.height <= vp.height + 2, `[${P}] the profile card is ${cb && cb.height}px tall in a ${vp.height}px view — it must scroll inside itself`).toBe(true);
    await assertReachable(page, page.locator('#profile-overlay [data-action="save-profile"]'), `[${P}] profile Save`);

    // A confirmation dialog: closing an edited form asks first, and both
    // answers are pressable. (Events inside an event is plain navigation now,
    // so the profile's "Discard changes?" is the confirm this arm drives.)
    await page.locator("#prof-company").fill("Device Co " + Date.now());
    await press(page.locator('#profile-overlay [data-action="overlay-close"][data-overlay-id="profile-overlay"]'), input);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await assertReachable(page, page.locator("#modal-confirm-btn"), `[${P}] discard confirm`);
    await assertReachable(page, page.locator("#modal-cancel-btn"), `[${P}] discard cancel`);
    await press(page.locator("#modal-cancel-btn"), input);
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
    await expect(page.locator("#profile-overlay"), `[${P}] Keep editing leaves the editor open`).toBeVisible();
    await press(page.locator('#profile-overlay [data-action="overlay-close"][data-overlay-id="profile-overlay"]'), input);
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
    await press(page.locator("#modal-confirm-btn"), input);
    await expect(page.locator("#profile-overlay"), `[${P}] Discard closes the editor`).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator("#leaderboard-page.active"), `[${P}] the participant is where they were`).toBeVisible();
  });

  test("rotating the device (or the monitor) mid-session keeps the app usable", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const f = await liveFixture();
    await enterAsParticipant(page, f);
    const P = testInfo.project.name;
    const before = page.viewportSize();
    expect(before, "the project must declare a viewport").toBeTruthy();
    // Landscape <-> portrait. On a desktop profile this is a rotated monitor
    // (or a window dragged to a narrow shape) — the same reflow question.
    await page.setViewportSize({ width: before.height, height: before.width });
    await page.waitForFunction((w) => Math.abs(window.innerWidth - w) < 400 || window.innerWidth !== w, before.width);
    await assertNoPageSideScroll(page, `[${P}] challenge list after rotating to ${before.height}x${before.width}`);
    const card = page.locator(`#task-grid [data-task-id="${f.tasks[1].id}"]`);
    await assertReachable(page, card, `[${P}] challenge card after rotating`);
    await press(card, input);
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
    await assertReachable(page, page.locator(`[data-action="task-submit-answer"][data-task-id="${f.tasks[1].id}"]`).first(), `[${P}] Submit after rotating`);
    // And back, with the detail view open.
    await page.setViewportSize(before);
    await assertNoPageSideScroll(page, `[${P}] challenge detail after rotating back`);
    await assertReachable(page, page.locator(`[data-action="task-submit-answer"][data-task-id="${f.tasks[1].id}"]`).first(), `[${P}] Submit after rotating back`);
  });

  test("hover styling needs a hover-capable pointer, and a tap never leaves it stuck", async ({ page }, testInfo) => {
    const P = testInfo.project.name;
    const input = inputOf(testInfo);
    await enterAsSuperadmin(page);
    const canHover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
    // The media query must agree with the project: touch profiles have no
    // hover, pointer profiles do. If this ever disagrees the rest is moot.
    expect(canHover, `[${P}] (hover: hover) must match exactly the non-touch profiles`).toBe(input === "pointer");
    // A NON-NAVIGATING target with a hover-gated rule: an admin table row. Its
    // `@media(hover:hover){table tbody tr:hover{…}}` highlight is exactly the
    // rule that, left un-gated, sticks on a phone after a tap (v6.9.13).
    const row = page.locator("#admin-comp-body tr").first();
    await row.waitFor({ state: "visible", timeout: 15000 });
    const cell = row.locator("td").nth(2);
    await cell.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    const bg = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
    const rest = await bg();
    const hoverBg = await page.evaluate(() => { const d = document.createElement("div"); d.style.background = "var(--surface2)"; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
    expect(rest, `[${P}] a resting row must not already wear the hover colour, or this arm proves nothing`).not.toBe(hoverBg);
    if (input === "pointer") {
      await pressThroughRenderStall(cell, `[${P}] a table cell`, "hover", testInfo.project.use.actionTimeout);
      await expect.poll(bg, { message: `[${P}] hovering a row must highlight it on a hover-capable device`, timeout: 3000 }).toBe(hoverBg);
      return;
    }
    // TOUCH. WebKit's touch EMULATION never enters :hover on a tap — measured:
    // even with the rule deliberately un-gated, a tapped row stays un-highlighted
    // on the iOS/iPad profiles — so there a style check could not fail whatever
    // the CSS said. Skipped with that reason rather than passed vacuously. The
    // Chromium touch profiles DO show a stuck hover once the gate is removed
    // (measured: all six fail), which is the real mobile behaviour this guards.
    test.skip(testInfo.project.use.defaultBrowserType === "webkit" || page.context().browser().browserType().name() === "webkit",
      `${P}: WebKit's touch emulation cannot enter :hover on a tap, so it cannot show a stuck hover — exercised on the Chromium touch profiles`);
    // Tap a corner of a plain cell, so nothing is activated.
    await cell.tap({ position: { x: 3, y: 3 } });
    await page.waitForTimeout(300);
    expect(await bg(), `[${P}] a TAP must not leave the row highlighted — the hover rule must stay inside @media(hover:hover)`).toBe(rest);
  });

  test("trackpad and mouse: the wide admin table pans inside its own scroller, never the page", async ({ page }, testInfo) => {
    test.skip(inputOf(testInfo) === "touch",
      "touch-only profile — no wheel device; panning a table there is a native swipe, which Playwright cannot synthesise, and the page-wide overflow is asserted by the other arms in this file");
    const P = testInfo.project.name;
    await enterAsSuperadmin(page);
    await openAdminTab(page, "admin-tasks-tab", "pointer");
    const scroller = page.locator("#admin-task-table-card");
    await scroller.waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#admin-task-body tr").first().waitFor({ state: "visible", timeout: 15000 });
    await assertNoPageSideScroll(page, `[${P}] admin Challenges`);
    // Every vertical scroller the wheel may legitimately move: the table's own
    // card (it has a measured max-height and becomes the scrollport once it holds
    // enough rows — v8.11.11), the admin content pane, and the page.
    const scrolledY = () => page.evaluate(() => {
      const card = document.getElementById("admin-task-table-card");
      const c = document.querySelector(".admin-content");
      return (card ? card.scrollTop : 0) + (c ? c.scrollTop : 0) + window.scrollY;
    });
    // Back to the TOP, then aim at the table where it now is. Earlier clicks let
    // Playwright scroll things into view, and a box measured before a reset
    // points at whatever has moved under it since — measured: the first draft's
    // wheel landed off the table and scrolled nothing.
    const resetAndAim = async () => {
      await page.evaluate(() => { const card = document.getElementById("admin-task-table-card"); if (card) card.scrollTop = 0; const c = document.querySelector(".admin-content"); if (c) c.scrollTop = 0; window.scrollTo(0, 0); });
      const b = await scroller.boundingBox();
      await page.mouse.move(b.x + Math.min(60, b.width / 3), b.y + Math.min(60, b.height / 3));
      return b;
    };

    // MOUSE: a notched vertical wheel scrolls the admin content (or the page) DOWN, never sideways.
    await resetAndAim();
    expect(await scrolledY(), `[${P}] the reset must leave the pane at its top`).toBe(0);
    const canScrollY = await page.evaluate(() => {
      const card = document.getElementById("admin-task-table-card");
      const c = document.querySelector(".admin-content");
      return (card && card.scrollHeight > card.clientHeight + 2) || (c && c.scrollHeight > c.clientHeight + 2) || document.documentElement.scrollHeight > document.documentElement.clientHeight + 2;
    });
    await page.mouse.wheel(0, 400);
    if (canScrollY) {
      await expect.poll(scrolledY, { message: `[${P}] a mouse wheel over the table must scroll it (or the pane) down`, timeout: 5000 }).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => window.scrollX), `[${P}] a vertical wheel must never scroll the page sideways`).toBe(0);

    // A PAUSE, and it is not decoration: browsers LATCH a wheel gesture to the
    // element that scrolled at its start (Chromium's scroll latching), so the
    // next gesture sent at once is delivered to the previous target. A person
    // scrolls, stops, then pans; the gap ends the latch — measured.
    await page.waitForTimeout(1200);

    // TRACKPAD: a two-finger horizontal pan is a burst of small deltaX wheel events.
    await resetAndAim();
    const dims = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    if (dims.sw > dims.cw + 2) {
      for (let i = 0; i < 12; i++) await page.mouse.wheel(24, 0);
      await expect.poll(() => scroller.evaluate((el) => el.scrollLeft), { message: `[${P}] a trackpad pan (deltaX) must scroll the table sideways inside its card`, timeout: 5000 }).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollX), `[${P}] the pan must not scroll the PAGE sideways`).toBe(0);
    } else {
      // Wide enough that the table fits: the correct outcome is that nothing needs panning.
      expect(dims.sw - dims.cw, `[${P}] the table fits at this width, so it must not overflow its card`).toBeLessThanOrEqual(2);
    }
  });

  // v8.13.0 — a Booth Event's multiple-choice challenge is ONE screen of tiles on
  // a device the shared query matches (phones, portrait tablets), and today's
  // card everywhere else, answered with the device's own input — a tap where
  // there is touch. WHICH projects get tiles is a decision per project, held in
  // this table: an expectation read from the query itself agrees with whatever
  // the query says (deleting the portrait-tablet clause, measured, left every
  // project green). A project added later reads as "today's card" until somebody
  // decides otherwise here.
  const BOOTH_TAP_PROJECTS = new Set([
    "mobile-chrome", "mobile-webkit", "mobile-chrome-samsung",
    "mobile-webkit-landscape", "mobile-chrome-samsung-landscape",
    "tablet-webkit-portrait", "tablet-chrome-samsung-portrait",
  ]);
  test("a booth multiple-choice challenge: tiles where the device query matches, today's card elsewhere", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const P = `[${testInfo.project.name}]`;
    const bct = require("./booth-choice-tap-fixture");
    const { api, csrf } = await bct.sa();
    const { comp, ids } = await bct.eventWithChoices(api, csrf, { tasks: [{ choices: bct.SHORT }] });
    const who = await bct.participantIn(api, csrf, comp.id);
    await api.dispose();
    await bct.signInTo(page, who.email, comp.id);
    await bct.openChallenge(page, ids[0]);
    const s = await bct.tapState(page);
    await assertNoPageSideScroll(page, `${P} booth challenge`);
    testInfo.annotations.push({ type: "choice-layout", description: s.mq ? `tap/${s.fit}` : "standard" });
    expect(s.mq, `${P} the decided layout for this project`).toBe(BOOTH_TAP_PROJECTS.has(testInfo.project.name));
    if (!s.mq) {
      expect(s.tap, `${P} no match → today's card`).toBe(false);
      expect(s.radios, `${P} the standard radios`).toBe(4);
      return;
    }
    expect(s.tap, `${P} the device matches → the tap view`).toBe(true);
    expect(s.headerShown, `${P} header hidden`).toBe(false);
    expect(["fixed", "scroll"], `${P} fit=${s.fit}`).toContain(s.fit);
    if (s.fit === "fixed") {
      expect(s.scrollH, `${P} one screen: the page does not scroll`).toBeLessThanOrEqual(s.innerH + 1);
      expect(s.lastBottom, `${P} the last tile is on screen`).toBeLessThanOrEqual(s.innerH + 1);
    }
    for (const h of s.tileHeights) expect(h, `${P} tile height`).toBeGreaterThanOrEqual(44);

    const confirm = async () => {
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 10000 });
      await assertReachable(page, page.locator("#modal-confirm-btn"), `${P} the naming confirm's Submit`);
      await assertReachable(page, page.locator("#modal-cancel-btn"), `${P} the naming confirm's Choose again`);
      await page.waitForTimeout(450);   // the 400 ms arm
      await press(page.locator("#modal-confirm-btn"), input);
    };
    const wrong = page.locator(".mcf-tile", { hasText: "FTP" });
    await assertReachable(page, wrong, `${P} a tile`);
    await press(wrong, input);
    await confirm();
    await expect(wrong, `${P} the wrong tile is marked`).toHaveClass(/is-tried/, { timeout: 15000 });
    const right = page.locator(".mcf-tile", { hasText: "HTTPS" });
    await press(right, input);
    await confirm();
    await expect(page.locator("h2", { hasText: "Challenge Solved!" }), `${P} solved`).toBeVisible({ timeout: 15000 });
    await press(page.locator("button", { hasText: "Continue" }).last(), input);
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });
    expect((await bct.tapState(page)).headerShown, `${P} the full chrome is back`).toBe(true);
  });

  test("the primary controls are at least 44px on every device", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const f = await liveFixture();
    await enterAsParticipant(page, f);
    const P = testInfo.project.name;
    const measure = async (loc, label) => {
      await expect(loc, `${label}: not visible`).toBeVisible({ timeout: 15000 });
      const bb = await loc.boundingBox();
      expect(bb && bb.height >= 43.5, `[${P}] ${label} is ${bb && bb.height}px tall — the house minimum is 44px`).toBe(true);
    };
    await measure(page.locator("#nav-competitions"), "the Events nav button");
    await measure(page.locator("#nav-challenges:not([aria-disabled=true])"), "the Challenges nav button");
    await press(page.locator(`#task-grid [data-task-id="${f.tasks[0].id}"]`), input);
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
    await measure(page.locator(`[data-action="task-submit-answer"][data-task-id="${f.tasks[0].id}"]`).first(), "Submit Answer");
    await measure(page.locator("#ans-text"), "the answer box");
  });

  test("the admin analytics chart draws at this screen size", async ({ page }, testInfo) => {
    const input = inputOf(testInfo);
    const P = testInfo.project.name;
    const f = await liveFixture();   // gives the platform-wide aggregate something to draw
    expect(f.comp.id).toBeTruthy();
    await enterAsSuperadmin(page);
    await openAdminTab(page, "admin-analytics-tab", input);
    // With no event focused the pane asks what to measure (v8.1.0) — answer it.
    // The prompt's own button, not the segmented "Global" control beside it —
    // both carry the same action, and the prompt is what a first-time admin meets.
    const wide = page.locator('#admin-analytics-tab .btn[data-action="analytics-set-scope"][data-value="global"]');
    await wide.waitFor({ state: "visible", timeout: 15000 });
    await press(wide, input);
    const chart = page.locator("#admin-analytics-tab canvas, #admin-analytics-tab svg[data-zr-dom-id]").first();
    await chart.waitFor({ state: "attached", timeout: 20000 });
    await expect.poll(async () => {
      const bb = await chart.boundingBox();
      return bb ? Math.round(bb.width) * Math.round(bb.height) : 0;
    }, { message: `[${P}] the analytics chart must have a real drawing surface at this size`, timeout: 15000 }).toBeGreaterThan(40 * 40);
    await assertNoPageSideScroll(page, `[${P}] admin Analytics`);
  });

  // Opening an event on a phone held sideways: focus goes to the event's name
  // (the Overview's route focus, ui/nav.js), so its header stays on screen. When
  // the Overview's own heading, below the header and the KPI band, took focus,
  // the page scrolled 300-400 px and the name, status, join pill, Invite and ⋯
  // ended up above the screen. The two landscape phones are the matrix's
  // shortest screens; tests/workspace-open-focus.spec.js holds the rest in
  // Chromium. Short: one open per project.
  const LANDSCAPE_PHONES = new Set(["mobile-webkit-landscape", "mobile-chrome-samsung-landscape"]);
  test("opening an event on a phone held sideways keeps its header on screen, with focus on its name", async ({ page }, testInfo) => {
    test.skip(!LANDSCAPE_PHONES.has(testInfo.project.name), "the landscape phones only: tests/workspace-open-focus.spec.js holds the open in Chromium");
    const input = inputOf(testInfo);
    const P = `[${testInfo.project.name}]`;
    const { api, csrf } = await adminApi();
    let comp;
    try {
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${uniq()} Sideways`, start_time: new Date(Date.now() - 60e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
      });
      expect(cr.ok(), `create competition: ${await cr.text()}`).toBeTruthy();
      comp = (await cr.json()).competition;
    } finally { await api.dispose(); }
    await enterAsSuperadmin(page);
    await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), comp.id),
      { timeout: 20000, message: `${P} the Events model holds the event` }).toBe(true);
    // The row's name opens it (at this width the rows are cards).
    await press(page.locator(`#admin-comp-body td.ev-name-cell[data-comp-id="${comp.id}"]`), input);
    await expect(page.locator("#ws-title"), `${P} the event's workspace opened`).toHaveText(comp.name, { timeout: 15000 });
    await expect(page.locator("#ws-title"), `${P} focus is on the event's name`).toBeFocused();
    const vp = await visibleArea(page);
    const top = await page.evaluate(() => document.getElementById("app-header").getBoundingClientRect().bottom);
    for (const [sel, label] of [["#ws-title", "the event's name"], ['#ws-quick [data-action="ws-invite"]', "Invite"], ["#ws-quick .ws-more-btn", "the ⋯ menu"]]) {
      const b = await page.locator(sel).boundingBox();
      expect(!!b && b.y >= top - 2 && b.y + b.height <= vp.height + 2 && b.x >= -2 && b.x + b.width <= vp.width + 2,
        `${P} ${label} is on screen below the header: box=${JSON.stringify(b)} header bottom=${top} visible=${vp.width}x${vp.height}`).toBe(true);
    }
  });
});
