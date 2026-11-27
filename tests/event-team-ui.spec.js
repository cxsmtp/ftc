"use strict";

// EVENT TEAM + PICK-ONE QUESTIONS — the browser half: the workspace's Team &
// reports section (add a member, the persona views, the lead list's contacted
// mark, the preview), the Settings card of allowed domains, the create form's
// seeded tick and the participant's pick-one card with no penalty warning; the
// SDR's "Hot still to contact" tile and the Managers' row count only leads who
// can be contacted, and Marketing's view with no leads says so in words that
// stand alone (operator rulings, 14 Nov 2026); the contacted mark's answer
// updates only the event it was sent for. The mail and the rules are locked in
// tests/event-team-reports.spec.js.

const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, TEST_DB_PATH } = require("./helpers");
const { adminLogin, viewComp, clickTab, openSettingsSection, loginViaApi, openCompCreateForm } = require("./ui-admin-helpers");
const { H, makeParticipant, enrol, makeTask, assignTask, grantEventAdmin } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

async function superCtx(browser) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await adminLogin(page);
  return { ctx, page };
}

test("Team & reports: a member is added, the persona views render and contacted is stored", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const put = await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } });
  expect(put.ok(), await put.text()).toBeTruthy();
  const name = `Team UI ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  const p = await makeParticipant(req, await csrf(), "teamui");
  await enrol(req, await csrf(), compId, [p.id]);

  await page.goto(`${BASE}/`);
  await viewComp(page, name);
  await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
  await expect(page.locator("#team-members-h")).toBeVisible();
  await page.locator("#team-add-role").selectOption("sdr");
  await page.locator("#team-add-name").fill("Sid Report");
  await page.locator("#team-add-email").fill("bad@gmail.com");
  await page.locator('[data-action="team-add"]').click();
  await expect(page.locator("#toast-stack")).toContainText("corp.example");
  await page.locator("#team-add-email").fill("sid@corp.example");
  await page.locator('[data-action="team-add"]').click();
  await expect(page.locator("#ws-team")).toContainText("sid@corp.example");

  // The persona views, by the lead they list — the SDR's card with the lead's
  // address, as on the SDR's email (operator ruling 79).
  await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
  await expect(page.locator("#team-persona-view")).toContainText("Sid Report");
  await expect(page.locator("#team-persona-view")).toContainText("1 lead");
  await expect(page.locator("#team-persona-view .team-lead .team-lead-email")).toHaveText(p.email);
  const box = page.locator('[data-change-action="team-contacted"]').first();
  const saved = page.waitForResponse(r => /\/leads\/.+\/contacted$/.test(r.url()));
  await box.check();
  expect((await saved).ok()).toBeTruthy();
  const rep = await (await req.get(`${BASE}/api/admin/competitions/${compId}/team-report`)).json();
  expect(rep.leads[0].contacted_at).toBeTruthy();

  await page.locator('[data-action="team-preview"]').click();
  // The HTML email itself, in a sandboxed frame, not its plain text. Contacted
  // leads leave the SDR's cards; the count stays. Sid has no account that can
  // open the event, so his email has no button and no link: the next step in
  // words (operator ruling 79).
  let mail = page.frameLocator("#modal-overlay iframe.team-preview");
  await expect(mail.locator("body")).toContainText("Your leads: 1 (0 hot)");
  await expect(mail.locator("body")).toContainText("This email has no link");
  await expect(mail.locator(".m-next")).toContainText("Next: ");
  await expect(mail.locator("a")).toHaveCount(0);
  await expect(mail.locator("body")).not.toContainText("&section=team");
  await page.locator("#modal-overlay.open #modal-confirm-btn").click();   // Close (a key press would land in the frame)
  await expect(page.locator("#modal-overlay.open")).toHaveCount(0);

  // CONTROL: an administrator's address opens the event, so the SE's email
  // (sent to one) carries the button.
  const adm = await makeParticipant(req, await csrf(), "teamuiadm");
  expect((await req.post(`${BASE}/api/admin/participants/${adm.id}/role`, { data: { role: "admin" }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  expect((await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example", adm.email.split("@")[1]] }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  const se = await req.post(`${BASE}/api/admin/competitions/${compId}/team`, { data: { role: "se", name: "Ada Admin", email: adm.email }, headers: { "x-csrf-token": await csrf() } });
  expect(se.ok(), await se.text()).toBeTruthy();
  await page.evaluate(() => window.loadEventTeam());
  await expect(page.locator("#ws-team")).toContainText("Ada Admin");
  await page.locator('[data-action="team-persona"][data-persona="se"]').click();
  await expect(page.locator("#team-persona-view")).toHaveAttribute("data-persona", "se");
  await page.locator('[data-action="team-preview"]').click();
  mail = page.frameLocator("#modal-overlay iframe.team-preview");
  await expect(mail.locator("body")).toContainText("&section=");
  await expect(mail.locator("a.m-btn-a")).toHaveCount(1);
  await expect(mail.locator("body")).not.toContainText("This email has no link");
  // The inline styles really apply (a stray quote in one ends the attribute and
  // leaves a serif page with a blue link): a filled button with white text.
  const btn = await mail.locator("a.m-btn-a").evaluate(el => { const c = getComputedStyle(el), p = getComputedStyle(el.closest("td")); return { color: c.color, pad: parseFloat(c.paddingLeft), deco: c.textDecorationLine, font: c.fontFamily, bg: p.backgroundColor }; });
  expect(btn.color).toBe("rgb(255, 255, 255)");
  expect(btn.bg).toBe("rgb(90, 61, 240)");
  expect(btn.pad).toBeGreaterThanOrEqual(16);
  expect(btn.deco).toBe("none");
  expect(btn.font).toContain("Segoe UI");
  // The dialog gives the 640 px mail its room.
  const frameBox = await page.locator("#modal-overlay iframe.team-preview").boundingBox();
  expect(frameBox.width, "wide enough for the mail").toBeGreaterThanOrEqual(640);
  expect(await page.locator("#modal-overlay iframe.team-preview").getAttribute("sandbox"), "no scripts, opaque origin").toBe("");
  expect(await page.locator("#modal-overlay pre").count(), "not the plain-text dump").toBe(0);
  await page.keyboard.press("Escape");

  // A report email's link opens this section of this event after sign-in, and
  // leaves no event id in the address bar.
  await page.goto(`${BASE}/?event=${compId}&section=team`);
  await expect(page.locator("#team-members-h")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#ws-team")).toContainText("sid@corp.example");
  expect(new URL(page.url()).search).toBe("");
  await ctx.close();
});

test("a role that may edit the event but not read the reports gets no add form and no Send now, each with its reason; Marketing and SDR are withheld without the lead file's permission (superadmin CONTROL)", async ({ browser }) => {
  // The server refuses both writes for such a role (tests/event-team-reports.spec.js);
  // the section must not offer them, and must say why instead.
  const a = await superCtx(browser);
  const req = a.page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  expect((await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  const name = `Team gate ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  // A Marketing member, so Send now would carry the CRM file.
  const mk = await req.post(`${BASE}/api/admin/competitions/${compId}/team`, { data: { role: "marketing", name: "Mia Gate", email: `mia-${Date.now()}@corp.example` }, headers: { "x-csrf-token": await csrf() } });
  expect(mk.ok(), await mk.text()).toBeTruthy();
  const holder = async (label, permissions) => {
    const role = await req.post(`${BASE}/api/admin/roles`, { data: { label: `${label} ${Date.now()}`, scope_mode: "granted", permissions }, headers: { "x-csrf-token": await csrf() } });
    expect(role.ok(), await role.text()).toBeTruthy();
    const p = await makeParticipant(req, await csrf(), label.toLowerCase().replace(/\W+/g, ""));
    const rr = await req.post(`${BASE}/api/admin/participants/${p.id}/role`, { data: { role: (await role.json()).role.id }, headers: { "x-csrf-token": await csrf() } });
    expect(rr.ok(), await rr.text()).toBeTruthy();
    await grantEventAdmin(req, await csrf(), compId, p.id);
    return p;
  };
  const editOnly = await holder("Team editor", ["events.view", "events.edit"]);
  const noCrm = await holder("Team viewer", ["events.view", "events.edit", "participants.view"]);
  const openTeam = async (email) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const page = await ctx.newPage();
    await loginViaApi(page, email);
    await page.goto(`${BASE}/`);
    await viewComp(page, name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
    await expect(page.locator("#team-members-h")).toBeVisible();
    await expect(page.locator("#ws-team")).toContainText("Mia Gate");
    return { ctx, page };
  };

  // events.edit alone: the form is replaced by the reason.
  let s = await openTeam(editOnly.email);
  await expect(s.page.locator("#team-add-refusal")).toContainText("participants' details");
  await expect(s.page.locator("#team-add-role"), "no add form").toHaveCount(0);
  await expect(s.page.locator('[data-action="team-send"]'), "no Send now").toHaveCount(0);
  await s.ctx.close();

  // participants.view without export.data: every role but the two sent a lead
  // file (Marketing's CRM file, each SDR's own: operator ruling 79), one note for
  // both, and Send now says why.
  s = await openTeam(noCrm.email);
  await expect(s.page.locator("#team-add-refusal")).toHaveCount(0);
  await expect(s.page.locator('#team-add-role option[value="sales"]')).toBeEnabled();
  await expect(s.page.locator('#team-add-role option[value="marketing"]')).toBeDisabled();
  await expect(s.page.locator('#team-add-role option[value="sdr"]')).toBeDisabled();
  await expect(s.page.locator(".team-role-refusal")).toHaveCount(1);
  await expect(s.page.locator(".team-role-refusal")).toContainText("Marketing, SDR:");
  await expect(s.page.locator(".team-role-refusal")).toContainText("CRM file");
  await expect(s.page.locator("#team-send-refusal")).toContainText("CRM file");
  await expect(s.page.locator('[data-action="team-send"]')).toHaveCount(0);
  await s.ctx.close();

  // CONTROL: the superadmin gets the whole form, Marketing included, and Send now.
  await a.page.goto(`${BASE}/`);
  await viewComp(a.page, name);
  await a.page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
  await expect(a.page.locator('#team-add-role option[value="marketing"]')).toBeEnabled();
  await expect(a.page.locator('#team-add-role option[value="sdr"]')).toBeEnabled();
  await expect(a.page.locator(".team-role-refusal")).toHaveCount(0);
  await expect(a.page.locator('[data-action="team-send"]')).toBeVisible();
  await expect(a.page.locator("#team-send-refusal")).toHaveCount(0);
  await a.ctx.close();
});

test("Settings lists the allowed domains; the create form seeds the tick from the kind", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  await page.goto(`${BASE}/`);
  await clickTab(page, "settings");
  await openSettingsSection(page, "email");
  await expect(page.locator("#team-domains-card")).toBeVisible();
  await page.locator("#team-domains-input").fill("Example.org\nfoo.example.org");
  await page.locator('[data-action="team-domains-save"]').click();
  await expect(page.locator("#team-domains-note")).toContainText(/Saved|Unchanged/);
  await expect(page.locator("#team-domains-input")).toHaveValue("example.org\nfoo.example.org");

  await page.goto(`${BASE}/`);
  await openCompCreateForm(page, "booth");
  await expect(page.locator("#comp-add-qualifying")).toBeChecked();
  await ctx.close();

  const c2 = await superCtx(browser);
  await c2.page.goto(`${BASE}/`);
  await openCompCreateForm(c2.page, "tournament");
  await expect(c2.page.locator("#comp-add-qualifying")).not.toBeChecked();
  await c2.ctx.close();
});

test("a participant answers a pick-one question with radios and no penalty warning", async ({ browser }) => {
  const a = await superCtx(browser);
  const req = a.page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const name = `Pick UI ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  const p = await makeParticipant(req, await csrf(), "pickui");
  await enrol(req, await csrf(), compId, [p.id]);
  await a.ctx.close();

  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await loginViaApi(page, p.email);
  await page.goto(`${BASE}/`);
  const card = page.locator(".task-card", { hasText: "How many developers" });
  await expect(card).toBeVisible();
  // A quick question, not a challenge to win: no difficulty, on the card or inside.
  await expect(card.locator(".pts")).toHaveText("Quick question");
  await expect(card.locator(".badge")).toHaveCount(0);
  // The difficulty chips leave it out; All still shows it.
  await page.locator("#diff-filters .filter-btn", { hasText: /Easy/ }).click();
  await expect(page.locator(".task-card", { hasText: "How many developers" })).toHaveCount(0);
  await page.locator('#diff-filters .filter-btn', { hasText: /^All$/ }).click();
  await expect(card).toBeVisible();

  await card.locator(".card-open").click();
  await expect(page.locator(".choice-option")).toHaveCount(4);
  const detail = page.locator("#task-detail-card");
  await expect(detail.locator(".pts")).toHaveText("Quick question");
  await expect(detail.locator(".badge")).toHaveCount(0);
  await expect(detail.locator(".attempts-count")).toHaveCount(0);
  await expect(detail.locator(".qa-rate")).toHaveCount(0);
  // "Every answer is accepted" once, in the question's text.
  expect((await detail.innerText()).match(/every answer is accepted/gi) || []).toHaveLength(1);

  await page.locator(".choice-option", { hasText: "1000+" }).click();
  const sent = page.waitForResponse(r => /\/submit$/.test(r.url()));
  await page.locator('[data-action="task-submit-answer"][data-mode="pickone"]').click();
  const r = await sent;
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body.correct).toBe(true);
  expect(body.qualifying).toBe(true);

  // THE THANK-YOU: no "Correct", no points, no score, and a way on.
  const dlg = page.locator(".ha-win");
  await expect(dlg.locator("#ha-win-h")).toHaveText("Thanks, noted");
  const said = await dlg.innerText();
  expect(said).not.toMatch(/correct|solved|\bpts\b|points|score/i);
  await dlg.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#tasks-page")).toBeVisible();

  // Answered: the list says so, and opening it shows their choice, never "Correct".
  await page.locator('#solve-filters .filter-btn', { hasText: /^All$/ }).click();
  await expect(card).toHaveClass(/solved/);
  expect(await card.evaluate(el => getComputedStyle(el, "::after").content)).toContain("ANSWERED");
  await card.locator(".card-open").click();
  const review = page.locator("#choice-review");
  await expect(review.locator(".choice-review-label")).toHaveText("Your answer");
  await expect(review.locator(".choice-review-row.is-picked")).toHaveCount(1);
  await expect(review.locator(".choice-review-row.is-picked")).toContainText("1000+");
  await expect(review.locator(".is-correct")).toHaveCount(0);
  const later = await detail.innerText();
  expect(later).toContain("Thanks, noted");
  expect(later).toMatch(/answered/i);
  expect(later).not.toMatch(/correct|\+\d+\b|solved/i);
  await expect(detail.locator(".qa-rate")).toHaveCount(0);
  await ctx.close();
});

// OPERATOR RULING 395 (14 Nov 2026): an answered Quick question offers Change
// answer while the person can still play; the new pick replaces the old in the
// reports. A scoring challenge stays answered once, and nothing is offered after
// the end.
test("an answered Quick question offers Change answer while the event runs, and the new pick is the answer (a scoring challenge CONTROL)", async ({ browser }) => {
  const a = await superCtx(browser);
  const req = a.page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const name = `Change UI ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  const task = await makeTask(req, await csrf(), "changeui", { correct_answer: "right" });
  await assignTask(req, await csrf(), task.id, [compId]);
  const p = await makeParticipant(req, await csrf(), "changeui");
  await enrol(req, await csrf(), compId, [p.id]);

  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await loginViaApi(page, p.email);
  await page.goto(`${BASE}/`);
  const card = page.locator(".task-card", { hasText: "How many developers" });
  const detail = page.locator("#task-detail-card");
  const answer = async (opt) => {
    await page.locator(".choice-option", { hasText: opt }).click();
    const sent = page.waitForResponse(r => /\/submit$/.test(r.url()));
    await page.locator('[data-action="task-submit-answer"][data-mode="pickone"]').click();
    expect((await sent).ok()).toBeTruthy();
    await page.locator(".ha-win").getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("#tasks-page")).toBeVisible();
  };
  await card.locator(".card-open").click();
  await expect(detail.locator('[data-action="task-change-answer"]'), "nothing to change before an answer").toHaveCount(0);
  await answer("1000+");
  await page.locator('#solve-filters .filter-btn', { hasText: /^All$/ }).click();
  await card.locator(".card-open").click();
  // Answered: their pick, the offer and its explanation, together.
  await expect(page.locator("#choice-review .choice-review-row.is-picked")).toContainText("1000+");
  await expect(detail).toContainText("You can change your answer until the event ends.");
  const change = detail.getByRole("button", { name: "Change answer" });
  await expect(change).toBeVisible();
  // Changing opens the options with the current pick ticked; Keep my answer leaves it as it was.
  await change.click();
  await expect(detail.locator(".qa-ans-label")).toContainText("Change your answer");
  await expect(detail.locator(".choice-option", { hasText: "1000+" }).locator("input")).toBeChecked();
  await detail.getByRole("button", { name: "Keep my answer" }).click();
  await expect(page.locator("#choice-review .choice-review-row.is-picked")).toContainText("1000+");
  await detail.getByRole("button", { name: "Change answer" }).click();
  await answer("1–49");
  await card.locator(".card-open").click();
  await expect(page.locator("#choice-review .choice-review-row.is-picked"), "the new pick is their answer").toContainText("1–49");
  await expect(page.locator("#choice-review .choice-review-row.is-picked")).toHaveCount(1);
  const rep = await (await req.get(`${BASE}/api/admin/competitions/${compId}/team-report`)).json();
  expect(rep.leads.find(l => l.user_id === p.id).answers.developers, "and the report's").toBe("1–49");

  // CONTROL: a scoring challenge, solved, offers no change.
  await page.goto(`${BASE}/`);
  await page.locator('#solve-filters .filter-btn', { hasText: /^All$/ }).click();
  await page.locator(".task-card", { hasText: task.title }).locator(".card-open").click();
  await page.locator("#ans-text").fill("right");
  await page.locator('[data-action="task-submit-answer"]').click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.locator(".ha-win").getByRole("button", { name: "Continue" }).click();
  await page.locator('#solve-filters .filter-btn', { hasText: /^All$/ }).click();
  await page.locator(".task-card", { hasText: task.title }).locator(".card-open").click();
  await expect(detail).toContainText("You have solved this challenge.");
  await expect(detail.locator('[data-action="task-change-answer"]')).toHaveCount(0);

  // After the end: still their answer, no longer changeable.
  expect((await req.post(`${BASE}/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  const pcsrf = (await (await page.request.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  expect((await page.request.post(`${BASE}/api/dismiss-ended`, { headers: { "x-csrf-token": pcsrf, "content-type": "application/json" } })).ok(), "the ended popup is dismissed first").toBeTruthy();
  const devId = (await (await page.request.get(`${BASE}/api/tasks`)).json()).find(t => /How many developers/.test(t.title)).id;
  await page.goto(`${BASE}/`);
  await expect(page.locator("#tasks-page")).toBeVisible();
  await page.evaluate((id) => window.openTask(id), devId);
  await expect(page.locator("#choice-review .choice-review-row.is-picked")).toContainText("1–49");
  await expect(detail.locator('[data-action="task-change-answer"]'), "not offered once the event has ended").toHaveCount(0);
  await expect(detail).not.toContainText("You can change your answer");
  await ctx.close();
  await a.ctx.close();
});

// The positive control for everything above: a scoring challenge on the same
// event keeps its difficulty, attempt count and rating, and its congratulations.
test("a scoring challenge keeps the chip, the stars and the congratulations; qualifying ones come last, in the fixed order", async ({ browser }) => {
  const a = await superCtx(browser);
  const req = a.page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const name = `Order UI ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  const task = await makeTask(req, await csrf(), "scoring", { correct_answer: "right" });
  await assignTask(req, await csrf(), task.id, [compId]);
  const p = await makeParticipant(req, await csrf(), "orderui");
  await enrol(req, await csrf(), compId, [p.id]);
  await a.ctx.close();

  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await loginViaApi(page, p.email);
  await page.goto(`${BASE}/`);
  await expect(page.locator(".task-card").first()).toBeVisible();
  const titles = await page.locator(".task-card h3").allInnerTexts();
  expect(titles.map(t => t.trim()), "scoring first, then developers, scanner, evaluating, follow-up").toEqual([
    task.title, "How many developers are in your organisation?", "Are you using a code security scanner today?",
    "Are you evaluating an AppSec solution?", "Would you like someone to follow up with you?",
  ]);
  const numbers = await page.locator(".task-card .tc-num").allInnerTexts();
  expect(numbers).toEqual(["1.01", "4.01", "4.02", "4.03", "4.04"]);

  const card = page.locator(".task-card", { hasText: task.title });
  await expect(card.locator(".badge.easy")).toHaveCount(1);
  await expect(card.locator(".pts")).toHaveText("+50 pts");
  await page.locator('#diff-filters .filter-btn', { hasText: /Easy/ }).click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  await page.locator('#diff-filters .filter-btn', { hasText: /^All$/ }).click();
  await card.locator(".card-open").click();
  const detail = page.locator("#task-detail-card");
  await expect(detail.locator(".badge.easy")).toHaveCount(1);
  await expect(detail.locator(".attempts-count")).toHaveCount(1);
  await expect(detail.locator(".qa-rate")).toHaveCount(1);
  // The play bar's position agrees with the list: the first of five.
  await expect(page.locator("#qa-stats")).toContainText("1 / 5");
  await page.locator("#ans-text").fill("right");
  await page.locator('[data-action="task-submit-answer"]').click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const dlg = page.locator(".ha-win");
  await expect(dlg.locator("#ha-win-h")).toHaveText("Challenge Solved!");
  await expect(dlg).toContainText("Correct");
  await expect(dlg).toContainText("+50");
  await ctx.close();
});

// A phone at a booth: the tap card, one tap, the same thank-you.
test.describe("on a phone at a Booth Event", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("a pick-one question is the tap card: large tiles, one tap answers, no confirm", async ({ browser }) => {
    const a = await superCtx(browser);
    const req = a.page.request;
    const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
    const name = `Tap UI ${Date.now()}`;
    const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const p = await makeParticipant(req, await csrf(), "tapui");
    await enrol(req, await csrf(), compId, [p.id]);
    await a.ctx.close();

    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginViaApi(page, p.email);
    await page.goto(`${BASE}/`);
    await page.locator(".task-card", { hasText: "How many developers" }).locator(".card-open").click();
    const tiles = page.locator(".mcf-options .mcf-tile");
    await expect(tiles).toHaveCount(4);
    // The author's order, ordered buckets, never shuffled.
    await expect(tiles.nth(0)).toContainText("1–49");
    await expect(tiles.nth(3)).toContainText("1000+");
    const box = await tiles.nth(0).boundingBox();
    expect(box.height, "a large tap target").toBeGreaterThanOrEqual(44);
    const bar = await page.locator(".mcf-bar").innerText();
    expect(bar).toContain("Quick question");
    expect(bar).not.toMatch(/easy|pts/i);
    await expect(page.locator("#mcf-howto")).toHaveText("Tap your answer.");
    const sent = page.waitForResponse(r => /\/submit$/.test(r.url()));
    await tiles.nth(3).click();
    expect((await sent).ok(), "one tap sends it").toBeTruthy();
    await expect(page.locator("#modal-overlay.open"), "no penalty confirm").toHaveCount(0);
    const dlg = page.locator(".ha-win");
    await expect(dlg.locator("#ha-win-h")).toHaveText("Thanks, noted");
    expect(await dlg.innerText()).not.toMatch(/correct|solved|\bpts\b|score/i);
    await dlg.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("#tasks-page")).toBeVisible();
    await ctx.close();
  });

  // Operator ruling 395: the one tap is not final — Change answer brings the tap
  // card back, naming the current pick, and one tap changes it.
  test("Change answer brings the tap card back, naming the current pick; one tap changes it", async ({ browser }) => {
    const a = await superCtx(browser);
    const req = a.page.request;
    const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
    const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name: `Tap change ${Date.now()}`, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const p = await makeParticipant(req, await csrf(), "tapchange");
    await enrol(req, await csrf(), compId, [p.id]);

    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginViaApi(page, p.email);
    await page.goto(`${BASE}/`);
    const card = page.locator(".task-card", { hasText: "follow up" });
    await card.locator(".card-open").click();
    const tiles = page.locator(".mcf-options .mcf-tile");
    await expect(tiles).toHaveCount(2);
    let sent = page.waitForResponse(r => /\/submit$/.test(r.url()));
    await tiles.nth(1).click();   // "No"
    expect((await sent).ok()).toBeTruthy();
    await page.locator(".ha-win").getByRole("button", { name: "Continue" }).click();
    await page.locator('#solve-filters .filter-btn', { hasText: /^All$/ }).click();
    await card.locator(".card-open").click();
    // Answered: the review card (never the tap card), with the offer.
    await expect(page.locator(".mcf-options .mcf-tile")).toHaveCount(0);
    await page.locator("#task-detail-card").getByRole("button", { name: "Change answer" }).click();
    await expect(tiles).toHaveCount(2);
    await expect(page.locator("#mcf-howto")).toHaveText("Your answer now: B. Tap another to change it, or go back to keep it.");
    sent = page.waitForResponse(r => /\/submit$/.test(r.url()));
    await tiles.nth(0).click();   // "Yes"
    const r = await sent;
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).qualifying).toBe(true);
    await expect(page.locator("#modal-overlay.open"), "still no confirm").toHaveCount(0);
    await page.locator(".ha-win").getByRole("button", { name: "Continue" }).click();
    await card.locator(".card-open").click();
    await expect(page.locator("#choice-review .choice-review-row.is-picked")).toContainText("Yes");
    const rep = await (await req.get(`${BASE}/api/admin/competitions/${compId}/team-report`)).json();
    const lead = rep.leads.find(l => l.user_id === p.id);
    expect([lead.answers.follow_up, lead.signal], "the report reads the new pick").toEqual(["Yes", "hot"]);
    await ctx.close();
    await a.ctx.close();
  });
});

// THE PERSONA PANELS: the segmented control is the app's, the two cards line up,
// each segment shows its own panel, and the bars are drawn to scale.
test("the persona switch is a real segmented control and every view is its own designed panel", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } });
  const name = `Panels UI ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  const big = await makeParticipant(req, await csrf(), "panelbig");
  const small = await makeParticipant(req, await csrf(), "panelsmall");
  const small2 = await makeParticipant(req, await csrf(), "panelsmall2");
  await enrol(req, await csrf(), compId, [big.id, small.id, small2.id]);
  for (const [role, n, e] of [["sdr", "Noor Report", "noor@corp.example"], ["marketing", "Sara Report", "sara@corp.example"]]) {
    const r = await req.post(`${BASE}/api/admin/competitions/${compId}/team`, { data: { role, name: n, email: e }, headers: { "x-csrf-token": await csrf() } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  // Three answers to the developers question: two say 1–49, one 1000+.
  for (const [p, opt] of [[big, "1000+"], [small, "1–49"], [small2, "1–49"]]) {
    const pctx = await browser.newContext({ baseURL: BASE });
    const pg = await pctx.newPage();
    await loginViaApi(pg, p.email);
    await pg.goto(`${BASE}/`);
    await pg.locator(".task-card", { hasText: "How many developers" }).locator(".card-open").click();
    await pg.locator(".choice-option", { hasText: opt }).click();
    const sent = pg.waitForResponse(r => /\/submit$/.test(r.url()));
    await pg.locator('[data-action="task-submit-answer"][data-mode="pickone"]').click();
    expect((await sent).ok()).toBeTruthy();
    // One person asks for a follow-up, so exactly one lead is hot.
    if (p === big) {
      await pg.locator(".ha-win button").click();
      await pg.locator(".task-card", { hasText: "follow up" }).locator(".card-open").click();
      await pg.locator(".choice-option", { hasText: "Yes" }).click();
      const again = pg.waitForResponse(r => /\/submit$/.test(r.url()));
      await pg.locator('[data-action="task-submit-answer"][data-mode="pickone"]').click();
      expect((await again).ok()).toBeTruthy();
    }
    await pctx.close();
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/`);
  await viewComp(page, name);
  await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
  await expect(page.locator("#team-members-h")).toBeVisible();
  await expect(page.locator("#team-persona-view")).toBeVisible();

  // The two cards line up at the top.
  const cards = page.locator("#ws-team .team-grid > .card");
  const [c1, c2] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
  expect(Math.abs(c1.y - c2.y), "the Targets card's top meets the Event team card's").toBeLessThanOrEqual(1);

  // The segmented control: the app's, separated, 44 px, aria-pressed follows.
  const seg = page.locator("#ws-team .ha-seg.team-personas");
  await expect(seg).toBeVisible();
  const btns = seg.locator("button");
  await expect(btns).toHaveCount(5);
  const geo = await btns.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { h: r.height, l: r.left, ri: r.right, pad: getComputedStyle(el).paddingLeft }; }));
  for (const g of geo) { expect(g.h).toBeGreaterThanOrEqual(44); expect(parseFloat(g.pad)).toBeGreaterThan(0); }
  for (let i = 1; i < geo.length; i++) expect(geo[i].l, "segments do not run together").toBeGreaterThanOrEqual(geo[i - 1].ri);

  const view = page.locator("#team-persona-view");
  const seen = {};
  for (const [persona, marker] of [["se", "Every challenge"], ["marketing", "Qualifying answers"], ["sales", "Accounts, most ready first"], ["sdr", "Noor Report"], ["manager", "Hot still to contact"]]) {
    const b = page.locator(`[data-action="team-persona"][data-persona="${persona}"]`);
    await b.click();
    await expect(page.locator(`[data-action="team-persona"][data-persona="${persona}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('#ws-team .team-personas button[aria-pressed="true"]')).toHaveCount(1);
    await expect(view).toContainText(marker);
    seen[persona] = await view.innerText();
  }
  expect(new Set(Object.values(seen)).size, "five different panels").toBe(5);

  // An SDR's cards come hot first, as in the email, and carry the opener.
  await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
  await expect(view.locator(".team-lead")).toHaveCount(3);
  await expect(view.locator(".team-lead").first().locator(".team-pill.is-hot")).toHaveCount(1);
  await expect(view.locator(".team-lead").first()).toContainText("You asked us to follow up");

  // Marketing's panel: figures as tiles, pills on the lead table, bars to scale.
  await page.locator('[data-action="team-persona"][data-persona="marketing"]').click();
  await expect(view.locator(".team-kpis .ws-kpi").first()).toBeVisible();
  expect(await view.locator(".team-pill.is-warm, .team-pill.is-cold").count()).toBeGreaterThan(0);
  expect(await view.locator(".team-pill.is-new").count()).toBeGreaterThan(0);
  const bars = view.locator('[data-question="developers"] .team-bar');
  await expect(bars).toHaveCount(4);
  const measure = await bars.evaluateAll(els => els.map(el => ({
    n: Number(el.dataset.count), track: el.querySelector(".team-bar-track").getBoundingClientRect().width,
    fill: el.querySelector(".team-bar-fill").getBoundingClientRect().width,
  })));
  expect(measure.map(m => m.n)).toEqual([2, 0, 0, 1]);
  expect(measure[0].fill / measure[0].track, "2 of 3").toBeCloseTo(2 / 3, 1);
  expect(measure[3].fill / measure[3].track, "1 of 3").toBeCloseTo(1 / 3, 1);
  expect(measure[1].fill).toBe(0);
  // The questions lead with the developers question.
  await expect(view.locator(".team-bars").first()).toHaveAttribute("data-question", "developers");
  // The lead list's heading stands clear of what precedes it.
  const head = await view.locator(".team-subhead", { hasText: "Lead list" }).boundingBox();
  const before = await view.locator(".team-bars-grid").boundingBox();
  expect(head.y - (before.y + before.height), "the heading has room above it").toBeGreaterThanOrEqual(16);
  await ctx.close();
});

// ── Operator rulings of 14 Nov 2026 on the persona views ────────────────────

/** An address opted out of our email, as the unsubscribe link records it. */
function optOut(email) {
  const db = new Database(TEST_DB_PATH);
  try { db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(email.toLowerCase(), new Date().toISOString()); } finally { db.close(); }
}

/** A participant's own answer to the follow-up question ("Yes" makes the lead hot). */
async function answerFollowUp(email, compId, optionText) {
  const p = await apiLogin(email);
  try {
    const sel = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: compId } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    const list = await (await p.api.get("/api/tasks", { headers: { "x-competition-id": compId } })).json();
    const q = list.find(t => /follow up/i.test(t.title));
    expect(q, "PRECONDITION: the event asks the follow-up question").toBeTruthy();
    const t = await (await p.api.get(`/api/tasks/${q.id}`, { headers: { "x-competition-id": compId } })).json();
    const opt = (t.choices || []).find(c => c.text === optionText);
    expect(opt, `PRECONDITION: an option "${optionText}"`).toBeTruthy();
    const r = await p.api.post(`/api/tasks/${q.id}/submit`, { headers: { ...H(p.csrf), "x-competition-id": compId }, data: { answer: JSON.stringify([opt.id]), gradingHash: t.grading_hash } });
    expect(r.ok(), `answer: ${await r.text()}`).toBeTruthy();
  } finally { await p.api.dispose(); }
}

// ONE MEANING OF "WAITING": the SDR's tile and the Managers' row count only the
// hot leads somebody may still reach (lib/event-team.js `isContactable`, the
// 48-hour reminder's), read per lead from the server, and the contacted mark
// moves the tile by the server's answer, in place.
test("the SDR's 'Hot still to contact' tile and the Managers' row count only leads who can be contacted, and the contacted mark moves the tile by the server's verdict (a hot lead who opted out stays out, unticked; CONTROL: a reachable one counts)", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  expect((await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  try {
    const name = `Waiting UI ${Date.now()}`;
    const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const reach = await makeParticipant(req, await csrf(), "waitin");
    const gone = await makeParticipant(req, await csrf(), "waitout");
    await enrol(req, await csrf(), compId, [reach.id, gone.id]);
    for (const p of [reach, gone]) await answerFollowUp(p.email, compId, "Yes");
    optOut(gone.email);
    // One SDR owns every lead.
    const sid = await req.post(`${BASE}/api/admin/competitions/${compId}/team`, { data: { role: "sdr", name: "Sid Waiting", email: `sid-${Date.now()}@corp.example` }, headers: { "x-csrf-token": await csrf() } });
    expect(sid.ok(), await sid.text()).toBeTruthy();
    const rep = await (await req.get(`${BASE}/api/admin/competitions/${compId}/team-report`)).json();
    const by = Object.fromEntries(rep.leads.map(l => [l.user_id, l]));
    expect([reach, gone].map(p => [by[p.id].signal, by[p.id].opted_out, by[p.id].contactable]), "PRECONDITION: two hot leads, the server's verdict on each").toEqual([["hot", false, true], ["hot", true, false]]);

    await page.goto(`${BASE}/`);
    await viewComp(page, name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
    await expect(page.locator("#team-members-h")).toBeVisible();
    const view = page.locator("#team-persona-view");
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    await expect(view).toHaveAttribute("data-persona", "sdr");
    const tile = view.locator('section.team-owner [data-kpi="hot-to-contact"]');
    await expect(tile.locator(".eyebrow")).toHaveText("Hot still to contact");
    await expect(tile.locator(".ws-kpi-num"), "the hot lead who opted out is not waiting").toHaveText("1");
    await expect(view.locator("section.team-owner .ws-kpi").nth(1).locator(".eyebrow"), "PRECONDITION: the Hot tile beside it").toHaveText("Hot");
    await expect(view.locator("section.team-owner .ws-kpi").nth(1).locator(".ws-kpi-num"), "…counts both").toHaveText("2");
    await expect(view, "the old label").not.toContainText("Hot not contacted");

    // The mark: the tile follows the server's answer, repainted in place.
    const boxOf = (p) => view.locator(`[data-change-action="team-contacted"][data-user-id="${p.id}"]`);
    const mark = async (p, on) => {
      const saved = page.waitForResponse(r => r.url().endsWith(`/leads/${p.id}/contacted`) && r.request().method() === "POST");
      if (on) await boxOf(p).check(); else await boxOf(p).uncheck();
      const r = await saved;
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).contactable;
    };
    expect(await mark(reach, true), "the server's verdict: marked").toBe(false);
    await expect(tile.locator(".ws-kpi-num"), "the reachable lead marked: nobody waits").toHaveText("0");
    expect(await page.evaluate(() => document.activeElement && document.activeElement.dataset.userId), "the box just pressed keeps its focus").toBe(reach.id);
    expect(await mark(gone, true)).toBe(false);
    expect(await mark(gone, false), "unticked, but opted out").toBe(false);
    // The count is redrawn from every lead's verdict, so this one also holds the
    // one who opted out: had the page taken an unticked box for "to contact", it
    // would read 2.
    expect(await mark(reach, false), "CONTROL: unticked and reachable").toBe(true);
    await expect(tile.locator(".ws-kpi-num"), "CONTROL: the reachable lead counts again, the one who opted out still does not").toHaveText("1");

    // The Managers' row: the same count, the same words, and the email's own call to action.
    await page.locator('[data-action="team-persona"][data-persona="manager"]').click();
    await expect(view).toHaveAttribute("data-persona", "manager");
    const row = view.locator("table.team-scorecard tbody tr", { hasText: "Hot still to contact" });
    await expect(row.locator("td").nth(0)).toHaveText("Hot still to contact");
    await expect(row.locator("td").nth(2), "the hot lead who opted out is not waiting").toHaveText("1");
    await expect(row.locator("td").nth(4)).toHaveText("Pending");
    await expect(view, "the old label").not.toContainText("Hot not yet contacted");
    await expect(view.locator(".team-focus")).toHaveText("Every hot lead still to contact has an owner. 1 is still waiting to be contacted.");
    // The reachable one marked: nothing waits, though the one who opted out was never marked.
    const m = await req.post(`${BASE}/api/admin/competitions/${compId}/leads/${reach.id}/contacted`, { data: { contacted: true }, headers: { "x-csrf-token": await csrf() } });
    expect(m.ok(), await m.text()).toBeTruthy();
    await page.evaluate(() => window.loadEventTeam());
    await expect(view.locator(".team-focus")).toHaveText("Nothing is stuck. No hot lead is waiting to be contacted.");
    await expect(row.locator("td").nth(2)).toHaveText("0");
    await expect(row.locator("td").nth(4)).toHaveText("Done");
  } finally {
    const r = await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: [] }, headers: { "x-csrf-token": await csrf() } });
    expect.soft(r.ok(), "the domain list back to its default").toBeTruthy();
    await ctx.close();
  }
});

// NEVER A COPY: the counts are the server's verdict per lead. A verdict the
// server's answer carries that the page could not have worked out from the lead
// (an answer changed on its way) is what the tile and the row show; a page
// counting by its own reading of the lead would show the other figure.
test("the persona views count by the server's verdict per lead, never their own reading of it: the report read's and the contacted mark's answer are followed", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  expect((await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  try {
    const name = `Verdict UI ${Date.now()}`;
    const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const p = await makeParticipant(req, await csrf(), "verdictui");
    await enrol(req, await csrf(), compId, [p.id]);
    await answerFollowUp(p.email, compId, "Yes");
    expect((await req.post(`${BASE}/api/admin/competitions/${compId}/team`, { data: { role: "sdr", name: "Sid Verdict", email: `sidv-${Date.now()}@corp.example` }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
    const real = (await (await req.get(`${BASE}/api/admin/competitions/${compId}/team-report`)).json()).leads.find(l => l.user_id === p.id);
    expect([real.signal, !!real.contacted_at, real.opted_out, real.contactable], "PRECONDITION: hot, not marked, not opted out: the server says reachable").toEqual(["hot", false, false, true]);
    // The report read's verdict, changed on its way: not to contact.
    const reportUrl = `**/api/admin/competitions/${compId}/team-report`;
    await page.route(reportUrl, async (route) => {
      const res = await route.fetch();
      const d = await res.json();
      for (const l of d.leads) if (l.user_id === p.id) l.contactable = false;
      await route.fulfill({ response: res, json: d });
    });
    await page.goto(`${BASE}/`);
    await viewComp(page, name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
    const view = page.locator("#team-persona-view");
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    await expect(view).toHaveAttribute("data-persona", "sdr");
    const tile = view.locator('section.team-owner [data-kpi="hot-to-contact"] .ws-kpi-num');
    await expect(view.locator("section.team-owner .ws-kpi").nth(1).locator(".ws-kpi-num"), "PRECONDITION: the lead is drawn, hot").toHaveText("1");
    await expect(tile, "the server's verdict, not the page's own reading of the lead").toHaveText("0");
    await page.locator('[data-action="team-persona"][data-persona="manager"]').click();
    const row = view.locator("table.team-scorecard tbody tr", { hasText: "Hot still to contact" });
    await expect(row.locator("td").nth(2), "…in the Managers' row too").toHaveText("0");
    await page.unroute(reportUrl);
    // The contacted mark's answer, changed on its way: still to contact after the mark.
    const markUrl = `**/api/admin/competitions/${compId}/leads/${p.id}/contacted`;
    const ownAnswers = [];
    await page.route(markUrl, async (route) => {
      const res = await route.fetch();
      const d = await res.json();
      ownAnswers.push(d.contactable);
      await route.fulfill({ response: res, json: { ...d, contactable: true } });
    });
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    await expect(tile).toHaveText("0");
    const saved = page.waitForResponse(r => r.url().endsWith(`/leads/${p.id}/contacted`) && r.request().method() === "POST");
    await view.locator(`[data-change-action="team-contacted"][data-user-id="${p.id}"]`).check();
    expect((await saved).ok()).toBeTruthy();
    expect(ownAnswers, "PRECONDITION: the server's own answer was: marked, so not to contact").toEqual([false]);
    await expect(tile, "the answer's verdict, not one worked out from the box").toHaveText("1");
    await page.unroute(markUrl);
  } finally {
    const r = await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: [] }, headers: { "x-csrf-token": await csrf() } });
    expect.soft(r.ok(), "the domain list back to its default").toBeTruthy();
    await ctx.close();
  }
});

// SAID ONCE: the email's intro says nobody has taken part; the in-app view has
// no intro, so its call to action must make sense alone without repeating it.
test("Marketing's view with nobody taking part: its call to action reads alone, and nothing says no leads twice (CONTROL: with a lead, the file's words and the list)", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  const name = `No leads UI ${Date.now()}`;
  const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
  expect(cr.ok(), await cr.text()).toBeTruthy();
  const compId = (await cr.json()).competition.id;
  expect((await (await req.get(`${BASE}/api/admin/competitions/${compId}/team-report`)).json()).leads, "PRECONDITION: nobody has taken part").toEqual([]);
  await page.goto(`${BASE}/`);
  await viewComp(page, name);
  await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
  await expect(page.locator("#team-members-h")).toBeVisible();
  const view = page.locator("#team-persona-view");
  await page.locator('[data-action="team-persona"][data-persona="marketing"]').click();
  await expect(view).toHaveAttribute("data-persona", "marketing");
  await expect(view.locator(".team-focus")).toHaveText("No leads yet. The list fills as people take part.");
  await expect(view, "the old reason").not.toContainText("Nobody has taken part");
  // …and the empty lead list draws no second "No leads yet." under it.
  expect(await view.evaluate((el) => (el.textContent.match(/No leads yet\./g) || []).length),
    "the view says 'No leads yet.' once").toBe(1);
  // CONTROL: one person in the event.
  const p = await makeParticipant(req, await csrf(), "noleadsui");
  await enrol(req, await csrf(), compId, [p.id]);
  await page.evaluate(() => window.loadEventTeam());
  await expect(view.locator(".team-focus")).toHaveText("Load 1 lead into the CRM today. The file is attached, one row per person.");
  await expect(view).not.toContainText("The list fills as people take part.");
  await expect(view.locator('table[data-tcols="team-leads"]'), "with a lead, the lead list is drawn").toBeVisible();
  await ctx.close();
});

// ONE ANSWER, ONE REPORT: the contacted mark's answer updates only the report
// it was sent against. The same person can be a hot lead in two events, so an
// answer for one that lands after the organiser opened the other must move
// neither the other event's tile nor its lead (CONTROL: the same held answer,
// released with its own event still open, is applied).
test("the contacted mark's answer updates only the event it was sent for: held while another event's Team & reports opens, it moves neither that event's tile nor its lead (CONTROL: released on its own event, it applies)", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  expect((await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  try {
    // Two Booth Events, the same person a hot lead in both, an SDR in each.
    const at = Date.now();
    const ev = {};
    for (const k of ["A", "B"]) {
      const name = `One answer ${k} ${at}`;
      const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      ev[k] = { name, id: (await cr.json()).competition.id, sdr: `Sid ${k}${k}` };
    }
    const p = await makeParticipant(req, await csrf(), "oneanswer");
    for (const k of ["A", "B"]) {
      await enrol(req, await csrf(), ev[k].id, [p.id]);
      await answerFollowUp(p.email, ev[k].id, "Yes");
      const sid = await req.post(`${BASE}/api/admin/competitions/${ev[k].id}/team`, { data: { role: "sdr", name: ev[k].sdr, email: `sid${k.toLowerCase()}-${at}@corp.example` }, headers: { "x-csrf-token": await csrf() } });
      expect(sid.ok(), await sid.text()).toBeTruthy();
    }
    const leadIn = async (k) => (await (await req.get(`${BASE}/api/admin/competitions/${ev[k].id}/team-report`)).json()).leads.find(l => l.user_id === p.id);
    for (const k of ["A", "B"]) {
      const l = await leadIn(k);
      expect([l.signal, !!l.contacted_at, l.contactable], `PRECONDITION: in ${k}, a hot lead still to contact`).toEqual(["hot", false, true]);
    }

    await page.goto(`${BASE}/`);
    await viewComp(page, ev.A.name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
    await expect(page.locator("#team-members-h")).toBeVisible();
    const view = page.locator("#team-persona-view");
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    await expect(view).toHaveAttribute("data-persona", "sdr");
    const tile = view.locator('section.team-owner [data-kpi="hot-to-contact"] .ws-kpi-num');
    const box = view.locator(`[data-change-action="team-contacted"][data-user-id="${p.id}"]`);
    // Which event's view is on screen, by its SDR's name.
    const shows = async (k) => {
      await expect(view).toContainText(ev[k].sdr);
      await expect(view).not.toContainText(ev[k === "A" ? "B" : "A"].sdr);
    };
    await shows("A");
    await expect(tile).toHaveText("1");
    // The witness that the page has handled an answer to this person's mark: its
    // own read of the body, then one task later, when every step after that
    // read has run.
    await page.evaluate((frag) => {
      const prev = window.fetch;
      window.__markAnswers = 0;
      window.fetch = function (input) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const sent = prev.apply(this, arguments);
        if (!url.includes(frag)) return sent;
        return sent.then((res) => {
          if (res) { const json = res.json.bind(res); res.json = () => json().finally(() => setTimeout(() => { window.__markAnswers++; }, 0)); }
          return res;
        });
      };
    }, `/leads/${p.id}/contacted`);
    const answers = () => page.evaluate(() => window.__markAnswers);
    // Holds the next mark of this person in event `k` until released.
    const holdNext = async (k) => {
      let arrived, release;
      const reached = new Promise(r => { arrived = r; });
      const go = new Promise(r => { release = r; });
      await page.route(`**/api/admin/competitions/${ev[k].id}/leads/${p.id}/contacted`, async (route) => { arrived(); await go; await route.continue(); }, { times: 1 });
      return { reached, release: () => release() };
    };

    // CONTROL: held, then released with A still open: the answer applies.
    let held = await holdNext("A");
    let n = await answers();
    await box.check();
    await held.reached;
    held.release();
    await expect.poll(answers, "the page handled the answer").toBe(n + 1);
    expect(await tile.textContent(), "CONTROL: the held answer, on its own event, moves the tile").toBe("0");
    // A back as it was: unticked, the person is to contact again.
    n = await answers();
    await box.uncheck();
    await expect.poll(answers).toBe(n + 1);
    await expect(tile).toHaveText("1");

    // Held while B's Team & reports opens: B is left as its own read drew it.
    held = await holdNext("A");
    n = await answers();
    await box.check();
    await held.reached;
    await page.evaluate((id) => window.openEventWorkspace(id, "", { tab: "admin-event-team-tab" }), ev.B.id);
    await expect(view).toHaveAttribute("data-persona", "sdr");
    await shows("B");
    await expect(tile, "PRECONDITION: in B, the person is still to contact").toHaveText("1");
    await expect(box, "PRECONDITION: B's box is not ticked").not.toBeChecked();
    held.release();
    await expect.poll(answers, "the page handled A's answer while B was open").toBe(n + 1);
    expect([await tile.textContent(), await box.isChecked()], "B's tile and box, after A's answer").toEqual(["1", false]);
    // B's own report too: the view drawn again from it still has the person to contact.
    await page.locator('[data-action="team-persona"][data-persona="manager"]').click();
    await expect(view).toHaveAttribute("data-persona", "manager");
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    await expect(view).toHaveAttribute("data-persona", "sdr");
    await shows("B");
    expect([await tile.textContent(), await box.isChecked()], "B drawn again from its own report").toEqual(["1", false]);
    // CONTROL: the mark landed on A, and only there.
    expect(await leadIn("B"), "B, on the server").toMatchObject({ contacted_at: null, contactable: true });
    const a = await leadIn("A");
    expect([!!a.contacted_at, a.contactable], "A, on the server").toEqual([true, false]);
    await page.evaluate((id) => window.openEventWorkspace(id, "", { tab: "admin-event-team-tab" }), ev.A.id);
    await shows("A");
    await expect(tile, "A, read again: nobody left to contact").toHaveText("0");
    await expect(box).toBeChecked();
  } finally {
    const r = await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: [] }, headers: { "x-csrf-token": await csrf() } });
    expect.soft(r.ok(), "the domain list back to its default").toBeTruthy();
    await ctx.close();
  }
});

// Sweep #311 — a sort chosen on a page-only list (the event team's members) can
// be cleared, putting the rows back in the order they were drawn in; ties keep
// that order whatever sorted before; and the list drawn for ANOTHER event starts
// unsorted (CONTROL: reopening the same event keeps its sort).
test("sweep #311: an event team list's sort clears back to the drawn order, ties keep it, and another event's list starts unsorted", async ({ browser }) => {
  const { ctx, page } = await superCtx(browser);
  const req = page.request;
  const csrf = async () => (await (await req.get(`${BASE}/api/csrf-token`)).json()).csrfToken;
  expect((await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: ["corp.example"] }, headers: { "x-csrf-token": await csrf() } })).ok()).toBeTruthy();
  try {
    const at = Date.now();
    const ev = {};
    for (const k of ["A", "B"]) {
      const name = `Sort clear ${k} ${at}`;
      const cr = await req.post(`${BASE}/api/admin/competitions`, { data: { name, event_kind: "booth", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" }, headers: { "x-csrf-token": await csrf() } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      ev[k] = { name, id: (await cr.json()).competition.id };
      // Drawn in the order added: Zed, Amy, Mia.
      for (const [who, role] of [["Zed", "sdr"], ["Amy", "se"], ["Mia", "sdr"]]) {
        const r = await req.post(`${BASE}/api/admin/competitions/${ev[k].id}/team`, { data: { role, name: `${who} ${k}`, email: `${who.toLowerCase()}${k.toLowerCase()}-${at}@corp.example` }, headers: { "x-csrf-token": await csrf() } });
        expect(r.ok(), await r.text()).toBeTruthy();
      }
    }
    const names = () => page.locator("table[data-tcols='team-members'] tbody td.cell-stack strong").allInnerTexts();
    const head = (col) => page.locator(`table[data-tcols='team-members'] th[data-tcol-dsort='${col}']`);
    const clear = page.locator(".tcol-bar[data-tcols-for='team-members'] .tcol-clear");
    const openTeam = async (k) => {
      await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-event-team-tab" }), { id: ev[k].id, n: ev[k].name });
      await expect(page.locator("#team-members-h")).toBeVisible({ timeout: 10000 });
      await expect.poll(names, { timeout: 10000 }).toHaveLength(3);
    };
    await page.goto(`${BASE}/`);
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await expect.poll(() => page.evaluate((ids) => ids.every(id => (window.adminCompetitionsData || []).some(c => c.id === id)), [ev.A.id, ev.B.id]), { timeout: 15000 }).toBe(true);
    await openTeam("A");
    expect(await names(), "CONTROL: the drawn order").toEqual(["Zed A", "Amy A", "Mia A"]);
    await expect(head("member")).toHaveAttribute("aria-sort", "none");
    await expect(clear, "nothing to clear").toBeHidden();
    await head("member").click({ position: { x: 8, y: 10 } });
    await expect.poll(names).toEqual(["Amy A", "Mia A", "Zed A"]);
    await expect(head("member")).toHaveAttribute("aria-sort", "ascending");
    await expect(clear).toBeVisible();
    await expect(clear).toHaveText("Clear sort");
    // By Role: the two SDRs keep their DRAWN order (Zed before Mia), not the
    // order the Member sort left them in.
    await head("role").click({ position: { x: 8, y: 10 } });
    await expect.poll(names, { message: "ties keep the drawn order" }).toEqual(["Zed A", "Mia A", "Amy A"]);
    // Another event's list starts unsorted.
    await openTeam("B");
    expect(await names(), "B is drawn in its own order, unsorted").toEqual(["Zed B", "Amy B", "Mia B"]);
    await expect(head("role")).toHaveAttribute("aria-sort", "none");
    await expect(clear).toBeHidden();
    // Sorted, then cleared: back to the drawn order.
    await head("member").click({ position: { x: 8, y: 10 } });
    await expect.poll(names).toEqual(["Amy B", "Mia B", "Zed B"]);
    await clear.click();
    await expect.poll(names, { message: "the drawn order again" }).toEqual(["Zed B", "Amy B", "Mia B"]);
    await expect(head("member")).toHaveAttribute("aria-sort", "none");
    await expect(clear).toBeHidden();
    // CONTROL: the same event drawn again keeps its sort. The list on screen is
    // marked first, so the order is read only once it has been drawn anew.
    await head("member").click({ position: { x: 8, y: 10 } });
    await expect.poll(names).toEqual(["Amy B", "Mia B", "Zed B"]);
    await page.evaluate(() => { document.querySelector("table[data-tcols='team-members']").dataset.stale = "1"; });
    await openTeam("B");
    await expect.poll(() => page.evaluate(() => !!document.querySelector("table[data-tcols='team-members']") && !document.querySelector("table[data-tcols='team-members'][data-stale]")),
      { timeout: 10000, message: "PRECONDITION: the list was drawn again" }).toBe(true);
    expect(await names(), "reopening the same event keeps its sort").toEqual(["Amy B", "Mia B", "Zed B"]);
    await expect(head("member")).toHaveAttribute("aria-sort", "ascending");
  } finally {
    const r = await req.put(`${BASE}/api/admin/team-report-domains`, { data: { domains: [] }, headers: { "x-csrf-token": await csrf() } });
    expect.soft(r.ok(), "the domain list back to its default").toBeTruthy();
    await ctx.close();
  }
});
