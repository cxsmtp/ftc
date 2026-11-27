// @ts-check
// Audit rerun fixes — accessibility (CTF-0003), the group Members dialog.
//   #1  the dialog is exposed as role=dialog + aria-modal + accessible name
//   #1  ARIA survives the card-replacing re-render
//   #11 keyboard focus is retained across a re-render
const { test, expect } = require("./isolated-test");
const { apiLogin, getSuperadminPass, BASE } = require("./helpers");

test.use({ baseURL: BASE });
const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test("#1/#11: group Members dialog is a labelled modal that keeps ARIA + focus across re-renders", async ({ page }) => {
  // A group with one member (created in one call via userIds).
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const aliceId = (await (await api.get("/api/admin/participants?limit=500")).json())
    .participants.find(p => p.email === "alice@acme.com").id;
  const gname = `A11yGrp-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const gr = await api.post("/api/admin/groups", { headers: H, data: { name: gname, userIds: [aliceId] } });
  const groupId = (await gr.json()).group.id;
  await api.dispose();

  // Open the Members dialog in the admin SPA (via the exported global, same as the live app's button).
  // audit v7.7.35 (T2) — re-read-and-retry-once so a global superadmin-password
  // rotation between the file read and the POST doesn't flake this one-shot login.
  const saLogin = async () => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return page.request.post("/api/login", { headers: h(csrfToken), data: { email: "superadmin", password: getSuperadminPass() } });
  };
  let lr = await saLogin();
  if (!lr.ok()) lr = await saLogin();
  expect(lr.ok()).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
  await page.evaluate(([gid, gn]) => window.manageGroupMembers(gid, gn), [groupId, gname]);

  // #1 — the dialog card is announced as a modal dialog with an accessible name.
  const card = page.locator('.card[role="dialog"]');
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card).toHaveAttribute("aria-modal", "true");
  const labelledby = await card.getAttribute("aria-labelledby");
  expect(labelledby, "dialog has an accessible name").toBeTruthy();
  await expect(page.locator(`#${labelledby}`)).toContainText("Members");

  // Trigger a card-replacing re-render via the debounced search.
  await page.locator("#gm-search").click();
  await page.locator("#gm-search").fill("alice");
  await page.waitForTimeout(500); // debounce (200ms) + refetch + render

  // #1 on re-render — the new card still carries the dialog ARIA.
  const card2 = page.locator('.card[role="dialog"]');
  await expect(card2).toHaveAttribute("aria-modal", "true");
  await expect(card2).toHaveAttribute("aria-labelledby", /.+/);
  // #11 — keyboard focus stayed in the search box (didn't drop to <body>).
  await expect(page.locator("#gm-search")).toBeFocused();
});
