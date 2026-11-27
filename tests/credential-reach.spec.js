// @ts-check
// v8.1.4 — four ways the credential surface offered or withheld the wrong thing.
//
// Every one of these is the same defect wearing different clothes: a surface that
// decides what to OFFER used a different rule from the surface that decides what
// to ALLOW, so the platform either promised something it then refused, or
// withheld something it would have permitted.
//
//   #21  `claimable` was tag-blind while the mint requires board presence, so a
//        benchmark participant was offered a certificate and told "You did not
//        participate in this event."
//   #23  the share POST that PUBLISHES a completion certificate's page was still
//        fired as pre-PR-26 telemetry — swallowed on failure, composer opened
//        regardless — so a participant posted a link that permanently 404s.
//   #35  the mint's lifecycle refusals ran BEFORE its idempotent existing-badge
//        return, so a holder's own "View certificate" button 409'd for the whole
//        of an admin revive.
//   #36  held certificates were matched by competition NAME, which is not unique.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, gradingHashFor, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `cr${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** Every test owns its participants — a shared fixture is not a stable identity. */
async function mkP(api, csrf, label) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Reach", lastName: label, nickname: label, email, company: "Acme",
      title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} must be findable after registering`).toBeTruthy();
  // approve REFUSES an unverified account, so verify first.
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok(), `verify ${label}`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok(), `approve ${label}`).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

/**
 * A LIVE event with `tasks` published challenges assigned. Created live because
 * an ENDED competition refuses assignment — the fixture checklist's item 2.
 */
async function mkEvent(api, csrf, { name, kind = "tournament", tasks = 1 }) {
  const data = { name, event_kind: kind, start_time: new Date(Date.now() - 3600e3).toISOString(), timezone: "UTC" };
  if (kind === "program") data.deadline_at = new Date(Date.now() + 90 * 86400e3).toISOString();
  else data.duration_minutes = 600;
  const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data });
  expect(cr.ok(), `create ${kind}: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;
  const ids = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} T${i}`, description: "d", difficulty: "easy",
              answer_type: "text", correct_answer: `right${i}`, status: "published" },
    });
    expect(tr.ok(), await tr.text()).toBeTruthy();
    const id = (await tr.json()).id;
    ids.push(id);
    const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
  }
  return { comp, taskIds: ids };
}

/** Assign, and ASSERT the count — the endpoint silently SKIPS ineligible users. */
async function enrol(api, csrf, compId, users) {
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: users.map(u => u.id), competitionIds: [compId] },
  });
  expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
  expect((await asg.json()).assigned, "every user must actually enrol").toBe(users.length);
}

async function asParticipant(email, compId) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select competition as ${email}: ${await sel.text()}`).toBeTruthy();
  return { api, csrf };
}

async function solve(api, csrf, taskId, answer) {
  // The grading token is REQUIRED on submit (v7.20.9 F1).
  const gradingHash = await gradingHashFor(api, taskId);
  const r = await api.post(`/api/tasks/${taskId}/submit`, { headers: H(csrf), data: { answer, gradingHash } });
  expect(r.ok(), `submit: ${await r.text()}`).toBeTruthy();
  const d = await r.json();
  expect(d.correct, "the fixture's answer must actually be correct").toBe(true);
}

async function compRow(api, compId) {
  const all = await (await api.get("/api/admin/competitions")).json();
  const row = (all || []).find(c => c.id === compId);
  expect(row, "the competition must be in the admin list").toBeTruthy();
  return row;
}

function badgeRow(token) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token); }
  finally { db.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// #21 — the offer and the refusal must agree.
// ─────────────────────────────────────────────────────────────────────────────
test("v8.1.4: a benchmark participant is NOT offered a certificate the mint refuses", async () => {
  const { api, csrf } = await sa();
  const { comp, taskIds } = await mkEvent(api, csrf, { name: `Bench ${uniq()}`, tasks: 1 });

  // Assign BEFORE tagging: the assign endpoint deliberately SKIPS benchmark and
  // staff users, so tagging first would silently enrol nobody.
  const ordinary = await mkP(api, csrf, uniq());
  const bench = await mkP(api, csrf, uniq());
  const idle = await mkP(api, csrf, uniq());   // never solves → no all-solved auto-end
  await enrol(api, csrf, comp.id, [ordinary, bench, idle]);

  const tag = await api.post(`/api/admin/participants/${bench.id}/tags`, { headers: H(csrf), data: { tag: "benchmark" } });
  expect(tag.status(), await tag.text()).toBe(200);

  // Both attempt. The benchmark user is a REAL, enrolled, attempting participant —
  // that is the whole point: nothing about their activity differs, only the tag.
  for (const who of [ordinary, bench]) {
    const p = await asParticipant(who.email, comp.id);
    await solve(p.api, p.csrf, taskIds[0], "right0");
    await p.api.dispose();
  }
  const endNow = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
  expect(endNow.ok(), `end-now: ${await endNow.text()}`).toBeTruthy();
  expect((await compRow(api, comp.id)).status, "the event really is ended").toBe("ended");

  // Precondition, asserted rather than assumed: the tag is on, and the benchmark
  // user is enrolled. Without this the test could pass because the tag never landed.
  const tags = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(bench.email)}`)).json();
  expect((tags.participants.find(p => p.id === bench.id) || {}).tags || [], "benchmark tag applied").toContain("benchmark");

  // POSITIVE CONTROL — an ordinary participant in the SAME event IS offered one,
  // and the mint honours the offer. Without this arm, "the benchmark user was not
  // offered a certificate" is equally satisfied by a build where nobody ever is.
  {
    const p = await asParticipant(ordinary.email, comp.id);
    const mine = await (await p.api.get("/api/me/certificates")).json();
    expect((mine.claimable || []).map(c => c.competitionId), "an ordinary attempter is offered").toContain(comp.id);
    const mint = await p.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(p.csrf) });
    expect(mint.status(), `the offer must be honoured: ${await mint.text()}`).toBe(200);
    await p.api.dispose();
  }

  // The finding: offered, then refused with a sentence that is not true.
  {
    const p = await asParticipant(bench.email, comp.id);
    const mine = await (await p.api.get("/api/me/certificates")).json();
    expect((mine.claimable || []).map(c => c.competitionId),
      "a benchmark participant is off the board, so the mint refuses — do not offer it").not.toContain(comp.id);
    const mint = await p.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(p.csrf) });
    expect(mint.status(), "…and the mint still refuses, so the two agree").toBe(403);
    await p.api.dispose();
  }
  await api.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// #35 — an already-minted badge is a fact, not a request to mint.
// ─────────────────────────────────────────────────────────────────────────────
test("v8.1.4: a holder can still retrieve their certificate during a revive, and after a dry-run tag", async () => {
  const { api, csrf } = await sa();
  const { comp, taskIds } = await mkEvent(api, csrf, { name: `Revive ${uniq()}`, tasks: 1 });
  const holder = await mkP(api, csrf, uniq());
  const idle = await mkP(api, csrf, uniq());
  await enrol(api, csrf, comp.id, [holder, idle]);

  const p = await asParticipant(holder.email, comp.id);
  await solve(p.api, p.csrf, taskIds[0], "right0");
  expect((await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) })).ok(), "end-now").toBeTruthy();

  const first = await p.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(p.csrf) });
  expect(first.status(), `mint: ${await first.text()}`).toBe(200);
  const token = (await first.json()).token;
  expect(token, "a token was minted").toBeTruthy();

  // REVIVE — a supported admin path: a manually-ended competition revives on a
  // duration extend.
  const row = await compRow(api, comp.id);
  const put = await api.put(`/api/admin/competitions/${comp.id}`, {
    headers: H(csrf), data: { duration_minutes: 900, expectedUpdatedAt: row.updated_at },
  });
  expect(put.ok(), `extend: ${await put.text()}`).toBeTruthy();
  expect((await compRow(api, comp.id)).status, "the competition really is live again").toBe("live");

  // Catches: restoring the original ordering (the not-ended 409 above the
  // idempotent return) — the holder's own "View certificate" button 409s.
  const during = await p.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(p.csrf) });
  expect(during.status(), `retrieving a HELD badge mid-revive: ${await during.text()}`).toBe(200);
  expect((await during.json()).token, "and it is the same badge, not a new one").toBe(token);

  // …and the same for a dry-run tag applied AFTER minting, which used to make the
  // holder's own certificate permanently unreachable with a 403.
  const dry = await api.post(`/api/admin/competitions/${comp.id}/tags`, { headers: H(csrf), data: { tag: "test/dry run" } });
  expect(dry.status(), await dry.text()).toBe(200);
  const tagged = await p.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(p.csrf) });
  expect(tagged.status(), `retrieving a HELD badge on a dry-run event: ${await tagged.text()}`).toBe(200);
  expect((await tagged.json()).token).toBe(token);

  // The artefact URLs are how the holder actually collects the document, so they
  // must keep working through both states.
  const pdf = await p.api.get(`/badge/${token}/certificate.pdf`);
  expect(pdf.status(), "the certificate PDF is still collectable").toBe(200);

  await p.api.dispose();
  await api.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// #23 — publishing rides this POST, so the composer must wait for it.
// ─────────────────────────────────────────────────────────────────────────────
test("v8.1.4: a failed share POST publishes nothing and opens no composer", async ({ page }) => {
  const { api, csrf } = await sa();
  // A PROGRAM, because a completion certificate's public page is the ONE thing
  // that waits on this POST (PR 26). A Competition badge's page is live from the
  // moment it is minted, so its share is deliberately still fire-and-forget.
  const { comp, taskIds } = await mkEvent(api, csrf, { name: `Prog ${uniq()}`, kind: "program", tasks: 1 });
  const who = await mkP(api, csrf, uniq());
  await enrol(api, csrf, comp.id, [who]);
  await api.dispose();

  // Establish the session BEFORE navigating (v7.21.26), and solve everything so
  // the certificate is genuinely claimable.
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const li = await codeLogin(page.request, who.email, H(csrfToken));
  expect(li.ok(), `login ${who.email}`).toBeTruthy();
  const pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok(), "select").toBeTruthy();
  const gh = await gradingHashFor(page.request, taskIds[0]);
  const sub = await page.request.post(`/api/tasks/${taskIds[0]}/submit`, { headers: H(pc), data: { answer: "right0", gradingHash: gh } });
  expect(sub.ok(), `solve: ${await sub.text()}`).toBeTruthy();

  await page.goto("/");
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 20000 }); // v8.6.4 — the CONTAINER is static markup in the shell (`<nav id="main-nav"></nav>`), so waiting on it is satisfied at first paint, before boot has resolved who we are or fetched anything. A nav BUTTON cannot exist until buildParticipantNav has run. The v8.3.33 class, on the participant side.

  // Record what the hand-off does with the popup instead of navigating away. The
  // fix opens a popup SYNCHRONOUSLY and navigates it only once publication is
  // confirmed, so both halves are observable: what it opened, and where (if
  // anywhere) it was sent.
  await page.evaluate(() => {
    window.__opens = []; window.__navs = []; window.__closed = 0;
    window.open = (u) => {
      window.__opens.push(String(u || ""));
      const w = {
        opener: {},
        location: { replace: (x) => { window.__navs.push(String(x)); } },
        close: () => { window.__closed++; },
      };
      return w;
    };
  });

  const cta = page.locator('#cert-cta [data-action="open-badge-share"]');
  await expect(cta, "a solved Program offers its certificate").toBeVisible({ timeout: 15000 });

  // The dropped connection this fix is for.
  await page.route("**/badge/*/shared", (r) => r.abort());
  await cta.click();
  await expect(page.locator(".badge-share-img")).toBeVisible({ timeout: 15000 });
  // v8.3.25 — piggy-backed here because this is the ONLY browser test that opens
  // a COMPLETION certificate's dialog. The title branched on the wire's
  // `placement` flag, which is `isPlacementRank(rank)` and blind to the basis, so
  // this rank-1 Program participant was greeted with "You placed completed!".
  await expect(page.locator("#modal-title"),
    "a completion certificate is titled by its BASIS, never by its rank").toHaveText(/Your certificate is ready/i);
  const token = await page.evaluate(() => window.S._badgeShare.token);
  expect(token, "the badge was minted").toBeTruthy();
  await page.locator("#modal-confirm-btn").click();

  // The observable: the composer was never sent anywhere, the participant is TOLD,
  // and the page really is still withheld.
  await expect(page.locator(".toast.toast-error")).toContainText(/nothing was shared/i, { timeout: 10000 });
  expect(await page.evaluate(() => window.__navs), "the composer must not be navigated to LinkedIn").toEqual([]);
  expect(await page.evaluate(() => window.__closed), "the placeholder popup is closed again").toBeGreaterThan(0);
  expect(badgeRow(token).shared_at, "nothing was published, so a retry is safe").toBeFalsy();
  // …and the page is genuinely still withheld, which is what publishing would change.
  expect((await page.request.get(`/badge/${token}`)).status(), "the public page is still withheld").toBe(404);

  // POSITIVE CONTROL — with the POST allowed through, the SAME badge publishes and
  // the composer IS handed the share URL. Without this arm, "no composer opened"
  // is equally satisfied by a build where sharing never works at all.
  await page.unroute("**/badge/*/shared");
  await page.evaluate(() => { window.__opens = []; window.__navs = []; window.__closed = 0; });
  await cta.click();
  await expect(page.locator(".badge-share-img")).toBeVisible({ timeout: 15000 });
  await page.locator("#modal-confirm-btn").click();
  await expect.poll(async () => (await page.evaluate(() => window.__navs)).join("|"), { timeout: 10000 })
    .toContain("linkedin.com/sharing/share-offsite/");
  expect(badgeRow(token).shared_at, "the retry published it").toBeTruthy();
  expect((await page.request.get(`/badge/${token}`)).status(), "and the public page resolves now").toBe(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// #36 — a certificate is matched by IDENTITY, never by a display string.
//
// A CORRECTION TO THE FINDING, which is why this test is not the one it asked
// for. The finding reasoned from the schema: `competitions.name` carries no
// UNIQUE constraint, so two events may share a name. True of the table and false
// of the platform — `POST /api/admin/competitions` refuses a duplicate name
// case-insensitively and globally (`SELECT 1 FROM competitions WHERE
// LOWER(name)=LOWER(?)`), with no carve-out for ended events, so the two rows the
// finding describes cannot be created through the API at all. The first draft of
// this test tried and was refused.
//
// The FIX still stands, and this is what it is worth: the client was joining a
// held certificate to the event on screen by comparing NAMES, and the uniqueness
// that made that safe lives in one route rather than in the schema — one
// `OR status='ended'` carve-out away from being false, and invisible from the
// client. Matching on the id the payload now carries does not depend on that.
//
// So the collision is driven where it actually mattered: the client's own state.
// The events are legitimately named, and `S.currentCompName` is set to the OTHER
// event's name while viewing B — exactly what the old matcher keyed on. Under the
// old code B renders A's certificate; under the fix it renders nothing.
// ─────────────────────────────────────────────────────────────────────────────
test("v8.1.4: a held certificate is matched by event id, not by the name on screen", async ({ page }) => {
  const { api, csrf } = await sa();
  const sharedName = `Recurring Programme ${uniq()}`;
  // A is ended and holds the certificate; B is live and holds nothing.
  const A = await mkEvent(api, csrf, { name: sharedName, tasks: 1 });
  const B = await mkEvent(api, csrf, { name: `${sharedName} (second run)`, tasks: 1 });
  const who = await mkP(api, csrf, uniq());
  await enrol(api, csrf, A.comp.id, [who]);
  await enrol(api, csrf, B.comp.id, [who]);

  // Sole participant solving the only challenge fires the all-solved auto-end,
  // which is exactly what we want for A — asserted rather than assumed.
  const pa = await asParticipant(who.email, A.comp.id);
  await solve(pa.api, pa.csrf, A.taskIds[0], "right0");
  expect((await compRow(api, A.comp.id)).status, "A auto-ended").toBe("ended");
  const mint = await pa.api.post(`/api/competitions/${A.comp.id}/badge`, { headers: H(pa.csrf) });
  expect(mint.status(), `mint in A: ${await mint.text()}`).toBe(200);
  const minted = await mint.json();
  expect(minted.publicCodeFormatted, "the certificate carries a printed code").toBeTruthy();
  await pa.api.dispose();
  expect((await compRow(api, B.comp.id)).status, "B is live, so nothing is claimable there").toBe("live");
  await api.dispose();

  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  expect((await codeLogin(page.request, who.email, H(csrfToken))).ok()).toBeTruthy();
  // Land on the LIVE event, so boot does not raise the ended-competition popup
  // over the page these assertions read.
  const bc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  expect((await page.request.post("/api/select-competition", { headers: H(bc), data: { competitionId: B.comp.id } })).ok(), "select B").toBeTruthy();
  await page.goto("/");
  await page.waitForSelector("#main-nav .nav-btn", { timeout: 20000 }); // v8.6.4 — the CONTAINER is static markup in the shell (`<nav id="main-nav"></nav>`), so waiting on it is satisfied at first paint, before boot has resolved who we are or fetched anything. A nav BUTTON cannot exist until buildParticipantNav has run. The v8.3.33 class, on the participant side.

  // `name` is passed per call so the B read can carry A's name — the collision
  // the old matcher keyed on, which the create route will not let us build in
  // the database.
  const read = async (compId, name) => page.evaluate(async ({ id, name }) => {
    window.S.currentCompetitionId = id;
    window.S.currentCompName = name;        // what the old, broken matcher keyed on
    window.showMain("tasks-page");
    await window.renderCertificateCta();
    const el = document.getElementById("cert-cta");
    return { hidden: !!el.hidden, text: (el.textContent || "").replace(/\s+/g, " ").trim() };
  }, { id: compId, name });

  // POSITIVE CONTROL first — viewing A shows A's certificate, so the matcher works
  // at all and "hidden on B" cannot pass on a build that never matches anything.
  const onA = await read(A.comp.id, sharedName);
  expect(onA.hidden, "viewing the event the certificate belongs to").toBe(false);
  expect(onA.text, "and it names that certificate's own code").toContain(minted.publicCodeFormatted);

  // The finding: an identically-named SECOND event must show nothing of A's.
  const onB = await read(B.comp.id, sharedName);   // B on screen, A's NAME in state
  expect(onB.hidden, "a different event that merely shares a name shows no certificate").toBe(true);
  expect(onB.text, "…and certainly not the other event's credential code").not.toContain(minted.publicCodeFormatted);
});
