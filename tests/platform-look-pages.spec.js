// @ts-check
//
// THE PLATFORM LOOK REACHES EVERY PAGE THEME-BOOT.JS PAINTS (operator ruling,
// 14 Nov 2026, #307). The help page (opened from the help drawer in a new tab)
// and the pages opened from email links (verification results, the email-change
// pages, the LinkedIn share page) run public/theme-boot.js but carried no
// `data-platform-look`, so the platform's mode, light colour and lock never
// reached them and, under a lock, a person's own earlier choice showed through.
// The server now puts the look on each of them, as on the app's page. The
// public certificate page and the not-found page every badge link that does not
// resolve answers (routes/badge.js _badgeShellTop) run it too, since 9.2.15.
//
//   SOURCE  — every page that runs theme-boot.js carries it: a static page the
//             {{platformLook}} placeholder, a server-rendered one platformLookAttr()
//             on its <html> (planted controls both ways; a floor of pages).
//   API     — each page's attribute IS the stored look, by value, and follows a
//             change at once; pages with no script carry none (the controls).
//   BROWSER — locked, the platform's look and mode win over a browser's own
//             choice on the help page, and its mode on an email page (whose own
//             palette then turns dark); unlocked, the own choice wins (CONTROL);
//             with no own choice, the help page paints the platform's look,
//             mode and colour, not the device's mode and the look's default.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { apiLogin, BASE, freshCtx, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant } = require("./event-admin-helpers");
// The lexically aware stripper: an `https://` inside an HTML template is not a comment.
const { stripComments: stripJsComments } = require("./html-sink-scan");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
const DEFAULT = { look: "", mode: "", ambient: "", lock: false };

async function setLook(value) {
  const s = await apiLogin("superadmin");
  try {
    const r = await s.api.put("/api/admin/platform-look", { headers: H(s.csrf), data: value });
    expect(r.ok(), `set the platform look: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).platform_look;
  } finally { await s.api.dispose(); }
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The `data-platform-look` on a page's <html>, parsed; null when absent. */
function lookAttr(html) {
  const m = /<html\b[^>]*\sdata-platform-look="([^"]*)"/i.exec(html);
  return m ? JSON.parse(decode(m[1])) : null;
}

let staged = null;   // { code } of a staged email change, for the confirm page
test.beforeAll(async () => {
  const s = await apiLogin("superadmin");
  try {
    const p = await makeParticipant(s.api, s.csrf, "look-pages");
    const r = await s.api.put(`/api/admin/participants/${p.id}`, { headers: H(s.csrf), data: { email: `moved-${p.email}` } });
    expect(r.ok(), `stage an email change: ${r.status()} ${await r.text()}`).toBeTruthy();
    const db = new Database(TEST_DB_PATH, { readonly: true, fileMustExist: true });
    try { staged = { code: db.prepare("SELECT pending_email_code c FROM users WHERE id=?").get(p.id).c }; } finally { db.close(); }
    expect(staged.code, "PRECONDITION: a staged change has a confirm code").toBeTruthy();
  } finally { await s.api.dispose(); }
});

/** Static pages, and server templates, that load theme-boot.js but lack the look. */
function pagesMissingTheLook(staticPages, jsSources) {
  const missing = [];
  let staticCount = 0, templateCount = 0;
  for (const [name, html] of staticPages) {
    const src = html.replace(/<!--[\s\S]*?-->/g, "");
    if (!/theme-boot\.js/.test(src)) continue;
    staticCount++;
    const tag = (/<html\b[^>]*>/i.exec(src) || [""])[0];
    if (!/data-platform-look="\{\{platformLook\}\}"/.test(tag)) missing.push(`${name}: <html> has no data-platform-look="{{platformLook}}"`);
  }
  for (const [name, js] of jsSources) {
    const src = stripJsComments(js);
    for (const m of src.matchAll(/theme-boot\.js/g)) {
      templateCount++;
      const at = src.lastIndexOf("<html", m.index);
      const tag = at < 0 || m.index - at > 3000 ? "" : src.slice(at, src.indexOf(">", at) + 1);
      if (!tag.includes("${platformLookAttr()}")) missing.push(`${name}: the page loading theme-boot.js (line ${src.slice(0, m.index).split("\n").length}) has no \${platformLookAttr()} on its <html>`);
    }
  }
  return { missing, staticCount, templateCount };
}

test.describe("the platform look on the help page and the pages opened from email links", () => {
  test("SOURCE: every page that runs theme-boot.js carries the platform look", () => {
    // Planted controls: each kind is caught without the look and passes with it.
    const bad = pagesMissingTheLook([["planted.html", '<html lang="en"><head><script src="/theme-boot.js"></script>']],
      [["planted.js", 'const page = `<!DOCTYPE html><html lang="en"><head><script src="/theme-boot.js"></script>`;']]);
    expect(bad.missing.length, JSON.stringify(bad.missing)).toBe(2);
    const good = pagesMissingTheLook([["planted.html", '<html lang="en" data-platform-look="{{platformLook}}"><head><script src="/theme-boot.js"></script>']],
      [["planted.js", 'const page = `<!DOCTYPE html><html lang="en"${platformLookAttr()}><head><script src="/theme-boot.js"></script>`;\n// a comment naming theme-boot.js is not a page']]);
    expect(good.missing).toEqual([]);
    expect(good.templateCount, "a comment is not a page").toBe(1);

    const statics = fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.endsWith(".html"))
      .map((f) => [`public/${f}`, fs.readFileSync(path.join(ROOT, "public", f), "utf8")]);
    const js = [["server.js", fs.readFileSync(path.join(ROOT, "server.js"), "utf8")]];
    for (const dir of ["routes", "lib"]) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".js"))) js.push([`${dir}/${f}`, fs.readFileSync(path.join(ROOT, dir, f), "utf8")]);
    }
    const r = pagesMissingTheLook(statics, js);
    expect(r.staticCount, "anti-vacuity: the app's page and the help page").toBeGreaterThanOrEqual(2);
    expect(r.templateCount, "anti-vacuity: the result, email-change and share pages, and the certificate pages' shell").toBeGreaterThanOrEqual(4);
    expect(r.missing, "a page that runs theme-boot.js must carry the platform look").toEqual([]);
  });

  test("API: each page carries the stored look, by value, and follows a change; pages with no script carry none", async () => {
    const { api } = await freshCtx();
    try {
      const pages = ["/help.html", "/verified.html", "/verify-expired.html", "/verify-failed.html", "/confirm-email?code=not-a-code", `/confirm-email?code=${staged.code}`,
        "/badge/not-a-real-token", "/badge/not-a-real-link/post"];
      const stored = await setLook({ look: "ambient", mode: "dark", ambient: "rose", lock: true });
      for (const url of pages) {
        const html = await (await api.get(url)).text();
        expect(html, `${url} runs theme-boot.js (the premise)`).toContain("/theme-boot.js");
        expect(lookAttr(html), `${url} carries the platform look`).toEqual(stored);
      }
      // The confirm page is the form, not the "not valid" result (two templates).
      expect(await (await api.get(`/confirm-email?code=${staged.code}`)).text()).toContain("Confirm Your New Email");
      // A change reaches the help page at once (its frozen copy is keyed by the look).
      const next = await setLook({ look: "signature", mode: "light", ambient: "", lock: false });
      expect(lookAttr(await (await api.get("/help.html")).text()), "the help page follows the change").toEqual(next);
      expect(lookAttr(await (await api.get("/verified.html")).text())).toEqual(next);
      expect(lookAttr(await (await api.get("/badge/not-a-real-token")).text()), "the certificate pages' shell follows the change").toEqual(next);
      // CONTROLS: pages with no script keep their fixed appearance and carry nothing.
      for (const url of ["/credential", "/api/unsubscribe?token=nope"]) {
        const html = await (await api.get(url)).text();
        expect(html, `${url} is a page (the premise)`).toMatch(/<html/i);
        expect(html, `${url} runs no theme-boot.js`).not.toContain("theme-boot.js");
        expect(lookAttr(html), `${url} carries no platform look`).toBeNull();
      }
    } finally {
      await setLook(DEFAULT);
      await api.dispose();
    }
  });

  /** A fresh browser whose own stored choice is `own` (null: none), opening `url`. */
  async function paint(browser, url, own, ctxOpts) {
    const ctx = await browser.newContext({ baseURL: BASE, ...(ctxOpts || {}) });
    try {
      const page = await ctx.newPage();
      if (own) {
        await page.addInitScript((o) => {
          try {
            if (!sessionStorage.getItem("primed")) {
              for (const [k, v] of Object.entries(o)) localStorage.setItem(k, v);
              sessionStorage.setItem("primed", "1");
            }
          } catch (_) { /* no storage */ }
        }, own);
      }
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return await page.evaluate(() => ({
        look: document.documentElement.getAttribute("data-look"),
        theme: document.documentElement.getAttribute("data-theme"),
        ambient: document.documentElement.getAttribute("data-ambient"),
        bg: getComputedStyle(document.body).backgroundColor,
      }));
    } finally { await ctx.close(); }
  }

  test("BROWSER: locked, the platform's look and mode win over a browser's own choice; unlocked, the choice wins", async ({ browser }) => {
    const own = { "hck-look": "ambient", "hck-theme": "light", "hck-ambient": "cyan" };
    try {
      await setLook({ look: "signature", mode: "dark", ambient: "", lock: true });
      const help = await paint(browser, "/help.html", own);
      expect([help.look, help.theme], "the help page: the locked look and mode").toEqual(["signature", "dark"]);
      const email = await paint(browser, "/verified.html", own);
      expect(email.theme, "an email page: the locked mode").toBe("dark");
      const confirm = await paint(browser, `/confirm-email?code=${staged.code}`, own);
      expect(confirm.theme, "the email-change page: the locked mode").toBe("dark");

      // CONTROL: unlocked, the browser's own choice wins on both pages.
      await setLook({ look: "signature", mode: "dark", ambient: "", lock: false });
      const help2 = await paint(browser, "/help.html", own);
      expect([help2.look, help2.theme, help2.ambient], "unlocked: the own choice").toEqual(["ambient", "light", "cyan"]);
      const email2 = await paint(browser, "/verified.html", own);
      expect(email2.theme, "unlocked: the own mode").toBe("light");
      expect(email2.bg, "the email page's own palette follows the mode (light differs from dark)").not.toBe(email.bg);
    } finally { await setLook(DEFAULT); }
  });

  test("BROWSER: with no choice of its own, the help page paints the platform's look, mode and colour, not the device's", async ({ browser }) => {
    try {
      await setLook({ look: "ambient", mode: "dark", ambient: "rose", lock: false });
      const help = await paint(browser, "/help.html", null, { colorScheme: "light" });
      expect([help.look, help.theme, help.ambient], "the platform's, on a light device").toEqual(["ambient", "dark", "rose"]);
      const email = await paint(browser, "/verify-failed.html", null, { colorScheme: "light" });
      expect(email.theme, "an email page: the platform's mode, on a light device").toBe("dark");
      // CONTROL: with no platform look the device decides, as before.
      await setLook(DEFAULT);
      const plain = await paint(browser, "/help.html", null, { colorScheme: "light" });
      expect([plain.look, plain.theme, plain.ambient], "the house default on a light device").toEqual(["ambient", "light", "ice"]);
    } finally { await setLook(DEFAULT); }
  });
});
