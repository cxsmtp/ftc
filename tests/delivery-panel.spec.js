// @ts-check
//
// v8.1.0 — the OPERATOR SURFACE for GET /api/admin/competitions/:id/delivery.
//
// The endpoint has been complete and admin-gated since v7.29.0 and NOTHING in
// public/js ever fetched it — swagger and one API test (login-code.spec.js) were
// its only consumers. So the release note's unqualified "the delivery panel
// ships with it" described a panel that did not exist, and an organiser at a
// stand was still opening History dialogs one participant at a time: the exact
// pre-feature state the endpoint was built to end. A feature no operator can
// reach is not a shipped feature.
//
// The API-level contract (cohort scoping, per-PERSON failure counting) is
// already locked in login-code.spec.js and is deliberately NOT re-tested here.
// What this file locks is the half that was missing: that the numbers reach a
// human, that the sentence explaining them travels with them, and that a failure
// is never dressed up as data.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, openEventMenu } = require("./ui-admin-helpers");

// Route every page.goto() + page.request.* to THIS worker's server.
test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `dp${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// The file owns its whole fixture — its own competition and its own two
// participants. Nothing here borrows a seeded fixture whose lifecycle other
// specs move (alice/bob, "Test Live"), so no test in this file can be broken by
// what ran before it.
let COMP_NAME = "";
let COMP_ID = "";
// A second, deliberately EMPTY competition. "nobody has joined yet" and "we could
// not find out" are different answers and the panel must render them differently
// — see the last two tests, which are each other's control.
let EMPTY_NAME = "";
/** @type {{enrolled:number,verified:number,email_failed:number}} */
let EXPECTED;

test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    // UPCOMING, deliberately. The panel is NOT status-gated (unlike Export
    // Activity, which is), because the moment an organiser most wants these
    // numbers is the night before while people are still registering through
    // the join link. An implementation that copied the export's
    // `status==='live'||status==='ended'` gate would fail every test in this
    // file at the kebab, which is the point of choosing an upcoming event.
    COMP_NAME = `${uniq()} Delivery`;
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: COMP_NAME,
        start_time: new Date(Date.now() + 3600e3).toISOString(),
        duration_minutes: 120,
        timezone: "UTC",
        // Self-enrolment is on because the UNVERIFIED half of the fixture below
        // is built through the join link — see `mk`.
        self_enroll_enabled: true,
      },
    });
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    COMP_ID = (await cr.json()).competition.id;
    const seReveal = await api.get(`/api/admin/competitions/${COMP_ID}/self-enroll`);
    expect(seReveal.ok(), `reveal join token: ${await seReveal.text()}`).toBeTruthy();
    const JOIN_TOKEN = (await seReveal.json()).token;
    expect(JOIN_TOKEN, "fixture: the competition must have a join token").toBeTruthy();

    // Two participants, ONE of them left unverified. The gap between `enrolled`
    // and `verified` is the number this panel exists to surface, so a fixture
    // where the two are equal could not tell a real gap from a hard-coded 0 —
    // and 2 vs 1 also means a verified/enrolled swap cannot pass.
    // BOTH participants must end up APPROVED, because the assign endpoint
    // silently SKIPS an unapproved user and the `assigned === 2` precondition
    // below would then fail for a reason that has nothing to do with the panel.
    // Verification is the axis we vary — and the two halves are built by
    // DIFFERENT routes, because `POST /api/admin/participants/:id/approve`
    // REFUSES an unverified account ("Approval is not meaningful until the
    // account is verified"), so verify-then-approve is the only ordering the
    // admin path allows and it cannot produce the state this panel exists to
    // surface.
    //
    // The unverified half therefore registers through the JOIN LINK, which is
    // both the route that works and the production shape: a join-token
    // registration is created approved=1 (the approval queue is skipped —
    // the organiser's QR is the approval) and verified=0 until the emailed link
    // is clicked. That gap between `enrolled` and `verified` IS the population
    // the panel is for, so building it any other way — a direct DB write, an
    // import — would measure a state real traffic does not produce.
    const mk = async (verified) => {
      const label = uniq();
      const email = `${label}@company.example`;
      const reg = await registerPost(api, "/api/register", {
        headers: H(csrf),
        data: {
          firstName: "Del", lastName: "Panel", nickname: label, email,
          company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
          password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
          ...(verified ? {} : { joinToken: JOIN_TOKEN }),
        },
      });
      expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
      const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
      const u = (list.participants || []).find((p) => p.email === email);
      expect(u, `participant ${label} must exist after register — the admin search returned `
        + `${JSON.stringify((list.participants || []).map((p) => p.email))}`).toBeTruthy();
      if (verified) {
        const vr = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
        expect(vr.ok(), `verify ${label}: ${await vr.text()}`).toBeTruthy();
        const ap = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
        expect(ap.ok(), `approve ${label}: ${await ap.text()}`).toBeTruthy();
      }
      // Assert the state each half was built for, so a future change to either
      // registration path fails HERE rather than as a wrong number three tests
      // down (the join-token path's auto-approval is the load-bearing half).
      const after = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
      const u2 = (after.participants || []).find((p) => p.email === email);
      expect(!!u2.approved, `fixture: ${label} must be approved or assign will skip them`).toBe(true);
      expect(!!u2.verified, `fixture: ${label} verified state`).toBe(!!verified);
      return u.id;
    };
    const ids = [await mk(true), await mk(false)];

    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: ids, competitionIds: [COMP_ID] },
    });
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    // Email first: the join-link registration enrols its account at sign-up (the
    // proof grant carries the event), so the assign adds only the verified half;
    // that both are really enrolled is asserted on the endpoint just below.
    expect((await asg.json()).assigned,
      "the verified participant must be enrolled by the assign").toBe(1);

    EXPECTED = await (await api.get(`/api/admin/competitions/${COMP_ID}/delivery`)).json();
    // Preconditions, asserted so a fixture that stopped producing this state
    // fails AS a fixture rather than as a mysterious rendering failure.
    expect(EXPECTED.enrolled, "fixture: two enrolled").toBe(2);
    expect(EXPECTED.verified, "fixture: exactly one of them verified").toBe(1);

    EMPTY_NAME = `${uniq()} Empty`;
    const er = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: {
        name: EMPTY_NAME,
        start_time: new Date(Date.now() + 7200e3).toISOString(),
        duration_minutes: 120,
        timezone: "UTC",
      },
    });
    expect(er.ok(), `create empty comp: ${er.status()} ${await er.text()}`).toBeTruthy();
    const emptyId = (await er.json()).competition.id;
    const ed = await (await api.get(`/api/admin/competitions/${emptyId}/delivery`)).json();
    expect(ed.enrolled, "fixture: the empty competition really has nobody in it").toBe(0);
  } finally {
    await api.dispose();
  }
});

/**
 * Open the delivery panel from the event's workspace ⋯ menu (the event's doors
 * are its workspace's; the Events-row menu keeps only Delete event) and return
 * the modal body. openEventMenu narrows the paginated Events table first and
 * presses the toggle until the menu is open.
 */
async function openDeliveryPanel(page, name = COMP_NAME) {
  const portal = await openEventMenu(page, name);
  const item = portal.locator('[data-action="comp-delivery"]').first();
  await expect(item, "the item reads Email delivery").toHaveText(/Email delivery/);
  await expect(item,
    "the delivery item must be on the menu for an UPCOMING event — it is deliberately not status-gated")
    .toBeVisible({ timeout: 5000 });
  await item.click();
  await expect(page.locator("#modal-overlay")).toBeVisible({ timeout: 15000 });
  return page.locator("#modal-body");
}

/** textContent (never innerText) with whitespace collapsed: the stat labels are
 *  upper-cased by CSS `text-transform`, which innerText would apply and
 *  textContent does not, so this reads what the markup actually says. */
async function panelText(body) {
  return (await body.evaluate((el) => el.textContent || "")).replace(/\s+/g, " ").trim();
}

test.describe("v8.1.0 — the delivery panel has an operator surface", () => {
  // Catches: the kebab item missing entirely (the reported defect); the item
  // wrongly copied the export's live/ended gate; the numbers hard-coded, zeroed,
  // or mapped to the wrong labels (2 vs 1 makes a swap fail); a broken gap.
  //
  // This is ALSO the positive control for the two failure tests below: without
  // it, "no numbers were rendered" is equally satisfied by a panel that never
  // renders numbers at all.
  test("the kebab opens a panel showing this event's real numbers", async ({ page }) => {
    await adminLogin(page);
    const body = await openDeliveryPanel(page);
    const text = await panelText(body);

    await expect(page.locator("#modal-title")).toContainText(COMP_NAME);

    // Asserted against the fixture THIS file built, not merely against whatever
    // the endpoint happened to say.
    expect(text, `panel text was: ${text}`).toContain("2 Enrolled");
    expect(text, `panel text was: ${text}`).toContain("1 Verified");
    // ...and against the endpoint, so the panel cannot invent a number that
    // merely happens to match the fixture.
    expect(text).toContain(`${EXPECTED.enrolled} Enrolled`);
    expect(text).toContain(`${EXPECTED.verified} Verified`);
    // email_failed is NOT pinned to a literal on purpose: registration itself
    // sends a verification mail and the shared test server points at a dead SMTP
    // port, so the count is an environment property rather than something this
    // fixture controls. Pinning it to the endpoint's own answer still catches a
    // dropped or mis-mapped third number.
    expect(text).toContain(`${EXPECTED.email_failed} Email failed`);

    // The gap is computed by the PANEL (the endpoint does not return it), so it
    // is the one number here that is entirely ours.
    expect(text, `panel text was: ${text}`).toMatch(/gap — 1 right now/);
  });

  // Catches: the explanation being dropped or reduced to a caption. Two of the
  // three numbers are useless without it — `verified` only means anything as a
  // gap, and `email_failed` counts PEOPLE, so an operator reading it as a
  // message count over-estimates the queue in front of them.
  test("the explanation ships with the numbers", async ({ page }) => {
    await adminLogin(page);
    const body = await openDeliveryPanel(page);
    const text = await panelText(body);

    expect(text, "enrolled must be explained as live-moving").toMatch(/moves the moment someone scans the QR/i);
    expect(text, "the gap must be named as the population that may be stuck").toMatch(/population that may be stuck/i);
    expect(text, "email_failed must say it counts PEOPLE, not messages")
      .toMatch(/counts PEOPLE with at least one failed send, not messages/);
    // The remedy named must be one that exists AND is honest about when it is
    // offered: the row action is gated on the participant being approved and
    // never having signed in (`can_use_code`; operator ruling, 14 Nov 2026), so
    // the copy states that condition rather than sending an organiser hunting
    // for a menu item that is not on every row (v7.14.2).
    expect(text, "the named remedy must carry its own condition").toMatch(/every approved\s+participant who has never signed in/i);
    expect(text).toMatch(/Show sign-in code/);
  });

  // Catches: a failure falling back to zeros. Three zeros are a perfectly
  // plausible answer here ("nobody has joined yet"), so a panel that rendered
  // them on an error would tell an organiser the room is empty when the truth is
  // that we do not know — the v7.23.5 rule.
  test("a failing request renders could-not-load, never zeros", async ({ page }) => {
    await adminLogin(page);
    await page.route("**/api/admin/competitions/*/delivery", (r) => r.abort());
    const body = await openDeliveryPanel(page);
    const text = await panelText(body);

    expect(text, `panel text was: ${text}`).toMatch(/Could not load the delivery status/i);
    // The strongest available expression of "must not render as data": the
    // failure copy carries no digits at all, so any number on screen is a
    // fabricated one.
    expect(text, `a failure must show NO numbers; got: ${text}`).not.toMatch(/\d/);
    expect(text).not.toContain("Enrolled");
  });

  // Catches: replacing the Number.isFinite shape check with `d.enrolled || 0`.
  // A 200 whose body we do not recognise is a failure, and defaulting its
  // missing keys to 0 is the same lie as the error branch above.
  test("a 200 with an unrecognised shape is a failure, not zeros", async ({ page }) => {
    await adminLogin(page);
    await page.route("**/api/admin/competitions/*/delivery", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const body = await openDeliveryPanel(page);
    const text = await panelText(body);

    expect(text, `panel text was: ${text}`).toMatch(/Could not load the delivery status/i);
    expect(text, `an unrecognised 200 must show NO numbers; got: ${text}`).not.toMatch(/\d/);
  });

  // Catches: "simplifying" esc(String(value)) to esc(value). esc() is
  // `String(str||'')`, so esc(0) is the EMPTY STRING and a genuine zero would
  // render as a blank cell — which reads as a broken panel, not as "none yet".
  //
  // It is also the CONTROL for the two failure tests above: they assert the
  // panel shows no numbers, and this is what makes that assertion mean
  // something, by proving an honest zero IS still shown as a number. "Nobody has
  // joined yet" and "we could not find out" must never look alike.
  test("an empty event renders a real zero, not a blank and not a failure", async ({ page }) => {
    await adminLogin(page);
    const body = await openDeliveryPanel(page, EMPTY_NAME);
    const text = await panelText(body);

    expect(text, `panel text was: ${text}`).toContain("0 Enrolled");
    expect(text, `panel text was: ${text}`).toContain("0 Verified");
    expect(text, "a zero cohort is DATA — it must not be reported as a load failure")
      .not.toMatch(/Could not load/i);
    expect(text, "the gap over an empty cohort is 0, not blank").toMatch(/gap — 0 right now/);
  });
});
