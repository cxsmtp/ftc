"use strict";

// v8.8.2 — THE PUBLIC-DOMAIN TAG IS OFFERED, NOT TYPED.
//
// Reported: an event admin could not see challenges "marked as public domain".
// The server rule was never broken — measured, a correctly tagged challenge is
// returned — but the value had to be typed exactly into a free-text box that
// accepts anything, so "public domain" was stored verbatim, rendered on the row
// as a tag, and granted nothing. Accept-and-ignore: a control that appears to
// work, which is worse than no control.
//
// THIS FILE IS THE ONLY LOCK ON THE FIX. public-domain-visibility.api.spec.js
// pins the RULE the chip exists to satisfy and stays green with the chip removed
// — the v8.7.7 lesson, and the reason both halves exist.
//
// The controls matter as much as the positives:
//   * "the chip applies the tag" is satisfied by a dialog that applies it to
//     everything, so an ORDINARY typed tag must still be stored as itself; and
//   * "the chip is offered" is satisfied by one offered unconditionally, so it
//     must be ABSENT once applied — a control whose only effect would be a no-op
//     is the thing this release is about.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, appearanceSettled } = require("./helpers");
const { adminLogin, clickTab, findSeededTaskRow } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = "public-domain";
const uniq = () => `pdui${Date.now().toString(36)}${Math.floor(performance.now() * 1000) % 9973}`;

async function makeTask(api, csrf, label) {
  const title = `PD ${label} ${uniq()}`;
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" },
  });
  expect(r.ok(), `create task: ${await r.text()}`).toBeTruthy();
  return { id: (await r.json()).id, title };
}

/** The stored tags, read back from the server rather than from the DOM. */
async function storedTags(page, taskId) {
  const r = await page.request.get("/api/admin/tasks");
  expect(r.ok(), `tasks: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the challenge is in the list").toBeTruthy();
  return row.tags || [];
}

async function openTagDialog(page, title) {
  const row = await findSeededTaskRow(page, title);
  await expect(row.first(), `the challenge "${title}" is visible`).toBeVisible();
  await row.first().locator('[data-action="task-tag-add"]').click();
  const input = page.locator("#task-tag-input");
  await expect(input, "the Add Tag dialog opened").toBeVisible({ timeout: 15000 });
  return input;
}

test.describe("v8.8.2 — the public-domain tag is offered as a chip", () => {
  /** @type {any} */ let sa;
  let target, ordinary;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const l = await apiLogin("superadmin");
    sa = l;
    target = await makeTask(l.api, l.csrf, "target");
    ordinary = await makeTask(l.api, l.csrf, "ordinary");
  });

  test("one click applies EXACTLY the reserved tag, and it is explained", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await openTagDialog(page, target.title);

    const chip = page.locator(`#task-tag-reserved [data-tag="${TAG}"]`);
    await expect(chip, "the reserved tag is offered without typing").toHaveCount(1);
    await expect(chip).toHaveText(TAG);
    // Withheld WITH its reason is this codebase's rule; OFFERED with its reason
    // is the same rule — a chip that silently changes who can see the challenge
    // would be worse than the typing it replaces.
    await expect(page.locator("#task-tag-reserved"), "…and says what it does")
      .toContainText(/shared pool/i);
    await expect(page.locator("#task-tag-reserved"), "…and warns about the near miss")
      .toContainText(/public domain/i);

    await chip.click();
    await expect(page.locator("#task-tag-input"), "the dialog closes on success").toHaveCount(0);

    const tags = await storedTags(page, target.id);
    expect(tags, "the STORED value is the reserved tag, character for character").toContain(TAG);
    expect(tags.some(t => t !== TAG && /public/i.test(t)),
      "…and no near-miss variant was written").toBe(false);
  });

  test("the chip is ABSENT once applied — no control whose only effect is a no-op", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    // Applied by the previous test; asserted as a precondition rather than assumed.
    expect(await storedTags(page, target.id), "precondition: already tagged").toContain(TAG);

    await openTagDialog(page, target.title);
    await expect(page.locator("#task-tag-reserved"),
      "the reserved block is gone once the tag is on").toHaveCount(0);
  });

  test("CONTROL — an ordinary typed tag is still stored as itself", async ({ page }) => {
    // Without this, "the chip applies public-domain" is equally satisfied by a
    // dialog that applies it to everything typed.
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const input = await openTagDialog(page, ordinary.title);
    await input.fill("needs-review");
    await page.locator("#task-tag-save-btn").click();
    await expect(page.locator("#task-tag-input")).toHaveCount(0);

    const tags = await storedTags(page, ordinary.id);
    expect(tags, "the typed tag is stored verbatim").toContain("needs-review");
    expect(tags, "…and the reserved tag was NOT applied").not.toContain(TAG);
  });
});

// ── v8.8.3 ──────────────────────────────────────────────────────────────────
//
// The chip was DISCOVERY, and discovery alone was not enough: the same report
// came back after v8.8.2 shipped it, from an operator whose challenge already
// carried `public domain` with a space. So the near miss is now REFUSED at the
// write, and any that is already stored is MARKED on the row with a one-click
// fix.
//
// These are browser tests because neither half can be seen from the API: the
// refusal's whole point is what the operator is shown when it fires, and the
// marker is client-side rendering over a row the server returns unchanged.
test.describe("v8.8.3 — a near miss is refused, and an existing one is fixable", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  test("typing a near miss is refused, the dialog STAYS OPEN, and the chip is right there", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "refuse");
    await adminLogin(page);
    await clickTab(page, "challenges");

    const input = await openTagDialog(page, t.title);
    await input.fill("public domain");
    await page.locator("#task-tag-save-btn").click();

    // The refusal names the reserved spelling — an operator who typed the natural
    // English form has to be told which form does the work.
    await expect(page.locator("#toast-stack"), "the refusal is reported")
      .toContainText(TAG, { timeout: 10000 });

    // AND THE DIALOG IS STILL OPEN. This is the half that makes the message
    // actionable: it names the chip as the remedy, and the chip is in this
    // dialog. Closing on a refusal sent the operator away to fetch the one
    // control they had just been told to use.
    await expect(input, "the dialog stayed open after the refusal").toBeVisible();
    const chip = page.locator(`#task-tag-reserved [data-tag="${TAG}"]`);
    await expect(chip, "the chip is on screen, ready to click").toBeVisible();

    // Nothing was stored — a refusal, never a silent fold to the reserved tag.
    expect(await storedTags(page, t.id), "the near miss was not stored").toEqual([]);

    // And the chip still works from the same open dialog.
    await chip.click();
    await expect.poll(() => storedTags(page, t.id), { timeout: 10000 }).toContain(TAG);
  });

  test("a near miss ALREADY on the row is marked inert and Fix repairs it", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "marked");

    // Planted directly, because the route now refuses it — which is the point.
    // This is the state a challenge tagged before v8.8.3 is in, and the state the
    // deliberately-unguarded importer and version-restore paths can still produce.
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(t.id, "public domain"); }
    finally { db.close(); }

    await adminLogin(page);
    await clickTab(page, "challenges");
    const row = await findSeededTaskRow(page, t.title);
    await expect(row.first(), "the challenge is listed").toBeVisible();

    // PRECONDITION, asserted rather than assumed: without it "the Fix link is
    // present" would be satisfied by a build that renders it on every tag.
    const inert = row.first().locator(".tag-inert");
    await expect(inert, "the inert tag is marked").toBeVisible();
    await expect(inert, "the marker names the tag it is about").toContainText("public domain");

    await inert.locator(".tag-fix").click();
    await page.locator("#modal-confirm-btn").click();

    await expect.poll(() => storedTags(page, t.id), { timeout: 15000 }).toEqual([TAG]);
  });

  test("v8.11.6: the inert chip keeps its palette in the LIGHT theme", async ({ page }) => {
    // The light rule `html[data-theme="light"] .tag{background:var(--accent);
    // color:#fff}` is (0-2-1) and later in source, so it BEAT `.tag.tag-inert`
    // (0-2-0) — and the chip took the solid accent fill it was written to avoid.
    // Measured consequences on this exact markup: the warning icon 1.16:1, the
    // Fix link 1.25:1 at rest and **1.00:1 on hover** — the control and its
    // background the identical colour, i.e. an invisible repair affordance on the
    // one chip whose whole job is to say something is wrong.
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "lightpal");
    const db = new Database(TEST_DB_PATH);
    try { db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(t.id, "public domain"); }
    finally { db.close(); }

    await adminLogin(page);
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
      try { localStorage.setItem("hck-theme", "light"); } catch (_) {}
    });
    await clickTab(page, "challenges");
    const row = await findSeededTaskRow(page, t.title);
    const inert = row.first().locator(".tag-inert");
    await expect(inert, "the inert tag is marked").toBeVisible();

    // Measured inside a retry: the table can re-render between Playwright
    // resolving the element and running this function, and a detached node's
    // computed styles are all "" (failed twice in CI). A null answer re-resolves.
    let m = null;
    await expect(async () => { m = await inert.evaluate((el) => {
      if (!el.isConnected) return null;
      const px = (c) => { const p = c.match(/[\d.]+/g).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const over = (t2, b) => ({ r: t2.r * t2.a + b.r * (1 - t2.a), g: t2.g * t2.a + b.g * (1 - t2.a), b: t2.b * t2.a + b.b * (1 - t2.a), a: 1 });
      const bgOf = (n) => { const st = [];
        for (let x = n; x && x.nodeType === 1; x = x.parentElement) {
          const c = px(getComputedStyle(x).backgroundColor);
          if (c.a > 0) st.push(c); if (c.a >= 1) break; }
        let cur = st.length && st[st.length - 1].a >= 1 ? st.pop() : { r: 255, g: 255, b: 255, a: 1 };
        for (let i = st.length - 1; i >= 0; i--) cur = over(st[i], cur); return cur; };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (a, b) => { const [x, y] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
        return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
      const fix = el.querySelector(".tag-fix");
      return { chipBg: getComputedStyle(el).backgroundColor, fix: ratio(px(getComputedStyle(fix).color), bgOf(fix)) };
    }); expect(m, "the chip was re-rendered mid-measurement; measuring again").not.toBeNull(); }).toPass({ timeout: 10000 });

    // The accent FILL is the defect's fingerprint — the intended muted surface is
    // what says "inert", and losing it is what collapsed every ratio on the chip.
    expect(m.chipBg, `the inert chip must not take the solid accent fill (got ${m.chipBg})`)
      .not.toBe("rgb(124, 58, 237)");
    expect(m.fix, `the Fix link must be readable in light (measured ${m.fix}:1)`).toBeGreaterThanOrEqual(4.5);
  });

  test("CONTROL — an ordinary tag is NOT marked inert", async ({ page }) => {
    // Without this, "the marker appears" is equally satisfied by a build that
    // marks every tag on every row, which would be a worse product than the
    // silence it replaced.
    const sa = await apiLogin("superadmin");
    const t = await makeTask(sa.api, sa.csrf, "ordinary");
    const r = await sa.api.post(`/api/admin/tasks/${t.id}/tags`, { headers: H(sa.csrf), data: { tag: "reuse-2026" } });
    expect(r.ok(), `tag: ${await r.text()}`).toBeTruthy();

    await adminLogin(page);
    await clickTab(page, "challenges");
    const row = await findSeededTaskRow(page, t.title);
    await expect(row.first()).toBeVisible();
    await expect(row.first().locator(".tag"), "the ordinary tag rendered").toContainText("reuse-2026");
    await expect(row.first().locator(".tag-inert"), "an ordinary tag carries no inert marker").toHaveCount(0);
  });
});
