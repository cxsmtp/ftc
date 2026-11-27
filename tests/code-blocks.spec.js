// @ts-check
//
// v7.20.4 — code blocks: every offered language is really registered, and the
// admin's View-as-Participant preview renders them EXACTLY as the participant
// view does.
const { test, expect } = require("./isolated-test");
const { apiLogin, getSuperadminPass, BASE, PARTICIPANT_PASS, codeLogin, settleFiniteAnimations } = require("./helpers");
const { makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const { adminLogin, clickTab, narrowChallengesTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });
const GUH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

test.describe("Code-block language menu (v7.20.4)", () => {
  test("every language the menu offers is actually registered with hljs", async ({ page }) => {
    // The vendored highlight.js is the upstream "common" build. It does NOT
    // carry dockerfile or powershell, yet both were offered — so choosing
    // either silently did nothing: getLanguage() returned undefined and
    // highlightCodeElement fell through to auto-detect. A menu entry that
    // quietly does nothing is a wrong answer, not a missing feature.
    //
    // This is asserted at RUNTIME, against the real bundle, because a source
    // scan cannot tell: csharp is registered as "C#", cpp as "C++", xml under
    // "HTML, XML" — a regex over the blob reports those as missing and would
    // have to be taught every alias by hand.
    await page.goto("/");
    await page.waitForFunction(() => !!window.hljs, { timeout: 20000 });
    const { vals, missing } = await page.evaluate(() => {
      const v = (window.CODE_LANGUAGES || []).map((l) => l.val).filter(Boolean);
      return { vals: v, missing: v.filter((x) => !window.hljs.getLanguage(x)) };
    });
    expect(vals.length, "the menu must be populated for this to mean anything").toBeGreaterThan(10);
    expect(missing,
      "these appear in the code-block language menu but hljs has no grammar for them, so " +
      "picking one silently falls through to auto-detect. Either register a grammar in " +
      "public/vendor/highlight/extra-languages.js or remove the menu entry:\n  " + missing.join("\n  ")
    ).toEqual([]);
  });

  test("Dockerfile highlights as Dockerfile, not as whatever auto-detect guesses", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!window.hljs, { timeout: 20000 });
    const out = await page.evaluate(() =>
      window.hljs.highlight("FROM node:26-alpine\n# a comment\nRUN npm ci --omit=dev\nCMD [\"node\",\"server.js\"]\n",
        { language: "dockerfile" }).value);
    expect(out, "FROM is an instruction keyword").toContain("hljs-keyword");
    expect(out, "# starts a comment").toContain("hljs-comment");
    // The markup splits the source across spans, so compare the TEXT.
    const text = await page.evaluate((h) => { const d = document.createElement("div");
      d.innerHTML = h; return d.textContent; }, out);
    expect(text, "the source text survives highlighting").toContain("node:26-alpine");
  });

  test("PowerShell highlights too — it was the other dead menu entry", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!window.hljs, { timeout: 20000 });
    const out = await page.evaluate(() =>
      window.hljs.highlight("# comment\n$items = Get-ChildItem -Path 'C:\\tmp'\nif ($items) { Write-Host \"found\" }\n",
        { language: "powershell" }).value);
    expect(out).toContain("hljs-variable");
    expect(out).toContain("hljs-comment");
    expect(out).toContain("hljs-keyword");
  });
});

/** A phone width inside the narrow-screen code-block rule (max-width:760px). */
const PHONE = { width: 390, height: 844 };

/** A code block's frame and spacing: the <pre> box and the <code> line height. */
function codeFrame(code) {
  const pre = getComputedStyle(code.closest("pre"));
  const cs = getComputedStyle(code);
  return { padding: pre.padding, margin: pre.margin, border: `${pre.borderTopWidth} ${pre.borderTopStyle} ${pre.borderTopColor}`,
    radius: pre.borderTopLeftRadius, shadow: pre.boxShadow, fontSize: cs.fontSize, lineHeight: cs.lineHeight };
}

/** Ligature settings and the inline font of the code inside `root`. */
function inlineAndBlock(root) {
  const inline = [...root.querySelectorAll("code")].find((c) => !c.closest("pre"));
  const block = root.querySelector("pre code");
  return { inline: getComputedStyle(inline).fontVariantLigatures, block: getComputedStyle(block).fontVariantLigatures,
    pre: getComputedStyle(block.closest("pre")).fontVariantLigatures, inlineFont: getComputedStyle(inline).fontFamily,
    inlineBg: getComputedStyle(inline).backgroundColor };
}

test.describe("The admin preview renders code like the participant view (v7.20.4)", () => {
  test("a code block has the SAME background, frame and spacing in both views, on a desktop and a phone, and neither view ligates code", async ({ page }) => {
    // Reported: "the admin task view doesn't show the code blocks in the same
    // way as the participant's view (code appear on black background)".
    //
    // The code-block CSS was scoped to `.rich-body` and `#task-detail-card`.
    // The admin preview renders into `#task-preview-overlay`, which matched
    // NEITHER — so nothing overrode atom-one-dark's own
    // `.hljs{background:#282c34}` and code sat on a black slab there while
    // every other surface used the theme-aware --code-bg.
    // Light theme: where the preview's inline code needs the light-theme sibling
    // of the participant rule too (asserted below, with its background).
    await page.emulateMedia({ colorScheme: "light" });
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await page.request.post("/api/login", { headers: GUH(csrfToken),
      data: { email: "superadmin", password: getSuperadminPass() } });
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;

    const title = `CodeBlk ${Date.now()}`;
    const desc = '<p>Build it:</p><pre><code class="language-dockerfile">FROM node:26-alpine\nRUN npm ci</code></pre>'
      + '<p>Inline: <code>a =&gt; b == c -- d</code></p>';
    const r = await page.request.post("/api/admin/tasks", { headers: GUH(csrf), data: {
      title, difficulty: "easy", answer_type: "text", correct_answer: "x",
      status: "published", description: desc } });
    expect(r.ok(), `seed: ${r.status()} ${await r.text()}`).toBeTruthy();
    const taskId = (await r.json()).id;
    // v8.12.4 — its OWN live event and participant (the fixture checklist):
    // this used to attach the challenge to the seeded "Test Live" and read it as
    // the seeded alice, both shared with every other test in the file.
    const live = await makeCompetition(page.request, csrf, "codeblk");
    const asg = await page.request.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: GUH(csrf), data: { competitionIds: [live.id] } });
    expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
    const reader = await makeParticipant(page.request, csrf, "codeblk");
    await enrol(page.request, csrf, live.id, [reader.id]);

    // ── ADMIN preview ──
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("button[data-tab-id='admin-tasks-tab']").click();
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first()
      .locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay").waitFor({ state: "visible", timeout: 10000 });
    const adminStyle = await page.locator("#task-preview-overlay pre code").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      const pre = getComputedStyle(el.closest("pre"));
      return { code: cs.backgroundColor, pre: pre.backgroundColor, colour: cs.color };
    });
    const adminFrame = await page.locator("#task-preview-overlay pre code").first().evaluate(codeFrame);
    // And at a phone width, where the narrow-screen rule (max-width:760px)
    // redraws both views' code blocks: the preview must follow it too.
    const wide = page.viewportSize();
    await page.setViewportSize(PHONE);
    const adminFramePhone = await page.locator("#task-preview-overlay pre code").first().evaluate(codeFrame);
    await page.setViewportSize(wide);
    const adminLig = await page.locator("#task-preview-overlay").evaluate(inlineAndBlock);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "PRECONDITION: light theme").toBe("light");

    // ── PARTICIPANT view ──
    const { csrfToken: c0 } = await (await page.request.get("/api/csrf-token")).json();
    const li = await codeLogin(page.request, reader.email, GUH(c0));
    expect(li.ok(), `participant login: ${await li.text()}`).toBeTruthy();
    const ac = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: GUH(ac), data: { competitionId: live.id } });
    expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#main-nav").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#nav-challenges:not([aria-disabled=true])").click();
    await page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`).click();
    await page.locator("#task-detail-card pre code").first().waitFor({ state: "visible", timeout: 15000 });
    const partStyle = await page.locator("#task-detail-card pre code").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      const pre = getComputedStyle(el.closest("pre"));
      return { code: cs.backgroundColor, pre: pre.backgroundColor, colour: cs.color };
    });
    const partFrame = await page.locator("#task-detail-card pre code").first().evaluate(codeFrame);
    await page.setViewportSize(PHONE);
    const partFramePhone = await page.locator("#task-detail-card pre code").first().evaluate(codeFrame);
    await page.setViewportSize(wide);
    // The FRAME too, not only the colours: the participant's card draws its code
    // block with its own padding, margin, edge, shadow and line height, and the
    // preview drew the older ones, so an author's View as Participant showed a
    // different block from the one participants read.
    expect(await page.locator("#task-detail-card").evaluate((c) => c.classList.contains("qa-card")),
      "PRECONDITION: the participant sees the standard (qa-card) challenge view").toBe(true);
    expect(adminFrame, "the preview draws the code block's frame and spacing as the participant's view does").toEqual(partFrame);
    expect(partFramePhone, "PRECONDITION: at a phone width the narrow-screen rule redraws the participant's code block").not.toEqual(partFrame);
    expect(adminFramePhone, "on a phone too, the preview draws the code block as the participant's view does").toEqual(partFramePhone);
    const partLig = await page.locator("#task-detail-card").evaluate(inlineAndBlock);
    // v8.14.3 — code shows the characters typed: no font ligatures in either
    // view, inline or block; and the preview's inline code is in the
    // participant's code font (it fell back to the browser's generic one).
    expect(partLig, "participant view").toEqual({ inline: "none", block: "none", pre: "none", inlineFont: expect.stringContaining("JetBrains Mono"), inlineBg: expect.any(String) });
    expect(adminLig, "admin preview, the same").toEqual(partLig);

    expect(adminStyle, "the two views must render a code block identically").toEqual(partStyle);
    // And specifically NOT atom-one-dark's raw slab, which is what was reported.
    expect(adminStyle.code, "the <code> must be transparent so the themed <pre> shows through")
      .toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(adminStyle.pre, "the <pre> carries the theme-aware --code-bg, not #282c34")
      .not.toBe("rgb(40, 44, 52)");

    await page.request.post("/api/csrf-token");
    const { csrfToken: c1 } = await (await page.request.get("/api/csrf-token")).json();
    void c1;
  });
});

// v8.14.3 — CODE SHOWS THE CHARACTERS TYPED. JetBrains Mono, the code font,
// ligates by default: `=>`, `==`, `!=`, `--`, `---` and `://` were drawn as
// single glyphs (an arrow, a long equals, an em-dash-like rule) in the
// challenge editor's code and everywhere else the font is used.
test.describe("The code font never draws two characters as one (v8.14.3)", () => {
  test("in the challenge editor, code renders exactly as its characters one by one — and the font really would ligate them", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    const body = page.locator("#tf-desc .rich-body");
    await body.waitFor({ state: "visible", timeout: 10000 });
    expect(await page.evaluate(async () => { await document.fonts.load('16px "JetBrains Mono"'); return document.fonts.check('16px "JetBrains Mono"'); }),
      "PRECONDITION: the code font is loaded").toBe(true);
    // The same characters three ways, drawn in turn in ONE code element at one
    // position (so anti-aliasing cannot differ): as the editor's stylesheet
    // draws code; with ligatures turned off INLINE, independently of that rule
    // (the reference); and with them turned back on inline (the control: this
    // font does join them). A zero-width non-joiner is no reference — Chromium
    // skips it in this font's contextual ligature rules.
    const t = "a=>b==c!=d--e---f://g";
    // Let the form's own finite animations (the dialog's fade-in) run out: under
    // load a stalled frame gives two equal shots of a half-faded element, and the
    // three shots below then compare different colours, not different glyphs.
    await settleFiniteAnimations(page);
    await body.evaluate((b) => { const p = document.createElement("p"); const c = document.createElement("code"); c.id = "lig"; p.appendChild(c); b.replaceChildren(p); });
    // The admin page may still be laying out around the editor: a shot is taken
    // only once two in a row agree, and the three only count if the element
    // did not move between them (a sub-pixel shift alone changes the pixels).
    const box = () => page.locator("#lig").boundingBox().then((b) => JSON.stringify(b));
    const shot = async (text, lig) => {
      await page.evaluate(({ text, lig }) => { const c = document.getElementById("lig"); c.textContent = text; c.style.fontVariantLigatures = lig || ""; }, { text, lig });
      let prev = await page.locator("#lig").screenshot();
      for (let i = 0; i < 20; i++) {
        const next = await page.locator("#lig").screenshot();
        if (next.equals(prev)) return next;
        prev = next;
      }
      throw new Error("the code element never stopped changing");
    };
    expect(await page.evaluate(() => getComputedStyle(document.getElementById("lig")).fontFamily)).toContain("JetBrains Mono");
    let code, ref, on;
    for (let attempt = 0; ; attempt++) {
      const b0 = await box();
      code = await shot(t);
      ref = await shot(t, "none");
      on = await shot(t, "normal");
      if ((await box()) === b0) break;
      if (attempt >= 4) throw new Error("the editor kept moving under the code element");
    }
    expect(on.equals(ref), "CONTROL: with ligatures on, this font draws these differently from the characters one by one").toBe(false);
    expect(code.equals(ref), "the editor's code is drawn exactly as the characters one by one").toBe(true);
  });

  test("the editor keeps spellcheck and autocorrect off inside code, however the code arrives — and never stores the marks", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "challenges");
    await page.locator("[data-action='open-task-form']").first().click();
    const editor = page.locator("#tf-desc");
    const body = editor.locator(".rich-body");
    await body.waitFor({ state: "visible", timeout: 10000 });
    // Loaded (setHtml), made with the toolbar, and pasted (the paste handler
    // inserts its normalised HTML with insertHTML).
    await page.evaluate(() => window.descEditor.setHtml('<p>prose -- here</p><pre><code>run --rm "x"</code></pre><p id="tb">a => b</p>'));
    await page.evaluate(() => { const t = document.getElementById("tb").firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, t.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
    await editor.locator("button[aria-label='Inline Code']").click();
    // A real paste event, into an empty paragraph of its own, through the
    // editor's own handler (normalise, then insertHTML).
    await page.evaluate(() => {
      const b = document.querySelector("#tf-desc .rich-body"); const p = document.createElement("p"); p.id = "paste"; p.appendChild(document.createElement("br")); b.appendChild(p);
      b.focus(); const r = document.createRange(); r.setStart(p, 0); r.collapse(true); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const dt = new DataTransfer(); dt.setData("text/html", "<code>pasted -- 'q'</code>"); dt.setData("text/plain", "pasted -- 'q'");
      b.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => page.evaluate(() => document.querySelector("#tf-desc .rich-body #paste code")?.textContent || ""),
      { message: "PRECONDITION: the paste landed as code" }).toContain("pasted");
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll("#tf-desc .rich-body code, #tf-desc .rich-body pre")].map((n) =>
      [n.nodeName, n.getAttribute("spellcheck"), n.getAttribute("autocorrect"), n.getAttribute("autocapitalize")].join(" ")))).toEqual([
      "PRE false off off", "CODE false off off", "CODE false off off", "CODE false off off"]);
    const counts = await page.evaluate(() => ({ code: document.querySelectorAll("#tf-desc .rich-body code").length,
      proseMarked: [...document.querySelectorAll("#tf-desc .rich-body p")].filter((p) => p.hasAttribute("spellcheck")).length }));
    expect(counts, "every code element is marked, and prose is left to the editor's spellcheck").toEqual({ code: 3, proseMarked: 0 });
    const html = await page.evaluate(() => window.descEditor.getHtml());
    expect(html, "the saved HTML still holds the code").toContain("<code>");
    expect(html, "…and none of the marks").not.toMatch(/spellcheck|autocorrect|autocapitalize/);
  });

  test("source: every rule and inline style that uses the code font turns ligatures off", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = (css.match(/[^{}]+\{[^{}]*\}/g) || []).filter((r) => /var\(--font-mono/.test(r.slice(r.indexOf("{"))));
    expect(rules.length, "anti-vacuity: the code-font rules were found").toBeGreaterThanOrEqual(12);
    const badCss = rules.filter((r) => !/font-variant-ligatures:\s*none/.test(r)).map((r) => r.trim().slice(0, 80));
    expect(badCss, "a rule using --font-mono must set font-variant-ligatures:none").toEqual([]);
    // Every other first-party file that can carry a style: the other
    // stylesheets, the HTML shells, the SPA and classic scripts, and the
    // server-rendered pages.
    const REPO = path.join(__dirname, "..");
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "vendor") walk(p); } else if (/\.(css|html|js)$/.test(e.name)) files.push(p); } };
    walk(path.join(REPO, "public")); walk(path.join(REPO, "routes")); files.push(path.join(REPO, "server.js"));
    const sites = [], badJs = [];
    for (const f of files) {
      const raw = fs.readFileSync(f, "utf8");
      if (f.endsWith(".css")) {
        if (f.endsWith(path.join("public", "styles.css"))) continue;
        const other = raw.replace(/\/\*[\s\S]*?\*\//g, "");
        for (const r of (other.match(/[^{}]+\{[^{}]*\}/g) || []).filter((x) => /var\(--font-mono/.test(x.slice(x.indexOf("{"))))) {
          sites.push(path.relative(REPO, f));
          if (!/font-variant-ligatures:\s*none/.test(r)) badJs.push(path.relative(REPO, f));
        }
        continue;
      }
      const src = f.endsWith(".html") ? raw.replace(/<!--[\s\S]*?-->/g, "") : stripJsComments(raw);
      const re = /var\(--font-mono/g;
      let m;
      while ((m = re.exec(src))) {
        // The style string it sits in: from its opening quote to its closing one.
        const start = Math.max(src.lastIndexOf('"', m.index), src.lastIndexOf("'", m.index), src.lastIndexOf("`", m.index));
        const ends = ['"', "'", "`"].map((q) => src.indexOf(q, m.index)).filter((i) => i >= 0);
        const style = src.slice(start, Math.min(...ends));
        const site = path.relative(REPO, f);
        sites.push(site);
        if (!/font-variant-ligatures:\s*none/.test(style)) badJs.push(site);
      }
    }
    // ANTI-VACUITY: the walk still reaches the inline styles. One is left (the
    // Logs entry dialog's <pre>): the JSON answer field's inline style moved into
    // styles.css (.qa-ans-json), where the CSS arm above checks it, and the
    // floor follows the code rather than a style moved back inline.
    expect(sites.length, "anti-vacuity: the inline code-font styles were found").toBeGreaterThanOrEqual(1);
    expect(sites, "anti-vacuity: the Logs entry dialog's inline code font is among them").toContain(path.join("public", "js", "features", "settings-admin.js"));
    expect(rules.some((r) => /\.qa-ans-json\b/.test(r)), "anti-vacuity: the JSON answer field's code-font rule is among the CSS rules").toBe(true);
    expect(badJs, "a style using var(--font-mono) must set font-variant-ligatures:none").toEqual([]);
  });
});
