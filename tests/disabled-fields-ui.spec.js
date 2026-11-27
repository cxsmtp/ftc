// @ts-check
//
// A FIELD THAT DOES NOT APPLY READS AT FULL STRENGTH, ON THE SCREENS THAT DRAW ONE.
//
// Operator ruling, 25 Nov 2026: every disabled text-bearing field keeps its own
// fill and shows a dashed --border-strong edge and a --muted value at full
// opacity, never the global `:disabled{opacity:.5}` fade, which composited the
// value below AA; the locked Schedule switch likewise (its chosen option in a
// --surface-3 well with --text-2). tests/css-token-sites.spec.js 2d holds the
// one rule on planted fields in every look; this file holds it on four real
// screens, each beside an enabled control on the same screen or a twin, so the
// treatment is shown to key on `disabled`, never on the dialog:
//   1. View Profile of a privileged account (every field read-only), and a
//      regular admin's Edit Profile of a participant (filled fields locked,
//      blank ones open);
//   2. an ended event's form (Name and start locked), an upcoming one's open;
//   3. a started two-session Competition's form: the Leaderboard select, the
//      Schedule switch and the live session's start, the later session's open;
//   4. a locked challenge's editor: title, answer type, answer, the empty
//      attempt cap's placeholder and "+ Accepted answer"; an unlocked twin's open.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, codeLogin, PARTICIPANT_PASS, BASE, appearanceSettled, settleFiniteAnimations } = require("./helpers");
const { adminLogin, clickTab, textContrast } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const MODES = ["light", "dark"];

async function loginViaApi(page, email, password) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await codeLogin(page.request, email, H(csrfToken), { password });
  if (!r.ok()) throw new Error(`loginViaApi(${email}) failed: ${r.status()} ${await r.text()}`);
}

/** Wait for a dialog to show and its entrance to finish: a read mid-fade sees opacity below 1. */
async function opened(page, locator, root) {
  await expect(locator).toBeVisible();
  await settleFiniteAnimations(page, root);
}

/** Paint <html> in the house look's day or night, after boot's own look read has answered. */
async function paintMode(page, theme) {
  await appearanceSettled(page);
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
}

/**
 * One control's look, with the tokens it is judged against resolved in its own
 * cascade (a probe beside it): opacity product up the tree, ink, text fill, the
 * four edges, the fill.
 */
const stateOf = (locator) => locator.evaluate((n) => {
  // A dialog focuses its first field on open: read the resting edge, not the focus ring.
  if (document.activeElement === n) n.blur();
  const probe = (prop, v) => {
    const p = document.createElement("span");
    p.style.setProperty(prop, v);
    n.parentElement.appendChild(p);
    const out = getComputedStyle(p).getPropertyValue(prop);
    p.remove();
    return out;
  };
  let op = 1;
  for (let e = n; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
  const cs = getComputedStyle(n);
  return {
    disabled: !!n.disabled, op, fg: cs.color, fill: cs.webkitTextFillColor, bg: cs.backgroundColor,
    styles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
    colours: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
    widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
    tok: {
      muted: probe("color", "var(--muted)"), text: probe("color", "var(--text)"), text2: probe("color", "var(--text-2)"),
      strong: probe("color", "var(--border-strong)"), control: probe("color", "var(--control)"), border: probe("color", "var(--border)"),
      surface3: probe("background-color", "var(--surface-3)"), accentStrong: probe("background-color", "var(--accent-strong)"),
      onAccent: probe("color", "var(--on-accent)"),
    },
  };
});

/** Asserts a DISABLED field's full-strength look: unfaded, --muted, four drawn dashed --border-strong edges, AA. */
async function expectLockedField(locator, why) {
  const s = await stateOf(locator);
  const w = `${why}: ${JSON.stringify(s)}`;
  expect(s.disabled, `PRECONDITION: ${w}`).toBe(true);
  expect(s.op, `not faded — ${w}`).toBe(1);
  expect(s.fg, `the value is --muted — ${w}`).toBe(s.tok.muted);
  expect(s.fill, `the text fill is --muted — ${w}`).toBe(s.tok.muted);
  expect(s.styles, `four dashed edges — ${w}`).toEqual(["dashed", "dashed", "dashed", "dashed"]);
  expect(s.widths.every((x) => parseFloat(x) >= 1), `four drawn edges — ${w}`).toBe(true);
  expect(s.colours, `edges in --border-strong — ${w}`).toEqual([s.tok.strong, s.tok.strong, s.tok.strong, s.tok.strong]);
  const c = await textContrast(locator);
  expect(c.ratio, `reads at AA on its fill — ${w}: ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(4.5);
}

/** Asserts an ENABLED field: unfaded, --text, four solid edges in `edge` (a probe key). */
async function expectOpenField(locator, why, edge = "control") {
  const s = await stateOf(locator);
  const w = `${why}: ${JSON.stringify(s)}`;
  expect(s.disabled, `PRECONDITION: enabled — ${w}`).toBe(false);
  expect(s.op, `CONTROL: not faded — ${w}`).toBe(1);
  expect(s.fg, `CONTROL: the value is --text — ${w}`).toBe(s.tok.text);
  expect(s.styles, `CONTROL: four solid edges — ${w}`).toEqual(["solid", "solid", "solid", "solid"]);
  expect(s.colours, `CONTROL: edges in --${edge} — ${w}`).toEqual([s.tok[edge], s.tok[edge], s.tok[edge], s.tok[edge]]);
}

/**
 * The ink of a crop of `locator` (the pixel farthest from the crop's commonest
 * colour), decoded in the page: a Blob, createImageBitmap, an OffscreenCanvas.
 * `what`: "arrow" (a select's right 28 px) or "text" (the content box, short of
 * a date field's picker region).
 */
async function inkOf(page, locator, what) {
  await locator.scrollIntoViewIfNeeded();
  const clip = await locator.evaluate((n, w) => {
    const r = n.getBoundingClientRect(), cs = getComputedStyle(n), px = (v) => parseFloat(v);
    const top = r.top + px(cs.borderTopWidth), bottom = r.bottom - px(cs.borderBottomWidth);
    if (w === "arrow") { const right = r.right - px(cs.borderRightWidth); return { x: right - 28, y: top, width: 28, height: bottom - top }; }
    const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    return { x: left, y: top + 2, width: Math.max(20, r.width - px(cs.paddingLeft) - px(cs.paddingRight) - 48), height: bottom - top - 4 };
  }, what);
  const png = await page.screenshot({ clip, animations: "disabled" });
  const data = await page.evaluate(async (bytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext("2d");
    g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data);
  }, [...png]);
  const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) { const k = `${data[i]},${data[i + 1]},${data[i + 2]}`; counts.set(k, (counts.get(k) || 0) + 1); }
  const fill = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  // The ink is the pixel farthest from the fill by the SUM of its channels: by
  // the largest one alone, a coloured antialiasing fringe can tie with the core.
  const sum = (a, b) => a.reduce((t, v, i) => t + Math.abs(v - b[i]), 0);
  let ink = fill, best = -1, far = 0;
  for (let i = 0; i < data.length; i += 4) {
    const p = [data[i], data[i + 1], data[i + 2]], d = sum(p, fill);
    if (dist(p, fill) > 40) far++;
    if (d > best) { best = d; ink = p; }
  }
  return { ink, fill, far, dist };
}
const rgbList = (s) => (String(s).match(/[\d.]+/g) || []).slice(0, 3).map(Number);

/** The disabled control's ink is nearer --muted than --text (and drawn at all). */
async function expectMutedInk(page, locator, what, why) {
  const s = await stateOf(locator);
  const x = await inkOf(page, locator, what);
  const m = rgbList(s.tok.muted), t = rgbList(s.tok.text);
  const w = `${why}: ink ${x.ink}, fill ${x.fill}, ${x.far} inked pixels; --muted ${m}, --text ${t}`;
  expect(x.far, `anti-vacuity: the crop holds a glyph — ${w}`).toBeGreaterThanOrEqual(20);
  expect(x.dist(x.ink, m), `drawn in --muted, not --text — ${w}`).toBeLessThan(x.dist(x.ink, t));
  // The glyph's core is the ink itself: a faded glyph is a blend toward the fill.
  expect(x.dist(x.ink, m), `drawn in --muted at full strength — ${w}`).toBeLessThanOrEqual(12);
}

let F;

test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const h = H(csrf);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const mk = async (slug) => {
    const email = `dfu-${slug}-${stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    const r = await registerPost(anon, "/api/register", { headers: H(ac), data: {
      firstName: "Field", lastName: "Owner", nickname: `dfu_${slug}_${stamp}`.slice(0, 40), email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    }});
    if (r.status() >= 400) throw new Error(`register ${email}: ${r.status()} ${await r.text()}`);
    await anon.dispose();
    const u = (await (await api.get("/api/admin/participants?limit=500")).json()).participants.find((p) => p.email === email);
    expect(u, `created ${email}`).toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: h });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: h });
    return { id: u.id, email };
  };
  const viewer = await mk("viewer");      // the regular admin whose screens we read
  const target = await mk("target");      // a privileged peer: View Profile, every field read-only
  const plain = await mk("plain");        // a participant: filled fields locked, blank ones open
  for (const [u, role] of [[viewer, "admin"], [target, "admin"]]) {
    const r = await api.post(`/api/admin/participants/${u.id}/role`, { headers: h, data: { role } });
    expect(r.ok(), `role ${role} for ${u.email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  }

  const mkComp = async (name, kind, startOffsetMs, extra = {}) => {
    const r = await api.post("/api/admin/competitions", { headers: h, data: {
      name: `${name} ${stamp}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() + startOffsetMs).toISOString(), duration_minutes: 60, ...extra,
    }});
    expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).competition;
  };
  const ended = await mkComp("DFU ended", "booth", -5 * 60e3);
  const end = await api.post(`/api/admin/competitions/${ended.id}/end-now`, { headers: h });
  expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
  const endedRow = (await (await api.get("/api/admin/competitions")).json()).find((c) => c.id === ended.id);
  expect(endedRow && endedRow.ended_at, "PRECONDITION: the event was ended").toBeTruthy();
  const upcoming = await mkComp("DFU upcoming", "booth", 2 * 864e5);

  const mkSessions = async (name, firstOffsetMs) => {
    const comp = await mkComp(name, "tournament", 864e5);
    const slots = {};
    for (const [label, off] of [["Live", firstOffsetMs], ["Later", 2 * 864e5]]) {
      const r = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: h, data: {
        name: label, start_time: new Date(Date.now() + off).toISOString(), duration_minutes: 60,
      }});
      expect(r.ok(), `session ${label} on ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
      slots[label] = (await r.json()).timeslot.id;
    }
    return { ...comp, slots };
  };
  const started = await mkSessions("DFU started", -5 * 60e3);
  const notStarted = await mkSessions("DFU two later", 864e5);

  const mkTask = async (title) => {
    const r = await api.post("/api/admin/tasks", { headers: h, data: {
      title: `${title} ${stamp}`, description: "<p>Locked text</p>", difficulty: "easy", answer_type: "text",
      correct_answer: "alpha", status: "published",
    }});
    expect(r.ok(), `create ${title}: ${r.status()} ${await r.text()}`).toBeTruthy();
    const j = await r.json();
    return j.task || j;
  };
  const locked = await mkTask("DFU locked");
  const unlocked = await mkTask("DFU open");
  // Set the lock explicitly (the route toggles): read, then toggle only if needed.
  const listed = await (await api.get("/api/admin/tasks")).json();
  const row = (Array.isArray(listed) ? listed : listed.tasks || []).find((t) => t.id === locked.id);
  if (!row.locked) {
    const r = await api.post(`/api/admin/tasks/${locked.id}/lock`, { headers: h });
    expect((await r.json()).locked, "the challenge is now locked").toBe(1);
  }
  await api.dispose();
  F = { viewer, target, plain, ended, upcoming, started, notStarted, locked, unlocked };
});

test.describe("disabled fields on real screens", () => {
  test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: "reduce" }); });

  test("View Profile of a privileged account is read-only at full strength; a regular admin's blank field on a participant is the enabled control in the same dialog", async ({ page }) => {
    await loginViaApi(page, F.viewer.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await clickTab(page, "Participants");
    const inc = page.locator("#p-include-admins");
    if (await inc.isVisible().catch(() => false) && !(await inc.isChecked())) await inc.check();
    await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window.S?.adminParticipantsData || []).some((p) => p.id === id)), [F.target.id, F.plain.id]),
      { timeout: 20000, message: "both accounts are in the People model" }).toBe(true);

    await page.evaluate((id) => window.adminEditProfile(id), F.target.id);
    const ov = page.locator("#admin-profile-overlay");
    await opened(page, ov, "#admin-profile-overlay");
    await expect(ov, "PRECONDITION: the dialog says it is read-only").toContainText("Read-only view.");
    const fields = ov.locator('input:not([type="checkbox"]):not([type="radio"]):disabled, select:disabled');
    const n = await fields.count();
    expect(n, "PRECONDITION: the read-only dialog holds its disabled fields").toBeGreaterThanOrEqual(10);
    await expect(ov.locator("#adp-avatar-upload"), "PRECONDITION: the file input is one of them").toBeDisabled();
    for (const mode of MODES) {
      await paintMode(page, mode);
      for (let i = 0; i < n; i++) {
        const f = fields.nth(i);
        if (!(await f.isVisible())) continue;
        await expectLockedField(f, `View Profile ${await f.getAttribute("id")} (${mode})`);
      }
      // The avatar pictures keep their recorded fade (operator ruling, 25 Nov 2026: kept as they are).
      const av = await ov.locator(".avatar-grid .avatar-option").first().evaluate((e) => getComputedStyle(e).opacity);
      expect(av, `the avatar pictures keep their recorded fade (${mode})`).toBe("0.5");
    }
    await page.keyboard.press("Escape");
    await expect(ov).toHaveCount(0);

    // CONTROL: the same viewer on an ordinary participant — Company is filled
    // (locked for a regular admin), Phone is blank (open).
    await page.evaluate((id) => window.adminEditProfile(id), F.plain.id);
    await opened(page, ov, "#admin-profile-overlay");
    for (const mode of MODES) {
      await paintMode(page, mode);
      await expectLockedField(ov.locator("#adp-company"), `a filled Company (${mode})`);
      await expectOpenField(ov.locator("#adp-phone"), `a blank Phone (${mode})`);
    }
  });

  test("an ended event's form shows its locked name and start at full strength; an upcoming event's form is the control", async ({ page }) => {
    await adminLogin(page);
    await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window.S?.adminCompetitionsData || []).some((c) => c.id === id)), [F.ended.id, F.upcoming.id]),
      { timeout: 20000, message: "both events are in the admin model" }).toBe(true);
    const ov = page.locator("#comp-form-overlay");
    await page.evaluate((id) => window.openCompetitionForm(id), F.ended.id);
    await opened(page, ov, "#comp-form-overlay");
    await expect(ov.locator(".comp-form-lock-note"), "PRECONDITION: the form says why").toBeVisible();
    for (const mode of MODES) {
      await paintMode(page, mode);
      for (const id of ["#comp-name", "#comp-date", "#comp-time"]) await expectLockedField(ov.locator(id), `ended ${id} (${mode})`);
      await expectMutedInk(page, ov.locator("#comp-date"), "text", `ended #comp-date digits (${mode})`);
    }
    await ov.locator('[data-action="overlay-close"]').first().click();
    await expect(ov).toHaveCount(0);
    await page.evaluate((id) => window.openCompetitionForm(id), F.upcoming.id);
    await opened(page, ov, "#comp-form-overlay");
    for (const mode of MODES) {
      await paintMode(page, mode);
      for (const id of ["#comp-name", "#comp-date", "#comp-time"]) await expectOpenField(ov.locator(id), `upcoming ${id} (${mode})`);
    }
  });

  test("a started two-session Competition's form: the locked Leaderboard select, Schedule switch and live session's start read at full strength, and the switch still refuses a press", async ({ page }) => {
    await adminLogin(page);
    await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window.S?.adminCompetitionsData || []).some((c) => c.id === id)), [F.started.id, F.notStarted.id]),
      { timeout: 20000, message: "both events are in the admin model" }).toBe(true);
    const ov = page.locator("#comp-form-overlay");
    await page.evaluate((id) => window.openCompetitionForm(id), F.started.id);
    await opened(page, ov, "#comp-form-overlay");
    const toggle = ov.locator(".comp-mode-toggle");
    await expect(toggle, "PRECONDITION: the switch is locked").toHaveClass(/\blocked\b/);
    await expect(ov.locator("#comp-mode-multi"), "PRECONDITION: Multiple sessions is chosen").toBeChecked();
    await expect(ov.locator("#comp-mode-multi")).toBeDisabled();
    await expect(ov.locator("#comp-mode-single")).toBeDisabled();
    const live = ov.locator(`.session-form-row[data-ts-id="${F.started.slots.Live}"]`);
    const later = ov.locator(`.session-form-row[data-ts-id="${F.started.slots.Later}"]`);
    await expect(live, "PRECONDITION: the live session's row").toHaveCount(1);
    await expect(later, "PRECONDITION: the later session's row").toHaveCount(1);
    for (const mode of MODES) {
      await paintMode(page, mode);
      await expectLockedField(ov.locator("#comp-lb-mode"), `#comp-lb-mode (${mode})`);
      await expectMutedInk(page, ov.locator("#comp-lb-mode"), "arrow", `#comp-lb-mode arrow (${mode})`);
      for (const cls of [".ts-date", ".ts-time"]) {
        await expectLockedField(live.locator(cls), `the live session's ${cls} (${mode})`);
        await expectOpenField(later.locator(cls), `the later session's ${cls} (${mode})`);
      }
      const t = await stateOf(toggle);
      const tw = `the Schedule switch (${mode}): ${JSON.stringify(t)}`;
      expect(t.op, `not faded — ${tw}`).toBe(1);
      expect(t.styles, `four dashed edges — ${tw}`).toEqual(["dashed", "dashed", "dashed", "dashed"]);
      expect(t.widths.every((x) => parseFloat(x) >= 1), `four drawn edges — ${tw}`).toBe(true);
      expect(t.colours, `edges in --border-strong — ${tw}`).toEqual([t.tok.strong, t.tok.strong, t.tok.strong, t.tok.strong]);
      const chosen = ov.locator('label[for="comp-mode-multi"]'), other = ov.locator('label[for="comp-mode-single"]');
      const c = await stateOf(chosen);
      const cw = `the chosen option (${mode}): ${JSON.stringify(c)}`;
      expect(c.op, `not faded — ${cw}`).toBe(1);
      expect(c.bg, `a --surface-3 well — ${cw}`).toBe(c.tok.surface3);
      expect(c.fg, `--text-2 — ${cw}`).toBe(c.tok.text2);
      expect((await textContrast(chosen)).ratio, `the chosen option reads at AA — ${cw}`).toBeGreaterThanOrEqual(4.5);
      const o = await stateOf(other);
      expect(o.op, `the other option is not faded (${mode})`).toBe(1);
      expect(o.fg, `the other option is --muted (${mode})`).toBe(o.tok.muted);
      expect((await textContrast(other)).ratio, `the other option reads at AA (${mode})`).toBeGreaterThanOrEqual(4.5);
    }
    // BEHAVIOUR: the switch no longer takes pointer-events:none; a press still changes nothing.
    await ov.locator('label[for="comp-mode-single"]').click({ force: true });
    await expect(ov.locator("#comp-mode-multi"), "a press on Single session changes nothing").toBeChecked();
    await expect(ov.locator("#comp-single-section"), "and the single-session fields stay hidden").toBeHidden();
    await ov.locator('[data-action="overlay-close"]').first().click();
    await expect(ov).toHaveCount(0);

    // CONTROL: a two-session Competition whose sessions have not started.
    await page.evaluate((id) => window.openCompetitionForm(id), F.notStarted.id);
    await opened(page, ov, "#comp-form-overlay");
    await expect(toggle, "CONTROL: an unstarted event's switch is not locked").not.toHaveClass(/\blocked\b/);
    for (const mode of MODES) {
      await paintMode(page, mode);
      await expectOpenField(ov.locator("#comp-lb-mode"), `CONTROL #comp-lb-mode (${mode})`);
      const t = await stateOf(toggle);
      expect(t.styles, `CONTROL: the switch's edge is solid (${mode})`).toEqual(["solid", "solid", "solid", "solid"]);
      expect(t.colours[0], `CONTROL: in --border (${mode})`).toBe(t.tok.border);
      const c = await stateOf(ov.locator('label[for="comp-mode-multi"]'));
      expect(c.bg, `CONTROL: the chosen option is on --accent-strong (${mode})`).toBe(c.tok.accentStrong);
      expect(c.fg, `CONTROL: with --on-accent (${mode})`).toBe(c.tok.onAccent);
    }
  });

  test("a locked challenge's editor: title, answer type, answer, the empty attempt cap's placeholder and + Accepted answer read at full strength; an unlocked challenge's editor is the control", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window.S?.adminTasksData || []).some((t) => t.id === id)), [F.locked.id, F.unlocked.id]),
      { timeout: 20000, message: "both challenges are in the admin model" }).toBe(true);
    const form = page.locator("#admin-task-form");
    const IDS = ["#tf-title", "#tf-atype", "#tf-answer", "#tf-attempt-cap"];
    await page.evaluate((id) => window.editTask(id), F.locked.id);
    await opened(page, form, null);
    await expect(page.locator("#task-form-title"), "PRECONDITION: the editor says it is locked").toContainText("Locked");
    await expect(page.locator("#tf-attempt-cap"), "PRECONDITION: the cap is empty").toHaveValue("");
    await expect(page.locator("#tf-attempt-cap")).toHaveAttribute("placeholder", "No limit");
    await expect(page.locator("#tf-add-answer"), "PRECONDITION: + Accepted answer is disabled").toBeDisabled();
    for (const mode of MODES) {
      await paintMode(page, mode);
      for (const id of IDS) await expectLockedField(page.locator(id), `locked ${id} (${mode})`);
      const ph = await page.locator("#tf-attempt-cap").evaluate((n) => {
        const p = document.createElement("span"); p.style.color = "var(--muted)"; n.parentElement.appendChild(p);
        const muted = getComputedStyle(p).color; p.remove();
        const s = getComputedStyle(n, "::placeholder");
        return { fg: s.color, op: s.opacity, muted };
      });
      expect(ph.fg, `the placeholder is --muted (${mode}): ${JSON.stringify(ph)}`).toBe(ph.muted);
      expect(ph.op, `the placeholder is at full strength (${mode})`).toBe("1");
      const add = await stateOf(page.locator("#tf-add-answer"));
      expect(add.op, `+ Accepted answer is not faded (${mode}): ${JSON.stringify(add)}`).toBe(1);
      expect(add.fg, `+ Accepted answer is --muted (${mode})`).toBe(add.tok.muted);
      expect((await textContrast(page.locator("#tf-add-answer"))).ratio, `+ Accepted answer reads at AA (${mode})`).toBeGreaterThanOrEqual(4.5);
    }
    // CONTROL: the unlocked twin, in the same editor.
    await page.evaluate((id) => window.editTask(id), F.unlocked.id);
    await expect(page.locator("#task-form-title")).not.toContainText("Locked");
    await settleFiniteAnimations(page, null);
    for (const mode of MODES) {
      await paintMode(page, mode);
      for (const id of IDS) await expectOpenField(page.locator(id), `unlocked ${id} (${mode})`);
      const add = await stateOf(page.locator("#tf-add-answer"));
      expect(add.disabled, `CONTROL: + Accepted answer applies (${mode})`).toBe(false);
      expect(add.op, `CONTROL: + Accepted answer is not faded (${mode})`).toBe(1);
    }
  });
});
