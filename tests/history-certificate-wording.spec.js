"use strict";

// HISTORY WORDS EVERY CERTIFICATE RECORD; IT NEVER SHOWS ITS RAW KEY.
//
// The History dialog (public/js/features/history.js formatEventChange) had words
// for a certificate's PDF download only: an issue (`badge_minted`), an image
// download, a share, a revocation, an Issue again, each congratulations email
// (`certificate_emailed`) and a code lookup (`credential_resolved`) fell to its
// default branch and printed the raw key, while the Audit page words them all
// (AUDIT_ACTIVITY_LABELS). Each now opens with the Audit page's words, names the
// holder on the event's History and the event on the person's, and says in
// plain words what its details add (how it was issued or shared, why it was
// revoked, what became of an email). Pinned here:
//   - the renderer, case by case, by value, with hostile values escaped;
//   - SOURCE SCANNER: every certificate record type the server writes into a
//     History table (an event's or a person's), collected from its writers,
//     renders without its raw key, with a floor so a renamed writer cannot make
//     it match nothing, and the writers whose type is a variable listed;
//   - real rows from the real writers (a share by the holder and by someone
//     else, a revocation with a reason) read in words in both History dialogs,
//     whose Type column keeps the key.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, TEST_DB_PATH, apiLogin, freshCtx } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
const CERT_TYPE = /^(badge|certificate|credential)_/;
// The certificate records a History table holds today: the scan must reach each.
const KNOWN = ["badge_minted", "badge_image_downloaded", "badge_shared", "badge_certificate_downloaded",
  "badge_revoked", "badge_reissued", "certificate_emailed", "credential_resolved", "certificate_config_changed"];
// Writers whose type is an expression, each looked at: `kind` is
// `_recordBadgeDownload`'s, whose callers' literals are collected below; `evType`
// in server.js is a submission's or a hint's. A new one fails until it is
// decided here.
const DYNAMIC_SITES = [
  "routes/badge.js|recordCompetitionEvent|kind",
  "server.js|recordCompetitionEvent|evType",
  "server.js|recordUserEvent|evType",
];

function jsFiles(dir) {
  let out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out = out.concat(jsFiles(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

// The argument list of the call whose "(" is at `i` (strings and nesting aware).
function callArgs(src, i) {
  let depth = 0, cur = "", q = null;
  const out = [];
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { cur += c; if (c === "\\") { cur += src[++j]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; cur += c; continue; }
    if ("([{".includes(c)) { depth++; if (depth === 1) continue; }
    if (")]}".includes(c)) { depth--; if (depth === 0) { out.push(cur); return out; } }
    if (c === "," && depth === 1) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  return out;
}

/** The certificate record types written into competition_events / user_events. */
function historyCertificateTypes() {
  const types = new Set();
  const dynamic = [];
  const files = [path.join(ROOT, "server.js"), ...jsFiles(path.join(ROOT, "lib")), ...jsFiles(path.join(ROOT, "routes"))];
  const re = /\b(queueEvent|recordCompetitionEvent|recordUserEvent)\s*\(/g;
  const lits = (expr) => [...String(expr || "").matchAll(/['"]([a-z][a-z0-9_]+)['"]/g)].map(x => x[1]);
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    const src = stripJsComments(fs.readFileSync(f, "utf8"));
    let m;
    while ((m = re.exec(src))) {
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;   // the definition
      let a = callArgs(src, m.index + m[0].length - 1);
      let fn = m[1];
      if (fn === "queueEvent") { fn = String(a[0] || "").trim().replace(/^.*\./, ""); a = a.slice(1); }
      if (fn !== "recordCompetitionEvent" && fn !== "recordUserEvent") continue;
      const found = lits(a[1]);
      if (!found.length) { dynamic.push(`${rel}|${fn}|${String(a[1] || "").trim()}`); continue; }
      found.filter(t => CERT_TYPE.test(t)).forEach(t => types.add(t));
    }
    // A badge download's type is `_recordBadgeDownload`'s FOURTH argument.
    if (rel === "routes/badge.js") for (const x of src.matchAll(/\b_recordBadgeDownload\s*\(/g)) {
      if (/function\s*$/.test(src.slice(Math.max(0, x.index - 12), x.index))) continue;
      lits(callArgs(src, x.index + x[0].length - 1)[3]).filter(t => CERT_TYPE.test(t)).forEach(t => types.add(t));
    }
  }
  return { types, dynamic: [...new Set(dynamic)].sort() };
}

async function bootRenderer(page) {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.formatEventChange === "function", null, { timeout: 20000 });
}

/** The words a History cell shows: tags dropped, a line break kept as one. */
const words = (html) => html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/[ \t]+/g, " ").trim();

test.describe("History — certificate records in words", () => {
  test("the renderer words each certificate record, by value, and escapes what it prints", async ({ page }) => {
    await bootRenderer(page);
    const iso = "2026-11-24T10:15:00.000Z";
    const cases = [
      ["badge_minted", { nickname: "nick", rank: 1, placement: true, via: "automatic" }, "Certificate issued: nick — automatically, by the platform"],
      ["badge_minted", { nickname: "nick", rank: 2, placement: true, via: "reissue" }, "Certificate issued: nick — again, after a revocation"],
      ["badge_minted", { nickname: "nick", rank: 7, placement: false }, "Certificate issued: nick"],
      ["badge_minted", {}, "Certificate issued"],
      ["badge_image_downloaded", { nickname: "nick", rank: 3, by_owner: false }, "Certificate image downloaded: nick"],
      ["badge_image_downloaded", {}, "Certificate image downloaded"],
      ["badge_shared", { nickname: "nick", by_owner: true }, "Certificate shared: nick"],
      ["badge_shared", { nickname: "nick", by_owner: false }, "Certificate shared: nick — not by its holder"],
      ["badge_shared", { nickname: "nick", by_owner: true, via: "share_link" }, "Certificate shared: nick — from the link in the congratulations email"],
      ["badge_shared", { nickname: "nick" }, "Certificate shared: nick"],
      ["badge_revoked", { competition_id: "c1", competition_name: "Spring CTF", basis: "participation", reason: "Issued to the wrong person" }, "Certificate revoked: Spring CTF\nReason: Issued to the wrong person"],
      ["badge_revoked", { competition_id: "c1", reason: "   " }, "Certificate revoked: c1"],
      ["badge_revoked", {}, "Certificate revoked"],
      ["badge_reissued", { competition_id: "c1", competition_name: "Spring CTF", basis: "placement", rank: 1, previous_basis: "participation" }, "Certificate issued again: Spring CTF"],
      ["badge_reissued", {}, "Certificate issued again"],
      ["certificate_emailed", { competition_name: "Spring CTF", status: "sent", via: "automatic", attempt: 1 }, "Certificate emailed: Spring CTF"],
      ["certificate_emailed", { competition_name: "E", status: "sent", via: "resend" }, "Certificate emailed: E — sent again by an organiser"],
      ["certificate_emailed", { competition_name: "E", status: "sent", via: "reissue" }, "Certificate emailed: E — with a certificate issued again"],
      ["certificate_emailed", { competition_name: "E", status: "failed", via: "automatic", attempt: 3, error: "smtp_failed" }, "Certificate email failed: E"],
      ["certificate_emailed", { competition_name: "E", status: "suppressed", via: "automatic" }, "Certificate email not sent: E\nthe address unsubscribed from these emails"],
      ["certificate_emailed", { competition_name: "E", status: "skipped", skipped: "revoked", via: "automatic" }, "Certificate email not sent: E\nthe certificate had been revoked"],
      ["certificate_emailed", { status: "skipped", skipped: "account_inactive", via: "automatic" }, "Certificate email not sent\nthe account is blocked, denied or not approved"],
      ["certificate_emailed", { competition_name: "E", status: "skipped", skipped: "not_member", via: "retry" }, "Certificate email not sent: E — a retry\nthey were no longer in the event"],
      ["certificate_emailed", { competition_name: "E", status: "skipped", skipped: "something_new" }, "Certificate email not sent: E"],
      ["certificate_emailed", { competition_name: "E" }, "Certificate email: E"],
      ["credential_resolved", { code_fingerprint: "cf_abc", competition_id: "c1", revoked: false }, "Certificate checked — its code was looked up to find its holder"],
      ["credential_resolved", { code_fingerprint: "cf_abc", competition_id: "c1", revoked: true }, "Certificate checked — its code was looked up to find its holder (the certificate had been revoked)"],
    ];
    const out = await page.evaluate((cs) => cs.map(([t, d]) => window.formatEventChange({ event_type: t, details: d })), cases);
    cases.forEach(([type, , want], i) => {
      expect(words(out[i]), `${type} ${JSON.stringify(cases[i][1])}`).toBe(want);
      expect(out[i], `${type}: no raw key`).not.toContain(type);
    });
    // A failed email names when it is tried again, in the screen's own date words.
    const retry = await page.evaluate((at) => window.formatEventChange({ event_type: "certificate_emailed",
      details: { competition_name: "E", status: "failed", via: "retry", next_attempt_at: at } }), iso);
    expect(words(retry)).toMatch(/^Certificate email failed: E — a retry\nit is tried again at \S/);
    expect(retry, "the date is worded, not the stored instant").not.toContain(iso);
    // Hostile stored values are text, never markup.
    const bad = "<img src=x onerror=window.__h=1>";
    const hostile = await page.evaluate((b) => [
      window.formatEventChange({ event_type: "badge_minted", details: { nickname: b } }),
      window.formatEventChange({ event_type: "badge_shared", details: { nickname: b, by_owner: false } }),
      window.formatEventChange({ event_type: "badge_image_downloaded", details: { nickname: b } }),
      window.formatEventChange({ event_type: "badge_revoked", details: { competition_name: b, reason: b } }),
      window.formatEventChange({ event_type: "badge_reissued", details: { competition_name: b } }),
      window.formatEventChange({ event_type: "certificate_emailed", details: { competition_name: b, status: "sent" } }),
    ], bad);
    for (const h of hostile) {
      expect(h).toContain("&lt;img src=x onerror=window.__h=1&gt;");
      expect(h.toLowerCase()).not.toContain("<img");
    }
    // CONTROL: the PDF download keeps its own wording, and an unknown type its key.
    expect(words(await page.evaluate(() => window.formatEventChange({ event_type: "badge_certificate_downloaded", details: { nickname: "nick" } }))))
      .toBe("Certificate PDF downloaded: nick");
    expect(await page.evaluate(() => window.formatEventChange({ event_type: "zz_unworded_probe", details: {} }))).toContain("zz_unworded_probe");
  });

  test("SOURCE SCANNER: every certificate record a History holds renders in words, never its raw key", async ({ page }) => {
    const { types, dynamic } = historyCertificateTypes();
    for (const k of KNOWN) expect(types.has(k), `anti-vacuity: the scan reaches "${k}"`).toBe(true);
    expect(dynamic, "every writer whose type is an expression is listed here, and its values collected").toEqual(DYNAMIC_SITES);
    await bootRenderer(page);
    const rendered = await page.evaluate((ts) => ts.map(t => [t,
      window.formatEventChange({ event_type: t, details: {} }),
      window.formatEventChange({ event_type: t, details: { nickname: "n", competition_name: "E", status: "sent", via: "automatic", by_owner: true, reason: "r" } }),
    ]), [...types].sort());
    for (const [t, bare, full] of rendered) {
      for (const h of [bare, full]) {
        expect(h, `${t}: give it words in formatEventChange (history.js)`).not.toContain(t);
        expect(words(h).length, `${t}: says something`).toBeGreaterThan(8);
      }
    }
  });
});

test.describe("History — real certificate records from their writers", () => {
  const W = {};
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const s = await apiLogin("superadmin");
    W.sa = s.api; W.saCsrf = s.csrf;
    W.comp = await makeCompetition(W.sa, W.saCsrf, "certwords");
    W.p = await makeParticipant(W.sa, W.saCsrf, "certwords");
    await enrol(W.sa, W.saCsrf, W.comp.id, [W.p.id]);
    W.tag = uniq("cw").replace(/[^a-zA-Z0-9]/g, "");
    W.token = `CW${W.tag}`;
    W.reason = `Issued to the wrong person ${W.tag}`;
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare(`INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot, created_at, basis)
                  VALUES (?, ?, ?, NULL, 4, 'none', ?, ?, 'participation')`).run(W.token, W.p.id, W.comp.id, W.p.nickname, new Date().toISOString());
    } finally { db.close(); }
    // A share by someone holding the link who is not its holder, then the holder's own.
    const anon = await freshCtx();
    try {
      const r = await anon.api.post(`/badge/${W.token}/shared`, { headers: H(anon.csrf) });
      expect(r.status(), await r.text()).toBe(200);
    } finally { await anon.api.dispose(); }
    const holder = await apiLogin(W.p.email, PARTICIPANT_PASS);
    try {
      const r = await holder.api.post(`/badge/${W.token}/shared`, { headers: H(holder.csrf) });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).published, "PRECONDITION: the holder's own share").toBe(true);
    } finally { await holder.api.dispose(); }
    const rv = await W.sa.post(`/api/admin/badges/${W.token}/revoke`, { headers: H(W.saCsrf), data: { reason: W.reason } });
    expect(rv.status(), await rv.text()).toBe(200);
    // PRECONDITION: the writers recorded what the History reads (past every projection).
    const rdb = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const shares = rdb.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='badge_shared' ORDER BY rowid").all(W.comp.id)
        .map(r => JSON.parse(r.details).by_owner);
      expect(shares, "two shares: not by its holder, then by its holder").toEqual([false, true]);
      const rev = rdb.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='badge_revoked'").all(W.p.id).map(r => JSON.parse(r.details));
      expect(rev.map(d => [d.competition_name, d.reason])).toEqual([[W.comp.name, W.reason]]);
    } finally { rdb.close(); }
  });
  test.afterAll(async () => { if (W.sa) await W.sa.dispose(); });

  test("the event's History says who shared it and how; the person's says the revocation and why; the Type column keeps the key", async ({ page }) => {
    test.setTimeout(120_000);
    const { adminLogin } = require("./ui-admin-helpers");
    await adminLogin(page);
    await page.waitForFunction(() => typeof window.showCompetitionHistory === "function" && typeof window.showUserHistory === "function");
    const ov = page.locator("#hist-overlay");
    const cells = (type) => ov.locator("#hist-body tr", { has: page.locator(".history-type-badge", { hasText: new RegExp(`^${type}$`, "i") }) })
      .locator(".history-change-cell");

    await page.evaluate((id) => { window.showCompetitionHistory(id); }, W.comp.id);
    await expect(ov).toBeVisible({ timeout: 15000 });
    await expect(cells("badge_shared")).toHaveCount(2, { timeout: 15000 });
    const shared = (await cells("badge_shared").allTextContents()).map(t => t.replace(/\s+/g, " ").trim()).sort();
    expect(shared).toEqual([`Certificate shared: ${W.p.nickname}`, `Certificate shared: ${W.p.nickname} — not by its holder`].sort());
    await ov.locator('[data-action="history-close"]').click();
    await expect(ov).toHaveCount(0, { timeout: 10000 });

    await page.evaluate((id) => { window.showUserHistory(id); }, W.p.id);
    await expect(ov).toBeVisible({ timeout: 15000 });
    await expect(cells("badge_revoked")).toHaveCount(1, { timeout: 15000 });
    const revoked = cells("badge_revoked");
    await expect(revoked).toContainText(`Certificate revoked: ${W.comp.name}`);
    await expect(revoked).toContainText(`Reason: ${W.reason}`);
    expect(await revoked.textContent(), "the change names no raw key").not.toContain("badge_revoked");
    await ov.locator('[data-action="history-close"]').click();
  });
});
