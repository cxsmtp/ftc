// @ts-check
"use strict";

// Polish-capture fixtures for the "ad" group: admin panes, admin dialogs and the
// server-rendered pages (tests/_ui-polish.spec.js, `fixture <name> [as <key>]`).
//
// Each fixture builds its OWN events, people and challenges through the real
// doors (the admin API, the participant API, the email-first sign-up), with
// names that cannot collide with the seed (alice/bob/carol, "Test Live", …) or
// with another group's fixtures. Fixtures that sign in as the built-in
// superadmin must run BEFORE the route's `apiLogin superadmin`: that account
// holds one session, so a later sign-in here would end the page's.
//
// The builders that are costly (a minted certificate, a staged email change, a
// capped challenge) are memoised for the life of the worker, so every capture of
// one screen shows the same person and event. A failed build is forgotten, so
// the next capture tries again. A worker restart (after any failure) re-reads
// this module and re-seeds the server, so a memo never outlives its database.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { request } = require("@playwright/test");

let _seq = 0;
const stamp = () => `${Date.now().toString(36)}${(++_seq).toString(36)}`;
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** One memoised async builder; a rejected build is not kept. */
function once(build) {
  let p = null;
  return (...args) => {
    if (!p) p = build(...args).catch((e) => { p = null; throw e; });
    return p;
  };
}

/** The test server's own database, for what no door exposes (see each caller). */
function withDb(helpers, fn, { readonly = false } = {}) {
  const Database = require("better-sqlite3");
  const db = new Database(helpers.TEST_DB_PATH, { readonly, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally { db.close(); }
}

async function asSuperadmin(helpers, fn) {
  const { api, csrf } = await helpers.apiLogin("superadmin");
  try {
    return await fn(api, { "x-csrf-token": csrf, "content-type": "application/json" });
  } finally { await api.dispose(); }
}

async function must(res, what) {
  if (!res.ok()) throw new Error(`fixture: ${what} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** A real participant through the email-first sign-up, verified and approved. */
async function makeParticipant(helpers, api, h, p) {
  const r = await helpers.registerPost(api, `${helpers.BASE}/api/register`, {
    headers: h, keepState: true,
    data: {
      firstName: p.first, lastName: p.last, email: p.email, company: p.company || "Northwind Labs",
      title: p.title || "Security Engineer", country: "GB", timezone: "Europe/London",
      jobFunction: "Software Developer / Engineer", city: "Leeds", avatar: p.avatar || "🦉",
    },
  });
  const d = await must(r, `register ${p.email}`);
  if (!d.id) throw new Error(`fixture: register ${p.email} answered no id: ${JSON.stringify(d)}`);
  return d.id;
}

async function makeEvent(api, h, name, { startOffsetMin = -20, durationMin = 120 } = {}) {
  const d = await must(await api.post("/api/admin/competitions", { headers: h, data: {
    name, start_time: new Date(Date.now() + startOffsetMin * 60_000).toISOString(), duration_minutes: durationMin,
  } }), `create event ${name}`);
  if (!d.competition || !d.competition.id) throw new Error(`fixture: event ${name} answered no id`);
  return d.competition.id;
}

async function makeChallenge(api, h, data) {
  const d = await must(await api.post("/api/admin/tasks", { headers: h, data: {
    description: "<p>Find the flag hidden in the request log and enter it below.</p>",
    difficulty: "easy", answer_type: "text", status: "published", ...data,
  } }), `create challenge ${data.title}`);
  return d.id;
}

async function enrol(api, h, userIds, compId) {
  const d = await must(await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds, competitionIds: [compId] } }), "assign");
  if (d.assigned !== userIds.length) throw new Error(`fixture: assign attached ${d.assigned} of ${userIds.length}`);
}

/** A signed-in participant request context (the emailed-code door). */
async function participantCtx(helpers, email) {
  const ctx = await request.newContext({ baseURL: helpers.BASE });
  const r = await helpers.codeLogin(ctx, email);
  if (!r.ok()) { await ctx.dispose(); throw new Error(`fixture: sign-in for ${email} failed: ${r.status()} ${await r.text()}`); }
  const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
  return { ctx, h: { "x-csrf-token": csrf, "content-type": "application/json" } };
}

// ── a minted, shared certificate ─────────────────────────────────────────────
// One participant, one challenge, solved: the all-solved auto-end ends the
// event (End Now if it did not), the participant mints the certificate through
// the participant's own door and shares it (publish-on-share), so /badge/<token>
// is live and /credential resolves its code.
//
// The LinkedIn share link (/badge/<link>/post) is the one thing no door hands
// out: the dispatcher mints it only into the congratulations email, storing a
// sha256, and the shared test server's relay is dead by design (localhost:587,
// TLS required), so the plaintext never leaves the server. The link row is
// therefore written here, exactly as lib/certificate-share.js mintShareLink
// writes it (hash of a 32-byte base64url token, seven days), for the
// certificate the real door minted.
const _cert = once(async (helpers) => {
  const id = stamp();
  const person = { first: "Mira", last: "Kowalski", email: `ad-mira-${id}@acme.com`, avatar: "🦊" };
  const answer = `flag-${id}`;
  const built = await asSuperadmin(helpers, async (api, h) => {
    const compId = await makeEvent(api, h, `Spring Secure Coding Cup ${id}`);
    const taskId = await makeChallenge(api, h, { title: `Log Detective ${id}`, correct_answer: answer });
    await must(await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } }), "assign challenge");
    const userId = await makeParticipant(helpers, api, h, person);
    await enrol(api, h, [userId], compId);
    return { compId, taskId, userId };
  });
  const { ctx, h } = await participantCtx(helpers, person.email);
  let badge;
  try {
    await must(await ctx.post("/api/select-competition", { headers: h, data: { competitionId: built.compId } }), "select event");
    const gradingHash = await helpers.gradingHashFor(ctx, built.taskId);
    const sub = await must(await ctx.post(`/api/tasks/${built.taskId}/submit`, { headers: h, data: { answer, gradingHash } }), "submit");
    if (!sub.correct) throw new Error(`fixture: the certificate challenge was not graded correct: ${JSON.stringify(sub)}`);
    // The all-solved auto-end normally ends it on that answer; End Now otherwise.
    const ended = await asSuperadmin(helpers, async (api, ah) => {
      const endedAt = async () => {
        const list = await must(await api.get("/api/admin/competitions"), "list events");
        const row = (Array.isArray(list) ? list : []).find((c) => c.id === built.compId);
        return !!(row && row.ended_at);
      };
      for (let i = 0; i < 20; i++) {
        if (await endedAt()) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      await api.post(`/api/admin/competitions/${built.compId}/end-now`, { headers: ah, data: {} });
      return endedAt();
    });
    if (!ended) throw new Error("fixture: the certificate event did not end");
    badge = await must(await ctx.post(`/api/competitions/${built.compId}/badge`, { headers: h, data: {} }), "mint certificate");
    await must(await ctx.post(`/badge/${badge.token}/shared`, { headers: h, data: {} }), "share certificate");
  } finally { await ctx.dispose(); }
  if (!badge || !badge.token || !badge.publicCode) throw new Error(`fixture: the mint answered no token or code: ${JSON.stringify(badge)}`);
  const link = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  withDb(helpers, (db) => db.prepare(
    "INSERT INTO certificate_share_links (id_hash, badge_token, created_at, expires_at) VALUES (?,?,?,?)"
  ).run(crypto.createHash("sha256").update(link).digest("hex"), badge.token, new Date(now).toISOString(), new Date(now + 7 * 24 * 3600_000).toISOString()));
  return { token: badge.token, code: badge.publicCode, surname: person.last, email: person.email, shareLink: link, compId: built.compId };
});

// ── a staged primary-email change ───────────────────────────────────────────
// A superadmin corrects a participant's address (staged, never applied); the
// confirmation code is mailed only to the new address, so it is read back from
// the database (read-only), as tests/admin-email-change-window.spec.js does.
const _emailChange = once(async (helpers) => {
  const id = stamp();
  const userId = await asSuperadmin(helpers, async (api, h) => {
    const uid = await makeParticipant(helpers, api, h, { first: "Lena", last: "Fischer", email: `ad-lena-${id}@acme.com` });
    await must(await api.put(`/api/admin/participants/${uid}`, { headers: h, data: { email: `lena.fischer-${id}@northwind-labs.com` } }), "stage email change");
    return uid;
  });
  const row = withDb(helpers, (db) => db.prepare("SELECT pending_email_code FROM users WHERE id=?").get(userId), { readonly: true });
  if (!row || !row.pending_email_code) throw new Error("fixture: the email change was not staged");
  return { code: row.pending_email_code };
});

// ── a challenge with an attempt limit, in a live event with people ──────────
const _capped = once(async (helpers) => {
  const id = stamp();
  return asSuperadmin(helpers, async (api, h) => {
    const compId = await makeEvent(api, h, `Capture the Flag Night ${id}`, { startOffsetMin: -15, durationMin: 240 });
    const title = `Three Tries ${id}`;
    const taskId = await makeChallenge(api, h, { title, correct_answer: `flag-${id}`, attempt_cap: 3 });
    await must(await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } }), "assign capped challenge");
    const a = await makeParticipant(helpers, api, h, { first: "Priya", last: "Natarajan", email: `ad-priya-${id}@acme.com`, avatar: "🐼" });
    const b = await makeParticipant(helpers, api, h, { first: "Tom", last: "Becker", email: `ad-tom-${id}@acme.com`, avatar: "🐙" });
    await enrol(api, h, [a, b], compId);
    return { title, compId };
  });
});

// ── a group with two members, bound to an event ─────────────────────────────
// Nothing seeds a group, so the Groups pane's Members and Events dialogs (and
// the "Or choose existing" chips of Add to group) would show nobody and nothing.
// Its own event and people, bound through the assign door (live-synced).
const _group = once(async (helpers) => {
  const id = stamp();
  return asSuperadmin(helpers, async (api, h) => {
    const compId = await makeEvent(api, h, `Partner Enablement Day ${id}`, { startOffsetMin: -10, durationMin: 240 });
    const a = await makeParticipant(helpers, api, h, { first: "Aiko", last: "Tanaka", email: `ad-aiko-${id}@acme.com`, avatar: "🦋" });
    const b = await makeParticipant(helpers, api, h, { first: "Diego", last: "Ramos", email: `ad-diego-${id}@acme.com`, avatar: "🦁" });
    const name = `Northwind Pilot ${id}`;
    const g = await must(await api.post("/api/admin/groups", { headers: h, data: { name, userIds: [a, b] } }), "create group");
    const groupId = g.group && g.group.id;
    if (!groupId) throw new Error(`fixture: the group create answered no id: ${JSON.stringify(g)}`);
    await must(await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [groupId], competitionIds: [compId] } }), "bind the group");
    return { name, groupId, compId };
  });
});

module.exports = {
  // Users & roles lists the accounts that run the platform; the built-in
  // superadmin has no row, so a fresh server lists nobody. One admin and one
  // event admin, created once through Add user (a repeat answers 409).
  adAdmins: async ({ helpers }) => {
    await asSuperadmin(helpers, async (api, h) => {
      for (const u of [
        { email: "ad-dana.reyes@acme.com", role: "admin", first_name: "Dana", last_name: "Reyes" },
        { email: "ad-omar.haddad@acme.com", role: "event_admin", first_name: "Omar", last_name: "Haddad" },
      ]) {
        const r = await api.post("/api/admin/users", { headers: h, data: u });
        if (!r.ok() && r.status() !== 409) throw new Error(`fixture: add ${u.email} failed: ${r.status()} ${await r.text()}`);
      }
    });
    return {};
  },

  adCert: async ({ helpers }) => _cert(helpers),
  adEmailChange: async ({ helpers }) => _emailChange(helpers),
  adCapped: async ({ helpers }) => _capped(helpers),
  adGroup: async ({ helpers }) => _group(helpers),

  // The People table shows six columns by default; the Tags and Groups cells,
  // whose "+ tag" and "+ group" chips open Add Tag and Add to Group, are behind
  // Columns. This browser shows them (an exact list of the columns shown, as
  // tests/ui-admin-helpers.js showAllParticipantColumns seeds it), before the
  // first page load: run it before the route's goto.
  adPeopleColumns: async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("ha:p-cols", JSON.stringify(["participant", "company", "status", "score", "last_active", "tags", "groups", "actions"]));
      } catch (_) { /* no storage: the default six stay, and the route's click fails by name */ }
    });
    return {};
  },

  // A real participants export (the superadmin's own Export JSON), cut down to
  // the three seeded people: every row then collides with an existing account,
  // which is what the conflict step needs. Written to a temp file for `upload`.
  adImportFile: async ({ helpers }) => {
    const data = await asSuperadmin(helpers, async (api) => must(await api.get("/api/admin/export/participants"), "export participants"));
    const keep = new Set(["alice@acme.com", "bob@acme.com", "carol@acme.com"]);
    const participants = (data.participants || []).filter((p) => keep.has(String(p.email || "").toLowerCase()));
    if (participants.length !== keep.size) throw new Error(`fixture: the export held ${participants.length} of the seeded people`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polish-ad-import-"));
    const file = path.join(dir, "participants-export.json");
    fs.writeFileSync(file, JSON.stringify({ ...data, participants }, null, 2));
    return { file, cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
  },

  // An unsubscribe link exactly as lib/email.js generateUnsubscribeToken signs it
  // (HMAC-SHA256 over the raw JSON, keyed by the raw bytes of the server's
  // DATA_DIR/.unsubscribe-secret), the recipe CLAUDE.md gives for specs.
  adUnsub: async ({ helpers }) => {
    const secret = fs.readFileSync(path.join(helpers.TEST_DATA_DIR, ".unsubscribe-secret"));
    const payload = JSON.stringify({ e: "jordan.ellis@northwind-labs.com", x: Date.now() + 365 * 24 * 3600_000 });
    return { token: `${b64url(payload)}.${b64url(crypto.createHmac("sha256", secret).update(payload).digest())}` };
  },

  // A blocked-address alert in the server's own store (test-only hook); cleared
  // after the capture, or it would open over every later admin screen.
  adIpBan: async ({ page }) => {
    const r = await page.request.post("/api/test/raise-ip-ban-alert", { data: {
      ip: "198.51.100.23", count4xx: 214, competitionName: "Test Live", competitionId: "polish-ad", acceptsTrustedIps: true,
    } });
    await must(r, "raise ip-ban alert");
    return { cleanup: async () => { await page.request.post("/api/test/clear-ip-ban-alerts"); } };
  },

  // Maintenance mode is the operator's switch: the existence of
  // DATA_DIR/.maintenance (its content the bypass token). Engaged for this one
  // capture and removed after it, pass or fail.
  adMaintenance: async ({ helpers }) => {
    const file = path.join(helpers.TEST_DATA_DIR, ".maintenance");
    if (fs.existsSync(file)) throw new Error("fixture: the test server is already in maintenance mode");
    fs.writeFileSync(file, `polish-ad-${stamp()}\n`);
    return { cleanup: async () => fs.rmSync(file, { force: true }) };
  },
};
