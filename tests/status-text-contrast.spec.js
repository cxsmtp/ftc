"use strict";

// v8.13.8 — SMALL STATUS TEXT READS AT AA IN THE LIGHT THEME.
//
// The light theme's `--green` (#15803d) and `--red` (#d62828) measure 4.30:1 and
// 4.29:1 on `--surface2`, the colour a hovered or selected row turns to, and less
// on a green tint. Small status words that sat on those backgrounds now take the
// badge foregrounds (`--badge-green-fg` #166534, `--badge-red-fg` #991b1b) in the
// light theme only; the dark theme keeps `--green` / `--red`. This file locks
// every site by MEASURING the text against its real composited background with
// the shared `textContrast` helper (tests/ui-admin-helpers.js), on the state
// that used to fail:
//
//   1. the Assign to Events dialog's "Assigned" tag (rows are --surface2 at rest);
//   2. a challenge's version History: attachments "+N" (.hist-ok) and "−N"
//      (.hist-bad), each on a HOVERED row;
//   3. a participant's History: a failed email's "failed" (.hist-bad), hovered
//      (the test SMTP relay is dead by design, so every send fails), and a sent
//      one's "sent" (.hist-ok) — a success copy routed into the dialog's fetch;
//   4. Submissions: the "+50" and "-5" points cells, each on a hovered row;
//   5. the multiple-choice "Correct" badge, in the admin's View as Participant
//      preview AND on a participant's own solved challenge.
//
// EVERY MEASUREMENT HAS ITS CONTROLS, in this order, so a reverted override is
// killed by the contrast assertion itself and not by a side check:
//   * PRECONDITION — the background measured is the one that used to fail: the
//     OLD token (`--green` / `--red`, resolved by a probe span in the element's
//     own cascade) composited on the very background `textContrast` measured is
//     BELOW 4.5:1. A hover that did not land, or a measurement taken on a
//     different surface, fails here, never passes vacuously. Hovered rows also
//     assert the row really is `--surface2`, and was not before the hover.
//   * THE LOCK — the text measures >= 4.5:1.
//   * IDENTITY — in light the text IS the badge token (defined in this page's
//     cascade), which differs from the old token; in dark it is still the old
//     token (the dark theme is unchanged by design).
// The theme flip is asserted (`data-theme` follows the emulated OS preference);
// nothing is stored, so theme-boot and the SPA follow the OS.
//
// FIXTURES (beforeAll, through the built-in superadmin's API session): a
// user-backed admin (role 'admin') whose BROWSER session is the only one any test
// opens — the built-in superadmin's API session survives it (one session per
// principal); two live tournaments (one holds the challenges, one is the
// unassigned control row); five challenges; participant P1 enrolled, who
// answers one challenge wrong then right and solves the multiple-choice one
// (`tAssign` stays unsolved, so the all-solved auto-end cannot fire, and the
// event is asserted still live).
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, gradingHashFor, zipOf } = require("./helpers");
const { loginViaApi, clickTab, openKebab, openAddToEventsFor, findSeededTaskRow, textContrast, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

// ── colour arithmetic (the same WCAG formula `textContrast` uses) ─────────────
function parseRgb(s) {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(s).trim());
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function lum({ r, g, b }) {
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
/** Contrast of an (opaque) colour string on an already-composited background. */
function ratioOn(colour, bg) {
  const c = parseRgb(colour);
  const fg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) };
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Every ratio measured, printed once at the end (the run's evidence). */
const MEASURED = [];

const themeOf = page => page.evaluate(() => document.documentElement.dataset.theme);

/** Wait out every FINITE animation and transition on the page (hover and theme fades). */
async function settle(page) {
  await page.evaluate(async () => {
    const anims = document.getAnimations ? document.getAnimations() : [];
    await Promise.all(anims
      .filter(a => a.effect && Number.isFinite(a.effect.getComputedTiming().endTime))
      .map(a => a.finished.catch(() => {})));
  });
}

/**
 * The element's own colour beside the tokens resolved IN ITS CASCADE (probe
 * spans appended to it, so theme and scope are the element's), and whether the
 * badge tokens are defined there at all — an undefined var() would make a probe
 * inherit the element's colour and an equality check pass on nothing.
 */
async function tokensAt(locator) {
  return locator.evaluate(el => {
    const read = (prop, v) => {
      const p = document.createElement("span");
      p.style[prop] = v;
      el.appendChild(p);
      const c = getComputedStyle(p)[prop];
      p.remove();
      return c;
    };
    const cs = getComputedStyle(el);
    return {
      color: cs.color,
      badgeGreen: read("color", "var(--badge-green-fg)"),
      badgeRed: read("color", "var(--badge-red-fg)"),
      green: read("color", "var(--green)"),
      red: read("color", "var(--red)"),
      surface2: read("backgroundColor", "var(--surface2)"),
      defined: {
        green: cs.getPropertyValue("--badge-green-fg").trim() !== "",
        red: cs.getPropertyValue("--badge-red-fg").trim() !== "",
      },
    };
  });
}

/**
 * Measure `loc` (status text of `tone`) in the theme the page is in, with the
 * controls described in the header. `what` names the site in every message.
 */
async function measure(page, loc, tone, what, theme, { darkBadge = false } = {}) {
  await expect(loc, `${what}: the status text is on screen`).toBeVisible();
  expect(await themeOf(page), `PRECONDITION ${what}: the page is in the ${theme} theme`).toBe(theme);
  await settle(page);
  const m = await textContrast(loc);
  expect(m.ratio, `${what} (${theme}): textContrast could not parse a colour: ${JSON.stringify(m)}`).not.toBeNull();
  const t = await tokensAt(loc);
  const oldTok = tone === "green" ? t.green : t.red;
  const newTok = tone === "green" ? t.badgeGreen : t.badgeRed;
  expect(m.opacity, `PRECONDITION ${what} (${theme}): nothing fades the text`).toBe(1);
  const oldRatio = ratioOn(oldTok, m.bg);
  MEASURED.push({ what, theme, ratio: m.ratio, oldTokenRatio: oldRatio, color: t.color });
  // A page styled by styles.css carries the generated look tokens (--surface-2
  // among them); a page with its own stylesheet does not.
  const styledByLooks = await loc.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim() !== "");
  if (theme === "light" && !styledByLooks) {
    expect(oldRatio,
      `PRECONDITION ${what} (light): the old --${tone} (${oldTok}) measures below AA on this very `
      + `background ${JSON.stringify(m.bg)} — the state that used to fail is the one measured`).toBeLessThan(4.5);
    expect(m.ratio, `${what} (light): the text (${t.color}) measures >= 4.5:1 on ${JSON.stringify(m.bg)}`)
      .toBeGreaterThanOrEqual(4.5);
    expect(t.defined[tone], `${what} (light): --badge-${tone}-fg is defined in this page's cascade`).toBe(true);
    expect(newTok, `CONTROL ${what} (light): --badge-${tone}-fg differs from --${tone}`).not.toBe(oldTok);
    expect(t.color, `${what} (light): the text is --badge-${tone}-fg`).toBe(newTok);
  } else if (theme === "light") {
    // ON styles.css THE LOOKS' PALETTE IS MEASURED AT THE SOURCE: every status ink
    // clears AA on --surface2 and on its own tint in every look
    // (scripts/build-theme-tokens.js fails the build otherwise), so the light
    // --badge-*-fg is that same ink (the legacy alias) and the old "the plain
    // token fails here" precondition no longer holds by design. What stays locked
    // is the reading itself, on the real composited background, and that the
    // site still takes the badge foreground.
    expect(m.ratio, `${what} (light): the text (${t.color}) measures >= 4.5:1 on ${JSON.stringify(m.bg)}`)
      .toBeGreaterThanOrEqual(4.5);
    expect(t.defined[tone], `${what} (light): --badge-${tone}-fg is defined in this page's cascade`).toBe(true);
    expect(t.color, `${what} (light): the text is --badge-${tone}-fg`).toBe(newTok);
  } else if (darkBadge) {
    // A site whose DARK reading also fell short takes the badge foreground there too.
    expect(oldRatio,
      `PRECONDITION ${what} (dark): the old --${tone} (${oldTok}) measures below AA on this very `
      + `background ${JSON.stringify(m.bg)} — the state that used to fail is the one measured`).toBeLessThan(4.5);
    expect(m.ratio, `${what} (dark): the text (${t.color}) measures >= 4.5:1 on ${JSON.stringify(m.bg)}`)
      .toBeGreaterThanOrEqual(4.5);
    expect(t.defined[tone], `${what} (dark): --badge-${tone}-fg is defined in this page's cascade`).toBe(true);
    expect(t.color, `${what} (dark): the text is --badge-${tone}-fg`).toBe(newTok);
  } else {
    expect(m.ratio, `${what} (dark): the text (${t.color}) measures >= 4.5:1 on ${JSON.stringify(m.bg)}`)
      .toBeGreaterThanOrEqual(4.5);
    expect(t.color, `${what} (dark): the dark theme is unchanged — the text is still --${tone}`).toBe(oldTok);
  }
  return { ratio: m.ratio, oldRatio, bg: m.bg };
}

/** Hover `row` and prove it took: the row is --surface2 now, and was not before. */
async function hoverRow(page, row, what) {
  const bgOf = () => row.evaluate(el => getComputedStyle(el).backgroundColor);
  const surface2 = () => row.evaluate(el => {
    const p = document.createElement("span");
    p.style.backgroundColor = "var(--surface2)";
    el.appendChild(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  });
  await page.mouse.move(0, 0);
  await settle(page);
  expect(await bgOf(), `CONTROL ${what}: the row is NOT --surface2 until it is hovered`).not.toBe(await surface2());
  await row.hover();
  await expect.poll(async () => (await bgOf()) === (await surface2()),
    { message: `PRECONDITION ${what}: the hovered row turned --surface2`, timeout: 5000 }).toBe(true);
}

/**
 * Follow the OS into dark and assert it did. Nothing stored is the house mode,
 * which follows the OS too (HOUSE_MODE "system"); the helper stores "system" first
 * so the page follows the OS live whatever that default becomes.
 */
async function toDark(page) {
  const was = await page.evaluate(() => { try { const v = localStorage.getItem("hck-theme"); localStorage.setItem("hck-theme", "system"); return v; } catch (_) { return "unreadable"; } });
  expect([null, "system"], "PRECONDITION: no stored theme pin (nothing, or \"system\")").toContain(was);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => themeOf(page), { message: "the page followed the OS into the dark theme", timeout: 5000 }).toBe("dark");
  await settle(page);
}

let sa, saCsrf;
let admin, p1;
let comp, compOther;
let tAssign, tHist, tPts, tMc;
let mcRightText, mcWrongText;

test.describe("v8.13.8 — small status text reads at AA in the light theme", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));

    // ── people ──
    admin = await makeParticipant(sa, saCsrf, "stcadmin");
    {
      const r = await sa.post(`/api/admin/participants/${admin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
      expect(r.ok(), `promote the admin: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    p1 = await makeParticipant(sa, saCsrf, "stcp1");

    // ── events ──
    comp = await makeCompetition(sa, saCsrf, "stc");
    compOther = await makeCompetition(sa, saCsrf, "stcother");

    // ── challenges ──
    tAssign = await makeTask(sa, saCsrf, "stcassign");
    tPts = await makeTask(sa, saCsrf, "stcpts", { correct_answer: "right-answer" });
    const tag = uniq("mc").replace(/[^a-zA-Z0-9]/g, "");
    mcRightText = `RIGHT_${tag}`;
    mcWrongText = `WRONG_${tag}`;
    tMc = await makeTask(sa, saCsrf, "stcmc", {
      answer_type: "choice", correct_answer: undefined,
      choices: [{ text: mcRightText, correct: true }, { text: mcWrongText }],
    });
    Object.assign(tAssign, { bankId: tAssign.id, id: (await assignTask(sa, saCsrf, tAssign.id, [comp.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
    Object.assign(tPts, { bankId: tPts.id, id: (await assignTask(sa, saCsrf, tPts.id, [comp.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there
    Object.assign(tMc, { bankId: tMc.id, id: (await assignTask(sa, saCsrf, tMc.id, [comp.id])).copies[0].task_id });   // the event's own copy (lib/event-copies.js): what is opened and answered there

    // tHist: v1 created; attachment uploaded, then a tag added (v2: attachments
    // +1); attachment deleted, then the tag removed (v3: attachments −1). The
    // upload and delete write no version of their own — the next one snapshots.
    tHist = await makeTask(sa, saCsrf, "stchist");
    let attId;
    {
      const r = await sa.post(`/api/admin/tasks/${tHist.id}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: { file: { name: "stc-notes.zip", mimeType: "application/zip", buffer: zipOf("README.txt", "status text contrast") } },
      });
      expect(r.ok(), `upload the attachment: ${r.status()} ${await r.text()}`).toBeTruthy();
      attId = (await r.json()).id;
      expect(attId, "the upload returned an attachment id").toBeTruthy();
    }
    {
      const r = await sa.post(`/api/admin/tasks/${tHist.id}/tags`, { headers: H(saCsrf), data: { tag: "stc-version" } });
      expect(r.ok(), `tag (version 2): ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    {
      const r = await sa.delete(`/api/admin/tasks/${tHist.id}/attachments/${attId}`, { headers: { "x-csrf-token": saCsrf } });
      expect(r.ok(), `delete the attachment: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    {
      const r = await sa.delete(`/api/admin/tasks/${tHist.id}/tags/${encodeURIComponent("stc-version")}`, { headers: { "x-csrf-token": saCsrf } });
      expect(r.ok(), `untag (version 3): ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    {
      const vs = await (await sa.get(`/api/admin/tasks/${tHist.id}/versions`)).json();
      const counts = [...vs].sort((a, b) => a.version_num - b.version_num)
        .map(v => (JSON.parse(v.snapshot || "{}").attachments || []).length);
      expect(counts, "PRECONDITION: the History holds attachments 0 → 1 → 0, so it shows a +1 and a −1").toEqual([0, 1, 0]);
    }

    // ── P1 plays: wrong then right on tPts, right on tMc; tAssign stays unsolved ──
    await enrol(sa, saCsrf, comp.id, [p1.id]);
    const { api, csrf } = await apiLogin(p1.email, PARTICIPANT_PASS);
    try {
      const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: comp.id } });
      expect(sel.ok(), `P1 selects the event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      const submit = async (taskId, answer) => {
        const r = await api.post(`/api/tasks/${taskId}/submit`, {
          headers: H(csrf), data: { answer, gradingHash: await gradingHashFor(api, taskId) },
        });
        expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBeTruthy();
        return r.json();
      };
      expect((await submit(tPts.id, "not-it")).correct, "the wrong answer is graded wrong").toBe(false);
      expect((await submit(tPts.id, "right-answer")).correct, "the right answer is graded right").toBe(true);
      const det = await (await api.get(`/api/tasks/${tMc.id}`)).json();
      const right = (det.choices || []).find(c => c.text === mcRightText);
      expect(right, "P1 is shown the right option").toBeTruthy();
      expect((await submit(tMc.id, JSON.stringify([right.id]))).correct, "P1 solves the multiple-choice challenge").toBe(true);
    } finally { await api.dispose(); }

    // The event is still live (tAssign is unsolved: no all-solved auto-end).
    {
      const list = await (await sa.get("/api/admin/competitions")).json();
      const row = (Array.isArray(list) ? list : list.competitions || []).find(c => c.id === comp.id);
      expect(row, "the event is in the admin list").toBeTruthy();
      expect(row.ended_at || null, "PRECONDITION: the event did not auto-end").toBeNull();
    }

    // P1's registration mail failed on the dead relay — the History row test 3 reads.
    await expect.poll(async () => {
      const r = await sa.get(`/api/admin/participants/${p1.id}/events?offset=0&limit=500`);
      if (!r.ok()) return `HTTP ${r.status()}`;
      const d = await r.json();
      const evs = Array.isArray(d) ? d : d.events || [];
      return evs.some(e => e.event_type === "email_sent" && e.details && e.details.success === false);
    }, { message: "PRECONDITION: P1's History holds a FAILED email_sent", timeout: 20000 }).toBe(true);
  });

  test.afterAll(async () => {
    console.log("[status-text-contrast] measured:\n" + MEASURED
      .map(m => `  ${m.theme.padEnd(5)} ${m.ratio.toFixed(2)}:1 (old token there ${m.oldTokenRatio.toFixed(2)}:1)  ${m.what}  ${m.color}`)
      .join("\n"));
    if (sa) await sa.dispose();
  });

  /** Sign the admin into this page's browser context and land on a settled panel, in light. */
  async function adminPanel(page) {
    await loginViaApi(page, admin.email, PARTICIPANT_PASS);
    const me = await page.request.get("/api/admin/me");
    expect(me.ok(), `the admin has a live session before goto("/"): ${me.status()} ${await me.text()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
  }

  /** Challenges tab → the challenge's kebab → `action`. */
  async function fromChallengeKebab(page, title, action) {
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, title);
    await expect(row.first(), `the challenge "${title}" is listed`).toBeVisible({ timeout: 15000 });
    await openKebab(page, row.first());
    const item = page.locator(`#kebab-portal [data-action="${action}"]`);
    await expect(item, `the kebab offers ${action}`).toHaveCount(1);
    await item.click();
  }

  test("Add to events: the 'Assigned' tag on its row", async ({ page }) => {
    await adminPanel(page);
    // Stage B — the bank's one door into events (the selection bar's Add to events).
    await clickTab(page, "Challenges");
    const aRow = await findSeededTaskRow(page, tAssign.title);
    await expect(aRow.first(), `the challenge "${tAssign.title}" is listed`).toBeVisible({ timeout: 15000 });
    await openAddToEventsFor(page, aRow.first());
    const overlay = page.locator("#assign-task-overlay");
    await expect(overlay, "the Assign to Events dialog opened").toBeVisible({ timeout: 20000 });
    const rowOf = c => overlay.locator(`#assign-task-comp-list > label:has(input[value="${c.id}"])`);
    await expect(rowOf(comp), "the holding event is listed").toHaveCount(1);
    await expect(rowOf(compOther), "the control event is listed").toHaveCount(1);
    // CONTROL: the tag follows the assignment — the other event's row has none.
    await expect(rowOf(compOther).locator(".assign-task-assigned"), "CONTROL: an event not holding the challenge shows no tag").toHaveCount(0);
    const tagEl = rowOf(comp).locator(".assign-task-assigned");
    await expect(tagEl, "the holding event's row shows Assigned").toHaveText("Assigned");
    // The row is --surface2 at rest (inline), so the failing state needs no hover.
    const surface = await tokensAt(rowOf(comp));
    expect(await rowOf(comp).evaluate(el => getComputedStyle(el).backgroundColor),
      "PRECONDITION: the row is --surface2 at rest").toBe(surface.surface2);

    await measure(page, tagEl, "green", "Assign dialog 'Assigned'", "light");
    await toDark(page);
    await measure(page, tagEl, "green", "Assign dialog 'Assigned'", "dark");
  });

  test("Challenge History: attachments '+1' (.hist-ok) and '−1' (.hist-bad) on hovered rows", async ({ page }) => {
    await adminPanel(page);
    await fromChallengeKebab(page, tHist.title, "task-history");
    const dlg = page.locator("#hist-overlay");
    await expect(dlg, "the History dialog opened").toBeVisible({ timeout: 15000 });
    const body = page.locator("#hist-body");
    const addRow = body.locator("tr", { has: page.locator(".hist-ok") });
    const remRow = body.locator("tr", { has: page.locator(".hist-bad") });
    await expect(addRow, "exactly one version shows an attachment added").toHaveCount(1);
    await expect(remRow, "exactly one version shows an attachment removed").toHaveCount(1);
    const ok = addRow.locator(".hist-ok");
    const bad = remRow.locator(".hist-bad");
    await expect(ok, "the added count reads +1").toHaveText("+1");
    await expect(bad, "the removed count reads −1").toHaveText("−1");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toDark(page);
      await hoverRow(page, addRow, `History +1 row (${theme})`);
      await measure(page, ok, "green", "History attachments '+1' (hovered row)", theme);
      await hoverRow(page, remRow, `History −1 row (${theme})`);
      await measure(page, bad, "red", "History attachments '−1' (hovered row)", theme);
    }
  });

  test("Participant History: a failed email's 'failed' (.hist-bad) on a hovered row", async ({ page }) => {
    await adminPanel(page);
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, p1.email);
    const prow = page.locator("#admin-participants-body tr", { hasText: p1.email });
    await expect(prow, "P1's row is the one listed").toHaveCount(1, { timeout: 15000 });
    await prow.locator(`[data-action="participant-history"][data-user-id="${p1.id}"]`).first().click();
    const dlg = page.locator("#hist-overlay");
    await expect(dlg, "the History dialog opened").toBeVisible({ timeout: 15000 });
    await page.locator("#hist-search").fill("email_sent");
    const row = page.locator("#hist-body tr", { has: page.locator(".hist-bad") }).first();
    const bad = row.locator(".hist-bad");
    await expect(bad, "a failed email reads 'failed'").toHaveText(/failed$/);
    await expect(row.locator(".history-type-badge"), "on an email_sent row").toHaveText("email_sent");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toDark(page);
      await hoverRow(page, row, `History email row (${theme})`);
      await measure(page, bad, "red", "History email 'failed' (hovered row)", theme);
    }
  });

  // The test relay refuses every send, so a SUCCESSFUL email row is produced by
  // routing the History dialog's own fetch: each response that carries one of
  // P1's real (failed) email_sent events gains a copy of it marked success, so
  // the real renderer draws a real "sent" row. The copy is told apart by its id.
  test("Participant History: a sent email's 'sent' (.hist-ok) on a hovered row", async ({ page }) => {
    let injected = 0;
    await page.route(`**/api/admin/participants/${p1.id}/events**`, async route => {
      const resp = await route.fetch();
      const body = await resp.json();
      const evs = Array.isArray(body && body.events) ? body.events : null;
      const src = evs && evs.find(e => (e.event_type || e.type) === "email_sent");
      if (src) {
        const parse = d => (typeof d === "string" ? JSON.parse(d) : { ...(d || {}) });
        const det = parse(src.details);
        det.success = true;
        delete det.error;
        const copy = { ...src, id: `${src.id}-sent-copy`, details: typeof src.details === "string" ? JSON.stringify(det) : det };
        evs.splice(evs.indexOf(src), 0, copy);
        if (typeof body.total === "number") body.total += 1;
        injected++;
      }
      await route.fulfill({ response: resp, json: body });
    });
    await adminPanel(page);
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, p1.email);
    const prow = page.locator("#admin-participants-body tr", { hasText: p1.email });
    await expect(prow, "P1's row is the one listed").toHaveCount(1, { timeout: 15000 });
    await prow.locator(`[data-action="participant-history"][data-user-id="${p1.id}"]`).first().click();
    await expect(page.locator("#hist-overlay"), "the History dialog opened").toBeVisible({ timeout: 15000 });
    await page.locator("#hist-search").fill("email_sent");
    const row = page.locator("#hist-body tr", { has: page.locator(".hist-ok") }).first();
    const ok = row.locator(".hist-ok");
    await expect(ok, "the injected success reads 'sent'").toHaveText(/sent$/);
    expect(injected, "PRECONDITION — the History fetch carried a real email_sent event, copied as a success").toBeGreaterThan(0);
    await expect(row.locator(".history-type-badge"), "on an email_sent row").toHaveText("email_sent");
    await expect(page.locator("#hist-body .hist-bad").first(), "CONTROL — the real (failed) row beside it still reads 'failed'").toHaveText(/failed$/);

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toDark(page);
      await hoverRow(page, row, `History email row (${theme})`);
      await measure(page, ok, "green", "History email 'sent' (hovered row)", theme);
    }
    await page.unroute(`**/api/admin/participants/${p1.id}/events**`);
  });

  test("Submissions: the '+50' and '-5' points cells on hovered rows", async ({ page }) => {
    await adminPanel(page);
    await clickTab(page, "Submissions");
    await page.locator("#submissions-search").fill(tPts.title);
    const rows = page.locator("#admin-submissions-body tr", { hasText: tPts.title });
    // Narrowed: exactly P1's two answers, and nothing else in the table.
    await expect.poll(() => page.locator("#admin-submissions-body tr").evaluateAll(
      (rs, t) => rs.length === 2 && rs.every(r => (r.textContent || "").includes(t)), tPts.title),
    { message: "the table narrowed to P1's two answers", timeout: 20000 }).toBe(true);
    await expect(rows).toHaveCount(2);
    const posRow = rows.filter({ has: page.locator("td.sub-cell-points.is-positive") });
    const negRow = rows.filter({ has: page.locator("td.sub-cell-points.is-negative") });
    const pos = posRow.locator("td.sub-cell-points");
    const neg = negRow.locator("td.sub-cell-points");
    await expect(pos, "the right answer scored +50").toHaveText("+50");
    await expect(neg, "the wrong answer cost 5").toHaveText("-5");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toDark(page);
      await hoverRow(page, posRow, `Submissions +50 row (${theme})`);
      await measure(page, pos, "green", "Submissions '+50' (hovered row)", theme);
      await hoverRow(page, negRow, `Submissions -5 row (${theme})`);
      await measure(page, neg, "red", "Submissions '-5' (hovered row)", theme);
    }
  });

  test("View as Participant: the multiple-choice 'Correct' badge", async ({ page }) => {
    await adminPanel(page);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, tMc.title);
    await expect(row.first(), "the multiple-choice challenge is listed").toBeVisible({ timeout: 15000 });
    await row.first().locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay, "the preview opened").toBeVisible({ timeout: 15000 });
    const correctRow = overlay.locator(".choice-review-row.is-correct");
    await expect(correctRow, "one option is marked correct").toHaveCount(1);
    await expect(correctRow, "the marked option is the right one").toContainText(mcRightText);
    await expect(overlay.locator(".choice-review-row:not(.is-correct)"), "CONTROL: the wrong option is unmarked").toContainText(mcWrongText);
    await expect(overlay.locator(".choice-review-row:not(.is-correct) .tpc-badge"), "CONTROL: no badge on the wrong option").toHaveCount(0);
    const badge = correctRow.locator(".tpc-badge");

    await measure(page, badge, "green", "preview 'Correct' badge", "light");
    await toDark(page);
    await measure(page, badge, "green", "preview 'Correct' badge", "dark");
  });

  test("A participant's solved multiple-choice challenge: the 'Correct' badge", async ({ page }) => {
    await loginViaApi(page, p1.email, PARTICIPANT_PASS);
    {
      const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
      const sel = await page.request.post("/api/select-competition", { headers: H(csrfToken), data: { competitionId: comp.id } });
      expect(sel.ok(), `P1 selects the event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    }
    await page.goto("/");
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    const nav = page.locator("#nav-challenges:not([aria-disabled=true])");
    await nav.waitFor({ state: "visible", timeout: 20000 });
    await nav.click();
    // The grid has loaded (the unsolved challenge is listed); a solved one sits
    // behind the Solved filter, which the participant picks.
    await page.locator(`[data-action="task-open"][data-task-id="${tAssign.id}"]`).waitFor({ state: "visible", timeout: 20000 });
    await page.locator('#solve-filters [data-action="set-solve-filter"][data-value="solved"]').click();
    const open = page.locator(`[data-action="task-open"][data-task-id="${tMc.id}"]`);
    await open.waitFor({ state: "visible", timeout: 20000 });
    await open.click();
    const review = page.locator("#choice-review");
    await expect(review, "the solved challenge shows its options read-only").toBeVisible({ timeout: 15000 });
    const correctRow = review.locator(".choice-review-row.is-correct");
    await expect(correctRow, "one option is marked correct").toHaveCount(1);
    await expect(correctRow, "the marked option is the right one").toContainText(mcRightText);
    await expect(review.locator(".choice-review-row:not(.is-correct) .tpc-badge"), "CONTROL: no badge on the wrong option").toHaveCount(0);
    const badge = correctRow.locator(".tpc-badge");

    await measure(page, badge, "green", "participant 'Correct' badge", "light");
    await toDark(page);
    await measure(page, badge, "green", "participant 'Correct' badge", "dark");
  });





});
