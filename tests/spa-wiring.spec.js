// @ts-check
//
// THE SPA'S WIRING, held by source scanners and by the one entry point that
// arrives from outside it:
//   • every action name a dispatcher attribute carries (data-action and its
//     change, input, enter, mouseenter and mouseleave siblings, in the shell or
//     in any module's markup) is registered with that dispatcher — a renamed
//     registration otherwise leaves a control that does nothing, and passes
//     every test that does not press it;
//   • every literal /api/ path the SPA asks is a route the server registers —
//     a renamed or removed route otherwise leaves a call that 404s;
//   • the persona-report email's deep link (/?event=<id>&section=<key>) never
//     lands on a section the link did not name.
// Dynamic names (built with ${…}) are not judged by the scanners; each carries a
// floor so a renamed symbol cannot leave it matching nothing.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { stripJsComments } = require("./doc-registry");
const { BASE, apiLogin, getSuperadminPass } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { makeCompetition } = require("./event-admin-helpers");

const ROOT = path.resolve(__dirname, "..");

function spaModules() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ROOT, "public/js"));
  return out;
}
const rel = (f) => path.relative(ROOT, f);

// ── action names ────────────────────────────────────────────────────────────
const ATTRS = ["action", "change-action", "input-action", "enter-action", "mouseenter-action", "mouseleave-action"];
const DATASET = { action: "action", changeAction: "change-action", inputAction: "input-action", enterAction: "enter-action", mouseenterAction: "mouseenter-action", mouseleaveAction: "mouseleave-action" };
// Which registry each attribute's dispatcher reads (core/main.js boot()).
const REGISTRY_OF = { "action": "action", "enter-action": "action", "mouseenter-action": "action", "mouseleave-action": "action", "change-action": "change", "input-action": "input" };

/** Registrations and literal uses in sources already stripped of comments. */
function actionScan(jsSources, html) {
  const reg = { action: new Set(), change: new Set(), input: new Set() };
  const uses = [];
  for (const { file, src } of jsSources) {
    for (const m of src.matchAll(/\bregister(Action|Change|Input)\(\s*(['"])([^'"]+)\2/g)) reg[m[1].toLowerCase()].add(m[3]);
    for (const m of src.matchAll(new RegExp(`data-(${ATTRS.join("|")})=(\\\\?["'])([^"'\\\\$]*?)\\2`, "g"))) uses.push({ file, attr: m[1], name: m[3] });
    for (const m of src.matchAll(/\bdataset\.(action|changeAction|inputAction|enterAction|mouseenterAction|mouseleaveAction)\s*=\s*(['"])([^'"]+)\2/g)) uses.push({ file, attr: DATASET[m[1]], name: m[3] });
  }
  for (const m of html.matchAll(new RegExp(`data-(${ATTRS.join("|")})="([^"]*)"`, "g"))) uses.push({ file: "public/index.html", attr: m[1], name: m[2] });
  const unregistered = uses.filter((u) => u.name && !reg[REGISTRY_OF[u.attr]].has(u.name));
  return { reg, uses, unregistered };
}

test.describe("the SPA's wiring — source scanners", () => {
  test("every action name in the shell and the modules is registered with its dispatcher", () => {
    const js = spaModules().map((f) => ({ file: rel(f), src: stripJsComments(fs.readFileSync(f, "utf8")) }));
    const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const { reg, uses, unregistered } = actionScan(js, html);
    // Floors: a renamed register* or attribute would otherwise match nothing.
    expect(reg.action.size, "registered actions").toBeGreaterThan(300);
    expect(reg.change.size, "registered change handlers").toBeGreaterThan(20);
    expect(reg.input.size, "registered input handlers").toBeGreaterThan(10);
    expect(uses.length, "literal action names read").toBeGreaterThan(600);
    expect(uses.filter((u) => u.file === "public/index.html").length, "the shell's own names are read").toBeGreaterThan(100);
    expect(unregistered.map((u) => `${u.file}: data-${u.attr}="${u.name}"`), "every literal action name has a handler").toEqual([]);

    // PLANTED CONTROLS: an unregistered name is caught in each form the scan reads,
    // and a change name registered only as an action is caught too.
    const planted = actionScan([
      { file: "planted.js", src: `registerAction('known',()=>{}); registerChange('picked',()=>{});
        const a = \`<button data-action="known">ok</button><button data-action="nobody-handles-this">x</button>\`;
        const b = "<select data-change-action=\\"known\\"></select>";
        el.dataset.action = 'also-unhandled';` },
    ], `<input data-input-action="picked">`);
    expect(planted.unregistered.map((u) => `${u.attr}:${u.name}`).sort())
      .toEqual(["action:also-unhandled", "action:nobody-handles-this", "change-action:known", "input-action:picked"]);
  });

  test("every literal /api/ path the SPA asks is a route the server registers", () => {
    const routes = [];
    const routeFiles = ["server.js", ...fs.readdirSync(path.join(ROOT, "routes")).filter((f) => f.endsWith(".js")).map((f) => `routes/${f}`)];
    for (const f of routeFiles) {
      const src = stripJsComments(fs.readFileSync(path.join(ROOT, f), "utf8"));
      for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete|all)\(\s*(["'`])(\/api\/[^"'`]+)\2/g)) routes.push(m[3]);
    }
    const routeRe = routes.map((p) => new RegExp("^" + p.replace(/[.+*?^$()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+") + "$", "i"));
    /** A client path: `${…}` is one segment, the query and fragment are dropped. */
    const routed = (raw) => {
      const p = raw.replace(/\$\{[^}]*\}/g, "X").split("?")[0].split("#")[0];
      // Ending in "/": the start of a path finished by concatenation.
      if (p.endsWith("/")) return routes.some((r) => r.replace(/:[A-Za-z_]+/g, "X").toLowerCase().startsWith(p.toLowerCase()) || r.toLowerCase().startsWith(p.toLowerCase()));
      return routeRe.some((re) => re.test(p));
    };
    const uses = [];
    for (const f of spaModules()) {
      const src = stripJsComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(/(["'`])(\/api\/(?:[^"'`\\]|\\.)*)\1/g)) uses.push({ file: rel(f), raw: m[2] });
    }
    expect(routes.length, "routes read").toBeGreaterThan(200);
    expect(uses.length, "SPA /api/ literals read").toBeGreaterThan(300);
    expect(uses.filter((u) => !routed(u.raw)).map((u) => `${u.file}: ${u.raw}`), "every SPA /api/ path has a route").toEqual([]);

    // PLANTED CONTROLS: a path no route answers, one with a renamed segment, and a
    // dangling prefix are caught; a parameter segment and a query still match.
    expect(routed("/api/admin/no-such-thing")).toBe(false);
    expect(routed("/api/admin/competitions/${id}/certificate")).toBe(false);
    expect(routed("/api/admin/nowhere/")).toBe(false);
    expect(routed("/api/admin/competitions/${encodeURIComponent(id)}/certificates?summary=1")).toBe(true);
  });
});

test.describe("the persona-report deep link", () => {
  test.use({ baseURL: BASE });

  // The fallback for a section the link does not know (the link's named sections
  // are each held where they render: the Event team section beside the report
  // that sends the link, the Overview and Certificates by the workspace's own
  // deep-link lock). Nothing here reads the workspace header, which the
  // workspace's lock holds.
  test("an unknown section in a report's link opens the event, never its Event team section, and leaves a plain address", async ({ page }) => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let comp;
    try { comp = await makeCompetition(sa, csrf, "deeplink"); } finally { await sa.dispose(); }
    await loginViaApi(page, "superadmin", getSuperadminPass());
    await page.goto(`/?event=${comp.id}&section=nonsense`);
    await expect.poll(() => page.evaluate(() => window.adminSelectedCompetitionId), { timeout: 20000, message: "the workspace opened on the linked event" }).toBe(comp.id);
    await expect(page.locator("#admin-event-team-tab"), "not on the Event team section").toBeHidden();
    await expect(page.locator('#ws-tabs [data-section="admin-event-team-tab"]')).not.toHaveAttribute("aria-current", "page");
    expect(new URL(page.url()).search, "the link's query is taken off the address").toBe("");
    // CONTROL: the same link naming the team section does open it, so the
    // witness above can see the section it says is absent.
    await page.goto(`/?event=${comp.id}&section=team`);
    await expect(page.locator("#admin-event-team-tab"), "on its Event team section").toBeVisible({ timeout: 15000 });
    expect(new URL(page.url()).search).toBe("");
  });
});
