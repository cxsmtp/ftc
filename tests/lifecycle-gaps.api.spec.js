// @ts-check
//
// v8.12.4 — paths a full coverage run (`npm run test:coverage`) showed NO test
// executing. Each is a real scenario an operator or participant can reach, not
// a defensive catch arm: the route reach was already complete (every route is
// requested by some spec), so these gaps sat one level down, inside handlers.
//
//   1. GET /api/admin/tasks/:taskId/attachments/:aid — the admin's own download
//      of a challenge attachment. The whole handler had never run.
//   2. An event deleted while a participant is inside it — the middleware's
//      recovery branch, and the live-event DELETE refusal's machine code.
//   3. A session chosen in ADVANCE that then goes live — the select-competition
//      branch that anchors the solve clock and records first entry for it.
//
// Every test owns its fixtures (the fixture checklist), and every refusal is
// paired with the control that separates it from a route that refuses everyone.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, zipOf } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

const row = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...a); } finally { db.close(); }
};
const rows = (sql, ...a) => {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};

async function signIn(email) {
  const s = await apiLogin(email, PARTICIPANT_PASS);
  return s;
}

test.describe("v8.12.4 — the admin downloads a challenge attachment", () => {
  test("a superadmin gets the exact ZIP back; an unknown or detached attachment is a 404; an organiser who cannot see the challenge is REFUSED by name", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    let organiser;
    try {
      const t = await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: uniq("AttachDL"), difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" } });
      expect(t.ok(), await t.text()).toBeTruthy();
      const taskId = (await t.json()).id;
      const zip = zipOf("README.txt", `payload ${uniq("zip")}`);
      const up = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": csrf },
        multipart: { file: { name: "bundle.zip", mimeType: "application/zip", buffer: zip }, display_name: "Starter pack" },
      });
      expect(up.ok(), `upload: ${up.status()} ${await up.text()}`).toBeTruthy();
      const aid = (await up.json()).id;
      expect(aid, "the upload returns the attachment id").toBeTruthy();

      const dl = await sa.get(`/api/admin/tasks/${taskId}/attachments/${aid}`);
      expect(dl.status()).toBe(200);
      expect(dl.headers()["content-type"]).toMatch(/application\/zip/);
      expect(dl.headers()["content-disposition"], "a file save, named after the display name")
        .toMatch(/attachment; filename="[^"]*starter[^"]*\.zip"/i);
      expect(Buffer.compare(await dl.body(), zip), "the bytes are exactly what was uploaded").toBe(0);

      // A different task's id never unlocks this task's file.
      expect((await sa.get(`/api/admin/tasks/${taskId}/attachments/not-an-attachment`)).status()).toBe(404);

      // An organiser with no grant on any event holding this challenge is refused
      // with a REASON — the route's own comment says why a 403 and not a 404.
      organiser = await makeParticipant(sa, csrf, "dl-org");
      const role = await sa.post(`/api/admin/participants/${organiser.id}/role`, { headers: H(csrf), data: { role: "event_admin" } });
      expect(role.ok(), await role.text()).toBeTruthy();
      const o = await signIn(organiser.email);
      try {
        const refused = await o.api.get(`/api/admin/tasks/${taskId}/attachments/${aid}`);
        expect(refused.status(), "the organiser cannot see this challenge").toBe(403);
        const b = await refused.json();
        expect(b.code, "…and the refusal carries its code").toBeTruthy();
        expect(String(b.error).length).toBeGreaterThan(20);
      } finally { await o.api.dispose(); }

      // Detaching the attachment makes the download a 404, not a stale file.
      const del = await sa.delete(`/api/admin/tasks/${taskId}/attachments/${aid}`, { headers: { "x-csrf-token": csrf } });
      expect(del.ok(), await del.text()).toBeTruthy();
      expect((await sa.get(`/api/admin/tasks/${taskId}/attachments/${aid}`)).status(), "a removed attachment is gone").toBe(404);
    } finally { await sa.dispose(); }
  });
});

test.describe("v8.12.4 — an event deleted while a participant is inside it", () => {
  test("a LIVE event in use refuses deletion by name; once ended and deleted, the participant's next request says so and the stale pointer is cleared on the record", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "del-mid");
      const p = await makeParticipant(sa, csrf, "del-mid");
      await enrol(sa, csrf, comp.id, [p.id]);
      const s = await signIn(p.email);
      try {
        const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
        expect((await s.api.get("/api/status")).status(), "PRECONDITION: inside the event").toBe(200);
        expect(row("SELECT active_competition_id AS a FROM users WHERE id=?", p.id).a, "PRECONDITION: the pin is set").toBe(comp.id);

        // A live event somebody is in cannot be deleted — and the refusal is
        // machine-readable, not only prose.
        const refused = await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
        expect(refused.status()).toBe(400);
        expect((await refused.json()).code).toBe("delete_live_in_use");

        expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
        const gone = await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
        expect(gone.ok(), `delete: ${gone.status()} ${await gone.text()}`).toBeTruthy();
        // Nothing clears the participant's pointer on delete (no foreign key),
        // which is exactly why the middleware must.
        expect(row("SELECT active_competition_id AS a FROM users WHERE id=?", p.id).a, "PRECONDITION: the pin dangles").toBe(comp.id);

        const st = await s.api.get("/api/status");
        expect(st.status()).toBe(404);
        expect((await st.json()).error).toMatch(/may have been deleted/i);
        expect(row("SELECT active_competition_id AS a FROM users WHERE id=?", p.id).a, "the dangling pin is cleared").toBeNull();
        const ev = rows("SELECT details FROM user_events WHERE user_id=? AND event_type='active_competition_changed' ORDER BY rowid", p.id)
          .map(r => JSON.parse(r.details || "{}")).filter(d => d.reason === "parent_deleted");
        expect(ev, "the clearing is on the participant's History, with its reason").toHaveLength(1);
        expect(ev[0].from).toBe(comp.id);
        expect(ev[0].to).toBeNull();

        // And the session is usable again: the participant is back at the picker.
        const me = await (await s.api.get("/api/me")).json();
        expect(me.competitionId || null, "the session no longer points at the deleted event").toBeNull();
      } finally { await s.api.dispose(); }
    } finally { await sa.dispose(); }
  });
});

test.describe("v8.12.4 — a session chosen in advance, entered once it is live", () => {
  test("entering after the session starts anchors the solve clock and records first entry for THAT session", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      // The entry clock: the subject is the anchor ENTERING the session stamps.
      const comp = await makeCompetition(sa, csrf, "advance", { start_time: new Date(Date.now() + 3_600_000).toISOString(), clock_start: "entry" });
      // The session starts a few seconds from now: chosen while upcoming, entered once live.
      const startsAt = Date.now() + 4000;
      const ts = await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H(csrf), data: {
        name: "Morning", start_time: new Date(startsAt).toISOString(), duration_minutes: 60 } });
      expect(ts.ok(), `timeslot: ${await ts.text()}`).toBeTruthy();
      const tsId = (await ts.json()).timeslot.id;
      const p = await makeParticipant(sa, csrf, "advance");
      await enrol(sa, csrf, comp.id, [p.id]);

      const s = await signIn(p.email);
      try {
        const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
        const pick = await s.api.post("/api/select-timeslot", { headers: H(s.csrf), data: { timeslotId: tsId } });
        expect(pick.ok(), `pick: ${await pick.text()}`).toBeTruthy();
        const before = row("SELECT timeslot_id, login_time FROM competition_users WHERE competition_id=? AND user_id=?", comp.id, p.id);
        expect(before.timeslot_id, "PRECONDITION: the session is chosen").toBe(tsId);
        expect(before.login_time, "PRECONDITION: the clock has NOT started — the session is still upcoming").toBeNull();

        await new Promise((r) => setTimeout(r, Math.max(0, startsAt - Date.now()) + 750));

        // The participant comes back once it has started. This is the ordinary
        // multi-session flow — choose the morning session the night before —
        // and this branch of select-competition is where its clock starts.
        const enter = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } });
        expect(enter.ok(), `enter: ${await enter.text()}`).toBeTruthy();
        const after = row("SELECT login_time, last_login_time FROM competition_users WHERE competition_id=? AND user_id=?", comp.id, p.id);
        expect(after.login_time, "the solve clock is anchored on entry").toBeTruthy();
        expect(Date.parse(after.login_time), "…at or after the session's start, never before it").toBeGreaterThanOrEqual(startsAt - 1000);

        // First entry is recorded (deferred off the hot path, so poll).
        await expect.poll(() => rows("SELECT details FROM user_events WHERE user_id=? AND event_type='first_joined'", p.id)
          .map(r => JSON.parse(r.details || "{}")).filter(d => d.competition_id === comp.id).length, { timeout: 5000 }).toBe(1);
        const fj = rows("SELECT details FROM user_events WHERE user_id=? AND event_type='first_joined'", p.id)
          .map(r => JSON.parse(r.details || "{}")).find(d => d.competition_id === comp.id);
        expect(fj.timeslot_id, "…naming the session they entered").toBe(tsId);
        await expect.poll(() => rows("SELECT 1 FROM timeslot_events WHERE timeslot_id=? AND event_type='first_joined'", tsId).length,
          { timeout: 5000 }).toBe(1);
      } finally { await s.api.dispose(); }
    } finally { await sa.dispose(); }
  });
});
