// @ts-check
//
// v7.23.0 — a participant missing a mandatory profile field must be able to
// COMPLETE the gate. Before this fix, one specific field could not be.
//
// `openProfileCompletionGate` used `id="gate-title"` twice: on the Work Title
// <input> and on the dialog's <h3>. The <h3> precedes ${titleRow} in the
// assembled markup, so `getElementById('gate-title')` returned the HEADING.
// The required-field filter is
//     gateReqs.filter(({id}) => !document.getElementById(id)?.value)
// and an <h3> has no `.value` — so `undefined` made it permanently "missing",
// the save reported "Required: Title." for ever, and `focus()` landed on
// <body>. The gate is non-dismissible (no X, no Cancel, no Escape) and
// `requireCompleteProfile` gates every participant endpoint server-side, so the
// account was unusable with no self-service escape. Reachable in production:
// the participant import writes `p.title || ""` on both create and overwrite.
//
// The COMPANY case is the control. It exercises the identical code path through a
// field whose id never collided, so a harness fault (gate never opens, save
// never fires, fixture wrong) fails BOTH cases while the real defect fails only
// the title case. Without it, "title closes the gate" cannot be distinguished
// from "the gate closes on anything".
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

function withDb(fn) {
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

async function saCtx() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", {
    headers: H(csrf), data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A verified+approved participant with exactly ONE mandatory field blanked. */
async function participantMissing(api, csrf, field, tag) {
  const email = `gate-${tag}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Gate", lastName: "Probe", nickname: `gate_${tag}`, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), await reg.text()).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find((p) => p.email === email);
  expect(u, "fresh participant must be findable").toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });

  // Blank the field directly. PUT /api/me refuses to clear a mandatory field
  // (400) and the admin route uses fillRequired, which keeps the current value
  // on an empty incoming one (v7.15.8) — so neither API can produce this state,
  // which is the point: it arrives via the import path or an older admin save.
  withDb((d) => d.prepare(`UPDATE users SET ${field}=NULL WHERE id=?`).run(u.id));
  return { email, id: u.id };
}

async function driveGate(page, email, field, inputId, value) {
  const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, email, H(tok));
  expect(li.ok(), `${email} login: ${li.status()} ${await li.text()}`).toBeTruthy();

  await page.goto("/");
  const overlay = page.locator("#profile-gate-overlay");
  await overlay.waitFor({ state: "visible", timeout: 20000 });

  const input = page.locator(`#${inputId}`);
  await expect(input, `${field}: the gate must render an input for the missing field`).toBeVisible();

  // The input must have an accessible name — the duplicate id also broke this,
  // because `label[for]` resolved to an <h3>, which is not a labelable element.
  const named = await input.evaluate((el) => {
    const lbl = el.labels && el.labels.length ? el.labels[0].textContent : "";
    return ((el.getAttribute("aria-label") || "") + " " + (lbl || "")).trim();
  });
  expect(named.length, `${field}: input has no accessible name`).toBeGreaterThan(0);

  await input.fill(value);
  await page.locator("#gate-save-btn").click();

  // The guarantee: the gate CLOSES. Failing this is the lockout.
  await overlay.waitFor({ state: "detached", timeout: 20000 });
}

test("v7.23.0: a participant missing Work Title can complete the gate (was a permanent lockout)", async ({ page }) => {
  const { api, csrf } = await saCtx();
  const u = await participantMissing(api, csrf, "title", "title");

  await driveGate(page, u.email, "title", "gate-work-title", "Principal Engineer");

  // The value must actually persist — a gate that closes without saving would
  // simply re-open on the next authenticated entry.
  const row = withDb((d) => d.prepare("SELECT title FROM users WHERE id=?").get(u.id));
  expect(row.title, "the typed Work Title must be stored").toBe("Principal Engineer");
  await api.dispose();
});

test("v7.23.0 control: a participant missing Company can complete the gate", async ({ page }) => {
  // Same code path, a field whose id never collided. If this fails too, the
  // fixture or the harness is wrong — not the title-specific defect. (Company,
  // not City: since the short form City is optional for every account, so a
  // blank one opens no gate.)
  const { api, csrf } = await saCtx();
  const u = await participantMissing(api, csrf, "company", "company");

  await driveGate(page, u.email, "company", "gate-company", "Lisbon Labs");

  const row = withDb((d) => d.prepare("SELECT company FROM users WHERE id=?").get(u.id));
  expect(row.company, "the typed Company must be stored").toBe("Lisbon Labs");
  await api.dispose();
});

test("v7.23.0: the gate renders no duplicate element ids", async ({ page }) => {
  // The root cause was a duplicate id, and it is cheap to assert directly:
  // getElementById returns the first match in document order, so ANY duplicate
  // inside an overlay silently redirects a lookup to the wrong node.
  const { api, csrf } = await saCtx();
  const u = await participantMissing(api, csrf, "title", "dupids");

  const tok = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  await codeLogin(page.request, u.email, H(tok));
  await page.goto("/");
  await page.locator("#profile-gate-overlay").waitFor({ state: "visible", timeout: 20000 });

  const dupes = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    const seen = new Set(), dup = new Set();
    for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); }
    return [...dup];
  });
  expect(dupes, `duplicate element ids while the profile gate is open: ${dupes.join(", ")}`).toEqual([]);
  await api.dispose();
});
