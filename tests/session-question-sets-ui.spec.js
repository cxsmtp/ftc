// @ts-check
//
// PER-SESSION QUESTION SETS AND THE RANKING CHOICE — the screens (owner
// decision, 27 Nov 2026). The rules are the server's (tests/session-question-
// sets.api.spec.js); this spec holds what an organiser and a participant meet:
//   * the event form's Ranking control (three choices) and its percentages box,
//     which is off while the choice has no overall board, and the save sending
//     the three stored fields;
//   * the workspace Questions section's Sessions chip on each of the event's
//     questions and its dialog, a started session's box fixed with its reason;
//   * the participant's leaderboard: their session's board and the overall
//     board beside it, ranked by percentages;
// each at 1440 and 390 px, scanned by axe (gated on impact).
const { test, expect } = require("./isolated-test");
const { BASE, codeLogin, settleFiniteAnimations } = require("./helpers");
const { adminLogin, openEventEdit, viewComp, clickTab, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, uniq, sa, makeParticipant, enrol, participantCtx, submit, rawAll } = require("./late-entry-fixture");
const { addQuestion, sessionEvent, setSessions, goLive, chooseSession } = require("./session-sets-fixture");

test.use({ baseURL: BASE });

async function scan(page, sel) {
  await settleFiniteAnimations(page);
  const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
  return (r.violations || []).filter(v => AXE_GATED_IMPACTS.has(v.impact)).flatMap(v => v.nodes.map(n =>
    `[${v.impact}] ${v.id} — ${(n.target || []).join(" ")}: ${(n.failureSummary || "").replace(/\s+/g, " ").slice(0, 180)}`));
}
/** No sideways scroll: the page is no wider than the window. */
async function noSidewaysScroll(page, what) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `${what}: no sideways scroll`).toBeLessThanOrEqual(cw + 1);
}

test.describe("the event form's Ranking control", () => {
  for (const width of [1440, 390]) {
    test(`three choices, the percentages box follows them, and the save stores what was chosen (${width} px)`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      const { api, csrf } = await sa();
      let ev;
      try { ev = await sessionEvent(api, csrf); } finally { await api.dispose(); }
      await adminLogin(page);
      await openEventEdit(page, ev.comp.name, { advanced: false });
      const form = page.locator("#comp-form-overlay");
      const sel = form.locator("#comp-lb-mode"), pct = form.locator("#comp-lb-percent"), note = form.locator("#comp-lb-mode-note");
      await sel.scrollIntoViewIfNeeded();
      await expect(sel.locator("option")).toHaveText(["A winner per session", "One overall winner", "Both: a winner per session and overall"]);
      await expect(sel, "an event that chose nothing ranks per session").toHaveValue("per_slot");
      await expect(pct, "percentages rank an overall board, so they are off here").toBeDisabled();
      await expect(note).toContainText("choose an overall winner (or both)");
      expect(await scan(page, "#comp-form-overlay .comp-form-ranking"), "the control passes axe").toEqual([]);
      await sel.selectOption("both");
      await expect(pct, "with an overall board the box can be ticked").toBeEnabled();
      await expect(note).toContainText("also ranked on one overall board");
      await pct.check();
      await noSidewaysScroll(page, "the form");
      let putBody = null;
      page.on("request", (r) => { if (r.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+$/.test(new URL(r.url()).pathname)) putBody = r.postDataJSON(); });
      await form.locator('[data-action="comp-save"]').click();
      await expect(page.locator("#modal-overlay.open #modal-title"), "the save asks first").toHaveText(/^Update /, { timeout: 10000 });
      await page.locator("#modal-confirm-btn").click();
      await expect(form).toHaveCount(0, { timeout: 15000 });
      expect(putBody && [putBody.leaderboard_mode, putBody.leaderboard_overall, putBody.leaderboard_percent], "the save sends the three fields").toEqual(["per_slot", true, true]);
      expect(rawAll("SELECT leaderboard_mode, leaderboard_overall, leaderboard_percent FROM competitions WHERE id=?", [ev.comp.id])[0])
        .toEqual({ leaderboard_mode: "per_slot", leaderboard_overall: 1, leaderboard_percent: 1 });
      // Back to a winner per session: the box unticks itself, and the save says so.
      await openEventEdit(page, ev.comp.name, { advanced: false });
      await expect(sel, "the form opens on what was stored").toHaveValue("both");
      await expect(pct).toBeChecked();
      await sel.selectOption("per_slot");
      await expect(pct).not.toBeChecked();
      await expect(pct).toBeDisabled();
    });
  }
});

test.describe("the Questions section's Sessions choice", () => {
  for (const width of [1440, 390]) {
    test(`each of the event's questions shows its sessions; the dialog changes them and a started session's box is fixed (${width} px)`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      const { api, csrf } = await sa();
      let ev, qA, qAll;
      try {
        ev = await sessionEvent(api, csrf);
        qAll = await addQuestion(api, csrf, ev.comp.id, { title: `Everywhere ${uniq()}` });
        qA = await addQuestion(api, csrf, ev.comp.id, { title: `Morning only ${uniq()}` });
        expect((await setSessions(api, csrf, ev.comp.id, qA, [ev.slots[0].id])).ok()).toBeTruthy();
      } finally { await api.dispose(); }
      await adminLogin(page);
      await clickTab(page, "Events");
      await viewComp(page, ev.comp.name);
      // The Questions section: a tab on a wide screen, the Section sheet on a phone.
      await page.locator("#ws-record").waitFor({ state: "visible", timeout: 10000 });
      const tab = page.locator('#ws-tabs [data-section="admin-tasks-tab"]').first();
      if (await tab.isVisible().catch(() => false)) await tab.click();
      else {
        await page.locator("#ws-section-pick").click();
        await page.locator('#ws-section-sheet [data-section="admin-tasks-tab"]').first().click();
      }
      const chip = (t) => page.locator(`#admin-task-body button.session-chip[data-task-id="${t}"]`);
      await expect(chip(qAll), "a question in every session says so").toHaveText("All sessions");
      await expect(chip(qA), "a narrowed one names its sessions").toHaveText(ev.slots[0].name);
      await expect(chip(qA)).toHaveClass(/is-narrowed/);
      expect(await scan(page, "#admin-task-body"), "the chips pass axe").toEqual([]);
      // Open the dialog on the shared question and keep it to the second session.
      await chip(qAll).click();
      const dlg = page.locator("#task-sessions-overlay");
      await expect(dlg.locator(".tsq-box")).toHaveCount(2);
      await expect(dlg.locator(".tsq-box:checked"), "every session ticked").toHaveCount(2);
      // Geometry: each row is a small box, then the session's name on one line
      // beside it, the whole name inside the dialog (a box stretched across the
      // row once squeezed the name off its right edge).
      const geo = await dlg.evaluate((d) => {
        const box = d.querySelector(".picker-modal").getBoundingClientRect();
        return [...d.querySelectorAll(".picker-row")].map(r => {
          const cb = r.querySelector(".tsq-box").getBoundingClientRect(), nm = r.querySelector(".tsq-name").getBoundingClientRect();
          return { cbW: cb.width, nameLeftOfBox: nm.left - cb.right, nameRight: nm.right - box.right, nameH: nm.height, rowH: r.getBoundingClientRect().height };
        });
      });
      for (const g of geo) {
        expect(g.cbW, `the box is a box (${JSON.stringify(g)})`).toBeLessThan(40);
        expect(g.nameLeftOfBox, "the name follows the box").toBeGreaterThanOrEqual(0);
        expect(g.nameRight, "the name stays inside the dialog").toBeLessThanOrEqual(0);
        expect(g.nameH, "the name reads on one line").toBeLessThan(30);
      }
      expect(await scan(page, "#task-sessions-overlay"), "the dialog passes axe").toEqual([]);
      await noSidewaysScroll(page, "the dialog");
      // Unticking every box is refused in place.
      await dlg.locator(`.tsq-box[value="${ev.slots[0].id}"]`).uncheck();
      await dlg.locator(`.tsq-box[value="${ev.slots[1].id}"]`).uncheck();
      await expect(dlg.locator("#tsq-error")).toContainText("at least one session");
      await expect(dlg.locator("#tsq-save")).toBeDisabled();
      await dlg.locator(`.tsq-box[value="${ev.slots[1].id}"]`).check();
      await dlg.locator("#tsq-save").click();
      await expect(dlg).toHaveCount(0);
      await expect(chip(qAll), "the chip now names the one session").toHaveText(ev.slots[1].name);
      expect(rawAll("SELECT timeslot_id FROM competition_task_sessions WHERE competition_id=? AND task_id=?", [ev.comp.id, qAll]).map(r => r.timeslot_id))
        .toEqual([ev.slots[1].id]);
      // A started session's box is fixed, with its reason.
      await goLive(ev.comp.id, [ev.slots[0].id]);
      await page.evaluate(() => window.loadAdminTasks());
      await chip(qA).click();
      const box = dlg.locator(`.tsq-box[value="${ev.slots[0].id}"]`);
      await expect(box, "the running session keeps its questions").toBeDisabled();
      await expect(box).toBeChecked();
      await expect(dlg.locator(".picker-row").filter({ has: page.locator(`.tsq-box[value="${ev.slots[0].id}"]`) })).toContainText("Running: its questions are fixed");
      await dlg.locator('[data-action="overlay-close"]').click();
    });
  }
});

test.describe("the participant's leaderboard", () => {
  for (const width of [1440, 390]) {
    test(`their session's board and the overall board beside it, by percentages (${width} px)`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      const { api, csrf } = await sa();
      const ctxs = [];
      let ev, pb;
      try {
        ev = await sessionEvent(api, csrf, { create: { leaderboard_mode: "per_slot", leaderboard_overall: true, leaderboard_percent: true } });
        const [A, B] = ev.slots;
        const easyA = await addQuestion(api, csrf, ev.comp.id, { difficulty: "easy" });
        const easyB = await addQuestion(api, csrf, ev.comp.id, { difficulty: "easy" });
        const hardB = await addQuestion(api, csrf, ev.comp.id, { difficulty: "hard" });
        expect((await setSessions(api, csrf, ev.comp.id, easyA, [A.id])).ok()).toBeTruthy();
        expect((await setSessions(api, csrf, ev.comp.id, easyB, [B.id])).ok()).toBeTruthy();
        expect((await setSessions(api, csrf, ev.comp.id, hardB, [B.id])).ok()).toBeTruthy();
        await goLive(ev.comp.id, [A.id, B.id]);
        const pa = await makeParticipant(api, csrf, `sqa${uniq()}`);
        pb = await makeParticipant(api, csrf, `sqb${uniq()}`);
        for (const [p, s, t] of [[pa, A, easyA], [pb, B, hardB]]) {
          await enrol(api, csrf, ev.comp.id, p.id);
          const c = await participantCtx(p.email, ev.comp.id);
          ctxs.push(c);
          await chooseSession(c, s.id);
          expect((await (await submit(c.api, c.csrf, t)).json()).correct).toBe(true);
        }
      } finally { for (const c of ctxs) await c.api.dispose(); await api.dispose(); }
      // B's own browser: sign in, enter the event and B's session, open the board.
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      expect((await codeLogin(page.request, pb.email, H(csrfToken))).ok()).toBeTruthy();
      await page.goto("/");
      await page.locator("#nav-leaderboard:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
      await page.locator("#nav-leaderboard").click();
      await expect(page.locator("#lb-board-caption"), "the board above is B's session's").toContainText(`Your session: ${ev.slots[1].name}`);
      const overall = page.locator("#lb-overall-section");
      await expect(overall.locator("h3")).toHaveText("Overall");
      await expect(overall).toContainText("percentage of their own session’s points");
      const rows = overall.locator("tbody tr");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).locator(".lb-pct"), "A's 100% leads").toHaveText("100%");
      await expect(rows.nth(1).locator(".lb-pct"), "B's 75%, though B has more points").toHaveText("75%");
      await expect(rows.nth(1)).toHaveClass(/\bme\b/);
      await expect(rows.nth(1)).toContainText("150 pts");
      await noSidewaysScroll(page, "the leaderboard");
      expect(await scan(page, "#leaderboard-page"), "the leaderboard passes axe").toEqual([]);
    });
  }
});
