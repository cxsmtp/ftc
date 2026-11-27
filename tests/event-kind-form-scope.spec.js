// @ts-check
//
// THE ONE CREATE FORM, AND THE RULE IT EXISTS TO ENFORCE: the form shows ONLY
// the settings the selected event kind can use. Every event starts on the New
// event page (a blank starter per kind, or a template); the kind is then a field
// on the form, and changing it re-renders the form for the new kind.
//
// This is the lock for that rule, and it is deliberately a MATRIX rather than a
// handful of spot-checks. The failure this guards against is not "a control is
// missing" — it is a control that is PRESENT for a kind the server refuses it
// for, which reads as a working setting right up until the save 400s or, worse,
// silently stores something nothing honours. Before this release the platform
// had five of those (a Booth Event offering multi-session mode, a Program
// offering reveal-answers, group leaderboard and trusted networks, and a Booth
// Event offering presence recording), plus two settings it accepted and ignored.
//
// THE ANTI-VACUITY CONTROL IS THE POINT. "the control is absent for a Program"
// is equally satisfied by a form that renders nothing at all, so every row of
// the matrix is asserted in BOTH directions: absent where the policy forbids it
// AND present where the policy allows it. A build that dropped a control
// entirely fails the second half; a build that dropped the gating fails the
// first. Neither half alone is worth anything.
const { test, expect } = require("./isolated-test");
const { freshCtx, apiLogin, getSuperadminPass, BASE, settleFiniteAnimations, appearanceSettled } = require("./helpers");
const { adminLogin, clickTab, openKebab, filterComps, openCompCreateForm, AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const TAG = `wz${Date.now().toString(36)}`;

// THE MATRIX. One row per kind-gated control, naming the policy key that decides
// it and the server refusal that key mirrors — so a reader can check the client
// against the server without leaving this file.
//
// `kinds` lists the kinds for which the control MUST render. Every kind not
// listed must NOT render it. Both directions are asserted for every row, which
// is what makes each entry a claim rather than a description.
const MATRIX = [
  { sel: "#comp-mode-multi",        kinds: ["tournament"],            why: "sessions:'many'      → routes/sessions.js sessions_forbidden" },
  { sel: "#comp-multi-section",     kinds: ["tournament"],            why: "sessions:'many'      → a session list a sessionless kind cannot have" },
  { sel: "#comp-lb-mode",           kinds: ["tournament"],            why: "sessions:'many'      → a leaderboard MODE scopes slots; with zero slots it names nothing" },
  { sel: "#comp-dur-box",           kinds: ["booth", "tournament"],   why: "schedule:'window'    → resolveSchedule duration_not_accepted" },
  { sel: "#comp-deadline-box",      kinds: ["program"],               why: "schedule:'deadline'  → resolveSchedule deadline_not_accepted" },
  { sel: "#comp-reveal-answers",    kinds: ["booth", "tournament"],   why: "reveal_answers       → reveal_answers_forbidden" },
  { sel: "#comp-group-leaderboard", kinds: ["booth", "tournament"],   why: "group_leaderboard    → group_leaderboard_forbidden" },
  { sel: "#comp-measure-presence",  kinds: ["tournament", "program"], why: "measure_presence     → measure_presence_forbidden" },
  // The one row where two policy keys disagree, and the reason it is here: a
  // Program MAY record time on platform (that is reporting) and can never use it
  // to break a tie (it does not rank). The server ACCEPTS time_basis there — it
  // is one of only two settings the platform accepts-and-ignores — so this is
  // the client refusing to offer a control that would change nothing.
  { sel: "#comp-time-basis",        kinds: ["tournament"],            why: "measure_presence AND ranking_enabled" },
  { sel: "#comp-trusted-ips",       kinds: ["booth", "tournament"],   why: "trusted_networks     → trusted_networks_forbidden" },
  // Use my current address goes wherever the field it fills goes (a superadmin
  // holds events.edit, the one other condition it renders on).
  { sel: "#comp-trusted-ips-mine",  kinds: ["booth", "tournament"],   why: "trusted_networks     → trusted_networks_forbidden" },
];

// Controls that must render for EVERY kind. Without these the matrix above is
// satisfiable by a form that renders almost nothing, and they are also the
// answer to "did we over-scope?" — each was checked against the policy table and
// has no kind-derived rule.
const UNIVERSAL = ["#comp-name", "#comp-date", "#comp-time", "#comp-tz",
  "#comp-attempt-cap", "#comp-internal",
  // v8.12.0 — "Staff can compete" is a decision about WHO is on the board, which
  // every kind has (a Program's certificate rests on it as much as a board does),
  // so it renders for all three and carries no policy key.
  "#comp-staff-compete",
  "#comp-cxone-disabled", "#comp-cxone-key", "#comp-cxone-group"];

const KINDS = ["booth", "tournament", "program"];

test.describe("v8.2.0 — the create wizard scopes the form to the event kind", () => {
  test("+ New Event opens the New event page: a blank starter per kind, no form until one is picked", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await page.click('[data-action="open-competition-form"]');
    await page.locator("#admin-templates-tab").waitFor({ state: "visible", timeout: 15000 });

    // No form yet: the kind is chosen by picking a starter, so there is never a
    // form whose kind nobody picked.
    expect(await page.locator("#comp-form-overlay").count(),
      "the page does not open the form behind it").toBe(0);

    const cards = page.locator('#tpl-kind-cards [data-action="new-event-start"]');
    await expect(cards, "exactly the three kinds").toHaveCount(3);
    for (const k of KINDS) {
      await expect(page.locator(`#tpl-kind-cards [data-action="new-event-start"][data-kind="${k}"]`),
        `a blank starter for ${k}`).toHaveCount(1);
    }
    // The old kind chooser dialog is gone: one place, not two.
    expect(await page.locator("#comp-kind-overlay").count(), "no separate kind chooser").toBe(0);

    await page.locator('#tpl-kind-cards [data-action="new-event-start"][data-kind="program"]').click();
    await page.waitForSelector("#comp-form-overlay", { timeout: 15000 });

    // The kind is a FIELD on the form, pre-selected from the starter, and the
    // hidden field every collector reads agrees with it.
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="program"]')).toBeChecked();
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"]'), "one option per kind").toHaveCount(3);
    expect(await page.locator("#comp-kind").inputValue()).toBe("program");
    await expect(page.locator("#comp-form-title")).toHaveText("New event");
  });

  test("changing the type on the form re-renders it for that kind and keeps what was typed", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page, "booth");
    await page.locator("#comp-name").fill(`${TAG} Retype`);
    await page.locator("#comp-date").fill("2033-04-05");
    await page.locator("#comp-time").fill("10:30");
    await expect(page.locator("#comp-dur-box"), "a Booth Event has a duration").toHaveCount(1);

    await page.locator('#comp-form-overlay label.kind-seg-opt:has(input[value="program"])').click();
    await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000 }).toBe("program");
    expect(await page.locator("#comp-form-overlay").count(), "the form is replaced, never stacked").toBe(1);
    // A different kind really does produce a different form...
    await expect(page.locator("#comp-deadline-box"), "a Program has a deadline").toHaveCount(1);
    await expect(page.locator("#comp-dur-box"), "and no duration").toHaveCount(0);
    // ...and what the admin typed survives the re-render.
    await expect(page.locator("#comp-name")).toHaveValue(`${TAG} Retype`);
    await expect(page.locator("#comp-date")).toHaveValue("2033-04-05");
    await expect(page.locator("#comp-time")).toHaveValue("10:30");
  });

  test("a change of type keeps the ticked challenges, and asks first when it would drop a setting the admin changed", async ({ page }) => {
    const { api, csrf } = await freshCtx();
    const lg = await api.post("/api/login", { headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lg.ok(), `superadmin login: ${lg.status()}`).toBeTruthy();
    const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const title = `${TAG} kept tick ${Date.now().toString(36)}`;
    const t = await api.post("/api/admin/tasks", { headers: H(c2), data: { title, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } });
    expect(t.ok(), `task: ${await t.text()}`).toBeTruthy();
    await api.dispose();

    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page, "tournament");
    await page.locator("#comp-name").fill(`${TAG} Ticks`);
    await page.locator("#comp-date").fill("2033-04-05");
    await page.locator("#comp-ch-search").fill(title);
    const box = page.locator("#comp-ch-list .picker-row", { hasText: title }).locator('input[type="checkbox"]');
    await box.check();
    await expect(page.locator("#comp-ch-count")).toContainText("1 ticked");
    const pick = (k) => page.locator(`#comp-form-overlay label.kind-seg-opt:has(input[value="${k}"])`).click();

    // Nothing the re-render would drop has changed: no question, and the tick
    // goes with the new type.
    await pick("booth");
    await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000 }).toBe("booth");
    await expect(page.locator("#modal-overlay.open"), "an untouched form changes type without asking").toHaveCount(0);
    await expect(page.locator("#comp-ch-count"), "the ticks are carried").toContainText("1 ticked", { timeout: 15000 });
    await expect(page.locator("#comp-ch-list .picker-row", { hasText: title }).locator('input[type="checkbox"]')).toBeChecked();

    // A setting the re-render WOULD drop: it asks, and Cancel keeps everything.
    await page.locator("#comp-attempt-cap").fill("3");
    await pick("program");
    const modal = page.locator("#modal-overlay.open");
    await expect(modal.locator("#modal-title")).toHaveText("Change type to Program?", { timeout: 10000 });
    await expect(modal).toContainText("goes back to the defaults");
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#comp-kind"), "Cancel keeps the type").toHaveValue("booth");
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="booth"]'), "and the control shows it").toBeChecked();
    await expect(page.locator("#comp-attempt-cap"), "and the setting").toHaveValue("3");

    // Confirmed: the new type's defaults, the ticks still carried.
    await pick("program");
    await expect(modal.locator("#modal-title")).toHaveText("Change type to Program?", { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000 }).toBe("program");
    await expect(page.locator("#comp-attempt-cap"), "the dropped setting is back to its default").toHaveValue("");
    await expect(page.locator("#comp-ch-count")).toContainText("1 ticked", { timeout: 15000 });
    await expect(page.locator("#comp-name")).toHaveValue(`${TAG} Ticks`);
  });

  // The confirm asks only when the admin CHANGED something the re-render would
  // drop: a form opened from any type and only named and dated (the carried
  // values) changes type at once, though a Program's form seeds a deadline and
  // a Booth Event's an automatic late-entry deadline of its own.
  test("an untouched form of any type changes type without asking", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    for (const [from, to] of [["program", "booth"], ["booth", "tournament"], ["tournament", "program"]]) {
      await openCompCreateForm(page, from);
      await page.locator("#comp-name").fill(`${TAG} From ${from}`);
      await page.locator("#comp-date").fill("2033-04-05");
      await page.locator("#comp-time").fill("10:30");
      await page.locator(`#comp-form-overlay label.kind-seg-opt:has(input[value="${to}"])`).click();
      await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000, message: `${from} → ${to}` }).toBe(to);
      await expect(page.locator("#modal-overlay.open"), `${from} → ${to}: nothing the admin set is dropped, so no question`).toHaveCount(0);
      await expect(page.locator("#comp-name"), `${from} → ${to}: the name is carried`).toHaveValue(`${TAG} From ${from}`);
      await page.locator('#comp-form-overlay [data-action="overlay-close"]').first().click();
      await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
    }
  });

  test("the create form keeps rarely used settings in a collapsed Advanced section", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page, "tournament", { advanced: false });
    const adv = page.locator("#comp-advanced");
    await expect(adv).toHaveCount(1);
    expect(await adv.evaluate((el) => el.open), "collapsed on a create").toBe(false);
    // The essentials stay on screen; the advanced controls exist but are folded.
    for (const sel of ["#comp-name", "#comp-date", "#comp-dur-box", "#comp-reveal-answers", "#comp-attempt-cap"]) {
      await expect(page.locator(`#comp-form-overlay ${sel}`), `${sel} is an essential`).toBeVisible();
    }
    for (const sel of ["#comp-group-leaderboard", "#comp-staff-compete", "#comp-internal", "#comp-trusted-ips", "#comp-cxone-disabled"]) {
      await expect(page.locator(`#comp-advanced ${sel}`), `${sel} lives in Advanced`).toHaveCount(1);
      await expect(page.locator(`#comp-advanced ${sel}`), `${sel} is folded away`).toBeHidden();
    }
    await adv.locator("summary").click();
    await expect(page.locator("#comp-advanced #comp-staff-compete"), "opening it shows them").toBeVisible();
    // Every non-obvious field carries a "?" tip.
    for (const key of ["event.kind", "event.duration", "event.reveal", "event.attempts", "event.staff", "event.cxone"]) {
      await expect(page.locator(`#comp-form-overlay [data-help="${key}"] button[data-action="help-tip"]`), `a tip for ${key}`).toHaveCount(1);
    }
    // The duplicate end-time inputs are gone; the end is shown, read-only.
    await expect(page.locator("#comp-end-date")).toHaveCount(0);
    await expect(page.locator("#comp-end-preview")).toContainText("Ends:");
  });

  // Operator ruling, 14 Nov 2026: the Checkmarx One opt-out stays folded in
  // Advanced on a create, and the section's always-visible summary line says
  // whether accounts will be created, following the box; the Create confirmation
  // says it too. A Competition's seed is ON, a Booth Event's OFF (the controls).
  test("the folded Advanced summary line and the Create confirmation say whether Checkmarx One accounts will be created", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    const line = page.locator("#comp-advanced > summary #comp-advanced-cxone");
    const confirmCxone = async () => {
      await page.locator('#comp-form-overlay [data-action="comp-save"]').click();
      const modal = page.locator("#modal-overlay.open");
      await expect(modal.locator("#modal-title")).toHaveText(/^Create /, { timeout: 10000 });
      const text = (await modal.locator("#comp-confirm-cxone").innerText()).trim();
      await page.locator("#modal-cancel-btn").click();
      await expect(modal).toHaveCount(0);
      return text;
    };
    const fill = async (name) => {
      await page.locator("#comp-name").fill(name);
      await page.locator("#comp-date").fill("2033-04-05");
      await page.locator("#comp-time").fill("10:30");
    };

    await openCompCreateForm(page, "tournament", { advanced: false });
    expect(await page.locator("#comp-advanced").evaluate((el) => el.open), "PRECONDITION: Advanced is folded").toBe(false);
    await expect(page.locator("#comp-advanced #comp-cxone-disabled"), "PRECONDITION: the box itself is folded away").toBeHidden();
    await expect(line, "a Competition creates accounts, and the folded section says so").toHaveText("Checkmarx One accounts: on");
    await expect(line).toBeVisible();
    await fill(`${TAG} Cx on`);
    expect(await confirmCxone(), "the confirmation says it too").toBe("Checkmarx One accounts: on — one is created for everyone who joins.");
    // The line follows the box.
    await page.locator("#comp-advanced > summary").click();
    await page.locator("#comp-cxone-disabled").check();
    await expect(line, "ticked: off").toHaveText("Checkmarx One accounts: off");
    expect(await confirmCxone(), "…and so does the confirmation").toBe("Checkmarx One accounts: off.");
    await page.locator("#comp-cxone-disabled").uncheck();
    await expect(line, "unticked: on again").toHaveText("Checkmarx One accounts: on");
    await page.locator('#comp-form-overlay [data-action="overlay-close"]').first().click();
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0);

    // A Booth Event's seed is the other way round.
    await openCompCreateForm(page, "booth", { advanced: false });
    await expect(line, "a Booth Event creates none").toHaveText("Checkmarx One accounts: off");
    await fill(`${TAG} Cx booth`);
    expect(await confirmCxone()).toBe("Checkmarx One accounts: off.");
    // A type change re-seeds the box, and the line follows it.
    await page.locator('#comp-form-overlay label.kind-seg-opt:has(input[value="tournament"])').click();
    await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000 }).toBe("tournament");
    await expect(line, "a Competition again: on").toHaveText("Checkmarx One accounts: on");
    await page.locator('#comp-form-overlay [data-action="overlay-close"]').first().click();
  });

  // THE LOCK. Every row of the matrix, both directions, for all three kinds.
  for (const kind of KINDS) {
    test(`step 2 for a ${kind} renders EXACTLY the controls that kind can use`, async ({ page }) => {
      await adminLogin(page);
      await clickTab(page, "Events");
      await openCompCreateForm(page, kind);

      for (const row of MATRIX) {
        const want = row.kinds.includes(kind);
        const n = await page.locator(`#comp-form-overlay ${row.sel}`).count();
        expect(n, `${kind}: ${row.sel} must be ${want ? "PRESENT" : "ABSENT"} — ${row.why}`)
          .toBe(want ? 1 : 0);
      }

      for (const sel of UNIVERSAL) {
        expect(await page.locator(`#comp-form-overlay ${sel}`).count(),
          `${kind}: ${sel} is kind-independent and must render`).toBe(1);
      }
    });
  }

  // Without this, "absent for a Program" is satisfied by a build that renders no
  // controls at all. It asserts the matrix DISCRIMINATES: every gated control is
  // present for at least one kind and absent for at least one other, so no row
  // is a constant.
  test("every row of the matrix actually discriminates between kinds", async () => {
    for (const row of MATRIX) {
      expect(row.kinds.length, `${row.sel}: must render for at least one kind`).toBeGreaterThan(0);
      expect(row.kinds.length, `${row.sel}: must be hidden for at least one kind, or it belongs in UNIVERSAL`)
        .toBeLessThan(KINDS.length);
      for (const k of row.kinds) expect(KINDS, `${row.sel}: unknown kind ${k}`).toContain(k);
    }
  });

  // The New event page and the one form each get their own scan.
  test("the New event page and the create form have no moderate+ axe violations", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await page.click('[data-action="open-competition-form"]');
    await page.locator('#tpl-kind-cards [data-action="new-event-start"]').first().waitFor({ state: "visible", timeout: 15000 });

    const scan = async (sel, what) => {
      await settleFiniteAnimations(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).include(sel).analyze();
      const bad = (results.violations || []).filter((v) => AXE_GATED_IMPACTS.has(v.impact));
      expect(bad, `${what} axe violations: ${[...new Set(bad.map((v) => v.id))].join(", ")}`).toEqual([]);
    };
    await scan("#admin-templates-tab", "New event page");

    // Every starter's control is a real, focusable button in its card's foot
    // (the card itself holds a list, which no button may).
    for (const k of KINDS) {
      const ctl = page.locator(`#tpl-kind-cards .tpl-kind[data-kind="${k}"] button[data-action="new-event-start"][data-kind="${k}"]`);
      await ctl.focus();
      expect(await ctl.evaluate((el) => el === document.activeElement),
        `${k}: the starter takes keyboard focus`).toBe(true);
    }
    await page.locator('#tpl-kind-cards [data-action="new-event-start"][data-kind="tournament"]').click();
    await page.locator("#comp-name").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#comp-advanced summary").click();
    await scan("#comp-form-overlay", "create form");
  });

  // THE HOVER STATE, WHICH AXE STRUCTURALLY CANNOT SEE.
  //
  // axe samples the RESTING state, so a hover style that drops text under AA
  // ships silently — and the first version of these cards did exactly that:
  // tinting the hover background with --accent-soft composited under the blurb
  // and took --muted to 4.49:1 dark / 4.16:1 light. DESIGN_SYSTEM's own
  // anti-pattern list names this ("coloured text on coloured tinted
  // backgrounds… those tints are alpha composites, so you must composite them
  // against the actual surface before measuring").
  //
  // A type card now holds TWO starts (Recommended setup, Start blank), so the
  // card itself is no control: hovering it must not change its background or
  // fade it, and must not lift it either (an affordance on something a press
  // does nothing to). Its buttons carry the hover.
  test("hovering a type card changes nothing on the card, never the background; its Start blank button answers the hover", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await page.click('[data-action="open-competition-form"]');
    await page.locator("#admin-templates-tab").waitFor({ state: "visible", timeout: 15000 });

    const card = page.locator('#tpl-kind-cards .tpl-kind[data-kind="program"]');
    await card.waitFor({ state: "visible", timeout: 5000 });
    const read = (loc) => loc.evaluate((el) => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundColor, border: c.borderTopColor, shadow: c.boxShadow, opacity: c.opacity, transform: c.transform };
    });

    const rest = await read(card);
    await card.locator(".tpl-kind-art").hover();
    // Wait past any transition before sampling, or this reads a frame mid-way
    // and compares nothing meaningful.
    await page.waitForTimeout(400);
    const hovered = await read(card);

    expect(hovered.bg, "a hover tint would composite under the blurb and drop it below AA")
      .toBe(rest.bg);
    expect({ border: hovered.border, shadow: hovered.shadow, transform: hovered.transform },
      "a card that is no control does not lift or light up under the pointer").toEqual({ border: rest.border, shadow: rest.shadow, transform: rest.transform });
    // The other way to silently break contrast (DESIGN_SYSTEM anti-pattern #1).
    expect(rest.opacity, "never dim a text-bearing surface with opacity").toBe("1");
    expect(hovered.opacity).toBe("1");
    // CONTROL: the control on the card does answer the pointer.
    const btn = card.locator('button[data-action="new-event-start"]');
    const btnRest = await read(btn);
    await btn.hover();
    await page.waitForTimeout(400);
    const btnHover = await read(btn);
    expect(btnHover, "CONTROL: Start blank answers the hover").not.toEqual(btnRest);
    expect(btnHover.opacity, "and is never faded").toBe("1");
  });

  // Every token this dialog uses must EXIST. A var() naming an undefined custom
  // property invalidates the whole declaration at computed-value time, silently
  // — DESIGN_SYSTEM lists it as an anti-pattern precisely because `--space-4`
  // and `--radius-lg` look plausible and neither exists. Resolving them through
  // the browser is the only check that cannot be fooled by a plausible name.
  test("the type control's design tokens all resolve", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page, "booth", { advanced: false });

    const TOKENS = ["--r-s", "--surface", "--surface-2", "--border", "--border-strong",
      "--text", "--text-2", "--muted", "--sh-1", "--focus", "--fs-13", "--fs-14", "--fw-semibold"];
    const unresolved = await page.evaluate((toks) => {
      const cs = getComputedStyle(document.documentElement);
      return toks.filter((t) => !cs.getPropertyValue(t).trim());
    }, TOKENS);
    expect(unresolved, "undefined custom properties are discarded silently").toEqual([]);

    // Resolved values, which is what catches a typo'd var(): an undefined
    // custom property voids the declaration and reads back as the initial value.
    const seg = await page.locator("#comp-form-overlay .kind-seg").evaluate((el) => {
      const c = getComputedStyle(el);
      return { display: c.display, radius: c.borderTopLeftRadius, border: c.borderTopStyle };
    });
    expect(seg.display, "the type control is a flex row").toBe("flex");
    expect(seg.border, "it has its own edge").toBe("solid");
    expect(seg.radius, "and a token radius").not.toBe("0px");
    const opt = await page.locator('#comp-form-overlay .kind-seg-opt:has(input:checked) span').evaluate((el) => {
      const c = getComputedStyle(el);
      return { h: el.getBoundingClientRect().height, fw: c.fontWeight };
    });
    expect(opt.h, "each option is a comfortable target").toBeGreaterThanOrEqual(36);
    expect(Number(opt.fw), "options are semibold (--fw-semibold)").toBeGreaterThanOrEqual(600);

    // The focus ring, read out of the RULE rather than off a focused element.
    // `:focus-visible` matches on input MODALITY, so a programmatic .focus()
    // after a mouse click may not match it at all and the assertion would pass
    // by reading the resting state. The stylesheet is same-origin, so the rule
    // itself is the honest source. DESIGN_SYSTEM §9.2 fixes both halves.
    const ring = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const r of rules || []) {
          if (r.selectorText === ".kind-seg-opt input:focus-visible + span") {
            // The SHORTHAND, not its longhands: `outline` here contains a
            // var(), which CSSOM stores as a pending-substitution value, so
            // outlineWidth/outlineStyle read back as empty strings and an
            // assertion on them would fail against perfectly correct CSS.
            return { outline: r.style.getPropertyValue("outline"), offset: r.style.getPropertyValue("outline-offset") };
          }
        }
      }
      return null;
    });
    expect(ring, "the type options carry a :focus-visible rule").toBeTruthy();
    expect(ring.offset, "outline-offset is 1px (inside the segmented track)").toBe("1px");
    // The looks give the ring its own token (--focus: >= 3:1 on canvas and card).
    expect(ring.outline, "outline is 2px solid var(--focus)").toMatch(/2px\s+solid\s+var\(--focus\)/);
  });

  // v8.2.2 — THE CHECKBOX IS THE NATIVE WIDGET, NOT A TEXT INPUT.
  //
  // The base `input,select,textarea` rule paints background/border/radius/padding
  // onto every input, and an author background REPLACES a native checkbox's
  // interior — so an unticked box rendered as a solid --surface2 square, which in
  // the dark theme is #1E1A3A: a black-filled checkbox that reads as ticked.
  // Asserted in BOTH themes because the rule is global and the two resolve
  // differently: dark is the reported case, light merely looked ordinary.
  for (const theme of ["dark", "light"]) {
    test(`an unticked checkbox is not painted with the text-input chrome (${theme})`, async ({ page }) => {
      await adminLogin(page);
      await clickTab(page, "Events");
      await appearanceSettled(page);   // the app's own look read is done repainting <html>
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await openCompCreateForm(page, "tournament");

      // Every checkbox the dialog renders, not just one — the rule is global and
      // a per-component override could mask it on the one box we happened to pick.
      const boxes = page.locator('#comp-form-overlay input[type="checkbox"]');
      const n = await boxes.count();
      expect(n, "the form renders checkboxes to check").toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const st = await boxes.nth(i).evaluate((el) => {
          const c = getComputedStyle(el);
          const root = getComputedStyle(document.documentElement);
          return { bg: c.backgroundColor, radius: c.borderTopLeftRadius, pad: c.paddingTop,
                   surface2: root.getPropertyValue("--surface2").trim(), id: el.id || el.className };
        });
        // The precise failure: the box wearing the text-input surface colour.
        const surfaceRgb = await page.evaluate((hex) => {
          const d = document.createElement("div"); d.style.color = hex; document.body.appendChild(d);
          const v = getComputedStyle(d).color; d.remove(); return v.replace("rgb", "rgba").replace(")", ", 1)");
        }, st.surface2);
        expect(st.bg.replace("rgb(", "rgba(").replace(/\)$/, ", 1)"),
          `${theme}/${st.id}: the checkbox must not be filled with --surface2 (${st.surface2})`).not.toBe(surfaceRgb);
        expect(st.radius, `${theme}/${st.id}: no 8px text-input radius`).toBe("0px");
        expect(st.pad, `${theme}/${st.id}: no 10px text-input padding`).toBe("0px");
      }
    });
  }

  // v8.2.2 — THE DEADLINE BLOCK FITS A PHONE, TICKED OR NOT.
  //
  // The column carried an inline `flex:0 0 auto`, so it sized to max-content —
  // and ticking "No fixed deadline" swaps the note for a full sentence. Measured
  // before the fix: the card's scrollWidth reached 877px inside a 270px content
  // box. 320px is the narrowest viewport this codebase supports (v7.15.0 records
  // the leaderboard being fixed at exactly that width).
  for (const w of [320, 360, 390]) {
    test(`a Program's deadline block does not overflow at ${w}px, ticked or not`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      await adminLogin(page);
      await clickTab(page, "Events");
      await openCompCreateForm(page, "program");

      const measure = () => page.evaluate(() => {
        const card = document.querySelector("#comp-form-overlay .comp-form-card");
        const box = document.getElementById("comp-deadline-box");
        return { card: card.scrollWidth - card.clientWidth, box: box.scrollWidth - box.clientWidth,
                 doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });

      const before = await measure();
      expect(before.box, `${w}px unticked: the deadline block overflows its column`).toBeLessThanOrEqual(1);
      expect(before.card, `${w}px unticked: the dialog scrolls sideways`).toBeLessThanOrEqual(1);

      // The reported case. Ticking fills + disables the fields and swaps in the
      // long "stays open" note — which is what used to set the column's width.
      await page.locator("#comp-no-deadline").check();
      await page.waitForTimeout(250);
      const after = await measure();
      expect(after.box, `${w}px TICKED: the deadline block overflows its column`).toBeLessThanOrEqual(1);
      expect(after.card, `${w}px TICKED: the dialog scrolls sideways`).toBeLessThanOrEqual(1);
      expect(after.doc, `${w}px TICKED: the PAGE scrolls sideways`).toBeLessThanOrEqual(1);
    });
  }

  // v8.2.2 — the self-enrolment ceiling is REMOVED. A source scan, because the
  // failure mode is re-introduction: a column, a schema entry or a form control
  // coming back one at a time would each look locally reasonable, and the
  // feature would be half-alive with no single test failing.
  test("SOURCE: the self-enrolment ceiling is gone from every shipped surface", () => {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..");
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith("data")) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(js|yaml|html|css)$/.test(e.name)) files.push(f);
      }
    };
    for (const d of ["lib", "routes", "public"]) walk(path.join(root, d));
    for (const f of ["db.js", "server.js", "swagger.yaml"]) files.push(path.join(root, f));

    const hits = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // Strip comments so the migration's own explanatory note — which must NAME
      // the column it drops — is not itself a hit (v7.21.13).
      const stripped = f.endsWith(".yaml") ? src
        : src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
      stripped.split("\n").forEach((line, i) => {
        if (/max_self_enrolled|maxSelfEnrolled|comp-max-self-enrolled|event_full/.test(line))
          hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    // The ONLY permitted mentions are the guarded DROP in db.js and the warning
    // it logs if the drop fails — neither can talk about the column without
    // naming it. Scoped to db.js AND to those two shapes, so the exemption
    // cannot quietly cover a re-introduction somewhere else in the same file.
    const allowed = (h) =>
      /^db\.js:\d+: *if \(after\.includes\("max_self_enrolled"\)\)/.test(h) ||
      /^db\.js:\d+: *console\.warn\("\[migration\] could not drop competitions\.max_self_enrolled/.test(h);
    expect(hits.filter((h) => !allowed(h)), "the ceiling must not creep back").toEqual([]);
  });

  // A CONTROL THAT IS NOT RENDERED IS NOT SENT.
  //
  // The other half of the rule, and the one that makes hiding safe. Reading an
  // absent checkbox as `false` and sending it would make the render layer a
  // silent WRITER: on an edit it would clear whatever the column held, which is
  // the v7.15.8 "an admin save must never erase a field" defect with the erasure
  // moved somewhere the admin cannot see it.
  test("a control the kind does not have is OMITTED from the request, never sent as false", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");

    /** @type {any} */ let body = null;
    await page.route("**/api/admin/competitions", async (route, req) => {
      if (req.method() === "POST") { try { body = JSON.parse(req.postData() || "{}"); } catch (_) { body = {}; } }
      await route.continue();
    });

    await openCompCreateForm(page, "program");
    const name = `${TAG} Prog Send`;
    await page.locator("#comp-name").fill(name);
    // Dates derived from NOW, and both inside two years — a deadline further out
    // than that raises the typo confirmation FIRST ("more than two years from
    // now"), so a hard-coded far-future date would meet a different modal than
    // the one this test is driving. The deadline must also be after the start,
    // which the form's own 90-day default only satisfies for a near-term start.
    const d = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 10);
    await page.locator("#comp-date").fill(d(30 * 86400e3));
    await page.locator("#comp-time").fill("09:00");
    await page.locator("#comp-deadline-date").fill(d(300 * 86400e3));
    await page.locator("#comp-deadline-time").fill("23:59");
    await page.locator('[data-action="comp-save"]').first().click();
    const modal = page.locator("#modal-overlay");
    await modal.waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#modal-overlay button", { hasText: /^Create$/ }).first().click();

    await expect.poll(() => (body ? 1 : 0), { timeout: 15000 }).toBe(1);

    // Absent controls → absent KEYS. `false` would be a value the admin never
    // chose, and for reveal/group it is a value the server refuses outright.
    for (const k of ["reveal_answers_on_end", "group_leaderboard_enabled", "time_basis", "duration_minutes"]) {
      expect(Object.prototype.hasOwnProperty.call(body, k),
        `a Program has no ${k} control, so the body must not carry the key`).toBe(false);
    }
    // Positive control — the keys a Program's form DOES render are still sent,
    // or "the key is absent" is satisfied by a request that carries nothing.
    for (const k of ["name", "start_time", "deadline_at", "measure_presence", "cxone_disabled", "attempt_cap"]) {
      expect(Object.prototype.hasOwnProperty.call(body, k),
        `a Program DOES render ${k}, so it must be sent`).toBe(true);
    }
    expect(body.event_kind, "the kind chosen in step 1 reaches the create").toBe("program");
  });

  // The controls that were collected by the form and put in no request body at
  // all — dead since the release that added them. A ticked box that does nothing
  // is the same defect class as a control shown to the wrong kind. (The third,
  // the self-enrolment ceiling, was removed outright in v8.2.2.)
  test("the presence controls actually persist", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await openCompCreateForm(page, "tournament");

    const name = `${TAG} Presence`;
    await page.locator("#comp-name").fill(name);
    await page.locator("#comp-date").fill("2033-06-07");
    await page.locator("#comp-time").fill("10:00");
    await page.locator("#comp-dur-h").fill("3");
    await page.locator("#comp-measure-presence").check();
    await page.locator("#comp-time-basis").check();
    await page.locator('[data-action="comp-save"]').first().click();
    await page.locator("#modal-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#modal-overlay button", { hasText: /^Create$/ }).first().click();
    await page.locator("#comp-name").waitFor({ state: "hidden", timeout: 15000 });

    const { api, csrf } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const list = await (await api.get("/api/admin/competitions")).json();
    const row = list.find((c) => c.name === name);
    expect(row, "the competition was created").toBeTruthy();
    expect(row.measure_presence, "'Record time on platform' reached the column").toBeTruthy();
    expect(row.time_basis, "and so did the tie-break basis").toBe("presence");
    await api.dispose();
  });

  // The per-kind CxOne default was unreachable from the browser: the form sent
  // the field unconditionally, so the server's `=== undefined` branch — the one
  // that applies the kind's own default — could never run for an event created
  // through the UI. A Booth Event therefore minted an external identity for
  // every two-minute walk-up, against its own policy.
  test("the CxOne opt-out is seeded from the kind, and a Booth Event defaults to OFF", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");

    await openCompCreateForm(page, "booth");
    await expect(page.locator("#comp-cxone-disabled"),
      "a Booth Event does not provision Checkmarx One accounts by default").toBeChecked();
    // The override fields follow the box, as they do on an edit.
    await expect(page.locator("#comp-cxone-key")).toBeDisabled();

    // The control, which is what makes the assertion above a claim about the
    // KIND rather than about the checkbox always being ticked.
    // Switching the type on the form re-seeds it from the NEW kind.
    await page.locator('#comp-form-overlay label.kind-seg-opt:has(input[value="tournament"])').click();
    await expect.poll(() => page.locator("#comp-kind").inputValue(), { timeout: 10000 }).toBe("tournament");
    await expect(page.locator("#comp-cxone-disabled"),
      "a Competition still provisions them").not.toBeChecked();
  });

  // Editing is NOT a wizard — the kind is immutable, so there is nothing to
  // choose — but the same scoping applies, because the settings a Program does
  // not have do not appear when an admin reopens it either.
  test("EDIT skips step 1 and scopes the form the same way", async ({ page }) => {
    const { api, csrf } = await freshCtx();
    const lr = await api.post("/api/login", { headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(lr.ok()).toBeTruthy();
    const c2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const name = `${TAG} EditProg`;
    const r = await api.post("/api/admin/competitions", {
      headers: H(c2),
      data: {
        name, event_kind: "program", timezone: "UTC",
        start_time: new Date(Date.now() + 3600e3).toISOString(),
        deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
      },
    });
    expect(r.ok(), `create program: ${r.status()} ${await r.text()}`).toBeTruthy();
    await api.dispose();

    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, name);
    // PRECONDITION, not decoration: the competitions table paginates and every
    // spec on this worker shares one database, so an unnarrowed first row is
    // whatever else happens to be there — and a Competition legitimately DOES
    // render the controls this test asserts are absent. Without this the failure
    // would read as a scoping regression when it is a fixture miss (v7.15.29).
    await expect.poll(async () => page.locator("#admin-comp-body tr").count(),
      { timeout: 5000 }).toBe(1);
    await openKebab(page, page.locator("#admin-comp-body tr").first());
    await page.locator("#kebab-portal button:has-text('Edit')").first().click();
    await page.locator("#comp-name").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator('#comp-form-overlay input[name="comp-kind-seg"][value="program"]'),
      "the form that opened really is the Program's").toBeChecked();

    // An edit opens straight on the form (no New event page, no chooser).
    // Offering the type change is locked in tests/event-kind-change.spec.js.
    expect(await page.locator("#comp-kind-overlay").count(),
      "an edit opens on the form, never on a chooser").toBe(0);
    await expect(page.locator("#admin-templates-tab"), "and never on the New event page").toBeHidden();

    for (const row of MATRIX) {
      const want = row.kinds.includes("program");
      expect(await page.locator(`#comp-form-overlay ${row.sel}`).count(),
        `edit of a Program: ${row.sel} must be ${want ? "PRESENT" : "ABSENT"} — ${row.why}`)
        .toBe(want ? 1 : 0);
    }
    // The title names the KIND rather than saying "Competition" for all three.
    await expect(page.locator("#comp-form-title")).toHaveText(/Program/);
  });

  // The client must not re-derive which fields a kind has. If it did, that map
  // would be right the day it was written and silently divergent the first time
  // a policy moved — the failure lib/event-policy.js exists to prevent. Every
  // gate must read the wire policy instead.
  test("SOURCE: the form derives visibility from the wire policy, never from the kind value", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "competitions-admin.js"), "utf8");

    // Strip comments FIRST, preserving line count — several comments added by
    // this very change quote the stored values they forbid (v7.21.13).
    const stripped = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

    const offenders = [];
    stripped.split("\n").forEach((line, i) => {
      // A comparison of a kind-shaped variable against a stored value. The
      // stored values are the vocabulary lib/event-policy.js owns; the client is
      // TOLD the policy and must not re-derive it.
      if (/===\s*['"](booth|tournament|program)['"]/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders, "no client-side kind→behaviour map").toEqual([]);

    // And the gates really do read the policy, so the assertion above is not
    // satisfied by a form that hard-codes visibility some other way.
    for (const key of ["pol.sessions", "pol.schedule", "pol.reveal_answers", "pol.group_leaderboard", "pol.measure_presence", "pol.trusted_networks"]) {
      expect(stripped, `the form asks the policy for ${key}`).toContain(key);
    }
  });

  // The New event page and the template editor (features/templates-admin.js)
  // are held to the same rule: a template row's icon, the editor's options and
  // the quick spin read the wire policy, never the stored kind.
  test("SOURCE: the New event page and the template editor never compare the kind to a stored value", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "templates-admin.js"), "utf8"));
    const offenders = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /[!=]==\s*['"](booth|tournament|program)['"]/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(offenders, "no client-side kind→behaviour map").toEqual([]);
    // ANTI-VACUITY: the file really asks the policy (a renamed helper would
    // leave the scan above matching nothing for the wrong reason).
    expect(src, "the template code asks the wire policy").toContain("policyOrDefault(");
  });
});
