// SWEEP #501 ON SCREEN (operator rulings, 23 Nov 2026).
//
// 1. While "Require account approval" is on, a role that may add people but not
//    approve accounts cannot sign anyone up at the desk: the People button says
//    why on hover and on the press (no prompt opens), the event workspace's ⋯
//    menu holds the reason instead of the item, and the command palette leaves
//    the action out. CONTROL: with approval off the same role gets the prompt.
// 2. "The organisers should see who's waiting FOR THEIR EVENTS ONLY": someone
//    who signed up through such a role's invitation waits, in no event; People
//    shows them to that event's organiser, naming the event, in the event's own
//    roster too, with a menu that says who approves and offers nothing else: no
//    row button, selection box or tag and group control. CONTROL: another
//    event's organiser is not shown them, read once their own member is listed.
const { test, expect } = require("./isolated-test");
const { loginViaApi, narrowPeopleTable, openKebab, viewComp, clickTab } = require("./ui-admin-helpers");
const { apiLogin, freshCtx, BASE } = require("./helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const REASON = "New accounts wait for approval on this platform, and your role cannot approve them";
const DESK_TITLE = "Create an account and show a sign-in code, with no email";   // the button's own tooltip (public/index.html)

test.describe("sweep #501 — what a role that cannot approve sees while approval is on", () => {
  let sa, saCsrf, comp, other, org, orgOther, waiting, otherMember, coOrganiser, compMember;

  const setApproval = async (on) => {
    const r = await sa.patch("/api/admin/settings", { headers: H(saCsrf), data: { require_account_approval: on } });
    expect(r.ok(), await r.text()).toBeTruthy();
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "eoui");
    other = await makeCompetition(sa, saCsrf, "eouix");
    const rr = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `EO UI ${Date.now()}`, scope_mode: "granted", permissions: ["events.view", "participants.view", "participants.enrol"] } });
    expect(rr.ok(), await rr.text()).toBeTruthy();
    const role = (await rr.json()).role;
    const asRole = async (label, ev) => {
      const u = await makeParticipant(sa, saCsrf, label);
      expect((await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: role.id } })).ok()).toBeTruthy();
      await grantEventAdmin(sa, saCsrf, ev.id, u.id);
      return u;
    };
    org = await asRole("eouiorg", comp);
    orgOther = await asRole("eouiorgx", other);
    // The other event's own member: its organiser's list is read once it holds them.
    otherMember = await makeParticipant(sa, saCsrf, "eouimember");
    await enrol(sa, saCsrf, other.id, [otherMember.id]);
    // A built-in event admin of the invited event, who may tag, group, select and
    // approve the event's members, and a member of it (the positive control).
    coOrganiser = await makeParticipant(sa, saCsrf, "eouico");
    await grantEventAdmin(sa, saCsrf, comp.id, coOrganiser.id);
    compMember = await makeParticipant(sa, saCsrf, "eouicompmember");
    await enrol(sa, saCsrf, comp.id, [compMember.id]);
    // A waiting invitee: invited by the organiser while approval is on.
    waiting = `eoui-wait-${Date.now()}@enrol-only.example`;
    const s = await apiLogin(org.email);
    try {
      const inv = await s.api.post("/api/admin/invitations", { headers: H(s.csrf), data: { emails: [waiting], competitionIds: [comp.id] } });
      expect(inv.ok(), await inv.text()).toBeTruthy();
    } finally { await s.api.dispose(); }
    await setApproval(true);
    try {
      const { api, csrf } = await freshCtx();
      try {
        await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
        await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: waiting } });
        const c = await (await api.get("/api/test/last-login-code?email=" + encodeURIComponent(waiting))).json();
        await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email: waiting, code: c.code } });
        const t = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        const r = await api.post("/api/register", { headers: H(t), data: { firstName: "Wanda", lastName: "Waiting", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London", email: waiting } });
        expect((await r.json()).pendingApproval, "PRECONDITION: the invitee waits").toBe(true);
      } finally { await api.dispose(); }
    } finally { await setApproval(false); }
  });

  test("the desk sign-up says why it is withheld, on the People button, in the workspace's Invite menu and in the palette; with approval off it opens (CONTROL)", async ({ page }) => {
    await setApproval(true);
    try {
      await loginViaApi(page, org.email);
      await page.goto("/");
      await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
      await page.locator('button.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
      const btn = page.locator("#desk-invite-btn");
      await expect(btn).toBeVisible({ timeout: 15000 });
      await expect(btn).toHaveAttribute("title", new RegExp(REASON));
      await btn.click();
      await expect(page.locator("#toast-stack"), "the press says why").toContainText(REASON);
      await expect(page.locator("#prompt-input"), "and asks for nothing").toHaveCount(0);
      // The palette leaves the action out (People and Invite are still there).
      await page.locator("#app-search-btn").click();
      const pal = page.locator("#command-palette-overlay");
      await expect(pal).toBeVisible();
      await pal.locator("input").fill("people");
      await expect(pal, "PRECONDITION: the palette lists the People actions").toContainText("Invite people");
      await pal.locator("input").fill("desk");
      await expect(pal.locator("input")).toHaveValue("desk");
      await expect(pal).not.toContainText("Sign up at the desk");
      await page.keyboard.press("Escape");
      // The event workspace's Invite menu holds the reason in the item's place
      // (the header's one control for adding people; owner's decision, 27 Nov
      // 2026), beside the email invitation.
      await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
      await viewComp(page, comp.name);
      await page.locator("#ws-quick .ws-invite-btn").click();
      const portal = page.locator("#kebab-portal");
      await expect(portal.locator('[data-action="ws-invite"]'), "PRECONDITION: the Invite menu is open").toBeVisible();
      await expect(portal.locator(".kebab-note")).toContainText(REASON);
      await expect(portal.locator('[data-action="desk-invite"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
    } finally { await setApproval(false); }
    // CONTROL: approval off, the same role is offered the desk sign-up in its
    // event's Invite menu (a role scoped to its events uses it from inside an
    // event), and the press opens the prompt.
    await page.reload();
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await page.locator('button.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
    await expect(page.locator("#desk-invite-btn")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#desk-invite-btn"), "its own tooltip").toHaveAttribute("title", DESK_TITLE);
    // The palette offers it, for the same words.
    await page.locator("#app-search-btn").click();
    const pal2 = page.locator("#command-palette-overlay");
    await expect(pal2).toBeVisible();
    await pal2.locator("input").fill("desk");
    await expect(pal2, "CONTROL: the palette offers it").toContainText("Sign up at the desk");
    await page.keyboard.press("Escape");
    await expect(pal2).toBeHidden();
    await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
    await viewComp(page, comp.name);
    await page.locator("#ws-quick .ws-invite-btn").click();
    const portal2 = page.locator("#kebab-portal");
    await expect(portal2.locator('[data-action="desk-invite"]'), "the item is offered").toBeVisible();
    await expect(portal2.locator(".kebab-note", { hasText: REASON })).toHaveCount(0);
    await portal2.locator('[data-action="desk-invite"]').click();
    await expect(page.locator("#prompt-input"), "the desk prompt opens").toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
  });

  test("a waiting invitee is shown to their event's organiser, naming it, in People and in the event's roster, with only the note in the menu; another event's organiser is not shown them (CONTROL)", async ({ page, browser }) => {
    await loginViaApi(page, org.email);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await page.locator('button.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
    await narrowPeopleTable(page, waiting);
    const row = page.locator("#admin-participants-body tr", { hasText: waiting });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".p-waiting-for")).toHaveText(`Invited to “${comp.name}”: waiting for an administrator's approval`);

    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator(".kebab-note")).toContainText("Waiting for an administrator's approval");
    await expect(portal.locator('[data-action="participant-edit-profile"], [data-action="participant-approve"], [data-action="participant-history"]'), "nothing else is offered").toHaveCount(0);
    await page.keyboard.press("Escape");
    // The event's own roster holds them too.
    await page.locator('button.admin-nav-item[data-tab-id="admin-competitions-tab"]').click();
    await viewComp(page, comp.name);
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, waiting);
    await expect(page.locator("#admin-participants-body tr", { hasText: waiting }), "in the event's roster").toHaveCount(1);

    const ctx2 = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx2.newPage();
      await loginViaApi(p2, orgOther.email);
      await p2.goto("/");
      await expect(p2.locator("#admin-page")).toBeVisible({ timeout: 20000 });
      await p2.locator('button.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
      // Read in ONE snapshot, once it holds their own event's member.
      await expect.poll(() => p2.evaluate(([k, w]) => {
        const d = window.adminParticipantsData || [];
        if (!d.some((p) => p.id === k)) return "not loaded yet";
        return d.some((p) => p.email === w) ? "listed" : "not listed";
      }, [otherMember.id, waiting]), { timeout: 15000, message: "CONTROL: another event's organiser is not given them" }).toBe("not listed");
    } finally { await ctx2.close(); }
  });

  test("a waiting invitee's row offers an organiser who may tag, group, select and approve none of it: the View button and the note alone (CONTROL: the event's own member's row offers them)", async ({ page }) => {
    await loginViaApi(page, coOrganiser.email);
    await page.goto("/");
    await expect(page.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await page.locator('button.admin-nav-item[data-tab-id="admin-participants-tab"]').click();
    const ROW_CONTROLS = '[data-action="participant-tag-add"], [data-action="participant-group-add"]';
    // CONTROL first: the event's member, for the same viewer.
    await narrowPeopleTable(page, compMember.email);
    const member = page.locator("#admin-participants-body tr", { hasText: compMember.email });
    await expect(member).toHaveCount(1);
    await expect(member.locator('.cb-cell input[type="checkbox"]'), "CONTROL: a member's row has its selection box").toHaveCount(1);
    await expect(member.locator(ROW_CONTROLS), "CONTROL: and its tag and group controls").toHaveCount(2);
    await narrowPeopleTable(page, waiting);
    const row = page.locator("#admin-participants-body tr", { hasText: waiting });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".p-waiting-for"), "PRECONDITION: the waiting row").toContainText("waiting for an administrator's approval");
    await expect(row.locator('.action-cell [data-action="participant-view-profile"]'), "PRECONDITION: its actions rendered").toHaveCount(1);
    await expect(row.locator('.action-cell [data-action]:not([data-action="participant-view-profile"])'), "no row button (Approve included)").toHaveCount(0);
    await expect(row.locator('.cb-cell input[type="checkbox"]'), "no selection box, so neither the bar's Approve nor Select all reaches it").toHaveCount(0);
    await expect(row.locator(ROW_CONTROLS), "no tag or group control").toHaveCount(0);
    await expect(row.locator(".chip-note"), "and no note about an admin account").toHaveCount(0);
  });
});
