// @ts-check
//
// THE FINAL BOARD: ITS PODIUM AND THE CERTIFICATE CARD (public/js/features/leaderboard.js).
//
// What a participant sees on the board once the event is over, each lock beside a
// control that shows the witness can see what it says is absent:
//
//   1. The podium names the certificate each place earns (Gold / Silver / Bronze)
//      only once the board is FINAL (control: the same board while live names
//      none). The table starts at rank 4 — places 1-3 stand on the podium, their
//      rows kept but hidden — and a column sort shows every row again.
//   2. The certificate card's states, read from the participant's own list:
//      "Get my certificate" before one is held; once held, the PDF download, the
//      image, the code and the emailed-on date; and a REVOKED certificate offers
//      nothing — no share button the mint would refuse, no rendition, no download
//      (control: the same card before the revoke had all three).
//   3. An aged held entry is shown until the re-read answers, never flipped to
//      "Get my certificate" for the length of the round trip, and a re-read that
//      changes nothing re-fetches no board (controls: one that changes it — the
//      name the certificate prints, a revoke — repaints at once).
//   4. The card's Time figure stays inside its column at 1280, 390 and 360: on
//      one line wherever it fits ("under 1 s", a long clock), and a year-long
//      clock too long for its column (the card's side column on a desktop, a
//      360 px phone) wraps only between its parts, never parting a number from
//      its unit (control: on one line it would not fit).
//   5. A held certificate's card is never drawn as "Get my certificate" while its
//      first read is out: on the first load, and after the dialog closes (sweep
//      #289; control: the recorder sees that label on a card holding none).
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/**
 * A ranked event of its own: five participants on five distinct scores (250, 200,
 * 150, 100, 50) and nobody solving all three challenges, so nothing ends it early
 * (fixture checklist item 1). Each participant enters the event (checklist 5), so
 * all five are on the board, and their marker resumes them into it at sign-in.
 */
async function rankedEvent(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const comp = await makeCompetition(sa, csrf, label);
    const tE = await makeTask(sa, csrf, `${label}-e`, { difficulty: "easy" });
    const tM = await makeTask(sa, csrf, `${label}-m`, { difficulty: "medium" });
    const tH = await makeTask(sa, csrf, `${label}-h`, { difficulty: "hard" });
    for (const t of [tE, tM, tH]) await assignTask(sa, csrf, t.id, [comp.id]);
    const people = [];
    for (let i = 1; i <= 5; i++) people.push(await makeParticipant(sa, csrf, `${label}${i}`));
    await enrol(sa, csrf, comp.id, people.map((p) => p.id));
    const solves = [[tM, tH], [tE, tH], [tH], [tM], [tE]];
    for (let i = 0; i < people.length; i++) {
      const P = await apiLogin(people[i].email);
      try {
        const sel = await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: comp.id } });
        expect(sel.ok(), `select ${i + 1}: ${await sel.text()}`).toBeTruthy();
        for (const t of solves[i]) {
          const r = await P.api.post(`/api/tasks/${t.id}/submit`, {
            headers: H(P.csrf), data: { answer: "a", gradingHash: await gradingHashFor(P.api, t.id) },
          });
          expect(r.ok(), `solve ${i + 1}: ${await r.text()}`).toBeTruthy();
          expect((await r.json()).correct, `precondition: participant ${i + 1} solved ${t.title}`).toBe(true);
        }
      } finally { await P.api.dispose(); }
    }
    return { comp, people, tasks: [tE, tM, tH] };
  } finally { await sa.dispose(); }
}

async function endNow(compId) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) });
    expect(r.ok(), `end now: ${await r.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
}

/**
 * Sign in in the browser and open the event's board. On an ENDED event the
 * sign-in lands behind the "Event Ended" notice, whose View Leaderboard is the
 * way to the board; on a live one the nav button is.
 */
async function openBoard(page, email, { ended = false } = {}) {
  await loginViaApi(page, email);
  await page.goto("/");
  const nav = page.locator("#nav-leaderboard:not([aria-disabled=true])");
  await expect(nav, "PRECONDITION: the participant is in the event").toBeVisible({ timeout: 20000 });
  if (ended) {
    await expect(page.locator("#modal-overlay.open"), "the ended notice").toContainText("has ended", { timeout: 20000 });
    await page.getByRole("button", { name: "View Leaderboard" }).click();
  } else {
    await nav.click();
  }
  await expect(page.locator("#leaderboard-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.locator("#lb-body tr[data-uid]").count(), { timeout: 15000 }).toBe(5);
}

/** Re-render the board as a fresh read: forget the held certificate, then load. */
async function rerender(page) {
  await page.evaluate(async () => { window.forgetCertHeld(); await window.loadLeaderboard({ silent: true }); });
}

const card = (page) => page.locator("#lb-badge-cta .lb-cert");

test("the podium names each certificate only once final; the table starts at rank 4; a sort shows every row", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await rankedEvent("pod");
  await openBoard(page, f.people[0].email);
  const body = page.locator("#lb-body");
  const scoresOf = (sel) => body.locator(sel).evaluateAll((trs) => trs.map((t) => Number(t.dataset.score)));

  // LIVE: three podium places, and none of them names a certificate yet.
  await expect(page.locator("#podium-row .podium-slot")).toHaveCount(3);
  await expect(page.locator("#podium-row .podium-cert"), "a live board names no certificate").toHaveCount(0);
  // The table starts below the podium: places 1-3 are kept but hidden.
  expect(await scoresOf("tr[hidden]"), "places 1-3 are on the podium, not in the table").toEqual([250, 200, 150]);
  expect(await scoresOf("tr:not([hidden])"), "the table starts at rank 4").toEqual([100, 50]);
  await expect(body.locator("tr:not([hidden])").first().locator(".lb-rank")).toContainText("#4");
  // A column sort is "everyone, by that column": every row shows again.
  await page.locator('#leaderboard-page th[data-action="sort-leaderboard"][data-col="player"]').click();
  await expect(body.locator("tr[hidden]")).toHaveCount(0);
  await expect(body.locator("tr:not([hidden])")).toHaveCount(5);

  // FINAL: each podium place names the certificate it earns.
  await endNow(f.comp.id);
  await page.evaluate(() => window.loadLeaderboard({ silent: true }));
  await expect(page.locator("#lb-page-title")).toHaveText("Final standings", { timeout: 10000 });
  const chip = (rank) => page.locator(`#podium-row .ps${rank} .podium-cert`);
  await expect(chip(1)).toHaveText(/Gold certificate/);
  await expect(chip(2)).toHaveText(/Silver certificate/);
  await expect(chip(3)).toHaveText(/Bronze certificate/);
});

test("the certificate card: get, then download with the image, the code and the emailed date; a revoked one offers nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await rankedEvent("card");
  await endNow(f.comp.id);
  await openBoard(page, f.people[0].email, { ended: true });

  // Not held yet: one gold action that mints.
  await expect(card(page)).toBeVisible({ timeout: 10000 });
  const action = card(page).locator('[data-action="open-badge-share"]');
  await expect(action).toHaveCount(1);
  await expect(action).toHaveText(/Get my certificate/);
  await expect(card(page).locator(".lb-cert-dl")).toHaveCount(0);

  // Held: the PDF, the image and the code, all of THIS certificate.
  const csrf = await page.evaluate(() => window.S.csrfToken);
  const mint = await page.request.post(`/api/competitions/${f.comp.id}/badge`, { headers: H(csrf) });
  expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
  const token = (await mint.json()).token;
  const mine = ((await (await page.request.get("/api/me/certificates")).json()).certificates || [])
    .find((c) => c.competitionId === f.comp.id);
  expect(mine && mine.pdfUrl && mine.code, `precondition: the list holds it: ${JSON.stringify(mine)}`).toBeTruthy();
  await rerender(page);
  const dl = card(page).locator("a.lb-cert-dl");
  await expect(dl).toHaveText(/Download certificate/);
  expect(await dl.getAttribute("href"), "the participant's own PDF").toBe(mine.pdfUrl);
  expect(await card(page).locator("a.lb-cert-png").getAttribute("href")).toBe(`${mine.imageUrl}?dl=1`);
  await expect(card(page).locator(".lb-cert-code")).toHaveText(mine.code);
  await expect(card(page).locator('[data-action="open-badge-share"]')).toHaveText(/Share on LinkedIn/);
  await expect(card(page).locator(".lb-cert-thumb")).toHaveCount(1);
  // CONTROL for the revoked card below: a held certificate's card says how to share and download it.
  await expect(card(page).locator(".lb-badge-cta-text")).toContainText(/on LinkedIn, or download it/);
  await expect(card(page).locator(".lb-cert-meta"), "no email was sent here").not.toContainText("Emailed");

  // The emailed date, when the certificate was mailed (the dispatcher's answer
  // is stubbed: under test no mail leaves the relay).
  const sentAt = "2026-03-14T09:30:00.000Z";
  await page.route("**/api/me/certificates", async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    for (const c of d.certificates || []) if (c.competitionId === f.comp.id) c.emailedAt = sentAt;
    await route.fulfill({ response: res, json: d });
  });
  await rerender(page);
  await expect(card(page).locator(".lb-cert-meta")).toContainText("Emailed to you on");
  await page.unroute("**/api/me/certificates");

  // REVOKED: the card says so and offers nothing the mint would refuse.
  const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
  try {
    const rv = await sa.post(`/api/admin/badges/${token}/revoke`, { headers: H(saCsrf), data: { reason: "test" } });
    expect(rv.ok(), `revoke: ${await rv.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
  await rerender(page);
  await expect(card(page).locator(".lb-cert-meta")).toContainText("This certificate has been revoked");
  await expect(card(page).locator('[data-action="open-badge-share"]'), "no share or get button for a revoked certificate").toHaveCount(0);
  await expect(card(page).locator(".lb-cert-dl")).toHaveCount(0);
  await expect(card(page).locator(".lb-cert-thumb"), "no rendition of a revoked certificate").toHaveCount(0);
  // Nor a line about sharing or downloading it beside "has been revoked": read
  // once, from the card the revoke line above is already on.
  const text = await card(page).locator(".lb-badge-cta-text").innerText();
  expect(text, "the card still says what the participant did").toMatch(/You placed/);
  expect(text, "no sharing line over a revoked certificate").not.toMatch(/LinkedIn|download/i);
  // The board's own facts still stand beside it.
  await expect(card(page).locator(".lb-cert-kpis")).toContainText("250");
});

// The card's rendition of the certificate names the holder as the certificate
// prints the name (operator ruling, 14 Nov 2026: a Chinese, Japanese or Korean
// name family name first, with no space): the server's rule, read from the
// account (`certificate_printed_name`) until a certificate is held, then from
// the held certificate (`name`), never first + last composed in the browser.
test("the card's rendition names the holder as the certificate prints the name", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await rankedEvent("nm");
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const put = await sa.put(`/api/admin/participants/${f.people[0].id}`, { headers: H(csrf), data: { firstName: "伟", lastName: "张" } });
    expect(put.ok(), `rename: ${await put.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
  await endNow(f.comp.id);
  await openBoard(page, f.people[0].email, { ended: true });
  const name = card(page).locator(".lb-cert-thumb .lb-cert-n");
  // Not held yet: the account's printed name.
  await expect(card(page).locator('[data-action="open-badge-share"]')).toHaveText(/Get my certificate/, { timeout: 10000 });
  await expect(name).toHaveText("张伟");
  expect(await page.evaluate(() => [window.S.currentUser.first_name, window.S.currentUser.last_name]),
    "PRECONDITION: the profile holds the name given name first").toEqual(["伟", "张"]);
  await expect(card(page), "the profile's own order is nowhere on the card").not.toContainText("伟 张");

  // Held: the certificate's own printed name, re-read with it.
  const pcsrf = await page.evaluate(() => window.S.csrfToken);
  const mint = await page.request.post(`/api/competitions/${f.comp.id}/badge`, { headers: H(pcsrf) });
  expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
  await rerender(page);
  await expect(card(page).locator("a.lb-cert-dl"), "precondition: the card holds the certificate").toHaveCount(1);
  await expect(name).toHaveText("张伟");
  // The held certificate is the source once there is one: what its list entry
  // says is what the rendition shows.
  await page.route("**/api/me/certificates", async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    for (const c of d.certificates || []) if (c.competitionId === f.comp.id) c.name = "Probe Held-Name";
    await route.fulfill({ response: res, json: d });
  });
  await rerender(page);
  await expect(name).toHaveText("Probe Held-Name");
  await page.unroute("**/api/me/certificates");
});

test("an aged held entry stays on the card until the re-read answers; only a re-read that changes it repaints", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await rankedEvent("age");
  await endNow(f.comp.id);
  await openBoard(page, f.people[0].email, { ended: true });
  // Every board read below is the test's own or the repaint's: the board's 15 s
  // interval is stopped, so its tick cannot land inside an observation window.
  await page.evaluate(() => { clearInterval(window.S.lbInterval); window.S.lbInterval = null; });
  const csrf = await page.evaluate(() => window.S.csrfToken);
  const mint = await page.request.post(`/api/competitions/${f.comp.id}/badge`, { headers: H(csrf) });
  expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
  await rerender(page);
  await expect(card(page).locator("a.lb-cert-dl"), "precondition: the card holds the certificate").toHaveCount(1);

  // Each round: a minute on, the held entry is due a re-read; the re-read is
  // held open, so the render in between is what the participant sees for the
  // round trip. `alter` edits what the re-read answers.
  let reReads = 0, gate = null, release = null, alter = null;
  await page.route("**/api/me/certificates", async (route) => {
    reReads++;
    const res = await route.fetch();
    const d = await res.json();
    if (alter) alter(d);
    await gate;
    await route.fulfill({ response: res, json: d });
  });
  // Board reads are counted IN THE PAGE, as they are asked for: a repaint calls
  // loadLeaderboard, whose fetch is issued before the re-read's promise settles
  // (leaderboard.js certRereadSettled). So once that promise has settled the
  // count is final — no window to wait out for an absence.
  await page.evaluate(() => {
    const f0 = window.fetch;
    window.__boardReads = 0;
    window.fetch = function (u) {
      if (new URL(typeof u === "string" ? u : u.url, location.origin).pathname === "/api/leaderboard") window.__boardReads++;
      return f0.apply(this, arguments);
    };
  });
  let shift = 0;
  async function round(n) {
    gate = new Promise((r) => { release = r; });
    shift += 61_000;
    await page.evaluate(async (ms) => {
      const real = window.__realNow || (window.__realNow = Date.now.bind(Date));
      Date.now = () => real() + ms;
      await window.loadLeaderboard({ silent: true });
    }, shift);
    await expect.poll(() => reReads, { message: `CONTROL: the aged entry was re-read (round ${n})` }).toBe(n);
    await expect(card(page).locator("a.lb-cert-dl"), "the card keeps the download while the re-read is out").toHaveCount(1);
    await expect(card(page).locator('[data-action="open-badge-share"]')).toHaveText(/Share on LinkedIn/);
    const before = await page.evaluate(() => window.__boardReads);
    release();
    // The re-read has answered and decided whether to repaint.
    const after = await page.evaluate(async () => { await window.certRereadSettled(); return window.__boardReads; });
    return after - before;
  }

  // The re-read answers the same certificate: nothing to repaint, so no board is fetched.
  expect(await round(1), "an unchanged re-read re-fetches no board").toBe(0);
  await expect(card(page).locator("a.lb-cert-dl")).toHaveCount(1);

  // A re-read that changes only the NAME the certificate prints (its holder was
  // renamed meanwhile) repaints too: the card's rendition names them as it does.
  const shown = card(page).locator(".lb-cert-thumb .lb-cert-n");
  await expect(shown, "PRECONDITION: the rendition names the holder by another name").not.toHaveText("Probe Renamed Holder");
  alter = (d) => { for (const c of d.certificates || []) if (c.competitionId === f.comp.id) c.name = "Probe Renamed Holder"; };
  expect(await round(2), "a re-read that renames the holder repaints the card").toBe(1);
  await expect(shown).toHaveText("Probe Renamed Holder");

  // CONTROL: a re-read that CHANGES the certificate (revoked meanwhile) repaints at once.
  alter = (d) => { for (const c of d.certificates || []) if (c.competitionId === f.comp.id) { c.name = "Probe Renamed Holder"; c.revoked = true; } };
  expect(await round(3), "a changed re-read repaints the card").toBe(1);
  await expect(card(page).locator(".lb-cert-meta")).toContainText("This certificate has been revoked");
  await expect(card(page).locator(".lb-cert-dl")).toHaveCount(0);
  await page.evaluate(() => { if (window.__realNow) Date.now = window.__realNow; });
  await page.unroute("**/api/me/certificates");
});

// Sweep #289 — every label the card's action has been drawn with, in order: a
// new button node is one paint (two paints with the same words are two entries).
async function recordCardLabels(page) {
  await page.addInitScript(() => {
    window.__cardLabels = []; window.__lastBtn = null;
    const look = () => {
      const b = document.querySelector('#lb-badge-cta .lb-cert [data-action="open-badge-share"]');
      if (b && b !== window.__lastBtn) { window.__lastBtn = b; window.__cardLabels.push((b.textContent || "").trim()); }
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
  });
}
/** Hold every read of the participant's own certificates until `open()`. */
async function gateCertReads(page) {
  const g = { reads: 0, open: null };
  let gate = new Promise((r) => { g.open = r; });
  await page.route("**/api/me/certificates", async (route) => {
    g.reads++;
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  return g;
}
const labels = (page) => page.evaluate(() => window.__cardLabels.slice());

test("sweep #289: a held certificate's card waits for its first read, never drawn as 'Get my certificate'", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await rankedEvent("first");
  await endNow(f.comp.id);
  const P = await apiLogin(f.people[0].email);
  try {
    const m = await P.api.post(`/api/competitions/${f.comp.id}/badge`, { headers: H(P.csrf) });
    expect(m.ok(), `the holder mints first: ${await m.text()}`).toBeTruthy();
  } finally { await P.api.dispose(); }
  await recordCardLabels(page);
  const g = await gateCertReads(page);
  await loginViaApi(page, f.people[0].email);
  await page.goto("/");
  await expect(page.locator("#modal-overlay.open"), "the ended notice").toContainText("has ended", { timeout: 20000 });
  await page.getByRole("button", { name: "View Leaderboard" }).click();
  await expect(page.locator("#leaderboard-page")).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.locator("#lb-body tr[data-uid]").count(), { timeout: 15000 }).toBe(5);
  await expect.poll(() => g.reads, { message: "PRECONDITION: the card's read is out" }).toBeGreaterThanOrEqual(1);
  expect(await labels(page), "nothing is drawn as not held while the read is out").not.toContain("Get my certificate");
  g.open();
  await expect(card(page).locator("a.lb-cert-dl"), "once read, the held certificate's download").toHaveCount(1, { timeout: 10000 });
  const seen = await labels(page);
  expect(seen.length, "CONTROL: the recorder saw the card").toBeGreaterThan(0);
  expect(seen.filter((l) => /Get my certificate/.test(l)), `never 'Get my certificate': ${JSON.stringify(seen)}`).toEqual([]);
  await page.unroute("**/api/me/certificates");
});

test("sweep #289: after the dialog mints, the card goes straight to the held certificate (CONTROL: before, it offered 'Get my certificate')", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await rankedEvent("dlg");
  await endNow(f.comp.id);
  await recordCardLabels(page);
  await openBoard(page, f.people[1].email, { ended: true });
  await expect(card(page).locator('[data-action="open-badge-share"]')).toHaveText(/Get my certificate/, { timeout: 10000 });
  expect((await labels(page)).some((l) => /Get my certificate/.test(l)), "CONTROL: the recorder records the label asserted absent below").toBe(true);
  await card(page).locator('[data-action="open-badge-share"]').click();
  const dlg = page.locator("#modal-overlay.open");
  await expect(dlg.getByRole("button", { name: "Close" }), "the dialog opened on the minted certificate").toBeVisible({ timeout: 15000 });
  const g = await gateCertReads(page);
  // From here only a NEWLY drawn card counts: the one on screen is the last seen.
  await page.evaluate(() => { window.__cardLabels = []; window.__lastBtn = document.querySelector('#lb-badge-cta .lb-cert [data-action="open-badge-share"]'); });
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect.poll(() => g.reads, { message: "PRECONDITION: the card's read after the dialog is out" }).toBeGreaterThanOrEqual(1);
  expect(await labels(page), "nothing redrawn while the read is out").toEqual([]);
  g.open();
  await expect(card(page).locator("a.lb-cert-dl"), "the minted certificate's download").toHaveCount(1, { timeout: 10000 });
  const seen = await labels(page);
  expect(seen.filter((l) => /Get my certificate/.test(l)), `never back to 'Get my certificate': ${JSON.stringify(seen)}`).toEqual([]);
  expect(seen.some((l) => /Share on LinkedIn/.test(l)), "drawn as held").toBe(true);
  await page.unroute("**/api/me/certificates");
});

test("sweep #289: switching to another event's board, the last event's certificate card is not left beside it while the new one is read", async ({ page }) => {
  test.setTimeout(150_000);
  const A = await rankedEvent("swa"), B = await rankedEvent("swb");
  const p = A.people[0];
  // p also plays B (one easy solve), both end, and p holds A's certificate.
  {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try { await enrol(sa, csrf, B.comp.id, [p.id]); } finally { await sa.dispose(); }
    const P = await apiLogin(p.email);
    try {
      expect((await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: B.comp.id } })).ok()).toBeTruthy();
      const r = await P.api.post(`/api/tasks/${B.tasks[0].id}/submit`, { headers: H(P.csrf), data: { answer: "a", gradingHash: await gradingHashFor(P.api, B.tasks[0].id) } });
      expect((await r.json()).correct, "PRECONDITION: p is on B's board").toBe(true);
    } finally { await P.api.dispose(); }
  }
  await endNow(A.comp.id);
  await endNow(B.comp.id);
  const P = await apiLogin(p.email);
  let code;
  try {
    const m = await P.api.post(`/api/competitions/${A.comp.id}/badge`, { headers: H(P.csrf) });
    expect(m.ok(), await m.text()).toBeTruthy();
    code = (await m.json()).publicCodeFormatted;
    expect((await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: A.comp.id } })).ok(), "back to A").toBeTruthy();
  } finally { await P.api.dispose(); }
  expect(code, "PRECONDITION: A's certificate has a code").toBeTruthy();
  await openBoard(page, p.email, { ended: true });
  const cta = page.locator("#lb-badge-cta");
  await expect(cta, "PRECONDITION: A's card shows A's certificate").toContainText(code, { timeout: 10000 });
  // Switch the tab to B, as the picker does, with B's read held.
  const g = await gateCertReads(page);
  const csrf = await page.evaluate(() => window.S.csrfToken);
  expect((await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: B.comp.id } })).ok()).toBeTruthy();
  await page.evaluate((b) => { window.S.currentCompetitionId = b; window.S._compGen++; window.loadLeaderboard({ silent: true }); }, B.comp.id);
  await expect.poll(() => page.locator("#lb-body tr[data-uid]").count(), { timeout: 15000, message: "B's board is drawn" }).toBe(6);
  await expect.poll(() => g.reads, { message: "PRECONDITION: B's read is out" }).toBeGreaterThanOrEqual(1);
  await expect(cta, "A's card is not left beside B's board").toBeHidden();
  g.open();
  await expect(cta.locator('[data-action="open-badge-share"]'), "CONTROL: B's own card once read").toHaveText(/Get my certificate/, { timeout: 10000 });
  await expect(cta).not.toContainText(code);
  await page.unroute("**/api/me/certificates");
});

// The Time figure's cases: the shortest words, a long clock, a year-long clock,
// and that clock beside a four-digit rank and score (the narrowest it can be).
// `wraps` names the widths where it is too long for its column and wraps between
// its parts — a 360 px phone, and the narrow side column the card takes beside
// the board on a desktop; everywhere else it is one line.
const KPI_CASES = [
  { ms: 400, words: "under 1 s", wraps: [] },
  { ms: 37_353_000, words: "10 h 22 m 33 s", wraps: [] },
  { ms: 31_535_999_000, words: "8759 h 59 m 59 s", wraps: [1280, 360] },
  { ms: 31_535_999_000, words: "8759 h 59 m 59 s", rank: 2999, score: 1950, wraps: [1280, 360] },
];
for (const width of [1280, 390, 360]) {
  test(`the card's Time figure fits its column at ${width} px: one line where it fits, else wrapped between its parts`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const f = await rankedEvent(`kpi${width}`);
    await endNow(f.comp.id);
    let cur = KPI_CASES[0];
    await page.route("**/api/leaderboard", async (route) => {
      const res = await route.fetch();
      const d = await res.json();
      if (d.me) {
        d.me.solveTimeMs = cur.ms;
        if (cur.rank != null) d.me.rank = cur.rank;
        if (cur.score != null) d.me.score = cur.score;
      }
      await route.fulfill({ response: res, json: d });
    });
    await openBoard(page, f.people[0].email, { ended: true });
    for (const c of KPI_CASES) {
      cur = c;
      await rerender(page);
      const row = card(page).locator(".lb-cert-kpis");
      if (c.rank != null) await expect(row).toContainText(String(c.rank));
      const fig = row.locator("> div").filter({ hasText: "Time" }).locator(".bignum");
      await expect(fig).toHaveText(c.words);
      // Each number stays with its unit: the pairs ("8759 h", "59 m", "59 s").
      const pairs = c.words.match(/\d+ [a-z]+/g);
      const m = await fig.evaluate((el, pairs) => {
        const text = el.firstChild;
        const flat = text.textContent.replace(/\u00a0/g, " ");
        const range = document.createRange(); range.selectNodeContents(el);
        const ink = range.getBoundingClientRect();
        const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        let from = 0;
        const split = [];
        for (const p of pairs) {
          const i = flat.indexOf(p, from);
          const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + p.length);
          if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size !== 1) split.push(p);
          from = i + p.length;
        }
        const cell = el.parentElement, cs = getComputedStyle(cell), cr = cell.getBoundingClientRect();
        const kpis = cell.parentElement;
        // The control: the same words held on one line, as the card drew them
        // before — wider than the column wherever the figure wraps.
        const keep = el.style.whiteSpace;
        el.style.whiteSpace = "nowrap";
        const oneLineW = el.getBoundingClientRect().width;
        el.style.whiteSpace = keep;
        return { lines, split, left: ink.left, right: ink.right,
          colLeft: cr.left + parseFloat(cs.paddingLeft), colRight: cr.right - parseFloat(cs.paddingRight),
          rowOver: kpis.scrollWidth - kpis.clientWidth, oneLineW,
          colW: cr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
      }, pairs);
      const at = `"${c.words}"${c.rank != null ? ` beside rank ${c.rank}, ${c.score} points` : ""} at ${width} px: ${JSON.stringify(m)}`;
      // Inside its OWN column (its content box): a figure spilling into the
      // padding or the next column would still be "inside the card".
      expect(m.right, `inside its column, ${at}`).toBeLessThanOrEqual(m.colRight + 0.5);
      expect(m.left, `inside its column, ${at}`).toBeGreaterThanOrEqual(m.colLeft - 0.5);
      expect(m.rowOver, `the row of figures does not overflow, ${at}`).toBeLessThanOrEqual(0);
      expect(m.split, `no number is parted from its unit, ${at}`).toEqual([]);
      if (c.wraps.includes(width)) {
        expect(m.oneLineW, `CONTROL: on one line it would not fit its column, ${at}`).toBeGreaterThan(m.colW + 0.5);
        expect(m.lines, `wrapped between its parts, ${at}`).toBe(2);
      } else {
        expect(m.lines, `one line, ${at}`).toBe(1);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
  });
}
