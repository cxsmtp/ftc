// @ts-check
//
// THE CLIENT HALF of "a medal certificate needs points above zero" (operator
// ruling, 14 Nov 2026; the server half is tests/placement-points.api.spec.js).
//
// The browser's `earnsPlacement` (public/js/ui/format.js) is a copy of the
// server's (lib/badge.js): browser modules cannot import lib/. It is held to the
// server's body here, and it decides three surfaces:
//   * the organiser's Rankings "Top three" panel — places on zero or less get no
//     medal preview, and a note names them;
//   * the participant's certificate card — before a certificate is held it
//     names the one the mint will issue;
//   * the podium chip (also pinned by tests/rankings-top-three.spec.js).
// The boards are intercepted: what is under test is what the client does with
// each answer.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, codeLogin, BASE, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { stripJsComments } = require("./doc-registry");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("the browser's earnsPlacement is the server's, body for body", () => {
  const ROOT = path.join(__dirname, "..");
  const bodyOf = (rel, re) => {
    const src = stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const m = re.exec(src);
    expect(m, `${rel} defines earnsPlacement`).toBeTruthy();
    return m[1].replace(/\s+/g, " ").trim();
  };
  const server = bodyOf("lib/badge.js", /\nfunction earnsPlacement\(e\) \{([\s\S]*?)\n\}/);
  const client = bodyOf("public/js/ui/format.js", /\nexport function earnsPlacement\(e\) \{([\s\S]*?)\n\}/);
  // Anti-vacuity: the body states both halves of the rule.
  expect(server).toContain("e.score > 0");
  expect(server).toMatch(/e\.rank === 3/);
  expect(client, "the client copy is the server's rule").toBe(server);
  // And it is the rule: one behavioural matrix on the server's copy.
  const { earnsPlacement } = require("../lib/badge.js");
  const cases = [[{ rank: 1, score: 1 }, true], [{ rank: 3, score: 50 }, true], [{ rank: 1, score: 0 }, false],
    [{ rank: 2, score: -5 }, false], [{ rank: 4, score: 300 }, false], [{ rank: null, score: 10 }, false], [null, false]];
  for (const [e, want] of cases) expect(earnsPlacement(e), JSON.stringify(e)).toBe(want);
});

// ─── The organiser's Top three panel ──────────────────────────────────────────

const row = (o) => ({
  userId: o.id, nickname: o.nick, avatar: "default1", score: o.score, finishTime: null, solveTimeMs: 1000,
  allSolved: false, rank: o.rank, firstName: o.first, lastName: o.last, company: "Co", email: `${o.nick}@x.test`,
  incorrectCount: 0, pointsLostIncorrect: 0, hintCount: 0, pointsLostHints: 0, pointsLostTotal: 0,
});
const board = (scores) => scores.map((s, i) => row({ id: `u${i + 1}`, nick: `n${i + 1}`, first: ["Ada", "Bo", "Cy", "Di"][i], last: "X", rank: i + 1, score: s }));

test.describe("Rankings — the Top three panel follows the certificate", () => {
  test("a top-three place on zero or less gets no medal preview, and the note names it", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    let ev;
    try {
      const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `PPTop ${uniq()}`, event_kind: "tournament", start_time: new Date(Date.now() - 3 * 3600_000).toISOString(), duration_minutes: 60 } });
      expect(r.status(), await r.text()).toBe(200);
      ev = (await r.json()).competition;
    } finally { await api.dispose(); }
    let current = board([300, 200, 0, 50]);
    await page.route("**/api/admin/leaderboard*", (r) => r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(r.request().url().includes("groups=1") ? [] : current) }));
    await page.route(`**/api/admin/competitions/${ev.id}/certificates`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"certificates":[]}' }));
    await page.route("**/api/admin/certificate-config/preview", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await adminLogin(page);
    await clickTab(page, "Events");
    await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), ev.id), { timeout: 20000 }).toBe(true);
    await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), ev);
    await clickTab(page, "Rankings");
    const box = page.locator("#admin-rankings-certs");
    await expect(box).toBeVisible({ timeout: 20000 });
    const ranks = () => box.locator(".rk-cert").evaluateAll((li) => li.map((x) => x.dataset.rank));
    const render = async (scores) => {
      current = board(scores);
      await page.evaluate(() => window.loadAdminRankingsTab());
    };

    // 3rd place holds 0 points: 1st and 2nd keep their previews, 3rd has none.
    await expect.poll(ranks).toEqual(["1", "2"]);
    // The panel cannot know whether the finisher attempted a challenge (a no-show
    // on 0 points gets no certificate at all), so the note says "if".
    await expect(box.locator(".rk-certs-zero")).toHaveText("No medal certificate for 3rd place: a top-three place earns Gold, Silver or Bronze only with points above zero; that finisher gets a participation certificate if they attempted a question.");
    await expect(box.locator('[data-action="rk-cert-download"][data-rank="3"]'), "no Bronze to download").toHaveCount(0);
    await expect(box, "nor is the finisher offered one by name").not.toContainText("Cy X");

    // 2nd and 3rd below zero: one medal left.
    await render([300, -5, -10, -20]);
    await expect.poll(ranks).toEqual(["1"]);
    await expect(box.locator(".rk-certs-zero")).toContainText("No medal certificate for 2nd and 3rd place:");
    await expect(box.locator(".rk-certs-zero")).toContainText("those finishers get a participation certificate if they attempted a question.");

    // Nobody scored: the panel says why there are no medals, and lists none.
    await render([0, 0, -5, -5]);
    await expect(box.locator(".rk-certs-zero")).toContainText("No medal certificate for 1st, 2nd and 3rd place:");
    await expect(box.locator(".rk-cert"), "no medal row at all").toHaveCount(0);
    await expect(box.locator(".rk-certs-list")).toHaveCount(0);

    // CONTROL: three scorers, three medals and no note.
    await render([300, 200, 100, 50]);
    await expect.poll(ranks).toEqual(["1", "2", "3"]);
    await expect(box.locator(".rk-certs-zero")).toHaveCount(0);
  });
});

// ─── The participant's certificate card ───────────────────────────────────────

async function mkParticipantInLiveEvent() {
  const label = `ppc${uniq()}`.slice(0, 18), email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Poi", lastName: "Nts", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "X" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const list = await (await api.get("/api/admin/participants?limit=5000")).json();
    const u = (list.participants || list.users || []).find((x) => x.email === email);
    expect(u, "the participant is findable").toBeTruthy();
    for (const ep of ["verify", "approve"]) expect((await api.post(`/api/admin/participants/${u.id}/${ep}`, { headers: H(csrf) })).ok()).toBeTruthy();
    const c = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `PPCard ${uniq()}`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
    expect(c.ok(), await c.text()).toBeTruthy();
    const compId = (await c.json()).competition.id;
    for (const t of ["A", "B"]) {
      const tr = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `PPCard ${t} ${uniq()}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" } });
      expect(tr.ok(), await tr.text()).toBeTruthy();
      const ar = await api.post(`/api/admin/tasks/${(await tr.json()).id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
      expect((await ar.json()).assigned, `challenge ${t} is on the event`).toBe(1);
    }
    const as = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [compId] } });
    expect((await as.json()).assigned, "the participant is enrolled").toBe(1);
    return { email, compId };
  } finally { await api.dispose(); }
}

const lbRow = (o) => ({ userId: o.id, nickname: `nick-${o.id}`, avatar: "default1", score: o.score, solveTimeMs: 1000, allSolved: false, rank: o.rank });

test.describe("the participant's certificate card names the certificate the mint will issue", () => {
  test("1st place on zero points is told they took part; 1st place with points that they placed", async ({ page }) => {
    const f = await mkParticipantInLiveEvent();
    const boardOf = (meScore) => [lbRow({ id: "ME", rank: 1, score: meScore }), lbRow({ id: "B", rank: 2, score: meScore - 5 }), lbRow({ id: "C", rank: 3, score: meScore - 10 })];
    const pay = (b) => ({ ranking_enabled: true, top3: b, board: b, me: b[0], groupBoard: null, lateBoard: null, board_limit: 20,
      ended: true, canShareBadge: true, lateEntrantMe: false, lateWindowOpen: false, lateDeadline: null,
      placementCertificates: true });   // as the route sends for an event that is not a dry run
    let current = pay(boardOf(0));
    await page.route("**/api/leaderboard*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }));

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    expect((await codeLogin(page.request, f.email, H(csrfToken), { password: PARTICIPANT_PASS })).ok()).toBeTruthy();
    await page.goto("/");
    const inside = page.locator("#nav-leaderboard:not([aria-disabled=true])");
    const card = page.locator(`#comp-grid [data-comp-id="${f.compId}"] .card-open`).first();
    await expect.poll(async () => (await inside.isVisible().catch(() => false)) || (await card.isVisible().catch(() => false)), { timeout: 30000 }).toBe(true);
    if (!(await inside.isVisible().catch(() => false))) {
      await card.click();
      const ok = page.locator("#modal-confirm-btn");
      if (await ok.isVisible().catch(() => false)) await ok.click();
    }
    await inside.click({ timeout: 20000 });
    const cta = page.locator("#lb-badge-cta");
    await expect(cta).toBeVisible({ timeout: 20000 });

    // 1st on zero points: participation, by the card's own words.
    await expect(cta).toContainText("You took part in");
    await expect(cta).not.toContainText("You placed");
    await expect(cta.locator(".lb-cert-t")).toHaveText("Certificate of participation");
    // …and the podium names no certificate on any of the three places.
    await expect(page.locator("#podium-row .podium-cert"), "no medal certificate is named for zero or less").toHaveCount(0);
    await expect(page.locator("#podium-row .podium-slot"), "the podium still shows the three places").toHaveCount(3);

    // CONTROL: the same place with points earns the medal, card and podium alike.
    current = pay(boardOf(300));
    await page.evaluate(() => window.loadLeaderboard({ silent: true }));
    await expect(cta).toContainText("You placed");
    await expect(cta.locator(".lb-cert-t")).toHaveText("Certificate of achievement · 1st place");
    await expect(page.locator("#podium-row .podium-cert")).toHaveCount(3);
  });
});

// A dry run never mints (`isDryRunCompetition`), so its final podium must not
// name a certificate a place cannot have. Driven through the real server: the
// leaderboard route says whether the event issues placement certificates.
test.describe("the podium names no certificate on a dry run", () => {
  test("a dry-run event's final podium shows the place and no certificate; untagged, the same place names Gold (CONTROL)", async ({ page }) => {
    const f = await mkParticipantInLiveEvent();
    const p = await apiLogin(f.email, PARTICIPANT_PASS);
    try {
      const sel = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: f.compId } });
      expect(sel.status(), await sel.text()).toBe(200);
      const tasks = await (await p.api.get("/api/tasks", { headers: { "x-competition-id": f.compId } })).json();
      const t = (Array.isArray(tasks) ? tasks : tasks.tasks)[0];
      const s = await p.api.post(`/api/tasks/${t.id}/submit`, { headers: { ...H(p.csrf), "x-competition-id": f.compId },
        data: { answer: "x", gradingHash: await gradingHashFor(p.api, t.id) } });
      expect(s.status(), await s.text()).toBe(200);
      expect((await s.json()).correct, "PRECONDITION: points above zero (one of two challenges, so no all-solved end)").toBe(true);
    } finally { await p.api.dispose(); }
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const end = await sa.post(`/api/admin/competitions/${f.compId}/end-now`, { headers: H(csrf), data: {} });
      expect(end.status(), await end.text()).toBe(200);
      const tag = await sa.post(`/api/admin/competitions/${f.compId}/tags`, { headers: H(csrf), data: { tag: "test/dry run" } });
      expect(tag.status(), await tag.text()).toBe(200);
    } finally { await sa.dispose(); }

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    expect((await codeLogin(page.request, f.email, H(csrfToken), { password: PARTICIPANT_PASS })).ok()).toBeTruthy();
    const pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: f.compId } });
    expect(sel.status(), await sel.text()).toBe(200);
    // The "Event Ended" popup would cover the board (fixture checklist item 10).
    const dis = await page.request.post("/api/dismiss-ended", { headers: { ...H(pc), "x-competition-id": f.compId }, data: {} });
    expect(dis.status(), await dis.text()).toBe(200);
    const lb = await (await page.request.get("/api/leaderboard", { headers: { "x-competition-id": f.compId } })).json();
    expect(lb.ended, "PRECONDITION: the board is final").toBe(true);
    expect(lb.top3.map(x => [x.rank, x.score > 0]), "PRECONDITION: rank 1 on points above zero").toEqual([[1, true]]);
    expect(lb.placementCertificates, "the route says a dry run issues no certificates").toBe(false);

    await page.goto("/");
    const inside = page.locator("#nav-leaderboard:not([aria-disabled=true])");
    await expect(inside).toBeVisible({ timeout: 30000 });
    await inside.click();
    await expect(page.locator("#podium-row .ps1"), "the place is still shown").toBeVisible({ timeout: 20000 });
    await expect(page.locator("#podium-row .podium-cert"), "no certificate is named on a dry run").toHaveCount(0);

    // CONTROL: the same place on the same event, untagged, names the Gold certificate.
    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    try {
      const un = await sa2.delete(`/api/admin/competitions/${f.compId}/tags/${encodeURIComponent("test/dry run")}`, { headers: H(c2) });
      expect(un.status(), await un.text()).toBe(200);
    } finally { await sa2.dispose(); }
    await page.evaluate(() => window.loadLeaderboard({ silent: true }));
    await expect(page.locator("#podium-row .ps1 .podium-cert")).toHaveText("Gold certificate");
  });
});
