// @ts-check
// Bulk "Assign to Events" (People → selection bar): Step 2 → Back returns to
// Step 1 as it was left. The group filter keeps its text, the list stays narrowed
// to it, and the group and event ticks stay ticked; before the fix Back re-drew
// Step 1 from scratch, dropping the filter text (and the event ticks), so the
// whole group list came back while the operator's query was gone.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin } = require("./helpers");
const { adminLogin, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

let sa, saCsrf, person, comp, stamp;
const alpha = [], beta = [];

test.describe("bulk assign: Back keeps Step 1 as it was left", () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    stamp = `${Date.now()}`.slice(-8);
    person = await makeParticipant(sa, saCsrf, "bkback");
    // Upcoming, so it takes new members and the wizard lists it.
    comp = await makeCompetition(sa, saCsrf, "bkback", { start_time: new Date(Date.now() + 86400e3).toISOString() });
    // Nine groups: the filter box is offered only past eight.
    const mk = async (name, into) => {
      const r = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name } });
      expect(r.ok(), `create group ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
      const d = await r.json();
      into.push({ id: String(d.id || (d.group && d.group.id)), name });
    };
    for (let i = 1; i <= 3; i++) await mk(`BkA${stamp} alpha ${i}`, alpha);
    for (let i = 1; i <= 6; i++) await mk(`BkB${stamp} beta ${i}`, beta);
  });
  test.afterAll(async () => { if (sa) await sa.dispose(); });

  test("Step 2 → Back keeps the filter text, the narrowed list and the ticks", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first().click();
    await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 15000 });
    await narrowPeopleTable(page, person.email);
    const cb = page.locator(`#admin-participants-body input[type="checkbox"][value="${person.id}"]`).first();
    await cb.waitFor({ state: "visible", timeout: 15000 });
    await cb.check();
    await page.locator("#selection-bar-assign-btn").click();
    const ov = page.locator("#bulk-assign-overlay");
    await expect(ov.locator("#bulk-assign-title")).toHaveText("Step 1: Select Events", { timeout: 15000 });

    const chip = (g) => ov.locator(`.bulk-group-pick[data-group-id="${g.id}"]`);
    const shownOurs = () => page.evaluate(({ ids }) => ids.filter((id) => {
      const el = document.querySelector(`#bulk-assign-overlay .bulk-group-pick[data-group-id="${id}"]`);
      return el && el.getClientRects().length > 0;
    }), { ids: [...alpha, ...beta].map((g) => g.id) });
    // PRECONDITION: with no filter every one of our groups shows.
    expect((await shownOurs()).sort()).toEqual([...alpha, ...beta].map((g) => g.id).sort());

    const filter = ov.locator("#bulk-group-filter");
    await expect(filter, "PRECONDITION: the filter is offered (more than eight groups)").toBeVisible();
    await filter.pressSequentially(`bka${stamp}`, { delay: 200 });
    await expect.poll(shownOurs, { message: "the filter narrows to the alpha groups" }).toEqual(alpha.map((g) => g.id));
    await chip(alpha[1]).click();
    await expect(chip(alpha[1])).toHaveAttribute("aria-pressed", "true");
    await ov.locator(`#bulk-comp-list input[type="checkbox"][value="${comp.id}"]`).check();

    await ov.locator('[data-action="bulk-assign-next"]').click();
    await expect(ov.locator("#bulk-assign-title")).toHaveText("Step 2: Confirm Assignment");
    await expect(ov.locator("#bulk-group-filter"), "Step 2 has no filter box").toHaveCount(0);
    await ov.locator('[data-action="bulk-assign-back"]').click();
    await expect(ov.locator("#bulk-assign-title")).toHaveText("Step 1: Select Events");

    await expect(ov.locator("#bulk-group-filter"), "the filter keeps its text").toHaveValue(`bka${stamp}`);
    expect(await shownOurs(), "only the matching groups show").toEqual(alpha.map((g) => g.id));
    await expect(chip(alpha[1]), "the group tick is kept").toHaveAttribute("aria-pressed", "true");
    await expect(chip(alpha[0]), "NEGATIVE: an unticked group stays unticked").toHaveAttribute("aria-pressed", "false");
    await expect(ov.locator(`#bulk-comp-list input[type="checkbox"][value="${comp.id}"]`), "the event tick is kept").toBeChecked();

    // The kept state is what is sent: Next again names the same group and event.
    await ov.locator('[data-action="bulk-assign-next"]').click();
    await expect(ov.locator(".bulk-assign-section-title", { hasText: "Groups bound (1)" })).toBeVisible();
    await expect(ov.locator(".bulk-assign-summary", { hasText: alpha[1].name })).toBeVisible();
    await expect(ov.locator(".bulk-assign-section-title", { hasText: "Events (1)" })).toBeVisible();
  });
});
