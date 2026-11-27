// v8.4.0 — the BROWSER half: the admin's two controls per field, and the sign-up
// form those controls shape.
//
// THE API SPEC BESIDE THIS ONE CANNOT SEE ANY OF IT.
// `booth-registration-fields.spec.js` proves the server stores the matrix,
// resolves it, refuses the wrong kind and demands a newly-mandatory field. It
// says nothing about whether an admin can reach the setting, whether the form a
// walk-up sees matches it, or whether the client refuses them before a request is
// ever made. A server capability the shipped client cannot reach is not a shipped
// feature — this codebase has paid for that twice — so both surfaces are driven
// for real here.
//
// THE CONTROLS THAT KEEP IT HONEST, since each headline assertion has a build
// that satisfies it for the wrong reason:
//
//   * "the booth form hides Phone" is equally satisfied by a build that hides
//     Phone everywhere. A Competition join link runs the same assertions and must
//     show every field with its own marker.
//   * "the field is not marked required" is equally satisfied by a form that
//     marks nothing. Each state matrix asserts the REQUIRED case on the same
//     fixture, so a form that lost every `*` fails.
//   * "the client accepted a blank Salutation" is equally satisfied by a client
//     that stopped validating. The required arm drives a real submit and requires
//     the inline refusal WITHOUT a request reaching the server.
//   * "Mandatory disables the Show checkbox" is equally satisfied by a dialog
//     that disables it always. The Optional arm asserts it is enabled.
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE } = require("./helpers");
// The suite's own admin sign-in, rather than a hand-rolled one. `adminLogin`
// establishes the session BEFORE navigating (the v7.21.26 trap: a `goto` first
// starts an ANONYMOUS SPA whose polls 401 the instant the login regenerates the
// session, at which point its own interceptor logs that session out), asserts
// the session is live, and waits for `#admin-page` rather than an either-or that
// `#login-page`'s painted-on-every-load `active` class would answer wrongly.
const { adminLogin, awaitCompModel, clickTab, signUpViaUi, openCompAdvanced } = require("./ui-admin-helpers");
const { REGISTRATION_FIELD_KEYS } = require("../lib/registration-fields");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `rfu${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function joinableEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true, ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const token = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
  return { comp, token };
}

/**
 * Open the sign-up form the way a walk-up does, and WAIT FOR THE POLICY TO LAND.
 *
 * The join banner is rendered from the preview response, so the form's markers
 * are correct only once that fetch has resolved. Waiting on the banner naming
 * THIS event rather than on a timeout is what makes it deterministic: the text
 * cannot be there before `_renderJoinBanner` has run, and that is the same call
 * that applies the states.
 */
async function openJoinSignup(page, token, compName) {
  await page.goto(`/join/${token}`);
  // Email first: the entry card names the event; the code then opens the form.
  await expect(page.locator("#join-banner-info")).toContainText(compName, { timeout: 15000 });
  await signUpViaUi(page, `walk-${uniq()}@company.example`, {}, { submit: false });
  await expect(page.locator("#reg-join-info")).toContainText(compName, { timeout: 15000 });
  await expect(page.locator("#reg-first")).toBeVisible();
}

/**
 * What the RENDERED form says about one field. Read off the DOM, never off the
 * policy object — the whole question here is whether the two agree.
 */
async function fieldUi(page, field) {
  return page.evaluate((f) => {
    const g = document.querySelector(`[data-relax-field="${f}"]`);
    if (!g) return null;
    const ctl = g.querySelector("input,select");
    const req = g.querySelector(".req");
    const staticHint = g.querySelector(".label-static-hint");
    const dynHint = g.querySelector(".label-optional-hint");
    return {
      hidden: g.hidden,
      state: g.getAttribute("data-relax-state"),
      ariaRequired: ctl ? ctl.getAttribute("aria-required") : null,
      // The rendered marker, not its presence in markup: three of these fields
      // carry a `.req` span that the stylesheet hides at rest.
      markerShown: req ? getComputedStyle(req).display !== "none" : false,
      optionalHintShown: !!((staticHint && getComputedStyle(staticHint).display !== "none") || dynHint),
    };
  }, field);
}

/** What remains of the retired password pair on the sign-up form: nothing. */
const NO_PASSWORD_UI = { groups: 0, heading: false, input: false, note: false };
async function passwordUi(page) {
  return page.evaluate(() => ({
    groups: document.querySelectorAll("#register-page [data-password-group]").length,
    heading: !!document.querySelector("#register-page [data-password-section]"),
    input: !!document.getElementById("reg-password"),
    note: !!document.getElementById("reg-password-optional-note"),
  }));
}

async function setFields(api, csrf, compId, registration_fields, more = {}) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const cur = (list.competitions || list).find(c => c.id === compId);
  expect(cur, "the competition is in the admin list").toBeTruthy();
  const r = await api.put(`/api/admin/competitions/${compId}`, {
    headers: H(csrf),
    data: { expectedUpdatedAt: cur.updated_at, ...(registration_fields ? { registration_fields } : {}), ...more },
  });
  expect(r.ok(), `PUT: ${await r.text()}`).toBeTruthy();
}

// The DOM id each field's control carries on the register form, so a loop can
// fill it without a per-field branch.
const INPUT_ID = {
  personal_title: "#reg-personal-title",
  phone: "#reg-phone",
  city: "#reg-city",
  linkedin_url: "#reg-linkedin",
  job_function: "#reg-job-function",
};
const PROFILE_FIELDS = Object.keys(INPUT_ID);

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.4.0 — the sign-up form renders exactly what the event asks for", () => {
  test("a Booth Event's DEFAULT form: the short form (three fields off, City and Job function optional)", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    await openJoinSignup(page, booth.token, booth.comp.name);

    for (const f of ["personal_title", "phone", "linkedin_url"]) {
      const ui = await fieldUi(page, f);
      expect(ui, `${f} has a relaxable group`).toBeTruthy();
      expect(ui.hidden, `${f} is not rendered on a default Booth Event`).toBe(true);
      // aria-required must travel with the marker, or a screen reader announces a
      // required field that is not on screen.
      expect(ui.ariaRequired, `${f} carries no aria-required while hidden`).toBeNull();
    }
    for (const f of ["city", "job_function"]) {
      const ui = await fieldUi(page, f);
      expect(ui.hidden, `${f} is shown`).toBe(false);
      expect(ui.state, `${f} is optional`).toBe("optional");
      expect(ui.markerShown, `${f} carries no * marker`).toBe(false);
      expect(ui.ariaRequired).toBeNull();
    }
    // The password is not offered at all, and its section heading goes with it —
    // a header over nothing reads as a field that failed to render.
    const pw = await passwordUi(page);
    expect(pw, "no sign-up form asks for a password any more").toEqual(NO_PASSWORD_UI);
    await api.dispose();
  });

  test("THE CONTROL: a Competition join link is completely unchanged", async ({ page }) => {
    const { api, csrf } = await sa();
    const tourn = await joinableEvent(api, csrf, "tournament");
    await openJoinSignup(page, tourn.token, tourn.comp.name);
    // Without this arm, every "the booth form hides it" assertion above is equally
    // satisfied by a build that hid the field for everybody.
    // The short form: City and Job function shown and optional, the other three off.
    for (const f of ["city", "job_function"]) {
      const ui = await fieldUi(page, f);
      expect(ui.hidden, `${f} is shown on a Competition`).toBe(false);
      expect(ui.state, `${f} is optional on a Competition`).toBe("optional");
      expect(ui.markerShown, `${f} carries no *`).toBe(false);
      expect(ui.ariaRequired, `${f} carries no aria-required`).toBeNull();
      expect(ui.optionalHintShown, `${f} says it is optional`).toBe(true);
    }
    for (const f of ["personal_title", "phone", "linkedin_url"]) {
      const ui = await fieldUi(page, f);
      expect(ui.state, `${f} is off on a Competition`).toBe("hidden");
      expect(ui.hidden, `${f} is not on the form`).toBe(true);
    }
    const pw = await passwordUi(page);
    expect(pw, "no sign-up form asks for a password any more").toEqual(NO_PASSWORD_UI);
    await api.dispose();
  });

  test("an ordinary sign-up with NO join link renders the resting form", async ({ page }) => {
    // The state that made `data-relax-default` necessary. `_applyRelaxedProfileFields`
    // runs only once a join link resolves, so a rule that inferred "required" from
    // "absent from both relaxed sets" would mark Salutation, Phone and LinkedIn URL
    // required for every visitor who is not behind a join link — the majority.
    await page.goto("/");
    await signUpViaUi(page, `rest-${uniq()}@company.example`, {}, { submit: false });
    await expect(page.locator("#reg-first")).toBeVisible();
    for (const f of ["personal_title", "phone", "linkedin_url"]) {
      const ui = await fieldUi(page, f);
      expect(ui.hidden, `${f} is off at rest`).toBe(true);
    }
    for (const f of ["city", "job_function"]) {
      const ui = await fieldUi(page, f);
      expect(ui.hidden, `${f} is shown at rest`).toBe(false);
      expect(ui.markerShown, `${f} is NOT marked required at rest`).toBe(false);
      expect(ui.ariaRequired, `${f} carries no aria-required at rest`).toBeNull();
    }
    const pw = await passwordUi(page);
    expect(pw, "no sign-up form asks for a password any more").toEqual(NO_PASSWORD_UI);
  });

  test("clearing a join link RESTORES each field's own default, not a blanket one", async ({ page }) => {
    // THE CASE THAT MAKES `data-relax-default` LOAD-BEARING, and the one the
    // resting-form test above structurally cannot reach: with no join token
    // `_applyRelaxedProfileFields` never runs at all, so that page is served
    // entirely by the static markup and the stylesheet. Here the function DOES
    // run, twice — once with a policy and once without — and the second pass has
    // to put every field back where its own markup says it belongs.
    //
    // Getting it wrong is not hypothetical: inferring "required" from "absent
    // from both relaxed sets" is what the pre-v8.4.0 code did, and it was correct
    // only because both relaxable fields happened to be required by default. With
    // three default-OPTIONAL fields in the loop the same inference marks
    // Salutation, Phone and LinkedIn URL required for a visitor who is no longer
    // behind any join link.
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth", {
      registration_fields: { phone: "required", personal_title: "required" },
    });
    await openJoinSignup(page, booth.token, booth.comp.name);
    expect((await fieldUi(page, "phone")).state, "required while the link applies").toBe("required");

    // Clear it the way the app itself does — the banner and the field states are
    // rendered by the same call, so they can never disagree about which event is
    // in play.
    await page.evaluate(() => { window.S._pendingJoinToken = null; window.S._pendingJoinComp = null; window._renderJoinBanner(); });
    for (const [f, want] of [["phone", "hidden"], ["personal_title", "hidden"], ["linkedin_url", "hidden"], ["city", "optional"], ["job_function", "optional"]]) {
      const ui = await fieldUi(page, f);
      expect(ui.state, `${f} returns to its own default, not a blanket one`).toBe(want);
      expect(ui.hidden, `${f} visibility matches its default`).toBe(want === "hidden");
    }
    await api.dispose();
  });

  for (const field of PROFILE_FIELDS) {
    test(`${field}: the form renders all three states, and the client refuses a blank REQUIRED one`, async ({ page }) => {
      const { api, csrf } = await sa();
      const booth = await joinableEvent(api, csrf, "booth", { registration_fields: { [field]: "hidden" } });

      // HIDDEN
      await openJoinSignup(page, booth.token, booth.comp.name);
      let ui = await fieldUi(page, field);
      expect(ui.hidden, `${field} hidden`).toBe(true);

      // OPTIONAL — shown, no marker, and it says so. A field on screen with no
      // stated status is one the visitor has to guess about.
      await setFields(api, csrf, booth.comp.id, { [field]: "optional" });
      await openJoinSignup(page, booth.token, booth.comp.name);
      ui = await fieldUi(page, field);
      expect(ui.hidden, `${field} optional is SHOWN`).toBe(false);
      expect(ui.state).toBe("optional");
      expect(ui.markerShown, `${field} optional carries no *`).toBe(false);
      expect(ui.ariaRequired).toBeNull();
      expect(ui.optionalHintShown, `${field} optional says "(optional)"`).toBe(true);

      // REQUIRED
      await setFields(api, csrf, booth.comp.id, { [field]: "required" });
      await openJoinSignup(page, booth.token, booth.comp.name);
      ui = await fieldUi(page, field);
      expect(ui.hidden, `${field} required is SHOWN`).toBe(false);
      expect(ui.state).toBe("required");
      expect(ui.markerShown, `${field} required carries its *`).toBe(true);
      expect(ui.ariaRequired).toBe("true");
      // A required select must not offer "Prefer not to say" and then refuse it —
      // that is a control presenting an answer it will reject.
      if (field === "personal_title") {
        const ph = await page.locator("#reg-personal-title option[value='']").textContent();
        expect(ph, "the blank option becomes an instruction").toMatch(/select/i);
      }

      // …AND THE CLIENT REFUSES A BLANK ONE BEFORE ANY REQUEST IS MADE. This is
      // the assertion the API spec structurally cannot make: a server-side 400
      // proves the rule, not that the walk-up is told about it on the screen they
      // are standing in front of.
      let posted = 0;
      page.on("request", (r) => { if (r.url().includes("/api/register")) posted++; });
      await fillFormExcept(page, field);
      // ASSERT THE PRECONDITION rather than assuming it. "Untouched" is not the
      // same as "empty" — Chromium will autofill an `autocomplete`-tagged input
      // once the rest of the form is populated, and a field that quietly arrives
      // non-blank makes this test pass for the opposite of its subject: the
      // client accepts the submit because the value is THERE, not because the
      // rule is missing.
      // A `<select>` cannot be `fill`ed, so the two control shapes are cleared
      // differently — and both are then asserted empty, which is the point.
      if (["personal_title", "job_function"].includes(field)) await page.locator(INPUT_ID[field]).selectOption("");
      else await page.locator(INPUT_ID[field]).fill("");
      expect(await page.locator(INPUT_ID[field]).inputValue(), `${field} is blank before submitting`).toBe("");
      await page.locator('[data-action="do-register"]').click();
      await expect(page.locator("#reg-error")).toBeVisible({ timeout: 10000 }).catch(async (e) => {
        const d = await page.evaluate((f) => ({
          state: document.querySelector(`[data-relax-field="${f}"]`)?.getAttribute("data-relax-state"),
          hidden: document.querySelector(`[data-relax-field="${f}"]`)?.hidden,
          val: document.querySelector(`[data-relax-field="${f}"] input, [data-relax-field="${f}"] select`)?.value,
          err: document.getElementById("reg-error")?.textContent,
          success: document.getElementById("reg-success")?.offsetParent !== null,
          page: [...document.querySelectorAll(".page")].filter(p => p.classList.contains("active")).map(p => p.id),
        }), field);
        throw new Error(`no inline refusal for ${field}: ${JSON.stringify(d)}\n${e.message}`);
      });
      expect(posted, "no /api/register request was made").toBe(0);
      await api.dispose();
    });
  }






});

/** Fill every visible required control EXCEPT `skip`, so only that one is blank. */
async function fillFormExcept(page, skip) {
  const nick = uniq();
  await page.locator("#reg-first").fill("Walk");
  await page.locator("#reg-last").fill("Up");
  await page.locator("#reg-company").fill("Acme");
  await page.locator("#reg-title").fill("Engineer");
  if (await page.locator("#reg-location-pick").isHidden()) await page.click("[data-action='reg-location-change']");
  await page.locator("#reg-country").selectOption("US");
  await page.locator("#reg-tz").selectOption({ index: 1 });
  for (const [field, sel] of Object.entries(INPUT_ID)) {
    if (field === skip) continue;
    const g = page.locator(`[data-relax-field="${field}"]`);
    if (await g.evaluate(el => el.hidden)) continue;
    if (field === "job_function") await page.locator(sel).selectOption("Software Developer / Engineer");
    else if (field === "personal_title") await page.locator(sel).selectOption("Dr.");
    else if (field === "linkedin_url") await page.locator(sel).fill("https://www.linkedin.com/in/walkup");
    else await page.locator(sel).fill("Testville");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.4.0 — the admin's two controls per field", () => {
  /**
   * Open the competition editor for `compId` and wait for the matrix to render.
   *
   * Waits for the MODEL, not for the pane: `editCompetition` renders entirely
   * from `S.adminCompetitionsData` and opens `if (!comp) return`, so against an
   * unloaded model it is a SILENT no-op and the failure surfaces ten seconds
   * later naming the overlay rather than the empty list (the v8.3.39 class).
   */
  async function openEditor(page, compId) {
    // `clickTab`, not a direct `window.adminTab` call: the pane switch is a
    // delegated click and the helper already handles the mobile drawer, the
    // in-page dispatch and the pane-visible wait. Driving the real control is
    // also what keeps this a test of a path a human can take.
    await clickTab(page, "Events");
    await awaitCompModel(page);
    await page.waitForFunction((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), compId, { timeout: 20000 });
    await page.evaluate((id) => window.editCompetition(id), compId);
    await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
    // The sign-up form is under Advanced settings, folded on an edit too (owner's
    // decision, 27 Nov 2026): opened as a person would.
    await openCompAdvanced(page);
  }

  test("every kind's editor shows one row per sign-up field", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    const tourn = await joinableEvent(api, csrf, "tournament");
    await adminLogin(page);
    await openEditor(page, booth.comp.id);
    await expect(page.locator(".reg-editor")).toBeVisible();
    // ONE ROW PER CONFIGURABLE FIELD — asserted as an exact set, so a field added
    // to the module and forgotten here fails rather than being quietly
    // unconfigurable.
    const rows = await page.locator("[data-reg-row]").evaluateAll(els => els.map(e => e.getAttribute("data-reg-row")));
    expect(rows.sort()).toEqual([...REGISTRATION_FIELD_KEYS].sort());
    await expect(page.locator("#comp-linkedin-signup"), "the LinkedIn sign-up switch is gone with LinkedIn sign-in").toHaveCount(0);
    await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();

    // Every kind configures its sign-up form (operator ruling, 30 Oct 2026), so a
    // Competition's editor offers the same rows, enabled.
    await openEditor(page, tourn.comp.id);
    await expect(page.locator(".reg-editor")).toBeVisible();
    const tRows = await page.locator("[data-reg-row]").evaluateAll(els => els.map(e => e.getAttribute("data-reg-row")));
    expect(tRows.sort()).toEqual([...REGISTRATION_FIELD_KEYS].sort());
    await expect(page.locator('#comp-form-overlay input[name="reg-state-city"][value="required"]')).toBeEnabled();
    await expect(page.locator("#comp-linkedin-signup")).toHaveCount(0);
    await api.dispose();
  });

  // ONE three-way switch per field (Required · Optional · Off) maps 1:1 onto the
  // stored state, so "required but not shown" is unrepresentable by construction.
  const seg = (page, key, v) => page.locator(`#comp-form-overlay input[name="reg-state-${key}"][value="${v}"]`);
  const stateOf = (page, key) => page.locator(`#comp-form-overlay input[name="reg-state-${key}"]:checked`).getAttribute("value");

  test("one Required · Optional · Off switch per field, the Always-asked rows fixed, and a live preview", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth", { registration_fields: { phone: "hidden" } });
    await adminLogin(page);
    await openEditor(page, booth.comp.id);
    expect(await stateOf(page, "phone")).toBe("hidden");
    await expect(page.locator("#comp-form-overlay .reg-field-fixed"), "the four always-asked fields are listed").toHaveCount(4);
    await expect(page.locator("#reg-preview"), "the preview does not show an Off field").not.toContainText("Phone");
    await seg(page, "phone", "required").check();
    await expect(page.locator("#reg-preview"), "the preview follows the switch").toContainText("Phone");
    await seg(page, "phone", "optional").check();
    await expect(page.locator("#reg-preview")).toContainText("(optional)");
    // Keyboard: the switch is a radio group, so arrows move it.
    await seg(page, "phone", "optional").focus();
    await page.keyboard.press("ArrowRight");
    expect(await stateOf(page, "phone"), "an arrow key moves the switch").toBe("hidden");
    await api.dispose();
  });

  // THE RAW-KEY GATE. `policyOrDefault` fills a missing key with the RESTRICTIVE
  // value, so gating the section on the MERGED answer makes the whole sign-up
  // form section vanish during any half-deployed moment (a server one commit
  // behind a reloaded SPA): the v8.4.1 incident. The form reads the RAW key and
  // falls back to the kind entry the shell carries; the late-entry twin is
  // locked in tests/late-entries-ui.spec.js.
  test("ABSENT IS NOT FALSE — a policy payload with no registration_fields_configurable key still renders the sign-up section", async ({ page }) => {
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf, "tournament");
    await api.dispose();
    await adminLogin(page);
    await clickTab(page, "Events");
    await awaitCompModel(page);
    await page.waitForFunction((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), ev.comp.id, { timeout: 20000 });
    const reopen = async () => {
      await page.evaluate((id) => window.editCompetition(id), ev.comp.id);
      await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
      await openCompAdvanced(page);   // folded on an edit too (owner's decision, 27 Nov 2026)
    };
    const close = async () => {
      await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
      await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
    };
    await page.evaluate((id) => {
      const c = (window.S.adminCompetitionsData || []).find(x => x.id === id);
      delete c.policy.registration_fields_configurable;
    }, ev.comp.id);
    await reopen();
    await expect(page.locator(".reg-editor"), "an ABSENT key falls back to the kind and still renders the section").toBeVisible();
    await expect(page.locator('#comp-form-overlay input[name="reg-state-phone"]')).toHaveCount(3);
    await close();
    // THE CONTROL: an explicit false is obeyed, or the fallback is just "render it always".
    await page.evaluate((id) => {
      const c = (window.S.adminCompetitionsData || []).find(x => x.id === id);
      c.policy.registration_fields_configurable = false;
    }, ev.comp.id);
    await reopen();
    await expect(page.locator(".reg-editor"), "an explicit refusal is obeyed").toHaveCount(0);
    await close();
  });

  // The section governs REGISTRATION, which stops when the event does: an ended
  // event's switches stay editable (a rerun can be prepared) and say they change
  // nothing today.
  test("an ended event's sign-up section says a change takes effect only if it runs again", async ({ page }) => {
    const { api, csrf } = await sa();
    const ended = await joinableEvent(api, csrf, "booth", { start_time: new Date(Date.now() - 3 * 3600e3).toISOString(), duration_minutes: 60 });
    const live = await joinableEvent(api, csrf, "booth");
    await api.dispose();
    await adminLogin(page);
    const note = page.locator("#comp-form-overlay .comp-form-reveal-hint", { hasText: "This event has ended, so nobody can register through its link" });
    await openEditor(page, ended.comp.id);
    await expect(page.locator(".reg-editor"), "PRECONDITION: the section renders").toBeVisible();
    await expect(note, "the ended event says the change is dormant").toHaveCount(1);
    await expect(note).toContainText("takes effect only if it runs again");
    await expect(seg(page, "phone", "required"), "and its switches stay editable").toBeEnabled();
    await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
    await openEditor(page, live.comp.id);
    await expect(page.locator(".reg-editor")).toBeVisible();
    await expect(note, "CONTROL: a live event's section says nothing of the kind").toHaveCount(0);
  });

  test("the switches round-trip through a real Save, all three states", async ({ page }) => {
    const { api, csrf } = await sa();
    const booth = await joinableEvent(api, csrf, "booth");
    await api.dispose();
    await adminLogin(page);
    await openEditor(page, booth.comp.id);
    await seg(page, "phone", "required").check();
    await seg(page, "city", "optional").check();
    await seg(page, "personal_title", "hidden").check();
    await page.locator('[data-action="comp-save"]').click();
    await expect(page.locator("#modal-overlay")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#modal-title")).toContainText(/update/i);
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 15000 }).catch(async (e) => {
      const toast = await page.locator("#toast-stack").innerText().catch(() => "(none)");
      throw new Error(`the save did not close the form. Toast: ${toast}\n${e.message}`);
    });
    const list = await (await page.request.get("/api/admin/competitions")).json();
    const c = list.find(x => x.id === booth.comp.id);
    expect(c, "the saved competition is in the list").toBeTruthy();
    expect(c.policy.registration_fields.phone, "Required → required").toBe("required");
    expect(c.policy.registration_fields.city, "Optional → optional").toBe("optional");
    expect(c.policy.registration_fields.personal_title, "Off → hidden").toBe("hidden");
    expect(c.policy.registration_fields.job_function, "untouched keeps the short-form default").toBe("optional");
    await openEditor(page, booth.comp.id);
    expect(await stateOf(page, "phone")).toBe("required");
    expect(await stateOf(page, "personal_title")).toBe("hidden");
  });
});
