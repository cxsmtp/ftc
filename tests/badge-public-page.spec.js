// @ts-check
//
// THE PUBLIC CERTIFICATE PAGES ON THE STANDALONE SHELL (9.2.15).
//
// GET /badge/:token and the one not-found page every badge link that does not
// resolve answers were drawn with style="" attributes only: a radial-gradient
// body, hex colours, an 18px literal corner on a 60px-blurred shadow, and
// `color-scheme: dark`, so they were dark only and sat outside every
// stylesheet scanner (CSP admits style attributes). They are drawn now by the
// standalone shell (public/verify-pages.css, routes/badge.js _badgeShellTop)
// with theme-boot.js and the platform look on <html>, like the LinkedIn share
// page. And the shell's corners follow DESIGN_SYSTEM.md §4 by role: cards
// --r-l, buttons and inputs --r-m, small parts --r-s.
//
//   1. one not-found body for every cause (invalid, unshared, revoked, orphaned,
//      and the share link's /post), the shell's; the live page keeps its
//      OpenGraph block, no robots line and its cache header (CONTROL);
//   2. by day and at night: card and artwork corners, a resting tier-1 shadow,
//      no gradient, no style attribute, readable text, one header logo, axe;
//   3. a locked platform mode reaches both pages; unlocked, the device decides
//      (CONTROL);
//   4. every card on the standalone pages has the app's card corner, and every
//      button and input its control corner (the small-part control beside it).
const { test, expect } = require("./isolated-test");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { BASE, apiLogin, freshCtx, TEST_DB_PATH, TEST_DATA_DIR } = require("./helpers");
const { H } = require("./event-admin-helpers");
const { heldCertificate, shareLink } = require("./certificate-fixture");
const { AxeBuilder, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { looks } = require("../scripts/theme/looks");

test.use({ baseURL: BASE });

const SHAPE = looks.signature.shape;          // rs 8px, rm 12px, rl 18px
const DEFAULT = { look: "", mode: "", ambient: "", lock: false };
const SENTENCE = "The link may be incorrect, or this badge is not published or is no longer available.";

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The `data-platform-look` on a page's <html>, parsed; null when absent. */
function lookAttr(html) {
  const m = /<html\b[^>]*\sdata-platform-look="([^"]*)"/i.exec(html);
  return m ? JSON.parse(decode(m[1])) : null;
}

async function setLook(value) {
  const s = await apiLogin("superadmin");
  try {
    const r = await s.api.put("/api/admin/platform-look", { headers: H(s.csrf), data: value });
    expect(r.ok(), `set the platform look: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).platform_look;
  } finally { await s.api.dispose(); }
}

/** The holder's own Share, through the real route: it publishes the page. */
async function share(cert) {
  const { api, csrf } = await apiLogin(cert.holder.email);
  try {
    const r = await api.post(`/badge/${cert.mint.token}/shared`, { headers: H(csrf) });
    expect(r.ok(), `share: ${r.status()} ${await r.text()}`).toBeTruthy();
    expect((await r.json()).published, "PRECONDITION: the owner's share publishes the page").toBe(true);
  } finally { await api.dispose(); }
}

async function getPage(url) {
  const { api } = await freshCtx();
  try {
    const r = await api.get(url);
    return { status: r.status(), headers: r.headers(), body: await r.text() };
  } finally { await api.dispose(); }
}

let live, unshared, revoked, orphaned;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  live = await heldCertificate("bpp-live");
  unshared = await heldCertificate("bpp-unshared");
  revoked = await heldCertificate("bpp-revoked");
  orphaned = await heldCertificate("bpp-orphan");
  // The revoked and orphaned ones are shared first, so the revocation and the
  // missing event are what withholds them, not the unpublished state.
  for (const c of [live, revoked, orphaned]) await share(c);
  for (const c of [revoked, orphaned]) {
    expect((await getPage(`/badge/${c.mint.token}`)).status, "PRECONDITION: shared, its page is live").toBe(200);
  }
  const sa = await apiLogin("superadmin");
  try {
    const r = await sa.api.post(`/api/admin/badges/${encodeURIComponent(revoked.mint.token)}/revoke`, { headers: H(sa.csrf), data: { reason: "badge-public-page" } });
    expect(r.ok(), `revoke: ${r.status()} ${await r.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }
});

test("a badge link that does not resolve answers one page for every cause, the shell's; the live page keeps its OpenGraph tags, no robots line and its cache header", async () => {
  const bogus = await getPage(`/badge/${crypto.randomBytes(32).toString("hex")}`);
  expect(bogus.status).toBe(404);
  const nf = bogus.body;
  // The orphaned certificate: its event is gone while the row stays. The cascade
  // makes that unreachable through the app, so it is built on a side connection
  // with foreign keys off, and put back (and checked) in the finally.
  const db = new Database(TEST_DB_PATH);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = OFF");
  const was = db.prepare("SELECT competition_id c FROM achievement_badges WHERE token=?").get(orphaned.mint.token).c;
  const answers = {};
  try {
    db.prepare("UPDATE achievement_badges SET competition_id=? WHERE token=?").run(`gone-${Date.now()}`, orphaned.mint.token);
    answers.orphaned = await getPage(`/badge/${orphaned.mint.token}`);
  } finally {
    db.prepare("UPDATE achievement_badges SET competition_id=? WHERE token=?").run(was, orphaned.mint.token);
    const back = db.prepare("SELECT competition_id c FROM achievement_badges WHERE token=?").get(orphaned.mint.token).c;
    const fk = db.prepare("PRAGMA foreign_key_check(achievement_badges)").all();
    db.close();
    expect(back, "the orphaned row was put back").toBe(was);
    expect(fk, "no foreign key left broken").toEqual([]);
  }
  answers.unshared = await getPage(`/badge/${unshared.mint.token}`);
  answers.revoked = await getPage(`/badge/${revoked.mint.token}`);
  answers.post = await getPage(`/badge/${crypto.randomBytes(32).toString("hex")}/post`);
  for (const [cause, a] of Object.entries(answers)) {
    expect(a.status, `${cause}: 404`).toBe(404);
    expect(a.body, `${cause}: byte-identical to the invalid token's page`).toBe(nf);
  }

  // The shell, by value.
  for (const piece of ['href="/verify-pages.css"', 'src="/theme-boot.js"', "data-platform-look=",
    '<meta name="color-scheme" content="light dark"/>', '<meta name="robots" content="noindex,nofollow"/>',
    'class="card badge-gone"', "This badge isn't available", SENTENCE]) {
    expect(nf, `the not-found page carries ${piece}`).toContain(piece);
  }
  expect(nf, "no style attribute").not.toMatch(/\sstyle=/i);
  expect(nf, "no gradient").not.toMatch(/gradient/i);
  expect(nf, "no hex colour").not.toMatch(/#[0-9A-Fa-f]{6}\b/);

  // CONTROL: the live page, on the same shell, keeps what a crawler reads.
  const page = await getPage(`/badge/${live.mint.token}`);
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"], "the live page's cache header").toBe("public, max-age=300");
  const html = page.body;
  expect(html).toMatch(/<meta property="og:image" content="[^"]+\/badge\/[^"/]+\/badge\.png"\/>/);
  expect(html).toContain('<meta property="og:title" content=');
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  expect(html, "a published page is meant to be found").not.toContain('name="robots"');
  expect(html).toContain('<meta name="color-scheme" content="light dark"/>');
  expect(html).toContain('class="card badge-card"');
  expect(html, "no style attribute").not.toMatch(/\sstyle=/i);
  expect(html, "no gradient").not.toMatch(/gradient/i);
  expect(html, "the live page is not the not-found page (the comparison above is not vacuous)").not.toBe(nf);
});

/** Everything the paint arms read, in one evaluate (probes added after the count). */
function measure(page, kind) {
  return page.evaluate((kind) => {
    const styled = document.querySelectorAll("[style]").length;   // before any probe
    const cs = (el) => getComputedStyle(el);
    const probe = (prop, val) => {
      const d = document.createElement("div");
      d.style.setProperty(prop, val);
      document.body.appendChild(d);
      const v = getComputedStyle(d).getPropertyValue(prop);
      d.remove();
      return v;
    };
    const rgba = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    // The background a text is drawn on: the first opaque one, starting at the
    // element ITSELF (a button paints its own fill).
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgba(cs(e).backgroundColor);
        if (c && c[3] === 1) return c;
      }
      return [255, 255, 255, 1];
    };
    const ratio = (el) => {
      const bg = bgOf(el);
      let fg = rgba(cs(el).color);
      fg = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
    };
    const card = document.querySelector(kind === "live" ? ".card.badge-card" : ".card.badge-gone");
    const img = document.querySelector(".badge-card img");
    const btn = document.querySelector(".btn");
    const s1 = probe("box-shadow", "var(--shadow-1)");
    const s2 = probe("box-shadow", "var(--shadow-2)");
    const shadows = [], gradients = [];
    for (const el of document.querySelectorAll("*")) {
      const sh = cs(el).boxShadow;
      if (sh !== "none" && sh !== s1 && sh !== s2) shadows.push(`${el.tagName}.${el.className}: ${sh}`);
      if (/gradient/.test(cs(el).backgroundImage)) gradients.push(`${el.tagName}.${el.className}`);
    }
    const texts = kind === "live"
      ? { h1: ".badge-card h1", meta: ".badge-meta" }
      : { h1: ".badge-gone h1", p: ".badge-gone p", btn: ".btn" };
    Object.assign(texts, { brand: "header .brand span", copy: ".footer-copy" });
    const contrast = {};
    for (const [k, sel] of Object.entries(texts)) {
      const el = document.querySelector(sel);
      contrast[k] = el ? ratio(el) : null;
    }
    const logos = [...document.querySelectorAll("header img")].filter((i) => cs(i).display !== "none").map((i) => i.className);
    return {
      theme: document.documentElement.dataset.theme,
      sheets: document.styleSheets.length,
      styled,
      cardBg: card ? cs(card).backgroundColor : null,
      cardRadius: card ? cs(card).borderTopLeftRadius : null,
      cardShadow: card ? cs(card).boxShadow : null,
      imgRadius: img ? cs(img).borderTopLeftRadius : null,
      imgShadow: img ? cs(img).boxShadow : null,
      s1, s2, shadows, gradients,
      bodyBg: cs(document.body).backgroundColor,
      bgProbe: probe("background-color", "var(--bg)"),
      headerBg: cs(document.querySelector("header")).backgroundColor,
      footerBg: cs(document.querySelector("footer")).backgroundColor,
      h1Select: cs(document.querySelector("main h1")).userSelect,
      btnBg: btn ? cs(btn).backgroundColor : null,
      accentProbe: probe("background-color", "var(--accent)"),
      contrast, logos,
    };
  }, kind);
}

test("the certificate page and its not-found page draw the shell's card by day and at night: card corners, artwork corners, a resting shadow, no gradient, readable text", async ({ browser }) => {
  expect(SHAPE.rl, `CONTROL: the card and control rungs differ (${SHAPE.rl} vs ${SHAPE.rm})`).not.toBe(SHAPE.rm);
  const got = {};
  for (const scheme of ["light", "dark"]) {
    for (const [kind, url] of [["live", `/badge/${live.mint.token}`], ["gone", "/badge/not-a-real-token"]]) {
      // A fresh context per arm: the live page is cacheable for five minutes.
      const ctx = await browser.newContext({ baseURL: BASE, colorScheme: scheme });
      try {
        const page = await ctx.newPage();
        await page.addInitScript(() => { try { localStorage.setItem("hck-theme", "system"); } catch (_) { /* no storage */ } });
        await page.goto(url);
        await page.locator("footer").waitFor({ state: "visible" });
        if (kind === "live") {
          await expect.poll(() => page.locator(".badge-card img").evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth),
            { message: "the artwork decoded" }).toBeGreaterThan(0);
        }
        const m = await measure(page, kind);
        const why = JSON.stringify({ scheme, kind, ...m });
        // PRECONDITIONS: the mode took, the sheet applied, nothing styled inline.
        expect(m.theme, `PRECONDITION: the page resolved ${scheme}: ${why}`).toBe(scheme);
        expect(m.sheets, why).toBeGreaterThan(0);
        expect(m.cardBg, `PRECONDITION: the card is painted by the sheet: ${why}`).not.toBe("rgba(0, 0, 0, 0)");
        expect(m.styled, `no element carries a style attribute: ${why}`).toBe(0);
        // Corners by role.
        expect(m.cardRadius, `the card is --r-l: ${why}`).toBe(SHAPE.rl);
        if (kind === "live") {
          expect(m.imgRadius, `the artwork is an answer block, --r-m: ${why}`).toBe(SHAPE.rm);
          expect(m.imgShadow, `the artwork has no shadow of its own: ${why}`).toBe("none");
          expect(m.h1Select, `the holder's name stays selectable: ${why}`).not.toBe("none");
        }
        // Flat: the card rests on tier 1, every shadow is a tier, no gradient.
        expect(m.s1, `PRECONDITION: the tier-1 probe resolved: ${why}`).not.toBe("none");
        expect(m.cardShadow, `the card rests on tier 1: ${why}`).toBe(m.s1);
        expect(m.shadows, `every shadow is a tier: ${why}`).toEqual([]);
        expect(m.gradients, `no gradient: ${why}`).toEqual([]);
        // Surfaces: a flat --bg body; header and footer the card's surface.
        expect(m.bodyBg, `the body is --bg: ${why}`).toBe(m.bgProbe);
        expect(m.headerBg, `the header is the card's surface: ${why}`).toBe(m.cardBg);
        expect(m.footerBg, `the footer is the card's surface: ${why}`).toBe(m.cardBg);
        expect(m.logos, `one header logo, the mode's own: ${why}`).toEqual([scheme === "light" ? "logo-light" : "logo-dark"]);
        // Readable text (AA), each against what it is drawn on.
        if (kind === "gone") {
          expect(m.btnBg, `CONTROL: the button is measured on its own accent fill: ${why}`).toBe(m.accentProbe);
          expect(m.btnBg, why).not.toBe(m.cardBg);
        }
        for (const [k, r] of Object.entries(m.contrast)) {
          expect(r, `${k} was measured: ${why}`).not.toBeNull();
          expect(r, `${k} reads at AA (${r}): ${why}`).toBeGreaterThanOrEqual(4.5);
        }
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        const bad = axe.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact));
        expect(bad.map((v) => v.id), `axe (${scheme}, ${kind})`).toEqual([]);
        got[`${scheme}:${kind}`] = m;
      } finally { await ctx.close(); }
    }
  }
  // CROSS-MODE CONTROL: the mode really changed the palette.
  expect(got["light:live"].cardBg).not.toBe(got["dark:live"].cardBg);
  expect(got["light:live"].s1).not.toBe(got["dark:live"].s1);
});

test("a locked platform mode reaches the certificate page and its not-found page; an unlocked platform leaves the device's mode", async ({ browser }) => {
  const urls = [`/badge/${live.mint.token}`, "/badge/not-a-real-token"];
  async function paint(url, want) {
    const ctx = await browser.newContext({ baseURL: BASE, colorScheme: "light" });
    try {
      const page = await ctx.newPage();
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      // The HTML this context received carries the stored look (no cached copy).
      expect(lookAttr(await resp.text()), `${url}: the look this context received`).toEqual(want);
      return await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }));
    } finally { await ctx.close(); }
  }
  try {
    const stored = await setLook({ look: "signature", mode: "dark", ambient: "", lock: true });
    for (const url of urls) {
      expect(lookAttr((await getPage(url)).body), `${url} carries the stored look`).toEqual(stored);
    }
    const locked = [];
    for (const url of urls) {
      const p = await paint(url, stored);
      expect(p.theme, `${url}: the locked mode on a light device`).toBe("dark");
      expect(p.bg, `${url}: the night --bg`).toBe("rgb(12, 10, 23)");
      locked.push(p);
    }
    // CONTROL: with no platform look the device decides.
    const plain = await setLook(DEFAULT);
    for (const [i, url] of urls.entries()) {
      const p = await paint(url, plain);
      expect(p.theme, `${url}: unlocked, the device's mode`).toBe("light");
      expect(p.bg, `${url}: the day palette differs`).not.toBe(locked[i].bg);
    }
  } finally {
    await setLook(DEFAULT);
  }
});

/** A real unsubscribe token for `email`: generateUnsubscribeToken's recipe. */
function unsubscribeToken(email) {
  const secret = fs.readFileSync(path.join(TEST_DATA_DIR, ".unsubscribe-secret"));
  const payload = JSON.stringify({ e: email, x: Date.now() + 24 * 3600_000 });
  const b64 = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64(payload)}.${b64(crypto.createHmac("sha256", secret).update(payload).digest())}`;
}

test("every card on the standalone pages has the app's card corners, and every button and input its control corners", async ({ browser }) => {
  const { rl, rm, rs } = SHAPE;
  expect(new Set([rl, rm, rs]).size, `CONTROL: the three rungs differ: ${rl} ${rm} ${rs}`).toBe(3);
  /** Each selector's top-left radius, after asserting it rendered. */
  async function radii(page, sels) {
    const out = {};
    for (const sel of sels) {
      const loc = page.locator(sel).first();
      await expect(loc, `${sel} rendered`).toBeVisible();
      const box = await loc.boundingBox();
      expect(box && box.width > 0 && box.height > 0, `${sel} has a box`).toBe(true);
      out[sel] = await loc.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    }
    return out;
  }
  const ctx = await browser.newContext({ baseURL: BASE });
  try {
    const page = await ctx.newPage();

    await page.goto("/verified.html");
    expect(await radii(page, [".card", ".btn", "footer .footer-social a"]), "/verified.html")
      .toEqual({ ".card": rl, ".btn": rm, "footer .footer-social a": rs });
    // A focused button keeps its corner (the focus rule carries none).
    let focused = null;
    for (let i = 0; i < 12 && !focused; i++) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => {
        const a = document.activeElement;
        return a && a.matches(".btn") && a.matches(":focus-visible") ? getComputedStyle(a).borderTopLeftRadius : null;
      });
    }
    expect(focused, "the button, focused from the keyboard, keeps --r-m").toBe(rm);

    await page.goto(`/api/unsubscribe?token=${encodeURIComponent(unsubscribeToken(`bpp-${Date.now()}@acme.com`))}`);
    await expect(page.getByRole("button", { name: "Yes, unsubscribe me" }), "the real confirmation page").toBeVisible();
    expect(await radii(page, ["main.card", "main.card form button"]), "the unsubscribe confirmation")
      .toEqual({ "main.card": rl, "main.card form button": rm });
    await page.goto("/api/unsubscribe?token=not-a-real-token");
    expect(await radii(page, ["main.card"]), "the unsubscribe link-expired page").toEqual({ "main.card": rl });

    await page.goto("/credential");
    await page.locator("#cred-code").fill("ABCD-EFGH-JKMN");
    await page.locator("#cred-surname").fill("Nobody");
    await page.locator(".cred-form button[type=submit]").click();
    await page.locator(".cred-card.cred-warn").waitFor({ state: "visible" });
    expect(await radii(page, [".cred-card.cred-warn", "#cred-code", ".cred-form .btn"]), "/credential")
      .toEqual({ ".cred-card.cred-warn": rl, "#cred-code": rm, ".cred-form .btn": rm });

    await page.goto(`/badge/${shareLink(live.mint.token)}/post`);
    expect(await radii(page, [".share-post-card", "#share-post-text", "#share-post-go", "#share-post-copy"]), "the share page")
      .toEqual({ ".share-post-card": rl, "#share-post-text": rm, "#share-post-go": rm, "#share-post-copy": rm });
  } finally { await ctx.close(); }
});
