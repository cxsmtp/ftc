"use strict";

// v8.8.0 — AN EVENT IN ITS LATE-ENTRY WINDOW READS APART FROM A FINISHED ONE.
//
// A late-entry window is an ENDED event that is still joinable and still taking
// submissions from late entrants. Before this release every admin surface
// collapsed it into "Ended": the events table said Ended, the default status
// chips hid it, and the Challenges and Participants columns — which filter to
// live/upcoming — dropped its badge entirely. An organiser could not see, from
// any admin screen, that a stand was still open.
//
// THIS FILE IS THE LOCK ON THE RENDERING. The decision is client-side, so
// late-entry-badges.api.spec.js (which pins the flag onto the payloads) cannot
// see a regression here — the v8.7.7 lesson, one release old.
//
// `computeCompStatus` is deliberately UNTOUCHED and still three-valued; the split
// is `compDisplayCategory`, used only where a human is shown a bucket. Widening
// the status itself would move the scoring freeze, the assignment freeze, the
// kind-change lock and the certificate gate with it — the same trap
// lib/late-entry.js refuses on the server.
//
// EVERY ARM CARRIES A CONTROL, because each positive assertion is otherwise
// satisfied by a strictly worse build:
//   * "the late-entry event is shown" — satisfied by a build that stopped
//     filtering ended events at all, so a CLOSED-window ended event must still be
//     hidden by the default chips and still badged "Ended".
//   * "the badge is distinct" — satisfied by a build that renamed every ended
//     badge, so the closed-window event must still read Ended.
//   * "it answers the Late entry chip" — satisfied by a build where it answers
//     every chip, so selecting ONLY Ended must NOT show it.

const { test, expect } = require("./isolated-test");
// The specs below click filter chips directly; the Filters panels start open.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").openFilterPanels(page); });
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, appearanceSettled } = require("./helpers");
const { adminLogin, clickTab, awaitCompModel, narrowEventsTable, narrowChallengesTable, narrowPeopleTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `lbu${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const MIN = 60_000;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeBooth(api, csrf) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} booth`, event_kind: "booth", timezone: "UTC",
      start_time: new Date(Date.now() - 5 * MIN).toISOString(), duration_minutes: 180,
      late_entry_enabled: true,
    },
  });
  expect(r.ok(), `create booth: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function makeTask(api, csrf, compId) {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} probe`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
  });
  expect(r.ok(), `create task: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).id;
  const a = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(a.ok(), `assign: ${await a.text()}`).toBeTruthy();
  return { id, title: (await (await api.get("/api/admin/tasks")).json()).find(t => t.id === id).title };
}

async function makeParticipant(api, csrf, compId) {
  const label = uniq();
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Late", lastName: "Badge", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  const u = ((await (await api.get("/api/admin/participants?limit=5000")).json()).participants || []).find(p => p.email === email);
  expect(u, "participant findable").toBeTruthy();
  // Verified AND approved before the enrol — /assign SKIPS an ineligible user and
  // still answers 200 (the fixture checklist's rule).
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok(), "verify").toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok(), "approve").toBeTruthy();
  const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [compId] } });
  expect(asg.ok(), `enrol: ${await asg.text()}`).toBeTruthy();
  const body = await asg.json();
  expect(body.assigned, `the enrol landed — got ${JSON.stringify(body)}`).toBe(1);
  return { id: u.id, nickname: label };
}

/** Move the schedule into the past. `agoMinutes` decides whether the window is open. */
function expireEvent(compId, agoMinutes, duration = 60) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const end = new Date(Date.now() - agoMinutes * MIN);
    expect(db.prepare("UPDATE competitions SET start_time=?, duration_minutes=? WHERE id=?")
      .run(new Date(end.getTime() - duration * MIN).toISOString(), duration, compId).changes,
      "the direct write must land").toBe(1);
  } finally { db.close(); }
}

/** Narrow the events table to one name and return its row. */
async function compRow(page, name) {
  await narrowEventsTable(page, name);
  const row = page.locator("#admin-comp-body tr", { hasText: name });
  await expect(row.first()).toBeVisible({ timeout: 15000 });
  return row.first();
}

/** Set the status chips to exactly one value. */
async function selectOnlyChip(page, status) {
  // Start from All, which clears the set, then tick exactly the one we want.
  // NOT filterComps(): that helper CLEARS the status chips on its fallback path,
  // which is right for a caller who just wants the row and fatal for a test whose
  // subject IS the chips.
  await page.locator('#comp-status-filters [data-status="all"]').click();
  await page.locator(`#comp-status-filters [data-status="${status}"]`).click();
}

/**
 * The COMPOSITED background of an element — walking up until an opaque layer is
 * found, because the badge tint is an alpha and getComputedStyle reports the
 * rgba rather than what the eye receives (the v7.22.0 rule: measure the
 * composite, never the token).
 */
const CONTRAST_FN = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map(x => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b, a: 1,
  });
  const stack = [];
  for (let n = el; n && n !== document.documentElement.parentNode; n = n.parentElement) {
    const c = parse(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
  }
  stack.push({ r: 255, g: 255, b: 255, a: 1 });
  let bg = stack[stack.length - 1];
  for (let i = stack.length - 2; i >= 0; i--) bg = over(stack[i], bg);
  const fg = parse(getComputedStyle(el).color);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const la = L(over(fg, bg)), lb = L(bg);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return { ratio: (hi + 0.05) / (lo + 0.05), fg: getComputedStyle(el).color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` };
};

test.describe("v8.8.0 — the late-entry badge, filter chip and row badges", () => {
  /** @type {any} */ let S;
  let openComp, closedComp, task, member;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    S = await sa();
    // Both built LIVE and populated, then expired — an ended event refuses the
    // CHALLENGE assignment for good; the participant assign it refused too until
    // v8.12.6, when one still taking late entries began admitting it (as a late
    // entrant). These fixtures want an ordinary member, so they enrol while LIVE.
    openComp = await makeBooth(S.api, S.csrf);
    task = await makeTask(S.api, S.csrf, openComp.id);
    member = await makeParticipant(S.api, S.csrf, openComp.id);
    closedComp = await makeBooth(S.api, S.csrf);
    expireEvent(openComp.id, 30);         // window OPEN
    expireEvent(closedComp.id, 49 * 60);  // window CLOSED
    await new Promise(r => setTimeout(r, 1_300));
  });

  test("the events table badges it apart from a finished event, and the CONTROL still reads Ended", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Competitions");
    await awaitCompModel(page);

    const open = await compRow(page, openComp.name);
    const badge = open.locator(".status-badge");
    await expect(badge, "the open window has its own badge").toHaveClass(/late-entry/);
    await expect(badge).toContainText(/late entry open/i);
    await expect(badge, "…and does NOT read Ended").not.toContainText(/^\s*Ended\s*$/i);

    // CONTROL — without this, "the badge says Late entry open" is satisfied by a
    // build that relabelled every ended event.
    await selectOnlyChip(page, "ended");
    const closed = await compRow(page, closedComp.name);
    const cb = closed.locator(".status-badge");
    await expect(cb, "a lapsed window is an ordinary ended event").toHaveClass(/ended/);
    await expect(cb).toContainText(/ended/i);
  });

  test("the Late entry chip is ON by default, and the event is listed without touching a filter", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Competitions");
    await awaitCompModel(page);

    await expect(page.locator('#comp-status-filters [data-status="late-entry"]'),
      "the chip exists and is active out of the box").toHaveClass(/active/);
    // Listed with the DEFAULT chips — no interaction at all before this read.
    await expect(await compRow(page, openComp.name), "the open window is in the default view").toBeVisible();

    // CONTROL — the default must NOT have started showing finished events.
    await narrowEventsTable(page, closedComp.name);
    await expect(page.locator("#admin-comp-body tr", { hasText: closedComp.name }),
      "a lapsed window is still hidden by default").toHaveCount(0);
  });

  test("it answers its OWN chip and not the Ended chip", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Competitions");
    await awaitCompModel(page);

    await selectOnlyChip(page, "late-entry");
    await expect(await compRow(page, openComp.name), "shown under its own chip").toBeVisible();

    // The separation IS the feature: leaving it in Ended too would mean the new
    // chip narrowed nothing an operator could see.
    await selectOnlyChip(page, "ended");
    await narrowEventsTable(page, openComp.name);
    await expect(page.locator("#admin-comp-body tr", { hasText: openComp.name }),
      "an open window is NOT an Ended event").toHaveCount(0);

    // Ticking EVERY specific chip must fall back to All. The toggle used to test
    // `size === 3` against three chips; with a fourth that literal makes "all
    // selected" unreachable and the All chip can never light up again, so the
    // count is derived from the rendered chips. Nothing else here would notice.
    // The set of chips to click is snapshotted BEFORE clicking any: reaching the
    // full set collapses to All and deactivates every specific chip, so a loop
    // that re-reads would click one again and drop straight back out of it.
    const inactive = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#comp-status-filters .filter-btn"))
        .filter(b => b.dataset.status !== "all" && !b.classList.contains("active"))
        .map(b => b.dataset.status));
    for (const st of inactive) await page.locator(`#comp-status-filters [data-status="${st}"]`).click();
    await expect(page.locator('#comp-status-filters [data-status="all"]'),
      "every specific chip selected collapses to All").toHaveClass(/active/);
  });

  test("the Challenges and Participants columns show the badge that used to be dropped", async ({ page }) => {
    await adminLogin(page);

    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, task.title);
    const trow = page.locator("#admin-task-body tr", { hasText: task.title });
    await expect(trow.first()).toBeVisible({ timeout: 15000 });
    const tbadge = trow.first().locator(`.comp-badge[data-comp-id="${openComp.id}"]`);
    await expect(tbadge, "the challenge row names the still-open event").toHaveCount(1);
    await expect(tbadge, "…in its own hue, not Upcoming's and not Ended's").toHaveClass(/comp-late-entry/);

    await clickTab(page, "Participants");
    await narrowPeopleTable(page, member.nickname);
    const prow = page.locator("#admin-participants-body tr", { hasText: member.nickname });
    await expect(prow.first()).toBeVisible({ timeout: 15000 });
    const pbadge = prow.first().locator(`.comp-badge[data-comp-id="${openComp.id}"]`);
    await expect(pbadge, "the participant row names it too").toHaveCount(1);
    await expect(pbadge).toHaveClass(/comp-late-entry/);
  });

  test("the badge is a DIFFERENT colour from Upcoming and from Ended, in both themes", async ({ page }) => {
    // "Separate colour coding" is the operator's requirement, and the class name
    // alone does not carry it: before v8.8.0 `.status-badge.late-entry` existed
    // and resolved to the SAME amber pair as Upcoming, so the two were
    // indistinguishable at a glance — which is precisely what a fourth chip beside
    // Live / Upcoming / Ended must not be. Compared as resolved values rather than
    // pinned to a hex, so a future palette move is free while a COLLISION fails.
    await adminLogin(page);
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    for (const theme of ["dark", "light"]) {
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      const seen = await page.evaluate(() => {
        const read = (cls) => {
          const el = document.createElement("span");
          el.className = "status-badge " + cls;
          document.body.appendChild(el);
          const cs = getComputedStyle(el);
          const v = `${cs.color}|${cs.backgroundColor}`;
          el.remove();
          return v;
        };
        return { late: read("late-entry"), upcoming: read("upcoming"), ended: read("ended") };
      });
      expect(seen.late, `${theme}: late-entry must not reuse Upcoming's pair (${seen.late})`).not.toBe(seen.upcoming);
      expect(seen.late, `${theme}: late-entry must not reuse Ended's pair (${seen.late})`).not.toBe(seen.ended);
    }
  });

  test("the badge clears AA in BOTH themes, measured on the composite", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Competitions");
    await awaitCompModel(page);
    await compRow(page, openComp.name);
    const sel = "#admin-comp-body tr .status-badge.late-entry";
    await expect(page.locator(sel).first()).toBeVisible();

    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    for (const theme of ["dark", "light"]) {
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      const m = await page.evaluate(CONTRAST_FN, sel);
      expect(m, `${theme}: the badge is measurable`).toBeTruthy();
      expect(m.ratio, `${theme}: ${m.fg} on ${m.bg} = ${m.ratio.toFixed(2)}:1 — AA needs 4.5`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
