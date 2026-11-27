"use strict";

// SWEEP #402 — A DOWNLOAD THROUGH THE CONGRATULATIONS EMAIL'S LINK MAY BE A MAIL
// SCANNER'S (operator ruling, 24 Nov 2026: record it, marked and labelled).
//
// The email links the certificate PDF (and attaches it). Mail scanners and link
// prefetchers fetch every link in a mail, signed out, exactly as the holder's own
// click from it arrives, and the PDF route records every fetch as a download. The
// mail's link carries `?from=email` (lib/certificate-dispatch.js), so the route
// records those fetches `via: "email_link"`, and the two places an organiser reads
// the record say what it may be:
//   * the event's History dialog (public/js/features/history.js formatEventChange);
//   * the Audit page's Activity column, its details dialog and its CSV
//     (public/js/features/audit-admin.js auditActivityLabel).
// The holder's own signed-in session is never a scanner, so its row says it came
// from the email link without the caveat. A plain download says neither (CONTROL).
//
// The rows are made by real downloads of a real certificate on this file's
// server, through the same marked URL the email carries; that the email carries
// it is held by tests/certificate-dispatch.spec.js (a capturing relay).

const fs = require("fs");
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin, freshCtx, gradingHashFor } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { adminLogin, clickTab, filterComps, openKebab } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const SCANNER = "Certificate PDF downloaded from the email link (may be a mail scanner)";
const HOLDER = "Certificate PDF downloaded from the email link";
const PLAIN = "Certificate PDF downloaded";

const W = {};

function downloads(compId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='badge_certificate_downloaded' ORDER BY rowid")
      .all(compId).map(r => ({ actor: r.changed_by, ...JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
  try {
    const p = await makeParticipant(sa, saCsrf, "maillink");
    // Two challenges, one answered wrong: attempted (a participation
    // certificate), and nothing ends the event early (fixture item 1).
    const comp = await makeCompetition(sa, saCsrf, "maillink");
    const t1 = await makeTask(sa, saCsrf, "maillink1");
    const t2 = await makeTask(sa, saCsrf, "maillink2");
    await assignTask(sa, saCsrf, t1.id, [comp.id]);
    await assignTask(sa, saCsrf, t2.id, [comp.id]);
    await enrol(sa, saCsrf, comp.id, [p.id]);
    const { api: pa, csrf: pc } = await apiLogin(p.email);
    let token;
    try {
      const sel = await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } });
      expect(sel.ok(), `select: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      const sub = await pa.post(`/api/tasks/${t1.id}/submit`, { headers: { ...H(pc), "x-competition-id": comp.id }, data: { answer: "not-it", gradingHash: await gradingHashFor(pa, t1.id) } });
      expect(sub.ok(), `submit: ${sub.status()} ${await sub.text()}`).toBeTruthy();
      expect((await sub.json()).correct, "PRECONDITION: a wrong answer, so the event stays live").toBe(false);
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf) });
      expect(end.ok(), `end: ${end.status()} ${await end.text()}`).toBeTruthy();
      const m = await pa.post(`/api/competitions/${comp.id}/badge`, { headers: H(pc) });
      expect(m.ok(), `mint: ${m.status()} ${await m.text()}`).toBeTruthy();
      token = (await m.json()).token;
      expect(token, "PRECONDITION: the holder collected a certificate").toBeTruthy();

      // The three downloads, oldest first: a signed-out fetch through the email's
      // marked link (a scanner's, or the holder's own signed-out click), the
      // holder's signed-in click on that link, and a plain signed-out download.
      const { api: anon } = await freshCtx();
      try {
        expect((await anon.get(`/badge/${token}/certificate.pdf?from=email`)).status()).toBe(200);
        expect((await pa.get(`/badge/${token}/certificate.pdf?from=email`)).status()).toBe(200);
        expect((await anon.get(`/badge/${token}/certificate.pdf`)).status()).toBe(200);
      } finally { await anon.dispose(); }
    } finally { await pa.dispose(); }
    const rows = downloads(comp.id);
    expect(rows.map(r => [r.actor.toLowerCase(), r.via === undefined ? null : r.via, r.by_owner]),
      "PRECONDITION: the server recorded the three as marked, marked by the holder, and plain")
      .toEqual([["anonymous", "email_link", false], [p.email.toLowerCase(), "email_link", true], ["anonymous", null, false]]);
    Object.assign(W, { comp, p, token });
  } finally { await sa.dispose(); }
});

test.describe("sweep #402 — a download through the email's link says it may be a mail scanner", () => {
  test("the event's History words each download: the email link's with the caveat, the holder's without it, a plain one as it was", async ({ page }) => {
    test.setTimeout(120_000);
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, W.comp.name);
    const row = page.locator("#admin-comp-body tr", { hasText: W.comp.name }).first();
    await openKebab(page, row);
    await page.locator('#kebab-portal [data-action="comp-history"]').click();
    const ov = page.locator("#hist-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    const lines = ov.locator("#hist-body tr", { hasText: "Certificate PDF downloaded" });
    await expect(lines, "the three downloads have their own History sentence").toHaveCount(3, { timeout: 15000 });
    const texts = (await lines.locator(".history-change-cell").allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim()).sort();
    expect(texts).toEqual([
      `Certificate PDF downloaded: ${W.p.nickname}`,
      `Certificate PDF downloaded: ${W.p.nickname} — from the email link (may be a mail scanner)`,
      `Certificate PDF downloaded: ${W.p.nickname} — from the email link, by its holder`,
    ].sort());
    // The Type column keeps the key, as for every row.
    await expect(lines.locator(".history-type-badge")).toHaveText(Array(3).fill("badge_certificate_downloaded"));
    await ov.locator('[data-action="history-close"]').click();
    await expect(ov).toHaveCount(0, { timeout: 10000 });
  });

  test("the renderer: the wording follows `via` and `by_owner`, escapes what it prints, and leaves other rows as they were", async ({ page }) => {
    await adminLogin(page);
    await page.waitForFunction(() => typeof window.formatEventChange === "function" && typeof window.auditActivityLabel === "function");
    const r = await page.evaluate(() => {
      const f = (details) => window.formatEventChange({ event_type: "badge_certificate_downloaded", details });
      const a = (details) => window.auditActivityLabel("badge_certificate_downloaded", details);
      return {
        scanner: f({ nickname: "nick", via: "email_link", by_owner: false }),
        holder: f({ nickname: "nick", via: "email_link", by_owner: true }),
        plain: f({ nickname: "nick", by_owner: false }),
        zip: f({ nickname: "nick", via: "top3_zip", by_owner: false }),
        hostile: f({ nickname: "<b>n</b>", via: "<img src=x onerror=alert(1)>" }),
        aScanner: a({ via: "email_link", by_owner: false }),
        aNoOwnerKey: a({ via: "email_link" }),
        aHolder: a({ via: "email_link", by_owner: true }),
        aPlain: a({ by_owner: false }),
        aNone: a(undefined),
        aOther: window.auditActivityLabel("badge_image_downloaded", { via: "email_link" }),
      };
    });
    const text = (html) => html.replace(/<[^>]+>/g, "");
    expect(text(r.scanner)).toBe("Certificate PDF downloaded: nick — from the email link (may be a mail scanner)");
    expect(text(r.holder)).toBe("Certificate PDF downloaded: nick — from the email link, by its holder");
    expect(text(r.plain), "CONTROL: a plain download names neither").toBe("Certificate PDF downloaded: nick");
    expect(text(r.zip)).toBe("Certificate PDF downloaded: nick — in the top 3 certificates download");
    expect(r.hostile, "the nickname and an unknown via are escaped").toContain("&lt;b&gt;n&lt;/b&gt;");
    expect(r.hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(r.hostile).not.toMatch(/<img|<b>/);
    expect(r.aScanner).toBe(SCANNER);
    expect(r.aNoOwnerKey, "no by_owner key is not the holder").toBe(SCANNER);
    expect(r.aHolder).toBe(HOLDER);
    expect(r.aPlain, "CONTROL: the plain wording").toBe(PLAIN);
    expect(r.aNone).toBe(PLAIN);
    expect(r.aOther, "CONTROL: only the PDF download takes the email-link wording").toBe("Certificate image downloaded");
  });

  test("the Audit page: the Activity column, the details dialog and the CSV say it may be a mail scanner; the holder's and a plain one do not", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminLogin(page);
    await page.locator('button.admin-nav-item[data-tab-id="admin-audit-tab"]').evaluate(el => el.click());
    await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 20000 });
    await expect(page.locator("#audit-event option[value='" + W.comp.id + "']")).toHaveCount(1, { timeout: 20000 });
    await page.locator("#audit-event").selectOption(W.comp.id);
    // Narrowed by the plain wording, which the search finds by the key it names
    // (the email-link rows included: their key is the same).
    await page.locator("#audit-search").fill("certificate pdf downloaded");
    const rows = page.locator("#admin-audit-body tr");
    await expect.poll(() => rows.evaluateAll(trs => trs.map(tr => (tr.querySelector("td.audit-activity") || {}).dataset?.eventType || "")),
      { timeout: 15000, message: "the list narrows to the event's three downloads" })
      .toEqual(Array(3).fill("badge_certificate_downloaded"));
    const shown = await page.locator("#admin-audit-body tr").evaluateAll(trs => trs
      .filter(tr => tr.querySelector('td.audit-activity[data-event-type="badge_certificate_downloaded"]'))
      .map(tr => [tr.querySelector("td.audit-activity").textContent.trim(), tr.querySelector("td.audit-actor").textContent.trim().toLowerCase()]));
    expect(shown.sort()).toEqual([
      [PLAIN, "anonymous"],
      [HOLDER, W.p.email.toLowerCase()],
      [SCANNER, "anonymous"],
    ].sort());

    // The details dialog says it too, and keeps the key.
    const scannerRow = page.locator("#admin-audit-body tr", { has: page.locator("td.audit-activity", { hasText: "(may be a mail scanner)" }) });
    await expect(scannerRow).toHaveCount(1);
    await scannerRow.locator('[data-action="audit-row-details"]').click();
    const dlg = page.locator("#audit-detail-overlay [role=dialog]");
    await expect(dlg.locator("dt", { hasText: /^Activity$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText(SCANNER);
    await expect(dlg.locator("dt", { hasText: /^Activity key$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("badge_certificate_downloaded");
    await page.keyboard.press("Escape");
    await expect(page.locator("#audit-detail-overlay")).toHaveCount(0);

    // The CSV's Activity column is the screen's.
    const dl = page.waitForEvent("download");
    await page.locator("#audit-export").click();
    const csv = fs.readFileSync(await (await dl).path(), "utf8");
    const lines = csv.split("\n").filter(l => l.includes('"badge_certificate_downloaded"'));
    expect(lines, "the three downloads are in the CSV").toHaveLength(3);
    expect(lines.filter(l => l.includes(`"${SCANNER}","badge_certificate_downloaded"`)), "the scanner caveat").toHaveLength(1);
    expect(lines.filter(l => l.includes(`"${HOLDER}","badge_certificate_downloaded"`)), "the holder's").toHaveLength(1);
    expect(lines.filter(l => l.includes(`"${PLAIN}","badge_certificate_downloaded"`)), "CONTROL: the plain one").toHaveLength(1);
  });
});
