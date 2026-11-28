"use strict";

// DOORS THAT NO SPEC PRESSED — each is pressed here through its real control,
// its effect is read back from the server, and where a refusal is cheap to
// provoke the refusal is shown to the person ("every mutation reports its
// refusal"):
//
//   * Team & reports: Save targets (and a refused value), Download leads CSV,
//     Preview email pressed twice (the later press wins and keeps the dialog's
//     full width), Send now (its outcome, then a refusal once the domain is no
//     longer allowed), Remove (and a refused removal);
//   * looks: an event's Save look, the platform's Apply to everyone now, the
//     Appearance page's organisation default;
//   * templates: Restore built-in templates;
//   * an event's sessions: Add session, edit, delete, and a live session's
//     End now;
//   * an ended event's Top 3 button reports that no certificate is issued yet.
//
// Global settings written here (allowed domains, the platform look) go back to
// their defaults in a finally. Every request goes through the browser's own
// superadmin session: the built-in account has one session at a time, so a
// separate API sign-in would end the browser's (and the browser's sign-in the
// API's).

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH } = require("./helpers");
const { adminLogin, viewComp, openSettingsSection, filterComps, clickTab } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const { openAppearance } = require("./chrome-helpers");
const Database = require("better-sqlite3");
const fs = require("fs");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const toasts = (page) => page.locator("#toast-stack");
const DEFAULT_LOOK = { look: "", mode: "", ambient: "", lock: false };

/** Sign the browser in as the superadmin; its session also makes the fixtures. */
async function signedIn(page) {
  await adminLogin(page);
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  return { sa: page.request, csrf };
}

/** Open an event's workspace on one of its sections (from the Events list,
 *  which the sidebar's Events shows, leaving any workspace already open). */
async function openWorkspace(page, name) {
  await clickTab(page, "Events");
  await expect.poll(() => page.evaluate(() => window.S.adminSelectedCompetitionId), { message: "PRECONDITION: no workspace is open" }).toBeFalsy();
  await viewComp(page, name);
}
async function openSection(page, name, section) {
  await openWorkspace(page, name);
  await page.locator(`#ws-tabs [data-section="${section}"]`).click();
}

test("Team & reports: Save targets, Download leads CSV, Preview email twice, Send now and Remove each do what they say", async ({ page }) => {
  test.setTimeout(150_000);
  const { sa, csrf } = await signedIn(page);
  const dom = await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: ["doors.example"] } });
  expect(dom.ok(), await dom.text()).toBeTruthy();
  try {
    const comp = await makeCompetition(sa, csrf, "doorsteam");
    const p = await makeParticipant(sa, csrf, "doorslead");
    await enrol(sa, csrf, comp.id, [p.id]);
    const addMember = async (name) => {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { headers: H(csrf), data: { role: "sdr", name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@doors.example` } });
      expect(r.ok(), `add ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).member;
    };
    const sid = await addMember("Sid Door");
    const team = async () => (await (await sa.get(`/api/admin/competitions/${comp.id}/team`)).json());

    await openSection(page, comp.name, "admin-event-team-tab");
    await expect(page.locator("#ws-team")).toContainText("sid.door@doors.example", { timeout: 15000 });

    // ── Save targets: a refused value is reported; a good one is stored.
    await page.locator("#team-lead-target").fill("lots");
    await page.locator('[data-action="team-targets-save"]').click();
    await expect(toasts(page), "the refusal is shown").toContainText("whole number", { timeout: 10000 });
    expect((await team()).targets.lead_target ?? null, "nothing was stored").toBeNull();
    await page.locator("#team-lead-target").fill("12");
    await page.locator('[data-action="team-targets-save"]').click();
    await expect(toasts(page)).toContainText("Targets saved.", { timeout: 10000 });
    expect((await team()).targets.lead_target, "the target is stored").toBe(12);

    // ── Download leads CSV: a real file holding the lead.
    await page.locator('[data-action="team-persona"][data-persona="sdr"]').click();
    const dl = page.waitForEvent("download");
    await page.locator('[data-action="team-leads-csv"]').click();
    const file = await dl;
    expect(file.suggestedFilename(), "the file is named for the event").toMatch(/^leads-.+\.csv$/);
    const csv = fs.readFileSync(await file.path(), "utf8");
    expect(csv, "the lead is in it").toContain(p.email);

    // ── Preview email pressed twice: the first answer (arriving first) is
    // superseded, so only the second opens, at the mail's full width.
    let firstReq = null, secondAsked, firstDone;
    const secondSeen = new Promise((r) => { secondAsked = r; });
    const firstFinished = new Promise((r) => { firstDone = r; });
    page.on("requestfinished", (r) => { if (r === firstReq) firstDone(); });
    await page.route("**/team-report/preview**", async (route) => {
      if (!firstReq) { firstReq = route.request(); await secondSeen; await route.continue(); return; }
      secondAsked();
      await firstFinished;   // the FIRST answer lands before the second
      await route.continue();
    });
    const asked = [];
    page.on("request", (r) => { if (r.url().includes("/team-report/preview")) asked.push(r.url()); });
    // How many times a dialog opens: the superseded answer must paint none.
    await page.evaluate(() => {
      window.__previewOpens = 0;
      const ov = document.getElementById("modal-overlay");
      let was = ov.classList.contains("open");
      new MutationObserver(() => { const now = ov.classList.contains("open"); if (now && !was) window.__previewOpens++; was = now; }).observe(ov, { attributes: true, attributeFilter: ["class"] });
    });
    await page.locator('[data-action="team-preview"]').click();
    await expect.poll(() => asked.length, { message: "PRECONDITION: the first preview was asked" }).toBe(1);
    await page.locator('[data-action="team-preview"]').click();
    const frame = page.locator("#modal-overlay iframe.team-preview");
    await expect(frame, "the later press opens the preview").toHaveCount(1, { timeout: 10000 });
    await expect.poll(() => asked.length).toBe(2);
    await expect.poll(async () => (await frame.boundingBox())?.width || 0, { message: "at the mail's full width, not the 420 px dialog", timeout: 5000 }).toBeGreaterThanOrEqual(640);
    expect(await page.evaluate(() => window.__previewOpens), "one dialog opened: the superseded answer painted nothing").toBe(1);
    await page.unroute("**/team-report/preview**");
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
    expect(await page.evaluate(() => document.getElementById("modal-box").style.width), "the width goes back when it closes").toBe("");

    // ── Send now: the outcome is reported by its counts.
    await page.locator('[data-action="team-send"]').click();
    await expect(page.locator("#modal-overlay.open")).toContainText("Send the reports now?");
    const sent = page.waitForResponse((r) => /\/team-report\/send$/.test(r.url()));
    await page.locator("#modal-confirm-btn").click();
    const sb = await (await sent).json();
    expect(sb.sent + sb.failed + sb.refused, `the send reached the member (${JSON.stringify(sb)})`).toBe(1);
    await expect(toasts(page), "the outcome is shown").toContainText(`${sb.sent} report${sb.sent === 1 ? "" : "s"} sent`, { timeout: 10000 });
    // …and once the domain is no longer allowed, the refusal is shown.
    const off = await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: [] } });
    expect(off.ok()).toBeTruthy();
    await page.locator('[data-action="team-send"]').click();
    await expect(page.locator("#modal-overlay.open")).toContainText("Send the reports now?");
    await page.locator("#modal-confirm-btn").click();
    await expect(toasts(page), "a refused send is reported as refused").toContainText("refused (domain not allowed)", { timeout: 10000 });

    // ── Remove: works; a removal the server refuses is reported.
    await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: ["doors.example"] } });
    const gone = await addMember("Gone Door");
    await openSection(page, comp.name, "admin-event-team-tab");
    await expect(page.locator("#ws-team")).toContainText("gone.door@doors.example", { timeout: 15000 });
    const del = await sa.delete(`/api/admin/competitions/${comp.id}/team/${gone.id}`, { headers: H(csrf) });
    expect(del.ok(), "PRECONDITION: removed behind the screen's back").toBeTruthy();
    await page.locator(`[data-action="team-remove"][data-member-id="${gone.id}"]`).click();
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack .toast-error", { hasText: "Team member not found" }), "the refused removal is reported, as an error").toBeVisible({ timeout: 10000 });
    await page.locator(`[data-action="team-remove"][data-member-id="${sid.id}"]`).click();
    await expect(page.locator("#modal-overlay.open")).toContainText("Remove from the team?");
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(async () => (await team()).members.map((m) => m.id), { message: "the member is removed", timeout: 10000 }).not.toContain(sid.id);
  } finally {
    const r = await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: [] } });
    expect(r.ok(), "the allowed domains are back to their default").toBeTruthy();
  }
});

test("looks: an event's Save look, Apply to everyone now and the organisation default each store what they show", async ({ page }) => {
  test.setTimeout(120_000);
  const { sa, csrf } = await signedIn(page);
  const comp = await makeCompetition(sa, csrf, "doorslook");
  const appearance = async () => (await (await sa.get("/api/settings/appearance")).json());
  try {
    // ── The event's Save look.
    await openSection(page, comp.name, "admin-event-settings-tab");
    await page.locator("#ev-look").selectOption("signature");
    await page.locator("#ev-look-lock").check();
    await page.locator('[data-action="event-look-save"]').click();
    await expect(toasts(page)).toContainText("Event look saved.", { timeout: 10000 });
    const row = async () => (await (await sa.get("/api/admin/competitions")).json()).find((c) => c.id === comp.id);
    expect(await row(), "stored, and locked").toMatchObject({ event_look: "signature", event_look_locked: 1 });
    await page.locator("#ev-look").selectOption("");
    await page.locator('[data-action="event-look-save"]').click();
    await expect(toasts(page)).toContainText("Event look removed", { timeout: 10000 });
    expect((await row()).event_look ?? null, "removed").toBeNull();

    // ── Apply to everyone now (Settings, Look).
    const stamp0 = Number((await appearance()).platform_look.stamp) || 0;
    await page.evaluate(() => window.adminTab(null, "admin-settings-tab"));
    await openSettingsSection(page, "branding");
    await page.locator("#pl-look").selectOption("signature");
    await page.locator('[data-action="platform-look-apply"]').click();
    await expect(page.locator("#modal-overlay.open")).toContainText("Apply to everyone now?");
    await page.locator("#modal-confirm-btn").click();
    await expect(toasts(page)).toContainText("Platform look applied to everyone.", { timeout: 10000 });
    const pl = (await appearance()).platform_look;
    expect(pl.look, "the look is stored").toBe("signature");
    expect(Number(pl.stamp), "and stamped for everyone").toBeGreaterThan(stamp0);

    // ── The Appearance page's organisation default: it shows the look just
    // applied, and moving it back to Default stores that.
    await openAppearance(page);
    await expect(page.locator("#ap-org-look"), "PRECONDITION: it shows the platform look").toHaveValue("signature");
    await page.locator("#ap-org-look").selectOption("");
    await page.locator('[data-action="appearance-org-save"]').click();
    await expect(toasts(page)).toContainText("Default look saved.", { timeout: 10000 });
    expect((await appearance()).platform_look.look, "the organisation default is the platform look").toBe("");
  } finally {
    const r = await sa.put("/api/admin/platform-look", { headers: H(csrf), data: DEFAULT_LOOK });
    expect(r.ok(), `the platform look is back to its default: ${await r.text()}`).toBeTruthy();
  }
});

test("templates: Restore built-in templates brings back a missing built-in", async ({ page }) => {
  const { sa } = await signedIn(page);
  const db = new Database(TEST_DB_PATH);
  try {
    const row = db.prepare("SELECT id FROM event_templates WHERE builtin_key='learning-program-30d' OR builtin_key LIKE 'learning%' LIMIT 1").get()
      || db.prepare("SELECT id FROM event_templates WHERE builtin_key IS NOT NULL LIMIT 1").get();
    expect(row, "PRECONDITION: a built-in template exists").toBeTruthy();
    // A built-in cannot be deleted through the API; an older deletion is
    // simulated by removing the row (as tests/event-template-protection.api.spec.js does).
    db.prepare("DELETE FROM event_templates WHERE id=?").run(row.id);
  } finally { db.close(); }
  const missing = (await (await sa.get("/api/admin/event-templates/deleted")).json()).missing_builtins || [];
  expect(missing.length, "PRECONDITION: a built-in is missing").toBe(1);

  await page.evaluate(() => window.adminTab(null, "admin-templates-tab"));
  const btn = page.locator('#tpl-deleted [data-action="tpl-restore-builtins"]');
  await expect(btn).toBeVisible({ timeout: 15000 });
  await btn.click();
  await expect(toasts(page)).toContainText("Restored 1 built-in template.", { timeout: 10000 });
  expect((await (await sa.get("/api/admin/event-templates/deleted")).json()).missing_builtins || [], "nothing is missing now").toEqual([]);
  await expect(btn, "the door goes once nothing is missing").toHaveCount(0);
});

test("sessions: Add session, edit and delete an upcoming one, and End now a live one, each through the workspace", async ({ page }) => {
  test.setTimeout(150_000);
  const { sa, csrf } = await signedIn(page);
  const later = await makeCompetition(sa, csrf, "doorsslots", { start_time: new Date(Date.now() + 2 * 86400e3).toISOString() });
  const slots = async (id) => (await (await sa.get(`/api/admin/competitions/${id}/timeslots`)).json());
  const list = (d) => (Array.isArray(d) ? d : (d.timeslots || []));

  await openWorkspace(page, later.name);
  // The upcoming event's checklist offers its first session.
  const add = page.locator('#ws-ov-ready [data-action="ws-ts-add"]');
  await expect(add).toBeVisible({ timeout: 15000 });
  await add.click();
  await page.locator("#ts-name").fill("Door Morning");
  const d = new Date(Date.now() + 2 * 86400e3);
  const pad = (x) => String(x).padStart(2, "0");
  await page.locator("#ts-date").fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  await page.locator("#ts-time").fill("10:00");
  await page.locator("#ts-duration").fill("90");
  await page.locator('#ts-form-overlay [data-action="ts-save"]').click();
  await expect(toasts(page)).toContainText("Session added.", { timeout: 10000 });
  const made = list(await slots(later.id));
  expect(made.map((t) => t.name), "the session is stored").toEqual(["Door Morning"]);

  // Edit it from the Sessions card.
  const edit = page.locator(`[data-action="ws-ts-edit"][data-ts-id="${made[0].id}"]`);
  await expect(edit).toBeVisible({ timeout: 15000 });
  await edit.click();
  await page.locator("#ts-name").fill("Door Evening");
  await page.locator('#ts-form-overlay [data-action="ts-save"]').click();
  await expect(toasts(page)).toContainText("Session updated.", { timeout: 10000 });
  expect(list(await slots(later.id)).map((t) => t.name), "renamed").toEqual(["Door Evening"]);

  // Delete it.
  await page.locator(`[data-action="ws-ts-delete"][data-ts-id="${made[0].id}"]`).click();
  await expect(page.locator("#modal-overlay.open")).toContainText("Delete this session?");
  await page.locator("#modal-confirm-btn").click();
  await expect(toasts(page)).toContainText("Session deleted.", { timeout: 10000 });
  expect(list(await slots(later.id)), "gone").toEqual([]);

  // End now, on a LIVE session of a live event (through both confirms).
  const live = await makeCompetition(sa, csrf, "doorslive");
  const mk = await sa.post(`/api/admin/competitions/${live.id}/timeslots`, { headers: H(csrf), data: { name: "Door Live", start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 120 } });
  expect(mk.ok(), await mk.text()).toBeTruthy();
  const liveTs = list(await slots(live.id))[0];
  await openWorkspace(page, live.name);
  const end = page.locator(`[data-action="ts-end-now"][data-ts-id="${liveTs.id}"]`);
  await expect(end).toBeVisible({ timeout: 15000 });
  await end.click();
  await expect(page.locator("#modal-overlay.open")).toContainText("end this session?", { timeout: 5000 });
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator("#modal-title"), "the countdown runs").toContainText("Ending session", { timeout: 5000 });
  await expect(toasts(page)).toContainText(`Session "Door Live" ended.`, { timeout: 20000 });
  const after = list(await slots(live.id))[0];
  expect(after.ended_at || after.status === "ended" || Number(after.duration_minutes) < 120, `the session is ended server-side (${JSON.stringify(after)})`).toBeTruthy();
});

test("Top 3 on an ended event with no certificate issued says so, and downloads nothing", async ({ page }) => {
  const { sa, csrf } = await signedIn(page);
  const ended = await makeCompetition(sa, csrf, "doorstop3", { start_time: new Date(Date.now() - 5 * 3600e3).toISOString(), duration_minutes: 60 });
  const downloads = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await clickTab(page, "Events");
  await filterComps(page, ended.name);
  const row = page.locator("#admin-comp-body tr", { hasText: ended.name }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const top3 = row.locator('[data-action="comp-top3"]');
  await expect(top3, "PRECONDITION: an ended, ranked event offers Top 3").toBeVisible();
  const answer = page.waitForResponse((r) => r.url().includes("/certificates/top3.zip"));
  await top3.click();
  const r = await answer;
  expect(r.status(), "the server refuses: nothing is issued").toBe(409);
  const code = (await r.json()).code;
  expect(["no_placement_certificates", "certificates_being_issued"], `a known refusal (${code})`).toContain(code);
  await expect(toasts(page), "the refusal is shown").toContainText(/certificate/i, { timeout: 10000 });
  expect(downloads, "nothing was downloaded").toEqual([]);
});
