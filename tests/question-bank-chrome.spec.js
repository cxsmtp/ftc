// @ts-check
//
// THE ORGANISER'S CHROME AFTER THE QUESTION BANK RENAME (owner's rename: the
// Challenge library is the Question bank, the workspace section is Questions,
// topics group the questions, `qualifying:` tags are internal). Pinned in a
// browser, by geometry and by value:
//
//   1. ROLES & PERMISSIONS: a Role chip never wraps inside its word ("Admi|n")
//      and an address never breaks mid-word ("example.co|m"): one line at 1440,
//      at 1024 only after a "." or "-" or before the "@", the table still
//      fitting its card. Last sign-in is one heading line from 1280.
//   2. QUESTION BANK: the count speaks of questions; each "?" sits right after
//      what it explains (the count, the Topic label, Import); a long topic chip
//      is one line, cut short, its whole name in its title.
//   3. ADD FROM BANK: the dialog speaks of questions, offers the bank's Topic
//      filter (it narrows, and All topics restores), shows each question's topic,
//      marks a qualifying question "Quick question" and never shows a raw
//      `qualifying:` tag.
//   4. THE EVENT FORM: the Event type "?" is on the label's line, beside it.
//   5. THE OVERVIEW: no organiser-facing "challenge" on the Overview's face, its
//      detail or its KPI band; the Questions tile and toggle say questions.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin, clickTab, viewComp, narrowChallengesTable, openCompCreateForm, openOverviewDetail } = require("./ui-admin-helpers");
const { H, makeCompetition, makeTask } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const S = `qbc${Date.now().toString(36)}`;
const LONG_TOPIC = `${S} Supply chain and software composition analysis`;
const OTHER_TOPIC = `Key ${S.slice(-5)}`;   // short: shown whole (the control)
const ADDR = `${S}.organiser@enablement-example.com`;
const QKEY = `qb${Date.now().toString(36)}`;
let comp, qLong, qOther, qQuick;

/** How many lines `el`'s text is laid out on (distinct line boxes). */
const lineCount = (loc) => loc.evaluate((el) => {
  const r = document.createRange(); r.selectNodeContents(el);
  return new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top + x.height / 2))).size;
});

/** The tip's button sits immediately after `anchor`, on its line. */
async function tipBeside(page, tipSel, anchorSel) {
  return page.evaluate(([t, a]) => {
    const tip = document.querySelector(t), anchor = document.querySelector(a);
    if (!tip || !anchor) return { missing: !tip ? t : a };
    const b = tip.querySelector(".help-tip-btn") || tip;
    const tr = b.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    return { prev: tip.previousElementSibling === anchor, gap: Math.round(tr.left - ar.right),
      dy: Math.round(Math.abs((tr.top + tr.height / 2) - (ar.top + ar.height / 2))) };
  }, [tipSel, anchorSel]);
}

test.describe("organiser chrome after the Question bank rename", () => {
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const topic = async (name) => {
        const r = await api.post("/api/admin/topics", { headers: H(csrf), data: { name } });
        expect(r.ok(), `topic ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
        return (await r.json()).id;
      };
      const tLong = await topic(LONG_TOPIC), tOther = await topic(OTHER_TOPIC);
      qLong = await makeTask(api, csrf, `${S}-long`, { topic_id: tLong });
      qOther = await makeTask(api, csrf, `${S}-other`, { topic_id: tOther });
      qQuick = await makeTask(api, csrf, `${S}-quick`, { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] });
      const t = await api.post(`/api/admin/tasks/${qQuick.id}/tags`, { headers: H(csrf), data: { tag: `qualifying:${QKEY}` } });
      expect(t.ok(), `qualifying tag: ${t.status()} ${await t.text()}`).toBeTruthy();
      const u = await api.post("/api/admin/users", { headers: H(csrf), data: { email: ADDR, first_name: "Dana", last_name: S, role: "admin" } });
      expect(u.ok(), `add user: ${u.status()} ${await u.text()}`).toBeTruthy();
      comp = await makeCompetition(api, csrf, `${S}-ev`, { start_time: new Date(Date.now() + 86_400_000).toISOString() });
    } finally { await api.dispose(); }
  });

  for (const width of [1024, 1440]) {
    test(`Roles & permissions at ${width}px: the Role chip and the address keep their words; the table fits`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await adminLogin(page);
      await page.locator('button.admin-nav-item[data-tab-id="admin-users-tab"]').click();
      const row = page.locator("#admin-users-tab .ua-table tbody tr", { hasText: ADDR });
      await expect(row).toBeVisible({ timeout: 15000 });
      const chip = row.locator(".ua-role-chip");
      await expect(chip).toHaveText("Admin");
      expect(await lineCount(chip), "the Role chip is one line").toBe(1);
      const addr = row.locator("td.cell-addr");
      await expect(addr).toHaveText(ADDR);
      // Never broken inside a word: at 1440 on one line; at 1024 at most at a
      // break the address itself offers (after "-", "." or before "@").
      const breaks = await addr.evaluate((el) => {
        // Every character of every text node (the address is split by <wbr>).
        const r = document.createRange(), tops = [];
        let txt = "";
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let tn = w.nextNode(); tn; tn = w.nextNode()) {
          const t = tn.textContent || "";
          for (let i = 0; i < t.length; i++) { r.setStart(tn, i); r.setEnd(tn, i + 1); const b = r.getClientRects()[0]; tops.push(b ? Math.round(b.top) : null); }
          txt += t;
        }
        const at = []; for (let i = 1; i < txt.length; i++) if (tops[i] !== null && tops[i - 1] !== null && tops[i] > tops[i - 1] + 2) at.push([txt[i - 1], txt[i]]);
        return at;
      });
      if (width >= 1440) expect(breaks, "the address is one line at 1440").toEqual([]);
      else expect(breaks.length, `at 1024 the address breaks at least once (where it may): ${JSON.stringify(breaks)}`).toBeGreaterThan(0);
      for (const [before, after] of breaks) expect("-.".includes(before) || after === "@", `a break only at a sensible point, not "${before}|${after}"`).toBe(true);
      // CONTROL: the measure sees a wrap. The same cell squeezed to 60 px breaks.
      expect(await addr.evaluate((el) => {
        const c = /** @type {HTMLElement} */ (el.cloneNode(true)); c.style.cssText = "display:block;width:60px;overflow-wrap:anywhere";
        document.body.appendChild(c);
        const r = document.createRange(); r.selectNodeContents(c);
        const n = new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; c.remove(); return n;
      }), "CONTROL: a narrow copy of the cell takes several lines").toBeGreaterThan(1);
      // The table still fits its card.
      const fit = await page.locator("#admin-users-tab .ua-table-wrap").evaluate(w => ({ sw: w.scrollWidth, cw: w.clientWidth,
        cols: [...w.querySelectorAll("thead th")].map(h => `${(h.textContent || "").trim()}:${Math.round(h.getBoundingClientRect().width)}`).join(" ") }));
      expect(fit.sw, `the users table fits its card at ${width}px (${fit.cols})`).toBeLessThanOrEqual(fit.cw + 1);
      const th = page.locator('#admin-users-tab .ua-table thead th[data-tcol="last_sign_in"]');
      await expect(th).toContainText("Last sign-in");
      if (width >= 1280) expect(await th.evaluate(el => { const r = document.createRange(); const n = [...el.childNodes].find(x => x.nodeType === 3 && /sign/.test(x.textContent || "")) || el; r.selectNodeContents(n); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; }),
        "Last sign-in is one heading line").toBe(1);
      // Add user's "?" is beside the button, not at the toolbar's far edge.
      const t = await tipBeside(page, '#admin-users-tab .ua-add-row [data-help="users.add"]', '#admin-users-tab [data-action="ua-add-user"]');
      expect(t.prev && t.gap >= 0 && t.gap <= 16 && t.dy <= 6, `Add user's tip beside it: ${JSON.stringify(t)}`).toBe(true);
    });
  }

  test("Question bank: counts questions, each tip beside what it explains, a long topic chip on one line", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await narrowChallengesTable(page, S);
    await expect(page.locator("#task-search-count")).toHaveText(/^\d+ of \d+ questions match(es)?$/, { timeout: 15000 });
    for (const [tip, anchor] of [
      ['#task-controls-row [data-help="library.list"]', "#task-search-count"],
      ['#task-controls-row [data-help="library.topics"]', 'label[for="task-topic-filter"]'],
    ]) {
      const t = await tipBeside(page, tip, anchor);
      expect(t.prev && t.gap >= 0 && t.gap <= 16 && t.dy <= 6, `${tip} beside ${anchor}: ${JSON.stringify(t)}`).toBe(true);
    }
    // The export tip follows the last of Export / Import on screen.
    const exp = await page.evaluate(() => {
      const tip = document.querySelector('#new-task-btn-row [data-help="library.export"]');
      const prev = [...document.querySelectorAll("#export-tasks-btn, #import-tasks-btn")].filter(b => /** @type {HTMLElement} */ (b).offsetParent).pop();
      if (!tip || !prev) return null;
      const a = prev.getBoundingClientRect(), b = (tip.querySelector(".help-tip-btn") || tip).getBoundingClientRect();
      return { gap: Math.round(b.left - a.right), dy: Math.round(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2))) };
    });
    expect(exp && exp.gap >= 0 && exp.gap <= 16 && exp.dy <= 6, `the export tip beside Import/Export: ${JSON.stringify(exp)}`).toBe(true);
    const chip = page.locator("#admin-task-body tr", { hasText: qLong.title }).locator(".topic-chip");
    await expect(chip).toHaveAttribute("title", LONG_TOPIC);
    await expect(chip).toHaveText(LONG_TOPIC);   // the whole name stays in the DOM
    expect(await lineCount(chip), "the topic chip is one line").toBe(1);
    expect(await chip.evaluate(el => el.scrollWidth > el.clientWidth), "a long topic is cut short, not wrapped").toBe(true);
    // CONTROL: a short topic is shown whole.
    const short = page.locator("#admin-task-body tr", { hasText: qOther.title }).locator(".topic-chip");
    expect(await short.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test("Add from bank: questions, the bank's Topic filter, topics shown, Quick question in words", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await viewComp(page, comp.name);
    await clickTab(page, "Challenges");
    await page.locator("#add-tasks-to-comp-btn").click();
    const dlg = page.locator("#task-picker-overlay");
    await expect(dlg).toBeVisible({ timeout: 10000 });
    await expect(dlg.locator("#task-picker-title")).toHaveText(`Questions in ${comp.name}`);
    await expect(dlg.locator("#task-picker-search")).toHaveAttribute("placeholder", "Search by title, difficulty or topic…");
    await expect(dlg.locator('[data-action="task-picker-select-all"]')).toHaveText("Select all shown");
    await expect(dlg.locator('[data-action="task-picker-unselect-all"]')).toHaveText("Unselect all shown");
    await dlg.locator("#task-picker-search").fill(S);
    const rows = dlg.locator("#task-picker-list .picker-row");
    await expect(rows).toHaveCount(3, { timeout: 5000 });
    await expect(dlg.locator("#task-picker-note")).toHaveText(/^\d+ of \d+ questions match(es)?$/);
    // The qualifying question: named in words, its tag nowhere in the dialog.
    await expect(rows.filter({ hasText: qQuick.title }).locator(".picker-row-flag.is-quick")).toHaveText("Quick question");
    expect(await dlg.evaluate(el => el.textContent || ""), "no raw qualifying tag").not.toContain("qualifying:");
    // CONTROL: the tag IS on the question the dialog was given.
    expect(await page.evaluate((id) => ((window.S.adminTasksData || []).find(t => t.id === id) || {}).tags || [], qQuick.id)).toContain(`qualifying:${QKEY}`);
    await expect(rows.filter({ hasText: qLong.title }).locator(".topic-chip")).toHaveText(LONG_TOPIC);
    await expect(rows.filter({ hasText: qOther.title }).locator(".picker-row-flag.is-quick"), "CONTROL: an ordinary question is not marked").toHaveCount(0);
    // The Topic filter narrows to one topic, and All topics restores.
    const sel = dlg.locator("#task-picker-topic");
    const longId = await sel.locator("option", { hasText: LONG_TOPIC }).getAttribute("value");
    await sel.selectOption(String(longId));
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(qLong.title);
    await sel.selectOption("");
    await expect(rows).toHaveCount(3);
  });

  test("the event form: Event type's tip is beside its label", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page, "program", { advanced: false });
    const t = await tipBeside(page, '#comp-form-overlay [data-help="event.kind"]', "#comp-kind-label");
    expect(t.prev && t.gap >= 0 && t.gap <= 16 && t.dy <= 6, `Event type's tip beside its label: ${JSON.stringify(t)}`).toBe(true);
  });

  test("the Overview speaks of questions, on its face, its detail and its KPI band", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await viewComp(page, comp.name);
    await expect(page.locator('#ws-kpis [data-kpi-tile="tasks"] .eyebrow')).toHaveText("Questions", { timeout: 15000 });
    await expect(page.locator("#ws-ov-ready")).toContainText("No questions yet", { timeout: 15000 });
    await expect(page.locator("#ws-ov-detail-more")).toContainText("Show questions, activity and organisers");
    await openOverviewDetail(page);
    await expect(page.locator("#ws-ov-tasks")).toContainText("No questions yet");
    const words = await page.evaluate(() => ["#ws-kpis", "#ws-overview"].map(s => /** @type {HTMLElement} */ (document.querySelector(s))?.innerText || "").join("\n"));
    expect(words.length, "CONTROL: the Overview was read").toBeGreaterThan(40);
    expect(words, "no organiser-facing 'challenge' on the Overview").not.toMatch(/challenge/i);
    await expect(page.locator('#ws-tabs .ws-tab[data-section="admin-tasks-tab"]')).toContainText("Questions");
  });
});
