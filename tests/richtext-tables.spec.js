// @ts-check
//
// v7.18.0 — tables in the challenge rich-text fields (description, explanation,
// hint), including paste from Word and from web pages.
//
// THREE allowlists have to agree or "tables don't work" with no error anywhere:
//   • lib/sanitise.js _RICH_TEXT_OPTS  — the server, and the security boundary
//   • renderRich()                     — what a participant actually sees
//   • normalisePastedHtml()            — what survives a paste into the editor
// A tag the server stores but the renderer drops shows as flattened text; a tag
// the paste keeps but the server strips vanishes on save. Both are silent, so
// each layer is pinned here and the parity between them is pinned mechanically.
// The same holds per tag for STYLES: what a paste keeps on each tag
// (RICH_STYLE_RULES) is the server's own rule for it (the last describe below).
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE, waitForAdminPage } = require("./helpers");

test.use({ baseURL: BASE });

async function adminPage(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", {
    headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
    data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await waitForAdminPage(page, 30000);
  // Login regenerates the session, so the pre-login token is dead afterwards.
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

/** Round-trip `description` through a real save and read it back. */
async function storeDescription(page, csrf, description) {
  const r = await page.request.post("/api/admin/tasks", {
    headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    data: {
      title: `TblTest ${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`,
      description, correct_answer: "a", answer_type: "text", difficulty: "easy",
    },
  });
  expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).id;
  const list = await (await page.request.get("/api/admin/tasks")).json();
  const row = (list.tasks || list).find((t) => t.id === id);
  expect(row, "created task must come back from the admin list").toBeTruthy();
  return { id, stored: row.description, cleanup: () =>
    page.request.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": csrf } }) };
}

async function openTaskForm(page) {
  await page.locator("button[data-tab-id='admin-tasks-tab']").click();
  await page.locator("#new-task-btn, [data-action='open-task-form']").first().click();
  await page.locator("#tf-desc .rich-body").waitFor({ state: "visible", timeout: 15000 });
}

test.describe("Server sanitiser: tables (v7.18.0)", () => {
  test("a table survives a real save with its structure and header semantics", async ({ page }) => {
    const csrf = await adminPage(page);
    const html = '<p>Intro</p><table><caption>Cap</caption><thead><tr>'
      + '<th scope="col">Name</th><th scope="col">Value</th></tr></thead>'
      + '<tbody><tr><td>alpha</td><td style="text-align:center">1</td></tr>'
      + '<tr><td colspan="2" style="background-color:#eeeeee">merged</td></tr></tbody></table><p>Outro</p>';
    const { stored, cleanup } = await storeDescription(page, csrf, html);

    for (const tag of ["table", "thead", "tbody", "tr", "th", "td", "caption"]) {
      expect(stored, `<${tag}> must survive the sanitiser`).toContain(`<${tag}`);
    }
    expect(stored, "scope is what tells a screen reader the cell heads its column").toContain('scope="col"');
    expect(stored, "a legitimate colspan is kept").toContain('colspan="2"');
    expect(stored, "cell alignment is kept").toContain("text-align:center");
    expect(stored, "cell background is kept").toContain("background-color");
    expect(stored, "surrounding content is undisturbed").toContain("Intro");
    await cleanup();
  });

  test("colspan/rowspan are CLAMPED, not trusted", async ({ page }) => {
    // sanitize-html validates attribute NAMES and never their VALUES, so
    // without an explicit transform `colspan="100000"` reaches every
    // participant's browser as a layout bomb.
    const csrf = await adminPage(page);
    const html = '<table><tbody><tr><td colspan="100000" rowspan="99999">x</td>'
      + '<td colspan="-4">y</td><td colspan="abc">z</td></tr></tbody></table>';
    const { stored, cleanup } = await storeDescription(page, csrf, html);
    expect(stored).not.toContain("100000");
    expect(stored).not.toContain("99999");
    expect(stored, "clamped to the documented ceiling").toContain('colspan="64"');
    expect(stored, "clamped to the documented ceiling").toContain('rowspan="64"');
    expect(stored, "a negative span is dropped, not repaired").not.toContain('colspan="-4"');
    expect(stored, "a non-numeric span is dropped").not.toContain('colspan="abc"');
    await cleanup();
  });

  test("a table cannot smuggle script, handlers or hostile attributes", async ({ page }) => {
    const csrf = await adminPage(page);
    const html = '<table onclick="steal()" id="x" class="y"><tbody>'
      + '<tr onmouseover="evil()"><td onclick="alert(1)" style="background:url(https://evil.test/p.png)">a</td>'
      + '<td><script>alert(2)<\/script>b</td>'
      + '<td style="position:fixed;top:0;left:0;width:100%">c</td></tr></tbody></table>';
    const { stored, cleanup } = await storeDescription(page, csrf, html);
    expect(stored.toLowerCase()).not.toContain("onclick");
    expect(stored.toLowerCase()).not.toContain("onmouseover");
    expect(stored.toLowerCase()).not.toContain("<script");
    expect(stored.toLowerCase()).not.toContain("steal(");
    expect(stored, "no url() — a cell background must not be able to beacon out").not.toContain("evil.test");
    expect(stored, "position is not on the cell style allowlist, so an overlay cannot be built")
      .not.toContain("position:fixed");
    expect(stored, "no id/class hooks on table elements").not.toContain('id="x"');
    await cleanup();
  });

  test("Word's clipboard cruft does not reach the database", async ({ page }) => {
    const csrf = await adminPage(page);
    const html = '<table class="MsoNormalTable" border="1" cellspacing="0" width="600" '
      + 'style="mso-cellspacing:0;border-collapse:collapse"><tr style="mso-yfti-irow:0">'
      + '<td width="300" valign="top" style="width:225.0pt;mso-border-alt:solid windowtext .5pt;'
      + 'background:white;text-align:left"><p class="MsoNormal"><span style="mso-fareast-font-family:'
      + 'Calibri;color:windowtext">Cell</span><o:p></o:p></p></td></tr></table>';
    const { stored, cleanup } = await storeDescription(page, csrf, html);
    expect(stored, "the table itself survives — that is the point").toContain("<table");
    expect(stored, "the author's text survives").toContain("Cell");
    expect(stored.toLowerCase()).not.toContain("mso-");
    expect(stored.toLowerCase()).not.toContain("msonormaltable");
    expect(stored.toLowerCase()).not.toContain("<o:p");
    expect(stored, "a pt width sized for A4 would overflow a phone").not.toContain("225.0pt");
    expect(stored, "presentational attributes are not on the allowlist").not.toContain('border="1"');
    await cleanup();
  });
});

test.describe("Client render + paste normalisation (v7.18.0)", () => {
  test("renderRich keeps tables instead of flattening them to text", async ({ page }) => {
    await adminPage(page);
    const out = await page.evaluate(() => window.renderRich(
      '<table><thead><tr><th scope="col">H</th></tr></thead>'
      + '<tbody><tr><td colspan="2" style="text-align:right">v</td></tr></tbody></table>'));
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain('scope="col"');
    expect(out).toContain('colspan="2"');
    // The renderer is the SECOND line; a handler must still never survive it.
    const evil = await page.evaluate(() => window.renderRich('<table><tr><td onclick="x()">a</td></tr></table>'));
    expect(evil.toLowerCase()).not.toContain("onclick");
  });

  test("renderRich and stripHtml clean in an inert document: a stored picture is never fetched while it is being cleaned (a live-document image CONTROL is)", async ({ page }) => {
    await adminPage(page);
    const hits = [];
    await page.route(/\/api\/images\/beacon-[a-z]+$/, (route) => {
      hits.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 404, body: "" });
    });
    const out = await page.evaluate(() => {
      // Sources the cleaning keeps (a stored picture's own path), so only WHERE
      // it is parsed decides whether the browser fetches it.
      const rendered = window.renderRich('<p>x</p><img src="/api/images/beacon-render">');
      const stripped = window.stripHtml('<p>y</p><img src="/api/images/beacon-strip">');
      // CONTROL: an image of the LIVE document is fetched at once, attached or not.
      const live = new Image();
      live.src = "/api/images/beacon-live";
      return { rendered, stripped };
    });
    expect(out.rendered, "the picture itself survives the cleaning").toContain('src="/api/images/beacon-render"');
    expect(out.stripped).toBe("y");
    await expect.poll(() => hits, { message: "CONTROL: the live-document image was requested" }).toContain("/api/images/beacon-live");
    expect(hits, "nothing the cleaning parsed was fetched").not.toContain("/api/images/beacon-render");
    expect(hits).not.toContain("/api/images/beacon-strip");
  });

  test("normalisePastedHtml keeps a Word table and drops everything Word wraps it in", async ({ page }) => {
    await adminPage(page);
    const word = `<!--[if gte mso 9]><xml><w:WordDocument/></xml><![endif]-->
      <meta name=Generator content="Microsoft Word 15">
      <style>.MsoNormal{margin:0}</style>
      <table class=MsoNormalTable border=1 width=600 style='mso-cellspacing:0'>
      <tr style='mso-yfti-irow:0'><td width=300 style='width:225.0pt;background:white;text-align:center'>
      <p class=MsoNormal><span style='color:windowtext;mso-fareast-font-family:Calibri'>Alpha</span><o:p></o:p></p>
      </td><td><b>Beta</b></td></tr></table>`;
    const out = await page.evaluate((h) => window.normalisePastedHtml(h), word);

    expect(out, "the table is the whole point of the paste").toContain("<table");
    expect(out).toContain("Alpha");
    expect(out, "inline emphasis is preserved").toContain("<b>");
    expect(out, "conditional comments are stripped BEFORE parsing — they are comments to a parser").not.toContain("mso 9");
    expect(out.toLowerCase()).not.toContain("<style");
    expect(out.toLowerCase()).not.toContain("<meta");
    expect(out.toLowerCase()).not.toContain("<o:p");
    expect(out.toLowerCase()).not.toContain("mso-");
    expect(out.toLowerCase()).not.toContain("msonormaltable");
    expect(out, "color:windowtext means nothing outside Word and is invisible on the dark theme")
      .not.toContain("windowtext");
    expect(out, "an absolute A4 width is dropped; percentages survive").not.toContain("225.0pt");
    expect(out, "the alignment the author actually chose survives").toContain("text-align:center");
  });

  test("pasting from a web page keeps structure and drops scripts, handlers and local images", async ({ page }) => {
    await adminPage(page);
    const web = '<div><h2>Title</h2><script>evil()<\/script>'
      + '<table><tr><td><a href="https://example.com/x">link</a></td>'
      + '<td><a href="javascript:evil()">bad</a></td></tr></table>'
      + '<img src="file:///C:/Users/me/img.png"><img src="https://example.com/ok.png">'
      + '<p onclick="x()">para</p></div>';
    const out = await page.evaluate((h) => window.normalisePastedHtml(h), web);

    expect(out).toContain("<table");
    expect(out, "an unsupported wrapper is UNWRAPPED, never dropped — its text is the content")
      .toContain("Title");
    expect(out.toLowerCase()).not.toContain("<h2");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out).toContain('href="https://example.com/x"');
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out, "a file:// image resolves for nobody else and would ship broken").not.toContain("file:///");
    expect(out).toContain("https://example.com/ok.png");
  });

  test("a table pasted into the editor is what the server then stores", async ({ page }) => {
    // The end-to-end claim: normalise → editor → save → read back. Asserting
    // only the normaliser would leave the join between the two layers untested,
    // which is exactly where an allowlist disagreement hides.
    const csrf = await adminPage(page);
    const word = `<table class=MsoNormalTable border=1 style='mso-cellspacing:0'>`
      + `<tr><td style='width:225.0pt;text-align:center;background:white'>`
      + `<p class=MsoNormal><span style='color:windowtext'>Pasted</span><o:p></o:p></p></td></tr></table>`;
    const normalised = await page.evaluate((h) => window.normalisePastedHtml(h), word);
    const { stored, cleanup } = await storeDescription(page, csrf, normalised);
    expect(stored, "the table reaches the database").toContain("<table");
    expect(stored).toContain("Pasted");
    expect(stored).toContain("text-align:center");
    expect(stored.toLowerCase()).not.toContain("mso-");
    await cleanup();
  });
});

test.describe("Table authoring in the editor (v7.18.0)", () => {
  test("the toolbar inserts a table, and the menu grows row/column actions inside one", async ({ page }) => {
    await adminPage(page);
    await openTaskForm(page);
    const editor = page.locator("#tf-desc");
    const body = editor.locator(".rich-body");
    await body.click();

    // Insert via the toolbar → dialog.
    await editor.locator("button[aria-label='Table']").click();
    await expect(editor.locator(".drop-pop [role='menuitem']").first()).toHaveText("Insert table…");
    // Outside a table the menu offers ONLY insert — an item that would silently
    // do nothing is worse than an absent one.
    await expect(editor.locator(".drop-pop [role='menuitem']")).toHaveCount(1);
    await editor.locator(".drop-pop [role='menuitem']").first().click();

    const dlg = page.locator("#table-insert-overlay");
    await expect(dlg).toBeVisible();
    await dlg.locator("#tbl-rows").fill("3");
    await dlg.locator("#tbl-cols").fill("2");
    await dlg.locator("#tbl-ok").click();
    await expect(dlg).toHaveCount(0);

    await expect(body.locator("table")).toHaveCount(1);
    await expect(body.locator("th")).toHaveCount(2);      // header row on by default
    await expect(body.locator("tbody tr")).toHaveCount(2); // 3 rows total incl. header
    await expect(body.locator("th").first()).toHaveAttribute("scope", "col");

    // With the caret inside the table the menu grows the editing actions.
    await body.locator("tbody td").first().click();
    await editor.locator("button[aria-label='Table']").click();
    const items = editor.locator(".drop-pop [role='menuitem']");
    await expect(items).toHaveCount(8);
    for (const label of ["Insert row above", "Insert column right", "Delete row", "Delete table"]) {
      await expect(items.filter({ hasText: label })).toHaveCount(1);
    }

    // Insert a column → every row gains a cell.
    await items.filter({ hasText: "Insert column right" }).click();
    await expect(body.locator("tbody tr").first().locator("td")).toHaveCount(3);
    await expect(body.locator("th")).toHaveCount(3);

    // Insert a row below → one more body row.
    await body.locator("tbody td").first().click();
    await editor.locator("button[aria-label='Table']").click();
    await editor.locator(".drop-pop [role='menuitem']").filter({ hasText: "Insert row below" }).click();
    await expect(body.locator("tbody tr")).toHaveCount(3);

    // Delete row → back to 2.
    await body.locator("tbody td").first().click();
    await editor.locator("button[aria-label='Table']").click();
    await editor.locator(".drop-pop [role='menuitem']").filter({ hasText: "Delete row" }).first().click();
    await expect(body.locator("tbody tr")).toHaveCount(2);

    // Delete table → gone.
    await body.locator("tbody td").first().click();
    await editor.locator("button[aria-label='Table']").click();
    await editor.locator(".drop-pop [role='menuitem']").filter({ hasText: "Delete table" }).click();
    await expect(body.locator("table")).toHaveCount(0);
  });

  test("the Table menu is not clipped by the editor's overflow", async ({ page }) => {
    // Found by looking at the generated screenshot, not by a failing test.
    // `.rich-editor` sets `overflow:hidden` to clip the toolbar and body to its
    // 8px radius, which clipped an absolutely-positioned popover — the last two
    // items ("Delete column", "Delete table") were cut off at the editor's
    // bottom edge and unreachable. Latent since the popovers were written: the
    // font and size menus are short enough to fit, so only the 8-item Table
    // menu made it visible.
    await adminPage(page);
    await openTaskForm(page);
    const editor = page.locator("#tf-desc");
    const body = editor.locator(".rich-body");
    await body.click();
    // Get a table under the caret so the menu renders its full 8 items.
    await editor.locator("button[aria-label='Table']").click();
    await editor.locator(".drop-pop [role='menuitem']").first().click();
    await page.locator("#table-insert-overlay #tbl-ok").click();
    await body.locator("tbody td").first().click();
    await editor.locator("button[aria-label='Table']").click();

    const items = editor.locator(".drop-pop [role='menuitem']");
    await expect(items).toHaveCount(8);
    const last = items.nth(7);
    await expect(last).toHaveText("Delete table");

    // Every item must be inside the viewport AND actually clickable — a clipped
    // item is still "visible" to a DOM query, so assert geometry and hit-testing
    // rather than visibility.
    const vp = page.viewportSize();
    for (let i = 0; i < 8; i++) {
      const bb = await items.nth(i).boundingBox();
      expect(bb, `menu item #${i} has no box`).not.toBeNull();
      expect(bb.y, `menu item #${i} above the viewport`).toBeGreaterThanOrEqual(-1);
      expect(bb.y + bb.height, `menu item #${i} below the viewport (vh=${vp.height})`)
        .toBeLessThanOrEqual(vp.height + 1);
    }
    // The decisive pair. The editor still clips its own overflow (that is what
    // rounds its corners), and the menu is TALLER than the editor — so the only
    // reason the last item is reachable is that the popover is position:fixed
    // and therefore not clipped by an ancestor's overflow. Assert both, so
    // reverting either one fails.
    await expect(editor, "the editor still clips — the popover must escape it, not the other way round")
      .toHaveCSS("overflow", "hidden");
    await expect(editor.locator(".drop-pop"),
      "an absolutely-positioned popover is clipped by .rich-editor{overflow:hidden}"
    ).toHaveCSS("position", "fixed");

    // And it is genuinely operable, not merely on-screen: clicking the last
    // item must do what it says. A clipped element still answers a DOM query.
    await last.click();
    await expect(body.locator("table")).toHaveCount(0);
  });

  test("a table authored in the editor is saved and comes back on re-open", async ({ page }) => {
    const csrf = await adminPage(page);
    await openTaskForm(page);
    const editor = page.locator("#tf-desc");
    const body = editor.locator(".rich-body");
    await body.click();
    await editor.locator("button[aria-label='Table']").click();
    await editor.locator(".drop-pop [role='menuitem']").first().click();
    await page.locator("#table-insert-overlay #tbl-rows").fill("2");
    await page.locator("#table-insert-overlay #tbl-cols").fill("2");
    await page.locator("#table-insert-overlay #tbl-ok").click();

    // Type into the first header cell so the round-trip carries real content.
    await body.locator("th").first().click();
    await page.keyboard.type("Metric");
    await body.locator("tbody td").first().click();
    await page.keyboard.type("42");

    const title = `TblAuthored ${Date.now()}`;
    await page.locator("#tf-title").fill(title);
    await page.locator("#tf-answer").fill("a");
    await page.locator("[data-action='save-task']").first().click();

    await expect.poll(async () => {
      const list = await (await page.request.get("/api/admin/tasks")).json();
      const row = (list.tasks || list).find((t) => t.title === title);
      return row ? row.description : null;
    }, { timeout: 15000 }).toContain("<table");

    const list = await (await page.request.get("/api/admin/tasks")).json();
    const row = (list.tasks || list).find((t) => t.title === title);
    expect(row.description, "the header cell text round-trips").toContain("Metric");
    expect(row.description, "the body cell text round-trips").toContain("42");
    expect(row.description).toContain("<th");
    await page.request.delete(`/api/admin/tasks/${row.id}`, { headers: { "x-csrf-token": csrf } });
  });

  test("pasting a Word table into the editor inserts a real table, not markup soup", async ({ page }) => {
    await adminPage(page);
    await openTaskForm(page);
    const body = page.locator("#tf-desc .rich-body");
    await body.click();

    // Drive a genuine paste event carrying a text/html flavour, which is what
    // Word actually puts on the clipboard.
    await page.evaluate(() => {
      const el = document.querySelector("#tf-desc .rich-body");
      el.focus();
      const dt = new DataTransfer();
      dt.setData("text/html", `<table class=MsoNormalTable border=1 style='mso-cellspacing:0'>`
        + `<tr><td style='width:225.0pt;background:white'><p class=MsoNormal>`
        + `<span style='color:windowtext'>Q1</span><o:p></o:p></p></td>`
        + `<td><span style='mso-fareast-font-family:Calibri'>100</span></td></tr></table>`);
      dt.setData("text/plain", "Q1\t100");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    await expect(body.locator("table")).toHaveCount(1);
    await expect(body.locator("td")).toHaveCount(2);
    await expect(body).toContainText("Q1");
    await expect(body).toContainText("100");
    const inner = await body.innerHTML();
    expect(inner.toLowerCase(), "no Word cruft is inserted into the editor").not.toContain("mso-");
    expect(inner.toLowerCase()).not.toContain("<o:p");
    expect(inner.toLowerCase()).not.toContain("windowtext");
  });

  test("pasting plain text with no HTML flavour still inserts the text", async ({ page }) => {
    // The fall-through branch: a paste from a terminal or a code editor carries
    // only text/plain, and must not be swallowed by the new handler.
    await adminPage(page);
    await openTaskForm(page);
    const body = page.locator("#tf-desc .rich-body");
    await body.click();
    await page.evaluate(() => {
      const el = document.querySelector("#tf-desc .rich-body");
      el.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", "just some plain text");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(body).toContainText("just some plain text");
  });
});

// ── What a paste keeps on each tag ──────────────────────────────────────────
// The paste normaliser kept the same ten style properties on every tag it gave a
// style (p, div and li included), while the server keeps a rule per tag and none on
// p, div or li: a pasted centred paragraph, a coloured list item or a bold table cell
// looked right in the editor and changed when saved. And Google Docs wraps every copy
// in <b style="font-weight:normal">: each run said font-weight:400, so the paste LOOKED
// normal, and the save, which keeps the <b> and drops both weights, STORED it bold.
// The paste now keeps exactly the server's rule per tag (RICH_STYLE_RULES, mirrored
// below), and a span's bold, italics, underline and strikethrough become b, i, u, s.

/**
 * In the page: each HTML string as [tag, canonical style] per element, in document
 * order, and as canonical HTML (attributes sorted). A canonical style is split as the
 * server reads one (a `;` inside quotes is no separator), each declaration
 * `prop:value`, sorted: two serialisations of one style compare equal.
 */
const canonIn = (page, htmls) => page.evaluate((htmls) => {
  const canonStyle = (s) => String(s || "").split(/;(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map((d) => d.trim()).filter(Boolean)
    .map((d) => { const i = d.indexOf(":"); return i < 0 ? d : `${d.slice(0, i).trim()}:${d.slice(i + 1).trim()}`; }).sort().join(";");
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ser = (n) => {
    if (n.nodeType === 3) return esc(n.data);
    if (n.nodeType !== 1) return "";
    const attrs = [...n.attributes].map((a) => [a.name, a.name === "style" ? canonStyle(a.value) : a.value]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return `<${n.localName}${attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("")}>${[...n.childNodes].map(ser).join("")}</${n.localName}>`;
  };
  return htmls.map((h) => {
    const d = document.implementation.createHTMLDocument("canon");
    d.body.innerHTML = h;
    return { html: [...d.body.childNodes].map(ser).join(""), proj: [...d.body.querySelectorAll("*")].map((e) => [e.localName, canonStyle(e.getAttribute("style"))]) };
  });
}, htmls);

test.describe("A paste keeps on each tag what the save keeps", () => {
  test("the paste keeps exactly the server's style rule on every tag (mirror lock)", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!window.RICH_STYLE_RULES && Array.isArray(window.RICH_SECTION_STYLES), null, { timeout: 20000 });
    // Each rule as {tag: {property: [[source, flags], …]}}, compared by value.
    const client = await page.evaluate(() => ({
      rules: Object.fromEntries(Object.entries(window.RICH_STYLE_RULES).map(([t, props]) =>
        [t, Object.fromEntries(Object.entries(props).map(([p, res]) => [p, res.map((re) => [re.source, re.flags])]))])),
      sections: [...window.RICH_SECTION_STYLES],
    }));
    const { _RICH_TEXT_OPTS: O } = require("../lib/sanitise");
    const ser = (rules) => Object.fromEntries(Object.entries(rules).map(([t, props]) =>
      [t, Object.fromEntries(Object.entries(props).map(([p, res]) => [p, res.map((re) => [re.source, re.flags])]))]));
    // Server rules a paste does not mirror, each for a reason; checked both ways.
    const EXEMPT = {
      img: "the server rewrites every image style to max-width:100% itself, and a paste keeps no image style",
      "*": "the empty fallback rule, holding nothing",
    };
    for (const k of Object.keys(EXEMPT)) {
      expect(Object.prototype.hasOwnProperty.call(O.allowedStyles, k), `the exempt rule ${k} exists on the server`).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(client.rules, k), `the exempt rule ${k} is absent on the client`).toBe(false);
    }
    const server = ser(Object.fromEntries(Object.entries(O.allowedStyles).filter(([t]) => !(t in EXEMPT))));
    const tags = Object.keys(server), pairs = tags.reduce((n, t) => n + Object.keys(server[t]).length, 0);
    expect(tags.length, "anti-vacuity: the server's styled tags were read").toBeGreaterThanOrEqual(9);
    expect(pairs, "anti-vacuity: every (tag, property) pair was read").toBeGreaterThanOrEqual(25);
    expect(client.rules, "the paste keeps per tag exactly the properties and value patterns the save keeps").toEqual(server);
    // The section rule the renderer reads is the same rule, not a third copy.
    for (const t of ["thead", "tbody", "tfoot"]) {
      expect(Object.keys(client.rules[t]).sort(), `${t}: RICH_SECTION_STYLES is its rule's properties`).toEqual([...client.sections].sort());
    }
    // CONTROL: the comparison sees a one-pattern difference (caption widened to justify).
    const planted = JSON.parse(JSON.stringify(server));
    planted.caption["text-align"] = [["^(left|right|center|justify)$", "i"]];
    expect(planted, "CONTROL: a widened caption rule compares unequal").not.toEqual(client.rules);
  });

  test("per tag and per property, a paste keeps the declaration exactly when the save does", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.normalisePastedHtml === "function", null, { timeout: 20000 });
    const sanitizeHtml = require("sanitize-html");
    const { _RICH_TEXT_OPTS } = require("../lib/sanitise");
    const { looks } = require("../scripts/theme/looks");
    // Each tag in a context the HTML parser keeps as written (an explicit tbody).
    const CTX = {
      span: (st) => `<span style="${st}">x</span>`, p: (st) => `<p style="${st}">x</p>`, div: (st) => `<div style="${st}">x</div>`,
      li: (st) => `<ul><li style="${st}">x</li></ul>`, ol: (st) => `<ol style="${st}"><li>x</li></ol>`, ul: (st) => `<ul style="${st}"><li>x</li></ul>`,
      table: (st) => `<table style="${st}"><tbody><tr><td>x</td></tr></tbody></table>`,
      thead: (st) => `<table><thead style="${st}"><tr><th>x</th></tr></thead></table>`,
      tbody: (st) => `<table><tbody style="${st}"><tr><td>x</td></tr></tbody></table>`,
      tfoot: (st) => `<table><tfoot style="${st}"><tr><td>x</td></tr></tfoot></table>`,
      tr: (st) => `<table><tbody><tr style="${st}"><td>x</td></tr></tbody></table>`,
      td: (st) => `<table><tbody><tr><td style="${st}">x</td></tr></tbody></table>`,
      th: (st) => `<table><tbody><tr><th style="${st}">x</th></tr></tbody></table>`,
      caption: (st) => `<table><caption style="${st}">c</caption><tbody><tr><td>x</td></tr></tbody></table>`,
      b: (st) => `<b style="${st}">x</b>`, i: (st) => `<i style="${st}">x</i>`, a: (st) => `<a href="https://x.example/" style="${st}">x</a>`,
      code: (st) => `<code style="${st}">x</code>`, pre: (st) => `<pre style="${st}">x</pre>`,
    };
    const DECLS = [
      ...["#123456", "var(--rt-red)", "var(--rt-hl-red)", "var(--bg)", "hsl(0 0% 0% / 0.5)", "rgba(1, 2, 3, 0.5)"].map((v) => `color:${v}`),
      ...["#abcdef", "var(--rt-hl-yellow)", "var(--rt-yellow)"].map((v) => `background-color:${v}`),
      ...["Arial", "Arial, sans-serif", '"Calibri",sans-serif'].map((v) => `font-family:${v}`),
      ...["12px", "1.2em", "11pt"].map((v) => `font-size:${v}`),
      ...["left", "center", "justify"].map((v) => `text-align:${v}`),
      ...["top", "baseline", "super"].map((v) => `vertical-align:${v}`),
      ...["50%", "300pt"].map((v) => `width:${v}`),
      "position:fixed", "background:white", "margin:0",
      // The server matches a property name exactly, case and all.
      "COLOR:#123456", "Text-Align:center",
      // A comment is no part of a declaration; a `;` inside quotes separates nothing.
      "color:#123456;/* c */font-size:12px", 'font-family:"a;b";color:#123456',
    ];
    // Converted to b, i, u and s on a span (held by the round-trip test below); on every
    // other tag both sides drop them.
    const EMPHASIS = ["font-weight:700", "font-weight:bold", "font-style:italic", "text-decoration:underline"];
    // Left out by reason: Word's junk values (windowtext, auto, inherit, initial,
    // transparent) and `!important`, which the paste drops while the server keeps
    // them, stricter by design and harmless to the round trip.
    const LITERALS = ["#123456", "#abcdef"];
    for (const [id, look] of Object.entries(looks)) for (const mode of ["light", "dark"]) {
      for (const v of [...Object.values(look[mode].rtInk), ...Object.values(look[mode].rtHighlight)]) {
        expect(LITERALS, `PRECONDITION: no case colour is ${id}/${mode}'s own ink or tint, which a paste turns into its name`).not.toContain(String(v).toLowerCase());
      }
    }
    const cases = [];
    for (const [tag, wrap] of Object.entries(CTX)) {
      for (const d of [...DECLS, ...(tag === "span" ? [] : EMPHASIS)]) cases.push({ tag, decl: d, html: wrap(d.replace(/"/g, "&quot;")) });
    }
    const server = cases.map((c) => sanitizeHtml(c.html, _RICH_TEXT_OPTS));
    const client = await page.evaluate((hs) => hs.map((h) => window.normalisePastedHtml(h)), cases.map((c) => c.html));
    const [sp, cp] = [await canonIn(page, server), await canonIn(page, client)];
    // A literal colour the save keeps, a paste turns into the nearest name or drops
    // (tests/richtext-colours.spec.js holds the mapping): what the save keeps of each
    // case's literal, as the paste writes it, by value.
    const AS_PASTED = { "color:#123456": "color:var(--rt-blue)", "background-color:#abcdef": "background-color:var(--rt-hl-blue)", "color:rgba(1, 2, 3, 0.5)": null };
    const pasted = (st) => st.split(";").filter(Boolean).map((d) => (Object.hasOwn(AS_PASTED, d) ? AS_PASTED[d] : d)).filter(Boolean).sort().join(";");
    let mapped = 0;
    const bad = [];
    let kept = 0, dropped = 0;
    cases.forEach((c, i) => {
      const want = sp[i].proj.map(([t, st]) => { const p = pasted(st); if (p !== st) mapped++; return [t, p]; });
      const s = JSON.stringify(want), k = JSON.stringify(cp[i].proj);
      if (sp[i].proj.some(([, st]) => st)) kept++; else dropped++;
      if (s !== k) bad.push(`${c.tag} {${c.decl}}: save ${s} vs paste ${k}`);
    });
    expect(cases.length, "anti-vacuity: every tag x declaration was built").toBeGreaterThanOrEqual(200);
    expect(kept, "CONTROL: the save keeps the allowed declarations, so the cases can tell").toBeGreaterThanOrEqual(30);
    expect(dropped, "the cases include declarations the save drops").toBeGreaterThanOrEqual(100);
    expect(mapped, "anti-vacuity: the literal colours the save keeps were judged as the paste maps them").toBeGreaterThanOrEqual(15);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  // Raw clipboard HTML: a Word paragraph and run, a styled div and list item, Google
  // Docs' wrapper, values the save refuses, `!important`, a quoted `;`, and a table
  // carrying styles on every part.
  const FIXTURE = '<p style="text-align:center;color:#c00000;font-weight:bold;margin:0">Para <span style="color:#336699;font-weight:700;font-style:italic;text-decoration:underline line-through;font-size:18px;vertical-align:super;font-family:&quot;Calibri&quot;,sans-serif">run</span></p>'
    + '<div style="background-color:#ffff00;text-align:right">Div</div><ul><li style="color:#aa0000;text-align:center">Item</li></ul>'
    + '<b style="font-weight:normal" id="docs-internal-guid-x"><span style="font-weight:400;font-style:normal;text-decoration:none;color:var(--rt-red);background-color:var(--rt-hl-yellow)">GD</span></b>'
    + '<span style="color:hsl(0 100% 50% / 0.5);font-family:Arial, sans-serif">hsl</span><span style="color:#123456 !important">imp</span>'
    + '<span style="font-family:&quot;a;b&quot;;color:#123456">semi</span>'
    + '<table style="width:50%;background-color:#eeeeee;color:#aa0000;text-align:center;font-weight:bold"><caption style="text-align:justify;color:#aa0000">Cap</caption>'
    + '<thead style="background-color:#dddddd;text-align:right;color:#aa0000;font-weight:bold"><tr style="background-color:#cccccc;color:#aa0000;text-align:center"><th scope="col" style="text-align:center;color:blue;font-size:12px">H</th></tr></thead>'
    + '<tbody style="vertical-align:top;width:10%"><tr><td style="text-align:justify;vertical-align:baseline;background-color:#bbbbbb;color:#112233;width:30%;font-weight:bold;font-family:Arial;text-decoration:underline">D</td></tr></tbody></table>';
  // Every literal colour comes out as the nearest name, or none (a neutral at the
  // ends of the lightness scale; the mapping: tests/richtext-colours.spec.js).
  const EXPECTED = '<p>Para <span style="color:var(--rt-blue);font-size:18px"><b><i><u><s>run</s></u></i></b></span></p><div>Div</div><ul><li>Item</li></ul>'
    + '<span style="color:var(--rt-red);background-color:var(--rt-hl-yellow)">GD</span><span style="color:var(--rt-red);font-family:Arial, sans-serif">hsl</span>'
    + '<span style="color:var(--rt-blue)">imp</span><span style="color:var(--rt-blue)">semi</span>'
    + '<table style="width:50%"><caption>Cap</caption><thead style="background-color:var(--rt-hl-grey);text-align:right"><tr style="background-color:var(--rt-hl-grey)">'
    + '<th scope="col" style="text-align:center;color:var(--rt-blue)">H</th></tr></thead><tbody style="vertical-align:top"><tr>'
    + '<td style="text-align:justify;vertical-align:baseline;background-color:var(--rt-hl-grey);width:30%">D</td></tr></tbody></table>';
  const FIXTURE_LITERALS = ["#c00000", "#336699", "#ffff00", "#aa0000", "#123456", "#eeeeee", "#dddddd", "#cccccc", "#bbbbbb", "#112233"];

  test("a paste into the editor is exactly what Save stores, and keeps the author's bold, italics and underlining", async ({ page }) => {
    const csrf = await adminPage(page);
    await openTaskForm(page);
    const { looks } = require("../scripts/theme/looks");
    const { sanitiseRichText } = require("../lib/sanitise");
    for (const [id, look] of Object.entries(looks)) for (const mode of ["light", "dark"]) {
      for (const v of [...Object.values(look[mode].rtInk), ...Object.values(look[mode].rtHighlight)]) {
        expect(FIXTURE_LITERALS, `PRECONDITION: no fixture colour is ${id}/${mode}'s own ink or tint`).not.toContain(String(v).toLowerCase());
      }
    }
    // Chromium's insertHTML drops a declaration equal to where it lands, so no fixture
    // value may equal the editor's own colour, size or family.
    const ctx = await page.evaluate(() => {
      const c = getComputedStyle(document.querySelector("#tf-desc .rich-body"));
      const probe = document.createElement("span"); document.body.appendChild(probe);
      const rgb = (v) => { probe.style.color = v; const r = getComputedStyle(probe).color; probe.style.color = ""; return r; };
      const lits = ["#c00000", "#336699", "#ffff00", "#aa0000", "#123456", "#eeeeee", "#dddddd", "#cccccc", "#bbbbbb", "#112233", "blue"].map(rgb);
      probe.remove();
      return { color: c.color, size: c.fontSize, family: c.fontFamily, lits };
    });
    expect(ctx.lits, "PRECONDITION: no fixture colour is the editor's own text colour").not.toContain(ctx.color);
    expect(["18px", "12px"], "PRECONDITION: no fixture size is the editor's own").not.toContain(ctx.size);
    expect(ctx.family, "PRECONDITION: the fixture's family is not the editor's own").not.toMatch(/^Arial/);

    // The normaliser alone, by value.
    const norm = await page.evaluate((h) => window.normalisePastedHtml(h), FIXTURE);
    const [cn, ce] = await canonIn(page, [norm, EXPECTED]);
    expect(cn.html, "a paste keeps per tag what the save keeps; emphasis on a span becomes b, i, u, s; Google Docs' wrapper goes").toBe(ce.html);

    // A real paste into the editor, then a real save of what the editor holds.
    await page.evaluate(() => window.descEditor.setHtml(""));
    await page.evaluate((h) => {
      const el = document.querySelector("#tf-desc .rich-body");
      el.focus();
      const dt = new DataTransfer();
      dt.setData("text/html", h);
      dt.setData("text/plain", "Para run Div Item GD hsl imp semi Cap H D");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, FIXTURE);
    const editorHtml = await page.evaluate(() => window.descEditor.getHtml());
    expect(editorHtml, "PRECONDITION: the paste landed").toContain("GD");
    const { stored, cleanup } = await storeDescription(page, csrf, editorHtml);
    const [cs, cx] = await canonIn(page, [stored, editorHtml]);
    expect(cs.html, "what the editor shows after a paste is exactly what Save stores").toBe(cx.html);
    // Allowed styles survive the save, by value.
    for (const want of ['<td style="text-align:justify;vertical-align:baseline;background-color:var(--rt-hl-grey);width:30%">',
      '<table style="width:50%">', '<thead style="background-color:var(--rt-hl-grey);text-align:right">',
      '<tr style="background-color:var(--rt-hl-grey)">', '<span style="color:var(--rt-red);background-color:var(--rt-hl-yellow)">GD',
      '<span style="color:var(--rt-red);font-family:Arial, sans-serif">hsl', '<span style="color:var(--rt-blue);font-size:18px">']) {
      expect(stored, `stored: ${want}`).toContain(want);
    }
    const shape = await page.evaluate((h) => {
      const d = document.implementation.createHTMLDocument("s"); d.body.innerHTML = h;
      const text = (t) => [...d.body.querySelectorAll("*")].find((e) => e.childNodes.length === 1 && e.firstChild.nodeType === 3 && e.firstChild.data === t);
      const chain = (el) => { const out = []; for (let n = el; n && n !== d.body; n = n.parentElement) out.push(n.localName); return out; };
      return { styled: ["p", "div", "li", "caption"].map((t) => [t, d.body.querySelector(t)?.hasAttribute("style")]),
        run: chain(text("run")), gd: chain(text("GD")) };
    }, stored);
    expect(shape.styled, "the stored p, div, li and caption carry no style").toEqual([["p", false], ["div", false], ["li", false], ["caption", false]]);
    expect(shape.run, "the pasted run is bold, italic, underlined and struck through, as tags").toEqual(["s", "u", "i", "b", "span", "p"]);
    expect(shape.gd, "the Google Docs text has no b around it").toEqual(["span"]);

    // As drawn: in the editor, and as a participant reads the stored challenge; and,
    // the CONTROL, what the save stored from the same paste before (the server
    // sanitising the raw clipboard HTML) draws the Google Docs text bold.
    const raw = sanitiseRichText(FIXTURE);
    expect(FIXTURE, "CONTROL: the fixture carries a paragraph style").toContain('<p style="');
    expect(raw, "CONTROL: …which the save drops").toContain("<p>Para");
    const drawn = await page.evaluate(([stored, raw]) => {
      const read = (root) => {
        const find = (t) => [...root.querySelectorAll("*")].find((e) => e.childNodes.length === 1 && e.firstChild.nodeType === 3 && e.firstChild.data === t);
        const run = getComputedStyle(find("run")), gd = getComputedStyle(find("GD"));
        return { run: [Number(run.fontWeight), run.fontStyle], gd: Number(gd.fontWeight) };
      };
      const box = (h) => { const b = document.createElement("div"); b.className = "rich-body"; b.innerHTML = window.renderRich(h); document.body.appendChild(b); const r = read(b); b.remove(); return r; };
      return { editor: read(document.querySelector("#tf-desc .rich-body")), stored: box(stored), before: box(raw) };
    }, [stored, raw]);
    expect(drawn.before.gd, "CONTROL: stored as before, the Google Docs text draws bold").toBeGreaterThanOrEqual(600);
    for (const where of ["editor", "stored"]) {
      expect(drawn[where].run[0], `${where}: the pasted bold run is bold`).toBeGreaterThanOrEqual(600);
      expect(drawn[where].run[1], `${where}: …and italic`).toBe("italic");
      expect(drawn[where].gd, `${where}: the Google Docs text is not bold`).toBe(400);
    }
    await cleanup();
  });
});
