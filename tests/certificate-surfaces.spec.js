// @ts-check
//
// What a certificate's holder is told about it, on every surface that reads it:
//   • the wire's `placement` comes from the frozen basis, as `rankLabel` does — a
//     late entrant's participation certificate keeps its podium rank and is still
//     no placing, so neither the dialog nor the public page may say "placed
//     participant", and the share card draws no medal for it (nor for a
//     Program completer at board rank 1);
//   • GET /api/me/certificates/:token/linkedin-post answers the holder only;
//   • the share link's refusals name a place that exists (the event's Challenges
//     page), never "My certificates";
//   • a REVOKED certificate says so on the Challenges page, which offers no mint
//     the server would refuse (the Leaderboard card's revoked state has its own
//     lock, beside that card's other states);
//   • once a certificate is held, the Leaderboard card says what IT attests (its
//     tier), never what the board's rank would suggest;
//   • the event's certificate list carries `counts`, `?summary=1` answers them
//     alone, and both lists read the ledger once per list, never per row;
//   • the ended Overview's Certificates card asks for the summary only, never
//     keeps a failed read (Try again, and the next entry reads again), and is
//     re-read on the poll only while a dispatcher job is due soon.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH, freshCtx } = require("./helpers");
const { loginViaApi, adminLogin, clickTab, viewComp } = require("./ui-admin-helpers");
const { H, makeCompetition } = require("./event-admin-helpers");
const { heldCertificate, shareLink } = require("./certificate-fixture");
const { stripJsComments } = require("./doc-registry");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const dbRun = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...a); } finally { db.close(); }
};

test("a late entrant's participation certificate is never called a placing, on the wire or on its public page", async () => {
  const { comp, holder, mint } = await heldCertificate("lateplace");
  // CONTROL: a real 1st place is a placing, and its page says where they finished.
  expect(mint, "PRECONDITION: a placement certificate").toMatchObject({ placement: true, rankLabel: "1st Place", rank: 1 });
  dbRun("UPDATE achievement_badges SET shared_at=? WHERE token=?", new Date().toISOString(), mint.token);
  const anon = (await freshCtx()).api;
  try {
    const page1 = await (await anon.get(`/badge/${mint.token}`)).text();
    expect(page1).toContain(`finished 1st place in ${comp.name}`);

    // The frozen state a late entrant minted inside the window holds: basis
    // participation, the podium rank beside it, the late-entrant mark.
    dbRun("UPDATE achievement_badges SET basis='participation', late_entrant=1, score_snapshot=NULL WHERE token=?", mint.token);
    const { api: pa, csrf: pc } = await apiLogin(holder.email);
    try {
      const again = await pa.post(`/api/competitions/${comp.id}/badge`, { headers: H(pc) });
      expect(again.ok(), await again.text()).toBeTruthy();
      const d = await again.json();
      expect(d.token, "the same certificate came back").toBe(mint.token);
      expect(d.rank, "the rank is still a podium rank").toBe(1);
      expect(d.rankLabel).toBe("Participant");
      expect(d.placement, "a participation basis is no placing, whatever the rank").toBe(false);
      expect(d.lateEntrant).toBe(true);
    } finally { await pa.dispose(); }

    const page2 = await (await anon.get(`/badge/${mint.token}`)).text();
    const desc = (page2.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || "";
    expect(desc, "the share preview says they took part as a late entrant").toContain(`took part in ${comp.name} as a late entrant`);
    expect(page2.toLowerCase(), "no sentence places them as 'participant'").not.toContain("finished participant");
  } finally { await anon.dispose(); }
});

test("the share card follows the frozen basis: no medal palette for a completion or participation certificate, whatever its rank", () => {
  const { buildBadgeSvg } = require("../lib/badge");
  const base = { competitionName: "C", displayName: "N", dateLabel: "D", platformName: "P" };
  const GOLD = "#F7D26A";   // the 1st-place disc (RANK_PALETTES[1].discFrom)
  // CONTROL: a real 1st place is drawn gold; a participation card at rank 7 is not.
  expect(buildBadgeSvg({ ...base, rank: 1, basis: "placement", scoreLabel: "50 pts" })).toContain(GOLD);
  const participation = buildBadgeSvg({ ...base, rank: 7, basis: "participation" });
  expect(participation).not.toContain(GOLD);
  // A Program completer's stored board rank never shows: rank 1 and rank 7 draw
  // the same card, and it is not gold.
  const completedFirst = buildBadgeSvg({ ...base, rank: 1, basis: "completion" });
  expect(completedFirst, "a completion at rank 1 is not drawn as a placing").not.toContain(GOLD);
  expect(completedFirst).toBe(buildBadgeSvg({ ...base, rank: 7, basis: "completion" }));
  expect(completedFirst).toContain("Completed");
  // A late entrant's participation at podium rank 1 is the participation card.
  expect(buildBadgeSvg({ ...base, rank: 1, basis: "participation" })).toBe(participation);
});

test("the signed-in LinkedIn post answers its holder only; another participant, a stranger and a revoked certificate get nothing", async () => {
  const { holder, other, mint } = await heldCertificate("postowner");
  const code = dbGet("SELECT public_code FROM achievement_badges WHERE token=?", mint.token).public_code;
  expect(code, "PRECONDITION: the certificate has a code").toBeTruthy();
  const url = `/api/me/certificates/${encodeURIComponent(mint.token)}/linkedin-post`;

  const { api: pa } = await apiLogin(holder.email);
  const { api: oa } = await apiLogin(other.email);
  const anon = (await freshCtx()).api;
  try {
    const mine = await pa.get(url);
    expect(mine.status(), await mine.text()).toBe(200);
    const body = await mine.json();
    expect(body.text, "the holder's post carries their verification link").toContain(`/credential?code=${code}`);
    expect(body.composerUrl).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=/);

    const theirs = await oa.get(url);
    expect(theirs.status(), "another participant holding the token is told nothing").toBe(404);
    expect(await theirs.text(), "no post text leaks").not.toContain(code);
    expect((await anon.get(url)).status(), "a stranger is not signed in").toBe(401);

    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const rv = await sa.post(`/api/admin/badges/${mint.token}/revoke`, { headers: H(csrf), data: { reason: "test" } });
      expect(rv.ok(), await rv.text()).toBeTruthy();
    } finally { await sa.dispose(); }
    const gone = await pa.get(url);
    expect(gone.status(), "a revoked certificate has no post").toBe(404);
    expect(await gone.text()).not.toContain(code);
  } finally { await pa.dispose(); await oa.dispose(); await anon.dispose(); }
});

test("a used share link names where the certificate lives, never 'My certificates'", async () => {
  const { mint } = await heldCertificate("spentlink");
  const link = shareLink(mint.token, { used: true });
  const { api: anon, csrf } = await freshCtx();
  try {
    const pg = await anon.get(`/badge/${link}/post`);
    expect(pg.status()).toBe(410);
    const html = await pg.text();
    expect(html).toContain("already been used");
    expect(html, "the page names the event's Challenges page").toContain("your certificate is on its Challenges page");
    expect(html).not.toContain("My certificates");
    const post = await anon.post(`/badge/${link}/post`, { headers: H(csrf), data: {} });
    const d = await post.json();
    expect(d).toMatchObject({ ok: false, reason: "used" });
    expect(d.error).toContain("your certificate is on its Challenges page");
    expect(d.error).not.toContain("My certificates");
  } finally { await anon.dispose(); }
  // No surface may send a holder to a place by that name: it exists nowhere.
  // Comments are stripped first (a comment may name the old copy); what is left
  // is every string a person can be shown.
  const root = path.resolve(__dirname, "..");
  const files = ["routes/badge.js", "lib/certificate-dispatch.js", "lib/certificate-share.js", "public/index.html"]
    .concat(fs.readdirSync(path.join(root, "public/js/features")).map(f => `public/js/features/${f}`));
  const shown = (f) => {
    const raw = fs.readFileSync(path.join(root, f), "utf8");
    return f.endsWith(".html") ? raw.replace(/<!--[\s\S]*?-->/g, "") : stripJsComments(raw);
  };
  const hits = files.filter(f => shown(f).includes("My certificates"));
  expect(files.length, "CONTROL: the scan read the feature modules").toBeGreaterThan(10);
  expect(shown("routes/badge.js"), "CONTROL: the scan sees the share link's own copy").toContain("your certificate is on its Challenges page");
  expect(hits, "no surface names a 'My certificates' place").toEqual([]);
});

test("a revoked certificate says so on the Challenges page, and offers no mint", async ({ page }) => {
  const { comp, holder, mint } = await heldCertificate("revokedcta");
  await loginViaApi(page, holder.email);
  await page.goto("/");
  // CONTROL: before the revoke, the Challenges page offers the held certificate.
  const cta = page.locator("#cert-cta");
  await expect(cta).toBeVisible({ timeout: 20000 });
  await expect(cta.locator('[data-action="open-badge-share"]'), "the held certificate is offered").toHaveText(/View certificate/);

  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const rv = await sa.post(`/api/admin/badges/${mint.token}/revoke`, { headers: H(csrf), data: { reason: "test" } });
    expect(rv.ok(), await rv.text()).toBeTruthy();
  } finally { await sa.dispose(); }

  await page.reload();
  await expect(cta).toBeVisible({ timeout: 20000 });
  await expect(cta).toContainText("This certificate has been revoked");
  await expect(cta.locator('[data-action="open-badge-share"]'), "no button for a revoked certificate").toHaveCount(0);
  expect(dbGet("SELECT COUNT(*) AS n FROM achievement_badges WHERE user_id=? AND competition_id=?", holder.id, comp.id).n, "nothing was re-minted").toBe(1);
});

test("the event's certificate list carries its counts, and summary=1 answers them without the rows", async () => {
  const { comp, mint } = await heldCertificate("certcounts");
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const url = `/api/admin/competitions/${comp.id}/certificates`;
    const full = await (await sa.get(url)).json();
    expect(full.certificates.length, "PRECONDITION: one certificate").toBe(1);
    expect(full.counts).toEqual({ issued: 1, revoked: 0, emailed: 0, failed: 0 });
    const sum = await (await sa.get(`${url}?summary=1`)).json();
    expect(sum.counts).toEqual(full.counts);
    expect("certificates" in sum, "the summary leaves the rows out").toBe(false);
    expect(Array.isArray(sum.pending)).toBe(true);
    const rv = await sa.post(`/api/admin/badges/${mint.token}/revoke`, { headers: H(csrf), data: { reason: "test" } });
    expect(rv.ok(), await rv.text()).toBeTruthy();
    expect((await (await sa.get(`${url}?summary=1`)).json()).counts, "a revoked certificate is counted apart").toEqual({ issued: 0, revoked: 1, emailed: 0, failed: 0 });
  } finally { await sa.dispose(); }
});

// THE LISTS' COST, read from the two list handlers themselves (comments stripped,
// tests/doc-registry.js routeRegions): inside the per-row loop — `rows.map((row)
// => { … });` — no ledger read of any shape and no read of the share-gate
// setting, and outside it exactly one batched ledger read for the whole list (the
// N+1 that made a 3000-person Overview cost ~6000 statements). A single-row
// lookup elsewhere in routes/badge.js (the resend) is not judged.
function perRowLoop(region) {
  const lines = region.split("\n");
  const i = lines.findIndex((l) => /\brows\.map\(\(row\) => \{\s*$/.test(l));
  if (i < 0) return null;
  const indent = lines[i].match(/^\s*/)[0];
  const j = lines.findIndex((l, k) => k > i && l === `${indent}});`);
  if (j < 0) return null;
  return { loop: lines.slice(i, j + 1).join("\n"), rest: [...lines.slice(0, i), ...lines.slice(j + 1)].join("\n") };
}
function listCostProblems(region) {
  const r = perRowLoop(region);
  if (!r) return ["the per-row loop (rows.map((row) => { … });) was not found"];
  const out = [];
  if (/\bcertificateEmailStates?\(/.test(r.loop)) out.push("a ledger read inside the per-row loop");
  if (/\b_badgeShareGateFloor\(/.test(r.loop)) out.push("a settings read inside the per-row loop");
  if (/\b_badgePageWithheld\(\s*row\s*\)/.test(r.loop)) out.push("the share gate judged without the list's floor inside the per-row loop");
  if ((r.rest.match(/\bcertificateEmailStates\(/g) || []).length !== 1) out.push("not exactly one batched ledger read for the list");
  return out;
}

test("both certificate lists read the ledger and the share-gate setting once per list, never per row", () => {
  const { routeRegions, routeKey } = require("./doc-registry");
  const regions = routeRegions();
  for (const route of ["/api/admin/competitions/:id/certificates", "/api/me/certificates"]) {
    const found = (regions.get(routeKey("GET", route)) || []).filter((r) => r.file === "routes/badge.js");
    expect(found.length, `PRECONDITION: GET ${route} is declared once in routes/badge.js`).toBe(1);
    expect(listCostProblems(found[0].body), `GET ${route}`).toEqual([]);
  }
  // PLANTED CONTROLS: the shape the lists have passes; a per-row lookup of either
  // shape, a per-row settings read and a lost batch are each caught.
  const OK = [
    '  app.get("/x", (req, res) => {',
    "    const _floor = _badgeShareGateFloor();",
    "    const _mails = certificateDispatch.certificateEmailStates(rows.map(r => r.token));",
    "    const out = rows.map((row) => {",
    "      return { published: !_badgePageWithheld(row, _floor), mail: _mails.get(row.token) || null };",
    "    });",
    "  });",
  ].join("\n");
  expect(listCostProblems(OK)).toEqual([]);
  expect(listCostProblems(OK.replace("_mails.get(row.token)", "certificateDispatch.certificateEmailState(row.token)"))).toContain("a ledger read inside the per-row loop");
  expect(listCostProblems(OK.replace("_mails.get(row.token)", "certificateDispatch.certificateEmailStates([row.token]).get(row.token)"))).toContain("a ledger read inside the per-row loop");
  expect(listCostProblems(OK.replace("_badgePageWithheld(row, _floor)", "_badgePageWithheld(row)"))).toContain("the share gate judged without the list's floor inside the per-row loop");
  expect(listCostProblems(OK.replace("_badgePageWithheld(row, _floor)", "_badgePageWithheld(row, _badgeShareGateFloor())"))).toContain("a settings read inside the per-row loop");
  expect(listCostProblems(OK.replace("    const _mails = certificateDispatch.certificateEmailStates(rows.map(r => r.token));\n", ""))).toContain("not exactly one batched ledger read for the list");
  expect(listCostProblems(OK.replace("rows.map((row) => {", "rows.forEach((row) => {"))).toEqual(["the per-row loop (rows.map((row) => { … });) was not found"]);
});

test("once a certificate is held, the Leaderboard card says what it attests, not what the board rank suggests", async ({ page }) => {
  const { comp, holder, mint } = await heldCertificate("lbtier");
  expect(mint, "PRECONDITION: a 1st-place certificate").toMatchObject({ placement: true, rank: 1 });
  await loginViaApi(page, holder.email);
  const card = page.locator("#lb-badge-cta");
  /** The card once the held certificate has been read (its code is shown). */
  const heldCard = async () => {
    await page.goto("/");
    await expect(page.locator('#nav-leaderboard:not([aria-disabled="true"])')).toBeVisible({ timeout: 20000 });
    await page.locator("#nav-leaderboard").click();
    await expect(card.locator(".lb-cert-meta"), "the held certificate was read").toContainText("Code", { timeout: 20000 });
    return card;
  };
  // CONTROL: a held 1st place is named as one.
  await heldCard();
  await expect(card.locator(".lb-badge-cta-text strong")).toContainText("You placed");
  await expect(card.locator(".lb-badge-cta-text strong")).toContainText("1st place");
  await expect(card.locator(".lb-cert-thumb")).toHaveClass(/\bis-p1\b/);

  // The frozen state a late entrant minted inside the window holds: basis
  // participation with the podium rank beside it. The board still shows rank 1.
  dbRun("UPDATE achievement_badges SET basis='participation', late_entrant=1, score_snapshot=NULL WHERE token=?", mint.token);
  await heldCard();
  await expect(card.locator(".lb-cert-t"), "PRECONDITION: the card shows the held certificate").toHaveText("Participant");
  await expect(card.locator(".lb-badge-cta-text strong"), "a participation certificate is not a placing").toHaveText(`You took part in ${comp.name}.`);
  await expect(card.locator(".lb-cert-thumb"), "and is not drawn as one").not.toHaveClass(/\bis-p[123]\b/);
});

test("the ended Overview's certificates card is painted from the summary, not the whole list", async ({ page }) => {
  const { comp } = await heldCertificate("certovw");
  const asks = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname === `/api/admin/competitions/${comp.id}/certificates`) asks.push(u.search); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await clickTab(page, "Events");
  await viewComp(page, comp.name);
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "ended", { timeout: 20000 });
  const certs = page.locator("#ws-ov-certs");
  await expect(certs.locator(".ws-prog-num")).toHaveText("1", { timeout: 15000 });
  await expect(certs).toContainText("issued");
  // Other panes read the rows (the Certificates section, Rankings); the card asks
  // only for the figures.
  expect(asks, "the Overview card asked for the summary").toContain("?summary=1");
});

// ── The ended Overview's Certificates card (features/event-workspace.js) ──────

const isSummaryOf = (compId) => (url) => url.pathname === `/api/admin/competitions/${compId}/certificates` && url.search === "?summary=1";

/** An event of its own, ended by End Now. */
async function endedEvent(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const comp = await makeCompetition(sa, csrf, label);
    const e = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(e.ok(), `end-now: ${await e.text()}`).toBeTruthy();
    return comp;
  } finally { await sa.dispose(); }
}

/** Open an event's workspace, once the Events model holds it, on its ended Overview. */
async function openEndedOverview(page, comp) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some((c) => c.id === id), comp.id),
    { timeout: 15000, message: "PRECONDITION: the Events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: comp.id, n: comp.name });
  await expect(page.locator("#ws-title")).toHaveText(comp.name, { timeout: 15000 });
  await expect(page.locator("#ws-overview")).toHaveAttribute("data-ov-state", "ended", { timeout: 15000 });
}

test("the Overview's certificates card never keeps a failed read: it offers Try again, and the next entry reads again", async ({ page }) => {
  const { comp } = await heldCertificate("certretry");
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  // The events poll stays out of the counts below: every read is the card's own.
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  let reads = 0;
  const summary = isSummaryOf(comp.id);
  await page.route(summary, (route) => { reads++; return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }); });
  await openEndedOverview(page, comp);
  const card = page.locator("#ws-ov-certs");
  const retry = card.locator('[data-action="ws-certs-retry"]');
  await expect(retry, "a failed read offers Try again").toBeVisible({ timeout: 15000 });
  await expect(card.locator(".ws-prog-num"), "and shows no figures").toHaveCount(0);
  const failedReads = reads;
  expect(failedReads, "PRECONDITION: the read was made, and failed").toBeGreaterThan(0);
  // Away from the Overview and back, within the minute a success is kept: the
  // failure is not served from a cache, the card reads again.
  await page.evaluate(() => window.wsTab("admin-rankings-tab"));
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await expect.poll(() => reads, { timeout: 10000, message: "back on the Overview the failed read is made again" }).toBeGreaterThan(failedReads);
  await expect(retry).toBeVisible();
  // Try again, with the route answering: the figures.
  await page.unroute(summary);
  await retry.click();
  await expect(card.locator(".ws-prog-num"), "Try again read the summary and painted it").toHaveText("1", { timeout: 15000 });
  await expect(retry).toHaveCount(0);
});

test("the poll re-reads the certificates card while a dispatcher job is due soon, never every poll for one days away", async ({ page }) => {
  const ev = await endedEvent("certpoll");
  const other = await endedEvent("certpollb");
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await page.evaluate(() => { clearInterval(window.S.adminCompPollInterval); window.S.adminCompPollInterval = null; });
  // The summary as the server sends it while a job waits: first held to a
  // late-entry deadline two days away, then (CONTROL) due in a minute.
  let dueAt = new Date(Date.now() + 2 * 86400e3).toISOString();
  let reads = 0;
  await page.route(isSummaryOf(ev.id), (route) => {
    reads++;
    return route.fulfill({ json: { competitionId: ev.id, emailEnabled: true, counts: { issued: 0, revoked: 0, emailed: 0, failed: 0 },
      pending: [{ scope: "event", reason: "late_entry_pending", dueAt }] } });
  });
  await openEndedOverview(page, ev);
  const card = page.locator("#ws-ov-certs");
  await expect(card).toContainText("Being issued", { timeout: 15000 });
  expect(reads, "PRECONDITION: one read on open").toBe(1);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.refreshOverviewLive());
  expect(reads, "a job days away: the polls keep the minute-long cache").toBe(1);
  // CONTROL: due within the minute, every poll reads it again.
  dueAt = new Date(Date.now() + 60_000).toISOString();
  await openEndedOverview(page, other);
  await openEndedOverview(page, ev);
  await expect.poll(() => reads, { timeout: 10000, message: "PRECONDITION: reopened, read again" }).toBe(2);
  for (let i = 0; i < 2; i++) await page.evaluate(() => window.refreshOverviewLive());
  expect(reads, "a job due soon: each poll reads it").toBe(4);
});

// OPERATOR RULING, 14 NOV 2026 (#99): an organiser competing in an event keeps
// its reads (the 14 Sep decision), so its Overview no longer claims anything is
// hidden from them: the certificates card shows its counts as it does for any
// organiser, and only the LIVE figures stay off the page (the pulse refuses a
// competitor, and the page never asks it). CONTROL: the same organiser once the
// event no longer lets staff compete sees the live figures, read from the pulse.
test("a competing organiser's ended Overview shows the certificate counts, and keeps only the live figures off the page", async ({ page }) => {
  test.setTimeout(120_000);
  const { comp } = await heldCertificate("certcmp");
  const { makeParticipant } = require("./event-admin-helpers");
  const { api: sa, csrf } = await apiLogin("superadmin");
  let org;
  try {
    org = await makeParticipant(sa, csrf, "certcmporg");
    const r = await sa.post(`/api/admin/participants/${org.id}/role`, { headers: H(csrf), data: { role: "admin" } });
    expect(r.ok(), `promote: ${await r.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
  // The event has ended, so no door enrols anybody: the competing state is
  // planted (the switch on, and a row for the organiser), as a staff-compete
  // event that ended with them playing holds it.
  dbRun("UPDATE competitions SET staff_compete=1 WHERE id=?", comp.id);
  dbRun("INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,1)", comp.id, org.id, "superadmin", new Date().toISOString());
  const asked = { pulse: 0, summary: 0 };
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === `/api/admin/competitions/${comp.id}/overview-pulse`) asked.pulse++;
    if (isSummaryOf(comp.id)(u)) asked.summary++;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginViaApi(page, org.email);
  await page.goto("/");
  await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
  await openEndedOverview(page, comp);
  await expect(page.locator("#ws-record .ws-chip-competing"), "PRECONDITION: the organiser competes in it").toBeVisible();
  const ov = page.locator("#ws-overview");
  const certs = page.locator("#ws-ov-certs");
  await expect(certs.locator(".ws-prog-num"), "the certificate counts, as any organiser sees them").toHaveText("1", { timeout: 15000 });
  await expect(certs).toContainText("issued");
  expect(asked.summary, "the card read them").toBeGreaterThan(0);
  await expect(page.locator("#ws-ov-progress"), "the live figures stay off the page, and it says only that").toContainText("While you compete in this event, its live figures are kept off this page.");
  await expect(ov, "nothing claims a read is hidden from them").not.toContainText("not shown");
  await expect(ov).not.toContainText("Hidden while you compete");
  expect(asked.pulse, "the page never asks for the live figures").toBe(0);

  // CONTROL: no longer competing (the switch off), the same organiser's Overview
  // reads the pulse and shows the figures.
  dbRun("UPDATE competitions SET staff_compete=0 WHERE id=?", comp.id);
  await page.evaluate(() => window.loadAdminCompetitions());
  await expect.poll(() => page.evaluate((id) => ((window.adminCompetitionsData || []).find((c) => c.id === id) || {}).competing === true, comp.id),
    { timeout: 10000, message: "PRECONDITION: the Events model says they no longer compete" }).toBe(false);
  await openEndedOverview(page, comp);
  await expect(page.locator("#ws-ov-progress"), "the live figures, from the pulse").toContainText("solved every challenge", { timeout: 15000 });
  await expect(page.locator("#ws-ov-progress")).not.toContainText("kept off this page");
  expect(asked.pulse, "CONTROL: read for an organiser who does not compete").toBeGreaterThan(0);
});

// ── An event whose certificates are not issued automatically (sweep finding #230) ──
//
// The dispatcher decides when it runs (lib/certificate-dispatch.js), so the job
// End Now queues for an event whose congratulations email is off is no promise:
// it will issue nothing. The Overview's card and the top-3 download used to say
// "being issued" for as long as that job waited. They now ask the same refusal
// the dispatcher will (`automaticRefusal` on the list, the route's own check)
// and say why; with the email on, the same moment still reads "being issued".

const { makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { PARTICIPANT_PASS, gradingHashFor } = require("./helpers");

/** A live event with one scorer on its board (a podium place), ended by End Now; the email off if asked. */
async function scoredEndedEvent(label, { emailOff = false, dryRun = false } = {}) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const comp = await makeCompetition(sa, csrf, label);
    if (dryRun) {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/tags`, { headers: H(csrf), data: { tag: "test/dry run" } });
      expect(r.ok(), `dry run: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    if (emailOff) {
      const r = await sa.put(`/api/admin/competitions/${comp.id}/certificate-config`, { headers: H(csrf), data: { config: { email: { enabled: false } } } });
      expect(r.ok(), `email off: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    // Two challenges, so one solve cannot finish the event (fixture checklist 1).
    const t1 = await makeTask(sa, csrf, `${label}-1`), t2 = await makeTask(sa, csrf, `${label}-2`);
    await assignTask(sa, csrf, t1.id, [comp.id]);
    await assignTask(sa, csrf, t2.id, [comp.id]);
    const p = await makeParticipant(sa, csrf, `${label}-p`);
    await enrol(sa, csrf, comp.id, [p.id]);
    const me = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      expect((await me.api.post("/api/select-competition", { headers: H(me.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      const s = await me.api.post(`/api/tasks/${t1.id}/submit`, { headers: { ...H(me.csrf), "x-competition-id": comp.id }, data: { answer: "a", gradingHash: await gradingHashFor(me.api, t1.id) } });
      expect(s.ok(), `solve: ${await s.text()}`).toBeTruthy();
      expect((await s.json()).correct, "PRECONDITION: a podium place").toBe(true);
    } finally { await me.api.dispose(); }
    const e = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(e.ok(), `end-now: ${await e.text()}`).toBeTruthy();
    return comp;
  } finally { await sa.dispose(); }
}

test("an event that issues nothing automatically never reads as being issued, at the download or in the list", async () => {
  const off = await scoredEndedEvent("cert-auto-off", { emailOff: true });
  const on = await scoredEndedEvent("cert-auto-on");
  const dry = await scoredEndedEvent("cert-auto-dry", { dryRun: true });
  // Signed in after the fixtures: the built-in superadmin keeps one session.
  const { api: sa } = await apiLogin("superadmin");
  try {
    const summary = async (c) => (await (await sa.get(`/api/admin/competitions/${c.id}/certificates?summary=1`)).json());
    const top3 = async (c) => { const r = await sa.get(`/api/admin/competitions/${c.id}/certificates/top3.zip`); return [r.status(), await r.json()]; };
    const sOff = await summary(off), sOn = await summary(on);
    expect(sOff.pending.length, "PRECONDITION: End Now queued a job for the email-off event too").toBeGreaterThan(0);
    expect(sOn.pending.length, "PRECONDITION: and for the control").toBeGreaterThan(0);
    expect(sOff.automaticRefusal, "the list says why nothing will be issued").toBe("email_disabled");
    expect(sOn.automaticRefusal, "CONTROL: nothing stops the other").toBeNull();
    const [stOff, dOff] = await top3(off);
    expect([stOff, dOff.code, dOff.reason], JSON.stringify(dOff)).toEqual([409, "certificates_not_issued_automatically", "email_disabled"]);
    const [stOn, dOn] = await top3(on);
    expect([stOn, dOn.code], JSON.stringify(dOn)).toEqual([409, "certificates_being_issued"]);
    // A test event's job promises nothing either: every refusal answers first.
    const sDry = await summary(dry);
    expect([sDry.automaticRefusal, sDry.pending.length > 0], "PRECONDITION: a job waits for the test event too").toEqual(["dry_run", true]);
    const [stDry, dDry] = await top3(dry);
    expect([stDry, dDry.code, dDry.reason], JSON.stringify(dDry)).toEqual([409, "certificates_not_issued_automatically", "dry_run"]);
  } finally { await sa.dispose(); }
});

test("the Overview's certificates card says why an event's certificates are not issued, instead of 'being issued'", async ({ page }) => {
  const off = await scoredEndedEvent("cert-card-off", { emailOff: true });
  const on = await scoredEndedEvent("cert-card-on");
  await page.setViewportSize({ width: 1440, height: 900 });
  await adminLogin(page);
  await openEndedOverview(page, off);
  const card = page.locator("#ws-ov-certs");
  await expect(card).toContainText("No certificates issued: they are not issued automatically while this event's congratulations email is off, so participants collect their own from the event.", { timeout: 15000 });
  await expect(card).not.toContainText("Being issued");
  // CONTROL: the same moment on an event whose email is on.
  await openEndedOverview(page, on);
  await expect(card).toContainText("Being issued: they go out a few minutes after the end.", { timeout: 15000 });
});
