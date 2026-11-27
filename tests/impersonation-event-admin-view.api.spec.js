// @ts-check
//
// v8.12.1 — IMPERSONATING AN EVENT ADMIN IN THEIR OWN ADMIN VIEW.
//
// Before this release an impersonation session was always PARTICIPANT-SHAPED:
// `isAdmin` was never set, so an admin impersonating an event admin could look
// at that organiser's participant view and nothing else, and the view toggle was
// refused for every tier because it dropped the marker across its regenerate.
// Now the entry takes `{view: "admin"}` for an event-admin target, the session
// is ADMIN-SHAPED (`isAdmin` set, NEVER `isSuperAdmin`), the toggle switches
// between the two views WITHOUT leaving impersonation, and the seat is scoped
// and gated exactly as the organiser themselves would be.
//
// Every positive here has its control, because "the superadmin saw one event"
// is equally satisfied by a build that shows nobody anything, and "the write
// was refused" by a build that refuses every write. The controls are the
// organiser's OWN session (untouched throughout) and the participant-target
// shape, which this release does not change.
//
// Every fixture is this file's own (the fixture checklist); nothing seeded is
// promoted or enrolled.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, PARTICIPANT_PASS, BASE, TEST_DB_PATH, TEST_DATA_DIR, findLogLine, codeLogin } = require("./helpers");
const path = require("path");
const {
  H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin, buildWorld,
} = require("./event-admin-helpers");

test.use({ baseURL: BASE });

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}
function dbAll(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
function dbRun(sql, ...args) {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
}
/** The newest event of one type on a user's own history, details parsed. */
function lastUserEvent(userId, type) {
  const row = dbGet("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type=? ORDER BY changed_at DESC, rowid DESC LIMIT 1", userId, type);
  return row ? { changed_by: row.changed_by, details: JSON.parse(row.details || "{}") } : null;
}

/**
 * Enter impersonation from a fresh session. `who` is "superadmin" (built-in) or
 * an email; `body` is the request body ({view} or nothing). Returns the live
 * api context plus a fresh CSRF token — the entry regenerates the session.
 */
async function enter(who, targetId, body, password) {
  const s = who === "superadmin" ? await apiLogin("superadmin") : await apiLogin(who, password || PARTICIPANT_PASS);
  const r = await s.api.post(`/api/admin/participants/${targetId}/impersonate`, { headers: H(s.csrf), data: body || {} });
  const d = await r.json().catch(() => ({}));
  const t = await (await s.api.get("/api/csrf-token")).json();
  return { api: s.api, csrf: t.csrfToken, status: r.status(), body: d };
}
async function refreshCsrf(ctx) {
  const t = await (await ctx.api.get("/api/csrf-token")).json();
  ctx.csrf = t.csrfToken;
  return ctx.csrf;
}

/** A regular (global) admin account, verified + approved + promoted. */
async function makeAdmin(sa, saCsrf, label, role = "admin") {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label} to ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}

let W;         // the standard event-admin world
let ADM;       // a REGULAR admin (the read-only tier)
let SUP;       // a USER-BACKED superadmin — the acting tier for most tests

// THE BUILT-IN SUPERADMIN IS ONE SESSION, PLATFORM-WIDE. Every `apiLogin("superadmin")`
// purges the previous one (single-session enforcement), so a test that enters
// impersonation as the built-in account kills the world's fixture session and
// every later `makeParticipant(W.sa, …)` reads an empty list. Tests that need the
// built-in account call `relogSa()` on their way out; everything else acts as a
// user-backed superadmin, which is also the only shape that can be a competitor.
async function relogSa() {
  const l = await apiLogin("superadmin");
  W.sa = l.api; W.saCsrf = l.csrf;
}

test.beforeAll(async () => {
  W = await buildWorld();
  ADM = await makeAdmin(W.sa, W.saCsrf, "regadm");
  SUP = await makeAdmin(W.sa, W.saCsrf, "supadm", "superadmin");
});

test.afterAll(async () => {
  try { await W?.sa.dispose(); } catch (_) {}
  try { await W?.eaApi.dispose(); } catch (_) {}
  try { await W?.zeroApi.dispose(); } catch (_) {}
});

test.describe("Entering an event admin's ADMIN view (v8.12.1)", () => {
  test("view:'admin' opens an ADMIN-SHAPED session that is the organiser's seat — and never a superadmin's", async () => {
    const s = await enter("superadmin", W.ea.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body).toMatchObject({ ok: true, readOnly: false, view: "admin", target: { id: W.ea.id, role: "event_admin", email: W.ea.email } });

      const me = await (await s.api.get("/api/me")).json();
      expect(me.email).toBe(W.ea.email);
      expect(me.isAdminView, "the session reads as the ADMIN view").toBe(true);
      expect(me.isEventAdmin, "the TIER of the seat").toBe(true);
      expect(me.isSuperAdmin, "an impersonation session is never superadmin-shaped").toBeFalsy();
      expect(me.impersonation).toMatchObject({ active: true, superadmin: true, admin_label: "superadmin", view: "admin", target_role: "event_admin" });

      const am = await s.api.get("/api/admin/me");
      expect(am.status(), await am.text()).toBe(200);
      const ad = await am.json();
      expect(ad).toMatchObject({ ok: true, role: "event_admin", isAdmin: true, isSuperAdmin: false, isEventAdmin: true, eventAdminCompetitionCount: 1 });
      expect(ad.impersonation, "/api/admin/me carries the same block, so the admin shell can render the banner from it").toMatchObject({ active: true, superadmin: true, view: "admin", target_role: "event_admin" });

      // The audit row on the ORGANISER's history says which view was opened.
      const started = lastUserEvent(W.ea.id, "impersonation_started");
      expect(started, "impersonation_started recorded on the target").toBeTruthy();
      expect(started.changed_by).toBe("superadmin");
      expect(started.details).toMatchObject({ target_role: "event_admin", view: "admin", read_only: false });
      expect(started.details.ip, "carries the requester's IP (the standing rule)").toBeTruthy();

      // THE CONTROL: the organiser's OWN live session is untouched by somebody
      // looking through their seat.
      const own = await W.eaApi.get("/api/admin/me");
      expect(own.status(), "the target's own session keeps working").toBe(200);
      expect((await own.json()).impersonation, "…and is not itself an impersonation").toBeUndefined();
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
      await relogSa();
    }
  });

  test("the default view is still the participant one, and it reports the tier as a TIER", async () => {
    const s = await enter(SUP.email, W.ea.id);
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body.view).toBe("participant");
      const me = await (await s.api.get("/api/me")).json();
      expect(me.isAdminView).toBe(false);
      expect(me.isEventAdmin, "isEventAdmin is the tier, not the view — the participant nav offers Admin View on it").toBe(true);
      expect(me.impersonation).toMatchObject({ active: true, view: "participant", target_role: "event_admin", admin_label: SUP.email });
      // Participant-shaped: the admin surface is closed (401 from the inline
      // /api/admin/me check, 403 from requireAdmin — both "not an admin session").
      expect((await s.api.get("/api/admin/me")).status()).toBe(401);
      expect([401, 403]).toContain((await s.api.get("/api/admin/competitions")).status());
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("view:'admin' on a PARTICIPANT target is refused with a named code, and a bad view value too", async () => {
    const bad = await enter(SUP.email, W.inMine.id, { view: "admin" });
    try {
      expect(bad.status, JSON.stringify(bad.body)).toBe(400);
      expect(bad.body.code).toBe("impersonation_view_unavailable");
      // Nothing was established: the session is still the superadmin's own.
      expect((await (await bad.api.get("/api/admin/me")).json()).role).toBe("superadmin");
      expect((await (await bad.api.get("/api/me")).json()).email).toBe(SUP.email);
      const inv = await bad.api.post(`/api/admin/participants/${W.inMine.id}/impersonate`, { headers: H(bad.csrf), data: { view: "owner" } });
      expect(inv.status()).toBe(400);
      expect((await inv.json()).code).toBe("impersonation_view_invalid");
      // CONTROL: the participant view of the same target still opens.
      const ok = await bad.api.post(`/api/admin/participants/${W.inMine.id}/impersonate`, { headers: H(bad.csrf), data: { view: "participant" } });
      expect(ok.status(), await ok.text()).toBe(200);
      expect((await ok.json()).view).toBe("participant");
    } finally {
      await refreshCsrf(bad);
      await bad.api.post("/api/impersonation/exit", { headers: H(bad.csrf) }).catch(() => {});
      await bad.api.dispose();
    }
  });

  test("an EVENT ADMIN cannot open a fellow organiser's admin view (nor impersonate them at all)", async () => {
    // Two organisers of the same event, so the target is in scope and only the
    // peer rule can refuse.
    const peer = await makeParticipant(W.sa, W.saCsrf, "peer");
    await enrol(W.sa, W.saCsrf, W.mine.id, [peer.id]);     // in scope: enrolled in the shared event
    await grantEventAdmin(W.sa, W.saCsrf, W.mine.id, peer.id);
    const r = await W.eaApi.post(`/api/admin/participants/${peer.id}/impersonate`, { headers: H(W.eaCsrf), data: { view: "admin" } });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("event_admin_target_privileged");
    // CONTROL: the same organiser CAN still impersonate an ordinary participant of their event.
    const c = await W.eaApi.post(`/api/admin/participants/${W.inMine.id}/impersonate`, { headers: H(W.eaCsrf), data: { view: "participant" } });
    expect(c.status(), await c.text()).toBe(200);
    await refreshCsrf({ api: W.eaApi, csrf: W.eaCsrf }).then(async () => {
      const t = await (await W.eaApi.get("/api/csrf-token")).json();
      await W.eaApi.post("/api/impersonation/exit", { headers: H(t.csrfToken) });
      const t2 = await (await W.eaApi.get("/api/csrf-token")).json();
      W.eaCsrf = t2.csrfToken;
    });
    const back = await W.eaApi.get("/api/admin/me");
    expect(back.status(), "the organiser is back in their own session").toBe(200);
  });
});

test.describe("What the seat may see and do", () => {
  test("the admin view is SCOPED to the organiser's events, and a zero-grant organiser's seat sees nothing", async () => {
    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      const comps = await (await s.api.get("/api/admin/competitions")).json();
      const ids = comps.map(c => c.id);
      expect(ids, "the organiser's own event is listed").toContain(W.mine.id);
      expect(ids, "the DECOY they do not organise is NOT — the seat is narrowed exactly as the organiser is").not.toContain(W.theirs.id);
      expect(JSON.stringify(comps), "by VALUE: the decoy's name appears nowhere").not.toContain(W.theirs.name);

      const parts = await (await s.api.get("/api/admin/participants?limit=5000")).json();
      const emails = (parts.participants || []).map(p => p.email);
      expect(emails).toContain(W.inMine.email);
      expect(emails, "a participant enrolled only in the decoy is withheld").not.toContain(W.inTheirs.email);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
    // The empty-scope catcher: `[]` is not `null` (the v8.7.0 fail-open).
    const z = await enter(SUP.email, W.zero.id, { view: "admin" });
    try {
      expect(z.status, JSON.stringify(z.body)).toBe(200);
      const comps = await (await z.api.get("/api/admin/competitions")).json();
      expect(Array.isArray(comps)).toBe(true);
      expect(comps.length, "a zero-grant organiser's seat lists NO events — not every event").toBe(0);
      const parts = await (await z.api.get("/api/admin/participants?limit=5000")).json();
      expect((parts.participants || []).length).toBe(0);
    } finally {
      await z.api.post("/api/impersonation/exit", { headers: H(z.csrf) }).catch(() => {});
      await z.api.dispose();
    }
  });

  test("routes forbidden to the tier stay forbidden through the seat, and a superadmin's own powers do not leak in", async () => {
    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      const logs = await s.api.get("/api/admin/logs");
      expect(logs.status(), "the request log is platform-wide and refused to the tier").toBe(403);
      expect((await logs.json()).code).toBe("event_admin_forbidden");
      const settings = await s.api.get("/api/admin/settings");
      expect(settings.status()).toBe(403);
      // Creating an event is not the tier's, whatever the acting admin could do
      // from their own seat.
      const create = await s.api.post("/api/admin/competitions", { headers: H(s.csrf), data: { name: `Leak ${uniq("x")}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } });
      expect(create.status(), "POST /api/admin/competitions is forbidden to the seat").toBe(403);
      // A superadmin-only endpoint is refused too: the session is not superadmin-shaped.
      const retention = await s.api.post("/api/admin/retention/purge", { headers: H(s.csrf) });
      expect(retention.status(), "superadmin-only work is refused through an organiser's seat").toBe(403);
      // And the seat cannot grant itself company.
      const grant = await s.api.post(`/api/admin/competitions/${W.mine.id}/admins`, { headers: H(s.csrf), data: { userId: W.inMine.id } });
      expect(grant.status(), "the self-propagation bar holds through the seat").toBe(403);
      expect(dbGet("SELECT COUNT(*) c FROM competition_admins WHERE competition_id=? AND user_id=?", W.mine.id, W.inMine.id).c).toBe(0);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("a REGULAR admin's seat is read-only: every admin write 403s with the impersonation code and writes nothing", async () => {
    const s = await enter(ADM.email, W.ea.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body.readOnly).toBe(true);
      // Reads work — the whole point of the feature for this tier.
      const comps = await s.api.get("/api/admin/competitions");
      expect(comps.status()).toBe(200);
      expect((await comps.json()).map(c => c.id)).toContain(W.mine.id);
      expect((await s.api.get("/api/admin/tasks")).status()).toBe(200);
      // Writes do not.
      const before = dbGet("SELECT name FROM competitions WHERE id=?", W.mine.id).name;
      const blocked = [
        ["PUT", `/api/admin/competitions/${W.mine.id}`, { name: "ReadOnlyRename" }],
        ["POST", "/api/admin/tasks", { title: `RO ${uniq("t")}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "draft" }],
        ["POST", "/api/admin/competitions/assign", { userIds: [W.inTheirs.id], competitionIds: [W.mine.id] }],
      ];
      for (const [method, url, data] of blocked) {
        const r = method === "PUT" ? await s.api.put(url, { headers: H(s.csrf), data }) : await s.api.post(url, { headers: H(s.csrf), data });
        expect(r.status(), `${method} ${url} must be refused for the read-only tier`).toBe(403);
        expect((await r.json()).code, `${method} ${url} carries the impersonation_readonly code`).toBe("impersonation_readonly");
      }
      expect(dbGet("SELECT name FROM competitions WHERE id=?", W.mine.id).name).toBe(before);
      expect(dbGet("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?", W.mine.id, W.inTheirs.id).c).toBe(0);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("a REGULAR admin's read-only seat still RENDERS: the certificate preview and the join QR are POSTs that store nothing", async () => {
    // Both carry a body to render (an unsaved design; the join link and code),
    // so they are POSTs; they store, mint and audit nothing, so the read-only
    // seat may make them — while a real write through the same seat is refused.
    const s = await enter(ADM.email, W.ea.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect(s.body.readOnly, "PRECONDITION: the read-only tier").toBe(true);
      const qr = await s.api.post("/api/admin/join-qr", { headers: H(s.csrf), data: { text: "https://example.test/join/abc", label: "ABC-123" } });
      expect(qr.status(), (await qr.text()).slice(0, 200)).toBe(200);
      expect(qr.headers()["content-type"]).toMatch(/image\/svg\+xml/);
      const pv = await s.api.post("/api/admin/certificate-config/preview", { headers: H(s.csrf), data: { competition_id: W.mine.id } });
      expect(pv.status(), (await pv.text()).slice(0, 200)).toBe(200);
      // CONTROL: a write through the same seat is still refused.
      const w = await s.api.put(`/api/admin/competitions/${W.mine.id}`, { headers: H(s.csrf), data: { name: "ReadOnlyRenameRender" } });
      expect(w.status()).toBe(403);
      expect((await w.json()).code).toBe("impersonation_readonly");
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("a SUPERADMIN's write through the seat lands, attributed to the superadmin and naming the seat", async () => {
    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    const newName = `EA renamed ${uniq("r")}`;
    try {
      const cur = await (await s.api.get("/api/admin/competitions")).json();
      const row = cur.find(c => c.id === W.mine.id);
      expect(row).toBeTruthy();
      const r = await s.api.put(`/api/admin/competitions/${W.mine.id}`, { headers: H(s.csrf), data: { name: newName, expectedUpdatedAt: row.updated_at } });
      expect(r.status(), await r.text()).toBe(200);
      expect(dbGet("SELECT name FROM competitions WHERE id=?", W.mine.id).name).toBe(newName);
      const ev = dbGet("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='edited' ORDER BY changed_at DESC, rowid DESC LIMIT 1", W.mine.id);
      expect(ev, "the edit is on the event's history").toBeTruthy();
      expect(ev.changed_by, "attributed to the ACTING admin, not the seat").toBe(SUP.email);
      const d = JSON.parse(ev.details || "{}");
      expect(d.impersonated_by, "…and the row says it was made under impersonation").toBe(SUP.email);
      expect(d.acting_as, "…through WHOSE seat").toBe(W.ea.email);
      expect(d.ip, "with the requester's IP").toBeTruthy();
      // CONTROL: the organiser's own edit carries neither marker.
      await W.eaApi.get("/api/csrf-token").then(async r0 => { W.eaCsrf = (await r0.json()).csrfToken; });
      const cur2 = await (await W.eaApi.get("/api/admin/competitions")).json();
      const row2 = cur2.find(c => c.id === W.mine.id);
      const own = await W.eaApi.put(`/api/admin/competitions/${W.mine.id}`, { headers: H(W.eaCsrf), data: { name: W.mine.name, expectedUpdatedAt: row2.updated_at } });
      expect(own.status(), await own.text()).toBe(200);
      const ev2 = dbGet("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='edited' ORDER BY changed_at DESC, rowid DESC LIMIT 1", W.mine.id);
      expect(ev2.changed_by).toBe(W.ea.email);
      const d2 = JSON.parse(ev2.details || "{}");
      expect(d2.impersonated_by).toBeUndefined();
      expect(d2.acting_as).toBeUndefined();
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("the seal binds the HUMAN: an organiser's sealed key is not readable through their seat, and a seal cannot be set by proxy", async () => {
    // The organiser seals a challenge from their OWN session (the author).
    const secret = `sealed-key-${uniq("k")}`;
    const t = await makeTask(W.eaApi, W.eaCsrf, "sealed", { answer_sealed: 1, correct_answer: secret, explanation: `<p>expl-${secret}</p>` });
    await assignTask(W.eaApi, W.eaCsrf, t.id, [W.mine.id]);
    // CONTROL: the author reads their own key.
    const ownList = await (await W.eaApi.get("/api/admin/tasks")).json();
    const ownRow = ownList.find(x => x.id === t.id);
    expect(ownRow, "the author sees the row").toBeTruthy();
    expect(ownRow.can_see_answer).toBe(true);
    expect(ownRow.correct_answer).toBe(secret);

    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      const r = await s.api.get("/api/admin/tasks");
      expect(r.status()).toBe(200);
      const body = await r.text();
      const list = JSON.parse(body);
      const row = list.find(x => x.id === t.id);
      expect(row, "the seat sees the row — it is the organiser's challenge").toBeTruthy();
      expect(row.can_see_answer, "…but the key is withheld from the person looking").toBe(false);
      expect(body, "by VALUE: the sealed key appears nowhere in the response").not.toContain(secret);
      // The version history through the seat is redacted too.
      const hist = await (await s.api.get(`/api/admin/tasks/${t.id}/versions`)).text();
      expect(hist).not.toContain(secret);
      // And a seal cannot be SET through somebody else's seat.
      const c = await s.api.post("/api/admin/tasks", { headers: H(s.csrf), data: { title: `Proxy ${uniq("p")}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "z", status: "draft", answer_sealed: 1 } });
      expect(c.status(), await c.text()).toBe(400);
      expect((await c.json()).code).toBe("answer_seal_not_by_proxy");
      // CONTROL: the same create UNSEALED lands (a superadmin's write through the seat).
      const c2 = await s.api.post("/api/admin/tasks", { headers: H(s.csrf), data: { title: `Proxy ok ${uniq("p")}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "z", status: "draft" } });
      expect(c2.status(), await c2.text()).toBe(200);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });
});

test.describe("Switching views inside the session", () => {
  test("the toggle switches admin ⇄ participant WITHOUT leaving impersonation, never sets superadmin, and is audited to the acting admin", async () => {
    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      // Down to the participant view.
      let r = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "participant" } });
      expect(r.status(), await r.text()).toBe(200);
      let d = await r.json();
      expect(d).toMatchObject({ ok: true, isAdmin: false, isSuperAdmin: false, isEventAdmin: true });
      expect(d.impersonation).toMatchObject({ active: true, view: "participant", target_role: "event_admin" });
      await refreshCsrf(s);
      let me = await (await s.api.get("/api/me")).json();
      expect(me.impersonation, "still impersonating").toMatchObject({ active: true, view: "participant" });
      expect(me.isAdminView).toBe(false);
      expect(me.email).toBe(W.ea.email);
      expect([401, 403], "the admin surface is closed in the participant view").toContain((await s.api.get("/api/admin/competitions")).status());
      // The switch is on the ORGANISER's history, attributed to the acting admin.
      const tog = lastUserEvent(W.ea.id, "admin_view_toggled");
      expect(tog).toBeTruthy();
      expect(tog.changed_by, "attributed to the ACTING admin").toBe(SUP.email);
      expect(tog.details).toMatchObject({ mode: "participant", impersonated_by: SUP.email, acting_as: W.ea.email });
      expect(tog.details.is_superadmin).toEqual({ from: false, to: false });

      // And back up.
      r = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "admin" } });
      expect(r.status(), await r.text()).toBe(200);
      d = await r.json();
      expect(d).toMatchObject({ ok: true, isAdmin: true, isSuperAdmin: false, isEventAdmin: true });
      expect(d.impersonation).toMatchObject({ active: true, view: "admin" });
      await refreshCsrf(s);
      me = await (await s.api.get("/api/me")).json();
      expect(me.isAdminView).toBe(true);
      expect(me.isSuperAdmin).toBeFalsy();
      expect(me.impersonation).toMatchObject({ active: true, view: "admin" });
      const comps = await (await s.api.get("/api/admin/competitions")).json();
      expect(comps.map(c => c.id)).toContain(W.mine.id);
      expect(comps.map(c => c.id)).not.toContain(W.theirs.id);
      // The read-only tier can toggle too — the toggle is navigation, not a write.
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
    const ro = await enter(ADM.email, W.ea.id, { view: "participant" });
    try {
      const r = await ro.api.post("/api/toggle-admin-view", { headers: H(ro.csrf), data: { mode: "admin" } });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).impersonation).toMatchObject({ active: true, superadmin: false, view: "admin" });
      await refreshCsrf(ro);
      expect((await ro.api.get("/api/admin/competitions")).status()).toBe(200);
      const w = await ro.api.put(`/api/admin/competitions/${W.mine.id}`, { headers: H(ro.csrf), data: { name: "x" } });
      expect(w.status(), "…and the tier is still read-only after the switch").toBe(403);
      expect((await w.json()).code).toBe("impersonation_readonly");
    } finally {
      await ro.api.post("/api/impersonation/exit", { headers: H(ro.csrf) }).catch(() => {});
      await ro.api.dispose();
    }
  });

  test("exit from the admin view restores the acting admin and closes the window naming the view", async () => {
    // The BUILT-IN account here, so both acting shapes are driven through the
    // exit: it has no users row, and its restore is the `builtinId` branch.
    const s = await enter("superadmin", W.ea.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      const r = await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) });
      expect(r.status(), await r.text()).toBe(200);
      await refreshCsrf(s);
      const ad = await (await s.api.get("/api/admin/me")).json();
      expect(ad).toMatchObject({ role: "superadmin", isSuperAdmin: true, isEventAdmin: false });
      expect(ad.impersonation).toBeUndefined();
      const ended = lastUserEvent(W.ea.id, "impersonation_ended");
      expect(ended).toBeTruthy();
      expect(ended.changed_by).toBe("superadmin");
      expect(ended.details).toMatchObject({ reason: "manual", view: "admin" });
    } finally {
      await s.api.dispose();
      await relogSa();
    }
  });
});

test.describe("Lifecycle: the target's tier and the acting admin's, re-read", () => {
  test("a target DEMOTED mid-session forces the exit: the acting admin is RESTORED, not stranded, and the window is closed", async () => {
    const ea2 = await makeParticipant(W.sa, W.saCsrf, "demote");
    await grantEventAdmin(W.sa, W.saCsrf, W.mine.id, ea2.id);
    const s = await enter(SUP.email, ea2.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect((await s.api.get("/api/admin/competitions")).status()).toBe(200);
      // Out-of-band demotion (the class the per-request re-read exists for).
      dbRun("UPDATE users SET role='participant' WHERE id=?", ea2.id);
      const r = await s.api.get("/api/admin/competitions");
      expect(r.status()).toBe(403);
      expect(await r.json()).toEqual({ error: "impersonation_ended", reason: "target_inactive" });
      // The acting admin is back in their own seat on the very next request.
      const ad = await (await s.api.get("/api/admin/me")).json();
      expect(ad).toMatchObject({ role: "superadmin", isSuperAdmin: true });
      expect(ad.impersonation).toBeUndefined();
      const ended = lastUserEvent(ea2.id, "impersonation_ended");
      expect(ended.details).toMatchObject({ reason: "target_inactive", view: "admin" });
    } finally {
      dbRun("UPDATE users SET role='participant' WHERE id=?", ea2.id);
      await s.api.dispose();
    }
  });

  test("a target PROMOTED to a global tier mid-session forces the exit too — the seat must not silently widen", async () => {
    const ea3 = await makeParticipant(W.sa, W.saCsrf, "promote");
    await grantEventAdmin(W.sa, W.saCsrf, W.mine.id, ea3.id);
    const s = await enter(SUP.email, ea3.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      dbRun("UPDATE users SET role='admin' WHERE id=?", ea3.id);
      const r = await s.api.get("/api/admin/participants?limit=10");
      expect(r.status(), "an organiser's seat that became a global admin's is not served").toBe(403);
      expect((await r.json()).error).toBe("impersonation_ended");
      const ad = await (await s.api.get("/api/admin/me")).json();
      expect(ad.role).toBe("superadmin");
    } finally {
      dbRun("UPDATE users SET role='participant' WHERE id=?", ea3.id);
      await s.api.dispose();
    }
  });

  test("the ACTING admin is re-read on reads too: a blocked ex-admin loses the organiser's panel on the next request", async () => {
    const adm2 = await makeAdmin(W.sa, W.saCsrf, "blockme");
    const s = await enter(adm2.email, W.ea.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      expect((await s.api.get("/api/admin/competitions")).status()).toBe(200);
      dbRun("UPDATE users SET blocked=1 WHERE id=?", adm2.id);
      const r = await s.api.get("/api/admin/competitions");
      expect(r.status(), "a GET through the seat is refused once the acting admin is blocked").toBe(403);
      expect((await r.json()).error).toBe("You do not have admin access");
      // The session is destroyed, not restored — there is nobody to hand it back to.
      expect((await s.api.get("/api/admin/me")).status()).toBe(401);
      expect((await s.api.get("/api/me")).status()).toBe(401);
    } finally {
      dbRun("UPDATE users SET blocked=0 WHERE id=?", adm2.id);
      await s.api.dispose();
    }
  });

  test("a participant-role target's participant view is unchanged: mode:'admin' is refused and the marker survives", async () => {
    const s = await enter(SUP.email, W.inMine.id, { view: "participant" });
    try {
      const r = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "admin" } });
      expect(r.status()).toBe(403);
      expect((await r.json()).error).toBe("You do not have admin access");
      const me = await (await s.api.get("/api/me")).json();
      expect(me.impersonation).toMatchObject({ active: true, view: "participant", target_role: "participant" });
      expect(me.isAdminView).toBe(false);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });
});

test.describe("Staff can compete meets the seat (v8.12.0 × v8.12.1)", () => {
  test("an acting admin who COMPETES in an event the organiser runs is refused the admin view — and re-refused on a write if it happens mid-session", async () => {
    // A user-backed superadmin (the built-in has no users row and can never be a competitor).
    const sup = await makeAdmin(W.sa, W.saCsrf, "supcomp", "superadmin");
    const compete = await makeCompetition(W.sa, W.saCsrf, "compete", { staff_compete: 1 });
    const org = await makeParticipant(W.sa, W.saCsrf, "orgcomp");
    await grantEventAdmin(W.sa, W.saCsrf, compete.id, org.id);
    // Precondition: the acting superadmin really holds a row on the compete event.
    await enrol(W.sa, W.saCsrf, compete.id, [sup.id]);
    expect(dbGet("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?", compete.id, sup.id).c).toBe(1);

    const s = await enter(sup.email, org.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(403);
      expect(s.body.code).toBe("competitor_cannot_edit");
      expect(s.body.competitionId).toBe(compete.id);
      expect(String(s.body.error)).toContain(compete.name);
      // CONTROL: the participant view of the same organiser still opens — the
      // rule is about changing the board through their seat, not about looking.
      const p = await s.api.post(`/api/admin/participants/${org.id}/impersonate`, { headers: H(s.csrf), data: { view: "participant" } });
      expect(p.status(), await p.text()).toBe(200);
    } finally {
      await refreshCsrf(s);
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }

    // Mid-session: a superadmin NOT competing enters, is then enrolled by a
    // colleague, and the next write through the seat is refused by the guard.
    const sup2 = await makeAdmin(W.sa, W.saCsrf, "supmid", "superadmin");
    const s2 = await enter(sup2.email, org.id, { view: "admin" });
    try {
      expect(s2.status, JSON.stringify(s2.body)).toBe(200);
      await enrol(W.sa, W.saCsrf, compete.id, [sup2.id]);
      const cur = await (await s2.api.get("/api/admin/competitions")).json();
      const row = cur.find(c => c.id === compete.id);
      expect(row, "reads still work").toBeTruthy();
      const w = await s2.api.put(`/api/admin/competitions/${compete.id}`, { headers: H(s2.csrf), data: { name: `${compete.name} x`, expectedUpdatedAt: row.updated_at } });
      expect(w.status(), await w.text()).toBe(403);
      expect((await w.json()).code).toBe("competitor_cannot_edit");
      expect(dbGet("SELECT name FROM competitions WHERE id=?", compete.id).name).toBe(compete.name);
    } finally {
      await s2.api.post("/api/impersonation/exit", { headers: H(s2.csrf) }).catch(() => {});
      await s2.api.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.12.1 PRE-RELEASE REVIEW — the arms below lock what an adversarial pass over
// the first draft found. Each is written from a concrete request that reached
// something it must not, so each carries the control that request's OWN panel
// gives (the organiser's session, or the acting admin's own).
// ─────────────────────────────────────────────────────────────────────────────
test.describe("The competitor lock binds the HAND as well as the seat (v8.12.1 review)", () => {
  test("a superadmin who competes in event E cannot block a rival, or edit a challenge E holds, through the seat of an organiser who runs a DIFFERENT event the rival is also in", async () => {
    // S competes in E (staff_compete). P is enrolled in E AND in F. T organises
    // F only. From S's own panel, blocking P is refused (rivals through E).
    // Through T's seat every door keyed on the SEAT alone passed — T competes
    // nowhere — and the guard's coarse re-ask covers only events T ORGANISES.
    const S = await makeAdmin(W.sa, W.saCsrf, "suprival", "superadmin");
    const E = await makeCompetition(W.sa, W.saCsrf, "rivalE", { staff_compete: 1 });
    const F = await makeCompetition(W.sa, W.saCsrf, "rivalF");
    const T = await makeParticipant(W.sa, W.saCsrf, "orgf");
    const P = await makeParticipant(W.sa, W.saCsrf, "rivalp");
    await grantEventAdmin(W.sa, W.saCsrf, F.id, T.id);
    await enrol(W.sa, W.saCsrf, E.id, [S.id, P.id]);
    await enrol(W.sa, W.saCsrf, F.id, [P.id]);
    expect(dbGet("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id IN (?,?)", E.id, S.id, P.id).c, "precondition: S and P both hold rows on E").toBe(2);
    expect(dbGet("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?", E.id, T.id).c, "precondition: the organiser T holds NO row on E").toBe(0);
    // A challenge T authored, held by BOTH events — the challenge-side variant.
    // SEALED, because a compete event admits sealed challenges only (v8.12.0);
    // the competitor door is asked BEFORE the seal on the PUT, so the refusal
    // under test is still the competitor's.
    const tl = await apiLogin(T.email, PARTICIPANT_PASS);
    const task = await makeTask(tl.api, tl.csrf, "shared", { answer_sealed: 1 });
    await assignTask(W.sa, W.saCsrf, task.id, [E.id, F.id]);
    // CONTROL FIRST: from T's OWN session, blocking P and editing the challenge both land.
    const ownBlock = await tl.api.post(`/api/admin/participants/${P.id}/block`, { headers: H(tl.csrf), data: {} });
    expect(ownBlock.status(), `organiser blocks: ${await ownBlock.text()}`).toBe(200);
    const unblock = await tl.api.post(`/api/admin/participants/${P.id}/block`, { headers: H(tl.csrf), data: {} }); // toggle back
    expect(unblock.status()).toBe(200);
    expect(dbGet("SELECT blocked FROM users WHERE id=?", P.id).blocked, "precondition: P is unblocked again").toBe(0);
    const ownTask = await (await tl.api.get("/api/admin/tasks")).json();
    const ownRow = ownTask.find(x => x.id === task.id);
    const ownEdit = await tl.api.put(`/api/admin/tasks/${task.id}`, { headers: H(tl.csrf), data: { title: `${task.title} own`, expectedUpdatedAt: ownRow.updated_at } });
    expect(ownEdit.status(), `organiser edits: ${await ownEdit.text()}`).toBe(200);
    await tl.api.dispose();

    const s = await enter(S.email, T.id, { view: "admin" });
    try {
      expect(s.status, `entry (S competes in E, T runs F): ${JSON.stringify(s.body)}`).toBe(200);
      // The Participants list through the seat names the rival WITH the event —
      // the row withholds the doors with their reason (v7.14.2).
      const list = await (await s.api.get(`/api/admin/participants?limit=5000`)).json();
      const pRow = list.participants.find(u => u.id === P.id);
      expect(pRow, "P is in T's scope through F").toBeTruthy();
      expect(pRow.rival_in, "the row says WHY the account doors are withheld").toMatchObject({ id: E.id });
      // Every account door: the rival refusal names E, and nothing moves.
      const blk = await s.api.post(`/api/admin/participants/${P.id}/block`, { headers: H(s.csrf), data: {} });
      expect(blk.status(), await blk.text()).toBe(403);
      expect((await blk.json()).code).toBe("competitor_cannot_edit");
      expect((await blk.json()).competitionId).toBe(E.id);
      expect(dbGet("SELECT blocked FROM users WHERE id=?", P.id).blocked).toBe(0);
      const tag = await s.api.post(`/api/admin/participants/${P.id}/tags`, { headers: H(s.csrf), data: { tag: "benchmark" } });
      expect(tag.status(), await tag.text()).toBe(403);
      expect(dbGet("SELECT COUNT(*) c FROM user_tags WHERE user_id=? AND tag='benchmark'", P.id).c).toBe(0);
      // The challenge door: a COSMETIC edit of T's own challenge, held by E, is refused through the seat.
      const seatList = await (await s.api.get("/api/admin/tasks")).json();
      const seatRow = seatList.find(x => x.id === task.id);
      expect(seatRow, "the seat sees T's challenge").toBeTruthy();
      expect(seatRow.competing_in.map(c => c.id), "…and the row says the hand competes in E").toContain(E.id);
      expect(seatRow.can_edit).toBe(false);
      const ed = await s.api.put(`/api/admin/tasks/${task.id}`, { headers: H(s.csrf), data: { title: `${task.title} seat`, expectedUpdatedAt: seatRow.updated_at } });
      expect(ed.status(), await ed.text()).toBe(403);
      expect((await ed.json()).code).toBe("competitor_cannot_edit");
      expect(dbGet("SELECT title FROM tasks WHERE id=?", task.id).title).toBe(`${task.title} own`);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("the toggle INTO the admin view asks the same compete question the entry does, before the regenerate", async () => {
    const S = await makeAdmin(W.sa, W.saCsrf, "suptog", "superadmin");
    const compete = await makeCompetition(W.sa, W.saCsrf, "togcomp", { staff_compete: 1 });
    const org = await makeParticipant(W.sa, W.saCsrf, "orgtog");
    await grantEventAdmin(W.sa, W.saCsrf, compete.id, org.id);
    await enrol(W.sa, W.saCsrf, compete.id, [S.id]);
    // The participant view opens (the rule is about the panel, not looking)…
    const s = await enter(S.email, org.id, { view: "participant" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      // …and the toggle up is refused with the entry's own shape, changing
      // nothing: same token still valid, marker intact, still participant-shaped.
      const up = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "admin" } });
      expect(up.status(), await up.text()).toBe(403);
      const b = await up.json();
      expect(b.code).toBe("competitor_cannot_edit");
      expect(b.competitionId).toBe(compete.id);
      const me = await (await s.api.get("/api/me")).json();
      expect(me.impersonation).toMatchObject({ active: true, view: "participant", target_role: "event_admin" });
      expect(me.isAdminView).toBe(false);
      const stillValid = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "participant" } });
      expect(stillValid.status(), "the refusal ran BEFORE the regenerate: the old CSRF token still works").toBe(200);
      // CONTROL: once S no longer competes there, the same toggle lands.
      const rm = await W.sa.delete(`/api/admin/competitions/${compete.id}/users/${S.id}`, { headers: H(W.saCsrf) });
      expect(rm.status(), await rm.text()).toBe(200);
      await refreshCsrf(s);
      const up2 = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "admin" } });
      expect(up2.status(), await up2.text()).toBe(200);
      expect((await up2.json()).impersonation).toMatchObject({ view: "admin" });
    } finally {
      await refreshCsrf(s);
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });
});

test.describe("The seal through the seat, in every direction (v8.12.1 review)", () => {
  test("v8.12.2 — a SUPERADMIN in an organiser's seat may REVEAL the organiser's sealed challenge: recorded as the superadmin, through that seat; the seat then reads and edits as the author; the reveal dies with the seat; a regular admin's seat is refused", async () => {
    const K = uniq("sr");
    const key = `SEATKEY_${K}`, hint = `SEATHINT_${K}`;
    const theirs = await makeTask(W.eaApi, W.eaCsrf, "easealedrv", { answer_sealed: 1, correct_answer: key, hint: `<p>${hint}</p>`, explanation: `<p>SEATWHY_${K}</p>` });
    await assignTask(W.eaApi, W.eaCsrf, theirs.id, [W.mine.id]);
    const recs = () => dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", theirs.id).c;

    // The REGULAR admin's seat: the reveal is a durable write, so the global
    // guard refuses it as read-only before the route is reached (CONTROL).
    const a = await enter(ADM.email, W.ea.id, { view: "admin" });
    try {
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      const rv = await a.api.post(`/api/admin/tasks/${theirs.id}/sealed-reveal`, { headers: H(a.csrf) });
      expect(rv.status(), await rv.text()).toBe(403);
      expect((await rv.json()).code).toBe("impersonation_readonly");
      expect(recs()).toBe(0);
    } finally { await a.api.post("/api/impersonation/exit", { headers: H(a.csrf) }).catch(() => {}); await a.api.dispose(); }

    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      const before = (await (await s.api.get("/api/admin/tasks")).json()).find(x => x.id === theirs.id);
      expect(before.can_see_answer, "sealed out through the seat until revealed").toBe(false);
      expect(before.hint, "the hint too (v8.12.2)").toBeUndefined();
      expect(before.can_reveal_answer, "…and OFFERED the reveal: the acting human's tier, not the seat's (S.isSuperAdmin is false here by construction)").toBe(true);
      const rv = await s.api.post(`/api/admin/tasks/${theirs.id}/sealed-reveal`, { headers: H(s.csrf) });
      expect(rv.status(), await rv.text()).toBe(200);
      expect(recs()).toBe(1);
      const rec = dbGet("SELECT changed_by, details FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", theirs.id);
      expect(rec.changed_by, "recorded as the SUPERADMIN, never as the seat").toBe(SUP.email);
      const d = JSON.parse(rec.details);
      expect(d.via).toBe("impersonated_admin_view");
      expect(d.impersonated_by, "…with the seat").toBe(SUP.email);
      // v8.12.2 review — the permanent table names the seat by ID, never by
      // email: it outlives the account and is read by other organisers.
      expect(d.acting_as_id, "…through WHOSE seat, as an id").toBe(W.ea.id);
      expect(d.acting_as, "no email in the permanent history").toBeUndefined();
      expect(rec.details).not.toContain(W.ea.email);
      expect(d.fields).toEqual(["correct_answer", "explanation", "hint"]);
      expect(rec.details).not.toContain(key);
      const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
        j => j.source === "audit" && j.scope === "task" && j.scope_id === theirs.id && j.event_type === "sealed_answer_revealed",
        { what: "the sealed_answer_revealed event through the seat" });
      expect(line.changed_by).toBe(SUP.email);
      expect(line.details.impersonated_by, "the two halves name the same person the same way").toBe(SUP.email);
      expect(line.details.acting_as).toBe(W.ea.email);
      const after = (await (await s.api.get("/api/admin/tasks")).json()).find(x => x.id === theirs.id);
      expect(after.correct_answer).toBe(key);
      expect(after.hint).toContain(hint);
      expect(after.answer_revealed).toBe(true);
      expect(after.can_edit).toBe(true);
      const put = await s.api.put(`/api/admin/tasks/${theirs.id}`, { headers: H(s.csrf), data: { title: `${theirs.title} seat-edit`, expectedUpdatedAt: after.updated_at } });
      expect(put.status(), await put.text()).toBe(200);
      const own = (await (await W.eaApi.get(`/api/admin/tasks/${theirs.id}/versions`)).json());
      const seen = own.find(v => v.change_type === "sealed_reveal");
      expect(seen, "the organiser can see who looked, and from where").toBeTruthy();
      expect(seen.details).toMatchObject({ impersonated_by: SUP.email, acting_as: W.ea.email });
      // The exit regenerates: the reveal made in the seat does not follow the
      // superadmin into their own restored session.
      const ex = await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) });
      expect(ex.ok(), await ex.text()).toBeTruthy();
      await refreshCsrf(s);
      const back = (await (await s.api.get("/api/admin/tasks")).json()).find(x => x.id === theirs.id);
      expect(back.correct_answer, "a reveal lasts the session shape it was made in").toBeUndefined();
      expect(back.can_reveal_answer).toBe(true);
    } finally { await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {}); await s.api.dispose(); }
  });

  test("the Submissions stream through the seat redacts the organiser's sealed answers, and the search cannot confirm one", async () => {
    // The one seal site the first draft missed: inline in server.js, keyed on
    // `req.session.userId` — the SEAT — so a superadmin in the organiser's panel
    // read every answer submitted to the organiser's sealed challenges.
    const secret = `SEALSUB_${uniq("k")}`;
    const t = await makeTask(W.eaApi, W.eaCsrf, "sealsub", { answer_sealed: 1, correct_answer: secret });
    await assignTask(W.eaApi, W.eaCsrf, t.id, [W.mine.id]);
    // A solver and a bystander (fixture checklist item 1 — one solver alone would auto-end the event).
    const solver = await makeParticipant(W.sa, W.saCsrf, "sealsolver");
    const by = await makeParticipant(W.sa, W.saCsrf, "sealby");
    await enrol(W.sa, W.saCsrf, W.mine.id, [solver.id, by.id]);
    const { freshCtx, gradingHashFor } = require("./helpers");
    const { api: pctx, csrf: pc } = await freshCtx();
    try {
      const li = await codeLogin(pctx, solver.email, H(pc));
      expect(li.ok(), await li.text()).toBeTruthy();
      const pcsrf = (await (await pctx.get("/api/csrf-token")).json()).csrfToken;
      const sel = await pctx.post("/api/select-competition", { headers: H(pcsrf), data: { competitionId: W.mine.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      const sub = await pctx.post(`/api/tasks/${t.id}/submit`, { headers: H(pcsrf), data: { answer: secret, gradingHash: await gradingHashFor(pctx, t.id) } });
      expect(sub.ok(), await sub.text()).toBeTruthy();
      expect((await sub.json()).correct, "the fixture's answer really is the key").toBe(true);
    } finally { await pctx.dispose(); }

    const read = async (api, q) => {
      const r = await api.get(`/api/admin/submissions?competitionId=${W.mine.id}&limit=100` + (q ? `&q=${encodeURIComponent(q)}` : ""));
      expect(r.status()).toBe(200);
      const body = await r.text();
      return { body, json: JSON.parse(body) };
    };
    // CONTROL: the author reads it, and the search finds it.
    const own = await read(W.eaApi);
    expect(own.body).toContain(secret);
    expect((await read(W.eaApi, secret)).json.total, "the author's search finds the row").toBeGreaterThanOrEqual(1);

    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      const seat = await read(s.api);
      expect(seat.json.events.some(e => e.task_id === t.id || e.answer_sealed === true), "the seat sees the stream — this is the organiser's event").toBe(true);
      expect(seat.body, "by VALUE: the submitted key appears nowhere through the seat").not.toContain(secret);
      expect((await read(s.api, secret)).json.total, "and the search is not an oracle for it").toBe(0);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("the HUMAN's own authorship DOES admit them through a seat; the seat's authorship admits nobody on the versions, the PUT, the unseal and the export — and on the participant surface a superadmin IS shown it, on the record (v8.12.2), while a regular admin still is not", async () => {
    // Direction one: a challenge the ACTING superadmin authored and sealed,
    // assigned to the organiser's event, is readable through the organiser's
    // seat — the seal binds the person, and the person is the author.
    const sl = await apiLogin(SUP.email, PARTICIPANT_PASS);
    const mineKey = `MINEKEY_${uniq("k")}`;
    const mine = await makeTask(sl.api, sl.csrf, "supsealed", { answer_sealed: 1, correct_answer: mineKey });
    await assignTask(sl.api, sl.csrf, mine.id, [W.mine.id]);
    await sl.api.dispose();
    // Direction two: the ORGANISER's sealed challenge, which the hand must not read anywhere.
    const theirKey = `THEIRKEY_${uniq("k")}`;
    const theirs = await makeTask(W.eaApi, W.eaCsrf, "easealed", { answer_sealed: 1, correct_answer: theirKey, explanation: `<p>expl-${theirKey}</p>` });
    await assignTask(W.eaApi, W.eaCsrf, theirs.id, [W.mine.id]);
    // A second version exists, so the history read has something to redact.
    const eaRow0 = (await (await W.eaApi.get("/api/admin/tasks")).json()).find(x => x.id === theirs.id);
    const bump = await W.eaApi.put(`/api/admin/tasks/${theirs.id}`, { headers: H(W.eaCsrf), data: { title: `${theirs.title} v2`, expectedUpdatedAt: eaRow0.updated_at } });
    expect(bump.status(), await bump.text()).toBe(200);
    // The organiser is enrolled so their participant view can open the challenge.
    await enrol(W.sa, W.saCsrf, W.mine.id, [W.ea.id]);

    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      const list = await (await s.api.get("/api/admin/tasks")).json();
      const mineRow = list.find(x => x.id === mine.id);
      expect(mineRow, "the seat sees the hand's challenge (it is in the organiser's event)").toBeTruthy();
      expect(mineRow.can_see_answer, "THE HAND IS THE AUTHOR: readable through the seat").toBe(true);
      expect(mineRow.correct_answer).toBe(mineKey);
      const theirRow = list.find(x => x.id === theirs.id);
      expect(theirRow.can_see_answer, "the SEAT's authorship admits nobody").toBe(false);
      // Versions: a real 200 with the versions present, redacted, against the author's own read.
      const vr = await s.api.get(`/api/admin/tasks/${theirs.id}/versions`);
      expect(vr.status()).toBe(200);
      const versions = await vr.json();
      expect(Array.isArray(versions) && versions.length >= 2, "the fixture really has a history to redact").toBe(true);
      expect(JSON.stringify(versions)).not.toContain(theirKey);
      expect(JSON.stringify(versions), "the snapshots are still there — redacted, not emptied").toContain(theirs.title);
      const ownV = await (await W.eaApi.get(`/api/admin/tasks/${theirs.id}/versions`)).text();
      expect(ownV, "CONTROL: the author's own history carries the key").toContain(theirKey);
      // The PUT and the unseal through the seat are refused as a non-author.
      const put = await s.api.put(`/api/admin/tasks/${theirs.id}`, { headers: H(s.csrf), data: { title: `${theirs.title} seat`, expectedUpdatedAt: theirRow.updated_at } });
      expect(put.status(), await put.text()).toBe(403);
      expect((await put.json()).code).toBe("answer_sealed_not_author");
      const unseal = await s.api.put(`/api/admin/tasks/${theirs.id}`, { headers: H(s.csrf), data: { answer_sealed: 0, expectedUpdatedAt: theirRow.updated_at } });
      expect(unseal.status(), await unseal.text()).toBe(403);
      expect(dbGet("SELECT answer_sealed FROM tasks WHERE id=?", theirs.id).answer_sealed).toBe(1);
      // The tasks export through the seat: the organiser's key withheld, the hand's own present.
      const ex = await s.api.get("/api/admin/export/tasks");
      expect(ex.status()).toBe(200);
      const exBody = await ex.text();
      expect(exBody).not.toContain(theirKey);
      expect(exBody, "CONTROL in the same file: the hand's own sealed key is exported").toContain(mineKey);
      const exRow = JSON.parse(exBody).tasks.find(x => x.title === `${theirs.title} v2`);
      expect(exRow, "the organiser's row is in the file").toBeTruthy();
      expect(exRow.answer_sealed).toBe(1);
      expect(exRow.correct_answer).toBeNull();
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }

    // The PARTICIPANT surface: the key reaches that wire on exactly one branch a
    // live event can produce — a SOLVER of a multiple-choice challenge is shown
    // the correct set (v7.20.1). The author is exempt from the seal there, so
    // the pre-fix `req.session.userId` showed the key to whoever impersonated
    // the author. Fixture: the organiser authors a sealed choice challenge,
    // solves it from their OWN participant session (the control: `correct_answer`
    // present), then the superadmin impersonates them in participant view.
    const MC = uniq("mc");
    const mc = await makeTask(W.eaApi, W.eaCsrf, "easealedmc", {
      answer_type: "choice", answer_sealed: 1, explanation: `<p>MCWHY_${MC}</p>`,
      choices: [{ text: `RIGHT_${MC}`, correct: true }, { text: `WRONG_${MC}`, correct: false }],
    });
    await assignTask(W.eaApi, W.eaCsrf, mc.id, [W.mine.id]);
    const { freshCtx, gradingHashFor } = require("./helpers");
    const { api: ea2, csrf: ea2c } = await freshCtx();
    try {
      const li = await codeLogin(ea2, W.ea.email, H(ea2c));
      expect(li.ok(), await li.text()).toBeTruthy();
      const c = (await (await ea2.get("/api/csrf-token")).json()).csrfToken;
      const sel = await ea2.post("/api/select-competition", { headers: H(c), data: { competitionId: W.mine.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      const det = JSON.parse(await (await ea2.get(`/api/tasks/${mc.id}`)).text());
      const right = det.choices.find(x => x.text === `RIGHT_${MC}`);
      const sub = await ea2.post(`/api/tasks/${mc.id}/submit`, { headers: H(c), data: { answer: JSON.stringify([right.id]), gradingHash: await gradingHashFor(ea2, mc.id) } });
      expect(sub.ok(), await sub.text()).toBeTruthy();
      expect((await sub.json()).correct, "the author really solved it").toBe(true);
      const own = JSON.parse(await (await ea2.get(`/api/tasks/${mc.id}`)).text());
      expect(own.correct_answer, "CONTROL: the AUTHOR's own participant view marks the correct option").toBeTruthy();
      expect(own.answer_sealed_withheld).toBeUndefined();
    } finally { await ea2.dispose(); }
    // The organiser's admin session was replaced by that login (one session per
    // user); re-establish it before the seat opens and for the tests below.
    const rl = await apiLogin(W.ea.email, PARTICIPANT_PASS);
    W.eaApi = rl.api; W.eaCsrf = rl.csrf;

    // v8.12.2 (operator decision, reversing v8.12.1 for ONE tier): a SUPERADMIN
    // impersonating the author IS shown the sealed value where the author would
    // be — and the disclosure is RECORDED, per open, naming the superadmin and
    // the seat. The control that keeps the seal a seal is the REGULAR admin
    // below, who is still shown nothing.
    const versionsBefore = dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", mc.id).c;
    const p = await enter(SUP.email, W.ea.id, { view: "participant" });
    try {
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const sel = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: W.mine.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      const r = await p.api.get(`/api/tasks/${mc.id}`);
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.text();
      const det = JSON.parse(body);
      expect(det.correct_answer, "a SUPERADMIN impersonating the author IS shown the correct option (v8.12.2)").toBeTruthy();
      expect(det.answer_sealed_withheld, "…and nothing was withheld").toBeUndefined();
      // The record: a `sealed_reveal` History row naming the superadmin, with the seat.
      const rec = dbGet("SELECT changed_by, details FROM task_versions WHERE task_id=? AND change_type='sealed_reveal' ORDER BY version_num DESC LIMIT 1", mc.id);
      expect(rec, "the disclosure is recorded in the challenge's history").toBeTruthy();
      expect(rec.changed_by, "…naming the SUPERADMIN, not the seat").toBe(SUP.email);
      const d = JSON.parse(rec.details || "{}");
      expect(d.via).toBe("participant_view");
      expect(d.fields).toContain("correct_answer");
      expect(d.impersonated_by, "…and the impersonation context").toBe(SUP.email);
      expect(d.acting_as_id, "the seat, as an id (v8.12.2 review)").toBe(W.ea.id);
      expect(rec.details, "never the seat's email in the permanent history").not.toContain(W.ea.email);
      expect(JSON.stringify(rec), "field NAMES only — the record never carries the key").not.toContain(`RIGHT_${MC}`);
      expect(dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", mc.id).c, "one record per open").toBe(versionsBefore + 1);
      // A second open is a second record — the participant surface has no
      // reveal control, so the open IS the reveal.
      await p.api.get(`/api/tasks/${mc.id}`);
      expect(dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", mc.id).c).toBe(versionsBefore + 2);
    } finally {
      await p.api.post("/api/impersonation/exit", { headers: H(p.csrf) }).catch(() => {});
      await p.api.dispose();
    }
    // CONTROL: a REGULAR admin impersonating the author is shown nothing, and
    // nothing is recorded — the seal still binds every tier below superadmin.
    const before2 = dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", mc.id).c;
    const q = await enter(ADM.email, W.ea.id, { view: "participant" });
    try {
      expect(q.status, JSON.stringify(q.body)).toBe(200);
      const sel = await q.api.post("/api/select-competition", { headers: H(q.csrf), data: { competitionId: W.mine.id } });
      expect(sel.ok(), await sel.text()).toBeTruthy();
      const body = await (await q.api.get(`/api/tasks/${mc.id}`)).text();
      const det = JSON.parse(body);
      expect(det.correct_answer, "a REGULAR admin impersonating the author is NOT shown the correct option").toBeUndefined();
      expect(det.answer_sealed_withheld, "and is told why").toBe(true);
      expect(body, "the sealed explanation is withheld by value").not.toContain(`MCWHY_${MC}`);
      expect(dbGet("SELECT COUNT(*) c FROM task_versions WHERE task_id=? AND change_type='sealed_reveal'", mc.id).c, "nothing to record").toBe(before2);
    } finally {
      await q.api.post("/api/impersonation/exit", { headers: H(q.csrf) }).catch(() => {});
      await q.api.dispose();
    }
  });
});

test.describe("Lifecycle and attribution through the seat (v8.12.1 review)", () => {
  test("an UNVERIFIED organiser's seat survives a gated-docs read: the guides follow the seat's tier, and nothing downgrades the session", async () => {
    // The grant route never checks `verified`, so an unverified organiser is a
    // real state; every v8.12.1 gate admits the target without it (v7.15.8),
    // and the docs gate was the one that did not — it cleared the flags and
    // left the marker, stranding the seat behind bare 403s.
    const org = await makeParticipant(W.sa, W.saCsrf, "unverorg");
    const ev = await makeCompetition(W.sa, W.saCsrf, "unverev");
    await grantEventAdmin(W.sa, W.saCsrf, ev.id, org.id);
    dbRun("UPDATE users SET verified=0 WHERE id=?", org.id);
    expect(dbGet("SELECT verified, role FROM users WHERE id=?", org.id)).toMatchObject({ verified: 0, role: "event_admin" });
    const s = await enter(SUP.email, org.id, { view: "admin" });
    try {
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      const guide = await s.api.get("/docs/user-guide/admin.md");
      expect(guide.status(), "the seat reads the guide its tier may read").toBe(200);
      const sup = await s.api.get("/docs/user-guide/superadmin.md");
      expect(sup.status(), "…and not the one it may not — the seat's tier, not the hand's").toBe(401);
      const me = await s.api.get("/api/admin/me");
      expect(me.status(), "the docs read did not downgrade the session").toBe(200);
      expect((await me.json()).impersonation).toMatchObject({ active: true, view: "admin" });
      const list = await s.api.get("/api/admin/competitions");
      expect(list.status(), "the panel still answers").toBe(200);
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });

  test("the ACTING admin losing admin access closes the target's window (reason actor_inactive) on every exit that destroys — requireAdmin, GET /api/admin/me and the toggle", async () => {
    const shapes = [
      ["a GET through requireAdmin", async (api, csrf) => api.get("/api/admin/competitions")],
      ["GET /api/admin/me", async (api, csrf) => api.get("/api/admin/me")],
      ["the toggle", async (api, csrf) => api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "participant" } })],
    ];
    for (const [label, fire] of shapes) {
      const adm = await makeAdmin(W.sa, W.saCsrf, "lostadm", "superadmin");
      const s = await enter(adm.email, W.ea.id, { view: "admin" });
      try {
        expect(s.status, `${label}: entry ${JSON.stringify(s.body)}`).toBe(200);
        const before = dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", W.ea.id).c;
        dbRun("UPDATE users SET blocked=1 WHERE id=?", adm.id);
        const r = await fire(s.api, s.csrf);
        expect(r.status(), `${label}: refused`).toBe(403);
        expect((await r.json()).error).toBe("You do not have admin access");
        const after = dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='impersonation_ended'", W.ea.id).c;
        expect(after, `${label}: the window on the target's row is closed`).toBe(before + 1);
        const ev = lastUserEvent(W.ea.id, "impersonation_ended");
        expect(ev.details.reason).toBe("actor_inactive");
        expect(ev.details.view).toBe("admin");
        expect(ev.changed_by, "attributed to the acting admin").toBe(adm.email);
        expect((await s.api.get("/api/me")).status(), `${label}: the session is gone`).toBe(401);
      } finally { await s.api.dispose(); }
    }
  });

  test("attribution survives a view toggle made BEFORE impersonating: impersonated_by and changed_by name the same person the same way", async () => {
    // The pre-v8.12.1 toggle dropped `userEmail` from the session, so an admin
    // who had peeked at participant view and come back snapshotted a NULL email
    // into the marker; `getAdminIdentity` read live and `reqContext` read the
    // snapshot, so one row carried an email beside a UUID.
    const adm = await makeAdmin(W.sa, W.saCsrf, "togfirst", "superadmin");
    const l = await apiLogin(adm.email, PARTICIPANT_PASS);
    let csrf = l.csrf;
    const down = await l.api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "participant" } });
    expect(down.status(), await down.text()).toBe(200);
    csrf = (await (await l.api.get("/api/csrf-token")).json()).csrfToken;
    const up = await l.api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "admin" } });
    expect(up.status(), await up.text()).toBe(200);
    csrf = (await (await l.api.get("/api/csrf-token")).json()).csrfToken;
    const ent = await l.api.post(`/api/admin/participants/${W.ea.id}/impersonate`, { headers: H(csrf), data: { view: "admin" } });
    expect(ent.status(), await ent.text()).toBe(200);
    csrf = (await (await l.api.get("/api/csrf-token")).json()).csrfToken;
    try {
      const started = lastUserEvent(W.ea.id, "impersonation_started");
      expect(started.changed_by).toBe(adm.email);
      // A write through the seat, and both fields on its event.
      const c = await l.api.post("/api/admin/tasks", { headers: H(csrf), data: { title: `Attr ${uniq("a")}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "z", status: "draft" } });
      expect(c.status(), await c.text()).toBe(200);
      const id = (await c.json()).id;
      const ver = dbGet("SELECT changed_by FROM task_versions WHERE task_id=? ORDER BY changed_at DESC LIMIT 1", id);
      expect(ver.changed_by, "changed_by (getAdminIdentity) is the acting admin's email").toBe(adm.email);
      // A toggle inside the window: its event carries reqContext's impersonated_by.
      const down = await l.api.post("/api/toggle-admin-view", { headers: H(csrf), data: { mode: "participant" } });
      expect(down.status(), await down.text()).toBe(200);
      csrf = (await (await l.api.get("/api/csrf-token")).json()).csrfToken;
      const tog = lastUserEvent(W.ea.id, "admin_view_toggled");
      expect(tog.changed_by).toBe(adm.email);
      expect(tog.details.impersonated_by, "impersonated_by (reqContext) is the SAME email, never the UUID the snapshot degraded to").toBe(adm.email);
      expect(tog.details.impersonated_by).not.toBe(adm.id);
    } finally {
      await l.api.post("/api/impersonation/exit", { headers: H(csrf) }).catch(() => {});
      await l.api.dispose();
    }
  });

  test("the toggle under impersonation never runs the target's auto-resume landing — a stale marker is left as it is, while the organiser's own toggle clears it", async () => {
    const org = await makeParticipant(W.sa, W.saCsrf, "markorg");
    const ev = await makeCompetition(W.sa, W.saCsrf, "markev");
    await grantEventAdmin(W.sa, W.saCsrf, ev.id, org.id);
    const stale = `gone-${uniq("m")}`; // a marker naming no event — the landing would NULL it and emit
    dbRun("UPDATE users SET active_competition_id=? WHERE id=?", stale, org.id);
    const s = await enter(SUP.email, org.id, { view: "admin" });
    try {
      const before = dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='active_competition_changed'", org.id).c;
      const down = await s.api.post("/api/toggle-admin-view", { headers: H(s.csrf), data: { mode: "participant" } });
      expect(down.status(), await down.text()).toBe(200);
      expect(dbGet("SELECT active_competition_id FROM users WHERE id=?", org.id).active_competition_id, "the target's marker is untouched by a peek").toBe(stale);
      expect(dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='active_competition_changed'", org.id).c).toBe(before);
    } finally {
      await refreshCsrf(s);
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
    // CONTROL: the organiser's OWN toggle into participant view runs the landing and clears it.
    const ol = await apiLogin(org.email, PARTICIPANT_PASS);
    try {
      const down = await ol.api.post("/api/toggle-admin-view", { headers: H(ol.csrf), data: { mode: "participant" } });
      expect(down.status(), await down.text()).toBe(200);
      expect(dbGet("SELECT active_competition_id FROM users WHERE id=?", org.id).active_competition_id).toBeNull();
    } finally { await ol.api.dispose(); }
  });

  test("a NESTED entry is refused by the guard with its own named code, and the seat is untouched", async () => {
    const s = await enter(SUP.email, W.ea.id, { view: "admin" });
    try {
      const r = await s.api.post(`/api/admin/participants/${W.inMine.id}/impersonate`, { headers: H(s.csrf), data: { view: "participant" } });
      expect(r.status()).toBe(403);
      const b = await r.json();
      expect(b.code, "the code a CLIENT receives — the route's inline arm is behind the guard").toBe("impersonation_nested");
      expect(String(b.error)).toContain("Exit that impersonation first");
      const me = await (await s.api.get("/api/me")).json();
      expect(me.email).toBe(W.ea.email);
      expect(me.impersonation).toMatchObject({ active: true, view: "admin" });
    } finally {
      await s.api.post("/api/impersonation/exit", { headers: H(s.csrf) }).catch(() => {});
      await s.api.dispose();
    }
  });
});

// The scanner-block exemption asks the ACTING admin FIRST. Kept in its own
// describe because arming the tracker is PROCESS-GLOBAL and blocks the whole
// address every other test in this worker shares — disarm + reset in BOTH hooks
// (the shape scanner-silent.api.spec.js established).
test.describe("The scanner-block exemption reads the acting admin, not the seat (v8.12.1 review)", () => {
  const PROBE_PATHS = ["/.env", "/wp-admin/setup-config.php", "/phpmyadmin/index.php", "/.git/config", "/config.json", "/administrator/index.php", "/.aws/credentials", "/backup.sql", "/adminer.php", "/owa/auth/logon.aspx", "/actuator/env", "/cgi-bin/test.cgi"];
  const { freshCtx } = require("./helpers");
  async function disarm() {
    const { api } = await freshCtx();
    try {
      await api.post("/api/test/scanner-toggle", { data: { enable: false } }).catch(() => {});
      await api.post("/api/test/scanner-reset", {}).catch(() => {});
      await api.post("/api/test/clear-ip-ban-alerts", {}).catch(() => {});
    } finally { await api.dispose(); }
  }
  test.beforeEach(async () => { await disarm(); });
  test.afterEach(async () => { await disarm(); });

  test("an admin-shaped seat whose ACTING admin is blocked is NOT exempt, while a live admin's own session on the same address is", async () => {
    const lost = await makeAdmin(W.sa, W.saCsrf, "scanlost", "superadmin");
    const live = await makeAdmin(W.sa, W.saCsrf, "scanlive");
    const sessions = [];
    try {
      const s = await enter(lost.email, W.ea.id, { view: "admin" });
      sessions.push(s.api);
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      const ll = await apiLogin(live.email, PARTICIPANT_PASS);
      sessions.push(ll.api);
      // The seat is admin-shaped: the `isAdmin` shortcut would exempt it on the
      // TARGET's standing. Block the acting admin BEFORE arming the tracker.
      dbRun("UPDATE users SET blocked=1 WHERE id=?", lost.id);
      const { api: anon } = await freshCtx();
      sessions.push(anon);
      expect((await anon.post("/api/test/scanner-toggle", { data: { enable: true } })).ok()).toBe(true);
      let blocked = false;
      for (let i = 1; i <= 60 && !blocked; i++) {
        const r = await anon.get(PROBE_PATHS[i % PROBE_PATHS.length] + "?i=" + i);
        if (r.status() === 429) blocked = true;
      }
      expect(blocked, "precondition: the shared address really is scanner-blocked").toBe(true);
      // THE CONTROL FIRST: a live admin's own session is exempt.
      expect((await ll.api.get("/api/admin/me")).status(), "a live admin on the blocked address is served").toBe(200);
      // The seat of a blocked acting admin is refused BY THE BLOCK (429), before
      // requireAdmin's forced exit could even run.
      expect((await s.api.get("/api/admin/me")).status(), "the seat is not exempt on the target's standing").toBe(429);
    } finally {
      for (const x of sessions) { try { await x.dispose(); } catch (_) {} }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE PINS — two things the behavioural arms above cannot hold, each stated.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("Source pins (v8.12.1 review)", () => {
  const fs = require("fs"), path = require("path");
  const { stripJsComments } = require("./doc-registry");
  const root = path.join(__dirname, "..");
  const read = f => stripJsComments(fs.readFileSync(path.join(root, f), "utf8"));

  test("every competitor predicate is asked about competitorIds(req) — the seat AND the hand — never about actorId(req) alone", () => {
    // The rival arm above drives ONE door (block) and one challenge PUT; the
    // class is ~55 doors across nine files, and the failure mode is the site
    // added later, keyed on the seat because every neighbouring line was until
    // this release. Comments stripped first: the guard's own comment and
    // lib/event-admin.js's `actorId` header quote the forbidden shape.
    const files = ["server.js",
      ...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`),
      ...fs.readdirSync(path.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`)];
    const forbidden = /\b_?(competitorRivalDenied|competitorEditDenied|competitorTaskEditDenied|competitorGroupDenied|competitorEventsForTask|competitorIn|rivalsOf)\(db,\s*actorId\(req\)/;
    const rawSql = /staff_compete\s*=\s*1[\s\S]{0,200}?\.all\((_competeActor|_actorGrp)\)/;
    let sites = 0;
    for (const f of files) {
      const src = read(f);
      const hit = src.match(forbidden);
      expect(hit, `${f}: a competitor predicate is asked about the seat alone (${hit && hit[0]}) — pass competitorIds(req)`).toBeNull();
      expect(src.match(rawSql), `${f}: a raw competing-set SQL binds a single actor id`).toBeNull();
      sites += (src.match(/competitorIds\(req\)/g) || []).length;
      // `_compWire`'s and the admin list's staffCompeteFlags carry the ids too.
      expect(src.match(/actorId:\s*actorId\(req\)/), `${f}: staffCompeteFlags is handed the seat alone`).toBeNull();
    }
    // Anti-vacuity: the sweep touched ~55 sites; a rename of the helper would
    // empty both matches and pass in silence otherwise.
    expect(sites, "the door sites really hand in competitorIds(req)").toBeGreaterThanOrEqual(40);
    // The helper itself: seat first, the hand appended when it differs, nulls dropped.
    const ea = read("lib/event-admin.js");
    expect(ea).toMatch(/function competitorIds\(req\)\s*\{[\s\S]*?const seat = actorId\(req\);[\s\S]*?const hand = actingAdminId\(req\);[\s\S]*?if \(seat\) out\.push\(seat\);[\s\S]*?if \(hand && hand !== seat\) out\.push\(hand\);/);
    // …and the pure module accepts the array at every predicate (`IN (…)`), so a
    // caller cannot hand in two ids and have the second silently ignored.
    const sc = read("lib/staff-compete.js");
    for (const fn of ["competitorIn", "competitorRivalDenied", "rivalsOf", "competitorEventsForTask", "competitorGroupDenied"]) {
      const body = sc.slice(sc.indexOf(`function ${fn}(`), sc.indexOf("\n}\n", sc.indexOf(`function ${fn}(`)));
      expect(body, `${fn} normalises its actor through _actorIds`).toMatch(/_actorIds\(/);
    }
    // The list is ONE bound JSON array (`IN (SELECT value FROM json_each(?))`).
    expect((sc.match(/JSON\.stringify\(ids\)/g) || []).length, "the SQL binds the id LIST").toBeGreaterThanOrEqual(5);
  });

  test("attribution under a seat rests on TWO halves that are each sufficient alone — both are pinned (the v8.10.3 shape)", () => {
    // Measured: reverting the toggle's identity mirrors leaves the behavioural
    // arm green (reqContext resolves live), and reverting reqContext leaves it
    // green (the snapshot carries the email). A reader deleting either on the
    // evidence of a passing suite would be right about the suite and wrong
    // about the platform the day the other is touched.
    const toggle = read("routes/participant.js");
    expect(toggle, "the toggle carries the identity mirrors through its regenerate for EVERY session, not only an impersonating one")
      .toMatch(/const oldData = \{ userId: req\.session\.userId,[^\n]*\n\s*userEmail: req\.session\.userEmail, userFirstName: req\.session\.userFirstName, userLastName: req\.session\.userLastName,\n(?:\s*\/\/[^\n]*\n)*\s*signInMethod: req\.session\.signInMethod, signedInAt: req\.session\.signedInAt, signInViaEmail: req\.session\.signInViaEmail,\n\s*\.\.\.\(imp \? \{ impersonator: imp \} : \{\}\) \};/);
    const audit = read("lib/audit.js");
    expect(audit, "reqContext resolves impersonated_by the way changed_by is resolved — live, through getAdminIdentity")
      .toMatch(/impersonated_by: getAdminIdentity\(req\)/);
    expect(audit).not.toMatch(/impersonated_by: impersonationActor\(s\)/);
  });
});
