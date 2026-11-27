// @ts-check
//
// v8.13.3 — a withheld registration link is SAID to be withheld.
//
// POST /api/admin/invitations withholds an invitation's registration link from
// an event admin when the invitation also covers events or groups they do not
// manage, answering `{email, link:null, linkWithheld:true}` in
// `undeliveredInvites` (the server half is in admin-sentinels-v8133). The invite
// dialog ignored the flag and fell to the link-less SMTP copy — "the email could
// not be delivered (retry or check SMTP)" — which reads as "there is no link" and
// sends an organiser to a relay they cannot fix: a control withheld without its
// reason (the v7.14.2 rule).
//
// Mocked, because the withholding needs a second organiser's invitation and an
// SMTP failure at once; what is under test is the DIALOG's rendering of a response
// shape the server already pins.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const { makeCompetition } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

let comp;
test.beforeAll(async () => {
  const sa = await apiLogin("superadmin");
  comp = await makeCompetition(sa.api, sa.csrf, "withheld");
  await sa.api.dispose();
});

function mockInvite(page, undelivered) {
  return page.route("**/api/admin/invitations", route => route.request().method() === "POST"
    ? route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true, invited: 2, assigned: 0, emailsSent: 0, resent: 0, errors: [], existingEmails: [], alreadyInvited: [], alreadyAssigned: [],
          undeliveredInvites: undelivered, unsubscribedInvites: [],
        }),
      })
    : route.continue());
}

async function sendInvite(page, emails) {
  await clickTab(page, "Participants");
  await page.locator("#invite-participants-btn").click();
  const overlay = page.locator("#invite-overlay");
  await expect(overlay, "the invite dialog opened").toBeVisible({ timeout: 15000 });
  await overlay.locator("#invite-emails").fill(emails.join("\n"));
  const cb = overlay.locator(`.invite-comp-cb[value="${comp.id}"]`);
  await expect(cb, "PRECONDITION: the event is offered in the dialog").toHaveCount(1);
  await cb.check();
  await overlay.locator("#invite-submit-btn").click();
  const result = page.locator("#invite-result");
  await expect(result, "the result is shown").toBeVisible({ timeout: 15000 });
  return result;
}

test("a withheld link says it is withheld — and the SMTP copy and a real link are unchanged (CONTROLS)", async ({ page }) => {
  await adminLogin(page);
  await mockInvite(page, [
    { email: "withheld@acme.com", link: null, linkWithheld: true },
    { email: "nolink@acme.com", link: null },
    { email: "haslink@acme.com", link: "http://localhost/register?invitation=abc" },
  ]);
  const result = await sendInvite(page, ["withheld@acme.com", "nolink@acme.com", "haslink@acme.com"]);
  const text = await result.innerText();
  const line = (email) => text.split("\n").find(l => l.includes(email)) || "";

  expect(line("withheld@acme.com"), "the withheld row names the reason").toContain(
    "Its registration link is not shown to you because this invitation also covers events or groups you do not manage");
  expect(line("withheld@acme.com"), "…and does not send the organiser to a relay they cannot fix").not.toContain("check SMTP");

  // CONTROL — a link that is merely absent keeps its SMTP copy, so the new sentence
  // is keyed on the flag rather than on `link: null`.
  expect(line("nolink@acme.com"), "an absent link keeps the SMTP copy").toContain("(retry or check SMTP)");
  expect(line("nolink@acme.com"), "…and is not reported as withheld").not.toContain("is not shown to you");

  // CONTROL — a real link is still handed over.
  await expect(result.locator('a[href="http://localhost/register?invitation=abc"]'), "a real link is still offered").toHaveCount(1);
});
