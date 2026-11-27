"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// v8.6.4 — THE COMPETITION PICKER RESERVES ITS GRID BEFORE THE DATA ARRIVES.
//
// `#comp-grid` populated from 0 cards to N as /api/my-competitions resolved, and
// everything below it moved by the full height of the card list. v8.3.16 found
// this and moved the join-code box ABOVE the grid, which left `#app-footer` as
// the only thing below — so the footer took the whole shift instead.
//
// MEASURED on the same 400 kbps / 500 ms link the CLS gate uses:
//     12 live events            0.1029   (0.0994 of it #app-footer alone)
//     8 live + 4 ended          0.0839
//   …with the skeleton:         0.0082   and #app-footer gone from the breakdown
//
// Two arms, because they fail differently. The first is the SUBJECT (the shift is
// gone); the second is deterministic and pins the thing that makes the
// reservation right rather than merely large.
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `clsk${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/**
 * A participant with `live` live events and `ended` finished ones — its own, per
 * the fixture-ownership rule: shared `alice` accumulates competitions as a run
 * proceeds, which is precisely why the CLS gate presented as intermittent.
 */
async function participantWith(live, ended) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Cls", lastName: "Skel", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
      jobFunction: "Software Developer / Engineer", city: "Testville" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }

  const { api, csrf } = await apiLogin("superadmin");
  try {
    const body = await (await api.get("/api/admin/participants?limit=5000")).json();
    const rows = Array.isArray(body) ? body : (body.users || body.participants || []);
    const u = rows.find((x) => x.email === email);
    expect(u, "the participant we just registered is findable").toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf), data: {} });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf), data: {} });

    const ids = [];
    for (let i = 0; i < live + ended; i++) {
      const c = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `${label} Event ${i}`, event_kind: "tournament", timezone: "UTC",
        start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
      expect(c.ok(), `create: ${await c.text()}`).toBeTruthy();
      ids.push((await c.json()).competition.id);
    }
    const as = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [u.id], competitionIds: ids } });
    expect(as.ok(), `assign: ${await as.text()}`).toBeTruthy();
    // End the tail, so the DEFAULT chip filter has something to hide.
    for (const id of ids.slice(live)) {
      const e = await api.post(`/api/admin/competitions/${id}/end-now`, { headers: H(csrf), data: {} });
      expect(e.ok(), `end-now: ${await e.text()}`).toBeTruthy();
    }
    return { email, ids };
  } finally { await api.dispose(); }
}

/** Sign the browser context in without driving the login form. */
async function signIn(page, email) {
  const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
  const r = await codeLogin(page.request, email, { "x-csrf-token": csrfToken, "content-type": "application/json" }, { base: `${BASE}` });
  expect(r.ok(), `login: ${r.status()}`).toBeTruthy();
}

test.describe("v8.6.4 — the picker reserves its grid", () => {
  test("the competition grid no longer shifts the page as it fills", async ({ page, context }) => {
    test.setTimeout(120_000);
    const f = await participantWith(8, 4);
    await signIn(page, f.email);

    const client = await context.newCDPSession(page);
    await client.send("Network.emulateNetworkConditions", {
      offline: false, latency: 500,
      downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });

    await page.addInitScript(() => {
      window._cls = 0; window._clsSrc = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window._cls += e.value;
          window._clsSrc.push({ v: +e.value.toFixed(4), nodes: (e.sources || []).map((s) => {
            const n = s.node; if (!n) return "(detached)";
            return n.id ? "#" + n.id : (n.tagName || "?") + "." + String(n.className || "").split(" ")[0];
          }) });
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#comp-grid .comp-card", { timeout: 60000 });
    await page.waitForTimeout(1500);

    const { cls, footer, breakdown } = await page.evaluate(() => ({
      cls: window._cls,
      // The specific node this exists to stop moving. v8.3.16 named it; before
      // the skeleton it carried 0.0698-0.0994 on its own.
      footer: window._clsSrc.filter((s) => s.nodes.includes("#app-footer"))
        .reduce((a, s) => a + s.v, 0),
      breakdown: window._clsSrc.slice().sort((a, b) => b.v - a.v).slice(0, 6)
        .map((s) => `${s.v} ${s.nodes.join("+")}`).join("; "),
    }));

    // Generous against the measured 0.0082, because a loaded box is not a quiet
    // one — but far under the 0.1 gate, and the mutation (no skeleton) lands at
    // 0.0839, so this cannot pass with the reservation removed.
    expect(cls, `picker CLS ${cls.toFixed(4)}. Shifts: ${breakdown}`).toBeLessThan(0.05);
    expect(footer, `#app-footer moved by ${footer.toFixed(4)} — the grid is growing under it again. Shifts: ${breakdown}`)
      .toBeLessThan(0.02);
  });

  test("no font preload the @font-face rules cannot use (it laid out the unstyled page)", async ({ request }) => {
    // The shell rewriter versions every href (?v=<hash>), but fonts.css asks for
    // the bare /vendor/fonts/*.woff2. A preload was therefore a DIFFERENT URL: it
    // never served the face, and when it landed before styles.css, Chrome ran a
    // layout + pre-paint on the unstyled page (its hover hit test), which became
    // the layout-shift baseline — the first styled frame then scored 0.037 on
    // <body> alone and the arm above failed about 9 runs in 10 in the CI image.
    // A preload whose URL a url() in fonts.css really requests is allowed.
    const shell = await (await request.get(`${BASE}/`)).text();
    const css = await (await request.get(`${BASE}/fonts.css`)).text();
    const used = new Set([...css.matchAll(/url\(\s*['"]?([^'")\s]+)/g)].map((m) => m[1]));
    expect(used.size, "anti-vacuity: fonts.css declares its faces by url()").toBeGreaterThan(0);
    expect(shell, "anti-vacuity: the served shell links fonts.css").toMatch(/href="\/fonts\.css/);
    const preloads = [...shell.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)].map((m) => m[0])
      .filter((tag) => /\bas="font"/.test(tag))
      .map((tag) => (tag.match(/\bhref="([^"]+)"/) || [, ""])[1]);
    const unused = preloads.filter((href) => !used.has(href));
    expect(unused, `font preloads no @font-face requests: ${unused.join(", ")}`).toEqual([]);
  });

  test("it reserves exactly what the picker will render, not what the payload holds", async ({ page }) => {
    test.setTimeout(120_000);
    // 2 live + 10 ended: the default chip filter hides the ten, so a reservation
    // sized from the raw payload over-reserves by four ROWS and the grid then
    // SHRINKS — a shift exactly like a grow. MEASURED: 0.1492 unfiltered against
    // 0.0113 filtered on this fixture, which is what makes this arm discriminating
    // where an 8+4 mix is not (there the span change happens to compensate).
    //
    // Asserted by COUNT rather than by a second CLS measurement: deterministic,
    // and it names the property instead of a symptom of it.
    const f = await participantWith(2, 10);
    await signIn(page, f.email);

    // Hold the picker's own fetch so the skeleton has a window at all. /api/me has
    // already delivered the list by then, which is the whole point.
    await page.route("**/api/my-competitions", async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    });

    // RECORDED BY OBSERVER, not sampled. Counting right after `domcontentloaded`
    // measured 0 under WORKERS=18 and passed serially — boot has to get through
    // /api/csrf-token, /api/config and /api/me before it reaches the picker at
    // all, so the sample landed before the skeleton could exist. That is the
    // "settle signal that is true too early" class, and widening the wait would
    // only move the race; watching the grid removes it.
    await page.addInitScript(() => {
      window.__maxSkeletons = 0;
      const tick = () => {
        const g = document.getElementById("comp-grid");
        if (g) window.__maxSkeletons = Math.max(window.__maxSkeletons,
          g.querySelectorAll(".skeleton-comp-card").length);
      };
      // On `document`, not `document.documentElement`: an init script runs before
      // the page's own scripts and can beat the parser to the root element, and
      // `observe(null, …)` THROWS — which kills the rest of this script silently,
      // leaving `__maxSkeletons` at its initial 0 and the assertion reporting a
      // missing skeleton against a perfectly correct build. Measured: the grid had
      // 2 skeleton children while this read 0.
      new MutationObserver(tick).observe(document, { childList: true, subtree: true });
      tick();
    });

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#comp-grid .comp-card", { timeout: 60000 });
    await page.unroute("**/api/my-competitions");
    const skeletons = await page.evaluate(() => window.__maxSkeletons);
    expect(skeletons, "the grid is reserved before the data arrives").toBeGreaterThan(0);
    const cards = await page.locator("#comp-grid .comp-card").count();

    expect(cards, "precondition: the default filter really is hiding the ended events").toBe(2);
    expect(skeletons, `reserved ${skeletons} cards for ${cards} that rendered`).toBe(cards);

    // …and at the right SPAN, which is what decides how many ROWS are reserved.
    const spans = await page.evaluate(() =>
      [...document.querySelectorAll("#comp-grid .comp-card")].map((c) =>
        (c.className.match(/bento-span-\d+/) || ["-"])[0]));
    expect(new Set(spans).size, "the fixture's live cards share one span").toBe(1);

    // ── ONLY AN EMPTY GRID GETS THEM, and this is not defensive tidiness: this
    // function is also the 15-second poll's body. Without the emptiness guard the
    // poll would blank a populated grid back to skeletons every tick — a visible
    // strobe and a fresh shift each time, which is the v7.23.5 "whoever writes
    // skeletons owns clearing them" defect inverted.
    //
    // Driven by calling the loader again rather than by waiting out a real 15 s
    // tick: same code path, deterministic, and it does not add 15 s to the file.
    await page.evaluate(() => { window.loadMyCompetitions(); });
    expect(await page.locator("#comp-grid .skeleton-comp-card").count(),
      "a re-load over a populated grid must not repaint skeletons").toBe(0);
    expect(await page.locator("#comp-grid .comp-card").count(),
      "and the cards are still there").toBe(cards);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CHALLENGES PAGE RESERVES THE TWO LINES IT ALWAYS FILLS.
//
// "N/M solved" (#tasks-subtitle) and the grid's count (#task-grid-count) shipped
// empty and were written in ONE run once /api/tasks answered, so everything below
// them moved as they landed. MEASURED on 9.2.12, unthrottled, the same in both
// looks: one shift entry naming #task-grid, #solve-filters, #diff-filters, the
// search box and #tasks-meter — 0.0225 at 1280 px (the filters +29 px, the grid
// +50 px) and 0.0404 at 390 px. With one line reserved for each, that entry is
// gone (1280 px: 0.0307 -> 0.0059 Signature, 0.0308 -> 0.0084 Ambient).
//
// /api/tasks is HELD, so the pre-data state is on screen for certain rather than
// raced; the geometry is the deterministic arm and the observer the CLS view of
// the same moment. #presence-note and #cert-cta are deliberately NOT reserved
// (their showing depends on the event and the person; v6.10.55 measured
// over-reserving as worse): while hidden they have no box at all.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("the Challenges page reserves its always-filled lines", () => {
  const { makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
  let fx;
  test.beforeAll(async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      // Four challenges and a second, idle participant: nothing can end the event
      // under the test (fixture checklist item 1); one event, so sign-in lands on it.
      const comp = await makeCompetition(sa, csrf, "clsr", { duration_minutes: 600 });
      for (let i = 0; i < 4; i++) {
        const t = await makeTask(sa, csrf, `clsr-${i}`, { difficulty: ["easy", "medium", "hard"][i % 3] });
        await assignTask(sa, csrf, t.id, [comp.id]);
      }
      const p = await makeParticipant(sa, csrf, "clsr");
      const idle = await makeParticipant(sa, csrf, "clsr-idle");
      await enrol(sa, csrf, comp.id, [p.id, idle.id]);
      fx = { comp, p };
    } finally { await sa.dispose(); }
  });

  const BELOW = ["#solve-filters", "#diff-filters", "#tasks-page>.participant-search-wrap", "#task-grid-count", "#task-grid"];
  const where = (page) => page.evaluate((below) => {
    const top = (s) => { const e = document.querySelector(s); return e ? Math.round((e.getBoundingClientRect().top + window.scrollY) * 10) / 10 : null; };
    const boxes = (s) => document.querySelector(s).getClientRects().length;
    return { tops: Object.fromEntries(below.map((s) => [s, top(s)])),
      subtitle: document.getElementById("tasks-subtitle").textContent.trim(),
      count: document.getElementById("task-grid-count").textContent.trim(),
      presenceBoxes: boxes("#presence-note"), certBoxes: boxes("#cert-cta") };
  }, BELOW);

  for (const [look, width] of [["ambient", 1280], ["signature", 1280], ["ambient", 390]]) {
    test(`nothing below the head moves when the challenges land (${look}, ${width} px)`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 800 });
      await signIn(page, fx.p.email);
      await page.addInitScript((l) => {
        try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", "light"); } catch (_) {}
        window._clsSrc = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            window._clsSrc.push({ t: e.startTime, v: +e.value.toFixed(4), nodes: (e.sources || []).map((s) => {
              const n = s.node; if (!n) return "(detached)";
              return n.id ? "#" + n.id : (n.tagName || "?") + "." + String(n.className || "").split(" ")[0];
            }) });
          }
        }).observe({ type: "layout-shift", buffered: true });
      }, look);
      let release, asked = false;
      const held = new Promise((r) => { release = r; });
      await page.route("**/api/tasks", async (route) => { asked = true; await held; await route.continue(); });
      try {
        await page.goto(`${BASE}/`);
        await expect(page.locator("#tasks-page.active #task-grid .skeleton-card").first(),
          "the Challenges page is up with its skeleton grid").toBeVisible({ timeout: 30000 });
        expect(asked, "PRECONDITION: /api/tasks has been asked for and is held").toBe(true);
        expect(await page.evaluate(() => document.documentElement.dataset.look), "PRECONDITION: the look").toBe(look);
        const before = await where(page);
        expect([before.subtitle, before.count], "PRECONDITION: neither line is filled yet").toEqual(["", ""]);
        expect([before.presenceBoxes, before.certBoxes], "the conditional lines reserve nothing while hidden").toEqual([0, 0]);
        const releasedAt = await page.evaluate(() => performance.now());
        release();
        await expect(page.locator("#task-grid .task-card").first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator("#tasks-subtitle")).toHaveText(/^\d+\/\d+ solved$/);
        await expect(page.locator("#task-grid-count")).toHaveText(/\d+ (of \d+ )?challenges?/);
        const after = await where(page);
        const moved = BELOW.filter((s) => Math.abs(after.tops[s] - before.tops[s]) > 1)
          .map((s) => `${s} ${before.tops[s]} -> ${after.tops[s]}`);
        expect(moved, `the lines below the head moved when the data landed: ${moved.join("; ")}`).toEqual([]);
        // The observer's view of the same moment.
        const shifts = await page.evaluate((t0) => window._clsSrc.filter((s) => s.t >= t0), releasedAt);
        const below = shifts.filter((s) => s.nodes.some((n) => /^#(solve-filters|diff-filters|task-grid|task-grid-count|tasks-meter)$|^DIV\.search-wrap$/.test(n)));
        expect(below, `layout shifts after /api/tasks answered: ${JSON.stringify(shifts)}`).toEqual([]);
      } finally {
        release();
        await page.unroute("**/api/tasks");
      }
    });
  }
});
