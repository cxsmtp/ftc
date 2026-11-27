// @ts-check
//
// THE PROFILE CARD'S CERTIFICATES AND APPROVAL LINE (public/js/features/profile-card.js).
//   • it asks about every event on the row that can hold a certificate — an
//     ended event, and a live completion-certificate event (a Program issues one
//     while it runs), never an upcoming one, which would take one of the capped
//     asks from an older event — and states a negative only about what it checked:
//     "No certificates issued yet." when it checked everything, "No certificates
//     in the 6 most recent events checked." when there were more;
//   • a role that may not read certificates is not sent to the route at all;
//   • "Approved … by" names an automatic approval in words, never its stored key.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const { adminLogin, clickTab, loginViaApi, showAllParticipantColumns, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { heldCertificate } = require("./certificate-fixture");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });
test.beforeEach(async ({ page }) => { await showAllParticipantColumns(page); });

const dbRun = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...a); } finally { db.close(); }
};

/** `n` events the person was enrolled in and never played, each ended. */
async function endedEventsWithout(sa, csrf, userId, n, label) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const c = await makeCompetition(sa, csrf, `${label}${i}`);
    await enrol(sa, csrf, c.id, [userId]);
    const e = await sa.post(`/api/admin/competitions/${c.id}/end-now`, { headers: H(csrf) });
    expect(e.ok(), `end-now: ${await e.text()}`).toBeTruthy();
    ids.push(c.id);
  }
  return ids;
}

/** Wait out the 5 s admin participants cache until the row shows `pred`. */
async function rowShows(sa, userId, pred) {
  await expect.poll(async () => {
    const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const row = (list.participants || []).find((p) => p.id === userId);
    return !!(row && pred(row));
  }, { timeout: 15000, message: "the People row reflects the fixture" }).toBe(true);
}

async function openCard(page, user) {
  await clickTab(page, "participants");
  await narrowPeopleTable(page, user.email);
  const btn = page.locator(`#admin-participants-body [data-action="participant-view-profile"][data-id="${user.id}"]`).first();
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.click();
  const card = page.locator("#profile-card-overlay .pc-card");
  await expect(card).toBeVisible();
  return card;
}

test("a live Program's completion certificate is on the card, and an automatic approval is named in words", async ({ page }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let target, program, task;
  try {
    target = await makeParticipant(sa, csrf, "pccompl");
    const cr = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `PC Program ${uniq("p")}`, event_kind: "program",
      start_time: new Date(Date.now() - 60_000).toISOString(),
      deadline_at: new Date(Date.now() + 30 * 86400e3).toISOString(),
    } });
    expect(cr.ok(), `create program: ${await cr.text()}`).toBeTruthy();
    program = (await cr.json()).competition;
    task = await makeTask(sa, csrf, "pccompl");
    await assignTask(sa, csrf, task.id, [program.id]);
    await enrol(sa, csrf, program.id, [target.id]);
    // An ended event without a certificate beside it: the old card asked only
    // about ended events, found nothing, and said none had been issued.
    await endedEventsWithout(sa, csrf, target.id, 1, "pcnone");
  } catch (e) { await sa.dispose(); throw e; }
  const { api: pa, csrf: pc } = await apiLogin(target.email);
  try {
    expect((await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: program.id } })).ok()).toBeTruthy();
    const sub = await pa.post(`/api/tasks/${task.id}/submit`, { headers: { ...H(pc), "x-competition-id": program.id }, data: { answer: "a", gradingHash: await gradingHashFor(pa, task.id) } });
    expect((await sub.json()).correct).toBe(true);
    const m = await pa.post(`/api/competitions/${program.id}/badge`, { headers: H(pc) });
    expect(m.ok(), `mint: ${await m.text()}`).toBeTruthy();
    expect((await m.json()).basis, "PRECONDITION: a completion certificate on a live Program").toBe("completion");
  } finally { await pa.dispose(); }
  // The email-first sign-up's own approval key (routes/auth.js).
  dbRun("UPDATE users SET approved_by='email_proof' WHERE id=?", target.id);
  try { await rowShows(sa, target.id, (r) => r.approved_by === "email_proof" && r.competitions.some((c) => c.id === program.id && c.status === "live" && c.certificate === "completion")); }
  finally { await sa.dispose(); }

  const certAsks = [];
  page.on("request", (r) => { if (/\/api\/admin\/competitions\/[^/]+\/certificates$/.test(new URL(r.url()).pathname)) certAsks.push(new URL(r.url()).pathname); });
  await adminLogin(page);
  const card = await openCard(page, target);
  await expect(card.locator(`[data-cert-for="${program.id}"]`), "the live Program's certificate is shown").toHaveText(/Completion/, { timeout: 15000 });
  await expect(card.locator("#pc-cert-note")).toHaveText("");
  await expect(card, "no claim that nothing was issued").not.toContainText("No certificates issued yet");
  expect(certAsks.some((p) => p.includes(program.id)), "the live Program was asked about").toBe(true);

  await expect(card).toContainText("automatically, at sign-up");
  await expect(card, "the stored key never reaches the card").not.toContainText("email_proof");
});

test("a negative is stated only about the events checked: past the cap it says how many", async ({ page }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let many, few;
  try {
    many = await makeParticipant(sa, csrf, "pcmany");
    few = await makeParticipant(sa, csrf, "pcfew");
    await endedEventsWithout(sa, csrf, many.id, 7, "pcm");
    await endedEventsWithout(sa, csrf, few.id, 1, "pcf");
    // An approval key the card has no words for is not printed either.
    dbRun("UPDATE users SET approved_by='a_future_key' WHERE id=?", many.id);
    await rowShows(sa, many.id, (r) => r.approved_by === "a_future_key" && r.competitions.filter((c) => c.status === "ended").length === 7);
    await rowShows(sa, few.id, (r) => r.approved_by === "superadmin");
  } finally { await sa.dispose(); }

  await adminLogin(page);
  let card = await openCard(page, many);
  await expect(card.locator("#pc-cert-note")).toHaveText("No certificates in the 6 most recent events checked.", { timeout: 15000 });
  const approved = card.locator(".pc-fact", { has: page.locator("dt", { hasText: /^Approved$/ }) });
  await expect(approved, "PRECONDITION: the approval fact is shown").toHaveCount(1);
  await expect(approved.locator("dd"), "an unknown approval key shows the date alone").not.toContainText(/a_future_key|by /);
  await expect(card, "an unknown approval key is never shown").not.toContainText("a_future_key");
  await card.locator('[data-pc-act="close"]').click();
  await expect(page.locator("#profile-card-overlay")).toHaveCount(0);
  // CONTROL: everything checked, so the plain negative is true.
  card = await openCard(page, few);
  await expect(card.locator("#pc-cert-note")).toHaveText("No certificates issued yet.", { timeout: 15000 });
  // CONTROL: an organiser's approval still names them.
  await expect(card).toContainText("by superadmin");
});

test("a role that may not read certificates is not sent to the route, and the card says nothing about them", async ({ page, browser }) => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let target, viewer;
  try {
    target = await makeParticipant(sa, csrf, "pcperm");
    await endedEventsWithout(sa, csrf, target.id, 1, "pcp");
    // A real custom role that reads people and events, but not certificates.
    const role = await sa.post("/api/admin/roles", { headers: H(csrf), data: {
      label: `People viewer ${uniq("r")}`, scope_mode: "all", permissions: ["events.view", "participants.view"],
    } });
    expect(role.ok(), `create role: ${role.status()} ${await role.text()}`).toBeTruthy();
    viewer = await makeParticipant(sa, csrf, "pcviewer");
    const pr = await sa.patch(`/api/admin/users/${viewer.id}/role`, { headers: H(csrf), data: { role: (await role.json()).role.id } });
    expect(pr.ok(), `assign role: ${pr.status()} ${await pr.text()}`).toBeTruthy();
    await rowShows(sa, target.id, (r) => r.competitions.some((c) => c.status === "ended"));
  } finally { await sa.dispose(); }

  const certAsks = (pg) => {
    const asks = [];
    pg.on("request", (r) => { if (/\/certificates$/.test(new URL(r.url()).pathname)) asks.push(r.url()); });
    return asks;
  };
  const viewerAsks = certAsks(page);
  await loginViaApi(page, viewer.email);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });
  await expect.poll(() => page.evaluate(() => {
    const p = window.S.permissions;
    return Array.isArray(p) && p.includes("participants.view") && !p.includes("certificates.view");
  }), { message: "PRECONDITION: the role's own permissions, from the server: people, not certificates" }).toBe(true);
  const card = await openCard(page, target);
  await expect(card.locator(".pc-events")).toBeVisible();
  await expect(card.locator(`[data-cert-for]`), "PRECONDITION: the ended event is on the card").not.toHaveCount(0);
  await expect(card.locator("#pc-cert-note")).toHaveText("");
  await expect(card).not.toContainText("Could not check certificates");

  // CONTROL: a role that may read certificates asks at once, in its own browser.
  // Requests are seen in the order they leave, so once this one is seen, one from
  // the viewer's card would have been seen before it.
  const ctx = await browser.newContext({ baseURL: BASE });
  try {
    const sp = await ctx.newPage();
    await showAllParticipantColumns(sp);
    const saAsks = certAsks(sp);
    await adminLogin(sp);
    const saCard = await openCard(sp, target);
    await expect.poll(() => saAsks.length, { timeout: 10000 }).toBe(1);
    await expect(saCard.locator("#pc-cert-note")).toHaveText("No certificates issued yet.");
  } finally { await ctx.close(); }
  expect(viewerAsks, "the role without certificates.view was never sent to the route").toEqual([]);
});

test("upcoming Programs are never asked: they cannot crowd an older event's certificate out of the capped asks", async ({ page }) => {
  // The holder of a 1st-place certificate in an ENDED event, then enrolled in six
  // UPCOMING Programs. The row lists events oldest first and the card asks the
  // six most recent, so if upcoming Programs counted they would take every ask.
  const { comp, holder } = await heldCertificate("pcupc");
  const programs = [];
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    for (let i = 0; i < 6; i++) {
      const cr = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `PC Soon ${i} ${uniq("p")}`, event_kind: "program",
        start_time: new Date(Date.now() + (i + 1) * 86400e3).toISOString(),
        deadline_at: new Date(Date.now() + (i + 40) * 86400e3).toISOString(),
      } });
      expect(cr.ok(), `create program: ${await cr.text()}`).toBeTruthy();
      programs.push((await cr.json()).competition);
    }
    for (const pr of programs) await enrol(sa, csrf, pr.id, [holder.id]);
    await rowShows(sa, holder.id, (r) => r.competitions.some((c) => c.id === comp.id && c.status === "ended")
      && programs.every((pr) => r.competitions.some((c) => c.id === pr.id && c.status === "upcoming" && c.certificate === "completion")));
  } finally { await sa.dispose(); }

  const asked = [];
  page.on("request", (r) => { const m = new URL(r.url()).pathname.match(/^\/api\/admin\/competitions\/([^/]+)\/certificates$/); if (m) asked.push(m[1]); });
  await adminLogin(page);
  const card = await openCard(page, holder);
  await expect(card.locator(`[data-cert-for="${comp.id}"]`), "the ended event's certificate is found").toHaveText(/1st place/, { timeout: 15000 });
  await expect(card.locator("#pc-cert-note"), "and nothing claims there is none").toHaveText("");
  expect(asked, "CONTROL: the ended event was asked").toContain(comp.id);
  expect(programs.filter((pr) => asked.includes(pr.id)).map((pr) => pr.name), "no upcoming Program was asked").toEqual([]);
});
