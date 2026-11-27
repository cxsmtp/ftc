"use strict";

// THE AUDIT PAGE'S ACTIVITY WORDING — public/js/features/audit-admin.js.
//
// The Activity column showed raw event_type keys (`data_exported`,
// `superadmin_login_success`, `submission_wrong`). It now shows plain words from
// AUDIT_ACTIVITY_LABELS, with the raw key kept in the details dialog and as its
// own CSV column, and the search matching both. Pinned here:
//
//   - a known key reads as its wording; an unknown key falls back to itself with
//     underscores spaced and the first letter capitalised (never blank);
//   - SOURCE SCANNER: every literal event type the server records (the
//     record*Event / recordOrphanedAuditEvent / createTaskVersion calls, the
//     task-event map, the CxOne removal emits, the badge downloads, the audit
//     route's own submission and hint types) has wording — a decision per type,
//     with a floor so a renamed writer cannot make it match nothing, and the
//     call sites whose type is a VARIABLE listed so a new one is looked at;
//   - the route: `q_event_types` widens `q` (a row whose key is listed matches
//     though its key does not contain the text), is ignored without `q`, and a
//     list over 50 names is refused;
//   - the pane: the planted row reads in words, its details dialog and the CSV
//     keep the key, and a search for the WORDING finds it.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin } = require("./helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const ROOT = path.join(__dirname, "..");
const T = `${Date.now()}${process.pid % 1000}`;

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

// Which argument carries the event type, per writer.
const TYPE_ARG = { recordCompetitionEvent: 1, recordTimeslotEvent: 1, recordUserEvent: 1, recordSettingsEvent: 1,
  recordOrphanedAuditEvent: 2, recordTaskAuditEvent: 2, createTaskVersion: 2 };
// Call sites whose type is an expression, each looked at: its values are
// collected by the dedicated patterns below. A new one fails until it is added
// here and its values are reachable.
const DYNAMIC_SITES = [
  "lib/audit.js|recordOrphanedAuditEvent|_TASK_EVENT_TYPE_MAP.sealed_reveal",
  "lib/audit.js|recordOrphanedAuditEvent|eventType",
  "lib/audit.js|recordOrphanedAuditEvent|eventType",
  "lib/cxone-withdraw.js|recordOrphanedAuditEvent|eventType",
  "routes/badge.js|recordCompetitionEvent|kind",
  "server.js|recordCompetitionEvent|evType",
  "server.js|recordTimeslotEvent|evType",
  "server.js|recordUserEvent|evType",
];

function emittedTypes() {
  const types = new Set();
  const dynamic = [];
  const files = [path.join(ROOT, "server.js"), ...jsFiles(path.join(ROOT, "lib")), ...jsFiles(path.join(ROOT, "routes"))];
  const re = /\b(queueEvent|recordCompetitionEvent|recordTimeslotEvent|recordUserEvent|recordSettingsEvent|recordOrphanedAuditEvent|recordTaskAuditEvent|createTaskVersion)\s*\(/g;
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    const src = stripJsComments(fs.readFileSync(f, "utf8"));
    let m;
    while ((m = re.exec(src))) {
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;   // the definition
      let a = callArgs(src, m.index + m[0].length - 1);
      let fn = m[1];
      if (fn === "queueEvent") { fn = String(a[0] || "").trim().replace(/^.*\./, ""); a = a.slice(1); }
      if (!(fn in TYPE_ARG)) continue;
      const expr = String(a[TYPE_ARG[fn]] || "").trim();
      const lits = [...expr.matchAll(/['"]([a-z][a-z0-9_]+)['"]/g)].map(x => x[1]);
      if (!lits.length) { dynamic.push(`${rel}|${fn}|${expr}`); continue; }
      lits.forEach(l => types.add(l));
    }
    // The dynamic sites' values.
    if (rel === "server.js") for (const x of src.matchAll(/evType\s*=\s*[^;]*?"([a-z_]+)"\s*:\s*"([a-z_]+)"/g)) { types.add(x[1]); types.add(x[2]); }
    if (rel === "lib/audit.js") {
      const map = src.match(/_TASK_EVENT_TYPE_MAP\s*=\s*\{([\s\S]*?)\};/);
      if (map) for (const x of map[1].matchAll(/:\s*"([a-z_]+)"/g)) types.add(x[1]);
    }
    if (rel === "lib/cxone-withdraw.js") for (const x of src.matchAll(/_emit\(\s*\w+\s*,\s*"([a-z_]+)"/g)) types.add(x[1]);
    // The badge downloads: the type is the FOURTH argument, by position (a call
    // may add the details it alone knows after it, as the email link's `via`).
    if (rel === "routes/badge.js") for (const x of src.matchAll(/\b_recordBadgeDownload\s*\(/g)) {
      if (/function\s*$/.test(src.slice(Math.max(0, x.index - 12), x.index))) continue;   // the definition
      const a = callArgs(src, x.index + x[0].length - 1);
      const lits = [...String(a[3] || "").matchAll(/['"]([a-z][a-z0-9_]+)['"]/g)].map(l => l[1]);
      if (!lits.length) dynamic.push(`${rel}|_recordBadgeDownload|${String(a[3] || "").trim()}`);
      lits.forEach(l => types.add(l));
    }
    // The audit route's own types for submissions and hints.
    if (rel === "routes/audit.js") for (const x of src.matchAll(/\bet:\s*"([^"]+)"/g)) for (const y of x[1].matchAll(/'([a-z]+_[a-z_]+)'/g)) types.add(y[1]);
  }
  // task_versions rows carry the raw change_type (the challenge_version source).
  return { types, dynamic: dynamic.sort() };
}

async function bootLabels(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.AUDIT_ACTIVITY_LABELS && typeof window.auditActivityLabel === "function", null, { timeout: 20000 });
}

test.describe("Audit — activity wording", () => {
  test("known key → its wording; unknown key → spaced and capitalised", async ({ page }) => {
    await bootLabels(page);
    const r = await page.evaluate(() => ({
      exported: window.auditActivityLabel("data_exported"),
      breakglass: window.auditActivityLabel("superadmin_login_success"),
      wrong: window.auditActivityLabel("submission_wrong"),
      signedIn: window.auditActivityLabel("login_success"),
      unknown: window.auditActivityLabel("zz_brand_new_thing"),
      doubled: window.auditActivityLabel("odd__key_"),
      empty: window.auditActivityLabel(""),
      nul: window.auditActivityLabel(null),
      proto: window.auditActivityLabel("constructor"),
      match: window.auditActivityKeysMatching("signed in"),
      matchKey: window.auditActivityKeysMatching("data exported"),
      tooShort: window.auditActivityKeysMatching("s"),
    }));
    expect(r.exported).toBe("Data exported");
    expect(r.breakglass).toBe("Break-glass sign-in");
    expect(r.wrong).toBe("Wrong answer");
    // CONTROL — the wording is not the fallback: a known key reads differently.
    expect(r.signedIn).toBe("Signed in");
    expect(r.signedIn).not.toBe("Login success");
    expect(r.unknown).toBe("Zz brand new thing");
    expect(r.doubled).toBe("Odd key");
    expect(r.empty).toBe("");
    expect(r.nul).toBe("");
    expect(r.proto, "an inherited property name is a key like any other").toBe("Constructor");
    expect(r.match, "the wording search finds the key").toContain("login_success");
    expect(r.match).not.toContain("logout_manual");
    expect(r.matchKey, "the spaced key matches too").toContain("data_exported");
    expect(r.tooShort).toEqual([]);
  });

  test("SOURCE SCANNER: every event type the server records has wording", async ({ page }) => {
    const { types, dynamic } = emittedTypes();
    expect(types.size, "anti-vacuity: the scan finds the writers' types").toBeGreaterThan(140);
    for (const k of ["data_exported", "superadmin_login_success", "submission_wrong", "hint_revealed",
      "sealed_answer_revealed", "cxone_realm_account_withdrawn", "badge_image_downloaded", "badge_certificate_downloaded", "badge_shared"]) {
      expect(types.has(k), `anti-vacuity: the scan reaches "${k}"`).toBe(true);
    }
    expect(dynamic, "every call site whose type is an expression is listed (and its values collected)").toEqual(DYNAMIC_SITES);
    await bootLabels(page);
    const labelled = new Set(await page.evaluate(() => Object.keys(window.AUDIT_ACTIVITY_LABELS)));
    const missing = [...types].filter(k => !labelled.has(k)).sort();
    expect(missing, "give each new event type plain wording in AUDIT_ACTIVITY_LABELS").toEqual([]);
  });

  test("the route: q_event_types widens the search, is ignored without q, and is capped", async () => {
    const s = await apiLogin("superadmin");
    const KEY = `zzlabel_probe_${T}`;
    const ACT = `actor-${T}@labels.example`;
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(require("crypto").randomUUID(), "test", "labels", KEY, ACT, new Date().toISOString(), null, null, null);
    } finally { db.close(); }
    const get = async (qs) => { const r = await s.api.get(`/api/admin/audit?types=log_event&${qs}`); return { status: r.status(), body: await r.json().catch(() => null) }; };
    const has = (b) => !!(b && Array.isArray(b.rows) && b.rows.some(x => x.event_type === KEY));
    // CONTROL — the row exists and its own key finds it.
    expect(has((await get(`q=${encodeURIComponent(KEY)}&n=1`)).body)).toBe(true);
    const words = `nothing-matches-${T}`;
    expect(has((await get(`q=${words}&n=2`)).body), "the text alone does not match").toBe(false);
    expect(has((await get(`q=${words}&q_event_types=${KEY}&n=3`)).body), "a listed key widens the search").toBe(true);
    // Ignored without q: it is never a filter of its own (the actor filter narrows to the row).
    const noQ = await get(`actor=${encodeURIComponent(ACT)}&q_event_types=some_other_key&n=4`);
    expect(has(noQ.body), "without q the list is not narrowed by it").toBe(true);
    const many = Array.from({ length: 51 }, (_, i) => `k${i}`).join(",");
    const over = await get(`q=x&q_event_types=${many}&n=5`);
    expect(over.status).toBe(400);
    expect(over.body && over.body.code).toBe("audit_q_event_types_invalid");
  });

  test("the pane: wording in the table, the key in details and CSV, wording search finds the row", async ({ page }) => {
    test.setTimeout(120_000);
    const ACT = `pane-${T}@labels.example`;
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("INSERT INTO orphan_events (id, scope, scope_id, event_type, changed_by, changed_at, competition_id, timeslot_id, details) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(require("crypto").randomUUID(), "badge", "labels", "badge_minted", ACT, new Date().toISOString(), null, null, JSON.stringify({ note: "planted" }));
    } finally { db.close(); }
    await page.setViewportSize({ width: 1440, height: 900 });
    const { adminLogin } = require("./ui-admin-helpers");
    await adminLogin(page);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 25000 });
    await page.evaluate(() => window.adminTab(document.querySelector('.admin-nav-item[data-tab-id="admin-audit-tab"]'), "admin-audit-tab"));
    await page.locator("#admin-audit-tab").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#audit-actor").fill(ACT);
    await page.locator("#audit-actor").dispatchEvent("change");
    const row = page.locator("#admin-audit-body tr", { hasText: ACT });
    await expect(row).toHaveCount(1, { timeout: 15000 });
    const cell = row.locator("td.audit-activity");
    await expect(cell).toHaveText("Certificate issued");
    await expect(cell).toHaveAttribute("data-event-type", "badge_minted");
    // The details dialog keeps the key.
    await row.locator('[data-action="audit-row-details"]').click();
    const dlg = page.locator("#audit-detail-overlay [role=dialog]");
    await expect(dlg).toContainText("Certificate issued");
    await expect(dlg.locator("dt", { hasText: /^Activity key$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("badge_minted");
    await page.keyboard.press("Escape");
    await expect(page.locator("#audit-detail-overlay")).toHaveCount(0);
    // The CSV carries both.
    const dl = page.waitForEvent("download");
    await page.locator("#audit-export").click();
    const file = await (await dl).path();
    const csv = fs.readFileSync(file, "utf8");
    const header = csv.replace(/^﻿/, "").split("\n")[0];
    expect(header).toContain('"Activity","Activity key"');
    const line = csv.split("\n").find(l => l.includes(ACT));
    expect(line, "the planted row is in the CSV").toBeTruthy();
    expect(line).toContain('"Certificate issued","badge_minted"');
    // A search for the WORDING finds it (the key does not contain those words).
    const req = page.waitForRequest(r => r.url().includes("/api/admin/audit?") && /q_event_types=[^&]*badge_minted/.test(decodeURIComponent(r.url())));
    await page.locator("#audit-search").pressSequentially("certificate issued", { delay: 20 });
    await req;
    await expect(row).toHaveCount(1, { timeout: 15000 });
    // CONTROL — a search that matches nothing empties the list.
    await page.locator("#audit-search").fill(`no-such-words-${T}`);
    await page.locator("#audit-search").dispatchEvent("input");
    await expect(row).toHaveCount(0, { timeout: 15000 });
  });
});
