// @ts-check
//
// v7.23.0 — the top-3 leaderboard ROWS must not encode rank by colour alone.
//
// `.medal.gold` / `.silver` / `.bronze` differ ONLY in `color` (the look's
// metal inks: `.medal.*` = --gold/--silver/--bronze), and `medalTinted()` renders the medal SVG
// `aria-hidden` with a visually-hidden ordinal. So before this fix a sighted
// user reading a leaderboard row saw three identically-shaped medals whose only
// distinguishing feature was hue — WCAG 1.4.1 Use of Color — while every rank
// from 4 down rendered a literal `#4`. Colour-vision deficiency, greyscale
// printing and forced-colors mode (where all three tints resolve to CanvasText)
// each collapse the distinction entirely, and the `sr-only` label helped none
// of them because it is not rendered.
//
// The PODIUM is deliberately exempt and that exemption is asserted here: its
// 120/90/70px block heights are already a non-colour cue, so it keeps the bare
// medal and its own type scale.
//
// Fixture: owns its competition and all three participants (v7.15.32 — never
// authenticate as, or mutate, a shared seeded fixture). Three participants are
// required, not one: the whole point is telling ranks 1, 2 and 3 apart.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = "rankcue";

async function saCtx() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", {
    headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()} ${await r.text()}`).toBeTruthy();
  // The login regenerates the session, so the pre-login token is dead.
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function makeParticipant(api, csrf, n) {
  const email = `${TAG}-${n}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Rank", lastName: `Probe${n}`, nickname: `${TAG}_${n}`, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), await reg.text()).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find((p) => p.email === email);
  expect(u, `participant ${n} must be findable`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { email, id: u.id };
}

test("v7.23.0: top-3 leaderboard rows carry a VISIBLE rank ordinal, not colour alone", async ({ page }) => {
  const { api, csrf } = await saCtx();

  // A live competition of our own.
  const comp = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `Rank Cue ${Date.now()}`,
      start_time: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      duration_minutes: 600, timezone: "UTC",
    },
  });
  expect(comp.status(), await comp.text()).toBe(200);
  // NB: the create response is {ok, competition:{...}} — not the row itself.
  const compId = (await comp.json()).competition.id;

  const users = [];
  for (const n of [1, 2, 3]) users.push(await makeParticipant(api, csrf, n));

  const assign = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map((u) => String(u.id)), competitionIds: [String(compId)] },
  });
  expect(assign.status(), await assign.text()).toBe(200);
  // The assign endpoint SKIPS ineligible users by design, so assert the count
  // rather than trusting the 200 — an empty board would otherwise read as a
  // rendering failure (v7.22.7).
  const assignBody = await assign.json();
  // Carry the WHOLE body: the endpoint reports skippedStaff / skippedUnapproved /
  // skippedBlocked, and a bare "expected 3, got 0" names none of them.
  expect(assignBody.assigned,
    `all three must actually be assigned; got ${JSON.stringify(assignBody)}`).toBe(3);

  // Each participant must SELECT the competition: that is what stamps
  // competition_users.login_time, and a participant with no anchor is excluded
  // from the board entirely (v7.21.3). Without this the board is empty and
  // every assertion below is vacuous.
  for (const u of users) {
    const { api: c, csrf: tok } = await freshCtx();
    const li = await codeLogin(c, u.email, H(tok));
    expect(li.ok(), `${u.email} login: ${li.status()} ${await li.text()}`).toBeTruthy();
    const tok2 = (await (await c.get("/api/csrf-token")).json()).csrfToken;
    const sel = await c.post("/api/select-competition", { headers: H(tok2), data: { competitionId: compId } });
    expect(sel.ok(), `${u.email} select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    await c.dispose();
  }

  // Sign the first participant in through the browser and open the board.
  const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, users[0].email, H(tok));
  expect(li.ok(), `browser login: ${li.status()}`).toBeTruthy();
  const tok2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/select-competition", { headers: H(tok2), data: { competitionId: compId } });

  await page.goto("/");
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().waitFor({ state: "visible", timeout: 20000 });
  await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Leaderboard')").first().click();
  await page.locator("#leaderboard-page.active").waitFor({ state: "visible", timeout: 10000 });

  const rows = page.locator("#leaderboard-page .lb-table tbody tr");
  await expect.poll(() => rows.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(3);

  for (const rank of [1, 2, 3]) {
    const cell = rows.nth(rank - 1).locator("td").first();

    // POSITIVE CONTROL: the medal must still be there. Without this the test
    // would also pass if the medals were simply deleted, which is a different
    // (and worse) change than the one being locked.
    await expect(cell.locator(".medal"), `rank ${rank}: medal missing`).toHaveCount(1);

    // The actual guarantee: the rank is readable as TEXT, not inferred from hue.
    const txt = ((await cell.innerText()) || "").replace(/\s+/g, "");
    expect(txt, `rank ${rank} cell must show a visible ordinal, got ${JSON.stringify(txt)}`).toContain(`#${rank}`);

    // ...and it must be genuinely visible, not an .sr-only clipped span.
    const ord = cell.locator(".medal-ord");
    await expect(ord, `rank ${rank}: .medal-ord missing`).toHaveCount(1);
    const box = await ord.boundingBox();
    expect(box && box.width > 4 && box.height > 4,
      `rank ${rank}: ordinal is not perceivably rendered (box=${JSON.stringify(box)})`).toBe(true);
  }

  // The podium keeps the bare medal — the exemption is deliberate (its block
  // heights are the non-colour cue) so it is asserted rather than assumed. The
  // three participants ARE the top three, so the podium must be there: counted,
  // never skipped when absent.
  const podium = page.locator("#podium-row .podium-num");
  await expect(podium, "precondition: the board's three participants stand on the podium").toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(podium.nth(i).locator(".medal"), "podium should still show a medal").toHaveCount(1);
    await expect(podium.nth(i).locator(".medal-ord"), "podium must NOT gain the row ordinal").toHaveCount(0);
  }

  await api.dispose();
});
