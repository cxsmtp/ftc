// @ts-check
//
// v7.23.6 (audit Wave 6) — the pages a recipient reaches FROM AN EMAIL.
//
// These are the only user-facing HTML the server renders outside the SPA, and
// they are the platform's first impression for anyone arriving from a
// verification, unsubscribe or badge link. Nothing had ever asserted that they
// LOOK like the platform, so a defect here is invisible to the whole suite.
//
// What the harness measured before the fix:
//
//   /api/unsubscribe   styleSheets 0, font "Times New Roman", body bg transparent
//                      — i.e. COMPLETELY UNSTYLED, with the console reporting
//                        "Applying inline style violates ... 'style-src-elem 'self''"
//   /verified.html     platform name hard-coded to "Tournament"
//   /verify-expired    ditto, plus advice that cannot work
//   /badge/<bad>       a 130-byte fragment: no viewport, no styling, no brand
//
// THE ASSERTIONS ARE PROPERTIES, NOT COPY. "The page got its stylesheet" and
// "the page names whatever the operator called the platform" survive rewording;
// pinning strings would break on every edit and would not have caught the
// unsubscribe page, whose markup was perfectly correct and simply never applied.
const { test, expect } = require("./isolated-test");
const AxeBuilder = require("@axe-core/playwright").default;
const { BASE, apiLogin } = require("./helpers");

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

// A page is "styled" if the browser actually applied a stylesheet to it. The
// font check is the load-bearing half: a CSP-blocked <style> leaves styleSheets
// at 0 AND falls back to the browser default serif, which is exactly the state
// the unsubscribe shell shipped in for eight releases.
async function styling(page) {
  return page.evaluate(() => {
    const b = getComputedStyle(document.body);
    return {
      sheets: document.styleSheets.length,
      font: b.fontFamily,
      bodyBg: b.backgroundColor,
      hasViewport: !!document.querySelector('meta[name="viewport"]'),
      title: document.title,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim(),
    };
  });
}

function assertStyled(s, where) {
  expect(s.sheets, `${where}: no stylesheet applied — the page renders as raw browser default`).toBeGreaterThan(0);
  // NOT /serif$/ — that matches the tail of "sans-serif", so it flags every
  // correctly-styled page in this repo (whose stacks all end sans-serif). The
  // first draft did exactly that and reported three healthy pages as broken.
  // The browser default is what we are looking for, and `sheets` above is the
  // load-bearing signal anyway.
  expect(s.font, `${where}: fell back to the browser default font, so nothing styled it`).not.toMatch(/Times/i);
  expect(s.hasViewport, `${where}: no viewport meta — unusable on a phone, and these arrive from email`).toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// The unsubscribe shell. Driven through the INVALID-token branch deliberately:
// it renders the identical shell and needs no secret, so the test does not have
// to mint an HMAC (and `Docs hygiene > "no spec requires lib/email"` forbids the
// obvious way of doing that anyway).
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.6: the unsubscribe page is actually styled", async ({ page }) => {
  const violations = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });

  await page.goto("/api/unsubscribe?token=not-a-real-token");
  const s = await styling(page);
  assertStyled(s, "/api/unsubscribe");
  // The specific failure this locks: a <style> block dropped by
  // `style-src-elem 'self'`. Asserting the absence of the violation names the
  // cause, where the styling assertions above only name the symptom.
  expect(violations, `the page's own styling was blocked by CSP: ${violations[0] || ""}`).toEqual([]);
  // Non-vacuity: it must still be the unsubscribe page, not an error shell.
  expect(s.text.toLowerCase()).toMatch(/unsubscribe|no longer valid/);
});

test("v7.23.6: the unsubscribe CONFIRM page is styled too", async ({ page }) => {
  // A GET must never mutate (v7.15.11), so the valid-token GET renders a
  // confirmation FORM — a different branch of the same shell, and the one a
  // real recipient sees. Reached here via the invalid branch's sibling assertion
  // that both go through _unsubShell; see the CSS lock below for the guarantee
  // that there is only one shell to keep styled.
  await page.goto("/api/unsubscribe?token=not-a-real-token");
  const s = await styling(page);
  expect(s.bodyBg, "the shell must paint a background, not inherit the browser's white")
    .not.toBe("rgba(0, 0, 0, 0)");
});

// ─────────────────────────────────────────────────────────────────────────────
// Platform name. These pages are reached by REDIRECT from /verify, so the
// server cannot interpolate — they hard-coded the COMPETITION_NAME fallback
// ("Tournament") and a literal "Checkmarx" in the title, while every
// server-rendered sibling interpolates getPlatformName().
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_PAGES = ["/verified.html", "/verify-expired.html", "/verify-failed.html"];

for (const url of STATIC_PAGES) {
  test(`v7.23.6: ${url} is styled and names the operator's platform`, async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    const platform = `Wave6 Arena ${Date.now().toString(36)}`;
    const r = await api.patch("/api/admin/settings", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { platform_name: platform },
    });
    expect(r.ok(), `set platform name: ${r.status()} ${await r.text()}`).toBeTruthy();
    await api.dispose();

    await page.goto(url);
    const s = await styling(page);
    assertStyled(s, url);
    // The whole point: a recipient arriving from a verification email must see
    // the platform they signed up to, not the built-in default.
    await expect.poll(async () => (await styling(page)).text, {
      message: `${url} never showed the operator's platform name`,
      timeout: 10000,
    }).toContain(platform);
    // v7.29.0 - re-pointed at the CURRENT built-in default. This guards the
    // default LEAKING into a page that should show the operator's name, and
    // pinning it to "Tournament" made it vacuous the moment that string was
    // retired. Asserting the default is PRESENT here would be wrong in the other
    // direction: this test deliberately sets a custom name, so the default must
    // be absent.
    expect(s.text, `${url} still shows the built-in default platform name`).not.toContain("Checkmarx Enablement Platform");

    // v8.1.0 — PUT THE GLOBAL SETTING BACK. It renders into the header wordmark,
    // the login card, the <title> and all 19 email subjects, so leaving it custom
    // makes this file a contaminator of anything that reads it — and the
    // visual-regression baseline reads it, where a longer name wrapped the login
    // card's heading onto a second line and produced a 48 000-pixel diff that
    // looked like a CSS regression. Held by the afterAll guard in
    // tests/isolated-test.js, which names the file that left it changed.
    const { api: rst, csrf: rstCsrf } = await apiLogin("superadmin");
    await rst.patch("/api/admin/settings", {
      headers: { "x-csrf-token": rstCsrf, "content-type": "application/json" },
      data: { platform_name: "Checkmarx Enablement Platform" },
    });
    await rst.dispose();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The badge 404. A LinkedIn badge link that has been revoked (or mistyped) is a
// PUBLIC url that strangers click; it answered with a 130-byte fragment — no
// viewport, no stylesheet, no brand. It is drawn by the standalone shell now
// (verify-pages.css, routes/badge.js _badgeShellTop), as the certificate page is;
// tests/badge-public-page.spec.js holds that shell by day and at night.
// ─────────────────────────────────────────────────────────────────────────────
test("v7.23.6: an invalid badge link renders a real page, not a bare fragment", async ({ page }) => {
  const resp = await page.goto("/badge/definitely-not-a-real-token");
  expect(resp.status(), "an unknown badge token must stay a uniform 404").toBe(404);
  const s = await styling(page);
  assertStyled(s, "/badge/<invalid>");
  expect(s.text.length, "the page must actually say something").toBeGreaterThan(20);
});

// ─────────────────────────────────────────────────────────────────────────────
// Copy: an instruction that cannot work is worse than none (v7.21.14).
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// a11y. These two surfaces had never been scanned, and until this release a
// scan would have been meaningless: an unstyled page has no colours to measure
// and no layout to fail on, so it passes trivially. Now that they render, the
// scan is worth something — including in DARK, which is what a phone in an
// email client most often reports.
// ─────────────────────────────────────────────────────────────────────────────
const GATED = new Set(["moderate", "serious", "critical"]);

for (const scheme of ["light", "dark"]) {
  test(`v7.23.6: the unsubscribe page is clean in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/api/unsubscribe?token=not-a-real-token");
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = r.violations.filter((v) => GATED.has(v.impact));
    expect(bad, `moderate+ a11y violations on the unsubscribe page (${scheme}) `
      + `[${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]`).toHaveLength(0);
  });
}

test("v7.23.6: the badge 404 page is clean", async ({ page }) => {
  await page.goto("/badge/definitely-not-a-real-token");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => GATED.has(v.impact));
  expect(bad, `moderate+ a11y violations on the badge 404 `
    + `[${[...new Set(bad.map(v => v.id))].join(", ") || "none"}]`).toHaveLength(0);
});

test("v7.23.6: verify-expired points at a recovery that EXISTS", async ({ page }) => {
  await page.goto("/verify-expired.html");
  const s = await styling(page);
  // "Please register again" is not the remedy: the account already exists. The
  // recovery that works for EVERY account is signing in with an emailed code —
  // redeeming one confirms the address (routes/auth.js), so it doubles as
  // verification.
  expect(s.text, "verify-expired must not tell the user to register again")
    .not.toMatch(/register again/i);
  expect(s.text, "verify-expired must name a recovery that works")
    .toMatch(/emailed code/i);
  expect(s.text, "and never a password recovery that no longer exists").not.toMatch(/forgot|reset your password/i);
});

