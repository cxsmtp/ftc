"use strict";

// AXE ON THE EVENT WORKSPACE AND THE SURFACES NO OTHER SCAN REACHES.
//   • the workspace's own sections — Overview (face and detail), Certificates
//     (the issued list and the designer, every panel open), Settings, Team &
//     reports (every role's view) — in every look, day and night, each scan
//     preceded by a check that the page really is in that look and mode;
//   • every Settings section (one is shown at a time, so a scan of the pane
//     reaches only the one on screen);
//   • Activity (Submissions) and the raw Logs in the dark theme (neither has a
//     sidebar item, so the per-tab dark sweep does not reach them).
// Gated on impact (AXE_GATED_IMPACTS), never on a rule list.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor, settleFiniteAnimations } = require("./helpers");
const { adminLogin, openOverviewDetail, openSettingsSection, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const STAMP = Date.now().toString(36);
const W = {};

async function solve(p, compId, taskId, ans) {
  const s = await apiLogin(p.email, PARTICIPANT_PASS);
  try {
    expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
    const r = await s.api.post(`/api/tasks/${taskId}/submit`, { headers: H(s.csrf), data: { answer: ans, gradingHash: await gradingHashFor(s.api, taskId) } });
    expect(r.ok(), await r.text()).toBeTruthy();
  } finally { await s.api.dispose(); }
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const mk = async (data) => {
      const r = await sa.post("/api/admin/competitions", { headers: H(csrf), data: { name: `A11y ${STAMP} ${Math.random().toString(36).slice(2, 7)}`, ...data } });
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).competition;
    };
    // A live Competition with activity and a session to come.
    W.live = await mk({ event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
    const t1 = await makeTask(sa, csrf, "a11y1", { correct_answer: "right" });
    const t2 = await makeTask(sa, csrf, "a11y2", { correct_answer: "right" });
    await assignTask(sa, csrf, t1.id, [W.live.id]);
    await assignTask(sa, csrf, t2.id, [W.live.id]);
    const p = await makeParticipant(sa, csrf, "a11yp");
    await enrol(sa, csrf, W.live.id, [p.id]);
    await solve(p, W.live.id, t1.id, "right");
    await solve(p, W.live.id, t2.id, "wrong");
    // An ended Competition with an issued certificate.
    W.ended = await mk({ event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
    const t3 = await makeTask(sa, csrf, "a11y3", { correct_answer: "right" });
    const t4 = await makeTask(sa, csrf, "a11y4", { correct_answer: "right" });
    await assignTask(sa, csrf, t3.id, [W.ended.id]);
    await assignTask(sa, csrf, t4.id, [W.ended.id]);
    const q = await makeParticipant(sa, csrf, "a11yq");
    await enrol(sa, csrf, W.ended.id, [q.id]);
    await solve(q, W.ended.id, t3.id, "right");
    expect((await sa.post(`/api/admin/competitions/${W.ended.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
    expect((await sa.post("/api/test/certificate-dispatch-tick", { headers: H(csrf), data: { force: true } })).ok()).toBeTruthy();
    // A live Booth Event with a team and a lead.
    expect((await sa.put("/api/admin/team-report-domains", { headers: H(csrf), data: { domains: ["corp.example"] } })).ok()).toBeTruthy();
    W.booth = await mk({ event_kind: "booth", self_enroll_enabled: true, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120 });
    for (const [role, name] of [["marketing", "Mia"], ["sdr", "Sid"], ["marketing_manager", "Max"]]) {
      const m = await sa.post(`/api/admin/competitions/${W.booth.id}/team`, { headers: H(csrf), data: { role, name, email: `${name.toLowerCase()}-${STAMP}@corp.example` } });
      expect(m.ok(), await m.text()).toBeTruthy();
    }
    const lead = await makeParticipant(sa, csrf, "a11ylead");
    await enrol(sa, csrf, W.booth.id, [lead.id]);
  } finally { await sa.dispose(); }
});

async function scan(page, sel) {
  // applyReveal fades; reduced motion removes the mid-transition sample.
  await settleFiniteAnimations(page);
  const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
  return (r.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact)).flatMap(v => v.nodes.map(n =>
    `[${v.impact}] ${v.id} — ${(n.target || []).join(" ")}: ${(n.failureSummary || "").replace(/\s+/g, " ").slice(0, 180)}`));
}

async function openWs(page, ev, tab) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id), { timeout: 15000 }).toBe(true);
  await page.evaluate(({ id, n, t }) => window.openEventWorkspace(id, n, t ? { tab: t } : {}), { id: ev.id, n: ev.name, t: tab || null });
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 10000 });
}

test("the workspace's sections pass axe in every look, day and night", async ({ page }) => {
  test.setTimeout(300_000);
  const { looks } = require("../scripts/theme/looks");
  const found = [];
  for (const [id, look] of Object.entries(looks)) {
    for (const mode of ["light", "dark"]) {
      await page.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) {} }, [id, mode]);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: mode });
      await adminLogin(page);
      const got = await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme,
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()]);
      expect(got, `${id}/${mode}: the page really is in this look and mode`).toEqual([id, mode, look[mode].bg.toLowerCase()]);
      const at = (what, bad) => { if (bad.length) found.push(`${what} — ${id}/${mode}:\n  ${bad.join("\n  ")}`); };

      // Overview: the live face, then the detail panel.
      await openWs(page, W.live);
      await expect(page.locator("#ws-ov-progress .ws-prog-fig")).toBeVisible({ timeout: 15000 });
      await openOverviewDetail(page);
      await expect(page.locator("#ws-ov-chart svg, #ws-ov-chart .ws-empty").first()).toBeVisible({ timeout: 15000 });
      at("Overview", await scan(page, "#admin-workspace"));
      at("Overview", await scan(page, "#admin-event-overview-tab"));
      // Settings.
      await page.evaluate(() => window.wsTab("admin-event-settings-tab"));
      await expect(page.locator("#ws-settings .ws-kvs")).toBeVisible({ timeout: 10000 });
      at("Settings", await scan(page, "#admin-event-settings-tab"));
      // Certificates: the issued list, and the designer with every panel open.
      await openWs(page, W.ended, "admin-event-certs-tab");
      await expect(page.locator("#ws-certs-issued table")).toBeVisible({ timeout: 15000 });
      await expect(page.locator("#ws-certs-design #cw-img")).toBeVisible({ timeout: 20000 });
      const panels = await page.locator("#ws-certs-design [data-cw-panel]").evaluateAll(bs => bs.map(b => b.dataset.cwPanel));
      for (const k of panels) {
        const b = page.locator(`#ws-certs-design [data-cw-panel="${k}"]`);
        if ((await b.getAttribute("aria-expanded")) !== "true") await b.click();
      }
      await expect(page.locator('#ws-certs-design [data-cw-panel][aria-expanded="false"]')).toHaveCount(0);
      at("Certificates", await scan(page, "#admin-event-certs-tab"));
      // Team & reports: every role's view.
      await openWs(page, W.booth, "admin-event-team-tab");
      await expect(page.locator('#team-report-body [data-action="team-persona"]').first()).toBeVisible({ timeout: 15000 });
      for (const persona of ["marketing", "se", "sales", "sdr", "manager"]) {
        await page.locator(`[data-action="team-persona"][data-persona="${persona}"]`).click();
        await expect(page.locator("#team-persona-view")).toHaveAttribute("data-persona", persona);
        at(`Team & reports (${persona})`, await scan(page, "#admin-event-team-tab"));
      }
    }
  }
  expect(found, found.join("\n\n")).toEqual([]);
});

test("every Settings section passes axe, not only the one on screen", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await adminLogin(page);
  await page.locator('.admin-nav-item[data-tab-id="admin-settings-tab"]').click();
  await expect(page.locator("#admin-settings-tab")).toBeVisible();
  const keys = await page.evaluate(() => [...document.querySelectorAll("#admin-settings-tab [data-settings-section]")]
    .filter(s => [...s.querySelectorAll(".settings-card")].some(c => getComputedStyle(c).display !== "none"))
    .map(s => s.dataset.settingsSection));
  expect(keys.length, `PRECONDITION: several sections to scan: ${keys.join(", ")}`).toBeGreaterThan(3);
  const found = [];
  for (const key of keys) {
    await openSettingsSection(page, key);
    const bad = await scan(page, "#admin-settings-tab");
    if (bad.length) found.push(`${key}:\n  ${bad.join("\n  ")}`);
  }
  expect(found, found.join("\n\n")).toEqual([]);
});

test("Activity and the raw Logs pass axe in the dark theme", async ({ page }) => {
  const DARK_BG = require("../scripts/theme/looks").looks.ambient.dark.bg.toLowerCase();
  await page.addInitScript(() => { try { localStorage.setItem("hck-theme", "dark"); } catch (_) {} });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await adminLogin(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()), "PRECONDITION: dark").toBe(DARK_BG);
  await openWs(page, W.live, "admin-submissions-tab");
  await expect(page.locator("#admin-submissions-tab tbody tr").first()).toBeVisible({ timeout: 15000 });
  const found = [];
  let bad = await scan(page, "#admin-submissions-tab");
  if (bad.length) found.push(`Activity:\n  ${bad.join("\n  ")}`);
  await page.evaluate(() => window.closeEventWorkspace({ silent: true }));
  await page.evaluate(() => window.adminTab(null, "admin-logs-tab"));
  await expect(page.locator("#admin-logs-tab tbody tr").first()).toBeVisible({ timeout: 15000 });
  bad = await scan(page, "#admin-logs-tab");
  if (bad.length) found.push(`Logs:\n  ${bad.join("\n  ")}`);
  expect(found, found.join("\n\n")).toEqual([]);
});
