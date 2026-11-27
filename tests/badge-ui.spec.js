// @ts-check
// Achievement-badge UI (v7.1.0): the top-3 share CTA on an ended competition's
// leaderboard, the preview modal, and the LinkedIn share-intent hand-off.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, gradingHashFor, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });
const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

let COMP_ID;

// Build a competition where Alice is the sole member and solves the only task —
// which auto-ends it, leaving her ranked 1st in a fully-ended competition.
test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  let r = await api.post("/api/admin/competitions", { headers: H, data: {
    name: `Badge UI ${stamp}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180,
  }});
  const compId = (await r.json()).competition.id;
  r = await api.post("/api/admin/tasks", { headers: H, data: {
    title: `BadgeUITask ${stamp}`, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: "win", explanation: "<p>e</p>", hint: "h", status: "published",
  }});
  const taskId = (await r.json()).id;
  await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H, data: { competitionIds: [compId] } });
  const ids = await (await api.get("/api/admin/participants?limit=1000")).json();
  const aliceId = ids.participants.find(p => p.email === "alice@acme.com").id;
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [aliceId], competitionIds: [compId] } });
  await api.dispose();

  const { api: pa, csrf: pc } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
  await pa.post("/api/select-competition", { headers: h(pc), data: { competitionId: compId } });
  await pa.post(`/api/tasks/${taskId}/submit`, { headers: h(pc), data: { answer: "win" , gradingHash: await gradingHashFor(pa, taskId)} }); // → auto-ends
  // v8.3.15 — ALICE IS NOW PINNED TO A COMPETITION HER OWN SUBMISSION ENDED.
  // Selecting it above writes the auto-resume marker, and since v8.3.15 an ENDED
  // event is resumed rather than refused — so `page.goto("/")` below lands her
  // INSIDE it, where the status poll raises the "Event Ended" modal. That
  // is correct behaviour and it is not what this test is about, but the modal is
  // a real overlay and it intercepts the CTA click.
  //
  // Marking it seen HERE is deterministic; waiting for it in the test would be
  // racing a poll, and the modal's own confirm is "View Leaderboard", so a
  // dismiss would also navigate. The landing itself is locked in
  // tests/event-auto-resume.spec.js.
  await pa.post("/api/dismiss-ended", { headers: h(pc) });
  await pa.dispose();
  COMP_ID = compId;
});

async function pageLogin(page, email, password) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, h(csrfToken), { password: password });
  expect(r.ok(), `login ${email}`).toBeTruthy();
}

test("top-3 finisher sees the share CTA and can open the LinkedIn share modal", async ({ page }) => {
  await pageLogin(page, "alice@acme.com", PARTICIPANT_PASS);
  await page.goto("/");
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 15000 }); // v8.6.4 — the CONTAINER is static markup in the shell (`<nav id="main-nav"></nav>`), so waiting on it is satisfied at first paint, before boot has resolved who we are or fetched anything. A nav BUTTON cannot exist until buildParticipantNav has run. The v8.3.33 class, on the participant side.

  // Put the session into this ended competition, then render its leaderboard.
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: h(csrf), data: { competitionId: COMP_ID } });
  expect(sel.ok(), "select ended comp").toBeTruthy();
  await page.evaluate((id) => { window.S.currentCompetitionId = id; window.showMain("leaderboard-page"); }, COMP_ID);

  // CTA shows for the 1st-place finisher on an ended competition.
  const cta = page.locator('#lb-badge-cta [data-action="open-badge-share"]');
  await expect(cta).toBeVisible({ timeout: 10000 });

  // v7.1.1 regression — the green "Live" pill must NOT show on an ENDED
  // competition's leaderboard (it did before, because the pill was rendered
  // unconditionally on the assumption the user is always popped off at end).
  await expect(page.locator("#lb-live-badge")).toBeHidden();

  // #6 (a11y) — the top-3 rank is announced to screen readers via a
  // visually-hidden ordinal alongside the aria-hidden medal.
  await expect(page.locator("#leaderboard-page .sr-only").filter({ hasText: "place" }).first()).toBeAttached();

  // Capture window.open so the LinkedIn hand-off doesn't navigate away in-test.
  await page.evaluate(() => { window.__lastOpen = null; window.open = (u) => { window.__lastOpen = u; return null; }; });

  await cta.click();

  // Preview modal renders the rendered PNG badge.
  const img = page.locator(".badge-share-img");
  await expect(img).toBeVisible({ timeout: 10000 });

  // v8.6.2 — THE PUBLICATION NOTE REACHES A RANKED KIND. This dialog is a
  // COMPETITION's (top-3 placement), and until v8.6.2 the note was rendered only
  // for a completion certificate — which is to say it was withheld from exactly
  // the participants whose page had already gone live at mint without their
  // being told. The server now withholds every unshared page, so the sentence is
  // true for everybody and is shown to everybody.
  const note = page.locator("#modal-overlay .badge-claim-note", { hasText: "Downloading is private" });
  await expect(note, "the publication note is shown on a Competition certificate too").toBeVisible();
  await expect(note).toContainText("Nothing is published until you press Share");

  // #12 (a11y) — the secondary Copy / Download affordances meet the 44px target.
  // Wait for each to be visible AND poll its measured height: boundingBox()
  // returns null for an element that is in the DOM but not yet laid out, so a
  // bare boundingBox() right after the modal opens flaked under WORKERS=8 CPU
  // pressure. The poll lets layout settle before asserting.
  // v7.15.0 — iterate EVERY secondary affordance rather than assuming one of
  // each. The dialog now offers PNG download, PDF download and Copy link, so a
  // single-match locator was a strict-mode violation — and asserting only the
  // first would have let a new affordance ship below the touch-target floor.
  // Operator ruling, 29 Oct 2026 — the downloads are real buttons, beside
  // "Copy post & open LinkedIn" and "Copy badge link".
  const secondaries = page.locator(".badge-share-secondary .btn");
  const secondaryCount = await secondaries.count();
  expect(secondaryCount, "copy-post / download-PDF / download-image / copy-link are all offered").toBe(4);
  await expect(page.locator('.badge-share-secondary [data-action="badge-copy-post"]')).toHaveText(/Copy post & open LinkedIn/);
  await expect(page.locator(".badge-share-help"), "sharing is link-only: nothing claims an attachment").not.toContainText(/certificate attached/i);
  for (let i = 0; i < secondaryCount; i++) {
    const loc = secondaries.nth(i);
    await expect(loc).toBeVisible();
    const label = (await loc.textContent() || "").trim();
    await expect.poll(async () => { const b = await loc.boundingBox(); return b ? b.height : 0; }, { message: `"${label}" height` }).toBeGreaterThanOrEqual(44);
  }
  // "Copy post & open LinkedIn": the whole two-line post reaches the clipboard
  // (through ui/clipboard.js) and LinkedIn's feed composer opens with it.
  // The clipboard answers in a LATER task, as a real one does, and the composer
  // window must open before that answer, in the click's own task: a pop-up
  // blocker allows a window only then, so awaiting the copy first loses it.
  await page.evaluate(() => {
    window.__copied = null; window.__copySettled = false; window.__openBeforeCopySettled = null;
    if (navigator.clipboard) navigator.clipboard.writeText = (t) => {
      window.__copied = t;
      return new Promise((res) => setTimeout(() => { window.__copySettled = true; res(); }, 400));
    };
    const open0 = window.open;
    window.open = (...a) => {
      if (window.__openBeforeCopySettled === null) window.__openBeforeCopySettled = !window.__copySettled;
      return open0(...a);
    };
  });
  await page.locator('.badge-share-secondary [data-action="badge-copy-post"]').click();
  await expect.poll(() => page.evaluate(() => window.__copied), { message: "the post was copied" })
    .toMatch(/^Proud to have earned 🥇 1st Place at .+, hosted by @Checkmarx!\n#Checkmarx .*\/credential\?code=[0-9A-Z]{12}$/);
  await expect.poll(() => page.evaluate(() => window.__lastOpen), { message: "the composer opens" })
    .toContain("linkedin.com/feed/?shareActive=true&text=Proud");
  expect(await page.evaluate(() => window.__openBeforeCopySettled),
    "the composer window opened in the click's task, before the clipboard answered").toBe(true);
  await expect(page.locator("#toast-stack"), "the copy's own outcome is still reported").toContainText("Post copied");
  await expect(page.locator("#modal-overlay"), "the dialog stays open").toHaveClass(/open/);
  // The certificate is downloadable as a PDF, not only as an image (v7.15.0 —
  // the reason for the reworded CTA: this was previously undiscoverable).
  const pdfLink = page.locator('.badge-share-secondary a[href$="/certificate.pdf"]');
  await expect(pdfLink, "a PDF download is offered").toHaveCount(1);
  await expect(pdfLink).toHaveAttribute("download", /.*/);
  // v7.21.30 — rendered on request from a token-keyed route, not the copy
  // stored at mint, so an artwork change reaches badges that already exist.
  await expect(img).toHaveAttribute("src", /\/badge\/[A-Za-z0-9_-]+\/badge\.png$/);
  // The image actually resolves (naturalWidth > 0).
  await expect.poll(async () => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  // Primary action is the LinkedIn share-intent.
  const confirm = page.locator("#modal-confirm-btn");
  await expect(confirm).toHaveText(/Share on LinkedIn/i);
  await confirm.click();
  // POLLED, not read once (v8.11.1). A placement certificate's page is withheld
  // until its holder shares — v8.6.2 made that withhold platform-wide — so the
  // client now AWAITS `POST /badge/:token/shared` and checks its result before
  // opening the composer, exactly as the completion kind has since v8.1.6.
  // Reading `__lastOpen` synchronously after the click measured the tick before
  // the publish landed; the property under test is that the composer opens with
  // the share intent, not that it opens within one microtask.
  await expect.poll(() => page.evaluate(() => window.__lastOpen),
    { message: "the composer opens once the page is published" })
    .toContain("linkedin.com/sharing/share-offsite/");

  // The public OG page renders under the real CSP with no style/CSP violations:
  // it is styled by /verify-pages.css alone and runs /theme-boot.js, so this
  // witnesses that a linked sheet and the theme script load under it.
  const token = await page.evaluate(() => window.S._badgeShare.token);
  const cspErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && /content.security|csp|style-src/i.test(m.text())) cspErrors.push(m.text()); });
  // v8.6.2 — the page is PUBLISHED BY THE SHARE ABOVE, so navigating straight to
  // it used to race the write: that POST was fire-and-forget for a ranked kind,
  // and before v8.6.2 the page was live at mint so the race could not bite.
  //
  // v8.11.1 (external audit F7) — the race is gone rather than merely polled
  // past: a ranked share now AWAITS the publish too, because v8.6.2's own
  // platform-wide withhold made "a failed audit must never cost the share" the
  // wrong rule for a page that does not exist yet. The poll is kept as a plain
  // settle — a 404 here means the page is broken, which is what it was always
  // for.
  await expect.poll(async () => (await page.request.get(`/badge/${token}`)).status(),
    { message: "the owner's share publishes the page" }).toBe(200);
  await page.goto(`/badge/${token}`);
  await expect(page.locator('img[width="1200"]')).toBeVisible();
  await expect.poll(async () => page.locator('img[width="1200"]').evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  expect(cspErrors, cspErrors.join(" | ")).toHaveLength(0);
});

// v7.12.4 — regression lock for the PARTICIPATION badge CTA (non-top-3 attempter) via
// the REAL entry path: the top-3 test above force-renders the leaderboard with
// window.showMain, so it never exercised (a) the participation copy or (b) the ended
// popup that a participant actually meets when re-entering a finished competition.
test("participation attempter: the ended popup routes to the leaderboard where the 'took part' CTA shows", async ({ page }) => {
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  // ── setup: an ended comp with 3 solvers (top-3) + one BELOW-top-3 attempter ──
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const comp = (await (await api.post("/api/admin/competitions", { headers: H, data: {
    name: `PartBadge ${stamp}`, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 180,
  } })).json()).competition.id;
  const task = (await (await api.post("/api/admin/tasks", { headers: H, data: {
    title: `PartBadgeTask ${stamp}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "win", status: "published",
  } })).json()).id;
  await api.post(`/api/admin/tasks/${task}/competitions`, { headers: H, data: { competitionIds: [comp] } });
  const email = `partbadge_${stamp}@acme.com`;
  const { api: anon, csrf: ac } = await freshCtx();
  await registerPost(anon, "/api/register", { headers: h(ac), data: {
    firstName: "P", lastName: "B", nickname: `partbadge${stamp}`.replace(/[^a-z0-9]/gi, ""), email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
  } });
  await anon.dispose();
  const parts = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
  const attId = parts.find(p => p.email === email).id;
  const solverIds = ["alice@acme.com", "bob@acme.com", "carol@acme.com"].map(e => parts.find(p => p.email === e).id);
  await api.post(`/api/admin/participants/${attId}/verify`, { headers: H });
  await api.post(`/api/admin/participants/${attId}/approve`, { headers: H });
  await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: [...solverIds, attId], competitionIds: [comp] } });
  for (const e of ["alice@acme.com", "bob@acme.com", "carol@acme.com"]) {
    const { api: sa, csrf: sc } = await apiLogin(e, PARTICIPANT_PASS);
    await sa.post("/api/select-competition", { headers: h(sc), data: { competitionId: comp } });
    await sa.post(`/api/tasks/${task}/submit`, { headers: h(sc), data: { answer: "win" , gradingHash: await gradingHashFor(sa, task)} });
    await sa.dispose();
  }
  const { api: ea, csrf: ec } = await apiLogin(email, PARTICIPANT_PASS);
  await ea.post("/api/select-competition", { headers: h(ec), data: { competitionId: comp } });
  await ea.post(`/api/tasks/${task}/submit`, { headers: h(ec), data: { answer: "nope" , gradingHash: await gradingHashFor(ea, task)} }); // wrong → attempted, below top-3
  await ea.dispose();
  await api.post(`/api/admin/competitions/${comp}/end-now`, { headers: H });
  await api.dispose();

  // ── the attempter re-enters the finished competition ──
  await pageLogin(page, email, PARTICIPANT_PASS);
  const selCsrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await page.request.post("/api/select-competition", { headers: h(selCsrf), data: { competitionId: comp } });
  await page.goto("/");
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 15000 }); // v8.6.4 — the CONTAINER is static markup in the shell (`<nav id="main-nav"></nav>`), so waiting on it is satisfied at first paint, before boot has resolved who we are or fetched anything. A nav BUTTON cannot exist until buildParticipantNav has run. The v8.3.33 class, on the participant side.

  // The ended popup fires on entry and (v7.12.4) offers "View Leaderboard" as its
  // primary action instead of stranding the user behind the nav-covering modal.
  const confirm = page.locator("#modal-confirm-btn");
  await expect(confirm).toBeVisible({ timeout: 10000 });
  await expect(confirm).toHaveText(/View Leaderboard/i);
  await confirm.click();

  // Lands on the leaderboard with the PARTICIPATION CTA (took-part copy, no placement).
  const cta = page.locator('#lb-badge-cta [data-action="open-badge-share"]');
  await expect(cta).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#lb-badge-cta")).toContainText(/took part/i);
  await expect(page.locator("#lb-badge-cta")).not.toContainText(/place/i);

  // And the participation badge actually mints + previews from this CTA.
  await cta.click();
  const img = page.locator(".badge-share-img");
  await expect(img).toBeVisible({ timeout: 10000 });
  // v7.21.30 — rendered on request from a token-keyed route, not the copy
  // stored at mint, so an artwork change reaches badges that already exist.
  await expect(img).toHaveAttribute("src", /\/badge\/[A-Za-z0-9_-]+\/badge\.png$/);
  await expect.poll(async () => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  // Server marks this a participation (not placement) badge.
  expect(await page.evaluate(() => window.S?._badgeShare?.placement)).toBe(false);
});
