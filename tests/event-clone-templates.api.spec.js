// @ts-check
//
// v8.15.0 — CLONE EVENT and EVENT TEMPLATES.
//
// What these locks pin, and why each fixture can fail:
//
//   * A clone copies every SETTING and every challenge ASSIGNMENT, and nothing
//     that belongs to the source's people or capabilities. Every copied setting
//     is set to a NON-default value on the source, so a clone that took the
//     kind's create defaults instead fails by value; every never-copied thing
//     (participants, join token, join code, trusted IPs, submissions) EXISTS on
//     the source, so "absent from the clone" is not vacuous.
//   * Sessions are re-based: the source has two at different offsets, and the
//     clone starts on another day, so a copy of the raw start times fails.
//   * Scope: an event admin clones the event they organise (and becomes its
//     organiser), is refused the DECOY they do not, and a zero-grant event admin
//     is refused everything.
//   * Templates: every refusal is named, and the built-in seeding runs ONCE
//     against the real db.js in a throwaway data directory.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol, buildWorld } = require("./event-admin-helpers");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ro = () => new Database(TEST_DB_PATH, { readonly: true });

let W;
test.beforeAll(async () => { W = await buildWorld(); });
test.afterAll(async () => {
  for (const a of [W && W.sa, W && W.eaApi, W && W.zeroApi]) { try { await a.dispose(); } catch (_) {} }
});

test.describe("v8.15.0 — Clone event", () => {
  test("a clone copies the settings, tags, challenges and re-based sessions, and never people, links or trusted IPs", async () => {
    const { sa, saCsrf } = W;
    const start = Date.now() + HOUR;
    const src = await makeCompetition(sa, saCsrf, "clonesrc", {
      event_kind: "tournament", start_time: new Date(start).toISOString(), duration_minutes: 240,
      reveal_answers_on_end: true, group_leaderboard_enabled: true, measure_presence: true, time_basis: "presence",
      attempt_cap: 3, cxone_disabled: true, self_enroll_enabled: true,
      leaderboard_mode: "global", tags: ["clonetag"],
    });
    // Two sessions at different offsets from the start.
    for (const [name, off, dur] of [["Morning", 0, 60], ["Afternoon", 3 * HOUR, 90]]) {
      const r = await sa.post(`/api/admin/competitions/${src.id}/timeslots`, { headers: H(saCsrf), data: {
        name, start_time: new Date(start + off + 5 * 60_000).toISOString(), duration_minutes: dur } });
      expect(r.ok(), `timeslot ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const t1 = await makeTask(sa, saCsrf, "clone-a");
    const t2 = await makeTask(sa, saCsrf, "clone-b", { difficulty: "hard" });
    await assignTask(sa, saCsrf, t1.id, [src.id]);
    await assignTask(sa, saCsrf, t2.id, [src.id]);
    const p = await makeParticipant(sa, saCsrf, "clonep");
    await enrol(sa, saCsrf, src.id, [p.id]);
    // The source is upcoming (sessions can only be added before anything has
    // happened), so its activity is PLANTED: a submission row and trusted IPs
    // (refused through the API while sessions exist). The point is only that
    // they EXIST on the source, so their absence from the copy is not vacuous.
    {
      const db = new Database(TEST_DB_PATH);
      try {
        db.prepare("UPDATE competitions SET trusted_network_ips='203.0.113.7' WHERE id=?").run(src.id);
        db.prepare("INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at) VALUES (?,?,?,?,?,0,-5,?)")
          .run(uniq("sub"), p.id, t1.id, src.id, "nope", new Date().toISOString());
      } finally { db.close(); }
    }
    await new Promise(r => setTimeout(r, 1100)); // the 1 s competition-row cache

    const newStart = new Date(Date.now() + 3 * DAY);
    newStart.setUTCSeconds(0, 0);
    const name = `Cloned ${uniq("c")}`;
    const r = await sa.post(`/api/admin/competitions/${src.id}/clone`, { headers: H(saCsrf), data: { name, start_time: newStart.toISOString() } });
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    expect(body.competition.status, "the copy is upcoming").toBe("upcoming");
    expect(body.assigned_challenges).toBe(2);
    expect(body.skipped_challenges).toEqual([]);
    expect(body.sessions_copied).toBe(2);
    expect(body.forced_settings, "trusted IPs are never copied, and the response says so").toEqual(["trusted_network_ips"]);
    expect(body.granted_organiser, "a superadmin is not made an organiser").toBe(false);
    const cid = body.competition.id;

    const db = ro();
    try {
      const s = db.prepare("SELECT * FROM competitions WHERE id=?").get(src.id);
      const c = db.prepare("SELECT * FROM competitions WHERE id=?").get(cid);
      // Settings copied BY VALUE (each non-default on the source).
      for (const k of ["event_kind", "duration_minutes", "reveal_answers_on_end", "group_leaderboard_enabled", "measure_presence",
        "time_basis", "attempt_cap", "cxone_disabled", "self_enroll_enabled", "leaderboard_mode", "auto_end_on_all_solved"]) {
        expect(c[k], `setting ${k} is copied`).toBe(s[k]);
      }
      expect(c.reveal_answers_on_end).toBe(1);
      expect(c.attempt_cap).toBe(3);
      expect(c.start_time).toBe(newStart.toISOString());
      // Never copied — each present on the source.
      expect(s.trusted_network_ips).toBe("203.0.113.7");
      expect(c.trusted_network_ips, "trusted IPs").toBeNull();
      expect(c.self_enroll_token && c.self_enroll_token !== s.self_enroll_token, "a FRESH join token").toBeTruthy();
      expect(c.join_code && c.join_code !== s.join_code, "a FRESH join code").toBeTruthy();
      expect(c.ended_at).toBeNull();
      expect(db.prepare("SELECT COUNT(*) n FROM competition_users WHERE competition_id=?").get(src.id).n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM competition_users WHERE competition_id=?").get(cid).n, "no participants").toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM submissions WHERE competition_id=?").get(src.id).n).toBeGreaterThan(0);
      expect(db.prepare("SELECT COUNT(*) n FROM submissions WHERE competition_id=?").get(cid).n, "no submissions").toBe(0);
      // Same challenges.
      const ids = (x) => db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=? ORDER BY task_id").all(x).map(r => r.task_id);
      expect(ids(cid)).toEqual(ids(src.id));
      // Tags.
      expect(db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(cid).map(r => r.tag)).toContain("clonetag");
      // Sessions re-based: the first one at the NEW start, the others keeping
      // their spacing from it, the same lengths. (Measured from the first
      // session, never from the event row's own start, which no session route
      // keeps current: tests/clone-template-plan.api.spec.js.)
      const slots = (x) => db.prepare("SELECT name, start_time, duration_minutes FROM competition_timeslots WHERE competition_id=? ORDER BY start_time").all(x);
      const so = slots(src.id), co = slots(cid);
      expect(co.length).toBe(2);
      expect(Date.parse(co[0].start_time), "the first session opens the copy").toBe(Date.parse(c.start_time));
      for (let i = 0; i < 2; i++) {
        expect(co[i].name).toBe(so[i].name);
        expect(co[i].duration_minutes).toBe(so[i].duration_minutes);
        expect(Date.parse(co[i].start_time) - Date.parse(co[0].start_time), `session ${so[i].name} keeps its spacing`)
          .toBe(Date.parse(so[i].start_time) - Date.parse(so[0].start_time));
      }
      // Audited as created, naming the source.
      const ev = db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'").get(cid);
      const d = JSON.parse(ev.details);
      expect(d.via).toBe("clone");
      expect(d.cloned_from).toBe(src.id);
      expect(d.ip, "the requester's context is recorded").toBeTruthy();
    } finally { db.close(); }
  });

  test("a kind change forces off what the new kind forbids, drops sessions, and skips unfit challenges by name", async () => {
    const { sa, saCsrf } = W;
    const src = await makeCompetition(sa, saCsrf, "kindsrc", { start_time: new Date(Date.now() + HOUR).toISOString(), group_leaderboard_enabled: true, measure_presence: true, time_basis: "presence" });
    const r0 = await sa.post(`/api/admin/competitions/${src.id}/timeslots`, { headers: H(saCsrf), data: {
      name: "Only", start_time: new Date(Date.now() + 2 * HOUR).toISOString(), duration_minutes: 30 } });
    expect(r0.ok(), await r0.text()).toBeTruthy();
    const plain = await makeTask(sa, saCsrf, "fit-ok");
    const file = await makeTask(sa, saCsrf, "fit-file", { answer_type: "file", correct_answer: "flag{x}" });
    await assignTask(sa, saCsrf, plain.id, [src.id]);
    await assignTask(sa, saCsrf, file.id, [src.id]);
    const r = await sa.post(`/api/admin/competitions/${src.id}/clone`, { headers: H(saCsrf), data: { name: `Booth ${uniq("k")}`, event_kind: "booth", duration_minutes: 45 } });
    expect(r.status(), await r.text()).toBe(200);
    const b = await r.json();
    expect(b.competition.event_kind).toBe("booth");
    expect(b.forced_settings).toEqual(expect.arrayContaining(["measure_presence", "time_basis", "sessions"]));
    expect(b.forced_settings, "group board is allowed for a booth, so it is NOT forced").not.toContain("group_leaderboard_enabled");
    expect(b.sessions_copied).toBe(0);
    expect(b.assigned_challenges).toBe(1);
    expect(b.skipped_challenges.map(s => [s.task_id, s.reason])).toEqual([[file.id, "unfit"]]);
    const db = ro();
    try {
      const c = db.prepare("SELECT * FROM competitions WHERE id=?").get(b.competition.id);
      expect(c.measure_presence).toBe(0);
      expect(c.time_basis).toBe("elapsed");
      expect(c.auto_end_on_all_solved, "a Booth Event never auto-ends").toBe(0);
      expect(c.duration_minutes).toBe(45);
      expect(db.prepare("SELECT COUNT(*) n FROM competition_timeslots WHERE competition_id=?").get(c.id).n).toBe(0);
    } finally { db.close(); }
  });

  test("named refusals: past start, unknown field, taken name, unknown event", async () => {
    const { sa, saCsrf, mine } = W;
    const past = await sa.post(`/api/admin/competitions/${mine.id}/clone`, { headers: H(saCsrf), data: { name: `P ${uniq("p")}`, start_time: new Date(Date.now() - HOUR).toISOString() } });
    expect(past.status()).toBe(400);
    expect((await past.json()).code).toBe("start_time_not_future");
    const unk = await sa.post(`/api/admin/competitions/${mine.id}/clone`, { headers: H(saCsrf), data: { name: `U ${uniq("u")}`, trusted_network_ips: "203.0.113.9" } });
    expect(unk.status()).toBe(400);
    expect((await unk.json()).code).toBe("unknown_field");
    const taken = await sa.post(`/api/admin/competitions/${mine.id}/clone`, { headers: H(saCsrf), data: { name: mine.name } });
    expect(taken.status()).toBe(409);
    const none = await sa.post(`/api/admin/competitions/00000000-0000-4000-8000-000000000000/clone`, { headers: H(saCsrf), data: { name: `N ${uniq("n")}` } });
    expect(none.status()).toBe(404);
  });

  test("scope: an event admin clones their own event and becomes its organiser; the decoy and a zero-grant actor are refused", async () => {
    const { eaApi, eaCsrf, zeroApi, zeroCsrf, mine, theirs, ea } = W;
    const ok = await eaApi.post(`/api/admin/competitions/${mine.id}/clone`, { headers: H(eaCsrf), data: { name: `EA clone ${uniq("e")}` } });
    expect(ok.status(), await ok.text()).toBe(200);
    const b = await ok.json();
    expect(b.granted_organiser).toBe(true);
    const db = ro();
    try {
      expect(db.prepare("SELECT 1 x FROM competition_admins WHERE competition_id=? AND user_id=?").get(b.competition.id, ea.id), "the organiser row exists").toBeTruthy();
      expect(db.prepare("SELECT COUNT(*) n FROM competition_users WHERE competition_id=?").get(b.competition.id).n).toBe(0);
    } finally { db.close(); }
    // …and the new event is in their scope at once (the scope cache was busted).
    const put = await eaApi.put(`/api/admin/competitions/${b.competition.id}`, { headers: H(eaCsrf), data: { name: `${b.competition.name} renamed` } });
    expect(put.status(), await put.text()).toBe(200);
    const refused = await eaApi.post(`/api/admin/competitions/${theirs.id}/clone`, { headers: H(eaCsrf), data: { name: `EA decoy ${uniq("d")}` } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("event_admin_out_of_scope");
    const zero = await zeroApi.post(`/api/admin/competitions/${mine.id}/clone`, { headers: H(zeroCsrf), data: { name: `Zero ${uniq("z")}` } });
    expect(zero.status()).toBe(403);
    expect((await zero.json()).code).toBe("event_admin_out_of_scope");
    const db2 = ro();
    try {
      expect(db2.prepare("SELECT COUNT(*) n FROM competitions WHERE name LIKE 'EA decoy %' OR name LIKE 'Zero %'").get().n, "a refused clone writes nothing").toBe(0);
    } finally { db2.close(); }
  });

  test("a competitor may not clone the event they compete in", async () => {
    const { sa, saCsrf } = W;
    const adm = await makeParticipant(sa, saCsrf, "compclone");
    const pr = await sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), await pr.text()).toBeTruthy();
    const ev = await makeCompetition(sa, saCsrf, "compete", { staff_compete: true });
    await enrol(sa, saCsrf, ev.id, [adm.id]);
    const al = await apiLogin(adm.email, PARTICIPANT_PASS);
    try {
      const r = await al.api.post(`/api/admin/competitions/${ev.id}/clone`, { headers: H(al.csrf), data: { name: `Comp ${uniq("c")}` } });
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe("competitor_cannot_edit");
      // Control: the same admin may clone an event they do not compete in.
      const other = await makeCompetition(sa, saCsrf, "notcompete");
      const ok = await al.api.post(`/api/admin/competitions/${other.id}/clone`, { headers: H(al.csrf), data: { name: `Comp ok ${uniq("c")}` } });
      expect(ok.status(), await ok.text()).toBe(200);
    } finally { await al.api.dispose(); }
  });
});

test.describe("v8.15.0 — Event templates", () => {
  test("the three built-in templates are listed", async () => {
    const r = await W.sa.get("/api/admin/event-templates");
    expect(r.ok()).toBeTruthy();
    const list = (await r.json()).templates;
    const built = list.filter(t => t.is_builtin);
    expect(built.map(t => [t.name, t.event_kind]).sort()).toEqual([
      ["Booth day (8 hours)", "booth"], ["Competition (several sessions)", "tournament"], ["Learning program (30 days)", "program"],
    ]);
    for (const t of built) expect(t.task_ids, `${t.name} carries no challenges`).toEqual([]);
    // The booth's recommended setup runs a full conference day with its join link open.
    expect(built.find(t => t.event_kind === "booth").settings).toEqual({ duration_minutes: 480, self_enroll_enabled: true });
    expect(built.find(t => t.event_kind === "tournament").settings).toEqual({ duration_minutes: 120 });
    expect(built.find(t => t.event_kind === "program").settings).toEqual({ duration_minutes: 43200 });
  });

  test("the built-ins are seeded once: a deleted one does not come back at the next boot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-seed-"));
    try {
      const run = () => require("child_process").spawnSync(process.execPath, ["-e", "require('./db')"], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, NODE_OPTIONS: "", DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, BASE_URL: "http://localhost", SMTP_HOST: "localhost" },
        encoding: "utf8",
      });
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      let db = new Database(path.join(dir, "hackathon.db"));
      try {
        expect(db.prepare("SELECT COUNT(*) n FROM event_templates WHERE is_builtin=1").get().n).toBe(3);
        expect(db.prepare("SELECT value FROM settings WHERE key='event_templates_seeded_at'").get(), "the marker is armed").toBeTruthy();
        db.prepare("DELETE FROM event_templates WHERE builtin_key='tournament-2h'").run();
      } finally { db.close(); }
      const second = run();
      expect(second.status, second.stderr).toBe(0);
      db = new Database(path.join(dir, "hackathon.db"), { readonly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) n FROM event_templates").get().n, "not re-seeded").toBe(2);
      } finally { db.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("create refuses unknown keys, forbidden settings, bad schedules and unfit challenges — each by name", async () => {
    const { sa, saCsrf } = W;
    const file = await makeTask(sa, saCsrf, "tpl-file", { answer_type: "file", correct_answer: "flag{y}" });
    const cases = [
      [{ event_kind: "tournament", settings: { duration_minutes: 60, trusted_network_ips: "203.0.113.1" } }, "template_setting_unknown"],
      [{ event_kind: "tournament", settings: { duration_minutes: 60, start_time: new Date().toISOString() } }, "template_setting_unknown"],
      [{ event_kind: "program", settings: { duration_minutes: 600, reveal_answers_on_end: true } }, "reveal_answers_forbidden"],
      [{ event_kind: "tournament", settings: { duration_minutes: 60, registration_fields: { phone: "mandatory" } } }, "template_settings_invalid"],
      [{ event_kind: "tournament", settings: { duration_minutes: 60, late_entry_enabled: true } }, "late_entry_forbidden"],
      [{ event_kind: "booth", settings: { duration_minutes: 60, measure_presence: true } }, "measure_presence_forbidden"],
      [{ event_kind: "tournament", settings: {} }, "duration_required"],
      [{ event_kind: "tournament", settings: { duration_minutes: 600000 } }, "duration_too_long"],
      [{ event_kind: "tournament", settings: { duration_minutes: "lots" } }, "template_settings_invalid"],
      [{ event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: ["no-such-task"] }, "template_task_missing"],
      [{ event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [file.id] }, "template_task_unfit"],
      [{ event_kind: "tournament", settings: { duration_minutes: 60 }, owner: "x" }, "unknown_field"],
    ];
    for (const [data, code] of cases) {
      const r = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name: `Bad ${uniq("b")}`, ...data } });
      expect(r.status(), `${code}: ${await r.text()}`).toBe(400);
      expect((await r.json()).code, JSON.stringify(data)).toBe(code);
    }
    const db = ro();
    try { expect(db.prepare("SELECT COUNT(*) n FROM event_templates WHERE name LIKE 'Bad %'").get().n, "a refused create writes nothing").toBe(0); }
    finally { db.close(); }
  });

  test("create, edit (with a stale-copy 409), spawn and delete", async () => {
    const { sa, saCsrf } = W;
    const t = await makeTask(sa, saCsrf, "tpl-a");
    const name = `Tpl ${uniq("t")}`;
    const c = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: {
      name, description: "A test template", event_kind: "tournament",
      settings: { duration_minutes: 90, attempt_cap: 4, reveal_answers_on_end: true, tags: ["TplTag"], registration_fields: { city: "required" } },
      task_ids: [t.id] } });
    expect(c.status(), await c.text()).toBe(200);
    const tpl = (await c.json()).template;
    expect(tpl.task_ids).toEqual([t.id]);
    expect(tpl.settings.tags).toEqual(["tpltag"]);
    const dup = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name: name.toUpperCase(), event_kind: "tournament", settings: { duration_minutes: 5 } } });
    expect(dup.status()).toBe(409);

    const stale = await sa.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(saCsrf), data: { description: "x", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" } });
    expect(stale.status()).toBe(409);
    const ed = await sa.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(saCsrf), data: { description: "Edited", expectedUpdatedAt: tpl.updated_at } });
    expect(ed.status(), await ed.text()).toBe(200);
    expect((await ed.json()).template.description).toBe("Edited");
    // A kind change re-judges the stored settings: a Program does not reveal answers.
    const kind = await sa.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(saCsrf), data: { event_kind: "program" } });
    expect(kind.status()).toBe(400);
    expect((await kind.json()).code).toBe("reveal_answers_forbidden");

    const start = new Date(Date.now() + 2 * DAY); start.setUTCSeconds(0, 0);
    const sp = await sa.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(saCsrf), data: { name: `Spawned ${uniq("s")}`, start_time: start.toISOString() } });
    expect(sp.status(), await sp.text()).toBe(200);
    const sb = await sp.json();
    expect(sb.competition.status).toBe("upcoming");
    expect(sb.assigned_challenges).toBe(1);
    const db = ro();
    try {
      const row = db.prepare("SELECT * FROM competitions WHERE id=?").get(sb.competition.id);
      expect(row.event_kind).toBe("tournament");
      expect(row.duration_minutes).toBe(90);
      expect(row.attempt_cap).toBe(4);
      expect(row.reveal_answers_on_end).toBe(1);
      expect(row.self_enroll_enabled, "absent settings take the kind's seed").toBe(0);
      // Every kind configures its sign-up form, so a Competition template's
      // matrix reaches the spawned event.
      expect(JSON.parse(row.registration_field_policy).city, "the template's sign-up matrix is carried").toBe("required");
      expect(db.prepare("SELECT tag FROM competition_tags WHERE competition_id=?").all(row.id).map(r => r.tag)).toEqual(["tpltag"]);
      expect(db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=?").all(row.id).map(r => r.task_id)).toEqual([t.id]);
      const d = JSON.parse(db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'").get(row.id).details);
      expect(d.via).toBe("template");
      expect(d.template_id).toBe(tpl.id);
    } finally { db.close(); }

    // A challenge deleted since is skipped by name, not a failure.
    const del = await sa.delete(`/api/admin/tasks/${t.id}`, { headers: H(saCsrf) });
    expect(del.ok(), await del.text()).toBeTruthy();
    const sp2 = await sa.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(saCsrf), data: { name: `Spawned ${uniq("s")}` } });
    expect(sp2.status(), await sp2.text()).toBe(200);
    const s2 = await sp2.json();
    expect(s2.assigned_challenges).toBe(0);
    expect(s2.skipped_challenges.map(x => x.reason)).toEqual(["missing"]);

    const rm = await sa.delete(`/api/admin/event-templates/${tpl.id}`, { headers: H(saCsrf) });
    expect(rm.ok()).toBeTruthy();
    expect((await sa.get(`/api/admin/event-templates/${tpl.id}`)).status()).toBe(404);
  });

  test("the built-in Learning Program spawns with its deadline 30 days after the start", async () => {
    const { sa, saCsrf } = W;
    const list = (await (await sa.get("/api/admin/event-templates")).json()).templates;
    const prog = list.find(t => t.is_builtin && t.event_kind === "program");
    expect(prog, "the built-in Program template exists").toBeTruthy();
    const start = new Date(Date.now() + DAY); start.setUTCSeconds(0, 0);
    const r = await sa.post(`/api/admin/event-templates/${prog.id}/spawn`, { headers: H(saCsrf), data: { name: `Prog ${uniq("p")}`, start_time: start.toISOString() } });
    expect(r.status(), await r.text()).toBe(200);
    const c = (await r.json()).competition;
    expect(Date.parse(c.deadline_at) - start.getTime()).toBe(30 * DAY);
    expect(c.event_kind).toBe("program");
  });

  test("event admins may list and spawn templates, never manage them, and see only challenges they may view", async () => {
    const { sa, saCsrf, eaApi, eaCsrf, ea } = W;
    const hidden = await makeTask(sa, saCsrf, "tpl-hidden");   // a superadmin's challenge in no event of theirs
    const name = `EA Tpl ${uniq("t")}`;
    const c = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: { name, event_kind: "tournament", settings: { duration_minutes: 30 }, task_ids: [hidden.id] } });
    expect(c.status(), await c.text()).toBe(200);
    const tpl = (await c.json()).template;
    const l = await eaApi.get("/api/admin/event-templates");
    expect(l.ok()).toBeTruthy();
    const mineView = (await l.json()).templates.find(x => x.id === tpl.id);
    expect(mineView, "listed").toBeTruthy();
    expect(mineView.task_ids, "the invisible challenge's id is withheld").toEqual([]);
    expect(mineView.withheld_task_count).toBe(1);
    expect(JSON.stringify(await (await eaApi.get(`/api/admin/event-templates/${tpl.id}`)).json())).not.toContain(hidden.id);
    // Control: the superadmin sees it.
    expect((await (await sa.get(`/api/admin/event-templates/${tpl.id}`)).json()).template.task_ids).toEqual([hidden.id]);

    for (const [method, url, data] of [
      ["post", "/api/admin/event-templates", { name: `EA new ${uniq("n")}`, event_kind: "tournament", settings: { duration_minutes: 5 } }],
      ["put", `/api/admin/event-templates/${tpl.id}`, { description: "ea" }],
      ["delete", `/api/admin/event-templates/${tpl.id}`, undefined],
      ["post", `/api/admin/competitions/${W.mine.id}/save-as-template`, { name: `EA save ${uniq("s")}` }],
    ]) {
      const r = await eaApi[method](url, { headers: H(eaCsrf), ...(data ? { data } : {}) });
      expect(r.status(), `${method} ${url}`).toBe(403);
      expect((await r.json()).code).toBe("event_admin_forbidden");
    }
    // An event admin whose every grant was revoked is shut out of starting one
    // too: a spawn would hand them a new event (lock: #59). Nothing is created.
    const zeroName = `Zero spawn ${uniq("z")}`;
    const zr = await W.zeroApi.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(W.zeroCsrf), data: { name: zeroName } });
    expect(zr.status(), await zr.text()).toBe(403);
    expect((await zr.json()).code).toBe("event_admin_no_events");
    const _all = await (await sa.get("/api/admin/competitions")).json();
    expect((_all.competitions || _all).some(x => x.name === zeroName), "no event was made").toBe(false);
    const sp = await eaApi.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(eaCsrf), data: { name: `EA spawn ${uniq("s")}` } });
    expect(sp.status(), await sp.text()).toBe(200);
    const b = await sp.json();
    expect(b.granted_organiser).toBe(true);
    // Counted, never named: the spawn's answer withholds what the template read
    // withheld (lock: tests/clone-template-plan.api.spec.js).
    expect(b.skipped_challenges).toEqual([{ reason: "not_visible" }]);
    expect(JSON.stringify(b), "the invisible challenge's id is withheld from the spawn too").not.toContain(hidden.id);
    const db = ro();
    try {
      expect(db.prepare("SELECT 1 x FROM competition_admins WHERE competition_id=? AND user_id=?").get(b.competition.id, ea.id)).toBeTruthy();
      expect(db.prepare("SELECT COUNT(*) n FROM competition_tasks WHERE competition_id=?").get(b.competition.id).n).toBe(0);
    } finally { db.close(); }
  });

  test("save-as-template takes the event's settings and challenges", async () => {
    const { sa, saCsrf } = W;
    // The source HAS trusted network IPs (a venue address and a rate-limit
    // bypass), so "the template does not carry them" is a claim about a value
    // that exists, not about an empty column.
    const venue = "203.0.113.57";
    const src = await makeCompetition(sa, saCsrf, "savesrc", { attempt_cap: 7, measure_presence: true, tags: ["savedtag"], trusted_network_ips: venue });
    {
      const db = ro();
      try { expect(db.prepare("SELECT trusted_network_ips FROM competitions WHERE id=?").get(src.id).trusted_network_ips, "PRECONDITION: the source has trusted IPs").toBe(venue); }
      finally { db.close(); }
    }
    const t = await makeTask(sa, saCsrf, "save-a");
    await assignTask(sa, saCsrf, t.id, [src.id]);
    const r = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name: `Saved ${uniq("s")}` } });
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    const tpl = body.template;
    expect(tpl.event_kind).toBe("tournament");
    expect(tpl.settings.attempt_cap).toBe(7);
    expect(tpl.settings.measure_presence).toBe(true);
    expect(tpl.settings.duration_minutes).toBe(600);
    expect(tpl.settings.tags).toEqual(["savedtag"]);
    expect(tpl.task_ids).toEqual([t.id]);
    expect(tpl.settings, "no capability or venue setting").not.toHaveProperty("trusted_network_ips");
    expect(JSON.stringify(body), "the venue address appears nowhere in the answer").not.toContain(venue);
    const db = ro();
    try {
      expect(db.prepare("SELECT settings FROM event_templates WHERE id=?").get(tpl.id).settings, "…nor in the stored template").not.toContain(venue);
    } finally { db.close(); }
  });

  // THE OPERATOR'S RULING OF 14 NOV 2026: saving the event you compete in as a
  // template is refused exactly as cloning it is — an event made from the
  // template carries its challenge set into an event you would organise. The
  // controls are on the SAME event (a non-competing admin, the built-in
  // superadmin) and the same competitor on an event they do not compete in, so
  // the refusal is about competing here, not the event or the actor.
  test("a competitor may not save the event they compete in as a template; a non-competing admin and the built-in superadmin may (controls)", async () => {
    const { sa, saCsrf } = W;
    const promote = async (label) => {
      const u = await makeParticipant(sa, saCsrf, label);
      const pr = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
      expect(pr.ok(), await pr.text()).toBeTruthy();
      return u;
    };
    const competitor = await promote("comptpl");
    const bystander = await promote("comptplby");
    const ev = await makeCompetition(sa, saCsrf, "competetpl", { staff_compete: true });
    const other = await makeCompetition(sa, saCsrf, "notcompetetpl");
    await enrol(sa, saCsrf, ev.id, [competitor.id]);
    const prefix = `CompTpl ${uniq("t")}`;
    const saved = () => {
      const db = ro();
      try { return db.prepare("SELECT name FROM event_templates WHERE name LIKE ? ORDER BY name").all(`${prefix}%`).map(r => r.name); } finally { db.close(); }
    };
    const competingFor = async (api) => ((await (await api.get("/api/admin/competitions")).json()).find(c => c.id === ev.id) || {}).competing;
    const cl = await apiLogin(competitor.email, PARTICIPANT_PASS);
    const bl = await apiLogin(bystander.email, PARTICIPANT_PASS);
    try {
      expect(await competingFor(cl.api), "PRECONDITION: the competitor competes in the event").toBe(true);
      expect(await competingFor(bl.api), "PRECONDITION: the other admin does not").toBe(false);

      const r = await cl.api.post(`/api/admin/competitions/${ev.id}/save-as-template`, { headers: H(cl.csrf), data: { name: `${prefix} refused` } });
      expect(r.status(), "a competitor is refused").toBe(403);
      const body = await r.json();
      expect({ code: body.code, competitionId: body.competitionId, competitionName: body.competitionName }, "the competitor refusal, naming the event")
        .toEqual({ code: "competitor_cannot_edit", competitionId: ev.id, competitionName: ev.name });
      expect(body.error, "…in words that name it").toContain(ev.name);
      const clone = await cl.api.post(`/api/admin/competitions/${ev.id}/clone`, { headers: H(cl.csrf), data: { name: `${prefix} clone` } });
      expect(clone.status()).toBe(403);
      expect(body, "the very body a clone is refused with").toEqual(await clone.json());
      expect(saved(), "a refused save writes no template").toEqual([]);

      // CONTROL: the same competitor saves an event they do not compete in.
      const own = await cl.api.post(`/api/admin/competitions/${other.id}/save-as-template`, { headers: H(cl.csrf), data: { name: `${prefix} elsewhere` } });
      expect(own.status(), await own.text()).toBe(200);
      // CONTROLS on the SAME event: a non-competing admin, and the built-in
      // superadmin, who has no user row and can never compete.
      const byAdmin = await bl.api.post(`/api/admin/competitions/${ev.id}/save-as-template`, { headers: H(bl.csrf), data: { name: `${prefix} by admin` } });
      expect(byAdmin.status(), await byAdmin.text()).toBe(200);
      const bySa = await sa.post(`/api/admin/competitions/${ev.id}/save-as-template`, { headers: H(saCsrf), data: { name: `${prefix} by superadmin` } });
      expect(bySa.status(), await bySa.text()).toBe(200);
      expect(saved(), "exactly the three allowed saves landed").toEqual([`${prefix} by admin`, `${prefix} by superadmin`, `${prefix} elsewhere`]);
    } finally { await cl.api.dispose(); await bl.api.dispose(); }
  });
});

// THE OPERATOR'S RULING OF 14 NOV 2026: an event that creates Checkmarx One
// accounts with its OWN key gives a copy — a clone, or a template saved from it —
// accounts OFF (`cxone_disabled`), named in `forced_settings`. The key is never
// copied, so the copy would otherwise create every joiner's account in the
// platform's default tenant, one the source never sent anybody to.
// Three sources, so each half of the predicate has a control: own key + accounts
// on (forced off), no key + accounts on (kept on, nothing named), own key +
// accounts already off (kept off, nothing named: nothing was turned off).
test.describe("Checkmarx One accounts: a copy of an event with its own key", () => {
  // A minimal key the decoder accepts: an `iss` on an allowlisted IAM host (the
  // signature is never checked — tenant discovery, not authentication).
  const fakeKey = () => `header.${Buffer.from(JSON.stringify({ iss: "https://iam.checkmarx.net/auth/realms/cxone_copy_test" })).toString("base64url")}.signature`;
  async function source(label, { key, disabled }) {
    const { sa, saCsrf } = W;
    const ev = await makeCompetition(sa, saCsrf, label, { start_time: new Date(Date.now() + 2 * DAY).toISOString(), duration_minutes: 90, cxone_disabled: disabled });
    if (key) {
      const r = await sa.put(`/api/admin/competitions/${ev.id}/cxone`, { headers: H(saCsrf), data: { cxone_api_key: fakeKey(), cxone_group_name: "" } });
      expect(r.ok(), `own key: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    const db = ro();
    try {
      const row = db.prepare("SELECT cxone_api_key IS NOT NULL AS k, cxone_disabled AS off FROM competitions WHERE id=?").get(ev.id);
      expect(row, `PRECONDITION: ${label} has ${key ? "its own key" : "no key"}, accounts ${disabled ? "off" : "on"}`).toEqual({ k: key ? 1 : 0, off: disabled ? 1 : 0 });
    } finally { db.close(); }
    return ev;
  }
  const copyRow = (id) => { const db = ro(); try { return db.prepare("SELECT cxone_disabled, cxone_api_key, cxone_group_name FROM competitions WHERE id=?").get(id); } finally { db.close(); } };

  test("a clone and a saved template turn accounts off and say so; without a key, or already off, nothing is turned off", async () => {
    const { sa, saCsrf } = W;
    const own = await source("ownkey", { key: true, disabled: false });
    const plain = await source("nokey", { key: false, disabled: false });
    const offAlready = await source("ownkeyoff", { key: true, disabled: true });
    const clone = async (src) => {
      const r = await sa.post(`/api/admin/competitions/${src.id}/clone`, { headers: H(saCsrf), data: { name: `Copy ${uniq("cx")}` } });
      expect(r.status(), await r.text()).toBe(200);
      return r.json();
    };

    const a = await clone(own);
    expect(a.forced_settings, "the answer names it").toContain("cxone_disabled");
    expect(copyRow(a.competition.id), "accounts off in the copy, and no key").toEqual({ cxone_disabled: 1, cxone_api_key: null, cxone_group_name: null });
    {
      const db = ro();
      try {
        const d = JSON.parse(db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='created'").get(a.competition.id).details);
        expect(d.forced_settings, "History records it").toContain("cxone_disabled");
        expect(d.cxone_disabled, "…and the value it took").toBe(true);
      } finally { db.close(); }
    }
    // CONTROLS — the predicate's two halves.
    const b = await clone(plain);
    expect(b.forced_settings, "no key: nothing turned off").not.toContain("cxone_disabled");
    expect(copyRow(b.competition.id).cxone_disabled, "…and the accounts stay on").toBe(0);
    const c = await clone(offAlready);
    expect(c.forced_settings, "already off: nothing was turned off").not.toContain("cxone_disabled");
    expect(copyRow(c.competition.id).cxone_disabled, "…and it stays off").toBe(1);

    // SAVE AS TEMPLATE: the same rule, the same word.
    const save = async (src) => {
      const r = await sa.post(`/api/admin/competitions/${src.id}/save-as-template`, { headers: H(saCsrf), data: { name: `Saved ${uniq("cx")}` } });
      expect(r.status(), await r.text()).toBe(200);
      return r.json();
    };
    const t = await save(own);
    expect(t.forced_settings, "the answer names it").toEqual(["cxone_disabled"]);
    expect(t.template.settings.cxone_disabled, "the template records accounts off").toBe(true);
    const t2 = await save(plain);
    expect(t2.forced_settings, "CONTROL: no key, nothing turned off").toEqual([]);
    expect(t2.template.settings.cxone_disabled, "…and accounts stay on").toBe(false);
    // What an event made from the template does: no accounts.
    const sp = await sa.post(`/api/admin/event-templates/${t.template.id}/spawn`, { headers: H(saCsrf), data: { name: `Spawned ${uniq("cx")}` } });
    expect(sp.status(), await sp.text()).toBe(200);
    expect(copyRow((await sp.json()).competition.id).cxone_disabled, "an event made from it creates no accounts").toBe(1);
  });
});

// SWEEP #63 (operator ruling, 23 Nov 2026), extending the 14 Nov ruling above: a
// competitor may not carry the challenges of an event they compete in into a
// template, nor into an event they make. A template's create and edit (which
// re-judges its whole list) and save-as-template refuse such a challenge, 403
// `template_task_competing`; a spawn and a clone leave it out with the reason
// `competing`. Each refusal beside its controls: the same competitor with a
// challenge no competing event holds, a non-competing admin, the built-in
// superadmin (who never competes). The challenges are SEALED (an event where
// staff compete holds sealed challenges only), written by a third admin, so the
// competitor is not their author.
test.describe("sweep #63 — the challenges of an event you compete in stay out of templates and of events you make", () => {
  let W, competitor, bystander, author, E, S, T, U;
  const promote = async (label) => {
    const u = await makeParticipant(W.sa, W.saCsrf, label);
    const pr = await W.sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(W.saCsrf), data: { role: "admin" } });
    expect(pr.ok(), await pr.text()).toBeTruthy();
    return u;
  };
  const tasksOf = (compId) => { const db = ro(); try { return db.prepare("SELECT task_id FROM competition_tasks WHERE competition_id=? ORDER BY task_id").all(compId).map(r => r.task_id); } finally { db.close(); } };
  const tplNamed = (name) => { const db = ro(); try { return db.prepare("SELECT * FROM event_templates WHERE name=?").get(name); } finally { db.close(); } };

  test.beforeAll(async () => {
    W = await buildWorld();
    competitor = await promote("c63comp");
    bystander = await promote("c63by");
    author = await promote("c63auth");
    E = await makeCompetition(W.sa, W.saCsrf, "c63compete", { staff_compete: true });
    S = await makeCompetition(W.sa, W.saCsrf, "c63source");
    const al = await apiLogin(author.email, PARTICIPANT_PASS);
    try {
      T = await makeTask(al.api, al.csrf, "c63held", { answer_sealed: true, correct_answer: "k" });
      U = await makeTask(al.api, al.csrf, "c63free", { answer_sealed: true, correct_answer: "k" });
    } finally { await al.api.dispose(); }
    await assignTask(W.sa, W.saCsrf, T.id, [E.id, S.id]);
    await assignTask(W.sa, W.saCsrf, U.id, [S.id]);
    await enrol(W.sa, W.saCsrf, E.id, [competitor.id]);
  });

  test("a template's create and edit refuse a challenge held by an event the saver competes in; the controls save", async () => {
    const cl = await apiLogin(competitor.email, PARTICIPANT_PASS);
    const bl = await apiLogin(bystander.email, PARTICIPANT_PASS);
    try {
      const competing = ((await (await cl.api.get("/api/admin/competitions")).json()).find(c => c.id === E.id) || {}).competing;
      expect(competing, "PRECONDITION: the competitor competes in the event").toBe(true);
      const body = (name, ids) => ({ name, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: ids });
      const name = `C63 ${uniq("t")}`;
      const r = await cl.api.post("/api/admin/event-templates", { headers: H(cl.csrf), data: body(name, [T.id, U.id]) });
      expect(r.status()).toBe(403);
      const b = await r.json();
      expect({ code: b.code, task_id: b.task_id }).toEqual({ code: "template_task_competing", task_id: T.id });
      expect(b.error, "it names the event and the challenge").toContain(E.name);
      expect(b.error).toContain(T.title);
      expect(tplNamed(name), "nothing was written").toBeUndefined();
      // CONTROL: the same competitor, a challenge no event of theirs holds.
      const own = await cl.api.post("/api/admin/event-templates", { headers: H(cl.csrf), data: body(`${name} own`, [U.id]) });
      expect(own.status(), await own.text()).toBe(200);
      // CONTROLS: a non-competing admin and the built-in superadmin save it.
      const by = await bl.api.post("/api/admin/event-templates", { headers: H(bl.csrf), data: body(`${name} by`, [T.id, U.id]) });
      expect(by.status(), await by.text()).toBe(200);
      const tpl = (await by.json()).template;
      const bySa = await W.sa.post("/api/admin/event-templates", { headers: H(W.saCsrf), data: body(`${name} sa`, [T.id, U.id]) });
      expect(bySa.status(), await bySa.text()).toBe(200);
      // An edit re-judges the whole list: the competitor cannot even rename it.
      const before = tplNamed(`${name} by`);
      const put = await cl.api.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(cl.csrf), data: { description: "renamed", expectedUpdatedAt: tpl.updated_at } });
      expect(put.status()).toBe(403);
      expect((await put.json()).code).toBe("template_task_competing");
      expect(tplNamed(`${name} by`), "the template is unchanged").toEqual(before);
      const okPut = await bl.api.put(`/api/admin/event-templates/${tpl.id}`, { headers: H(bl.csrf), data: { description: "renamed", expectedUpdatedAt: tpl.updated_at } });
      expect(okPut.status(), "CONTROL: its own author edits it").toBe(200);
    } finally { await cl.api.dispose(); await bl.api.dispose(); }
  });

  test("save-as-template refuses an event holding such a challenge; a spawn and a clone leave it out, by name and reason", async () => {
    const cl = await apiLogin(competitor.email, PARTICIPANT_PASS);
    const bl = await apiLogin(bystander.email, PARTICIPANT_PASS);
    try {
      const name = `C63s ${uniq("s")}`;
      const sat = await cl.api.post(`/api/admin/competitions/${S.id}/save-as-template`, { headers: H(cl.csrf), data: { name } });
      expect(sat.status()).toBe(403);
      expect(await sat.json()).toMatchObject({ code: "template_task_competing", task_id: T.id });
      expect(tplNamed(name)).toBeUndefined();
      const sab = await bl.api.post(`/api/admin/competitions/${S.id}/save-as-template`, { headers: H(bl.csrf), data: { name: `${name} by` } });
      expect(sab.status(), `CONTROL: a non-competing admin saves it: ${await sab.text()}`).toBe(200);
      const tpl = (await sab.json()).template;
      expect([...tpl.task_ids].sort()).toEqual([T.id, U.id].sort());

      const spawn = await cl.api.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(cl.csrf), data: { name: `${name} spawn` } });
      expect(spawn.status(), await spawn.text()).toBe(200);
      const sp = await spawn.json();
      expect(sp.skipped_challenges).toEqual([expect.objectContaining({ task_id: T.id, title: T.title, reason: "competing", message: `you compete in “${E.name}”, which holds it` })]);
      expect(tasksOf(sp.competition.id), "the new event holds only the other challenge").toEqual([U.id]);
      const clone = await cl.api.post(`/api/admin/competitions/${S.id}/clone`, { headers: H(cl.csrf), data: { name: `${name} clone` } });
      expect(clone.status(), await clone.text()).toBe(200);
      const cb = await clone.json();
      expect(cb.skipped_challenges.map(x => [x.task_id, x.reason])).toEqual([[T.id, "competing"]]);
      expect(tasksOf(cb.competition.id)).toEqual([U.id]);
      // CONTROLS: the non-competing admin's spawn and the superadmin's clone carry both.
      const bsp = await bl.api.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(bl.csrf), data: { name: `${name} spawn by` } });
      expect(bsp.status(), await bsp.text()).toBe(200);
      const bb = await bsp.json();
      expect(bb.skipped_challenges).toEqual([]);
      expect(bb.assigned_challenges).toBe(2);
      const sac = await W.sa.post(`/api/admin/competitions/${S.id}/clone`, { headers: H(W.saCsrf), data: { name: `${name} clone sa` } });
      expect(sac.status(), await sac.text()).toBe(200);
      expect(tasksOf((await sac.json()).competition.id)).toEqual([T.id, U.id].sort());
    } finally { await cl.api.dispose(); await bl.api.dispose(); }
  });

  test("an organiser competing in an event they do not run is told the reason without that event's name", async () => {
    // The event admin organises W.mine and competes in E2, which they do not run.
    const E2 = await makeCompetition(W.sa, W.saCsrf, "c63other", { staff_compete: true });
    const al = await apiLogin(author.email, PARTICIPANT_PASS);
    let T2;
    try { T2 = await makeTask(al.api, al.csrf, "c63ea", { answer_sealed: true, correct_answer: "k" }); } finally { await al.api.dispose(); }
    await assignTask(W.sa, W.saCsrf, T2.id, [E2.id, W.mine.id]);
    await enrol(W.sa, W.saCsrf, E2.id, [W.ea.id]);
    const tr = await W.sa.post("/api/admin/event-templates", { headers: H(W.saCsrf), data: { name: `C63ea ${uniq("e")}`, event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [T2.id] } });
    expect(tr.status(), await tr.text()).toBe(200);
    const tpl = (await tr.json()).template;
    const sp = await W.eaApi.post(`/api/admin/event-templates/${tpl.id}/spawn`, { headers: H(W.eaCsrf), data: { name: `C63ea spawn ${uniq("p")}` } });
    expect(sp.status(), await sp.text()).toBe(200);
    const s = await sp.json();
    expect(s.skipped_challenges.map(x => [x.task_id, x.reason])).toEqual([[T2.id, "competing"]]);
    expect(s.skipped_challenges[0].message, "words that read inside the toast's brackets").toBe("you compete in an event that holds it");
    expect(s.skipped_challenges[0].message, "the event they do not run is not named").not.toContain(E2.name);
  });
});
