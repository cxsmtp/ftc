// @ts-check
//
// THE EVENT WORKSPACE'S DOORS, PRESSED (sweep gap #246).
//
// Each door here was drawn and counted by other specs but never pressed. What a
// press does is what an organiser gets, so each is driven to its outcome:
//   • ⋯ → Export everything: the full export of THIS event is requested, and the
//     ZIP the server named arrives, holding this event (its name and id, its
//     participant) and nothing of a decoy event's;
//   • Approve (the header's, shown while someone in the event waits): the
//     event's Participants section, narrowed to its waiting accounts — never a
//     member already approved, nor a waiting account of another event;
//   • the Overview's attention row: "1 person is" / "2 people are waiting for
//     approval", counting this event's accounts only, absent when nobody waits,
//     and its own Review opens the event's waiting accounts;
//   • the Overview's walk-up card, Full-screen QR: the join code is read (and
//     audited) on the press, shown full screen with the QR, and Escape closes it;
//   • on a phone, the Section button: the sheet lists the event's sections, and
//     picking one shows it;
//   • REVEAL ON PRESS: opening a workspace sends no read of the join secret
//     (GET …/self-enroll) and writes no `self_enroll_revealed` History row; the
//     press of the join pill sends exactly one read and writes exactly one row,
//     with the request's context (CONTROL: the request listener and the History
//     query do see a reveal when one happens).
// Each test owns its events and people.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DB_PATH } = require("./helpers");
const { adminLogin } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const yauzl = require("yauzl");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

function withDb(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const revealRows = (id) => withDb(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='self_enroll_revealed' ORDER BY changed_at").all(id));
/** The printed join code (`XXX-XXX`), as the reveal formats the stored one. */
const joinCodeDisplay = (id) => {
  const code = withDb(db => db.prepare("SELECT join_code FROM competitions WHERE id=?").get(id).join_code);
  expect(code, "PRECONDITION: the event has a join code").toBeTruthy();
  return code.match(/.{1,3}/g).join("-");
};

/** Every entry of a ZIP buffer as { name: text }. */
function unzip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on("entry", (e) => {
        zip.openReadStream(e, (e2, s) => {
          if (e2) return reject(e2);
          const parts = [];
          s.on("data", (d) => parts.push(d));
          s.on("end", () => { out[e.fileName] = Buffer.concat(parts).toString("utf8"); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Build a world as the built-in superadmin; the session ends before the browser signs in. */
async function asSuperadmin(fn) {
  const s = await apiLogin("superadmin");
  try { return await fn(s.api, s.csrf); } finally { await s.api.dispose(); }
}

async function openWorkspace(page, ev, tab) {
  await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id),
    { timeout: 15000, message: "the events model holds the event" }).toBe(true);
  await page.evaluate(({ id, n, t }) => window.openEventWorkspace(id, n, t ? { tab: t } : {}), { id: ev.id, n: ev.name, t: tab });
  await expect(page.locator("#admin-workspace")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#ws-title")).toHaveText(ev.name);
}

/**
 * A member of `compId` who is WAITING for approval: verified, not approved.
 * The assign route skips an unapproved account, so the row is written while
 * approved, then the account is rewound to registerPost's FIXTURE state (the
 * test-only POST /api/test/registration-legacy-state: unverified, unapproved;
 * no sign-up creates it) and verified by hand.
 */
async function makeWaitingMember(sa, csrf, compId, label) {
  const p = await makeParticipant(sa, csrf, label);
  await enrol(sa, csrf, compId, [p.id]);
  const back = await sa.post("/api/test/registration-legacy-state", { headers: H(csrf), data: { email: p.email } });
  expect(back.ok(), `unapprove ${label}: ${await back.text()}`).toBeTruthy();
  expect((await back.json()).approved, `${label} is no longer approved`).toBe(false);
  const v = await sa.post(`/api/admin/participants/${p.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify ${label}: ${await v.text()}`).toBeTruthy();
  const row = withDb(db => db.prepare("SELECT verified, approved, denied_at, COALESCE(blocked,0) AS blocked FROM users WHERE id=?").get(p.id));
  expect(row, `PRECONDITION: ${label} waits for approval`).toEqual({ verified: 1, approved: 0, denied_at: null, blocked: 0 });
  expect(withDb(db => !!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, p.id)), `PRECONDITION: ${label} is a member`).toBe(true);
  return p;
}

/** The People table's rows, by address. */
const emailsShown = (page) => page.evaluate(() => [...document.querySelectorAll("#admin-participants-body .p-sub[data-email]")].map(e => e.dataset.email).sort());
/** The rows and the shared loading count, read in ONE evaluate so they agree. */
const tableState = (page) => page.evaluate(() => ({
  loading: (window.S && window.S._loadingCount) || 0,
  shown: [...document.querySelectorAll("#admin-participants-body .p-sub[data-email]")].map(e => e.dataset.email).sort(),
}));

test("⋯ → Export everything requests this event's full export and saves the ZIP the server named, holding this event and none of a decoy's", async ({ page }) => {
  const { ev, p, q } = await asSuperadmin(async (sa, csrf) => {
    const ev = await makeCompetition(sa, csrf, "wsexport");
    const decoy = await makeCompetition(sa, csrf, "wsexportdecoy");
    const p = await makeParticipant(sa, csrf, "wsexportp");
    const q = await makeParticipant(sa, csrf, "wsexportq");
    await enrol(sa, csrf, ev.id, [p.id]);
    await enrol(sa, csrf, decoy.id, [q.id]);
    return { ev, p, q };
  });
  await adminLogin(page);
  await openWorkspace(page, ev);
  await page.locator("#ws-quick .ws-more-btn").click();
  const item = page.locator('#kebab-portal.open [data-action="ws-export-zip"]');
  await expect(item, "the ⋯ menu offers Export everything").toBeVisible({ timeout: 5000 });
  const isExport = (u) => new URL(u).pathname.endsWith("/export/full");
  const [rq, res, dl] = await Promise.all([
    page.waitForRequest((r) => isExport(r.url())),
    page.waitForResponse((r) => isExport(r.url())),
    page.waitForEvent("download"),
    item.click(),
  ]);
  const u = new URL(rq.url());
  expect(u.pathname, "the export of THIS event").toBe(`/api/admin/competitions/${ev.id}/export/full`);
  expect(u.searchParams.get("format")).toBe("zip-csv");
  expect(res.status()).toBe(200);
  const named = /filename="([^"]+)"/.exec(res.headers()["content-disposition"] || "");
  expect(named, "the server names the file").toBeTruthy();
  expect(dl.suggestedFilename(), "saved under the name the server gave it").toBe(named[1]);
  const files = await unzip(require("fs").readFileSync(await dl.path()));
  expect(files["README.txt"], "the file is this event's").toContain(`"${ev.name}" (${ev.id})`);
  expect(files["participants.csv"], "…with its participant").toContain(p.email);
  expect(Object.values(files).join("\n"), "…and nothing of the decoy's").not.toContain(q.email);
  await expect(page.locator(".toast").filter({ hasText: "Event exported." })).toBeVisible();
});

test("Approve opens this event's Participants on its waiting accounts only: not a member already approved, not a waiting account of another event", async ({ page }) => {
  test.setTimeout(90_000);
  const { ev, waiting, approvedMember, otherWaiting } = await asSuperadmin(async (sa, csrf) => {
    const ev = await makeCompetition(sa, csrf, "wsapprove");
    const decoy = await makeCompetition(sa, csrf, "wsapprovedecoy");
    const approvedMember = await makeParticipant(sa, csrf, "wsapproveok");
    await enrol(sa, csrf, ev.id, [approvedMember.id]);
    const waiting = await makeWaitingMember(sa, csrf, ev.id, "wsapprovewait");
    const otherWaiting = await makeWaitingMember(sa, csrf, decoy.id, "wsapproveother");
    return { ev, waiting, approvedMember, otherWaiting };
  });
  await adminLogin(page);
  await openWorkspace(page, ev);
  const approve = page.locator('#ws-quick [data-action="ws-review-pending"]');
  await expect(approve, "the header offers Approve while someone in the event waits").toBeVisible({ timeout: 20000 });
  await expect(approve.locator(".ws-badge"), "…counting this event's waiting accounts only").toHaveAttribute("aria-label", "1 waiting");
  await approve.click();
  await expect(page.locator("#admin-participants-tab")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#admin-workspace"), "inside the event's workspace").toHaveAttribute("data-section", "admin-participants-tab");
  await expect(page.locator("#ws-title")).toHaveText(ev.name);
  await expect(page.locator('#p-status-filters [data-value="pending"]'), "the Pending filter is on").toHaveClass(/\bactive\b/);
  // Judged once the section's own load has drawn (the People loader holds the
  // shared loading count and renders in the step that releases it), so a
  // filtered render the load then replaces cannot pass for the outcome.
  await expect.poll(() => tableState(page), { timeout: 15000, message: "only this event's waiting account is listed, once the section has loaded" })
    .toEqual({ loading: 0, shown: [waiting.email] });

  // CONTROL: the same section without the Pending filter lists both of the
  // event's members (so the filter, not an empty roster, made the narrowing),
  // and still never the other event's waiting account.
  await page.locator('#p-status-filters [data-value="pending"]').evaluate((b) => b.click());
  await expect(page.locator('#p-status-filters [data-value="pending"]')).not.toHaveClass(/\bactive\b/);
  await expect.poll(() => emailsShown(page), { timeout: 15000 }).toEqual([waiting.email, approvedMember.email].sort());
  expect(await emailsShown(page)).not.toContain(otherWaiting.email);
});

test("the Overview's attention row counts this event's waiting accounts (one person, two people, none) and its Review opens them", async ({ page }) => {
  test.setTimeout(120_000);
  const { two, one, none, twoWaiting, noneMember } = await asSuperadmin(async (sa, csrf) => {
    const two = await makeCompetition(sa, csrf, "wsattntwo");
    const one = await makeCompetition(sa, csrf, "wsattnone");
    const none = await makeCompetition(sa, csrf, "wsattnnone");
    const twoWaiting = [await makeWaitingMember(sa, csrf, two.id, "wsattnw1"), await makeWaitingMember(sa, csrf, two.id, "wsattnw2")];
    await makeWaitingMember(sa, csrf, one.id, "wsattnw3");
    const noneMember = await makeParticipant(sa, csrf, "wsattnok");
    await enrol(sa, csrf, none.id, [noneMember.id]);
    return { two, one, none, twoWaiting, noneMember };
  });
  await adminLogin(page);
  const attn = page.locator("#ws-ov-attn .ws-attn-warn").filter({ hasText: "waiting for approval" });
  const review = page.locator('#ws-ov-attn [data-action="ws-review-pending"]');

  await openWorkspace(page, two);
  await expect(attn, "two of this event's accounts wait (another event's waiting account is not counted)").toHaveText(/^2 people are waiting for approval\./, { timeout: 20000 });
  await expect(review).toHaveCount(1);

  await openWorkspace(page, one);
  await expect(attn, "one account waits: the singular").toHaveText(/^1 person is waiting for approval\./, { timeout: 20000 });

  // CONTROL — an event whose only member is approved shows no approvals line,
  // judged once the People model the line counts from holds that member.
  await openWorkspace(page, none);
  await expect.poll(() => page.evaluate((id) => (window.adminParticipantsData || []).some(p => p.id === id), noneMember.id),
    { timeout: 15000, message: "PRECONDITION: the People model has loaded this event's member" }).toBe(true);
  await expect(page.locator("#admin-workspace")).toHaveAttribute("data-section", "admin-event-overview-tab");
  await expect(review, "nobody waits: no Review").toHaveCount(0);
  await expect(page.locator("#ws-ov-attn")).not.toContainText("waiting for approval");

  // The row's OWN Review (not the header's Approve) opens the event's waiting accounts.
  await openWorkspace(page, two);
  await expect(review).toBeVisible({ timeout: 20000 });
  await review.click();
  await expect(page.locator("#admin-workspace"), "inside the event's workspace").toHaveAttribute("data-section", "admin-participants-tab", { timeout: 10000 });
  await expect(page.locator("#ws-title")).toHaveText(two.name);
  await expect(page.locator('#p-status-filters [data-value="pending"]'), "the Pending filter is on").toHaveClass(/\bactive\b/);
  await expect.poll(() => tableState(page), { timeout: 15000, message: "this event's two waiting accounts are listed, once the section has loaded" })
    .toEqual({ loading: 0, shown: twoWaiting.map(p => p.email).sort() });
});

test("the Overview's Full-screen QR reads the join code on the press, shows it full screen with its QR, and Escape closes it", async ({ page }) => {
  const ev = await asSuperadmin((sa, csrf) => makeCompetition(sa, csrf, "wsovqr", { self_enroll_enabled: true }));
  const code = joinCodeDisplay(ev.id);
  await adminLogin(page);
  await openWorkspace(page, ev);
  const card = page.locator("#ws-ov-join");
  const btn = card.locator('[data-action="ws-ov-qr"]');
  await expect(btn, "the walk-up card offers the full-screen QR").toBeVisible({ timeout: 15000 });
  await expect(card.locator(".ws-ov-jcode"), "PRECONDITION: no code before the press").toHaveCount(0);
  expect(revealRows(ev.id), "PRECONDITION: nothing revealed yet").toHaveLength(0);

  await btn.click();
  const full = page.locator("#ws-qr-full");
  await expect(full).toBeVisible({ timeout: 10000 });
  await expect(full.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
  await expect(full.locator("#ws-qr-full-title"), "the event's name").toHaveText(ev.name);
  await expect(full.locator(".ws-qr-full-jcode"), "the event's join code").toHaveText(code);
  const img = full.locator("#ws-qr-full-qr img");
  await expect(img, "the QR").toBeVisible({ timeout: 10000 });
  await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await expect(card.locator(".ws-ov-jcode"), "the card under it now shows the code").toHaveText(code);
  await expect.poll(() => revealRows(ev.id).length, { message: "the reveal is on the event's History" }).toBe(1);

  await page.keyboard.press("Escape");
  await expect(full, "Escape closes the full-screen QR").toHaveCount(0);
  await expect(card, "…and only it: the Overview stays").toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.closest("#ws-ov-join") ? document.activeElement.dataset.action : null),
    { message: "focus goes back to the button that opened it" }).toBe("ws-ov-qr");
});

test("on a phone, the Section button opens the sheet of this event's sections, and picking one shows it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ev = await asSuperadmin((sa, csrf) => makeCompetition(sa, csrf, "wssheet"));
  await adminLogin(page);
  await openWorkspace(page, ev);
  const pick = page.locator("#ws-section-pick");
  await expect(pick, "the phone's section control").toBeVisible();
  await expect(page.locator("#ws-tabs"), "PRECONDITION: the tab strip is the Section button here").toBeHidden();
  await expect(page.locator("#ws-section-name")).toHaveText("Overview");

  await pick.click();
  const sheet = page.locator('#ws-section-sheet [role="dialog"]');
  await expect(sheet).toBeVisible();
  const offered = await page.evaluate(() => [...document.querySelectorAll("#ws-tabs .ws-tab")].filter(b => b.style.display !== "none").map(b => b.dataset.section));
  expect(offered.length, "PRECONDITION: the event offers several sections").toBeGreaterThan(3);
  expect(await sheet.locator(".ws-sheet-item").evaluateAll((els) => els.map(e => e.dataset.section)), "the sheet lists exactly the sections offered").toEqual(offered);
  const cur = sheet.locator('.ws-sheet-item[aria-current="page"]');
  await expect(cur, "the section on screen is marked").toHaveText("Overview");
  await expect(cur, "…and takes focus").toBeFocused();

  await sheet.locator('.ws-sheet-item[data-section="admin-event-settings-tab"]').click();
  await expect(page.locator("#ws-section-sheet"), "picking closes the sheet").toHaveCount(0);
  await expect(page.locator("#admin-event-settings-tab"), "…and shows the section").toBeVisible();
  await expect(page.locator("#admin-event-settings-tab")).toContainText("How this event runs");
  await expect(page.locator("#admin-event-overview-tab")).toBeHidden();
  await expect(page.locator("#ws-section-name")).toHaveText("Settings");
  await expect(page.locator("#admin-workspace")).toHaveAttribute("data-section", "admin-event-settings-tab");
  await expect(page.locator("#ws-title"), "still inside the event").toHaveText(ev.name);

  // Reopened, it marks the new section; Escape closes it and hands focus back.
  await pick.click();
  await expect(page.locator('#ws-section-sheet .ws-sheet-item[aria-current="page"]')).toHaveText("Settings");
  await page.keyboard.press("Escape");
  await expect(page.locator("#ws-section-sheet")).toHaveCount(0);
  await expect(pick).toBeFocused();
});

test("opening a workspace reveals nothing: the join code is read, and its History row written, only when the join pill is pressed", async ({ page }) => {
  const ev = await asSuperadmin((sa, csrf) => makeCompetition(sa, csrf, "wsreveal", { self_enroll_enabled: true }));
  const code = joinCodeDisplay(ev.id);
  const reveals = [];
  let pressed = false;
  page.on("request", (rq) => {
    if (rq.method() === "GET" && new URL(rq.url()).pathname === `/api/admin/competitions/${ev.id}/self-enroll`) reveals.push(pressed ? "after the press" : "before the press");
  });
  await adminLogin(page);
  // The Overview's own reads have answered before anything is judged.
  const pulse = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/competitions/${ev.id}/overview-pulse`);
  const orgs = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/competitions/${ev.id}/admins`);
  await openWorkspace(page, ev);
  await Promise.all([pulse, orgs]);
  const pill = page.locator('#ws-join [data-action="ws-join-reveal"]');
  await expect(pill, "the header's join pill, not yet revealed").toBeVisible();
  await expect(page.locator('#ws-ov-join [data-action="ws-ov-qr"]'), "the walk-up card's door, not yet revealed").toBeVisible();
  await expect(page.locator("#ws-ov-join .ws-ov-jcode")).toHaveCount(0);
  // Another section and back: each repaints the header and the Overview.
  await page.evaluate(() => window.wsTab("admin-event-settings-tab"));
  await expect(page.locator("#admin-event-settings-tab")).toBeVisible();
  await page.evaluate(() => window.wsTab("admin-event-overview-tab"));
  await expect(page.locator('#ws-ov-join [data-action="ws-ov-qr"]')).toBeVisible();
  expect(reveals, "opening the workspace read no join secret").toEqual([]);
  expect(revealRows(ev.id), "…and recorded no reveal").toHaveLength(0);

  // The press: one read, one History row.
  pressed = true;
  await pill.click();
  const pop = page.locator("#ws-join-pop");
  await expect(pop).toBeVisible({ timeout: 10000 });
  await expect(pop.locator(".ws-jcode"), "the event's join code").toHaveText(code);
  expect(reveals, "CONTROL: the press read it, once").toEqual(["after the press"]);
  await expect.poll(() => revealRows(ev.id).length, { message: "the reveal is on the event's History" }).toBe(1);
  const row = revealRows(ev.id)[0];
  expect(row.changed_by, "by whoever pressed").toBe("superadmin");
  const det = JSON.parse(row.details);
  expect(det.ip, "with the request's context").toBeTruthy();
  expect(det.req_id).toBeTruthy();
  // The code read is kept for this open: closing and reopening the popover reads nothing more.
  const shown = page.locator('#ws-join [data-action="ws-join-toggle"]');
  await shown.click();
  await expect(pop).toBeHidden();
  await shown.click();
  await expect(page.locator("#ws-join-pop .ws-jcode")).toHaveText(code);
  expect(reveals, "reopening read nothing").toEqual(["after the press"]);
  expect(revealRows(ev.id)).toHaveLength(1);
});
