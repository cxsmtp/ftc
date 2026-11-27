"use strict";

// THE ASSIGN TO EVENTS DIALOG'S SAVE BUTTON NEVER FADES.
//
// `updateAssignSaveBtn` (public/js/features/challenges-admin.js) keeps the
// dialog's Save disabled until a box changes. It also wrote an inline opacity,
// `btn.style.opacity=changed?'1':'0.5'`, which out-ranks `.btn:disabled`, so the
// inactive button was drawn at half strength and its label composited below AA,
// against DESIGN_SYSTEM §7: "Disabled controls never fade" (`.btn:disabled` is a
// --surface-3 well with --muted text at full opacity). The button's state is now
// its `disabled` property alone, drawn by the stylesheet. The source half — no
// JavaScript writes such a fade through any expression — is the Docs-hygiene
// scanner in tests/functional-core-b.api.spec.js (tests/js-opacity-scan.js).
//
// MEASURED IN THE REAL DIALOG, opened through the real kebab, in three phases:
// at open (nothing changed), after a box is ticked, and after it is unticked
// again (the path that wrote 0.5 back), each in every look x mode x ambient
// colour:
//   * PRECONDITION — the button is disabled or enabled as the phase says, and the
//     global `:disabled{opacity:.5}` is live in this dialog (a plain disabled
//     button planted beside Save computes 0.5), so reading 1 on Save means the
//     `.btn` rule won, not that opacity went unread;
//   * NO FADE — no inline opacity, computed opacity 1, and nothing up the ancestor
//     chain fades it (`textContrast` folds every ancestor's opacity in);
//   * THE STATE — disabled is the --surface-3 fill with --muted text, enabled the
//     --accent-strong fill with --on-accent text (each token resolved by a probe in
//     the button's own cascade);
//   * AA — the label measures >= 4.5:1 on its fill.
// CONTROL: in every combination the disabled fill differs from the enabled one,
// so the two states read apart without any fade. The dialog is never saved.
//
// FIXTURES (beforeAll, through the built-in superadmin's API session, which the
// browser's sign-in then replaces — one session per principal — so nothing calls
// the API after it): two live tournaments, and one published challenge assigned
// to the first only.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, appearanceSettled } = require("./helpers");
const { adminLogin, clickTab, openKebab, findSeededTaskRow, textContrast } = require("./ui-admin-helpers");
const { makeCompetition, makeTask, assignTask } = require("./event-admin-helpers");
const { lookCombos } = require("./look-tokens");

test.use({ baseURL: BASE });

/** Paint the page as one look x mode x ambient colour, in place. */
const paint = (page, { look, theme, ambient }) => page.evaluate(([l, t, a]) => {
  const h = document.documentElement;
  h.setAttribute("data-look", l); h.setAttribute("data-theme", t);
  if (a) h.setAttribute("data-ambient", a); else h.removeAttribute("data-ambient");
}, [look, theme, ambient]);

/** Save's state in one read, with the tokens it should show resolved beside it. */
const readSave = (save) => save.evaluate((btn) => {
  const host = btn.parentElement;
  const probe = (prop, v) => {
    const p = document.createElement("span");
    p.style[prop] = v;
    host.appendChild(p);
    const c = getComputedStyle(p)[prop];
    p.remove();
    return c;
  };
  const plain = document.createElement("button");
  plain.type = "button"; plain.disabled = true; plain.textContent = "probe";
  host.appendChild(plain);
  const plainOpacity = getComputedStyle(plain).opacity;
  plain.remove();
  const cs = getComputedStyle(btn);
  return {
    disabled: btn.disabled, inline: btn.style.opacity, opacity: cs.opacity, bg: cs.backgroundColor, fg: cs.color,
    well: probe("backgroundColor", "var(--surface-3)"), muted: probe("color", "var(--muted)"),
    primary: probe("backgroundColor", "var(--accent-strong)"), onPrimary: probe("color", "var(--on-accent)"),
    plainOpacity,
  };
});

let held, spare, task;

test.describe("the Assign to Events dialog's Save button", () => {
  test.beforeAll(async () => {
    const s = await apiLogin("superadmin");
    try {
      held = await makeCompetition(s.api, s.csrf, "save-held");
      spare = await makeCompetition(s.api, s.csrf, "save-spare");
      task = await makeTask(s.api, s.csrf, "save-state");
      await assignTask(s.api, s.csrf, task.id, [held.id]);
    } finally {
      await s.api.dispose();
    }
  });

  test("rests in the --surface-3 well at full strength until a box changes, fills as the primary on a change, and returns to the well, never faded, in every look, mode and ambient colour", async ({ page }) => {
    test.setTimeout(120_000);
    // Reduced motion: a fill read right after the look changes under it is never
    // mid-transition.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, task.title);
    await expect(row.first(), `the challenge "${task.title}" is listed`).toBeVisible({ timeout: 15000 });
    await openKebab(page, row.first());
    const item = page.locator('#kebab-portal [data-action="task-assign-to-comps"]');
    await expect(item, "Assign to Events is offered").toHaveCount(1);
    await item.click();
    const overlay = page.locator("#assign-task-overlay");
    await expect(overlay, "the Assign to Events dialog opened").toBeVisible({ timeout: 20000 });
    const heldBox = overlay.locator(`input[type="checkbox"][value="${held.id}"]`);
    const spareBox = overlay.locator(`input[type="checkbox"][value="${spare.id}"]`);
    await expect(heldBox, "PRECONDITION: the holding event is listed and ticked").toBeChecked();
    await expect(spareBox, "PRECONDITION: the other event is listed and unticked").not.toBeChecked();
    await expect(spareBox, "PRECONDITION: the other event can be ticked").toBeEnabled();
    const save = overlay.locator("#assign-task-save-btn");

    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    const fills = {};
    const check = async (phase, wantDisabled) => {
      fills[phase] = {};
      for (const c of combos) {
        await paint(page, c);
        const r = await readSave(save);
        const tc = await textContrast(save);
        const why = `${phase}, ${c.label}: ${JSON.stringify(r)}; contrast ${JSON.stringify(tc)}`;
        if (r.plainOpacity !== "0.5") bad.push(`PRECONDITION: the global :disabled fade is not live on a plain disabled button — ${why}`);
        if (r.disabled !== wantDisabled) bad.push(`Save is ${r.disabled ? "disabled" : "enabled"} — ${why}`);
        if (r.inline !== "") bad.push(`an inline opacity ${r.inline} is written on Save — ${why}`);
        if (r.opacity !== "1" || tc.opacity !== 1) bad.push(`Save is faded: opacity ${r.opacity}, ${tc.opacity} through its ancestors — ${why}`);
        const [wantBg, wantFg, state] = wantDisabled
          ? [r.well, r.muted, "the disabled well (--surface-3 fill, --muted text)"]
          : [r.primary, r.onPrimary, "the primary (--accent-strong fill, --on-accent text)"];
        if (r.bg !== wantBg || r.fg !== wantFg) bad.push(`Save is not ${state} — ${why}`);
        if (!(tc.ratio >= 4.5)) bad.push(`Save's label measures ${tc.ratio}:1 on its fill — ${why}`);
        fills[phase][c.label] = r.bg;
      }
    };

    await expect(save, "PRECONDITION: nothing changed, so Save is disabled").toBeDisabled();
    await check("at open", true);

    await spareBox.check();
    await expect(save, "ticking a box enables Save").toBeEnabled();
    await check("after a change", false);

    await spareBox.uncheck();
    await expect(save, "unticking it again disables Save").toBeDisabled();
    await check("after the change is undone", true);

    expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
    // CONTROL: the two states read apart by their fill in every combination.
    for (const c of combos) {
      expect(fills["at open"][c.label], `the disabled and enabled fills differ in ${c.label}`).not.toBe(fills["after a change"][c.label]);
    }
    await overlay.locator('[data-action="overlay-close"]').click();
    await expect(overlay, "the dialog closed without saving").toHaveCount(0);
  });
});
