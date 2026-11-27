// @ts-check
// Visual-regression gate (v6.20.x) — pixel-diff baselines via toHaveScreenshot.
//
// PREREQUISITE met in v6.20.x: fonts are self-hosted (public/fonts.css →
// /vendor/fonts/*.woff2), so rendering no longer depends on Google Fonts CDN
// timing or a host system-ui fallback. That determinism is what makes a
// pixel-diff gate viable here (it was deliberately declined before — see the
// CLAUDE.md "Accepted audit dispositions" history).
//
// SCOPE: a small set of STABLE, high-value, anonymous screens. We do NOT
// screenshot live/admin data surfaces (timers, leaderboard rows, ECharts) —
// those carry irreducibly volatile content that pixel-diff can't sanely gate.
// Volatile chrome (the version badge) is masked.
//
// BASELINES: committed under tests/visual-regression.spec.js-snapshots/ and are
// browser+OS specific (Playwright names them *-chromium-linux.png). CI runs the
// same Chromium/Linux as these baselines. If you change the render environment
// (Playwright/Chromium version, OS), regenerate with:
//   npx playwright test tests/visual-regression.spec.js --update-snapshots=all
// `=all`, not a bare `--update-snapshots` / `-u`: the bare flag means
// `changed`, which rewrites only a comparison that FAILED — and a
// render-environment change can land under the tolerance and pass, leaving the
// old pixels as the reference for every later diff.
// Deleting the baseline PNGs (tests/visual-regression.spec.js-snapshots/) and
// re-running is equivalent; the first run then FAILS while it writes them,
// which reads as a regression and is not one.
// maxDiffPixelRatio gives a small tolerance for antialiasing jitter without
// letting a real layout/color regression through.
//
// v8.11.3 — LOWERED 0.01 -> 0.0005, on a MEASUREMENT rather than a guess. The
// noise floor was sampled by re-running the shots of the time against the committed
// baselines at tolerance 0: 60-130 changed pixels on a 1280x800 viewport
// (1,024,000 px), i.e. 0.006%-0.013%. The old 1% was ~80x that floor, and
// CLAUDE.md records it swallowing two real changes: a whole bordered join-code
// box (~0.3%, v8.2.3) and a login link (~0.86%, v8.1.0 PR 33). Both PASSED.
// 0.0005 (0.05%) is still 4-8x the measured floor, so antialiasing jitter is
// absorbed, while anything the size of a control is not.
//
// v8.13.4 — THAT "NOISE FLOOR" WAS THE VERSION BADGE, NOT ANTIALIASING. The
// mask paints over #platform-version, but the badge's WIDTH still decides
// where the theme and Help buttons beside it sit, and the badge reads the
// platform version — so every release whose version string renders a pixel
// wider or narrower moved those two buttons and the mask's edge (64-65 px per
// shot from v8.8.13 to v8.13.4; the 60-130 px of v8.11.3 is the same thing,
// and v8.8.13's "Chromium moved them 148-153 px" was measured against
// baselines taken at a version one digit shorter, so it was most probably the
// badge too — no longer provable, that Chromium is gone).
// Measured on the Playwright 1.63 → 1.64 step (Chromium 153 → 156): with the
// version string set back to the baseline's, all four shots matched the old
// baselines at maxDiffPixelRatio 0 AND threshold 0, i.e. byte-for-byte; with
// the real one they differed by exactly the badge. So ready() pins the badge
// text before the shot, and the shot no longer depends on the version at all
// (measured: a run with version "88.888.888" matched baselines taken at 8.13.4
// at tolerance 0; the same run without the pin differed by 2513-2517 px).
//
// AND THE ADOPTION RULE THAT GOES WITH IT: a bare `--update-snapshots` does NOT
// rewrite a comparison that PASSED, so a deliberate change landing under the
// tolerance leaves the baseline holding the pre-change pixels and every later
// diff is measured from a stale reference. To adopt such a change, run with
// `--update-snapshots=all`, or DELETE the baseline PNGs and re-run. Lowering
// the tolerance shrinks that trap; it does not remove it.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");

test.use({ baseURL: BASE });

// Shared screenshot options: mask the volatile version badge, allow a tiny
// antialiasing tolerance, disable animations so transitions don't race the shot.
function shotOpts(page) {
  return {
    mask: [page.locator("#platform-version")],
    maxDiffPixelRatio: 0.0005,
    animations: "disabled",
  };
}

// Wait for self-hosted fonts to finish loading before any shot — otherwise the
// first frame can capture the FOUT fallback and diff against a webfont baseline.
//
// Then PIN the version badge (v8.13.4, see the header): masked or not, its
// width lays out the buttons beside it. It is pinned only once boot has filled
// it — the login form is visible from the static shell, BEFORE /api/config
// answers, so pinning first would race the real text back in — and asserted
// afterwards, so dropping the pin line alone fails here. Dropping the pin AND
// its assertion together would pass most shots (a version-width change is
// 475-519 px, around the 0.0005 tolerance of ~512 px), so the SOURCE arm at the end of this
// file holds the pair (v8.13.4 review).
const PINNED_VERSION = "v.0.0.0";
async function ready(page, anchor) {
  await page.locator(anchor).waitFor({ state: "visible", timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  const badge = page.locator("#platform-version");
  await expect(badge).not.toHaveText("", { timeout: 15000 });
  await badge.evaluate((el, v) => { el.textContent = v; }, PINNED_VERSION);
  await expect(badge).toHaveText(PINNED_VERSION);
}

test.describe("Visual regression (v6.20.x)", () => {
  // The registration form shows the country and timezone DETECTED from the
  // browser, and a browser takes the host's zone unless told otherwise: the
  // baselines were made in CI's UTC container, so a run on a machine in any
  // other zone drew a different form. Pinned, so the shot is the same everywhere.
  test.use({ timezoneId: "UTC" });
  for (const theme of ["dark", "light"]) {
    test(`login screen (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem("hck-theme", t); } catch (_) {} }, theme);
      await page.goto("/");
      await ready(page, "#login-email");
      await expect(page).toHaveScreenshot(`login-${theme}.png`, shotOpts(page));
    });
  }

  test("registration form", async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem("hck-theme", "dark"); } catch (_) {} });
    // Email first: the form opens only once an address proof is redeemed, so
    // reach it through the real door (code step, then the form) on a FIXED new
    // address — the form shows it, and a per-run address would change the shot.
    // Each spec file gets a fresh server, so the address is always new here.
    await page.goto("/");
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 15000 });
    await page.fill("#login-email", "visual-signup@company.example");
    await page.click("#login-submit");
    await page.locator("#sc-code").waitFor({ state: "visible", timeout: 15000 });
    const r = await page.request.get("/api/test/last-login-code?email=" + encodeURIComponent("visual-signup@company.example"));
    expect(r.ok(), "the new address was mailed an address proof").toBeTruthy();
    await page.fill("#sc-code", (await r.json()).code);
    await page.click("#signin-code-overlay [data-action='signin-code-redeem']");
    await ready(page, "#register-page.active #reg-first");
    await expect(page).toHaveScreenshot("register-dark.png", shotOpts(page));
  });


});

// SOURCE ARM (v8.13.4 review). The pin's only behavioural witness is the
// assertion inside ready() itself, so a refactor that drops both lines leaves
// the shots green or nearly so: a one-character version change measured 475-519
// px of diff against a ~512 px tolerance, so most would still pass. This reads the file and requires that
// ready() WRITES the pinned text into #platform-version and ASSERTS it, that the
// pin is a fixed literal rather than anything read from version.json, and that
// every screenshot in the file is taken after ready().
test("source arm: ready() pins and asserts the version badge before every shot", () => {
  const fs = require("fs");
  // Comments stripped in ONE left-to-right pass that also steps over strings, line
  // structure kept. Block-then-line is wrong here specifically: the header's
  // `/vendor/fonts/*.woff2` opens a "block comment" that swallows PINNED_VERSION.
  const src = fs.readFileSync(__filename, "utf8").replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    m => (m[0] === "/" ? m.replace(/[^\n]/g, " ") : m));
  const pin = src.match(/const PINNED_VERSION\s*=\s*(["'])([^"'\n]*)\1\s*;/);
  expect(pin, "PINNED_VERSION is a string literal").not.toBeNull();
  expect(pin[2], "the pin is a fixed placeholder, not a real version").toBe("v.0.0.0");
  expect(src, "the pin must not track the build: nothing here loads the version file").not.toMatch(/(?:require|readFileSync)\([^)]*version\.json/);
  const start = src.indexOf("async function ready(");
  expect(start, "ready() exists").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  // The WRITE is any `.evaluate(…)` call whose own (paren-balanced) argument list
  // assigns textContent and passes PINNED_VERSION — read semantically, not as one
  // spelling, so renaming the callback's parameters or reformatting it is not a
  // failure (the fix-delta review: a scanner wrong about working code gets
  // deleted). Balancing keeps a later `toHaveText(PINNED_VERSION)` from
  // satisfying a write that does not pass the pin.
  const argsAt = (i) => {
    let d = 0;
    for (let j = i; j < body.length; j++) {
      if (body[j] === "(") d++;
      else if (body[j] === ")" && --d === 0) return body.slice(i, j + 1);
    }
    return "";
  };
  let write = -1;
  for (const m of body.matchAll(/\.evaluate\(/g)) {
    const args = argsAt(m.index + m[0].length - 1);
    if (/\btextContent\s*=/.test(args) && /\bPINNED_VERSION\b/.test(args)) { write = m.index; break; }
  }
  const assert = body.search(/toHaveText\(\s*PINNED_VERSION\s*[,)]/);
  const filled = body.search(/not\.toHaveText\(\s*(["'`])\1/);
  expect(body, "ready() addresses the version badge").toMatch(/locator\(\s*"#platform-version"\s*\)/);
  expect(write, "ready() writes PINNED_VERSION into the badge").toBeGreaterThan(-1);
  expect(assert, "ready() asserts the badge reads PINNED_VERSION").toBeGreaterThan(-1);
  expect(filled > -1 && filled < write, "the pin waits for boot to fill the badge first, or the real text races back in").toBe(true);
  expect(write < assert, "the assertion follows the write").toBe(true);
  // Every shot is preceded, inside its own test, by `await ready(`.
  const shots = [...src.matchAll(/toHaveScreenshot\(/g)].map(m => m.index);
  expect(shots.length, "anti-vacuity: two call sites (the login loop shoots both themes) behind the three baselines").toBeGreaterThanOrEqual(2);
  for (const at of shots) {
    const testStart = src.lastIndexOf("test(", at);
    expect(src.slice(testStart, at), `the shot at offset ${at} is taken after ready()`).toMatch(/await ready\(page,/);
  }
});
