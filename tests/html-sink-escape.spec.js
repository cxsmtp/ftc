// @ts-check
//
// HTML SINKS ESCAPE WHAT THEY ARE GIVEN.
//
// A custom role label reached showModal's `message` unescaped (users-admin.js,
// the Add user "existing account" confirm), and showModal renders its message as
// HTML: a stored XSS any admin who can name a role could plant for every other
// admin. The fix was one esc(); the class is every place public/js writes dynamic
// text into an HTML sink. This file is the family's guard, in two halves that
// each see what the other cannot:
//
//   1. SOURCE (tests/html-sink-scan.js) — every sink in public/js (showModal's
//      message, _countdownConfirm, setSafeHtml, innerHTML/outerHTML, insert-
//      AdjacentHTML), followed back through variables, first-party helpers and
//      parameters to every call site, must be built only of escaped or provably
//      inert values. It reaches dialogs and states no browser test builds. It is
//      TAUGHT the idioms (numbers, ICO.* icons, static tables, *Html renderers
//      whose own inputs are escaped, fmtDt, the rich-text sanitiser, inert-
//      document parses) and anything else is a finding unless it is on ALLOW
//      below with its reason. ALLOW is checked both ways: a stale entry fails.
//      RENDERER_CONTRACTS hold the builders that ALLOW entries lean on.
//   2. BROWSER — a role label, an event name, a group name and a challenge title
//      carrying `<img src=x onerror=window.__xss=1>` are put through the real
//      dialogs that show them, plus the invite-results panel fed the same text by
//      the server. The witness is the DOM: no <img> appears and the text is shown
//      literally. (`window.__xss` is asserted too, but the CSP has no
//      'unsafe-inline', so an injected handler would not run even when the markup
//      lands — the <img> count is what can fail, and a positive control proves it.)
//
// STATED GAPS (what the scanner does NOT prove):
//   * NUMERIC_PROPS / NUMERIC_PROP_RE trust a property by NAME (`id`, `score`,
//     `rank`, `*_count`, `skipped*`…): a server field so named that carried text
//     would pass. `(x||0).toLocaleString()` is trusted as a number the same way.
//   * Helpers are resolved by name (same file first, else an export) and their
//     callers found by direct or aliased calls only; a helper also used as a
//     value (a callback, `.call`/`.apply`/`.bind`, a property) is reported, never
//     assumed safe, as is an expression nested too deep to follow.
//   * Only showModal's `message` is treated as HTML; its title and button labels
//     are set as text by ui/modal.js. A new HTML-taking option needs teaching.

const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask } = require("./event-admin-helpers");

const ROOT = path.join(__dirname, "..");
const { scan, Scanner } = require("./html-sink-scan");

// Reviewed exceptions: the value IS markup, by construction, and is not built
// from anything a person types. Key: file + the expression the scanner prints.
const ALLOW = [
  { file: "public/js/features/competition-picker.js", expr: "c.status",
    why: "the server's derived status (upcoming|live|ended, lib/competitions.js competitionStatus), never text a person writes" },
  { file: "public/js/features/challenges-admin.js", expr: "el.innerHTML",
    why: "re-serialises an already rendered, sanitised <pre><code> block to turn <br>/<div> into newlines; its text nodes serialise escaped" },
  { file: "public/js/features/participant-tasks.js", expr: "el.innerHTML",
    why: "the same <pre><code> newline normalisation on the participant card" },
  { file: "public/js/features/event-workspace.js", expr: "btn.innerHTML",
    why: "a button's own markup, saved before a busy state and written back after it" },
  { file: "public/js/features/participants-admin.js", expr: "srcMenu.innerHTML",
    why: "copies an already rendered row menu into the shared #kebab-portal" },
  { file: "public/js/features/help-drawer.js", expr: "window.HelpRenderer.render(md, basePath, { linkMode: 'drawer' })",
    why: "the first-party guide renderer (public/help-renderer.js, which esc()s every text and attribute) over the app's own docs/*.md" },
  { file: "public/js/features/history.js", expr: "i.changeHtml",
    why: "built only by formatEventChange / _diffTaskVersion / _fmtRevealRow, each held by RENDERER_CONTRACTS below" },
  { file: "public/js/ui/richtext.js", expr: "hljs.highlight(text,{language:lang,ignoreIllegals:true}).value",
    why: "highlight.js output, built from the code block's textContent and escaped by the library" },
  { file: "public/js/ui/richtext.js", expr: "hljs.highlightAuto(text).value",
    why: "highlight.js auto-detected output, built from textContent and escaped by the library" },
  { file: "public/js/ui/richtext.js", expr: "c.innerHTML",
    why: "the rich editor's own round trip: getHtml serialises the editor DOM, setHtml loads server-sanitised rich text (lib/sanitise.js) back into it" },
  { file: "public/js/features/event-team.js", expr: "d.html",
    why: "a report email from GET .../team-report/preview: lib/team-report-mail.js escapes every dynamic value, and setSafeSrcdoc only loads it into a sandboxed frame with no scripts and an opaque origin" },
];

// Builders an ALLOW entry leans on: each expression, judged at its anchor, must
// come back proven safe with no finding.
const RENDERER_CONTRACTS = [
  { file: "public/js/features/history.js", anchor: "changeHtml=formatEventChange(ev)", expr: "formatEventChange(ev)" },
  { file: "public/js/features/history.js", anchor: "changeHtml=_diffTaskVersion(ev,prev)", expr: "_diffTaskVersion(ev,prev)" },
  { file: "public/js/features/history.js", anchor: "changeHtml=_fmtRevealRow(ev)", expr: "_fmtRevealRow(ev)" },
];

const keyOf = (f) => `${f.file} :: ${f.expr}`;

test.describe("HTML sinks — source scanner", () => {
  test("every dynamic value written into an HTML sink is escaped, or allow-listed with a reason", () => {
    const r = scan(ROOT);
    // Anti-vacuity: the scanner found the sinks it exists to judge.
    expect(r.sinkCount, "the scanner reached the sinks (showModal, setSafeHtml, innerHTML…)").toBeGreaterThan(350);
    const allowed = new Set(ALLOW.map(a => `${a.file} :: ${a.expr}`));
    const open = r.findings.filter(f => !allowed.has(keyOf(f)));
    expect(open.map(f => `${f.file}:${f.line}: ${f.expr}  [${f.why}]  (sink ${f.sink})`),
      "unescaped value(s) reach an HTML sink — wrap them in esc(), or teach the scanner an idiom; never widen ALLOW without a reason").toEqual([]);
    // Both directions: an ALLOW entry the code no longer needs is deleted.
    const seen = new Set(r.findings.map(keyOf));
    expect(ALLOW.filter(a => !seen.has(`${a.file} :: ${a.expr}`)).map(a => `${a.file} :: ${a.expr}`),
      "stale ALLOW entries (the value is now escaped or gone): delete them").toEqual([]);
    for (const a of ALLOW) expect(a.why.length, `ALLOW ${a.file} :: ${a.expr} carries a reason`).toBeGreaterThan(40);
  });

  test("the builders the allow-list leans on are themselves proven safe", () => {
    const s = new Scanner(ROOT);
    for (const c of RENDERER_CONTRACTS) {
      const src = s.files[c.file].src;
      const at = src.indexOf(c.anchor);
      expect(at, `anchor "${c.anchor}" still exists in ${c.file}`).toBeGreaterThan(-1);
      s.findings = [];
      const ok = s.safe(c.file, at + c.anchor.indexOf(c.expr), c.expr);
      expect(s.findings.map(f => `${f.file}:${f.line}: ${f.expr} [${f.why}]`), `${c.expr} builds only escaped values`).toEqual([]);
      expect(ok, `${c.expr} is proven safe`).toBe(true);
    }
  });

  test("the guide renderer the help-drawer entry leans on writes raw HTML and a link's text as text (behavioural)", () => {
    // public/help-renderer.js, run with the vendored marked in a bare context
    // (no document: its screenshot observer stays off).
    const vm = require("vm");
    const sandbox = { console, URL, location: { origin: "http://help.test" } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const f of ["public/vendor/marked.min.js", "public/help-renderer.js"]) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
    }
    const render = (md) => sandbox.HelpRenderer.render(md, "/docs/participant.md", { linkMode: "page" });
    const bad = "<img src=x onerror=window.__xss=1>";
    // Raw HTML, as a block and inline (renderer.html).
    const block = render(`Intro\n\n${bad}\n\nA word in *<b>bold</b>* here.\n`);
    expect(block, "a raw HTML block is shown as text").toContain("&lt;img src=x onerror=window.__xss=1&gt;");
    expect(block, "inline raw HTML is shown as text").toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(block.toLowerCase()).not.toContain("<img");
    expect(block.toLowerCase()).not.toContain("<b>");
    // A link's visible text comes from its escaped inline tokens (linkInner),
    // never from the raw source.
    const link = render(`[${bad}](https://example.com/page) and [**Bold** text](https://example.com/b) and [x](javascript:alert(1))`);
    expect(link, "the link's text is the escaped payload").toContain('rel="noopener noreferrer">&lt;img src=x onerror=window.__xss=1&gt;</a>');
    expect(link.toLowerCase()).not.toContain("<img");
    expect(link, "CONTROL: link text still renders its markdown").toContain("<strong>Bold</strong> text</a>");
    expect(link, "a javascript: URL never reaches the href").toContain('<a href="#" target="_blank" rel="noopener noreferrer">x</a>');
  });

  test("planted controls: the scanner flags an unescaped value, passes its escaped twin, and ignores a comment", () => {
    // A throwaway tree holding one planted module beside a copy of format.js, so
    // the planted code can import esc() the way app code does.
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "sinkscan-"));
    try {
      fs.mkdirSync(path.join(tmp, "public/js/ui"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "public/js/core"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "public/js/ui/format.js"), path.join(tmp, "public/js/ui/format.js"));
      fs.writeFileSync(path.join(tmp, "public/js/core/trusted-types.js"), "export function setSafeHtml(el, s) { el.innerHTML = s; }\n");
      fs.writeFileSync(path.join(tmp, "public/js/ui/planted.js"), [
        'import { esc } from "./format.js";',
        'import { setSafeHtml } from "../core/trusted-types.js";',
        "export function bad(el, user) { setSafeHtml(el, `<b>${user.name}</b>`); }",
        "export function good(el, user) { setSafeHtml(el, `<b>${esc(user.name)}</b>`); }",
        "export function badModal(role) { return showModal({ title: 'x', message: `Give them ${role.label}?` }); }",
        "export function goodModal(role) { return showModal({ title: `${role.label}`, message: `Give them ${esc(role.label)}?` }); }",
        "function rowHtml(r) { return `<td>${r.title}</td>`; }",
        "export function viaHelper(el, rows) { setSafeHtml(el, rows.map(rowHtml).join('')); }",
        "// setSafeHtml(el, `<b>${user.comment}</b>`) — a comment quoting the bad shape",
        "export function numbers(el, n, rows) { setSafeHtml(el, `<i>${Number(n)}</i><i>${rows.length}</i>`); }",
        // a helper whose only DIRECT caller escapes, but which is also handed on
        // as a value: those callers cannot be followed, so the value use is found
        "function cellOf(v) { return `<td>${v}</td>`; }",
        "export function direct(el) { setSafeHtml(el, cellOf(esc('x'))); }",
        "export function asValue(xs) { return xs.map(cellOf); }",
        // a bracketed property write is the same sink as the dotted one
        "export function bracket(el, u) { el['innerHTML'] = u.bio; }",
        // a class name or string holding the helper's name is not a use of it
        "export function named(el) { setSafeHtml(el, `<i class=\"cellOf\">${esc('y')}</i>`); }",
        "",
      ].join("\n"));
      // A value followed through more than 40 steps is a finding, never a pass.
      const chain = ["  let a0 = u.deep;"];
      for (let k = 1; k <= 45; k++) chain.push(`  let a${k} = a${k - 1};`);
      fs.writeFileSync(path.join(tmp, "public/js/ui/planted-deep.js"), [
        'import { setSafeHtml } from "../core/trusted-types.js";',
        "export function deep(el, u) {", ...chain, "  setSafeHtml(el, a45);", "}", "",
      ].join("\n"));
      const r = scan(tmp);
      const deep = r.findings.filter(f => f.file === "public/js/ui/planted-deep.js");
      expect(deep.map(f => f.why), "a value followed too deep is reported, not passed").toContain("expression nested too deep to follow");
      const got = r.findings.filter(f => f.file === "public/js/ui/planted.js").map(f => f.expr);
      expect(got, "the unescaped setSafeHtml value is found").toContain("user.name");
      expect(got, "the unescaped showModal message value is found").toContain("role.label");
      expect(got, "a value reached through a helper is found").toContain("r.title");
      expect(got, "a comment is never scanned").not.toContain("user.comment");
      expect(got, "a helper also used as a value is reported").toContain("cellOf");
      expect(got, "a bracketed innerHTML write is judged").toContain("u.bio");
      expect(got.length, `exactly the five planted defects, no more: ${JSON.stringify(got)}`).toBe(5);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // README (Trusted Types): app code writes HTML only through setSafeHtml, the
  // `app-html` policy's one door. A raw `.innerHTML =` reaches the DOM through
  // the vendor-compatibility `default` policy instead, a bypass the escape scan
  // above cannot see (it judges the VALUE, not the door). Only the doors'
  // own definitions (core/trusted-types.js) write the properties. The scan
  // covers the module graph (public/js); the classic scripts outside it
  // (help.js, help-renderer.js, theme-boot.js) cannot import setSafeHtml.
  test("no module under public/js writes innerHTML, outerHTML or insertAdjacentHTML outside core/trusted-types.js", () => {
    // (nor any other HTML-parsing call: document.write, setHTMLUnsafe,
    // createContextualFragment, parseHTMLUnsafe)
    const { stripComments } = require("./html-sink-scan");
    const RAW = /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\[\s*['"](?:innerHTML|outerHTML)['"]\s*\]\s*\+?=(?!=)|\b(?:insertAdjacentHTML|document\.write(?:ln)?|setHTMLUnsafe|createContextualFragment|parseHTMLUnsafe)\s*\(/g;
    const rawWrites = (src) => [...stripComments(src).matchAll(RAW)].map(m => src.slice(0, m.index).split("\n").length);
    // Controls: the matcher finds each raw write, and passes a read, a compare,
    // a setSafeHtml call and a comment quoting the forbidden shape.
    expect(rawWrites("a.innerHTML = x;\nb.outerHTML+=y;\nc.insertAdjacentHTML('beforeend', z);\nd['innerHTML'] = x;\ndocument.write(y);").length).toBe(5);
    expect(rawWrites("const h = a.innerHTML;\nif (a.innerHTML === b) f();\nconst g = a['innerHTML'];\nsetSafeHtml(a, x);\n// a.innerHTML = x\n/* b.outerHTML = y */")).toEqual([]);
    const files = [];
    (function walkJs(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkJs(p); else if (e.name.endsWith(".js")) files.push(p);
      }
    })(path.join(ROOT, "public", "js"));
    const hits = [];
    let doors = 0, setSafeCalls = 0;
    for (const f of files) {
      const rel = path.relative(ROOT, f).split(path.sep).join("/");
      const src = fs.readFileSync(f, "utf8");
      const lines = rawWrites(src);
      if (rel === "public/js/core/trusted-types.js") { doors = lines.length; continue; }
      setSafeCalls += (stripComments(src).match(/\bsetSafeHtml\s*\(/g) || []).length;
      for (const ln of lines) hits.push(`${rel}:${ln}`);
    }
    expect(doors, "anti-vacuity: the door itself (setSafeHtml) is found writing innerHTML").toBeGreaterThan(0);
    expect(setSafeCalls, "anti-vacuity: the app's HTML writes go through setSafeHtml").toBeGreaterThan(300);
    expect(hits, "raw HTML writes outside core/trusted-types.js: use setSafeHtml(el, html)").toEqual([]);
  });
});

const PAYLOAD = "<img src=x onerror=window.__xss=1>";

// The guide renderer the ALLOW entry above trusts (public/help-renderer.js,
// with the vendored marked), run as the help drawer runs it. marked flags text
// after a raw-block tag (<pre>, <code>, <kbd>, <script>) as already escaped and
// its own text renderer writes it raw, so the renderer escapes text itself.
test.describe("HTML sinks — the guide renderer", () => {
  function renderGuide(md) {
    const vm = require("vm");
    const ctx = { console, URL, location: { origin: "http://localhost" } };
    ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public/vendor/marked.min.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public/help-renderer.js"), "utf8"), ctx);
    return ctx.HelpRenderer.render(md, "/docs/user-guide/participant.md", { linkMode: "drawer" });
  }
  test("a tag after an inline <code>, <kbd> or <pre> is text, never markup; ordinary markdown still renders", () => {
    for (const md of [
      "<code>a <img/src=x/onerror=alert(1)> b</code>",
      "x <kbd>y <svg/onload=alert(1)> z</kbd>",
      "<pre>p <img/src=x/onerror=alert(1)> q</pre>",
      "plain <img src=x onerror=alert(1)> text",
    ]) {
      const out = renderGuide(md);
      expect(out, `${md} → ${out}`).not.toMatch(/<(img|svg|code|kbd|pre)\b/i);
      expect(out, `the tag is shown as text: ${out}`).toMatch(/&lt;(img|svg)/);
    }
    // CONTROL: the renderer still renders markdown, and keeps an entity whole.
    expect(renderGuide("**bold**, `code` & &amp; done")).toBe("<p><strong>bold</strong>, <code>code</code> &amp; &amp; done</p>\n");
    expect(renderGuide("[Admin](admin.md#alerts)")).toContain('data-help-nav="/docs/user-guide/admin.md" data-help-frag="alerts"');
  });
});

test.describe("HTML sinks — the dialogs that show stored names", () => {
  test.use({ baseURL: BASE });
  let sa, roleId, roleLabel, existing, comp, task, groupId, groupName;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    sa = await apiLogin("superadmin");
    roleLabel = `${PAYLOAD} ${Date.now() % 100000}`;
    const rr = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: roleLabel, scope_mode: "granted", permissions: [] } });
    expect(rr.ok(), `create role: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    roleId = (await rr.json()).role.id;
    existing = await makeParticipant(sa.api, sa.csrf, "sinkx");
    // The helpers report their own generated names; the extra overrides them, so
    // keep the names written here.
    const compName = `${PAYLOAD} event ${Date.now() % 100000}`;
    comp = { ...(await makeCompetition(sa.api, sa.csrf, "sinkx", { name: compName })), name: compName };
    const taskTitle = `${PAYLOAD} challenge ${Date.now() % 100000}`;
    task = { ...(await makeTask(sa.api, sa.csrf, "sinkx", { title: taskTitle })), title: taskTitle };
    await assignTask(sa.api, sa.csrf, task.id, [comp.id]);
    groupName = `${PAYLOAD} group ${Date.now() % 100000}`;
    const gr = await sa.api.post("/api/admin/groups", { headers: H(sa.csrf), data: { name: groupName, userIds: [] } });
    expect(gr.ok(), `create group: ${gr.status()} ${await gr.text()}`).toBeTruthy();
    groupId = (await gr.json()).group.id;
  });
  test.afterAll(async () => { if (sa) await sa.api.dispose(); });

  /** The open confirm shows `text` literally, holds no <img>, and ran nothing. */
  async function expectInertModal(page, text, what) {
    const ov = page.locator("#modal-overlay.open");
    await expect(ov, `${what}: the confirm opened`).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#modal-body"), `${what}: the name is shown as text`).toContainText(text);
    expect(await page.locator("#modal-overlay img").count(), `${what}: no <img> element was created`).toBe(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).__xss), `${what}: no handler ran`).toBeUndefined();
    await page.locator("#modal-cancel-btn").click();
    await expect(ov).toHaveCount(0);
  }

  test("positive control: markup passed to showModal unescaped DOES render, so the <img> witness can fail", async ({ page }) => {
    await adminLogin(page);
    await page.evaluate((p) => { /** @type {any} */ (window).showModal({ title: "control", message: p }); }, PAYLOAD);
    await expect(page.locator("#modal-overlay.open")).toBeVisible();
    expect(await page.locator("#modal-overlay img").count(), "an unescaped message creates the element").toBe(1);
    await page.locator("#modal-cancel-btn").click();
  });

  test("Add user: the existing-account confirm shows a custom role label as text", async ({ page }) => {
    await adminLogin(page);
    await page.locator('button.admin-nav-item[data-tab-id="admin-users-tab"]').click();
    await expect(page.locator("#ua-body .ua-switch")).toBeVisible({ timeout: 15000 });
    await page.locator('[data-action="ua-add-user"]').click();
    const dlg = page.locator("#ua-add");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator(`#ua-add-role option[value="${roleId}"]`), "PRECONDITION: the custom role is offered").toHaveCount(1);
    await dlg.locator("#ua-add-email").fill(existing.email);
    await dlg.locator("#ua-add-role").selectOption(roleId);
    await dlg.locator('button[type="submit"]').click();
    await expectInertModal(page, roleLabel, "Add user confirm");
    expect(await page.locator("#ua-add img").count(), "nor in the dialog behind it").toBe(0);
  });

  test("event name: the Delete Event confirm and the live-challenge warning show it as text", async ({ page }) => {
    await adminLogin(page);
    await page.evaluate(async () => { await /** @type {any} */ (window).loadAdminCompetitions(); });
    await page.evaluate((id) => { /** @type {any} */ (window).deleteCompetition(id); }, comp.id);
    await expectInertModal(page, comp.name, "Delete Event");
    // The challenge sits in that LIVE event, so editing it names the event — the
    // sentence whose names are now escaped where they become HTML.
    await page.evaluate(async () => { await /** @type {any} */ (window).loadAdminTasks(); });
    await page.evaluate((id) => { /** @type {any} */ (window)._confirmLiveChallengeMutation(id, "Hide Challenge", "Participants stop seeing it."); }, task.id);
    await expectInertModal(page, comp.name, "live-challenge warning");
  });

  test("challenge title: the Delete Challenge confirm shows it as text", async ({ page }) => {
    await adminLogin(page);
    await page.evaluate(async () => { await /** @type {any} */ (window).loadAdminTasks(); });
    await page.evaluate((id) => { /** @type {any} */ (window).deleteTask(id); }, task.id);
    await expectInertModal(page, task.title, "Delete Challenge");
  });

  test("group name: the Delete Group confirm shows it as text", async ({ page }) => {
    await adminLogin(page);
    await page.evaluate(([id, name]) => { /** @type {any} */ (window).deleteGroup(id, name); }, [groupId, groupName]);
    await expectInertModal(page, groupName, "Delete Group");
  });

  test("invite results: addresses and errors the server sends back are shown as text", async ({ page }) => {
    await adminLogin(page);
    // What is under test is the dialog's rendering of the response, so the
    // response carries the payload (no real address can: `<` and `>` are refused).
    await page.route("**/api/admin/invitations", route => route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ok: true, invited: 0, assigned: 0, emailsSent: 0, resent: 0,
          existingEmails: ["kept@acme.com", PAYLOAD], alreadyInvited: [], alreadyAssigned: [],
          undeliveredInvites: [], unsubscribedInvites: [], errors: [`Invalid email: ${PAYLOAD}`],
        }) })
      : route.continue());
    await page.evaluate(() => { /** @type {any} */ (window).openInviteDialog(); });
    const overlay = page.locator("#invite-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await overlay.locator("#invite-emails").fill("kept@acme.com");
    await overlay.locator("#invite-submit-btn").click();
    const result = page.locator("#invite-result");
    await expect(result, "the result panel is shown").toBeVisible({ timeout: 15000 });
    await expect(result, "the returned text is shown literally").toContainText(PAYLOAD);
    expect(await overlay.locator("img").count(), "no <img> element was created").toBe(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).__xss)).toBeUndefined();
  });
});
