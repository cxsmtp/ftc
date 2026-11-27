"use strict";

// AN EVENT'S CERTIFICATES SECTION: the issued list's Re-send and the designer's
// state (public/js/features/certificate-wizard.js).
//   • Re-send is the route's own offer: with the congratulations email off it is
//     still offered (one email, on request); a role without certificates.send is
//     not offered it; a delivery cut by a restart reads in words, not as a token;
//   • the issued list names each holder as their certificate prints the name
//     (the row's `name`), never as first + last composed in the browser, and
//     each download is named after it in any script (张伟-certificate.pdf);
//   • the designer: a first save gives the way back at once; an unset frame
//     follows the medal and says so; the preview is drawn again when the design
//     it sits on changed; a Program opens on its completion certificate; a
//     refused medal-wording field gets focus on its own certificate; a save over
//     somebody else's newer save is refused and offers their version.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { adminLogin, loginViaApi, clickTab, awaitCompModel } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const STAMP = Date.now().toString(36);
const DAY = 86_400_000;

async function createEvent(api, csrf, data) {
  const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: { name: `Cert ${STAMP} ${Math.random().toString(36).slice(2, 7)}`, ...data } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).competition;
}

async function openCerts(page, ev) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n, { tab: "admin-event-certs-tab" }), { id: ev.id, n: ev.name });
  await expect(page.locator("#ws-certs-design")).toBeVisible({ timeout: 15000 });
}

// An ended event with the congratulations email OFF and one certificate per
// holder, each collected by its holder (the dispatcher issues nothing with the
// email off). Each of `names` ({firstName, lastName, …} or null) renames its
// holder before they collect it.
async function emailOffWithHolders(sa, csrf, names) {
  const ev = await createEvent(sa, csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
  const t = await makeTask(sa, csrf, "certrs", { correct_answer: "right" });
  const spare = await makeTask(sa, csrf, "certrsspare", { correct_answer: "right" });
  await assignTask(sa, csrf, t.id, [ev.id]);
  await assignTask(sa, csrf, spare.id, [ev.id]);
  const people = [];
  for (const name of names) {
    const p = await makeParticipant(sa, csrf, "certrsp");
    if (name) {
      const put = await sa.put(`/api/admin/participants/${p.id}`, { headers: H(csrf), data: name });
      expect(put.ok(), `rename: ${await put.text()}`).toBeTruthy();
    }
    people.push(p);
  }
  await enrol(sa, csrf, ev.id, people.map((p) => p.id));
  const off = await sa.put(`/api/admin/competitions/${ev.id}/certificate-config`, { headers: H(csrf), data: { config: { email: { enabled: false } } } });
  expect(off.ok(), await off.text()).toBeTruthy();
  const sessions = [];
  try {
    for (const p of people) {
      const s = await apiLogin(p.email, PARTICIPANT_PASS);
      sessions.push(s);
      expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: ev.id } })).ok()).toBeTruthy();
      const r = await s.api.post(`/api/tasks/${t.id}/submit`, { headers: H(s.csrf), data: { answer: "right", gradingHash: await gradingHashFor(s.api, t.id) } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }
    const e = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(csrf), data: {} });
    expect(e.ok(), await e.text()).toBeTruthy();
    for (const s of sessions) {
      const m = await s.api.post(`/api/competitions/${ev.id}/badge`, { headers: H(s.csrf), data: {} });
      expect(m.ok(), `the holder collects it: ${await m.text()}`).toBeTruthy();
    }
  } finally { for (const s of sessions) await s.api.dispose(); }
  return { ev, people };
}

// One holder: `name` ({firstName, lastName}) renames them before they collect it.
async function emailOffWithCertificate(sa, csrf, name = null) {
  const { ev, people } = await emailOffWithHolders(sa, csrf, [name]);
  return { ev, p: people[0] };
}

/** The /Title of a certificate PDF (what it names its holder by), from its UTF-16BE hex string. */
function pdfTitle(buf) {
  const hex = /\/Title <([0-9a-f]+)>/i.exec(buf.toString("latin1"));
  expect(hex, "the PDF carries a title").toBeTruthy();
  return Buffer.from(hex[1], "hex").swap16().toString("utf16le").replace(/^\uFEFF/, "");
}

test("Re-send is offered with the email off, never to a role without certificates.send; a cut delivery reads in words; the code column needs the lookup permission", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev, p, viewer;
  try {
    ({ ev, p } = await emailOffWithCertificate(sa.api, sa.csrf));
    const role = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `Certificate viewer ${STAMP}`, scope_mode: "all", permissions: ["panel.access", "events.view", "certificates.view"] } });
    expect(role.ok(), `create role: ${await role.text()}`).toBeTruthy();
    viewer = await makeParticipant(sa.api, sa.csrf, "certviewer");
    const pr = await sa.api.patch(`/api/admin/users/${viewer.id}/role`, { headers: H(sa.csrf), data: { role: (await role.json()).role.id } });
    expect(pr.ok(), `assign role: ${await pr.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }

  await adminLogin(page);
  await openCerts(page, ev);
  const issued = page.locator("#ws-certs-issued");
  await expect(issued.locator(".ic-note"), "PRECONDITION: the email is off").toContainText("Certificate emails are off");
  await expect(issued.locator(`[data-ic="resend"][data-user="${p.id}"]`), "Re-send works with the email off, so it is offered").toBeVisible({ timeout: 15000 });
  // The credential code beside its holder is for whoever may look a certificate
  // up by its code (sweep #403). CONTROL: the superadmin sees the Code column.
  await expect(issued.locator("thead th", { hasText: "Code" }), "CONTROL: the superadmin sees the Code column").toHaveCount(1);
  await expect(issued.locator(`tr:has([data-ic="pdf"][data-user="${p.id}"]) code.ic-code`), "…and the holder's code in it")
    .toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // A delivery a restart cut short: the server's `unknown`, in words.
  await page.route(`**/api/admin/competitions/${ev.id}/certificates`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    for (const c of d.certificates) c.emailStatus = { status: "unknown", lastError: null };
    await route.fulfill({ response: res, json: d });
  });
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await page.evaluate(() => window.wsTab("admin-event-certs-tab"));
  const mail = issued.locator('td[data-label="Email"]').first();
  await expect(mail).toHaveText("Delivery unknown — re-send to be sure", { timeout: 15000 });
  await page.unroute(`**/api/admin/competitions/${ev.id}/certificates`);

  // A role that may see the certificates but not send them: no Re-send.
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const vp = await ctx.newPage();
  try {
    await loginViaApi(vp, viewer.email, PARTICIPANT_PASS);
    await vp.goto("/");
    await expect(vp.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openCerts(vp, ev);
    await expect(vp.locator(`#ws-certs-issued [data-ic="pdf"][data-user="${p.id}"]`), "PRECONDITION: the list is drawn").toBeVisible({ timeout: 15000 });
    await expect(vp.locator('#ws-certs-issued [data-ic="resend"]'), "no Re-send its route refuses").toHaveCount(0);
    await expect(vp.locator("#ws-certs-issued thead th", { hasText: "Code" }), "no Code column without the lookup permission").toHaveCount(0);
    await expect(vp.locator("#ws-certs-issued code.ic-code"), "…and no code in any row").toHaveCount(0);
  } finally { await ctx.close(); }
});

// The Issued list names each holder as their certificate prints the name: the
// row's `name` (routes/badge.js `_heldName`, the rule the artwork reads), never
// first + last composed in the browser; and each download is named after it, in
// whatever script it is written (operator ruling, 14 Nov 2026). A Chinese name
// prints family name first (张伟), so the profile's own order ("伟 张") is
// nowhere on the list, and its file is 张伟-certificate.pdf; CONTROLS: an ASCII
// name is listed and named as it always was (jane-doe), an accented Latin one
// keeps its letters in the file name as every script does (josé-garcía), and a
// certificate that prints the nickname (no face draws Georgian) is named by the
// nickname. Each PDF's own title is the witness of the name it prints. What the
// row's `name` says is what the list, its buttons' names and the download's file
// name follow.
test("the issued list names each holder as the certificate prints the name, and so does each download", async ({ page }) => {
  test.setTimeout(120_000);
  const NICK = `nk${STAMP}ka`;
  const sa = await apiLogin("superadmin");
  let ev, zh, jane, ka, jose;
  try {
    ({ ev, people: [zh, jane, ka, jose] } = await emailOffWithHolders(sa.api, sa.csrf, [
      { firstName: "伟", lastName: "张" },
      { firstName: "Jane", lastName: "Doe" },
      { firstName: "გიორგი", lastName: "ბერიძე", nickname: NICK },
      { firstName: "José", lastName: "García" },
    ]));
  } finally { await sa.api.dispose(); }

  await adminLogin(page);
  await openCerts(page, ev);
  const issued = page.locator("#ws-certs-issued");
  const rowOf = (p) => issued.locator("tr", { has: page.locator(`[data-ic="pdf"][data-user="${p.id}"]`) });
  const fs = require("fs");
  for (const [p, name, file] of [[zh, "张伟", "张伟-certificate"], [jane, "Jane Doe", "jane-doe-certificate"], [ka, NICK, `${NICK}-certificate`],
    [jose, "José García", "josé-garcía-certificate"]]) {
    await expect(rowOf(p).locator("td.ic-lead b"), `${name}: the Holder column`).toHaveText(name, { timeout: 15000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), rowOf(p).locator('[data-ic="pdf"]').click()]);
    expect(dl.suggestedFilename(), `${name}: the PDF's file name`).toBe(`${file}.pdf`);
    expect(pdfTitle(fs.readFileSync(await dl.path())).split(" — ").slice(1), `${name}: the event and the name the PDF prints`)
      .toEqual([ev.name, name]);
  }
  const [png] = await Promise.all([page.waitForEvent("download"), rowOf(zh).locator('[data-ic="png"]').click()]);
  expect(png.suggestedFilename(), "the share image is named after the printed name too").toBe("张伟-certificate.png");
  const pdf = issued.locator(`[data-ic="pdf"][data-user="${zh.id}"]`);
  await expect(pdf).toHaveAttribute("aria-label", "PDF certificate of 张伟");
  await expect(issued.locator(`[data-ic="png"][data-user="${zh.id}"]`)).toHaveAttribute("aria-label", "PNG image of 张伟's certificate");
  await expect(issued, "the profile's own order is nowhere on the list").not.toContainText("伟 张");
  await expect(issued, "nor the name the nickname certificate does not print").not.toContainText("გიორგი");

  // The row's `name` is the source: a probe in it is what the list names, and
  // what the downloaded certificate is called.
  const holder = rowOf(zh).locator("td.ic-lead b");
  await page.route(`**/api/admin/competitions/${ev.id}/certificates`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    for (const c of d.certificates) c.name = "Probe Listed-Name";
    await route.fulfill({ response: res, json: d });
  });
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await page.evaluate(() => window.wsTab("admin-event-certs-tab"));
  await expect(holder).toHaveText("Probe Listed-Name", { timeout: 15000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), pdf.click()]);
  expect(dl.suggestedFilename()).toBe("probe-listed-name-certificate.pdf");
  await page.unroute(`**/api/admin/competitions/${ev.id}/certificates`);
});

test("the designer: the way back after a first save, an unset frame follows the medal, a Program opens on completion", async ({ page }) => {
  const sa = await apiLogin("superadmin");
  let ev, prog;
  try {
    ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 });
    prog = await createEvent(sa.api, sa.csrf, { event_kind: "program", start_time: new Date(Date.now() - 60_000).toISOString(), deadline_at: new Date(Date.now() + 30 * DAY).toISOString() });
  } finally { await sa.api.dispose(); }
  await adminLogin(page);
  await openCerts(page, ev);
  const box = page.locator("#ws-certs-design");
  await expect(box.locator('.cw-tier[data-tier="gold"]'), "CONTROL: a Competition opens on its gold certificate").toHaveAttribute("aria-pressed", "true", { timeout: 15000 });

  // The frame, unset, follows the medal's metal and says so.
  await box.locator('[data-cw-panel="colors"]').click();
  const frame = box.locator('.cw-colour:has(input[data-key="frame"])');
  await expect(frame).toHaveAttribute("data-follows", "medal");
  await expect(frame.locator("code")).toHaveText("Follows the medal");
  const gold = (await box.locator('input[data-sec="colors"][data-key="gold"]').inputValue()).toLowerCase();
  expect(await frame.locator("input").inputValue(), "the swatch is the gold metal, not black").toBe(gold);
  expect(gold).not.toBe("#000000");

  // A first save gives this event its own design, and the way back appears at once.
  await expect(box.locator('[data-cw="reset"]'), "CONTROL: nothing to go back from yet").toHaveCount(0);
  await frame.locator("input").fill("#123456");
  await expect(frame, "a chosen frame no longer follows the medal").not.toHaveAttribute("data-follows", "medal");
  await expect(frame.locator("code")).toHaveText("#123456");
  await box.locator('[data-cw="save"]').click();
  await expect(page.locator(".toast").filter({ hasText: "Certificate design saved." })).toBeVisible({ timeout: 10000 });
  await expect(box.locator('[data-cw="reset"]'), "Use the platform design, without reopening").toHaveText("Use the platform design");

  // A Program certifies completion: its designer opens on that certificate.
  await openCerts(page, prog);
  await expect(box.locator('.cw-tier[data-tier="completion"]')).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
});

test("the preview is drawn again when the platform design under it changed, and only then", async ({ page }) => {
  const sa = await apiLogin("superadmin");
  let ev;
  try { ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 }); }
  finally { await sa.api.dispose(); }
  await adminLogin(page);
  let previews = 0;
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/admin\/certificate-config\/preview$/.test(r.url())) previews++; });
  await openCerts(page, ev);
  await expect(page.locator("#ws-certs-design #cw-img")).toBeVisible({ timeout: 20000 });
  const first = previews;
  expect(first, "PRECONDITION: the preview was rendered").toBeGreaterThan(0);
  // CONTROL: reopened with nothing changed, the cached picture is used.
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await openCerts(page, ev);
  await expect(page.locator("#ws-certs-design #cw-img")).toBeVisible({ timeout: 20000 });
  expect(previews, "nothing changed: no new render").toBe(first);
  // Another administrator changes the platform design this event inherits.
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const put = await page.request.put("/api/admin/certificate-config", { headers: H(csrf), data: { config: { text: { title: `Retitled ${STAMP}` } } } });
  expect(put.ok(), await put.text()).toBeTruthy();
  try {
    await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
    await openCerts(page, ev);
    await expect.poll(() => previews, { timeout: 15000, message: "the design under it changed: rendered again" }).toBeGreaterThan(first);
  } finally {
    expect((await page.request.delete("/api/admin/certificate-config", { headers: H(csrf) })).ok(), "the platform design is restored").toBeTruthy();
  }
});

test("a refused medal-wording field gets focus on its own certificate; a save over a newer one offers their version", async ({ page }) => {
  const sa = await apiLogin("superadmin");
  let ev;
  try { ev = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() + DAY).toISOString(), duration_minutes: 60 }); }
  finally { await sa.api.dispose(); }
  await adminLogin(page);
  await openCerts(page, ev);
  const box = page.locator("#ws-certs-design");
  // Silver's headline gets a placeholder that does not exist; the editor moves on to Gold.
  await box.locator('.cw-tier[data-tier="silver"]').click();
  const silverHead = box.locator('input[data-sec="labels"][data-key="silver"][data-sub="headline"]');
  await silverHead.fill("Second {nope}");
  await box.locator('.cw-tier[data-tier="gold"]').click();
  await expect(silverHead, "PRECONDITION: Gold's wording is on screen").toHaveCount(0);
  await box.locator('[data-cw="save"]').click();
  await expect(page.locator(".toast").filter({ hasText: "{nope}" })).toBeVisible({ timeout: 10000 });
  await expect(box.locator('.cw-tier[data-tier="silver"]'), "the refused field's certificate is shown").toHaveAttribute("aria-pressed", "true");
  await expect(silverHead, "and the field has focus").toBeFocused();
  await silverHead.fill("Second place");

  // Another administrator saves this event's design after it was opened here.
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const cur = await (await page.request.get(`/api/admin/competitions/${ev.id}/certificate-config`)).json();
  const theirs = await page.request.put(`/api/admin/competitions/${ev.id}/certificate-config`, { headers: H(csrf), data: { config: { text: { title: `Theirs ${STAMP}` } }, expectedVersion: cur.version } });
  expect(theirs.ok(), await theirs.text()).toBeTruthy();
  await box.locator('[data-cw="save"]').click();
  const modal = page.locator("#modal-overlay.open");
  await expect(modal, "the save is refused, with a choice").toBeVisible({ timeout: 10000 });
  await expect(page.locator("#modal-title")).toHaveText("This design was changed");
  const stored = await (await page.request.get(`/api/admin/competitions/${ev.id}/certificate-config`)).json();
  expect(stored.effective.text.title, "their change is still stored").toBe(`Theirs ${STAMP}`);
  expect(stored.effective.labels.silver.headline, "ours was not stored over it").not.toBe("Second place");
  await page.locator("#modal-confirm-btn").click();   // Load their version
  await box.locator('[data-cw-panel="text"]').click();
  await expect(box.locator("#cw-t-title"), "their version is loaded").toHaveValue(`Theirs ${STAMP}`, { timeout: 15000 });
  // CONTROL: from their version, a save goes through.
  await box.locator("#cw-t-title").fill(`Ours ${STAMP}`);
  await box.locator('[data-cw="save"]').click();
  await expect(page.locator(".toast").filter({ hasText: "Certificate design saved." })).toBeVisible({ timeout: 10000 });
});

// REVOKE and ISSUE AGAIN on the Issued list (operator ruling, 17 Nov 2026): a
// superadmin revokes a certificate there and issues it again from the event's
// current results (a new code; the revoked row stays, without the button); a
// role that may only look at certificates is offered neither, shown the same
// list at the same moment.
test("Revoke and Issue again: a superadmin's list offers both, a role without the permission neither", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev, p, viewer;
  try {
    ({ ev, p } = await emailOffWithCertificate(sa.api, sa.csrf));
    const role = await sa.api.post("/api/admin/roles", { headers: H(sa.csrf), data: { label: `Certificate looker ${STAMP}`, scope_mode: "all", permissions: ["panel.access", "events.view", "certificates.view"] } });
    expect(role.ok(), `create role: ${await role.text()}`).toBeTruthy();
    viewer = await makeParticipant(sa.api, sa.csrf, "certlooker");
    const pr = await sa.api.patch(`/api/admin/users/${viewer.id}/role`, { headers: H(sa.csrf), data: { role: (await role.json()).role.id } });
    expect(pr.ok(), `assign role: ${await pr.text()}`).toBeTruthy();
  } finally { await sa.api.dispose(); }

  await adminLogin(page);
  await openCerts(page, ev);
  const issued = page.locator("#ws-certs-issued");
  const revokeBtn = issued.locator(`[data-ic="revoke"][data-user="${p.id}"]`);
  await expect(revokeBtn, "a live certificate offers Revoke").toBeVisible({ timeout: 15000 });
  await expect(revokeBtn).toHaveAttribute("aria-label", /^Revoke /);
  const codeBefore = (await issued.locator(".ic-code").first().innerText()).trim();
  await revokeBtn.click();
  await page.locator("#prompt-input").fill("the placing moved");
  await page.locator("#prompt-ok").click();
  await expect(issued.locator(".ic-revoked"), "the row reads Revoked").toBeVisible({ timeout: 15000 });
  const again = issued.locator(`[data-ic="reissue"][data-user="${p.id}"]`);
  await expect(again, "…and offers Issue again").toBeVisible();

  // The looker, at the same moment: the same rows, neither button.
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const vp = await ctx.newPage();
  try {
    await loginViaApi(vp, viewer.email, PARTICIPANT_PASS);
    await vp.goto("/");
    await expect(vp.locator("#admin-page")).toBeVisible({ timeout: 20000 });
    await openCerts(vp, ev);
    await expect(vp.locator("#ws-certs-issued .ic-revoked"), "PRECONDITION: the revoked row is drawn").toBeVisible({ timeout: 15000 });
    await expect(vp.locator('#ws-certs-issued [data-ic="reissue"], #ws-certs-issued [data-ic="revoke"]'), "neither door its routes refuse").toHaveCount(0);
  } finally { await ctx.close(); }

  await again.click();
  await expect(page.locator("#modal-confirm-btn")).toHaveText("Issue again");
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator(".toast").filter({ hasText: "New certificate issued" })).toBeVisible({ timeout: 15000 });
  const pdf = issued.locator(`[data-ic="pdf"][data-user="${p.id}"]`);
  await expect(pdf, "a live certificate again").toBeVisible({ timeout: 15000 });
  await expect(issued.locator('[data-ic="reissue"]'), "the revoked row no longer offers it").toHaveCount(0);
  await expect(issued.locator(".ic-revoked"), "the revoked one stays listed").toHaveCount(1);
  const codes = (await issued.locator(".ic-code").allInnerTexts()).map(t => t.trim());
  expect(codes, "a new code beside the revoked one").toContain(codeBefore);
  expect(new Set(codes).size, "two different codes").toBe(2);
});

// A REVIVE LEAVES ISSUED CERTIFICATES AS ISSUED, and the save's confirm says so
// (operator ruling, 17 Nov 2026), from the admin list's `certificates_issued`;
// CONTROLS: an event with none says nothing of certificates, and a save that
// moves nothing revives nothing, so it says nothing either. The assign dialog's
// revival warning carries the same sentence (`_getAssignRevivalHints`), never for
// a Program (a completion certificate) or with none issued.
test("the revive confirm says issued certificates stay as issued", async ({ page }) => {
  test.setTimeout(90_000);
  const sa = await apiLogin("superadmin");
  let ev, bare;
  try {
    ({ ev } = await emailOffWithCertificate(sa.api, sa.csrf));
    bare = await createEvent(sa.api, sa.csrf, { event_kind: "tournament", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 });
    const e = await sa.api.post(`/api/admin/competitions/${bare.id}/end-now`, { headers: H(sa.csrf), data: {} });
    expect(e.ok(), await e.text()).toBeTruthy();
  } finally { await sa.api.dispose(); }

  await adminLogin(page);
  await clickTab(page, "Events");
  await awaitCompModel(page);
  const confirmText = async (compId, { extend }) => {
    await page.waitForFunction((id) => (window.S?.adminCompetitionsData || []).some(c => c.id === id), compId, { timeout: 20000 });
    await page.evaluate((id) => window.editCompetition(id), compId);
    await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
    if (extend) {
      const h = page.locator("#comp-dur-h");
      await h.fill(String((parseInt(await h.inputValue(), 10) || 0) + 1));
      await h.dispatchEvent("change");
    }
    await page.locator('[data-action="comp-save"]').click();
    const modal = page.locator("#modal-overlay");
    await expect(modal).toBeVisible({ timeout: 10000 });
    const text = await page.locator("#modal-body").innerText();
    await modal.locator("#modal-cancel-btn").click();
    await expect(modal).toBeHidden({ timeout: 10000 });
    const overlay = page.locator("#comp-form-overlay");
    for (let i = 0; i < 5 && (await overlay.count()) > 0; i++) {
      await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(50);
    }
    await expect(overlay).toHaveCount(0, { timeout: 10000 });
    return text;
  };
  const SAYS = "has already issued 1 certificate";
  const revived = await confirmText(ev.id, { extend: true });
  expect(revived).toContain("will become live again");
  expect(revived).toContain(SAYS);
  expect(revived).toContain("issue it again from the new results");
  const none = await confirmText(bare.id, { extend: true });
  expect(none, "CONTROL: the revival is still named").toContain("will become live again");
  expect(none, "…with nothing about certificates when none were issued").not.toContain("already issued");
  const still = await confirmText(ev.id, { extend: false });
  expect(still, "CONTROL: a save that moves nothing revives nothing").not.toContain(SAYS);

  const hints = await page.evaluate(() => {
    const base = { name: "Synthetic", start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240,
      ended_at: new Date(Date.now() - 60_000).toISOString(), ended_manually: 0, timeslots: [] };
    const h = (extra) => window._getAssignRevivalHints({ ...base, ...extra }) || "";
    return { two: h({ certificates_issued: 2, policy: { certificate: "attempt" } }), zero: h({ certificates_issued: 0 }),
      program: h({ certificates_issued: 3, policy: { certificate: "completion" } }) };
  });
  expect(hints.two, "PRECONDITION: the assign warning is drawn").toContain("Revival warning");
  expect(hints.two).toContain("has already issued 2 certificates");
  expect(hints.zero, "PRECONDITION").toContain("Revival warning");
  expect(hints.zero).not.toContain("already issued");
  expect(hints.program, "a Program's completion certificates are not about the board").not.toContain("already issued");
});

