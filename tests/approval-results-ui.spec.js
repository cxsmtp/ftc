"use strict";

// WHAT AN ORGANISER IS TOLD WHEN AN APPROVAL WAS NOT THEIRS TO GIVE.
//
//   * The Invite dialog: an organiser's invitation approves a waiting account
//     only once it puts the account into one of their events (routes/
//     invitations.js; the server half is tests/invitation-approve-permission.
//     api.spec.js). One whose every enrolment was skipped is listed in the
//     answer's `leftPending`; the dialog says so in words and keeps the address
//     in the box, beside its reason, like every other address that did not go
//     through. Driven for real, end to end.
//   * The selection bar's Approve (bulk approve): the route skips and counts
//     each account a row's own Approve would refuse (an organiser's or an
//     administrator's, one outside the organiser's events, a rival), and the
//     result names each count with its reason. The route's answer is stubbed
//     here with every count set, so each sentence is checked; the counts
//     themselves are the API spec's.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, TEST_DB_PATH } = require("./helpers");
const { loginViaApi, clickTab, adminLogin } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const write = (q, ...a) => {
  const Database = require("better-sqlite3");
  const d = new Database(TEST_DB_PATH);
  try { return d.prepare(q).run(...a); } finally { d.close(); }
};

let org, waiting;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const A = await makeCompetition(sa, csrf, "apprres");
    org = await makeParticipant(sa, csrf, "apprresorg");
    await grantEventAdmin(sa, csrf, A.id, org.id);
    // A verified account waiting for approval, tagged staff: on an event where
    // staff do not compete its enrolment is skipped (a spectator gets no row).
    waiting = await makeParticipant(sa, csrf, "apprreswait");
    const t = await sa.post(`/api/admin/participants/${waiting.id}/tags`, { headers: H(csrf), data: { tag: "staff" } });
    expect(t.ok(), `staff tag: ${await t.text()}`).toBeTruthy();
    write("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id=?", waiting.id);
  } finally { await sa.dispose(); }
});

test("the Invite dialog says an account was left waiting for approval, and keeps its address in the box", async ({ page }) => {
  await loginViaApi(page, org.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await clickTab(page, "Participants");
  const btn = page.locator("#invite-participants-btn");
  await expect(btn).toBeVisible({ timeout: 15000 });
  await btn.click();
  const overlay = page.locator("#invite-overlay");
  await expect(overlay).toBeVisible({ timeout: 15000 });
  await expect(overlay.locator("input.invite-comp-cb:checked"), "PRECONDITION: the organiser's one event is ticked").toHaveCount(1);
  const box = overlay.locator("#invite-emails");
  await box.fill(waiting.email);
  const respP = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/admin/invitations", { timeout: 20000 });
  await overlay.locator("#invite-submit-btn").click();
  const body = await (await respP).json();
  expect(body.leftPending, "PRECONDITION: the server left the account waiting").toEqual([waiting.email.toLowerCase()]);
  await expect(page.locator("#toast-stack"), "the dialog says so, and why").toContainText("1 account(s) left waiting for approval — none of your events took them, so an administrator approves them", { timeout: 10000 });
  await expect(box, "the address stays in the box").toHaveValue(new RegExp(waiting.email.replace(/[.+]/g, "\\$&"), "i"));
  await expect(overlay.locator(".invite-result-detail"), "…and its own line says why")
    .toContainText(`${waiting.email.toLowerCase()} — left waiting for approval: none of your events took it, so an administrator approves it`);
});

test("the selection bar's Approve names each account it skipped and why", async ({ page }) => {
  await adminLogin(page);
  await clickTab(page, "Participants");
  // A pending row the handler will send (its selection set in the page: the
  // handler reads `S.selectedParticipants`, as the checkboxes leave it).
  await expect.poll(() => page.evaluate((id) => (window.S.adminParticipantsData || []).some(p => p.id === id), waiting.id),
    { timeout: 15000, message: "the waiting account is in the loaded list" }).toBe(true);
  await page.route("**/api/admin/participants/bulk-approve", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, approved: 0, emailFailures: 0, skipped: 0, skippedPrivileged: 1, skippedOutOfScope: 2, skippedRival: 3 }),
  }));
  await page.evaluate((id) => { window.S.selectedParticipants.clear(); window.S.selectedParticipants.add(id); window.bulkApproveUsers(); }, waiting.id);
  const confirm = page.locator("#modal-overlay");
  await expect(confirm).toBeVisible({ timeout: 10000 });
  await confirm.getByRole("button", { name: "Approve All" }).click();
  const toast = page.locator("#toast-stack");
  await expect(toast).toContainText("1 skipped — an organiser's or an administrator's account, which is not yours to approve.", { timeout: 10000 });
  await expect(toast).toContainText("2 skipped — not in any of your events.");
  await expect(toast).toContainText("3 skipped — you compete against them in an event.");
});
