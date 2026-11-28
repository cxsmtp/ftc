// @ts-check
//
// v9.2.13 — RICH-TEXT COLOURS ARE NAMES, DRAWN IN EACH LOOK'S OWN SHADE.
//
// The challenge editor's Text colour and Highlight menus wrote twelve literal hex
// values, and no literal colour is readable on both a day and a night surface:
// #00e5a0 measured 1.6:1 on the light cards, #ffd166 1.4:1, white 1.0:1, and at
// night black fell to 1.2:1 and the violet to 3.1:1. A pick now stores a NAME as
// the custom property that draws it (`color:var(--rt-red)`,
// `background-color:var(--rt-hl-yellow)`), which every look x mode gives its own
// ink or tint, measured at AA (scripts/theme/looks.js rtInk and rtHighlight). An
// inline var(), because the browser's own editing re-serialises what it moves with
// its computed colour inlined and its attributes dropped (joining two lines, a
// paste at a line's end), while it keeps an inline var() as written. This file holds:
//   1. the server admits a listed name's own var() and no other var(), wherever a
//      colour is admitted, and keeps an older literal (by value);
//   2. the paste normaliser agrees, and turns this look's ink or tint (what a
//      copy inside the editor carries, as the browser copies computed colours)
//      back into its name, and any other literal (Word, a web page) into the
//      nearest name, or none, so a pasted run reads at AA in both modes;
//   3. every ink and tint clears AA in every look x mode x ambient colour,
//      measured from the data AND in a real page, and the generator's own
//      measurement reports a planted failure;
//   4. the menus store the name, never a hex: a pick over part of a coloured run
//      or an older literal splits it, "no colour" takes it off, the keyboard path
//      works, a colour picked at a bare caret colours what is typed next, and
//      Clear Formatting leaves no colour behind;
//   5. a named colour reaches the participant's challenge and View as
//      Participant in that look's own ink, beside an older literal drawn as stored;
//   6. a table section (thead, tbody, tfoot) keeps only a tint and its alignment, on
//      the server, in the renderer and on a paste, and every tag allowed a style has
//      a rule of its own (sanitize-html filters nothing on a tag without one);
//   7. a pick undoes as one step (Ctrl+Z, Cmd+Z, the browser's Undo) before the
//      browser's own history, which it leaves intact, and redoes (Ctrl+Shift+Z,
//      Cmd+Shift+Z, Ctrl+Y); a colour waiting at a caret goes to text an IME composes.
// The client/server/palette name mirror is held in tests/functional-core-b.api.spec.js
// (Docs hygiene), beside the table allowlist's; the section mirror is held here (6).
const { test, expect } = require("./isolated-test");
const { getSuperadminPass, BASE, waitForAdminPage, codeLogin, appearanceSettled } = require("./helpers");
const { makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const { narrowChallengesTable } = require("./ui-admin-helpers");
const { lookCombos } = require("./look-tokens");
const { looks } = require("../scripts/theme/looks");

test.use({ baseURL: BASE });
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

// The names, from the palette data (the mirror lock holds them equal to the
// client's and the server's lists).
const NAMES = Object.keys(looks.signature.light.rtInk);

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const cssRgb = (s) => String(s).match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
const toRgb = (c) => (String(c).trim().startsWith("#") ? hexRgb(String(c).trim()) : cssRgb(c));
const rgbText = (hex) => `rgb(${hexRgb(hex).join(", ")})`;
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const A = lum(toRgb(a)), B = lum(toRgb(b)); return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); };

async function superadminApi(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", { headers: H(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
}

/** Round-trip `description` through a real save; returns what the server stored. */
async function storeDescription(page, csrf, description) {
  const r = await page.request.post("/api/admin/tasks", { headers: H(csrf), data: {
    title: `RtColour ${Date.now()}-${Math.floor(performance.now() * 1000) % 100000}`,
    description, correct_answer: "a", answer_type: "text", difficulty: "easy" } });
  expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).id;
  const list = await (await page.request.get("/api/admin/tasks")).json();
  const row = (list.tasks || list).find((t) => t.id === id);
  expect(row, "the created task comes back from the admin list").toBeTruthy();
  return { id, stored: row.description };
}

// ── 1. The server ───────────────────────────────────────────────────────────
test.describe("The sanitiser admits a colour NAME's own var() and no other", () => {
  test("each listed name is stored for text and highlight, in spans and table cells; an unknown, mis-cased, wrong-kind or fallback var() and the page's own tokens are dropped; an older literal stays", async ({ page }) => {
    const csrf = await superadminApi(page);
    const named = NAMES.map((n) => `<span style="color:var(--rt-${n})">c-${n}</span><span style="background-color:var(--rt-hl-${n})">h-${n}</span>`).join("");
    const refused = '<span style="color:var(--rt-chartreuse)">x1</span><span style="color:var(--bg)">x2</span>'
      + '<span style="color:VAR(--RT-RED)">x3</span><span style="color:var(--rt-red, #000)">x4</span>'
      + '<span style="color:var(--rt-hl-red)">x5</span><span style="background-color:var(--rt-red)">x6</span>'
      + '<span style="color:rgb(var(--glow))">x6b</span>';
    const cells = '<table style="background-color:var(--rt-hl-blue)"><tbody><tr style="background-color:var(--accent)">'
      + '<td style="color:var(--rt-green)">x7</td><th style="color:var(--text)">x8</th></tr></tbody></table>';
    const legacy = '<span style="color:#ff4d6a;font-size:20px">x9</span><font color="#00e5a0">x10</font>';
    const { stored } = await storeDescription(page, csrf, `<p>${named}</p><p>${refused}</p>${cells}<p>${legacy}</p>`);
    expect(NAMES.length, "anti-vacuity: the palette names nine colours").toBe(9);
    expect(stored, "stored exactly: every listed name kept; every other var() dropped; older colours as stored").toBe(
      `<p>${named}</p>`
      + "<p><span>x1</span><span>x2</span><span>x3</span><span>x4</span><span>x5</span><span>x6</span><span>x6b</span></p>"
      + '<table style="background-color:var(--rt-hl-blue)"><tbody><tr><td style="color:var(--rt-green)">x7</td><th>x8</th></tr></tbody></table>'
      + '<p><span style="color:#ff4d6a;font-size:20px">x9</span><span style="color:#00e5a0">x10</span></p>');
  });
});

// ── 2. The paste normaliser ─────────────────────────────────────────────────
test.describe("A paste keeps a name, and turns this look's own ink back into one", () => {
  test("a listed name's var() is kept and any other dropped; this look's ink or tint becomes its name; another mode's ink and a foreign colour become the nearest name", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.normalisePastedHtml === "function", null, { timeout: 20000 });
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    const out = await page.evaluate(() => {
      const h = document.documentElement;
      h.setAttribute("data-look", "signature"); h.setAttribute("data-theme", "dark");
      return window.normalisePastedHtml(
        '<span style="color: var(--rt-red); font-weight: 700">a</span><span style="color: var(--rt-chartreuse)">b</span>'
        + '<span style="color: var(--bg)">c</span><span style="color: var(--rt-hl-red)">d</span><span style="color: rgb(var(--glow))">d2</span>'
        // a copy inside the editor, as the browser writes it: computed literals
        + '<span style="color: rgb(246, 145, 149)">e</span><span style="background-color: rgb(59, 49, 20)">f</span><span style="color:#EEC028">g</span>'
        // the day ink of red (not this mode's), and a foreign colour
        + '<span style="color: rgb(186, 21, 26)">h</span><span style="color:#ff0000">i</span>');
    });
    expect(looks.signature.dark.rtInk.red, "PRECONDITION: the night red ink is the copied literal").toBe("#f69195");
    expect(looks.signature.dark.rtHighlight.yellow).toBe("#3b3114");
    expect(looks.signature.dark.rtInk.yellow).toBe("#eec028");
    // (The save keeps no weight on a span, so a pasted bold span becomes <b>: tests/richtext-tables.spec.js.)
    expect(out).toBe('<span style="color:var(--rt-red)"><b>a</b></span><span>b</span><span>c</span><span>d</span><span>d2</span>'
      + '<span style="color:var(--rt-red)">e</span><span style="background-color:var(--rt-hl-yellow)">f</span><span style="color:var(--rt-yellow)">g</span>'
      + '<span style="color:var(--rt-red)">h</span><span style="color:var(--rt-red)">i</span>');
  });

  test("a colour pasted from Word or a web page is stored as the nearest name, or none (black, white, near-neutral): only names remain, and the text reads at AA by day and at night in the house look", async ({ page }) => {
    const csrf = await superadminApi(page);
    await page.goto("/");
    await page.waitForFunction(() => typeof window.normalisePastedHtml === "function" && typeof window.renderRich === "function", null, { timeout: 20000 });
    await appearanceSettled(page);
    // Word's clipboard (its conditional comment, class and mso- properties, single
    // quotes) and a web page's computed colours, side by side.
    const pasted = "<html xmlns:o='urn:schemas-microsoft-com:office:office'><body><!--StartFragment-->"
      + "<p class=MsoNormal><span style='color:#C00000;mso-themecolor:accent2'>w1</span> <span style='color:#FF0000'>w2</span> "
      + "<span style='color:#0070C0'>w3</span> <span style='color:#00B050'>w4</span> <span style='background-color:#FFFF00;mso-highlight:yellow'>w5</span> "
      + "<span style='color:#000000'>w6</span> <span style='color:windowtext'>w7</span> <span style='background-color:white'>w8</span> "
      + "<span style='color:#595959'>w9</span></p><!--EndFragment--></body></html>"
      + '<p><span style="color: rgb(112, 48, 160);">x1</span> <span style="color: hsl(330, 80%, 50%);">x2</span> '
      + '<span style="background-color: rgb(255, 242, 204);">x3</span> '
      + '<span style="color: rgb(255, 255, 255); background-color: rgb(34, 34, 34);">x4</span> '
      + '<span style="color: rgb(250, 250, 248);">x5</span> <span style="background-color: rgb(27, 23, 53);">x6</span> '
      + '<span style="color: #002060;">x7</span> <span style="color: var(--rt-green);">ctl</span></p>';
    const normalised = await page.evaluate((html) => {
      const h = document.documentElement, out = {};
      for (const theme of ["light", "dark"]) {
        h.setAttribute("data-look", "ambient"); h.setAttribute("data-theme", theme);
        out[theme] = window.normalisePastedHtml(html);
      }
      return out;
    }, pasted);
    expect(normalised.dark, "the same names by day and at night: a hue, not this mode's shade").toBe(normalised.light);
    const { stored } = await storeDescription(page, csrf, normalised.light);
    const spans = await page.evaluate((html) => {
      const d = document.implementation.createHTMLDocument("x"); d.body.innerHTML = html;
      return [...d.body.querySelectorAll("span")].map((s) => [s.textContent, s.getAttribute("style") || ""]);
    }, stored);
    expect(spans, "each pasted colour as stored, by value").toEqual([
      ["w1", "color:var(--rt-red)"], ["w2", "color:var(--rt-red)"], ["w3", "color:var(--rt-blue)"], ["w4", "color:var(--rt-green)"],
      ["w5", "background-color:var(--rt-hl-yellow)"], ["w6", ""], ["w7", ""], ["w8", ""], ["w9", "color:var(--rt-grey)"],
      ["x1", "color:var(--rt-violet)"], ["x2", "color:var(--rt-pink)"], ["x3", "background-color:var(--rt-hl-yellow)"],
      ["x4", ""], ["x5", ""], ["x6", ""], ["x7", "color:var(--rt-blue)"],
      ["ctl", "color:var(--rt-green)"],
    ]);
    expect(stored, "no literal colour is stored: only names, or none").not.toMatch(/(?:#[0-9a-f]{3,6}\b|rgb\(|hsl\(|windowtext|white)/i);
    // As the challenge draws it, on a card, in the house look by day and at night.
    for (const theme of ["light", "dark"]) {
      const got = await page.evaluate(([html, theme]) => {
        const h = document.documentElement;
        h.setAttribute("data-look", "ambient"); h.setAttribute("data-theme", theme); h.removeAttribute("data-ambient");
        const card = document.createElement("div");
        card.className = "card";
        card.style.background = "var(--surface)";
        const box = document.createElement("div");
        box.className = "rich-body";
        box.innerHTML = window.renderRich(html);
        card.appendChild(box); document.body.appendChild(card);
        const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(.*, 0\)$/.test(b) && b !== "transparent") return b; } return getComputedStyle(document.body).backgroundColor; };
        const r = [...box.querySelectorAll("span")].map((s) => [s.textContent, getComputedStyle(s).color, bgOf(s)]);
        card.remove();
        return r;
      }, [stored, theme]);
      expect(got.length, "anti-vacuity: every span was drawn").toBe(spans.length);
      const low = got.filter(([, fg, bg]) => ratio(fg, bg) < 4.5).map(([t, fg, bg]) => `${t}: ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
      expect(low, `${theme}: every pasted run reads at AA`).toEqual([]);
    }
    // CONTROL: the colours as pasted, drawn the same way at night, do not all read.
    const raw = await page.evaluate(() => {
      const h = document.documentElement; h.setAttribute("data-look", "ambient"); h.setAttribute("data-theme", "dark");
      const card = document.createElement("div"); card.style.background = "var(--surface)";
      const s = document.createElement("span"); s.style.color = "#C00000"; s.textContent = "w1";
      card.appendChild(s); document.body.appendChild(card);
      const out = [getComputedStyle(s).color, getComputedStyle(card).backgroundColor]; card.remove(); return out;
    });
    expect(ratio(raw[0], raw[1]), "CONTROL: Word's dark red, kept literal, is below AA at night").toBeLessThan(4.5);
  });

  // ONE HUE TABLE (ui/richtext.js RICH_COLOUR_HUES), never the look's own inks: the
  // inks differ by mode, and a table read from them stored #ffa500 (the keyword
  // `orange`) as yellow by day and orange at night. Each band below sat where the
  // two modes' inks disagreed; every look x mode's ink of a name, and a plain CSS
  // keyword of it, must come back as that name, in every look and mode. (A tint is
  // pale by day and near-black at night, so outside its own look x mode, where it
  // is an exact match, the neutral thresholds decide it, not a hue.)
  test("a pasted colour takes the same name by day and at night in every look: the keyword orange, one colour from each band where the modes' inks disagreed, and every look x mode's ink of each name", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.normalisePastedHtml === "function", null, { timeout: 20000 });
    await appearanceSettled(page);
    // [text, style, the name it must become]. OKLCH hues: 5° 37° 70° 121° 184° 238° 277° 322°.
    const want = [
      ["orange", "color:#ffa500", "color:var(--rt-orange)"],
      ["b5", "color:#d06a84", "color:var(--rt-pink)"], ["b37", "color:#d17054", "color:var(--rt-red)"],
      ["b70", "color:#c17f21", "color:var(--rt-orange)"], ["b121", "color:#849b35", "color:var(--rt-yellow)"],
      ["b184", "color:#1ca597", "color:var(--rt-cyan)"], ["b238", "color:#2999d4", "color:var(--rt-blue)"],
      ["b277", "color:#7c86dd", "color:var(--rt-blue)"], ["b322", "color:#b473be", "color:var(--rt-violet)"],
      ["kred", "color:red", "color:var(--rt-red)"], ["kyellow", "color:yellow", "color:var(--rt-yellow)"],
      ["kgreen", "color:green", "color:var(--rt-green)"], ["kcyan", "color:cyan", "color:var(--rt-cyan)"],
      ["kblue", "color:blue", "color:var(--rt-blue)"], ["kviolet", "color:blueviolet", "color:var(--rt-violet)"],
      ["kpink", "color:hotpink", "color:var(--rt-pink)"], ["kpurple", "color:purple", "color:var(--rt-violet)"],
      ["kmagenta", "color:magenta", "color:var(--rt-violet)"], ["kmvr", "color:mediumvioletred", "color:var(--rt-pink)"],
    ];
    for (const look of Object.keys(looks)) for (const mode of ["light", "dark"]) {
      for (const [name, hex] of Object.entries(looks[look][mode].rtInk)) if (name !== "grey") want.push([`i-${look}-${mode}-${name}`, `color:${hex}`, `color:var(--rt-${name})`]);
    }
    expect(want.filter((w) => w[0].startsWith("i-")).length, "anti-vacuity: both looks' inks, both modes, eight names").toBe(32);
    const html = "<p>" + want.map(([t, st]) => `<span style="${st}">${t}</span>`).join(" ") + "</p>";
    const got = await page.evaluate((html) => {
      const h = document.documentElement, out = {};
      for (const look of ["signature", "ambient"]) for (const theme of ["light", "dark"]) {
        h.setAttribute("data-look", look); h.setAttribute("data-theme", theme);
        const d = document.implementation.createHTMLDocument("x"); d.body.innerHTML = window.normalisePastedHtml(html);
        out[`${look}-${theme}`] = [...d.body.querySelectorAll("span")].map((s) => [s.textContent, s.getAttribute("style") || ""]);
      }
      return out;
    }, html);
    const expected = want.map(([t, , name]) => [t, name]);
    for (const [where, spans] of Object.entries(got)) expect(spans, `${where}: each pasted colour as its name, by value`).toEqual(expected);
    expect(Object.keys(got), "anti-vacuity: four look x mode pastes").toHaveLength(4);
  });
});

// ── 3. The palette ──────────────────────────────────────────────────────────
test.describe("Every name is readable in every look, mode and ambient colour", () => {
  test("from the data: each ink clears 4.5:1 on canvas, card, well and hover well; body, muted, link and every ink clear it on each highlight", () => {
    const combos = lookCombos();
    expect(combos.length, "anti-vacuity: every look x mode x ambient colour").toBeGreaterThanOrEqual(14);
    const bad = [];
    let pairs = 0;
    for (const { label, tokens: t } of combos) {
      for (const n of NAMES) {
        const ink = t[`--rt-${n}`], tint = t[`--rt-hl-${n}`];
        if (!ink || !tint) { bad.push(`${label}: ${n} has no ink or no tint`); continue; }
        for (const layer of ["--bg", "--surface", "--surface-2", "--surface-3"]) {
          pairs++; const r = ratio(ink, t[layer]);
          if (r < 4.5) bad.push(`${label}: ${n} ink ${ink} on ${layer} = ${r.toFixed(2)}`);
        }
        for (const fg of ["--text", "--muted", "--accent-ink", ...NAMES.map((x) => `--rt-${x}`)]) {
          pairs++; const r = ratio(t[fg], tint);
          if (r < 4.5) bad.push(`${label}: ${fg} on the ${n} highlight ${tint} = ${r.toFixed(2)}`);
        }
      }
    }
    expect(pairs, "anti-vacuity: every pair was measured").toBe(combos.length * NAMES.length * (4 + 3 + NAMES.length));
    expect(bad, bad.join("\n")).toEqual([]);
    // CONTROL: the literal palette the names replaced fails exactly where it was
    // reported, so a measure that could not see a failure would not pass this.
    const sigDay = combos.find((c) => c.label === "signature/light").tokens;
    const sigNight = combos.find((c) => c.label === "signature/dark").tokens;
    expect(ratio("#00e5a0", sigDay["--surface"]), "CONTROL: the old bright green on a day card").toBeLessThan(2);
    expect(ratio("#000000", sigNight["--surface"]), "CONTROL: the old black on a night card").toBeLessThan(2);
  });

  test("the generator measures every rich-text pair and fails a planted unreadable ink, tint or a missing name", () => {
    const { measure } = require("../scripts/build-theme-tokens");
    const real = measure();
    expect(real.fails, real.fails.join("\n")).toEqual([]);
    expect(real.rich, "every look x mode x ambient colour: 4 layers + body, muted, link + every ink, per name").toBe(14 * NAMES.length * (4 + 3 + NAMES.length));
    const data = JSON.parse(JSON.stringify({ looks, ambients: require("../scripts/theme/looks").ambients }));
    data.looks.signature.light.rtInk.yellow = "#ffd166";        // the old literal yellow
    data.looks.ambient.dark.rtHighlight.grey = "#9ba2ae";        // a tint as light as the muted text
    delete data.looks.signature.dark.rtHighlight.pink;           // a name with no tint
    const planted = measure(data).fails.join("\n");
    expect(planted, "a planted day ink below AA is reported").toContain("signature/light: rtInk.yellow on surface");
    expect(planted, "a planted night tint the muted text cannot be read on is reported").toContain("ambient/dark/ice: muted on rtHighlight.grey");
    expect(planted, "a name without a tint is reported").toContain("signature/dark: rtInk and rtHighlight name different colours");
  });

  test("in a real page each name is drawn in its look's own ink and tint, and every pair measures AA as drawn", async ({ page }) => {
    await page.goto("/");
    await page.locator("#login-page").waitFor({ state: "attached", timeout: 20000 });
    await page.waitForFunction(() => typeof window.renderRich === "function", null, { timeout: 20000 });
    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    const combos = lookCombos();
    const bad = [];
    let drawn = 0;
    for (const c of combos) {
      const got = await page.evaluate(([look, theme, ambient, names]) => {
        const h = document.documentElement;
        h.setAttribute("data-look", look); h.setAttribute("data-theme", theme);
        if (ambient) h.setAttribute("data-ambient", ambient); else h.removeAttribute("data-ambient");
        // Rich text as the challenge draws it, plus a hint's muted text.
        const box = document.createElement("div");
        box.className = "rich-body";
        box.innerHTML = window.renderRich(names.map((n) =>
          `<span style="color:var(--rt-${n})">i</span>`
          + `<span style="background-color:var(--rt-hl-${n})">h<a href="https://example.com/">l</a></span>`).join("")
          + `<div style="color:var(--muted)">${names.map((n) => `<span style="background-color:var(--rt-hl-${n})">m</span>`).join("")}</div>`);
        document.body.appendChild(box);
        const cs = getComputedStyle(h);
        const tok = (k) => cs.getPropertyValue(k).trim();
        const out = { layers: { bg: tok("--bg"), surface: tok("--surface"), surface2: tok("--surface-2"), surface3: tok("--surface-3") }, names: {} };
        const own = [...box.querySelectorAll(":scope > span")], hint = [...box.querySelectorAll(":scope > div > span")];
        names.forEach((n, i) => {
          const ink = own[2 * i], hl = own[2 * i + 1];
          out.names[n] = { ink: getComputedStyle(ink).color, tint: getComputedStyle(hl).backgroundColor,
            text: getComputedStyle(hl).color, link: getComputedStyle(hl.querySelector("a")).color, muted: getComputedStyle(hint[i]).color };
        });
        box.remove();
        return out;
      }, [c.look, c.theme, c.ambient, NAMES]);
      const t = c.tokens;
      for (const n of NAMES) {
        const g = got.names[n];
        drawn++;
        if (g.ink !== rgbText(t[`--rt-${n}`])) bad.push(`${c.label}: ${n} is drawn ${g.ink}, not the look's ink ${t[`--rt-${n}`]}`);
        if (g.tint !== rgbText(t[`--rt-hl-${n}`])) bad.push(`${c.label}: the ${n} highlight is drawn ${g.tint}, not the look's tint ${t[`--rt-hl-${n}`]}`);
        for (const [layer, v] of Object.entries(got.layers)) if (ratio(g.ink, v) < 4.5) bad.push(`${c.label}: ${n} ink on ${layer} = ${ratio(g.ink, v).toFixed(2)}`);
        for (const k of ["text", "link", "muted"]) if (ratio(g[k], g.tint) < 4.5) bad.push(`${c.label}: ${k} on the ${n} highlight = ${ratio(g[k], g.tint).toFixed(2)}`);
      }
    }
    expect(drawn, "anti-vacuity: every name in every combination was drawn").toBe(combos.length * NAMES.length);
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

// ── 4. The editor ───────────────────────────────────────────────────────────
async function openEditor(page, look = "signature", theme = "light") {
  await page.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) {} }, [look, theme]);
  const csrf = await superadminApi(page);
  await page.goto("/");
  await waitForAdminPage(page, 30000);
  await page.locator("button[data-tab-id='admin-tasks-tab']").click();
  await page.locator("#new-task-btn, [data-action='open-task-form']").first().click();
  await page.locator("#tf-desc .rich-body").waitFor({ state: "visible", timeout: 15000 });
  expect(await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme]),
    "PRECONDITION: the look and mode asked for").toEqual([look, theme]);
  return csrf;
}
const setDesc = (page, html) => page.evaluate((h) => window.descEditor.setHtml(h), html);
const getDesc = (page) => page.evaluate(() => window.descEditor.getHtml());
// How the editor writes a name (the browser's own serialisation of the style it sets).
const ink = (n) => `color: var(--rt-${n});`;
const tint = (n) => `background-color: var(--rt-hl-${n});`;
/** Select `len` characters from `at` in the first text node of the description holding `text` (or a bare caret). */
const selectIn = (page, text, at, len) => page.evaluate(([text, at, len]) => {
  const body = document.querySelector("#tf-desc .rich-body");
  body.focus();
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let t; while ((t = w.nextNode()) && !t.data.includes(text));
  if (!t) throw new Error(`no text node holds ${text}`);
  const i = t.data.indexOf(text) + at;
  const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + len);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}, [text, at, len]);
async function pick(page, kind, name) {
  const bar = page.locator("#tf-desc .rich-toolbar");
  if (await bar.locator(".rt-more-btn").getAttribute("aria-expanded") !== "true") await bar.locator(".rt-more-btn").click();
  await bar.locator(`button[aria-label='${kind === "highlight" ? "Highlight" : "Text Color"}']`).click();
  const pop = bar.locator(".color-pop");
  await expect(pop).toBeVisible();
  await pop.locator(name ? `[data-rt-swatch="${name}"]` : ".color-sw.no-color").click();
  await expect(pop).toHaveCount(0);
}

test.describe("The editor's colour menus store a name, never a hex", () => {
  test("Text colour and Highlight write the name, offer each name drawn in the look's own ink and tint, and the save stores exactly that", async ({ page }) => {
    await openEditor(page, "signature", "light");
    await setDesc(page, "<p>Alpha Bravo Charlie</p>");
    await selectIn(page, "Bravo", 0, 5);
    // The menu: "no colour" and the nine names, each painted in this look's ink.
    const bar = page.locator("#tf-desc .rich-toolbar");
    await bar.locator(".rt-more-btn").click();
    await bar.locator("button[aria-label='Text Color']").click();
    const pop = bar.locator(".color-pop");
    await expect(pop.locator("[role='menuitem']")).toHaveCount(1 + NAMES.length);
    expect(await pop.locator("[role='menuitem']").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))))
      .toEqual(["Default colour", ...NAMES.map((n) => n[0].toUpperCase() + n.slice(1))]);
    const swatches = await pop.locator("[data-rt-swatch]").evaluateAll((els) => els.map((e) => [e.dataset.rtSwatch, getComputedStyle(e).backgroundColor]));
    expect(swatches, "each text swatch shows the ink this look draws").toEqual(NAMES.map((n) => [n, rgbText(looks.signature.light.rtInk[n])]));
    await pop.locator('[data-rt-swatch="red"]').click();
    expect(await getDesc(page)).toBe(`<p>Alpha <span style="${ink("red")}">Bravo</span> Charlie</p>`);
    // The Highlight menu, its swatches the tints, each with an edge (a day tint is
    // pale on the menu's own card).
    await selectIn(page, "Charlie", 0, 7);
    await bar.locator("button[aria-label='Highlight']").click();
    const tints = await bar.locator(".color-pop [data-rt-swatch]").evaluateAll((els) => els.map((e) => [e.dataset.rtSwatch, getComputedStyle(e).backgroundColor, getComputedStyle(e).borderTopColor]));
    const edge = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--border-strong").trim());
    expect(tints, "each highlight swatch shows the tint this look draws, with an edge").toEqual(NAMES.map((n) => [n, rgbText(looks.signature.light.rtHighlight[n]), rgbText(edge)]));
    await bar.locator('.color-pop [data-rt-swatch="yellow"]').click();
    expect(await getDesc(page)).toBe(`<p>Alpha <span style="${ink("red")}">Bravo</span> <span style="${tint("yellow")}">Charlie</span></p>`);
    // Drawn in the look's ink and tint, in the editor itself.
    const drawn = await page.locator("#tf-desc .rich-body").evaluate((b) => { const [a, c] = b.querySelectorAll("span"); return [getComputedStyle(a).color, getComputedStyle(c).backgroundColor]; });
    expect(drawn).toEqual([rgbText(looks.signature.light.rtInk.red), rgbText(looks.signature.light.rtHighlight.yellow)]);
    // The save stores the names (in the server's own serialisation of a style).
    const title = `RtSave ${Date.now()}`;
    await page.locator("#tf-title").fill(title);
    await page.locator("#tf-answer").fill("a");
    await page.locator("[data-action='save-task']").first().click();
    await expect.poll(async () => {
      const list = await (await page.request.get("/api/admin/tasks")).json();
      const row = (list.tasks || list).find((t) => t.title === title);
      return row ? row.description : null;
    }, { timeout: 15000 }).toBe('<p>Alpha <span style="color:var(--rt-red)">Bravo</span> <span style="background-color:var(--rt-hl-yellow)">Charlie</span></p>');
  });

  test("a pick over part of a coloured run splits it; no colour takes it off; the keyboard path colours the selection it was opened on; a line is never split", async ({ page }) => {
    await openEditor(page, "ambient", "dark");
    await setDesc(page, `<p><span style="${ink("red")}">Hello world</span></p>`);
    await selectIn(page, "lo wo", 0, 5);
    await pick(page, "color", "blue");
    expect(await getDesc(page), "the red run is split at the selection; only the selected part turns blue")
      .toBe(`<p><span style="${ink("red")}">Hel</span><span style="${ink("blue")}">lo wo</span><span style="${ink("red")}">rld</span></p>`);
    await selectIn(page, "Hel", 0, 3);
    await pick(page, "color", null);
    expect(await getDesc(page), "\"Default colour\" takes the name off the selection only")
      .toBe(`<p>Hel<span style="${ink("blue")}">lo wo</span><span style="${ink("red")}">rld</span></p>`);
    // A highlight across a coloured run keeps the run's colour; "No highlight" takes it off.
    await selectIn(page, "lo wo", 1, 3);
    await pick(page, "highlight", "green");
    expect(await getDesc(page)).toBe(`<p>Hel<span style="${ink("blue")}">l<span style="${tint("green")}">o w</span>o</span><span style="${ink("red")}">rld</span></p>`);
    await selectIn(page, "o w", 0, 3);
    await pick(page, "highlight", null);
    expect(await getDesc(page)).toBe(`<p>Hel<span style="${ink("blue")}">lo wo</span><span style="${ink("red")}">rld</span></p>`);
    // The keyboard: Enter on Text Color opens the menu on the first swatch; the
    // arrows move to a name and Enter applies it to the selection the menu opened
    // on, although focus left the editor for the menu.
    await selectIn(page, "rld", 0, 3);
    const bar = page.locator("#tf-desc .rich-toolbar");
    await bar.locator("button[aria-label='Text Color']").focus();
    await page.keyboard.press("Enter");
    const pop = bar.locator(".color-pop");
    await expect(pop.locator("[role='menuitem']").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(pop.locator('[data-rt-swatch="red"]')).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(pop.locator('[data-rt-swatch="orange"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pop).toHaveCount(0);
    expect(await getDesc(page)).toBe(`<p>Hel<span style="${ink("blue")}">lo wo</span><span style="${ink("orange")}">rld</span></p>`);
    // A colour span wrapping whole lines (a paste can leave one) is never split
    // through a line: splitting it there would cut the line in two.
    await setDesc(page, `<span style="${ink("red")}"><div>Line one</div><div>Line two</div></span>`);
    await selectIn(page, "Line one", 5, 3);
    await pick(page, "color", "blue");
    expect(await getDesc(page), "the lines stay whole; the pick is drawn inside its line")
      .toBe(`<span style="${ink("red")}"><div>Line <span style="${ink("blue")}">one</span></div><div>Line two</div></span>`);
  });

  test("an older literal colour or highlight under a pick is split, and the picked part carries the name only; text copied or dragged inside the editor keeps its names", async ({ page }) => {
    await openEditor(page, "signature", "dark");
    await setDesc(page, '<p><span style="color:#ff4d6a;font-size:20px">Legacy text</span></p>');
    await selectIn(page, "Legacy text", 3, 6);
    await pick(page, "color", "green");
    const got = await page.locator("#tf-desc .rich-body").evaluate((b) => [...b.querySelectorAll("p > span")].map((s) => ({
      text: s.textContent, colour: s.style.color,
      inner: s.firstElementChild ? { colour: s.firstElementChild.style.color, size: s.firstElementChild.style.fontSize } : null,
      drawn: getComputedStyle(s.firstElementChild || s).color })));
    expect(got, "the older colour keeps the unselected ends; the middle loses it and takes the name").toEqual([
      { text: "Leg", colour: "rgb(255, 77, 106)", inner: null, drawn: "rgb(255, 77, 106)" },
      { text: "acy te", colour: "var(--rt-green)", inner: { colour: "", size: "20px" }, drawn: rgbText(looks.signature.dark.rtInk.green) },
      { text: "xt", colour: "rgb(255, 77, 106)", inner: null, drawn: "rgb(255, 77, 106)" },
    ]);
    // An older highlight likewise: the selected part loses its literal background
    // (the wrapper left with nothing else goes) and takes the named tint.
    await setDesc(page, '<p><span style="background-color:#ffff00">Marked text</span></p>');
    await selectIn(page, "Marked text", 3, 6);
    await pick(page, "highlight", "blue");
    expect(await getDesc(page)).toBe(`<p><span style="background-color:#ffff00">Mar</span><span style="${tint("blue")}">ked te</span>`
      + '<span style="background-color:#ffff00">xt</span></p>');
    // A copy inside the editor reaches the clipboard as the browser draws it, with
    // this look's literal ink and tint (Chromium's own shape, recorded): pasted at
    // a line's end, the text comes back with its names, and no literal colour.
    await setDesc(page, "<p>Target</p>");
    await selectIn(page, "Target", 6, 0);
    await page.evaluate(() => {
      const el = document.querySelector("#tf-desc .rich-body");
      const dt = new DataTransfer();
      dt.setData("text/html", '<span style="box-sizing: border-box; font-size: 14px; background-color: rgb(27, 23, 53); color: rgb(246, 145, 149);">coloured</span>'
        + '<span style="color: rgb(239, 234, 249); font-size: 14px; background-color: rgb(27, 23, 53); display: inline !important;"> and </span>'
        + '<span style="box-sizing: border-box; color: rgb(239, 234, 249); font-size: 14px; background-color: rgb(59, 49, 20);">marked</span>');
      dt.setData("text/plain", "coloured and marked");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    expect(await page.locator("#tf-desc .rich-body").evaluate((b) => ({ text: b.textContent,
      colours: [...b.querySelectorAll("[style]")].map((e) => [e.textContent, e.style.color, e.style.backgroundColor]).filter(([, c, bg]) => c || bg) })))
      .toEqual({ text: "Targetcoloured and marked", colours: [["coloured", "var(--rt-red)", ""], ["marked", "", "var(--rt-hl-yellow)"]] });
    // A drag inside the editor moves the text as the browser draws it, too.
    await setDesc(page, `<p>Start <span style="${ink("red")}">coloured</span> end</p><p>Second line here</p>`);
    await page.evaluate(() => {
      window.__drops = [];
      const b = document.querySelector("#tf-desc .rich-body");
      b.addEventListener("drop", (e) => window.__drops.push(e.dataTransfer.getData("text/html")), { capture: true, once: true });
      b.focus();
      const r = document.createRange(); r.selectNodeContents(b.querySelector("span").firstChild);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    const from = await page.locator("#tf-desc .rich-body span").boundingBox();
    const to = await page.locator("#tf-desc .rich-body p").nth(1).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 5, from.y + from.height / 2 + 2, { steps: 4 });
    await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__drops.length), { message: "the drag dropped inside the editor" }).toBe(1);
    expect(await page.evaluate(() => window.__drops[0]), "PRECONDITION: the browser moved the text as a literal ink, not its name")
      .toContain(`color: ${rgbText(looks.signature.dark.rtInk.red)}`);
    expect(await page.locator("#tf-desc .rich-body").evaluate((b) => ({ second: b.querySelectorAll("p")[1].textContent,
      colours: [...b.querySelectorAll("[style]")].map((e) => [e.textContent, e.style.color]).filter(([, c]) => c) })))
      .toEqual({ second: "Second line herecoloured", colours: [["coloured", "var(--rt-red)"]] });
  });

  test("with nothing selected, a picked colour colours what is typed next, until the caret moves; Clear Formatting leaves no colour behind", async ({ page }) => {
    await openEditor(page, "ambient", "light");
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "color", "red");
    expect(await getDesc(page), "a bare caret changes nothing until something is typed").toBe("<p>One two</p>");
    await page.keyboard.type("z");
    expect(await page.evaluate(() => {
      const r = getSelection().getRangeAt(0), n = r.startContainer;
      return [r.collapsed, (n.nodeType === 3 ? n.parentElement : n).style.color, n.nodeType === 3 && r.startOffset === n.length];
    }), "the caret is left inside the coloured text, at its end, so typing carries on in it").toEqual([true, "var(--rt-red)", true]);
    await page.keyboard.type("z");
    expect(await getDesc(page), "the typed text takes the colour, and the caret stays inside it")
      .toBe(`<p>One <span style="${ink("red")}">zz</span>two</p>`);
    // A highlight and a colour picked at one caret both apply to what is typed.
    await selectIn(page, "two", 3, 0);
    await pick(page, "color", "violet");
    await pick(page, "highlight", "cyan");
    await page.keyboard.type("q");
    expect(await getDesc(page)).toBe(`<p>One <span style="${ink("red")}">zz</span>two<span style="${tint("cyan")}"><span style="${ink("violet")}">q</span></span></p>`);
    // CONTROL: a caret that moved after the pick drops it.
    await selectIn(page, "One", 0, 0);
    await pick(page, "color", "green");
    await selectIn(page, "One", 2, 0);
    await page.keyboard.type("x");
    expect(await getDesc(page), "the pick waited at another caret, so this text is plain")
      .toBe(`<p>Onxe <span style="${ink("red")}">zz</span>two<span style="${tint("cyan")}"><span style="${ink("violet")}">q</span></span></p>`);
    // Clear Formatting on named text: bold, colour and highlight all go.
    await setDesc(page, `<p><b><span style="${ink("red")}">Bold</span> <span style="${tint("yellow")}">red</span></b> plain</p>`);
    await page.evaluate(() => {
      const b = document.querySelector("#tf-desc .rich-body"); b.focus();
      const [first, second] = b.querySelectorAll("p b > span");
      const r = document.createRange(); r.setStart(first.firstChild, 0); r.setEnd(second.firstChild, second.firstChild.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    const bar = page.locator("#tf-desc .rich-toolbar");
    if (await bar.locator(".rt-more-btn").getAttribute("aria-expanded") !== "true") await bar.locator(".rt-more-btn").click();
    await bar.locator("button[aria-label='Clear Formatting']").click();
    expect(await getDesc(page)).toBe("<p>Bold red plain</p>");
  });
});

// ── 5. Where participants read it ───────────────────────────────────────────
test.describe("A named colour reaches every surface that renders the challenge", () => {
  test("View as Participant (by day) and the participant's challenge (at night) draw the look's own ink and tint, and an older literal as stored", async ({ page, browser }) => {
    await page.addInitScript(() => { try { localStorage.setItem("hck-look", "signature"); localStorage.setItem("hck-theme", "light"); } catch (_) {} });
    const csrf = await superadminApi(page);
    const title = `RtSurfaces ${Date.now()}`;
    const description = '<p><span style="color:var(--rt-green)">Named</span> and <span style="color:#ff4d6a">legacy</span> and <span style="background-color:var(--rt-hl-yellow)">marked</span></p>';
    const r = await page.request.post("/api/admin/tasks", { headers: H(csrf), data: {
      title, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published", description } });
    expect(r.ok(), `seed: ${r.status()} ${await r.text()}`).toBeTruthy();
    const taskId = (await r.json()).id;
    const live = await makeCompetition(page.request, csrf, "rtcolour");
    const asg = await page.request.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [live.id] } });
    expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
    // The event's own copy (lib/event-copies.js): the card its participant opens.
    const heldId = (await asg.json()).copies[0].task_id;
    const reader = await makeParticipant(page.request, csrf, "rtcolour");
    await enrol(page.request, csrf, live.id, [reader.id]);
    const read = (root) => root.evaluate((el) => {
      const [named, legacy, marked] = el.querySelectorAll("span");
      return { named: getComputedStyle(named).color, legacy: getComputedStyle(legacy).color, marked: getComputedStyle(marked).backgroundColor,
        look: [document.documentElement.dataset.look, document.documentElement.dataset.theme] };
    });

    // The admin's View as Participant, by day.
    await page.goto("/");
    await waitForAdminPage(page, 30000);
    await page.locator("button[data-tab-id='admin-tasks-tab']").click();
    await narrowChallengesTable(page, title);
    await page.locator("#admin-task-body tr", { hasText: title }).first().locator("[data-action='task-view']").first().click();
    await page.locator("#task-preview-overlay .task-preview-desc span").first().waitFor({ state: "visible", timeout: 10000 });
    expect(await read(page.locator("#task-preview-overlay .task-preview-desc"))).toEqual({
      named: rgbText(looks.signature.light.rtInk.green), legacy: "rgb(255, 77, 106)",
      marked: rgbText(looks.signature.light.rtHighlight.yellow), look: ["signature", "light"] });

    // The participant's challenge, at night, in their own browser.
    const ctx = await browser.newContext({ baseURL: BASE });
    try {
      await ctx.addInitScript(() => { try { localStorage.setItem("hck-look", "ambient"); localStorage.setItem("hck-theme", "dark"); } catch (_) {} });
      const p2 = await ctx.newPage();
      const li = await codeLogin(p2.request, reader.email);
      expect(li.ok(), `participant sign-in: ${await li.text()}`).toBeTruthy();
      const ac = (await (await p2.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await p2.request.post("/api/select-competition", { headers: H(ac), data: { competitionId: live.id } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      await p2.goto("/");
      await p2.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 20000 });
      await p2.locator("#nav-challenges:not([aria-disabled=true])").click();
      await p2.locator(`[data-action="task-open"][data-task-id="${heldId}"]`).click();
      await p2.locator("#task-detail-card .task-desc span").first().waitFor({ state: "visible", timeout: 15000 });
      expect(await read(p2.locator("#task-detail-card .task-desc"))).toEqual({
        named: rgbText(looks.ambient.dark.rtInk.green), legacy: "rgb(255, 77, 106)",
        marked: rgbText(looks.ambient.dark.rtHighlight.yellow), look: ["ambient", "dark"] });
    } finally { await ctx.close(); }
  });
});

// ── 6. A table section's style ──────────────────────────────────────────────
// sanitize-html filters a style only by the tag's own rule or a "*" rule, and with
// neither keeps it exactly as written: thead, tbody and tfoot took a style with no
// rule, so a page token, a url() and position:fixed were stored and drawn as written.
test.describe("A table section keeps only a tint and its alignment", () => {
  test("the server stores a section's tint and alignment and drops a page token, url(), position and every other property; every tag allowed a style has a rule of its own, and the fallback rule keeps nothing on a tag without one", async ({ page }) => {
    const csrf = await superadminApi(page);
    const sections = "<table>"
      + '<thead style="background-color:var(--bg);color:var(--text);position:fixed;inset:0;z-index:99999"><tr><th>h</th></tr></thead>'
      + '<tbody style="background-color:var(--rt-hl-blue);text-align:center;vertical-align:top;position:absolute;top:0;width:100%"><tr><td>b</td></tr></tbody>'
      + '<tfoot style="background-color:#eeeeee;background-image:url(https://example.com/beacon.png);text-align:right"><tr><td>f</td></tr></tfoot></table>'
      + '<table><tbody style="background-color:var(--rt-red)"><tr><td>ink as a tint</td></tr></tbody>'
      + '<tfoot style="background-color:var(--rt-hl-red, #000);vertical-align:var(--x)"><tr><td>fallback</td></tr></tfoot></table>';
    const { stored } = await storeDescription(page, csrf, sections);
    expect(stored, "each section keeps a literal or a listed name's tint and its alignment, nothing else").toBe("<table>"
      + "<thead><tr><th>h</th></tr></thead>"
      + '<tbody style="background-color:var(--rt-hl-blue);text-align:center;vertical-align:top"><tr><td>b</td></tr></tbody>'
      + '<tfoot style="background-color:#eeeeee;text-align:right"><tr><td>f</td></tr></tfoot></table>'
      + "<table><tbody><tr><td>ink as a tint</td></tr></tbody><tfoot><tr><td>fallback</td></tr></tfoot></table>");

    // Every tag the server lets carry a style has a rule of its own, and the "*" rule
    // keeps nothing, so a tag given a style later without a rule keeps no declaration.
    const { _RICH_TEXT_OPTS: O } = require("../lib/sanitise");
    const styled = Object.entries(O.allowedAttributes).filter(([, a]) => a.includes("style")).map(([t]) => t);
    expect(styled.length, "anti-vacuity: the allowlist gives a style to the span, the image and every table tag").toBeGreaterThanOrEqual(10);
    expect(styled.filter((t) => !Object.prototype.hasOwnProperty.call(O.allowedStyles, t)), "a tag allowed a style without a rule of its own").toEqual([]);
    expect(O.allowedStyles["*"], "the fallback rule admits no property").toEqual({});
    const sanitizeHtml = require("sanitize-html");
    const withP = { ...O, allowedAttributes: { ...O.allowedAttributes, p: ["style"] } };
    const planted = '<p style="color:red;position:fixed">p</p><span style="color:red;position:fixed">s</span>';
    expect(sanitizeHtml(planted, withP), "a tag given a style with no rule keeps nothing; a tag with a rule keeps what it admits")
      .toBe('<p>p</p><span style="color:red">s</span>');
    const { "*": _fallback, ...noFallback } = O.allowedStyles;
    expect(sanitizeHtml(planted, { ...withP, allowedStyles: noFallback }), "CONTROL: without the fallback, this sanitize-html keeps an unruled style as written")
      .toBe('<p style="color:red;position:fixed">p</p><span style="color:red">s</span>');

    // The renderer keeps the server's section properties (RICH_SECTION_STYLES, derived
    // from the paste's section rule, which tests/richtext-tables.spec.js mirrors whole).
    await page.goto("/");
    await page.waitForFunction(() => Array.isArray(window.RICH_SECTION_STYLES), null, { timeout: 20000 });
    const client = (await page.evaluate(() => [...window.RICH_SECTION_STYLES])).sort();
    expect(client.length, "anti-vacuity: the client lists the section properties").toBeGreaterThanOrEqual(3);
    for (const tag of ["thead", "tbody", "tfoot"]) {
      expect(Object.keys(O.allowedStyles[tag]).sort(), `${tag}: the client keeps exactly the server's section properties`).toEqual(client);
    }
  });

  test("the renderer keeps only a section's tint and alignment, so a section stored before the server filtered one cannot cover the page; a paste keeps what the save will", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => typeof window.renderRich === "function" && typeof window.normalisePastedHtml === "function", null, { timeout: 20000 });
    const got = await page.evaluate(() => {
      // A table as the server stored one while sections went unfiltered.
      const stored = "<table>"
        + '<tbody style="background-color:var(--bg);position:fixed;inset:0;z-index:99999;background-image:url(/api/images/beacon)"><tr><td style="text-align:right">x</td></tr></tbody>'
        + '<thead style="background-color:var(--rt-hl-blue);text-align:center;vertical-align:top;color:#ff0000"><tr><th>h</th></tr></thead>'
        + '<tfoot style="background-color:#eeeeee;width:100%;background-color:var(--rt-red)"><tr><td>f</td></tr></tfoot></table>';
      const html = window.renderRich(stored);
      const box = document.createElement("div");
      box.className = "rich-body";
      box.innerHTML = html;
      document.body.appendChild(box);
      const out = { html, position: getComputedStyle(box.querySelector("tbody")).position };
      box.remove();
      // CONTROL: the same section drawn as stored is laid over the page.
      const raw = document.createElement("div");
      raw.innerHTML = '<table><tbody style="position:fixed;inset:0"><tr><td>x</td></tr></tbody></table>';
      document.body.appendChild(raw);
      out.rawPosition = getComputedStyle(raw.querySelector("tbody")).position;
      raw.remove();
      // A web page's table as Chromium copies it (computed styles on each section).
      out.paste = window.normalisePastedHtml("<table>"
        + '<thead style="color: rgb(250, 250, 250); text-align: center; background-color: rgb(34, 51, 68); font-weight: bold; position: fixed"><tr><th>H</th></tr></thead>'
        + '<tbody style="background-color: var(--bg); vertical-align: top; width: 50%"><tr><td style="color: rgb(153, 0, 0)">v</td></tr></tbody></table>');
      return out;
    });
    expect(got.rawPosition, "CONTROL: drawn as stored, the section is laid over the page").toBe("fixed");
    expect(got.position, "rendered, it stays in the table").toBe("static");
    expect(got.html, "the renderer keeps a section's tint and alignment and nothing else; a cell is left as stored").toBe("<table>"
      + '<tbody><tr><td style="text-align:right">x</td></tr></tbody>'
      + '<thead style="background-color:var(--rt-hl-blue);text-align:center;vertical-align:top"><tr><th>h</th></tr></thead>'
      + "<tfoot><tr><td>f</td></tr></tfoot></table>");
    // (A literal colour comes out as the nearest name: a dark slate tint is grey.)
    expect(got.paste, "a pasted section keeps what the server will, so the editor shows what is saved").toBe("<table>"
      + '<thead style="text-align:center;background-color:var(--rt-hl-grey)"><tr><th>H</th></tr></thead>'
      + '<tbody style="vertical-align:top"><tr><td style="color:var(--rt-red)">v</td></tr></tbody></table>');
  });
});

// ── 7. Undo, redo and an IME ────────────────────────────────────────────────
// A pick is the editor's own DOM work, so the browser's history never sees it: Ctrl+Z
// passed over it and undid the typing before it, at places the pick had split since.
const undo = (page) => page.keyboard.press("Control+z");
const redo = (page, keys = "Control+Shift+z") => page.keyboard.press(keys);
const selected = (page) => page.evaluate(() => getSelection().toString());
// The caret as [text it sits in, offset], or null for a selection.
const caretAt = (page) => page.evaluate(() => {
  const r = getSelection().getRangeAt(0);
  return r.collapsed && r.startContainer.nodeType === 3 ? [r.startContainer.data, r.startOffset] : null;
});
// The browser's own Undo (its Edit and context menus) arrives as a beforeinput.
const menuUndo = (page) => page.evaluate(() => {
  const e = new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true });
  document.querySelector("#tf-desc .rich-body").dispatchEvent(e);
  return e.defaultPrevented;
});
// Whether the browser has an Undo and a Redo of its own ([undo, redo]): what its own
// history holds, which a pick never adds to (measured: true once text is typed).
const browserHistory = (page) => page.evaluate(() => [document.queryCommandEnabled("undo"), document.queryCommandEnabled("redo")]);

test.describe("A colour pick undoes as one step, before the browser's own history", () => {
  test("Ctrl+Z takes a pick off and leaves the typed text, the last pick first; Ctrl+Shift+Z and Ctrl+Y put them back; the next Ctrl+Z undoes the typing as the browser always did", async ({ page }) => {
    await openEditor(page, "signature", "light");
    await setDesc(page, "<p>Alpha</p>");
    await selectIn(page, "Alpha", 5, 0);
    await page.keyboard.type(" Bravo Charlie");
    expect(await getDesc(page), "PRECONDITION: the browser typed it").toBe("<p>Alpha Bravo Charlie</p>");
    await selectIn(page, "Bravo", 0, 5);
    await pick(page, "color", "red");
    await selectIn(page, "Charlie", 0, 7);
    await pick(page, "highlight", "yellow");
    const red = `<p>Alpha <span style="${ink("red")}">Bravo</span> Charlie</p>`;
    const both = `<p>Alpha <span style="${ink("red")}">Bravo</span> <span style="${tint("yellow")}">Charlie</span></p>`;
    expect(await getDesc(page)).toBe(both);
    await undo(page);
    expect(await getDesc(page), "the last pick comes off first, the text kept").toBe(red);
    expect(await selected(page), "with the text it coloured selected again").toBe("Charlie");
    await undo(page);
    expect(await getDesc(page), "then the pick before it").toBe("<p>Alpha Bravo Charlie</p>");
    expect(await selected(page)).toBe("Bravo");
    await redo(page);
    expect(await getDesc(page), "Ctrl+Shift+Z puts the first pick back").toBe(red);
    await redo(page, "Control+y");
    expect(await getDesc(page), "Ctrl+Y the second").toBe(both);
    await undo(page);
    await undo(page);
    expect(await getDesc(page)).toBe("<p>Alpha Bravo Charlie</p>");
    // A new pick after an undo leaves nothing to redo.
    await selectIn(page, "Alpha", 0, 5);
    await pick(page, "color", "green");
    await redo(page);
    expect(await getDesc(page), "the undone picks are not put back over a new one").toBe(`<p><span style="${ink("green")}">Alpha</span> Bravo Charlie</p>`);
    await undo(page);
    expect(await getDesc(page)).toBe("<p>Alpha Bravo Charlie</p>");
    // The picks gave the text back node for node, so the browser's own history still
    // describes it: its next step, the typing, undoes as it always did.
    await undo(page);
    expect(await getDesc(page), "the browser's own step undoes the typing").toBe("<p>Alpha</p>");
  });

  test("Cmd+Z and Cmd+Shift+Z take a pick off and put it back with nothing on the browser's own history; a colour picked at a bare caret and the character typed with it undo as one step; the browser's Undo takes a pick back too; any other change ends the editor's steps", async ({ page }) => {
    await openEditor(page, "ambient", "light");
    // A Mac's keys, before anything is typed or formatted in this page: the browser has
    // no Undo or Redo of its own to fire for them, whatever its platform binds to them
    // (Chromium on Linux binds none to Meta+Z), so only the editor's key handler can.
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 3);
    await pick(page, "color", "red");
    const two = `<p>One <span style="${ink("red")}">two</span></p>`;
    expect(await getDesc(page), "CONTROL: the pick is in the text before either key").toBe(two);
    expect(await browserHistory(page), "PRECONDITION: the browser has no Undo or Redo of its own here").toEqual([false, false]);
    await page.keyboard.press("Meta+z");
    expect(await getDesc(page), "Cmd+Z takes the pick off").toBe("<p>One two</p>");
    await page.keyboard.press("Meta+Shift+z");
    expect(await getDesc(page), "Cmd+Shift+Z puts it back").toBe(two);
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "color", "red");
    await page.keyboard.type("z");
    const typed = `<p>One <span style="${ink("red")}">z</span>two</p>`;
    expect(await getDesc(page)).toBe(typed);
    await undo(page);
    expect(await getDesc(page), "the typed character goes with its colour, in one step").toBe("<p>One two</p>");
    expect(await caretAt(page), "and the caret is back where the colour was picked").toEqual(["One two", 4]);
    await redo(page);
    expect(await getDesc(page)).toBe(typed);
    await page.keyboard.type("y");
    expect(await getDesc(page), "a redo leaves the caret inside the colour, as the typing did").toBe(`<p>One <span style="${ink("red")}">zy</span>two</p>`);
    expect((await browserHistory(page))[0], "CONTROL: typing puts a step on the browser's own history, so the precondition before Cmd+Z can tell").toBe(true);
    // The browser's own Undo (its Edit menu) takes the editor's step first too.
    await setDesc(page, "<p>Alpha Bravo</p>");
    await selectIn(page, "Bravo", 0, 5);
    await pick(page, "highlight", "green");
    expect(await getDesc(page)).toBe(`<p>Alpha <span style="${tint("green")}">Bravo</span></p>`);
    expect(await menuUndo(page), "the editor takes the browser's Undo for its own step").toBe(true);
    expect(await getDesc(page)).toBe("<p>Alpha Bravo</p>");
    expect(await menuUndo(page), "CONTROL: with no step of its own, the editor leaves the browser's Undo to the browser").toBe(false);
    // Any other change ends the editor's steps: its records would no longer describe
    // the text, so Ctrl+Z is the browser's again.
    await selectIn(page, "Alpha", 0, 5);
    await pick(page, "color", "blue");
    await selectIn(page, "Bravo", 0, 5);
    await page.locator("#tf-desc .rich-toolbar button[aria-label='Bold']").click();
    expect(await getDesc(page)).toBe(`<p><span style="${ink("blue")}">Alpha</span> <b>Bravo</b></p>`);
    await undo(page);
    expect(await getDesc(page), "Ctrl+Z undoes the bold, the browser's step, and leaves the pick before it")
      .toBe(`<p><span style="${ink("blue")}">Alpha</span> Bravo</p>`);
  });
});

test.describe("A colour waiting at a caret goes to text an IME composes there", () => {
  test("the committed composition takes the colour, as one step, with the caret left in it; a cancelled composition leaves the colour waiting; a deletion drops it", async ({ page }) => {
    await openEditor(page, "signature", "light");
    // Chromium's own IME path (what an Android keyboard or a Chinese, Japanese or
    // Korean input method drives): insertCompositionText, which cannot be cancelled.
    const cdp = await page.context().newCDPSession(page);
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "color", "red");
    await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
    expect(await getDesc(page), "nothing is touched while the IME composes").toBe("<p>One にほtwo</p>");
    await cdp.send("Input.insertText", { text: "日本" });
    const composed = `<p>One <span style="${ink("red")}">日本</span>two</p>`;
    await expect.poll(() => getDesc(page), { message: "the committed text takes the colour" }).toBe(composed);
    await undo(page);
    expect(await getDesc(page), "Ctrl+Z takes the colour off the composed text").toBe("<p>One 日本two</p>");
    await redo(page);
    expect(await getDesc(page)).toBe(composed);
    await page.keyboard.type("x");
    expect(await getDesc(page), "the caret is left inside the colour").toBe(`<p>One <span style="${ink("red")}">日本x</span>two</p>`);
    // A composition the IME cancels commits nothing: the colour still waits for text.
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "highlight", "cyan");
    await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    expect(await getDesc(page), "PRECONDITION: the composition left nothing").toBe("<p>One two</p>");
    await page.keyboard.type("z");
    expect(await getDesc(page), "the next text typed takes the waiting colour").toBe(`<p>One <span style="${tint("cyan")}">z</span>two</p>`);
    // Safari's order (simulated: Chromium neither sends nor constructs the type, so the
    // events carry it as their own property): the committed text is inserted after
    // compositionend, as insertFromComposition, and coloured as it arrives.
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "color", "orange");
    const safari = await page.evaluate(() => {
      const b = document.querySelector("#tf-desc .rich-body");
      const input = (type) => {
        const e = new InputEvent(type, { bubbles: true, cancelable: type === "beforeinput", data: "日本" });
        Object.defineProperty(e, "inputType", { value: "insertFromComposition" });
        return e;
      };
      b.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      b.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
      const before = window.descEditor.getHtml();
      b.dispatchEvent(input("beforeinput"));
      const r = getSelection().getRangeAt(0), t = document.createTextNode("日本");
      r.insertNode(t); r.setStartAfter(t); r.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      b.dispatchEvent(input("input"));
      return [before, window.descEditor.getHtml()];   // in one task, before any timer
    });
    expect(safari, "untouched until the text is in, then coloured as it arrives").toEqual(["<p>One two</p>", `<p>One <span style="${ink("orange")}">日本</span>two</p>`]);
    // CONTROL: a composition at another caret is not the text the colour waited for,
    // and drops it.
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "color", "green");
    await selectIn(page, "One two", 2, 0);
    await cdp.send("Input.imeSetComposition", { text: "日", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "日" });
    await page.keyboard.type("x");
    expect(await getDesc(page), "composed and typed at a moved caret, the text is plain").toBe("<p>On日xe two</p>");
    // CONTROL: a deletion is not text, and drops the waiting colour.
    await setDesc(page, "<p>One two</p>");
    await selectIn(page, "One two", 4, 0);
    await pick(page, "color", "violet");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("q");
    expect(await getDesc(page), "after a deletion the text typed is plain").toBe("<p>Oneqtwo</p>");
  });
});
